// C2a / R5 (symptom 3, second half) — WHICH PHRASE'S SLOT a group lock/unlock response is filed into.
//
// THE BUG THIS PINS. The lock routes address a group ROW by its uuid, and `state.ts` used to answer `'summary'`
// for any row its caches did not happen to hold. A chapter entry's Phrase-② read that has not landed yet — or has
// landed and gone stale, reporting no such row — therefore fell to the Summary slot, and the desk rendered a
// chapter entry inside the Summary surface: five sections plus a chapter, and a rail lit on Phrase ① while the
// crew worked Phrase ②. That is the mis-slot the Author reads as "the desk is still on Phrase 1".
//
// THE RULE UNDER TEST (`state.ts:surfaceOfLockView` → `groupSurfaceOf` → forced read → `'unassigned'`):
//   1. the response's OWN `PhraseDetailView.key` decides, because `routes.ts:phraseVerbView` picks the refreshed
//      read from the group row's phrase — a Phrase-② answer carries `key:'plotlines'`, and the Summary's
//      `PhraseView` has no `key` at all, so absence IS the Summary's signature;
//   2. else the cache that actually HOLDS the row decides (present is present);
//   3. else, for a Story whose Phrase-② read is wanted, it is fetched ONCE (the `refresh` key is coalesced) —
//      "not loaded" is exactly the state the mis-slot came from;
//   4. else `'unassigned`: a row the desk has not read is a row it may not file, so NOTHING is committed into
//      either slot from that response.
//
// Every assertion reads the exact snapshot slot and the client mock's calls, never a component's ink (the
// pattern `state.plotlines.test.ts` sets). The lock fake TRACKS the lock the way a route does — the re-read
// `mutate` runs afterwards reports the same locked row — so an assertion cannot pass on a stale read.
import { describe, expect, it, vi } from 'vitest';

import { createDashboardStore } from './state';
import type { ApiClient, PhraseDetailView, PhraseGroupLockResult, PhraseView } from './api';
import {
    fakeHarness,
    groupedPhraseView,
    phraseDetailView,
    storyRow,
    storyView
} from './testing/shell-fakes';

/**
 * Two books, `mode` the projected Phrase ② dial, and a lock fake that MOVES THE ROW in every later read.
 *
 * `lockIds` is the book's server state: `lockPhraseGroup` adds the row, and BOTH phrase reads report it. Without
 * that, `mutate`'s re-read would blank the badge the store just committed and the test would be asserting a fake's
 * amnesia rather than the store's slot decision.
 */
function harness(
    options: {
        mode?: 'groups' | 'classic';
        /** `'plotlines'` answers a chapter entry, `'summary'` a Summary section, `'chapters'` a row NEITHER phrase owns. */
        lockKey?: 'plotlines' | 'summary' | 'chapters';
        /**
         * The stale-cache case: the FIRST Phrase ② read answers with no rows at all — the state a read that landed
         * before the entry existed is in — and every later read reports the real, lock-tracking rows. It is a flag
         * rather than a `getPhraseDetail` override so the later reads still track `lockIds` the way a route does.
         */
        emptyFirstRead?: boolean;
        /**
         * Holds the Summary re-read `mutate` runs after the write (every call but the open's own) on a promise the
         * test releases. WHY: the re-read HEALS either slot in a few microtasks, so an assertion that waits for the
         * verb is measuring the repair, not the DECISION. Held open, the snapshot the test reads is the frame the
         * store committed from the response — which is exactly where the mis-slot lived.
         */
        holdSummaryReread?: boolean;
    } = {}
    // The return type is INFERRED rather than written out: the harness's handles (the client, the store, the lock
    // ledger, and the release for the held re-read) are all the fake's own, and a spelled-out shape has to be
    // edited every time a case needs one more of them.
) {
    const rows = [storyRow('s1'), storyRow('s2')];
    const lockIds = new Set<string>();
    const lockKey = options.lockKey ?? 'plotlines';

    /** One row, with the lock the server now holds. */
    const lockOf = (id: string) =>
        lockIds.has(id)
            ? { locked: true, locked_revision: 1, locked_by: 'author' as const, locked_at: '2026-11-09T10:00:00.000Z' }
            : {};

    const getStory = vi.fn(async (storyId: string) => ({
        ...storyView(rows.find((row) => row.id === storyId) ?? storyRow(storyId)),
        plotlines_mode: options.mode ?? 'classic',
        phrase_started: { summary: true, plotlines: options.mode === 'groups' },
        summary_compiled: true
    }));

    // The Summary read: its five sections, each carrying the lock the server holds for it. The gate is the last
    // leg — every call resolves the same rows, only the later ones WAIT, so a test can read the frame the store
    // committed from the verb's own response.
    let phraseCallsMade = 0;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
        release = resolve;
    });
    const getPhrase = vi.fn(async (storyId: string) => {
        phraseCallsMade += 1;
        if (options.holdSummaryReread === true && phraseCallsMade > 1) await hold;

        return groupedPhraseView(storyId, {
            groups: groupedPhraseView(storyId).groups.map((group) => ({ ...group, ...lockOf(group.id) }))
        });
    });

    // Phrase ②'s read: three chapter entries, or the rows a test names.
    const detail = vi.fn(
        (async (storyId: string) =>
            // The stale-cache case: while nothing exists yet, the read reports NO rows — which is the state a read
            // that landed before the entry existed is really in, and the state the mis-slot came from.
            options.emptyFirstRead === true && lockIds.size === 0
                ? phraseDetailView(storyId, { groups: [] })
                : phraseDetailView(storyId, {
                      groups: phraseDetailView(storyId).groups.map((row) => ({ ...row, ...lockOf(row.id) }))
                  }))
    );

    // The route's answer: the lock receipt plus THAT phrase's refreshed read. The `key` is the witness the store
    // reads first — and a `'summary'` answer is the keyless `PhraseView`, exactly as `routes.ts` sends it.
    const lockPhraseGroup = vi.fn(
        async (storyId: string, groupId: string): Promise<PhraseGroupLockResult> => {
            lockIds.add(groupId);

            const view: PhraseView =
                lockKey === 'plotlines'
                    ? (phraseDetailView(storyId, {
                          groups: phraseDetailView(storyId).groups.map((row) => ({ ...row, ...lockOf(row.id) }))
                      }) as unknown as PhraseView)
                    : lockKey === 'chapters'
                      ? // A phrase this desk does not slot: keyed, so the store cannot call it the Summary, and
                        // carrying a row id that lives in neither cache — the shape of a read that has not landed.
                        ({
                            ...phraseDetailView(storyId),
                            key: 'chapters',
                            groups: [{ ...phraseDetailView(storyId).groups[0], id: 'grp-orphan_9', key: 'orphan_9' }]
                        } as unknown as PhraseView)
                      : (groupedPhraseView(storyId, {
                            groups: groupedPhraseView(storyId).groups.map((row) => ({ ...row, ...lockOf(row.id) }))
                        }) as unknown as PhraseView);

            return {
                story_id: storyId,
                phrase_id: lockKey === 'plotlines' ? 'phrase_plotlines_1' : 'phrase_summary_1',
                group_id: groupId,
                locked: true,
                locked_revision: 1,
                locked_by: 'author',
                locked_at: '2026-11-09T10:00:00.000Z',
                view
            };
        }
    );

    const { client, store } = fakeHarness(rows, [], {
        getStory,
        getPhrase,
        getPhraseDetail: detail,
        lockPhraseGroup
    });

    return {
        client,
        store,
        lockedIds: () => Array.from(lockIds),
        /** Lets the held Summary re-read land (a no-op when the harness is not holding). */
        releaseSummaryReread: () => release()
    };
}

/** The Phrase ② read's calls, as plain story ids — the count IS the argument about wasted and forced flights. */
function detailCalls(client: ApiClient): string[] {
    return (client.getPhraseDetail as unknown as { mock: { calls: string[][] } }).mock.calls.map((call) => call[0]);
}

/** Every group row the desk holds for the Story, from either slot — what a mis-slot would have polluted. */
function filedRows(store: ReturnType<typeof createDashboardStore>, storyId: string) {
    const snapshot = store.getSnapshot();

    return [
        ...(snapshot.phrases[storyId]?.groups ?? []),
        ...(snapshot.phraseDetails[storyId]?.groups ?? [])
    ].map((row) => ({ id: row.id, key: row.key, locked: row.locked === true }));
}

/**
 * Lets the store's commits land without waiting on a held re-read — the same two ticks `state.plotlines.test.ts`
 * uses. Deterministic: the held promise never resolves in this window, so nothing races the assertions.
 */
async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('the store — a lock response is filed into the phrase the ANSWER names (C2a/R5)', () => {
    it('a chapter entry’s lock lands in the Phrase ② slot, and the Summary keeps its five sections', async () => {
        const { store } = harness({ mode: 'groups' });

        await store.openStory('s1');
        await store.lockPhraseGroup('s1', 'entry-chapter_2');

        const detail = store.getSnapshot().phraseDetails.s1;

        expect(detail?.key).toBe('plotlines');
        // The lock the route reported, on the row the route named — and only on that row.
        expect(detail?.groups.map((row) => [row.id, row.locked === true])).toEqual([
            ['entry-chapter_1', false],
            ['entry-chapter_2', true],
            ['entry-chapter_3', false]
        ]);
        // THE MIS-SLOT, PUNISHED: committing that read into `phrases` would replace the Summary's five sections
        // with three chapter entries (and repaint the rail's counts).
        expect(store.getSnapshot().phrases.s1?.groups.map((row) => row.key)).toEqual([
            'premise',
            'promise',
            'theme',
            'tone',
            'ending'
        ]);
        expect(store.getSnapshot().groupLockErrors).toEqual({});
    });

    it('a stale Phrase ② read that reports no such entry still files the keyed answer under Phrase ②', async () => {
        // THE STATE THE BUG CAME FROM: the read landed BEFORE the entry existed, so the cache held no row and the
        // old lookup answered `'summary'` from mere absence.
        //
        // WHY THE SUMMARY RE-READ IS HELD: `mutate` re-reads BOTH phrase reads after the write, and a test that
        // awaits the verb is measuring that repair, not the store's decision — either rule lands the same final
        // frame. Held open, the snapshot below is the frame the store COMMITTED from the response.
        const { client, store, releaseSummaryReread } = harness({
            mode: 'groups',
            emptyFirstRead: true,
            holdSummaryReread: true
        });

        await store.openStory('s1');

        expect(store.getSnapshot().phraseDetails.s1?.groups).toEqual([]);

        const write = store.lockPhraseGroup('s1', 'entry-chapter_1');

        await settle();

        // The entry is filed where the ANSWER said it lives.
        expect(store.getSnapshot().phraseDetails.s1?.groups.map((row) => [row.id, row.locked === true])).toEqual([
            ['entry-chapter_1', true],
            ['entry-chapter_2', false],
            ['entry-chapter_3', false]
        ]);
        // THE MIS-SLOT, CAUGHT AT THE MOMENT IT WOULD HAVE HAPPENED: the pre-R5 store wrote this same keyed read
        // into `phrases`, which is how a chapter row came to sit inside the Summary's five sections.
        expect(store.getSnapshot().phrases.s1?.groups.map((row) => row.key)).toEqual([
            'premise',
            'promise',
            'theme',
            'tone',
            'ending'
        ]);
        releaseSummaryReread();
        await write;

        // The keyed answer is authoritative, so the forced read is NOT paid for: one read on open, one on the
        // mutation's own refetch, and nothing in between.
        expect(detailCalls(client)).toEqual(['s1', 's1']);
        expect(store.getSnapshot().groupLockErrors).toEqual({});
    });

    it('a Summary section’s lock keeps the keyless answer in the Summary slot and asks for no Phrase ② read', async () => {
        // A classic book: Phrase ② has no entry surface at all, so this verb must not touch the Phrase ② route —
        // the same `phraseDetailWanted` gate every other Phrase-② read uses.
        const { client, store } = harness({ mode: 'classic', lockKey: 'summary' });

        await store.openStory('s1');

        expect(detailCalls(client)).toEqual([]);

        await store.lockPhraseGroup('s1', 'grp-tone');

        expect(store.getSnapshot().phrases.s1?.groups.map((row) => [row.key, row.locked === true])).toEqual([
            ['premise', false],
            ['promise', false],
            ['theme', false],
            ['tone', true],
            ['ending', false]
        ]);
        // The Absence of a `key` is the Summary's signature (`api.ts:PhraseView` has none), so this path did not
        // move — and the desk paid for no Phrase ② read to find that out.
        expect(detailCalls(client)).toEqual([]);
        expect(store.getSnapshot().phraseDetails.s1).toBeUndefined();
        expect(store.getSnapshot().phraseDetailErrors).toEqual({});
    });

    it('a row neither phrase owns is committed into NEITHER slot, after exactly one forced Phrase ② read', async () => {
        const { client, store } = harness({ mode: 'groups', lockKey: 'chapters' });

        await store.openStory('s1');

        await store.lockPhraseGroup('s1', 'grp-orphan_9');

        const rows = filedRows(store, 's1');

        // THE HONEST ANSWER IS "I HAVE NOT READ THAT ROW". Filing the keyed-but-unslotted response under the
        // Summary is the same invention R5 removes, so the lock the route reported appears nowhere on the desk
        // until a read reports the row.
        expect(rows.some((row) => row.id === 'grp-orphan_9')).toBe(false);
        expect(rows.filter((row) => row.locked === true)).toEqual([]);
        // Both caches keep their OWN rows: five sections, three entries.
        expect(store.getSnapshot().phrases.s1?.groups).toHaveLength(5);
        expect(store.getSnapshot().phraseDetails.s1?.groups.map((row) => row.key)).toEqual([
            'chapter_1',
            'chapter_2',
            'chapter_3'
        ]);
        // One open read, one FORCED read (the cache was empty of the row and the Story wants the read), and one
        // refetch. The forced read is coalesced — at most one flight per decision, never a poll.
        expect(detailCalls(client)).toEqual(['s1', 's1', 's1']);
    });

    it('an unslotted row on a classic book chases no Phrase ② read at all, and still files nothing', async () => {
        // Held again, for the same reason as the stale-read case: on a classic book the Summary re-read is the ONLY
        // thing that could paper over a wrong commit, and it is the very leg the mis-slot wrote into.
        const { client, store, releaseSummaryReread } = harness({
            mode: 'classic',
            lockKey: 'chapters',
            holdSummaryReread: true
        });

        await store.openStory('s1');

        const write = store.lockPhraseGroup('s1', 'grp-orphan_9');

        await settle();

        // `phraseDetailWanted` is false: the dial says the entries are not this book's surface, so "not loaded" is
        // a fact about the book, not a gap to chase.
        expect(detailCalls(client)).toEqual([]);
        expect(store.getSnapshot().phraseDetails.s1).toBeUndefined();
        expect(filedRows(store, 's1').some((row) => row.id === 'grp-orphan_9')).toBe(false);
        expect(filedRows(store, 's1').filter((row) => row.locked === true)).toEqual([]);
        expect(store.getSnapshot().phrases.s1?.groups).toHaveLength(5);

        releaseSummaryReread();
        await write;

        // The lock did not fail: the write succeeded, it simply owns no slot this desk has.
        expect(store.getSnapshot().groupLockErrors).toEqual({});
        expect(store.getSnapshot().storyViews.s1?.story.id).toBe('s1');
    });
});
