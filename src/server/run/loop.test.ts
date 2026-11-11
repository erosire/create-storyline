// Acceptance for the one turn engine ./loop — the code every fresh context runs (the dispatched
// run, a D-38 panel agent, a D-17e sub-context).
//
// The pinned behaviours here are the ones the spec makes load-bearing:
//   T-6a   the whole catalogue is declared on EVERY request, so a fresh context sees its tools on
//          turn one and never pays a discovery round trip.
//   S-2    the brief is the history: the conversation starts from the system turn and nothing else.
//   S-4    the run ends when the model stops calling tools — nothing else ends it (E-0: no cap).
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
import type { RunToolContext, RunToolSession } from './types';

/** The session a loop runs as — T3's five bound fields (T-3). */
const SESSION: RunToolSession = {
    storyId: 'story_1',
    runId: 'run_1',
    runRef: 'run_1',
    sessionRef: 'sess_run_1',
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

        return { ...turn(request), usage: { input: 100, output: 40 } };
    });

    return { store, story, runtime, client, requests, context: runtime.createContext(SESSION) };
}

/** The loop's spec, with the context supplied — the only field a caller cannot know in advance. */
const specFor = (context: RunToolContext) => ({
    label: 'run_1',
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
                    Object.assign(new Error('run run_1 killed by the Author (P8, U-7)'), { name: 'AbortError' })
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
        ).rejects.toThrow('run run_1 killed by the Author (P8, U-7)');

        // The kill landed before the second request, so the run spent exactly one turn (P8: the cord
        // works between turns, not only inside the transport).
        expect(h.client.callCount).toBe(1);

        expect(wasAborted(Object.assign(new Error('aborted'), { name: 'AbortError' }), controller.signal)).toBe(true);
        // An aborted signal is enough on its own: the reason may be any value the host chose.
        expect(wasAborted(new Error('provider fault'), controller.signal)).toBe(true);
        expect(wasAborted(new Error('provider fault'), new AbortController().signal)).toBe(false);
    });
});
