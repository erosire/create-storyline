// SUMMARY PHRASE R6 / R2 / D-68 — the three routes the group workspace is built on, pinned on the WIRE.
//
// `api.test.ts` pins the surface that existed before the phrase read; this file pins the additions,
// because they are the half the server is built against: the paths, the verb, and the exact body the
// revise route accepts. A path that drifts here fails silently in the desk (the rail just shows "loading"),
// so it is asserted as text, not as a snapshot.
//
// D-68 adds the Author's whole-Summary choose. Its three 409 sentences are copied from
// `server/api/routes.ts` and asserted VERBATIM here: they are the Author's next action, so a client that
// rewrites or truncates one strands the Author with a button that refuses and no reason.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_ROOT, ApiError, api } from './api';
import { groupedPhraseView, phraseView, reviewedPhraseView } from './testing/shell-fakes';
import type { PhraseReviewedChooseResult } from './api';

/** The fetch call api.ts actually made: [url, init]. */
function lastFetch(): { url: string; method: string; body?: string } {
    const calls = (fetch as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls;
    const [url, init] = calls[calls.length - 1] as [string, RequestInit];

    return { url, method: init.method ?? 'GET', body: typeof init.body === 'string' ? init.body : undefined };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('api — GET /stories/:id/phrases (R6)', () => {
    it('reads the phrase projection from its own route and returns it untouched', async () => {
        const phrase = groupedPhraseView('story_1');

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => phrase }))
        );

        expect(await api.getPhrase('story_1')).toEqual(phrase);
        // One read, its own route: the phrase rows are not part of `GET /stories/:id`, which is why the
        // rail has a loading state at all.
        expect(lastFetch()).toEqual({ url: `${API_ROOT}/stories/story_1/phrases`, method: 'GET' });
    });

    it("answers a legacy book's sampling echo without inventing a 404", async () => {
        // The projection sends `{mode:'sampling', groups: []}` for a Story with no group rows, so the rail
        // can tell "this book has no groups" from "the read failed".
        const echo = phraseView('story_1');

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => echo }))
        );

        const result = await api.getPhrase('story_1');

        expect(result.mode).toBe('sampling');
        expect(result.groups).toEqual([]);
        expect(result.review.mode).toBe('sampling');
        expect(result.overview).toBe('');
    });

    it('raises the server’s own sentence when the read is refused (L-13)', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: false,
                status: 404,
                statusText: 'Not Found',
                json: async () => ({ error: 'this Story has no Summary Phrase' })
            }))
        );

        const failure = await api.getPhrase('story_1').catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(ApiError);
        expect((failure as ApiError).status).toBe(404);
        expect((failure as ApiError).message).toBe('this Story has no Summary Phrase');
    });
});

describe('api — POST /stories/:id/phrases/groups/:groupId/revise (R2)', () => {
    it('sends the new text and the note to the group addressed by its id', async () => {
        const result = {
            story_id: 'story_1',
            phrase_id: 'phrase_summary_1',
            revision: 2,
            installed: [{ group_id: 'grp-tone', group_key: 'tone', revision_id: 'rev-tone-2', number: 2 }],
            archived: [{ group_id: 'grp-tone', group_key: 'tone', revision_id: 'rev-tone-1', number: 1 }],
            mirror: { summary_id: 'sum_1', fields: ['tone'], written: true },
            view: groupedPhraseView('story_1')
        };

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => result }))
        );

        expect(
            await api.revisePhraseGroup('story_1', 'grp-tone', {
                content: 'Plain sentences, salt in every image.',
                note: 'the last revision lost the salt'
            })
        ).toEqual(result);
        expect(lastFetch()).toEqual({
            url: `${API_ROOT}/stories/story_1/phrases/groups/grp-tone/revise`,
            method: 'POST',
            body: JSON.stringify({
                content: 'Plain sentences, salt in every image.',
                note: 'the last revision lost the salt'
            })
        });
    });

    it('omits the note key entirely when the Author left it blank, so the route sees no empty note', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: true,
                status: 200,
                statusText: 'OK',
                json: async () => groupedPhraseView('story_1')
            }))
        );

        await api.revisePhraseGroup('story_1', 'grp-tone', { content: 'A colder ending, then.' });

        expect(lastFetch()).toEqual({
            url: `${API_ROOT}/stories/story_1/phrases/groups/grp-tone/revise`,
            method: 'POST',
            body: '{"content":"A colder ending, then."}'
        });
    });

    it('addresses the group by its uuid verbatim — the dashboard never reshapes an id', async () => {
        const uuid = '0f9f0e2c-6a5d-4f1a-9b64-8f2f3a7c11d0';

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: true,
                status: 200,
                statusText: 'OK',
                json: async () => groupedPhraseView('story_1')
            }))
        );

        await api.revisePhraseGroup('story_1', uuid, { content: 'x' });
        expect(lastFetch().url).toBe(`${API_ROOT}/stories/story_1/phrases/groups/${uuid}/revise`);
    });

    it('surfaces the 409 the route sends while a Writer holds the group (F8/R4)', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: false,
                status: 409,
                statusText: 'Conflict',
                json: async () => ({ error: 'the Writer is rewriting this group; try again when its revision lands' })
            }))
        );

        const failure = await api
            .revisePhraseGroup('story_1', 'grp-theme', { content: 'a second hand on the same sentence' })
            .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(ApiError);
        expect((failure as ApiError).status).toBe(409);
        // The pane's disabled control and this refusal read the same flag, so the sentence a 409 carries is
        // the sentence the Author would otherwise have had to discover by clicking.
        expect((failure as ApiError).message).toBe(
            'the Writer is rewriting this group; try again when its revision lands'
        );
    });
});

describe('api — POST /stories/:id/phrases/reviewed/choose (D-68)', () => {
    /** Stubs one JSON answer of the shape the choose route sends (200, or a 409 with its sentence). */
    function stubAnswer(status: number, payload: unknown) {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: status < 400,
                status,
                statusText: status === 200 ? 'OK' : 'Conflict',
                json: async () => payload
            }))
        );
    }

    it('addresses the WHOLE reviewed Overview — no group id in the path — and returns the route’s report', async () => {
        const result = {
            story_id: 'story_1',
            phrase_id: 'phrase_summary_1',
            revision: 7,
            vector: { 'grp-premise': 1 },
            vector_hash: 'vh-clean-1',
            at: '2026-11-09T14:00:00.000Z',
            overview: 'Five sections the Author took.',
            installed: [],
            discarded: [{ group_id: 'grp-ending', group_key: 'ending', revision_id: 'rev-ending-3', number: 3 }],
            sources: [],
            mirror: { summary_id: 'sum_1', fields: ['premise'], written: true },
            // The REFRESHED read, which is the whole point of the route answering with a view: after a choose
            // the projection reports `state:'chosen'`, and the tab re-renders off this without a second read.
            view: reviewedPhraseView('story_1', 'chosen')
        };

        stubAnswer(200, result);

        expect(await api.choosePhraseReviewed('story_1')).toEqual(result);
        expect(lastFetch()).toEqual({
            url: `${API_ROOT}/stories/story_1/phrases/reviewed/choose`,
            method: 'POST',
            // No note means an empty body object, not an empty-string note: the attribution line the install
            // writes would otherwise print a blank quote (D-68).
            body: '{}'
        });
    });

    it('sends the Author’s note when there is one, and drops a blank one', async () => {
        stubAnswer(200, reviewedPhraseView('story_1', 'chosen'));
        await api.choosePhraseReviewed('story_1', { note: '  the newer Ending is the one I want  ' });
        expect(lastFetch().body).toBe('{"note":"  the newer Ending is the one I want  "}');

        stubAnswer(200, reviewedPhraseView('story_1', 'chosen'));
        await api.choosePhraseReviewed('story_1', { note: '' });
        expect(lastFetch().body).toBe('{}');
    });

    it('raises the sampling book’s 409 verbatim, so the Author hears about the import route', async () => {
        stubAnswer(
            409,
            {
                error:
                    "this Story's Summary is still written as one text (no group catalog); POST /stories/story_1/phrases/import turns the flat Summary into groups first (R6, D-68)."
            }
        );

        const failure = await api.choosePhraseReviewed('story_1').catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(ApiError);
        expect((failure as ApiError).status).toBe(409);
        expect((failure as ApiError).message).toBe(
            "this Story's Summary is still written as one text (no group catalog); POST /stories/story_1/phrases/import turns the flat Summary into groups first (R6, D-68)."
        );
    });

    it('raises the incomplete-selection 409 verbatim, gaps and all', async () => {
        // The sentence lists one clause per missing group, with the gap token the domain reports. The client
        // is what carries it to the Summary tab, so nothing here may shorten it.
        stubAnswer(
            409,
            {
                error:
                    'this Story has no Reviewed Summary to choose: ending (unwritten), promise (an unresolved issue names it) ' +
                    '— a group joins the reviewed Overview only once a cross-group Critic pass closes with no unresolved defect on it (D-67, D-68).'
            }
        );

        const failure = await api.choosePhraseReviewed('story_1').catch((error: unknown) => error);

        expect((failure as ApiError).message).toBe(
            'this Story has no Reviewed Summary to choose: ending (unwritten), promise (an unresolved issue names it) ' +
                '— a group joins the reviewed Overview only once a cross-group Critic pass closes with no unresolved defect on it (D-67, D-68).'
        );
    });

    it('raises the live-Writer 409 verbatim, with the run ids the Author has to wait for (R4)', async () => {
        stubAnswer(
            409,
            {
                error:
                    'the Writer is rewriting part of this Summary right now (run_write_groups_1, run_write_groups_2), so choosing the reviewed Overview ' +
                    'would install under a pass that has not finished — the same choice lands once those runs close (R4, D-68).'
            }
        );

        const failure = await api.choosePhraseReviewed('story_1', { note: 'take it' }).catch((error: unknown) => error);

        expect((failure as ApiError).message).toBe(
            'the Writer is rewriting part of this Summary right now (run_write_groups_1, run_write_groups_2), so choosing the reviewed Overview ' +
                'would install under a pass that has not finished — the same choice lands once those runs close (R4, D-68).'
        );
    });
});
