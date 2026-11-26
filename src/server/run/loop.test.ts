// Acceptance for the one turn engine ./loop — the code every fresh context runs (the dispatched
// run, a D-38 panel agent, a D-17e sub-context).
//
// The pinned behaviours here are the ones the spec makes load-bearing:
//   T-6a   the whole catalogue is declared on EVERY request, so a fresh context sees its tools on
//          turn one and never pays a discovery round trip.
//   S-2    the brief is the history: the conversation starts from the system turn and nothing else.
//   S-4    the run ends when the model stops calling tools — nothing else ends it (E-0: no cap),
//          except C2-AD3's Critic policy, which ends a review pass at the report it files and bounds
//          its review turns (the last block below).
//   T-4/T-7/T-8 the tool result is serialised WHOLE, so `currents` and `rev` reach the model.
//   T-11   a malformed `arguments` payload is a refusal the model can correct inside the same turn,
//          not a run failure.
//   S-4a   the lease heartbeat fires after every tool call, including an intercepted proposal.
//   D-38   an intercepted proposal is not an execution and does not clear the no-op flag.
import { MockChatClient, calls, msg } from '../llm';
import type { ChatRequest, ChatResponse } from '../llm';
import { Store } from '../store';
import { createTally, runAgentLoop, wasAborted } from './loop';
import { MockToolRuntime, seedStory } from './mock';
import { interceptingRuntime } from './panel';
import type { PanelProposal } from './panel';
import { CRITIC_CONCLUDE_NUDGE, CRITIC_REVIEW_TURN_CAP } from './plugins/critic-termination';
import type { RunToolContext, RunToolSession } from './types';

/** The session a loop runs as — T3's five bound fields (T-3). */
const SESSION: RunToolSession = {
    storyId: 'story_0',
    runId: 'run_0',
    runRef: 'run_0',
    sessionRef: 'sess_run_0',
    templateRef: 'writer-prose',
    roleName: 'writer',
    roleKind: 'writer'
};

/** A tiny fixed tool whose result is asserted byte for byte (T-7: bounded and structured). */
const PING_RESULT = { ok: true, data: { pong: true }, rev: 1 };

function harness(turns: Array<(request: ChatRequest) => ChatResponse>) {
    const store = Store.empty();
    const story = seedStory(store);
    const runtime = new MockToolRuntime(store, story.id, { ping: () => PING_RESULT });
    const requests: ChatRequest[] = [];
    const client = new MockChatClient((request, state) => {
        requests.push(request);

        const turn = turns[state.callIndex];

        if (turn === undefined)
            throw new Error(
                `no scripted turn for call ${state.callIndex} (the loop asked more times than the test scripted)`
            );

        return { ...turn(request), usage: { input: 100, output: 40, cached_input: 0 } };
    });

    return { store, story, runtime, client, requests, context: runtime.createContext(SESSION) };
}

/** The loop's spec, with the context supplied — the only field a caller cannot know in advance. */
const specFor = (context: RunToolContext) => ({
    label: 'run_0',
    system: 'THE BRIEF',
    kickoff: 'Carry out THE JOB.',
    model: 'gpt-5',
    context
});

describe('loop — the turn engine (S-2, S-4, T-6a, T-4, T-11, S-4a)', () => {
    it('asks once with the whole catalogue and ends when the model stops calling tools (T-6a, S-4, E-0)', async () => {
        const h = harness([() => ({ message: msg({ content: 'Nothing left to report.' }) })]);
        const tally = createTally();

        const outcome = await runAgentLoop({ chat: h.client, runtime: h.runtime }, specFor(h.context), tally);

        expect(outcome).toEqual({ text: 'Nothing left to report.', turns: 1 });
        // T-6a: a role-blind catalogue on turn one — every tool the session holds, declared upfront.
        expect(h.requests[0].tools).toEqual(h.runtime.schemas());
        expect(h.requests[0].model).toBe('gpt-5');
        // S-2: the brief IS the memory — the system turn plus the ask, and no prior conversation.
        expect(h.requests[0].messages).toEqual([
            { role: 'system', content: 'THE BRIEF' },
            { role: 'user', content: 'Carry out THE JOB.' }
        ]);
        // S-6: recorded, never read as a limit (E-0).
        expect(tally).toEqual({ tokens: 140, executed: [], reports: [] });
    });

    it('feeds every tool result back whole, in wire shape, and records what executed (T-4, T-7, T-8, S-4a)', async () => {
        const h = harness([
            () => ({
                message: msg({
                    toolCalls: calls([
                        { name: 'ping', args: {} },
                        { name: 'readSeed', args: {} }
                    ])
                })
            }),
            () => ({ message: msg({ content: 'Reported.' }) })
        ]);
        const tally = createTally();
        const heartbeats: number[] = [];

        const outcome = await runAgentLoop(
            { chat: h.client, runtime: h.runtime, heartbeat: () => heartbeats.push(1) },
            specFor(h.context),
            tally
        );

        expect(outcome).toEqual({ text: 'Reported.', turns: 2 });
        // S-4a: one lease refresh per tool call. That count IS the contract — it is what keeps a
        // four-hour run alive and lets a hung one lapse (E-0, L-2).
        expect(heartbeats).toEqual([1, 1]);

        const history = h.requests[1].messages;

        // An assistant turn that carries only tool calls still holds a STRING content (the note the
        // client author pins), plus the calls in the OpenAI wire shape.
        expect(history[2]).toEqual({
            role: 'assistant',
            content: '',
            tool_calls: [
                { id: 'call_1', name: 'ping', arguments: '{}' },
                { id: 'call_2', name: 'readSeed', arguments: '{}' }
            ]
        });
        // The WHOLE result object, keys in the order the tool wrote them: T-8's `rev` and T-4's
        // `currents` must reach the model or the next `expects` is a guess.
        expect(history[3]).toEqual({
            role: 'tool',
            content: '{"ok":true,"data":{"pong":true},"rev":1}',
            tool_call_id: 'call_1'
        });
        expect(history[4].role).toBe('tool');
        expect(JSON.parse(String(history[4].content))).toEqual({ ok: true, data: { seed: h.story.idea }, rev: 1 });

        expect(tally.executed).toEqual(['ping', 'readSeed']);
        expect(tally.reports).toEqual([]);
        expect(tally.tokens).toBe(280);
    });

    it('turns a malformed arguments payload into a refusal the model sees, not a run failure (T-11)', async () => {
        const h = harness([
            () => ({ message: { content: '', tool_calls: [{ id: 'call_1', name: 'ping', arguments: '{oops' }] } }),
            () => ({ message: msg({ content: 'Fixed it.' }) })
        ]);
        const tally = createTally();

        const outcome = await runAgentLoop({ chat: h.client, runtime: h.runtime }, specFor(h.context), tally);

        expect(outcome).toEqual({ text: 'Fixed it.', turns: 2 });

        const refusal = JSON.parse(String(h.requests[1].messages[3].content)) as { ok: boolean; error: string };

        expect(refusal.ok).toBe(false);
        expect(refusal.error).toContain('— T-11');
        expect(refusal.error.startsWith('arguments were not valid JSON (')).toBe(true);
        // Nothing executed; the run kept going, which is the whole point of T-11's placement.
        expect(tally.executed).toEqual([]);
    });

    it('never counts an intercepted D-38 proposal as an execution or a report (S-4, D-38)', async () => {
        const h = harness([
            () => ({
                message: msg({
                    toolCalls: calls([
                        { name: 'readSeed', args: {} },
                        { name: 'submitVerdict', args: { target_ref: 'chapter_1' } }
                    ])
                })
            }),
            () => ({ message: msg({ content: 'done' }) })
        ]);
        const proposals: PanelProposal[] = [];
        // Inside a panel agent a mutating call is a proposal: it must not land, must not be listed as
        // executed, and must not clear the run's S-4 no-op flag on its own.
        const intercepted = interceptingRuntime(h.runtime, 1, proposals);
        const tally = createTally();
        const reported: string[] = [];

        await runAgentLoop(
            { chat: h.client, runtime: intercepted, onReport: (name) => reported.push(name) },
            specFor(h.context),
            tally
        );

        expect(proposals).toEqual([{ tool: 'submitVerdict', args: { target_ref: 'chapter_1' } }]);
        expect(tally.executed).toEqual(['readSeed']);
        expect(tally.reports).toEqual([]);
        expect(reported).toEqual([]);
        // The agent is told its write was RECORDED rather than applied, so it does not retry a write
        // it believes happened (T-1a's visible-refusal principle applied to a proposal).
        expect(JSON.parse(String(h.requests[1].messages[4].content))).toEqual({
            ok: true,
            summary:
                "recorded as agent 1's proposal — the run aggregates its panel and executes one winning set (D-38)",
            proposed: true
        });
        // The read still executed for real — a panel agent that cannot read cannot judge (D-38).
        expect(h.runtime.calls.map((call) => call.name)).toEqual(['readSeed']);
    });

    it('throws the signal’s own reason when the run is stopped between turns, and recognises it (P8, S-3)', async () => {
        const controller = new AbortController();
        const h = harness([
            () => {
                controller.abort(
                    Object.assign(new Error('run run_0 killed by the Author (P8, U-7)'), { name: 'AbortError' })
                );

                return { message: msg({ toolCalls: calls([{ name: 'ping', args: {} }]) }) };
            },
            () => ({ message: msg({ content: 'never asked' }) })
        ]);

        await expect(
            runAgentLoop(
                { chat: h.client, runtime: h.runtime },
                { ...specFor(h.context), signal: controller.signal },
                createTally()
            )
        ).rejects.toThrow('run run_0 killed by the Author (P8, U-7)');

        // The kill landed before the second request, so the run spent exactly one turn (P8: the cord
        // works between turns, not only inside the transport).
        expect(h.client.callCount).toBe(1);

        expect(wasAborted(Object.assign(new Error('aborted'), { name: 'AbortError' }), controller.signal)).toBe(true);
        // An aborted signal is enough on its own: the reason may be any value the host chose.
        expect(wasAborted(new Error('provider fault'), controller.signal)).toBe(true);
        expect(wasAborted(new Error('provider fault'), new AbortController().signal)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// C2-AD3 — a Critic review pass ENDS when it files its report
//
// Why these are asserted on the fallback loop as well as on the engine path (./story-engine.test.ts):
// the shipped server runs the engine and its `critic-termination` plugin, but this file's loop is
// what a caller without an engine gets, and the two must not hold different contracts. The assertions
// below therefore read the same three facts the acceptance criteria name — the turn count, the cause
// recorded on the outcome, and the nudge's position in the transcript — and never the plugin's
// internals.
// ---------------------------------------------------------------------------

/** What the report tools answer in this file: flat, `proposed`-free, so the loop counts them as filed. */
const VERDICT_RESULT = { ok: true, id: 'verdict_0', rev: 1 };
const FINDING_RESULT = { ok: true, id: 'finding_0', rev: 1 };

/**
 * The same harness as above, with the two report tools pinned to fixed answers — used by BOTH the
 * Critic tests and the paired Writer test, so the only variable left is the kind.
 *
 * WHY NOT `./mock`'s own `submitVerdict`/`raiseFinding`: W3b owns those doubles and is rewriting them
 * right now to carry the terminal report's extra `verdicts[]`/`findings[]`. This loop's acceptance is
 * about WHEN it stops, not about the row shape a report returns, so the tools are stubbed to the flat
 * `{id, rev}` answer; the store-writing assertions live in ./executor.test.ts instead.
 */
function reportHarness(turns: Array<(request: ChatRequest) => ChatResponse>) {
    const store = Store.empty();
    const story = seedStory(store);
    const runtime = new MockToolRuntime(store, story.id, {
        submitVerdict: () => VERDICT_RESULT,
        raiseFinding: () => FINDING_RESULT
    });
    const requests: ChatRequest[] = [];
    const client = new MockChatClient((request, state) => {
        // SNAPSHOT, not the live object: ./loop keeps ONE `messages` array and pushes the nudge into
        // it between turns, so a recorded alias would read as the FINAL transcript and the "was the
        // nudge in THIS turn's request" assertions below would lie — the same reason executor.test.ts
        // carries its own `record()` helper instead of using `makeRecorder`.
        requests.push({ ...request, messages: request.messages.map((message) => ({ ...message })) });

        const turn = turns[state.callIndex];

        if (turn === undefined)
            throw new Error(
                `no scripted turn for call ${state.callIndex} (the loop asked more times than the test scripted)`
            );

        return { ...turn(request), usage: { input: 100, output: 40, cached_input: 0 } };
    });

    return { store, story, runtime, client, requests, context: runtime.createContext(SESSION) };
}

/** The same spec, run as a Critic — the only difference C2-AD3 looks at. */
const criticSpec = (context: RunToolContext, extra: Record<string, unknown> = {}) => ({
    ...specFor(context),
    roleKind: 'critic' as const,
    ...extra
});

describe('loop — the Critic review pass ends at its report (C2-AD3)', () => {
    it('stops the turn it files `submitVerdict`: two requests, and the verdict is the answer (C1)', async () => {
        const h = reportHarness([
            () => ({ message: msg({ content: 'reading', toolCalls: calls([{ name: 'readSeed', args: {} }]) }) }),
            () => ({
                message: msg({
                    content: 'the map is wrong at chapter 3',
                    toolCalls: calls([{ name: 'submitVerdict', args: { target_ref: 'chapter_0', recommendation: 'revise' } }])
                })
            }),
            // Scripted on purpose and never reached: if the loop asked a third time, this turn would
            // answer and the turn-count assertion below would fail.
            () => ({ message: msg({ content: 'never asked' }) })
        ]);
        const tally = createTally();

        const outcome = await runAgentLoop(
            { chat: h.client, runtime: h.runtime },
            criticSpec(h.context),
            tally
        );

        // The documented default, pinned here so a silent change to the bound fails at its definition.
        expect(CRITIC_REVIEW_TURN_CAP).toBe(24);

        expect(outcome).toEqual({
            // The pass keeps the prose it said while filing — the stop discards nothing.
            text: 'the map is wrong at chapter 3',
            turns: 2,
            endCause: {
                kind: 'reported',
                turns: 2,
                cap: 24,
                reports: ['submitVerdict'],
                terminal_tool: 'submitVerdict'
            }
        });
        // C1's actual claim: NO third model turn. The third scripted reply is still unconsumed.
        expect(h.client.callCount).toBe(2);
        expect(h.requests).toHaveLength(2);
        // S-4: the pass filed a report, so the row it closes is not a no-op turn.
        expect(tally.reports).toEqual(['submitVerdict']);
        expect(tally.executed).toEqual(['readSeed', 'submitVerdict']);
    });

    it('leaves a Writer alone: the same report tool call still loops to the natural end (C2)', async () => {
        // `reportHarness`, not `criticHarness`-specific tooling: the ONLY difference under test is the
        // kind, and the tools answer identically for both.
        const h = reportHarness([
            () => ({
                message: msg({
                    content: 'writing',
                    toolCalls: calls([{ name: 'submitVerdict', args: { target_ref: 'chapter_0' } }])
                })
            }),
            () => ({ message: msg({ toolCalls: calls([{ name: 'readSeed', args: {} }]) }) }),
            () => ({ message: msg({ content: 'the chapter carries the promise' }) })
        ]);

        const outcome = await runAgentLoop({ chat: h.client, runtime: h.runtime }, specFor(h.context), createTally());

        // Three turns, the ordinary no-tool-call end, and NO `endCause`: the report tool is S-4's
        // report for a Writer, not this Writer's terminal call (C2-AD3 is critic-only).
        expect(outcome).toEqual({ text: 'the chapter carries the promise', turns: 3 });
        expect(h.client.callCount).toBe(3);
        expect(h.runtime.calls.map((call) => call.name)).toEqual(['submitVerdict', 'readSeed']);
    });

    it('nudges once, only after a report exists, and stops at the verdict it nudged for (C5)', async () => {
        const h = reportHarness([
            // Turn 1: pure reading — nothing filed, so no nudge may exist yet.
            () => ({ message: msg({ content: 'reading', toolCalls: calls([{ name: 'readSeed', args: {} }]) }) }),
            // Turn 2: a PARTIAL report (S-4 counts it, C2-AD3 does not end on it).
            () => ({
                message: msg({ content: 'one defect', toolCalls: calls([{ name: 'raiseFinding', args: { criterion_ref: 'c1' } }]) })
            }),
            // Turn 3: the critic keeps reading anyway — this is the turn the nudge answers.
            () => ({ message: msg({ content: 'still reading', toolCalls: calls([{ name: 'readSeed', args: {} }]) }) }),
            // Turn 4: the verdict, filed on the nudge's advice.
            () => ({
                message: msg({ content: 'verdict filed', toolCalls: calls([{ name: 'submitVerdict', args: { recommendation: 'revise' } }]) })
            }),
            () => ({ message: msg({ content: 'never asked' }) })
        ]);

        const outcome = await runAgentLoop(
            { chat: h.client, runtime: h.runtime },
            criticSpec(h.context),
            createTally()
        );

        const nudgeOf = (index: number): unknown[] =>
            h.requests[index].messages.filter((message) => message.content === CRITIC_CONCLUDE_NUDGE);

        // C5's two halves, turn by turn: no nudge on the request that PRECEDED any report...
        expect(nudgeOf(0)).toEqual([]);
        expect(nudgeOf(1)).toEqual([]);
        // ...exactly one, on the request right after the report was filed, and it is the LAST turn the
        // model is shown (a mid-conversation injection would read as the tool's own answer).
        expect(nudgeOf(2)).toHaveLength(1);
        expect(h.requests[2].messages[h.requests[2].messages.length - 1]).toEqual({
            role: 'user',
            content: CRITIC_CONCLUDE_NUDGE
        });
        // And never AGAIN, not even in the request that follows it. The fallback loop owns its own
        // transcript, so the nudge goes into the ONE request and is NOT pushed into `messages`: the
        // engine path's `turn.before` override reaches a single request the same way, and a line that
        // rode forward would re-lecture the model on every later turn (the drift this fixed measured
        // as `nudges_per_request [0,1,1]`). Zero here is the proof both paths now agree.
        expect(nudgeOf(3)).toEqual([]);
        expect(h.client.callCount).toBe(4);

        expect(outcome).toEqual({
            text: 'verdict filed',
            turns: 4,
            endCause: {
                kind: 'reported',
                turns: 4,
                cap: 24,
                reports: ['raiseFinding', 'submitVerdict'],
                terminal_tool: 'submitVerdict'
            }
        });
    });

    it('bounds a critic that never concludes at the configured cap, and says so (C4)', async () => {
        const h = reportHarness([
            () => ({ message: msg({ content: 'reading', toolCalls: calls([{ name: 'readSeed', args: {} }]) }) }),
            () => ({ message: msg({ content: 'reading more', toolCalls: calls([{ name: 'readSeed', args: {} }]) }) }),
            () => ({ message: msg({ content: 'never asked' }) })
        ]);

        const outcome = await runAgentLoop(
            { chat: h.client, runtime: h.runtime },
            criticSpec(h.context, { criticTurnCap: 2 }),
            createTally()
        );

        // `capped`, not `reported`, and not an empty outcome: the bound is a distinct end state, so a
        // capped pass can never be mistaken for a pass that filed its verdict.
        expect(outcome).toEqual({
            text: 'reading more',
            turns: 2,
            endCause: { kind: 'capped', turns: 2, cap: 2, reports: [] }
        });
        expect(h.client.callCount).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// C2-AD3, the REFUSAL rule — a terminal report the tool layer refused does NOT end the pass
//
// This is the defect the engine path carried and this loop had to be proved not to carry it: the
// model's `submitVerdict` call is a REQUEST to file, and T-1a's rule id makes a refusal something the
// model corrects INSIDE the run. So the pass must keep its turn, the refusal must reach the model as
// this call's tool message, and the run must not be scored as having reported what was never written.
// The engine twin of these two tests is the C2-AD3 refusal block in ./executor.test.ts, which drives
// the same pair through `RunExecutor` -> the real harness -> `critic-termination`; the two paths must
// not drift, and this block is what pins the fallback half.
// ---------------------------------------------------------------------------

/** T-1a's refusal shape: `ok: false`, the rule id, and the sentence the model has to act on. */
const VERDICT_REFUSAL = {
    ok: false,
    refused: 'P6',
    error: 'a criterion line with no quotation is not evidence (P6) — quote the draft',
    message: 'the verdict was not filed'
};

/**
 * The report rig with `submitVerdict` answering on command, so a test can own the WHOLE refusal
 * history of one pass. The counter is kept OUTSIDE the handler on purpose: a default-parameter
 * counter (`(n = { value: 0 }) => ...`) is rebuilt on every call and would refuse forever, which is
 * the wrong rig for the recovery case below.
 */
function refusingHarness(
    turns: Array<(request: ChatRequest) => ChatResponse>,
    verdict: (callIndex: number) => Record<string, unknown> = () => VERDICT_REFUSAL
) {
    const store = Store.empty();
    const story = seedStory(store);
    let verdictCalls = 0;
    const runtime = new MockToolRuntime(store, story.id, {
        submitVerdict: () => verdict(verdictCalls++),
        raiseFinding: () => FINDING_RESULT
    });
    const requests: ChatRequest[] = [];
    const client = new MockChatClient((request, state) => {
        // SNAPSHOT, exactly as `reportHarness` does: the assertions below are about what the model was
        // shown AT A GIVEN TURN, and ./loop reuses one `messages` array across turns.
        requests.push({ ...request, messages: request.messages.map((message) => ({ ...message })) });

        const turn = turns[state.callIndex];

        if (turn === undefined)
            throw new Error(
                `no scripted turn for call ${state.callIndex} (the loop asked more times than the test scripted)`
            );

        return { ...turn(request), usage: { input: 100, output: 40, cached_input: 0 } };
    });

    return { store, story, runtime, client, requests, context: runtime.createContext(SESSION) };
}

/** The tool messages of one recorded request, parsed — a refusal has to be read, not sniffed for a word. */
const toolResultsOf = (request: ChatRequest): Record<string, unknown>[] =>
    request.messages
        .filter((message) => message.role === 'tool')
        .map((message) => JSON.parse(String(message.content)) as Record<string, unknown>);

const VERDICT_CALL = { name: 'submitVerdict', args: { target_ref: 'chapter_0', recommendation: 'revise' } };

describe('loop — a REFUSED terminal report leaves the Critic its correction turn (C2-AD3, T-1a)', () => {
    it('keeps running, shows the model the refusal, and files no report it did not file (N1, N3)', async () => {
        const h = refusingHarness([
            // Turn 1: asks to file, and the tool layer turns the call away.
            () => ({ message: msg({ content: 'verdict filed', toolCalls: calls([VERDICT_CALL]) }) }),
            // Turn 2: only possible if the loop asked again — and the script ANSWERS the refusal,
            // which is what the requirement ("at least produce result") buys the model.
            () => ({ message: msg({ content: 're-reading the evidence', toolCalls: calls([{ name: 'readSeed', args: {} }]) }) }),
            // Turn 3: gives up and answers tool-less, which is S-4's ordinary natural end.
            () => ({ message: msg({ content: 'I could not get the verdict in' }) })
        ]);
        const tally = createTally();

        const outcome = await runAgentLoop({ chat: h.client, runtime: h.runtime }, criticSpec(h.context), tally);

        // THE PASS DID NOT END ON THE REFUSED TURN: three model turns where the shipped code stopped
        // at one, and the tool log proves the refused call really executed rather than being skipped.
        expect(h.client.callCount).toBe(3);
        expect(h.runtime.calls.map((call) => call.name)).toEqual(['submitVerdict', 'readSeed']);

        // THE REFUSAL REACHED THE MODEL, whole, as this call's own tool message on the NEXT request —
        // T-4's "serialise the result object WHOLE" is what carries the rule id to the model.
        expect(toolResultsOf(h.requests[1])).toEqual([VERDICT_REFUSAL]);

        // NO END CAUSE, because nothing about the pass concluded: it ended on the model's own
        // tool-less turn like any other run. And note what is NOT here — the conclude nudge. A refusal
        // needs no reminder, and pushing one on top of it is the double-instruction the request-scoped
        // nudge exists to avoid.
        expect(outcome).toEqual({ text: 'I could not get the verdict in', turns: 3 });

        // THE BOOKKEEPING HALF OF THE FIX: a call the tool refused is not a delivery, so S-4's list
        // stays empty. `run/executor.ts` turns an empty `reports` into `no_op: true`, which is what
        // lets the seat be owed again instead of paid for a verdict that was never written.
        expect(tally.reports).toEqual([]);
        // The refused call still RUNS, so it is on the executed list — the row can name the attempt.
        expect(tally.executed).toEqual(['submitVerdict', 'readSeed']);
    });

    it('ends `reported` when the pass fixes the refusal, and `capped` naming it when it does not (N3, N5)', async () => {
        // TWO endings from the SAME first refusal, asserted side by side: a pass that corrects itself
        // ends as a completed pass, and a pass that runs out its bound is `capped` WITH the refusal on
        // its record — never the same record as a critic that simply never concluded.
        const stuck = refusingHarness([
            () => ({ message: msg({ content: 'verdict filed', toolCalls: calls([VERDICT_CALL]) }) }),
            () => ({ message: msg({ content: 'still trying', toolCalls: calls([VERDICT_CALL]) }) }),
            // Scripted so an extra request would be caught by the turn count below.
            () => ({ message: msg({ content: 'never asked' }) })
        ]);

        const stuckOutcome = await runAgentLoop(
            { chat: stuck.client, runtime: stuck.runtime },
            criticSpec(stuck.context, { criticTurnCap: 2 }),
            createTally()
        );

        expect(stuck.client.callCount).toBe(2);
        // `capped` (not `reported`), with `refusals` naming what it asked for: this is the row a
        // harness reader uses to tell "it ran out of review turns" from "it ran out and was refused".
        expect(stuckOutcome).toEqual({
            text: 'still trying',
            turns: 2,
            endCause: { kind: 'capped', turns: 2, cap: 2, reports: [], refusals: ['submitVerdict'] }
        });

        // THE RECOVERY CASE: the same first refusal, then a call that gets it right. The pass ends as
        // `reported`, on the turn the filing SUCCEEDED, and the earlier refusal stays on the record as
        // a fact about the pass — the repair does not erase the refusal.
        const recovered = refusingHarness(
            [
                () => ({ message: msg({ content: 'verdict filed', toolCalls: calls([VERDICT_CALL]) }) }),
                () => ({ message: msg({ content: 'verdict filed properly', toolCalls: calls([VERDICT_CALL]) }) }),
                () => ({ message: msg({ content: 'never asked' }) })
            ],
            // Refuses the FIRST call only — the correction the rule exists to buy.
            (callIndex) => (callIndex === 0 ? VERDICT_REFUSAL : VERDICT_RESULT)
        );
        const recoveredTally = createTally();

        const recoveredOutcome = await runAgentLoop(
            { chat: recovered.client, runtime: recovered.runtime },
            criticSpec(recovered.context),
            recoveredTally
        );

        // C1 still holds on the SUCCESS: the pass stops on the turn it files, one model turn used to
        // correct, and no third request.
        expect(recovered.client.callCount).toBe(2);
        expect(recoveredOutcome).toEqual({
            text: 'verdict filed properly',
            turns: 2,
            endCause: {
                kind: 'reported',
                turns: 2,
                cap: CRITIC_REVIEW_TURN_CAP,
                reports: ['submitVerdict'],
                refusals: ['submitVerdict'],
                terminal_tool: 'submitVerdict'
            }
        });
        // THE SEAT IS PAID THIS TIME: the second call really filed, so S-4's list has the report and
        // the run that closes over it is not a no-op.
        expect(recoveredTally.reports).toEqual(['submitVerdict']);
    });
});
