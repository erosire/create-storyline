// `GET /agents` — the global Story-agent roster the right panel renders.
import { describe, expect, it } from 'vitest';
import { buildStorylineRuntime } from './server';
import { Store } from '../store/store';

const ENV = {
    STORYLINE_PROVIDER_BASE_URL: 'http://127.0.0.1:1/v1',
    STORYLINE_PROVIDER_MODEL: 'scripted',
    STORYLINE_PROVIDER_API_KEY: ''
};

describe('GET /agents', () => {
    it('answers the four global agents even before any Story has dispatched work', async () => {
        const runtime = buildStorylineRuntime({
            store: Store.empty(),
            engineConfig: { autoSweep: false },
            noAssistantSeed: true,
            env: ENV
        });

        const response = await runtime.app.request('http://localhost/v1/storyline/agents');

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual([
            { kind: 'writer', title: 'Writer', status: 'idle', working: [] },
            { kind: 'editor', title: 'Editor', status: 'idle', working: [] },
            { kind: 'reader', title: 'Reader', status: 'idle', working: [] },
            { kind: 'checker', title: 'Checker', status: 'idle', working: [] }
        ]);
    });
});
