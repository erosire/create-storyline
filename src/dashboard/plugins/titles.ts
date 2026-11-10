// The Titles plugin: the tree's registry, the active Title, and the one live socket.
//
// WHY THIS PLUGIN EXISTS (and why the old "session" plugin does not): in this
// workstation a Title IS a harness session — one session per Title, always created
// from the `'storyline'` harness (src/api/storyline.ts, fixed contract). Nothing
// here discovers a harness or a preset: the tree lists Titles, picking one makes it
// the session every other plugin addresses, and starting a new one is the only way
// a session is ever created. The word "session" survives only inside this file and
// in the api layer, where it is the wire's name for a Title.
//
// ONE SOCKET FOR THE WHOLE DASHBOARD: the record store, the transcript and the agent
// roster are all per-Title, and the harness scopes every stream subscription by
// session. Two sockets would double each frame and let two panes disagree about the
// story, so this plugin owns the only connection and re-broadcasts it as dashboard
// EVENTS (the kernel's intended shape: events are live signals, and a view that
// mounts later reads `state(id).get()` for the truth). Switching Titles closes the
// old observation and dials the new one — a stale socket would keep painting the
// Title the operator walked away from.
//
// WHICH TITLE IS ACTIVE, in this order:
//   1. whatever is already active in this page's lifetime (a re-ensure must not move);
//   2. the id this browser persisted, but only while the server still lists it —
//      a deleted Title must not leave every pane pointed at nothing;
//   3. the newest Title the server has.
// The list is the whole truth, so there is no liveness probe: an id the list returns
// exists, and one it does not is gone. That is also why no `GET /sessions/{id}`
// round trip happens on boot any more.
//
// COLD START: with zero Titles the server answered successfully and there is simply
// nothing to open, so the first Title is created (untitled — the tree renders it as
// `Untitled 1`). A FAILED list never auto-creates: that would paper over a server
// that is down with a stack of empty Titles.
//
// THE COLLECTION ENSURE: the two story documents (`outlines`, `storyline`) are
// collections this app defines through the `records` tool, because the record store
// has no REST write path. It runs after activation, fire-and-forget, and `collection-
// exists` counts as success (src/api/storyline.ts). When a define lands, the store
// changed, so this plugin emits a `records.updated` signal with rev 0 — the marker
// the records plugin reads as "re-read, whatever you have seen" (a real frame always
// carries a positive watermark).
import type { DashboardPlugin, DashboardPluginAPI } from '@underload/dashboard';
import { createStorylineStream, type StorylineStreamEvents, type StreamStatus } from '../../api/stream';
import type { TitleRow } from '../../api';
import {
    API_SERVICE,
    EMPTY_TITLES,
    PLUGIN_IDS,
    STATUS_ORDERS,
    STATUS_SLOT,
    STREAM_CHIP,
    STREAM_RECORDS_EVENT,
    STREAM_RESYNC_EVENT,
    STREAM_SECTION_EVENT,
    STREAM_STATE,
    STREAM_STATUS_EVENT,
    STREAM_TEXT_EVENT,
    STREAM_THREAD_EVENT,
    STREAM_TURN_EVENT,
    TITLE_CHIP,
    TITLES_ACTIVE_EVENT,
    TITLES_ACTIVE_STATE,
    TITLES_CREATE_COMMAND,
    TITLES_FAILED_EVENT,
    TITLES_READY_EVENT,
    TITLES_REFRESH_COMMAND,
    TITLES_RENAME_COMMAND,
    TITLES_SELECT_COMMAND,
    TITLES_SERVICE,
    TITLES_STATE,
    type SectionDisplayState,
    type StatusValue,
    type StorylineApiService,
    type StreamRecordsEvent,
    type StreamResyncEvent,
    type StreamState,
    type StreamStatusEvent,
    type TitlesActiveEvent,
    type TitlesFailedEvent,
    type TitlesReadyEvent,
    type TitlesService,
    type TitlesState
} from '../contract';
import { StreamChip, TitleChip } from '../components/Chips';

/** The key the active Title id is stored under (per origin; a delete leaves it and the list wins). */
export const TITLES_STORAGE_KEY = 'storyline:active-title';

/**
 * Stream seam. A test injects a double that records `followTurn`/`close` and pushes
 * frames through the events object; production uses `createStorylineStream`.
 */
export type StreamFactory = (sessionId: string, events: StorylineStreamEvents) => TitlesStreamHandle;

/** The lifecycle slice of the stream this plugin hands out. */
export type TitlesStreamHandle = {
    connect(): void;
    close(reason?: string): void;
    followTurn(turnId: string): void;
    status(): StreamStatus;
};

export type TitlesPluginOptions = {
    /** Defaults to `createStorylineStream` dialled at `api.socketUrl()`. */
    streamFactory?: StreamFactory;
    /** Active-Title persistence key; '' or null disables it (tests, locked-down browsers). */
    storageKey?: string | null;
};

/** The harness section state, narrowed to the union this UI labels. */
const asSectionState = (state: string): SectionDisplayState | null =>
    state === 'open' || state === 'streaming' || state === 'done' || state === 'error' || state === 'cancelled' ? (state as SectionDisplayState) : null;

/** Defensive storage access: jsdom without a key, private mode and disabled storage all throw. */
const readStored = (key: string): string | null => {
    if (key.length === 0) return null;

    try {
        return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
        return null;
    }
};

const writeStored = (key: string, value: string): void => {
    if (key.length === 0) return;

    try {
        globalThis.localStorage?.setItem(key, value);
    } catch {
        // An unwritable store costs resume, never the Title itself.
    }
};

export function createTitlesPlugin(options: TitlesPluginOptions = {}): DashboardPlugin {
    // '' is a legitimate value here (it disables persistence), hence the explicit
    // nullish check rather than `||`.
    const storageKey = options.storageKey ?? TITLES_STORAGE_KEY;

    return {
        id: PLUGIN_IDS.titles,
        requires: [PLUGIN_IDS.api],

        setup(api: DashboardPluginAPI): () => void {
            const server = api.getService<StorylineApiService>(API_SERVICE);
            const titles = api.state<TitlesState>(TITLES_STATE, EMPTY_TITLES);
            const active = api.state<string>(TITLES_ACTIVE_STATE, '');
            const streamState = api.state<StreamState>(STREAM_STATE, { status: 'idle', error: '' });

            let stream: TitlesStreamHandle | null = null;
            let loading: Promise<TitlesState> | null = null;
            let disposed = false;

            const closeStream = (): void => {
                if (stream === null) return;
                const handle = stream;

                stream = null;
                try {
                    handle.close('title change');
                } catch {
                    // A socket that throws while closing is already gone.
                }
                // Settled here as well as through the handle's own callback, because an
                // injected double may not emit one (an equal write is a kernel no-op).
                streamState.set((previous) => (previous.status === 'closed' ? previous : { ...previous, status: 'closed' }));
            };

            const openStream = (sessionId: string): void => {
                closeStream();

                const events: StorylineStreamEvents = {
                    onStatus: (status) => {
                        streamState.set((previous) => ({ ...previous, status }));
                        api.emit<StreamStatusEvent>(STREAM_STATUS_EVENT, { status });
                    },

                    onText: (text, turnId) => api.emit(STREAM_TEXT_EVENT, { turnId, text }),

                    // The whole turn row, so a late listener folds the same way an early one did.
                    onTurn: (turn) => api.emit(STREAM_TURN_EVENT, { turn }),

                    // The conversation roster row (`thread.upsert`) — the agents panel's live state.
                    onThread: (thread) => api.emit(STREAM_THREAD_EVENT, { thread }),

                    // One display section's state (`section:open` / `section:set`) — an agent's phase.
                    onSection: (section) => {
                        if (asSectionState(section.state) === null) return;
                        api.emit(STREAM_SECTION_EVENT, { section });
                    },

                    onRecords: (signal) => api.emit<StreamRecordsEvent>(STREAM_RECORDS_EVENT, signal),

                    onResync: (reason, turnId) => {
                        // This client never guesses what dropped frames held; the panes answer a
                        // resync by re-reading their bounded REST sources.
                        const status = stream?.status() ?? 'open';

                        streamState.set((previous) => ({ ...previous, status, error: `stream resync: ${reason}` }));
                        api.emit<StreamResyncEvent>(STREAM_RESYNC_EVENT, {
                            reason,
                            ...(turnId === undefined ? {} : { turnId })
                        });
                    },

                    onError: (error) => {
                        const status = stream?.status() ?? 'open';
                        const message = `${error.code}: ${error.message}`;

                        streamState.set({ status, error: message });
                        api.emit<StreamStatusEvent>(STREAM_STATUS_EVENT, { status, error: message });
                    }
                };

                const handle =
                    options.streamFactory?.(sessionId, events) ?? createStorylineStream({ sessionId, events, socketUrl: server.socketUrl() });

                stream = handle;
                handle.connect();
            };

            /** The row for an id, or the row the server carries for it. */
            const rowOf = (rows: readonly TitleRow[], id: string): TitleRow | undefined => rows.find((row) => row.id === id);

            /** Reads every Title the server has, coalescing concurrent callers onto one promise. */
            const load = (): Promise<TitlesState> => {
                if (loading !== null) return loading;

                titles.set((previous) => ({ ...previous, phase: 'loading', error: '' }));

                loading = server
                    .listTitles()
                    .then(
                        (rows): TitlesState => {
                            // After disposal the state cell is GONE and reading it throws, so this
                            // branch rebuilds the value from the rows it already holds. It matters:
                            // `load()` is called fire-and-forget at boot, and a rejected read would
                            // surface as an unhandled promise rejection in a page that only closed
                            // the dashboard a microtask earlier.
                            if (disposed) return { phase: 'ready', error: '', rows };

                            const next: TitlesState = { phase: 'ready', error: '', rows };

                            titles.set(next);
                            api.emit<TitlesReadyEvent>(TITLES_READY_EVENT, { count: rows.length });

                            return next;
                        },
                        (error: unknown): TitlesState => {
                            const message = error instanceof Error ? error.message : String(error);

                            if (disposed) return { phase: 'error', error: message, rows: [] };

                            // The rows already on screen stay: a failed refresh must not
                            // blank a tree the operator is reading.
                            titles.set((previous) => ({ ...previous, phase: 'error', error: message }));
                            api.emit<TitlesFailedEvent>(TITLES_FAILED_EVENT, { message });

                            return titles.get();
                        },
                    )
                    .finally(() => {
                        loading = null;
                    });

                return loading;
            };

            /**
             * Makes one Title the active one: state, persistence, socket, then the signal.
             *
             * IDEMPOTENT by construction: activation can be asked for twice in the same
             * tick (the boot load and the first consumer's `ensureActive()`), and a second
             * observation on one Title would double every frame the panes fold.
             */
            const activate = (row: TitleRow): string => {
                const already = active.get() === row.id && stream !== null;

                active.set(row.id);

                if (already) return row.id;

                writeStored(storageKey, row.id);
                openStream(row.id);
                api.emit<TitlesActiveEvent>(TITLES_ACTIVE_EVENT, { sessionId: row.id, label: row.label });

                // Fire-and-forget: a Title whose documents cannot be defined is still a Title
                // the tree shows and the operator can talk to.
                void server.ensureCollections(row.id).then(
                    (report) => {
                        if (disposed || active.get() !== row.id) return;
                        const failed = report.results.filter((result) => result.state === 'failed');

                        if (failed.length > 0) {
                            api.emit<TitlesFailedEvent>(TITLES_FAILED_EVENT, {
                                message: `${failed.map((result) => result.name).join(', ')}: ${failed[0]?.error ?? 'could not be created'}`
                            });

                            return;
                        }
                        // A define that landed changed the store: rev 0 tells the records
                        // plugin to re-read regardless of the watermark it has already seen.
                        api.emit<StreamRecordsEvent>(STREAM_RECORDS_EVENT, { storeRev: 0, collectionsRev: 0 });
                    },
                    (error: unknown) => {
                        if (disposed) return;
                        api.emit<TitlesFailedEvent>(TITLES_FAILED_EVENT, {
                            message: error instanceof Error ? error.message : String(error)
                        });
                    },
                );

                return row.id;
            };

            /** Picks the Title to be active, in the documented order. */
            const pick = (rows: readonly TitleRow[]): TitleRow | undefined => {
                const current = active.get();

                if (current.length > 0) {
                    const currentRow = rowOf(rows, current);
                    if (currentRow !== undefined) return currentRow;
                }

                const stored = readStored(storageKey);

                if (stored !== null && stored.length > 0) {
                    const storedRow = rowOf(rows, stored);
                    if (storedRow !== undefined) return storedRow;
                }

                // `listTitles` is newest-first, so "the first" IS the newest.
                return rows[0];
            };

            /**
             * Picks and activates the Title this page should work on. Shared by the boot
             * load and by any consumer that asks for an active Title, so the two can never
             * start two observations of the same story.
             */
            const settleActive = (): Promise<string> =>
                load().then(async (state) => {
                    if (disposed) return '';

                    let row = pick(state.rows);

                    if (row === undefined && state.phase === 'ready') {
                        // A cold, empty library: open the first Title rather than a blank shell.
                        row = await server
                            .createTitle('')
                            .then((created) => created)
                            .catch(() => undefined);

                        if (row !== undefined) titles.set({ ...state, rows: [row, ...state.rows] });
                    }

                    if (row === undefined) return '';

                    return activate(row);
                });

            const ensureActive = (): Promise<string> => {
                const current = active.get();

                if (current.length > 0) return Promise.resolve(current);

                return settleActive();
            };

            api.service<TitlesService>(TITLES_SERVICE, {
                activeId: () => active.get(),
                ensureActive,
                // The stream handle may be closed between Titles, and a closed observation
                // still accepts the call — it is a no-op there (src/api/stream.ts).
                followTurn: (turnId: string) => stream?.followTurn(turnId)
            });

            api.command<void, Promise<readonly TitleRow[]>>(TITLES_REFRESH_COMMAND, () => load().then((state) => state.rows));

            api.command<string, Promise<TitleRow>>(TITLES_CREATE_COMMAND, async (name) => {
                const created = await server.createTitle(name ?? '');
                const state = titles.get();

                titles.set({ ...state, phase: 'ready', error: '', rows: [created, ...state.rows.filter((row) => row.id !== created.id)] });
                api.emit<TitlesReadyEvent>(TITLES_READY_EVENT, { count: titles.get().rows.length });

                // Starting a Title means working on it: it becomes active at once.
                activate(created);

                return created;
            });

            api.command<{ id: string; name: string }, Promise<TitleRow | null>>(TITLES_RENAME_COMMAND, async ({ id, name }) => {
                const renamed = await server.renameTitle(id, name);
                const state = titles.get();

                if (renamed === null) return null;

                titles.set({ ...state, rows: state.rows.map((row) => (row.id === renamed.id ? renamed : row)) });
                // The strip and the tree both show the label, so both must hear about it.
                api.emit<TitlesReadyEvent>(TITLES_READY_EVENT, { count: state.rows.length });

                if (active.get() === renamed.id) api.emit<TitlesActiveEvent>(TITLES_ACTIVE_EVENT, { sessionId: renamed.id, label: renamed.label });

                return renamed;
            });

            api.command<string, Promise<string>>(TITLES_SELECT_COMMAND, async (id) => {
                const state = titles.get();
                const row = rowOf(state.rows, id);

                // Selecting an id the tree never listed is a no-op with a visible reason,
                // not a socket dialled at a session that may not exist.
                if (row === undefined) {
                    titles.set({ ...state, error: `No Title ${id}.` });

                    return active.get();
                }

                return activate(row);
            });

            api.slot<StatusValue>(STATUS_SLOT, {
                id: TITLE_CHIP,
                order: STATUS_ORDERS.title,
                value: { label: 'Title', component: TitleChip }
            });

            // The observation belongs to this plugin, so the chip that reports it does too:
            // without it a dropped-frame resync or a closed socket would be invisible in the
            // strip, and `storyline.stream.state` is the only place that sentence is kept.
            api.slot<StatusValue>(STATUS_SLOT, {
                id: STREAM_CHIP,
                order: STATUS_ORDERS.stream,
                value: { label: 'Stream', component: StreamChip }
            });

            // The tree is the workstation's front door, so it fills itself at boot: the first
            // paint already shows the Titles the server has, with one of them open. No
            // liveness probe and no created session — the list is the whole truth.
            void settleActive();

            // Teardown: the socket goes first and quietly. A run the operator started keeps
            // executing server-side — this only stops watching it.
            return () => {
                disposed = true;
                closeStream();
            };
        }
    };
}
