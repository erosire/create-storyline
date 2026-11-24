/**
 * HARDENING (item 6, R3/D-34) — a cross-group finding is closed by a COMPLETED fix, and the loop's
 * re-check only ever runs on a group book.
 *
 * Two rules, pinned from the records they leave behind:
 *
 *   1. A finding that names THREE groups is one defect, and §4.10 has no "partly fixed" state. On this
 *      book the Author's batch dial is 1, so the three fixes arrive one sweep apart — and the finding
 *      must stay `approved` with its fix task `open` until the LAST named group has an installed
 *      revision claiming it (`phrase/findings.ts:findingResolution`'s `missing` set is the evidence).
 *      Closing on the first install would report a defect as answered while two of the five groups still
 *      said the thing the Author complained about; the open row with its `missing` groups is what routes
 *      the next batch (`findingGroupsStillOwed`).
 *   2. Closure is a JOIN on claims, in BOTH directions of the ordering. The install-time close
 *      (`closeFindingWhenGroupsResolved`) is state-gated on `approved` (D-34: the loop may not mark a
 *      defect fixed while the Author is looking at an approval row), so a Writer pass that answers the
 *      defect BEFORE an approval funnel writes `approved` correctly declines — and then, with no group
 *      still owing the finding, the planner never dispatches another pass for it. Before this pass the
 *      row sat `approved` and unanswered-forever; the sweep's `loop_reconcile_findings` step re-runs the
 *      same read one sweep later (idempotent, restart-safe, L-3) and the fix task follows the finding.
 *      That step reads `group_revisions.finding_refs`, which only a group install ever writes, so it is
 *      scoped to `isGroupManagedStory` books — on a legacy Summary the read answers `resolved_all: true`
 *      VACUOUSLY (nothing in scope), and acting on that would delete the sampling round's fix work. The
 *      third case pins the vacuous read and the refusal to act on it.
 *
 * Values were read off the rig (`Temp/…/probe-batchcap.ts`, `probe-reconcile.ts`), not guessed. Group
 * identities are asserted by CATALOG KEY: the ids are minted per store and carry no meaning a reader can
 * check. `auto_approve: []` appears where a test needs the D-34 gate to stay shut.
 */
import { describe, expect, it } from 'vitest';

import { createRig, seedFinding, seedTask, type Rig } from './mock';
import { generateWork } from './work';
import { closeFindingAnsweredByInstalls, findingResolution } from '../phrase/findings';
import { AUTHOR_ATTR } from '../run/mock';
import type { Finding } from '../../shared/types';

/** The batch the planner offers right now: catalog keys per `draft_groups` job, in dispatch order. */
const batches = (rig: Rig): string[][] =>
    generateWork(rig.store, rig.story(), { at: '2026-11-24T11:00:00.000Z', phase: 'summary' })
        .filter((candidate) => candidate.item.kind === 'draft_groups')
        .map((candidate) => (candidate.item.groupRefs ?? []).map((ref) => rig.store.phraseGroups.require(ref).key));

/** `{catalogKey: revision}` — the whole group set as one exact value. */
const revisions = (rig: Rig): Record<string, number> =>
    Object.fromEntries(rig.store.phraseGroups.list().map((group) => [group.key, group.revision]));

/** R3's resolution, with the group IDS replaced by the catalog keys a reader can check. */
const resolutionOf = (rig: Rig, finding: Finding) => {
    const resolution = findingResolution(rig.store, rig.story(), finding);
    const keys = (ids: string[]) => ids.map((id) => rig.store.phraseGroups.require(id).key).sort();

    return {
        targeted: keys(resolution.targeted),
        resolved: keys(resolution.resolved),
        missing: keys(resolution.missing),
        resolved_all: resolution.resolved_all
    };
};

/** A book whose whole Overview is written once (five groups at revision 1, mirror in sync). */
async function writtenOnce(summarySampling: number): Promise<Rig> {
    const rig = await createRig({
        summaryMode: 'groups',
        summarySampling,
        summaryReaders: 1,
        crew: { researchQuestions: [] }
    });

    await rig.run();

    expect(revisions(rig)).toEqual({ premise: 1, promise: 1, theme: 1, tone: 1, ending: 1 });

    return rig;
}

const groupIdOf = (rig: Rig, key: string): string =>
    rig.store.phraseGroups.list().find((group) => group.key === key)!.id;

/** The deep review's output, seeded: an open defect naming the groups the Author says are wrong (R3). */
function seedGroupFinding(
    rig: Rig,
    keys: string[],
    fields: { cost: 'critical' | 'major' | 'minor'; state: Finding['state'] }
): Finding {
    const seeded = seedFinding(rig.store, rig.storyId, {
        target_ref: 'summary_0',
        criterion_ref: 'C-14',
        cost: fields.cost,
        state: fields.state,
        title: 'three groups still promise the drowned valley',
        detail: 'summary_0 premise, tone and ending keep the valley dry; the Seed drowned it',
        fingerprint: 'C-14|summary_0|valley'
    });

    return rig.store.findings.update(
        seeded.id,
        { group_refs: keys.map((key) => groupIdOf(rig, key)) },
        { run_ref: null, author: true, why: 'seed: the defect names its groups (R3)' },
        [{ id: seeded.id, rev: seeded.rev }]
    );
}

describe('a cross-group finding waits for every group it names (R3, D-34)', () => {
    it('holds the close until the last of three batches lands, then closes the finding and its task', async () => {
        // The dial the Author set to ONE group per pass — the shape that splits one finding's fix across
        // three sweeps and makes the ordering observable.
        const rig = await writtenOnce(1);
        const finding = seedGroupFinding(rig, ['premise', 'tone', 'ending'], { cost: 'critical', state: 'confirmed' });

        const task = seedTask(rig.store, rig.storyId, {
            kind: 'fix',
            title: 'fix finding_0: drown the valley in all three groups',
            detail: `C-14 on summary_0 · ${finding.id}`,
            owner_role: 'writer',
            finding_ref: finding.id
        });

        // D-34's gate, opened by the Author: an approved row is authorised work for the Writer.
        await rig.engine.approveFinding(finding.id);

        expect({ state: rig.store.findings.require(finding.id).state, owed: batches(rig)[0] }).toEqual({
            state: 'approved',
            owed: ['premise']
        });

        // Fix 1 of 3: premise re-written and its revision CLAIMING the finding — but tone and ending are
        // still the text the Author complained about, so the row cannot read `fixed`.
        await rig.step();

        expect(revisions(rig)).toEqual({ premise: 2, promise: 1, theme: 1, tone: 1, ending: 1 });
        expect(resolutionOf(rig, finding)).toEqual({
            targeted: ['ending', 'premise', 'tone'],
            resolved: ['premise'],
            missing: ['ending', 'tone'],
            resolved_all: false
        });
        expect({ state: rig.store.findings.require(finding.id).state, task: rig.store.tasks.require(task.id).state }).toEqual({
            state: 'approved',
            task: 'open'
        });

        // Fix 2 of 3 — still two claims short of nothing.
        await rig.step();

        expect(revisions(rig)).toEqual({ premise: 2, promise: 1, theme: 1, tone: 2, ending: 1 });
        expect(resolutionOf(rig, finding)).toEqual({
            targeted: ['ending', 'premise', 'tone'],
            resolved: ['premise', 'tone'],
            missing: ['ending'],
            resolved_all: false
        });
        expect({ state: rig.store.findings.require(finding.id).state, task: rig.store.tasks.require(task.id).state }).toEqual({
            state: 'approved',
            task: 'open'
        });

        // Fix 3 of 3: the last missing claim lands, and the SAME settle closes the finding (R3) and
        // consumes the task that named it.
        await rig.step();

        expect(revisions(rig)).toEqual({ premise: 2, promise: 1, theme: 1, tone: 2, ending: 2 });
        expect(resolutionOf(rig, finding)).toEqual({
            targeted: ['ending', 'premise', 'tone'],
            resolved: ['ending', 'premise', 'tone'],
            missing: [],
            resolved_all: true
        });
        expect({ state: rig.store.findings.require(finding.id).state, task: rig.store.tasks.require(task.id).state }).toEqual({
            state: 'fixed',
            task: 'done'
        });

        // Nothing is owed any more: the defect is answered group-by-group, so the batch is silent.
        expect(batches(rig)).toEqual([]);
    });

    it('closes on the sweep that follows a late approval, and never before it (loop_reconcile_findings)', async () => {
        const rig = await writtenOnce(1);

        // The Author's dial auto-approves nothing, so the row is STILL `confirmed` when the Writer answers
        // it — the state gate that stops the loop from marking a defect fixed under the Author's hand.
        const dial = rig.story();

        rig.store.stories.update(
            dial.id,
            { auto_approve: [] },
            { run_ref: null, author: true, why: 'seed: no cost auto-approves on this book (D-35b)' },
            [{ id: dial.id, rev: dial.rev }]
        );

        const finding = seedGroupFinding(rig, ['tone'], { cost: 'minor', state: 'confirmed' });

        const task = seedTask(rig.store, rig.storyId, {
            kind: 'fix',
            title: 'fix finding_0: drown the valley in the tone group',
            detail: `C-14 on summary_0 · ${finding.id}`,
            owner_role: 'writer',
            finding_ref: finding.id
        });

        // The pass runs off the OPEN row (`groupWorkTargets` accepts D-33's ladder on purpose) and installs
        // the answer. D-34's gate holds: `confirmed` cannot close, and the task stays queued.
        await rig.step();

        expect(revisions(rig)).toEqual({ premise: 1, promise: 1, theme: 1, tone: 2, ending: 1 });
        expect(resolutionOf(rig, finding)).toEqual({
            targeted: ['tone'],
            resolved: ['tone'],
            missing: [],
            resolved_all: true
        });
        expect({ state: rig.store.findings.require(finding.id).state, task: rig.store.tasks.require(task.id).state }).toEqual({
            state: 'confirmed',
            task: 'open'
        });

        // The approval lands afterwards, and it closes nothing by itself: `approveFinding` re-arms work,
        // and by now no group OWES the finding, so the planner would never dispatch another pass for it.
        const gate = rig.store.findings.require(finding.id);

        rig.store.findings.update(
            finding.id,
            { state: 'approved', approved_by: 'author' },
            { run_ref: null, author: true, why: 'seed: D-34 approval landed after the install' },
            [{ id: finding.id, rev: gate.rev }]
        );

        expect({ state: rig.store.findings.require(finding.id).state, task: rig.store.tasks.require(task.id).state }).toEqual({
            state: 'approved',
            task: 'open'
        });

        // THE SWEEP'S RE-CHECK. Same records, same rule, one sweep later — the third approval funnel and
        // the crash-recovery path in one step (L-3). The finding is answered on the evidence, so it closes
        // and its fix task is consumed rather than left to hold L-37's drain.
        await rig.step();

        expect({ state: rig.store.findings.require(finding.id).state, task: rig.store.tasks.require(task.id).state }).toEqual({
            state: 'fixed',
            task: 'done'
        });
    });
});

describe('the reconcile is a group-book rule: a legacy Summary has nothing in scope (P1 guard)', () => {
    it('refuses to close an approved Summary finding on a book with no phrase rows', async () => {
        const rig = await createRig({ summarySampling: 1, summaryReaders: 1, crew: { researchQuestions: [] } });

        await rig.run();

        const seeded = seedFinding(rig.store, rig.storyId, {
            target_ref: 'summary_0',
            criterion_ref: 'C-14',
            cost: 'critical',
            state: 'approved',
            title: 'the Summary over-promises the rescue',
            detail: 'summary_0 promise: the rescue is certain; the plotlines make it a coin toss',
            fingerprint: 'C-14|summary_0|rescue'
        });
        const finding = rig.store.findings.require(seeded.id);

        const task = seedTask(rig.store, rig.storyId, {
            kind: 'fix',
            title: 'fix finding_0: cost the rescue',
            detail: `C-14 on summary_0 · ${finding.id}`,
            owner_role: 'writer',
            finding_ref: finding.id
        });

        // The whole point of the guard: with no catalog in scope the read is TRUE BY EMPTINESS — and an
        // emptiness is not evidence that a defect was rewritten away.
        expect(rig.store.phraseGroups.list()).toEqual([]);
        expect(resolutionOf(rig, finding)).toEqual({
            targeted: [],
            resolved: [],
            missing: [],
            resolved_all: true
        });

        const before = { ...finding };
        const closed = closeFindingAnsweredByInstalls(
            rig.store,
            rig.story(),
            finding,
            { run_ref: null, why: 'probe: the group close attempted on a legacy Summary' }
        );

        expect(closed).toBeUndefined();
        expect({ ...rig.store.findings.require(finding.id) }).toEqual(before);
        expect(rig.store.findings.require(finding.id).state).toBe('approved');
        expect(rig.store.tasks.require(task.id).state).toBe('open');
    });
});
