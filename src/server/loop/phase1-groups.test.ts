/**
 * SUMMARY PHRASE at the LOOP layer (R2, R4, R5, R6) — the group pipeline as the engine BOOKS it, as the
 * Run row HOLDS it, and as `settleJob` INSTALLS it, on the mock crew rig.
 *
 * `src/server/phrase/*.test.ts` proves the domain rules and `api/phrase-routes.test.ts` proves the
 * Author's surface. Only this file can prove the runtime behaviour the redesign is about:
 *
 *   1. R5 — a group-managed book dispatches a `draft_groups` run and never a `sample_unit` or
 *      `screen_samples` one: the whole-Summary sampler is off this path, not merely deprioritised;
 *   2. R2 — the batch is cut at the Author's `summary_sampling` dial (the same knob phase ① always had),
 *      in catalog order, and the claim key addresses the GROUP SET (`wi_draft_groups_<summaryRef>_
 *      <group-vector hash>_<attempt>`), so a restart reproduces the family from the rows;
 *   3. R2/R6 — an accepted answer installs on settle: one Group Revision per group, `run_ref` on the
 *      rows, the Overview mirror rewritten from the same commit, the groups outside the batch untouched,
 *      and NO competing `Revision` row created at all (there is nothing left to select);
 *   4. R4 — the hold is read from a PERSISTED live Run row: with a Writer holding three groups, the
 *      planner's next batch is the two groups nobody holds;
 *   5. R3/R5 — the structured review re-arms on the GROUP VECTOR: one `review_groups` seat per
 *      `summary_critics`, keyed `wi_review_groups_<vectorHash>_<pass>`, reading every group.
 *
 * Group ids are uid addresses, so they are read from the book; the hashes are recomputed with the same
 * helpers the planner uses (`phrase/revisions.ts`), never hardcoded. Values were read off the rig (one
 * sweep per round trip), not guessed.
 */
import { describe, expect, it } from 'vitest';

// F1/F3 — `groupWriteAttempts` is exported precisely so a test (and the Author's rail) can read the
// number the batch gate branches on, instead of inferring it from which candidates appeared.
import { generateWork, groupWriteAttempts, GROUP_WRITE_ATTEMPT_CAP } from './work';
import { isLiveRun } from './records';
import { createRig, seedFinding, seedTask } from './mock';
import { groupRevisionVector, groupVectorHash } from '../phrase/revisions';
import type { Rig } from './mock';
import type { Finding, PhraseGroup, Task } from '../../shared/types';

/** The candidate list the planner would offer this sweep — the same call `engine.sweep()` makes. */
const candidates = (rig: Rig) =>
    generateWork(rig.store, rig.story(), { at: new Date().toISOString(), phase: 'summary' });

/** The book's groups in catalog order. */
const groupsOf = (rig: Rig): PhraseGroup[] => rig.store.phraseGroups.list();

/**
 * The claim FAMILY the planner builds for a set of groups (`work.ts:1064`): the group-vector hash at
 * revision 0, so a batch is a claim FAMILY and a restart reproduces it from the rows.
 */
const familyOf = (refs: string[]) =>
    `wi_draft_groups_summary_0_${groupVectorHash(Object.fromEntries(refs.map((ref) => [ref, 0])))}`;

/** The group Writer candidates, with the claim key and ledger line the planner built for them. */
const groupJobs = (rig: Rig) =>
    candidates(rig)
        .filter((job) => job.item.kind === 'draft_groups')
        .map((job) => ({ key: job.key, refs: job.item.groupRefs ?? [], why: job.why, toolMode: job.item.toolMode }));

/** The Critic seats, same shape: the seat's claim key is what makes it reproducible across a restart. */
const reviewSeats = (rig: Rig) =>
    candidates(rig)
        .filter((job) => job.item.kind === 'review_groups')
        .map((job) => ({ key: job.key, refs: job.item.groupRefs ?? [], why: job.why }));

/**
 * The Writer allowance each group has spent, as `key: attempts` in catalog order — the number the batch
 * gate branches on (`work.ts:GROUP_WRITE_ATTEMPT_CAP`), read from the exported counter rather than
 * inferred from which candidates showed up.
 */
const attemptsOf = (rig: Rig): string[] =>
    groupsOf(rig).map((group) => `${group.key}: ${groupWriteAttempts(rig.store, rig.story(), group)}`);

/** The `draft_groups` candidates, with the attribution a FIX batch has to carry (R3's anchor). */
const fixBatches = (rig: Rig) =>
    candidates(rig)
        .filter((job) => job.item.kind === 'draft_groups')
        .map((job) => ({
            refs: (job.item.groupRefs ?? []).map((ref) => rig.store.phraseGroups.require(ref).key),
            findingRefs: job.item.findingRefs ?? [],
            taskRefs: job.item.taskRefs ?? []
        }));

/**
 * An Editor-approved, group-scoped defect PLUS the open fix task its confirmation armed — the state the
 * deep review leaves in the book.
 *
 * Seeded directly on purpose: this file pins what the SCHEDULER does with such a row (does a Writer pass
 * get bought for the group it names?), while `tools/reader.test.ts` pins the attribution rule that
 * produces it and `integration/` drives the whole chain with a real crew.
 */
const seedGroupFinding = (rig: Rig, groupId: string): { finding: Finding; task: Task } => {
    const seeded = seedFinding(rig.store, rig.storyId, {
        target_ref: 'summary_0',
        criterion_ref: 'C-14',
        cost: 'critical',
        state: 'approved',
        title: 'the premise contradicts the Seed',
        detail: 'the Overview promises a cartographer; the Seed says the map was destroyed',
        fingerprint: 'C-14|summary_0'
    });

    // `group_refs` is R3's anchor: without it the same defect means "rewrite all five groups".
    const finding = rig.store.findings.update(
        seeded.id,
        { group_refs: [groupId] },
        { run_ref: null, author: true, why: 'seed: the deep review scoped this defect to one group (R3)' },
        [{ id: seeded.id, rev: seeded.rev }]
    );
    const task = seedTask(rig.store, rig.storyId, {
        kind: 'fix',
        title: 'fix finding_0: pay the premise the Seed states',
        detail: `C-14 on summary_0 · ${finding.id}`,
        owner_role: 'writer',
        finding_ref: finding.id
    });

    return { finding, task };
};

/**
 * Every CLOSED run row that names one group — the count F1 replaced. It includes the THREE reading
 * passes (the seat, the deep review and D-65's scoring pass each carry `group_refs` because their crew
 * judged the whole Overview), so the pair of numbers here — this raw count against `groupWriteAttempts`
 * — is what makes the exclusion falsifiable instead of a comment.
 */
const closedRefRunsOf = (rig: Rig, groupId: string): number =>
    rig.store.runs.list().filter((run) => !isLiveRun(run) && (run.group_refs ?? []).includes(groupId)).length;

describe('an approved finding still buys its Writer fix (F1)', () => {
    it('counts writes, not reads: a seat and a deep review spend nothing, so the fix dispatches', async () => {
        const rig = await createRig({ summaryMode: 'groups', summarySampling: 5, summaryCritics: 1 });

        // Round 1 of the group pipeline, run for real: one Writer pass writes all five groups, then the
        // seat and the deep review read that installed Overview. This is the state F1 mis-read — three
        // CLOSED runs name all five groups here, and counting all three as writes left every group at
        // `GROUP_WRITE_ATTEMPT_CAP`, so the finding below could never schedule its fix.
        await rig.run();

        // D-67 took the scoring pass OUT of this list. It is armed by the CLEAN selection, and this rig's
        // deep review files findings, so no group of this vector ever carries a Clean verdict — a Reader is
        // never offered a Summary the crew is still rejecting. What remains is the pipeline the phase
        // actually owes: the Writer batch, the structured seat, the deep cross-group pass. (The dispatch
        // ORDER of the scoring seat, `rank: -1` ahead of these two, is pinned in `section-scores.test.ts`,
        // where the fixture closes a clean pass first.)
        expect(rig.store.runs.list().map((run) => run.work_item_ref ?? run.id)).toEqual([
            'wi_research_1',
            `${familyOf(groupsOf(rig).map((group) => group.id))}_1`,
            `wi_review_groups_${groupVectorHash(groupRevisionVector(rig.store, rig.storyId))}_1`,
            `wi_group_check_${groupVectorHash(groupRevisionVector(rig.store, rig.storyId))}_1`
        ]);

        const premise = groupsOf(rig).find((group) => group.key === 'premise')!;

        // The raw read F1 replaced: THREE closed runs carry this group id — one wrote it, two only read it
        // (the structured seat and the deep cross-group review). The Run row carries `group_refs` because
        // the pass really did judge every group, which is what
        // the rail shows; it is `isGroupHoldingRun` (`phrase/exclusion.ts:40`), not the refs, that decides
        // whether a row spent the Writer's allowance, and a scoring run is not a holding kind.
        expect(closedRefRunsOf(rig, premise.id)).toBe(3);
        // The counter's answer: ZERO. Two of those rows are not holding runs (R4's own predicate), and the
        // third is the pass that WROTE this text, so it is not an attempt AGAINST it — the baseline is the
        // group's `latest` Group Revision, which that install created (`work.ts:groupWriteAttempts`).
        expect(attemptsOf(rig)).toEqual(['premise: 0', 'promise: 0', 'theme: 0', 'tone: 0', 'ending: 0']);

        const { finding, task } = seedGroupFinding(rig, premise.id);

        // The dispatch itself: exactly one batch, naming ONLY the group that owes the finding — the other
        // four are written and owe nothing (R2), and the finding and task ride along so the install can
        // claim them (R3).
        expect(fixBatches(rig)).toEqual([
            { refs: ['premise'], findingRefs: [finding.id], taskRefs: [task.id] }
        ]);

        await rig.engine.sweep();
        await rig.engine.settle();

        // The fix landed: premise number 2 `latest` claiming the finding and the task, its old text
        // archived (R2), and the other four groups untouched (an unasked rewrite is an unasked regression).
        const rows = rig.store.groupRevisions.list().filter((revision) => revision.group_key === 'premise');

        expect(rows.map((revision) => [revision.id, revision.number, revision.state, revision.finding_refs, revision.task_refs])).toEqual([
            ['group_revision_0', 1, 'archived', undefined, undefined],
            ['group_revision_5', 2, 'latest', [finding.id], [task.id]]
        ]);
        expect(
            rig.store.groupRevisions
                .list()
                .filter((revision) => revision.group_key !== 'premise')
                .map((revision) => [revision.group_key, revision.number, revision.state])
        ).toEqual([
            ['promise', 1, 'latest'],
            ['theme', 1, 'latest'],
            ['tone', 1, 'latest'],
            ['ending', 1, 'latest']
        ]);
        expect(groupsOf(rig).map((group) => [group.key, group.revision])).toEqual([
            ['premise', 2],
            ['promise', 1],
            ['theme', 1],
            ['tone', 1],
            ['ending', 1]
        ]);

        // R3's closure: every targeted group has a revision answering the finding, so the row is `fixed`
        // and the fix task is consumed.
        expect(rig.store.findings.require(finding.id)).toMatchObject({ state: 'fixed', group_refs: [premise.id] });
        expect(rig.store.tasks.require(task.id)).toMatchObject({ state: 'done', attempts: 1 });

        // R6's mirror follows the group that moved, and only that one.
        const summary = rig.store.summaries.require('summary_0');
        const premiseGroup = rig.store.phraseGroups.require(premise.id);

        expect(summary.premise).toBe(premiseGroup.content);
        expect(premiseGroup.content).toBe(`The ${premise.id} line this story refuses to lose.`);

        // F1's second half — the RESET, pinned against the ledger. premise now carries TWO closed Writer
        // passes (the draft and this fix) plus the TWO reading passes over the first vector (the structured
        // seat and the deep cross-group review): four rows name it, and the counter reads ZERO, because the
        // allowance runs from the NEW text. A baseline taken from the `phrase_groups` row (the pre-F1
        // read) would show all four here and freeze the book after two rounds, which is the failure this
        // correction removes. (D-67 is why the count is four and not five: the fix moved the vector, and a
        // vector with no Clean verdict is never offered to the Reader, so D-65's scoring row is absent.)
        expect(closedRefRunsOf(rig, premise.id)).toBe(4);
        expect(attemptsOf(rig)).toEqual(['premise: 0', 'promise: 0', 'theme: 0', 'tone: 0', 'ending: 0']);
    });
});

describe('the per-group allowance stops a Writer pass, never a Critic (F1, F3)', () => {
    it('gives no Writer candidate once the corrected allowance is spent, and spends none on reading', async () => {
        const rig = await createRig({ summaryMode: 'groups', summarySampling: 5, summaryCritics: 1 });

        await rig.engine.sweep();
        await rig.engine.settle();

        const premise = groupsOf(rig).find((group) => group.key === 'premise')!;
        const { finding, task } = seedGroupFinding(rig, premise.id);

        // Nothing spent against the current text yet, so the fix is dispatchable — exactly the state F1
        // blocked in, where the two reading passes had eaten the allowance.
        expect(attemptsOf(rig)).toEqual(['premise: 0', 'promise: 0', 'theme: 0', 'tone: 0', 'ending: 0']);
        expect(fixBatches(rig)).toEqual([{ refs: ['premise'], findingRefs: [finding.id], taskRefs: [task.id] }]);

        // Two CLOSED Writer passes that installed NOTHING (a refused answer ends `torn_down` without
        // writing a revision — the state this bound exists for) and the allowance is spent. A third pass
        // would be the same runaway the sampling family bounds with `samplingCapOf`, and the group path's
        // escalation is the open finding itself, staying in the Author's rail with its attempts visible.
        for (const attempt of [9, 10]) {
            rig.store.runs.create(
                {
                    story_id: rig.storyId,
                    work_item_ref: `${familyOf([premise.id])}_${attempt}`,
                    role: 'writer',
                    state: 'torn_down',
                    started_at: `2026-11-24T11:00:0${attempt - 9}.000Z`,
                    tokens: 40,
                    kind: 'work',
                    delegated: [],
                    group_refs: [premise.id]
                },
                { run_ref: null, author: false, why: `seed: closed Writer pass ${attempt} on premise (F3)` }
            );
        }

        expect(groupWriteAttempts(rig.store, rig.story(), premise)).toBe(GROUP_WRITE_ATTEMPT_CAP);
        expect(fixBatches(rig)).toEqual([]);
        // The defect is NOT forgotten when the allowance runs out: it stays open, scoped, and visible in the
        // Author's rail with its debt on the group row.
        expect(rig.store.findings.require(finding.id)).toMatchObject({ state: 'approved', group_refs: [premise.id] });
        expect(rig.store.phraseGroups.require(premise.id).revision).toBe(1);
        expect(candidates(rig).find((job) => job.item.kind === 'draft_groups')).toBeUndefined();

        // And reading stays free: the seat for this vector is still armed, and once it closes the allowance
        // is exactly where it was — a Critic pass never spends a Writer's budget.
        const seats = reviewSeats(rig);

        expect(seats).toHaveLength(1);
        expect(seats[0].key).toBe(`wi_review_groups_${groupVectorHash(groupRevisionVector(rig.store, rig.storyId))}_1`);

        // Two sweeps, because the ceiling is 1 in this rig (`loop/mock.ts:445`) and D-65 put the scoring
        // seat AHEAD of the review seats in the dispatch order (`loop/work.ts` candidate 2b carries
        // `rank: -1`, so a Summary revision is scored before anything can rewrite it). One sweep launches
        // one seat: sweep 1 = the score for this vector, sweep 2 = the review seat this test is about.
        await rig.engine.sweep();
        await rig.engine.settle();
        await rig.engine.sweep();
        await rig.engine.settle();

        // The seat ran (`wi_review_groups_…_1` is closed) and premise's number did not move: the review
        // consumed a run, not the group's write budget, so the parked state survives the read (F1, F3).
        // The seat ran, premise's number did not move, and the counter still reads the cap: a Critic pass
        // consumed a run, not the group's write budget (F1), and the parked state survives the read (F3).
        // The raw count still reads FIVE, and D-67 is why its composition changed rather than its size: the
        // display-only scoring pass is gone (no Clean verdict on this vector, so no Reader is offered it),
        // and the deep cross-group pass now lands in this sweep instead of the next one. Both of those rows
        // carry all five `group_refs`, and NEITHER is a holding kind, so `groupWriteAttempts` stays at the
        // cap — which is exactly the pair F1 was built to make visible.
        expect(groupWriteAttempts(rig.store, rig.story(), premise)).toBe(GROUP_WRITE_ATTEMPT_CAP);
        expect(closedRefRunsOf(rig, premise.id)).toBe(5);
        expect(rig.store.phraseGroups.require(premise.id).revision).toBe(1);
        expect(rig.store.runs.list().map((run) => run.work_item_ref ?? run.id)).toEqual([
            'wi_research_1',
            `${familyOf(groupsOf(rig).map((group) => group.id))}_1`,
            `${familyOf([premise.id])}_9`,
            `${familyOf([premise.id])}_10`,
            `wi_review_groups_${groupVectorHash(groupRevisionVector(rig.store, rig.storyId))}_1`,
            `wi_group_check_${groupVectorHash(groupRevisionVector(rig.store, rig.storyId))}_1`
        ]);
        expect(fixBatches(rig)).toEqual([]);
    });
});

describe('a group-managed book runs the group pipeline, never the sampler (R5)', () => {
    it('dispatches the three-group batch, holds its groups on the Run row, and books no sampler job', async () => {
        const rig = await createRig({ summaryMode: 'groups', summarySampling: 3, summaryCritics: 2 });
        const batch = groupsOf(rig).slice(0, 3).map((group) => group.id);

        const started = (await rig.engine.sweep()).stories[0].started;

        // R5's headline, on the ledger rather than in prose: one group pass, and no `sample_unit` and no
        // `screen_samples` item anywhere on the book.
        expect(started).toHaveLength(1);
        expect([...rig.items.values()].map((item) => item.kind)).toEqual(['draft_groups']);

        const key = started[0];

        // R2 — the key is `wi_draft_groups_<summaryRef>_<group-set hash>_<attempt>`, where the hash is the
        // batch's group vector at revision 0. Asserting the DERIVATION rather than a hash literal is the
        // contract: a restart re-reads the rows and must land on the same family.
        expect(key).toBe(`${familyOf(batch)}_1`);

        const item = rig.items.get(key);
        const run = rig.store.runs.list().find((row) => row.work_item_ref === key)!;

        expect({
            kind: item?.kind,
            toolMode: item?.toolMode,
            schema: item?.responseSchema?.name,
            groupRefs: item?.groupRefs,
            findingRefs: item?.findingRefs,
            templateRef: item?.templateRef,
            roleName: item?.roleName,
            unit: item?.unit,
            // R4 — the Run row carries the batch the Work Item named: `run/executor.ts` copies it, and
            // `phrase/exclusion.ts` reads it. The claim key is ledger identity, never the lock.
            runGroupRefs: run.group_refs
        }).toEqual({
            kind: 'draft_groups',
            toolMode: 'none',
            // R7: a schema-driven job, so this is the only kind of prompt change the slice makes.
            schema: 'GroupDraft',
            groupRefs: batch,
            findingRefs: [],
            templateRef: 'writer-summary-sampler',
            roleName: 'writer',
            unit: { kind: 'summary', ref: 'summary_0' },
            runGroupRefs: batch
        });

        expect(
            [...rig.items.values()].filter((row) => row.kind === 'sample_unit' || row.kind === 'screen_samples')
        ).toEqual([]);
        expect(rig.store.revisions.list()).toEqual([]);
    });

    it('cuts the batch at the dial: a two-group book asks for two groups and no more (R2)', async () => {
        const rig = await createRig({ summaryMode: 'groups', summarySampling: 2, summaryCritics: 1 });
        const groups = groupsOf(rig);

        expect(groupJobs(rig)).toEqual([
            {
                key: `wi_draft_groups_summary_0_${groupVectorHash({
                    [groups[0].id]: 0,
                    [groups[1].id]: 0
                })}_1`,
                refs: [groups[0].id, groups[1].id],
                why: 'rewrite 2 Summary group(s) — premise, promise — in one structured pass (R2, R5)',
                toolMode: 'none'
            }
        ]);
    });

    it('writes the batch in catalog order and leaves the rest of the book to later batches (R2)', async () => {
        const rig = await createRig({ summaryMode: 'groups', summarySampling: 3, summaryCritics: 2 });

        await rig.engine.sweep();

        const groups = groupsOf(rig);

        // The batch is the first three in CATALOG order — a deterministic cut, so a restart asks for the
        // same three groups rather than whichever three the store happened to list first.
        expect(groupJobs(rig)).toEqual([
            {
                key: `wi_draft_groups_summary_0_${groupVectorHash({
                    [groups[3].id]: 0,
                    [groups[4].id]: 0
                })}_1`,
                refs: [groups[3].id, groups[4].id],
                why: 'rewrite 2 Summary group(s) — tone, ending — in one structured pass (R2, R5)',
                toolMode: 'none'
            }
        ]);
    });
});

describe('an accepted answer installs on settle (R2, R5, R6)', () => {
    it('writes one Group Revision per group, mirrors the Overview, and leaves the other two groups untouched', async () => {
        const rig = await createRig({ summaryMode: 'groups', summarySampling: 3, summaryCritics: 2 });

        await rig.engine.sweep();

        const rows = rig.store.groupRevisions.list();
        const groups = groupsOf(rig);
        const batch = groups.slice(0, 3);
        const run = rig.store.runs.list().find((row) => row.work_item_ref === `${familyOf(batch.map((group) => group.id))}_1`)!;

        // R2 — one revision per group, at number 1, `latest`, attributed to the run that wrote it. An
        // unclaimed install leaves the claim arrays empty rather than inventing a resolution (R3).
        expect(rows.map((row) => [row.id, row.group_id, row.number, row.state])).toEqual([
            ['group_revision_0', batch[0].id, 1, 'latest'],
            ['group_revision_1', batch[1].id, 1, 'latest'],
            ['group_revision_2', batch[2].id, 1, 'latest']
        ]);
        expect(rows.map((row) => row.run_ref)).toEqual([run.id, run.id, run.id]);
        // An unclaimed install leaves the claim fields OFF the row (not `[]`): a hand edit and a Writer
        // pass that answers no finding both claim nothing, and R3's closure reads the absence as such.
        expect(rows.map((row) => [row.finding_refs, row.task_refs])).toEqual([
            [undefined, undefined],
            [undefined, undefined],
            [undefined, undefined]
        ]);
        // The rig's default answer names the group id, which traces each row to the group the JOB asked
        // for — not the group the prompt happened to mention first.
        expect(rows.map((row) => row.content)).toEqual(
            batch.map((group) => `The ${group.id} line this story refuses to lose.`)
        );

        // R2 — the two groups the batch never held are exactly as the catalog created them.
        expect(groups.map((group) => [group.key, group.revision, group.content, group.updated_by])).toEqual([
            ['premise', 1, `The ${batch[0].id} line this story refuses to lose.`, run.id],
            ['promise', 1, `The ${batch[1].id} line this story refuses to lose.`, run.id],
            ['theme', 1, `The ${batch[2].id} line this story refuses to lose.`, run.id],
            ['tone', 0, '', null],
            ['ending', 0, '', null]
        ]);

        // R6 — the legacy mirror carries the group prose for the fields the batch WROTE, and no others.
        // (The rig's fresh Story creates the Summary with the other fields unset; the install leaves them
        // exactly as they were, which is R2's "an untouched field is not written".)
        const summary = rig.store.summaries.require('summary_0');

        expect([summary.premise, summary.promise, summary.theme]).toEqual(rows.map((row) => row.content));
        expect([summary.tone ?? null, summary.ending ?? null, summary.world_rules ?? null]).toEqual([
            null,
            null,
            null
        ]);

        // R5 — nothing was queued for the Author to choose between: the accepted result IS the state.
        expect(rig.store.revisions.list()).toEqual([]);
    });
});

describe('one live Writer op per group (R4)', () => {
    it('reads the hold from the persisted live Run row, not from the claim key', async () => {
        const rig = await createRig({ summaryMode: 'groups', summarySampling: 3, summaryCritics: 2 });
        const groups = groupsOf(rig);
        const held = groups.slice(0, 3);
        const free = groups.slice(3);

        // A Writer IN FLIGHT on three groups — the state a restart finds the book in, and the only thing
        // `phrase/exclusion.ts:partitionGroups` reads. Its `work_item_ref` deliberately names a claim key
        // the planner would never build for this set, which is the point: the key is ignored.
        rig.store.runs.create(
            {
                story_id: rig.storyId,
                work_item_ref: 'wi_draft_groups_summary_0_ffffffffffffffff_9',
                role: 'writer',
                state: 'working',
                started_at: '2026-11-24T10:00:00.000Z',
                tokens: 0,
                kind: 'work',
                delegated: [],
                group_refs: held.map((group) => group.id)
            },
            { run_ref: null, author: false, why: 'seed: a live group Writer run (R4)' }
        );

        expect(groupJobs(rig)).toEqual([
            {
                key: `wi_draft_groups_summary_0_${groupVectorHash({ [free[0].id]: 0, [free[1].id]: 0 })}_1`,
                refs: [free[0].id, free[1].id],
                why: 'rewrite 2 Summary group(s) — tone, ending — in one structured pass (R2, R5)',
                toolMode: 'none'
            }
        ]);

        // Two live batches may run at once (that is the concurrency the redesign buys), but no group is
        // ever in two of them.
        const liveRefs = rig.liveRuns().flatMap((id) => rig.store.runs.require(id).group_refs ?? []);

        expect(liveRefs).toEqual(held.map((group) => group.id));
        expect(liveRefs.filter((ref) => free.some((group) => group.id === ref))).toEqual([]);
    });
});

describe('the structured review re-arms on the group vector (R3, R5)', () => {
    it('books one seat per Critic, keyed by the vector the install moved, over every group', async () => {
        const rig = await createRig({ summaryMode: 'groups', summarySampling: 5, summaryCritics: 2 });

        await rig.engine.sweep();

        // One pass wrote the whole vector, so the seats below key on all five groups at number 1 — and
        // the next install (a re-write of one group) moves the vector and re-arms the seats by itself.
        expect(groupRevisionVector(rig.store, rig.storyId)).toEqual(
            Object.fromEntries(groupsOf(rig).map((group) => [group.id, 1]))
        );

        const vectorHash = groupVectorHash(groupRevisionVector(rig.store, rig.storyId));
        const allRefs = groupsOf(rig).map((group) => group.id);

        expect(reviewSeats(rig)).toEqual([
            {
                key: `wi_review_groups_${vectorHash}_1`,
                refs: allRefs,
                why: `Critic 1/2 reviews the installed Overview at group vector ${vectorHash} (R3, R5)`
            },
            {
                key: `wi_review_groups_${vectorHash}_2`,
                refs: allRefs,
                why: `Critic 2/2 reviews the installed Overview at group vector ${vectorHash} (R3, R5)`
            }
        ]);

        const seats = [1, 2].map((pass) => candidates(rig).find((job) => job.key === `wi_review_groups_${vectorHash}_${pass}`)!.item);

        expect(seats.map((item) => [item.kind, item.toolMode, item.responseSchema?.name, item.roleName])).toEqual([
            ['review_groups', 'none', 'GroupReview', 'critic'],
            ['review_groups', 'none', 'GroupReview', 'critic']
        ]);
    });
});
