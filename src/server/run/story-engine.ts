// The Story runtime built on the @underload/harness ENGINE only.
//
// WHY THIS FILE EXISTS. A Story is a book, a Phase is a session against that book, and a Run is
// one thread inside the phase's session. The harness package owns the part that is the same for
// every host — the agent loop, the tool-call protocol, transcript commitment, retries and thread
// lifecycle — while Storyline owns everything that is specific to the Author: the book, the
// loop, the permission rows, the criteria and the phases. So Storyline builds ONE harness per
// Story with the same four agent profiles every story uses (writer, editor, reader, checker),
// and each dispatched Run opens a thread inside that story's harness.
//
// ISOLATION. Two stories never share a Harness instance, a tool registry, a transcript or a
// thread roster. The AGENT DEFINITIONS are shared values (the same kind, prompt and model), but
// their runtime state lives in the story's own harness, which is exactly the "same agent across
// multiple harnesses, no cross contamination" rule.
//
// SESSIONS. The harness engine itself is the execution loop; it has no session object. Storyline
// supplies that level: one Session record per Story phase, opened on first use and owning the
// threads its Runs create. A phase therefore groups its threads without any engine state crossing
// between stories.
//
// ENGINE ONLY. This module imports `@underload/harness` (agent/harness/tool and their types). It
// never imports `@underload/harness/server`, never starts a listener, and never uses the harness
// server's SessionStore: the Storyline server (`api/server.ts`) is the only server.
import { agent, harness, tool } from '@underload/harness';
import type {
    Agent,
    Harness,
    HarnessAssistantMessage,
    HarnessMessage,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest,
    HarnessToolCall,
    ToolContext
} from '@underload/harness';
import type { ChatClient, ChatMessage, ToolCall, ToolSchema } from '../llm';
import type { LoopOutcome, LoopSpec, RunTally } from './loop';
import { isReportTool } from './catalogue';
import { isProposedResult, type RunToolContext, type ToolRuntime } from './types';
import type { RoleKind, Story, StoryPhase } from '../../shared/types';
import type { Store } from '../store';

// ---------------------------------------------------------------------------
// The agent roster: the same four brains in every Story's harness
// ---------------------------------------------------------------------------

const STORY_AGENT_KINDS: readonly RoleKind[] = ['writer', 'editor', 'reader', 'checker'];

/** The single-property unwrap the harness applies before `execute` (tool()'s contract). */
const singlePropertyKey = (schema: Record<string, unknown> | undefined): string | undefined => {
    if (schema?.type !== 'object') return undefined;

    const properties = schema.properties;

    if (typeof properties !== 'object' || properties === null) return undefined;

    const keys = Object.keys(properties as Record<string, unknown>);

    return keys.length === 1 ? keys[0] : undefined;
};

/** One live Run's identity and the Storyline context its tool calls execute against. */
interface EngineRun {
    /** The engine agent key this run's brain and thread were built under. */
    agentKey: string;
    /** The engine thread id, once `createThread` has minted it. */
    threadId: string;
    storyId: string;
    phase: StoryPhase;
    roleKind: RoleKind;
    roleName: string;
    label: string;
    /** The tool runtime the engine calls execute through (a panel agent's is the intercepting one). */
    runtime: ToolRuntime;
    /** The Storyline context (story binding, role row, attribution). */
    context: RunToolContext;
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

/** The public status row a dashboard renders for one agent tile. */
export interface StoryAgentStatus {
    kind: RoleKind;
    title: string;
    status: 'idle' | 'running';
    /** Live threads across every Story, oldest first. */
    working: Array<{
        story_id: string;
        story_title: string;
        phase: StoryPhase;
        role_name: string;
        work_item: string;
        thread_id: string;
        started_at: number;
    }>;
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
            'The only agent that writes the book: the Summary in phase ①, plotlines in ②, chapters and prose in ③. Refused on locked artifacts.'
    },
    {
        kind: 'editor',
        title: 'Editor',
        description:
            'Chooses between competing drafts, verifies Ideas and findings, and writes no prose of its own.'
    },
    {
        kind: 'reader',
        title: 'Reader',
        description: 'Reads as an audience, rates what it reads, and proposes Ideas and findings. Never writes.'
    },
    {
        kind: 'checker',
        title: 'Checker',
        description: 'Judges criteria, files findings and tasks, and reports to the Author. Writes no artifacts.'
    }
];

/** A title for one kind, re-used by the route projection and the tests. */
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
    /** Brief system line -> run, so the transport can attribute a request to its thread. */
    private readonly byBrief = new Map<string, EngineRun>();

    constructor(private readonly storyId: string, options: StoryHarnessOptions) {
        this.store = options.store;
        this.chat = options.chat;
        this.runtime = options.runtime;
        this.defaultModel = options.defaultModel;

        const create = options.createHarness ?? harness;
        const agents: Record<string, Agent> = {};
        const ranks: Record<string, 'A'> = {};

        for (const kind of STORY_AGENT_KINDS) {
            agents[kind] = agent({ model: this.defaultModel, stream: this.streamFor(kind), retry: false });
            ranks[kind] = 'A';
        }

        // Every configured agent is Rank A so the ENGINE's own delegation rules never add a
        // peer this Story's template did not declare. The baseline row may still be installed;
        // `installDelegate` below makes the registry hold Storyline's §8 definition, which is the
        // only delegation door the Author's templates control (D-17e).
        this.catalogue = this.toolCatalogue();
        this.declaredSchemas = new Map(this.runtime.schemas().map((schema) => [schema.function.name, schema]));
        this.engine = create({
            agents,
            entry: 'writer',
            ranks,
            presets: false,
            builtinPlugins: [],
            toolCreation: false,
            tools: this.catalogue,
            knowledgeOwner: `storyline:${storyId}`
        });

        this.installDelegate();
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
                            error:
                                'this tool call arrived outside a Storyline thread, so there is no Story to bind (T-3)'
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
        if (run.signal?.aborted === true) return { ok: false, error: 'the run was stopped before this call started (P8)' };

        // U-1e: not merely hidden from the declaration list. A model that guesses a name the run
        // was not offered is refused here as well, so §7/§8.6's empty cell cannot be bypassed.
        if (!run.allowed.has(name)) {
            return { ok: false, error: `tool "${name}" is not offered to this run (U-1e)` };
        }

        const cursor = run.tally.executed.length;
        const result: Awaited<ReturnType<ToolRuntime['execute']>> = await run.runtime.execute(
            run.context,
            name,
            args
        );

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
                    // transcript the provider answers DOES carry them. The executor's mock reads
                    // the same field through this exact cast, so one shape serves both.
                    const projected = {
                        role: 'assistant' as const,
                        content: message.content
                    } as ChatMessage & { tool_calls?: HarnessToolCall[] };

                    if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
                        projected.tool_calls = message.toolCalls;
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
            .map((schema) => this.declaredSchemas.get(schema.name) ?? {
                type: 'function',
                function: {
                    name: schema.name,
                    description: schema.description,
                    parameters: schema.parameters ?? { type: 'object', properties: {} }
                }
            });
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
                yield { type: 'error', message: 'the run was stopped by the Author (P8)' };
                return;
            }

            let response;

            try {
                response = await this.chat.complete({
                    model: request.model,
                    messages: this.chatMessages(request.messages),
                    tools: this.toolSchemas(request, run),
                    signal: request.signal ?? run.signal
                });
            } catch (error) {
                if ((error as { name?: string } | undefined)?.name === 'AbortError') {
                    yield { type: 'error', message: 'the run was stopped by the Author (P8)' };
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
            }

            // S-6/E-0: tokens are informational, recorded on every provider turn the run caused.
            run.tally.tokens += (response.usage?.input ?? 0) + (response.usage?.output ?? 0);
            run.turns += 1;

            const content = response.message.content ?? '';

            if (content.length > 0) yield { type: 'text', delta: content };

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
     * Runs one agent turn in a fresh thread of the Story's harness. The caller supplies the
     * Storyline context, runtime and tally; this method owns only the engine part.
     */
    async run(spec: EngineRunSpec): Promise<LoopOutcome> {
        const story = this.store.stories.get(this.storyId) as Story | undefined;

        if (story === undefined) throw new Error(`Story "${this.storyId}" does not exist (T-3)`);

        const agentKey = spec.roleKind;
        const session = this.session(spec.phase);

        // The FOUR brains are the story's fixed roster (writer/editor/reader/checker), created
        // with the harness and shared by every Story that uses the same kinds. A Run opens a
        // THREAD on its kind's brain rather than minting a new one: agent identity is stable
        // across stories, while the transcript and the tool context stay thread-local.
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

        const run: EngineRun = {
            agentKey,
            threadId: thread.id,
            storyId: this.storyId,
            phase: spec.phase,
            roleKind: spec.roleKind,
            roleName: spec.roleName,
            label: spec.label,
            runtime: spec.runtime,
            context: spec.context,
            tally: spec.tally,
            heartbeat: spec.heartbeat,
            onReport: spec.onReport,
            signal: spec.signal,
            briefKey,
            // U-1e: an omitted list means the whole catalogue; an explicit list (an assistant run)
            // narrows what the model is offered and what it may call.
            allowed: new Set(spec.tools?.map((schema) => schema.function.name) ?? this.runtime.schemas().map((schema) => schema.function.name)),
            queue: Promise.resolve(),
            turns: 0,
            startedAt: Date.now()
        };

        this.runs.set(thread.id, run);
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

            return { text: answer.content, turns: run.turns };
        } catch (error) {
            throw run.lastError ?? error;
        } finally {
            run.endedAt = Date.now();
            this.byBrief.delete(briefKey);

            // The engine caps a harness at MAX_THREAD_RECORDS. Storyline keeps only the live
            // indicator and the book's own audit, so old terminal threads are dropped before the
            // cap can refuse the next dispatch.
            if (this.runs.size > 128) this.prune();
        }
    }

    /** True while any thread in this Story's harness is running. */
    active(): boolean {
        return [...this.runs.values()].some((run) => run.endedAt === undefined);
    }

    /** The status projection for this Story's live threads. */
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

            return {
                kind: entry.kind,
                title: entry.title,
                status: working.length > 0 ? 'running' : 'idle',
                working
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
                // A thread the engine already dropped is already pruned; nothing else is owed.
            }

            this.runs.delete(run.threadId);

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

    /** Run one agent thread for a Story's current phase (or the phase named on the spec). */
    run(spec: EngineRunSpec): Promise<LoopOutcome> {
        return this.forStory(spec.storyId).run(spec);
    }

    /** The global agent status projection across every Story harness this process owns. */
    statuses(): StoryAgentStatus[] {
        const byKind = new Map<RoleKind, StoryAgentStatus>();

        for (const entry of STORY_AGENT_CATALOGUE) {
            byKind.set(entry.kind, { kind: entry.kind, title: entry.title, status: 'idle', working: [] });
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

        return [...byKind.values()];
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
