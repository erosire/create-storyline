// The run layer's test double for T3's tool runtime, plus the §4 fixtures its tests build on.
//
// WHY THIS LAYER OWNS THE FAKE: W2's runtime (`src/server/tools/**`) is still landing — as of
// writing, `createToolRuntime` is named in `tools/types.ts`'s header but not implemented, and that
// directory does not typecheck. This layer's acceptance is about the RUN, not about the catalogue's
// internals, so its tests drive a fake that speaks T3's pinned shapes exactly: `ToolResult` with
// `ok / data / rev / refused / message / cas_conflict / currents` (T-7, T-8, T-1a, T-4), a context
// shaped like `RunToolContext`, and `ToolSchema`s in the OpenAI wire shape.
//
// WHAT THE FAKE HAS TO GET RIGHT, and why each rule is here:
//   T-3   every read and write is scoped to the context's `storyId`, and reaching outside it is a
//         refusal naming T-3 — a run that could read a neighbouring Story would pass these tests
//         and fail in the product.
//   T-4   a write whose `expects` is stale returns `{ok:false, cas_conflict:true, currents:[…]}`
//         INSTEAD of throwing, so the agent re-reads and re-applies. This is the single most
//         load-bearing behaviour for the run layer: the CAS round trip is a TRANSCRIPT event, and
//         the run layer is the code that puts it in front of the model.
//   T-5   writes carry `{run_ref, why}` (P11) and land inside ONE `store.commit(...)` group, which
//         is how D-22's "the selection and the deletion of the losers are one decision" holds.
//   P11   the attribution's `run_ref` is the CONTEXT's `runRef` — so a panel agent's or a
//         delegate's write is credited to the dispatched run and never to a phantom row (T-2b, S-7).
//   T-6c  `listTools` / `describeTool` answer from the registered set, so tool discovery works.
//   D-16  `raiseFinding` dedupes by fingerprint and says `repeat` + which finding it re-raised,
//         because that is what makes "no progress" visible to an amnesiac loop (D-32).
//   D-17e `delegate` calls `ctx.services.delegate` — the seam the run layer injected — and surfaces
//         its answer as data, refusing with the rule id when the session has no such service.
//
// WHAT IT DELIBERATELY DOES NOT DO: enforce §7's permission table (T1/T3's job — these tests never
// depend on a refusal they did not script), and hold any panel logic. A D-38 proposal never reaches
// this class at all: the wrapper in ./panel short-circuits a mutating call BEFORE `execute`, so
// `runtime.calls` is exactly "what really executed" — which is what the panel's acceptance needs.
// The ONE exception to the permission-blind rule is the Phase-1 research surface (structureSeed /
// writeKnowledge / readKnowledge / retireKnowledge / reportNoResearch): those writes — and D-51's
// zero-write research report, which is still the Researcher's alone — are gated by the kind that owns
// them, because a run-layer test must not be able to script an impossible session (see
// `wrongKindRefusal`).
import {
    CasConflict,
    Store,
    StoreError,
    type Attribution,
    type CAS,
    type Collection,
    type UpdatePatch
} from '../store';
import { BUILT_IN_CRITERIA, defaultGoal } from '../../shared/criteria';
// HARDENING (R6): the mock crew implements the SAME contract as `tools/writer.ts:editSummary`,
// and a group-managed book must not get its mirror written through the double either.
import { isGroupManagedStory } from '../phrase';
// D-33c/D-33d: the scripted crew files and approves under the loop's OWN issues-first predicate, so
// an integration test cannot exercise a finding flow the product refuses. `loop/records.ts` imports
// nothing from `run/`, so this adds no cycle. (The other half of the old pair — the per-run attribution
// read the mirror rule keyed on, deleted with the rule on 2026-11-26 — is not read here any more,
// because the mirror rule is gone; see `raiseFinding`'s D-33c block.)
import { openIssueFindings } from '../loop/records';
// The Seed's change-detector hash, shared with `structureSeed` (tools/knowledge.ts) so the mock's
// P5 refusal fires on exactly the value the real tool would compare (documents/…§3.3).
import { seedHashOf } from '../../shared/seed-hash';
import {
    type Chapter,
    type ChapterSection,
    type Digest,
    type Finding,
    type Goal,
    type Idea,
    type KnowledgeEntry,
    type KnowledgeSource,
    type Plotline,
    type RecordInit,
    type Revision,
    type SeedBrief,
    type Story,
    type StoryPhase,
    type StoredRecord,
    type Summary,
    type Task,
    type Template,
    type TemplateRole,
    type Verdict,
    type VerdictCriterion
} from '../../shared/types';
import type { ToolSchema } from '../llm';
import type { RunToolContext, RunToolHooks, RunToolSession, ToolResult, ToolRuntime } from './types';

// ---------------------------------------------------------------------------
// The context shape and the call log
// ---------------------------------------------------------------------------

/**
 * The context T3's `createContext` returns (`RunToolContext` in `tools/types.ts`), mirrored with
 * `roleKind: string` so the fake does not import a module that is still moving. The field NAMES
 * match, which is what lets the real runtime be dropped in without touching a test.
 */
export interface MockRunContext {
    storyId: string;
    runRef: string;
    templateRef: string;
    roleName: string;
    roleKind: string;
    services: {
        delegate?: (roleName: string, task: string) => Promise<{ ok: boolean; summary?: string; error?: string }>;
    };
}

/** One call that REACHED this runtime — the D-38 acceptance assertions read this list. */
export interface MockToolCall {
    runRef: string;
    roleName: string;
    roleKind: string;
    name: string;
    args: Record<string, unknown>;
}

/** One tool's behaviour in the fake. The runtime is handed in so a test can override one tool and keep the rest. */
export type MockToolHandler = (
    ctx: MockRunContext,
    args: Record<string, unknown>,
    runtime: MockToolRuntime
) => ToolResult | Promise<ToolResult>;

// ---------------------------------------------------------------------------
// Shared plumbing: T-3 scoping, T-4 conflicts, T-5 attribution, D-22 commits
// ---------------------------------------------------------------------------

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** T-4: the token the model was told to send back (`tools/types.ts` re-exports `CAS` for this). */
const expectsOf = (args: Record<string, unknown>): CAS[] =>
    Array.isArray(args.expects) ? (args.expects as CAS[]) : [];

/** T-5: every mutating call carries a reason; `selectRevision`'s lives in `selection_note` (T-2a). */
const whyOf = (args: Record<string, unknown>): string =>
    str(args.why).trim() || str(args.selection_note).trim() || 'tool call with no stated reason (T-5)';

/** P11: the write is credited to the CONTEXT's run — the parent's, for a panel agent or a delegate. */
const attrFor = (ctx: MockRunContext, args: Record<string, unknown>): Attribution => ({
    run_ref: ctx.runRef,
    why: whyOf(args)
});

/** T-3: a record outside this run's Story does not exist for it, and the refusal says which rule. */
function scopedGet<T extends StoredRecord & { story_id: string }>(
    collection: Collection<T>,
    storyId: string,
    id: string
): T | undefined {
    const record = collection.get(id);

    return record !== undefined && record.story_id === storyId ? record : undefined;
}

const outsideStory = (ctx: MockRunContext, id: string): ToolResult => ({
    ok: false,
    refused: 'T-3',
    message: `${id || 'that record'} is not part of story ${ctx.storyId} — a run exists for exactly one Story (T-3)`
});

/**
 * The Phase-1 tools' kind gate (§7.2). This double otherwise never enforces the permission table
 * — the tool layer's own tests do — but `structureSeed`/`writeKnowledge`/`retireKnowledge` are
 * handed to the run layer as the Researcher's and the Editor's, and a run-layer test that scripts
 * a Writer calling one has to see the same P10 a real session would answer.
 */
const wrongKindRefusal = (ctx: MockRunContext, tool: string, holder: string): ToolResult => ({
    ok: false,
    refused: 'P10',
    message: `a ${ctx.roleKind} may not ${tool}: §7.2 reserves it for a ${holder}`
});

/** T-4's rejected-write shape and T-5's missing-`why` shape; anything else is a genuine fault. */
function asToolError(error: unknown): ToolResult {
    if (error instanceof CasConflict) {
        // The CURRENT records ride along — this is the payload that lets a fresh context
        // re-apply its change instead of forcing the write (T-4).
        return { ok: false, cas_conflict: true, currents: error.currents, message: error.message };
    }

    if (error instanceof StoreError) {
        return { ok: false, refused: 'T-5', message: error.message };
    }

    throw error;
}

/**
 * Runs `fn` as one commit group and hands back what it produced.
 *
 * `Store.commit` swallows the callback's return value (its signature is `Promise<void>`), so the
 * value is captured through the closure instead. One group per decision is not cosmetics: D-22's
 * "the selection and the deletion happen in the same commit" and the store's all-or-nothing
 * rollback are what a multi-record tool result depends on.
 */
async function inCommit<T>(store: Store, label: string, fn: () => T): Promise<T> {
    let produced!: T;

    await store.commit(label, () => {
        produced = fn();
    });

    return produced;
}

/** The Story the run is bound to (T-3). */
const storyOf = (runtime: MockToolRuntime, ctx: MockRunContext): Story | undefined =>
    runtime.store.stories.get(ctx.storyId);

/** The CURRENT Digest by highest rev — the same rule ./brief applies, so brief and read agree (D-12a). */
function currentDigest(runtime: MockToolRuntime, storyId: string): Digest | undefined {
    const owned = runtime.store.digests.list().filter((digest) => digest.story_id === storyId);

    if (owned.length === 0) return undefined;

    return owned.reduce((best, digest) => (digest.rev > best.rev ? digest : best));
}

/** The competing drafts of one unit, in id order — the order a select brief renders them in (D-21). */
function competingOf(runtime: MockToolRuntime, storyId: string, unitRef: string): Revision[] {
    return runtime.store.revisions
        .list()
        .filter(
            (revision) =>
                revision.story_id === storyId &&
                revision.unit_ref === unitRef &&
                (revision.state === 'drafted' || revision.state === 'competing')
        )
        .sort((left, right) => left.id.localeCompare(right.id));
}

// ---------------------------------------------------------------------------
// The tool set (T3's names, T3's result shapes)
// ---------------------------------------------------------------------------

/**
 * W3b (2026-11-26) — ONE verdict ROW from one target's args, shared by the double's `submitVerdict`
 * primary call and every entry of its `verdicts[]` array, so a scripted terminal report and a real
 * session file the same rows. The double stays LENIENT on purpose (it enforces neither D-15's evidence
 * bar nor D-33b's kind/cost pairing — §8.4's fake exists so run tests never depend on a refusal they
 * did not script); what it must share is the SHAPE: one row per target, `criteria_passed` per target,
 * `hard_pass` computed from the hard criteria in that row only.
 *
 * `criteria_passed` is accepted beside `criteria` because the tool's nested `verdicts[]` entries carry
 * `criteria_passed`, so a scripted call can read exactly like a real one.
 */
async function mockVerdictRow(
    ctx: MockRunContext,
    args: Record<string, unknown>,
    runtime: MockToolRuntime
): Promise<Verdict> {
    const criteria = Array.isArray(args.criteria)
        ? (args.criteria as VerdictCriterion[])
        : Array.isArray(args.criteria_passed)
          ? (args.criteria_passed as VerdictCriterion[])
          : [];
    const hardIds = new Set(BUILT_IN_CRITERIA.filter((criterion) => criterion.hard).map((criterion) => criterion.id));

    return inCommit(runtime.store, 'submit_verdict', () =>
        runtime.store.verdicts.create(
            {
                story_id: ctx.storyId,
                target_ref: str(args.target_ref),
                target_kind: str(args.target_kind) || 'chapter',
                run_ref: ctx.runRef,
                template_ref: ctx.templateRef,
                round: num(args.round) || 1,
                // P4/D-15: a verdict is per-criterion with an evidence line, never a score.
                criteria_passed: criteria,
                hard_pass: criteria.filter((entry) => hardIds.has(entry.criterion)).every((entry) => entry.result),
                soft_count: criteria.filter((entry) => entry.result).length,
                recommendation: (str(args.recommendation) || 'advance') as Verdict['recommendation']
            },
            attrFor(ctx, args)
        )
    );
}

/**
 * F3 (2026-11-26) — D-33c's admissibility for one scripted REPORT, the double's copy of
 * `tools/reader.ts:findingGateOf`: the rows open BEFORE the report wrote anything, plus how many
 * `kind: issue` entries that report carries itself.
 *
 * WHY THE DOUBLE NEEDS IT. `submitVerdict`'s `findings[]` used to ask the store per entry, so a scripted
 * `[proposal, issue]` report FILED the proposal on a clear board while `[issue, proposal]` dismissed it.
 * The product no longer behaves that way (admissibility is resolved once, before the first write), and this
 * class exists so a scripted crew cannot script a sequence the server refuses — the same argument the
 * comment on {@link mockFileFinding} makes for the gate itself.
 */
type MockFindingGate = { openIssues: Finding[]; sameReportIssues: number };

function mockFindingGate(
    ctx: MockRunContext,
    runtime: MockToolRuntime,
    entries: Record<string, unknown>[]
): MockFindingGate {
    return {
        openIssues: openIssueFindings(runtime.store, ctx.storyId),
        // KIND-TOLERANT, exactly like `mockFileFinding` below: anything that is not `proposal` is an issue.
        sameReportIssues: entries.filter((entry) => str(entry.kind) !== 'proposal').length
    };
}

/**
 * The dismissal answer, mirroring `tools/reader.ts:dismissedProposal` — same rule id, same reason-not-a-
 * queue framing (F3), same additive `same_report_issues` key — in this double's FLAT shape, because the run
 * layer's transcript reads that shape rather than the tool's `data` envelope.
 */
function mockDismissedProposal(gate: MockFindingGate) {
    const openIds = gate.openIssues.map((issue) => issue.id);
    const total = openIds.length + gate.sameReportIssues;
    const causes: string[] = [];

    if (openIds.length > 0) causes.push(`open before this call — ${openIds.join(', ')}`);
    if (gate.sameReportIssues > 0)
        causes.push(
            openIds.length > 0
                ? `plus ${gate.sameReportIssues} ${gate.sameReportIssues === 1 ? 'issue' : 'issues'} filed by this same report`
                : 'filed by this same report'
        );

    return {
        ok: true,
        dismissed: 'D-33c',
        filed: false,
        kind: 'proposal' as Finding['kind'],
        message: `this proposal is dismissed, not filed — the reason is ${total} ${total === 1 ? 'issue' : 'issues'}: ${causes.join('; ')}. A suggestion about a book that still has defects is not what this round is for, and the dismissal settles the claim here: no row, no count, nothing to answer. Conclude this pass — submit your verdict (D-33c).`,
        // PRE-CALL rows only, so a scripted pass is never told its own submission was already on the board.
        open_issues: openIds.length,
        open_issue_refs: openIds,
        ...(gate.sameReportIssues > 0 ? { same_report_issues: gate.sameReportIssues } : {})
    };
}

/**
 * W3b (2026-11-26) — ONE finding from an args record: the whole `raiseFinding` handler, lifted here so
 * `submitVerdict`'s `findings[]` files each entry through the SAME D-33c gate and the SAME D-16 dedupe
 * as a standalone call (the tool layer does the same lift in `tools/reader.ts:fileFinding`). The
 * scripted crew cannot script a sequence the product refuses, and a terminal report in a run test
 * behaves like the real terminal call.
 *
 * F3 adds the optional {@link MockFindingGate}: a batch caller hands in the D-33c answer it resolved before
 * the batch wrote anything, so an entry's fate cannot depend on its position in `findings[]`.
 */
async function mockFileFinding(
    ctx: MockRunContext,
    args: Record<string, unknown>,
    runtime: MockToolRuntime,
    gate?: MockFindingGate
) {
    const criterionRef = str(args.criterion_ref);
    const targetRef = str(args.target_ref);
    // T5: the mock is KIND-TOLERANT. An omitted or unknown `kind` is an `issue`, the same reading
    // the real tool normalises to, and the dedupe key follows `utilities.ts:findingFingerprint`'s
    // rule: `issue` keeps the pre-field two-part key (so a scripted repeat still matches), and an
    // `proposal` marks itself so a proposal does not collapse into the defect beside it.
    const kind: Finding['kind'] = str(args.kind) === 'proposal' ? 'proposal' : 'issue';
    const fingerprint = kind === 'proposal' ? `${criterionRef}|${targetRef}|proposal` : `${criterionRef}|${targetRef}`;

    // D-33c — the mock crew files under the SAME issues-first rule the real tool enforces,
    // because an integration test that ran the loop through this double would otherwise exercise
    // a flow the product no longer allows (a proposal approved over an open defect) and report
    // green for a sequence the server refuses. Same predicate, same rule id, same answer as
    // `tools/reader.ts:raiseFinding` + `dismissedProposal`:
    //   a `proposal` over an unresolved issue is DISMISSED (2026-11-26) — `ok: true`, no row,
    //   no `seen_count`, and the answer names the open issues that dismissed it: that roster is the
    //   REASON, not a queue the claim waits behind, and the claim is spent for this pass (nothing is
    //   parked and there is no retry to re-arm). It is NOT a refusal:
    //   the old `{ok:false, refused:'D-33c'}` shape told the scripted crew its call was wrong
    //   and listed exits to try, which is the retry loop the rule now closes at the first call.
    //   "Unresolved" is the ONE holding set `loop/types.ts:ISSUE_HOLDING_STATES` (`unconfirmed`,
    //   `confirmed`, `approved`): a `disputed` row is not a defect and does not hold, exactly as
    //   in the real tool, so a loop test cannot report green for an answer the product removed.
    // The mirror rule (an `issue` refused after this run filed a proposal) is GONE, in the
    // double as in the tool: it could only ever refuse a DEFECT, and the ordering it protected
    // is carried by this gate plus D-33d's approval gate.
    // The result shape is this double's own (flat, like every other handler here), not the tool
    // layer's `data` envelope, because that is what the run layer's transcript reads.
    if (kind === 'proposal') {
        // F3 (2026-11-26): the answer comes from the GATE when the caller is filing a report, and from the
        // store when it is filing one claim — the same split `tools/reader.ts:fileFinding` makes, so the
        // double and the product agree about which entry in `findings[]` survives.
        const resolved = gate ?? { openIssues: openIssueFindings(runtime.store, ctx.storyId), sameReportIssues: 0 };

        if (resolved.openIssues.length > 0 || resolved.sameReportIssues > 0) return mockDismissedProposal(resolved);
    }

    // D-16/D-32: the dedupe lives in the tool layer, and the ANSWER names the existing
    // record — a fresh context that is told `repeat` can stop, which is the mechanism that
    // makes "no progress" visible in an amnesiac loop.
    const existing = runtime.store.findings
        .list()
        .find(
            (row) =>
                row.story_id === ctx.storyId &&
                row.fingerprint === fingerprint &&
                row.state !== 'fixed' &&
                row.state !== 'discarded'
        );

    if (existing !== undefined) {
        const bumped = await inCommit(runtime.store, 'raise_finding', () =>
            runtime.store.findings.update(existing.id, { seen_count: existing.seen_count + 1 }, attrFor(ctx, args))
        );

        return {
            ok: true,
            repeat: true,
            finding_id: bumped.id,
            // T5: the kind the open row actually carries, echoed like the real tool does.
            kind: bumped.kind ?? 'issue',
            rev: bumped.rev
        };
    }

    const created = await inCommit(runtime.store, 'raise_finding', () =>
        runtime.store.findings.create(
            {
                story_id: ctx.storyId,
                target_ref: targetRef,
                criterion_ref: criterionRef,
                title: str(args.title),
                detail: str(args.detail) || undefined,
                evidence: str(args.evidence),
                cost: (str(args.cost) || 'minor') as Finding['cost'],
                // T5: stored explicitly, default included — the same discipline the real tool
                // follows, so a scripted row and a tool-written row read alike.
                kind,
                fingerprint,
                state: 'unconfirmed',
                seen_count: 1
            },
            attrFor(ctx, args)
        )
    );

    return { ok: true, finding_id: created.id, kind: created.kind ?? 'issue', rev: created.rev };
}
/**
 * The §8 surface the run layer exercises: the §8.1 read names (so `isReadOnlyTool`'s prefix rule is
 * exercised against real names) and the §8.2/§8.3/§8.4 write and report names.
 */
function defaultTools(): Record<string, MockToolHandler> {
    return {
        // -- §8.1 reads (T-8: each names the revision it read) ----------------------------------
        readSeed: (ctx, args, runtime) => {
            const story = storyOf(runtime, ctx);

            return story === undefined
                ? { ok: false, refused: 'T-3', message: `no story ${ctx.storyId} in the store (T-3)` }
                : { ok: true, data: { seed: story.idea }, rev: story.rev };
        },
        readSummary: (ctx, args, runtime) => {
            const summary = runtime.store.summaries.list().find((row) => row.story_id === ctx.storyId);

            return summary === undefined ? { ok: true, data: null } : { ok: true, data: summary, rev: summary.rev };
        },
        readDigest: (ctx, args, runtime) => {
            const digest = currentDigest(runtime, ctx.storyId);

            return digest === undefined ? { ok: true, data: null } : { ok: true, data: digest, rev: digest.rev };
        },
        readChapter: (ctx, args, runtime) => {
            const chapter = scopedGet(runtime.store.chapters, ctx.storyId, str(args.chapter_id));

            return chapter === undefined
                ? outsideStory(ctx, str(args.chapter_id))
                : { ok: true, data: chapter, rev: chapter.rev };
        },
        readPlotline: (ctx, args, runtime) => {
            const plotline = scopedGet(runtime.store.plotlines, ctx.storyId, str(args.plotline_id));

            return plotline === undefined
                ? outsideStory(ctx, str(args.plotline_id))
                : { ok: true, data: plotline, rev: plotline.rev };
        },
        readGoals: (ctx, args, runtime) => ({
            ok: true,
            data: runtime.store.goals.list().filter((goal) => goal.story_id === ctx.storyId)
        }),
        readFindings: (ctx, args, runtime) => ({
            ok: true,
            data: runtime.store.findings.list().filter((row) => row.story_id === ctx.storyId)
        }),
        readVerdicts: (ctx, args, runtime) => ({
            ok: true,
            data: runtime.store.verdicts.list().filter((row) => row.story_id === ctx.storyId)
        }),
        listTasks: (ctx, args, runtime) => ({
            ok: true,
            data: runtime.store.tasks.list().filter((row) => row.story_id === ctx.storyId)
        }),
        listIdeas: (ctx, args, runtime) => ({
            ok: true,
            data: runtime.store.ideas.list().filter((row) => row.story_id === ctx.storyId)
        }),
        listRevisions: (ctx, args, runtime) => ({
            ok: true,
            data: competingOf(runtime, ctx.storyId, str(args.unit_ref))
        }),

        // -- T-6c: the catalogue is readable from inside the run ---------------------------------
        listTools: (ctx, args, runtime) => ({ ok: true, data: { tools: runtime.toolNames() } }),
        describeTool: (ctx, args, runtime) => {
            const name = str(args.name);
            const schema = runtime.definitionOf(name);

            return schema === undefined
                ? {
                      ok: false,
                      refused: 'T-6c',
                      message: `no tool named ${name} (T-6c) — listTools names what this session holds`
                  }
                : { ok: true, data: schema.function };
        },

        // -- §8.4 plumbing: what the readers live on -------------------------------------------
        // W3b (2026-11-26) — `submitVerdict` is the TERMINAL report of a review pass, in the double as in
        // the tool: the classic verdict plus the OPTIONAL `verdicts[]` (further targets, §6.2a/D-21) and
        // `findings[]` (every claim the critic is certain of), each filed through the SAME helper a
        // standalone call uses, so a scripted terminal report behaves like a real one. The result keeps
        // this double's flat shape (`id`/`rev`, not the tool's `data` envelope) because that is what the
        // run layer's transcript reads; the extra arrays are receipts of the rows this call wrote.
        submitVerdict: async (ctx, args, runtime) => {
            // F3 (2026-11-26): D-33c is resolved for the WHOLE report before any of it files, exactly as
            // `tools/reader.ts:submitVerdict` does, so a scripted `[proposal, issue]` pass reaches the same
            // answer as `[issue, proposal]` and this double cannot green-light a sequence the product
            // refuses. Verdict rows do not hold a proposal, which is why the gate may be read first.
            const extraFindings = Array.isArray(args.findings) ? (args.findings as Record<string, unknown>[]) : [];
            const gate = mockFindingGate(ctx, runtime, extraFindings);
            const created = await mockVerdictRow(ctx, args, runtime);
            const extraVerdicts = Array.isArray(args.verdicts) ? (args.verdicts as Record<string, unknown>[]) : [];
            const verdicts: Record<string, unknown>[] = [];
            const findings: Record<string, unknown>[] = [];

            for (const entry of extraVerdicts) {
                const row = await mockVerdictRow(
                    ctx,
                    {
                        ...entry,
                        // The primary's recommendation is the default, exactly as in the tool: two reports
                        // about one text are meant to reach the same answer (D-21).
                        recommendation: entry.recommendation ?? args.recommendation,
                        // T-5 in the double: the attribution's `why` falls back to the call's reason.
                        why: entry.why ?? args.why
                    },
                    runtime
                );

                verdicts.push({ ok: true, id: row.id, rev: row.rev, target_ref: row.target_ref });
            }

            // Every entry is judged against the ONE gate above — never against the rows its siblings wrote.
            for (const entry of extraFindings)
                findings.push(await mockFileFinding(ctx, { ...entry, why: entry.why ?? args.why }, runtime, gate));

            return {
                ok: true,
                id: created.id,
                rev: created.rev,
                ...(verdicts.length > 0 ? { verdicts } : {}),
                ...(findings.length > 0 ? { findings } : {}),
                ...(verdicts.length + findings.length > 0
                    ? { reported: { verdicts: verdicts.length + 1, findings: findings.length } }
                    : {})
            };
        },
        raiseFinding: async (ctx, args, runtime) => mockFileFinding(ctx, args, runtime),
        createTask: async (ctx, args, runtime) => {
            const created = await inCommit(runtime.store, 'create_task', () =>
                runtime.store.tasks.create(
                    {
                        story_id: ctx.storyId,
                        kind: str(args.kind) || 'fix',
                        title: str(args.title),
                        detail: str(args.detail) || undefined,
                        owner_role: str(args.owner_role) || undefined,
                        state: 'open',
                        priority: args.priority === undefined ? 2 : num(args.priority),
                        criterion_ref: str(args.criterion_ref) || undefined,
                        attempts: 0
                    },
                    attrFor(ctx, args)
                )
            );

            return { ok: true, id: created.id, rev: created.rev };
        },
        requestAuthor: async (ctx, args, runtime) => {
            // §8.3's escalation (P7). Recorded as a blocked task, which is what the loop reads; the
            // run layer only needs the call to be a real write with a real row behind it.
            const created = await inCommit(runtime.store, 'request_author', () =>
                runtime.store.tasks.create(
                    {
                        story_id: ctx.storyId,
                        kind: 'author_question',
                        title: str(args.question) || 'the run needs a decision from the Author',
                        state: 'blocked',
                        priority: 1,
                        attempts: 0
                    },
                    attrFor(ctx, args)
                )
            );

            return { ok: true, id: created.id, rev: created.rev };
        },

        // -- §8.2 editor writes: all CAS'd, all one commit group ---------------------------------
        selectRevision: async (ctx, args, runtime) => {
            const unitRef = str(args.unit_ref);
            const revisionId = str(args.revision_id);

            if (scopedGet(runtime.store.revisions, ctx.storyId, revisionId) === undefined)
                return outsideStory(ctx, revisionId);

            try {
                // T-4 BEFORE the commit: a stale `expects` writes nothing at all and returns the
                // current records, which is the whole of "re-read and re-apply, do not force".
                // (`_assertCas` is the store's own T-4 gate — the one `update(..., expects)` calls.)
                runtime.store._assertCas(expectsOf(args));

                const chosen = await inCommit(runtime.store, 'select_revision', () => {
                    const updated = runtime.store.revisions.update(
                        revisionId,
                        // T-2a/L-17: the note is the Author's only window into automated taste, and
                        // the panel's dissent rides on exactly this field (D-38).
                        { state: 'selected', selection_note: str(args.selection_note) },
                        attrFor(ctx, args)
                    );

                    // D-22: the losers go in the same commit — hard, not a flag.
                    for (const sibling of runtime.store.revisions.list()) {
                        if (
                            sibling.story_id !== ctx.storyId ||
                            sibling.unit_ref !== unitRef ||
                            sibling.id === revisionId
                        )
                            continue;
                        if (sibling.state !== 'drafted' && sibling.state !== 'competing') continue;

                        runtime.store.revisions.delete(sibling.id, attrFor(ctx, args));
                    }

                    // §4.4's unit pointer — the only record §4 gives one.
                    const chapter = scopedGet(runtime.store.chapters, ctx.storyId, unitRef);

                    if (chapter !== undefined) {
                        runtime.store.chapters.update(chapter.id, { current_revision: updated.id }, attrFor(ctx, args));
                    }

                    return updated;
                });

                return { ok: true, rev: chosen.rev, data: { revision_id: chosen.id } };
            } catch (error) {
                return asToolError(error);
            }
        },
        rejectAll: async (ctx, args, runtime) => {
            const unitRef = str(args.unit_ref);

            try {
                runtime.store._assertCas(expectsOf(args));
            } catch (error) {
                return asToolError(error);
            }

            let deleted = 0;

            await inCommit(runtime.store, 'reject_all', () => {
                for (const sibling of competingOf(runtime, ctx.storyId, unitRef)) {
                    runtime.store.revisions.delete(sibling.id, attrFor(ctx, args));
                    deleted += 1;
                }

                // L-18: rejecting everything is a decision with a consequence. The unit needs
                // another pass, and the queue is how an amnesiac loop remembers that.
                runtime.store.tasks.create(
                    {
                        story_id: ctx.storyId,
                        kind: 'rewrite',
                        title: `rewrite ${unitRef} — every draft was rejected`,
                        state: 'open',
                        priority: 1,
                        attempts: 0
                    },
                    attrFor(ctx, args)
                );
            });

            return { ok: true, data: { deleted, unit_ref: unitRef } };
        },
        requestMerge: async (ctx, args, runtime) => {
            // L-19: the Editor names the parts; the Writer writes the seam. So a merge request is a
            // task, not a piece of prose.
            const created = await inCommit(runtime.store, 'request_merge', () =>
                runtime.store.tasks.create(
                    {
                        story_id: ctx.storyId,
                        kind: 'merge',
                        title: `merge ${str(args.unit_ref)} — ${str(args.merge_plan) || 'parts named'}`,
                        detail: str(args.selection_note) || undefined,
                        state: 'open',
                        priority: 1,
                        attempts: 0
                    },
                    attrFor(ctx, args)
                )
            );

            return { ok: true, id: created.id, rev: created.rev };
        },
        verifyFinding: async (ctx, args, runtime) => {
            const findingId = str(args.finding_id);
            const finding = scopedGet(runtime.store.findings, ctx.storyId, findingId);

            if (finding === undefined) return outsideStory(ctx, findingId);

            try {
                const updated = runtime.store.findings.update(
                    findingId,
                    {
                        // D-33/D-34: the Editor rewrites the claim into one the Author can read in a
                        // single pass and sets the cost it ACTUALLY deserves.
                        title: str(args.title) || finding.title,
                        detail: args.detail === undefined ? finding.detail : str(args.detail),
                        evidence: str(args.evidence) || finding.evidence,
                        cost: (str(args.cost) || finding.cost) as Finding['cost'],
                        state: str(args.verdict) === 'disputed' ? 'disputed' : 'confirmed',
                        confirmed_by: ctx.runRef
                    } satisfies UpdatePatch<Finding>,
                    attrFor(ctx, args),
                    expectsOf(args)
                );

                return { ok: true, rev: updated.rev };
            } catch (error) {
                return asToolError(error);
            }
        },
        verifyIdea: async (ctx, args, runtime) => {
            const ideaId = str(args.idea_id);
            const idea = scopedGet(runtime.store.ideas, ctx.storyId, ideaId);

            if (idea === undefined) return outsideStory(ctx, ideaId);

            try {
                const updated = runtime.store.ideas.update(
                    ideaId,
                    {
                        // D-27/D-31: the fact-check and the guidelines answer stay separate fields.
                        verification: {
                            verdict: (str(args.verdict) || 'confirmed') as NonNullable<Idea['verification']>['verdict'],
                            evidence: str(args.evidence),
                            meets_guidelines: args.meets_guidelines === true,
                            checked_by_run: ctx.runRef,
                            checked_at: new Date().toISOString()
                        },
                        state: str(args.verdict) === 'refuted' ? 'refuted' : 'verified'
                    } satisfies UpdatePatch<Idea>,
                    attrFor(ctx, args),
                    expectsOf(args)
                );

                return { ok: true, rev: updated.rev };
            } catch (error) {
                return asToolError(error);
            }
        },
        markUnverifiable: async (ctx, args, runtime) => {
            const ideaId = str(args.idea_id);

            if (scopedGet(runtime.store.ideas, ctx.storyId, ideaId) === undefined) return outsideStory(ctx, ideaId);

            try {
                const updated = runtime.store.ideas.update(
                    ideaId,
                    {
                        verification: {
                            verdict: 'unverifiable' as NonNullable<Idea['verification']>['verdict'],
                            evidence: str(args.evidence) || 'could not be checked from this run',
                            meets_guidelines: false,
                            checked_by_run: ctx.runRef,
                            checked_at: new Date().toISOString()
                        }
                    } satisfies UpdatePatch<Idea>,
                    attrFor(ctx, args),
                    expectsOf(args)
                );

                return { ok: true, rev: updated.rev };
            } catch (error) {
                return asToolError(error);
            }
        },
        approveFinding: async (ctx, args, runtime) => {
            const findingId = str(args.finding_id);

            if (scopedGet(runtime.store.findings, ctx.storyId, findingId) === undefined)
                return outsideStory(ctx, findingId);

            const decision = str(args.decision);

            // The rig lets the SWEEP apply the dial (`auto`), which is the path that also creates
            // the fix task (engine.scanStory's L-1 step 2). Writing the approval here would skip
            // that path and leave the finding approved with no work behind it.
            if (decision === 'auto') return { ok: true };

            // D-33d — the mirror of `tools/editor.ts:approveFinding`: issues are in focus before
            // anything else can be done, so a `proposal` is not approved while the Story carries an
            // unresolved issue, and only a DISCARD is exempt (declining a change is not an approval).
            // `auto` is exempt here for the reason above — the sweep performs that approval, and the
            // sweep itself skips proposals (engine's `loop_auto_approve`), which is where the real
            // tool's `auto` refusal is mirrored.
            const row = scopedGet(runtime.store.findings, ctx.storyId, findingId);

            if (decision !== 'discard' && row?.kind === 'proposal') {
                const openIssues = openIssueFindings(runtime.store, ctx.storyId);

                if (openIssues.length > 0) {
                    return {
                        ok: false,
                        refused: 'D-33d',
                        message: `proposal ${findingId} cannot be approved while ${openIssues.length} ${openIssues.length === 1 ? 'issue is' : 'issues are'} unresolved — ${openIssues.map((issue) => issue.id).join(', ')} — because issues are in focus before anything else can be done (D-33d). Only \`unconfirmed\`, \`confirmed\` and \`approved\` issues are in that set: one you marked \`disputed\` already released this proposal.`,
                        open_issues: openIssues.length,
                        open_issue_refs: openIssues.map((issue) => issue.id)
                    };
                }
            }

            try {
                const updated = runtime.store.findings.update(
                    findingId,
                    {
                        state: decision === 'discard' ? 'discarded' : 'approved',
                        approved_by: ctx.runRef
                    } satisfies UpdatePatch<Finding>,
                    attrFor(ctx, args),
                    expectsOf(args)
                );

                return { ok: true, rev: updated.rev };
            } catch (error) {
                return asToolError(error);
            }
        },
        confirmFinding: async (ctx, args, runtime) => {
            const findingId = str(args.finding_id);
            const finding = scopedGet(runtime.store.findings, ctx.storyId, findingId);

            if (finding === undefined) return outsideStory(ctx, findingId);
            if (finding.state !== 'confirmed' && finding.state !== 'approved')
                return {
                    ok: false,
                    refused: 'D-33',
                    message: `finding ${findingId} is ${finding.state}; only an Editor-confirmed finding reaches the Critic's confirmation`
                };

            const dispute = str(args.verdict) === 'dispute';

            try {
                const updated = runtime.store.findings.update(
                    findingId,
                    {
                        state: dispute ? 'disputed' : finding.state,
                        critic_confirmed: !dispute,
                        critic_confirmed_by: ctx.runRef,
                        evidence: `${finding.evidence}\n\nCritic confirmation: ${str(args.evidence)}`
                    } satisfies UpdatePatch<Finding>,
                    attrFor(ctx, args),
                    expectsOf(args)
                );

                if (dispute) {
                    for (const task of runtime.store.tasks.list()) {
                        if (task.story_id !== ctx.storyId || task.finding_ref !== findingId) continue;
                        if (task.state !== 'open' && task.state !== 'claimed' && task.state !== 'blocked') continue;

                        runtime.store.tasks.update(task.id, { state: 'wontfix' }, attrFor(ctx, args));
                    }
                }

                return { ok: true, rev: updated.rev };
            } catch (error) {
                return asToolError(error);
            }
        },
        reviewSeed: async (_ctx, args) => ({ ok: true, data: { verdict: str(args.verdict) || 'accept' } }),
        editChapter: async (ctx, args, runtime) => {
            const chapterId = str(args.chapter_id);

            if (scopedGet(runtime.store.chapters, ctx.storyId, chapterId) === undefined)
                return outsideStory(ctx, chapterId);

            const patch: UpdatePatch<Chapter> = {};

            if (args.title !== undefined) patch.title = str(args.title);
            if (args.summary !== undefined) patch.summary = str(args.summary);
            if (Array.isArray(args.sections)) patch.sections = args.sections as ChapterSection[];

            try {
                const updated = runtime.store.chapters.update(chapterId, patch, attrFor(ctx, args), expectsOf(args));

                return { ok: true, rev: updated.rev };
            } catch (error) {
                return asToolError(error);
            }
        },
        editSummary: async (ctx, args, runtime) => {
            // HARDENING (R6): mirror the real tool's group-book refusal (tools/writer.ts) — the
            // five prose fields are the install's projection on a grouped book, here too.
            if (isGroupManagedStory(runtime.store.stories.get(ctx.storyId)))
                return {
                    ok: false,
                    refused: 'R6',
                    message:
                        'this book writes its Summary group by group, so the prose fields are the mirror the install writes (R6) — use the grouped draft_groups job or the per-group revise route'
                };

            const summary = runtime.store.summaries.list().find((row) => row.story_id === ctx.storyId);

            if (summary === undefined) {
                return {
                    ok: false,
                    refused: 'T-3',
                    message: `story ${ctx.storyId} has no Summary record to edit (T-3)`
                };
            }

            const patch: UpdatePatch<Summary> = {};

            for (const field of ['premise', 'promise', 'theme', 'tone', 'ending', 'world_rules'] as const) {
                if (args[field] !== undefined) patch[field] = str(args[field]);
            }

            try {
                const updated = runtime.store.summaries.update(summary.id, patch, attrFor(ctx, args), expectsOf(args));

                return { ok: true, rev: updated.rev };
            } catch (error) {
                return asToolError(error);
            }
        },
        markChapterDone: async (ctx, args, runtime) => {
            const chapterId = str(args.chapter_id);

            if (scopedGet(runtime.store.chapters, ctx.storyId, chapterId) === undefined)
                return outsideStory(ctx, chapterId);

            try {
                const updated = runtime.store.chapters.update(
                    chapterId,
                    { state: 'done' } satisfies UpdatePatch<Chapter>,
                    attrFor(ctx, args),
                    expectsOf(args)
                );

                return { ok: true, rev: updated.rev };
            } catch (error) {
                return asToolError(error);
            }
        },
        proposeIdea: async (ctx, args, runtime) => {
            // D-26/D-28: a Critic proposes, the row starts `proposed`, and nothing else happens —
            // the pick is the Author's (P10).
            const created = await inCommit(runtime.store, 'propose_idea', () =>
                runtime.store.ideas.create(
                    {
                        story_id: ctx.storyId,
                        phase: (str(args.phase) || 'chapters') as StoryPhase,
                        unit_ref: str(args.unit_ref) || undefined,
                        body: str(args.body),
                        kind: (str(args.kind) || 'possibility') as Idea['kind'],
                        author: ctx.roleName,
                        sources: Array.isArray(args.sources) ? (args.sources as Idea['sources']) : [],
                        fingerprint: str(args.body).slice(0, 120),
                        seen_count: 1,
                        state: 'proposed'
                    },
                    attrFor(ctx, args)
                )
            );

            return { ok: true, id: created.id, rev: created.rev };
        },

        // -- Phase-1 research (documents/phase-1-research-pipeline.md §7.1) ---------------------
        // The five tools a run-layer test may now script. They are schema-faithful enough for the
        // run layer's purposes (a real row, a real commit, a real refusal code) and they mirror the
        // REAL tool's one structural guard per call: the kind gate (§7.2), the Seed hash (P5), and
        // the retire refusal. The fingerprint here is mock-local on purpose — the run layer's rig
        // must not import T3's tools module, which is the whole reason this double exists.
        structureSeed: async (ctx, args, runtime) => {
            if (ctx.roleKind !== 'editor') return wrongKindRefusal(ctx, 'structureSeed', 'editor');

            const story = storyOf(runtime, ctx);

            if (story === undefined)
                return { ok: false, refused: 'T-3', message: `no story ${ctx.storyId} in the store (T-3)` };

            const currentHash = seedHashOf(story.idea);

            if (str(args.seed_hash).trim() !== currentHash)
                return {
                    ok: false,
                    refused: 'P5',
                    message: `seed_hash does not match the Seed this Story holds now (${currentHash}): re-derive from the current Seed`
                };

            const accepted = runtime.store.seedBriefs
                .list()
                .find(
                    (row) => row.story_id === ctx.storyId && row.seed_hash === currentHash && row.status === 'accepted'
                );

            if (accepted !== undefined) return { ok: true, repeat: true, id: accepted.id, rev: accepted.rev };

            const created = await inCommit(runtime.store, 'structure_seed', () => {
                for (const row of runtime.store.seedBriefs
                    .list()
                    .filter((brief) => brief.story_id === ctx.storyId && brief.status === 'accepted'))
                    runtime.store.seedBriefs.update(row.id, { status: 'draft' }, attrFor(ctx, args));

                return runtime.store.seedBriefs.create(
                    {
                        story_id: ctx.storyId,
                        seed_hash: currentHash,
                        logline: str(args.logline),
                        protagonist: str(args.protagonist),
                        want: str(args.want),
                        need: str(args.need) || undefined,
                        obstacle: str(args.obstacle),
                        stakes: str(args.stakes),
                        setting: str(args.setting),
                        world_rules: Array.isArray(args.world_rules) ? (args.world_rules as string[]) : [],
                        promise: str(args.promise),
                        tone_hints: str(args.tone_hints) || undefined,
                        constraints: Array.isArray(args.constraints) ? (args.constraints as string[]) : [],
                        open_questions: Array.isArray(args.open_questions) ? (args.open_questions as string[]) : [],
                        // D-51: the arg, WHEN SENT, is stored as sent — `[]` is the Editor's waiver and
                        // must survive the round trip. An absent arg keeps the pre-D-51 row shape (no
                        // field), which `records.ts:researchGate` reads as `needed`. The double does not
                        // require the arg, because its job is the row shape, not the schema guard.
                        ...(Array.isArray(args.research_questions)
                            ? { research_questions: args.research_questions as string[] }
                            : {}),
                        status: 'accepted'
                    },
                    attrFor(ctx, args)
                ) as SeedBrief;
            });

            return { ok: true, id: created.id, rev: created.rev };
        },
        writeKnowledge: async (ctx, args, runtime) => {
            if (ctx.roleKind !== 'researcher') return wrongKindRefusal(ctx, 'writeKnowledge', 'researcher');

            const topic = str(args.topic).trim();
            const claim = str(args.claim).trim();
            const sources = Array.isArray(args.sources) ? (args.sources as KnowledgeSource[]) : [];

            // Mock-local fingerprint: the same (story, topic, claim) key the real tool hashes.
            const fingerprint = `mock|${ctx.storyId}|${topic.toLowerCase()}|${claim.toLowerCase()}`;
            const existing = runtime.store.knowledge
                .list()
                .find((row) => row.story_id === ctx.storyId && row.fingerprint === fingerprint);

            if (existing !== undefined) {
                const merged = [...existing.sources];

                for (const source of sources)
                    if (!merged.some((row) => row.url_or_title === source.url_or_title)) merged.push(source);

                const bumped = await inCommit(runtime.store, 'write_knowledge', () =>
                    runtime.store.knowledge.update(
                        existing.id,
                        {
                            seen_count: existing.seen_count + 1,
                            importance: (str(args.importance) || existing.importance) as KnowledgeEntry['importance'],
                            sources: merged,
                            author: ctx.roleName
                        },
                        attrFor(ctx, args)
                    )
                );

                return { ok: true, repeat: true, id: bumped.id, rev: bumped.rev };
            }

            const created = await inCommit(runtime.store, 'write_knowledge', () =>
                runtime.store.knowledge.create(
                    {
                        story_id: ctx.storyId,
                        kind: (str(args.kind) || 'fact') as KnowledgeEntry['kind'],
                        topic: topic.toLowerCase(),
                        claim,
                        detail: str(args.detail) || undefined,
                        importance: (str(args.importance) || 'normal') as KnowledgeEntry['importance'],
                        sources,
                        fingerprint,
                        seen_count: 1,
                        author: ctx.roleName,
                        phase: (str(args.phase) || undefined) as StoryPhase | undefined
                    },
                    attrFor(ctx, args)
                )
            );

            return { ok: true, id: created.id, rev: created.rev };
        },
        readKnowledge: (ctx, args, runtime) => ({
            ok: true,
            data: runtime.store.knowledge
                .list()
                .filter((row) => row.story_id === ctx.storyId)
                .filter((row) => (str(args.importance) ? row.importance === str(args.importance) : true))
                .filter((row) => (str(args.kind) ? row.kind === str(args.kind) : true))
                .filter((row) => (str(args.topic) ? row.topic.includes(str(args.topic).toLowerCase()) : true))
        }),
        retireKnowledge: async (ctx, args, runtime) => {
            if (ctx.roleKind !== 'researcher') return wrongKindRefusal(ctx, 'retireKnowledge', 'researcher');

            const entry = scopedGet(runtime.store.knowledge, ctx.storyId, str(args.knowledge_id));

            if (entry === undefined) return outsideStory(ctx, str(args.knowledge_id));
            if (entry.importance === 'low')
                return {
                    ok: false,
                    refused: 'T-11',
                    message: `knowledge ${entry.id} is already low importance, so there is nothing to retire`
                };

            try {
                const updated = runtime.store.knowledge.update(
                    entry.id,
                    {
                        importance: 'low',
                        detail: `${entry.detail ? `${entry.detail}\n\n` : ''}(retired) ${whyOf(args)}`
                    },
                    attrFor(ctx, args),
                    expectsOf(args)
                );

                return { ok: true, rev: updated.rev };
            } catch (error) {
                return asToolError(error);
            }
        },

        // D-51: the Researcher's zero-write closing report. The double mirrors the real tool's guards —
        // the §7.2 kind gate, the stated rationale, and the Seed Brief READ from the record — and then
        // writes nothing at all. That absence is the tool's whole point, so what the run layer asserts
        // is the run's own tally: a run that reports here is not a no-op turn (S-4) even though the
        // store gained no row.
        reportNoResearch: async (ctx, args, runtime) => {
            if (ctx.roleKind !== 'researcher') return wrongKindRefusal(ctx, 'reportNoResearch', 'researcher');

            const rationale = str(args.rationale).trim();

            if (!rationale)
                return {
                    ok: false,
                    refused: 'T-11',
                    message:
                        'reportNoResearch needs a rationale: say why this premise needs no fact outside itself, or write the knowledge (D-51)'
                };

            // The brief this pass answers, read from the record exactly as the real tool reads it
            // (`structureSeed` keeps at most one `accepted` row per Story, so the last one is the live one).
            const accepted = runtime.store.seedBriefs
                .list()
                .filter((row) => row.story_id === ctx.storyId && row.status === 'accepted');
            const brief = accepted[accepted.length - 1];

            const knowledge_rows = runtime.store.knowledge.list().filter((row) => row.story_id === ctx.storyId).length;

            return {
                ok: true,
                summary: `Research pass closed with nothing to record${brief ? ` (Seed Brief ${brief.id})` : ''}`,
                data: {
                    research: 'none',
                    seed_brief_id: brief?.id ?? null,
                    research_questions: brief?.research_questions ?? [],
                    knowledge_rows,
                    rationale
                }
            };
        },

        // -- D-17e: the seam the run layer injected ----------------------------------------------
        delegate: async (ctx, args) => {
            const service = ctx.services.delegate;

            if (service === undefined) {
                return {
                    ok: false,
                    refused: 'D-17e',
                    message: 'this session holds no delegate service — the run did not offer one (D-17e)'
                };
            }

            const answer = await service(str(args.role), str(args.task));

            // D-17e: the sub-context's final text is the parent run's only result.
            return answer.ok
                ? { ok: true, data: { summary: answer.summary ?? '' } }
                : { ok: false, refused: 'D-17e', message: answer.error ?? 'the delegated sub-context failed' };
        }
    };
}

// ---------------------------------------------------------------------------
// The runtime
// ---------------------------------------------------------------------------

/**
 * T3's pinned `ToolRuntime` (schemas / one context per session / one `execute`), implemented
 * against the REAL store so the run layer's tests exercise genuine journal, commit and CAS
 * behaviour rather than a memorised one.
 */
export class MockToolRuntime implements ToolRuntime {
    /** Every call that REACHED this runtime, in order. A D-38 proposal never appears here. */
    readonly calls: MockToolCall[] = [];

    private readonly handlers: Record<string, MockToolHandler>;

    constructor(
        readonly store: Store,
        readonly storyId: string,
        /** Per-test overrides: an existing name replaces a default, a new name adds a tool. */
        tools: Record<string, MockToolHandler> = {}
    ) {
        this.handlers = { ...defaultTools(), ...tools };
    }

    /** T-6a: the whole catalogue on every session, role-blind. */
    schemas(): ToolSchema[] {
        return this.toolNames().map((name) => ({
            type: 'function',
            function: {
                name,
                description: `mock ${name} — the W5 test double for the §8 catalogue`,
                parameters: { type: 'object', properties: {}, additionalProperties: false }
            }
        }));
    }

    toolNames(): string[] {
        return Object.keys(this.handlers).sort();
    }

    definitionOf(name: string): ToolSchema | undefined {
        return this.schemas().find((schema) => schema.function.name === name);
    }

    /** One session, one context (S-1); the Story is bound in, so no tool takes a storyId (T-3). */
    createContext(session: RunToolSession, hooks?: RunToolHooks): RunToolContext {
        const delegate = hooks?.delegate;

        return {
            storyId: session.storyId ?? this.storyId,
            runRef: session.runRef ?? '',
            templateRef: session.templateRef ?? '',
            roleName: session.roleName ?? '',
            roleKind: session.roleKind ?? 'reader',
            services: {
                // The run layer's hook may answer synchronously; T3's service contract is a promise.
                delegate:
                    delegate === undefined
                        ? undefined
                        : async (role, task) => {
                              const result = await delegate(role, task);

                              return { ok: result.ok === true, summary: result.summary, error: result.error };
                          }
            }
        } satisfies MockRunContext;
    }

    async execute(context: RunToolContext, name: string, args: Record<string, unknown>): Promise<ToolResult> {
        const ctx = context as MockRunContext;

        this.calls.push({ runRef: ctx.runRef, roleName: ctx.roleName, roleKind: ctx.roleKind, name, args });

        const handler = this.handlers[name];

        if (handler === undefined) {
            // T-11/T-6c: an unknown name is a visible refusal the model can correct, not a fault.
            return {
                ok: false,
                refused: 'T-6c',
                message: `no tool named ${name} is registered on this session (T-6c) — listTools names the catalogue`
            };
        }

        return handler(ctx, args, this);
    }
}

// ---------------------------------------------------------------------------
// §4 fixtures
//
// Each fills only what §4 marks required and takes overrides for the two or three fields a test
// actually varies, so a test cannot drift into inventing a field the spec does not have.
// ---------------------------------------------------------------------------

/** The Author-shaped attribution seed data carries (D-20a: `run_ref: null`, `author: true`). */
export const AUTHOR_ATTR: Attribution = { run_ref: null, author: true, why: 'seed for the run-layer tests' };

/** Drops the four bookkeeping fields a store-minted record carries, so a factory can feed `create`. */
export function strip<T extends StoredRecord>(record: T): RecordInit<T> {
    // Rest-destructure rather than a cast: `create` mints the four itself, and the store test's
    // fixtures use the same shape (`Omit<Story, 'id' | 'rev' | 'created_at' | 'updated_at'>`).
    const { id, rev, created_at, updated_at, ...rest } = record;

    return rest as RecordInit<T>;
}

/** §4.1 Story + §4.2 Summary (phase ①'s minimum). */
export function seedStory(
    store: Store,
    init: Partial<Omit<Story, 'id' | 'rev' | 'created_at' | 'updated_at'>> = {}
): Story {
    const story = store.stories.create(
        {
            title: init.title ?? 'Cold Mountain',
            phase: init.phase ?? 'chapters',
            idea:
                init.idea ??
                'A cartographer returns to the valley she mapped as a girl and finds it redrawn by a reservoir.',
            summary_locked: init.summary_locked ?? false,
            plotlines_locked: init.plotlines_locked ?? false,
            pending_kind: init.pending_kind ?? 'none',
            status: init.status ?? 'ready',
            trend: init.trend ?? 'unknown',
            auto_approve: init.auto_approve ?? ['critical', 'major'],
            author_stop: init.author_stop ?? false,
            digest_rev: init.digest_rev ?? 0,
            template_refs: init.template_refs ?? [],
            chapter_deps: init.chapter_deps ?? {}
        },
        AUTHOR_ATTR
    );

    store.summaries.create(
        {
            story_id: story.id,
            chapter_count: 3,
            premise: 'A return to a mapped valley that no longer matches the map.',
            promise: 'The map and the territory reconcile in the last chapter.',
            theme: 'Memory against measurement.',
            tone: 'Plain, cold, precise.',
            ending: 'She floods the valley on purpose.',
            world_rules: 'No magic; the reservoir is engineering.',
            locked: false
        },
        AUTHOR_ATTR
    );

    return story;
}

/** §4.11 Goal holding the built-in criteria (G-4: every crew is briefed against the same target). */
export function seedGoal(store: Store, storyId: string): Goal {
    return store.goals.create(strip(defaultGoal(storyId)), AUTHOR_ATTR);
}

/** §4.8 Digest (D-12a: one current record, derived by the engine — a run never writes it). */
export function seedDigest(store: Store, storyId: string, body: string, stale = false): Digest {
    return store.digests.create({ story_id: storyId, body, stale, current: true }, AUTHOR_ATTR);
}

/** §4.3 plotline — the contract a chapter must deliver (P4). */
export function seedPlotline(
    store: Store,
    storyId: string,
    init: Partial<Omit<Plotline, 'id' | 'rev' | 'created_at' | 'updated_at'>> = {}
): Plotline {
    return store.plotlines.create(
        {
            story_id: storyId,
            order: init.order ?? 1,
            heading: init.heading ?? 'The reservoir is where the map was',
            must_happen: init.must_happen ?? 'She sees the flooded church steeple.',
            must_change: init.must_change ?? 'She stops trusting her own map.',
            pov: init.pov ?? 'Maren',
            setups: init.setups ?? 'the 1911 survey map',
            payoffs: init.payoffs ?? 'the steeple bell',
            contract_locked: init.contract_locked ?? false,
            aligned: init.aligned ?? true,
            needs_recheck: init.needs_recheck ?? false
        },
        AUTHOR_ATTR
    );
}

/** §4.4 chapter with one Author-origin and one crew-origin section (D-7 addressing, P9). */
export function seedChapter(
    store: Store,
    storyId: string,
    init: Partial<Omit<Chapter, 'id' | 'rev' | 'created_at' | 'updated_at'>> = {}
): Chapter {
    // §4.4's `origin` union is `author | writer` (D-7, T-2): an Author span is propose-only for every
    // agent (P9), a writer span is the crew's to rewrite. Declared with its type once, so the
    // literal cannot widen to `string`.
    const sections: ChapterSection[] = [
        { id: 'sec_1', text: 'The ridge was where she had put the ridge.', origin: 'author' },
        { id: 'sec_2', text: 'Below it, water where the town had been.', origin: 'writer' }
    ];

    return store.chapters.create(
        {
            story_id: storyId,
            plotline_ref: init.plotline_ref,
            order: init.order ?? 1,
            title: init.title ?? 'The Return',
            summary: init.summary ?? 'Maren reaches the ridge and does not recognise her own map.',
            sections: init.sections ?? sections,
            state: init.state ?? 'drafting',
            current_revision: init.current_revision,
            author_locked: init.author_locked ?? false,
            round: init.round ?? 1
        },
        AUTHOR_ATTR
    );
}

/** §4.15 competing draft — what D-21 keeps out of every brief except a select/merge one. */
export function seedRevision(
    store: Store,
    storyId: string,
    unitRef: string,
    body: string,
    runRef: string,
    init: Partial<Omit<Revision, 'id' | 'rev' | 'created_at' | 'updated_at'>> = {}
): Revision {
    return store.revisions.create(
        {
            story_id: storyId,
            unit_kind: init.unit_kind ?? 'chapter',
            unit_ref: unitRef,
            body,
            run_ref: runRef,
            state: init.state ?? 'competing',
            verdict_refs: init.verdict_refs ?? []
        },
        AUTHOR_ATTR
    );
}

/** §4.12 template — the harness the run resolves its role prompt and permission row from (D-17a). */
export function seedTemplate(
    store: Store,
    init: Partial<Omit<Template, 'id' | 'rev' | 'created_at' | 'updated_at'>> & { name: string; roles: TemplateRole[] }
): Template {
    return store.templates.create(
        {
            name: init.name,
            title: init.title ?? init.name,
            description: init.description,
            roles: init.roles,
            serves_phase: init.serves_phase ?? ['chapters'],
            done_definition: init.done_definition ?? 'the unit delivers its contract and the report is filed',
            selection_rules: init.selection_rules,
            attempts: init.attempts ?? 1,
            delegation: init.delegation,
            escalation_rule: init.escalation_rule,
            next_phase: init.next_phase,
            max_concurrent: init.max_concurrent,
            builtin: init.builtin ?? false,
            editable: init.editable ?? true
        },
        AUTHOR_ATTR
    );
}

/** §4.17 Idea — D-29's selected-and-unabsorbed case is a brief section, so it is a fixture. */
export function seedIdea(
    store: Store,
    storyId: string,
    init: Partial<Omit<Idea, 'id' | 'rev' | 'created_at' | 'updated_at'>> = {}
): Idea {
    return store.ideas.create(
        {
            story_id: storyId,
            phase: init.phase ?? 'chapters',
            unit_ref: init.unit_ref,
            body: init.body ?? 'the steeple bell should ring under the water',
            kind: init.kind ?? 'direction',
            author: init.author ?? 'critic-continuity',
            sources: init.sources ?? [],
            fingerprint: init.fingerprint ?? 'steeple-bell',
            seen_count: init.seen_count ?? 1,
            state: init.state ?? 'selected',
            verification: init.verification,
            selection_note: init.selection_note,
            absorbed_into: init.absorbed_into
        },
        AUTHOR_ATTR
    );
}

/** §4.10 finding to verify (D-33) — what a `verify_findings` job names. */
export function seedFinding(
    store: Store,
    storyId: string,
    init: Partial<Omit<Finding, 'id' | 'rev' | 'created_at' | 'updated_at'>> = {}
): Finding {
    return store.findings.create(
        {
            story_id: storyId,
            target_ref: init.target_ref ?? 'chapter_1',
            criterion_ref: init.criterion_ref ?? 'C-4',
            title: init.title ?? 'the 1911 map is never paid off',
            detail: init.detail,
            evidence: init.evidence ?? 'chapter_1 sec_1 mentions the map; nothing answers it',
            cost: init.cost ?? 'major',
            // T5/D-33b: the claim type, omitted unless a fixture asks for one — so a seeded row stays the
            // kind-less legacy shape by default, which is exactly what the brief renderer must tolerate.
            ...(init.kind === undefined ? {} : { kind: init.kind }),
            fingerprint: init.fingerprint ?? 'C-4|chapter_1',
            state: init.state ?? 'unconfirmed',
            seen_count: init.seen_count ?? 1,
            related_refs: init.related_refs,
            ...(init.critic_confirmed === undefined ? {} : { critic_confirmed: init.critic_confirmed }),
            ...(init.critic_confirmed_by === undefined ? {} : { critic_confirmed_by: init.critic_confirmed_by })
        },
        AUTHOR_ATTR
    );
}

/** §4.7 task the job must clear (S-2's "the open tasks that job must clear"). */
export function seedTask(
    store: Store,
    storyId: string,
    init: Partial<Omit<Task, 'id' | 'rev' | 'created_at' | 'updated_at'>> = {}
): Task {
    return store.tasks.create(
        {
            story_id: storyId,
            kind: init.kind ?? 'fix',
            title: init.title ?? 'pay off the 1911 map in chapter 3',
            detail: init.detail,
            owner_role: init.owner_role ?? 'writer-prose',
            state: init.state ?? 'open',
            priority: init.priority ?? 1,
            criterion_ref: init.criterion_ref ?? 'C-4',
            finding_ref: init.finding_ref,
            attempts: init.attempts ?? 0
        },
        AUTHOR_ATTR
    );
}
