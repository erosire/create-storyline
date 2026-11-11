// Transport contract for the harness LLM client (§9, S-1…S-4a, S-6, E-0).
//
// Every assertion is an EXACT value against a stubbed `fetch` injected through the
// `fetchImpl` seam — no network, no timers beyond the 0ms backoff override, and no
// dependence on which host `Response` implementation vitest happens to provide (the stub
// only has to satisfy what the client actually reads: `status` and `text()`).
import { describe, expect, it } from 'vitest';
import { DEFAULT_RETRY_DELAY_MS, LlmError, createOpenAICompatClient, isAbortError, isLlmError } from './client';
import type { ChatMessage, ChatRequest, ToolSchema } from './client';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

/** A scripted provider reply: an HTTP status plus a body, or a transport-level rejection. */
type StubReply = { status: number; body: string } | { reject: unknown };

/** One recorded call, exactly as the client handed it to `fetch`. */
type StubCall = { url: string; method: string | undefined; headers: Record<string, string>; body: string };

/**
 * The provider double. `replies[index]` answers call `index`; the last entry repeats, so a
 * "always 500" case needs one entry. The returned object is duck-typed to the two fields the
 * client reads, which is what keeps these tests independent of the jsdom/undici globals.
 */
const stub = (replies: StubReply[], onCall?: (controller?: AbortSignal) => void) => {
    const seen: StubCall[] = [];

    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
        const index = seen.length;

        seen.push({
            url: String(input),
            method: init?.method,
            headers: (init?.headers ?? {}) as Record<string, string>,
            body: String(init?.body)
        });

        onCall?.(init?.signal ?? undefined);

        const reply = replies[Math.min(index, replies.length - 1)];

        if ('reject' in reply) throw reply.reject;

        return {
            status: reply.status,
            ok: reply.status >= 200 && reply.status < 300,
            text: async () => reply.body
        } as Response;
    }) as unknown as typeof fetch;

    return { fetchImpl, seen };
};

/** The smallest brief a run sends: one system turn (S-2 — the brief is the whole memory). */
const messages: ChatMessage[] = [{ role: 'system', content: 'You are the Editor.' }];

const json = (body: unknown): string => JSON.stringify(body);

/** Resolves to the rejection value, so error fields can be asserted exactly rather than matched loosely. */
const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
    try {
        await promise;
    } catch (error) {
        return error;
    }

    return null;
};

const abortError = (): Error => {
    const error = new Error('This operation was aborted');
    error.name = 'AbortError';

    return error;
};

const COMPLETED_URL = 'https://relay.test/v1/chat/completions';

// ---------------------------------------------------------------------------
// Happy path and wire shape
// ---------------------------------------------------------------------------

describe('createOpenAICompatClient — request shape', () => {
    it('posts model and messages to <baseUrl>/chat/completions and maps the assistant turn', async () => {
        const provider = stub([
            {
                status: 200,
                body: json({
                    choices: [{ message: { content: 'verdict: pass' } }],
                    usage: { prompt_tokens: 120, completion_tokens: 34 }
                })
            }
        ]);
        const client = createOpenAICompatClient({
            baseUrl: 'https://relay.test/v1',
            apiKey: 'sk-test',
            model: 'crew/basalt',
            fetchImpl: provider.fetchImpl
        });

        const response = await client.complete({ model: 'crew/basalt', messages });

        expect(provider.seen).toEqual([
            {
                url: COMPLETED_URL,
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
                body: json({ model: 'crew/basalt', messages })
            }
        ]);
        expect(response).toEqual({ message: { content: 'verdict: pass' }, usage: { input: 120, output: 34 } });
    });

    it('collapses a trailing slash on baseUrl so the completions path is never doubled', async () => {
        const provider = stub([{ status: 200, body: json({ choices: [{ message: { content: 'ok' } }] }) }]);
        const client = createOpenAICompatClient({
            baseUrl: 'https://relay.test/v1/',
            model: 'm',
            fetchImpl: provider.fetchImpl
        });

        await client.complete({ model: 'm', messages });

        expect(provider.seen[0].url).toBe(COMPLETED_URL);
    });

    it('sends no authorization header at all when the provider is key-free', async () => {
        const provider = stub([{ status: 200, body: json({ choices: [{ message: { content: 'ok' } }] }) }]);
        const client = createOpenAICompatClient({
            baseUrl: 'https://relay.test/v1',
            apiKey: '   ',
            model: 'm',
            fetchImpl: provider.fetchImpl
        });

        await client.complete({ model: 'm', messages });

        expect(provider.seen[0].headers).toEqual({ 'content-type': 'application/json' });
    });

    it('passes the tool schema through verbatim, and omits an empty tools list', async () => {
        const tools: ToolSchema[] = [
            {
                type: 'function',
                function: {
                    name: 'submitVerdict',
                    description: 'File the pass/fail report for this run (S-4).',
                    parameters: { type: 'object', properties: { pass: { type: 'boolean' } }, required: ['pass'] }
                }
            }
        ];
        const withTools = stub([{ status: 200, body: json({ choices: [{ message: { content: 'ok' } }] }) }]);
        const emptyTools = stub([{ status: 200, body: json({ choices: [{ message: { content: 'ok' } }] }) }]);

        await createOpenAICompatClient({
            baseUrl: 'https://relay.test/v1',
            model: 'm',
            fetchImpl: withTools.fetchImpl
        }).complete({
            model: 'm',
            messages,
            tools
        });
        await createOpenAICompatClient({
            baseUrl: 'https://relay.test/v1',
            model: 'm',
            fetchImpl: emptyTools.fetchImpl
        }).complete({
            model: 'm',
            messages,
            tools: []
        });

        expect(JSON.parse(withTools.seen[0].body)).toEqual({ model: 'm', messages, tools });
        expect(JSON.parse(emptyTools.seen[0].body)).toEqual({ model: 'm', messages });
    });

    it('reports the default single-retry backoff as 1000ms (the seam exists so tests need not wait for it)', () => {
        expect(DEFAULT_RETRY_DELAY_MS).toBe(1_000);
    });
});

describe('createOpenAICompatClient — response mapping', () => {
    it('omits usage entirely when the provider sends none (S-6: informational, never assumed)', async () => {
        const provider = stub([{ status: 200, body: json({ choices: [{ message: { content: 'quiet' } }] }) }]);
        const client = createOpenAICompatClient({
            baseUrl: 'https://relay.test/v1',
            model: 'm',
            fetchImpl: provider.fetchImpl
        });

        expect(await client.complete({ model: 'm', messages })).toEqual({ message: { content: 'quiet' } });
    });

    it('normalises a null content and an object-form tool-call arguments into the pinned shape', async () => {
        const provider = stub([
            {
                status: 200,
                body: json({
                    choices: [
                        {
                            message: {
                                content: null,
                                tool_calls: [
                                    { id: 'call_9', function: { name: 'submitVerdict', arguments: { pass: true } } }
                                ]
                            }
                        }
                    ]
                })
            }
        ]);
        const client = createOpenAICompatClient({
            baseUrl: 'https://relay.test/v1',
            model: 'm',
            fetchImpl: provider.fetchImpl
        });

        expect(await client.complete({ model: 'm', messages })).toEqual({
            message: { tool_calls: [{ id: 'call_9', name: 'submitVerdict', arguments: '{"pass":true}' }] }
        });
    });

    it('assigns a positional id when the provider omits one, so a tool result can still be correlated', async () => {
        const provider = stub([
            {
                status: 200,
                body: json({
                    choices: [{ message: { tool_calls: [{ function: { name: 'raiseFinding', arguments: '{}' } }] } }]
                })
            }
        ]);
        const client = createOpenAICompatClient({
            baseUrl: 'https://relay.test/v1',
            model: 'm',
            fetchImpl: provider.fetchImpl
        });

        expect(await client.complete({ model: 'm', messages })).toEqual({
            message: { tool_calls: [{ id: 'call_1', name: 'raiseFinding', arguments: '{}' }] }
        });
    });

    it('treats a 2xx with no choices[0].message as a fatal provider fault (no retry)', async () => {
        const provider = stub([{ status: 200, body: json({ ok: true }) }]);
        const client = createOpenAICompatClient({
            baseUrl: 'https://relay.test/v1',
            model: 'm',
            fetchImpl: provider.fetchImpl
        });

        const failure = await rejection(client.complete({ model: 'm', messages }));

        expect(provider.seen.length).toBe(1);
        expect(isLlmError(failure)).toBe(true);
        expect({
            status: (failure as LlmError).status,
            body: (failure as LlmError).body,
            message: (failure as LlmError).message
        }).toEqual({
            status: 200,
            body: json({ ok: true }),
            message: `LLM provider response from ${COMPLETED_URL} carried no choices[0].message.`
        });
    });

    it('rejects a flattened choice rather than guessing at it (the turn lives under choices[0].message)', async () => {
        // A relay that puts `content` on the choice itself would otherwise yield a silent
        // empty turn, which §9 counts as a no-op run (S-4) — worse than a named failure.
        const flat = { choices: [{ content: 'flattened', finish_reason: 'stop' }] };
        const provider = stub([{ status: 200, body: json(flat) }]);
        const client = createOpenAICompatClient({
            baseUrl: 'https://relay.test/v1',
            model: 'm',
            fetchImpl: provider.fetchImpl
        });

        const failure = await rejection(client.complete({ model: 'm', messages }));

        expect(provider.seen.length).toBe(1);
        expect(isLlmError(failure)).toBe(true);
        expect({ status: (failure as LlmError).status, body: (failure as LlmError).body }).toEqual({
            status: 200,
            body: json(flat)
        });
    });
});

// ---------------------------------------------------------------------------
// Retry policy (S-3/S-4a: one retry, then the run layer owns the failure)
// ---------------------------------------------------------------------------

describe('createOpenAICompatClient — retry policy', () => {
    it('retries a 429 exactly once and returns the second answer', async () => {
        const provider = stub([
            { status: 429, body: 'rate limited' },
            { status: 200, body: json({ choices: [{ message: { content: 'recovered' } }] }) }
        ]);
        const client = createOpenAICompatClient({
            baseUrl: 'https://relay.test/v1',
            model: 'm',
            fetchImpl: provider.fetchImpl,
            retryDelayMs: 0
        });

        expect(await client.complete({ model: 'm', messages })).toEqual({ message: { content: 'recovered' } });
        expect(provider.seen.length).toBe(2);
    });

    it('retries a 5xx exactly once, then throws an LlmError carrying status and body', async () => {
        const provider = stub([{ status: 500, body: 'boom' }]);
        const client = createOpenAICompatClient({
            baseUrl: 'https://relay.test/v1',
            model: 'm',
            fetchImpl: provider.fetchImpl,
            retryDelayMs: 0
        });

        const failure = (await rejection(client.complete({ model: 'm', messages }))) as LlmError;

        expect(provider.seen.length).toBe(2);
        expect(isLlmError(failure)).toBe(true);
        expect({ status: failure.status, body: failure.body, message: failure.message }).toEqual({
            status: 500,
            body: 'boom',
            message: `LLM provider returned 500 for ${COMPLETED_URL}: boom`
        });
    });

    it('never retries a 4xx other than 429 — a bad brief is a run failure, not a transient fault', async () => {
        const provider = stub([{ status: 400, body: 'invalid model' }]);
        const client = createOpenAICompatClient({
            baseUrl: 'https://relay.test/v1',
            model: 'm',
            fetchImpl: provider.fetchImpl,
            retryDelayMs: 0
        });

        const failure = (await rejection(client.complete({ model: 'm', messages }))) as LlmError;

        expect(provider.seen.length).toBe(1);
        expect({ status: failure.status, body: failure.body }).toEqual({ status: 400, body: 'invalid model' });
    });

    it('retries a transport failure once, then surfaces it as status 0', async () => {
        const provider = stub([{ reject: new Error('fetch failed') }]);
        const client = createOpenAICompatClient({
            baseUrl: 'https://relay.test/v1',
            model: 'm',
            fetchImpl: provider.fetchImpl,
            retryDelayMs: 0
        });

        const failure = (await rejection(client.complete({ model: 'm', messages }))) as LlmError;

        expect(provider.seen.length).toBe(2);
        expect({ status: failure.status, body: failure.body, message: failure.message }).toEqual({
            status: 0,
            body: 'Error: fetch failed',
            message: `LLM request to ${COMPLETED_URL} failed without a response: Error: fetch failed`
        });
    });
});

// ---------------------------------------------------------------------------
// Abort handling (P8 — the Author can always pull the cord; S-3 teardown)
// ---------------------------------------------------------------------------

describe('createOpenAICompatClient — abort', () => {
    it('never dials the provider for a signal that is already aborted', async () => {
        const provider = stub([{ status: 200, body: json({ choices: [{ message: { content: 'unreachable' } }] }) }]);
        const client = createOpenAICompatClient({
            baseUrl: 'https://relay.test/v1',
            model: 'm',
            fetchImpl: provider.fetchImpl
        });
        const controller = new AbortController();

        controller.abort();

        const failure = await rejection(client.complete({ model: 'm', messages, signal: controller.signal }));

        expect(provider.seen.length).toBe(0);
        expect(isLlmError(failure)).toBe(false);
        expect(isAbortError(failure)).toBe(true);
    });

    it('does not retry a mid-call abort, and reports it as the abort rather than an LlmError', async () => {
        const provider = stub([{ reject: abortError() }]);
        const client = createOpenAICompatClient({
            baseUrl: 'https://relay.test/v1',
            model: 'm',
            fetchImpl: provider.fetchImpl,
            retryDelayMs: 0
        });

        const failure = await rejection(
            client.complete({ model: 'm', messages, signal: new AbortController().signal })
        );

        expect(provider.seen.length).toBe(1);
        expect(isLlmError(failure)).toBe(false);
        expect(isAbortError(failure)).toBe(true);
        expect((failure as Error).message).toBe('This operation was aborted');
    });

    it('cuts the retry backoff short when the signal aborts while waiting', async () => {
        const controller = new AbortController();
        // The provider answers 500 (so a retry would be scheduled); the abort lands as soon
        // as the first attempt is recorded, i.e. inside the backoff window.
        const provider = stub([{ status: 503, body: 'busy' }], () => controller.abort());
        const client = createOpenAICompatClient({
            baseUrl: 'https://relay.test/v1',
            model: 'm',
            fetchImpl: provider.fetchImpl,
            retryDelayMs: 30_000
        });

        const failure = await rejection(client.complete({ model: 'm', messages, signal: controller.signal }));

        expect(provider.seen.length).toBe(1);
        expect(isLlmError(failure)).toBe(false);
        expect(isAbortError(failure)).toBe(true);
    });

    it('accepts a request with no signal at all (the executor may run without a lease abort)', async () => {
        const provider = stub([{ status: 200, body: json({ choices: [{ message: { content: 'signal-free' } }] }) }]);
        const client = createOpenAICompatClient({
            baseUrl: 'https://relay.test/v1',
            model: 'm',
            fetchImpl: provider.fetchImpl
        });
        const request: ChatRequest = { model: 'm', messages };

        expect(await client.complete(request)).toEqual({ message: { content: 'signal-free' } });
    });
});
