// The dashboard, rendered from what the real server actually sends.
//
// The component suites feed `shell-fakes` fixtures to the panels. This one has no fixtures: every
// prop the shell renders comes out of `GET /stories`, `GET /stories/:id`, `GET /queue` and
// `GET /runs` on a booted Storyline server, so what is on screen is the wire, not a description of
// it. The `ApiClient` double only carries those payloads; it invents nothing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { act, screen } from '@testing-library/react';

import { StorylineApp } from './StorylineApp';
import { fakeHarness, renderWithStore } from './testing/shell-fakes';
import {
    bootStoryline,
    createSliceStory,
    openDial,
    queue,
    SLICE_SEED,
    storyRow,
    storyView,
    type StorylineFixture
} from '../server/integration/harness';
import type { QueueItem, StoryRow, StoryView } from './api';
import { seedHashOf } from '../shared/seed-hash';

/** Mounts the whole shell over one Story's real payloads, with the Story region already open. */
async function mountRealServer(
    rows: StoryRow[],
    items: QueueItem[],
    view: StoryView,
    runs: Array<Record<string, unknown>>
) {
    const harness = fakeHarness(rows, items, {
        getStory: async () => view,
        listRuns: async () => runs as never
    });

    await harness.store.reload();
    await harness.store.openStory(rows[0].id);

    let mounted = false;

    await act(async () => {
        renderWithStore(<StorylineApp store={harness.store} />, harness.store);
        mounted = true;
    });

    expect(mounted).toBe(true);

    return harness;
}

describe('the dashboard over the real server', () => {
    let fixture: StorylineFixture;
    let storyId = '';

    beforeAll(async () => {
        fixture = await bootStoryline();
        storyId = await createSliceStory(fixture, 3);
        await openDial(fixture, storyId);
    });

    afterAll(async () => {
        await fixture.close();
    });

    it('a Story nobody has worked on renders from the server without inventing a level (L-14)', async () => {
        const rows = (await fixture.api<StoryRow[]>('GET', '/stories')).body;

        // S-RUNTIME: the workspace's Story id is the UUID its book is named after
        // (`store/persist.ts:STORY_ID_PATTERN`), not a `story_<n>` counter — the row the panel renders
        // is therefore keyed by the id the fixture got back from `POST /stories`.
        expect(await storyRow(fixture, storyId)).toMatchObject({ id: storyId, phase: 'summary', status: 'ready' });

        await mountRealServer(
            rows,
            (await queue(fixture)) as QueueItem[],
            (await storyView(fixture, storyId)) as StoryView,
            []
        );

        // The title is the projection's own truncation of the Seed, not the test's.
        expect(
            screen.getAllByText('A nobody inherits a lighthouse that chooses its own keepe...').length
        ).toBeGreaterThan(0);

        const text = String(document.body.textContent);

        // The navigation row says the server's status and nothing it recomputed. Levels live on
        // the panes now; the compact row must not smuggle a second rendering in.
        expect(text).toContain('ready');
        expect(text).not.toContain('n/a');

        // The Story view prints the server's own reason sentence.
        expect(text).toContain('phase summary is open: the Seed is being expanded (L-29 stops it at the lock)');
    });

    it('the same screen once the phase-① crew has sampled keeps rendering the real Story payload', async () => {
        // Phase ①'s opener is gated (documents/phase-1-research-pipeline.md §6.4): sweep 1 structures
        // the Seed, sweep 2 researches it, and only then — with an ACCEPTED brief and the research
        // closed — do the `summary_sampling` Writer samples start. Walking to the first sampler is
        // therefore a proof the two gates really ran, not a sleep: the crew below cannot exist on a
        // server that skipped one.
        await fixture.settle(
            () => fixture.store.runs.list().some((run) => run.template_ref === 'writer-summary-sampler'),
            20
        );

        const rows = (await fixture.api<StoryRow[]>('GET', '/stories')).body;
        const runs = (await fixture.api<Array<Record<string, unknown>>>('GET', `/runs?story_id=${storyId}`)).body;
        const view = (await storyView(fixture, storyId)) as StoryView;

        await mountRealServer(rows, (await queue(fixture)) as QueueItem[], view, runs);

        const text = String(document.body.textContent);

        expect(
            screen.getAllByText('A nobody inherits a lighthouse that chooses its own keepe...').length
        ).toBeGreaterThan(0);
        expect(text).toContain('Summary — Phrase 1');

        // ---------------------------------------------------------------------
        // C7 / R10 — the phrase attribution over the REAL wire, on the surface the Author is handed.
        //
        // Everything else in this file mounts the shell and reads its prose; these lines pin the two halves of the
        // fix that a fixture suite cannot prove: that `GET /stories/:id` LABELS its crew slice exactly like
        // `GET /runs` (the gap that made the mark invisible on the path the desk reads first), and that the
        // mounted status line renders those labels rather than defaulting to Phrase ①. The rows here are the
        // phase-① opener's real rows: the Seed structuring pass is Phrase ①'s by claim-key family, the research
        // job and the sampler are keyed on refs the projection cannot resolve to a phrase, and they are ALL closed
        // by now, which is why the line itself stays silent — the desk says nothing about a crew that is not
        // working, and invents no phrase for a row it cannot attribute.
        // ---------------------------------------------------------------------
        const structuringKey = `wi_structure_seed_${seedHashOf(SLICE_SEED)}`;
        const labelOf = (run: Record<string, unknown>): unknown => run.phrase_key;

        // ONE RULE, ONE ANSWER on both routes — every row of the Story payload labelled, alike with the crew listing.
        expect((view.runs as unknown as Array<Record<string, unknown>>).map(labelOf)).toEqual(
            runs.map(labelOf)
        );
        expect((view.runs as unknown as Array<Record<string, unknown>>).map(labelOf)).toContain('summary');
        expect(runs.map(labelOf)).not.toContain(undefined);

        // THE ROWS THE PANEL LABELS, as the shipped projection answers them for this book.
        const labelsByKey = new Map(
            runs.map((run) => [String(run.work_item_ref), String(run.phrase_key)])
        );

        expect(labelsByKey.get(structuringKey)).toBe('summary');
        expect(labelsByKey.get('wi_research_1')).toBe('unknown');

        // AND THE MOUNTED SURFACE: the status line the shell renders above the pane, read off the real payload.
        const statusLine = document.querySelector('.sv-story-status')?.textContent ?? '';

        expect(statusLine).not.toContain('Phrase 1');
        expect(statusLine).not.toContain('phrase not named');

        // The crew is the server's run rows: the templates that actually ran, not a fixture list —
        // phase ①'s opener in dispatch order (templates.ts:DEFAULT_ASSIGNMENT). `writer-summary` no
        // longer exists; the Sampler replaced it (§6.4 step 3).
        //
        // The two GATE rows are pinned exactly, in dispatch order, with the role each one ran under:
        // that is the proof the walk reached a sampler through both gates rather than past them. What
        // follows them is the SAMPLING LEG — one `wi_sample_…` claim per sample
        // (`loop/records.ts:sampleKeyOf`) and one `wi_screen_revision_<n>_<pass>` claim per screening
        // pass over that sample (`loop/records.ts:screenPrefixOf`, and the key names the SAMPLE's own
        // revision id, so sample 1's first pass is `wi_screen_revision_0_1`).
        //
        // WHY THE LEG IS SPLIT FROM THE GATES BY CLAIM PREFIX RATHER THAN PINNED ROW-FOR-ROW: the walk
        // stops the moment ONE sampler row exists (`settle` above), and `harness.ts:tick` drains every
        // run a sweep opens — so on a loaded machine the first sample's screening pass has already torn
        // down inside the same tick that produced the sampler. Screening is therefore legitimate work of
        // the leg, not a gate this walk walked past: it is filtered with the samples and pinned by WHO
        // ran, exactly like them. The exact per-round ledger is pinned row-for-row in
        // `summary-sampling.test.ts` and `slice-phases.test.ts`. Anything that is neither gate nor
        // sampler nor screening pass (a deep review, an escalation, a sign-off) lands in `gates` below
        // and fails it, which is what keeps the shape honest.
        const keyOf = (run: Record<string, unknown>): string => String(run.work_item_ref);
        const samplerOf = (run: Record<string, unknown>): string => `${String(run.template_ref)}/${String(run.role)}`;

        const sampling = runs.filter((run) => keyOf(run).startsWith('wi_sample_'));
        const screening = runs.filter((run) => keyOf(run).startsWith('wi_screen_'));
        const gates = runs.filter(
            (run) => !keyOf(run).startsWith('wi_sample_') && !keyOf(run).startsWith('wi_screen_')
        );

        expect(gates.map((run) => [keyOf(run), String(run.template_ref), String(run.role)])).toEqual([
            [`wi_structure_seed_${seedHashOf(SLICE_SEED)}`, 'editor-seed-structure', 'editor'],
            ['wi_research_1', 'researcher-story', 'researcher']
        ]);

        // The Sampler is the only crew writing prose here, under the Writer's kind, and at least one
        // sample row exists — which is the row the stop predicate walked to.
        expect(sampling.length).toBeGreaterThan(0);
        expect([...new Set(sampling.map(samplerOf))]).toEqual(['writer-summary-sampler/writer']);

        // A screening pass that has landed is the Screening crew reading a sample: none is legitimate
        // (the sweep may have stopped after the first sample), and any row under a `wi_screen_…` claim
        // that is NOT `critic-screening/critic` is the drift this pins.
        expect(screening.filter((run) => samplerOf(run) !== 'critic-screening/critic')).toEqual([]);
    });
});
