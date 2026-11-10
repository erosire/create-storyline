// The agent surface: the transcript of this Title and the composer that addresses it.
//
// AGENT TARGETING (the fixed contract's `writer` / `reader` / `editor`, all three
// equal): the harness submit route has NO agent field — `SubmitTaskInput` is exactly
// `{ input, threadId? }` (harness src/frontend/api.ts:1470). The agent belongs to the
// CONVERSATION: `POST /sessions/{id}/threads` takes `{ agent, label }` (harness
// src/shared/harness-api.ts:1724) and a submit addressed to that thread runs as that
// agent. So this plugin keeps ONE thread per agent key per Title (opened lazily, and
// reused across reloads by the api's own reuse rule), and addresses it on every send —
// three selectable agents, three conversations, one Title, no server-side addition.
//
// THE TRANSCRIPT IS PER TITLE, NOT GLOBAL. Rows live in one bucket per session id and
// the state cell always mirrors the ACTIVE Title's bucket, so switching Titles swaps
// the conversation without discarding what the Title being left behind showed. Each
// bucket tracks at most one running turn: two open rows racing into one transcript is
// a UI this workstation does not need, so the composer disables Send and offers Stop.
//
// WHAT THE STREAM DOES HERE. The titles plugin owns the socket and re-broadcasts it as
// events (plugins/titles.ts); this plugin is one of its listeners:
//   STREAM_TEXT  — the ACCUMULATED primary answer, assigned (never appended) onto the
//                  open row, because the stream client already folded the deltas;
//   STREAM_TURN  — the whole turn row. It CREATES a row for a turn this UI did not
//                  start (the story pipeline drives turns of its own), marks it
//                  `triggered`, and its terminal state is what ENDS an answer — a delta
//                  stream alone cannot say that, only `turn.upsert` can;
//   STREAM_RESYNC — frames were dropped, so the fold is not trustworthy and the
//                  canonical display is re-read instead.
// The canonical read (`GET .../turns/{id}/display`, through the api's `readTurnText`)
// is the settle step for every terminal turn: whatever the deltas accumulated, the
// server's committed text is what stays on screen. The `agent` hint it takes is which
// flow ANSWERED — the display document is one section per flow and only the hint says
// which one is the answer (src/api/storyline.ts, `turnTextFromDisplay`).
//
// THE THIRD SOURCE: THE CONVERSATION ITSELF. A turn the review chain started has no turn
// row at all — it is delivered by posting into a conversation (`sendThreadInput`), and the
// store wraps a run in a turn only inside its own submit route (harness
// src/server/sessions.ts:8098) — so the only frame it ever sends is `records.updated`. The
// agents plugin reads that conversation and announces what grew
// (`storyline.agents.activity`, plugins/agents.ts); this plugin folds it into the
// transcript as rows with no turn id, the prompt as `system` and the answer as `agent`.
// Without that read the chained prose would be unreadable: the trigger fires, the records
// move, and nothing on screen says what the next agent was asked or what it said.
import type { DashboardPlugin, DashboardPluginAPI } from '@underload/dashboard';
import type { StorylineAgent, StorylineThreadMessage } from '../../api';
import {
    AGENTS_ACTIVITY_EVENT,
    AGENTS_ROSTER_SERVICE,
    AGENT_OPTIONS,
    API_SERVICE,
    COMPOSER_PANEL,
    DEFAULT_AGENT,
    PANEL_ORDERS,
    PANEL_SLOT,
    PLUGIN_IDS,
    STREAM_RESYNC_EVENT,
    STREAM_TEXT_EVENT,
    STREAM_TURN_EVENT,
    TITLES_ACTIVE_EVENT,
    TITLES_SERVICE,
    TRANSCRIPT_PANEL,
    TURNS_AGENT_STATE,
    TURNS_COMPOSER_STATE,
    TURNS_FINISHED_EVENT,
    TURNS_SELECT_AGENT_COMMAND,
    TURNS_SEND_COMMAND,
    TURNS_SENT_EVENT,
    TURNS_STOP_COMMAND,
    TURNS_TRANSCRIPT_STATE,
    TURNS_UPDATE_COMMAND,
    AGENTS_SELECT_EVENT,
    type AgentsActivityEvent,
    type AgentsSelectEvent,
    type ComposerDraft,
    type PanelValue,
    type RosterService,
    type StorylineApiService,
    type StreamResyncEvent,
    type StreamTextEvent,
    type StreamTurnEvent,
    type TitlesActiveEvent,
    type TitlesService,
    type TurnPhase,
    type TurnRole,
    type TurnRow,
    type TurnsFinishedEvent,
    type TurnsSentEvent
} from '../contract';
import { ComposerPanel } from '../components/ComposerPanel';
import { TranscriptPanel } from '../components/TranscriptPanel';

/** Harness turn status -> this UI's row phase. Only done/error/cancelled are terminal. */
export const phaseOfTurnStatus = (status: string): TurnPhase => {
    if (status === 'done') return 'done';
    if (status === 'error') return 'error';
    if (status === 'cancelled') return 'cancelled';
    if (status === 'aborted' || status === 'stopped') return 'stopped';
    if (status === 'running') return 'running';

    return 'queued';
};

/** The phases after which no delta may reopen a row. */
const isTerminal = (phase: TurnPhase): boolean => phase === 'done' || phase === 'error' || phase === 'cancelled';

/** One row of the transcript: an empty placeholder whose text arrives from the stream. */
const openRow = (sessionId: string, agent: TurnRow['agent'], role: TurnRow['role'], text: string, at: number, triggered: boolean): TurnRow => ({
    id: `turn-row-${sessionId}-${at}-${role}`,
    turnId: '',
    sessionId,
    agent,
    role,
    // A question the operator sent is finished the moment it is sent; an answer starts open.
    phase: role === 'user' ? 'done' : 'queued',
    text,
    triggered,
    at
});

/** Narrowed to the three keys this UI speaks; anything else is an unknown flow. */
const asAgent = (value: string | undefined): StorylineAgent | '' =>
    AGENT_OPTIONS.some((option) => option.key === value) ? (value as StorylineAgent) : '';

/**
 * A transcript entry's author, in this UI's vocabulary.
 *
 * The conversation cannot say who posted a `user` entry, and the two answers it might have
 * are displayed differently on purpose: an operator's prompt already has its own row (the
 * composer writes one the moment Send is clicked), while a prompt the review chain posted
 * has no row anywhere else — so it is shown as `system`, never as "you".
 */
const roleOfEntry = (role: StorylineThreadMessage['role']): TurnRole => (role === 'user' ? 'system' : 'agent');

/**
 * Text comparison that ignores layout: the same sentence reaches this panel from the turn
 * display document (paragraph-split, folded by the stream) and from the transcript entry
 * (one string), and those differ by whitespace, not by content.
 */
const sameText = (left: string, right: string): boolean =>
    left.replace(/\s+/g, ' ').trim() === right.replace(/\s+/g, ' ').trim();

export function createTurnsPlugin(): DashboardPlugin {
    return {
        id: PLUGIN_IDS.turns,
        requires: [PLUGIN_IDS.api, PLUGIN_IDS.titles, PLUGIN_IDS.agents],

        setup(api: DashboardPluginAPI): () => void {
            const server = api.getService<StorylineApiService>(API_SERVICE);
            const titles = api.getService<TitlesService>(TITLES_SERVICE);
            const roster = api.getService<RosterService>(AGENTS_ROSTER_SERVICE);

            // The starting agent is the composition's option, applied by a command after the
            // build (composition.ts) — the kernel has no plugin options, and a command is the
            // only legal way to write another plugin's state.
            const agent = api.state<StorylineAgent>(TURNS_AGENT_STATE, DEFAULT_AGENT);
            const transcript = api.state<readonly TurnRow[]>(TURNS_TRANSCRIPT_STATE, []);
            const composer = api.state<ComposerDraft>(TURNS_COMPOSER_STATE, { agent: DEFAULT_AGENT, text: '' });

            // Everything below is bookkeeping, never rendered: the kernel forbids mutating a
            // published snapshot, so the buckets live here and only the ACTIVE one is copied
            // into the state cell.
            const buckets = new Map<string, TurnRow[]>();
            /** turnId -> the transcript row currently showing that turn's answer. */
            const rowsByTurn = new Map<string, string>();
            /** `${sessionId}::${agent}` -> that conversation, opened once per Title. */
            const threadsByAgent = new Map<string, string>();
            /** One running turn per Title — what Stop addresses. */
            const activeTurns = new Map<string, { turnId: string; rowId: string; threadId: string }>();
            let sessionId = '';
            let sequence = 0;
            let disposed = false;

            const nextAt = (): number => {
                sequence += 1;

                // Wall clock plus a counter: two rows created in the same millisecond still
                // order deterministically, which is what a transcript needs.
                return Date.now() + sequence / 1000;
            };

            const bucketOf = (session: string): TurnRow[] => buckets.get(session) ?? [];

            /** Publishes one Title's rows; the cell only ever holds THAT Title's transcript. */
            const paint = (session: string): void => {
                if (disposed || session !== sessionId) return;
                transcript.set([...bucketOf(session)]);
            };

            const appendRows = (session: string, ...rows: TurnRow[]): void => {
                if (disposed) return;
                buckets.set(session, [...bucketOf(session), ...rows]);
                paint(session);
            };

            const patchRow = (session: string, rowId: string, patch: Partial<TurnRow>): void => {
                if (disposed) return;
                buckets.set(
                    session,
                    bucketOf(session).map((row) => (row.id === rowId ? { ...row, ...patch } : row)),
                );
                paint(session);
            };

            /**
             * The agent a turn belongs to: the thread it was posted on (the roster's own
             * answer), else the roster the server published on the turn. A threadless flow
             * naming one of our three agents still resolves; anything else reads as ''.
             */
            const agentOfTurn = (threadId: string | undefined, activeAgents: readonly string[] | undefined): StorylineAgent | '' => {
                if (threadId !== undefined && threadId.length > 0) {
                    for (const option of AGENT_OPTIONS) {
                        if (roster()[option.key]?.id === threadId) return option.key;
                    }
                }

                const named = (activeAgents ?? []).map(asAgent).filter((key): key is StorylineAgent => key !== '');

                return named.length === 1 ? named[0] as StorylineAgent : '';
            };

            /**
             * Replace a row's text with the server's committed answer. Only a terminal row or
             * an empty one is overwritten: mid-flight, the live fold is AHEAD of a display
             * read that started earlier, and clobbering it backwards makes the answer flicker.
             */
            const settle = async (session: string, rowId: string, turnId: string, target: StorylineAgent | ''): Promise<void> => {
                if (disposed || session.length === 0) return;

                let text: string;

                try {
                    text = await server.readTurnText(session, turnId, target === '' ? undefined : target);
                } catch {
                    // A failed canonical read keeps the streamed fold on screen: it is the
                    // same answer minus whatever the read would have confirmed.
                    return;
                }

                if (disposed || text.length === 0 || session !== sessionId) return;

                const current = bucketOf(session).find((row) => row.id === rowId);

                if (current === undefined) return;
                if (!isTerminal(current.phase) && current.text.length > 0) return;

                patchRow(session, rowId, { text });
            };

            // A new Title is a new conversation: point at its bucket, and drop the per-Title
            // maps that would otherwise address the previous Title's threads.
            api.on<TitlesActiveEvent>(TITLES_ACTIVE_EVENT, ({ sessionId: next }) => {
                sessionId = next;
                rowsByTurn.clear();
                activeTurns.clear();
                paint(next);
            });

            api.on<StreamTextEvent>(STREAM_TEXT_EVENT, ({ turnId, text }) => {
                const rowId = rowsByTurn.get(turnId);

                if (rowId === undefined) return;

                const session = sessionId;
                const current = bucketOf(session).find((row) => row.id === rowId);

                if (current === undefined || isTerminal(current.phase)) return;

                // `onText` carries the ACCUMULATED answer (src/api/stream.ts), so this is an
                // assignment, never an append — an append would double every delta.
                patchRow(session, rowId, { text, phase: 'running' });
            });

            api.on<StreamTurnEvent>(STREAM_TURN_EVENT, ({ turn }) => {
                const session = sessionId;
                const phase = phaseOfTurnStatus(turn.status);
                let rowId = rowsByTurn.get(turn.id);

                if (rowId === undefined) {
                    // A turn this UI did not start: the story pipeline (or another tab). It
                    // gets a row the moment it appears, marked as not ours.
                    const created = openRow(session, agentOfTurn(turn.threadId, turn.activeAgents), 'agent', '', nextAt(), true);

                    rowId = created.id;
                    rowsByTurn.set(turn.id, rowId);
                    buckets.set(session, [...bucketOf(session), { ...created, turnId: turn.id, phase }]);
                    paint(session);
                } else {
                    // Attribution is re-derived on every frame instead of being frozen at the
                    // first one: a row created before the roster recognised its thread (the
                    // `thread.upsert` can arrive after the `turn.upsert`) gets its agent here.
                    const attributed = agentOfTurn(turn.threadId, turn.activeAgents);

                    patchRow(session, rowId, attributed === '' ? { phase, turnId: turn.id } : { phase, turnId: turn.id, agent: attributed });
                }

                // A row that opened on this thread belongs to it, so the panel can follow it.
                const owner = activeTurns.get(session);

                if (owner !== undefined && owner.turnId === turn.id) activeTurns.set(session, { ...owner, threadId: turn.threadId ?? owner.threadId });

                if (!isTerminal(phase)) return;

                if (owner !== undefined && owner.turnId === turn.id) activeTurns.delete(session);
                api.emit<TurnsFinishedEvent>(TURNS_FINISHED_EVENT, { turnId: turn.id, phase });
                void settle(session, rowId, turn.id, bucketOf(session).find((row) => row.id === rowId)?.agent ?? '');
            });

            /**
             * A CHAINED turn, made visible (R-K). The review chain hands the next agent its task
             * with `harness.sendThreadInput` (src/server/orchestrator.ts:421), which starts a run
             * inside a conversation but mints NO session turn — the store builds a turn row only
             * around its own submit route (harness src/server/sessions.ts:8098) — so no
             * `turn.upsert`, no display document and no `onText` delta ever arrives for a chained
             * answer. The conversation itself is the only record of it, and the agents plugin has
             * just read it (plugins/agents.ts); this handler turns what grew into transcript rows.
             *
             * Two rules keep the panel honest:
             *   - ONE row per conversation entry, keyed by the thread and the entry's absolute
             *     position, so a re-read (a resync, a second `records.updated`) cannot append the
             *     same prose twice;
             *   - a sentence the panel is ALREADY showing under the same role is not added a
             *     second time. A user turn that commits records announces its own prompt and
             *     answer through this same conversation read, and both are on screen already as
             *     the composer's rows. Skipping is the only thing that happens here — a chain
             *     entry can never replace or remove a row the turn path wrote, so the worst case
             *     is a repeated sentence appearing once.
             */
            api.on<AgentsActivityEvent>(AGENTS_ACTIVITY_EVENT, ({ agent, threadId, messages }) => {
                const session = sessionId;

                if (session.length === 0) return;

                const bucket = bucketOf(session);
                const rows: TurnRow[] = [];

                for (const message of messages) {
                    const role = roleOfEntry(message.role);
                    const id = `chain-row-${threadId}-${message.position}`;

                    if (bucket.some((row) => row.id === id) || rows.some((row) => row.id === id)) continue;

                    // `shownFor` is the role the SAME sentence wears when the turn path wrote it:
                    // an operator's prompt is a `user` row here and a `user` entry in the
                    // conversation, while a chained prompt has no turn-path row at all.
                    const shownFor = role === 'system' ? 'user' : 'agent';

                    if (bucket.some((row) => row.role === shownFor && sameText(row.text, message.text))) continue;

                    rows.push({
                        id,
                        // No turn id, on purpose: there is no turn to open, and every consumer
                        // that distinguishes "ours" from "the pipeline's" reads exactly this field.
                        turnId: '',
                        sessionId: session,
                        agent,
                        role,
                        // Recorded prose, not a live fold: the conversation is where the server
                        // keeps it, and it cannot still be streaming when it was read from there.
                        phase: 'done',
                        text: message.text,
                        triggered: true,
                        at: nextAt()
                    });
                }

                if (rows.length === 0) return;

                appendRows(session, ...rows);
            });

            api.on<StreamResyncEvent>(STREAM_RESYNC_EVENT, ({ turnId }) => {
                if (turnId === undefined) return;
                const rowId = rowsByTurn.get(turnId);

                if (rowId === undefined) return;
                // Dropped frames mean the fold is missing text, not that the run failed: the
                // canonical display is the bounded, correct recovery.
                void settle(sessionId, rowId, turnId, bucketOf(sessionId).find((row) => row.id === rowId)?.agent ?? '');
            });

            // Following an agent in the roster makes it the composer's target: reading a
            // thread and writing into it is one gesture, not two pickers.
            api.on<AgentsSelectEvent>(AGENTS_SELECT_EVENT, ({ agent: picked }) => {
                agent.set(picked);
                composer.set((previous) => ({ ...previous, agent: picked }));
            });

            api.command<StorylineAgent, StorylineAgent>(TURNS_SELECT_AGENT_COMMAND, (key) => {
                agent.set(key);
                composer.set((previous) => ({ ...previous, agent: key }));

                return key;
            });

            api.command<string, ComposerDraft>(TURNS_UPDATE_COMMAND, (text) => {
                composer.set({ agent: agent.get(), text: text ?? '' });

                return composer.get();
            });

            api.command<string, Promise<readonly TurnRow[]>>(TURNS_SEND_COMMAND, async (text) => {
                const body = (text ?? '').trim();
                const key = agent.get();

                if (body.length === 0) return transcript.get();
                if (activeTurns.has(sessionId)) throw new Error('An agent is already answering this Title — stop it first.');

                const session = sessionId;
                const at = nextAt();
                const question = openRow(session, key, 'user', body, at, false);
                const answer = openRow(session, key, 'agent', '', at, false);

                // The rows land BEFORE the request: the composer must show what it sent even
                // if the submit fails, and a failed send is then an errored row rather than a
                // vanished message.
                appendRows(session, question, answer);
                composer.set({ agent: key, text: '' });

                try {
                    // A Title is picked, not created, by the composer: this resolves the active
                    // one and is a no-op once one is active (plugins/titles.ts).
                    const activeSession = await titles.ensureActive();
                    const threadKey = `${activeSession}::${key}`;
                    const threadId = threadsByAgent.get(threadKey) ?? (await server.openThread(activeSession, key));

                    threadsByAgent.set(threadKey, threadId);

                    const receipt = await server.submit(activeSession, threadId, body);
                    const turnId = receipt.turnId;

                    rowsByTurn.set(turnId, answer.id);
                    activeTurns.set(activeSession, { turnId, rowId: answer.id, threadId: receipt.threadId || threadId });

                    patchRow(activeSession, answer.id, { turnId, phase: 'running', agent: key });

                    // Deltas ride the TURN scope only, so the subscription opens as soon as the
                    // id exists; the canonical read below closes the window between the submit
                    // and that subscription.
                    titles.followTurn(turnId);
                    api.emit<TurnsSentEvent>(TURNS_SENT_EVENT, { turnId, agent: key, rowId: answer.id });

                    void settle(activeSession, answer.id, turnId, key);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);

                    patchRow(session, answer.id, { phase: 'error', text: message });
                    activeTurns.delete(session);
                }

                return transcript.get();
            });

            api.command<void, Promise<boolean>>(TURNS_STOP_COMMAND, async () => {
                const running = activeTurns.get(sessionId);

                if (running === undefined) return false;

                const { turnId, rowId, threadId } = running;

                try {
                    await server.stop(sessionId, threadId);
                } catch {
                    // Already finished server-side: the terminal `turn.upsert` still arrives,
                    // and stopping a finished run is not an error worth showing.
                }

                // The row is left OPEN on purpose. If the server did stop the run, a
                // `turn.upsert(cancelled)` lands and closes it; if it had already finished,
                // the real terminal state wins over a guess made here.
                patchRow(sessionId, rowId, { phase: 'queued', turnId });

                return true;
            });

            api.slot<PanelValue>(PANEL_SLOT, {
                id: TRANSCRIPT_PANEL,
                order: PANEL_ORDERS.transcript,
                value: { title: 'Conversation', region: 'composer', hint: 'this Title only', component: TranscriptPanel }
            });

            api.slot<PanelValue>(PANEL_SLOT, {
                id: COMPOSER_PANEL,
                order: PANEL_ORDERS.composer,
                value: { title: 'Composer', region: 'composer', component: ComposerPanel }
            });

            return () => {
                disposed = true;
                rowsByTurn.clear();
                activeTurns.clear();
            };
        }
    };
}
