// The deterministic mock provider for the package's tests.
//
// WHY THIS FILE IS SHIPPING, NOT SCRATCH: every integration suite in this package drives
// a run end to end (§9), and a run is one LLM conversation per turn (S-1). Those tests need
// a `ChatClient` whose answers are known exactly — a flaky provider must never be the
// reason a store or executor test fails. It lives next to the real client and imports only
// from it, so it stays compilable on its own and cannot drift from the pinned shapes.
//
// It is deliberately THIN: no delay simulation, no abort bookkeeping, no usage guessing.
// A test that needs an abort drives the real client (see client.test.ts); a test that needs
// usage scripts it explicitly, because S-6/E-0 make usage informational and nothing should
// be able to rely on an invented default.
import type { AssistantMessage, ChatClient, ChatRequest, ChatResponse, ToolCall } from './client';

// ---------------------------------------------------------------------------
// The mock client
// ---------------------------------------------------------------------------

/** Per-call context handed to the handler: 0-based index of the call this client has made. */
export type MockState = { callIndex: number };

export type MockHandler = (request: ChatRequest, state: MockState) => ChatResponse | Promise<ChatResponse>;

/**
 * A `ChatClient` that answers from one handler.
 *
 * `callIndex` is what lets a test script a tool loop without a closure of its own: turn 0
 * asks for a tool, turn 1 reports the result, turn 2 submits the verdict (S-4).
 * `callCount` is a read-only counter for assertions ("the run asked the model twice").
 */
export class MockChatClient implements ChatClient {
    private readonly handler: MockHandler;
    private count = 0;

    constructor(handler: MockHandler) {
        this.handler = handler;
    }

    /** How many `complete` calls this instance has received. */
    get callCount(): number {
        return this.count;
    }

    async complete(request: ChatRequest): Promise<ChatResponse> {
        const state: MockState = { callIndex: this.count };

        this.count += 1;

        return this.handler(request, state);
    }
}

// ---------------------------------------------------------------------------
// Message builders (exact, so tests can assert exact values)
// ---------------------------------------------------------------------------

/** One scripted tool request: `args` is the object form; the wire shape stringifies it. */
export type ToolCallSpec = { name: string; args?: Record<string, unknown> };

/**
 * Builds a `tool_calls` array with the pinned ids (`call_1`, `call_2`, …) and `arguments`
 * JSON-stringified in the OpenAI wire shape. Key order follows insertion order, which is
 * stable for object literals — that is what makes exact-string assertions possible.
 */
export const calls = (specs: ToolCallSpec[]): ToolCall[] =>
    specs.map((spec, index) => ({
        id: `call_${index + 1}`,
        name: spec.name,
        arguments: JSON.stringify(spec.args ?? {})
    }));

/**
 * Builds an `AssistantMessage`. Keys are OMITTED rather than set to `undefined`, matching
 * what the real client emits, so a test that asserts `toEqual` sees the production shape.
 */
export const msg = (input?: { content?: string; toolCalls?: ToolCall[] }): AssistantMessage => {
    const message: AssistantMessage = {};

    if (input?.content !== undefined) message.content = input.content;
    if (input?.toolCalls && input.toolCalls.length > 0) message.tool_calls = input.toolCalls;

    return message;
};

// ---------------------------------------------------------------------------
// Scripted sequences and the recorder
// ---------------------------------------------------------------------------

/**
 * A client that replays fixed replies in order, one per call, per instance (a fresh
 * `scripted(...)` call gives a fresh cursor — S-1 says a run never reuses a session, and
 * the mock mirrors that so a second run cannot inherit the first one's cursor).
 *
 * Each entry is a literal `AssistantMessage` or a function of the request, which is how a
 * test asserts the brief it was given AND picks the reply from it in one step.
 *
 * Running past the end throws rather than returning an empty turn: an executor that asks
 * for a turn nobody scripted is exactly the "went in circles" case (§6.7), and a silent
 * empty reply would hide it.
 */
export const scripted = (
    ...responses: Array<AssistantMessage | ((request: ChatRequest) => AssistantMessage)>
): MockChatClient =>
    new MockChatClient((request, state) => {
        const entry = responses[state.callIndex];

        if (entry === undefined) {
            throw new Error(
                `MockChatClient exhausted: ${responses.length} scripted response(s), call index ${state.callIndex} requested.`
            );
        }

        return { message: typeof entry === 'function' ? entry(request) : entry };
    });

export type Recorder = { client: MockChatClient; requests: ChatRequest[] };

/**
 * A client plus the requests it received, for asserting briefs and tool schemas (S-2 pins
 * the brief's contents, and S-7's crew panel needs the tool surface) with exact `toEqual`
 * checks instead of sniffing.
 *
 * Replies `{ content: 'ok' }` by default — a fixed string, so an assertion on the run's
 * output is still exact. Pass `respond` to record AND drive the answer.
 */
export const makeRecorder = (respond?: MockHandler): Recorder => {
    const requests: ChatRequest[] = [];
    const client = new MockChatClient(async (request, state) => {
        requests.push(request);

        if (respond) return respond(request, state);

        return { message: { content: 'ok' } };
    });

    return { client, requests };
};
