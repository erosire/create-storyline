// `GET /agents` and `PATCH /agents/:kind` — the global employee roster the right panel renders,
// including the model each agent asks for (U-8, T-6b).
import { describe, expect, it } from 'vitest';
import { buildStorylineRuntime } from './server';
import { Store } from '../store/store';
import { StoryThreadLog } from '../run/thread-log';

const ENV = {
    STORYLINE_PROVIDER_BASE_URL: 'http://127.0.0.1:1/v1',
    STORYLINE_PROVIDER_MODEL: 'scripted',
    STORYLINE_PROVIDER_API_KEY: ''
};

/**
 * The roster exactly as `GET /agents` answers it: ALPHABETICAL by employee kind (T12/F1).
 *
 * The harness projects in catalogue order (writer, editor, critic, reader, researcher), but U-8 and
 * documents/phase-1-research-pipeline.md §7.3 say the roster lists alphabetically, so the route sorts
 * a copy. This fixture is therefore the ROUTE's order, not the catalogue's — the distinction is the
 * point of the first test below.
 */
const idleRows = (model: string) => [
    {
        kind: 'critic',
        title: 'Critic',
        status: 'idle',
        rank: 'A',
        model,
        model_source: 'default',
        template_models: [],
        working: [],
        recent: []
    },
    {
        kind: 'editor',
        title: 'Editor',
        status: 'idle',
        rank: 'A',
        model,
        model_source: 'default',
        template_models: [],
        working: [],
        recent: []
    },
    // The Reader used to be the Checker, which sorted FIRST. Renamed, it sorts third: after
    // Editor, before Researcher. The route's alphabetical sort is what moves it, not the harness.
    {
        kind: 'reader',
        title: 'Reader',
        status: 'idle',
        rank: 'A',
        model,
        model_source: 'default',
        template_models: [],
        working: [],
        recent: []
    },
    // §7.3 of documents/phase-1-research-pipeline.md: the fifth employee. The catalogue appends it
    // after the original four; alphabetically it sits fourth, between the Reader and the Writer.
    {
        kind: 'researcher',
        title: 'Researcher',
        status: 'idle',
        rank: 'A',
        model,
        model_source: 'default',
        template_models: [],
        working: [],
        recent: []
    },
    {
        kind: 'writer',
        title: 'Writer',
        status: 'idle',
        rank: 'A',
        model,
        model_source: 'default',
        template_models: [],
        working: [],
        recent: []
    }
];

describe('GET /agents', () => {
    it('answers the five global employees, and the model each one asks for, before any Story dispatches work', async () => {
        const runtime = buildStorylineRuntime({
            store: Store.empty(),
            engineConfig: { autoSweep: false },
            noAssistantSeed: true,
            env: ENV
        });

        const response = await runtime.app.request('http://localhost/v1/storyline/agents');

        expect(response.status).toBe(200);
        // The roster is ALPHABETICAL, not the harness catalogue's order (U-8 / §7.3, T12/F1): the
        // exact array pins the presentation order, so a revert to catalogue order fails here.
        expect(await response.json()).toEqual(idleRows('scripted'));

        // The same five rows, in that same order: the roster is the whole set of dispatched kinds
        // (T-0/§7.2), and a kind missing from it is a tile the Author can never configure.
        const kinds = (
            (await (await runtime.app.request('http://localhost/v1/storyline/agents')).json()) as Array<{
                kind: string;
            }>
        ).map((row) => row.kind);

        expect(kinds).toEqual(['critic', 'editor', 'reader', 'researcher', 'writer']);
    });

    it('keeps a torn-down run and its reason visible on the idle agent’s tile (S-3)', async () => {
        const store = Store.empty();

        store.runs.create(
            {
                story_id: 'story_0',
                work_item_ref: 'wi_check_chapters_1',
                role: 'reader',
                state: 'failed',
                started_at: '2026-11-22T10:00:00.000Z',
                ended_at: '2026-11-22T10:00:01.000Z',
                tokens: 0,
                kind: 'work',
                no_op: true,
                end_reason: 'failed — LLM provider fault: Invalid value for `[0].function`: Field required',
                delegated: []
            },
            { run_ref: null, author: true, why: 'seed the failed run the roster must keep visible' }
        );

        const runtime = buildStorylineRuntime({
            store,
            engineConfig: { autoSweep: false },
            noAssistantSeed: true,
            env: ENV
        });

        const response = await runtime.app.request('http://localhost/v1/storyline/agents');
        const rows = (await response.json()) as Array<{
            kind: string;
            status: string;
            recent: Array<Record<string, unknown>>;
        }>;
        const reader = rows.find((row) => row.kind === 'reader');

        expect(reader?.status).toBe('idle');
        expect(reader?.recent).toHaveLength(1);
        expect(reader?.recent[0]).toMatchObject({
            run_id: 'run_0',
            work_item: 'wi_check_chapters_1',
            state: 'failed',
            no_op: true
        });
        expect(String(reader?.recent[0]?.end_reason)).toContain('Field required');
    });
});

describe('GET /agents/:kind/threads', () => {
    it('answers an empty retained history before a thread closes', async () => {
        const runtime = buildStorylineRuntime({
            store: Store.empty(),
            engineConfig: { autoSweep: false },
            noAssistantSeed: true,
            env: ENV
        });

        const response = await runtime.app.request('http://localhost/v1/storyline/agents/writer/threads');

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ kind: 'writer', threads: [] });
    });

    it('lists the retained threads oldest first, with request and answer (U-8)', async () => {
        const store = Store.empty();
        const threadLog = StoryThreadLog.memory();

        threadLog.append({
            thread_id: 'thread-new',
            run_id: 'run_2',
            story_id: 'story_1',
            story_title: 'Old title',
            phase: 'chapters',
            role: 'writer',
            role_name: 'writer',
            title: 'write chapter_2',
            state: 'torn_down',
            started_at: '2026-11-22T10:00:10.000Z',
            ended_at: '2026-11-22T10:00:14.000Z',
            tokens: 42,
            request: 'Write chapter two.',
            answer: 'Chapter two is written.',
            retained: true
        });
        threadLog.append({
            thread_id: 'thread-old',
            run_id: 'run_1',
            story_id: 'story_1',
            story_title: 'Old title',
            phase: 'summary',
            role: 'writer',
            role_name: 'writer',
            title: 'write summary',
            state: 'failed',
            started_at: '2026-11-22T10:00:00.000Z',
            ended_at: '2026-11-22T10:00:01.000Z',
            tokens: 3,
            request: 'Write the Summary.',
            answer: '',
            error: 'failed — provider fault',
            retained: true
        });

        const runtime = buildStorylineRuntime({
            store,
            threadLog,
            engineConfig: { autoSweep: false },
            noAssistantSeed: true,
            env: ENV
        });

        const response = await runtime.app.request('http://localhost/v1/storyline/agents/writer/threads');
        const body = (await response.json()) as { kind: string; threads: Array<Record<string, unknown>> };

        expect(response.status).toBe(200);
        expect(body.kind).toBe('writer');
        expect(body.threads.map((thread) => thread.thread_id)).toEqual(['thread-old', 'thread-new']);
        expect(body.threads[0]).toMatchObject({
            phase: 'summary',
            request: 'Write the Summary.',
            answer: '',
            error: 'failed — provider fault',
            retained: true
        });
    });

    it('refuses an unknown kind rather than inventing a thread list (U-8)', async () => {
        const runtime = buildStorylineRuntime({
            store: Store.empty(),
            engineConfig: { autoSweep: false },
            noAssistantSeed: true,
            env: ENV
        });

        const response = await runtime.app.request('http://localhost/v1/storyline/agents/explorer/threads');

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({
            error: 'no agent named "explorer" — the global roster is writer, editor, reader, critic and researcher (U-8).'
        });
    });
});

describe('GET /agents/models', () => {
    /** A fetch double that answers the OpenAI-compatible catalog and records the URL dialed. */
    const catalogFetch = (data: Array<{ id: string }>, status = 200): { seen: string[]; fetchImpl: typeof fetch } => {
        const seen: string[] = [];
        const fetchImpl = (async (input: string | URL | Request) => {
            seen.push(String(input));

            return new Response(JSON.stringify({ object: 'list', data }), {
                status,
                headers: { 'content-type': 'application/json' }
            });
        }) as typeof fetch;

        return { seen, fetchImpl };
    };

    it('lists the provider catalog at the default base URL the harness engine dials', async () => {
        const { seen, fetchImpl } = catalogFetch([{ id: 'local/basalt' }, { id: 'deepseek-r1' }]);
        const runtime = buildStorylineRuntime({
            store: Store.empty(),
            engineConfig: { autoSweep: false },
            noAssistantSeed: true,
            env: {},
            fetchImpl
        });

        const response = await runtime.app.request('http://localhost/v1/storyline/agents/models');

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            base_url: 'http://localhost:8800/providers/private/v1',
            models: ['local/basalt', 'deepseek-r1']
        });
        expect(seen).toEqual(['http://localhost:8800/providers/private/v1/models']);
    });

    it('follows the provider base URL the process was given', async () => {
        const { seen, fetchImpl } = catalogFetch([{ id: 'scripted' }]);
        const runtime = buildStorylineRuntime({
            store: Store.empty(),
            engineConfig: { autoSweep: false },
            noAssistantSeed: true,
            env: ENV,
            fetchImpl
        });

        const response = await runtime.app.request('http://localhost/v1/storyline/agents/models');

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ base_url: 'http://127.0.0.1:1/v1', models: ['scripted'] });
        expect(seen).toEqual(['http://127.0.0.1:1/v1/models']);
    });

    it('names the provider when its catalog cannot be read', async () => {
        const { fetchImpl } = catalogFetch([], 503);
        const runtime = buildStorylineRuntime({
            store: Store.empty(),
            engineConfig: { autoSweep: false },
            noAssistantSeed: true,
            env: {},
            fetchImpl
        });

        const response = await runtime.app.request('http://localhost/v1/storyline/agents/models');

        expect(response.status).toBe(502);
        expect(await response.json()).toEqual({
            error: `the provider's model catalog at http://localhost:8800/providers/private/v1/models answered 503 — ${JSON.stringify({ object: 'list', data: [] })}`
        });
    });
});

describe('PATCH /agents/:kind', () => {
    it('sets one agent’s model and leaves the other four on the process default', async () => {
        const runtime = buildStorylineRuntime({
            store: Store.empty(),
            engineConfig: { autoSweep: false },
            noAssistantSeed: true,
            env: ENV
        });

        const response = await runtime.app.request('http://localhost/v1/storyline/agents/writer', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'deepseek-r1' })
        });

        expect(response.status).toBe(200);
        // The PATCH answer is the same projection GET answers — SAME alphabetical order (T12/F1),
        // with only the Writer's row changed.
        expect(await response.json()).toEqual(
            idleRows('scripted').map((row) =>
                row.kind === 'writer' ? { ...row, model: 'deepseek-r1', model_source: 'agent' } : row
            )
        );

        // The write is the roster's, not the request's: a second GET reads the choice back. The
        // Writer is the LAST tile alphabetically.
        const reread = await runtime.app.request('http://localhost/v1/storyline/agents');

        expect((await reread.json())[4]).toMatchObject({
            kind: 'writer',
            model: 'deepseek-r1',
            model_source: 'agent'
        });
    });

    it('clears a choice with null, returning the agent to the process default', async () => {
        const runtime = buildStorylineRuntime({
            store: Store.empty(),
            engineConfig: { autoSweep: false },
            noAssistantSeed: true,
            env: ENV
        });

        await runtime.app.request('http://localhost/v1/storyline/agents/editor', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'editor-model' })
        });

        const cleared = await runtime.app.request('http://localhost/v1/storyline/agents/editor', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: null })
        });

        expect(cleared.status).toBe(200);
        // Row 2 of the ALPHABETICAL roster projection (Critic, Editor, Reader, Researcher, Writer):
        // the Editor used to sit at [2], behind the Checker; the Reader sorts after it, so the
        // Editor's row is [1] now. The PATCH targets `/agents/editor`, so this is the row it changed.
        expect((await cleared.json())[1]).toMatchObject({
            kind: 'editor',
            model: 'scripted',
            model_source: 'default'
        });
    });

    it('sets and clears the Researcher’s model like any other employee (U-8, §7.3)', async () => {
        const runtime = buildStorylineRuntime({
            store: Store.empty(),
            engineConfig: { autoSweep: false },
            noAssistantSeed: true,
            env: ENV
        });

        const set = await runtime.app.request('http://localhost/v1/storyline/agents/researcher', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'deepseek-r1' })
        });

        expect(set.status).toBe(200);
        // Row 4 of the ALPHABETICAL roster projection (Critic, Editor, Reader, Researcher, Writer):
        // the same object every other kind answers, with the Author's choice on it and its source
        // recorded (T-6b).
        const rows = (await set.json()) as Array<Record<string, unknown>>;

        expect(rows[3]).toEqual({
            ...idleRows('scripted')[3],
            model: 'deepseek-r1',
            model_source: 'agent'
        });

        const cleared = await runtime.app.request('http://localhost/v1/storyline/agents/researcher', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: null })
        });

        expect(cleared.status).toBe(200);
        expect((await cleared.json())[3]).toMatchObject({
            kind: 'researcher',
            model: 'scripted',
            model_source: 'default'
        });
    });

    it('refuses an unknown employee kind rather than inventing a sixth tile (U-8)', async () => {
        const runtime = buildStorylineRuntime({
            store: Store.empty(),
            engineConfig: { autoSweep: false },
            noAssistantSeed: true,
            env: ENV
        });

        const response = await runtime.app.request('http://localhost/v1/storyline/agents/explorer', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'gpt-5' })
        });

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({
            error: 'no agent named "explorer" — the global roster is writer, editor, reader, critic and researcher (U-8).'
        });
    });

    it('refuses a missing or blank model instead of silently clearing a running configuration', async () => {
        const runtime = buildStorylineRuntime({
            store: Store.empty(),
            engineConfig: { autoSweep: false },
            noAssistantSeed: true,
            env: ENV
        });

        const missing = await runtime.app.request('http://localhost/v1/storyline/agents/writer', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({})
        });
        const blank = await runtime.app.request('http://localhost/v1/storyline/agents/writer', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: '   ' })
        });

        expect(missing.status).toBe(400);
        expect(blank.status).toBe(400);
        expect(await blank.json()).toEqual({
            error: '`model` must be a non-empty string, or null to clear the agent’s choice (T-6b).'
        });
    });
});
