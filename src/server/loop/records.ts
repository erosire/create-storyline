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
    OPEN_TASK_STATES,
    UNDECIDED_IDEA_STATES,
    type LoopChapter,
    type LoopDirective,
    type LoopStory
} from './types';
import { DEFAULT_SUMMARY_READERS, DEFAULT_SUMMARY_SAMPLING } from '../../shared/types';
import { seedHashOf } from '../../shared/seed-hash';
import type {
    Chapter,
    Cost,
    Directive,
    Finding,
    Idea,
    Plotline,
    Proposal,
    Revision,
    Run,
    RunState,
    SampleReview,
    SeedBrief,
    Story,
    StoryPhase,
    Task,
    Template,
    Verdict
} from '../../shared/types';
import type { CommitEvent } from '../store';
import type { Store } from '../store';

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

/** Tasks whose `finding_ref` points at one finding — how an approved finding's fix work is found again. */
export function tasksForFinding(store: Store, storyId: string, findingId: string): Task[] {
    return store.tasks
        .list()
        .filter(
            (task) =>
                task.story_id === storyId && task.finding_ref === findingId && OPEN_TASK_STATES.includes(task.state)
        );
}

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
 * The findings that still block a Summary from being final: critical or major findings on the
 * SELECTED draft. Findings on a discarded sibling are history, not work — the next Reader round
 * reads the kept draft fresh. Minor and taste findings never block (they are not show-stoppers).
 */
export function summaryBlockingFindings(store: Store, story: Story, unitRef: string): Finding[] {
    const selected = selectedSummaryRevision(store, story.id, unitRef);

    if (selected === undefined) return [];

    return storyFindings(store, story.id).filter((finding) => {
        if (finding.state !== 'confirmed' && finding.state !== 'approved') return false;
        // NO `reader_confirmed` GATE (phase-1 research pipeline, §6.4 step 6): the tool-using deep
        // review IS the Reader's read of the selected revision, and the Editor's verification of
        // those findings is the acceptance that arms the next round. The classic pipeline's extra
        // per-finding confirmation thread was removed with it, so requiring the flag here would
        // make every finding invisible to the phase gate.
        if (finding.cost !== 'critical' && finding.cost !== 'major') return false;

        // A draft-scoped finding names its draft in L-11a's related_refs. A finding with none is
        // about the Summary as a whole and therefore still blocks the final choice.
        const related = finding.related_refs ?? [];

        return related.length === 0 ? finding.target_ref === unitRef : related.includes(selected.id);
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
 */
export function wontfixTasks(store: Store, storyId: string): string[] {
    const ids: string[] = [];

    for (const task of openTasks(store, storyId)) {
        store.tasks.update(
            task.id,
            { state: 'wontfix' },
            loopAttr(`cleared the pending queue for ${storyId} (L-36, U-1b)`),
            [{ id: task.id, rev: task.rev }]
        );
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

/** L-37's condition 2: every suspicion a Reader or checker raised must be confirmed or disputed. */
export const unconfirmedFindings = (store: Store, storyId: string): Finding[] =>
    storyFindings(store, storyId).filter((finding) => finding.state === 'unconfirmed');

/**
 * Phase ①'s bar is critical/major (D-30, D-34): a Reader may file clarity and description notes
 * at `minor`/`taste`, and the Editor records them, but they are not show-stoppers. Those notes
 * must not hold the Editor's choice, the fix pass or the phase sign-off — only a suspicion that
 * would actually cost the Writer a pass does. Every other phase keeps D-33's all-costs rule.
 */
export const unconfirmedBlockingFindings = (store: Store, story: Story): Finding[] =>
    unconfirmedFindings(store, story.id).filter(
        (finding) =>
            story.phase !== 'summary' || finding.cost === 'critical' || finding.cost === 'major'
    );

/**
 * D-34: `confirmed` findings the dial does NOT cover — the pile on the Author's desk.
 *
 * PHASE ①'S BAR IS CRITICAL/MAJOR. A Reader may file clarity and description notes at
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

    const leftSeq = creationSeq(store, left.id);
    const rightSeq = creationSeq(store, right.id);

    if (leftSeq >= 0 && rightSeq >= 0) return leftSeq > rightSeq;

    return left.created_at > right.created_at;
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

/** L-37's condition 4 / L-20: any unit still waiting on an Editor. */
export function unitsWithCompetingRevisions(store: Store, storyId: string): string[] {
    const units = new Set<string>();

    for (const revision of store.revisions.list()) {
        if (revision.story_id === storyId && isReviewableDraft(revision)) units.add(revision.unit_ref);
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
 * (criteria/engine.ts:scopeTargets), so an ordinary per-unit checker pass that files a Story-targeted
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
 * (§6.2a: checkers first, then the choice).
 *
 * Two target conventions are accepted on purpose: a checker that files against the REVISION id
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
 * The attempt cap of one round's SAMPLING family (§6.4 step 3): `summary_sampling` owed samples plus
 * the retry allowance. Read from here by `./work` (the dispatch gate and the wave-scoped exhaustion
 * read) and `./engine` (the selection gate and the wave re-arm), so those three call sites cannot
 * disagree about when a round is spent. `./status`'s drain sentence adds the same two numbers from
 * the allowance directly; the number is identical, and that file is outside this pass's ownership.
 */
export const samplingCapOf = (story: Story): number => samplingSizeOf(story) + SAMPLING_RETRY_ALLOWANCE;

/** Phase ①'s screening count (§6.4 step 4): how many screening Readers judge each sample. */
export function screeningSizeOf(story: Story): number {
    const raw = story.summary_readers;

    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 1) return Math.floor(raw);

    return DEFAULT_SUMMARY_READERS;
}

/** The sampling round IN FLIGHT: the rounds before it completed a selection (§6.6). */
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

/** The claim key of one brief's research pass — the brief's `rev` IS the generation (§6.4 gate 2). */
export const researchKeyOf = (brief: SeedBrief): string => `wi_research_${brief.rev}`;

/** Has the accepted brief's research pass CLOSED? A live run does not count — sampling waits. */
export function researchClosed(store: Store, story: Story, brief: SeedBrief): boolean {
    return runsForItem(store, researchKeyOf(brief)).some((run) => run.story_id === story.id && !isLiveRun(run));
}

/**
 * Round 1 samples as soon as structure and research are closed; a REFINEMENT round (§6.4 step 7)
 * waits until the deep review has finished defining the issues it must answer —
 *
 *   * at least one OPEN `fix` task exists (the approved work the next prompt carries), AND
 *   * no critical/major suspicion is still `unconfirmed` (an unverified complaint is not an
 *     instruction: compiling it into a Writer prompt would spend a round on a claim the Editor
 *     has not accepted, D-33).
 *
 * `round` is passed in so the same predicate serves work generation, the drain preconditions and
 * the selection sweep (the caller always knows which round it is asking about).
 */
export function samplingArmed(store: Store, story: Story, round: number): boolean {
    if (round <= 1) return true;

    return openFixTasks(store, story.id).length > 0 && unconfirmedBlockingFindings(store, story).length === 0;
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

/** One draft's screening reviews, oldest first — the selector's evidence (§6.5). */
export function screensFor(store: Store, revisionId: string): SampleReview[] {
    return store.sampleReviews
        .list()
        .filter((review) => review.revision_ref === revisionId)
        .sort(recency);
}

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
 */
export const samplePrefixOf = (summaryRef: string, round: number, wave = 0): string =>
    wave > 0 ? `wi_sample_${summaryRef}_${round}_w${wave}_` : `wi_sample_${summaryRef}_${round}_`;

/** How many screening runs one draft's claim family has already dispatched (the retry counter). */
export function screenAttempts(store: Store, revisionId: string): number {
    const prefix = screenPrefixOf(revisionId);

    return store.runs.list().filter((run) => (run.work_item_ref ?? '').startsWith(prefix)).length;
}

/** How many sampling runs the in-flight round's CURRENT WAVE has already dispatched (the retry counter). */
export function sampleAttempts(store: Store, summaryRef: string, round: number, wave = 0): number {
    const prefix = samplePrefixOf(summaryRef, round, wave);

    return store.runs.list().filter((run) => (run.work_item_ref ?? '').startsWith(prefix)).length;
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
 * The OPEN `fix` tasks (§4.7) — D-34's approved work, and the list the next sampling round's
 * prompt compiles (§6.8). A `claimed` row is a fix pass in flight, which phase ① no longer runs;
 * the arming gate reads only what is waiting, so the round cannot be spent on work already moving.
 */
export function openFixTasks(store: Store, storyId: string): Task[] {
    return openTasks(store, storyId).filter((task) => task.kind === 'fix' && task.state === 'open');
}

/**
 * The claim key of one deep-review Reader pass over the SELECTED revision (§6.4 step 6).
 *
 * A separate family from `wi_screen_` on purpose: the screening passes are no-tool one-turn runs
 * that rank the samples, while these hold the tool catalogue and judge the winner. One ledger must
 * not confuse them.
 */
export const deepReviewKeyOf = (revisionId: string, pass: number): string => `wi_review_${revisionId}_a${pass}`;

/** How many deep-review passes the selected revision still owes (a live pass does not count). */
export function deepReviewPassesOwed(store: Store, story: Story, revision: Revision | undefined): number {
    if (revision === undefined) return 0;

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

/**
 * Open the Author-facing escalation row for a failure the loop cannot fix itself, or return the
 * one already waiting.
 *
 * WHY A TASK AND NOT A STATUS: §4.1's `pending_kind` enum has no "question" member (L-36's comment
 * in ./status says the same), and P7's channel for "only the Author can decide this" is the queue.
 * `owner_role: 'author'` is the same shape `requestAuthor` writes (tools/checker.ts), and
 * `reusePrefix` makes the call idempotent across sweeps: re-escalating every sweep would bury the
 * Author in identical rows.
 */
export function openEscalationTask(
    store: Store,
    storyId: string,
    input: { title: string; detail: string; reusePrefix: string; why: string; priority?: number }
): Task {
    const existing = store.tasks
        .list()
        .find(
            (task) =>
                task.story_id === storyId &&
                task.kind === 'escalation' &&
                task.state === 'open' &&
                task.title.startsWith(input.reusePrefix)
        );

    if (existing !== undefined) return existing;

    return store.tasks.create(
        {
            story_id: storyId,
            kind: 'escalation',
            title: input.title,
            detail: input.detail,
            owner_role: 'author',
            state: 'open',
            priority: input.priority ?? 1,
            attempts: 0
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
 */
export const isClaimed = (store: Store, workItemId: string): boolean =>
    store.runs.list().some((run) => isLiveRun(run) && run.work_item_ref === workItemId);

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
