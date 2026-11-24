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
    findingRevisionScope,
    FINDING_VERIFY_CAP,
    ideasToVerify,
    isClaimed,
    isDeepReviewSelection,
    isFindingVerifyExhausted,
    isFullyScreened,
    isLiveRun,
    isSupersededSummaryDraft,
    last,
    liveRuns,
    maxConcurrentOf,
    openEscalationTask,
    openFixTaskIds,
    // T-10 / the G-9 fix: the phase-① queue's third fix owner. These reads answer "which open `fix`
    // rows does a RESEARCHER own, how many grounding passes has it spent, is that budget gone, has
    // anything been recorded about it, and what has the crew actually recorded" — all journal-derived,
    // so they survive a server restart the same way the sampling cap does.
    isWriterActionableFix,
    openPrerequisiteFixTasks,
    openResearchFixPrerequisites,
    openUnserviceableFixTasks,
    RESEARCH_PREREQUISITE_CAP,
    researchPrerequisiteAnswered,
    researchPrerequisiteAttempts,
    researchPrerequisiteEvidence,
    researchPrerequisiteExhausted,
    researchPrerequisiteKeyOf,
    researchPrerequisiteLive,
    stalledResearchPrerequisites,
    openTasks,
    // H1: the queue has to ask the sweep's "is this round still gathering evidence?" question, and a
    // second copy of the run-family pattern is how two call sites start disagreeing.
    PHASE1_PIPELINE_RUN,
    researchGate,
    researchKeyOf,
    researchQuestionsOf,
    roundHasEligibleCandidate,
    roundRevisions,
    roundRequiresCertification,
    roundSampleScores,
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
    summaryRevisionRounds,
    // SUMMARY PHRASE R3: the fix rows one finding armed. The batch hands its tasks to the settlement
    // through `WorkItem.taskRefs`, and `engine.ts:settleJob` consumes them only when the finding they
    // name is resolved in every group it targets.
    tasksForFinding,
    templatesFor,
    unconfirmedBlockingFindings,
    unconfirmedFindings,
    unitIsChecked,
    verifyFindingAttempts,
    verdictsTargeting,
    wholeStoryVerdicts
} from './records';
import { pendingDirectives } from './directives';
import { dialKeyOf, drainPreconditions, probeIsLive } from './status';
import type { WorkCandidate } from './types';
import {
    type RoleKind,
    type SeedBrief,
    type StoryPhase,
    type Story,
    type Finding,
    type PhraseGroup,
    type Task,
    type Template,
    type UnitKind,
    type Chapter
} from '../../shared/types';
import {
    GROUP_DRAFT_SCHEMA_NAME,
    GroupDraftSchema,
    GROUP_REVIEW_SCHEMA_NAME,
    GroupReviewSchema,
    ISSUE_LIST_SCHEMA_NAME,
    IssueListSchema,
    SUMMARY_SAMPLE_SCHEMA_NAME,
    SummarySampleSchema
} from '../../shared/schemas';
// SUMMARY PHRASE (R1-R5) — the group domain, imported from its ONE surface (`../phrase/index`).
// `isGroupManagedStory` is the switch (`story.summary_mode`, NOT the presence of rows),
// `phraseGroupsOf`/`storyPhrase` are the book's catalog rows, `findingGroupsStillOwed` routes an
// open finding into the groups it still needs rewritten (R3), `partitionGroups` is R4's deferral, and
// the vector hash is what makes a review pass re-arm on an install rather than on a clock.
import {
    allReviewSeatsRun,
    findingGroupsStillOwed,
    GROUP_DRAFT_ITEM_PREFIX,
    // HARDENING: the write allowance, the target set and the seat read now live in
    // `phrase/exclusion.ts` (the one home for the group pipeline's READS), because `status.ts` needs
    // them too and cannot import `work.ts` back — `work.ts` already imports `status.ts`. F1's rule is
    // unchanged: the allowance counts exactly the runs `isGroupHoldingRun` accepts and no others.
    GROUP_WRITE_ATTEMPT_CAP,
    groupWorkTargets,
    groupWriteAttempts,
    groupRevisionVector,
    groupVectorHash,
    isGroupHoldingRun,
    isGroupManagedStory,
    partitionGroups,
    phraseGroupsOf,
    storyPhrase
} from '../phrase';
// F1: the allowance read and its cap are Author-facing and were exported from THIS module; the
// re-export keeps `loop/phase1-groups*.test.ts` and any rail-side import site resolving while the
// definition lives with the rest of the group-pipeline reads.
export { GROUP_WRITE_ATTEMPT_CAP, groupWriteAttempts } from '../phrase/exclusion';
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
 * loop cannot work around, and H1 gives it a second shape:
 *
 *   (a) the provider is not returning valid `SummarySample` JSON, so no sample exists, there is
 *       nothing to screen and nothing to select; or
 *   (b) H1/R3 — samples exist, but the round CANNOT select one: it was armed with fix tasks and every
 *       draft failed certification (its fixes unresolved, or a blocking screening issue). Selecting
 *       the least-bad of those would install text the round's own Readers rejected and close the fix
 *       tasks on the strength of that installation, which is the loop running backwards.
 *
 * Both shapes are bounded by the SAME attempt cap and recover the SAME way: the Author clears the
 * escalation and the sweep re-arms a fresh wave (`engine.ts:rearmSamplingWave`). Generation simply
 * stops offering samples once the cap is spent, because the retry allowance IS the bound.
 */
export function samplingExhausted(store: Store, story: Story): boolean {
    if (story.phase !== 'summary') return false;

    const summaryRef = storySummary(store, story.id)?.id;

    if (summaryRef === undefined) return false;

    const round = samplingRoundOf(story);

    // The CURRENT WAVE's attempts: a re-armed wave starts at zero, which is exactly what makes the
    // Author's clear recover the round instead of re-opening the same escalation forever.
    if (sampleAttempts(store, summaryRef, round, samplingWaveOf(story)) < samplingCapOf(story)) return false;

    const drafted = roundRevisions(store, story.id, round).filter((revision) => revision.state === 'drafted');

    // (a) no draft at all — the provider failure this escalation was written for.
    if (drafted.length === 0) return true;

    // The round is still gathering evidence (a screening pass running or owed, T12/C): nothing has
    // failed yet, so the sweep must not ask the Author about a round that could still certify.
    if (liveRuns(store, story.id).some((run) => PHASE1_PIPELINE_RUN.test(run.work_item_ref ?? ''))) return false;
    if (drafted.some((revision) => !isFullyScreened(store, story, revision.id))) return false;

    // (b) H1 — the round is complete and holds no certifiable draft. A round with nothing to certify
    // (round 1, or one whose screening rows predate fix verification) is NOT exhausted: §6.5's least
    // -bad path still installs the best draft the round produced, exactly as it did before (R5).
    return roundRequiresCertification(store, story.id, round) && !roundHasEligibleCandidate(store, story, round);
}

/**
 * Queue (or re-find) the Author's escalation for an exhausted sampling round. Idempotent by title
 * prefix, so the sweep may call it every time the condition holds without stacking rows.
 *
 * The `detail` records the WAVE it was opened at (T12/E): `engine.ts:rearmSamplingWave` bumps
 * `stories.sampling_wave` when a cleared row's recorded wave still equals the Story's, so the
 * recorded-wave guard is what makes the bump happen once per cleared escalation rather than on
 * every sweep.
 *
 * H1 — the two exhaustion shapes share this row, and so share the wave recovery above, but they ask
 * different questions of the Author: a provider that cannot produce JSON is fixed by changing the
 * model, and a round whose drafts were all rejected is fixed by settling the fix tasks, discarding
 * them, or widening the sampling. The title says which one happened, because the reuse key only
 * matches the opening and the detail would otherwise be the only truth in the row.
 */
export function openSamplingFailureTask(store: Store, story: Story): Task {
    const cap = samplingCapOf(story);
    const round = samplingRoundOf(story);
    const wave = samplingWaveOf(story);
    const scored = roundSampleScores(store, story.id, round);
    const rejected =
        scored.length > 0 &&
        roundRequiresCertification(store, story.id, round) &&
        !roundHasEligibleCandidate(store, story, round);

    if (rejected) {
        // N-1 — the row has to say WHICH axis exhausted the round. A candidate is eligible only when
        // BOTH are clean, so an exhausted certifying round is exactly "no draft was clean on both", and
        // each candidate's score says which one it failed:
        //
        //   * the FIX axis — `fixesUnresolved` (a demanded task the Readers marked unresolved, or a
        //     draft whose screening leg produced no verdict at all); or
        //   * the SCREENING axis — a `critical`/`high` issue count (minors are taste and never appear
        //     here: the schema closes severity at critical/high and the Summary prompts cost wording
        //     notes as minor, T-11/R6, so they are never described as blockers).
        //
        // Before this, a round whose drafts had ALL answered the work list and were refused for a
        // blocking screening issue was reported as "no draft answered the fixes … the screening leg never
        // answered, so nothing was certified" — the opposite of what its own ledger said. The title tail
        // is free to tell the truth: both `openEscalationTask`'s reuse key and
        // `engine.ts:rearmSamplingWave` match only `SAMPLING_FAILURE_PREFIX` (and the detail's `wave:`),
        // so the recovery semantics are untouched.
        const outstanding = scored
            .flatMap((sample) =>
                sample.fixesUnresolved.map((ref) => ({
                    ref,
                    revision: sample.revision.id,
                    // A draft whose screening leg produced no valid verdict never ANSWERED `unresolved` —
                    // it was never graded (H1-C1/F2's ungradeable shape). The Author's lever is the
                    // provider in that case, not the draft, so the row names which of the two it is.
                    verdict: sample.legacyScreening ? 'never screened' : 'unresolved'
                }))
            )
            .sort(
                (left, right) => left.ref.localeCompare(right.ref) || left.revision.localeCompare(right.revision)
            );
        const listed = outstanding.map((entry) => `${entry.ref} (${entry.verdict} on ${entry.revision})`).join('; ');
        // The drafts that DID clear everything they were handed. `fixRefs.length > 0` keeps an
        // H1-C1/F1-settled (empty) demand from reading as a certification.
        const certified = scored.filter((sample) => sample.fixRefs.length > 0 && sample.fixesUnresolved.length === 0);
        const certifiedIds = certified.map((sample) => sample.revision.id).join(', ');
        // The counts behind the rejection, per draft — the context the Author needs to judge whether the
        // WRITER is the problem (widen the sampling) or the TASKS are (re-cost them).
        const blocked = scored
            .filter((sample) => sample.critical + sample.high > 0)
            .map((sample) => `${sample.revision.id} (${sample.critical} critical, ${sample.high} high)`)
            .sort((left, right) => left.localeCompare(right));
        const drafts = `${scored.length} Summary ${scored.length === 1 ? 'draft' : 'drafts'}`;
        // Three truthful shapes, and the mixed one never claims nothing was certified when something was.
        const title =
            certified.length === 0
                ? `${SAMPLING_FAILURE_PREFIX} ${cap} attempts — no draft answered the fixes this round was armed with`
                : `${SAMPLING_FAILURE_PREFIX} ${cap} attempts — no draft was both fixed and free of critical/high screening issues`;
        const head =
            certified.length === 0
                ? `round ${round} drafted ${drafts} and no screening pass certified them (wave: ${wave}). `
                : `round ${round} drafted ${drafts} and none was selectable (wave: ${wave}): ${certifiedIds} cleared every fix it was handed, with evidence, and was rejected for its screening issues` +
                  `${listed.length > 0 ? ', while the rest left fixes unresolved' : ''}. `;
        const fixes =
            listed.length > 0
                ? `Outstanding: ${listed}. `
                : 'Every fix this round was armed with was certified with evidence — nothing is outstanding. ';
        const screening = blocked.length > 0 ? `Rejected on screening issues: ${blocked.join('; ')}. ` : '';
        // The recovery levers, named by the axis that actually failed. Nothing here changes what the loop
        // does: the base draft is untouched, the tasks stay open, and clearing the row re-arms a wave.
        const lever =
            certified.length === 0
                ? 'Discard or re-cost the fix tasks if they are what is wrong, widen summary_sampling for another attempt in this wave, or clear this row and the sweep re-arms a fresh wave of samples against the same base draft (§6.4 step 3, T12/E).'
                : listed.length === 0
                  ? 'The work list is ANSWERED, so this is the drafts failing their Readers rather than the tasks being wrong: widen summary_sampling for another attempt in this wave, or clear this row and the sweep re-arms a fresh wave of samples against the same base draft (§6.4 step 3, T12/E).'
                  : 'Re-cost the outstanding fix tasks if they are what is wrong, widen summary_sampling for another attempt in this wave, or clear this row and the sweep re-arms a fresh wave of samples against the same base draft (§6.4 step 3, T12/E).';

        return openEscalationTask(store, story.id, {
            title,
            detail:
                head +
                fixes +
                screening +
                'The selected Summary is unchanged and every fix task is still open — nothing was closed on a draft that failed (§6.8, R4). ' +
                lever,
            reusePrefix: SAMPLING_FAILURE_PREFIX,
            why:
                certified.length === 0
                    ? `sampling round ${round} spent its retry allowance with no draft that answered its fix tasks; whether the drafts or the tasks are wrong is the Author's call (§6.5, §6.8)`
                    : `sampling round ${round} spent its retry allowance with no draft that was BOTH certified and free of critical/high screening issues; the screening counts, not the work list, are what blocked it (§6.5, §6.8)`
        });
    }

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
 * The escalation title's stable opening for a finding the Editor will not decide — the reuse key
 * (T6/R2d). It names the FINDING, so two stalled findings ask two questions and a sweep that
 * re-escalates the same one cannot stack a third row.
 */
export const FINDING_VERIFY_STALL_PREFIX = 'Phase ① verification undecided for finding';

/**
 * Queue (or re-find) the Author's escalation for a finding whose verification budget is spent.
 *
 * Why the row is `blocked` rather than `open`: an `open` row is dispatchable work, and the crew has
 * nothing left to run — the Story would read `ready` while every path forward was refused, which is
 * the contradiction this pass exists to remove. A `blocked` row is the shape `checker.ts:requestAuthor`
 * writes for a question, and `status.ts:decideStory` step 4 turns it into the honest "the crew asked
 * you" Author wait (P7, L-36/L-37).
 *
 * The engine closes the row when the finding leaves `unconfirmed` (engine.ts:escalateVerifyStall) —
 * the Author's approve/dispute is the answer, and the question must not outlive it.
 *
 * T10/F2 — the reuse key names the finding and is ANCHORED on the title separator. Findings come from
 * one counter, so `finding_1` is a text prefix of `finding_10`: the old `"<prefix> <id>"` key let
 * finding_1's row satisfy finding_10's lookup (in the order finding_1 escalated first, finding_10 never
 * got its own question — and the row it borrowed named the wrong finding). `openEscalationTask` now
 * also requires the stored `finding_ref` to match exactly, so the one-row-per-finding contract holds
 * whatever the titles say.
 */
export function openFindingVerifyStallTask(store: Store, story: Story, finding: Finding): Task {
    return openEscalationTask(store, story.id, {
        title: `${FINDING_VERIFY_STALL_PREFIX} ${finding.id} — the Editor was sent ${FINDING_VERIFY_CAP} times and never decided it`,
        detail:
            `finding ${finding.id} (${finding.cost}, ${finding.fingerprint}, target ${finding.target_ref}) is still ` +
            '`unconfirmed` after every verification pass the loop is allowed to buy. No further pass is offered for it; ' +
            'approve it, dispute it, or discard it, and the Summary round moves again (§15 step 11, D-33).',
        // The ` —` separator is the anchor: `… finding finding_1 —` is not a prefix of
        // `… finding finding_10 —`, which is exactly the collision the bare id produced.
        reusePrefix: `${FINDING_VERIFY_STALL_PREFIX} ${finding.id} —`,
        state: 'blocked',
        findingRef: finding.id,
        why: `finding ${finding.id} stayed unconfirmed across ${FINDING_VERIFY_CAP} Editor verification passes; the answer is the Author's (D-33, P7)`
    });
}

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

// ---------------------------------------------------------------------------
// T-10 / the G-9 fix — the RESEARCHER half of a round's fix demand
// ---------------------------------------------------------------------------

/**
 * The Author question for a Researcher-owned prerequisite the loop can no longer ground: its
 * `FIX_PREREQUISITE_CAP` passes are spent and none of them recorded a fact.
 *
 * WHY THIS IS AN AUTHOR ROW AND NOT ANOTHER PASS: the round cannot arm (a prerequisite is its input,
 * `records.ts:samplingArmed`), a draft cannot answer it (no draft settles a research question), and
 * the crew cannot retry it (budget spent). Only the Author can break that — supply the fact, drop
 * the requirement, or re-open the budget with a new finding — so it becomes the one thing that stops
 * the Story reading `ready` with nothing to dispatch (H2/R2).
 */
export const FIX_PREREQUISITE_STALL_PREFIX = 'Phase ① research prerequisite exhausted on';

/**
 * The Author question for a `fix` row whose `owner_role` names a role no phase-① job serves. A
 * placeholder row from another subsystem — `seed_review`, a directive, an intake probe — lands in the
 * same queue with an owner that has no phase-① work. Naming it is the honest answer; running a
 * Writer at it or quietly closing it would be the loop's fiction.
 */
export const FIX_TASK_OWNER_PREFIX = 'Phase ① fix task has no crew that can work it';

/** One row per task, forever: `<prefix> <task id> —` (the dash keeps ids out of each other's prefix). */
const fixTaskEscalationKeyOf = (prefix: string, taskId: string): string => `${prefix} ${taskId} —`;

/** The finding a task names, if any — this ledger carries ONE `finding_ref` per row. */
const taskFindingRefs = (task: Task): string[] => (task.finding_ref === undefined ? [] : [task.finding_ref]);

/** The Knowledge rows a task's research passes wrote, as ids — the evidence a settlement cites. */
const taskEvidenceIds = (store: Store, storyId: string, taskId: string): string[] =>
    researchPrerequisiteEvidence(store, storyId, taskId).map((event) => event.id);

/** Open (or reuse) the exhausted-prerequisite question. `openEscalationTask` keeps one row per task. */
export function openFixPrerequisiteStallEscalation(store: Store, story: Story, task: Task): Task {
    const cap = RESEARCH_PREREQUISITE_CAP;
    const evidenceIds = taskEvidenceIds(store, story.id, task.id);
    const findingRefs = taskFindingRefs(task);

    return openEscalationTask(store, story.id, {
        title: fixTaskEscalationKeyOf(FIX_PREREQUISITE_STALL_PREFIX, task.id) + (task.title ?? ''),
        detail:
            `${task.id} is a fix task owned by ${task.owner_role ?? 'a researcher'} — grounding an external fact, not writing a line — and its ${cap} research passes produced no recorded fact (${evidenceIds.length} Knowledge entries${evidenceIds.length > 0 ? `: ${evidenceIds.join(', ')}` : ''}).`,
        state: 'open',
        reusePrefix: fixTaskEscalationKeyOf(FIX_PREREQUISITE_STALL_PREFIX, task.id),
        why: `the round was armed to close ${task.id} and phase ① has no way to ground it (T-10); the sampling cap is spent on it, so the choice is yours (P7)`,
        ...(findingRefs.length === 0 ? {} : { findingRef: findingRefs[0] })
    });
}

/** Open (or reuse) the "this owner has no phase-① job" question. */
export function openFixTaskOwnerEscalation(store: Store, story: Story, task: Task): Task {
    const owner = (task.owner_role ?? '').trim() || 'nobody';
    const findingRefs = taskFindingRefs(task);

    return openEscalationTask(store, story.id, {
        title: fixTaskEscalationKeyOf(FIX_TASK_OWNER_PREFIX, task.id) + (task.title ?? ''),
        detail: `${task.id} is open and owned by ${owner}. Phase ① offers Writer work, Researcher grounding, Editor structure/review, and a Chapter Writer — none of them is ${owner}, and a draft cannot be graded against work it cannot do.`,
        state: 'open',
        reusePrefix: fixTaskEscalationKeyOf(FIX_TASK_OWNER_PREFIX, task.id),
        why: `${owner} has no phase-① job that can work ${task.id}: it is yours to re-own, restate, or close (P7)`,
        ...(findingRefs.length === 0 ? {} : { findingRef: findingRefs[0] })
    });
}

/**
 * The one phase-① job a Researcher-owned `fix` task turns into: a grounding pass on the SAME
 * `summary` anchor the samples use, kind `research`, priority 0.
 *
 * WHY A JOB AT ALL (H2/R1): the alternative — excluding such a row from the round's demand — strands
 * it. The row stays open forever, `roundRequiresCertification` still wants every fix closed, and the
 * next round arms onto the same mixed demand. This is the architecture's own answer: the fix names a
 * fact nobody has grounded, so the crew that grounds facts (D-37's `research` pass, with
 * `writeKnowledge`) is dispatched, told WHICH task and finding and what its done condition is, and
 * its evidence is what closes the row (`engine.ts:settleFixPrerequisites`) — never the run ending.
 *
 * It rides the existing `research` kind and the existing `wi_research_fix_<task>_a<n>` family, so the
 * sampler gate's `PHASE1_PIPELINE_RUN` test, the run family, and every existing read behave exactly
 * as they already do. `taskRefs`/`findingRefs` are what `brief.ts` renders into the dispatched job,
 * which is how a no-tool Researcher sees the question it is being asked.
 */
function phase1FixPrerequisites(store: Store, story: Story, summaryRef: string): WorkCandidate[] {
    const out: WorkCandidate[] = [];

    // A prerequisite the budget has spent is NOT re-offered here — it becomes the Author question
    // below, and re-offering it would buy a fifth and sixth pass with no budget left to spend.
    for (const task of openResearchFixPrerequisites(store, story.id)) {
        const attempts = researchPrerequisiteAttempts(store, task.id);

        if (researchPrerequisiteExhausted(store, task)) {
            openFixPrerequisiteStallEscalation(store, story, task);
            continue;
        }

        const findingRefs = taskFindingRefs(task);
        const evidenceIds = taskEvidenceIds(store, story.id, task.id);

        const built = candidate(
            store,
            story,
            'research',
            'researcher',
            // F1 — the unit is a WorkUnitRef, not the bare artifact id: `brief.ts` branches on
            // `item.unit.kind` to render ARTIFACT UNDER REVIEW, so a string here produced a brief with
            // an empty artifact section and a Researcher grounding the fact without ever seeing the
            // Summary it is a fact about. Same `{ kind: 'summary', ref }` anchor the samples and the
            // screening passes carry (`phase1PipelineCandidates`'s sample and screen jobs);
            // `undefined` only when the Story has no Summary row at all.
            summaryRef === '' ? undefined : { kind: 'summary', ref: summaryRef },
            // The attempt number is IN the key — the family's anti-repeat discipline (§6.4 step 2).
            researchPrerequisiteKeyOf(task.id, attempts + 1),
            `ground the external fact ${task.id} asks for (§6.4 step 2, T-10)`,
            0,
            {
                // D-17b: pinned like every other phase-① job, so this pass can never be routed to a
                // Writer template by the pool pick.
                templateRef: 'researcher-story',
                roleName: 'researcher',
                // `taskRefs` + `findingRefs` are rendered by `brief.ts:renderJob` as the task's title
                // and the finding's detail; `note` carries the done condition and the answer the
                // Researcher must NOT choose.
                taskRefs: [task.id],
                findingRefs,
                note:
                    `Fix task ${task.id} (${(task.title ?? '').trim() || 'no title'}) is a RESEARCH prerequisite, not a line to rewrite${findingRefs.length > 0 ? ` — it names ${findingRefs.join(', ')}` : ''}.${evidenceIds.length > 0 ? ` ${evidenceIds.length} Knowledge entr${evidenceIds.length === 1 ? 'y is' : 'ies are'} already recorded for the earlier pass${evidenceIds.length > 0 ? ` (${evidenceIds.slice(0, 3).join(', ')})` : ''} — re-cite them with the source that grounds this claim rather than starting cold.` : ''} Attempt ${attempts + 1} of ${RESEARCH_PREREQUISITE_CAP}. Call writeKnowledge with the fact and its source; that record IS the completion evidence that closes the task. Do NOT call reportNoResearch: it settles nothing here, and the row stays open.`
            }
        );

        if (built !== undefined) out.push(built);
    }

    // A row whose owner has no phase-① job at all: the question is the work. It holds the drain, and
    // the Author's answer (re-own it, restate it, close it) clears it the moment the row leaves the
    // set this reads (`engine.ts:settleFixPrerequisites` closes the row on the same condition).
    for (const task of openUnserviceableFixTasks(store, story.id)) openFixTaskOwnerEscalation(store, story, task);

    return out;
}

// ---------------------------------------------------------------------------
// SUMMARY PHRASE — the group pipeline (R2/R3/R4/R5)
// ---------------------------------------------------------------------------

/**
 * The group pipeline's jobs (§6.4's shape, R5's content), in dispatch order:
 *
 *   1. `draft_groups`  — ONE Writer pass over a batch of groups (a structured, no-tool turn whose
 *                        answer is installed whole by `engine.ts:settleJob`);
 *   2. `review_groups` — one structured Reader pass per seat over the INSTALLED Overview, keyed by the
 *                        group vector, which is the redesign's replacement for screening N candidates;
 *   3. `check_unit`    — the deep cross-group review, the tool-carrying pass that turns what the
 *                        Reader noticed into findings with `group_refs` on them (R3). It stays because
 *                        R5 keeps the deep review; only the whole-Summary sampling and the draft
 *                        selection are gone.
 *
 * WHY THERE IS NO SAMPLING HERE AT ALL: in this model an accepted Writer result IS the state, so the
 * round of N competing drafts, their screening, and the Editor's pick have nothing to choose between
 * (R5). The retry knob is the per-group allowance above, and the "is it better now?" question is
 * answered by the next review, not by a score.
 */
function phase1GroupCandidates(
    store: Store,
    story: Story,
    summaryRef: string,
    brief: SeedBrief | undefined
): WorkCandidate[] {
    const out: WorkCandidate[] = [];
    const groups = phraseGroupsOf(store, story.id);

    if (groups.length === 0) return [];

    const allRefs = groups.map((group) => group.id);
    const phrase = storyPhrase(store, story.id);

    // -- 1. The Writer batch -------------------------------------------------------------------
    // The batch is the owed set cut three ways, in this order, because each cut is a different rule:
    //   a. R4 — a group a live Writer already holds is DEFERRED, not cancelled: a batch of
    //      {premise, tone} with premise live offers {tone}. Two disjoint batches run at once, which is
    //      the concurrency the redesign exists to buy;
    //   b. the per-group allowance (`GROUP_WRITE_ATTEMPT_CAP`), measured against each group's own
    //      current text;
    //   c. the Author's batch size, read from the SAME dial phase ① always had: `summary_sampling`
    //      was "how many competing drafts", and for a group book it is "how many groups one pass may
    //      rewrite". Reusing it keeps one Author-facing knob and no new setting.
    const targets = groupWorkTargets(store, story);
    // R5 keeps phase ①'s gates exactly where they were: the Writer batch does not open until an
    // accepted Seed Brief exists and its research leg is settled. This is the SAME
    // `researchGate` predicate the sampler reads (`phase1PipelineCandidates`'s step 3), so the two
    // pipelines can never tell different stories about whether a round is grounded — the redesign
    // changed what a Writer is asked to write, not what it has to be able to answer first.
    const gatesOpen = brief !== undefined && researchGate(store, story, brief) !== 'needed';

    if (gatesOpen && targets.length > 0) {
        const { free } = partitionGroups(store, story.id, targets.map((target) => target.group));

        if (free.length > 0) {
            const batchSize = Math.max(1, summarySamplingOf(story));
            const batch = free.slice(0, batchSize);
            const batchRefs = batch.map((group) => group.id);
            const batchIds = new Set(batchRefs);
            const findingRefs = targets
                .filter((target) => batchIds.has(target.group.id))
                .flatMap((target) => target.findingRefs);

            // The claim family is `wi_draft_groups_<summaryRef>_<group-set hash>_<attempt>` (see
            // `phrase/exclusion.ts:GROUP_DRAFT_ITEM_PREFIX` for why the shape is owned there): the
            // group-set hash makes one batch a claim FAMILY rather than one claim, so a failed pass
            // retries under the next attempt number while a restart reproduces the family exactly.
            // The exclusion does not read the key — it reads the Run row's persisted `group_refs`,
            // which `run/executor.ts` copies from the Work Item — so the key is ledger identity, not
            // the lock itself.
            const family = `${GROUP_DRAFT_ITEM_PREFIX}_${summaryRef}_${groupVectorHash(Object.fromEntries(batchRefs.map((ref) => [ref, 0])))}`;
            const attempts = store.runs
                .list()
                .filter((run) => run.story_id === story.id && (run.work_item_ref ?? '').startsWith(`${family}_`)).length;

            const built = candidate(
                store,
                story,
                'draft_groups',
                'writer',
                { kind: 'summary', ref: summaryRef },
                claimKey(family, attempts + 1),
                `rewrite ${batch.length} Summary group(s) — ${batch.map((group) => group.key).join(', ')} — in one structured pass (R2, R5)`,
                2,
                {
                    toolMode: 'none',
                    responseSchema: { name: GROUP_DRAFT_SCHEMA_NAME, schema: GroupDraftSchema },
                    groupRefs: batchRefs,
                    // The findings this batch answers ride on the job twice, on purpose: `findingRefs`
                    // is what the brief renders with their evidence, and it is also the list the
                    // install stamps onto the new revisions (`GroupInstallOptions.findingRefs`), which
                    // is the anchor R3's closure is judged on. `taskRefs` is the fix rows themselves —
                    // held open by `settleJob` until the findings they name are actually resolved.
                    findingRefs,
                    taskRefs: findingRefs
                        .map((id) => store.findings.get(id))
                        .flatMap((finding) =>
                            finding === undefined
                                ? []
                                : tasksForFinding(store, story.id, finding.id).map((task) => task.id)
                        )
                        .filter((id, index, all) => all.indexOf(id) === index),
                    // The answer contract and the "write these groups, in this order, revise don't
                    // rewrite" rules are NOT in this note: they are engine-owned text the prompt
                    // compiler appends (`run/phase1-prompt.ts:compileGroupDraftPrompt` →
                    // `GROUP_DRAFT_INSTRUCTION`), because §5's cache rule wants the binding sentences
                    // in one place for every batch. The template's own prose stays generic (R7).
                    templateRef: 'writer-summary-sampler',
                    roleName: 'writer'
                }
            );

            if (built !== undefined) out.push(built);
        }
    }

    // -- 2. The structured review of the installed Overview ---------------------------------------
    // Keyed by the GROUP VECTOR (`{groupId: number}` hashed — `phrase/revisions.ts:groupVectorHash`),
    // which is the whole point of the redesign's review: an install moves the vector, so the seats
    // re-arm by themselves, and the N passes of one vector are N different seats (the rotation) rather
    // than N drafts of one text. A restart re-reads the vector from the rows and reproduces the keys.
    const vectorHash = groupVectorHash(groupRevisionVector(store, story.id));
    const hasText = groups.some((group) => group.revision > 0);
    const readers = summaryReadersOf(story);

    if (hasText) {
        for (let pass = 1; pass <= readers; pass += 1) {
            const key = `wi_review_groups_${vectorHash}_${pass}`;

            // One run per seat per vector: `runsForItem` counts CLOSED runs, so a seat that has
            // already reported on this state is not bought again, and the live seat is caught by
            // `candidate()`'s own claim check.
            if (runsForItem(store, key).length > 0) continue;

            const built = candidate(
                store,
                story,
                'review_groups',
                'reader',
                { kind: 'summary', ref: summaryRef },
                key,
                `Reader ${pass}/${readers} reviews the installed Overview at group vector ${vectorHash} (R3, R5)`,
                2,
                {
                    toolMode: 'none',
                    responseSchema: { name: GROUP_REVIEW_SCHEMA_NAME, schema: GroupReviewSchema },
                    // Every group, because the Reader judges the Overview as installed — the batch that
                    // moved the vector is not the only text it has to read, and a defect that crosses
                    // groups must be able to name every group it crosses.
                    groupRefs: allRefs,
                    fixRefs: openFixTaskIds(store, story.id),
                    // Again no note: `run/phase1-prompt.ts:compileGroupReviewPrompt` appends
                    // `GROUP_REVIEW_INSTRUCTION` (name the groups, quote the line, grade the fixes), so
                    // the seat's brief and the cache key come from one compiler.
                    templateRef: 'reader-screening',
                    roleName: 'reader'
                },
                pass - 1
            );

            if (built !== undefined) out.push(built);
        }
    }

    // -- 3. The deep cross-group review (§6.4 step 6, R5) -----------------------------------------
    // The tool-carrying pass, offered once the structured seats for this vector have all run: it is
    // the pass that turns "the Reader noticed something" into a FINDING with `group_refs` on it
    // (`tools/checker.ts:raiseFinding`), and R3's whole closure rule runs on that attribution.
    // `revisionRef` is deliberately absent — there is no draft row in this model; the brief carries
    // the composed Overview and the run reads the book with tools (R6's mirror keeps `readSummary`
    // honest).
    if (hasText && phrase !== undefined) {
        const reviewsFiled = groups.length > 0 && allReviewSeatsRun(store, vectorHash, readers);

        if (reviewsFiled) {
            for (let pass = 1; pass <= readers; pass += 1) {
                const key = `wi_group_check_${vectorHash}_${pass}`;

                if (runsForItem(store, key).length > 0) continue;

                const template = DEEP_REVIEW_TEMPLATES[(pass - 1) % DEEP_REVIEW_TEMPLATES.length];

                const built = candidate(
                    store,
                    story,
                    'check_unit',
                    'reader',
                    { kind: 'summary', ref: summaryRef },
                    key,
                    `Reader ${pass}/${readers} reviews the group Overview at vector ${vectorHash} against the Seed (R3, R5)`,
                    2,
                    {
                        groupRefs: allRefs,
                        templateRef: template,
                        roleName: 'reader',
                        // The group model's deep review (R3/R5): the artifact is the COMPOSED Overview,
                        // there is no draft row to name, and the one thing this pass must do that the
                        // legacy one never had to is say WHICH GROUPS each complaint is about. Without
                        // `group_refs` a finding means "the whole Overview" (the legacy reading) and the
                        // next Writer batch rewrites all five — the exact cost R2 exists to remove.
                        note:
                            `Reader pass ${pass}/${readers} on the installed group Overview at vector ${vectorHash}. THIS IS THE OVERVIEW, NOT PROSE, and it is composed from the book's Summary groups: ${groups
                                .map((group) => group.key)
                                .join(', ')}. THE SEED IS GENERAL, NOT AN OUTLINE: cost critical or major only on a contradiction you can QUOTE — the Seed, critical Knowledge, or the Overview's own promise and rules — or a central commitment the Seed states that it lacks. Added detail, an open Seed question, an unstated stake and unplanted setup are NOT defects. Word choice, sentence shape and register are taste or minor, because phase ③ writes the sentences. File the critical and major issues with raiseFinding on ${summaryRef}: detail (what is wrong and where), criterion, the quoted passage, the evidence line, the cost you believe — AND ` +
                            "`group_refs` naming every group the defect is about, as the group ids in the brief. " +
                            `A premise contradiction belongs to the premise group; a promise the ending does not keep names both. Cross-group incoherence is the review this pass exists for: judge the groups AGAINST EACH OTHER, not five times in isolation. Do not name a group you did not read a quote from, and never guess an id — an id the Story does not have is refused. File the goal verdict with submitVerdict at target_ref ${summaryRef}; there is no draft row in this model, so do not invent one. Never edit the book (D-26, D-30, T-9). Do not propose Ideas. Minor notes are optional and must not keep you searching; once the issues that matter are reported, stop — an empty pass is valid.`,
                    },
                    pass - 1
                );

                if (built !== undefined) out.push(built);
            }
        }
    }

    return out;
}

/**
 * Phase ①'s jobs, in the pipeline's own order (§6.4 steps 1-6):
 *
 *   1. `structure_seed` — priority 0, one per Seed hash. Refuses everything below it.
 *   2. `research`       — priority 0, one per accepted brief, and ONLY when the Editor's
 *                          `research_questions` list is non-empty: an empty list WAIVES this leg
 *                          (D-51), so no candidate is generated and sampling is not gated on it.
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

    // -- 0. Ground the round's RESEARCHER-owned fixes (T-10 / the G-9 fix) ------------------------
    // FIRST, ahead of the Seed job: these rows are what the round was armed with, and until the fact
    // is recorded no refinement sample can answer them — the round is already spent, so the cheapest
    // useful thread the sweep can open is the grounding pass. It rides priority 0 and its own
    // `wi_research_fix_*` family, so one pass per task per sweep and the directive rule below still
    // outranks it.
    out.push(...phase1FixPrerequisites(store, story, summaryRef));

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
                note: 'Seed structure: read the Seed and call structureSeed with the structured brief — the Seed itself is never edited (P5). Put gaps in open_questions; never invent a fact. State the research decision in research_questions: the questions a draft could not answer from the Seed alone, or [] when the premise is self-contained and the Researcher is waived (D-51) — never invent a question to fill the list.'
            }
        );

        if (built !== undefined) out.push(built);
    }

    // -- 2. Research the brief (§6.4 step 2, D-51) ------------------------------------------------
    // The key names the brief's `rev`, so a re-structured brief re-arms the pass and the samples
    // wait for the new knowledge (a live research run does not count — `records.ts:researchGate`).
    //
    // D-51: the Editor's `research_questions` list decides whether this job exists at all. A brief
    // whose list is EMPTY is WAIVED — no candidate, no run, nothing to wait for — which is what
    // stops a one-line Seed like "A Dog Tale" from buying a Researcher that invents a topic to
    // justify its own dispatch. A brief that predates the field (no property) is `needed`, exactly
    // as it was before the field existed.
    if (brief !== undefined && researchGate(store, story, brief) === 'needed') {
        // The questions ride in the note because the job briefing renders it (`brief.ts:renderJob`),
        // which is how a dispatched Researcher learns WHICH facts the Editor actually asked for
        // instead of surveying the whole setting. An empty scope never reaches this branch, so the
        // list below is always non-empty; a legacy brief names none and says so.
        const questions = researchQuestionsOf(brief);

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
                note:
                    'Research the facts this Seed Brief depends on and record them with writeKnowledge — one entry per claim, importance that means something, sources cited (T-10). ' +
                    // The report sentence comes BEFORE the question list on purpose: the briefing clips
                    // the note at 600 chars (`brief.ts:renderJob`), and the questions are the
                    // variable-length part. An agent that never reaches the list still learns how to end
                    // the run without inventing a fact (D-51).
                    'When none of the questions below needs an external lookup, close the pass with reportNoResearch rather than manufacturing a source (D-51). ' +
                    `The Editor's research questions for this brief (${questions.length}): ${
                        questions.length === 0
                            ? '(the brief predates the research_questions field — read the Seed Brief and research only what it genuinely cannot answer)'
                            : questions.map((question) => `"${question}"`).join('; ')
                    }.`
            }
        );

        if (built !== undefined) out.push(built);
    }

    // No Summary row means there is nothing to sample into; phase ① opens one in `createStory`
    // (§4.2: one Summary per Story), so this is a defensive read rather than a real state.
    if (summaryRef === '') return out;

    // SUMMARY PHRASE (R1/R5/R6): the switch is the STORY SETTING, not a derived fact —
    // `story.summary_mode === 'groups'` (and a row with no `summary_mode` is a legacy book, so
    // `phrase/catalog.ts:isGroupManagedStory` answers false and nothing here changes). A group-managed
    // book takes `phase1GroupCandidates` and never reaches the sampler below: no N competing drafts,
    // no screening set to rank, no Editor pick — an accepted Writer result is installed and its
    // predecessor becomes history in the same commit.
    //
    // Steps 0-2 above (the round's research fix owners, the Seed Brief, the research gate) are SHARED:
    // the redesign changed how the Summary gets written, not what the Seed Brief has to answer first.
    if (isGroupManagedStory(story)) {
        out.push(...phase1GroupCandidates(store, story, summaryRef, brief));

        return out;
    }

    const round = samplingRoundOf(story);
    const size = summarySamplingOf(story);
    const readers = summaryReadersOf(story);

    // -- 3. Sample (§6.4 step 3) ------------------------------------------------------------------
    // Gated on BOTH gates above, and on the round's arming rule: round 1 samples immediately after
    // research; round N+1 waits for the deep review to have defined the issues it must answer
    // (`records.ts:samplingArmed` — an open `fix` task and no unconfirmed blocking finding).
    //
    // D-51: `researchGate` is the same predicate gate 2 above reads, and anything but `needed` lets
    // the sample through — `waived` (the Editor decided there was nothing external to look up) and
    // `closed` (a pass ran and finished) are both "gate satisfied". Reading the two gates from one
    // predicate is what keeps generation and the drain probe (§6.7) telling the same story.
    if (brief !== undefined && researchGate(store, story, brief) !== 'needed' && samplingArmed(store, story, round)) {
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
        // H1/R3/R5 — the hill-climbing retry. `have < size` is the round the Author asked for; the
        // second half is what makes a round whose candidates ALL failed fix verification (or all carry
        // a blocking screening issue) draft AGAINST the same base instead of selecting the least-bad
        // text and calling the defect fixed. It stays inside the SAME bound the pipeline already had:
        // `samplingCapOf` = size + `SAMPLING_RETRY_ALLOWANCE` attempts per wave, and when that is
        // spent the round escalates to the Author (`samplingExhausted` below) rather than looping —
        // there is no retry loop here, only one more sample per sweep.
        //
        // `stalled` is deliberately as narrow as the selection gate it mirrors
        // (`engine.ts:trySelectSample`): the round must have its full set of drafts, EVERY draft must
        // be screened (T12/C), and no screening pass may still be running. Without those clauses the
        // queue would buy a fourth sample while the third was still being read, and the retry would
        // cost attempts it did not need.
        const drafted = roundRevisions(store, story.id, round).filter((revision) => revision.state === 'drafted');
        const pipelineLive = liveRuns(store, story.id).some((run) =>
            PHASE1_PIPELINE_RUN.test(run.work_item_ref ?? '')
        );
        const stalled =
            drafted.length > 0 &&
            !pipelineLive &&
            drafted.every((revision) => isFullyScreened(store, story, revision.id)) &&
            roundRequiresCertification(store, story.id, round) &&
            !roundHasEligibleCandidate(store, story, round);

        // The attempt counter (not the revision count) is what makes a FAILED sample retryable:
        // an invalid answer produces no row, so the next sweep buys the next claim key (N+3 cap).
        if ((have < size || stalled) && attempts < samplingCapOf(story) && !live) {
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
                    // H1/R1 — the fix tasks this round must answer, frozen onto the job so the Writer
                    // reads their evidence (not just their titles) and every sample of the round reads
                    // the same list. Round 1 is the first draft: it is handed nothing to revise.
                    fixRefs: round > 1 ? openFixTaskIds(store, story.id) : [],
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
    //
    // T6/R2b: the round's OWN drafts are screened even after its sampling leg has closed — the wave
    // being disarmed or spending its attempt cap mid-flight stops NEW samples, it does not cancel the
    // screening the round still owes. `records.ts:isSupersededSummaryDraft` is the other half: a draft
    // of a wave the Editor has already chosen past is never screened (that was the job that could
    // never be answered), while a draft of the round in flight always is.
    const revisionRounds = summaryRevisionRounds(store, story.id);
    // H1/R2 — the fixes each screening pass is handed, frozen onto the job (`WorkItem.fixRefs`). The
    // screener is the run that compares the candidate with the draft it replaces, so it is also the
    // run that certifies the fixes; a first-round draft is handed none, which is what keeps round 1
    // costing what it used to (R5).
    //
    // A screen dispatched after the Editor confirms a new finding mid-round carries the WIDER list,
    // which can reject a draft its Writer never saw that task in. That asymmetry is deliberate and it
    // fails closed: the round is not allowed to call a defect answered that its own Reader is looking
    // at, the rejected candidate simply costs one more attempt of the existing allowance, and the
    // retry's sampling job carries the wider list too (`fixRefs` above). Freezing the screen list to
    // each draft's own sample job would instead let a late-confirmed defect ride past the round
    // unclosed.
    const fixTaskIds = openFixTaskIds(store, story.id);

    for (const revision of summaryRevisions(store, story.id)) {
        if (revision.state !== 'drafted') continue;

        // A draft the Editor has already set aside: nothing a screener says about it can steer the
        // round that is running now, so the pass would be bought forever and answered by nobody.
        if (isSupersededSummaryDraft(store, story, revision, revisionRounds)) continue;

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
                // H1/R2: a REFINED draft (round ≥ 2) is screened against the fixes its round was armed
                // with; a first-round draft is handed an explicit empty list, which is a DECLARATION
                // that nothing was asked (`records.ts:sampleFixDemand`) and keeps the round-1 screen
                // byte-identical to what it was before fix verification existed.
                fixRefs: (revision.round ?? 1) > 1 || revision.origin === 'refined' ? fixTaskIds : [],
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

    // T10/F7: one condition, shared with `records.ts:deepReviewPassesOwed` — the review is offered for
    // the CURRENT round's selection only. The records-level predicate is what the drain probe and the
    // sign-off read, so an Author-selected older-round draft is neither offered passes nor held open by
    // passes it was never owed (the round's `deepReviewRoundOf`, §6.4 step 6).
    if (selected !== undefined && isDeepReviewSelection(story, selected)) {
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
                    note: `Reader pass ${pass}/${readers} on the selected Summary draft ${selected.id}. File TWO verdicts with submitVerdict: the goal verdict at target_ref ${selected.unit_ref} (the Goal’s own row) and the draft\u2019s own line at target_ref ${selected.id} (the crew panel\u2019s row). THIS IS THE OVERVIEW, NOT PROSE; THE SEED IS GENERAL, NOT AN OUTLINE: cost critical or major only on a contradiction you can QUOTE — the Seed, critical Knowledge, or the draft\u2019s own promise and rules — or a central commitment the Seed states that it lacks. Added detail, an open Seed question, an unstated stake and unplanted setup are NOT defects. A Summary is a set of facts, not prose: word choice, sentence shape and register are taste or minor, because phase ③ writes the sentences. The draft and the Seed are in the brief; call readSummary only if the brief does not carry the draft. Use tools to check a specific doubt — not to survey the book — and for a factual point one citable source is enough. File the critical and major issues with raiseFinding on ${selected.unit_ref}: detail (what is wrong and where), criterion, quoted passage, evidence line, and the cost you believe; name ${selected.id} in related_refs so the dashboard files each finding under this Overview; the draft line never replaces the Summary line. Never edit the book (D-26, D-30, T-9). Do not propose Ideas. Minor/taste notes are optional and must not keep you searching; once the issues that matter are reported, stop — an empty pass is valid.`
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
    //
    // T6/R2c + R2d put two bounds on this queue, both of which the sweep's escalation reads the same
    // way (`records.ts:findingsVerifyStalled`), so generation and escalation cannot disagree:
    //
    //  - a suspicion written about a draft the loop has ALREADY set aside earns no pass at all: the
    //    verify run re-reads the KEPT draft, which never contained the defect, so no answer it files
    //    can confirm or dispute the finding (the same reason a finding on a discarded sibling never
    //    blocks the phase — `records.ts:findingRevisionScope`);
    //  - a finding that has been sent `FINDING_VERIFY_CAP` times is dropped from the queue. An Editor
    //    run that closes without calling a tool leaves the finding `unconfirmed`, and an unconfirmed
    //    finding is a D-33 hold, so an uncapped queue bought the same question every sweep forever.
    for (const finding of unconfirmed) {
        if (
            ctx.phase === 'summary' &&
            (findingRevisionScope(store, story, finding) === 'superseded' ||
                isFindingVerifyExhausted(store, finding.id))
        )
            continue;

        const prefix = `wi_verify_finding_${finding.id}`;
        // Counted on the ANCHORED family (`records.ts:verifyFindingPrefixOf`): `finding_1` is a
        // prefix of `finding_10`, so an unanchored count would spend one finding's budget on another.
        const generation = verifyFindingAttempts(store, finding.id) + 1;
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
