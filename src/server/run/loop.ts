// The agentic loop — the one turn engine this build has, shared by the dispatched run, the
// D-38 panel's agents, and the D-17e delegate's sub-context.
//
// WHY ONE LOOP FOR ALL THREE: S-1 says a run is one thread for one job, D-17e says a
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
// THE ONE EXCEPTION IS THE CRITIC'S REVIEW PASS (C2-AD3), and it is a POLICY end, not a clock: a
// Critic run ends the moment its terminal report (`submitVerdict`) has FILED — meaning the tool
// ANSWERED, not merely that the model asked. A verdict the tool layer refused (T-1a) leaves the run
// its next turn, exactly as it does on the engine path, and the refusal is already in the transcript
// as that call's own message. A critic that filed a PARTIAL report (`raiseFinding`) and keeps reading
// gets one nudge, then the bounded review-turn cap. The rule lives in ./plugins/critic-termination
// for the shipped engine-backed path and is mirrored below for this hand-written loop, so a caller
// with no engine cannot get a different contract. Every other kind keeps E-0's unbounded loop
// untouched.
//
// THE RUN ENDS NATURALLY when the model returns a turn with no `tool_calls` (§9 "report →
// commit → teardown"): the model decides it is done, which is why the brief's etiquette section
// states S-4's obligation — a model that stops without reporting produces a no-op turn, and that
// is measured (S-4) rather than prevented.
import type { ChatClient, ChatMessage, ChatUsage, ToolCall, ToolSchema } from '../llm';
import { isAbortError } from '../llm';
import { isReportTool } from './catalogue';
import {
    CRITIC_ROLE_KIND,
    CRITIC_CONCLUDE_NUDGE,
    criticTurnCapFromEnvironment,
    isTerminalCriticReport
} from './plugins/critic-termination';
import { isProposedResult, type RunToolContext, type ToolResult, type ToolRuntime } from './types';
import type { RoleKind, StoryPhase } from '../../shared/types';

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
     * The engine-backed runner. When present, `runAgentLoop` delegates the whole model/tool loop
     * to it (the Story's harness) and keeps this file's legacy loop only as the unit-test path.
     */
    runAgent?: (deps: LoopDeps, spec: LoopSpec, tally: RunTally) => Promise<LoopOutcome>;
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
    /** The Run row this thread belongs to (a panel agent's own label is not the parent's id). */
    runId?: string;
    /** One line naming what this thread was asked to do (the thread bar's title). */
    requestTitle?: string;
    /** The assembled brief (S-2) — the run's whole memory, sent as the system turn. */
    system: string;
    /** The ask (S-2's job, restated as an instruction). */
    kickoff: string;
    model: string;
    context: RunToolContext;
    /** T-3: the Story this run is bound to (the engine harness is selected by it). */
    storyId?: string;
    /** The phase session this run's thread belongs to. */
    phase?: StoryPhase;
    /** The template role that produced this run (attribution and the crew rail). */
    roleName?: string;
    /** §4.12 role kind, which selects the brief and the permission row. */
    roleKind?: RoleKind;
    /**
     * U-1e: the tools this session declares, when the caller has narrowed the catalogue. Omitted
     * means T-6a's default — the whole catalogue on every session. The Author-invoked assistant
     * run is the case this exists for: §7 and §8.6 give it no web, so its session must not carry
     * `searchWeb`/`fetchPage` even when the model would happily advertise them (§7's column, U-1e).
     */
    tools?: ToolSchema[];
    /**
     * C2-AD3: the review-turn bound for a `critic` run on THIS loop. Omitted means
     * {@link criticTurnCapFromEnvironment} — the same default the shipped plugin reads, so both
     * paths agree unless a host narrowed one. The engine-backed path cannot take it per run (its
     * plugin is built with the Story harness), so `runEngineAgent` ignores this field and the
     * harness-level cap in force there decides.
     */
    criticTurnCap?: number;
    signal?: AbortSignal;
}

/**
 * How a run that ended EARLY ended, in the run's own words (C2-AD3). It exists because the ordinary
 * `LoopOutcome` says nothing about WHY the loop stopped, and the run row must not claim "the model
 * returned no tool call" for a Critic pass that was ended by its own filed report.
 *
 *   - `reported` — it filed its terminal report, and the pass ended on that turn. A completed
 *     result, not a kill and not a failure: the verdict is in the book.
 *   - `capped` — the review-turn cap caught it before it filed its verdict. Honest wording only:
 *     the findings it did file stand, and the row says the verdict is missing.
 */
export interface RunEndCause {
    kind: 'reported' | 'capped';
    /** Model turns this pass really issued. */
    turns: number;
    /** The bound that was in force when the pass ended. */
    cap: number;
    /** Every report tool it FILED, in call order (S-4's classification). A refusal is not here. */
    reports: string[];
    /**
     * Every report tool it called and the tool layer REFUSED (`{ ok: false }`, T-1a). Omitted when the
     * pass was never refused. This is the third state the run row has to keep: `reports: []` alone
     * reads "never answered", and a pass whose verdict was refused and never fixed answered and lost.
     */
    refusals?: string[];
    /** The terminal tool name, present for a `reported` end. */
    terminal_tool?: string;
}

export interface LoopOutcome {
    /** The model's final text — the delegate's `summary` (D-17e) and the panel's reported answer. */
    text: string;
    /** Turns asked of the provider, for the tests that pin "the run asked twice". */
    turns: number;
    /**
     * Absent for every run that ended the way it always has — the natural no-tool-call turn, a
     * panel, a structured turn. Present only when the Critic policy ended the pass early.
     */
    endCause?: RunEndCause;
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
    // The shipped server always supplies this: the Story's own harness executes the loop. The
    // hand-written loop below remains the deterministic unit-test path and the fallback for a
    // caller that has no engine (a bare `run/loop.test.ts` harness).
    if (deps.runAgent !== undefined) return deps.runAgent(deps, spec, tally);

    const { chat, runtime } = deps;

    // The brief IS the history (S-2: "a run has no memory of any prior run"), so the
    // conversation starts from the assembled text and nothing else.
    const messages: ChatMessage[] = [
        { role: 'system', content: spec.system },
        { role: 'user', content: spec.kickoff }
    ];

    let turns = 0;

    // C2-AD3 — the Critic review policy for THIS fallback loop, mirroring
    // ./plugins/critic-termination: terminal report → stop now; partial report → one nudge; no
    // verdict by the cap → stop and say so. Gated on the kind, so every other role never reads a
    // line of it.
    const isCriticPass = spec.roleKind === CRITIC_ROLE_KIND;
    const reviewCap = spec.criticTurnCap ?? criticTurnCapFromEnvironment();
    // What the pass has FILED, what it called and had REFUSED, and how many times it has been nudged.
    const filedReports: string[] = [];
    const refusedReports: string[] = [];
    // THE NUDGE IS A REQUEST, NOT A MESSAGE. The engine path injects it through a `turn.before`
    // transcript override that reaches one request and is never committed; this loop owns its own
    // transcript, so pushing the line into `messages` would re-lecture the model on every later turn
    // (measured: the same instruction in 3 consecutive requests of one pass). Arming the flag puts it
    // in exactly the NEXT request, and `criticNudges` bounds the arming to once per run — so both
    // paths show the model the instruction at most once (objective 5).
    let criticNudges = 0;
    let criticNudgePending = false;

    for (;;) {
        // Checked before the dial, not only inside the transport: a kill that lands between two
        // turns must not spend another request (P8 — "the Author can always pull the cord").
        throwIfAborted(spec.signal);

        // The history the model is asked to answer THIS turn: the committed transcript, plus the one
        // nudge if it was armed after the last turn. `messages` itself never gains the line.
        const requestMessages: ChatMessage[] = criticNudgePending
            ? [...messages, { role: 'user', content: CRITIC_CONCLUDE_NUDGE }]
            : messages;

        criticNudgePending = false;

        const response = await chat.complete({
            model: spec.model,
            messages: requestMessages,
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

        // C2-AD3: the terminal report this turn filed, if any. Reset per turn so a call the model
        // only THOUGHT it filed (a malformed payload, below) never ends the pass.
        let filedTerminalTool: string | undefined;

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

            if (reachedTool && isReportTool(call.name) && !isProposedResult(result) && result.ok !== false) {
                // S-4's "did this run report anything" is about what LANDED. A refusal filed nothing,
                // so it must not clear the run's `no_op` flag, and the row must not move to
                // `reporting` on a call the tool layer turned away (`run/executor.ts:631` reads this
                // list, and the loop engine's seat-owed decision reads the row).
                if (!tally.reports.includes(call.name)) deps.onReport?.(call.name);

                tally.reports.push(call.name);
            }

            // C2-AD3 — the Critic policy counts a report the call DELIVERED, and a refusal is not a
            // delivery. The engine's plugin now decides the same way, from the `ToolResult` the host's
            // tool bridge hands it, because neither `turn.after`'s committed `tool_calls` nor the
            // harness's `tool.after` outcome can see a `{ ok: false }` refusal: the request to file is
            // not the filing. A D-38 PROPOSAL is a delivery — the agent was told its write is recorded
            // and the run aggregates it later — so a critic panel member still ends on its proposal
            // here exactly as it does on the engine path. Only a call that never reached the tool
            // layer (T-11's malformed payload) and a refusal leave the pass its next turn.
            if (isCriticPass && reachedTool && isReportTool(call.name)) {
                if (result.ok === false) {
                    if (!refusedReports.includes(call.name)) refusedReports.push(call.name);
                } else {
                    if (!filedReports.includes(call.name)) filedReports.push(call.name);

                    if (isTerminalCriticReport(call.name)) filedTerminalTool = call.name;
                }
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

        // C2-AD3 — the three Critic rules, in precedence order, taken AFTER the turn's tools ran so
        // the filed report is already in the book when the pass ends. A non-critic never reaches any
        // of this and keeps looping to its natural end.
        if (isCriticPass) {
            // 1. Its verdict FILED: the review pass is over, and this is a completed result — no
            //    further model turn (objective 1). `turn.content` is the prose it said while filing.
            if (filedTerminalTool !== undefined) {
                return {
                    text: turn.content,
                    turns,
                    endCause: {
                        kind: 'reported',
                        turns,
                        cap: reviewCap,
                        reports: [...filedReports],
                        ...(refusedReports.length === 0 ? {} : { refusals: [...refusedReports] }),
                        terminal_tool: filedTerminalTool
                    }
                };
            }

            // 2. The review-turn cap. Honest wording on the row, `capped` and not `reported`: the
            //    verdict never arrived, and the findings it did file are all this pass produced. A
            //    verdict it filed and had REFUSED is named in `refusals`, because "never answered" and
            //    "answered and refused" are different facts for the Author and for the seat.
            if (turns >= reviewCap) {
                return {
                    text: turn.content,
                    turns,
                    endCause: {
                        kind: 'capped',
                        turns,
                        cap: reviewCap,
                        reports: [...filedReports],
                        ...(refusedReports.length === 0 ? {} : { refusals: [...refusedReports] })
                    }
                };
            }

            // 3. One nudge, once, and only because a report SUCCEEDED (objective 2). A refusal is not
            //    here on purpose: the refusal is already in the transcript as this turn's tool message
            //    and is the instruction the model actually has to answer.
            if (filedReports.length > 0 && criticNudges === 0) {
                criticNudges += 1;
                criticNudgePending = true;
            }
        }
    }
}

/** Whether a thrown value means "someone stopped this run" rather than "it broke" (S-3, P8). */
export const wasAborted = (error: unknown, signal?: AbortSignal): boolean =>
    isAbortError(error) || signal?.aborted === true;
