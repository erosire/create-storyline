// C7 / R10 — the STORY payload attributes its crew rows exactly like the crew listing does.
//
// THE GAP. C2a put the phrase attribution on `GET /runs` (`runsAcross` → `projectRunRow`) and left
// `GET /stories/:id`'s `runs` slice as plain §4.13 rows — the desk's own Story frame, which
// `dashboard/state.ts:refreshStory` ALSO parks in the crew slot (`runs: view.runs`). A surface fed by the Story
// payload therefore had no `phrase_key` to render and could only print "phrase not named": the phrase mark was
// real on one route and absent on the one the desk reads first.
//
// THE RULE UNDER TEST, unchanged from `run-phrase-attribution.test.ts` (that file pins WHY a row reads the way it
// does; this file pins that the SECOND route gives the same answer):
//   held `group_refs` win, then the claim key's family (`wi_structure_seed_*` → summary,
//   `wi_structure_plotlines_*` → plotlines, `wi_draft_groups_<ref>_<hash>` resolved against THIS book), and
//   neither → `'unknown'` — never a silent Phrase ①.
//
// The ids are the ones the store mints (`story_0`, `summary_0`, `phrase_group_*`) and `recordUidAt` mints for the
// phrase rows, because the claim-key rule reads those ids. Every expected value below is a literal.
import { describe, expect, it } from 'vitest';

import { Store } from '../store/store';
import { recordUidAt } from '../store/persist';
import { AUTHOR_ATTR, seedStory } from '../run/mock';
import { CriteriaEngine } from '../criteria/engine';
import { DigestBuilder } from '../digest/digest';
import { projectRunRow, runsAcross, storyView } from './projections';
import type { ProjectedRun } from '../../dashboard/api';
import type { Run, Story } from '../../shared/types';

/** One book: a Story, its `summaries` row, both numbered phrase rows, one group in each. */
function book() {
    const store = Store.empty();
    const story = seedStory(store, { phase: 'plotlines' });
    const summaryId = store.summaries.list().find((row) => row.story_id === story.id)!.id;
    let nextUid = 0;

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

    return {
        store,
        story,
        summaryId,
        summaryPhrase,
        plotlinesPhrase,
        premise: group(summaryPhrase.id, 'premise', 1),
        chapter: group(plotlinesPhrase.id, 'chapter_1', 1)
    };
}

/** A run row in the shape `run/executor.ts` writes: the claim key, and the group set copied off the Work Item. */
function seedRun(
    store: Store,
    story: Story,
    init: { work_item_ref?: string; group_refs?: string[] } = {}
): Run {
    return store.runs.create(
        {
            story_id: story.id,
            ...(init.work_item_ref === undefined ? {} : { work_item_ref: init.work_item_ref }),
            role: 'writer',
            state: 'working',
            started_at: '2026-11-25T10:00:00.000Z',
            tokens: 0,
            kind: 'work',
            delegated: [],
            ...(init.group_refs === undefined ? {} : { group_refs: init.group_refs })
        },
        AUTHOR_ATTR
    );
}

/** The whole pinned set: the two draft families, both held-group answers, a vector-hash pass, an assistant row. */
function seedSixRows(world: ReturnType<typeof book>) {
    const { store, story, summaryId, plotlinesPhrase, premise, chapter } = world;

    seedRun(store, story, { work_item_ref: `wi_draft_groups_${summaryId}_9b7c5d3e1f2a4068_2` });
    seedRun(store, story, { work_item_ref: `wi_draft_groups_${plotlinesPhrase.id}_9b7c5d3e1f2a4068_2` });
    seedRun(store, story, { work_item_ref: 'wi_review_groups_4c1d8e2a77b0f5a3', group_refs: [chapter.id] });
    seedRun(store, story, { work_item_ref: 'wi_review_groups_4c1d8e2a77b0f5a3', group_refs: [premise.id] });
    seedRun(store, story, { work_item_ref: 'wi_group_check_4c1d8e2a77b0f5a3' });
    seedRun(store, story, { work_item_ref: 'assistant_story_0_1' });
}

const deps = (store: Store) => ({ store, criteria: new CriteriaEngine(), digest: new DigestBuilder() });

describe('the Story payload labels its runs with the same rule the crew listing uses (C7/R10)', () => {
    it('`GET /stories/:id` rows and `GET /runs` rows carry identical labels for identical rows', () => {
        const world = book();
        const { store, story } = world;

        seedSixRows(world);

        const view = storyView(deps(store), story);
        const rows = view.runs as ProjectedRun[];

        expect(rows.map((run) => [run.id, run.phrase_key])).toEqual([
            ['run_0', 'summary'],
            ['run_1', 'plotlines'],
            ['run_2', 'plotlines'],
            ['run_3', 'summary'],
            ['run_4', 'unknown'],
            ['run_5', 'unknown']
        ]);

        // THE ONE RULE, ONE ANSWER: the same six rows through the crew listing's projection read alike, in the
        // same order (both read the store's order for one Story), so no surface can be right and the other wrong.
        expect(rows.map((run) => [run.id, run.phrase_key])).toEqual(
            runsAcross([store], story.id).map((run) => [run.id, run.phrase_key])
        );

        // And both are still the per-row answer, not a route-level guess: a row's label comes from its own rows.
        expect(store.runs.list().map((run) => [run.id, projectRunRow(store, run).phrase_key])).toEqual(
            rows.map((run) => [run.id, run.phrase_key])
        );
    });

    it('the label is ADDITIVE — the pinned slice order, the row fields and the store all stay as they were', () => {
        const world = book();
        const { store, story } = world;

        seedSixRows(world);

        const view = storyView(deps(store), story);
        const rows = view.runs as ProjectedRun[];
        const stored = store.runs.list();

        // Every §4.13 field still travels, unchanged, and `phrase_key` is the only addition.
        expect(rows.length).toBe(stored.length);
        rows.forEach((row, index) => {
            expect({ ...row, phrase_key: undefined }).toEqual({ ...stored[index]!, phrase_key: undefined });
        });

        // The slice is a COPY: the stored row never gains a display field a restart or a back-track could leave
        // out of step with the rows it describes (P1 — the store is the memory).
        expect(Object.keys(stored[0]!).includes('phrase_key')).toBe(false);

        // The pinned key order of the payload is untouched: the label rides INSIDE the runs slice, and the slice
        // itself keeps its position, right after `proposals` and before `templates`.
        expect(Object.keys(view).indexOf('runs') - Object.keys(view).indexOf('proposals')).toBe(1);
        expect(Object.keys(view).indexOf('templates') - Object.keys(view).indexOf('runs')).toBe(1);
    });

    it('a Story nobody has worked on answers an empty labelled slice, and never a phrase', () => {
        const world = book();

        const view = storyView(deps(world.store), world.story);

        expect(view.runs).toEqual([]);
        expect((view.runs as ProjectedRun[]).map((run) => run.phrase_key)).toEqual([]);
    });

    it('the slice stays scoped to the Story the payload is about, label included', () => {
        const world = book();
        const { store, story } = world;
        const other = seedStory(store, { phase: 'plotlines' });

        seedSixRows(world);
        // A sibling Story's row, with the OTHER story's summaries id resolved, so its label differs.
        const otherSummaryId = store.summaries.list().find((row) => row.story_id === other.id)!.id;

        seedRun(store, other, { work_item_ref: `wi_draft_groups_${otherSummaryId}_9b7c5d3e1f2a4068_1` });

        const view = storyView(deps(store), story);

        expect((view.runs as ProjectedRun[]).map((run) => [run.story_id, run.id, run.phrase_key])).toEqual([
            ['story_0', 'run_0', 'summary'],
            ['story_0', 'run_1', 'plotlines'],
            ['story_0', 'run_2', 'plotlines'],
            ['story_0', 'run_3', 'summary'],
            ['story_0', 'run_4', 'unknown'],
            ['story_0', 'run_5', 'unknown']
        ]);
        expect(
            (storyView(deps(store), other).runs as ProjectedRun[]).map((run) => [
                run.story_id,
                run.id,
                run.phrase_key
            ])
        ).toEqual([
            ['story_1', 'run_6', 'summary']
        ]);
    });
});
