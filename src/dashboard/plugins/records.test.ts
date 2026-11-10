// The records plugin: one snapshot per Title, woken by the stream's own watermarks.
//
// What is pinned here is the part a unit test cannot fake: the plugin reacts to events
// the titles plugin re-broadcasts, addresses the read at whatever Title is active NOW,
// and answers the server's `store_rev` rather than a client-side guess.
import { describe, expect, it } from 'vitest';
import type { StorylineRecords } from '../../api';
import {
    EMPTY_RECORDS,
    RECORDS_REFRESH_COMMAND,
    RECORDS_STATE,
    TITLES_SELECT_COMMAND,
    type RecordsState
} from '../contract';
import { buildStoryline, RECORDS } from '../testing/doubles';

/** The state a ready snapshot produces, spelled out so a changed field is a diff. */
const readyFor = (sessionId: string, storeRev = RECORDS.storeRev): RecordsState => ({
    phase: 'ready',
    error: '',
    data: { ...RECORDS, sessionId, storeRev }
});

describe('records plugin', () => {
    it('reads the store of the Title boot picked, with no action from the operator', async () => {
        const { instance, flush } = buildStoryline();

        await flush();

        expect(instance.state<RecordsState>(RECORDS_STATE).get()).toEqual(readyFor('ses-new'));

        instance.dispose();
    });

    it('re-reads once more when a collection define lands, because the store changed', async () => {
        const { instance, calls, flush } = buildStoryline();

        await flush();

        // Activation reads, then the `records.updated` signal the titles plugin emits after
        // a successful define (rev 0 = "re-read whatever you have seen").
        expect(calls.filter((call) => call.startsWith('readRecords:'))).toEqual(['readRecords:ses-new', 'readRecords:ses-new']);

        instance.dispose();
    });

    it("shows the next Title's empty store before its read lands, and never the previous Title rows", async () => {
        // A holder of resolvers keyed by Title, the same shape the next test uses:
        // element access is not flow-narrowed, so the resolver keeps its declared type
        // even though it is assigned inside the promise executor. The payload is a
        // `StorylineRecords` because that is what the facade's `readRecords` answers with.
        const releases: Record<string, (value: StorylineRecords) => void> = {};

        const { instance, flush } = buildStoryline({
            api: {
                readRecords: (sessionId) =>
                    sessionId === 'ses-old'
                        ? new Promise<StorylineRecords>((resolve) => {
                              releases['ses-old'] = resolve;
                          })
                        : Promise.resolve({ ...RECORDS, sessionId })
            }
        });

        await flush();

        void instance.execute<string, Promise<string>>(TITLES_SELECT_COMMAND, 'ses-old');
        await flush();

        // The switch clears the snapshot: `Untitled 2` has not been read yet, and the
        // chapters of `Fog on the water` must not sit under its name.
        expect(instance.state<RecordsState>(RECORDS_STATE).get()).toEqual({
            phase: 'loading',
            error: '',
            data: { ...EMPTY_RECORDS, sessionId: 'ses-old' }
        });

        releases['ses-old']?.({ ...RECORDS, sessionId: 'ses-old', storeRev: 3 });
        await flush();

        expect(instance.state<RecordsState>(RECORDS_STATE).get()).toEqual(readyFor('ses-old', 3));

        instance.dispose();
    });

    it('drops a snapshot that answers for a Title the operator already left', async () => {
        const releases: Record<string, (value: StorylineRecords) => void> = {};

        const { instance, flush } = buildStoryline({
            api: {
                readRecords: (sessionId) =>
                    sessionId === 'ses-old'
                        ? new Promise<StorylineRecords>((resolve) => {
                              releases['ses-old'] = resolve;
                          })
                        : Promise.resolve({ ...RECORDS, sessionId })
            }
        });

        await flush();

        void instance.execute<string, Promise<string>>(TITLES_SELECT_COMMAND, 'ses-old');
        await flush();
        // Back to the newest Title, whose read is immediate.
        void instance.execute<string, Promise<string>>(TITLES_SELECT_COMMAND, 'ses-new');
        await flush();

        releases['ses-old']?.({ ...RECORDS, sessionId: 'ses-old', storeRev: 99 });
        await flush();

        // The slow reply was for a Title no longer open: it is dropped, not painted.
        expect(instance.state<RecordsState>(RECORDS_STATE).get()).toEqual(readyFor('ses-new'));

        instance.dispose();
    });

    it('ignores the one live frame that repeats the watermark it already holds, and acts above it', async () => {
        const { instance, calls, flush, stream } = buildStoryline();

        await flush();

        // Boot's own reads (the Title activation plus the store's opening read), counted rather
        // than assumed so this test is about the frames, not about the boot sequence.
        const reads = () => calls.filter((call) => call.startsWith('readRecords:')).length;
        const boot = reads();

        // The duplicate the server can send twice: a rejected tool call still publishes
        // (harness src/server/sessions.ts:2288), and its watermarks were read BEFORE the edit,
        // so this frame re-reads the identical snapshot for nothing.
        stream().onRecords?.({ storeRev: RECORDS.storeRev, collectionsRev: 40 });
        await flush();

        // The server's own number decides: a frame that states the rev on screen is not news.
        expect(reads()).toBe(boot);

        stream().onRecords?.({ storeRev: RECORDS.storeRev + 1, collectionsRev: 41 });
        await flush();

        expect(reads()).toBe(boot + 1);
        expect(calls.filter((call) => call.startsWith('readRecords:')).every((call) => call === 'readRecords:ses-new')).toBe(true);
        expect(instance.state<RecordsState>(RECORDS_STATE).get().data.storeRev).toBe(12);

        instance.dispose();
    });

    it('re-reads when the store is rewound below the watermark on screen, and the rewound rows land (T13)', async () => {
        // The read after the rewind answers with the store that exists AFTER a replace: a
        // replaced store restarts the rev, which is the whole point of the frame.
        let rewound = false;
        const { instance, calls, flush, stream } = buildStoryline({
            api: {
                readRecords: async (sessionId: string) => ({ ...RECORDS, sessionId, storeRev: rewound ? 5 : 12 })
            }
        });

        await flush();

        expect(instance.state<RecordsState>(RECORDS_STATE).get().data.storeRev).toBe(12);

        await flush();

        expect(instance.state<RecordsState>(RECORDS_STATE).get().data.storeRev).toBe(12);

        rewound = true;

        // `<=` was the defect: a frame BELOW the watermark on screen was thrown away, so a
        // restore, an import or a rebind left the tree and the pane showing the rows of a store
        // that no longer exists — with no error to say so. The contract calls the lower frame a
        // RE-BOOTSTRAP (harness src/server/sessions.ts:845-856: `recordsChanges(since)` answers
        // `reset: true` and "the snapshot must be re-read"), which is what a resync already does.
        const reads = () => calls.filter((call) => call.startsWith('readRecords:')).length;
        const boot = reads();

        stream().onRecords?.({ storeRev: 5, collectionsRev: 40 });
        await flush();

        expect(reads()).toBe(boot + 1);
        expect(instance.state<RecordsState>(RECORDS_STATE).get().data.storeRev).toBe(5);

        // The watermark moved WITH the rewound snapshot, so the very same frame is now the one
        // true no-op: the plugin did not merely re-read once and keep watching a stale number.
        stream().onRecords?.({ storeRev: 5, collectionsRev: 40 });
        await flush();

        expect(reads()).toBe(boot + 1);

        instance.dispose();
    });

    it('coalesces a burst of live frames into one read plus one trailing read', async () => {
        let reads = 0;
        // Each entry is a THUNK, not the resolver itself: the payload differs per read
        // (`storeRev` moves with the read count), and the plugin must see a settled
        // snapshot when the test releases one, not `undefined`.
        const pending: Array<() => void> = [];

        const { instance, calls, flush, stream } = buildStoryline({
            api: {
                readRecords: () => {
                    reads += 1;

                    if (reads <= 2) return Promise.resolve({ ...RECORDS, sessionId: 'ses-new' });

                    return new Promise<StorylineRecords>((resolve) => {
                        pending.push(() => resolve({ ...RECORDS, sessionId: 'ses-new', storeRev: 10 + reads }));
                    });
                }
            }
        });

        await flush();

        // Two frames while one read is in flight: N reads of one store is N-1 wasted.
        stream().onRecords?.({ storeRev: 20, collectionsRev: 1 });
        stream().onRecords?.({ storeRev: 21, collectionsRev: 1 });
        await flush();

        expect(reads).toBe(3);

        pending[0]?.();
        await flush();

        expect(reads).toBe(4);
        expect(pending).toHaveLength(2);
        expect(calls.filter((call) => call.startsWith('readRecords:'))).toHaveLength(4);

        pending[1]?.();
        await flush();

        expect(instance.state<RecordsState>(RECORDS_STATE).get().data.storeRev).toBe(14);

        instance.dispose();
    });

    it('re-reads after a resync even at the same watermark, because the watermark is untrusted', async () => {
        const { instance, calls, flush, stream } = buildStoryline();

        await flush();

        stream().onRecords?.({ storeRev: RECORDS.storeRev, collectionsRev: 1 });
        await flush();

        expect(calls.filter((call) => call.startsWith('readRecords:'))).toHaveLength(2);

        stream().onResync?.('frames_dropped', undefined);
        await flush();

        expect(calls.filter((call) => call.startsWith('readRecords:'))).toHaveLength(3);

        instance.dispose();
    });

    it('keeps the rows on screen when a refresh fails and states the server sentence', async () => {
        let second = false;

        const { instance, flush, stream } = buildStoryline({
            api: {
                readRecords: (sessionId) => {
                    if (second) return Promise.reject(new Error('records tool unavailable'));
                    second = true;

                    return Promise.resolve({ ...RECORDS, sessionId });
                }
            }
        });

        await flush();

        stream().onRecords?.({ storeRev: 99, collectionsRev: 1 });
        await flush();

        const state = instance.state<RecordsState>(RECORDS_STATE).get();

        expect(state.phase).toBe('error');
        expect(state.error).toBe('records tool unavailable');
        // The failure is shown, and the rows the operator was reading are still there.
        expect(state.data).toEqual(readyFor('ses-new').data);

        instance.dispose();
    });

    it('settles an idle store when no Title is active instead of inventing one', async () => {
        const { instance, flush } = buildStoryline({ api: { listTitles: async () => Promise.reject(new Error('gateway down')) } });

        await flush();

        // No Title, nothing to read: the pane says "pick a Title", which is not an error.
        expect(instance.state<RecordsState>(RECORDS_STATE).get()).toEqual({ phase: 'idle', error: '', data: EMPTY_RECORDS });
        expect(instance.execute<undefined, Promise<void>>(RECORDS_REFRESH_COMMAND)).toBeInstanceOf(Promise);

        instance.dispose();
    });
});
