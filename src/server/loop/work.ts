// Work generation: given one Story's records, what jobs should a crew run next (L-1 step 4, §6.2).
//
// The shape of the pipeline, per unit (summary, plotline set/plotline, chapter), is §6.2a's:
//
//   writers ×`attempts`  →  competing revisions  →  checkers ×M  →  an Editor selects  →  losers deleted
//
// Phase ① is the Author's refinement of that shape: the per-sample review crew is the Readers,
// and the Editor's own verification comes between their reports and the choice —
//
//   writers ×`summary_sampling`  →  competing revisions  →  readers ×`summary_readers` per draft
//     →  Editor verifies each report  →  Editor selects  →  one corrected draft of the same unit
//     →  its own Readers  →  the Editor again, until no valid critique remains.
//
// and the loop is DRIVEN BY RECORDS, never by a criterion that happens to be red. That distinction is
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
    dispatchableTasks,
    findingRefs,
    ideasToVerify,
    isClaimed,
    isLiveRun,
    last,
    liveRuns,
    maxConcurrentOf,
    templatesFor,
    openTasks,
    runsForItem,
    storyChapters,
    selectedSummaryRevision,
    storyPlotlines,
    storySummary,
    summaryBlockingFindings,
    summaryRoundTasks,
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
    DEFAULT_SUMMARY_READERS,
    DEFAULT_SUMMARY_SAMPLING,
    type RoleKind,
    type StoryPhase,
    type Story,
    type Task,
    type Template,
    type UnitKind,
    type Chapter
} from '../../shared/types';
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
 */
/** The generation encoded in `wi_write_<unitRef>_<generation>_a<attempt>`, or `undefined`. */
function writeGenerationOf(workItem: string | undefined, unitRef: string): number | undefined {
    const prefix = `wi_write_${unitRef}_`;

    if (workItem === undefined || !workItem.startsWith(prefix)) return undefined;

    const generation = Number(workItem.slice(prefix.length).split('_')[0]);

    return Number.isInteger(generation) && generation > 0 ? generation : undefined;
}

/** The highest Writer-round generation this unit has ever started. */
function summaryWriteGeneration(store: Store, unitRef: string): number {
    let highest = 0;

    for (const run of store.runs.list()) {
        const generation = writeGenerationOf(run.work_item_ref, unitRef);
        if (generation !== undefined && generation > highest) highest = generation;
    }

    return highest;
}

/** Attempts in one generation that have produced a draft (or are still writing one). */
function summaryAttemptsStarted(store: Store, unitRef: string, generation: number): Set<number> {
    const prefix = `wi_write_${unitRef}_${generation}_a`;
    const done = new Set<number>();
    const attemptOf = (workItem: string | undefined): number | undefined => {
        if (workItem === undefined || !workItem.startsWith(prefix)) return undefined;

        const attempt = Number(workItem.slice(prefix.length));

        return Number.isInteger(attempt) && attempt > 0 ? attempt : undefined;
    };

    const runById = new Map(store.runs.list().map((run) => [run.id, run]));

    for (const revision of store.revisions.list()) {
        if (revision.unit_ref !== unitRef) continue;

        const run = revision.run_ref === undefined ? undefined : runById.get(revision.run_ref);
        const attempt = attemptOf(run?.work_item_ref);

        if (attempt !== undefined) done.add(attempt);
    }

    for (const run of store.runs.list()) {
        if (!isLiveRun(run)) continue;

        const attempt = attemptOf(run.work_item_ref);

        if (attempt !== undefined) done.add(attempt);
    }

    return done;
}

/**
 * Phase ①'s gap: a round is `summary_sampling` COMPLETE drafts, and a new round starts only when
 * the selected Summary still has critical/major work (or the Author asked for one). Counting the
 * drafts, not the run rows, means a failed Writer attempt is retried instead of silently shrinking
 * the round — the old `runs.length` count could strand a two-of-three round forever.
 */
function summaryRoundGap(store: Store, story: Story, unitRef: string, attempts: number): number {
    if (attempts <= 1) return 0;

    const selected = selectedSummaryRevision(store, story.id, unitRef);
    const competing = competingRevisions(store, story.id, unitRef).length;
    // A current round must finish before a queued rewrite/merge is started. The Editor's choice
    // comes first; the Author's "another round" then starts from the chosen draft.
    const needsRound =
        selected === undefined ||
        (competing === 0 &&
            (summaryRoundTasks(store, story.id, unitRef).length > 0 ||
                summaryBlockingFindings(store, story, unitRef).some((finding) => finding.state === 'approved')));

    if (!needsRound) return 0;

    const highest = summaryWriteGeneration(store, unitRef);
    // While drafts are competing, the current generation is still being filled. Once it has been
    // chosen (or rejected), the next three drafts are a new generation.
    const generation = competing > 0 ? Math.max(1, highest) : highest + 1;
    const started = summaryAttemptsStarted(store, unitRef, generation).size;

    return Math.max(0, attempts - started);
}

function divergenceGap(store: Store, story: Story, unitRef: string, attempts: number): number {
    if (attempts <= 1) return 0;

    if (story.phase === 'summary') return summaryRoundGap(store, story, unitRef, attempts);

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
 * Phase ①'s sampling size: how many Writers expand one Seed.
 *
 * D-38a puts the count on the Author, and the Story row is where a per-book override lives so a
 * built-in template never has to be edited in place (D-17). The published standard is
 * {@link DEFAULT_SUMMARY_SAMPLING}, and it is the fallback the Summary pane's dial shows — so the
 * loop must use that same number when the Story has no override. Reading a template's `attempts`
 * here made the pane say "5 Writers" while an older persisted template ran 3.
 */
export function summarySamplingOf(story: Story): number {
    const raw = story.summary_sampling;

    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 1) return Math.floor(raw);

    return DEFAULT_SUMMARY_SAMPLING;
}

/** Phase ①'s Reader count per Summary draft (the Author's setting, standard five). */
function summaryReadersOf(story: Story): number {
    const raw = story.summary_readers;

    return typeof raw === 'number' && Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_SUMMARY_READERS;
}

/**
 * The claim keys of the Reader passes over one Summary draft.
 *
 * The key names the REVISION, not the unit: each Writer sample is read on its own, and a revised
 * draft is a new revision whose review starts immediately rather than inheriting the old one's.
 */
function readerKeysFor(revisionId: string, count: number): string[] {
    const keys: string[] = [];

    for (let index = 1; index <= count; index += 1) keys.push(`wi_read_${revisionId}_a${index}`);

    return keys;
}

/**
 * Has every Reader pass over this draft CLOSED? A pass that has run once is recorded by its run
 * row (the lease is the store, L-3); a live row is still reading, and the Editor must not choose
 * a draft while somebody is still reviewing it (the Writer → Reader → Editor order the Author set).
 */
function readerReviewComplete(store: Store, revisionId: string, count: number): boolean {
    return readerKeysFor(revisionId, count).every((key) => runsForItem(store, key).some((run) => !isLiveRun(run)));
}

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

    // -- Editors first: the choice (L-20) and the verification (D-33, D-27) -----------------------
    const templateAttempts = attemptsOf(templatesFor(store, story, 'writer')[0]);
    const writerAttempts = story.phase === 'summary' ? summarySamplingOf(story) : templateAttempts;
    const summaryReaders = summaryReadersOf(story);
    // Every unconfirmed finding is Editor work; only critical/major ones may HOLD the choice.
    const unconfirmed = unconfirmedFindings(store, story.id);
    const blockingUnconfirmed = unconfirmedBlockingFindings(store, story);

    for (const unit of units) {
        // The Author's phase-① order is Writer → Reader → Editor. An Editor choice waits until
        // every Reader pass over every competing sample has closed AND every critical/major
        // suspicion those Readers filed has an Editor verdict: the choice is the last step, not
        // the first look. Minor/taste notes are recorded, never show-stoppers (D-30, D-34).
        if (story.phase === 'summary') {
            const competing = competingRevisions(store, story.id, unit.ref);
            const reviewed =
                competing.length > 0 &&
                competing.every((revision) => readerReviewComplete(store, revision.id, summaryReaders));

            if (!reviewed || blockingUnconfirmed.length > 0) continue;
        }

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

    if (unconfirmed.length > 0) {
        const ids = unconfirmed.map((finding) => finding.id);
        const generation = dispatchCount(store, 'wi_verify_findings') + 1;
        const built = candidate(
            store,
            story,
            'verify_findings',
            'editor',
            wholeStoryUnit(ctx.phase),
            claimKey('wi_verify_findings', generation, `${ids.length}_${ids[0]}_${last(ids)}`),
            `${ids.length} unconfirmed finding${ids.length === 1 ? '' : 's'} need an Editor's verdict (D-33, L-1)`,
            1,
            { findingRefs: ids }
        );

        if (built) out.push(built);
    }

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

    // -- Phase ①: one Reader pass per sample, started the moment the sample exists ----------------
    //
    // The Author's order for the Summary is Writer → Reader → Editor. Each Writer attempt is a
    // competing revision, and a revision becomes reviewable the moment it lands — the sweep does
    // NOT wait for the other samples (the pipeline is per-draft, not per-stage). A revised draft
    // is a NEW revision and therefore gets its own fresh readers: the review of draft 2 is not
    // evidence about draft 3.
    if (story.phase === 'summary') {
        const summaryUnit = units.find((unit) => unit.kind === 'summary');
        // A job generated before the first Writer lands has no Summary row to name (the unit ref
        // is ''), but drafts always live on the row the tool created — `summary_1` — so the review
        // pass resolves the record first instead of asking for revisions of the empty ref.
        const summaryRef = storySummary(store, story.id)?.id ?? summaryUnit?.ref ?? '';

        if (summaryUnit !== undefined && summaryRef.length > 0) {
            const competing = competingRevisions(store, story.id, summaryRef);

            if (competing.length > 0) {
                const keys = competing.map((revision) => readerKeysFor(revision.id, summaryReaders));

                for (const [revisionIndex, revision] of competing.entries()) {
                    for (let pass = 1; pass <= summaryReaders; pass += 1) {
                        const key = keys[revisionIndex]?.[pass - 1];

                        if (key === undefined || runsForItem(store, key).length > 0) continue;

                        const built = candidate(
                            store,
                            story,
                            'check_unit',
                            'reader',
                            { kind: 'summary', ref: summaryRef },
                            key,
                            `Reader ${pass}/${summaryReaders} reads Summary draft ${revision.id} against the Seed (D-30, phase ①)`,
                            2,
                            {
                                revisionRef: revision.id,
                                note: `Reader pass ${pass} of ${summaryReaders} on draft ${revision.id}. The draft and the Seed are in the brief; call readSummary only if the brief does not carry the draft. Use tools to check a specific doubt — not to survey the book — and for a factual point one citable source is enough. File the critical and major issues with raiseFinding on ${summaryRef}: detail (what is wrong and where), criterion, quoted passage, evidence line, and the cost you believe; name ${revision.id} in related_refs so the dashboard files each finding under this Overview. Rate the draft with submitVerdict against ${revision.id}, and never edit the book (D-26, D-30, T-9). Do not propose Ideas. Minor/taste notes are optional and must not keep you searching; once the issues that matter are reported, stop — an empty pass is valid.`
                            },
                            // D-30's four angles: successive passes take different seats, and a fifth
                            // pass starts the rotation again rather than repeating one angle blindly.
                            revisionIndex + pass - 1
                        );

                        if (built) out.push(built);
                    }
                }
            } else if (
                draftedBefore(store, summaryRef) &&
                // An installed selection already went through the revision readers; this fallback is
                // only for a Summary that was written IN PLACE (a one-sample template or the loop
                // rig's tool double). Reading the installed text again would re-open the phase forever.
                !store.revisions.list().some((row) => row.story_id === story.id && row.unit_ref === summaryRef)
            ) {
                // A Summary written IN PLACE (no divergence: one sample, or a template with
                // `attempts: 1`) is still reviewed by Readers before the Editor. The installed
                // revision is the generation: an Author edit or a Writer fix re-arms the passes.
                const summary = storySummary(store, story.id);
                const revision = summary?.rev ?? 1;

                for (let pass = 1; pass <= summaryReaders; pass += 1) {
                    const key = `wi_read_${summaryRef}_r${revision}_a${pass}`;

                    if (runsForItem(store, key).length > 0) continue;

                    const built = candidate(
                        store,
                        story,
                        'check_unit',
                        'reader',
                        { kind: 'summary', ref: summaryRef },
                        key,
                        `Reader ${pass}/${summaryReaders} reads the installed Summary against the Seed (D-30, phase ①)`,
                        2,
                        {
                            note: `Reader pass ${pass} of ${summaryReaders} on the installed Summary ${summaryRef}. The Summary and the Seed are in the brief; use tools to check a specific doubt — not to survey the book — and for a factual point one citable source is enough. File the critical and major issues with raiseFinding on ${summaryRef}: detail (what is wrong and where), criterion, quoted passage, evidence line, and the cost you believe. Rate it with submitVerdict, and never edit the book (D-26, D-30, T-9). Do not propose Ideas. Minor/taste notes are optional and must not keep you searching; once the issues that matter are reported, stop — an empty pass is valid.`
                        },
                        pass - 1
                    );

                    if (built) out.push(built);
                }
            }
        }
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

    // -- Writers: the fix work a decision unblocked, then the drafts (§6.2's chapter pass) --------
    const fixJobs = fixWork(store, story, ctx.phase);

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

        // D-17d/D-38a: an ordinary fix pass is a correction, not an exploration, so it gets ONE
        // draft. Phase ① is the exception: every Summary round is a fresh sampling of
        // `summary_sampling` complete drafts, including a round started by an Author request or
        // an L-18 re-brief.
        const attempts =
            story.phase === 'summary' ? writerAttempts : trigger.trigger === WRITE_TRIGGERS.task ? 1 : writerAttempts;
        const prefix = `wi_write_${unit.ref}`;
        const generation =
            story.phase === 'summary'
                ? competingRevisions(store, story.id, unit.ref).length > 0
                    ? Math.max(1, summaryWriteGeneration(store, unit.ref))
                    : summaryWriteGeneration(store, unit.ref) + 1
                : divergenceGeneration(store, unit.ref);

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            const key = claimKey(prefix, generation, `a${attempt}`);

            // Each sibling runs exactly once per pass: unlike every other job kind, "is it still needed?"
            // cannot be answered from the artifact (a blind draft changes nothing the next one can see,
            // which is the point of L-16), so the run row is the only honest record of the sibling.
            //
            // PHASE ①'S EXCEPTION: a run that closed without filing a draft (model failure, empty
            // turn) must not shrink the round. The attempt is retried under the same claim key; a
            // live run or a revision it actually produced is the only thing that closes it.
            const runs = runsForItem(store, key);
            const produced =
                story.phase === 'summary' &&
                runs.length > 0 &&
                store.revisions.list().some(
                    (revision) =>
                        revision.unit_ref === unit.ref &&
                        revision.run_ref !== undefined &&
                        runs.some((run) => run.id === revision.run_ref)
                );
            const claimed = story.phase === 'summary' ? runs.some(isLiveRun) || produced : runs.length > 0;

            if (claimed) continue;

            const built = candidate(
                store,
                story,
                'write_unit',
                'writer',
                unit.ref === '' ? wholeStoryUnit(ctx.phase) : { kind: unit.kind, ref: unit.ref },
                key,
                `${trigger.trigger}: draft ${label(unit)} (attempt ${attempt} of ${attempts}, blind to the others — L-16)`,
                attempts > 1 ? 3 : 3,
                {
                    // L-16: the drafts must not see each other, so the note names the divergence and
                    // nothing else. L-18's re-brief line and D-29's selected Ideas come from the store
                    // (the brief renders them), not from here.
                    note:
                        attempts > 1
                            ? `Divergent draft ${attempt}/${attempts} of ${label(unit)}: no other draft is visible to you (L-16, P13).`
                            : `Draft ${label(unit)}.`,
                    ...(trigger.tasks.length > 0 ? { taskRefs: trigger.tasks.map((task) => task.id) } : {}),
                    ...(story.phase === 'summary'
                        ? {
                              findingRefs: summaryBlockingFindings(store, story, unit.ref).map(
                                  (finding) => finding.id
                              )
                          }
                        : {})
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
