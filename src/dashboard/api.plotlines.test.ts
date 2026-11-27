// T-W4 — Phrase ②'s four routes, pinned on the WIRE: the paths, the verbs, and the exact body each accepts.
//
// These are the calls the handoff card, the dial and the entry pane make, and a path that drifts here fails
// silently in the desk (the rail just shows a loading line), so every one is asserted as TEXT rather than a
// snapshot. The refusals are asserted VERBATIM too: they are the Author's next action, and a client that
// reworded a 409 about a started phrase would strand the desk with a shut button and no reason (L-13).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_ROOT, ApiError, api, PHRASE_PLOTLINES_KEY } from './api';
import { phraseDetailView } from './testing/shell-fakes';

/** The fetch call api.ts actually made: [url, method, body]. */
function lastFetch(): { url: string; method: string; body?: string } {
    const calls = (fetch as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls;
    const [url, init] = calls[calls.length - 1] as [string, RequestInit];

    return { url, method: init.method ?? 'GET', body: typeof init.body === 'string' ? init.body : undefined };
}

function ok(json: unknown) {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => json })));
}

function refused(status: number, message: string) {
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
            ok: false,
            status,
            statusText: status === 409 ? 'Conflict' : 'Bad Request',
            json: async () => ({ error: message })
        }))
    );
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('api — GET /stories/:id/phrases/plotlines (T-W4)', () => {
    it('reads the phrase surface from its own route, keyed by the catalog word, and returns it untouched', async () => {
        const detail = phraseDetailView('story_1');

        ok(detail);

        expect(await api.getPhraseDetail('story_1', PHRASE_PLOTLINES_KEY)).toEqual(detail);
        // One read, its own route: the entries are not part of `GET /stories/:id`, and they are not the
        // Summary's rows under a second name (`/phrases`, no key) — which is why the pane has a loading state.
        expect(lastFetch()).toEqual({ url: `${API_ROOT}/stories/story_1/phrases/plotlines`, method: 'GET' });
    });

    it('reports the classic echo as the wire sends it, rather than turning it into an empty entry set', async () => {
        const classic = phraseDetailView('story_1', { mode: 'classic', groups: [], overview: '', brief: null });

        ok(classic);

        const result = await api.getPhraseDetail('story_1', 'plotlines');

        // `classic` is this phrase's off word (the Summary's is `sampling`), and the rail routes on it, so the
        // client may not normalise it away.
        expect(result.mode).toBe('classic');
        expect(result.groups).toEqual([]);
        expect(result.brief).toBeNull();
    });

    it('raises the server’s own sentence when the read is refused (L-13)', async () => {
        refused(404, 'this Story has no Plotlines phrase');

        const failure = await api.getPhraseDetail('story_1', 'plotlines').catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(ApiError);
        expect((failure as ApiError).status).toBe(404);
        expect((failure as ApiError).message).toBe('this Story has no Plotlines phrase');
    });
});

describe('api — POST /stories/:id/phrases/plotlines/start (R5 / D-76)', () => {
    const receipt = {
        story_id: 'story_1',
        phrase_id: 'phrase_plotlines_1',
        key: 'plotlines',
        source: 'compiled' as const,
        seed_chars: 67,
        seed_head: 'A smuggler pays the tide to cross the salt road, and the road collects.',
        started: { id: 'start_1', at: '2026-11-09T12:00:00.000Z' },
        view: phraseDetailView('story_1')
    };

    it('sends the compiled arm as ONE key, with no stray text beside it', async () => {
        ok(receipt);

        expect(await api.startPhrase('story_1', 'plotlines', { source: 'compiled' })).toEqual(receipt);
        expect(lastFetch()).toEqual({
            url: `${API_ROOT}/stories/story_1/phrases/plotlines/start`,
            method: 'POST',
            body: '{"source":"compiled"}'
        });
    });

    it('sends the custom arm with its text, and an absent body as the route’s default', async () => {
        ok({ ...receipt, source: 'custom' as const, seed_chars: 42, seed_head: 'six chapters, alternating timeline' });

        await api.startPhrase('story_1', 'plotlines', { source: 'custom', text: 'six chapters, alternating timeline' });

        expect(lastFetch().body).toBe('{"source":"custom","text":"six chapters, alternating timeline"}');

        // No input at all is `{}`, which the route resolves to `compiled` — the default it documents, not a
        // body this client invents a key for.
        await api.startPhrase('story_1', 'plotlines');

        expect(lastFetch().body).toBe('{}');
    });

    it('carries the route’s 409 about a started phrase verbatim (D-72)', async () => {
        refused(
            409,
            'this phrase has already started: its Seed is the text every entry, revision and claim key was written against (D-72)'
        );

        const failure = await api
            .startPhrase('story_1', 'plotlines', { source: 'compiled' })
            .catch((error: unknown) => error);

        expect((failure as ApiError).status).toBe(409);
        expect((failure as ApiError).message).toBe(
            'this phrase has already started: its Seed is the text every entry, revision and claim key was written against (D-72)'
        );
    });

    it('carries the 409 about a Summary that is not compiled, and the 400 about an empty custom Seed', async () => {
        refused(409, 'this Story has no compiled Summary to start the phrase from (R5)');

        expect(
            (
                await api.startPhrase('story_1', 'plotlines', { source: 'compiled' }).catch((error: unknown) => error)
            ) instanceof ApiError
        ).toBe(true);
        expect(lastFetch()).toEqual({
            url: `${API_ROOT}/stories/story_1/phrases/plotlines/start`,
            method: 'POST',
            body: '{"source":"compiled"}'
        });

        refused(400, 'a custom start needs a Seed: the phrase copies what you send, and an empty one has nothing to write from');

        const empty = await api
            .startPhrase('story_1', 'plotlines', { source: 'custom', text: '' })
            .catch((error: unknown) => error);

        expect((empty as ApiError).status).toBe(400);
        expect((empty as ApiError).message).toBe(
            'a custom start needs a Seed: the phrase copies what you send, and an empty one has nothing to write from'
        );
        // The client still sends the empty string on this arm: the ROUTE owns the refusal, and the desk's own
        // check (`customSeedRefusal`) is what keeps the Author from making the call in the first place.
        expect(lastFetch().body).toBe('{"source":"custom","text":""}');
    });
});

describe('api — POST /stories/:id/phrases/groups/:groupId/revise, the entry leg (T-W4)', () => {
    const result = {
        story_id: 'story_1',
        phrase_id: 'phrase_plotlines_1',
        revision: 2,
        installed: [
            { group_id: 'entry-chapter_2', group_key: 'chapter_2', revision_id: 'rev-ch2-2', number: 2 }
        ],
        archived: [
            { group_id: 'entry-chapter_2', group_key: 'chapter_2', revision_id: 'rev-ch2-1', number: 1 }
        ],
        mirror: undefined,
        view: phraseDetailView('story_1')
    };

    it('sends the contract fields to the entry addressed by its id, with no content key', async () => {
        ok(result);

        expect(
            await api.revisePhraseEntry('story_1', 'entry-chapter_2', {
                plotpoints: { must_happen: 'the toll is refused', must_change: 'the road collects' }
            })
        ).toEqual(result);
        // The SAME route as the Summary group's revise, and the body is what makes it the entry leg: `plotpoints`,
        // never `content` — an entry's prose is composed from the fields, so a `content` key would be editing a
        // rendering (P4).
        expect(lastFetch()).toEqual({
            url: `${API_ROOT}/stories/story_1/phrases/groups/entry-chapter_2/revise`,
            method: 'POST',
            body: '{"plotpoints":{"must_happen":"the toll is refused","must_change":"the road collects"}}'
        });
    });

    it('sends the note only when the Author wrote one', async () => {
        ok(result);

        await api.revisePhraseEntry('story_1', 'entry-chapter_1', {
            plotpoints: {
                must_happen: 'the crossing is attempted',
                must_change: 'the mentor’s price is paid',
                heading: 'The Salt Road',
                pov: 'Hale'
            },
            note: 'make the toll concrete'
        });

        expect(JSON.parse(lastFetch().body ?? '')).toEqual({
            plotpoints: {
                must_happen: 'the crossing is attempted',
                must_change: 'the mentor’s price is paid',
                heading: 'The Salt Road',
                pov: 'Hale'
            },
            note: 'make the toll concrete'
        });
    });

    it('raises the route’s refusal for an entry with no contract (P4)', async () => {
        refused(400, 'a plotlines entry is revised through its plotpoints: send must_happen and must_change');

        const failure = await api
            .revisePhraseEntry('story_1', 'entry-chapter_1', {
                plotpoints: { must_happen: '', must_change: '' }
            })
            .catch((error: unknown) => error);

        expect((failure as ApiError).status).toBe(400);
        expect((failure as ApiError).message).toBe(
            'a plotlines entry is revised through its plotpoints: send must_happen and must_change'
        );
    });
});

describe('api — PATCH /stories/:id with the Phrase ② dial (T-W4)', () => {
    it('writes the dial as an explicit word, on the Story’s own route', async () => {
        ok({ id: 'story_1', plotlines_mode: 'groups' });

        await api.patchStory('story_1', { plotlines_mode: 'groups' });

        expect(lastFetch()).toEqual({
            url: `${API_ROOT}/stories/story_1`,
            method: 'PATCH',
            body: '{"plotlines_mode":"groups"}'
        });
    });

    it('writes the classic word rather than omitting the key, so OFF is a decision the server can see', async () => {
        ok({ id: 'story_1', plotlines_mode: 'classic' });

        await api.patchStory('story_1', { plotlines_mode: 'classic' });

        expect(lastFetch().body).toBe('{"plotlines_mode":"classic"}');
    });

    it('carries the 409 that closes the dial with the start (D-71)', async () => {
        refused(
            409,
            'Phrase 2 has started on this Story: its Seed, its brief and its chapter entries were written against the mode that produced them, so the dial closed with the start'
        );

        const failure = await api.patchStory('story_1', { plotlines_mode: 'classic' }).catch((error: unknown) => error);

        expect((failure as ApiError).status).toBe(409);
        expect((failure as ApiError).message).toBe(
            'Phrase 2 has started on this Story: its Seed, its brief and its chapter entries were written against the mode that produced them, so the dial closed with the start'
        );
    });
});

// R7 — THE SEED PROOFREAD, on the wire. The verb is a GET, so the Author's draft rides in the QUERY: this suite is
// the only place that fact is pinned, and a client that interpolated the draft raw would ask about a DIFFERENT
// brief the moment the Author wrote an `&` or a `#` — which a prose brief does routinely, and the answer would look
// like a proofread of text nobody typed.
describe('api — GET /stories/:id/phrases/plotlines/seed/cleanup (R7)', () => {
    it('asks with the draft in the query, with no body, and hands the proposal back untouched', async () => {
        const proposal = { ok: true, source_hash: '9b8387ee', text: 'A mapmaker finds her own coastline.', changed: true };

        ok(proposal);

        expect(await api.getPhraseSeedCleanup('story_1', PHRASE_PLOTLINES_KEY, 'A mapmaker she find her own coastline.')).toEqual(
            proposal
        );
        // A GET with no body: the pass writes nothing, and the client must not offer it a body to write with.
        expect(lastFetch()).toEqual({
            url: `${API_ROOT}/stories/story_1/phrases/plotlines/seed/cleanup?seed=A%20mapmaker%20she%20find%20her%20own%20coastline.`,
            method: 'GET'
        });
        expect(lastFetch().body).toBeUndefined();
    });

    it('escapes the punctuation a prose brief actually contains, so the server reads the whole draft', async () => {
        ok({ ok: true, source_hash: '00000000', text: 'x', changed: false });

        await api.getPhraseSeedCleanup(
            'story_1',
            PHRASE_PLOTLINES_KEY,
            'Six chapters & a tide # 6 charts + 1 lighthouse? she=drew it'
        );

        // `&` and `#` are the two that would TRUNCATE an unescaped query — the proofread would run over a fragment
        // and the Author would be shown a correction of a sentence they never sent.
        expect(lastFetch().url).toBe(
            `${API_ROOT}/stories/story_1/phrases/plotlines/seed/cleanup?seed=Six%20chapters%20%26%20a%20tide%20%23%206%20charts%20%2B%201%20lighthouse%3F%20she%3Ddrew%20it`
        );
    });

    it('addresses an unquoted phrase key the way every other phrase verb does', async () => {
        ok({ ok: true, source_hash: '00000000', text: 'x', changed: false });

        await api.getPhraseSeedCleanup('story_1', 'unwritten idea', 'A brief.');

        expect(lastFetch().url).toBe(`${API_ROOT}/stories/story_1/phrases/unwritten%20idea/seed/cleanup?seed=A%20brief.`);
    });

    it('passes the guard’s refusal arm through as a value, because a refusal is an answer (AC3)', async () => {
        // The route answers 200 with no `text`; the client has no business turning that into a throw, and the card
        // decides what to show from `ok`.
        ok({ ok: false, source_hash: '9b8387ee', refusal: 'numbers_lost' });

        expect(await api.getPhraseSeedCleanup('story_1', PHRASE_PLOTLINES_KEY, 'A mapmaker needs 6 charts.')).toEqual({
            ok: false,
            source_hash: '9b8387ee',
            refusal: 'numbers_lost'
        });
    });

    it('raises the no-transport 409 with the server’s own sentence (L-13)', async () => {
        refused(
            409,
            'this server has no model transport wired into its route table, so the Editor has nothing to ask for a proofread (R7): the Seed you typed is still exactly what POST …/phrases/start copies.'
        );

        const failure = await api
            .getPhraseSeedCleanup('story_1', PHRASE_PLOTLINES_KEY, 'A brief.')
            .catch((error: unknown) => error);

        expect((failure as ApiError).status).toBe(409);
        expect((failure as ApiError).message).toBe(
            'this server has no model transport wired into its route table, so the Editor has nothing to ask for a proofread (R7): the Seed you typed is still exactly what POST …/phrases/start copies.'
        );
    });
});
