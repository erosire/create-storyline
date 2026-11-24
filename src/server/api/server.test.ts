// §10 / W9-W13 — the boot: the runtime builder, the listener, the SSE transport, and the CLI flags (T7).
//
// WHAT `routes.test.ts` does NOT cover, and this file does: the things that only exist once the server is
// a PROCESS — a bound port, a mounted static root, a live `text/event-stream`, the provider triple read
// from the environment, §8.6's template seed, and the flag grammar the operator types.
//
// WHY `startStorylineServer({ port: 0 })`: an OS-assigned port keeps the suite parallel-safe, and the
// handle reporting the port it ACTUALLY bound is the half that makes a real `fetch` over a real socket
// possible. That round trip is the proof the mount root (`/v1/storyline`) is the one the dashboard's
// `API_ROOT` constant dials — a router-only test cannot show it.
import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MockChatClient, msg } from '../llm/mock';
import { parseArgs, HELP_TEXT, bootBanner } from '../cli';
import { bootStorylineServer, createStorylineApp, openStore } from '../main';
import { resolveServerConfig } from '../config';
import { Store, StoryStores, STORY_ID_PATTERN } from '../store';
import { buildStorylineRuntime, startStorylineServer } from './server';
import type { Run, Story } from '../../shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const quietChat = (): MockChatClient => new MockChatClient(() => ({ message: msg({ content: 'nothing to report' }) }));

/**
 * Reads the stream until `needle` arrives. The SSE handler is push-based and debounced, so the only
 * honest assertion is "this frame came out"; the cap turns a silent stream into a failure naming the
 * frame, rather than a vitest timeout.
 *
 * The pending `read()` is carried between ticks on purpose: a plain race would drop whichever chunk
 * arrived while the timer won, and a dropped frame reads as a lost push.
 */
async function readUntil(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    needle: string,
    limitMs = 3_000
): Promise<string> {
    const decoder = new TextDecoder();

    let text = '';
    let pending: Promise<{ done: boolean; value?: Uint8Array }> | undefined;

    for (let elapsed = 0; !text.includes(needle) && elapsed < limitMs; elapsed += 25) {
        pending = pending ?? reader.read().catch(() => ({ done: true, value: undefined }));

        const read = await Promise.race([pending, new Promise<undefined>((resolve) => setTimeout(resolve, 25))]);

        if (read === undefined) continue;

        pending = undefined;
        if (read.done) break;
        if (read.value !== undefined) text += decoder.decode(read.value, { stream: true });
    }

    if (!text.includes(needle)) throw new Error(`the stream never sent ${needle} (got: ${JSON.stringify(text)})`);

    return text;
}

// ---------------------------------------------------------------------------
// The runtime builder
// ---------------------------------------------------------------------------

describe('the runtime builder', () => {
    it('defaults the model transport from the provider triple, and honours the overrides', () => {
        const store = Store.empty();

        const built = buildStorylineRuntime({ store, chat: quietChat(), engineConfig: { autoSweep: false }, env: {} });

        expect(built.defaultModel).toBe('local/basalt');

        const dialed = buildStorylineRuntime({
            store: Store.empty(),
            chat: quietChat(),
            engineConfig: { autoSweep: false },
            env: { STORYLINE_PROVIDER_MODEL: 'deepseek-r1', STORYLINE_PROVIDER_BASE_URL: 'http://relay:1234/v1' }
        });

        expect(dialed.defaultModel).toBe('deepseek-r1');
    });

    it('seeds §8.6 assistant harness exactly once, whatever the boot order', () => {
        const store = Store.empty();

        buildStorylineRuntime({ store, chat: quietChat(), engineConfig: { autoSweep: false }, env: {} });
        buildStorylineRuntime({ store, chat: quietChat(), engineConfig: { autoSweep: false }, env: {} });

        // The engine seeds the built-in catalogue by slug inside `createStory`, so a second boot must not
        // put a second assistant card on the wall (D-17b: assignment refs are names, not counters).
        expect(store.templates.list().filter((row) => row.name === 'assistant').length).toBe(1);
    });

    it('mounts the surface at the one root the dashboard dials', async () => {
        const { app } = buildStorylineRuntime({
            store: Store.empty(),
            chat: quietChat(),
            engineConfig: { autoSweep: false },
            env: {}
        });

        const response = await app.request('http://localhost/v1/storyline/stories');

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual([]);

        // Anything outside that root is not this server's business (the gateway owns the rest of the URL).
        expect((await app.request('http://localhost/stories')).status).toBe(404);
    });
});

// ---------------------------------------------------------------------------
// The listener (W9)
// ---------------------------------------------------------------------------

describe('the listener', () => {
    it('serves the pinned root over a real socket and closes cleanly', async () => {
        const handle = await startStorylineServer({
            port: 0,
            host: '127.0.0.1',
            store: Store.empty(),
            chat: quietChat(),
            engineConfig: { autoSweep: false },
            env: {}
        });

        // `--port 0` is the operator's "I do not care", and the handle is what tells the dashboard where
        // the OS actually put it.
        expect(handle.port).toBeGreaterThan(0);

        const base = `http://127.0.0.1:${handle.port}/v1/storyline`;

        const created = await fetch(`${base}/stories`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'Booted', idea: 'A chart that redraws itself.', chapter_count: 1 })
        });
        const story = (await created.json()) as { id: string; status: string };

        expect(story).toEqual({
            id: 'story_0',
            title: 'Booted',
            phase: 'summary',
            status: 'ready',
            pending_kind: 'none',
            status_reason: 'phase summary is open: the Seed is being expanded (L-29 stops it at the lock)',
            summary_locked: false,
            plotlines_locked: false,
            levels: { summary: '1/2 · failing: C-14', plotlines: 'n/a', chapters: 'n/a', whole: 'n/a' },
            trend: 'unknown',
            // The POST body omitted the dial, so D-35's shipped default lands (critical + major + minor).
            auto_approve: ['critical', 'major', 'minor'],
            active_runs: 0,
            completion_proposed: false
        });

        expect((await fetch(`${base}/stories/story_0`)).status).toBe(200);

        await handle.close();

        const after = await fetch(`${base}/stories`).then(
            () => 'open',
            () => 'closed'
        );

        expect(after).toBe('closed');
    });

    it('answers the API without a built dashboard, and says so (U-12)', async () => {
        const handle = await startStorylineServer({
            port: 0,
            host: '127.0.0.1',
            store: Store.empty(),
            chat: quietChat(),
            engineConfig: { autoSweep: false },
            staticRoot: '/definitely/not/built',
            env: {}
        });

        const page = await fetch(`http://127.0.0.1:${handle.port}/`);
        const body = (await page.json()) as { error: string };

        expect(page.status).toBe(404);
        expect(body.error).toBe(
            'the dashboard is not built — run `yarn build`, or use `yarn dev` for the Vite dev server.'
        );

        // An extension-less path is a client route, an extension is an asset, and only the first gets the
        // app-shell answer.
        const asset = await fetch(`http://127.0.0.1:${handle.port}/assets/index-abc123.js`);

        expect(asset.status).toBe(404);
        expect(((await asset.json()) as { error: string }).error).toBe(
            '/assets/index-abc123.js is not in the built dashboard.'
        );

        // The API stays reachable at the pinned root even with a static mount in front of it.
        expect((await fetch(`http://127.0.0.1:${handle.port}/v1/storyline/queue`)).status).toBe(200);

        await handle.close();
    });
});

// ---------------------------------------------------------------------------
// W9 — the book the listener boots with
// ---------------------------------------------------------------------------

describe('W9 — the store root at boot', () => {
    /**
     * One Story, created over the socket so the boot path under test is the shipped one.
     *
     * S-RUNTIME: the id the route answers with is the Story's identity AND its directory name, so it
     * is the only way back to the book — these two tests read the row out of the registry by it. It is
     * a UUID (`persist.ts:newStoryId`), never a `story_<n>` counter: an unbound flat book mints those,
     * a workspace never does, and asserting the shape here is what stops a future change from quietly
     * putting the counter back.
     */
    const createOverSocket = async (port: number, title: string): Promise<string> => {
        const created = await fetch(`http://127.0.0.1:${port}/v1/storyline/stories`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title, idea: 'A keeper trades years for one night of memory.', chapter_count: 1 })
        });

        expect(created.status).toBe(200);

        const story = (await created.json()) as { id: string };

        expect(STORY_ID_PATTERN.test(story.id)).toBe(true);

        return story.id;
    };

    it('keeps an explicitly in-memory run in memory (W9: `--store-root ""`)', async () => {
        // `null` is the RESOLVED form of the switch, and `null ?? default` is the bug this pins: the
        // banner says "this run leaves no book behind", so the store must have no root at all.
        const handle = await bootStorylineServer({
            storeRoot: null,
            port: 0,
            host: '127.0.0.1',
            staticRoot: null,
            chat: quietChat(),
            engineConfig: { autoSweep: false },
            env: {}
        });

        try {
            // S-RUNTIME: a workspace boot's `handle.store` is the APP-CONFIG book — in memory here, so
            // it has no root — and it holds the crew catalogue and the host settings, never a Story row.
            expect(handle.store.rootDir).toBeNull();
            expect(handle.store.stories.list()).toEqual([]);

            const storyId = await createOverSocket(handle.port, 'In Memory');
            const book = handle.runtimes.requires(storyId).store;

            // The Story is in its own in-memory book, keyed by the UUID the registry allocated
            // (`store/story-stores.ts:create`), which is also the id the row carries.
            expect(book.rootDir).toBeNull();
            expect(book.stories.list().map((row) => [row.id, row.title])).toEqual([[storyId, 'In Memory']]);
        } finally {
            await handle.close();
        }
    });

    it('opens a durable book when the root is a directory, and the next boot reads it back (W1, L-3)', async () => {
        // `os.tmpdir()` follows `TMPDIR`, which the suite points at the repo's own `Temp/`.
        const root = await mkdtemp(path.join(tmpdir(), 'storyline-book-'));

        const handle = await bootStorylineServer({
            storeRoot: root,
            port: 0,
            host: '127.0.0.1',
            staticRoot: null,
            chat: quietChat(),
            engineConfig: { autoSweep: false },
            env: {}
        });

        // `storyId` is read AGAIN below the `finally`, after the book has been closed and re-opened, so
        // it is declared outside the try-block that mints it. It starts empty only to keep the later
        // reads in scope: a create that throws propagates through `finally` and never reaches them.
        let storyId = '';

        try {
            // S-RUNTIME: the workspace splits the root — `handle.store` is `<root>/server/` (the app
            // book: catalogue + host settings), and the Story the POST below creates lives in
            // `<root>/stories/<uuid>/`. Reading the app book's Story list would answer `[]` forever,
            // which is the drift this assertion now pins instead.
            expect(handle.store.rootDir).toBe(path.join(root, 'server'));

            storyId = await createOverSocket(handle.port, 'Durable');

            expect(handle.runtimes.requires(storyId).store.rootDir).toBe(path.join(root, 'stories', storyId));
        } finally {
            // `close()` is the flush (L-3): the snapshot and the journal are on disk when it resolves.
            await handle.close();
        }

        // The proof is not a file format assertion but the Author's promise: re-open the root and the
        // Story is still there. `StoryStores.open` is the shipped opener for a WORKSPACE root — it
        // refuses a pre-per-story flat `store.json` and loads one book per `<root>/stories/<uuid>/`
        // folder, cross-checking each book's `story_id` binding (`store/store.ts:loadStory`).
        const reopened = await StoryStores.open(root);

        try {
            expect(reopened.ids()).toEqual([storyId]);
            expect(reopened.rootOf(storyId)).toBe(path.join(root, 'stories', storyId));
            expect(reopened.require(storyId).stories.list().map((row) => [row.id, row.title])).toEqual([
                [storyId, 'Durable']
            ]);
        } finally {
            await reopened.close();
        }
    });
});

// ---------------------------------------------------------------------------
// §10 — the SSE channel
// ---------------------------------------------------------------------------

describe('§10 — the event stream', () => {
    it('pushes the pinned topics with the affected Story id as `data:`', async () => {
        const { app } = buildStorylineRuntime({
            store: Store.empty(),
            chat: quietChat(),
            engineConfig: { autoSweep: false },
            streamDebounceMs: 5,
            env: {}
        });

        const response = await app.request('http://localhost/v1/storyline/stream');

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/event-stream');

        const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;

        // The first frame is the liveness proof: a client that sees it knows the stream is not buffered
        // behind a proxy, which is what the client's 5s poll fallback is for (L-24).
        expect(await readUntil(reader, 'event: ready')).toContain('event: ready');

        await app.request('http://localhost/v1/storyline/stories', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'Streamed', idea: 'A chart that redraws itself.', chapter_count: 1 })
        });

        const frames = await readUntil(reader, 'event: story');

        expect(frames).toContain('event: story');
        expect(frames).toContain('data: story_0');

        // A run row moves the CREW topic as well as the Story row's `active_runs` (U-1, U-7).
        const assistant = await app.request('http://localhost/v1/storyline/stories/story_0/assistant', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ target: 'summary', text: 'tighten the promise line' })
        });
        const run = (await assistant.json()) as Run;

        const crewFrames = await readUntil(reader, `event: runs`);

        expect(crewFrames).toContain(`data: ${run.story_id}`);

        await reader.cancel();
    });
});

// ---------------------------------------------------------------------------
// The mount entry (`main.ts`)
// ---------------------------------------------------------------------------

describe('the mount entry', () => {
    it('opens an in-memory book when the store root is empty', async () => {
        const store = await openStore(null);

        store.stories.create(
            {
                title: 'Scratch',
                phase: 'summary',
                idea: 'x',
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
            },
            { run_ref: null, author: true, why: 'fixture: an in-memory book is still a book (P1)' }
        );

        // W1's contract: `Store.empty()` journals every write and persists none — the flag the CLI prints.
        expect(store.journal.length).toBe(1);
    });

    it('hands an embedding host the mounted app plus the engine handle', async () => {
        const runtime = await createStorylineApp({
            storeRoot: null,
            chat: quietChat(),
            engineConfig: { autoSweep: false },
            env: {}
        });

        const created = await runtime.app.request('http://localhost/v1/storyline/stories', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'Mounted', idea: 'A lighthouse with no keeper.', chapter_count: 1 })
        });

        expect(created.status).toBe(200);

        const story = (await created.json()) as { id: string };

        // S-RUNTIME: the mount entry on a store root opens a WORKSPACE, so `runtime.store` is the app
        // book and the Story's rows are in the book the coordinator allocated for its UUID. `requires`
        // is the coordinator's own verb and its error names the missing Story, which is what a host
        // reading its own mount needs when it hands back an id from another book.
        expect((runtime.runtimes.requires(story.id).store.stories.require(story.id) as Story).title).toBe('Mounted');

        // L-1: the mount entry does NOT start the loop — the host starts it when it is ready.
        runtime.engine.start();
        runtime.engine.stop();

        // S-RUNTIME: `runtimes.close()` is the whole shutdown — every Story's projection and harness,
        // then every book, then the app book. Closing only `runtime.store` would flush the
        // configuration and leave each Story's journal unwritten.
        await runtime.runtimes.close();
    });
});

// ---------------------------------------------------------------------------
// The CLI flag grammar (`cli.ts` → `config.ts`)
// ---------------------------------------------------------------------------

describe('the CLI flags', () => {
    it('accepts both spellings of a value flag, and keeps the last one', () => {
        expect(parseArgs(['--port', '5050', '--host=0.0.0.0', '--no-static'])).toEqual({
            port: '5050',
            host: '0.0.0.0',
            noStatic: true,
            help: false
        });
        expect(parseArgs(['--port', '5050', '--port', '5060'])).toEqual({ port: '5060', noStatic: false, help: false });
    });

    it('passes an explicit blank store root through as the in-memory switch', () => {
        const flags = parseArgs(['--store-root', '']);

        expect(flags.storeRoot).toBe('');

        // The chain the operator gets: flag → env → default, resolved in one place. The package root and the
        // filesystem probe are injected so the answer does not depend on what this checkout happens to have
        // built (the store root is about the BOOK; `dist/` is about the UI — U-12).
        const config = resolveServerConfig({ flags, env: {}, packageRoot: '/pkg', exists: () => false });

        expect(config.port).toBe(5000);
        expect(config.host).toBe('127.0.0.1');
        expect(config.storeRoot).toBeNull();
        expect(config.staticRoot).toBeNull();

        // The other half of the probe: with a build present, the default serves it.
        expect(resolveServerConfig({ flags: {}, env: {}, packageRoot: '/pkg', exists: () => true }).staticRoot).toBe(
            '/pkg/dist'
        );
        expect(
            resolveServerConfig({ flags: { noStatic: true }, env: {}, packageRoot: '/pkg', exists: () => true })
                .staticRoot
        ).toBeNull();
    });

    it('names the option it does not know instead of guessing', () => {
        expect(() => parseArgs(['--oops'])).toThrow(
            'unknown option "--oops". Run with --help for the options this server takes.'
        );
        expect(() => parseArgs(['--port'])).toThrow(
            '--port needs a value. Run with --help for the options this server takes.'
        );
    });

    it('prints the resolved boot for the operator, not the flags it was given', () => {
        const handle = {
            port: 5050,
            host: '127.0.0.1',
            app: {} as never,
            store: { close: async () => undefined } as never,
            engine: {} as never,
            // S-RUNTIME: the banner's "durable — N Stories" line comes from the COORDINATOR
            // (`cli.ts:bootBanner` reads `handle.runtimes.count()`), and the handle's shutdown is
            // `runtimes.close()` — the flush of every Story book and the app book. A hand-built
            // handle without it is not a handle the CLI could close.
            runtimes: { count: () => 1, close: async () => undefined } as never,
            defaultModel: 'm',
            close: async () => undefined
        } as never;

        const lines = bootBanner(handle, { storeRoot: null }, { STORYLINE_PROVIDER_MODEL: 'deepseek-r1' });

        expect(lines[0]).toBe('Storyline is listening on http://127.0.0.1:5050/v1/storyline');
        expect(lines[2]).toBe('harness: http://localhost:8800/providers/private/v1 · model deepseek-r1');
        expect(lines[3]).toContain('in-memory');

        // The durable half of the same sentence names the TWO directories a workspace boot opens, and
        // the Story count the coordinator actually holds: an operator told "durable" is told what is
        // behind the run, not just that a root was typed (`cli.ts:bootBanner`).
        expect(
            bootBanner(handle, { storeRoot: '/books' }, {})[3]
        ).toBe(
            'book: durable — 1 Story · store.json + journal.jsonl under /books/stories/<uuid> · configuration under /books/server'
        );
        expect(HELP_TEXT).toContain('--store-root <dir>');
    });
});
