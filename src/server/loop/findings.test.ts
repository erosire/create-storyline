/**
 * Acceptance for the findings half of the loop — §12 rows W4e/W4f and decisions D-33, D-34, D-34a,
 * D-35, D-35b, D-41c, L-25b, L-16a.
 *
 * The dial (`auto_approve`, §4.1) is the whole difference between the three fixtures below, so each one
 * is the same scripted defect on the same Story with a different dial:
 *   A. the dial covers the cost — the row is the LOOP's work, approved with no author tap (D-35);
 *   B. the dial does not cover it — the row is a PROMPT, and `approveFinding` is what starts work (D-34);
 *   C. the Editor disputes it — the row is neither (D-33), and the Story still drains (D-35b).
 *
 * `checkerFinds` files the defect from the checker job, which is what §8's catalogue does for a real
 * checker; the target is the unit that was under judgment, so the fix work the engine creates is aimed
 * at a real artifact (L-11a) rather than at the Story row.
 *
 * Every value asserted below is a row in the store. Run values come from the rig's fix runs, not from
 * what the crew "remembered" doing.
 */
import { describe, expect, it } from 'vitest';

import { createRig, walkToChapters, walkToDrain, type Rig } from './mock';

/** The finding rows as one string each: criterion, target, state, cost, who approved, and sightings. */
function ladder(rig: Rig): string[] {
    return rig.store.findings
        .list()
        .filter((finding) => finding.story_id === rig.storyId)
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(
            (finding) =>
                `${finding.criterion_ref}|${finding.target_ref}:${finding.state}:${finding.cost}:${finding.approved_by ?? 'none'}:seen${finding.seen_count}`
        );
}

/** The fix passes the loop dispatched, as Work Item refs. */
function fixRuns(rig: Rig): string[] {
    return rig.store.runs
        .list()
        .filter((run) => (run.work_item_ref ?? '').startsWith('wi_fix_'))
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((run) => run.work_item_ref ?? '');
}

/** The task queue the loop built, oldest first. */
function taskRows(rig: Rig): string[] {
    return rig.store.tasks
        .list()
        .filter((task) => task.story_id === rig.storyId)
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((task) => `${task.id}:${task.kind}:${task.state}:${task.finding_ref ?? 'none'}:${task.attempts}`);
}

/**
 * The same queue read for §4.7/D-11: the two refs a task is required to carry, in the record's own
 * field order. `taskRows` proves the FINDING link; this proves the criterion link too, which is what
 * lets the Author see which bar the fix work was filed against (D-11's "the queue holds the plan").
 */
function queueRows(rig: Rig): string[] {
    return rig.store.tasks
        .list()
        .filter((task) => task.story_id === rig.storyId)
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(
            (task) =>
                `${task.id}:${task.kind}:${task.state}:${task.criterion_ref ?? 'none'}:${task.finding_ref ?? 'none'}:${task.attempts}`
        );
}

/** The one scripted defect every fixture below files. */
const DEFECT = { cost: 'major' as const, criterion: 'C-13', title: 'the map contradicts the 1911 survey' };

describe('D-35 / W4f — a finding the dial covers becomes work with no author tap', () => {
    /** Phases ① and ② judged, with the covered defect filed at each unit the checker reached. */
    async function worked() {
        const rig = await createRig({ story: { chapter_count: 2 }, crew: { checkerFinds: [DEFECT] } });

        await walkToChapters(rig, 2);

        return rig;
    }

    it('approves on the spot, creates the task, and runs the fix — the Author is never consulted', async () => {
        const rig = await worked();

        // D-35: the dial is ['critical','major'], so a major defect is already authorised work. The
        // attribution is `auto`, never `author` (D-41c keeps the two decisions distinguishable).
        const row = rig.store.findings.list().find((finding) => finding.target_ref === 'summary_1');

        expect(row).toMatchObject({
            id: 'finding_1',
            criterion_ref: 'C-13',
            cost: 'major',
            state: 'fixed',
            approved_by: 'auto',
            seen_count: 1,
            fingerprint: row?.fingerprint
        });
        expect(row?.fingerprint).not.toBe('');

        // D-34: the approval is what creates the Writer work, aimed at the artifact the finding named.
        // Phase ②'s checker filed the same defect against plotline 1, and that row got its own task.
        expect(taskRows(rig)).toEqual(['task_1:fix:done:finding_1:1', 'task_2:fix:done:finding_2:1']);
        expect(rig.store.tasks.get('task_1')?.detail).toContain('C-13 on summary_1');

        // The fix passes really ran, and they are what closed the rows.
        expect(fixRuns(rig)).toEqual(['wi_fix_summary_1_1_finding_1_task_1', 'wi_fix_plotline_1_1_finding_2_task_2']);
    });

    it('aims the fix at the unit that was under judgment, not at the Story row (L-11a, T-12)', async () => {
        const rig = await worked();

        // Phase ②'s checker filed the same defect against each plotline, so each one got its own task
        // against its own unit. A fix task that could not name an artifact would be `blocked` (T-12),
        // and none of these are.
        expect(
            rig.store.tasks
                .list()
                .filter((task) => task.kind === 'fix')
                .map((task) => `${task.finding_ref}:${task.detail?.split(' · ')[0]}`)
                .sort()
        ).toEqual(['finding_1:C-13 on summary_1', 'finding_2:C-13 on plotline_1']);
    });

    it('carries the criterion and the finding on the task row — the queue, not the transcript, is the plan (§4.7, D-11)', async () => {
        const rig = await worked();

        // §4.7 names `criterion_ref` and `finding_ref` on the task record, and D-11 makes the queue the
        // plan the Goal is reachable from. A row that lost either ref would still run, but the Author
        // could no longer read WHICH bar the fix was filed against, and the finding it answers.
        expect(queueRows(rig)).toEqual(['task_1:fix:done:C-13:finding_1:1', 'task_2:fix:done:C-13:finding_2:1']);
        expect(rig.store.tasks.require('task_1')).toMatchObject({
            kind: 'fix',
            owner_role: 'writer',
            criterion_ref: 'C-13',
            finding_ref: 'finding_1',
            title: 'fix major: the map contradicts the 1911 survey',
            detail: 'C-13 on summary_1 · summary_1'
        });
    });

    it('keeps working while covered work is open — a failing criterion is not a drain (L-35, L-25)', async () => {
        const rig = await worked();

        // The sweep, not the lock verb, is what re-derives the reason sentence (L-1: the sweep decides).
        await rig.step();

        const story = rig.story();

        // C-13 fails at every level the crew reached, so the phase Goal is not green and nothing may
        // propose completion. The crew still has the queue in front of it.
        expect({ status: story.status, kind: story.pending_kind, completion: story.completion ?? null }).toEqual({
            status: 'ready',
            kind: 'none',
            completion: null
        });
        // The phase Goal sentence is the whole reason here — C-13 is one of six levels the crew has not
        // made pass yet, and the board shows the count first (G-2's rendered ladder).
        expect(story.status_reason).toBe('0/6 · failing: C-7, C-8, C-9, C-10, C-11, C-13');
    });

    it('a re-claim of a defect the crew already fixed opens a second row the ledger reads as a regression (L-16a, D-16)', async () => {
        const rig = await worked();

        await rig.run(30);

        // The checker re-files the same fingerprint on chapter 1 every pass. §8's dedupe
        // (server/tools/artifacts.ts:708-712) matches rows that are NOT `fixed`, so the open row counts
        // its sightings (D-16) and a re-claim after the fix is a fresh row rather than a zombie.
        expect(ladder(rig)).toEqual([
            'C-13|summary_1:fixed:major:auto:seen1',
            'C-13|plotline_1:fixed:major:auto:seen1',
            'C-13|plotline_2:fixed:major:auto:seen1',
            'C-13|chapter_1:fixed:major:auto:seen2',
            'C-13|chapter_1:approved:major:auto:seen3'
        ]);

        // The second row is work again, and the Story is nowhere near finished.
        expect(taskRows(rig)[4]).toBe('task_5:fix:open:finding_5:0');
        expect(rig.story().status).toBe('ready');
        expect(rig.story().blocked_on).toContain('C-13');
    });
});

describe('D-34 / D-35b — a finding outside the dial is a prompt until the Author answers it', () => {
    /** The §15 walk with the dial narrowed to `critical`: the major defect is not the loop's problem. */
    async function parked() {
        const rig = await createRig({
            story: { chapter_count: 2, auto_approve: ['critical'] },
            crew: { checkerFinds: [DEFECT] }
        });

        await walkToDrain(rig, 2);

        return rig;
    }

    it('drains with the rows awaiting the Author, and names the count where the board reads it', async () => {
        const rig = await parked();
        const story = rig.story();

        expect(ladder(rig)).toEqual([
            'C-13|summary_1:confirmed:major:none:seen1',
            'C-13|plotline_1:confirmed:major:none:seen1',
            'C-13|plotline_2:confirmed:major:none:seen1',
            'C-13|chapter_1:confirmed:major:none:seen2',
            'C-13|chapter_2:confirmed:major:none:seen2',
            'C-13|story_1:confirmed:major:none:seen1'
        ]);

        // A sub-dial finding is not authorised work (L-37 condition 1), so the Story still drains — and
        // the reason says so in the order the Author reads it: worked-out, checked, what is left.
        expect({ status: story.status, kind: story.pending_kind, blocked: story.blocked_on }).toEqual({
            status: 'pending',
            kind: 'drained',
            blocked: '6 findings awaiting you'
        });
        expect(story.status_reason).toContain('no critical left to work on (D-35b)');
        expect(story.status_reason).toContain('6 findings awaiting you');
        // Completion is NOT proposed: the phase Goal is 5/6 because C-13 still fails.
        expect(story.status_reason).toContain('completion not proposed');
        expect(story.completion).toBeUndefined();

        // Nothing was worked: no task, no fix run, and the crew dispatched nothing on the last sweep.
        expect(taskRows(rig)).toEqual([]);
        expect(fixRuns(rig)).toEqual([]);
    });

    it('the approval is what starts Writer work, and the Author answer is on the record (D-34, D-41c)', async () => {
        const rig = await parked();

        await rig.engine.approveFinding('finding_1');

        // The approval queues the work; the loop runs it. `approveFinding` alone would leave the task
        // `open` — D-34's "approval starts Writer work" is about the queue, and the crew does the pass.
        await rig.run(40);

        expect(ladder(rig).slice(0, 1)).toEqual(['C-13|summary_1:fixed:major:author:seen1']);
        expect(taskRows(rig)).toEqual(['task_1:fix:done:finding_1:1']);
        expect(fixRuns(rig)).toEqual(['wi_fix_summary_1_1_finding_1_task_1']);

        // The rest of the tray is still a prompt, one less than before, and the Story is drained again:
        // the fix closed, and an approval that drains again is the loop re-deriving from the records.
        const story = rig.story();

        expect({ status: story.status, kind: story.pending_kind, blocked: story.blocked_on }).toEqual({
            status: 'pending',
            kind: 'drained',
            blocked: '5 findings awaiting you'
        });
    });

    it('the task the Author starts is the same record shape — criterion and finding refs and all (§4.7, D-11, D-34)', async () => {
        const rig = await parked();

        await rig.engine.approveFinding('finding_1');
        await rig.run(40);

        // The two approve paths (the dial's auto-approve and the Author's tap) go through ONE task
        // factory (invalidation.ts:createFixTask), so the row the Author sees carries exactly what the
        // loop's own row carries. A second shape here would be two queue dialects in one store.
        expect(queueRows(rig)).toEqual(['task_1:fix:done:C-13:finding_1:1']);
        expect(rig.store.tasks.require('task_1')).toMatchObject({
            kind: 'fix',
            owner_role: 'writer',
            criterion_ref: 'C-13',
            finding_ref: 'finding_1'
        });
        expect(fixRuns(rig)).toEqual(['wi_fix_summary_1_1_finding_1_task_1']);
    });

    it('accepting completion discards the leftovers and says how many (L-25b)', async () => {
        const rig = await parked();

        await rig.engine.acceptCompletion(rig.storyId, true);

        const story = rig.story();

        expect({
            status: story.status,
            kind: story.pending_kind,
            accepted: story.completion?.accepted,
            // `discarded` is L-30's refusal counter (how many times the Author said "not yet"), and
            // `leftovers` is L-25b's count of what the acceptance threw away. One row carries both, so
            // the number the Author was told about at proposal time is still there afterwards.
            leftovers: story.completion?.leftovers,
            refusals: story.completion?.discarded
        }).toEqual({
            status: 'completed',
            kind: 'none',
            accepted: true,
            // The six rows the Author never answered are what "done" threw away.
            leftovers: { findings: 6, ideas: 0 },
            refusals: 0
        });
        expect(story.status_reason).toBe(
            'the Author accepted completion: 6 findings and 0 Ideas were discarded (L-25b)'
        );
        expect(ladder(rig)).toEqual([
            'C-13|summary_1:discarded:major:none:seen1',
            'C-13|plotline_1:discarded:major:none:seen1',
            'C-13|plotline_2:discarded:major:none:seen1',
            'C-13|chapter_1:discarded:major:none:seen2',
            'C-13|chapter_2:discarded:major:none:seen2',
            'C-13|story_1:discarded:major:none:seen1'
        ]);
    });
});

describe('D-33 / D-35b — a disputed claim is not a defect, and does not hold the drain', () => {
    /** The same Story, with the Editor ruling against the checker on every claim. */
    async function disputed() {
        const rig = await createRig({
            story: { chapter_count: 2 },
            crew: {
                checkerFinds: [DEFECT],
                verdictFor: () => ({
                    verdict: 'disputed' as const,
                    evidence: 'the survey agrees with the map on the page'
                })
            }
        });

        await walkToDrain(rig, 2);

        return rig;
    }

    it('files the Editor verdict on the row, creates no work, and lets the Story drain', async () => {
        const rig = await disputed();

        expect(ladder(rig)).toEqual([
            'C-13|summary_1:disputed:major:none:seen1',
            'C-13|plotline_1:disputed:major:none:seen1',
            'C-13|plotline_2:disputed:major:none:seen1',
            'C-13|chapter_1:disputed:major:none:seen2',
            'C-13|chapter_2:disputed:major:none:seen2',
            'C-13|story_1:disputed:major:none:seen1'
        ]);
        expect(taskRows(rig)).toEqual([]);
        expect(fixRuns(rig)).toEqual([]);

        const story = rig.story();

        expect({ status: story.status, kind: story.pending_kind }).toEqual({ status: 'pending', kind: 'drained' });
        // The leftovers the Author can still act on are counted, but they are not work (D-33).
        expect(story.blocked_on).toBe('the Author: work the leftovers or accept completion');
    });

    it('the Editor triage is final — an approval does not quietly re-cost the claim (D-34a)', async () => {
        const rig = await disputed();

        await rig.engine.approveFinding('finding_1', { note: 'fine, do it' });

        // D-34a: the cost the Editor left standing is the cost the work is done at. An approval that
        // re-costed everything would undo the Editor's judgement forty times a day.
        const row = rig.store.findings.get('finding_1');

        expect({ state: row?.state, cost: row?.cost, approved_by: row?.approved_by }).toEqual({
            state: 'approved',
            cost: 'major',
            approved_by: 'author'
        });

        // Approve-and-recost is a separate act, and it is the only thing that moves the cost.
        await rig.engine.approveFinding('finding_2', { cost: 'critical', by: 'author' });
        expect({
            cost: rig.store.findings.get('finding_2')?.cost,
            state: rig.store.findings.get('finding_2')?.state
        }).toEqual({
            cost: 'critical',
            state: 'approved'
        });
    });
});
