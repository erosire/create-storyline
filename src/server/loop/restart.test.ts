/**
 * Acceptance for restart — §12 row W5 ("kill the process mid-run and restart: nothing is lost, nothing
 * is doubled, and the abandoned run is released") plus L-3, S-3 and S-4a.
 *
 * The rig takes a store the caller built (`{store, attach: true}`), which is exactly the restarted
 * process: the rows, the claim keys and the journal ARE the state, so nothing has to be handed over.
 *
 * The crashed run is written by hand — a row left `running` with no in-flight handle — because that is
 * what a `SIGKILL` leaves behind: the executor's promise is gone, the store's row is not. Whether the
 * loop adopts it, abandons it, or re-dispatches its work is decided from the row's own `updated_at`,
 * which is the heartbeat S-4a names (no clock, no timeout).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Store } from '../store/store';
import { createRig, type Rig } from './mock';

/** The visible state of the book, as one object, so "nothing was lost" is a single comparison. */
function footprints(rig: Rig) {
    const story = rig.story();

    return {
        phase: story.phase,
        status: story.status,
        pending_kind: story.pending_kind,
        summary_locked: story.summary_locked,
        plotlines_locked: story.plotlines_locked,
        rounds: (story as { round?: number }).round ?? 0,
        chapters: rig.store.chapters.list().length,
        plotlines: rig.store.plotlines.list().length,
        verdicts: rig.store.verdicts.list().length,
        runs: rig.store.runs.list().length,
        digests: rig.store.digests.list().length
    };
}

/**
 * Leaves one run row `running` with no live owner — the crashed process's fingerprint — and returns its
 * Work Item key, which is the claim the next engine has to reason about (L-2).
 */
async function orphanRun(rig: Rig): Promise<{ runId: string; key: string }> {
    const store = rig.store;
    const run = store.runs.list().sort((left, right) => left.id.localeCompare(right.id))[0];
    const fresh = store.runs.require(run.id);

    await store.commit('simulate_crash', () => {
        // §4.5's live vocabulary is `spawning | working | reporting` (records.ts:489), and `working` is
        // what a mid-flight run row reads as. It is the state the lease check is about: a live row with
        // no live owner.
        store.runs.update(
            fresh.id,
            { state: 'working', ended_at: null, end_reason: '' },
            { run_ref: fresh.id, why: 'the process was killed while this run was in flight (W5)' },
            [{ id: fresh.id, rev: fresh.rev }]
        );
    });

    return { runId: run.id, key: run.work_item_ref ?? '' };
}

describe('W5 / L-3 — a restarted loop reads the same book', () => {
    let root = '';

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'loop-restart-'));
    });

    afterEach(async () => {
        // The store keeps a flush interval alive until `close()`, and a restart test holds two stores,
        // so a late flush can land while the directory is being removed. `Temp/` is disposable either
        // way, so the cleanup is best-effort rather than an assertion.
        await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
    });

    it('keeps every row the first engine wrote, and re-attaches to the same Story', async () => {
        const store = await Store.load(root);
        const first = await createRig({ store, story: { chapter_count: 1 } });

        // Sweep into phase ② so the reopened engine has rows in three collections to lose.
        await first.run();
        await first.engine.lockPhase(first.storyId, 'summary');
        await first.run();

        const before = footprints(first);

        expect({ phase: before.phase, plotlines: before.plotlines }).toEqual({ phase: 'plotlines', plotlines: 0 });

        await store.close();

        // The restarted process: a fresh Store over the same two files, a fresh engine, nothing passed
        // between them but the records (P1: the store is the memory).
        const reopened = await Store.load(root);
        const second = await createRig({ store: reopened, attach: true });

        expect(second.storyId).toBe(first.storyId);
        expect(footprints(second)).toEqual(before);

        // A restarted engine does not invent a Story, and it does not re-run what the rows already
        // record: the first sweep starts work, it does not replay history.
        const report = await second.step();

        expect(report.runs_started).toBeLessThanOrEqual(1);
        expect(second.store.runs.list().length).toBeGreaterThanOrEqual(before.runs);
    });

    it('releases the run the dead process left behind, and its work goes back to the queue once (L-3, S-3)', async () => {
        const store = await Store.load(root);
        const first = await createRig({ store, story: { chapter_count: 1 } });

        await first.run();

        const { key } = await orphanRun(first);

        await store.close();

        // The claim the orphan held is released at construction — `recover()` runs before the first
        // sweep, so the loop never waits on a session that died with the old process (L-3's "re-adopt or
        // abandon", and abandoning is the honest half: the harness is gone).
        const reopened = await Store.load(root);
        const second = await createRig({ store: reopened, attach: true });
        const report = await second.step();

        expect({
            state: second.store.runs.require(
                second.store.runs.list().sort((left, right) => left.id.localeCompare(right.id))[0].id
            ).state,
            started: report.stories[0].started
        }).toEqual({
            state: 'abandoned',
            started: []
        });

        // "Nothing is doubled" is the other half of the row, and the claim key is what makes it checkable:
        // the abandoned run's Work Item keeps its key, so any retry would land as another row naming the
        // same key rather than hiding in memory. The crew does NOT redo it — the work the dead run
        // finished is visible in the records it wrote (the Summary row and its verdict), which is L-3's
        // "the fresh run's work is visible in the records" clause rather than a memory of progress.
        const rows = second.store.runs.list().filter((run) => run.work_item_ref === key);

        expect(rows.map((run) => [run.state, run.end_reason ?? ''])).toEqual([
            ['abandoned', 'the engine restarted and this run had no owner in this process (L-3, S-4a)']
        ]);
    });

    it('a run whose owner goes quiet loses its lease, and the item returns to the queue (S-4a, D-36)', async () => {
        const store = await Store.load(root);
        const rig = await createRig({ store, story: { chapter_count: 1 }, leaseIdleMs: 1 });

        await rig.run();

        // A live row written while the engine is alive: nothing about a restart is involved, so the only
        // thing that can release it is S-4a's lease check. The heartbeat is the row's `updated_at`, which
        // the executor bumps on every transition, so a row nobody has touched for `leaseIdleMs` has a
        // dead owner — a record read, not a timer the process has to survive.
        const orphan = await store.commit('orphan_lease', () => {
            store.runs.create(
                {
                    story_id: rig.storyId,
                    work_item_ref: 'wi_write_summary_1_2_a2',
                    role: 'writer',
                    state: 'working',
                    started_at: new Date().toISOString(),
                    tokens: 0,
                    kind: 'work',
                    delegated: []
                },
                { run_ref: null, why: 'a run row whose owner stopped reporting (S-4a)' }
            );
        });

        void orphan;

        // Elapsed time only moves forward, so the wait makes the lapse deterministic without the test
        // depending on any particular timing.
        await new Promise((resolve) => setTimeout(resolve, 10));

        const next = await rig.step();
        const row = rig.store.runs
            .list()
            .filter((run) => run.work_item_ref === 'wi_write_summary_1_2_a2')
            .sort((left, right) => left.id.localeCompare(right.id))[0];

        // The report names the Work Item key, not the run row: what the caller cares about is which job
        // came back from the dead, and the key is what they would re-dispatch by.
        expect(next.leases_lapsed).toEqual(['wi_write_summary_1_2_a2']);
        expect({ state: row.state, end_reason: row.end_reason }).toEqual({
            state: 'abandoned',
            end_reason: 'the lease lapsed after 1ms of silence (S-4a, D-36)'
        });

        // The claim is gone, so the Work Item is dispatchable again on the sweep after this one.
        expect(rig.liveRuns()).not.toContain(row.id);
    });
});
