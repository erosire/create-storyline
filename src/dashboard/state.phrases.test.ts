// SUMMARY PHRASE R6 — the phrase read lives in the STORE, not in a component.
//
// The rail's group rows, the Overview's per-group state and the group pane all read
// `snapshot.phrases[storyId]`, so this suite answers the question a component test cannot: WHEN does the
// desk ask the server about the Summary Phrase, and what does a refusal do to the rest of the desk?
//
//   - one read per open, per mutation that touches the Story, per stream event naming the open Story, and
//     per explicit reload — never one per component, and never a timer of its own;
//   - a refusal is cached PER STORY as the server's own sentence (`phraseErrors`, L-13) while the Story
//     payload, the queue and the crew stay on screen;
//   - the group's one write (`revisePhraseGroup`) commits the fresh view the route answers with, then runs
//     the same re-read choreography every other mutation runs (P1: the server is the only memory).
import { describe, expect, it, vi } from 'vitest';

import { createDashboardStore } from './state';
import { ApiError, type ApiClient, type PhraseGroupReviseResult, type StreamKind } from './api';
import { fakeHarness, groupedPhraseView, storyRow } from './testing/shell-fakes';

/**
 * Two books, both group-managed, with the phrase read (and the stream handler) under the test's control.
 *
 * The fake's DEFAULT phrase is the sampling echo of a legacy book, so a grouped test names the read —
 * that default is what keeps the pre-R6 shell tests reading exactly as they did.
 */
function harness(overrides: { getPhrase?: ApiClient['getPhrase']; revisePhraseGroup?: ApiClient['revisePhraseGroup'] } = {}) {
    const stream: { handler: ((kind: StreamKind, storyId?: string) => void) | undefined } = { handler: undefined };
    const getPhrase = vi.fn(overrides.getPhrase ?? (async (storyId: string) => groupedPhraseView(storyId)));
    const revisePhraseGroup = vi.fn(
        overrides.revisePhraseGroup ??
            (async (storyId: string) => ({
                story_id: storyId,
                phrase_id: 'phrase_summary_1',
                revision: 2,
                installed: [{ group_id: 'grp-tone', group_key: 'tone', revision_id: 'rev-tone-2', number: 2 }],
                archived: [{ group_id: 'grp-tone', group_key: 'tone', revision_id: 'rev-tone-1', number: 1 }],
                mirror: { summary_id: 'sum_1', fields: ['tone'], written: true },
                view: groupedPhraseView(storyId)
            }))
    );

    return {
        stream,
        getPhrase,
        revisePhraseGroup,
        ...fakeHarness([storyRow('s1'), storyRow('s2')], [], {
            getPhrase,
            revisePhraseGroup,
            subscribeEvents: vi.fn((handler: (kind: StreamKind, storyId?: string) => void) => {
                stream.handler = handler;

                return () => {
                    stream.handler = undefined;
                };
            })
        })
    };
}

/** The phrase-read calls, as plain story ids — the assertion a reader can check at a glance. */
function phraseCalls(client: ApiClient): string[] {
    return (client.getPhrase as unknown as { mock: { calls: string[][] } }).mock.calls.map((call) => call[0]);
}

/**
 * A stream handler is synchronous and the refresh it starts is not, so a test that fires an event has to
 * let the store's chain settle before reading the snapshot. Two macrotask turns cover the client's own
 * awaits without reaching any timer this store owns.
 */
async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('the store — the phrase read rides the Story lifecycle (R6)', () => {
    it('reads the phrase once when the Story opens, and caches it under its own Story id', async () => {
        const { client, store } = harness();

        await store.reload();
        // On the desk's home view nothing has asked about a Summary Phrase: the read belongs to a Story.
        expect(phraseCalls(client)).toEqual([]);
        expect(store.selectedPhrase()).toBeNull();

        await store.openStory('s1');

        expect(phraseCalls(client)).toEqual(['s1']);
        expect(store.getSnapshot().phrases.s1?.story_id).toBe('s1');
        expect(store.getSnapshot().phrases.s1?.mode).toBe('groups');
        expect(store.getSnapshot().phrases.s1?.groups.map((group) => group.key)).toEqual([
            'premise',
            'promise',
            'theme',
            'tone',
            'ending'
        ]);
        expect(store.getSnapshot().phraseErrors).toEqual({});
        expect(store.selectedPhrase()?.story_id).toBe('s1');
    });

    it('keeps one cached read per Story, and follows the Story the Author is standing on', async () => {
        const { client, store } = harness();

        await store.openStory('s1');
        await store.openStory('s2');

        expect(phraseCalls(client)).toEqual(['s1', 's2']);
        expect(Object.keys(store.getSnapshot().phrases).sort()).toEqual(['s1', 's2']);
        expect(store.selectedPhrase()?.story_id).toBe('s2');
    });

    it('reads the new book’s groups the moment it is created, because a new Story is group-managed', async () => {
        const { client, store } = harness();

        await store.reload();
        await store.createStory({ idea: 'A keeper of a lighthouse begins lying to the sea.', chapter_count: 3 });

        expect(phraseCalls(client)).toEqual(['story_new']);
        expect(store.getSnapshot().phrases.story_new?.groups).toHaveLength(5);
    });

    it('re-reads the phrase with every other read on an explicit reload, and only the open Story’s', async () => {
        const { client, store } = harness();

        await store.reload();
        expect(phraseCalls(client)).toEqual([]);

        await store.openStory('s1');
        await store.reload();

        expect(phraseCalls(client)).toEqual(['s1', 's1']);
    });

    it("drops the deleted book's rows and its cached refusal with it", async () => {
        const { store } = harness({
            getPhrase: async (storyId: string) => {
                if (storyId === 's1') {
                    throw new ApiError(404, 'this Story has no Summary Phrase');
                }

                return groupedPhraseView(storyId);
            }
        });

        await store.openStory('s1');
        expect(store.getSnapshot().phrases.s1).toBeUndefined();
        expect(store.getSnapshot().phraseErrors.s1).toBe('this Story has no Summary Phrase');

        await store.deleteStory('s1');

        // A Story id can come back (a re-import), and a refusal from the dead book must not outlive it.
        expect(store.getSnapshot().phrases.s1).toBeUndefined();
        expect(store.getSnapshot().phraseErrors.s1).toBeUndefined();
    });
});

describe('the store — a refused phrase read is a sentence, not an empty Summary (L-13)', () => {
    it('caches the server’s own sentence per Story and leaves the Story payload standing', async () => {
        const { store } = harness({
            getPhrase: async () => {
                throw new ApiError(404, 'this Story has no Summary Phrase');
            }
        });

        await store.openStory('s1');

        // The rail's honest answer: no rows (so the pane says the read failed, not that nothing is
        // written), and the reason the server itself gave.
        expect(store.getSnapshot().phrases.s1).toBeUndefined();
        expect(store.getSnapshot().phraseErrors.s1).toBe('this Story has no Summary Phrase');
        // The strip is cleared by the surrounding mutation's own refetch round (`mutate` resets it after
        // every re-read settles), which is why the PER-Story cache is the copy the panes read.
        expect(store.getSnapshot().error).toBeNull();
        // …and the rest of the desk is untouched: this is the defect class the cache exists for.
        expect(store.selectedStory()?.story.id).toBe('s1');
        expect(store.getSnapshot().storyViews.s1).toBeTruthy();
    });

    it('raises the refusal into the shell’s error strip when the read fails outside a mutation', async () => {
        const { store, stream } = harness({
            getPhrase: async () => {
                throw new ApiError(503, 'the phrase read is unavailable');
            }
        });

        await store.openStory('s1');
        // `mutate` cleared the strip at the end of the open (the per-Story cache kept the sentence), and
        // the stream handler exists only once the shell has started.
        expect(store.getSnapshot().error).toBeNull();
        store.start();
        expect(stream.handler).toBeTypeOf('function');

        stream.handler?.('story', 's1');
        await flush();

        expect(store.getSnapshot().error).toBe('the phrase read is unavailable');
        expect(store.getSnapshot().phraseErrors.s1).toBe('the phrase read is unavailable');
        // A failed group read never took the Story payload with it.
        expect(store.selectedStory()?.story.id).toBe('s1');
    });

    it('clears the cached refusal as soon as a later read answers', async () => {
        let fail = true;
        const { store } = harness({
            getPhrase: async (storyId: string) => {
                if (fail) {
                    throw new ApiError(503, 'the phrase read is unavailable');
                }

                return groupedPhraseView(storyId);
            }
        });

        await store.openStory('s1');
        expect(store.getSnapshot().phraseErrors.s1).toBe('the phrase read is unavailable');

        fail = false;
        // The retry is not a special case: it is the next event or mutation, which is how every other
        // failed read in this store recovers.
        await store.stop('s1');

        expect(store.getSnapshot().phrases.s1?.story_id).toBe('s1');
        expect(store.getSnapshot().phraseErrors.s1).toBeUndefined();
    });
});

describe('the store — every write re-reads the group rows (R6)', () => {
    it('re-reads the phrase after a mutation that touches the Story, exactly once per mutation', async () => {
        const { client, store } = harness();

        await store.openStory('s1');
        await store.stop('s1');

        // A Writer install, a finding scope change and a dispatched group pass are all rows of THIS read,
        // so the rail answers in the frame the Author clicked in. One flight, not one per panel.
        expect(phraseCalls(client)).toEqual(['s1', 's1']);
    });

    it('reads the phrase rows of the Story a mutation touched, not the open Story’s', async () => {
        const { client, store } = harness();

        await store.openStory('s1');
        await store.stop('s2');

        // `mutate` re-reads what the SERVER may have changed, and the phrase rows belong to the Story the
        // verb named. The open book's rail is left holding its own (current) rows until its next event,
        // mutation, or open — which is why a mutation on another book must not burn a read on this one.
        expect(phraseCalls(client)).toEqual(['s1', 's2']);
        expect(Object.keys(store.getSnapshot().phrases).sort()).toEqual(['s1', 's2']);
    });

    it('re-reads the phrase on a stream event that names the open Story', async () => {
        const { client, store, stream } = harness();

        await store.openStory('s1');
        store.start();
        expect(stream.handler).toBeTypeOf('function');
        expect(store.getSnapshot().phrases.s1).toBeTruthy();

        stream.handler?.('story', 's1');
        await flush();

        // The group rail is the Author's Summary surface: a Writer install or a dispatched group pass
        // lands on these rows, so the event that says "this Story changed" re-reads them with the Story.
        expect(phraseCalls(client)).toEqual(['s1', 's1']);
    });

    it('leaves the phrase read alone on a crew-only event, and on an event about another Story', async () => {
        const { client, store, stream } = harness();

        await store.openStory('s1');
        store.start();

        stream.handler?.('runs', 's1');
        stream.handler?.('queue');
        stream.handler?.('story', 's2');
        await flush();

        // The crew's roster and the desk's queue are not the Summary's rows, and a Story the Author is not
        // standing on is not this rail's business. (Its rows come back on the next open.)
        expect(phraseCalls(client)).toEqual(['s1']);
    });
});

describe('the store — the group write commits the view the route answers with (R2)', () => {
    it('sends the group id and the input, then shows the installed revision without a hand-patch', async () => {
        const fresh = groupedPhraseView('s1', {
            revision: 2,
            groups: groupedPhraseView('s1').groups.map((group) =>
                group.key === 'tone'
                    ? { ...group, revision: 2, content: 'Plain sentences, salt in every image.' }
                    : group
            )
        });
        const result: PhraseGroupReviseResult = {
            story_id: 's1',
            phrase_id: 'phrase_summary_1',
            revision: 2,
            installed: [{ group_id: 'grp-tone', group_key: 'tone', revision_id: 'rev-tone-2', number: 2 }],
            archived: [{ group_id: 'grp-tone', group_key: 'tone', revision_id: 'rev-tone-1', number: 1 }],
            mirror: { summary_id: 'sum_1', fields: ['tone'], written: true },
            view: fresh
        };
        // The route and the follow-up read agree, exactly as they do on the server: the install report and
        // `GET /stories/:id/phrases` come from one commit, so the pane cannot show two different numbers.
        const { client, store, revisePhraseGroup } = harness({
            revisePhraseGroup: async () => result,
            getPhrase: async () => fresh
        });

        await store.openStory('s1');
        const committed = await store.revisePhraseGroup('s1', 'grp-tone', {
            content: 'Plain sentences, salt in every image.',
            note: 'the last revision lost the salt'
        });

        expect(client.revisePhraseGroup).toHaveBeenCalledTimes(1);
        expect(revisePhraseGroup.mock.calls[0]).toEqual([
            's1',
            'grp-tone',
            { content: 'Plain sentences, salt in every image.', note: 'the last revision lost the salt' }
        ]);
        expect(committed).toEqual(result);
        // The install report IS the new state: the pane reads Tone at Revision 2, with its archived count.
        expect(store.getSnapshot().phrases.s1).toEqual(fresh);
        expect(store.getSnapshot().phrases.s1?.groups.find((group) => group.key === 'tone')?.revision).toBe(2);
    });

    it('re-reads the phrase after the write, so a number the route did not return cannot be guessed at', async () => {
        const { client, store } = harness();

        await store.openStory('s1');
        await store.revisePhraseGroup('s1', 'grp-tone', { content: 'a colder sentence' });

        // `mutate`'s choreography: the write, then the Story, the knowledge and the phrase read. The
        // committed install report and the re-read agree because the server is the only memory (P1).
        expect(phraseCalls(client)).toEqual(['s1', 's1']);
        expect(store.getSnapshot().error).toBeNull();
    });

    it('keeps the cache untouched when the route refuses the write (F8/R4)', async () => {
        const { client, store } = harness({
            revisePhraseGroup: async () => {
                throw new ApiError(409, 'the Writer is rewriting this group; try again when its revision lands');
            }
        });

        await store.openStory('s1');
        const before = store.getSnapshot().phrases.s1;

        await store.revisePhraseGroup('s1', 'grp-theme', { content: 'a second hand on the same sentence' });

        // The 409 reaches the strip (`mutate`'s own catch, which does not run the refetch round), and the
        // rows stay exactly as the last read had them: the pane's disabled control is the guard, and a
        // refusal must not corrupt the book on screen.
        expect(store.getSnapshot().error).toBe(
            'the Writer is rewriting this group; try again when its revision lands'
        );
        expect(store.getSnapshot().phrases.s1).toBe(before);
        // The refusal short-circuits `mutate`, so the re-read round never runs — no extra phrase flight.
        expect(phraseCalls(client)).toEqual(['s1']);
    });
});

describe('the store — the phrase cache is the shell’s only phrase memory', () => {
    it('a second store instance starts with no group rows at all', () => {
        const fresh = createDashboardStore(fakeHarness([storyRow('s1')], []).client);

        expect(fresh.getSnapshot().phrases).toEqual({});
        expect(fresh.getSnapshot().phraseErrors).toEqual({});
        expect(fresh.selectedPhrase()).toBeNull();
    });
});
