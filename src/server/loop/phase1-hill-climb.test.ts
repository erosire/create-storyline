// H1/R3/R5 — the hill a phase-① round has to climb, at the loop layer.
//
// The integration rows (`src/server/integration/summary-sampling.test.ts`) prove the same rules
// through the real server. This file pins the three decisions the queue and the selector make, where
// they are actually implemented, because those are the rows a future "simplify the selector" change
// would silently break:
//
//   1. A round that was handed fix tasks selects ONLY from candidates its own screening passes
//      certified. The least-bad draft is not installed when it failed the fix (R3).
//   2. A stalled round buys MORE samples — but inside the attempt cap the pipeline already had
//      (`samplingCapOf` = size + `SAMPLING_RETRY_ALLOWANCE`), so the retry is bounded by the existing
//      machinery: no new round cap, no retry loop, one extra sample per sweep (R3).
//   3. A spent cap escalates to the Author, and clearing the escalation re-arms a fresh WAVE instead
//      of installing the draft that failed. Nothing closes until a draft certifies it (R4).
//   4. THE STREAK, not only the cap, ends a wave (the Author's chosen policy): a refinement round that
//      proves nothing better than the accepted draft `SAMPLING_NO_PROGRESS_STREAK` attempts in a row
//      stops there, REGRESSIONS included, and its escalation says so. A round that keeps climbing buys
//      past the static cap (each improvement extends it), and a round the provider never answered keeps
//      its own bound — the static cap, because an unread draft proves nothing either way.
import { describe, expect, it } from 'vitest';

import { createRig, seedFinding, seedTask } from './mock';
import { loopAttr } from './records';
import { drainPreconditions } from './status';
import { generateWork } from './work';
import {
    findingFixWorkSettled,
    openFixTaskIds,
    openResearchFixPrerequisites,
    openUnserviceableFixTasks,
    RESEARCH_PREREQUISITE_CAP,
    roundHasEligibleCandidate,
    roundRequiresCertification,
    roundSampleScores,
    sampleFixDemand,
    samplingArmed,
    samplingCapOf,
    // H2/R2 — the streak that stops a wave early. The escalation text quotes the number, so the test
    // that pins that text reads it from the same constant rather than hard-coding a third copy.
    SAMPLING_NO_PROGRESS_STREAK,
    samplingRoundOf,
    samplingWaveOf,
    selectedSummaryRevision,
    storySummary
} from './records';
import { SAMPLING_FAILURE_PREFIX, SCREENING_PARTIAL_PREFIX, FIX_PREREQUISITE_STALL_PREFIX, FIX_TASK_OWNER_PREFIX } from './work';
import type { Rig } from './mock';
import type { IssueList } from '../../shared/schemas';
import type { SampledFixVerification, Story } from '../../shared/types';

/** What the sweep would dispatch right now, in generation order. */
function offers(rig: Rig, prefix = ''): string[] {
    return generateWork(rig.store, storyOf(rig), { at: new Date().toISOString(), phase: 'summary' })
        .map((candidate) => candidate.key)
        .filter((key) => key.startsWith(prefix));
}

function storyOf(rig: Rig): Story {
    return rig.store.stories.require(rig.storyId);
}

/** The Story's Summary row (§4.2: exactly one), by story rather than by id. */
function summaryOf(rig: Rig) {
    const summary = storySummary(rig.store, rig.storyId);

    if (summary === undefined) throw new Error('the rig has no Summary row');

    return summary;
}

/** Every run row under a claim-key prefix, in clock order, as `key:state`. */
function runs(rig: Rig, prefix: string): string[] {
    return rig.store.runs
        .list()
        .filter((run) => (run.work_item_ref ?? '').startsWith(prefix))
        .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id))
        .map((run) => `${run.work_item_ref}:${run.state}`);
}

/** Every Summary draft as `id:r<round>:<origin>:<state>`. */
function revisionRows(rig: Rig): string[] {
    return rig.store.revisions
        .list()
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((revision) => `${revision.id}:r${revision.round}:${revision.origin}:${revision.state}`);
}

/** The fields the installed Summary carries, so a "nothing was installed" row can name what is. */
function installedPremiseOf(rig: Rig): string {
    const selected = selectedSummaryRevision(rig.store, rig.storyId);

    if (selected === undefined) throw new Error('no selected Summary revision');

    return String((selected.body as { fields?: Record<string, unknown> }).fields?.premise ?? '');
}

/** The two records that arm a refinement round, written the way the dial leaves them (D-34). */
function armRefinementRound(rig: Rig) {
    const summary = summaryOf(rig);
    const selected = selectedSummaryRevision(rig.store, rig.storyId);

    if (selected === undefined) throw new Error('the rig has no selected Summary draft');

    const finding = seedFinding(rig.store, rig.storyId, {
        target_ref: summary.id,
        criterion_ref: 'C-14',
        cost: 'major',
        state: 'approved',
        fingerprint: 'C-14|hill',
        related_refs: [selected.id]
    });
    const task = seedTask(rig.store, rig.storyId, {
        kind: 'fix',
        title: 'fix major: the ending does not pay the promise',
        detail: `C-14 on ${summary.id}`,
        owner_role: 'writer',
        finding_ref: finding.id
    });

    return { finding, task };
}

/** Step until `done` holds; the pipeline dispatches one job per family per sweep, so rows land late. */
async function settleUntil(rig: Rig, done: () => boolean, sweeps = 10): Promise<void> {
    for (let sweep = 0; sweep < sweeps; sweep += 1) {
        if (done()) return;

        await rig.step();
    }

    if (!done()) throw new Error('the sweep never reached the state this row asks about');
}

describe('H1/R3/R4 — a stalled round climbs instead of installing the least-bad draft', () => {
    it('retries past the sample the Author asked for, escalates at the cap, and closes nothing on the way', async () => {
        /** What the round's screening passes say about the repair: flipped once, by the Author's clear. */
        let certified = false;

        const rig = await createRig({
            summarySampling: 1,
            summaryCritics: 1,
            crew: {
                // The certificate is the mock's knob (see `CrewBehaviour.screenFixes`): the drafts are
                // clean on their counts, so the ONLY thing rejecting them is the fix audit — which is
                // exactly the state the old pipeline resolved by installing the least-bad text.
                screenFixes: ({ fixIds }) =>
                    certified
                        ? fixIds.map((fix_ref) => ({
                              fix_ref,
                              status: 'resolved' as const,
                              evidence: 'ending: the flood is her choice, and it pays the map.'
                          }))
                        : fixIds.map((fix_ref) => ({
                              fix_ref,
                              status: 'unresolved' as const,
                              evidence: 'ending: She floods it. — the promise the brief makes is still not paid'
                          }))
            }
        });

        await rig.run();

        // Round 1 is clean and installed, and it owed no certificate: nothing had been asked of it (R5).
        expect(storyOf(rig).sampling_round).toBe(1);
        expect(rig.store.tasks.list()).toEqual([]);

        const { finding, task } = armRefinementRound(rig);
        const cap = samplingCapOf(storyOf(rig));

        // size 1 + `SAMPLING_RETRY_ALLOWANCE` 3: the retry allowance is the bound (R3).
        expect(cap).toBe(4);
        // An empty round cannot require a certificate: the obligation arrives with the first candidate
        // that was handed a fix list, which is the sample the next sweep dispatches.
        expect(roundRequiresCertification(rig.store, rig.storyId, 2)).toBe(false);

        // The round's first sample: one draft, one screening pass, and a certificate that says no. The
        // pipeline is per-draft and one dispatch per family per sweep, so the screen lands a sweep or
        // two after the sample row does.
        await rig.step();

        expect(roundRequiresCertification(rig.store, rig.storyId, 2)).toBe(true);
        await settleUntil(rig, () => rig.store.sampleReviews.list().some((review) => review.revision_ref === 'revision_1'));

        expect(revisionRows(rig)).toEqual(['revision_0:r1:sampled:selected', 'revision_1:r2:refined:drafted']);
        // The review row carries BOTH halves of the certificate: the list the job handed the Critic and
        // the verdict it returned. That pairing is what makes the demand gradeable (§4, H1). Round 1's
        // row declares an empty list and carries no verdicts at all — the difference between "nothing
        // was asked" and "asked and refused", which is what the selector is allowed to tell apart.
        expect(
            rig.store.sampleReviews
                .list()
                .map(
                    (review) =>
                        `${review.revision_ref}:${
                            review.fix_refs === undefined ? 'absent' : `[${review.fix_refs.join('+')}]`
                        }:${
                            review.fix_verifications === undefined
                                ? 'silent'
                                : review.fix_verifications.map((verdict) => `${verdict.fix_ref}=${verdict.status}`).join('+') || 'empty'
                        }`
                )
        ).toEqual(['revision_0:[]:silent', 'revision_1:[task_0]:task_0=unresolved']);
        expect(
            sampleFixDemand(rig.store, rig.storyId, rig.store.revisions.require('revision_1'))
        ).toEqual(['task_0']);
        expect(roundHasEligibleCandidate(rig.store, storyOf(rig), 2)).toBe(false);

        // …and the queue's answer to a stalled round: ANOTHER sample, even though the round already
        // holds the one sample the Author asked for. `have < size` is false here, so this offer comes
        // from the hill-climb clause alone, inside the same cap (`work.ts:phase1Candidates`).
        expect(offers(rig, 'wi_sample_')).toEqual(['wi_sample_summary_0_2_2']);

        // Climb until the allowance is spent, then wait for the last screening pass to answer: the
        // escalation only opens once the round is complete and holds nobody it is allowed to pick.
        await settleUntil(rig, () => runs(rig, 'wi_sample_summary_0_2_').filter((row) => row.endsWith(':torn_down')).length >= cap);

        // Four attempts, and no fifth: the retry is an allowance, not a round cap.
        expect(runs(rig, 'wi_sample_summary_0_2_')).toEqual([
            'wi_sample_summary_0_2_1:torn_down',
            'wi_sample_summary_0_2_2:torn_down',
            'wi_sample_summary_0_2_3:torn_down',
            'wi_sample_summary_0_2_4:torn_down'
        ]);
        expect(offers(rig, 'wi_sample_')).toEqual([]);

        await settleUntil(rig, () => rig.store.tasks.list().some((row) => row.kind === 'escalation'));

        const escalation = rig.store.tasks.list().find((row) => row.kind === 'escalation');

        // R3: the failure is surfaced, and it is the REJECTION escalation rather than the provider one,
        // because the Author's decision is different — settle the tasks, or widen the sampling.
        expect(escalation).toMatchObject({ kind: 'escalation', owner_role: 'author', state: 'open' });
        expect(escalation?.title).toBe(
            `${SAMPLING_FAILURE_PREFIX} 4 attempts — no draft answered the fixes this round was armed with`
        );
        expect(escalation?.detail).toContain('task_0 (unresolved on revision_1)');

        // R4: nothing moved. Four drafts were read and refused; the Summary is still round 1's, the
        // task is still open, the finding is still approved, and the round never advanced.
        expect(storyOf(rig).sampling_round).toBe(1);
        expect(storyOf(rig).sampling_history?.map((line) => line.round)).toEqual([1]);
        expect(rig.store.tasks.require(task.id).state).toBe('open');
        expect(rig.store.findings.require(finding.id).state).toBe('approved');
        expect(rig.store.summaries.require(summaryOf(rig).id).premise).toBe(installedPremiseOf(rig));
        expect(revisionRows(rig)).toEqual([
            'revision_0:r1:sampled:selected',
            'revision_1:r2:refined:drafted',
            'revision_2:r2:refined:drafted',
            'revision_3:r2:refined:drafted',
            'revision_4:r2:refined:drafted'
        ]);

        // The Author's clear (L-36/U-1b) closes the escalation, and the sweep re-arms a fresh wave.
        // `engine.ts:clearPending` would `wontfix` every open task — the fix task included — so this
        // row closes the escalation alone: the point of the row is the wave, not the work queue.
        rig.store.tasks.update(
            escalation!.id,
            { state: 'wontfix' },
            loopAttr('test: the Author cleared the certification escalation (L-36, U-1b)'),
            [{ id: escalation!.id, rev: escalation!.rev }]
        );
        // …and the crew is now a Writer that actually repaired the ending. The clear only bought the
        // attempt: it is the CERTIFICATE that closes the task (R4).
        certified = true;

        await rig.run();

        expect(samplingWaveOf(storyOf(rig))).toBe(1);
        expect(runs(rig, 'wi_sample_summary_0_2_w1_')).toEqual(['wi_sample_summary_0_2_w1_1:torn_down']);
        expect(storyOf(rig).sampling_round).toBe(2);
        expect(rig.store.tasks.require(task.id).state).toBe('done');
        expect(rig.store.findings.require(finding.id).state).toBe('fixed');
        // The four rejected drafts are gone (P13's hard truncation) — which is precisely why the
        // history line of the round that DID select records what each candidate left outstanding.
        expect(revisionRows(rig)).toEqual(['revision_0:r1:sampled:selected', 'revision_5:r2:refined:selected']);
        // The history line names every candidate the round held, including the four it refused — which
        // is the only surviving record once §6.6 deletes their drafts and their reviews (R4).
        expect((storyOf(rig).sampling_history ?? []).map((line) => line.samples.map((sample) => `${sample.revision_id}:${((sample.unresolved_fixes ?? []).join('+')) || 'clear'}`))).toEqual([
            ['revision_0:clear'],
            [
                'revision_1:task_0',
                'revision_2:task_0',
                'revision_3:task_0',
                'revision_4:task_0',
                'revision_5:clear'
            ]
        ]);
    });

    it('leaves a round with nothing to certify on §6.5’s least-bad path (R5)', async () => {
        // No fix task, so no certificate is asked; sample 1 carries a high issue and sample 2 is
        // clean. The round installs the best draft it produced, exactly as it did before H1 — the
        // gate is a floor on the round that owes a repair, not a new rule for every round.
        const rig = await createRig({
            summarySampling: 2,
            summaryCritics: 1,
            crew: {
                // The loop rig hands the screening pass the prompt, not a sample index, so the draft
                // being read is what tells the mock which sibling it is judging (D-21).
                screenAnswer: ({ prompt }): IssueList =>
                    /^premise: sample 1:/m.test(prompt)
                        ? {
                              issues: [
                                  {
                                      severity: 'high',
                                      criterion: 'C-14',
                                      location: 'premise',
                                      quote: 'sample 1: the Seed Brief',
                                      detail: 'the premise drops what the brief makes central'
                                  }
                              ]
                          }
                        : { issues: [] }
            }
        });

        await rig.run();

        expect(storyOf(rig).sampling_round).toBe(1);
        // The clean sibling won on the counts; the loser and its review were truncated (§6.6).
        expect(revisionRows(rig)).toEqual(['revision_1:r1:sampled:selected']);
        expect(rig.store.revisions.require('revision_1').issue_counts).toEqual({ critical: 0, high: 0 });
        expect(rig.store.sampleReviews.list().map((review) => `${review.revision_ref}:${review.issues.length}`)).toEqual([
            'revision_1:0'
        ]);
        // Nothing owed, so nothing to certify — and the round still selected. `sampling_round` is the
        // round that COMPLETED; `samplingRoundOf` is the one now in flight (the parity table in
        // `phase1-round-parity.test.ts`), so the two reading 1 and 2 here is the correct pair.
        expect(roundRequiresCertification(rig.store, rig.storyId, 1)).toBe(false);
        expect(samplingRoundOf(storyOf(rig))).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// H1-C1 (V1 F1/F2) — the two ways the hill could stop being a hill
// ---------------------------------------------------------------------------

describe('H1-C1/F1 — the demand counts only what is STILL owed, so the Author can settle their way out', () => {
    it('finishes the stalled round once the Author discards the fix task the escalation named', async () => {
        // The rejection escalation tells the Author to discard the fix tasks if they are what is wrong.
        // Doing exactly that used to strand the round: its drafts were still graded against the task
        // recorded on their screening rows (`fix_refs`, frozen at dispatch) although it was `wontfix`, so
        // every candidate stayed ineligible, while `samplingArmed` refused another sample (no OPEN fix
        // task), the attempt cap was not spent, and `trySelectSample` had no winner to install. No work,
        // no winner, no escalation — the round-1 Summary sat under a drain that could never clear.
        const rig = await createRig({
            summarySampling: 1,
            summaryCritics: 1,
            crew: {
                // Clean on their counts; refused on the certificate alone — the state that used to be
                // resolved by installing the least-bad text.
                screenFixes: ({ fixIds }) =>
                    fixIds.map((fix_ref) => ({
                        fix_ref,
                        status: 'unresolved' as const,
                        evidence: 'ending: She floods it. — the promise the brief makes is still not paid'
                    }))
            }
        });

        await rig.run();

        const { finding, task } = armRefinementRound(rig);

        await settleUntil(
            rig,
            () => rig.store.tasks.list().some((row) => row.kind === 'escalation' && row.state === 'open'),
            20
        );

        const escalation = rig.store.tasks.list().find((row) => row.kind === 'escalation');

        expect(escalation?.title).toBe(
            `${SAMPLING_FAILURE_PREFIX} 4 attempts — no draft answered the fixes this round was armed with`
        );
        // The durable audit of the refusal, which survives the task it names (P11).
        expect(escalation?.detail).toContain('task_0 (unresolved on revision_1)');
        // The deadlock's shape, before the Author acts: four refused drafts, the round not advanced, and
        // a queue with nothing left to buy.
        expect(revisionRows(rig)).toEqual([
            'revision_0:r1:sampled:selected',
            'revision_1:r2:refined:drafted',
            'revision_2:r2:refined:drafted',
            'revision_3:r2:refined:drafted',
            'revision_4:r2:refined:drafted'
        ]);
        expect(offers(rig, 'wi_sample_')).toEqual([]);

        // -- the Author follows the escalation's own advice -----------------------------------------
        const settledTask = rig.store.tasks.require(task.id);
        const settledFinding = rig.store.findings.require(finding.id);

        rig.store.tasks.update(
            task.id,
            { state: 'wontfix' },
            loopAttr('test: the Author discarded the fix task the escalation named (the advice in its detail)'),
            [{ id: task.id, rev: settledTask.rev }]
        );
        rig.store.findings.update(
            finding.id,
            { state: 'discarded' },
            loopAttr('test: the complaint behind it is discarded with the task (D-34)'),
            [{ id: finding.id, rev: settledFinding.rev }]
        );
        rig.store.tasks.update(
            escalation!.id,
            { state: 'wontfix' },
            loopAttr('test: the Author cleared the certification escalation (L-36, U-1b)'),
            [{ id: escalation!.id, rev: escalation!.rev }]
        );

        await settleUntil(rig, () => storyOf(rig).sampling_round === 2);

        // The round resolves — and it resolves WITHOUT a new wave. `engine.ts:rearmSamplingWave` refuses
        // to bump while `samplingExhausted` is false, and the demand intersection made the round
        // selectable the moment the task was settled: the wave exists to buy retries the round can still
        // spend, and this one had nothing left to buy. Hence no `_w1_` family at all.
        expect(samplingWaveOf(storyOf(rig))).toBe(0);
        expect(runs(rig, 'wi_sample_summary_0_2_w1_')).toEqual([]);
        expect(revisionRows(rig)).toEqual(['revision_0:r1:sampled:selected', 'revision_1:r2:refined:selected']);
        expect(rig.store.revisions.require('revision_1').issue_counts).toEqual({ critical: 0, high: 0 });
        // The INCUMBENT no longer holds the Summary: the draft this round had refused is now the selected
        // one, and §4.2's prose blocks come off its body. The sentence itself reads the same as round 1's,
        // and that is the pipeline's design rather than a bug — the sampler is a byte-identical, seeded
        // prompt whose only diversity knob is `sampleIndex` (§5), and this is round 2's first sample. So
        // the assertion names the record that matters: provenance, not wording.
        expect(selectedSummaryRevision(rig.store, rig.storyId)?.id).toBe('revision_1');
        const installed = String(rig.store.summaries.require(summaryOf(rig).id).premise ?? '');

        expect(installed).toBe(
            String(
                (rig.store.revisions.require('revision_1').body as { fields?: Record<string, unknown> }).fields
                    ?.premise ?? ''
            )
        );
        // A settled row is never re-written by a later selection: the task stays `wontfix` and the
        // finding stays `discarded`, so the Author's decision is not quietly relabelled `done`/`fixed`.
        expect(rig.store.tasks.require(task.id).state).toBe('wontfix');
        expect(rig.store.findings.require(finding.id).state).toBe('discarded');
        // Nothing is left to deadlock the drain: no open question, and no `drafted` Summary row.
        expect(
            rig.store.tasks
                .list()
                .filter((row) => row.kind === 'escalation' && row.state === 'open')
                .map((row) => row.title)
        ).toEqual([]);
        expect(rig.store.revisions.list().filter((row) => row.state === 'drafted').map((row) => row.id)).toEqual([]);
        // The drain's phase-① clauses go quiet too. During the deadlock they were NOT what said "blocked"
        // — clause 3 is gated on `samplingArmed`, which an Author with no open fix task already reads as
        // false, and no screening was owed — the Story was stuck because the round could not select. This
        // assertion pins that no sampling/screening clause comes back unmet afterwards.
        expect(
            drainPreconditions(rig.store, storyOf(rig)).unmet.filter((reason) =>
                /sample|screening/i.test(reason)
            )
        ).toEqual([]);
        // And the P11 line says what the SELECTION saw — with the task settled the round owed nothing, so
        // every candidate reads clear. The refusal is the escalation row's record, above; the history line
        // records unresolved fixes, and at this commit there were none outstanding.
        expect(
            (storyOf(rig).sampling_history ?? []).map((line) =>
                line.samples.map((sample) => `${sample.revision_id}:${(sample.unresolved_fixes ?? []).join('+') || 'clear'}`)
            )
        ).toEqual([['revision_0:clear'], ['revision_1:clear', 'revision_2:clear', 'revision_3:clear', 'revision_4:clear']]);
    });
});

describe('H1-C1/F2 — a refined round that cannot verify never replaces the incumbent', () => {
    it('refuses every draft when the screening leg answers nothing, and escalates instead of installing one', async () => {
        // Every screening answer fails the schema, so NOT ONE `sample_reviews` row is persisted. T12/C's
        // degrade still treats each draft as screened (its screening attempts are spent), and that used to
        // be the fail-open: a refined, entirely unverified draft replaced the incumbent on zero
        // verification. The strict contract is "if it isn't verified, discard the draft and try again".
        const rig = await createRig({
            summarySampling: 1,
            summaryCritics: 1,
            crew: { screenAnswer: () => 'not json' }
        });

        await rig.run();

        // Round 1 keeps the OLD behaviour, and stays that way on purpose: it owed no certificate, so the
        // degrade installs its draft and reports the partial screening. F2 tightens rounds that owe fixes
        // — the distinction is pinned here as well as in `sample-select.test.ts`.
        expect(storyOf(rig).sampling_round).toBe(1);
        expect(revisionRows(rig)).toEqual(['revision_0:r1:sampled:selected']);
        expect(rig.store.sampleReviews.list()).toEqual([]);

        const { finding, task } = armRefinementRound(rig);

        // Four samples, and four SPENT screening families behind each one (critics 1 + the allowance):
        // the screening family dispatches one run per sweep, so this row needs room to breathe.
        await settleUntil(
            rig,
            () =>
                rig.store.tasks
                    .list()
                    .some((row) => row.kind === 'escalation' && (row.title ?? '').startsWith(SAMPLING_FAILURE_PREFIX)),
            40
        );

        // F2 stated at the record level: the round owes the open fix task (the fallback demand — its
        // screening rows declare nothing, because none were written) and NOTHING in it can certify.
        expect(roundRequiresCertification(rig.store, rig.storyId, 2)).toBe(true);
        expect(roundHasEligibleCandidate(rig.store, storyOf(rig), 2)).toBe(false);
        // …so the hill was not climbed and nothing moved: the round-1 Summary still holds the book, the
        // task and the finding are untouched, and the round never advanced.
        expect(storyOf(rig).sampling_round).toBe(1);
        expect(rig.store.tasks.require(task.id).state).toBe('open');
        expect(rig.store.findings.require(finding.id).state).toBe('approved');
        expect(revisionRows(rig)).toEqual([
            'revision_0:r1:sampled:selected',
            'revision_1:r2:refined:drafted',
            'revision_2:r2:refined:drafted',
            'revision_3:r2:refined:drafted',
            'revision_4:r2:refined:drafted'
        ]);
        // Bounded, and surfaced to the Author: four sampling attempts (size 1 + the allowance), no fifth,
        // and one screening family spent per draft — the retry allowance is still the only bound, and the
        // escalation is the existing Author-facing one, so there is no silent competing-draft stall.
        expect(runs(rig, 'wi_sample_summary_0_2_')).toEqual([
            'wi_sample_summary_0_2_1:torn_down',
            'wi_sample_summary_0_2_2:torn_down',
            'wi_sample_summary_0_2_3:torn_down',
            'wi_sample_summary_0_2_4:torn_down'
        ]);
        expect(runs(rig, 'wi_screen_revision_1')).toEqual([
            'wi_screen_revision_1_1:failed',
            'wi_screen_revision_1_2:failed',
            'wi_screen_revision_1_3:failed',
            'wi_screen_revision_1_4:failed'
        ]);
        expect(offers(rig, 'wi_sample_')).toEqual([]);

        const escalations = rig.store.tasks.list().filter((row) => row.kind === 'escalation');

        expect(escalations.map((row) => row.title).sort()).toEqual(
            [
                `${SAMPLING_FAILURE_PREFIX} 4 attempts — no draft answered the fixes this round was armed with`,
                `${SCREENING_PARTIAL_PREFIX} 1 — selection proceeded with partial screening`
            ].sort()
        );
        expect(
            escalations.find((row) => (row.title ?? '').startsWith(SAMPLING_FAILURE_PREFIX))?.detail
        ).toContain(`${task.id} (never screened on revision_1)`);
        // N-1: the draft did not answer `unresolved`, it was never GRADED — and the row says so, because
        // the Author's lever is the provider here, not the draft or the task.
        expect(
            escalations.find((row) => (row.title ?? '').startsWith(SAMPLING_FAILURE_PREFIX))?.detail
        ).not.toContain(`${task.id} (unresolved on revision_1)`);
        // The demand here is the OPEN fix task — the fallback branch, because no screening row was ever
        // written to declare one — so the row can name exactly what each draft failed to answer.
        expect(roundSampleScores(rig.store, rig.storyId, 2).map((scored) => scored.fixesUnresolved)).toEqual([
            [task.id],
            [task.id],
            [task.id],
            [task.id]
        ]);
        // The partial-screening row is scoped to the round that ACTUALLY selected on a partial set: no
        // round-2 selection proceeded, so the strict rule reports a rejection, not a proceed-anyway.
        expect(escalations.some((row) => (row.title ?? '').includes('round 2'))).toBe(false);
    });
});

describe('N-1 — the rejection escalation names the axis that actually failed', () => {
    it('reports the critical/high blocker — not missing verification — when every draft answered the fixes', async () => {
        // The other half of the stall: the certificate is CLEAN on every draft (the rig certifies by
        // default, `mock.ts:CrewBehaviour.screenFixes`) and what throws every candidate off the round is a
        // `high` screening issue. The loop's behaviour was already right — bounded retry, nothing closed,
        // an Author escalation — but its explanation claimed no draft had answered the fixes and that the
        // screening leg never answered, which is the opposite of what the ledger says.
        let clean = false;

        const rig = await createRig({
            summarySampling: 1,
            summaryCritics: 1,
            crew: {
                screenAnswer: () =>
                    clean
                        ? { issues: [] }
                        : {
                              issues: [
                                  {
                                      severity: 'high' as const,
                                      criterion: 'C-14',
                                      location: 'ending',
                                      quote: 'refined: she floods it after all',
                                      detail: 'the ending still takes the choice away from her'
                                  }
                              ]
                          }
            }
        });

        await rig.run();

        const { finding, task } = armRefinementRound(rig);
        const incumbent = installedPremiseOf(rig);

        await settleUntil(
            rig,
            () => rig.store.tasks.list().some((row) => row.kind === 'escalation' && row.state === 'open'),
            20
        );

        // The ledger first, so the text cannot drift from the data: every draft cleared the fix it was
        // handed, and every draft carried exactly one blocking high.
        expect(
            roundSampleScores(rig.store, rig.storyId, 2).map((scored) => ({
                id: scored.revision.id,
                fixRefs: scored.fixRefs,
                fixesCleared: scored.fixesCleared,
                fixesUnresolved: scored.fixesUnresolved,
                critical: scored.critical,
                high: scored.high,
                legacyScreening: scored.legacyScreening,
                eligible: scored.eligible
            }))
        // THREE attempts, not the cap's four: a candidate that introduces a blocking issue is a
        // REGRESSION, and a regression never measures the hill — it is a no-progress attempt
        // (`samplingProgressOf`). Three of those in a row stop the wave (`SAMPLING_NO_PROGRESS_STREAK`),
        // which is the user-chosen policy: retry while the hill climbs, stop when it does not.
        ).toEqual([
            'revision_1',
            'revision_2',
            'revision_3'
        ].map((id) => ({
            id,
            fixRefs: [task.id],
            fixesCleared: [task.id],
            fixesUnresolved: [],
            critical: 0,
            high: 1,
            legacyScreening: false,
            eligible: false
        })));

        const escalation = rig.store.tasks.list().find((row) => row.kind === 'escalation');

        // The title says which axis failed, and it still opens with the reuse key the re-arm matches on
        // (both `openEscalationTask` and `engine.ts:rearmSamplingWave` read only the prefix and `wave:`).
        expect(escalation?.title.startsWith(SAMPLING_FAILURE_PREFIX)).toBe(true);
        expect(escalation?.title).toBe(
            `${SAMPLING_FAILURE_PREFIX} 3 attempts — no draft was both fixed and free of critical/high screening issues`
        );
        expect(escalation?.detail).toContain('wave: 0');
        // The hill, in the numbers the ledger proved: no candidate ever measured it (every one of them
        // introduced a blocking high), three attempts in a row bought nothing, and the static cap of 4
        // is still shown so the Author can see the wave stopped EARLY.
        expect(escalation?.detail).toContain(
            'Hill progress in wave 0: 3 of 4 attempts, best unresolved blocking fix not yet proved, 3 consecutive attempts without improvement.'
        );
        expect(escalation?.detail).toContain(
            `The round stopped because ${SAMPLING_NO_PROGRESS_STREAK} attempts in a row proved nothing better than the accepted draft`
        );
        expect(escalation?.detail).toContain(
            'cleared every fix it was handed, with evidence, and was rejected for its screening issues'
        );
        expect(escalation?.detail).toContain(
            'Every fix this round was armed with was certified with evidence — nothing is outstanding.'
        );
        expect(escalation?.detail).toContain(
            [
                'Rejected on screening issues: revision_1 (0 critical, 1 high);',
                'revision_2 (0 critical, 1 high);',
                'revision_3 (0 critical, 1 high).'
            ].join(' ')
        );
        // The lever names the drafts, not the work list — and it does NOT invite the Author to discard a
        // task this round has already answered.
        expect(escalation?.detail).toContain('The work list is ANSWERED');
        // …and the three claims that were false for this state are gone.
        expect(escalation?.detail).not.toContain('Outstanding:');
        expect(escalation?.detail).not.toContain('nothing was certified');
        expect(escalation?.detail).not.toContain('never screened');
        expect(escalation?.title).not.toContain('no draft answered the fixes');

        // The behaviour the text describes is unchanged in kind — bounded attempts, nothing installed,
        // nothing closed, and the fix task still open (which is what keeps the next round armed) — but the
        // bound that bit here is the no-progress streak, not the cap: three refused drafts and no fourth.
        expect(runs(rig, 'wi_sample_summary_0_2_')).toEqual([
            'wi_sample_summary_0_2_1:torn_down',
            'wi_sample_summary_0_2_2:torn_down',
            'wi_sample_summary_0_2_3:torn_down'
        ]);
        expect(offers(rig, 'wi_sample_')).toEqual([]);
        expect(storyOf(rig).sampling_round).toBe(1);
        expect(rig.store.tasks.require(task.id).state).toBe('open');
        expect(rig.store.findings.require(finding.id).state).toBe('approved');
        expect(installedPremiseOf(rig)).toBe(incumbent);
        expect(revisionRows(rig)).toEqual([
            'revision_0:r1:sampled:selected',
            'revision_1:r2:refined:drafted',
            'revision_2:r2:refined:drafted',
            'revision_3:r2:refined:drafted'
        ]);
        // The history of the refusal names what each draft left outstanding — nothing — on every line,
        // because the rejection is the screening counts and those are recorded per candidate on the
        // escalation row above (H1-C1/F3 keeps the field honest: `[]` means "owed nothing or cleared it",
        // which is exactly this round's story).
        expect(
            (storyOf(rig).sampling_history ?? []).map((line) => line.round)
        ).toEqual([1]);

        // -- and the new title still recovers through the existing path -----------------------------
        // The Author clears the row (wave bump) and the crew writes a clean draft: the certificate was
        // never the problem, so the wave-1 sample closes the task the way test 1's does.
        const fresh = rig.store.tasks.require(escalation!.id);

        rig.store.tasks.update(
            escalation!.id,
            { state: 'wontfix' },
            loopAttr('test: the Author cleared the screening-axis escalation (L-36, U-1b)'),
            [{ id: escalation!.id, rev: fresh.rev }]
        );
        clean = true;

        await settleUntil(rig, () => storyOf(rig).sampling_round === 2, 20);

        expect(samplingWaveOf(storyOf(rig))).toBe(1);
        expect(runs(rig, 'wi_sample_summary_0_2_w1_')).toEqual(['wi_sample_summary_0_2_w1_1:torn_down']);
        // `revision_4`: the ids count creates, not survivors, so the wave-1 draft follows the THREE
        // refused drafts of wave 0 (test 1's winner is `revision_5` because that wave spent four).
        expect(revisionRows(rig)).toEqual(['revision_0:r1:sampled:selected', 'revision_4:r2:refined:selected']);
        expect(rig.store.tasks.require(task.id).state).toBe('done');
        expect(rig.store.findings.require(finding.id).state).toBe('fixed');
        expect(
            (storyOf(rig).sampling_history ?? []).map((line) =>
                line.samples.map((sample) => `${sample.revision_id}:${(sample.unresolved_fixes ?? []).join('+') || 'clear'}`)
            )
        ).toEqual([
            ['revision_0:clear'],
            // Every candidate that competed in round 2 keeps its line, refused or not — and every one of
            // them cleared the fix, so the audit says `clear` on all four while the escalation row above
            // records the screening counts that actually refused them.
            ['revision_1:clear', 'revision_2:clear', 'revision_3:clear', 'revision_4:clear']
        ]);

        // H2 — the same line carries WHY each candidate is on it. The selection commit deletes the refused
        // drafts AND their `sample_reviews` rows (P13/§6.6), so `outcome` + `reject_reason` are the only
        // surviving answer, and they are the selector's own words (`sample-select.ts:scoreSample`), not a
        // paraphrase: these three refused the round for introducing a major the accepted draft did not
        // carry, and the winner is the installed draft, which owed no explanation. The line is stamped
        // with wave 1 — the wave that installed it, after the Author's clear re-armed the hill.
        const hillLine = (storyOf(rig).sampling_history ?? [])[1];

        expect(hillLine.wave).toBe(1);
        expect(
            hillLine.samples.map(
                (sample) => `${sample.revision_id}:${sample.outcome}:${sample.reject_reason ?? 'no reason asked'}`
            )
        ).toEqual([
            'revision_1:rejected:introduced 0 critical / 1 major the accepted draft did not have',
            'revision_2:rejected:introduced 0 critical / 1 major the accepted draft did not have',
            'revision_3:rejected:introduced 0 critical / 1 major the accepted draft did not have',
            'revision_4:accepted:no reason asked'
        ]);
        // And the hill's own numbers on the entry: one attempt bought the install, and the bar the install
        // leaves behind (`0` — the certified fix was the round's only blocking row). `improvements` is 0
        // even though this draft finally climbed: the FIRST regression-free candidate of a wave MEASURES
        // the hill, it does not climb above a bar that did not exist yet (`records.ts:samplingProgressOf`,
        // `sample-select.ts:bestUnresolvedBlocking`) — only a later candidate that beats a proved bar is
        // credited, and that credit is what extends the ceiling.
        expect({
            attempts: hillLine.attempts,
            improvements: hillLine.improvements,
            unresolved_blocking: hillLine.unresolved_blocking
        }).toEqual({ attempts: 1, improvements: 0, unresolved_blocking: 0 });
    });
});

describe('H1/R2 — the fix list a round is actually graded against (records.ts:sampleFixDemand)', () => {
    // The demand decides everything downstream: it is what the Writer is handed, what each Critic must
    // certify, and what the selection commit may close. These rows pin the ladder the evidence reader
    // climbs — the list the Worker was handed, then the ids the verdicts echo, then the Story's own open
    // tasks — because the three answer different questions and only the first two are a promise the round
    // actually made. Every rung is intersected with the STILL-OPEN fix tasks (H1-C1/F1): a task the Author
    // settled stops being an outstanding promise, and a promise that is not outstanding cannot veto a
    // draft, buy a sample, or keep a round from selecting.

    /** One Summary draft, in the shape `engine.ts:settleJob` writes one (§6.4 step 3). */
    function seedDraft(rig: Rig, init: { round: number; origin: 'sampled' | 'refined' }) {
        return rig.store.revisions.create(
            {
                story_id: rig.storyId,
                unit_kind: 'summary',
                unit_ref: summaryOf(rig).id,
                body: { fields: { premise: `round ${init.round} draft` } },
                run_ref: `run_demand_r${init.round}`,
                state: 'drafted',
                round: init.round,
                origin: init.origin,
                verdict_refs: []
            },
            loopAttr('test: seed a Summary draft for the fix-demand ladder')
        );
    }

    /**
     * One screening row carrying EXACTLY the H1 fields named. Omitting a field is how a row written
     * before that field existed looks, and it is the difference between "this pass carried nothing"
     * and "this pass carried it and said nothing" (`sample-select.ts:carryingFix`).
     */
    function seedScreen(
        rig: Rig,
        revisionId: string,
        row: { fixRefs?: string[]; verdicts?: SampledFixVerification[] }
    ) {
        rig.store.sampleReviews.create(
            {
                story_id: rig.storyId,
                revision_ref: revisionId,
                critic: 'critic-screening',
                issues: [],
                valid: true,
                ...(row.fixRefs === undefined ? {} : { fix_refs: row.fixRefs }),
                ...(row.verdicts === undefined ? {} : { fix_verifications: row.verdicts })
            },
            loopAttr('test: seed one screening row for the fix-demand ladder')
        );
    }

    /** The certificate exactly as the selection commit and the sampling queue both read it. */
    function certificateOf(rig: Rig, round: number) {
        const [scored] = roundSampleScores(rig.store, rig.storyId, round);

        return {
            fixRefs: scored.fixRefs,
            fixesCleared: scored.fixesCleared,
            fixesUnresolved: scored.fixesUnresolved,
            eligible: scored.eligible,
            legacyScreening: scored.legacyScreening
        };
    }

    it('grades a refined draft against the list its Worker was handed, not the list the Story owes', async () => {
        const rig = await createRig();
        const draft = seedDraft(rig, { round: 2, origin: 'refined' });

        seedTask(rig.store, rig.storyId, { kind: 'fix', title: 'pay off the 1911 map', finding_ref: 'finding_0' });
        seedTask(rig.store, rig.storyId, { kind: 'fix', title: 'name the informant', finding_ref: 'finding_1' });

        // The round went out before `task_0` was confirmed for this draft's pass, so only `task_1` was
        // ever promised to it. An open task nobody handed the Writer cannot disqualify a draft that
        // ever saw it — and it is what arms the NEXT round (`records.ts:samplingArmed`).
        seedScreen(rig, draft.id, {
            fixRefs: ['task_1'],
            verdicts: [{ fix_ref: 'task_1', status: 'resolved', evidence: 'ending: the informant signs on page 4.' }]
        });

        expect(sampleFixDemand(rig.store, rig.storyId, draft)).toEqual(['task_1']);
        expect(roundRequiresCertification(rig.store, rig.storyId, 2)).toBe(true);
        expect(certificateOf(rig, 2)).toEqual({
            fixRefs: ['task_1'],
            fixesCleared: ['task_1'],
            fixesUnresolved: [],
            eligible: true,
            legacyScreening: false
        });
    });

    it('reads the demand from the verdicts when the reviewer left fix_refs out', async () => {
        const rig = await createRig();
        const draft = seedDraft(rig, { round: 2, origin: 'refined' });

        seedTask(rig.store, rig.storyId, { kind: 'fix', title: 'pay off the 1911 map', finding_ref: 'finding_0' });
        seedScreen(rig, draft.id, {
            verdicts: [{ fix_ref: 'task_0', status: 'unresolved', evidence: 'ending: the map is never opened again.' }]
        });

        expect(sampleFixDemand(rig.store, rig.storyId, draft)).toEqual(['task_0']);
        expect(roundRequiresCertification(rig.store, rig.storyId, 2)).toBe(true);
        // A pass that answered about the fix is not a legacy pass: its failing verdict keeps the draft
        // off the round, which is the rejection that triggers the retry rather than a least-bad install.
        expect(certificateOf(rig, 2)).toEqual({
            fixRefs: ['task_0'],
            fixesCleared: [],
            fixesUnresolved: ['task_0'],
            eligible: false,
            legacyScreening: false
        });
    });

    it('holds a refined draft nobody graded to the Story’s open fix tasks, and refuses it (F2)', async () => {
        const rig = await createRig();
        const draft = seedDraft(rig, { round: 2, origin: 'refined' });

        seedTask(rig.store, rig.storyId, { kind: 'fix', title: 'pay off the 1911 map', finding_ref: 'finding_0' });
        seedTask(rig.store, rig.storyId, { kind: 'fix', title: 'name the informant', finding_ref: 'finding_1' });
        // The screening leg answered with issues only — the rows a pre-H1 store holds, or a provider that
        // dropped the certificate. The arming rule only ran this round because those tasks existed, so
        // they remain the demand.
        seedScreen(rig, draft.id, {});

        expect(sampleFixDemand(rig.store, rig.storyId, draft)).toEqual(['task_0', 'task_1']);
        expect(roundRequiresCertification(rig.store, rig.storyId, 2)).toBe(true);
        // H1-C1/F2 — ungradeable is INELIGIBLE, not clean. This row used to read `eligible: true` on the
        // argument that silence from a Critic who never held a list cannot VETO; it cannot, but it also
        // certifies nothing, and a round that owes a repair does not get to install prose on that basis.
        // The engine's closure gate is the second lock: `fixesCleared` is empty, so both tasks and both
        // findings stay open and auditable whatever the round decides (R4).
        expect(certificateOf(rig, 2)).toEqual({
            fixRefs: ['task_0', 'task_1'],
            fixesCleared: [],
            fixesUnresolved: ['task_0', 'task_1'],
            eligible: false,
            legacyScreening: true
        });
    });

    it('drops a fix task the Author settled from the declared demand (F1: the deadlock’s root)', async () => {
        const rig = await createRig();
        const draft = seedDraft(rig, { round: 2, origin: 'refined' });
        const task = seedTask(rig.store, rig.storyId, {
            kind: 'fix',
            title: 'pay off the 1911 map',
            finding_ref: 'finding_1'
        });

        seedScreen(rig, draft.id, {
            fixRefs: [task.id],
            verdicts: [{ fix_ref: task.id, status: 'unresolved', evidence: 'ending: the map is never opened again.' }]
        });

        // While the task is open, the failed verdict holds the draft off the round.
        expect(sampleFixDemand(rig.store, rig.storyId, draft)).toEqual([task.id]);
        expect(roundRequiresCertification(rig.store, rig.storyId, 2)).toBe(true);
        expect(certificateOf(rig, 2)).toEqual({
            fixRefs: [task.id],
            fixesCleared: [],
            fixesUnresolved: [task.id],
            eligible: false,
            legacyScreening: false
        });

        // The Author discards the task — the advice the escalation itself gives. The screening rows still
        // name it, but a settled task is no longer an outstanding promise, so it cannot veto the round:
        // the intersection with `openFixTaskIds` (the set the Writer's prompt and the arming rule also
        // read) takes it out and the round resolves on its counts.
        rig.store.tasks.update(
            task.id,
            { state: 'wontfix' },
            loopAttr('test: the Author discarded the fix task'),
            [{ id: task.id, rev: task.rev }]
        );

        expect(sampleFixDemand(rig.store, rig.storyId, draft)).toEqual([]);
        expect(roundRequiresCertification(rig.store, rig.storyId, 2)).toBe(false);
        expect(certificateOf(rig, 2)).toEqual({
            fixRefs: [],
            fixesCleared: [],
            fixesUnresolved: [],
            eligible: true,
            // The row still DECLARES a list, so it is not a legacy row — the demand simply came back
            // empty. Only the certificate's contents changed, which is what keeps the audit honest.
            legacyScreening: false
        });
    });

    it('keeps a hand-closed task out of the demand and still demands the one that is open (F1: `done` too)', async () => {
        const rig = await createRig();
        const draft = seedDraft(rig, { round: 2, origin: 'refined' });
        const closed = seedTask(rig.store, rig.storyId, { kind: 'fix', title: 'pay off the 1911 map' });
        const owed = seedTask(rig.store, rig.storyId, { kind: 'fix', title: 'name the informant' });

        // Hand-closing a task (an Author settling it out of band, or a fix pass that reached `done`) takes
        // it out of the demand; the OPEN one is still owed, still out of order in the recorded list, and
        // still has to be certified by every pass that was handed it.
        rig.store.tasks.update(
            closed.id,
            { state: 'done' },
            loopAttr('test: the Author settled this task by hand'),
            [{ id: closed.id, rev: closed.rev }]
        );
        seedScreen(rig, draft.id, {
            fixRefs: [owed.id, closed.id],
            verdicts: [
                { fix_ref: owed.id, status: 'resolved', evidence: 'ending: the informant signs on page 4.' },
                { fix_ref: closed.id, status: 'unresolved', evidence: 'ending: still unearned.' }
            ]
        });

        expect(sampleFixDemand(rig.store, rig.storyId, draft)).toEqual([owed.id]);
        expect(certificateOf(rig, 2)).toEqual({
            fixRefs: [owed.id],
            fixesCleared: [owed.id],
            fixesUnresolved: [],
            eligible: true,
            legacyScreening: false
        });
    });

    it('applies the same intersection to a demand the reviewer echoed per verdict (F1)', async () => {
        const rig = await createRig();
        const draft = seedDraft(rig, { round: 2, origin: 'refined' });
        const task = seedTask(rig.store, rig.storyId, { kind: 'fix', title: 'pay off the 1911 map' });

        seedScreen(rig, draft.id, {
            verdicts: [{ fix_ref: task.id, status: 'unresolved', evidence: 'ending: the map is never opened again.' }]
        });

        expect(sampleFixDemand(rig.store, rig.storyId, draft)).toEqual([task.id]);
        expect(roundHasEligibleCandidate(rig.store, storyOf(rig), 2)).toBe(false);

        rig.store.tasks.update(
            task.id,
            { state: 'wontfix' },
            loopAttr('test: the Author discarded the fix task'),
            [{ id: task.id, rev: task.rev }]
        );

        // Every rung of the ladder is intersected, not just the declared one — otherwise a reviewer that
        // echoes ids per verdict would resurrect a dead demand on a settled task.
        expect(sampleFixDemand(rig.store, rig.storyId, draft)).toEqual([]);
        expect(roundRequiresCertification(rig.store, rig.storyId, 2)).toBe(false);
        expect(roundHasEligibleCandidate(rig.store, storyOf(rig), 2)).toBe(true);
    });

    it('demands nothing of a first-round draft, even while the Story owes a fix', async () => {
        const rig = await createRig();
        const draft = seedDraft(rig, { round: 1, origin: 'sampled' });

        seedTask(rig.store, rig.storyId, { kind: 'fix', title: 'pay off the 1911 map', finding_ref: 'finding_1' });
        seedScreen(rig, draft.id, {});

        // Round 1 defined the defects rather than answering them, so §6.5's least-bad path still stands
        // (R5) — the open task is what arms round 2, not what disqualifies round 1.
        expect(sampleFixDemand(rig.store, rig.storyId, draft)).toEqual([]);
        expect(roundRequiresCertification(rig.store, rig.storyId, 1)).toBe(false);
        expect(certificateOf(rig, 1)).toEqual({
            fixRefs: [],
            fixesCleared: [],
            fixesUnresolved: [],
            eligible: true,
            legacyScreening: true
        });
    });
});

// H2/R1 + H2/R2 — who a phase-① `fix` row belongs to, what the loop does about each owner, and what
// the Story reads as when the loop has run out of ways to serve it. The live round this came from
// (story_16) armed on `task_187 (unresolved on revision_102)`, a row `owner_role: 'researcher'`
// naming a reference the crew could not resolve: every draft was graded against it, every Critic
// answered `unknown` (the honest answer — no draft can ground an external fact), both drafts went
// ineligible, the sampling cap was spent, the Author question that followed was reported as `ready`,
// and the Story sat there claiming Working. Rows (a)-(e) are those four facts, in code.
describe('H2/R1-R2 — the fix owners phase ① has, the work each becomes, and the wait that follows', () => {
    /** An approved finding plus one `fix` row for each of the three owners phase ① has to know. */
    function mixedDemand(rig: Rig) {
        const summary = summaryOf(rig);
        const finding = seedFinding(rig.store, rig.storyId, {
            target_ref: summary.id,
            criterion_ref: 'C-14',
            cost: 'major',
            state: 'approved',
            fingerprint: 'C-14|owners'
        });
        const writer = seedTask(rig.store, rig.storyId, {
            kind: 'fix',
            title: 'fix major: the ending does not pay the promise',
            detail: `C-14 on ${summary.id}`,
            owner_role: 'writer',
            finding_ref: finding.id
        });
        const ground = seedTask(rig.store, rig.storyId, {
            kind: 'fix',
            title: 'source the public-housing pet rule this Summary asserts',
            detail: 'a reference the crew cannot resolve from the Seed alone',
            owner_role: 'researcher',
            finding_ref: finding.id
        });
        const odd = seedTask(rig.store, rig.storyId, {
            kind: 'fix',
            title: 're-triage the intake note',
            detail: 'a row another subsystem left in this Story',
            owner_role: 'editor',
            finding_ref: finding.id
        });

        return { finding, writer, ground, odd };
    }

    /** The Author question this task family opens, newest match — `undefined` until one exists. */
    function questionFor(rig: Rig, prefix: string) {
        return rig.store.tasks
            .list()
            .filter((task) => task.story_id === rig.storyId && task.kind === 'escalation')
            .find((task) => (task.title ?? '').startsWith(prefix));
    }

    // (a) the routing itself: one row per owner, and each set answers for exactly one of them.
    it('demands the Writer row, routes the Researcher row to real work, and hands the rest to the Author', async () => {
        const rig = await createRig({ summarySampling: 1, summaryCritics: 1 });
        const { finding, writer, ground, odd } = mixedDemand(rig);

        // The demand a round is armed and graded against: the Writer's row, and only the Writer's.
        expect(openFixTaskIds(rig.store, rig.storyId)).toEqual([writer.id]);
        // The prerequisite the Researcher can execute, and the row no phase-① job serves at all.
        expect(openResearchFixPrerequisites(rig.store, rig.storyId).map((task) => task.id)).toEqual([ground.id]);
        expect(openUnserviceableFixTasks(rig.store, rig.storyId).map((task) => task.id)).toEqual([odd.id]);
        // The unserviceable row is NOT filtered into silence: the round cannot arm onto an unanswered
        // prerequisite, which is what keeps the Story off the `ready` reading (row (e)) — and the drain
        // probe names the same set (`status.ts:phase1Unmet`) rather than reporting a clean drain.
        expect(samplingArmed(rig.store, storyOf(rig), 2)).toBe(false);

        // Round 1 arms regardless (`samplingArmed` is the REFINEMENT gate), so the prerequisite is
        // routed ALONGSIDE the round-1 sample rather than gating it — and a refinement round, the one
        // that was armed with the row, is the one that waits (the assertion above). The sample outranks
        // the grounding pass in the capacity fill, so what `generateWork` hands this sweep is the
        // sample; the grounding pass is the whole answer once the sampler is gone, which rows (b) and
        // (c) drive end to end (the pass runs on the `wi_research_fix_<task>_a<n>` family, records
        // Knowledge through the task it is handed, and settles or escalates from there).
        expect(offers(rig, 'wi_sample_')).toEqual(['wi_sample_summary_0_1_1']);
        // The grounding pass is offered in the SAME sweep, not instead of the sample: routing does not
        // stall the round, it adds the work that can actually settle the row.
        expect(offers(rig, 'wi_research_fix_')).toEqual([`wi_research_fix_${ground.id}_a1`]);

        // The job the routing actually generates — pinned on the wire, not only behaviourally: existing
        // kind/role/template, the family key, the task and finding it must settle, and the note that
        // states the done condition and forbids the answer that would settle nothing.
        const [job] = generateWork(rig.store, storyOf(rig), { at: new Date().toISOString(), phase: 'summary' })
            .filter((candidate) => candidate.key === `wi_research_fix_${ground.id}_a1`);

        expect(job?.item.kind).toBe('research');
        expect(job?.item.taskRefs).toEqual([ground.id]);
        expect(job?.item.findingRefs).toEqual([finding.id]);
        expect(String(job?.item.note)).toContain('writeKnowledge');
        expect(String(job?.item.note)).toContain('Do NOT call reportNoResearch');
        // F1 — the unit is a WorkUnitRef pointing at the Summary, NOT the bare artifact id:
        // `brief.ts:renderArtifact` renders ARTIFACT UNDER REVIEW from `item.unit.kind` and
        // `renderSelectedIdeas` scopes on `item.unit?.ref`. A string unit matched neither, and the
        // Researcher was dispatched with an empty artifact section (pinned in
        // `run/brief.test.ts`, which shows the Summary fields reaching the brief).
        expect(job?.item.unit).toEqual({ kind: 'summary', ref: 'summary_0' });
    });

    // (b) the prerequisite settles on EVIDENCE: the pass records the fact and its ROW closes. F3 — the
    // FINDING it shares with other fix rows does not: `mixedDemand` hangs three rows (Researcher,
    // Writer, an unserviceable owner) off ONE finding, exactly the live shape (`finding_332` carried the
    // Researcher's `task_187` and the Writer's repair), and the prose repair is still owed.
    it('closes the prerequisite when a pass records the fact, and leaves a shared finding alone', async () => {
        const rig = await createRig({ summarySampling: 1, summaryCritics: 1 });
        const { finding, ground, writer } = mixedDemand(rig);

        await settleUntil(
            rig,
            () => rig.store.tasks.get(ground.id)?.state === 'done',
            24
        );

        expect(rig.store.tasks.get(ground.id)?.state).toBe('done');
        // F3: the FACT is grounded, the complaint is not retired. The finding keeps the state the
        // Editor left it in while any other open fix row names it — marking it `fixed` here would drop
        // a major from the blocking set AND write an unrecoverable line into the closed-fingerprint
        // history the trend reads (L-16a).
        expect(rig.store.findings.get(finding.id)?.state).toBe('approved');
        expect(rig.store.tasks.get(writer.id)?.state).toBe('open');
        expect(findingFixWorkSettled(rig.store, rig.storyId, finding.id, ground.id)).toBe(false);
        // One pass was enough, so the family holds exactly one run — no retry storm behind the fix.
        expect(runs(rig, `wi_research_fix_${ground.id}_`)).toEqual([`wi_research_fix_${ground.id}_a1:torn_down`]);
        // With the prerequisite answered the round is no longer held by it.
        expect(openResearchFixPrerequisites(rig.store, rig.storyId)).toEqual([]);
    });

    // (b2) F3 through the whole lifecycle: the Researcher row settles first, the refined round is still
    // graded only against the Writer's row, and the finding is retired by the LAST settlement — the
    // certified selection — and not before. The still-open third owner in row (b) is the other half of
    // this invariant (selection must not close a finding another owner still holds); row (a) of the H1
    // describe already pins the single-row case closing normally.
    it('retires a finding shared by a Researcher row and a Writer row only after the Writer row certifies (F3)', async () => {
        /** The round's screening answer: flipped once the grounding pass has landed. */
        let certified = false;
        const rig = await createRig({
            summarySampling: 1,
            summaryCritics: 1,
            crew: {
                screenFixes: ({ fixIds }) =>
                    certified
                        ? fixIds.map((fix_ref) => ({
                              fix_ref,
                              status: 'resolved' as const,
                              evidence: 'ending: the flood is her choice, and it pays the map.'
                          }))
                        : fixIds.map((fix_ref) => ({
                              fix_ref,
                              status: 'unresolved' as const,
                              evidence: 'ending: the map is never opened again.'
                          }))
            }
        });

        await rig.run();
        expect(rig.store.tasks.list()).toEqual([]);

        const selected = selectedSummaryRevision(rig.store, rig.storyId);
        const finding = seedFinding(rig.store, rig.storyId, {
            target_ref: summaryOf(rig).id,
            criterion_ref: 'C-14',
            cost: 'major',
            state: 'approved',
            fingerprint: 'C-14|shared',
            related_refs: [selected?.id ?? '']
        });
        // ONE finding, TWO owners — the live shape.
        const ground = seedTask(rig.store, rig.storyId, {
            kind: 'fix',
            title: 'source the public-housing pet rule this Summary asserts',
            owner_role: 'researcher',
            finding_ref: finding.id
        });
        const writer = seedTask(rig.store, rig.storyId, {
            kind: 'fix',
            title: 'fix major: the ending does not pay the promise',
            owner_role: 'writer',
            finding_ref: finding.id
        });

        // The Writer's row is the round's whole demand; the Researcher's is work, not a grading target.
        expect(openFixTaskIds(rig.store, rig.storyId)).toEqual([writer.id]);

        await settleUntil(rig, () => rig.store.tasks.require(ground.id).state === 'done', 30);

        // Grounded, and still not retired: the repair is open.
        expect(rig.store.findings.require(finding.id).state).toBe('approved');
        expect(rig.store.tasks.require(writer.id).state).toBe('open');

        // The drafts cannot certify while the crew is still writing the repair, so the round keeps
        // climbing (no selection, no finding change).
        await settleUntil(rig, () => rig.store.sampleReviews.list().some((review) => (review.fix_refs ?? []).length > 0), 30);
        expect(rig.store.findings.require(finding.id).state).toBe('approved');

        certified = true;
        await settleUntil(rig, () => rig.store.tasks.require(writer.id).state === 'done', 30);

        // The LAST open row naming the finding settled with successful evidence — and only now does the
        // finding go `fixed`, in the same commit that closed the Writer's row.
        expect(rig.store.tasks.require(writer.id).state).toBe('done');
        expect(rig.store.findings.require(finding.id).state).toBe('fixed');
        expect(findingFixWorkSettled(rig.store, rig.storyId, finding.id, writer.id)).toBe(true);
        expect(storyOf(rig).sampling_round).toBe(2);
    });

    // (c) the negative half of (b): a run that ends WITHOUT evidence never settles the row, and the
    // budget is the existing cap — not a new counter, and not unbounded.
    it('never settles a prerequisite on a run that recorded nothing, and stops at the existing cap', async () => {
        const rig = await createRig({
            summarySampling: 1,
            summaryCritics: 1,
            crew: { researchCalls: 'report' }
        });
        const { finding, ground } = mixedDemand(rig);

        // H2/R2's other half, first: while the grounding pass is dispatchable, the sweep DISPATCHES it
        // rather than reading an idle Author wait (step 4 only runs at `dispatchable === 0`, and step 3's
        // drain wins whenever its preconditions hold — `drain.test.ts` pins that precedence).
        const working = await rig.step();

        expect(working.stories[0]?.started).toContain(`wi_research_fix_${ground.id}_a1`);
        expect(working.stories[0]?.status_reason).not.toContain('the crew asked you');

        // `reportNoResearch` writes no Knowledge, which is the pass that "finished" without answering.
        await settleUntil(
            rig,
            () => runs(rig, `wi_research_fix_${ground.id}_`).length === RESEARCH_PREREQUISITE_CAP,
            40
        );

        expect(runs(rig, `wi_research_fix_${ground.id}_`).length).toBe(RESEARCH_PREREQUISITE_CAP);
        expect(rig.store.tasks.get(ground.id)?.state).toBe('open');
        expect(rig.store.findings.get(finding.id)?.state).toBe('approved');
        // The pass counter is journal-derived (restart-safe), and it is exactly at the cap — one more
        // sweep cannot buy a fifth pass.
        expect(runs(rig, `wi_research_fix_${ground.id}_`).sort()).toEqual([
            `wi_research_fix_${ground.id}_a1:torn_down`,
            `wi_research_fix_${ground.id}_a2:torn_down`,
            `wi_research_fix_${ground.id}_a3:torn_down`,
            `wi_research_fix_${ground.id}_a4:torn_down`
        ]);
        expect(offers(rig, 'wi_research_fix_')).toEqual([]);

        // (d) the budget spent with nothing to show for it is the Author's question, in the one row.
        const question = questionFor(rig, FIX_PREREQUISITE_STALL_PREFIX);

        expect(question?.state).toBe('open');
        expect(question?.owner_role).toBe('author');
        expect(question?.title.startsWith(`${FIX_PREREQUISITE_STALL_PREFIX} ${ground.id} —`)).toBe(true);
        expect(question?.detail).toContain(ground.id);
        expect(question?.finding_ref).toBe(finding.id);
        // One row per task, forever: another sweep reuses it instead of stacking a second question.
        const before = question?.id;
        await rig.step();
        expect(questionFor(rig, FIX_PREREQUISITE_STALL_PREFIX)?.id).toBe(before);

        // (e) H2/R2 — the decision machine's turn. The row is deliberately `open` (NOT `blocked`): the
        // sampling escalation's reuse key, its drain-hold, and `rearmSamplingWave`'s clear-and-rearm all
        // key on the open row, so the row's state cannot be what makes it a wait. `decideStory` step 4
        // now reads an OPEN Author-owned escalation as the "the crew asked you" wait exactly when the
        // sweep has nothing to dispatch and no run is live — the `blocked`-only read is what walked past
        // it and left the Story on `ready` (the dashboard's Working pill) over a question only the
        // Author can answer. Pinned on the sweep's own report, which is what the API projects.
        let settled = await rig.step();

        for (let sweep = 0; sweep < 12 && (settled.stories[0]?.started.length ?? 0) > 0; sweep += 1) {
            settled = await rig.step();
        }

        expect(settled.stories[0]?.started).toEqual([]);
        expect(settled.stories[0]?.wanted.map((candidate) => candidate.key)).toEqual([]);

        // `decideStory` names the first open Author-owned question it finds; the sweep's own read is
        // pinned verbatim, and both rows this fixture opens are Author-owned questions.
        const named =
            rig.store.tasks
                .list()
                .find(
                    (task) =>
                        task.story_id === rig.storyId &&
                        task.kind === 'escalation' &&
                        task.state === 'open' &&
                        task.owner_role === 'author'
                ) ?? question;

        expect({
            status: settled.stories[0]?.status,
            pending: settled.stories[0]?.pending_kind,
            blocked: storyOf(rig).blocked_on,
            reason: String(settled.stories[0]?.status_reason)
        }).toEqual({
            status: 'pending',
            pending: 'drained',
            blocked: 'the Author: an open question',
            reason: `the crew asked you: "${named?.title}" (P7) · nothing else is dispatchable (L-37)`
        });
        // The drain stays unmet: the open prerequisite and its question both hold it, so the sweep can
        // never report a clean drain over work the loop still owes.
        expect(drainPreconditions(rig.store, storyOf(rig)).met).toBe(false);
        expect(rig.store.tasks.get(ground.id)?.state).toBe('open');
    });

    // (f) the owner phase ① cannot serve at all: it becomes its own question, and it is never a
    // demand, never a `fix_ref`, and never a draft's failure.
    it('asks the Author about a fix row no phase-① job can serve, and never puts it in front of a draft', async () => {
        const rig = await createRig({ summarySampling: 1, summaryCritics: 1 });
        const { writer, ground, odd } = mixedDemand(rig);

        await settleUntil(rig, () => questionFor(rig, FIX_TASK_OWNER_PREFIX) !== undefined, 24);

        const question = questionFor(rig, FIX_TASK_OWNER_PREFIX);

        expect(question?.state).toBe('open');
        expect(question?.owner_role).toBe('author');
        expect(question?.title.startsWith(`${FIX_TASK_OWNER_PREFIX} ${odd.id} —`)).toBe(true);
        // The unserviceable row is in neither crew set — not the Writer's demand, not the Researcher's
        // prerequisite list — so the only honest move is the question above. (The exact "the Writer's
        // row is demanded and the Researcher's is routed" read is pinned in the first row of this
        // describe; by here the pipeline has already worked those two rows.)
        expect(openUnserviceableFixTasks(rig.store, rig.storyId).map((task) => task.id)).toEqual([odd.id]);
        expect(openFixTaskIds(rig.store, rig.storyId).includes(odd.id)).toBe(false);
        expect(openResearchFixPrerequisites(rig.store, rig.storyId).includes(odd)).toBe(false);
        // The Author settling the row out of band closes the question with it.
        rig.store.tasks.update(
            odd.id,
            { state: 'wontfix' },
            loopAttr('test: the Author discarded the row and answered the question'),
            [{ id: odd.id, rev: odd.rev }]
        );
        await rig.step();

        expect(questionFor(rig, FIX_TASK_OWNER_PREFIX)?.state).toBe('done');
    });
});
