// The harness listing: the Storyline-owned boot catalogue projected for the dashboard.
//
// The projection is deliberately read from `./harness-config.ts` (R5), not the harness
// package's module-global `presets`. These assertions pin the visible contract the panel and the
// route share: order, rank-A grouping, entry flags and tool counts.
import { describe, expect, it } from 'vitest';
import { SHARED_TOOL_NAMES } from '@underload/harness/server';
import { harnessListings } from './harnesses';
import { STORYLINE_HARNESS_PRESETS } from './harness-config';

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

describe('harnessListings', () => {
    it('lists the eight Storyline cards in declaration order with Rank A called out', () => {
        const listings = harnessListings();

        expect(listings.map((listing) => listing.name)).toEqual(EXPECTED_NAMES);

        // Every shipped card has exactly one Rank A member — its entry agent — and the
        // `rank_a` array is in roster order without re-sorting.
        expect(
            listings.map((listing) => ({ entry: listing.entry, rank_a: listing.rank_a }))
        ).toEqual([
            { entry: 'general', rank_a: ['general'] },
            { entry: 'instruct', rank_a: ['instruct'] },
            { entry: 'research', rank_a: ['research'] },
            { entry: 'workspace', rank_a: ['workspace'] },
            { entry: 'reviewer', rank_a: ['reviewer'] },
            { entry: 'planner', rank_a: ['planner'] },
            { entry: 'debugger', rank_a: ['debugger'] },
            { entry: 'general', rank_a: ['general'] }
        ]);

        expect(
            listings.map((listing) => listing.agents.map((agent) => [agent.name, agent.rank, agent.entry]))
        ).toEqual([
            [['general', 'A', true]],
            [
                ['instruct', 'A', true],
                ['general', 'B', false],
                ['research', 'B', false],
                ['workspace', 'B', false],
                ['reviewer', 'B', false],
                ['debugger', 'B', false],
                ['summarizer', 'B', false]
            ],
            [
                ['research', 'A', true],
                ['general', 'B', false],
                ['instruct', 'B', false],
                ['workspace', 'B', false],
                ['reviewer', 'B', false],
                ['debugger', 'B', false],
                ['summarizer', 'B', false]
            ],
            [
                ['workspace', 'A', true],
                ['general', 'B', false],
                ['instruct', 'B', false],
                ['research', 'B', false],
                ['reviewer', 'B', false],
                ['debugger', 'B', false],
                ['summarizer', 'B', false]
            ],
            [
                ['reviewer', 'A', true],
                ['general', 'B', false],
                ['instruct', 'B', false],
                ['research', 'B', false],
                ['workspace', 'B', false],
                ['debugger', 'B', false],
                ['summarizer', 'B', false]
            ],
            [
                ['planner', 'A', true],
                ['general', 'B', false],
                ['instruct', 'B', false],
                ['research', 'B', false],
                ['workspace', 'B', false],
                ['reviewer', 'B', false],
                ['debugger', 'B', false],
                ['summarizer', 'B', false]
            ],
            [
                ['debugger', 'A', true],
                ['general', 'B', false],
                ['instruct', 'B', false],
                ['research', 'B', false],
                ['workspace', 'B', false],
                ['reviewer', 'B', false],
                ['summarizer', 'B', false]
            ],
            [['general', 'A', true]]
        ]);
    });

    it('projects the general card exactly, including its trusted profile text and tool count', () => {
        const general = harnessListings().find((listing) => listing.name === 'general');

        expect(general).toEqual({
            name: 'general',
            title: 'General',
            description:
                'The default general-purpose agent, with the full shared toolbox and NO delegates: it does every step itself, so `delegate` is not registered and cannot be enabled. File read/write/edit/glob and a configured search are always available; call toolRequest for files, commands, diffs, syntax checks, time, text, or notes.',
            entry: 'general',
            builtin: true,
            agents: [
                {
                    name: 'general',
                    title: 'General',
                    description:
                        'The default general-purpose agent. It does the whole task itself, start to finish: this harness configures no agent ranked below it, so delegate is not even registered and it never splits work out.',
                    rank: 'A',
                    entry: true
                }
            ],
            rank_a: ['general'],
            tool_count: SHARED_TOOL_NAMES.length
        });
    });

    it('keeps the chat card tool-less and entry-bearing on the general profile', () => {
        const chat = harnessListings().find((listing) => listing.name === 'chat');

        expect(chat).toEqual({
            name: 'chat',
            title: 'Chat',
            description:
                'A single answer with no toolbox: the General profile on an empty catalogue (no file, search, delegation, or record tool is registered), so it cannot read or write the server host — the only tools it can ever call are the harness-owned core rows. It carries no iteration budget, so it keeps going until the model answers.',
            entry: 'general',
            builtin: true,
            agents: [
                {
                    name: 'general',
                    title: 'General',
                    description:
                        'The default general-purpose agent. It does the whole task itself, start to finish: this harness configures no agent ranked below it, so delegate is not even registered and it never splits work out.',
                    rank: 'A',
                    entry: true
                }
            ],
            rank_a: ['general'],
            tool_count: 0
        });
    });

    it('returns an empty listing for an explicitly empty catalogue', () => {
        expect(harnessListings([])).toEqual([]);
    });

    it('projects a host-supplied catalogue rather than merging the Storyline default back in', () => {
        const resolved = harnessListings([
            {
                name: 'host-card',
                title: 'Host card',
                description: 'One host-declared card.',
                requiresEndpoint: true,
                entry: 'reviewer',
                ranks: { reviewer: 'A', general: 'B' },
                agents: ['reviewer', 'general'],
                tools: ['probeTool'],
                environmentTools: [],
                builtin: true,
                editable: true,
                template: 'live',
                create: () => {
                    throw new Error('the listing must never build a harness');
                }
            }
        ]);

        expect(resolved).toHaveLength(1);
        expect(resolved[0]).toMatchObject({
            name: 'host-card',
            title: 'Host card',
            entry: 'reviewer',
            builtin: true,
            rank_a: ['reviewer'],
            tool_count: 1
        });
        expect(resolved[0]?.agents.map((agent) => [agent.name, agent.rank, agent.entry])).toEqual([
            ['reviewer', 'A', true],
            ['general', 'B', false]
        ]);
    });

    it('declares every listing name in the configuration module exactly once', () => {
        expect(harnessListings().map((listing) => listing.name)).toEqual(
            STORYLINE_HARNESS_PRESETS.map((preset) => preset.name)
        );
    });
});
