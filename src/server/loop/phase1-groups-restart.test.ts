/**
 * SUMMARY PHRASE at the RESTART and LEASE boundary (R2, R4, L-3, S-3, S-4a) — what happens to a group
 * Writer pass when the process that started it stops reporting.
 *
 * WHY THIS FILE EXISTS: `phase1-groups.test.ts` proves the hold is read from a persisted Run row while the
 * engine that wrote it is alive, and `restart.test.ts` proves the loop's restart and lease rules for the
 * whole-Summary pipeline. The combination is the case the redesign actually ships into: a group batch is a
 * claim on separately-addressed rows of book, so "did the restart lose the lock, double the pass, or
 * freeze the group?" is a question about `group_refs`, the claim FAMILY, and the per-group write allowance —
 * none of which the legacy restart rows touch.
 *
 * Pinned here, in the order the engine meets them:
 *
 *   1. the hold is a ROW, not a promise handle: the reopened store carries the live run and the group ids
 *      it locked BEFORE any engine has looked at it — that is what `phrase/exclusion.ts` reads, and what
 *      makes the Author's rail refuse a hand edit on a server that has just booted;
 *   2. L-3/S-3's honest half — the restarted engine ABANDONS that run (its owner died with the old
 *      process), so the groups are not locked forever by a pass that will never report, and the install it
 *      never made did not happen: the group's revision number is exactly what it was;
 *   3. the claim FAMILY keeps its identity (R2): the abandoned row keeps `_1`, the replacement is `_2`, and
 *      no key is dispatched twice — replaying a dead pass under its own key is how one text would be
 *      installed twice;
 *   4. F1's counter follows: a pass that died without installing IS an attempt against the current text,
 *      and the replacement's install resets the clock, so a crash costs a group one attempt and nothing
 *      else;
 *   5. S-4a/D-36 — a lease lapse releases EXACTLY the lapsed pass's groups: a sibling pass on a disjoint
 *      group is untouched, and the lapse report names one Work Item key. What the release does NOT buy,
 *      since D-66, is a pass over the freed group ALONE: a finding's group set is dispatched whole, so the
 *      set waits for the sibling's sweep and then answers BOTH groups in one pass. This row used to pin the
 *      opposite ("the resumed batch is cut around it"), which is the partial-fix bug D-66 removes — the
 *      book spent a round with one of two named groups rewritten.
 *
 * THE CRASH IS WRITTEN BY HAND, like `restart.test.ts:orphanRun` does it: the mock crew finishes a run
 * inside `sweep()`, so no amount of sweeping leaves a group pass live to be orphaned. A row left `working`
 * with no in-flight handle IS what a killed process leaves behind, and the loop decides from the row alone.
 *
 * Values were read off the rig (one probe per round trip), not guessed. `Store.load` on a real temp
 * directory is deliberate in the restart row: the claim is that the DISK holds the lock.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Store } from '../store/store';
import { generateWork, groupWriteAttempts, GROUP_WRITE_ATTEMPT_CAP } from './work';
import { createRig, seedFinding, seedTask } from './mock';
import { groupVectorHash } from '../phrase/revisions';
import { liveGroupRefs, liveGroupWriters } from '../phrase/exclusion';
import type { Rig } from './mock';
import type { PhraseGroup } from '../../shared/types';

/** The book's groups, in catalog order. */
const groupsOf = (rig: Rig): PhraseGroup[] => rig.store.phraseGroups.list();

/**
 * The claim FAMILY the planner builds for a set of groups (`loop/work.ts`): the group-vector hash at
 * revision 0, so one batch is a FAMILY and a restart reproduces it from the rows.
 */
const familyOf = (refs: string[]): string =>
    `wi_draft_groups_summary_0_${groupVectorHash(Object.fromEntries(refs.map((ref) => [ref, 0])))}`;

/** The `draft_groups` candidates the planner would offer this sweep, as `key: [group keys]`. */
const draftJobs = (rig: Rig) =>
    generateWork(rig.store, rig.story(), { at: new Date().toISOString(), phase: 'summary' })
        .filter((candidate) => candidate.item.kind === 'draft_groups')
        .map((candidate) => ({
            key: candidate.key,
            refs: (candidate.item.groupRefs ?? []).map((ref) => rig.store.phraseGroups.require(ref).key)
        }));

/** Every Run row of one claim family, as `key: state`, in id order — the "nothing doubled" check. */
const familyLedger = (rig: Rig, family: string) =>
    rig.store.runs
        .list()
        .filter((run) => (run.work_item_ref ?? '').startsWith(`${family}_`))
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((run) => `${run.work_item_ref}:${run.state}`);

/**
 * An Editor-approved defect scoped to the named groups, plus the open fix task that authorises the
 * rewrite — the state in which the loop wants a Writer pass over exactly those groups.
 */
const seedGroupFix = (rig: Rig, ...groupIds: string[]) => {
    const finding = seedFinding(rig.store, rig.storyId, {
        target_ref: 'summary_0',
        criterion_ref: 'C-14',
        cost: 'critical',
        state: 'approved',
        title: 'the groups contradict the Seed',
        detail: 'the Overview promises a cartographer; the Seed says the map was destroyed',
        fingerprint: 'C-14|summary_0'
    });

    rig.store.findings.update(
        finding.id,
        { group_refs: groupIds },
        { run_ref: null, author: true, why: 'seed: the deep review scoped this defect to these groups (R3)' },
        [{ id: finding.id, rev: finding.rev }]
    );
    seedTask(rig.store, rig.storyId, {
        kind: 'fix',
        title: 'pay the premise the Seed states',
        detail: 'C-14 on summary_0',
        owner_role: 'writer',
        finding_ref: finding.id
    });

    return finding;
};

/**
 * Leaves one group Writer pass live with no owner — the killed process's fingerprint — holding exactly
 * `groupIds`, and returns the row. Its claim key is the real family key at attempt 1, so the FAMILY is
 * what the restarted engine has to reason about, not an invented string.
 */
const orphanGroupPass = (store: Store, storyId: string, groupIds: string[]) =>
    store.runs.create(
        {
            story_id: storyId,
            work_item_ref: `${familyOf(groupIds)}_1`,
            role: 'writer',
            state: 'working',
            started_at: '2026-11-24T10:00:00.000Z',
            tokens: 0,
            kind: 'work',
            delegated: [],
            group_refs: groupIds
        },
        { run_ref: null, author: false, why: 'the process died while this group batch was in flight (L-3)' }
    );

describe('a group Writer pass survives a restart as a row, not as a lock (L-3, S-3, R2, R4)', () => {
    let root = '';

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'loop-groups-restart-'));
    });

    afterEach(async () => {
        // The store keeps a flush interval alive until `close()`, and this test holds two stores over one
        // directory, so the cleanup is best-effort (`Temp/` is disposable either way).
        await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
    });

    it('reopens with the hold on disk, abandons the dead pass once, and resumes the batch under the next attempt', async () => {
        const store = await Store.load(root);
        const first = await createRig({ store, summaryMode: 'groups', summarySampling: 5, summaryCritics: 1 });

        // Round 1 to quiescence: one pass wrote all five groups, the Critic seat and the deep review closed
        // against that vector. This is the state an Author leaves their server in.
        await first.run();

        expect(groupsOf(first).map((group) => [group.key, group.revision])).toEqual([
            ['premise', 1],
            ['promise', 1],
            ['theme', 1],
            ['tone', 1],
            ['ending', 1]
        ]);

        // The state a crash is caught in: the Editor has approved a premise defect, and a Writer pass over
        // that ONE group is in flight.
        const premise = groupsOf(first).find((group) => group.key === 'premise')!;
        const finding = seedGroupFix(first, premise.id);
        const inFlight = orphanGroupPass(first.store, first.storyId, [premise.id]);

        await store.close();

        const reopened = await Store.load(root);

        // THE HOLD IS ON DISK. Before any engine has read this store, the live row and the group ids it
        // locked are there — `liveGroupWriters` is the same read the Author's rail and the revise route
        // use, so a fresh server process already refuses a hand edit on `premise` (F8, R4).
        const persisted = reopened.runs.require(inFlight.id);

        expect({ state: persisted.state, group_refs: persisted.group_refs, work_item_ref: persisted.work_item_ref }).toEqual({
            state: 'working',
            group_refs: [premise.id],
            work_item_ref: `${familyOf([premise.id])}_1`
        });
        expect(liveGroupRefs(reopened, first.storyId).size).toBe(1);
        expect(liveGroupWriters(reopened, first.storyId, premise.id).map((run) => run.id)).toEqual([inFlight.id]);

        // And the dead pass had installed nothing: the group's number is what the last ACCEPTED revision
        // wrote, so the text the Author reads on the way back up is not a half-written answer (P1).
        expect(reopened.phraseGroups.require(premise.id).revision).toBe(1);

        // The restarted process: a fresh engine over the same two files, nothing handed over but records.
        const second = await createRig({ store: reopened, attach: true });

        // L-3/S-3's honest half: `recover()` ran in the constructor and abandoned the dead pass, so its
        // groups are no longer held by a run that will never report.
        const abandoned = second.store.runs.require(inFlight.id);

        expect({ state: abandoned.state, end_reason: abandoned.end_reason }).toEqual({
            state: 'abandoned',
            end_reason: 'the engine restarted and this run had no owner in this process (L-3, S-4a)'
        });
        expect(liveGroupWriters(second.store, second.storyId, premise.id)).toEqual([]);

        // The batch is wanted again, and it is the SAME batch: the one group that owes the finding, not the
        // whole Overview. A restart that fell back to "rewrite all five" would discard the four groups the
        // dead pass never touched (R2).
        expect(draftJobs(second)).toEqual([{ key: `${familyOf([premise.id])}_2`, refs: ['premise'] }]);

        // F1's counter, read at the boundary: the abandoned pass IS an attempt against the current text (it
        // started after that text was installed and wrote nothing), while the four groups nobody touched
        // still hold their full allowance. One dead pass is not a freeze: the cap is 2.
        expect(groupWriteAttempts(second.store, second.story(), premise)).toBe(1);
        expect(GROUP_WRITE_ATTEMPT_CAP).toBe(2);
        expect(
            groupsOf(second)
                .filter((group) => group.key !== 'premise')
                .map((group) => groupWriteAttempts(second.store, second.story(), group))
        ).toEqual([0, 0, 0, 0]);

        // The defect survived the crash as the work it was: approved, scoped, unclaimed.
        expect(second.store.findings.require(finding.id)).toMatchObject({ state: 'approved', group_refs: [premise.id] });

        // One step: the replacement pass runs and settles.
        await second.step();

        // THE LEDGER, which is where "nothing is doubled" is decided. The dead pass keeps its key, the
        // replacement is the family's NEXT attempt, and no key appears twice — replaying `_1` would install
        // the same text twice and move the group's number for an answer nobody read.
        expect(familyLedger(second, familyOf([premise.id]))).toEqual([
            `${familyOf([premise.id])}_1:abandoned`,
            `${familyOf([premise.id])}_2:torn_down`
        ]);

        // The resumed pass installed: premise at 2, the other four untouched at 1 (R2), and premise's write
        // clock restarted on the NEW text (F1) — the crash cost that group one attempt and nothing else.
        expect(groupsOf(second).map((group) => [group.key, group.revision])).toEqual([
            ['premise', 2],
            ['promise', 1],
            ['theme', 1],
            ['tone', 1],
            ['ending', 1]
        ]);
        expect(groupWriteAttempts(second.store, second.story(), premise)).toBe(0);
    });
});

describe('a lapsed group lease releases exactly its own groups (S-4a, D-36, R4)', () => {
    it('abandons the lapsed pass, holds the finding’s WHOLE set until the sibling reports, then answers it in one pass', async () => {
        // TWO threads, deliberately: R4 lets one Story run several group Writer passes at once, because a
        // pass holds GROUPS and not the Summary unit, so the two passes below are legal company. With the
        // loop's default single thread, the sibling would occupy it and the replacement would simply wait
        // (the restart row above already pins the sequence when the thread is busy).
        const rig = await createRig({
            summaryMode: 'groups',
            summarySampling: 5,
            summaryCritics: 1,
            globalMaxConcurrent: 2,
            // A lease window wide enough that the sibling — written AFTER the wait, so its `updated_at` is
            // the freshest row in the book — cannot lapse, while the dead pass (untouched since before the
            // wait) must. Elapsed time only moves forward, so the wait makes the lapse deterministic
            // without the test depending on any particular scheduling: 600ms of silence, 500ms window.
            leaseIdleMs: 500
        });

        await rig.run();

        const [premise, promise, theme, tone, ending] = groupsOf(rig);

        // The dead pass was writing premise; a SECOND pass, on a DISJOINT group, is writing tone. Together
        // they hold every group the approved finding names — which is why nothing is offered at all until
        // one of them stops reporting (R4's exclusion, not a scheduling accident).
        const finding = seedGroupFix(rig, premise.id, tone.id);

        const dead = orphanGroupPass(rig.store, rig.storyId, [premise.id]);

        await new Promise((resolve) => setTimeout(resolve, 600));

        const alive = rig.store.runs.create(
            {
                story_id: rig.storyId,
                work_item_ref: `${familyOf([tone.id])}_1`,
                role: 'writer',
                state: 'working',
                started_at: new Date().toISOString(),
                tokens: 0,
                kind: 'work',
                delegated: [],
                group_refs: [tone.id]
            },
            { run_ref: null, author: false, why: 'seed: a second group pass, still reporting (R4)' }
        );

        // Both groups the finding names are held, so the planner offers NOTHING — the fix is owed and still
        // cannot be dispatched, which is R4's exclusion working, not a queueing accident.
        expect(draftJobs(rig)).toEqual([]);

        const report = await rig.step();

        // The report names WORK ITEM KEYS, and only the dead one: the lapse is a per-run decision from the
        // row's own heartbeat, so a reporting sibling is not collateral damage.
        expect(report.leases_lapsed).toEqual([`${familyOf([premise.id])}_1`]);

        const lapsed = rig.store.runs.require(dead.id);

        expect({ state: lapsed.state, end_reason: lapsed.end_reason }).toEqual({
            state: 'abandoned',
            end_reason: 'the lease lapsed after 500ms of silence (S-4a, D-36)'
        });

        // The sibling is still live, still holding tone, and its claim is untouched.
        expect(rig.liveRuns()).toContain(alive.id);
        expect(rig.store.runs.require(alive.id)).toMatchObject({ state: 'working', group_refs: [tone.id] });
        expect(liveGroupWriters(rig.store, rig.storyId, tone.id).map((run) => run.id)).toEqual([alive.id]);

        // D-66 — WHERE THE REDESIGN CHANGES THE LEASE STORY. The lapse freed premise, and premise alone
        // would have been a legal batch before: R4's exclusion reads groups, and premise has no holder now.
        // But the defect names premise AND tone, and a pass over premise only would answer HALF of it. So
        // the set is withheld WHOLE until tone's holder reports: nothing starts this sweep. The race R4
        // removes is still decided by rows' `group_refs`, and D-66 adds that a finding's set is cut around
        // a live pass only by WAITING for it, never by dropping a group.
        expect(report.stories[0].started).toEqual([]);

        // THE LEDGER at the lapse: the lapsed pass keeps its key and stays `abandoned`, the live sibling's
        // family gained nothing, and the pair family the finding will actually be served by does not exist
        // yet — so a replay of this sweep cannot double the pass either (L-3).
        expect(familyLedger(rig, familyOf([premise.id]))).toEqual([`${familyOf([premise.id])}_1:abandoned`]);
        expect(familyLedger(rig, familyOf([tone.id]))).toEqual([`${familyOf([tone.id])}_1:working`]);
        expect(familyLedger(rig, familyOf([premise.id, tone.id]))).toEqual([]);

        // A lapse moves no number: premise still sits on the round-1 text. It is NOT a free pass either —
        // the dead pass counts as an attempt against the current text (F1), which is what stops a crash from
        // buying an endless line of rewrites.
        expect(groupsOf(rig).map((group) => [group.key, group.revision])).toEqual([
            ['premise', 1],
            ['promise', 1],
            ['theme', 1],
            ['tone', 1],
            ['ending', 1]
        ]);
        expect(groupWriteAttempts(rig.store, rig.story(), premise)).toBe(1);
        expect(groupWriteAttempts(rig.store, rig.story(), tone)).toBe(0);

        // The sibling reports. A hand-seeded row has no in-flight handle to close it, so the test retires it
        // the way `phase1-groups-drain.test.ts` does, and the moment tone is free the WHOLE set is on offer —
        // under the PAIR's family key, one attempt, both groups.
        const sibling = rig.store.runs.require(alive.id);

        rig.store.runs.update(
            alive.id,
            { state: 'torn_down', ended_at: '2026-11-24T10:00:03.000Z' },
            { run_ref: null, author: true, why: 'seed: the sibling pass reported and released tone (R4)' },
            [{ id: sibling.id, rev: sibling.rev }]
        );

        const pair = familyOf([premise.id, tone.id]);

        expect(draftJobs(rig)).toEqual([{ key: `${pair}_1`, refs: ['premise', 'tone'] }]);

        const resumed = await rig.step();

        expect(resumed.stories[0].started).toEqual([`${pair}_1`]);

        const replacement = rig.store.runs.list().find((run) => run.work_item_ref === `${pair}_1`)!;

        expect(replacement.group_refs).toEqual([premise.id, tone.id]);

        // BOTH groups move on the same settle, and the two that no finding named keep their round-1 text
        // (R2's independence is untouched). Each write clock restarts on the new text (F1): the crash cost
        // premise one attempt and nothing else.
        expect(groupsOf(rig).map((group) => [group.key, group.revision])).toEqual([
            ['premise', 2],
            ['promise', 1],
            ['theme', 1],
            ['tone', 2],
            ['ending', 1]
        ]);
        expect(groupWriteAttempts(rig.store, rig.story(), premise)).toBe(0);
        expect(groupWriteAttempts(rig.store, rig.story(), tone)).toBe(0);

        // THE POINT OF THE RULE: the defect is answered by the one pass, on the sweep it lands — there was
        // never a sweep in which the Author's book showed this finding as half-fixed.
        expect(rig.store.findings.require(finding.id).state).toBe('fixed');

        // THE LEDGER, finally: one lapse, one replacement, one closed sibling, no doubled pass, and the pair
        // family carries the single pass that answered the defect.
        expect(familyLedger(rig, familyOf([premise.id]))).toEqual([`${familyOf([premise.id])}_1:abandoned`]);
        expect(familyLedger(rig, familyOf([tone.id]))).toEqual([`${familyOf([tone.id])}_1:torn_down`]);
        expect(familyLedger(rig, pair)).toEqual([`${pair}_1:torn_down`]);

        // And no group has a live holder, so a hand edit is accepted on both — the SAME read the route
        // gives (F8), which the pair pass released together rather than one at a time.
        expect(liveGroupWriters(rig.store, rig.storyId, premise.id)).toEqual([]);
        expect(liveGroupWriters(rig.store, rig.storyId, tone.id)).toEqual([]);

        // The two groups no finding named never moved at all.
        expect([promise, theme, ending].map((group) => rig.store.phraseGroups.require(group.id).revision)).toEqual([1, 1, 1]);
    });
});
