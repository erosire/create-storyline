// U-8 / T-6b — the global roster's model choices: precedence, clearing, and durability across a
// restart (the store's snapshot is the one durable file the server already owns).
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    AGENT_MODELS_SETTING,
    agentModelChoices,
    agentModelFor,
    isAgentKind,
    runModelFor,
    setAgentModel,
    templateRoleModels
} from './agent-models';
import { Store } from '../store';

/** A scratch directory under the repo's `Temp/`, never the OS temp (see AGENTS.md). */
async function scratch(): Promise<string> {
    const root = path.resolve(process.cwd(), 'Temp');

    await mkdir(root, { recursive: true });

    return mkdtemp(path.join(root, 'create-storyline-agent-models-'));
}

describe('agent models — the global roster (U-8, T-6b)', () => {
    it('defaults every kind to the process model until the Author chooses otherwise', () => {
        const store = Store.empty();

        expect(agentModelFor(store, 'gpt-5', 'writer')).toEqual({ model: 'gpt-5', source: 'default' });

        setAgentModel(store, 'writer', 'deepseek-r1');

        expect(agentModelFor(store, 'gpt-5', 'writer')).toEqual({ model: 'deepseek-r1', source: 'agent' });
        expect(agentModelFor(store, 'gpt-5', 'editor')).toEqual({ model: 'gpt-5', source: 'default' });
    });

    it('gives an explicit roster choice precedence over a template role, and the role precedence once cleared', () => {
        const store = Store.empty();

        expect(runModelFor(store, 'gpt-5', 'writer', 'role-model')).toBe('role-model');

        setAgentModel(store, 'writer', 'agent-model');

        expect(runModelFor(store, 'gpt-5', 'writer', 'role-model')).toBe('agent-model');
        expect(runModelFor(store, 'gpt-5', 'writer')).toBe('agent-model');

        setAgentModel(store, 'writer', null);

        expect(runModelFor(store, 'gpt-5', 'writer', 'role-model')).toBe('role-model');
        expect(runModelFor(store, 'gpt-5', 'writer')).toBe('gpt-5');
    });

    it('clears one choice with null and ignores malformed settings instead of failing every run', () => {
        const store = Store.empty();

        setAgentModel(store, 'reader', 'reader-model');
        setAgentModel(store, 'checker', 'checker-model');
        setAgentModel(store, 'reader', null);

        expect(agentModelChoices(store)).toEqual({ checker: 'checker-model' });

        store.setSetting(AGENT_MODELS_SETTING, { writer: '   ', editor: 42, reader: 'reader-model' });

        expect(agentModelChoices(store)).toEqual({ reader: 'reader-model' });
    });

    it('knows the four kinds and refuses a fifth at the boundary', () => {
        expect(['writer', 'editor', 'reader', 'checker'].every(isAgentKind)).toBe(true);
        expect(isAgentKind('explorer')).toBe(false);
        expect(isAgentKind('')).toBe(false);
    });

    it('survives a restart, and a cleared choice comes back as the process default', async () => {
        const dir = await scratch();

        try {
            const store = await Store.load(dir);

            setAgentModel(store, 'writer', 'deepseek-r1');
            await store.close();

            const reloaded = await Store.load(dir);

            expect(agentModelFor(reloaded, 'gpt-5', 'writer')).toEqual({
                model: 'deepseek-r1',
                source: 'agent'
            });

            setAgentModel(reloaded, 'writer', null);
            await reloaded.close();

            const cleared = await Store.load(dir);

            expect(agentModelFor(cleared, 'gpt-5', 'writer')).toEqual({ model: 'gpt-5', source: 'default' });
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
