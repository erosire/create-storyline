// The deterministic provider every integration suite in this package drives runs with.
//
// These tests pin the exact behaviour the executor and store suites will rely on: turn
// order per client instance, the `callIndex` a tool loop reads, the exact wire shape the
// builders emit, and the recorder's request capture (S-2 — the brief is asserted, not
// eyeballed).
import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatRequest } from './client';
import { MockChatClient, calls, makeRecorder, msg, scripted } from './mock';

const messages: ChatMessage[] = [{ role: 'user', content: 'Judge chapter 3 against its plotline.' }];

describe('MockChatClient', () => {
    it('hands the handler the request and a 0-based call index, and counts its own calls', async () => {
        const seen: Array<{ model: string; state: { callIndex: number } }> = [];
        const client = new MockChatClient((request, state) => {
            seen.push({ model: request.model, state });

            return { message: { content: `turn ${state.callIndex}` } };
        });

        const first = await client.complete({ model: 'crew/editor', messages });
        const second = await client.complete({ model: 'crew/editor', messages });

        expect(seen).toEqual([
            { model: 'crew/editor', state: { callIndex: 0 } },
            { model: 'crew/editor', state: { callIndex: 1 } }
        ]);
        expect([first, second]).toEqual([{ message: { content: 'turn 0' } }, { message: { content: 'turn 1' } }]);
        expect(client.callCount).toBe(2);
    });

    it('passes a handler-authored ChatResponse through untouched, including usage', async () => {
        const client = new MockChatClient(() =>
            Promise.resolve({ message: { content: 'done' }, usage: { input: 5, output: 7 } })
        );

        expect(await client.complete({ model: 'm', messages })).toEqual({
            message: { content: 'done' },
            usage: { input: 5, output: 7 }
        });
    });
});

describe('scripted', () => {
    it('replays scripted replies in order, one per call, per instance', async () => {
        const client = scripted(msg({ content: 'first' }), msg({ content: 'second' }));

        expect([
            await client.complete({ model: 'm', messages }),
            await client.complete({ model: 'm', messages })
        ]).toEqual([{ message: { content: 'first' } }, { message: { content: 'second' } }]);

        // A second instance starts its own cursor: a run never inherits another's turns (S-1).
        const fresh = scripted(msg({ content: 'first' }));

        expect(await fresh.complete({ model: 'm', messages })).toEqual({ message: { content: 'first' } });
    });

    it('lets a reply read the request it was sent', async () => {
        const client = scripted((request) => msg({ content: `brief:${request.messages[0].content.length}` }));

        expect(await client.complete({ model: 'm', messages })).toEqual({
            message: { content: `brief:${messages[0].content.length}` }
        });
    });

    it('throws a named, exact error when a run asks for a turn nobody scripted', async () => {
        const client = scripted(msg({ content: 'only' }));

        await client.complete({ model: 'm', messages });

        const failure = await client.complete({ model: 'm', messages }).then(
            () => null,
            (error: Error) => error.message
        );

        expect(failure).toBe('MockChatClient exhausted: 1 scripted response(s), call index 1 requested.');
    });

    it('scripts a tool loop exactly as S-4 reports it: call, then verdict', async () => {
        const client = scripted(
            msg({ toolCalls: calls([{ name: 'readChapter', args: { chapterId: 'ch_3' } }]) }),
            msg({ toolCalls: calls([{ name: 'submitVerdict', args: { pass: true, evidence: 'line 12' } }]) })
        );

        expect(
            await client.complete({
                model: 'm',
                messages,
                tools: [{ type: 'function', function: { name: 'submitVerdict', description: 'd', parameters: {} } }]
            })
        ).toEqual({
            message: { tool_calls: [{ id: 'call_1', name: 'readChapter', arguments: '{"chapterId":"ch_3"}' }] }
        });
        expect(await client.complete({ model: 'm', messages })).toEqual({
            message: {
                tool_calls: [{ id: 'call_1', name: 'submitVerdict', arguments: '{"pass":true,"evidence":"line 12"}' }]
            }
        });
    });
});

describe('msg / calls', () => {
    it('builds tool calls with positional ids and stringified arguments', () => {
        expect(calls([{ name: 'submitVerdict', args: { pass: true } }, { name: 'raiseFinding' }])).toEqual([
            { id: 'call_1', name: 'submitVerdict', arguments: '{"pass":true}' },
            { id: 'call_2', name: 'raiseFinding', arguments: '{}' }
        ]);
    });

    it('omits keys the message does not carry, so `toEqual` sees the production shape', () => {
        expect(msg()).toEqual({});
        expect(msg({ content: 'drafted' })).toEqual({ content: 'drafted' });
        expect(msg({ toolCalls: [] })).toEqual({});
        expect(msg({ content: 'look', toolCalls: calls([{ name: 'requestAuthor', args: {} }]) })).toEqual({
            content: 'look',
            tool_calls: [{ id: 'call_1', name: 'requestAuthor', arguments: '{}' }]
        });
    });
});

describe('makeRecorder', () => {
    it('captures the full request, including tools and the default reply', async () => {
        const request = makeRecorder();
        const tools = [
            {
                type: 'function' as const,
                function: { name: 'createTask', description: 'Queue work (S-4).', parameters: { type: 'object' } }
            }
        ];

        expect(await request.client.complete({ model: 'crew/reader', messages, tools })).toEqual({
            message: { content: 'ok' }
        });

        expect(request.requests).toEqual([{ model: 'crew/reader', messages, tools }]);

        await request.client.complete({
            model: 'crew/reader',
            messages: [...messages, { role: 'tool', content: '{"ok":true}', tool_call_id: 'call_1' }]
        });

        expect(request.requests.length).toBe(2);
        expect(request.requests[1]).toEqual({
            model: 'crew/reader',
            messages: [messages[0], { role: 'tool', content: '{"ok":true}', tool_call_id: 'call_1' }]
        });
    });

    it('records AND answers when a responder is supplied', async () => {
        const recorded: ChatRequest[] = [];
        const harness = makeRecorder((req, state) => {
            recorded.push(req);

            return { message: { content: `answered ${state.callIndex}` } };
        });

        expect(await harness.client.complete({ model: 'm', messages })).toEqual({ message: { content: 'answered 0' } });
        expect(recorded).toEqual([{ model: 'm', messages }]);
        expect(harness.requests).toEqual([{ model: 'm', messages }]);
    });
});
