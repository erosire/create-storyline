// §10 / W9-W13 — the `/v1/storyline` route table, end to end (T7).
//
// WHAT IS REAL HERE: the shipped `Store`, `CriteriaEngine`, `DigestBuilder`, `RunExecutor`, `LoopEngine`
// and the route layer itself, driven through `app.request(...)` — a real Hono request through a real
// router into the real engine against the real rows. The doubles are exactly the two the loop's own rig
// doubles (`loop/mock.ts`'s header says why): the MODEL (`MockChatClient`) and the §8 tool catalogue
// (`MockToolRuntime`). Nothing about a projection, a lock, a decision, or an undo is faked.
//
// WHY EXACT VALUES: the 409s ARE the product copy (L-13), so a test that matched a substring would let a
// reworded refusal ship. Every refusal below is asserted verbatim, and every projection is asserted as a
// whole object.
import { describe, expect, it } from 'vitest';
import { CriteriaEngine } from '../criteria/engine';
import { DigestBuilder } from '../digest/digest';
import { MockChatClient, msg } from '../llm/mock';
import { LoopEngine } from '../loop/engine';
import { createRig } from '../loop/mock';
import { RunExecutor } from '../run/executor';
import { MockToolRuntime, seedChapter, seedFinding, seedIdea, seedRevision, seedTask } from '../run/mock';
import { Store } from '../store/store';
import { DEFAULT_ASSIGNMENT } from '../templates/templates';
import { buildStorylineRuntime } from './server';
import { feedEvents } from './projections';
import type { Hono } from 'hono';
import type { CommitEvent } from '../store';
import type { ChatClient, ChatResponse } from '../llm';
import type { LoopEngineConfig } from '../loop/types';

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

interface TestApp {
    app: Hono;
    store: Store;
    engine: LoopEngine;
    executor: RunExecutor;
}

/** The chat double's default: answer prose, call nothing, so a sweep that runs is a sweep that ends. */
const quietChat = (): MockChatClient => new MockChatClient(() => ({ message: msg({ content: 'nothing to report' }) }));

/**
 * Builds the server exactly the way `bootStorylineServer` does, with the two doubles injected and the
 * sweep timer off (L-1: a test is the clock). `streamDebounceMs: 5` keeps the SSE test honest without a
 * 100ms wait.
 */
function makeApp(chat: ChatClient = quietChat()): TestApp {
    const store = Store.empty();
    const criteria = new CriteriaEngine();
    const digest = new DigestBuilder();
    const runtime = new MockToolRuntime(store, '', {});
    const executor = new RunExecutor({ store, runtime, chat, defaultModel: 'mock-gpt' });
    const engineConfig: LoopEngineConfig = { autoSweep: false };
    const engine = new LoopEngine({ store, executor, criteria, digest, config: engineConfig });
    const built = buildStorylineRuntime({ store, chat, runtime, executor, engine, engineConfig, streamDebounceMs: 5 });

    return { app: built.app, store, engine, executor };
}

interface Reply {
    status: number;
    body: unknown;
}

/** One JSON round trip against the mounted root — the same fetch the dashboard client does. */
async function call(app: Hono, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<Reply> {
    const response = await app.request(`http://localhost/v1/storyline${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    });

    const text = await response.text();

    return { status: response.status, body: text.length === 0 ? undefined : JSON.parse(text) };
}

/** The `{error}` body, which the client re-throws verbatim (L-13). */
const errorOf = (reply: Reply): string => (reply.body as { error: string }).error;

/**
 * Waits for a run row to close. Only needed for the two tests that let a run finish on its own terms
 * (S-3's teardown is asynchronous by nature); the value it returns is then asserted exactly, and the cap
 * turns a stuck run into a test failure rather than a vitest timeout.
 */
async function waitFor<T>(read: () => T | undefined, limitMs = 2_000): Promise<T> {
    for (let elapsed = 0; elapsed <= limitMs; elapsed += 5) {
        const value = read();

        if (value !== undefined) return value;

        await new Promise((resolve) => setTimeout(resolve, 5));
    }

    throw new Error('the run never closed its row (S-3: teardown is unconditional)');
}

// ---------------------------------------------------------------------------
// The Stories panel (U-1) and the Story view (U-4…U-17)
// ---------------------------------------------------------------------------

describe('§10.2 U-1 — the Stories panel', () => {
    it('lists no stories before the first Seed', async () => {
        const { app } = makeApp();

        expect(await call(app, 'GET', '/stories')).toEqual({ status: 200, body: [] });
    });

    it('creates a Story and answers with the rendered row, not the record', async () => {
        const { app } = makeApp();

        const created = await call(app, 'POST', '/stories', {
            title: 'The Salt Cartographer',
            idea: 'A mapmaker finds her own coastline redrawn on a chart she surveyed herself.',
            chapter_count: 2
        });

        // A fresh Story is in phase ① with phase ②'s level not reached yet (L-14: `n/a`, never `0/n`), and
        // phase ①'s level fails the one criterion nothing has satisfied yet: the Seed is unwritten prose.
        expect(created.body).toEqual({
            id: 'story_1',
            title: 'The Salt Cartographer',
            phase: 'summary',
            status: 'ready',
            pending_kind: 'none',
            status_reason: 'phase summary is open: the Seed is being expanded (L-29 stops it at the lock)',
            summary_locked: false,
            plotlines_locked: false,
            levels: { summary: '1/2 · failing: C-14', plotlines: 'n/a', chapters: 'n/a', whole: 'n/a' },
            trend: 'unknown',
            auto_approve: ['critical', 'major'],
            active_runs: 0,
            completion_proposed: false
        });
    });

    it('refuses a body with no Seed, in the sentence the Author reads', async () => {
        const { app } = makeApp();

        const reply = await call(app, 'POST', '/stories', { title: 'No idea', chapter_count: 1 });

        expect(reply.status).toBe(400);
        expect(errorOf(reply)).toBe(
            'a Story needs a Seed: `idea` must be a non-empty string (P5: it is what the book is measured against).'
        );
    });

    it('answers 404 for a story the book has never heard of', async () => {
        const { app } = makeApp();

        const reply = await call(app, 'GET', '/stories/story_missing');

        expect(reply.status).toBe(404);
        expect(errorOf(reply)).toBe('no story named story_missing is in the book (P1: the store is the memory)');
    });

    /**
     * `PATCH /stories/:id` is the one route with four different meanings, so it gets four assertions: the
     * title and the D-35 dial are row edits, the Seed is D-25a's backtrack (it goes through the engine's
     * `editSeed`, which re-derives the Goal), and the chapter count is D-3c's growth-or-shrink decision.
     */
    it('applies the four row edits the Story cards make, each through its own verb (U-10a, D-35, D-25a, D-3c)', async () => {
        const { app, store } = makeApp();

        await call(app, 'POST', '/stories', {
            title: 'One Book',
            idea: 'A keeper and a lighthouse.',
            chapter_count: 1
        });

        const dialed = await call(app, 'PATCH', '/stories/story_1', {
            title: 'The Keeper',
            auto_approve: ['critical']
        });

        expect(dialed.status).toBe(200);
        expect((dialed.body as { title: string; auto_approve: string[] }).title).toBe('The Keeper');
        expect((dialed.body as { auto_approve: string[] }).auto_approve).toEqual(['critical']);

        // The dial is a Story-level setting, so the view the cost panel reads carries it (D-35).
        const view = (await call(app, 'GET', '/stories/story_1')).body as {
            story: { title: string; auto_approve: string[] };
        };

        expect(view.story.title).toBe('The Keeper');
        expect(view.story.auto_approve).toEqual(['critical']);

        // D-3c: growing creates `outlined` chapters and shrinking drops the extras. The confirm is the
        // DASHBOARD's gate (it asks before sending), so the route always grants it — `loop/engine.test.ts`
        // pins the unconfirmed refusal, and this pins what the shipped contract actually does.
        const grown = await call(app, 'PATCH', '/stories/story_1', { chapter_count: 3 });

        expect(grown.status).toBe(200);
        expect(
            ((await call(app, 'GET', '/stories/story_1')).body as { chapters: Array<{ id: string }> }).chapters.map(
                (row) => row.id
            )
        ).toEqual(['chapter_1', 'chapter_2', 'chapter_3']);

        const shrunk = await call(app, 'PATCH', '/stories/story_1', { chapter_count: 1 });

        expect(shrunk.status).toBe(200);
        expect(
            ((await call(app, 'GET', '/stories/story_1')).body as { chapters: Array<{ id: string }> }).chapters.map(
                (row) => row.id
            )
        ).toEqual(['chapter_1']);

        // D-25a last, because it is the destructive one: the Seed is what the Goal is measured against, so
        // editing it is a full backtrack — phase ① re-opens and the derived artifacts are scrapped rather
        // than a column being patched.
        const seeded = await call(app, 'PATCH', '/stories/story_1', { idea: 'A keeper who has never left the rock.' });

        expect(seeded.status).toBe(200);
        expect((seeded.body as { phase: string; summary_locked: boolean; levels: { plotlines: string } }).phase).toBe(
            'summary'
        );
        expect((seeded.body as { levels: { plotlines: string } }).levels.plotlines).toBe('n/a');
        expect(store.stories.require('story_1').idea).toBe('A keeper who has never left the rock.');
        expect(
            ((await call(app, 'GET', '/stories/story_1')).body as { chapters: Array<{ id: string }> }).chapters
        ).toEqual([]);
    });

    it('refuses a Story patch that carries nothing it knows, or a field it cannot take', async () => {
        const { app } = makeApp();

        await call(app, 'POST', '/stories', {
            title: 'Refusals',
            idea: 'A keeper and a lighthouse.',
            chapter_count: 1
        });

        const nothing = await call(app, 'PATCH', '/stories/story_1', {});

        expect(nothing.status).toBe(400);
        expect(errorOf(nothing)).toBe(
            'PATCH /stories/:id got no field it knows: title, idea, chapter_count, auto_approve (D-35).'
        );

        expect([
            (await call(app, 'PATCH', '/stories/story_1', { title: '   ' })).status,
            (await call(app, 'PATCH', '/stories/story_1', { idea: '' })).status,
            (await call(app, 'PATCH', '/stories/story_1', { chapter_count: 0 })).status,
            (await call(app, 'PATCH', '/stories/story_1', { chapter_count: 1.5 })).status,
            (await call(app, 'PATCH', '/stories/story_1', { auto_approve: ['enjoyable'] })).status
        ]).toEqual([400, 400, 400, 400, 400]);

        const missing = await call(app, 'PATCH', '/stories/story_missing', { title: 'Nowhere' });

        expect(missing.status).toBe(404);
        expect(errorOf(missing)).toBe('no story named story_missing is in the book (P1: the store is the memory)');
    });

    it('reads the whole Story region in one document (W9)', async () => {
        const { app, store } = makeApp();

        await call(app, 'POST', '/stories', {
            title: 'One Book',
            idea: 'A keeper and a lighthouse.',
            chapter_count: 1
        });
        seedChapter(store, 'story_1', { order: 1 });

        const reply = await call(app, 'GET', '/stories/story_1');

        expect(reply.status).toBe(200);

        const view = reply.body as Record<string, unknown>;

        expect(Object.keys(view)).toEqual([
            'story',
            'summary',
            'plotlines',
            'chapters',
            'goal',
            'ideas',
            'revisions',
            // U-13 (D-21): the §4.9 rows ride with the view so the side-by-side panes can show each
            // draft's own judgement instead of a bare ref list.
            'verdicts',
            'findings',
            'proposals',
            'runs',
            'templates',
            'cost_distribution',
            'completion_preview',
            'digest',
            // U-1a: the stalled screen's "what the crews tried across rounds". Additive, and it rides
            // last so the pinned order above stays the order the projection builds.
            'level_history'
        ]);
        expect(Object.keys(view.summary as object).sort()).toEqual([
            'chapter_count',
            'created_at',
            'id',
            'locked',
            'rev',
            'story_id',
            'updated_at'
        ]);
        expect(view.plotlines).toEqual([]);
        expect((view.chapters as unknown[]).length).toBe(1);
        expect(view.ideas).toEqual([]);
        expect(view.revisions).toEqual([]);
        expect(view.verdicts).toEqual([]);
        expect(view.findings).toEqual([]);
        expect(view.proposals).toEqual([]);
        expect(view.runs).toEqual([]);
        expect(view.templates).toEqual(DEFAULT_ASSIGNMENT);
        expect(view.completion_preview).toBeNull();
        expect(view.cost_distribution).toEqual({
            confirmed_per_cost: { critical: 0, major: 0, minor: 0, taste: 0 },
            downgrades: 0
        });

        const goal = view.goal as {
            phase_progress: string;
            failing: unknown[];
            chapter_progress: Record<string, string>;
        };

        expect(goal.phase_progress).toBe('1/2 · failing: C-14');
        expect(goal.failing).toEqual([
            { criterion: 'C-14', fix_hint: expect.any(String), evidence: expect.any(String) }
        ]);
        // G-1: the per-chapter bar is the chapter level's own arithmetic — an unevaluated chapter is 0
        // against the four criteria that judge one, not an empty string.
        expect(goal.chapter_progress).toEqual({ chapter_1: '0/4 · failing: C-7, C-8, C-9, C-12' });
    });
});

// ---------------------------------------------------------------------------
// U-16 — lock and backtrack
// ---------------------------------------------------------------------------

describe('§10.2 U-16 — lock and backtrack', () => {
    /** A Story whose phase ① Goal has been emptied by the Author, so a lock is allowed by both gates. */
    const storyWithPassingGoal = async (app: Hono): Promise<void> => {
        await call(app, 'POST', '/stories', {
            title: 'Lockable',
            idea: 'A chart that redraws itself.',
            chapter_count: 1
        });
        await call(app, 'PATCH', '/stories/story_1/goal', {
            criteria: [
                { op: 'remove', id: 'C-14' },
                { op: 'remove', id: 'C-15' }
            ]
        });
    };

    it('refuses the lock whose Goal is not met, naming the failing criteria (U-16)', async () => {
        const { app } = makeApp();

        await call(app, 'POST', '/stories', {
            title: 'Not Yet',
            idea: 'A keeper who keeps nothing.',
            chapter_count: 1
        });

        const reply = await call(app, 'POST', '/stories/story_1/lock');

        expect(reply.status).toBe(409);
        expect(errorOf(reply)).toBe(
            'cannot lock phase summary: its Goal is not met — 1/2 · failing: C-14 (U-16: lock only a phase whose Goal passes)'
        );
    });

    it('lets the ENGINE answer a full Ideas tray, so L-7a keeps its own sentence', async () => {
        const { app, store } = makeApp();

        await storyWithPassingGoal(app);
        seedIdea(store, 'story_1', { phase: 'summary', state: 'proposed', fingerprint: 'bell-under-water' });

        const reply = await call(app, 'POST', '/stories/story_1/lock');

        expect(reply.status).toBe(409);
        expect(errorOf(reply)).toBe(
            'cannot lock summary: 1 Idea still in the tray — each must be selected, discarded, or deferred first (L-7a, D-29)'
        );
    });

    it('locks the current phase and opens the next one', async () => {
        const { app } = makeApp();

        await storyWithPassingGoal(app);

        const reply = await call(app, 'POST', '/stories/story_1/lock');

        expect(reply.status).toBe(200);
        expect((reply.body as { phase: string; summary_locked: boolean }).phase).toBe('plotlines');
        expect((reply.body as { summary_locked: boolean }).summary_locked).toBe(true);
    });

    it('advances the phase after a real crew pass, through the same route', async () => {
        // The loop's own rig: a scripted crew reports against the brief, so phase ①'s Goal passes on the
        // criteria engine's own arithmetic rather than on a test fixture (see `loop/mock.ts`).
        const rig = await createRig({
            story: { title: 'The Salt Cartographer', idea: 'A chart redrawn.', chapter_count: 1 }
        });

        await rig.run();

        const built = buildStorylineRuntime({
            store: rig.store,
            engine: rig.engine,
            executor: rig.executor,
            engineConfig: { autoSweep: false }
        });
        const before = rig.story();

        expect(before.phase).toBe('summary');

        const reply = await call(built.app, 'POST', `/stories/${before.id}/lock`);

        expect(reply.status).toBe(200);
        expect((reply.body as { phase: string }).phase).toBe('plotlines');
    });

    it('backtracks to phase ① and opens the lock again (L-31)', async () => {
        const { app, store } = makeApp();

        await storyWithPassingGoal(app);
        await call(app, 'POST', '/stories/story_1/lock');

        const reply = await call(app, 'POST', '/stories/story_1/backtrack', { phase: 'summary' });

        expect(reply.status).toBe(200);
        expect((reply.body as { summary_locked: boolean; phase: string }).summary_locked).toBe(false);
        expect(store.stories.require('story_1').summary_locked).toBe(false);
    });

    it('refuses a backtrack target that is not a phase the Story left', async () => {
        const { app } = makeApp();

        await call(app, 'POST', '/stories', { title: 'Wrong Target', idea: 'A lighthouse.', chapter_count: 1 });

        const reply = await call(app, 'POST', '/stories/story_1/backtrack', { phase: 'chapters' });

        expect(reply.status).toBe(400);
        expect(errorOf(reply)).toBe(
            '`phase` must be "summary" or "plotlines" — phase ③ is where the Story already is (L-32).'
        );
    });
});

// ---------------------------------------------------------------------------
// Stop / resume / clear-pending (U-3, U-17)
// ---------------------------------------------------------------------------

describe('§10.2 U-3 — stop, resume, clear-pending', () => {
    it('stops the Story for the prose edit and hands it back (D-37, D-37b)', async () => {
        const { app, store } = makeApp();

        await call(app, 'POST', '/stories', {
            title: 'Paused',
            idea: 'A survey that mislays its own scale.',
            chapter_count: 1
        });

        const stopped = await call(app, 'POST', '/stories/story_1/stop');

        expect(stopped.status).toBe(200);
        expect((stopped.body as { status: string }).status).toBe('stopped');
        expect(store.stories.require('story_1').author_stop).toBe(true);

        const resumed = await call(app, 'POST', '/stories/story_1/resume');

        expect(resumed.status).toBe(200);
        expect((resumed.body as { status: string }).status).toBe('ready');
    });

    it('clears the pending tasks the Author would otherwise wait on (L-36)', async () => {
        const { app, store } = makeApp();

        await call(app, 'POST', '/stories', { title: 'Cleared', idea: 'A coastline that moves.', chapter_count: 1 });
        seedTask(store, 'story_1', { kind: 'fix', state: 'open', title: 'pay off the 1911 map' });

        const reply = await call(app, 'POST', '/stories/story_1/clear-pending');

        expect(reply.status).toBe(200);
        expect(store.tasks.list().map((row) => `${row.kind}:${row.state}`)).toEqual(['fix:wontfix']);
    });
});

// ---------------------------------------------------------------------------
// The Author's desk: findings and Ideas (U-10a, U-15)
// ---------------------------------------------------------------------------

describe('§10.2 U-10a — findings on the desk', () => {
    it('approves a finding and files the fix work (D-34)', async () => {
        const { app, store } = makeApp();

        await call(app, 'POST', '/stories', {
            title: 'Approved',
            idea: 'A map that precedes the land.',
            chapter_count: 1
        });
        seedFinding(store, 'story_1', { state: 'confirmed', cost: 'major', fingerprint: 'C-4|chapter_1' });

        const reply = await call(app, 'POST', '/stories/story_1/findings/finding_1/approve', {
            why: 'the map has to be paid off in chapter 1'
        });

        expect(reply.status).toBe(200);

        const finding = store.findings.require('finding_1');

        expect(finding.state).toBe('approved');
        expect(finding.approved_by).toBe('author');

        const task = store.tasks.list().find((row) => row.kind === 'fix');

        expect(task?.finding_ref).toBe('finding_1');
    });

    it('re-opens a drained Story when the approval starts work again (L-37a)', async () => {
        const { app, store } = makeApp();

        await call(app, 'POST', '/stories', { title: 'Re-opened', idea: 'A book that ends twice.', chapter_count: 1 });

        store.stories.update(
            'story_1',
            { status: 'pending', pending_kind: 'drained' },
            { run_ref: null, author: true, why: 'the test puts the Story at the drained boundary' },
            [{ id: 'story_1', rev: store.stories.require('story_1').rev }]
        );

        seedFinding(store, 'story_1', { state: 'confirmed', cost: 'major', fingerprint: 'C-4|chapter_1' });

        const reply = await call(app, 'POST', '/stories/story_1/findings/finding_1/approve', {
            why: 'still worth doing'
        });

        expect((reply.body as { status: string; pending_kind: string }).status).toBe('ready');
        expect((reply.body as { pending_kind: string }).pending_kind).toBe('none');
    });

    it("discards a finding with the Author's reason, and the desk is empty (D-34)", async () => {
        const { app, store } = makeApp();

        await call(app, 'POST', '/stories', {
            title: 'Discarded',
            idea: 'A keeper who stops keeping.',
            chapter_count: 1
        });
        seedFinding(store, 'story_1', { state: 'confirmed', cost: 'minor', fingerprint: 'C-4|chapter_1' });

        const reply = await call(app, 'POST', '/stories/story_1/findings/finding_1/discard', {
            why: 'the repetition is the point'
        });

        expect(reply.status).toBe(200);
        expect(store.findings.require('finding_1').state).toBe('discarded');

        const empty = await call(app, 'GET', '/queue');

        expect(empty.body).toEqual([]);
    });

    it('refuses an approval with no reason (T-5)', async () => {
        const { app, store } = makeApp();

        await call(app, 'POST', '/stories', { title: 'Silent', idea: 'A survey with no notes.', chapter_count: 1 });
        seedFinding(store, 'story_1', { state: 'confirmed', fingerprint: 'C-4|chapter_1' });

        const reply = await call(app, 'POST', '/stories/story_1/findings/finding_1/approve', { why: '   ' });

        expect(reply.status).toBe(400);
        expect(errorOf(reply)).toBe('`why` is required: an approval with no reason is not auditable (D-8, T-5).');
    });

    it('answers 404 for a finding that belongs to another Story (T-3)', async () => {
        const { app, store } = makeApp();

        await call(app, 'POST', '/stories', { title: 'Mine', idea: 'One book.', chapter_count: 1 });
        seedFinding(store, 'story_1', { state: 'confirmed', fingerprint: 'C-4|chapter_1' });

        const reply = await call(app, 'POST', '/stories/story_1/findings/finding_9/approve', { why: 'wrong id' });

        expect(reply.status).toBe(404);
        expect(errorOf(reply)).toBe('no finding named finding_9 is in the book (P1: the store is the memory)');
    });
});

describe('§10.2 U-15 — the Ideas tray', () => {
    /** A sourced, unverified Idea — D-27's exact case. */
    const sourcedIdea = (store: Store): void => {
        seedIdea(store, 'story_1', {
            phase: 'summary',
            state: 'proposed',
            fingerprint: 'steeple-bell',
            sources: [
                {
                    url_or_title: 'the 1911 survey notes',
                    claim: 'the bell was under the water',
                    accessed_at: '2026-01-01T00:00:00.000Z'
                }
            ],
            verification: null
        });
    };

    it('refuses to select a sourced Idea the Editor has not verified (D-27)', async () => {
        const { app, store } = makeApp();

        await call(app, 'POST', '/stories', { title: 'Unverified', idea: 'A valley under water.', chapter_count: 1 });
        sourcedIdea(store);

        const reply = await call(app, 'POST', '/stories/story_1/ideas/idea_1/select', { note: '' });

        expect(reply.status).toBe(409);
        expect(errorOf(reply)).toBe(
            'Idea idea_1 cites sources the Editor has not verified — pick it with a note, or that is the explicit "I know" this Idea has not earned (D-27, C-15).'
        );
        expect(store.ideas.require('idea_1').state).toBe('proposed');
    });

    it('takes a note as the Author\'s explicit "I know" and decides the tray (D-27, D-29)', async () => {
        const { app, store } = makeApp();

        await call(app, 'POST', '/stories', { title: 'Known', idea: 'A valley under water.', chapter_count: 1 });
        sourcedIdea(store);

        const reply = await call(app, 'POST', '/stories/story_1/ideas/idea_1/select', {
            note: 'I know — I read the survey myself'
        });

        expect(reply.status).toBe(200);

        const idea = store.ideas.require('idea_1');

        expect(idea.state).toBe('selected');
        expect(idea.selection_note).toBe('I know — I read the survey myself');

        // D-29 / P1: the pick AND its reason are one decision, so they are one commit. The route used to
        // write the note in a SECOND commit (`author_idea_note`) behind `decide_idea`, which journaled one
        // Author move as two groups and left the decision half-applied if that second write lost its CAS
        // race (T-4). `decideIdea` takes the note, so every row this click touched carries the engine's own
        // `decide_idea` label — the Idea row and the absorb Task it created — and no `author_idea_note`
        // group exists in the book at all.
        expect(store.journal.filter((event) => event.commit_label === 'author_idea_note')).toEqual([]);
        expect(
            store.journal
                .filter((event) => event.commit_label === 'decide_idea')
                .map((event) => `${event.collection}:${event.op}:${event.id}`)
        ).toEqual(['ideas:update:idea_1', 'tasks:create:task_1']);
    });

    it('discards and defers, and clears the sign-off the tray was blocking (L-7a, D-36)', async () => {
        const { app, store } = makeApp();

        await call(app, 'POST', '/stories', { title: 'Deferred', idea: 'A town under the water.', chapter_count: 1 });

        seedIdea(store, 'story_1', { phase: 'summary', state: 'proposed', fingerprint: 'bell' });
        seedIdea(store, 'story_1', { phase: 'summary', state: 'proposed', fingerprint: 'lantern' });

        // The loop parked this Story on the tray; that is the state the decision releases (L-7a).
        store.stories.update(
            'story_1',
            { status: 'pending', pending_kind: 'idea_selection' },
            { run_ref: null, author: true, why: 'fixture: the tray is what this Story is waiting on' },
            [{ id: 'story_1', rev: store.stories.require('story_1').rev }]
        );

        const deferred = await call(app, 'POST', '/stories/story_1/ideas/idea_1/defer');

        expect(deferred.status).toBe(200);
        expect(store.ideas.require('idea_1').state).toBe('deferred');

        const discarded = await call(app, 'POST', '/stories/story_1/ideas/idea_2/discard');

        expect(discarded.status).toBe(200);
        expect(store.ideas.require('idea_2').state).toBe('discarded');

        // The tray is empty, so a Story that was parked on idea_selection moves to the sign-off.
        const story = store.stories.require('story_1');

        expect(story.pending_kind).toBe('phase_signoff');
    });
});

// ---------------------------------------------------------------------------
// U-10 — the cross-Story queue
// ---------------------------------------------------------------------------

describe('§10.2 U-10 — the queue is the home screen', () => {
    it('aggregates findings, Ideas, escalations and tool gaps across Stories', async () => {
        const { app, store } = makeApp();

        await call(app, 'POST', '/stories', { title: 'First Book', idea: 'A map.', chapter_count: 1 });
        await call(app, 'POST', '/stories', { title: 'Second Book', idea: 'A lighthouse.', chapter_count: 1 });

        // `minor` is outside the default dial, so it really is on the desk (D-35).
        seedFinding(store, 'story_1', {
            state: 'confirmed',
            cost: 'minor',
            title: 'the bell is unpaid',
            evidence: 'ch2 sec_1',
            fingerprint: 'C-9|ch2'
        });
        seedIdea(store, 'story_1', {
            phase: 'summary',
            state: 'proposed',
            body: 'let the keeper lie',
            fingerprint: 'keeper-lie'
        });
        seedTask(store, 'story_1', {
            kind: 'escalation',
            state: 'open',
            title: 'does the steeple survive?',
            detail: 'the two plotlines disagree',
            criterion_ref: 'C-4'
        });
        seedTask(store, 'story_2', {
            kind: 'capability_gap',
            state: 'open',
            title: 'no tool writes a plotline',
            criterion_ref: 'C-1'
        });

        const reply = await call(app, 'GET', '/queue');
        const items = (reply.body as Array<Record<string, unknown>>).map(
            ({ created_at: _created_at, ...rest }) => rest
        );

        expect(items).toEqual([
            {
                kind: 'finding',
                story_id: 'story_1',
                story_title: 'First Book',
                id: 'finding_1',
                title: 'the bell is unpaid',
                evidence: 'ch2 sec_1',
                cost: 'minor'
            },
            {
                kind: 'idea',
                story_id: 'story_1',
                story_title: 'First Book',
                id: 'idea_1',
                title: 'let the keeper lie',
                detail: 'direction · phase summary',
                evidence: 'reader-continuity'
            },
            {
                kind: 'escalation',
                story_id: 'story_1',
                story_title: 'First Book',
                id: 'task_1',
                title: 'does the steeple survive?',
                detail: 'the two plotlines disagree',
                evidence: 'C-4'
            },
            {
                kind: 'tool_gap',
                story_id: 'story_2',
                story_title: 'Second Book',
                id: 'task_2',
                title: 'no tool writes a plotline',
                evidence: 'C-1'
            }
        ]);
    });
});

// ---------------------------------------------------------------------------
// U-17 / D-37 / D-24 — the prose pane, and the drafts it overrides
// ---------------------------------------------------------------------------

describe('§10.2 U-17 — the prose pane', () => {
    it("refuses the edit while the Story runs, in D-37's own words", async () => {
        const { app, store } = makeApp();

        await call(app, 'POST', '/stories', { title: 'Running', idea: 'A ridge over water.', chapter_count: 1 });
        seedChapter(store, 'story_1', { order: 1 });

        const reply = await call(app, 'POST', '/stories/story_1/chapters/chapter_1/sections/sec_2', {
            content: 'the Author was here'
        });

        expect(reply.status).toBe(409);
        expect(errorOf(reply)).toBe(
            'the prose pane is editable only while the Story is stopped — pause it first (D-37): story_1 is ready'
        );
    });

    it("writes the section once the Story is paused, and marks the span the Author's (D-37a, P9)", async () => {
        const { app, store } = makeApp();

        await call(app, 'POST', '/stories', { title: 'Paused Prose', idea: 'A ridge over water.', chapter_count: 1 });
        seedChapter(store, 'story_1', { order: 1 });
        await call(app, 'POST', '/stories/story_1/stop');

        const reply = await call(app, 'POST', '/stories/story_1/chapters/chapter_1/sections/sec_2', {
            content: 'the Author was here instead'
        });

        expect(reply.status).toBe(200);

        const section = store.chapters.require('chapter_1').sections.find((row) => row.id === 'sec_2');

        expect(section?.text).toBe('the Author was here instead');
        expect(section?.origin).toBe('author');
    });

    it('undoes exactly that write, back to the paragraph that stood (P11, U-5, L-17a)', async () => {
        const { app, store } = makeApp();

        await call(app, 'POST', '/stories', { title: 'Undone', idea: 'A ridge over water.', chapter_count: 1 });
        seedChapter(store, 'story_1', { order: 1 });
        await call(app, 'POST', '/stories/story_1/stop');
        await call(app, 'POST', '/stories/story_1/chapters/chapter_1/sections/sec_2', {
            content: 'the Author was here instead'
        });

        const reply = await call(app, 'POST', '/stories/story_1/undo', {
            chapter_id: 'chapter_1',
            section_id: 'sec_2'
        });

        expect(reply.status).toBe(200);

        const section = store.chapters.require('chapter_1').sections.find((row) => row.id === 'sec_2');

        expect(section?.text).toBe('Below it, water where the town had been.');
    });

    it('overrides every competing draft in ONE commit when the Author edits over them (D-24, D-22)', async () => {
        const { app, store } = makeApp();

        await call(app, 'POST', '/stories', { title: 'Overridden', idea: 'A ridge over water.', chapter_count: 1 });
        seedChapter(store, 'story_1', { order: 1 });
        seedRevision(store, 'story_1', 'chapter_1', 'draft one', 'run_1');
        seedRevision(store, 'story_1', 'chapter_1', 'draft two', 'run_2');

        await call(app, 'POST', '/stories/story_1/stop');

        const reply = await call(app, 'POST', '/stories/story_1/chapters/chapter_1/sections/sec_2', {
            content: "the Author's own paragraph"
        });

        expect(reply.status).toBe(200);

        const revisions = store.revisions.list();

        // D-22: the losers are gone from the book, not hidden by a state.
        expect(revisions.length).toBe(1);
        expect(revisions[0].state).toBe('selected');
        expect(revisions[0].selection_note).toBe(
            'selected by the Author (D-24) — their own edit is the version that stands'
        );
        expect(store.chapters.require('chapter_1').current_revision).toBe(revisions[0].id);

        // D-12a/P11: one decision, one journal group. Every row the override touched shares the label.
        const group = store.journal.filter((event) => event.commit_label === 'author_revision_override');

        expect(group.map((event) => `${event.collection}:${event.op}:${event.id}`)).toEqual([
            `revisions:delete:revision_1`,
            `revisions:update:${revisions[0].id}`,
            'chapters:update:chapter_1'
        ]);
    });

    it('re-opens an approved chapter and hands the work back to the crew (L-10)', async () => {
        const { app, store } = makeApp();

        await call(app, 'POST', '/stories', { title: 'Reopened', idea: 'A ridge over water.', chapter_count: 1 });
        seedChapter(store, 'story_1', { order: 1, state: 'done', author_locked: true });

        const reply = await call(app, 'POST', '/stories/story_1/chapters/chapter_1/unapprove');

        expect(reply.status).toBe(200);
        expect(store.chapters.require('chapter_1').state).toBe('needs_recheck');
        expect(store.chapters.require('chapter_1').author_locked).toBe(false);
    });

    it('writes the per-chapter bar override as §4.4 stores it (G-1)', async () => {
        const { app, store } = makeApp();

        await call(app, 'POST', '/stories', { title: 'Barred', idea: 'A ridge over water.', chapter_count: 1 });
        seedChapter(store, 'story_1', { order: 1 });

        const reply = await call(app, 'PATCH', '/stories/story_1/chapters/chapter_1/bar', { bar_override: '-C-4 +1' });

        expect(reply.status).toBe(200);
        expect(store.chapters.require('chapter_1').bar_override).toBe('-C-4 +1');
    });
});

// ---------------------------------------------------------------------------
// U-5 proposals, U-9 directives, U-13 completion, D-17b assignment
// ---------------------------------------------------------------------------

describe('§10.2 U-5/U-9/U-13 — the rest of the Story surface', () => {
    /** One §4.16 proposal row, as a run would have filed it. */
    const seedProposal = (store: Store): void => {
        seedChapter(store, 'story_1', { order: 1 });

        store.proposals.create(
            {
                story_id: 'story_1',
                target_ref: 'chapter_1',
                target_field: 'sections[1].text',
                patch: { insert: 'a second steeple' },
                why: 'the payoff lands earlier',
                run_ref: 'run_1',
                state: 'pending'
            },
            { run_ref: null, author: true, why: 'fixture: an agent proposal awaiting the Author (D-20)' }
        );
    };

    it('accepts a proposal (D-20)', async () => {
        const { app, store } = makeApp();

        await call(app, 'POST', '/stories', { title: 'Proposed', idea: 'A ridge over water.', chapter_count: 1 });
        seedProposal(store);

        const reply = await call(app, 'POST', '/stories/story_1/proposals/proposal_1/accept');

        expect(reply.status).toBe(200);
        expect(store.proposals.require('proposal_1').state).toBe('accepted');
    });

    it('rejects a proposal with the same decision surface (D-20a)', async () => {
        const { app, store } = makeApp();

        await call(app, 'POST', '/stories', { title: 'Rejected', idea: 'A ridge over water.', chapter_count: 1 });
        seedProposal(store);

        const reply = await call(app, 'POST', '/stories/story_1/proposals/proposal_1/reject');

        expect(reply.status).toBe(200);
        expect(store.proposals.require('proposal_1').state).toBe('rejected');
    });

    it('turns one line of intent into a directives record (U-9, D-19)', async () => {
        const { app, store } = makeApp();

        await call(app, 'POST', '/stories', { title: 'Directed', idea: 'A ridge over water.', chapter_count: 1 });

        const reply = await call(app, 'POST', '/stories/story_1/directives', { text: 'kill the mentor in ch4' });

        expect(reply.status).toBe(200);
        expect(store.directives.list().map((row) => row.text)).toEqual(['kill the mentor in ch4']);
    });

    it('refuses a directive bar that receives conversation (U-9)', async () => {
        const { app } = makeApp();

        await call(app, 'POST', '/stories', { title: 'Chatty', idea: 'A ridge over water.', chapter_count: 1 });

        const reply = await call(app, 'POST', '/stories/story_1/directives', { text: '' });

        expect(reply.status).toBe(400);
        expect(errorOf(reply)).toBe(
            '`text` is the decision. The directive bar does not accept conversation (U-9, D-19).'
        );
    });

    it('assigns templates wholesale and refuses a bad assignment by name (D-17b)', async () => {
        const { app, store } = makeApp();

        await call(app, 'POST', '/stories', { title: 'Assigned', idea: 'A ridge over water.', chapter_count: 1 });

        const reply = await call(app, 'POST', '/stories/story_1/templates', { template_ids: ['no-such-harness'] });

        expect(reply.status).toBe(409);
        expect(errorOf(reply)).toContain(
            'assignment names "no-such-harness", which is not a template in the catalogue (D-17b)'
        );

        // A writer-only crew is refused too: drafts need an Editor to select them (D-23), so the whole
        // crew has to be assigned, which is exactly what the built-in default set is.
        const writerOnly = await call(app, 'POST', '/stories/story_1/templates', { template_ids: ['writer-summary'] });

        expect(writerOnly.status).toBe(409);
        expect(errorOf(writerOnly)).toContain('assignment needs an Editor template');

        const good = await call(app, 'POST', '/stories/story_1/templates', {
            template_ids: store.stories.require('story_1').template_refs
        });

        expect(good.status).toBe(200);
        expect(store.stories.require('story_1').template_refs).toEqual(DEFAULT_ASSIGNMENT);
    });

    it('accepts completion and closes the leftovers the preview counted (L-25b, L-26)', async () => {
        const { app, store } = makeApp();

        await call(app, 'POST', '/stories', { title: 'Completed', idea: 'A ridge over water.', chapter_count: 1 });
        seedFinding(store, 'story_1', { state: 'confirmed', cost: 'taste', fingerprint: 'C-13|story_1' });
        // U-14 / T-3b: a `verified` Idea is still the Author's undecided tray — the Editor answered "is the
        // claim true?" — and `acceptCompletion` discards it like any other discardable row, so the preview
        // has to count it. The old `proposed`-only read reported 0 Ideas for exactly this row.
        seedIdea(store, 'story_1', { phase: 'summary', state: 'verified', fingerprint: 'survey-1911' });

        store.stories.update(
            'story_1',
            {
                status: 'pending',
                pending_kind: 'drained',
                completion: {
                    proposed_at: '2026-01-01T00:00:00.000Z',
                    phase: 'chapters',
                    leftovers: { findings: 1, ideas: 0 },
                    accepted: false,
                    discarded: 0
                }
            },
            { run_ref: null, author: true, why: 'fixture: the loop has proposed completion' },
            [{ id: 'story_1', rev: store.stories.require('story_1').rev }]
        );

        const preview = (await call(app, 'GET', '/stories/story_1')).body as { completion_preview: unknown };

        expect(preview.completion_preview).toEqual({
            open_findings: 1,
            open_ideas: 1,
            oldest: 'the 1911 map is never paid off'
        });

        const reply = await call(app, 'POST', '/stories/story_1/complete');

        expect(reply.status).toBe(200);
        expect((reply.body as { status: string }).status).toBe('completed');
        expect(store.findings.require('finding_1').state).toBe('discarded');
        // The number the preview showed is the number the accept moved: the verified row is discarded by
        // the same click, not left undecided on a finished Story.
        expect(store.ideas.require('idea_1').state).toBe('discarded');
    });
});

// ---------------------------------------------------------------------------
// U-6 — the Goal panel
// ---------------------------------------------------------------------------

describe('§10.2 U-6 — the Goal panel', () => {
    it('folds the criterion ops in order and answers with the Goal surface', async () => {
        const { app, store } = makeApp();

        await call(app, 'POST', '/stories', { title: 'Tuned', idea: 'A ridge over water.', chapter_count: 1 });

        const reply = await call(app, 'PATCH', '/stories/story_1/goal', {
            threshold_soft: 3,
            criteria: [
                { op: 'remove', id: 'C-15' },
                { op: 'setHard', id: 'C-14', hard: false },
                { op: 'add', criterion: { id: 'C-99', text: 'the sea is never named twice in one page', hard: true } }
            ]
        });

        expect(reply.status).toBe(200);

        const surface = reply.body as {
            goal: { threshold_soft: number; criteria: Array<{ id: string; hard: boolean }> };
            phase_progress: string;
        };

        expect(surface.goal.threshold_soft).toBe(3);
        expect(surface.goal.criteria.map((row) => `${row.id}:${row.hard ? 'hard' : 'soft'}`)).toEqual([
            'C-0:hard',
            'C-1:hard',
            'C-2:hard',
            'C-3:soft',
            'C-4:hard',
            'C-5:hard',
            'C-6:hard',
            'C-7:hard',
            'C-8:hard',
            'C-9:soft',
            'C-10:hard',
            'C-11:soft',
            'C-12:soft',
            'C-13:hard',
            'C-14:soft',
            'C-99:hard'
        ]);
        // The phase level is C-14 and C-15; the ops deleted C-15 and made C-14 soft, so the phase now
        // answers one criterion — and still fails it, because the Summary does not yet deliver the Seed.
        expect(surface.phase_progress).toBe('0/1 · failing: C-14');

        const goal = store.goals.list().find((row) => row.story_id === 'story_1');

        expect(goal?.criteria.map((row) => row.id)).toEqual([
            'C-0',
            'C-1',
            'C-2',
            'C-3',
            'C-4',
            'C-5',
            'C-6',
            'C-7',
            'C-8',
            'C-9',
            'C-10',
            'C-11',
            'C-12',
            'C-13',
            'C-14',
            'C-99'
        ]);
    });

    it('refuses an op it cannot fold (G-1)', async () => {
        const { app } = makeApp();

        await call(app, 'POST', '/stories', { title: 'Bad Op', idea: 'A ridge over water.', chapter_count: 1 });

        const reply = await call(app, 'PATCH', '/stories/story_1/goal', { criteria: [{ op: 'flip' } as never] });

        expect(reply.status).toBe(400);
        expect(errorOf(reply)).toContain('is not one of add/remove/setHard with the fields it needs (G-1)');
    });
});

// ---------------------------------------------------------------------------
// U-8 — the template catalogue
// ---------------------------------------------------------------------------

describe('§10.2 U-8 — the template catalogue', () => {
    /** A §4.12 template that passes T-0, and the same one with its prompt removed. */
    const goodTemplate = (name: string): Record<string, unknown> => ({
        name,
        title: 'Colder Checker',
        roles: [
            {
                name: 'checker-cold',
                kind: 'checker',
                prompt: 'Judge only whether the prose is cold, and cite the line.'
            }
        ],
        serves_phase: ['chapters'],
        done_definition: 'one verdict per criterion, each with a citable line.',
        attempts: 1,
        builtin: false,
        editable: true
    });

    it('ships the §8.6 assistant harness as a built-in, duplicate-only card', async () => {
        const { app } = makeApp();

        const reply = await call(app, 'GET', '/templates');
        const assistant = (reply.body as Array<Record<string, unknown>>).find((row) => row.name === 'assistant');

        expect(assistant).toBeDefined();
        expect(assistant?.builtin).toBe(true);
        expect(assistant?.editable).toBe(false);
        // The permission row is chosen by KIND, and only the writer row can change an artifact (§8.6).
        expect((assistant?.roles as Array<Record<string, unknown>>)[0].kind).toBe('writer');
        expect((assistant?.roles as Array<Record<string, unknown>>)[0].web).toBe(false);
    });

    it('creates a template, duplicates a built-in, and refuses editing the built-in (D-17)', async () => {
        const { app, store } = makeApp();

        const created = await call(app, 'POST', '/templates', { template: goodTemplate('checker-cold') });

        expect(created.status).toBe(200);
        expect((created.body as { name: string; builtin: boolean }).name).toBe('checker-cold');

        const duplicate = await call(app, 'POST', '/templates', { duplicate_of: 'assistant' });

        expect(duplicate.status).toBe(200);
        expect((duplicate.body as { name: string; builtin: boolean; editable: boolean }).name).toBe('assistant-copy');
        expect((duplicate.body as { builtin: boolean }).builtin).toBe(false);

        const builtIn = await call(app, 'PATCH', '/templates/assistant', { attempts: 3 });

        expect(builtIn.status).toBe(409);
        expect(errorOf(builtIn)).toBe('template assistant is built-in — duplicate it and edit the copy (D-17).');

        const edited = await call(
            app,
            'PATCH',
            `/templates/${store.templates.list().find((row) => row.name === 'checker-cold')?.id}`,
            { attempts: 4 }
        );

        expect(edited.status).toBe(200);
        expect((edited.body as { attempts: number }).attempts).toBe(4);
    });

    it('refuses a template that cannot be briefed, naming which rule it breaks (T-0)', async () => {
        const { app } = makeApp();

        const broken = {
            ...goodTemplate('checker-no-prompt'),
            roles: [{ name: 'checker-no-prompt', kind: 'checker', prompt: '' }]
        };
        const reply = await call(app, 'POST', '/templates', { template: broken });

        expect(reply.status).toBe(409);
        expect(errorOf(reply)).toContain('(T-0)');
        expect(errorOf(reply)).toContain('checker-no-prompt');
    });

    it('refuses a template name the catalogue already holds (D-17)', async () => {
        const { app } = makeApp();

        const reply = await call(app, 'POST', '/templates', { template: goodTemplate('assistant') });

        expect(reply.status).toBe(409);
        expect(errorOf(reply)).toBe(
            'a template named assistant is already in the catalogue — duplicate it and edit the copy (D-17).'
        );
    });
});

// ---------------------------------------------------------------------------
// U-7 — the crew panel, and §8.6's assistant run
// ---------------------------------------------------------------------------

describe('§4.13 U-7 — the crew', () => {
    /**
     * A chat double that answers only when the run's OWN abort signal fires — the mock provider has no
     * abort bookkeeping of its own (`llm/mock.ts`'s header), and P8's cord is the signal, so the handler
     * has to be the one that notices it. The rejection lands in `RunExecutor`'s catch, which reads
     * `wasAborted(error, signal)` and closes the row as `killed` (S-3).
     */
    const hangingChat = (): MockChatClient =>
        new MockChatClient(
            (request) =>
                new Promise<ChatResponse>((resolve, reject) => {
                    const signal = request.signal;

                    if (signal?.aborted) reject(new Error('aborted before the first turn'));

                    signal?.addEventListener('abort', () => reject(new Error('aborted by the Author (P8, U-7)')), {
                        once: true
                    });
                })
        );

    it("lists runs per Story and kills one with the Author's cord (P8, U-7)", async () => {
        const { app, store } = makeApp(hangingChat());

        await call(app, 'POST', '/stories', { title: 'Killed', idea: 'A ridge over water.', chapter_count: 1 });

        const assistant = await call(app, 'POST', '/stories/story_1/assistant', {
            target: 'summary',
            text: 'tighten the promise line'
        });

        expect(assistant.status).toBe(200);

        const run = assistant.body as { id: string; state: string; kind: string };

        expect(run.kind).toBe('assistant');
        expect((await call(app, 'GET', '/runs?story_id=story_1')).body).toEqual([
            expect.objectContaining({ id: run.id, story_id: 'story_1' })
        ]);

        const killed = await call(app, 'POST', `/runs/${run.id}/kill`);

        expect(killed.status).toBe(200);

        // S-3: the teardown is unconditional, so the row closes on its own terms right after the cord.
        const closed = await waitFor(() =>
            store.runs.require(run.id).ended_at == null ? undefined : store.runs.require(run.id)
        );

        expect(closed.state).toBe('abandoned');
        expect(closed.end_reason).toBe('killed — the Author pulled the cord (P8, U-7)');
    });

    it('answers 404 for a run that was never spawned', async () => {
        const { app } = makeApp();

        const reply = await call(app, 'POST', '/runs/run_9/kill');

        expect(reply.status).toBe(404);
        expect(errorOf(reply)).toBe('no run named run_9 is in the book (P1: the store is the memory)');
    });

    it('§8.6: "Ask assistant" spawns a real run at the artifact, and the row is the answer', async () => {
        const { app, store } = makeApp();

        await call(app, 'POST', '/stories', { title: 'Asked', idea: 'A ridge over water.', chapter_count: 1 });

        const reply = await call(app, 'POST', '/stories/story_1/assistant', {
            target: 'summary',
            text: 'make the promise colder'
        });

        expect(reply.status).toBe(200);

        const run = reply.body as {
            id: string;
            kind: string;
            role: string;
            template_ref?: string;
            story_id: string;
            work_item_ref?: string;
        };
        const assistantTemplate = store.templates.list().find((row) => row.name === 'assistant');

        expect(run.kind).toBe('assistant');
        expect(run.role).toBe('writer');
        expect(run.template_ref).toBe(assistantTemplate?.name);
        expect(run.story_id).toBe('story_1');
        expect(run.work_item_ref).toBe('assistant_story_1_1');

        // The quiet chat answers with prose on the first turn, so this run tears down on its own (S-3).
        const closed = await waitFor(() =>
            store.runs.get(run.id)?.ended_at == null ? undefined : store.runs.require(run.id)
        );

        expect(closed.state).toBe('torn_down');
    });

    it('§8.6: refuses an ask with nothing in it', async () => {
        const { app } = makeApp();

        await call(app, 'POST', '/stories', { title: 'Empty Ask', idea: 'A ridge over water.', chapter_count: 1 });

        const reply = await call(app, 'POST', '/stories/story_1/assistant', { target: 'chapters', text: 'anything' });

        expect(reply.status).toBe(400);
        expect(errorOf(reply)).toBe(
            '`target` must be "summary" or "directive" (§8.6: the assistant is aimed at an artifact, not at a conversation).'
        );
    });
});

// ---------------------------------------------------------------------------
// §10 — the SSE feed's mapping (the transport itself is `server.test.ts`)
// ---------------------------------------------------------------------------

describe('§10 — the commit feed maps to the pinned topics', () => {
    const event = (
        collection: string,
        op: 'create' | 'update' | 'delete',
        id: string,
        story_id?: string
    ): CommitEvent => ({
        seq: 1,
        at: '2026-01-01T00:00:00.000Z',
        collection: collection as CommitEvent['collection'],
        op,
        id,
        attribution: { run_ref: null, why: 'fixture' },
        ...(story_id === undefined ? {} : { patch: { story_id } }),
        commit_label: 'fixture'
    });

    it('a Story write is one `story` frame carrying the Story id', () => {
        expect(feedEvents([event('chapters', 'update', 'chapter_1', 'story_1')])).toEqual([
            { kind: 'story', storyId: 'story_1' }
        ]);
    });

    it('a run write moves the crew panel AND the Stories row', () => {
        expect(feedEvents([event('runs', 'create', 'run_1', 'story_1')])).toEqual([
            { kind: 'runs', storyId: 'story_1' },
            { kind: 'story', storyId: 'story_1' }
        ]);
    });

    it('a queue write moves the desk AND the Stories row, and a burst de-duplicates per topic', () => {
        expect(
            feedEvents([
                event('findings', 'create', 'finding_1', 'story_1'),
                event('tasks', 'update', 'task_1', 'story_1'),
                event('findings', 'update', 'finding_2', 'story_1')
            ])
        ).toEqual([
            { kind: 'queue', storyId: 'story_1' },
            { kind: 'story', storyId: 'story_1' }
        ]);
    });

    it('a Story row event names its own id, so a create is not workspace-wide', () => {
        expect(feedEvents([event('stories', 'create', 'story_7')])).toEqual([{ kind: 'story', storyId: 'story_7' }]);
    });

    it('an unattributable write is workspace-wide, which the client reads as "refetch everything"', () => {
        expect(feedEvents([event('ledger', 'update', 'ledger_1')])).toEqual([{ kind: 'story' }]);
    });

    it('ignores a collection no region reads', () => {
        expect(feedEvents([event('directives', 'create', 'directive_1', 'story_1')])).toEqual([]);
    });
});
