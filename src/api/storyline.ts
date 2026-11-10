// The storyline REST layer — the ONLY module in this package that imports
// `@underload/harness/frontend`.
//
// THE MOUNT: './root' MUST be this file's first import. Its module body writes
// `__HARNESS_CONFIG__.apiRoot = '/v1/storyline'`, and the harness client resolves
// its root exactly once, while the client module is evaluated. ESM evaluates a
// module's dependencies in source order, so this import order IS the mount; no
// other file in the package imports the client, which keeps that rule checkable
// by eye. (Verified: with this order, `apiUrl('/v1/harness/sessions')` answers
// `/v1/storyline/sessions` and `streamSocketUrl()` answers
// `ws://<origin>/v1/storyline/stream`.)
//
// WHAT THIS LAYER IS: a thin facade over the harness package's own published
// browser client. Every request goes through that package's REST functions, which
// own URL building (against the mounted root), the client header, the
// `{error:{message}}` envelope and cursor paging. What THIS file adds is the
// story-specific part:
//
//   1. the projection from the harness WIRE vocabulary (snake_case resource rows
//      and the open-keyed `RecordEntryRow`s of the record store) onto the VIEW
//      MODEL the workstation renders (`TitleRow`, `ChapterRow`, `ProfileRow`,
//      `SectionRow`, `StorylineRecords`), including every normalization the wire
//      allows: a list read OMITS a `getOnly` chapter body, an optional `order` is
//      absent until written, `traits` defaults to [];
//   2. the multi-call assemblies the REST contract deliberately splits apart (the
//      paged title list, the idempotent collection ensure, per-agent conversation
//      threading, the document stitching the center pane shows);
//   3. the seam itself — `createStorylineApi()` returns a plain object, so the
//      dashboard composition runs on an injected fake and no plugin test needs a
//      server.
//
// TITLES ARE SESSIONS (R-F/R-J): one `SessionSummary` row is one Title, and this
// app always creates it from the ONE harness it ships (`STORYLINE_HARNESS_ID`).
// The old preset discovery is gone: the app knows its harness, so `GET
// /harnesses` has no place in the UI path, and `listSessions` is filtered by that
// harness name server-side (`PageQuery.harness`, harness src/frontend/api.ts:649).
//
// AGENT TARGETING (fixed contract: `writer` / `reader` / `editor`, no primary):
// the harness submit route takes NO agent field — `SubmitTaskInput` is exactly
// `{ input, attachments?, references?, threadId? }`. The agent is a property of the
// CONVERSATION: `POST /sessions/{id}/threads` takes
// `CreateSessionThreadRequest { agent, label?, owner_thread_id? }` (harness
// src/shared/harness-api.ts:1724), and a submit addressed to that thread runs as
// that agent. So this UI opens ONE host thread per agent key and addresses it
// explicitly — see `openThread`.
//
// TURN TEXT: `GET .../turns/{id}/display` answers ONE SECTION PER FLOW, and the
// projector stamps `role:'primary'` on a section only when it is the turn's root AND
// its agent is the session primary (harness src/server/turn-projector.ts:723). Since
// every agent here runs in its own host thread, the section that ANSWERS is identified
// by the agent key, not by the role: `readTurnText` therefore takes that key and
// resolves the section through the one shared rule in ./stream.ts, which the live
// display fold uses for the same turn.
//
// WHY THE WIRE TYPES LOOK THIN: the published `@underload/harness` package ships
// no `.d.ts` beside `dist/underload-harness.frontend.mjs`, so a typecheck of this
// package infers the client's signatures from JavaScript (parameters and returns
// degrade to `any`), even though the `development` condition serves real typed
// source to the dev server. Derived aliases (`Awaited<ReturnType<…>>`) cannot be
// trusted to be exact, so EVERY mapper below normalizes at RUNTIME instead of
// trusting a declared shape — which is also what makes this layer immune to a
// server that adds or trims a field.
import { STORYLINE_API_ROOT } from './root';
// The answer-section rule lives in ./stream.ts, next to the live display-op fold that
// needs it, so the REST read and the stream fold resolve ONE turn's answer the same
// way. The direction matters: importing the shared rule from ./stream.ts keeps this
// module the only one that touches the harness client, and gives the two planes no
// cycle ('./stream.ts' imports nothing from here).
import { answerSectionCandidates, threadFrameFromRow, type DisplaySectionShape, type StorylineThreadRef } from './stream';
import {
    cancelSessionThread,
    createSession,
    createSessionThread,
    executeSessionTool,
    getSessionRecords,
    getTurnDisplay,
    listSessions,
    listThreads,
    listTranscriptMessages,
    streamSocketUrl,
    submitTask,
    updateSession
} from '@underload/harness/frontend';

// ---------------------------------------------------------------------------
// Wire types (derived from the published client, never hand-duplicated)
// ---------------------------------------------------------------------------

/** The 202 answer of `POST {root}/sessions/{id}/tasks` (TaskReceipt). */
export type StorylineTaskReceipt = Awaited<ReturnType<typeof submitTask>>;
/** The body of `GET {root}/sessions/{id}/records` (RecordsSnapshotResponse). */
export type StorylineRecordsSnapshot = Awaited<ReturnType<typeof getSessionRecords>>;
/** The roster row both planes read (ThreadSummary) — declared in ./stream.ts. */
export type { StorylineThreadRef };

// ---------------------------------------------------------------------------
// The fixed vocabulary of this product
// ---------------------------------------------------------------------------

/**
 * The ONE harness every Title this UI creates is built from. The server-side preset
 * of the same name owns the `writer`/`reader`/`editor` team (src/server/presets.ts),
 * and the app never asks a catalogue which harness exists — that discovery round
 * trip was the harness-centric UI this redesign removes.
 */
export const STORYLINE_HARNESS_ID = 'storyline';

/** The agent keys this UI addresses (fixed contract — equal task targets). */
export const STORYLINE_AGENTS = ['writer', 'reader', 'editor'] as const;
export type StorylineAgent = (typeof STORYLINE_AGENTS)[number];

/** The fixed documents of the tree's left-hand sections; both are ordered section stores. */
export const STORYLINE_SECTION_COLLECTIONS = ['outlines', 'storyline'] as const;
export type StorylineSectionCollection = (typeof STORYLINE_SECTION_COLLECTIONS)[number];

/**
 * The field spec every section collection is `define`d with (records tool
 * `{define:{name,fields}}`, harness src/core/records.ts:3202). `order` is
 * `sortable`, which is what makes the store's OWN page order ascending
 * (records.ts:1881) instead of a client-side guess, and `content` is deliberately
 * NOT `getOnly`: a snapshot therefore carries the bodies and the center pane needs
 * one read per Title, not one per section (records.ts:3748 is the list projection
 * that would otherwise drop them).
 */
export const STORYLINE_SECTION_FIELDS = [
    { key: 'order', type: 'integer', sortable: true },
    { key: 'heading', type: 'text', maxLength: 200 },
    { key: 'content', type: 'text', maxLength: 4000 }
] as const;

/** The closed status enum of the built-in `chapters` collection (harness src/core/chapter.ts:51). */
export const CHAPTER_STATUSES = ['planned', 'draft', 'complete'] as const;
export type ChapterStatus = (typeof CHAPTER_STATUSES)[number];

/** `SessionStatus` (harness-api.ts:905) — the badge a Title row carries. */
export const TITLE_STATUSES = ['idle', 'running', 'error'] as const;
export type TitleStatus = (typeof TITLE_STATUSES)[number];

/** The error code a re-`define` answers with (records.ts:206 `collectionExists`). */
export const COLLECTION_EXISTS_CODE = 'collection-exists';

/** The largest page the harness contract allows (HARNESS_PAGE_LIMIT.max). */
const PAGE_LIMIT = 100;

/** Titles are paged, and a workstation with more than this many is a browsing problem, not a UI one. */
const MAX_TITLE_PAGES = 3;

/**
 * Pages one transcript read walks before it stops and says so. The read exists to show
 * the LAST exchange of one conversation, so walking a bounded number of pages from the
 * start is enough for any conversation this workstation shows, and a longer one is
 * reported as `truncated` rather than read without bound.
 */
const MAX_TRANSCRIPT_PAGES = 4;

// ---------------------------------------------------------------------------
// The view model the workstation renders
// ---------------------------------------------------------------------------

/**
 * One Title = one harness session (R-F). `title` is what the server stores (it can
 * be absent); `label` is what the tree renders, fallback included, so no view ever
 * has to invent a name.
 */
export type TitleRow = {
    id: string;
    /** The stored session title; '' when the server carries none. */
    title: string;
    /** `title`, or `Untitled N` — N is the row's position in created_at order. */
    label: string;
    createdAt: number;
    updatedAt: number;
    status: TitleStatus;
    turnCount: number;
    threadCount: number;
};

/**
 * One chapter WITHOUT its body. A list read never carries `content` — it is a
 * `getOnly` field (chapter.ts:49) — so "no body" and "this read does not show
 * bodies" are different facts, and that distinction lives in this type.
 */
export type ChapterRow = {
    id: string;
    /** The CAS token a guarded write sends back as `expects: [{id, rev}]`. */
    rev: number;
    title: string;
    summary: string;
    status: ChapterStatus;
    /** The ascending sort key; null means the chapter has no explicit position. */
    order: number | null;
};

/** One chapter plus its body — the `chapters` tool's `get` answer and nothing else. */
export type ChapterDetail = ChapterRow & { content: string };

/** One entry of the built-in `profiles` collection (harness src/core/profile.ts:34). */
export type ProfileRow = {
    id: string;
    rev: number;
    name: string;
    description: string;
    traits: string[];
    notes: string;
};

/**
 * One section of an `outlines`/`storyline` document. `hasContent` is the honest
 * answer to "did this read carry the body": a store whose collection was defined
 * with a `getOnly` body reads as `false`, and the center pane says so instead of
 * rendering a phantom empty section.
 */
export type SectionRow = {
    id: string;
    rev: number;
    order: number | null;
    heading: string;
    content: string;
    hasContent: boolean;
};

/** The normalized, panel-shaped view of one record-store snapshot. */
export type StorylineRecords = {
    sessionId: string;
    /** The store-wide watermark of this read — the cursor any later delta compares against. */
    storeRev: number;
    chapters: ChapterRow[];
    profiles: ProfileRow[];
    outlines: SectionRow[];
    storyline: SectionRow[];
    /** True when the snapshot named the collection at all — an unwritten story and an unbound collection are different facts. */
    hasChapters: boolean;
    hasProfiles: boolean;
    hasOutlines: boolean;
    hasStoryline: boolean;
};

/** One outcome of the idempotent collection ensure (never an exception — see `ensureCollections`). */
export type CollectionEnsure = { name: string; state: 'defined' | 'exists' | 'failed'; error: string };
export type CollectionEnsureReport = { sessionId: string; results: CollectionEnsure[] };

// ---------------------------------------------------------------------------
// Normalization: wire rows -> view model. Every function here is TOTAL: an
// unexpected value degrades to the documented default instead of throwing, and
// each one is pinned by ./storyline.test.ts.
// ---------------------------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

const asString = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const asNumberOrNull = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Number(value);

        return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
};

const asNumber = (value: unknown, fallback = 0): number => asNumberOrNull(value) ?? fallback;

/** An unknown status degrades to `planned`, the collection's own declared default. */
const asChapterStatus = (value: unknown): ChapterStatus =>
    (CHAPTER_STATUSES as readonly string[]).includes(asString(value)) ? (value as ChapterStatus) : 'planned';

/** An unknown session status degrades to `idle`, the row's own declared default. */
const asTitleStatus = (value: unknown): TitleStatus =>
    (TITLE_STATUSES as readonly string[]).includes(asString(value)) ? (value as TitleStatus) : 'idle';

/** `traits` is a trimmed, de-duplicated string array server-side; a non-array reads as []. */
const asStrings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/**
 * The one ordering rule the story uses for both ordered stores: rows that carry an
 * `order` come FIRST, ascending, and the rest keep insertion order — chapter.ts:11
 * calls it "a stable sort", and a `sortable` collection's page is already in that
 * order (records.ts:1881). Re-stating it client-side costs nothing and keeps the
 * tree's numbering honest if a read ever answers raw insertion order.
 */
export const sortByOrder = <T extends { order: number | null }>(rows: readonly T[]): T[] =>
    rows
        .map((row, index) => ({ row, index }))
        .sort((left, right) => {
            const leftOrder = left.row.order;
            const rightOrder = right.row.order;

            if (leftOrder === null && rightOrder === null) return left.index - right.index;
            if (leftOrder === null) return 1;
            if (rightOrder === null) return -1;
            if (leftOrder !== rightOrder) return leftOrder - rightOrder;

            return left.index - right.index;
        })
        .map((item) => item.row);

/** Chapters in store order, made explicit (see `sortByOrder`). */
export const sortChapters = (chapters: readonly ChapterRow[]): ChapterRow[] => sortByOrder(chapters);

/** Sections in store order, made explicit (see `sortByOrder`). */
export const sortSections = (sections: readonly SectionRow[]): SectionRow[] => sortByOrder(sections);

/** One `RecordEntryRow` of `chapters` -> `ChapterRow` (never a body — see ChapterRow). */
export const chapterFromEntry = (entry: unknown): ChapterRow => {
    const row = asRecord(entry);

    return {
        id: asString(row.id),
        rev: asNumber(row.rev),
        title: asString(row.title),
        summary: asString(row.summary),
        status: asChapterStatus(row.status),
        order: asNumberOrNull(row.order)
    };
};

/** One `RecordEntryRow` of `profiles` -> `ProfileRow`. */
export const profileFromEntry = (entry: unknown): ProfileRow => {
    const row = asRecord(entry);

    return {
        id: asString(row.id),
        rev: asNumber(row.rev),
        name: asString(row.name),
        description: asString(row.description),
        traits: asStrings(row.traits),
        notes: asString(row.notes)
    };
};

/** One `RecordEntryRow` of `outlines`/`storyline` -> `SectionRow`. */
export const sectionFromEntry = (entry: unknown): SectionRow => {
    const row = asRecord(entry);

    return {
        id: asString(row.id),
        rev: asNumber(row.rev),
        order: asNumberOrNull(row.order),
        heading: asString(row.heading),
        content: asString(row.content),
        hasContent: typeof row.content === 'string'
    };
};

/**
 * The `(F)` / `(M)` suffix the tree shows after a character name (fixed contract).
 * The `profiles` collection has NO gender field (harness src/core/profile.ts:34),
 * so the convention is a trait: `female`/`F` and `male`/`M`, matched
 * case-insensitively on the trimmed value. Anything else — including no trait at
 * all — reads as no suffix, which is the honest answer.
 */
export const genderOfTraits = (traits: readonly string[]): 'F' | 'M' | null => {
    for (const trait of traits) {
        const key = trait.trim().toLowerCase();

        if (key === 'female' || key === 'f') return 'F';
        if (key === 'male' || key === 'm') return 'M';
    }

    return null;
};

/** The tree's label for one character: `Kushina Uzumaki (F)`, or the bare name. */
export const profileLabel = (profile: Pick<ProfileRow, 'name' | 'traits'>): string => {
    const name = profile.name.trim().length > 0 ? profile.name.trim() : '(unnamed)';
    const gender = genderOfTraits(profile.traits);

    return gender === null ? name : `${name} (${gender})`;
};

/**
 * The ordered sections of one document, stitched into the text the center pane
 * shows. A section with a heading renders it on its own line above the body, so a
 * `#`-free document still reads as a list of parts; an empty section contributes
 * nothing rather than a blank block.
 */
export const documentTextOf = (sections: readonly SectionRow[]): string =>
    sections
        .map((section) => [section.heading.trim(), section.content.trim()].filter((part) => part.length > 0).join('\n'))
        .filter((block) => block.length > 0)
        .join('\n\n');

/** The one collection row with this name, or undefined when the store has none. */
export const findCollection = (snapshot: unknown, name: string): readonly unknown[] | undefined => {
    const collections = asRecord(snapshot).collections;
    if (!Array.isArray(collections)) return undefined;

    for (const collection of collections) {
        const row = asRecord(collection);
        if (asString(row.name) !== name) continue;

        return Array.isArray(row.entries) ? row.entries : [];
    }

    return undefined;
};

/**
 * `GET .../records` snapshot -> the workstation view. A missing collection is
 * REPORTED (`hasChapters`/`hasProfiles`/`hasOutlines`/`hasStoryline`) rather than
 * faked empty: a store that never had the section collections defined is a
 * different situation from an unwritten story, and the panes say so differently.
 */
export const recordsFromSnapshot = (snapshot: unknown): StorylineRecords => {
    const body = asRecord(snapshot);
    const chapters = findCollection(body, 'chapters');
    const profiles = findCollection(body, 'profiles');
    const outlines = findCollection(body, 'outlines');
    const storyline = findCollection(body, 'storyline');

    return {
        sessionId: asString(body.session_id),
        storeRev: asNumber(body.store_rev),
        chapters: sortChapters((chapters ?? []).map(chapterFromEntry)),
        profiles: (profiles ?? []).map(profileFromEntry),
        outlines: sortSections((outlines ?? []).map(sectionFromEntry)),
        storyline: sortSections((storyline ?? []).map(sectionFromEntry)),
        hasChapters: chapters !== undefined,
        hasProfiles: profiles !== undefined,
        hasOutlines: outlines !== undefined,
        hasStoryline: storyline !== undefined
    };
};

/**
 * One `SessionSummary` row -> one Title. `fallback` is the position used by the
 * `Untitled N` name, which the caller derives from created_at order — the row's
 * own `title` wins whenever the server carries one.
 */
export const titleRowFromSession = (row: unknown, fallback = 1): TitleRow => {
    const session = asRecord(row);
    const title = asString(session.title).trim();

    return {
        id: asString(session.id),
        title,
        label: title.length > 0 ? title : `Untitled ${fallback}`,
        createdAt: asNumber(session.created_at),
        updatedAt: asNumber(session.updated_at),
        status: asTitleStatus(session.status),
        turnCount: asNumber(session.turn_count),
        threadCount: asNumber(session.thread_count)
    };
};

/**
 * The whole (possibly paged) session list -> the tree's Titles. Newest first, so
 * the Title being worked on is at the top of a long list, and the fallback numbers
 * follow that same order. Rows without an id are dropped: nothing downstream can
 * address them.
 */
export const titleRowsFromPages = (pages: readonly unknown[]): TitleRow[] =>
    pages
        .flatMap((page) => asArray(asRecord(page).items))
        .map(asRecord)
        .filter((row) => asString(row.id).length > 0)
        .sort((left, right) => asNumber(right.created_at) - asNumber(left.created_at))
        .map((row, index) => titleRowFromSession(row, index + 1));

/** One thread roster row, projected to the fields both planes read (see ./stream.ts). */
export const threadRefsFromPage = (page: unknown): StorylineThreadRef[] => asArray(asRecord(page).items).map(threadFrameFromRow);

/**
 * Which of the roster's threads already holds this agent's conversation: the most
 * recently ACTIVE top-level host thread of that agent (highest `sequence`).
 *
 * TWO ROWS DISQUALIFY, and both mistakes are live ones:
 *   - `origin !== 'host'` — an agent-spawned subagent conversation is not this UI's
 *     composer surface, and addressing it would steer a subagent instead of the story;
 *   - `ownerThreadId` set — a conversation created BY a delegation. Verified against a
 *     running mount: `GET /threads` answers such a row with `owner_thread_id` (e.g.
 *     `{ id: 'thread-2', agent: 'reader', owner_thread_id: 'thread-1' }`, the child the
 *     writer's `delegate` tool opened), it is a HOST thread (`origin: 'host'`, harness
 *     src/types/index.ts:2430), and it is NEWER than the agent's own conversation — so
 *     `origin` plus `sequence` alone picked it and the composer started typing into
 *     somebody else's turn. The server's review chain already refuses those rows
 *     (`storylineTargetThread`, src/server/orchestrator.ts:244), so this rule IS the
 *     chain's rule: the chained answer lands in the conversation the composer addresses.
 */
export const selectAgentThread = (threads: readonly StorylineThreadRef[], agent: string): StorylineThreadRef | null => {
    const candidates = threads.filter((thread) => thread.agent === agent && thread.origin === 'host' && thread.ownerThreadId.length === 0);
    if (candidates.length === 0) return null;

    return candidates.reduce((best, thread) => (thread.sequence > best.sequence ? thread : best));
};

// ---------------------------------------------------------------------------
// The conversation read — the transcript entries of one agent thread
//
// WHY THIS READ EXISTS (R-K, the review chain made visible): a chained turn is delivered
// through `harness.sendThreadInput` (src/server/orchestrator.ts:421), which starts a RUN
// but not a session TURN — the store mints a turn only inside its own submit route
// (`POST /sessions/{id}/tasks`, harness src/server/sessions.ts:8098, the one place that
// wraps a run in `runContexts`). So a chained answer has no `turn.upsert`, no display
// document and no transcript row: the only frames it publishes are `records.updated`
// (the store's session-wide `onRecordsChange`, harness src/server/sessions.ts:2282) and
// the conversation's own entry in `GET /threads`. What DOES grow is the thread's
// transcript, which the runtime appends to for every run whatever started it — and
// `GET .../threads/{id}/transcript/messages` is its published read (harness
// src/frontend/api.ts:1407, the route `HARNESS_ROUTES.sessionsBySessionIdThreadsByThreadIdTranscriptMessages`).
// Reading it is therefore the only way this UI can show the chained prose at all.
// ---------------------------------------------------------------------------

/**
 * One entry of one conversation, projected for display. `position` is the entry's
 * absolute index in the transcript (the cursor the paging route addresses, and stable
 * because a conversation is append-only), which is what lets a caller tell "new since
 * the last read" from "the same entry again" without a per-message id the wire may omit.
 */
export type StorylineThreadMessage = {
    position: number;
    /** The runtime's own entry id when it carries one; '' when it does not. */
    messageId: string;
    /** The two entries a conversation exchange has: the prompt and the answer. */
    role: 'user' | 'agent';
    text: string;
};

/** One conversation read: the projected entries plus what the transcript as a whole holds. */
export type StorylineThreadMessages = {
    sessionId: string;
    threadId: string;
    /** The agent the conversation belongs to, from the read itself. */
    agent: string;
    /** Entries in the WHOLE transcript, including the ones this projection dropped. */
    total: number;
    /** `unreadable` is a state of the stored document, not of this read — it says the transcript cannot be shown at all. */
    state: 'ok' | 'unreadable' | '';
    /** True when the page bound was reached before the end: the read is the newest part, not the whole. */
    truncated: boolean;
    messages: StorylineThreadMessage[];
};

/**
 * Transcript entries -> the entries an operator reads. Total: never throws.
 *
 * Dropped, with reasons: a `system` entry is the seeded instruction (not conversation),
 * a `tool` entry is a call's bounded payload (the route's role enum is
 * `['system','user','assistant','tool']`, harness src/server/api.ts:4236, and a tool body
 * is capped at 65,536 bytes, src/frontend/api.ts:1404), and an `assistant` entry of a
 * tool-call turn carries no prose at all (`''` content beside `toolCalls`,
 * src/types/index.ts:202). `offset` is the absolute index of the first entry of this
 * page, because the route pages by TRANSCRIPT POSITION (api.ts:4250 — the cursor counts
 * served entries) and a caller comparing reads needs positions, not page-relative ones.
 */
export const threadMessagesFromEntries = (entries: readonly unknown[], offset = 0): StorylineThreadMessage[] => {
    const messages: StorylineThreadMessage[] = [];

    entries.forEach((item, index) => {
        const entry = asRecord(item);
        const role = asString(entry.role);

        if (role !== 'user' && role !== 'assistant') return;

        const text = asString(entry.content).trim();
        if (text.length === 0) return;

        messages.push({
            position: offset + index,
            messageId: asString(entry.messageId),
            role: role === 'assistant' ? 'agent' : 'user',
            text
        });
    });

    return messages;
};

/** The transcript state a read answers with; anything the contract does not state reads as ''. */
const asTranscriptState = (value: unknown): 'ok' | 'unreadable' | '' =>
    value === 'ok' || value === 'unreadable' ? value : '';

/**
 * Classifies one `define` failure. `collection-exists` is the expected answer on
 * every Title after the first (and the answer when the SERVER defines the
 * collection first — src/server/** may do exactly that), so it is a SUCCESS here,
 * never an error the UI shows.
 *
 * THE CODE RIDES IN THE MESSAGE ON THE WIRE (T10 seam fix). The records engine codes a
 * refusal three ways on the THROWN object — `error.name`, `error.code` and the first token
 * of `error.message` (harness src/core/records.ts:195-198) — but the tool-execution route
 * serializes a failure as the closed `{ ok: false, error: { message } }` envelope
 * (harness-api.ts:822-845), so over REST the ONLY surviving spelling is the message prefix:
 * verified live, re-`define`ing a collection the create hook already owns answers
 * `{"ok":false,"error":{"message":"collection-exists: A collection named \"outlines\" is
 * already defined; ..."}}` with no `code` field at all. Reading just `code` therefore
 * reported EVERY already-owned Title's two folders as a failed define, which the titles
 * plugin turns into its failure strip on every activation. All three spellings are checked,
 * the same rule ./../server/collections.ts:131 applies on the server side.
 */
export const ensureResultOf = (name: string, failure: unknown): CollectionEnsure => {
    const error = asRecord(failure);
    const sentence = asString(error.message);

    if (
        asString(error.code) === COLLECTION_EXISTS_CODE ||
        asString(error.name) === COLLECTION_EXISTS_CODE ||
        sentence.includes(COLLECTION_EXISTS_CODE)
    ) {
        return { name, state: 'exists', error: '' };
    }

    return { name, state: 'failed', error: sentence.length > 0 ? sentence : `the records tool refused to define ${name}` };
};

/**
 * A `ToolCallResult` is a DISCRIMINATED union and BOTH outcomes are HTTP 200, so
 * the only correct branch is `ok` (harness src/shared/harness-api.ts:822-845). A
 * failure becomes an Error carrying the server's own sentence, which is what the
 * pane shows in place of its rows.
 */
const unwrapToolResult = (result: unknown, label: string): unknown => {
    const body = asRecord(result);

    if (body.ok === false) {
        const error = asRecord(body.error);

        throw new Error(`${label}: ${asString(error.message, 'the tool call failed')}`);
    }

    return body.result;
};

/**
 * The `chapters` tool's `get` answer is `{ chapter, content, counts }`: every
 * `getOnly` field rides BESIDE the singular key, never inside it (harness
 * src/core/records.ts:3521). An entry with no body key stays `content: ''` here,
 * because the pane renders an empty body, not a phantom one.
 */
export const chapterDetailFromToolPayload = (payload: unknown): ChapterDetail | null => {
    const body = asRecord(payload);
    const entry = body.chapter ?? body.entry;
    if (entry === undefined) return null;

    const chapter = chapterFromEntry(entry);

    return { ...chapter, content: asString(body.content ?? asRecord(entry).content) };
};

/** The `{ chapter }` answer of one mutation, projected to a row. */
const rowFromToolPayload = <T>(payload: unknown, key: string, map: (entry: unknown) => T): T | null => {
    const entry = asRecord(payload)[key];

    return entry === undefined ? null : map(entry);
};

// ---------------------------------------------------------------------------
// The turn display read — the answering agent's committed prose
// ---------------------------------------------------------------------------

/** One `TurnSection` of the display document, projected to the fields the answer rule
 *  reads plus its node list. The display subtree keeps CAMELCASE on the wire (harness
 *  src/server/api-reads.ts:21) — unlike the snake_case resource rows above. */
type DisplaySectionRow = DisplaySectionShape & { id: string; nodes: unknown[] };

const displaySectionsOf = (display: unknown): DisplaySectionRow[] =>
    asArray(asRecord(display).sections).map((item, index) => {
        const row = asRecord(item);

        return {
            // `TurnSection.id` is `${turnId}:${ordinal}` and always present; a missing
            // id still gets a stable key so the answer rule can rank the section.
            id: asString(row.id, `section-${index}`),
            ...(typeof row.role === 'string' ? { role: row.role } : {}),
            ...(typeof row.agent === 'string' ? { agent: row.agent } : {}),
            ...(typeof row.parentSectionId === 'string' ? { parentSectionId: row.parentSectionId } : {}),
            nodes: asArray(row.nodes)
        };
    });

/** ONE section's committed prose: its `kind: 'text'` nodes, in document order. A
 *  `DisplayReasoningNode` (harness turn-display.ts:792) is a separate surface, a
 *  `DisplayStep` (:721) carries a bounded `preview` instead of prose, and a
 *  `DisplayNoticeNode` (:819) is a status line — none of them is the answer. */
const sectionText = (section: DisplaySectionRow): string => {
    const parts: string[] = [];

    for (const item of section.nodes) {
        const node = asRecord(item);
        if (asString(node.kind) !== 'text') continue;

        const text = asString(node.text);
        if (text.length === 0) continue;
        parts.push(text);
    }

    return parts.join('');
};

/**
 * The answer of one turn, out of the `GET .../turns/{id}/display` document.
 *
 * WHY THE HINT EXISTS: the projector stamps a section `role: 'primary'` only when it is
 * the turn's root AND its agent is the session primary (harness
 * `src/server/turn-projector.ts:723`, and the same test in `inlineSection` at :953).
 * This UI addresses every agent through its own host thread (see the header), so a
 * `reader` or `editor` run answers in a `subagent`-role ROOT section — and an
 * extraction keyed on `role === 'primary'` alone returned '' for two of the three
 * agents, leaving the transcript's `…` placeholder on screen forever.
 *
 * The candidate chain (`answerSectionCandidates`, ./stream.ts) resolves to exactly ONE
 * section, so a delegated child's report is never concatenated onto the answer and
 * never replaces it. '' is an honest answer: the caller keeps whatever the stream
 * already painted.
 */
export const turnTextFromDisplay = (display: unknown, agent?: string): string => {
    const sections = displaySectionsOf(display);

    for (const section of answerSectionCandidates(sections, {
        ...(agent === undefined ? {} : { agent }),
        hasText: (candidate) => sectionText(candidate).length > 0
    })) {
        const text = sectionText(section);
        if (text.length > 0) return text;
    }

    return '';
};

// ---------------------------------------------------------------------------
// The facade
// ---------------------------------------------------------------------------

/**
 * Everything a plugin may ask of the server. Deliberately a plain object of
 * functions: the dashboard composition injects it, so the composition test, the
 * pane tests and the stream wiring all run without a network, and this module's
 * real implementation is the only code in the package that reaches fetch.
 */
export type StorylineApi = {
    /** The mounted REST root this UI dials (`/v1/storyline`). */
    root(): string;
    /** The absolute WebSocket URL of the live stream (`harness.v1` subprotocol). */
    socketUrl(): string;

    /** `GET /sessions?harness=storyline` — every Title, newest first, fallback names applied. */
    listTitles(): Promise<TitleRow[]>;
    /** `POST /sessions` with harness `'storyline'`; an empty name sends NO title at all. */
    createTitle(name: string): Promise<TitleRow>;
    /** `PATCH /sessions/{id}` — rename a Title (an empty name clears it, so the fallback renders). */
    renameTitle(id: string, name: string): Promise<TitleRow | null>;

    /**
     * Idempotently `define`s the two section collections through the `records` tool.
     * NEVER rejects: `collection-exists` is success, and a store that refuses for
     * another reason (or is unreachable) is reported in the returned results, because
     * a Title whose outline cannot be created is still a Title the tree shows.
     */
    ensureCollections(sessionId: string): Promise<CollectionEnsureReport>;

    /** `GET /sessions/{id}/threads` — the roster the reuse rule and the agents panel read. */
    listThreads(sessionId: string): Promise<StorylineThreadRef[]>;
    /** `POST /sessions/{id}/threads` (or reuse) — the conversation that runs as `agent`. */
    openThread(sessionId: string, agent: StorylineAgent): Promise<string>;
    /** `POST /sessions/{id}/tasks` addressed at one agent's conversation. */
    submit(sessionId: string, threadId: string, text: string): Promise<{ turnId: string; threadId: string }>;
    /** `POST /sessions/{id}/threads/{id}/cancel` — stop one agent's run. */
    stop(sessionId: string, threadId: string): Promise<void>;

    /**
     * `GET /sessions/{id}/threads/{id}/transcript/messages` — what one conversation
     * actually contains, entry by entry. This is the read that makes a CHAINED turn
     * visible: a `sendThreadInput` run writes the transcript but mints no session turn,
     * so there is no `turn.upsert` and no display document to read (see the section
     * above `threadMessagesFromEntries` for the whole finding).
     */
    readThreadMessages(sessionId: string, threadId: string): Promise<StorylineThreadMessages>;

    /** `GET /sessions/{id}/records` — the whole bounded store, normalized for the tree and panes. */
    readRecords(sessionId: string): Promise<StorylineRecords>;
    /** `chapters` tool `get` — the only way to read a chapter body (content is getOnly). */
    readChapter(sessionId: string, chapterId: string): Promise<ChapterDetail | null>;
    /** `chapters` tool `update` with the CAS token the engine requires on an identified write. */
    setChapterStatus(sessionId: string, chapter: { id: string; rev: number }, status: ChapterStatus): Promise<ChapterRow | null>;

    /**
     * `GET /sessions/{id}/turns/{id}/display` — the canonical answer that settles a
     * streamed turn. `agent` is the key this UI addressed the turn to: the display
     * document is one section per flow, and only the hint says which flow ANSWERS (see
     * `turnTextFromDisplay`). Omit it and the root/primary flow still resolves.
     */
    readTurnText(sessionId: string, turnId: string, agent?: StorylineAgent): Promise<string>;
};

/**
 * Walks one conversation's paged transcript read and projects every entry it saw.
 *
 * Cursors on this plane are OPAQUE (`base64url(epoch.ordinal)`, harness
 * src/server/api-paging.ts:39) and a stale one answers 400, so the only way forward is the
 * `nextCursor` the previous page issued — there is no seek to the end. `MAX_TRANSCRIPT_PAGES`
 * bounds the walk: a caller displays the TAIL, and `truncated` is the honest sentence for a
 * transcript longer than the walk covered.
 */
const readTranscriptPages = async (sessionId: string, threadId: string): Promise<StorylineThreadMessages> => {
    const messages: StorylineThreadMessage[] = [];

    let cursor = '';
    let offset = 0;
    let pages = 0;
    let agent = '';
    let total = 0;
    let state: StorylineThreadMessages['state'] = '';

    while (pages < MAX_TRANSCRIPT_PAGES) {
        const page = asRecord(
            await listTranscriptMessages(sessionId, threadId, { limit: PAGE_LIMIT, ...(cursor.length === 0 ? {} : { cursor }) }),
        );
        const entries = asArray(page.items);

        // The read names the conversation's agent and its state; either can be absent on a
        // trimmed reply, and the LAST page's answer is the one that stands.
        agent = asString(page.agent, agent);
        total = asNumber(page.total, total);
        state = asTranscriptState(page.state);

        messages.push(...threadMessagesFromEntries(entries, offset));
        offset += entries.length;
        pages += 1;

        const next = page.nextCursor;

        if (typeof next !== 'string' || next.length === 0) break;
        cursor = next;
    }

    return { sessionId, threadId, agent, total, state, truncated: offset < total, messages };
};

/** One `define` attempt, reported rather than thrown (see `ensureCollections`). */
const defineCollection = async (sessionId: string, name: string): Promise<CollectionEnsure> => {
    try {
        const result = asRecord(await executeSessionTool(sessionId, 'records', { define: { name, fields: STORYLINE_SECTION_FIELDS } }));

        if (result.ok === false) return ensureResultOf(name, asRecord(result.error));

        return { name, state: 'defined', error: '' };
    } catch (error) {
        // A transport failure is data too: the tree still renders whatever the store holds.
        return ensureResultOf(name, { message: error instanceof Error ? error.message : String(error) });
    }
};

/**
 * The real implementation. Tool executions are the record store's only write path
 * from a browser — the store has no REST mutation route (agents edit it with their
 * tools) — so a pane edit executes the same `records`/`chapters` tool an agent
 * executes, resolved inside this session's registry. That is a deliberate
 * dependency on the story harness BINDING those tools, and a failure degrades the
 * pane to read-only with the server's own sentence.
 */
export const createStorylineApi = (): StorylineApi => ({
    root: (): string => STORYLINE_API_ROOT,

    socketUrl: (): string => streamSocketUrl(),

    listTitles: async (): Promise<TitleRow[]> => {
        const pages: unknown[] = [await listSessions({ limit: PAGE_LIMIT, harness: STORYLINE_HARNESS_ID })];

        // Bounded paging: three pages is 300 Titles, and a rail longer than that is a
        // search problem this workstation does not solve with a fetch loop.
        while (pages.length < MAX_TITLE_PAGES) {
            const cursor = asRecord(pages[pages.length - 1]).nextCursor;

            if (typeof cursor !== 'string' || cursor.length === 0) break;
            pages.push(await listSessions({ limit: PAGE_LIMIT, harness: STORYLINE_HARNESS_ID, cursor }));
        }

        return titleRowsFromPages(pages);
    },

    createTitle: async (name: string): Promise<TitleRow> => {
        const trimmed = name.trim();
        // An empty name sends NO `title` key at all: the server's row then carries no
        // title, which is exactly the case the `Untitled N` fallback describes.
        const created = asRecord(
            await createSession(trimmed.length === 0 ? { harness: STORYLINE_HARNESS_ID } : { harness: STORYLINE_HARNESS_ID, title: trimmed })
        );

        if (asString(created.id).length === 0) throw new Error('The storyline server created a title without an id.');

        return titleRowFromSession(created);
    },

    renameTitle: async (id: string, name: string): Promise<TitleRow | null> => {
        const trimmed = name.trim();
        const patched = asRecord(await updateSession(id, { title: trimmed.length === 0 ? null : trimmed }));

        return asString(patched.id).length === 0 ? null : titleRowFromSession(patched);
    },

    ensureCollections: async (sessionId: string): Promise<CollectionEnsureReport> => ({
        sessionId,
        // Concurrent and independent: two `define`s of different names cannot collide,
        // and neither one's outcome changes the other.
        results: await Promise.all(STORYLINE_SECTION_COLLECTIONS.map((name) => defineCollection(sessionId, name)))
    }),

    listThreads: async (sessionId: string): Promise<StorylineThreadRef[]> =>
        threadRefsFromPage(await listThreads(sessionId, { limit: PAGE_LIMIT })),

    openThread: async (sessionId: string, agent: StorylineAgent): Promise<string> => {
        // Reuse first: a reload must continue the SAME agent conversation, and a
        // second thread per agent would fork the story's context.
        const existing = selectAgentThread(await threadRefsFromPage(await listThreads(sessionId, { limit: PAGE_LIMIT })), agent);

        if (existing !== null) return existing.id;

        const created = asRecord(await createSessionThread(sessionId, { agent, label: `storyline:${agent}` }));
        const thread = created.thread ?? created;
        const id = asString(asRecord(thread).id);

        if (id.length === 0) throw new Error(`The storyline server opened a ${agent} thread without an id.`);

        return id;
    },

    submit: async (sessionId: string, threadId: string, text: string): Promise<{ turnId: string; threadId: string }> => {
        const receipt = asRecord(await submitTask(sessionId, { input: text, threadId }));

        return { turnId: asString(receipt.turn_id), threadId: asString(receipt.thread_id) || threadId };
    },

    stop: async (sessionId: string, threadId: string): Promise<void> => {
        await cancelSessionThread(sessionId, threadId);
    },

    // The one read that reaches a chained run's prose: see `readTranscriptPages`. A failing
    // conversation read REJECTS, and the caller that asked for it reports the failure on its
    // own surface rather than blanking a pane that already has content.
    readThreadMessages: async (sessionId: string, threadId: string): Promise<StorylineThreadMessages> =>
        readTranscriptPages(sessionId, threadId),

    readRecords: async (sessionId: string): Promise<StorylineRecords> => recordsFromSnapshot(await getSessionRecords(sessionId)),

    readChapter: async (sessionId: string, chapterId: string): Promise<ChapterDetail | null> =>
        chapterDetailFromToolPayload(
            unwrapToolResult(await executeSessionTool(sessionId, 'chapters', { action: 'get', id: chapterId }), 'chapters get')
        ),

    setChapterStatus: async (sessionId: string, chapter: { id: string; rev: number }, status: ChapterStatus): Promise<ChapterRow | null> =>
        rowFromToolPayload(
            unwrapToolResult(
                await executeSessionTool(sessionId, 'chapters', {
                    action: 'update',
                    id: chapter.id,
                    status,
                    // GUARDED WRITE. A call with a caller identity may only patch a record it has read,
                    // and the token is the proof (records.ts:1765); the rev came from the snapshot this
                    // pane is showing, so a stale click fails as a conflict instead of overwriting an
                    // agent's newer edit.
                    expects: [{ id: chapter.id, rev: chapter.rev }]
                }),
                'chapters update'
            ),
            'chapter',
            chapterFromEntry
        ),

    readTurnText: async (sessionId: string, turnId: string, agent?: StorylineAgent): Promise<string> =>
        turnTextFromDisplay(await getTurnDisplay(sessionId, turnId), agent)
});

/** The singleton most hosts use; the composition takes it as its default injection. */
export const storylineApi: StorylineApi = createStorylineApi();
