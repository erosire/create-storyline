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

    return { app: built.app, store };
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

        // The start is the ROW (there is no counter for it), and it is journaled in the same commit.
        expect(phrase.key).toBe('plotlines');
        expect(phrase.revision).toBe(0);
        expect(phrase.group_refs).toEqual([]);
        expect(world.store.journal.filter((event) => event.commit_label === 'phrase_start')).toHaveLength(1);
        expect(journalWhy(world.store, 'phrase_start')).toContain(
            "the Plotlines Phrase was started from the Story's compiled Summary (D-72)"
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
