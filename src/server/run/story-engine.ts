// The Story runtime built on the @underload/harness ENGINE only.
//
// VOCABULARY (V-1). The five profiles this file configures are EMPLOYEES — the standing roster
// entries Writer, Editor, Critic, Reader and Researcher. An employee is not an agent; it becomes
// one only while a thread is executing. `engine.agents[kind]` is the employee's engine profile,
// and every Run opens one THREAD under it. A template role chooses which employee kind takes a
// job; the template itself is neither an employee nor an agent (D-38).
//
// WHY THIS FILE EXISTS. A Story is a book, a Phase is a session against that book, and a Run is
// one thread inside the phase's session. The harness package owns the part that is the same for
// every host — the agent loop, the tool-call protocol, transcript commitment, retries and thread
// lifecycle — while Storyline owns everything that is specific to the Author: the book, the
// loop, the permission rows, the criteria and the phases. So Storyline builds ONE harness per
// Story with the same five employees every story uses (writer, editor, critic, reader,
// researcher), and each dispatched Run opens a thread inside that story's harness.
//
// ISOLATION. Two stories never share a Harness instance, a tool registry, a transcript or a
// thread roster. The EMPLOYEE DEFINITIONS are shared values (the same kind, prompt and model),
// but their runtime state lives in the story's own harness, which is exactly the "same employee
// across multiple harnesses, no cross contamination" rule.
//
// SESSIONS. The harness engine itself is the execution loop; it has no session object. Storyline
// supplies that level: one Session record per Story phase (the UI's "phrase": P1/P3/P4), opened on
// first use and owning the threads its Runs create. A phase therefore groups its threads without
// any engine state crossing between stories; a thread is never reused.
//
// ENGINE ONLY. This module imports `@underload/harness` (agent/harness/tool and their types). It
// never imports `@underload/harness/server`, never starts a listener, and never uses the harness
// server's SessionStore: the Storyline server (`api/server.ts`) is the only server.
import { BUILTIN_PLUGINS, agent, harness, tool } from '@underload/harness';
import type {
    Agent,
    AgentRank,
    Harness,
    HarnessAssistantMessage,
    HarnessMessage,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest,
    ToolContext
} from '@underload/harness';
import type { ChatClient, ChatMessage, ToolCall, ToolSchema } from '../llm';
import type { LoopOutcome, LoopSpec, RunTally } from './loop';
import { agentModelFor, templateRoleModels, type AgentModelSource, type AgentTemplateModel } from './agent-models';
import { isReportTool } from './catalogue';
import { isProposedResult, type RunToolContext, type ToolRuntime } from './types';
import type { RoleKind, Run, Story, StoryPhase } from '../../shared/types';
import type { Store } from '../store';
// The ONE definition of "this journaled Run row is still alive" (`spawning|working|reporting`).
// `StoryHarnessManager.statuses` reads it so the roster and the loop never disagree about what a
// live run is (L-37), and `loop/records.ts` imports nothing from `run/`, so this edge is not a cycle.
import { isLiveRun } from '../loop/records';
import {
    StoryThreadLog,
    type StoryThreadActivity,
    type StoryThreadRecord,
    type StoryThreadState
} from './thread-log';

// ---------------------------------------------------------------------------
// The employee roster: the same five standing identities in every Story's harness
// ---------------------------------------------------------------------------

/**
 * The five EMPLOYEE kinds (V-1). The constant keeps its historical `AGENT` spelling because the
 * engine profile key is the kind; what it enumerates is the roster of employees, not running
 * agents. An employee becomes an agent only for the thread a Run opens under it.
 *
 * `researcher` is the Phase-1 addition (documents/phase-1-research-pipeline.md §3.1): it owns a
 * dispatched Work Item (V-2), reads everything, and writes only `knowledge`.
 */
const STORY_AGENT_KINDS: readonly RoleKind[] = ['writer', 'editor', 'critic', 'reader', 'researcher'];

/**
 * R2/R3 — the harness engine's CONTEXT plugins this host runs. Both are shipped built-ins:
 *
 *   - `context-compaction` stops a long thread's transcript growing without bound: at the
 *     context limit the conversation summarizes itself, and every turn the summary replaced
 *     stops being sent (reversibly, through the engine's inclusion flags — nothing is deleted).
 *   - `context-trimmer` withholds superseded/failed tool units and stale thinking on every
 *     assistant turn, which is the cheap per-turn half of the same problem.
 *
 * `async-ping` (the third built-in) is deliberately left OUT: it keeps a parked server session
 * awake by sending background pings, while Storyline's runs are host-driven turns whose lease
 * the executor already refreshes after each model request and tool call (S-4a). Running it
 * would add provider traffic without keeping any Storyline thread alive.
 */
const STORYLINE_BUILTIN_PLUGINS = BUILTIN_PLUGINS.filter(
    (plugin) => plugin.name === 'context-compaction' || plugin.name === 'context-trimmer'
);

/**
 * Every configured employee holds the same rank (the harness's authority model, R15). Rank A for
 * all five makes them peers: none is another's subordinate, and the ENGINE registers no
 * `delegate` door for a single-rank roster. The harness still needs a routing name for an
 * unfocused session, and that name is the Editor — the Author's one channel — not a higher-ranked
 * employee (V-1).
 *
 * V-2: only a Rank A employee may own a dispatched Work Item and take action on a phase's
 * requirements. A Rank B employee may be added, but only as a delegation target inside a Rank A
 * thread; it never receives a Work Item and never reports to the loop independently.
 *
 * The Researcher is Rank A too (§3.1): the `research` Work Item is a dispatched job like any
 * other, so a Rank B Researcher could not own it and the pipeline's second gate would never close.
 */
export const STORY_AGENT_RANKS: Record<RoleKind, AgentRank> = {
    writer: 'A',
    editor: 'A',
    critic: 'A',
    reader: 'A',
    researcher: 'A'
};

/**
 * The employee that routes an unfocused session. VOCABULARY (V-1): "entry" is not a roster role
 * and never reaches the dashboard — the harness needs a routing name, and the Author's one channel
 * is the Editor, so the Editor is that name (the directive handoff). It is routing, never an
 * authority claim (R15).
 */
export const STORY_AGENT_ENTRY: RoleKind = 'editor';

/** The single-property unwrap the harness applies before `execute` (tool()'s contract). */
const singlePropertyKey = (schema: Record<string, unknown> | undefined): string | undefined => {
    if (schema?.type !== 'object') return undefined;

    const properties = schema.properties;

    if (typeof properties !== 'object' || properties === null) return undefined;

    const keys = Object.keys(properties as Record<string, unknown>);

    return keys.length === 1 ? keys[0] : undefined;
};

/**
 * The OpenAI wire shape of one assistant tool call. The engine's `HarnessToolCall` is flat
 * (`{id, name, arguments}`); a strict provider requires the nested `function` wrapper, and its
 * absence is a 400 on every turn after the first tool call.
 */
interface WireToolCall {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
}

/** The engine's transport sends `{}` for arguments that are not a plain JSON object; same rule here. */
const wireArguments = (raw: string): string => {
    try {
        const parsed: unknown = JSON.parse(raw);

        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? raw : '{}';
    } catch {
        return '{}';
    }
};

/**
 * How many live steps one running thread reports. The Author is reading "what is happening
 * now", not the transcript; the newest steps are the useful ones, and a long run must not grow
 * an unbounded array in the projection.
 */
const MAX_ACTIVITY_STEPS = 40;

/** One activity line is a glance, not a transcript — long tool summaries and prose get clipped. */
const ACTIVITY_LINE_LIMIT = 600;

/**
 * S-4a/E-0 — how often a provider request refreshes the run's lease while it is in flight. A
 * large context can spend minutes composing a turn, and the sweep rightly reads "no tool call
 * for a while" as a dead owner; waiting on a live request is work too. The beat stops with the
 * request, so a process that stops running still lets the lease lapse.
 */
const STREAM_HEARTBEAT_MS = 30_000;

/** One line of activity, trimmed and bounded for the thread surface. */
const activityLine = (text: string): string => {
    const trimmed = text.trim();

    return trimmed.length <= ACTIVITY_LINE_LIMIT ? trimmed : `${trimmed.slice(0, ACTIVITY_LINE_LIMIT - 1)}…`;
};

/**
 * The sentence an aborted stream answers with. The abort carries the CAUSE (the Author's cord,
 * a stopped Story, a lapsed lease), so the thread's retained error names the real one instead
 * of blaming the Author for every cancellation (S-4a, P8, D-37).
 */
const abortSentence = (signal: AbortSignal | undefined): string =>
    signal?.reason instanceof Error ? signal.reason.message : 'the run was stopped (P8)';

/** A tool call as one activity line: the tool plus the human summary the tool layer wrote. */
const toolActivityLine = (name: string, result: { ok?: boolean; summary?: string; message?: string; error?: string }): string => {
    const detail = result.summary ?? result.message ?? result.error;

    if (detail !== undefined && detail.trim().length > 0) return `${name} — ${detail}`;

    return result.ok === false ? `${name} — failed` : name;
};

/** One live Run's identity and the Storyline context its tool calls execute against. */
interface EngineRun {
    /** The employee key whose engine profile this run's thread was built under. */
    agentKey: string;
    /** The engine thread id, once `createThread` has minted it. */
    threadId: string;
    storyId: string;
    phase: StoryPhase;
    roleKind: RoleKind;
    roleName: string;
    label: string;
    /** The Storyline Run row this thread belongs to (a panel agent's label is not the parent's id). */
    runId: string;
    /** The tool runtime the engine calls execute through (a panel agent's is the intercepting one). */
    runtime: ToolRuntime;
    /** The Storyline context (story binding, role row, attribution). */
    context: RunToolContext;
    /** What the thread was asked to do, in one line (the thread bar's title). */
    title: string;
    /** The full brief this thread was given. */
    request: string;
    /** The kickoff turn, kept beside the brief for the request/answer surface. */
    kickoff: string;
    /** The final answer; empty while the thread runs. */
    answer: string;
    /** Live steps, oldest first — what the employee is doing right now (U-8). */
    activity: StoryThreadActivity[];
    /** The thread's retained state. */
    state: StoryThreadState;
    /** Why the thread failed, when it did. */
    error?: string;
    tally: RunTally;
    heartbeat?: () => void;
    onReport?: (name: string) => void;
    signal?: AbortSignal;
    /** U-1e: the names this run may be OFFERED (an assistant run has no web row). */
    allowed: Set<string>;
    /** Serialises tool executions inside this thread so store commits keep call order. */
    queue: Promise<unknown>;
    /** Model requests this run has made, for the loop's diagnostics. */
    turns: number;
    /** The exact system line registered in `byBrief` (unique per run). */
    briefKey: string;
    /** The brief system line, useful to a host inspecting the thread. */
    startedAt: number;
    endedAt?: number;
    /** The last transport failure, so the executor can classify it exactly (S-3). */
    lastError?: unknown;
}

/** One phase session inside a Story's harness. */
export interface StorySession {
    storyId: string;
    phase: StoryPhase;
    openedAt: number;
    runs: Map<string, EngineRun>;
}

/** One closed thread row, kept on an employee tile so a failed thread does not vanish into `idle` (S-3, U-8). */
export interface StoryAgentRecentRun {
    run_id: string;
    story_id: string;
    story_title: string;
    work_item: string;
    state: Run['state'];
    started_at: string;
    ended_at?: string;
    end_reason?: string;
    no_op: boolean;
    tokens: number;
}

/** The public status row a dashboard renders for one EMPLOYEE tile (V-1). */
export interface StoryAgentStatus {
    kind: RoleKind;
    title: string;
    /** `running` means the employee has at least one live thread; `idle` means it has none. */
    status: 'idle' | 'running';
    /** The harness rank this employee holds; `A` is a peer, not a lead (R15, V-2). */
    rank: AgentRank;
    /**
     * U-8 / T-6b — the model this employee asks for when its template role names none. The
     * employee rail shows it beside the status so the Author never has to guess what a tile runs.
     */ model: string;
    /** `agent` when the Author set it on the global roster, `default` for the process model. */
    model_source: AgentModelSource;
    /**
     * Template roles that name their own model for this employee kind (T-6b). They override the
     * process default until the Author sets a roster choice, so the tile has to name them.
     */
    template_models: AgentTemplateModel[];
    /** Live threads across every Story, oldest first — the executions this employee is running. */
    working: Array<{
        story_id: string;
        story_title: string;
        phase: StoryPhase;
        role_name: string;
        work_item: string;
        thread_id: string;
        started_at: number;
    }>;
    /**
     * The newest closed runs of this kind, newest first. A run row exists from spawn to teardown
     * (D-18), and its `end_reason` is the only place a provider fault or a bad brief is written
     * (S-3) — without this list the tile reads `idle` while the same fault repeats every sweep.
     */
    recent: StoryAgentRecentRun[];
}

/** How many closed runs a tile keeps for "why did it end" (bounded, newest first). */
const RECENT_RUNS = 3;

/** The newest closed threads of ONE employee kind, read from the journaled rows (never local guesses). */
function recentRuns(store: Store, kind: RoleKind, storyId?: string): StoryAgentRecentRun[] {
    return store.runs
        .list()
        .filter(
            (run) =>
                run.role === kind &&
                (storyId === undefined || run.story_id === storyId) &&
                // Only a torn-down row: a live run is already on `working`, and "last run — working"
                // would read like a second, finished thread.
                (run.state === 'torn_down' || run.state === 'failed' || run.state === 'abandoned')
        )
        .sort((left, right) => {
            const started = right.started_at.localeCompare(left.started_at);

            return started !== 0 ? started : right.id.localeCompare(left.id);
        })
        .slice(0, RECENT_RUNS)
        .map((run) => ({
            run_id: run.id,
            story_id: run.story_id,
            story_title: (store.stories.get(run.story_id) as Story | undefined)?.title ?? run.story_id,
            work_item: run.work_item_ref ?? '',
            state: run.state,
            started_at: run.started_at,
            ...(run.ended_at === undefined || run.ended_at === null ? {} : { ended_at: run.ended_at }),
            ...(run.end_reason === undefined ? {} : { end_reason: run.end_reason }),
            no_op: run.no_op === true,
            tokens: run.tokens
        }));
}

export interface StoryAgentCatalogueEntry {
    kind: RoleKind;
    title: string;
    description: string;
}

export const STORY_AGENT_CATALOGUE: readonly StoryAgentCatalogueEntry[] = [
    {
        kind: 'writer',
        title: 'Writer',
        description:
            'The only employee that writes the book: the Summary in phase ①, plotlines in ②, chapters and prose in ③. Refused on locked artifacts.'
    },
    {
        kind: 'editor',
        title: 'Editor',
        description: 'Chooses between competing drafts, verifies Ideas and findings, and writes no prose of its own.'
    },
    {
        kind: 'critic',
        title: 'Critic',
        description: 'Reads as an audience, rates what it reads, and proposes Ideas and findings. Never writes.'
    },
    {
        kind: 'reader',
        title: 'Reader',
        description: 'Judges criteria, files findings and tasks, and reports to the Author. Writes no artifacts.'
    },
    {
        // §7.3 of documents/phase-1-research-pipeline.md: the fifth employee. Unlike the four
        // above it has no §4 story artifact of its own — its product is `knowledge`, and its
        // writes are refused naming P10 the moment it reaches for the book.
        kind: 'researcher',
        title: 'Researcher',
        description: 'Searches the web, keeps the Story knowledge current, and never writes the book.'
    }
];

/** A title for one employee kind, re-used by the route projection and the tests. */
export const storyAgentTitle = (kind: string): string =>
    STORY_AGENT_CATALOGUE.find((entry) => entry.kind === kind)?.title ?? kind;

// ---------------------------------------------------------------------------
// One Story = one harness
// ---------------------------------------------------------------------------

export interface StoryHarnessOptions {
    store: Store;
    chat: ChatClient;
    runtime: ToolRuntime;
    /** Model used when a role names none (T-6b). */
    defaultModel: string;
    /** Test seam; defaults to the engine's `harness`. */
    createHarness?: typeof harness;
    /** Durable thread history (request + answer); defaults to an in-memory log. */
    threadLog?: StoryThreadLog;
}

export class StoryHarness {
    private readonly store: Store;
    private readonly chat: ChatClient;
    private readonly runtime: ToolRuntime;
    private readonly defaultModel: string;
    private readonly engine: Harness;
    /** The configured definitions, kept so the engine's baseline `delegate` can be re-skinned. */
    private readonly catalogue: Record<string, ReturnType<typeof tool>>;
    /** The EXACT model-facing schemas (the engine may only see a loosened copy for validation). */
    private readonly declaredSchemas: Map<string, ToolSchema>;
    private readonly sessions = new Map<StoryPhase, StorySession>();
    private readonly runs = new Map<string, EngineRun>();
    /** Every thread this Story ever ran, including the ones `prune` drops from the live maps. */
    private readonly history = new Map<string, EngineRun>();
    /** Request + answer, retained beyond the process (see thread-log.ts). */
    private readonly threadLog: StoryThreadLog;
    /** Brief system line -> run, so the transport can attribute a request to its thread. */
    private readonly byBrief = new Map<string, EngineRun>();

    constructor(
        private readonly storyId: string,
        options: StoryHarnessOptions
    ) {
        this.store = options.store;
        this.chat = options.chat;
        this.runtime = options.runtime;
        this.defaultModel = options.defaultModel;
        this.threadLog = options.threadLog ?? StoryThreadLog.memory();

        const create = options.createHarness ?? harness;
        const agents: Record<string, Agent> = {};
        const ranks: Record<string, AgentRank> = {};

        for (const kind of STORY_AGENT_KINDS) {
            agents[kind] = agent({ model: this.defaultModel, stream: this.streamFor(kind), retry: false });
            ranks[kind] = STORY_AGENT_RANKS[kind];
        }

        // Every configured employee is Rank A: one rank across the roster means the ENGINE
        // registers no `delegate` door of its own (R15), and the session's routing name is the
        // Editor (the Author's channel) rather than a higher-ranked employee. Storyline's §8
        // `delegate` remains the template's explicit D-17e door, not an authority relation between
        // these peers. V-2 allows a Rank B employee only as a delegation target, never as a Work
        // Item owner.
        this.catalogue = this.toolCatalogue();
        this.declaredSchemas = new Map(this.runtime.schemas().map((schema) => [schema.function.name, schema]));
        this.engine = create({
            agents,
            entry: STORY_AGENT_ENTRY,
            ranks,
            presets: false,
            // The two CONTEXT built-ins (compaction + trimmer), never the parked-session ping.
            builtinPlugins: STORYLINE_BUILTIN_PLUGINS,
            toolCreation: false,
            tools: this.catalogue,
            knowledgeOwner: `storyline:${storyId}`
        });

        this.installDelegate();
    }

    /**
     * R2/R3 — the engine plugins this Story's harness actually runs, in application order.
     * Diagnostics and the plugin test read this; the roster UI has no plugin pane (the host
     * fixes the set in {@link STORYLINE_BUILTIN_PLUGINS}).
     */
    get pluginNames(): readonly string[] {
        return this.engine.plugins;
    }

    /**
     * The engine installs its own `delegate` baseline and re-projects that row's schema whenever
     * the roster changes. Storyline's catalogue also has a `delegate` tool — the one the §4.12
     * template's delegation list governs — so the installed row is re-skinned to that definition
     * after construction and after every `addAgent`.
     */
    private installDelegate(): void {
        const intended = this.catalogue.delegate;
        const installed = this.engine.tools.delegate;

        if (intended === undefined || installed === undefined) return;

        installed.description = intended.description;
        installed.parameters = intended.parameters;
        installed.tags = [...intended.tags];
        installed.execute = intended.execute;
        installed.visibility = intended.visibility;
    }

    // -----------------------------------------------------------------------
    // The tool surface: the §8 catalogue wired to the run that called it
    // -----------------------------------------------------------------------

    private toolCatalogue(): Record<string, ReturnType<typeof tool>> {
        const catalogue: Record<string, ReturnType<typeof tool>> = {};

        for (const definition of this.runtime.schemas()) {
            const declared = definition.function.parameters;
            const key = singlePropertyKey(declared);
            const toolName = definition.function.name;
            // The engine validates before `execute`; Storyline's own runtime is the authority on
            // the body (T-11), and a test double legitimately declares an opaque `{}` schema. An
            // explicit empty shell is opened so the call reaches that authority instead of being
            // rejected by a duplicate validator with a weaker schema.
            const schema =
                declared !== null &&
                typeof declared === 'object' &&
                declared.type === 'object' &&
                typeof declared.properties === 'object' &&
                Object.keys(declared.properties as Record<string, unknown>).length === 0
                    ? { ...declared, additionalProperties: true }
                    : declared;

            catalogue[toolName] = tool({
                name: toolName,
                description: definition.function.description,
                // T-6/T-6a: every session holds the whole catalogue and sees it on turn one.
                tags: ['storyline', 'story'],
                visibility: 'core',
                parameters: schema,
                execute: async (context: ToolContext) => {
                    const run = this.runOf(context);

                    if (run === undefined) {
                        return {
                            ok: false,
                            error: 'this tool call arrived outside a Storyline thread, so there is no Story to bind (T-3)'
                        };
                    }

                    // `tool()` applies the single-property rule; the §8 runtime takes the object
                    // form (T-11 validates the body), so the unwrap is reversed exactly once.
                    const args =
                        key === undefined
                            ? ((context.parameters ?? {}) as Record<string, unknown>)
                            : ({ [key]: context.parameters } as Record<string, unknown>);

                    // One call at a time per thread: the harness may schedule a batch together,
                    // and Storyline's store commits have an author-visible order.
                    const executed = run.queue.then(() => this.executeInRun(run, toolName, args));

                    run.queue = executed.catch(() => undefined);

                    return executed;
                }
            });
        }

        return catalogue;
    }

    private runOf(context: ToolContext): EngineRun | undefined {
        if (context.threadId !== undefined) {
            const byThread = this.runs.get(context.threadId);

            if (byThread !== undefined) return byThread;
        }

        // Manual `executeTool` has no thread; the caller is the host and must name no Story
        // implicitly. Storyline never takes that path, so an absent thread is a wiring fault.
        return undefined;
    }

    private async executeInRun(run: EngineRun, name: string, args: Record<string, unknown>): Promise<unknown> {
        if (run.signal?.aborted === true)
            return { ok: false, error: 'the run was stopped before this call started (P8)' };

        // U-1e: not merely hidden from the declaration list. A model that guesses a name the run
        // was not offered is refused here as well, so §7/§8.6's empty cell cannot be bypassed.
        if (!run.allowed.has(name)) {
            return { ok: false, error: `tool "${name}" is not offered to this run (U-1e)` };
        }

        const cursor = run.tally.executed.length;
        // The step is visible while the tool runs, then rewritten with what it answered — the
        // surface reads "readChapter — running…" and becomes "readChapter — <summary>".
        const step = this.noteActivity(run, `${name} — running…`);

        // S-4a: a long tool (a web fetch, a large read) is work too; beat while it is in flight so
        // a slow call is not mistaken for a dead owner by the sweep.
        const beating =
            run.heartbeat === undefined ? undefined : setInterval(() => run.heartbeat?.(), STREAM_HEARTBEAT_MS);
        let result: Awaited<ReturnType<ToolRuntime['execute']>>;

        try {
            result = await run.runtime.execute(run.context, name, args);
        } finally {
            if (beating !== undefined) clearInterval(beating);
        }

        step.text = activityLine(toolActivityLine(name, result));

        // S-4a: the lease is refreshed on every tool call, exactly as the hand-written loop did.
        run.heartbeat?.();

        if (isReportTool(name) && !isProposedResult(result)) {
            if (!run.tally.reports.includes(name)) run.onReport?.(name);

            run.tally.reports.push(name);
        }

        if (!isProposedResult(result)) {
            // A nested run (the delegate's sub-context) merges its calls into this tally while
            // the call is still executing. Re-seat them AFTER the call that caused them so the
            // list reads as the sequence of causes (the legacy loop's tally cursor rule).
            const merged = run.tally.executed.splice(cursor, run.tally.executed.length - cursor);

            run.tally.executed.push(name, ...merged);
        }

        return result;
    }

    // -----------------------------------------------------------------------
    // The transport: our ChatClient behind the engine's HarnessStream
    // -----------------------------------------------------------------------

    /**
     * Maps the engine transcript onto the provider's pinned `ChatMessage` shape. The engine keeps
     * richer messages (inclusion flags, message ids, attachments); none of those is a provider
     * field, and this adapter is the only place that projection happens.
     */
    private chatMessages(messages: readonly HarnessMessage[]): ChatMessage[] {
        return messages
            .filter((message) => message.included !== false)
            .map((message) => {
                if (message.role === 'tool') {
                    return {
                        role: 'tool',
                        content: message.content,
                        tool_call_id: message.toolCallId,
                        name: message.name
                    } satisfies ChatMessage;
                }

                if (message.role === 'assistant') {
                    // `ChatMessage` deliberately does not declare `tool_calls`, but the wire
                    // transcript the provider answers DOES carry them. The provider checks the
                    // OpenAI shape — every call is `{id, type: 'function', function: {name,
                    // arguments}}` — while the engine keeps the flat `{id, name, arguments}`
                    // form, so the projection is the one place the two vocabularies meet.
                    // Sending the engine's flat form is what made a second turn a 400 with
                    // "Invalid value for [0].function: Field required" on a strict provider.
                    const projected = {
                        role: 'assistant' as const,
                        content: message.content
                    } as ChatMessage & { tool_calls?: WireToolCall[] };

                    if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
                        projected.tool_calls = message.toolCalls.map((call) => ({
                            id: call.id,
                            type: 'function' as const,
                            function: { name: call.name, arguments: wireArguments(call.arguments) }
                        }));
                    }

                    return projected;
                }

                return { role: message.role, content: message.content } satisfies ChatMessage;
            });
    }

    /**
     * The engine tool declaration shape -> the provider's OpenAI function schema.
     *
     * The engine registers its own baseline controls (`toolRequest`, `tasks`, the thread pair)
     * that are not part of Storyline's §8 surface. They stay registered — a host action may call
     * them — but they are not OFFERED to a Storyline agent: the declaration list is narrowed to
     * this Run's allowed names, which is what keeps T-6a and U-1e true at the wire.
     */
    private toolSchemas(request: HarnessStreamRequest, run: EngineRun | undefined): ToolSchema[] {
        return (request.tools ?? [])
            .filter((schema) => run === undefined || run.allowed.has(schema.name))
            .map(
                (schema) =>
                    this.declaredSchemas.get(schema.name) ?? {
                        type: 'function',
                        function: {
                            name: schema.name,
                            description: schema.description,
                            parameters: schema.parameters ?? { type: 'object', properties: {} }
                        }
                    }
            );
    }

    /**
     * The stream adapter. The Run is resolved from the request's first system message: each Run
     * owns a unique brief (and panel agents append their own preamble), so one lookup serves the
     * whole conversation without the transport growing a thread-id parameter it does not have.
     */
    private streamFor(kind: RoleKind): HarnessStream {
        return async function* (this: StoryHarness, request: HarnessStreamRequest): AsyncIterable<HarnessStreamEvent> {
            const run = this.runByRequest(request);

            if (run === undefined) {
                yield {
                    type: 'error',
                    message: `the ${kind} harness received a request whose brief names no Storyline Run`
                };
                return;
            }

            if (run.signal?.aborted === true) {
                yield { type: 'error', message: abortSentence(run.signal) };
                return;
            }

            this.noteActivity(run, `waiting on the model (turn ${run.turns + 1})`);

            let response;

            // S-4a/E-0: waiting on a live provider request is work too. A 175k-token context can
            // spend minutes composing one turn, and the lease would otherwise call a healthy run
            // dead. Beat for as long as the request is in flight; a stopped process still lets the
            // lease lapse because the beat dies with the process.
            run.heartbeat?.();
            let beating: ReturnType<typeof setInterval> | undefined;

            if (run.heartbeat !== undefined) {
                const beat = run.heartbeat;
                beating = setInterval(() => beat(), STREAM_HEARTBEAT_MS);
            }

            try {
                response = await this.chat.complete({
                    model: request.model,
                    messages: this.chatMessages(request.messages),
                    tools: this.toolSchemas(request, run),
                    signal: request.signal ?? run.signal
                });
            } catch (error) {
                if ((error as { name?: string } | undefined)?.name === 'AbortError') {
                    yield { type: 'error', message: abortSentence(request.signal ?? run.signal) };
                    return;
                }

                // S-3: the executor classifies a provider fault by its type (`LlmError`), so the
                // original is kept and rethrown after the engine has closed its thread.
                run.lastError = error;

                yield {
                    type: 'error',
                    message: error instanceof Error ? error.message : String(error)
                };
                return;
            } finally {
                if (beating !== undefined) clearInterval(beating);
            }

            // S-6/E-0: tokens are informational, recorded on every provider turn the run caused.
            run.tally.tokens += (response.usage?.input ?? 0) + (response.usage?.output ?? 0);
            run.turns += 1;

            const content = response.message.content ?? '';

            if (content.length > 0) {
                this.noteActivity(run, content);
                yield { type: 'text', delta: content };
            }

            // The engine requires tool-call ids to be unique for the whole conversation, while
            // an OpenAI-compatible provider commonly reuses `call_1` per turn. Nesting the turn
            // number into the id keeps both contracts true without asking a model to cooperate.
            const toolCalls = (response.message.tool_calls ?? []).map((call, index) => ({
                ...call,
                id: `${call.id}~${run.turns}_${index}`
            }));

            yield {
                type: 'done',
                stopReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
                toolCalls: toolCalls as ToolCall[],
                ...(response.usage === undefined
                    ? {}
                    : {
                          usage: {
                              input: response.usage.input,
                              output: response.usage.output,
                              total: response.usage.input + response.usage.output
                          }
                      })
            };
        }.bind(this);
    }

    private runByRequest(request: HarnessStreamRequest): EngineRun | undefined {
        for (const message of request.messages) {
            if (message.role !== 'system') continue;

            const run = this.byBrief.get(message.content);

            if (run !== undefined) return run;
        }

        return undefined;
    }

    // -----------------------------------------------------------------------
    // Sessions and threads
    // -----------------------------------------------------------------------

    /** The phase session, opened on first use. */
    session(phase: StoryPhase): StorySession {
        let session = this.sessions.get(phase);

        if (session === undefined) {
            session = { storyId: this.storyId, phase, openedAt: Date.now(), runs: new Map() };
            this.sessions.set(phase, session);
        }

        return session;
    }

    /** Every phase session this Story has opened, in phase order. */
    sessionsForStatus(): StorySession[] {
        return [...this.sessions.values()].sort(
            (left, right) => STORY_PHASE_ORDER.indexOf(left.phase) - STORY_PHASE_ORDER.indexOf(right.phase)
        );
    }

    /**
     * Runs one employee turn in a fresh thread of the Story's harness. The caller supplies the
     * Storyline context, runtime and tally; this method owns only the engine part.
     */
    async run(spec: EngineRunSpec): Promise<LoopOutcome> {
        const story = this.store.stories.get(this.storyId) as Story | undefined;

        if (story === undefined) throw new Error(`Story "${this.storyId}" does not exist (T-3)`);

        const agentKey = spec.roleKind;
        const session = this.session(spec.phase);

        // The FOUR employee kinds are the story's fixed roster (writer/editor/critic/reader),
        // created with the harness and shared by every Story that uses the same kinds. A Run opens
        // a THREAD on its kind's engine profile rather than minting a new profile: the employee is
        // the stable identity, while the agent exists only for this thread's lifetime and the
        // transcript and tool context stay thread-local (V-1).
        this.engine.agents[agentKey].model(spec.model);

        const thread = this.engine.createThread(agentKey, {
            label: `${this.storyId}:${spec.phase}:${spec.label}`
        });

        // The transport cannot see a thread id (the engine's stream request has none), so the
        // brief doubles as the correlation key. Identical jobs can run concurrently (two panel
        // agents with the same preamble are not possible, but two delegation calls with the same
        // task text are), so a duplicate gets a visible run tag instead of aliasing another run's
        // tally and tool context.
        let briefKey = spec.system;

        for (let duplicate = 2; this.byBrief.has(briefKey); duplicate += 1) {
            briefKey = `${spec.system}\n\nRun identity: ${thread.id} (${duplicate})`;
        }

        const title = spec.requestTitle?.trim() || spec.label;

        const run: EngineRun = {
            agentKey,
            threadId: thread.id,
            storyId: this.storyId,
            phase: spec.phase,
            roleKind: spec.roleKind,
            roleName: spec.roleName,
            label: spec.label,
            runId: spec.runId ?? spec.label,
            title,
            request: spec.system,
            kickoff: spec.kickoff,
            answer: '',
            activity: [],
            state: 'running',
            runtime: spec.runtime,
            context: spec.context,
            tally: spec.tally,
            heartbeat: spec.heartbeat,
            onReport: spec.onReport,
            signal: spec.signal,
            briefKey,
            // U-1e: an omitted list means the whole catalogue; an explicit list (an assistant run)
            // narrows what the model is offered and what it may call.
            allowed: new Set(
                spec.tools?.map((schema) => schema.function.name) ??
                    this.runtime.schemas().map((schema) => schema.function.name)
            ),
            queue: Promise.resolve(),
            turns: 0,
            startedAt: Date.now()
        };

        this.runs.set(thread.id, run);
        // The retained history is deliberately not the live `runs` map: `prune` evicts the engine
        // records the cap cannot hold, while the Author's revision surface keeps every thread.
        this.history.set(thread.id, run);
        session.runs.set(thread.id, run);
        this.byBrief.set(briefKey, run);

        try {
            // The brief is the system turn (S-2), and the kickoff asks for the job (S-4). This is
            // the same conversation shape the hand-written loop used, now committed by the engine.
            this.engine.setThreadMessages(thread.id, [{ role: 'system', content: briefKey }]);
            this.engine.setThreadLabel(thread.id, `${this.storyId}:${spec.phase}:${spec.label}`);

            const answer: HarnessAssistantMessage = await this.engine.sendThreadInput(thread.id, spec.kickoff, {
                ...(spec.signal === undefined ? {} : { signal: spec.signal })
            });

            run.answer = answer.content;
            run.state = 'torn_down';

            return { text: answer.content, turns: run.turns };
        } catch (error) {
            const aborted =
                spec.signal?.aborted === true || (error as { name?: string } | undefined)?.name === 'AbortError';

            run.state = aborted ? 'abandoned' : 'failed';
            run.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);

            throw run.lastError ?? error;
        } finally {
            run.endedAt = Date.now();

            // THE BRIEF STAYS THE THREAD'S KEY AFTER THIS RUN RESOLVES (2026-11-23). A thread can
            // outlive the `sendThreadInput` call that started it: the engine's `context-compaction`
            // plugin ends a host turn on its own SUMMARY and immediately continues the conversation
            // with a continuation nudge as a SECOND run on the SAME thread. That turn's stream
            // request carries the same seeded brief, so deleting the mapping here made the harness
            // answer "the writer harness received a request whose brief names no Storyline Run" and
            // the Author's Writer thread died exactly as it reached its context limit. The mapping is
            // dropped with the thread instead (`prune`), which is the only point at which no request
            // can arrive on it.

            // The engine caps a harness at MAX_THREAD_RECORDS. Storyline keeps only the live
            // indicator and the book's own audit, so old terminal threads are dropped before the
            // cap can refuse the next dispatch.
            if (this.runs.size > 128) this.prune();

            // The retained record is written after every path, including a failure: the Author
            // reads "why did this thread end" on the same bar the request is on.
            this.threadLog.append(this.recordOf(run));
        }
    }

    /**
     * Appends one live step to a running thread, bounded to the newest {@link MAX_ACTIVITY_STEPS}
     * and to {@link ACTIVITY_LINE_LIMIT} characters. The returned entry is mutable so a tool call
     * can turn "running…" into its answer without a second row.
     */
    private noteActivity(run: EngineRun, text: string): StoryThreadActivity {
        const entry: StoryThreadActivity = { at: new Date().toISOString(), text: activityLine(text) };

        run.activity.push(entry);

        if (run.activity.length > MAX_ACTIVITY_STEPS) {
            run.activity.splice(0, run.activity.length - MAX_ACTIVITY_STEPS);
        }

        return entry;
    }

    /** One `EngineRun` as the retained bar record, with the Story title read from the book now. */
    private recordOf(run: EngineRun): StoryThreadRecord {
        const story = this.store.stories.get(run.storyId) as Story | undefined;
        const request = run.kickoff.length === 0 ? run.request : `${run.request}\n\n---\n\n${run.kickoff}`;

        return {
            thread_id: run.threadId,
            run_id: run.runId,
            story_id: run.storyId,
            story_title: story?.title ?? run.storyId,
            phase: run.phase,
            role: run.roleKind,
            role_name: run.roleName,
            title: run.title,
            state: run.state,
            started_at: new Date(run.startedAt).toISOString(),
            ...(run.endedAt === undefined ? {} : { ended_at: new Date(run.endedAt).toISOString() }),
            tokens: run.tally.tokens,
            request,
            answer: run.answer,
            ...(run.error === undefined ? {} : { error: run.error }),
            // U-8: the live steps exist only while the thread runs. A closed thread is judged
            // on its request and answer, and the retained JSONL never needs the step feed.
            ...(run.endedAt === undefined && run.activity.length > 0
                ? { activity: run.activity.map((entry) => ({ ...entry })) }
                : {}),
            retained: true
        };
    }

    /** Every thread this Story ever ran, oldest first (the employee thread surface, R15/U-8). */
    threads(): StoryThreadRecord[] {
        return [...this.history.values()]
            .sort((left, right) => left.startedAt - right.startedAt || left.threadId.localeCompare(right.threadId))
            .map((run) => this.recordOf(run));
    }

    /** True while any thread in this Story's harness is running. */
    active(): boolean {
        return [...this.runs.values()].some((run) => run.endedAt === undefined);
    }

    /**
     * The journaled Run id each LIVE engine thread of this harness belongs to, with the employee
     * kind it runs as. `StoryHarnessManager.statuses` needs exactly this to keep a Run from being
     * counted twice — once as its thread and once as its row. The identity is the thread's
     * `run_id`: the parent row's id itself for a single-agent run, a panel agent and a delegate
     * (all three pass `runId: runId`, see `executor.ts`), and a `<run_id>#<role>` sub-label
     * wherever a thread record names its parent that way. `api/projections.ts:agentThreads` dedups
     * the thread LIST with the same `run_id.split('#')[0]` identity, so the two surfaces count the
     * same execution (R1) — the split is what makes a sub-labelled thread cover its parent row too.
     */
    liveRunRefs(): Array<{ kind: RoleKind; runId: string }> {
        return [...this.runs.values()]
            .filter((run) => run.endedAt === undefined)
            .map((run) => ({ kind: run.roleKind, runId: run.runId }));
    }

    /** The status projection for this Story's employees and their live threads. */
    statuses(): StoryAgentStatus[] {
        const story = this.store.stories.get(this.storyId) as Story | undefined;
        const title = story?.title ?? this.storyId;

        return STORY_AGENT_CATALOGUE.map((entry) => {
            const working = [...this.runs.values()]
                .filter((run) => run.roleKind === entry.kind && run.endedAt === undefined)
                .sort((left, right) => left.startedAt - right.startedAt)
                .map((run) => ({
                    story_id: this.storyId,
                    story_title: title,
                    phase: run.phase,
                    role_name: run.roleName,
                    work_item: run.label,
                    thread_id: run.threadId,
                    started_at: run.startedAt
                }));

            const choice = agentModelFor(this.store, this.defaultModel, entry.kind);

            return {
                kind: entry.kind,
                title: entry.title,
                status: working.length > 0 ? 'running' : 'idle',
                rank: STORY_AGENT_RANKS[entry.kind],
                model: choice.model,
                model_source: choice.source,
                template_models: templateRoleModels(this.store, entry.kind),
                working,
                recent: recentRuns(this.store, entry.kind, this.storyId)
            };
        });
    }

    /** Drop terminal threads beyond the engine's per-harness record bound. */
    prune(keep = 64): void {
        const terminal = [...this.runs.values()]
            .filter((run) => run.endedAt !== undefined)
            .sort((left, right) => left.startedAt - right.startedAt);

        for (const run of terminal.slice(0, Math.max(0, terminal.length - keep))) {
            try {
                this.engine.deleteThread(run.threadId);
            } catch {
                // The engine refuses a thread that still has live work: a context-compaction
                // continuation can outlive the run that started it, and its tool calls and its
                // stream request both still resolve through this run. Keep every mapping until the
                // engine really drops the thread.
                continue;
            }

            this.runs.delete(run.threadId);

            // A pruned thread can receive no further request, so its brief key is safe to drop
            // (the run itself stays in `history` for the Author's thread surface).
            if (this.byBrief.get(run.briefKey) === run) this.byBrief.delete(run.briefKey);

            for (const session of this.sessions.values()) session.runs.delete(run.threadId);
        }
    }

    dispose(): void {
        try {
            this.engine.stopAllThreads('the Storyline server is closing');
            this.engine.dispose();
        } catch {
            // Teardown is best-effort; the Story book is the durable state (P1).
        }
    }
}

/** The order a phase session list is rendered in. */
const STORY_PHASE_ORDER: StoryPhase[] = ['summary', 'plotlines', 'chapters'];

// ---------------------------------------------------------------------------
// The run spec the executor/panel/delegate hand to the Story harness
// ---------------------------------------------------------------------------

export interface EngineRunSpec {
    storyId: string;
    phase: StoryPhase;
    label: string;
    /** The Run row this thread belongs to; defaults to `label` for a top-level run. */
    runId?: string;
    /** One line naming what this thread was asked to do (the thread bar's title). */
    requestTitle?: string;
    roleName: string;
    roleKind: RoleKind;
    model: string;
    system: string;
    kickoff: string;
    /** U-1e: the tool names this run may be offered; omitted means the whole catalogue. */
    tools?: ToolSchema[];
    runtime: ToolRuntime;
    context: RunToolContext;
    tally: RunTally;
    signal?: AbortSignal;
    heartbeat?: () => void;
    onReport?: (name: string) => void;
}

/**
 * The per-process Story harness registry. One harness instance per Story, shared by every Run
 * that Story causes; deleted with the process, never shared across a Story boundary.
 */
export class StoryHarnessManager {
    private readonly harnesses = new Map<string, StoryHarness>();
    private readonly options: StoryHarnessOptions;
    private readonly store: Store;

    constructor(options: StoryHarnessOptions) {
        this.options = options;
        this.store = options.store;
    }

    forStory(storyId: string): StoryHarness {
        let story = this.harnesses.get(storyId);

        if (story === undefined) {
            story = new StoryHarness(storyId, this.options);
            this.harnesses.set(storyId, story);
        }

        return story;
    }

    /** Run one employee thread for a Story's current phase (or the phase named on the spec). */
    run(spec: EngineRunSpec): Promise<LoopOutcome> {
        return this.forStory(spec.storyId).run(spec);
    }

    /**
     * Every thread one employee kind ever ran, across every Story harness this process owns,
     * oldest first. This is the content the employee tile opens — not a per-story live list.
     */
    threads(kind?: RoleKind): StoryThreadRecord[] {
        return [...this.harnesses.values()]
            .flatMap((story) => story.threads())
            .filter((record) => kind === undefined || record.role === kind)
            .sort(
                (left, right) =>
                    left.started_at.localeCompare(right.started_at) || left.thread_id.localeCompare(right.thread_id)
            );
    }

    /**
     * The global employee status projection across every Story harness this process owns.
     *
     * R1 — "running" has TWO live sources and both must count:
     *   - a live ENGINE thread inside some Story's harness (`StoryHarness.statuses`), and
     *   - a live journaled Run row (`loop/records.ts:isLiveRun` — `spawning|working|reporting`),
     *     which is the ONLY trace a run leaves while it has no engine thread: a `toolMode:'none'`
     *     structured run calls `chat.complete` directly (`run/executor.ts:runStructuredTurn`) and
     *     retains its thread record only in `execute`'s `finally`, and a tool run's row says
     *     `spawning` before its thread is even created. Before this reconciliation the tile read
     *     `idle` for exactly those runs while the thread panel showed the same Writer RUNNING.
     *
     * A run that has BOTH counts once: `mergeJournaledRuns` drops every row a live thread already
     * accounts for, and the roster order (catalogue order — §7.3's alphabetic sort is the route's)
     * and every other field stay exactly as the harness projected them (R3).
     */
    statuses(): StoryAgentStatus[] {
        const byKind = new Map<RoleKind, StoryAgentStatus>();

        for (const entry of STORY_AGENT_CATALOGUE) {
            // The model is a roster fact, not a per-Story thread fact, so a workspace with no
            // harness yet still answers what each employee would run (U-8).
            const choice = agentModelFor(this.store, this.options.defaultModel, entry.kind);

            byKind.set(entry.kind, {
                kind: entry.kind,
                title: entry.title,
                status: 'idle',
                rank: STORY_AGENT_RANKS[entry.kind],
                model: choice.model,
                model_source: choice.source,
                template_models: templateRoleModels(this.store, entry.kind),
                working: [],
                // Read from the journaled rows, not from a harness: after a restart there is no
                // harness to ask, and the failed run is exactly the thread the Author needs (S-3).
                recent: recentRuns(this.store, entry.kind)
            });
        }

        for (const story of this.harnesses.values()) {
            for (const status of story.statuses()) {
                const combined = byKind.get(status.kind);

                if (combined === undefined) continue;

                if (status.working.length > 0) {
                    combined.status = 'running';
                    combined.working.push(...status.working);
                }
            }
        }

        this.mergeJournaledRuns(byKind);

        return [...byKind.values()];
    }

    /**
     * Adds the live runs NO engine thread represents, so an employee whose work runs off-thread is
     * still `running` with the right thread count (R1), and turns the employee back to `idle` when
     * neither a thread nor a live row is left — the closed rows belong to `recent`, never here.
     *
     * Coverage uses the projections' identity per employee kind (the same scoping
     * `api/projections.ts:agentThreads` applies when it filters a kind's records): a row is skipped
     * when a live thread of that SAME kind names it, either exactly (`run_7`) or as a parent of a
     * sub-labelled thread (`run_7#agent_2`). A kind with no live thread keeps its row.
     *
     * Appended rows keep the `working` contract's oldest-first order and take the `run_row:` thread
     * id the projections already give a run-row thread, so a thread key never collides with an
     * engine thread id and a refetch is stable.
     */
    private mergeJournaledRuns(byKind: Map<RoleKind, StoryAgentStatus>): void {
        const covered = new Map<RoleKind, Set<string>>();

        for (const story of this.harnesses.values()) {
            for (const ref of story.liveRunRefs()) {
                const ids = covered.get(ref.kind) ?? new Set<string>();

                ids.add(ref.runId.split('#')[0]);
                covered.set(ref.kind, ids);
            }
        }

        // A legacy role kind is not on the roster tile, so its row has nothing to merge into (V-1).
        const rows = this.store.runs
            .list()
            .filter((run) => isLiveRun(run) && byKind.has(run.role) && !covered.get(run.role)?.has(run.id));

        rows.sort((left, right) => left.started_at.localeCompare(right.started_at) || left.id.localeCompare(right.id));

        for (const run of rows) {
            const status = byKind.get(run.role);

            if (status === undefined) continue;

            const story = this.store.stories.get(run.story_id) as Story | undefined;

            status.working.push({
                story_id: run.story_id,
                story_title: story?.title ?? run.story_id,
                // A run that is executing NOW belongs to the phase the Story is in. The work-item
                // name hints `api/projections.ts:legacyPhase` needs are only for the thread list's
                // pre-retention rows, which cannot ask the Story what phase it was in.
                phase: story?.phase ?? 'chapters',
                role_name: run.role,
                work_item: run.work_item_ref ?? run.id,
                thread_id: `run_row:${run.id}`,
                // `working` rows carry epoch-ms (an engine thread's `startedAt`); the journal's
                // clock is ISO 8601, so the row's timestamp is read into the same scale.
                started_at: Date.parse(run.started_at)
            });
            status.status = 'running';
        }
    }

    /** True when a Story has a harness, i.e. has ever dispatched work. */
    has(storyId: string): boolean {
        return this.harnesses.has(storyId);
    }

    /** Drop the engine state of a Story that no longer exists (backtrack never deletes a Story). */
    forget(storyId: string): void {
        const story = this.harnesses.get(storyId);

        if (story === undefined) return;

        story.dispose();
        this.harnesses.delete(storyId);
    }

    dispose(): void {
        for (const story of this.harnesses.values()) story.dispose();

        this.harnesses.clear();
    }

    /** The Store the manager binds tool contexts against (exposed for tests and diagnostics). */
    get book(): Store {
        return this.store;
    }
}

// ---------------------------------------------------------------------------
// The engine-backed loop runner
// ---------------------------------------------------------------------------

/**
 * Drop-in replacement for `runAgentLoop` that executes the same `LoopSpec` through the Story's
 * harness instead of the hand-written provider loop. The SPEC is unchanged on purpose: the
 * executor, panel and delegate all keep their existing accounting and permission behaviour.
 */
export async function runEngineAgent(
    manager: StoryHarnessManager,
    storyId: string,
    phase: StoryPhase,
    spec: LoopSpec,
    tally: RunTally,
    extra: { runtime: ToolRuntime; context: RunToolContext; heartbeat?: () => void; onReport?: (name: string) => void }
): Promise<LoopOutcome> {
    return manager.run({
        storyId,
        phase,
        label: spec.label,
        ...(spec.runId === undefined ? {} : { runId: spec.runId }),
        ...(spec.requestTitle === undefined ? {} : { requestTitle: spec.requestTitle }),
        roleName: spec.roleName ?? 'writer',
        roleKind: (spec.roleKind ?? 'writer') as RoleKind,
        model: spec.model,
        system: spec.system,
        kickoff: spec.kickoff,
        ...(spec.tools === undefined ? {} : { tools: spec.tools }),
        runtime: extra.runtime,
        context: extra.context,
        tally,
        signal: spec.signal,
        heartbeat: extra.heartbeat,
        onReport: extra.onReport
    });
}
