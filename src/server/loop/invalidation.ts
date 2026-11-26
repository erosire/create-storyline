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
// is a backtrack (L-31). So nothing here unlocks an artifact it KEEPS, and `scrapPhasesAfter` is the only
// path that deletes a locked phase's artifacts — with the one exception D-69 forces (T8 finding 1): a
// PHRASE GROUP lock whose revision rows this scrap deletes comes off with them, because a flag naming a
// deleted row is not a lock, it is a deadlock. See the block inside `scrapPhasesAfter`.
//
// T-W6 (D-77) extends the same line to Phrase ② rather than bending it: the phase-② artifact is a phrase
// row on the grouped model, so `scrapPhasesAfter` DELETES that row (and its entries, history and brief)
// when it reaches above phase ②, and KEEPS it when it lands on phase ② — exactly what the same function
// does to a §4.3 plotline row. See `scrapPlotlinesPhrase`.
import {
    authorAttr,
    deletePhaseIdeas,
    loopAttr,
    storyChapters,
    storyFindings,
    storyIdeas,
    storyPlotlines,
    storySummary,
    wontfixTasks,
    loopChapter
} from './records';
import { TASK_KINDS, UNDO_STACK_LIMIT, type LoopChapter, type PhaseLockReceipt, type UndoEntry } from './types';
// HARDENING (D-25/D-25a group reset): `scrapPhasesAfter` has to scrap the group pipeline's history
// alongside the legacy `revisions` rows — see the block in the function — and the switch is the book
// itself (`phrase/catalog.ts:isGroupManagedStory`). `phraseGroupsOf` + `isPhraseGroupLocked` are the two
// reads the D-69 lock clear needs, and they come from the SAME catalog module the write layer reads, so
// a scrap can never disagree with `phrase/locks.ts` about which row carries a live lock.
// T12/R3 adds `voidFindingsOnLock` to that list: the Summary accept voids its open findings through the
// SAME void path a group lock uses, rather than writing `discarded` a second time in a second file.
import {
    isGroupManagedStory,
    isPhraseGroupLocked,
    isPhraseGroupManaged,
    phraseGroupsOf,
    storyPhraseByKey,
    // T12/R3: the finding's OWN scope read, so the accept asks the same question the rail asks, and the
    // void path itself.
    findingGroupScope,
    voidFindingsOnLock
} from '../phrase';
// PHRASE ② (T-W2): the phrase KEY the scrap gate above names (see `shared/phrase.ts`). T12 adds the
// SUMMARY key: the accept's leftover sweep is scoped to the phrase it is completing.
import { PHRASE_PLOTLINES_KEY, PHRASE_SUMMARY_KEY } from '../../shared/phrase';
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
 * T-W6 (D-77, R11) — THE PLOTLINES PHRASE GOES WITH THE PHASE THAT OWNS IT, WHOLE.
 *
 * This is the phrase-side half of what the plotline loop two blocks below already does to §4.3: when the
 * scrap reaches ABOVE phase ②, phase ②'s artifact is deleted rather than reopened. Phrase ②'s artifact is
 * a `phrases` row plus everything keyed to it — `phrase_groups` (the chapter entries), its
 * `group_revisions` (the entries' history) and `plotline_briefs` (the structure pass that declared the
 * entry set) — so "delete the phase" means all four, in one commit, or the book keeps a phrase whose
 * entries, history and brief belong to a scrapped round.
 *
 * WHY THE WHOLE ROW AND NOT A RESET, which is what the SUMMARY phrase gets in `engine.ts:editSeed`:
 * D-25a's "a Seed edit is a full clear" stays authoritative, and the reason is the Start verb. A phrase
 * row is the identity its entries, revisions and claim keys name, and `startPlotlinesPhrase` REFUSES a
 * second start on the same book (409 — D-72's copied seed is the input that history was written
 * against). So a reset that left the row standing would leave an Author holding a book whose phase ② has
 * been emptied with no way to re-seed it: the loop cannot start it (only the Author can, D-72), and the
 * Author cannot start it either (the row is already there). Deleting the row is the one state where the
 * rail's Start card works again, which is the difference between a cleared book and a dead one.
 *
 * THE COPIED-SEED INDEPENDENCE IS NOT WEAKENED (D-72, the user's "phrases are discrete and independent"):
 * that property is about Phrase ② never READING Phrase ① live — it reads `phrases.seed`, not
 * `stories.idea` — and deleting the row when the Story-Seed changes says nothing about what a surviving
 * row reads. The copied-seed rule and the scrap rule are orthogonal, and both are pinned:
 * `api/phrase-start-routes.test.ts` pins the immunity of a SURVIVING row, and the D-77 pins below name
 * the four collections this one deletes.
 *
 * IT IS NOT GATED ON EITHER DIAL. `plotlines_mode` says who WRITES the contracts, not whether the rows
 * exist; a started row with the dial off (a seeded book, or one whose dial was moved before the 409 rule
 * landed) still owns entries that name a scrapped round, and leaving them is exactly the mixed-dial
 * inconsistency this wave closed: entries at `revision: 3` over a `group_revisions` table with no rows.
 * The predicate is the ROW (`phrase/catalog.ts:storyPhraseByKey`), and an unstarted book is a no-op.
 *
 * WHAT SURVIVES: `summaries.chapter_count` (D-3b's Author truth — neither a scrap nor a Seed edit
 * touches it), the `plotlines` contract rows (this function's caller deletes them at the same rank), the
 * findings/tasks/verdicts of the scrapped pass (P11's provenance), and the `summary_scores` rows (they
 * are keyed by a vector hash, and the scrap has never deleted a score).
 */
function scrapPlotlinesPhrase(store: Store, story: Story, why: string): boolean {
    const phrase = storyPhraseByKey(store, story.id, PHRASE_PLOTLINES_KEY);

    if (phrase === undefined) return false;

    // Briefs first, then the entries they declared, then the history of those entries, then the row that
    // owns them: every one of these deletes is scoped by `phrase_id` (never `story_id`) so a book with a
    // second phrase of the same kind — or a Summary whose groups are being RESET rather than deleted two
    // blocks below — keeps the rows this scrap is not about.
    store.plotlineBriefs.deleteWhere((row) => row.phrase_id === phrase.id, loopAttr(`${why}; the structure pass that declared this phrase's chapters goes with the phrase (D-77)`));
    store.phraseGroups.deleteWhere((row) => row.phrase_id === phrase.id, loopAttr(`${why}; the chapter entries go with the phrase that materialised them (D-77)`));
    store.groupRevisions.deleteWhere((row) => row.phrase_id === phrase.id, loopAttr(`${why}; the entries' history goes with the entries (D-25, D-77)`));
    store.phrases.delete(phrase.id, loopAttr(`${why}; the Plotlines Phrase row goes with the phase it is (L-31, D-77)`));

    return true;
}

/**
 * L-31/D-25: scrap everything the later phases produced.
 *
 * What goes: the prose and the structure, hard — chapters and their revisions when backing up to
 * `plotlines`; plotlines, chapters, digests and per-chapter verdicts when backing up to `summary`.
 * Every deleted revision's `sample_reviews` rows go in the same commit (T12/B): a screening review is
 * a review OF one sample, so a review whose `revision_ref` no longer resolves is an orphan, not
 * provenance.
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
 * PHRASE ② TRAVELS WITH ITS PHASE (T-W6, D-77): a scrap that reaches ABOVE phase ② deletes the Plotlines
 * Phrase — row, chapter entries, entry history and brief — in this same commit, and a scrap that lands ON
 * phase ② keeps them (only a lock whose revision rows this function deleted comes off, D-69).
 * `scrapPlotlinesPhrase` states why that delete is a delete rather than the Summary's reset.
 *
 * The Ideas go too (D-36, D-25's note): a phase that was locked already deleted its tray, and a phase
 * that was never locked loses it with the rest, because keeping them means a new Critic proposing what
 * the Author already rejected against artifacts that no longer exist.
 *
 * ONE LOCK IS DELETED WITH ITS ARTIFACT (D-69, T8 finding 1): a PHRASE GROUP lock is a flag on a
 * REVISION (`locked_revision` names a `group_revisions` row, and `phrase/reviewed.ts:cleanSelectionOf`
 * resolves a locked group's Overview entry through its `latest` row), so the scrap that deletes those
 * rows deletes the lock's subject and clears the flag with them. The reopened phase's group TEXT and
 * numbers survive; only the dead flag goes. Every other lock this module respects survives, because a
 * phase whose artifact survives keeps the artifact's lock (L-11's line).
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
): {
    chapters: number;
    plotlines: number;
    revisions: number;
    groupRevisions: number;
    ideas: number;
    digests: number;
    verdicts: number;
} {
    const rank = phaseRank(phase);
    const counts = { chapters: 0, plotlines: 0, revisions: 0, groupRevisions: 0, ideas: 0, digests: 0, verdicts: 0 };

    for (const chapter of store.chapters.list()) {
        if (chapter.story_id !== story.id) continue;
        if (rank >= phaseRank('chapters')) continue;

        store.chapters.delete(chapter.id, loopAttr(why));
        counts.chapters += 1;
    }

    // The revisions this backtrack actually deletes, so the screening reviews below can be scoped to
    // exactly them — a review of a SURVIVING revision is evidence, not debris (T12/B).
    const scrappedRevisions = new Set<string>();

    for (const revision of store.revisions.list()) {
        if (revision.story_id !== story.id) continue;
        // Drafts belong to the chapter they were written against; backing up to `chapters` keeps the
        // current phase's work (L-31 scraps only the LATER phases).
        if (rank >= phaseRank('chapters')) continue;

        store.revisions.delete(revision.id, loopAttr(why));
        scrappedRevisions.add(revision.id);
        counts.revisions += 1;
    }

    // SUMMARY PHRASE (hardening, D-25/D-25a): `group_revisions` is the group pipeline's history —
    // the same kind of row the loop deletes one block above, produced by the same reopened phase.
    // Left behind, the scrapped pass kept steering the book three ways at once: the write allowance
    // counts "runs after THIS text" from the `latest` row (`phrase/exclusion.ts:writeBaselineOf`),
    // the review seats are keyed by the vector those numbers hash to, and R3's closure joins on
    // claims stamped onto exactly these rows — so an open finding could read "already answered" by
    // a revision of prose the Author just scrapped, and a fresh draft would land at number N+1 of a
    // round nobody remembers. The GROUP ROWS survive, ids stable (R1's addresses outlive the text):
    // they are the reopened phase's own artifact, the same L-31 reason the `summaries` row and the
    // plotlines survive a backtrack. Whether the current text itself is re-grown is the CALLER's
    // decision, exactly as the legacy prose is cleared by `engine.ts:editSeed` and kept by
    // `backtrack('summary')` — those flows reset the group rows with the mirror, never this scrap.
    //
    // THE LOCK THAT STANDS ON THOSE ROWS GOES WITH THEM (D-69, T8 finding 1), and this branch — not the
    // group row loop above or below — is the only place it may. A group lock is not a flag on the GROUP,
    // it is a flag on a REVISION: `phrase/locks.ts` writes `locked_revision`, and
    // `phrase/reviewed.ts:cleanSelectionOf` resolves a locked group's Overview entry by finding its
    // `latest` row at `group.revision`. Deleting the history deletes the lock's subject, and the stale
    // flag then strands the book in BOTH directions:
    //   * the reviewed Overview can never COMPOSE again, because the locked group has a permanent gap
    //     (`cleanSelectionOf` answers `no_clean_revision` for a group with no `latest` row), and the
    //     Reader score seats, the Editor lock seats and the Author's reviewed choose are all keyed to a
    //     COMPLETE selection; and
    //   * `phrase/revisions.ts:installGroupRevisions` refuses a batch naming ANY locked group BEFORE its
    //     first write (R2's atomicity), so the stale flag blocks the re-install of the other four groups
    //     too — the loop cannot rebuild the Overview at all, and the only way out is an Author unlock the
    //     rail has no reason to offer, on a lock the Author never set.
    // Clearing is `phrase/locks.ts:unlockPhraseGroup`'s exact write: the four fields to `false`/`null`
    // (`null`, never `undefined` — a store patch merges through JSON, so an `undefined` would DELETE the
    // key instead of clearing it), with `content` and `revision` untouched so the text survives
    // byte-for-byte as L-31 requires. NOTHING ELSE moves: the claims the lock voided stay `discarded`
    // (§4.10 makes a discard terminal, and a scrap that resurrected one would invent work the Author
    // watched close), and only rows that actually carry a lock are written, because an UNLOCKED row
    // leaves these four fields OUT entirely and that absence is the shape every projection reads as
    // "open" (`api/projections.ts`, `dashboard/api.ts:PhraseGroupRow`).
    //
    // THE BRANCH IS THE RULE, not a matter of placement: a backtrack to `chapters` (`rank >=
    // phaseRank('chapters')`) deletes nothing group-shaped, so every lock there still names a live
    // `latest` row and STANDS — cleared locks would be the bug there, not the fix.
    // T-W2 (PHRASE ②): the gate is EITHER phrase's dial, not the Summary's alone. A Story with
    // `summary_mode:'classic'` and `plotlines_mode:'groups'` has `group_revisions` rows — the chapter
    // lane's history — and leaving them behind on a scrap would keep the D-25 defect alive one phrase
    // down: the write allowance counts runs after THIS text, the review seats key on the vector those
    // numbers hash to, and R3's closure joins on claims stamped onto exactly these rows. The lock-clear
    // loop below reads `phraseGroupsOf` UNSCOPED on purpose: a scrap deletes this Story's whole
    // `group_revisions` table slice, so a lock on EITHER phrase's row would be left naming a row that
    // is gone (D-69), and clearing one phrase's flag while the other's history was deleted is the
    // half-applied state that strands a book in both directions.
    if (
        rank < phaseRank('chapters') &&
        (isGroupManagedStory(story) || isPhraseGroupManaged(story, PHRASE_PLOTLINES_KEY))
    ) {
        counts.groupRevisions = store.groupRevisions.deleteWhere(
            (revision) => revision.story_id === story.id,
            loopAttr(`${why}; the group revisions of the scrapped phase go with their drafts (D-25, R2)`)
        );

        for (const group of phraseGroupsOf(store, story.id).filter(isPhraseGroupLocked)) {
            store.phraseGroups.update(
                group.id,
                { locked: false, locked_revision: null, locked_by: null, locked_at: null },
                loopAttr(
                    `${why}; ${group.key}'s lock named a revision row this scrap deleted, so the flag goes with the history while the words stay (D-69, R2)`
                ),
                // CAS against the row as the catalog read it, exactly like `locks.ts`'s two writes: a
                // install that moved the group inside this same commit loses this update rather than
                // having its flag cleared behind it.
                [{ id: group.id, rev: group.rev }]
            );
        }
    }

    // T12/B: a `sample_reviews` row is a review OF one revision (`revision_ref`), so it is scoped to
    // that revision's life. Deleting the revisions and keeping their reviews orphaned the rows — a
    // `revision_ref` naming a row the store no longer holds, which the Story view then renders as a
    // screening of nothing. Only reviews pointing at a DELETED revision go; the surviving revision's
    // reviews stay (the selection commit already truncated the losers' rows, and a review of the kept
    // draft is the provenance §6.6 keeps). The same commit, so the two halves are never observable
    // apart (P1).
    if (scrappedRevisions.size > 0) {
        store.sampleReviews.deleteWhere(
            (review) => review.story_id === story.id && scrappedRevisions.has(review.revision_ref),
            loopAttr(`${why}; the screening reviews of the deleted revisions go with them (§3.4, T12/B)`)
        );
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

    // PHRASE ② (T-W6, D-77) — the SAME line, drawn one layer up. The block above deletes §4.3's contract
    // rows when the scrap reaches ABOVE phase ② and UNLOCKS them when it lands ON phase ②; Phrase ②'s
    // rows are the same artifact on the other authoring model, so the phrase follows the phase with the
    // identical fork: `rank < phaseRank('plotlines')` (a `backtrack('summary')`, and `editSeed`, which
    // calls this function at `'summary'`) deletes the phrase whole — row, entries, history and brief —
    // while `rank === phaseRank('plotlines')` KEEPS it, because the reopened phase's own artifact is what
    // the Author went back to work on (L-31) and its entries are the text they are about to revise. The
    // only thing the reopened case does to the phrase is the lock clear above, and it runs there because
    // this rank DOES delete the `group_revisions` rows (`rank < phaseRank('chapters')`): the entries keep
    // their TEXT and their numbers — the base for another round, L-31 — and every flag that named a
    // deleted revision comes off with it (D-69). The briefs survive untouched: the structure pass is the
    // phrase's own record of how the seed resolves into chapters, and phase ② is reopening to act on it.
    if (rank < phaseRank('plotlines')) {
        scrapPlotlinesPhrase(store, story, why);
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
 * THE SUMMARY LEG ALSO ACCEPTS (T12/R3): locking phase ① is the Author declaring the Summary final, so the
 * phrase's outstanding work stops in the SAME commit — open findings are voided and open tasks go to
 * `wontfix`. See {@link acceptSummaryLeftovers} for why each is a state change and why the sweep is
 * phrase-scoped. The `plotlines` and `chapters` legs are untouched by this: a sign-off there closes a
 * contract, it does not complete an artifact the Author has just signed.
 *
 * The phase advance is here too, because "one action on the Dashboard" (L-7) means the lock and the
 * phase movement cannot be observed separately — a Story whose plotlines are locked but whose phase is
 * still `plotlines` would re-offer the plotline sign-off on the next sweep.
 */
export function lockWrites(store: Store, story: Story, phase: StoryPhase, at: string): PhaseLockReceipt {
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

        // T12/R3, AFTER the tray and before the phase move, in this same commit: the accept's leftovers are
        // part of the decision, not a follow-up the store can be observed without.
        const leftovers = acceptSummaryLeftovers(store, story, at);

        return {
            deleted_ideas: deleted,
            next_phase: 'plotlines',
            voided_findings: leftovers.voided_findings,
            wontfixed_tasks: leftovers.wontfixed_tasks
        };
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
 * T12 / R3 — "accept the final Summary" stops the Summary phrase's outstanding work, in the caller's
 * commit, and reports the counts (L-25b's shape for an accept with leftovers: "whatever is still open at
 * that moment — findings, `proposed` Ideas — is discarded by the act of completing, and the count is
 * recorded and shown").
 *
 * WHY A STATE CHANGE AND NEVER A ROW DELETE: D-36 empties the Ideas TRAY by DELETING rows, and
 * `documents/specifications.md` pins the difference on the same act — a lock's findings survive as
 * provenance (P11). A voided finding is the Author declining a claim about text that is now signed off,
 * which is exactly `discarded` in §4.10's ladder (D-33c reads `fixed`/`discarded` as CLOSED), and a task
 * the accept will not run is `wontfix` in §4.7's ladder. Delete either and the Author loses the record of
 * what the crew said about the book; move the state and the queue empties with the audit intact.
 *
 * WHY PHRASE-SCOPED AND NOT STORY-WIDE (R3): the artifact being completed is the SUMMARY, so the accept
 * swallows the Summary's claims. A finding that names ONLY Phrase ②'s chapter entries is still live work
 * for the phrase this same accept is about to start, and one that names groups in BOTH phrases keeps its
 * Phrase ② half for the same reason. An UNSCOPED finding (`Finding.group_refs` absent or naming no group
 * this book has) is the legacy whole-Overview meaning — `phrase/findings.ts:findingGroupScope` is the one
 * reader of that absence — which is the Summary's own claim, so it goes.
 *
 * THE STATE FILTER IS NOT HERE: `phrase/locks.ts:voidFindingsOnLock` owns it, so `fixed` and `discarded`
 * rows are untouched by construction and `disputed` moves because D-33c counts a dispute as a live claim.
 * That is the SAME void the group lock performs, one layer up — which is the point of calling it.
 *
 * THE TASKS: §4.7's rows carry no phase and no phrase, so "the Summary phrase's open tasks" is every task
 * still in the queue at the moment of the accept — which at a phase-① sign-off IS Summary work, because
 * phase-② work is only opened by this commit's phase move. They go to `wontfix` through
 * `records.ts:wontfixTasks` (the L-36 path), not a delete: §4.7's word for a job that will not be done,
 * and the queue's history stays readable.
 */
function acceptSummaryLeftovers(
    store: Store,
    story: Story,
    at: string
): { voided_findings: number; wontfixed_tasks: number } {
    // THE PHRASE BEING COMPLETED. A book with no Summary Phrase row has no group namespace, so the only
    // findings it can hold are the unscoped legacy ones — which are still the Summary's, and still go.
    const phrase = storyPhraseByKey(store, story.id, PHRASE_SUMMARY_KEY);
    const summaryGroupIds = new Set(
        phrase === undefined ? [] : phraseGroupsOf(store, story.id, phrase.id).map((group) => group.id)
    );

    const candidates = storyFindings(store, story.id).filter((finding) => {
        // THE SCOPE IS THE DOMAIN'S OWN READ (`phrase/findings.ts:findingGroupScope`), not the raw
        // `group_refs`: that function is the one place that interprets an absent-or-unknown ref list as
        // "the whole Overview" (R3), and re-deciding it here would give the accept a second, slightly
        // different meaning of "whose claim is this".
        const scope = findingGroupScope(store, story, finding);

        // Unscoped: the legacy "the Overview as a whole" claim, which is the artifact being accepted.
        if (scope.unscoped) return true;

        // Every group it names belongs to Phrase ①: the claim is about the text that just stopped being
        // writable. (Mixed refs stay open on purpose — the Phrase ② half is still writable, and voiding a
        // live claim the accept did not freeze is the mistake R3's scope rule exists to prevent.)
        return scope.refs.every((id) => summaryGroupIds.has(id));
    });

    // ONE attribution for both sweeps: the accept is one decision, and every row it moves carries the same
    // sentence (the void path appends its own per-finding clause to it).
    const attribution = authorAttr(`the Author accepted the Summary at ${at} (L-7a, T12)`);

    const voided = voidFindingsOnLock(store, story, candidates, attribution, (finding, scope) =>
        scope.unscoped
            ? `${attribution.why}; discarded ${finding.id} because it named no group and the Overview it was raised against is now signed off (summary accept)`
            : `${attribution.why}; discarded ${finding.id} because every group it names (${scope.refs
                  .map((id) => store.phraseGroups.get(id)?.key ?? id)
                  .join(', ')}) is settled text the accept will not rewrite (summary accept)`
    );

    const wontfixed = wontfixTasks(
        store,
        story.id,
        authorAttr(
            `the Author accepted the Summary at ${at}; its open tasks are wontfix because the phrase is complete (T12, R3)`
        )
    );

    return { voided_findings: voided.length, wontfixed_tasks: wontfixed.length };
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
