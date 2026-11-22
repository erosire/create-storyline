// Directives: the Author's one line of direction to the Editor (D-19, L-24, L-27, W12, V-1).
//
// §4.14 says the loop "determined" the impact, so the resolution below is a lookup rather than an
// inference — every clause names a record the Author can point at:
//
//   * a ref the caller passed (`refs`, the UI's "applies to" picker) always counts;
//   * `ch4` / `chapter 4` / `#4` resolve by chapter ORDER, the number the Author actually types;
//   * a record id that appears verbatim in the text counts (the Author pasted it from the tree);
//   * a chapter title or plotline heading quoted in the sentence counts, because that is how the Author
//     refers to a scene ("kill the mentor in ch4" names both a character and a chapter);
//   * a CastMember name or a LedgerEntry `subject` that appears counts its owning chapter, since the
//     fact or the person is what moved and the chapter is where it is written (§4.14's impact list
//     explicitly includes ledger entries);
//   * the result is expanded ONE hop through `stories.chapter_deps` (L-9: the dependency set exists to
//     say "which chapters a change must propagate to").
//
// What the loop does with the result is the same propagation any other change to the book gets
// (L-11a): `needs_recheck` for the dependents, and a report of what it touched. The TASKS are the
// Editor's — a `directive_work` thread reviews the sentence and calls `createTask`; the sweep then
// dispatches each task as its own fresh thread (S-1, not delegation). The directive's own tasks
// outrank everything in the queue (priority 1), and the runs that were busy on a now-changed artifact
// are stopped, because a Writer mid-pass on chapter 4 after the Author said the mentor dies there is
// writing a scene that no longer exists.
import { authorAttr, loopAttr, storyChapters, storyPlotlines } from './records';
import { createFixTask, dependents, markNeedsRecheck, phaseRank } from './invalidation';
import { TASK_KINDS, type DirectiveReport, type LoopDirective } from './types';
import type { Story, Task } from '../../shared/types';
import type { Store } from '../store';

/** The `ch4` / `chapter 4` / `#4` forms, matched case-insensitively. */
const ORDER_PATTERNS = [/\bch\s*#?(\d{1,3})\b/gi, /\bchapter\s*#?(\d{1,3})\b/gi, /#(\d{1,3})\b/g];

/** Record ids this build's store mints, matched wherever they appear in the sentence. */
const RECORD_ID = /\b(?:chap|plot|summ|cast|ledg|find|idea)_[A-Za-z0-9]+/g;

/**
 * Which artifacts this directive touches — the mechanical resolution, before dependency expansion.
 * Returns refs (record ids) plus the ledger entries named, which §4.14 counts as impact too.
 */
export function resolveDirectiveTargets(
    store: Store,
    story: Story,
    text: string,
    refs: string[] = []
): { refs: string[]; ledger: string[] } {
    const chapters = storyChapters(store, story.id);
    const plotlines = storyPlotlines(store, story.id);
    const found = new Set<string>(refs.filter((ref) => typeof ref === 'string' && ref.length > 0));
    const ledger: string[] = [];

    for (const pattern of ORDER_PATTERNS) {
        for (const match of text.matchAll(pattern)) {
            const order = Number.parseInt(match[1] ?? '0', 10);
            const chapter = chapters.find((row) => row.order === order);

            if (chapter !== undefined) found.add(chapter.id);

            const plotline = plotlines.find((row) => row.order === order);

            if (plotline !== undefined) found.add(plotline.id);
        }
    }

    for (const match of text.matchAll(RECORD_ID)) {
        const ref = match[0];

        if (chapters.some((chapter) => chapter.id === ref) || plotlines.some((plotline) => plotline.id === ref))
            found.add(ref);

        const entry = store.ledger.get(ref);

        if (entry !== undefined && entry.story_id === story.id) ledger.push(entry.id);
    }

    // A name or a subject mentioned in prose: the person/fact is what moved, the chapter is where it
    // is written, and the ledger entry is the thing the next pass has to reconcile.
    const haystack = text.toLowerCase();

    for (const member of store.cast.list()) {
        if (member.story_id !== story.id) continue;
        if (member.name.length === 0 || !haystack.includes(member.name.toLowerCase())) continue;

        // A character the directive names is a book-wide fact, so the chapters that name them in their
        // contract are the ones the loop can prove are affected.
        for (const plotline of plotlines) {
            const contract = `${plotline.must_happen ?? ''} ${plotline.must_change ?? ''} ${plotline.pov ?? ''}`;

            if (contract.toLowerCase().includes(member.name.toLowerCase())) found.add(plotline.id);
        }
    }

    for (const entry of store.ledger.list()) {
        if (entry.story_id !== story.id) continue;
        if (entry.subject.length === 0 || !haystack.includes(entry.subject.toLowerCase())) continue;

        ledger.push(entry.id);

        if (entry.chapter_ref !== undefined) found.add(entry.chapter_ref);

        for (const chapter of chapters) {
            if (chapter.summary?.toLowerCase().includes(entry.subject.toLowerCase()) === true) found.add(chapter.id);
        }
    }

    // A title or heading quoted in the sentence is the most common way an Author points at a scene.
    for (const chapter of chapters) {
        if (chapter.title.length > 0 && haystack.includes(chapter.title.toLowerCase())) found.add(chapter.id);
    }

    for (const plotline of plotlines) {
        if (
            plotline.heading !== undefined &&
            plotline.heading.length > 0 &&
            haystack.includes(plotline.heading.toLowerCase())
        ) {
            found.add(plotline.id);

            const chapter = chapters.find((row) => row.plotline_ref === plotline.id);

            if (chapter !== undefined) found.add(chapter.id);
        }
    }

    return { refs: [...found], ledger: [...new Set(ledger)] };
}

/**
 * The escalation this directive answers (P7, L-24).
 *
 * A run that called `requestAuthor` left a `blocked` task — the queue's way of saying "only the Author
 * can move this". A directive IS the answer, so the row is closed here rather than left to rot, and the
 * report names it so the Author can see which question they just settled.
 */
export function findOpenEscalation(store: Store, story: Story): Task | undefined {
    return store.tasks
        .list()
        .filter((task) => task.story_id === story.id && task.state === 'blocked')
        .sort((left, right) => left.id.localeCompare(right.id))[0];
}

/**
 * Records one directive and does the propagation the SERVER owns: resolve the artifacts, mark the
 * dependents, stop the runs that are writing into the changed artifacts, answer the escalation, and
 * report what it touched. It deliberately creates no tasks.
 *
 * THE EDITOR OWNS THE TASKS (the user's model, V-1): the Author's channel is the Editor, so a
 * `directive_work` job is queued and the Editor reviews the direction and calls `createTask` for the
 * work it implies. The server then reads the queue and opens a thread for each task (the sweep), which
 * is not a delegate: no nested conversation, one Work Item per thread. If no Editor review produces
 * any task (no Editor assigned, a failed thread), `createDirectiveFallbackTasks` keeps D-19's promise
 * that a directive still becomes work.
 *
 * `killRun` is handed in by the engine rather than called here, because stopping a run belongs to the
 * executor (it owns the abort controller); the directive layer decides WHICH runs must stop and reports
 * the count. A run working on an artifact the directive just changed is stopped for the same reason P8
 * stops everything else: its write would land on a book that no longer exists.
 *
 * L-27: a directive on a `completed` Story returns it to `ready` — "a finished book the Author keeps
 * writing by hand stays policed forever". That re-opening is recorded in the report so the row can say
 * it happened.
 */
export function recordDirective(
    store: Store,
    story: Story,
    input: { text: string; refs?: string[]; at: string; killRun?: (runId: string) => void }
): { directive_id: string; impact: DirectiveReport; targets: string[] } {
    const resolved = resolveDirectiveTargets(store, story, input.text, input.refs ?? []);
    const targets = dependents(store, story, resolved.refs);
    const reopened = story.status === 'completed';
    const escalation = findOpenEscalation(store, story);

    const directive = store.directives.create(
        {
            story_id: story.id,
            text: input.text,
            // §4.14's `impact` is the ref list; the richer report rides on the loop's addition below.
            impact: [...targets, ...resolved.ledger],
            // The Editor's task plan is what finishes this row; it stays `propagating` until then.
            state: 'propagating',
            targets
        },
        authorAttr(`the Author issued a directive to the Editor (D-19): ${input.text.slice(0, 120)}`)
    );

    // 1. The propagation both directions in time (L-11a): the directive is the decision, so the
    //    dependents are re-judged whether or not the Editor's review has landed yet.
    const rechecks = markNeedsRecheck(
        store,
        story,
        targets,
        `${directive.id}: the Author changed the book, dependents are re-judged (L-11a, D-19)`
    );

    // 2. The runs that were busy on those artifacts (P8's mechanism, L-24's "the crew needed a
    //    decision" now that they have one).
    let stopped = 0;

    if (input.killRun !== undefined) {
        for (const run of store.runs.list()) {
            if (run.story_id !== story.id) continue;
            if (!['spawning', 'working', 'reporting'].includes(run.state)) continue;
            if ((run.work_item_ref ?? '').length === 0) continue;
            if (!targets.some((ref) => (run.work_item_ref ?? '').includes(ref))) continue;

            input.killRun(run.id);
            stopped += 1;
        }
    }

    // 3. The escalation this answers (P7). `done` is the honest state: the question was answered.
    if (escalation !== undefined) {
        store.tasks.update(
            escalation.id,
            { state: 'done' },
            authorAttr(`the directive answered the crew's question (P7, L-24): ${input.text.slice(0, 80)}`),
            [{ id: escalation.id, rev: escalation.rev }]
        );
    }

    const impact: DirectiveReport = {
        runs_stopped: stopped,
        // The Editor's thread is the task author; this count lands when its review closes
        // (`completeDirective`), so the row never claims work that has not been queued yet.
        tasks_created: 0,
        tasks_superseded: escalation === undefined ? 0 : 1,
        needs_recheck: rechecks,
        ledger_touched: resolved.ledger,
        answered_task_id: escalation?.id ?? null,
        completed_reopened: reopened
    };

    store.directives.update(
        directive.id,
        { report: impact },
        authorAttr(`directive ${directive.id} is waiting for the Editor's task review (D-19)`),
        [{ id: directive.id, rev: directive.rev }]
    );

    return { directive_id: directive.id, impact, targets };
}

/**
 * The fallback D-19 promise, used only when an Editor review produced no tasks (or could not run):
 * one fix task per affected artifact, priority 1, naming the directive so the sweep and the Writer's
 * brief can read the provenance from `detail` (D-11).
 *
 * No `findingId` on purpose: §4.7's `finding_ref` names a row in `findings`, and a Directive is not a
 * finding (D-19). The same reason holds when the Editor writes its own tasks through `createTask`.
 */
export function createDirectiveFallbackTasks(store: Store, story: Story, directive: LoopDirective): number {
    const refs = directive.targets ?? directive.impact.filter((ref) => !ref.startsWith('ledg'));
    let tasksCreated = 0;

    for (const ref of refs) {
        if (ref === story.id) continue;

        createFixTask(store, story, {
            unitRef: ref,
            title: `propagate: ${directive.text.slice(0, 120)}`,
            detail: `${directive.id} · ${ref}`,
            priority: 1,
            why: `${directive.id} had no Editor task plan; the loop queued the fallback work itself (D-19, D-11)`
        });
        tasksCreated += 1;
    }

    return tasksCreated;
}

/** The zero report, so an old or interrupted row can still be completed without inventing counts. */
const EMPTY_REPORT: DirectiveReport = {
    runs_stopped: 0,
    tasks_created: 0,
    tasks_superseded: 0,
    needs_recheck: [],
    ledger_touched: [],
    answered_task_id: null,
    completed_reopened: false
};

/**
 * Closes a propagating directive once the Editor's review has landed. The tasks are the Editor's;
 * this only records how many its thread queued and marks the row done (D-19's report).
 */
export function completeDirective(
    store: Store,
    directiveId: string,
    patch: Partial<DirectiveReport>,
    why: string
): void {
    const directive = store.directives.require(directiveId);
    const report: DirectiveReport = { ...EMPTY_REPORT, ...(directive.report ?? {}), ...patch };

    store.directives.update(directive.id, { state: 'done', report }, loopAttr(why), [
        { id: directive.id, rev: directive.rev }
    ]);
}

/**
 * Every directive still waiting for the Editor's review (or for a crash recovery to close it). The
 * sweep turns each one into a `directive_work` job; a done or rejected row is history.
 */
export function pendingDirectives(store: Store, storyId: string): LoopDirective[] {
    return store.directives
        .list()
        .filter(
            (directive) =>
                directive.story_id === storyId && directive.state !== 'done' && directive.state !== 'rejected'
        ) as LoopDirective[];
}

/** The task kind a directive's answer creates — kept as data so the sweep's dispatch mapping reads clearly. */
export const DIRECTIVE_TASK_KIND = TASK_KINDS.directive;

/** Is this ref from a later phase than the Story is standing in? A directive cannot touch those. */
export const refPhaseRank = (ref: string): number =>
    ref.startsWith('summ')
        ? phaseRank('summary')
        : ref.startsWith('plot')
          ? phaseRank('plotlines')
          : phaseRank('chapters');

/** Attribution helper kept here so the directive report and the tasks it creates say the same thing. */
export const directiveAttr = (why: string) => loopAttr(why);
