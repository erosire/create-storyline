// The Story knowledge projection: the directory the browser reads, and the durability the
// Author asked for (a destroyed session must not take the knowledge with it).
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../store/store';
import { StoryKnowledge } from './story-knowledge';

const attribution = { author: true, why: 'fixture: a book is made of records (P1)' };

function seedStory(store: Store) {
    const story = store.stories.create(
        {
            title: 'Hollow Sea',
            phase: 'chapters',
            idea: 'a disgraced cartographer must map the sea that ate her fleet, and the sea remembers her name',
            summary_locked: true,
            plotlines_locked: true,
            pending_kind: 'none',
            status: 'ready',
            trend: 'improving',
            auto_approve: ['critical', 'major'],
            author_stop: false,
            digest_rev: 0,
            template_refs: [],
            chapter_deps: {}
        },
        attribution
    );

    store.summaries.create(
        {
            story_id: story.id,
            chapter_count: 2,
            premise: 'A cartographer maps a sea that remembers the fleet it swallowed.',
            theme: 'the map is not the territory, and the territory remembers',
            locked: true
        },
        attribution
    );

    store.plotlines.create(
        {
            story_id: story.id,
            order: 1,
            heading: 'The sounding line',
            must_happen: 'She sounds a trench that is not on any chart.',
            must_change: 'She learns the sea is answering her.',
            contract_locked: true,
            aligned: true,
            needs_recheck: false
        },
        attribution
    );

    store.chapters.create(
        {
            story_id: story.id,
            order: 1,
            title: 'First Sounding',
            summary: 'The fleet is gone; the chart is not.',
            sections: [
                {
                    id: 'section_1_1',
                    text: 'The rope went down and did not come back.',
                    origin: 'writer'
                }
            ],
            state: 'done',
            author_locked: false,
            round: 1,
            last_score: '2/3'
        },
        attribution
    );

    store.chapters.create(
        {
            story_id: story.id,
            order: 2,
            title: 'Long Sounding',
            sections: [{ id: 'section_2_1', text: 'wave '.repeat(2_000), origin: 'writer' }],
            state: 'in_review',
            author_locked: false,
            round: 1
        },
        attribution
    );

    store.cast.create(
        {
            story_id: story.id,
            name: 'Ilsa Vane',
            want: 'a chart that is true',
            need: 'to be forgiven by the sea',
            arc: 'cartographer → witness',
            state_now: 'alone on a borrowed boat'
        },
        attribution
    );

    store.goals.create(
        {
            story_id: story.id,
            title: 'the book as the Author wants it',
            threshold_soft: 2,
            criteria: [
                {
                    id: 'C-0',
                    label: 'the declared chapter count is met',
                    question: 'Does the chapter set match the declared count?',
                    checker: 'code',
                    hard: true,
                    fix_hint: 'Write the missing chapters.'
                }
            ],
            flat_rounds: 4,
            regress_tolerance: 2
        },
        attribution
    );

    return story;
}

describe('StoryKnowledge — the durable directory', () => {
    it('projects the book into the eight folders without recomputing anything client-side', () => {
        const store = Store.empty();
        const story = seedStory(store);
        const knowledge = StoryKnowledge.memory(store);

        const tree = knowledge.tree(story.id);

        expect(tree).not.toBeNull();
        expect(tree?.sections.map((section) => section.key)).toEqual([
            'summary',
            'plotlines',
            'chapters',
            'cast',
            'continuity',
            'goal',
            'ideas',
            'findings'
        ]);
        expect(tree?.degraded).toBe(false);

        const summary = tree?.sections.find((section) => section.key === 'summary');
        expect(summary?.entries[0]?.title).toBe('Overview');
        expect(summary?.entries[0]?.body).toContain('A cartographer maps a sea');

        const chapters = tree?.sections.find((section) => section.key === 'chapters');
        expect(chapters?.entries[0]?.title).toBe('Chapter 1 · First Sounding');
        expect(chapters?.entries[0]?.body).toContain('The rope went down');

        // The engine caps one paragraph at 4000 characters; a long chapter is clipped with a
        // sentence that names where the full prose still lives, never refused by the store.
        const long = chapters?.entries.find((entry) => entry.title.includes('Long Sounding'));
        expect(long?.body.length).toBeLessThan(3_950);
        expect(long?.body).toContain('truncated');

        const cast = tree?.sections.find((section) => section.key === 'cast');
        expect(cast?.entries[0]?.title).toBe('Ilsa Vane');

        // An empty folder is still a folder: the shape of a story is visible before its prose.
        const ideas = tree?.sections.find((section) => section.key === 'ideas');
        expect(ideas?.entries[0]?.tags).toContain('placeholder');
        expect(ideas?.entries[0]?.body).toContain('Ideas tray is empty');
    });

    it('survives a closed knowledge handle: a second store reads the same articles from disk', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'storyline-knowledge-'));

        try {
            const store = Store.empty();
            const story = seedStory(store);
            const first = await StoryKnowledge.open(store, root);

            expect(first.directory).not.toBeNull();
            expect(first.tree(story.id)?.sections.find((section) => section.key === 'summary')).toBeTruthy();
            await first.flush();
            await first.close();

            // The durable files are the harness's own layout: `<root>/harness/knowledge/`.
            const index = path.join(root, 'harness', 'knowledge', 'index.json');
            expect((await stat(index)).isFile()).toBe(true);

            // A fresh engine over the same root sees the articles even though the first handle
            // (and the book it was projecting) is gone.
            const reopened = await StoryKnowledge.open(Store.empty(), root);
            const articles = reopened.knowledgeEngine.snapshot().articles;

            expect(articles.length).toBeGreaterThanOrEqual(8);
            expect(articles.some((article) => article.title === 'Hollow Sea — Summary')).toBe(true);
            expect(articles.some((article) => article.title === 'Hollow Sea — Chapters')).toBe(true);

            await reopened.close();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
