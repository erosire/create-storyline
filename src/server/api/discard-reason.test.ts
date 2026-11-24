/**
 * R1 / R3 — the discard reason as it reaches the dashboard through `StoryView.revisions`.
 *
 * WHY THIS FILE EXISTS: the rail reads the projected Story view (`GET /stories/:id`), not the store,
 * and two of the three ways a `discarded` row gets there never had an explanation:
 *   - the Author's selection (routes.ts:1022) keeps Summary siblings as `discarded` history, and
 *   - `viewRevisions` (projections.ts:317) resurrects the Summary samples a phase ① selection
 *     hard-deleted, forcing `state: 'discarded'` from the journal.
 * Both now carry `Revision.discard_reason`: the Author's own note when they typed one, otherwise the
 * sentence the commit is already attributed with; and for a reconstructed row, the journal delete
 * event's `attribution.why` — which is why a sampling truncation reads as a truncation, never as an
 * Editor's judgment the Editor never made.
 *
 * Legacy rows (written before the field existed) are pinned too: they must project exactly as they
 * did, with no invented reason and no blank one.
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
import type { Revision, Story } from '../../shared/types';

interface TestApp {
    app: Hono;
    store: Store;
}

/** The shipped wiring with the loop's doubles and the sweep timer off (as phase1-view.test.ts). */
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

async function call(
    app: Hono,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown
): Promise<{ status: number; body: unknown }> {
    const response = await app.request(`http://localhost/v1/storyline${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    });

    return { status: response.status, body: await response.json() };
}

/**
 * A Story through the real create route, so the Summary row and the minted ids are the ones the
 * dashboard reads. The route writes no revisions, so the first draft a fixture files is `revision_0`.
 */
async function seedStory(world: TestApp): Promise<{ storyId: string; summaryId: string }> {
    const created = await call(world.app, 'POST', '/stories', {
        title: 'The Long Sounding',
        idea: 'A cartographer maps a sea that remembers the fleet it swallowed.',
        chapter_count: 2,
        // SUMMARY PHRASE (R5/R6): this file is about the discard reason on a SUPERSEDED Summary draft,
        // which only a legacy book has — on a group-managed Story the Summary has no competing draft
        // set and `revisions/:id/select` answers 409. `'sampling'` puts the create back on the pipeline
        // these rows are written against.
        summary_mode: 'sampling'
    });

    // The create route answers with the stories-row; only the minted `id` is read here, and §4.1's
    // `Story` row is the shared type that carries it (the row shape itself is a dashboard contract).
    const storyId = (created.body as Story).id;

    return { storyId, summaryId: world.store.summaries.list()[0].id };
}

/** Two competing Summary drafts of one unit: `revision_0`, then `revision_1`. */
function seedSummaryDrafts(world: TestApp, storyId: string, summaryId: string, endings: string[]): void {
    for (const ending of endings) {
        world.store.revisions.create(
            {
                story_id: storyId,
                // §4.15's Summary shape is `{fields}` (tools/artifacts.ts:502), so an install has prose.
                body: { fields: { ending } },
                unit_kind: 'summary',
                unit_ref: summaryId,
                run_ref: 'run_writer',
                state: 'competing',
                verdict_refs: []
            },
            { run_ref: 'run_writer', why: 'fixture: a Summary draft' }
        );
    }
}

/** One row of the projected `revisions` slice, by id — the JSON the rail actually renders. */
function viewRow(body: unknown, id: string): Revision {
    const revisions = (body as { revisions: Revision[] }).revisions;

    return revisions.find((row) => row.id === id) as Revision;
}

/** The pair the rail renders for one row: the state and the reason that goes with it. */
const reasonOf = (row: Revision) => ({ state: row.state, discard_reason: row.discard_reason });

describe('the discard reason on the projected revision history (R1, R3)', () => {
    it("an Author selection puts the Author's note on the kept loser, and the view carries it (R1, D-24)", async () => {
        const world = makeApp();
        const { storyId, summaryId } = await seedStory(world);
        seedSummaryDrafts(world, storyId, summaryId, [
            'She floods the valley on purpose.',
            'She leaves the valley standing.'
        ]);

        const note = 'The deliberate flood is the promise the Seed made (D-24).';
        const reply = await call(world.app, 'POST', `/stories/${storyId}/revisions/revision_1/select`, { note });

        expect(reply.status).toBe(200);

        // The winner keeps riding `selection_note` (T-2a) and gains no reason of its own; the field
        // is only ever the loser's, which is why the two can sit side by side in the rail.
        expect({
            state: world.store.revisions.require('revision_1').state,
            selection_note: world.store.revisions.require('revision_1').selection_note,
            discard_reason: world.store.revisions.require('revision_1').discard_reason
        }).toEqual({ state: 'selected', selection_note: note, discard_reason: undefined });

        expect({
            state: world.store.revisions.require('revision_0').state,
            selection_note: world.store.revisions.require('revision_0').selection_note,
            discard_reason: world.store.revisions.require('revision_0').discard_reason
        }).toEqual({ state: 'discarded', selection_note: undefined, discard_reason: note });

        // The same values out of the projection, with no new endpoint: `revisions` IS the rail's slice.
        expect(reasonOf(viewRow((await call(world.app, 'GET', `/stories/${storyId}`)).body, 'revision_0'))).toEqual({
            state: 'discarded',
            discard_reason: note
        });
    });

    it('a bare Author click still gives the loser a truthful reason, naming the decision (R1, D-24)', async () => {
        const world = makeApp();
        const { storyId, summaryId } = await seedStory(world);
        seedSummaryDrafts(world, storyId, summaryId, [
            'She floods the valley on purpose.',
            'She leaves the valley standing.'
        ]);

        const reply = await call(world.app, 'POST', `/stories/${storyId}/revisions/revision_1/select`, {});

        expect(reply.status).toBe(200);

        // Nothing is invented: the reason is the very sentence P11 makes this commit carry, so the
        // rail states WHICH decision set the row aside without claiming an explanation the Author
        // never typed. `note` stays optional on the wire, so no author field turns mandatory.
        const decision = `the Author selected revision_1 for ${summaryId} (D-24, U-13)`;

        expect([
            ...new Set(
                world.store.journal
                    .filter((event) => event.commit_label === 'author_revision_select')
                    .map((event) => event.attribution.why)
            )
        ]).toEqual([decision]);
        expect(reasonOf(world.store.revisions.require('revision_0'))).toEqual({
            state: 'discarded',
            discard_reason: decision
        });
        // The winner's default note is untouched (L-13), so this change is invisible to that field.
        expect(world.store.revisions.require('revision_1').selection_note).toBe('selected by the Author (D-24)');
        // The Summary leg still keeps both rows, so the rail keeps its Revision 1…N (D-22's exception).
        expect(world.store.revisions.list().map((row) => row.id)).toEqual(['revision_0', 'revision_1']);
    });

    it('a hard-deleted Summary sample reconstructs with the journal reason, not an invented one (R3)', async () => {
        const world = makeApp();
        const { storyId, summaryId } = await seedStory(world);
        seedSummaryDrafts(world, storyId, summaryId, [
            'She floods the valley on purpose.',
            'She leaves the valley standing.'
        ]);

        // Phase ①'s truncation removes the loser outright (loop/engine.ts:1376), so the row only comes
        // back through `viewRevisions`; the delete's `attribution.why` is its only history.
        const truncation = 'sampling round 2 retired the Summary draft revision_1 (§6.6, D-36)';
        world.store.revisions.delete('revision_1', { run_ref: null, why: truncation });

        const view = (await call(world.app, 'GET', `/stories/${storyId}`)).body;

        expect({
            id: viewRow(view, 'revision_1').id,
            ...reasonOf(viewRow(view, 'revision_1')),
            body: viewRow(view, 'revision_1').body
        }).toEqual({
            id: 'revision_1',
            state: 'discarded',
            discard_reason: truncation,
            body: { fields: { ending: 'She leaves the valley standing.' } }
        });

        // The live row is untouched — reconstruction adds a reason to history, never to a draft.
        expect(reasonOf(viewRow(view, 'revision_0'))).toEqual({
            state: 'competing',
            discard_reason: undefined
        });
    });

    it('a reconstructed row keeps its own persisted reason rather than the delete wording (R3)', async () => {
        const world = makeApp();
        const { storyId, summaryId } = await seedStory(world);
        seedSummaryDrafts(world, storyId, summaryId, ['She floods the valley on purpose.', 'She leaves the valley.']);

        const editorReason = 'The Editor rejected it: nothing here answers the Seed.';

        world.store.revisions.update(
            'revision_1',
            { state: 'discarded', discard_reason: editorReason },
            { run_ref: null, why: 'fixture: the Editor rejected the draft' }
        );
        // A later prune deletes the row; its own wording must not overwrite the reason on the row.
        world.store.revisions.delete('revision_1', {
            run_ref: null,
            why: 'a later prune removed the discarded draft (D-22)'
        });

        expect(reasonOf(viewRow((await call(world.app, 'GET', `/stories/${storyId}`)).body, 'revision_1'))).toEqual({
            state: 'discarded',
            discard_reason: editorReason
        });
    });

    it('a legacy row with no reason still projects, and no blank reason is invented (R3)', async () => {
        const world = makeApp();
        const { storyId, summaryId } = await seedStory(world);
        seedSummaryDrafts(world, storyId, summaryId, ['She floods the valley on purpose.', 'She leaves the valley.']);

        // A row written before `discard_reason` existed. The store keeps records whole (store/store.ts
        // does not field-whitelist an update), so it simply carries no such key.
        world.store.revisions.update(
            'revision_1',
            { state: 'discarded' },
            { run_ref: null, why: 'fixture: legacy discard' }
        );

        const view = (await call(world.app, 'GET', `/stories/${storyId}`)).body;
        const legacy = viewRow(view, 'revision_1');

        expect(reasonOf(legacy)).toEqual({ state: 'discarded', discard_reason: undefined });
        // Absent, not empty: the rail shows no reason rather than a blank one.
        expect('discard_reason' in legacy).toBe(false);
        expect((view as { revisions: Revision[] }).revisions.map((row) => row.id)).toEqual([
            'revision_0',
            'revision_1'
        ]);
    });
});
