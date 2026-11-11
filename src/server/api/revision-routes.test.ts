/**
 * U-13 / D-24 / D-22 / D-23 — the Author's two revision verbs, end to end through the route table.
 *
 * WHY THIS FILE EXISTS: the comparison pane rendered a "Select this draft" button whose comment said
 * the Author override "lands with the API" — and it never had. §6.2a gives the Author the move, D-24
 * ranks it above a Checker's selection, and D-23 gives the merge a task row; none of it was reachable
 * from `/v1/storyline`. These tests pin the two routes the fix adds, in the same harness
 * `routes.test.ts` uses (real store, real engine, real Hono request), because the 400s and 404s are
 * product copy (L-13) and are asserted verbatim.
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
import type { ChapterSection, Revision, Story } from '../../shared/types';
// The projection's row shape is the client's contract, and `dashboard/api.ts` is where it is named
// (`routes.ts` imports its goal-patch type from the same place).
import type { StoryRow } from '../../dashboard/api';
import type { LoopEngineConfig } from '../loop/types';

interface TestApp {
    app: Hono;
    store: Store;
}

/** The shipped wiring, with the loop's own two doubles and the sweep timer off (same as routes.test.ts). */
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

/** One JSON round trip against the mounted root — the fetch the dashboard client makes. */
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
 * A Story plus one chapter and two competing drafts. The Story comes from the real create route (so
 * its Summary and Goal are real rows); the drafts are written straight to the store because §8's
 * `fileRevision` is the crew's path and this file is about the Author's.
 *
 * The ids are the store's own minted sequence — `story_1`, `chapter_1`, `revision_1`, `revision_2` —
 * and every assertion names them exactly rather than reading them back.
 */
async function seedWorld(): Promise<TestApp & { story: Story }> {
    const world = makeApp();
    const reply = await call(world.app, 'POST', '/stories', {
        title: 'The Return',
        idea: 'A cartographer finds the valley she mapped is under water.',
        chapter_count: 2
    });

    const story = world.store.stories.require((reply.body as StoryRow).id);
    const plotline = world.store.plotlines.create(
        {
            story_id: story.id,
            order: 1,
            heading: 'She reads the water',
            must_happen: 'She wades in.',
            must_change: 'She stops measuring.',
            contract_locked: false,
            aligned: false,
            needs_recheck: false
        },
        { why: 'seed: plotline for the drafts to be judged against' }
    );

    world.store.chapters.create(
        {
            story_id: story.id,
            plotline_ref: plotline.id,
            order: 1,
            title: 'The Ridge',
            summary: 'She reaches the ridge and does not recognise her own map.',
            sections: [{ id: 'section_1', text: 'The standing text before any draft.', origin: 'writer' }],
            state: 'drafting',
            author_locked: false,
            round: 1
        },
        { why: 'seed: chapter under review' }
    );

    for (const [index, text] of [
        'First draft: the ridge is gone.',
        'Second draft: the ridge is underwater.'
    ].entries()) {
        world.store.revisions.create(
            {
                story_id: story.id,
                // §4.15's stored chapter shape: `{sections}` (src/server/tools/artifacts.ts's codec),
                // so the install has prose to write rather than an empty chapter (D-22's warning).
                body: {
                    sections: [
                        {
                            id: `section_1`,
                            text,
                            origin: 'writer'
                        }
                    ]
                },
                unit_kind: 'chapter',
                unit_ref: 'chapter_1',
                run_ref: `run_${index + 1}`,
                template_ref: 'writer',
                state: 'competing',
                verdict_refs: []
            },
            { run_ref: `run_${index + 1}`, why: `seed: draft ${index + 1} filed by the Writer run` }
        );
    }

    return { ...world, story };
}

describe('the Author revision routes (U-13, D-24, D-22, D-23)', () => {
    it('the Author selects a draft: it installs, its sibling is deleted in the same commit (U-13, D-24, D-22)', async () => {
        const world = await seedWorld();
        const journalBefore = world.store.journal.length;

        const reply = await call(world.app, 'POST', '/stories/story_1/revisions/revision_2/select', {
            note: 'The underwater version keeps the map promise (D-24).'
        });

        expect(reply.status).toBe(200);
        // The response is the refreshed stories-row, the same shape every Story verb answers with.
        expect((reply.body as StoryRow).id).toBe('story_1');

        // D-22: exactly one draft survives, and it is the one the Author named.
        const survivors: Revision[] = world.store.revisions.list();

        expect(survivors.map((row) => row.id)).toEqual(['revision_2']);
        expect(survivors[0].state).toBe('selected');
        expect(survivors[0].selection_note).toBe('The underwater version keeps the map promise (D-24).');

        // The winning draft's prose is the chapter's prose, and `current_revision` records the choice
        // so the restore path stays expressible (D-24).
        expect(world.store.chapters.require('chapter_1').sections).toEqual<ChapterSection[]>([
            {
                id: 'section_1',
                text: 'Second draft: the ridge is underwater.',
                origin: 'writer',
                last_run_ref: null
            }
        ]);
        expect(world.store.chapters.require('chapter_1').current_revision).toBe('revision_2');

        // P11/D-20a: an Author write, so `author: true` with no run behind it — the audit has to tell
        // this apart from the Checker's `selectRevision`, which carries a `run_ref`.
        const group = world.store.journal.slice(journalBefore);
        const labels = [...new Set(group.map((event) => event.commit_label))];

        expect(labels).toEqual(['author_revision_select']);
        expect(group.map((event) => `${event.op} ${event.collection} ${event.id}`)).toEqual([
            'update chapters chapter_1',
            'update revisions revision_2',
            'delete revisions revision_1'
        ]);
        expect(group.every((event) => event.attribution.author === true && event.attribution.run_ref === null)).toBe(
            true
        );
        expect(group[0].attribution.why).toBe('the Author selected revision_2 for chapter_1 (D-24, U-13)');
    });

    it('a bare click still attributes: the default note is the Author naming themselves (U-13, L-13)', async () => {
        const world = await seedWorld();

        const reply = await call(world.app, 'POST', '/stories/story_1/revisions/revision_1/select', {});

        expect(reply.status).toBe(200);
        expect(world.store.revisions.require('revision_1').selection_note).toBe('selected by the Author (D-24)');
        expect(world.store.revisions.list().map((row) => row.id)).toEqual(['revision_1']);
    });

    it('a draft that is not in the book misses, and no draft is touched (U-13, T-3, L-13)', async () => {
        const world = await seedWorld();

        const reply = await call(world.app, 'POST', '/stories/story_1/revisions/revision_9/select', {});

        expect(reply.status).toBe(404);
        expect(errorOf(reply)).toBe('no revision named revision_9 is in the book (P1: the store is the memory)');
        expect(world.store.revisions.list().map((row) => row.state)).toEqual(['competing', 'competing']);

        // T-3: a draft from another Story is the same miss, and the Story check comes first.
        const foreign = await call(world.app, 'POST', '/stories/story_7/revisions/revision_1/select', {});

        expect(foreign.status).toBe(404);
        expect(errorOf(foreign)).toBe('no story named story_7 is in the book (P1: the store is the memory)');
    });

    it('the merge request opens the task a Writer picks up, and the drafts keep competing (U-13a, D-23)', async () => {
        const world = await seedWorld();

        const reply = await call(world.app, 'POST', '/stories/story_1/revisions/merge', {
            unit_ref: 'chapter_1',
            revision_ids: ['revision_1', 'revision_2'],
            parts: 'The opening of revision_1, the last paragraph of revision_2.',
            why: 'Neither draft is right, and the pair of them is.'
        });

        expect(reply.status).toBe(200);
        expect((reply.body as StoryRow).id).toBe('story_1');

        // D-23: the merge is queued work, not a decision — the drafts are untouched.
        expect(world.store.revisions.list().map((row) => row.state)).toEqual(['competing', 'competing']);
        expect(world.store.chapters.require('chapter_1').sections[0].text).toBe('The standing text before any draft.');
        expect(world.store.chapters.require('chapter_1').current_revision).toBeUndefined();

        // The task is the one §8.2's `requestMerge` would open: same kind, same dedupe title, same
        // owner, so the Author's desk and the Checker's request land as ONE entry (T-24, L-11a).
        expect(world.store.tasks.list().length).toBe(1);
        expect(world.store.tasks.require('task_1')).toMatchObject({
            story_id: 'story_1',
            kind: 'merge',
            title: 'Merge 2 drafts for chapter_1',
            owner_role: 'writer',
            state: 'open',
            attempts: 0
        });
        expect(world.store.tasks.require('task_1').detail).toBe(
            'The opening of revision_1, the last paragraph of revision_2.\nDrafts: revision_1, revision_2\nWhy: Neither draft is right, and the pair of them is.'
        );
        // P11: the Author asked, so the row is attributed to the Author and not to a run.
        expect(world.store.tasks.require('task_1').created_at.length).toBeGreaterThan(0);
    });

    it('a second merge request for the same drafts dedupes into the one task (U-13a, T-24, L-11a)', async () => {
        const world = await seedWorld();
        const body = {
            unit_ref: 'chapter_1',
            revision_ids: ['revision_1', 'revision_2'],
            parts: 'Opening from revision_1, ending from revision_2.'
        };

        expect((await call(world.app, 'POST', '/stories/story_1/revisions/merge', body)).status).toBe(200);
        expect((await call(world.app, 'POST', '/stories/story_1/revisions/merge', body)).status).toBe(200);
        expect(world.store.tasks.list().map((task) => task.id)).toEqual(['task_1']);
    });

    it('the merge request refuses what is not a merge, in the copy the Author reads (U-13a, D-23, L-13)', async () => {
        const world = await seedWorld();

        // One draft is already a decision.
        const lonely = await call(world.app, 'POST', '/stories/story_1/revisions/merge', {
            unit_ref: 'chapter_1',
            revision_ids: ['revision_1'],
            parts: 'All of it.'
        });

        expect(lonely.status).toBe(400);
        expect(errorOf(lonely)).toBe(
            '`revision_ids` must name at least two drafts — one draft is already a decision (D-23).'
        );

        // The brief is the whole request; a merge with no stated parts is a coin flip.
        const silent = await call(world.app, 'POST', '/stories/story_1/revisions/merge', {
            unit_ref: 'chapter_1',
            revision_ids: ['revision_1', 'revision_2'],
            parts: '   '
        });

        expect(silent.status).toBe(400);
        expect(errorOf(silent)).toBe('`parts` is the merge brief: which half of which draft to take (§8.2).');

        // A draft from another unit cannot be merged with this one (T-3's one-unit rule).
        const otherUnit = await call(world.app, 'POST', '/stories/story_1/revisions/merge', {
            unit_ref: 'plotline_1',
            revision_ids: ['revision_1', 'revision_2'],
            parts: 'Both halves.'
        });

        expect(otherUnit.status).toBe(400);
        expect(errorOf(otherUnit)).toBe(
            'revision revision_1 belongs to chapter_1, not to plotline_1, so it cannot be merged with it (T-3).'
        );

        // An unknown unit misses rather than queueing a task against nothing.
        const nowhere = await call(world.app, 'POST', '/stories/story_1/revisions/merge', {
            unit_ref: 'chapter_9',
            revision_ids: ['revision_1', 'revision_2'],
            parts: 'Both halves.'
        });

        expect(nowhere.status).toBe(404);
        expect(errorOf(nowhere)).toBe('no unit named chapter_9 is in the book (P1: the store is the memory)');
        expect(world.store.tasks.list().length).toBe(0);
    });

    it('the Author may select a Summary draft, which installs the prose fields (U-13, D-22)', async () => {
        const world = await seedWorld();
        const summary = world.store.summaries.list()[0];

        for (const ending of ['She floods the valley on purpose.', 'She leaves the valley standing.']) {
            world.store.revisions.create(
                {
                    story_id: 'story_1',
                    body: { fields: { ending } },
                    unit_kind: 'summary',
                    unit_ref: summary.id,
                    run_ref: 'run_writer',
                    state: 'competing',
                    verdict_refs: []
                },
                { run_ref: 'run_writer', why: 'seed: a Summary draft' }
            );
        }

        const reply = await call(world.app, 'POST', '/stories/story_1/revisions/revision_3/select', {
            note: 'The deliberate ending is the one the Seed promises (D-24).'
        });

        expect(reply.status).toBe(200);
        expect(world.store.summaries.require(summary.id).ending).toBe('She floods the valley on purpose.');
        // Both Summary drafts go, and the chapter's drafts are untouched — the delete is per unit (D-22).
        expect(world.store.revisions.list().map((row) => row.id)).toEqual(['revision_1', 'revision_2', 'revision_3']);
        expect(world.store.revisions.require('revision_3').state).toBe('selected');
    });
});
