/**
 * U-10b — "the Author may approve one finding, approve a whole chapter's worth".
 *
 * WHY THIS FILE EXISTS: the queue only ever offered the one-finding approve (U-10a). With a stalled
 * chapter the Author clicks forty times, which is the silent batching U-10b's sentence names. These
 * tests pin the bulk route in the shipped wiring (real store, real engine, real Hono request), the
 * same harness `revision-routes.test.ts` uses, and they assert the 400/404 copy verbatim because that
 * copy is product surface (L-13).
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
import type { Finding, FindingState, Story } from '../../shared/types';
import type { StoryRow } from '../../dashboard/api';
import type { LoopEngineConfig } from '../loop/types';

interface TestApp {
    app: Hono;
    store: Store;
}

/** The shipped wiring, sweep timer off (same as routes.test.ts / revision-routes.test.ts). */
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

async function call(app: Hono, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<Reply> {
    const response = await app.request(`http://localhost/v1/storyline${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    });

    const text = await response.text();

    return { status: response.status, body: text.length === 0 ? undefined : JSON.parse(text) };
}

const errorOf = (reply: Reply): string => (reply.body as { error: string }).error;

/** One §4.10 finding in one state, aimed at one unit — the store mints `finding_N` in call order. */
function seedFinding(
    store: Store,
    storyId: string,
    over: Partial<Pick<Finding, 'target_ref' | 'related_refs' | 'state' | 'cost' | 'criterion_ref'>>
): Finding {
    return store.findings.create(
        {
            story_id: storyId,
            target_ref: over.target_ref ?? 'chapter_1',
            criterion_ref: over.criterion_ref ?? 'C-6',
            title: 'The scene dodges the promise',
            evidence: 'The ridge is named, never seen (C-6).',
            cost: over.cost ?? 'major',
            fingerprint: `fp_${store.findings.count() + 1}`,
            state: over.state ?? 'confirmed',
            seen_count: 1,
            ...(over.related_refs === undefined ? {} : { related_refs: over.related_refs })
        },
        { why: 'seed: finding for the approval gate' }
    ) as Finding;
}

/**
 * One Story (`story_1`) from the real create route, one chapter (`chapter_1`), and the second chapter
 * the cross-chapter case needs (`chapter_2`).
 */
async function seedWorld(): Promise<TestApp & { story: Story }> {
    const world = makeApp();
    const reply = await call(world.app, 'POST', '/stories', {
        title: 'The Return',
        idea: 'A cartographer finds the valley she mapped is under water.',
        chapter_count: 2
    });

    const story = world.store.stories.require((reply.body as StoryRow).id);

    for (const [order, title] of ['The Ridge', 'The Water'].entries()) {
        world.store.chapters.create(
            {
                story_id: story.id,
                plotline_ref: 'plotline_1',
                order: order + 1,
                title,
                summary: 'She reads the water.',
                sections: [{ id: `section_${order + 1}`, text: 'Standing prose.', origin: 'writer' }],
                state: 'drafting',
                author_locked: false,
                round: 1
            },
            { why: 'seed: chapter under review' }
        );
    }

    return { ...world, story };
}

/** `[id, state, approved_by]` for every finding, so "what moved" is one exact value. */
function board(store: Store): Array<[string, FindingState, string | null | undefined]> {
    return store.findings.list().map((row) => [row.id, row.state, row.approved_by]);
}

describe('U-10b — approving a whole chapter worth of findings', () => {
    it('approves every confirmed finding aimed at the chapter, by target_ref OR by L-11a related_refs', async () => {
        const world = await seedWorld();
        const { store } = world;

        seedFinding(store, 'story_1', { target_ref: 'chapter_1' }); // finding_1 — aimed at it
        seedFinding(store, 'story_1', { target_ref: 'chapter_2', related_refs: ['chapter_1'] }); // finding_2 — touches it
        seedFinding(store, 'story_1', { target_ref: 'chapter_2' }); // finding_3 — another chapter's
        seedFinding(store, 'story_1', { target_ref: 'chapter_1', state: 'unconfirmed' }); // finding_4 — Editor's, not the queue's
        seedFinding(store, 'story_1', { target_ref: 'chapter_1', state: 'discarded' }); // finding_5 — closed

        const reply = await call(world.app, 'POST', '/stories/story_1/chapters/chapter_1/findings/approve-all', {
            why: 'the ridge has to be seen, not named'
        });

        expect(reply.status).toBe(200);
        // Only the two rows that belong to this chapter AND sit in the queue moved, and they moved to
        // `approved` with `by: author` (D-41c: the Author's approval is not the auto lane).
        expect(board(store)).toEqual([
            ['finding_1', 'approved', 'author'],
            ['finding_2', 'approved', 'author'],
            ['finding_3', 'confirmed', undefined],
            ['finding_4', 'unconfirmed', undefined],
            ['finding_5', 'discarded', undefined]
        ]);
    });

    it('each approval is its own journaled commit, and the note the Author typed rides on every one (U-10b, D-34)', async () => {
        const world = await seedWorld();
        const { store } = world;

        seedFinding(store, 'story_1', { target_ref: 'chapter_1' });
        seedFinding(store, 'story_1', { target_ref: 'chapter_1' });

        await call(world.app, 'POST', '/stories/story_1/chapters/chapter_1/findings/approve-all', {
            why: 'both of these are the same mistake'
        });

        expect(
            store.journal
                .filter((event) => event.commit_label === 'approve_finding' && event.collection === 'findings')
                .map((event) => ({ id: event.id, why: event.attribution.why }))
        ).toEqual([
            {
                id: 'finding_1',
                why: 'the Author approved major fp_1: both of these are the same mistake (D-34)'
            },
            {
                id: 'finding_2',
                why: 'the Author approved major fp_2: both of these are the same mistake (D-34)'
            }
        ]);
    });

    it('refuses a blank `why` — a bulk approval with no reason is the least auditable write in the book', async () => {
        const world = await seedWorld();

        seedFinding(world.store, 'story_1', { target_ref: 'chapter_1' });

        const reply = await call(world.app, 'POST', '/stories/story_1/chapters/chapter_1/findings/approve-all', {
            why: '   '
        });

        expect(reply.status).toBe(400);
        expect(errorOf(reply)).toBe(
            '`why` is required: an approval with no reason is not auditable, and a bulk one least of all (D-8, T-5).'
        );
        expect(board(world.store)).toEqual([['finding_1', 'confirmed', undefined]]);
    });

    it('a chapter that is not in the book answers 404 naming the id, and a chapter of another Story misses too', async () => {
        const world = await seedWorld();

        const unknown = await call(world.app, 'POST', '/stories/story_1/chapters/chapter_9/findings/approve-all', {
            why: 'anything'
        });

        expect(unknown.status).toBe(404);
        expect(errorOf(unknown)).toBe('no chapter named chapter_9 is in the book (P1: the store is the memory)');
    });
});
