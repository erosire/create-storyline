// Work generation: given one Story's records, what jobs should a crew run next (L-1 step 4, §6.2).
//
// TWO SHAPES LIVE HERE, and the phase decides which one a Story runs:
//
//   * PHASES ②/③ are §6.2a's classic divergence, per unit:
//
//       writers ×`attempts`  →  competing revisions  →  checkers ×M  →  an Editor selects  →  losers deleted
//
//   * PHASE ① is the research pipeline (documents/phase-1-research-pipeline.md §6.4), and it has NO
//     Editor choice and NO `write_unit` at all — the engine persists each sample from the run's
//     validated structured answer and selects deterministically:
//
//       Editor structures the Seed      (structure_seed, wi_structure_seed_<seedHash>)
//         → Researcher gathers Knowledge (research, wi_research_<brief.rev>)
//         → N no-tool one-turn samples  (sample_unit, wi_sample_<summaryRef>_<round>_<attempt>)
//         → M no-tool screens per sample(screen_samples, wi_screen_<revisionId>_<attempt>)
//         → the ENGINE selects the least-issue sample (sample-select.ts, §6.5) and truncates the rest
//         → deep review by tool-using Readers             (check_unit, wi_review_<revisionId>_a<pass>)
//         → Editor verification (verify_findings/verify_ideas) → an approval queues a `fix` task
//         → that open `fix` task arms round N+1, whose compiled prompt carries base revision + tasks.
//
// The loop is DRIVEN BY RECORDS, never by a criterion that happens to be red. That distinction is
// the difference between "the crew works until it drains" (L-37) and "the crew re-drafts the same
// chapter forever" (§15 step 9's treadmill). So a writer is dispatched only on one of four triggers:
//
//   * the unit has never been drafted and no crew has ever been pointed at it (a first pass);
//   * an open queue task names it — the fix work D-34's approval creates, the merge L-19 asks for, the
//     re-brief L-18's `rejectAll` creates, the directive D-19 propagates, the Idea D-29 selected;
//   * the chapter carries `needs_recheck` (L-12: a `needs_recheck` chapter is re-entered automatically,
//     which is the rule that stops approved chapters rotting silently);
//   * a checker turned up nothing to fix but the unit has no verdict at all, so nobody has judged it.
//
// A claim key is DETERMINISTIC and carries a generation counter derived from the run rows
// (`wi_write_ch4_2_a1`), which is what makes L-2's "two sweeps must never spawn two crews for one job"
// true across a restart as well as inside one process: the run row's `work_item_ref` outlives the
// process, so the claim is the lease (S-4a) and a restarted engine sees it.
import {
    actionableFindings,
    attemptsOf,
    competingRevisions,
    createdAfter,
    currentSeedBrief,
    deepReviewKeyOf,
    dispatchableTasks,
    findingRefs,
    ideasToVerify,
    isClaimed,
    isLiveRun,
    last,
    liveRuns,
    maxConcurrentOf,
    openEscalationTask,
    openTasks,
    researchClosed,
    researchKeyOf,
    roundRevisions,
    runsForItem,
    SAMPLING_RETRY_ALLOWANCE,
    sampleAttempts,
    samplingArmed,
    samplingCapOf,
    samplingRoundOf,
    samplingSizeOf,
    samplingWaveOf,
    samplePrefixOf,
    screenAttempts,
    screensFor,
    screeningCapOf,
    screeningSizeOf,
    screenPrefixOf,
    selectedSummaryRevision,
    storyChapters,
    storyFindings,
    storyPlotlines,
    storySummary,
    summaryRevisions,
    templatesFor,
    unconfirmedBlockingFindings,
    unconfirmedFindings,
    unitIsChecked,
    verdictsTargeting,
    wholeStoryVerdicts
} from './records';
import { pendingDirectives } from './directives';
import { dialKeyOf, drainPreconditions, probeIsLive } from './status';
import type { WorkCandidate } from './types';
import {
    type RoleKind,
    type StoryPhase,
    type Story,
    type Task,
    type Template,
    type UnitKind,
    type Chapter
} from '../../shared/types';
import { ISSUE_LIST_SCHEMA_NAME, IssueListSchema, SUMMARY_SAMPLE_SCHEMA_NAME, SummarySampleSchema } from '../../shared/schemas';
import { seedHashOf } from '../../shared/seed-hash';
import type { WorkItem, WorkUnitRef } from '../run/types';
import type { Store } from '../store';

/** The four writer triggers, as data, so a test can assert WHY a draft was spawned (L-22's honesty). */
export const WRITE_TRIGGERS = {
    /** Nothing has ever been pointed at this unit — the first pass (§15 step 1). */
    first: 'first pass',
    /** A queue task names it: D-34's approved finding, L-18's re-brief, L-19's merge, D-19's directive. */
    task: 'queue task',
    /** L-12: a `needs_recheck` chapter re-enters the loop by itself. */
    recheck: 'needs_recheck',
    /** The artifact exists but has never been judged, so the crew owes it a look. */
    unjudged: 'never judged'
} as const;

// ---------------------------------------------------------------------------
// Claim keys (L-2)
// ---------------------------------------------------------------------------

/** How many times this prefix has already been dispatched, live or closed — the generation counter. */
function dispatchCount(store: Store, prefix: string): number {
    return store.runs.list().filter((run) => (run.work_item_ref ?? '').startsWith(prefix)).length;
}

/**
 * A generation counter for a claim family whose unit ref comes AFTER the generation in the key
 * (`wi_select_<n>_<unitRef>`). `dispatchCount` reads the prefix before the number, so this is the
 * one place a family is counted by its tail instead; without it a unit could only ever be selected
 * once, and phase ①'s second (corrected) draft would wait for a choice that never comes.
 */
function dispatchCountFor(store: Store, prefix: string, unitRef: string): number {
    return store.runs
        .list()
        .filter(
            (run) =>
                (run.work_item_ref ?? '').startsWith(prefix) &&
                (unitRef === '' || (run.work_item_ref ?? '').endsWith(`_${unitRef}`))
        ).length;
}

/**
 * Rotates an offer list by `generation % length` so successive sweeps lead with different entries.
 *
 * Used for the checker offers above: the generation is already store-derived, so the rotation is a pure
 * function of records rather than of anything the engine remembers between sweeps.
 */
function rotateByGeneration<T>(items: T[], generation: number): T[] {
    if (items.length <= 1) return items;

    const rotated = [...items];
    const steps = (generation - 1) % rotated.length;

    for (let step = 0; step < steps; step += 1) rotated.push(rotated.shift() as T);

    return rotated;
}

/** The claim key for a job, with the generation that makes a re-run of the same job a NEW claim. */
function claimKey(prefix: string, generation: number, suffix = ''): string {
    return suffix.length > 0 ? `${prefix}_${generation}_${suffix}` : `${prefix}_${generation}`;
}

// ---------------------------------------------------------------------------
// The three per-unit predicates
// ---------------------------------------------------------------------------

/**
 * Is a crew already on this unit's draft? Any live `write_unit` run naming the unit answers yes
 * (L-2's claim), and so does a live `merge` or `select` run — the unit is mid-decision either way.
 */
function unitIsBusy(store: Store, storyId: string, unitRef: string): boolean {
    return liveRuns(store, storyId).some(
        (run) => run.work_item_ref?.includes(unitRef) === true || (run.work_item_ref ?? '').includes(`_${unitRef}`)
    );
}

/**
 * Closed writer runs for one unit — "has a crew already drafted this?" (the first-pass predicate).
 *
 * The SET-level unit (ref '' — phase ② while the chapter count does not match the plotline set,
 * C-0/D-3b) has no claim-key namespace of its own: `wi_write_` would match every writer run the
 * Story ever ran, so the set would read as already drafted on a Story that has never had a plotline
 * and the phase ② Writer would never be dispatched (§15 step 2). Like `judgedBefore` next to it, the
 * empty ref answers "not by this test", and the sibling predicate over the story row decides.
 */
function draftedBefore(store: Store, unitRef: string): boolean {
    if (unitRef === '') return false;

    return store.runs.list().some((run) => (run.work_item_ref ?? '').startsWith(`wi_write_${unitRef}`));
}

/**
 * Is a Writer still on this unit? `createStory` opens every Story with an EMPTY Summary row, so
 * `draftedBefore` alone cannot tell "the Writer is writing it right now" from "the Summary was
 * written in place": the live Writer's run is already a `wi_write_*` row, and the row it will fill
 * carries only `chapter_count`. Phase ①'s in-place review path must wait for that run to close —
 * Readers read a finished artifact, never the empty row a live Writer has not reached yet (§4.15).
 */
function writerIsLiveOn(store: Store, storyId: string, unitRef: string): boolean {
    return liveRuns(store, storyId).some(
        (run) => run.role === 'writer' && (run.work_item_ref ?? '').includes(`_${unitRef}_`)
    );
}

/**
 * Any verdict naming one unit (or one of its drafts), which is the "somebody judged it" signal.
 *
 * The set-level unit (ref '' — phase ② while the chapter count does not yet match the plotline set,
 * C-0/D-3b) has no row of its own to be filed against, and the set's consistency is judged AT THE STORY
 * ROW (criteria/engine.ts:scopeTargets). Reading an empty ref literally would ask a question no verdict
 * can answer, and the sweep would buy a fresh checker pass for the set on every sweep forever.
 */
const judgedBefore = (store: Store, storyId: string, unitRef: string): boolean =>
    verdictsTargeting(store, storyId, unitRef === '' ? storyId : unitRef).length > 0;

/**
 * How many times an Editor has already chosen for one unit, which is how many divergence passes that
 * unit has FINISHED (D-17d). Read from stored rows so the count survives a restart (L-3).
 */
function selectedPasses(store: Store, unitRef: string): number {
    return store.revisions.list().filter((revision) => revision.unit_ref === unitRef && revision.state === 'selected')
        .length;
}

/**
 * The drafts the unit's CURRENT pass still owes (D-17d, L-16, W4b).
 *
 * The Author sets `attempts` on the assigned Writer template; the pass that consumes them is numbered by
 * how many times the Editor has already chosen for the unit, so the same generation of keys keeps being
 * offered until the set is complete. `owing > 0` is the state where one competing draft must NOT cancel
 * its unborn siblings — L-16's drafts are blind siblings, not sequels — and where the Editor must not
 * choose between drafts that were never written: D-17d's choice is between the attempts the Author asked
 * for, not between however many happened to run before the first one got checked.
 *
 * PHASE ① HAS NO `write_unit` AT ALL (documents/phase-1-research-pipeline.md §6.4): its drafts come
 * from `sample_unit` runs whose answer the ENGINE persists, so this gap is phases ②/③'s question and
 * the `story.phase === 'summary'` branch that used to answer it is gone with the classic pipeline.
 */
function divergenceGap(store: Store, story: Story, unitRef: string, attempts: number): number {
    if (attempts <= 1) return 0;

    // A unit the Editor has already chosen for is being REVISED, not re-sampled. Phase ①'s loop is
    // Writer → Reader → Editor, and the Editor's valid critique sends back ONE corrected draft (the
    // `wi_fix_*` job); re-expanding it into the Author's whole sampling set every round would make
    // a revision cost N drafts and turn a single critique into a new search.
    if (selectedPasses(store, unitRef) > 0) return 0;

    // Only a pass that is IN FLIGHT owes siblings. Once the drafts are gone — chosen, or never written —
    // the unit's next step is whatever its triggers say, not another generation of drafts; without this
    // clause a decided unit would re-open its own divergence set on every sweep and never drain.
    if (competingRevisions(store, story.id, unitRef).length === 0) return 0;

    const prefix = `wi_write_${unitRef}_${divergenceGeneration(store, unitRef)}_a`;

    return Math.max(
        0,
        attempts - store.runs.list().filter((run) => (run.work_item_ref ?? '').startsWith(prefix)).length
    );
}

/** The pass number the next draft of this unit belongs to (see `divergenceGap`). */
const divergenceGeneration = (store: Store, unitRef: string): number => selectedPasses(store, unitRef) + 1;

/**
 * Phase ①'s sampling size: how many Writers expand one Seed Brief per round.
 *
 * Kept as a named export because the Summary pane and the loop's tests read it; the number itself is
 * `records.ts:samplingSizeOf`, which is where `./status` and `./engine` read it from too — one
 * definition, no cycle between the decision machine and work generation.
 */
export const summarySamplingOf = (story: Story): number => samplingSizeOf(story);

/** Phase ①'s screening count: how many Readers judge each sample (§6.4 step 4). */
const summaryReadersOf = (story: Story): number => screeningSizeOf(story);

/**
 * Does this unit need a Writer, and on which trigger?
 *
 * The competing-revision guard is L-16's discipline seen from the other side: while drafts are
 * competing, a new Writer would be a fourth draft nobody asked for, and the unit's next step is a
 * checker or an Editor, not another draft.
 */
export function writeTrigger(
    store: Store,
    story: Story,
    unitRef: string,
    chapter: Chapter | undefined,
    /** Drafts the current divergence pass still owes (see `divergenceGap`). */
    owing = 0
): { trigger: string; tasks: Task[] } | undefined {
    // Phase ① never reaches this function (its Writer jobs are `sample_unit`, generated by
    // `phase1PipelineCandidates`), so the gate that used to hold a Writer behind the Seed review
    // lives there now: nothing is sampled until an accepted brief exists and its research closed.

    // While drafts are competing the unit's next step is normally a checker or an Editor, not a fourth
    // draft nobody asked for. The exception is D-17d: the Author asked for N blind attempts, and the
    // first one landing must not cancel the ones still owed (L-16's drafts are siblings).
    if (competingRevisions(store, story.id, unitRef).length > 0 && owing <= 0) return undefined;

    // The pass still owes siblings (D-17d): the trigger IS the divergence. The unit's row state has
    // already moved on — the first draft set it to `in_pass` (L-8's bookkeeping) — so none of the
    // first-pass branches below would fire, and the remaining attempts are part of THIS pass rather than
    // a fresh one.
    if (owing > 0) return { trigger: WRITE_TRIGGERS.first, tasks: [] };

    const tasks = dispatchableTasks(store, story.id).filter(
        (task) =>
            task.detail?.includes(unitRef) === true ||
            task.title.includes(unitRef) === true ||
            (task.finding_ref !== undefined && findingTouchesUnit(store, task.finding_ref, unitRef))
    );

    if (tasks.length > 0) return { trigger: WRITE_TRIGGERS.task, tasks };

    if (chapter !== undefined && (chapter.state === 'needs_recheck' || chapter.state === 'outlined')) {
        return { trigger: chapter.state === 'needs_recheck' ? WRITE_TRIGGERS.recheck : WRITE_TRIGGERS.first, tasks };
    }

    if (chapter === undefined && !draftedBefore(store, unitRef) && !judgedBefore(store, story.id, unitRef)) {
        // A summary or plotline-set unit with no crew history: §15 step 1's first pass.
        return { trigger: WRITE_TRIGGERS.first, tasks };
    }

    if (
        chapter !== undefined &&
        chapter.state === 'drafting' &&
        !draftedBefore(store, unitRef) &&
        !judgedBefore(store, story.id, unitRef)
    ) {
        return { trigger: WRITE_TRIGGERS.first, tasks };
    }

    return undefined;
}

/** Does the finding behind a task touch this unit? L-11a's `related_refs` are part of the answer. */
function findingTouchesUnit(store: Store, findingId: string, unitRef: string): boolean {
    const finding = store.findings.get(findingId);

    if (finding === undefined) return false;

    return finding.target_ref === unitRef || (finding.related_refs ?? []).includes(unitRef);
}

/**
 * Does this unit need a checker?
 *
 * Two cases. A unit with competing drafts needs one per draft (§6.2a's "Checker runs ×M → verdicts per
 * revision"), and a unit whose newest draft has not been judged needs one against the stored artifact.
 * Freshness is a journal-order question, not an id comparison — verdict ids and revision ids come from
 * different counters (records.ts:createdAfter).
 */
export function needsChecker(store: Store, story: Story, unitRef: string): boolean {
    const competing = competingRevisions(store, story.id, unitRef);
    const newestDraft = last(competing);
    const verdicts = verdictsTargeting(store, story.id, unitRef);
    const perDraft = competing.filter((revision) => verdictsTargeting(store, story.id, revision.id).length > 0);

    if (competing.length > 0) {
        if (perDraft.length === competing.length) return false;

        // Drafts exist that nobody has judged yet. If unit-level verdicts already cover the count,
        // `unitIsChecked` said yes and this is unreachable; otherwise check what is missing.
        return verdicts.length < competing.length || perDraft.length < competing.length;
    }

    if (newestDraft !== undefined) {
        return verdicts.every((verdict) => !createdAfter(store, verdict, newestDraft)) && draftedBefore(store, unitRef);
    }

    // No drafts at all (the tool layer wrote the artifact in place): the unit needs a verdict if a
    // crew has written to it and nobody has judged it since.
    const newestWrite = last(
        store.runs
            .list()
            .filter((run) => (run.work_item_ref ?? '').startsWith(`wi_write_${unitRef}`) && run.state !== 'spawning')
    );

    if (newestWrite === undefined) return false;

    return !judgedBefore(store, story.id, unitRef);
}

/** Whether an Editor should be dispatched for one unit (§6.2a's choice, gated on checked drafts). */
export function needsEditor(store: Store, story: Story, unitRef: string, owing = 0): boolean {
    const competing = competingRevisions(store, story.id, unitRef);

    if (competing.length === 0) return false;

    // D-17d: the Editor chooses between the attempts the Author asked for, so it waits for the set. A
    // choice made while drafts are still owed would delete drafts that were never written (D-22).
    if (owing > 0) return false;

    return unitIsChecked(store, story.id, unitRef);
}

// ---------------------------------------------------------------------------
// The candidate list
// ---------------------------------------------------------------------------

/** The unit a job is about: `undefined` ref means the whole-Story artifact for this phase (§8.3). */
function wholeStoryUnit(phase: StoryPhase): WorkUnitRef | undefined {
    if (phase === 'summary') return { kind: 'summary', ref: '' };

    return undefined;
}

/** Builds one candidate, resolving the template and role and checking the claim (L-2). */
function candidate(
    store: Store,
    story: Story,
    kind: WorkItem['kind'],
    roleKind: RoleKind,
    unit: WorkUnitRef | undefined,
    key: string,
    why: string,
    priority: number,
    extra: Partial<WorkItem> = {},
    /** For a reader: which assigned angle this pass takes (so N passes are N different seats). */
    rotation?: number
): WorkCandidate | undefined {
    if (isClaimed(store, key)) return undefined;

    const pool = templatesFor(store, story, roleKind);

    if (pool.length === 0) return undefined;

    // S-5: each template's own ceiling is checked at dispatch time; here we bind ONE template so the
    // Work Item's `templateRef` is deterministic. Reader roles rotate across the assigned reader
    // templates (D-30's four angles); every other kind takes the first assigned match.
    const template = roleKind === 'reader' ? pool[(rotation ?? dispatchCount(store, key)) % pool.length] : pool[0];

    return {
        key,
        item: {
            id: key,
            storyId: story.id,
            kind,
            templateRef: template.name,
            roleName: roleNameOf(template, roleKind),
            unit,
            ...extra
        },
        max_concurrent: maxConcurrentOf(template),
        why,
        priority
    };
}

/** The role NAME inside a template for a kind (U-7 shows it on the crew panel). */
function roleNameOf(template: Template, kind: RoleKind): string {
    return (template.roles ?? []).find((role) => role.kind === kind)?.name ?? kind;
}

// ---------------------------------------------------------------------------
// Phase ① — structure → research → sample → screen → deep review (§6.4)
// ---------------------------------------------------------------------------

/** The escalation title's stable opening — the reuse key, so a sweep never queues a second one. */
export const SAMPLING_FAILURE_PREFIX = 'Phase ① sampling failed after';

/**
 * The retry allowance on top of a round's sampling size (§6.4 step 3) — `records.ts` owns the
 * number because `./status` reads it too, and this module already imports that one. Re-exported
 * so a caller that reads the pipeline's caps from work generation finds it beside its siblings.
 */
export { SAMPLING_RETRY_ALLOWANCE };

/**
 * The four deep-review Reader angles (§14 item 10, D-30). The screening Reader is deliberately NOT
 * in this list: it is the one-turn, no-tool screening mode, and a deep-review pass that reused it
 * would rate the selected draft on a prompt that never opens with the whole book (T-11).
 */
export const DEEP_REVIEW_TEMPLATES = [
    'reader-genre',
    'reader-plausibility',
    'reader-audience',
    'reader-mystery'
] as const;

/**
 * Is the in-flight round out of retries with nothing to show? That is the one phase-① failure the
 * loop cannot work around: the provider is not returning valid `SummarySample` JSON, so no sample
 * exists, there is nothing to screen and nothing to select. The engine turns this into the Author's
 * escalation (`openSamplingFailureTask`); generation itself simply stops offering samples because
 * the retry cap is spent.
 */
export function samplingExhausted(store: Store, story: Story): boolean {
    if (story.phase !== 'summary') return false;

    const summaryRef = storySummary(store, story.id)?.id;

    if (summaryRef === undefined) return false;

    const round = samplingRoundOf(story);

    return (
        roundRevisions(store, story.id, round).length === 0 &&
        // The CURRENT WAVE's attempts: a re-armed wave starts at zero, which is exactly what makes
        // the Author's clear recover the round instead of re-opening the same escalation forever.
        sampleAttempts(store, summaryRef, round, samplingWaveOf(story)) >= samplingCapOf(story)
    );
}

/**
 * Queue (or re-find) the Author's escalation for an exhausted sampling round. Idempotent by title
 * prefix, so the sweep may call it every time the condition holds without stacking rows.
 *
 * The `detail` records the WAVE it was opened at (T12/E): `engine.ts:rearmSamplingWave` bumps
 * `stories.sampling_wave` when a cleared row's recorded wave still equals the Story's, so the
 * recorded-wave guard is what makes the bump happen once per cleared escalation rather than on
 * every sweep.
 */
export function openSamplingFailureTask(store: Store, story: Story): Task {
    const cap = samplingCapOf(story);
    const round = samplingRoundOf(story);
    const wave = samplingWaveOf(story);

    return openEscalationTask(store, story.id, {
        title: `${SAMPLING_FAILURE_PREFIX} ${cap} attempts — the provider is not returning valid SummarySample JSON`,
        detail: `round ${round} produced no Summary sample after ${cap} one-turn attempts (wave: ${wave}). Check the provider/model the sampler runs on, then clear this row (or change summary_sampling) and the sweep re-arms a fresh wave of samples (§6.4 step 3).`,
        reusePrefix: SAMPLING_FAILURE_PREFIX,
        why: `sampling round ${round} spent its retry allowance with no sample; the provider answer is the Author's to fix (§6.4 step 3)`
    });
}

/** The escalation title's stable opening for a partially screened round — the reuse key (T12/C). */
export const SCREENING_PARTIAL_PREFIX = 'Phase ① screening incomplete in round';

/**
 * Queue (or re-find) the Author's escalation for a round selected on a PARTIAL screening set
 * (T12/C).
 *
 * Why a row and not a silent degrade: the selection proceeded (the Story keeps moving instead of
 * dead-stalling), and the Author is the only one who can fix a provider that keeps returning invalid
 * `IssueList` JSON — so the round reports what it did rather than pretending the reviews were there.
 * `reusePrefix` names the ROUND, so each partially screened round raises its own single row and a
 * re-run of the same selection commit cannot stack a second one.
 */
export function openScreeningExhaustionTask(
    store: Store,
    story: Story,
    round: number,
    revisionIds: string[]
): Task {
    const cap = screeningCapOf(story);
    const readers = screeningSizeOf(story);

    return openEscalationTask(store, story.id, {
        title: `${SCREENING_PARTIAL_PREFIX} ${round} — selection proceeded with partial screening`,
        detail: `round ${round}: ${revisionIds.join(', ')} reached the ${cap}-attempt screening cap with ${readers}-or-fewer valid reviews each. Selection proceeded with the partial reviews (§6.5); the next round screens its own samples afresh (§6.4 step 4).`,
        reusePrefix: `${SCREENING_PARTIAL_PREFIX} ${round}`,
        why: `sampling round ${round} selected a sample whose screening was only partial; the provider answer is the Author's to fix (§6.4 step 4)`
    });
}

/**
 * Phase ①'s jobs, in the pipeline's own order (§6.4 steps 1-6):
 *
 *   1. `structure_seed` — priority 0, one per Seed hash. Refuses everything below it.
 *   2. `research`       — priority 0, one per accepted brief. Refuses sampling until it closes.
 *   3. `sample_unit`    — priority 2, ONE job per sweep: the next sample of the in-flight round.
 *   4. `screen_samples` — priority 2, one job per unaided screening pass of a drafted sample.
 *   5. deep review      — priority 2, `check_unit` WITH tools, one pass per Reader on the selected
 *                          revision of the round that just closed a selection.
 *
 * One job per family per sweep on purpose: the claim key carries the attempt counter, so the
 * generation is store-derived (L-2/L-3) and the capacity fill decides how many run in parallel —
 * a wider ceiling takes several, the rig's ceiling of 1 walks them one at a time.
 */
function phase1PipelineCandidates(store: Store, story: Story): WorkCandidate[] {
    const out: WorkCandidate[] = [];
    const summary = storySummary(store, story.id);
    const summaryRef = summary?.id ?? '';
    const brief = currentSeedBrief(store, story);
    const seedHash = seedHashOf(story.idea);

    // -- 1. Structure the Seed (§6.4 step 1, P5) --------------------------------------------------
    // One thread per Seed hash: an Author edit changes the hash, re-arms this job, and every later
    // stage waits for the new brief (`currentSeedBrief` counts a stale hash as none).
    if (brief === undefined) {
        const built = candidate(
            store,
            story,
            'structure_seed',
            'editor',
            undefined,
            `wi_structure_seed_${seedHash}`,
            'structure the Seed into a Seed Brief before phase ① expands it (P5, §6.4 step 1)',
            0,
            {
                // `extra` overrides the pool pick: the structuring pass has exactly ONE template
                // (D-17b's `serves_phase` keeps the phase-②/③ Writers out of this pool anyway).
                templateRef: 'editor-seed-structure',
                roleName: 'editor',
                note: 'Seed structure: read the Seed and call structureSeed with the structured brief — the Seed itself is never edited (P5). Put gaps in open_questions; never invent a fact.'
            }
        );

        if (built !== undefined) out.push(built);
    }

    // -- 2. Research the brief (§6.4 step 2) ------------------------------------------------------
    // The key names the brief's `rev`, so a re-structured brief re-arms the pass and the samples
    // wait for the new knowledge (a live research run does not count — `researchClosed`).
    if (brief !== undefined && !researchClosed(store, story, brief)) {
        const built = candidate(
            store,
            story,
            'research',
            'researcher',
            undefined,
            researchKeyOf(brief),
            `research the facts Seed Brief ${brief.id} depends on (§6.4 step 2)`,
            0,
            {
                templateRef: 'researcher-story',
                roleName: 'researcher',
                note: 'Research the facts this Seed Brief depends on and record them with writeKnowledge — one entry per claim, importance that means something, sources cited (T-10).'
            }
        );

        if (built !== undefined) out.push(built);
    }

    // No Summary row means there is nothing to sample into; phase ① opens one in `createStory`
    // (§4.2: one Summary per Story), so this is a defensive read rather than a real state.
    if (summaryRef === '') return out;

    const round = samplingRoundOf(story);
    const size = summarySamplingOf(story);
    const readers = summaryReadersOf(story);

    // -- 3. Sample (§6.4 step 3) ------------------------------------------------------------------
    // Gated on BOTH gates above, and on the round's arming rule: round 1 samples immediately after
    // research; round N+1 waits for the deep review to have defined the issues it must answer
    // (`records.ts:samplingArmed` — an open `fix` task and no unconfirmed blocking finding).
    if (brief !== undefined && researchClosed(store, story, brief) && samplingArmed(store, story, round)) {
        const have = roundRevisions(store, story.id, round).length;
        // T12/E: the claim family is WAVE-scoped, so a wave the Author's clear re-armed starts at
        // attempt 1 while the spent wave's run rows stay on the ledger as audit (P11). The prefix is
        // derived from `records.ts:samplePrefixOf` (minus its trailing `_`) so the two spellings of
        // the family cannot drift.
        const wave = samplingWaveOf(story);
        const prefix = samplePrefixOf(summaryRef, round, wave).slice(0, -1);
        const attempts = sampleAttempts(store, summaryRef, round, wave);
        // The trailing `_` anchors the FAMILY check: round 1's prefix is a prefix of round 10's key,
        // and a live sampler on round 10 must not look like one on round 1. The wave segment keeps
        // the same anchoring for waves (`_w1_` never prefixes `_w10_` because of the trailing `_`).
        const live = liveRuns(store, story.id).some((run) =>
            (run.work_item_ref ?? '').startsWith(samplePrefixOf(summaryRef, round, wave))
        );

        // The attempt counter (not the revision count) is what makes a FAILED sample retryable:
        // an invalid answer produces no row, so the next sweep buys the next claim key (N+3 cap).
        if (have < size && attempts < samplingCapOf(story) && !live) {
            const built = candidate(
                store,
                story,
                'sample_unit',
                'writer',
                { kind: 'summary', ref: summaryRef },
                claimKey(prefix, attempts + 1),
                `sample the Summary (round ${round}, sample ${have + 1} of ${size}) — one structured turn, no tools (§6.2a)`,
                2,
                {
                    toolMode: 'none',
                    responseSchema: { name: SUMMARY_SAMPLE_SCHEMA_NAME, schema: SummarySampleSchema },
                    // 1-based (§2): the transport sends it as the provider `seed`, which is the
                    // round's ONLY diversity knob (§5 — no temperature, byte-identical prompt).
                    sampleIndex: have + 1,
                    round,
                    templateRef: 'writer-summary-sampler',
                    roleName: 'writer'
                }
            );

            if (built !== undefined) out.push(built);
        }
    }

    // -- 4. Screen the samples (§6.4 step 4) ------------------------------------------------------
    // A sample is screenable the moment the engine persisted it (`drafted`); the pipeline is
    // per-draft, so the screens of sample 1 do not wait for sample 3. The claim key names the
    // REVISION, which is how each draft's passes stay independent across a restart.
    for (const revision of summaryRevisions(store, story.id)) {
        if (revision.state !== 'drafted') continue;

        const prefix = `wi_screen_${revision.id}`;
        const screens = screensFor(store, revision.id);
        const attempts = screenAttempts(store, revision.id);
        // Anchored with `_` for the same reason as the sampling family (revision_1 vs revision_10).
        const live = liveRuns(store, story.id).some((run) =>
            (run.work_item_ref ?? '').startsWith(screenPrefixOf(revision.id))
        );

        // `screens.length` counts VALID answers only (a failed screen persists no review), so the
        // attempt cap is the safety net that keeps a broken provider from buying a run per sweep
        // forever. It is the sample cap's shape (§6.4 step 3), applied to the cheaper pass, and it is
        // read from `records.ts:screeningCapOf` so the dispatch gate and the selection gate
        // (`engine.ts:trySelectSample`, T12/C) measure the same exhaustion.
        if (screens.length >= readers || attempts >= screeningCapOf(story) || live) continue;

        const built = candidate(
            store,
            story,
            'screen_samples',
            'reader',
            { kind: 'summary', ref: revision.unit_ref },
            claimKey(prefix, attempts + 1),
            `screen draft ${revision.id} (pass ${screens.length + 1} of ${readers}) — one structured turn, no tools (§6.4 step 4)`,
            2,
            {
                toolMode: 'none',
                responseSchema: { name: ISSUE_LIST_SCHEMA_NAME, schema: IssueListSchema },
                revisionRef: revision.id,
                templateRef: 'reader-screening',
                roleName: 'reader'
            }
        );

        if (built !== undefined) out.push(built);
    }

    // -- 5. Deep review (§6.4 step 6) -------------------------------------------------------------
    // The selected revision of the round whose selection just completed gets the real review: a
    // Reader WITH the tool catalogue, one pass per angle. `wi_review_` is a fresh family, so the
    // screening passes (no tools) and the review passes (tools) can never be confused in the ledger.
    const selected = selectedSummaryRevision(store, story.id);

    if (selected !== undefined && (selected.round ?? 1) === (story.sampling_round ?? 1)) {
        for (let pass = 1; pass <= readers; pass += 1) {
            const key = deepReviewKeyOf(selected.id, pass);

            if (runsForItem(store, key).length > 0) continue;

            const template = DEEP_REVIEW_TEMPLATES[(pass - 1) % DEEP_REVIEW_TEMPLATES.length];

            const built = candidate(
                store,
                story,
                'check_unit',
                'reader',
                { kind: 'summary', ref: selected.unit_ref },
                key,
                `Reader ${pass}/${readers} reviews the selected Summary revision ${selected.id} against the Seed (phase ① deep review)`,
                2,
                {
                    // The one deep-review job that KEEPS its tools (D-26/D-30): the run may read the
                    // Summary, the Seed and the Knowledge to check a specific doubt.
                    revisionRef: selected.id,
                    templateRef: template,
                    roleName: 'reader',
                    note: `Reader pass ${pass} of ${readers} on the selected Summary draft ${selected.id}. The draft and the Seed are in the brief; call readSummary only if the brief does not carry the draft. Use tools to check a specific doubt — not to survey the book — and for a factual point one citable source is enough. File the critical and major issues with raiseFinding on ${selected.unit_ref}: detail (what is wrong and where), criterion, quoted passage, evidence line, and the cost you believe; name ${selected.id} in related_refs so the dashboard files each finding under this Overview. Rate the draft with submitVerdict against ${selected.unit_ref}, and never edit the book (D-26, D-30, T-9). Do not propose Ideas. Minor/taste notes are optional and must not keep you searching; once the issues that matter are reported, stop — an empty pass is valid.`
                },
                pass - 1
            );

            if (built !== undefined) out.push(built);
        }
    }

    return out;
}

/**
 * The jobs one Story is entitled to run this sweep, in dispatch-priority order.
 *
 * Priorities are the spec's own urgency, not a tuning knob: an Editor choosing between drafts is
 * first (L-20 blocks the phase until it happens), then the Editor's verification of a suspicion
 * (D-33: an unverified finding is work, and it is cheap), then fix work a decision unblocked (D-34),
 * then drafts (the expensive, divergent work), then the whole-Story pass, then the drain probe.
 */
export function generateWork(store: Store, story: Story, ctx: { at: string; phase: StoryPhase }): WorkCandidate[] {
    const out: WorkCandidate[] = [];
    const units = phaseUnits(store, story);

    // -- The Author's directive, before everything else -------------------------------------------
    // The Author's one channel is the Editor (V-1): a propagating directive is a job for the Editor,
    // whose review turns it into queued tasks. THIS is the boundary that is not a delegate — the
    // Editor queues Work for the loop, and the loop opens a fresh thread per task (S-1), rather than
    // the Editor fanning out to Writers inside its own run.
    for (const directive of pendingDirectives(store, story.id)) {
        const built = candidate(
            store,
            story,
            'directive_work',
            'editor',
            undefined,
            `wi_directive_${directive.id}`,
            `read the Author's directive ${directive.id} and set the tasks it implies (D-19)`,
            0,
            { directiveRef: directive.id }
        );

        if (built) out.push(built);
    }

    // -- Phase ①: structure → research → sample → screen → deep review (§6.4) ---------------------
    // Two priority-0 gates (the Editor's structuring, then the Researcher's pass) and the pipeline's
    // own work at priority 2 — a sample IS the draft in this pipeline, so it belongs in the same
    // urgency class as phases ②/③'s `write_unit`.
    if (story.phase === 'summary') out.push(...phase1PipelineCandidates(store, story));

    // -- Editors first: the choice (L-20) and the verification (D-33, D-27) -----------------------
    const templateAttempts = attemptsOf(templatesFor(store, story, 'writer')[0]);
    // Phase ① has no classic divergence set any more: its samples are the pipeline jobs above, and
    // its round is numbered by `story.sampling_round` rather than by a `wi_write_*` generation.
    const writerAttempts = templateAttempts;
    // Every unconfirmed finding is Editor work; only critical/major ones may HOLD the choice.
    const unconfirmed = unconfirmedFindings(store, story.id);

    for (const unit of units) {
        // PHASE ① HAS NO EDITOR CHOICE. The selector is deterministic (§6.5: fewest critical, then
        // fewest high, then total, then the earliest sample) and runs in the engine's settlement, so
        // offering a `select` run would be a model asked to make a choice the design removed (P6).
        if (story.phase === 'summary') continue;

        // An open merge request is the Editor's answer for this unit. Re-asking for a selection
        // while the Writer has not composed the merged text is the exact loop the old surface got
        // stuck in: every sweep bought another Editor run that requested the same merge.
        const mergeQueued =
            unit.ref !== '' &&
            dispatchableTasks(store, story.id).some(
                (task) =>
                    task.kind === 'merge' &&
                    (task.detail?.includes(unit.ref) === true || task.title.includes(unit.ref))
            );

        if (mergeQueued) continue;

        if (needsEditor(store, story, unit.ref, divergenceGap(store, story, unit.ref, writerAttempts))) {
            const generation = dispatchCountFor(store, 'wi_select_', unit.ref) + 1;
            const built = candidate(
                store,
                story,
                'select',
                'editor',
                unit.ref === '' ? wholeStoryUnit(ctx.phase) : { kind: unit.kind, ref: unit.ref },
                claimKey('wi_select', generation, unit.ref),
                `choose between the competing drafts of ${label(unit)} (L-17, D-22)`,
                1
            );

            if (built) out.push(built);
        }
    }

    // D-33/D-38: one Editor thread PER finding. A batch of findings made the Editor's brief (and
    // its reply) grow with every Reader report, which is where a 1M-token thread came from; a
    // single finding per Work Item keeps each thread small and its decision auditable.
    for (const finding of unconfirmed) {
        const prefix = `wi_verify_finding_${finding.id}`;
        const generation = dispatchCount(store, prefix) + 1;
        const unit =
            ctx.phase === 'summary'
                ? finding.target_ref === story.id
                    ? wholeStoryUnit(ctx.phase)
                    : { kind: 'summary' as UnitKind, ref: finding.target_ref }
                : wholeStoryUnit(ctx.phase);
        const built = candidate(
            store,
            story,
            'verify_findings',
            'editor',
            unit,
            claimKey(prefix, generation),
            `verify finding ${finding.id} and approve it when it holds (D-33)`,
            1,
            {
                findingRefs: [finding.id],
                note: `Verify finding ${finding.id} only. Confirm it when the defect is real, approve it in the same run, and dispute it when it is not — no other finding belongs to this thread.`
            }
        );

        if (built) out.push(built);
    }

    // Phase ①'s independent second look. The Editor's verify/approval is not enough to spend a
    // Writer round: one Reader thread re-checks each confirmed or approved finding and calls
    const verifiable = ideasToVerify(store, story.id, story.phase);

    if (verifiable.length > 0) {
        const ids = verifiable.map((idea) => idea.id);
        const generation = dispatchCount(store, 'wi_verify_ideas') + 1;
        const built = candidate(
            store,
            story,
            'verify_ideas',
            'editor',
            wholeStoryUnit(ctx.phase),
            claimKey('wi_verify_ideas', generation, `${ids.length}_${ids[0]}`),
            `${ids.length} sourced Idea${ids.length === 1 ? '' : 's'} must be verified before the Author can pick (D-27, C-15)`,
            1,
            { ideaRefs: ids }
        );

        if (built) out.push(built);
    }

    // -- Checkers: every competing draft, then any unit whose newest draft is unjudged -------------
    for (const unit of units) {
        // Phase ①'s review crew is the Readers above; a consistency checker here would be a
        // third opinion between the Reader and the Editor, which is not the loop the Author set.
        if (story.phase === 'summary') continue;

        // A unit mid-divergence is not worth judging yet: the Editor judges the SET of attempts together
        // (§6.2a's loop B), so a checker bought for draft 1 of 3 would be re-bought after every sibling
        // and would starve the drafts that are still owed (they rank below the checker's priority).
        if (divergenceGap(store, story, unit.ref, writerAttempts) > 0) continue;

        if (!needsChecker(store, story, unit.ref)) continue;

        // `unitIsChecked` accepts either verdict convention — per-draft verdicts, or unit-level verdicts
        // covering the count, which is what §8.3's `submitVerdict` actually writes because its
        // `target_ref` is the unit. Reading only the per-draft convention here would re-buy the same
        // checker pass on every sweep for a unit the Editor already has enough to choose between.
        if (unitIsChecked(store, story.id, unit.ref)) continue;

        const competing = competingRevisions(store, story.id, unit.ref);
        const unchecked = competing.filter((revision) => verdictsTargeting(store, story.id, revision.id).length === 0);

        // D-22's "the Editor chooses between drafts that have each been read" needs a rotation, not a
        // fixed order. Two facts force it: the capacity ceiling hands the sweep one launch at a time
        // (`globalMaxConcurrent`, and the rig runs 1), and §8.3's `submitVerdict` files its verdict
        // against the UNIT because `target_ref` is the unit (brief.ts / tools/editor.ts) — so no draft is
        // ever recorded as "already read", and the first competing draft wins every sweep. Measured: with
        // `attempts: 3`, three checker passes ran and all three were aimed at `revision_1`, while
        // `revision_2` and `revision_3` sat deferred and unread. Rotating by the generation (which is the
        // dispatch count, so this stays store-derived and survives a restart, L-3) puts each owed draft
        // first exactly once per cycle, and the siblings stay in the list for a higher ceiling to take.
        //
        // The rotation runs over the FULL `competing` list and the already-judged drafts are filtered out
        // AFTERWARDS. Rotating the shrinking `unchecked` list instead re-bases the cycle every sweep — the
        // generation says "lead with draft 2", draft 1 is already gone, so draft 2 lands on `revision_3`'s
        // slot and the offer order goes 1, 3, 2 rather than the spec's 1, 2, 3 (§6.2a). Filtering after
        // keeps the cycle anchored to the drafts the unit actually has, which is what D-22's "each draft
        // read once per cycle" reads as.
        const prefix = `wi_check_${unit.ref}`;
        const generation = dispatchCount(store, prefix) + 1;
        const rotated = competing.length > 0 ? rotateByGeneration(competing, generation) : [];
        const targets = rotated.length > 0 ? rotated.filter((revision) => unchecked.includes(revision)) : [undefined];

        for (const [index, revision] of targets.entries()) {
            const built = candidate(
                store,
                story,
                'check_unit',
                'checker',
                unit.ref === '' ? wholeStoryUnit(ctx.phase) : { kind: unit.kind, ref: unit.ref },
                claimKey(prefix, generation, revision?.id ?? 'unit'),
                revision === undefined
                    ? `judge ${label(unit)} against the phase Goal (P4)`
                    : `judge draft ${revision.id} of ${label(unit)} (§6.2a: verdicts per revision)`,
                2,
                // The checker brief renders the UNIT, not a competing draft (brief.ts:672 shows draft
                // bodies for `select`/`merge` only), so the draft this run is told to judge is named
                // in the job line the sweep writes. `listRevisions` is in every session's catalogue
                // (§8.2), which is how a checker reads the draft itself when the brief does not carry
                // it. This is the one place the loop reaches around the brief, and it is a tool-layer
                // gap worth reporting rather than a loop bug.
                revision === undefined
                    ? {}
                    : {
                          note: `This run judges draft ${revision.id} of ${unit.ref}; read it with \`listRevisions\` and file your verdict against it.`
                      }
            );

            if (built !== undefined) {
                // The rotation only takes effect where the dispatcher can see it: its tie-break is the
                // claim key, which sorts `revision_1` first for as long as that row exists. `rank` is the
                // order WITHIN the priority class, so the draft this generation owes goes first and its
                // siblings wait their turn instead of being deferred forever.
                built.rank = index;

                out.push(built);
            }
        }
    }

    // -- Writers: the work a decision unblocked (phases ②/③; phase ① has no `write_unit`) --------
    // Phase ①'s approved findings are answered by a NEW SAMPLING ROUND, not by a hand-fix pass: the
    // open `fix` task is compiled into the round's prompt and consumed by its selection (§6.8), so a
    // `wi_fix_*` job here would be the classic pipeline's shape sneaking back in.
    const fixJobs = story.phase === 'summary' ? [] : fixWork(store, story, ctx.phase);

    for (const job of fixJobs) {
        const built = candidate(
            store,
            story,
            'write_unit',
            'writer',
            job.unit === '' ? wholeStoryUnit(ctx.phase) : { kind: job.kind, ref: job.unit },
            job.key,
            job.why,
            job.priority,
            { taskRefs: job.taskRefs, findingRefs: job.findingRefs }
        );

        if (built) out.push(built);
    }

    for (const unit of units) {
        // PHASE ① HAS NO `write_unit` (documents/phase-1-research-pipeline.md §6.4): the Writer's
        // only phase-① job is `sample_unit`, one structured turn with no tools, and a redraft is a
        // new SAMPLING ROUND armed by the open `fix` tasks — not a tool-writing fix pass. Phases
        // ②/③ keep the classic writer below unchanged.
        if (story.phase === 'summary') continue;

        // A unit with an explicit fix job already has its Writer: the `wi_fix_*` Work Item clears
        // the approved findings/task, and the generic draft would be a second Writer racing it on
        // the same artifact (T-4's compare-and-swap is not a scheduling mechanism).
        if (fixJobs.some((job) => job.unit === unit.ref)) continue;

        if (unitIsBusy(store, story.id, unit.ref)) continue;

        // D-17d/D-38a: the divergence count is the AUTHOR's setting on the assigned Writer template,
        // never an engine constant. A fix pass gets ONE draft (the work is a correction, not an
        // exploration), and a first pass gets the template's `attempts`.
        const owing = divergenceGap(store, story, unit.ref, writerAttempts);
        const trigger = writeTrigger(store, story, unit.ref, unit.chapter, owing);

        if (trigger === undefined) continue;

        // D-17d/D-38a: an ordinary fix pass is a correction, not an exploration, so it gets ONE draft.
        const attempts = trigger.trigger === WRITE_TRIGGERS.task ? 1 : writerAttempts;
        const prefix = `wi_write_${unit.ref}`;
        const generation = divergenceGeneration(store, unit.ref);

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            const key = claimKey(prefix, generation, `a${attempt}`);

            // Each sibling runs exactly once per pass: unlike every other job kind, "is it still needed?"
            // cannot be answered from the artifact (a blind draft changes nothing the next one can see,
            // which is the point of L-16), so the run row is the only honest record of the sibling.
            if (runsForItem(store, key).length > 0) continue;

            const built = candidate(
                store,
                story,
                'write_unit',
                'writer',
                unit.ref === '' ? wholeStoryUnit(ctx.phase) : { kind: unit.kind, ref: unit.ref },
                key,
                `${trigger.trigger}: draft ${label(unit)} (attempt ${attempt} of ${attempts}, blind to the others — L-16)`,
                3,
                {
                    // L-16: the drafts must not see each other, so the note names the divergence and
                    // nothing else. L-18's re-brief line and D-29's selected Ideas come from the store
                    // (the brief renders them), not from here.
                    note:
                        attempts > 1
                            ? `Divergent draft ${attempt}/${attempts} of ${label(unit)}: no other draft is visible to you (L-16, P13).`
                            : `Draft ${label(unit)}.`,
                    ...(trigger.tasks.length > 0 ? { taskRefs: trigger.tasks.map((task) => task.id) } : {})
                }
            );

            if (built) out.push(built);
        }
    }

    // -- The whole-Story pass, and the drain probe ------------------------------------------------
    const whole = wholeStoryCandidate(store, story, ctx.phase);

    if (whole !== undefined) out.push(whole);

    // L-37's probe round is a FULL pass over the Story, and L-36 says a wait only begins "when nothing
    // else is dispatchable". So the probe is generated last and only over an empty list: a round that ran
    // alongside a draft or a verification would be reading a Story that is still changing, which is how a
    // loop reports `drained` while its queue is full.
    const probe = probeCandidates(store, story, ctx.phase, out.length);

    out.push(...probe);

    // §9's order is the dispatch order; the priority field keeps it stable across the capacity fill.
    return out.sort((left, right) => left.priority - right.priority || left.key.localeCompare(right.key));
}

/** A unit is one artifact the loop can draft/judge; `ref === ''` is the whole-Story artifact. */
interface UnitView {
    kind: UnitKind;
    ref: string;
    label: string;
    chapter?: Chapter;
}

function label(unit: UnitView): string {
    return unit.ref === '' ? 'the whole-Story artifact' : `${unit.kind} ${unit.ref}`;
}

/**
 * The units the current phase works on together.
 *
 * Phase ① is one unit (the Summary draft, D-3d). Phase ② is the plotline SET while it does not exist
 * yet, and one unit per plotline afterwards — but never a per-plotline draft while the count is wrong,
 * because C-0 says the set is the artifact the Author's count binds (D-3b, L-6a). Phase ③ is every
 * chapter at once (L-8: the whole chapter set is in flight together, not one at a time).
 */
function phaseUnits(store: Store, story: Story): UnitView[] {
    if (story.phase === 'summary') {
        const summary = storySummary(store, story.id);

        return [{ kind: 'summary', ref: summary?.id ?? '', label: 'the Summary draft' }];
    }

    if (story.phase === 'plotlines') {
        const plotlines = storyPlotlines(store, story.id);
        const count = storySummary(store, story.id)?.chapter_count;

        if (plotlines.length === 0 || (count !== undefined && plotlines.length !== count)) {
            return [{ kind: 'plotline', ref: '', label: 'the plotline set' }];
        }

        return plotlines.map((plotline) => ({
            kind: 'plotline',
            ref: plotline.id,
            label: `plotline ${plotline.order}`
        }));
    }

    return storyChapters(store, story.id).map((chapter) => ({
        kind: 'chapter',
        ref: chapter.id,
        label: `chapter ${chapter.order}`,
        chapter
    }));
}

/**
 * The fix work a decision unblocked (D-34: the approval is what creates the task, and the task is what
 * dispatches the Writer).
 *
 * Grouping is per unit, not per finding: two confirmed findings on chapter 6 are one Writer pass with
 * two refs, because two runs on one artifact would race each other's compare-and-swap (T-4) and P13's
 * divergence is not meant to be two fixes pretending to be drafts.
 */
function fixWork(
    store: Store,
    story: Story,
    phase: StoryPhase
): {
    key: string;
    unit: string;
    kind: UnitKind;
    why: string;
    priority: number;
    taskRefs: string[];
    findingRefs: string[];
}[] {
    const byUnit = new Map<
        string,
        { findings: string[]; tasks: string[]; taskKinds: Set<string>; kind: UnitKind }
    >();
    const add = (unit: string, kind: UnitKind, findingId: string, taskId: string, taskKind?: string) => {
        const held = byUnit.get(unit) ?? {
            findings: [] as string[],
            tasks: [] as string[],
            taskKinds: new Set<string>(),
            kind
        };

        if (!held.findings.includes(findingId)) held.findings.push(findingId);
        if (!held.tasks.includes(taskId)) held.tasks.push(taskId);
        if (taskKind !== undefined) held.taskKinds.add(taskKind);
        byUnit.set(unit, held);
    };

    for (const finding of actionableFindings(store, story)) {
        // Phase ① never reaches this function any more (its Writer work is `sample_unit`, and the
        // deep review's findings arm a ROUND rather than a `wi_fix_*` pass), so the classic
        // `reader_confirmed` wait is gone with the per-finding confirmation thread (§6.4 step 6).
        const task = openTasks(store, story.id).find((row) => row.finding_ref === finding.id);

        // A whole-book defect is filed against the STORY row, because that is what the whole-level
        // criteria are scoped to (criteria/engine.ts:scopeTargets). A Writer cannot edit "the story", so
        // the fix is aimed at the artifacts the finding NAMES — D-11's multi-target and L-11a's "fix the
        // side the plotline says is wrong". With no artifact named there is no writer work to hand out:
        // the loop cannot localise the defect, and per T-12 that is the Author's call, not a run whose
        // brief it has to improvise. Those tasks are created `blocked` by the engine
        // (`createWorkForFinding`), so they never show up here.
        const units =
            finding.target_ref === story.id
                ? findingRefs(finding).filter((ref) => ref !== story.id && ref.length > 0)
                : [finding.target_ref];

        for (const unit of units) add(unit, unitKindOf(unit), finding.id, task?.id ?? '', 'fix');
    }

    // The queue's own merge requests (L-19: the Editor names the parts, the Writer composes).
    for (const task of dispatchableTasks(store, story.id)) {
        if (task.kind !== 'merge' && task.kind !== 'rewrite' && task.kind !== 'absorb' && task.kind !== 'directive')
            continue;

        const unit = unitRefInTask(task);

        if (unit === '') continue;

        add(unit, unitKindOf(unit), '', task.id, task.kind);
    }

    const jobs: {
        key: string;
        unit: string;
        kind: UnitKind;
        why: string;
        priority: number;
        taskRefs: string[];
        findingRefs: string[];
    }[] = [];

    for (const [unit, held] of [...byUnit.entries()].sort()) {
        if (unit === '' || unit === story.id) continue;

        const competing = competingRevisions(store, story.id, unit).length;
        const hasMerge = held.taskKinds.has('merge');

        // A unit mid-decision is not ready for a fix pass: the Editor's choice comes first (L-20).
        // The one exception is a merge the Editor already asked for — that request IS the choice, and
        // refusing to run it is what turned a valid merge brief into a select/skip loop. The merge
        // Writer composes one text; the drafts stay in place until a later selection.
        if (competing > 0 && !hasMerge) continue;

        const prefix = `wi_fix_${unit}`;
        const isSummary = held.kind === 'summary';
        // Every Summary round is `summary_sampling` complete drafts, not one patch. A merge is the
        // one exception: the Editor named one text, so one Writer composes it.
        const attempts = isSummary && !hasMerge ? summarySamplingOf(story) : 1;
        const runs = dispatchCount(store, prefix);
        // Count ROUNDS, not runs, so three attempts share one generation and the next round gets
        // the next generation. At one attempt this is the old `dispatchCount + 1` exactly.
        const generation = isSummary ? Math.floor(runs / attempts) + 1 : runs + 1;
        const suffix = `${last(held.findings) ?? 'task'}_${last(held.tasks) ?? 'none'}`;

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            jobs.push({
                key:
                    attempts === 1
                        ? claimKey(prefix, generation, suffix)
                        : `${claimKey(prefix, generation, suffix)}_a${attempt}`,
                unit,
                kind: held.kind,
                why: `${held.findings.length > 0 ? `fix ${held.findings.length} approved finding${held.findings.length === 1 ? '' : 's'}` : hasMerge ? 'run the Editor\'s merge request' : 'clear a queued task'} on ${unit} (D-34, D-11)`,
                // D-35's dial put these here, so a fix a decision unblocked outranks a fresh draft.
                priority: 2,
                taskRefs: held.tasks.filter((id) => id.length > 0),
                findingRefs: held.findings
            });
        }
    }

    return jobs;
}

/** Which artifact a ref names — the phase-independent way to answer, since refs are record ids. */
function unitKindOf(ref: string): UnitKind {
    return ref.startsWith('plot') ? 'plotline' : ref.startsWith('summ') ? 'summary' : 'chapter';
}

/** The unit a queue task names, out of the refs the loop writes into `title`/`detail`. */
function unitRefInTask(task: Task): string {
    const text = `${task.title} ${task.detail ?? ''}`;

    for (const ref of [task.finding_ref, ...(task.detail ? [task.detail] : []), ...text.split(/\s+/)]) {
        // The ids are minted from the collection singulars: `chapter_1`, `plotline_1`,
        // `summary_1`. The old `chap|plot|summ` prefixes never matched a real ref, which is why
        // a merge/rewrite task could sit open forever while the sweep kept asking the Editor.
        if (typeof ref === 'string' && /^(chapter|plotline|summary)_[A-Za-z0-9_]+$/.test(ref)) return ref;
    }

    return '';
}

/**
 * The whole-Story checker (§6.2's C-10/C-11/C-13 level, §5.2's `whole` level).
 *
 * It runs only once every chapter has been judged, because pacing and promise-payment are
 * unanswerable against a half-written book — and because an early whole-Story pass would file findings
 * about chapters that have not been drafted yet (E-1: the pass reads the Digest, not every chapter's
 * prose, and a Digest of a partial book misleads it).
 */
function wholeStoryCandidate(store: Store, story: Story, phase: StoryPhase): WorkCandidate | undefined {
    if (phase !== 'chapters') return undefined;

    const chapters = storyChapters(store, story.id);

    if (chapters.length === 0) return undefined;

    const unjudged = chapters.filter((chapter) => verdictsTargeting(store, story.id, chapter.id).length === 0);

    if (unjudged.length > 0) return undefined;

    // The pass is per chapter-set revision: a new chapter state re-arms it, and its own claim key keeps
    // it to one run at a time (L-2).
    const signature = chapters.map((chapter) => `${chapter.id}:${chapter.round}:${chapter.state}`).join('|');
    const prefix = 'wi_whole_check';
    const generation = dispatchCount(store, prefix) + 1;

    // Cheap idempotence: skip when the newest whole-Story verdict post-dates every chapter verdict.
    // Only the pass's OWN verdicts count (records.ts:wholeStoryVerdicts) — a per-unit checker also
    // files a Story-targeted line, and reading that as the pass would either stop it forever or, once
    // the Story row passes nine verdicts, let it re-arm on every sweep (ids collate `verdict_8` above
    // `verdict_9`, so the comparison goes through the journal: records.ts:createdAfter).
    const passVerdicts = wholeStoryVerdicts(store, story.id);
    const chapterVerdicts = chapters.flatMap((chapter) => verdictsTargeting(store, story.id, chapter.id));
    const newestPass = last(passVerdicts);
    const newestChapter = last(chapterVerdicts);

    if (newestPass !== undefined && (newestChapter === undefined || createdAfter(store, newestPass, newestChapter)))
        return undefined;

    return candidate(
        store,
        story,
        'whole_story_check',
        'checker',
        { kind: 'chapter', ref: story.id },
        claimKey(prefix, generation, signature.slice(0, 40)),
        `judge the whole Story at the chapters→whole level once every chapter has been judged (§5.2, C-10/C-11/C-13)`,
        3
    );
}

/**
 * The drain probe's two jobs (L-37's condition 3, D-35b): one Reader round and one checker pass, and
 * nothing else — the round exists to answer "is there anything left at the threshold?", so spawning
 * drafts alongside it would put work in flight that the round is meant to rule out.
 *
 * It only starts when conditions 1, 2 and 4 already hold (L-37's "on a single full pass"), because
 * otherwise the round would be judging a Story that still has queued work, which is how a loop reports
 * `drained` while its queue is full.
 */
function probeCandidates(
    store: Store,
    story: Story,
    phase: StoryPhase,
    dispatchableElsewhere: number
): WorkCandidate[] {
    const loop = story as import('./types').LoopStory;

    // A round that has STARTED must finish. L-37's condition 3 is one Reader round PLUS one checker
    // pass, and the second half is still owed when the first half came back with something: the
    // checker filing a finding breaks the preconditions (an unconfirmed finding is work), and a gate
    // applied to FINISHING a round would leave it `running` forever — which reads as "the round is
    // still in flight", so the Story never drains and never stalls. The gates below decide whether a
    // round may START (L-37's "single full pass" over a Story with nothing queued), never whether it
    // may close.
    const started = loop.probe !== undefined && loop.probe.status === 'running' && loop.probe.phase === phase;

    if (!started) {
        if (!drainPreconditions(store, story).met) return [];

        // L-36/L-37: the round only means something over a Story with nothing else to do. The caller
        // hands in how many jobs it had already found, so the probe never races a draft or a
        // verification.
        if (dispatchableElsewhere > 0) return [];
    }

    if (probeIsLive(story, phase, dialKeyOf(story), true)) return [];

    // A round already in flight still has work to hand out: capacity 1 means the sweep dispatches one
    // job per sweep, so the Reader must survive the sweep that started the Checker. What must NOT
    // happen is the same job offered twice, so a probe job is offered only while it has never run —
    // unlike every other job kind, its "is it still needed?" answer cannot come from the artifact state,
    // because a clean round deliberately changes nothing (L-37). `round` only moves at the boundary
    // where the round is judged, so the pair is exactly one Reader round plus one Checker pass.
    const round = (loop.round ?? 0) + 1;
    const out: WorkCandidate[] = [];

    // THE PAIR'S CLAIM KEYS. Each half counts its OWN prefix (`wi_probe_reader_chapters_1`, `_2`, …),
    // and while a round is running the half already recorded on `ProbeState` keeps its id. The counter
    // is deliberately NOT `story.round`: L-15's round counter also moves on work cycles that are not
    // probe rounds (see engine.ts), and a key that moved mid-round would orphan the id the round was
    // stored with — which is exactly what L-37.3 reads to decide when a round is over.
    const next = (kind: 'reader' | 'checker') =>
        `wi_probe_${kind}_${phase}_${dispatchCount(store, `wi_probe_${kind}_${phase}`) + 1}`;
    const keys = {
        reader: (started ? loop.probe?.reader_item_id : null) ?? next('reader'),
        checker: (started ? loop.probe?.checker_item_id : null) ?? next('checker')
    };

    const reader = candidate(
        store,
        story,
        'write_unit',
        'reader',
        phase === 'chapters' ? undefined : wholeStoryUnit(phase),
        keys.reader,
        `fresh reading round ${round}: propose what is still wrong at the dial threshold (L-37, D-30)`,
        4,
        {
            note: `Drain probe round ${round}: read for anything at or above the Story's dial (${dialPhraseOf(story)}), and file it — an empty round is what ends this phase's work (L-37).`
        }
    );

    const checker = candidate(
        store,
        story,
        'check_unit',
        'checker',
        phase === 'chapters' ? undefined : wholeStoryUnit(phase),
        keys.checker,
        `drain probe round ${round}: one consistency pass at the dial threshold (L-37, D-35b)`,
        4,
        {
            note: `Drain probe round ${round}: judge the artifact against the phase Goal and file findings; nothing at or above ${dialPhraseOf(story)} means the round is clean.`
        }
    );

    // `candidate` returns undefined when the role's template cannot be resolved (a Story assigned a
    // reader template that no longer exists), and the round must not be recorded against a job that can
    // never run — that is how a probe would hang `running` forever (L-37.3).
    if (reader !== undefined && runsForItem(store, keys.reader).length === 0) out.push(reader);
    if (checker !== undefined && runsForItem(store, keys.checker).length === 0) out.push(checker);

    return out;
}

const dialPhraseOf = (story: Story): string => dialKeyOf(story).join('/') || 'nothing';
