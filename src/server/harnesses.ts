// The harness listing: the agents a session can run, with their authority rank.
//
// WHY IT READS THE STORYLINE BOOT CONFIGURATION INSTEAD OF THE BOOK'S TEMPLATES: the Author
// asked for "the list of agents available for that session", in the harness's own vocabulary.
// The §4.12 templates are the loop's crews (Writer/Editor/Reader/Checker); the harness presets
// are the actual agent teams each session runs. The two are different layers, and this listing
// is deliberately the second one — the runtime agents, each with the A–Z rank that decides who
// may delegate to whom.
//
// THE SOURCE OF RECORD IS `./harness-config.ts` (R5), NOT THE HARNESS BARREL'S `presets`: the
// route table passes the presets resolved from the runtime's `harness` option, so an embedder
// that supplies an empty or custom configuration sees exactly that catalogue here. The no-arg
// default exists for direct callers/tests and resolves Storyline's own shipped configuration.
//
// `Rank A` is called out explicitly because the rank model treats it as the highest authority
// and a session may hold any number of Rank A members. The panel groups them apart from the
// delegates, so "these are Rank A" is a fact the Author can see without decoding letters.
import type { AgentRank } from '@underload/harness';
import { agentProfile, describeHarness } from '@underload/harness/server';
import type { HarnessPreset } from '@underload/harness/server';
import { resolveStorylineHarnessBoot } from './harness-config';

/** One agent available inside a harness session. */
export interface HarnessAgentListing {
    name: string;
    title: string;
    description: string;
    /** The harness's A–Z authority letter; `A` is highest. */
    rank: AgentRank;
    /** True for the routing member an unfocused submit opens a conversation for. */
    entry: boolean;
}

/** One harness session template, with its roster in declaration order. */
export interface HarnessListing {
    name: string;
    title: string;
    description: string;
    entry: string;
    builtin: boolean;
    agents: HarnessAgentListing[];
    /** The names a client can render under a "Rank A" heading without re-sorting. */
    rank_a: string[];
    tool_count: number;
}

/**
 * Project a RESOLVED preset catalogue for the dashboard.
 *
 * The route passes the catalogue resolved from the runtime's `harness` option; omitting it
 * projects Storyline's own shipped configuration. `describeHarness` is the harness package's
 * descriptor rule, so a boot-declared card and a registry-created card cannot disagree about
 * its title, entry, ranks or tool count.
 */
export function harnessListings(
    catalogue: readonly HarnessPreset[] = resolveStorylineHarnessBoot().presets
): HarnessListing[] {
    return catalogue.map((preset) => {
        const descriptor = describeHarness(preset);
        const agents: HarnessAgentListing[] = descriptor.agents.map((name) => {
            const profile = agentProfile(name);

            return {
                name,
                title: profile?.title ?? name,
                description: profile?.description ?? '',
                rank: descriptor.ranks[name] ?? 'A',
                entry: descriptor.entry === name
            };
        });

        return {
            name: descriptor.name,
            title: descriptor.title,
            description: descriptor.description,
            entry: descriptor.entry,
            builtin: descriptor.builtin,
            agents,
            rank_a: agents.filter((agent) => agent.rank === 'A').map((agent) => agent.name),
            tool_count: descriptor.tools.length
        };
    });
}
