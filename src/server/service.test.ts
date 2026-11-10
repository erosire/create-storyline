// The `/v1/storyline` remount (R1) — unit level, with an injected runtime so no
// listener, no database and no provider is involved. What these tests pin is the one
// thing this package adds to the harness API: the mount translation in both
// directions, plus the root-keyed runtime resolution around it.
import { describe, expect, it } from 'vitest';
import { createHarnessRuntime } from '@underload/harness/server';
import type { HarnessRuntime, ServiceEndpointParameters } from '@underload/harness/server';
import { createStorylineHarnessRegistry } from './presets';
import {
    STORYLINE_DEFAULT_TITLE,
    STORYLINE_MOUNT,
    STORYLINE_ROOT_ROUTE,
    STORYLINE_STREAM_ROUTE,
    STORYLINE_WILDCARD_ROUTE,
    clearStorylineRuntimes,
    configureStorylineRuntime,
    createStorylineServiceHandler,
    createStorylineServiceUpgrade,
    storylineRuntimeCount,
    storylineRuntimeSettings
} from './service';

const SETTINGS = { baseURL: 'http://127.0.0.1:1/v1', apiKey: '', model: 'story/test-model' };
const DEFAULTS = { baseURL: SETTINGS.baseURL, model: SETTINGS.model, hasApiKey: false };

// `loadEnvironment: false` is not cosmetic: the default path reads the harness
// package's `.env` into `process.env` on the first request, which would make this
// file depend on a file a developer may or may not have.
const runtimeFor = (): HarnessRuntime =>
    createHarnessRuntime({
        loadEnvironment: false,
        settings: SETTINGS,
        defaults: DEFAULTS,
        registry: createStorylineHarnessRegistry()
    });

const harness = createStorylineServiceHandler({ runtime: runtimeFor() });

// The structural shape of a request: `header` answers `host` because the harness
// adapter's Origin gate compares the Origin against it, and `raw.method` is the verb
// the dispatcher uses. Everything else (the body stream, the abort signal) stays
// absent, which is what a body-less GET looks like.
const contextFor = (path: string, method = 'GET') => ({
    req: {
        path,
        header: (name: string) => (name.toLowerCase() === 'host' ? '127.0.0.1:5000' : undefined),
        raw: { method, signal: new AbortController().signal }
    }
});

// An explicit `{}` body keeps these unit tests on the loader's pre-parsed path, so
// the handler never tries to read a request stream that does not exist here.
const EMPTY: ServiceEndpointParameters = { body: {} };

describe('storyline mount constants', () => {
    it('declares exactly the three routes the gateway is told about', () => {
        expect(STORYLINE_MOUNT).toBe('/v1/storyline');
        expect(STORYLINE_ROOT_ROUTE).toBe('/v1/storyline');
        expect(STORYLINE_WILDCARD_ROUTE).toBe('/v1/storyline/*');
        expect(STORYLINE_STREAM_ROUTE).toBe('/v1/storyline/stream');
    });
});

describe('storyline REST remount', () => {
    it('answers the boot document at the bare mount and rewrites every link', async () => {
        const result = await harness(contextFor('/v1/storyline') as never, EMPTY, undefined);

        expect(result.status).toBe(200);

        const body = result.response as {
            api_root: string;
            service: string;
            links: Record<string, string>;
        };

        expect(body.api_root).toBe('/v1/storyline');
        expect(body.links.self).toBe('/v1/storyline');
        expect(body.links.sessions).toBe('/v1/storyline/sessions');
        expect(body.links.stream).toBe('/v1/storyline/stream');
        // The whole point of the OUT rewrite: a client booted here must never be
        // handed a path under the root this server does not serve.
        expect(JSON.stringify(result.response).includes('/v1/harness')).toBe(false);
        expect(result.raw).toBeUndefined();
    });

    it('leaves the mount token inside user content byte-identical', async () => {
        const created = await harness(
            contextFor('/v1/storyline/sessions', 'POST'),
            { body: { harness: 'storyline' } },
            undefined
        );
        const sessionId = String((created.response as { session: { id: string } }).session.id);

        // Story prose that happens to QUOTE the harness root. The blunt split/join
        // rewrite (this file's history) turned every such token into `/v1/storyline`,
        // so a chapter read back was not the chapter that was written — the writer's
        // text was corrupted by the transport.
        const CONTENT =
            'The memo said: post the dispatch to /v1/harness/sessions and wait for the epoch. Nothing ever came back.';

        const written = await harness(
            contextFor(`/v1/storyline/sessions/${sessionId}/tools/chapters/executions`, 'POST'),
            {
                body: {
                    parameters: {
                    action: 'add',
                    title: 'The Memo',
                    summary: 'A route that never answers.',
                    content: CONTENT,
                    status: 'draft',
                },
                },
            },
            undefined
        );

        expect(written.status).toBe(200);

        const added = (written.response as { result: { chapter: { id: string; title: string } } }).result;

        // `add` answers the row plus the counts, and NO body: `content` is a getOnly
        // field, so the round trip below is the only way to see what was stored.
        expect(added.chapter.title).toBe('The Memo');

        const read = await harness(
            contextFor(`/v1/storyline/sessions/${sessionId}/tools/chapters/executions`, 'POST'),
            { body: { parameters: { action: 'get', id: added.chapter.id } } },
            undefined
        );

        // The getOnly body rides BESIDE the singular key (core/records.ts:3521), and the
        // rewrite must not touch it: the blunt split/join used to answer
        // `…post the dispatch to /v1/storyline/sessions and wait…` here.
        expect((read.response as { result: { content: string } }).result.content).toBe(CONTENT);
        // The token survived in the serialized body — once, exactly where it was put.
        expect(JSON.stringify(read.response).split('/v1/harness').length - 1).toBe(1);
        // Headers stay consistent with the body they describe: the dispatcher answers
        // epoch/revision only (api.ts:1497 `json`/`withHeaders`) and the gateway
        // serializes and measures `response` AFTER this handler returns, so a body
        // rewrite can never leave a stale length behind.
        expect(read.headers?.['X-Harness-Epoch']).toBeDefined();
        expect(read.headers?.['content-length']).toBeUndefined();
    });

    it('still rewrites the mount in every structural field it owns', async () => {
        // `api_root` (api.ts:1662) and the whole `links` map (api.ts:1647-1658) are the
        // fields the dispatcher BUILDS from the mount it was handed, so they are exactly
        // what a surgical rewrite must keep rewriting — a client booted here may never
        // be handed a path this server does not serve.
        const boot = await harness(contextFor('/v1/storyline') as never, EMPTY, undefined);
        const document = boot.response as { api_root: string; links: Record<string, string> };

        expect(document.api_root).toBe('/v1/storyline');
        expect(document.links).toEqual({
            self: '/v1/storyline',
            health: '/v1/storyline/health',
            config: '/v1/storyline/config',
            harnesses: '/v1/storyline/harnesses',
            agents: '/v1/storyline/agents',
            tools: '/v1/storyline/tools',
            plugins: '/v1/storyline/plugins',
            models: '/v1/storyline/models',
            sessions: '/v1/storyline/sessions',
            stream: '/v1/storyline/stream'
        });
        // `error.message` is structural too: the one closed error envelope
        // (harness-api.ts:288 `ErrorBody`) carries sentences the dispatcher mints FROM
        // the mount — pinned by the 400 and 404 tests above.
        const missing = await harness(contextFor('/v1/storyline/nope') as never, EMPTY, undefined);

        const unknownRoute = (missing.response as { error: { message: string } }).error.message;

        expect(unknownRoute).toBe('Unknown API route: GET /v1/storyline/nope');
    });

    it('serves the config document with the provider triple this host resolved', async () => {
        const result = await harness(contextFor('/v1/storyline/config') as never, EMPTY, undefined);

        expect(result.status).toBe(200);
        expect(result.response).toMatchObject({
            defaults: { base_url: SETTINGS.baseURL, model: SETTINGS.model, has_api_key: false },
            writable_fields: ['settings.base_url', 'settings.model', 'settings.api_key']
        });
    });

    it('creates a storyline session and stamps the contract headers', async () => {
        const result = await harness(
            contextFor('/v1/storyline/sessions', 'POST') as never,
            { body: { harness: 'storyline' } },
            undefined
        );

        expect(result.status).toBe(201);

        const session = (result.response as { session: Record<string, unknown> }).session;

        expect(session.harness).toBe('storyline');
        expect(session.status).toBe('idle');
        expect(session.model).toBe(SETTINGS.model);
        // The roster, as the harness itself resolved it from the preset.
        expect(Object.keys(session.agent_models as Record<string, string>)).toEqual(['writer', 'reader', 'editor']);

        expect(result.headers?.['X-Harness-Epoch']).toBeDefined();
        expect(result.headers?.['X-Harness-Revision']).toBe('1');
    });

    it('lists the presets of this mount through the wildcard, storyline included', async () => {
        // `context.req.path` is the pathname WITHOUT the query (Hono's own contract),
        // and the query rides `parameters.query` — which is how the paginated routes
        // get their `limit`.
        const result = await harness(
            contextFor('/v1/storyline/harnesses') as never,
            { body: {}, query: { limit: '50' } },
            undefined
        );

        expect(result.status).toBe(200);

        const items = (result.response as { items: Record<string, unknown>[] }).items;
        const storyline = items.find((item) => item.name === 'storyline');

        expect(items.map((item) => item.name)).toContain('storyline');
        expect(storyline).toMatchObject({
            name: 'storyline',
            title: 'Storyline',
            primary: 'writer',
            subagents: ['reader', 'editor'],
            agents: ['writer', 'reader', 'editor']
        });
    });

    it('answers a plain GET on the stream path with the 400 the contract declares, naming THIS mount', async () => {
        const result = await harness(contextFor('/v1/storyline/stream') as never, EMPTY, undefined);

        expect(result.status).toBe(400);
        expect((result.response as { error: { message: string } }).error.message).toBe(
            'GET /v1/storyline/stream is a WebSocket upgrade: send Upgrade: websocket and Connection: Upgrade.'
        );
    });

    it('404s an unknown subpath, naming the path the client actually asked for', async () => {
        const result = await harness(contextFor('/v1/storyline/does-not-exist') as never, EMPTY, undefined);

        expect(result.status).toBe(404);
        expect((result.response as { error: { message: string } }).error.message).toBe(
            'Unknown API route: GET /v1/storyline/does-not-exist'
        );
    });

    it('leaves a foreign target to the dispatcher instead of rewriting it', async () => {
        // The declared routes are the storyline ones, so this only happens if another
        // mount hands us its path. Pass-through is the honest answer: the dispatcher
        // resolves it against its own root rather than this package guessing.
        const result = await harness(contextFor('/v1/other/things') as never, EMPTY, undefined);

        expect(result.status).toBe(404);
    });
});

describe('storyline Title contract (R-A, R-B)', () => {
    // The two fields of a create response that are not deterministic content: the generated
    // session id, and the hub's resource revision. Both are pinned explicitly below; every
    // other field of every response here is asserted in full.
    const sessionOf = (result: { response?: unknown }): Record<string, unknown> => (result.response as { session: Record<string, unknown> }).session;

    const createSession = async (body: Record<string, unknown>) =>
        harness(contextFor('/v1/storyline/sessions', 'POST') as never, { body }, undefined);

    const readSession = async (sessionId: string) => harness(contextFor(`/v1/storyline/sessions/${sessionId}`) as never, EMPTY, undefined);

    const readRecords = async (sessionId: string) => harness(contextFor(`/v1/storyline/sessions/${sessionId}/records`) as never, EMPTY, undefined);

    // The wire projection of the two folders (`api-reads.ts recordFieldRowOf` renders
    // `{key, type, required}` — the caps are the engine's, not a field the panel needs).
    const SECTION_ROWS = [
        { key: 'order', type: 'integer', required: false },
        { key: 'heading', type: 'text', required: false },
        { key: 'content', type: 'text', required: false }
    ];

    it('names a Title the user did not name, and keeps the name they typed', async () => {
        const unnamed = await createSession({ harness: 'storyline' });

        expect(unnamed.status).toBe(201);
        expect(sessionOf(unnamed).title).toBe(STORYLINE_DEFAULT_TITLE);

        const named = await createSession({ harness: 'storyline', title: 'The Quiet Harbour' });

        expect(named.status).toBe(201);
        expect(sessionOf(named).title).toBe('The Quiet Harbour');

        // The store row, not just the response the create returned: the harness only names a
        // session when the body carries a title, so this rename is the whole of R-A, and a
        // panel that lists Titles later must see the same words.
        const sessionId = String(sessionOf(unnamed).id);
        const reread = await readSession(sessionId);

        expect(reread.status).toBe(200);
        expect(sessionOf(reread).id).toBe(sessionId);
        expect(sessionOf(reread).title).toBe(STORYLINE_DEFAULT_TITLE);
        expect(sessionOf(reread).harness).toBe('storyline');

        const rereadNamed = await readSession(String(sessionOf(named).id));

        expect(sessionOf(rereadNamed).title).toBe('The Quiet Harbour');

        // The rename must not disturb the contract headers or the rest of the row.
        expect(sessionOf(unnamed).harness).toBe('storyline');
        expect(unnamed.headers?.['X-Harness-Revision']).toBeDefined();
    });

    it('owns the two folders a Title needs before the create returns', async () => {
        const created = await createSession({ harness: 'storyline', title: 'Harbour' });
        const sessionId = String(sessionOf(created).id);
        const snapshot = await readRecords(sessionId);

        expect(snapshot.status).toBe(200);

        const body = snapshot.response as { session_id: string; store_rev: number; collections_rev: number; collections: Record<string, unknown>[]; changes: unknown[] };

        expect(body.session_id).toBe(sessionId);
        // Two `define` calls and no records: the collection watermark moved twice, the store
        // watermark did not, and the retained change feed is empty — a panel booting on this
        // document has nothing to replay.
        expect(body.store_rev).toBe(0);
        expect(body.collections_rev).toBe(2);
        expect(body.changes).toEqual([]);

        expect(body.collections.map((collection) => collection.name)).toEqual(['tasks', 'chapters', 'profiles', 'locations', 'outlines', 'storyline']);
        expect(body.collections.slice(4)).toEqual([
            { name: 'outlines', store_rev: 0, count: 0, fields: SECTION_ROWS, entries: [] },
            { name: 'storyline', store_rev: 0, count: 0, fields: SECTION_ROWS, entries: [] }
        ]);

        // Idempotent across creates: a second Title defines its own two folders and nothing
        // about the first one changes.
        const second = await createSession({ harness: 'storyline' });
        const secondSnapshot = await readRecords(String(sessionOf(second).id));

        expect((secondSnapshot.response as { collections: Record<string, unknown>[] }).collections.map((collection) => collection.name)).toEqual([
            'tasks',
            'chapters',
            'profiles',
            'locations',
            'outlines',
            'storyline'
        ]);
    });

    it('leaves a session on another preset exactly as the harness built it', async () => {
        // The hook is this package's, on this package's preset. A `general` session on the same
        // server keeps the four collections the harness ships and no default title, because the
        // UI that created it is not the Title browser.
        const created = await createSession({ harness: 'general' });

        expect(created.status).toBe(201);
        expect(sessionOf(created).title).toBeUndefined();

        const snapshot = await readRecords(String(sessionOf(created).id));

        expect((snapshot.response as { collections: Record<string, unknown>[] }).collections.map((collection) => collection.name)).toEqual([
            'tasks',
            'chapters',
            'profiles',
            'locations'
        ]);
    });
});

describe('storyline upgrade', () => {
    it('hands an unrelated path back to the gateway with the socket untouched', () => {
        const writes: string[] = [];
        const socket = {
            write: (chunk: string) => {
                writes.push(String(chunk));

                return true;
            },
            end: (chunk?: string) => {
                writes.push(String(chunk));

                return socket;
            },
            destroy: () => socket,
            on: () => socket
        };

        // `url` is the only field the mount reads before its path check, so a plain
        // object is the whole request this test needs (cast at the call site, kept
        // typed here so the restore assertion can read it).
        const request = { url: '/v1/storyline/sessions', headers: {}, method: 'GET' };
        const handled = createStorylineServiceUpgrade({ runtime: runtimeFor() })(
            request as never,
            socket as never,
            Buffer.alloc(0),
            undefined
        );

        expect(handled).toBe(false);
        expect(writes).toEqual([]);
        // Restored for whoever handles the request next: the rewrite lives only inside
        // the hand-off, never on the client's request object.
        expect(request.url).toBe('/v1/storyline/sessions');
    });
});

describe('storyline runtime resolution', () => {
    it('keeps the boot-time provider document the handler will hand the runtime', () => {
        configureStorylineRuntime({ settings: SETTINGS, defaults: DEFAULTS });

        expect(storylineRuntimeSettings()).toEqual({ settings: SETTINGS, defaults: DEFAULTS });
    });

    it('resolves one in-memory runtime per root, whatever shape the empty root takes', async () => {
        clearStorylineRuntimes();

        const withoutRoot = createStorylineServiceHandler();

        const first = await withoutRoot(contextFor('/v1/storyline') as never, EMPTY, {});
        const second = await withoutRoot(contextFor('/v1/storyline') as never, EMPTY, {});
        // An explicit `null` is the harness's "no persistence" value, and it keys to
        // the same in-memory runtime as an absent root.
        const explicitNull = await withoutRoot(contextFor('/v1/storyline') as never, EMPTY, { root: null });

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(explicitNull.status).toBe(200);
        expect(storylineRuntimeCount()).toBe(1);

        const epochOf = (response: unknown) => (response as { epoch: string }).epoch;

        expect(epochOf(explicitNull.response)).toBe(epochOf(first.response));

        clearStorylineRuntimes();

        expect(storylineRuntimeCount()).toBe(0);
    });

    it('refuses a blank database root with the harness message instead of going in memory silently', async () => {
        clearStorylineRuntimes();

        const result = await createStorylineServiceHandler()(
            contextFor('/v1/storyline') as never,
            EMPTY,
            // A present-but-blank root is an operator typo, and the harness rule is
            // that a stated root is never silently ignored.
            { root: '   ' }
        );

        expect(result.status).toBe(500);
        expect((result.response as { error: { message: string } }).error.message).toBe(
            'A harness database root must be a non-empty string when provided.'
        );

        clearStorylineRuntimes();
    });
});
