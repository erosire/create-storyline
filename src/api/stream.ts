// The live update plane: this package's WebSocket client for the storyline stream.
//
// WHY THIS FILE EXISTS: `@underload/harness` ships a browser stream client
// (`src/frontend/stream.ts`) but does NOT publish it — the `@underload/harness/
// frontend` barrel exports the REST surface plus `streamSocketUrl`, and
// `createHarnessStream` stays shell-private. The frame vocabulary lives in the
// package's `src/shared/harness-stream.ts`, which has no exports subpath either
// (`@underload/harness/shared` re-exports origin/attachments/agent-results only).
// So the frames are re-declared here, each with its source comment — the same
// documented workaround `distribution/chat-assistant/src/api/harness-stream.ts`
// carries. Only the subset this UI consumes is modelled, and an unknown frame or
// op is data to tolerate, never a failure.
//
// WHAT THIS CLIENT DOES: one socket per observation, opened with the `harness.v1`
// subprotocol against `streamSocketUrl()` (which the harness client derives from
// the SAME root the REST calls use — see ./root.ts, so the two can never
// disagree). It subscribes to the scopes that carry what the UI renders:
//
//   session scope -> `turn.upsert` (whole turn row: start + every terminal
//                    transition), `session.updated`, `records.updated`,
//                    `usage.updated`; every other kind (including
//                    `transcript.updated`, whose only publisher is the REST transcript
//                    PUT) is tolerated and not surfaced — see `StorylineStreamEvents`
//   turn scope    -> `display.ops`, the token-level deltas. Deltas ride ONLY the
//                    turn scope (<=32 ops per frame, `node:append` capped at
//                    2000 chars), which is why a streaming answer needs a turn
//                    subscription and not just the session one.
//
// THE RULES THAT MAKE IT CORRECT (each one is a bug the naive version has):
//   1. `sequence` is monotonic per subscription. `sequence > want` is a GAP: this
//      client re-subscribes that subscription from its own cursor AND reports
//      `frames_dropped`, because quietly continuing renders a wrong answer.
//   2. `resync_required` (cursor_expired | epoch_mismatch | frames_dropped) and a
//      reconnect are both REPORTED, never resolved in place. The owner re-reads
//      the canonical resource over REST. That is deliberately the caller's job
//      here: this module keeps zero imports from ./storyline.ts (no cycle, and a
//      test can drive it with nothing but a fake socket).
//   3. A dropped socket NEVER cancels the server-side run — execution is
//      server-owned. This closes and re-dials an OBSERVATION, resuming with a
//      `hello` {epoch, cursor} as the FIRST frame (a late hello is refused).
//   4. Liveness is the contract's own heartbeat budget: three silent intervals
//      close THIS side with 4408 and dial again. A browser gives no timeout for a
//      half-open socket, so without it a stalled stream hangs the composer's Stop
//      button forever.
//
// The accumulated answer is rebuilt from the OPS, not from a per-frame string:
// `node:insert` records a node's kind and initial text, `node:append` adds a
// delta, `node:remove`/`attempt:discard` drop exactly the nodes they name, and
// only TEXT nodes of the ANSWERING section reach `onText`. The answering section is
// the flow this turn answers AS: the session primary's primary-role section when one
// exists, otherwise the ROOT section — a host thread addressed at `reader`/`editor`
// projects a `subagent`-role ROOT section (harness `src/server/turn-projector.ts:723`
// and `:953`), and its prose is still the answer the stage must paint. A NESTED
// (delegated) section's prose is never glued onto it and never replaces it.
// Reasoning deltas go to a separate buffer so the answer never mixes them in.
//
// WHAT THE STORYLINE SURFACES ALSO NEED (R-H): two more folds, both derived from
// frames the session scope already publishes (harness src/server/stream/protocol.ts:73
// — the session scope publishes `turn.upsert`, `records.updated` AND `thread.upsert`):
//   - `onThread`  — one whole `ThreadSummary` row per `thread.upsert` frame
//                   (`payload.thread`, harness src/server/api.ts:1394), which is how the
//                   agents panel learns that the editor's conversation is `running`;
//   - `onSection` — the identity and STATE of one display section from `section:open` /
//                   `section:set` (`TurnSection.state`, harness src/shared/turn-display.ts:195),
//                   the cheapest honest "what is that agent doing right now" the contract has.
// Both ride the SAME subscription, so no extra scope is opened and nothing is polled
// between frames; `GET .../threads` over REST stays the cold-start and reconnect baseline.
import { STORYLINE_API_ROOT } from './root';

// ---------------------------------------------------------------------------
// Re-declared frame vocabulary (source: packages/underload/harness/src/shared/
// harness-stream.ts, generated from src/server/harness.swagger.yaml)
// ---------------------------------------------------------------------------

/** The negotiated subprotocol. Source: harness `src/shared/harness-api.ts:42`. */
export const HARNESS_WS_SUBPROTOCOL = 'harness.v1';

/** `WsSubscriptionScope` — the four addressable scopes. Source: harness-stream.ts:201. */
export type WsScope = 'global' | 'session' | 'thread' | 'turn';

/**
 * `WsStreamLimits` (the subset this client ACTS on), restated at the contract's
 * defaults so a `welcome` frame only has to OVERRIDE them — a deployment that
 * tunes a value inside its declared bounds is followed without a rebuild.
 * Source: harness-stream.ts:28-49.
 */
export const HARNESS_WS_LIMITS = {
    heartbeat_interval_ms: 15000,
    heartbeat_timeout_intervals: 3,
    heartbeat_timeout_close_code: 4408,
    ops_per_update_frame: 32,
    delta_chars_per_append_op: 2000
} as const;

/** `WsWelcome` (harness-stream.ts:470) — the first server frame. */
type WsWelcome = { type: 'welcome'; protocol: string; epoch: string; at: number; limits?: Record<string, number> };

/** `WsSubscriptionState` (harness-stream.ts:502) — one subscription's baseline. */
type WsSubscriptionState = {
    type: 'subscription_state';
    subscription_id: string;
    scope: WsScope;
    epoch: string;
    sequence: number;
    cursor: string;
};

/**
 * `TurnDisplayOp` (harness-stream.ts:141) — one addressed display mutation. Only
 * the fields this client reads are declared. `section:open` carries a whole
 * `TurnSection` copy with `nodes: []` (harness `src/server/turn-projector.ts:817`),
 * so `role`, `agent` and `parentSectionId` are the fields that identify WHICH flow
 * a node belongs to — the answer rule below reads them — and `state` / `threadId` /
 * `startedAt` are what the agents panel reads for a live phase. `section:set` carries
 * a `TurnSectionPatch` (turn-display.ts:1043) instead, which patches only the fields
 * it names, so the fold merges rather than replaces.
 */
type WsDisplayOp = {
    op: string;
    turnId?: string;
    sectionId?: string;
    nodeId?: string;
    nodeIds?: string[];
    delta?: string;
    patch?: Record<string, unknown>;
    section?: { id?: string; role?: string; agent?: string; parentSectionId?: string; state?: string; threadId?: string; startedAt?: number; endedAt?: number };
    node?: { id?: string; kind?: string; text?: string };
};

// ---------------------------------------------------------------------------
// The answer-section rule (shared with the REST read path in ./storyline.ts)
// ---------------------------------------------------------------------------
//
// WHY IT EXISTS: the projector stamps `role: 'primary'` on a section ONLY when that
// section is the turn's root AND its agent is the session primary (harness
// `src/server/turn-projector.ts:723`, repeated for a threadless flow at `:953`, and
// `src/server/api-reads.ts:1145` is where a read surfaces it). A host-thread run of
// `reader` or `editor` therefore answers as a `subagent`-role ROOT section, and any
// extraction keyed on `role === 'primary'` alone returns '' for two of this UI's
// three agents. This is the one rule both planes use.
//
// The order below is a preference chain, not a guess:
//   1. the section that is BOTH the primary flow AND the agent this UI addressed the
//      turn to — the classic writer turn;
//   2. the ROOT section of that agent — a thread-targeted turn, whose root section IS
//      the answering agent's flow (`parentSectionId` absent is what "root" means; the
//      projector resolves nesting server-side, `TurnSection.parentSectionId`);
//   3. any section of that agent — a delegated child that answers the same agent;
//   4. the primary flow, whatever the hint said;
//   5. the root section — a fold that never learned the hint (the live plane has
//      none: one turn scope carries one turn, and its root section answers);
//   6. the caller's "has prose" section — the last honest look before answering ''.
// Exactly ONE section supplies the answer, so a delegated child's report can never be
// concatenated onto it (double-printing) or overwrite it.

/** The identity fields of one display section, as BOTH producers send them: the cold
 *  document (`TurnSection`, harness `src/shared/turn-display.ts:953`) and the live
 *  `section:open` op. */
export type DisplaySectionShape = {
    id?: string;
    /** `DisplayRole` — anything that is not the literal `'subagent'` is a primary flow. */
    role?: string;
    /** The agent this section's flow belongs to. */
    agent?: string;
    /** Absent on a root section; the nesting the projector resolved server-side. */
    parentSectionId?: string;
};

export type AnswerSectionOptions<T extends DisplaySectionShape> = {
    /** The agent this UI addressed the turn to (a thread-targeted turn answers AS it). */
    agent?: string;
    /** "This section carries prose." Supplied by each caller because the node
     *  bookkeeping differs: a document's `nodes` array vs. this client's folded map. */
    hasText?: (section: T) => boolean;
};

/**
 * The answer sections of one turn, best first. Callers take the first candidate that
 * actually carries prose, which is what makes "prefer the answering agent, fall back
 * to primary, else any text-bearing section" one deterministic chain instead of a
 * pile of conditionals.
 */
export const answerSectionCandidates = <T extends DisplaySectionShape>(
    sections: readonly T[],
    options: AnswerSectionOptions<T> = {}
): T[] => {
    const hint = typeof options.agent === 'string' && options.agent.length > 0 ? options.agent : undefined;
    // A section is primary unless the server said `subagent` — the tolerant reading the
    // live fold has always applied (its old rule was `role !== 'subagent'` per node).
    const isPrimary = (section: T): boolean => section.role !== 'subagent';
    const isRoot = (section: T): boolean => section.parentSectionId === undefined || section.parentSectionId === '';
    const isHinted = (section: T): boolean => hint !== undefined && section.agent === hint;

    const preferred = [
        ...(hint === undefined ? [] : [sections.find((section) => isHinted(section) && isPrimary(section))]),
        ...(hint === undefined ? [] : [sections.find((section) => isHinted(section) && isRoot(section))]),
        ...(hint === undefined ? [] : [sections.find(isHinted)]),
        sections.find(isPrimary),
        sections.find(isRoot),
        ...(options.hasText === undefined ? [] : [sections.find(options.hasText)])
    ];

    const ordered: T[] = [];

    for (const section of preferred) {
        // `find` can miss, and the same section can satisfy two tiers; both are skips,
        // not candidates, and the first match keeps winning.
        if (section === undefined) continue;
        if (ordered.includes(section)) continue;
        ordered.push(section);
    }

    return ordered;
};

/** The subset of `TurnSummary` (harness-api.ts:2030) a consumer reads. camelCase by contract. */
export type HarnessTurnFrame = {
    id: string;
    index: number;
    status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
    state?: string;
    threadId?: string;
    threadLabel?: string;
    updatedAt: number;
    startedAt?: number;
    promptPreview?: string;
    /** Every agent with live work in this turn — the fallback attribution when a
     *  turn row carries no `threadId` (a threadless flow). */
    activeAgents?: string[];
    detail?: string;
};

/**
 * The roster row BOTH planes read: a `ThreadSummary` from `GET .../threads` (harness
 * harness-api.ts:1670) or the whole row inside a `thread.upsert` frame
 * (`payload.thread`, harness src/server/api.ts:1394). One type for both, because the
 * wire sends the same snake_case row and the agents panel must not disagree with the
 * REST roster it re-reads on a reconnect.
 *
 * The name is this package's, and ./storyline.ts re-exports it as the record its api
 * returns — `sequence` (not a timestamp) is the ordering the thread-reuse rule uses,
 * and there are NO per-thread timestamps in the contract, so a row answers "which
 * conversation, in what state" and never "when".
 *
 * `ownerThreadId` is the delegation link (`ThreadSummary.owner_thread_id`, harness
 * harness-api.ts:1676) and it is the field that decides whether a row is THE
 * conversation for its agent or somebody else's work in progress: an agent the writer
 * delegated to answers in a host thread that carries `owner_thread_id`, and `origin`
 * alone cannot tell the two apart. Without this projection the composer could not see
 * the difference and would type into the delegated child (see `selectAgentThread`).
 */
export type StorylineThreadRef = {
    id: string;
    agent: string;
    origin: 'host' | 'agent' | '';
    status: 'idle' | 'running' | 'paused' | 'stopped' | '';
    sequence: number;
    /** The conversation this one was delegated from; '' when it is top-level. */
    ownerThreadId: string;
    label: string;
    messageCount: number;
    transcriptState: 'ok' | 'unreadable' | '';
};

/** Total projection of one roster row (REST item or stream payload) — never throws. */
export const threadFrameFromRow = (row: unknown): StorylineThreadRef => {
    const source = typeof row === 'object' && row !== null ? (row as Record<string, unknown>) : {};
    const origin = typeof source.origin === 'string' ? source.origin : '';
    const status = typeof source.status === 'string' ? source.status : '';
    const transcript = typeof source.transcript_state === 'string' ? source.transcript_state : '';
    const count = typeof source.message_count === 'number' && Number.isFinite(source.message_count) ? source.message_count : 0;

    return {
        id: typeof source.id === 'string' ? source.id : '',
        agent: typeof source.agent === 'string' ? source.agent : '',
        origin: origin === 'host' || origin === 'agent' ? origin : '',
        status: status === 'idle' || status === 'running' || status === 'paused' || status === 'stopped' ? status : '',
        sequence: typeof source.sequence === 'number' && Number.isFinite(source.sequence) ? source.sequence : 0,
        ownerThreadId: typeof source.owner_thread_id === 'string' ? source.owner_thread_id : '',
        label: typeof source.label === 'string' ? source.label : '',
        messageCount: count,
        transcriptState: transcript === 'ok' || transcript === 'unreadable' ? transcript : ''
    };
};

/**
 * One display section's identity and state, folded from `section:open` / `section:set`
 * and published to the agents panel. `state` is `SectionDisplayState`
 * (harness turn-display.ts:195: `open | streaming | done | error | cancelled`) — the
 * only "phase" the contract states, so the panel labels THIS rather than inventing one.
 */
export type HarnessSectionFrame = {
    turnId: string;
    sectionId: string;
    agent: string;
    role: string;
    state: string;
    threadId: string;
    startedAt: number | null;
    endedAt: number | null;
};

/** `WsUpdate` variants this client routes (harness-stream.ts:530/561/577/590). */
type WsUpdate = {
    type: 'update';
    subscription_id: string;
    sequence: number;
    cursor: string;
    kind: string;
    at: number;
    turn?: HarnessTurnFrame;
    turn_id?: string;
    ops?: WsDisplayOp[];
    usage_patch?: { input?: number; output?: number; total?: number; cached?: number };
    session?: Record<string, unknown>;
    /** `thread.upsert`'s payload field: one whole `ThreadSummary` row (harness src/server/api.ts:1394). */
    thread?: unknown;
    /** `records.updated`'s payload field: the two watermarks, nested (`WsUpdateRecords`, harness-stream.ts:108; minted at harness src/server/api.ts:1451). */
    records?: { store_rev?: number; collections_rev?: number };
    store_rev?: number;
    collections_rev?: number;
};

/** `WsResyncRequired` (harness-stream.ts:778). */
type WsResyncRequired = {
    type: 'resync_required';
    subscription_id: string;
    reason: 'cursor_expired' | 'epoch_mismatch' | 'frames_dropped';
    epoch: string;
    cursor: string;
};

/** `WsProtocolError` (harness-stream.ts:796). */
export type WsProtocolError = {
    type: 'error';
    code: string;
    message: string;
    subscription_id?: string;
    retryable: boolean;
    close_code?: number;
};

type WsServerFrame =
    | WsWelcome
    | WsSubscriptionState
    | WsUpdate
    | WsResyncRequired
    | WsProtocolError
    | { type: string; at?: number };

/** The client frames this module ever sends (harness-stream.ts:310/457/479/541). */
type WsClientFrame =
    | { type: 'hello'; protocol: string; epoch: string; cursor: string }
    | {
          type: 'subscribe';
          subscription_id: string;
          scope: WsScope;
          session_id?: string;
          turn_id?: string;
          pace?: 'ordered' | 'ack';
          cursor?: string;
      }
    | { type: 'unsubscribe'; subscription_id: string }
    | { type: 'bye'; reason?: string };

// ---------------------------------------------------------------------------
// The socket seam (structural, so a test double satisfies it without pretending
// to be a browser)
// ---------------------------------------------------------------------------

export type StreamSocket = {
    send(data: string): void;
    close(code?: number, reason?: string): void;
    onopen: (() => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    onerror: (() => void) | null;
    onclose: ((event: { code?: number; reason?: string }) => void) | null;
};

export type StreamSocketFactory = (url: string, protocol: string) => StreamSocket;

/** `(fn, ms) => cancel` — injectable clock, so a test fires a deadline on demand. */
export type StreamScheduler = (fn: () => void, ms: number) => () => void;

export type StreamStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/** Why an observation asked its owner to re-read a resource over REST. */
export type StreamResyncReason = 'cursor_expired' | 'epoch_mismatch' | 'frames_dropped' | 'reconnected';

export type StorylineStreamEvents = {
    /** The ACCUMULATED answer of one turn — the answering agent's prose — after every delta. */
    onText?: (text: string, turnId: string) => void;
    /** The accumulated reasoning text, kept apart from the answer. */
    onReasoning?: (text: string, turnId: string) => void;
    /** One whole turn row (start + every terminal transition). */
    onTurn?: (turn: HarnessTurnFrame) => void;
    /** One whole conversation roster row (`thread.upsert`) — the agents panel's live thread state. */
    onThread?: (thread: StorylineThreadRef) => void;
    /** One display section's identity/state (`section:open`, `section:set`) — the live phase of one agent. */
    onSection?: (section: HarnessSectionFrame) => void;
    /** A usage patch (per-turn or per-session figure). */
    onUsage?: (usage: { input?: number; output?: number; total?: number; cached?: number }, turnId?: string) => void;
    /** Session metadata patch (`session.updated`) — the header follows the status here. */
    onSession?: (patch: Record<string, unknown>) => void;
    /** The record store moved (`records.updated`): watermarks only, a reader re-reads the snapshot. */
    onRecords?: (signal: { storeRev: number; collectionsRev: number }) => void;
    // NO transcript hook, on purpose (T13). The wire's `transcript.updated` frame names a
    // conversation whose TRANSCRIPT DOCUMENT was replaced, and the store publishes it from ONE
    // route only — the REST transcript PUT (harness src/server/sessions.ts:9158, in
    // `updateThreadTranscript`) — never from a run appending its own messages. A chained
    // `sendThreadInput` run therefore produces no such frame, and an `onTranscript` surface
    // wired to it would be a callback the workstation can never receive: the conversation read
    // is cued by `thread.upsert`'s `message_count` and by `records.updated` instead
    // (src/dashboard/plugins/agents.ts). Such a frame is still an unknown kind to tolerate.
    /** Connection lifecycle, for the composer's "reconnecting" affordance and for tests. */
    onStatus?: (status: StreamStatus) => void;
    /** A bounded REST re-read is needed: this client never guesses what the dropped frames held. */
    onResync?: (reason: StreamResyncReason, turnId: string | undefined) => void;
    /** A protocol error naming one of this client's subscriptions. */
    onError?: (error: WsProtocolError) => void;
};

export type StorylineStreamOptions = {
    /** The session whose scopes this observation follows. */
    sessionId: string;
    /** Turn scopes to open immediately (deltas need one; the session scope alone never carries text). */
    turnIds?: readonly string[];
    events?: StorylineStreamEvents;
    /** Defaults to `streamSocketUrl()`-style join of STORYLINE_API_ROOT on this page's origin. */
    socketUrl?: string;
    /** Defaults to `new globalThis.WebSocket(url, [subprotocol])`. */
    socketFactory?: StreamSocketFactory;
    /** Defaults to setTimeout/clearTimeout. */
    schedule?: StreamScheduler;
    /** Resume state override for a host that persisted {epoch, cursor} across reloads. */
    resume?: { epoch: string; cursor: string };
    /** Stop the reconnect loop after this many attempts (0 = forever, the default). */
    maxReconnectAttempts?: number;
};

export type StorylineStreamHandle = {
    /** Open the connection (idempotent while connecting/open). */
    connect(): void;
    /** Add one turn scope — a submit learns its turn id only after the socket is up. */
    followTurn(turnId: string): void;
    /** Ask the owner for a bounded REST re-read of one turn now (same path a gap takes). */
    requestResync(turnId?: string): void;
    /** The epoch/cursor last APPLIED — the resume token, and the figure a caller compares against. */
    resumeState(): { epoch: string | null; cursor: string | null };
    status(): StreamStatus;
    /** The accumulated answer of one turn (the answering section's prose) — what a
     *  late-mounted surface paints. */
    textOf(turnId?: string): string;
    /** Clean goodbye: `bye` then close 1000. Subscriptions are released; the RUN is not touched. */
    close(reason?: string): void;
};

// Reconnect backoff: capped exponential with jitter (500ms base, 10s cap), so a
// server restart does not turn every open tab into a thundering redial.
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

/** True for the turn states that end a streamed answer. */
export const isTerminalTurnStatus = (status: HarnessTurnFrame['status'] | string): boolean =>
    status === 'done' || status === 'error' || status === 'cancelled';

const defaultSchedule: StreamScheduler = (fn, ms) => {
    const timer = globalThis.setTimeout(fn, ms);

    return () => globalThis.clearTimeout(timer);
};

/** The default factory: the platform WebSocket, or nothing when the host has none. */
const defaultFactory = (): StreamSocketFactory | undefined => {
    const ctor = (globalThis as unknown as {
        WebSocket?: new (url: string, protocols: readonly string[]) => StreamSocket;
    }).WebSocket;

    return typeof ctor === 'function' ? (url, protocol) => new ctor(url, [protocol]) : undefined;
};

/**
 * A root-relative path (`/v1/storyline/stream`) must be upgraded against THIS
 * page's origin; an absolute http(s) URL only needs its scheme swapped; an
 * absolute ws(s) URL is already what to dial. Same rule the harness client's own
 * `streamSocketUrl` applies, kept local so this module has no import cycle.
 */
const socketUrlOf = (root: string): string => {
    if (/^wss?:\/\//i.test(root)) return root;
    if (/^https:\/\//i.test(root)) return `wss://${root.slice('https://'.length)}`;
    if (/^http:\/\//i.test(root)) return `ws://${root.slice('http://'.length)}`;

    const origin = globalThis.location?.origin ?? 'http://localhost';

    return `${origin.startsWith('https:') ? 'wss' : 'ws'}://${origin.slice(origin.indexOf('//') + 2)}${root}`;
};

/** Default socket target: this page's origin + the storyline root + `/stream`. */
const defaultSocketUrl = (): string => {
    const path = `${STORYLINE_API_ROOT}/stream`;

    return socketUrlOf(globalThis.location ? `${globalThis.location.origin}${path}` : path);
};

/**
 * Open one stream observation for one session.
 *
 * Everything environmental is injectable (socket, clock, url) because the
 * correct behaviour — gap detection, heartbeat close, resume — is exactly the
 * behaviour a test must be able to force without a server.
 */
export const createStorylineStream = (options: StorylineStreamOptions = {} as StorylineStreamOptions): StorylineStreamHandle => {
    const events = options.events ?? {};
    const schedule = options.schedule ?? defaultSchedule;
    const factory = options.socketFactory ?? defaultFactory();
    const maxAttempts = options.maxReconnectAttempts ?? 0;

    // The contract's tunables, re-adopted from the `welcome` frame when it carries
    // them (a deployment may tune inside its declared bounds). The `number`
    // annotations matter: the defaults come from an `as const` object, whose
    // literal types would otherwise refuse the re-adopted value.
    let heartbeatIntervalMs: number = HARNESS_WS_LIMITS.heartbeat_interval_ms;
    let heartbeatTimeoutIntervals: number = HARNESS_WS_LIMITS.heartbeat_timeout_intervals;
    let heartbeatCloseCode: number = HARNESS_WS_LIMITS.heartbeat_timeout_close_code;

    let socket: StreamSocket | undefined;
    let status: StreamStatus = 'idle';
    let attempts = 0;
    let manualClose = false;
    let reconnectCancel: (() => void) | undefined;
    let heartbeatCancel: (() => void) | undefined;

    // Resume state: the epoch of the server this client last spoke to, and the
    // highest cursor it APPLIED. A cursor from an OLD epoch is refused with
    // `epoch_mismatch` — the honest answer, and the reason this client reports a
    // re-read instead of replaying.
    let epoch: string | null = options.resume?.epoch ?? null;
    let cursor: string | null = options.resume?.cursor ?? null;

    type Subscription = {
        id: string;
        scope: WsScope;
        turnId?: string;
        cursor: string | null;
        /** The sequence the NEXT frame must carry; null = nothing seen yet (a fresh baseline cannot gap). */
        want: number | null;
    };

    const subscriptions = new Map<string, Subscription>();
    let nextSubscriptionId = 0;

    // The display fold, keyed by TURN: one connection can follow several turns,
    // and a shared fold would interleave two answers.
    //   sections — `turn::section` -> the identity `section:open` named (the ordering
    //              contract guarantees it precedes every op naming that section, so the
    //              flow a node belongs to is always known in time);
    //   nodes    — `turn::node` -> {kind, text, sectionId}; the answer is the ANSWERING
    //              section's `text` nodes in insertion order (see `answerSectionCandidates`
    //              above), which is why a `node:remove` between appends cannot leave a
    //              stale fragment behind.
    type SectionFold = DisplaySectionShape & {
        id: string;
        /** `SectionDisplayState` (harness turn-display.ts:195) — what that flow is doing right now. */
        state: string;
        threadId: string;
        startedAt: number | null;
        endedAt: number | null;
    };
    type NodeFold = { kind: string; text: string; order: number; sectionId?: string };
    const foldKey = (turnId: string, id: string): string => `${turnId}::${id}`;
    const sections = new Map<string, SectionFold>();
    const nodes = new Map<string, NodeFold>();
    const textByTurn = new Map<string, string>();
    const reasoningByTurn = new Map<string, string>();
    let insertOrder = 0;
    // The turn treated as "the answer being streamed" when exactly one is followed
    // — the fallback key for an op that names no turn of its own.
    let focusTurnId: string | undefined = options.turnIds?.[0];

    const setStatus = (next: StreamStatus): void => {
        if (status === next) return;
        status = next;
        events.onStatus?.(next);
    };

    const send = (frame: WsClientFrame): boolean => {
        if (socket === undefined || status !== 'open') return false;

        try {
            socket.send(JSON.stringify(frame));

            return true;
        } catch {
            // A socket that throws on send is a dead one; the close handler and the
            // reconnect path own the recovery.
            return false;
        }
    };

    const sendSubscribe = (sub: Subscription): void => {
        send({
            type: 'subscribe',
            subscription_id: sub.id,
            scope: sub.scope,
            ...(options.sessionId.length === 0 ? {} : { session_id: options.sessionId }),
            ...(sub.scope === 'turn' && sub.turnId !== undefined ? { turn_id: sub.turnId } : {}),
            pace: 'ordered',
            ...(sub.cursor === null || sub.cursor === '' ? {} : { cursor: sub.cursor })
        });
    };

    const openSubscription = (scope: WsScope, turnId?: string): Subscription => {
        nextSubscriptionId += 1;

        const sub: Subscription = {
            id: `sl-${nextSubscriptionId}`,
            scope,
            ...(turnId === undefined ? {} : { turnId }),
            cursor: null,
            want: null
        };

        subscriptions.set(sub.id, sub);
        if (status === 'open') sendSubscribe(sub);
        else connect();

        return sub;
    };

    const clearHeartbeat = (): void => {
        if (heartbeatCancel !== undefined) {
            heartbeatCancel();
            heartbeatCancel = undefined;
        }
    };

    // Every inbound frame is liveness; the DEADLINE is always interval*intervals,
    // so a busy publisher does not buy itself immunity and a silent one is caught.
    const armHeartbeat = (): void => {
        clearHeartbeat();
        heartbeatCancel = schedule(() => {
            if (status !== 'open') return;
            socket?.close(heartbeatCloseCode, 'heartbeat timeout');
        }, heartbeatIntervalMs * heartbeatTimeoutIntervals);
    };

    const scheduleReconnect = (): void => {
        if (manualClose || reconnectCancel !== undefined) return;
        if (maxAttempts > 0 && attempts >= maxAttempts) {
            setStatus('closed');

            return;
        }

        const backoff = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempts);
        const jitter = Math.floor(backoff * 0.25 * Math.random());

        attempts += 1;
        reconnectCancel = schedule(() => {
            reconnectCancel = undefined;
            connect();
        }, backoff + jitter);
    };

    /**
     * The honest recovery: REPORT that a re-read is needed. The owner re-reads the
     * canonical resource over REST (the turns plugin does it with `getTurnDisplay`)
     * and replaces the row outright — appending to a fold that missed frames would
     * double-print a sentence.
     */
    const reportResync = (turnId: string | undefined, reason: StreamResyncReason): void => {
        events.onResync?.(reason, turnId ?? focusTurnId);
    };

    /** True when anything at all has folded for this turn — a turn with no sections and
     *  no nodes has nothing to paint, whatever key a caller passes. */
    const hasFold = (turnId: string): boolean => {
        const prefix = `${turnId}::`;

        for (const key of sections.keys()) if (key.startsWith(prefix)) return true;
        for (const key of nodes.keys()) if (key.startsWith(prefix)) return true;

        return false;
    };

    /** The `text` nodes folded for one turn, each carrying the section it belongs to
     *  (absent = a node whose `section:open` this client never saw). */
    const textNodesOfTurn = (turnId: string): Array<{ sectionId?: string; text: string; order: number }> => {
        const found: Array<{ sectionId?: string; text: string; order: number }> = [];

        for (const [key, fold] of nodes) {
            if (!key.startsWith(`${turnId}::`)) continue;
            if (fold.kind !== 'text') continue;

            const section = fold.sectionId === undefined ? {} : { sectionId: fold.sectionId };

            found.push({ ...section, text: fold.text, order: fold.order });
        }

        return found;
    };

    /**
     * The answer of one turn: the ANSWERING section's text nodes, in insertion order.
     * Recomputed from the fold rather than cached, because a later `section:open` can
     * change which section answers and a `node:remove` can take prose back out.
     */
    const foldAnswerText = (turnId: string): string => {
        const textNodes = textNodesOfTurn(turnId);
        const sectionsOfTurn: SectionFold[] = [];

        for (const [key, section] of sections) {
            if (key.startsWith(`${turnId}::`)) sectionsOfTurn.push(section);
        }

        // A node whose section this client never learned (its `section:open` was the
        // dropped frame) belongs to the ANSWER until the owner's canonical read replaces
        // the fold — the rule the old provisional `primary: true` node followed, and the
        // reason a gap keeps the answer growing instead of stalling.
        const joinOf = (sectionId: string | undefined): string =>
            textNodes
                .filter((node) => node.sectionId === sectionId || node.sectionId === undefined)
                .sort((left, right) => left.order - right.order)
                .map((node) => node.text)
                .join('');

        for (const section of answerSectionCandidates(sectionsOfTurn, {
            hasText: (candidate) => textNodes.some((node) => node.sectionId === candidate.id)
        })) {
            const text = joinOf(section.id);
            if (text.length > 0) return text;
        }

        return joinOf(undefined);
    };

    /** Publish the accumulated answer when (and only when) this op changed it. */
    const publishText = (turnId: string): void => {
        const next = foldAnswerText(turnId);

        if (next === textByTurn.get(turnId)) return;
        // Nothing has been said yet and nothing changed: emitting '' would replace the
        // stage's placeholder with an empty paragraph for a turn that has no prose.
        if (next.length === 0 && !textByTurn.has(turnId)) return;

        textByTurn.set(turnId, next);
        events.onText?.(next, turnId);
    };

    /** Publishes one section's identity and state for the agents panel (R-H). It fires
     *  on every `section:open` / `section:set`, because the fold is the only place that
     *  knows both halves; a consumer keyed on (turnId, sectionId) is idempotent, and
     *  per-subscription ordering is what makes the LAST state published the current one. */
    const publishSection = (turnId: string, sectionId: string): void => {
        const fold = sections.get(foldKey(turnId, sectionId));

        if (events.onSection === undefined || fold === undefined) return;

        events.onSection({
            turnId,
            sectionId,
            agent: fold.agent ?? '',
            role: fold.role ?? '',
            state: fold.state,
            threadId: fold.threadId,
            startedAt: fold.startedAt,
            endedAt: fold.endedAt
        });
    };

    /** Applies one display op to the fold. Painting happens through the callbacks. */
    const applyOp = (op: WsDisplayOp, frameTurnId: string | undefined): void => {
        const turnId = op.turnId ?? frameTurnId ?? focusTurnId;

        switch (op.op) {
            case 'section:open': {
                // Narrowing is done on a local `const` so the checked `id` stays narrowed
                // through the write below (a property check on `op` would not transfer).
                const section = op.section;

                if (turnId === undefined || section === undefined || section.id === undefined) return;

                sections.set(foldKey(turnId, section.id), {
                    id: section.id,
                    ...(section.role === undefined ? {} : { role: section.role }),
                    ...(section.agent === undefined ? {} : { agent: section.agent }),
                    ...(section.parentSectionId === undefined ? {} : { parentSectionId: section.parentSectionId }),
                    // `open` is the state of a freshly opened section (turn-display.ts:194),
                    // so a frame that omits `state` is honestly read as exactly that.
                    state: typeof section.state === 'string' ? section.state : 'open',
                    threadId: typeof section.threadId === 'string' ? section.threadId : '',
                    startedAt: typeof section.startedAt === 'number' ? section.startedAt : null,
                    endedAt: typeof section.endedAt === 'number' ? section.endedAt : null
                });

                publishSection(turnId, section.id);

                return;
            }
            case 'section:set': {
                // A `TurnSectionPatch` names ONLY the fields it changes (turn-display.ts:1043),
                // so identity survives and `state` moves — that move is the phase the agents
                // panel shows. A patch for a section whose `section:open` was the dropped frame
                // is dropped with it: the gap path already asks the owner for a canonical re-read,
                // and inventing a role-less section here could hijack the answer selection.
                if (turnId === undefined || op.sectionId === undefined) return;

                const fold = sections.get(foldKey(turnId, op.sectionId));

                if (fold === undefined) return;

                const patch = op.patch ?? {};

                if (typeof patch.state === 'string') fold.state = patch.state;
                if (typeof patch.agent === 'string') fold.agent = patch.agent;
                if (typeof patch.role === 'string') fold.role = patch.role;
                if (typeof patch.threadId === 'string') fold.threadId = patch.threadId;
                if (typeof patch.startedAt === 'number') fold.startedAt = patch.startedAt;
                if (typeof patch.endedAt === 'number') fold.endedAt = patch.endedAt;

                publishSection(turnId, op.sectionId);

                return;
            }
            case 'node:insert': {
                if (turnId === undefined || op.node?.id === undefined || op.node.kind === undefined) return;
                insertOrder += 1;

                const kind = op.node.kind;
                const text = typeof op.node.text === 'string' ? op.node.text : '';

                nodes.set(foldKey(turnId, op.node.id), {
                    kind,
                    text,
                    order: insertOrder,
                    ...(op.sectionId === undefined ? {} : { sectionId: op.sectionId })
                });

                // A node can arrive WITH text (a replayed or committed node), and that
                // text is already part of the answer — waiting for the next append would
                // show nothing for a turn that already has content.
                if (kind === 'text') publishText(turnId);

                return;
            }
            case 'node:append': {
                if (turnId === undefined || op.nodeId === undefined || typeof op.delta !== 'string') return;

                const key = foldKey(turnId, op.nodeId);
                const node = nodes.get(key);
                const delta = op.delta;

                // A delta whose `node:insert` was the dropped frame is NOT discarded: it
                // folds into a provisional node — in the section this op names, or with no
                // section at all when it does not — so the answer keeps growing, and the
                // owner's re-read replaces the fold with canonical text.
                const resolved: NodeFold = node ?? {
                    kind: 'text',
                    text: '',
                    order: ++insertOrder,
                    ...(op.sectionId === undefined ? {} : { sectionId: op.sectionId })
                };

                resolved.text += delta;
                if (node === undefined) nodes.set(key, resolved);

                if (resolved.kind === 'reasoning') {
                    const next = `${reasoningByTurn.get(turnId) ?? ''}${delta}`;

                    reasoningByTurn.set(turnId, next);
                    events.onReasoning?.(next, turnId);

                    return;
                }
                if (resolved.kind !== 'text') return;

                publishText(turnId);

                return;
            }
            case 'node:remove': {
                if (turnId === undefined || op.nodeId === undefined) return;
                nodes.delete(foldKey(turnId, op.nodeId));

                return;
            }
            case 'attempt:discard': {
                if (turnId === undefined) return;
                // A retry names the EXACT nodes to drop, so the fold never tracks an
                // attempt window itself.
                for (const id of op.nodeIds ?? []) nodes.delete(foldKey(turnId, id));

                return;
            }
            default:
                // Every other op (`turn`, `section:set`, `step:set`, `context:*`,
                // `tail:*`, `pending:set`, `usage`, `attempt:commit`) is display
                // detail this surface does not fold.
                return;
        }
    };

    const handleFrame = (raw: unknown): void => {
        if (typeof raw !== 'object' || raw === null || typeof (raw as { type?: unknown }).type !== 'string') return;
        const frame = raw as WsServerFrame;

        if (frame.type === 'welcome') {
            const welcome = frame as WsWelcome;

            attempts = 0;
            epoch = welcome.epoch;

            // Re-adopt the numbers IN FORCE on this connection, then re-arm: the
            // deadline set before the handshake used the shipped defaults.
            const limits = welcome.limits;

            if (typeof limits?.heartbeat_interval_ms === 'number') heartbeatIntervalMs = limits.heartbeat_interval_ms;
            if (typeof limits?.heartbeat_timeout_intervals === 'number') {
                heartbeatTimeoutIntervals = limits.heartbeat_timeout_intervals;
            }
            if (typeof limits?.heartbeat_timeout_close_code === 'number') {
                heartbeatCloseCode = limits.heartbeat_timeout_close_code;
            }
            if (status === 'open') armHeartbeat();

            return;
        }

        if (frame.type === 'subscription_state') {
            const state = frame as WsSubscriptionState;
            const sub = subscriptions.get(state.subscription_id);

            epoch = state.epoch;
            cursor = state.cursor;
            if (sub === undefined) return;
            sub.cursor = state.cursor;
            sub.want = state.sequence + 1;

            return;
        }

        if (frame.type === 'update') {
            const update = frame as WsUpdate;
            const sub = subscriptions.get(update.subscription_id);

            // A frame for a subscription this client released (or never opened)
            // names a resource no pane is showing: apply nothing.
            if (sub === undefined) return;

            // GAP by arithmetic: a server that dropped frames must say so, and a
            // client that can count notices when it did not.
            if (sub.want !== null && update.sequence > sub.want) {
                sub.want = null;
                send({ type: 'unsubscribe', subscription_id: sub.id });
                sendSubscribe(sub);
                reportResync(sub.turnId, 'frames_dropped');
            }

            sub.want = update.sequence + 1;
            sub.cursor = update.cursor;
            cursor = update.cursor;

            if (update.kind === 'turn.upsert' && update.turn !== undefined) {
                events.onTurn?.(update.turn);

                return;
            }

            // `thread.upsert` carries ONE whole roster row and nothing else
            // (`payload.thread`, harness src/server/api.ts:1394). A row with no id names
            // no conversation, so it changes nothing.
            if (update.kind === 'thread.upsert') {
                const thread = threadFrameFromRow(update.thread);
                if (thread.id.length === 0) return;

                events.onThread?.(thread);

                return;
            }

            if (update.kind === 'display.ops') {
                const turnId = update.turn_id ?? sub.turnId;

                if (turnId !== undefined) focusTurnId = turnId;
                for (const op of update.ops ?? []) applyOp(op, turnId);

                return;
            }

            if (update.kind === 'usage.updated') {
                events.onUsage?.(update.usage_patch ?? {}, update.turn_id ?? sub.turnId);

                return;
            }

            if (update.kind === 'session.updated') {
                events.onSession?.(update.session ?? {});

                return;
            }

            // `records.updated` carries the store watermarks only, NESTED under `records`
            // (`RecordsSignal`, harness-api.ts:1571; minted at harness src/server/api.ts:1451)
            // — a pane that wants the rows pages the REST snapshot, which is what the records
            // plugin does on this callback. The flat form is still read as a fallback, and
            // BOTH matter: the watermark is what tells that plugin whether this frame moved
            // the store at all.
            if (update.kind === 'records.updated') {
                const signal = update.records ?? update;

                events.onRecords?.({
                    storeRev: Number(signal.store_rev ?? 0),
                    collectionsRev: Number(signal.collections_rev ?? 0)
                });

                return;
            }

            // `transcript.updated` and every other kind land here: no pane wants them, so the
            // frame is data to tolerate and the cursor (already advanced above) is the whole
            // response. See `StorylineStreamEvents` for why there is no transcript callback.
            return;
        }

        if (frame.type === 'resync_required') {
            const resync = frame as WsResyncRequired;
            const sub = subscriptions.get(resync.subscription_id);

            epoch = resync.epoch;
            cursor = resync.cursor;
            if (sub === undefined) return;
            sub.cursor = resync.cursor;
            sub.want = null;
            reportResync(sub.turnId, resync.reason);

            return;
        }

        if (frame.type === 'error') {
            events.onError?.(frame as WsProtocolError);

            return;
        }

        // `heartbeat` / `pong`: the peer is alive, so the deadline moves.
        armHeartbeat();
    };

    const connect = (): void => {
        if (factory === undefined) {
            // No socket in this host at all (a bare-node test, a locked-down
            // browser): degraded observation, never a failed task — the caller
            // still learns the terminal state from its own canonical read.
            setStatus('closed');

            return;
        }

        if (status === 'connecting' || status === 'open') return;

        setStatus(attempts === 0 ? 'connecting' : 'reconnecting');
        manualClose = false;

        let created: StreamSocket;

        try {
            created = factory(socketUrlOf(options.socketUrl ?? defaultSocketUrl()), HARNESS_WS_SUBPROTOCOL);
        } catch {
            scheduleReconnect();

            return;
        }

        socket = created;
        armHeartbeat();

        created.onopen = () => {
            if (socket !== created) return;

            setStatus('open');
            armHeartbeat();

            // `hello` is the ONLY resume input, and only as the FIRST frame — so it
            // is sent exactly when there is a position to resume from.
            if (epoch !== null && cursor !== null) {
                send({ type: 'hello', protocol: HARNESS_WS_SUBPROTOCOL, epoch, cursor });
            }

            for (const sub of subscriptions.values()) sendSubscribe(sub);

            // A reconnect can silently miss deltas (the run kept going while the
            // socket was down), so every followed turn is re-read once, bounded.
            if (attempts > 0) {
                for (const sub of subscriptions.values()) {
                    if (sub.scope === 'turn' && sub.turnId !== undefined) reportResync(sub.turnId, 'reconnected');
                }
            }
        };

        created.onmessage = (messageEvent) => {
            if (socket !== created) return;
            armHeartbeat();

            let parsed: unknown;

            try {
                parsed = JSON.parse(String(messageEvent.data));
            } catch {
                return;
            }

            handleFrame(parsed);
        };

        created.onerror = () => {
            if (socket !== created) return;
            armHeartbeat();
        };

        created.onclose = () => {
            if (socket !== created) return;

            clearHeartbeat();
            socket = undefined;

            if (manualClose) {
                setStatus('closed');

                return;
            }

            // Every subscription re-registers after a reconnect, and the sequence
            // bookkeeping restarts so a fresh `subscription_state` baseline is not
            // compared against the old sequence space.
            for (const sub of subscriptions.values()) sub.want = null;
            setStatus('reconnecting');
            scheduleReconnect();
        };
    };

    // The session scope always exists: it carries `turn.upsert` and
    // `records.updated`, which is what ends a streamed answer and wakes the panels.
    openSubscription('session');
    for (const turnId of options.turnIds ?? []) openSubscription('turn', turnId);

    return {
        connect,

        followTurn: (turnId: string): void => {
            for (const sub of subscriptions.values()) {
                if (sub.scope === 'turn' && sub.turnId === turnId) return;
            }

            focusTurnId = turnId;
            openSubscription('turn', turnId);
        },

        requestResync: (turnId?: string): void => {
            reportResync(turnId ?? focusTurnId, 'frames_dropped');
        },

        resumeState: () => ({ epoch, cursor }),

        status: () => status,

        // The accumulated answer of one turn (or of the focused turn), recomputed from
        // the fold so a surface that mounts mid-stream paints what already arrived —
        // including a fold that gained or lost a section since the last emission.
        textOf: (turnId?: string): string => {
            const key = turnId ?? focusTurnId ?? '';

            if (hasFold(key)) return foldAnswerText(key);

            // No key match: the single followed turn, when there is exactly one — one
            // observation never shows another turn's answer as an empty pane.
            if (textByTurn.size === 1) return foldAnswerText([...textByTurn.keys()][0] as string);

            return '';
        },

        close: (reason?: string): void => {
            manualClose = true;
            clearHeartbeat();

            if (reconnectCancel !== undefined) {
                reconnectCancel();
                reconnectCancel = undefined;
            }

            if (status === 'open') send({ type: 'bye', ...(reason === undefined ? {} : { reason }) });
            socket?.close(1000, reason ?? 'client bye');

            socket = undefined;
            subscriptions.clear();
            setStatus('closed');
        }
    };
};
