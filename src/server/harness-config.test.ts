// R5 — the Storyline-owned harness boot configuration.
//
// These tests pin the DECLARATION, not the harness library's internal catalogue: exact preset
// names/order, exact rosters/ranks, exact tool posture and the zero-floor behaviour of an
// explicitly empty configuration. If the harness package's shipped catalogue changes, this file
// must be edited on purpose — that is the boundary the configuration module exists to draw.
import { describe, expect, it } from 'vitest';
import type { HarnessProgress, RunnerSettings } from '@underload/harness';
import { SHARED_TOOL_NAMES } from '@underload/harness/server';
import {
    STORYLINE_HARNESS_CONFIGURATION,
    STORYLINE_HARNESS_PRESETS,
    resolveStorylineHarnessBoot
} from './harness-config';

const EXPECTED_NAMES = [
    'general',
    'instruct',
    'research',
    'workspace',
    'reviewer',
    'planner',
    'debugger',
    'chat'
];

const EXPECTED_ROSTERS = [
    ['general'],
    ['instruct', 'general', 'research', 'workspace', 'reviewer', 'debugger', 'summarizer'],
    ['research', 'general', 'instruct', 'workspace', 'reviewer', 'debugger', 'summarizer'],
    ['workspace', 'general', 'instruct', 'research', 'reviewer', 'debugger', 'summarizer'],
    ['reviewer', 'general', 'instruct', 'research', 'workspace', 'debugger', 'summarizer'],
    ['planner', 'general', 'instruct', 'research', 'workspace', 'reviewer', 'debugger', 'summarizer'],
    ['debugger', 'general', 'instruct', 'research', 'workspace', 'reviewer', 'summarizer'],
    ['general']
];

describe('STORYLINE_HARNESS_CONFIGURATION', () => {
    it('declares the eight shipped cards in dashboard order, with no plugins or commands', () => {
        expect(STORYLINE_HARNESS_PRESETS.map((preset) => preset.name)).toEqual(EXPECTED_NAMES);
        expect(STORYLINE_HARNESS_CONFIGURATION.plugins).toEqual([]);
        expect(STORYLINE_HARNESS_CONFIGURATION.commands).toEqual([]);
        expect(STORYLINE_HARNESS_CONFIGURATION.toolbox).toEqual({
            sharedToolbox: true,
            websearch: false,
            webfetch: false
        });
    });

    it('resolves the exact rosters, ranks and tool posture the listing projects', () => {
        const resolved = resolveStorylineHarnessBoot();

        expect(resolved.presets.map((preset) => preset.name)).toEqual(EXPECTED_NAMES);
        expect(resolved.presets.map((preset) => [...preset.agents])).toEqual(EXPECTED_ROSTERS);

        expect(resolved.presets.map((preset) => ({ ...preset.ranks }))).toEqual([
            { general: 'A' },
            {
                instruct: 'A',
                general: 'B',
                research: 'B',
                workspace: 'B',
                reviewer: 'B',
                debugger: 'B',
                summarizer: 'B'
            },
            {
                research: 'A',
                general: 'B',
                instruct: 'B',
                workspace: 'B',
                reviewer: 'B',
                debugger: 'B',
                summarizer: 'B'
            },
            {
                workspace: 'A',
                general: 'B',
                instruct: 'B',
                research: 'B',
                reviewer: 'B',
                debugger: 'B',
                summarizer: 'B'
            },
            {
                reviewer: 'A',
                general: 'B',
                instruct: 'B',
                research: 'B',
                workspace: 'B',
                debugger: 'B',
                summarizer: 'B'
            },
            {
                planner: 'A',
                general: 'B',
                instruct: 'B',
                research: 'B',
                workspace: 'B',
                reviewer: 'B',
                debugger: 'B',
                summarizer: 'B'
            },
            {
                debugger: 'A',
                general: 'B',
                instruct: 'B',
                research: 'B',
                workspace: 'B',
                reviewer: 'B',
                summarizer: 'B'
            },
            { general: 'A' }
        ]);

        expect(resolved.presets.map((preset) => [...preset.tools])).toEqual([
            [...SHARED_TOOL_NAMES],
            [...SHARED_TOOL_NAMES],
            [...SHARED_TOOL_NAMES],
            [...SHARED_TOOL_NAMES],
            [...SHARED_TOOL_NAMES],
            [...SHARED_TOOL_NAMES],
            [...SHARED_TOOL_NAMES],
            []
        ]);

        // The chat card is the one explicit toolbox exception: its stated `[]` must survive the
        // resolver — empty is a real override, not an omission that lets the deployment rows in.
        expect(resolved.presets[7]?.environmentTools).toEqual([]);
        expect(resolved.presets.slice(0, 7).map((preset) => [...(preset.environmentTools ?? [])])).toEqual(
            Array.from({ length: 7 }, () => ['search', 'fetch'])
        );

        expect(resolved.plugins).toEqual([]);
        expect(resolved.pluginDescriptors).toEqual([]);
        expect(resolved.commands).toEqual([]);
        expect(resolved.toolbox).toEqual({ sharedToolbox: true, websearch: false, webfetch: false });
    });

    it('makes the cards’ environment rows real in the FACTORY, not only on the card', () => {
        // R5 integration guard: `chat`'s stated `[]` must clear the deployment floor's
        // environment rows in the runtime, and a working card's stated list must register its
        // rows. `fetch` is keyless, so both halves are deterministic without a provider.
        const settings: RunnerSettings = {
            baseURL: 'http://provider.test/v1',
            apiKey: 'storyline-key',
            model: 'storyline-model'
        };
        const progress: HarnessProgress = async () => undefined;
        const presets = resolveStorylineHarnessBoot().presets;

        const chatTools = Object.keys(presets[7]!.create(settings, progress).tools);
        expect(chatTools).not.toContain('fetch');
        expect(chatTools).not.toContain('search');
        expect(chatTools).toContain('toolRequest');

        const generalTools = Object.keys(presets[0]!.create(settings, progress).tools);
        expect(generalTools).toContain('fetch');
    });

    it('keeps an explicitly empty configuration at the harness zero floor', () => {
        // `{}` must NOT be defaulted back to Storyline's catalogue: omission vs an explicit
        // empty object is the whole R-boot contract this package consumes.
        expect(resolveStorylineHarnessBoot({})).toEqual({
            presets: [],
            plugins: [],
            pluginDescriptors: [],
            toolbox: { sharedToolbox: false },
            commands: []
        });
    });
});
