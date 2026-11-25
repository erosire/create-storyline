/**
 * T-W6 (D-77, R11) — THE BLAST RADIUS OF A SEED EDIT AND OF A PHASE SCRAP, MEASURED ON PLOTLINES PHRASE ②.
 *
 * WHAT THIS FILE PINS, and why it was not pinned before:
 *
 *   1. `editSeed` (D-25a's "a Seed edit is a FULL clear") deletes the Plotlines Phrase WHOLE — its
 *      `phrases` row, its `chapter_<n>` entries, their `group_revisions` history and its
 *      `plotline_briefs` — instead of resetting them the way the Summary's rows are reset. The reason is
 *      not taste, it is the Start verb: `startPlotlinesPhrase` REFUSES a second start while the row
 *      exists (D-72, and the loop may not start it either), so a cleared phrase with a surviving row is
 *      a book whose phase ② can never be re-seeded. The Summary's rows have no such rule — the catalog is
 *      re-minted with the Story and re-grown by the next sweep — so the Summary keeps its RESET (same
 *      ids, `''`/`0`, D-63) and Phrase ② gets a DELETE.
 *   2. The same removal runs on `backtrack('summary')`, which reaches above phase ② exactly as a Seed
 *      edit does — `scrapPhasesAfter(…, 'summary')` is one function with two callers.
 *   3. `backtrack('plotlines')` lands ON phase ② and KEEPS the phrase: the entries are the text the
 *      reopened phase is about to revise (L-31), the brief survives, and only a group lock whose
 *      `locked_revision` this scrap deleted comes off (D-69) — the entry's TEXT and number stay.
 *   4. THE MIXED-DIAL BOOK IS THE CASE THE OLD CODE GOT WRONG. With `summary_mode:'sampling'` and
 *      `plotlines_mode:'groups'`, the group-revisions wipe was gated on EITHER dial while the group RESET
 *      was gated on the Summary's, so a Seed edit emptied the history table and left every chapter entry
 *      at `revision: N` over it — an entry claiming a revision line the store cannot show. The phrase
 *      deletion is gated on NEITHER dial (a started row is the predicate), so that state is unreachable.
 *   5. An UNSTARTED Phrase ② — the classic book, and every book whose Author never pushed the compiled
 *      Summary into the phrase — is untouched by all of this: the predicate is the phrase ROW, and its
 *      absence is a no-op, not a migration (R6's rule one phrase down).
 *
 * Values were read off the rig (the installs, the lock stamp, the surviving ids), not guessed.
 */
import { describe, expect, it } from 'vitest';

import { createRig, type Rig } from './mock';
// Phrase ②'s three domain operations, through the phrase barrel the loop and the routes use, plus the
// chapter entry's content renderer (an install of a CHAPTER entry has to carry its plotpoints — P4) and
// the lock write whose four fields the scrap is allowed to clear.
import { acceptPlotlineBrief, createPlotlineBrief, startPlotlinesPhrase } from '../phrase';
import { chapterEntryContent, type PlotpointFields } from '../phrase/plotpoints';
import { installGroupRevisions } from '../phrase/revisions';
import { lockPhraseGroup } from '../phrase/locks';
import { AUTHOR_ATTR } from '../run/mock';
import type { Phrase, PhraseGroup, PlotlineBrief } from '../../shared/types';

/** The text the Author hands Phrase ② — the compiled Overview in the real flow, copied into the row (D-72). */
const PLOTLINES_SEED = 'Premise: a cartographer returns. Promise: the map reconciles. Ending: she floods the valley.';

/** A book with the Summary written group by group, and NO Phrase ② yet (`createRig`'s clock, no sweeps). */
async function groupBook(summaryMode: 'groups' | 'sampling' = 'groups'): Promise<Rig> {
    return createRig({
        summaryMode,
        summarySampling: 5,
        summaryCritics: 1,
        crew: { researchQuestions: [] }
    });
}

/**
 * Starts Phrase ②, lets the structure pass declare the count, and materializes the entries — the state
 * between "the Author started it" and "a Writer wrote it", which is already enough for the scrap to act on.
 */
function startedPhrase(rig: Rig, chapterCount = 2) {
    const started = startPlotlinesPhrase(rig.store, rig.story(), PLOTLINES_SEED, AUTHOR_ATTR);
    const brief = createPlotlineBrief(
        rig.store,
        rig.story(),
        started.phrase,
        { chapter_count: chapterCount },
        AUTHOR_ATTR
    );
    const accepted = acceptPlotlineBrief(rig.store, rig.story(), brief, AUTHOR_ATTR);

    return { phrase: started.phrase, brief: accepted.brief, groups: accepted.groups };
}

/** One chapter entry's contract, in the shape `parseChapterDraftAnswer` would have produced. */
function plotpointsFor(order: number): PlotpointFields {
    return {
        heading: `Chapter ${order}`,
        must_happen: `the chart is proved wrong in chapter ${order}`,
        must_change: `she stops trusting the chart by the end of chapter ${order}`,
        pov: 'Maren',
        setups: `the 1911 survey (${order})`,
        payoffs: `the steeple bell (${order})`
    };
}

/**
 * One install over the given entries: a `group_revisions` row per entry, the entry numbers at 1, and the
 * mirrored §4.3 contract rows. This is the history the scrap is about to delete — and the row a lock names.
 */
function installEntries(rig: Rig, groups: PhraseGroup[], runRef: string) {
    return installGroupRevisions(
        rig.store,
        rig.story(),
        groups.map((group, index) => {
            const plotpoints = plotpointsFor(index + 1);

            return { group, content: chapterEntryContent(group, plotpoints), plotpoints };
        }),
        AUTHOR_ATTR,
        { runRef, workItemRef: `wi_draft_entries_${runRef}` }
    );
}

/** The lock as the ROW carries it, with the two fields a lock is a fact ABOUT (absent reads as `null`). */
const lockFieldsOf = (rig: Rig, groupId: string) => {
    const row = rig.store.phraseGroups.require(groupId);

    return {
        key: row.key,
        content: row.content,
        revision: row.revision,
        locked: row.locked ?? null,
        locked_revision: row.locked_revision ?? null,
        locked_by: row.locked_by ?? null,
        locked_at: row.locked_at ?? null
    };
};

/** Everything Phrase ② owns, as one readable snapshot for the "gone" and "survives" assertions. */
const phraseStateOf = (rig: Rig, phrase: Phrase) => ({
    phrase: rig.store.phrases.get(phrase.id) === undefined ? 'gone' : 'kept',
    groups: rig.store.phraseGroups.list().filter((row) => row.phrase_id === phrase.id).map((row) => row.key),
    revisions: rig.store.groupRevisions.list().filter((row) => row.phrase_id === phrase.id).length,
    briefs: rig.store.plotlineBriefs.list().filter((row) => row.phrase_id === phrase.id).length
});

describe('a Seed edit and a backtrack to phase ① delete the Plotlines Phrase whole (D-25a, D-77)', () => {
    it('drops the phrase row, its chapter entries, their history and its brief, and keeps the Summary phrase reset in place', async () => {
        const rig = await groupBook('groups');

        // The Summary's own round: five groups written and installed, so the book has TWO phrases with
        // history — and the delete rule is the one that tells them apart.
        const summaryGroups = rig.store.phraseGroups.list();
        const summaryPhrase = rig.store.phrases.require(summaryGroups[0]!.phrase_id);

        installGroupRevisions(
            rig.store,
            rig.story(),
            summaryGroups.map((group) => ({ group, content: `${group.key}: the first text.` })),
            AUTHOR_ATTR,
            { runRef: 'run_summary_1', workItemRef: 'wi_draft_groups_1' }
        );

        const phrase = startedPhrase(rig, 2);

        installEntries(rig, phrase.groups, 'run_plotlines_1');

        // Story B gets its own Phrase ②, so "gone" can only mean gone for THIS book (P1's scoping).
        const other = await rig.engine.createStory({
            title: 'The Signalman',
            idea: 'A signalman answers a letter written after his death.',
            chapter_count: 1,
            summary_mode: 'groups'
        });
        const otherStory = rig.store.stories.require(other.story_id);
        const otherPhrase = startPlotlinesPhrase(rig.store, otherStory, PLOTLINES_SEED, AUTHOR_ATTR).phrase;

        // B's brief is ACCEPTED, not merely drafted: acceptance is what materializes the chapter entries
        // (`plotpoints.ts:createPlotlineEntriesForPhrase`), so B really does own a group row for the
        // delete to leave alone. A draft-only brief would make the isolation pin below vacuous.
        const otherBrief = createPlotlineBrief(rig.store, otherStory, otherPhrase, { chapter_count: 1 }, AUTHOR_ATTR);

        acceptPlotlineBrief(rig.store, otherStory, otherBrief, AUTHOR_ATTR);

        const summaryIdsBefore = summaryGroups.map((group) => group.id);
        const plotlineRows = rig.store.plotlines.list().filter((row) => row.story_id === rig.storyId);

        // The pre-state, pinned so a vacuous "gone" is impossible: two phrases on the book, one accepted
        // brief, two chapter entries with one revision each, and two mirrored §4.3 contracts.
        expect(
            rig.store.phrases.list().filter((row) => row.story_id === rig.storyId).map((row) => row.key).sort()
        ).toEqual(['plotlines', 'summary']);
        expect(plotlineRows.map((row) => row.order)).toEqual([1, 2]);
        expect(phraseStateOf(rig, phrase.phrase)).toEqual({
            phrase: 'kept',
            groups: ['chapter_1', 'chapter_2'],
            revisions: 2,
            briefs: 1
        });

        await rig.engine.editSeed(rig.storyId, 'A lighthouse keeper trades places with the sea.', {
            confirm: true
        });

        // ① Phrase ② is GONE, whole: the row, the entries, the entries' history, and the structure pass
        // that declared the count. Nothing keys onto the deleted phrase any more.
        expect(phraseStateOf(rig, phrase.phrase)).toEqual({
            phrase: 'gone',
            groups: [],
            revisions: 0,
            briefs: 0
        });

        // ② The Summary phrase is NOT deleted: same row, same five group ids, `''`/`0` — the reset D-63
        // pins, which is what lets the next sweep re-grow the Overview from the new Seed.
        const summaryAfter = rig.store.phrases.require(summaryPhrase.id);

        expect({ id: summaryAfter.id, content: summaryAfter.content, revision: summaryAfter.revision }).toEqual({
            id: summaryPhrase.id,
            content: '',
            revision: 0
        });
        expect(rig.store.phraseGroups.list().map((group) => group.id)).toEqual(
            expect.arrayContaining(summaryIdsBefore)
        );
        expect(rig.store.phraseGroups.list().filter((group) => group.phrase_id === summaryPhrase.id).map((group) => `${group.key}:${JSON.stringify(group.content)}:${group.revision}`)).toEqual([
            'premise:"":0',
            'promise:"":0',
            'theme:"":0',
            'tone:"":0',
            'ending:"":0'
        ]);

        // ③ The classic contracts the install mirrored are gone with the scrapped phase, and Story B's
        // phrase — row and brief — is untouched by any of it.
        expect(rig.store.plotlines.list().filter((row) => row.story_id === rig.storyId)).toEqual([]);
        expect(rig.store.phrases.get(otherPhrase.id)?.key).toBe('plotlines');
        expect(rig.store.plotlineBriefs.list().filter((row) => row.phrase_id === otherPhrase.id)).toHaveLength(1);
        expect(rig.store.phraseGroups.list().filter((group) => group.phrase_id === otherPhrase.id)).toHaveLength(1);
    });

    it('leaves a mixed-dial book no entry claiming a history the store deleted (D-77, the old asymmetry)', async () => {
        // The dial pair the old code fell between: the Summary runs legacy sampling, so there is NO
        // Summary phrase at all (the catalog is only minted for a grouped Summary, engine.ts:2911), while
        // the chapter entries are the writing surface. The group-revisions wipe ran (EITHER dial), the
        // group RESET did not (SUMMARY dial), and the entries were left at `revision: 1` over an empty
        // history table. The phrase delete is gated on neither dial, so it closes the gap by construction.
        const rig = await groupBook('sampling');
        const phrase = startedPhrase(rig, 2);

        installEntries(rig, phrase.groups, 'run_plotlines_mixed');

        const entriesBefore = rig.store.phraseGroups
            .list()
            .filter((group) => group.phrase_id === phrase.phrase.id)
            .map((group) => `${group.key}:${group.revision}`);

        expect(entriesBefore).toEqual(['chapter_1:1', 'chapter_2:1']);
        expect(rig.store.groupRevisions.list().filter((row) => row.story_id === rig.storyId)).toHaveLength(2);

        await rig.engine.editSeed(rig.storyId, 'A dog walks home through a changed valley.', { confirm: true });

        // The whole phrase is gone, so there is no row left whose `revision` names a deleted line, and no
        // orphan brief the next structure pass would call current (`records.ts:currentPlotlineBrief`).
        expect(phraseStateOf(rig, phrase.phrase)).toEqual({ phrase: 'gone', groups: [], revisions: 0, briefs: 0 });
        expect(rig.store.phrases.list().filter((row) => row.story_id === rig.storyId)).toEqual([]);
        expect(rig.store.phraseGroups.list().filter((row) => row.story_id === rig.storyId)).toEqual([]);
        expect(rig.store.groupRevisions.list().filter((row) => row.story_id === rig.storyId)).toEqual([]);
        expect(rig.store.plotlineBriefs.list().filter((row) => row.story_id === rig.storyId)).toEqual([]);
        // The Story itself is still the D-25a reset it always was: phase ①, the new Seed, no locks.
        expect({
            phase: rig.story().phase,
            idea: rig.story().idea,
            summary_locked: rig.story().summary_locked,
            plotlines_locked: rig.story().plotlines_locked
        }).toEqual({
            phase: 'summary',
            idea: 'A dog walks home through a changed valley.',
            summary_locked: false,
            plotlines_locked: false
        });
    });

    it('takes the phrase on a backtrack to summary exactly as it takes it on a Seed edit (L-31, D-77)', async () => {
        const rig = await groupBook('groups');

        // The Summary written group by group FIRST, so the side this verb must NOT touch is a side with
        // real words and real numbers in it. Without this install the rig's five group rows sit unwritten
        // (`revision: 0`, empty), and "the Summary survived" would be a pin about an empty artifact.
        const summaryGroups = rig.store.phraseGroups.list();
        const summaryPhrase = rig.store.phrases.require(summaryGroups[0]!.phrase_id);

        installGroupRevisions(
            rig.store,
            rig.story(),
            summaryGroups.map((group) => ({ group, content: `${group.key}: the first text.` })),
            AUTHOR_ATTR,
            { runRef: 'run_summary_1', workItemRef: 'wi_draft_groups_1' }
        );

        const phrase = startedPhrase(rig, 3);

        installEntries(rig, phrase.groups, 'run_plotlines_back');

        expect(phraseStateOf(rig, phrase.phrase)).toEqual({
            phrase: 'kept',
            groups: ['chapter_1', 'chapter_2', 'chapter_3'],
            revisions: 3,
            briefs: 1
        });

        // THE SUMMARY SIDE, SCOPED TO PHRASE ① (key `summary`, and its own group rows). Capture it before the
        // call and compare after: `backtrack('summary')` reopens phase ①, so L-31 keeps its artifact — the
        // phrase row and the five group rows with their texts and numbers — and `scrapPhasesAfter` says so
        // itself ("whether the current text itself is re-grown is the CALLER's decision", and this caller does
        // not re-grow). The contract THIS pin owns is that the Phrase ② delete changes none of it.
        const summaryGroupRows = () =>
            rig.store.phraseGroups
                .list()
                .filter((row) => row.phrase_id === summaryPhrase.id)
                .map((row) => ({ id: row.id, key: row.key, revision: row.revision, content: row.content }))
                .sort((a, b) => a.key.localeCompare(b.key));
        const groupRowsBefore = summaryGroupRows();

        // The pre-state, pinned concretely so the after-comparison cannot be a tautology about an empty store.
        expect(groupRowsBefore.map((row) => `${row.key}:${row.revision}`)).toEqual([
            'ending:1',
            'premise:1',
            'promise:1',
            'theme:1',
            'tone:1'
        ]);
        expect(groupRowsBefore.every((row) => row.content === `${row.key}: the first text.`)).toBe(true);

        const summary = rig.store.phrases.require(summaryPhrase.id);

        // The Overview composition itself is `phrase/revisions.ts`'s contract (its exact text is pinned in
        // the phrase suite, and `group-seed-reset.test.ts:226` pins that one installed pass puts the phrase
        // row at revision 2 after a second pass); what matters here is that it is INSTALLED — a real artifact
        // with a number — before the verb runs, so "unchanged" cannot mean "nothing was there".
        expect({ key: summary.key, revision: summary.revision, installed: summary.content !== '' }).toEqual({
            key: 'summary',
            revision: 1,
            installed: true
        });

        await rig.engine.backtrack(rig.storyId, 'summary');

        expect(phraseStateOf(rig, phrase.phrase)).toEqual({ phrase: 'gone', groups: [], revisions: 0, briefs: 0 });
        // Only Phrase ②'s row is gone; the Summary row stands where it was, and so do its five groups.
        expect(
            rig.store.phrases
                .list()
                .filter((row) => row.story_id === rig.storyId)
                .map((row) => `${row.key}:${row.revision}`)
        ).toEqual(['summary:1']);
        const kept = rig.store.phrases.require(summaryPhrase.id);

        expect({ id: kept.id, content: kept.content, revision: kept.revision }).toEqual({
            id: summaryPhrase.id,
            content: summary.content,
            revision: summary.revision
        });
        expect(summaryGroupRows()).toEqual(groupRowsBefore);
    });
});

describe('a backtrack to phase ② keeps the Plotlines Phrase and clears only the lock whose rows it deleted (L-31, D-69, D-77)', () => {
    it('keeps the row, the entries and the brief, and lifts a lock that named a scrapped revision', async () => {
        const rig = await groupBook('groups');
        const phrase = startedPhrase(rig, 2);
        const first = phrase.groups[0]!;

        installEntries(rig, phrase.groups, 'run_plotlines_keep');

        // An Author lock on chapter 1, at the revision the install just wrote. It is a fact ABOUT
        // `group_revisions` row (number 1), and the scrap below deletes that row (D-25) — so the flag goes
        // (D-69) while the entry's TEXT and number stay (L-31).
        lockPhraseGroup(rig.store, rig.story(), first.id, AUTHOR_ATTR, {
            actor: 'author',
            at: '2026-11-24T10:00:00.000Z'
        });

        const before = lockFieldsOf(rig, first.id);

        expect(before).toEqual({
            key: 'chapter_1',
            content: chapterEntryContent(first, plotpointsFor(1)),
            revision: 1,
            locked: true,
            locked_revision: 1,
            locked_by: 'author',
            locked_at: '2026-11-24T10:00:00.000Z'
        });

        const phraseId = phrase.phrase.id;
        const briefId = rig.store.plotlineBriefs.list().find((row) => row.phrase_id === phraseId)!.id;

        await rig.engine.backtrack(rig.storyId, 'plotlines');

        // ① THE PHRASE SURVIVES, same id: phase ② is reopening to revise these entries, not to lose them.
        // The brief that declared the count survives WITH them — `accepted` is the state D-77 keeps, not a
        // draft to redo. (A Seed edit is the opposite case: the brief row is deleted with the phrase, and
        // re-starting means a fresh structure pass.)
        expect(phraseStateOf(rig, phrase.phrase)).toEqual({
            phrase: 'kept',
            groups: ['chapter_1', 'chapter_2'],
            revisions: 0,
            briefs: 1
        });
        expect(rig.store.plotlineBriefs.require(briefId).status).toBe('accepted');

        // ② The entry keeps its TEXT and its number — the base for the next round — and only the four lock
        // fields move, because this scrap deleted the revision row the flag named.
        expect(lockFieldsOf(rig, first.id)).toEqual({
            key: before.key,
            content: before.content,
            revision: before.revision,
            locked: false,
            locked_revision: null,
            locked_by: null,
            locked_at: null
        });

        // ③ The mirrored contracts survive and are unlocked again (L-7's mirror, exactly as the classic
        // book's plotlines are when the same verb runs).
        expect(rig.store.plotlines.list().filter((row) => row.story_id === rig.storyId).map((row) => row.order)).toEqual([1, 2]);
        expect(
            rig.store.plotlines.list().filter((row) => row.story_id === rig.storyId).every((row) => !row.contract_locked)
        ).toBe(true);
        expect({ phase: rig.story().phase, plotlines_locked: rig.story().plotlines_locked }).toEqual({
            phase: 'plotlines',
            plotlines_locked: false
        });
    });

    it('leaves an UNSTARTED Phrase ② exactly where it was — the predicate is the row, never the dial (R6, D-71)', async () => {
        // The book every pre-Phrase-② pin describes: the Summary is grouped, `plotlines_mode` reads
        // `'groups'` by the engine's own default, and the Author never started the phrase. A Seed edit
        // must not invent a phrase deletion here, and must not throw: the row read is the predicate.
        const rig = await groupBook('groups');

        expect(rig.store.phrases.list().filter((row) => row.key === 'plotlines')).toEqual([]);

        await rig.engine.editSeed(rig.storyId, 'A keeper inherits a lamp that has never been lit.', {
            confirm: true
        });

        expect({
            phrases: rig.store.phrases.list().map((row) => `${row.key}:${row.revision}`),
            groups: rig.store.phraseGroups.list().map((row) => `${row.key}:${row.revision}`),
            briefs: rig.store.plotlineBriefs.list()
        }).toEqual({
            phrases: ['summary:0'],
            groups: ['premise:0', 'promise:0', 'theme:0', 'tone:0', 'ending:0'],
            briefs: []
        });
    });
});
