// Unit tests for the REST layer: the `/v1/storyline` mount, the session/turn call
// shapes, and every wire-row projection.
//
// WHAT IS MOCKED: `globalThis.fetch` only. Everything above it is the real code —
// including the harness client (which builds the URL, stamps the headers and parses
// the error envelope), so these tests also pin the MOUNT itself: the recorded URL
// for `POST /sessions` is `/v1/storyline/sessions`, which is the fixed contract and
// the thing most likely to silently regress.
//
// TWO CALL SHAPES ARE THE WHOLE POINT of the T11 fixes and are pinned at that boundary:
// `GET .../threads` rows carry `owner_thread_id` and the reuse rule must refuse them
// (`selectAgentThread`), and `GET .../threads/{tid}/transcript/messages` is the only read
// that can show a chained turn at all (`readThreadMessages`, see the section above
// `threadMessagesFromEntries` in ./storyline.ts for why no turn-based read can).
//
// The assertions are EXACT: full URLs, full JSON bodies, full projected rows. Where
// the wire is allowed to be partial (a chapter with no `order`, an unknown status,
// a non-array `traits`) the expected value is the documented default, spelled out.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORYLINE_API_ROOT } from './root';
import {
    chapterDetailFromToolPayload,
    createStorylineApi,
    ensureResultOf,
    recordsFromSnapshot,
    profileLabel,
    selectAgentThread,
    sortChapters,
    threadMessagesFromEntries,
    titleRowsFromPages,
    turnTextFromDisplay,
    STORYLINE_HARNESS_ID,
    STORYLINE_SECTION_FIELDS,
    type ChapterRow,
    type StorylineThreadRef
} from './storyline';

type Call = { url: string; method: string; body: unknown };

/** One canned answer: the status the client sees and the JSON body it parses. */
type Stub = { status?: number; body: unknown };

const calls: Call[] = [];

/**
 * `METHOD url` -> canned answer. Exact keys (not predicates) are deliberate: a
 * typo in a URL this package builds becomes a visible 404 instead of a route that
 * quietly matched the wrong thing.
 */
const mockFetch = (routes: Record<string, Stub>): void => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input);
        const method = String(init.method ?? 'GET');
        const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : null;

        calls.push({ url, method, body });

        const stub = routes[`${method} ${url}`];
        const status = stub?.status ?? 200;

        return new Response(
            JSON.stringify(stub === undefined ? { error: { message: `no route for ${method} ${url}` } } : stub.body),
            { status, headers: { 'content-type': 'application/json' } }
        );
    });
};

beforeEach(() => {
    calls.length = 0;
});

afterEach(() => {
    vi.unstubAllGlobals();
});

/**
 * A roster row in full (the `StorylineThreadRef` both planes project to, src/api/stream.ts).
 * The reuse rule reads `agent`/`origin`/`sequence`/`ownerThreadId`, and the fixture spells
 * out the rest because the rule is written against the whole row — `toEqual` on a selection
 * compares every field, so a mapper that starts inventing a label or a count fails here.
 */
const threadRow = (id: string, agent: string, origin: 'host' | 'agent', sequence: number): StorylineThreadRef => ({
    id,
    agent,
    origin,
    sequence,
    ownerThreadId: '',
    status: 'idle',
    label: `storyline:${agent}`,
    messageCount: 0,
    transcriptState: 'ok'
});

describe('the /v1/storyline mount', () => {
    it('dials the storyline root, not the harness default', async () => {
        // `POST /sessions` answers a Session RESPONSE (`{ session }`), which is what
        // the harness client unwraps — pinned here so a projection change cannot
        // silently read `body.id` and return '' forever.
        mockFetch({ 'POST /v1/storyline/sessions': { body: { session: { id: 'ses-1', title: 'Storyline', harness: 'story' } } } });

        const api = createStorylineApi();
        const row = await api.createTitle('Storyline');

        expect(api.root()).toBe(STORYLINE_API_ROOT);
        expect(row.id).toBe('ses-1');
        // The whole point of src/api/root.ts, asserted at the request boundary — and the
        // harness id is the FIXED one, never a preset discovered from a catalogue.
        expect(calls).toEqual([{ url: '/v1/storyline/sessions', method: 'POST', body: { harness: STORYLINE_HARNESS_ID, title: 'Storyline' } }]);
    });

    it('derives the stream URL from the same root', () => {
        // jsdom's origin is http://localhost:3000, and the socket URL is produced by
        // the harness client itself — so REST and WS cannot disagree by construction.
        expect(createStorylineApi().socketUrl()).toBe('ws://localhost:3000/v1/storyline/stream');
    });
});

describe('title lifecycle calls', () => {
    it('lists Titles as sessions, filtered to this app\'s harness server-side', async () => {
        // The filter lives in the query: `GET /harnesses` has no place in this UI's path
        // any more, because the app already knows the one harness it ships.
        mockFetch({
            'GET /v1/storyline/sessions?limit=100&harness=storyline': {
                body: {
                    items: [
                        // Out of order on purpose, and one row without an id: the rail's
                        // order is created_at DESC and a nameless row names no Title.
                        { id: 'ses-old', title: 'Deep Sea', created_at: 100, updated_at: 180, status: 'idle', turn_count: 2, thread_count: 1 },
                        { id: 'ses-new', created_at: 300, updated_at: 300, status: 'running', turn_count: 0, thread_count: 0 },
                        { title: 'Ghost', created_at: 400 }
                    ],
                    next_cursor: null,
                    revision: 5,
                    limit: 100
                }
            }
        });

        expect(await createStorylineApi().listTitles()).toEqual([
            { id: 'ses-new', title: '', label: 'Untitled 1', createdAt: 300, updatedAt: 300, status: 'running', turnCount: 0, threadCount: 0 },
            { id: 'ses-old', title: 'Deep Sea', label: 'Deep Sea', createdAt: 100, updatedAt: 180, status: 'idle', turnCount: 2, threadCount: 1 }
        ]);
        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /v1/storyline/sessions?limit=100&harness=storyline']);
    });

    it('follows the cursor for at most three pages, so a huge library cannot hang the rail', async () => {
        // Each page answers a cursor, so a loop without a bound would fetch forever.
        const page = (id: string, next: string | null) => ({
            items: [{ id, created_at: id === 'ses-1' ? 100 : 200, updated_at: 200, status: 'idle', turn_count: 0, thread_count: 0 }],
            next_cursor: next,
            revision: 1,
            limit: 100
        });

        mockFetch({
            'GET /v1/storyline/sessions?limit=100&harness=storyline': { body: page('ses-1', 'c2') },
            'GET /v1/storyline/sessions?limit=100&cursor=c2&harness=storyline': { body: page('ses-2', 'c3') },
            'GET /v1/storyline/sessions?limit=100&cursor=c3&harness=storyline': { body: page('ses-3', 'c4') }
            // `c4` has no route: reaching a FOURTH page would answer 404 and fail loudly.
        });

        expect((await createStorylineApi().listTitles()).map((row) => row.id)).toEqual(['ses-2', 'ses-3', 'ses-1']);
        expect(calls).toHaveLength(3);
    });

    it('refuses a create that carries no id', async () => {
        mockFetch({ 'POST /v1/storyline/sessions': { body: { session: {} } } });

        await expect(createStorylineApi().createTitle('Storyline')).rejects.toThrow('The storyline server created a title without an id.');
    });

    it('treats a collection the server already owns as a success — the code rides in the MESSAGE', async () => {
        // VERIFIED LIVE against a booted gateway (T10): the create hook (./../server/service.ts
        // `finalizeStorylineSessionCreate`) already owns both folders, and the tool-execution
        // route serializes the refusal as the closed `{ ok: false, error: { message } }`
        // envelope — there is NO `code` field on the wire. A classifier that read only `code`
        // reported both folders of EVERY existing Title as a failed define, which the titles
        // plugin renders as its failure strip on every activation. This body is the answer the
        // route really sends, quoted from the probe; the ensure still NEVER rejects, because a
        // Title whose outline cannot be created is still a Title.
        const already =
            'collection-exists: A collection named "outlines" is already defined; a re-define is refused rather than merged, because it would silently change a live contract.';

        mockFetch({
            'POST /v1/storyline/sessions/ses-1/tools/records/executions': {
                body: { ok: false, error: { message: already }, duration_ms: 1 }
            }
        });

        expect(await createStorylineApi().ensureCollections('ses-1')).toEqual({
            sessionId: 'ses-1',
            results: [
                { name: 'outlines', state: 'exists', error: '' },
                { name: 'storyline', state: 'exists', error: '' }
            ]
        });
        // Both defines go through the `records` tool with the same field spec, which is
        // what makes the store's own page order ascending (`order` is sortable).
        expect(calls.map((call) => call.body)).toEqual([
            { parameters: { define: { name: 'outlines', fields: STORYLINE_SECTION_FIELDS } } },
            { parameters: { define: { name: 'storyline', fields: STORYLINE_SECTION_FIELDS } } }
        ]);
    });

    it('reads the exists answer through every spelling the engine uses', () => {
        // The engine codes one refusal THREE ways on purpose (harness src/core/records.ts:195-198):
        // the thrown object carries `name`, `code`, AND the message token. Over REST only the
        // message survives, and an in-process host may hand this classifier the thrown object
        // itself — so all three spellings are the success case. Any other refusal keeps the
        // server's own sentence for the pane, and a refusal with no sentence keeps the
        // collection's name, which is the only thing still worth telling the user.
        expect(ensureResultOf('outlines', { message: 'collection-exists: A collection named "outlines" is already defined.' })).toEqual({
            name: 'outlines',
            state: 'exists',
            error: ''
        });
        expect(ensureResultOf('storyline', { code: 'collection-exists', message: 'already defined' })).toEqual({
            name: 'storyline',
            state: 'exists',
            error: ''
        });
        expect(ensureResultOf('storyline', { name: 'collection-exists' })).toEqual({ name: 'storyline', state: 'exists', error: '' });
        expect(ensureResultOf('outlines', { code: 'forbidden', message: 'this session is read only' })).toEqual({
            name: 'outlines',
            state: 'failed',
            error: 'this session is read only'
        });
        expect(ensureResultOf('outlines', {})).toEqual({ name: 'outlines', state: 'failed', error: 'the records tool refused to define outlines' });
    });

    it('reports a store that refuses the define for another reason, with the server\'s sentence', async () => {
        mockFetch({
            'POST /v1/storyline/sessions/ses-1/tools/records/executions': {
                body: { ok: false, error: { code: 'forbidden', message: 'this session is read only' }, duration_ms: 1 }
            }
        });

        expect(await createStorylineApi().ensureCollections('ses-1')).toEqual({
            sessionId: 'ses-1',
            results: [
                { name: 'outlines', state: 'failed', error: 'this session is read only' },
                { name: 'storyline', state: 'failed', error: 'this session is read only' }
            ]
        });
    });
});

describe('the submit path (agent targeting)', () => {
    it('addresses one agent thread explicitly, because the submit has no agent field', async () => {
        mockFetch({
            'POST /v1/storyline/sessions/ses-1/tasks': {
                status: 202,
                body: {
                    session_id: 'ses-1',
                    turn_id: 'turn-9',
                    thread_id: 'thr-editor',
                    status: 'queued',
                    session_revision: 3,
                    accepted_at: 1,
                    links: {}
                }
            }
        });

        const receipt = await createStorylineApi().submit('ses-1', 'thr-editor', 'Tighten the opening.');

        expect(calls).toEqual([
            {
                url: '/v1/storyline/sessions/ses-1/tasks',
                method: 'POST',
                body: { input: 'Tighten the opening.', thread_id: 'thr-editor' }
            }
        ]);
        expect(receipt).toEqual({ turnId: 'turn-9', threadId: 'thr-editor' });
    });

    it('reuses the newest HOST thread of the agent instead of forking a conversation', async () => {
        mockFetch({
            // The roster the reuse rule reads.
            'GET /v1/storyline/sessions/ses-1/threads?limit=100': {
                body: {
                    items: [
                        { id: 'thr-w-1', agent: 'writer', origin: 'host', sequence: 2 },
                        // An agent-spawned subagent conversation is not the
                        // composer's surface, even when it is newer.
                        { id: 'thr-w-2', agent: 'writer', origin: 'agent', sequence: 7 },
                        { id: 'thr-w-3', agent: 'writer', origin: 'host', sequence: 5 },
                        // The conversation the writer's `delegate` call opened for the
                        // reader's answer: a HOST row with the newest sequence, and the one
                        // the reuse rule must still refuse because it carries an owner.
                        { id: 'thr-w-4', agent: 'writer', origin: 'host', sequence: 9, owner_thread_id: 'thr-w-3' },
                        { id: 'thr-r-1', agent: 'reader', origin: 'host', sequence: 1 }
                    ],
                    nextCursor: null,
                    revision: 1,
                    limit: 100
                }
            },
            // The editor has no conversation yet, so exactly one create happens.
            'POST /v1/storyline/sessions/ses-1/threads': {
                body: { thread: { id: 'thr-e-9', agent: 'editor', origin: 'host', sequence: 8 } }
            }
        });

        const api = createStorylineApi();

        expect(await api.openThread('ses-1', 'writer')).toBe('thr-w-3');
        expect(await api.openThread('ses-1', 'editor')).toBe('thr-e-9');

        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'GET /v1/storyline/sessions/ses-1/threads?limit=100',
            'GET /v1/storyline/sessions/ses-1/threads?limit=100',
            'POST /v1/storyline/sessions/ses-1/threads'
        ]);
        expect(calls[2]?.body).toEqual({ agent: 'editor', label: 'storyline:editor' });
    });

    it('selectAgentThread prefers the most recent host thread and refuses another agent\'s', () => {
        const threads = [threadRow('a', 'writer', 'agent', 9), threadRow('b', 'writer', 'host', 3), threadRow('c', 'writer', 'host', 4)];

        expect(selectAgentThread(threads, 'writer')).toEqual(threadRow('c', 'writer', 'host', 4));
        expect(selectAgentThread(threads, 'editor')).toBeNull();
    });

    it('selectAgentThread refuses a delegated child, however new its sequence', () => {
        // THE REAL BUG THIS PINS. The writer's `delegate` tool opens a conversation for the
        // agent it delegated to, and that row is `origin: 'host'` as well (harness
        // src/types/index.ts:2430) — verified against a running mount, `GET /threads` answered
        // `{ id: 'thread-2', agent: 'reader', owner_thread_id: 'thread-1' }`. Ranking on
        // `origin` + `sequence` alone therefore handed the composer to the delegated child,
        // while the server's chain wrote its answer into `thread-1` (src/server/
        // orchestrator.ts `storylineTargetThread`), so the two addressed different
        // conversations. The owner link is what separates them, and the newer row loses.
        const own = { ...threadRow('thread-1', 'reader', 'host', 4), messageCount: 6 };
        const child = { ...threadRow('thread-2', 'reader', 'host', 9), ownerThreadId: 'thread-1' };

        expect(selectAgentThread([child, own], 'reader')).toEqual(own);

        // An agent whose ONLY conversation is a delegation has no composer surface at all —
        // which is the truth, and the answer `openThread` acts on by opening a new one.
        expect(selectAgentThread([child], 'reader')).toBeNull();

        // An agent-spawned row that carries no owner is still ranked last, and a row for a
        // different agent never wins.
        expect(selectAgentThread([threadRow('a', 'writer', 'host', 1), threadRow('b', 'editor', 'host', 8)], 'writer')).toEqual(
            threadRow('a', 'writer', 'host', 1)
        );
    });
});

describe('the conversation read', () => {
    it('projects the entries of one exchange, at their absolute transcript positions', () => {
        // The wire entries are `HarnessMessage`s (harness src/types/index.ts:181). What an
        // operator reads is the pair: the prompt and the answer. The rest is dropped, with the
        // reason in the mapper's comment — and the positions are ABSOLUTE (the second page
        // starts at 2), because that is the key a caller compares reads against.
        expect(
            threadMessagesFromEntries(
                [
                    { role: 'system', content: 'You are the writer.' },
                    { role: 'user', content: 'Review what changed.', messageId: 'm-1' },
                    // A tool-call turn's assistant entry carries no prose beside its calls.
                    { role: 'assistant', content: '', toolCalls: [{ id: 'c-1', name: 'records', arguments: '{}' }] },
                    { role: 'tool', content: '{"ok":true}', toolCallId: 'c-1' },
                    { role: 'assistant', content: '  Chapter two now opens at the harbour.\n', messageId: 'm-2' },
                    // A role the contract does not state is not conversation.
                    { role: 'unknown', content: 'ignored' }
                ],
                3
            )
        ).toEqual([
            { position: 4, messageId: 'm-1', role: 'user', text: 'Review what changed.' },
            { position: 7, messageId: 'm-2', role: 'agent', text: 'Chapter two now opens at the harbour.' }
        ]);

        // Total: a non-array and a malformed entry degrade instead of throwing.
        expect(threadMessagesFromEntries([])).toEqual([]);
    });

    it('walks the transcript pages and reports the conversation the prose belongs to', async () => {
        // THE ROUTE, pinned at the request boundary: `GET
        // {root}/sessions/{id}/threads/{tid}/transcript/messages` — the published read
        // (harness src/frontend/api.ts:1407). The cursor is OPAQUE and issued by the route
        // (src/server/api-paging.ts), so paging forward means handing back `next_cursor`
        // exactly as it arrived, which is what these two recorded URLs prove.
        mockFetch({
            'GET /v1/storyline/sessions/ses-1/threads/thread-1/transcript/messages?limit=100': {
                body: {
                    items: [
                        { role: 'system', content: 'instructions' },
                        { role: 'user', content: 'You were called because the editor finished a turn.', messageId: 'm-1' }
                    ],
                    next_cursor: 'cur-2',
                    observed_at: 1,
                    revision: 7,
                    limit: 2,
                    thread_id: 'thread-1',
                    agent: 'writer',
                    transcript_state: 'ok',
                    total: 3
                }
            },
            'GET /v1/storyline/sessions/ses-1/threads/thread-1/transcript/messages?limit=100&cursor=cur-2': {
                body: {
                    items: [{ role: 'assistant', content: 'The opening still holds; chapter five is the problem.', messageId: 'm-2' }],
                    next_cursor: null,
                    observed_at: 2,
                    revision: 7,
                    limit: 1,
                    thread_id: 'thread-1',
                    agent: 'writer',
                    transcript_state: 'ok',
                    total: 3
                }
            }
        });

        expect(await createStorylineApi().readThreadMessages('ses-1', 'thread-1')).toEqual({
            sessionId: 'ses-1',
            threadId: 'thread-1',
            agent: 'writer',
            total: 3,
            state: 'ok',
            truncated: false,
            messages: [
                { position: 1, messageId: 'm-1', role: 'user', text: 'You were called because the editor finished a turn.' },
                { position: 2, messageId: 'm-2', role: 'agent', text: 'The opening still holds; chapter five is the problem.' }
            ]
        });

        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'GET /v1/storyline/sessions/ses-1/threads/thread-1/transcript/messages?limit=100',
            'GET /v1/storyline/sessions/ses-1/threads/thread-1/transcript/messages?limit=100&cursor=cur-2'
        ]);
    });

    it('stops the page walk at its bound and says so instead of reading forever', async () => {
        // Every page hands back the same cursor, so the walk cannot end on its own; the bound
        // (4 pages) is what stops it, and `truncated` is the honest sentence that the read is
        // the newest part rather than the whole transcript.
        const page = (items: unknown[], next: string | null) => ({
            body: {
                items,
                next_cursor: next,
                observed_at: 1,
                revision: 1,
                limit: items.length,
                thread_id: 'thread-1',
                agent: 'writer',
                transcript_state: 'ok',
                total: 5
            }
        });

        mockFetch({
            'GET /v1/storyline/sessions/ses-1/threads/thread-1/transcript/messages?limit=100': page([{ role: 'user', content: 'a' }], 'cur'),
            'GET /v1/storyline/sessions/ses-1/threads/thread-1/transcript/messages?limit=100&cursor=cur': page([{ role: 'user', content: 'a' }], 'cur')
        });

        const read = await createStorylineApi().readThreadMessages('ses-1', 'thread-1');

        expect(read.truncated).toBe(true);
        expect(read.messages.map((message) => message.position)).toEqual([0, 1, 2, 3]);
        expect(calls).toHaveLength(4);
    });
});

describe('record projection', () => {
    const snapshot = {
        session_id: 'ses-1',
        revision: 4,
        store_rev: 12,
        collections_rev: 2,
        collections: [
            {
                name: 'tasks',
                store_rev: 1,
                count: 1,
                fields: [],
                entries: [{ id: 't1', rev: 1, text: 'draft ch1', completed: false }]
            },
            {
                name: 'chapters',
                store_rev: 3,
                count: 3,
                fields: [],
                entries: [
                    // Deliberately NOT in `order` sequence, and with no `content`
                    // anywhere: a list read never carries the getOnly body.
                    { id: 'ch-3', rev: 2, title: 'Three', summary: 'late', status: 'draft' },
                    { id: 'ch-1', rev: 1, title: 'One', summary: 'open', status: 'planned', order: 10 },
                    { id: 'ch-2', rev: 4, title: 'Two', summary: 'middle', status: 'nonsense', order: 5 }
                ]
            },
            {
                name: 'profiles',
                store_rev: 2,
                count: 2,
                fields: [],
                entries: [
                    { id: 'p-1', rev: 1, name: 'Ada', description: 'Cartographer', traits: ['proud', 'curious', 7], notes: 'leads the third act' },
                    // `traits` absent and status-ish fields missing: the defaults apply.
                    { id: 'p-2', rev: 3, name: 'Vane', description: 'Rival' }
                ]
            },
            {
                // The two section stores the tree's left half is built from. `content` is
                // NOT getOnly, so a snapshot carries the bodies and the center pane needs
                // one read per Title; one row is deliberately written out of order.
                name: 'outlines',
                store_rev: 4,
                count: 2,
                fields: [],
                entries: [
                    { id: 'sec-2', rev: 1, heading: 'The fog', content: 'Ada sails.', order: 2 },
                    { id: 'sec-1', rev: 2, heading: 'Cold open', content: 'The harbour is empty.', order: 1 }
                ]
            },
            {
                name: 'storyline',
                store_rev: 1,
                count: 1,
                fields: [],
                // No `content` and no `order` at all: the row says so instead of guessing.
                entries: [{ id: 'sec-3', rev: 1, heading: 'Unwritten' }]
            }
        ],
        changes: []
    };

    it('projects every bound story collection into exact view rows', () => {
        expect(recordsFromSnapshot(snapshot)).toEqual({
            sessionId: 'ses-1',
            storeRev: 12,
            // `order` first, ascending; the chapter with no order stays last.
            chapters: [
                { id: 'ch-2', rev: 4, title: 'Two', summary: 'middle', status: 'planned', order: 5 },
                { id: 'ch-1', rev: 1, title: 'One', summary: 'open', status: 'planned', order: 10 },
                { id: 'ch-3', rev: 2, title: 'Three', summary: 'late', status: 'draft', order: null }
            ],
            profiles: [
                { id: 'p-1', rev: 1, name: 'Ada', description: 'Cartographer', traits: ['proud', 'curious'], notes: 'leads the third act' },
                { id: 'p-2', rev: 3, name: 'Vane', description: 'Rival', traits: [], notes: '' }
            ],
            outlines: [
                { id: 'sec-1', rev: 2, order: 1, heading: 'Cold open', content: 'The harbour is empty.', hasContent: true },
                { id: 'sec-2', rev: 1, order: 2, heading: 'The fog', content: 'Ada sails.', hasContent: true }
            ],
            storyline: [{ id: 'sec-3', rev: 1, order: null, heading: 'Unwritten', content: '', hasContent: false }],
            hasChapters: true,
            hasProfiles: true,
            hasOutlines: true,
            hasStoryline: true
        });
    });

    it('reports a store that binds no story collections instead of faking empty ones', () => {
        const bare = { session_id: 'ses-2', store_rev: 0, collections: [{ name: 'tasks', entries: [] }], changes: [] };

        expect(recordsFromSnapshot(bare)).toEqual({
            sessionId: 'ses-2',
            storeRev: 0,
            chapters: [],
            profiles: [],
            outlines: [],
            storyline: [],
            hasChapters: false,
            hasProfiles: false,
            hasOutlines: false,
            hasStoryline: false
        });
    });

    it('names a profile with no gender trait by name alone, and a gendered one with the suffix', () => {
        const [ada, vane] = recordsFromSnapshot(snapshot).profiles;

        // The `(F)` / `(M)` suffix is the fixed contract. `profiles` has no gender
        // FIELD, so the convention is a trait, matched case-insensitively; a profile
        // with no such trait gets no suffix, which is the honest answer.
        expect(profileLabel(ada)).toBe('Ada');
        expect(profileLabel({ ...vane, traits: [' Female '] })).toBe('Vane (F)');
        expect(profileLabel({ ...vane, traits: ['m'] })).toBe('Vane (M)');
    });

    it('reads records through the records route and normalizes them', async () => {
        mockFetch({ 'GET /v1/storyline/sessions/ses-1/records': { body: snapshot } });

        const records = await createStorylineApi().readRecords('ses-1');

        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /v1/storyline/sessions/ses-1/records']);
        expect(records.chapters.map((chapter) => chapter.id)).toEqual(['ch-2', 'ch-1', 'ch-3']);
        expect(records.profiles[1]).toEqual({ id: 'p-2', rev: 3, name: 'Vane', description: 'Rival', traits: [], notes: '' });
    });
});

describe('chapter body and edit calls (the record store has no REST writes)', () => {
    it('reads the getOnly body through the chapters tool, beside the singular key', async () => {
        // The tool-execution route, and the `ToolCallResult` union it answers with
        // (both outcomes are HTTP 200, so `ok` is the only branch that matters).
        mockFetch({
            'POST /v1/storyline/sessions/ses-1/tools/chapters/executions': {
                body: { ok: true, result: { chapter: { id: 'ch-1', rev: 3, title: 'One', summary: 'open', status: 'draft' }, content: 'The fog came in.', counts: {} }, duration_ms: 4 }
            }
        });

        expect(await createStorylineApi().readChapter('ses-1', 'ch-1')).toEqual({
            id: 'ch-1',
            rev: 3,
            title: 'One',
            summary: 'open',
            status: 'draft',
            order: null,
            content: 'The fog came in.'
        });
        expect(calls[0]?.body).toEqual({ parameters: { action: 'get', id: 'ch-1' } });
    });

    it('writes an update through the tool and surfaces a tool failure as an error', async () => {
        // A session that binds no `chapters` tool answers `ok: false` at HTTP 200;
        // the panel must show the server's sentence, not a silently read-only pane.
        mockFetch({
            'POST /v1/storyline/sessions/ses-1/tools/chapters/executions': {
                body: { ok: false, error: { code: 'unknown_tool', message: 'this session binds no chapters tool' }, duration_ms: 1 }
            }
        });

        // GUARDED WRITE: the store requires the CAS token the caller read, so a stale
        // click fails as a conflict instead of overwriting an agent's newer edit.
        await expect(createStorylineApi().setChapterStatus('ses-1', { id: 'ch-1', rev: 3 }, 'complete')).rejects.toThrow(
            'chapters update: this session binds no chapters tool'
        );
        expect(calls[0]?.body).toEqual({ parameters: { action: 'update', id: 'ch-1', status: 'complete', expects: [{ id: 'ch-1', rev: 3 }] } });
    });

    it('keeps a chapter detail null when the tool answers without an entry', () => {
        expect(chapterDetailFromToolPayload({ counts: {} })).toBeNull();
    });

    it('sorts chapters: explicit order ascending first, the rest in insertion order', () => {
        const chapter = (id: string, order: number | null): ChapterRow => ({
            id,
            rev: 1,
            title: id,
            summary: '',
            status: 'planned',
            order
        });

        expect(sortChapters([chapter('a', null), chapter('b', 2), chapter('c', 1), chapter('d', null)]).map((row) => row.id)).toEqual([
            'c',
            'b',
            'a',
            'd'
        ]);
    });
});

// ---------------------------------------------------------------------------
// The turn display read — the answer of a THREAD-TARGETED turn
// ---------------------------------------------------------------------------
//
// WHY THESE SHAPES ARE NOT INVENTED. A display document is a `TurnDisplay`
// (harness `src/shared/turn-display.ts:1073`); its sections are `TurnSection`
// (:953) and its nodes are the four members of the `DisplayNode` union —
// `DisplayTextNode` (:772), `DisplayReasoningNode` (:792), `DisplayStep` (:721) and
// `DisplayNoticeNode` (:819). The projector stamps `role: 'primary'` on a section
// ONLY when it is the root section AND its agent is the session primary
// (`src/server/turn-projector.ts:723`, and the same test in `inlineSection` at
// :953), so a host-thread run of `reader` or `editor` answers as a `subagent`-role
// ROOT section. Extraction keyed on `role === 'primary'` alone therefore returns ''
// for two of this UI's three agents — the defect these tests pin shut.
describe('the turn display read (thread-targeted answers)', () => {
    /** `DisplayTextNode` — committed prose, exactly as the projector emits it. */
    const textNode = (id: string, text: string) => ({ kind: 'text', id, text, committed: true, chars: text.length });

    /** `DisplayReasoningNode` — a thinking window: never part of the answer. */
    const reasoningNode = (id: string, text: string) => ({ kind: 'reasoning', id, text, share: 0.25, chars: text.length });

    /** `DisplayStep` — a settled tool call. Its `preview` is display noise. */
    const toolStep = (id: string, sectionId: string, name: string, preview: string) => ({
        kind: 'tool',
        id,
        turnId: 'turn-9',
        sectionId,
        name,
        state: 'complete',
        preview,
        detail: { stepId: id, hasResult: true, truncated: false }
    });

    /** `DisplayNoticeNode` — a one-line notice, also not the answer. */
    const noticeNode = (id: string, text: string) => ({ kind: 'notice', id, tone: 'answer', text });

    /** A `TurnSection` in the wire's camelCase, `parentSectionId` only when nested. */
    const section = (
        id: string,
        role: string,
        agent: string,
        nodes: readonly unknown[],
        extra: Record<string, unknown> = {}
    ) => ({
        id,
        role,
        agent,
        agentLabel: agent,
        state: 'closed',
        context: [],
        nodes,
        ...extra
    });

    // The observed payload of a `reader` host-thread turn: ONE root section, role
    // `subagent`, agent `reader`, holding reasoning + prose + tool rows.
    const readerDisplay = {
        turnId: 'turn-9',
        sections: [
            section('turn-9:0', 'subagent', 'reader', [
                reasoningNode('1', 'Skim the chapter for the turn.'),
                textNode('2', 'Chapter two opens on an empty harbour.'),
                toolStep('3', 'turn-9:0', 'chapters', 'get ch-2'),
                textNode('4', ' The prose is clean.')
            ])
        ]
    };

    it('extracts the answering agent\'s prose out of a subagent-role root section', () => {
        // Both text nodes of the answering section, in document order, and NOTHING
        // else: the reasoning window, the tool row and its preview stay out.
        expect(turnTextFromDisplay(readerDisplay, 'reader')).toBe('Chapter two opens on an empty harbour. The prose is clean.');
        // No hint (a resync that no longer knows the agent) still finds the root flow.
        expect(turnTextFromDisplay(readerDisplay)).toBe('Chapter two opens on an empty harbour. The prose is clean.');
    });

    it('leaves a primary turn reading exactly as it did', () => {
        const writerDisplay = {
            turnId: 'turn-1',
            sections: [
                section('turn-1:0', 'primary', 'writer', [
                    reasoningNode('1', 'Plan the opening.'),
                    textNode('2', 'Chapter one is done.'),
                    noticeNode('3', '2 calls')
                ])
            ]
        };

        expect(turnTextFromDisplay(writerDisplay, 'writer')).toBe('Chapter one is done.');
        expect(turnTextFromDisplay(writerDisplay)).toBe('Chapter one is done.');
    });

    it('names one answering section instead of concatenating every section', () => {
        const mixed = {
            turnId: 'turn-1',
            sections: [
                section('turn-1:0', 'primary', 'writer', [textNode('2', 'Chapter one is written.')]),
                // A delegated child of the SAME turn: its prose is a report, not the
                // answer, and it must never be glued onto (or replace) the answer.
                section('turn-1:1', 'subagent', 'reader', [
                    toolStep('3', 'turn-1:1', 'chapters', 'get ch-1'),
                    textNode('4', 'A delegated aside.')
                ], { parentSectionId: 'turn-1:0' })
            ]
        };

        expect(turnTextFromDisplay(mixed, 'writer')).toBe('Chapter one is written.');
        // The same document addressed to the delegated reader answers with its OWN
        // prose — that is what "surface the answering agent's text" means.
        expect(turnTextFromDisplay(mixed, 'reader')).toBe('A delegated aside.');
    });

    it('answers no prose for a turn that made no prose', () => {
        const toolsOnly = {
            turnId: 'turn-2',
            sections: [section('turn-2:0', 'primary', 'writer', [toolStep('1', 'turn-2:0', 'chapters', 'add ch-1')])]
        };

        expect(turnTextFromDisplay(toolsOnly, 'writer')).toBe('');
        expect(turnTextFromDisplay({ turnId: 'turn-3', sections: [] }, 'writer')).toBe('');
        expect(turnTextFromDisplay(undefined)).toBe('');
        expect(turnTextFromDisplay(null, 'reader')).toBe('');
    });

    it('settles a streamed reader turn over the display route', async () => {
        mockFetch({ 'GET /v1/storyline/sessions/ses-1/turns/turn-9/display': { body: { display: readerDisplay } } });

        expect(await createStorylineApi().readTurnText('ses-1', 'turn-9', 'reader')).toBe(
            'Chapter two opens on an empty harbour. The prose is clean.'
        );
        expect(calls).toEqual([{ url: '/v1/storyline/sessions/ses-1/turns/turn-9/display', method: 'GET', body: null }]);
    });
});
