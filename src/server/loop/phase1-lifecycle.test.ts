// Phase ①'s round lifecycle (documents/specifications.md §16.5-§16.7, D-47/D-49/D-52/D-53,
// §15 steps 1 and 10-11's waiting shapes), end to end on the loop rig. Four state-machine rules are
// pinned here, each one a defect the classic gates got wrong in a way the dashboard could see:
//
//   R2a  a clean, fully reviewed round STOPS: the Story waits on the Author's lock and no further run
//        is minted, however many sweeps pass (L-29's gate, L-2's idempotence);
//   R2b  a sampling round whose LEG closed mid-flight — disarmed by a review that filed a blocking
//        suspicion, or spent at the attempt cap — still reaches selection: its drafts are screened and
//        chosen instead of stranding in the round that made them (D-52, §16.6);
//   R2c  a finding is attributed to ONE draft. Written about a draft the loop has set aside, it neither
//        blocks the round nor buys another verification pass, and when the selection retires the draft
//        the finding is retired with it — and so is the fix task it queued (D-52 step 4, P13);
//   R2d  an Editor verification pass that never decides the finding is BOUNDED: `FINDING_VERIFY_CAP`
//        passes, then the crew asks the Author instead of being re-sent every sweep forever (D-33, P7).
//
// Every value asserted below is a store row or a dispatched Work Item. The probes that found these
// defects (Temp/t6/probe3-5.ts, reproducible with `yarn vite-node`) are where the expected values come
// from — each one is what the rule REQUIRES, not what the code happens to emit.
import { describe, expect, it } from 'vitest';

import { createRig, seedFinding, seedTask } from './mock';
import { generateWork, FINDING_VERIFY_STALL_PREFIX } from './work';
import { drainPreconditions } from './status';
import {
    FINDING_VERIFY_CAP,
    findingRevisionScope,
    isSupersededSummaryDraft,
    samplingRoundOf,
    selectedSummaryRevision,
    summaryBlockingFindings,
    unconfirmedBlockingFindings,
    type FindingRevisionScope
} from './records';
import type { Rig } from './mock';
import type { Story } from '../../shared/types';

/**
 * Every run row as its claim key, in the order the sweep started it.
 *
 * Sorted by `created_at` then id — NOT by id alone: the store's ids come from one counter, so
 * `run_10` sorts before `run_2` as text and a family's retries land in the wrong place once a Story
 * has more than nine runs. The clock order is the dispatch order the rules below are about.
 */
function runKeys(rig: Rig, prefix = ''): string[] {
    return rig.store.runs
        .list()
        .filter((run) => (run.work_item_ref ?? '').startsWith(prefix))
        .sort(
            (left, right) =>
                left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id)
        )
        .map((run) => run.work_item_ref ?? run.id);
}

/** The queue as `id:kind:state`, oldest first. */
function taskRows(rig: Rig): string[] {
    return rig.store.tasks
        .list()
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((task) => `${task.id}:${task.kind}:${task.state}`);
}

/** Every Summary draft as `id:round:state` — what each rule below does to the round's drafts. */
function revisionRows(rig: Rig): string[] {
    return rig.store.revisions
        .list()
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((revision) => `${revision.id}:r${revision.round}:${revision.state}`);
}

/** The Story's Summary row (the artifact a phase-① finding targets; `related_refs` names the draft). */
function summaryOf(rig: Rig) {
    const summary = rig.store.summaries.list().find((row) => row.story_id === rig.storyId);

    if (summary === undefined) throw new Error('the rig has no Summary row');

    return summary;
}

function storyOf(rig: Rig): Story {
    return rig.store.stories.require(rig.storyId);
}

/** The carried Summary revision, or a test failure naming the state that should have produced it. */
function carriedOf(rig: Rig, why: string) {
    const selected = selectedSummaryRevision(rig.store, rig.storyId);

    if (selected === undefined) throw new Error(`no selected Summary revision (${why})`);

    return selected;
}

/** The finding ids each gate considers, so a wrong attribution shows up as a wrong list, not a mood. */
function gateRows(rig: Rig) {
    const story = storyOf(rig);

    return {
        blocking: summaryBlockingFindings(rig.store, story, summaryOf(rig).id).map((finding) => finding.id),
        unconfirmed: unconfirmedBlockingFindings(rig.store, story).map((finding) => finding.id)
    };
}

/** What the sweep would dispatch right now — the offers, in the order generation produces them. */
function offers(rig: Rig): string[] {
    return generateWork(rig.store, storyOf(rig), { at: new Date().toISOString(), phase: 'summary' }).map(
        (candidate) => candidate.key
    );
}

/** The two records that arm a refinement round: an approved finding on the carried draft and its fix. */
function armRefinementRound(rig: Rig) {
    const summary = summaryOf(rig);
    const selected = carriedOf(rig, 'arming a refinement round');

    const finding = seedFinding(rig.store, rig.storyId, {
        target_ref: summary.id,
        criterion_ref: 'C-14',
        cost: 'major',
        state: 'approved',
        fingerprint: 'C-14|arm',
        related_refs: [selected.id]
    });
    const task = seedTask(rig.store, rig.storyId, {
        kind: 'fix',
        title: 'fix major: the ending does not pay the promise',
        detail: `C-14 on ${summary.id} · ${summary.id}`,
        owner_role: 'writer',
        finding_ref: finding.id
    });

    return { finding, task, selected };
}

/** A finding the way phase ① files one: the Summary row as target, the draft it read in `related_refs`. */
function seedSummaryFinding(
    rig: Rig,
    input: { fingerprint: string; cost: 'critical' | 'major'; state: 'unconfirmed' | 'confirmed'; refs: string[] }
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

describe('R2a — a clean, fully reviewed Summary stops and awaits the Author', () => {
    it('signs the round off to the Author and mints no further run across repeated sweeps (L-29, L-2)', async () => {
        const rig = await createRig({ summarySampling: 1, summaryReaders: 1 });

        await rig.run();

        const story = storyOf(rig);

        expect({ phase: story.phase, status: story.status, pending: story.pending_kind }).toEqual({
            phase: 'summary',
            status: 'pending',
            pending: 'phase_signoff'
        });

        // The whole ledger the round produced: the research pass, one sample, its screening set, and
        // the deep review of the winner. Nothing else — no verification thread, no sampling retry.
        expect(runKeys(rig)).toEqual([
            'wi_research_1',
            'wi_sample_summary_1_1_1',
            'wi_screen_revision_1_1',
            'wi_review_revision_1_a1'
        ]);
        expect(revisionRows(rig)).toEqual(['revision_1:r1:selected']);
        expect(taskRows(rig)).toEqual([]);

        // L-2's idempotence, measured rather than assumed: a Story waiting on its Author never spends
        // another run waiting. The drain probe's round is still OFFERED (it is the evidence the drain
        // claims), but the sign-off holds dispatch, so the offer never becomes a run and its key never
        // climbs a generation.
        const before = runKeys(rig);

        for (let sweep = 0; sweep < 3; sweep += 1) await rig.step();

        expect(runKeys(rig)).toEqual(before);
        expect(offers(rig)).toEqual(['wi_probe_checker_summary_1', 'wi_probe_reader_summary_1']);
    });
});

describe('R2b — a sampling round whose leg closed mid-flight still reaches selection', () => {
    it('screens and selects a stranded draft instead of waiting on samples the loop stopped buying (D-52, §16.6)', async () => {
        // Three samples per round, one screening Reader: round 1 runs to completion, and the approved
        // finding plus its fix task arm round 2 (`records.ts:samplingArmed`).
        const rig = await createRig({ summarySampling: 3, summaryReaders: 1, crew: { verifyReports: 'silent' } });

        await rig.run();

        const { task } = armRefinementRound(rig);

        // One round-2 sample lands, and the round still owes two more.
        await rig.step();

        expect(storyOf(rig).sampling_round).toBe(1);
        expect(revisionRows(rig)).toEqual(['revision_1:r1:selected', 'revision_4:r2:drafted']);

        // The round is disarmed UNDER ITSELF: a review files a blocking suspicion nobody decides, so
        // the arming rule refuses the next sample. The draft that exists is screened and reviewable,
        // and §16.7's sign-off gate needs a selection the old gate refused because the round was
        // short of its sample count — so the round stranded with its own work unfinished.
        seedSummaryFinding(rig, {
            fingerprint: 'C-14|mid-round',
            cost: 'critical',
            state: 'unconfirmed',
            refs: ['revision_1']
        });

        for (let sweep = 0; sweep < 10; sweep += 1) await rig.step();

        const story = storyOf(rig);

        // The round closed: `revision_4`, the only draft it produced, was screened and selected, and
        // `sampling_round` advanced. Round 1's winner stays as the audit line the history names.
        expect(story.sampling_round).toBe(2);
        expect(revisionRows(rig)).toEqual(['revision_1:r1:selected', 'revision_4:r2:selected']);

        // The stranded draft really was screened — ONE pass, because the Story asks for one Reader, and
        // the family stopped there. An unscreenable draft would have been bought to the screening
        // attempt cap, one job per sweep, which is the treadmill this rule replaces with an answer.
        expect(runKeys(rig, 'wi_screen_')).toEqual([
            'wi_screen_revision_1_1',
            'wi_screen_revision_2_1',
            'wi_screen_revision_3_1',
            'wi_screen_revision_4_1'
        ]);
        // …and the round stopped SAMPLING rather than restarting it: exactly one round-2 attempt.
        expect(runKeys(rig, 'wi_sample_')).toEqual([
            'wi_sample_summary_1_1_1',
            'wi_sample_summary_1_1_2',
            'wi_sample_summary_1_1_3',
            'wi_sample_summary_1_2_1'
        ]);

        // D-47 step 5: the resample answers the fix task its prompt carried, and the sign-off is offered —
        // round is over, the drain is met, and only the Author's lock is left.
        expect(rig.store.tasks.require(task.id).state).toBe('done');
        expect({ status: story.status, pending: story.pending_kind }).toEqual({
            status: 'pending',
            pending: 'phase_signoff'
        });
        expect(drainPreconditions(rig.store, story)).toEqual({ met: true, unmet: [] });
    });
});

describe('R2c — a finding belongs to one draft, and a set-aside draft is nobody\'s work', () => {
    it('splits the three attribution scopes on the records themselves', async () => {
        // Two samples, so round 1 leaves a loser behind in the ledger: the selection truncates the row,
        // and the persisted `sampling_history` is what still says that draft ever existed.
        const rig = await createRig({ summarySampling: 2, summaryReaders: 1 });

        await rig.run();

        const summary = summaryOf(rig);
        const carried = carriedOf(rig, 'attribution scopes');

        expect(revisionRows(rig)).toEqual(['revision_1:r1:selected']);
        expect(storyOf(rig).sampling_history?.map((entry) => `${entry.round}:${entry.samples.map((s) => s.revision_id).join('+')}:${entry.selected}`)).toEqual([
            '1:revision_1+revision_2:revision_1'
        ]);
        expect(isSupersededSummaryDraft(rig.store, storyOf(rig), carried)).toBe(false);

        const scopeOf = (refs?: string[]): FindingRevisionScope => {
            const finding = seedFinding(rig.store, rig.storyId, {
                target_ref: summary.id,
                criterion_ref: 'C-19',
                cost: 'minor',
                state: 'unconfirmed',
                fingerprint: `C-19|${refs?.join('+') ?? 'none'}`,
                ...(refs === undefined ? {} : { related_refs: refs })
            });

            return findingRevisionScope(rig.store, storyOf(rig), finding);
        };

        // `selected` names the draft the Summary carries.
        expect(scopeOf([carried.id])).toBe('selected');
        // `superseded` names a draft this Story has already had and the Summary no longer holds — the
        // row is gone, the audit line is not, and re-reading the kept draft can never decide it.
        expect(scopeOf(['revision_2'])).toBe('superseded');
        // `artifact` is a statement about the Summary as a whole: no refs at all (L-11a's legacy
        // shape), the Summary row itself, or an id this Story never had. All three keep their weight.
        expect(scopeOf([])).toBe('artifact');
        expect(scopeOf()).toBe('artifact');
        expect(scopeOf([summary.id])).toBe('artifact');
        expect(scopeOf(['revision_9'])).toBe('artifact');
    });

    it('neither blocks the round nor buys a verification pass for a finding about a set-aside draft', async () => {
        // `silent`: the Editor never decides anything, so any verify run below is the QUEUE offering
        // work on this finding rather than an answer arriving.
        const rig = await createRig({ summarySampling: 1, summaryReaders: 1, crew: { verifyReports: 'silent' } });

        await rig.run();

        const round1 = carriedOf(rig, 'round 1 selection');

        // Round 2 runs to completion, so `round1` becomes a draft the Summary no longer carries.
        armRefinementRound(rig);
        await rig.run();

        expect(carriedOf(rig, 'round 2 selection').id).toBe('revision_2');

        // The late report of a review that ran while round 1's winner was the carried draft.
        const stale = seedSummaryFinding(rig, {
            fingerprint: 'C-14|stale',
            cost: 'critical',
            state: 'unconfirmed',
            refs: [round1.id]
        });

        expect(findingRevisionScope(rig.store, storyOf(rig), stale)).toBe('superseded');

        for (let sweep = 0; sweep < 4; sweep += 1) await rig.step();

        // The reported contradiction: the dashboard showed "nothing blocking on the selected Summary"
        // while the round was held by this finding. Both gates now read one answer…
        expect(gateRows(rig)).toEqual({ blocking: [], unconfirmed: [] });
        // …the queue stops buying passes for it…
        expect(runKeys(rig, 'wi_verify_')).toEqual([]);
        // …and the phase advances to the lock instead of standing still.
        const story = storyOf(rig);

        expect({ status: story.status, pending: story.pending_kind }).toEqual({
            status: 'pending',
            pending: 'phase_signoff'
        });
        expect(drainPreconditions(rig.store, story)).toEqual({ met: true, unmet: [] });

        // The finding is NOT rewritten or dropped for this: it is still `unconfirmed` on the record and
        // the Author can still decide it. Quietly discarding it would be a machine deleting a defect.
        expect(story.sampling_round).toBe(2);
        expect(rig.store.findings.require(stale.id).state).toBe('unconfirmed');
    });

    it('keeps a finding on the carried draft blocking, verified, and sign-off refused (D-33)', async () => {
        const rig = await createRig({ summarySampling: 1, summaryReaders: 1, crew: { verifyReports: 'silent' } });

        await rig.run();

        const live = seedSummaryFinding(rig, {
            fingerprint: 'C-14|live',
            cost: 'critical',
            state: 'unconfirmed',
            refs: [carriedOf(rig, 'a live finding').id]
        });

        expect(findingRevisionScope(rig.store, storyOf(rig), live)).toBe('selected');

        await rig.step();

        // The same cost and the same target, on the draft that is still carried: it holds the round's
        // gates and buys its pass. The two gates are complementary, so an `unconfirmed` finding is the
        // D-33 hold (the sign-off's `findingsUnconfirmed`), while `summaryBlockingFindings` counts the
        // ones somebody has already decided — the same attribution answers both, as the flip below shows.
        expect(gateRows(rig)).toEqual({ blocking: [], unconfirmed: [live.id] });
        expect(runKeys(rig, 'wi_verify_')).toEqual(['wi_verify_finding_finding_1_1']);

        const story = storyOf(rig);

        expect(drainPreconditions(rig.store, story)).toEqual({
            met: false,
            unmet: ['1 finding still unconfirmed (D-33)']
        });
        expect(story.pending_kind).not.toBe('phase_signoff');

        // The Editor confirms it: the finding moves to the blocking gate, still naming the carried draft.
        rig.store.findings.update(live.id, { state: 'confirmed' }, { why: 'test: the Editor confirmed it' });

        expect(gateRows(rig)).toEqual({ blocking: [live.id], unconfirmed: [] });
    });

    it('retires a finding whose draft the selection truncated, with the fix task it queued (D-52 step 4, P13)', async () => {
        // Two samples in round 2 so the selection has a loser to truncate. The finding naming that loser
        // is seeded while the draft still exists: the retirement happens inside the selection commit,
        // and afterwards the row is gone — which is exactly why it must be attributed then, not later.
        const rig = await createRig({ summarySampling: 2, summaryReaders: 1, crew: { verifyReports: 'silent' } });

        await rig.run();

        expect(revisionRows(rig)).toEqual(['revision_1:r1:selected']);

        armRefinementRound(rig);

        // Run until round 2's second sample exists — the window between the sample landing and the
        // screening that closes the round. The selection cannot have run yet: nobody has screened it.
        let sweep = 0;

        while (sweep < 12 && !rig.store.revisions.list().some((revision) => revision.id === 'revision_4')) {
            await rig.step();
            sweep += 1;
        }

        expect(revisionRows(rig)).toEqual([
            'revision_1:r1:selected',
            'revision_3:r2:drafted',
            'revision_4:r2:drafted'
        ]);

        // A confirmed defect on the draft that will lose, and the fix task its confirmation queued.
        const doomed = seedSummaryFinding(rig, {
            fingerprint: 'C-14|doomed',
            cost: 'major',
            state: 'confirmed',
            refs: ['revision_4']
        });
        const fix = seedTask(rig.store, rig.storyId, {
            kind: 'fix',
            title: 'fix major: the second sample drops the promise',
            detail: `C-14 on ${summaryOf(rig).id} · ${summaryOf(rig).id}`,
            owner_role: 'writer',
            finding_ref: doomed.id
        });

        for (sweep = 0; sweep < 8; sweep += 1) await rig.step();

        // The selection kept round 2's first sample and truncated the second — and with the draft went
        // the finding about it and the work that finding had queued.
        expect(revisionRows(rig)).toEqual(['revision_1:r1:selected', 'revision_3:r2:selected']);
        expect(rig.store.findings.require(doomed.id).state).toBe('discarded');
        expect(rig.store.tasks.require(fix.id).state).toBe('wontfix');

        // A finding naming a truncated draft is inert in every gate: it cannot block the round the
        // truncation just started, and it cannot buy a verification pass for a text nobody holds.
        expect(findingRevisionScope(rig.store, storyOf(rig), rig.store.findings.require(doomed.id))).toBe('superseded');
        expect(gateRows(rig)).toEqual({ blocking: [], unconfirmed: [] });

        const story = storyOf(rig);

        expect({ status: story.status, pending: story.pending_kind }).toEqual({
            status: 'pending',
            pending: 'phase_signoff'
        });
        expect(drainPreconditions(rig.store, story)).toEqual({ met: true, unmet: [] });
    });
});

describe('R2d — an Editor verification pass that never decides the finding is bounded', () => {
    it('spends the budget, then asks the Author instead of buying a pass every sweep (D-33, P7)', async () => {
        // `silent`: the verify run closes without calling a tool — the case that used to loop, because
        // the finding stayed `unconfirmed` and an unconfirmed finding is a D-33 hold.
        const rig = await createRig({ summarySampling: 1, summaryReaders: 1, crew: { verifyReports: 'silent' } });

        await rig.run();

        seedSummaryFinding(rig, {
            fingerprint: 'C-14|undecided',
            cost: 'critical',
            state: 'unconfirmed',
            refs: [carriedOf(rig, 'the undecided finding').id]
        });

        // One pass per attempt, plus the sweep that opens the escalation and the sweeps after it: the
        // claim being tested is that the ledger STOPS growing, so the run has to outlive the cap.
        for (let sweep = 0; sweep < 8; sweep += 1) await rig.step();

        // Exactly the cap, each generation of ONE anchored family: no fifth pass on the sixth sweep,
        // and no second family for the same finding.
        expect(runKeys(rig, 'wi_verify_')).toEqual([
            'wi_verify_finding_finding_1_1',
            'wi_verify_finding_finding_1_2',
            'wi_verify_finding_finding_1_3',
            'wi_verify_finding_finding_1_4'
        ]);
        expect(FINDING_VERIFY_CAP).toBe(4);

        // The crew's question, in the shape the decision tree reads as the Author's turn: ONE row,
        // `blocked` (an `open` escalation is dispatchable work the crew cannot do), and pointed at the
        // finding so the sweep can close it when the finding is decided.
        expect(taskRows(rig)).toEqual(['task_1:escalation:blocked']);

        const question = rig.store.tasks.list()[0];

        expect({
            prefix: question.title.slice(0, FINDING_VERIFY_STALL_PREFIX.length),
            owner: question.owner_role,
            findingRef: question.finding_ref
        }).toEqual({
            prefix: FINDING_VERIFY_STALL_PREFIX,
            owner: 'author',
            findingRef: 'finding_1'
        });

        const story = storyOf(rig);

        // The honest state: not `ready` with nothing to run, and not a `drained` that claims the crew is
        // finished — the drain names what is owed, and the reason line names who is being asked.
        expect(story.status).toBe('pending');
        expect(story.pending_kind).toBe('drained');
        expect(story.status_reason).toContain('the crew asked you');
        expect(drainPreconditions(rig.store, story)).toEqual({
            met: false,
            unmet: ['1 finding still unconfirmed (D-33)']
        });
        expect(offers(rig)).toEqual([]);

        // The answer arrives: the Author discards the defect. The next sweep closes the question and the
        // phase is offered its lock again — a question outliving its answer would hold the Story in
        // "the crew asked you" forever.
        rig.store.findings.update('finding_1', { state: 'discarded' }, { why: 'test: the Author dismissed it' });

        for (let sweep = 0; sweep < 2; sweep += 1) await rig.step();

        expect(taskRows(rig)).toEqual(['task_1:escalation:done']);
        expect(storyOf(rig).pending_kind).toBe('phase_signoff');
        // The budget is not re-spent after the answer either: no further pass was bought.
        expect(runKeys(rig, 'wi_verify_').length).toBe(FINDING_VERIFY_CAP);
    });
});

describe('the round and its sampling leg, read from the ledger', () => {
    it('counts the round in flight as one that has no sampling run of its own yet (D-48, D-52)', async () => {
        const rig = await createRig({ summarySampling: 1, summaryReaders: 1 });

        await rig.run();

        // Round 1 completed, so the round IN FLIGHT is 2 — and round 2 has no sampling run yet, which is
        // the state D-49's arming rule must keep refusing. `samplingRoundOf` is the round the loop works.
        expect(samplingRoundOf(storyOf(rig))).toBe(2);
        expect(runKeys(rig, 'wi_sample_summary_1_2_')).toEqual([]);
        expect(runKeys(rig, 'wi_sample_summary_1_1_')).toEqual(['wi_sample_summary_1_1_1']);
    });
});
