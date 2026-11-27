// C2a / R4 (symptom 3, second half) — the SERVER derives which PHRASE a crew row belongs to.
//
// WHAT THE AUTHOR COULD NOT SEE. The desk showed runs with no phrase word on the row at all, so a Writer the loop
// had dispatched against Phrase ②'s chapter entries sat under a rail lit on Phrase ① and read as Phrase-① work.
// `projections.ts:runPhraseKeyOf` answers the question from rows the book already holds, and `'unknown'` is a real
// answer rather than a default to Phrase ①.
//
// THE RULE, in the order the witnesses arrive (`projections.ts:runPhraseKeyOf`):
//   1. THE GROUP SET THE RUN HOLDS (`Run.group_refs`, the run's own persisted state, copied off the Work Item by
//      `run/executor.ts`) — every ref must resolve to a group on the run's OWN Story and to a phrase the rail
//      numbers; a ref that resolves nowhere is not attributable and falls through, and a set spanning both phrases
//      says `'unknown'` about the whole run;
//   2. else THE CLAIM KEY, and only for the three families that carry a phrase in their string:
//      `wi_structure_seed_*` (Phrase ①), `wi_structure_plotlines_*` (Phrase ②), and
//      `wi_draft_groups_<claim ref>_<hash>` whose ref is resolved against THIS book's rows — the `summaries` id
//      for Phrase ①, the plotlines PHRASE ROW id for Phrase ② (seam S8);
//   3. else `'unknown'`: the vector-hash families (`wi_review_groups_*`, `wi_summary_score_*`, `wi_group_check_*`)
//      are keyed on a hash BOTH phrases mint, and the classic jobs are not phrase-scoped at all.
//
// The ids are asserted as the store mints them (`story_0`, `summary_0`, `group_0`) and as `recordUidAt` mints the
// phrase addresses, because the claim-key rule reads those ids — a fixture with invented ids would test the
// fixture. Every expected value below is a literal.
import { describe, expect, it } from 'vitest';

import { Store } from '../store/store';
import { recordUidAt } from '../store/persist';
import { AUTHOR_ATTR, seedStory } from '../run/mock';
import { projectRunRow, runPhraseKeyOf, runsAcross } from './projections';
import type { Run, Story } from '../../shared/types';

/** One book: a Story, its `summaries` row, both numbered phrase rows, and one group in each. */
function book() {
    const store = Store.empty();
    const story = seedStory(store, { phase: 'plotlines' });
    const summaryId = store.summaries.list().find((row) => row.story_id === story.id)!.id;
    let nextUid = 0;

    // The two phrase rows the desk numbers, addressed by real record uids — the shape the start route mints, and
    // the address a Phrase-② claim key quotes.
    const phrase = (key: 'summary' | 'plotlines', order: number) =>
        store.phrases.createWithId(
            recordUidAt(nextUid++),
            {
                story_id: story.id,
                key,
                title: key === 'summary' ? 'Summary' : 'Plotlines',
                description: `${key} pipeline.`,
                content: '',
                order,
                revision: 0,
                group_refs: []
            },
            AUTHOR_ATTR
        );
    const summaryPhrase = phrase('summary', 1);
    const plotlinesPhrase = phrase('plotlines', 2);

    const group = (phraseId: string, key: string, order: number) =>
        store.phraseGroups.create(
            {
                story_id: story.id,
                phrase_id: phraseId,
                key,
                title: `The ${key} group`,
                description: 'A group the crew writes.',
                order,
                content: 'The text the Writer installed.',
                revision: 1
            },
            AUTHOR_ATTR
        );

    return { store, story, summaryId, summaryPhrase, plotlinesPhrase, premise: group(summaryPhrase.id, 'premise', 1) };
}

/** A run row in the shape `run/executor.ts` writes: the claim key, and the group set copied off the Work Item. */
function seedRun(
    store: Store,
    story: Story,
    init: { work_item_ref?: string; group_refs?: string[]; started_at?: string } = {}
): Run {
    return store.runs.create(
        {
            story_id: story.id,
            ...(init.work_item_ref === undefined ? {} : { work_item_ref: init.work_item_ref }),
            role: 'writer',
            state: 'working',
            started_at: init.started_at ?? '2026-11-25T10:00:00.000Z',
            tokens: 0,
            kind: 'work',
            delegated: [],
            ...(init.group_refs === undefined ? {} : { group_refs: init.group_refs })
        },
        AUTHOR_ATTR
    );
}

describe('the crew listing labels each run with the phrase its own rows name (C2a/R4)', () => {
    it('the two structuring families name their own phrase, and neither collapses into the other', () => {
        // The two phrases can hold IDENTICAL text and hash to the same string, which is exactly why the loop mints
        // two families. Reading them alike is the mislabel symptom 3 looks like.
        const { store, story } = book();

        const summaryPass = seedRun(store, story, { work_item_ref: 'wi_structure_seed_3f9a1c7b5d2e8a40_1' });
        const plotlinesPass = seedRun(store, story, { work_item_ref: 'wi_structure_plotlines_3f9a1c7b5d2e8a40_1' });

        expect(runPhraseKeyOf(store, summaryPass)).toBe('summary');
        expect(runPhraseKeyOf(store, plotlinesPass)).toBe('plotlines');
    });

    it('a draft claim key is resolved against this book’s rows, in both directions', () => {
        const { store, story, summaryId, plotlinesPhrase } = book();

        // Phrase ①'s batch is keyed on the `summaries` row id, Phrase ②'s on the plotlines PHRASE ROW id (seam S8).
        const summaryBatch = seedRun(store, story, {
            work_item_ref: `wi_draft_groups_${summaryId}_9b7c5d3e1f2a4068_2`
        });
        const plotlinesBatch = seedRun(store, story, {
            work_item_ref: `wi_draft_groups_${plotlinesPhrase.id}_9b7c5d3e1f2a4068_2`
        });

        expect(runPhraseKeyOf(store, summaryBatch)).toBe('summary');
        expect(runPhraseKeyOf(store, plotlinesBatch)).toBe('plotlines');

        // THE ANCHORED `_`: a ref that merely STARTS with another ref is not that ref. `summary_0x` is a different
        // claim ref, and reading it as Phrase ① would attribute a row this book has no evidence for.
        const lookalike = seedRun(store, story, { work_item_ref: 'wi_draft_groups_summary_0x_9b7c5d3e1f2a4068_1' });

        expect(runPhraseKeyOf(store, lookalike)).toBe('unknown');
    });

    it('the group set the run holds outranks the claim key, and a batch across both phrases names neither', () => {
        const { store, story, premise, plotlinesPhrase, summaryId } = book();
        const chapterGroup = store.phraseGroups.create(
            {
                story_id: story.id,
                phrase_id: plotlinesPhrase.id,
                key: 'chapter_1',
                title: 'Chapter 1 — The Salt Road',
                description: 'The chapter contract.',
                order: 1,
                content: '## Must happen: the crossing.',
                revision: 1
            },
            AUTHOR_ATTR
        );

        // (a) An unattributable claim key, and a chapter entry in hand: the HAND decides.
        const writer = seedRun(store, story, {
            work_item_ref: 'wi_review_groups_4c1d8e2a77b0f5a3',
            group_refs: [chapterGroup.id]
        });

        expect(runPhraseKeyOf(store, writer)).toBe('plotlines');

        // (b) A Summary group in hand: the same rule answers Phrase ①.
        const summariser = seedRun(store, story, {
            work_item_ref: 'wi_review_groups_4c1d8e2a77b0f5a3',
            group_refs: [premise.id]
        });

        expect(runPhraseKeyOf(store, summariser)).toBe('summary');

        // (c) A batch spanning BOTH phrases says nothing about either — and does not fall through to the key,
        // which would have quietly filed it under Phrase ①.
        const straddler = seedRun(store, story, {
            work_item_ref: `wi_draft_groups_${summaryId}_9b7c5d3e1f2a4068_3`,
            group_refs: [premise.id, chapterGroup.id]
        });

        expect(runPhraseKeyOf(store, straddler)).toBe('unknown');
    });

    it('a ref that resolves nowhere is not attributable, and falls through to the claim key', () => {
        const { store, story, summaryId } = book();

        // A deleted group, or a row from another book: the run's own rows no longer answer, so the claim key is
        // asked — and a PARTIAL group set must not outvote it.
        const dangling = seedRun(store, story, {
            work_item_ref: `wi_draft_groups_${summaryId}_9b7c5d3e1f2a4068_4`,
            group_refs: ['00000000-0000-4000-8000-0000000000fe']
        });

        expect(runPhraseKeyOf(store, dangling)).toBe('summary');

        const danglingAndUnkeyed = seedRun(store, story, {
            work_item_ref: 'wi_summary_score_4c1d8e2a77b0f5a3',
            group_refs: ['00000000-0000-4000-8000-0000000000fe']
        });

        expect(runPhraseKeyOf(store, danglingAndUnkeyed)).toBe('unknown');

        // A group on ANOTHER Story of the same book: ids are book-local, so the row must also belong to THIS
        // Story before it may say anything about this run.
        const other = seedStory(store, { phase: 'plotlines' });
        const borrowed = seedRun(store, other, {
            work_item_ref: 'wi_review_groups_4c1d8e2a77b0f5a3',
            group_refs: [store.phraseGroups.list()[0].id]
        });

        expect(borrowed.story_id).toBe(other.id);
        expect(runPhraseKeyOf(store, borrowed)).toBe('unknown');
    });

    it('a family both phrases mint stays unknown, rather than defaulting to Phrase 1', () => {
        const { store, story } = book();

        // A vector hash is a number this build cannot reverse into a phrase, and these runs carry no group rows
        // here. The desk says so; it does not pick the phrase the rail happens to be lit on.
        for (const key of [
            'wi_review_groups_4c1d8e2a77b0f5a3',
            'wi_summary_score_4c1d8e2a77b0f5a3',
            'wi_group_check_4c1d8e2a77b0f5a3',
            'wi_group_lock_4c1d8e2a77b0f5a3',
            'wi_write_ch1',
            'wi_check_unit_ch1_a2',
            'wi_research_valley'
        ]) {
            expect(runPhraseKeyOf(store, seedRun(store, story, { work_item_ref: key }))).toBe('unknown');
        }

        // A row with NEITHER a claim key nor group rows — the assistant's own run — is equally unattributed.
        const bare = seedRun(store, story, {});

        expect(runPhraseKeyOf(store, bare)).toBe('unknown');
    });

    it('the listing labels every row, per BOOK, and never writes the label into the store', () => {
        // Two books, each minting its own `run_0` and its own `phrase_group_*`: the SAME id string means a
        // different row — indeed a DIFFERENT PHRASE, or nothing at all — in the other book, which is why the
        // attribution runs against the book the row came from.
        const first = book();
        const second = book();
        const chapterInSecond = second.store.phraseGroups.create(
            {
                story_id: second.story.id,
                phrase_id: second.plotlinesPhrase.id,
                key: 'chapter_2',
                title: 'Chapter 2 — The Toll',
                description: 'The chapter contract.',
                order: 2,
                content: '## Must change: the road collects.',
                revision: 1
            },
            AUTHOR_ATTR
        );

        expect(chapterInSecond.id).toBe('phrase_group_1');
        expect(second.store.phraseGroups.require('phrase_group_1').phrase_id).toBe(second.plotlinesPhrase.id);
        expect(first.store.phraseGroups.get('phrase_group_1')).toBeUndefined();

        const firstRun = seedRun(first.store, first.story, { group_refs: ['phrase_group_1'] });
        const secondRun = seedRun(second.store, second.story, { group_refs: ['phrase_group_1'] });

        // One book's dangling ref is the other book's chapter entry, and the label follows the book.
        expect(runPhraseKeyOf(first.store, firstRun)).toBe('unknown');
        expect(runPhraseKeyOf(second.store, secondRun)).toBe('plotlines');
        expect(runsAcross([first.store, second.store]).map((row) => [row.id, row.phrase_key])).toEqual([
            ['run_0', 'unknown'],
            ['run_0', 'plotlines']
        ]);

        // The listing is a COPY: a stored row never gains a display field (`runs.require` would otherwise carry a
        // phrase label through a restart, which is the drift R4 projects instead of storing).
        const stored = first.store.runs.require('run_0');

        expect(Object.keys(stored).includes('phrase_key')).toBe(false);
        expect(runsAcross([first.store])[0]).toEqual({ ...stored, phrase_key: 'unknown' });
        expect(projectRunRow(second.store, secondRun)).toEqual({ ...secondRun, phrase_key: 'plotlines' });
    });

    it('the Story filter narrows the LABELED listing, and sorts oldest first', () => {
        const { store, story } = book();
        const other = seedStory(store, { phase: 'plotlines' });

        seedRun(store, story, { work_item_ref: 'wi_structure_seed_3f9a1c7b5d2e8a40_1', started_at: '2026-11-25T12:00:00.000Z' });
        seedRun(store, other, { work_item_ref: 'wi_structure_plotlines_3f9a1c7b5d2e8a40_1', started_at: '2026-11-25T09:00:00.000Z' });

        // Both stories are `story_*` in ONE book, so the filter is on the row's Story and the labels survive it.
        expect(runsAcross([store]).map((row) => [row.story_id, row.phrase_key])).toEqual([
            ['story_1', 'plotlines'],
            ['story_0', 'summary']
        ]);
        expect(runsAcross([store], 'story_1').map((row) => [row.story_id, row.phrase_key])).toEqual([
            ['story_1', 'plotlines']
        ]);
        expect(runsAcross([store], 'story_absent')).toEqual([]);
    });
});
