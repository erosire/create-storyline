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

const idleRows = (model: string) => [
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
    {
        kind: 'checker',
        title: 'Checker',
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
    it('answers the four global employees, and the model each one asks for, before any Story dispatches work', async () => {
        const runtime = buildStorylineRuntime({
            store: Store.empty(),
            engineConfig: { autoSweep: false },
            noAssistantSeed: true,
            env: ENV
        });

        const response = await runtime.app.request('http://localhost/v1/storyline/agents');

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(idleRows('scripted'));
    });

    it('keeps a torn-down run and its reason visible on the idle agent’s tile (S-3)', async () => {
        const store = Store.empty();

        store.runs.create(
            {
                story_id: 'story_1',
                work_item_ref: 'wi_check_chapters_1',
                role: 'checker',
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
        const checker = rows.find((row) => row.kind === 'checker');

        expect(checker?.status).toBe('idle');
        expect(checker?.recent).toHaveLength(1);
        expect(checker?.recent[0]).toMatchObject({
            run_id: 'run_1',
            work_item: 'wi_check_chapters_1',
            state: 'failed',
            no_op: true
        });
        expect(String(checker?.recent[0]?.end_reason)).toContain('Field required');
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
            error: 'no agent named "explorer" — the global roster is writer, editor, reader and checker (U-8).'
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
    it('sets one agent’s model and leaves the other three on the process default', async () => {
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
        expect(await response.json()).toEqual([
            { ...idleRows('scripted')[0], model: 'deepseek-r1', model_source: 'agent' },
            ...idleRows('scripted').slice(1)
        ]);

        // The write is the roster's, not the request's: a second GET reads the choice back.
        const reread = await runtime.app.request('http://localhost/v1/storyline/agents');

        expect((await reread.json())[0]).toMatchObject({ kind: 'writer', model: 'deepseek-r1', model_source: 'agent' });
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
        expect((await cleared.json())[1]).toMatchObject({
            kind: 'editor',
            model: 'scripted',
            model_source: 'default'
        });
    });

    it('refuses an unknown employee kind rather than inventing a fifth tile (U-8)', async () => {
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
            error: 'no agent named "explorer" — the global roster is writer, editor, reader and checker (U-8).'
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
