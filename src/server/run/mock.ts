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
import {
    type Chapter,
    type ChapterSection,
    type Digest,
    type Finding,
    type Goal,
    type Idea,
    type Plotline,
    type RecordInit,
    type Revision,
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
                revision.story_id === storyId && revision.unit_ref === unitRef && revision.state === 'competing'
        )
        .sort((left, right) => left.id.localeCompare(right.id));
}

// ---------------------------------------------------------------------------
// The tool set (T3's names, T3's result shapes)
// ---------------------------------------------------------------------------

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

        // -- §8.4 plumbing: what the checkers live on -------------------------------------------
        submitVerdict: async (ctx, args, runtime) => {
            const criteria = Array.isArray(args.criteria) ? (args.criteria as VerdictCriterion[]) : [];
            const hardIds = new Set(
                BUILT_IN_CRITERIA.filter((criterion) => criterion.hard).map((criterion) => criterion.id)
            );
            const created = await inCommit(runtime.store, 'submit_verdict', () =>
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
                        hard_pass: criteria
                            .filter((entry) => hardIds.has(entry.criterion))
                            .every((entry) => entry.result),
                        soft_count: criteria.filter((entry) => entry.result).length,
                        recommendation: (str(args.recommendation) || 'advance') as Verdict['recommendation']
                    },
                    attrFor(ctx, args)
                )
            );

            return { ok: true, id: created.id, rev: created.rev };
        },
        raiseFinding: async (ctx, args, runtime) => {
            const criterionRef = str(args.criterion_ref);
            const targetRef = str(args.target_ref);
            const fingerprint = `${criterionRef}|${targetRef}`;

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
                    runtime.store.findings.update(
                        existing.id,
                        { seen_count: existing.seen_count + 1 },
                        attrFor(ctx, args)
                    )
                );

                return { ok: true, repeat: true, finding_id: bumped.id, rev: bumped.rev };
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
                        fingerprint,
                        state: 'unconfirmed',
                        seen_count: 1
                    },
                    attrFor(ctx, args)
                )
            );

            return { ok: true, finding_id: created.id, rev: created.rev };
        },
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
                        if (sibling.state !== 'competing') continue;

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

            try {
                const updated = runtime.store.findings.update(
                    findingId,
                    {
                        state: str(args.decision) === 'discard' ? 'discarded' : 'approved',
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
            // D-26/D-28: a Reader proposes, the row starts `proposed`, and nothing else happens —
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
            roleKind: session.roleKind ?? 'checker',
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
            author: init.author ?? 'reader-continuity',
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
            fingerprint: init.fingerprint ?? 'C-4|chapter_1',
            state: init.state ?? 'unconfirmed',
            seen_count: init.seen_count ?? 1
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
            attempts: init.attempts ?? 0
        },
        AUTHOR_ATTR
    );
}
