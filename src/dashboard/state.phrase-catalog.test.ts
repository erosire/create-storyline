/**
 * state.phrase-catalog.test.ts — the STARTABLE PHRASE CATALOG in the store (R1).
 *
 * The create form's phrase selector, its "what will this book open on?" sentence and its start
 * control all read `snapshot.phraseCatalog`, and the shape of that slot is the whole contract:
 *
 *   - the catalog is the SERVER's list (`GET /phrases`), cached as-is — the store pre-filters
 *     nothing, because "pressable" is `starts_on_demand` and "starts on create" is
 *     `starts_on_create`, and a store that dropped the on-create row would take the Author's
 *     knowledge of what the book does with them out of the desk;
 *   - it is ONE global read, not one per book: a create has no story id to key it on yet;
 *   - `null` and `[]` are different facts and the form prints a different sentence for each —
 *     `null` is "the desk does not know" (never fetched, or the read failed) and `[]` is "this
 *     build offers no on-demand phrase". A 503 that committed `[]` would print the second
 *     sentence over the first, which is the honesty this suite pins;
 *   - a failure is CACHED (`phraseCatalogError`) and retriable: it never sticks over a later
 *     read that answers.
 */
import { describe, expect, it, vi } from 'vitest';

import { ApiError, type ApiClient, type PhraseCatalogEntry } from './api';
import { fakeHarness, storyRow } from './testing/shell-fakes';
import { PHRASE_CATALOG_ROWS } from './testing/product-values';

/**
 * The desk over one Story, with `GET /phrases` under the test's control. The fake is wrapped in
 * `vi.fn` by `fakeHarness`'s override path, so the call count is the read's own.
 */
function harness(overrides: { getPhraseCatalog?: ApiClient['getPhraseCatalog'] } = {}) {
    return fakeHarness([storyRow('s1', { title: 'Hollow Sea' })], [], {
        getPhraseCatalog: vi.fn(overrides.getPhraseCatalog ?? (async () => PHRASE_CATALOG_ROWS))
    });
}

/** The catalog read's calls, one entry per request. */
function catalogCalls(client: ApiClient): number {
    return (client.getPhraseCatalog as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
}

/**
 * The stream handler is synchronous and the refresh it starts is not, so a test that boots the desk
 * has to let the chain settle. Two macrotask turns cover the client's own awaits without reaching any
 * timer this store owns.
 */
async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('the store — the phrase catalog (R1)', () => {
    it('caches the catalog exactly as the Server ordered it, with both start flags intact', async () => {
        const { client, store } = harness();

        await store.reload();

        // The selector's order IS the catalog's order, and the store re-sorts nothing: a future kind
        // reaches the form in the place the server put it.
        expect(store.getSnapshot().phraseCatalog).toEqual(PHRASE_CATALOG_ROWS);
        expect(
            (store.getSnapshot().phraseCatalog ?? []).map((row) => [
                row.key,
                row.starts_on_create,
                row.starts_on_demand
            ])
        ).toEqual([
            ['summary', true, false],
            ['plotlines', false, true]
        ]);
        expect(store.getSnapshot().phraseCatalogError).toBeNull();
        expect(catalogCalls(client)).toBe(1);
    });

    it('reads the catalog when the desk boots, so the form never fills in under the Author\'s hand', async () => {
        const { client, store } = harness();

        // `start()` is first paint: the home desk IS the create form for an Author with no Story open,
        // and a selector that arrives after the paint is a control that moves under a hand already on it.
        store.start();
        await flush();

        expect(catalogCalls(client)).toBe(1);
        expect(store.getSnapshot().phraseCatalog?.map((row) => row.key)).toEqual(['summary', 'plotlines']);
        // The boot read is global, so it happens with no Story open at all.
        expect(store.getSnapshot().activeStoryId).toBeNull();
    });

    it('asks once for the whole desk: opening a Story adds no catalog read', async () => {
        const { client, store } = harness();

        await store.reload();
        await store.openStory('s1');
        await store.reload();

        // The catalog is a capability list, not a per-book projection: `POST /stories` takes a catalog
        // key on a book that does not exist yet, so nothing about it depends on which Story is open.
        // (The second reload is the desk's own reload, which is allowed to re-read; see the next case.)
        expect(catalogCalls(client)).toBe(2);
        expect(store.getSnapshot().phraseCatalog).toEqual(PHRASE_CATALOG_ROWS);
    });

    it('re-reads on reload, so a phrase kind the server turns on mid-session reaches the form', async () => {
        let rows: PhraseCatalogEntry[] = PHRASE_CATALOG_ROWS.slice(0, 1);
        const { client, store } = harness({ getPhraseCatalog: async () => rows });

        await store.reload();
        expect(store.getSnapshot().phraseCatalog?.map((row) => row.key)).toEqual(['summary']);

        rows = PHRASE_CATALOG_ROWS;
        await store.reload();

        // The cache is a mirror, not a memory: the desk shows what the server offers NOW, including a
        // kind that was not enabled when the desk booted.
        expect(store.getSnapshot().phraseCatalog?.map((row) => row.key)).toEqual(['summary', 'plotlines']);
        expect(catalogCalls(client)).toBe(2);
    });

    it('keeps the slot unknown and caches the route\'s own sentence when the read fails', async () => {
        const { store } = harness({
            getPhraseCatalog: async () => {
                throw new ApiError(503, 'the phrase catalog is unavailable');
            }
        });

        await store.reload();

        // ABSENT, NOT EMPTY: the read did not answer, so the form must say "the desk cannot tell what a
        // book can open on" rather than "this build starts nothing on demand".
        expect(store.getSnapshot().phraseCatalog).toBeNull();
        expect(store.getSnapshot().phraseCatalogError).toBe('the phrase catalog is unavailable');
        // The server's sentence travels on the shell's strip too, verbatim (L-13) — the desk adds nothing.
        expect(store.getSnapshot().error).toBe('the phrase catalog is unavailable');
        // A failed catalog read never took the rest of the desk with it.
        expect(store.getSnapshot().stories.map((row) => row.id)).toEqual(['s1']);
    });

    it('treats an empty catalog as a legal answer, and still tells it apart from a failure', async () => {
        let failure = false;
        const { store } = harness({
            getPhraseCatalog: async () => {
                if (failure) throw new ApiError(503, 'the phrase catalog is unavailable');

                return [];
            }
        });

        await store.reload();

        // `[]` means this build offers no startable phrase — a fact about the server, and the one case
        // where an empty list is the whole answer.
        expect(store.getSnapshot().phraseCatalog).toEqual([]);
        expect(store.getSnapshot().phraseCatalogError).toBeNull();

        failure = true;
        await store.reload();

        // The failure does NOT leave the stale `[]` in the slot: the desk would otherwise keep claiming
        // "this build starts nothing" through an outage that has no opinion about it.
        expect(store.getSnapshot().phraseCatalog).toBeNull();
        expect(store.getSnapshot().phraseCatalogError).toBe('the phrase catalog is unavailable');
    });

    it('clears the cached refusal as soon as a later read answers', async () => {
        let failure = true;
        const { store } = harness({
            getPhraseCatalog: async () => {
                if (failure) throw new ApiError(503, 'the phrase catalog is unavailable');

                return PHRASE_CATALOG_ROWS;
            }
        });

        await store.reload();
        expect(store.getSnapshot().phraseCatalog).toBeNull();

        failure = false;
        await store.reload();

        expect(store.getSnapshot().phraseCatalog).toEqual(PHRASE_CATALOG_ROWS);
        expect(store.getSnapshot().phraseCatalogError).toBeNull();
    });

    it('hands a create the phrase key the form chose, and re-reads that phrase\'s own rows', async () => {
        const { client, store } = harness();

        await store.reload();

        await store.createStory({ title: 'Hollow Sea', idea: 'A smuggler pays the tide.', start_phrase: 'plotlines' });

        const snapshot = store.getSnapshot();

        // The created book becomes THE story, and the phrase the create started is read on its own key —
        // the pane's Seed (R3) comes from that read, which the rail has not asked for on a one-frame-old book.
        expect(snapshot.activeStoryId).toBe('story_new');
        expect(snapshot.phraseDetails.story_new).toBeDefined();
        // The landing hint is the shell's to spend, so the store keeps it until the frame proves the start.
        expect(snapshot.phraseLanding).toEqual({ story_id: 'story_new', phrase_key: 'plotlines' });
        expect(store.takePhraseLanding()).toEqual({ story_id: 'story_new', phrase_key: 'plotlines' });
        expect(store.takePhraseLanding()).toBeNull();
        // The key the FORM picked is the key the read is addressed with — not a default the store
        // invented, and not the Summary the rail would otherwise open.
        expect(
            (client.getPhraseDetail as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
                (call) => [call[0], call[1]]
            )
        ).toEqual([['story_new', 'plotlines']]);
    });
});
