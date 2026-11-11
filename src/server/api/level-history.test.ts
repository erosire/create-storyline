/**
 * U-1a — the stalled screen's "what the crews tried across rounds" has to reach the client.
 *
 * The history is loop bookkeeping (`level_history` on the Story row, written by `recordRound` in
 * ../loop/trend.ts), NOT a §4.1 field, so before this fix the Story view's payload simply did not
 * carry it: the pane could not render the rounds no matter what it did. Pinned through the real route
 * so the contract is the shipped JSON, exact, oldest first.
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
import type { LevelHistoryEntry } from '../loop/types';
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

/** Two rounds, identical numbers: the flat pair L-21 counts, in the order `recordRound` appends them. */
const ROUNDS: LevelHistoryEntry[] = [
    {
        round: 4,
        at: '2026-11-11T09:00:00.000Z',
        phase: 'chapters',
        levels: { summary: '4/4', plotlines: '6/6', chapters: '4/6', whole: '2/5' },
        fingerprint_closed: ['fp-c8-voice'],
        fingerprint_reopened: [],
        findings_confirmed_new: ['fp-c11-promise'],
        flat_streak: 1,
        trend: 'flat',
        runs_closed: 9
    },
    {
        round: 5,
        at: '2026-11-11T09:30:00.000Z',
        phase: 'chapters',
        levels: { summary: '4/4', plotlines: '6/6', chapters: '4/6', whole: '2/5' },
        fingerprint_closed: [],
        fingerprint_reopened: ['fp-c8-voice'],
        findings_confirmed_new: [],
        flat_streak: 2,
        trend: 'flat',
        runs_closed: 11
    }
];

describe('U-1a — the Story view carries the round history the stalled screen reads', () => {
    it('projects `level_history` verbatim, oldest first, on the Story payload the dashboard fetches', async () => {
        const world = makeApp();
        const created = await call(world.app, 'POST', '/stories', {
            title: 'The Return',
            idea: 'A cartographer finds the valley she mapped is under water.',
            chapter_count: 2
        });

        const storyId = (created.body as StoryRow).id;
        const row = world.store.stories.require(storyId);

        world.store.stories.update(
            storyId,
            // The loop writes this field the same way (trend.ts's `recordRound`); the projection must
            // not rename, re-sort, or summarise it.
            { level_history: ROUNDS, flat_streak: 2 },
            { run_ref: null, why: 'seed: two flat rounds (L-15, L-21)' },
            [{ id: storyId, rev: row.rev }]
        );

        const view = (await call(world.app, 'GET', `/stories/${storyId}`)).body as { level_history: unknown };

        expect(view.level_history).toEqual(ROUNDS);
    });

    it('a Story that has never finished a round gets an empty list, not an absent field', async () => {
        const world = makeApp();
        const created = await call(world.app, 'POST', '/stories', {
            title: 'First Light',
            idea: 'A keeper inherits a lamp that has never been lit.',
            chapter_count: 1
        });

        const view = (await call(world.app, 'GET', `/stories/${(created.body as StoryRow).id}`)).body as {
            level_history: unknown;
        };

        expect(view.level_history).toEqual([]);
    });
});
