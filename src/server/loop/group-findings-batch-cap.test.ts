/**
 * HARDENING (item 6, R3/D-34) + R12 (D-66) — a cross-group finding is closed by a COMPLETED fix, and a
 * fix is never CUT in half.
 *
 * Three rules, pinned from the records they leave behind:
 *
 *   1. A finding that names THREE groups is one defect, and §4.10 has no "partly fixed" state. Since
 *      D-66 the loop also never SCHEDULES half of it: on this book the Author's batch dial is 1 and the
 *      finding still arms ONE pass over all three groups, because the dial is a cap BETWEEN finding-sets
 *      and yields WITHIN one (`phrase/exclusion.ts:planGroupDraftBatch`). One pass, one commit, three
 *      claiming revisions, and the finding is `fixed` on that settle — no sweep in which the Author's
 *      book shows a defect as partly answered.
 *      1b. What D-66 did NOT move is the CLOSURE join, and the second case below still pins it: a fix
 *      that reaches only one of the groups it names — installed before the approval landed, or scripted
 *      that way — keeps the finding `approved` with its task `open`, because
 *      `phrase/findings.ts:findingResolution`'s `missing` set is non-empty. Closing on a partial claim
 *      would report a defect as answered while a group still said what the Author objected to.
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

import { createRig, seedFinding, seedTask, type CrewBehaviour, type Rig } from './mock';
import { generateWork } from './work';
import { closeFindingAnsweredByInstalls, findingResolution } from '../phrase/findings';
// The claim-key family is RECOMPUTED with the same hash the planner uses (`loop/work.ts`), never copied
// off a run row: the assertion is that a batch's key addresses its WHOLE group set.
import { groupVectorHash } from '../phrase/revisions';
import { AUTHOR_ATTR } from '../run/mock';
import type { Finding } from '../../shared/types';

/** The batch the planner offers right now: catalog keys per `draft_groups` job, in dispatch order. */
const batches = (rig: Rig): string[][] =>
    generateWork(rig.store, rig.story(), { at: '2026-11-24T11:00:00.000Z', phase: 'summary' })
        .filter((candidate) => candidate.item.kind === 'draft_groups')
        .map((candidate) => (candidate.item.groupRefs ?? []).map((ref) => rig.store.phraseGroups.require(ref).key));

/**
 * The same candidates WITH their claims: the claim key, the batch's catalog keys, and the findings and
 * tasks the job carries. D-66 is partly a claim-shape rule — one finding rides on ONE job, listed once,
 * however many of its groups the job rewrote — so the shape has to be read, not inferred from the group
 * list.
 */
const draftJobs = (rig: Rig) =>
    generateWork(rig.store, rig.story(), { at: '2026-11-24T11:00:00.000Z', phase: 'summary' })
        .filter((candidate) => candidate.item.kind === 'draft_groups')
        .map((candidate) => ({
            key: candidate.key,
            refs: (candidate.item.groupRefs ?? []).map((ref) => rig.store.phraseGroups.require(ref).key),
            findingRefs: candidate.item.findingRefs ?? [],
            taskRefs: candidate.item.taskRefs ?? []
        }));

/** `{catalogKey: revision}` — the whole group set as one exact value. */
const revisions = (rig: Rig): Record<string, number> =>
    Object.fromEntries(rig.store.phraseGroups.list().map((group) => [group.key, group.revision]));

/**
 * The claim FAMILY a batch over these catalog keys is dispatched under (`loop/work.ts`): the group-set
 * hash at revision 0, recomputed through the same helper the planner uses. It is how a reader checks
 * that ONE pass covered the WHOLE set — a `{premise, tone, ending}` batch is a different family from
 * three single-group ones.
 */
const familyOf = (rig: Rig, keys: string[]): string =>
    `wi_draft_groups_summary_0_${groupVectorHash(Object.fromEntries(keys.map((key) => [groupIdOf(rig, key), 0])))}`;

/**
 * Every Group Revision a fix pass installed (number 2), as
 * `[group_key, number, state, finding_refs, task_refs, work_item_ref]`, sorted by catalog key so the
 * value does not depend on journal order.
 *
 * The two claim fields are the point of D-66: one pass over three groups stamps the finding ONCE on each
 * of the three texts (the batch lists a finding once however many of its groups it rewrote —
 * `loop/work.ts` dedupes `findingRefs` before the install copies them), and `work_item_ref` names the
 * whole-set family, which is what proves the three revisions came from the SAME commit.
 */
const claims = (rig: Rig) =>
    rig.store.groupRevisions
        .list()
        .filter((revision) => revision.number === 2)
        .sort((left, right) => left.group_key.localeCompare(right.group_key))
        .map((revision) => [
            revision.group_key,
            revision.number,
            revision.state,
            revision.finding_refs,
            revision.task_refs,
            revision.work_item_ref
        ]);

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

/**
 * A book whose whole Overview is written once (five groups at revision 1, mirror in sync).
 *
 * `crew` is the scripted behaviour layered on the quiet default; `researchQuestions: []` always stays,
 * because a Researcher still filing defects would rank its own work ahead of the fix pass these rigs
 * watch. A hook here may read the rig it is about to build (the closure runs on a later sweep, never
 * during construction) — which is how the refusal case below records the group set each seat was shown.
 */
async function writtenOnce(summarySampling: number, crew: CrewBehaviour = {}): Promise<Rig> {
    const rig = await createRig({
        summaryMode: 'groups',
        summarySampling,
        summaryCritics: 1,
        crew: { researchQuestions: [], ...crew }
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
    fields: { cost: 'critical' | 'major' | 'minor'; state: Finding['state']; tag?: string }
): Finding {
    // `tag` keeps two seeded findings distinguishable (D-16's fingerprint is the dedupe key a real review
    // would collapse on), and the GROUP KEYS are quoted in the title so the row says what it crosses.
    const tag = fields.tag ?? '';
    const seeded = seedFinding(rig.store, rig.storyId, {
        target_ref: 'summary_0',
        criterion_ref: 'C-14',
        cost: fields.cost,
        state: fields.state,
        title: `${keys.join(', ')} still promise the drowned valley${tag === '' ? '' : ` (${tag})`}`,
        detail: `summary_0 ${keys.join(', ')} keep the valley dry; the Seed drowned it`,
        fingerprint: `C-14|summary_0|valley${tag === '' ? '' : `|${tag}`}`
    });

    return rig.store.findings.update(
        seeded.id,
        { group_refs: keys.map((key) => groupIdOf(rig, key)) },
        { run_ref: null, author: true, why: 'seed: the defect names its groups (R3)' },
        [{ id: seeded.id, rev: seeded.rev }]
    );
}

describe('a cross-group finding is fixed in ONE pass (R12, D-66)', () => {
    it('dispatches the three-group set under a dial of one, and the same install closes the finding and its task', async () => {
        // The dial the Author set to ONE group per pass — the shape that, before D-66, split one defect
        // across three sweeps. The dial is now a cap BETWEEN finding-sets and yields WITHIN one
        // (`phrase/exclusion.ts:planGroupDraftBatch`), so the whole set this finding arms goes out as one
        // batch, and the ledger never shows a moment where two of the five groups still said what the
        // Author objected to while the row looked partly answered.
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

        // The batch the planner offers is the finding's WHOLE group set, in catalog order — not the first
        // group of it.
        expect({ state: rig.store.findings.require(finding.id).state, owed: batches(rig)[0] }).toEqual({
            state: 'approved',
            owed: ['premise', 'tone', 'ending']
        });

        // ONE step, one pass, three revisions. Nothing ranks ahead of the fix here: `writtenOnce` already
        // ran the scoring seat and both reading seats for the first-draft vector (D-65).
        await rig.step();

        // The three named groups moved together; the two the finding never named keep their text, their
        // number and their allowance (R2's independence is untouched by D-66).
        expect(revisions(rig)).toEqual({ premise: 2, promise: 1, theme: 1, tone: 2, ending: 2 });

        // THE CLAIMS — the evidence D-66 exists to make true. Three new texts, ONE work item behind all of
        // them (`work_item_ref` is the WHOLE-SET family, not three single-group families), each claiming
        // the finding EXACTLY ONCE: the batch lists a finding once however many of its groups it rewrote,
        // so the audit never reads two closures out of one fix.
        const key = `${familyOf(rig, ['premise', 'tone', 'ending'])}_1`;

        expect(claims(rig)).toEqual([
            ['ending', 2, 'latest', [finding.id], [task.id], key],
            ['premise', 2, 'latest', [finding.id], [task.id], key],
            ['tone', 2, 'latest', [finding.id], [task.id], key]
        ]);

        const install = rig.store.runs.list().find((run) => run.work_item_ref === key)!;

        expect(
            rig.store.groupRevisions
                .list()
                .filter((revision) => revision.number === 2)
                .map((revision) => revision.run_ref)
        ).toEqual([install.id, install.id, install.id]);

        // R3's close fires on the same settle, because nothing is `missing`: every named group carries a
        // revision written for it, and the row was `approved` before the pass ran.
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

        // Nothing is owed any more: the defect was answered in the pass that armed it, so the batch is silent.
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

describe('the batch dial never splits one finding’s group set (R12, D-66)', () => {
    it('arms ONE draft seat over both groups of a two-group finding, on a dial of one', async () => {
        const rig = await writtenOnce(1);
        const finding = seedGroupFinding(rig, ['premise', 'promise'], {
            cost: 'major',
            state: 'approved',
            tag: 'pair'
        });
        const task = seedTask(rig.store, rig.storyId, {
            kind: 'fix',
            title: 'fix finding_0: pay the promise in both groups',
            detail: `C-14 on summary_0 · ${finding.id}`,
            owner_role: 'writer',
            finding_ref: finding.id
        });

        // The dial says "one group per pass"; the finding says "two groups, one defect". The finding wins:
        // the dial caps BETWEEN finding-sets (`phrase/exclusion.ts:planGroupDraftBatch`), so there is a
        // single job, and its claim key is the family for the PAIR — a premise-only family would be a
        // different key, and that is exactly the split-pass ledger this rule removes.
        expect(draftJobs(rig)).toEqual([
            {
                key: `${familyOf(rig, ['premise', 'promise'])}_1`,
                refs: ['premise', 'promise'],
                findingRefs: [finding.id],
                taskRefs: [task.id]
            }
        ]);
    });

    it('merges overlapping findings into one pass over the union of their groups', async () => {
        const rig = await writtenOnce(1);
        const pair = seedGroupFinding(rig, ['premise', 'promise'], { cost: 'major', state: 'approved', tag: 'a' });
        const other = seedGroupFinding(rig, ['promise', 'ending'], { cost: 'critical', state: 'approved', tag: 'b' });

        const tasks = [pair, other].map((finding, index) =>
            seedTask(rig.store, rig.storyId, {
                kind: 'fix',
                title: `fix ${finding.id}`,
                detail: `C-14 on summary_0 · ${finding.id}`,
                owner_role: 'writer',
                finding_ref: finding.id
            })
        );

        // The two defects meet on `promise`, so they are one connected set: `premise` cannot be rewritten
        // without answering the first defect, and `ending` without answering the second. Three groups, one
        // pass, on a book whose dial is 1 — and the batches stay separate for findings that do NOT overlap
        // (the case below), so this is a merge rule, not a "always rewrite everything" rule.
        expect(draftJobs(rig)).toEqual([
            {
                key: `${familyOf(rig, ['premise', 'promise', 'ending'])}_1`,
                refs: ['premise', 'promise', 'ending'],
                findingRefs: [pair.id, other.id],
                taskRefs: tasks.map((task) => task.id)
            }
        ]);

        await rig.step();

        // One settle, three groups, and BOTH defects are answered by it. Every revision the one commit
        // installs is stamped with the whole set it answers (`loop/engine.ts` passes a single
        // `finding_refs` list to `installGroupRevisions`), which is harmless: `findingResolution`
        // (phrase/findings.ts) only walks the groups of the finding it is closing. The dedupe matters
        // here — `pair` is stamped once per revision, not once per group.
        expect(revisions(rig)).toEqual({ premise: 2, promise: 2, theme: 1, tone: 1, ending: 2 });
        expect(claims(rig).map((row) => [row[0], row[3]])).toEqual([
            ['ending', [pair.id, other.id]],
            ['premise', [pair.id, other.id]],
            ['promise', [pair.id, other.id]]
        ]);
        expect(rig.store.findings.list().map((row) => [row.id, row.state])).toEqual([
            [pair.id, 'fixed'],
            [other.id, 'fixed']
        ]);
    });

    // What a REFUSAL looks like — the other half of "never a partial fix". Before D-66 the Writer could
    // answer ONE group of a two-group batch, the engine installed that one text, and the ledger showed a
    // defect partly answered. `phrase/revisions.ts:parseGroupDraftAnswer` now refuses a whole answer that
    // is missing a group the job carried, and `loop/engine.ts` installs only when `groupDraft.ok` — so one
    // group moves or NONE does, and the fix row is held with the refusal named in its history.
    it('refuses a partial answer whole: the group the Writer did write is not installed either', async () => {
        const seen: string[][] = [];
        const rig = await writtenOnce(1, {
            // One rule, and it is a COMPLETE answer for the warm-up: the first-draft seats carry one group
            // each, so "write only the first group you were shown" answers them fully. The seat this case
            // cares about carries TWO groups, and the same rule is HALF an answer.
            groupDraft: ({ item, groupRefs }) => {
                // The raw GROUP IDS, not catalog keys: the hook fires during the warm-up, before the `rig`
                // binding is assigned, so it cannot read the store. The assertions below map ids back to
                // keys through `groupIdOf`, which keeps the expected value readable.
                seen.push([...groupRefs]);
                // A seat that carries NO finding is the warm-up's Overview draft, and it answers fully. A
                // seat carrying the seeded defect is the FIX pass, and it answers only its first group —
                // HALF an answer, which is exactly what `parseGroupDraftAnswer` must refuse (R12).
                const halfAnswer = (item.findingRefs?.length ?? 0) > 0;

                return {
                    groups: (halfAnswer ? groupRefs.slice(0, 1) : groupRefs).map((group_ref) => ({
                        group_ref,
                        content: `The ${group_ref} line this story refuses to lose.`
                    })),
                    knowledge_used: []
                };
            }
        });
        const finding = seedGroupFinding(rig, ['premise', 'tone'], { cost: 'major', state: 'approved', tag: 'partial' });
        const task = seedTask(rig.store, rig.storyId, {
            kind: 'fix',
            title: 'fix finding_0: drown the valley in the premise and the tone',
            detail: `C-14 on summary_0 · ${finding.id}`,
            owner_role: 'writer',
            finding_ref: finding.id
        });

        // The seat on offer is the WHOLE set — one job, two groups, one claim entry.
        expect(draftJobs(rig)).toEqual([
            {
                key: `${familyOf(rig, ['premise', 'tone'])}_1`,
                refs: ['premise', 'tone'],
                findingRefs: [finding.id],
                taskRefs: [task.id]
            }
        ]);

        await rig.step();

        // The pass was shown BOTH groups and answered one, and the refusal moved NOTHING: no group leaves
        // revision 1, and there is no number-2 Group Revision anywhere on the book.
        // The seats the crew was asked to write, in dispatch order: five single-group seats for the warm-up
        // (catalog rank), then ONE seat over BOTH groups of the defect. The last entry is the whole point of
        // D-66 — on a book whose dial is 1, the fix pass is still shown the pair.
        expect(seen.map((refs) => refs.map((ref) => rig.store.phraseGroups.require(ref).key))).toEqual([
            ['premise'],
            ['promise'],
            ['theme'],
            ['tone'],
            ['ending'],
            ['premise', 'tone']
        ]);
        expect(revisions(rig)).toEqual({ premise: 1, promise: 1, theme: 1, tone: 1, ending: 1 });
        expect(claims(rig)).toEqual([]);
        expect(resolutionOf(rig, finding)).toEqual({
            targeted: ['premise', 'tone'],
            resolved: [],
            missing: ['premise', 'tone'],
            resolved_all: false
        });
        // The finding is still the Author's row and the fix row is HELD — spent attempts, `open` state, and
        // the refusal in the sentence the row reports, rather than a row closed because a run finished.
        expect({ finding: rig.store.findings.require(finding.id).state, task: rig.store.tasks.require(task.id).state }).toEqual({
            finding: 'approved',
            task: 'open'
        });
    });

    it('still rationed BETWEEN independent sets: two single-group findings under a dial of one buy one pass', async () => {
        const rig = await writtenOnce(1);
        const first = seedGroupFinding(rig, ['premise'], { cost: 'major', state: 'approved', tag: 'a' });
        const second = seedGroupFinding(rig, ['ending'], { cost: 'major', state: 'approved', tag: 'b' });

        [first, second].forEach((finding) =>
            seedTask(rig.store, rig.storyId, {
                kind: 'fix',
                title: `fix ${finding.id}`,
                detail: `C-14 on summary_0 · ${finding.id}`,
                owner_role: 'writer',
                finding_ref: finding.id
            })
        );

        // Independent sets are still cut at the dial — D-66 only exempts a set from being SPLIT, it does
        // not exempt the loop from the Author's knob. Catalog order decides which one goes first, so a
        // restart offers the same one (L-3).
        expect(batches(rig)).toEqual([['premise']]);

        await rig.step();
        expect({ first: rig.store.findings.require(first.id).state, second: rig.store.findings.require(second.id).state }).toEqual({
            first: 'fixed',
            second: 'approved'
        });

        // The other set is untouched and still owed — its own pass, its own family, nothing half-installed
        // on the way.
        expect(batches(rig)).toEqual([['ending']]);
    });
});

describe('the reconcile is a group-book rule: a legacy Summary has nothing in scope (P1 guard)', () => {
    it('refuses to close an approved Summary finding on a book with no phrase rows', async () => {
        const rig = await createRig({ summarySampling: 1, summaryCritics: 1, crew: { researchQuestions: [] } });

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
