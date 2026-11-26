// The Critic termination policy (C2-AD3) — one harness plugin, one host-side ledger.
//
// WHY A PLUGIN IS THE ONLY SUPPORTED MECHANISM. A Critic review pass was measured at 6–17 minutes
// and 200k–380k TOKENS per pass (12 deep passes = 86.8% of a whole run's tokens), because the loop
// has no iteration cap (`run/loop.ts:10-15` "NO ITERATION CAP") and ends only when the model returns
// a turn with no `tool_calls`. The alternatives were all rejected on the evidence:
//
//   - `agent({ maxIterations })` / the harness default (`Infinity`) is resolved ONCE at harness
//     construction and applies to EVERY employee, so capping it would cap Writers, Editors, Readers
//     and the structured path too — E-0/S-4a forbid a run bound for those roles.
//   - `HarnessRunOptions` is only `{ signal, attachments }` — there is no per-run turn bound.
//   - Aborting the run's own signal would classify the pass as `killed`/`abandoned`, which is the
//     misreport C2-AD3 exists to fix: the pass CONCLUDED, and its filed verdict is the result.
//
// What IS available is a plugin on `HarnessConfiguration.plugins`: `turn.before` is the only hook
// whose return value the engine honours, and `HarnessTurnDecision`'s `{ action: 'stop', reason }`
// ends the RUN at that boundary (`src/engine/harness.ts:14199-14240` — `stopThreadState`, then
// `throwIfAborted`). Three facts this file depends on, all pinned by probe on this checkout:
//
//   1. `turn.after` fires AFTER the assistant message commits and BEFORE any tool launches. That is
//      why a report is NOT classified from it: the committed `toolCalls` are the model's REQUEST to
//      file, and a report tool can still refuse that call (`{ ok: false }`, T-1a). Classifying from
//      the request armed `reported` on a refusal, the stop was taken at the next `turn.before`, and
//      the model never saw the refusal — the whole pass ended having filed nothing while the row
//      claimed it had reported. So detection moved to the tool's RESULT, which the host hands this
//      plugin through `handle.toolResult(threadId, tool, ok)`: `run/story-engine.ts`'s tool bridge
//      observes the real `ToolResult` (`story-engine.ts:executeInRun`) between `turn.after` and the
//      next `turn.before`, which is exactly the window the stop is taken in. The consequence a host
//      must respect: WITHOUT that call the plugin never arms — a pass it cannot see the outcome of
//      runs to its cap rather than being ended on a promise. `StoryHarness` is that host, and it
//      calls it for every executed tool of every thread.
//   2. `turn.after` still carries the committed message, so the turn counter and the last prose are
//      kept there. Stopping at `turn.before` issues NO further model turn: the transcript keeps
//      `user / assistant / tool` and the model is never asked again (verified: 1 model turn issued,
//      stop taken at iteration 2). And because a REFUSED report no longer arms the stop, the model
//      gets exactly the turn the refusal needs — the refusal is committed as the tool's own message,
//      so it is inside the run, which is what `tools/reader.ts`'s contract promises.
//   3. A plugin `stop` REJECTS `sendThreadInput` with a `HarnessError` whose message is the plugin's
//      own `reason`, and stamps the thread record `stopReason: 'plugin-parked'`. The rejection
//      carries no machine-readable code, so the host must not string-match it: THIS file records the
//      stop in a ledger the host reads back by thread id (`ledger.take(threadId)`), which is why the
//      plugin and the ledger are built together here.
//
// WHAT COUNTS AS "reported". `isReportTool` (../catalogue, S-4's closed list) answers "did this pass
// do work the loop must not re-dispatch". The TERMINAL call is narrower on purpose: C2-AD3 names
// `submitVerdict` as the one call that carries the review's verdicts and findings, so filing it ends
// the pass. A critic that files `raiseFinding`/`proposeIdea` and keeps reading has reported
// something but has NOT concluded: it gets ONE nudge and then the turn cap, which is objective 2's
// "it used raiseFinding and hasn't concluded" case.
//
// THREE ENDINGS, AND THE REFUSAL THAT IS NONE OF THEM. The vocabulary stays three-valued on purpose:
// `reported` (a successful terminal report), `capped` (the bound caught it), and "still running — its
// report was refused". A refusal is recorded in `refusals` and folds into neither kind. A pass that
// ends capped with `refusals: ['submitVerdict']` is a pass that TRIED to answer and was refused; a
// pass with `reports: []` never answered. The run row has to tell those apart, because the
// seat-owed decision (S-4's `no_op`) reads the row.
//
// ROLE SCOPE. Every decision here is gated on `payload.agent === 'critic'` (the engine's agent key
// IS Storyline's `roleKind` — `run/story-engine.ts:832`), and the hook returns `undefined` for every
// other employee, so a Writer, Editor, Reader or Researcher run is untouched.
import type { HarnessMessage, HarnessPlugin, HarnessPluginApi } from '@underload/harness';
import type { RoleKind } from '../../../shared/types';
import { isReportTool } from '../catalogue';

/** The only employee kind this policy acts on (V-1: the engine profile key). */
export const CRITIC_ROLE_KIND: RoleKind = 'critic';

/**
 * The hard bound on model turns for ONE Critic review pass, in force when the host sets no cap.
 *
 * WHY 24. The measured legitimate deep-review pass costs 200k–380k tokens. Storyline's Critic brief
 * is one system turn plus its own reads, so a pass re-sends a context that grows roughly 30–50k
 * tokens per turn: 380k / ~40k ≈ 9–12 model turns for the most expensive honest pass, and the
 * verdict is normally filed in 3–6 turns (read the unit, read the criteria, file). 24 is therefore
 * ~2x the worst observed legitimate pass — wide enough that no pass C2-AD3 wants to keep is ever cut
 * short, tight enough that a pass which has read 24 turns' worth and still has no verdict is the
 * runaway the acceptance criteria name, and the ceiling bounds its cost at roughly the same order as
 * the passes it replaces rather than at `Infinity`.
 *
 * E-0/S-4a's "no timeout, no retry cap" stays intact for every other role: this is a bound on ONE
 * kind's review turns, not a clock on the run, and nothing here aborts a run that keeps working.
 */
export const CRITIC_REVIEW_TURN_CAP = 24;

/** The operator override for {@link CRITIC_REVIEW_TURN_CAP}, read once at harness construction. */
export const CRITIC_TURN_CAP_ENV = 'STORYLINE_CRITIC_TURN_CAP';

/**
 * The cap in force for this process: {@link CRITIC_REVIEW_TURN_CAP} unless the operator set
 * `STORYLINE_CRITIC_TURN_CAP` to a positive integer. A malformed value falls back to the default
 * rather than failing the boot, and `Number.MAX_SAFE_INTEGER` is the widest thing a host can ask for
 * (it is the "effectively unbounded" spelling, and it is still finite).
 */
export const criticTurnCapFromEnvironment = (fallback: number = CRITIC_REVIEW_TURN_CAP): number => {
    const raw = process.env[CRITIC_TURN_CAP_ENV];

    if (raw === undefined || raw.trim() === '') return fallback;

    const parsed = Number.parseInt(raw.trim(), 10);

    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * The call that ENDS a Critic review pass: the one terminal report C2-AD3 describes. Kept narrow and
 * named apart from S-4's wider `REPORT_TOOLS` list, because `raiseFinding` and `proposeIdea` are
 * partial reports — a critic that filed one finding has not answered the job it was dispatched for.
 */
export const CRITIC_TERMINAL_REPORT_TOOLS = ['submitVerdict'] as const;

/** Whether this tool call is the Critic's terminal report. */
export const isTerminalCriticReport = (name: string): boolean =>
    (CRITIC_TERMINAL_REPORT_TOOLS as readonly string[]).includes(name);

/**
 * The single soft nudge (objective 2). Injected as a `user` turn at the next `turn.before` AFTER a
 * report has SUCCEEDED and BEFORE the cap is reached, so the pass gets exactly one chance to file
 * its verdict on its own terms. The engine applies a `turn.before` transcript override to the
 * REQUEST only — the injected line is never committed to the canonical transcript — which is what
 * makes "at most once" structural rather than a bookkeeping hope. `run/loop.ts`'s fallback loop owns
 * its own transcript, so it injects the same way: into the ONE request, never into the history it
 * carries forward. A refused report does NOT arm the nudge — the refusal is already the message the
 * model has to answer, and telling it to "conclude now" would lecture it past its own error.
 */
export const CRITIC_CONCLUDE_NUDGE =
    '[critic pass] You have already filed a report. Conclude now: no more reading, searching or ' +
    'listing. File your verdict with `submitVerdict` on this turn and give your answer — if you keep ' +
    'reading, this pass ends at its review-turn cap without its verdict (C2-AD3).';

/** How the pass ended: by its own terminal report, or because the cap caught it. */
export type CriticTerminalKind = 'reported' | 'capped';

/** What the plugin decided about one Critic thread, for the host to record truthfully. */
export interface CriticTerminalRecord {
    /** `reported` = it filed its terminal report; `capped` = the review-turn cap ended it. */
    kind: CriticTerminalKind;
    thread_id: string;
    /** Model turns the pass actually issued before the stop was taken. */
    turns: number;
    /** The cap that was in force (both kinds carry it, so a host never has to guess). */
    cap: number;
    /** Every report tool the pass FILED — a refused call is not here (S-4's classification). */
    reports: string[];
    /**
     * Every report tool the pass called and had REFUSED, in call order. Omitted when the pass was
     * never refused, so a clean record stays byte-exact: the distinction the row has to keep is
     * "filed", "refused", and "never asked", and folding a refusal into `reports` is the defect this
     * field replaces.
     */
    refusals?: string[];
    /** The terminal tool name, present only for a `reported` stop. */
    terminal_tool?: string;
    /** The last assistant prose the pass committed — its answer, kept instead of discarded. */
    final_text: string;
    /** Whether the soft nudge was injected. */
    nudged: boolean;
    /** The sentence handed to the engine's `stop` decision, and to the rail. */
    reason: string;
}

/** Live per-thread observation while a Critic pass runs (the test surface for the nudge rules). */
export interface CriticPassObservation {
    turns: number;
    reports: string[];
    refusals: string[];
    nudges: number;
}

export interface CriticTerminationLedger {
    /** The stop this plugin performed for a thread — consumed once, so no later run inherits it. */
    take: (threadId: string) => CriticTerminalRecord | undefined;
    /** What the pass has done so far. Read-only, and absent for a thread this policy never watched. */
    observe: (threadId: string) => CriticPassObservation | undefined;
    /** Drops every trace of a finished thread. The host calls it in its `finally`. */
    release: (threadId: string) => void;
}

export interface CriticTerminationHandle {
    /** The plugin to hand to `HarnessConfiguration.plugins`. */
    plugin: HarnessPlugin;
    /** The host-side record of the stops this plugin performed. */
    ledger: CriticTerminationLedger;
    /** The cap in force for this plugin instance. */
    cap: number;
    /**
     * THE POLICY'S ONLY EYES ON A TOOL CALL: the host reports what a call ANSWERED, and that — never
     * the model's request — is what arms the stop. Call it for every executed tool of every thread;
     * the policy ignores names outside S-4's report list and threads it never watched as a Critic's.
     *
     * `ok` is the tool layer's own verdict (`ToolResult.ok`, T-1a), not the transport's: the harness
     * classifies a `{ ok: false }` refusal as a COMPLETED call (`core/tool-outcome.ts` — only a throw
     * or an over-cap delivery is `failed`), so `tool.after`'s `isError` cannot see a Storyline
     * refusal. The host that holds the real `ToolResult` is the layer that has to say.
     */
    toolResult: (threadId: string, tool: string, ok: boolean) => void;
}

/**
 * One harness can host several Critic threads at once (a D-38 critic panel, a delegated Critic, two
 * concurrent Work Items), so per-thread state is keyed by engine thread id and never global. The
 * map is bounded oldest-first: the host releases each thread in its `finally`, and the ceiling is
 * the belt that keeps a leaked key from growing forever if some future path forgets to.
 */
const MAX_TRACKED_THREADS = 512;

interface CriticThreadState {
    turns: number;
    /** Report tools that ANSWERED `ok` — the only list that arms the nudge or the stop. */
    reports: string[];
    /** Report tools the pass called and the tool layer REFUSED (`{ ok: false }`, T-1a). */
    refusals: string[];
    terminalTool?: string;
    nudges: number;
    finalText: string;
    reported: boolean;
}

export interface CriticTerminationOptions {
    /** Model-turn bound for one review pass. Defaults to {@link criticTurnCapFromEnvironment}. */
    cap?: number;
}

/**
 * Builds the plugin plus the ledger it writes. One pair per Story harness — the harness is the scope
 * the state belongs to, because Storyline never shares a thread between Stories.
 */
export const createCriticTerminationPlugin = (
    options: CriticTerminationOptions = {}
): CriticTerminationHandle => {
    const cap = options.cap ?? criticTurnCapFromEnvironment();
    const threads = new Map<string, CriticThreadState>();

    // Created on first sight of a Critic turn, and only ever for a Critic (`agent === 'critic'`),
    // which is what keeps every other employee's thread out of this map entirely.
    const stateOf = (threadId: string): CriticThreadState => {
        const existing = threads.get(threadId);

        if (existing !== undefined) return existing;

        // Oldest-first eviction: `Map` iteration order is insertion order, so the FIRST key is the
        // thread this policy finished watching longest ago. A `for...of` with a break is the first
        // key without leaning on `IteratorResult` narrowing (this package's `lib` is pre-ES2022).
        if (threads.size >= MAX_TRACKED_THREADS) {
            for (const oldest of threads.keys()) {
                threads.delete(oldest);
                break;
            }
        }

        const created: CriticThreadState = {
            turns: 0,
            reports: [],
            refusals: [],
            nudges: 0,
            finalText: '',
            reported: false
        };
        threads.set(threadId, created);

        return created;
    };

    // The terminal records, kept APART from the live state so a stop taken at `turn.before` survives
    // until the host reads it: the plugin's `stop` makes `sendThreadInput` reject, and the host's
    // catch runs after every hook. Without this the host would see a bare rejection and record the
    // pass as `failed`, which is exactly the misreport C2-AD3 exists to fix.
    const terminals = new Map<string, CriticTerminalRecord>();

    // The terminal tool the pass called and never got filed: refused at least once, and never
    // SUCCEEDED afterwards. That last clause is the whole difference between "the verdict was refused"
    // (the correction turn was wasted) and "the verdict was refused, then fixed" (it was not), and it
    // is why `refusals` and `reports` are separate lists rather than one list with a flag.
    const terminalRefusalOf = (state: CriticThreadState): string | undefined =>
        CRITIC_TERMINAL_REPORT_TOOLS.find((name) => state.refusals.includes(name) && !state.reports.includes(name));

    const recordOf = (threadId: string, state: CriticThreadState, kind: CriticTerminalKind): CriticTerminalRecord => {
        const terminalTool = state.terminalTool;
        const refusedTerminal = terminalRefusalOf(state);

        return {
            kind,
            thread_id: threadId,
            turns: state.turns,
            cap,
            reports: [...state.reports],
            ...(state.refusals.length === 0 ? {} : { refusals: [...state.refusals] }),
            ...(kind === 'reported' && terminalTool !== undefined ? { terminal_tool: terminalTool } : {}),
            final_text: state.finalText,
            nudged: state.nudges > 0,
            // The prose the engine puts on the rejection, and which `run/story-engine.ts` keeps on
            // the capped thread's record so the rail can say what actually happened. The capped
            // sentence has TWO spellings, because the two facts are different: a pass that never
            // called its verdict is not the same run as one whose verdict was refused and never
            // fixed, and the Author reads this line to know which of them happened.
            reason:
                kind === 'reported'
                    ? `the Critic filed its report (${terminalTool ?? state.reports.join(', ')}) at model turn ${String(
                          state.turns
                      )} — the pass is complete (C2-AD3)`
                    : refusedTerminal === undefined
                      ? `the Critic review pass reached its ${String(cap)}-model-turn cap without filing its verdict (C2-AD3)`
                      : `the Critic review pass reached its ${String(cap)}-model-turn cap with its ${refusedTerminal} report refused and never filed (C2-AD3)`
        };
    };

    // Stamps the record and returns it, so the hook's `reason` and the host's record are the same
    // sentence and cannot drift apart.
    const takeTerminal = (threadId: string, kind: CriticTerminalKind, state: CriticThreadState): CriticTerminalRecord => {
        const record = recordOf(threadId, state, kind);

        terminals.set(threadId, record);

        return record;
    };

    // THE CLASSIFICATION, Fed by the host. A report tool's RESULT is the only thing that can say
    // whether a Critic pass filed anything: `turn.after`'s `toolCalls` are the model's request, the
    // tool layer may refuse it with `{ ok: false }` (T-1a), and the harness reports such a call as a
    // COMPLETED delivery (`core/tool-outcome.ts`), so nothing the hooks carry can see the refusal.
    //
    // Two rules, both load-bearing:
    //   - Only a thread this policy already watched as a Critic's is touched (`threads.get`, NOT
    //     `stateOf`): a Writer's `submitVerdict` must not open state, which is what keeps every other
    //     employee out of the map entirely (the role gate is one mechanism, not two).
    //   - A success ARMS; a refusal only RECORDS. The pass that is refused keeps its turn, because
    //     the refusal is committed as that call's own tool message and the model answers it.
    const toolResult = (threadId: string, tool: string, ok: boolean): void => {
        const state = threads.get(threadId);

        if (state === undefined || !isReportTool(tool)) return;

        if (!ok) {
            // Deduped like `reports`: the row names WHICH report the pass could not file, and "three
            // times" is the same fact as "once" for that sentence.
            if (!state.refusals.includes(tool)) state.refusals.push(tool);

            return;
        }

        if (!state.reports.includes(tool)) state.reports.push(tool);

        // S-4's list decides "this pass reported something"; the narrow terminal set decides "this
        // pass is DONE", and only a call that ANSWERED belongs in either.
        if (isTerminalCriticReport(tool)) {
            state.terminalTool = tool;
            state.reported = true;
        }
    };

    const setup = (api: HarnessPluginApi): void => {
        // OBSERVE. `turn.after` hands over the committed assistant message before any tool launches.
        // This hook no longer decides anything about reports — it keeps the two facts the stop needs
        // that are NOT a tool outcome: how many turns the pass ran, and the prose it last committed,
        // so a stopped pass answers with what it wrote instead of reporting an empty answer.
        api.on('turn.after', (payload) => {
            if (payload.agent !== CRITIC_ROLE_KIND || payload.threadId === undefined) return;

            const state = stateOf(payload.threadId);

            state.turns = Math.max(state.turns, payload.iteration);

            const text = payload.message.content ?? '';

            if (text.trim() !== '') state.finalText = text;
        });

        // DECIDE. `turn.before` is the one hook whose return value ends a run, and it is also the
        // boundary where the reporting turn's tool calls have already been executed and committed —
        // so the filed verdict survives the stop and no further model request is issued.
        api.on('turn.before', (payload) => {
            if (payload.agent !== CRITIC_ROLE_KIND) return;

            const state = stateOf(payload.threadId);

            // `iteration` is the 1-based number of the turn ABOUT to be sent, so the turns already
            // issued are `iteration - 1`. Keeping the counter current is what makes `take()` and the
            // capped sentence report the true turn count.
            state.turns = Math.max(state.turns, payload.iteration - 1);

            // 1. A SUCCEEDED terminal report: end the pass on the spot (objective 1). Checked first so
            //    a verdict filed on the same turn the cap would have caught it still records as
            //    `reported`. A REFUSED one never reaches here — `toolResult` armed nothing — so the
            //    model keeps its turn and answers the refusal the tool committed.
            if (state.reported) {
                const record = takeTerminal(payload.threadId, 'reported', state);

                return { decision: { action: 'stop', reason: record.reason } };
            }

            // 2. Hard cap (objective 2): the pass has spent its bound and still has no verdict.
            if (payload.iteration > cap) {
                const record = takeTerminal(payload.threadId, 'capped', state);

                return { decision: { action: 'stop', reason: record.reason } };
            }

            // 3. Soft nudge, once, and only after a report SUCCEEDED. `state.nudges` is the guard; a
            //    second injection is impossible by construction. A refusal does not arm it: the
            //    refusal is already the message the model has to answer.
            if (state.reports.length > 0 && state.nudges === 0) {
                state.nudges += 1;

                // The request the model is about to receive, plus one instruction. `currentMessages()`
                // is the projection AFTER any earlier hook in this round (compaction included), so the
                // nudge rides on top of what the round already decided instead of undoing it.
                const transcript: HarnessMessage[] = [
                    ...payload.currentMessages(),
                    { role: 'user', content: CRITIC_CONCLUDE_NUDGE }
                ];

                return { decision: { action: 'replace', transcript } };
            }

            // 4. Everything else: say nothing, change nothing.
            return undefined;
        });
    };

    const plugin: HarnessPlugin = {
        name: 'critic-termination',
        metadata: {
            name: 'critic-termination',
            title: 'Critic Termination',
            description:
                'Ends a Critic review pass once its verdict is FILED (refusing it leaves the model its ' +
                'correction turn), nudges it once when it keeps reading after a partial report, and ' +
                'bounds its review turns (C2-AD3).',
            version: '1.0.0',
            tags: ['storyline', 'policy', 'lifecycle'],
            builtin: false,
            hooks: ['turn.before', 'turn.after']
        },
        setup
    };

    const ledger: CriticTerminationLedger = {
        // A stop is recorded in `terminals` (built apart from the live state, so it survives the
        // rejection) and CONSUMED here: one conclusion, one read, so no later run on the same thread
        // id could inherit it.
        take: (threadId: string) => {
            const terminal = terminals.get(threadId);

            if (terminal === undefined) return undefined;

            terminals.delete(threadId);

            return terminal;
        },
        observe: (threadId: string) => {
            const state = threads.get(threadId);

            return state === undefined
                ? undefined
                : {
                      turns: state.turns,
                      reports: [...state.reports],
                      refusals: [...state.refusals],
                      nudges: state.nudges
                  };
        },
        release: (threadId: string) => {
            threads.delete(threadId);
            terminals.delete(threadId);
        }
    };

    return { plugin, ledger, cap, toolResult };
};
