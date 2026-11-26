// The loop's read layer: every query a sweep performs over the store, in one place.
//
// Why this is a module and not inline calls: the sweep touches ~15 record questions per Story
// (open tasks, unconfirmed findings, the dial's coverage, competing revisions per unit, fresh
// verdicts per revision, live runs per claim key, the assigned templates…). Keeping them here means
// the engine, the decision machine, and the tests all read the SAME definitions of "open",
// "awaiting the Author", "checked", and "claimed" — which is the whole content of L-37 and D-33/D-34,
// and the place a bug hides when two call sites disagree about it.
//
// Every function here is a pure read over the store handed to it (P1: the store is the only memory)
// and returns records in a STABLE order — sorts are by `order` then `id`, never by insertion order, so
// a sweep's dispatch order cannot shift between runs of the same store state (L-2's idempotence).
import {
    CLOSED_FINDING_STATES,
    CONFIRMED_FINDING_STATES,
    DISPATCHABLE_TASK_KINDS,
    ISSUE_HOLDING_STATES,
    OPEN_TASK_STATES,
    UNDECIDED_IDEA_STATES,
    type LoopChapter,
    type LoopDirective,
    type LoopStory
} from './types';
import { DEFAULT_SUMMARY_CRITICS, DEFAULT_SUMMARY_SAMPLING } from '../../shared/types';
import { seedHashOf } from '../../shared/seed-hash';
// PHRASE ② (T-W2): the phrase-seed read the Phrase ② gate needs. It comes from `phrase/catalog.ts`
// DIRECTLY, not from the `../phrase` barrel: the barrel re-exports `exclusion.ts` and `reviewed.ts`,
// both of which import this module, and `catalog.ts` imports nothing from `loop/**` — so this edge
// cannot close a cycle.
import { phraseSeedOf } from '../phrase/catalog';
import type {
    Chapter,
    Cost,
    Directive,
    Finding,
    Idea,
    Phrase,
    Plotline,
    PlotlineBrief,
    Proposal,
    Revision,
    Run,
    RunState,
    SampleReview,
    SeedBrief,
    Story,
    StoryPhase,
    SummaryReviewHistoryEntry,
    Task,
    Template,
    Verdict
} from '../../shared/types';
import type { Attribution, CommitEvent } from '../store';
import type { Store } from '../store';
// H1: the round's screening evidence becomes numbers in ONE place, and `./sample-select` owns that
// rule. The direction matters — `sample-select` imports only `shared/types`, so this import cannot
// cycle, and the selector stays readable without a store in it.
import { bestUnresolvedBlocking, eligibleSamples, requiresFixCertification, scoreSample, selectSample, type ScoredSample } from './sample-select';

// ---------------------------------------------------------------------------
// Attribution for the engine's own writes (P11, T-5)
// ---------------------------------------------------------------------------

/**
 * The engine writes as the machine, on its own account: no `run_ref` (no run did it, L-1/D-12a) and
 * no `author` flag, so the audit can tell a loop decision from an Author action from a run's write.
 * `why` is required and non-blank — the store refuses a write without one (T-5).
 */
export const loopAttr = (why: string) => ({ run_ref: null, why });

/**
 * The engine writes ON the Author's instruction (a lock, an approval, a backtrack, an edit). D-20a's
 * rule is that the Author's own action is a direct write rather than a proposal, because there is
 * nobody to approve it — `author: true` with `run_ref: null` is exactly that shape.
 */
export const authorAttr = (why: string) => ({ run_ref: null, author: true, why });

/**
 * Last element of an already-sorted read, or `undefined`.
 *
 * This package's tsconfig pins `lib` to `es5` + `es2015.collection` (see tsconfig.json), so
 * `Array.prototype.at` (ES2022) is not in scope — and the module system forbids a runtime shim
 * nobody asked for. One helper, one behaviour, used everywhere the loop wants "the newest row".
 */
export const last = <T>(rows: readonly T[] | undefined): T | undefined =>
    rows === undefined || rows.length === 0 ? undefined : rows[rows.length - 1];

// ---------------------------------------------------------------------------
// Story-level reads
// ---------------------------------------------------------------------------

/** The Story or a throw — every loop path is written for a Story that exists; a missing one is a bug. */
export function requireStory(store: Store, storyId: string): Story {
    const story = store.stories.get(storyId);

    if (story === undefined) throw new Error(`no story named ${storyId} — the loop has no record to run`);

    return story;
}

/** The same record, widened to the loop's additive fields (see `LoopStory` in ./types). */
export const loopStory = (story: Story): LoopStory => story as LoopStory;

/** §4.2's one Summary per Story. Undefined is a real state: phase ① has not produced it yet. */
export function storySummary(store: Store, storyId: string): import('../../shared/types').Summary | undefined {
    return store.summaries.list().find((summary) => summary.story_id === storyId);
}

/** §4.3, in chapter order — the order L-6a counts and the plotline jobs are dispatched in. */
export function storyPlotlines(store: Store, storyId: string): Plotline[] {
    return store.plotlines
        .list()
        .filter((plotline) => plotline.story_id === storyId)
        .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

/** §4.4, in chapter order. L-8: all of these are in flight together, so order is display and identity only. */
export function storyChapters(store: Store, storyId: string): Chapter[] {
    return store.chapters
        .list()
        .filter((chapter) => chapter.story_id === storyId)
        .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

/** The chapter widened to the loop's additive `undo_stack` (L-17a). */
export function loopChapter(store: Store, chapterId: string): LoopChapter | undefined {
    return store.chapters.get(chapterId) as LoopChapter | undefined;
}

/** §4.14 in creation order — a directive queue is read oldest-first (D-19 propagates in order). */
export function storyDirectives(store: Store, storyId: string): LoopDirective[] {
    return store.directives
        .list()
        .filter((directive) => directive.story_id === storyId)
        .sort(
            (left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id)
        ) as LoopDirective[];
}

export const directiveById = (store: Store, directiveId: string): Directive | undefined =>
    store.directives.get(directiveId);

// ---------------------------------------------------------------------------
// The queue (§4.7)
// ---------------------------------------------------------------------------

/** Tasks still waiting for a crew (L-37's condition 1). `blocked` is deliberately excluded. */
export function openTasks(store: Store, storyId: string): Task[] {
    return store.tasks
        .list()
        .filter((task) => task.story_id === storyId && OPEN_TASK_STATES.includes(task.state))
        .sort(taskOrder);
}

/** Queue order: priority first (1 is most urgent), then creation — stable, so dispatch is reproducible. */
function taskOrder(left: Task, right: Task): number {
    return left.priority - right.priority || left.id.localeCompare(right.id);
}

/**
 * The tasks a Writer or Editor can actually run (L-37's condition 1, "no task remains for a Writer").
 *
 * An `escalation` task is a question for the Author and an author_question row is `blocked`, so
 * neither counts here; a sign-off marker is the loop's own note, not a job. This filter is what makes
 * `drained` mean "no authorised work" rather than "no rows".
 */
export function dispatchableTasks(store: Store, storyId: string): Task[] {
    return openTasks(store, storyId).filter(
        (task) => DISPATCHABLE_TASK_KINDS.includes(task.kind) || task.owner_role !== undefined
    );
}

export const taskById = (store: Store, taskId: string): Task | undefined => store.tasks.get(taskId);

// ---------------------------------------------------------------------------
// Who owns a task (§4.7 `owner_role`, H2/R1)
// ---------------------------------------------------------------------------

/**
 * §4.7's `owner_role` is free text on purpose (P15), so ownership is compared as a trimmed,
 * lower-cased role kind. Absent or blank is the D-34 shape: `tools/editor.ts:approveFinding` opens an
 * approved finding's fix row with `owner_role: 'writer'`, and a row the loop opened without an owner is
 * the same Writer's work. `Task.owner_role`'s own doc names the five kinds this reads.
 */
export const taskOwnerRole = (task: Task): string => (task.owner_role ?? '').trim().toLowerCase();

/** The owners whose work a candidate Summary can actually be graded against (H2/R1). */
export const WRITER_FIX_OWNERS: readonly string[] = ['', 'writer'];

/**
 * The one non-Writer owner phase ① can EXECUTE. §6.4 step 2 already runs this role with the web tools
 * and `writeKnowledge`, so an external-fact prerequisite owned by it becomes a real Work Item instead
 * of a question a no-tool Critic is blamed for not answering.
 */
export const RESEARCH_FIX_OWNER = 'researcher';

/** Tasks whose `finding_ref` points at one finding — how an approved finding's fix work is found again. */
export function tasksForFinding(store: Store, storyId: string, findingId: string): Task[] {
    return store.tasks
        .list()
        .filter(
            (task) =>
                task.story_id === storyId && task.finding_ref === findingId && OPEN_TASK_STATES.includes(task.state)
        );
}

/**
 * F3 — the `fix` rows that STILL owe one finding, excluding the row that just settled.
 *
 * WHY THIS EXISTS: a finding's fix work can be split across owners — the live story_16 shape is
 * `finding_332` carrying a Researcher-owned grounding row (`task_187`) AND a Writer-owned repair row
 * on the same finding. Marking the finding `fixed` when only the research row settled removed a major
 * from the blocking set while the prose repair was still owed, and wrote a `fixed` row into the
 * closed-fingerprint history that the trend reads forever (L-16a: a re-raised fingerprint reads as a
 * regression, so a wrong `fixed` is not undoable by a later sweep).
 *
 * The invariant: a finding with N fix rows reaches `fixed` only when its LAST open row has settled.
 * `OPEN_TASK_STATES` (`open`/`claimed`) is the unfinished set — `done`/`wontfix` are settled, and a
 * `blocked` row is the crew asking the Author something, which is the Author's hold rather than
 * unfinished fix work (L-37's condition 1 reads it the same way). `settledTaskId` is excluded because
 * the caller updates its own row inside the same transaction; the compare-and-set ordering makes the
 * caller pass it explicitly rather than trusting store visibility.
 */
export function remainingOpenFixTasksForFinding(
    store: Store,
    storyId: string,
    findingRef: string,
    settledTaskId?: string
): Task[] {
    return store.tasks
        .list()
        .filter(
            (task) =>
                task.story_id === storyId &&
                task.kind === 'fix' &&
                task.finding_ref === findingRef &&
                task.id !== settledTaskId &&
                OPEN_TASK_STATES.includes(task.state)
        );
}

/** F3 — is this finding's fix work fully settled? Only when no OTHER open fix row still names it. */
export const findingFixWorkSettled = (
    store: Store,
    storyId: string,
    findingRef: string,
    settledTaskId?: string
): boolean => remainingOpenFixTasksForFinding(store, storyId, findingRef, settledTaskId).length === 0;

/** Tasks naming one unit as their subject, matched on the title/detail refs the loop writes. */
export function tasksForUnit(store: Store, storyId: string, unitRef: string): Task[] {
    return openTasks(store, storyId).filter(
        (task) => task.detail?.includes(unitRef) === true || task.title.includes(unitRef) === true
    );
}

/**
 * The Summary's draft history, oldest first. Phase ①'s rail is a flat Revision 1…N list:
 * every round adds `summary_sampling` drafts, the Editor keeps one, and the two it did not
 * keep stay in the book as `discarded` rows (not deleted).
 */
export function summaryRevisionsFor(store: Store, storyId: string, unitRef: string): Revision[] {
    return store.revisions
        .list()
        .filter(
            (revision) =>
                revision.story_id === storyId &&
                revision.unit_kind === 'summary' &&
                revision.unit_ref === unitRef
        )
        .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));
}

/**
 * The draft the Summary row currently carries. At most one Summary revision is `selected` per unit.
 *
 * `unitRef` is OPTIONAL because phase ①'s pipeline asks the Story-wide question ("which Summary
 * revision did the last selection install?" — §6.6) while the per-unit readers (the select brief,
 * the blocking-finding filter) ask it for one specific row. With no ref the whole Story's Summary
 * revisions are considered; a Story has exactly one Summary (§4.2), so the two agree in practice.
 */
export function selectedSummaryRevision(
    store: Store,
    storyId: string,
    unitRef?: string
): Revision | undefined {
    const rows =
        unitRef === undefined ? summaryRevisions(store, storyId) : summaryRevisionsFor(store, storyId, unitRef);

    return last(rows.filter((revision) => revision.state === 'selected'));
}

/**
 * Which draft one finding is ABOUT (T6/R2c, documents/specifications.md §15 step 11).
 *
 * `related_refs` is the only attribution a finding carries, and three different readers need the
 * same answer — the sign-off's blocking set, the verification queue, and the tool that raises the
 * finding — so the answer is computed once here rather than re-derived per call site:
 *
 *  - `selected`   — it names the draft the Summary row currently carries. Real work on the text the
 *                   Author would sign.
 *  - `superseded` — every ref names a Summary draft this Story has ALREADY HAD (the revision row
 *                   exists) and none of them is the carried draft: the defect was written about a
 *                   text the Summary no longer holds. It stays on the record as audit, but it neither
 *                   blocks the phase nor earns another verification pass, and re-running the review
 *                   over the kept draft cannot decide it (that is the treadmill).
 *  - `artifact`   — it names no draft at all, or names something that is not a Summary revision
 *                   (the Summary row itself, a criterion, a chapter). L-11a's legacy whole-Story
 *                   shape: it reads as a statement about the Summary as a whole, so it keeps the
 *                   blocking weight it always had — it must never be silently dropped.
 *
 * A ref that names a revision of ANOTHER story counts as `artifact` (conservative: unknown means
 * "keep blocking", never "quietly ignore").
 */
export type FindingRevisionScope = 'selected' | 'superseded' | 'artifact';

export function findingRevisionScope(store: Store, story: Story, finding: Finding): FindingRevisionScope {
    const related = finding.related_refs ?? [];

    if (related.length === 0) return 'artifact';

    // The Summary row's own id is a unit ref, not a revision, so it must never be mistaken for a
    // draft the finding is scoped to (L-11a's whole-Summary findings name it).
    const summaryRef = storySummary(store, story.id)?.id;
    const rounds = summaryRevisionRounds(store, story.id);
    const selectedId = selectedSummaryRevision(store, story.id)?.id;

    const namesDraft = related.filter((ref) => ref !== summaryRef && rounds.has(ref));

    // Every ref is a whole-Summary statement (no draft named): the legacy shape, and it blocks.
    if (namesDraft.length === 0) return 'artifact';

    return namesDraft.includes(selectedId ?? '') ? 'selected' : 'superseded';
}

/**
 * The findings that still block a Summary from being final: the blocking-cost findings on the
 * SELECTED draft. Findings on a discarded sibling are history, not work — the next Critic round
 * reads the kept draft fresh. Which costs block is `records.ts:summaryBlockingCost`: critical and major
 * always, and minor only when the Story's dial makes minor authorised work — so a dial that EXCLUDES
 * minor lets the Summary be signed with minors sitting open, and a dial that INCLUDES minor does not.
 * `taste` never blocks a Summary, in any phase (phase ③ owns the prose it would prefer between).
 */
export function summaryBlockingFindings(store: Store, story: Story, unitRef: string): Finding[] {
    const selected = selectedSummaryRevision(store, story.id, unitRef);

    if (selected === undefined) return [];

    return storyFindings(store, story.id).filter((finding) => {
        if (finding.state !== 'confirmed' && finding.state !== 'approved') return false;
        // NO `critic_confirmed` GATE (phase-1 research pipeline, §6.4 step 6): the tool-using deep
        // review IS the Critic's read of the selected revision, and the Editor's verification of
        // those findings is the acceptance that arms the next round. The classic pipeline's extra
        // per-finding confirmation thread was removed with it, so requiring the flag here would
        // make every finding invisible to the phase gate.
        // The Summary's phase-independent bar (`records.ts:summaryBlockingCost`): critical/major always,
        // minor only when the Author's dial makes minor real work, taste never.
        if (!summaryBlockingCost(story, finding.cost)) return false;

        // T6/R2c: the SAME attribution the verification queue and the raising tool read
        // (`records.ts:findingRevisionScope`). Only the two non-superseded answers keep blocking
        // weight, and their rules are exactly what this filter did before: a finding that names no
        // draft blocks only when its TARGET is this Summary (L-11a's legacy whole-Story shape), and
        // a finding that names a draft blocks.
        const scope = findingRevisionScope(store, story, finding);

        return scope === 'superseded' ? false : scope === 'artifact' ? finding.target_ref === unitRef : true;
    });
}

/**
 * Writer tasks a Summary round must answer: the fixes an Editor approved, the Author's
 * "another revision" request, and an L-18 re-brief. Merge requests are excluded — they are a
 * single Writer pass and are handled separately so they can run while drafts are competing.
 */
export function summaryRoundTasks(store: Store, storyId: string, unitRef: string): Task[] {
    return dispatchableTasks(store, storyId).filter(
        (task) =>
            task.kind !== 'merge' &&
            (task.detail?.includes(unitRef) === true || task.title.includes(unitRef) === true)
    );
}

/**
 * L-36/U-1b's "clear pending": decline every queued job without touching the findings behind it.
 * `wontfix` is §4.7's word for a task that will not be done, and the finding stays where the Author
 * left it, so the queue can be emptied without silently discarding a defect.
 *
 * T12/R3 GAVE IT A SECOND CALLER, and the only thing that differs is the JOURNAL SENTENCE: the Summary
 * accept closes the same queue for the same reason (the phrase is complete, so the jobs standing there
 * will not be done). The attribution stays optional so the L-36 caller keeps its exact sentence — a
 * default, not an overload, because the audit line is what tells a reader which act emptied the queue.
 *
 * OPEN MEANS `records.ts:OPEN_TASK_STATES` (`open` and `claimed`; `blocked` is an Author question and
 * `done`/`wontfix` are closed), and the ids come back in queue order so a caller can report the count it
 * acted on rather than a count it hopes for.
 */
export function wontfixTasks(
    store: Store,
    storyId: string,
    attribution: Attribution = loopAttr(`cleared the pending queue for ${storyId} (L-36, U-1b)`)
): string[] {
    const ids: string[] = [];

    for (const task of openTasks(store, storyId)) {
        store.tasks.update(task.id, { state: 'wontfix' }, attribution, [{ id: task.id, rev: task.rev }]);
        ids.push(task.id);
    }

    return ids;
}

// ---------------------------------------------------------------------------
// Findings (§4.10, D-33/D-34/D-35)
// ---------------------------------------------------------------------------

export function storyFindings(store: Store, storyId: string): Finding[] {
    return store.findings
        .list()
        .filter((finding) => finding.story_id === storyId)
        .sort((left, right) => left.id.localeCompare(right.id));
}

export const findingsIn = (findings: Finding[], states: Finding['state'][]): Finding[] =>
    findings.filter((finding) => states.includes(finding.state));

/** L-37's condition 2: every suspicion a Critic or reader raised must be confirmed or disputed. */
export const unconfirmedFindings = (store: Store, storyId: string): Finding[] =>
    storyFindings(store, storyId).filter((finding) => finding.state === 'unconfirmed');

/**
 * Phase ①'s blocking bar, as ONE predicate every reader of "does this defect stop the round?" shares
 * (D-30, D-34, D-35, and the hill-climb's minor rule).
 *
 * critical and major are blocking whatever the dial says — the Summary is a contract of facts, and a
 * broken fact costs a Writer round in any phase.
 *
 * `minor` is DIAL-DRIVEN, and dial-driven the SAME WAY on every path (the sweep's auto-approve, the
 * Editor's `approveFinding`, the arming rule, the sign-off and the drain): when the Story's
 * `auto_approve` covers minor, a confirmed Summary minor is authorised work — it creates fix tasks, it
 * arms the next revision, and the round may not stop with it outstanding. When the dial does NOT cover
 * minor, the note stays `confirmed` and NON-blocking: it never arms a revision, never holds the
 * sign-off, and the Story drains with it sitting there. Before this, the engine's sweep skipped
 * phase-① minors unconditionally while the Editor's tool approved them whenever the dial said so, so
 * the same finding was work on one path and a dead end on the other.
 *
 * `taste` is never blocking in phase ①, dial or no dial: the prose does not exist yet (phase ③ writes
 * it), so a preference between two phrasings of one commitment cannot cost a sampling round (R6).
 * Later phases keep D-33's all-costs rule.
 */
export const isBlockingCost = (story: Story, cost: Cost): boolean =>
    story.phase !== 'summary' || summaryBlockingCost(story, cost);

/**
 * THE SUMMARY'S OWN BAR, and it is deliberately PHASE-INDEPENDENT: the Summary is signed once, and its
 * blocking rows keep being read after the Story moved on (the phase sign-off, the Accept tick in
 * `story-nav.ts`, and phase ②'s chapter work all ask "does the carried Summary still hold a blocker?").
 * Reading `isBlockingCost` there would newly hold a signed Summary on a `taste` note the moment the Story
 * left phase ① — a cross-phase change nothing asked for.
 *
 * So: `critical` and `major` always; `minor` exactly when the Author's dial makes minor authorised work
 * (D-35's one dial, read the same way as `isBlockingCost`); `taste` never, because the prose it would
 * prefer between does not exist until phase ③.
 */
export const summaryBlockingCost = (story: Story, cost: Cost): boolean =>
    cost === 'critical' || cost === 'major' || (cost === 'minor' && dialCovers(story, 'minor'));

// ---------------------------------------------------------------------------
// D-33c/D-33d — the one predicate for "does this Story still hold an unresolved defect?"
// ---------------------------------------------------------------------------

/**
 * THE OPEN-DEFECT TEST FOR ONE ROW (D-33c, D-33d, and D-67's Clean read): `kind: 'issue'` — explicit
 * or absent, the legacy reading `tools/reader.ts:kindOf` and `tools/utilities.ts:findingFingerprint`
 * both give it — in a state that HOLDS work.
 *
 * THE HOLDING SET IS `ISSUE_HOLDING_STATES` (`loop/types.ts`): `unconfirmed`, `confirmed`, `approved`.
 * That is §4.10's own "Open means any of `unconfirmed`, `confirmed`, `approved` that is not yet
 * `fixed`" (specifications.md §4.10), and the same three the Author's rail lists
 * (`api/projections.ts`, `dashboard/components/story-contract.ts:OPEN_FINDING_STATES`). The phase-①
 * sign-off reads a NARROWER set and never a wider one: `summaryBlockingFindings` below keeps only
 * `confirmed` and `approved`, and only at a blocking cost (`summaryBlockingCost`), so a sign-off can
 * never block on more rows than this predicate calls open — an `unconfirmed` suspicion holds the FLOW
 * (D-33c) without holding the phase's lock, and the dial's `minor` rule narrows it once more.
 *
 * WHY STATE, NOT COST. The question D-33c answers is "is there a defect this book still has to
 * answer?", which is a different question from `isBlockingCost` — a `minor`/`taste` issue is still a
 * defect the crew named, and the Author asked that proposals wait behind issues, not only behind the
 * expensive ones.
 *
 * WHY `disputed` IS NO LONGER OPEN (2026-11-25, the owner's decision — "Not blocking — keep
 * flowing"). D-33's own principle is that a disputed claim is not a defect, and the repo already
 * treats it that way everywhere else: it drives no work (`phrase/exclusion.ts:345-354` — "a
 * `disputed`/`discarded`/`fixed` row drives nothing"), earns no seat (`loop/work.ts`'s verify queue
 * is `unconfirmed`-only, and `tools/reader.ts:confirmFinding` accepts only `confirmed`/`approved`),
 * never reaches the Author's desk (`records.ts:findingsAwaitingAuthor` wants `confirmed`), never
 * holds the drain (`loop/findings.test.ts:355`), never holds a chapter (`loop/engine.ts:898`) or the
 * sign-off (`records.ts:summaryBlockingFindings`), and the dashboard files it under "archived".
 * Counting it as open here was the one outlier, and it deadlocked silently: the row held the Critic's
 * proposal gate and the Editor's approval gate forever, while nothing in the pipeline could ever move
 * it and the rail truthfully showed "no open findings".
 *
 * THE AUTHOR STILL OWNS THE VERDICT. The overturn valves are untouched and the flow never waits on
 * any of them: the no-guard approve/discard routes (`api/routes.ts`), the completion-accept discard
 * sweep, and the group lock's voiding (`phrase/locks.ts:VOIDABLE_FINDING_STATES`, which still voids a
 * `disputed` row). The Editor's "not a defect" is D-34a's final triage FOR THE FLOW; an Author who
 * disagrees says so on the row, and the loop does not sit down in the meantime.
 *
 * The Clean-stamp half of this read (`phrase/reviewed.ts:openIssueGroupIds`) is documented as a
 * deliberate reader of THIS pair, so the reviewed-Overview veto, the rail's `blockingIssues` list and
 * the crew's gates all move in the same commit — which is what un-wedges a book stuck on a disputed
 * claim: its group stops being vetoed, the Clean stamp lands, the selection completes, and the
 * scoring seat arms.
 */
export const isOpenIssueFinding = (finding: Finding): boolean =>
    (finding.kind ?? 'issue') === 'issue' && ISSUE_HOLDING_STATES.includes(finding.state);

/**
 * Every unresolved DEFECT this Story carries, in the store's stable finding order (D-33c, D-33d).
 *
 * THIS IS THE ONE PLACE that question gets answered, and all four funnels read it — the Critic's
 * `raiseFinding` gate (`tools/reader.ts`), the Editor's `approveFinding` gate (`tools/editor.ts`), the
 * dial's auto-approve sweep and `engine.approveFinding` (`loop/engine.ts`), and the Author's approve-all
 * route (`api/routes.ts`). That singleness is the whole point, and it is the same reason this module
 * exists at all: two copies of "is an issue still open" is how the Critic ends up allowed to file what
 * the Editor refuses to approve, which is the exact divergence this rule set removes.
 *
 * It is STORY-scoped, never phase-scoped: a defect carried out of phase ① into phase ② is still
 * unresolved, and D-33c says nothing about which phase raised it.
 */
export function openIssueFindings(store: Store, storyId: string): Finding[] {
    return storyFindings(store, storyId).filter(isOpenIssueFinding);
}

/**
 * The findings ONE RUN filed — attributed by RUN through the journal, the same mechanism
 * `records.ts:revisionReviewFindings` and `researchPrerequisiteEvidence` use (D-33c's second rule).
 *
 * D-33c's no-mixing rule asks "did THIS pass already file a proposal?", and the answer is not on the
 * row: §4.10 has no `run_ref` field, and `related_refs` says what a finding is ABOUT, not who filed it.
 * The create event's `attribution.run_ref` is the fact (P11), so the journal is the only honest source.
 *
 * Only `create` counts. A D-16 re-sighting is a `seen_count` bump on a row an EARLIER pass filed, and
 * that pass — not this one — is what the row is attributed to; crediting the bump would let a Critic be
 * refused for filing an issue because it re-read a proposal some other round raised.
 *
 * An absent `runId` (an Author-invoked tool context with no run row, a direct test call) answers the
 * question "no run, so no pass to conflict with", which is the safe reading: the rule cannot hold work
 * the loop cannot attribute.
 */
export function findingsRaisedByRun(store: Store, storyId: string, runId: string | undefined): Finding[] {
    if (runId === undefined || runId === '') return [];

    return store.journal
        .filter(
            (event) =>
                event.collection === 'findings' &&
                event.op === 'create' &&
                event.attribution?.run_ref === runId
        )
        .map((event) => store.findings.get(event.id))
        .filter((finding): finding is Finding => finding !== undefined && finding.story_id === storyId)
        .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Phase ①'s bar is critical/major — plus `minor` when the Author's dial makes minor real work
 * (`records.ts:summaryBlockingCost`): a Critic may file clarity and description notes at `minor`/`taste`,
 * and the Editor records them, but they are not show-stoppers unless the dial authorises them. Those notes
 * must not hold the Editor's choice, the fix pass or the phase sign-off — only a suspicion that would
 * actually cost the Writer a pass does. Every other phase keeps D-33's all-costs rule, and keeps counting
 * a suspicion about a set-aside draft, exactly as it did before.
 *
 * T6/R2c adds the other half of the same question: in phase ① a suspicion that names a draft the
 * loop has ALREADY set aside (`records.ts:findingRevisionScope` → `superseded`) cannot hold this
 * round either. The review has no way to decide it — re-verifying re-reads the KEPT draft, which
 * never contained the defect — so the round would wait on a question that can never be answered.
 * The finding stays `unconfirmed` on the record (the Author still sees it); it is only removed from
 * this round's blocking set, exactly like a finding on a discarded sibling.
 */
export const unconfirmedBlockingFindings = (store: Store, story: Story): Finding[] =>
    unconfirmedFindings(store, story.id).filter(
        (finding) =>
            story.phase !== 'summary' ||
            (summaryBlockingCost(story, finding.cost) &&
                findingRevisionScope(store, story, finding) !== 'superseded')
    );

// ---------------------------------------------------------------------------
// Phase ①'s per-finding verification budget (D-33, T6/R2d)
// ---------------------------------------------------------------------------

/**
 * The anchored claim family of one finding's verification thread — trailing `_` included.
 *
 * `work.ts` mints the keys as `wi_verify_finding_<finding id>_<generation>`, and findings come from
 * one counter, so `wi_verify_finding_finding_1` is a PREFIX of `finding_10`'s family: the count has
 * to be anchored on the `_` or one finding's budget is spent by another finding's passes (the same
 * trap `records.ts:screenPrefixOf` documents for the screening family).
 */
export const verifyFindingPrefixOf = (findingId: string): string => `wi_verify_finding_${findingId}_`;

/**
 * Every run row in one finding's anchored verification family, live and closed.
 *
 * Both the budget count and the live check read THIS list, so "has the finding been sent `CAP` times"
 * and "is the last pass still in flight" cannot be computed from two different families (T10/F3).
 *
 * S-RUNTIME: scoped to the Story that OWNS the finding, read from the finding row itself. The family
 * name is built from a LOCAL id — one Story's `finding_3` and another Story's `finding_3` mint the same
 * `wi_verify_finding_finding_3_` prefix — so in a book holding several Stories one Story's passes would
 * spend another Story's budget, and the cap (and the escalation that follows it) would answer for the
 * wrong defect. A per-Story book (`store/story-stores.ts`) has one Story, where the scope is a no-op.
 *
 * The scope comes from the ROW rather than from a parameter because the finding's Story is a fact the
 * store already holds, and every caller (engine, work, projections) already has the finding in hand. A
 * missing row — the Story is being deleted, the book was edited by hand — answers "cannot tell", and the
 * scan stays unscoped so a post-delete audit read still returns the runs it is being asked about.
 */
export function verifyFindingRuns(store: Store, findingId: string): Run[] {
    const prefix = verifyFindingPrefixOf(findingId);
    const owner = store.findings.get(findingId)?.story_id;

    return store.runs.list().filter(
        (run) => (owner === undefined || run.story_id === owner) && (run.work_item_ref ?? '').startsWith(prefix)
    );
}

/**
 * Is one finding's verification thread still in flight? (T10/F3)
 *
 * The cap counts DISPATCHED passes, so the last pass the loop bought spends the budget the moment its
 * run opens — while it is still running, the Editor may be about to answer the finding right now. An
 * escalation is a question to the Author, and opening it mid-pass tells the Author the crew gave up on a
 * pass that has not finished; worse, a valid final Editor decision landing afterwards would leave a
 * resolved-looking question behind. Only the CLOSED ledger may say "undecided".
 */
export const verifyFindingLive = (store: Store, findingId: string): boolean =>
    verifyFindingRuns(store, findingId).some((run) => isLiveRun(run));

/** How many Editor verification passes one finding has already been sent for, live and closed. */
export const verifyFindingAttempts = (store: Store, findingId: string): number =>
    verifyFindingRuns(store, findingId).length;

/**
 * Has one finding used up its verification budget? The number lives with the sampling allowance it
 * mirrors (`records.ts:FINDING_VERIFY_CAP`).
 */
export const isFindingVerifyExhausted = (store: Store, findingId: string): boolean =>
    verifyFindingAttempts(store, findingId) >= FINDING_VERIFY_CAP;

/**
 * The phase-① findings the Editor has been sent at `FINDING_VERIFY_CAP` times and never decided.
 *
 * The queue (`work.ts`) stops offering them a job the moment the budget is spent; this is the list
 * the sweep escalates on, so the two halves cannot disagree about WHICH findings stalled. A finding
 * about a superseded draft is not here — it earns no job in the first place (R2c), so it must not
 * borrow the escalation of a finding that is still live.
 *
 * T10/F3 adds the second exclusion: a finding whose LAST bought pass is still running is not stalled
 * either. The budget is spent on the run count, so without this the sweep opened the Author's question
 * over the head of an Editor run that had not answered yet, and a decision arriving one commit later
 * would have had to close a row that should never have opened.
 */
export function findingsVerifyStalled(store: Store, story: Story): Finding[] {
    if (story.phase !== 'summary') return [];

    return unconfirmedFindings(store, story.id).filter(
        (finding) =>
            findingRevisionScope(store, story, finding) !== 'superseded' &&
            isFindingVerifyExhausted(store, finding.id) &&
            !verifyFindingLive(store, finding.id)
    );
}

/**
 * D-34: `confirmed` findings the dial does NOT cover — the pile on the Author's desk.
 *
 * PHASE ①'S BAR IS CRITICAL/MAJOR. A Critic may file clarity and description notes at
 * `minor`/`taste`, and the Editor records them, but they are not show-stoppers and never ask
 * the Author for an approval decision. The Summary round only carries critical/major work.
 */
export function findingsAwaitingAuthor(store: Store, story: Story): Finding[] {
    return storyFindings(store, story.id).filter(
        (finding) =>
            finding.state === 'confirmed' &&
            !dialCovers(story, finding.cost) &&
            !(story.phase === 'summary' && (finding.cost === 'minor' || finding.cost === 'taste'))
    );
}

/** D-35: `confirmed` findings the dial DOES cover — the sweep approves these on the spot. */
export function findingsToAutoApprove(store: Store, story: Story): Finding[] {
    return storyFindings(store, story.id).filter(
        (finding) => finding.state === 'confirmed' && dialCovers(story, finding.cost)
    );
}

/** Findings the crew may act on: approved, or confirmed and covered by the dial before it is approved. */
export function actionableFindings(store: Store, story: Story): Finding[] {
    return storyFindings(store, story.id).filter(
        (finding) => finding.state === 'approved' || (finding.state === 'confirmed' && dialCovers(story, finding.cost))
    );
}

/**
 * D-35's dial: which costs skip the approval wait. §4.1's `auto_approve` is a subset of the four
 * costs, so coverage is membership — no ordering, no threshold arithmetic (D-35b's threshold is the
 * SET, and §15 step 11 counts "nothing at or above `major`" as exactly "no critical and no major").
 */
export const dialCovers = (story: Story, cost: Cost): boolean => (story.auto_approve ?? []).includes(cost);

/** The dial as a sorted, stable string — stored on the probe so a widened dial invalidates it (D-35b). */
export const dialKey = (story: Story): string => [...(story.auto_approve ?? [])].sort().join(',');

/** L-15/L-16a: the fingerprints that are currently closed. */
export function closedFingerprints(store: Store, storyId: string): string[] {
    return storyFindings(store, storyId)
        .filter((finding) => CLOSED_FINDING_STATES.includes(finding.state))
        .map((finding) => finding.fingerprint);
}

/** L-15a: fingerprints with a CONFIRMED finding open — the only ones the trend and the stall consult. */
export function confirmedOpenFingerprints(store: Store, storyId: string): string[] {
    return storyFindings(store, storyId)
        .filter((finding) => CONFIRMED_FINDING_STATES.includes(finding.state))
        .map((finding) => finding.fingerprint);
}

/** L-22: the confirmed finding that has been open longest, for the stalled reason sentence. */
export function oldestConfirmedFinding(store: Store, storyId: string): Finding | undefined {
    const open = storyFindings(store, storyId)
        .filter((finding) => CONFIRMED_FINDING_STATES.includes(finding.state))
        .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));

    return open[0];
}

/** The records a finding touches: its own target plus `related_refs` (L-11a, D-33's propagation input). */
export function findingRefs(finding: Finding): string[] {
    return [finding.target_ref, ...(finding.related_refs ?? [])].filter(
        (ref) => typeof ref === 'string' && ref.length > 0
    );
}

// ---------------------------------------------------------------------------
// Ideas (§4.17, D-26…D-32)
// ---------------------------------------------------------------------------

export function storyIdeas(store: Store, storyId: string): Idea[] {
    return store.ideas
        .list()
        .filter((idea) => idea.story_id === storyId)
        .sort((left, right) => left.id.localeCompare(right.id));
}

/** The tray for one phase and one unit — what `decideIdea` resolves in a single pass (D-29, L-7a). */
export function ideaTray(store: Store, storyId: string, phase: StoryPhase, unitRef = ''): Idea[] {
    // The same undecided set the lock gate reads (`undecidedIdeas` below, `UNDECIDED_IDEA_STATES` in
    // types.ts): `decideIdea` can only decide rows that are still undecided, and a `verified` or
    // `refuted` row is exactly one of those (T-3b). The old local copy of this list was a third spelling
    // of the same four states.
    return storyIdeas(store, storyId).filter(
        (idea) =>
            idea.phase === phase && (idea.unit_ref ?? '') === unitRef && UNDECIDED_IDEA_STATES.includes(idea.state)
    );
}

/**
 * Ideas needing the Editor's fact-check (D-27: a sourced Idea must be verified before it can be picked).
 *
 * The predicate is the one the dispatch decision reads (loop/status.ts, loop/work.ts), so it is the
 * exact set §D-27 calls work: `proposed` (nothing decided yet), carrying `sources` (an unsourced Idea
 * is judged on guidelines, not fact-checked — C-15/editor.ts refuses to refute one), and with no
 * Editor answer on the row yet — `verification` absent OR null, because the store mints the column as
 * NULL and only `verifyIdea` writes a block. A row that has one is verified work, whatever its `state`
 * says, and re-dispatching it would burn an Editor pass on a claim somebody has already checked (the
 * same fact the Author's select gate consults, api/routes.ts's D-27 refusal).
 */
export function ideasToVerify(store: Store, storyId: string, phase: StoryPhase): Idea[] {
    return storyIdeas(store, storyId).filter(
        (idea) =>
            (idea.phase === phase &&
                idea.state === 'proposed' &&
                (idea.sources?.length ?? 0) > 0 &&
                // "No Editor answer yet". The store defaults the column to NULL (`verification: null`) while
                // `verifyIdea` writes a whole object, so BOTH spellings mean unverified — a strict
                // `=== undefined` read would never match a real Idea row and D-27 would silently never fire.
                idea.verification === undefined) ||
            idea.verification === null
    );
}

/**
 * L-7a / U-15 / D-29: the phase's Ideas TRAY — every row the Author has not decided.
 *
 * The state set is `UNDECIDED_IDEA_STATES` (types.ts:259): `proposed` is undecided by definition, and so
 * is every state the Editor's `verifyIdea` can move a row to — `verified`, `refuted`, `unverifiable`
 * (§4.17) — because the Editor's verdict answers "is the claim true?", never "is it in the book?"
 * (T-3b, D-29). A refuted Idea still needs the Author's discard and a verified one still needs the
 * Author's pick, so only `selected` / `discarded` / `deferred` leave the tray.
 *
 * This is the set the lock gate reads: U-15 says "the phase cannot be locked while it [the tray] is
 * non-empty", and the tray holds the rows carrying the Editor's verdict (a verified Idea is precisely
 * what the Author is meant to select), so gating on `state === 'proposed'` alone let a row escape the
 * tray the moment the Editor answered it — a verified-but-never-picked Idea vanished at the lock and was
 * deleted by D-36 without ever being decided, which is the "decision the machine made by silence" L-7a
 * exists to prevent. The dashboard's `lockCheck` already counts this set
 * (dashboard/components/story-contract.ts's `isDecidedIdea`), so the server's gate and the pane's Lock
 * button now agree.
 */
export const undecidedIdeas = (store: Store, storyId: string, phase: StoryPhase): Idea[] =>
    storyIdeas(store, storyId).filter((idea) => idea.phase === phase && UNDECIDED_IDEA_STATES.includes(idea.state));

/**
 * The tray reader `api/routes.ts` (the lock gate and the "tray is empty → sign-off" flip) and
 * `api/projections.ts` (the queue's `idea` rows) import under this name; both want EXACTLY the tray above,
 * so the predicate is widened here rather than duplicated at those two call sites, which are outside this
 * pass's ownership. `undecidedIdeas` is the name to prefer in new code.
 */
export const proposedIdeas = undecidedIdeas;

/**
 * The strict `proposed` set — NOT the tray. Kept for L-25b's leftovers count, which U-14 renders as
 * "what accepting discards" and which `api/projections.ts:completionPreview` computes the same way;
 * the tray itself is {@link undecidedIdeas} above (L-7a's lock gate).
 */
export const proposedOnlyIdeas = (store: Store, storyId: string, phase: StoryPhase): Idea[] =>
    storyIdeas(store, storyId).filter((idea) => idea.phase === phase && idea.state === 'proposed');

/**
 * L-36: Ideas whose fingerprint matches one the Author already decided — a repeat, reported not re-opened.
 */
export function repeatIdeas(store: Store, storyId: string, phase: StoryPhase): Idea[] {
    const decided = new Map<string, string>();

    for (const idea of storyIdeas(store, storyId)) {
        if (
            idea.phase === phase &&
            (idea.state === 'selected' || idea.state === 'discarded' || idea.state === 'deferred')
        ) {
            decided.set(idea.fingerprint, idea.id);
        }
    }

    return storyIdeas(store, storyId).filter(
        (idea) => idea.phase === phase && idea.state === 'proposed' && decided.has(idea.fingerprint)
    );
}

/**
 * D-36: the lock empties the tray — EVERY row of the phase, `selected` ones included (U-2, review fix 5).
 *
 * The carve-out this removes kept `state === 'selected'` rows alive, on the theory that an accepted
 * Idea is a record worth holding. It is not: the thing that was accepted became the phase's artifact
 * (an Idea that became a plotline is judged as a plotline, by C-1/C-2, and its provenance is the
 * journal), and a "tray" that still shows last phase's accepted rows breaks D-36 twice over — the
 * Author reads decisions as pending work, and L-7a's "the tray must be empty before a lock" stops
 * meaning anything the next phase asks it.
 */
export function deletePhaseIdeas(store: Store, storyId: string, phase: StoryPhase): number {
    const doomed = storyIdeas(store, storyId).filter((idea) => idea.phase === phase);
    let deleted = 0;

    for (const idea of doomed) {
        store.ideas.delete(idea.id, loopAttr(`locking phase ${phase} empties the Ideas tray (D-36)`));
        deleted += 1;
    }

    return deleted;
}

// ---------------------------------------------------------------------------
// Revisions and verdicts (§4.15, §4.9)
// ---------------------------------------------------------------------------

/**
 * Recency for records of the SAME collection, oldest first.
 *
 * `Collection.list()` hands back the Map's insertion order, which is creation order, and `Array#sort`
 * is stable — so comparing only `created_at` keeps that order exact even when two rows land in the same
 * millisecond. Ids cannot be used here: store.ts:293 mints them from a PER-collection counter, so
 * `verdict_9` collates AFTER `verdict_10` and a newest-last read goes wrong the moment a collection
 * passes nine rows (this is what made the whole-Story pass re-run forever in the §15 slice).
 */
function recency(left: { created_at: string }, right: { created_at: string }): number {
    return left.created_at < right.created_at ? -1 : left.created_at > right.created_at ? 1 : 0;
}

/** The journal `seq` that created one record, or -1 when the journal no longer holds that event. */
export function creationSeq(store: Store, id: string): number {
    for (const event of store.journal) {
        if (event.op === 'create' && event.id === id) return event.seq;
    }

    return -1;
}

/**
 * Whether `left` was created after a resolved journal POSITION (`rightSeq`), with `rightCreatedAt`
 * as the timestamp fallback — the ordering rule of {@link createdAfter} with the right-hand side
 * already resolved.
 *
 * The position is passed in rather than looked up because some "current text" markers are not rows
 * that were CREATED at that moment: `phrase/exclusion.ts:writeBaselineOf` anchors a group's write
 * allowance on the journal event that LAST wrote its text, which after a Seed reset
 * (`loop/engine.ts:editSeed`) is an `update` of the group row, not a create. Ids cannot express that,
 * and the same trimming rule applies: no journal, no answer from seq.
 */
export function createdAfterSeq(
    store: Store,
    left: { id: string; created_at: string },
    rightSeq: number,
    rightCreatedAt: string
): boolean {
    const leftSeq = creationSeq(store, left.id);

    if (leftSeq >= 0 && rightSeq >= 0) return leftSeq > rightSeq;

    return left.created_at > rightCreatedAt;
}

/**
 * Whether `left` was created after `right` — the freshness question across COLLECTIONS (a verdict
 * against a draft, one chapter's verdict against another's).
 *
 * Ids cannot answer it: every collection counts from 1 (store.ts:293), so `verdict_12 > revision_3`
 * says nothing about order. The journal is the store's one global order (P11), so its `seq` decides;
 * a row whose create event has been trimmed (a snapshot restored without its journal) falls back to
 * its timestamp.
 */
export function createdAfter(
    store: Store,
    left: { id: string; created_at: string },
    right: { id: string; created_at: string }
): boolean {
    if (left.id === right.id) return false;

    return createdAfterSeq(store, left, creationSeq(store, right.id), right.created_at);
}

/**
 * A draft a reviewer may read: `drafted` once its Writer run closed, and `competing` for rows a
 * store written before the pending/drafted lifecycle still carries (§4.15).
 */
export const isReviewableDraft = (revision: Revision): boolean =>
    revision.state === 'drafted' || revision.state === 'competing';

/** The competing drafts of one unit, oldest draft first — the order the select brief renders them in. */
export function competingRevisions(store: Store, storyId: string, unitRef: string): Revision[] {
    return store.revisions
        .list()
        .filter(
            (revision) => revision.story_id === storyId && revision.unit_ref === unitRef && isReviewableDraft(revision)
        )
        .sort(recency);
}

/**
 * L-37's condition 4 / L-20: any unit still waiting on an Editor.
 *
 * T6/R2b: a Summary draft the loop has ALREADY set aside is not competition. Selection deletes its
 * losers, but a draft that was still being screened when the Editor chose survives the delete, and
 * without this filter that dead draft keeps the Summary unit in this list forever — which holds both
 * the drain (§6.7's condition 4) and the phase sign-off over a Summary the Editor has already
 * chosen. Chapters keep counting every draft: there, competing drafts are the ordinary state.
 */
export function unitsWithCompetingRevisions(store: Store, story: Story): string[] {
    const units = new Set<string>();
    const rounds = summaryRevisionRounds(store, story.id);

    for (const revision of store.revisions.list()) {
        if (revision.story_id !== story.id || !isReviewableDraft(revision)) continue;
        if (revision.unit_kind === 'summary' && isSupersededSummaryDraft(store, story, revision, rounds)) continue;

        units.add(revision.unit_ref);
    }

    return [...units].sort();
}

/** The drafts a Writer is still writing — the units whose review has not started yet. */
export function unitsWithPendingRevisions(store: Store, storyId: string): string[] {
    const units = new Set<string>();

    for (const revision of store.revisions.list()) {
        if (revision.story_id === storyId && revision.state === 'pending') units.add(revision.unit_ref);
    }

    return [...units].sort();
}

/** Every verdict of one Story, oldest first (see {@link recency} for why that is the order). */
export function verdictsFor(store: Store, storyId: string): Verdict[] {
    return store.verdicts
        .list()
        .filter((verdict) => verdict.story_id === storyId)
        .sort(recency);
}

/** Verdicts naming one target (a unit ref or a revision id — the tool layer decides which it files). */
export function verdictsTargeting(store: Store, storyId: string, targetRef: string): Verdict[] {
    return verdictsFor(store, storyId).filter((verdict) => verdict.target_ref === targetRef);
}

/** The newest verdict naming one target, or undefined when nothing has judged it. */
export function latestVerdictFor(store: Store, storyId: string, targetRef: string): Verdict | undefined {
    return last(verdictsTargeting(store, storyId, targetRef));
}

/**
 * The verdicts the whole-Story pass filed (§5.2's `whole` level, C-10/C-11/C-13).
 *
 * The target ref alone cannot pick them out: the whole-level criteria are scoped to the STORY row
 * (criteria/engine.ts:scopeTargets), so an ordinary per-unit reader pass that files a Story-targeted
 * verdict would look like a finished whole-Story pass. The run behind the verdict is the honest marker
 * — the pass owns the `wi_whole_check` claim prefix (work.ts:wholeStoryCandidate).
 */
export function wholeStoryVerdicts(store: Store, storyId: string): Verdict[] {
    const passRuns = new Set(
        store.runs
            .list()
            .filter((run) => run.story_id === storyId && (run.work_item_ref ?? '').startsWith('wi_whole_check'))
            .map((run) => run.id)
    );

    return verdictsTargeting(store, storyId, storyId).filter((verdict) => passRuns.has(verdict.run_ref ?? ''));
}

/**
 * Has the loop looked at the whole Story in one pass at least once? The pass owns the `wi_whole_check`
 * claim prefix (work.ts:564), so the closed run row is the marker — not the verdicts it filed, because
 * a pass that reported nothing still happened (S-4).
 *
 * L-15's round boundary (b) asks this question: until the loop has seen the whole book once it has no
 * baseline for "unchanged", and counting flat rounds in that window is the L-37a inversion — a Story on
 * its way to being drained reads as stuck.
 */
export function wholePassClosed(store: Store, storyId: string): boolean {
    return store.runs
        .list()
        .some(
            (run) =>
                run.story_id === storyId && (run.work_item_ref ?? '').startsWith('wi_whole_check') && !isLiveRun(run)
        );
}

/**
 * A verdict is FRESH for a unit when it was written after the unit's newest competing draft: an old
 * pass's verdict cannot say a draft that did not exist yet has been judged (D-23, L-20).
 *
 * `after` is the draft ROW rather than its id, because verdict and revision ids come from different
 * counters and only the journal can order them against each other ({@link createdAfter}).
 */
export function freshVerdictsFor(
    store: Store,
    storyId: string,
    targetRef: string,
    after: { id: string; created_at: string }
): Verdict[] {
    return verdictsTargeting(store, storyId, targetRef).filter((verdict) => createdAfter(store, verdict, after));
}

/**
 * Whether every competing draft of one unit has been judged — the gate before an Editor is dispatched
 * (§6.2a: readers first, then the choice).
 *
 * Two target conventions are accepted on purpose: a reader that files against the REVISION id
 * (per-draft verdicts, which §6.2a's "verdicts per revision" reads as) and one that files against the
 * UNIT (which is what `submitVerdict`'s `target_ref` does today, §8.3). The rule is a count: at least
 * one fresh verdict per competing draft, whichever target the tool layer chose.
 */
export function unitIsChecked(store: Store, storyId: string, unitRef: string): boolean {
    const competing = competingRevisions(store, storyId, unitRef);

    if (competing.length === 0) {
        // Nothing competing: the unit is judged against its own stored artifact, and "checked" means a
        // verdict exists at all (a unit that has never been judged has never been reviewed).
        //
        // The SET-level unit (phase ② while the count is wrong, C-0/D-3b) has no ref of its own — the
        // set is judged at the STORY row, because that is what the set-level criteria are scoped to
        // (criteria/engine.ts:scopeTargets). Without that substitution the set would read as never
        // checked, and the sweep would buy a fresh `wi_check__N_unit` pass every sweep forever.
        return verdictsTargeting(store, storyId, unitRef === '' ? storyId : unitRef).length > 0;
    }

    const newest = competing[competing.length - 1];
    const unitVerdicts = freshVerdictsFor(store, storyId, unitRef, newest).length;

    if (unitVerdicts >= competing.length) return true;

    const perDraft = competing.filter((revision) => freshVerdictsFor(store, storyId, revision.id, revision).length > 0);

    return perDraft.length === competing.length;
}

// ---------------------------------------------------------------------------
// Phase ①'s research pipeline (§6.4: structure → research → sample → screen → select)
// ---------------------------------------------------------------------------
//
// The reads the pipeline's own gates are written in terms of. They live HERE rather than in
// ./work because three modules ask the same questions (the sweep's work generation, the drain
// preconditions in ./status, and the engine's settlement), and two spellings of "is the round
// finished?" is exactly the bug this file exists to prevent.

/**
 * Phase ①'s sampling size (§6.4 step 3): how many Writers expand one Seed Brief per round.
 *
 * D-38a puts the count on the Author, and the Story row is where a per-book override lives. The
 * published standard is `DEFAULT_SUMMARY_SAMPLING`, and it is the fallback the Summary pane's dial
 * shows — so the loop must use that same number when the Story has no override. Reading a
 * template's `attempts` here made the pane say "5 Writers" while a persisted template ran 3.
 */
export function samplingSizeOf(story: Story): number {
    const raw = story.summary_sampling;

    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 1) return Math.floor(raw);

    return DEFAULT_SUMMARY_SAMPLING;
}

/**
 * The retry allowance on top of a round's stage sizes (§6.4 step 3). A sampling run that returns
 * invalid JSON twice produces NO revision, so the ATTEMPT counter — not the revision count — is what
 * lets a stage try again; past this allowance the provider is not answering the schema and only the
 * Author can change that (the escalation in ./work).
 */
export const SAMPLING_RETRY_ALLOWANCE = 3;

/**
 * How many times the loop may send the Editor at ONE finding before it stops and asks the Author.
 *
 * `SAMPLING_RETRY_ALLOWANCE` is the loop's universal "the first attempt plus this many retries"
 * budget (§6.4 step 3), so the same grace applies here. Without a cap phase ①'s verify queue is a
 * treadmill: an Editor run that closes without calling a tool leaves the finding `unconfirmed`, and
 * an unconfirmed finding is a D-33 hold, so every sweep bought another pass on the same question
 * forever — the loop never drained, never stalled, and never told the Author (T6/R2d).
 */
export const FINDING_VERIFY_CAP = 1 + SAMPLING_RETRY_ALLOWANCE;

/**
 * The attempt cap of one round's SAMPLING family (§6.4 step 3): `summary_sampling` owed samples plus
 * the retry allowance. Read from here by `./work` (the dispatch gate and the wave-scoped exhaustion
 * read) and `./engine` (the selection gate and the wave re-arm), so those three call sites cannot
 * disagree about when a round is spent. `./status`'s drain sentence adds the same two numbers from
 * the allowance directly; the number is identical, and that file is outside this pass's ownership.
 */
export const samplingCapOf = (story: Story): number => samplingSizeOf(story) + SAMPLING_RETRY_ALLOWANCE;

/** Phase ①'s screening count (§6.4 step 4): how many screening Critics judge each sample. */
export function screeningSizeOf(story: Story): number {
    const raw = story.summary_critics;

    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 1) return Math.floor(raw);

    return DEFAULT_SUMMARY_CRITICS;
}

/**
 * The sampling round IN FLIGHT: one past the rounds that completed a selection (§6.6).
 *
 * This is the ONE round number supersession is measured against, on both sides of the wire — the
 * projection sends it as `sampling.active_round` (`api.ts:SamplingView`) so the dashboard compares
 * against the same integer instead of re-deriving it from `sampling.round` (T12/P1). The table, with
 * what `sampling_round` / `deepReviewRoundOf` say beside it:
 *
 * | state                                             | `sampling_round` | THIS | deep review |
 * | ------------------------------------------------- | ---------------- | ---- | ----------- |
 * | never selected (`?? 0`)                           | absent           | 1    | 1           |
 * | Author reset after round R (engine's scrap path)  | 0                | 1    | 0           |
 * | round R selected, nothing of R+1 written          | R                | R+1  | R           |
 * | round R+1 mid-flight (its drafts exist)           | R                | R+1  | R           |
 *
 * Before the first selection this is 1, which is why round 1's drafts are LIVE here and superseded
 * once a selection lands: the counter, not a timestamp, is the whole rule. Note the reset row — the
 * in-flight round is 1 while the deep review belongs to round 0, i.e. to no selection at all
 * (`isDeepReviewSelection` refuses, and the review is not owed).
 */
export const samplingRoundOf = (story: Story): number => (story.sampling_round ?? 0) + 1;

/**
 * Phase ①'s sampling WAVE for the round in flight (T12/E).
 *
 * A round that spent its sampling attempt cap leaves the spent runs behind, so the counter cannot
 * reset by itself; the Author's clear of the failure escalation is what re-arms the round, and the
 * wave is the generation that makes it possible: the sample claim prefix carries it
 * (`samplePrefixOf`), so a new wave starts at attempt 1 while every spent run row stays as audit.
 * `0` is the first wave — the absent field a Story written before the field existed reads as.
 */
export const samplingWaveOf = (story: Story): number => {
    const raw = story.sampling_wave;

    return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
};

/**
 * The WAVE-AGNOSTIC sampling family of one round — trailing `_` included (T10/F5).
 *
 * The wave sits AFTER the round in the key (`wi_sample_<summary>_<round>_w<wave>_<attempt>`), so the
 * wave-0 spelling of the prefix is the whole round's family: every wave's key starts with it. The
 * trailing `_` is what anchors the round, exactly as it anchors the screening family
 * (`screenPrefixOf`): round 1's prefix `wi_sample_s_1_` is NOT a prefix of round 10's
 * `wi_sample_s_10_1`, so a started round 10 can never be read as a started round 1.
 */
export const sampleRoundPrefixOf = (summaryRef: string, round: number): string => samplePrefixOf(summaryRef, round);

/**
 * Has one sampling round STARTED — did the loop already send the Writer for it? (§16.6, D-52)
 *
 * `stories.sampling_round` only advances on a COMPLETED selection (§6.6), so "started" is read from
 * the ledger rather than from the Story. T10/F5: it is read from the round's WHOLE family
 * (`sampleRoundPrefixOf`), NOT from the current wave. "Did this round ever sample?" is a fact about the
 * round, and a sampling-failure escalation the Author clears bumps `sampling_wave` underneath it: read
 * wave-scoped, a round with three drafts on the ledger and a fresh wave looks UNstarted, `samplingLegClosed`
 * refuses to close the leg, and the round strands its own drafts with the sign-off gated on a selection
 * that will never be offered. Wave-scoped counting stays where it belongs — the retry cap
 * (`sampleAttempts`) and the escalation's re-arm both read the ACTIVE wave only.
 */
export const samplingRoundStarted = (store: Store, story: Story, round: number): boolean => {
    const summaryRef = storySummary(store, story.id)?.id ?? '';

    if (summaryRef === '') return false;

    const prefix = sampleRoundPrefixOf(summaryRef, round);

    return store.runs.list().some((run) => run.story_id === story.id && (run.work_item_ref ?? '').startsWith(prefix));
};

/**
 * Is this round's sampling LEG closed — will nothing more be written before the Editor chooses?
 *
 * The attempt cap (§6.4 step 3, `samplingCapOf`) and the arming rule (D-49, §16.7) are the only two ways
 * a round stops sampling early, and both mean the same thing for the selection: the drafts that exist are
 * the drafts the Editor has to choose from.
 *
 * The `samplingRoundStarted` clause on the second arm is what keeps two different rules apart. A round
 * that was never armed and never sampled has nothing to select and must keep refusing — that is D-49's
 * release, and it is still honoured. A round that sampled and was then disarmed mid-flight must still
 * be allowed to close, or its own drafts strand with the sign-off gated on a selection that will never
 * come (D-52, §16.6/§16.7). Reading it from the ledger rather than from
 * the caller's guards is what makes the predicate safe to reuse.
 *
 * T10/F5 splits the two ledger reads the arms need, and they are deliberately NOT the same scope: the
 * cap arm counts the ACTIVE WAVE (that is the re-arm contract, T12/E), while the started arm reads the
 * round's whole family. A wave bump is a retry, not a new round — the drafts made before it are still
 * this round's, and a started round that cannot close strands them.
 */
export const samplingLegClosed = (store: Store, story: Story, round: number): boolean => {
    const summary = storySummary(store, story.id);

    if (summary === undefined) return false;

    return (
        // HILL CLIMB: the arm is the wave's CEILING, not the static cap — the ceiling grows while the
        // round keeps proving a lower unresolved count, and the no-progress streak closes the leg even
        // with attempts left, so a stalled round stops buying instead of burning the allowance.
        samplingBudgetSpent(store, story, round) ||
        (!samplingArmed(store, story, round) && samplingRoundStarted(store, story, round))
    );
};

/**
 * The sampling ROUND each Summary draft of this Story belongs to (§6.2a), and — because it is keyed by
 * draft id — THE definition of "this id is one of this Story's Summary drafts" that
 * `findingRevisionScope` reads.
 *
 * Three passes, in this order, and each one exists for a different real row:
 *   1. `revisions.round` — authoritative for every draft the pipeline wrote (§6.2a).
 *   2. `sampling_history` — the P11 audit line, the only surviving round for a draft the selection
 *      hard-deleted (P13/D-22), and for a row that predates the `round` field but was part of a
 *      COMPLETED round.
 *   3. every remaining Summary row at round `1` — the round-less legacy row that has neither (T12/P2).
 *      It must stay a MEMBER of the map, or a finding naming it reads as a whole-Story statement.
 *
 * A row that appears in none of them is not a draft of this Story: another Story's revision, the
 * Summary UNIT row, a Seed Brief or a criterion id stay unknown, and `findingRevisionScope` keeps
 * those blocking (unknown means "keep the weight", never "quietly ignore").
 */
export function summaryRevisionRounds(store: Store, storyId: string): Map<string, number> {
    const rounds = new Map<string, number>();

    for (const revision of summaryRevisions(store, storyId)) {
        if (typeof revision.round === 'number' && Number.isFinite(revision.round))
            rounds.set(revision.id, revision.round);
    }

    for (const history of storySamplingHistory(store, storyId)) {
        for (const sample of history.samples) {
            if (!rounds.has(sample?.revision_id)) rounds.set(sample.revision_id, history.round);
        }
    }

    // T12/P2 — the round-LESS rows are STILL drafts. A row written before §6.2a numbered rounds has
    // neither its own `round` nor a history line (the P11 audit only records COMPLETED rounds, and a
    // legacy selection may predate that too), and dropping it from the map made it an unknown id:
    // `findingRevisionScope` then answered `artifact` for a finding naming that very draft, and
    // `summaryBlockingFindings` weighted it only when its TARGET happened to be the Summary row — so a
    // blocker filed against the carried revision with `target_ref` = the revision went silent. The
    // dashboard's own map (`story-contract.ts:summaryScopeContext`) already counted such a row, which is
    // the second answer this pass removes. Membership is "this Story has a Summary draft with this id";
    // the VALUE is `1`, the same fallback `isSupersededSummaryDraft` and `roundRevisions` already apply
    // to a row with no round (§3.5) — and a legacy round-1 row is exactly that.
    for (const revision of summaryRevisions(store, storyId)) {
        if (!rounds.has(revision.id)) rounds.set(revision.id, 1);
    }

    return rounds;
}

/** The persisted selection audit of one Story, oldest round first (§6.6, P11). */
export type SamplingRound = NonNullable<Story['sampling_history']>[number];

export function storySamplingHistory(store: Store, storyId: string): SamplingRound[] {
    const story = store.stories.get(storyId);

    const history = story === undefined ? [] : story.sampling_history ?? [];

    return [...history].sort((left, right) => left.round - right.round);
}

/**
 * Is this Summary draft a LOSER of a wave the loop has already moved past? (T6/R2b, R2c)
 *
 * Selection hard-deletes its losers (engine.ts:trySelectSample), but a draft that was still being
 * screened when the Editor chose survives the delete: it never entered the candidate set the choice
 * was made from, and nothing else ever cleans it up. It sits in the active round's revision list
 * forever — a screening job that can never be answered, a competition that can never be decided,
 * and findings written about it that can never be confirmed.
 *
 * The rule is one comparison: the active round is `samplingRoundOf(story)` and the selection
 * history only records COMPLETED rounds, so a draft of an OLDER round that is still not `selected`
 * has been set aside by a choice the loop already made. `sampling_round` never goes backwards on
 * its own (only an Author reset clears it, engine.ts's reset path) and no tool writes a Summary
 * revision once the phase is signed off, so this cannot sweep up a draft the active round has yet
 * to review.
 *
 * THE FOUR STATES, stated once because the dashboard has to answer them identically (T12/P1, mirrored
 * by `story-contract.ts:isSupersededSummaryDraft`):
 *   - before the first selection (active round 1): round-1 drafts are LIVE — `1 < 1` is false;
 *   - after round R's selection, before anything of R+1 exists (active R+1): a leftover round-R draft
 *     is superseded — the loop moved on the moment it chose;
 *   - during R+1 (active R+1): R+1 drafts are LIVE and every older round is superseded;
 *   - an Author override that installs an OLDER round's revision changes WHICH draft the Summary
 *     carries, never the active round, so the rivals of that older round stay superseded — this
 *     predicate reads `sampling_round`, never `selectedSummaryRevision` (that is what
 *     `isDeepReviewSelection` owns, and the two must not be confused: an override can retire a review
 *     debt, it cannot re-arm a generation the loop already spent).
 *
 * A round-less legacy row takes round 1 from `summaryRevisionRounds` (its third pass), the same
 * fallback `roundRevisions` uses (§3.5), so both sides number it the same way.
 */
export const isSupersededSummaryDraft = (
    store: Store,
    story: Story,
    revision: Revision,
    rounds = summaryRevisionRounds(store, story.id)
): boolean => {
    if (revision.state === 'selected' || revision.state === 'discarded') return false;

    return (rounds.get(revision.id) ?? revision.round ?? 1) < samplingRoundOf(story);
};

/** §3.3: the Story's ACCEPTED Seed Brief, newest last. Undefined is a real state (nothing structured). */
export function acceptedSeedBrief(store: Store, storyId: string): SeedBrief | undefined {
    return last(
        store.seedBriefs
            .list()
            .filter((brief) => brief.story_id === storyId && brief.status === 'accepted')
            .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id))
    );
}

/**
 * The accepted brief that describes the Seed AS IT STANDS NOW (§3.3/§6.4 gate 1).
 *
 * A brief derived from an older Seed counts as NONE: `seed_hash` is the change detector, so an
 * Author edit of `stories.idea` (D-25a) re-arms the structuring and no sample may be taken from a
 * description of a book nobody is writing (P5). Comparing here rather than at every call site keeps
 * the gate one predicate.
 */
export function currentSeedBrief(store: Store, story: Story): SeedBrief | undefined {
    const brief = acceptedSeedBrief(store, story.id);

    return brief !== undefined && brief.seed_hash === seedHashOf(story.idea) ? brief : undefined;
}

// ---------------------------------------------------------------------------
// PHRASE ② — the Plotline brief (T-W2, Phrase ② step 1's gate)
// ---------------------------------------------------------------------------

/**
 * The hash every Phrase ② gate compares: the hash of the PHRASE's own seed.
 *
 * It is NOT `seedHashOf(story.idea)`. Phrase ② was built so that the two phrases are discrete
 * (`phrase/controllers/plotlines.ts`'s start step COPIES the text handed to it), and `phraseSeedOf`
 * is the one read that interprets `phrases.seed` (seam S2). Importing it straight from
 * `phrase/catalog.ts` rather than from the `../phrase` barrel is deliberate: the barrel reaches
 * `exclusion.ts` and `reviewed.ts`, which import THIS module, so the direct path is what keeps the
 * loop's read layer free of an initialization cycle.
 */
export const plotlinePhraseSeedHashOf = (phrase: Phrase | undefined, story: Story | undefined): string =>
    seedHashOf(phraseSeedOf(phrase, story));

/**
 * The accepted Plotline brief that describes this phrase's seed AS IT STANDS NOW — Phrase ②'s
 * equivalent of {@link currentSeedBrief}, and the gate every chapter job waits behind.
 *
 * A brief for an older phrase seed counts as NONE, which re-arms the structuring pass exactly the way
 * a Seed edit re-arms phase ①'s (P5, one phrase down). The scope is the PHRASE ROW, not the Story: a
 * book whose Phrase ② was replaced keeps the retired brief of the phrase it no longer has, and reading
 * by `story_id` alone would let that stale structure gate a fresh phrase.
 */
export function currentPlotlineBrief(
    store: Store,
    story: Story,
    phrase: Phrase | undefined
): PlotlineBrief | undefined {
    if (phrase === undefined) return undefined;

    const hash = plotlinePhraseSeedHashOf(phrase, story);

    return store.plotlineBriefs
        .list()
        .find(
            (brief) => brief.phrase_id === phrase.id && brief.seed_hash === hash && brief.status === 'accepted'
        );
}

/**
 * Phrase ②'s structuring claim key: `wi_structure_plotlines_<phrase seed hash>`.
 *
 * WHY IT IS ITS OWN FAMILY AND NOT `wi_structure_seed_<hash>`: the two phrases can hold the SAME text
 * — an Author who pushes the compiled Summary into Phrase ② and started the book from that same prose
 * gets an identical hash — and one family would let the Summary's accepted structuring silently
 * satisfied Phrase ②'s, so the chapter set would never be decided. The prefix is the difference, and
 * the hash is over the phrase seed.
 */
export const plotlinesStructureKeyOf = (phrase: Phrase | undefined, story: Story): string =>
    `${PLOTLINES_STRUCTURE_ITEM_PREFIX}_${plotlinePhraseSeedHashOf(phrase, story)}`;

/** The family prefix {@link plotlinesStructureKeyOf} builds. Recognised by `invalidation.ts`. */
export const PLOTLINES_STRUCTURE_ITEM_PREFIX = 'wi_structure_plotlines';

/** The claim key of one brief's research pass — the brief's `rev` IS the generation (§6.4 gate 2). */
export const researchKeyOf = (brief: SeedBrief): string => `wi_research_${brief.rev}`;

/** Has the accepted brief's research pass CLOSED? A live run does not count — sampling waits. */
export function researchClosed(store: Store, story: Story, brief: SeedBrief): boolean {
    return runsForItem(store, researchKeyOf(brief)).some((run) => run.story_id === story.id && !isLiveRun(run));
}

/**
 * D-51 — the three states phase ①'s second gate can be in, in the order the sweep reads them.
 *
 * `waived`  — the Editor wrote an EMPTY `research_questions` list: the pass is not owed at all,
 *             so no `wi_research_*` Work Item exists and nothing waits for one (R1b).
 * `needed`  — the brief lists questions, OR the brief predates the field (no property): the pass
 *             has to close before a sample may be taken (R1c, and the legacy path of R1a).
 * `closed`  — a run for the brief's research key exists and is no longer live, so the gate is
 *             satisfied and sampling may be generated.
 */
export type ResearchGate = 'waived' | 'needed' | 'closed';

/**
 * D-51: did the Editor WAIVE research for this brief?
 *
 * Only an ARRAY that is present and EMPTY says yes. `undefined` is the legacy shape (a brief
 * stored before the field existed) and counts as "needed" — silently skipping a pass an older
 * Story was owed would change what its stored brief means. A non-empty list is a scope, never a
 * waiver, even if a later run reports that nothing in it needed an external lookup (R1d: that run
 * CLOSES the pass as `closed`, it does not rewrite the decision).
 */
export const researchWaived = (brief: SeedBrief): boolean =>
    Array.isArray(brief.research_questions) && brief.research_questions.length === 0;

/**
 * The ONE predicate phase ①'s second gate reads (D-51).
 *
 * Work generation, the Phase-① drain reason and the sampling precondition all ask this same
 * question, so the three of them cannot disagree about whether a sample may be taken. The order is
 * deliberate: a waived scope never consults the run rows, so an Editor who waived research cannot
 * be blocked by a research pass that was never going to happen.
 */
export function researchGate(store: Store, story: Story, brief: SeedBrief): ResearchGate {
    if (researchWaived(brief)) return 'waived';
    if (researchClosed(store, story, brief)) return 'closed';

    return 'needed';
}

/** The questions the Researcher's pass is scoped to; `[]` for a legacy brief that names none. */
export const researchQuestionsOf = (brief: SeedBrief): string[] =>
    Array.isArray(brief.research_questions) ? brief.research_questions : [];

// ---------------------------------------------------------------------------
// H2/R1 — a fix task whose work is a prerequisite (owner ≠ Writer), and its evidence
// ---------------------------------------------------------------------------

/**
 * The claim-key family of one fix task's research passes — trailing `_` included.
 *
 * A phase-① `fix` row owned by the Researcher (§4.7's free-text `owner_role`) asks for an EXTERNAL
 * FACT, not a Summary edit: the live story's `task_187` demanded sourced public-housing pet-law
 * research. Phase ① has exactly one crew job that can produce one — `research` (§6.4 step 2) — so this
 * is the same Work Item kind, in its OWN family so it cannot be confused with the brief's opening
 * pass: `wi_research_<brief.rev>` has no `_a<n>` tail, and a family counted by this prefix can never
 * borrow the opening pass's closed run (or the task would read as already answered before it started).
 *
 * The `_` anchor is load-bearing exactly as it is in `screenPrefixOf`: `task_18` is a text prefix of
 * `task_187`, and ids come from one counter, so an unanchored prefix would spend one task's passes
 * against another task's cap.
 */
export const researchPrerequisitePrefixOf = (taskId: string): string => `wi_research_fix_${taskId}_`;

/** One research pass for one prerequisite task: the claim key carries the attempt, like every family here. */
export const researchPrerequisiteKeyOf = (taskId: string, attempt: number): string =>
    `${researchPrerequisitePrefixOf(taskId)}a${attempt}`;

/**
 * How many research passes this task has already bought — live and closed, the same counter as every family.
 *
 * S-RUNTIME: scoped to the Story that owns the task. The family is named after a LOCAL id (`task_187`
 * in one book is a different job from `task_187` in another), and this counter feeds
 * `researchPrerequisiteExhausted` — an unscoped count in a shared book would tell one Story its
 * Researcher's budget was spent by another Story's passes, and the task would escalate without ever
 * being asked. Both readers below take the same scope so the cap and the "answered?" gate cannot drift.
 */
export function researchPrerequisiteAttempts(store: Store, taskId: string): number {
    const prefix = researchPrerequisitePrefixOf(taskId);
    const owner = store.tasks.get(taskId)?.story_id;

    return store.runs.list().filter(
        (run) => (owner === undefined || run.story_id === owner) && (run.work_item_ref ?? '').startsWith(prefix)
    ).length;
}

/** The run rows of one task's research family, oldest first. Scoped like `researchPrerequisiteAttempts`. */
export function researchPrerequisiteRuns(store: Store, taskId: string): Run[] {
    const prefix = researchPrerequisitePrefixOf(taskId);
    const owner = store.tasks.get(taskId)?.story_id;

    return store.runs
        .list()
        .filter((run) => (owner === undefined || run.story_id === owner) && (run.work_item_ref ?? '').startsWith(prefix))
        .sort((left, right) => left.id.localeCompare(right.id));
}

/** Is a research pass for this task still in flight? (the queue must not buy a second one — L-2) */
export const researchPrerequisiteLive = (store: Store, taskId: string): boolean =>
    researchPrerequisiteRuns(store, taskId).some(isLiveRun);

/**
 * The pass budget for one research prerequisite — the loop's universal allowance, not a new knob:
 * the first pass plus `SAMPLING_RETRY_ALLOWANCE` retries, which is what `FINDING_VERIFY_CAP` already
 * bounds the verify queue with. Reusing the number is what keeps a prerequisite from being the one
 * place in phase ① with an unbounded retry loop.
 */
export const RESEARCH_PREREQUISITE_CAP = FINDING_VERIFY_CAP;

/** Has this task spent its whole research pass budget? (H2/R1 — the bound; past it, the Author is asked.) */
export const researchPrerequisiteExhausted = (store: Store, task: Task): boolean =>
    researchPrerequisiteAttempts(store, task.id) >= RESEARCH_PREREQUISITE_CAP;

/**
 * The completion EVIDENCE one research pass produced: the journal's `knowledge` writes attributed to a
 * run in this task's family.
 *
 * WHY THE JOURNAL AND NOT THE LEDGER: the settlement question is "did THIS pass establish the fact?",
 * and `writeKnowledge` stamps its `run_ref` on every entry it creates or bumps (`tools/knowledge.ts`
 * through `buildAttribution`). A Knowledge row from the brief's opening pass is not an answer to a
 * question raised three rounds later, and a closed run that called nothing — the `reportNoResearch`
 * shape, or a run that simply ended — is not an answer either. H2/R1's rule, "a research prerequisite
 * settles on concrete completion evidence, never because a run finished", is this query; the engine's
 * settle step (`engine.ts:settleFixPrerequisites`) is its only writer-side reader.
 *
 * Updates count as well as creates, because a re-cited entry IS the pass's answer when the fact was
 * already on the ledger: D-16's dedupe merges the new sources and re-triages the importance, which is a
 * sourced answer to the task, not silence.
 */
export function researchPrerequisiteEvidence(store: Store, storyId: string, taskId: string): CommitEvent[] {
    // The run rows are story-scoped (§4.13), so restricting the ledger reads to this family's runs
    // already restricts them to this Story; the `story_id` clause is a belt for a hand-edited store.
    const runIds = new Set(
        researchPrerequisiteRuns(store, taskId)
            .filter((run) => run.story_id === storyId)
            .map((run) => run.id)
    );

    if (runIds.size === 0) return [];

    return store.journal.filter(
        (event) =>
            event.collection === 'knowledge' &&
            (event.op === 'create' || event.op === 'update') &&
            event.attribution?.run_ref !== undefined &&
            event.attribution.run_ref !== null &&
            runIds.has(event.attribution.run_ref)
    );
}

/**
 * Has this prerequisite task been ANSWERED on the ledger? True the moment one of its research passes
 * wrote Knowledge; the task row itself only changes when the engine's settle step commits it, so the
 * queue, the sampling gate and the settlement read the same fact rather than two halves of it.
 */
export function researchPrerequisiteAnswered(store: Store, storyId: string, task: Task): boolean {
    return researchPrerequisiteEvidence(store, storyId, task.id).length > 0;
}

/**
 * H2/R1/R2 — is the round held behind a prerequisite that cannot run (spent its pass budget) and has no
 * evidence? That is the one prerequisite state the Author has to break, and it has to be visible to the
 * queue (stop buying passes), the drain probe (name the unmet stage) and the decision machine (the
 * Author's turn rather than `ready`), or the Story reads `ready` with nothing to dispatch.
 */
export function stalledResearchPrerequisites(store: Store, storyId: string): Task[] {
    return openPrerequisiteFixTasks(store, storyId)
        .filter(isResearchPrerequisiteFix)
        .filter((task) => !researchPrerequisiteAnswered(store, storyId, task))
        .filter((task) => researchPrerequisiteExhausted(store, task));
}

/**
 * Round 1 samples as soon as structure and research are closed; a REFINEMENT round (§6.4 step 7)
 * waits until the deep review has finished defining the issues it must answer —
 *
 *   * at least one OPEN, WRITER-OWNED `fix` task exists (the approved work the next prompt carries), AND
 *   * no critical/major suspicion is still `unconfirmed` (an unverified complaint is not an
 *     instruction: compiling it into a Writer prompt would spend a round on a claim the Editor
 *     has not accepted, D-33), AND
 *   * H2/R1 — no Researcher-owned `fix` prerequisite is still unanswered. A prerequisite is the round's
 *     INPUT, not one of its deliverables: the Knowledge it establishes belongs in the Writer's prompt
 *     (§5's KNOWLEDGE block), so the round waits for the pass, then samples with the Writer tasks that
 *     remain. Gating here rather than in `work.ts` is what keeps the queue, the drain probe (§6.7) and
 *     `samplingLegClosed` reading one answer — and an ANSWERED prerequisite (Knowledge on the ledger,
 *     task row not yet flipped by the settle step) never holds the round.
 *
 * `round` is passed in so the same predicate serves work generation, the drain preconditions and
 * the selection sweep (the caller always knows which round it is asking about).
 *
 * G1 — the fourth leg: an ACCEPTED-REVISION PLATEAU also disarms the round, and it disarms it HERE
 * rather than only in the queue, because three readers call this one predicate (the sampling queue,
 * `samplingLegClosed`, and the drain's unmet list). The plateau is not about THIS round's attempts —
 * those are bounded by `samplingProgressOf` — it is about the loop having installed revision after
 * revision that its own deep review never improved (F1's unbounded path: each candidate certifies the
 * old fix, introduces nothing, and the review files a fresh blocking finding with new wording). Open
 * fix tasks WILL exist in that state, so the three legs above would happily arm another round forever;
 * this is the leg that stops the actual work, not just the status text (requirement 3).
 */
export function samplingArmed(store: Store, story: Story, round: number): boolean {
    if (round <= 1) return true;

    return (
        !revisionReviewPlateau(store, story) &&
        openWriterFixTasks(store, story.id).length > 0 &&
        unconfirmedBlockingFindings(store, story).length === 0 &&
        openResearchFixPrerequisites(store, story.id).length === 0
    );
}

/** Every Summary revision of the Story, oldest first (all rounds; losers are deleted by selection). */
export function summaryRevisions(store: Store, storyId: string): Revision[] {
    return store.revisions
        .list()
        .filter((revision) => revision.story_id === storyId && revision.unit_kind === 'summary')
        .sort(recency);
}

/**
 * The Summary revisions of ONE sampling round, oldest first. `round` defaults to 1 on the row
 * (§3.5), so a revision written before the pipeline existed is round 1's draft.
 */
export function roundRevisions(store: Store, storyId: string, round: number): Revision[] {
    return summaryRevisions(store, storyId).filter((revision) => (revision.round ?? 1) === round);
}

/**
 * One draft's screening reviews, oldest first — the selector's evidence (§6.5).
 *
 * S-RUNTIME: scoped to the Story that owns the draft (the review row carries `story_id`, and the draft
 * row says who owns it). `revision_1` exists in EVERY book, so in a book that holds several Stories an
 * unscoped read would let one Story's Critic reviews satisfy another Story's screening set — and
 * `isFullyScreened` selects a draft on a review set it never collected. One Story per book is what makes
 * the scope a no-op in production; the scope is what keeps the phase-① selection honest in a shared one.
 */
export function screensFor(store: Store, revisionId: string): SampleReview[] {
    const owner = store.revisions.get(revisionId)?.story_id;

    return store.sampleReviews
        .list()
        .filter(
            (review) =>
                review.revision_ref === revisionId && (owner === undefined || review.story_id === owner)
        )
        .sort(recency);
}

/**
 * The sampling/screening run families, as one test (`wi_sample_…` / `wi_screen_…`).
 *
 * H1 exported it (it was engine- and status-local): `work.ts` now has to ask the same question —
 * "is this round still gathering evidence?" — before it calls a round exhausted, and a queue and a
 * sweep that disagree about which runs count would open an Author escalation over a round that was
 * still being screened (T12/C's argument, applied to the new certification stall).
 */
export const PHASE1_PIPELINE_RUN = /^wi_(sample|screen)_/;

/**
 * The claim key's PREFIX for one draft's screening family — trailing `_` included.
 *
 * The underscore is load-bearing, not cosmetic: revisions are numbered from one counter, and a bare
 * `wi_screen_revision_1` is a prefix of `wi_screen_revision_10`, so an unanchored count would add a
 * tenth draft's passes to the first draft's retry counter. `claimKey` always writes `<prefix>_<n>`,
 * so this is exactly the family.
 */
export const screenPrefixOf = (revisionId: string): string => `wi_screen_${revisionId}_`;

/**
 * The family PREFIX for one round's sampling family — trailing `_` included.
 *
 * The key is `wi_sample_<summary>_<round>_<attempt>` in wave 0 and `wi_sample_<summary>_<round>_w<wave>_<attempt>`
 * from wave 1 (T12/E). The wave segment is inside the prefix, so `sampleAttempts` counts the runs of
 * the CURRENT wave only: that is what makes the Author's clear re-arm a spent round (the old wave's
 * rows stay on the ledger but no longer count against the new cap).
 *
 * With no `wave` (wave 0) the prefix is the ROUND's whole family — every wave's key starts with
 * `wi_sample_<summary>_<round>_` — which is what `sampleRoundPrefixOf` exposes for the wave-agnostic
 * "has this round started" read (T10/F5).
 */
export const samplePrefixOf = (summaryRef: string, round: number, wave = 0): string =>
    wave > 0 ? `wi_sample_${summaryRef}_${round}_w${wave}_` : `wi_sample_${summaryRef}_${round}_`;

/**
 * How many screening runs one draft's claim family has already dispatched (the retry counter).
 *
 * S-RUNTIME: scoped to the Story that owns the revision (see `verifyFindingRuns` for the reasoning —
 * `wi_screen_revision_1_` is the same family name in two books, and this is the counter that decides
 * whether a draft is "treated as screened" without its full review set).
 */
export function screenAttempts(store: Store, revisionId: string): number {
    const prefix = screenPrefixOf(revisionId);
    const owner = store.revisions.get(revisionId)?.story_id;

    return store.runs.list().filter(
        (run) => (owner === undefined || run.story_id === owner) && (run.work_item_ref ?? '').startsWith(prefix)
    ).length;
}

/**
 * How many sampling runs the in-flight round's CURRENT WAVE has already dispatched (the retry counter).
 *
 * S-RUNTIME: scoped to the Story that owns the Summary the round samples (`summaryRef` is that row's
 * id — `work.ts:storySummary`), for the same reason as the screening family. This is also the number
 * H2's hill state reads (`samplingProgressOf`), so an unscoped count would let one Story's spent wave
 * stop another Story's round from buying the attempts it is owed.
 */
export function sampleAttempts(store: Store, summaryRef: string, round: number, wave = 0): number {
    const prefix = samplePrefixOf(summaryRef, round, wave);
    const owner = store.summaries.get(summaryRef)?.story_id;

    return store.runs.list().filter(
        (run) => (owner === undefined || run.story_id === owner) && (run.work_item_ref ?? '').startsWith(prefix)
    ).length;
}

/**
 * The attempt cap of one draft's SCREENING family (§6.4 step 4): its owed passes plus the allowance.
 * Screens are a cheaper pass than a sample, and they have no waves (T12/C): a draft that cannot
 * collect its reviews inside the cap is selected on the partial set instead.
 */
export const screeningCapOf = (story: Story): number => screeningSizeOf(story) + SAMPLING_RETRY_ALLOWANCE;

/** Has one draft spent its whole screening attempt cap? The retry counter, not the row count, decides. */
export const screeningExhaustedFor = (store: Store, story: Story, revisionId: string): boolean =>
    screenAttempts(store, revisionId) >= screeningCapOf(story);

/**
 * May this draft be treated as screened by the selection trigger? (T12/C)
 *
 * Two ways, and they are the whole rule: it carries its full review set (`screeningSizeOf`), OR its
 * screening attempts are exhausted. The second clause is the degrade path — a provider that keeps
 * answering invalid `IssueList` JSON must not strand the round forever: the sample is selected on
 * the reviews it did collect (possibly none), and `./work`'s escalation row tells the Author.
 */
export const isFullyScreened = (store: Store, story: Story, revisionId: string): boolean =>
    screensFor(store, revisionId).length >= screeningSizeOf(story) ||
    screeningExhaustedFor(store, story, revisionId);

/**
 * Every OPEN `fix` row (§4.7), whatever role owns it — the queue's own accounting, and the set the
 * H2 prerequisite scan walks. `openTasks` is `open`/`claimed` in queue order; the `state` filter here
 * keeps the `claimed` shape out, exactly as it always has been.
 */
export function openFixTasksAll(store: Store, storyId: string): Task[] {
    return openTasks(store, storyId).filter((task) => task.kind === 'fix' && task.state === 'open');
}

/**
 * H2/R1 — an open `fix` row a candidate Summary CAN be graded against.
 *
 * §4.7's `owner_role` is free text on purpose (P15), and phase ① had exactly one reading of it: every
 * open `fix` row was treated as work the next Writer draft would answer. That is only true when the row
 * IS the Writer's. `approveFinding` opens approved findings as `owner_role: 'writer'`
 * (`tools/editor.ts`), and an unowned row is the same D-34 shape, so blank/`writer` is the Writer's.
 * Anything else — the live story's `task_187`, an Editor's `createTask` naming `researcher` for
 * "source the public-housing pet rule this Summary asserts" — is a PREREQUISITE: no candidate Summary
 * can satisfy it, and a no-tool screening Critic, which has neither the web tools nor the Knowledge
 * ledger in front of it, cannot grade it either. Grading it as if a draft could answer it made every
 * candidate ineligible (`unknown` is not a pass, `sample-select.ts:certifiesFix`) and the round
 * exhausted with nothing the Author could clear except discarding real work.
 *
 * The row is NOT hidden: `openPrerequisiteFixTasks` below turns it into role-appropriate Work, and the
 * queue keeps counting it as unmet work until it settles.
 *
 * WHY A PREFIX TEST AS WELL AS THE LIST: §4.7's doc names the five ROLE KINDS, but the assignment
 * layer writes TEMPLATE ids into the same field — a Writer job's owner reads `writer-prose` or
 * `writer-style` (`templates.ts:DEFAULT_ASSIGNMENT`, and `run/mock.ts:seedTask`'s default) — and phase
 * ①'s own Researcher template is `researcher-story`. A closed list would read those rows as somebody
 * else's work and strand them in the prerequisite queue, which is the opposite bug in the other
 * direction. Every `writer*` name is the role the draft is graded against; the prefix is the field's
 * real alphabet, not a widening of the rule.
 */
export const isWriterActionableFix = (task: Task): boolean =>
    WRITER_FIX_OWNERS.includes(taskOwnerRole(task)) || taskOwnerRole(task).startsWith('writer');

/**
 * H2/R1 — an open `fix` row whose work is an external fact, not a prose repair. Phase ① HAS a crew job
 * for this owner (`research` → `writeKnowledge`, §6.4 step 2), which is why it gets real Work rather
 * than a filter. The same role-kind/template tolerance applies (`researcher`, or the `researcher-story`
 * template id that names it).
 */
export const isResearchPrerequisiteFix = (task: Task): boolean =>
    task.kind === 'fix' &&
    (taskOwnerRole(task) === RESEARCH_FIX_OWNER || taskOwnerRole(task).startsWith(`${RESEARCH_FIX_OWNER}-`));

/**
 * The OPEN `fix` tasks a Writer round is armed and graded against (§6.8) — D-34's approved work, and
 * the list the next sampling round's prompt compiles. A `claimed` row is a fix pass in flight, which
 * phase ① no longer runs; the arming gate reads only what is waiting, so the round cannot be spent on
 * work already moving. H2/R1 narrowed this to `isWriterActionableFix` rows: the Writer's prompt, the
 * screening certificate and the arming rule all read THIS set, so a researcher-owned prerequisite can
 * be neither demanded nor vetoed.
 */
export function openWriterFixTasks(store: Store, storyId: string): Task[] {
    return openFixTasksAll(store, storyId).filter(isWriterActionableFix);
}

/**
 * H2/R1 — the OPEN `fix` rows whose owner is NOT the Writer: prerequisites that must be executed by
 * their own role before a Summary round can answer the rest of the work list. Queue order (priority,
 * then id) so a sweep's dispatch order is reproducible (L-2).
 */
export function openPrerequisiteFixTasks(store: Store, storyId: string): Task[] {
    return openFixTasksAll(store, storyId).filter((task) => !isWriterActionableFix(task));
}

/**
 * H2/R1 — the Researcher-owned prerequisites phase ① can actually run, minus the ones that are already
 * ANSWERED. `researchPrerequisiteEvidence` is the settlement gate: a pass that recorded Knowledge has
 * settled the question on the ledger even if the sweep has not flipped the task row yet, so a round
 * waits for the WORK, not for the bookkeeping.
 */
export function openResearchFixPrerequisites(store: Store, storyId: string): Task[] {
    return openPrerequisiteFixTasks(store, storyId)
        .filter(isResearchPrerequisiteFix)
        .filter((task) => !researchPrerequisiteAnswered(store, storyId, task));
}

/**
 * H2/R1 — the open `fix` rows phase ① has NO crew job for: an owner that is neither the Writer nor the
 * Researcher (an `editor`/`critic`/`reader` "fix" row in a phase with no Editor fix pass). They are
 * neither Writer work nor researchable prerequisites, so the only honest move is the Author's
 * (`work.ts:openFixOwnershipTask`) — filtering them out of every set while nothing ran for them is the
 * silent ready-with-nothing-to-do state H2 exists to remove.
 */
export function openUnserviceableFixTasks(store: Store, storyId: string): Task[] {
    return openPrerequisiteFixTasks(store, storyId).filter((task) => !isResearchPrerequisiteFix(task));
}

/** The open WRITER-owned fix task ids, ascending — the order a prompt renders and a certificate compares in. */
export const openFixTaskIds = (store: Store, storyId: string): string[] =>
    openWriterFixTasks(store, storyId)
        .map((task) => task.id)
        .sort((left, right) => left.localeCompare(right));

/**
 * H1 (R2/R4) — the fix ids one draft's screening passes were ASKED to certify, of the ones STILL OPEN.
 *
 * The still-open filter is not a tidy-up (H1-C1/F1): a demand is a PROMISE the round made, and a task
 * the Author discarded (`wontfix`) or closed (`done`) between the escalation and the selection is no
 * longer outstanding. Grading a candidate against it anyway made every draft ineligible, while
 * `samplingArmed` refused to buy another sample (it requires an OPEN fix task) and the attempt cap was
 * not spent — so the round had no eligible winner, no new work, and no escalation: a deadlock the
 * Author could reach by following the escalation's own advice ("discard the fix tasks"). One rule,
 * three readers: this is the same `openFixTaskIds` set the Writer's prompt is compiled from
 * (`work.ts:dispatchSamples`) and the arming rule counts, so the queue, the prompt and the certificate
 * cannot disagree about what is owed.
 *
 * Normally the demand is the union of the `fix_refs` its screening rows carry: every screening job
 * records the list its own prompt rendered, so each candidate is graded against exactly what ITS
 * screeners were handed and nothing else. A fix confirmed after one draft's screens went out burdens
 * only the drafts whose later pass carried it — and that pass alone has to certify it, since a pass
 * that was never handed a task cannot be blamed for not answering it
 * (`sample-select.ts:scoreSample` filters to the passes that carry each id).
 *
 * Three fallbacks, in order, for rows that declare nothing:
 *   * verdicts without a per-report list — `IssueListSchema` keeps `fix_refs` optional so pre-H1 rows
 *     parse, and lets a reviewer echo the id on each verdict instead. Those ids ARE the demand;
 *     ignoring them would let a certification-shaped report dodge the gate over a formatting choice.
 *   * a REFINED draft (round ≥ 2) whose screening leg answered nothing — the provider broke, or the
 *     rows predate fix verification. The Story's OPEN fix tasks are then the demand, because the
 *     arming rule (`samplingArmed`) only let the round run at all when those tasks existed: a draft
 *     nobody graded against them is not certified, and selecting it would be the least-bad path this
 *     change removes (R3). Being ungradeable is INELIGIBILITY, not a clean certificate (H1-C1/F2) —
 *     see `sample-select.ts:scoreSample`.
 *   * a FIRST-round draft (`origin: 'sampled'`): its prompt carried no fixes at all, so it is
 *     demanded nothing. That is what keeps a clean round 1 — including the T12/C partial-screening
 *     degrade — behaving exactly as it did before (R5).
 */
export function sampleFixDemand(store: Store, storyId: string, revision: Revision): string[] {
    // `openFixTaskIds` is `state: 'open'` only: a `claimed` row is a fix pass in flight (phase ① does
    // not run them), and `done`/`wontfix` are settled. `openFixTasks` is the same set the arming rule
    // and the Writer's prompt read, so a task can never be "owed" to one of them and not the others.
    const outstanding = new Set(openFixTaskIds(store, storyId));
    const stillOwed = (ids: Iterable<string>): string[] =>
        [...new Set([...ids])].filter((ref) => outstanding.has(ref)).sort((left, right) => left.localeCompare(right));
    const screens = screensFor(store, revision.id);
    const declaring = screens.filter((review) => review.fix_refs !== undefined);

    // A declared list is the answer even when the intersection comes out EMPTY — the round owed these
    // ids and the Author has since settled them, which is "nothing outstanding", NOT an invitation to
    // fall through and demand some other open task this draft was never handed.
    if (declaring.length > 0) return stillOwed(declaring.flatMap((review) => review.fix_refs ?? []));

    // The schema lets a reviewer echo the demand PER VERDICT (`fix_verifications[].fix_ref`) while
    // leaving the per-report `fix_refs` out — that field is optional precisely so pre-H1 rows still
    // parse. Such a report is still a demand: reading it as "nothing asked" would let a
    // certification-shaped row slip past the gate on a formatting choice the model made.
    const carried = screens
        .flatMap((review) => review.fix_verifications ?? [])
        .map((verification) => verification.fix_ref)
        .filter((ref) => typeof ref === 'string' && ref.length > 0);

    if (carried.length > 0) return stillOwed(carried);

    return (revision.round ?? 1) > 1 || revision.origin === 'refined' ? [...outstanding] : [];
}

/**
 * The ACCEPTED Summary text — the draft the Summary row currently carries, i.e. Revision N (§6.2a).
 *
 * Every refinement candidate is measured against THIS text: it is the base the Writer was handed, the
 * draft the screening Critic is shown next to the candidate, and the thing a new critical/major would
 * be new IN. `undefined` means the Story has no accepted revision yet — round 1 — which is the one
 * state where nothing can regress and §6.5's initial-creation semantics still apply (R5).
 */
export const acceptedSummaryRevision = (store: Store, storyId: string): Revision | undefined =>
    selectedSummaryRevision(store, storyId);

/**
 * H1 — every candidate of one sampling round, scored (R3/R5).
 *
 * The single place the round's screening evidence becomes numbers: `engine.ts:trySelectSample` ranks
 * these, `work.ts` reads them to decide whether the round still owes samples, and
 * `roundHasEligibleCandidate` answers, from the queue, the same question the selection answers at the
 * commit. One predicate, three readers — which is how generation and selection cannot disagree about
 * what "fixed" means, and neither can buy work the other one would refuse.
 *
 * The ACCEPTED base rides along (`scoreSample`'s `base`), and that is what makes a refinement round a
 * HILL rather than a fresh competition: with it, an unclassified blocking issue counts as something
 * this draft created, and the candidate's minimality against the accepted text becomes measurable. In
 * round 1 there is no selected revision, so there is no base, and nothing is a regression (R5).
 */
export function roundSampleScores(store: Store, storyId: string, round: number): ScoredSample[] {
    const base = acceptedSummaryRevision(store, storyId)?.body;

    return roundRevisions(store, storyId, round)
        .filter((revision) => revision.state === 'drafted')
        .map((revision) =>
            scoreSample({
                revision,
                reviews: screensFor(store, revision.id),
                fixRefs: sampleFixDemand(store, storyId, revision),
                ...(base === undefined ? {} : { base })
            })
        );
}

/**
 * The best candidate this round may INSTALL — the selection's pool, stated once for the engine and
 * the queue (R3, and requirement 7's "no eligible candidate means no install").
 *
 * A round WITH an accepted base selects from the eligible set or from NOTHING. §6.5's least-bad path
 * was written for the First Revision, where there is no incumbent to protect; once the Author has
 * signed a text, installing the least bad of a round whose candidates all failed means accepting a
 * draft the round's own Critics rejected — and it used to close the very tasks it failed. That is the
 * ratchet this change removes, and the retry allowance (`samplingProgressOf`) is what bounds the
 * re-sampling instead.
 *
 * A round WITHOUT a base (round 1) keeps the old behaviour, including the T12/C partial-screening
 * degrade and the clean-first-round case (R5): the first Summary is chosen from what the seed
 * produced, worst-to-best, because there is nothing to be worse than.
 */
export function roundInstallableCandidate(store: Store, storyId: string, round: number): ScoredSample | undefined {
    const scored = roundSampleScores(store, storyId, round);

    if (scored.length === 0) return undefined;

    // The base is what decides the mode; `roundSampleScores` already read it, so the two readers
    // cannot disagree about whether this round is protecting an incumbent.
    if (acceptedSummaryRevision(store, storyId) === undefined) return selectSample(scored);

    return selectSample(eligibleSamples(scored));
}

/**
 * H1 (R3) — does this round have to CERTIFY fixes before it may select anything?
 *
 * True as soon as one candidate was handed a fix list that is STILL OPEN, which after the arming rule
 * (`samplingArmed`) means every round from 2 on that still owes a repair. A round with nothing to
 * certify keeps §6.5's least-bad path, so a clean round 1 — including the T12/C partial-screening
 * degrade — is unchanged (R5), and so is a refinement whose fix tasks the Author settled after the
 * escalation (H1-C1/F1: the promise is gone, so there is nothing left to veto the round).
 *
 * What changed in H1-C1/F2 is the OTHER half: a round that DOES owe fixes gets no help from an
 * ungradeable screening set. `requiresFixCertification` true and every candidate `legacyScreening`
 * means `eligibleSamples` is empty — the round retries inside the attempt cap and escalates, rather
 * than installing a refined draft nobody verified over the incumbent.
 */
export function roundRequiresCertification(store: Store, storyId: string, round: number): boolean {
    return requiresFixCertification(roundSampleScores(store, storyId, round));
}

/**
 * H1 (R3/R5) — does the in-flight round already hold a draft it is ALLOWED to select?
 *
 * The sampling queue asks this before buying another sample: a round whose fixes were answered by
 * nothing keeps climbing (the Writer drafts again, inside the attempt cap), and a round that already
 * holds a certified draft must not spend another sample on it. Only a draft whose screening is
 * COMPLETE (`isFullyScreened`, T12/C) counts, so a screen still in flight is never read as a failure.
 */
export function roundHasEligibleCandidate(store: Store, story: Story, round: number): boolean {
    return roundSampleScores(store, story.id, round)
        .filter((scored) => isFullyScreened(store, story, scored.revision.id))
        .some((scored) => scored.eligible);
}

// ---------------------------------------------------------------------------
// The hill's retry allowance — retry WHILE the round measurably improves, stop when it stops improving
// ---------------------------------------------------------------------------

/**
 * How many completed, measured attempts in a row that failed to lower the best unresolved-blocking-fix
 * count stop the round and ask the Author (3, as the request sets it).
 *
 * WHY A STREAK AND NOT A NUMBER OF ATTEMPTS: the old static cap (`samplingSize + SAMPLING_RETRY_ALLOW-
 * ANCE`) stopped a round that was still climbing — a candidate that fixed one of three defects and
 * introduced nothing is progress, and stopping there throws the climb away — while the same cap let a
 * round burn attempts on candidates that changed nothing. The streak measures the thing that actually
 * matters (is the next attempt earning its keep?) and the ceiling below keeps the provider-failure
 * path bounded exactly as it was.
 */
export const SAMPLING_NO_PROGRESS_STREAK = 3;

/** What one wave of the hill has proved so far — the retry scheduling state, read from the ledger. */
export interface SamplingProgress {
    round: number;
    wave: number;
    /** True when the round has an accepted Revision N to climb from. A first round has no streak. */
    refinement: boolean;
    /** Sampling attempts this WAVE has dispatched — the counter every cap reads (`sampleAttempts`). */
    attempts: number;
    /** This wave's candidates whose screening leg has closed, oldest first (`isFullyScreened`). */
    completed: ScoredSample[];
    /** Attempts that produced no readable candidate: no screening row at all, or only schema-invalid ones. */
    invalidAttempts: number;
    /**
     * The lowest unresolved-blocking-fix count any regression-free, readable candidate has proved, or
     * `undefined` while no candidate has proved anything. THE BASELINE: the first such candidate sets
     * it (it is not counted as an improvement — nothing was beaten) and every later attempt has to
     * beat it to keep buying work.
     */
    bestUnresolved?: number;
    /** Improvements this wave has proved. Each one buys one attempt beyond the static cap. */
    improvements: number;
    /** Completed, measured attempts in a row that did NOT lower `bestUnresolved` (regressions included). */
    noImprovement: number;
    /** Attempts the wave may still spend: `samplingCapOf(story) + improvements`. */
    ceiling: number;
    /** True when the no-progress streak has stopped this round. */
    stalledForProgress: boolean;
    /** True when nothing more may be bought — the streak was spent, or the ceiling was. */
    spent: boolean;
}

/**
 * The Summary drafts one WAVE's sampling attempts produced, oldest first.
 *
 * Attribution goes through the sample RUN, not through the draft row: `Revision.run_ref` names the run
 * that wrote it, and the run's `work_item_ref` carries the wave (`wi_sample_<summary>_<round>_w<wave>_
 * <n>`). Reading it off the ledger rather than off a counter is what makes the progress state survive
 * a restart — and the reason wave 0 cannot use `samplePrefixOf(…, 0)`: that prefix is the WHOLE
 * round's family, so it also matches every later wave's key (T12/E).
 */
function waveSampleRevisions(store: Store, storyId: string, summaryRef: string, round: number, wave: number): Revision[] {
    const roundPrefix = sampleRoundPrefixOf(summaryRef, round);
    const mine = new Set(
        store.runs
            .list()
            .filter((run) => {
                const key = run.work_item_ref ?? '';

                if (!key.startsWith(roundPrefix)) return false;

                // The wave segment sits between the round and the attempt, so a wave-0 key has none of
                // it — and `samplePrefixOf(…, 0)` cannot be used here because it is the whole round.
                return wave === 0
                    ? !/_w\d+_/.test(key.slice(roundPrefix.length))
                    : key.startsWith(samplePrefixOf(summaryRef, round, wave));
            })
            .map((run) => run.id)
    );

    return roundRevisions(store, storyId, round).filter(
        (revision) => revision.run_ref !== undefined && mine.has(revision.run_ref)
    );
}

/**
 * What the hill has proved in one wave, derived from the ledger on every read (P11/L-3: the engine
 * keeps no memory, so a restart recomputes exactly this).
 *
 * THE WALK, and the three ways an attempt can land:
 *   * NO READABLE CANDIDATE (no screening row, or only rows persisted `valid: false`) — a provider
 *     failure. It never sets a baseline and never extends the streak: those attempts are bounded by
 *     the existing static cap (`samplingCapOf`), which is the bound the provider-failure escalation
 *     already speaks of, so a provider that never answers cannot loop forever.
 *   * A MEASURED, REGRESSION-FREE CANDIDATE — the first one sets the baseline; a later one with a
 *     LOWER unresolved-blocking count is an improvement (streak → 0, ceiling +1); one that ties or
 *     worsens it is a no-improvement.
 *   * A CANDIDATE WITH A NEW CRITICAL/MAJOR — a regression. It cannot set or lower the baseline (the
 *     count it proved belongs to a draft the loop would never install), so it counts as
 *     no-improvement, exactly as the request asks.
 *
 * Only a round with an ACCEPTED base is measured at all: a first round is producing the sample set the
 * Author asked for, not retrying a climb, so it keeps §6.5's cap and its least-bad install (R5).
 *
 * The wave is what resets the state. The Author's clear of the failure escalation bumps
 * `sampling_wave` (`engine.ts:rearmSamplingWave`) and every number here is scoped to one wave, so the
 * fresh wave starts with no baseline and no streak — a fresh wave IS a fresh baseline, and the loop
 * never re-arms a no-progress stop by itself.
 */
export function samplingProgressOf(store: Store, story: Story, round: number, wave = samplingWaveOf(story)): SamplingProgress {
    const summary = storySummary(store, story.id);
    const summaryRef = summary?.id ?? '';
    const refinement = acceptedSummaryRevision(store, story.id) !== undefined;
    const attempts = summaryRef === '' ? 0 : sampleAttempts(store, summaryRef, round, wave);
    const scored = roundSampleScores(store, story.id, round);
    const mine = new Set(
        summaryRef === '' ? [] : waveSampleRevisions(store, story.id, summaryRef, round, wave).map((revision) => revision.id)
    );
    const completed = scored.filter(
        (sample) => mine.has(sample.revision.id) && isFullyScreened(store, story, sample.revision.id)
    );

    let bestUnresolved: number | undefined;
    let improvements = 0;
    let noImprovement = 0;
    let invalidAttempts = 0;

    for (const sample of completed) {
        // No readable screening set: the provider owes this attempt, the streak does not.
        if (!sample.gradeable) {
            invalidAttempts += 1;
            continue;
        }

        const regressionFree = sample.blockingIntroduced === 0;

        if (bestUnresolved === undefined) {
            // The first regression-free candidate MEASURES the hill; it does not climb it.
            if (regressionFree) bestUnresolved = sample.unresolvedBlocking;
            else noImprovement += 1;

            continue;
        }

        if (regressionFree && sample.unresolvedBlocking < bestUnresolved) {
            bestUnresolved = sample.unresolvedBlocking;
            improvements += 1;
            noImprovement = 0;
            continue;
        }

        noImprovement += 1;
    }

    // The best-ever count, not just this walk's last value — the baseline must never move back up, so
    // a later regression cannot re-open a hill the round already climbed (a lower bar is a fact).
    const proven = bestUnresolvedBlocking(completed);
    const ceiling = samplingCapOf(story) + improvements;
    const stalledForProgress = refinement && noImprovement >= SAMPLING_NO_PROGRESS_STREAK;

    return {
        round,
        wave,
        refinement,
        attempts,
        completed,
        invalidAttempts,
        bestUnresolved: proven ?? bestUnresolved,
        improvements,
        noImprovement,
        ceiling,
        stalledForProgress,
        spent: stalledForProgress || attempts >= ceiling
    };
}

/**
 * Can this round buy nothing more? Either its wave spent the ceiling — the static cap, extended only
 * by proven improvements — or the no-progress streak stopped it while it still had attempts left.
 *
 * Every reader of "is this round done trying" goes through here (`samplingLegClosed`, the sampling
 * queue, the exhaustion escalation, and the drain's precondition), so a round cannot look finished to
 * one of them and still owe samples to another.
 */
export function samplingBudgetSpent(store: Store, story: Story, round: number): boolean {
    const summary = storySummary(store, story.id);

    if (summary === undefined) return false;

    return samplingProgressOf(store, story, round).spent;
}

/**
 * The claim key of one deep-review Critic pass over the SELECTED revision (§6.4 step 6).
 *
 * A separate family from `wi_screen_` on purpose: the screening passes are no-tool one-turn runs
 * that rank the samples, while these hold the tool catalogue and judge the winner. One ledger must
 * not confuse them.
 */
export const deepReviewKeyOf = (revisionId: string, pass: number): string => `wi_review_${revisionId}_a${pass}`;

/**
 * The round the deep review belongs to: the round whose SELECTION the Story carries (§6.4 step 6).
 *
 * `sampling_round` advances on a completed selection (§6.6), so after round N's selection the carried
 * draft is round N's and the review is owed for it, while round N+1 is still only sampling. `?? 1`
 * covers a Story whose field is absent — a selection installed before the field existed is round 1's,
 * which is also what a Revision with no `round` reads as (§3.5/§6.2a).
 */
export const deepReviewRoundOf = (story: Story): number => story.sampling_round ?? 1;

/**
 * Is this revision the one the deep review is owed passes FOR? (T10/F7 — one condition, two readers)
 *
 * `work.ts` offers a `wi_review_*` pass only for the current round's selection, and the reason is not
 * cosmetic: the deep review is the review of the text the pipeline just chose, and a Critic pass bought
 * for a draft the loop has moved past answers nothing. So the SAME condition has to answer the ledger
 * question "what is still owed?" — otherwise an Author who selects an OLDER-round revision (the Summary
 * pane can select any draft of the Story) owes `summary_critics` passes that generation will never
 * offer, the drain names them as unmet work, and the sign-off waits on passes the loop cannot dispatch.
 * One predicate, read by the queue, the drain probe and the sign-off, so an older-round selection is
 * simply not the review target rather than a debt nobody can pay.
 */
export const isDeepReviewSelection = (story: Story, revision: Revision): boolean =>
    (revision.round ?? 1) === deepReviewRoundOf(story);

/** How many deep-review passes the selected revision still owes (a live pass does not count). */
export function deepReviewPassesOwed(store: Store, story: Story, revision: Revision | undefined): number {
    if (revision === undefined) return 0;

    // T10/F7: a selection from another round owes nothing, and it is owed NOTHING — the queue that
    // would pay the debt only ever dispatches the current round's review.
    if (!isDeepReviewSelection(story, revision)) return 0;

    let owed = 0;

    for (let pass = 1; pass <= screeningSizeOf(story); pass += 1) {
        if (!runsForItem(store, deepReviewKeyOf(revision.id, pass)).some((run) => !isLiveRun(run))) owed += 1;
    }

    return owed;
}

/**
 * Is the deep review of the round's SELECTED revision finished (§6.4 step 6)?
 *
 * The phase's sign-off and the drain probe both wait on this: an Author signing a Summary whose
 * review has run one pass of five would sign a verdict nobody finished, and a probe would report
 * "nothing left at the dial" while the cheap review the pipeline bought is still owed. True when
 * there is no selected revision yet — the sign-off gate has its own conditions for that.
 */
export const deepReviewComplete = (store: Store, story: Story, revision: Revision | undefined): boolean =>
    deepReviewPassesOwed(store, story, revision) === 0;

// ---------------------------------------------------------------------------
// G1 — the ACCEPTED-REVISION plateau: the same no-progress rule, one level up
// ---------------------------------------------------------------------------

/**
 * The Story's accepted-revision audit rows, oldest first (§3.6's `summary_review_history`).
 *
 * It reads the field through `Story` (shared/types.ts declares it there, beside `sampling_history`, so
 * `LoopStory` in ./types sees it through the augmentation too): an absent field means "no accepted
 * revision of this Story has been reviewed yet", which is the state before the first selection AND the
 * state a backtrack or a Seed edit leaves behind (`engine.ts:backtrack` / `editSeed` clear it with the
 * sampling counters, because the revisions it described no longer exist).
 */
export const summaryReviewHistoryOf = (story: Story): SummaryReviewHistoryEntry[] =>
    story.summary_review_history ?? [];

/**
 * The anchored claim family of one revision's DEEP REVIEW — trailing `_a` included.
 *
 * `deepReviewKeyOf` mints `wi_review_<revision>_a<pass>`; revision ids come from one counter, so
 * `wi_review_revision_3` alone would also match `revision_30`'s passes (the same trap
 * `records.ts:screenPrefixOf` documents). The `_a` is the anchor: `revision_3`'s family is
 * `wi_review_revision_3_a…`, which `revision_30`'s `wi_review_revision_30_a1` is not.
 */
export const deepReviewPrefixOf = (revisionId: string): string => `wi_review_${revisionId}_a`;

/**
 * The findings one accepted revision's DEEP REVIEW raised — attributed by RUN, not by title.
 *
 * `deepReviewPrefixOf` gives the runs that judged this draft, and a finding's create event carries
 * `attribution.run_ref`, so this answers "what did the review of THIS text file?" from the ledger.
 * Attribution goes through the journal rather than through `related_refs` because `related_refs` says
 * what a finding is ABOUT (which is `findingRevisionScope`'s question) and can name a draft the finding
 * was re-raised against; the run that filed it is the fact this audit needs. It is the same mechanism
 * `records.ts:researchPrerequisiteEvidence` uses for a Researcher pass's Knowledge.
 *
 * LIMIT, stated honestly: a re-sighting of a fingerprint that is STILL open is a `seen_count` bump on
 * the older row (D-16) and therefore stays attributed to the review that first filed it, so it adds
 * nothing here. That is safe rather than optimistic — the open finding's fix task is what armed the
 * round, so the round cannot install a candidate that has not certified it, and the next review's
 * filing of a CLOSED defect is a fresh row (D-16's dedupe skips `fixed`/`discarded`).
 */
export function revisionReviewFindings(store: Store, revision: Revision): Finding[] {
    const owner = store.revisions.get(revision.id)?.story_id;
    const prefix = deepReviewPrefixOf(revision.id);
    const runIds = new Set(
        store.runs
            .list()
            .filter(
                (run) =>
                    (owner === undefined || run.story_id === owner) && (run.work_item_ref ?? '').startsWith(prefix)
            )
            .map((run) => run.id)
    );

    if (runIds.size === 0) return [];

    return store.journal
        .filter(
            (event) =>
                event.collection === 'findings' &&
                event.op === 'create' &&
                event.attribution?.run_ref !== undefined &&
                event.attribution.run_ref !== null &&
                runIds.has(event.attribution.run_ref)
        )
        .map((event) => store.findings.get(event.id))
        .filter(
            (finding): finding is Finding =>
                finding !== undefined && (owner === undefined || finding.story_id === owner)
        )
        .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * The review-raised findings that COUNT as blocking work on this revision.
 *
 * THREE FILTERS, all of them the loop's own existing answers — nothing new is decided here:
 *   * `confirmed`/`approved` — the Editor's verdict. A `disputed` claim was never a defect, a
 *     `discarded` one will not be acted on, and an `unconfirmed` one is not decided yet (the caller
 *     waits for that, requirement 5), so none of them may become a permanent number in the audit;
 *   * `summaryBlockingCost` — THE dial-aware Summary bar (`records.ts:summaryBlockingCost`, D-35):
 *     critical and major always, `minor` only when `auto_approve` covers it, `taste` never. Counting a
 *     taste note would let wording preferences stop the loop, which is the failure T-11/R6 removes;
 *   * not `superseded` — a defect describing a draft the Summary no longer holds is history, not work
 *     (T6/R2c), and it cannot be decided by a review that reads the carried text.
 */
export function revisionBlockingFindings(store: Store, story: Story, revision: Revision): Finding[] {
    return revisionReviewFindings(store, revision).filter(
        (finding) =>
            (finding.state === 'confirmed' || finding.state === 'approved') &&
            summaryBlockingCost(story, finding.cost) &&
            findingRevisionScope(store, story, finding) !== 'superseded'
    );
}

/** What one WAVE's accepted revisions have proved, read from the persisted audit (G1). */
export interface RevisionReviewProgress {
    /** The wave these entries belong to (`samplingWaveOf` unless a caller asks for another). */
    wave: number;
    /** This wave's audit rows, oldest first — the numbers the policy walks. */
    entries: SummaryReviewHistoryEntry[];
    /** How many accepted revisions this wave has had reviewed. */
    reviewed: number;
    /**
     * The LOWEST blocking count any reviewed revision of this wave has proved, or `undefined` while
     * nothing has been reviewed. THE BAR: the first entry SETS it and is not an improvement (nothing was
     * beaten), and it never moves back up — a later regression cannot re-open ground already won.
     */
    bestBlockingFound?: number;
    /** Entries that strictly lowered the bar. */
    improvements: number;
    /** Reviewed entries in a row that did NOT strictly lower it (equal counts included — requirement 2). */
    noImprovement: number;
    /** True when the streak has stopped this Story: the Author has to act. */
    plateaued: boolean;
}

/**
 * The hill, one level up — and deliberately derived from the STORED audit rather than re-derived from
 * live finding rows (contrast `samplingProgressOf`, which derives from `runs` because a candidate's
 * screening rows outlive its round).
 *
 * WHY STORED: the numbers this policy branches on describe the review of a text the loop HAS installed,
 * and the next selection destroys the evidence — it marks the certified findings `fixed`, truncates
 * drafts, and a later Editor downgrade can re-cost a row. Re-counting live rows would let the count
 * drift after the decision, so a plateau could be argued away (or invented) by a write that happened
 * afterwards. The entry is the loop's best judgement AT SETTLE TIME, frozen (requirement 5).
 *
 * THE WALK is the same shape as the candidate walk, one entry per accepted revision instead of one per
 * attempt, and it reuses `SAMPLING_NO_PROGRESS_STREAK` rather than inventing a second number: the
 * request's own words — "the same policy, applied across reviewed accepted revisions" — make it the same
 * constant. Entries are partitioned by WAVE, so the Author's clear of the plateau escalation
 * (`engine.ts:rearmSamplingWave` bumps `sampling_wave`) is a fresh baseline and not a longer streak;
 * reading an old wave after a bump is an audit read, not policy.
 */
export function revisionReviewProgressOf(
    store: Store,
    story: Story,
    wave = samplingWaveOf(story)
): RevisionReviewProgress {
    const entries = summaryReviewHistoryOf(story).filter((entry) => entry.wave === wave);

    let bestBlockingFound: number | undefined;
    let improvements = 0;
    let noImprovement = 0;

    for (const entry of entries) {
        // The first reviewed revision MEASURES the hill; it does not climb it.
        if (bestBlockingFound === undefined) {
            bestBlockingFound = entry.blocking_found;
            continue;
        }

        if (entry.blocking_found < bestBlockingFound) {
            bestBlockingFound = entry.blocking_found;
            improvements += 1;
            noImprovement = 0;
            continue;
        }

        noImprovement += 1;
    }

    return {
        wave,
        entries,
        reviewed: entries.length,
        bestBlockingFound,
        improvements,
        noImprovement,
        plateaued: noImprovement >= SAMPLING_NO_PROGRESS_STREAK
    };
}

/**
 * Is the Story on an accepted-revision plateau? One predicate, read by the arming rule, the queue and
 * the drain probe, so generation cannot buy a revision the audit has already refused (requirement 3's
 * "stop actual automated work, not just the status text").
 */
export const revisionReviewPlateau = (store: Store, story: Story): boolean =>
    revisionReviewProgressOf(store, story).plateaued;

/**
 * The audit entry this sweep owes, or `undefined` when nothing may be recorded yet.
 *
 * THE THREE GATES, and why each one is load-bearing:
 *   * the carried revision is the CURRENT round's selection (`isDeepReviewSelection`, T10/F7) —
 *     `deepReviewComplete` answers "owed nothing" for an older-round selection, so without this guard an
 *     Author-selected draft from a previous round would be audited a second time (requirement 1's
 *     "exclude superseded/old revision reviews");
 *   * its deep review has FULLY closed (`deepReviewComplete`) — a half-read draft has not been judged
 *     yet, and counting it would put a pass that has not run on the record as a clean revision;
 *   * no blocking suspicion is still `unconfirmed` (`unconfirmedBlockingFindings`) — requirement 5's
 *     reconciliation. The Critics file UNCONFIRMED findings and the Editor's verification decides them
 *     (D-33); counting a suspicion before that decision is over, then having the Editor dispute it or
 *     re-cost it below the bar, would leave a permanent blocking regression in the audit for a defect
 *     nobody believes. This is also not a stall: those same unconfirmed rows already refuse the sampler
 *     (`samplingArmed`), so the loop is already waiting here, and the guard therefore triggers BEFORE
 *     the next sampler in the adversarial scenario — the round only arms once the verification has
 *     settled, and this step runs earlier in the same sweep.
 *
 * The entry is keyed by `revision_id`, which is what makes the write idempotent across sweeps and across
 * a restart: the audit is append-only, so the loop can never re-count a revision it has already judged.
 */
export function pendingRevisionReviewEntry(
    store: Store,
    story: Story
): { revision: Revision; blocking: Finding[] } | undefined {
    const selected = selectedSummaryRevision(store, story.id);

    if (selected === undefined) return undefined;
    if (!isDeepReviewSelection(story, selected)) return undefined;
    if (!deepReviewComplete(store, story, selected)) return undefined;
    if (unconfirmedBlockingFindings(store, story).length > 0) return undefined;
    if (summaryReviewHistoryOf(story).some((entry) => entry.revision_id === selected.id)) return undefined;

    return { revision: selected, blocking: revisionBlockingFindings(store, story, selected) };
}

/**
 * Open the Author-facing escalation row for a failure the loop cannot fix itself, or return the
 * one already waiting.
 *
 * WHY A TASK AND NOT A STATUS: §4.1's `pending_kind` enum has no "question" member (L-36's comment
 * in ./status says the same), and P7's channel for "only the Author can decide this" is the queue.
 * `owner_role: 'author'` is the same shape `requestAuthor` writes (tools/reader.ts), and
 * `reusePrefix` makes the call idempotent across sweeps: re-escalating every sweep would bury the
 * Author in identical rows.
 */
export function openEscalationTask(
    store: Store,
    storyId: string,
    input: {
        title: string;
        detail: string;
        reusePrefix: string;
        why: string;
        priority?: number;
        /**
         * The row's state. `open` (the default, and what every existing escalation writes) keeps the
         * row in the queue as a hold on the drain; `blocked` is the shape `reader.ts:requestAuthor`
         * uses for a question, and it is what `status.ts:decideStory` step 4 turns into the "the crew
         * asked you" Author wait — a `blocked` row is NOT dispatchable work, so the loop stops instead
         * of reading `ready` with nothing to run.
         */
        state?: 'open' | 'blocked';
        /** The finding this question is about, so the sweep can close the row when it is decided. */
        findingRef?: string;
    }
): Task {
    const state = input.state ?? 'open';

    // T10/F2: when the row belongs to ONE finding, the reuse lookup matches the finding itself, not
    // just the title's opening. Ids come from one counter, so `finding_1` is a text prefix of
    // `finding_10` and a title-only prefix match hands one finding's question to another finding's
    // sweep — the "one row per finding" contract this helper exists to keep.
    const existing = store.tasks
        .list()
        .find(
            (task) =>
                task.story_id === storyId &&
                task.kind === 'escalation' &&
                task.state === state &&
                task.title.startsWith(input.reusePrefix) &&
                (input.findingRef === undefined || task.finding_ref === input.findingRef)
        );

    if (existing !== undefined) return existing;

    return store.tasks.create(
        {
            story_id: storyId,
            kind: 'escalation',
            title: input.title,
            detail: input.detail,
            owner_role: 'author',
            state,
            priority: input.priority ?? 1,
            attempts: 0,
            ...(input.findingRef === undefined ? {} : { finding_ref: input.findingRef })
        },
        loopAttr(input.why)
    ) as Task;
}

// ---------------------------------------------------------------------------
// Runs and the claim-with-lease (L-2, S-4a, D-36)
// ---------------------------------------------------------------------------

/**
 * Run states that mean "a crew is alive" — everything the §4.13 enum has before teardown
 * (`torn_down`, `failed`, `abandoned` are all closed).
 */
export const LIVE_RUN_STATES: RunState[] = ['spawning', 'working', 'reporting'];

export const isLiveRun = (run: Run): boolean => LIVE_RUN_STATES.includes(run.state);

export function liveRuns(store: Store, storyId?: string): Run[] {
    return store.runs
        .list()
        .filter((run) => isLiveRun(run) && (storyId === undefined || run.story_id === storyId))
        .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * The durable half of the claim (L-2): a Work Item is claimed while a live run row names it.
 *
 * The Work Item id is deterministic (see `WorkCandidate.key`), so this single query answers "has a
 * crew already got this job?" — including after a restart, where the run row outlived the process.
 * The lease itself is the run row's `updated_at`, checked by `lapsedRuns`.
 *
 * S-RUNTIME: `storyId` scopes the read to one Story, because some claim families carry no local id at
 * all (`wi_verify_ideas`, `wi_whole_check`, `wi_probe_critic_chapters_1`) and are therefore the SAME
 * string in two books. Under the per-Story layout a store holds one Story and the scope is a no-op;
 * in a book holding several, an unscoped read lets one Story's live run claim another Story's job, and
 * the second Story never gets the work it owes. Omitted means "any Story", which is what a caller that
 * has no Story in hand (a projection asking "is this item taken?") wants.
 */
export const isClaimed = (store: Store, workItemId: string, storyId?: string): boolean =>
    store.runs.list().some(
        (run) => isLiveRun(run) && run.work_item_ref === workItemId && (storyId === undefined || run.story_id === storyId)
    );

/** The closed run rows for one Work Item — `undefined` when the item has never been dispatched. */
export function runsForItem(store: Store, workItemId: string): Run[] {
    return store.runs
        .list()
        .filter((run) => run.work_item_ref === workItemId)
        .sort((left, right) => left.id.localeCompare(right.id));
}

export const runById = (store: Store, runId: string): Run | undefined => store.runs.get(runId);

/** Live runs of one template within one Story — S-5's per-template, per-Story cap. */
export function liveRunsForTemplate(store: Store, storyId: string, templateRef: string): number {
    return liveRuns(store, storyId).filter((run) => run.template_ref === templateRef).length;
}

/**
 * Live runs whose lease has lapsed (S-4a, D-36). The clock is the CALLER's `now`, never
 * `Date.now()` inside this function, so a test can lapse a lease without waiting or faking a clock.
 */
export function lapsedRuns(store: Store, nowMs: number, leaseIdleMs: number): Run[] {
    return liveRuns(store).filter((run) => nowMs - new Date(run.updated_at).getTime() > leaseIdleMs);
}

/** S-4's no-op accounting: runs that closed this round, and among them the ones that reported nothing. */
export function closedRunsSince(store: Store, sinceMs: number): { closed: Run[]; noOps: Run[] } {
    const closed = store.runs
        .list()
        .filter((run) => !isLiveRun(run) && new Date(run.updated_at).getTime() >= sinceMs)
        .sort((left, right) => left.id.localeCompare(right.id));

    return { closed, noOps: closed.filter((run) => run.no_op === true) };
}

// ---------------------------------------------------------------------------
// Proposals (§4.16, D-20)
// ---------------------------------------------------------------------------

export const pendingProposals = (store: Store, storyId: string): Proposal[] =>
    store.proposals
        .list()
        .filter((proposal) => proposal.story_id === storyId && proposal.state === 'pending')
        .sort((left, right) => left.id.localeCompare(right.id));

// ---------------------------------------------------------------------------
// Templates (§4.12) — who the loop can dispatch
// ---------------------------------------------------------------------------

/** The template rows a Story holds, in assignment order; an unknown slug resolves to nothing (D-17b). */
export function assignedTemplates(store: Store, story: Story): Template[] {
    const refs = story.template_refs ?? [];
    const rows: Template[] = [];

    for (const ref of refs) {
        const row = store.templates.list().find((template) => template.id === ref || template.name === ref);

        if (row !== undefined && !rows.some((held) => held.id === row.id)) rows.push(row);
    }

    return rows;
}

/**
 * The templates that can serve this phase with this role kind (L-4: three loops, three template sets;
 * L-33: the phase must be the Story's current one).
 */
export function templatesFor(store: Store, story: Story, kind: string): Template[] {
    return assignedTemplates(store, story).filter(
        (template) =>
            (template.serves_phase ?? []).includes(story.phase) &&
            (template.roles ?? []).some((role) => role.kind === kind)
    );
}

/**
 * D-17d: how many parallel drafts one unit gets, from the AUTHOR's setting rather than an engine
 * constant (D-38a). A template with no `attempts` gets one draft — divergence is off, not defaulted on
 * behind the Author's back.
 */
export const attemptsOf = (template: Template | undefined): number => {
    const raw = template?.attempts;

    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1;
};

/** S-5/D-38a: the per-template, per-Story ceiling. Absent means one at a time. */
export const maxConcurrentOf = (template: Template | undefined): number => {
    const raw = template?.max_concurrent;

    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1;
};

/** The role NAME inside a template for a kind — the Work Item's `roleName` (U-7 shows it). */
export function roleNameOf(template: Template | undefined, kind: string): string {
    const role = (template?.roles ?? []).find((candidate) => candidate.kind === kind);

    return role?.name ?? kind;
}

// ---------------------------------------------------------------------------
// Ordering and journal helpers
// ---------------------------------------------------------------------------

/** The journal's high-water mark — the drain probe's watermark (see `ProbeState.journal_seq`). */
export const latestJournalSeq = (store: Store): number =>
    store.journal.reduce((highest, event) => Math.max(highest, event.seq), 0);

/**
 * State events after a watermark, scoped to one Story (D-14's exclusion rules apply: the Digest and
 * the run rows are machinery, not story state, and a `stories` patch that only moved `digest_rev` is
 * the engine's bookkeeping — see digest.ts:141-158 for the same three exclusions).
 */
export function stateEventsSince(store: Store, storyId: string, sinceSeq: number): CommitEvent[] {
    return store.journal.filter(
        (event) =>
            event.seq > sinceSeq &&
            event.collection !== 'digests' &&
            event.collection !== 'runs' &&
            !(event.collection === 'stories' && event.id === storyId && isDigestRevOnlyPatch(event.patch)) &&
            touchesStory(store, storyId, event)
    );
}

function isDigestRevOnlyPatch(patch: unknown): boolean {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return false;

    const keys = Object.keys(patch as Record<string, unknown>);

    return keys.length === 1 && keys[0] === 'digest_rev';
}

/**
 * Does this event belong to this Story? A create/update patch carries `story_id` directly, and for
 * anything else (a delete, or a patch that omitted it) the record itself is consulted — or, when the
 * record is gone, the deleted row the journal kept (P11's undo payload).
 */
function touchesStory(store: Store, storyId: string, event: CommitEvent): boolean {
    if (event.collection === 'stories') return event.id === storyId;

    const patch = event.patch as Record<string, unknown> | undefined;

    if (patch !== undefined && typeof patch === 'object' && typeof patch.story_id === 'string')
        return patch.story_id === storyId;

    const collection = (store as unknown as Record<string, { get(id: string): { story_id?: string } | undefined }>)[
        event.collection
    ];

    if (collection === undefined) return false;

    return collection.get(event.id)?.story_id === storyId;
}

/** Findings and Ideas created after a watermark — exactly "what the fresh round turned up" (L-37.3). */
export function findingsCreatedSince(store: Store, storyId: string, sinceSeq: number): Finding[] {
    return stateEventsSince(store, storyId, sinceSeq)
        .filter((event) => event.collection === 'findings' && event.op === 'create')
        .map((event) => store.findings.get(event.id))
        .filter((finding): finding is Finding => finding !== undefined && finding.story_id === storyId);
}

export function ideasCreatedSince(store: Store, storyId: string, sinceSeq: number): Idea[] {
    return stateEventsSince(store, storyId, sinceSeq)
        .filter((event) => event.collection === 'ideas' && event.op === 'create')
        .map((event) => store.ideas.get(event.id))
        .filter((idea): idea is Idea => idea !== undefined && idea.story_id === storyId);
}
