// The turns plugin: one Title's transcript, and the composer that addresses it.
//
// WHAT THIS FILE PINS, in the order the operator meets it:
//
//   1. THE SEND PATH. The harness submit takes NO agent field — `SubmitTaskInput` is
//      `{ input, threadId? }` (harness src/frontend/api.ts:1470) — so "send to the
//      reader" means "post into the reader's conversation". The pinned call sequence is
//      `openThread:<Title>:<agent>` → `submit:<thread>:<text>` → `followTurn` on the ONE
//      shared socket → the canonical `readTurnText` that settles the row.
//   2. THE CANONICAL SETTLE. `settle()` re-reads `GET .../turns/{id}/display` and has to
//      hand that read the agent the composer addressed the turn to: the display document
//      is one section per flow, and a `reader`/`editor` host-thread run projects a
//      `subagent`-role root (harness src/server/turn-projector.ts:723), so the hint is
//      the difference between committed prose and a row that never fills in. Three paths
//      settle a row — the submit, the terminal `turn.upsert`, a dropped-frame resync —
//      and all three must carry the hint. The extraction itself is pinned in
//      src/api/storyline.test.ts.
//   3. PER-TITLE ISOLATION. Rows live in a bucket per session and the state cell mirrors
//      only the ACTIVE Title's bucket, so switching Titles swaps the conversation and
//      switching back restores it.
//   4. THE FOLD RULES. `onText` carries the ACCUMULATED answer, so the row is ASSIGNED,
//      never appended; only a terminal `turn.upsert` may end an answer; and a mid-flight
//      canonical read must not clobber a fold that is already ahead of it.
//   5. THE CHAIN. A review-chain run posts its task into a conversation with
//      `sendThreadInput` and mints NO session turn, so none of the four paths above ever see
//      it (src/server/orchestrator.ts). What reaches this page is the agents plugin's
//      announcement — the entries a `records.updated` frame proved were new — and the rows
//      it appends here: one per entry, `triggered`, with no turn id, never a sentence the
//      panel is already showing under the same role.
//
// Everything runs through the real composition with both network seams doubled
// (../testing/doubles.ts), so no server and no socket is involved.
import { describe, expect, it } from 'vitest';
import type { StorylineThreadMessage, StorylineThreadRef } from '../../api';
import type { HarnessTurnFrame } from '../../api/stream';
import {
    AGENTS_ACTIVITY_EVENT,
    TITLES_SELECT_COMMAND,
    TURNS_AGENT_STATE,
    TURNS_COMPOSER_STATE,
    TURNS_FINISHED_EVENT,
    TURNS_SEND_COMMAND,
    TURNS_SENT_EVENT,
    TURNS_STOP_COMMAND,
    TURNS_TRANSCRIPT_STATE,
    type AgentsActivityEvent,
    type ComposerDraft,
    type StorylineAgent,
    type TurnRow,
    type TurnsFinishedEvent,
    type TurnsSentEvent
} from '../contract';
import { buildStoryline, THREADS, threadMessagesFor } from '../testing/doubles';

/** The committed prose the doubled display read answers with (doubles.ts `readTurnText`). */
const COMMITTED = 'the committed answer';

/**
 * `id` and `at` are wall-clock derived, so they are left out; everything an operator
 * actually sees — which Title, which agent, which role, how far it got, the text — is
 * compared exactly.
 */
const visibleRows = (rows: readonly TurnRow[]) =>
    rows.map((row) => ({
        sessionId: row.sessionId,
        agent: row.agent,
        role: row.role,
        phase: row.phase,
        text: row.text,
        turnId: row.turnId,
        triggered: row.triggered
    }));

/**
 * Only the routes a send takes. Boot also reads the store and the roster, and those
 * belong to plugins records.test.ts / agents.test.ts pin — counting them here would make
 * this file move when another plugin changes.
 */
const sendRoutes = (calls: readonly string[]) => calls.filter((call) => /^(openThread|submit|readTurnText|stop):/.test(call));

/** One `turn.upsert` frame — the only frame that can END a streamed answer. */
const turnFrame = (id: string, status: HarnessTurnFrame['status'], threadId = 'thread-writer'): HarnessTurnFrame => ({
    id,
    index: 1,
    status,
    threadId,
    updatedAt: 2
});

/** A conversation row for a thread the REST roster never listed (a late `thread.upsert`). */
const lateThread = (agent: string, id: string): StorylineThreadRef => ({
    id,
    agent,
    origin: 'host',
    status: 'running',
    sequence: 9,
    ownerThreadId: '',
    label: `storyline:${agent}`,
    messageCount: 1,
    transcriptState: 'ok'
});

/**
 * One entry as the conversation read returns it (src/api/storyline.ts). `position` is the
 * entry's absolute index in the transcript, which is the only stable identity a chained entry
 * has: a chained run mints no turn, so nothing downstream can key on a turn id.
 */
const entry = (position: number, role: StorylineThreadMessage['role'], text: string): StorylineThreadMessage => ({
    position,
    messageId: `m-${position}`,
    role,
    text
});

describe('turns plugin send path', () => {
    it('sends into the conversation of the chosen agent and follows that turn on the shared socket', async () => {
        const { instance, calls, handle, flush } = buildStoryline();

        await flush();

        const sent: string[] = [];

        instance.on<TurnsSentEvent>(TURNS_SENT_EVENT, ({ agent, turnId }) => sent.push(`${agent}:${turnId}`));

        await instance.execute<string, Promise<readonly TurnRow[]>>(TURNS_SEND_COMMAND, 'Open on the harbour.');
        await flush();

        // The thread first, then the submit addressed to it, then the canonical re-read of
        // the turn that submit answered for — in that order, with nothing in between.
        expect(sendRoutes(calls)).toEqual([
            'openThread:ses-new:writer',
            `submit:thread-writer:Open on the harbour.`,
            `readTurnText:turn-1:writer`
        ]);
        // Deltas ride the TURN scope only, so the subscription opens the moment the id exists.
        expect(handle.followed).toEqual(['turn-1']);
        expect(sent).toEqual(['writer:turn-1']);

        const rows = instance.state<readonly TurnRow[]>(TURNS_TRANSCRIPT_STATE).get();

        expect(visibleRows(rows)).toEqual([
            { sessionId: 'ses-new', agent: 'writer', role: 'user', phase: 'done', text: 'Open on the harbour.', turnId: '', triggered: false },
            { sessionId: 'ses-new', agent: 'writer', role: 'agent', phase: 'running', text: COMMITTED, turnId: 'turn-1', triggered: false }
        ]);

        // The draft is spent: a composer that kept the text would send the same line twice.
        expect(instance.state<ComposerDraft>(TURNS_COMPOSER_STATE).get()).toEqual({ agent: 'writer', text: '' });

        instance.dispose();
    });

    it('addresses every re-read at the agent the composer picked, not at the default', async () => {
        // The composition's `agent` option is applied through a command after the build
        // (composition.ts) — the kernel has no plugin options, so this is also the pinned
        // proof that the host's choice lands in the turns plugin's own state.
        const { instance, calls, flush, stream } = buildStoryline({ agent: 'reader' });

        await flush();

        expect(instance.state<StorylineAgent>(TURNS_AGENT_STATE).get()).toBe('reader');

        const finished: TurnsFinishedEvent[] = [];

        instance.on<TurnsFinishedEvent>(TURNS_FINISHED_EVENT, (event) => finished.push(event));

        await instance.execute<string, Promise<readonly TurnRow[]>>(TURNS_SEND_COMMAND, 'Summarize chapter two.');
        await flush();

        // Path 1 — the submit's own re-read, which closes the window between the submit and
        // the turn subscription.
        expect(sendRoutes(calls)).toEqual(['openThread:ses-new:reader', 'submit:thread-reader:Summarize chapter two.', 'readTurnText:turn-1:reader']);

        // Path 2 — the terminal `turn.upsert`.
        stream().onTurn?.(turnFrame('turn-1', 'done', 'thread-reader'));
        await flush();

        // Path 3 — a dropped-frame resync re-reads the same canonical document.
        stream().onResync?.('frames_dropped', 'turn-1');
        await flush();

        // The hint names `reader` on all three paths: a `reader` run answers in a
        // `subagent`-role section, so an extraction keyed on the primary flow alone would
        // have left this row on its placeholder forever.
        expect(sendRoutes(calls).filter((call) => call.startsWith('readTurnText:'))).toEqual([
            'readTurnText:turn-1:reader',
            'readTurnText:turn-1:reader',
            'readTurnText:turn-1:reader'
        ]);
        expect(finished).toEqual([{ turnId: 'turn-1', phase: 'done' }]);

        const rows = instance.state<readonly TurnRow[]>(TURNS_TRANSCRIPT_STATE).get();

        expect(visibleRows(rows)).toEqual([
            { sessionId: 'ses-new', agent: 'reader', role: 'user', phase: 'done', text: 'Summarize chapter two.', turnId: '', triggered: false },
            { sessionId: 'ses-new', agent: 'reader', role: 'agent', phase: 'done', text: COMMITTED, turnId: 'turn-1', triggered: false }
        ]);

        instance.dispose();
    });

    it('opens one conversation per agent per Title and reuses it for the next send', async () => {
        const { instance, calls, flush, stream } = buildStoryline();

        await flush();
        await instance.execute<string, Promise<readonly TurnRow[]>>(TURNS_SEND_COMMAND, 'First line.');
        await flush();

        // The turn has to close before the next send: one running turn per Title.
        stream().onTurn?.(turnFrame('turn-1', 'done'));
        await flush();

        await instance.execute<string, Promise<readonly TurnRow[]>>(TURNS_SEND_COMMAND, 'Second line.');
        await flush();

        // Two sends, ONE conversation — a second thread per agent would fork the story's
        // context, and the api's own reuse rule (src/api/storyline.ts `openThread`) is the
        // other half of that promise.
        expect(sendRoutes(calls)).toEqual([
            'openThread:ses-new:writer',
            'submit:thread-writer:First line.',
            'readTurnText:turn-1:writer',
            'readTurnText:turn-1:writer',
            'submit:thread-writer:Second line.',
            'readTurnText:turn-1:writer'
        ]);

        const rows = instance.state<readonly TurnRow[]>(TURNS_TRANSCRIPT_STATE).get();

        expect(rows).toHaveLength(4);
        expect(rows.map((row) => row.text)).toEqual(['First line.', COMMITTED, 'Second line.', COMMITTED]);

        instance.dispose();
    });

    it('refuses a second send while an agent is still answering, and says why', async () => {
        const { instance, calls, flush } = buildStoryline();

        await flush();
        await instance.execute<string, Promise<readonly TurnRow[]>>(TURNS_SEND_COMMAND, 'First line.');
        await flush();

        await expect(instance.execute<string, Promise<readonly TurnRow[]>>(TURNS_SEND_COMMAND, 'Too soon.')).rejects.toThrow(
            'An agent is already answering this Title — stop it first.',
        );

        // The refusal happens BEFORE the rows are appended: a rejected send must not leave a
        // question on screen that the server never received.
        const rows = instance.state<readonly TurnRow[]>(TURNS_TRANSCRIPT_STATE).get();

        expect(rows.map((row) => row.text)).toEqual(['First line.', COMMITTED]);
        expect(sendRoutes(calls)).toHaveLength(3);

        instance.dispose();
    });

    it('sends nothing for a blank draft instead of opening a conversation', async () => {
        const { instance, calls, flush } = buildStoryline();

        await flush();

        const rows = await instance.execute<string, Promise<readonly TurnRow[]>>(TURNS_SEND_COMMAND, '   ');

        expect(rows).toEqual([]);
        expect(sendRoutes(calls)).toEqual([]);

        instance.dispose();
    });

    it('stops a run over the thread it was posted on and leaves the row open', async () => {
        const { instance, calls, flush, stream } = buildStoryline();

        await flush();
        await instance.execute<string, Promise<readonly TurnRow[]>>(TURNS_SEND_COMMAND, 'Long draft.');
        await flush();

        expect(await instance.execute<void, Promise<boolean>>(TURNS_STOP_COMMAND)).toBe(true);

        // The row is left OPEN on purpose: if the server really stopped the run a
        // `turn.upsert(cancelled)` lands and closes it, and if the run had already finished
        // its real terminal state wins over a guess made here.
        expect(instance.state<readonly TurnRow[]>(TURNS_TRANSCRIPT_STATE).get()[1]).toMatchObject({ phase: 'queued', turnId: 'turn-1' });

        // Stop addresses the conversation, not the agent key, and never a Title that has
        // nothing running: a second stop answers false because the row is no longer owned.
        stream().onTurn?.(turnFrame('turn-1', 'cancelled'));
        await flush();
        expect(await instance.execute<void, Promise<boolean>>(TURNS_STOP_COMMAND)).toBe(false);

        expect(sendRoutes(calls).filter((call) => call.startsWith('stop:'))).toEqual(['stop:ses-new:thread-writer']);

        const rows = instance.state<readonly TurnRow[]>(TURNS_TRANSCRIPT_STATE).get();

        // The cancel frame is what closed the row, and the committed prose stayed.
        expect(visibleRows(rows)[1]).toEqual({
            sessionId: 'ses-new',
            agent: 'writer',
            role: 'agent',
            phase: 'cancelled',
            text: COMMITTED,
            turnId: 'turn-1',
            triggered: false
        });

        instance.dispose();
    });
});

describe('turns plugin stream fold', () => {
    it('assigns the accumulated stream text onto the open row instead of appending it', async () => {
        const { instance, flush, stream } = buildStoryline();

        await flush();
        await instance.execute<string, Promise<readonly TurnRow[]>>(TURNS_SEND_COMMAND, 'Draft the opening.');
        await flush();

        // `onText` carries the ACCUMULATED answer (src/api/stream.ts folds the deltas), so a
        // second frame replaces the row's text; an append would double every delta.
        stream().onText?.('Fog, then', 'turn-1');
        stream().onText?.('Fog, then a harbour.', 'turn-1');
        await flush();

        const rows = instance.state<readonly TurnRow[]>(TURNS_TRANSCRIPT_STATE).get();

        expect(rows).toHaveLength(2);
        expect(rows[1]).toMatchObject({ role: 'agent', phase: 'running', text: 'Fog, then a harbour.' });

        instance.dispose();
    });

    it('keeps a mid-flight fold when a canonical read lands behind it, and takes the committed text when the turn ends', async () => {
        const { instance, flush, stream } = buildStoryline();

        await flush();
        await instance.execute<string, Promise<readonly TurnRow[]>>(TURNS_SEND_COMMAND, 'Draft the opening.');
        await flush();

        // Mid-flight: a display read that started earlier is BEHIND the fold, so clobbering
        // it backwards would make the answer flicker. The streamed text stays.
        stream().onText?.('Fog, then a harbour.', 'turn-1');
        instance.emit('storyline.stream.resync', { reason: 'frames_dropped', turnId: 'turn-1' });
        await flush();

        expect(instance.state<readonly TurnRow[]>(TURNS_TRANSCRIPT_STATE).get()[1]).toMatchObject({ phase: 'running', text: 'Fog, then a harbour.' });

        // Terminal: now the server's committed prose wins, because the fold cannot say the
        // answer is finished and the display document can.
        stream().onTurn?.(turnFrame('turn-1', 'done'));
        await flush();

        expect(instance.state<readonly TurnRow[]>(TURNS_TRANSCRIPT_STATE).get()[1]).toMatchObject({ phase: 'done', text: COMMITTED });

        instance.dispose();
    });

    it('shows a turn the story pipeline started and attributes it once the roster names its thread', async () => {
        const { instance, calls, flush, stream } = buildStoryline();

        await flush();

        // The story drives turns of its own. This one arrives before its thread has appeared
        // in the roster, so the honest answer at that moment is "no agent of ours".
        stream().onTurn?.({ id: 'turn-77', index: 5, status: 'running', threadId: 'thread-late', updatedAt: 10 });
        await flush();

        const rows = () => instance.state<readonly TurnRow[]>(TURNS_TRANSCRIPT_STATE).get();

        expect(visibleRows(rows())).toEqual([
            { sessionId: 'ses-new', agent: '', role: 'agent', phase: 'running', text: '', turnId: 'turn-77', triggered: true }
        ]);

        // The `thread.upsert` lands late. Attribution is re-derived on every frame rather
        // than frozen at the first one, so the row gets its agent here.
        stream().onThread?.(lateThread('editor', 'thread-late'));
        stream().onTurn?.({ id: 'turn-77', index: 5, status: 'running', threadId: 'thread-late', updatedAt: 11 });
        await flush();

        expect(rows()[0]).toMatchObject({ agent: 'editor', triggered: true });

        stream().onTurn?.({ id: 'turn-77', index: 5, status: 'done', threadId: 'thread-late', updatedAt: 12 });
        await flush();

        // One row for the whole turn, settled through the agent the roster named.
        expect(rows()).toHaveLength(1);
        expect(rows()[0]).toMatchObject({ agent: 'editor', phase: 'done', text: COMMITTED });
        expect(sendRoutes(calls)).toEqual(['readTurnText:turn-77:editor']);

        instance.dispose();
    });

    it('leaves a turn with no route to one of our three agents unattributed', async () => {
        const { instance, flush, stream } = buildStoryline();

        await flush();

        // A threadless flow naming two of the three agents is a team turn: guessing either
        // one would label an answer that belongs to neither.
        stream().onTurn?.({ id: 'turn-88', index: 6, status: 'running', activeAgents: ['writer', 'reader'], updatedAt: 10 });
        await flush();

        expect(instance.state<readonly TurnRow[]>(TURNS_TRANSCRIPT_STATE).get()[0]).toMatchObject({ agent: '', turnId: 'turn-88' });

        instance.dispose();
    });
});

describe('turns plugin chained turns', () => {
    /**
     * The announcement plugins/agents.ts emits when a conversation gains entries this page has
     * not shown (plugins/agents.ts). Emitting it directly keeps these tests about the transcript
     * half of the chain; the cue that produces it is pinned there.
     */
    const announcer = (instance: ReturnType<typeof buildStoryline>['instance']) => {
        return (agent: StorylineAgent, threadId: string, messages: readonly StorylineThreadMessage[]): void => {
            instance.emit<AgentsActivityEvent>(AGENTS_ACTIVITY_EVENT, { agent, threadId, messages });
        };
    };

    it('turns the conversation a record frame announced into chain-initiated rows', async () => {
        // THE CHAIN'S WHOLE FOOTPRINT ON THIS PANEL: a chained run mints no turn row, so no
        // `turn.upsert`, no display document and no `onText` delta ever arrive for it
        // (src/server/orchestrator.ts). The `records.updated` frame the next hop's gate wrote,
        // and the conversation the agents plugin read because of it, are all there is — and the
        // transcript still has to show the exchange.
        let round = 0;

        const { instance, flush, stream } = buildStoryline({
            api: {
                // The roster's message count is what says a conversation gained prose.
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

        await flush();

        // Boot SEEDED the conversations: the prose that was already there when the page opened
        // is history, not chain traffic, and it does not belong in this transcript.
        expect(instance.state<readonly TurnRow[]>(TURNS_TRANSCRIPT_STATE).get()).toEqual([]);

        round = 1;
        stream().onRecords?.({ storeRev: 14, collectionsRev: 2 });
        await flush();

        // The task the chain posted and the answer it produced, in the order the conversation
        // holds them. No turn id — there is no turn to open — and `triggered`, because the
        // pipeline started this exchange rather than the composer.
        expect(visibleRows(instance.state<readonly TurnRow[]>(TURNS_TRANSCRIPT_STATE).get())).toEqual([
            {
                sessionId: 'ses-new',
                agent: 'writer',
                role: 'system',
                phase: 'done',
                text: 'You were called because the editor finished a turn.',
                turnId: '',
                triggered: true
            },
            {
                sessionId: 'ses-new',
                agent: 'writer',
                role: 'agent',
                phase: 'done',
                text: 'The opening still holds; chapter five is the problem.',
                turnId: '',
                triggered: true
            }
        ]);

        instance.dispose();
    });

    it('shows each announced entry once however many times the conversation is re-read', async () => {
        const { instance, flush } = buildStoryline();
        const announce = announcer(instance);

        await flush();

        announce('writer', 'thread-writer', [entry(8, 'user', 'Review what changed.'), entry(9, 'agent', 'Chapter four holds.')]);
        await flush();

        // A resync, or a second `records.updated` whose read covers the same ground: the rows
        // are keyed by the thread and the entry's absolute position, so the same prose cannot
        // be appended twice.
        announce('writer', 'thread-writer', [entry(8, 'user', 'Review what changed.'), entry(9, 'agent', 'Chapter four holds.')]);
        await flush();

        const rows = instance.state<readonly TurnRow[]>(TURNS_TRANSCRIPT_STATE).get();

        expect(rows.map((row) => ({ role: row.role, text: row.text }))).toEqual([
            { role: 'system', text: 'Review what changed.' },
            { role: 'agent', text: 'Chapter four holds.' }
        ]);

        // The next hop is its own exchange, so it lands after the first one rather than
        // replacing it — a chain has to read as a sequence of handoffs.
        announce('writer', 'thread-writer', [entry(10, 'user', 'Now check chapter five.'), entry(11, 'agent', 'Chapter five needs the harbour back.')]);
        await flush();

        expect(instance.state<readonly TurnRow[]>(TURNS_TRANSCRIPT_STATE).get().map((row) => row.text)).toEqual([
            'Review what changed.',
            'Chapter four holds.',
            'Now check chapter five.',
            'Chapter five needs the harbour back.'
        ]);

        instance.dispose();
    });

    it('does not put the operator’s own prompt and answer on screen a second time', async () => {
        const { instance, flush } = buildStoryline();
        const announce = announcer(instance);

        await flush();
        await instance.execute<string, Promise<readonly TurnRow[]>>(TURNS_SEND_COMMAND, 'Open on the harbour.');
        await flush();

        // The composer wrote both sides of its own exchange already.
        expect(instance.state<readonly TurnRow[]>(TURNS_TRANSCRIPT_STATE).get().map((row) => row.text)).toEqual(['Open on the harbour.', COMMITTED]);

        // A user turn commits records too, so its own conversation announces those same two
        // entries back at this panel — laid out differently from the fold, which is why the
        // comparison ignores whitespace. Only the entry nobody has seen becomes a row.
        announce('writer', 'thread-writer', [
            entry(4, 'user', 'Open  on\nthe harbour.'),
            entry(5, 'agent', COMMITTED),
            entry(6, 'user', 'The editor wants the ending checked.')
        ]);
        await flush();

        const rows = instance.state<readonly TurnRow[]>(TURNS_TRANSCRIPT_STATE).get();

        expect(rows.map((row) => ({ role: row.role, text: row.text, triggered: row.triggered }))).toEqual([
            { role: 'user', text: 'Open on the harbour.', triggered: false },
            { role: 'agent', text: COMMITTED, triggered: false },
            { role: 'system', text: 'The editor wants the ending checked.', triggered: true }
        ]);

        instance.dispose();
    });

    it('keeps one Title’s chained rows inside that Title’s transcript', async () => {
        const { instance, flush } = buildStoryline();
        const announce = announcer(instance);

        await flush();
        await instance.execute<string, Promise<string>>(TITLES_SELECT_COMMAND, 'ses-old');
        await flush();

        announce('reader', 'thread-reader', [entry(2, 'user', 'Summarize what the writer changed.'), entry(3, 'agent', 'Two scenes moved.')]);
        await flush();

        expect(visibleRows(instance.state<readonly TurnRow[]>(TURNS_TRANSCRIPT_STATE).get()).map((row) => row.sessionId)).toEqual(['ses-old', 'ses-old']);

        await instance.execute<string, Promise<string>>(TITLES_SELECT_COMMAND, 'ses-new');
        await flush();

        // The other Title never had that conversation, so its transcript is still empty — and
        // switching back finds the chain rows where they were left.
        expect(instance.state<readonly TurnRow[]>(TURNS_TRANSCRIPT_STATE).get()).toEqual([]);

        await instance.execute<string, Promise<string>>(TITLES_SELECT_COMMAND, 'ses-old');
        await flush();

        expect(instance.state<readonly TurnRow[]>(TURNS_TRANSCRIPT_STATE).get().map((row) => row.text)).toEqual([
            'Summarize what the writer changed.',
            'Two scenes moved.'
        ]);

        instance.dispose();
    });
});

describe('turns plugin per-Title transcripts', () => {
    it('keeps each Title rows in its own bucket across a Title switch', async () => {
        const { instance, calls, flush } = buildStoryline();

        await flush();
        await instance.execute<string, Promise<readonly TurnRow[]>>(TURNS_SEND_COMMAND, 'For the newest Title.');
        await flush();

        const before = visibleRows(instance.state<readonly TurnRow[]>(TURNS_TRANSCRIPT_STATE).get());

        expect(before.map((row) => row.sessionId)).toEqual(['ses-new', 'ses-new']);

        await instance.execute<string, Promise<string>>(TITLES_SELECT_COMMAND, 'ses-old');
        await flush();

        // The cell holds the ACTIVE Title, and that Title has no rows yet: the newest
        // Title's conversation must not sit under the wrong name.
        expect(instance.state<readonly TurnRow[]>(TURNS_TRANSCRIPT_STATE).get()).toEqual([]);

        await instance.execute<string, Promise<readonly TurnRow[]>>(TURNS_SEND_COMMAND, 'For the older Title.');
        await flush();

        expect(visibleRows(instance.state<readonly TurnRow[]>(TURNS_TRANSCRIPT_STATE).get())).toEqual([
            { sessionId: 'ses-old', agent: 'writer', role: 'user', phase: 'done', text: 'For the older Title.', turnId: '', triggered: false },
            { sessionId: 'ses-old', agent: 'writer', role: 'agent', phase: 'running', text: COMMITTED, turnId: 'turn-1', triggered: false }
        ]);

        await instance.execute<string, Promise<string>>(TITLES_SELECT_COMMAND, 'ses-new');
        await flush();

        // Switching back restores what was left behind, and each Title keeps its OWN
        // conversation per agent — the thread cache is keyed by Title for exactly this.
        expect(visibleRows(instance.state<readonly TurnRow[]>(TURNS_TRANSCRIPT_STATE).get())).toEqual(before);
        expect(sendRoutes(calls).filter((call) => call.startsWith('openThread:'))).toEqual([
            'openThread:ses-new:writer',
            'openThread:ses-old:writer'
        ]);

        instance.dispose();
    });

    it('treats a Title switch as a fresh start for the running-turn guard', async () => {
        const { instance, flush, stream } = buildStoryline();

        await flush();
        await instance.execute<string, Promise<readonly TurnRow[]>>(TURNS_SEND_COMMAND, 'Busy here.');
        await flush();

        // Two Titles, two conversations: the other Title has nothing running, so its send
        // is accepted while this one is still answering.
        await instance.execute<string, Promise<string>>(TITLES_SELECT_COMMAND, 'ses-old');
        await flush();
        await instance.execute<string, Promise<readonly TurnRow[]>>(TURNS_SEND_COMMAND, 'And here.');
        await flush();

        expect(instance.state<readonly TurnRow[]>(TURNS_TRANSCRIPT_STATE).get().map((row) => row.sessionId)).toEqual(['ses-old', 'ses-old']);

        // The row left behind is still open on screen, and the guard came back cleared: a
        // Title switch drops this plugin's per-Title maps (turns.ts), so the composer does
        // not refuse a send over a run whose frames were never watched here. Closing that
        // abandoned row needs the turn's terminal status, which the display read does not
        // carry — pinned here so the choice stays visible rather than accidental.
        await instance.execute<string, Promise<string>>(TITLES_SELECT_COMMAND, 'ses-new');
        await flush();

        const before = instance.state<readonly TurnRow[]>(TURNS_TRANSCRIPT_STATE).get();

        expect(before.map((row) => ({ phase: row.phase, text: row.text }))).toEqual([
            { phase: 'done', text: 'Busy here.' },
            { phase: 'running', text: COMMITTED }
        ]);

        await instance.execute<string, Promise<readonly TurnRow[]>>(TURNS_SEND_COMMAND, 'Try again.');
        await flush();

        expect(instance.state<readonly TurnRow[]>(TURNS_TRANSCRIPT_STATE).get().map((row) => row.text)).toEqual([
            'Busy here.',
            COMMITTED,
            'Try again.',
            COMMITTED
        ]);

        // The terminal frame the switch missed still closes the row it belongs to, because
        // the frame is folded against whichever Title is active now.
        stream().onTurn?.(turnFrame('turn-1', 'done'));
        await flush();

        expect(instance.state<readonly TurnRow[]>(TURNS_TRANSCRIPT_STATE).get()[3]).toMatchObject({ phase: 'done', turnId: 'turn-1' });

        instance.dispose();
    });
});
