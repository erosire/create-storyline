// W5's spawner half: `RunExecutor` — one Work Item in, one closed run row out.
//
// VOCABULARY (V-1). The Work Item names a template role, which names an EMPLOYEE kind (Writer,
// Editor, Critic, Reader). The executor opens one THREAD on that employee's engine profile; the
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
// the sweep re-adopts or abandons it (L-3). The one exception (C2-AD3) is the Critic's review
// pass, and it is not a clock: the pass ends when its report has FILED — the tool answered, not
// merely the model asked — or when the review-turn bound catches a critic that will not conclude.
// Both are decisions about the pass, both close the row `torn_down` with a sentence of its own
// ({@link END_REPORTED}, {@link END_CAPPED}), and neither puts a time limit on any run. A report the
// tool layer REFUSED ends nothing at all: the row's third honest ending is {@link END_UNREPORTED},
// paired with `no_op: true`, which is what lets the loop owe that seat again.
//
// THE TWO CLOCKS (the bug this file carried, and the contract that closes it): a
// `toolMode: 'none'` run answers in ONE structured turn and never calls a tool, so between the
// row's `working` write and the provider's first byte NOTHING refreshed `updated_at`. A healthy
// local model composing a 120.4s turn was therefore indistinguishable from a dead worker, and the
// sweep abandoned it at 120000ms of silence (observed: 4 of 6 Summary samples + 2 screens, each
// `tokens=0`, against a bounded sampling allowance). Liveness now covers the wait itself:
//   1. IDLE EXECUTION LEASE — unchanged, owned by the sweep (`DEFAULT_LEASE_IDLE_MS`,
//      server/loop/types.ts:307; checked by `lapsedRuns`, server/loop/records.ts:1599). It answers
//      "is anyone home?", and {@link completeStructured} keeps it fed while a request is in flight,
//      exactly as the engine's stream adapter already does for a tool run
//      (server/run/story-engine.ts:714-750). Silence is what kills a run, never slowness.
//   2. REQUEST-LIVENESS CEILING — added here, `STRUCTURED_REQUEST_MAX_MS`. It answers "how long may
//      an answer that never arrives go on being believed?", because a heartbeat that beats for an
//      unresolved request forever would keep a hung provider Promise alive indefinitely and turn
//      S-4a's lease into no guard at all. It is one finite window per provider request, so a run is
//      bounded at STRUCTURED_ATTEMPTS x the ceiling and cannot recurse or spin.
import { LlmError, type ChatClient, type ChatMessage, type ChatRequest, type ChatResponse, type ToolSchema } from '../llm';
import { parseStructuredContent } from '../llm/structured';
import { type RoleAggregation, type RoleKind, type Run, type RunDelegation, type Story } from '../../shared/types';
import { type Store, type UpdatePatch } from '../store';
import { runModelFor } from './agent-models';
import { buildBrief, type AssembledBrief } from './brief';
import { isReportTool, REPORT_TOOLS, reportToolsForStructureSeat, toolsForRunKind } from './catalogue';
import { genericReasonerPrompt, resolveHarness, kickoffLine, type ResolvedHarness } from './harness';
import { createTally, runAgentLoop, wasAborted, type LoopOutcome, type RunEndCause, type RunTally } from './loop';
import { type PanelOutcome, runPanel } from './panel';
import { isTerminalCriticReport } from './plugins/critic-termination';
import {
    compileGroupDraftPrompt,
    compileGroupLockPrompt,
    compileGroupReviewPrompt,
    compileSamplePrompt,
    compileScreenPrompt,
    compileSectionScorePrompt,
    type CompiledPrompt
} from './phase1-prompt';
import { runEngineAgent, StoryHarnessManager } from './story-engine';
// D-67: the reviewed hash a scoring seat claimed under, read back off its Work Item id — the SAME
// reader `loop/engine.ts` uses when it stamps the score rows, so the prompt the Reader is shown and
// the `vector_hash` the ledger files cannot name different books. `server/phrase` imports nothing from
// the run layer, so this adds no cycle (and `phase1-prompt.ts` already reaches across the same way).
import { phraseStructureSeatOf, sectionScoreVectorHashOf } from '../phrase';
// PHRASE GROUP LOCK: the other half of the same read for an Editor lock seat — `{vector, group}` off the
// `wi_group_lock_<cleanVectorHash>_<groupId>` claim key, owned by `loop/editor-lock.ts` because the
// generator, the compiler and the settle all spell the key from there.
import { groupLockSeatOf } from '../loop/editor-lock';
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
    /**
     * The executor-owned signal: aborted by `kill`, by the request-liveness ceiling
     * ({@link stopAtRequestCeiling}), or linked to the caller's (lease expiry, Story stop). Every
     * structured provider request is handed THIS signal, so a kill, a stop and a ceiling all reach the
     * transport instead of only the run's own bookkeeping.
     */
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
 * §4.13's `end_reason` for a run that ended on its own tool-less turn HAVING FILED NOTHING. It is a
 * different sentence from {@link END_COMPLETED} because the plain one asserts the run reported, and
 * `no_op: true` on the same row says it did not — the pair the crew rail shows would contradict
 * itself. This is the row of a pass whose every report tool was refused, and of the brief bug S-4
 * measures: the honest state is "ended without a successful report", not "reported".
 *
 * It names neither {@link END_REPORTED}'s tool nor a cap, because neither happened, and it keeps clear
 * of the pause words `runsStoppedByPause` (dashboard/components/story-contract.ts:2817) matches, so a
 * run that concluded is never counted as one the Author stopped.
 */
const END_UNREPORTED = 'completed — the model returned no tool call and the run filed no report (S-4)';

/**
 * §4.13's `end_reason` for a `toolMode: 'none'` run. It is a different sentence on purpose: a
 * structured run never "returned no tool call and reported" — it was given no tool to call, and
 * its single schema-validated answer is what the engine persists (§2 decision 2).
 */
const END_STRUCTURED = 'completed — one structured turn, validated against the response schema (§4.2)';

/**
 * §4.13's `end_reason` for a Critic review pass that ENDED BY FILING ITS REPORT (C2-AD3). It is a
 * different sentence from {@link END_COMPLETED} on purpose: the model did NOT return a turn with no
 * tool call — it filed `submitVerdict`, and the run ended on that turn because the pass had answered.
 * Claiming the natural-end sentence here would misdescribe the run the Author is reading (U-7), and
 * the number of turns it cost is the fact the whole change exists to make visible.
 *
 * WHY THE WORDING AVOIDS "stop"/"kill"/"author": `runsStoppedByPause` (dashboard/components/
 * story-contract.ts:2817) counts paused runs by matching `/author|stop|paused|kill` against
 * `end_reason`. A Critic pass that concluded must never land in that count, so this sentence names
 * what happened without any of those words.
 */
const END_REPORTED = (cause: RunEndCause): string =>
    `completed — the Critic filed its report (${cause.terminal_tool ?? cause.reports.join(', ')}) at model turn ${String(
        cause.turns
    )} and the pass ended there (C2-AD3)`;

/**
 * §4.13's `end_reason` for a Critic pass the review-turn CAP ended (C2-AD3). Honest, and deliberately
 * not the same sentence as {@link END_REPORTED}: the pass ran out its bound without filing its
 * verdict, so the row says the verdict is missing and names the bound, while the findings it did file
 * stay filed. The row still closes `torn_down` rather than `failed`, because teardown really happened
 * and the work it produced is in the book — a cap is a bounded outcome, not a fault.
 */
const END_CAPPED = (cause: RunEndCause): string => {
    const refused = terminalRefusalOf(cause);

    // TWO capped sentences, because the two facts differ and the Author tunes against them. A pass that
    // never called its verdict is a critic that would not conclude; a pass that called it and was
    // REFUSED (T-1a) is a critic whose answer the tool layer turned away — the correction turn the fix
    // gives it is the difference, and the row has to show which one it is reading.
    return refused === undefined
        ? `completed — the Critic reached its ${String(cause.cap)}-model-turn review cap without filing its verdict; the ${String(
              cause.turns
          )} turns it ran and the findings it filed stand (C2-AD3)`
        : `completed — the Critic reached its ${String(cause.cap)}-model-turn review cap with its ${refused} report refused and nothing filed; the ${String(
              cause.turns
          )} turns it ran are all this pass produced (C2-AD3)`;
};

/**
 * The terminal report this pass called and never got filed — refused, with no later success for the
 * same tool. `run/plugins/critic-termination` and `run/loop.ts` both report refusals; this is the one
 * place that turns one into a sentence, so the plugin's ledger, the thread record and the run row
 * cannot name three different versions of the same ending.
 */
const terminalRefusalOf = (cause: RunEndCause): string | undefined =>
    (cause.refusals ?? []).find((name) => isTerminalCriticReport(name) && !cause.reports.includes(name));

/**
 * The panel clause on a run row (MAJOR 4). A panel REPLACES the run's loop (D-38), so the run never
 * has an `endCause` of its own and would otherwise claim "the model returned no tool call" for members
 * each ended by their own review policy. The counts come from `run/panel.ts`, which folds the members'
 * `endCause`s into numbers — one clause, because the run answers once.
 *
 * Empty for every panel with no policy-watched members (a Writer or Editor panel, and a critic panel
 * whose members all ended naturally), which is what keeps the sentences of every existing run row
 * byte-identical.
 */
const panelMemberClause = (panel: PanelOutcome): string => {
    // ONE or MANY, because the row is prose the Author reads: a 2-agent panel whose members all filed
    // has to read as a sentence, not as a count glued to a singular verb.
    const count = (value: number | undefined, one: string, many: string): string | undefined =>
        value === undefined ? undefined : `${String(value)} ${value === 1 ? one : many}`;
    const parts = [
        count(panel.reported, 'filed its report', 'filed their reports'),
        count(panel.capped, 'reached its review-turn cap without a verdict', 'reached their review-turn cap without a verdict'),
        count(panel.refused, 'had its report refused and never filed one', 'had their reports refused and never filed one')
    ].filter((part): part is string => part !== undefined);

    return parts.length === 0 ? '' : `; its members — ${parts.join(', ')} (C2-AD3)`;
};

/**
 * §4.13's `end_reason` for a D-38 PANEL whose members WERE ended by their own review policy. It
 * replaces {@link END_COMPLETED}'s claim that "the model returned no tool call" for that row, because
 * for a panel that sentence was never true — the members each ended under C2-AD3 and the panel then
 * aggregated them — and it carries what each ending was, so a capped critic panel cannot be read as a
 * panel that concluded. Panels with no policy-watched members keep the historical sentence (the clause
 * is empty and this builder is never reached), which is why no existing row changes.
 */
const END_PANEL = (panel: PanelOutcome, agents: number, noOp: boolean): string =>
    `completed — the panel answered once (${String(panel.answered)} of ${String(agents)} agents answered) and the run ${
        noOp ? 'filed no report (S-4)' : 'reported'
    }${panelMemberClause(panel)}`;

/**
 * How many provider calls a no-tool run may make. TWO is the whole budget the design allows:
 * one answer plus at most ONE schema-repair retry (§4.2, §2's "at most one schema-repair
 * retry"). A run that is still invalid after the retry FAILS — never a second repair.
 */
const STRUCTURED_ATTEMPTS = 2;

/**
 * How often an in-flight provider request refreshes the lease (S-4a). Deliberately the same
 * cadence the engine's stream adapter uses while a TOOL run waits on its model turn
 * (`STREAM_HEARTBEAT_MS`, server/run/story-engine.ts:173), so the sweep sees one liveness rhythm
 * from both execution modes. A third of the 120s idle lease, so a run survives one lost store
 * write (see {@link heartbeat}) rather than lapsing on a bookkeeping fault.
 */
const RUN_HEARTBEAT_MS = 30_000;

/**
 * The liveness ceiling of ONE structured provider request — the finite half of S-4a's guard
 * (header note "THE TWO CLOCKS"). Why a number is legal here while E-0 forbids a run timeout:
 * E-0/S-4a ban a clock on the RUN ("a run that takes four hours is fine"), and this puts no bound
 * on how many turns or attempts a run may take. It bounds one promise: the window inside which a
 * request that has produced nothing is still believed to be a live worker rather than a hung
 * socket. 10 minutes is ~5x the slowest legitimate turn observed on a local provider (120.4s for a
 * full sampling turn) while staying finite, so the pathological case — a provider Promise that
 * never settles — ends the run at a known time instead of leaving the crew panel holding a
 * `working` row until the process restarts (L-3).
 *
 * NOT an environment knob on purpose: `RunExecutorDeps` (./types) carries no config bag, and the
 * sweep's `leaseIdleMs` is the dial the operator already owns. This ceiling is a property of the
 * transport contract, not a deployment preference.
 */
const STRUCTURED_REQUEST_MAX_MS = 600_000;

/**
 * The journal `why` for a beat fired while a provider request is pending. It differs from the
 * tool-call sentence only so an Author reading the audit can tell "waiting on the model" from
 * "running a tool"; both are lease beats and neither is a story fact (P3 — run-row events are
 * excluded from briefs by `eventBelongsToStory`, server/run/brief.ts:330).
 */
const BEAT_REQUEST = 'lease heartbeat — provider request in flight (S-4a)';

/**
 * Why a live run was aborted. The Author's cord is only ONE of the ways a run stops being its
 * own (P8): the sweep also kills a Story's crew when the Story is stopped or paused (D-37), a
 * directive that changes the book out from under a run (L-24), a Story delete (P1), a lease
 * that lapsed (S-4a), and a provider request that outlived its liveness ceiling (see
 * `STRUCTURED_REQUEST_MAX_MS`). Naming the cause is what stops the UI from telling the Author that
 * they pulled a cord they never touched — and it is the WORKER-HEALTH DISTINCTION the two clocks
 * need: `lease` says "nobody was home", `deadline` says "somebody was home and stopped answering".
 * A run abandoned for either reason returns its Work Item to the queue; only the sentence the
 * Author reads differs.
 *
 * WHY C2-AD3 ADDED NO MEMBER HERE. The ways a Critic pass now ends early — a terminal report that
 * FILLED, and the review-turn cap — are not cancellations: the run reaches `execute`'s success path
 * with its result intact and closes `torn_down`/`completed`. This union is the vocabulary of the
 * ABORT path (`ABORT_TEXT`'s `end` strings all say "abandoned"), so putting a concluded review pass
 * in it would claim the pass was killed and hand its Work Item back to the queue. The sentences that
 * describe an early end — {@link END_REPORTED}, {@link END_CAPPED} and {@link END_UNREPORTED} — are
 * therefore `end_reason` builders on the completed path, not new kill causes. A REFUSED report is not
 * a kill cause either and not an ending: it is a turn the model gets back.
 */
type RunKillReason = 'author' | 'lease' | 'deadline' | 'stop' | 'directive' | 'delete';

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
    deadline: {
        abort: 'abandoned — its provider request outlived the request-liveness ceiling (S-4a)',
        end: 'abandoned — its provider request outlived the request-liveness ceiling (S-4a)'
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

/**
 * The VALUE a cancellation carries, for paths that must reject rather than throw. The mirror of
 * {@link RunExecutor.abortIfStopped} and of `abortReason` in server/llm/client.ts:173: the signal's
 * own reason when the host set one (so an Author cord, a stopped Story or a lapsed lease keeps its
 * own sentence all the way to the row), and a synthesised `AbortError` when it did not.
 */
const signalReason = (signal: AbortSignal): Error => {
    const reason = signal.reason;

    if (reason instanceof Error) return reason;

    if (reason !== undefined) {
        const wrapped = new Error(String(reason));
        wrapped.name = 'AbortError';

        return wrapped;
    }

    const synthesised = new Error('run aborted');
    synthesised.name = 'AbortError';

    return synthesised;
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
                delegated: [],
                // SUMMARY PHRASE R4 — the group set this run HOLDS, copied off the item at the moment
                // the row is created. It has to be the row's own field (not re-derived from
                // `work_item_ref`) because the exclusion is judged from persisted state: a restart, a
                // lease expiry and a second engine all read the same answer from the live rows, and a
                // claim key's hash is not something the exclusion should have to re-parse.
                ...(item.groupRefs === undefined || item.groupRefs.length === 0
                    ? {}
                    : { group_refs: [...item.groupRefs] })
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
        // What the agent loop returned, when this run took the single-agent path. Needed out here
        // because C2-AD3 reads `endCause` from it to decide the row's `end_reason`: a Critic pass that
        // ended by filing its verdict must not borrow the natural-end sentence.
        let loopOutcome: LoopOutcome | undefined;

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

            // S-4's closing sentence, per seat (D-a). The kickoff repeats the closed report list, so it
            // has to be cut the same way the brief's `TOOLS AND HOW TO END` section is cut
            // (`run/brief.ts:renderEtiquette`): a structuring seat must not be told to end on the OTHER
            // phrase's structuring write — Phrase ②'s Editor ending on `structureSeed` lands a Seed Brief
            // for the wrong phrase and leaves the chapter set unaccepted, and Phrase ①'s seat is offered a
            // `structurePlotlines` call the tool refuses outright. Every non-seat run gets the whole
            // union, byte-identically to before, and Phrase ①'s list is unchanged too (its seat never
            // saw `structurePlotlines` in the union, so cutting it is a no-op).
            const kickoffTools =
                item.kind === 'structure_seed'
                    ? reportToolsForStructureSeat(phraseStructureSeatOf(item.id).declaresChapterCount)
                    : REPORT_TOOLS;

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
                        kickoff: kickoffLine(kickoffTools),
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
                loopOutcome = await runAgentLoop(
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
                        kickoff: kickoffLine(kickoffTools),
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
            //
            // WHY THIS LINE NEEDS NO `ok` CHECK (it used to be where the refusal bug lived): both
            // executors now push into `tally.reports` only when the tool ANSWERED — the hand-written
            // loop at ./loop.ts and the engine's tool bridge at ./story-engine.ts each require
            // `result.ok !== false`. So "the terminal report was refused" arrives here already as an
            // empty `reports`, which is exactly what S-4's flag and the seat-owed decision want: a
            // pass that filed nothing OWES its seat again, whatever the model believed it filed.
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
            // A structured run states what it actually did: one validated turn, no tool calls. A
            // Critic pass that C2-AD3 ended early states THAT instead — checked ahead of the
            // natural-end pair, because `endCause` is only ever present on a single-agent run's
            // outcome (a D-38 panel answers with its own dissent sentence and its own member counts,
            // and a `toolMode: 'none'` run never enters the loop at all).
            //
            // THE THREE ENDINGS, IN THE ORDER THE ROW READS THEM: `reported` (a successful terminal
            // report), `capped` (the bound caught it, with a sentence of its own when the verdict was
            // REFUSED), and ended-without-a-successful-report ({@link END_UNREPORTED}) for a run that
            // closed on its own turn having filed nothing. The panel clause is appended to whichever
            // base sentence applies, because a panel's members each ended under their own policy while
            // the run as a whole ended naturally.
            const endCause = loopOutcome?.endCause;
            const panelClause = panelOutcome === undefined ? '' : panelMemberClause(panelOutcome);
            const endReason = structuredRun
                ? END_STRUCTURED
                : endCause?.kind === 'reported'
                  ? END_REPORTED(endCause)
                  : endCause?.kind === 'capped'
                    ? END_CAPPED(endCause)
                    : panelOutcome === undefined
                      ? noOp
                          ? END_UNREPORTED
                          : END_COMPLETED
                      : panelOutcome.dissent !== ''
                        ? `${END_COMPLETED}; panel disagreed — ${panelOutcome.dissent} (${String(
                              panelOutcome.answered
                          )} of ${String(scope.agents)} agents answered)${panelClause}`
                        : panelClause === ''
                          ? noOp
                              ? END_UNREPORTED
                              : END_COMPLETED
                          : END_PANEL(panelOutcome, scope.agents, noOp);

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

        // SUMMARY PHRASE (R2/R3/R5): the group model's two one-turn jobs. Both read the ITEM for what
        // they are about, exactly as the sampling pair does, so every pass of one batch renders
        // byte-identical bytes (§5's cache argument) and a restart recompiles the same prompt.
        //
        // PHRASE ② (T-W2): `templateSlug`/`roleName` are the item's OWN crew. The compiler decides what
        // to do with them (`phase1-prompt.ts:slugFor`): the Summary lane keeps the canonical slug from §8
        // — its `templateRef` is a template POOL pick, a scheduling fact, not the prompt's voice — while
        // Phrase ② resolves the crew its seats bound themselves to (`writer-plotlines-sampler`, the
        // rotating Critic angles, the general Editor for a contract lock). The PHRASE itself is never a
        // parameter: the compilers derive it from the group rows the item names, so a restart compiles the
        // same bytes without a Work Item field that could disagree with the rows (L-3).
        if (item.kind === 'draft_groups') {
            if (item.groupRefs === undefined || item.groupRefs.length === 0) {
                // A Writer with no group to write has no answer to give; refusing here keeps a batch
                // that empty from spending a run on `{"groups":[]}` (which the parser then refuses).
                throw new Error('a draft_groups item must name the groups it writes in groupRefs (§R2)');
            }

            return compileGroupDraftPrompt(this.store, item.storyId, {
                groupRefs: item.groupRefs,
                fixRefs: item.fixRefs,
                templateSlug: item.templateRef,
                roleName: item.roleName
            });
        }

        if (item.kind === 'review_groups') {
            return compileGroupReviewPrompt(this.store, item.storyId, {
                // An empty set is legal here (unlike a draft): a review with no group rows can only
                // report against the Seed, and the compiler says so in the prompt rather than throwing.
                groupRefs: item.groupRefs ?? [],
                fixRefs: item.fixRefs,
                templateSlug: item.templateRef,
                roleName: item.roleName
            });
        }

        // READER SCORING (D-65): the one-turn, no-tool score pass. Like the two above it reads the ITEM
        // for what it is about (byte-identical prompts, restartable), and unlike them it has no fix list:
        // a score is of the TEXT, and a pass shown the approved work would start grading the work.
        if (item.kind === 'score_sections') {
            if (item.groupRefs === undefined || item.groupRefs.length === 0) {
                // A Reader with no section in front of it has nothing to score, and an answer with no
                // group_ref is refused at settle anyway — refusing here is the cheaper, louder answer.
                throw new Error('a score_sections item must name the groups it scores in groupRefs (§D-65)');
            }

            return compileSectionScorePrompt(this.store, item.storyId, {
                groupRefs: item.groupRefs,
                // D-67: the hash the seat CLAIMED under, read back off the Work Item id — the same read
                // the engine's settle uses to stamp the score rows, so the compiler and the ledger name
                // one hash. The Reader is scored against the CLEAN selection that hash identifies, never
                // against whatever the live vector happens to be when the run starts: a Writer install
                // mid-queue changes the book, not the judgement this seat was armed for.
                vectorHash: sectionScoreVectorHashOf(item.id),
                // PHRASE ② (T-W2): the crew, phrase-resolved by the compiler (see the note above).
                templateSlug: item.templateRef,
                roleName: item.roleName
            });
        }

        // PHRASE GROUP LOCK (R-lock): the Editor's one-turn, no-tool judgement over ONE section. The
        // compiler reads the ITEM for both halves of its identity — the group the seat was claimed for
        // (`WorkItem.groupRefs`, exactly one) and the clean vector in its claim key — which is what keeps
        // a queued seat judging the Overview it was armed on rather than whatever the book looks like when
        // capacity frees up. A throw here is the seat's gate having gone (Setting off, selection advanced,
        // score scrapped): the run fails, the seat's key is spent, and the next clean vector asks again.
        if (item.kind === 'group_lock') {
            const refs = item.groupRefs ?? [];

            if (refs.length !== 1) {
                throw new Error(
                    `a group_lock item must name exactly one group in groupRefs, and this one named ${refs.length} — one seat decides one section (§R-lock)`
                );
            }

            return compileGroupLockPrompt(this.store, item.storyId, {
                groupRef: refs[0],
                vectorHash: groupLockSeatOf(item.id).vector_hash,
                // PHRASE ② (T-W2): the seat's own crew — `editor-group-lock` is the Summary's copy, and a
                // chapter seat runs on the general Editor (`slugFor` keeps the canonical slug for phase ①).
                templateSlug: item.templateRef,
                roleName: item.roleName
            });
        }

        if (item.kind === 'screen_samples') {
            if (item.revisionRef === undefined || item.revisionRef.length === 0) {
                // A screen with no draft can judge nothing; failing loudly beats an empty issue
                // list the selector would read as "this sample is clean" (§6.5).
                throw new Error('a screen_samples item must name the draft it judges in revisionRef (§6.4 step 4)');
            }

            // H1/R2 — the fix list travels on the ITEM, not on a store read: the queue recorded it when
            // it queued the pass, so (a) every pass of one round renders the same bytes (§5's cache
            // argument), and (b) the verdict the engine persists is graded against exactly the fixes
            // this Critic was handed (`WorkItem.fixRefs`).
            return compileScreenPrompt(this.store, item.storyId, item.revisionRef, { fixRefs: item.fixRefs });
        }

        // The round is on the item because it is not derivable from the store (§6.8): round 2+
        // must read the PREVIOUS round's selected revision, and only the sweep knows the round.
        return compileSamplePrompt(this.store, item.storyId, { round: item.round ?? 1, fixRefs: item.fixRefs });
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
     * one-turn sampling call can be MINUTES long on a local provider, and because no engine thread
     * exists for this mode, nothing beats for it: {@link completeStructured} owns the lease liveness
     * of its own request (S-4a). The run cannot host tools, but it is still working, and the retained
     * thread log below keeps the request/answer history complete (U-8).
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
            // tool surface and no `temperature` (§5's diversity is the `seed`, nothing else). The
            // call goes through `completeStructured`, which owns its lease liveness (S-4a).
            const response = await this.completeStructured(scope, {
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
     * One structured provider request, wrapped in the run's lease liveness (S-4a).
     *
     * THE BUG THIS CLOSES: a `toolMode: 'none'` run never enters the engine, and before this method
     * nothing between the row's `working` write and the provider's answer touched `updated_at`. The
     * sweep reads that column as the lease (`lapsedRuns`, server/loop/records.ts:1599; the 120s
     * default is `DEFAULT_LEASE_IDLE_MS`, server/loop/types.ts:307, applied at
     * server/loop/engine.ts:385), so a healthy model composing one long turn was killed as a dead
     * worker mid-request. The engine's stream adapter had already learned this lesson for tool runs
     * (server/run/story-engine.ts:714-750 beats around `chat.complete` and clears the interval in
     * `finally`); this is the same contract for the direct transport path.
     *
     * THE CONTRACT, in the order it happens:
     *   1. beat BEFORE dispatching, so the lease clock starts at the request rather than at the last
     *      row write — a request that takes 0ms and one that takes 600s start equally fresh;
     *   2. beat every RUN_HEARTBEAT_MS while the promise is pending, so the row is never silent for
     *      more than one cadence while work is genuinely in flight — slowness is never a fault;
     *   3. stop beating the MOMENT the request is over, by whichever ending arrives first: the
     *      provider answer, a provider fault, a cancellation (the Author's cord, a stopped Story, a
     *      caller-side lease expiry — the `abort` listener, because a signal is a request and an
     *      adapter may ignore it), or the ceiling;
     *   4. at STRUCTURED_REQUEST_MAX_MS of waiting, stop beating AND stop the run: the beat count is
     *      finite, and the deadline both aborts the request (releases the socket; the pinned client
     *      rethrows the cancellation, server/llm/client.ts:416) and settles this `await` through the
     *      race, so even a provider Promise that ignores its signal cannot keep the run — or the
     *      interval — alive forever.
     *
     * WHY A RACE AND NOT ONLY AN ABORT: `signal` asks, it does not command. Racing the ceiling is
     * what makes step 4 a finite guard rather than a polite suggestion, and it is the only place in
     * this file where a clock touches a run — E-0's "no timeout on a run" still holds, because this
     * caps ONE REQUEST, not the run's life and not its attempt count (which stays
     * STRUCTURED_ATTEMPTS, ./§4.2).
     */
    private async completeStructured(scope: RunScope, request: ChatRequest): Promise<ChatResponse> {
        this.heartbeat(scope, BEAT_REQUEST);

        // The tick budget IS the ceiling: 600_000 / 30_000 = 20 ticks, so the final beat lands at
        // t=570s and the ceiling fires at t=600s. Counting ticks instead of wall-clock elapsed keeps
        // the window exact under a test's fake clock — no `Date.now()` arithmetic, no drift, and no
        // minutes of real sleeping (the suites are deterministic by rule).
        let beatsLeft = Math.ceil(STRUCTURED_REQUEST_MAX_MS / RUN_HEARTBEAT_MS);
        let beating: ReturnType<typeof setInterval> | undefined;
        let settleCeiling!: (error: Error) => void;

        const ceiling = new Promise<never>((_resolve, reject) => {
            settleCeiling = reject;
        });

        beating = setInterval(() => {
            beatsLeft -= 1;

            if (beatsLeft > 0) {
                this.heartbeat(scope, BEAT_REQUEST);

                return;
            }

            // Step 4. Cleared here as well as in `finally`, so a beat can never fire after the run
            // has been told to stop.
            if (beating !== undefined) {
                clearInterval(beating);
                beating = undefined;
            }

            // `stopAtRequestCeiling` aborts, which fires `onStop` below; that listener settles the
            // ceiling with the very same error, so this second settle is a no-op by design.
            settleCeiling(this.stopAtRequestCeiling(scope));
        }, RUN_HEARTBEAT_MS);

        // Step 3's cancellation leg. The pinned client rejects when its signal aborts, so the race
        // would settle anyway — but a beat spent AFTER a kill is a lie to the sweep ("this run is
        // waiting on work"), and an adapter that ignored the signal would keep a stopped run looking
        // alive until the ceiling. Stopping on the abort tick is what makes "the heartbeat lives as
        // long as the request, and no longer" true for every transport, not only for ours.
        const onStop = (): void => {
            if (beating !== undefined) {
                clearInterval(beating);
                beating = undefined;
            }

            settleCeiling(signalReason(scope.controller.signal));
        };

        scope.controller.signal.addEventListener('abort', onStop, { once: true });

        try {
            // Dispatched INSIDE the try: `complete` returns a promise (a synchronous throw from an
            // adapter still becomes a rejection), and the `finally` below is the only thing allowed to
            // end the beating.
            const pending = this.chat.complete(request);

            // The race's loser must not become an unhandled rejection: once the ceiling has fired this
            // run is closing, and a provider that faults minutes later is a fault against a closed row.
            // Its tokens are lost by design — the row's total is written once, at teardown (S-3, S-6) —
            // which is the same accounting the abandoned rows carry today.
            pending.catch(() => undefined);

            return await Promise.race([pending, ceiling]);
        } finally {
            // R1's stop condition: completion, provider error, abort, Author stop and the ceiling all
            // pass through here, so neither the listener nor the interval outlives its own request (no
            // handle leak, and no beat landing in the gap before a schema-repair turn).
            scope.controller.signal.removeEventListener('abort', onStop);

            if (beating !== undefined) clearInterval(beating);
        }
    }

    /**
     * The ceiling fired: stop believing an unanswered request is a live worker, and name why the run
     * stopped (S-4a's worker-health distinction — `deadline`, not `lease`).
     *
     * ORDER MATTERS. The cause goes into `this.killed` while the signal is still clean, so
     * `execute`'s catch reaches `ABORT_TEXT.deadline` and the Author reads "its provider request
     * outlived the request-liveness ceiling" rather than "the lease lapsed". A stop that arrived
     * FIRST owns the row: an Author cord, a stopped Story, a directive, or a caller-side lease expiry
     * already recorded (or implied) its own reason, and the ceiling then only releases the request
     * (P8, S-3).
     */
    private stopAtRequestCeiling(scope: RunScope): Error {
        const error = new Error(
            `run ${scope.runId} ${ABORT_TEXT.deadline.abort}: ${scope.item.kind} waited ${STRUCTURED_REQUEST_MAX_MS}ms on model ${scope.model} for the ${scope.item.responseSchema?.name ?? 'structured'} answer`
        );

        // `name === 'AbortError'` is the portable discriminator for this codebase
        // (`isAbortError`, server/llm/client.ts:169) — `wasAborted` (./loop.ts:259) would also read
        // the aborted signal, but the error stays honest on its own.
        error.name = 'AbortError';

        if (scope.controller.signal.aborted) return error;

        this.killed.set(scope.runId, 'deadline');
        scope.controller.abort(error);

        return error;
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
     * S-4a: the lease heartbeat. It refreshes `updated_at` and nothing else, because the loop engine
     * reads that column as the lease — so a run that keeps working is fine however long it takes
     * (E-0). Two things fire it: every tool call (./loop.ts:228, ./panel.ts and the engine's tool
     * execution), and — since the structured-run fix — the pending provider request itself
     * ({@link completeStructured}). The `why` only labels the audit; the row write is the lease.
     *
     * A heartbeat write that fails is swallowed on purpose: losing one row update must not kill a run
     * that is otherwise fine, and the symptom of a persistently failing heartbeat is a lapsed lease,
     * which is the loop's own recovery path. That tolerance is also why the beat cadence is a third
     * of the idle lease rather than the whole of it.
     */
    private heartbeat(scope: RunScope, why = 'lease heartbeat — tool call (S-4a)'): void {
        try {
            this.store.runs.update(scope.runId, {}, { run_ref: scope.runId, why });
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
            // A sub-context may itself delegate (the built-in Writer template names `reader`);
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
     * so with an explicit empty list, e.g. `critic-genre.delegation: []`).
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
        // forbids explicitly (`critic-genre.delegation: []`), and T-6a's "every kind sees all
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
