// R5 — the harness boot configuration reaches the dashboard listing through BOTH Storyline
// construction paths (the synchronous runtime builder and the async app/service entry), and an
// explicitly empty configuration stays empty.
import { describe, expect, it } from 'vitest';
import { tool } from '@underload/harness';
import type { HarnessPlugin } from '@underload/harness';
import type { HarnessBootConfiguration } from '@underload/harness/server';
import { buildStorylineRuntime, startStorylineServer } from './server';
import { createStorylineApp } from '../main';
import { Store } from '../store/store';

// The probe tool is a constructed definition, the shape `toolbox.extraTools` accepts; it also
// proves the tool map survives construction (the listing advertises it by name).
const probeTool = tool<Record<string, never>, { story: true }>({
    description: 'Storyline boot probe.',
    tags: ['boot', 'probe'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: () => ({ story: true })
});

// One host plugin, deliberately NOT one of the harness package's built-ins: the resolved
// configuration must carry exactly this entry and its descriptor.
const probePlugin: HarnessPlugin = {
    name: 'storyline-probe',
    metadata: { name: 'storyline-probe', title: 'Storyline probe', builtin: false, settings: [] },
    setup: () => undefined
};

const customHarness = (): HarnessBootConfiguration => ({
    presets: [
        {
            name: 'story-team',
            title: 'Story team',
            description: 'A host-declared Storyline team.',
            agents: ['reviewer', 'general'],
            entry: 'reviewer',
            ranks: { reviewer: 'A', general: 'B' },
            tools: ['probeTool'],
            environmentTools: []
        }
    ],
    plugins: [probePlugin],
    toolbox: {
        sharedToolbox: false,
        extraTools: { probeTool }
    }
});

const expectedListing = {
    name: 'story-team',
    title: 'Story team',
    description: 'A host-declared Storyline team.',
    entry: 'reviewer',
    builtin: true,
    agents: [
        {
            name: 'reviewer',
            title: 'Reviewer',
            description:
                'Strict, independent reviewer of anything: plans, code, documents, claims. Every finding carries file, line, or quote evidence and the smallest fix; nothing is invented to fill the report and nothing is waved through. Read-only unless the brief asks for a fix.',
            rank: 'A',
            entry: true
        },
        {
            name: 'general',
            title: 'General',
            description:
                'The default general-purpose agent. It does the whole task itself, start to finish: this harness configures no agent ranked below it, so delegate is not even registered and it never splits work out.',
            rank: 'B',
            entry: false
        }
    ],
    rank_a: ['reviewer'],
    tool_count: 1
};

describe('harness boot configuration on the runtime builder', () => {
    it('projects a host-supplied preset while keeping the plugin/toolbox config inspectable', async () => {
        const runtime = buildStorylineRuntime({
            store: Store.empty(),
            harness: customHarness(),
            engineConfig: { autoSweep: false },
            env: {}
        });

        const response = await runtime.app.request('http://localhost/v1/storyline/harnesses');

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual([expectedListing]);

        expect(runtime.harnessConfiguration.presets.map((preset) => preset.name)).toEqual(['story-team']);
        expect(runtime.harnessConfiguration.plugins.map((plugin) => plugin.name)).toEqual([
            'storyline-probe'
        ]);
        expect(runtime.harnessConfiguration.pluginDescriptors).toEqual([
            { name: 'storyline-probe', title: 'Storyline probe', builtin: false, settings: [] }
        ]);
        expect(Object.keys(runtime.harnessConfiguration.toolbox.extraTools ?? {})).toEqual(['probeTool']);
        expect(runtime.harnessConfiguration.toolbox.sharedToolbox).toBe(false);
    });

    it('keeps an explicit empty configuration empty', async () => {
        const runtime = buildStorylineRuntime({
            store: Store.empty(),
            harness: {},
            engineConfig: { autoSweep: false },
            env: {}
        });

        const response = await runtime.app.request('http://localhost/v1/storyline/harnesses');

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual([]);
        expect(runtime.harnessConfiguration).toEqual({
            presets: [],
            plugins: [],
            pluginDescriptors: [],
            toolbox: { sharedToolbox: false },
            commands: []
        });
    });

    it('uses the Storyline-owned default when the option is omitted', async () => {
        const runtime = buildStorylineRuntime({
            store: Store.empty(),
            engineConfig: { autoSweep: false },
            env: {}
        });

        const response = await runtime.app.request('http://localhost/v1/storyline/harnesses');

        expect(response.status).toBe(200);
        expect(((await response.json()) as Array<{ name: string }>).map((listing) => listing.name)).toEqual([
            'general',
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner',
            'debugger',
            'chat'
        ]);
        expect(runtime.harnessConfiguration.plugins).toEqual([]);
    });
});

describe('harness boot configuration on the app/service entry', () => {
    it('carries the same host configuration through the standalone listener', async () => {
        const handle = await startStorylineServer({
            port: 0,
            host: '127.0.0.1',
            store: Store.empty(),
            harness: customHarness(),
            engineConfig: { autoSweep: false },
            env: {}
        });

        try {
            const response = await fetch(`http://127.0.0.1:${handle.port}/v1/storyline/harnesses`);

            expect(response.status).toBe(200);
            expect(await response.json()).toEqual([expectedListing]);
            expect(handle.harnessConfiguration.plugins.map((plugin) => plugin.name)).toEqual([
                'storyline-probe'
            ]);
        } finally {
            await handle.close();
        }
    });

    it('carries the same host configuration through createStorylineApp', async () => {
        const runtime = await createStorylineApp({
            storeRoot: null,
            harness: customHarness(),
            engineConfig: { autoSweep: false },
            env: {}
        });

        try {
            const response = await runtime.app.request('http://localhost/v1/storyline/harnesses');

            expect(response.status).toBe(200);
            expect(await response.json()).toEqual([expectedListing]);
            expect(runtime.harnessConfiguration.plugins.map((plugin) => plugin.name)).toEqual([
                'storyline-probe'
            ]);
            expect(Object.keys(runtime.harnessConfiguration.toolbox.extraTools ?? {})).toEqual(['probeTool']);
        } finally {
            runtime.engine.stop();
            await runtime.store.close();
            await runtime.knowledge.close();
        }
    });
});
