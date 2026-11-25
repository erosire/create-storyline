// T5 / R1 + R2 — the LOCK verbs in the BINDING LAYER: the pane's click shape → the store verb, and the cached
// refusal set → the frame the pane reads.
//
// Why this file exists next to `shell-binding.test.ts` (and not inside it): the lock pair and the Editor-locking
// dial are a new contract, and the routing rules below are the ONLY place a pane's argument list becomes a route
// call. Two things can go wrong here and neither is visible from a component test:
//
//   1. THE GROUP IS THE ADDRESS. `lockPhraseGroup('grp-tone')` (the pane-local shape, R1) and
//      `lockPhraseGroup('story_1', 'grp-tone')` (the pinned shape) must both reach the store with the SAME pair —
//      a binding that read the first argument as the group in the pinned call would POST to `…/groups/story_1/lock`
//      and the server would 404 on a group that is a Story (L-13).
//   2. THE REFUSAL TRAVELS AS A RECORD, NOT A FLAG. `storyViewData`'s sixth argument is the whole
//      `state.ts:groupLockErrors` map; absent means "no refusals", which is NOT the same claim as success, and the
//      pane looks one group's sentence up by `api.ts:groupLockKey` (this file pins the map reaching the frame;
//      `SummaryGroupPane.locks.test.tsx` pins the sentence rendering).
import { describe, expect, it } from 'vitest';
import { shellActions, storyViewData } from './shell-binding';
import { fakeHarness, storyRow, storyView } from './testing/shell-fakes';

/** A loaded Story whose shell scope is `story_1` — the shape every binding resolves against. */
async function bound() {
    const harness = fakeHarness([storyRow('story_1')], []);
    await harness.store.openStory('story_1');

    return { ...harness, actions: shellActions(harness.store, 'story_1') };
}

describe('shell-binding — the lock pair addresses the GROUP in both call shapes (R1)', () => {
    it('takes the pane-local (groupId) and the pinned (storyId, groupId), and reaches the route with the pair', async () => {
        const { actions, client } = await bound();

        // The pane's own shape: the row's group id, with the Story being the shell's scope (D-29 / R1).
        await actions.lockPhraseGroup?.('grp-tone');
        expect(client.lockPhraseGroup).toHaveBeenLastCalledWith('story_1', 'grp-tone');

        // The pinned shape, unchanged: (storyId, groupId). A second argument proves the first one named the book,
        // so `scopeOf` reads it — and the group is still the group.
        await actions.lockPhraseGroup?.('story_1', 'grp-premise');
        expect(client.lockPhraseGroup).toHaveBeenLastCalledWith('story_1', 'grp-premise');

        expect(client.lockPhraseGroup).toHaveBeenCalledTimes(2);
    });

    it('routes the unlock the same way, so the two verbs cannot be read as each other', async () => {
        const { actions, client } = await bound();

        await actions.unlockPhraseGroup?.('grp-tone');
        expect(client.unlockPhraseGroup).toHaveBeenLastCalledWith('story_1', 'grp-tone');

        await actions.unlockPhraseGroup?.('story_1', 'grp-promise');
        expect(client.unlockPhraseGroup).toHaveBeenLastCalledWith('story_1', 'grp-promise');
        // The lock route never saw these clicks: an unlock is a POST to `/unlock`, not to `/lock`.
        expect(client.lockPhraseGroup).not.toHaveBeenCalled();
    });

    it('refuses a click that names no group, instead of POSTing to `…/groups/undefined/lock` (L-13)', async () => {
        const { actions, client } = await bound();

        await expect(actions.lockPhraseGroup?.()).rejects.toThrow(
            'lockPhraseGroup was called without the id the route needs'
        );
        await expect(actions.unlockPhraseGroup?.()).rejects.toThrow(
            'unlockPhraseGroup was called without the id the route needs'
        );
        // Named, and never sent: a route call with `undefined` in the path is a 404 the Author never sees explained.
        expect(client.lockPhraseGroup).not.toHaveBeenCalled();
        expect(client.unlockPhraseGroup).not.toHaveBeenCalled();
    });

    it('caches the refusal on the frame the pane reads, keyed by the pair the pane looks it up by', async () => {
        const { actions, store } = await bound();
        const refusal =
            'the Writer is replacing this group right now (run_write_groups_1), so the lock would commit text about to move (R4).';

        // The fake client stands in for a route that has not landed in THIS wave: the verb throws, and the store
        // caches the sentence under `<storyId>:<groupId>` (`api.ts:groupLockKey`) rather than only in the
        // shell-wide line, so the pane can print it next to the button that raised it.
        const { store: rejecting } = fakeHarness([storyRow('story_1')], [], {
            lockPhraseGroup: async () => {
                throw new Error(refusal);
            }
        });
        await rejecting.openStory('story_1');

        expect(await shellActions(rejecting, 'story_1').lockPhraseGroup?.('grp-theme')).toBeNull();
        expect(rejecting.getSnapshot().groupLockErrors).toEqual({
            'story_1:grp-theme': `Locking this group was refused: ${refusal}`
        });

        // The frame carries the WHOLE record, because the key already names the Story: a refusal from another book
        // can never be looked up on this one's frame, and a map with one entry is not "every group is refused".
        const frame = storyViewData(
            store.selectedStory() ?? storyView(storyRow('story_1')),
            [],
            undefined,
            undefined,
            undefined,
            rejecting.getSnapshot().groupLockErrors
        );

        expect(frame.groupLockErrors).toEqual({ 'story_1:grp-theme': `Locking this group was refused: ${refusal}` });
        expect(actions.lockPhraseGroup).toBeTypeOf('function');
    });
});

describe('shell-binding — the Editor-locking dial is one Story patch, both ways round (R2)', () => {
    it('sends the boolean the Settings switch produced, from the local shape and the pinned one', async () => {
        const { actions, client } = await bound();

        // The Settings row's own call: (storyId, checked) — OFF is an explicit boolean, never an omitted key
        // (`state.ts:setEditorGroupLocking`), because absent means off on the wire.
        await actions.setEditorGroupLocking?.('story_1', true);
        expect(client.patchStory).toHaveBeenLastCalledWith('story_1', { editor_group_locking: true });

        await actions.setEditorGroupLocking?.('story_1', false);
        expect(client.patchStory).toHaveBeenLastCalledWith('story_1', { editor_group_locking: false });

        // The shell-local shape: a bare boolean, with the Story being the shell's scope.
        await actions.setEditorGroupLocking?.(true);
        expect(client.patchStory).toHaveBeenLastCalledWith('story_1', { editor_group_locking: true });

        // A call that names the book and omits the value reads as ENABLE, the way every other dial in this file
        // reads a call with no value — and the Setting still shows what the server echoed, not what was implied.
        await actions.setEditorGroupLocking?.('story_1');
        expect(client.patchStory).toHaveBeenLastCalledWith('story_1', { editor_group_locking: true });
    });
});

describe('shell-binding — the refusal set rides the frame, absent when there is none', () => {
    it('says NOTHING for no refusals, and keeps the two other error slots independent', () => {
        const view = storyView(storyRow('story_1'));
        const refusal = 'this group has no revision to lock in — write it first (R1)';

        // Absent, not empty: `groupLockErrors: undefined` would be a key with an undefined value on the frame, and
        // the pane's lookup would still have to pass. `{}` is the store's own "no refusals".
        expect('groupLockErrors' in storyViewData(view, [])).toBe(false);
        expect('groupLockErrors' in storyViewData(view, [], undefined, undefined, undefined, undefined)).toBe(false);
        expect(storyViewData(view, [], undefined, undefined, undefined, {}).groupLockErrors).toEqual({});

        // A record is threaded verbatim — the map is the store's, so the binding invents nothing about its keys.
        expect(
            storyViewData(view, [], undefined, undefined, undefined, { 'story_1:grp-ending': refusal }).groupLockErrors
        ).toEqual({ 'story_1:grp-ending': refusal });

        // The three error slots stay independent: a failed phrase READ and a choose refusal do not silence a lock
        // refusal, and one lock refusal does not overwrite the others.
        const all = storyViewData(
            view,
            [],
            undefined,
            'this Story has no Summary Phrase',
            'no Reviewed Summary to choose',
            { 'story_1:grp-ending': refusal }
        );

        expect(all.phraseError).toBe('this Story has no Summary Phrase');
        expect(all.reviewedError).toBe('no Reviewed Summary to choose');
        expect(all.groupLockErrors).toEqual({ 'story_1:grp-ending': refusal });
    });
});
