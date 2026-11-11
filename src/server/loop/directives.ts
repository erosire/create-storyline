// Directives: the Author's one line of direction, propagated mechanically (D-19, L-24, L-27, W12).
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
// (L-11a): tasks for the work, `needs_recheck` for the dependents, and a report of what it touched. It
// does NOT re-litigate the Author's decision: the directive's own tasks outrank everything in the queue
// (priority 1), and the runs that were busy on a now-changed artifact are stopped, because a Writer
// mid-pass on chapter 4 after the Author said the mentor dies there is writing a scene that no longer
// exists.
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
 * Applies one directive: creates the row, the tasks, and the propagation, and reports what it touched.
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
export function applyDirective(
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
            state: 'propagating'
        },
        authorAttr(`the Author issued a directive (D-19): ${input.text.slice(0, 120)}`)
    );

    // 1. The work it implies — one task per affected unit, priority 1, naming the directive so the
    //    queue can always say which instruction a task came from (D-11: the queue holds the plan).
    //
    // No `findingId` here on purpose: §4.7's `finding_ref` names a row in `findings`, and a Directive is
    // not a finding (D-19). The directive id rides in `detail`, which is where the sweep reads refs from
    // (work.ts:unitRefInTask), so the provenance survives without a bogus foreign ref.
    let tasksCreated = 0;

    for (const ref of targets) {
        if (ref === story.id) continue;

        createFixTask(store, story, {
            unitRef: ref,
            title: `propagate: ${input.text.slice(0, 120)}`,
            detail: `${directive.id} · ${ref}`,
            priority: 1,
            why: `${directive.id} propagated the Author's directive onto ${ref} (D-19, D-11)`
        });
        tasksCreated += 1;
    }

    // 2. The propagation both directions in time (L-11a), in the same commit as the tasks (L-11).
    const rechecks = markNeedsRecheck(
        store,
        story,
        targets,
        `${directive.id}: the Author changed the book, dependents are re-judged (L-11a, D-19)`
    );

    // 3. The runs that were busy on those artifacts (P8's mechanism, L-24's "the crew needed a
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

    // 4. The escalation this answers (P7). `done` is the honest state: the question was answered.
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
        tasks_created: tasksCreated,
        tasks_superseded: escalation === undefined ? 0 : 1,
        needs_recheck: rechecks,
        ledger_touched: resolved.ledger,
        answered_task_id: escalation?.id ?? null,
        completed_reopened: reopened
    };

    store.directives.update(
        directive.id,
        // The loop determined the impact, so the row is finished once the propagation landed (D-19's
        // "a report of what changed" is the `impact` field plus the report the addition below carries).
        { state: 'done', report: impact },
        authorAttr(`directive propagated: ${targets.length} artifacts, ${tasksCreated} tasks (D-19)`),
        [{ id: directive.id, rev: directive.rev }]
    );

    return { directive_id: directive.id, impact, targets };
}

/** Any directive the loop has not finished propagating (a crash between the create and the report). */
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
