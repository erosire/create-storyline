// Invalidation, propagation, and the artifact-scrapping verbs (§6.5, §6.3a, D-5, D-25, D-25a, D-3c).
//
// These are the writes the loop performs when a fact about the book changes. Each one is a plain
// function over an open store so the engine can compose several of them into ONE commit — and the
// "one commit" part is not style:
//   * L-11a's "in the same commit" is what makes a contradiction visible on both sides at once, so a
//     run never reads a half-propagated book (the L-8a case: chapter 12's defect marks chapter 1 in
//     the same group);
//   * D-22 and L-7 both demand that a decision and its consequences land together;
//   * D-36's tray deletion belongs to the lock commit for the same reason.
//
// L-11's line is the boundary this module respects: a change to a LOCKED artifact is not a commit, it
// is a backtrack (L-31). So nothing here unlocks anything, and `scrapPhasesAfter` is the only path
// that deletes a locked phase's artifacts.
import {
    authorAttr,
    deletePhaseIdeas,
    loopAttr,
    storyChapters,
    storyIdeas,
    storyPlotlines,
    storySummary,
    loopChapter
} from './records';
import { TASK_KINDS, UNDO_STACK_LIMIT, type LoopChapter, type UndoEntry } from './types';
import type { Chapter, ChapterSection, Story, StoryPhase, Task } from '../../shared/types';
import type { Store } from '../store';

/** The canonical phase order, so a backtrack and a lock can agree about what "later" means. */
const PHASE_ORDER: StoryPhase[] = ['summary', 'plotlines', 'chapters'];

export const phaseRank = (phase: StoryPhase): number => PHASE_ORDER.indexOf(phase);

/**
 * L-11 + L-11a: mark the named chapters (and their plotlines) `needs_recheck`, and reopen any chapter
 * already `done` that the change touches.
 *
 * Propagation runs BOTH directions in time, which is why the caller passes a set of refs rather than
 * "the chapter that changed": a contradiction between chapter 1 and chapter 12 marks both, and the
 * choice of which side to FIX is a separate decision (see `pickFixTarget`). A chapter with no declared
 * dependency is the case L-9 warns about, so the caller seeds the set from `stories.chapter_deps` as
 * well as from the finding's own refs.
 *
 * A `done` chapter is reopened by writing `state: 'needs_recheck'` — §4.4's enum has both states, and
 * L-12 requires the reopened chapter to re-enter Loop B automatically, which the sweep's `needs_recheck`
 * trigger then does.
 */
export function markNeedsRecheck(store: Store, story: Story, refs: string[], why: string): string[] {
    const touched: string[] = [];
    const chapterIds = new Set(storyChapters(store, story.id).map((chapter) => chapter.id));

    for (const ref of new Set(refs)) {
        if (chapterIds.has(ref)) {
            const chapter = store.chapters.get(ref);

            if (chapter === undefined || chapter.state === 'needs_recheck') continue;

            store.chapters.update(ref, { state: 'needs_recheck' }, loopAttr(why), [{ id: ref, rev: chapter.rev }]);
            touched.push(ref);

            // L-11 says the plotline travels with the chapter: a contract nobody re-read is a contract
            // the next Writer will silently violate.
            if (chapter.plotline_ref !== undefined) {
                const plotline = store.plotlines.get(chapter.plotline_ref);

                if (plotline !== undefined && !plotline.needs_recheck) {
                    store.plotlines.update(chapter.plotline_ref, { needs_recheck: true }, loopAttr(why), [
                        { id: chapter.plotline_ref, rev: plotline.rev }
                    ]);
                }
            }

            continue;
        }

        const plotline = store.plotlines.get(ref);

        if (plotline !== undefined && !plotline.needs_recheck) {
            store.plotlines.update(ref, { needs_recheck: true }, loopAttr(why), [{ id: ref, rev: plotline.rev }]);
            touched.push(ref);

            // A plotline that moved invalidates its chapter too, in the same commit (L-11).
            const chapter = storyChapters(store, story.id).find((row) => row.plotline_ref === ref);

            if (chapter !== undefined && chapter.state !== 'needs_recheck') {
                store.chapters.update(chapter.id, { state: 'needs_recheck' }, loopAttr(why), [
                    { id: chapter.id, rev: chapter.rev }
                ]);
                touched.push(chapter.id);
            }
        }
    }

    return touched;
}

/**
 * L-9's declared dependency set, expanded one hop: what a change to these refs must propagate to.
 *
 * Deliberately one hop and not a transitive closure — L-9's purpose is to say "which chapters a change
 * must propagate to", and a transitive closure over a 40-chapter set would recheck the book on every
 * edit, which is the same cost as no rule at all and reads as a broken loop.
 */
export function dependents(store: Store, story: Story, refs: string[]): string[] {
    const deps = story.chapter_deps ?? {};
    const out = new Set<string>();

    for (const ref of refs) {
        out.add(ref);

        for (const dependent of deps[ref] ?? []) out.add(dependent);
    }

    return [...out];
}

/**
 * Which side of a contradiction gets the fix task (L-11a: "the loop fixes the side the plotline says is
 * wrong", and §15 step 3b's chapter-1/locks case).
 *
 * The rule is mechanical on purpose: a chapter whose plotline NAMES the finding's subject in `setups`
 * or `payoffs` is the chapter that OWNS the fact, so that is the chapter to change. Ties go to the
 * earlier chapter, because the earlier chapter is the one later prose has to agree with. When no
 * plotline names the subject, the target of the finding is the target of the fix — the loop does not
 * invent a second opinion the Editor did not record.
 */
export function pickFixTarget(store: Store, story: Story, refs: string[], subject: string): string | undefined {
    const chapters = storyChapters(store, story.id).filter((chapter) => refs.includes(chapter.id));

    if (chapters.length === 0) return refs[0];

    const needle = normalise(subject);

    const owner = chapters.find((chapter) => {
        const plotline = store.plotlines.get(chapter.plotline_ref ?? '');

        if (plotline === undefined) return false;

        const owned = `${plotline.setups ?? ''} ${plotline.payoffs ?? ''}`;

        return needle.length > 0 && normalise(owned).includes(needle);
    });

    if (owner !== undefined) return owner.id;

    return [...chapters].sort((left, right) => left.order - right.order)[0].id;
}

/** Lowercase, whitespace-collapsed, punctuation-stripped — the same spirit as criteria's `normalizeKey`. */
function normalise(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * D-34 + D-11: the task a confirmed-and-approved finding owns.
 *
 * One task per finding (not per chapter), because the finding is the unit the Author approved and the
 * unit the verdict closes. `finding_ref` is what lets the sweep find the task again, and what makes
 * L-37's condition 1 ("no open task remains") decidable without guessing from a title.
 *
 * `findingId` is OPTIONAL because §4.7's `finding_ref` is a ref into `findings`, and not every fix task
 * starts from one: the directive path (directives.ts) queues the propagation of the Author's own
 * sentence, and a Directive row is not a finding (D-19). Writing a directive id into that column would
 * point the ref at a row `store.findings` has never heard of (work.ts:unitRefInTask and
 * records.ts:tasksForFinding both read it as a finding), so the column stays empty and `why` says what
 * really created the work.
 */
export function createFixTask(
    store: Store,
    story: Story,
    input: {
        findingId?: string;
        unitRef: string;
        title: string;
        detail: string;
        priority: number;
        criterionRef?: string;
        blocked?: boolean;
        /** Journal sentence for the row; defaults to the finding-approval wording (P11). */
        why?: string;
    }
): Task {
    // A `blocked` fix task is the one the crew cannot run: the defect is real and approved, but nothing
    // in §4 names an artifact a Writer could edit (a whole-book contradiction with no chapters on it).
    // Per T-12 that is a gap to hand to the Author, not a run whose brief the Writer has to improvise —
    // and `blocked` is not an open state (records.ts:OPEN_TASK_STATES), so it cannot hold `drained`
    // hostage while the crew stands there with nothing it is allowed to do.
    return store.tasks.create(
        {
            story_id: story.id,
            kind: TASK_KINDS.fix,
            title: input.title,
            detail: `${input.detail} · ${input.unitRef}`,
            owner_role: 'writer',
            state: input.blocked === true ? 'blocked' : 'open',
            priority: input.priority,
            criterion_ref: input.criterionRef,
            finding_ref: input.findingId,
            attempts: 0
        },
        loopAttr(input.why ?? `approval of ${input.findingId} created the fix work (D-34, D-11)`)
    );
}

/**
 * D-3c: grow the chapter set.
 *
 * New chapters enter as `outlined` — "added chapters enter the queue as `outlined`" — and each is
 * bound to the plotline at its order, because a chapter without a contract has nothing to deliver
 * (C-1, P4). The plotlines are re-sorted by order, which is exactly what a grow after a shrink needs:
 * the sequence moves, so every dependent chapter is rechecked by the caller (D-3c's last clause).
 */
export function materialiseChapters(store: Store, story: Story, count: number): string[] {
    const existing = storyChapters(store, story.id);
    const plotlines = storyPlotlines(store, story.id);
    const created: string[] = [];

    // Bind what exists first, so a chapter is never orphaned by a plotline that arrived later (C-1).
    for (const chapter of existing) {
        if (chapter.plotline_ref !== undefined && store.plotlines.get(chapter.plotline_ref) !== undefined) continue;

        const partner = plotlines.find((plotline) => plotline.order === chapter.order);

        if (partner === undefined) continue;

        store.chapters.update(
            chapter.id,
            { plotline_ref: partner.id },
            loopAttr(`bound chapter ${chapter.order} to its plotline (C-1, P4)`),
            [{ id: chapter.id, rev: chapter.rev }]
        );
    }

    for (let order = existing.length + 1; order <= count; order += 1) {
        const partner = plotlines.find((plotline) => plotline.order === order);

        const chapter = store.chapters.create(
            {
                story_id: story.id,
                plotline_ref: partner?.id,
                order,
                title: `Chapter ${order}`,
                summary: partner?.heading,
                // D-7: §4.4's `content` is derived from sections, so a chapter with no prose is an
                // empty section list rather than an empty string — the shape every read expects.
                sections: [],
                state: 'outlined',
                author_locked: false,
                round: 0
            },
            loopAttr(`chapter_count grew to ${count}; chapter ${order} enters the queue as outlined (D-3c)`)
        );

        created.push(chapter.id);

        if (partner !== undefined && partner.chapter_ref === undefined) {
            store.plotlines.update(
                partner.id,
                { chapter_ref: chapter.id },
                loopAttr(`bound plotline ${order} to its chapter (D-4)`),
                [{ id: partner.id, rev: partner.rev }]
            );
        }
    }

    return created;
}

/**
 * L-31/D-25: scrap everything the later phases produced.
 *
 * What goes: the prose and the structure, hard — chapters and their revisions when backing up to
 * `plotlines`; plotlines, chapters, digests and per-chapter verdicts when backing up to `summary`.
 *
 * The reopened phase's OWN artifact survives: backing up to `plotlines` unlocks the plotlines rather
 * than deleting them, exactly as backing up to `summary` keeps the Summary row and clears its lock.
 * Two reasons, one of them practical: the Author goes back to phase ② in order to edit the plotlines,
 * so deleting them throws away the thing they went back to change; and §8's catalogue gives no agent a
 * way to CREATE a plotline (the gap W2 reports), so a phase ② emptied of plotlines can never be
 * refilled — the Story would strand with nothing to judge and no tool to write.
 * What stays: the verdicts, findings and `selection_note`s of the scrapped work, as provenance
 * (P11 — the Author must still be able to ask why this draft was chosen).
 *
 * The Ideas go too (D-36, D-25's note): a phase that was locked already deleted its tray, and a phase
 * that was never locked loses it with the rest, because keeping them means a new Reader proposing what
 * the Author already rejected against artifacts that no longer exist.
 *
 * Ledger entries survive: they are the continuity FACTS of the book, and the book still exists — what
 * changed is that its structure is being rebuilt above them. The `stale` flag is where a fact a
 * backtrack retired goes, and the criteria engine excludes `stale` entries from C-5/C-6, so marking
 * rather than deleting is what keeps a scrapped pass from failing the new one.
 */
export function scrapPhasesAfter(
    store: Store,
    story: Story,
    phase: StoryPhase,
    why: string
): { chapters: number; plotlines: number; revisions: number; ideas: number; digests: number; verdicts: number } {
    const rank = phaseRank(phase);
    const counts = { chapters: 0, plotlines: 0, revisions: 0, ideas: 0, digests: 0, verdicts: 0 };

    for (const chapter of store.chapters.list()) {
        if (chapter.story_id !== story.id) continue;
        if (rank >= phaseRank('chapters')) continue;

        store.chapters.delete(chapter.id, loopAttr(why));
        counts.chapters += 1;
    }

    for (const revision of store.revisions.list()) {
        if (revision.story_id !== story.id) continue;
        // Drafts belong to the chapter they were written against; backing up to `chapters` keeps the
        // current phase's work (L-31 scraps only the LATER phases).
        if (rank >= phaseRank('chapters')) continue;

        store.revisions.delete(revision.id, loopAttr(why));
        counts.revisions += 1;
    }

    if (rank <= phaseRank('plotlines')) {
        for (const plotline of store.plotlines.list()) {
            if (plotline.story_id !== story.id) continue;

            // Reopening the phase that OWNS the plotlines unlocks them (L-7: `contract_locked` is what
            // makes a plotline propose-only for agents); only a phase above them is deleted.
            if (rank === phaseRank('plotlines')) {
                if (!plotline.contract_locked) continue;

                const fresh = store.plotlines.require(plotline.id);

                store.plotlines.update(
                    fresh.id,
                    { contract_locked: false },
                    loopAttr(`${why}; the plotline contract is editable again (L-7, D-31)`),
                    [{ id: fresh.id, rev: fresh.rev }]
                );

                continue;
            }

            store.plotlines.delete(plotline.id, loopAttr(why));
            counts.plotlines += 1;
        }

        for (const digest of store.digests.list()) {
            if (digest.story_id !== story.id) continue;

            store.digests.delete(digest.id, loopAttr(why));
            counts.digests += 1;
        }

        // Only the PER-CHAPTER verdicts go (L-31 names them): the Summary and plotline verdicts are the
        // surviving provenance of the phases that still exist. The chapter rows are already gone by
        // here, so `target_kind` is the discriminator — which is also what a hand-built store with no
        // chapter rows at all would need.
        for (const verdict of store.verdicts.list()) {
            if (verdict.story_id !== story.id) continue;
            if (verdict.target_kind !== 'chapter') continue;

            store.verdicts.delete(verdict.id, loopAttr(why));
            counts.verdicts += 1;
        }
    }

    // The tray of every phase at or after the reopened one. The reopened phase gets an EMPTY tray
    // (D-25's note), which is the price of a store that stays small.
    for (const idea of storyIdeas(store, story.id)) {
        if (phaseRank(idea.phase) < rank) continue;

        store.ideas.delete(idea.id, loopAttr(why));
        counts.ideas += 1;
    }

    return counts;
}

/** D-25a: editing the Seed is the full backtrack, and the confirmation is the UI's job (see `editSeed`). */
export const scrapEverythingButTheSeed = (store: Store, story: Story, why: string) =>
    scrapPhasesAfter(store, story, 'summary', why);

/**
 * L-7 / L-7a / L-7's mirror rule, in one commit: the Story's flag, the artifact's flag, every
 * `contract_locked` mirror, and the emptied tray (D-36).
 *
 * The phase advance is here too, because "one action on the Dashboard" (L-7) means the lock and the
 * phase movement cannot be observed separately — a Story whose plotlines are locked but whose phase is
 * still `plotlines` would re-offer the plotline sign-off on the next sweep.
 */
export function lockWrites(
    store: Store,
    story: Story,
    phase: StoryPhase,
    at: string
): { deleted_ideas: number; next_phase: StoryPhase | null } {
    let deleted = 0;

    if (phase === 'summary') {
        store.stories.update(
            story.id,
            { summary_locked: true },
            authorAttr(`the Author locked the Summary at ${at} (L-7a)`),
            [{ id: story.id, rev: story.rev }]
        );

        const summary = storySummary(store, story.id);

        if (summary !== undefined) {
            store.summaries.update(
                summary.id,
                { locked: true },
                authorAttr('the Summary lock mirrors the Story flag (L-7a)'),
                [{ id: summary.id, rev: summary.rev }]
            );
        }

        deleted = deletePhaseTray(store, story, 'summary');

        return { deleted_ideas: deleted, next_phase: 'plotlines' };
    }

    if (phase === 'plotlines') {
        const fresh = store.stories.require(story.id);

        store.stories.update(
            fresh.id,
            { plotlines_locked: true, phase: 'chapters' },
            authorAttr(`the Author locked the plotlines at ${at}; phase → chapters (L-7, L-29)`),
            [{ id: fresh.id, rev: fresh.rev }]
        );

        for (const plotline of storyPlotlines(store, story.id)) {
            store.plotlines.update(
                plotline.id,
                { contract_locked: true },
                authorAttr('a locked plotline is propose-only for agents (L-7, D-6)'),
                [{ id: plotline.id, rev: plotline.rev }]
            );
        }

        deleted = deletePhaseTray(store, story, 'plotlines');

        // L-8 + D-3c: locking the plotlines opens the chapter pass with every chapter in flight, so the
        // chapter rows have to exist for the sweep to dispatch against (C-1 needs them too). Written
        // only when missing, so an Author who let the Writer create them first is not double-created.
        const chapters = storyChapters(store, story.id);

        if (chapters.length === 0) {
            const count = storySummary(store, story.id)?.chapter_count ?? storyPlotlines(store, story.id).length;

            materialiseChapters(store, store.stories.require(story.id), count);
        }

        return { deleted_ideas: deleted, next_phase: 'chapters' };
    }

    // L-25a: `completed` IS phase ③'s lock, and there is no fourth phase.
    return { deleted_ideas: deletePhaseTray(store, story, 'chapters'), next_phase: null };
}

/**
 * D-36: the lock deletes the phase's Ideas — selected, discarded and deferred alike.
 *
 * U-2 (review fix 5): this used to be a second, slightly different copy of the same rule, and the
 * copy kept `state === 'selected'` rows alive. The rule has exactly one definition now —
 * `deletePhaseIdeas` in ./records — so a lock can never disagree with the read layer about what
 * "the tray" means (records.ts's docblock names why a `selected` row is not a survivor).
 */
function deletePhaseTray(store: Store, story: Story, phase: StoryPhase): number {
    return deletePhaseIdeas(store, story.id, phase);
}

/**
 * L-17a: push one undo snapshot.
 *
 * The snapshot is the WHOLE chapter rather than the section, because the section list is the unit a
 * rewrite replaces (D-7 makes a whole-chapter rewrite a separate operation from a section edit, and an
 * undo that only restored a paragraph would silently drop a rewrite's other changes).
 */
export function pushUndo(store: Store, chapter: Chapter, entry: UndoEntry): void {
    const loop = chapter as LoopChapter;
    const stack = [...(loop.undo_stack ?? []), entry].slice(-UNDO_STACK_LIMIT);

    store.chapters.update(
        chapter.id,
        { undo_stack: stack } as never,
        loopAttr(`undo snapshot before ${entry.verb} (L-17a)`),
        [{ id: chapter.id, rev: chapter.rev }]
    );
}

/**
 * D-37a: the Author's edit lands as a direct write (D-20a) and the span becomes Author-written, so from
 * that point the crew may only `proposeChange` against it (P9, D-20).
 *
 * The loop does NOT treat the edit as a defect (D-37b): nothing here opens a finding, and nothing here
 * schedules a Writer to restore what the Author replaced. The propagation the caller performs is the
 * ordinary L-11a kind — dependents get `needs_recheck` because the book now reads differently — and the
 * next review simply judges the book as it now reads.
 */
export function applySectionEdit(
    store: Store,
    chapterIn: Chapter,
    sectionId: string,
    text: string
): { sections: ChapterSection[]; created: boolean } {
    // The caller may be holding the row from EARLIER in the same commit: `pushUndo` writes the chapter
    // first when it snapshots the pre-edit state (L-17a), and T-4's compare-and-swap is exact about a
    // rev that moved underneath — re-read so the assertion names the rev this commit is standing on.
    const chapter = store.chapters.get(chapterIn.id) ?? chapterIn;
    const sections = chapter.sections.map((section) =>
        section.id === sectionId ? { ...section, text, origin: 'author' as const } : section
    );
    const created = !chapter.sections.some((section) => section.id === sectionId);

    if (created) sections.push({ id: sectionId, text, origin: 'author' });

    store.chapters.update(
        chapter.id,
        { sections },
        authorAttr(`the Author rewrote ${sectionId} while paused (D-37, D-37a)`),
        [{ id: chapter.id, rev: chapter.rev }]
    );

    return { sections, created };
}

/** L-17a: the payload `undoLast` re-commits, and the entry it consumed. */
export function popUndo(store: Store, chapter: Chapter): UndoEntry | undefined {
    const loop = loopChapter(store, chapter.id);
    const stack = loop?.undo_stack ?? [];

    if (stack.length === 0) return undefined;

    const entry = stack[stack.length - 1];

    store.chapters.update(
        chapter.id,
        // The snapshot IS the chapter as it was: sections, state, and the bar. Restoring the section
        // list alone would undo the prose but not the span origins the edit changed (D-37a).
        { ...(entry.snapshot as Chapter), undo_stack: stack.slice(0, -1) } as never,
        authorAttr(`undo of ${entry.verb} on ${entry.section_id} (L-17a)`),
        [{ id: chapter.id, rev: chapter.rev }]
    );

    return entry;
}

/** L-10: the chapter is done — the Goal passed and the Author's standing acceptance covers the rest. */
export function markChapterDone(store: Store, chapter: Chapter, why: string): void {
    if (chapter.state === 'done') return;

    store.chapters.update(chapter.id, { state: 'done' }, loopAttr(why), [{ id: chapter.id, rev: chapter.rev }]);
}

/** L-12: a chapter re-entered by propagation is re-entered automatically, so the sweep needs no nudge. */
export const needsRecheckChapters = (store: Store, storyId: string): Chapter[] =>
    storyChapters(store, storyId).filter((chapter) => chapter.state === 'needs_recheck');
