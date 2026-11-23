// W5's spawner half: `RunExecutor` — one Work Item in, one closed run row out.
//
// VOCABULARY (V-1). The Work Item names a template role, which names an EMPLOYEE kind (Writer,
// Editor, Reader, Checker). The executor opens one THREAD on that employee's engine profile; the
// employee is an agent only for that thread's life. A panel's N agents (D-38) and a delegate's
// sub-context (D-17e) are additional agents inside the same thread, never additional employees,
// and neither opens a Work Item.
//
// WHAT THIS FILE OWNS (§9): the run row's whole life (S-1: spawn → work → report → teardown),
// the unconditional teardown (S-3), the no-op accounting (S-4), the lease heartbeat (S-4a), the
// Author's cord (P8 / U-7 kill), the delegated sub-context (D-17e / T-2b / S-7) and the panel
// (D-38). What it does NOT own: the queue and the lease themselves (W5's sweep claims Work Items
// and reads `updated_at`), the tools (T3), the loop's status machine (W4), and the brief's
// content (./brief, S-2).
//
// WHY THE RUN ROW EXISTS FROM BEFORE THE FIRST TOKEN (D-18): the crew panel is a list of thread
// rows, and the Author's Stop has to have something to point at. So the row is created in
// `spawning` first, moves to `working` when the brief is in hand, to `reporting` when the first
// report tool lands (§9's report step), and to its end state exactly once — in `finally`, which
// is the mechanical form of S-3's "teardown is unconditional, including on failure, timeout and
// Author stop. No orphan threads."
//
// WHY THERE IS NO TIMEOUT AND NO CAP HERE (E-0, S-4a): the only guard is the lease, and the
// lease is `runs.updated_at`, refreshed after every tool call by {@link heartbeat}. A four-hour
// run is fine while it keeps calling tools; a hung run stops refreshing and lapses (L-2), and
// the sweep re-adopts or abandons it (L-3).
import { LlmError, type ChatClient, type ChatMessage, type ToolSchema } from '../llm';
import { parseStructuredContent } from '../llm/structured';
import { type RoleAggregation, type RoleKind, type Run, type RunDelegation, type Story } from '../../shared/types';
import { type Store, type UpdatePatch } from '../store';
import { runModelFor } from './agent-models';
import { buildBrief, type AssembledBrief } from './brief';
import { isReportTool, REPORT_TOOLS, toolsForRunKind } from './catalogue';
import { genericReasonerPrompt, resolveHarness, kickoffLine, type ResolvedHarness } from './harness';
import { createTally, runAgentLoop, wasAborted, type RunTally } from './loop';
import { type PanelOutcome, runPanel } from './panel';
import { compileSamplePrompt, compileScreenPrompt, type CompiledPrompt } from './phase1-prompt';
import { runEngineAgent, StoryHarnessManager } from './story-engine';
import { resolveAggregation } from './types';
import type { StoryThreadLog, StoryThreadRecord, StoryThreadState } from './thread-log';
import {
    type RunExecutorDeps,
    type RunResult,
    type RunToolContext,
    type RunToolHooks,
    type RunToolSession,
    type ToolRuntime,
    type ToolResult,
    type WorkItem
} from './types';

/** A run row that this executor has taken ownership of, with everything the loop needs in one bag. */
interface RunScope {
    runId: string;
    item: WorkItem;
    harness: ResolvedHarness;
    model: string;
    /** The executor-owned signal: aborted by `kill`, or linked to the caller's (lease expiry, Story stop). */
    controller: AbortController;
    tally: RunTally;
    /** The run's own tool context — the identity every executed write is attributed to (P11, D-38). */
    context: RunToolContext;
    /**
     * The assembled brief (S-2), present for every tool-carrying run. A `toolMode: 'none'` run has
     * no brief: its whole memory is the compiled Phase-1 prompt (./phase1-prompt), and assembling
     * a tool-oriented brief would only put text the model never sees into the bookkeeping.
     */
    briefing?: AssembledBrief & { hash: string };
    agents: number;
    aggregate: RoleAggregation;
    /**
     * U-1e: the tool list this run is OFFERED, computed once from the runtime's catalogue and the
     * Work Item's kind (§7's table — an `assistant` run has no web row, so it never sees
     * `searchWeb`/`fetchPage`). The same list goes to the loop, the panel's agents and every
     * delegate, because a sub-context inherits what its run may do (T-2b).
     */
    tools: ToolSchema[];
    /** True for §8.6's Author-invoked run — every write it makes records `assistant: true` (§2). */
    assistant: boolean;
}

/** §4.13's `end_reason` for a natural end — the row records WHY it ended (S-3). */
const END_COMPLETED = 'completed — the model returned no tool call and the run reported';

/**
 * §4.13's `end_reason` for a `toolMode: 'none'` run. It is a different sentence on purpose: a
 * structured run never "returned no tool call and reported" — it was given no tool to call, and
 * its single schema-validated answer is what the engine persists (§2 decision 2).
 */
const END_STRUCTURED = 'completed — one structured turn, validated against the response schema (§4.2)';

/**
 * How many provider calls a no-tool run may make. TWO is the whole budget the design allows:
 * one answer plus at most ONE schema-repair retry (§4.2, §2's "at most one schema-repair
 * retry"). A run that is still invalid after the retry FAILS — never a second repair.
 */
const STRUCTURED_ATTEMPTS = 2;

/**
 * Why a live run was aborted. The Author's cord is only ONE of the ways a run stops being its
 * own (P8): the sweep also kills a Story's crew when the Story is stopped or paused (D-37), a
 * directive that changes the book out from under a run (L-24), a Story delete (P1), and a lease
 * that lapsed (S-4a). Naming the cause is what stops the UI from telling the Author that they
 * pulled a cord they never touched.
 */
type RunKillReason = 'author' | 'lease' | 'stop' | 'directive' | 'delete';

/** The abort sentence and the closed row's `end_reason`, one per cause. */
const ABORT_TEXT: Record<RunKillReason, { abort: string; end: string }> = {
    author: {
        abort: 'killed by the Author (P8, U-7)',
        end: 'killed — the Author pulled the cord (P8, U-7)'
    },
    lease: {
        abort: 'abandoned — the lease lapsed (S-4a, D-36)',
        end: 'abandoned — the lease lapsed (S-4a, D-36)'
    },
    stop: {
        abort: 'abandoned — the Story was stopped (P8, D-37)',
        end: 'abandoned — the Story was stopped (P8, D-37)'
    },
    directive: {
        abort: 'abandoned — a directive changed the book under it (P8, L-24)',
        end: 'abandoned — a directive changed the book under it (P8, L-24)'
    },
    delete: {
        abort: 'abandoned — the Story was deleted (P1)',
        end: 'abandoned — the Story was deleted (P1)'
    }
};

/**
 * The one-line request a thread bar shows. The sweep's note is the most specific thing the
 * Author wrote; otherwise the job kind and the unit it names are the honest summary. The full
 * brief (the actual request) is retained separately by the Story harness.
 */
const requestTitleOf = (item: WorkItem): string => {
    const note = (item.note ?? '').trim();

    if (note.length > 0) return note;

    const unit = item.unit === undefined ? '' : ` ${item.unit.kind} ${item.unit.ref}`;

    return `${item.kind}${unit}`;
};

export class RunExecutor {
    private readonly store: Store;
    private readonly runtime: ToolRuntime;
    private readonly chat: ChatClient;
    private readonly defaultModel: string;
    /**
     * The per-Story engine harnesses. Built lazily on the first run, because a test rig wires the
     * executor's chat/runtime by `Object.assign` after construction (and the manager must see the
     * real pair, not the placeholders).
     */
    private harnessInstance: StoryHarnessManager | undefined;
    private readonly injectedHarness: StoryHarnessManager | undefined;
    /** Every thread's request + answer, retained beyond the process (see thread-log.ts). */
    private readonly threadLog: StoryThreadLog | undefined;

    /** Live runs this instance owns, so `kill(runId)` has something to abort (P8, U-7). */
    private readonly controllers = new Map<string, AbortController>();
    /** Live runs that were aborted, with the cause, so teardown names the real reason (S-3). */
    private readonly killed = new Map<string, RunKillReason>();

    constructor(deps: RunExecutorDeps) {
        this.store = deps.store;
        this.runtime = deps.runtime;
        this.chat = deps.chat;
        this.defaultModel = deps.defaultModel;
        this.injectedHarness = deps.harness;
        this.threadLog = deps.threadLog;
    }

    /** The manager over the CURRENT store/runtime/chat pair (late-bound for the test rig). */
    get harness(): StoryHarnessManager {
        if (this.injectedHarness !== undefined) return this.injectedHarness;

        if (this.harnessInstance === undefined) {
            this.harnessInstance = new StoryHarnessManager({
                store: this.store,
                runtime: this.runtime,
                chat: this.chat,
                defaultModel: this.defaultModel,
                ...(this.threadLog === undefined ? {} : { threadLog: this.threadLog })
            });
        }

        return this.harnessInstance;
    }

    /**
     * The engine-backed loop runner. The spec is the SAME one the hand-written loop took, so the
     * panel, delegate, tally and permission behaviour are unchanged; only the loop owner moved
     * into the Story's harness.
     */
    private readonly runAgent = (
        deps: import('./loop').LoopDeps,
        spec: import('./loop').LoopSpec,
        tally: RunTally
    ): Promise<import('./loop').LoopOutcome> => {
        if (spec.storyId === undefined) {
            throw new Error('an engine-backed run must name the Story it is bound to (T-3)');
        }

        return runEngineAgent(this.harness, spec.storyId, spec.phase ?? 'chapters', spec, tally, {
            runtime: deps.runtime,
            context: spec.context,
            ...(deps.heartbeat === undefined ? {} : { heartbeat: deps.heartbeat }),
            ...(deps.onReport === undefined ? {} : { onReport: deps.onReport })
        });
    };

    // -------------------------------------------------------------------------
    // The Author's cord (P8, U-7)
    // -------------------------------------------------------------------------

    /**
     * Kills one live run with the CAUSE of the abort. The abort surfaces as a cancellation in
     * whatever the run is doing (a chat request, between turns, or inside a tool call's next
     * loop iteration), and the run row closes as `abandoned` with the cause's `end_reason` —
     * teardown still runs, because S-3 has no exception for a stop.
     *
     * `reason` defaults to the Author's cord because that is the route's meaning; the sweep
     * passes the real cause (a stopped Story, a lapsed lease) so a run killed by a timeout is
     * never reported as an Author kill (S-4a, D-36).
     *
     * A kill for a run this instance does not own is ignored: the sweep owns the lease, and a
     * server restart abandons stale rows on boot (L-3) rather than through this method.
     */
    kill(runId: string, reason: RunKillReason = 'author'): void {
        const controller = this.controllers.get(runId);

        if (controller === undefined) return;

        this.killed.set(runId, reason);

        const abort = new Error(`run ${runId} ${ABORT_TEXT[reason].abort}`);

        abort.name = 'AbortError';
        controller.abort(abort);
    }

    // -------------------------------------------------------------------------
    // Spawn → work → teardown (S-1, S-3)
    // -------------------------------------------------------------------------

    /**
     * Runs one Work Item to a closed run row. Never throws: every failure path closes the row
     * and returns the reason, because the caller is a sweep that has to keep dispatching (L-1)
     * and a thrown run would strand the lease.
     */
    async execute(item: WorkItem, signal?: AbortSignal): Promise<RunResult> {
        const harness = resolveHarness(this.store, item);
        const tally = createTally();
        const controller = new AbortController();
        const startedAt = new Date().toISOString();

        // D-18: the row exists before anything else, so the crew panel shows the crew being
        // assembled and the Author has a Stop button before the first token is spent.
        const row = this.store.runs.create(
            {
                story_id: item.storyId,
                work_item_ref: item.id,
                template_ref: item.templateRef,
                role: harness.kind,
                session_ref: '',
                state: 'spawning',
                started_at: startedAt,
                tokens: 0,
                // §8.6's Author-invoked run is the other kind of run this layer can spawn.
                kind: item.kind === 'assistant' ? 'assistant' : 'work',
                no_op: false,
                delegated: []
            },
            { run_ref: null, why: `run spawned for work item ${item.id} (${item.kind}) — S-1` }
        );

        const runId = row.id;

        this.controllers.set(runId, controller);

        // The caller's signal (Story stop, lease expiry) is LINKED rather than passed through:
        // `kill` must also be able to stop a run the caller gave no signal to, and the run row
        // needs to know which of the two happened (S-3 vs P8).
        const onOuterAbort = (): void => {
            if (controller.signal.aborted) return;

            controller.abort(signal?.reason);
        };

        if (signal) {
            if (signal.aborted) onOuterAbort();
            else signal.addEventListener('abort', onOuterAbort, { once: true });
        }

        // Both start at the pessimistic value so `finally` always has a closed-row patch to
        // write — S-3 leaves no path on which a run row stays open, not even a throw from inside
        // the catch block below.
        let result: RunResult = {
            runId,
            ended: 'failed',
            no_op: true,
            tokens: 0,
            toolsCalled: [],
            error: 'run closed before the agent loop started'
        };
        let finalRow: UpdatePatch<Run> = {
            state: 'failed',
            ended_at: new Date().toISOString(),
            tokens: 0,
            no_op: true,
            end_reason: 'failed — closed before the agent loop started (S-3)'
        };
        // What the panel decided, when this run's role declares `agents` > 1. Kept out here so the
        // teardown can quote the split: U-8d wants the crew panel to mark a run whose internals
        // disagreed, and the row is the only thing the crew panel reads (D-38).
        let panelOutcome: PanelOutcome | undefined;
        // The structured answer of a `toolMode: 'none'` run. Declared out here because BOTH the
        // completion path (RunResult) and `finally` (the retained thread record) read it.
        let structuredValue: unknown;
        let structuredUsage: RunResult['usage'];
        let structuredText = '';
        let structuredPromptHash: string | undefined;
        /** The two turns the structured run was given — the retained thread's `request` (U-8). */
        let structuredRequest = '';

        try {
            // §2 decision 3: a no-tool run is the single-turn structured mode. It has no brief and
            // no tool context — the compiled prompt is its whole memory.
            const structuredRun = item.toolMode === 'none';

            // S-2: the brief is assembled here, from the store alone — and BEFORE the loop
            // starts, because the run's whole memory has to exist before its first turn does.
            // (A structured run skips it: see `RunScope.briefing`.)
            const briefing = structuredRun ? undefined : buildBrief(this.store, item, harness);
            const agents = Math.max(1, harness.role?.agents ?? 1);
            const aggregate = resolveAggregation(agents, harness.role?.aggregate);
            const phase = (this.store.stories.get(item.storyId) as Story | undefined)?.phase ?? 'chapters';
            const scope: RunScope = {
                runId,
                item,
                harness,
                // T-6b's precedence, in one place (`runModelFor`): the Author's explicit choice
                // on the employee roster (U-8) wins; otherwise the template role's own model; then
                // the process default.
                model: runModelFor(this.store, this.defaultModel, harness.kind, harness.role?.model),
                controller,
                tally,
                context: undefined,
                ...(briefing === undefined ? {} : { briefing }),
                agents,
                aggregate,
                // U-1e + §2 decision 3: the tool list is decided once, here, from the Work Item's
                // kind AND its execution mode — the loop, the panel's agents and every delegate get
                // this same list (see `RunScope.tools`). A `none` mode returns an EMPTY list.
                tools: toolsForRunKind(this.runtime.schemas(), item.kind, item.toolMode),
                // §2: the Author-invoked run of §8.6 is the one run kind the audit has to label
                // separately, so the flag rides on the scope and reaches the session below.
                assistant: item.kind === 'assistant'
            };

            // A no-tool run never gets a tool context: nothing can execute a call it cannot make,
            // and building the context would suggest the mode is a filter rather than a mode.
            if (!structuredRun) {
                scope.context = this.runtime.createContext(this.sessionFor(scope), {
                    // D-17e: the run answers its own `delegate` tool calls with an inner agent loop.
                    delegate: (role, task) => this.delegate(scope, role, task)
                });
            }

            // The prompt is compiled BEFORE the row says `working`, so its hash reaches the row
            // before the first token exactly as a tool run's `brief_hash` does (D-18, S-2).
            const compiled = structuredRun ? this.compilePrompt(scope) : undefined;

            if (compiled !== undefined) structuredRequest = `${compiled.system}\n\n---\n\n${compiled.user}`;

            // S-2 + §4.13: the brief's identity is recorded on the row the moment it exists, so
            // the Author can reconstruct what a finished run was told (D-12a's promise). For a
            // structured run the compiled prompt IS that memory, so its hash is what the row names.
            const briefHash = compiled?.hash ?? briefing?.hash ?? '';

            this.store.runs.update(
                runId,
                { state: 'working', session_ref: `sess_${runId}`, brief_hash: briefHash },
                {
                    run_ref: runId,
                    why: `${compiled === undefined ? 'brief assembled' : 'structured prompt compiled'} and hashed (${briefHash.slice(0, 12)}…) — S-2`
                }
            );

            if (compiled !== undefined) {
                const outcome = await this.runStructuredTurn(scope, compiled);

                structuredValue = outcome.value;
                structuredUsage = outcome.usage;
                structuredText = outcome.text;
                structuredPromptHash = compiled.hash;
            } else if (scope.briefing === undefined) {
                // Unreachable by construction (a tool run assembled its brief above); stated so a
                // future refactor fails the run instead of sending an empty system turn.
                throw new Error('a tool-carrying run has no assembled brief (S-2) — the run cannot start');
            } else if (agents > 1) {
                // D-38: the role is a PANEL. The panel replaces this run's outer loop — it does
                // not run alongside one — so the loop still receives one report (S-1, D-38).
                panelOutcome = await runPanel(
                    { chat: this.chat, runtime: this.runtime, runAgent: this.runAgent },
                    {
                        brief: scope.briefing.text,
                        kickoff: kickoffLine(REPORT_TOOLS),
                        model: scope.model,
                        roleName: scope.harness.roleName,
                        roleKind: scope.harness.kind,
                        templateRef: item.templateRef,
                        storyId: item.storyId,
                        phase,
                        runId,
                        count: agents,
                        aggregate,
                        selectionRules: scope.harness.template?.selection_rules ?? '',
                        jobSummary: `panel agent of ${item.kind}${item.unit ? ` for ${item.unit.kind} ${item.unit.ref}` : ''}`,
                        parentContext: scope.context,
                        createContext: (session, hooks) => this.runtime.createContext(session, hooks),
                        delegate: (role, task) => this.delegate(scope, role, task),
                        heartbeat: () => this.heartbeat(scope),
                        addDelegated: (entry) => this.addDelegated(scope, entry),
                        onExecuted: (name) => this.markReported(scope, name),
                        // U-1e: the panel's agents are this run's agents, so they get its tool list and
                        // its identity — an assistant run's panel neither sees the web nor writes as crew.
                        tools: scope.tools,
                        assistant: scope.assistant,
                        signal: controller.signal
                    },
                    tally
                );
            } else {
                await runAgentLoop(
                    {
                        chat: this.chat,
                        runtime: this.runtime,
                        runAgent: this.runAgent,
                        heartbeat: () => this.heartbeat(scope),
                        onReport: () => this.markReporting(scope)
                    },
                    {
                        label: runId,
                        runId,
                        requestTitle: requestTitleOf(item),
                        system: scope.briefing.text,
                        kickoff: kickoffLine(REPORT_TOOLS),
                        model: scope.model,
                        context: scope.context,
                        storyId: item.storyId,
                        phase,
                        roleName: scope.harness.roleName,
                        roleKind: scope.harness.kind,
                        // U-1e: §7's tool row for this kind of run (./catalogue's `toolsForRunKind`).
                        tools: scope.tools,
                        signal: controller.signal
                    },
                    tally
                );
            }

            // S-4: a run that called no report tool is a no-op turn and must count toward loop
            // detection — the flag is the loop's input (L-15), and S-4's own note is that a
            // Writer run that wrote nothing and escalated nothing is a bug in its brief.
            //
            // A `toolMode: 'none'` run is the ONE exception, and it is not a loosening of S-4: the
            // validated structured answer IS its report (§2 decision 2 — the engine persists it),
            // so a successful structured run did produce the thing its job exists to produce.
            const noOp = item.toolMode === 'none' ? false : tally.reports.length === 0;

            result = {
                runId,
                ended: 'completed',
                no_op: noOp,
                tokens: tally.tokens,
                toolsCalled: [...tally.executed],
                // Omitted rather than `undefined`, so a reader of the result can tell a structured
                // run from a prose one without a `in` check (and toEqual assertions stay exact).
                ...(structuredValue === undefined ? {} : { structured: structuredValue }),
                ...(structuredPromptHash === undefined ? {} : { promptHash: structuredPromptHash }),
                ...(structuredUsage === undefined ? {} : { usage: structuredUsage })
            };
            // A panel that disagreed says so on the row too (D-38, U-8d): the dissent's home is the
            // `selection_note` the panel appended it to, and the row is where the crew panel looks.
            // A structured run states what it actually did: one validated turn, no tool calls.
            const endReason = structuredRun
                ? END_STRUCTURED
                : panelOutcome === undefined || panelOutcome.dissent === ''
                  ? END_COMPLETED
                  : `${END_COMPLETED}; panel disagreed — ${panelOutcome.dissent} (${panelOutcome.answered} of ${scope.agents} agents answered)`;

            finalRow = {
                state: 'torn_down',
                ended_at: new Date().toISOString(),
                tokens: tally.tokens,
                no_op: noOp,
                end_reason: endReason
            };
        } catch (error) {
            const noOp = tally.reports.length === 0;

            if (wasAborted(error, controller.signal)) {
                // Same state, different causes: the Author's cord says `killed`; a stopped
                // Story, a directive, a delete or a lapsed lease each say what really happened
                // (S-4a, L-2, D-37). A caller signal with no recorded cause keeps the generic
                // sentence.
                const killReason = this.killed.get(runId);

                result = {
                    runId,
                    ended: 'killed',
                    no_op: noOp,
                    tokens: tally.tokens,
                    toolsCalled: [...tally.executed]
                };
                finalRow = {
                    state: 'abandoned',
                    ended_at: new Date().toISOString(),
                    tokens: tally.tokens,
                    no_op: noOp,
                    end_reason:
                        killReason === undefined
                            ? 'abandoned — the caller signal aborted (lease expiry or Story stop, S-4a)'
                            : ABORT_TEXT[killReason].end
                };
            } else {
                const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
                const provider = error instanceof LlmError;

                result = {
                    runId,
                    ended: 'failed',
                    no_op: noOp,
                    tokens: tally.tokens,
                    toolsCalled: [...tally.executed],
                    error: reason
                };
                // S-3: the row records WHY it ended, and the transport's status/body is the most
                // useful sentence the row can carry for a provider fault (client.ts's contract).
                finalRow = {
                    state: 'failed',
                    ended_at: new Date().toISOString(),
                    tokens: tally.tokens,
                    no_op: noOp,
                    end_reason: `${provider ? 'failed — LLM provider fault' : 'failed'}: ${reason}`
                };
            }
        } finally {
            // S-3, mechanically: this block runs on success, on abort and on throw, so there is no
            // path on which a run row stays open or a session is left orphaned.
            signal?.removeEventListener('abort', onOuterAbort);
            this.controllers.delete(runId);
            this.killed.delete(runId);
            this.teardown(runId, finalRow);

            // A no-tool run never enters the engine, so nothing else writes its thread record:
            // `StoryHarness.run`'s retention is mirrored here, in the same shape and on every path
            // (a failed sample is exactly the thread the Author needs, S-3/U-8).
            if (structuredRequest !== '') {
                this.retainStructuredThread(item, harness, startedAt, structuredRequest, structuredText, result);
            }
        }

        return result;
    }

    // -------------------------------------------------------------------------
    // §4.2 / §2 decision 3 — the single-turn, no-tool structured run
    // -------------------------------------------------------------------------

    /**
     * Which compiled prompt this Work Item runs on (§5). Kind decides, not the template: a
     * `screen_samples` job judges the ONE draft its `revisionRef` names (D-21), and every other
     * no-tool kind is a sampling round whose base revision comes from `item.round`.
     */
    private compilePrompt(scope: RunScope): CompiledPrompt {
        const { item } = scope;

        if (item.kind === 'screen_samples') {
            if (item.revisionRef === undefined || item.revisionRef.length === 0) {
                // A screen with no draft can judge nothing; failing loudly beats an empty issue
                // list the selector would read as "this sample is clean" (§6.5).
                throw new Error('a screen_samples item must name the draft it judges in revisionRef (§6.4 step 4)');
            }

            return compileScreenPrompt(this.store, item.storyId, item.revisionRef);
        }

        // The round is on the item because it is not derivable from the store (§6.8): round 2+
        // must read the PREVIOUS round's selected revision, and only the sweep knows the round.
        return compileSamplePrompt(this.store, item.storyId, { round: item.round ?? 1 });
    }

    /**
     * Executes the structured mode (§4.2): ONE assistant turn with no tools and a
     * `response_format`, plus at most one schema-repair retry.
     *
     * WHY THE DIRECT TRANSPORT PATH AND NOT AN ENGINE THREAD (the investigation this build was
     * asked to record):
     *   (a) The engine's stream request type is `{model, messages, tools, signal}` — it has no
     *       place for `response_format` or `seed`, and `StoryHarness.streamFor` calls
     *       `chat.complete` without them, so an engine thread CANNOT deliver §4.2's structured
     *       contract or §5's sampling seed.
     *   (b) `GET /agents` reads its live `working` list from the ENGINE threads a Story harness owns
     *       (`StoryHarness.statuses`), reconciled with the live run rows by
     *       `StoryHarnessManager.mergeJournaledRuns` — which is why a run with no thread of its own
     *       can still count on the tile, and why `recent` (the CLOSED rows) never double-books it.
     * So this path owns the provider call directly. The consequence, stated plainly: the run row is
     * created/updated/closed exactly like a normal run (D-18, S-3 — `spawning` → `working` →
     * `torn_down`) and appears in every store-derived surface — including the employee tile's live
     * `working` list, which counts it from the row (R1) while no engine thread exists for it. A
     * one-turn sampling call is seconds long and cannot host tools, so it earns no engine thread
     * surface of its own; the retained thread log below keeps the request/answer history complete
     * (U-8).
     *
     * Tokens are added to the run's tally per call (S-6/E-0), including the repair attempt — a
     * failed answer still cost the provider call.
     */
    private async runStructuredTurn(
        scope: RunScope,
        compiled: CompiledPrompt
    ): Promise<{ value: unknown; text: string; usage?: RunResult['usage'] }> {
        const schema = scope.item.responseSchema;

        if (schema === undefined) {
            throw new Error(
                `a toolMode:'none' ${scope.item.kind} run must name its responseSchema (name + plain JSON Schema) — §4.3`
            );
        }

        const messages: ChatMessage[] = [
            { role: 'system', content: compiled.system },
            { role: 'user', content: compiled.user }
        ];

        // Summed across the (at most two) requests: `tokens` on the run row is the run's provider
        // cost, and reporting only the last call would under-count a repaired answer.
        let usage: { input: number; output: number; cached_input: number } | undefined;
        let lastError = '';

        for (let attempt = 1; attempt <= STRUCTURED_ATTEMPTS; attempt += 1) {
            // P8: a cord pulled between turns must not spend another request.
            this.abortIfStopped(scope.controller.signal);

            // NO `tools` key at all: §2 decision 3 is an execution mode, so the request carries no
            // tool surface and no `temperature` (§5's diversity is the `seed`, nothing else).
            const response = await this.chat.complete({
                model: scope.model,
                messages,
                responseFormat: schema,
                ...(scope.item.sampleIndex === undefined ? {} : { seed: scope.item.sampleIndex }),
                signal: scope.controller.signal
            });

            if (response.usage !== undefined) {
                scope.tally.tokens += response.usage.input + response.usage.output;
                usage = {
                    input: (usage?.input ?? 0) + response.usage.input,
                    output: (usage?.output ?? 0) + response.usage.output,
                    cached_input: (usage?.cached_input ?? 0) + response.usage.cached_input
                };
            }

            const text = response.message.content ?? '';
            const parsed = parseStructuredContent(text, schema.schema);

            if (parsed.ok) return { value: parsed.value, text, ...(usage === undefined ? {} : { usage }) };

            lastError = parsed.error;

            // The previous attempt stays in the transcript, so the model can SEE what it answered
            // and re-emit corrected JSON; the repair line names the validator's exact failure.
            if (attempt < STRUCTURED_ATTEMPTS) {
                messages.push(
                    { role: 'assistant', content: text },
                    {
                        role: 'user',
                        content: `Your previous answer was not valid: ${parsed.error}. Re-emit the COMPLETE JSON object matching the schema, and nothing else.`
                    }
                );
            }
        }

        throw new Error(
            `structured answer failed schema validation after ${STRUCTURED_ATTEMPTS} attempts: ${lastError}`
        );
    }

    /**
     * Throws the signal's own reason so an Author Stop / stopped Story / lapsed lease surfaces as
     * the cancellation it is (`wasAborted` then closes the row as `abandoned`, S-3). Same rule as
     * ./loop's `throwIfAborted`; duplicated here because a no-tool run never enters that loop.
     */
    private abortIfStopped(signal: AbortSignal): void {
        if (!signal.aborted) return;

        const reason = signal.reason;

        if (reason === undefined) {
            const synthesised = new Error('run aborted');
            synthesised.name = 'AbortError';

            throw synthesised;
        }

        throw reason;
    }

    /**
     * The retained thread record for a no-tool run (the mirror of `StoryHarness.run`'s
     * `threadLog.append`, reached from `execute`'s `finally`). `thread_id` is synthesised because
     * no engine thread exists — the row is keyed by the run instead, and the value is stable for
     * the life of the record. Nothing here is read by the model; it is the Author's history (U-8).
     */
    private retainStructuredThread(
        item: WorkItem,
        harness: ResolvedHarness,
        startedAt: string,
        request: string,
        answer: string,
        result: RunResult
    ): void {
        if (this.threadLog === undefined) return;

        const story = this.store.stories.get(item.storyId) as Story | undefined;
        const state: StoryThreadState =
            result.ended === 'completed' ? 'torn_down' : result.ended === 'killed' ? 'abandoned' : 'failed';

        const record: StoryThreadRecord = {
            thread_id: `single_${result.runId}`,
            run_id: result.runId,
            story_id: item.storyId,
            story_title: story?.title ?? item.storyId,
            phase: story?.phase ?? 'chapters',
            role: harness.kind,
            role_name: harness.roleName,
            title: requestTitleOf(item),
            state,
            started_at: startedAt,
            ended_at: new Date().toISOString(),
            tokens: result.tokens,
            request,
            // A failed or repaired-then-failed run has no validated answer; the raw text is
            // deliberately not retained as if it were one (S-3's "why did this thread end" is the
            // run row's `end_reason`).
            answer: result.structured === undefined ? answer : JSON.stringify(result.structured),
            ...(result.error === undefined ? {} : { error: result.error }),
            retained: true
        };

        try {
            this.threadLog.append(record);
        } catch {
            // Retention is presentation; losing one line must not change the run's outcome.
        }
    }

    // -------------------------------------------------------------------------
    // Plumbing the scope needs
    // -------------------------------------------------------------------------

    /** The session T3 binds the tool context to: T-3's story scope plus the identity every write carries. */
    private sessionFor(scope: RunScope, delegatedRole?: string): RunToolSession {
        return {
            storyId: scope.item.storyId,
            runId: scope.runId,
            runRef: scope.runId,
            sessionRef: `sess_${scope.runId}`,
            templateRef: scope.item.templateRef,
            roleName: scope.harness.roleName,
            roleKind: scope.harness.kind,
            agents: scope.agents,
            aggregate: scope.aggregate,
            delegatedRole,
            // §2: the Author-invoked run's writes carry the assistant flag; a delegate's writes
            // inherit it, because a sub-context acts for its run (T-2b).
            assistant: scope.assistant
        };
    }

    /**
     * S-4a: the lease heartbeat. Every tool call refreshes `updated_at` — nothing else, because
     * the loop engine reads that column as the lease and a run that keeps calling tools is
     * working however long it takes (E-0). A heartbeat write that fails is swallowed on purpose:
     * losing one row update must not kill a run that is otherwise fine, and the symptom of a
     * persistently failing heartbeat is a lapsed lease, which is the loop's own recovery path.
     */
    private heartbeat(scope: RunScope): void {
        try {
            this.store.runs.update(
                scope.runId,
                {},
                { run_ref: scope.runId, why: 'lease heartbeat — tool call (S-4a)' }
            );
        } catch {
            // Swallowed — see the note above.
        }
    }

    /** §4.13's `reporting` state: the run has reported and the server's commit is the next step (§9). */
    private markReporting(scope: RunScope): void {
        try {
            const current = this.store.runs.get(scope.runId);

            if (current === undefined || current.state !== 'working') return;

            this.store.runs.update(
                scope.runId,
                { state: 'reporting' },
                { run_ref: scope.runId, why: 'report tool called — §9 report step' }
            );
        } catch {
            // Same reasoning as the heartbeat: panel state is observation, not the run's own progress.
        }
    }

    /**
     * The panel's post-execution bookkeeping. The loop records execution itself for a
     * single-agent run, but a panel's winning set is executed by ./panel AFTER the aggregation,
     * so the calls have to reach the run's tally from here: `toolsCalled` must list what really
     * executed (S-4), and a report tool that lands through the panel still moves the row to
     * `reporting` (§9's report step, D-38's one report surface).
     */
    private markReported(scope: RunScope, name: string): void {
        scope.tally.executed.push(name);

        if (!isReportTool(name)) return;

        if (!scope.tally.reports.includes(name)) {
            scope.tally.reports.push(name);
            this.markReporting(scope);
        }
    }

    /**
     * S-7: a delegated sub-context or panel agent is shown NESTED under the run that spawned it.
     * The read-modify-write is synchronous, so concurrent delegates cannot lose an entry.
     */
    private addDelegated(scope: RunScope, entry: RunDelegation): void {
        try {
            const current = this.store.runs.get(scope.runId);

            if (current === undefined) return;

            this.store.runs.update(
                scope.runId,
                { delegated: [...current.delegated, entry] },
                { run_ref: scope.runId, why: `nested sub-context recorded under this run (S-7): ${entry.role}` }
            );
        } catch {
            // The nested list is presentation (U-7); losing it must not fail the run.
        }
    }

    /**
     * D-17e / T-2b — the `delegate` tool's answer: an INNER agent loop, inside this run and this
     * Story, with no Work Item and no run row of its own (S-7).
     *
     * The prompt is the named role's prompt when the template declares that role, and a generic
     * reasoner prompt otherwise. The permission row is always the PARENT's kind, and so is the
     * `runRef`: an inner agent's mutating calls execute for real under the parent run's identity,
     * because T-2b's rule is that a sub-context "cannot write anything the parent could not" —
     * attribution to a phantom run would break P11's audit trail for no benefit.
     */
    private async delegate(scope: RunScope, role: string, task: string): Promise<ToolResult> {
        const permitted = this.delegationAllowed(scope, role);

        if (!permitted.allowed) return { ok: false, error: permitted.reason };

        const inner = scope.harness.template?.roles?.find((candidate) => candidate.name === role);
        const innerTally = createTally();
        const hooks: RunToolHooks = {
            // A sub-context may itself delegate (the built-in Writer template names `checker`);
            // the recursion is bounded by the template's own delegation lists.
            delegate: (nestedRole, nestedTask) => this.delegate(scope, nestedRole, nestedTask)
        };

        const context = this.runtime.createContext(this.sessionFor(scope, role), hooks);

        const outcome = await runAgentLoop(
            { chat: this.chat, runtime: this.runtime, runAgent: this.runAgent, heartbeat: () => this.heartbeat(scope) },
            {
                label: `${scope.runId}#${role}`,
                runId: scope.runId,
                requestTitle: task,
                system: inner ? inner.prompt : genericReasonerPrompt(role, task),
                kickoff: task,
                // A named role's own model when it exists; otherwise the run's model (T-6b: the
                // model is the template's setting, not this layer's choice).
                model: inner?.model ?? scope.model,
                context,
                storyId: scope.item.storyId,
                phase: (this.store.stories.get(scope.item.storyId) as Story | undefined)?.phase ?? 'chapters',
                roleName: role,
                roleKind: inner?.kind ?? scope.harness.kind,
                // U-1e/T-2b: a sub-context may only do what its run may do — including which tools it
                // is offered, so a delegate inside an assistant run has no web either.
                tools: scope.tools,
                signal: scope.controller.signal
            },
            innerTally
        );

        // The sub-context's tokens roll up into the run (S-6) and are reported on the nested entry.
        scope.tally.tokens += innerTally.tokens;
        scope.tally.executed.push(...innerTally.executed);

        // D-17e: "the delegating run remains the one that reports", so a report tool its
        // sub-context executed IS this run's report. Without this, a run that delegated and came
        // back with a filed finding would be counted a no-op turn by S-4 — and the loop would
        // re-dispatch work the run demonstrably did (L-15).
        for (const report of innerTally.reports) {
            if (scope.tally.reports.includes(report)) continue;

            scope.tally.reports.push(report);
            this.markReporting(scope);
        }

        this.addDelegated(scope, { role, task, summary: outcome.text, tokens: innerTally.tokens });

        // The inner agent's final text is the parent's only result (D-17e).
        return { ok: true, summary: outcome.text };
    }

    /**
     * D-17e: `delegation` names the roles a template may delegate to inside its own run. An
     * absent field means "undeclared" and is allowed (the built-in templates that forbid it say
     * so with an explicit empty list, e.g. `reader-genre.delegation: []`).
     *
     * WHY AN EXPLICIT LIST IS HONOURED STRICTLY, INCLUDING FOR A KIND NAME: this method used to
     * allow ANY RoleKind through regardless of the list, so a template could "safely" name a kind
     * in its own list. When `researcher` joined `ROLE_KINDS` (phase-1 research pipeline §3.1) that
     * loophole silently turned every template's explicit `delegation: []` into "the Researcher is
     * fine", which is exactly the fan-out D-17e lets a template forbid. A list that NAMES a kind
     * still works through `includes` — the entry is what grants the door, never the spelling.
     */
    private delegationAllowed(scope: RunScope, role: string): { allowed: boolean; reason?: string } {
        const declared = scope.harness.template?.delegation;

        // An absent `delegation` field is undeclared rather than forbidden: the built-in roster
        // forbids explicitly (`reader-genre.delegation: []`), and T-6a's "every kind sees all
        // tools" applies to the catalogue, not to what a template chooses to fan out to.
        if (declared === undefined) return { allowed: true };
        if (declared.includes(role)) return { allowed: true };

        return {
            allowed: false,
            reason: `template "${scope.harness.template?.name ?? scope.item.templateRef}" does not name "${role}" in its delegation list (D-17e) — delegate to ${
                declared.length > 0 ? declared.join(', ') : 'nobody'
            }, or do the reasoning yourself`
        };
    }

    /**
     * S-3's unconditional close. Writes the end state, `ended_at`, the token total, `no_op` and
     * `end_reason` in ONE update, so a run row is never observable in a half-closed state. A
     * teardown that throws (the row was deleted from under us — an Author's cleanup, or a
     * backtrack scrap) is swallowed after one retry: nothing may prevent the row from closing,
     * and nothing may make the run's result depend on a bookkeeping write either.
     */
    private teardown(runId: string, patch: UpdatePatch<Run>): void {
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            try {
                const current = this.store.runs.get(runId);

                if (current === undefined) return;

                // The sweep may already have closed the row with its own reason — a lapsed
                // lease writes S-4a's sentence before the aborted run's promise settles. S-3
                // means the row closes exactly once, not that this method must be the one that
                // writes it: keep the sweep's state and reason, and land only the accounting.
                if (current.ended_at !== undefined && current.ended_at !== null) {
                    this.store.runs.update(
                        runId,
                        { tokens: patch.tokens, no_op: patch.no_op },
                        { run_ref: runId, why: 'teardown — the row was already closed by the sweep (S-3, S-4a)' }
                    );

                    return;
                }

                this.store.runs.update(runId, patch, {
                    run_ref: runId,
                    why: `teardown — ${patch.end_reason ?? patch.state} (S-3)`
                });

                return;
            } catch (error) {
                if (attempt === 2) {
                    // Last resort: the row could not be closed. Recorded nowhere but here, because
                    // the caller is a sweep that has to keep going, and the run's own result (with
                    // its `error`) is already on its way back to it.
                    console.warn(`[run ${runId}] teardown could not close the run row (S-3):`, error);

                    return;
                }
            }
        }
    }
}
