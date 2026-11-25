// The two dashboard reads: the Story knowledge directory and the global employee roster.
import { describe, expect, it } from 'vitest';
import { buildStorylineRuntime } from './server';
import { seedChapter, seedGoal, seedStory } from '../run/mock';
import { Store } from '../store/store';

function makeRuntime() {
    const store = Store.empty();
    const story = seedStory(store);

    seedGoal(store, story.id);
    seedChapter(store, story.id);

    return { runtime: buildStorylineRuntime({ store, engineConfig: { autoSweep: false }, env: {} }), story };
}

describe('GET /stories/:id/knowledge', () => {
    it('answers the nine folders from the Story rows', async () => {
        const { runtime, story } = makeRuntime();

        const response = await runtime.app.request(`http://localhost/v1/storyline/stories/${story.id}/knowledge`);

        expect(response.status).toBe(200);

        const tree = (await response.json()) as {
            story_id: string;
            degraded: boolean;
            sections: Array<{ key: string; entries: Array<{ title: string; body: string; tags: string[] }> }>;
        };

        expect(tree.story_id).toBe(story.id);
        expect(tree.degraded).toBe(false);
        expect(tree.sections.map((section) => section.key)).toEqual([
            'research',
            'summary',
            'plotlines',
            'chapters',
            'cast',
            'continuity',
            'goal',
            'ideas',
            'findings'
        ]);

        const summary = tree.sections.find((section) => section.key === 'summary');
        expect(summary?.entries[0]?.body).toContain('mapped valley');

        const chapters = tree.sections.find((section) => section.key === 'chapters');
        expect(chapters?.entries[0]?.body).toContain('The ridge was where she had put the ridge.');

        // The empty folders are still in the response: the directory's shape is the story's shape.
        const cast = tree.sections.find((section) => section.key === 'cast');
        expect(cast?.entries[0]?.tags).toContain('placeholder');

        // §10 / §3.2 — the research folder exists on a Story the Researcher has not visited yet, and
        // it STATES the absence rather than disappearing (an empty research folder is information).
        const research = tree.sections.find((section) => section.key === 'research');
        expect(research?.entries).toEqual([
            {
                key: 'research:empty',
                title: 'Research',
                body: 'No research yet — the Researcher gathers the facts, places and sources the book depends on in phase ①.',
                tags: [`story:${story.id}`, 'section:research', 'entry:research:empty', 'placeholder']
            }
        ]);
    });

    it('refuses a Story that is not in the book before touching the knowledge store', async () => {
        const { runtime } = makeRuntime();

        const response = await runtime.app.request('http://localhost/v1/storyline/stories/story_999/knowledge');

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({
            error: 'no story named story_999 is in the book (P1: the store is the memory)'
        });
    });
});

describe('GET /agents', () => {
    it('lists the five global Story agents and their live thread count', async () => {
        const { runtime } = makeRuntime();

        const response = await runtime.app.request('http://localhost/v1/storyline/agents');

        expect(response.status).toBe(200);

        const listings = (await response.json()) as Array<{ kind: string; status: string; working: unknown[] }>;

        // §7.3 / U-8: the roster lists ALPHABETICALLY (T12/F1 — the route sorts the harness
        // catalogue projection, which appends the Researcher last).
        expect(listings.map((row) => row.kind)).toEqual(['critic', 'editor', 'reader', 'researcher', 'writer']);
        expect(listings.every((row) => row.status === 'idle' && row.working.length === 0)).toBe(true);
    });
});
