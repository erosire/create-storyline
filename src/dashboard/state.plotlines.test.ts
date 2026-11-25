// T-W4 — Phrase ②'s transport in the STORE: when the desk asks for the chapter entries, and what each of the
// three new verbs commits.
//
// A component test cannot answer WHEN the read happens, and that is where the two failure modes live:
//
//   1. a Phrase ② poll for every Story on the desk would pay for a surface nobody is looking at, and a classic
//      book has no entries to fetch at all — so the store asks only when the dial says the surface is open
//      (`story.plotlines_mode`) or the rows are already cached (`phraseDetails[storyId]`);
//   2. the Phrase ② read and the Summary read must never share a slot: the revise route's `view` is the PHRASE
//      read, and committing it into `phrases` would put chapter rows under the Summary's five groups.
//
// The refusals are pinned too, and the two kinds are deliberately cached in different places: a REFUSED READ goes
// into `phraseDetailErrors[storyId]` (the pane prints it as its failed-read line), while a REFUSED START is the
// shell's line only — writing a 409 about the handoff into the read's slot would paint a failed read over rows
// that arrived fine. Every verb's assertions read the client mock's calls and the exact snapshot slot, never a
// component's ink.
import { describe, expect, it, vi } from 'vitest';

import { createDashboardStore } from './state';
import {
    ApiError,
    type ApiClient,
    type PhraseEntryReviseResult,
    type PhraseStartResult,
    type StreamKind,
    type StoryPatch
} from './api';
import {
    fakeHarness,
    groupedPhraseView,
    phraseDetailView,
    storyRow,
    storyView
} from './testing/shell-fakes';

/**
 * Two books with Phrase ② in the state the test asks for. `mode` is the projected dial — it travels on the
 * Story VIEW (what the desk routes on), and the `PATCH` body is what moves it.
 */
function harness(
    options: {
        mode?: 'groups' | 'classic';
        getPhraseDetail?: ApiClient['getPhraseDetail'];
        startPhrase?: ApiClient['startPhrase'];
        revisePhraseEntry?: ApiClient['revisePhraseEntry'];
    } = {}
) {
    const rows = [storyRow('s1'), storyRow('s2')];
    // The read's answer TRACKS the entry write: the route installs revision 2, and the re-read `mutate` runs
    // afterwards reports the same number. A fake that always answered `revision: 1` would make the store look
    // like it lost the write, when what it did was re-read the server — which is the behaviour under test.
    let installed: { entryId: string; revision: number } | undefined;
    const getStory = vi.fn(async (storyId: string) => ({
        ...storyView(rows.find((row) => row.id === storyId) ?? storyRow(storyId)),
        plotlines_mode: options.mode ?? 'classic',
        phrase_started: { summary: true, plotlines: false },
        summary_compiled: true
    }));
    // The default Phrase ② read is the wire-shaped three-chapter entry set; a refusal test overrides it.
    const getPhraseDetail = vi.fn(
        options.getPhraseDetail ??
            (async (storyId: string) =>
                phraseDetailView(storyId, {
                    groups: phraseDetailView(storyId).groups.map((row) =>
                        installed !== undefined && row.id === installed?.entryId
                            ? { ...row, revision: installed?.revision ?? row.revision }
                            : row
                    )
                }))
    );
    const stream = { handler: undefined as ((kind: StreamKind, storyId?: string) => void) | undefined };
    const patchStory = vi.fn(async (storyId: string, patch: StoryPatch) => ({
        ...storyRow(storyId),
        // The fake echoes the dial back the way the projection does, so a test can read what the write said.
        ...(patch.plotlines_mode === undefined ? {} : { plotlines_mode: patch.plotlines_mode })
    }));
    const startPhrase = vi.fn(
        options.startPhrase ??
            (async (storyId: string, key: string): Promise<PhraseStartResult> => ({
                story_id: storyId,
                phrase_id: 'phrase_plotlines_1',
                key,
                source: 'compiled',
                seed_chars: 67,
                seed_head: 'A smuggler pays the tide to cross the salt road, and the road collects.',
                started: { id: 'start_1', at: '2026-11-09T12:00:00.000Z' },
                view: phraseDetailView(storyId, { seed_chars: 67 })
            }))
    );
    const revisePhraseEntry = vi.fn(
        options.revisePhraseEntry ??
            (async (storyId: string, entryId: string): Promise<PhraseEntryReviseResult> => {
                installed = { entryId, revision: 2 };

                return {
                    story_id: storyId,
                    phrase_id: 'phrase_plotlines_1',
                    revision: 2,
                    installed: [
                        { group_id: entryId, group_key: 'chapter_1', revision_id: `rev-${entryId}-2`, number: 2 }
                    ],
                    archived: [
                        { group_id: entryId, group_key: 'chapter_1', revision_id: `rev-${entryId}-1`, number: 1 }
                    ],
                    // The entry leg writes no Summary mirror (the Summary is a different phrase), so the route
                    // answers the not-written frame with its reason — never an absent key.
                    mirror: { summary_id: null, fields: [], written: false, reason: 'no_summary' },
                    view: phraseDetailView(storyId, {
                        groups: phraseDetailView(storyId).groups.map((row) =>
                            row.id === entryId ? { ...row, revision: 2 } : row
                        )
                    })
                };
            })
    );

    return {
        stream,
        ...fakeHarness(rows, [], {
            getStory,
            patchStory,
            getPhraseDetail,
            startPhrase,
            revisePhraseEntry,
            // The Summary read keeps its own slot here too, so the two caches can be told apart in the
            // assertions below (`phrases.s1` has five groups, `phraseDetails.s1` has three chapter entries).
            getPhrase: vi.fn(async (storyId: string) => groupedPhraseView(storyId)),
            subscribeEvents: vi.fn((handler: (kind: StreamKind, storyId?: string) => void) => {
                stream.handler = handler;

                return () => {
                    stream.handler = undefined;
                };
            })
        }),
        patchStory
    };
}

/** The Phrase ② read's calls, as plain story ids. */
function detailCalls(client: ApiClient): string[] {
    return (client.getPhraseDetail as unknown as { mock: { calls: string[][] } }).mock.calls.map(
        (call) => call[0]
    );
}

/**
 * A stream handler is synchronous and the refresh it starts is not, so a test that fires an event has to let
 * the store's chain settle before reading the snapshot.
 */
async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('the store — the Phrase ② read is fetched only where the surface is open (T-W4)', () => {
    it('pays for no phrase read on a classic book, and reads the entries the moment the dial is on', async () => {
        const classic = harness({ mode: 'classic' });

        await classic.store.openStory('s1');

        // The rail's Phrase ② row still exists on a classic book (its pane is the §4.3 records, off the Story
        // payload), so the absence of this fetch is a decision, not an oversight.
        expect(detailCalls(classic.client)).toEqual([]);
        expect(classic.store.getSnapshot().phraseDetails.s1).toBeUndefined();
        expect(classic.store.getSnapshot().phraseDetailErrors).toEqual({});

        const grouped = harness({ mode: 'groups' });

        await grouped.store.openStory('s1');

        expect(detailCalls(grouped.client)).toEqual(['s1']);
        expect(grouped.store.getSnapshot().phraseDetails.s1?.groups.map((row) => row.key)).toEqual([
            'chapter_1',
            'chapter_2',
            'chapter_3'
        ]);
    });

    it('caches the server’s own sentence when the read fails, and leaves the Story and the Summary read standing', async () => {
        const { client, store, stream } = harness({
            mode: 'groups',
            getPhraseDetail: async () => {
                throw new ApiError(503, 'the gateway is not answering');
            }
        });

        await store.openStory('s1');

        expect(store.getSnapshot().phraseDetails.s1).toBeUndefined();
        expect(store.getSnapshot().phraseDetailErrors.s1).toBe('the gateway is not answering');
        // The failure belongs to ONE route: the Story payload, the Summary read and the other Story's rows are
        // untouched, and the sentence is not written into the Summary's error slot.
        expect(store.getSnapshot().storyViews.s1?.story.id).toBe('s1');
        expect(store.getSnapshot().phrases.s1?.groups).toHaveLength(5);
        expect(store.getSnapshot().phraseErrors).toEqual({});
        // The open's own chain clears the shell strip at its tail (the per-Story cache keeps the sentence), so
        // the strip only carries this failure when the read happens outside a mutation — the stream's case.
        expect(store.getSnapshot().error).toBeNull();

        store.start();
        stream.handler?.('story', 's1');
        await flush();

        expect(store.getSnapshot().error).toBe('the gateway is not answering');
        expect(client.getPhraseDetail).toHaveBeenCalledTimes(2);
    });

    it('re-reads the entries with a mutation only while the surface is open, and only for the Story it touched', async () => {
        const { client, store } = harness({ mode: 'groups' });

        await store.openStory('s1');

        expect(detailCalls(client)).toEqual(['s1']);

        // The third argument is the Idea's note, which is part of the select route's body — not a flag.
        await store.selectIdea('s1', 'idea_1', 'the crossing is attempted, and the toll is refused');
        await flush();

        // One extra read, for the Story the write touched: the entries move under the same writes the Summary's
        // groups do, and an Author standing on one has to see it move in the frame they clicked in.
        expect(detailCalls(client)).toEqual(['s1', 's1']);

        // A write against a Story whose surface was never opened pays for no read of its own.
        await store.selectIdea('s2', 'idea_1', 'the road collects');
        await flush();

        expect(detailCalls(client)).toEqual(['s1', 's1']);
    });
});

describe('the store — the Phrase ② verbs commit the receipt, not a guess (T-W4)', () => {
    it('the dial patches the explicit word, and only the grouped word pulls the rows in', async () => {
        const { client, store, patchStory } = harness({ mode: 'classic' });

        await store.openStory('s1');

        await store.setPlotlinesMode('s1', 'groups');

        // The body names the mode rather than omitting it: `'classic'` is the default, so an author switching
        // OFF has to send a word the server can tell apart from silence.
        expect(patchStory.mock.calls.map((call) => call[1])).toEqual([{ plotlines_mode: 'groups' }]);
        expect(detailCalls(client)).toEqual(['s1']);

        await store.setPlotlinesMode('s1', 'classic');

        expect(patchStory.mock.calls.map((call) => call[1])).toEqual([
            { plotlines_mode: 'groups' },
            { plotlines_mode: 'classic' }
        ]);
        // Turning the dial off re-reads the STORY (the projection's answer), not the entries the dial just
        // closed: the pane falls back to the §4.3 records off the payload it already refreshes.
        expect(detailCalls(client)).toEqual(['s1', 's1']);
    });

    it('the start commits the read the route answers with, and the rail reads the flag off the re-read Story', async () => {
        const { client, store } = harness({ mode: 'classic' });

        await store.openStory('s1');

        // The classic book had no read; the start's own receipt opens the surface, which is why the verb is
        // where the cache first appears (no rail click is needed to make the entries real).
        const result = await store.startPhrase('s1', 'plotlines', { source: 'compiled' });

        expect((result as { source: string }).source).toBe('compiled');
        expect(store.getSnapshot().phraseDetails.s1?.groups.map((row) => row.key)).toEqual([
            'chapter_1',
            'chapter_2',
            'chapter_3'
        ]);
        // The receipt's own Seed head is what the handoff's receipt line prints — committed, not re-derived.
        expect(store.getSnapshot().phraseDetails.s1?.seed_head).toBe(
            'A smuggler pays the tide to cross the salt road, and the road collects.'
        );
        // `mutate` re-reads the Story, whose `phrase_started` flag is what closes the handoff and the dial.
        expect(client.getStory).toHaveBeenCalled();
    });

    it('a start refusal is the shell’s line, never a failed-read slot', async () => {
        const { store } = harness({
            mode: 'groups',
            startPhrase: async () => {
                throw new ApiError(
                    409,
                    'this phrase has already started: its Seed is the text every entry, revision and claim key was written against (D-72)'
                );
            }
        });

        await store.openStory('s1');

        const before = store.getSnapshot().phraseDetails.s1;

        expect(await store.startPhrase('s1', 'plotlines', { source: 'compiled' })).toBeNull();
        expect(store.getSnapshot().error).toBe(
            'this phrase has already started: its Seed is the text every entry, revision and claim key was written against (D-72)'
        );
        // THE SLOT MEANS "THE READ FAILED". A 409 about the handoff would render a failed-read line over rows
        // that arrived fine, so the cache keeps the rows the desk already had.
        expect(store.getSnapshot().phraseDetailErrors).toEqual({});
        expect(store.getSnapshot().phraseDetails.s1).toBe(before);
    });

    it('the entry revise commits the phrase read into the Phrase ② slot, and the Summary keeps its groups', async () => {
        const { store } = harness({ mode: 'groups' });

        await store.openStory('s1');

        await store.revisePhraseEntry('s1', 'entry-chapter_2', {
            plotpoints: { must_happen: 'the toll is refused', must_change: 'the road collects' }
        });

        const detail = store.getSnapshot().phraseDetails.s1;

        // The revised entry carries the route's number, and the other two are the rows the receipt still reports.
        expect(detail?.groups.map((row) => [row.key, row.revision])).toEqual([
            ['chapter_1', 1],
            ['chapter_2', 2],
            ['chapter_3', 1]
        ]);
        // THE BUG THIS PIN: committing the route's `view` into `phrases` would swap the Summary's five groups for
        // three chapter rows and repaint the whole rail.
        expect(store.getSnapshot().phrases.s1?.groups.map((row) => row.key)).toEqual([
            'premise',
            'promise',
            'theme',
            'tone',
            'ending'
        ]);
    });

    it('a refused entry write leaves the cache exactly as it was (F8/R4)', async () => {
        const { store } = harness({
            mode: 'groups',
            revisePhraseEntry: async () => {
                throw new ApiError(409, 'the Writer is rewriting this entry: the revise route refuses until the pass lands');
            }
        });

        await store.openStory('s1');

        const before = store.getSnapshot().phraseDetails.s1;

        expect(
            await store.revisePhraseEntry('s1', 'entry-chapter_1', {
                plotpoints: { must_happen: 'x', must_change: 'y' }
            })
        ).toBeNull();
        expect(store.getSnapshot().phraseDetails.s1).toBe(before);
        expect(store.getSnapshot().phraseDetails.s1?.groups.map((row) => row.revision)).toEqual([1, 1, 1]);
    });

    it('a second store instance starts with no chapter entries at all (P1)', () => {
        const fresh = createDashboardStore(harness({ mode: 'groups' }).client);

        expect(fresh.getSnapshot().phraseDetails).toEqual({});
        expect(fresh.getSnapshot().phraseDetailErrors).toEqual({});
    });
});
