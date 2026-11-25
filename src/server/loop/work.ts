// Work generation: given one Story's records, what jobs should a crew run next (L-1 step 4, §6.2).
//
// TWO SHAPES LIVE HERE, and the phase decides which one a Story runs:
//
//   * PHASES ②/③ are §6.2a's classic divergence, per unit:
//
//       writers ×`attempts`  →  competing revisions  →  readers ×M  →  an Editor selects  →  losers deleted
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
//         → deep review by tool-using Critics             (check_unit, wi_review_<revisionId>_a<pass>)
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
//   * a reader turned up nothing to fix but the unit has no verdict at all, so nobody has judged it.
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
    // PHRASE ② (T-W2): the chapter lane's three brief reads, one per question the generator asks —
    // is there an ACCEPTED brief (`currentPlotlineBrief`; nothing below the structure job is answerable
    // without it), what hash does the phrase's own seed carry (the staleness test the tool re-checks),
    // and the structuring job's claim key (`plotlinesStructureKeyOf`, a DIFFERENT family from phase ①'s
    // `wi_structure_seed_*` because the two phrases can hold identical text and hash the same).
    currentPlotlineBrief,
    plotlinePhraseSeedHashOf,
    plotlinesStructureKeyOf,
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
    SECTION_SCORES_SCHEMA_NAME,
    SectionScoresSchema,
    // PHRASE GROUP LOCK (R3/T6b): the Editor's judgement contract. Its seat writes no artifact of its
    // own — the product is the lock flag on the section's row — so the schema is the only thing this job
    // carries that a provider could get wrong.
    GROUP_LOCK_SCHEMA_NAME,
    GroupLockDecisionSchema,
    // PHRASE ② (T-W2): the chapter lane's answer contract — plotpoints, not prose. The batch job carries
    // it so the provider is bound to the same shape `phrase/plotpoints.ts:parseChapterDraftAnswer`
    // checks and the controller's `parseDraft` runs (`phrase/controllers/plotlines.ts`).
    CHAPTER_DRAFT_SCHEMA_NAME,
    ChapterDraftSchema,
    SUMMARY_SAMPLE_SCHEMA_NAME,
    SummarySampleSchema
} from '../../shared/schemas';
// PHRASE ② (T-W2): the phrase KEY, not a phrase name. The lane's gate reads `story.plotlines_mode`
// through `isPhraseGroupManaged(story, PHRASE_PLOTLINES_KEY)`, and the phrase row is looked up by the
// same constant (`shared/phrase.ts` is the one home of both).
import { PHRASE_PLOTLINES_KEY } from '../../shared/phrase';
// SUMMARY PHRASE (R1-R5) — the group domain, imported from its ONE surface (`../phrase/index`).
// `isGroupManagedStory` is the switch (`story.summary_mode`, NOT the presence of rows),
// `phraseGroupsOf`/`storyPhrase` are the book's catalog rows, `findingGroupsStillOwed` routes an
// open finding into the groups it still needs rewritten (R3), and `planGroupDraftBatch` is the cut
// that turns those owed rows into ONE pass per finding — R4's deferral, the allowance and the Author's
// dial in one ordered rule (D-66). The vector hash is what makes a review pass re-arm on an install
// rather than on a clock.
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
    // READER SCORING (D-65, gated by D-67): the seat's claim key and the attempt cap live in the phrase
    // domain so the generator, the projection and the drain probe read one definition of each. D-67
    // replaced the completeness gate with the CLEAN SELECTION (`cleanSelectionOf`) and the one-run-per-
    // vector rule with "no score rows for this hash, and fewer than the cap's worth of closed runs",
    // so a refusal re-arms the seat without letting a broken provider buy a Reader forever.
    cleanSelectionOf,
    groupCheckSeatKey,
    // PHRASE ② (T-W2): the batch's CLAIM REF is the phrase row id (`exclusion.ts:groupDraftClaimRef`,
    // seam S8), so the Summary's batch and the chapter batch on one book never spend each other's
    // attempts; and the review seat key is the SAME builder phase ① uses, because the vector hash — not
    // the family — is what keeps the two phrases' seats apart.
    groupDraftClaimRef,
    groupReviewSeatKey,
    // The PHRASE-level dial (`story.plotlines_mode`). `isGroupManagedStory` above stays the Summary's
    // predicate for the classic pins; this is the form the phase-② lane asks.
    isPhraseGroupManaged,
    // The phrase's OWN copied seed (seam S2) — Phrase ②'s structuring input, never `stories.idea`.
    phraseSeedOf,
    planGroupDraftBatch,
    phraseGroupsOf,
    scoredVectorHashes,
    SECTION_SCORE_ATTEMPT_CAP,
    sectionScoreClaimKey,
    storyPhrase,
    // The Plotlines phrase row, by key. `storyPhrase` (below) stays the PRIMARY/Summary read every
    // pre-Phrase-② call site uses; a chapter job has to name its own phrase.
    storyPhraseByKey,
    // T-W2b: the contract row's chapter entry, by `order` — the inverse of the install's mirror
    // (`phrase/plotpoints.ts:syncPlotlineContract`). `needsReader` needs it to see the lane's install as
    // the write that it is; the tools' finding route and the §8.1 guards read the same function.
    plotlineChapterGroupOf,
    // T-W2b: THE GATE the three suppressions below share — the dial PLUS a materialized chapter set.
    // The dial alone over-reports: `loop/engine.ts:2887` defaults `plotlines_mode` to `'groups'`, so a book
    // whose Author never started Phrase ② would otherwise lose the §4.3 tools and the classic Writer legs.
    plotlineLaneIsLive
} from '../phrase';
// F1: the allowance read and its cap are Author-facing and were exported from THIS module; the
// re-export keeps `loop/phase1-groups*.test.ts` and any rail-side import site resolving while the
// definition lives with the rest of the group-pipeline reads.
export { GROUP_WRITE_ATTEMPT_CAP, groupWriteAttempts } from '../phrase/exclusion';
// PHRASE GROUP LOCK (R3/T6b) — the Editor's judgement seat. The three reads below are ALL this
// generator needs: which sections may be offered at all (`editorLockSeatTargets`, which folds the
// Setting, the clean selection, the Reader's row and the Writer hold into one pass), the seat's key
// (`groupLockSeatKey`, the same builder the settle reads the vector back from), and whether that seat is
// already spent. The RULES are not here: `loop/editor-lock.ts` owns them so the prompt compiler and the
// settle answer with the same read, and `phrase/locks.ts` still owns the write.
import { editorLockSeatTargets, groupLockSeatKey, groupLockSeatSpent } from './editor-lock';
// The slug above is a VALUE of the prompt compiler that owns it, not a string copied here: the seat's
// `templateRef` and the copy `compileGroupLockPrompt` renders come from one constant, so renaming the
// slug cannot leave a Work Item pointing at a template that no prompt is compiled from. (The edge is
// one-way — `run/phase1-prompt.ts` depends on `loop/editor-lock.ts` and `loop/records.ts`, never on this
// module — so importing it here cannot form a cycle.)
import { GROUP_LOCK_TEMPLATE_SLUG } from '../run/phase1-prompt';
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
 * Used for the reader offers above: the generation is already store-derived, so the rotation is a pure
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
 * Critics read a finished artifact, never the empty row a live Writer has not reached yet (§4.15).
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
 * can answer, and the sweep would buy a fresh reader pass for the set on every sweep forever.
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
    // Writer → Critic → Editor, and the Editor's valid critique sends back ONE corrected draft (the
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

/** Phase ①'s screening count: how many Critics judge each sample (§6.4 step 4). */
const summaryCriticsOf = (story: Story): number => screeningSizeOf(story);

/**
 * Does this unit need a Writer, and on which trigger?
 *
 * The competing-revision guard is L-16's discipline seen from the other side: while drafts are
 * competing, a new Writer would be a fourth draft nobody asked for, and the unit's next step is a
 * reader or an Editor, not another draft.
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

    // While drafts are competing the unit's next step is normally a reader or an Editor, not a fourth
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
 * T-W2b — IS THIS CONTRACT ROW THE PRODUCT OF THE PHRASE's INSTALL?
 *
 * `needsReader`'s no-drafts branch asks "has a crew written to this artifact?" and answers it from the
 * run ledger (`wi_write_<unit>_*`). A group-managed book has no such run for a contract row: the lane's
 * `draft_groups` batch installs the chapter ENTRY and `phrase/plotpoints.ts:syncPlotlineContract`
 * mirrors it onto the row in the same commit, so the write is a `group_revisions` row, not a run naming
 * the unit. The chapter entry's own counter is the honest record of that event — `PhraseGroup.revision`
 * is the number of texts installed into the entry — so this reads the row's `order` → entry (the
 * inverse of the mirror) and asks whether an install has happened.
 *
 * `false` for a row that is not the phrase's (no entry at that order, or the phrase is unstarted) and
 * for the phase-② SET unit (`ref: ''`), where there is no entry to consult.
 */
function contractInstalledByPhrase(store: Store, storyId: string, unitRef: string): boolean {
    const row = store.plotlines.get(unitRef);

    if (row === undefined || row.story_id !== storyId) return false;

    const entry = plotlineChapterGroupOf(store, storyId, row.order);

    return entry !== undefined && entry.revision > 0;
}

/**
 * Does this unit need a reader?
 *
 * Two cases. A unit with competing drafts needs one per draft (§6.2a's "Reader runs ×M → verdicts per
 * revision"), and a unit whose newest draft has not been judged needs one against the stored artifact.
 * Freshness is a journal-order question, not an id comparison — verdict ids and revision ids come from
 * different counters (records.ts:createdAfter).
 *
 * `installedByPhrase` (T-W2b) says the artifact was written by the PHRASE's install rather than by a
 * `wi_write_*` run — the chapter-contract case on a group-managed book. It is a parameter and not a
 * lookup inside this function because only the caller knows which surface it is standing in front of
 * (`generateWork` has the phrase dial), and because the flag keeps this predicate honest for every
 * classic book: with the flag off, the answer is the byte-for-byte pre-T-W2b answer.
 */
export function needsReader(
    store: Store,
    story: Story,
    unitRef: string,
    installedByPhrase = false
): boolean {
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

    // T-W2b — ON A GROUP-MANAGED BOOK THE INSTALL IS THE WRITE. The chapter contract is written by the
    // lane's `draft_groups` batch (`phrase/revisions.ts:installGroupRevisions` mirrors the chapter entry
    // onto the `plotlines` row in the install's commit), and the batch's claim key names the PHRASE row,
    // not the unit — so no `wi_write_<unit>` run exists, ever, now that the classic Writer leg is
    // suppressed on this dial. Answering `false` here was what left the contracts unjudged: no reader
    // pass, no C-2/C-3 verdict lines at the row, and a phase-② Goal that cannot complete. The caller's
    // flag is the phrase's own record of that write (`PhraseGroup.revision > 0`).
    if (newestWrite === undefined && !installedByPhrase) return false;

    // The "has anybody judged this unit" test, shared by both write shapes. The freshness rule here is
    // deliberately the tool-written one (an existence check, not the per-draft journal comparison
    // above): a contract the lane redrafts is re-judged when L-11's invalidation marks the row, not on
    // every install, and the classic in-place writer behaves the same way.
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
    /** For a critic: which assigned angle this pass takes (so N passes are N different seats). */
    rotation?: number
): WorkCandidate | undefined {
    if (isClaimed(store, key)) return undefined;

    const pool = templatesFor(store, story, roleKind);

    if (pool.length === 0) return undefined;

    // S-5: each template's own ceiling is checked at dispatch time; here we bind ONE template so the
    // Work Item's `templateRef` is deterministic. Critic roles rotate across the assigned critic
    // templates (D-30's four angles); every other kind takes the first assigned match.
    const template = roleKind === 'critic' ? pool[(rotation ?? dispatchCount(store, key)) % pool.length] : pool[0];

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
 * The four deep-review Critic angles (§14 item 10, D-30). The screening Critic is deliberately NOT
 * in this list: it is the one-turn, no-tool screening mode, and a deep-review pass that reused it
 * would rate the selected draft on a prompt that never opens with the whole book (T-11).
 */
export const DEEP_REVIEW_TEMPLATES = [
    'critic-genre',
    'critic-plausibility',
    'critic-audience',
    'critic-mystery'
] as const;

/**
 * Is the in-flight round out of retries with nothing to show? That is the one phase-① failure the
 * loop cannot work around, and H1 gives it a second shape:
 *
 *   (a) the provider is not returning valid `SummarySample` JSON, so no sample exists, there is
 *       nothing to screen and nothing to select; or
 *   (b) H1/R3 — samples exist, but the round CANNOT select one: it was armed with fix tasks and every
 *       draft failed certification (its fixes unresolved, or a blocking screening issue). Selecting
 *       the least-bad of those would install text the round's own Critics rejected and close the fix
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
        //   * the FIX axis — `fixesUnresolved` (a demanded task the Critics marked unresolved, or a
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
                  ? 'The work list is ANSWERED, so this is the drafts failing their Critics rather than the tasks being wrong: widen summary_sampling for another attempt in this wave, or clear this row and the sweep re-arms a fresh wave of samples against the same base draft (§6.4 step 3, T12/E).'
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
 * the contradiction this pass exists to remove. A `blocked` row is the shape `reader.ts:requestAuthor`
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
    const critics = screeningSizeOf(story);

    return openEscalationTask(store, story.id, {
        title: `${SCREENING_PARTIAL_PREFIX} ${round} — selection proceeded with partial screening`,
        detail: `round ${round}: ${revisionIds.join(', ')} reached the ${cap}-attempt screening cap with ${critics}-or-fewer valid reviews each. Selection proceeded with the partial reviews (§6.5); the next round screens its own samples afresh (§6.4 step 4).`,
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
 *   2. `review_groups` — one structured Critic pass per seat over the INSTALLED Overview, keyed by the
 *                        group vector, which is the redesign's replacement for screening N candidates;
 *   3. `check_unit`    — the deep cross-group review, the tool-carrying pass that turns what the
 *                        Critic noticed into findings with `group_refs` on them (R3). It stays because
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
    //   a. R4 — a group a live Writer already holds is DEFERRED, not cancelled. D-66 changed the SHAPE
    //      of the deferral: the unit that waits is the FINDING-SET, not the group, so a batch of
    //      {premise, tone} with premise live offers NOTHING rather than {tone} — a tone-only install
    //      would bank a partial fix under a claim that says the finding was answered. Two disjoint sets
    //      still run at once, which is the concurrency the redesign exists to buy;
    //   b. the per-group allowance (`GROUP_WRITE_ATTEMPT_CAP`), measured against each group's own
    //      current text — and under D-66 a parked group holds back the whole set it belongs to, because
    //      the loop cannot answer half a defect;
    //   c. the Author's batch size, read from the SAME dial phase ① always had: `summary_sampling` was
    //      "how many competing drafts", and for a group book it is "how many groups one pass may
    //      rewrite". D-66 makes it a cap BETWEEN finding-sets: it never splits one, so a set larger than
    //      the dial is dispatched whole. Reusing the dial keeps one Author-facing knob and no new
    //      setting.
    // All three live in `phrase/exclusion.ts:planGroupDraftBatch`, because the drain probe
    // (`groupPipelineOwed`) has to answer with the same rules the queue dispatches (D-62).
    const targets = groupWorkTargets(store, story);
    // R5 keeps phase ①'s gates exactly where they were: the Writer batch does not open until an
    // accepted Seed Brief exists and its research leg is settled. This is the SAME
    // `researchGate` predicate the sampler reads (`phase1PipelineCandidates`'s step 3), so the two
    // pipelines can never tell different stories about whether a round is grounded — the redesign
    // changed what a Writer is asked to write, not what it has to be able to answer first.
    const gatesOpen = brief !== undefined && researchGate(store, story, brief) !== 'needed';

    if (gatesOpen && targets.length > 0) {
        const batch = planGroupDraftBatch(store, story, targets);

        if (batch.length > 0) {
            const batchRefs = batch.map((target) => target.group.id);
            // D-66 put one finding's groups in the same batch, so the ids repeat once per group they
            // name. They are DEDUPED here because this list is what the install stamps onto EVERY new
            // revision row's `finding_refs` (`engine.ts` passes `item.findingRefs` straight through to
            // `installGroupRevisions`, which copies it verbatim): `['finding_0', 'finding_0']` would
            // claim the same defect twice on one text, and the Author's rail would read two closures
            // from one fix.
            const findingRefs = [...new Set(batch.flatMap((target) => target.findingRefs))];

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
                // D-66: the ledger line names EVERY group of the batch, which under the atomic rule is
                // every group of every defect the batch answers — so "the fix was applied" is readable
                // from the Work Item alone, without re-deriving the finding's group set.
                `rewrite ${batch.length} Summary group(s) — ${batch.map((target) => target.group.key).join(', ')} — in one structured pass (R2, R5)`,
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
    const critics = summaryCriticsOf(story);

    if (hasText) {
        for (let pass = 1; pass <= critics; pass += 1) {
            const key = `wi_review_groups_${vectorHash}_${pass}`;

            // One run per seat per vector: `runsForItem` counts CLOSED runs, so a seat that has
            // already reported on this state is not bought again, and the live seat is caught by
            // `candidate()`'s own claim check.
            if (runsForItem(store, key).length > 0) continue;

            const built = candidate(
                store,
                story,
                'review_groups',
                'critic',
                { kind: 'summary', ref: summaryRef },
                key,
                `Critic ${pass}/${critics} reviews the installed Overview at group vector ${vectorHash} (R3, R5)`,
                2,
                {
                    toolMode: 'none',
                    responseSchema: { name: GROUP_REVIEW_SCHEMA_NAME, schema: GroupReviewSchema },
                    // Every group, because the Critic judges the Overview as installed — the batch that
                    // moved the vector is not the only text it has to read, and a defect that crosses
                    // groups must be able to name every group it crosses.
                    groupRefs: allRefs,
                    fixRefs: openFixTaskIds(store, story.id),
                    // Again no note: `run/phase1-prompt.ts:compileGroupReviewPrompt` appends
                    // `GROUP_REVIEW_INSTRUCTION` (name the groups, quote the line, grade the fixes), so
                    // the seat's brief and the cache key come from one compiler.
                    templateRef: 'critic-screening',
                    roleName: 'critic'
                },
                pass - 1
            );

            if (built !== undefined) out.push(built);
        }
    }

    // -- 2b. The Reader's score of the REVIEWED Overview (D-65, gated by D-67) --------------------
    // ONE seat per CLEAN vector, keyed exactly like the review seats above, so a Clean advance re-arms it
    // by itself and a restart reproduces the key from the rows. The Author asked for the number "immediately
    // next turn", which sets the two knobs here: it goes out on the FIRST sweep that has a reviewable
    // Overview, and it is ranked AHEAD of the Critic seats inside the same priority class so the rail has
    // a score before the review pass that may follow it with findings. It is display work: no findings,
    // no tasks, no verdicts, and nothing in `loop/**` reads the rows it writes (P6's exception, D-65).
    //
    // THE GATE IS THE CLEAN SELECTION, NOT THE INSTALLED TEXT (D-67). The seat used to open the moment all
    // five groups had text, which put a number on the rail in the same turn the first drafts landed — before
    // anything had been REJECTED, which is the only evidence the phase has that the Summary says what the
    // Author meant. So the Reader is armed by `cleanSelectionOf` (D-67): every group must have a Clean
    // revision, and the hash the seat claims is the CLEAN selection's, not the live vector's. Two readings
    // follow, and both are the point:
    //   - a Writer install whose newest revision still has an unresolved defect does NOT re-arm this seat —
    //     nothing reviewable changed, and a score of unreviewed text is the number the Author asked not to
    //     be shown; and
    //   - the seat re-arms the first time the clean selection ADVANCES (a deep pass clears the group, or a
    //     later clean revision supersedes an older one), because the key is that selection's hash.
    // The text the Reader is shown is the same selection (`run/phase1-prompt.ts` compiles the prompt from
    // the rows behind `reviewed.vector_hash`), which is what makes the recorded `vector_hash` true.
    const reviewed = cleanSelectionOf(store, story);

    if (reviewed.complete) {
        const key = sectionScoreClaimKey(reviewed.vector_hash);

        // THREE ways this seat is not owed, in the order that costs least:
        //   1. the hash already has score rows — the judgement exists, and re-reading the same text to
        //      produce it again is the churn the seat's key was built to stop;
        //   2. the seat has spent its attempts. D-67 REVERSED the old one-run-per-vector rule: a refusal
        //      (a provider that cannot answer `SectionScores`) writes no rows, and under the old rule the
        //      closed run spent the claim, so a vector that was Clean at the moment of one bad answer
        //      stayed unscored until a Writer happened to rewrite it — a clean book stranded by plumbing.
        //      A refusal now re-arms, and `SECTION_SCORE_ATTEMPT_CAP` is what stops a permanently broken
        //      provider from buying a Reader every sweep; and
        //   3. a live run already holds the key (`candidate`'s `isClaimed` guard below covers this too —
        //      the closed-run count is the one this branch has to read).
        const scored = scoredVectorHashes(store, story.id).has(reviewed.vector_hash);
        const attempts = runsForItem(store, key).filter((run) => !isLiveRun(run)).length;

        if (!scored && attempts < SECTION_SCORE_ATTEMPT_CAP) {
            const built = candidate(
                store,
                story,
                'score_sections',
                'reader',
                { kind: 'summary', ref: summaryRef },
                key,
                `Reader scores all ${groups.length} sections of the reviewed Overview at clean vector ${reviewed.vector_hash} (D-65, D-67)`,
                2,
                {
                    toolMode: 'none',
                    responseSchema: { name: SECTION_SCORES_SCHEMA_NAME, schema: SectionScoresSchema },
                    // All five, always: the answer must name every group exactly once
                    // (`phrase/section-scores.ts` refuses an incomplete run), and consistency with the
                    // OTHER sections is one of the three things each section is judged on.
                    groupRefs: allRefs,
                    // The reader's own consistency angle: it is the built-in whose role prompt is about
                    // the contract chain holding across artifacts, which is what a cross-section score is.
                    // The scoring rules themselves are engine-owned text (`SECTION_SCORE_INSTRUCTION`), so
                    // an Author rewriting this template cannot lose the contract.
                    templateRef: 'reader-consistency',
                    roleName: 'reader'
                }
            );

            if (built !== undefined) {
                // Ranked BEFORE the priority-2 Critic seats (whose rank is 0), for the reason in the
                // header: the number is the fastest progress surface the rail has, and the dispatch
                // tie-break would otherwise sort the alphabetically-earlier review seats first.
                built.rank = -1;
                out.push(built);
            }
        }
    }

    // -- 2c. The Editor's judgement: may this section be frozen as finished text? (R3/T6b) --------
    // One Editor pass per CLEAN section per CLEAN vector, asking one question with one reason: may this
    // section's current clean text be LOCKED — fixed, from now on, as the consistency evidence every
    // other section is revised against? It is the crew-side half of `Story.editor_group_locking` (absent
    // = OFF, and OFF means this loop produces nothing at all: no seat, no run, no lock). The write itself
    // is not here — it is `phrase/locks.ts:lockPhraseGroup`, called by the settle — and so is every rule
    // that decides eligibility: `loop/editor-lock.ts:editorLockSeatTargets` folds the Setting, the clean
    // selection, this section's Reader row, the Writer hold and the already-locked state into ONE pass,
    // which is also what the prompt renders and what the settle re-runs.
    //
    // WHY ONE SEAT PER SECTION AND NOT ONE PER BOOK: a lock is a judgement about ONE section, so a pass
    // that answers "not yet" for `tone` must not stop `premise` from being frozen, and a pass that freezes
    // `premise` must not spend `tone`'s turn. The group id is IN the key (`wi_group_lock_<vector>_<group>`)
    // for that reason, and the vector half of it is what re-arms a decided seat when the Clean selection
    // ADVANCES — the only event that makes the question worth asking again.
    //
    // WHY THIS WORK IS NEVER OWED: the seat is an offer, not a debt. `phrase/exclusion.ts`
    // `:GROUP_PIPELINE_RUN_PREFIXES` and `:groupPipelineOwed` deliberately do not know this family, so the
    // drain probe never counts it, sign-off never waits on it, and the hill-climb never reads the flag.
    // A book where the Editor answers `false` five times — or is never asked, on a Story that left the
    // Setting off — drains and signs off exactly as it did before R3/T6b. That is why this seat may sit
    // LAST in its class, below work the pipeline actually owes.
    for (const evidence of editorLockSeatTargets(store, story)) {
        const key = groupLockSeatKey(evidence.vector_hash, evidence.group.id);

        // 1. Spent: any run already carries this exact seat key on this Story (see
        //    `editor-lock.ts:groupLockSeatSpent` for why the read is story-scoped). A CLOSED run retires
        //    the seat whichever way the answer went — `false` is a decision, not a failure — and only an
        //    advance of the clean selection brings it back. A LIVE run counts too: the section is already
        //    being decided, and queueing a second opinion on one freeze is the churn the key exists to stop.
        if (groupLockSeatSpent(store, evidence)) continue;

        // 2. The text is moving UNDER the seat — and only a DRAFT pass can move it.
        //    `phrase/exclusion.ts:GROUP_HOLDING_KINDS` is the domain's answer to "which kind can install a
        //    group" (`draft_groups`, and nothing else), so it is the only family this skip may react to. The
        //    review, score and deep-check seats all carry EVERY group id in `groupRefs` while installing
        //    nothing; skipping behind those would let the Critic queue swallow the judgement seat every time
        //    a vector is owed a review, which is not a rule about locks — it is an accident of the key shape.
        //    A queued draft over THIS section is a real conflict: the words the Editor would freeze are not
        //    the words the next clean selection will stand behind, and a lock fixes a REVISION. Skipping is
        //    not a refusal and spends nothing — the install moves the vector, the key is that vector's hash,
        //    and the seat re-arms itself against the new one.
        if (out.some((job) => job.item.kind === 'draft_groups' && job.item.groupRefs?.includes(evidence.group.id) === true)) {
            continue;
        }

        const built = candidate(
            store,
            story,
            'group_lock',
            'editor',
            { kind: 'summary', ref: summaryRef },
            key,
            `Editor judges whether ${evidence.group.key} may be locked as finished text at clean vector ${evidence.vector_hash} (R3)`,
            2,
            {
                // No tools: the seat reads a compiled brief (the clean text, the Reader's rationale, the
                // live claims, the locked peers) and answers once. An Editor that could call
                // `phrase_group_lock` here would be a second, unaudited path to the same flag.
                toolMode: 'none',
                responseSchema: { name: GROUP_LOCK_SCHEMA_NAME, schema: GroupLockDecisionSchema },
                // EXACTLY one section — the seat's whole identity. `run/executor.ts` refuses a
                // `group_lock` item that names more, so a bug here surfaces as a refusal rather than as a
                // freeze of a section nobody was shown.
                groupRefs: [evidence.group.id],
                // The live claims the Editor weighed, so the brief renders the evidence behind each one and
                // the journal can show which claims this freeze retires (`lockPhraseGroup` closes the open
                // rows naming this section, exactly as an Author's lock does).
                findingRefs: evidence.open_claims.map((claim) => claim.id),
                // The prompt is compiled from its OWN slug (`run/phase1-prompt.ts:GROUP_LOCK_TEMPLATE_SLUG`
                // → `compileGroupLockPrompt`), so the row names the copy the run was actually shown, and an
                // Author editing the generic Editor template cannot quietly lose the freeze's rules. The slug
                // HAS a built-in row: `templates.ts:builtIn('editor-group-lock')` ships the `editor` role
                // copy and `templates.ts:DEFAULT_ASSIGNMENT` lists it, and
                // `run/phase1-prompt.ts:rolePromptOf` reads that prompt off the store's templates. The
                // stated-absence fallback is only for the case §8 allows (the Author deleted the row or
                // emptied its prompt), and `GROUP_LOCK_INSTRUCTION` carries the binding contract whichever
                // way the copy resolves (§5, R7).
                templateRef: GROUP_LOCK_TEMPLATE_SLUG,
                roleName: 'editor'
            }
        );

        if (built !== undefined) {
            // LAST in the priority-2 class (the Reader's score is -1, the Critic seats 0): the lock is an
            // adjudication OVER both of those, and when two seats are both eligible in one sweep the
            // freeze is the one whose absence costs the least — an unlocked section keeps being rewritten,
            // which is the loop's normal, healthy state.
            built.rank = 1;
            out.push(built);
        }
    }

    // -- 3. The deep cross-group review (§6.4 step 6, R5) -----------------------------------------
    // The tool-carrying pass, offered once the structured seats for this vector have all run: it is
    // the pass that turns "the Critic noticed something" into a FINDING with `group_refs` on it
    // (`tools/reader.ts:raiseFinding`), and R3's whole closure rule runs on that attribution.
    // `revisionRef` is deliberately absent — there is no draft row in this model; the brief carries
    // the composed Overview and the run reads the book with tools (R6's mirror keeps `readSummary`
    // honest).
    if (hasText && phrase !== undefined) {
        const reviewsFiled = groups.length > 0 && allReviewSeatsRun(store, vectorHash, critics);

        if (reviewsFiled) {
            for (let pass = 1; pass <= critics; pass += 1) {
                // Built by `phrase/exclusion.ts:groupCheckSeatKey`, the same builder
                // `phrase/reviewed.ts:stampCleanRevisions` reads the hash back from
                // (`groupCheckVectorHashOf`): the Clean verdict is only trustworthy if the seat that
                // claims a vector and the stamp that records it spell the key the same way.
                const key = groupCheckSeatKey(vectorHash, pass);

                if (runsForItem(store, key).length > 0) continue;

                const template = DEEP_REVIEW_TEMPLATES[(pass - 1) % DEEP_REVIEW_TEMPLATES.length];

                const built = candidate(
                    store,
                    story,
                    'check_unit',
                    'critic',
                    { kind: 'summary', ref: summaryRef },
                    key,
                    `Critic ${pass}/${critics} reviews the group Overview at vector ${vectorHash} against the Seed (R3, R5)`,
                    2,
                    {
                        groupRefs: allRefs,
                        templateRef: template,
                        roleName: 'critic',
                        // The group model's deep review (R3/R5): the artifact is the COMPOSED Overview,
                        // there is no draft row to name, and the one thing this pass must do that the
                        // legacy one never had to is say WHICH GROUPS each complaint is about. Without
                        // `group_refs` a finding means "the whole Overview" (the legacy reading) and the
                        // next Writer batch rewrites all five — the exact cost R2 exists to remove.
                        note:
                            `Critic pass ${pass}/${critics} on the installed group Overview at vector ${vectorHash}. THIS IS THE OVERVIEW, NOT PROSE, and it is composed from the book's Summary groups: ${groups
                                .map((group) => group.key)
                                .join(', ')}. THE SEED IS GENERAL, NOT AN OUTLINE: cost critical or major only on a contradiction you can QUOTE — the Seed, critical Knowledge, or the Overview's own promise and rules — or a central commitment the Seed states that it lacks. Added detail, an open Seed question, an unstated stake and unplanted setup are NOT defects. Word choice, sentence shape and register are a PROPOSAL (kind 'proposal', cost 'taste' or 'minor'), never a taste-cost Issue, because phase ③ writes the sentences. File the critical and major issues with raiseFinding on ${summaryRef}: detail (what is wrong and where), criterion, the quoted passage, the evidence line, the cost you believe — AND ` +
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

// ---------------------------------------------------------------------------
// PHRASE ② — the chapter group pipeline (T-W2)
// ---------------------------------------------------------------------------
//
// WHY THIS IS A SECOND GENERATOR RATHER THAN A PARAMETERISATION OF `phase1GroupCandidates`: the two
// lanes agree on every MECHANISM (the owed set, the finding-atomic batch, the vector-keyed seats, the
// attempt caps) and disagree on every SENTENCE — the Writer answers plotpoints instead of prose, the
// Critic judges a chapter chain instead of an Overview, the Editor locks a contract instead of a
// section, and the gate at the top is an accepted PLOTLINE brief rather than a Seed brief plus the
// research leg. Threading one flag through phase ①'s generator would have rewritten the bytes of every
// summary job that 1772 tests pin, to save a hundred lines. The RULES are still shared: every read here
// goes through the same `phrase/exclusion.ts` predicates, and the claim keys are the same families.
//
// THE CLAIM-KEY DISJOINTNESS, spelled out because it is the one thing a restart can corrupt:
//   * `structure_seed`    — `wi_structure_plotlines_<phrase seed hash>` (records.ts), a DIFFERENT family
//     from `wi_structure_seed_<seed hash>`: the two phrases can hold the same text, and one family would
//     let phase ①'s accepted structuring silently satisfy Phrase ②'s;
//   * `draft_groups`      — `wi_draft_groups_<claim ref>_<group set hash>_<attempt>`, where the ref is
//     the phrase ROW id (`controller.draftClaimRef`, seam S8) instead of the `summaries` row id. Two
//     batches on one book therefore never spend each other's attempts;
//   * `review_groups`, `score_sections`, `group_check`, `group_lock` — the SAME families as phase ①,
//     because each is keyed on the group VECTOR, and a vector is a map of THIS phrase's group ids
//     (`groupRevisionVector(store, storyId, phraseId)`). Two phrases' vectors cannot collide: their
//     groups are different rows, so their hashes are different numbers.
//
// WHAT IS DELIBERATELY NOT GENERATED HERE: the Researcher's fix-prerequisite queue
// (`phase1FixPrerequisites`) and the sampling gates. Phrase ② has no research leg — the Seed's pass
// settled what the world facts are — and the classic phase-② `write_unit`/`select` pair is suppressed
// while the book is group-managed (`generateWork`, T-W2 + T-W2b), because the chapter contract IS
// installed by the draft job and there is nothing for an Editor to choose between. The suppression
// covers BOTH classic write legs — the blind draft pair (`wi_write_<ref>_<gen>_a<n>`) and the
// finding-armed fix pair (`wi_fix_<unit>_*`) — because R2 allows ONE writing surface per entry: a
// classic Writer holding `editPlotline` against a mirrored row writes the contract out of band, and
// the mirror only syncs on install. The classic READING legs stay (the `check_unit` trio, the Editor's
// `verify_findings`, `whole_story_check`, the drain probes): a reader is not a writing surface, and
// the findings it files are routed onto the chapter groups (`tools/reader.ts:raiseFinding`) so they
// arm work through revise → install → mirror.
//
// THE ONE GAP WORTH NAMING: a phase-② `fix` task with no FINDING behind it (a hand-armed row) drives no
// group work, because `groupWorkTargets`' two reasons are "never written" and "an open finding owes it".
// The classic path would have put it in a `write_unit` brief. In group mode the row simply holds the
// drain until the Author or the Editor resolves it, which is the fail-closed answer.

/**
 * Phrase ②'s jobs, in the pipeline's own order. Every one of them is PHRASE-SCOPED: the groups are the
 * Plotlines phrase's rows, the vector is that phrase's, and the clean selection is that phrase's.
 */
export function phase2GroupCandidates(store: Store, story: Story): WorkCandidate[] {
    const out: WorkCandidate[] = [];
    const phrase = storyPhraseByKey(store, story.id, PHRASE_PLOTLINES_KEY);

    // An unstarted Phrase ② has no seed and no entries, so there is nothing to structure and nobody to
    // draft. Starting it is an AUTHOR act (the compiled Summary is pushed in, or the Author types their
    // own text) — the loop cannot invent the seed the chapters will be read from.
    if (phrase === undefined) return out;

    const brief = currentPlotlineBrief(store, story, phrase);
    const groups = phraseGroupsOf(store, story.id, phrase.id);
    const seedHash = plotlinePhraseSeedHashOf(phrase, story);

    // -- 1. Structure the phrase seed (P5, one phrase down) --------------------------------------
    // One thread per phrase-seed hash, and it outranks everything below: with no accepted brief the
    // book has no chapter COUNT, so there is no entry set to draft and no arity to check an answer
    // against. `tools/plotlines.ts:structurePlotlines` is what satisfies it, and that call also
    // materializes `chapter_1..chapter_N` in the same commit.
    if (brief === undefined) {
        const built = candidate(
            store,
            story,
            'structure_seed',
            'editor',
            undefined,
            plotlinesStructureKeyOf(phrase, story),
            'structure the Plotlines Phrase seed into a chapter set before any contract is drafted (P5, D-3b)',
            0,
            {
                // The phase-② crew binds itself, exactly as phase ①'s structurer does: the unbound
                // Editor pool pick is `editor-general`, and this job is not that job.
                templateRef: 'editor-plotlines-structure',
                roleName: 'editor',
                // The seed and its hash travel in the note because the briefing renders it
                // (`run/brief.ts:renderJob`) and the tool refuses a hash it did not print. The clip is
                // the brief builder's, so the tail sentence — the one that says what to DO — is written
                // before the variable-length quote.
                note:
                    `Plotline structure: the PHRASE seed below is the text you are structuring — not the Story's Seed, and not the Summary's prose. Call structurePlotlines once with chapter_count, the number of chapters this seed resolves into, and seed_hash exactly as printed. The call also accepts the brief: that single write declares summaries.chapter_count and creates chapter_1..chapter_N, and every chapter contract is written against that set (D-3b). Never edit the phrase seed, never write a plotline yourself.\n\nPHRASE SEED (seed_hash=${seedHash}):\n${phraseSeedOf(phrase, story)}`
            }
        );

        if (built !== undefined) out.push(built);

        // Nothing below this line is answerable: the entry set is the brief's product.
        return out;
    }

    // An accepted brief with no entries means materialization never ran (a store restored from before
    // the entries existed, or a hand-created brief). The accept step is the only writer of the entry
    // set, so re-arming the structuring job is the honest answer — the same key, so one pass fixes it.
    if (groups.length === 0) return out;

    const allRefs = groups.map((group) => group.id);
    const critics = summaryCriticsOf(story);

    // -- 2. The Writer batch: chapter contracts, one pass per finding-set -------------------------
    // Same three cuts as phase ①, in the same order (R4's deferral, the per-group allowance, the
    // Author's dial between finding-sets), because all three live in `phrase/exclusion.ts` and the
    // drain probe reads those same predicates. The only difference is the namespace: `claimRef` is the
    // PHRASE ROW id (`controller.draftClaimRef`, seam S8) and the targets are this phrase's rows.
    const targets = groupWorkTargets(store, story, phrase.id);
    const claimRef = groupDraftClaimRef(store, story, phrase.id);

    if (claimRef !== '' && targets.length > 0) {
        const batch = planGroupDraftBatch(store, story, targets, phrase.id);

        if (batch.length > 0) {
            const batchRefs = batch.map((target) => target.group.id);
            const findingRefs = [...new Set(batch.flatMap((target) => target.findingRefs))];
            const family = `${GROUP_DRAFT_ITEM_PREFIX}_${claimRef}_${groupVectorHash(Object.fromEntries(batchRefs.map((ref) => [ref, 0])))}`;
            const attempts = store.runs
                .list()
                .filter((run) => run.story_id === story.id && (run.work_item_ref ?? '').startsWith(`${family}_`)).length;

            const built = candidate(
                store,
                story,
                'draft_groups',
                'writer',
                // `undefined` = the whole-Story artifact for this phase (`wholeStoryUnit('plotlines')`),
                // which is what a batch over SEVERAL chapters is. The Summary's lane names its one
                // `summaries` row because that row IS the artifact; the chapter lane's artifact is the
                // set of contracts the install mirrors, and no single ref covers it.
                undefined,
                claimKey(family, attempts + 1),
                `rewrite ${batch.length} chapter contract(s) — ${batch.map((target) => target.group.key).join(', ')} — in one structured pass (R2, R5)`,
                2,
                {
                    toolMode: 'none',
                    // PHRASE ②'s answer contract comes from the CONTROLLER, not from a constant here
                    // (seam S12): a chapter answer is plotpoints, and the arity the engine checks it
                    // against is the materialized chapter set rather than the catalog's five.
                    responseSchema: { name: CHAPTER_DRAFT_SCHEMA_NAME, schema: ChapterDraftSchema },
                    groupRefs: batchRefs,
                    findingRefs,
                    taskRefs: findingRefs
                        .map((id) => store.findings.get(id))
                        .flatMap((finding) =>
                            finding === undefined
                                ? []
                                : tasksForFinding(store, story.id, finding.id).map((task) => task.id)
                        )
                        .filter((id, index, all) => all.indexOf(id) === index),
                    templateRef: 'writer-plotlines-sampler',
                    roleName: 'writer'
                }
            );

            if (built !== undefined) out.push(built);
        }
    }

    // -- 3. The structured review of the installed chapter set ------------------------------------
    // Keyed by the CHAPTER vector, so an install re-arms every seat by itself and a cross-chapter
    // defect can be attributed to both ends of the chain it breaks.
    const vectorHash = groupVectorHash(groupRevisionVector(store, story.id, phrase.id));
    const hasText = groups.some((group) => group.revision > 0);

    if (hasText) {
        for (let pass = 1; pass <= critics; pass += 1) {
            // The same builder phase ① uses (`exclusion.ts:groupReviewSeatKey`) — the family is shared
            // and the vector is what keeps the two phrases' seats apart.
            const key = groupReviewSeatKey(vectorHash, pass);

            if (runsForItem(store, key).length > 0) continue;

            // Phase ② has no `critic-screening` in its pool (that row serves phase ①), so the seats
            // rotate the assigned phase-② Critic angles — the same four the deep review uses, and the
            // rotation is what makes N passes N different readers rather than N copies of one.
            const template = DEEP_REVIEW_TEMPLATES[(pass - 1) % DEEP_REVIEW_TEMPLATES.length];

            const built = candidate(
                store,
                story,
                'review_groups',
                'critic',
                undefined,
                key,
                `Critic ${pass}/${critics} reviews the installed chapter set at vector ${vectorHash} (R3, R5)`,
                2,
                {
                    toolMode: 'none',
                    responseSchema: { name: GROUP_REVIEW_SCHEMA_NAME, schema: GroupReviewSchema },
                    // Every chapter, not just the batch that moved the vector: a setup planted in
                    // chapter 2 and paid in chapter 7 is one issue naming both.
                    groupRefs: allRefs,
                    fixRefs: openFixTaskIds(store, story.id),
                    templateRef: template,
                    roleName: 'critic'
                },
                pass - 1
            );

            if (built !== undefined) out.push(built);
        }
    }

    // -- 3b. The Reader's score of the REVIEWED chapter set (D-65, gated by D-67) ------------------
    // One seat per CLEAN vector of THIS phrase. `cleanSelectionOf` scoped to the phrase is the whole
    // difference: a Summary clean selection says nothing about whether chapter 4's contract survived a
    // cross-chapter pass, and the hash the seat claims has to be the hash of the chapters it renders.
    const reviewed = cleanSelectionOf(store, story, phrase.id);

    if (reviewed.complete) {
        const key = sectionScoreClaimKey(reviewed.vector_hash);
        const scored = scoredVectorHashes(store, story.id).has(reviewed.vector_hash);
        const attempts = runsForItem(store, key).filter((run) => !isLiveRun(run)).length;

        if (!scored && attempts < SECTION_SCORE_ATTEMPT_CAP) {
            const built = candidate(
                store,
                story,
                'score_sections',
                'reader',
                undefined,
                key,
                `Reader scores all ${groups.length} chapter contracts of the reviewed Plotlines at clean vector ${reviewed.vector_hash} (D-65, D-67)`,
                2,
                {
                    toolMode: 'none',
                    responseSchema: { name: SECTION_SCORES_SCHEMA_NAME, schema: SectionScoresSchema },
                    groupRefs: allRefs,
                    // `reader-consistency` serves every phase, so the chapter seat uses the same crew as
                    // the Summary's: a cross-section score is exactly the contract-chain judgement this
                    // reader's role prompt is about.
                    templateRef: 'reader-consistency',
                    roleName: 'reader'
                }
            );

            if (built !== undefined) {
                built.rank = -1;
                out.push(built);
            }
        }
    }

    // -- 3c. The Editor's judgement: may this chapter contract be frozen? (R3/T6b) ----------------
    // The seat is an OFFER, never a debt (`groupPipelineOwed` does not know this family), and it is
    // armed only while `editor_group_locking` is on. Phrase-scoped, and the phrase scoping is load-
    // bearing here: an unscoped read would arm a chapter seat against the SUMMARY's clean selection and
    // the guard would refuse every one of them.
    for (const evidence of editorLockSeatTargets(store, story, phrase.id)) {
        const key = groupLockSeatKey(evidence.vector_hash, evidence.group.id);

        if (groupLockSeatSpent(store, evidence)) continue;

        if (
            out.some((job) => job.item.kind === 'draft_groups' && job.item.groupRefs?.includes(evidence.group.id) === true)
        )
            continue;

        const built = candidate(
            store,
            story,
            'group_lock',
            'editor',
            undefined,
            key,
            `Editor judges whether ${evidence.group.key} may be locked as a finished contract at clean vector ${evidence.vector_hash} (R3)`,
            2,
            {
                toolMode: 'none',
                responseSchema: { name: GROUP_LOCK_SCHEMA_NAME, schema: GroupLockDecisionSchema },
                groupRefs: [evidence.group.id],
                findingRefs: evidence.open_claims.map((claim) => claim.id),
                // The summary seat's own slug (`editor-group-lock`) serves phase ① only, so the chapter
                // seat runs on the general Editor crew. The engine-owned lock contract the compiler
                // appends is Phrase ②'s (`controller.instructions.lock`), which is the half that actually
                // binds the answer; the role copy is generic adjudication either way.
                templateRef: 'editor-general',
                roleName: 'editor'
            }
        );

        if (built !== undefined) {
            built.rank = 1;
            out.push(built);
        }
    }

    // -- 4. The deep cross-chapter review (§6.4 step 6, R5) ---------------------------------------
    // The tool-carrying pass, offered once the structured seats for this vector have reported: it is
    // the pass that turns "the Critic noticed a broken chain" into a FINDING carrying `group_refs`, and
    // R3's closure rule runs on that attribution. Without `group_refs` a complaint means "the whole
    // book" and the next batch rewrites every chapter.
    if (hasText) {
        const reviewsFiled = allReviewSeatsRun(store, vectorHash, critics);

        if (reviewsFiled) {
            for (let pass = 1; pass <= critics; pass += 1) {
                const key = groupCheckSeatKey(vectorHash, pass);

                if (runsForItem(store, key).length > 0) continue;

                const template = DEEP_REVIEW_TEMPLATES[(pass - 1) % DEEP_REVIEW_TEMPLATES.length];

                const built = candidate(
                    store,
                    story,
                    'check_unit',
                    'critic',
                    undefined,
                    key,
                    `Critic ${pass}/${critics} reviews the chapter contracts at vector ${vectorHash} against the phrase seed (R3, R5)`,
                    2,
                    {
                        groupRefs: allRefs,
                        templateRef: template,
                        roleName: 'critic',
                        note:
                            `Critic pass ${pass}/${critics} on the installed chapter contracts at vector ${vectorHash}. THESE ARE CONTRACTS, NOT PROSE, and the book composes them in chapter order: ${groups
                                .map((group) => group.key)
                                .join(', ')}. THE PHRASE SEED IS GENERAL, NOT AN OUTLINE: cost critical or major only on a contradiction you can QUOTE — the phrase seed, critical Knowledge, or a contract's own setups and payoffs — or a commitment the seed states that the chapter set lacks. Added detail, an open question the seed left silent and unplanted setup are NOT defects. A contract may be SPARSE and still correct: judge it as a contract, not as a scene nobody wrote, and never cost a note because you would have staged the chapter differently — phase \u2462 writes the sentences. ` +
                            `THE CHAIN IS THE THING TO CHECK: every payoff has a setup in an earlier chapter, every setup is collected in a later one, and a chapter that changes nothing leaves the book flat. Say which end is wrong and name the other end. File the critical and major issues with raiseFinding on ${story.id}: detail (what is wrong and where), criterion, the quoted passage, the evidence line, the cost you believe — AND ` +
                            "`group_refs` naming EVERY chapter the defect crosses, as the chapter group ids in the brief. A defect that crosses chapters is ONE issue naming both, because the repair is one decision about two contracts. Do not name a group you did not read a quote from, and never guess an id — an id the Story does not have is refused. File the goal verdict with submitVerdict at target_ref " +
                            `${story.id}; there is no draft row in this model, so do not invent one. Never edit the book (D-26, D-30, T-9). Do not propose Ideas. Minor notes are optional and must not keep you searching; once the issues that matter are reported, stop — an empty pass is valid.`,
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
 *   5. deep review      — priority 2, `check_unit` WITH tools, one pass per Critic on the selected
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
    const critics = summaryCriticsOf(story);

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
    // fails closed: the round is not allowed to call a defect answered that its own Critic is looking
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
        if (screens.length >= critics || attempts >= screeningCapOf(story) || live) continue;

        const built = candidate(
            store,
            story,
            'screen_samples',
            'critic',
            { kind: 'summary', ref: revision.unit_ref },
            claimKey(prefix, attempts + 1),
            `screen draft ${revision.id} (pass ${screens.length + 1} of ${critics}) — one structured turn, no tools (§6.4 step 4)`,
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
                templateRef: 'critic-screening',
                roleName: 'critic'
            }
        );

        if (built !== undefined) out.push(built);
    }

    // -- 5. Deep review (§6.4 step 6) -------------------------------------------------------------
    // The selected revision of the round whose selection just completed gets the real review: a
    // Critic WITH the tool catalogue, one pass per angle. `wi_review_` is a fresh family, so the
    // screening passes (no tools) and the review passes (tools) can never be confused in the ledger.
    const selected = selectedSummaryRevision(store, story.id);

    // T10/F7: one condition, shared with `records.ts:deepReviewPassesOwed` — the review is offered for
    // the CURRENT round's selection only. The records-level predicate is what the drain probe and the
    // sign-off read, so an Author-selected older-round draft is neither offered passes nor held open by
    // passes it was never owed (the round's `deepReviewRoundOf`, §6.4 step 6).
    if (selected !== undefined && isDeepReviewSelection(story, selected)) {
        for (let pass = 1; pass <= critics; pass += 1) {
            const key = deepReviewKeyOf(selected.id, pass);

            if (runsForItem(store, key).length > 0) continue;

            const template = DEEP_REVIEW_TEMPLATES[(pass - 1) % DEEP_REVIEW_TEMPLATES.length];

            const built = candidate(
                store,
                story,
                'check_unit',
                'critic',
                { kind: 'summary', ref: selected.unit_ref },
                key,
                `Critic ${pass}/${critics} reviews the selected Summary revision ${selected.id} against the Seed (phase ① deep review)`,
                2,
                {
                    // The one deep-review job that KEEPS its tools (D-26/D-30): the run may read the
                    // Summary, the Seed and the Knowledge to check a specific doubt.
                    revisionRef: selected.id,
                    templateRef: template,
                    roleName: 'critic',
                    note: `Critic pass ${pass}/${critics} on the selected Summary draft ${selected.id}. File TWO verdicts with submitVerdict: the goal verdict at target_ref ${selected.unit_ref} (the Goal’s own row) and the draft\u2019s own line at target_ref ${selected.id} (the crew panel\u2019s row). THIS IS THE OVERVIEW, NOT PROSE; THE SEED IS GENERAL, NOT AN OUTLINE: cost critical or major only on a contradiction you can QUOTE — the Seed, critical Knowledge, or the draft\u2019s own promise and rules — or a central commitment the Seed states that it lacks. Added detail, an open Seed question, an unstated stake and unplanted setup are NOT defects. A Summary is a set of facts, not prose: word choice, sentence shape and register are a PROPOSAL (kind 'proposal', cost 'taste' or 'minor'), never a taste-cost Issue, because phase ③ writes the sentences. The draft and the Seed are in the brief; call readSummary only if the brief does not carry the draft. Use tools to check a specific doubt — not to survey the book — and for a factual point one citable source is enough. File the critical and major issues with raiseFinding on ${selected.unit_ref}: detail (what is wrong and where), criterion, quoted passage, evidence line, and the cost you believe; name ${selected.id} in related_refs so the dashboard files each finding under this Overview; the draft line never replaces the Summary line. Never edit the book (D-26, D-30, T-9). Do not propose Ideas. A minor Issue and any Proposal are optional and must not keep you searching; once the issues that matter are reported, stop — an empty pass is valid.`
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

    // -- Phase ②, group-managed: structure → draft → review → score → lock (T-W2) -----------------
    // THE SWITCH IS THE PHRASE'S OWN DIAL (`story.plotlines_mode`), not the Story's and not the presence
    // of rows: a Story may run Phrase ① in the group model with Phrase ② still on the classic
    // `createPlotline` tools, and vice versa (`phrase/catalog.ts:isPhraseGroupManaged` says why the two
    // are separate). An ABSENT field reads `'classic'`, which is what every book written before Phrase ②
    // existed is, so every existing phase-② pin below keeps running untouched.
    //
    // The lane runs the classic verification legs ALONGSIDE it (`verify_findings`, `verify_ideas`, and
    // the drain probes further down): those answer "is this finding real / is this Idea sourced / is the
    // queue empty", which is orthogonal to WHO writes the contracts. What the lane does NOT run is the
    // per-unit trio below (`select`, `check_unit`, `write_unit`), because the batch job installs the
    // contracts and the Editor's choice between "competing drafts" is a choice this pipeline removed —
    // exactly the argument §6.5/P6 makes for phase ①'s samples, one phrase down.
    const plotlinesGroups = story.phase === 'plotlines' && isPhraseGroupManaged(story, PHRASE_PLOTLINES_KEY);

    if (plotlinesGroups) out.push(...phase2GroupCandidates(store, story));

    // T-W2b — THE SUPPRESSION NEEDS THE LANE, NOT JUST THE DIAL. `loop/engine.ts:2887` defaults
    // `plotlines_mode` to `'groups'`, so the flag above is true on every book whose Author never pushed a
    // Summary into Phrase ② — and the §4.3 tools, the `write_unit` pair, and the classic meaning of an
    // unscoped finding have to stay EXACTLY where they were for that book (the measured cost of getting
    // this wrong: the classic phase-② walk in `integration/slice-phases.test.ts` and the findings ladder
    // in `loop/findings.test.ts`, both green before this wave, both stalled by a dial-only reading).
    // `phrase/plotpoints.ts:plotlineLaneIsLive` is the gate the three suppressions below share: the DIAL
    // PLUS A STARTED PHRASE ROW (`phrase/catalog.ts:storyPhraseByKey` reads it — the row the Author's Start
    // verb wrote, NOT a materialized chapter set). The distinction is live between a start and the accepted
    // brief: a started phrase with no entries yet has no contracts, and "nothing installed yet" is not a
    // licence for the classic Writer to draft §4.3 rows out-of-band and have the install overwrite them.
    const laneWritesContracts = plotlinesGroups && plotlineLaneIsLive(store, story);

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
        // PHRASE ② GROUP MODE REMOVES THE SAME CHOICE (T-W2): the batch's install IS the selection —
        // `phrase/revisions.ts:installGroupRevisions` writes the accepted text and archives the previous
        // one in the same commit — so a `select` job here would adjudicate between rows that no longer
        // exist as a set. A classic phase-② Story (`plotlines_mode: 'classic'`) still gets it.
        if (story.phase === 'summary' || plotlinesGroups) continue;

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
    // its reply) grow with every Critic report, which is where a 1M-token thread came from; a
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
                // T5: the note used to say "confirm it when the defect is real", which told the Editor to
                // run the defect test on a row that is a PROPOSAL — and a proposal is never "real" in
                // that sense, so it came back disputed without anyone weighing it. The note now names both
                // questions; `run/brief.ts:jobStatement`'s `verify_findings` branch carries the full rule.
                note: `Verify finding ${finding.id} only. Confirm it when the defect is real or the proposal is worth a pass, approve it in the same run, and dispute it when it is not — no other finding belongs to this thread.`
            }
        );

        if (built) out.push(built);
    }

    // Phase ①'s independent second look. The Editor's verify/approval is not enough to spend a
    // Writer round: one Critic thread re-checks each confirmed or approved finding and calls
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

    // -- Readers: every competing draft, then any unit whose newest draft is unjudged -------------
    for (const unit of units) {
        // Phase ①'s review crew is the Critics above; a consistency reader here would be a
        // third opinion between the Critic and the Editor, which is not the loop the Author set.
        if (story.phase === 'summary') continue;

        // A unit mid-divergence is not worth judging yet: the Editor judges the SET of attempts together
        // (§6.2a's loop B), so a reader bought for draft 1 of 3 would be re-bought after every sibling
        // and would starve the drafts that are still owed (they rank below the reader's priority).
        if (divergenceGap(store, story, unit.ref, writerAttempts) > 0) continue;

        // T-W2b — THE INSTALL COUNTS AS THE WRITE. On this dial the contract was installed by the lane's
        // batch, so `needsReader`'s run-ledger test cannot see it and the unit would never be judged
        // (see `contractInstalledByPhrase`). The flag is scoped to the unit KIND the phrase owns — a
        // CHAPTER unit on the same book is phase ③ prose with a classic Writer leg, and a classic book
        // never sets it, so every pre-T-W2b answer is byte-for-byte unchanged.
        const writtenByPhrase =
            laneWritesContracts && unit.kind === 'plotline' && contractInstalledByPhrase(store, story.id, unit.ref);

        if (!needsReader(store, story, unit.ref, writtenByPhrase)) continue;

        // `unitIsChecked` accepts either verdict convention — per-draft verdicts, or unit-level verdicts
        // covering the count, which is what §8.3's `submitVerdict` actually writes because its
        // `target_ref` is the unit. Reading only the per-draft convention here would re-buy the same
        // reader pass on every sweep for a unit the Editor already has enough to choose between.
        if (unitIsChecked(store, story.id, unit.ref)) continue;

        const competing = competingRevisions(store, story.id, unit.ref);
        const unchecked = competing.filter((revision) => verdictsTargeting(store, story.id, revision.id).length === 0);

        // D-22's "the Editor chooses between drafts that have each been read" needs a rotation, not a
        // fixed order. Two facts force it: the capacity ceiling hands the sweep one launch at a time
        // (`globalMaxConcurrent`, and the rig runs 1), and §8.3's `submitVerdict` files its verdict
        // against the UNIT because `target_ref` is the unit (brief.ts / tools/editor.ts) — so no draft is
        // ever recorded as "already read", and the first competing draft wins every sweep. Measured: with
        // `attempts: 3`, three reader passes ran and all three were aimed at `revision_1`, while
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
                'reader',
                unit.ref === '' ? wholeStoryUnit(ctx.phase) : { kind: unit.kind, ref: unit.ref },
                claimKey(prefix, generation, revision?.id ?? 'unit'),
                revision === undefined
                    ? `judge ${label(unit)} against the phase Goal (P4)`
                    : `judge draft ${revision.id} of ${label(unit)} (§6.2a: verdicts per revision)`,
                2,
                // The reader brief renders the UNIT, not a competing draft (brief.ts:672 shows draft
                // bodies for `select`/`merge` only), so the draft this run is told to judge is named
                // in the job line the sweep writes. `listRevisions` is in every session's catalogue
                // (§8.2), which is how a reader reads the draft itself when the brief does not carry
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
    //
    // T-W2b — THE ONE WRITING SURFACE (R2) ALSO APPLIES HERE. A `wi_fix_<unit>_*` job is a classic
    // `write_unit` pass, and in group-managed phase ② the contract text belongs to the chapter group:
    // the fix reaches it through the lane's revise → install → mirror path, not through a Writer
    // calling `editPlotline` on the mirrored row. A classic fix pass there is worse than wasted: it
    // writes the artifact OUT OF BAND, so `phrase_groups.content`/`group_revisions` and the `plotlines`
    // row drift apart (the mirror only syncs on install), and the refusal ledger the Author reads fills
    // with phantom T-4/T-11 rows. The filter is scoped to the JOB'S KIND, so an approved finding
    // against a CHAPTER still buys its fix pass on a book whose prose phrase runs classic — the only
    // jobs removed are the ones whose unit is a contract the lane owns.
    const fixJobs = (story.phase === 'summary' ? [] : fixWork(store, story, ctx.phase)).filter(
        (job) => !(laneWritesContracts && job.kind === 'plotline')
    );

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

        // T-W2b — PHASE ② GROUP MODE HAS NO CLASSIC `write_unit` EITHER (the correction to T-W2): the
        // lane's `draft_groups` job writes the chapter contracts, and its install mirrors them onto the
        // `plotlines` rows. A classic draft pass here could only do one of two things — create an order
        // the install already holds (T-4) or edit the mirrored row out of band (divergence) — so the
        // candidate is not generated at all. The unit KIND is the scope, not the phase: a book whose
        // Plotlines phrase is group-managed still gets a classic `write_unit` for a CHAPTER unit, which
        // is phase ③'s prose and is not owned by Phrase ②. The reader trio above (`check_unit`) and the
        // Editor's `verify_findings` stay exactly as T-W2 left them — verification is not a writing
        // surface — and a `plotlines_mode: 'classic'` book keeps this leg (the flag is false).
        if (laneWritesContracts && unit.kind === 'plotline') continue;

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
        // `critic_confirmed` wait is gone with the per-finding confirmation thread (§6.4 step 6).
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
 * The whole-Story reader (§6.2's C-10/C-11/C-13 level, §5.2's `whole` level).
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
    // Only the pass's OWN verdicts count (records.ts:wholeStoryVerdicts) — a per-unit reader also
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
        'reader',
        { kind: 'chapter', ref: story.id },
        claimKey(prefix, generation, signature.slice(0, 40)),
        `judge the whole Story at the chapters→whole level once every chapter has been judged (§5.2, C-10/C-11/C-13)`,
        3
    );
}

/**
 * The drain probe's two jobs (L-37's condition 3, D-35b): one Critic round and one reader pass, and
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

    // A round that has STARTED must finish. L-37's condition 3 is one Critic round PLUS one reader
    // pass, and the second half is still owed when the first half came back with something: the
    // reader filing a finding breaks the preconditions (an unconfirmed finding is work), and a gate
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
    // job per sweep, so the Critic must survive the sweep that started the Reader. What must NOT
    // happen is the same job offered twice, so a probe job is offered only while it has never run —
    // unlike every other job kind, its "is it still needed?" answer cannot come from the artifact state,
    // because a clean round deliberately changes nothing (L-37). `round` only moves at the boundary
    // where the round is judged, so the pair is exactly one Critic round plus one Reader pass.
    const round = (loop.round ?? 0) + 1;
    const out: WorkCandidate[] = [];

    // THE PAIR'S CLAIM KEYS. Each half counts its OWN prefix (`wi_probe_critic_chapters_1`, `_2`, …),
    // and while a round is running the half already recorded on `ProbeState` keeps its id. The counter
    // is deliberately NOT `story.round`: L-15's round counter also moves on work cycles that are not
    // probe rounds (see engine.ts), and a key that moved mid-round would orphan the id the round was
    // stored with — which is exactly what L-37.3 reads to decide when a round is over.
    const next = (kind: 'critic' | 'reader') =>
        `wi_probe_${kind}_${phase}_${dispatchCount(store, `wi_probe_${kind}_${phase}`) + 1}`;
    const keys = {
        critic: (started ? loop.probe?.critic_item_id : null) ?? next('critic'),
        reader: (started ? loop.probe?.reader_item_id : null) ?? next('reader')
    };

    const critic = candidate(
        store,
        story,
        'write_unit',
        'critic',
        phase === 'chapters' ? undefined : wholeStoryUnit(phase),
        keys.critic,
        `fresh reading round ${round}: propose what is still wrong at the dial threshold (L-37, D-30)`,
        4,
        {
            note: `Drain probe round ${round}: read for anything at or above the Story's dial (${dialPhraseOf(story)}), and file it — an empty round is what ends this phase's work (L-37).`
        }
    );

    const reader = candidate(
        store,
        story,
        'check_unit',
        'reader',
        phase === 'chapters' ? undefined : wholeStoryUnit(phase),
        keys.reader,
        `drain probe round ${round}: one consistency pass at the dial threshold (L-37, D-35b)`,
        4,
        {
            note: `Drain probe round ${round}: judge the artifact against the phase Goal and file findings; nothing at or above ${dialPhraseOf(story)} means the round is clean.`
        }
    );

    // `candidate` returns undefined when the role's template cannot be resolved (a Story assigned a
    // critic template that no longer exists), and the round must not be recorded against a job that can
    // never run — that is how a probe would hang `running` forever (L-37.3).
    if (critic !== undefined && runsForItem(store, keys.critic).length === 0) out.push(critic);
    if (reader !== undefined && runsForItem(store, keys.reader).length === 0) out.push(reader);

    return out;
}

const dialPhraseOf = (story: Story): string => dialKeyOf(story).join('/') || 'nothing';
