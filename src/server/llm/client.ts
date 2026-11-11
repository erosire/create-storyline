// The harness LLM transport — the only thing in the package that talks to a model.
//
// WHY THIS FILE EXISTS: §9 runs one ephemeral harness per Work Item (S-1) and the run
// executor drives it through tool calling. The executor owns the loop, the brief (S-2),
// teardown (S-3) and no-op accounting (S-4); it needs one dependency-free primitive:
// "send these messages, get one assistant message back". Everything here is that
// primitive — plain `fetch`, no SDK, no streaming, and nothing outside this directory is
// imported, so the pinned types below are the single place the executor binds to.
//
// RETRY POLICY, and why it is ONE retry rather than the run-level "no retry cap" of S-4a:
// S-4a removes caps at the RUN layer (a run may take four hours; lease expiry, not a
// clock, is what detects a hang). That is not a licence for the transport to spin: a
// provider that is down would otherwise burn the run's whole life on a dead socket, and
// §9's answer to a failure is teardown plus a run row that records why it ended (S-3),
// not an endless internal loop. So this client retries a transient fault EXACTLY ONCE
// after a 1s backoff and then throws — the run layer treats the throw as run failure and
// the Work Item returns to the queue on lease expiry (L-2, S-4a).
//
// E-0 / S-6: `usage` is passed through verbatim and is INFORMATIONAL ONLY. Nothing here
// gates on it, and nothing may read it as a limit — no budget, cap, timeout, or round
// limit lives in this layer. There is deliberately no request timeout.

// ---------------------------------------------------------------------------
// The pinned transport surface (consumers code against exactly this)
// ---------------------------------------------------------------------------

/** One tool advertised to the model — the OpenAI function-schema wire shape. */
export interface ToolSchema {
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** One tool the model asked for. `arguments` is a JSON STRING (OpenAI wire shape). */
export interface ToolCall {
    id: string;
    name: string;
    arguments: string;
}

/** What one assistant turn can be: prose, tool calls, or both. Keys are omitted, never `undefined`. */
export interface AssistantMessage {
    content?: string;
    tool_calls?: ToolCall[];
}

/** The conversation handed to the model. A harness is stateless (S-1, S-2), so the brief IS the history. */
export type ChatMessage = {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_call_id?: string;
    name?: string;
};

export interface ChatRequest {
    model: string;
    messages: ChatMessage[];
    tools?: ToolSchema[];
    signal?: AbortSignal;
}

/** Token counts, recorded for information only (S-6) — never a limit (E-0). */
export interface ChatUsage {
    input: number;
    output: number;
}

export interface ChatResponse {
    message: AssistantMessage;
    usage?: ChatUsage;
}

export interface ChatClient {
    complete(req: ChatRequest): Promise<ChatResponse>;
}

export interface LlmConfig {
    /** Provider root, e.g. `http://localhost:5500/providers/private/v1`. Trailing slashes are collapsed. */
    baseUrl: string;
    /** Optional: a key-free local relay sends no `Authorization` header at all. */
    apiKey?: string;
    /** Default model for requests (a `ChatRequest` may override it per call). */
    model: string;
    /** Test seam; defaults to `globalThis.fetch`. Keeps the transport dependency-free and the tests hermetic. */
    fetchImpl?: typeof fetch;
    /** Test seam for the single retry backoff; defaults to `DEFAULT_RETRY_DELAY_MS`. */
    retryDelayMs?: number;
}

// ---------------------------------------------------------------------------
// Transport constants
// ---------------------------------------------------------------------------

/** The OpenAI-compatible path appended to `baseUrl` (relays mount completions under it). */
const COMPLETIONS_PATH = 'chat/completions';

/** One call + one retry. Exactly one retry: no silent infinite retries. */
const MAX_ATTEMPTS = 2;

/** The single backoff interval between the two attempts (1s, per the transport contract). */
export const DEFAULT_RETRY_DELAY_MS = 1_000;

/** Error bodies are clipped so a relay's HTML error page cannot flood a run row (S-3). */
const MAX_ERROR_BODY = 2_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Every failure this client raises after a response — or after the retries are spent — is
 * an `LlmError`, so the run layer catches one type and records `{status, body}` on the run
 * row (S-3).
 *
 * `status === 0` is the transport-level case: a socket/DNS/TLS fault with no HTTP response.
 * Aborts are the ONE exception to this type: they propagate as the signal's own reason (see
 * `createOpenAICompatClient`) so the executor can tell an Author stop / teardown (P8, S-3)
 * apart from a provider fault.
 */
export class LlmError extends Error {
    /** HTTP status, or 0 when no response was received at all. */
    readonly status: number;
    /** The raw response body (clipped), for the run row and the logs. */
    readonly body: string;

    constructor(status: number, body: string, message: string) {
        super(message);
        this.name = 'LlmError';
        this.status = status;
        this.body = body;
    }
}

/** Type guard for the executor's catch block — one error type for provider faults. */
export const isLlmError = (value: unknown): value is LlmError => value instanceof LlmError;

/**
 * Aborts surface as `AbortError`s from `fetch`, from the body read, and from the pre-flight
 * and backoff checks. Node and browsers both set `signal.reason` to an `AbortError`
 * DOMException, so the `name` check is the portable discriminator; `isAbortError` lets the
 * executor recognise a cancellation without treating it as a provider fault.
 */
export const isAbortError = (value: unknown): boolean =>
    typeof value === 'object' && value !== null && (value as { name?: unknown }).name === 'AbortError';

/** The reason a signal aborted, or a synthesised `AbortError` when the host left `reason` unset. */
const abortReason = (signal?: AbortSignal): unknown => {
    const reason = signal?.reason;

    if (reason !== undefined) return reason;

    const synthesised = new Error('LLM request aborted');
    synthesised.name = 'AbortError';

    return synthesised;
};

// ---------------------------------------------------------------------------
// Wire-format helpers (OpenAI-compatible, non-streaming)
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject | null =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;

/** Relays emit counts as numbers, numeric strings, or `null`; usage is informational, so anything unusable is 0. */
const asCount = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;

/**
 * `${baseUrl}/chat/completions`, with trailing slashes collapsed. Operators paste base URLs
 * with or without a trailing `/` (`.../v1` vs `.../v1/`), and a doubled slash 404s on
 * several relays — so the join is normalised once, here.
 */
const completionsUrl = (baseUrl: string): string => `${baseUrl.replace(/\/+$/, '')}/${COMPLETIONS_PATH}`;

/**
 * The request body: `{model, messages, tools?}`. `tools` is the standard array and is
 * OMITTED when absent or empty — some relays reject `tools: []` outright, and an empty list
 * means "no tool surface" either way.
 */
const payloadOf = (request: ChatRequest): string => {
    const body: JsonObject = { model: request.model, messages: request.messages };

    if (request.tools && request.tools.length > 0) body.tools = request.tools;

    return JSON.stringify(body);
};

/**
 * One `choices[0].tool_calls[m]` -> the pinned `ToolCall`.
 *
 * `arguments` MUST be a JSON string on our side (OpenAI's wire shape). Relays that hand back
 * a parsed object are normalised by stringifying, so the executor decodes exactly one shape
 * before dispatching the tool result (S-4). A missing `id` gets a positional one, because a
 * tool result cannot be filed without correlating it to the call.
 */
const toolCallOf = (raw: unknown, index: number): ToolCall | null => {
    const entry = asObject(raw);

    if (entry === null) return null;

    // Some relays flatten the schema (`{name, arguments}` instead of `{function: {...}`).
    const fn = asObject(entry.function) ?? entry;
    const rawArguments = fn.arguments;
    const id = typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : `call_${index + 1}`;

    return {
        id,
        name: typeof fn.name === 'string' ? fn.name : '',
        arguments:
            typeof rawArguments === 'string'
                ? rawArguments
                : rawArguments === undefined || rawArguments === null
                  ? '{}'
                  : JSON.stringify(rawArguments)
    };
};

/**
 * `choices[0].message` -> `AssistantMessage`; a `content: null` (common alongside tool calls)
 * becomes an absent key. The argument is the nested `message` object, NOT the choice wrapper
 * (`{ message, finish_reason, index, logprobs }`) — pinning that distinction is what the
 * response-mapping tests exist for.
 */
const messageOf = (choice: JsonObject): AssistantMessage => {
    const rawCalls = Array.isArray(choice.tool_calls) ? choice.tool_calls : [];
    const toolCalls = rawCalls
        .map(toolCallOf)
        .filter((call): call is ToolCall => call !== null && call.name.length > 0);

    const message: AssistantMessage = {};

    if (typeof choice.content === 'string') message.content = choice.content;
    if (toolCalls.length > 0) message.tool_calls = toolCalls;

    return message;
};

/** `usage` passthrough — the key appears only when the provider sent one (S-6, E-0). */
const usageOf = (root: JsonObject): ChatUsage | null => {
    const usage = asObject(root.usage);

    if (usage === null) return null;

    return { input: asCount(usage.prompt_tokens), output: asCount(usage.completion_tokens) };
};

const clip = (text: string): string => (text.length <= MAX_ERROR_BODY ? text : `${text.slice(0, MAX_ERROR_BODY)}…`);

const describeError = (error: unknown): string =>
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/** A transport fault with no HTTP status (`status: 0`), e.g. a refused connection. */
const transportError = (error: unknown, url: string): LlmError =>
    new LlmError(
        0,
        clip(describeError(error)),
        `LLM request to ${url} failed without a response: ${describeError(error)}`
    );

/** 429 (rate limit) and 5xx (provider fault) are the only statuses worth a second attempt. */
const isTransientStatus = (status: number): boolean => status === 429 || status >= 500;

/**
 * Backoff between the two attempts. It rejects the moment the signal aborts: an Author Stop
 * (P8) must not wait out the 1s before reaching teardown (S-3).
 */
const backoff = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortReason(signal));

            return;
        }

        const onAbort = (): void => {
            clearTimeout(timer);
            reject(abortReason(signal));
        };

        const timer = setTimeout(() => {
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);

        if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/** One round trip, normalised: `ok` carries the parsed response; `retry`/`fatal` carry the `LlmError` to surface. */
type SendOutcome =
    | { kind: 'ok'; response: ChatResponse }
    | { kind: 'retry'; error: LlmError }
    | { kind: 'fatal'; error: LlmError };

/**
 * Builds the one client the run executor uses (S-1: a fresh harness dials the provider per
 * turn; the client itself is stateless and safe to share across concurrent runs, S-5).
 *
 * `fetchImpl` / `retryDelayMs` are test seams added on top of the pinned `LlmConfig` shape —
 * both optional, so a plain `{ baseUrl, apiKey, model }` still constructs. Everything else is
 * the contract: POST `${baseUrl}/chat/completions`, JSON headers, Bearer only when a key is
 * present, non-streaming, `signal` honoured, exactly one retry, `usage` passthrough.
 */
export const createOpenAICompatClient = (config: LlmConfig): ChatClient => {
    const fetchImpl: typeof fetch = config.fetchImpl ?? globalThis.fetch;
    const retryDelayMs = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const url = completionsUrl(config.baseUrl);

    // Static per config, so computed once. An empty or blank key sends no `Authorization`
    // header at all: a bare `Bearer ` is rejected by some gateways.
    const apiKey = config.apiKey?.trim() ?? '';
    const headers: Record<string, string> = { 'content-type': 'application/json' };

    if (apiKey.length > 0) headers.authorization = `Bearer ${apiKey}`;

    const sendOnce = async (payload: string, signal?: AbortSignal): Promise<SendOutcome> => {
        let status: number;
        let text: string;

        try {
            const response = await fetchImpl(url, { method: 'POST', headers, body: payload, signal });

            // Non-streaming by contract: the whole body is read before anything is parsed.
            text = await response.text();
            status = response.status;
        } catch (error) {
            // An abort is a cancellation, not a fault (P8, S-3): propagate unwrapped, never retry.
            if (isAbortError(error)) throw error;

            return { kind: 'retry', error: transportError(error, url) };
        }

        if (status < 200 || status >= 300) {
            const error = new LlmError(status, clip(text), `LLM provider returned ${status} for ${url}: ${clip(text)}`);

            return { kind: isTransientStatus(status) ? 'retry' : 'fatal', error };
        }

        let parsed: unknown;

        try {
            parsed = JSON.parse(text);
        } catch {
            // A 2xx that is not JSON is a broken relay, not a transient fault: no retry.
            return {
                kind: 'fatal',
                error: new LlmError(status, clip(text), `LLM provider returned a non-JSON 2xx body from ${url}.`)
            };
        }

        // The envelope is `{ choices: [{ message: {...}, finish_reason }], usage }`, so the
        // assistant turn is NESTED one level below the choice — `choices[0].message`, not
        // `choices[0]`. A missing envelope or turn is a broken provider response, not a
        // transient fault, so it is fatal (no retry) and carries the raw body for the run row.
        // A choice that carries `content` directly (a flattened envelope) is treated as
        // malformed rather than guessed at: `usage` would be unreadable in that shape anyway.
        const root = asObject(parsed);
        const choice = root === null ? null : asObject(Array.isArray(root.choices) ? root.choices[0] : null);
        const turn = choice === null ? null : asObject(choice.message);

        if (root === null || turn === null) {
            return {
                kind: 'fatal',
                error: new LlmError(
                    status,
                    clip(text),
                    `LLM provider response from ${url} carried no choices[0].message.`
                )
            };
        }

        const response: ChatResponse = { message: messageOf(turn) };
        const usage = usageOf(root);

        if (usage !== null) response.usage = usage;

        return { kind: 'ok', response };
    };

    return {
        complete: async (request: ChatRequest): Promise<ChatResponse> => {
            const { signal } = request;

            // A signal that is already aborted never opens a socket: the executor aborts on
            // teardown (S-3), and a stale request must not reach the provider at all.
            if (signal?.aborted) throw abortReason(signal);

            const payload = payloadOf(request);
            let lastError: LlmError | undefined;

            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
                let outcome: SendOutcome;

                try {
                    outcome = await sendOnce(payload, signal);
                } catch (error) {
                    if (isAbortError(error)) throw error;

                    // `sendOnce` only throws on abort, so this is defensive: a host `fetch`
                    // that rejects late must still surface as an `LlmError`, never a raw fault.
                    lastError = transportError(error, url);

                    if (attempt === MAX_ATTEMPTS) break;
                    await backoff(retryDelayMs, signal);
                    continue;
                }

                if (outcome.kind === 'ok') return outcome.response;
                if (outcome.kind === 'fatal') throw outcome.error;

                lastError = outcome.error;

                if (attempt === MAX_ATTEMPTS) break;
                await backoff(retryDelayMs, signal);
            }

            throw lastError ?? new LlmError(0, '', `LLM request to ${url} produced no outcome.`);
        }
    };
};
