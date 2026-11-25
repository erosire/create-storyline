/**
 * §8.3 — the reader surface: the report tools. Every one of these WRITES A RECORD and changes
 * no story state (D-1): a verdict is a report, a finding is a claim, `markChapterDone` is a
 * recommendation, and only the loop engine or the Author moves a chapter (L-10, P6).
 *
 * §7 line 619 grants `write` on `verdicts`/`findings` to every dispatched kind, so these tools
 * are not reader-only: a Writer may file the defect it sees. What IS reader-only in practice is
 * who is asked to, which the template brief decides (D-17a) — not the permission row.
 *
 * T-11 lives here in two places the spec calls out by name: `cost` is a required enum
 * (`raiseFinding`), and a failing criterion line with no evidence is invalid (`submitVerdict`,
 * D-15). Both are refused with the accepted value set, not repaired.
 */
// T5: `FINDING_KINDS` is the value the `kind` enum is built from, so the tool, the §4.10 record and
// the dashboard read one list rather than three copies that can drift (`shared/types.ts`).
import { FINDING_KINDS } from '../../shared/types';
import type { Finding, FindingKind, Task, Verdict, VerdictCriterion } from '../../shared/types';
import { criterionById } from '../../shared/criteria';
// SUMMARY PHRASE R3: the group-managed switch and the book's group rows. Imported from the domain's
// one surface (`../phrase`), because `raiseFinding` must apply the SAME reading of an absent
// `group_refs` that `phrase/findings.ts:findingGroupScope` applies when it decides closure — two
// copies of that rule is how a finding ends up open against a group nobody was told about.
// R1 adds the lock's one predicate to the same import: the tool and the planner read "is this group's
// text settled?" off one function (`phrase/catalog.ts:isPhraseGroupLocked`).
import { isGroupManagedStory, isPhraseGroupLocked, phraseGroupsOf } from '../phrase';
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
    revisionRows,
    scoreLine,
    stableFingerprint
} from './artifacts';
import { COST_ENUM, EXPECTS_ARG, RECOMMENDATION_ENUM, arr, bool, enumOf, num, obj, str, whyArg } from './schema';
// D-33c/D-33d: "does this Story still hold an unresolved defect?" and "what did THIS pass already
// file?" are the loop's own questions, not the tool's copies of them. `openIssueFindings` is read by
// the Critic's gate here, the Editor's `approveFinding`, the dial sweep, `engine.approveFinding` and
// the approve-all route, so the four cannot disagree about what "an issue is still open" means — the
// divergence that would let a Critic file a proposal the Editor then refuses to approve.
// `loop/records.ts` imports nothing from the tool layer, so this adds no cycle (same argument as
// `tools/editor.ts`'s import of `isBlockingCost`).
import { findingsRaisedByRun, openIssueFindings } from '../loop/records';
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
 * §6.2a's pipeline is "Reader runs ×M (fresh, read-only) → verdicts per revision", and the loop
 * dispatches one reader per draft (`wi_check_<unit>_<gen>_<revision_id>`, see loop/work.ts); with
 * only artifact targets, every one of those verdicts lands on the unit and U-13's side-by-side view
 * has no per-draft verdicts to show. `resolveRef` already accepts a `revisions` ref
 * (tools/artifacts.ts:RESOLVABLE), so this is the only gate that had to widen.
 *
 * `raiseFinding` deliberately keeps the narrower {@link TARGET_KINDS}: a defect is a claim about an
 * artifact, not about one draft of it — and D-22 deletes the losing drafts, which would leave the
 * finding pointing at a row that no longer exists.
 */
const VERDICT_TARGET_KINDS = [...TARGET_KINDS, 'revisions'] as const;

/**
 * T5: the claim type, normalised once at the top of `raiseFinding`.
 *
 * Anything that is not `proposal` is an `issue`. The schema enum already refuses a bad value with
 * T-11, so the only thing that can reach here besides the two words is an OMISSION, which means the
 * §4.10 default — and the same reading a row raised before the field existed carries (its stored
 * `kind` is absent, and `tools/utilities.ts:findingFingerprint` hashes that form as `issue`).
 */
const kindOf = (value: unknown): FindingKind => (value === 'proposal' ? 'proposal' : 'issue');

/**
 * D-33c's refusal roster: the unresolved issues, named the way every other refusal in this file names
 * the records it is refusing over — the ids, with the state the crew has to move.
 *
 * Capped at three with an explicit count of the rest. A refusal the crew can act on in one turn names
 * what it can act on; a forty-id list past the point of usefulness is noise the run has to clip, and
 * the full set rides in the refusal's `open_issue_refs` detail anyway, so nothing is hidden.
 */
function issueRoster(findings: Finding[]): string {
    const named = findings
        .slice(0, 3)
        .map((finding) => `${finding.id} (${finding.cost}, ${finding.state})`)
        .join(', ');

    return findings.length > 3 ? `${named}, and ${findings.length - 3} more` : named;
}

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
 * per-draft reader jobs (`wi_check_<unit>_<gen>_<revision_id>`) name the draft in the job line, and
 * filing against it is what gives U-13's side-by-side view a verdict per draft. The criteria engine
 * aggregates per TARGET (criteria/engine.ts:aggregateJudgeWithTargets), so a draft verdict cannot
 * displace the artifact verdict the Goal is measured on — with ONE narrow exception: at the
 * `summary` level, a verdict filed against the draft the Summary row CURRENTLY carries is read as
 * evidence for the Summary too (criteria/engine.ts:summaryDraftEvidenceRefs), because in phase ① that
 * draft is the Summary's text. A competing or discarded sibling's verdict still decides nothing.
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
        // §6.2a/D-21: a reader pointed at one draft files its verdict against THAT draft, so the
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
 * R3: `group_refs` normalised by the SAME rule as `related_refs` — trim, drop blanks, dedupe,
 * first-seen order, capped. Only five groups exist, so the 12-ref cap is never the binding limit;
 * reusing the normaliser is the point, because two near-copies of that loop are how a dedupe rule
 * starts to differ between the two fields.
 */
const groupRefsOf = (value: unknown): string[] => relatedRefsOf(value);

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
 * §8.3 `raiseFinding`: a named claim with evidence, on a criterion, in one of two kinds (T5). An
 * `issue` claims a DEFECT — the artifact fails the criterion — and its admissibility test is a
 * quotation: name the commitment and show it broken. A `proposal` suggests a change the Seed never
 * had to promise; the absence rule does not judge it, and the Editor weighs it on whether the book
 * is better for the pass.
 *
 * D-33: a reader's or a Critic's finding starts `unconfirmed` — it is a suspicion until an Editor
 * confirms it. D-16: the same claim against the same criterion, target and KIND bumps `seen_count`
 * instead of opening a second row, which is what makes "no progress" detectable in an amnesiac system.
 *
 * `related_refs` is the one argument beyond §8's row (L-11a, authorized for W2): the other units
 * the defect touches, stored on the record so one report propagates instead of being re-raised per
 * chapter. It is optional, so every §8 call still works unchanged.
 */
const raiseFinding: ToolDefinition = {
    name: 'raiseFinding',
    description:
        "File a claim: the artifact, the criterion, a title, the evidence, and a cost. Say WHICH of the two it is with `kind` (default `issue`). An `issue` claims a DEFECT — it breaks the story's logic, contradicts a commitment, or rests on a claim the text cannot support — and its proof is a quotation: name the commitment the Seed or the artifact states and show the artifact breaking it. A claim whose whole case is something the Seed never said is not an issue, because the Writer may invent any detail the Seed does not rule out. A `proposal` is an IMPROVEMENT the Seed never had to promise — a word change, a new element, a twist linked earlier: title it as a proposal, quote the passage it would improve, and say what to change and why it is worth the pass, because the Editor weighs it on merit, never on whether the Seed promised it. The two cost ladders do not overlap at the ends, and a mis-marked row is refused rather than re-triaged: `critical` is refused for a proposal (a suggestion is not a contradiction the text cannot live with), and `taste` is refused for an issue (a preference is a proposal, not a defect). ISSUES ARE WORKED FIRST, in both directions (D-33c): while any issue on this Story is unresolved — only `fixed` or `discarded` closes one, so `unconfirmed`, `confirmed`, `approved` and `disputed` all still hold — a `kind: proposal` call is refused with the count of open issues, and an `issue` is refused if THIS pass already filed a proposal, because an issue and a proposal never share a review pass: end the pass and file the issue in your next review. File an issue whenever you have one, and if you have no issue and no new proposal, file nothing — an empty pass is a valid, good outcome. Name related_refs — the other records the same claim touches — and it propagates across chapters instead of being re-raised unit by unit (L-11a). A reader or critic finding starts unconfirmed until an Editor confirms it (D-33); the same claim again bumps seen_count instead of opening a row (D-16). On a book written group by group a Summary finding also names its scope in `group_refs`, copied from the `phrase_groups` pairs the brief prints, and it closes once every group it names has been revised (R3).",
    inputSchema: {
        type: 'object',
        properties: {
            target_ref: str('The artifact that fails (a chapter, plotline or summary id).'),
            criterion_ref: str('The criterion id it fails (readGoals lists them).'),
            title: str('The claim in one line, specific enough to act on (P4). For `kind: proposal` it PROPOSES the change — "let the keeper lie first" — rather than accusing the text of an absence.'),
            detail: str('What is wrong and where — the lines or rows involved. For `kind: proposal`: what to change, and why it is worth a Writer pass.'),
            evidence: str('The citable proof (D-15): a quote, a line range, a ledger row. For `kind: proposal`, the passage the change would improve.'),
            cost: COST_ENUM,
            // T5: which of the two claims this is. Optional, so every §8-shaped call still means exactly
            // what it meant — an omitted `kind` is an `issue`, the same reading a row from before the
            // field carries. `proposal` is the Critic's legitimate outlet for an improvement, and the
            // marker is what stops the Editor's absence rule from disputing it (see the description).
            kind: enumOf(
                FINDING_KINDS,
                '`issue` (the default) claims a defect and must quote a commitment the artifact breaks, at cost `critical`, `major` or `minor`; `proposal` suggests a change the Seed never promised, which the Editor weighs on merit, at cost `major`, `minor` or `taste`.'
            ),
            // L-11a: cross-chapter propagation. Optional, so §8's call shape is unchanged.
            related_refs: arr(
                'Other records this defect touches (chapter, plotline or summary ids), so the finding propagates across chapters (L-11a).',
                str('One related record ref.')
            ),
            // SUMMARY PHRASE R3: which Summary GROUPS this defect is about. Optional on the schema so a
            // phase ②/③ call and a legacy (non-group) book are untouched; REQUIRED in practice on a
            // group-managed book's Summary finding, which the handler below enforces with a refusal that
            // lists the ids. It is the field R3's closure rule runs on: a finding closes when every
            // group it names has a revision written to answer it, so an unscoped finding means "the
            // whole Overview" and the next Writer batch rewrites all five groups to answer one sentence.
            group_refs: arr(
                'The Summary groups this defect is about, as the phrase_groups ids in your brief (premise, promise, theme, tone, ending). Name every group it crosses, and all five when the Overview itself is what is wrong: on a group-managed book a Summary finding with no groups is refused, because the repair is routed by these ids and the finding closes only once every group it names has been revised. Only on a legacy whole-Summary book does an omitted list mean the whole Overview (R3).',
                str('One phrase_groups id.')
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
        // T5: which of the two claims this is. Normalised BEFORE anything else reads it — the
        // fingerprint, the row, and both payloads — so an omitted `kind` cannot mean one thing to the
        // dedupe and another to the Author's queue.
        const kind = kindOf(ctx.args.kind);

        // T5/D-33b — the two kinds own opposite ends of the cost ladder, and each end-combination is
        // REFUSED rather than quietly re-triaged.
        //
        // (a) `proposal` + `critical`: `critical` is the ladder's word for a contradiction the text
        //     cannot live with, and it sits on the Author's auto-approve dial by default (D-35), so a
        //     Critic that dressed a wish in `critical` would spend a Writer pass and skip the gate —
        //     the exact failure the `proposal` kind exists to make cheap to say honestly instead.
        // (b) `issue` + `taste` (the mirror, and the half that keeps (a) from being one-sided): "this is
        //     merely a preference" IS the definition of a Proposal, so a row that claims to be a defect
        //     while costing the ladder's preference rung has contradicted itself. Without this rule the
        //     taxonomy leaks the long way round — a Critic files a word-choice wish as a `taste` ISSUE,
        //     it reads as a defect in the Author's queue, and the Editor's absence gate then disputes a
        //     claim that should never have been called a defect.
        //
        // Neither rule touches the Editor: `verifyFinding` may re-cost a row to any rung it can justify,
        // because D-34a makes that triage final (see `tools/editor.ts`, which stays kind- and cost-neutral).
        if (kind === 'proposal' && cost === 'critical') {
            throw new ToolRefusal(
                'D-33b',
                'a `kind: proposal` finding cannot be `critical`: `critical` is a contradiction the text cannot live with — of itself, of the Seed, or of critical Knowledge — and a proposal the Seed never promised is not one.',
                {
                    field: 'cost',
                    expected: ['major', 'minor', 'taste'],
                    fix: "call raiseFinding again with cost `major` at most and kind `proposal`, or with kind `issue` if the draft contradicts something it states"
                }
            );
        }

        if (kind === 'issue' && cost === 'taste') {
            throw new ToolRefusal(
                'D-33b',
                'an `issue` cannot be `taste`: an Issue is rated `critical`, `major` or `minor` — a preference is a Proposal (`kind: proposal`), not a defect.',
                {
                    field: 'cost',
                    expected: ['critical', 'major', 'minor'],
                    fix: "call raiseFinding again with kind `proposal` and cost `taste` when this is a preference, or with cost `minor` at least when it really is a defect"
                }
            );
        }

        // D-33c — ISSUES BEFORE PROPOSALS, in the reviewer's own tool, both directions.
        //
        // WHY HERE AND NOT IN THE PROMPT: the Author's loop was reviewing a book whose defects were still
        // on the table. A Critic that filed one Proposals-with-a-capital-P while three `critical` issues
        // sat unresolved spent the round on a wish, and the Editor had no way to say "answer the defects
        // first" — the pair of claims were two perfectly legal calls and the dial approved whichever cost
        // it covered. These two refusals are the durable fix, and they sit at the gate for the same reason
        // D-33b's pair does: a rule the crew can walk past is a rule the round pays for.
        //
        // Both read the loop's ONE predicate (`loop/records.ts:openIssueFindings`), so this tool, the
        // Editor's `approveFinding` (D-33d), the dial sweep, `engine.approveFinding` and the approve-all
        // route cannot drift apart about what "an issue is still open" means.
        //
        // (a) G1 — a PROPOSAL WAITS FOR THE ISSUES. Every issue has to reach `fixed` or `discarded`
        //     before a proposal can be filed. This covers the SAME-PASS case for free: an issue raised
        //     moments ago in this run is open, so the proposal that follows it is refused here rather
        //     than by a second rule. An issue stays open while `unconfirmed`, `confirmed`, `approved` or
        //     `disputed` — the first three because the repair has not landed, and `disputed` because
        //     "the Editor thinks that is not a defect" is a decision the Author can still overturn, and
        //     until the row closes the record still calls the book defective.
        //
        //     Placed BEFORE the D-16 dedupe on purpose (the same reasoning as the phase-① draft rule
        //     below): a call this rule refuses must not even bump `seen_count` on an older proposal row,
        //     because that would let a proposal advance the loop's "no progress" ledger without being
        //     admissible. It also means a re-sighting of an OPEN proposal is refused while issues are
        //     open — the row the crew wants bumped already exists, so nothing is lost but a count.
        //
        //     Issues themselves are gated by NOTHING here (except (b)): the release valve stays open, and
        //     a proposal becomes filable the instant every issue closes. That is the property a later
        //     "clean revision" feature depends on, so it is written down rather than left to inference.
        if (kind === 'proposal') {
            const openIssues = openIssueFindings(ctx.store, ctx.storyId);

            if (openIssues.length > 0) {
                throw new ToolRefusal(
                    'D-33c',
                    `a proposal cannot be filed while ${openIssues.length} ${openIssues.length === 1 ? 'issue is' : 'issues are'} unresolved — ${issueRoster(openIssues)} — because a suggestion about a book that still has defects is not what the round is for. Every issue has to reach \`fixed\` or \`discarded\` before a proposal can be filed (D-33c).`,
                    {
                        field: 'kind',
                        expected: ['issue'],
                        open_issues: openIssues.length,
                        open_issue_refs: openIssues.map((finding) => finding.id),
                        fix: 'resolve every open issue first (verify, approve, fix or discard it), then call raiseFinding again with kind `proposal` — or file this as `kind: issue` if the draft actually breaks something'
                    }
                );
            }
        }

        // (b) G2 — AN ISSUE AND A PROPOSAL NEVER SHARE A PASS. One review pass answers ONE question:
        //     "what is broken here?" or "what would make this better?". Mixing them is what made the
        //     round unreadable — the Editor's queue arrived as one undifferentiated pile, and the
        //     Proposals rode the dial while the defects were still being argued.
        //
        // The direction the refusal has to cover is the awkward one: the PROPOSAL came first, so (a) has
        // nothing to say about the issue that follows it (an issue is always filable). Attribution goes
        // through the journal (`loop/records.ts:findingsRaisedByRun`), because §4.10 has no `run_ref`
        // field and `related_refs` names what a finding is ABOUT, not who filed it — the same reasoning
        // `revisionReviewFindings` records.
        //
        // The OTHER direction needs no refusal at all: an issue filed first is open, so (a) refuses the
        // proposal that follows it. The two halves are not symmetric by accident.
        if (kind === 'issue') {
            const siblingProposals = findingsRaisedByRun(ctx.store, ctx.storyId, ctx.runId).filter(
                (finding) => finding.kind === 'proposal'
            );

            if (siblingProposals.length > 0) {
                throw new ToolRefusal(
                    'D-33c',
                    `this pass already filed ${siblingProposals.map((finding) => finding.id).join(', ')} as \`kind: proposal\`, and an issue cannot share a review pass with a proposal (D-33c).`,
                    {
                        field: 'kind',
                        expected: ['proposal'],
                        proposal_refs: siblingProposals.map((finding) => finding.id),
                        fix: "this pass filed a proposal; an issue and a proposal cannot share a pass. End the pass; file the issue in your next review"
                    }
                );
            }
        }

        // L-11a: normalised before the dedupe lookup, so a repeat that only adds refs is still
        // recognised as the same finding (the fingerprint never looks at them).
        const relatedRefs = relatedRefsOf(ctx.args.related_refs);
        // SUMMARY PHRASE R3: the groups this defect is about, normalised the same way. `let` because the
        // group-lock rule below NARROWS it: a locked group is never added to a claim's scope, so what is
        // stored is the part of the reporter's scope that can still be rewritten (R1).
        let groupRefs = groupRefsOf(ctx.args.group_refs);
        // The book's own group rows, read ONCE and used twice: to refuse an id the Story does not have,
        // and to tell the reporter which ids it may name. A non-group book has none, and every group
        // rule below is inert for it (R6: a legacy Story's finding keeps its old meaning).
        const ownedGroups = isGroupManagedStory(ctx.story) ? phraseGroupsOf(ctx.store, ctx.storyId) : [];

        // T6/R2c: phase ①'s defect must say WHICH DRAFT it describes, at the moment it is filed.
        //
        // Every downstream reader — the sign-off's blocking set, the verification queue, and the
        // selection's retirement of a lost draft — decides what a finding is about by reading
        // `related_refs` against the draft the Summary row carries. A finding that names a draft the
        // loop has already set aside can never be decided: the Editor's verification pass reads the
        // KEPT draft, which never contained the defect, so the round waits on a question no run can
        // answer (and the crew used to be re-sent at it every sweep). Asking for the one id where it is
        // cheap to ask is the whole fix, and it is refused before the D-16 dedupe so a mis-scoped call
        // cannot even bump `seen_count`.
        //
        // Deliberately narrow:
        //   * phase ① only — a chapter or plotline defect is aimed at its own row, where there is no
        //     competing-draft question to answer;
        //   * a Summary TARGET only — `raiseFinding`'s targets are artifacts (§8's narrow TARGET_KINDS,
        //     the note on that constant above), so "the Summary" is the shape a phase-① draft defect
        //     takes, and the Story-targeted whole-Story findings L-11a propagates stay untouched;
        //   * only once a selection has installed a draft — before the first selection there is nothing
        //     to name, so the rule cannot hold the very first round;
        //   * never on a group-managed book — there is no competing draft there at all (R5), so the id
        //     this rule demands does not exist; the group finding is scoped by `group_refs` instead,
        //     which the block below requires.
        if (ctx.story.phase === 'summary' && target.collection === 'summaries' && !isGroupManagedStory(ctx.story)) {
            const drafts = revisionRows(ctx.store, ctx.storyId).filter((row) => row.unit_kind === 'summary');
            const carried = drafts.find((row) => row.state === 'selected');

            if (carried !== undefined && !relatedRefs.includes(carried.id)) {
                // The refs that name a Summary draft at all: if they name only superseded drafts, the
                // crew is describing a text the Summary no longer holds, which is worth saying out loud
                // rather than filing as a defect on the current one.
                const stale = relatedRefs.filter((ref) => drafts.some((row) => row.id === ref));

                throw new ToolRefusal(
                    'D-33',
                    relatedRefs.length === 0
                        ? `a phase ① finding on the Summary has to name the draft it describes: the Summary now carries ${carried.id}, and a finding that names no draft cannot be verified against it (D-33, §6.4 step 6).`
                        : stale.length > 0
                          ? `${stale.join(', ')} is not the draft the Summary carries — the selection replaced it with ${carried.id}, so a defect written about it is history, not work the round can act on (D-33, §6.6).`
                          : `a phase ① finding on the Summary has to name the draft it describes alongside its other refs: the Summary now carries ${carried.id} (D-33, §6.4 step 6).`,
                    {
                        field: 'related_refs',
                        expected: [carried.id],
                        fix: `call raiseFinding again with related_refs including ${carried.id} — the Summary revision you actually read`
                    }
                );
            }
        }

        // SUMMARY PHRASE R3 — the group attribution, checked against the BOOK before any row moves.
        //
        // Two rules, both of them because R3's closure is a JOIN on these ids:
        //
        //   * an id the Story does not have is refused. Silently dropping it would make the finding
        //     mean something other than what the reporter said — and if it were the finding's ONLY ref,
        //     the row would silently become "the whole Overview", which is the most expensive reading
        //     there is here (every group re-written to answer one sentence);
        //   * on a group-managed book, a phase ① finding ON THE SUMMARY must name its groups. Omitting
        //     `group_refs` is still legal for a cross-cutting defect that genuinely spans the whole
        //     Overview — but the reporter has to have the ids in front of it when it decides that, so
        //     the refusal lists them and the loop never files a Summary defect the planner can only
        //     route to all five.
        //
        // A phase ②/③ finding (chapter, plotline) and a legacy book's Summary finding are untouched: the
        // argument stays optional, and an absent `group_refs` keeps its old whole-Overview meaning.
        if (groupRefs.length > 0) {
            const owned = new Set(ownedGroups.map((group) => group.id));
            const unknown = groupRefs.filter((ref) => !owned.has(ref));

            if (unknown.length > 0) {
                throw new ToolRefusal(
                    'R3',
                    `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not ${owned.size === 0 ? 'a group of this Story' : 'a group of this Story — its groups are ' + ownedGroups.map((group) => `${group.key}=${group.id}`).join(', ')}. A defect cannot be closed against a group that does not exist (R3).`,
                    {
                        field: 'group_refs',
                        expected: [...owned],
                        // HARDENING (R3): this used to offer "omit group_refs" to EVERY book, but on a
                        // grouped book omission is refused by the rule immediately below — the only
                        // honest reading of "the whole Overview" THERE is naming all owned.length ids,
                        // because closure is a JOIN on them (`phrase/findings.ts:findingGroupScope`).
                        // `owned.size === 0` is the legacy whole-Summary book (no catalog), and there
                        // omission keeps its old whole-Overview meaning, so the fix branches with the
                        // message above rather than contradicting it.
                        fix:
                            owned.size === 0
                                ? 'omit group_refs — this book has no phrase groups, so its Summary is one whole text'
                                : `call raiseFinding again with group_refs naming every group the defect crosses — a whole-Overview defect names all ${owned.size} ids listed; this book has no unscoped Summary path`
                    }
                );
            }
        }

        // GROUP LOCK (R1) — a claim cannot be filed against text that has already been signed off.
        //
        // A locked group is SETTLED CONTENT: no install may rewrite it (`revisions.ts:installGroupRevisions`
        // refuses the target), and the lock's own voiding rule (`locks.ts:lockPhraseGroup`) discards the
        // claims whose whole scope just stopped being writable. Filing a NEW claim into that state from a run
        // would be the same dead end dressed up as work: the row would sit open, the planner would offer no
        // group for it, and the round would wait on a text nobody may touch. Two answers, one rule:
        //
        //   * WHOLLY LOCKED (every id named is locked) → REFUSE. The claim has no text left to rewrite, and
        //     silently filing a void row is the "quiet no-op" this package refuses elsewhere: the crew has to
        //     hear that its finding is aimed at settled prose, because the action is the Author's (unlock) or
        //     the finding's own re-scoping, not another pass;
        //   * MIXED (some locked, some open) → the locked ids come OFF the stored scope and the claim stays
        //     the reporter's own, for the groups that CAN move. This is the read the domain already applies
        //     (`findings.ts:findingActionableScope` subtracts the locked part before R3's closure join), so
        //     storing the unlocked subset is not a rewrite of the claim — it is the same scope, stated in the
        //     form the planner and the rail act on. A cross-group defect therefore survives a neighbour's
        //     lock intact; what it may no longer do is demand an edit to the group that stands.
        //
        // UNSCOPED CLAIMS ARE UNTOUCHED, deliberately. An absent `group_refs` means "the whole Overview"
        // (R3's legacy reading, spelled out in `findingGroupScope`), and its scope is a READ of the group
        // rows, not a list the reporter typed; narrowing it here would invent an attribution the crew never
        // made. A whole-Overview claim on a book whose LAST group has just locked is void on the domain's
        // read (`findingActionableScope.voided`) and was voided at lock time if it existed then — which is
        // the domain's job, not this tool's.
        //
        // A non-group book has no rows in `ownedGroups`, so `lockedNamed` is empty and every line here is
        // inert — the legacy filing behaves exactly as it did (R6).
        const lockedGroups = ownedGroups.filter((group) => isPhraseGroupLocked(group));
        const keyOfGroup = new Map(ownedGroups.map((group) => [group.id, group.key]));
        const namedGroups = (ids: string[]) =>
            ids.map((id) => `${keyOfGroup.get(id) ?? id}=${id}`).join(', ');
        const lockedNamed = groupRefs.filter((ref) => lockedGroups.some((group) => group.id === ref));

        if (lockedNamed.length > 0 && lockedNamed.length === groupRefs.length) {
            const openGroups = ownedGroups.filter((group) => !isPhraseGroupLocked(group));

            throw new ToolRefusal(
                'R1',
                `${namedGroups(lockedNamed)} ${lockedNamed.length === 1 ? 'is' : 'are'} locked, so this claim is aimed at settled content — a locked group has no next revision to answer it, and a finding no Writer may act on holds the round open over text the Author has signed off (R1).`,
                {
                    field: 'group_refs',
                    locked_group_refs: lockedNamed,
                    expected: openGroups.map((group) => group.id),
                    fix:
                        openGroups.length === 0
                            ? // Every group stands: the whole Overview is settled, so there is genuinely
                              // nothing this pass can file as work. Saying so beats offering a re-scope that
                              // would name the same locked rows under another name.
                              'file nothing against the Summary — every group of this Overview is locked; only the Author lifts a lock (POST …/phrases/groups/:groupId/unlock)'
                            : `call raiseFinding again with group_refs naming the groups the defect crosses that are NOT locked (${namedGroups(openGroups.map((group) => group.id))}), or ask the Author to unlock the group first`
                }
            );
        }

        // MIXED: the locked part comes off, and the reporter is TOLD in the result it reads — a scope that
        // quietly shrinks between what it sent and what is stored is how a crew starts re-filing the same
        // claim every pass, hunting for the group it cannot name.
        const droppedLockedGroups = lockedNamed;
        groupRefs = groupRefs.filter((ref) => !lockedNamed.includes(ref));

        if (
            ownedGroups.length > 0 &&
            ctx.story.phase === 'summary' &&
            target.collection === 'summaries' &&
            groupRefs.length === 0
        ) {
            throw new ToolRefusal(
                'R3',
                `this Summary is written group by group, so a defect on it has to say which groups it is about: ${ownedGroups
                    .map((group) => `${group.key}=${group.id}`)
                    .join(', ')}. A finding that names none is read as "the whole Overview", and the fix would rewrite all five groups to answer one sentence (R3).`,
                {
                    field: 'group_refs',
                    expected: ownedGroups.map((group) => group.id),
                    fix: 'call raiseFinding again with group_refs naming every group the defect crosses'
                }
            );
        }

        // D-16: the fingerprint carries the kind (T5), so the same sentence filed once as a defect and
        // once as a proposal is two rows — they are different claims, and the Editor decides them by
        // opposite rules. An `issue` keeps the pre-field hash, so a row raised before `kind` existed
        // still dedupes against a new `issue` report (L-16a: no silent second row for an old finding).
        const fingerprint = fingerprintFinding(target.id, criterionRef, title, kind);
        const duplicate = duplicateFinding(ctx.store, ctx.storyId, fingerprint);
        const why = whyOf(ctx) || `Finding on ${target.id} for ${criterionRef}: ${title}`;

        // D-16: a repeat sighting counts itself. The bump is a write, so it goes through a commit
        // with the same attribution discipline as a new row (P11).
        if (duplicate) {
            // L-11a: the bump also keeps any unit the earlier sighting did not name, so propagation
            // survives dedupe instead of being paid for with a second row. R3's `group_refs` follow the
            // same merge: a repeat that names one more group widens the scope of the row the loop is
            // already working on rather than filing a second claim against the same defect.
            const mergedRefs = mergedRelatedRefs(duplicate.related_refs, relatedRefs);
            const mergedGroups = mergedRelatedRefs(duplicate.group_refs, groupRefs);
            const bumped = (await commitAs(
                ctx,
                'raiseFinding',
                () =>
                    ctx.store.findings.update(
                        duplicate.id,
                        {
                            seen_count: duplicate.seen_count + 1,
                            ...(mergedRefs ? { related_refs: mergedRefs } : {}),
                            ...(mergedGroups ? { group_refs: mergedGroups } : {})
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
                    // T5: the kind the OPEN row actually carries. A legacy row has no `kind` field, and
                    // `issue` is the honest reading of it — the same reading the fingerprint gave it.
                    kind: bumped.kind ?? 'issue',
                    criterion_ref: bumped.criterion_ref,
                    target_ref: bumped.target_ref,
                    // L-11a: what the open row now says it touches, so the reporter knows the
                    // propagation it asked for is on the record (an empty array means none).
                    related_refs: bumped.related_refs ?? [],
                    // R3: and which groups the open row now targets (empty = the whole Overview).
                    group_refs: bumped.group_refs ?? []
                },
                { finding_id: bumped.id }
            );
        }

        // D-30: a Critic's finding is the Editor's input, so it has to carry the what-and-where
        // line. Evidence alone names the proof; `detail` is what lets the Editor check the claim
        // against the passage without re-reading the draft — the quick verdict the phase needs.
        if (ctx.role === 'critic' && detail.trim().length === 0) {
            throw new ToolRefusal(
                'D-30',
                `a Critic finding needs \`detail\`: what is wrong and where (section, paragraph or lines), so the Editor can check it against the passage without re-reading the draft`,
                {
                    field: 'detail',
                    fix: 'call raiseFinding again with detail naming the passage; add related_refs when the defect touches another record'
                }
            );
        }

        // D-33: only an Editor's own finding starts `confirmed` — the Editor is the one who
        // confirms, so confirming its own report is not a rubber stamp of someone else's claim.
        const editorIssued = ctx.role === 'editor';
        // R1 — the note a narrowed scope owes the reporter (see the group-lock rule above). It rides on the
        // result of BOTH roles: an Editor that filed over a locked group needs the same sentence, and the
        // echoed `group_refs` alone would read as the tool losing an id it was given.
        const lockNotes =
            droppedLockedGroups.length === 0
                ? []
                : [
                      `Locked groups are settled content: ${namedGroups(droppedLockedGroups)} came off this finding's scope, which now names only the groups a Writer may still rewrite (R1). Only the Author lifts a lock.`
                  ];
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
                        // T5: stored EXPLICITLY, default included. `related_refs`/`group_refs` above are
                        // omitted when empty because absence is their meaning; here absence means
                        // `issue` too, but writing the word keeps a new row self-describing next to the
                        // kind it dedupes against, and leaves the legacy rows as the only kind-less ones.
                        kind,
                        fingerprint,
                        state: editorIssued ? 'confirmed' : 'unconfirmed',
                        confirmed_by: editorIssued ? (ctx.runId ?? null) : null,
                        approved_by: null,
                        seen_count: 1,
                        // L-11a: omitted rather than stored empty, so a record that names nothing
                        // looks exactly like a record raised before the field existed. R3's
                        // `group_refs` follow the same discipline: an absent field is the legacy
                        // whole-Overview meaning, and `phrase/findings.ts:findingGroupScope` is the one
                        // place that reading is written down.
                        ...(relatedRefs.length ? { related_refs: relatedRefs } : {}),
                        ...(groupRefs.length ? { group_refs: groupRefs } : {})
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
                // T5: echoed so the run can see which claim it actually filed — an omitted `kind` comes
                // back as the `issue` it was stored as, rather than as nothing.
                kind: written.kind ?? 'issue',
                state: written.state,
                fingerprint: written.fingerprint,
                seen_count: written.seen_count,
                // L-11a: echoed so the run can see what it propagated, and so a reader of the
                // transcript does not have to re-read the record to learn the fan-out.
                related_refs: written.related_refs ?? [],
                // R3: and the groups the row now targets, echoed the same way. An empty array here means
                // "the whole Overview" — which on a group-managed book the handler has just refused, so
                // the only way a caller sees `[]` is a phase ②/③ finding or a legacy Summary one.
                group_refs: written.group_refs ?? [],
                // R1: only present when the lock narrowed this claim, so every other filing keeps the exact
                // result payload it had. What was dropped is reported rather than hidden, because the crew
                // that named three groups and stored two has to know which neighbour stands.
                ...(droppedLockedGroups.length === 0
                    ? {}
                    : { locked_group_refs_dropped: droppedLockedGroups }),
                // D-34: the cost the Author's dial auto-approves starts work without a gate.
                auto_approved_cost: ctx.story.auto_approve.includes(written.cost),
                current_rev: written.rev
            },
            written.rev,
            `Finding ${written.id} on ${target.id} (${criterionRef}, ${cost}) — ${written.state}`,
            {
                finding_id: written.id,
                notes: editorIssued
                    ? lockNotes.length === 0
                        ? undefined
                        : lockNotes
                    : [
                          'Unconfirmed until an Editor confirms, disputes or rewrites it (D-33). Nothing is repaired yet (D-34).',
                          // T5: a proposal is judged by the OPPOSITE test from a defect claim, and
                          // saying so in the result the Reporter reads keeps it from re-filing a proposal
                          // as a defect the round after the first one is disputed.
                          ...(written.kind === 'proposal'
                              ? [
                                    'This is a proposal, not a defect: the Editor weighs it on whether the book is better for a Writer pass, never on whether the Seed promised the change.'
                                ]
                              : []),
                          ...lockNotes
                      ]
            }
        );
    }
};

// ── 3. confirmFinding (phase ①'s independent second look) ───────────────────

/** The states a Critic may still confirm: after the Editor's verify, before the fix has closed it. */
const CONFIRMABLE_FINDING_STATES: Array<Finding['state']> = ['confirmed', 'approved'];

/**
 * Phase ①'s granular second look. The Editor's `verifyFinding` confirms a Critic's suspicion;
 * this tool is the Critic's OWN independent pass over that same single finding, after the Editor
 * has approved it. A `confirm` is what lets the Writer spend a round on the defect
 * (`critic_confirmed`), and a `dispute` withdraws the queued fix so no Writer acts on a claim the
 * Critic no longer believes. It writes one finding — never a batch — so each thread carries one
 * decision and one piece of evidence.
 */
const confirmFinding: ToolDefinition = {
    name: 'confirmFinding',
    description:
        "Record the Critic's independent second look at an Editor-approved finding: `confirm` when the defect holds (the Writer's fix is then allowed), or `dispute` when it does not (the queued fix is withdrawn). This thread confirms exactly one finding and rewrites nothing else.",
    inputSchema: {
        type: 'object',
        properties: {
            finding_id: str('The finding the Editor approved.'),
            verdict: {
                type: 'string',
                enum: ['confirm', 'dispute'],
                description: 'confirm = the defect is real; dispute = the Critic does not believe it.'
            },
            evidence: str('What this independent check read and what it showed (required — no verdict without evidence).'),
            why: whyArg('Why this is the right verdict for this finding (T-5).'),
            expects: EXPECTS_ARG
        },
        required: ['finding_id', 'verdict', 'evidence', 'why']
    },
    writes: 'findings',
    level: 'verify',
    mutating: true,
    primaryArg: 'finding_id',
    // A report-style decision, like `verifyFinding`: the row it checks is named by the brief and
    // the call carries its evidence, so it does not need a separate `expects` read (T-4).
    expectsArg: false,
    // Phase ①'s confirmation is a CRITIC act: the Editor verified, the Critic re-checks it. The
    // grant is explicit so the §7 row's `write` level for a Critic does not have to be widened.
    kinds: ['critic'],
    onlyKinds: ['critic'],
    requires: ['finding_id', 'verdict', 'evidence', 'why'],
    async execute(ctx, expects): Promise<ToolResult> {
        const target = await mustResolveRef(ctx, ctx.args.finding_id, 'finding_id', ['findings']);
        const finding = target.record as Finding;
        const verdict = String(ctx.args.verdict ?? '');
        const evidence = String(ctx.args.evidence ?? '').trim();
        const why = whyOf(ctx);

        if (verdict !== 'confirm' && verdict !== 'dispute') {
            throw new ToolRefusal('T-11', 'confirmFinding needs verdict "confirm" or "dispute".', {
                field: 'verdict',
                received: verdict,
                fix: 're-check the finding and say whether it holds'
            });
        }

        if (!CONFIRMABLE_FINDING_STATES.includes(finding.state)) {
            throw new ToolRefusal(
                'D-33',
                `finding ${finding.id} is ${finding.state}, so there is nothing for the Critic to confirm — only an Editor-confirmed or approved finding reaches this pass`,
                {
                    finding_id: finding.id,
                    state: finding.state,
                    fix: 'the Editor confirms a suspicion first (verifyFinding); the Critic confirms that confirmation'
                }
            );
        }

        if (!evidence) {
            throw new ToolRefusal(
                'D-15',
                'confirmFinding needs `evidence`: the independent check has to say what it read and what it showed',
                {
                    field: 'evidence',
                    finding_id: finding.id,
                    fix: 'quote the passage or the line range this check looked at'
                }
            );
        }

        const appended = `${finding.evidence}\n\nCritic confirmation: ${evidence}`;
        const written = (await commitAs(
            ctx,
            'confirmFinding',
            async () => {
                const updated = ctx.store.findings.update(
                    finding.id,
                    {
                        state: verdict === 'confirm' ? finding.state : 'disputed',
                        critic_confirmed: verdict === 'confirm',
                        critic_confirmed_by: ctx.actorLabel,
                        evidence: appended
                    },
                    buildAttribution(ctx, why),
                    expects
                );

                // A disputed finding must not leave a Writer task standing: the approval created
                // the queue entry, so the Critic's veto withdraws it in the same commit.
                if (verdict === 'dispute') {
                    for (const task of ctx.store.tasks.list()) {
                        if (task.story_id !== ctx.storyId || task.finding_ref !== finding.id) continue;
                        if (task.state !== 'open' && task.state !== 'claimed' && task.state !== 'blocked') continue;

                        ctx.store.tasks.update(
                            task.id,
                            { state: 'wontfix' },
                            buildAttribution(
                                ctx,
                                `${finding.id} was disputed by the Critic's independent check, so its fix task is withdrawn`
                            )
                        );
                    }
                }

                return updated;
            },
            expects
        )) as Finding;

        return ok(
            {
                id: written.id,
                state: written.state,
                verdict,
                critic_confirmed: written.critic_confirmed === true,
                current_rev: written.rev,
                next:
                    verdict === 'confirm'
                        ? `the Writer may now fix ${written.id} (phase ①)`
                        : `the fix work for ${written.id} is withdrawn; the finding stays disputed for the audit trail (D-33)`
            },
            written.rev,
            `Finding ${written.id} ${verdict === 'confirm' ? 'confirmed' : 'disputed'} by the Critic`
        );
    }
};

// ── 4. createTask (D-11/P4/P12) ─────────────────────────────────────────────

/**
 * §8.3 `createTask`: the fix a reader wants, handed to the queue rather than to an agent
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
                // `researcher` is a dispatched kind (§7.2): a Researcher may queue the research
                // work it cannot do here, and any kind may route a fact-check to it.
                ['writer', 'editor', 'critic', 'reader', 'researcher', 'author'],
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
        // The claim path exists so a reader that intends to do the work itself does not have the
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
            owner_role: enumOf(
                ['writer', 'editor', 'critic', 'reader', 'researcher', 'author'],
                'Who does the work now.'
            ),
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
export const readerTools: ToolDefinition[] = [
    submitVerdict,
    raiseFinding,
    confirmFinding,
    createTask,
    editTask,
    requestAuthor,
    markChapterDone
];

/** Exported for the tests that pin the queue vocabulary this layer files. */
export const READER_TASK_KINDS: Task['kind'][] = ['fix', 'escalation', 'signoff'];
