// §10 / P1 — deleting a Story is deleting its harness: every story-scoped §4 row, the knowledge
// directory, the in-memory sessions/threads, and the Story row itself. This is the route the
// dashboard's Delete button drives, asserted through the real engine and store.
import { describe, expect, it } from 'vitest';
import { MockChatClient, msg } from '../llm/mock';
import { buildStorylineRuntime } from './server';
import { MockToolRuntime, seedChapter, seedFinding, seedIdea, seedPlotline, seedRevision, seedTask } from '../run/mock';
import { Store } from '../store/store';
import type { Hono } from 'hono';
import type { StoryRow } from '../../dashboard/api';

const makeApp = () => {
    const store = Store.empty();
    const chat = new MockChatClient(() => ({ message: msg({ content: 'nothing to report' }) }));
    const runtime = new MockToolRuntime(store, '');
    const built = buildStorylineRuntime({
        store,
        chat,
        runtime,
        engineConfig: { autoSweep: false },
        noAssistantSeed: true
    });

    return { ...built, toolRuntime: runtime };
};

async function call(app: Hono, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) {
    const response = await app.request(`http://localhost/v1/storyline${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    });
    const text = await response.text();

    return { status: response.status, body: text.length === 0 ? undefined : (JSON.parse(text) as unknown) };
}

describe('DELETE /stories/:id — the Story and its harness go together (P1, §10)', () => {
    it('removes the book, its artifacts, its runs, its knowledge and its harness', async () => {
        const world = makeApp();

        const created = await call(world.app, 'POST', '/stories', {
            title: 'The Salt Cartographer',
            idea: 'A mapmaker finds her own coastline redrawn on a chart she surveyed herself.',
            chapter_count: 2
        });
        const storyId = (created.body as StoryRow).id;

        // Seed one row in the collections the Story owns (the shape of a lived-in book).
        const plotline = seedPlotline(world.store, storyId);
        const chapter = seedChapter(world.store, storyId, { plotline_ref: plotline.id });
        seedFinding(world.store, storyId, { target_ref: chapter.id });
        seedTask(world.store, storyId);
        seedIdea(world.store, storyId);
        seedRevision(world.store, storyId, chapter.id, 'a competing draft', 'run_1');

        world.store.runs.create(
            {
                story_id: storyId,
                work_item_ref: 'wi_write_chapter_1',
                role: 'writer',
                state: 'torn_down',
                started_at: '2026-11-22T10:00:00.000Z',
                ended_at: '2026-11-22T10:00:01.000Z',
                tokens: 12,
                kind: 'work',
                no_op: false,
                delegated: []
            },
            { run_ref: null, author: true, why: 'seed a closed run the delete must remove' }
        );

        // The knowledge directory materialises on read; the harness exists once a Story dispatches.
        expect((await call(world.app, 'GET', `/stories/${storyId}/knowledge`)).status).toBe(200);
        expect(world.knowledge.tree(storyId)?.sections).toHaveLength(8);

        world.executor.harness.forStory(storyId);
        expect(world.executor.harness.has(storyId)).toBe(true);

        const deleted = await call(world.app, 'DELETE', `/stories/${storyId}`);

        expect(deleted).toEqual({ status: 200, body: { deleted: storyId } });
        expect(world.store.stories.get(storyId)).toBeUndefined();
        expect(world.store.summaries.list().filter((row) => row.story_id === storyId)).toEqual([]);
        expect(world.store.plotlines.list().filter((row) => row.story_id === storyId)).toEqual([]);
        expect(world.store.chapters.list().filter((row) => row.story_id === storyId)).toEqual([]);
        expect(world.store.findings.list().filter((row) => row.story_id === storyId)).toEqual([]);
        expect(world.store.tasks.list().filter((row) => row.story_id === storyId)).toEqual([]);
        expect(world.store.ideas.list().filter((row) => row.story_id === storyId)).toEqual([]);
        expect(world.store.revisions.list().filter((row) => row.story_id === storyId)).toEqual([]);
        expect(world.store.runs.list().filter((row) => row.story_id === storyId)).toEqual([]);
        expect(world.store.goals.list().filter((row) => row.story_id === storyId)).toEqual([]);

        // The projection outside §4 and the harness are gone with the Story.
        expect(world.knowledge.tree(storyId)).toBeNull();
        expect(world.executor.harness.has(storyId)).toBe(false);
        expect((await call(world.app, 'GET', `/stories/${storyId}`)).status).toBe(404);
        expect((await call(world.app, 'GET', `/stories/${storyId}/knowledge`)).status).toBe(404);
    });

    it('keeps the global template catalogue: a template is the Author’s, not the Story’s', async () => {
        const world = makeApp();
        const created = await call(world.app, 'POST', '/stories', {
            title: 'First Light',
            idea: 'A keeper inherits a lamp that has never been lit.',
            chapter_count: 1
        });
        const storyId = (created.body as StoryRow).id;
        const before = world.store.templates.list().map((row) => row.name);

        await call(world.app, 'DELETE', `/stories/${storyId}`);

        expect(world.store.templates.list().map((row) => row.name)).toEqual(before);
    });

    it('answers 404 for a Story that is not in the book, and 404 for a second delete', async () => {
        const world = makeApp();
        const created = await call(world.app, 'POST', '/stories', {
            title: 'Quiet Orchard',
            idea: 'A fruit grower hears the trees answer a question nobody asked.',
            chapter_count: 1
        });
        const storyId = (created.body as StoryRow).id;

        expect((await call(world.app, 'DELETE', '/stories/story_999')).status).toBe(404);
        expect((await call(world.app, 'DELETE', `/stories/${storyId}`)).status).toBe(200);
        expect((await call(world.app, 'DELETE', `/stories/${storyId}`)).status).toBe(404);
    });
});
