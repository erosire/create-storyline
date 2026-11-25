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
    over: Partial<Pick<Finding, 'target_ref' | 'related_refs' | 'state' | 'cost' | 'criterion_ref' | 'kind'>>
): Finding {
    return store.findings.create(
        {
            story_id: storyId,
            target_ref: over.target_ref ?? 'chapter_0',
            criterion_ref: over.criterion_ref ?? 'C-6',
            title: 'The scene dodges the promise',
            evidence: 'The ridge is named, never seen (C-6).',
            cost: over.cost ?? 'major',
            // D-33d: `kind` is the only way this fixture can ask for a PROPOSAL row, and it stays
            // optional so every existing row in this file keeps the `issue` reading it always had.
            ...(over.kind === undefined ? {} : { kind: over.kind }),
            fingerprint: `fp_${store.findings.count() + 1}`,
            state: over.state ?? 'confirmed',
            seen_count: 1,
            ...(over.related_refs === undefined ? {} : { related_refs: over.related_refs })
        },
        { why: 'seed: finding for the approval gate' }
    ) as Finding;
}

/**
 * One Story (`story_0`) from the real create route, one chapter (`chapter_0`), and the second chapter
 * the cross-chapter case needs (`chapter_1`).
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
                plotline_ref: 'plotline_0',
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

        seedFinding(store, 'story_0', { target_ref: 'chapter_0' }); // finding_0 — aimed at it
        seedFinding(store, 'story_0', { target_ref: 'chapter_1', related_refs: ['chapter_0'] }); // finding_1 — touches it
        seedFinding(store, 'story_0', { target_ref: 'chapter_1' }); // finding_2 — another chapter's
        seedFinding(store, 'story_0', { target_ref: 'chapter_0', state: 'unconfirmed' }); // finding_3 — Editor's, not the queue's
        seedFinding(store, 'story_0', { target_ref: 'chapter_0', state: 'discarded' }); // finding_4 — closed

        const reply = await call(world.app, 'POST', '/stories/story_0/chapters/chapter_0/findings/approve-all', {
            why: 'the ridge has to be seen, not named'
        });

        expect(reply.status).toBe(200);
        // Only the two rows that belong to this chapter AND sit in the queue moved, and they moved to
        // `approved` with `by: author` (D-41c: the Author's approval is not the auto lane).
        expect(board(store)).toEqual([
            ['finding_0', 'approved', 'author'],
            ['finding_1', 'approved', 'author'],
            ['finding_2', 'confirmed', undefined],
            ['finding_3', 'unconfirmed', undefined],
            ['finding_4', 'discarded', undefined]
        ]);
    });

    it('each approval is its own journaled commit, and the note the Author typed rides on every one (U-10b, D-34)', async () => {
        const world = await seedWorld();
        const { store } = world;

        seedFinding(store, 'story_0', { target_ref: 'chapter_0' });
        seedFinding(store, 'story_0', { target_ref: 'chapter_0' });

        await call(world.app, 'POST', '/stories/story_0/chapters/chapter_0/findings/approve-all', {
            why: 'both of these are the same mistake'
        });

        expect(
            store.journal
                .filter((event) => event.commit_label === 'approve_finding' && event.collection === 'findings')
                .map((event) => ({ id: event.id, why: event.attribution.why }))
        ).toEqual([
            {
                id: 'finding_0',
                why: 'the Author approved major fp_1: both of these are the same mistake (D-34)'
            },
            {
                id: 'finding_1',
                why: 'the Author approved major fp_2: both of these are the same mistake (D-34)'
            }
        ]);
    });

    it('refuses a blank `why` — a bulk approval with no reason is the least auditable write in the book', async () => {
        const world = await seedWorld();

        seedFinding(world.store, 'story_0', { target_ref: 'chapter_0' });

        const reply = await call(world.app, 'POST', '/stories/story_0/chapters/chapter_0/findings/approve-all', {
            why: '   '
        });

        expect(reply.status).toBe(400);
        expect(errorOf(reply)).toBe(
            '`why` is required: an approval with no reason is not auditable, and a bulk one least of all (D-8, T-5).'
        );
        expect(board(world.store)).toEqual([['finding_0', 'confirmed', undefined]]);
    });

    it('a chapter that is not in the book answers 404 naming the id, and a chapter of another Story misses too', async () => {
        const world = await seedWorld();

        const unknown = await call(world.app, 'POST', '/stories/story_0/chapters/chapter_8/findings/approve-all', {
            why: 'anything'
        });

        expect(unknown.status).toBe(404);
        expect(errorOf(unknown)).toBe('no chapter named chapter_8 is in the book (P1: the store is the memory)');
    });
});

// ── D-33c/D-33d at the Author's queue ──────────────────────────────────────────────────────────
//
// WHY THESE ROWS EXIST: the tool refuses an approval over an open issue, and the Author's two approve
// buttons do not go through the tool — the single approve lands on `engine.approveFinding` and the bulk
// one loops over it. Before this rule, both funnels were the hole: the same proposal the Editor was
// refused was one click away from a Writer round. And the bulk route had a second failure the shape of
// its answer hides: `approved` is not `resolved`, so approving a chapter's ISSUES in one batch must not
// unlock that chapter's PROPOSALS in the same batch.
describe('D-33d — the Author cannot approve a proposal over an unresolved issue', () => {
    it('the single approve refuses a proposal, names the issues, and moves nothing', async () => {
        const world = await seedWorld();
        const { store } = world;

        seedFinding(store, 'story_0', { target_ref: 'chapter_0' }); // finding_0 — the issue
        seedFinding(store, 'story_0', { target_ref: 'chapter_0', kind: 'proposal' }); // finding_1 — the proposal

        const reply = await call(world.app, 'POST', '/stories/story_0/findings/finding_1/approve', {
            why: 'worth a pass'
        });

        expect(reply.status).toBe(409);
        // L-13: the body is the sentence the Author reads, and it has to say WHICH rule and WHICH rows.
        expect(errorOf(reply)).toBe(
            'proposal finding_1 cannot be approved while 1 issue is unresolved — finding_0 (major, confirmed) — because issues are in focus before anything else can be done. Resolve them, or discard the proposal (D-33d).'
        );
        expect(board(store)).toEqual([
            ['finding_0', 'confirmed', undefined],
            ['finding_1', 'confirmed', undefined]
        ]);
        // The commit rolled back, so no Writer work leaked in behind the refusal either.
        expect(store.tasks.list()).toEqual([]);
    });

    it('the single approve goes through once the issue is resolved', async () => {
        const world = await seedWorld();
        const { store } = world;

        seedFinding(store, 'story_0', { target_ref: 'chapter_0' });
        seedFinding(store, 'story_0', { target_ref: 'chapter_0', kind: 'proposal' });

        const issue = store.findings.require('finding_0');

        store.findings.update('finding_0', { state: 'fixed' }, { why: 'seed: the repair landed' }, [
            { id: issue.id, rev: issue.rev }
        ]);

        const reply = await call(world.app, 'POST', '/stories/story_0/findings/finding_1/approve', {
            why: 'worth a pass'
        });

        expect(reply.status).toBe(200);
        expect(board(store)).toEqual([
            ['finding_0', 'fixed', undefined],
            ['finding_1', 'approved', 'author']
        ]);
    });

    it('the discard route still closes a proposal over an open issue (D-33d)', async () => {
        const world = await seedWorld();
        const { store } = world;

        seedFinding(store, 'story_0', { target_ref: 'chapter_0' });
        seedFinding(store, 'story_0', { target_ref: 'chapter_0', kind: 'proposal' });

        const reply = await call(world.app, 'POST', '/stories/story_0/findings/finding_1/discard', {
            why: 'the book is better without the flourish'
        });

        expect(reply.status).toBe(200);
        // Declining a change is not an approval and creates no Writer work, so the rule that sequences
        // approvals has no business refusing it — and closing the row is what L-15a/L-16a read.
        expect(board(store)).toEqual([
            ['finding_0', 'confirmed', undefined],
            ['finding_1', 'discarded', undefined]
        ]);
    });

    it('approve-all takes the chapter\u2019s issues and SKIPS its proposals, because approving an issue is not resolving it (U-10b, D-33d)', async () => {
        const world = await seedWorld();
        const { store } = world;

        seedFinding(store, 'story_0', { target_ref: 'chapter_0' }); // finding_0 — issue
        seedFinding(store, 'story_0', { target_ref: 'chapter_0', kind: 'proposal' }); // finding_1 — proposal
        seedFinding(store, 'story_0', { target_ref: 'chapter_1', related_refs: ['chapter_0'] }); // finding_2 — issue, via L-11a

        const reply = await call(world.app, 'POST', '/stories/story_0/chapters/chapter_0/findings/approve-all', {
            why: 'clear the ridge, leave the flourish for later'
        });

        expect(reply.status).toBe(200);
        // The two issues moved and the proposal did NOT, even though its own chapter-mates were approved
        // in the same batch: `approved` opens a Writer task, it does not resolve anything, so the batch
        // that clears the defects is the batch AFTER which the proposal becomes approvable.
        expect(board(store)).toEqual([
            ['finding_0', 'approved', 'author'],
            ['finding_1', 'confirmed', undefined],
            ['finding_2', 'approved', 'author']
        ]);
        // The route keeps its shape: one journaled approve per finding it APPROVED, and no anonymous
        // bulk write. The skipped row simply has no event.
        expect(
            store.journal
                .filter((event) => event.commit_label === 'approve_finding' && event.collection === 'findings')
                .map((event) => event.id)
        ).toEqual(['finding_0', 'finding_2']);
        // A SECOND batch, fired right after the first, still skips it: `approved` opens Writer work, it is
        // not `fixed`, so the issues the proposal was waiting on are not resolved yet. The release comes
        // from the repair landing (the `fixed` case above), never from the Author clicking twice.
        const again = await call(world.app, 'POST', '/stories/story_0/chapters/chapter_0/findings/approve-all', {
            why: 'and the flourish, now?'
        });

        expect(again.status).toBe(200);
        expect(board(store)).toEqual([
            ['finding_0', 'approved', 'author'],
            ['finding_1', 'confirmed', undefined],
            ['finding_2', 'approved', 'author']
        ]);
    });

    it('approve-all approves the proposals too, once the Story has no issue left (D-33d)', async () => {
        const world = await seedWorld();
        const { store } = world;

        seedFinding(store, 'story_0', { target_ref: 'chapter_0', kind: 'proposal' });
        seedFinding(store, 'story_0', { target_ref: 'chapter_0', kind: 'proposal' });

        const reply = await call(world.app, 'POST', '/stories/story_0/chapters/chapter_0/findings/approve-all', {
            why: 'no defects left in this chapter, so the improvements can go'
        });

        expect(reply.status).toBe(200);
        expect(board(store)).toEqual([
            ['finding_0', 'approved', 'author'],
            ['finding_1', 'approved', 'author']
        ]);
    });
});
