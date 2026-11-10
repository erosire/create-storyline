// The agents plugin: three equal targets, and the published fact each one's phase comes
// from.
//
// Two halves, deliberately:
//
//   THE DERIVATION (pure functions). `phase` is the part a UI can get wrong, so every
//   branch of its precedence is pinned here: the agent's own display section (`open` /
//   `streaming` / `error` / `cancelled`, harness src/shared/turn-display.ts:195) beats a
//   working turn, which beats the last section's failure — which must NOT vanish behind a
//   thread that has gone back to idle — which beats the thread's own status, which beats
//   "no thread yet". Nothing else is allowed to produce a phase word, because the
//   alternative is a stage machine the server cannot back up.
//
//   THE WIRING (through the real composition). The roster only exists if the plugin reads
//   it: `GET .../threads` on activation (a page opening on a story already underway would
//   otherwise show three agents doing nothing), once per Title, again after a resync;
//   `thread.upsert` frames for the live half; and the per-Title reset that stops the
//   previous story's agents from being shown under the new Title's name.
//
// The row shape is asserted whole with `toEqual`, so a phase that stops being derived from
// a published fact fails instead of quietly degrading.
import { describe, expect, it } from 'vitest';
import type { StorylineThreadMessage, StorylineThreadRef } from '../../api';
import type { HarnessSectionFrame, HarnessTurnFrame } from '../../api/stream';
import {
    AGENTS_ACTIVITY_EVENT,
    AGENTS_ROSTER_SERVICE,
    AGENTS_SELECT_COMMAND,
    AGENTS_SELECT_EVENT,
    AGENTS_STATE,
    TITLES_SELECT_COMMAND,
    TURNS_AGENT_STATE,
    TURNS_COMPOSER_STATE,
    type AgentsActivityEvent,
    type AgentRow,
    type AgentsState,
    type AgentsSelectEvent,
    type ComposerDraft,
    type RosterService,
    type StorylineAgent
} from '../contract';
import { agentRowsFor, rosterByAgent, type AgentFacts } from './agents';
import { buildStoryline, THREADS, threadMessagesFor } from '../testing/doubles';

/** A host thread for one agent, with the two fields the ranking rules read. */
const thread = (agent: string, overrides: Partial<StorylineThreadRef> = {}): StorylineThreadRef => ({
    id: `thread-${agent}-${overrides.sequence ?? 1}`,
    agent,
    origin: 'host',
    status: 'idle',
    sequence: 1,
    ownerThreadId: '',
    label: `storyline:${agent}`,
    messageCount: 0,
    transcriptState: 'ok',
    ...overrides
});

/** One display section — the only thing that may label an agent mid-sentence. */
const section = (sectionId: string, agent: string, state: string, threadId = 'thread-writer'): HarnessSectionFrame => ({
    turnId: 'turn-1',
    sectionId,
    agent,
    role: 'primary',
    state,
    threadId,
    startedAt: 1,
    endedAt: null
});

/** One turn row, with the two attribution signals the wire carries. */
const turn = (id: string, status: HarnessTurnFrame['status'], overrides: Partial<HarnessTurnFrame> = {}): HarnessTurnFrame => ({
    id,
    index: 1,
    status,
    updatedAt: 5,
    ...overrides
});

/** Facts spelled out per test: threads come from the roster rule, the rest are frames. */
const factsFor = (
    threads: readonly StorylineThreadRef[],
    sections: readonly HarnessSectionFrame[] = [],
    turns: readonly HarnessTurnFrame[] = [],
    activity: Partial<Record<StorylineAgent, StorylineThreadMessage>> = {},
): AgentFacts => ({
    threads: rosterByAgent(threads),
    sections: Object.fromEntries(sections.map((frame) => [frame.sectionId, frame])),
    turns: Object.fromEntries(turns.map((frame) => [frame.id, frame])),
    activity
});

/** One row, asserted whole — the three fields this file is about stay visible in the diff. */
const rowFor = (agent: StorylineAgent, overrides: Partial<AgentRow>): AgentRow => ({
    agent,
    label: '',
    threadId: '',
    threadStatus: 'missing',
    workingTurnId: '',
    phase: 'no thread yet',
    sectionIds: [],
    messageCount: 0,
    lastActivity: '',
    lastAuthor: '',
    ...overrides
});

/** One transcript entry — the newest sentence of one agent's conversation. */
const entry = (position: number, role: StorylineThreadMessage['role'], text: string): StorylineThreadMessage => ({
    position,
    messageId: `m-${position}`,
    role,
    text
});

describe('agent roster derivation', () => {
    it('gives each agent one thread, taking the host conversation over a spawned one', () => {
        const hostOld = thread('writer', { id: 'host-old', sequence: 3 });
        const hostNew = thread('writer', { id: 'host-new', sequence: 7 });
        const spawned = thread('writer', { id: 'spawned', origin: 'agent', sequence: 99 });
        const readerSpawned = thread('reader', { id: 'reader-spawned', origin: 'agent', sequence: 2 });
        const outsider = thread('critic', { id: 'critic-thread', sequence: 50 });

        // `origin` outranks `sequence`: a subagent conversation with a huge sequence is
        // still not this UI's composer surface, and a row for an agent this product does
        // not have is dropped rather than shown.
        expect(rosterByAgent([hostOld, spawned, hostNew, readerSpawned, outsider])).toEqual({ writer: hostNew, reader: readerSpawned });
    });

    it('skips a delegated conversation even when it outranks the agent\'s own', () => {
        // The delegation child IS a host thread and it is the newest row the roster answers
        // with (src/api/storyline.test.ts pins the wire row) — so without the owner check the
        // card, the composer and the conversation read all land on somebody else's turn.
        const own = thread('writer', { id: 'own', sequence: 4, messageCount: 8 });
        const child = thread('writer', { id: 'delegated', sequence: 9, ownerThreadId: 'own', status: 'running', messageCount: 2 });

        expect(rosterByAgent([child, own])).toEqual({ writer: own });

        // An agent whose only conversation is a delegation has nothing this UI addresses — the
        // honest answer is no entry, which the row renders as "no thread yet".
        expect(rosterByAgent([child])).toEqual({});
    });

    it('shows the last sentence of an agent\'s conversation, and who wrote it', () => {
        const rows = agentRowsFor(factsFor(THREADS, [], [], { writer: entry(8, 'agent', 'Chapter five now opens at the harbour.'), reader: entry(1, 'user', 'Review what changed.') }));

        expect(rows.map((row) => ({ agent: row.agent, lastActivity: row.lastActivity, lastAuthor: row.lastAuthor }))).toEqual([
            { agent: 'writer', lastActivity: 'Chapter five now opens at the harbour.', lastAuthor: 'agent' },
            { agent: 'reader', lastActivity: 'Review what changed.', lastAuthor: 'user' },
            { agent: 'editor', lastActivity: '', lastAuthor: '' }
        ]);

        // The card holds a preview, not the prose: the transcript is where the whole thing is
        // read, so one collapsed line is the bound and the ellipsis is part of the contract.
        const long = agentRowsFor(factsFor(THREADS, [], [], { writer: entry(1, 'user', `${'x'.repeat(200)}\nmore`) }));

        expect(long[0]?.lastActivity).toEqual(`${'x'.repeat(139)}…`);
        expect(long[0]?.lastAuthor).toBe('user');
    });

    it('shows all three targets even when the story has used none of them', () => {
        expect(agentRowsFor(factsFor([]))).toEqual([rowFor('writer', {}), rowFor('reader', {}), rowFor('editor', {})]);
    });

    it('labels an agent by the section it is still writing, above every other signal', () => {
        const rows = agentRowsFor(factsFor(THREADS, [section('s-1', 'writer', 'streaming'), section('s-2', 'editor', 'open')]));

        expect(rows).toEqual([
            rowFor('writer', { label: 'storyline:writer', threadId: 'thread-writer', threadStatus: 'running', phase: 'writing', sectionIds: ['s-1'], messageCount: 9 }),
            rowFor('reader', { label: 'storyline:reader', threadId: 'thread-reader', threadStatus: 'idle', phase: 'idle', messageCount: 2 }),
            rowFor('editor', { label: 'storyline:editor', threadId: 'thread-editor', threadStatus: 'idle', phase: 'planning', sectionIds: ['s-2'], messageCount: 0 })
        ]);
    });

    it('says an agent is working from a turn alone, by its thread or by the published roster', () => {
        const byThread = agentRowsFor(factsFor(THREADS, [], [turn('turn-1', 'running', { threadId: 'thread-reader' })]));

        expect(byThread.map((row) => ({ agent: row.agent, workingTurnId: row.workingTurnId, phase: row.phase }))).toEqual([
            { agent: 'writer', workingTurnId: '', phase: 'running' },
            { agent: 'reader', workingTurnId: 'turn-1', phase: 'writing' },
            { agent: 'editor', workingTurnId: '', phase: 'idle' }
        ]);

        // A threadless flow naming exactly one of the three still resolves; a finished turn
        // is no longer work, and `queued` is.
        const byRoster = agentRowsFor(factsFor([], [], [turn('turn-2', 'queued', { activeAgents: ['editor'] }), turn('turn-3', 'done', { activeAgents: ['writer'] })]));

        expect(byRoster.map((row) => ({ agent: row.agent, workingTurnId: row.workingTurnId, phase: row.phase }))).toEqual([
            { agent: 'writer', workingTurnId: '', phase: 'no thread yet' },
            { agent: 'reader', workingTurnId: '', phase: 'no thread yet' },
            { agent: 'editor', workingTurnId: 'turn-2', phase: 'writing' }
        ]);

        // A turn naming two of the three agents is a team turn: BOTH are busy with it, which
        // is what a roster answers. The transcript asks a different question — WHICH flow
        // answered — so it leaves the same turn unattributed (plugins/turns.ts).
        const team = agentRowsFor(factsFor([], [], [turn('turn-4', 'running', { activeAgents: ['writer', 'reader'] })]));

        expect(team.map((row) => ({ agent: row.agent, workingTurnId: row.workingTurnId, phase: row.phase }))).toEqual([
            { agent: 'writer', workingTurnId: 'turn-4', phase: 'writing' },
            { agent: 'reader', workingTurnId: 'turn-4', phase: 'writing' },
            { agent: 'editor', workingTurnId: '', phase: 'no thread yet' }
        ]);
    });

    it('keeps a failed or stopped section visible above a thread that is idle again', () => {
        const failed = agentRowsFor(factsFor(THREADS, [section('s-1', 'writer', 'error')]));
        const stopped = agentRowsFor(factsFor(THREADS, [section('s-9', 'reader', 'cancelled')]));

        expect(failed.map((row) => row.phase)).toEqual(['failed', 'idle', 'idle']);
        expect(stopped.map((row) => row.phase)).toEqual(['running', 'stopped', 'idle']);

        // A section that finished cleanly is history, not the current phase: the thread's
        // own status is the live fact then, and `sectionIds` still names what was written.
        const finished = agentRowsFor(factsFor(THREADS, [section('s-1', 'writer', 'done')]));

        expect(finished.map((row) => ({ phase: row.phase, sectionIds: row.sectionIds }))).toEqual([
            { phase: 'running', sectionIds: ['s-1'] },
            { phase: 'idle', sectionIds: [] },
            { phase: 'idle', sectionIds: [] }
        ]);
    });
});

describe('agents plugin wiring', () => {
    it('reads the roster once for the Title boot picked, and publishes it for the composer', async () => {
        const { instance, calls, flush } = buildStoryline();

        await flush();

        const state = instance.state<AgentsState>(AGENTS_STATE).get();

        expect(state).toEqual({
            phase: 'ready',
            error: '',
            rows: [
                rowFor('writer', { label: 'storyline:writer', threadId: 'thread-writer', threadStatus: 'running', phase: 'running', messageCount: 9 }),
                rowFor('reader', { label: 'storyline:reader', threadId: 'thread-reader', threadStatus: 'idle', phase: 'idle', messageCount: 2 }),
                rowFor('editor', { label: 'storyline:editor', threadId: 'thread-editor', threadStatus: 'idle', phase: 'idle', messageCount: 0 })
            ]
        });

        // One backfill read per Title — the live half arrives as frames, not as a poll.
        expect(calls.filter((call) => call.startsWith('listThreads:'))).toEqual(['listThreads:ses-new']);
        // The same rows the panel shows, as the service the turns plugin labels turns with.
        expect(instance.service<RosterService>(AGENTS_ROSTER_SERVICE)()).toEqual({ writer: THREADS[0], reader: THREADS[1], editor: THREADS[2] });

        instance.dispose();
    });

    it('clears the previous Title agents before its roster lands, and reads exactly once more', async () => {
        // The same resolver holder the records suite uses: element access keeps the
        // declared type even though the resolver is captured inside the promise executor.
        const releases: Record<string, (value: StorylineThreadRef[]) => void> = {};

        const { instance, calls, flush } = buildStoryline({
            api: {
                listThreads: (sessionId) =>
                    sessionId === 'ses-old'
                        ? new Promise<StorylineThreadRef[]>((resolve) => {
                              releases['ses-old'] = resolve;
                          })
                        : Promise.resolve(THREADS)
            }
        });

        await flush();

        await instance.execute<string, Promise<string>>(TITLES_SELECT_COMMAND, 'ses-old');
        await flush();

        // The empty roster of the Title being opened, never the rows of the one being left.
        expect(instance.state<AgentsState>(AGENTS_STATE).get()).toEqual({
            phase: 'loading',
            error: '',
            rows: [rowFor('writer', {}), rowFor('reader', {}), rowFor('editor', {})]
        });

        releases['ses-old']?.([thread('editor', { id: 'thread-old-editor', agent: 'editor', status: 'running', sequence: 4, messageCount: 1 })]);
        await flush();

        expect(instance.state<AgentsState>(AGENTS_STATE).get()).toEqual({
            phase: 'ready',
            error: '',
            rows: [
                rowFor('writer', {}),
                rowFor('reader', {}),
                rowFor('editor', { label: 'storyline:editor', threadId: 'thread-old-editor', threadStatus: 'running', phase: 'running', messageCount: 1 })
            ]
        });
        expect(calls.filter((call) => call.startsWith('listThreads:'))).toEqual(['listThreads:ses-new', 'listThreads:ses-old']);

        instance.dispose();
    });

    it('drops a roster that answers for a Title the operator already left', async () => {
        // Every roster read is held open, so the switch and the reply can be ordered by
        // hand — the only way to pin which replies the plugin is allowed to paint.
        const pending: Record<string, (value: StorylineThreadRef[]) => void> = {};

        const { instance, calls, flush, stream } = buildStoryline({
            api: {
                listThreads: (sessionId) =>
                    new Promise<StorylineThreadRef[]>((resolve) => {
                        pending[sessionId] = resolve;
                    })
            }
        });

        await flush();

        // Boot's read for `ses-new` is still in flight, so the switch's own read coalesces
        // away rather than racing it.
        await instance.execute<string, Promise<string>>(TITLES_SELECT_COMMAND, 'ses-old');
        await flush();

        expect(instance.state<AgentsState>(AGENTS_STATE).get()).toEqual({ phase: 'loading', error: '', rows: [rowFor('writer', {}), rowFor('reader', {}), rowFor('editor', {})] });
        expect(calls.filter((call) => call.startsWith('listThreads:'))).toEqual(['listThreads:ses-new']);

        pending['ses-new']?.(THREADS);
        await flush();

        // The reply names a Title the operator is no longer on: dropped, not painted, so the
        // previous story's agents never appear under the new Title's name.
        expect(instance.state<AgentsState>(AGENTS_STATE).get()).toEqual({ phase: 'loading', error: '', rows: [rowFor('writer', {}), rowFor('reader', {}), rowFor('editor', {})] });

        // A resync is the documented recovery: the read is asked for again, for whichever
        // Title is active now.
        stream().onResync?.('frames_dropped', undefined);
        await flush();

        expect(calls.filter((call) => call.startsWith('listThreads:'))).toEqual(['listThreads:ses-new', 'listThreads:ses-old']);

        pending['ses-old']?.([]);
        await flush();

        expect(instance.state<AgentsState>(AGENTS_STATE).get()).toEqual({ phase: 'ready', error: '', rows: [rowFor('writer', {}), rowFor('reader', {}), rowFor('editor', {})] });

        instance.dispose();
    });

    it('takes a live thread frame over the REST row, but never a spawned or delegated one', async () => {
        const { instance, flush, stream } = buildStoryline();

        await flush();

        // `thread.upsert` carries the same row the REST roster does (one mapper,
        // src/api/stream.ts `threadFrameFromRow`), so the live view cannot disagree.
        stream().onThread?.({ ...THREADS[0], status: 'idle', sequence: 8, messageCount: 12 });
        await flush();

        expect(instance.state<AgentsState>(AGENTS_STATE).get().rows[0]).toMatchObject({
            threadStatus: 'idle',
            phase: 'idle',
            messageCount: 12
        });

        // An agent-spawned conversation with nothing new to say does not steal the row: the
        // composer addresses the host thread the frame would replace.
        stream().onThread?.(thread('writer', { id: 'spawned-late', origin: 'agent', sequence: 2, status: 'running' }));
        await flush();

        expect(instance.state<AgentsState>(AGENTS_STATE).get().rows[0]).toMatchObject({ threadId: 'thread-writer', messageCount: 12 });

        // A DELEGATION CHILD is the same trap with nothing left to distinguish it: the parent's
        // agent key, `origin: 'host'`, a newer sequence and a higher count — only the delegation
        // link says it is not the conversation the operator addresses. Taking it would move the
        // card, the follow target and the conversation read onto a thread nobody chose.
        stream().onThread?.(thread('writer', { id: 'child-late', ownerThreadId: 'thread-writer', sequence: 20, status: 'running', messageCount: 40 }));
        await flush();

        expect(instance.state<AgentsState>(AGENTS_STATE).get().rows[0]).toMatchObject({ threadId: 'thread-writer', threadStatus: 'idle', messageCount: 12 });

        instance.dispose();
    });

    it('re-reads the roster when the socket opens and when frames were dropped', async () => {
        const { instance, calls, flush, stream } = buildStoryline();

        await flush();

        stream().onStatus?.('open');
        await flush();
        stream().onResync?.('frames_dropped', undefined);
        await flush();

        // An open socket and a gap both mean frames this panel would have seen are gone; the
        // roster read is the only complete picture again.
        expect(calls.filter((call) => call.startsWith('listThreads:'))).toEqual(['listThreads:ses-new', 'listThreads:ses-new', 'listThreads:ses-new']);

        stream().onStatus?.('closed');
        await flush();

        // A close is not a re-read: nothing new arrived while the page was blind.
        expect(calls.filter((call) => call.startsWith('listThreads:'))).toHaveLength(3);

        instance.dispose();
    });

    it('states the roster read failed without erasing the panel', async () => {
        const { instance, flush } = buildStoryline({ api: { listThreads: async () => Promise.reject(new Error('roster unavailable')) } });

        await flush();

        const state = instance.state<AgentsState>(AGENTS_STATE).get();

        expect(state.phase).toBe('error');
        expect(state.error).toBe('roster unavailable');
        // The three targets are still on screen — with no thread, which is the truth.
        expect(state.rows).toEqual([rowFor('writer', {}), rowFor('reader', {}), rowFor('editor', {})]);

        instance.dispose();
    });

    it('labels a live section as it streams, and drops every section when the Title changes', async () => {
        const { instance, flush, stream } = buildStoryline();

        await flush();

        stream().onSection?.(section('s-1', 'writer', 'streaming'));
        await flush();

        expect(instance.state<AgentsState>(AGENTS_STATE).get().rows[0]).toMatchObject({ agent: 'writer', phase: 'writing', sectionIds: ['s-1'] });

        // A section that ended badly stays the phase: the failure is the fact an operator
        // needs, and the thread has already gone back to idle by the time the panel sees it.
        stream().onSection?.(section('s-1', 'writer', 'error'));
        await flush();

        expect(instance.state<AgentsState>(AGENTS_STATE).get().rows[0]).toMatchObject({ phase: 'failed', sectionIds: ['s-1'] });

        // A new Title is a new set of conversations: none of the old story's sections may
        // label the new one, so the thread's own status is what shows again.
        await instance.execute<string, Promise<string>>(TITLES_SELECT_COMMAND, 'ses-old');
        await flush();

        expect(instance.state<AgentsState>(AGENTS_STATE).get().rows[0]).toMatchObject({ phase: 'running', sectionIds: [] });

        instance.dispose();
    });

    it('makes the agent an operator follows the composer target', async () => {
        const { instance, flush } = buildStoryline();

        await flush();

        const events: AgentsSelectEvent[] = [];

        instance.on<AgentsSelectEvent>(AGENTS_SELECT_EVENT, (event) => events.push(event));

        expect(await instance.execute<StorylineAgent, Promise<AgentsSelectEvent>>(AGENTS_SELECT_COMMAND, 'reader')).toEqual({
            agent: 'reader',
            threadId: 'thread-reader'
        });
        expect(events).toEqual([{ agent: 'reader', threadId: 'thread-reader' }]);

        // Reading a thread and writing into it is one gesture: the turns plugin moves the
        // composer to the agent this panel pointed at.
        expect(instance.state<StorylineAgent>(TURNS_AGENT_STATE).get()).toBe('reader');
        expect(instance.state<ComposerDraft>(TURNS_COMPOSER_STATE).get()).toEqual({ agent: 'reader', text: '' });

        instance.dispose();
    });

    it('reads each conversation when the Title opens and shows its last sentence without announcing it', async () => {
        const { instance, calls, flush } = buildStoryline({
            api: {
                readThreadMessages: async (sessionId, threadId) =>
                    threadMessagesFor(sessionId, threadId, [entry(0, 'user', 'Review what changed.'), entry(1, 'agent', 'Chapter four holds.')])
            }
        });

        const events: AgentsActivityEvent[] = [];

        instance.on<AgentsActivityEvent>(AGENTS_ACTIVITY_EVENT, (event) => events.push(event));
        await flush();

        // The card can now answer "what is this agent holding?" for a page that opened
        // mid-story — the newest entry of each conversation, from the conversation.
        const rows = instance.state<AgentsState>(AGENTS_STATE).get().rows;

        expect(rows.map((row) => row.lastActivity)).toEqual(['Chapter four holds.', 'Chapter four holds.', 'Chapter four holds.']);
        expect(rows.map((row) => row.lastAuthor)).toEqual(['agent', 'agent', 'agent']);

        // AND NOTHING IS ANNOUNCED. History is not chain traffic: without this rule the first
        // record frame would replay every conversation's whole past into the transcript.
        expect(events).toEqual([]);

        // One read per agent conversation, on the roster the Title just produced.
        expect(calls.filter((call) => call.startsWith('readThreadMessages:'))).toEqual([
            'readThreadMessages:thread-writer',
            'readThreadMessages:thread-reader',
            'readThreadMessages:thread-editor'
        ]);

        instance.dispose();
    });

    it('treats a record frame as the chain cue: re-reads, reads the conversation that grew, announces only what is new', async () => {
        // THE CHAIN'S WHOLE FOOTPRINT. A chained turn mints no turn row, so no `turn.upsert`
        // and no stream text ever arrive for it (src/server/orchestrator.ts); what DOES arrive
        // is `records.updated` — the gate that triggers the next hop is a record write, and the
        // store publishes it from a session-wide subscription whatever path wrote.
        let round = 0;

        const { instance, calls, flush, stream } = buildStoryline({
            api: {
                listThreads: async () => (round === 0 ? THREADS : THREADS.map((row) => (row.agent === 'writer' ? { ...row, messageCount: 12 } : row))),
                readThreadMessages: async (sessionId, threadId) =>
                    threadMessagesFor(
                        sessionId,
                        threadId,
                        round === 0
                            ? [entry(7, 'agent', 'Chapter four holds.')]
                            : [
                                  entry(7, 'agent', 'Chapter four holds.'),
                                  entry(8, 'user', 'You were called because the editor finished a turn.'),
                                  entry(9, 'agent', 'The opening still holds; chapter five is the problem.')
                              ]
                    )
            }
        });

        const events: AgentsActivityEvent[] = [];

        instance.on<AgentsActivityEvent>(AGENTS_ACTIVITY_EVENT, (event) => events.push(event));
        await flush();

        expect(events).toEqual([]);

        round = 1;
        stream().onRecords?.({ storeRev: 14, collectionsRev: 2 });
        await flush();

        // The announcement is the two entries that did not exist a moment ago, in the order the
        // conversation holds them — the task the chain posted, then the answer.
        expect(events).toEqual([
            {
                agent: 'writer',
                threadId: 'thread-writer',
                messages: [entry(8, 'user', 'You were called because the editor finished a turn.'), entry(9, 'agent', 'The opening still holds; chapter five is the problem.')]
            }
        ]);

        // And the card moved with it: the answer, and the count the roster now reports.
        const rows = instance.state<AgentsState>(AGENTS_STATE).get().rows;

        expect(rows[0]).toMatchObject({ lastActivity: 'The opening still holds; chapter five is the problem.', lastAuthor: 'agent', messageCount: 12 });

        // Only the conversation whose roster count moved is read a second time; a run that
        // commits records ten times must not page ten transcripts.
        expect(calls.filter((call) => call.startsWith('readThreadMessages:')).slice(3)).toEqual(['readThreadMessages:thread-writer']);

        instance.dispose();
    });

    it('treats the roster frame as the chain cue when no record moved at all (T13)', async () => {
        // THE CUE A RECORD WRITE CANNOT CARRY. `records.updated` is published synchronously
        // inside the committed tool call (harness src/server/sessions.ts:2262-2296), so it always
        // lands BEFORE the run's answer is appended (src/harness.ts:9811) — and the last hop of
        // the shipped chain (the reader, instructed to change nothing, src/server/presets.ts)
        // produces no record write at all. What DOES move is the conversation, and the roster row
        // carries its count (`message_count`, projected at src/api/stream.ts). The T13 defect
        // ignored the frame's count and re-read only on the record cue, so the answer stayed off
        // screen until some later record write anywhere in the session — or a click.
        let round = 0;

        const { instance, calls, flush, stream } = buildStoryline({
            api: {
                readThreadMessages: async (sessionId, threadId) =>
                    threadMessagesFor(
                        sessionId,
                        threadId,
                        round === 0
                            ? [entry(7, 'agent', 'Chapter four holds.')]
                            : threadId === 'thread-writer'
                              ? [
                                    entry(7, 'agent', 'Chapter four holds.'),
                                    entry(8, 'user', 'You were called because the editor finished a turn.'),
                                    entry(9, 'agent', 'The opening still holds; chapter five is the problem.')
                                ]
                              : [entry(7, 'agent', 'Chapter four holds.')]
                    )
            }
        });

        const events: AgentsActivityEvent[] = [];

        instance.on<AgentsActivityEvent>(AGENTS_ACTIVITY_EVENT, (event) => events.push(event));
        await flush();

        expect(events).toEqual([]);

        // ONE FRAME, AND NO RECORD WRITE ANYWHERE. `thread.upsert` arrives on its own, carrying
        // the row whose count grew — the whole live cue for a prose-only hop.
        round = 1;
        stream().onThread?.({ ...THREADS[0], status: 'idle', sequence: 8, messageCount: 11 });
        await flush();

        expect(events).toEqual([
            {
                agent: 'writer',
                threadId: 'thread-writer',
                messages: [entry(8, 'user', 'You were called because the editor finished a turn.'), entry(9, 'agent', 'The opening still holds; chapter five is the problem.')]
            }
        ]);

        // The card shows the sentence the run appended, and the count the frame carried.
        expect(instance.state<AgentsState>(AGENTS_STATE).get().rows[0]).toMatchObject({
            lastActivity: 'The opening still holds; chapter five is the problem.',
            lastAuthor: 'agent',
            messageCount: 11
        });

        // The frame IS the roster row, so no REST roster read was needed, and only the
        // conversation that grew was read — the other two stay exactly as they were.
        expect(calls.filter((call) => call.startsWith('listThreads:'))).toEqual(['listThreads:ses-new']);
        expect(calls.filter((call) => call.startsWith('readThreadMessages:'))).toEqual([
            'readThreadMessages:thread-writer',
            'readThreadMessages:thread-reader',
            'readThreadMessages:thread-editor',
            'readThreadMessages:thread-writer'
        ]);

        // A frame that repeats the count already on screen is not news: the roster moves for
        // reasons that change nothing (a stop, a resume, a status flip), and a conversation read
        // per frame would page transcripts that cannot hold a new sentence.
        stream().onThread?.({ ...THREADS[0], status: 'idle', sequence: 9, messageCount: 11 });
        stream().onThread?.({ ...THREADS[0], status: 'running', sequence: 10, messageCount: 11 });
        await flush();

        expect(calls.filter((call) => call.startsWith('readThreadMessages:'))).toHaveLength(4);
        expect(events).toHaveLength(1);

        instance.dispose();
    });

    it('does not mistake the synthetic store marker for a chain signal', async () => {
        const { instance, calls, flush, stream } = buildStoryline();

        await flush();

        // `storeRev: 0` is the titles plugin's own "the collections were just defined" cue
        // (plugins/titles.ts), not a server frame, and the roster was read moments ago.
        stream().onRecords?.({ storeRev: 0, collectionsRev: 0 });
        await flush();

        expect(calls.filter((call) => call.startsWith('listThreads:'))).toEqual(['listThreads:ses-new']);

        instance.dispose();
    });

    it('leaves the panel complete when a conversation cannot be read', async () => {
        const { instance, flush } = buildStoryline({
            api: {
                readThreadMessages: async () => Promise.reject(new Error('transcript unavailable'))
            }
        });

        await flush();

        const state = instance.state<AgentsState>(AGENTS_STATE).get();

        // A preview this pane cannot fetch is an empty line, not a broken roster: the rows,
        // their threads and their counts all still come from the read that succeeded.
        expect(state.phase).toBe('ready');
        expect(state.error).toBe('');
        expect(state.rows.map((row) => row.lastActivity)).toEqual(['', '', '']);
        expect(state.rows[0]).toMatchObject({ threadId: 'thread-writer', messageCount: 9 });

        instance.dispose();
    });
});
