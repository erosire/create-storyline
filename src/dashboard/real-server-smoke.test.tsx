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

    it('a Story nobody has worked on renders its unreached levels as `n/a`, never as a score (L-14)', async () => {
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

        // L-14: the level the Story is in shows `n/m` with the failure named, and the three it has not
        // reached show `n/a` — a level nobody has judged is not a level with zero passing.
        const text = String(document.body.textContent);

        expect(text).toContain('1/2 · failing: C-14');
        expect(text.split('n/a')).toHaveLength(4);

        // And the reason the row carries is the server's sentence, verbatim.
        expect(text).toContain('phase summary is open: the Seed is being expanded (L-29 stops it at the lock)');
    });

    it('the same screen after one sweep shows the crew working and the Summary level passing', async () => {
        await fixture.tick();

        const rows = (await fixture.api<StoryRow[]>('GET', '/stories')).body;
        const runs = (await fixture.api<Array<Record<string, unknown>>>('GET', `/runs?story_id=${storyId}`)).body;

        await mountRealServer(
            rows,
            (await queue(fixture)) as QueueItem[],
            (await storyView(fixture, storyId)) as StoryView,
            runs
        );

        const text = String(document.body.textContent);

        // The Summary level moved to a passing score while the other three stay unreached.
        expect(text).toContain('2/2');
        expect(text.split('n/a')).toHaveLength(4);

        // The crew rail is the server's run rows: the templates that actually ran, not a fixture list.
        expect(runs.map((run) => run.template_ref)).toEqual(['writer-summary', 'writer-summary', 'writer-summary']);
        expect(text).toContain('writer-summary');
    });
});
