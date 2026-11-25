// T5 / R1 — the two group-LOCK routes, pinned on the WIRE.
//
// Why a file of its own: `api.test.ts` pins the surface that existed before the group workspace, and
// `api.phrases.test.ts` pins the phrase read, the revise write and D-68's choose. The lock pair is the third
// verb the desk puts in the Author's hands, and a path that drifts here fails SILENTLY in the UI — the pane
// shows a lock badge over a group the server never locked, or a button that refuses and says nothing. So the
// path, the verb, and the absence of a body are asserted as text.
//
// NO BODY IS THE CONTRACT. The verdict is "this text stands", and WHO made it is the route's own attribution
// (the Author, or the Editor while the Story's `editor_group_locking` Setting is on) — never a field the desk
// asserts about itself. That is also why the group is addressed in the PATH: a catalog reorder cannot move the
// write onto a sibling row.
//
// The refusal sentences are asserted VERBATIM: the server's 409/403 is the Author's next action (L-13), and a
// client that rewrites one strands the desk with a button that refused and no reason.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_ROOT, ApiError, api } from './api';
import { groupedPhraseView } from './testing/shell-fakes';
import type { PhraseGroupLockResult } from './api';

/** The fetch call api.ts actually made: [url, method, body]. */
function lastFetch(): { url: string; method: string; body?: string } {
    const calls = (fetch as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls;
    const [url, init] = calls[calls.length - 1] as [string, RequestInit];

    return { url, method: init.method ?? 'GET', body: typeof init.body === 'string' ? init.body : undefined };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

/** What the lock route answers: the state it left the group in, and the refreshed read (revise's convention). */
function lockedResult(storyId: string, groupId: string): PhraseGroupLockResult {
    return {
        story_id: storyId,
        phrase_id: 'phrase_summary_1',
        group_id: groupId,
        locked: true,
        locked_revision: 4,
        locked_by: 'author',
        locked_at: '2026-11-11T09:00:00.000Z',
        view: groupedPhraseView(storyId)
    };
}

describe('api — POST /stories/:id/phrases/groups/:groupId/lock (R1)', () => {
    it('addresses the group by its id in the path, sends no body, and returns the route’s report untouched', async () => {
        const result = lockedResult('story_1', 'grp-tone');

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => result }))
        );

        expect(await api.lockPhraseGroup('story_1', 'grp-tone')).toEqual(result);
        expect(lastFetch()).toEqual({
            url: `${API_ROOT}/stories/story_1/phrases/groups/grp-tone/lock`,
            method: 'POST'
        });
    });

    it('escapes a group id the projection invented, so an odd id cannot escape its path segment', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => lockedResult('story_1', 'grp/odd') }))
        );

        await api.lockPhraseGroup('story_1', 'grp/odd');

        expect(lastFetch().url).toBe(`${API_ROOT}/stories/story_1/phrases/groups/grp%2Fodd/lock`);
    });

    it('raises the 409 the route refused with, verbatim, so the pane can print the Author’s next action', async () => {
        // The two refusals the lock route actually has (R1/R4): nothing written to commit, and a live Writer
        // about to move the text. Both are printed as the server said them.
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: false,
                status: 409,
                statusText: 'Conflict',
                json: async () => ({ error: 'this group has no revision to lock in — write it first (R1)' })
            }))
        );

        const failure = await api.lockPhraseGroup('story_1', 'grp-ending').catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(ApiError);
        expect((failure as ApiError).status).toBe(409);
        expect((failure as ApiError).message).toBe('this group has no revision to lock in — write it first (R1)');
    });
});

describe('api — POST /stories/:id/phrases/groups/:groupId/unlock (R1)', () => {
    it('opens the group the Author addressed, and answers the state it left it in', async () => {
        const result: PhraseGroupLockResult = {
            story_id: 'story_1',
            phrase_id: 'phrase_summary_1',
            group_id: 'grp-tone',
            locked: false,
            locked_revision: null,
            locked_by: null,
            locked_at: null,
            view: groupedPhraseView('story_1')
        };

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => result }))
        );

        expect(await api.unlockPhraseGroup('story_1', 'grp-tone')).toEqual(result);
        expect(lastFetch()).toEqual({
            url: `${API_ROOT}/stories/story_1/phrases/groups/grp-tone/unlock`,
            method: 'POST'
        });
    });

    it("raises the 403 that says only the Author lifts a lock, rather than retrying the Editor's leg", async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: false,
                status: 403,
                statusText: 'Forbidden',
                json: async () => ({ error: 'only the Author unlocks a group (R1)' })
            }))
        );

        const failure = await api.unlockPhraseGroup('story_1', 'grp-tone').catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(ApiError);
        expect((failure as ApiError).status).toBe(403);
        expect((failure as ApiError).message).toBe('only the Author unlocks a group (R1)');
    });

    it('reports a lock that is not standing as the route said it, not as a success', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: false,
                status: 409,
                statusText: 'Conflict',
                json: async () => ({ error: 'this group is not locked in' })
            }))
        );

        const failure = await api.unlockPhraseGroup('story_1', 'grp-tone').catch((error: unknown) => error);

        expect((failure as ApiError).message).toBe('this group is not locked in');
    });
});
