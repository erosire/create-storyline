// @vitest-environment node
// The integrated story: one booted storyline gateway answering the FULL product path —
// bootstrap, preset discovery, session create, record-tool writes, the record-store
// read the panels render, and the live stream — over real HTTP and a real WebSocket.
//
// WHY A SEPARATE FILE FROM ./discovery.test.ts: that file proves the MOUNT exists
// (the scanner finds the endpoint folder, the upgrade tier routes the handshake). This
// one proves the STORY works on top of it: the chapters/profiles executions the UI's
// panels issue, and the snapshot read that follows them, which is the exact pair
// src/api/storyline.ts `readRecords`/`updateChapter` performs. The two files boot
// their own gateways and share nothing, so a failure names its own layer.
//
// WHY `@vitest-environment node`: the package default is jsdom (the dashboard ships),
// and this file needs the NODE implementations of `fetch` and `WebSocket`. jsdom's
// `fetch` is a relative-URL client bound to the fake page origin, which would test the
// emulation instead of the server.
//
// WHY IT ALSO OWNS THE TWO T10 SEAMS. The workstation used to be verified against a
// stubbed `fetch` only, so any assumption its stub made about this server was unproven.
// The three reads the redesigned product cannot work without are pinned here against a
// booted gateway: the Title rail's `?harness=storyline` filter (does the route honour
// it — yes, so no client-side filter was needed), the idempotent collection `define`
// against folders the create hook already owns (the refusal, and the exact shape its
// code travels in), and the rename the rail re-reads. The third seam — which conversation
// a chained turn lands in — is a HARNESS-level question with no HTTP surface of its own,
// so it is pinned in ./orchestrator.test.ts instead.
//
// WHY PORT 0 AND NEVER 5000: `startStorylineServer({ port: 0 })` asks
// `allocateFreePort` (./main.ts:130) for a concrete OS-assigned port, because
// `startServer` never reports its bound address. A repo-wide gateway is normally
// RUNNING on :5000 (the shared `yarn start-service` host); binding it here would
// killPort-steal a live developer gateway for the length of the suite.
//
// WHY `databaseRoot: null`: the runtime is in-memory, so the suite writes no
// `temporary/harness/state.json` and leaves nothing behind on disk.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStorylineServer, type StorylineServer } from './main';
import { STORYLINE_DEFAULT_TITLE, clearStorylineRuntimes } from './service';

// A provider that dials nothing: nothing in this file runs a model turn, so the triple
// only has to be explicit. `defaults` is derived from it by the entry, and the session
// row's `model` is asserted against it — which is the wiring under test, not a mock.
const SETTINGS = { baseURL: 'http://127.0.0.1:1/v1', apiKey: '', model: 'story/test-model' };

// The contract's subprotocol (harness src/shared/harness-api.ts:42), restated rather
// than imported so this file keeps zero imports from the harness server barrel.
const SUBPROTOCOL = 'harness.v1';

// The REST epoch header the harness stamps on every JSON response, and the same value
// the stream's `welcome` frame carries (harness src/server/service.ts:68 states the
// equality). Asserting it across the two planes is what proves REST and WS are served
// by ONE runtime — the reason ./service.ts resolves the runtime in the upgrade handler.
const EPOCH_HEADER = 'x-harness-epoch';

// The wire projection of one Title section field (harness api-reads.ts
// `recordFieldRowOf` renders exactly `{key, type, required}` — the 200/4000-character caps
// are the engine's own limits and are not part of the row a panel is handed).
const SECTION_FIELDS = [
    { key: 'order', type: 'integer', required: false },
    { key: 'heading', type: 'text', required: false },
    { key: 'content', type: 'text', required: false }
];

// The exact `define` payload the workstation's `ensureCollections` sends — src/api/storyline.ts
// `STORYLINE_SECTION_FIELDS`, restated here for the same reason `SECTION_FIELDS` above is
// restated: this file pins the WIRE, and importing the api module would drag the browser client
// (and its `./root` mount side-effect) into a node suite. The field caps are the CLIENT's, which
// is the point: the server-side definition (./collections.ts) is a second, different owner of the
// same two names, and both must survive the other one winning.
const UI_SECTION_FIELDS = [
    { key: 'order', type: 'integer', sortable: true },
    { key: 'heading', type: 'text', maxLength: 200 },
    { key: 'content', type: 'text', maxLength: 4000 }
];

/**
 * The sentence the records engine answers a re-`define` with (core/records.ts:1129). It is the
 * ONLY place the `collection-exists` code survives the tool route's closed
 * `{ ok: false, error: { message } }` envelope, and therefore the only thing the UI's
 * `ensureResultOf` can classify on — pinned verbatim so a wording change in the engine is a
 * visible test failure rather than a failure strip over every Title.
 */
const collectionExistsSentence = (name: string): string =>
    `collection-exists: A collection named "${name}" is already defined; a re-define is refused rather than merged, because it would silently change a live contract.`;

type Wire = { status: number; headers: Headers; body: unknown };

/** The JSON text of a response, kept as a string when the body is not JSON (an assertion failure then shows what was served). */
const call = async (origin: string, pathname: string, init: { method?: string; body?: unknown } = {}): Promise<Wire> => {
    const payload = init.body === undefined ? undefined : JSON.stringify(init.body);
    const response = await fetch(`${origin}${pathname}`, {
        method: init.method ?? 'GET',
        ...(payload === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: payload })
    });
    const text = await response.text();

    let body: unknown = text;

    try {
        body = JSON.parse(text) as unknown;
    } catch {
        // Left as the raw text on purpose.
    }

    return { status: response.status, headers: response.headers, body };
};

const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

/** One entry of a `{ items: [...] }` page, by `name`. */
const findNamed = (body: unknown, name: string): Record<string, unknown> | undefined =>
    (Array.isArray(asRecord(body).items) ? (asRecord(body).items as unknown[]) : [])
        .map(asRecord)
        .find((item) => item.name === name);

/** One collection of a `RecordsSnapshotResponse` (`{ collections: [{ name, entries }] }`, harness-api.ts:1522). */
const findCollection = (body: unknown, name: string): Record<string, unknown> | undefined =>
    (Array.isArray(asRecord(body).collections) ? (asRecord(body).collections as unknown[]) : [])
        .map(asRecord)
        .find((collection) => collection.name === name);

/** One `{ items: [...] }` page, as rows. */
const itemsOf = (body: unknown): Record<string, unknown>[] =>
    (Array.isArray(asRecord(body).items) ? (asRecord(body).items as unknown[]) : []).map(asRecord);

/** The rail's row identity: what a Title IS on the wire, with "no title" spelled as `null`
 *  (a `SessionSummary` row simply omits the key, which is the case the UI's `Untitled N`
 *  fallback describes — src/api/storyline.ts `titleRowFromSession`). */
const sessionRows = (body: unknown): { id: unknown; harness: unknown; title: unknown }[] =>
    itemsOf(body).map((row) => ({ id: row.id, harness: row.harness, title: row.title === undefined ? null : row.title }));

/** The entries of one collection, empty when the store names it not at all. */
const entriesOf = (collection: Record<string, unknown> | undefined): Record<string, unknown>[] =>
    collection === undefined || !Array.isArray(collection.entries) ? [] : (collection.entries as unknown[]).map(asRecord);

/** The next frame on a live stream socket, or a named failure — never a silent hang. */
const nextFrame = (socket: WebSocket, timeoutMs = 20_000): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
        const cleanup = (): void => {
            clearTimeout(timer);
            socket.removeEventListener('message', onMessage);
            socket.removeEventListener('error', onError);
            socket.removeEventListener('close', onClose);
        };
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`No stream frame arrived within ${timeoutMs}ms.`));
        }, timeoutMs);
        const onMessage = (event: MessageEvent): void => {
            cleanup();
            resolve(asRecord(JSON.parse(String(event.data)) as unknown));
        };
        const onError = (): void => {
            cleanup();
            reject(new Error('The stream socket errored before answering a frame.'));
        };
        const onClose = (event: CloseEvent): void => {
            cleanup();
            reject(new Error(`The stream socket closed with code ${event.code} before answering a frame.`));
        };

        socket.addEventListener('message', onMessage);
        socket.addEventListener('error', onError);
        socket.addEventListener('close', onClose);
    });

/** Opens the socket and waits for the handshake to complete. */
const openStream = async (url: string): Promise<WebSocket> => {
    const socket = new WebSocket(url, [SUBPROTOCOL]);

    await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener('error', () => reject(new Error(`The stream handshake at ${url} failed.`)), { once: true });
    });

    return socket;
};

describe('storyline gateway — the integrated story path', () => {
    let server: StorylineServer;
    let sessionId = '';
    /** The epoch the REST plane answered with, compared against the stream's `welcome`. */
    let restEpoch = '';
    /** The store watermark seen after the chapter write, so the profile write can be pinned to exactly one later position. */
    let chapterStoreRev = 0;
    /** The three sessions the seam tests below create, shared so the rename test can address the rail's row. */
    let seamTitledId = '';
    let seamUntitledId = '';
    let seamForeignId = '';

    beforeAll(async () => {
        server = await startStorylineServer({
            port: 0,
            databaseRoot: null,
            // An empty env plus `noStatic` makes every input explicit: no developer
            // shell, and no dependence on whether `dist/` happens to exist.
            env: {},
            flags: { noStatic: true, help: false },
            settings: SETTINGS,
            defaults: { baseURL: SETTINGS.baseURL, model: SETTINGS.model, hasApiKey: false }
        });
    }, 60_000);

    afterAll(async () => {
        await server?.close();
        clearStorylineRuntimes();
    });

    it('boots on an ephemeral port and never on the shared gateway port 5000', () => {
        expect(server.port).toBeGreaterThan(0);
        expect(server.port).not.toBe(5000);
        expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
    });

    it('answers the bootstrap at /v1/storyline with this mount as the API root', async () => {
        const response = await call(server.url, '/v1/storyline');

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            api_root: '/v1/storyline',
            links: {
                self: '/v1/storyline',
                sessions: '/v1/storyline/sessions',
                stream: '/v1/storyline/stream'
            }
        });
        // The mount rewrite is total for JSON documents: a client booted at this root
        // is never handed a link it cannot follow (./service.ts:216).
        expect(JSON.stringify(response.body)).not.toContain('/v1/harness');
    });

    it('discovers the storyline preset card through the gateway', async () => {
        const response = await call(server.url, '/v1/storyline/harnesses?limit=100');

        expect(response.status).toBe(200);

        const card = findNamed(response.body, 'storyline');

        // The card the UI's `selectPreset` matches on (src/api/storyline.ts:304): all
        // three story agents declared, the writer primary. `title` and `builtin` come
        // from ./presets.ts:198 and :222.
        expect(card).toMatchObject({
            name: 'storyline',
            title: 'Storyline',
            primary: 'writer',
            subagents: ['reader', 'editor'],
            agents: ['writer', 'reader', 'editor'],
            requires_endpoint: true,
            builtin: true
        });
        // The match must not be accidental: no other shipped preset declares this
        // roster, so `selectPresetFromCards` cannot pick anything else.
        const storyRosters = (asRecord(response.body).items as unknown[])
            .map(asRecord)
            .filter((item) => {
                const agents = Array.isArray(item.agents) ? (item.agents as string[]) : [];

                return agents.includes('writer') && agents.includes('reader') && agents.includes('editor');
            })
            .map((item) => item.name);

        expect(storyRosters).toEqual(['storyline']);
    });

    it('creates a storyline session and stamps the roster and the epoch', async () => {
        const response = await call(server.url, '/v1/storyline/sessions', { method: 'POST', body: { harness: 'storyline' } });

        expect(response.status).toBe(201);

        const session = asRecord(asRecord(response.body).session);

        sessionId = String(session.id ?? '');
        restEpoch = response.headers.get(EPOCH_HEADER) ?? '';

        expect(sessionId.length).toBeGreaterThan(0);
        expect(session).toMatchObject({ harness: 'storyline', status: 'idle', model: SETTINGS.model });
        // The provider document this package installed (./main.ts -> ./service.ts
        // `configureStorylineRuntime`) is the one the SESSION carries, key-free. That is
        // the wiring a bare gateway would silently get wrong: the harness's own
        // `HARNESS_*` fallbacks instead of the resolved triple.
        expect(session).toMatchObject({ endpoint: { base_url: SETTINGS.baseURL, model: SETTINGS.model, has_api_key: false } });
        // The three agents exist as session members, in the preset's own order.
        expect(Object.keys(asRecord(session.agent_models))).toEqual(['writer', 'reader', 'editor']);
        expect(session).toHaveProperty('definition_revision');
        expect(JSON.stringify(response.body)).not.toContain('/v1/harness');
        expect(restEpoch.length).toBeGreaterThan(0);
    });

    it('names an unnamed Title and owns its two folders the moment it exists', async () => {
        const response = await call(server.url, '/v1/storyline/sessions', { method: 'POST', body: { harness: 'storyline' } });
        const session = asRecord(asRecord(response.body).session);
        const createdId = String(session.id ?? '');

        expect(response.status).toBe(201);
        expect(createdId.length).toBeGreaterThan(0);

        // R-A: a Title the browser did not name still has a name, and it is THIS package's
        // default — the harness itself leaves an unnamed session untitled, so the presence of
        // this field is the storyline create path doing its own work.
        expect(session.title).toBe(STORYLINE_DEFAULT_TITLE);

        // ...and the name a client DID send survives the same path untouched.
        const named = await call(server.url, '/v1/storyline/sessions', { method: 'POST', body: { harness: 'storyline', title: 'The Quiet Harbour' } });

        expect(asRecord(asRecord(named.body).session).title).toBe('The Quiet Harbour');

        // R-B over the wire: the two folders the Outlines and Storyline panels render are
        // already there when the create returns, declared with the field spec the panel sorts
        // and filters by, and empty. `collections_rev` moved twice (two defines) while
        // `store_rev` is still 0 and the change feed is empty — a panel booting on this
        // document has nothing to replay.
        const snapshot = await call(server.url, `/v1/storyline/sessions/${createdId}/records`);
        const body = asRecord(snapshot.body);

        expect(snapshot.status).toBe(200);
        expect(body.store_rev).toBe(0);
        expect(body.collections_rev).toBe(2);
        expect(body.changes).toEqual([]);
        expect((body.collections as Record<string, unknown>[]).map((collection) => collection.name)).toEqual([
            'tasks',
            'chapters',
            'profiles',
            'locations',
            'outlines',
            'storyline'
        ]);
        expect(findCollection(body, 'outlines')).toEqual({ name: 'outlines', store_rev: 0, count: 0, fields: SECTION_FIELDS, entries: [] });
        expect(findCollection(body, 'storyline')).toEqual({ name: 'storyline', store_rev: 0, count: 0, fields: SECTION_FIELDS, entries: [] });
    });

    it('writes a chapter through the chapters tool and shows it in the record snapshot', async () => {
        const executed = await call(server.url, `/v1/storyline/sessions/${sessionId}/tools/chapters/executions`, {
            method: 'POST',
            body: {
                parameters: {
                    action: 'add',
                    title: 'The Long Shadow',
                    summary: 'Marlowe reaches the harbour and finds it empty.',
                    content: 'The fog came in at four and the harbour was already asleep.',
                    status: 'draft',
                    order: 2
                }
            }
        });

        expect(executed.status).toBe(200);

        const result = asRecord(asRecord(executed.body).result);

        // `add` answers `{ chapter, counts }` (chapters.tool.ts), and `content` is
        // getOnly (core/chapter.ts:47) — so the mutation result carries the summary and
        // the body, while the LIST read below must not carry the body.
        expect(asRecord(executed.body).ok).toBe(true);
        expect(result.chapter).toMatchObject({
            title: 'The Long Shadow',
            summary: 'Marlowe reaches the harbour and finds it empty.',
            status: 'draft',
            order: 2,
            rev: 1
        });
        expect(asRecord(result.counts).total).toBe(1);

        const snapshot = await call(server.url, `/v1/storyline/sessions/${sessionId}/records`);

        expect(snapshot.status).toBe(200);

        const body = asRecord(snapshot.body);
        const chaptersCollection = findCollection(snapshot.body, 'chapters');
        const chapters = entriesOf(chaptersCollection);

        expect(body.session_id).toBe(sessionId);
        // `collections_rev` describes WHICH collections exist, not what was written, so
        // the proof this write reached the store is the collection's own row count and
        // the store watermark the next write is measured against.
        expect(chaptersCollection).toMatchObject({ name: 'chapters', count: 1 });
        chapterStoreRev = Number(body.store_rev);
        expect(chapters.length).toBe(1);
        expect(chapters[0]).toMatchObject({
            title: 'The Long Shadow',
            summary: 'Marlowe reaches the harbour and finds it empty.',
            status: 'draft',
            order: 2
        });
        expect(chapters[0]).not.toHaveProperty('content');
    });

    it('writes a profile through the profiles tool and shows it in the record snapshot', async () => {
        const executed = await call(server.url, `/v1/storyline/sessions/${sessionId}/tools/profiles/executions`, {
            method: 'POST',
            body: {
                parameters: {
                    action: 'add',
                    name: 'Ada Lyle',
                    description: 'Cartographer of a coast that keeps moving.',
                    traits: ['proud', 'stubborn'],
                    notes: 'Never draws the same harbour twice.'
                }
            }
        });

        expect(executed.status).toBe(200);
        expect(asRecord(executed.body).ok).toBe(true);

        const profile = asRecord(asRecord(asRecord(executed.body).result).profile);

        // core/profile.ts:36 declares `traits` as a trimmed, de-duplicated string array,
        // so the row round-trips both values in the order they were sent.
        expect(profile).toMatchObject({
            name: 'Ada Lyle',
            description: 'Cartographer of a coast that keeps moving.',
            traits: ['proud', 'stubborn'],
            notes: 'Never draws the same harbour twice.',
            rev: 1
        });

        const snapshot = await call(server.url, `/v1/storyline/sessions/${sessionId}/records`);
        const profiles = entriesOf(findCollection(snapshot.body, 'profiles'));

        expect(profiles.length).toBe(1);
        expect(profiles[0]).toMatchObject({
            name: 'Ada Lyle',
            description: 'Cartographer of a coast that keeps moving.',
            traits: ['proud', 'stubborn'],
            notes: 'Never draws the same harbour twice.'
        });
        // One store, both collections: the snapshot the panels render is the union, and
        // this write moved the watermark by exactly one position from where the chapter
        // write left it (`store_rev` is the store-wide feed position, one per change).
        expect(asRecord(snapshot.body).store_rev).toBe(chapterStoreRev + 1);
    });

    it('writes ordered sections through the records tool and reads them back in document order', async () => {
        // R-B over the wire, in the shape the Outlines panel uses: one `records` call per
        // section (the tool is generic, the collection is named in the parameters), then the
        // two reads the UI performs — the store snapshot, and a `records` page.
        const five = { id: '4', order: 10, heading: 'Act One', content: 'Ines arrives at the harbour.', rev: 1 };
        const three = { id: '3', order: 30, heading: 'Act Three', content: 'The reckoning.', rev: 1 };

        const write = async (entry: Record<string, unknown>): Promise<void> => {
            const executed = await call(server.url, `/v1/storyline/sessions/${sessionId}/tools/records/executions`, {
                method: 'POST',
                body: { parameters: { collection: 'outlines', entries: [entry] } }
            });

            expect(executed.status).toBe(200);
            expect(asRecord(executed.body).ok).toBe(true);
        };

        // Deliberately out of sequence: the proof that `order` is the sort key is that the
        // page comes back in document order for sections SENT in the other order.
        await write({ order: 30, heading: 'Act Three', content: 'The reckoning.' });
        await write({ order: 10, heading: 'Act One', content: 'Ines arrives at the harbour.' });

        // Ids are session-wide, so these two follow the chapter ('1') and the profile ('2').
        const projected = (entries: Record<string, unknown>[]) =>
            entries.map((entry) => ({ id: entry.id, order: entry.order, heading: entry.heading, content: entry.content, rev: entry.rev }));

        const page = await call(server.url, `/v1/storyline/sessions/${sessionId}/tools/records/executions`, {
            method: 'POST',
            body: { parameters: { collection: 'outlines' } }
        });

        expect(asRecord(page.body).ok).toBe(true);

        const pageResult = asRecord(asRecord(page.body).result);

        expect(projected(pageResult.entries as Record<string, unknown>[])).toEqual([five, three]);
        expect(pageResult.counts).toEqual({ total: 2 });
        expect(pageResult.page).toEqual({ offset: 0, limit: 20, hasMore: false });

        const snapshot = await call(server.url, `/v1/storyline/sessions/${sessionId}/records`);
        const outlines = findCollection(snapshot.body, 'outlines');

        expect(outlines).toMatchObject({ name: 'outlines', count: 2 });
        // The snapshot is ordered by ID, not by `order` — which is why a panel that renders
        // the snapshot sorts by `order` itself, while a `records` page arrives sorted.
        expect(projected(entriesOf(outlines))).toEqual([three, five]);
        // Two more feed positions on top of the chapter and profile writes.
        expect(asRecord(snapshot.body).store_rev).toBe(chapterStoreRev + 3);
    });

    it('streams the story live at /v1/storyline/stream with the harness.v1 subprotocol', async () => {
        const socket = await openStream(server.stream);

        try {
            // The negotiated subprotocol is the handshake answer, not an assumption.
            expect(socket.protocol).toBe(SUBPROTOCOL);

            const welcome = await nextFrame(socket);

            // `welcome` is always the first server frame (stream/connection.ts:396), and
            // its epoch is the REST hub's epoch (harness src/server/service.ts:68) — one
            // runtime behind both mounts of this gateway.
            expect(welcome).toMatchObject({ type: 'welcome', protocol: SUBPROTOCOL, epoch: restEpoch });

            // `hello` is a CLIENT frame and is honoured only as the first one
            // (stream/connection.ts:213); the stream client src/api/stream.ts:37 sends it
            // exactly this way when it resumes an observation.
            socket.send(JSON.stringify({ type: 'hello', protocol: SUBPROTOCOL, epoch: restEpoch }));
            socket.send(
                JSON.stringify({ type: 'subscribe', subscription_id: 'sub-1', scope: 'session', session_id: sessionId })
            );

            const state = await nextFrame(socket);

            // `subscription_state` is the reconciliation anchor and is never droppable, so
            // a session subscription on a live session is answered with it — not with an
            // `error` frame naming an unknown resource, which would mean the mount's
            // runtime is not the runtime that created the session.
            expect(state).toMatchObject({ type: 'subscription_state', subscription_id: 'sub-1', scope: 'session', epoch: restEpoch });
        } finally {
            // `bye` is the contract's clean goodbye (close 1000), so the server releases
            // the subscription instead of seeing a dropped connection.
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'bye', reason: 'test complete' }));
            socket.close();
        }
    }, 30_000);

    it('filters the Title list by harness ON THE SERVER, so another app\'s sessions never reach the rail', async () => {
        // T10 SEAM 1. The workstation's `listTitles` asks
        // `GET <mount>/sessions?limit=100&harness=storyline` and relies on the ROUTE honouring
        // `harness`; were the parameter ignored, the Title tree would silently list every
        // session this gateway can build. The route is the harness's own (`getSessions`,
        // packages/underload/harness/src/server/api.ts:2486-2500): the filter is
        // `record.preset.name === harness`, and a row carries `harness` as well — so a
        // client-side filter remains available, but the live answer proved it is NOT needed.
        // What the rail already sees, read BEFORE this test creates anything and hard-pinned to
        // the three Titles the earlier tests in this file own. Reading rather than hard-coding
        // the ids keeps the exact assertions below exact; pinning the count is what says the
        // filter is not simply returning a different page.
        const baseline = sessionRows((await call(server.url, '/v1/storyline/sessions?limit=100&harness=storyline')).body);

        expect(baseline).toHaveLength(3);
        expect(baseline.map((row) => row.harness)).toEqual(['storyline', 'storyline', 'storyline']);

        const titled = await call(server.url, '/v1/storyline/sessions', { method: 'POST', body: { harness: 'storyline', title: 'Seam Titled' } });
        const untitled = await call(server.url, '/v1/storyline/sessions', { method: 'POST', body: { harness: 'storyline' } });
        const foreign = await call(server.url, '/v1/storyline/sessions', { method: 'POST', body: { harness: 'workspace' } });
        const unknown = await call(server.url, '/v1/storyline/sessions', { method: 'POST', body: { harness: 'definitely-not-a-harness' } });

        expect(titled.status).toBe(201);
        expect(untitled.status).toBe(201);

        seamTitledId = String(asRecord(asRecord(titled.body).session).id);
        seamUntitledId = String(asRecord(asRecord(untitled.body).session).id);
        seamForeignId = String(asRecord(asRecord(foreign.body).session).id);

        // This mount serves the shipped presets too — exactly why the rail needs the filter —
        // and an unknown harness is a 404 naming it, never a silent fallback to `storyline`.
        expect(asRecord(asRecord(foreign.body).session).harness).toBe('workspace');
        expect(unknown.status).toBe(404);
        expect(unknown.body).toEqual({ error: { message: 'Unknown harness "definitely-not-a-harness".' } });

        // The unnamed Title is named by THIS package's create hook, and that name — not null —
        // is what the rail reads.
        const mine = [
            { id: seamTitledId, harness: 'storyline', title: 'Seam Titled' },
            { id: seamUntitledId, harness: 'storyline', title: STORYLINE_DEFAULT_TITLE }
        ];

        const filtered = await call(server.url, '/v1/storyline/sessions?limit=100&harness=storyline');

        expect(filtered.status).toBe(200);
        // Store order: creation order, ascending `created_at`. The rail re-sorts newest-first in
        // `titleRowsFromPages`, so its order does not depend on this — the SERVER's order is
        // pinned because it is what a cursor pages through.
        expect(sessionRows(filtered.body)).toEqual([...baseline, ...mine]);

        const unfiltered = await call(server.url, '/v1/storyline/sessions?limit=100');

        expect(sessionRows(unfiltered.body)).toEqual([
            ...baseline,
            ...mine,
            // A `workspace` session is not a Title: the create hook keys on the CARD, so it keeps
            // no title at all (the harness itself leaves an unnamed session untitleled).
            { id: seamForeignId, harness: 'workspace', title: null }
        ]);

        const onlyWorkspace = await call(server.url, '/v1/storyline/sessions?limit=100&harness=workspace');

        expect(sessionRows(onlyWorkspace.body)).toEqual([{ id: seamForeignId, harness: 'workspace', title: null }]);

        // A filter that matches nothing is a VALUE, not an error: an empty rail is the honest
        // answer, where a 400 would make the tree look like a broken server.
        const noMatch = await call(server.url, '/v1/storyline/sessions?limit=100&harness=definitely-not-a-harness');

        expect(noMatch.status).toBe(200);
        expect(sessionRows(noMatch.body)).toEqual([]);

        // `limit` is the only thing the client's `pageParams` always sends, so the no-query read
        // is the same unfiltered page (the contract's default limit of 25 is above this file's
        // session count, so no cursor is in play).
        const bare = await call(server.url, '/v1/storyline/sessions');

        expect(bare.status).toBe(200);
        expect(sessionRows(bare.body)).toEqual(sessionRows(unfiltered.body));
    });

    it('renames a Title over REST and the filtered rail read answers with the new name', async () => {
        // The workstation's `renameTitle` is a `PATCH <mount>/sessions/{id}` carrying
        // `{ title }`, and its rename flow sends `null` to CLEAR a name so the rail's
        // `Untitled N` fallback renders. Both directions have to survive the real route, and the
        // list the rail re-reads must show the change without a restart.
        const patched = await call(server.url, `/v1/storyline/sessions/${seamTitledId}`, { method: 'PATCH', body: { title: 'Renamed On The Rail' } });

        expect(patched.status).toBe(200);
        expect(asRecord(asRecord(patched.body).session)).toMatchObject({ id: seamTitledId, title: 'Renamed On The Rail' });

        const afterRename = await call(server.url, '/v1/storyline/sessions?limit=100&harness=storyline');

        expect(sessionRows(afterRename.body).find((row) => row.id === seamTitledId)).toEqual({
            id: seamTitledId,
            harness: 'storyline',
            title: 'Renamed On The Rail'
        });

        const cleared = await call(server.url, `/v1/storyline/sessions/${seamTitledId}`, { method: 'PATCH', body: { title: null } });

        expect(cleared.status).toBe(200);
        // `title: null` REMOVES the field — it does not store an empty string. That is the state
        // the fallback is written for, and the difference is what `titleRowFromSession` reads.
        expect(asRecord(asRecord(cleared.body).session)).not.toHaveProperty('title');

        const afterClear = await call(server.url, '/v1/storyline/sessions?limit=100&harness=storyline');

        expect(sessionRows(afterClear.body).find((row) => row.id === seamTitledId)).toEqual({
            id: seamTitledId,
            harness: 'storyline',
            title: null
        });
    });

    it('lets the create hook\'s collections and the UI\'s own idempotent define coexist', async () => {
        // T10 SEAM 3. The create hook (./service.ts `finalizeStorylineSessionCreate`) defines
        // `outlines` and `storyline` BEFORE the 201, and the workstation still sends its own
        // `define` on every Title activation (src/api/storyline.ts `ensureCollections`). A
        // re-`define` is REFUSED, never merged (core/records.ts:1129), so the whole coexistence
        // contract is the refusal — and its SHAPE is the seam: the tool route answers the closed
        // `{ ok: false, error: { message } }` envelope, so the `collection-exists` code survives
        // only as the first token of the sentence. There is no `error.code` on the wire, and the
        // client classifier reads that sentence (see ./../api/storyline.test.ts).
        const created = await call(server.url, '/v1/storyline/sessions', { method: 'POST', body: { harness: 'storyline', title: 'Overlap Seam' } });
        const overlapId = String(asRecord(asRecord(created.body).session).id);

        expect(created.status).toBe(201);

        // Baseline: both folders are already there and the store has moved nothing.
        const before = asRecord((await call(server.url, `/v1/storyline/sessions/${overlapId}/records`)).body);

        expect(before).toMatchObject({ session_id: overlapId, store_rev: 0, collections_rev: 2, changes: [] });

        for (const name of ['outlines', 'storyline']) {
            const redefined = await call(server.url, `/v1/storyline/sessions/${overlapId}/tools/records/executions`, {
                method: 'POST',
                body: { parameters: { define: { name, fields: UI_SECTION_FIELDS } } }
            });

            // A tool failure is a 200 with `ok: false` (harness-api.ts:822-845) — the only branch
            // that tells it apart from a define that landed, which is what `unwrapToolResult`
            // and `defineCollection` both key on.
            expect(redefined.status).toBe(200);
            expect(asRecord(redefined.body).ok).toBe(false);
            expect(asRecord(redefined.body).error).toEqual({ message: collectionExistsSentence(name) });
            expect(typeof asRecord(redefined.body).duration_ms).toBe('number');
        }

        // The refusal is a genuine no-op: the store is exactly what the create hook left, which
        // is why the UI may treat it as success instead of re-reading and retrying.
        const after = asRecord((await call(server.url, `/v1/storyline/sessions/${overlapId}/records`)).body);

        expect(after.store_rev).toBe(0);
        expect(after.collections_rev).toBe(2);
        expect((after.collections as unknown[]).map(asRecord).map((collection) => collection.name)).toEqual([
            'tasks',
            'chapters',
            'profiles',
            'locations',
            'outlines',
            'storyline'
        ]);

        // The other half of the coexistence proof: the workstation's EXACT payload is valid on
        // this route, so the ensure is a real define when the store lacks the name — and the
        // second attempt hits the same refusal, which is what makes it idempotent.
        const spare = await call(server.url, '/v1/storyline/sessions', { method: 'POST', body: { harness: 'storyline', title: 'Spare Seam' } });
        const spareId = String(asRecord(asRecord(spare.body).session).id);
        const define = (name: string) =>
            call(server.url, `/v1/storyline/sessions/${spareId}/tools/records/executions`, {
                method: 'POST',
                body: { parameters: { define: { name, fields: UI_SECTION_FIELDS } } }
            });

        const defined = asRecord((await define('t10_probe_notes')).body);

        expect(defined.ok).toBe(true);
        expect(asRecord(defined.result)).toEqual({
            entries: [],
            counts: { total: 0 },
            page: { offset: 0, limit: 20, hasMore: false },
            storeRev: 0,
            collection: 't10_probe_notes'
        });

        const again = asRecord((await define('t10_probe_notes')).body);

        expect(again.ok).toBe(false);
        expect(asRecord(again.error)).toEqual({ message: collectionExistsSentence('t10_probe_notes') });

        // A third owner would have moved the store twice; a `define` moves the COLLECTIONS
        // watermark only, and the panel's row reads are unaffected either way.
        const spareSnapshot = asRecord((await call(server.url, `/v1/storyline/sessions/${spareId}/records`)).body);

        expect(spareSnapshot.store_rev).toBe(0);
        expect(spareSnapshot.collections_rev).toBe(3);
        expect((spareSnapshot.collections as unknown[]).map(asRecord).map((collection) => collection.name)).toEqual([
            'tasks',
            'chapters',
            'profiles',
            'locations',
            'outlines',
            'storyline',
            't10_probe_notes'
        ]);
    });
});
