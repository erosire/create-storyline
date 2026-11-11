/**
 * §8.3 — the checker surface: the report tools. Every one of these WRITES A RECORD and changes
 * no story state (D-1): a verdict is a report, a finding is a claim, `markChapterDone` is a
 * recommendation, and only the loop engine or the Author moves a chapter (L-10, P6).
 *
 * §7 line 619 grants `write` on `verdicts`/`findings` to every dispatched kind, so these tools
 * are not checker-only: a Writer may file the defect it sees. What IS checker-only in practice is
 * who is asked to, which the template brief decides (D-17a) — not the permission row.
 *
 * T-11 lives here in two places the spec calls out by name: `cost` is a required enum
 * (`raiseFinding`), and a failing criterion line with no evidence is invalid (`submitVerdict`,
 * D-15). Both are refused with the accepted value set, not repaired.
 */
import type { Finding, Task, Verdict, VerdictCriterion } from '../../shared/types';
import { criterionById } from '../../shared/criteria';
// U-3a: only the ID crosses this boundary — `digest_gap` is the §4.6 open-thread ref D-13 gives a crew
// for reporting a bad Digest, and the builder is the module that owns the name (src/server/digest).
import { DIGEST_GAP_CRITERION } from '../digest/digest';
import {
    chapterRows,
    duplicateFinding,
    fingerprintFinding,
    goalFor,
    mustResolveRef,
    openTask,
    ownerFor,
    resolvedChapter,
    scoreLine,
    stableFingerprint
} from './artifacts';
import { COST_ENUM, EXPECTS_ARG, RECOMMENDATION_ENUM, arr, bool, enumOf, num, obj, str, whyArg } from './schema';
import {
    buildAttribution,
    clip,
    commitAs,
    idOf,
    ok,
    repeatResult,
    revOf,
    summarize,
    ToolRefusal,
    whyOf
} from './utilities';
import type { ToolDefinition, ToolExecutionContext, ToolResult } from './types';

/**
 * The artifact kinds a verdict or a finding can be about (D-4's chain, plus the Story itself).
 * `stories` is load-bearing, not decoration: §5.2 scopes C-4 (the cross-plotline consistency check)
 * and every `whole`-level criterion to the Story row (criteria/engine.ts:scopeTargets), and the loop
 * treats that row as the set-level unit's verdict target (loop/work.ts:judgedBefore). Without it the
 * crew can never pass the criteria that are scoped there, so phase ② and the whole-Story pass in
 * phase ③ could not finish.
 */
const TARGET_KINDS = ['stories', 'summaries', 'plotlines', 'chapters'] as const;

/**
 * §6.2a / D-21 / U-13: a VERDICT may also name one competing draft — a `revisions` row of this Story.
 * §6.2a's pipeline is "Checker runs ×M (fresh, read-only) → verdicts per revision", and the loop
 * dispatches one checker per draft (`wi_check_<unit>_<gen>_<revision_id>`, see loop/work.ts); with
 * only artifact targets, every one of those verdicts lands on the unit and U-13's side-by-side view
 * has no per-draft verdicts to show. `resolveRef` already accepts a `revisions` ref
 * (tools/artifacts.ts:RESOLVABLE), so this is the only gate that had to widen.
 *
 * `raiseFinding` deliberately keeps the narrower {@link TARGET_KINDS}: a defect is a claim about an
 * artifact, not about one draft of it — and D-22 deletes the losing drafts, which would leave the
 * finding pointing at a row that no longer exists.
 */
const VERDICT_TARGET_KINDS = [...TARGET_KINDS, 'revisions'] as const;

/** §4.9 → §4.4 vocabulary: the collection a target resolved to becomes the verdict's `target_kind`. */
function targetKindOf(collection: string): string {
    if (collection === 'summaries') return 'summary';
    if (collection === 'plotlines') return 'plotline';
    if (collection === 'chapters') return 'chapter';
    // §4.15's draft row, judged as its own target (§6.2a's per-revision verdicts, D-21).
    if (collection === 'revisions') return 'revision';
    return collection;
}

/**
 * Reads one `criteria_passed[]` item into the stored shape, refusing what T-11/D-15 forbids:
 * an unknown criterion id, a non-boolean result, or a FAILING line with no evidence.
 */
function parseCriterionLine(
    ctx: ToolExecutionContext,
    raw: unknown,
    index: number,
    known: Set<string>
): VerdictCriterion {
    const label = `criteria_passed[${index}]`;
    if (typeof raw !== 'object' || raw === null)
        throw new ToolRefusal('T-11', `${label} must be an object with criterion, result and evidence.`, {
            field: label,
            expected: '{criterion, result, evidence, finding_ref?}',
            fix: 'one line per criterion you actually checked'
        });
    const item = raw as Record<string, unknown>;
    const criterion = typeof item.criterion === 'string' ? item.criterion.trim() : '';
    if (!criterion)
        throw new ToolRefusal(
            'T-11',
            `${label}.criterion is required — a verdict line must name the criterion it judged.`,
            {
                field: `${label}.criterion`,
                fix: 'use one of the ids readGoals returns'
            }
        );
    // G-4: a verdict line about a criterion that is not on this Story's list cannot be counted,
    // so it is refused rather than silently dropped from the pass/fail arithmetic.
    if (!known.has(criterion) && !criterionById(criterion))
        throw new ToolRefusal(
            'T-11',
            `no criterion "${criterion}" is on this Story's list, so its verdict line cannot be counted.`,
            {
                field: `${label}.criterion`,
                expected: [...known],
                fix: 'readGoals lists the ids, or the Author adds the criterion to the Goal (G-1)'
            }
        );
    if (typeof item.result !== 'boolean')
        throw new ToolRefusal('T-11', `${label}.result must be true or false — P6 forbids a score or a grade.`, {
            field: `${label}.result`,
            received: item.result,
            fix: 'send a boolean'
        });

    const evidence = typeof item.evidence === 'string' ? item.evidence.trim() : '';
    // D-15: "a FAILING line with no evidence is invalid" — the refusal quotes the rule.
    if (item.result === false && !evidence)
        throw new ToolRefusal(
            'D-15',
            `${label} fails ${criterion} with no evidence, and a verdict with no citable evidence is invalid.`,
            { field: `${label}.evidence`, rule: 'D-15', fix: 'cite the lines or the ledger row that show the failure' }
        );

    const findingRef = typeof item.finding_ref === 'string' ? item.finding_ref.trim() : '';
    return { criterion, result: item.result, evidence, ...(findingRef ? { finding_ref: findingRef } : {}) };
}

/**
 * The §5.1 arithmetic, rendered not scored (P6): every HARD criterion must have a passing line,
 * and the soft passes are counted for the Goal's threshold.
 */
function verdictTally(
    lines: VerdictCriterion[],
    criteria: { id: string; hard: boolean }[]
): { hard_pass: boolean; soft_count: number; missing_hard: string[] } {
    const byCriterion = new Map(lines.map((line) => [line.criterion, line]));
    const missingHard: string[] = [];
    let softCount = 0;
    let hardPass = true;
    for (const criterion of criteria) {
        const line = byCriterion.get(criterion.id);
        if (criterion.hard) {
            if (!line || !line.result) {
                hardPass = false;
                if (!line) missingHard.push(criterion.id);
            }
        } else if (line?.result) softCount += 1;
    }
    return { hard_pass: hardPass, soft_count: softCount, missing_hard: missingHard };
}

// ── 1. submitVerdict (D-15/D-28/P6) ─────────────────────────────────────────

/**
 * §8.3 `submitVerdict`: the run's pass/fail report for one artifact. It writes the verdict and
 * nothing else — no chapter state, no score, no phase move (D-1, L-10). The recommendation is the
 * reviewer's opinion about what the loop should do next (D-28).
 *
 * §6.2a's "verdicts per revision" is served by the same call with a `revisions` target: the loop's
 * per-draft checker jobs (`wi_check_<unit>_<gen>_<revision_id>`) name the draft in the job line, and
 * filing against it is what gives U-13's side-by-side view a verdict per draft. The criteria engine
 * aggregates per TARGET (criteria/engine.ts:aggregateJudgeWithTargets), so a draft verdict can never
 * displace the artifact verdict the Goal is measured on.
 *
 * §8 lists no `why` on this row, but the store refuses an unattributed write (P11), so the
 * reason is synthesised from the call itself (see `whyOptional` in `types.ts`).
 */
const submitVerdict: ToolDefinition = {
    name: 'submitVerdict',
    description:
        'Report the verdict for one artifact or one competing revision: one line per criterion with pass/fail and citable evidence, plus a recommendation. It changes no story state — the loop advances a chapter on it (P6, L-10). A failing line with no evidence is rejected (D-15).',
    inputSchema: {
        type: 'object',
        properties: {
            target_ref: str(
                'The thing judged: a chapter, plotline or summary (its id), a competing revision (its id, when the job names a draft — §6.2a files one verdict per revision, D-21), or the Story itself when the report is about the set or the whole book (§5.2 scopes C-4 and the whole level there).'
            ),
            criteria_passed: arr(
                'One line per criterion judged (every hard criterion must appear).',
                obj(
                    'A single pass/fail line.',
                    {
                        criterion: str('The criterion id, as readGoals prints it.'),
                        result: bool('True = it passes.'),
                        evidence: str('The citable lines, section, or ledger row (required on a failure, D-15).'),
                        finding_ref: str('A finding raised for this failure.')
                    },
                    ['criterion', 'result']
                )
            ),
            recommendation: enumOf(
                ['advance', 'fix', 'stuck'],
                'advance = good enough; fix = work remains; stuck = the Author should be asked.'
            ),
            why: whyArg('Optional: what drove the recommendation.')
        },
        required: ['target_ref', 'criteria_passed', 'recommendation']
    },
    writes: 'verdicts',
    level: 'write',
    mutating: true,
    whyOptional: true,
    primaryArg: 'target_ref',
    requires: ['target_ref', 'criteria_passed', 'recommendation'],
    async execute(ctx): Promise<ToolResult> {
        // §6.2a/D-21: a checker pointed at one draft files its verdict against THAT draft, so the
        // target set here is the wider {@link VERDICT_TARGET_KINDS} (`revisions` included); a finding
        // stays aimed at an artifact (see the note on that constant).
        const target = await mustResolveRef(ctx, ctx.args.target_ref, 'target_ref', [...VERDICT_TARGET_KINDS]);
        const rawLines = Array.isArray(ctx.args.criteria_passed) ? ctx.args.criteria_passed : [];
        if (!rawLines.length)
            throw new ToolRefusal(
                'T-11',
                'criteria_passed needs at least one line — a verdict that checked nothing is a no-op turn (S-4).',
                {
                    field: 'criteria_passed',
                    fix: 'one line per hard criterion, from readGoals'
                }
            );

        const goal = goalFor(ctx.store, ctx.storyId, ctx.story.phase);
        const criteria = goal.criteria.length ? goal.criteria : [{ id: 'C-0', hard: true }];
        const known = new Set(criteria.map((criterion) => criterion.id));
        const lines = rawLines.map((raw, index) => parseCriterionLine(ctx, raw, index, known));

        const recommendation = String(ctx.args.recommendation) as Verdict['recommendation'];
        const tally = verdictTally(lines, criteria);
        // The round is the target's own pass counter, so a verdict always says which attempt it
        // judges (§6.7's loop detection reads that, not the wall clock).
        const chapter = target.collection === 'chapters' ? resolvedChapter(target) : undefined;
        const priorRounds = ctx.store.verdicts
            .list()
            .filter((row) => row.story_id === ctx.storyId && row.target_ref === target.id)
            .map((row) => row.round);
        const round = chapter ? Math.max(chapter.round, ...priorRounds, 1) : Math.max(1, ...priorRounds, 1);

        // T-5 still holds even though §8 omits `why` here: the reason names the target and the
        // outcome, which is what an auditor needs from a verdict row.
        const why =
            whyOf(ctx) ||
            `Verdict on ${target.id}: ${tally.hard_pass ? 'hard pass' : 'failing'} · recommend ${recommendation}`;

        const written = (await commitAs(
            ctx,
            'submitVerdict',
            async () => {
                const verdict = ctx.store.verdicts.create(
                    {
                        story_id: ctx.storyId,
                        target_ref: target.id,
                        target_kind: targetKindOf(target.collection),
                        run_ref: ctx.runId,
                        template_ref: ctx.templateRef,
                        round,
                        criteria_passed: lines,
                        hard_pass: tally.hard_pass,
                        soft_count: tally.soft_count,
                        recommendation
                    },
                    buildAttribution(ctx, why)
                ) as Verdict;

                // §4.15: a `revisions` row carries `verdict_refs` — the judgement filed AGAINST that one
                // draft. §6.2a files "verdicts per revision", and the Editor's brief reads the refs off
                // the draft row (run/brief.ts:renderCompetingRevisions), so the ref is appended in the
                // SAME commit as the verdict: a verdict that exists without its ref on the draft is a row
                // the pane can only find by re-scanning §4.9 (the gap this closes, D-21's side-by-side).
                // Purely additive — the verdict row itself is unchanged, and an artifact target writes
                // nothing extra.
                if (target.collection === 'revisions') {
                    const draft = ctx.store.revisions.get(target.id);

                    if (draft !== undefined) {
                        const refs = [...(draft.verdict_refs ?? []), verdict.id];

                        ctx.store.revisions.update(
                            draft.id,
                            { verdict_refs: refs },
                            buildAttribution(ctx, `Verdict ${verdict.id} judges ${draft.id} (§4.15, D-21)`)
                        );
                    }
                }

                return verdict;
            },
            []
        )) as Verdict;

        const failing = lines.filter((line) => !line.result).map((line) => line.criterion);
        return ok(
            {
                id: written.id,
                target_ref: written.target_ref,
                target_kind: written.target_kind,
                round: written.round,
                hard_pass: written.hard_pass,
                soft_count: written.soft_count,
                threshold_soft: goal.threshold_soft,
                // P6: rendered as n/m, never averaged into a number that ranks prose.
                score: scoreLine(lines.filter((line) => line.result).length, lines.length),
                failing_criteria: failing,
                // D-1: the explicit statement that nothing else moved, so a fresh context cannot
                // infer that a verdict signs anything off.
                state_changed: false,
                ...(tally.missing_hard.length ? { missing_hard_criteria: tally.missing_hard } : {}),
                recommendation: written.recommendation,
                current_rev: written.rev
            },
            written.rev,
            `Verdict ${written.id} on ${target.id}: ${tally.hard_pass ? 'hard pass' : `failing ${failing.join(', ') || 'unjudged'}`} · ${recommendation}`,
            {
                notes: [
                    tally.hard_pass
                        ? 'Recommendation only: the loop advances the chapter, and the Author signs it off (L-10).'
                        : 'A failing hard criterion means the loop queues a fix; nothing here is repaired by this call.',
                    ...(tally.missing_hard.length
                        ? [`No line was sent for hard criteria: ${tally.missing_hard.join(', ')} (D-15 requires one).`]
                        : [])
                ]
            }
        );
    }
};

// ── 2. raiseFinding (D-16/D-33/D-34/L-11a) ──────────────────────────────────

/**
 * Normalises `related_refs` (L-11a): trims, drops blanks, dedupes, and keeps first-seen order.
 *
 * The refs are stored verbatim rather than resolved. A defect that reaches chapter 7 is often
 * raised before the reporter has read chapter 7, and refusing the report over an unresolvable ref
 * would cost the propagation (L-11a) to protect a field nobody writes to; a NON-STRING item is
 * still refused, by the schema, before this runs (T-11). The cap is a guard against a model
 * dumping the whole outline into one array (T-7's bounded-payload rule, applied on the way in).
 */
function relatedRefsOf(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const seen: string[] = [];
    for (const entry of value) {
        if (typeof entry !== 'string') continue;
        const ref = entry.trim();
        if (!ref || seen.includes(ref)) continue;
        seen.push(ref);
        if (seen.length >= RELATED_REF_LIMIT) break;
    }
    return seen;
}

/** The most `related_refs` one finding may carry (L-11a's propagation is a fan-out, not an index). */
const RELATED_REF_LIMIT = 12;

/**
 * L-11a: the refs to keep on a REPEAT sighting (D-16). The open row's refs win, in order, and a
 * new sighting only ever adds — losing `related_refs` on a dedupe is how a cross-chapter defect
 * silently stops being cross-chapter. Returns undefined when nothing new arrived, so an identical
 * repeat still journals one `seen_count` bump and nothing else.
 */
function mergedRelatedRefs(existing: string[] | undefined, incoming: string[]): string[] | undefined {
    if (incoming.length === 0) return undefined;
    const merged = relatedRefsOf([...(existing ?? []), ...incoming]);
    if (existing && merged.length === existing.length && merged.every((ref, index) => ref === existing[index]))
        return undefined;
    return merged;
}

/**
 * §8.3 `raiseFinding`: a named defect with evidence, on a criterion. D-33: a checker's or a
 * Reader's finding starts `unconfirmed` — it is a suspicion until an Editor confirms it. D-16:
 * the same claim against the same criterion and target bumps `seen_count` instead of opening a
 * second row, which is what makes "no progress" detectable in an amnesiac system.
 *
 * `related_refs` is the one argument beyond §8's row (L-11a, authorized for W2): the other units
 * the defect touches, stored on the record so one report propagates instead of being re-raised per
 * chapter. It is optional, so every §8 call still works unchanged.
 */
const raiseFinding: ToolDefinition = {
    name: 'raiseFinding',
    description:
        'File a defect: the artifact, the criterion it fails, a title, the evidence, and a cost. Name related_refs — the other records the same defect touches — and it propagates across chapters instead of being re-raised unit by unit (L-11a). A checker or reader finding starts unconfirmed until an Editor confirms it (D-33); the same claim again bumps seen_count instead of opening a row (D-16).',
    inputSchema: {
        type: 'object',
        properties: {
            target_ref: str('The artifact that fails (a chapter, plotline or summary id).'),
            criterion_ref: str('The criterion id it fails (readGoals lists them).'),
            title: str('The defect in one line, specific enough to act on (P4).'),
            detail: str('What is wrong and where — the lines or rows involved.'),
            evidence: str('The citable proof (D-15): a quote, a line range, a ledger row.'),
            cost: COST_ENUM,
            // L-11a: cross-chapter propagation. Optional, so §8's call shape is unchanged.
            related_refs: arr(
                'Other records this defect touches (chapter, plotline or summary ids), so the finding propagates across chapters (L-11a).',
                str('One related record ref.')
            ),
            why: whyArg('Optional: why this is worth the Author attention.')
        },
        required: ['target_ref', 'criterion_ref', 'title', 'evidence', 'cost']
    },
    writes: 'findings',
    level: 'write',
    mutating: true,
    whyOptional: true,
    primaryArg: 'target_ref',
    requires: ['target_ref', 'criterion_ref', 'title', 'evidence', 'cost'],
    async execute(ctx): Promise<ToolResult> {
        const target = await mustResolveRef(ctx, ctx.args.target_ref, 'target_ref', [...TARGET_KINDS]);
        const criterionRef = String(ctx.args.criterion_ref ?? '').trim();
        // The criterion need not be on this Story's Goal (P15 keeps the set open), but a typo is
        // the far more common case, so an unknown id is refused with the list that is in force.
        //
        // U-3a (D-13): `digest_gap` is the one ref §4.6's open-thread list names that no §4.11 Goal
        // carries, because it is not a quality criterion a crew judges against — it is a crew
        // reporting that the derived Digest itself failed it (D-12a). §8's `createTask` takes no kind,
        // so the finding is the only filing route D-13 leaves, and `DigestBuilder.isExpanded` reads
        // exactly this ref back (src/server/digest/digest.ts). It is accepted by name — not invented
        // as a wildcard — so every other unknown ref still pays the T-11 refusal above.
        const goal = goalFor(ctx.store, ctx.storyId, ctx.story.phase);
        const known = new Set(goal.criteria.map((criterion) => criterion.id));
        if (criterionRef !== DIGEST_GAP_CRITERION && !known.has(criterionRef) && !criterionById(criterionRef))
            throw new ToolRefusal('T-11', `no criterion "${criterionRef}" is on this Story's list.`, {
                field: 'criterion_ref',
                expected: [...known],
                fix: 'name a criterion from readGoals (G-4)'
            });

        const title = summarize(String(ctx.args.title ?? ''), 200);
        const evidence = String(ctx.args.evidence ?? '').trim();
        const detail = typeof ctx.args.detail === 'string' ? ctx.args.detail : '';
        const cost = String(ctx.args.cost) as Finding['cost'];
        // L-11a: normalised before the dedupe lookup, so a repeat that only adds refs is still
        // recognised as the same finding (the fingerprint never looks at them).
        const relatedRefs = relatedRefsOf(ctx.args.related_refs);
        const fingerprint = fingerprintFinding(target.id, criterionRef, title);
        const duplicate = duplicateFinding(ctx.store, ctx.storyId, fingerprint);
        const why = whyOf(ctx) || `Finding on ${target.id} for ${criterionRef}: ${title}`;

        // D-16: a repeat sighting counts itself. The bump is a write, so it goes through a commit
        // with the same attribution discipline as a new row (P11).
        if (duplicate) {
            // L-11a: the bump also keeps any unit the earlier sighting did not name, so propagation
            // survives dedupe instead of being paid for with a second row.
            const mergedRefs = mergedRelatedRefs(duplicate.related_refs, relatedRefs);
            const bumped = (await commitAs(
                ctx,
                'raiseFinding',
                () =>
                    ctx.store.findings.update(
                        duplicate.id,
                        {
                            seen_count: duplicate.seen_count + 1,
                            ...(mergedRefs ? { related_refs: mergedRefs } : {})
                        },
                        buildAttribution(ctx, `${why} (already filed)`)
                    ),
                []
            )) as Finding;
            return repeatResult(
                `Finding already open as ${bumped.id} (seen ${bumped.seen_count} times)`,
                {
                    finding_id: bumped.id,
                    id: bumped.id,
                    seen_count: bumped.seen_count,
                    state: bumped.state,
                    cost: bumped.cost,
                    criterion_ref: bumped.criterion_ref,
                    target_ref: bumped.target_ref,
                    // L-11a: what the open row now says it touches, so the reporter knows the
                    // propagation it asked for is on the record (an empty array means none).
                    related_refs: bumped.related_refs ?? []
                },
                { finding_id: bumped.id }
            );
        }

        // D-33: only an Editor's own finding starts `confirmed` — the Editor is the one who
        // confirms, so confirming its own report is not a rubber stamp of someone else's claim.
        const editorIssued = ctx.role === 'editor';
        const written = (await commitAs(
            ctx,
            'raiseFinding',
            () =>
                ctx.store.findings.create(
                    {
                        story_id: ctx.storyId,
                        target_ref: target.id,
                        criterion_ref: criterionRef,
                        title,
                        detail,
                        evidence,
                        cost,
                        fingerprint,
                        state: editorIssued ? 'confirmed' : 'unconfirmed',
                        confirmed_by: editorIssued ? (ctx.runId ?? null) : null,
                        approved_by: null,
                        seen_count: 1,
                        // L-11a: omitted rather than stored empty, so a record that names nothing
                        // looks exactly like a record raised before the field existed.
                        ...(relatedRefs.length ? { related_refs: relatedRefs } : {})
                    },
                    buildAttribution(ctx, why)
                ),
            []
        )) as Finding;

        return ok(
            {
                id: written.id,
                finding_id: written.id,
                target_ref: written.target_ref,
                criterion_ref: written.criterion_ref,
                title: written.title,
                cost: written.cost,
                state: written.state,
                fingerprint: written.fingerprint,
                seen_count: written.seen_count,
                // L-11a: echoed so the run can see what it propagated, and so a reader of the
                // transcript does not have to re-read the record to learn the fan-out.
                related_refs: written.related_refs ?? [],
                // D-34: the cost the Author's dial auto-approves starts work without a gate.
                auto_approved_cost: ctx.story.auto_approve.includes(written.cost),
                current_rev: written.rev
            },
            written.rev,
            `Finding ${written.id} on ${target.id} (${criterionRef}, ${cost}) — ${written.state}`,
            {
                finding_id: written.id,
                notes: editorIssued
                    ? undefined
                    : [
                          'Unconfirmed until an Editor confirms, disputes or rewrites it (D-33). Nothing is repaired yet (D-34).'
                      ]
            }
        );
    }
};

// ── 3. createTask (D-11/P4/P12) ─────────────────────────────────────────────

/**
 * §8.3 `createTask`: the fix a checker wants, handed to the queue rather than to an agent
 * (D-17c's alternative). Everything the next run needs goes in the text, because it starts with
 * nothing (P4). `kind` is not an argument: §8 fixes this tool as the fix-request path, and P15
 * keeps `Task.kind` free text so a new kind of work needs no schema change — the other kinds
 * (`digest_gap`, `capability_gap`, `escalation`, `signoff`) are filed by the tools that own them.
 */
const createTask: ToolDefinition = {
    name: 'createTask',
    description:
        'Queue work for the next run instead of doing it yourself: title, detail, who should own it, the criterion it closes, the finding it fixes, and a priority. Everything the next run needs goes in the text — it starts with nothing (P4, D-11).',
    inputSchema: {
        type: 'object',
        properties: {
            title: str('The work in one line.'),
            detail: str('What to do, what to read first, and what done looks like (P4).'),
            owner_role: enumOf(
                ['writer', 'editor', 'reader', 'checker', 'author'],
                'The kind that should do the work.'
            ),
            criterion_ref: str('The criterion this closes, when it is a criterion queue entry (P12).'),
            finding_ref: str('The finding this entry was raised from.'),
            priority: num('Higher is picked up first (the sweep orders by it).'),
            done: bool('True opens the entry already claimed by you, so the sweep does not hand it to someone else.'),
            why: whyArg('Why this work needs doing at all (T-5).')
        },
        // §8.3 lists `priority` with no `?` and §4.7 stores it: an untriaged queue entry is the
        // same mistake as an untriaged finding (T-11), so the caller picks the number instead of
        // letting everything land at the sweep's default.
        required: ['title', 'detail', 'owner_role', 'priority', 'why']
    },
    writes: 'tasks',
    level: 'write',
    mutating: true,
    expectsArg: false,
    primaryArg: 'title',
    requires: ['title', 'detail', 'owner_role', 'why'],
    async execute(ctx): Promise<ToolResult> {
        const title = summarize(String(ctx.args.title ?? ''), 200);
        const why = whyOf(ctx);
        const criterionRef = typeof ctx.args.criterion_ref === 'string' ? ctx.args.criterion_ref.trim() : '';
        if (criterionRef) {
            const goal = goalFor(ctx.store, ctx.storyId, ctx.story.phase);
            const known = new Set(goal.criteria.map((criterion) => criterion.id));
            if (!known.has(criterionRef) && !criterionById(criterionRef))
                throw new ToolRefusal('T-11', `no criterion "${criterionRef}" is on this Story's list.`, {
                    field: 'criterion_ref',
                    expected: [...known],
                    fix: 'name a criterion from readGoals, or omit criterion_ref'
                });
        }
        // A finding_ref must be a real finding, or P12's "the queue entry closes the finding"
        // silently becomes a dangling reference the dashboard cannot follow.
        const finding =
            ctx.args.finding_ref === undefined
                ? undefined
                : await mustResolveRef(ctx, ctx.args.finding_ref, 'finding_ref', ['findings']);

        const owner = ownerFor(typeof ctx.args.owner_role === 'string' ? ctx.args.owner_role : '', 'writer');
        const filed = await commitAs(
            ctx,
            'createTask',
            () =>
                openTask(
                    ctx.store,
                    ctx.storyId,
                    {
                        kind: 'fix',
                        title,
                        detail: String(ctx.args.detail ?? ''),
                        owner_role: owner,
                        criterion_ref: criterionRef || undefined,
                        finding_ref: finding?.id,
                        priority: Number.isFinite(Number(ctx.args.priority))
                            ? Math.trunc(Number(ctx.args.priority))
                            : 10
                    },
                    buildAttribution(ctx, why)
                ),
            []
        );

        const task = filed.task;
        // The claim path exists so a checker that intends to do the work itself does not have the
        // sweep hand the same entry to another run.
        if (filed.reused)
            return repeatResult(
                `Task already queued as ${task.id}`,
                {
                    task_id: task.id,
                    id: task.id,
                    state: task.state,
                    owner_role: task.owner_role ?? '',
                    priority: task.priority
                },
                { task_id: task.id }
            );

        if (ctx.args.done === true && task.state === 'open') {
            await commitAs(
                ctx,
                'createTask',
                () =>
                    ctx.store.tasks.update(
                        task.id,
                        { state: 'claimed', owner_role: ctx.roleName || ctx.role, attempts: task.attempts + 1 },
                        buildAttribution(ctx, why)
                    ),
                []
            );
        }

        return ok(
            {
                id: task.id,
                task_id: task.id,
                kind: task.kind,
                title: task.title,
                owner_role: task.owner_role ?? '',
                state: ctx.args.done === true ? 'claimed' : task.state,
                priority: task.priority,
                criterion_ref: task.criterion_ref ?? '',
                finding_ref: task.finding_ref ?? ''
            },
            revOf(task),
            `Task ${task.id} queued for ${task.owner_role ?? 'the queue'} (${title})`,
            {
                task_id: task.id,
                notes: [
                    'The queue holds the plan, not the transcript — the sweep dispatches it when the role is free (D-11).'
                ]
            }
        );
    }
};

// ── 4. editTask (D-11/L-15) ─────────────────────────────────────────────────

/**
 * §8.3 `editTask`: `task_id, state?, detail?, expects, why`. The queue is agent-writable (D-11),
 * so `state` is one of the §4.7 states — unlike a chapter's `state`, which is engine-owned (D-1).
 * Claiming bumps `attempts`, because attempts are the thing that makes "no progress" visible
 * (L-15) and a fresh context that re-claims a task is exactly that signal.
 */
const editTask: ToolDefinition = {
    name: 'editTask',
    description:
        'Move a queue entry: claimed, blocked, done, wontfix — and write the note the next run will read. The queue is agent-writable; a blocked entry must say why (D-11).',
    inputSchema: {
        type: 'object',
        properties: {
            task_id: str('The queue entry (its id).'),
            state: enumOf(['open', 'claimed', 'blocked', 'done', 'wontfix'], 'The new queue state.'),
            detail: str('The note for whoever picks this up next (P4).'),
            owner_role: enumOf(['writer', 'editor', 'reader', 'checker', 'author'], 'Who does the work now.'),
            priority: num('Higher is picked up first.'),
            expects: EXPECTS_ARG,
            why: whyArg('Why the entry changed (T-5).')
        },
        required: ['task_id', 'why']
    },
    writes: 'tasks',
    level: 'write',
    mutating: true,
    expectsArg: true,
    primaryArg: 'task_id',
    requires: ['task_id', 'why'],
    async execute(ctx, expects): Promise<ToolResult> {
        const resolved = await mustResolveRef(ctx, ctx.args.task_id, 'task_id', ['tasks']);
        const task = resolved.record as Task;
        const state = typeof ctx.args.state === 'string' ? (ctx.args.state as Task['state']) : undefined;
        const detail = typeof ctx.args.detail === 'string' ? ctx.args.detail : undefined;
        const owner = typeof ctx.args.owner_role === 'string' ? ctx.args.owner_role : undefined;
        const priority = ctx.args.priority === undefined ? undefined : Math.trunc(Number(ctx.args.priority));
        if (priority !== undefined && !Number.isFinite(priority))
            throw new ToolRefusal('T-11', 'priority must be a number.', {
                field: 'priority',
                received: ctx.args.priority,
                fix: 'send an integer'
            });
        if (!state && detail === undefined && !owner && priority === undefined)
            throw new ToolRefusal('T-11', 'editTask received nothing to change.', {
                field: 'state',
                fix: 'send state, detail, owner_role or priority'
            });

        // D-11: a blocked entry that does not say why is worse than no entry — the next run
        // re-derives the blocker from scratch and wastes a pass on it.
        if (state === 'blocked' && !(detail ?? task.detail ?? '').trim())
            throw new ToolRefusal(
                'D-11',
                'blocking a task without a detail line leaves the next run with nothing to read.',
                {
                    field: 'detail',
                    fix: 'say what blocks it and what would unblock it'
                }
            );

        const why = whyOf(ctx);
        const patch: Partial<Task> = {};
        if (state) patch.state = state;
        if (detail !== undefined) patch.detail = detail;
        if (owner) patch.owner_role = owner;
        if (priority !== undefined) patch.priority = priority;
        // L-15: claiming is an attempt, and attempts are what a no-progress loop is detected on.
        if (state === 'claimed') {
            patch.attempts = task.attempts + 1;
            patch.owner_role = patch.owner_role ?? (ctx.roleName || ctx.role);
        }
        // Taking a queued entry is also an assignment, so an unassigned entry handed to nobody
        // would never be picked up (D-11's queue is only useful if it names an owner).
        if (state === 'done' && !patch.owner_role && !task.owner_role) patch.owner_role = ctx.roleName || ctx.role;

        const written = (await commitAs(
            ctx,
            'editTask',
            () => ctx.store.tasks.update(task.id, patch, buildAttribution(ctx, why), expects),
            expects
        )) as Task;

        return ok(
            {
                id: written.id,
                task_id: written.id,
                state: written.state,
                owner_role: written.owner_role ?? '',
                priority: written.priority,
                attempts: written.attempts,
                fields_written: Object.keys(patch).sort(),
                current_rev: written.rev
            },
            written.rev,
            `Task ${written.id} → ${written.state}${state === 'blocked' ? ' (blocked: the detail says why)' : ''}`
        );
    }
};

// ── 5. requestAuthor (P7/D-25) ──────────────────────────────────────────────

/**
 * §8.3 `requestAuthor`: escalation — a decision above the crew's pay grade (P7, D-25). It
 * creates the queue entry (an `escalation` task owned by the Author) and does not block the run,
 * because a run that stops to wait is a run that times out (S-3).
 *
 * Distinct from `reportGap` (§8.4, T-12): this asks about the STORY, that one reports a hole in
 * the BUILD.
 */
const requestAuthor: ToolDefinition = {
    name: 'requestAuthor',
    description:
        'Escalate a decision to the Author: the question, the options they can choose between, and why it cannot be decided here. It queues the question and keeps running; the Author answers in the dashboard (P7, D-25).',
    inputSchema: {
        type: 'object',
        properties: {
            question: str('The decision being asked for, in one line.'),
            options: arr('The choices the Author can pick between (empty means: open question).', str('One option.')),
            context: str('What you know, what you ruled out, and what is at stake (P4).'),
            priority: num('Higher is answered first.'),
            why: whyArg('Why this is the Author\u2019s call and not the crew\u2019s (T-5).')
        },
        required: ['question', 'options', 'why']
    },
    writes: 'tasks',
    level: 'write',
    mutating: true,
    expectsArg: false,
    primaryArg: 'question',
    requires: ['question', 'options', 'why'],
    async execute(ctx): Promise<ToolResult> {
        const question = summarize(String(ctx.args.question ?? ''), 200);
        const options = Array.isArray(ctx.args.options)
            ? (ctx.args.options as unknown[]).map((option) => String(option)).filter(Boolean)
            : [];
        if (!Array.isArray(ctx.args.options))
            throw new ToolRefusal(
                'T-11',
                'options must be an array of strings — an empty array is allowed for an open question.',
                {
                    field: 'options',
                    received: ctx.args.options,
                    fix: 'send [] if there are no discrete options'
                }
            );

        const why = whyOf(ctx);
        const detail = [
            `Question: ${String(ctx.args.question ?? '')}`,
            options.length
                ? `Options:\n${options.map((option, index) => `${index + 1}. ${option}`).join('\n')}`
                : 'Options: none — open question.',
            ctx.args.context ? `Context: ${String(ctx.args.context)}` : '',
            `Asked by: ${ctx.roleName || ctx.role} (${ctx.role})`,
            `Why: ${why}`
        ]
            .filter(Boolean)
            .join('\n');

        const filed = await commitAs(
            ctx,
            'requestAuthor',
            () =>
                openTask(
                    ctx.store,
                    ctx.storyId,
                    {
                        kind: 'escalation',
                        title: question,
                        detail,
                        owner_role: 'author',
                        priority: Number.isFinite(Number(ctx.args.priority))
                            ? Math.trunc(Number(ctx.args.priority))
                            : 50
                    },
                    buildAttribution(ctx, why)
                ),
            []
        );

        const data = { question, options, task_id: filed.task.id, owner_role: 'author', state: filed.task.state };
        if (filed.reused)
            return repeatResult(`Escalation already queued as ${filed.task.id}`, data, {
                task_id: filed.task.id,
                notes: ['D-25: an escalation reaches the Author queue; it does not pause the Story by itself.']
            });
        return ok(data, revOf(filed.task), `Escalation queued as ${filed.task.id}: ${question}`, {
            task_id: filed.task.id,
            notes: [
                'The run keeps working; the Author answers in the dashboard (D-25). A stopped Story would have refused this write (P8).'
            ]
        });
    }
};

// ── 6. markChapterDone (L-10/D-1) ───────────────────────────────────────────

/**
 * §8.3 `markChapterDone`: "a *recommendation*; only the Author finalises" (L-10). So it does NOT
 * touch `Chapter.state` (D-1 forbids an agent moving a lifecycle field) — it queues a `signoff`
 * task for the Author, which is the record that the crew considers the chapter finished.
 *
 * §8 lists no `why` on this row either (see `whyOptional`), so the reason is synthesised from the
 * chapter and its last score.
 */
const markChapterDone: ToolDefinition = {
    name: 'markChapterDone',
    description:
        'Recommend that a chapter is finished. This queues the signoff for the Author; it does not change the chapter state, because only the Author finalises (L-10, D-1).',
    inputSchema: {
        type: 'object',
        properties: {
            chapter_id: str('The chapter (its id, its order number, or a unique part of its title).'),
            evidence: str('Optional: what makes it done — the passing verdict or the criteria met.'),
            why: whyArg('Optional: why it is ready to sign off now.')
        },
        required: ['chapter_id']
    },
    writes: 'tasks',
    level: 'write',
    mutating: true,
    whyOptional: true,
    primaryArg: 'chapter_id',
    requires: ['chapter_id'],
    async execute(ctx): Promise<ToolResult> {
        const resolved = await mustResolveRef(ctx, ctx.args.chapter_id, 'chapter_id', ['chapters']);
        const chapter = resolvedChapter(resolved);
        // D-1: the recommendation is about the chapter; the queue entry is what gets written.
        if (chapter.author_locked)
            throw new ToolRefusal(
                'P9',
                `chapter ${chapter.id} has author_locked set, so its finishing is the Author\u2019s own call.`,
                {
                    chapter_id: chapter.id,
                    fix: 'the Author releases the lock, or signs the chapter off directly'
                }
            );

        const lastVerdict = ctx.store.verdicts
            .list()
            .filter((row) => row.story_id === ctx.storyId && row.target_ref === chapter.id)
            .sort((a, b) => b.round - a.round || b.id.localeCompare(a.id))[0];
        const openFindings = ctx.store.findings
            .list()
            .filter(
                (row) =>
                    row.story_id === ctx.storyId &&
                    row.target_ref === chapter.id &&
                    ['unconfirmed', 'confirmed', 'approved'].includes(row.state)
            );

        const why =
            whyOf(ctx) ||
            `Recommend signoff for chapter ${chapter.id}${lastVerdict ? ` (round ${lastVerdict.round}: ${lastVerdict.hard_pass ? 'hard pass' : 'not passing'})` : ''}`;
        const title = `Sign off chapter ${chapter.order}${chapter.title ? `: ${chapter.title}` : ''}`;
        const detail = [
            `Chapter: ${chapter.id} (state ${chapter.state}, round ${chapter.round}${chapter.last_score ? `, last score ${chapter.last_score}` : ''})`,
            lastVerdict
                ? `Last verdict: ${lastVerdict.id} round ${lastVerdict.round} — ${lastVerdict.hard_pass ? 'hard pass' : 'hard fail'}, ${lastVerdict.soft_count} soft, recommends ${lastVerdict.recommendation}`
                : 'Last verdict: none recorded for this chapter.',
            openFindings.length
                ? `Open findings: ${openFindings.map((finding) => `${finding.id} (${finding.cost})`).join(', ')}`
                : 'Open findings: none.',
            ctx.args.evidence ? `Evidence: ${String(ctx.args.evidence)}` : '',
            `Recommended by: ${ctx.roleName || ctx.role}`,
            `Why: ${why}`
        ]
            .filter(Boolean)
            .join('\n');

        const filed = await commitAs(
            ctx,
            'markChapterDone',
            () =>
                openTask(
                    ctx.store,
                    ctx.storyId,
                    { kind: 'signoff', title, detail, owner_role: 'author', priority: 45 },
                    buildAttribution(ctx, why)
                ),
            []
        );

        const data = {
            chapter_id: chapter.id,
            chapter_state: chapter.state,
            task_id: filed.task.id,
            open_findings: openFindings.length,
            state_changed: false
        };
        if (filed.reused)
            return repeatResult(`Signoff for ${chapter.id} already queued as ${filed.task.id}`, data, {
                task_id: filed.task.id,
                notes: ['L-10: the recommendation is already in front of the Author.']
            });
        return ok(data, revOf(filed.task), `Signoff queued as ${filed.task.id} for ${chapter.id}`, {
            task_id: filed.task.id,
            notes: [
                'Recommendation only: the chapter state is unchanged (D-1), and the Author finalises it (L-10).',
                ...(openFindings.length
                    ? [
                          `${openFindings.length} open finding(s) remain on this chapter — D-34 keeps them in front of the Author.`
                      ]
                    : [])
            ]
        });
    }
};

/** §8.3's six report tools. */
export const checkerTools: ToolDefinition[] = [
    submitVerdict,
    raiseFinding,
    createTask,
    editTask,
    requestAuthor,
    markChapterDone
];

/** Exported for the tests that pin the queue vocabulary this layer files. */
export const CHECKER_TASK_KINDS: Task['kind'][] = ['fix', 'escalation', 'signoff'];
