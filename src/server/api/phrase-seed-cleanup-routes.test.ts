// R7 / R12 — THE ONE-TIME SEED CLEANUP, reached from the desk, and the provenance the start records.
//
// WHAT THIS FILE PINS, and why each of these is a test rather than a comment:
//
//   1. THE PROPOSAL IS A PROPOSAL (AC2 / P10 / L-19). `GET …/phrases/plotlines/seed/cleanup` answers TEXT and
//      touches no record: one tool-less turn, no run row, no thread, no write. The verb's whole claim is that
//      the Author can see a cleanup BEFORE anything is stored, so the assertion that matters is not "the model
//      answered" but "the book is byte-for-byte the book it was" — phrase rows, journal length, everything.
//      The request shape is pinned off the mock's recording because it is the only place the "no tools"
//      promise is observable: the module takes no `Store`, so it cannot write, and `tools: []` is what stops
//      it calling something that can.
//   2. THE CONFIRM IS A PRESS, NOT A FLAG (AC2). `StartPhraseRequest` grew nothing: the desk puts the proposal
//      in the Seed box and the Author's NEXT `source:'custom'` press carries it. Pinned end to end — the
//      proposal, then the start, then the row — because the recorded decision ("normalizes the seed once, at
//      start, with Author confirm") is only true if the write happens ONCE, with the confirmed bytes, and
//      never through a second verb that could move the Seed after the phrase exists (D-72, D-76/§18.13).
//   3. A GUARD REFUSAL IS NOT A WRITE AND NOT A CONFIRM (AC3). `numbers_lost` / `too_short` / `too_long` /
//      `empty_answer` answer 200 with no `text`, so the desk has nothing to accept; the Author's own text is
//      what the next start copies. The route could have quietly returned the source as the "proposal" and no
//      one would have noticed for a month — this is the place that pins it did not.
//   4. THE COMPILED ARM SPENDS NOTHING (AC2). A Seed out of Phrase ① was written and reviewed by the crew, so
//      a proofread on it is a model call buying nothing. `chat.callCount` before and after a `compiled` start
//      is the assertion; the prose around it is decoration.
//   5. THE PROVENANCE IS ON THE ROW AND ON THE READ (AC5 / R12), and an ABSENT one means LEGACY — not
//      `compiled`. A phrase written before the field existed has a Seed whose origin nobody recorded, and a
//      projection that guessed would tell an Author their own typed brief was the crew's Overview. So the key
//      is asserted absent (`'seed_source' in view`), not null and not defaulted.
//
// THE FIXTURES use the same broken brief as `run/seed-cleanup.test.ts`, so the two files read as one story:
// the runner's file pins the transform and its guards, this one pins the verb, the refusals, and the write
// the confirm performs. `9b8387ee` is `shared/seed-hash.ts` over that trimmed brief — captured from the
// function, the identical value the Start commit journals beside the copied length.
import { describe, expect, it } from 'vitest';
import { CriteriaEngine } from '../criteria/engine';
import { DigestBuilder } from '../digest/digest';
import { MockChatClient, msg } from '../llm/mock';
import { LoopEngine } from '../loop/engine';
import { RunExecutor } from '../run/executor';
import { MockToolRuntime, AUTHOR_ATTR } from '../run/mock';
import { Store } from '../store/store';
import { seedHashOf } from '../../shared/seed-hash';
import { buildStorylineRuntime } from './server';
import { createStorylineRoutes } from './routes';
import { Hono } from 'hono';
import type { Phrase, Story } from '../../shared/types';
import type { LoopEngineConfig } from '../loop/types';

// THE AUTHOR'S BRIEF, with the grammar still in it — the text they paste into the Seed box.
const BROKEN =
    'A mapmaker she find her own coastline redrawn on a chart she survey herself, and she need 6 charts to prove it to the harbour board that never trusted her.';

// THE CLEANED TEXT the scripted provider answers with: same sentences, grammar fixed, the 6 intact, and the
// same 155 characters, so neither the length envelope nor a dropped digit is what makes the passing case pass.
const CLEAN =
    'A mapmaker finds her own coastline redrawn on a chart she surveyed herself, and she needs 6 charts to prove it to the harbour board that never trusted her.';

/** FNV-1a over the trimmed `BROKEN` — the hash the proposal answers with, and the one the start journals. */
const BROKEN_HASH = '9b8387ee';

interface TestApp {
    app: Hono;
    store: Store;
    /** THE ROUTE TABLE'S TRANSPORT — the same client the runs spawn with, and the one the cleanup asks. */
    chat: MockChatClient;
}

/**
 * The shipped wiring with a scripted provider that answers the cleanup with `CLEAN`. The provider is the
 * real seam: `server.ts` hands the routes the very client it hands the executor, so injecting one here
 * exercises the production path rather than a route built with a private transport.
 */
function makeApp(answer = CLEAN): TestApp {
    const store = Store.empty();
    const criteria = new CriteriaEngine();
    const digest = new DigestBuilder();
    const chat = new MockChatClient(() => ({ message: msg({ content: answer }) }));
    const runtime = new MockToolRuntime(store, '', {});
    const executor = new RunExecutor({ store, runtime, chat, defaultModel: 'mock-gpt' });
    const engineConfig: LoopEngineConfig = { autoSweep: false };
    const engine = new LoopEngine({ store, executor, criteria, digest, config: engineConfig });
    const built = buildStorylineRuntime({ store, chat, runtime, executor, engine, engineConfig, streamDebounceMs: 5 });

    return { app: built.app, store, chat };
}

interface Reply {
    status: number;
    body: unknown;
}

const call = async (
    app: Hono,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown
): Promise<Reply> => {
    const response = await app.request(`http://localhost/v1/storyline${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    });

    return { status: response.status, body: await response.json().catch(() => undefined) };
};

const errorOf = (reply: Reply): string => (reply.body as { error: string }).error;
const viewOf = (reply: Reply): Record<string, unknown> => reply.body as Record<string, unknown>;

/**
 * A Story on the create route's defaults, with a Summary NOBODY has written — the custom arm's book. The
 * scripted answer travels with it, because the guard tests need a Story AND a provider that misbehaves: a
 * refusal is a PROPOSAL outcome, and a proposal needs a book to be about.
 */
async function makeStory(answer = CLEAN): Promise<TestApp & { story: Story }> {
    const world = makeApp(answer);
    const reply = await call(world.app, 'POST', '/stories', {
        title: 'The Salt Cartographer',
        idea: 'A mapmaker finds her own coastline redrawn on a chart she surveyed herself.',
        chapter_count: 2
    });

    return { ...world, story: world.store.stories.require((reply.body as { id: string }).id) };
}

/** A Story whose Summary IS written, so the `compiled` arm has a real Overview to copy. */
async function makeStoryWithSummary(
    text = 'A keeper refuses the relief boat and the island decides for her.'
): Promise<TestApp & { story: Story; overview: string }> {
    const world = await makeStory();
    const premiseId = world.store.phraseGroups.list().find((group) => group.key === 'premise')!.id;

    const revised = await call(world.app, 'POST', `/stories/story_0/phrases/groups/${premiseId}/revise`, {
        content: text
    });

    expect(revised.status).toBe(200);

    return { ...world, overview: (revised.body as { view: { overview: string } }).view.overview };
}

const plotlinesPhrase = (store: Store): Phrase | undefined =>
    store.phrases.list().find((phrase) => phrase.key === 'plotlines');

/** The cleanup read, with the draft in the query — the shape the desk dials. */
const cleanup = (app: Hono, seed: string, key = 'plotlines') =>
    call(app, 'GET', `/stories/story_0/phrases/${key}/seed/cleanup?seed=${encodeURIComponent(seed)}`);

/**
 * THE ROUTE TABLE WITHOUT A TRANSPORT. `server.ts` always resolves one, so this is the hand-wired embed the
 * optional dep exists for: the table built straight from the runtime's own pieces, minus `chat`, mounted under
 * the SAME prefix the shipped server mounts it at (`server/api/server.ts:402` — a bare `createStorylineRoutes`
 * answer carries no `/v1/storyline` prefix of its own, so dialing it unprefixed is a 404 about the mount).
 */
function makeTransportlessApp(): Hono {
    const built = buildStorylineRuntime({
        store: Store.empty(),
        engineConfig: { autoSweep: false },
        chat: new MockChatClient(() => ({ message: msg({ content: CLEAN }) })),
        streamDebounceMs: 5
    });
    // THE DEPS, minus one key: this is the same table `server.ts` builds, assembled from the runtime's own
    // pieces, and `chat` is simply not among them. `defaultModel` is deliberately KEPT, so the refusal below
    // can only be about the missing client — a host that has a model name and no transport is the state a
    // hand-wired embed is actually in, and the verb has to answer THAT, not a hypothetical with neither.
    return new Hono().route(
        '/v1/storyline',
        createStorylineRoutes({
            store: built.store,
            engine: built.engine,
            runtimes: built.runtimes,
            config: built.config,
            criteria: built.criteria,
            digest: built.digest,
            knowledge: built.knowledge,
            threadLog: built.threadLog,
            // Required by `StorylineRoutesDeps` (the roster's model catalog dials it); the cleanup never reads it,
            // so the value only has to be a root here.
            providerBaseUrl: 'http://127.0.0.1:8800',
            defaultModel: built.defaultModel
        })
    );
}

describe('GET /stories/:id/phrases/plotlines/seed/cleanup — the proposal is offered and writes nothing (AC2)', () => {
    it('answers the cleaned text, and asks the model exactly once with no tools (P10: a projection, not a run)', async () => {
        const world = await makeStory();
        const journalBefore = world.store.journal.length;

        const reply = await cleanup(world.app, BROKEN);

        expect(reply.status).toBe(200);
        // THE WHOLE BODY, exact. `text` is the proposal, `changed` says the proposal differs, and the hash is
        // the value that binds the proposal to THIS draft — the desk's proof that a confirm is carrying the
        // bytes the pass actually read.
        expect(reply.body).toEqual({ ok: true, source_hash: BROKEN_HASH, text: CLEAN, changed: true });
        expect(reply.body).toBe(viewOf(reply));

        // ONE tool-less turn on the host's model: no run row, no work item, no thread, and nothing the pass
        // could call that would write a record before the Author confirmed.
        expect(world.chat.callCount).toBe(1);
        // THE MODEL THE ROUTE TABLE WAS BUILT WITH — `server.ts` resolves the model once, from the provider
        // env (`DEFAULT_PROVIDER_MODEL` when the triple is unset), and hands the routes that string. It is NOT
        // the injected executor's model: the cleanup is the routes' own read, so the value pinned here is the
        // one the desk's read actually asks, which is the point of wiring one client and one name.
        expect(world.chat.calls[0].model).toBe('local/basalt');
        expect(world.chat.calls[0].tools).toEqual([]);
        expect(world.chat.calls[0].temperature).toBe(0);

        // THE BOOK IS UNTOUCHED — the part of the promise the desk cannot see from the payload. Phrase ② has
        // no row (so no Seed, so nothing was normalized), and the journal has not grown a line.
        expect(plotlinesPhrase(world.store)).toBeUndefined();
        expect(world.store.journal).toHaveLength(journalBefore);
    });

    it('trims the draft before hashing, so the proposal and the confirm are one text', async () => {
        const world = await makeStory();

        // The padding is the desk's, not the Author's: `StartPhraseRequest`'s `custom` arm trims the same way,
        // so a proposal computed over `  BROKEN  ` is a proposal about the bytes the start would copy.
        const reply = await cleanup(world.app, `  \n${BROKEN}\n  `);

        expect(reply.status).toBe(200);
        expect(reply.body).toEqual({ ok: true, source_hash: BROKEN_HASH, text: CLEAN, changed: true });
        expect(world.chat.calls[0].messages[1].content).toContain(`--- BEGIN BRIEF ---\n${BROKEN}\n--- END BRIEF ---`);
    });

    it('reports "nothing to fix" as the answer, not as a refusal (a proposal identical to the brief)', async () => {
        const world = await makeStory(BROKEN);

        expect((await cleanup(world.app, BROKEN)).body).toEqual({
            ok: true,
            source_hash: BROKEN_HASH,
            text: BROKEN,
            changed: false
        });
    });

    it.each([
        // The rewrite is grammatical and reads BETTER — which is why the guard runs before the Author does.
        [
            'A mapmaker finds her own coastline redrawn on a chart she surveyed herself, and she needs several charts to prove it to the harbour board that never trusted her.',
            'numbers_lost'
        ],
        ['A mapmaker needs 6 charts to prove she was right.', 'too_short'],
        [
            `${CLEAN} The harbour master keeps a lighthouse that no ship has ever needed, and she lights it for nobody.`,
            'too_long'
        ],
        ['', 'empty_answer']
    ] as Array<[string, string]>)('answers a %s-style rewrite as a 200 with no proposal to confirm (AC3)', async (answer, refusal) => {
        // The Story is part of the fixture: a guard refusal is a PROPOSAL outcome on a real book, and the
        // assertion below is that the book is still untouched afterwards.
        const world = await makeStory(answer);
        const journalBefore = world.store.journal.length;

        const reply = await cleanup(world.app, BROKEN);

        expect(reply.status).toBe(200);
        // NO `text` KEY AT ALL. The desk's confirm control reads the proposal, so a refusal that carried the
        // source in `text` would offer the Author their own prose back as a suggestion and let them "confirm"
        // a rewrite the guard just rejected — AC3's silent-confirm, pinned out of existence here.
        expect(reply.body).toEqual({ ok: false, source_hash: BROKEN_HASH, refusal });
        // THE `refusal` KEY IS THERE, with the code the guard named — AC3's half that says WHY there is no
        // proposal, so the desk can tell the Author which rule fired instead of "the Editor shrugged".
        expect('refusal' in (reply.body as Record<string, unknown>)).toBe(true);
        expect('text' in (reply.body as Record<string, unknown>)).toBe(false);
        expect(plotlinesPhrase(world.store)).toBeUndefined();
        expect(world.store.journal).toHaveLength(journalBefore);
    });

    it('400s a request that names no text at all, and asks the model nothing', async () => {
        const world = await makeStory();

        const reply = await call(world.app, 'GET', '/stories/story_0/phrases/plotlines/seed/cleanup');

        expect(reply.status).toBe(400);
        expect(errorOf(reply)).toBe(
            '`seed` is the query parameter this read proofreads — the Author’s pending Seed, which has no row to read it from until the Start copies it (R7, D-72).'
        );
        expect(world.chat.callCount).toBe(0);
    });

    it('400s a blank draft without spending a model call (a blank brief is the Start verb’s 400 anyway)', async () => {
        const world = await makeStory();

        const reply = await cleanup(world.app, '   \n  ');

        expect(reply.status).toBe(400);
        expect(errorOf(reply)).toBe(
            "`seed` is blank, and there is nothing to proofread: the cleanup exists to correct the grammar of text the Author wrote, and an empty Seed is the Start verb's 400 anyway (R7, D-76)."
        );
        expect(world.chat.callCount).toBe(0);
    });

    it('409s Phrase ①, whose Seed the Author never hands over (R7 is the custom arm, and only that arm)', async () => {
        const world = await makeStory();

        const reply = await cleanup(world.app, BROKEN, 'summary');

        expect(reply.status).toBe(409);
        expect(errorOf(reply)).toBe(
            'the summary Phrase has no Seed the Author hands over: its entry set comes from the catalog and the loop writes it, so there is no brief of yours for the Editor to proofread (R7). GET /stories/story_0/phrases/plotlines/seed/cleanup is the read that takes one.'
        );
        expect(world.chat.callCount).toBe(0);
    });

    it('409s a phrase that already started, and spends nothing — the cleanup belongs before the copy (D-72)', async () => {
        const world = await makeStory();

        const started = await call(world.app, 'POST', '/stories/story_0/phrases/plotlines/start', {
            source: 'custom',
            text: BROKEN
        });

        expect(started.status).toBe(200);

        const before = world.chat.callCount;
        const reply = await cleanup(world.app, BROKEN);

        expect(reply.status).toBe(409);
        expect(errorOf(reply)).toBe(
            `the plotlines Phrase is already started on this Story (${plotlinesPhrase(world.store)!.id}), so its Seed is copied and read-only: the cleanup is the Editor's pass over your draft BEFORE the start, and the confirm is the Start press itself (R7, D-72).`
        );
        // The refusal is decided off the ROW, before the transport: asking the model about a Seed that can no
        // longer move is a call the Author pays for and never sees.
        expect(world.chat.callCount).toBe(before);
    });

    it('404s a phrase the catalog does not know, before anything is asked (R1)', async () => {
        const world = await makeStory();

        const reply = await cleanup(world.app, BROKEN, 'unwritten-idea');

        expect(reply.status).toBe(404);
        // THE STORE'S OWN SENTENCE for an unknown phrase — the route checks the book before it checks the
        // query or the transport, so a typo'd key costs no model call and reads like every other 404 here.
        expect(errorOf(reply)).toBe('no phrase named unwritten-idea is in the book (P1: the store is the memory)');
        expect(world.chat.callCount).toBe(0);
    });

    it('409s honestly when the route table has no transport, rather than proposing the Author’s own text', async () => {
        // THE HAND-WIRED EMBED: a host that built the route table from the runtime's pieces and left `chat`
        // out. `server.ts` never does this, so the optional dep exists for exactly this host, and the only
        // honest answer it can give is that there is nothing to ask.
        const bare = makeTransportlessApp();

        await call(bare, 'POST', '/stories', { title: 'No transport', idea: 'A book with no provider.', chapter_count: 1 });

        // ORDERING FIRST: an unknown Story 404s off the book, exactly as every other phrase verb does, before
        // the transport is consulted at all.
        const absent = await call(bare, 'GET', '/stories/story_missing/phrases/plotlines/seed/cleanup?seed=A%20brief.');

        expect(absent.status).toBe(404);
        expect(errorOf(absent)).toBe('no story named story_missing is in the book (P1: the store is the memory)');

        const refused = await call(bare, 'GET', '/stories/story_0/phrases/plotlines/seed/cleanup?seed=A%20brief.');

        expect(refused.status).toBe(409);
        expect(errorOf(refused)).toBe(
            'this server has no model transport wired into its route table, so the Editor has nothing to ask for a proofread (R7): the Seed you typed is still exactly what POST …/phrases/start copies.'
        );

        // THE OTHER ARM OF THE RIG: the same book, the same request, WITH the client wired — so the 409 above
        // is about the missing transport and not about the verb being unreachable.
        const withStory = await makeStory();

        expect((await cleanup(withStory.app, 'A mapmaker she draws what she has seen.')).status).toBe(200);
    });
});

describe('the confirm is the next Start press — the Seed is written once, with the confirmed bytes (AC2)', () => {
    it('copies the proposal exactly once, records `custom`, and asks the model nothing on the write', async () => {
        const world = await makeStory();

        const proposal = viewOf(await cleanup(world.app, BROKEN));

        expect(proposal.ok).toBe(true);

        // THE PRESS, carrying the proposal the way the desk does it: the cleaned text goes in the Seed box and
        // the same `source:'custom'` body sends it. `StartPhraseRequest` grew no flag, so this is the whole
        // of the confirm — the Author's own press, with the bytes they were shown.
        const start = await call(world.app, 'POST', '/stories/story_0/phrases/plotlines/start', {
            source: 'custom',
            text: proposal.text as string
        });

        expect(start.status).toBe(200);

        // ONE row, holding EXACTLY the proposal — not the Author's broken draft, and not a third text.
        const phrase = plotlinesPhrase(world.store)!;

        expect(world.store.phrases.list().filter((row) => row.key === 'plotlines')).toHaveLength(1);
        expect(phrase.seed).toBe(CLEAN);
        expect(phrase.seed_source).toBe('custom');

        // The receipt and the rail agree with the row, and the receipt's `view` is where the desk learns the
        // provenance without a second read.
        const receipt = viewOf(start);

        expect(receipt.seed_chars).toBe(CLEAN.length);
        expect(receipt.seed_head).toBe(CLEAN);
        expect((receipt.view as Record<string, unknown>).seed_source).toBe('custom');
        expect(viewOf(await call(world.app, 'GET', '/stories/story_0/phrases/plotlines')).seed_source).toBe('custom');

        // AC2's other half: the cleanup asked ONCE, and the start asked nothing at all. The write is a copy.
        expect(world.chat.callCount).toBe(1);
    });

    it('keeps the Author’s own text when the guard refused the rewrite — nothing was silently confirmed (AC3)', async () => {
        // The model's answer loses the 6, so the pass has NO proposal; the desk shows the refusal and the
        // draft stays as the Author wrote it.
        const world = await makeStory(
            'A mapmaker finds her own coastline redrawn on a chart she surveyed herself, and she needs several charts to prove it to the harbour board that never trusted her.'
        );

        expect(viewOf(await cleanup(world.app, BROKEN))).toEqual({
            ok: false,
            source_hash: BROKEN_HASH,
            refusal: 'numbers_lost'
        });

        const start = await call(world.app, 'POST', '/stories/story_0/phrases/plotlines/start', {
            source: 'custom',
            text: BROKEN
        });

        expect(start.status).toBe(200);
        // THE SEED IS THE AUTHOR'S TEXT, guards and all. A rejected cleanup is a no-op: the phrase is never
        // started on a rewrite nobody accepted, which is the state a confirm flag on the request would have
        // made reachable.
        expect(plotlinesPhrase(world.store)!.seed).toBe(BROKEN);
        expect(plotlinesPhrase(world.store)!.seed_source).toBe('custom');
        expect(world.chat.callCount).toBe(1);
    });

    it('asks the model NOTHING on the compiled arm, and records the provenance as `compiled` (AC2 / AC5)', async () => {
        const world = await makeStoryWithSummary();
        const before = world.chat.callCount;

        const start = await call(world.app, 'POST', '/stories/story_0/phrases/plotlines/start', { source: 'compiled' });

        expect(start.status).toBe(200);
        // Zero calls: the Overview the crew wrote is already reviewed prose, so a proofread would only move
        // the Seed away from the text the rail showed (R7's whole reason the arm is not offered one).
        expect(world.chat.callCount).toBe(before);
        expect(plotlinesPhrase(world.store)!.seed).toBe(world.overview);
        expect(plotlinesPhrase(world.store)!.seed_source).toBe('compiled');
        expect(viewOf(start).source).toBe('compiled');
        expect((viewOf(start).view as Record<string, unknown>).seed_source).toBe('compiled');
    });
});

describe('R12 — an absent provenance means LEGACY, never `compiled` (R6 no-migration rule)', () => {
    it('answers a phrase whose row predates the field with the key ABSENT while the Seed still shows', async () => {
        const world = await makeStory();

        // A LEGACY ROW, written the way the store wrote one before this field existed: the copied Seed is
        // there, and no word about which arm copied it. Minted through the store because the current start
        // verb always records the arm, so nothing in the route can produce the older shape.
        const legacy = world.store.phrases.create(
            {
                story_id: world.story.id,
                key: 'plotlines',
                title: 'Plotlines',
                description: 'The chapter set this Story writes.',
                content: '',
                order: 2,
                revision: 0,
                group_refs: [],
                seed: 'Six chapters, alternating timeline, no frame story.'
            },
            AUTHOR_ATTR
        );

        expect(legacy.seed_source).toBeUndefined();

        const view = viewOf(await call(world.app, 'GET', '/stories/story_0/phrases/plotlines'));

        // THE SEED STILL READS — the rail is not blind about the text — while the ORIGIN is absent from the
        // payload. Not `null`, not `compiled`: the desk has to be able to tell "unknown" from "the crew's".
        expect(view.seed_head).toBe('Six chapters, alternating timeline, no frame story.');
        expect(view.seed_chars).toBe('Six chapters, alternating timeline, no frame story.'.length);
        expect('seed_source' in view).toBe(false);
    });

    it('carries no provenance for a phrase that has not started (there is no copy to have an origin)', async () => {
        const world = await makeStory();

        const view = viewOf(await call(world.app, 'GET', '/stories/story_0/phrases/plotlines'));

        expect(view.phrase_id).toBeNull();
        expect('seed_source' in view).toBe(false);
    });
});
