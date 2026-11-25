// S-ROUTES — one route table, many books: the Story-scoped half of the HTTP surface (A-RUNTIME acceptance 3-5).
//
// WHAT IS REAL HERE: the mounted Hono route table from `api/routes.ts:createStorylineRoutes` over the whole
// workspace composition — the app book at `<root>/server/`, the Story registry, one runtime per Story book —
// driven with `app.request(...)`, which is a real request through the real router. The only double is the model
// (`llm/mock.ts:MockChatClient`), which no case here dispatches a run against: the sweeps stay off
// (`autoSweep: false`, no `start()`), so every row these assertions read was written by a route or by the seed.
//
// WHY EXACT VALUES: the regression this file exists to prevent is a route that quietly reads the WRONG book —
// the app catalogue (which holds no Story rows at all) or a sibling Story's rows. Both failures look like an id
// that exists somewhere and an answer that came from somewhere else, so every expectation is an exact id array
// or a verbatim error sentence.
//
// THE SHAPES: `openStorylineRuntime({ storeRoot })` is the workspace the server boots. The single-book shape is
// covered by `api/loop-route.test.ts` and `api/contract.test.ts`; this file is the multi-book half.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MockChatClient } from '../llm/mock';
import { LOOP_CEILING_SETTING } from '../loop/ceiling';
import { AGENT_MODELS_SETTING } from '../run/agent-models';
import { BUILT_IN_TEMPLATES } from '../templates';
import {
    HARNESS_DIRECTORY,
    JOURNAL_FILE,
    SERVER_DIRECTORY,
    STORIES_DIRECTORY,
    STORE_FILE,
    Store,
    storyDirectoryPath,
    type Attribution
} from '../store';
import { openStorylineRuntime, startStorylineServer } from './server';
import type { Finding, Run } from '../../shared/types';

const AUTHOR: Attribution = { run_ref: null, author: true, why: 'the Author writes in the book' };

/**
 * The id the app book mints for the first row an AUTHOR adds. `Collection.create` mints `template_0 …`
 * in catalogue order and ignores a built-in's slug-shaped `id`, so an app book seeded with N built-ins
 * hands its next row `template_${N}`. R-lock (D-69) added the `editor-group-lock` crew, which moved that
 * literal from `template_13` to `template_14`; it is derived here so the next built-in costs this suite
 * no edit (the count itself is pinned where it belongs — by `templates.test.ts`'s roster list).
 */
const FIRST_AUTHOR_MINTED_ID = `template_${BUILT_IN_TEMPLATES.length}`;

const IDEA_A = 'A lighthouse keeper starts answering letters written by a ship that sank in her bay.';
const IDEA_B = 'A cartographer returns to the valley she mapped as a girl and finds it redrawn by a reservoir.';

// A UUID-shaped id no workspace here ever opens: what a Story on the Author's other server looks like.
const FOREIGN = '5c0f3a9d-9b6e-4f42-8d7a-1e2b3c4d5e6f';

/** A §4.11 Finding, `confirmed` so it sits on the Author's desk once the dial stops covering it. */
function confirmedFinding(storyId: string, detail: string): Omit<Finding, 'id' | 'rev' | 'created_at' | 'updated_at'> {
    return {
        story_id: storyId,
        target_ref: 'chapter_0',
        criterion_ref: 'C-7',
        title: 'The bay is never paid off',
        detail,
        evidence: 'ch1 §3, ¶2',
        cost: 'major',
        fingerprint: `fp_${detail}`,
        state: 'confirmed',
        seen_count: 1
    };
}

/** One live thread: a `working` row is what the ceiling's live count reads (L-2). */
function liveRun(storyId: string, startedAt: string): Omit<Run, 'id' | 'rev' | 'created_at' | 'updated_at'> {
    return {
        story_id: storyId,
        work_item_ref: `wi_review_summary_${startedAt}`,
        role: 'critic',
        state: 'working',
        started_at: startedAt,
        tokens: 1000,
        kind: 'work',
        delegated: []
    };
}

// --------------------------------------------------------------------------------
// The workspace fixture
// --------------------------------------------------------------------------------

// Scratch roots live in the package's own `Temp/` (AGENTS.md: never the OS temp), one per case, removed after.
let scratchIndex = 0;

const scratch = (label: string): string => {
    const root = path.resolve(
        process.cwd(),
        'Temp',
        `story-isolation-routes-${label}-${process.pid}-${scratchIndex++}`
    );

    mkdirSync(root, { recursive: true });

    return root;
};

const removeRoot = (root: string): void => rmSync(root, { recursive: true, force: true });

type Opened = Awaited<ReturnType<typeof openStorylineRuntime>>;

/**
 * The workspace boot the server itself uses, with the loop's timer off: the tests are the clock, and a sweep
 * firing between two requests would make every row count below a race rather than an expectation.
 * `noAssistantSeed` keeps the app catalogue exactly the shipped 13 crews, so the ids stay literal; an empty
 * `env` keeps an operator's `STORYLINE_MAX_CONCURRENT` from moving the ceiling the tests assert.
 *
 * `assistant: true` opts back IN to the §8.6 crew the shipped server always seeds (`server.ts:seedAssistant`),
 * which is what the Author's-ask case needs: that run names the `assistant` template, and a Story's catalogue
 * is a copy of the app book's, so the seed has to be in the app book for the copy to carry it.
 */
const boot = (root: string, opts?: { assistant?: boolean }): Promise<Opened> =>
    openStorylineRuntime({
        storeRoot: root,
        // An empty env, so an operator's `STORYLINE_MAX_CONCURRENT` or provider variables cannot move the
        // ceiling or the transport these tests assert on.
        env: {},
        chat: new MockChatClient(() => ({
            message: { content: 'The watchtower stood over the pass, and the map it was built from was wrong.' }
        })),
        engineConfig: { autoSweep: false, sweepIntervalMs: 60_000 },
        // The shipped 13 crews and nothing else, so `/templates` ids stay literal in the expectations below.
        ...(opts?.assistant === true ? {} : { noAssistantSeed: true }),
        streamDebounceMs: 1
    });

const BASE = 'http://localhost/v1/storyline';

/** One request, answered as `{status, body}` — the shape every expectation below reads. */
async function call(
    opened: Opened,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    route: string,
    body?: unknown
): Promise<{ status: number; body: any }> {
    const response = await opened.app.request(`${BASE}${route}`, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    });
    const text = await response.text();

    return { status: response.status, body: text === '' ? null : (JSON.parse(text) as any) };
}

const errorOf = (reply: { body: any }): string => reply.body.error;

/** The per-case lifecycle: boot the workspace, run the body, shut the whole workspace down, drop the files. */
async function withWorkspace<T>(
    label: string,
    body: (opened: Opened) => Promise<T>,
    opts?: { assistant?: boolean }
): Promise<T> {
    const root = scratch(label);
    const opened = await boot(root, opts);

    try {
        return await body(opened);
    } finally {
        await opened.runtimes.close();
        removeRoot(root);
    }
}

/**
 * Two Stories, made one after the other through the route that makes them. Sequential on purpose: the registry
 * registers a book when its Story is created, and the routes that resolve a book-LOCAL id (`/runs/:id/kill`)
 * take the first book that holds it — so creation order is the order those routes resolve in, and a
 * `Promise.all` here would make that a race rather than an expectation.
 */
async function createTwoStories(opened: Opened): Promise<string[]> {
    const created = [
        await call(opened, 'POST', '/stories', { idea: IDEA_A, title: 'Lighthouse', chapter_count: 1 }),
        await call(opened, 'POST', '/stories', { idea: IDEA_B, title: 'Reservoir', chapter_count: 1 })
    ];

    expect(created.map((reply) => reply.status)).toEqual([200, 200]);

    return created.map((reply) => reply.body.id as string);
}

// --------------------------------------------------------------------------------
// 1. Every book's Story is in the listing; a Story from elsewhere is absent
// --------------------------------------------------------------------------------

describe('GET /stories spans every book, and a Story this workspace does not hold is absent', () => {
    it('lists one row per Story across books, and answers a foreign id as a miss', async () => {
        await withWorkspace('stories-listing', async (opened) => {
            const [a, b] = await createTwoStories(opened);

            // One row per Story, in book order — and the folder IS the id, so the ids are the two UUIDs the
            // registry allocated, not `stories_0`/`stories_1`.
            const listing = await call(opened, 'GET', '/stories');

            expect(listing.status).toBe(200);
            expect(listing.body.map((row: { id: string; title: string; idea: string }) => [row.id, row.title])).toEqual(
                [
                    [a, 'Lighthouse'],
                    [b, 'Reservoir']
                ].sort((left, right) => left[0]!.localeCompare(right[0]!))
            );

            // The whole Story region in one read comes from THAT Story's book: every slice is Story-filtered,
            // and the ids inside it are book-local.
            const viewA = await call(opened, 'GET', `/stories/${a}`);

            expect(viewA.status).toBe(200);
            expect(viewA.body.story.id).toBe(a);
            expect(viewA.body.story.idea).toBe(IDEA_A);
            expect(viewA.body.findings).toEqual([]);
            expect(viewA.body.runs).toEqual([]);

            // A Story id from another server's root is absent, not wrong: the same answer the store's row
            // fence gives at record level, and never another Story's rows.
            const foreign = await call(opened, 'GET', `/stories/${FOREIGN}`);

            expect(foreign.status).toBe(404);
            expect(errorOf(foreign)).toBe(
                'no story named 5c0f3a9d-9b6e-4f42-8d7a-1e2b3c4d5e6f is in the book (P1: the store is the memory)'
            );

            // A mutation on a foreign Story is refused the same way: the id resolves to no book, the handler's
            // own lookup misses, and the answer is the book-miss 404 this layer owns — not another Story's rows.
            const stop = await call(opened, 'POST', `/stories/${FOREIGN}/stop`);

            expect(stop.status).toBe(404);
            expect(errorOf(stop)).toBe(
                'no story named 5c0f3a9d-9b6e-4f42-8d7a-1e2b3c4d5e6f is in the book (P1: the store is the memory)'
            );

            // And a Story of THIS workspace still answers afterwards, in its own book.
            const stopped = await call(opened, 'POST', `/stories/${b}/stop`);

            expect(stopped.status).toBe(200);

            // The stop answers with U-1's row for the Story it acted on (`routes.ts:verb` re-reads the row from
            // that Story's own book), and the flag lands in that book only.
            expect(stopped.body.id).toBe(b);
            expect(stopped.body.title).toBe('Reservoir');

            // The stop moved ONE book's Story row: the panel row and the full view both read the Story's own
            // book, so a sibling's `author_stop` is still false.
            expect((await call(opened, 'GET', `/stories/${b}`)).body.story.author_stop).toBe(true);
            expect((await call(opened, 'GET', `/stories/${a}`)).body.story.author_stop).toBe(false);
        });
    });
});

// --------------------------------------------------------------------------------
// 2. Two books' `finding_0` are two rows
// --------------------------------------------------------------------------------

describe('GET /queue keeps same-named rows from different books apart', () => {
    it('shows one desk row per Story when both books hold `finding_0`', async () => {
        await withWorkspace('queue-merge', async (opened) => {
            const [a, b] = await createTwoStories(opened);

            // A confirmed finding in each book, plus a dial that no longer auto-approves it, in one commit per
            // book. Both books mint the SAME child id — the collision the desk has to survive.
            for (const [storyId, detail] of [
                [a, 'a1'],
                [b, 'b2']
            ] as const) {
                const book = opened.runtimes.storeFor(storyId) as Store;

                await book.commit('author_desk', (tx) => {
                    tx.stories.update(storyId, { auto_approve: [] }, AUTHOR);
                    tx.findings.create(confirmedFinding(storyId, detail), AUTHOR);
                });
            }

            expect((opened.runtimes.storeFor(a) as Store).findings.list().map((row) => row.id)).toEqual(['finding_0']);
            expect((opened.runtimes.storeFor(b) as Store).findings.list().map((row) => row.id)).toEqual(['finding_0']);

            const queue = await call(opened, 'GET', '/queue');

            expect(queue.status).toBe(200);

            // Two clickable rows, told apart by the `story_id` each carries. A merge keyed on the record id
            // would show one row — and the Author would approve one Story's finding while believing both moved.
            // The order is the desk's own rule — `api/projections.ts:queueOrder` sorts Story id, then creation,
            // then row id — restated here so the pair is asserted exactly rather than as a set.
            const byStoryThenRow = (left: [string, string, string], right: [string, string, string]): number =>
                left[2].localeCompare(right[2]) || left[1].localeCompare(right[1]);

            const desk = (
                queue.body as { kind: string; id: string; story_id: string }[]
            ).map((item) => [item.kind, item.id, item.story_id]);

            expect(desk).toEqual(
                ([
                    ['finding', 'finding_0', a],
                    ['finding', 'finding_0', b]
                ] as [string, string, string][]).sort(byStoryThenRow)
            );

            // And each Story's own view still holds only its own words.
            const viewA = await call(opened, 'GET', `/stories/${a}`);

            expect(viewA.body.findings.map((row: { id: string; detail: string }) => [row.id, row.detail])).toEqual([
                ['finding_0', 'a1']
            ]);
        });
    });
});

// --------------------------------------------------------------------------------
// 3. The crew panel: two `run_0` rows, a filter that cannot leak, and a kill that finds its book
// --------------------------------------------------------------------------------

describe('GET /runs and POST /runs/:id/kill are scoped to the book that holds the run', () => {
    it(
        'keeps two books’ `run_0` as two rows, refuses an ambiguous kill with 409, and stops only the Story it names',
        async () => {
            await withWorkspace('runs-kill', async (opened) => {
                const [a, b] = await createTwoStories(opened);

                // One live thread per book, both minted `run_0`, with `started_at` values that pin the panel's
                // order so the two rows are assertable as an exact pair.
                (opened.runtimes.storeFor(a) as Store).runs.create(liveRun(a, '2026-11-24T10:00:00.000Z'), AUTHOR);
                (opened.runtimes.storeFor(b) as Store).runs.create(liveRun(b, '2026-11-24T09:00:00.000Z'), AUTHOR);

                const all = await call(opened, 'GET', '/runs');

                expect(all.status).toBe(200);
                // Ordered by `started_at`, and NOT de-duplicated by id: `run_0` twice is two threads.
                expect(all.body.map((row: { id: string; story_id: string }) => [row.id, row.story_id])).toEqual([
                    ['run_0', b],
                    ['run_0', a]
                ]);

                for (const storyId of [a, b]) {
                    const filtered = await call(opened, 'GET', `/runs?story_id=${storyId}`);

                    expect(filtered.body.map((row: { id: string; story_id: string }) => [row.id, row.story_id])).toEqual([
                        ['run_0', storyId]
                    ]);
                }

                // A Story this server does not hold has no ledger here: an empty panel, not someone else's.
                expect((await call(opened, 'GET', `/runs?story_id=${FOREIGN}`)).body).toEqual([]);

                // WHICH EXECUTOR THE KILL REACHES is the isolation claim, and a run row created outside a run
                // cannot show it (`RunExecutor.kill` aborts only a controller that instance started). So each
                // book's executor is spied: the assertion is "B's executor was asked, A's never was" — which is
                // what a 200 body alone could never prove.
                const killA = vi
                    .spyOn(opened.runtimes.requires(a).executor, 'kill')
                    .mockImplementation((): void => undefined);
                const killB = vi
                    .spyOn(opened.runtimes.requires(b).executor, 'kill')
                    .mockImplementation((): void => undefined);

                // AMBIGUOUS: both books hold `run_0` and the request named no Story. The route refuses instead
                // of stopping whichever book came first in book order, and it refuses BEFORE it aborts.
                const unscoped = await call(opened, 'POST', '/runs/run_0/kill');

                expect(unscoped.status).toBe(409);
                expect(errorOf(unscoped)).toBe(
                    '`run run_0` is a Story-local id and more than one Story in this workspace holds it, while the ' +
                        'request named none — send `?story_id=` with the Story the run belongs to, so the kill stops ' +
                        'that thread and no other (S-RUNTIME: one book per Story).'
                );
                expect(killA.mock.calls).toEqual([]);
                expect(killB.mock.calls).toEqual([]);
                expect(
                    (await call(opened, 'GET', '/runs')).body.map((row: { id: string; state: string }) => [
                        row.id,
                        row.state
                    ])
                ).toEqual([
                    ['run_0', 'working'],
                    ['run_0', 'working']
                ]);

                // SCOPED: the Story named is the Story whose executor aborts, and the sibling keeps its thread.
                const scoped = await call(opened, 'POST', `/runs/run_0/kill?story_id=${b}`);

                expect(scoped.status).toBe(200);
                expect(scoped.body.id).toBe('run_0');
                expect(scoped.body.story_id).toBe(b);
                expect(killB.mock.calls.map((args) => args[0])).toEqual(['run_0']);
                expect(killA.mock.calls).toEqual([]);
                expect(
                    (await call(opened, 'GET', `/runs?story_id=${a}`)).body.map((row: { id: string; state: string }) => [
                        row.id,
                        row.state
                    ])
                ).toEqual([['run_0', 'working']]);

                // A Story this workspace has never opened has no run to stop: the same 404 sentence an unknown
                // run id answers, never another Story's thread by default.
                const foreign = await call(opened, 'POST', `/runs/run_0/kill?story_id=${FOREIGN}`);

                expect(foreign.status).toBe(404);
                expect(errorOf(foreign)).toBe('no run named run_0 is in the book (P1: the store is the memory)');
                expect(killA.mock.calls).toEqual([]);
                expect(killB.mock.calls).toHaveLength(1);

                // A scope that matches exactly one book is exact even when the local id repeats: B's row goes
                // away, and the SAME unscoped request is now unambiguous and lands in the only book left.
                (opened.runtimes.storeFor(b) as Store).runs.delete('run_0', AUTHOR);

                const unique = await call(opened, 'POST', '/runs/run_0/kill');

                expect(unique.status).toBe(200);
                expect(unique.body.story_id).toBe(a);
                expect(killA.mock.calls.map((args) => args[0])).toEqual(['run_0']);

                const unknown = await call(opened, 'POST', '/runs/run_9/kill');

                expect(unknown.status).toBe(404);
                expect(errorOf(unknown)).toBe('no run named run_9 is in the book (P1: the store is the memory)');

                killA.mockRestore();
                killB.mockRestore();
            });
        }
    );
});

// --------------------------------------------------------------------------------
// 4. Host configuration: one write, mirrored into every Story's runtime
// --------------------------------------------------------------------------------

describe('A configuration write lands in the app book and in every Story’s copy', () => {
    it('mirrors a new crew, the roster and the ceiling into each book, and refuses a built-in edit', async () => {
        await withWorkspace('config-mirror', async (opened) => {
            const [a, b] = await createTwoStories(opened);
            const builtIn = BUILT_IN_TEMPLATES[0].name;

            // `/templates` reads the app book: the shipped catalogue, once for the whole workspace.
            expect(
                (await call(opened, 'GET', '/templates')).body.map((row: { name: string }) => row.name)
            ).toEqual(BUILT_IN_TEMPLATES.map((row) => row.name));

            // Duplicate, then edit the copy — the only way an Author may change a built-in (D-17).
            const duplicated = await call(opened, 'POST', '/templates', { duplicate_of: builtIn });

            expect(duplicated.status).toBe(200);
            expect([
                duplicated.body.id,
                duplicated.body.name,
                duplicated.body.builtin,
                duplicated.body.editable
            ]).toEqual([FIRST_AUTHOR_MINTED_ID, `${builtIn}-copy`, false, true]);

            // The row is app configuration, so it is journaled in the app book — and mirrored, because each
            // Story briefs its harness from its OWN copy of the catalogue.
            for (const storyId of [a, b]) {
                const copy = (opened.runtimes.storeFor(storyId) as Store).templates.get(FIRST_AUTHOR_MINTED_ID);

                expect([copy?.id, copy?.name, copy?.rev]).toEqual([FIRST_AUTHOR_MINTED_ID, `${builtIn}-copy`, 1]);
            }

            // A Story book's journal never sees the config copy: the Digest reads a `template_*` event as
            // story work, and this was not work.
            for (const storyId of [a, b]) {
                expect(
                    (opened.runtimes.storeFor(storyId) as Store).journal.some(
                        (event) => event.collection === 'templates'
                    )
                ).toBe(false);
            }

            const edited = await call(opened, 'PATCH', `/templates/${FIRST_AUTHOR_MINTED_ID}`, { title: 'The Surveyors' });

            expect(edited.status).toBe(200);
            expect([edited.body.rev, edited.body.title]).toEqual([2, 'The Surveyors']);

            for (const storyId of [a, b]) {
                const copy = (opened.runtimes.storeFor(storyId) as Store).templates.get(FIRST_AUTHOR_MINTED_ID);

                expect([copy?.title, copy?.rev]).toEqual(['The Surveyors', 2]);
            }

            // A built-in is duplicate-only, addressed by id or by slug, and the refusal names the rule.
            const builtInEdit = await call(opened, 'PATCH', `/templates/${builtIn}`, { title: 'Overwritten' });

            expect(builtInEdit.status).toBe(409);
            expect(errorOf(builtInEdit)).toBe(
                `template ${builtIn} is built-in — duplicate it and edit the copy (D-17).`
            );

            // A new crew that takes a built-in's slug is refused before anything is written.
            const clash = await call(opened, 'POST', '/templates', {
                template: {
                    name: builtIn,
                    title: 'Clash',
                    roles: [],
                    serves_phase: 'summary',
                    done_definition: '',
                    attempts: 3
                }
            });

            expect(clash.status).toBe(409);
            expect(errorOf(clash)).toBe(
                `a template named ${builtIn} is already in the catalogue — duplicate it and edit the copy (D-17).`
            );

            // The roster is the same kind of host setting: one write, and every Story's runtime reads it.
            expect((await call(opened, 'PATCH', '/agents/writer', { model: 'gpt-author-one' })).status).toBe(200);

            for (const storyId of [a, b]) {
                expect((opened.runtimes.storeFor(storyId) as Store).setting(AGENT_MODELS_SETTING)).toEqual({
                    writer: 'gpt-author-one'
                });
            }

            const unknownAgent = await call(opened, 'PATCH', '/agents/cartographer', { model: 'x' });

            expect(unknownAgent.status).toBe(404);
            expect(errorOf(unknownAgent)).toBe(
                'no agent named "cartographer" — the global roster is writer, editor, reader, critic and researcher (U-8).'
            );

            // The ceiling: refused, then moved once, then seen by every book — and counted across them.
            const missingField = await call(opened, 'PATCH', '/loop', {});

            expect(missingField.status).toBe(400);
            expect(errorOf(missingField)).toBe(
                '`global_max_concurrent` is required — send the number of threads the loop may run at once (S-5).'
            );

            const zeroThreads = await call(opened, 'PATCH', '/loop', { global_max_concurrent: 0 });

            expect(zeroThreads.status).toBe(400);
            expect(errorOf(zeroThreads)).toBe(
                '`global_max_concurrent` must be a whole number of threads, at least 1 — it is the hard cap on simultaneous runs (S-5).'
            );

            // One live thread per book, so the PATCH has a live count to report: the ceiling's number is the
            // SUM across the books, because it is one number that arbitrates everything (S-5).
            (opened.runtimes.storeFor(a) as Store).runs.create(liveRun(a, '2026-11-24T10:00:00.000Z'), AUTHOR);
            (opened.runtimes.storeFor(b) as Store).runs.create(liveRun(b, '2026-11-24T09:00:00.000Z'), AUTHOR);

            const moved = await call(opened, 'PATCH', '/loop', { global_max_concurrent: 3 });

            expect(moved.status).toBe(200);
            expect(moved.body).toEqual({ global_max_concurrent: 3, live_runs: 2 });

            for (const storyId of [a, b]) {
                expect((opened.runtimes.storeFor(storyId) as Store).setting(LOOP_CEILING_SETTING)).toBe(3);
            }

            expect((await call(opened, 'GET', '/loop')).body).toEqual({ global_max_concurrent: 3, live_runs: 2 });
        });
    });
});

// --------------------------------------------------------------------------------
// 5. The workspace survives its own restart
// --------------------------------------------------------------------------------

describe('A restarted workspace answers for every Story it reopens', () => {
    it('reloads the books, their rows and the app’s configuration from disk, with no migration', async () => {
        const root = scratch('restart');
        const first = await boot(root);
        const created = await call(first, 'POST', '/stories', { idea: IDEA_A, title: 'Lighthouse', chapter_count: 1 });
        const storyId = created.body.id as string;

        await call(first, 'PATCH', '/loop', { global_max_concurrent: 4 });
        await call(first, 'POST', '/templates', { duplicate_of: BUILT_IN_TEMPLATES[1].name });
        await (first.runtimes.storeFor(storyId) as Store).commit('seed_finding', (tx) => {
            tx.findings.create(confirmedFinding(storyId, 'a1'), AUTHOR);
        });

        await first.runtimes.close();

        const again = await boot(root);

        try {
            expect((await call(again, 'GET', '/stories')).body.map((row: { id: string; title: string }) => [row.id, row.title])).toEqual([
                [storyId, 'Lighthouse']
            ]);

            expect(
                (await call(again, 'GET', `/stories/${storyId}`)).body.findings.map((row: { id: string; detail: string }) => [
                    row.id,
                    row.detail
                ])
            ).toEqual([['finding_0', 'a1']]);

            // Host configuration comes back as the Author left it, and the one Story's copy is already
            // current — the desk can brief a run without a re-sync.
            expect((await call(again, 'GET', '/loop')).body).toEqual({ global_max_concurrent: 4, live_runs: 0 });
            expect((await call(again, 'GET', '/templates')).body.map((row: { name: string }) => row.name)).toEqual([
                ...BUILT_IN_TEMPLATES.map((row) => row.name),
                `${BUILT_IN_TEMPLATES[1].name}-copy`
            ]);
            expect((again.runtimes.storeFor(storyId) as Store).setting(LOOP_CEILING_SETTING)).toBe(4);
            expect((again.runtimes.storeFor(storyId) as Store).templates.list().map((row) => row.name)).toContain(
                `${BUILT_IN_TEMPLATES[1].name}-copy`
            );

            // The Story is addressable, its folder is the folder it always was, and its knowledge projection
            // reopened with it (that read is per-Story, rooted in the Story's own directory).
            expect(again.runtimes.count()).toBe(1);
            expect(again.runtimes.contexts_().map((context) => context.storyId)).toEqual([storyId]);
            expect((await call(again, 'GET', `/stories/${storyId}/knowledge`)).status).toBe(200);
        } finally {
            await again.runtimes.close();
            removeRoot(root);
        }
    });
});

// --------------------------------------------------------------------------------
// 6. One feed for every book, including the book that does not exist yet
// --------------------------------------------------------------------------------

describe('GET /stream fans every book, including a Story created after the client connected', () => {
    it(
        'sends `ready`, then each new Story’s id, on one connection and with no reconnect',
        async () => {
            // THE REAL TRANSPORT, ON PURPOSE: the feed is a long-lived chunked body, and reading it from the
            // in-process `app.request` response proved to be a delivery race rather than a test of the server.
            // This case therefore boots the listening process the dashboard actually talks to. The fan-in's
            // reachability without a socket is pinned in `runtime/story-isolation-runtimes.test.ts`; what is
            // pinned HERE is that the frames are written and arrive, tagged with the Story that moved.
            const root = scratch('stream-fan');
            const server = await startStorylineServer({
                port: 0,
                staticRoot: null,
                storeRoot: root,
                env: {},
                noAssistantSeed: true,
                chat: new MockChatClient(() => ({
                    message: { content: 'The watchtower stood over the pass, and the map it was built from was wrong.' }
                })),
                // The sweep timer is longer than the case: the only commits on the wire are the two Stories
                // themselves, so the frame list has nothing in it but what this test caused.
                engineConfig: { autoSweep: false, sweepIntervalMs: 60_000 },
                streamDebounceMs: 5
            });
            const base = `http://127.0.0.1:${server.port}/v1/storyline`;
            const controller = new AbortController();

            try {
                const response = await fetch(`${base}/stream`, { signal: controller.signal });
                const reader = response.body!.getReader();
                const decoder = new TextDecoder();
                const lines: string[] = [];

                // ONE read in flight at a time. A `Promise.race` that re-arms `reader.read()` on every tick
                // throws away the losing read's resolved chunk, which is how a quiet workspace's single frame
                // was dropped here; a plain sequential drain keeps every byte. The abort at the end makes the
                // last read reject, so the drain swallows exactly that and nothing else.
                const draining = (async (): Promise<void> => {
                    for (;;) {
                        const { value, done } = await reader.read();

                        if (done) return;

                        if (value === undefined) continue;

                        for (const line of decoder.decode(value).split('\n')) {
                            if (line.startsWith('event:') || line.startsWith('data:')) lines.push(line.trim());
                        }
                    }
                })().catch(() => undefined);

                // Deadlines only schedule the reads; every assertion below is on exact frame text.
                const arrives = async (predicate: () => boolean, withinMs = 5_000): Promise<boolean> => {
                    const stopAt = Date.now() + withinMs;

                    while (!predicate() && Date.now() < stopAt) {
                        await new Promise((resolve) => setTimeout(resolve, 25));
                    }

                    return predicate();
                };

                const createStory = async (idea: string, title: string): Promise<string> => {
                    const created = await fetch(`${base}/stories`, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ idea, title, chapter_count: 1 })
                    });
                    const row = (await created.json()) as { id: string };

                    expect(created.status).toBe(200);

                    return row.id;
                };

                expect(await arrives(() => lines.length >= 2)).toBe(true);

                // The `ready` frame is what lets a client tell a live stream from a buffered proxy (L-24).
                expect(lines[0]).toBe('event: ready');
                expect(lines[1]).toBe('data:');

                // A Story created while the stream is open moves the feed on its own: the registry's fan-in
                // covers books opened after the subscription, so this pane does not wait for a reload.
                const first = await createStory(IDEA_B, 'Reservoir');

                expect(await arrives(() => lines.includes(`data: ${first}`))).toBe(true);
                expect(lines).toContain('event: story');

                // A second Story, in a second book, on the same connection. Two books both journal `finding_0`
                // at `seq` 1, so the frame has to name the Story that moved — a feed that merges them into one
                // pane cannot be clicked, and this one never names a book this server does not hold.
                const second = await createStory(IDEA_A, 'Lighthouse');

                expect(await arrives(() => lines.includes(`data: ${second}`))).toBe(true);

                expect(lines.filter((line) => line === 'event: story')).toHaveLength(2);
                expect(
                    lines.filter((line) => line.startsWith('data: ')).sort()
                ).toEqual([`data: ${first}`, `data: ${second}`].sort());

                // The drain never resolves while the body is open, so the shutdown ordering is: unsubscribe
                // (the drain sees `done`), then close, then drop the files.
                reader.cancel();
                await draining;
            } finally {
                controller.abort();
                await server.close();
                removeRoot(root);
            }
        },
        // Two HTTP round trips plus a live body: the default 5s budget is tight on a loaded machine.
        30_000
    );
});

// --------------------------------------------------------------------------------
// 7. The Author's ask spawns a run IN the Story's book — the one book that can hold it
// --------------------------------------------------------------------------------

describe('POST /stories/:id/assistant spawns through the Story’s own executor', () => {
    it(
        'lands the run row in the Story’s book, keeps the app book run-free, and reuses the local id per book',
        async () => {
            // THE ASSISTANT CREW, ON PURPOSE: the ask names the `assistant` template (§8.6), the crew is seeded
            // into the APP book, and every Story's catalogue is a copy of it — so this case takes the shipped
            // seed the catalogue-exactness cases opt out of.
            await withWorkspace(
                'assistant-spawn',
                async (opened) => {
                    const [a, b] = await createTwoStories(opened);

                    const asked = await call(opened, 'POST', `/stories/${a}/assistant`, {
                        text: 'what is the spine of this?',
                        target: 'summary'
                    });

                    expect(asked.status).toBe(200);
                    // The row the route answers with is the Story's own run: the id is book-LOCAL, and the row
                    // carries the uuid the path named. `working` is what the handler read back synchronously —
                    // `RunExecutor.execute` writes the row before its first await (D-18), which is the whole
                    // reason this route can answer with a live run at all.
                    expect(
                        [
                            asked.body.id,
                            asked.body.story_id,
                            asked.body.kind,
                            asked.body.role,
                            asked.body.state,
                            asked.body.work_item_ref
                        ]
                    ).toEqual(['run_0', a, 'assistant', 'writer', 'working', `assistant_${a}_1`]);

                    const bookA = opened.runtimes.storeFor(a) as Store;

                    expect(bookA.runs.list().map((row) => [row.id, row.kind, row.story_id])).toEqual([
                        ['run_0', 'assistant', a]
                    ]);

                    // THE ISOLATION HALF, and the regression this case exists for: the app book (`<root>/server/`)
                    // is the one book in the workspace that holds no Story, so a run row written there has no
                    // story to attach to and the row fence refuses it. `RunExecutor` writes into the book it was
                    // built over, and `deps.executor` is built over the app book — asking through it answered 409
                    // (`no run row, no run`) for a run that had in fact started.
                    expect(opened.runtimes.appConfig.book.runs.list()).toEqual([]);

                    // A second ask is a second row in the same book, and its claim key moves per ask (§9) so it
                    // is not deduped into the first run's shadow.
                    const again = await call(opened, 'POST', `/stories/${a}/assistant`, {
                        text: 'and the ending?',
                        target: 'directive'
                    });

                    expect([again.status, again.body.id, again.body.work_item_ref]).toEqual([
                        200,
                        'run_1',
                        `assistant_${a}_2`
                    ]);
                    expect(bookA.runs.list().map((row) => row.id)).toEqual(['run_0', 'run_1']);

                    // Another Story, the same LOCAL id: two books, two `run_0` rows, kept apart by the `story_id`
                    // each row already carries — the aggregate never merges them into one clickable run.
                    const askedB = await call(opened, 'POST', `/stories/${b}/assistant`, {
                        text: 'what is the spine of this?',
                        target: 'summary'
                    });

                    expect([askedB.status, askedB.body.id, askedB.body.story_id]).toEqual([200, 'run_0', b]);
                    expect((opened.runtimes.storeFor(b) as Store).runs.list().map((row) => [row.id, row.kind])).toEqual([
                        ['run_0', 'assistant']
                    ]);

                    // Books in book order, each book's rows in its own order, and the Story filter narrows to
                    // one book — including the Story this workspace has never opened, which answers empty
                    // rather than every run in the workspace.
                    expect(
                        (await call(opened, 'GET', '/runs')).body.map((row: Run) => [row.story_id, row.id, row.kind])
                    ).toEqual([
                        [a, 'run_0', 'assistant'],
                        [a, 'run_1', 'assistant'],
                        [b, 'run_0', 'assistant']
                    ]);
                    expect(
                        (await call(opened, 'GET', `/runs?story_id=${a}`)).body.map((row: Run) => [row.id, row.kind])
                    ).toEqual([
                        ['run_0', 'assistant'],
                        ['run_1', 'assistant']
                    ]);
                    expect((await call(opened, 'GET', `/runs?story_id=${FOREIGN}`)).body).toEqual([]);

                    // The Story's own region reads back the same two rows from its own book, and nothing from a
                    // sibling: B's `run_0` is not in A's view, and A's `run_1` is not in B's.
                    expect(
                        ((await call(opened, 'GET', `/stories/${a}`)).body.runs as Run[]).map((row) => row.id)
                    ).toEqual(['run_0', 'run_1']);
                    expect(
                        ((await call(opened, 'GET', `/stories/${b}`)).body.runs as Run[]).map((row) => row.id)
                    ).toEqual(['run_0']);

                    // The app book stays run-free for the whole case: no ask, no filter, no aggregate ever put
                    // a Story's row back into it.
                    expect(opened.runtimes.appConfig.book.runs.list()).toEqual([]);
                },
                { assistant: true }
            );
        },
        // A real executor runs the ask against the model double; give it room beyond the default 5s.
        20_000
    );
});

// --------------------------------------------------------------------------------
// 8. DELETE /stories/:id — one coordinated purge: the Story's WHOLE book goes, nothing else does
// --------------------------------------------------------------------------------

describe('DELETE /stories/:id purges the Story, its folder and its context', () => {
    it(
        'removes store.json, the journal and the harness files, unloads the runtime, leaves the other Story byte-identical, and stays gone after a restart',
        async () => {
            const root = scratch('delete-purge');
            const first = await boot(root);

            try {
                const [a, b] = await createTwoStories(first);

                // A lived-in Story: a desk row of its own (the dial off, so the confirmed finding stays
                // the Author's call), and a LIVE run row the delete has to stop and settle before the folder
                // is removed. Story B gets the same LOCAL ids so "nothing moved" is a comparison a collision
                // could not fake.
                for (const [storyId, detail] of [
                    [a, 'a1'],
                    [b, 'b1']
                ] as const) {
                    const book = first.runtimes.storeFor(storyId) as Store;

                    await book.commit('author_desk', (tx) => {
                        tx.stories.update(storyId, { auto_approve: [] }, AUTHOR);
                        tx.findings.create(confirmedFinding(storyId, detail), AUTHOR);
                    });
                }

                (first.runtimes.storeFor(a) as Store).runs.create(liveRun(a, '2026-11-24T10:00:00.000Z'), AUTHOR);

                // Host configuration the app book owns, so "the app config survives" is an exact comparison
                // rather than a shape: the ceiling the Author moved, and the catalogue every Story copies.
                expect((await call(first, 'PATCH', '/loop', { global_max_concurrent: 3 })).body).toEqual({
                    global_max_concurrent: 3,
                    live_runs: 1
                });

                const catalogue = first.runtimes.appConfig.templates().map((row) => row.name);

                // Both books derive their nine articles, so "the projection is gone" and "the sibling's is
                // still open" are both observable rather than assumed.
                expect((await call(first, 'GET', `/stories/${a}/knowledge`)).body.sections).toHaveLength(9);
                expect((await call(first, 'GET', `/stories/${b}/knowledge`)).body.sections).toHaveLength(9);

                const contextA = first.runtimes.requires(a);
                const contextB = first.runtimes.requires(b);

                expect(existsSync(path.join(storyDirectoryPath(root, a), STORE_FILE))).toBe(true);
                expect(existsSync(path.join(storyDirectoryPath(root, a), JOURNAL_FILE))).toBe(true);
                expect(existsSync(path.join(storyDirectoryPath(root, a), HARNESS_DIRECTORY))).toBe(true);

                // Flush first: "byte-identical" has to compare settled files, not a pending debounce. The
                // knowledge projection has its own barrier, and `harness/` is part of the comparison, so it
                // is flushed too — a late article write must not read as the delete moving a neighbour's file.
                await first.runtimes.persistAll();
                await contextA.knowledge.flush();
                await contextB.knowledge.flush();

                const beforeB = {
                    store: readFileSync(path.join(storyDirectoryPath(root, b), STORE_FILE), 'utf-8'),
                    journal: readFileSync(path.join(storyDirectoryPath(root, b), JOURNAL_FILE), 'utf-8'),
                    harness: readdirSync(path.join(storyDirectoryPath(root, b), HARNESS_DIRECTORY)).sort(),
                    findings: (first.runtimes.storeFor(b) as Store).findings
                        .list()
                        .map((row) => [row.id, row.story_id, row.detail])
                };

                const deleted = await call(first, 'DELETE', `/stories/${a}`);

                expect(deleted).toEqual({ status: 200, body: { deleted: a } });

                // The book itself: folder, `store.json`, journal and the whole `harness/` tree, gone
                // together. Only B's folder is left under `stories/`.
                expect(existsSync(storyDirectoryPath(root, a))).toBe(false);
                expect(readdirSync(path.join(root, STORIES_DIRECTORY)).sort()).toEqual([b]);

                // The runtime is UNLOADED — no context, no book, no projection, no sweep visit — so the
                // process holds no memory of a Story the Author deleted.
                expect(first.runtimes.count()).toBe(1);
                expect(first.runtimes.contexts_().map((context) => context.storyId)).toEqual([b]);
                expect(first.runtimes.contextOf(a)).toBeUndefined();
                expect(first.runtimes.storeFor(a)).toBeUndefined();
                // A closed projection answers `null`; the sibling's is still open and still complete.
                expect(contextA.knowledge.tree(a)).toBeNull();
                expect(contextB.knowledge.tree(b)?.sections).toHaveLength(9);

                // The HTTP face agrees with the disk: the Story is gone from every listing, its runs went
                // with it, and its desk row is no longer on the Author's queue.
                expect((await call(first, 'GET', `/stories/${a}`)).status).toBe(404);
                expect(((await call(first, 'GET', '/stories')).body as { id: string }[]).map((row) => row.id)).toEqual(
                    [b]
                );
                expect((await call(first, 'GET', '/runs')).body).toEqual([]);
                expect((await call(first, 'GET', '/loop')).body).toEqual({ global_max_concurrent: 3, live_runs: 0 });
                expect(
                    ((await call(first, 'GET', '/queue')).body as { kind: string; id: string; story_id: string }[]).map(
                        (item) => [item.kind, item.id, item.story_id]
                    )
                ).toEqual([['finding', 'finding_0', b]]);

                // Story B, byte for byte: same `store.json`, same journal, same harness files, same
                // `finding_0` under its own Story. A delete that journalled into the neighbour, or that
                // re-materialised its articles, fails here rather than at the next restart.
                expect(readFileSync(path.join(storyDirectoryPath(root, b), STORE_FILE), 'utf-8')).toBe(beforeB.store);
                expect(readFileSync(path.join(storyDirectoryPath(root, b), JOURNAL_FILE), 'utf-8')).toBe(beforeB.journal);
                expect(readdirSync(path.join(storyDirectoryPath(root, b), HARNESS_DIRECTORY)).sort()).toEqual(
                    beforeB.harness
                );
                expect((first.runtimes.storeFor(b) as Store).findings
                    .list()
                    .map((row) => [row.id, row.story_id, row.detail])).toEqual(beforeB.findings);

                // And the host configuration is exactly what it was: the ceiling the Author set, the whole
                // catalogue, and the app book still on disk where the registry reads it back.
                expect(first.runtimes.appConfig.templates().map((row) => row.name)).toEqual(catalogue);
                expect(first.runtimes.appConfig.getGlobalMaxConcurrent()).toBe(3);
                expect(existsSync(path.join(root, SERVER_DIRECTORY, STORE_FILE))).toBe(true);

                await first.runtimes.close();

                // THE RESTART — the shape the defect shipped as. Before the folder was removed, a restart
                // reopened the deleted Story's book as a live context over a Story that no longer existed;
                // now the registry has one book to load and the workspace has one Story to answer for.
                const second = await boot(root);

                try {
                    expect(second.runtimes.count()).toBe(1);
                    expect(second.runtimes.contexts_().map((context) => context.storyId)).toEqual([b]);
                    expect(second.runtimes.contextOf(a)).toBeUndefined();
                    expect(second.runtimes.storeFor(a)).toBeUndefined();
                    expect((await call(second, 'GET', `/stories/${a}`)).status).toBe(404);
                    expect(
                        ((await call(second, 'GET', '/stories')).body as { id: string }[]).map((row) => row.id)
                    ).toEqual([b]);
                    expect((await call(second, 'GET', '/runs')).body).toEqual([]);
                    // The host settings survived the restart exactly as they survived the delete.
                    expect((await call(second, 'GET', '/loop')).body).toEqual({
                        global_max_concurrent: 3,
                        live_runs: 0
                    });
                    expect(second.runtimes.appConfig.templates().map((row) => row.name)).toEqual(catalogue);
                    // B's rows and articles are still its own, read from its own book.
                    expect((second.runtimes.storeFor(b) as Store).findings.list().map((row) => row.id)).toEqual([
                        'finding_0'
                    ]);
                    expect((await call(second, 'GET', `/stories/${b}/knowledge`)).body.sections).toHaveLength(9);
                } finally {
                    await second.runtimes.close();
                }
            } finally {
                removeRoot(root);
            }
        },
        // Two full workspace boots (the second is the restart leg) against the model double.
        20_000
    );
});
