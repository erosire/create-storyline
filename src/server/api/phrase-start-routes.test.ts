// PHRASE ② (T-W3) — the on-demand START verb, the PER-PHRASE rail read, the per-phrase gates on the group
// verbs, and `plotlines_mode` on the two Story routes.
//
// WHAT THIS FILE PINS, and why each thing is a test rather than a comment:
//
//   1. THE SEED IS COPIED (D-72). The whole phrase-independence rule rests on one row field: the text handed
//      to `POST …/phrases/plotlines/start` becomes `phrases.seed`, and every later read of THAT phrase goes
//      through it. So the test that matters most here is not "the start returned 200" — it is "the Summary
//      moved afterwards and the phrase did not", asserted against the rows and against the rail's own
//      `seed_head`, which is the text the Author is shown when they press the handoff button.
//   2. THE COPIED TEXT IS THE COMPILED SUMMARY, by the same read the rail previews
//      (`projections.ts:compiledSummaryOf`), so a button cannot offer what the verb then refuses. The test
//      therefore asserts the copied seed EQUALS the Overview `GET …/phrases` reports, byte for byte.
//   3. THE REFUSALS ARE PRODUCT COPY (L-13): a `source: 'custom'` with no text, an empty compiled Summary,
//      a second start, a phrase the loop starts, and a `classic` book asked to revise a chapter entry are all
//      sentences an Author reads, so they are asserted VERBATIM — including the P4 sentence's two verbs,
//      which is what makes the 409 actionable rather than a dead end.
//   4. THE PER-PHRASE GATE MOVES THE DIAL, NOT THE SENTENCE. Every Summary refusal string this wave touched is
//      re-pinned here unchanged (the same copies `phrase-routes.test.ts` and `phrase-lock-routes.test.ts`
//      pin), because generalising the gate is only safe if the legacy book still hears exactly what it heard
//      before. The Plotlines arm is pinned next to it, so the pair is visible as one rule read twice.
//   5. THE RAIL READS ITS OWN PHRASE: a Plotlines read carries the chapter entries and nothing else, has no
//      `review.mirror` (R6's mirror is the Summary's legacy prose), and answers the phrase's brief block.
//   6. THE NEW STORY FIELDS are additive, and a test names the three of them, because the dashboard wave
//      builds its button-enable condition off `summary_compiled` and its rail rows off `phrase_started`.
//
// THE IDS: a route-created Story mints its phrase and group rows with `newRecordUid`, so ids come out of the
// store and the expectations name them through those reads. The counter-minted rows (`summary_0`,
// `group_revision_N`) are pinned literally. Journal reads use `slice(-1)[0]`, not `.at(-1)` (the package's
// tsconfig lib predates ES2022).
import { describe, expect, it } from 'vitest';
import { CriteriaEngine } from '../criteria/engine';
import { DigestBuilder } from '../digest/digest';
import { MockChatClient, msg } from '../llm/mock';
import { LoopEngine } from '../loop/engine';
import { RunExecutor } from '../run/executor';
import { MockToolRuntime, AUTHOR_ATTR } from '../run/mock';
import { Store } from '../store/store';
// R7 (this wave) — the Start verb's journal line names the `seed_hash` of the bytes it copied, and this file
// pins that literal. Same function the phrase's own gates hash with, so the two values are one fact.
import { seedHashOf } from '../../shared/seed-hash';
import { buildStorylineRuntime } from './server';
// THE PHRASE DOMAIN, used here as a FIXTURE only. The chapter entries exist because the Editor's brief was
// accepted, and the only honest way to get real ones is the domain operation that creates them — this file
// pins the HTTP surface, not the accept rule (that is `phrase/plotlines.test.ts`).
import { acceptPlotlineBrief, createPlotlineBrief, startPlotlinesPhrase } from '../phrase';
import type { Hono } from 'hono';
import type { Phrase, PlotlineBrief, Story } from '../../shared/types';
// THE SERVER'S OWN STORY READ TYPE, which is the pinned client `StoryView` WIDENED by the three phrase-rail
// fields (T-W3): asserting through it pins the additive fields without touching `dashboard/api.ts`.
import type { StorylineStoryView } from './projections';
import type { LoopEngineConfig } from '../loop/types';

interface TestApp {
    app: Hono;
    store: Store;
    /** THE ROUTE TABLE'S TRANSPORT. Returned so a test can count model calls rather than infer them. */
    chat: MockChatClient;
}

/** The shipped wiring with the loop's two doubles and the sweep timer off (as in `phrase-routes.test.ts`). */
function makeApp(): TestApp {
    const store = Store.empty();
    const criteria = new CriteriaEngine();
    const digest = new DigestBuilder();
    const chat = new MockChatClient(() => ({ message: msg({ content: 'nothing to report' }) }));
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
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown
): Promise<Reply> => {
    const response = await app.request(`http://localhost/v1/storyline${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    });

    const text = await response.text();

    return { status: response.status, body: text.length === 0 ? undefined : JSON.parse(text) };
};

const errorOf = (reply: Reply): string => (reply.body as { error: string }).error;
const viewOf = (reply: Reply): Record<string, unknown> => reply.body as Record<string, unknown>;

/** The LAST journal line a commit label wrote — the audit read every phrase verb is pinned against. */
const journalWhy = (store: Store, label: string): string =>
    (store.journal.filter((event) => event.commit_label === label).slice(-1)[0].attribution as { why: string }).why;

/**
 * R12 — the commit's lines by OPERATION, oldest first.
 *
 * The Start commit writes TWO events in one group: the phrase CREATE that copies the Seed, and the UPDATE
 * that records which arm wrote it (`Phrase.seed_source`, R12). `journalWhy` therefore lands on the
 * provenance line now, so a test that means "what did the copy itself say" names the create. Both lists are
 * pinned where they matter, because the honest audit of a start IS two sentences — the bytes, and where they
 * came from.
 */
const journalWhysByOp = (store: Store, label: string): Array<{ op: string; why: string }> =>
    store.journal
        .filter((event) => event.commit_label === label)
        .map((event) => ({ op: event.op, why: (event.attribution as { why: string }).why }));

/** The CREATE line of a start — the sentence that names the copied text. */
const journalCreateWhy = (store: Store, label: string): string =>
    journalWhysByOp(store, label).filter((event) => event.op === 'create')[0].why;

/** The UPDATE line of a start — the sentence that names the arm (`Phrase.seed_source`). */
const journalProvenanceWhy = (store: Store, label: string): string =>
    journalWhysByOp(store, label).filter((event) => event.op === 'update')[0].why;

/**
 * A Story on the create route's DEFAULTS — both dials on (R5/R11: `summary_mode: 'groups'` and
 * `plotlines_mode: 'groups'`) and a Summary nobody has written yet.
 */
async function makeStory(
    body: Record<string, unknown> = {
        title: 'The Salt Cartographer',
        idea: 'A mapmaker finds her own coastline redrawn on a chart she surveyed herself.',
        chapter_count: 2
    }
): Promise<TestApp & { story: Story }> {
    const world = makeApp();
    const reply = await call(world.app, 'POST', '/stories', body);
    const story = world.store.stories.require((reply.body as { id: string }).id);

    return { ...world, story };
}

/**
 * A Story whose Summary IS written: one group carries known prose, so the compiled Summary the start verb
 * copies is a string this file can state exactly (`## <title>` + the text, per the composition rule the
 * `PhraseView.overview` note states and `phrase-routes.test.ts` pins).
 */
async function makeStoryWithSummary(text = 'A keeper refuses the relief boat and the island decides for her.'): Promise<
    TestApp & { story: Story; overview: string }
> {
    const world = await makeStory();
    const premiseId = world.store.phraseGroups.list().find((group) => group.key === 'premise')!.id;

    const revised = await call(world.app, 'POST', `/stories/story_0/phrases/groups/${premiseId}/revise`, {
        content: text
    });

    expect(revised.status).toBe(200);

    const overview = (revised.body as { view: { overview: string } }).view.overview;

    expect(overview).toBe(`## Premise\n${text}`);

    return { ...world, overview };
}

/** One Story's Plotlines Phrase row, read from the book (a started phrase is a ROW — that is the fact). */
const plotlinesPhrase = (store: Store): Phrase | undefined =>
    store.phrases.list().find((phrase) => phrase.key === 'plotlines');

/** The brief the Editor's structure pass writes, through the domain operation the tool surface writes with. */
function seedBrief(store: Store, story: Story, phrase: Phrase, chapterCount: number): PlotlineBrief {
    return createPlotlineBrief(store, story, phrase, { chapter_count: chapterCount }, AUTHOR_ATTR);
}

describe("POST /stories: Phrase ② has its own dial, validated like the Summary's (R11, D-71)", () => {
    it('books a NEW Story on the chapter-entry pipeline and answers the three rail fields', async () => {
        const world = makeApp();

        const reply = await call(world.app, 'POST', '/stories', {
            idea: 'A translator finds a letter she wrote in a language she has never learned.',
            chapter_count: 3
        });

        expect(reply.status).toBe(200);

        const story = world.store.stories.require((reply.body as { id: string }).id);

        // The engine's default, NOT a route-invented one: an omitted key reaches `createStory` absent.
        expect(story.plotlines_mode).toBe('groups');

        const view = viewOf(await call(world.app, 'GET', '/stories/story_0'));
        const rail = view as unknown as StorylineStoryView;

        expect(rail.plotlines_mode).toBe('groups');
        // THE RAIL'S TWO ROWS: Phrase ① exists from the create commit (R1), Phrase ② exists only once the
        // Author starts it — and while it does not, `plotlines_mode` is still movable (P4).
        expect(rail.phrase_started).toEqual({ summary: true, plotlines: false });
        // NOTHING TO COPY YET: no group has text, so the handoff button is grey. This is the WEAKER question
        // ("is there text"), and the Start verb's 409 is the server's answer to the same one.
        expect(rail.summary_compiled).toBe(false);
    });

    it.each([
        ['grouping', 'a typo for one of the two words'],
        ['sampling', "the OTHER phrase's off-word, which is not this dial's word"]
    ])('refuses `plotlines_mode: %s` (%s) and books nothing', async (mode) => {
        const world = makeApp();

        const reply = await call(world.app, 'POST', '/stories', {
            idea: 'A cartographer maps a coastline that keeps moving.',
            plotlines_mode: mode
        });

        expect(reply.status).toBe(400);
        expect(errorOf(reply)).toBe(
            '`plotlines_mode` must be `\'groups\'` (the chapter entries, one per chapter the Plotlines brief declares) or `\'classic\'` (the §4.3 plotline tools, the pipeline every book written before Phrase ② runs).'
        );
        expect(world.store.stories.list()).toEqual([]);
    });

    it('books a `classic` Story, and the view says classic rather than inventing the new default', async () => {
        const world = makeApp();

        const reply = await call(world.app, 'POST', '/stories', {
            idea: 'A lighthouse keeper logs a ship that never arrives.',
            plotlines_mode: 'classic'
        });

        expect(reply.status).toBe(200);
        expect(world.store.stories.require((reply.body as { id: string }).id).plotlines_mode).toBe('classic');
        expect(viewOf(await call(world.app, 'GET', '/stories/story_0')).plotlines_mode).toBe('classic');
    });
});

describe('PATCH /stories/:id: the Plotlines dial moves only while the phrase is unstarted (P4)', () => {
    it('moves an un-started Phrase ② and journals the decision', async () => {
        const world = await makeStory();

        const reply = await call(world.app, 'PATCH', '/stories/story_0', { plotlines_mode: 'classic' });

        expect(reply.status).toBe(200);
        expect(world.store.stories.require('story_0').plotlines_mode).toBe('classic');

        // The journal names the move, because "who writes a whole phase" is a decision a later reader has to
        // be able to date (P11).
        expect(journalWhy(world.store, 'patch_story')).toContain(
            'Phrase ② now writes its plotlines through the classic tools (R11)'
        );
        expect(journalWhy(world.store, 'patch_story')).toContain('the Author used PATCH /stories/:id on story_0');

        // And the rail's field follows the row, so a disabled button and a verb's 409 agree (P4).
        expect(viewOf(await call(world.app, 'GET', '/stories/story_0')).plotlines_mode).toBe('classic');
    });

    it('refuses a word outside the two, and refuses to move a started phrase', async () => {
        const world = await makeStory();

        const bad = await call(world.app, 'PATCH', '/stories/story_0', { plotlines_mode: 'chapter' });

        expect(bad.status).toBe(400);
        expect(errorOf(bad)).toBe(
            "`plotlines_mode` must be 'groups' (the chapter entries) or 'classic' (the plotline tools); omitting it leaves the Story as it is (R11)."
        );

        const started = await call(world.app, 'POST', '/stories/story_0/phrases/plotlines/start', {
            source: 'custom',
            text: 'A coast guard finds a wreck she reported herself.'
        });

        expect(started.status).toBe(200);

        const phraseId = plotlinesPhrase(world.store)!.id;
        const move = await call(world.app, 'PATCH', '/stories/story_0', { plotlines_mode: 'classic' });

        expect(move.status).toBe(409);
        // THE SENTENCE NAMES THE ROW, because the row is the thing that made the dial unmovable.
        expect(errorOf(move)).toBe(
            `this Story's Plotlines Phrase is already started (${phraseId}), so \`plotlines_mode\` no longer moves: its copied seed, its chapter entries and its claim keys were written under the pipeline that was chosen at the start, and switching lanes now would leave entries nobody chose (P4).`
        );
        expect(world.store.stories.require('story_0').plotlines_mode).toBe('groups');
    });

    it('takes a no-op write of the value the row already carries, so an idempotent client does not fail', async () => {
        const world = await makeStory();

        const started = await call(world.app, 'POST', '/stories/story_0/phrases/plotlines/start', {
            source: 'custom',
            text: 'A coast guard finds a wreck she reported herself.'
        });

        expect(started.status).toBe(200);

        // The started phrase blocks a CHANGE of lane; it does not block a client re-PUTting the value it
        // read, which changes nothing and therefore refuses nothing.
        expect((await call(world.app, 'PATCH', '/stories/story_0', { plotlines_mode: 'groups' })).status).toBe(200);
        expect(world.store.stories.require('story_0').plotlines_mode).toBe('groups');
    });
});

describe('GET /stories/:id/phrases/:key: one rail read, scoped to the phrase named (R11)', () => {
    it('answers an un-started Phrase ② in the empty shape rather than a 404 (R6, generalised)', async () => {
        const world = await makeStory();

        const reply = await call(world.app, 'GET', '/stories/story_0/phrases/plotlines');

        expect(reply.status).toBe(200);

        const view = viewOf(reply);

        expect(Object.keys(view).sort()).toEqual([
            'brief',
            'findings',
            'groups',
            'key',
            'mode',
            'overview',
            'phrase_id',
            'review',
            'reviewed',
            'revision',
            'seed_chars',
            'seed_head',
            'story_id',
            'tasks'
        ]);
        expect(view.key).toBe('plotlines');
        expect(view.phrase_id).toBeNull();
        // The dial is on for a NEW book (the create default), and the phrase is still un-started — the rail
        // shows both facts at once rather than collapsing one into the other.
        expect(view.mode).toBe('groups');
        expect(view.groups).toEqual([]);
        expect(view.findings).toEqual([]);
        expect(view.tasks).toEqual([]);
        expect(view.overview).toBe('');
        expect(view.revision).toBe(0);
        expect(view.brief).toBeNull();
        // THE SEED PREVIEW OF A PHRASE WITH NO ROW is the text it WOULD copy — the same fallback every
        // phrase-level gate reads (`phraseSeedOf`), so the rail and the gate agree before the start too.
        expect(view.seed_head).toBe(world.story.idea);
        expect(view.seed_chars).toBe(world.story.idea.length);

        const review = view.review as Record<string, unknown>;

        expect(Object.keys(review).sort()).toEqual([
            'blocking_findings',
            'deep_reviews_on_current_vector',
            'mode',
            'open_findings',
            'open_tasks',
            'review_seats',
            'reviews_on_current_vector',
            'unwritten_groups',
            'vector',
            'vector_hash',
            'written_groups'
        ]);
        expect(review.mode).toBe('groups');
        // A phrase with no rows has no catalog keys to be owed either — `[]`, not the Summary's five.
        expect(review.unwritten_groups).toEqual([]);
        // R6's mirror is the legacy `summaries` prose. Phrase ② has no such record, so the key is ABSENT.
        expect(review).not.toHaveProperty('mirror');
    });

    it('keeps the Summary leg the pinned view plus exactly the four deltas', async () => {
        const world = await makeStory();

        const pinned = viewOf(await call(world.app, 'GET', '/stories/story_0/phrases'));
        const detail = viewOf(await call(world.app, 'GET', '/stories/story_0/phrases/summary'));

        // ONE projection, so the two reads cannot drift: every pinned field is byte-identical...
        for (const key of Object.keys(pinned)) expect(detail[key]).toEqual(pinned[key]);

        expect(detail.key).toBe('summary');
        expect(detail.seed_head).toBe(world.story.idea);
        expect(detail.seed_chars).toBe(world.story.idea.length);
        expect(detail.brief).toBeNull();

        // ...and the Summary KEEPS its mirror, because that is the phrase the legacy prose belongs to.
        expect((detail.review as Record<string, unknown>).mirror).toEqual(
            (pinned.review as Record<string, unknown>).mirror
        );
    });

    it('404s a phrase the catalog does not have, and never guesses the Summary', async () => {
        const world = await makeStory();

        const reply = await call(world.app, 'GET', '/stories/story_0/phrases/chapters');

        expect(reply.status).toBe(404);
        expect(errorOf(reply)).toBe('no phrase named chapters is in the book (P1: the store is the memory)');
    });
});

describe('POST /stories/:id/phrases/:key/start: the Author starts Phrase ② from a Seed they choose (R5, D-76)', () => {
    it('copies the COMPILED Summary — the Overview the rail shows — onto the phrase row', async () => {
        // TWO BOOKS in one world: `story_0` gets the written Summary, and `story_1` (created by the same
        // `POST /stories` route below) is the second start's target. A Story id is counter-minted per book,
        // so the ids are known: `story_0` then `story_1`.
        const world = makeApp();

        const created = await call(world.app, 'POST', '/stories', {
            title: 'The Salt Cartographer',
            idea: 'A mapmaker finds her own coastline redrawn on a chart she surveyed herself.',
            chapter_count: 2
        });

        expect(created.status).toBe(200);

        await call(world.app, 'POST', '/stories', {
            title: 'The Second Book',
            idea: 'A translator finds a letter she wrote in a language she never learned.',
            chapter_count: 1
        });

        const premiseId = world.store.phraseGroups
            .list()
            .filter((group) => group.story_id === 'story_0')
            .find((group) => group.key === 'premise')!
            .id;

        const written = await call(
            world.app,
            'POST',
            `/stories/story_0/phrases/groups/${premiseId}/revise`,
            { content: 'A keeper refuses the relief boat and the island decides for her.' }
        );

        expect(written.status).toBe(200);

        const overview = (written.body as { view: { overview: string } }).view.overview;

        expect(overview).toBe('## Premise\nA keeper refuses the relief boat and the island decides for her.');

        const reply = await call(world.app, 'POST', '/stories/story_0/phrases/plotlines/start', { source: 'compiled' });

        expect(reply.status).toBe(200);

        const body = viewOf(reply);
        const phrase = plotlinesPhrase(world.store)!;

        expect(Object.keys(body)).toEqual([
            'story_id',
            'phrase_id',
            'key',
            'source',
            'seed_chars',
            'seed_head',
            'started',
            // R8 — the two phase fields are ADDITIVE, in the order the receipt answers them: `started` is
            // the phrase row, `phase_opened` is the loop's pointer. Nothing above this line moved.
            'phase_opened',
            'phase_open_reason',
            'view'
        ]);
        expect(body.story_id).toBe('story_0');
        expect(body.phrase_id).toBe(phrase.id);
        expect(body.key).toBe('plotlines');
        expect(body.source).toBe('compiled');
        expect(body.started).toBe(true);
        // THE COPY, byte for byte: the text the rail previewed is the text the phrase holds. A start that
        // copied `stories.idea`, or an agent's retelling, would fail right here.
        expect(phrase.seed).toBe(overview);
        expect(body.seed_head).toBe(overview);
        expect(body.seed_chars).toBe(overview.length);
        // R8, HALF ONE — THIS BOOK'S SUMMARY IS NOT SIGNED OFF, so the crew stays exactly where it was. The
        // phrase started; the pointer did not, and the reason names the verb that DOES move it. (The
        // signed-off half — the pointer moving — is the `R8` block below.)
        expect(body.phase_opened).toBe(false);
        expect(body.phase_open_reason).toBe(
            'the Summary is not signed off, so the crew stays on Phrase ①: POST /stories/story_0/lock is the act that signs phase summary off and opens phase plotlines (L-33: a phase is entered only with every earlier phase locked)'
        );
        expect(world.store.stories.require('story_0')).toMatchObject({ phase: 'summary', summary_locked: false });
        // And no phase commit happened at all: `phrase_start` is the only label this press writes.
        expect(world.store.journal.filter((event) => event.commit_label === 'open_plotlines_phase')).toHaveLength(0);

        // The start is the ROW (there is no counter for it), and it is journaled in the same commit.
        expect(phrase.key).toBe('plotlines');
        expect(phrase.revision).toBe(0);
        expect(phrase.group_refs).toEqual([]);
        // The start is the ROW (there is no counter for it), and it is journaled in the same commit — TWO
        // lines, one commit: the copy, and the provenance R12 records beside it. They cannot disagree, and a
        // start that recorded only one of the two would leave the row's own origin unstated.
        expect(journalWhysByOp(world.store, 'phrase_start').map((event) => event.op)).toEqual(['create', 'update']);
        expect(journalCreateWhy(world.store, 'phrase_start')).toContain(
            "the Plotlines Phrase was started from the Story's compiled Summary (D-72)"
        );
        // R12 — the arm, named on the row AND in its audit line, in the same commit as the copy.
        expect(phrase.seed_source).toBe('compiled');
        expect(journalProvenanceWhy(world.store, 'phrase_start')).toContain(
            'the Seed this phrase copies came from `compiled`'
        );

        // And the response's `view` is the read a fresh GET answers — the rail needs no follow-up call.
        expect(body.view).toEqual(viewOf(await call(world.app, 'GET', '/stories/story_0/phrases/plotlines')));

        // A SECOND start on this book is the 409; a start on `story_1`, whose Summary is unwritten, is the
        // empty-compiled 409 — and neither mints a row, so the one phrase below is the only one there is.
        expect(
            (await call(world.app, 'POST', '/stories/story_1/phrases/plotlines/start', { source: 'compiled' })).status
        ).toBe(409);
        expect(world.store.phrases.list().filter((row) => row.key === 'plotlines')).toHaveLength(1);
    });

    it("starts from the Author's own text on the custom arm, trimmed but otherwise untouched", async () => {
        const world = await makeStory();
        const seed = 'Three years after the tide charts were withdrawn, the salt roads reopen.';

        const reply = await call(world.app, 'POST', '/stories/story_0/phrases/plotlines/start', {
            source: 'custom',
            text: `  ${seed}  `
        });

        expect(reply.status).toBe(200);
        // Trimmed at the edges, verbatim inside: the verb does not re-write the Author's sentence.
        expect(plotlinesPhrase(world.store)!.seed).toBe(seed);
        expect(viewOf(await call(world.app, 'GET', '/stories/story_0/phrases/plotlines')).seed_head).toBe(seed);
    });

    // THE ARMS, READ AS A START AND A COPY (AC1 / AC2). R7's recorded decision puts a one-time grammar pass on
    // the `custom` arm ONLY, as a proposal the Author confirms BEFORE this verb runs; the `compiled` arm is the
    // crew's own reviewed text and gets no pass at all. Neither half of that can be pinned by asserting a
    // response shape, so these two tests assert the two things that would actually break: the compiled arm
    // asking a model (a second opinion about text the Critic already graded, and a Seed that no longer matches
    // the rail), and a start writing its Seed more than once (D-72 — a re-seeded phrase has entries, revisions
    // and claim keys pointing at words that used to be there).
    it('asks the model NOTHING on the compiled arm, and copies the compiled Summary byte for byte (AC2)', async () => {
        const world = await makeStoryWithSummary();
        const before = world.chat.callCount;

        const reply = await call(world.app, 'POST', '/stories/story_0/phrases/plotlines/start', { source: 'compiled' });

        expect(reply.status).toBe(200);
        // ZERO calls. The sweep timer is off in this rig, so the only thing that could have asked is this verb —
        // and the `compiled` arm must never ask: the Overview it copies was written by the crew and reviewed by
        // the Critic, so a cleanup pass would move the Seed away from the text the rail showed.
        expect(world.chat.callCount).toBe(before);
        // BYTE-IDENTICAL, in all three places the copy can be read: the row, the receipt, and the fresh rail read.
        expect(plotlinesPhrase(world.store)!.seed).toBe(world.overview);
        expect(viewOf(reply).seed_head).toBe(world.overview);
        expect(viewOf(reply).seed_chars).toBe(world.overview.length);
        // And one row, in ONE commit — the copy is one act, whatever arm produced the text. The commit carries
        // two events (the create, and R12's provenance update), and neither of them is a model call: the
        // compiled arm still asks the transport nothing, which is the `callCount` assertion above.
        expect(world.store.phrases.list().filter((row) => row.key === 'plotlines')).toHaveLength(1);
        expect(world.store.journal.filter((event) => event.commit_label === 'phrase_start')).toHaveLength(2);
    });

    it('writes the confirmed custom Seed ONCE, and the journal names the bytes it wrote (AC1)', async () => {
        // NO COMPILED SUMMARY on this book (`makeStory` writes none), which is the arm the desk used to refuse
        // even though the verb accepts it — AC4's server half, and the reason a cleanup proposal has to be
        // produced BEFORE the start rather than corrected after it.
        const world = await makeStory();
        const model = new MockChatClient(() => ({ message: msg({ content: 'no crew answer expected' }) }));

        // THE CONFIRM, modelled the way the desk performs it: the proposal text is the text the Author presses
        // Start with, so `text` here is the confirmed cleanup and this verb is only the write. `model` is parked
        // beside the rig rather than wired into it — nothing on this path may reach a transport.
        expect(model.callCount).toBe(0);

        const confirmed =
            'A mapmaker finds her own coastline redrawn on a chart she surveyed herself, and she needs 6 charts to prove it.';

        expect(world.store.phrases.list().filter((row) => row.key === 'plotlines')).toHaveLength(0);

        const reply = await call(world.app, 'POST', '/stories/story_0/phrases/plotlines/start', {
            source: 'custom',
            text: confirmed
        });

        expect(reply.status).toBe(200);
        expect(viewOf(reply).source).toBe('custom');
        expect(world.chat.callCount).toBe(0);

        // ONE write, and it holds exactly the confirmed text (D-72: this is the copy, and it is the only one).
        // R12 — the same commit records the ARM: `custom`, because these bytes came from the Author's hand
        // (through the cleanup proposal they confirmed), and that word is what tells the next reader no
        // further pass is owed and no compiled Overview was involved.
        const rows = world.store.phrases.list().filter((row) => row.key === 'plotlines');

        expect(rows).toHaveLength(1);
        expect(rows[0].seed).toBe(confirmed);
        expect(rows[0].seed_source).toBe('custom');
        expect(journalWhysByOp(world.store, 'phrase_start').map((event) => event.op)).toEqual(['create', 'update']);

        // THE AUDIT LINE NAMES THE TEXT (P11): the length and the hash of what was copied, the same hash every
        // Phrase-② gate is keyed to. "Started from the Author's own text" alone left the copied bytes unnamed.
        expect(journalCreateWhy(world.store, 'phrase_start')).toContain(
            `the Plotlines Phrase was started from the Author's own text (D-72) — ${confirmed.length} characters, seed_hash=${seedHashOf(confirmed)}.`
        );
        // And the provenance line says which arm, in the words the desk's cleanup gate reads.
        expect(journalProvenanceWhy(world.store, 'phrase_start')).toContain(
            'the Seed this phrase copies came from `custom`'
        );

        // A second press cannot replace it: the 409 that names the row, and the row still holds the confirmed
        // bytes (D-76 / §18.13 — after the start there is no verb that re-seeds a phrase). The refused press
        // wrote NOTHING, so the commit count is the two lines the first press wrote — no third provenance
        // line, and no re-labelled arm (R12: only the writer of the row declares its origin).
        const again = await call(world.app, 'POST', '/stories/story_0/phrases/plotlines/start', {
            source: 'custom',
            text: 'A cleaner rewrite nobody confirmed.'
        });

        expect(again.status).toBe(409);
        expect(plotlinesPhrase(world.store)!.seed).toBe(confirmed);
        expect(plotlinesPhrase(world.store)!.seed_source).toBe('custom');
        expect(world.store.journal.filter((event) => event.commit_label === 'phrase_start')).toHaveLength(2);
        expect(world.chat.callCount).toBe(0);
    });

    it('treats an absent body as `source: compiled`, and previews at most 400 characters of the seed', async () => {
        const world = await makeStoryWithSummary('A keeper refuses the relief boat.');

        const withoutBody = await call(world.app, 'POST', '/stories/story_0/phrases/plotlines/start');

        expect(withoutBody.status).toBe(200);
        expect((withoutBody.body as { source: string }).source).toBe('compiled');
        expect(plotlinesPhrase(world.store)!.seed).toBe('## Premise\nA keeper refuses the relief boat.');

        // A SECOND press on the same book is the 409 that names the row, not a re-seed.
        expect(
            (
                await call(world.app, 'POST', '/stories/story_0/phrases/plotlines/start', {
                    source: 'custom',
                    text: 'A different seed.'
                })
            ).status
        ).toBe(409);

        // A LONG SEED travels as a window plus its true length, never as the whole prompt input. On a second
        // book, so the phrase really is fresh: 30 × `'Seed sentence. '` is 450 characters and the start trims
        // the trailing space, so the seed is 449 — the head is exactly the contract's 400 and `seed_chars`
        // still reports 449. A rail that rendered the head as though it were the whole seed would be lying
        // about how much text the crew was actually started on.
        await call(world.app, 'POST', '/stories', { idea: 'A coast guard logs a wreck she reported herself.' });

        const long = 'Seed sentence. '.repeat(30);

        expect(long.length).toBe(450);
        expect(long.trim().length).toBe(449);

        const started = await call(world.app, 'POST', '/stories/story_1/phrases/plotlines/start', {
            source: 'custom',
            text: long
        });

        expect(started.status).toBe(200);

        const view = (started.body as { view: Record<string, unknown> }).view;

        expect(view.seed_chars).toBe(449);
        expect((view.seed_head as string).length).toBe(400);
        expect(view.seed_head).toBe(long.trim().slice(0, 400));
    });

    it('leaves the copied seed where it was when Phrase ① moves on (D-72)', async () => {
        const world = await makeStoryWithSummary('A keeper refuses the relief boat.');

        expect(
            (await call(world.app, 'POST', '/stories/story_0/phrases/plotlines/start', { source: 'compiled' })).status
        ).toBe(200);

        const phraseId = plotlinesPhrase(world.store)!.id;

        expect(plotlinesPhrase(world.store)!.seed).toBe('## Premise\nA keeper refuses the relief boat.');

        // Phrase ① moves: another group is written, so the COMPOSED Summary changes...
        const themeId = world.store.phraseGroups.list().find((group) => group.key === 'theme')!.id;

        expect(
            (
                await call(world.app, 'POST', `/stories/story_0/phrases/groups/${themeId}/revise`, {
                    content: 'The chart is not the sea, and the sea does not care.'
                })
            ).status
        ).toBe(200);

        // ...and the Story's Seed is edited through the store, the way a backtrack edits it...
        const story = world.store.stories.require('story_0');

        world.store.stories.update(
            story.id,
            { idea: 'A different seed entirely: the coastline walks inland.' },
            { run_ref: null, author: true, why: 'seed: the Author edited the Seed after the handoff (T-W3 fixture)' },
            [{ id: story.id, rev: story.rev }]
        );

        // ...and Phrase ② is untouched: its row still holds the text it was handed, and its rail read still
        // previews that text. THIS is the independence the whole rule is about.
        expect(plotlinesPhrase(world.store)!.id).toBe(phraseId);
        expect(plotlinesPhrase(world.store)!.seed).toBe('## Premise\nA keeper refuses the relief boat.');

        const plotlines = viewOf(await call(world.app, 'GET', '/stories/story_0/phrases/plotlines'));

        expect(plotlines.seed_head).toBe('## Premise\nA keeper refuses the relief boat.');
        expect(plotlines.seed_chars).toBe('## Premise\nA keeper refuses the relief boat.'.length);

        // THE SUMMARY LEG MOVES TOO, AND ONLY ONCE ITS OWN COPY IS MOVED. Phrase ①'s seed was copied the same
        // way at story creation (`seed_source: story_idea` resolves at CREATE, not at read), so editing
        // `stories.idea` behind it does not move the Summary's preview either — the fallback in
        // `phraseSeedOf` is for a row that predates the field (R6's no-migration reading), not for a row that
        // has one. Both phrases are discrete from the moment each was started; that is the rule, and the row
        // is what proves it.
        expect(viewOf(await call(world.app, 'GET', '/stories/story_0/phrases/summary')).seed_head).toBe(
            'A mapmaker finds her own coastline redrawn on a chart she surveyed herself.'
        );
        expect(world.store.stories.require('story_0').idea).toBe(
            'A different seed entirely: the coastline walks inland.'
        );
    });

    it('refuses a custom start with no usable text — this verb does not author the Seed', async () => {
        const cases: Array<[string, Record<string, unknown>]> = [
            ['an absent text', { source: 'custom' }],
            ['a blank text', { source: 'custom', text: '   ' }]
        ];

        for (const [label, body] of cases) {
            const world = await makeStoryWithSummary();

            const reply = await call(world.app, 'POST', '/stories/story_0/phrases/plotlines/start', body);

            expect([label, reply.status]).toEqual([label, 400]);
            expect(errorOf(reply)).toBe(
                "`source` is 'custom', so `text` must be a non-empty string — it is the seed this Phrase is written from, and this route does not write it for you (D-76)."
            );
            expect(plotlinesPhrase(world.store)).toBeUndefined();
        }
    });

    it('refuses a compiled start when there is no Summary to copy, and names the way to get one', async () => {
        // A book whose five groups exist but hold nothing: the compiled Summary is the empty string, and a
        // phrase over an empty seed would be hashed by every gate as though the Author had written something.
        const world = await makeStory();

        const reply = await call(world.app, 'POST', '/stories/story_0/phrases/plotlines/start', {});

        expect(reply.status).toBe(409);
        expect(errorOf(reply)).toBe(
            'this Story has no compiled Summary to start the plotlines Phrase from; POST /stories/story_0/phrases/import turns the flat Summary into groups, and a written Overview is what gets copied (R5, D-76).'
        );
        expect(plotlinesPhrase(world.store)).toBeUndefined();
        expect(world.store.phraseGroups.list()).toHaveLength(5);
    });

    it('refuses a second start, naming the row whose seed is already load-bearing', async () => {
        const world = await makeStoryWithSummary();

        expect(
            (await call(world.app, 'POST', '/stories/story_0/phrases/plotlines/start', { source: 'compiled' })).status
        ).toBe(200);

        const again = await call(world.app, 'POST', '/stories/story_0/phrases/plotlines/start', {
            source: 'custom',
            text: 'A different seed.'
        });

        expect(again.status).toBe(409);
        expect(errorOf(again)).toBe(
            `the plotlines Phrase is already started on this Story (${plotlinesPhrase(world.store)!.id}); its copied seed is the text every entry, revision and claim key was written against, so a new seed means a new phrase, not a re-start (D-72).`
        );
        // The refusal happened before the write: the seed is still the first one.
        expect(plotlinesPhrase(world.store)!.seed).toBe('## Premise\nA keeper refuses the relief boat and the island decides for her.');
    });

    it('404s a phrase outside the catalog and 409s one the loop starts (R1)', async () => {
        const world = await makeStoryWithSummary();

        const unknown = await call(world.app, 'POST', '/stories/story_0/phrases/continuity/start', {});

        expect(unknown.status).toBe(404);
        expect(errorOf(unknown)).toBe('no phrase named continuity is in the book (P1: the store is the memory)');

        // Phrase ① exists and the loop writes it, so "start it by hand" is the impossible part — 409, not 404.
        const summary = await call(world.app, 'POST', '/stories/story_0/phrases/summary/start', {});

        expect(summary.status).toBe(409);
        expect(errorOf(summary)).toBe(
            'the summary Phrase is not an on-demand start: its entry set comes from the catalog and the loop writes it, so there is no seed for the Author to hand over. POST /stories/story_0/phrases/plotlines/start is the verb that takes one (R1: `starts_on_demand` is catalog data, and this route reads it).'
        );
    });

    it('refuses a Story that is not in the book before any phrase work', async () => {
        const world = makeApp();

        const reply = await call(world.app, 'POST', '/stories/story_9/phrases/plotlines/start', {});

        expect(reply.status).toBe(404);
        expect(errorOf(reply)).toBe('no story named story_9 is in the book (P1: the store is the memory)');
    });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// R8 (D-78, one move later) — THE START VERB'S SECOND MOVE. The decision this pins: "Opening Phrase ②
// should move the crew when Phase ① is already signed off." One press, two writes, and the guard decides
// the second one:
//   - SIGNED OFF (`stories.summary_locked === true`) → the pointer moves to `plotlines`, with the same
//     field set and the same Author attribution the Accept's phase write uses (`engine.ts:3222-3235`), in
//     its OWN commit;
//   - NOT signed off → the crew stays on Phrase ① and the answer names L-33's precondition and the verb
//     that DOES satisfy it (`POST /stories/:id/lock`) — that is the half of the decision that reads
//     "before sign-off, nothing moves", and it is pinned in the Start-verb block above;
//   - already at phase ② or past it → no double advance, and the pointer's owner stays `lockPhase` (L-7).
//
// WHY THE FIXTURE SEEDS THE ROW: the pair `phase: 'summary'` + `summary_locked: true` is NOT reachable
// through the current verbs. Accept moves the pointer itself (`invalidation.ts:644 next_phase: 'plotlines'`)
// and starts Phrase ② in the same act (`routes.ts:1508-1524`, pinned by `lock-accept-routes.test.ts:250`),
// and a backtrack to `summary` CLEARS the flag (`engine.ts:3285` — probe-confirmed: it lands with
// `summary_locked: false`). The pair is the state a RESTORED or hand-edited book is in, which is exactly
// what this rule is for, so the fixture states the row the way `story-delete.test.ts:247-253` does instead
// of pretending a verb produced it. The rule is therefore defensive by construction: on a book the verbs
// did produce, the guard answers "already in phase plotlines" rather than walking the pointer twice.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('a Start that lands on a signed-off Summary moves the crew into Phase ② (R8, D-78)', () => {
    /** The pointer-side fields the move writes — the after-state, stated as ONE exact value. */
    const POINTER_KEYS = ['phase', 'status', 'pending_kind', 'status_reason', 'blocked_on'] as const;

    const pointerOf = (story: Story): Record<string, unknown> =>
        Object.fromEntries(POINTER_KEYS.map((key) => [key, (story as unknown as Record<string, unknown>)[key]]));

    /**
     * Everything on the SUMMARY side of the book, as one snapshot for `toEqual`: the artifact and its lock
     * mirror, Phrase ①'s row, its sections and their history, and the queue. Phrase ②'s own row is excluded
     * because the Start writes it — the point of the snapshot is that NOTHING ELSE moved.
     *
     * The clone is a JSON round-trip because that is this store's own snapshot rule (`store.ts:210-218`:
     * every §4 record is JSON by construction), so the before-snapshot is the same shape the after-read
     * returns and `toEqual` compares rows against rows, not live objects against live objects.
     */
    const cloneRows = <T>(rows: readonly T[]): T[] => JSON.parse(JSON.stringify(rows)) as T[];
    const summaryBook = (store: Store) => {
        const summaryId = store.phrases.list().find((phrase) => phrase.key === 'summary')!.id;
        const story = store.stories.require('story_0');

        return {
            summaries: cloneRows(store.summaries.list()),
            summaryPhrase: cloneRows(store.phrases.list().filter((phrase) => phrase.key === 'summary')),
            sections: cloneRows(store.phraseGroups.list().filter((group) => group.phrase_id === summaryId)),
            history: cloneRows(store.groupRevisions.list()),
            revisions: cloneRows(store.revisions.list()),
            findings: cloneRows(store.findings.list()),
            tasks: cloneRows(store.tasks.list()),
            // R7's lock mirror: an accepted Summary keeps its Phrase-row `locked_at`, and a Start is not an
            // Accept — it may not re-date a sign-off it did not make.
            locks: { summary_locked: story.summary_locked, plotlines_locked: story.plotlines_locked }
        };
    };

    /**
     * A book whose Summary IS signed off and whose Phrase ② is not open: `phase: 'summary'` over
     * signed-off text, the pair written as data (see the block header for why no verb writes it).
     */
    const restoredBook = async () => {
        const world = await makeStoryWithSummary();
        const story = world.store.stories.require('story_0');

        world.store.stories.update(
            story.id,
            { summary_locked: true, status: 'pending', pending_kind: 'phase_signoff' },
            { run_ref: null, author: true, why: 'seed: phase ① is signed off while the pointer is still on it (L-7)' },
            [{ id: story.id, rev: story.rev }]
        );

        return world;
    };

    it('moves the pointer into Phase ② and leaves the signed-off Summary exactly as it was (AC1)', async () => {
        const world = await restoredBook();

        // THE BEFORE-STATE, stated: Phase ①'s pointer over signed-off text, Phrase ② not started.
        expect({ phase: world.store.stories.require('story_0').phase, summary_locked: world.store.stories.require('story_0').summary_locked }).toEqual({
            phase: 'summary',
            summary_locked: true
        });
        expect((viewOf(await call(world.app, 'GET', '/stories/story_0')) as unknown as StorylineStoryView).phrase_started).toEqual({
            summary: true,
            plotlines: false
        });

        const before = summaryBook(world.store);

        const reply = await call(world.app, 'POST', '/stories/story_0/phrases/plotlines/start');

        expect(reply.status).toBe(200);

        const body = viewOf(reply);

        // THE MOVE HAPPENED, and the receipt says so in the same breath as the phrase row. `phase_open_reason`
        // is `''` on the writing arm — the same convention the Accept's `phrase_start_reason` uses, so a rail
        // cannot invent a reason for a decision it has no reason about.
        expect(body.phase_opened).toBe(true);
        expect(body.phase_open_reason).toBe('');

        const story = world.store.stories.require('story_0');

        expect({ phase: story.phase, status: story.status, pending_kind: story.pending_kind, blocked_on: story.blocked_on }).toEqual({
            phase: 'plotlines',
            status: 'ready',
            pending_kind: 'none',
            blocked_on: ''
        });
        // The reason sentence, exact apart from the clock the route stamps: it names BOTH acts, in the order
        // the Author did them, and the rules they answer.
        expect(story.status_reason).toMatch(
            /^phase summary was signed off and the Author started the Plotlines Phrase at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z; phase plotlines is open \(L-7, L-29\)$/
        );
        // L-37: a drain round is per phase, so the move retires it — the same field the lock's phase write
        // clears (`engine.ts:3231`), and the reason the crew cannot carry Phrase ①'s drain into Phase ②.
        expect(story.probe).toBeUndefined();
        // The lock survives the move: signing Phase ① off is not undone by opening Phrase ②.
        expect(story.summary_locked).toBe(true);

        // PHRASE ② IS A ROW, and the rail's second row goes live. The row is the whole fact — the phrase
        // table has no "started" flag beyond the row itself and the seed it was handed (D-72), so `seed` is
        // the started-ness assertion here, and the rail's `phrase_started` is the read the Author sees.
        const phrase = plotlinesPhrase(world.store)!;

        expect(phrase.key).toBe('plotlines');
        expect(phrase.seed).toBe(world.overview);
        expect((viewOf(await call(world.app, 'GET', '/stories/story_0')) as unknown as StorylineStoryView).phrase_started).toEqual({
            summary: true,
            plotlines: true
        });

        // NOTHING ON THE SUMMARY SIDE MOVED — the artifact, its lock mirror, the sections, the history, the
        // queue. This is §18.12's guarantee ("a Start that leaves the Summary alone"), and it holds on the
        // arm where the POINTER moves too: the move is the pointer, never the signed-off text.
        expect(summaryBook(world.store)).toEqual(before);

        // L-6: two writes, TWO journal events, in the order the Author did them — and the Start's own line
        // still names ONLY the Start. This is why the pointer is its own commit and not an extra clause on
        // `phrase_start`: the pinned audit line for the verb cannot absorb a phase act it did not do.
        const labels = world.store.journal.filter(
            (event) => event.commit_label === 'phrase_start' || event.commit_label === 'open_plotlines_phase'
        );

        expect(labels.map((event) => event.commit_label)).toEqual([
            'phrase_start',
            // R12 — the start commit's second line (the provenance), in the SAME group: the label list grows
            // by one start event, not by one commit, and the phase leg is still its own commit after it.
            'phrase_start',
            'open_plotlines_phase'
        ]);
        expect(labels.every((event) => event.attribution.author === true)).toBe(true);
        expect(journalCreateWhy(world.store, 'phrase_start')).toContain(
            "the Plotlines Phrase was started from the Story's compiled Summary (D-72)"
        );
        expect(journalWhy(world.store, 'open_plotlines_phase')).toContain(
            'the Author started the Plotlines Phrase while phase summary was already signed off at'
        );
        expect(journalWhy(world.store, 'open_plotlines_phase')).toContain('phase plotlines opened (L-7, L-29, L-33)');
    });

    it('answers a second press with the phrase that already exists, and the pointer does not move again (AC3)', async () => {
        const world = await restoredBook();

        expect((await call(world.app, 'POST', '/stories/story_0/phrases/plotlines/start')).status).toBe(200);

        const again = await call(world.app, 'POST', '/stories/story_0/phrases/plotlines/start');

        // The start verb's own idempotence comes FIRST (the row exists, so the seed is load-bearing — the
        // 409 every Start test pins), and the pointer leg never runs against a started phrase.
        expect(again.status).toBe(409);
        expect(world.store.stories.require('story_0').phase).toBe('plotlines');
        expect(world.store.journal.filter((event) => event.commit_label === 'open_plotlines_phase')).toHaveLength(1);
    });

    it('does not double-advance a book the Accept already moved into Phase ② (AC3)', async () => {
        const world = await makeStoryWithSummary();
        const story = world.store.stories.require('story_0');

        // The reachable arm of the same guard: pointer already in Phase ②, Phrase ② still unstarted — what
        // an Accept leaves behind when its auto-start leg refuses (nothing compiled, or the classic lane).
        world.store.stories.update(
            story.id,
            { summary_locked: true, phase: 'plotlines' },
            { run_ref: null, author: true, why: 'seed: the Accept moved the pointer (L-7)' },
            [{ id: story.id, rev: story.rev }]
        );

        const reply = await call(world.app, 'POST', '/stories/story_0/phrases/plotlines/start');

        expect(reply.status).toBe(200);

        const body = viewOf(reply);

        expect(body.started).toBe(true);
        expect(body.phase_opened).toBe(false);
        expect(body.phase_open_reason).toBe(
            'the Story is already in phase plotlines, which is where the loop\'s pointer belongs; a Phrase ② start does not move it again (L-7: each phase transition is the Author\'s sign-off)'
        );
        expect(world.store.stories.require('story_0').phase).toBe('plotlines');
        expect(world.store.journal.filter((event) => event.commit_label === 'open_plotlines_phase')).toHaveLength(0);
    });

    it('leaves a Phase ③ book where it is — a phrase verb does not reopen Phase ②', async () => {
        const world = await makeStoryWithSummary();
        const story = world.store.stories.require('story_0');

        world.store.stories.update(
            story.id,
            { summary_locked: true, plotlines_locked: true, phase: 'chapters' },
            { run_ref: null, author: true, why: 'seed: both sign-offs are on and the book is writing chapters (L-7, L-29)' },
            [{ id: story.id, rev: story.rev }]
        );

        const reply = await call(world.app, 'POST', '/stories/story_0/phrases/plotlines/start');

        expect(reply.status).toBe(200);
        expect(viewOf(reply).phase_opened).toBe(false);
        expect(world.store.stories.require('story_0').phase).toBe('chapters');
        // The Start's own write still happened (D-78/L-37): the desk is cleared even where the pointer stays.
        expect(world.store.stories.require('story_0').pending_kind).toBe('none');
    });
});

describe('the Plotlines rail: entries, brief, and a Start that leaves the Summary alone (P3, R11)', () => {
    /** A started Phrase ② whose brief the Author accepted, so the chapter entries exist as real rows. */
    async function makeStartedBook(chapterCount = 2): Promise<TestApp & { story: Story; phrase: Phrase; chapters: string[] }> {
        const world = await makeStoryWithSummary();

        expect(
            (await call(world.app, 'POST', '/stories/story_0/phrases/plotlines/start', { source: 'compiled' })).status
        ).toBe(200);

        const phrase = plotlinesPhrase(world.store)!;

        acceptPlotlineBrief(world.store, world.story, seedBrief(world.store, world.story, phrase, chapterCount), AUTHOR_ATTR);

        return {
            ...world,
            phrase,
            chapters: world.store.phraseGroups
                .list()
                .filter((group) => group.phrase_id === phrase.id)
                .map((group) => group.id)
        };
    }

    it('reads the chapter entries and the accepted brief, and the Summary keeps its own read', async () => {
        const world = await makeStartedBook(3);
        const brief = world.store.plotlineBriefs.list().find((row) => row.phrase_id === world.phrase.id)!;

        expect(brief.status).toBe('accepted');

        const reply = await call(world.app, 'GET', '/stories/story_0/phrases/plotlines');
        const view = viewOf(reply);

        expect(view.phrase_id).toBe(world.phrase.id);
        expect(view.key).toBe('plotlines');
        expect(view.mode).toBe('groups');
        // THE BRIEF BLOCK (§4.11's rail rule): the plan's state, the count it declares, and the moment it
        // became truth — the brief row's own `updated_at`, which is what the accept moved.
        expect(view.brief).toEqual({ status: 'accepted', chapter_count: 3, accepted_at: brief.updated_at });
        // The entries are this phrase's ONLY, in composition order; the Summary's five sections are not here.
        expect((view.groups as Array<Record<string, unknown>>).map((group) => group.key)).toEqual([
            'chapter_1',
            'chapter_2',
            'chapter_3'
        ]);
        expect((view.review as Record<string, unknown>).unwritten_groups).toEqual([
            'chapter_1',
            'chapter_2',
            'chapter_3'
        ]);
        // The phrase's own Overview composes its entries; unwritten ones contribute nothing.
        expect(view.overview).toBe('');

        // The Summary rail is unchanged by all of it: five sections, and its `mode` is still the Summary's word.
        const summary = viewOf(await call(world.app, 'GET', '/stories/story_0/phrases'));

        expect((summary.groups as Array<Record<string, unknown>>).map((group) => group.key)).toEqual([
            'premise',
            'promise',
            'theme',
            'tone',
            'ending'
        ]);
        expect(summary.mode).toBe('groups');
        expect((summary.review as Record<string, unknown>).vector).toEqual(
            Object.fromEntries(
                world.store.phraseGroups
                    .list()
                    .filter((group) => group.phrase_id !== world.phrase.id)
                    .map((group) => [group.id, group.revision])
            )
        );
        // And the Story view's rail rows now read started.
        const story = viewOf(await call(world.app, 'GET', '/stories/story_0'));

        expect(story.phrase_started).toEqual({ summary: true, plotlines: true });
        expect(story.summary_compiled).toBe(true);
    });

    it('shows the LAST structure the Editor wrote, not an older accepted one', async () => {
        const world = await makeStartedBook(2);

        // A second structuring pass over the same seed, left a DRAFT: the rail shows the plan the Editor
        // wrote LAST, because the accept that matters is the one on the newest row.
        const second = seedBrief(world.store, world.story, world.phrase, 4);

        expect(second.status).toBe('draft');

        const view = viewOf(await call(world.app, 'GET', '/stories/story_0/phrases/plotlines'));

        expect(view.brief).toEqual({ status: 'draft', chapter_count: 4 });
        expect(world.store.plotlineBriefs.list()).toHaveLength(2);
        // `accepted_at` is the accepted arm only — a draft has no acceptance to report, and the projection
        // says so by leaving the key off rather than sending null.
        expect(view.brief as object).not.toHaveProperty('accepted_at');
    });
});

describe('the group verbs act on whichever phrase the group belongs to (P3, P4, R6 unchanged)', () => {
    /** A started Phrase ② with chapter entries, and its first chapter written by hand. */
    async function makeChapterBook(): Promise<TestApp & { story: Story; chapterId: string }> {
        const world = await makeStoryWithSummary();

        expect(
            (await call(world.app, 'POST', '/stories/story_0/phrases/plotlines/start', { source: 'compiled' })).status
        ).toBe(200);

        const phrase = plotlinesPhrase(world.store)!;

        acceptPlotlineBrief(world.store, world.story, seedBrief(world.store, world.story, phrase, 2), AUTHOR_ATTR);

        const chapterId = world.store.phraseGroups
            .list()
            .find((group) => group.phrase_id === phrase.id && group.key === 'chapter_1')!.id;

        return { ...world, chapterId };
    }

    it('writes a chapter entry from its plotpoints, mirrors the `plotlines` contract, and answers the Plotlines view', async () => {
        const world = await makeChapterBook();

        const reply = await call(world.app, 'POST', `/stories/story_0/phrases/groups/${world.chapterId}/revise`, {
            plotpoints: {
                must_happen: 'She sails out to mark the shoal herself.',
                must_change: 'The chart she trusts becomes the thing she doubts.',
                pov: 'The cartographer, first person past.'
            },
            note: 'the shoal is the antagonist now'
        });

        expect(reply.status).toBe(200);

        const body = viewOf(reply);
        const chapter = world.store.phraseGroups.require(world.chapterId);
        // A group revision row is counter-minted (`group_revision_N`), so the id is read off the store and
        // named through that read, exactly as `phrase-routes.test.ts` does.
        const installedRow = world.store.groupRevisions
            .list()
            .find((row) => row.group_id === world.chapterId && row.state === 'latest')!;

        // THE ENVELOPE is the same seven keys the Summary leg pins, and the `view` is the PHRASE'S read.
        expect(Object.keys(body)).toEqual(['story_id', 'phrase_id', 'revision', 'installed', 'archived', 'mirror', 'view']);
        expect(body.phrase_id).toBe(plotlinesPhrase(world.store)!.id);
        expect(body.revision).toBe(1);
        expect(body.installed).toEqual([
            { group_id: world.chapterId, group_key: 'chapter_1', revision_id: installedRow.id, number: 1 }
        ]);
        expect(body.archived).toEqual([]);
        // The install has no prose mirror on this leg, and says WHY rather than answering with an empty
        // object a client would have to interpret (`revisions.ts` seam S3).
        expect(body.mirror).toEqual({ summary_id: null, fields: [], written: false, reason: 'not_summary_phrase' });
        expect((body.view as Record<string, unknown>).key).toBe('plotlines');

        // THE ENTRY TEXT is the same derivation the loop's install composes with, so a hand edit and a
        // Writer's answer leave one text: labeled lines, fixed order, blank fields omitted.
        expect(chapter.content).toBe(
            [
                'Must happen: She sails out to mark the shoal herself.',
                'Must change: The chart she trusts becomes the thing she doubts.',
                'POV: The cartographer, first person past.'
            ].join('\n')
        );
        expect(chapter.revision).toBe(1);

        // THE CONTRACT MOVES WITH THE TEXT: the `plotlines` row the loop already reads is created by the same
        // commit, from the same fields (P4 — which is why a chapter revise with no plotpoints is refused).
        const contract = world.store.plotlines.list().find((row) => row.story_id === 'story_0' && row.order === 1);

        expect(contract).toBeDefined();
        expect(contract!.must_happen).toBe('She sails out to mark the shoal herself.');
        expect(contract!.must_change).toBe('The chart she trusts becomes the thing she doubts.');
        expect(contract!.pov).toBe('The cartographer, first person past.');

        // The Summary's Overview is NOT recomposed from the chapter text: the two phrases compose separately.
        expect((body.view as { overview: string }).overview).toBe('## Chapter 1\n' + chapter.content);
        expect(viewOf(await call(world.app, 'GET', '/stories/story_0/phrases')).overview).toBe(
            '## Premise\nA keeper refuses the relief boat and the island decides for her.'
        );
    });

    it('refuses a chapter entry with no contract, and names the fields it needs (P4)', async () => {
        const world = await makeChapterBook();

        const reply = await call(world.app, 'POST', `/stories/story_0/phrases/groups/${world.chapterId}/revise`, {
            content: 'Prose alone does not state a chapter contract.'
        });

        expect(reply.status).toBe(400);
        expect(errorOf(reply)).toBe(
            '`plotpoints` is a chapter entry\'s text: `must_happen` and `must_change` must both be non-empty strings, and the entry\'s text and its `plotlines` contract are composed from them together (P4).'
        );

        const incomplete = await call(world.app, 'POST', `/stories/story_0/phrases/groups/${world.chapterId}/revise`, {
            plotpoints: { must_happen: 'She sails out.', must_change: '   ' }
        });

        expect(incomplete.status).toBe(400);
        expect(errorOf(incomplete)).toBe(errorOf(reply));
        // Nothing moved on either refusal.
        expect(world.store.phraseGroups.require(world.chapterId).content).toBe('');
        expect(world.store.plotlines.list()).toEqual([]);
    });

    it('refuses a chapter verb on a classic book with the sentence that names both moves (P4)', async () => {
        const world = await makeChapterBook();

        // The fixture moves the dial straight on the row: through the routes a STARTED phrase's dial is
        // immovable, and the 409 for that is pinned above. A book whose phrase exists while the lane is
        // classic is therefore a book whose Setting was moved under it, and the verb's answer is the point.
        const story = world.store.stories.require('story_0');

        world.store.stories.update(
            story.id,
            { plotlines_mode: 'classic' },
            { run_ref: null, author: true, why: 'seed: a chapter entry under the classic lane (T-W3 fixture)' },
            [{ id: story.id, rev: story.rev }]
        );

        const locked = await call(world.app, 'POST', `/stories/story_0/phrases/groups/${world.chapterId}/lock`, {});

        expect(locked.status).toBe(409);
        expect(errorOf(locked)).toBe(
            "this Story's chapter entries are not its writable surface (`plotlines_mode` is not 'groups', so contracts are still written by the classic plotline tools); set `plotlines_mode` to 'groups' with PATCH /stories/story_0 and start the phrase with POST /stories/story_0/phrases/plotlines/start (P4)."
        );

        const revised = await call(world.app, 'POST', `/stories/story_0/phrases/groups/${world.chapterId}/revise`, {
            plotpoints: { must_happen: 'She sails out.', must_change: 'She doubts the chart.' }
        });

        expect(revised.status).toBe(409);
        expect(errorOf(revised)).toBe(errorOf(locked));

        const opened = await call(world.app, 'POST', `/stories/story_0/phrases/groups/${world.chapterId}/unlock`, {});

        expect(opened.status).toBe(409);
        expect(errorOf(opened)).toBe(errorOf(locked));
        expect(world.store.phraseGroups.require(world.chapterId).locked).toBeUndefined();
    });

    it('still answers a Summary group with the Summary\'s own sentence, tokens and view (R6, pinned)', async () => {
        // The legacy half of the same gate: a `sampling` book has no rows, so an unknown group id lands on the
        // Summary dial and hears the import sentence — byte for byte what it heard before Phrase ② existed.
        const world = await makeStory({
            title: 'The Old Sampling Book',
            idea: 'A keeper and a lighthouse, written the way it always was.',
            chapter_count: 1,
            summary_mode: 'sampling'
        });
        const premise = world.store.phraseGroups.list().find((group) => group.key === 'premise');

        expect(premise).toBeUndefined();

        for (const verb of ['revise', 'lock', 'unlock'] as const) {
            const reply = await call(world.app, 'POST', `/stories/story_0/phrases/groups/group_9/${verb}`, {
                content: 'text'
            });

            expect(reply.status).toBe(409);
            expect(errorOf(reply)).toBe(
                verb === 'revise'
                    ? 'this Story\'s Summary is still written as one text (no group catalog); POST /stories/story_0/phrases/import turns the flat Summary into groups first (R6).'
                    : 'this Story\'s Summary is still written as one text (no group catalog); POST /stories/story_0/phrases/import turns the flat Summary into groups first (R1, R6).'
            );
        }
    });

    it('answers a Summary revise with the pinned `GET …/phrases` shape, not the wider one', async () => {
        const world = await makeStory();
        const premiseId = world.store.phraseGroups.list().find((group) => group.key === 'premise')!.id;

        const reply = await call(world.app, 'POST', `/stories/story_0/phrases/groups/${premiseId}/revise`, {
            content: 'A keeper, a relief boat, and a chart nobody believes.'
        });

        expect(reply.status).toBe(200);

        const body = reply.body as { view: Record<string, unknown> };

        expect(body.view).toEqual(viewOf(await call(world.app, 'GET', '/stories/story_0/phrases')));
        expect(body.view).not.toHaveProperty('key');
        expect(body.view).not.toHaveProperty('brief');
        expect((body.view.review as Record<string, unknown>).mirror).toBeDefined();
    });
});
