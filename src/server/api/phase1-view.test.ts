/**
 * §10 — the research pipeline's two Story-view slices: the accepted Seed Brief and the sampling
 * state (documents/phase-1-research-pipeline.md §3.3/§3.6, §6.5-§6.6).
 *
 * WHY A ROUTE-LEVEL TEST: `projections.ts` reads loop bookkeeping (`seed_briefs`,
 * `stories.sampling_history`, `stories.sampling_round`), and the contract that matters is the JSON
 * the dashboard's `getStory` receives. The projections are additive — a Story with no brief and no
 * rounds still answers both keys — so the empty case is pinned beside the populated ones.
 */
import { describe, expect, it } from 'vitest';
import { CriteriaEngine } from '../criteria/engine';
import { DigestBuilder } from '../digest/digest';
import { MockChatClient, msg } from '../llm/mock';
import { LoopEngine } from '../loop/engine';
import { RunExecutor } from '../run/executor';
import { MockToolRuntime } from '../run/mock';
import { Store } from '../store/store';
import { buildStorylineRuntime } from './server';
import type { Hono } from 'hono';
import type { StoryRow } from '../../dashboard/api';

interface TestApp {
    app: Hono;
    store: Store;
}

function makeApp(): TestApp {
    const store = Store.empty();
    const criteria = new CriteriaEngine();
    const digest = new DigestBuilder();
    const chat = new MockChatClient(() => ({ message: msg({ content: 'nothing to report' }) }));
    const runtime = new MockToolRuntime(store, '', {});
    const executor = new RunExecutor({ store, runtime, chat, defaultModel: 'mock-gpt' });
    const engine = new LoopEngine({ store, executor, criteria, digest, config: { autoSweep: false } });
    const built = buildStorylineRuntime({
        store,
        chat,
        runtime,
        executor,
        engine,
        engineConfig: { autoSweep: false },
        // No assistant-seed run on boot: the book under test is exactly what the fixture writes.
        noAssistantSeed: true,
        streamDebounceMs: 5
    });

    return { app: built.app, store };
}

async function call(app: Hono, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ body: unknown }> {
    const response = await app.request(`http://localhost/v1/storyline${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    });

    return { body: await response.json() };
}

/** A Story through the real route, so the view is read exactly as the dashboard reads it. */
async function createStory(app: Hono): Promise<string> {
    const created = await call(app, 'POST', '/stories', {
        title: 'The Long Sounding',
        idea: 'A cartographer maps a sea that remembers the fleet it swallowed.',
        chapter_count: 2
    });

    return (created.body as StoryRow).id;
}

const attribution = { author: true, why: 'fixture: the loop writes these rows (§3.3, §3.6)' };

/** The seven rounds the projection must cap at five. Rounds are appended oldest first by the engine. */
const HISTORY = Array.from({ length: 7 }, (_, index) => {
    const round = index + 1;

    return {
        round,
        at: `2026-11-2${round}T09:00:00.000Z`,
        samples: [
            { revision_id: `revision_${round}a`, critical: round, high: 0, valid: true },
            { revision_id: `revision_${round}b`, critical: 0, high: round, valid: round % 2 === 0 }
        ],
        selected: `revision_${round}a`
    };
});

describe('§10 / §3.3 — the Story view carries the accepted Seed Brief', () => {
    it('answers null before phase ① has accepted a brief', async () => {
        const world = makeApp();
        const storyId = await createStory(world.app);

        const view = (await call(world.app, 'GET', `/stories/${storyId}`)).body as { seed_brief: unknown };

        expect(view.seed_brief).toBeNull();
    });

    it('projects the ACCEPTED brief trimmed to the reading surface, ignoring a newer draft row', async () => {
        const world = makeApp();
        const storyId = await createStory(world.app);

        // An accepted brief for the current Seed…
        world.store.seedBriefs.create(
            {
                story_id: storyId,
                seed_hash: 'seed-hash-current',
                logline: 'A cartographer maps a sea that remembers her fleet.',
                protagonist: 'Ilsa Vane',
                want: 'a chart that is true',
                need: 'to be forgiven by the sea',
                obstacle: 'the sea recolours every line she draws',
                stakes: 'her name is the next one the sea repeats',
                setting: 'a harbour town built on a drowned chart',
                world_rules: ['the sea keeps names it has taken', 'a chart drawn in salt is true'],
                promise: 'every sounding answers in a voice she knows',
                tone_hints: 'tidal, close third person',
                constraints: ['no rescue by the navy'],
                open_questions: ['does the lamp know her?'],
                status: 'accepted'
            },
            attribution
        );
        const accepted = world.store.seedBriefs.list()[0];

        // …and a NEWER draft (a Seed edit re-armed the structuring). The accepted row is the brief a
        // Writer is told (run/phase1-prompt.ts:acceptedSeedBrief), so the draft must not win here.
        world.store.seedBriefs.create(
            {
                story_id: storyId,
                seed_hash: 'seed-hash-edited',
                logline: 'A draft brief the Editor has not accepted.',
                protagonist: 'Draft Vane',
                want: 'draft want',
                obstacle: 'draft obstacle',
                stakes: 'draft stakes',
                setting: 'draft setting',
                world_rules: [],
                promise: 'draft promise',
                constraints: [],
                open_questions: [],
                status: 'draft'
            },
            attribution
        );

        const view = (await call(world.app, 'GET', `/stories/${storyId}`)).body as { seed_brief: unknown };

        // TRIMMED means exactly these ten fields: the arrays and tone hints belong to the prompt
        // compiler, not the pane, and the raw Seed stays `stories.idea` (P5).
        expect(view.seed_brief).toEqual({
            id: accepted.id,
            seed_hash: 'seed-hash-current',
            logline: 'A cartographer maps a sea that remembers her fleet.',
            protagonist: 'Ilsa Vane',
            want: 'a chart that is true',
            obstacle: 'the sea recolours every line she draws',
            stakes: 'her name is the next one the sea repeats',
            setting: 'a harbour town built on a drowned chart',
            promise: 'every sounding answers in a voice she knows',
            status: 'accepted'
        });
    });
});

describe('§10 / §6.5-§6.6 — the Story view carries the sampling state', () => {
    it('answers round 1 and no history before the first selection', async () => {
        const world = makeApp();
        const storyId = await createStory(world.app);

        const view = (await call(world.app, 'GET', `/stories/${storyId}`)).body as { sampling: unknown };

        // `round` is the last COMPLETED round and `active_round` is the round in flight; before the first
        // selection they are the SAME number (T12/P1), which is exactly why the client may not derive one
        // from the other.
        expect(view.sampling).toEqual({ round: 1, active_round: 1, history: [] });
    });

    it('reports the reset counter as 0 while the in-flight round is 1 again (T12/P1)', async () => {
        const world = makeApp();
        const storyId = await createStory(world.app);
        const row = world.store.stories.require(storyId);

        // A backtrack reset `sampling_round` to 0 (engine.ts's `scrapPhasesAfter`) rather than deleting it.
        // The view reports the stored 0 — the round whose SELECTION the Story carries, which is none — while
        // supersession still measures against round 1, the round the reopened phase is sampling.
        world.store.stories.update(
            storyId,
            { sampling_round: 0 },
            { run_ref: null, why: 'seed: the Author reopened phase ① (§16.7)' },
            [{ id: storyId, rev: row.rev }]
        );

        const view = (await call(world.app, 'GET', `/stories/${storyId}`)).body as { sampling: unknown };

        expect(view.sampling).toEqual({ round: 0, active_round: 1, history: [] });
    });

    it('caps the history at the last five rounds, newest first, and names the last selection', async () => {
        const world = makeApp();
        const storyId = await createStory(world.app);
        const row = world.store.stories.require(storyId);

        world.store.stories.update(
            storyId,
            { sampling_history: HISTORY, sampling_round: 7 },
            { run_ref: null, why: 'seed: seven completed sampling rounds (§6.6)' },
            [{ id: storyId, rev: row.rev }]
        );

        const view = (await call(world.app, 'GET', `/stories/${storyId}`)).body as { sampling: unknown };

        expect(view.sampling).toEqual({
            // The loop's `sampling_round` is the last COMPLETED round (§6.6); the in-flight one is 8, and
            // the projection sends BOTH because supersession and the deep review ask different questions
            // (T12/P1).
            round: 7,
            active_round: 8,
            // The winner of round 7 with the counts that won it — read off the history line, because
            // the selection commit hard-deletes the losers (P13/D-22).
            selected: { revision_id: 'revision_7a', critical: 7, high: 0 },
            // Rounds 3-7 only, newest first: the earlier rounds stay in the book, not on the pane.
            history: [7, 6, 5, 4, 3].map((round) => {
                const entry = HISTORY[round - 1];

                return {
                    round: entry.round,
                    at: entry.at,
                    samples: entry.samples.map((sample) => ({
                        revision_id: sample.revision_id,
                        critical: sample.critical,
                        high: sample.high,
                        valid: sample.valid
                    })),
                    selected: entry.selected
                };
            })
        });
    });

    it('omits `selected` when the newest round names a sample it does not carry', async () => {
        const world = makeApp();
        const storyId = await createStory(world.app);
        const row = world.store.stories.require(storyId);

        world.store.stories.update(
            storyId,
            {
                sampling_round: 2,
                sampling_history: [
                    { round: 1, at: '2026-11-21T09:00:00.000Z', samples: HISTORY[0].samples, selected: 'revision_1a' },
                    // A malformed row: `selected` is not among its own samples. The projection states
                    // the absence rather than inventing counts for an id it cannot match.
                    { round: 2, at: '2026-11-22T09:00:00.000Z', samples: HISTORY[1].samples, selected: 'revision_gone' }
                ]
            },
            { run_ref: null, why: 'seed: a snapshot the selector could not have written' },
            [{ id: storyId, rev: row.rev }]
        );

        const view = (await call(world.app, 'GET', `/stories/${storyId}`)).body as { sampling: unknown };

        expect(view.sampling).toEqual({
            round: 2,
            active_round: 3,
            history: [
                {
                    round: 2,
                    at: '2026-11-22T09:00:00.000Z',
                    samples: HISTORY[1].samples,
                    selected: 'revision_gone'
                },
                {
                    round: 1,
                    at: '2026-11-21T09:00:00.000Z',
                    samples: HISTORY[0].samples,
                    selected: 'revision_1a'
                }
            ]
        });
    });
});
