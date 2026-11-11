// The agentic loop — the one turn engine this build has, shared by the dispatched run, the
// D-38 panel's agents, and the D-17e delegate's sub-context.
//
// WHY ONE LOOP FOR ALL THREE: S-1 says a run is one session for one job, D-17e says a
// delegated sub-context is the same thing minus the Work Item, and D-38 says a panel is N of
// them inside one run. Any separate implementation of "call the model, run its tools, feed the
// results back" would drift on the parts that matter most: how a tool result is serialised,
// how an abort surfaces, and how tokens are counted.
//
// NO ITERATION CAP (E-0, S-4a) — deliberately: "there is no timeout on a run and no retry cap.
// A run that takes four hours is fine. A run that hangs is detected by lease expiry, not by a
// clock". The guard is therefore the heartbeat this loop fires after every tool call
// ({@link LoopDeps.heartbeat}): the loop engine reads `runs.updated_at` as the lease, so a long
// run is fine while it keeps calling tools and a hung one lapses (S-4a, L-2). Adding a cap here
// would be the exact thing E-0 forbids.
//
// THE RUN ENDS NATURALLY when the model returns a turn with no `tool_calls` (§9 "report →
// commit → teardown"): the model decides it is done, which is why the brief's etiquette section
// states S-4's obligation — a model that stops without reporting produces a no-op turn, and that
// is measured (S-4) rather than prevented.
import type { ChatClient, ChatMessage, ChatUsage, ToolCall, ToolSchema } from '../llm';
import { isAbortError } from '../llm';
import { isReportTool } from './catalogue';
import { isProposedResult, type RunToolContext, type ToolResult, type ToolRuntime } from './types';

/**
 * Everything the run counted and called, accumulated IN PLACE so a throw halfway through does
 * not lose it. This is why the loop takes a tally instead of only returning one: S-6 wants the
 * run row's `tokens` even for a run that failed, and S-4 wants `no_op` for a run that was
 * killed, so both numbers have to survive the exception path.
 */
export interface RunTally {
    /** Sum of ChatUsage across EVERY turn this run caused — its own, its panel's, its delegates' (S-6). */
    tokens: number;
    /** Tools whose execution really happened, in call order. An intercepted D-38 proposal is not here. */
    executed: string[];
    /** The subset that are report tools (S-4) — empty means the run is a no-op turn. */
    reports: string[];
}

export const createTally = (): RunTally => ({ tokens: 0, executed: [], reports: [] });

/** An assistant turn carrying its tool calls. `ChatMessage` has no `tool_calls` field, so this names it. */
type AssistantTurn = ChatMessage & { tool_calls?: ToolCall[] };

export interface LoopDeps {
    chat: ChatClient;
    runtime: ToolRuntime;
    /**
     * Fired after EVERY tool call, executed or intercepted — this is the lease heartbeat
     * (S-4a), and it must fire for a panel agent's intercepted proposal too: the run is still
     * working, so the lease must not lapse while its panel reads (D-38).
     */
    heartbeat?: () => void;
    /**
     * Fired the first time a report tool EXECUTES, so the run row can move to `reporting`
     * (§4.13) while the commit is still happening — the crew panel's "what it is doing" (U-7).
     */
    onReport?: (name: string) => void;
}

export interface LoopSpec {
    /** Whose loop this is, for diagnostics in a thrown error (`run_7`, `run_7#agent_2`). */
    label: string;
    /** The assembled brief (S-2) — the run's whole memory, sent as the system turn. */
    system: string;
    /** The ask (S-2's job, restated as an instruction). */
    kickoff: string;
    model: string;
    context: RunToolContext;
    /**
     * U-1e: the tools this session declares, when the caller has narrowed the catalogue. Omitted
     * means T-6a's default — the whole catalogue on every session. The Author-invoked assistant
     * run is the case this exists for: §7 and §8.6 give it no web, so its session must not carry
     * `searchWeb`/`fetchPage` even when the model would happily advertise them (§7's column, U-1e).
     */
    tools?: ToolSchema[];
    signal?: AbortSignal;
}

export interface LoopOutcome {
    /** The model's final text — the delegate's `summary` (D-17e) and the panel's reported answer. */
    text: string;
    /** Turns asked of the provider, for the tests that pin "the run asked twice". */
    turns: number;
}

/** Adds one turn's usage to the tally. `usage` is absent when the provider sent none (S-6). */
function addUsage(tally: RunTally, usage?: ChatUsage): void {
    // E-0/S-6: recorded, never read as a limit — nothing in this loop branches on the number.
    tally.tokens += (usage?.input ?? 0) + (usage?.output ?? 0);
}

/** Throws the signal's own reason, so an Author Stop surfaces as the cancellation it is (P8, S-3). */
function throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;

    const reason = signal.reason;

    if (reason === undefined) {
        const synthesised = new Error('run aborted');
        synthesised.name = 'AbortError';

        throw synthesised;
    }

    throw reason;
}

/**
 * `arguments` is a JSON string on the wire (the OpenAI shape the client normalises to). A bad
 * payload is a tool-call failure the MODEL sees and can correct, not a run failure — T-11 puts
 * the schema check in the tool layer for exactly this reason, and a fresh context that gets a
 * naming error in the result fixes it in place instead of ending the run.
 */
function decodeArguments(call: ToolCall): { args: Record<string, unknown> } | { error: string } {
    if (call.arguments.trim() === '') return { args: {} };

    try {
        const parsed: unknown = JSON.parse(call.arguments);

        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return {
                error: `arguments must be a JSON object of the tool's fields (got ${Array.isArray(parsed) ? 'an array' : typeof parsed}) — T-11`
            };
        }

        return { args: parsed as Record<string, unknown> };
    } catch (error) {
        return {
            error: `arguments were not valid JSON (${error instanceof Error ? error.message : String(error)}) — T-11`
        };
    }
}

/**
 * Runs one agent loop to its natural end. Throws on abort (the caller turns that into
 * `abandoned`, S-3) and on any transport/store fault (the caller turns that into `failed`).
 */
export async function runAgentLoop(deps: LoopDeps, spec: LoopSpec, tally: RunTally): Promise<LoopOutcome> {
    const { chat, runtime } = deps;

    // The brief IS the history (S-2: "a run has no memory of any prior run"), so the
    // conversation starts from the assembled text and nothing else.
    const messages: ChatMessage[] = [
        { role: 'system', content: spec.system },
        { role: 'user', content: spec.kickoff }
    ];

    let turns = 0;

    for (;;) {
        // Checked before the dial, not only inside the transport: a kill that lands between two
        // turns must not spend another request (P8 — "the Author can always pull the cord").
        throwIfAborted(spec.signal);

        const response = await chat.complete({
            model: spec.model,
            messages,
            // T-6a/T-6: the whole catalogue is declared on every session, so a fresh context
            // sees its tools on turn one and never pays a discovery round trip.
            tools: spec.tools ?? runtime.schemas(),
            signal: spec.signal
        });

        turns += 1;
        addUsage(tally, response.usage);

        const { message } = response;
        const toolCalls = message.tool_calls ?? [];

        if (toolCalls.length === 0) {
            // The run's natural end: no tool call means the model considers the job reported.
            return { text: message.content ?? '', turns };
        }

        // An assistant turn that only carries tool_calls has `content: null` on the wire, which
        // the transport omits; the history must still hold a string (the NOTE the client author
        // pins), so `?? ''` and never `undefined`.
        const turn: AssistantTurn = { role: 'assistant', content: message.content ?? '' };

        turn.tool_calls = toolCalls;
        messages.push(turn);

        for (const call of toolCalls) {
            const decoded = decodeArguments(call);
            let result: ToolResult;
            // A call whose arguments never parsed never reached the tool layer at all, so it is
            // neither an execution (S-4's `toolsCalled`) nor a report — and the run's no-op flag must
            // not be cleared by a call that could not run (T-11).
            let reachedTool = false;
            // Where this call's entries start. `delegate` answers from INSIDE the tool call by
            // merging its sub-context's executed names into this same tally (D-17e, executor.delegate),
            // so without this cursor the inner calls would sort ahead of the call that caused them and
            // `toolsCalled` would stop being call order (RunResult's pinned contract for T6).
            const tallyCursor = tally.executed.length;

            if ('error' in decoded) {
                result = { ok: false, error: decoded.error };
            } else {
                result = await runtime.execute(spec.context, call.name, decoded.args);
                reachedTool = true;
            }

            // AFTER every tool call: the lease heartbeat (S-4a). Not debounced and not
            // conditional — the tool call IS the evidence of life, and a hung run stops
            // producing them. A malformed payload counts too: the model is still talking.
            deps.heartbeat?.();

            if (reachedTool && isReportTool(call.name) && !isProposedResult(result)) {
                if (!tally.reports.includes(call.name)) deps.onReport?.(call.name);

                tally.reports.push(call.name);
            }

            if (reachedTool && !isProposedResult(result)) {
                // Anything the call merged in (a sub-context's calls) goes AFTER the call itself, so
                // the list reads as the sequence of causes, not as whichever tally push won the race.
                const merged = tally.executed.splice(tallyCursor, tally.executed.length - tallyCursor);

                tally.executed.push(call.name, ...merged);
            }

            messages.push({
                role: 'tool',
                // The whole result object, so T-4's `currents` and T-8's read revision reach the
                // model rather than being summarised away here.
                content: JSON.stringify(result),
                tool_call_id: call.id
            });
        }
    }
}

/** Whether a thrown value means "someone stopped this run" rather than "it broke" (S-3, P8). */
export const wasAborted = (error: unknown, signal?: AbortSignal): boolean =>
    isAbortError(error) || signal?.aborted === true;
