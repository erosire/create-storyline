// The agents plugin: what writer, reader and editor are doing to this Title right now.
//
// THREE EQUAL TARGETS, ALWAYS ALL THREE (fixed contract): the panel is a roster, not
// a picker — no primary agent, no subagent, no ranking. The harness team behind the
// `'storyline'` harness decides which of the three answers a task; this UI only shows
// what each of them is busy with.
//
// WHERE EACH FACT COMES FROM — nothing here is invented:
//   • the thread a agent answers on, and its status: `GET .../threads` (the roster)
//     plus every `thread.upsert` frame, which is the same snake_case row (the two are
//     projected by ONE mapper, `threadFrameFromRow`, so the live view can never
//     disagree with the REST read it re-does on a reconnect);
//   • the phase word: the agent's own DISPLAY SECTIONS (`section:open` / `section:set`),
//     whose state is `open | streaming | done | error | cancelled` (harness
//     src/shared/turn-display.ts:195). That is the only "phase" the contract states, so
//     the panel labels THAT (via `SECTION_PHASE_LABELS`) instead of inventing a stage
//     machine the server cannot back up;
//   • the turn it is on: a turn row whose `threadId` is that thread, or whose published
//     `activeAgents` names that agent — the two attribution signals the wire carries.
//     A turn with neither is left unattributed rather than guessed at;
//   • the last sentence it holds: that conversation's transcript entries, read over REST
//     (`api.readThreadMessages`, src/api/storyline.ts). This is the part a CHAINED turn
//     cannot publish any other way: the review chain hands the next agent its task with
//     `harness.sendThreadInput` (src/server/orchestrator.ts:421), which starts a run but
//     mints NO session turn — the store wraps a run in a turn only inside its own submit
//     route (harness src/server/sessions.ts:8098) — so there is no `turn.upsert`, no
//     display document and no transcript row for a chained answer. What DOES grow is the
//     conversation and the record store, and both are visible here: the roster's
//     `message_count` and the session-wide `records.updated` frame
//     (harness src/server/sessions.ts:2282). Reading the conversation is therefore the
//     only way this workstation can show the chained prose, and announcing what grew is
//     how the transcript gets it (contract.ts `AGENTS_ACTIVITY_EVENT`).
//
// THE TWO CUES THAT READ A CONVERSATION, and why one is not enough. `records.updated` is
// the chain's loudest footprint (a chained hop exists BECAUSE it wrote a record) and it is
// what makes the posted TASK appear early. But the store publishes it synchronously inside
// the committed tool call (harness src/server/sessions.ts:2262-2296) — always BEFORE that
// run's final answer is appended (src/harness.ts:9811) — so on that cue alone the answer
// waits for the next record write from ANYWHERE in the session, and the last hop of the
// shipped chain (the reader, instructed to change nothing, src/server/presets.ts) never
// produces one at all: its prompt and its critique stay invisible until the operator acts.
// `thread.upsert` carries the roster's `message_count`, and that row moving is the frame
// that says the conversation grew, so the panel also re-reads a conversation when the count
// it last read goes up (see the `STREAM_THREAD_EVENT` handler). Neither cue is optional:
// one shows the task, the other shows the answer.
//
// WHY DELEGATED CHILDREN ARE SKIPPED (the T11 fix): a conversation a `delegate` call
// opened is itself `origin: 'host'` and carries `owner_thread_id` (harness
// src/types/index.ts:2430), and it is newer than the agent's own conversation — so a
// roster rule that ranked only `origin` and `sequence` handed the card, the composer and
// the transcript over to somebody else's work in progress. The server's chain refuses those
// rows for the same reason (`storylineTargetThread`, src/server/orchestrator.ts:244) and
// so does `selectAgentThread` (src/api/storyline.ts): one rule, three consumers.
//
// WHY THE ROSTER IS STILL READ OVER REST: a session scope publishes `thread.upsert`,
// but only for threads that change while this page watches. A page that opens on a
// story already underway would otherwise show three agents doing nothing, so the
// roster read on activation (and after a resync, where frames were demonstrably lost)
// is what makes the panel complete.
import type { DashboardPlugin, DashboardPluginAPI } from '@underload/dashboard';
import type { StorylineThreadMessage } from '../../api';
import type { HarnessSectionFrame, HarnessTurnFrame, StorylineThreadRef } from '../../api/stream';
import {
    AGENTS_ACTIVITY_EVENT,
    AGENTS_PANEL,
    AGENTS_ROSTER_SERVICE,
    AGENTS_SELECT_COMMAND,
    AGENTS_SELECT_EVENT,
    AGENT_OPTIONS,
    API_SERVICE,
    EMPTY_AGENTS,
    PANEL_ORDERS,
    PANEL_SLOT,
    PLUGIN_IDS,
    SECTION_PHASE_LABELS,
    STREAM_RECORDS_EVENT,
    STREAM_RESYNC_EVENT,
    STREAM_SECTION_EVENT,
    STREAM_STATUS_EVENT,
    STREAM_THREAD_EVENT,
    STREAM_TURN_EVENT,
    TITLES_ACTIVE_EVENT,
    TITLES_SERVICE,
    AGENTS_STATE,
    type AgentsActivityEvent,
    type AgentRow,
    type AgentsState,
    type AgentsSelectEvent,
    type PanelValue,
    type RosterService,
    type SectionDisplayState,
    type StorylineAgent,
    type StreamRecordsEvent,
    type StreamResyncEvent,
    type StreamSectionEvent,
    type StreamStatusEvent,
    type StreamThreadEvent,
    type StreamTurnEvent,
    type TitlesActiveEvent,
    type TitlesService,
    type StorylineApiService
} from '../contract';
import { AgentsPanel } from '../components/AgentsPanel';

// ——— derivation (pure; the rules an operator reads, testable without a runtime) ———

/** The live facts one agent's row is derived from. */
export type AgentFacts = {
    /** Thread rows for the active Title, newest read wins (keyed by agent). */
    threads: Partial<Record<StorylineAgent, StorylineThreadRef>>;
    /** Every display section this page has seen, newest state each (keyed by section id). */
    sections: Record<string, HarnessSectionFrame>;
    /** Turn rows this page has seen, newest state each (keyed by turn id). */
    turns: Record<string, HarnessTurnFrame>;
    /** The newest prose entry of each agent's conversation, from that conversation's read. */
    activity: Partial<Record<StorylineAgent, StorylineThreadMessage>>;
};

/** The turn states that still expect traffic. */
const WORKING_TURN = ['queued', 'running'];

/** The section states that mean "this agent is mid-sentence". */
const LIVE_SECTION: readonly SectionDisplayState[] = ['open', 'streaming'];

/** True for the section states that name live work. */
const isLiveSection = (state: string): state is SectionDisplayState => LIVE_SECTION.includes(state as SectionDisplayState);

/**
 * How much of an agent's last sentence a card carries. The whole text is one click away
 * in the transcript, so the card's job is to identify the message, not to reproduce it.
 */
const ACTIVITY_PREVIEW_LIMIT = 140;

/** One line of prose: collapsed whitespace, bounded, with the ellipsis the bound implies. */
const previewOf = (text: string): string => {
    const collapsed = text.replace(/\s+/g, ' ').trim();

    return collapsed.length <= ACTIVITY_PREVIEW_LIMIT ? collapsed : `${collapsed.slice(0, ACTIVITY_PREVIEW_LIMIT - 1)}…`;
};

/**
 * One thread per agent out of a roster page: the agent's own HOST conversation wins (that
 * is the conversation the story runs on), and within the same origin the highest `sequence`
 * wins, because `sequence` is the only ordering the contract gives a thread row. An
 * agent-spawned thread still beats no thread at all — it is where that agent's output
 * lands, and the transcript the panel points at is that one.
 *
 * A row that carries an OWNER is skipped outright, host or not: it is a conversation
 * somebody else's turn opened (a `delegate` child), and pointing the card, the composer or
 * the conversation read at it shows one agent's work under another agent's name. An agent
 * whose only conversation is a delegated one honestly reads as "no thread yet".
 */
export function rosterByAgent(threads: readonly StorylineThreadRef[]): Partial<Record<StorylineAgent, StorylineThreadRef>> {
    const out: Partial<Record<StorylineAgent, StorylineThreadRef>> = {};
    const ranks: Partial<Record<StorylineAgent, number>> = {};

    for (const thread of threads) {
        const agent = thread.agent as StorylineAgent;

        if (!AGENT_OPTIONS.some((option) => option.key === agent)) continue;
        if (thread.ownerThreadId.length > 0) continue;

        // Origin first, then sequence: the offset only has to outrank any plausible
        // sequence, so a host thread always wins over an agent-spawned one.
        const rank = (thread.origin === 'host' ? 1_000_000 : 0) + thread.sequence;

        if (ranks[agent] === undefined || rank > (ranks[agent] as number)) {
            ranks[agent] = rank;
            out[agent] = thread;
        }
    }

    return out;
}

/** The turn this agent is busy with: by thread first, by the published roster second. */
function workingTurnOf(agent: StorylineAgent, threadId: string, facts: AgentFacts): string {
    let found = '';
    let best = -1;

    for (const turn of Object.values(facts.turns)) {
        if (!WORKING_TURN.includes(turn.status)) continue;

        const attributed = (threadId.length > 0 && turn.threadId === threadId) || turn.activeAgents?.includes(agent) === true;

        if (!attributed) continue;
        // `updatedAt` is a wall clock; `index` breaks a tie inside one session's history.
        const rank = turn.updatedAt * 1000 + turn.index;

        if (rank > best) {
            best = rank;
            found = turn.id;
        }
    }

    return found;
}

/** The sections this agent has written, oldest first — the tree's per-agent marks. */
function sectionsOf(agent: StorylineAgent, facts: AgentFacts): string[] {
    return Object.keys(facts.sections).filter((id) => facts.sections[id]?.agent === agent);
}

/**
 * The whole roster fold: one row per declared agent, in the fixed order, each one
 * labelled by a published fact. An agent with no thread reads as `missing` with an
 * empty phase — which is the truth before the story has asked anything of it.
 */
export function agentRowsFor(facts: AgentFacts): AgentRow[] {
    return AGENT_OPTIONS.map((option) => {
        const agent = option.key;
        const thread = facts.threads[agent];
        const threadId = thread?.id ?? '';
        const activity = facts.activity?.[agent];
        const owned = sectionsOf(agent, facts);
        const live = owned.filter((id) => isLiveSection(facts.sections[id]?.state ?? ''));
        const turn = workingTurnOf(agent, threadId, facts);

        // Phase precedence: the live section (the most specific thing the agent itself
        // published) → a working turn with no section yet (it is answering, that is all the
        // wire says) → the last section's failure, which must not vanish behind a thread
        // that has already gone back to idle → the thread's own status → "no thread".
        const phaseOf = (): string => {
            const newest = owned.length > 0 ? (owned as string[])[owned.length - 1] : undefined;
            const liveState = live.length > 0 ? facts.sections[live[live.length - 1] as string]?.state : undefined;

            if (liveState !== undefined && isLiveSection(liveState)) return SECTION_PHASE_LABELS[liveState];
            if (turn.length > 0) return SECTION_PHASE_LABELS.streaming;

            const lastState = newest === undefined ? undefined : facts.sections[newest]?.state;

            if (lastState === 'error' || lastState === 'cancelled') return SECTION_PHASE_LABELS[lastState];
            if (thread === undefined) return 'no thread yet';

            return thread.status === '' ? 'idle' : thread.status;
        };

        return {
            agent,
            // A thread's own label is what the server calls this conversation; the agent
            // key is the fallback until one exists.
            label: thread?.label ?? '',
            threadId,
            threadStatus: thread?.status ?? 'missing',
            workingTurnId: turn,
            phase: phaseOf(),
            sectionIds: owned,
            messageCount: thread?.messageCount ?? 0,
            // The conversation's newest sentence, read from the conversation itself — the
            // only chained prose this page can show (see the header).
            lastActivity: activity === undefined ? '' : previewOf(activity.text),
            lastAuthor: activity?.role ?? ''
        };
    });
}

// ——— the plugin —————————————————————————————————————————————————————————————————

export function createAgentsPlugin(): DashboardPlugin {
    return {
        id: PLUGIN_IDS.agents,
        requires: [PLUGIN_IDS.api, PLUGIN_IDS.titles],

        setup(api: DashboardPluginAPI): () => void {
            const server = api.getService<StorylineApiService>(API_SERVICE);
            const titles = api.getService<TitlesService>(TITLES_SERVICE);
            const state = api.state<AgentsState>(AGENTS_STATE, EMPTY_AGENTS);

            const facts: AgentFacts = { threads: {}, sections: {}, turns: {}, activity: {} };
            let disposed = false;
            let reading = false;
            /** A roster signal that arrived while one read was in flight: ask once more after it. */
            let reread = false;

            /**
             * Roster `message_count` per agent, as of the last conversation read. A count that
             * has not moved cannot hold a new sentence, which is what keeps a burst of
             * `records.updated` frames (one per committed record call) from paging transcripts
             * that have not changed.
             */
            const counts: Partial<Record<StorylineAgent, number>> = {};
            /** thread id -> the newest transcript position already announced. */
            const announced = new Map<string, number>();
            let readingActivity = false;
            let activityAgain = false;

            /** Republishes the fold. The kernel needs a NEW value, so every write is fresh. */
            const publish = (phase: AgentsState['phase'] = 'ready', error = ''): void => {
                if (disposed) return;
                state.set({ phase, error, rows: agentRowsFor(facts) });
            };

            /** Forgets every conversation fact — what a Title change owes the next Title. */
            const forgetActivity = (): void => {
                facts.activity = {};
                announced.clear();

                for (const key of Object.keys(counts) as StorylineAgent[]) delete counts[key];
            };

            /** Re-reads the roster for the active Title; a reply for a left Title is dropped. */
            const readRoster = (): Promise<void> => {
                const sessionId = titles.activeId();

                if (disposed || sessionId.length === 0) return Promise.resolve();
                // One read at a time: activation, a resync, a status flip and a record frame
                // can all ask at once. A signal that lands during one is answered by exactly
                // one more read, so a burst of frames cannot be missed and cannot loop.
                if (reading) {
                    reread = true;

                    return Promise.resolve();
                }

                reading = true;

                return server.listThreads(sessionId).then(
                    async (threads) => {
                        reading = false;
                        if (disposed || titles.activeId() !== sessionId) return;
                        facts.threads = rosterByAgent(threads);
                        publish();

                        // The roster's counts are the only cue a chained turn leaves, so the
                        // conversation read hangs off this read and nowhere else.
                        await syncActivity();

                        if (reread) {
                            reread = false;
                            void readRoster();
                        }
                    },
                    (error: unknown) => {
                        reading = false;
                        if (disposed) return;
                        // Whatever the frames already established stays on screen; the
                        // sentence says the roster is the part that failed.
                        publish('error', error instanceof Error ? error.message : String(error));
                    },
                );
            };

            /**
             * Reads one agent's conversation: the newest sentence for its card, and the entries
             * this page has never announced as a live signal for the transcript.
             *
             * The FIRST read of a conversation is a seed, not an announcement. A page that
             * opens on a story already underway has nothing new to report, and replaying the
             * whole history as chain traffic would push the operator's own prompts back into
             * the transcript as if the pipeline had written them.
             */
            const readActivity = (agent: StorylineAgent): Promise<void> => {
                const sessionId = titles.activeId();
                const thread = facts.threads[agent];

                if (disposed || sessionId.length === 0 || thread === undefined) return Promise.resolve();

                return server.readThreadMessages(sessionId, thread.id).then(
                    (page) => {
                        if (disposed || titles.activeId() !== sessionId) return;

                        const newest = page.messages.length > 0 ? page.messages[page.messages.length - 1] : undefined;
                        const seen = announced.get(thread.id);

                        if (newest === undefined) delete facts.activity[agent];
                        else facts.activity[agent] = newest;

                        // Spelled AFTER a successful read, so a conversation this page could not
                        // read stays due for the next signal instead of going quiet forever.
                        counts[agent] = thread.messageCount;

                        if (seen === undefined) {
                            announced.set(thread.id, newest === undefined ? -1 : newest.position);
                            publish();

                            return;
                        }

                        const fresh = page.messages.filter((message) => message.position > seen);

                        if (fresh.length > 0) {
                            announced.set(thread.id, (fresh[fresh.length - 1] as StorylineThreadMessage).position);
                            api.emit<AgentsActivityEvent>(AGENTS_ACTIVITY_EVENT, { agent, threadId: thread.id, messages: fresh });
                        }

                        publish();
                    },
                    // A conversation this pane cannot read stays unlabelled: the roster row
                    // already states its message count, and a failed preview is not a failure
                    // of the roster. The panel that wants the text is the transcript, and it
                    // says its own error.
                    () => undefined,
                );
            };

            /**
             * Reads the conversations whose roster count moved. One batch at a time, because a
             * run commits records repeatedly and three parallel page-walks per commit is not
             * what a workstation browser should spend.
             */
            const syncActivity = (): Promise<void> => {
                if (disposed) return Promise.resolve();

                if (readingActivity) {
                    activityAgain = true;

                    return Promise.resolve();
                }

                const due = (Object.keys(facts.threads) as StorylineAgent[]).filter((agent) => {
                    const thread = facts.threads[agent];

                    if (thread === undefined) return false;

                    const known = counts[agent];

                    return known === undefined || thread.messageCount > known;
                });

                if (due.length === 0) return Promise.resolve();

                readingActivity = true;

                const settle = (): void => {
                    readingActivity = false;

                    if (activityAgain) {
                        activityAgain = false;
                        void syncActivity();
                    }
                };

                return due
                    .reduce((chain, agent) => chain.then(() => readActivity(agent)), Promise.resolve())
                    .then(settle, settle);
            };

            api.service<RosterService>(
                AGENTS_ROSTER_SERVICE,
                (): Partial<Record<StorylineAgent, StorylineThreadRef>> => ({ ...facts.threads }),
            );

            api.command<StorylineAgent, AgentsSelectEvent>(AGENTS_SELECT_COMMAND, (agent) => {
                const threadId = facts.threads[agent]?.id ?? '';
                const event: AgentsSelectEvent = { agent, threadId };

                // The composer follows the agent being inspected: reading a thread and
                // writing into it should be the same gesture, not two pickers.
                api.emit<AgentsSelectEvent>(AGENTS_SELECT_EVENT, event);

                return event;
            });

            api.slot<PanelValue>(PANEL_SLOT, {
                id: AGENTS_PANEL,
                order: PANEL_ORDERS.agents,
                value: { title: 'Agents', region: 'agents', hint: 'writer · reader · editor', component: AgentsPanel }
            });

            // A Title becoming active is a new set of conversations: drop what the previous
            // Title's agents were doing before reading the new ones.
            api.on<TitlesActiveEvent>(TITLES_ACTIVE_EVENT, () => {
                facts.threads = {};
                facts.sections = {};
                facts.turns = {};
                forgetActivity();
                void readRoster();
                publish('loading');
            });

            // `thread.upsert` is the live half of the roster; the REST read is the backfill.
            api.on<StreamThreadEvent>(STREAM_THREAD_EVENT, ({ thread }) => {
                const agent = thread.agent as StorylineAgent;

                if (!AGENT_OPTIONS.some((option) => option.key === agent)) return;

                // A DELEGATION CHILD is a conversation an agent spawned, not the one the
                // operator addresses. It arrives with the parent's agent key and `origin: 'host'`,
                // so only the delegation link tells them apart (`ownerThreadId`, projected at
                // src/api/stream.ts:277 from `ThreadSummary.owner_thread_id`), and its sequence is
                // always newer than the parent's. The roster read and the composer's reuse rule
                // both refuse these rows (plugins/agents.ts `rosterByAgent`,
                // src/api/storyline.ts `selectAgentThread`); refusing them here is what stops the
                // card, the follow target and the conversation read from drifting onto a child
                // the moment its frame lands — which is the drift this whole rule exists to stop.
                if (thread.ownerThreadId.length > 0) return;

                const previous = facts.threads[agent];

                // Frames arrive in order, so the newer row simply replaces the older one.
                if (previous !== undefined && previous.origin === 'host' && thread.origin !== 'host' && thread.sequence <= previous.sequence) return;

                facts.threads[agent] = thread;
                publish();

                // THE SECOND CUE, AND THE ONLY ONE THAT LANDS ON THE ANSWER. `records.updated` is
                // published SYNCHRONOUSLY inside the committed tool call (harness
                // src/server/sessions.ts:2262-2296), which is always BEFORE the run's final answer
                // is appended (src/harness.ts:9811), and a `sendThreadInput` run mints no session
                // turn at all — no `turn.upsert`, no `display.ops` (src/server/orchestrator.ts:62-65).
                // So the roster's `message_count` moving under this frame is the first live fact
                // this page can act on that says the prose exists: cueing the conversation read
                // here is what makes the answer appear when it is appended rather than on the next
                // record write anywhere in the session. It matters most for the LAST hop of the
                // shipped chain — the reader, told to change nothing (src/server/presets.ts) —
                // which never produces a record frame at all, so its prompt and its critique used
                // to stay invisible until the operator acted again.
                const known = counts[agent];

                if (known === undefined || thread.messageCount > known) void syncActivity();
            });

            api.on<StreamSectionEvent>(STREAM_SECTION_EVENT, ({ section }: StreamSectionEvent) => {
                if (section.sectionId.length === 0) return;
                facts.sections[section.sectionId] = section;
                publish();
            });

            api.on<StreamTurnEvent>(STREAM_TURN_EVENT, ({ turn }: StreamTurnEvent) => {
                if (turn.id.length === 0) return;
                facts.turns[turn.id] = turn;
                publish();
            });

            // An open socket or a dropped-frame resync means frames this panel would have
            // seen are gone: the roster read is the only complete picture again.
            api.on<StreamStatusEvent>(STREAM_STATUS_EVENT, ({ status }) => {
                if (status === 'open') void readRoster();
            });

            api.on<StreamResyncEvent>(STREAM_RESYNC_EVENT, (_event: StreamResyncEvent) => {
                void readRoster();
            });

            // THE CHAIN'S LOUDEST FOOTPRINT, and the cue for the TASK rather than the answer. The
            // review chain fires on a record write and nothing else (src/server/orchestrator.ts:473
            // -489), and the store publishes that write from a session-wide subscription whatever
            // path made it (harness src/server/sessions.ts:2262-2296) — so a chained turn always
            // arrives with `records.updated` and never with a turn row. Re-reading the roster is
            // the cheap half; the conversation read that follows it is what shows the prose the
            // record write already proves exists. It is NOT the whole story: the frame lands inside
            // the tool call, before the run's answer is appended, which is why the `thread.upsert`
            // handler above cues the same read a second time (see this file's header).
            //
            // `storeRev: 0` is skipped on purpose: that frame is not a server signal but the
            // titles plugin's synthetic "the collections were just defined, re-read the store"
            // marker (plugins/titles.ts:302), and a real frame always carries a positive
            // watermark. The roster was read when this Title was activated, so re-reading it for
            // a marker would cost a second read for nothing.
            api.on<StreamRecordsEvent>(STREAM_RECORDS_EVENT, ({ storeRev }) => {
                if (storeRev <= 0) return;
                void readRoster();
            });

            return () => {
                disposed = true;
            };
        }
    };
}

/** The section state type, re-exported so a test can name it without importing the api layer. */
export type { SectionDisplayState } from '../contract';
export type { HarnessSectionFrame, HarnessTurnFrame };
