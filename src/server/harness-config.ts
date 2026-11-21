// THE STORYLINE-OWNED HARNESS BOOT CONFIGURATION (R5).
//
// WHAT THIS FILE OWNS: the exact catalogue this package ships to `@underload/harness/server`
// and the one place that default is resolved. The harness boot contract (R-boot) makes every
// omitted member EMPTY, so importing `presets` from the harness barrel would leave this app
// with an implicit, module-global catalogue that an embedder could not replace. Instead the
// cards below are declared here, by name and roster, and every deployment decision (plugins,
// toolbox, extra tools/sources, commands) is visible in one object:
//
//   * `undefined` configuration  -> `STORYLINE_HARNESS_CONFIGURATION`;
//   * an explicitly EMPTY object -> the harness zero floor (no cards, no plugins, core tools only).
//
// The listing route consumes the PRESETS from the resolved configuration; no HarnessRuntime is
// created just to answer `GET /harnesses`. `buildStorylineRuntime` resolves this module once and
// passes the resolved presets to the route table, so a caller-supplied configuration reaches the
// visible catalogue without a second route stack (see `api/server.ts` and `api/routes.ts`).
//
// BOUNDARY VERSUS THE STORY ENGINE: this is the harness package's session-agent catalogue, not
// Storyline's own loop vocabulary. `src/server/loop/templates.ts` (`BUILT_IN_TEMPLATES`), the
// §8.6 assistant seed (`api/server.ts:assistantTemplate`) and `src/server/tools/` are the Story
// engine's roles/tools and are NOT replaced, migrated or listed by this configuration. The
// dashboard's `GET /harnesses` read has always been the harness catalogue (`harnesses.ts`), and
// it stays that — only the source of record moves from the harness barrel to this file.
//
// DEFAULTS ARE AN EXPLICIT CHOICE:
//   - the eight cards below reproduce the harness package's shipped visible catalogue
//     (general, instruct, research/Explore, workspace/Analyst, reviewer, planner/Manager,
//     debugger, chat) and their exact rosters/ranks, so existing dashboard listings do not move;
//   - the shared toolbox stays ON for the seven working cards, and OFF for `chat`, matching the
//     cards' own posture; the deployment-level environment rows are OFF and each card states its
//     own rows through `environmentTools`, the authoritative per-card list (an explicit `[]`
//     CLEARS rows inherited from the deployment toolbox; omission would inherit them). So the
//     seven working cards list search/fetch and `chat` states `[]` — each row is declared once,
//     on the card, and the runtime follows that same list;
//   - NO executable plugins and NO extra tools/sources/commands ship here. Storyline has never
//     loaded a harness plugin, so the honest default is the empty list; an embedder that wants
//     the harness package's built-ins passes `plugins: [...BUILTIN_PLUGINS]` in its own config.
//
// Cross-references:
//   - ../../../../underload/harness/src/server/harnesses/boot.ts — the boot contract/resolver
//   - ./harnesses.ts — the dashboard listing projection over the resolved presets
//   - ../main.ts / ./api/server.ts — standalone/app construction (`harness` option)
//   - ./endpoint/storyline/service-route.ts — service construction (`variables.harness`)
import type { AgentRank } from '@underload/harness';
import {
    SHARED_TOOL_NAMES,
    resolveHarnessBootConfiguration
} from '@underload/harness/server';
import type {
    HarnessBootConfiguration,
    HarnessBootPresetConfiguration,
    ResolvedHarnessBootConfiguration
} from '@underload/harness/server';

// The rank letters the shipped cards use: the entry agent is the highest authority, its
// delegates sit one rank below. A single-rank card has no `delegate` row at all, which is why
// `general` and `chat` state one rank only.
const ENTRY_RANK: AgentRank = 'A';
const TEAM_RANK: AgentRank = 'B';

// Kept in every multi-member roster so `textSummarize`'s delegated path has its profile; the
// Manager (`planner`) is deliberately absent from every OTHER card because it refuses to run
// as a delegate.
const SUMMARIZER_AGENT_NAME = 'summarizer';

// The tool names the seven working cards advertise. `SHARED_TOOL_NAMES` is the harness
// package's own shared toolbox list, so this configuration cannot drift from the factory that
// would register it when an embedder boots a real session from this configuration.
const SHARED_CARD_TOOLS = SHARED_TOOL_NAMES;

// The environment rows the seven working cards declare. An explicit `environmentTools` list
// is authoritative for registration as well as for the card (harness boot resolver), so these
// cards register search/fetch even though the deployment floor states both OFF — no separate
// `websearch`/`webfetch` booleans are needed, and stating a contradicting one is an error.
const SHARED_CARD_ENVIRONMENT_TOOLS = ['search', 'fetch'] as const;

// ---------------------------------------------------------------------------
// The rosters and authority maps, stated once per card
// ---------------------------------------------------------------------------

const instructRoster = [
    'instruct',
    'general',
    'research',
    'workspace',
    'reviewer',
    'debugger',
    SUMMARIZER_AGENT_NAME
] as const;

const instructRanks: Readonly<Record<string, AgentRank>> = {
    instruct: ENTRY_RANK,
    general: TEAM_RANK,
    research: TEAM_RANK,
    workspace: TEAM_RANK,
    reviewer: TEAM_RANK,
    debugger: TEAM_RANK,
    summarizer: TEAM_RANK
};

const researchRoster = [
    'research',
    'general',
    'instruct',
    'workspace',
    'reviewer',
    'debugger',
    SUMMARIZER_AGENT_NAME
] as const;

const researchRanks: Readonly<Record<string, AgentRank>> = {
    research: ENTRY_RANK,
    general: TEAM_RANK,
    instruct: TEAM_RANK,
    workspace: TEAM_RANK,
    reviewer: TEAM_RANK,
    debugger: TEAM_RANK,
    summarizer: TEAM_RANK
};

const workspaceRoster = [
    'workspace',
    'general',
    'instruct',
    'research',
    'reviewer',
    'debugger',
    SUMMARIZER_AGENT_NAME
] as const;

const workspaceRanks: Readonly<Record<string, AgentRank>> = {
    workspace: ENTRY_RANK,
    general: TEAM_RANK,
    instruct: TEAM_RANK,
    research: TEAM_RANK,
    reviewer: TEAM_RANK,
    debugger: TEAM_RANK,
    summarizer: TEAM_RANK
};

const reviewerRoster = [
    'reviewer',
    'general',
    'instruct',
    'research',
    'workspace',
    'debugger',
    SUMMARIZER_AGENT_NAME
] as const;

const reviewerRanks: Readonly<Record<string, AgentRank>> = {
    reviewer: ENTRY_RANK,
    general: TEAM_RANK,
    instruct: TEAM_RANK,
    research: TEAM_RANK,
    workspace: TEAM_RANK,
    debugger: TEAM_RANK,
    summarizer: TEAM_RANK
};

const plannerRoster = [
    'planner',
    'general',
    'instruct',
    'research',
    'workspace',
    'reviewer',
    'debugger',
    SUMMARIZER_AGENT_NAME
] as const;

const plannerRanks: Readonly<Record<string, AgentRank>> = {
    planner: ENTRY_RANK,
    general: TEAM_RANK,
    instruct: TEAM_RANK,
    research: TEAM_RANK,
    workspace: TEAM_RANK,
    reviewer: TEAM_RANK,
    debugger: TEAM_RANK,
    summarizer: TEAM_RANK
};

const debuggerRoster = [
    'debugger',
    'general',
    'instruct',
    'research',
    'workspace',
    'reviewer',
    SUMMARIZER_AGENT_NAME
] as const;

const debuggerRanks: Readonly<Record<string, AgentRank>> = {
    debugger: ENTRY_RANK,
    general: TEAM_RANK,
    instruct: TEAM_RANK,
    research: TEAM_RANK,
    workspace: TEAM_RANK,
    reviewer: TEAM_RANK,
    summarizer: TEAM_RANK
};

// ---------------------------------------------------------------------------
// The shipped Storyline catalogue (R5, explicit)
// ---------------------------------------------------------------------------

/**
 * The visible harness catalogue this package ships, in dashboard order.
 *
 * The order is a contract: `GET /harnesses` returns it verbatim and the panel renders it.
 * Titles/descriptions/rosters mirror the harness package's shipped cards; when that package
 * changes its shipped catalogue, this list has to be edited deliberately rather than silently
 * following a barrel export.
 */
export const STORYLINE_HARNESS_PRESETS: readonly HarnessBootPresetConfiguration[] = [
    {
        name: 'general',
        title: 'General',
        description:
            'The default general-purpose agent, with the full shared toolbox and NO delegates: it does every step itself, so `delegate` is not registered and cannot be enabled. File read/write/edit/glob and a configured search are always available; call toolRequest for files, commands, diffs, syntax checks, time, text, or notes.',
        agents: ['general'],
        entry: 'general',
        ranks: { general: ENTRY_RANK },
        tools: SHARED_CARD_TOOLS,
        environmentTools: SHARED_CARD_ENVIRONMENT_TOOLS
    },
    {
        name: 'instruct',
        title: 'Instruct',
        description:
            'General worker with the full shared toolbox and the other roles as its Rank B delegates. It does its own building and editing, and delegates only the steps that would burn its context: research, exploration, a long read, a review. Unlike the Manager, it never hands out work it must still finish itself.',
        agents: instructRoster,
        entry: 'instruct',
        ranks: instructRanks,
        tools: SHARED_CARD_TOOLS,
        environmentTools: SHARED_CARD_ENVIRONMENT_TOOLS
    },
    {
        name: 'research',
        title: 'Explore',
        description:
            'Read-only investigator with the same full toolbox as every live harness and the other roles as its Rank B delegates. Maps files, symbols, configuration and the web, cross-checks what decides the answer, and cites file, line, tool, or URL. Changes nothing on disk unless the brief authorises a change.',
        agents: researchRoster,
        entry: 'research',
        ranks: researchRanks,
        tools: SHARED_CARD_TOOLS,
        environmentTools: SHARED_CARD_ENVIRONMENT_TOOLS
    },
    {
        name: 'workspace',
        title: 'Analyst',
        description:
            'The implementor, with the full shared toolbox and the other roles as its Rank B delegates: file read/write/edit/glob are always available, and files, syntax checks, diffs, and commands are discovered by tag. Writes the change in the existing style of the codebase, keeps it minimal and efficient, and verifies it with a real check.',
        agents: workspaceRoster,
        entry: 'workspace',
        ranks: workspaceRanks,
        tools: SHARED_CARD_TOOLS,
        environmentTools: SHARED_CARD_ENVIRONMENT_TOOLS
    },
    {
        name: 'reviewer',
        title: 'Reviewer',
        description:
            'Strict, independent reviewer with the full shared toolbox and the other roles as its Rank B delegates. Judges plans, code, documents, and claims against their own acceptance criteria, reports each finding with file/line or quote evidence plus the smallest fix, and says plainly when there is nothing to find. Reads and verifies by default; edits only when asked.',
        agents: reviewerRoster,
        entry: 'reviewer',
        ranks: reviewerRanks,
        tools: SHARED_CARD_TOOLS,
        environmentTools: SHARED_CARD_ENVIRONMENT_TOOLS
    },
    {
        name: 'planner',
        title: 'Manager',
        description:
            'Planning and orchestration lead with the full shared toolbox, Rank A itself and every other role as its Rank B delegates. Holds the whole goal, writes an explicit plan, delegates every step (research, workspace, reviewer, debugger, general, instruct), and accepts each result only after an independent review. It never executes a step itself, and refuses to run as a delegate.',
        agents: plannerRoster,
        entry: 'planner',
        ranks: plannerRanks,
        tools: SHARED_CARD_TOOLS,
        environmentTools: SHARED_CARD_ENVIRONMENT_TOOLS
    },
    {
        name: 'debugger',
        title: 'Debugger',
        description:
            'Stress-test harness with the full shared toolbox, Rank A itself and every other role as its Rank B delegates. Nothing is off-limits: it enables any searchable tool, runs any command, exercises each capability at its edges, reproduces what breaks, and reports the exact input and error.',
        agents: debuggerRoster,
        entry: 'debugger',
        ranks: debuggerRanks,
        tools: SHARED_CARD_TOOLS,
        environmentTools: SHARED_CARD_ENVIRONMENT_TOOLS
    },
    {
        // The tool-less card: a one-rank General roster and no advertised tools. `environmentTools:
        // []` is the AUTHORITATIVE empty row set — it clears the deployment floor's inherited
        // search/fetch for this card — and `sharedToolbox: false` drops the shared catalogue. No
        // separate websearch/webfetch booleans are stated: the list is the one source of truth,
        // and a contradicting boolean is now rejected rather than silently winning one way.
        name: 'chat',
        title: 'Chat',
        description:
            'A single answer with no toolbox: the General profile on an empty catalogue (no file, search, delegation, or record tool is registered), so it cannot read or write the server host — the only tools it can ever call are the harness-owned core rows. It carries no iteration budget, so it keeps going until the model answers.',
        agents: ['general'],
        entry: 'general',
        ranks: { general: ENTRY_RANK },
        tools: [],
        environmentTools: [],
        sharedToolbox: false
    }
];

/**
 * Storyline's complete default harness boot configuration.
 *
 * `toolbox.sharedToolbox` is explicitly ON (matching the seven working cards). The two
 * environment rows are explicitly OFF at the deployment floor — the posture a NEW card created
 * through the harness API inherits — and every shipped card states its own rows through the
 * authoritative per-card `environmentTools` list: the seven working cards list search/fetch,
 * `chat` states `[]`, which clears the inherited rows. Stating the rows once per card is what
 * keeps `chat` truly empty without a deployment-shaped workaround.
 *
 * `plugins`/`commands` are empty by choice: this package has no executable plugin or
 * slash-command story, and an embedder passes its own list rather than inheriting one.
 */
export const STORYLINE_HARNESS_CONFIGURATION: HarnessBootConfiguration = {
    presets: STORYLINE_HARNESS_PRESETS,
    plugins: [],
    toolbox: {
        sharedToolbox: true,
        websearch: false,
        webfetch: false
    },
    commands: []
};

/**
 * Resolve a Storyline harness configuration through the harness package's public resolver.
 *
 * The `undefined` branch is the package default; `{}` is deliberately NOT defaulted, because
 * "the host supplied an empty configuration" must mean an empty catalogue (R-boot), not "put
 * Storyline's cards back". The service cache compares `harnessBootSignature` of the same raw
 * configuration, so it goes through this same door for construction and only uses the raw value
 * for identity (functions cannot survive a resolved re-comparison).
 */
export const resolveStorylineHarnessBoot = (
    configuration?: HarnessBootConfiguration
): ResolvedHarnessBootConfiguration => resolveHarnessBootConfiguration(configuration ?? STORYLINE_HARNESS_CONFIGURATION);
