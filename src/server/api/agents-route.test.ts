// `GET /agents` and `PATCH /agents/:kind` — the global Story-agent roster the right panel renders,
// including the model each agent asks for (U-8, T-6b).
import { describe, expect, it } from 'vitest';
import { buildStorylineRuntime } from './server';
import { Store } from '../store/store';

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
        model,
        model_source: 'default',
        template_models: [],
        working: []
    },
    {
        kind: 'editor',
        title: 'Editor',
        status: 'idle',
        model,
        model_source: 'default',
        template_models: [],
        working: []
    },
    {
        kind: 'reader',
        title: 'Reader',
        status: 'idle',
        model,
        model_source: 'default',
        template_models: [],
        working: []
    },
    {
        kind: 'checker',
        title: 'Checker',
        status: 'idle',
        model,
        model_source: 'default',
        template_models: [],
        working: []
    }
];

describe('GET /agents', () => {
    it('answers the four global agents, and the model each one asks for, before any Story dispatches work', async () => {
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

    it('refuses an unknown agent kind rather than inventing a fifth tile (U-8)', async () => {
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
