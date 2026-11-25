/**
 * Acceptance for the findings half of the loop — §12 rows W4e/W4f and decisions D-33, D-33d, D-34, D-34a,
 * D-35, D-35b, D-41c, L-25b, L-16a.
 *
 * The dial (`auto_approve`, §4.1) is the whole difference between the three fixtures below, so each one
 * is the same scripted defect on the same Story with a different dial:
 *   A. the dial covers the cost — the row is the LOOP's work, approved with no author tap (D-35);
 *   B. the dial does not cover it — the row is a PROMPT, and `approveFinding` is what starts work (D-34);
 *   C. the Editor disputes it — the row is neither (D-33), and the Story still drains (D-35b).
 *
 * A FOURTH describe covers D-33d from the loop's side: the sweep is the one approval funnel nobody
 * clicks, so it is where "issues are in focus" has to hold even when nothing in the UI is watching.
 *
 * `readerFinds` files the defect from the reader job, which is what §8's catalogue does for a real
 * reader; the target is the unit that was under judgment, so the fix work the engine creates is aimed
 * at a real artifact (L-11a) rather than at the Story row.
 *
 * Every value asserted below is a row in the store. Run values come from the rig's fix runs, not from
 * what the crew "remembered" doing.
 */
import { describe, expect, it } from 'vitest';

import { createRig, walkToChapters, walkToDrain, type Rig } from './mock';
import type { SweepReport } from './types';

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

/**
 * What the DIAL approved on one sweep, straight from the report (L-1: the sweep decides, and its report
 * is what the Author reads). `D-33d` asserts against this rather than the rows alone, because the whole
 * claim is about what the sweep DID on that pass — a row that is merely still `confirmed` proves less
 * than a report that says it was skipped.
 */
function autoApprovedOf(report: SweepReport, storyId: string): string[] {
    return report.stories.find((row) => row.story_id === storyId)?.auto_approved ?? [];
}

/** The one scripted defect every fixture below files. */
const DEFECT = { cost: 'major' as const, criterion: 'C-13', title: 'the map contradicts the 1911 survey' };

describe('D-35 / W4f — a finding the dial covers becomes work with no author tap', () => {
    /** Phases ① and ② judged, with the covered defect filed at each unit the reader reached. */
    async function worked() {
        const rig = await createRig({ story: { chapter_count: 2 }, crew: { readerFinds: [DEFECT] } });

        await walkToChapters(rig, 2);

        return rig;
    }

    it('approves on the spot, creates the task, and runs the fix — the Author is never consulted', async () => {
        const rig = await worked();

        // D-35: the dial is ['critical','major'], so a major defect is already authorised work. The
        // attribution is `auto`, never `author` (D-41c keeps the two decisions distinguishable).
        // Phase ① files nothing here: the deep-review Critic is a Critic, not the reader whose
        // `readerFinds` fixture this is (rig/mock.ts), so the two plotline rows are the whole ladder
        // this walk reaches.
        const row = rig.store.findings.list().find((finding) => finding.target_ref === 'plotline_0');

        expect(row).toMatchObject({
            id: 'finding_0',
            criterion_ref: 'C-13',
            cost: 'major',
            state: 'fixed',
            approved_by: 'auto',
            seen_count: 1,
            fingerprint: row?.fingerprint
        });
        expect(row?.fingerprint).not.toBe('');

        // D-34: the approval is what creates the Writer work, aimed at the artifact the finding named.
        // Phase ②'s reader filed the same defect against each plotline, and each row got its own task.
        expect(taskRows(rig)).toEqual(['task_0:fix:done:finding_0:1', 'task_1:fix:done:finding_1:1']);
        expect(rig.store.tasks.get('task_0')?.detail).toContain('C-13 on plotline_0');

        // The fix passes really ran, and they are what closed the rows.
        expect(fixRuns(rig)).toEqual([
            'wi_fix_plotline_1_1_finding_1_task_1',
            'wi_fix_plotline_0_1_finding_0_task_0'
        ]);
    });

    it('aims the fix at the unit that was under judgment, not at the Story row (L-11a, T-12)', async () => {
        const rig = await worked();

        // Phase ②'s reader filed the same defect against each plotline, so each one got its own task
        // against its own unit. A fix task that could not name an artifact would be `blocked` (T-12),
        // and none of these are.
        expect(
            rig.store.tasks
                .list()
                .filter((task) => task.kind === 'fix')
                .map((task) => `${task.finding_ref}:${task.detail?.split(' · ')[0]}`)
                .sort()
        ).toEqual(['finding_0:C-13 on plotline_0', 'finding_1:C-13 on plotline_1']);
    });

    it('carries the criterion and the finding on the task row — the queue, not the transcript, is the plan (§4.7, D-11)', async () => {
        const rig = await worked();

        // §4.7 names `criterion_ref` and `finding_ref` on the task record, and D-11 makes the queue the
        // plan the Goal is reachable from. A row that lost either ref would still run, but the Author
        // could no longer read WHICH bar the fix was filed against, and the finding it answers.
        expect(queueRows(rig)).toEqual([
            'task_0:fix:done:C-13:finding_0:1',
            'task_1:fix:done:C-13:finding_1:1'
        ]);
        expect(rig.store.tasks.require('task_0')).toMatchObject({
            kind: 'fix',
            owner_role: 'writer',
            criterion_ref: 'C-13',
            finding_ref: 'finding_0',
            title: 'fix major: the map contradicts the 1911 survey',
            detail: 'C-13 on plotline_0 · plotline_0'
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

        // The reader re-files the same fingerprint on chapter 1 every pass. §8's dedupe
        // (server/tools/artifacts.ts:708-712) matches rows that are NOT `fixed`, so a re-claim
        // after a fix opens a FRESH row instead of resurrecting the closed one (L-16a, D-16).
        // The two untouched rows are the first sighting and one same-fingerprint repeat.
        const chapter = ladder(rig).filter((row) => row.includes('|chapter_0:'));

        expect(chapter).toContain('C-13|chapter_0:fixed:major:auto:seen2');
        expect(chapter.length).toBeGreaterThan(2);

        // Every re-claim after the first is a new row with a new task behind it — the loop does
        // not silently treat a fixed finding as still work, and it does not lose the regression.
        // The walk spends 30 sweeps here, so the exact rows are pinned: the first fixed sighting
        // (seen twice), six fixed re-claims, and the newest re-raise still open.
        expect(chapter).toEqual([
            'C-13|chapter_0:fixed:major:auto:seen2',
            'C-13|chapter_0:fixed:major:auto:seen1',
            'C-13|chapter_0:fixed:major:auto:seen1',
            'C-13|chapter_0:fixed:major:auto:seen1',
            'C-13|chapter_0:fixed:major:auto:seen1',
            'C-13|chapter_0:fixed:major:auto:seen1',
            'C-13|chapter_0:confirmed:major:none:seen1'
        ]);

        const regression = rig.store.findings.list().find((finding) => finding.id === 'finding_8');

        expect(regression).toMatchObject({ target_ref: 'chapter_0', criterion_ref: 'C-13', cost: 'major' });

        // The re-raise is a row of its own with its own task behind it: finding_8 has not been
        // approved yet (the 30-sweep window closes first), and every earlier re-claim ran a fix.
        expect(taskRows(rig)).toEqual([
            'task_0:fix:done:finding_0:1',
            'task_1:fix:done:finding_1:1',
            'task_2:fix:done:finding_2:1',
            'task_3:fix:done:finding_3:1',
            'task_4:fix:done:finding_4:1',
            'task_5:fix:done:finding_5:1',
            'task_6:fix:done:finding_6:1',
            'task_7:fix:done:finding_7:1'
        ]);
        expect(rig.story().status).toBe('ready');
        expect(rig.story().blocked_on).toContain('C-13');
    });
});

describe('D-34 / D-35b — a finding outside the dial is a prompt until the Author answers it', () => {
    /** The §15 walk with the dial narrowed to `critical`: the major defect is not the loop's problem. */
    async function parked() {
        const rig = await createRig({
            story: { chapter_count: 2, auto_approve: ['critical'] },
            crew: { readerFinds: [DEFECT] }
        });

        await walkToDrain(rig, 2);

        return rig;
    }

    it('drains with the rows awaiting the Author, and names the count where the board reads it', async () => {
        const rig = await parked();
        const story = rig.story();

        expect(ladder(rig)).toEqual([
            'C-13|plotline_0:confirmed:major:none:seen1',
            'C-13|plotline_1:confirmed:major:none:seen1',
            'C-13|chapter_0:confirmed:major:none:seen2',
            'C-13|chapter_1:confirmed:major:none:seen2',
            'C-13|story_0:confirmed:major:none:seen1'
        ]);

        // A sub-dial finding is not authorised work (L-37 condition 1), so the Story still drains — and
        // the reason says so in the order the Author reads it: worked-out, checked, what is left.
        expect({ status: story.status, kind: story.pending_kind, blocked: story.blocked_on }).toEqual({
            status: 'pending',
            kind: 'drained',
            blocked: '5 findings awaiting you'
        });
        expect(story.status_reason).toContain('no critical left to work on (D-35b)');
        expect(story.status_reason).toContain('5 findings awaiting you');
        // Completion is NOT proposed: the phase Goal is 5/6 because C-13 still fails.
        expect(story.status_reason).toContain('completion not proposed');
        expect(story.completion).toBeUndefined();

        // Nothing was worked: no task, no fix run, and the crew dispatched nothing on the last sweep.
        expect(taskRows(rig)).toEqual([]);
        expect(fixRuns(rig)).toEqual([]);
    });

    it('the approval is what starts Writer work, and the Author answer is on the record (D-34, D-41c)', async () => {
        const rig = await parked();

        await rig.engine.approveFinding('finding_0');

        // The approval queues the work; the loop runs it. `approveFinding` alone would leave the task
        // `open` — D-34's "approval starts Writer work" is about the queue, and the crew does the pass.
        await rig.run(40);

        expect(ladder(rig).slice(0, 1)).toEqual(['C-13|plotline_0:fixed:major:author:seen1']);
        expect(taskRows(rig)).toEqual(['task_0:fix:done:finding_0:1']);
        expect(fixRuns(rig)).toEqual(['wi_fix_plotline_0_1_finding_0_task_0']);

        // The rest of the tray is still a prompt, one less than before, and the Story is drained again:
        // the fix closed, and an approval that drains again is the loop re-deriving from the records.
        const story = rig.story();

        expect({ status: story.status, kind: story.pending_kind, blocked: story.blocked_on }).toEqual({
            status: 'pending',
            kind: 'drained',
            blocked: '4 findings awaiting you'
        });
    });

    it('the task the Author starts is the same record shape — criterion and finding refs and all (§4.7, D-11, D-34)', async () => {
        const rig = await parked();

        await rig.engine.approveFinding('finding_0');
        await rig.run(40);

        // The two approve paths (the dial's auto-approve and the Author's tap) go through ONE task
        // factory (invalidation.ts:createFixTask), so the row the Author sees carries exactly what the
        // loop's own row carries. A second shape here would be two queue dialects in one store.
        expect(queueRows(rig)).toEqual(['task_0:fix:done:C-13:finding_0:1']);
        expect(rig.store.tasks.require('task_0')).toMatchObject({
            kind: 'fix',
            owner_role: 'writer',
            criterion_ref: 'C-13',
            finding_ref: 'finding_0'
        });
        expect(fixRuns(rig)).toEqual(['wi_fix_plotline_0_1_finding_0_task_0']);
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
            // The five rows the Author never answered are what "done" threw away.
            leftovers: { findings: 5, ideas: 0 },
            refusals: 0
        });
        expect(story.status_reason).toBe(
            'the Author accepted completion: 5 findings and 0 Ideas were discarded (L-25b)'
        );
        expect(ladder(rig)).toEqual([
            'C-13|plotline_0:discarded:major:none:seen1',
            'C-13|plotline_1:discarded:major:none:seen1',
            'C-13|chapter_0:discarded:major:none:seen2',
            'C-13|chapter_1:discarded:major:none:seen2',
            'C-13|story_0:discarded:major:none:seen1'
        ]);
    });
});

describe('D-33 / D-35b — a disputed claim is not a defect, and does not hold the drain', () => {
    /** The same Story, with the Editor ruling against the reader on every claim. */
    async function disputed() {
        const rig = await createRig({
            story: { chapter_count: 2 },
            crew: {
                readerFinds: [DEFECT],
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
            'C-13|plotline_0:disputed:major:none:seen1',
            'C-13|plotline_1:disputed:major:none:seen1',
            'C-13|chapter_0:disputed:major:none:seen2',
            'C-13|chapter_1:disputed:major:none:seen2',
            'C-13|story_0:disputed:major:none:seen1'
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

        await rig.engine.approveFinding('finding_0', { note: 'fine, do it' });

        // D-34a: the cost the Editor left standing is the cost the work is done at. An approval that
        // re-costed everything would undo the Editor's judgement forty times a day.
        const row = rig.store.findings.get('finding_0');

        expect({ state: row?.state, cost: row?.cost, approved_by: row?.approved_by }).toEqual({
            state: 'approved',
            cost: 'major',
            approved_by: 'author'
        });

        // Approve-and-recost is a separate act, and it is the only thing that moves the cost.
        await rig.engine.approveFinding('finding_1', { cost: 'critical', by: 'author' });
        expect({
            cost: rig.store.findings.get('finding_1')?.cost,
            state: rig.store.findings.get('finding_1')?.state
        }).toEqual({
            cost: 'critical',
            state: 'approved'
        });
    });
});

// ── D-33d in the loop: the dial is not a side door around issues-in-focus ────────────────────────
//
// WHY THIS ROW EXISTS: D-33d is enforced in four places, and the dial sweep is the one nobody clicks.
// The sweep used to approve every `confirmed` row whose cost the dial covered, kind-blind, so a Story with
// five confirmed defects and one `major` PROPOSAL spent the round's Writer capacity on the suggestion —
// the exact failure the Critic-side rule (D-33c) prevents at filing time, arriving from the other side.
// The sweep cannot refuse the way the tool does (one commit over the whole Story's tray: a throw would
// abort the batch and strand the issues), so it SKIPS: the proposal stays `confirmed`, and the report
// says what it did.
describe('D-33d — the dial approves the issues before it approves a proposal', () => {
    /**
     * One confirmed ISSUE and one confirmed PROPOSAL on the same unit at the same cost, on a Story whose
     * dial covers that cost. Seeded straight into the store rather than filed through the crew: the rule
     * is about the ROWS the sweep reads, and the two rows are identical except for `kind` — anything else
     * and a passing test could be proving something about cost or target instead of about D-33d.
     */
    async function tray() {
        const rig = await createRig({ story: { chapter_count: 2 } });

        for (const kind of ['issue', 'proposal'] as const) {
            rig.store.findings.create(
                {
                    story_id: rig.storyId,
                    target_ref: 'plotline_0',
                    criterion_ref: 'C-13',
                    title: kind === 'issue' ? 'the map contradicts the 1911 survey' : 'open the book on the ridge',
                    evidence: 'C-13 says the survey is quoted; it is not.',
                    cost: 'major',
                    kind,
                    fingerprint: `fp_d33d_${kind}`,
                    state: 'confirmed',
                    seen_count: 1
                },
                { why: 'seed: the dial sweep gate (D-33d)' }
            );
        }

        return rig;
    }

    /** `[id]|kind:state:who` — the two columns this rule turns on, plus what moved them. */
    const trayRows = (rig: Rig): string[] =>
        rig.store.findings
            .list()
            .filter((finding) => finding.story_id === rig.storyId)
            .sort((left, right) => left.id.localeCompare(right.id))
            .map((finding) => `${finding.id}|${finding.kind ?? 'issue'}:${finding.state}:${finding.approved_by ?? 'none'}`);

    it('approves the issue and leaves the proposal confirmed — and reports only what it did', async () => {
        const rig = await tray();

        const report = await rig.step();

        // The sweep's own report is the honest witness here: a skipped row is ABSENT from `auto_approved`
        // rather than named in it, which is the shape a batch skip has to have.
        expect(autoApprovedOf(report, rig.storyId)).toEqual(['finding_0']);
        expect(trayRows(rig)).toEqual([
            'finding_0|issue:approved:auto',
            'finding_1|proposal:confirmed:none'
        ]);

        // And the skip is not a silent loss: the proposal is still `confirmed`, so U-10's queue, the
        // Author's tray and the next sweep all still see it. (`trayRows` above is what pins `approved_by`
        // — an untouched row simply has no value for it, which `toMatchObject` cannot state.)
        expect(rig.store.findings.require('finding_1')).toMatchObject({
            kind: 'proposal',
            state: 'confirmed',
            cost: 'major',
            target_ref: 'plotline_0'
        });
    });

    it('the next sweep approves the proposal the moment the issue stops being an issue', async () => {
        const rig = await tray();

        await rig.step();

        // `approved` is NOT a release: the issue is now the loop's work, and work that has not landed is
        // still an unresolved defect. Closing it (`fixed`) is what releases the proposal.
        const issue = rig.store.findings.require('finding_0');

        rig.store.findings.update(
            'finding_0',
            { state: 'fixed' },
            { why: 'seed: the repair landed (D-33d)' },
            [{ id: issue.id, rev: issue.rev }]
        );

        const second = await rig.step();

        expect(autoApprovedOf(second, rig.storyId)).toEqual(['finding_1']);
        expect(trayRows(rig)).toEqual(['finding_0|issue:fixed:auto', 'finding_1|proposal:approved:auto']);
    });

    it('an approved issue still holds the proposal, so only `fixed`/`discarded` release it', async () => {
        const rig = await tray();

        await rig.step();

        // A second sweep with the issue merely `approved` — work promised, not work done — must not move
        // the proposal either. This is the case the dial used to get wrong on its own: the row the sweep
        // had already handled reads as "moving" and the suggestion looked next in line.
        const again = await rig.step();

        expect(autoApprovedOf(again, rig.storyId)).toEqual([]);
        expect(trayRows(rig)).toEqual(['finding_0|issue:approved:auto', 'finding_1|proposal:confirmed:none']);
    });
});
