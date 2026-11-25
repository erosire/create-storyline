/**
 * D2 — A FIX ROW DIES WITH THE FINDING THAT STOPPED BEING WORK.
 *
 * `dispatchableTasks` (`records.ts:160-164`) admits ANY `kind: 'fix'` row, so ONE open row is enough to
 * hold L-37's drain (`status.ts:135` — "N tasks still queued") and the phase sign-off
 * (`status.ts:669-686`, `phaseWorkQueued`) forever. Before the sweep's `loop_close_moot_fix_rows` leg
 * (`engine.ts`, the commit beside `loop_reconcile_findings`) the sweep's only task-closing leg was the
 * reconcile's install-settle half, gated `if (finding.state !== 'approved') continue;` — it closed rows
 * only for findings THIS very pass answered with an install. A finding that reached `fixed` on an
 * earlier settle (`phrase/findings.ts:closeFindingWhenGroupsResolved`, `engine.ts:settleFixPrerequisites`),
 * that the Author DISCARDED, or that the Editor DISPUTED orphaned every row that named it, and the
 * planner never dispatches such a row again because nothing owes that finding a pass. That is the
 * second silent deadlock of the class the `ISSUE_HOLDING_STATES` change just removed — the same shape,
 * one table later — so the pins below are written to be read next to that one.
 *
 *   1. THE MOOT SET (`types.ts:MOOT_FIX_TASK_FINDING_STATES`): `fixed`, `discarded`, `disputed` close
 *      their rows on the sweep that follows, with the reason in the row's own history, on a GROUP book
 *      and on a LEGACY one. The leg is deliberately not story-mode-scoped — the orphan comes from a
 *      finding leaving the workable set, not from `group_revisions.finding_refs`, which is the only
 *      reason the reconcile leg above sits inside `isGroupManagedStory` (the P1 vacuity guard in
 *      `group-findings-batch-cap.test.ts`).
 *   2. THE CONTROL, the other side of the set: `unconfirmed`/`confirmed`/`approved` are
 *      `ISSUE_HOLDING_STATES` — live work — and their rows survive the same sweep with their attempts
 *      untouched, and the drain still counts them. Only the install that answers them closes them.
 *   3. THE ORDER: an unserviceable orphan must not buy a P7 Author question on the way out. The leg runs
 *      BEFORE `generateWork`, so `work.ts:openFixTaskOwnerEscalation` reads a queue the row already left
 *      (pinned in the loop-level walk below, where one orphan is owned by a role phase ① cannot run).
 *   4. THE SCENARIO, end to end: a group book carrying a DISPUTED issue and a REPAIRED (`fixed`) issue,
 *      both scoped to `ending`, each with its orphan row, and a Writer pass that answers a third, live
 *      defect. Under the four-state holding set the disputed row vetoed the Clean stamp for `ending`
 *      forever and D-33c refused the Critic's proposal over it, so the Reader's scoring seat never armed
 *      and the book sat on an orphan queue. Under the doctrine it walks: the deep pass FILES the
 *      proposal, every group takes the Clean stamp, the selection completes, the scoring seat arms, and
 *      both orphans are closed as the sweep settles the install.
 *
 * Values were read off the rig (`Temp/coding/probe-orphan.ts`, `probe-control.ts`, `probe-f5c.ts`), not
 * guessed. Finding and task ids are the store's own mint order, group ids are UUIDs, so groups are named
 * by CATALOG KEY and rows are asserted as functions of the rows the store holds.
 */
import { describe, expect, it } from 'vitest';
import { createRig, seedFinding, seedTask, type CrewBehaviour, type Rig } from './mock';
import { generateWork } from './work';
import { drainPreconditions } from './status';
import { FIX_TASK_OWNER_PREFIX } from './work';
import { cleanSelectionOf } from '../phrase/reviewed';
import { sectionScoreClaimKey } from '../phrase/exclusion';
import { groupRevisionVector, groupVectorHash } from '../phrase/revisions';
import { AUTHOR_ATTR } from '../run/mock';
import type { Finding, Task } from '../../shared/types';

/** The commit label the leg writes, pinned so the audit group and the rule cannot drift apart. */
const LEG = 'loop_close_moot_fix_rows';

/**
 * The sentences the leg writes, in full — the `why` IS the product here: it is what the Author reads on
 * the row, and the `disputed` half is the answer to "didn't you throw away my work?" (D-33: a disputed
 * claim is not a defect, and an overturn re-arms the work through the findings).
 */
const consumedWhy = (findingId: string, state: string) =>
    `${findingId} is ${state}, so the fix row that named it is consumed — the defect is answered or retired, and an open row over it holds L-37's drain with nothing left to run (D-11, R3)`;

const disputedWhy = (findingId: string) =>
    `${findingId} is disputed — a disputed claim is not a defect (D-33), so the fix row that named it is moot and is closed here; an Author overturn re-arms the work through the findings, not through this row (D-11, D-34a)`;

/** The phase-① rig both groups of cases use: a waived research leg, one Critic per pass. */
const rigged = (summaryMode: 'groups' | 'sampling', crew: CrewBehaviour = {}): Promise<Rig> =>
    createRig({
        summaryMode,
        summarySampling: 1,
        summaryCritics: 1,
        crew: { researchQuestions: [], ...crew }
    });

/** The catalog row behind a group's key — group ids are UIDs the store mints, and carry no meaning. */
const groupIdOf = (rig: Rig, key: string): string =>
    rig.store.phraseGroups.list().find((group) => group.key === key)!.id;

/** A group's key from its id, so a `group_refs` expectation can be written in words a reader checks. */
const groupKeyOf = (rig: Rig, id: string): string => rig.store.phraseGroups.require(id).key;

/**
 * A finding in one exact state, written through the store rather than raised: the rule under test reads
 * the STORED state (`types.ts:MOOT_FIX_TASK_FINDING_STATES`), not the chain that would have produced it,
 * so seeding pins the rule and not the pipeline. `keys` scopes it to those groups (R3 — a grouped
 * Summary finding is scoped by `group_refs`); absent `keys` leaves it chapter-aimed, the D-11 shape
 * `engine.ts:createWorkForFinding` writes when the fix targets an artifact rather than the Overview.
 */
function seedStateFinding(
    rig: Rig,
    state: Finding['state'],
    fields: { criterion: string; title: string; keys?: string[] }
): Finding {
    const seeded = seedFinding(rig.store, rig.storyId, {
        target_ref: fields.keys === undefined ? 'chapter_1' : 'summary_0',
        criterion_ref: fields.criterion,
        cost: 'major',
        state,
        title: fields.title,
        detail: `${fields.title} — the Overview keeps the valley dry; the Seed drowned it`,
        evidence: `summary_0 / chapter_1: ${fields.title}`,
        fingerprint: `${fields.criterion}|${fields.title}`
    });

    if (fields.keys === undefined) return seeded;

    return rig.store.findings.update(
        seeded.id,
        { group_refs: fields.keys.map((key) => groupIdOf(rig, key)) },
        AUTHOR_ATTR,
        [{ id: seeded.id, rev: seeded.rev }]
    );
}

/** The Writer's row for one finding — the row the sweep is being asked about. */
const seedFixRow = (rig: Rig, finding: Finding, owner_role = 'writer'): Task =>
    seedTask(rig.store, rig.storyId, {
        kind: 'fix',
        title: `fix ${finding.id}: ${finding.title}`,
        detail: `${finding.criterion_ref} on ${finding.target_ref} · ${finding.id}`,
        owner_role,
        finding_ref: finding.id
    });

/** Every task row as `[id, kind, state, finding_ref, attempts]`, in the store's mint order. */
const taskRows = (rig: Rig) =>
    rig.store.tasks
        .list()
        .map((task) => [task.id, task.kind, task.state, task.finding_ref ?? '-', task.attempts ?? 0]);

/**
 * Every row the sweep closed, as `[task_id, commit_label, attribution.run_ref, attribution.why]`.
 * The label is the audit group (`store.ts:139`), `run_ref: null` says the LOOP wrote it rather than a
 * crew run (P11), and the sentence is what the Author reads — all three are the pin, not decoration.
 * `label` narrows the read to one commit, so a control can assert the ABSENCE of this leg's rows while
 * another leg's closes sit next to them.
 */
const closedRows = (rig: Rig, label: string = LEG) =>
    rig.store.journal
        .filter(
            (event) =>
                event.collection === 'tasks' &&
                event.op === 'update' &&
                event.commit_label === label &&
                (event.patch as Partial<Task> | undefined)?.state === 'done'
        )
        .map((event) => [event.id, event.commit_label, event.attribution?.run_ref ?? null, event.attribution?.why ?? '']);

/** The one event that closed a task, however it was closed — for asserting the SETTLE's own leg. */
const closeEventOf = (rig: Rig, taskId: string) =>
    rig.store.journal.find(
        (event) => event.collection === 'tasks' && event.id === taskId && (event.patch as Partial<Task> | undefined)?.state === 'done'
    )!;

/** The findings as `[id, kind, state, group keys]` — kind matters because D-33c reads it. */
const findingRows = (rig: Rig) =>
    rig.store.findings
        .list()
        .map((finding) => [
            finding.id,
            finding.kind ?? 'issue',
            finding.state,
            (finding.group_refs ?? []).map((ref) => groupKeyOf(rig, ref))
        ]);

/** The work list this sweep would offer, as `[kind, claim key]` pairs in dispatch order. */
const seats = (rig: Rig) =>
    generateWork(rig.store, rig.story(), { at: '2026-11-25T10:00:00.000Z', phase: 'summary' }).map(
        (candidate) => [candidate.item.kind, candidate.key] as const
    );

/** The vector of the text that is installed right now — the same read the scoring seat's key is built from. */
const vectorHashOf = (rig: Rig): string => groupVectorHash(groupRevisionVector(rig.store, rig.storyId));

describe('the sweep closes a fix row whose finding stopped being work (D2, D-11, R3)', () => {
    it('closes `fixed`, `discarded` and `disputed` rows on the next sweep, and releases the drain', async () => {
        const rig = await rigged('groups');

        await rig.run();

        expect(rig.store.phraseGroups.list().map((group) => [group.key, group.revision])).toEqual([
            ['premise', 1],
            ['promise', 1],
            ['theme', 1],
            ['tone', 1],
            ['ending', 1]
        ]);

        // The three states of `MOOT_FIX_TASK_FINDING_STATES`, each with its Writer's row. Scoped to
        // `ending` so a group book is honest about them (R3), and NONE of them arms a draft seat: the
        // batch cut reads the holding set (`loop/records.ts:openIssueFindings`), so a moot finding is
        // already invisible to the planner — which is exactly why nothing else would ever close the row.
        const repaired = seedStateFinding(rig, 'fixed', { criterion: 'C-4', title: 'the ending walks back the promise', keys: ['ending'] });
        const retired = seedStateFinding(rig, 'discarded', { criterion: 'C-5', title: 'the ending promises a second map', keys: ['ending'] });
        const denied = seedStateFinding(rig, 'disputed', { criterion: 'C-9', title: 'the ending is too fast', keys: ['ending'] });

        const rows = [repaired, retired, denied].map((finding) => seedFixRow(rig, finding));

        // THE DEADLOCK, in the Author's own words before the sweep: three rows, and the drain names them.
        expect(taskRows(rig)).toEqual(rows.map((task) => [task.id, 'fix', 'open', task.finding_ref, 0]));
        expect(drainPreconditions(rig.store, rig.story()).unmet).toEqual(['3 tasks still queued']);

        await rig.step();

        // All three closed by the leg — one sweep, no install, no crew run.
        expect(taskRows(rig)).toEqual(rows.map((task) => [task.id, 'fix', 'done', task.finding_ref, 0]));
        expect(closedRows(rig)).toEqual([
            [rows[0]!.id, LEG, null, consumedWhy(repaired.id, 'fixed')],
            [rows[1]!.id, LEG, null, consumedWhy(retired.id, 'discarded')],
            [rows[2]!.id, LEG, null, disputedWhy(denied.id)]
        ]);
        // The queue no longer holds the Story: the sentence the drain was saying is gone.
        expect(drainPreconditions(rig.store, rig.story()).unmet).toEqual([]);
        // And the findings themselves are untouched: closing the ROW is not re-deciding the finding.
        expect(findingRows(rig)).toEqual([
            [repaired.id, 'issue', 'fixed', ['ending']],
            [retired.id, 'issue', 'discarded', ['ending']],
            [denied.id, 'issue', 'disputed', ['ending']]
        ]);
    });

    it('leaves the rows of a finding that is still work — the control from the other side of the set', async () => {
        const rig = await rigged('groups');

        await rig.run();

        // `ISSUE_HOLDING_STATES`, one of each, each with its row. Chapter-aimed on purpose: the point is
        // that the ROW survives, and a Summary-scoped live finding would arm the Writer batch and be
        // closed by the INSTALL (`loop_job_result`), which is a different rule and is pinned in
        // `group-findings-batch-cap.test.ts`. Here the sweep is the only thing that could touch them.
        const live = ['approved', 'confirmed', 'unconfirmed'].map((state, index) =>
            seedStateFinding(rig, state as Finding['state'], {
                criterion: `C-${20 + index}`,
                title: `the keeper lies before the storm ${index}`
            })
        );
        const rows = live.map((finding) => seedFixRow(rig, finding));

        expect(drainPreconditions(rig.store, rig.story()).unmet).toContain('3 tasks still queued');

        await rig.step();

        // Still open, still unspent: `approved` work keeps its row until an install answers it, and a
        // `confirmed`/`unconfirmed` row is the same live defect waiting on the Author or the Editor.
        expect(taskRows(rig)).toEqual(rows.map((task) => [task.id, 'fix', 'open', task.finding_ref, 0]));
        // The STATES move (the verify pass confirms the `unconfirmed` row, and the Story's dial
        // auto-approves a confirmed major, D-35) — the ROWS do not. Every one of those states is in
        // `ISSUE_HOLDING_STATES`, which is the set this leg must leave alone.
        expect(findingRows(rig)).toEqual([
            [live[0]!.id, 'issue', 'approved', []],
            [live[1]!.id, 'issue', 'approved', []],
            [live[2]!.id, 'issue', 'confirmed', []]
        ]);
        // The leg wrote NOTHING this sweep — the absence is the control, not an untested path.
        expect(closedRows(rig)).toEqual([]);
        expect(drainPreconditions(rig.store, rig.story()).unmet).toContain('3 tasks still queued');
    });

    it('closes them on a legacy whole-Summary book too — the leg is not a group-book rule', async () => {
        // The contrast with `group-findings-batch-cap.test.ts`'s P1 guard: THAT leg must stay inside
        // `isGroupManagedStory` because its evidence is `group_revisions.finding_refs`, which a legacy
        // book never writes, and acting on the vacuous read would delete the sampling round's fix work.
        // This leg reads row states only, so it has no vacuity to guard — and the orphan is just as real
        // here, where the fix work rides the sampling round rather than a group batch.
        const rig = await rigged('sampling');

        await rig.run();

        expect(rig.store.phraseGroups.list()).toEqual([]);

        const repaired = seedStateFinding(rig, 'fixed', { criterion: 'C-30', title: 'the keeper lies first' });
        const denied = seedStateFinding(rig, 'disputed', { criterion: 'C-31', title: 'the storm arrives twice' });

        const rows = [
            seedFixRow(rig, repaired, 'writer-prose'),
            // The live story's shape: a placeholder row from another subsystem, owned by a role phase ①
            // cannot run. Left open, this row would ALSO buy a P7 Author question (`work.ts:840`); the
            // leg closes it before `generateWork` reads the queue, which is the order the last case pins.
            seedFixRow(rig, denied, 'illustrator')
        ];

        expect(drainPreconditions(rig.store, rig.story()).unmet).toContain('2 tasks still queued');

        await rig.step();

        expect(taskRows(rig)).toEqual(rows.map((task) => [task.id, 'fix', 'done', task.finding_ref, 0]));
        expect(closedRows(rig)).toEqual([
            [rows[0]!.id, LEG, null, consumedWhy(repaired.id, 'fixed')],
            [rows[1]!.id, LEG, null, disputedWhy(denied.id)]
        ]);
        expect(drainPreconditions(rig.store, rig.story()).unmet).toEqual([]);
    });
});

describe('the whole story: a disputed claim, a repaired one, and a fix that lands (D2 × D-33c × D-65 × D-67)', () => {
    it('files the Critic proposal, completes the clean selection, arms the scoring seat, and closes both orphans', async () => {
        // THE BOOK THE OWNER REPORTED. A group-mode Summary, every group written once, carrying a defect
        // the Writer has REPAIRED (`fixed`) and the same section carrying a claim the Editor DISPUTED —
        // both scoped to `ending` — each with a `fix` row nobody will ever dispatch. A third, live defect
        // (`approved`, scoped to `tone`) is the one the sweep actually has work for, and its install is
        // what settles the vector the review and the scoring seat then read.
        // `armed` gates the scripted proposal: `loop/mock.ts` COPIES the crew object into the rig
        // (`options.crew ?? {}`), so the knob has to exist before `createRig` and decide per sweep. The
        // warm-up's deep pass files NOTHING (the Clean stamp's case), and the pass that reviews the vector
        // the fix install writes files the proposal — through the REAL `raiseFinding` tool, because D-33c's
        // rule is a read of the stored rows and a seeded proposal would pin the fixture, not the gate.
        // `cost: minor` because D-33b keeps a proposal out of `critical`; the pin is the KIND.
        let armed = false;
        const crew: CrewBehaviour = {
            researchQuestions: [],
            deepReviewFinds: () =>
                armed
                    ? { cost: 'minor', criterion: 'C-11', title: 'proposal: let the keeper lie first', groupKeys: ['premise'], kind: 'proposal' }
                    : undefined
        };
        const rig = await rigged('groups', crew);

        await rig.run();

        const repaired = seedStateFinding(rig, 'fixed', { criterion: 'C-4', title: 'the ending walks back the promise', keys: ['ending'] });
        const denied = seedStateFinding(rig, 'disputed', { criterion: 'C-9', title: 'the ending is too fast', keys: ['ending'] });
        const owed = seedStateFinding(rig, 'approved', { criterion: 'C-14', title: 'the tone group promises the drowned valley', keys: ['tone'] });

        const orphanRepaired = seedFixRow(rig, repaired, 'writer-prose');
        // Phase ① has no job for `illustrator`, so this row is BOTH an orphan and unserviceable: open, it
        // is the P7 question's input (`work.ts:openFixTaskOwnerEscalation`); closed by the leg first, it
        // never becomes one.
        const orphanDenied = seedFixRow(rig, denied, 'illustrator');
        const liveRow = seedFixRow(rig, owed, 'writer');

        // The deep review of the vector the install writes is the pass that files the proposal.
        armed = true;

        // 1 — the fix pass over `tone`, and the orphans go with the findings they name.
        await rig.step();

        expect(rig.store.phraseGroups.list().map((group) => [group.key, group.revision])).toEqual([
            ['premise', 1],
            ['promise', 1],
            ['theme', 1],
            ['tone', 2],
            ['ending', 1]
        ]);
        // The live defect closed on the install, and ITS row followed it through the settle (`run_ref` =
        // the installing run) — the pre-existing leg, untouched by this change.
        expect(taskRows(rig)).toEqual([
            [orphanRepaired.id, 'fix', 'done', repaired.id, 0],
            [orphanDenied.id, 'fix', 'done', denied.id, 0],
            [liveRow.id, 'fix', 'done', owed.id, 1]
        ]);
        expect(closedRows(rig)).toEqual([
            [orphanRepaired.id, LEG, null, consumedWhy(repaired.id, 'fixed')],
            [orphanDenied.id, LEG, null, disputedWhy(denied.id)]
        ]);
        // The live row's close is the OTHER leg, and it is unchanged: an install closed the finding, and
        // the settle closed the row in the same commit, attributed to the run that installed the answer
        // (`engine.ts:settleJob`, `loop_job_result`).
        const liveClose = closeEventOf(rig, liveRow.id);

        expect(liveClose.commit_label).toBe('loop_job_result');
        expect(liveClose.attribution?.why).toBe(
            `the group install of run ${liveClose.attribution?.run_ref} resolved ${owed.id} in every group it targets, so the task that named it is consumed (R3, D-11, D-34)`
        );

        // 2-4 — the review seat on the new vector, then the deep cross-group pass, which settles the Clean
        // stamps. The scoring seat is armed by the CLEAN SELECTION (`phrase/reviewed.ts:cleanSelectionOf`,
        // read through `loop/work.ts:1156-1175`), so its appearance is the read that the disputed row no
        // longer vetoes `ending`.
        await rig.step();
        await rig.step();
        await rig.step();

        // THE CRITIC FILES THE PROPOSAL IN-RUN. Under the four-state holding set this row does not exist:
        // `tools/reader.ts:raiseFinding` refuses a `kind: proposal` call over an unresolved issue, and a
        // `disputed` issue counted as unresolved, so the pass filed nothing (measured: `Temp/coding/
        // probe-f5c.ts` under the old set has no proposal row at any step).
        expect(findingRows(rig)).toEqual([
            [repaired.id, 'issue', 'fixed', ['ending']],
            [denied.id, 'issue', 'disputed', ['ending']],
            [owed.id, 'issue', 'fixed', ['tone']],
            ['finding_3', 'proposal', 'unconfirmed', []]
        ]);

        // THE CLEAN SELECTION COMPLETES. Under the old set `ending` stays a gap
        // (`{ group_key: 'ending', reason: 'no_clean_revision', issues_open: true }`) for as long as the
        // disputed row stands, because `phrase/reviewed.ts:openIssueGroupIds` reads the same predicate.
        const selection = cleanSelectionOf(rig.store, rig.story());

        expect([selection.complete, selection.gaps]).toEqual([true, []]);

        // AND THE SCORING SEAT ARMS on the clean vector — the phase resumed, which is the whole point of
        // releasing a disputed claim instead of blocking on it.
        expect(seats(rig).filter(([kind]) => kind === 'score_sections')).toEqual([
            ['score_sections', sectionScoreClaimKey(vectorHashOf(rig))]
        ]);

        // AND NOTHING WAS ASKED OF THE AUTHOR on the way: the two orphans closed before `generateWork`
        // read the queue, so the unserviceable one never opened its P7 question.
        const escalations = rig.store.tasks.list().filter((task) => task.kind === 'escalation');

        expect(escalations).toEqual([]);
        expect(escalations.filter((task) => (task.title ?? '').startsWith(FIX_TASK_OWNER_PREFIX))).toEqual([]);
    });
});
