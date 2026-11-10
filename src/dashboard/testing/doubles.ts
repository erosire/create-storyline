// Test doubles for the two network seams, shared by every dashboard test.
//
// WHY A SHARED MODULE: the app touches the network in exactly two places — the
// `StorylineApi` facade (injected as `storyline.api`) and the stream socket (injected
// as `streamFactory`) — so ONE pair of doubles is enough to run the whole composition
// with no server, and every plugin test then asserts the path a click actually takes.
// The precedent is the kernel's own example app (`example/src/testing/workbench.ts`).
//
// THE FIXTURES ARE THE STORY these tests read: two Titles (newest first), a store with
// one section in each document store, one chapter whose body only the tool read can
// answer with, and one host thread per agent — the rows the harness would answer with
// for the `'storyline'` harness.
import type {
    ChapterDetail,
    ChapterRow,
    ProfileRow,
    SectionRow,
    StorylineApi,
    StorylineRecords,
    StorylineThreadMessage,
    StorylineThreadMessages,
    TitleRow
} from '../../api';
import type { StorylineStreamEvents, StreamStatus } from '../../api/stream';
import type { StorylineThreadRef } from '../../api';
import { createStoryline, type StorylineOptions } from '../composition';
import type { StreamFactory, TitlesStreamHandle } from '../plugins/titles';

/** The newest Title the server lists — what a cold page opens. */
export const TITLE_NEW: TitleRow = {
    id: 'ses-new',
    title: 'Fog on the water',
    label: 'Fog on the water',
    createdAt: 2_000,
    updatedAt: 2_100,
    status: 'idle',
    turnCount: 3,
    threadCount: 1
};

/** The older Title, and the one a persisted id may point at. */
export const TITLE_OLD: TitleRow = {
    id: 'ses-old',
    title: '',
    label: 'Untitled 2',
    createdAt: 1_000,
    updatedAt: 1_100,
    status: 'running',
    turnCount: 1,
    threadCount: 0
};

export const CHAPTER_ROW: ChapterRow = { id: 'ch-1', rev: 4, title: 'The crossing', summary: 'The cartographer sails', status: 'draft', order: 1 };

/** The body only the `chapters` tool's `get` can answer with (`content` is getOnly). */
export const CHAPTER_BODY: ChapterDetail = { ...CHAPTER_ROW, content: 'She counted the buoys twice.' };

export const PROFILE_ROW: ProfileRow = { id: 'p-1', rev: 2, name: 'Ada', description: 'Cartographer', traits: ['female', 'proud'], notes: 'leads' };

export const OUTLINE_ROW: SectionRow = { id: 'o-1', rev: 1, order: 1, heading: 'Opening', content: 'Fog, then a harbour.', hasContent: true };

export const STORY_ROW: SectionRow = { id: 's-1', rev: 1, order: 1, heading: 'Chapter one', content: 'She woke before dawn.', hasContent: true };

/** The snapshot every read resolves to, with all four documents present. */
export const RECORDS: StorylineRecords = {
    sessionId: 'ses-new',
    storeRev: 12,
    chapters: [CHAPTER_ROW],
    profiles: [PROFILE_ROW],
    outlines: [OUTLINE_ROW],
    storyline: [STORY_ROW],
    hasChapters: true,
    hasProfiles: true,
    hasOutlines: true,
    hasStoryline: true
};

/** One host thread per agent: the roster the harness answers with mid-story. */
export const THREADS: StorylineThreadRef[] = [
    { id: 'thread-writer', agent: 'writer', origin: 'host', status: 'running', sequence: 7, ownerThreadId: '', label: 'storyline:writer', messageCount: 9, transcriptState: 'ok' },
    { id: 'thread-reader', agent: 'reader', origin: 'host', status: 'idle', sequence: 3, ownerThreadId: '', label: 'storyline:reader', messageCount: 2, transcriptState: 'ok' },
    { id: 'thread-editor', agent: 'editor', origin: 'host', status: 'idle', sequence: 1, ownerThreadId: '', label: 'storyline:editor', messageCount: 0, transcriptState: 'ok' }
];

/**
 * One conversation read: EMPTY unless a test says otherwise. The preview read exists to
 * show a CHAINED turn, and a suite that is not testing the chain must not see a sentence
 * no server wrote — so the default answer is a conversation with no prose in it, and a
 * chain test supplies its own entries.
 */
export const threadMessagesFor = (sessionId: string, threadId: string, messages: StorylineThreadMessage[] = []): StorylineThreadMessages => ({
    sessionId,
    threadId,
    agent: threadId.replace(/^thread-/, ''),
    total: messages.length,
    state: 'ok',
    truncated: false,
    messages
});

/**
 * The route label each recorded call puts in `calls`, spelled out per route because the
 * label IS the assertion: `readRecords:ses-new` names the Title the read addressed and
 * `setChapterStatus:ch-1:4:draft` names the rev the CAS write carried. The session id is
 * left out of the calls whose thread or record id already names the target.
 */
const ROUTE_LABELS: { [key in keyof StorylineApi]?: (args: unknown[]) => string } = {
    listTitles: () => 'listTitles',
    createTitle: ([name]) => `createTitle:${name ?? ''}`,
    renameTitle: ([id, name]) => `renameTitle:${id}:${name}`,
    ensureCollections: ([sessionId]) => `ensureCollections:${sessionId}`,
    listThreads: ([sessionId]) => `listThreads:${sessionId}`,
    openThread: ([sessionId, agent]) => `openThread:${sessionId}:${agent}`,
    submit: ([sessionId, threadId, text]) => `submit:${threadId}:${text}`,
    stop: ([sessionId, threadId]) => `stop:${sessionId}:${threadId}`,
    // Names the conversation, because that is the whole question this read answers.
    readThreadMessages: ([sessionId, threadId]) => `readThreadMessages:${threadId}`,
    readRecords: ([sessionId]) => `readRecords:${sessionId}`,
    readChapter: ([sessionId, chapterId]) => `readChapter:${chapterId}`,
    setChapterStatus: ([sessionId, chapter, status]) => `setChapterStatus:${(chapter as { id: string; rev: number }).id}:${(chapter as { id: string; rev: number }).rev}:${status}`,
    readTurnText: ([sessionId, turnId, agent]) => `readTurnText:${turnId}:${agent ?? ''}`
};

/**
 * The REST seam, doubled. `calls` records every route the plugins took, in order.
 *
 * WHY THE WRAPPER: a test replaces a method to control timing or an outcome (a
 * `readRecords` that never settles, a `listTitles` that rejects). Recording inside the
 * default body would then lose that route from the sequence, so the recorder wraps
 * whichever implementation ends up in place — overrides change the ANSWER, never the
 * observability. `root`/`socketUrl` are not recorded: they are reads of a constant, and
 * counting them would put noise into every `toEqual` of a call sequence.
 */
export function fakeApi(overrides: Partial<StorylineApi> = {}): { api: StorylineApi; calls: string[] } {
    const calls: string[] = [];

    const impl: StorylineApi = {
        root: () => '/v1/storyline',
        socketUrl: () => 'ws://localhost:3000/v1/storyline/stream',
        listTitles: async () => [TITLE_NEW, TITLE_OLD],
        createTitle: async (name) => ({ id: 'ses-fresh', title: name, label: name === '' ? 'Untitled 1' : name, createdAt: 3_000, updatedAt: 3_000, status: 'idle', turnCount: 0, threadCount: 0 }),
        renameTitle: async (id, name) => ({ ...TITLE_NEW, id, title: name, label: name, updatedAt: 4_000 }),
        ensureCollections: async (sessionId) => ({ sessionId, results: [{ name: 'outlines', state: 'defined', error: '' }, { name: 'storyline', state: 'exists', error: '' }] }),
        // One host thread per agent: what the harness answers with mid-story, so the
        // agents panel and the thread-reuse rule both have rows to work with.
        listThreads: async () => THREADS,
        // Agent targeting: a submit carries a threadId, never an agent (harness
        // src/frontend/api.ts:1470), so the conversation IS the targeting.
        openThread: async (sessionId, agent) => `thread-${agent}`,
        submit: async (sessionId, threadId, text) => ({ turnId: 'turn-1', threadId }),
        stop: async () => undefined,
        // A conversation with nothing in it, until a test gives it a chained exchange.
        readThreadMessages: async (sessionId, threadId) => threadMessagesFor(sessionId, threadId),
        readRecords: async (sessionId) => ({ ...RECORDS, sessionId }),
        readChapter: async () => CHAPTER_BODY,
        setChapterStatus: async (sessionId, chapter, status) => ({ ...CHAPTER_ROW, rev: chapter.rev + 1, status }),
        readTurnText: async () => 'the committed answer',
        ...overrides
    };

    // The recorder is installed BY KEY, which TypeScript can only check against the
    // INTERSECTION of every route's signature — so the map is an untyped record and the
    // cast happens once, at the end. Key safety lives in `ROUTE_LABELS` above: a route
    // missing there is a route nobody can assert on, and `undefinedLabel` fails loudly.
    const wrapped: Record<string, unknown> = { ...impl };

    for (const key of Object.keys(ROUTE_LABELS) as (keyof StorylineApi)[]) {
        const label = ROUTE_LABELS[key] as (args: unknown[]) => string;

        wrapped[key] = (...args: unknown[]): unknown => {
            calls.push(label(args));

            return (impl[key] as (...values: unknown[]) => unknown)(...args);
        };
    }

    return { api: wrapped as unknown as StorylineApi, calls };
}

/** The socket seam, doubled: records the lifecycle and keeps the events object. */
export function fakeStream() {
    const handle: TitlesStreamHandle & { connectCalls: number; closeReasons: (string | undefined)[]; followed: string[]; state: StreamStatus } = {
        connectCalls: 0,
        closeReasons: [],
        followed: [],
        state: 'idle',
        connect() {
            this.connectCalls += 1;
            this.state = 'open';
        },
        close(reason) {
            this.closeReasons.push(reason);
            this.state = 'closed';
        },
        followTurn(turnId) {
            this.followed.push(turnId);
        },
        status() {
            return this.state;
        }
    };

    const captured: { sessionIds: string[]; events: StorylineStreamEvents | null } = { sessionIds: [], events: null };
    const streamFactory: StreamFactory = (sessionId, events) => {
        captured.sessionIds.push(sessionId);
        captured.events = events;

        return handle;
    };

    return { handle, captured, streamFactory };
}

/**
 * One assembled dashboard plus every double a test needs to poke. `storageKey: ''` by
 * default, so a test never inherits an active Title from the one before it.
 */
export function buildStoryline(options: { api?: Partial<StorylineApi> } & Omit<StorylineOptions, 'api'> = {}) {
    const { api, calls } = fakeApi(options.api);
    const { handle, captured, streamFactory } = fakeStream();

    const instance = createStoryline({
        api,
        streamFactory,
        // '' disables localStorage resume, so a test never inherits an active Title from
        // the one before it — unless the test passes its own key on purpose.
        storageKey: options.storageKey ?? '',
        ...('agent' in options ? { agent: options.agent } : {}),
        ...('theme' in options ? { theme: options.theme } : {})
    });

    /** Lets every fire-and-forget read started by an event settle. */
    const flush = async () => {
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
    };

    /** The captured stream's event object — how a test pushes a live frame. */
    const stream = (): StorylineStreamEvents => captured.events as StorylineStreamEvents;

    return { instance, api, calls, handle, captured, streamFactory, flush, stream };
}
