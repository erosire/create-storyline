// The storyline workstation's id vocabulary — the shared contract every plugin,
// component and test imports, and the only place these ids are spelled.
//
// WHY ONE MODULE: plugins register against these ids, the shell and panes read
// them back through the same constants, and tests assert the same ones. A rename
// is a one-line change that every consumer typechecks, and no plugin ever has to
// import another plugin (which is how a dashboard grows without import cycles).
//
// The whole vocabulary is `storyline.`-prefixed — the reserved namespace of this
// composition — because the state/service/command/event id space is GLOBAL inside
// one dashboard(): an unqualified `session.id` would collide with any future
// plugin that ships its own session concept.
//
// THE UI IS STORY-FIRST: a Title is the unit of work, so the ids below speak of
// titles, not sessions or harnesses. The harness session is an implementation
// detail of a Title (one session per Title, always built from the `'storyline'`
// harness — see src/api/storyline.ts), and nothing here mentions presets,
// harnesses, primary agents or subagents.
//
// Modelled on the two precedents in this repo:
//   - packages/underload/dashboard/example/src/app/contract.ts (the kernel's own
//     worked example: slots, contribution shapes, service facades, plugin ids);
//   - distribution/chat-assistant/src/dashboard/contract.ts (the same discipline
//     against a real harness server).
import type { ComponentType } from 'react';
import type {
    ChapterDetail,
    StorylineAgent,
    StorylineApi,
    StorylineRecords,
    StorylineThreadMessage,
    StorylineThreadRef,
    TitleRow
} from '../api';
import type { HarnessSectionFrame, HarnessTurnFrame, StreamResyncReason, StreamStatus } from '../api/stream';

// ——— Slot names ———————————————————————————————————————————————————————————————
// Open channels the shell maps over. Adding a capability means contributing to
// one; the shell has no feature list to edit.

/** Every titled region card the shell renders, in `order`. */
export const PANEL_SLOT = 'storyline.panels';

/** The live chips in the top strip. */
export const STATUS_SLOT = 'storyline.status';

/** One slot contribution exactly as `instance.slot<T>(name)` returns it. */
export type Contribution<T> = { id: string; order: number; value: T };

// ——— Regions and contributions (layout vocabulary) —————————————————————————————

/**
 * The four workbench areas: the Title tree, the document it points at, the agents
 * working on it, and the composer that talks to them.
 */
export type RegionId = 'tree' | 'center' | 'agents' | 'composer';

/** One area, published by the layout plugin (`storyline.layout.regions`). */
export type RegionSpec = { id: RegionId; label: string; order: number };

/** Brand metadata, published by the layout plugin (`storyline.layout.brand`). */
export type BrandSpec = { name: string; tagline: string; notice: string };

/** What the shell must render for one PANEL_SLOT contribution. */
export type PanelValue = {
    title: string;
    region: RegionId;
    /** Short right-aligned caption in the panel header (a count, a status). */
    hint?: string;
    component: ComponentType;
};

/** One STATUS_SLOT contribution. */
export type StatusValue = { label: string; component: ComponentType };

// ——— Title vocabulary (one Title = one story session) ——————————————————————————

/**
 * The lifecycle of the Title REGISTRY. `loading` covers both the first read and a
 * manual refresh, because the tree keeps showing what it already had either way.
 */
export type TitlesPhase = 'idle' | 'loading' | 'ready' | 'error';

export type TitlesState = { phase: TitlesPhase; error: string; rows: readonly TitleRow[] };

export const EMPTY_TITLES: TitlesState = { phase: 'idle', error: '', rows: [] };

/**
 * One agent row of the agents panel. `phase` is the human-readable thing the agent
 * is doing right now; it is always a label derived from a published fact (a display
 * section state, a turn, a thread status) and never an invented stage machine.
 */
export type AgentRow = {
    agent: StorylineAgent;
    /** The thread label the server carries, else the agent key. */
    label: string;
    /** The conversation this agent answers on; '' until one exists. */
    threadId: string;
    /** `ThreadSummary.status`, or 'missing' when the agent has no thread yet. */
    threadStatus: StorylineThreadRef['status'] | 'missing';
    /** The turn this agent is busy with, '' when it is idle. */
    workingTurnId: string;
    /** What the composer's Send button will do for this agent. */
    phase: string;
    /** Sections this agent has written, newest last — the tree's agent marks. */
    sectionIds: readonly string[];
    /** Message count from the roster; 0 when the roster has not answered yet. */
    messageCount: number;
    /**
     * The last sentence this conversation holds, read from its transcript
     * (`api.readThreadMessages`) and truncated for a card. '' when nothing has been read
     * or the conversation has no prose in it. This is the part of a CHAINED turn the turn
     * stream can never show: a `sendThreadInput` run mints no session turn, so the only
     * place its prose exists is the conversation itself.
     */
    lastActivity: string;
    /** Who wrote `lastActivity` — `user` is the chain's task, `agent` is the answer. */
    lastAuthor: 'user' | 'agent' | '';
};

/** The agents panel's whole view: three equal targets, always all three. */
export type AgentsState = { phase: TitlesPhase; error: string; rows: readonly AgentRow[] };

export const EMPTY_AGENTS: AgentsState = { phase: 'idle', error: '', rows: [] };

/** One row of the agent selector: the fixed contract's keys plus what the picker shows. */
export type AgentOption = { key: StorylineAgent; label: string; hint: string };

/**
 * Every agent the composer can address (fixed contract). All three are equal task
 * targets: no primary, no subagent, no ranking — the harness team decides who answers.
 */
export const AGENT_OPTIONS: readonly AgentOption[] = [
    { key: 'writer', label: 'Writer', hint: 'Writes the prose' },
    { key: 'reader', label: 'Reader', hint: 'Reads for pace and continuity' },
    { key: 'editor', label: 'Editor', hint: 'Tightens scenes and profiles' }
];

/** The agent a fresh composer starts on. */
export const DEFAULT_AGENT: StorylineAgent = 'writer';

// ——— Center pane (document) vocabulary —————————————————————————————————————————

/** The four documents a Title owns; the center pane shows exactly one at a time. */
export type ContentKind = 'outlines' | 'chapters' | 'profiles' | 'storyline';

/**
 * What the center pane is showing. `id: ''` means the whole document; a chapter id
 * means that chapter's body, which the list read cannot carry (content is getOnly).
 */
export type ContentSelection = { kind: ContentKind; id: string };

export const DEFAULT_CONTENT: ContentSelection = { kind: 'outlines', id: '' };

/**
 * Labels the tree and the center pane share, so a document is named the same place twice.
 * `chapters` reads "Plotlines" because that is the word this product uses for the sequence of
 * chapters (the server's collection is still `chapters`, and every row inside it is still a
 * Chapter — this is the one document NAME, not a rename of the data). ONE source: a pane that
 * rendered the raw collection key would give one document two names.
 */
export const CONTENT_LABELS: Record<ContentKind, string> = {
    outlines: 'Outlines',
    chapters: 'Plotlines',
    profiles: 'Profiles',
    storyline: 'Storyline'
};

/**
 * The four documents, in the order both the tree's groups and the center pane's tabs
 * show them. ONE list, so the two halves of the workstation cannot drift apart.
 */
export const CENTER_TABS: readonly ContentKind[] = ['outlines', 'chapters', 'profiles', 'storyline'];

export type ContentPhase = 'idle' | 'loading' | 'ready' | 'error';

/** `storyline.content.detail`: the selected chapter plus its body (the one read a list cannot do). */
export type ChapterDetailState = { chapter: ChapterDetail | null; phase: ContentPhase; error: string };

export const EMPTY_CHAPTER_DETAIL: ChapterDetailState = { chapter: null, phase: 'idle', error: '' };

/**
 * `storyline.chapters.write`: the outcome of the LAST chapter status write, keyed to the
 * chapter it addressed. That write is CAS-guarded, so it can be REFUSED — an agent edited the
 * chapter between the snapshot read this pane clicked on and the click itself — and the
 * engine's own stale sentence is the only thing that explains a chip that did not move. It
 * lives in a cell the tree reads rather than in a rejected promise, because the click that
 * started the write has no caller left to handle one (`void setStatus(...)`, StoryTree.tsx).
 */
export type ChapterWriteResult = { chapterId: string; error: string };

export const EMPTY_CHAPTER_WRITE: ChapterWriteResult = { chapterId: '', error: '' };

// ——— Record-store vocabulary ————————————————————————————————————————————————————

/** The refresh state of the record store behind the tree and the center pane. */
export type RecordsPhase = 'idle' | 'loading' | 'ready' | 'error';

export type RecordsState = { phase: RecordsPhase; error: string; data: StorylineRecords };

/** The empty store, so every pane has one shared "nothing yet" description. */
export const EMPTY_RECORDS: StorylineRecords = {
    sessionId: '',
    storeRev: 0,
    chapters: [],
    profiles: [],
    outlines: [],
    storyline: [],
    hasChapters: false,
    hasProfiles: false,
    hasOutlines: false,
    hasStoryline: false
};

// ——— Agent turn surface —————————————————————————————————————————————————————————

/**
 * One line of the transcript: a question the operator sent, an agent's answer, or the
 * prompt the server's review chain put into an agent's conversation.
 *
 * `system` is the third kind and it is not a decoration: a chained turn is delivered by
 * posting a task INTO the agent's conversation (src/server/orchestrator.ts), so the
 * conversation holds a prompt nobody typed. Showing it as `user` would credit the
 * operator with a sentence they never wrote.
 */
export type TurnRole = 'user' | 'agent' | 'system';

/** Mirrors the harness turn states, plus `queued` for a row with no receipt yet. */
export type TurnPhase = 'queued' | 'running' | 'done' | 'error' | 'cancelled' | 'stopped';

export type TurnRow = {
    id: string;
    /** The harness turn id; '' until the submit's receipt lands. */
    turnId: string;
    /** The Title this row belongs to — the transcript is per Title, never global. */
    sessionId: string;
    /** '' when the turn's agent is not one of this UI's three (a threadless flow). */
    agent: StorylineAgent | '';
    role: TurnRole;
    phase: TurnPhase;
    text: string;
    /** True when the story pipeline started this turn, not the composer. */
    triggered: boolean;
    /** Wall-clock ms, for stable ordering only — never parsed back into a date. */
    at: number;
};

/** The composer's draft plus the agent it will be sent to. */
export type ComposerDraft = { agent: StorylineAgent; text: string };

// ——— Stream vocabulary ————————————————————————————————————————————————————————————

// The wire/stream types the views and plugins need, re-exported so a component has
// exactly ONE module to import its vocabulary from. `isolatedModules`-safe: these
// are type-only re-exports, and the api module remains their only declaration. The
// names imported above are re-exported as a LOCAL group (a name may appear in only
// one export clause), so a view still gets every type from `./contract` alone.
export type { StreamStatus, StreamResyncReason } from '../api/stream';
export type { ChapterRow, ChapterStatus, ProfileRow, SectionRow } from '../api';
export type { ChapterDetail, StorylineAgent, StorylineRecords, StorylineThreadMessage, StorylineThreadRef, TitleRow };

/** Value of `storyline.stream.state`: the observation's lifecycle, mirrored from the socket. */
export type StreamState = { status: StreamStatus; error: string };

/** What an agent's display sections can say about itself (harness turn-display.ts:195). */
export type SectionDisplayState = 'open' | 'streaming' | 'done' | 'error' | 'cancelled';

/** The one place a section state becomes a word an operator reads. */
export const SECTION_PHASE_LABELS: Record<SectionDisplayState, string> = {
    open: 'planning',
    streaming: 'writing',
    done: 'done',
    error: 'failed',
    cancelled: 'stopped'
};

// ——— Theme vocabulary —————————————————————————————————————————————————————————————

/** 'ink' is the dark workstation skin, 'paper' the light one. */
export type ThemeMode = 'ink' | 'paper';

/** Semantic palette published by the theme plugin (`storyline.theme.palette`). */
export type ThemePalette = Record<ThemeMode, { accent: string }>;

// ——— Service facades (the cross-plugin dependency surface) ———————————————————————
// Plugins talk to each other through these, never through the dashboard instance;
// `requires` guarantees the producer's setup() ran first.

/**
 * `storyline.api` — the server seam (see src/api/storyline.ts). An ALIAS, not a
 * hand-copied shape: the api module owns the contract and this file only names it,
 * so a new method is one change in one place.
 */
export type StorylineApiService = StorylineApi;

/**
 * `storyline.titles.api` — the Title registry's read side. `activeId()` is the one
 * session id every other plugin addresses, and it is '' before the first Title is
 * chosen, which is the honest answer rather than a created session.
 */
export type TitlesService = {
    /** The active Title's session id ('' before the first Title is picked). */
    activeId(): string;
    /** Pick a Title if needed and make sure its stream is open; shared, idempotent. */
    ensureActive(): Promise<string>;
    /**
     * Follow one turn's delta scope on the shared socket. The stream client opens
     * the session scope only, and harness deltas ride the TURN scope, so a sender
     * that learns a turn id has to ask for it here — the titles plugin owns the one
     * connection and nobody else may touch it.
     */
    followTurn(turnId: string): void;
};

/**
 * `storyline.agents.roster` — the agent -> thread rows the agents plugin last read.
 * A function, not a value, because the roster changes; a consumer calls it at the
 * moment it needs an answer (turns.ts uses it to label a turn it did not start).
 */
export type RosterService = () => Partial<Record<StorylineAgent, StorylineThreadRef>>;

// ——— State ids ————————————————————————————————————————————————————————————————————

export const TITLES_STATE = 'storyline.titles.state';
export const TITLES_ACTIVE_STATE = 'storyline.titles.active';
export const STREAM_STATE = 'storyline.stream.state';
export const RECORDS_STATE = 'storyline.records.state';

export const CONTENT_SELECT_STATE = 'storyline.content.selection';
export const CONTENT_DETAIL_STATE = 'storyline.content.detail';
export const CHAPTER_WRITE_STATE = 'storyline.chapters.write';

export const AGENTS_STATE = 'storyline.agents.state';
export const AGENTS_ROSTER_SERVICE = 'storyline.agents.roster';

export const TURNS_AGENT_STATE = 'storyline.turns.agent';
export const TURNS_TRANSCRIPT_STATE = 'storyline.turns.transcript';
export const TURNS_COMPOSER_STATE = 'storyline.turns.composer';

export const THEME_MODE_STATE = 'storyline.theme.mode';

// ——— Service ids ——————————————————————————————————————————————————————————————————

export const API_SERVICE = 'storyline.api';
export const LAYOUT_BRAND_SERVICE = 'storyline.layout.brand';
export const LAYOUT_REGIONS_SERVICE = 'storyline.layout.regions';
export const TITLES_SERVICE = 'storyline.titles.api';
export const THEME_PALETTE_SERVICE = 'storyline.theme.palette';

// ——— Command ids ——————————————————————————————————————————————————————————————————

export const TITLES_REFRESH_COMMAND = 'storyline.titles.refresh';
export const TITLES_CREATE_COMMAND = 'storyline.titles.create';
export const TITLES_RENAME_COMMAND = 'storyline.titles.rename';
export const TITLES_SELECT_COMMAND = 'storyline.titles.select';

export const RECORDS_REFRESH_COMMAND = 'storyline.records.refresh';

export const CONTENT_SELECT_COMMAND = 'storyline.content.select';
export const CONTENT_REFRESH_COMMAND = 'storyline.content.refresh';
export const CHAPTER_STATUS_COMMAND = 'storyline.chapters.status';

export const AGENTS_SELECT_COMMAND = 'storyline.agents.select';

export const TURNS_SELECT_AGENT_COMMAND = 'storyline.turns.selectAgent';
export const TURNS_UPDATE_COMMAND = 'storyline.turns.update';
export const TURNS_SEND_COMMAND = 'storyline.turns.send';
export const TURNS_STOP_COMMAND = 'storyline.turns.stop';

export const THEME_TOGGLE_COMMAND = 'storyline.theme.toggle';

// ——— Event ids and payloads ———————————————————————————————————————————————————————
// The stream is the ONLY producer of most of these, and the titles plugin is that
// producer: one socket, many listeners. Events are live signals (the kernel queues
// nothing), so a view that mounts late must read `state(id).get()` for the truth.

export const TITLES_READY_EVENT = 'storyline.titles.ready';
export const TITLES_ACTIVE_EVENT = 'storyline.titles.active';
export const TITLES_FAILED_EVENT = 'storyline.titles.failed';

export const STREAM_STATUS_EVENT = 'storyline.stream.status';
export const STREAM_TURN_EVENT = 'storyline.stream.turn';
export const STREAM_TEXT_EVENT = 'storyline.stream.text';
export const STREAM_THREAD_EVENT = 'storyline.stream.thread';
export const STREAM_SECTION_EVENT = 'storyline.stream.section';
export const STREAM_RECORDS_EVENT = 'storyline.stream.records';
export const STREAM_RESYNC_EVENT = 'storyline.stream.resync';

export const AGENTS_SELECT_EVENT = 'storyline.agents.selected';

/**
 * `storyline.agents.activity` — one agent's conversation gained entries this page had not
 * announced yet (plugins/agents.ts). It is how a CHAINED turn reaches the transcript: a
 * chained run posts into a conversation and writes its transcript, but it mints no session
 * turn, so no `turn.upsert` and no display document ever arrive for it. The roster's
 * `message_count` moving under a `records.updated` frame is the only live fact that says
 * prose exists, and this event carries the prose itself.
 */
export const AGENTS_ACTIVITY_EVENT = 'storyline.agents.activity';

export const TURNS_SENT_EVENT = 'storyline.turns.sent';
export const TURNS_FINISHED_EVENT = 'storyline.turns.finished';

export type TitlesReadyEvent = { count: number };
export type TitlesActiveEvent = { sessionId: string; label: string };
export type TitlesFailedEvent = { message: string };
export type StreamStatusEvent = { status: StreamStatus; error?: string };
export type StreamTurnEvent = { turn: HarnessTurnFrame };
export type StreamTextEvent = { turnId: string; text: string };
export type StreamThreadEvent = { thread: StorylineThreadRef };
export type StreamSectionEvent = { section: HarnessSectionFrame };
export type StreamRecordsEvent = { storeRev: number; collectionsRev: number };
export type StreamResyncEvent = { reason: StreamResyncReason; turnId?: string };
export type AgentsSelectEvent = { agent: StorylineAgent; threadId: string };
export type AgentsActivityEvent = { agent: StorylineAgent; threadId: string; messages: readonly StorylineThreadMessage[] };
export type TurnsSentEvent = { turnId: string; agent: StorylineAgent; rowId: string };
export type TurnsFinishedEvent = { turnId: string; phase: TurnPhase };

// ——— Panel and chip ids (the placement the slot order decides) ——————————————————

export const TREE_PANEL = 'storyline.tree';
export const CENTER_PANEL = 'storyline.center';
export const AGENTS_PANEL = 'storyline.agents';
export const TRANSCRIPT_PANEL = 'storyline.transcript';
export const COMPOSER_PANEL = 'storyline.composer';

export const BRAND_CHIP = 'storyline.brand';
export const TITLE_CHIP = 'storyline.title.chip';
export const STREAM_CHIP = 'storyline.stream.chip';
export const THEME_CHIP = 'storyline.theme.chip';

/**
 * Slot orders. Orders are compared WITHIN a region (the shell groups contributions
 * by `region` first), so each number below is position inside its own area:
 * tree · center · agents · [transcript over composer] in the bottom strip.
 */
export const PANEL_ORDERS = { tree: 10, center: 20, agents: 10, transcript: 10, composer: 20 } as const;
export const STATUS_ORDERS = { brand: 10, title: 20, stream: 30, theme: 90 } as const;

// ——— Plugin ids (also the expected value of `instance.plugins`) ———————————————————

export const PLUGIN_IDS = {
    layout: 'storyline.layout',
    theme: 'storyline.theme',
    api: 'storyline.api',
    titles: 'storyline.titles',
    records: 'storyline.records',
    content: 'storyline.content',
    agents: 'storyline.agents',
    turns: 'storyline.turns'
} as const;

/** The setup order the composition declares, and the order the core validates. */
export const PLUGIN_ORDER: readonly string[] = [
    PLUGIN_IDS.layout,
    PLUGIN_IDS.theme,
    PLUGIN_IDS.api,
    PLUGIN_IDS.titles,
    PLUGIN_IDS.records,
    PLUGIN_IDS.content,
    PLUGIN_IDS.agents,
    PLUGIN_IDS.turns
];
