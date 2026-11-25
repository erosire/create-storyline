// T5 / R1 + R2 — the group-LOCK verbs in the STORE, where the desk's memory actually lives.
//
// A pane's badge is read off `snapshot.phrases[storyId]`, and its refusal line off
// `snapshot.groupLockErrors`, so this suite answers what a component test cannot:
//
//   - the lock route's refreshed phrase read is COMMITTED (the badge and the rail move in the frame the Author
//     clicked in), and a response that carried no group rows is not faked into a commit — `mutate`'s own re-read
//     is what puts the new state on screen (P1: the durable store is the only memory);
//   - a refusal is cached PER GROUP under `<storyId>:<groupId>` (the one key builder the pane and the store
//     share, `api.ts:groupLockKey`), names WHICH verb was refused, and keeps the server's sentence verbatim
//     (L-13) — and the cached phrase read is left exactly as it was, which is why a refused lock can never read
//     as a success: the badge would have to come from rows the server never sent;
//   - the sentence is cleared by the next successful write on THAT group, and a delete drops the deleted
//     Story's sentences rather than stranding them under keys nobody reads;
//   - the Editor-locking Setting is one `PATCH /stories/:id` key, written as an explicit boolean so OFF is
//     tellable from "the body never mentioned it" (absent means off).
import { describe, expect, it, vi } from 'vitest';

import { createDashboardStore } from './state';
import { ApiError, type ApiClient, type PhraseGroupLockResult, type PhraseView } from './api';
import { fakeHarness, groupedPhraseView, storyRow } from './testing/shell-fakes';

/** The grouped read with Tone locked in — the body the lock route answers with. */
function lockedPhrase(storyId: string): PhraseView {
    const phrase = groupedPhraseView(storyId);

    return {
        ...phrase,
        groups: phrase.groups.map((group) =>
            group.id === 'grp-tone'
                ? {
                      ...group,
                      locked: true,
                      locked_revision: 1,
                      locked_by: 'author' as const,
                      locked_at: '2026-11-11T09:00:00.000Z'
                  }
                : group
        )
    };
}

/** Two group-managed books, with the phrase read under the test's control. */
function harness(overrides: Partial<ApiClient> = {}) {
    return fakeHarness([storyRow('s1'), storyRow('s2')], [], {
        getPhrase: vi.fn(async (storyId: string) => groupedPhraseView(storyId)),
        ...overrides
    });
}

/** The recorded calls of one fake method, as plain argument lists. */
function calls(client: ApiClient, name: keyof ApiClient): unknown[][] {
    return (client[name] as unknown as { mock: { calls: unknown[][] } }).mock.calls;
}

/** The group row the cached read currently reports. */
function groupRow(store: ReturnType<typeof createDashboardStore>, storyId: string, groupId: string) {
    return store.getSnapshot().phrases[storyId]?.groups.find((group) => group.id === groupId);
}

describe('the store — the lock commits the read the route answered (R1)', () => {
    it('calls the route for the Story and group it was told, and commits the refreshed rows', async () => {
        const lockPhraseGroup = vi.fn(
            async (storyId: string, groupId: string): Promise<PhraseGroupLockResult> => ({
                story_id: storyId,
                phrase_id: 'phrase_summary_1',
                group_id: groupId,
                locked: true,
                locked_revision: 1,
                locked_by: 'author',
                locked_at: '2026-11-11T09:00:00.000Z',
                view: lockedPhrase(storyId)
            })
        );
        // A read that reflects the lock once the route has answered it: the store commits the response's rows AND
        // `mutate` re-reads the book, so this fake must not report an unlocked group after a successful lock, or it
        // would be describing a server that locked the group and then forgot.
        const getPhrase = vi.fn(async (storyId: string) =>
            lockPhraseGroup.mock.calls.length > 0 ? lockedPhrase(storyId) : groupedPhraseView(storyId)
        );
        const { client, store } = harness({ getPhrase, lockPhraseGroup });

        await store.openStory('s1');

        expect(await store.lockPhraseGroup('s1', 'grp-tone')).toEqual({
            story_id: 's1',
            phrase_id: 'phrase_summary_1',
            group_id: 'grp-tone',
            locked: true,
            locked_revision: 1,
            locked_by: 'author',
            locked_at: '2026-11-11T09:00:00.000Z',
            view: lockedPhrase('s1')
        });
        // The route addresses the GROUP, by the pair the pane's confirm click produced — the UUID, never a key.
        expect(calls(client, 'lockPhraseGroup')).toEqual([['s1', 'grp-tone']]);
        expect(groupRow(store, 's1', 'grp-tone')?.locked).toBe(true);
        expect(groupRow(store, 's1', 'grp-tone')?.locked_by).toBe('author');
        expect(groupRow(store, 's1', 'grp-tone')?.locked_revision).toBe(1);
        // One read for the open, one for the mutation's refresh — the response's rows land first, and the re-read
        // agrees with them, which is what a real lock route answers.
        expect(getPhrase).toHaveBeenCalledTimes(2);
        expect(store.getSnapshot().groupLockErrors).toEqual({});
    });

    it('opens a locked group the same way, and commits the read that says it is open again', async () => {
        const unlockPhraseGroup = vi.fn(async (storyId: string): Promise<PhraseGroupLockResult> => ({
            story_id: storyId,
            group_id: 'grp-tone',
            locked: false,
            locked_revision: null,
            locked_by: null,
            locked_at: null,
            view: groupedPhraseView(storyId)
        }));
        const { client, store } = harness({ unlockPhraseGroup });

        await store.openStory('s1');
        await store.unlockPhraseGroup('s1', 'grp-tone');

        expect(calls(client, 'unlockPhraseGroup')).toEqual([['s1', 'grp-tone']]);
        expect(groupRow(store, 's1', 'grp-tone')?.locked).toBeUndefined();
        expect(store.getSnapshot().groupLockErrors).toEqual({});
    });

    it('commits nothing it invented when the route answers without rows, and lets the store’s own re-read land', async () => {
        // The lock wave is allowed to answer the plain verdict (`{locked:true}`) with no `view`; the client's
        // result type makes every field optional for exactly that reason. Inventing group rows here would put a
        // badge on text nobody read, so the cache keeps the read and `mutate`'s refresh replaces it.
        const getPhrase = vi.fn(async (storyId: string) =>
            getPhrase.mock.calls.length > 1 ? lockedPhrase(storyId) : groupedPhraseView(storyId)
        );
        const { store } = harness({
            getPhrase,
            lockPhraseGroup: async (storyId: string, groupId: string): Promise<PhraseGroupLockResult> => ({
                story_id: storyId,
                group_id: groupId,
                locked: true
            })
        });

        await store.openStory('s1');
        await store.lockPhraseGroup('s1', 'grp-tone');

        // One read on open, one on the mutation's refresh — and the locked row arrives from the READ, not from
        // a cache entry the store would have had to guess at.
        expect(getPhrase).toHaveBeenCalledTimes(2);
        expect(groupRow(store, 's1', 'grp-tone')?.locked).toBe(true);
    });
});

describe('the store — a refused lock is cached where the pane can print it (R1, L-13)', () => {
    it('caches the server’s sentence per group, names the verb, and leaves the cached rows untouched', async () => {
        const refusal = 'the Writer is replacing this group right now (run_write_groups_1), so the lock would commit text about to move (R4).';
        const { store } = harness({
            lockPhraseGroup: async () => {
                throw new ApiError(409, refusal);
            }
        });

        await store.openStory('s1');
        const before = store.getSnapshot().phrases.s1;

        expect(await store.lockPhraseGroup('s1', 'grp-tone')).toBeNull();
        expect(store.getSnapshot().groupLockErrors).toEqual({
            's1:grp-tone': `Locking this group was refused: ${refusal}`
        });
        // The top bar's strip carries the same sentence, and the rows are the ones the server still reports:
        // `locked` never moved, so the pane prints a refusal AND an open group, which is the truth.
        expect(store.getSnapshot().error).toBe(refusal);
        expect(store.getSnapshot().phrases.s1).toBe(before);
        expect(groupRow(store, 's1', 'grp-tone')?.locked).toBeUndefined();
        // `mutate` short-circuits on the refusal, so nothing was re-read into a state nobody wrote.
        expect(store.getSnapshot().phrases.s1?.groups.map((group) => group.locked)).toEqual([
            undefined,
            undefined,
            undefined,
            undefined,
            undefined
        ]);
    });

    it('says UNLOCKING for an unlock refusal, so the two refusals cannot be read as each other', async () => {
        const { store } = harness({
            unlockPhraseGroup: async () => {
                throw new ApiError(403, 'only the Author unlocks a group (R1)');
            }
        });

        await store.openStory('s1');
        await store.unlockPhraseGroup('s1', 'grp-tone');

        expect(store.getSnapshot().groupLockErrors).toEqual({
            's1:grp-tone': 'Unlocking this group was refused: only the Author unlocks a group (R1)'
        });
    });

    it('clears the sentence for the group that succeeded, and keeps the one that is still true', async () => {
        const { store } = harness({
            lockPhraseGroup: async (storyId: string, groupId: string): Promise<PhraseGroupLockResult> => {
                if (groupId === 'grp-ending') {
                    throw new ApiError(409, 'this group has no revision to lock in — write it first (R1)');
                }

                return { story_id: storyId, group_id: groupId, locked: true, view: lockedPhrase(storyId) };
            }
        });

        await store.openStory('s1');
        await store.lockPhraseGroup('s1', 'grp-tone');
        await store.lockPhraseGroup('s1', 'grp-ending');

        expect(Object.keys(store.getSnapshot().groupLockErrors)).toEqual(['s1:grp-ending']);

        await store.lockPhraseGroup('s1', 'grp-tone');

        // The success cleared Tone's line (there is one), and Ending's stays until that group's own write
        // answers it — a refusal about one section must not vanish because a sibling succeeded.
        expect(store.getSnapshot().groupLockErrors).toEqual({
            's1:grp-ending':
                'Locking this group was refused: this group has no revision to lock in — write it first (R1)'
        });
    });

    it('drops a deleted Story’s sentences, and no one else’s', async () => {
        const { store } = harness({
            lockPhraseGroup: async () => {
                throw new ApiError(409, 'this Story is stopped, and nothing may be committed (R1)');
            }
        });

        await store.openStory('s1');
        await store.lockPhraseGroup('s1', 'grp-tone');
        await store.openStory('s2');
        await store.lockPhraseGroup('s2', 'grp-tone');

        expect(Object.keys(store.getSnapshot().groupLockErrors).sort()).toEqual([
            's1:grp-tone',
            's2:grp-tone'
        ]);

        await store.deleteStory('s1');

        expect(store.getSnapshot().groupLockErrors).toEqual({
            's2:grp-tone': 'Locking this group was refused: this Story is stopped, and nothing may be committed (R1)'
        });
    });
});

describe('the store — the Editor-locking Setting is one Story patch (R2)', () => {
    it('sends the key with the boolean the Author clicked, both ways round', async () => {
        // The route's own answer is the Story row; `mutate` ignores it and re-reads the book (P1), and what this
        // test pins is the BODY the Setting write sent, which is the only thing a PATCH can lose.
        const patchStory = vi.fn(async (storyId: string) => storyRow(storyId));
        const { client, store } = harness({ patchStory });

        await store.openStory('s1');
        await store.setEditorGroupLocking('s1', true);
        await store.setEditorGroupLocking('s1', false);

        // OFF is a body the server can tell apart from "the body never mentioned it", which is what every other
        // dial on this pane does too: absent means off, so an omitted key would be a guess.
        expect(calls(client, 'patchStory')).toEqual([
            ['s1', { editor_group_locking: true }],
            ['s1', { editor_group_locking: false }]
        ]);
    });
});
