// Contract tests for this package's storyline stream client.
//
// Why this file exists at all: the WS protocol module is not published by
// `@underload/harness` (see the header of ./stream.ts), so the subscription,
// replay, gap, and heartbeat rules are local implementation and have to be pinned
// locally. A fake socket + fake clock make every rule observable without a server:
// Math.random is pinned to 0 so reconnect backoff is an EXACT number.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HARNESS_WS_LIMITS, HARNESS_WS_SUBPROTOCOL, createStorylineStream, isTerminalTurnStatus } from './stream';
import type { HarnessTurnFrame, StreamScheduler, StreamSocket, StreamStatus, WsProtocolError } from './stream';

// jsdom's default document origin; the socket target is derived from the SAME
// root the REST calls use, which is what ties the two planes together.
const SOCKET_URL = 'ws://localhost:3000/v1/storyline/stream';
const SESSION_ID = 'sess-1';
const HEARTBEAT_MS = HARNESS_WS_LIMITS.heartbeat_interval_ms * HARNESS_WS_LIMITS.heartbeat_timeout_intervals;

/** Structural `StreamSocket` double: records sends/closes, driven by the test. */
class FakeSocket implements StreamSocket {
    readonly url: string;
    readonly protocol: string;
    readonly sent: unknown[] = [];
    readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    // Optional event arg: the client writes a 1-arg handler here, and the test
    // driver fires it with no close event at all (a transport drop carries one).
    onclose: ((event?: { code?: number; reason?: string }) => void) | null = null;

    constructor(url: string, protocol: string) {
        this.url = url;
        this.protocol = protocol;
    }

    send(data: string) {
        this.sent.push(JSON.parse(data) as unknown);
    }

    close(code?: number, reason?: string) {
        this.closeCalls.push({ code, reason });
    }

    // --- test-side drivers -------------------------------------------------
    emitOpen() {
        this.onopen?.();
    }

    emit(frame: Record<string, unknown>) {
        this.onmessage?.({ data: JSON.stringify(frame) });
    }

    emitClose() {
        this.onclose?.({});
    }
}

/** Manual clock: heartbeat deadlines and reconnect backoff run when told to. */
class FakeClock {
    private nextId = 1;
    private readonly timers = new Map<number, { ms: number; run: () => void }>();

    readonly schedule: StreamScheduler = (fn, ms) => {
        const id = this.nextId++;
        this.timers.set(id, {
            ms,
            run: () => {
                this.timers.delete(id);
                fn();
            }
        });

        return () => {
            this.timers.delete(id);
        };
    };

    /** Every deadline currently armed, so a test can prove nothing extra is. */
    pending() {
        return [...this.timers.values()].map((timer) => timer.ms);
    }

    run(ms: number) {
        const entry = [...this.timers.entries()].find(([, timer]) => timer.ms === ms);
        if (entry === undefined) {
            throw new Error(`no timer armed for ${ms}ms; pending=${JSON.stringify(this.pending())}`);
        }
        entry[1].run();
    }
}

/** The handshake every later test needs: open, welcome, then one baseline per subscription. */
function handshake(socket: FakeSocket, baselines: Array<{ id: string; scope: string; sequence: number; cursor: string; epoch?: string }>) {
    socket.emitOpen();
    socket.emit({ type: 'welcome', protocol: HARNESS_WS_SUBPROTOCOL, epoch: 'ep-1', at: 1 });
    for (const baseline of baselines) {
        socket.emit({ type: 'subscription_state', subscription_id: baseline.id, scope: baseline.scope, epoch: baseline.epoch ?? 'ep-1', sequence: baseline.sequence, cursor: baseline.cursor });
    }
}

function setup(options: { turnIds?: readonly string[]; maxReconnectAttempts?: number } = {}) {
    const sockets: FakeSocket[] = [];
    const clock = new FakeClock();
    const statuses: StreamStatus[] = [];
    const turns: HarnessTurnFrame[] = [];
    const texts: Array<{ text: string; turnId: string }> = [];
    const reasoning: Array<{ text: string; turnId: string }> = [];
    const usage: Array<{ patch: unknown; turnId?: string }> = [];
    const sessions: unknown[] = [];
    const records: Array<{ storeRev: number; collectionsRev: number; thread?: unknown; section?: unknown }> = [];
    // Roster and flow frames: the transcript pane and the center pane watch these
    // instead of polling the thread list or the snapshot.
    const threads: unknown[] = [];
    const sections: unknown[] = [];
    const resyncs: Array<{ reason: string; turnId?: string }> = [];
    const errors: WsProtocolError[] = [];

    const handle = createStorylineStream({
        sessionId: SESSION_ID,
        ...(options.turnIds === undefined ? {} : { turnIds: options.turnIds }),
        ...(options.maxReconnectAttempts === undefined ? {} : { maxReconnectAttempts: options.maxReconnectAttempts }),
        schedule: clock.schedule,
        socketFactory: (url, protocol) => {
            const socket = new FakeSocket(url, protocol);
            sockets.push(socket);

            return socket;
        },
        events: {
            onStatus: (status) => statuses.push(status),
            onTurn: (turn) => turns.push(turn),
            onText: (text, turnId) => texts.push({ text, turnId }),
            onReasoning: (text, turnId) => reasoning.push({ text, turnId }),
            onUsage: (patch, turnId) => usage.push({ patch, turnId }),
            onSession: (patch) => sessions.push(patch),
            onRecords: (signal) => records.push(signal),
            onThread: (thread) => threads.push(thread),
            onSection: (section) => sections.push(section),
            onResync: (reason, turnId) => resyncs.push({ reason, turnId }),
            onError: (error) => errors.push(error)
        }
    });

    /** Sends one `display.ops` update on the turn subscription (always `sl-2`). */
    const sendOps = (sequence: number, ops: unknown[], turnId = 'turn-1') => {
        sockets[sockets.length - 1].emit({ type: 'update', subscription_id: 'sl-2', sequence, cursor: `d${sequence}`, kind: 'display.ops', at: sequence, ...(turnId === undefined ? {} : { turn_id: turnId }), ops });
    };

    /** Sends one `update` on the session subscription (always `sl-1`). */
    const sendSession = (frame: Record<string, unknown>) => {
        sockets[sockets.length - 1].emit(frame);
    };

    return { handle, sockets, clock, statuses, turns, texts, reasoning, usage, sessions, records, threads, sections, resyncs, errors, sendOps, sendSession };
}

const turnRow = (id: string, status: HarnessTurnFrame['status']): HarnessTurnFrame => ({ id, index: 1, status, threadId: 'thread-1', updatedAt: 2 });

describe('createStorylineStream', () => {
    beforeEach(() => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('dials the storyline root with the harness subprotocol and subscribes session-scoped on open', () => {
        const { handle, sockets, statuses, clock } = setup();

        // Construction opens the session scope, which always exists.
        expect(handle.status()).toBe('connecting');
        expect(sockets).toHaveLength(1);
        expect(sockets[0].url).toBe(SOCKET_URL);
        expect(sockets[0].protocol).toBe(HARNESS_WS_SUBPROTOCOL);
        // Nothing is sent before the socket is open.
        expect(sockets[0].sent).toEqual([]);

        handshake(sockets[0], [{ id: 'sl-1', scope: 'session', sequence: 10, cursor: 'c10' }]);

        expect(statuses).toEqual(['connecting', 'open']);
        expect(sockets[0].sent).toEqual([
            // No `hello` on a first dial: there is no epoch/cursor pair to resume from.
            { type: 'subscribe', subscription_id: 'sl-1', scope: 'session', session_id: SESSION_ID, pace: 'ordered' }
        ]);
        expect(handle.resumeState()).toEqual({ epoch: 'ep-1', cursor: 'c10' });
        // Liveness is armed at the shipped budget: 15s * 3 intervals.
        expect(clock.pending()).toEqual([HEARTBEAT_MS]);

        handle.close('leaving');
        expect(handle.status()).toBe('closed');
        expect(sockets[0].sent[1]).toEqual({ type: 'bye', reason: 'leaving' });
        expect(sockets[0].closeCalls).toEqual([{ code: 1000, reason: 'leaving' }]);
        // A closed observation arms nothing, and a late close event cannot resurrect it.
        expect(clock.pending()).toEqual([]);
        sockets[0].emitClose();
        expect(handle.status()).toBe('closed');
    });

    it('replays epoch and cursor with hello first, re-subscribes every scope, and reports a reconnect re-read', () => {
        const { handle, sockets, clock, statuses, resyncs, sendSession } = setup({ turnIds: ['turn-1'] });

        handshake(sockets[0], [
            { id: 'sl-1', scope: 'session', sequence: 10, cursor: 'c10' },
            { id: 'sl-2', scope: 'turn', sequence: 3, cursor: 'd3' }
        ]);
        expect(sockets[0].sent).toEqual([
            { type: 'subscribe', subscription_id: 'sl-1', scope: 'session', session_id: SESSION_ID, pace: 'ordered' },
            { type: 'subscribe', subscription_id: 'sl-2', scope: 'turn', session_id: SESSION_ID, turn_id: 'turn-1', pace: 'ordered' }
        ]);

        // One committed frame moves the cursor the reconnect will resume from.
        sendSession({ type: 'update', subscription_id: 'sl-1', sequence: 11, cursor: 'c11', kind: 'turn.upsert', at: 11, turn: turnRow('turn-1', 'running') });
        expect(handle.resumeState()).toEqual({ epoch: 'ep-1', cursor: 'c11' });

        sockets[0].emitClose();
        expect(handle.status()).toBe('reconnecting');
        // Heartbeat is disarmed while down; only the 500ms first backoff remains.
        expect(clock.pending()).toEqual([500]);

        clock.run(500);
        expect(sockets).toHaveLength(2);
        expect(statuses).toEqual(['connecting', 'open', 'reconnecting']);

        handshake(sockets[1], [
            { id: 'sl-1', scope: 'session', sequence: 12, cursor: 'c12' },
            { id: 'sl-2', scope: 'turn', sequence: 4, cursor: 'd4' }
        ]);
        expect(sockets[1].sent).toEqual([
            // `hello` is the only resume input and must be the FIRST frame.
            { type: 'hello', protocol: HARNESS_WS_SUBPROTOCOL, epoch: 'ep-1', cursor: 'c11' },
            // Each subscription resumes from ITS OWN cursor.
            { type: 'subscribe', subscription_id: 'sl-1', scope: 'session', session_id: SESSION_ID, pace: 'ordered', cursor: 'c11' },
            { type: 'subscribe', subscription_id: 'sl-2', scope: 'turn', session_id: SESSION_ID, turn_id: 'turn-1', pace: 'ordered', cursor: 'd3' }
        ]);
        // Deltas may have been produced while the socket was down, so the followed
        // turn is reported for one bounded re-read.
        expect(resyncs).toEqual([{ reason: 'reconnected', turnId: 'turn-1' }]);
        expect(statuses).toEqual(['connecting', 'open', 'reconnecting', 'open']);

        handle.close();
    });

    it('routes each session-scope kind to its own owner and ignores kinds and subscriptions it has none for', () => {
        const { handle, sockets, sendSession, turns, usage, sessions, records, texts } = setup();
        handshake(sockets[0], [{ id: 'sl-1', scope: 'session', sequence: 10, cursor: 'c10' }]);

        sendSession({ type: 'update', subscription_id: 'sl-1', sequence: 11, cursor: 'c11', kind: 'turn.upsert', at: 11, turn: turnRow('turn-1', 'done') });
        expect(turns).toEqual([turnRow('turn-1', 'done')]);

        sendSession({ type: 'update', subscription_id: 'sl-1', sequence: 12, cursor: 'c12', kind: 'usage.updated', at: 12, turn_id: 'turn-1', usage_patch: { input: 120, output: 480, total: 600 } });
        expect(usage).toEqual([{ patch: { input: 120, output: 480, total: 600 }, turnId: 'turn-1' }]);

        sendSession({ type: 'update', subscription_id: 'sl-1', sequence: 13, cursor: 'c13', kind: 'session.updated', at: 13, session: { status: 'running', activeTurnCount: 1 } });
        expect(sessions).toEqual([{ status: 'running', activeTurnCount: 1 }]);

        // `records.updated` carries watermarks only: the panels page the REST snapshot.
        sendSession({ type: 'update', subscription_id: 'sl-1', sequence: 14, cursor: 'c14', kind: 'records.updated', at: 14, store_rev: 7, collections_rev: 3 });
        expect(records).toEqual([{ storeRev: 7, collectionsRev: 3 }]);

        // THE CHAINED PROSE CUE, and the one kind this client deliberately ignores. A run
        // started with `harness.sendThreadInput` mints no session turn — no `turn.upsert`, no
        // `display.ops` (src/server/orchestrator.ts:62-65) — so the panels hang the conversation
        // read off `records.updated` plus the roster row's `message_count`
        // (src/dashboard/plugins/agents.ts). `transcript.updated` is NOT that cue: the store
        // publishes it from ONE place, `updateThreadTranscript` (harness
        // src/server/sessions.ts:9158), which is the REST transcript-PUT route an editor uses,
        // and a thread run appending its own answer never calls it. A hook here was therefore
        // wired to a signal that never arrives for a chain — it is gone rather than left as an
        // option nothing could pass. The frame is still data to tolerate: no callback, no throw,
        // and the cursor still advances so a later resume does not replay it.
        const transcriptFrame = { type: 'update', subscription_id: 'sl-1', sequence: 15, cursor: 'c15', kind: 'transcript.updated', at: 15, turn_id: 'turn-1' };
        sendSession(transcriptFrame);
        expect(turns).toHaveLength(1);
        expect(records).toHaveLength(1);

        // A kind with no pane and a frame for a subscription that was never opened
        // are data to tolerate: no callback, no throw, cursor still advances.
        sendSession({ type: 'update', subscription_id: 'sl-1', sequence: 16, cursor: 'c16', kind: 'thing.updated', at: 16, whatever: true });
        sendSession({ type: 'update', subscription_id: 'sl-9', sequence: 99, cursor: 'c99', kind: 'turn.upsert', at: 99, turn: turnRow('turn-x', 'running') });
        expect(turns).toHaveLength(1);
        expect(records).toHaveLength(1);
        expect(texts).toEqual([]);
        expect(handle.resumeState()).toEqual({ epoch: 'ep-1', cursor: 'c16' });

        handle.close();
    });

    it('projects a roster row from thread.upsert, and reads watermarks nested under records', () => {
        const { handle, sockets, threads, records, sendSession } = setup();

        handshake(sockets[0], [{ id: 'sl-1', scope: 'session', sequence: 10, cursor: 'c10' }]);

        // The wire row is snake_case (`ThreadSummary`, harness-api.ts:1670; minted at
        // harness src/server/api.ts:1394); the dashboard consumes ONE camelCase shape
        // for both the REST list and this frame, which is what `threadFrameFromRow` is.
        sendSession({
            type: 'update',
            subscription_id: 'sl-1',
            sequence: 11,
            cursor: 'c11',
            kind: 'thread.upsert',
            at: 11,
            thread: { id: 'thread-1', agent: 'writer', origin: 'host', status: 'running', sequence: 4, label: 'storyline:writer', transcript_state: 'ok', message_count: 4, has_transcript: true }
        });
        // A DELEGATED child is the same row kind with one extra field, and the field is the
        // whole difference: `owner_thread_id` says this conversation belongs to another
        // agent's turn, and a projection that dropped it would let the composer, the roster
        // and the chain disagree about which conversation an agent is answering on. That
        // frame lands at the end of this test, after the watermarks, so the sequence numbers
        // below keep counting up.
        expect(threads[0]).toEqual({
            id: 'thread-1',
            agent: 'writer',
            origin: 'host',
            status: 'running',
            sequence: 4,
            ownerThreadId: '',
            label: 'storyline:writer',
            messageCount: 4,
            transcriptState: 'ok'
        });

        // The `records.updated` signal nests its watermarks under `records`
        // (`WsUpdateRecords`, harness-stream.ts:108). The pane pages the REST snapshot, so
        // this event carries the revisions and nothing else — a flat frame is read too.
        sendSession({ type: 'update', subscription_id: 'sl-1', sequence: 12, cursor: 'c12', kind: 'records.updated', at: 12, records: { store_rev: 8, collections_rev: 2 } });
        expect(records).toEqual([{ storeRev: 8, collectionsRev: 2 }]);
        sendSession({ type: 'update', subscription_id: 'sl-1', sequence: 13, cursor: 'c13', kind: 'records.updated', at: 13, store_rev: 9, collections_rev: 2 });
        expect(records[1]).toEqual({ storeRev: 9, collectionsRev: 2 });

        // A row with no id names no conversation: no callback, and the cursor still moves.
        sendSession({ type: 'update', subscription_id: 'sl-1', sequence: 14, cursor: 'c14', kind: 'thread.upsert', at: 14, thread: { agent: 'reader', status: 'running' } });
        expect(threads).toHaveLength(1);

        // THE OWNER LINK, from the same frame kind. `GET /threads` answers a conversation the
        // `delegate` tool opened with `owner_thread_id` set, and so does this frame — dropping
        // it in the projection is what let a delegated child steal the composer.
        sendSession({
            type: 'update',
            subscription_id: 'sl-1',
            sequence: 15,
            cursor: 'c15',
            kind: 'thread.upsert',
            at: 15,
            thread: { id: 'thread-9', agent: 'writer', origin: 'host', status: 'idle', sequence: 5, owner_thread_id: 'thread-1', message_count: 1 }
        });
        expect(threads[1]).toEqual({
            id: 'thread-9',
            agent: 'writer',
            origin: 'host',
            status: 'idle',
            sequence: 5,
            ownerThreadId: 'thread-1',
            label: '',
            messageCount: 1,
            transcriptState: ''
        });
        expect(handle.resumeState()).toEqual({ epoch: 'ep-1', cursor: 'c15' });

        handle.close();
    });

    it('publishes a section identity and state so the flow can be attributed to an agent', () => {
        const { handle, sockets, sections, sendOps } = setup({ turnIds: ['turn-1'] });

        handshake(sockets[0], [{ id: 'sl-1', scope: 'session', sequence: 10, cursor: 'c10' }, { id: 'sl-2', scope: 'turn', sequence: 3, cursor: 'd3' }]);

        sendOps(4, [
            { op: 'section:open', section: { id: 'sec-a', role: 'primary', agent: 'writer', state: 'streaming', threadId: 'thread-1', startedAt: 100 } },
            // A patch names only the fields it changes (`TurnSectionPatch`,
            // turn-display.ts:1043), so identity survives the state move — that move is
            // the phase the agents panel shows.
            { op: 'section:set', sectionId: 'sec-a', patch: { state: 'done', endedAt: 180 } },
            // A patch for a section whose `section:open` was the dropped frame is dropped
            // with it: inventing a role-less section here could hijack the answer selection.
            { op: 'section:set', sectionId: 'sec-unseen', patch: { state: 'done' } }
        ]);
        expect(sections).toEqual([
            { turnId: 'turn-1', sectionId: 'sec-a', agent: 'writer', role: 'primary', state: 'streaming', threadId: 'thread-1', startedAt: 100, endedAt: null },
            { turnId: 'turn-1', sectionId: 'sec-a', agent: 'writer', role: 'primary', state: 'done', threadId: 'thread-1', startedAt: 100, endedAt: 180 }
        ]);

        handle.close();
    });

    it('folds display ops into the primary answer, keeps reasoning in its own buffer, and excludes subagent sections', () => {
        const { handle, sockets, texts, reasoning, sendOps } = setup({ turnIds: ['turn-1'] });
        handshake(sockets[0], [{ id: 'sl-1', scope: 'session', sequence: 10, cursor: 'c10' }, { id: 'sl-2', scope: 'turn', sequence: 3, cursor: 'd3' }]);

        sendOps(4, [
            { op: 'section:open', section: { id: 'sec-a', role: 'primary' } },
            { op: 'node:insert', sectionId: 'sec-a', node: { id: 'n-1', kind: 'text', text: 'Once' } }
        ]);
        // A node can arrive WITH text (a replayed/committed node) and that text is
        // already the answer.
        expect(texts).toEqual([{ text: 'Once', turnId: 'turn-1' }]);

        sendOps(5, [{ op: 'node:append', nodeId: 'n-1', delta: ' upon' }]);
        expect(texts[1]).toEqual({ text: 'Once upon', turnId: 'turn-1' });

        sendOps(6, [
            { op: 'node:insert', sectionId: 'sec-a', node: { id: 'n-2', kind: 'reasoning' } },
            { op: 'node:append', nodeId: 'n-2', delta: 'Consider the ending' }
        ]);
        // Reasoning deltas never touch the answer buffer.
        expect(reasoning).toEqual([{ text: 'Consider the ending', turnId: 'turn-1' }]);
        expect(texts).toHaveLength(2);

        sendOps(7, [
            { op: 'section:open', section: { id: 'sec-b', role: 'subagent' } },
            { op: 'node:insert', sectionId: 'sec-b', node: { id: 'n-3', kind: 'text', text: 'a subagent aside' } },
            // Unknown ops are display detail this surface does not fold.
            { op: 'section:set', sectionId: 'sec-a', section: { title: 'renamed' } }
        ]);
        expect(texts).toHaveLength(2);
        // `textOf` is what a surface mounted mid-stream paints, with or without a key.
        expect(handle.textOf('turn-1')).toBe('Once upon');
        expect(handle.textOf()).toBe('Once upon');
        // An unknown key falls back to the single folded turn — one observation never
        // shows another turn's answer as an empty pane.
        expect(handle.textOf('turn-unknown')).toBe('Once upon');

        handle.close();
    });

    it('streams the answer of a host-thread turn whose root section is a subagent (reader/editor)', () => {
        const { handle, sockets, texts, reasoning, sendOps } = setup({ turnIds: ['turn-1'] });
        handshake(sockets[0], [{ id: 'sl-1', scope: 'session', sequence: 10, cursor: 'c10' }, { id: 'sl-2', scope: 'turn', sequence: 3, cursor: 'd3' }]);

        // `section:open` carries the WHOLE `TurnSection` copy with `nodes: []`
        // (harness src/server/turn-projector.ts:817), and the projector marks a root
        // section `primary` only when its agent IS the session primary (:723). A host
        // thread addressed at `reader` therefore opens a `subagent`-role root section,
        // and its prose is still the answer this UI has to paint.
        sendOps(4, [
            {
                op: 'section:open',
                section: { id: 'sec-r', role: 'subagent', agent: 'reader', agentLabel: 'reader', state: 'streaming', nodes: [], context: [] }
            },
            { op: 'node:insert', sectionId: 'sec-r', node: { id: 'n-1', kind: 'reasoning' } },
            { op: 'node:append', sectionId: 'sec-r', nodeId: 'n-1', delta: ' Skimming for the turn.' }
        ]);
        // A turn that has said no prose yet paints no prose — the placeholder stays,
        // but the reasoning window is still folded into its own buffer.
        expect(texts).toEqual([]);
        expect(reasoning).toEqual([{ text: ' Skimming for the turn.', turnId: 'turn-1' }]);

        sendOps(5, [{ op: 'node:insert', sectionId: 'sec-r', node: { id: 'n-2', kind: 'text', text: 'The harbour is empty.' } }]);
        expect(texts).toEqual([{ text: 'The harbour is empty.', turnId: 'turn-1' }]);

        sendOps(6, [{ op: 'node:append', sectionId: 'sec-r', nodeId: 'n-2', delta: ' Only gulls.' }]);
        expect(texts[1]).toEqual({ text: 'The harbour is empty. Only gulls.', turnId: 'turn-1' });
        expect(handle.textOf('turn-1')).toBe('The harbour is empty. Only gulls.');

        handle.close();
    });

    it('keeps a delegated child\'s prose out of a subagent root\'s answer', () => {
        const { handle, sockets, texts, sendOps } = setup({ turnIds: ['turn-1'] });
        handshake(sockets[0], [{ id: 'sl-1', scope: 'session', sequence: 10, cursor: 'c10' }, { id: 'sl-2', scope: 'turn', sequence: 3, cursor: 'd3' }]);

        sendOps(4, [
            { op: 'section:open', section: { id: 'sec-r', role: 'subagent', agent: 'reader', agentLabel: 'reader' } },
            { op: 'node:insert', sectionId: 'sec-r', node: { id: 'n-1', kind: 'text', text: 'The reader reports: chapter two is tight.' } },
            // The reader delegated: a NESTED section (the projector resolves the
            // parent, `TurnSection.parentSectionId`), whose prose is a report.
            { op: 'section:open', section: { id: 'sec-e', role: 'subagent', agent: 'editor', agentLabel: 'editor', parentSectionId: 'sec-r' } },
            { op: 'node:insert', sectionId: 'sec-e', node: { id: 'n-2', kind: 'text', text: 'A suggested cut.' } }
        ]);

        // Exactly one emission, and it is the answering root section's text — the
        // child's insert neither appends to it nor replaces it.
        expect(texts).toEqual([{ text: 'The reader reports: chapter two is tight.', turnId: 'turn-1' }]);
        expect(handle.textOf('turn-1')).toBe('The reader reports: chapter two is tight.');

        handle.close();
    });

    it('drops exactly the nodes an attempt names, so the next append recomputes a clean answer', () => {
        const { handle, sockets, texts, sendOps } = setup({ turnIds: ['turn-1'] });
        handshake(sockets[0], [{ id: 'sl-1', scope: 'session', sequence: 10, cursor: 'c10' }, { id: 'sl-2', scope: 'turn', sequence: 3, cursor: 'd3' }]);

        sendOps(4, [
            { op: 'section:open', section: { id: 'sec-a', role: 'primary' } },
            { op: 'node:insert', sectionId: 'sec-a', node: { id: 'n-1', kind: 'text', text: 'Once' } }
        ]);
        sendOps(5, [{ op: 'node:insert', sectionId: 'sec-a', node: { id: 'n-5', kind: 'text', text: ' [discarded attempt]' } }]);
        expect(texts.map((entry) => entry.text)).toEqual(['Once', 'Once [discarded attempt]']);

        // A retry names the EXACT nodes to drop; the fold never tracks a window.
        sendOps(6, [{ op: 'attempt:discard', nodeIds: ['n-5'] }]);
        sendOps(7, [{ op: 'node:append', nodeId: 'n-1', delta: ' upon a time.' }]);
        expect(texts[2]).toEqual({ text: 'Once upon a time.', turnId: 'turn-1' });
        expect(handle.textOf('turn-1')).toBe('Once upon a time.');

        // A delta whose `node:insert` was lost still folds into a provisional node,
        // because the owner replaces the fold with canonical text on its re-read.
        sendOps(8, [{ op: 'node:append', nodeId: 'n-9', delta: ' A late node.' }]);
        expect(texts[3]).toEqual({ text: 'Once upon a time. A late node.', turnId: 'turn-1' });

        handle.close();
    });

    it('counts a sequence gap as dropped frames: unsubscribe, re-subscribe from the last applied cursor, report', () => {
        const { handle, sockets, sendSession, turns, resyncs } = setup();
        handshake(sockets[0], [{ id: 'sl-1', scope: 'session', sequence: 10, cursor: 'c10' }]);
        const sent = () => sockets[0].sent as unknown[];

        sendSession({ type: 'update', subscription_id: 'sl-1', sequence: 11, cursor: 'c11', kind: 'turn.upsert', at: 11, turn: turnRow('turn-1', 'running') });
        // 12 and 13 never arrived: the client counts, and the server's silence is a lie.
        sendSession({ type: 'update', subscription_id: 'sl-1', sequence: 14, cursor: 'c14', kind: 'turn.upsert', at: 14, turn: turnRow('turn-2', 'done') });

        expect(sent().slice(1)).toEqual([
            { type: 'unsubscribe', subscription_id: 'sl-1' },
            // The re-subscribe resumes from the last APPLIED cursor (c11), not from
            // the frame that revealed the gap.
            { type: 'subscribe', subscription_id: 'sl-1', scope: 'session', session_id: SESSION_ID, pace: 'ordered', cursor: 'c11' }
        ]);
        // Reported, never guessed: the owner re-reads the turns page over REST.
        expect(resyncs).toEqual([{ reason: 'frames_dropped', turnId: undefined }]);
        // The frame that revealed the gap is still applied, then the baseline restarts.
        expect(turns).toEqual([turnRow('turn-1', 'running'), turnRow('turn-2', 'done')]);
        expect(handle.resumeState()).toEqual({ epoch: 'ep-1', cursor: 'c14' });

        // A fresh baseline after the re-subscribe must not gap against the old sequence space.
        sendSession({ type: 'subscription_state', subscription_id: 'sl-1', scope: 'session', epoch: 'ep-1', sequence: 20, cursor: 'c20' });
        sendSession({ type: 'update', subscription_id: 'sl-1', sequence: 21, cursor: 'c21', kind: 'turn.upsert', at: 21, turn: turnRow('turn-3', 'done') });
        expect(resyncs).toHaveLength(1);
        expect(turns).toHaveLength(3);

        handle.close();
    });

    it('reports a server resync_required and a protocol error without tearing the socket down', () => {
        const { handle, sockets, sendSession, resyncs, errors } = setup({ turnIds: ['turn-1'] });
        handshake(sockets[0], [{ id: 'sl-1', scope: 'session', sequence: 10, cursor: 'c10' }, { id: 'sl-2', scope: 'turn', sequence: 3, cursor: 'd3' }]);
        const sentBefore = sockets[0].sent.length;

        sendSession({ type: 'resync_required', subscription_id: 'sl-2', reason: 'cursor_expired', epoch: 'ep-2', cursor: 'c50' });
        expect(resyncs).toEqual([{ reason: 'cursor_expired', turnId: 'turn-1' }]);
        // The new epoch/cursor become the resume token immediately.
        expect(handle.resumeState()).toEqual({ epoch: 'ep-2', cursor: 'c50' });

        const protocolError: WsProtocolError = { type: 'error', code: 'invalid_payload', message: 'turn_id is required', subscription_id: 'sl-2', retryable: false };
        sendSession(protocolError);
        expect(errors).toEqual([protocolError]);
        // Neither frame closes anything: recovery is the owner's bounded re-read.
        expect(sockets[0].sent).toHaveLength(sentBefore);
        expect(sockets[0].closeCalls).toEqual([]);
        expect(handle.status()).toBe('open');

        // `requestResync` is the same report on demand (the composer uses it after a stop).
        handle.requestResync();
        expect(resyncs[1]).toEqual({ reason: 'frames_dropped', turnId: 'turn-1' });

        handle.close();
    });

    it('adopts the heartbeat budget carried by welcome and closes a stalled socket with 4408', () => {
        const { handle, sockets, clock } = setup();

        sockets[0].emitOpen();
        expect(clock.pending()).toEqual([HEARTBEAT_MS]);
        sockets[0].emit({ type: 'welcome', protocol: HARNESS_WS_SUBPROTOCOL, epoch: 'ep-9', at: 1, limits: { heartbeat_interval_ms: 100, heartbeat_timeout_intervals: 2, heartbeat_timeout_close_code: 4400 } });
        // The numbers IN FORCE on this connection win, and the deadline is re-armed.
        expect(clock.pending()).toEqual([200]);

        // Every inbound frame is liveness: the deadline moves but never disappears.
        sockets[0].emit({ type: 'heartbeat', at: 2 });
        expect(clock.pending()).toEqual([200]);

        clock.run(200);
        // Three silent intervals close THIS side with the negotiated code; the RUN is untouched.
        expect(sockets[0].closeCalls).toEqual([{ code: 4400, reason: 'heartbeat timeout' }]);

        sockets[0].emitClose();
        expect(handle.status()).toBe('reconnecting');
        expect(clock.pending()).toEqual([500]);
        handle.close();
    });

    it('gives up and reports closed after maxReconnectAttempts instead of redialling forever', () => {
        const { handle, sockets, clock, statuses } = setup({ maxReconnectAttempts: 1 });

        handshake(sockets[0], [{ id: 'sl-1', scope: 'session', sequence: 10, cursor: 'c10' }]);
        sockets[0].emitClose();
        expect(clock.pending()).toEqual([500]);

        clock.run(500);
        expect(sockets).toHaveLength(2);
        sockets[1].emitOpen();
        expect(handle.status()).toBe('open');

        // Second failure: the attempt budget is spent, so this is terminal — no timer,
        // no third socket, and `closed` (not `reconnecting`) is the last word.
        sockets[1].emitClose();
        expect(statuses).toEqual(['connecting', 'open', 'reconnecting', 'open', 'reconnecting', 'closed']);
        expect(clock.pending()).toEqual([]);
        expect(sockets).toHaveLength(2);

        handle.close();
    });

    it('treats only done, error, and cancelled as terminal turn states', () => {
        expect(isTerminalTurnStatus('queued')).toBe(false);
        expect(isTerminalTurnStatus('running')).toBe(false);
        expect(isTerminalTurnStatus('done')).toBe(true);
        expect(isTerminalTurnStatus('error')).toBe(true);
        expect(isTerminalTurnStatus('cancelled')).toBe(true);
        // A display state is not a turn status: the fold streams it, the run did not end.
        expect(isTerminalTurnStatus('streaming')).toBe(false);
    });
});
