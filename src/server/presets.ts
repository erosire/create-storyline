// The `storyline` harness preset (R2) and the registry that carries it.
//
// WHY A PRESET AND NOT A HAND-BUILT HARNESS: a harness session is created FROM a
// preset name (`POST /v1/storyline/sessions {harness: 'storyline'}`), and a
// session that is saved and restarted is REBUILT from its frozen preset record by
// the registry (`createProfiledHarness`, the same factory every shipped preset
// uses). Declaring the team the way the shipped presets do — a live template plus
// the `customAgents` map — is therefore what makes a storyline conversation
// survive a restart byte-identically instead of only on the first request.
//
// WHY `customAgents` AND NOT `agentFromProfile`: `@underload/harness` ships eight
// TRUSTED profiles (general, instruct, research, workspace, reviewer, planner,
// debugger, summarizer) and none of them is a novelist. A preset member whose name
// is NOT a profile is a session-defined agent, and `agentsFromProfiles` builds it
// from the stored base instruction (`agentConfigurationForCustom`, no catalogue
// lookup, no guideline composition). `writer` / `reader` / `editor` are exactly
// that: this package owns their prompts, the harness owns their transport.
//
// WHY `createProfiledHarness` AND NOT a bare `harness({...})`: the product rule in
// `packages/underload/harness/src/server/harnesses/toolbox.ts` is that a harness
// choice changes the AGENTS and never the TOOLBOX. Using the shared factory keeps
// that promise for free — `presets: false`, `maxIterations: PRESET_MAX_ITERATIONS`
// (1000), the shared tool source map, and the environment-backed search/fetch
// opt-in — and, decisively, it makes a freshly created storyline harness and a
// restored one the same object graph.
//
// WHY `chapters`, `profiles` AND `records` ARE TOUCHED AT ALL (R3/R4/R-D): all three
// are HARNESS-OWNED record tools that every harness already registers (verified: a
// harness built with `presets: false` registers toolRegistry, toolRequest, toolList,
// toolManage, toolCreate, records, tasks, profiles, chapters, locations, agentManage,
// agentResult, delegate, threadFork, toolCancel). None is `visibility: 'core'`, so all
// three are REGISTERED but not DECLARED: the model cannot call a searchable tool until
// progressive discovery has enabled it (src/harness.ts "Tool visibility").
// `harness.runtime.requestTools` is the public host-side door into that same enabled
// set (HarnessToolRuntime, src/types/index.ts:958), so `create()` enables them by name
// and the first model turn of a storyline session already sees them. `records` is in
// that set because the two collections a Title owns (`outlines`, `storyline`,
// ./collections.ts) are ordinary record collections — an agent reaches them through
// `records` with a `collection`, and without the tool declared it could read them from
// the UI but never write a section.
//
// WHY THE PROGRESS CLOSURE IS WRAPPED (R-C): the preset is the only place that gets a
// per-session progress closure, and the closure is the only surface that sees EVERY run
// of that session. `create()` therefore installs the review-chain observer
// (./orchestrator.ts) in front of it — the server, not the browser, decides that an
// editor's change is handed to the writer.
import { SHARED_TOOL_NAMES, createHarnessRegistry, createProfiledHarness, presets } from '@underload/harness/server';
import type { HarnessPreset, HarnessRegistry, HarnessRegistrySnapshot, RunnerSettings } from '@underload/harness/server';
// `Harness` is the LIBRARY type (src/harness.ts via the package root); the server
// barrel does not re-export it, so the value import and the type import use
// different entries on purpose.
import type { Harness, HarnessEvent, HarnessProgress } from '@underload/harness';
import { resolveChainRules, type StorylineChainRules } from './config';
import { createStorylineOrchestrator, type StorylineOrchestratorOptions } from './orchestrator';

// The preset factory's third argument — the server's host-hook bundle (`stateChange`,
// `interaction`, `diagnostic`, defined as `HarnessPresetReport` in
// packages/underload/harness/src/server/harnesses/types.ts:33). DERIVED from the `create`
// signature rather than imported: `HarnessPresetReport` itself is not a named export of
// `@underload/harness/server` (the barrel's list at src/server/harnesses/index.ts:111
// exports `HarnessPreset` and `RunnerSettings` from that file and stops there), and this
// package must not reach into another package's internals to name a type the public
// signature already carries. `Parameters<...>[2]` is exactly the argument the store passes.
export type StorylinePresetReport = NonNullable<Parameters<HarnessPreset['create']>[2]>;

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** The preset name every storyline session is created from (the UI's `harness` field). */
export const STORYLINE_PRESET_NAME = 'storyline';

/** The diagnostic owner every chain report is filed under (the session journal). */
export const STORYLINE_DIAGNOSTIC_OWNER = 'storyline';

/** The primary agent: the only member that writes prose. */
export const WRITER_AGENT_NAME = 'writer';

/** The critique agent, delegated to by the writer. */
export const READER_AGENT_NAME = 'reader';

/** The storyboard agent, delegated to by the writer. */
export const EDITOR_AGENT_NAME = 'editor';

/**
 * The roster in harness order (primary first, then the delegation allowlist). This
 * is the order `agentsFromProfiles` and the preset's `agents` field both expect,
 * and it is what the tests pin — a reordering here is a reordering of the roster
 * every session gets.
 */
export const STORYLINE_AGENT_NAMES = [WRITER_AGENT_NAME, READER_AGENT_NAME, EDITOR_AGENT_NAME] as const;

/**
 * The record tools this package guarantees to its agents (R3/R4/R-D). They are the four
 * collections a Title is built from:
 *
 *   `chapters`  — the prose layout (title, summary, content, status, order)
 *   `profiles`  — the cast (name, description, traits, notes)
 *   `records`   — the GENERIC engine entry, which is how the two collections this package
 *                 owns are reached: `outlines` and `storyline` are ordinary record
 *                 collections (./collections.ts), and without `records` declared an agent
 *                 could read them through the UI but could not write a section.
 *
 * All three ship `visibility: 'searchable'`, which is why `enableStorylineRecordTools`
 * exists at all; `tasks`, `locations` and the rest stay behind `toolRequest` on purpose,
 * because the brief's tool surface for this package is exactly these.
 */
export const STORYLINE_RECORD_TOOL_NAMES = ['chapters', 'profiles', 'records'] as const;

// ---------------------------------------------------------------------------
// The prompts (R2, rewritten for the Title model — R-D)
// ---------------------------------------------------------------------------

// Three rules repeat across the three prompts, and every repeat is deliberate: an agent
// only follows a rule it is told in its OWN instructions. They are (1) the four
// collections are the Title and nothing else is, (2) read before writing and carry
// `expects: [{ id, rev }]` so a concurrent edit is never overwritten, and (3) every
// profile carries a gender trait, because the folder list shows `(F)`/`(M)` and a
// character without one reads as unfinished. The 4000-character bound is the
// collection's own (`CHAPTER_MAX_TEXT`,
// packages/underload/harness/src/core/chapter.ts:27) — an agent that does not know it
// silently truncates a scene instead of splitting it. No UI or server vocabulary appears
// in any prompt: an agent is told about records and prose, never about panels.
export const WRITER_INSTRUCTION = [
    'You are the writer, the primary agent of a story team, and the only member who writes prose.',
    'The Title is its records: `chapters` holds the prose, `profiles` holds the cast, `outlines` holds the plan, and `storyline` holds the running line. Nothing that is not written down in one of them is part of the story.',
    'A chapter body goes in `chapters.content`, which holds 4000 characters: split a scene that runs longer into chapters instead of cutting it short, and let `order` say where each chapter belongs.',
    'Read and write `outlines` and `storyline` through the `records` tool with `collection: "outlines"` or `collection: "storyline"`. Each record is one section with an `order`, an optional `heading`, and up to 4000 characters of `content`; the whole document is those sections in order. Add a section by sending an entry with no id, change one by sending its id with only the fields you mean to change, and read the neighbours before writing between them.',
    'Keep the cast in `profiles`, and give every character a gender trait — `female` or `male` — the moment the character is created. Never leave one without it.',
    'Read a record before you change it, and send the `rev` you read back as `expects: [{ id, rev }]`; a rejected write means somebody else moved first, so re-read and re-apply instead of forcing.',
    'Draft and continue in the established voice and point of view, and finish a turn with actual prose or an actual layout, never with a plan to write one.',
    'When the plan is revised, your job is the prose that depends on it: read what changed, rewrite the chapters that no longer match, and say in one line what you left behind.',
    'Delegate to `reader` for critique of a finished draft and to `editor` for a revised layout or a structural repair, and act on what they report instead of arguing with it.',
    'Never contradict a stored chapter or profile by accident — change it deliberately, or state that the story has moved past it. Where the team disagrees, the records are the record: reconcile them, then write.'
].join('\n');

// The reader is read-only by policy, not by tooling — the shared toolbox still hands it
// `write`/`edit`, so the instruction is what keeps critique from becoming a silent
// rewrite (the product rule in toolbox.ts is that only the agents differ).
export const READER_INSTRUCTION = [
    'You are the reader: you read the Title and critique it. You never rewrite it and you change no record.',
    'Read the whole of it: the layout and bodies in `chapters`, the cast in `profiles`, the plan in `outlines` and the running line in `storyline` — the last two through the `records` tool with `collection: "outlines"` or `collection: "storyline"`, read in `order`.',
    'Judge four things and say which one you are talking about: pacing, continuity, character consistency, and prose quality.',
    'Cite the chapter or profile each point is about, by id and title, and quote at most a sentence as evidence.',
    'Separate a defect from a matter of taste, rank the findings by what they cost the story, and name for each the smallest change that would fix it.',
    'Flag a character whose profile carries no gender trait, a section whose `order` puts it out of sequence, and a chapter that reads as though a revision passed it by.',
    'End with the one thing to do next.'
].join('\n');

// The editor owns mutations of the structure and the cast, so it is the member that is
// told the compare-and-swap rule twice: once for the built-in collections, once for the
// two the Title owns.
export const EDITOR_INSTRUCTION = [
    'You are the editor: you own the shape of the Title — the plan, the sequence of chapters, and the coherence of the cast — and you revise them in place.',
    'Revise the layout through `chapters`: retitle, re-summarise, re-order with `order`, merge or split chapters, and correct `status`. Reordering IS an `update` of `order`; there is no move action.',
    'Keep `outlines` and `storyline` current through the `records` tool with `collection: "outlines"` or `collection: "storyline"`: they are ordered sections, so a revision is an entry carrying that section\'s `id` and only the fields you changed, and a new section is an entry with no `id` — never a rewrite of the whole document.',
    'Repair the cast through `profiles`: merge duplicate characters, resolve contradictory traits, and give any profile without a gender trait one — `female` or `male` — because a character without it is unfinished.',
    'Every write carries `expects: [{ id, rev }]` for the revision you just read; a rejected call means re-read and re-apply, never force.',
    'Prefer the smallest change that makes the Title hold together, and where prose would have to change as well, say so in an edit note rather than rewriting the scene yourself.',
    'Return the revised layout as an ordered list of chapter ids and titles, then numbered edit notes. Keep each note operational: what to change, where, and why in one line.'
].join('\n');

/**
 * The roster's base instructions, keyed by agent name. This is the preset's
 * `customAgents` map: for a name listed here `agentsFromProfiles` skips the
 * catalogue entirely and the stored text IS the system prompt
 * (packages/underload/harness/src/server/harnesses/toolbox.ts
 * `agentConfigurationForCustom`), which is what a restart replays exactly.
 */
export const STORYLINE_AGENT_INSTRUCTIONS: Readonly<Record<string, string>> = {
    [WRITER_AGENT_NAME]: WRITER_INSTRUCTION,
    [READER_AGENT_NAME]: READER_INSTRUCTION,
    [EDITOR_AGENT_NAME]: EDITOR_INSTRUCTION
};

// Display identity per agent (R2 colors). Nothing in the runtime reads these; the UI
// paints one stable swatch per role instead of hashing its name. Chosen so the three
// roles of one team read as a team: ink for the author, amber for the reviewer, teal
// for the reviser.
export const STORYLINE_AGENT_COLORS: Readonly<Record<string, string>> = {
    [WRITER_AGENT_NAME]: '#8b5e34',
    [READER_AGENT_NAME]: '#b45309',
    [EDITOR_AGENT_NAME]: '#0f766e'
};

// ---------------------------------------------------------------------------
// The preset
// ---------------------------------------------------------------------------

/**
 * Declare and enable the story record tools on a freshly built harness.
 *
 * `requestTools(caller, { names })` is the host-side entry to the SAME enabled set
 * `toolRequest` writes: `caller: undefined` means "the harness itself, no calling
 * agent", and the returned `{ matched, enabled, omitted }` counts are how the tests
 * prove all three names got a slot rather than being silently dropped. Enabling a name
 * that is already enabled is a no-op, and a name that is NOT registered or is a core
 * declaration throws — hence the registration guard, which keeps this working against a
 * harness build that renames or promotes a collection.
 */
export const enableStorylineRecordTools = (harness: Harness): void => {
    for (const name of STORYLINE_RECORD_TOOL_NAMES) {
        if (harness.tools[name] === undefined) continue;

        harness.runtime.requestTools(undefined, { names: [name] });
    }
};

/**
 * The preset's `report` is the server's diagnostic sink (harness
 * src/server/harnesses/types.ts:88 `diagnostic`, wired by the store at
 * src/server/sessions.ts:2232). Routing chain failures there is what makes "the writer
 * was never asked to review" a fact `GET /sessions/{id}` can answer instead of a line in
 * a terminal nobody is watching. A preset built outside the server (a test, a CLI) has no
 * sink, and then the same sentence goes to stderr rather than being lost.
 */
const createStorylineFailureReport = (report?: StorylinePresetReport): ((message: string) => void) => {
    if (report?.diagnostic === undefined) {
        return (message: string): void => {
            console.warn(`[storyline] ${message}`);
        };
    }

    return (message: string): void => {
        // `policy` is the kind a host reports a DECISION under (harness
        // src/types/index.ts:3948 `HarnessDiagnosticEvent`, and the store journals it on
        // the session at src/server/sessions.ts `notePluginDiagnostic`). Both messages this
        // sink gets are decisions of that shape — a chain that stopped at its depth cap, or
        // a chained review that could not be delivered — so one kind is the honest mapping.
        report.diagnostic?.({ type: 'plugin_diagnostic', kind: 'policy', owner: STORYLINE_DIAGNOSTIC_OWNER, message });
    };
};

/** The per-session construction this preset performs, overridable for a scripted host. */
export type StorylineHarnessBuilder = (settings: RunnerSettings, progress: HarnessProgress, report?: StorylinePresetReport) => Harness;

export type StorylinePresetOptions = {
    /**
     * Builds the harness for one session. Defaults to the shared profiled factory — the
     * one every shipped preset uses — and a test passes a scripted-transport team here
     * while keeping THIS file's wiring (tool declarations plus the review chain).
     */
    build?: StorylineHarnessBuilder;
    /**
     * The review chain to install. Defaults to `STORYLINE_CHAIN` / `STORYLINE_CHAIN_DEPTH`
     * read at construction time; an explicit value is how a host (or a test) pins the rule
     * without touching the environment.
     */
    chain?: StorylineChainRules;
    /** Environment the chain rules are read from. Defaults to `process.env`. */
    env?: NodeJS.ProcessEnv;
    /** Observer overrides: `deliver`, `report`, `schedule` (see ./orchestrator.ts). */
    orchestration?: Pick<StorylineOrchestratorOptions, 'deliver' | 'report' | 'schedule'>;
};

/**
 * Build the `storyline` preset.
 *
 * `create` runs once per SESSION with that session's merged provider settings, and by
 * default it delegates to `createProfiledHarness` — the shared live factory — passing the
 * `customAgents` map so the roster is built from this file's prompts. The harness then
 * gets three steps of this package's wiring:
 *   1. the review-chain observer, wrapped AROUND the progress closure (the closure is a
 *      constructor argument, so the wrapper has to exist before the build and resolve the
 *      handle lazily through it);
 *   2. the record tools declared (see `enableStorylineRecordTools`);
 *   3. nothing else — the two collections a Title owns are defined by the service layer
 *      once the session row exists (./service.ts), not here, because a preset factory
 *      cannot await a tool call (`create` is synchronous by contract, harness
 *      src/server/harnesses/types.ts:201) and a fire-and-forget `define` would race the
 *      store's own snapshot restore on a restarted session.
 */
export const createStorylinePreset = (options: StorylinePresetOptions = {}): HarnessPreset => {
    // The shared factory for THIS team. Built once per preset instance, exactly as every
    // shipped preset does it, because the closure is what captures the maps a session is
    // frozen with. A host that supplies `build` (a scripted team in a test) replaces the
    // whole step, and this factory is then never constructed.
    const buildTeam: StorylineHarnessBuilder =
        options.build ??
        createProfiledHarness(
            WRITER_AGENT_NAME,
            [READER_AGENT_NAME, EDITOR_AGENT_NAME],
            {},
            undefined,
            STORYLINE_AGENT_COLORS,
            STORYLINE_AGENT_INSTRUCTIONS
        );

    return {
        name: STORYLINE_PRESET_NAME,
        title: 'Storyline',
        description:
            'A story team working on one Title: the `writer` drafts prose, the `editor` revises the plan and the sequence, and the `reader` critiques what is on the page. The Title is its records — `chapters` for the prose, `profiles` for the cast, `outlines` and `storyline` for the ordered sections — and all three record tools are already declared on every turn, so no discovery call is needed to use them. When one role finishes a turn that changed records, the next is asked to review it.',
        // Every storyline session dials a model, so the card is not usable without a
        // provider (the scripted `demo` preset is the only one that is).
        requiresEndpoint: true,
        primary: WRITER_AGENT_NAME,
        // The delegation allowlist. Non-empty is what registers `delegate`
        // (src/harness.ts `activation: 'subagents'`), so the writer really can ask.
        subagents: [READER_AGENT_NAME, EDITOR_AGENT_NAME],
        agents: [...STORYLINE_AGENT_NAMES],
        // Declared for display only; the factory below is the source of truth. The
        // shared toolbox means the card advertises exactly what a shipped card does.
        tools: SHARED_TOOL_NAMES,
        environmentTools: ['search', 'fetch'],
        // Same rule as `agentColors`: display metadata for the three roles, never a
        // prompt input.
        agentColors: STORYLINE_AGENT_COLORS,
        // R7: the invented roster. `agentsFromProfiles` builds these three from the
        // stored text instead of a catalogue profile, and the registry replays the
        // map when a saved session is rebuilt.
        customAgents: STORYLINE_AGENT_INSTRUCTIONS,
        // `builtin: true` is honest provenance: this card ships with the application
        // rather than being registered by a client through POST /harnesses.
        builtin: true,
        editable: true,
        template: 'live',
        create: (settings, progress, report) => {
            // The observer needs the handle, the handle needs the progress closure, and
            // the closure is a constructor argument — so the handle is resolved lazily
            // through a variable that is assigned the moment `buildTeam` returns. No run
            // can report progress before then, because construction starts none.
            let built: Harness | undefined;

            // Resolved PER SESSION rather than at module load: a bad
            // `STORYLINE_CHAIN_DEPTH` is then a session-create error message naming the
            // variable, not an `import` that throws for every consumer of this barrel.
            const rules = options.chain ?? resolveChainRules(options.env ?? process.env);
            const failure = createStorylineFailureReport(report);
            const orchestrator = createStorylineOrchestrator({
                harness: () => built,
                rules,
                report: failure,
                ...options.orchestration
            });

            // The observer runs FIRST so it still sees every frame when the store's own
            // recorder drops one (a run outside a turn scope has no sink by design,
            // src/server/sessions.ts:2766). Whatever the closure returns is forwarded
            // untouched: the store's recorder is async and its promise is the run's own.
            const observed: HarnessProgress = (event: HarnessEvent) => {
                orchestrator.observe(event);

                return progress(event);
            };

            const team = buildTeam(settings, observed, report);

            built = team;

            enableStorylineRecordTools(team);

            return team;
        }
    };
};

/** A fresh preset instance (a registry copies templates, but a fresh object cannot leak). */
export const storylinePreset: HarnessPreset = createStorylinePreset();

export type StorylineRegistryOptions = {
    /**
     * Extra presets, inserted LAST. `createHarnessRegistry` seeds an
     * insertion-ordered Map with `entries.set(name, copy)` per entry
     * (packages/underload/harness/src/server/harnesses/registry.ts:1199-1203), so
     * the last entry under a name wins. That is how a test swaps in a scripted
     * preset named `storyline` without touching this file.
     */
    extra?: readonly HarnessPreset[];
    /** Include the presets that ship with `@underload/harness` (default true). */
    includeShipped?: boolean;
};

/**
 * The preset catalogue this server boots with: the shipped presets, then
 * `storyline`, then the caller's overrides — the insertion order IS the precedence
 * rule. Keeping the shipped presets costs nothing and lets an operator open a
 * `workspace` or `research` conversation against the same process.
 */
export const createStorylineHarnessRegistry = (options: StorylineRegistryOptions = {}): HarnessRegistry =>
    createHarnessRegistry([
        ...(options.includeShipped === false ? [] : presets),
        createStorylinePreset(),
        ...(options.extra ?? [])
    ]);

/**
 * Make sure one live registry can resolve `storyline`, and return it.
 *
 * The normal path is a no-op: this package's endpoint module is the first caller of
 * `getHarnessRuntime` for its database root, so the runtime it asks for is built
 * with `createStorylineHarnessRegistry()`. The fallback exists for the case where a
 * WIDER gateway has already built the root-keyed runtime for the harness package's own
 * `/v1/harness` mount, with the default catalogue. In that runtime
 * `storyline` would be missing and every session create would 404.
 *
 * `registry.create()` cannot help here: it validates every member id against the
 * trusted profile catalogue, and `writer`/`reader`/`editor` are session-defined
 * agents, not profiles. `snapshot()`/`restore()` can — they are the registry's own
 * documented rollback pair, they carry preset objects verbatim, and a preset is
 * never mutated in place, so appending one entry and restoring is exactly the
 * "committed registry mutation" the API performs for a create.
 */
export const ensureStorylinePreset = (registry: HarnessRegistry): HarnessPreset => {
    const existing = registry.find(STORYLINE_PRESET_NAME);

    if (existing !== undefined) return existing;

    const preset = createStorylinePreset();
    const captured = registry.snapshot();

    registry.restore({
        ...captured,
        entries: [...captured.entries, [STORYLINE_PRESET_NAME, preset]]
    } as HarnessRegistrySnapshot);

    return preset;
};
