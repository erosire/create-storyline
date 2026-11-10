// The records plugin: one normalized read of the active Title's record store.
//
// WHY A PLUGIN FOR A SINGLE READ: the Title tree and the center pane render the SAME
// snapshot (`GET /sessions/{id}/records` returns every collection in one bounded
// response — that is what the route is FOR, harness harness-api.ts:1532), so one
// owner keeps them from disagreeing about the story. It is also the only place that
// reacts to the stream's `records.updated` signal, so an agent editing chapters live
// repaints the tree and the document without either pane knowing about the socket.
//
// PER TITLE, NEVER GLOBAL: switching Titles clears the snapshot to `EMPTY_RECORDS`
// (carrying the new session id) before the read lands, so a chapter of the Title
// just left behind is never shown as if it belonged to the one now open. A reply
// that arrives after a switch is dropped by comparing the session id it was read for.
//
// THE COALESCING LOOP: a burst of live edits fires many `records.updated` frames.
// Each one is a reason to re-read, and N reads of the same store is N-1 wasted
// requests, so a refresh that arrives while one is in flight sets a dirty flag and
// exactly ONE trailing read happens afterwards. Rows stay visible during a reload
// (`phase: 'loading'` while the previous rows are still in `data`), which is what
// makes a live edit look like a repaint instead of a flash.
//
// THE WATERMARK: every `records.updated` frame carries the store's own `store_rev`. A
// frame that states the watermark of the snapshot already on screen cannot hold anything
// new, so it is ignored — the server's number, not a client-side guess. A frame ABOVE it is
// a re-read. A frame BELOW it is a REWIND: `reset()`/`restore()` take the watermark down on
// purpose, and the contract says a client that sees its own watermark above `store_rev`
// re-bootstraps from the snapshot read (harness src/server/sessions.ts:845-856). Skipping
// that frame left the tree and the pane holding the rows of a store that no longer exists,
// until some later frame climbed back above the old watermark. Rev 0 is the opposite
// signal: "something changed, no idea when" (the titles plugin emits it after a collection
// define), and it always re-reads.
import type { DashboardPlugin, DashboardPluginAPI } from '@underload/dashboard';
import {
    API_SERVICE,
    EMPTY_RECORDS,
    PLUGIN_IDS,
    RECORDS_REFRESH_COMMAND,
    RECORDS_STATE,
    STREAM_RECORDS_EVENT,
    STREAM_RESYNC_EVENT,
    TITLES_ACTIVE_EVENT,
    TITLES_SERVICE,
    type RecordsState,
    type StreamRecordsEvent,
    type StorylineApiService,
    type TitlesActiveEvent,
    type TitlesService
} from '../contract';

export function createRecordsPlugin(): DashboardPlugin {
    return {
        id: PLUGIN_IDS.records,
        requires: [PLUGIN_IDS.api, PLUGIN_IDS.titles],

        setup(api: DashboardPluginAPI): () => void {
            const server = api.getService<StorylineApiService>(API_SERVICE);
            const titles = api.getService<TitlesService>(TITLES_SERVICE);
            const state = api.state<RecordsState>(RECORDS_STATE, { phase: 'idle', error: '', data: EMPTY_RECORDS });

            let inFlight: Promise<void> | null = null;
            let queued = false;
            let disposed = false;
            /** The watermark of the snapshot currently on screen, per session. */
            let seen = new Map<string, number>();

            const readOnce = async (): Promise<void> => {
                const sessionId = titles.activeId();

                // No Title, nothing to read — and an idle pane that says "pick a Title" is
                // the honest state, not an error and not an empty store.
                if (sessionId.length === 0) {
                    state.set({ phase: 'idle', error: '', data: EMPTY_RECORDS });

                    return;
                }

                const data = await server.readRecords(sessionId);

                // A late answer from a disposed dashboard must not resurrect state the
                // kernel has already dropped (every operation throws after dispose).
                if (disposed) return;
                // A reply for a Title the operator already left is the wrong story entirely.
                if (titles.activeId() !== sessionId) return;

                seen.set(sessionId, data.storeRev);
                state.set({ phase: 'ready', error: '', data });
            };

            const refresh = (): Promise<void> => {
                if (inFlight !== null) {
                    queued = true;

                    return inFlight;
                }

                state.set((previous) => ({ ...previous, phase: 'loading', error: '' }));

                inFlight = (async () => {
                    do {
                        queued = false;
                        try {
                            await readOnce();
                        } catch (error) {
                            if (disposed) return;
                            const message = error instanceof Error ? error.message : String(error);

                            // The rows that ARE there stay on screen; the failure is stated once.
                            state.set((previous) => ({ ...previous, phase: 'error', error: message }));
                        }
                    } while (queued && !disposed);
                })().finally(() => {
                    inFlight = null;
                });

                return inFlight;
            };

            /** Drops what the previous Title showed, so the new one starts from nothing known. */
            const reset = (sessionId: string): void => {
                state.set({ phase: 'loading', error: '', data: { ...EMPTY_RECORDS, sessionId } });
            };

            api.command<void, Promise<void>>(RECORDS_REFRESH_COMMAND, () => refresh());

            // A Title becoming active is the first chance there is a store to read at all.
            api.on<TitlesActiveEvent>(TITLES_ACTIVE_EVENT, ({ sessionId }) => {
                reset(sessionId);
                void refresh();
            });

            // The live signal carries watermarks only (RecordsSignal), so the answer is a
            // fresh bounded read, never a guess about which row moved.
            api.on<StreamRecordsEvent>(STREAM_RECORDS_EVENT, ({ storeRev }) => {
                const sessionId = titles.activeId();
                const last = seen.get(sessionId) ?? 0;

                // The ONE no-op is a frame that states the watermark already on screen. Above
                // it, the store moved and the rows are stale. BELOW it, the store was REWOUND —
                // `reset()`/`restore()` legitimately take `storeRev` down, and the contract says
                // so (harness src/server/sessions.ts:845-856: "one per `reset()`/`restore()`/
                // `define`/`drop`, where `storeRev` may legitimately go DOWN ... a client that
                // sees its own watermark above `storeRev` ... re-bootstraps from the snapshot
                // read"). Skipping that frame is what left the tree and the pane showing the
                // rows of the store that no longer exists until some later frame climbed back
                // above the old watermark, so a rewind re-bootstraps exactly like a resync.
                if (storeRev > 0 && storeRev === last) return;
                void refresh();
            });

            // A resync means frames were dropped, so the watermark on screen is untrusted.
            api.on(STREAM_RESYNC_EVENT, () => {
                seen = new Map();
                void refresh();
            });

            return () => {
                disposed = true;
            };
        }
    };
}
