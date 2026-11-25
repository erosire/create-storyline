// S-RUNTIME — one runtime per Story: the isolation the workspace owes between books (A-RUNTIME acceptance).
//
// WHAT IS REAL HERE: the shipped `Store`, `StoryStores` registry, `ServerConfig` app book, `RunExecutor`,
// `LoopEngine`, criteria engine, Digest builder and tool runtime — the same objects
// `api/server.ts:openStorylineRuntime` composes — driven through `StoryRuntimes` directly rather than through
// the transport. The only double is the model (`llm/mock.ts:MockChatClient`), which this layer stores and
// never interprets.
//
// WHY EXACT VALUES: the claim of the layout is that a Story's memory is ITS book, so "one runtime", "the same
// catalogue", "one ceiling" and "no cross-talk" are countable facts with known answers. Every expectation below
// is a pinned array, id or sentence — several are quoted from the shipped errors, because an Author reads those.
//
// THE CLOCK: no case lets the sweep timer fire. Every workspace opens with `engineConfig.sweepIntervalMs` far
// longer than the test, so `start()` can wire the engines (the coordinator owns the one timer, and `sweepAll`
// skips engines it never started) while every sweep asserted here is one the test asked for by name.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CriteriaEngine } from '../criteria/engine';
import { DigestBuilder } from '../digest/digest';
import { MockChatClient } from '../llm/mock';
import { LOOP_CEILING_SETTING } from '../loop/ceiling';
import { LoopEngine } from '../loop/engine';
import { AGENT_MODELS_SETTING } from '../run/agent-models';
import { RunExecutor } from '../run/executor';
import { BUILT_IN_TEMPLATES } from '../templates';
import { SERVER_DIRECTORY, STORIES_DIRECTORY, Store, StoryLayoutError, isRecordUid, type Attribution } from '../store';
import { StoryStores } from '../store/story-stores';
import { StoreError } from '../store/store';
import { createToolRuntime } from '../tools/context';
import type { Finding, Run, Story, Template } from '../../shared/types';
import type { StoryThreadRecord } from '../run/thread-log';
import { ServerConfig } from './server-config';
import { SHARED_STORE_ID, StoryRuntimes } from './story-runtimes';

/**
 * The app book's template ids, DERIVED rather than literal.
 *
 * `seedCatalogue` creates the built-ins through `Collection.create`, which mints `template_0 …` in
 * catalogue order and ignores each row's slug-shaped `id` — so the app catalogue's ids are exactly the
 * first `BUILT_IN_TEMPLATES.length` counter ids, the last built-in is `template_${N-1}`, and the first row
 * an Author adds is `template_${N}`. R-lock (D-69) added the `editor-group-lock` crew, which moved every
 * literal in this file by one; the rule is pinned HERE once so the next built-in costs no test edit, while
 * the catalogue's shape and order stay pinned by `templates/templates.test.ts`.
 */
const BUILT_IN_APP_IDS = BUILT_IN_TEMPLATES.map((_, index) => `template_${index}`);
const LAST_BUILT_IN_APP_ID = `template_${BUILT_IN_TEMPLATES.length - 1}`;
const FIRST_AUTHOR_MINTED_ID = `template_${BUILT_IN_TEMPLATES.length}`;

// --------------------------------------------------------------------------------
// The fixtures
// --------------------------------------------------------------------------------

// Fixed UUIDs keep every id assertion exact: the folder name IS the id, so a literal here is a literal on
// disk. `store/story-stores.test.ts` uses the same set for the same reason.
const ID_A = '2f7c9a51-6a13-4bd6-9b1c-6c2b0d4b7a11';
const ID_B = '8b1d4c2e-0f77-4a3f-a2c5-9d1e6b8c4f22';
const ID_C = '5c0f3a9d-9b6e-4f42-8d7a-1e2b3c4d5e6f';

const AUTHOR: Attribution = { run_ref: null, author: true, why: 'the Author writes in the book' };

const IDEA_A = 'A lighthouse keeper starts answering letters written by a ship that sank in her bay.';
const IDEA_B = 'A cartographer returns to the valley she mapped as a girl and finds it redrawn by a reservoir.';
const IDEA_C = 'A beekeeper walks the last unmapped hedgerow in the county, one contract at a time.';

/** The §4.1 Story payload for an unbound book (a story-bound book overrides `id` with its own UUID). */
function storyInit(title: string): Omit<Story, 'id' | 'rev' | 'created_at' | 'updated_at'> {
    return {
        title,
        phase: 'summary',
        idea: IDEA_A,
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

/** A §4.11 Finding — the record whose id two books used to collide over. */
function findingInit(storyId: string, detail: string): Omit<Finding, 'id' | 'rev' | 'created_at' | 'updated_at'> {
    return {
        story_id: storyId,
        target_ref: 'chapter_0',
        criterion_ref: 'C-7',
        title: 'The bay is never paid off',
        detail,
        evidence: 'ch1 §3, ¶2',
        cost: 'major',
        fingerprint: `fp_${detail}`,
        state: 'unconfirmed',
        seen_count: 1
    };
}

/** A live thread the shared ceiling has to count: a `working` row is what `liveRuns` reads (L-2). */
function runInit(storyId: string, index: number): Omit<Run, 'id' | 'rev' | 'created_at' | 'updated_at'> {
    return {
        story_id: storyId,
        work_item_ref: `wi_review_summary_a${index}`,
        role: 'critic',
        state: 'working',
        started_at: '2026-11-24T10:00:00.000Z',
        tokens: 1000 * index,
        kind: 'work',
        delegated: []
    };
}

/** A crew payload from an app row, with the store-assigned bookkeeping stripped (`templates.create`'s input). */
function crewCopy(row: Template, name: string): Omit<Template, 'id' | 'rev' | 'created_at' | 'updated_at'> {
    const clone = JSON.parse(JSON.stringify(row)) as Record<string, unknown>;

    delete clone.id;
    delete clone.rev;
    delete clone.created_at;
    delete clone.updated_at;
    clone.name = name;

    return clone as Omit<Template, 'id' | 'rev' | 'created_at' | 'updated_at'>;
}

/** A journal as an Author's audit reads it: the sequence, the write, the record — and nothing else. */
const journalRows = (store: Store): Array<[number, string, string, string]> =>
    store.journal.map((event) => [event.seq, event.collection, event.op, event.id]);

// SUMMARY PHRASE R1: the three phrase collections (`phrases`, `phrase_groups`, `group_revisions`) are
// ADDRESSed by uid, not by the per-book counter (`store/store.ts` says why: a group id is named by a
// route, by a finding's `group_refs` and by every `group_revisions.group_id`, so it has to be mintable
// before the row exists). This case is about ids being STORY-LOCAL, so it pins the two kinds
// separately: the counter-minted ids stay literal, and the uid-addressed ones are named by kind here
// and pinned as real uids — and as ids the OTHER book does not have — just below.
const uidAddressed = (collection: string) =>
    collection === 'phrases' || collection === 'phrase_groups' || collection === 'group_revisions';

const journalShape = (store: Store) =>
    journalRows(store).map(([seq, collection, op, id]) => [seq, collection, op, uidAddressed(collection) ? '<uid>' : id]);

/** The id sequence a case injects into the registry, so created Stories are addressable by exact string. */
const factory = (ids: string[]) => {
    let next = 0;

    return () => ids[next++];
};

/** The model every run here gets: one prose answer, whatever the brief asks for. */
const stubChat = () =>
    new MockChatClient(() => ({
        message: { content: 'The watchtower stood over the pass, and the map it was built from was wrong.' }
    }));

// Scratch roots live in the package's own `Temp/` (AGENTS.md: never the OS temp), one per case, removed after.
let scratchIndex = 0;

const scratch = (label: string): string => {
    const root = path.resolve(process.cwd(), 'Temp', `story-isolation-${label}-${process.pid}-${scratchIndex++}`);

    mkdirSync(root, { recursive: true });

    return root;
};

const removeRoot = (root: string): void => rmSync(root, { recursive: true, force: true });

/**
 * Everything a sweep report promises EXCEPT its wall-clock stamp: an idle workspace's pass is fully
 * predictable, and `at` is the only field that cannot be an exact literal.
 */
const idleOf = (report: { stories: unknown; runs_started: number; runs_finished: number; leases_lapsed: string[]; skipped: boolean }): unknown[] => [
    report.stories,
    report.runs_started,
    report.runs_finished,
    report.leases_lapsed,
    report.skipped
];

/** Every Story book directory under a store root, in the sorted order the registry loads them. */
const bookDirs = (root: string): string[] => readdirSync(path.join(root, STORIES_DIRECTORY)).sort();

/** The three files one Story book is made of — the layout, asserted as a set so a stray file is visible. */
const BOOK_FILES = ['harness', 'journal.jsonl', 'store.json'];

const bookFiles = (root: string, storyId: string): string[] =>
    readdirSync(path.join(root, STORIES_DIRECTORY, storyId)).sort();

const journalText = (root: string, storyId: string): string =>
    readFileSync(path.join(root, STORIES_DIRECTORY, storyId, 'journal.jsonl'), 'utf-8');

/** The bytes one Story book is stored in — the whole point of "nothing else moved" being assertable. */
const bookText = (root: string, storyId: string, file: string): string =>
    readFileSync(path.join(root, STORIES_DIRECTORY, storyId, file), 'utf-8');

/** What is in one Story's `harness/` directory (its knowledge articles and its retained threads). */
const harnessFiles = (root: string, storyId: string): string[] =>
    readdirSync(path.join(root, STORIES_DIRECTORY, storyId, 'harness')).sort();

const storyPathOf = (root: string, storyId: string): string => path.join(root, STORIES_DIRECTORY, storyId);

/** One retained thread, field-for-field what `run/thread-log.ts` appends, so the log has something to lose. */
function threadRecord(storyId: string, threadId: string): StoryThreadRecord {
    return {
        thread_id: threadId,
        run_id: 'run_0',
        story_id: storyId,
        story_title: 'Lighthouse',
        phase: 'summary',
        role: 'critic',
        role_name: 'critic',
        title: 'Read the Summary against the Goal',
        state: 'torn_down',
        started_at: '2026-11-24T10:00:00.000Z',
        ended_at: '2026-11-24T10:00:02.000Z',
        tokens: 120,
        request: 'Read the Summary against the Goal and report what is missing.',
        answer: 'The bay is never paid off.',
        retained: true
    };
}

/**
 * A workspace over one store root: the registry (with the Story ids this case asked for) plus the runtime
 * coordinator over it and the app book at `<root>/server/` — the composition `openStorylineRuntime` builds.
 */
const openWorkspace = async (
    root: string,
    options: { storyIds?: string[]; engineConfig?: Record<string, unknown>; config?: ServerConfig } = {}
) => {
    const stories = await StoryStores.open(root, {
        ...(options.storyIds === undefined ? {} : { createStoryId: factory(options.storyIds) })
    });
    const runtimes = await StoryRuntimes.open({
        stories,
        config: options.config ?? (await ServerConfig.open(root)),
        chat: stubChat(),
        engineConfig: { autoSweep: false, sweepIntervalMs: 60_000, ...options.engineConfig }
    });

    return { stories, runtimes };
};

// --------------------------------------------------------------------------------
// 1. One isolated context per Story book
// --------------------------------------------------------------------------------

describe('StoryRuntimes keeps one isolated context per Story book', () => {
    it('gives each Story its own book, engine, executor, projection and thread log — never another Story’s', async () => {
        const root = scratch('one-per-story');

        try {
            const { runtimes } = await openWorkspace(root, { storyIds: [ID_A, ID_B] });

            expect(await runtimes.createStory({ idea: IDEA_A, title: 'Lighthouse' })).toEqual({ story_id: ID_A });
            expect(await runtimes.createStory({ idea: IDEA_B, title: 'Reservoir' })).toEqual({ story_id: ID_B });

            expect(runtimes.count()).toBe(2);

            // Book order is the order the Stories panel lists and the order the sweep fans in.
            expect(runtimes.contexts_().map((context) => context.storyId)).toEqual([ID_A, ID_B]);
            expect(runtimes.books().map((book) => book.id)).toEqual([ID_A, ID_B]);

            const storeA = runtimes.storeFor(ID_A) as Store;
            const storeB = runtimes.storeFor(ID_B) as Store;
            const stores = runtimes.stores();

            expect(stores).toHaveLength(2);
            expect(stores[0]).toBe(storeA);
            expect(stores[1]).toBe(storeB);

            const contextA = runtimes.requires(ID_A);
            const contextB = runtimes.requires(ID_B);

            // Every per-Story object is its own object: sharing any one of them is how two Stories end up
            // reading one engine's state, one executor's harness sessions or one projection's articles.
            expect(contextA.store).not.toBe(contextB.store);
            expect(contextA.engine).not.toBe(contextB.engine);
            expect(contextA.executor).not.toBe(contextB.executor);
            expect(contextA.runtime).not.toBe(contextB.runtime);
            expect(contextA.knowledge).not.toBe(contextB.knowledge);
            expect(contextA.threadLog).not.toBe(contextB.threadLog);
            expect(contextA.harness).not.toBe(contextB.harness);

            // Each engine acts on its own book, and each context's files live inside that book's folder.
            // `StoryRuntimeContext.store` is the book the engine and executor were built over; `LoopEngine`'s
            // own store field is private, so the context is the seam that proves the wiring.
            expect(contextA.store).toBe(storeA);
            expect(contextB.store).toBe(storeB);
            expect(contextA.root).toBe(path.join(root, STORIES_DIRECTORY, ID_A));
            expect(contextB.root).toBe(path.join(root, STORIES_DIRECTORY, ID_B));
            expect(bookDirs(root)).toEqual([ID_A, ID_B]);
            expect(bookFiles(root, ID_A)).toEqual(BOOK_FILES);

            // The Story row is the Story the folder was made for: a bound book cannot mint another id.
            expect(storeA.stories.list().map((row) => [row.id, row.idea])).toEqual([[ID_A, IDEA_A]]);
            expect(storeB.stories.list().map((row) => [row.id, row.idea])).toEqual([[ID_B, IDEA_B]]);

            // An id that is not an open book has no runtime and no store — the route's 404 sentence.
            expect(runtimes.contextOf(ID_C)).toBeUndefined();
            expect(runtimes.storeFor(ID_C)).toBeUndefined();
            expect(() => runtimes.requires(ID_C)).toThrow(
                `no story ${ID_C} has a runtime here — every Story is its own stories/<uuid>/ book, and an id ` +
                    `from another book has no runtime to act in`
            );

            await runtimes.close();
        } finally {
            removeRoot(root);
        }
    });
});

// --------------------------------------------------------------------------------
// 2. A write in one book lands in that book only
// --------------------------------------------------------------------------------

describe('A write in one Story book changes nothing in another', () => {
    it('keeps child ids, journals and files Story-local, so both books hold their own `finding_0`', async () => {
        const root = scratch('write-isolation');

        try {
            const { runtimes } = await openWorkspace(root, { storyIds: [ID_A, ID_B] });

            await runtimes.createStory({ idea: IDEA_A });
            await runtimes.createStory({ idea: IDEA_B });

            const bookA = runtimes.storeFor(ID_A) as Store;
            const bookB = runtimes.storeFor(ID_B) as Store;

            // §15 step 0 in each book wrote the SAME child ids under DIFFERENT stories, each from its own
            // counter at 0 — the flat layout's single counter could not have produced `summary_0` twice.
            //
            // The Summary Phrase's catalog rows are in this sequence now (R1: `createStory` opens the
            // Phrase and its five groups in the SAME commit as the Story): one phrase create, the five
            // group creates in CATALOG ORDER, and the phrase's content update — then the Goal, and the
            // Story update that closes the commit. The uid ids are named by kind here because they are
            // random per book; the next block pins them as uids the other book does not hold.
            expect(journalShape(bookA)).toEqual([
                [1, 'stories', 'create', ID_A],
                [2, 'summaries', 'create', 'summary_0'],
                [3, 'phrases', 'create', '<uid>'],
                [4, 'phrase_groups', 'create', '<uid>'],
                [5, 'phrase_groups', 'create', '<uid>'],
                [6, 'phrase_groups', 'create', '<uid>'],
                [7, 'phrase_groups', 'create', '<uid>'],
                [8, 'phrase_groups', 'create', '<uid>'],
                [9, 'phrases', 'update', '<uid>'],
                [10, 'goals', 'create', 'goal_0'],
                [11, 'stories', 'update', ID_A]
            ]);
            expect(journalShape(bookB)).toEqual([
                [1, 'stories', 'create', ID_B],
                [2, 'summaries', 'create', 'summary_0'],
                [3, 'phrases', 'create', '<uid>'],
                [4, 'phrase_groups', 'create', '<uid>'],
                [5, 'phrase_groups', 'create', '<uid>'],
                [6, 'phrase_groups', 'create', '<uid>'],
                [7, 'phrase_groups', 'create', '<uid>'],
                [8, 'phrase_groups', 'create', '<uid>'],
                [9, 'phrases', 'update', '<uid>'],
                [10, 'goals', 'create', 'goal_0'],
                [11, 'stories', 'update', ID_B]
            ]);
            // The uid half of the same claim: both books hold the five CATALOG groups, and not one of
            // A's addresses appears in B — a uid is Story-local in exactly the way `summary_0` is, and
            // it is the id the routes, findings and run rows will name from here on.
            expect([...bookA.phrases.list().map((row) => row.id), ...bookA.phraseGroups.list().map((row) => row.id)]).toHaveLength(6);
            expect(bookA.phraseGroups.list().map((row) => row.key)).toEqual([
                'premise',
                'promise',
                'theme',
                'tone',
                'ending'
            ]);
            expect(bookB.phraseGroups.list().map((row) => row.key)).toEqual([
                'premise',
                'promise',
                'theme',
                'tone',
                'ending'
            ]);

            const catalogA = new Set([
                ...bookA.phrases.list().map((row) => row.id),
                ...bookA.phraseGroups.list().map((row) => row.id)
            ]);
            const catalogB = [
                ...bookB.phrases.list().map((row) => row.id),
                ...bookB.phraseGroups.list().map((row) => row.id)
            ];

            expect(Array.from(catalogA).every(isRecordUid)).toBe(true);
            expect(catalogB.filter((id) => catalogA.has(id))).toEqual([]);
            expect(bookA.stories.list().map((row) => row.id)).toEqual([ID_A]);
            expect(bookB.stories.list().map((row) => row.id)).toEqual([ID_B]);

            // A write in A appends to A's journal and moves B's by nothing at all.
            await bookA.commit('seed_finding', (tx) => { tx.findings.create(findingInit(ID_A, 'a1'), AUTHOR); });

            expect(journalRows(bookA).slice(11)).toEqual([[12, 'findings', 'create', 'finding_0']]);
            expect(journalRows(bookB)).toHaveLength(11);
            expect(bookB.findings.list()).toEqual([]);

            // B mints its own `finding_0` — the collision the shared journal used to resolve by renumbering.
            await bookB.commit('seed_finding', (tx) => { tx.findings.create(findingInit(ID_B, 'b1'), AUTHOR); });

            expect(bookA.findings.list().map((row) => [row.id, row.story_id, row.detail])).toEqual([
                ['finding_0', ID_A, 'a1']
            ]);
            expect(bookB.findings.list().map((row) => [row.id, row.story_id, row.detail])).toEqual([
                ['finding_0', ID_B, 'b1']
            ]);

            // Each counter continues in its own book: A goes to `finding_1`, B is still at one row.
            await bookA.commit('seed_finding', (tx) => { tx.findings.create(findingInit(ID_A, 'a2'), AUTHOR); });

            expect(bookA.findings.list().map((row) => row.id)).toEqual(['finding_0', 'finding_1']);
            expect(bookB.findings.list().map((row) => row.id)).toEqual(['finding_0']);
            // 13 = the create commit's 11 rows (4, plus the 7 the Summary Phrase's catalog adds — R1)
            // plus A's two findings; B's 12 is the same shape with one finding. Both counters continue in
            // their own book, which is the claim this case exists for.
            expect(bookA.journal.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
            expect(bookB.journal.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

            // And the book refuses another Story's row outright, so a mis-routed write cannot even be
            // attempted: P1's fence is what makes the isolation structural rather than a convention.
            expect(() => bookB.findings.create(findingInit(ID_A, 'written-in-the-wrong-book'), AUTHOR)).toThrow(
                new StoreError(
                    `findings names story ${ID_A}, but this store is story ${ID_B} — one Store is one story, ` +
                        `so another story's records live in their own stories/<uuid>/ folder`
                )
            );

            await runtimes.close();

            // On disk: each book's journal holds exactly its own events, and neither file mentions the
            // other Story's id — no shared log, no shared column, nothing to filter. The two counts match
            // the in-memory journals above, catalog rows included (R1 writes them in the create commit).
            expect(journalText(root, ID_A).trim().split('\n')).toHaveLength(13);
            expect(journalText(root, ID_B).trim().split('\n')).toHaveLength(12);
            expect(journalText(root, ID_A)).not.toContain(ID_B);
            expect(journalText(root, ID_B)).not.toContain(ID_A);
        } finally {
            removeRoot(root);
        }
    });
});

// --------------------------------------------------------------------------------
// 3. The app catalogue configures every book, and follows the app's edits
// --------------------------------------------------------------------------------

describe('The app book configures every Story book', () => {
    it('seeds the built-ins once into the app book and copies them under the app row ids', async () => {
        const root = scratch('catalogue-copy');

        try {
            const config = await ServerConfig.open(root);

            expect(config.directory()).toBe(path.join(root, SERVER_DIRECTORY));
            expect(config.templates()).toEqual([]);

            const { runtimes } = await openWorkspace(root, { storyIds: [ID_A, ID_B], config });

            // One app book per workspace holds the catalogue — not one copy per Story.
            const appRows = config.templates();

            expect(appRows.map((row) => row.name)).toEqual(BUILT_IN_TEMPLATES.map((row) => row.name));
            expect(appRows.map((row) => row.builtin)).toEqual(BUILT_IN_TEMPLATES.map(() => true));

            await runtimes.createStory({ idea: IDEA_A });
            await runtimes.createStory({ idea: IDEA_B });

            // Each book carries the app rows under the app's OWN ids. A copy that minted its own number would
            // fork the roster: `assignTemplates` reports the ids the Author reads in the app catalogue.
            const appIds = appRows.map((row) => row.id);

            expect(appIds).toEqual(BUILT_IN_APP_IDS);

            for (const storyId of [ID_A, ID_B]) {
                const store = runtimes.storeFor(storyId) as Store;

                expect(store.templates.list().map((row) => row.id)).toEqual(appIds);
                expect(store.templates.list().map((row) => [row.name, row.title, row.rev])).toEqual(
                    appRows.map((row) => [row.name, row.title, row.rev])
                );
            }

            // A crew the Author adds to the app reaches every open book on the next sync, with the app's id,
            // and `syncConfig` answers with exactly the books whose content changed.
            const crew = config.book.templates.create(
                { ...crewCopy(appRows[0], 'author-cartographers'), builtin: false, editable: true },
                AUTHOR
            );

            expect(crew.id).toBe(FIRST_AUTHOR_MINTED_ID);
            expect(runtimes.syncConfig()).toEqual([ID_A, ID_B]);

            for (const storyId of [ID_A, ID_B]) {
                const store = runtimes.storeFor(storyId) as Store;
                const copy = store.templates.get(crew.id);

                expect([copy?.id, copy?.name, copy?.title, copy?.rev]).toEqual([
                    FIRST_AUTHOR_MINTED_ID,
                    'author-cartographers',
                    appRows[0].title,
                    1
                ]);
            }

            // Syncing twice is a no-op: a book that already matches is neither rewritten nor reported.
            expect(runtimes.syncConfig()).toEqual([]);

            // Editing the app row moves the copies, because a copy is the app row's shadow, not a fork.
            const edited = config.book.templates.update(
                crew.id,
                { title: 'The Surveyors' },
                { ...AUTHOR, why: 'the Author retitled the crew' }
            );

            expect(edited.rev).toBe(2);
            expect(runtimes.syncConfig()).toEqual([ID_A, ID_B]);

            for (const storyId of [ID_A, ID_B]) {
                const copy = (runtimes.storeFor(storyId) as Store).templates.get(crew.id);

                expect([copy?.title, copy?.rev]).toEqual(['The Surveyors', 2]);
            }

            // A Story's own edit to one of its copies is a fork, and it survives every sync: `applyTo`
            // refreshes only a copy that sits BEHIND the app row, so the book's own rev-2 row is its own.
            // (`Collection.create` cannot mint a fork here: a Story book's template counter is behind the
            // app's ids, which is the id-collision hazard the copy rule exists to avoid.)
            const forked = (runtimes.storeFor(ID_A) as Store).templates.update(
                appIds[appIds.length - 1],
                { name: 'lighthouse-only', title: 'The Lighthouse Pool' },
                { ...AUTHOR, why: 'this Story renamed the crew it was assigned' }
            );

            expect([forked.id, forked.name, forked.rev]).toEqual([LAST_BUILT_IN_APP_ID, 'lighthouse-only', 2]);
            expect(runtimes.syncConfig()).toEqual([]);

            const copyA = (runtimes.storeFor(ID_A) as Store).templates.get(appIds[appIds.length - 1]);
            const copyB = (runtimes.storeFor(ID_B) as Store).templates.get(appIds[appIds.length - 1]);

            expect([copyA?.name, copyA?.title]).toEqual(['lighthouse-only', 'The Lighthouse Pool']);
            expect([copyB?.name, copyB?.title]).toEqual([appRows[appRows.length - 1].name, appRows[appRows.length - 1].title]);

            // The app editing that same crew does not reach the Story that rewrote it, but it does reach the
            // Story that left its copy alone.
            config.book.templates.update(
                appIds[appIds.length - 1],
                { title: 'The Roster Pool' },
                { ...AUTHOR, why: 'the Author retitled the built-in' }
            );

            expect(runtimes.syncConfig()).toEqual([ID_B]);
            expect(
                (runtimes.storeFor(ID_B) as Store).templates.get(appIds[appIds.length - 1])?.title
            ).toBe('The Roster Pool');
            expect(
                (runtimes.storeFor(ID_A) as Store).templates.get(appIds[appIds.length - 1])?.title
            ).toBe('The Lighthouse Pool');

            await runtimes.close();
        } finally {
            removeRoot(root);
        }
    });

    it('mirrors the host settings into every book and lets the app value always win', async () => {
        const root = scratch('host-settings');

        try {
            const config = await ServerConfig.open(root);

            config.setAgentModel('writer', 'gpt-author-one');
            config.setGlobalMaxConcurrent(5);

            const { runtimes } = await openWorkspace(root, { storyIds: [ID_A, ID_B], config });

            await runtimes.createStory({ idea: IDEA_A });
            await runtimes.createStory({ idea: IDEA_B });

            // The roster and the ceiling are host truth, so each book carries the app's value verbatim.
            for (const storyId of [ID_A, ID_B]) {
                const store = runtimes.storeFor(storyId) as Store;

                expect(store.setting(AGENT_MODELS_SETTING)).toEqual({ writer: 'gpt-author-one' });
                expect(store.setting(LOOP_CEILING_SETTING)).toBe(5);
            }

            // The live ceiling is ONE number for the process, reported across the books it arbitrates.
            expect(runtimes.ceilingView).toEqual({ limit: 5, live_runs: 0, stories: 2 });

            // Moving it moves the app book, the shared ceiling and every engine's own number at once, so a
            // context taken on its own cannot quietly keep dispatching against the old cap.
            runtimes.setGlobalMaxConcurrent(2);

            expect(runtimes.ceilingView).toEqual({ limit: 2, live_runs: 0, stories: 2 });
            expect(runtimes.config.globalMaxConcurrent).toBe(2);
            expect(config.getGlobalMaxConcurrent()).toBe(2);
            expect(runtimes.contexts_().map((context) => context.engine.config.globalMaxConcurrent)).toEqual([2, 2]);
            expect(runtimes.syncConfig()).toEqual([ID_A, ID_B]);

            for (const storyId of [ID_A, ID_B]) {
                expect((runtimes.storeFor(storyId) as Store).setting(LOOP_CEILING_SETTING)).toBe(2);
            }

            // A per-book copy never outranks the app: a book that guessed a roster is overwritten with the
            // app's, because N books each holding a process-wide number is N numbers.
            (runtimes.storeFor(ID_A) as Store).setSetting(AGENT_MODELS_SETTING, { writer: 'a-book-guessed' });

            expect(runtimes.syncConfig()).toEqual([ID_A]);
            expect((runtimes.storeFor(ID_A) as Store).setting(AGENT_MODELS_SETTING)).toEqual({
                writer: 'gpt-author-one'
            });

            await runtimes.close();
        } finally {
            removeRoot(root);
        }
    });
});

// --------------------------------------------------------------------------------
// 4. The app book is durable configuration, not a second story log
// --------------------------------------------------------------------------------

describe('The app book is durable configuration, not a second story log', () => {
    it('reopens with its crews and settings, and copies them into a book without journalling them', async () => {
        const root = scratch('app-book-durable');

        try {
            const config = await ServerConfig.open(root);

            config.seedCatalogue();

            const crew = config.book.templates.create(
                { ...crewCopy(config.templates()[0], 'author-cartographers'), builtin: false, editable: true },
                AUTHOR
            );

            config.setAgentModel('editor', 'gpt-editor-two');
            config.setGlobalMaxConcurrent(3);

            const before = config.templates().map((row) => [row.id, row.name, row.rev]);

            expect(before.length).toBe(BUILT_IN_TEMPLATES.length + 1);
            expect(before[before.length - 1]).toEqual([FIRST_AUTHOR_MINTED_ID, 'author-cartographers', 1]);

            await config.persist();
            await config.close();

            // A restart reads the same rows at the same revs: a config book that re-minted its rows on every
            // boot would fork every Story's copy on the first sync after the upgrade.
            const again = await ServerConfig.open(root);

            expect(again.templates().map((row) => [row.id, row.name, row.rev])).toEqual(before);
            expect(again.getAgentModels()).toEqual({ editor: 'gpt-editor-two' });
            expect(again.getGlobalMaxConcurrent()).toBe(3);
            expect(again.hasTemplateNamed('author-cartographers')).toBe(true);

            // Materialising that book into a Story book writes NO journal line: the Digest reads a
            // `template_*` event as story work, and a config copy is not work the Author performed.
            const book = Store.emptyStory(ID_C);

            expect(book.journal).toEqual([]);
            again.applyTo(book);

            expect(book.journal).toEqual([]);
            expect(book.templates.list().map((row) => [row.id, row.name, row.rev])).toEqual(
                again.templates().map((row) => [row.id, row.name, row.rev])
            );
            expect(book.setting(AGENT_MODELS_SETTING)).toEqual({ editor: 'gpt-editor-two' });
            expect(book.setting(LOOP_CEILING_SETTING)).toBe(3);
            expect(again.matches(book)).toBe(true);

            // And the app book itself stays app-config-only: no Story rows, no findings — `<root>/server/`
            // holds the configuration and nothing a Story remembers.
            expect(again.book.stories.list()).toEqual([]);
            expect(again.book.findings.list()).toEqual([]);
            expect(crew.name).toBe('author-cartographers');

            await again.close();
        } finally {
            removeRoot(root);
        }
    });
});

// --------------------------------------------------------------------------------
// 5. Scheduling: one switch, one timer, one ceiling
// --------------------------------------------------------------------------------

describe('The coordinator owns the loop for every Story', () => {
    it('starts and stops every Story engine with the workspace, including Stories made while it runs', async () => {
        const root = scratch('scheduling');

        try {
            const { runtimes } = await openWorkspace(root, { storyIds: [ID_A, ID_B, ID_C] });

            await runtimes.createStory({ idea: IDEA_A });
            await runtimes.createStory({ idea: IDEA_B });

            // Stopped: nothing schedules, and an explicit sweep refuses every book (L-1's switch, N times).
            // The report is the workspace's one pass, so an idle workspace answers with an empty story list.
            expect(runtimes.started).toBe(false);
            expect(runtimes.contexts_().map((context) => context.engine.started)).toEqual([false, false]);
            expect(idleOf(await runtimes.sweep())).toEqual([[], 0, 0, [], false]);

            runtimes.start();

            expect(runtimes.started).toBe(true);
            expect(runtimes.contexts_().map((context) => context.engine.started)).toEqual([true, true]);

            // A Story made while the workspace runs joins the running loop — it is not a book to restart for.
            await runtimes.createStory({ idea: IDEA_C });

            expect(runtimes.count()).toBe(3);
            expect(runtimes.contexts_().map((context) => context.engine.started)).toEqual([true, true, true]);

            // The workspace's one timer is the only clock: a context's own sweep is off, which is what keeps
            // the shared ceiling able to arbitrate between books instead of N books self-certifying capacity.
            expect(runtimes.config.autoSweep).toBe(false);

            runtimes.stop();

            expect(runtimes.started).toBe(false);
            expect(runtimes.contexts_().map((context) => context.engine.started)).toEqual([
                false,
                false,
                false
            ]);
            // The sweep after a stop answers the same way as the one before a start: nothing was scheduled,
            // so the pass names no Story (`sweepAll` skips engines that were never started).
            expect(idleOf(await runtimes.sweep())).toEqual([[], 0, 0, [], false]);

            // `setStopped` is the same switch the API names, in both directions.
            runtimes.setStopped(false);
            expect(runtimes.contexts_().map((context) => context.engine.started)).toEqual([true, true, true]);
            runtimes.setStopped(true);
            expect(runtimes.contexts_().map((context) => context.engine.started)).toEqual([false, false, false]);

            await runtimes.close();
        } finally {
            removeRoot(root);
        }
    });

    it('sweeps every Story in one pass, in book order, and reports each Story only as its own entry', async () => {
        const root = scratch('sweep-fan');

        try {
            const { runtimes } = await openWorkspace(root, { storyIds: [ID_A, ID_B] });

            await runtimes.createStory({ idea: IDEA_A });
            await runtimes.createStory({ idea: IDEA_B });

            runtimes.start();

            const report = await runtimes.sweep();

            // ONE pass, and both books in it: `stories` is concatenated in book order, and each entry names
            // the Story it came from. The isolation claim lives in those `story_id`s — two books' work stays
            // two entries, and the counter sums because the ceiling that spent it is one number (S-5). An
            // aggregated engine would report ONE story for a workspace of two books.
            expect(report.stories.map((story) => story.story_id)).toEqual([ID_A, ID_B]);
            expect([report.skipped, report.runs_started, report.runs_finished, report.leases_lapsed]).toEqual([
                false,
                2,
                0,
                []
            ]);

            await runtimes.settle();

            const bookA = runtimes.storeFor(ID_A) as Store;
            const bookB = runtimes.storeFor(ID_B) as Store;

            // The same local counter starts in each book: the first run either Story dispatches is `run_0`,
            // and every row carries its own book's story id (P1's fence, now per folder).
            expect(bookA.runs.list().map((row) => [row.id, row.story_id])).toEqual([[ 'run_0', ID_A ]]);
            expect(bookB.runs.list().map((row) => [row.id, row.story_id])).toEqual([[ 'run_0', ID_B ]]);

            // The one ceiling counts live threads ACROSS the books, which is the whole reason one exists.
            bookA.runs.create(runInit(ID_A, 1), AUTHOR);
            bookA.runs.create(runInit(ID_A, 2), AUTHOR);
            bookB.runs.create(runInit(ID_B, 3), AUTHOR);

            expect(runtimes.liveRuns()).toBe(3);
            expect(runtimes.ceilingView).toEqual({ limit: 12, live_runs: 3, stories: 2 });

            // Lowering it is one write, seen by every engine on its next dispatch and by the app book.
            runtimes.setGlobalMaxConcurrent(1);

            expect(runtimes.ceilingView).toEqual({ limit: 1, live_runs: 3, stories: 2 });
            expect(runtimes.contexts_().map((context) => context.engine.config.globalMaxConcurrent)).toEqual([1, 1]);

            await runtimes.close();

            // Both books came off the disk with their own work: the sweep touched two folders, not one.
            expect(bookFiles(root, ID_A)).toEqual(BOOK_FILES);
            expect(bookFiles(root, ID_B)).toEqual(BOOK_FILES);
            expect(journalText(root, ID_A)).toContain(ID_A);
            expect(journalText(root, ID_B)).toContain(ID_B);
        } finally {
            removeRoot(root);
        }
    });
});

// --------------------------------------------------------------------------------
// 6. The workspace survives its own restart
// --------------------------------------------------------------------------------

describe('A restarted workspace reopens every Story with its own memory and the app’s current config', () => {
    it('reloads the books, their rows, the app catalogue and the ceiling without a migration', async () => {
        const root = scratch('restart');

        try {
            const config = await ServerConfig.open(root);

            config.setGlobalMaxConcurrent(5);

            const { runtimes } = await openWorkspace(root, { storyIds: [ID_A, ID_B], config });

            await runtimes.createStory({ idea: IDEA_A });
            await runtimes.createStory({ idea: IDEA_B });

            const crew = config.book.templates.create(
                { ...crewCopy(config.templates()[0], 'author-cartographers'), builtin: false, editable: true },
                AUTHOR
            );

            expect(runtimes.syncConfig()).toEqual([ID_A, ID_B]);
            await (runtimes.storeFor(ID_A) as Store).commit('seed_finding', (tx) => {
                tx.findings.create(findingInit(ID_A, 'a1'), AUTHOR);
            });

            await runtimes.close();

            // Reopen: two books, the rows each one wrote, the Author's crew in the app book, and the
            // ceiling the Author chose — every one of them read from files, none of them migrated.
            const again = await openWorkspace(root);

            expect(again.runtimes.count()).toBe(2);
            expect(bookDirs(root)).toEqual([ID_A, ID_B]);
            expect(again.runtimes.contexts_().map((context) => context.storyId)).toEqual([ID_A, ID_B]);
            expect((again.runtimes.storeFor(ID_A) as Store).findings.list().map((row) => row.id)).toEqual([
                'finding_0'
            ]);
            expect((again.runtimes.storeFor(ID_B) as Store).findings.list()).toEqual([]);
            expect(again.runtimes.appConfig.templates().map((row) => row.name)).toContain('author-cartographers');
            expect(again.runtimes.appConfig.getGlobalMaxConcurrent()).toBe(5);
            expect(again.runtimes.ceilingView).toEqual({ limit: 5, live_runs: 0, stories: 2 });

            // The books were seeded from the app configuration at boot, so the first sync after a restart
            // has nothing left to do — the copy on disk is already the app's current copy.
            expect(again.runtimes.syncConfig()).toEqual([]);
            expect((again.runtimes.storeFor(ID_B) as Store).templates.get(crew.id)?.name).toBe(
                'author-cartographers'
            );

            await again.runtimes.close();
        } finally {
            removeRoot(root);
        }
    });
});

// --------------------------------------------------------------------------------
// 7. Single-book (adopt) mode: the injected book is the whole workspace
// --------------------------------------------------------------------------------

describe('StoryRuntimes.adopt routes one injected book without inventing an app book', () => {
    it('adopts the caller’s executor, engine and store, and refuses a Story the book does not hold', async () => {
        const store = Store.emptyStory(ID_A);

        await store.commit('seed', (tx) => { tx.stories.create(storyInit('Lighthouse'), AUTHOR); });

        const executor = new RunExecutor({
            store,
            runtime: createToolRuntime(store),
            chat: stubChat(),
            // Required: the model a run asks for when its template names none (T-6b). Nothing here calls
            // the model, so the name only has to exist.
            defaultModel: 'mock-model'
        });
        const engine = new LoopEngine({
            store,
            executor,
            criteria: new CriteriaEngine(),
            digest: new DigestBuilder(),
            config: { autoSweep: false }
        });

        const runtimes = StoryRuntimes.adopt({ store, executor, engine });

        // One context over the caller's book, addressed by that book's Story.
        expect(runtimes.count()).toBe(1);
        expect(runtimes.contexts_().map((context) => context.storyId)).toEqual([ID_A]);
        expect(runtimes.stores()).toEqual([store]);
        expect(runtimes.storeFor(ID_A)).toBe(store);

        // The injected pieces are adopted verbatim: the coordinator does not build a second engine over
        // the same rows, which is what keeps an embed's own loop its own.
        expect(runtimes.requires(ID_A).engine).toBe(engine);
        expect(runtimes.requires(ID_A).executor).toBe(executor);
        expect(runtimes.requires(ID_A).harness).toBe(executor.harness);
        expect(runtimes.engineOf(ID_A)).toBe(engine);
        expect(runtimes.engineOf(ID_B)).toBeUndefined();

        // A Story this book does not hold is a miss, not a call into someone else's rows (the 404). The
        // shared-store key addresses a context only when the injected book declares no Story at all
        // (`story-runtimes.ts:bookEntries`), which an unbound `Store.empty()` book does and this one does not.
        expect(runtimes.contextOf(ID_B)).toBeUndefined();
        expect(runtimes.storeFor(ID_B)).toBeUndefined();
        expect(runtimes.storeFor(SHARED_STORE_ID)).toBeUndefined();

        // No app book was supplied, so no catalogue was seeded anywhere: the book keeps exactly its own rows.
        expect(runtimes.appConfig.templates()).toEqual([]);
        expect(runtimes.appConfig.book.rootDir).toBeNull();
        expect(store.templates.list()).toEqual([]);

        // The ceiling still exists, at the shipped standard, and still arbitrates the one book.
        expect(runtimes.ceilingView).toEqual({ limit: 12, live_runs: 0, stories: 1 });

        await runtimes.close();
        await store.close();
    });
});

// --------------------------------------------------------------------------------
// 8. The layout refuses what this build does not support
// --------------------------------------------------------------------------------

describe('The workspace refuses a legacy flat store root', () => {
    it('refuses a root whose store files are not inside stories/<uuid>/', async () => {
        const root = scratch('legacy-flat');

        try {
            // The pre-per-story layout: `store.json` and `journal.jsonl` directly under the root. This build
            // has no migration, so adopting them silently is the bug being removed.
            writeFileSync(path.join(root, 'store.json'), '{"records":{}}', 'utf-8');
            writeFileSync(path.join(root, 'journal.jsonl'), '', 'utf-8');

            const failure = await StoryStores.open(root).then(
                () => null,
                (error: unknown) => error
            );

            expect(failure).toBeInstanceOf(StoryLayoutError);

            const message = (failure as Error).message;

            // The error names the layout and the fix, not just "bad root": an Author opening an old
            // workspace has to be able to read what to do next.
            expect(message).toContain(root);
            expect(message).toContain(`${STORIES_DIRECTORY}/<uuid>`);
            expect(existsSync(path.join(root, 'store.json'))).toBe(true);
        } finally {
            removeRoot(root);
        }
    });
});

// --------------------------------------------------------------------------------
// 9. Deleting a Story purges its whole book — and nothing else
// --------------------------------------------------------------------------------

describe('A deleted Story leaves no book, no context and no ghost on restart', () => {
    it(
        'kills its runs, deletes its rows, threads, articles and folder, and leaves B and the app book byte-identical',
        async () => {
            const root = scratch('delete-purge');

            try {
                const config = await ServerConfig.open(root);

                config.setGlobalMaxConcurrent(5);

                const { stories, runtimes } = await openWorkspace(root, { storyIds: [ID_A, ID_B], config });

                await runtimes.createStory({ idea: IDEA_A, title: 'Lighthouse' });
                await runtimes.createStory({ idea: IDEA_B, title: 'Reservoir' });

                const contextA = runtimes.requires(ID_A);
                const contextB = runtimes.requires(ID_B);

                // A lived-in book, in the shape a working Story actually has: a child row (its OWN
                // `finding_0`), a LIVE run row the coordinator has to stop and settle before the folder
                // goes, and a retained thread in its own log.
                await contextA.store.commit('seed_finding', (tx) => {
                    tx.findings.create(findingInit(ID_A, 'a1'), AUTHOR);
                });
                // The id is captured because the kill assertion below names it exactly, and the
                // per-book counter is what mints it (`run_0`, in this book's own order).
                const runA = contextA.store.runs.create(runInit(ID_A, 1), AUTHOR);
                await contextB.store.commit('seed_finding', (tx) => {
                    tx.findings.create(findingInit(ID_B, 'b1'), AUTHOR);
                });
                contextA.threadLog.append(threadRecord(ID_A, 'thread_a'));
                contextB.threadLog.append(threadRecord(ID_B, 'thread_b'));

                // The Author's own crew and the ceiling they chose: host configuration, which the delete
                // has no business touching.
                const crew = config.book.templates.create(
                    { ...crewCopy(config.templates()[0], 'author-cartographers'), builtin: false, editable: true },
                    AUTHOR
                );

                expect(runtimes.syncConfig()).toEqual([ID_A, ID_B]);

                // The nine articles are derived from the rows, so a Story that has rows HAS a directory.
                expect(contextA.knowledge.tree(ID_A)?.sections).toHaveLength(9);
                expect(contextB.knowledge.tree(ID_B)?.sections).toHaveLength(9);

                // FLUSH BEFORE ANY DISK PROBE — the three-file shape here AND the byte-for-byte comparison
                // after the delete. The snapshot write is DEBOUNCED (`store/store.ts:PERSIST_DEBOUNCE_MS`)
                // and rides the same serialised chain as the journal appends (`store/store.ts:persist`
                // awaits the chain that drains `appendJournal`), so on a contended run a book can still be
                // holding its `journal.jsonl` in that queue when a probe lands: `store.json` and
                // `harness/` are on disk already — the folder and the snapshot come from the Story's own
                // creation, and the thread log appends SYNCHRONOUSLY (`run/thread-log.ts:append`) — and
                // only the journal is in flight. `persistAll()` awaits every book's explicit flush, which
                // drains the queued appends with it, so the probe and the "unchanged" comparison below both
                // read settled bytes rather than a pending timer. The projection has its OWN barrier, and
                // `harness/` is part of the comparison, so both are flushed here — otherwise a late article
                // write would look like the delete moved a file.
                await runtimes.persistAll();
                await contextA.knowledge.flush();
                await contextB.knowledge.flush();

                expect(bookDirs(root)).toEqual([ID_A, ID_B]);
                expect(bookFiles(root, ID_A)).toEqual(BOOK_FILES);
                expect(existsSync(path.join(storyPathOf(root, ID_A), 'harness', 'threads.jsonl'))).toBe(true);
                expect(runtimes.liveRuns()).toBe(1);

                const appJournalBefore = config.book.journal.map((event) => [event.seq, event.collection, event.op, event.id]);
                const appTemplatesBefore = config.templates().map((row) => row.name);
                const beforeB = {
                    store: bookText(root, ID_B, 'store.json'),
                    journal: bookText(root, ID_B, 'journal.jsonl'),
                    harness: harnessFiles(root, ID_B),
                    rows: journalRows(contextB.store),
                    findings: contextB.store.findings.list().map((row) => [row.id, row.story_id, row.detail]),
                    templates: contextB.store.templates.get(crew.id)?.name,
                    threads: contextB.threadLog.list().map((record) => record.thread_id)
                };

                // WHY A SPY SHOWS WHAT THE ROWS CANNOT: `RunExecutor.kill` aborts only a controller THIS
                // process started, and the Run row above was seeded rather than started, so a stopped thread
                // rewrites no row a test could read. Spying each Story's own executor turns "the purge
                // stopped this Story's run, and never asked the neighbour" into an exact call log.
                const killA = vi.spyOn(contextA.executor, 'kill');
                const killB = vi.spyOn(contextB.executor, 'kill');

                await runtimes.removeStory(ID_A);

                // THE KILL IS STORY-SCOPED AT THE COORDINATOR, AND IN A FIXED ORDER: this book's executor is
                // asked twice about the one run — `LoopEngine.pauseStory`'s cord (`stop`, loop/engine.ts:2212)
                // and then `LoopEngine.deleteStory`'s own ask (`delete`, loop/engine.ts:2230), the row still
                // being live between them — and B's executor is never asked at all. Cord first is the
                // contract: a run that outlives the book it writes to tears down into rows about to be gone.
                expect(killA.mock.calls).toEqual([
                    [runA.id, 'stop'],
                    [runA.id, 'delete']
                ]);
                expect(killB.mock.calls).toEqual([]);

                killA.mockRestore();
                killB.mockRestore();

                // The whole book is off the disk: folder, `store.json`, journal and `harness/` together.
                expect(existsSync(storyPathOf(root, ID_A))).toBe(false);
                expect(bookDirs(root)).toEqual([ID_B]);

                // The runtime is gone from the set, so no route, sweep or ceiling read refers to it again.
                expect(runtimes.count()).toBe(1);
                expect(runtimes.contexts_().map((context) => context.storyId)).toEqual([ID_B]);
                expect(runtimes.books().map((book) => book.id)).toEqual([ID_B]);
                expect(runtimes.contextOf(ID_A)).toBeUndefined();
                expect(runtimes.storeFor(ID_A)).toBeUndefined();
                expect(() => runtimes.requires(ID_A)).toThrow(StoryLayoutError);
                expect(stories.has(ID_A)).toBe(false);

                // The runs went with the book, and the ceiling's live count fell with them: the delete
                // stopped and settled them before the folder was removed, so none of them tore down into
                // rows that no longer exist.
                expect(contextA.store.runs.list()).toEqual([]);
                expect(runtimes.liveRuns()).toBe(0);

                // The projection is RELEASED, not merely emptied: a closed one answers `null`, while B's
                // stays open — the difference between "this Story's files are gone" and "the workspace
                // shut down".
                expect(contextA.knowledge.tree(ID_A)).toBeNull();
                expect(contextB.knowledge.tree(ID_B)?.sections).toHaveLength(9);
                expect(contextA.threadLog.list()).toEqual([]);

                // Story B, byte for byte and row for row: same `store.json`, same journal, same harness
                // files, same `finding_0` under its own id, same retained thread.
                expect(bookText(root, ID_B, 'store.json')).toBe(beforeB.store);
                expect(bookText(root, ID_B, 'journal.jsonl')).toBe(beforeB.journal);
                expect(harnessFiles(root, ID_B)).toEqual(beforeB.harness);
                expect(journalRows(contextB.store)).toEqual(beforeB.rows);
                expect(contextB.store.findings.list().map((row) => [row.id, row.story_id, row.detail])).toEqual(
                    beforeB.findings
                );
                expect(contextB.store.templates.get(crew.id)?.name).toBe(beforeB.templates);
                expect(contextB.threadLog.list().map((record) => record.thread_id)).toEqual(beforeB.threads);

                // The app book is untouched: no journal event the delete added, no crew lost, and the
                // ceiling still the Author's number over one fewer Story.
                expect(config.book.journal.map((event) => [event.seq, event.collection, event.op, event.id])).toEqual(
                    appJournalBefore
                );
                expect(config.templates().map((row) => row.name)).toEqual(appTemplatesBefore);
                expect(config.getGlobalMaxConcurrent()).toBe(5);
                expect(runtimes.ceilingView).toEqual({ limit: 5, live_runs: 0, stories: 1 });

                // THE FLUSH BEFORE THE PROBE, not a sleep: the app book's snapshot write is DEBOUNCED (25ms,
                // `store/store.ts:PERSIST_DEBOUNCE_MS`), so on a fast focused run nothing has touched
                // `<root>/server/` yet and the probe below would answer `false` for a book that is perfectly
                // healthy. `persist()` is the explicit flush, and the same one the config-boot test uses (:575).
                await config.persist();

                expect(existsSync(path.join(root, SERVER_DIRECTORY, 'store.json'))).toBe(true);

                await runtimes.close();

                // RESTART — the half the defect actually shipped as. The folder is gone, so the registry
                // has one book to load, the workspace has one context, and there is no dead Story row for
                // the panel to list and no projection to reopen.
                const again = await openWorkspace(root);

                expect(bookDirs(root)).toEqual([ID_B]);
                expect(again.stories.ids()).toEqual([ID_B]);
                expect(again.runtimes.count()).toBe(1);
                expect(again.runtimes.contexts_().map((context) => context.storyId)).toEqual([ID_B]);
                expect(again.runtimes.contextOf(ID_A)).toBeUndefined();
                expect(again.runtimes.storeFor(ID_A)).toBeUndefined();
                expect((again.runtimes.storeFor(ID_B) as Store).findings.list().map((row) => row.id)).toEqual([
                    'finding_0'
                ]);
                expect(again.runtimes.appConfig.templates().map((row) => row.name)).toContain('author-cartographers');
                expect(again.runtimes.appConfig.getGlobalMaxConcurrent()).toBe(5);

                await again.runtimes.close();
            } finally {
                removeRoot(root);
            }
        }
    );
});

// --------------------------------------------------------------------------------
// 10. A Story whose runtime fails to build leaves no half-open book behind
// --------------------------------------------------------------------------------

describe('A create that fails after the folder is allocated rolls the book back', () => {
    it('removes the folder and the registry entry, and re-throws the failure — with nothing for a restart to reopen', async () => {
        const root = scratch('create-rollback');

        try {
            // THE FAILURE, chosen because it is the shipped one: `build` refuses a Story with no model
            // transport and no injected executor (`story-runtimes.ts:build`), and it refuses AFTER the
            // registry has allocated `<uuid>/` and persisted the empty book. That window is what the
            // rollback exists for — without it the folder restarts as a Story the Author never asked for.
            const stories = await StoryStores.open(root, { createStoryId: factory([ID_A]) });
            const runtimes = await StoryRuntimes.open({
                stories,
                config: await ServerConfig.open(root),
                engineConfig: { autoSweep: false, sweepIntervalMs: 60_000 }
            });

            expect(runtimes.count()).toBe(0);

            const failure = await runtimes.createStory({ idea: IDEA_A, title: 'Lighthouse' }).then(
                (created) => created,
                (error: unknown) => error
            );

            expect(failure).toBeInstanceOf(StoryLayoutError);
            expect((failure as Error).message).toBe('a Story runtime needs a `chat` transport or an injected `executor`');

            // Nothing survived: no context, no registry entry, no folder.
            expect(runtimes.count()).toBe(0);
            expect(runtimes.contexts_()).toEqual([]);
            expect(stories.ids()).toEqual([]);
            expect(existsSync(storyPathOf(root, ID_A))).toBe(false);
            expect(bookDirs(root)).toEqual([]);

            await runtimes.close();

            // A restart has nothing to reopen: the failed create did not become a ghost book, and the app
            // book is still the only thing under the root.
            const again = await openWorkspace(root);

            expect(bookDirs(root)).toEqual([]);
            expect(again.runtimes.count()).toBe(0);
            expect(again.stories.count()).toBe(0);

            await again.runtimes.close();
        } finally {
            removeRoot(root);
        }
    });

    it('refuses an id that is not a UUID before it makes a folder a rollback would have to clean', async () => {
        const root = scratch('create-bad-id');

        try {
            // The other failure half: the id factory is the registry's, and a non-UUID is refused BEFORE
            // `createStoryDirectory` runs, so this case never has anything to roll back — and the Story
            // already open keeps its book untouched.
            const stories = await StoryStores.open(root, { createStoryId: factory([ID_A, 'story_1']) });
            const runtimes = await StoryRuntimes.open({
                stories,
                config: await ServerConfig.open(root),
                chat: stubChat(),
                engineConfig: { autoSweep: false, sweepIntervalMs: 60_000 }
            });

            expect(await runtimes.createStory({ idea: IDEA_A, title: 'Lighthouse' })).toEqual({ story_id: ID_A });

            const failure = await runtimes.createStory({ idea: IDEA_B, title: 'Reservoir' }).then(
                (created) => created,
                (error: unknown) => error
            );

            expect(failure).toBeInstanceOf(StoryLayoutError);
            expect((failure as Error).message).toContain('story_1');
            expect(runtimes.count()).toBe(1);
            expect(bookDirs(root)).toEqual([ID_A]);
            expect(existsSync(storyPathOf(root, 'story_1'))).toBe(false);

            await runtimes.close();

            const again = await openWorkspace(root);

            expect(again.runtimes.count()).toBe(1);
            expect(again.runtimes.contexts_().map((context) => context.storyId)).toEqual([ID_A]);

            await again.runtimes.close();
        } finally {
            removeRoot(root);
        }
    });
});
