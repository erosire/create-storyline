// The per-story registry — the storage foundation every story-separated rule rests on:
//
//   * `<root>/stories/<uuid>/{store.json,journal.jsonl,harness/}` is the layout, and one Store is one story;
//   * child ids and journal sequences are STORY-LOCAL, so two stories may both hold `finding_0`;
//   * deleting a story removes its folder and changes not one byte of another story's files;
//   * an unvalidated id can never escape the `stories/` root (it is the directory name);
//   * the old flat layout is refused loudly, because this build has no migration and no backward compatibility.
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { StoryStores, type StoryCommit } from './story-stores';
import { STORY_ID_PATTERN, storyDirectoryPath, type StoreSnapshot } from './persist';
import { Store, type Attribution } from './store';
import type { Finding, Story } from '../../shared/types';

const AUTHOR: Attribution = { run_ref: null, author: true, why: 'author opens the book' };
const RUN_A: Attribution = { run_ref: 'run_1', why: 'editor raises a finding' };

// Fixed ids (the registry accepts any canonical UUID shape) keep every assertion exact.
const ID_A = '2f7c9a51-6a13-4bd6-9b1c-6c2b0d4b7a11';
const ID_B = '8b1d4c2e-0f77-4a3f-a2c5-9d1e6b8c4f22';
const ID_C = '5c0f3a9d-9b6e-4f42-8d7a-1e2b3c4d5e6f';

/** The id sequence a test injects, so created stories are addressable by exact string. */
const factory = (ids: string[]) => {
    let next = 0;

    return () => {
        const id = ids[next];

        next += 1;

        return id;
    };
};

/** A §4.1 Story payload, and the id the registry assigned is the only field that varies. */
function storyInit(title: string): Omit<Story, 'id' | 'rev' | 'created_at' | 'updated_at'> {
    return {
        title,
        phase: 'summary',
        idea: 'A cartographer returns to the valley she mapped as a girl and finds it redrawn by a reservoir.',
        summary_locked: false,
        plotlines_locked: false,
        pending_kind: 'none',
        status: 'ready',
        trend: 'unknown',
        auto_approve: ['critical', 'major'],
        author_stop: false,
        digest_rev: 0,
        template_refs: [],
        chapter_deps: {}
    };
}

/** A §4.11 Finding — the record whose id is the one two stories used to collide over. */
function findingInit(storyId: string, detail: string): Omit<Finding, 'id' | 'rev' | 'created_at' | 'updated_at'> {
    return {
        story_id: storyId,
        target_ref: 'chapter_0',
        criterion_ref: 'C-7',
        title: 'The reservoir is never paid off',
        detail,
        evidence: 'ch1 §3, ¶2',
        cost: 'major',
        fingerprint: `fp_${detail}`,
        state: 'unconfirmed',
        seen_count: 1
    };
}

/**
 * A scratch store root under the repo's own `Temp/` (never the OS temp — AGENTS.md — and never an
 * actual book). Each test gets its own directory so nothing here can read or delete a real story.
 */
async function scratch(): Promise<string> {
    const base = path.resolve(process.cwd(), 'Temp');

    await mkdir(base, { recursive: true });

    return mkdtemp(path.join(base, 'create-storyline-story-stores-'));
}

/** The whole durable footprint of one story: both files, verbatim, for byte-exact comparisons. */
async function footprint(root: string, storyId: string): Promise<{ store: string; journal: string }> {
    const dir = storyDirectoryPath(root, storyId);

    const read = async (file: string): Promise<string> => {
        try {
            return await readFile(path.join(dir, file), 'utf-8');
        } catch {
            // Absent is a value of its own: `''` says "this story has no such file", which a
            // before/after comparison must be able to tell apart from an emptied file.
            return '';
        }
    };

    return { store: await read('store.json'), journal: await read('journal.jsonl') };
}

/** `true` when a path does not exist — the delete assertions read better with it than with a try/catch. */
async function missing(target: string): Promise<boolean> {
    try {
        await readdir(target);

        return false;
    } catch {
        return true;
    }
}

describe('StoryStores — the layout', () => {
    it('creates `<root>/stories/<uuid>/` with store.json, journal.jsonl and harness/, and opens it as one Store', async () => {
        const root = await scratch();

        try {
            const registry = await StoryStores.open(root, { createStoryId: factory([ID_A]) });
            const created = await registry.create();

            expect(created.id).toBe(ID_A);
            expect(created.root).toBe(path.join(root, 'stories', ID_A));

            // The folder split is the story boundary, so the listing is exact, not incidental.
            expect(await readdir(path.join(root, 'stories'))).toEqual([ID_A]);
            expect((await readdir(created.root as string)).sort()).toEqual(['harness', 'store.json']);
            expect(STORY_ID_PATTERN.test(created.id)).toBe(true);

            // The story row carries the registry's UUID — `stories.create` cannot invent `story_0`.
            const story = created.store.stories.create(storyInit('Cold Mountain'), AUTHOR);

            expect(story.id).toBe(ID_A);
            expect(created.store.storyId).toBe(ID_A);

            await created.store.commit('author_seed', (tx) => {
                tx.findings.create(findingInit(ID_A, 'the opening is unfelt'), RUN_A);
            });
            await registry.close();

            const snapshot = JSON.parse(
                await readFile(path.join(created.root as string, 'store.json'), 'utf-8')
            ) as StoreSnapshot;

            expect(snapshot.story_id).toBe(ID_A);
            expect(snapshot.records.stories).toEqual([expect.objectContaining({ id: ID_A })]);
            expect(snapshot.records.findings).toEqual([expect.objectContaining({ id: 'finding_0', story_id: ID_A })]);

            const journal = await readFile(path.join(created.root as string, 'journal.jsonl'), 'utf-8');

            expect(journal.trim().split('\n')).toHaveLength(2);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('lists each entry as `{id, root, store}` and resolves `get`/`require`/`entry`/`rootOf` by UUID', async () => {
        const root = await scratch();

        try {
            const registry = await StoryStores.open(root, { createStoryId: factory([ID_A, ID_B]) });

            await registry.create();
            await registry.create();

            // Sorted by folder name at open time, and the second create() is still insertion-ordered here.
            expect(registry.ids()).toEqual([ID_A, ID_B]);
            expect(registry.list().map((entry) => [entry.id, entry.root])).toEqual([
                [ID_A, path.join(root, 'stories', ID_A)],
                [ID_B, path.join(root, 'stories', ID_B)]
            ]);
            expect(registry.list().map((entry) => entry.store.storyId)).toEqual([ID_A, ID_B]);
            expect(registry.get(ID_A)).toBe(registry.list()[0].store);
            expect(registry.entry(ID_B)?.id).toBe(ID_B);
            expect(registry.rootOf(ID_B)).toBe(path.join(root, 'stories', ID_B));
            expect(registry.has(ID_A)).toBe(true);
            expect(registry.has('story_1')).toBe(false);
            expect(registry.count()).toBe(2);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('reopens the same root with the same stories, counters and journals (L-3, per story)', async () => {
        const root = await scratch();

        try {
            const first = await StoryStores.open(root, { createStoryId: factory([ID_A, ID_B]) });

            for (const title of ['Cold Mountain', 'Salt Line']) await first.create();

            const [a, b] = [first.require(ID_A), first.require(ID_B)];

            a.stories.create(storyInit('Cold Mountain'), AUTHOR);
            a.findings.create(findingInit(ID_A, 'a1'), RUN_A);
            a.findings.create(findingInit(ID_A, 'a2'), RUN_A);

            b.stories.create(storyInit('Salt Line'), AUTHOR);
            b.findings.create(findingInit(ID_B, 'b1'), RUN_A);

            await first.close();

            const again = await StoryStores.open(root);

            expect(again.ids()).toEqual([ID_A, ID_B]);
            expect(again.list().map((entry) => entry.store.findings.list().map((row) => row.id))).toEqual([
                ['finding_0', 'finding_1'],
                ['finding_0']
            ]);

            // The counters survived per story: A continues at 2, B at 1. A shared counter — the old
            // flat layout — would have handed B `finding_2`.
            expect(again.require(ID_A).findings.create(findingInit(ID_A, 'a3'), RUN_A).id).toBe('finding_2');
            expect(again.require(ID_B).findings.create(findingInit(ID_B, 'b2'), RUN_A).id).toBe('finding_1');

            // And so did each story's own journal sequence, from its own store's initial state.
            expect(again.require(ID_A).journal.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
            expect(again.require(ID_B).journal.map((event) => event.seq)).toEqual([1, 2, 3]);

            await again.close();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('treats a missing `stories/` directory as a first boot with no stories', async () => {
        const root = await scratch();

        try {
            const registry = await StoryStores.open(root);

            expect(registry.list()).toEqual([]);
            expect(registry.ids()).toEqual([]);
            expect(await missing(path.join(root, 'stories'))).toBe(true);

            await registry.close();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('ignores a non-UUID sibling inside `stories/` instead of failing the whole root', async () => {
        const root = await scratch();

        try {
            await mkdir(path.join(root, 'stories', 'notes'), { recursive: true });

            const registry = await StoryStores.open(root, { createStoryId: factory([ID_A]) });

            await registry.create();

            expect(registry.ids()).toEqual([ID_A]);

            await registry.close();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

describe('StoryStores — two stories are two books', () => {
    it('keeps duplicate story-local child ids independent', async () => {
        const root = await scratch();

        try {
            const registry = await StoryStores.open(root, { createStoryId: factory([ID_A, ID_B]) });
            const a = await registry.create();
            const b = await registry.create();

            await a.store.commit('seed', (tx) => {
                tx.stories.create(storyInit('Cold Mountain'), AUTHOR);
                tx.findings.create(findingInit(ID_A, 'a1'), RUN_A);
            });
            await b.store.commit('seed', (tx) => {
                tx.stories.create(storyInit('Salt Line'), AUTHOR);
                tx.findings.create(findingInit(ID_B, 'b1'), RUN_A);
            });

            // Both stories hold `finding_0`; neither is the other's finding.
            expect([a.store.findings.list()[0].id, b.store.findings.list()[0].id]).toEqual(['finding_0', 'finding_0']);

            await a.store.commit('revise', (tx) => {
                tx.findings.update('finding_0', { detail: 'a1 revised' }, RUN_A);
            });

            expect(a.store.findings.require('finding_0').detail).toBe('a1 revised');
            expect(b.store.findings.require('finding_0').detail).toBe('b1');

            // Two journals, each its own story's history from seq 1.
            expect(a.store.journal.map((event) => event.seq)).toEqual([1, 2, 3]);
            expect(b.store.journal.map((event) => event.seq)).toEqual([1, 2]);
            expect(a.store.journal[2].commit_label).toBe('revise');

            // A scrap in one story cannot reach the other: the predicate runs against one collection.
            expect(a.store.findings.deleteWhere(() => true, AUTHOR)).toBe(1);
            expect(a.store.journal.map((event) => [event.seq, event.op])).toEqual([
                [1, 'create'],
                [2, 'create'],
                [3, 'update'],
                [4, 'delete']
            ]);
            expect(b.store.findings.list().map((row) => row.detail)).toEqual(['b1']);

            // A write naming the other story is refused, not parked in the wrong book.
            expect(() => b.store.findings.create(findingInit(ID_A, 'misfiled'), RUN_A)).toThrow(/one Store is one story/);

            await registry.close();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('deleting A removes only A: B keeps the same bytes and the same state', async () => {
        const root = await scratch();

        try {
            const registry = await StoryStores.open(root, { createStoryId: factory([ID_A, ID_B]) });
            const a = await registry.create();
            const b = await registry.create();

            for (const entry of [a, b]) {
                await entry.store.commit('seed', (tx) => {
                    tx.stories.create(storyInit(entry.id === ID_A ? 'Cold Mountain' : 'Salt Line'), AUTHOR);
                    tx.findings.create(findingInit(entry.id, 'open question'), RUN_A);
                });
            }

            await registry.persistAll();

            const before = await footprint(root, ID_B);

            expect(await registry.remove(ID_A)).toBe(true);

            // A is gone — folder and all, including its harness scratch.
            expect(await missing(storyDirectoryPath(root, ID_A))).toBe(true);
            expect(registry.ids()).toEqual([ID_B]);
            expect(registry.get(ID_A)).toBeUndefined();

            // B is untouched, byte for byte, and unchanged in memory.
            expect(await footprint(root, ID_B)).toEqual(before);
            expect(b.store.findings.require('finding_0').detail).toBe('open question');
            expect(b.store.journal.map((event) => event.seq)).toEqual([1, 2]);

            // A reopen sees exactly one story, and it is still B with its counter intact.
            await registry.close();

            const again = await StoryStores.open(root);

            expect(again.ids()).toEqual([ID_B]);
            expect(again.require(ID_B).findings.create(findingInit(ID_B, 'next'), RUN_A).id).toBe('finding_1');
            expect(await missing(storyDirectoryPath(root, ID_A))).toBe(true);

            await again.close();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('purges a story folder the registry never opened, and reports that it was not open', async () => {
        const root = await scratch();

        try {
            const registry = await StoryStores.open(root, { createStoryId: factory([ID_A]) });

            // A folder that appears after open() (a second process, or a scratch directory): the
            // purge still removes it, and the `false` says the registry never had it in memory.
            await mkdir(storyDirectoryPath(root, ID_B), { recursive: true });

            expect(await registry.remove(ID_B)).toBe(false);
            expect(await missing(storyDirectoryPath(root, ID_B))).toBe(true);
            expect(registry.ids()).toEqual([]);

            // An open story reports `true`, and its folder goes with it.
            const opened = await registry.create();

            expect(await registry.remove(opened.id)).toBe(true);
            expect(await missing(storyDirectoryPath(root, ID_A))).toBe(true);
            expect((await StoryStores.open(root)).ids()).toEqual([]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

describe('StoryStores — ids cannot escape the root', () => {
    it('refuses a malformed id before any path is built, and never creates a directory', async () => {
        const root = await scratch();

        try {
            const registry = await StoryStores.open(root);

            for (const bad of ['../evil', 'story_1', '', 'a/b', '../../etc', ID_A.toUpperCase() + 'x']) {
                await expect(registry.create(bad)).rejects.toThrow(/UUID/);
                expect(() => registry.require(bad)).toThrow(/UUID|is open/);
                await expect(registry.remove(bad)).rejects.toThrow(/UUID/);
            }

            expect(registry.ids()).toEqual([]);
            expect(await missing(path.join(root, 'stories'))).toBe(true);
            expect(await missing(path.resolve(root, '..', 'evil'))).toBe(true);

            await registry.close();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('refuses an id factory that does not produce a UUID', async () => {
        const root = await scratch();

        try {
            const registry = await StoryStores.open(root, { createStoryId: () => 'story_1' });

            await expect(registry.create()).rejects.toThrow(/is not a UUID/);
            expect(await missing(path.join(root, 'stories'))).toBe(true);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('refuses to open a folder whose store.json belongs to another story', async () => {
        const root = await scratch();

        try {
            // Hand-built, deliberately mismatched: folder `B`, binding `A`.
            const dir = storyDirectoryPath(root, ID_B);

            await mkdir(path.join(dir, 'harness'), { recursive: true });
            await writeFile(
                path.join(dir, 'store.json'),
                JSON.stringify({ version: 2, story_id: ID_A, counters: {}, records: {}, journal: [] })
            );

            await expect(StoryStores.open(root)).rejects.toThrow(
                `belongs to story ${ID_A}, not story ${ID_B}`
            );
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

describe('StoryStores — the old flat layout is not migrated', () => {
    it('fails clearly when `<root>/store.json` is still there', async () => {
        const root = await scratch();

        try {
            await writeFile(path.join(root, 'store.json'), JSON.stringify({ version: 1, counters: {}, records: {}, journal: [] }));

            let message = '';

            try {
                await StoryStores.open(root);
            } catch (error) {
                message = (error as Error).message;
            }

            expect(message).toContain(path.join(root, 'store.json'));
            expect(message).toContain('pre-per-story layout');
            expect(message).toContain('does not migrate');
            expect(message).toContain('stories/<uuid>/');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('fails clearly for a stray `<root>/journal.jsonl` too, naming both files when both are present', async () => {
        const root = await scratch();

        try {
            await writeFile(path.join(root, 'journal.jsonl'), '');

            await expect(StoryStores.open(root)).rejects.toThrow(`${path.join(root, 'journal.jsonl')} is the`);

            await writeFile(path.join(root, 'store.json'), '{}');

            let message = '';

            try {
                await StoryStores.open(root);
            } catch (error) {
                message = (error as Error).message;
            }

            expect(message).toContain(`${path.join(root, 'store.json')} and ${path.join(root, 'journal.jsonl')} are`);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

describe('StoryStores — commit fan-in', () => {
    it('fans every story commits through one subscription, including a story created after it', async () => {
        const root = await scratch();

        try {
            const registry = await StoryStores.open(root, { createStoryId: factory([ID_A, ID_B, ID_C]) });

            const seen: StoryCommit[] = [];

            const off = registry.onCommit((commit) => seen.push(commit));

            const a = await registry.create();
            const b = await registry.create();

            // A story created AFTER the subscription still feeds it — the SSE feed attaches once.
            const c = await registry.create();

            await a.store.commit('seed_a', (tx) => {
                tx.stories.create(storyInit('Cold Mountain'), AUTHOR);
                tx.findings.create(findingInit(ID_A, 'a1'), RUN_A);
            });
            await b.store.commit('seed_b', (tx) => {
                tx.stories.create(storyInit('Salt Line'), AUTHOR);
            });
            await c.store.commit('seed_c', (tx) => {
                tx.findings.create(findingInit(ID_C, 'c1'), RUN_A);
            });

            // One entry per commit GROUP, tagged with the story it happened in (the events alone are
            // ambiguous: two stories both journal `finding_0` at seq 2).
            expect(
                seen.map((commit) => [
                    commit.storyId,
                    commit.root,
                    commit.events.map((event) => [event.seq, event.commit_label, event.id])
                ])
            ).toEqual([
                [ID_A, path.join(root, 'stories', ID_A), [[1, 'seed_a', ID_A], [2, 'seed_a', 'finding_0']]],
                [ID_B, path.join(root, 'stories', ID_B), [[1, 'seed_b', ID_B]]],
                [ID_C, path.join(root, 'stories', ID_C), [[1, 'seed_c', 'finding_0']]]
            ]);

            off();

            await a.store.commit('after_unsubscribe', (tx) => {
                tx.findings.create(findingInit(ID_A, 'a2'), RUN_A);
            });

            expect(seen).toHaveLength(3);

            // A removed story stops emitting: its commits are no longer a story anyone can read.
            const off2 = registry.onCommit((commit) => seen.push(commit));

            await registry.remove(ID_B);
            await b.store.commit('orphan', (tx) => {
                tx.findings.create(findingInit(ID_B, 'b2'), RUN_A);
            });

            expect(seen).toHaveLength(3);
            off2();

            await registry.close();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('writes nothing anywhere in the in-memory registry, and still separates the stories', async () => {
        const registry = StoryStores.inMemory({ createStoryId: factory([ID_A, ID_B]) });

        const seen: string[] = [];

        registry.onCommit((commit) => seen.push(`${commit.storyId}:${commit.events.map((e) => e.seq).join('+')}`));

        const a = await registry.create();
        const b = await registry.create();

        expect(registry.root).toBeNull();
        expect([a.root, b.root]).toEqual([null, null]);

        await a.store.commit('seed', (tx) => {
            tx.stories.create(storyInit('Cold Mountain'), AUTHOR);
            tx.findings.create(findingInit(ID_A, 'a1'), RUN_A);
        });
        await b.store.commit('seed', (tx) => {
            tx.stories.create(storyInit('Salt Line'), AUTHOR);
            tx.findings.create(findingInit(ID_B, 'b1'), RUN_A);
        });

        expect(seen).toEqual([`${ID_A}:1+2`, `${ID_B}:1+2`]);
        expect(a.store.findings.require('finding_0').detail).toBe('a1');
        expect(b.store.findings.require('finding_0').detail).toBe('b1');

        await registry.persistAll();
        await registry.close();

        expect(a.store.findings.count()).toBe(1);
    });
});

describe('StoryStores — the registry is not a hidden global', () => {
    it('keeps two registries over the same root independent until one closes', async () => {
        const root = await scratch();

        try {
            const first = await StoryStores.open(root, { createStoryId: factory([ID_A]) });

            await first.create();
            await first.persistAll();

            const second = await StoryStores.open(root);

            expect(second.ids()).toEqual([ID_A]);
            expect(second.require(ID_A).stories.count()).toBe(0);

            // The same folder read twice; the flush that lands last is the one the next open sees.
            second.require(ID_A).stories.create(storyInit('Cold Mountain'), AUTHOR);
            await second.close();

            const third = await StoryStores.open(root);

            expect(third.require(ID_A).stories.list().map((row) => row.title)).toEqual(['Cold Mountain']);

            await first.close();
            await third.close();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('refuses to open the same story twice inside one registry', async () => {
        const root = await scratch();

        try {
            const registry = await StoryStores.open(root, { createStoryId: factory([ID_A]) });

            await registry.create();

            await expect(registry.create(ID_A)).rejects.toThrow(`story ${ID_A} is already open`);

            await registry.close();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('hands out the same Store instance per story, so `require` cannot fork state', async () => {
        const registry = StoryStores.inMemory({ createStoryId: factory([ID_A]) });

        const created = await registry.create();

        expect(registry.require(ID_A)).toBe(created.store);
        expect(registry.require(ID_A)).toBeInstanceOf(Store);
        expect(() => registry.require('nope-not-a-uuid')).toThrow(/UUID/);
    });
});
