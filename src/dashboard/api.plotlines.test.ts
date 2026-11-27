// T-W4 — Phrase ②'s four routes, pinned on the WIRE: the paths, the verbs, and the exact body each accepts.
//
// R2 (W2) moved the Seed cleanup off the request line: the draft rides in a POST BODY (a pasted brief is routinely
// larger than a request target can carry), and R5 (W2) moved a chapter entry's revise body from two prose fields to
// the ORDERED `beats` list. Both are pinned here as text, because both are the difference between the desk asking
// about the right text and asking about a fragment of it.
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
                plotpoints: { beats: ['the toll is refused', 'the road collects'] }
            })
        ).toEqual(result);
        // The SAME route as the Summary group's revise, and the body is what makes it the entry leg: `plotpoints`,
        // never `content` — an entry's prose is composed from the fields, so a `content` key would be editing a
        // rendering (P4). THE BEATS TRAVEL AS AN ORDERED ARRAY: the order IS the contract (C-7 checks the prose
        // against every beat and C-3/C-8 against the last one), so a client that sorted, joined or re-split this
        // list would silently redraft the chapter on the way out.
        expect(lastFetch()).toEqual({
            url: `${API_ROOT}/stories/story_1/phrases/groups/entry-chapter_2/revise`,
            method: 'POST',
            body: '{"plotpoints":{"beats":["the toll is refused","the road collects"]}}'
        });
    });

    it('sends the note only when the Author wrote one', async () => {
        ok(result);

        await api.revisePhraseEntry('story_1', 'entry-chapter_1', {
            plotpoints: {
                heading: 'The Salt Road',
                beats: ['the crossing is attempted', 'the mentor’s price is paid'],
                dialogue: ['Hale: “The road collects its own toll.”']
            },
            note: 'make the toll concrete'
        });

        // The client is a MIRROR, not a policy: the fields ride out exactly as the caller assembled them, in the
        // caller's order, so the pane's omission rule (`PhraseEntries.tsx:submit`) is the one place a blank can be
        // dropped, and this body is what the route composes the entry's text from.
        expect(JSON.parse(lastFetch().body ?? '')).toEqual({
            plotpoints: {
                heading: 'The Salt Road',
                beats: ['the crossing is attempted', 'the mentor’s price is paid'],
                dialogue: ['Hale: “The road collects its own toll.”']
            },
            note: 'make the toll concrete'
        });
    });

    it('raises the route’s refusal for an entry with no contract (P4)', async () => {
        // THE ROUTE'S OWN SENTENCE (`routes.ts:plotpointsFromBody`, pinned by the server's
        // `phrase-start-routes.test.ts:1235`), verbatim — and note that `['   ', '']` is a NON-EMPTY array that
        // carries no beat: the blanks are dropped, which is what makes "at least one beat" a real rule.
        refused(
            400,
            '`plotpoints` is a chapter entry\'s text: `beats` must be a non-empty list of non-blank strings — the ORDERED contract the entry\'s text and its `plotlines` row are composed from — or the body must carry the deprecated `must_happen` prose the Server recovers beats from (P4, §4.20).'
        );

        const failure = await api
            .revisePhraseEntry('story_1', 'entry-chapter_1', {
                plotpoints: { beats: ['   ', ''] }
            })
            .catch((error: unknown) => error);

        expect((failure as ApiError).status).toBe(400);
        expect((failure as ApiError).message).toBe(
            '`plotpoints` is a chapter entry\'s text: `beats` must be a non-empty list of non-blank strings — the ORDERED contract the entry\'s text and its `plotlines` row are composed from — or the body must carry the deprecated `must_happen` prose the Server recovers beats from (P4, §4.20).'
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

// R2 / R7 — THE SEED PROOFREAD, on the wire, in BOTH ADDRESSES.
//
// The draft rides in a POST BODY (R2/W2): a pasted brief is routinely larger than a request target can carry
// (`maxHeaderSize`), which is exactly the brief that needs proofreading, and prose in a query string is prose at
// the mercy of `&`, `#` and `+`. Both arms answer a byte-identical `SeedCleanupProposal`, and BOTH write nothing:
// the body is how an unwritable draft travels, not how a row is written (P10). The pre-create arm is addressed by
// the CATALOG KEY, because the Seed it reads has no Story yet — the create copies it into the Story and the Start
// copies it into the phrase (D-72).
describe('api — POST /stories/:id/phrases/:key/seed/cleanup (R2 / R7)', () => {
    it('sends the draft in the body, over the phrase’s own route, and hands the proposal back untouched', async () => {
        const proposal = { ok: true, source_hash: '9b8387ee', text: 'A mapmaker finds her own coastline.', changed: true };

        ok(proposal);

        expect(
            await api.requestPhraseSeedCleanup('story_1', PHRASE_PLOTLINES_KEY, 'A mapmaker she find her own coastline.')
        ).toEqual(proposal);
        // ONE body key, and the proposal comes back as the server answered it — `ok` and `changed` are the two
        // flags the card branches on, so a client that mapped them would be deciding the Author's press for them.
        expect(lastFetch()).toEqual({
            url: `${API_ROOT}/stories/story_1/phrases/plotlines/seed/cleanup`,
            method: 'POST',
            body: '{"seed":"A mapmaker she find her own coastline."}'
        });
    });

    it('carries the punctuation and length a real brief contains, unescaped and whole', async () => {
        ok({ ok: true, source_hash: '00000000', text: 'x', changed: false });

        const draft =
            'Six chapters & a tide # 6 charts + 1 lighthouse? she=drew it, and the ledger says "salt" — ' +
            'so the road collects, and the road collects, and the road collects.';

        await api.requestPhraseSeedCleanup('story_1', PHRASE_PLOTLINES_KEY, draft);

        // The request line holds ONLY the route, so none of that text is cut, escaped or truncated: the JSON body
        // carries the draft byte for byte, which is the difference between a proofread of the Author's brief and a
        // proofread of the fragment before the first `&`.
        expect(lastFetch().url).toBe(`${API_ROOT}/stories/story_1/phrases/plotlines/seed/cleanup`);
        expect(JSON.parse(lastFetch().body ?? '').seed).toBe(draft);
    });

    it('addresses an unquoted phrase key the way every other phrase verb does', async () => {
        ok({ ok: true, source_hash: '00000000', text: 'x', changed: false });

        await api.requestPhraseSeedCleanup('story_1', 'unwritten idea', 'A brief.');

        expect(lastFetch().url).toBe(`${API_ROOT}/stories/story_1/phrases/unwritten%20idea/seed/cleanup`);
    });

    it('passes the guard’s refusal arm through as a value, because a refusal is an answer (AC3)', async () => {
        // The route answers 200 with no `text`; the client has no business turning that into a throw, and the card
        // decides what to show from `ok`.
        ok({ ok: false, source_hash: '9b8387ee', refusal: 'numbers_lost' });

        expect(await api.requestPhraseSeedCleanup('story_1', PHRASE_PLOTLINES_KEY, 'A mapmaker needs 6 charts.')).toEqual({
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
            .requestPhraseSeedCleanup('story_1', PHRASE_PLOTLINES_KEY, 'A brief.')
            .catch((error: unknown) => error);

        expect((failure as ApiError).status).toBe(409);
        expect((failure as ApiError).message).toBe(
            'this server has no model transport wired into its route table, so the Editor has nothing to ask for a proofread (R7): the Seed you typed is still exactly what POST …/phrases/start copies.'
        );
    });
});

// R2 — THE PROOFREAD WITH NO STORY YET. The create form's brief has no row anywhere, so its route is addressed by
// the phrase KIND the create will name as `start_phrase`; the story-scoped arm cannot stand in for it and 404s
// before it reaches the model.
describe('api — POST /phrases/:key/seed/cleanup (R2, the create form’s arm)', () => {
    it('asks the draft’s own route, one body key, and answers the same proposal shape', async () => {
        const proposal = { ok: true, source_hash: '4f2a91c0', text: 'A tide chart, redrawn.', changed: true };

        ok(proposal);

        expect(await api.requestSeedCleanupDraft('plotlines', 'A mapmaker she find her own coastline.')).toEqual(proposal);
        expect(lastFetch()).toEqual({
            url: `${API_ROOT}/phrases/plotlines/seed/cleanup`,
            method: 'POST',
            body: '{"seed":"A mapmaker she find her own coastline."}'
        });
    });

    it('escapes the catalog key it is addressed by, and keeps the refusal arm a value', async () => {
        ok({ ok: false, source_hash: '00000000', refusal: 'too_short' });

        expect(await api.requestSeedCleanupDraft('unwritten idea', 'A fragment.')).toEqual({
            ok: false,
            source_hash: '00000000',
            refusal: 'too_short'
        });
        expect(lastFetch().url).toBe(`${API_ROOT}/phrases/unwritten%20idea/seed/cleanup`);
    });

    it('raises the 404 for a key this build never catalogued, verbatim (L-13)', async () => {
        refused(404, 'no startable phrase is catalogued under that key');

        // A KEY THE CATALOG HAS NEVER HEARD OF. It used to be `summary` pinned here, which quietly recorded the
        // wrong rule: W6 corrected the workspace leg to the catalog's START set, so the Summary is a kind this
        // route answers — the only keys it refuses by address are ones the build does not have at all.
        const failure = await api.requestSeedCleanupDraft('characters', 'A brief.').catch((error: unknown) => error);

        expect((failure as ApiError).status).toBe(404);
        expect((failure as ApiError).message).toBe('no startable phrase is catalogued under that key');
    });

    it('addresses the Summary kind on the pre-create leg, the phrase the default create mints (W6, R2)', async () => {
        // THE BODY, not the query, and the kind from the catalog: the Create sheet's brief becomes the Summary's
        // SEED (`seed_source: 'story_idea'`), so the proofread is addressed to `summary` exactly as it is to
        // `plotlines`. Pinned as the request the browser dials, because a client that still refused this key is how
        // the server fix alone would fail to reach an Author.
        const proposal = { ok: true, source_hash: '9b8387ee', text: 'A tide chart, redrawn.', changed: true };

        ok(proposal);

        expect(await api.requestSeedCleanupDraft('summary', 'A mapmaker she find her own coastline.')).toEqual(
            proposal
        );
        expect(lastFetch()).toEqual({
            url: `${API_ROOT}/phrases/summary/seed/cleanup`,
            method: 'POST',
            body: '{"seed":"A mapmaker she find her own coastline."}'
        });
    });

    it('keeps the optional `blocker` on the refusal arm, on both cleanup legs (R6, W4)', async () => {
        // THE ONE KEY THAT SAYS WHOSE FAILURE IT IS. The server answers `refusal` PLUS `blocker` when its own
        // prompt file is refused, and the desk prints a different sentence for that than for a guard refusal — so
        // the client's job is to lose nothing on the way through. All three transports compose the same object
        // (`routes.ts:seedCleanupBody`), and this desk calls two of them.
        const blocked = {
            ok: false,
            source_hash: '00000000',
            refusal: 'empty_answer',
            blocker: 'seed-cleanup.md: `name: seed-cleaner` disagrees with `slug: seed-cleanup`'
        };

        ok(blocked);

        expect(await api.requestSeedCleanupDraft(PHRASE_PLOTLINES_KEY, 'A brief.')).toEqual(blocked);
        expect(await api.requestPhraseSeedCleanup('story_1', PHRASE_PLOTLINES_KEY, 'A brief.')).toEqual(blocked);

        // AND THE ARM IS STILL JUST A VALUE when there is no blocker: the guard refusal stays the two-key object
        // it always was, so a client-side `blocker ?? ''` never becomes a third state.
        ok({ ok: false, source_hash: '00000000', refusal: 'numbers_lost' });

        expect(await api.requestSeedCleanupDraft(PHRASE_PLOTLINES_KEY, 'A brief.')).toEqual({
            ok: false,
            source_hash: '00000000',
            refusal: 'numbers_lost'
        });
    });
});
