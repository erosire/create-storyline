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
    storyRow,
    storyView,
    type StorylineFixture
} from '../server/integration/harness';
import type { QueueItem, StoryRow, StoryView } from './api';

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

        expect(await storyRow(fixture, storyId)).toMatchObject({ id: 'story_1', phase: 'summary', status: 'ready' });

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

        await mountRealServer(
            rows,
            (await queue(fixture)) as QueueItem[],
            (await storyView(fixture, storyId)) as StoryView,
            runs
        );

        const text = String(document.body.textContent);

        expect(
            screen.getAllByText('A nobody inherits a lighthouse that chooses its own keepe...').length
        ).toBeGreaterThan(0);
        expect(text).toContain('Summary — Phrase 1');

        // The crew is the server's run rows: the templates that actually ran, not a fixture list —
        // phase ①'s opener in dispatch order (templates.ts:DEFAULT_ASSIGNMENT). `writer-summary` no
        // longer exists; the Sampler replaced it, and it buys one sample per sweep (§6.4 step 3's
        // claim key), so the FIRST sampler row is exactly where this walk stopped.
        expect(runs.map((run) => run.template_ref)).toEqual([
            'editor-seed-structure',
            'researcher-story',
            'writer-summary-sampler'
        ]);
        expect(runs.map((run) => run.role)).toEqual(['editor', 'researcher', 'writer']);
    });
});
