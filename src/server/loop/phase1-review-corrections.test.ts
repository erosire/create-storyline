// T10 — the backend review findings about phase ①'s review half (F2, F3, F4, and the T8 deep-review
// deadlock). Each row below is the state the reviewer could reach, and the assertion is what the RULE
// requires rather than what the code emitted:
//
//   F2   ONE escalation per finding. Findings come from one counter, so `finding_1` is a text prefix of
//        `finding_10`; the reuse key `"<prefix> <id>"` let finding_10's question borrow finding_1's row
//        (or lose its own), so two stalled findings asked one question about the wrong finding.
//   F3   The Author is asked only after the last bought pass has CLOSED. The verify cap counts
//        DISPATCHED passes, so the budget is spent the moment the final run opens — asking over the head
//        of an Editor run that has not answered yet turns a decision that is about to land into a
//        question the Author has to clean up.
//   F4   A resolved Phase-① stall row closes even after the Story has left phase ①. Opening is
//        phase-scoped (`records.ts:findingsVerifyStalled` answers `[]` outside phase ①); the CLOSE half
//        is not, or a `blocked` row the Author already answered keeps every later phase in "the crew
//        asked you" and the drain can never be met.
//   T8   The deep review is owed for the CURRENT round's selection — the same condition the work queue
//        dispatches on. An Author who selects an older-round draft was owed `summary_critics` passes the
//        queue would never offer: an un-payable debt in the drain and a sign-off that waits forever.
//
// Nothing here re-derives the pipeline: each case starts from the rig's own completed round, so the
// rows the assertions read were written by the loop.
import { describe, expect, it } from 'vitest';

import { createRig, seedFinding, seedTask } from './mock';
import { generateWork, openFindingVerifyStallTask } from './work';
import { drainPreconditions } from './status';
import {
    deepReviewComplete,
    deepReviewPassesOwed,
    findingsVerifyStalled,
    isDeepReviewSelection,
    samplingRoundOf,
    selectedSummaryRevision
} from './records';
import type { Rig } from './mock';
import type { Finding, Story } from '../../shared/types';

/** The queue as `id:kind:state`, oldest first — an escalation is a row, so it is asserted as one. */
function taskRows(rig: Rig): string[] {
    return rig.store.tasks
        .list()
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((task) => `${task.id}:${task.kind}:${task.state}`);
}

/** The escalation rows' finding refs, in id order — which finding each question is actually about. */
function escalationRefs(rig: Rig): string[] {
    return rig.store.tasks
        .list()
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((task) => `${task.kind}:${task.state}:${task.finding_ref ?? 'none'}`);
}

/** Every run row as its claim key, in clock order (ids are a counter: `run_10` sorts before `run_2`). */
function runKeys(rig: Rig, prefix = ''): string[] {
    return rig.store.runs
        .list()
        .filter((run) => (run.work_item_ref ?? '').startsWith(prefix))
        .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id))
        .map((run) => run.work_item_ref ?? run.id);
}

function storyOf(rig: Rig): Story {
    return rig.store.stories.require(rig.storyId);
}

function summaryOf(rig: Rig) {
    const summary = rig.store.summaries.list().find((row) => row.story_id === rig.storyId);

    if (summary === undefined) throw new Error('the rig has no Summary row');

    return summary;
}

function carriedOf(rig: Rig, why: string) {
    const selected = selectedSummaryRevision(rig.store, rig.storyId);

    if (selected === undefined) throw new Error(`no selected Summary revision (${why})`);

    return selected;
}

/** The offers the sweep would make right now — dispatch and the owed-count must agree, so both read here. */
function offers(rig: Rig): string[] {
    // `generateWork` is a pure read of the rows, exactly as the sweep calls it.
    return generateWork(rig.store, storyOf(rig), { at: new Date().toISOString(), phase: 'summary' }).map(
        (candidate) => candidate.key
    );
}

/** A finding the way phase ① files one: the Summary row as target, the draft it read in `related_refs`. */
function seedSummaryFinding(
    rig: Rig,
    input: { fingerprint: string; cost: 'critical' | 'major'; state: Finding['state']; refs: string[] }
) {
    return seedFinding(rig.store, rig.storyId, {
        target_ref: summaryOf(rig).id,
        criterion_ref: 'C-14',
        cost: input.cost,
        state: input.state,
        fingerprint: input.fingerprint,
        related_refs: input.refs
    });
}

/**
 * One run row in a finding's anchored verify family (§16.1's `wi_verify_finding_<id>_<n>`).
 *
 * The rows are seeded rather than swept so the test controls WHICH point in the budget it is asking
 * about — `working` is the last bought pass mid-flight, `torn_down` is the same pass having closed
 * without deciding (the crew's `verifyReports: 'silent'` answer).
 */
function seedVerifyRun(rig: Rig, key: string, state: 'torn_down' | 'working'): void {
    const at = new Date().toISOString();

    rig.store.runs.create(
        {
            story_id: rig.storyId,
            work_item_ref: key,
            role: 'editor',
            state,
            started_at: at,
            ended_at: state === 'working' ? null : at,
            tokens: 0,
            kind: 'work',
            no_op: false,
            delegated: []
        },
        { run_ref: null, why: `seed: one Editor verification pass ${key} in the finding's family (D-33)` }
    );
}

/** Sends one finding to the end of its budget with `live` deciding whether the last pass is still running. */
function exhaustVerifyFamily(rig: Rig, findingId: string, live: boolean): void {
    for (let pass = 1; pass <= 4; pass += 1)
        seedVerifyRun(rig, `wi_verify_finding_${findingId}_${pass}`, live && pass === 4 ? 'working' : 'torn_down');
}

/**
 * Runs a rig through round 1 and then round 2 (an approved finding on the carried draft and its fix
 * task arm the refinement round, §16.7), so the Story carries a SECOND-round selection with an older
 * round's draft still on the ledger.
 */
async function twoRounds(rig: Rig): Promise<{ first: string; second: string }> {
    await rig.run();

    const first = carriedOf(rig, 'round 1 selection');

    seedFinding(rig.store, rig.storyId, {
        target_ref: summaryOf(rig).id,
        criterion_ref: 'C-14',
        cost: 'major',
        state: 'approved',
        fingerprint: 'C-14|arm',
        related_refs: [first.id]
    });
    seedTask(rig.store, rig.storyId, {
        kind: 'fix',
        title: 'fix major: the ending does not pay the promise',
        detail: `C-14 on ${summaryOf(rig).id} · ${summaryOf(rig).id}`,
        owner_role: 'writer',
        finding_ref: rig.store.findings.list()[0].id
    });

    await rig.run();

    return { first: first.id, second: carriedOf(rig, 'round 2 selection').id };
}

describe('T10/F2 — one stalled finding, one escalation, whatever the id prefixes', () => {
    /**
     * Eleven findings, so `finding_1` and `finding_10` both exist: the collision needs the counter, and
     * the counter is the only thing that ever produced these ids. ZERO-BASED ids (W1) start at
     * `finding_0`, so eleven rows are what it takes to reach the `_1`/`_10` pair this rule is about.
     */
    function seedElevenFindings(rig: Rig): string[] {
        return Array.from({ length: 11 }, (_, index) =>
            seedFinding(rig.store, rig.storyId, {
                target_ref: summaryOf(rig).id,
                criterion_ref: 'C-14',
                cost: 'major',
                state: 'unconfirmed',
                fingerprint: `C-14|finding-${index + 1}`
            }).id
        );
    }

    it('gives finding_10 its own row when finding_10 escalates first', async () => {
        const rig = await createRig({ summarySampling: 1, summaryCritics: 1 });
        const ids = seedElevenFindings(rig);

        expect(ids).toEqual(Array.from({ length: 11 }, (_, index) => `finding_${index}`));

        // Both findings have spent their anchored budgets, so BOTH are stalled lists — the queue and the
        // escalation read the same predicate (`records.ts:findingsVerifyStalled`).
        exhaustVerifyFamily(rig, 'finding_1', false);
        exhaustVerifyFamily(rig, 'finding_10', false);

        expect(findingsVerifyStalled(rig.store, storyOf(rig)).map((finding) => finding.id)).toEqual([
            'finding_1',
            'finding_10'
        ]);

        // finding_10 FIRST: its title begins `… for finding finding_10 —`, which the old unanchored
        // reuse prefix `… for finding finding_1` also matched, so finding_1 borrowed that row and never
        // got a question of its own.
        openFindingVerifyStallTask(rig.store, storyOf(rig), rig.store.findings.require('finding_10'));
        openFindingVerifyStallTask(rig.store, storyOf(rig), rig.store.findings.require('finding_1'));

        expect(taskRows(rig)).toEqual(['task_0:escalation:blocked', 'task_1:escalation:blocked']);
        expect(escalationRefs(rig)).toEqual([
            'escalation:blocked:finding_10',
            'escalation:blocked:finding_1'
        ]);

        // A repeat of either sweep call re-finds ITS OWN row — idempotent per finding, not per prefix.
        openFindingVerifyStallTask(rig.store, storyOf(rig), rig.store.findings.require('finding_10'));
        openFindingVerifyStallTask(rig.store, storyOf(rig), rig.store.findings.require('finding_1'));

        expect(taskRows(rig)).toEqual(['task_0:escalation:blocked', 'task_1:escalation:blocked']);
    });

    it('gives each finding its own row when finding_1 escalates first (the other order)', async () => {
        const rig = await createRig({ summarySampling: 1, summaryCritics: 1 });

        seedElevenFindings(rig);
        exhaustVerifyFamily(rig, 'finding_1', false);
        exhaustVerifyFamily(rig, 'finding_10', false);

        openFindingVerifyStallTask(rig.store, storyOf(rig), rig.store.findings.require('finding_1'));
        openFindingVerifyStallTask(rig.store, storyOf(rig), rig.store.findings.require('finding_10'));

        expect(escalationRefs(rig)).toEqual([
            'escalation:blocked:finding_1',
            'escalation:blocked:finding_10'
        ]);
        // The titles say which finding each row is about, so the Author can answer the right one.
        expect(
            rig.store.tasks
                .list()
                .sort((left, right) => left.id.localeCompare(right.id))
                .map((task) => (task.title ?? '').slice(0, 70))
        ).toEqual([
            'Phase ① verification undecided for finding finding_1 — the Editor was ',
            'Phase ① verification undecided for finding finding_10 — the Editor was'
        ]);
    });
});

describe('T10/F3 — the Author is asked only after the last bought pass has closed', () => {
    it('holds the escalation while the final verification pass is live, and opens it once it closes', async () => {
        const rig = await createRig({ summarySampling: 1, summaryCritics: 1 });

        await rig.run();

        const finding = seedSummaryFinding(rig, {
            fingerprint: 'C-14|in-flight',
            cost: 'critical',
            state: 'unconfirmed',
            refs: [carriedOf(rig, 'a finding under its last pass').id]
        });

        // The budget is spent — 4 passes — but the last one is still running: the Editor may be about to
        // answer this exact finding, and the cap counts dispatches, not decisions.
        exhaustVerifyFamily(rig, finding.id, true);

        expect(findingsVerifyStalled(rig.store, storyOf(rig))).toEqual([]);

        await rig.step();

        // No question yet, and no fifth pass bought for a finding whose budget is spent: the Story is
        // simply still waiting on the crew, which is the honest state.
        expect(taskRows(rig)).toEqual([]);
        expect(findingsVerifyStalled(rig.store, storyOf(rig))).toEqual([]);
        expect(runKeys(rig, 'wi_verify_')).toEqual([
            'wi_verify_finding_finding_0_1',
            'wi_verify_finding_finding_0_2',
            'wi_verify_finding_finding_0_3',
            'wi_verify_finding_finding_0_4'
        ]);

        // The bought pass closes WITHOUT deciding (the `verifyReports: 'silent'` answer). Now, and only
        // now, is there a fact of the matter to take to the Author.
        const liveRun = rig.store.runs
            .list()
            .find((run) => run.work_item_ref === 'wi_verify_finding_finding_0_4');

        if (liveRun === undefined) throw new Error('the last bought verification pass has no run row');

        rig.store.runs.update(
            liveRun.id,
            { state: 'torn_down', ended_at: new Date().toISOString() },
            { run_ref: liveRun.id, why: 'test: the final verification pass closed without deciding (D-33)' }
        );

        await rig.step();

        expect(taskRows(rig)).toEqual(['task_0:escalation:blocked']);
        expect(escalationRefs(rig)).toEqual(['escalation:blocked:finding_0']);
        expect(findingsVerifyStalled(rig.store, storyOf(rig)).map((row) => row.id)).toEqual(['finding_0']);

        const story = storyOf(rig);

        expect(story.pending_kind).toBe('drained');
        expect(story.status_reason).toContain('the crew asked you');
        expect(drainPreconditions(rig.store, story)).toEqual({
            met: false,
            unmet: ['1 finding still unconfirmed (D-33)']
        });
    });

    it('lets a valid final Editor decision resolve the finding with no escalation at all', async () => {
        const rig = await createRig({ summarySampling: 1, summaryCritics: 1 });

        await rig.run();

        const finding = seedSummaryFinding(rig, {
            fingerprint: 'C-14|last-pass',
            cost: 'critical',
            state: 'unconfirmed',
            refs: [carriedOf(rig, 'a finding on its last pass').id]
        });

        exhaustVerifyFamily(rig, finding.id, true);

        // The Editor answers on that last bought pass — `verifyFinding` confirms it — before the sweep
        // ever gets a chance to escalate.
        rig.store.findings.update(
            finding.id,
            { state: 'confirmed' },
            { run_ref: null, why: 'test: the Editor answered on the final pass (D-33)' }
        );

        for (let sweep = 0; sweep < 3; sweep += 1) await rig.step();

        // No question was ever asked: the crew's last pass answered the finding, and the dial covered the
        // cost, so the loop approved it on the spot and queued the fix work (D-35/D-34) — the queue moved
        // on instead of stopping to ask the Author.
        expect(rig.store.tasks.list().filter((task) => task.kind === 'escalation')).toEqual([]);
        expect(taskRows(rig)).toEqual(['task_0:fix:open']);
        expect(findingsVerifyStalled(rig.store, storyOf(rig))).toEqual([]);
        expect(rig.store.findings.require(finding.id).state).toBe('approved');
    });
});

describe('T10/F4 — a resolved Phase-① stall row closes after the phase advances', () => {
    it('closes the blocked question once the Story has left phase ①, so later phases can drain', async () => {
        const rig = await createRig({ summarySampling: 1, summaryCritics: 1, crew: { verifyReports: 'silent' } });

        await rig.run();

        seedSummaryFinding(rig, {
            fingerprint: 'C-14|cross-phase',
            cost: 'critical',
            state: 'unconfirmed',
            refs: [carriedOf(rig, 'the cross-phase row').id]
        });

        // Phase ① spends the budget and opens the Author's question (the R2d shape this file builds on).
        for (let sweep = 0; sweep < 8; sweep += 1) await rig.step();

        expect(taskRows(rig)).toEqual(['task_0:escalation:blocked']);
        expect(storyOf(rig).pending_kind).toBe('drained');

        // The Author discards the defect, and the Summary is locked — the phase advance is what the
        // Author's lock does (§15 step 5), so the row now belongs to a phase the Story has left.
        rig.store.findings.update(
            'finding_0',
            { state: 'discarded' },
            { run_ref: null, why: 'test: the Author dismissed the defect (D-33)' }
        );
        rig.store.stories.update(
            rig.storyId,
            { phase: 'plotlines' },
            { run_ref: null, why: 'test: the Author locked phase ① (§15 step 5)' }
        );

        expect(storyOf(rig).phase).toBe('plotlines');
        expect(taskRows(rig)).toEqual(['task_0:escalation:blocked']);

        await rig.step();

        // The close half of the sweep still runs outside phase ①: the row is `done`, no `blocked`
        // escalation survives, and the Story is not held in "the crew asked you" by a Phase-① question.
        expect(taskRows(rig)).toEqual(['task_0:escalation:done']);
        expect(
            rig.store.tasks.list().filter((task) => task.kind === 'escalation' && task.state === 'blocked')
        ).toEqual([]);
        expect(storyOf(rig).status_reason ?? '').not.toContain('the crew asked you');
        // Opening stays Phase-1-only: a later phase never gets a new one of these rows.
        expect(findingsVerifyStalled(rig.store, storyOf(rig))).toEqual([]);
    });
});

describe('T8 — the deep review is owed for the current round’s selection only', () => {
    it('owes every configured pass for a fresh current-round selection, and none for an older-round one', async () => {
        const rig = await createRig({ summarySampling: 1, summaryCritics: 2 });

        const { first, second } = await twoRounds(rig);

        expect(storyOf(rig).sampling_round).toBe(2);
        expect(samplingRoundOf(storyOf(rig))).toBe(3);
        expect(carriedOf(rig, 'the round 2 selection').id).toBe(second);

        // Take the review ledger back to "nobody has reviewed it" — the fresh-selection state, for both
        // rounds' drafts. Two run deletes, and the two predicates under test are all that is left.
        for (const run of rig.store.runs.list().filter((row) => (row.work_item_ref ?? '').startsWith('wi_review_')))
            rig.store.runs.delete(run.id, { run_ref: null, why: 'test: the deep review has not run yet (§6.4 step 6)' });

        // (a) The carried draft IS the current round's selection: it owes all `summary_critics` passes,
        // and the queue offers exactly those keys.
        const current = rig.store.revisions.require(second);

        expect(isDeepReviewSelection(storyOf(rig), current)).toBe(true);
        expect(deepReviewPassesOwed(rig.store, storyOf(rig), current)).toBe(2);
        expect(deepReviewComplete(rig.store, storyOf(rig), current)).toBe(false);
        expect(offers(rig).filter((key) => key.startsWith('wi_review_'))).toEqual([
            'wi_review_revision_1_a1',
            'wi_review_revision_1_a2'
        ]);
        expect(drainPreconditions(rig.store, storyOf(rig)).unmet).toContain(
            '2 deep-review passes still owed for the selected Summary revision (§6.4 step 6)'
        );

        // (b) The Author overrides the selection with the OLDER round's draft — the Summary pane can
        // select any draft of the Story. Generation offers no pass for it (that was already true), so
        // the ledger must stop owing them too, or the drain names work the loop can never dispatch and
        // the sign-off waits forever.
        rig.store.revisions.update(
            second,
            { state: 'discarded' },
            { run_ref: null, why: 'test: the Author stopped carrying round 2’s draft' }
        );
        rig.store.revisions.update(
            first,
            { state: 'selected' },
            { run_ref: null, why: 'test: the Author selected round 1’s draft' }
        );

        const older = rig.store.revisions.require(first);

        expect(selectedSummaryRevision(rig.store, rig.storyId)?.id).toBe(first);
        expect(isDeepReviewSelection(storyOf(rig), older)).toBe(false);
        expect(deepReviewPassesOwed(rig.store, storyOf(rig), older)).toBe(0);
        expect(deepReviewComplete(rig.store, storyOf(rig), older)).toBe(true);
        expect(offers(rig).filter((key) => key.startsWith('wi_review_'))).toEqual([]);
        expect(drainPreconditions(rig.store, storyOf(rig)).unmet).not.toContain(
            '2 deep-review passes still owed for the selected Summary revision (§6.4 step 6)'
        );
    });
});
