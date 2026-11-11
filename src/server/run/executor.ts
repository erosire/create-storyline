// W5's spawner half: `RunExecutor` — one Work Item in, one closed run row out.
//
// WHAT THIS FILE OWNS (§9): the run row's whole life (S-1: spawn → work → report → teardown),
// the unconditional teardown (S-3), the no-op accounting (S-4), the lease heartbeat (S-4a), the
// Author's cord (P8 / U-7 kill), the delegated sub-context (D-17e / T-2b / S-7) and the panel
// (D-38). What it does NOT own: the queue and the lease themselves (W5's sweep claims Work Items
// and reads `updated_at`), the tools (T3), the loop's status machine (W4), and the brief's
// content (./brief, S-2).
//
// WHY THE RUN ROW EXISTS FROM BEFORE THE FIRST TOKEN (D-18): the crew panel is a list of run
// rows, and the Author's Stop has to have something to point at. So the row is created in
// `spawning` first, moves to `working` when the brief is in hand, to `reporting` when the first
// report tool lands (§9's report step), and to its end state exactly once — in `finally`, which
// is the mechanical form of S-3's "teardown is unconditional, including on failure, timeout and
// Author stop. No orphan sessions."
//
// WHY THERE IS NO TIMEOUT AND NO CAP HERE (E-0, S-4a): the only guard is the lease, and the
// lease is `runs.updated_at`, refreshed after every tool call by {@link heartbeat}. A four-hour
// run is fine while it keeps calling tools; a hung run stops refreshing and lapses (L-2), and
// the sweep re-adopts or abandons it (L-3).
import { LlmError, type ChatClient, type ToolSchema } from '../llm';
import { ROLE_KINDS, type RoleAggregation, type RoleKind, type Run, type RunDelegation } from '../../shared/types';
import { type Store, type UpdatePatch } from '../store';
import { buildBrief, type AssembledBrief } from './brief';
import { isReportTool, REPORT_TOOLS, toolsForRunKind } from './catalogue';
import { genericReasonerPrompt, resolveHarness, kickoffLine, type ResolvedHarness } from './harness';
import { createTally, runAgentLoop, wasAborted, type RunTally } from './loop';
import { type PanelOutcome, runPanel } from './panel';
import { resolveAggregation } from './types';
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
    briefing: AssembledBrief & { hash: string };
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

export class RunExecutor {
    private readonly store: Store;
    private readonly runtime: ToolRuntime;
    private readonly chat: ChatClient;
    private readonly defaultModel: string;

    /** Live runs this instance owns, so `kill(runId)` has something to abort (P8, U-7). */
    private readonly controllers = new Map<string, AbortController>();
    /** Runs the Author killed, kept so the teardown can name `killed` rather than a generic abort. */
    private readonly killed = new Set<string>();

    constructor(deps: RunExecutorDeps) {
        this.store = deps.store;
        this.runtime = deps.runtime;
        this.chat = deps.chat;
        this.defaultModel = deps.defaultModel;
    }

    // -------------------------------------------------------------------------
    // The Author's cord (P8, U-7)
    // -------------------------------------------------------------------------

    /**
     * Kills one live run. The abort surfaces as a cancellation in whatever the run is doing
     * (a chat request, between turns, or inside a tool call's next loop iteration), and the run
     * row closes as `abandoned` with `end_reason: killed` — teardown still runs, because S-3 has
     * no exception for a stop.
     *
     * A kill for a run this instance does not own is ignored: the sweep owns the lease, and a
     * server restart abandons stale rows on boot (L-3) rather than through this method.
     */
    kill(runId: string): void {
        const controller = this.controllers.get(runId);

        if (controller === undefined) return;

        this.killed.add(runId);

        const abort = new Error(`run ${runId} killed by the Author (P8, U-7)`);

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

        try {
            // S-2: the brief is assembled here, from the store alone — and BEFORE the loop
            // starts, because the run's whole memory has to exist before its first turn does.
            const briefing = buildBrief(this.store, item, harness);
            const agents = Math.max(1, harness.role?.agents ?? 1);
            const aggregate = resolveAggregation(agents, harness.role?.aggregate);
            const scope: RunScope = {
                runId,
                item,
                harness,
                model: harness.role?.model ?? this.defaultModel,
                controller,
                tally,
                context: undefined,
                briefing,
                agents,
                aggregate,
                // U-1e: the tool list is decided once, here, from the Work Item's kind — the loop,
                // the panel's agents and every delegate get this same list (see `RunScope.tools`).
                tools: toolsForRunKind(this.runtime.schemas(), item.kind),
                // §2: the Author-invoked run of §8.6 is the one run kind the audit has to label
                // separately, so the flag rides on the scope and reaches the session below.
                assistant: item.kind === 'assistant'
            };

            scope.context = this.runtime.createContext(this.sessionFor(scope), {
                // D-17e: the run answers its own `delegate` tool calls with an inner agent loop.
                delegate: (role, task) => this.delegate(scope, role, task)
            });

            // S-2 + §4.13: the brief's identity is recorded on the row the moment it exists, so
            // the Author can reconstruct what a finished run was told (D-12a's promise).
            this.store.runs.update(
                runId,
                { state: 'working', session_ref: `sess_${runId}`, brief_hash: briefing.hash },
                { run_ref: runId, why: `brief assembled and hashed (${briefing.hash.slice(0, 12)}…) — S-2` }
            );

            if (agents > 1) {
                // D-38: the role is a PANEL. The panel replaces this run's outer loop — it does
                // not run alongside one — so the loop still receives one report (S-1, D-38).
                panelOutcome = await runPanel(
                    { chat: this.chat, runtime: this.runtime },
                    {
                        brief: briefing.text,
                        kickoff: kickoffLine(REPORT_TOOLS),
                        model: scope.model,
                        roleName: scope.harness.roleName,
                        roleKind: scope.harness.kind,
                        templateRef: item.templateRef,
                        storyId: item.storyId,
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
                        heartbeat: () => this.heartbeat(scope),
                        onReport: () => this.markReporting(scope)
                    },
                    {
                        label: runId,
                        system: briefing.text,
                        kickoff: kickoffLine(REPORT_TOOLS),
                        model: scope.model,
                        context: scope.context,
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
            const noOp = tally.reports.length === 0;

            result = { runId, ended: 'completed', no_op: noOp, tokens: tally.tokens, toolsCalled: [...tally.executed] };
            // A panel that disagreed says so on the row too (D-38, U-8d): the dissent's home is the
            // `selection_note` the panel appended it to, and the row is where the crew panel looks.
            finalRow = {
                state: 'torn_down',
                ended_at: new Date().toISOString(),
                tokens: tally.tokens,
                no_op: noOp,
                end_reason:
                    panelOutcome === undefined || panelOutcome.dissent === ''
                        ? END_COMPLETED
                        : `${END_COMPLETED}; panel disagreed — ${panelOutcome.dissent} (${panelOutcome.answered} of ${scope.agents} agents answered)`
            };
        } catch (error) {
            const noOp = tally.reports.length === 0;

            if (wasAborted(error, controller.signal)) {
                // Two different causes, one state: the Author's cord says `killed`, everything
                // else (lease expiry, Story stop) is an abandonment the sweep can explain (S-4a, L-2).
                const killed = this.killed.has(runId);

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
                    end_reason: killed
                        ? 'killed — the Author pulled the cord (P8, U-7)'
                        : 'abandoned — the caller signal aborted (lease expiry or Story stop, S-4a)'
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
        }

        return result;
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
            { chat: this.chat, runtime: this.runtime, heartbeat: () => this.heartbeat(scope) },
            {
                label: `${scope.runId}#${role}`,
                system: inner ? inner.prompt : genericReasonerPrompt(role, task),
                kickoff: task,
                // A named role's own model when it exists; otherwise the run's model (T-6b: the
                // model is the template's setting, not this layer's choice).
                model: inner?.model ?? scope.model,
                context,
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
     * so with an explicit empty list, e.g. `reader-genre.delegation: []`), and a kind name is
     * always allowed because the delegation list may legitimately name a kind rather than a role.
     */
    private delegationAllowed(scope: RunScope, role: string): { allowed: boolean; reason?: string } {
        const declared = scope.harness.template?.delegation;

        // An absent `delegation` field is undeclared rather than forbidden: the built-in roster
        // forbids explicitly (`reader-genre.delegation: []`), and T-6a's "all four kinds see all
        // tools" applies to the catalogue, not to what a template chooses to fan out to.
        if (declared === undefined) return { allowed: true };
        if (declared.includes(role)) return { allowed: true };

        // A delegation list may name a KIND instead of a role name (T-0: `kind` is what selects
        // the permission row, and the inner agent inherits the parent's row either way).
        if ((ROLE_KINDS as readonly string[]).includes(role)) return { allowed: true };

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
