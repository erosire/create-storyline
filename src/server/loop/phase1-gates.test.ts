// Phase ①'s degradation and retry gates, pinned as regression rows (T12/B…E, H6).
//
// These are the rules that decide how a round ENDS when the provider misbehaves, and each one was
// verified by an independent review to be missing or wrong in the shipped build. The file is a
// companion to `phase1-research.test.ts` (the happy path) and `sample-select.test.ts` (the ranking):
//
//   B — a backtrack/`editSeed` deletes the revisions it scraps AND their `sample_reviews` rows;
//   C — screening exhaustion degrades to a partial-review selection + ONE Author escalation;
//   D — a round may not select before its full sample set exists unless sampling is exhausted;
//   E — a cleared sampling-failure escalation re-arms the round as a new WAVE;
//   H6 — R8/D-49's negative gate: round 2 does not arm without an open fix task, nor over an
//        unconfirmed blocking finding.
import { describe, expect, it } from 'vitest';

import { createRig, seedFinding, seedTask } from './mock';
import { samplingArmed, samplingCapOf, screeningCapOf } from './records';
import { generateWork, SAMPLING_FAILURE_PREFIX, SCREENING_PARTIAL_PREFIX } from './work';
import type { Rig } from './mock';
import type { SummarySample } from '../../shared/schemas';

/** Every run row under one prefix as `claim key:state`, oldest first — the ledger a test reads. */
function runs(rig: Rig, prefix = ''): string[] {
    return rig.store.runs
        .list()
        .filter((run) => (run.work_item_ref ?? '').startsWith(prefix))
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((run) => `${run.work_item_ref ?? run.id}:${run.state}`);
}

/** The Summary row of the rig's Story. */
function summaryOf(rig: Rig) {
    const summary = rig.store.summaries.list().find((row) => row.story_id === rig.storyId);

    if (summary === undefined) throw new Error('the rig has no Summary row');

    return summary;
}

/** A schema-valid `SummarySample` for a chosen index, independent of the prompt's Seed Brief. */
function sampleOf(index: number): SummarySample {
    return {
        premise: `sample ${index}: premise`,
        promise: `sample ${index} pays the promise the Seed makes`,
        theme: `sample ${index} theme`,
        tone: `sample ${index} tone`,
        ending: `sample ${index} ending`,
        world_rules: `sample ${index} world rules`,
        knowledge_used: []
    };
}

/** The work generation offers at one instant — the same pure read the sweep makes. */
function offered(rig: Rig): string[] {
    return generateWork(rig.store, rig.store.stories.require(rig.storyId), {
        at: new Date().toISOString(),
        phase: 'summary'
    }).map((candidate) => candidate.key);
}

// ---------------------------------------------------------------------------
// B — a scrapped revision takes its screening reviews with it
// ---------------------------------------------------------------------------

describe('T12/B — scrapping a Summary revision leaves no orphaned sample review', () => {
    it('`editSeed` deletes the round’s screening reviews in the same commit as its revisions', async () => {
        // Two samples, two screening passes each: the selection truncates the loser AND its reviews,
        // so after round 1 the store holds exactly the winner's two reviews — the rows a Seed edit
        // would orphan if the backtrack only deleted the revisions.
        const rig = await createRig({ summarySampling: 2, summaryCritics: 2 });

        await rig.run();

        expect(rig.store.revisions.list().map((revision) => `${revision.id}:${revision.state}`)).toEqual([
            'revision_0:selected'
        ]);
        expect(rig.store.sampleReviews.list().map((review) => review.revision_ref)).toEqual([
            'revision_0',
            'revision_0'
        ]);

        await rig.engine.editSeed(rig.storyId, 'A cartographer burns every map she draws.', { confirm: true });

        // D-25a scraps every revision; T12/B says the reviews of those revisions go with them.
        expect(rig.store.revisions.list()).toEqual([]);
        expect(rig.store.sampleReviews.list()).toEqual([]);
    });

    it('a backtrack to `summary` deletes the reviews too, and a backtrack that deletes no revision deletes no review', async () => {
        // A backtrack to `chapters` scraps only LATER phases, so the Summary revision (and therefore
        // its reviews) survives: the fix is scoped to the revisions a commit actually deletes.
        const kept = await createRig({ summarySampling: 1, summaryCritics: 2 });

        await kept.run();

        expect(kept.store.sampleReviews.list().map((review) => review.revision_ref)).toEqual([
            'revision_0',
            'revision_0'
        ]);

        await kept.engine.backtrack(kept.storyId, 'chapters');

        expect(kept.store.revisions.list().map((revision) => revision.id)).toEqual(['revision_0']);
        expect(kept.store.sampleReviews.list().map((review) => review.revision_ref)).toEqual([
            'revision_0',
            'revision_0'
        ]);

        // The same Story backtracked to `summary` scraps the revision, so the reviews must go too.
        await kept.engine.backtrack(kept.storyId, 'summary');

        expect(kept.store.revisions.list()).toEqual([]);
        expect(kept.store.sampleReviews.list()).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// C — screening exhaustion degrades, and reports
// ---------------------------------------------------------------------------

describe('T12/C — a round whose screening attempts are spent selects on the partial set and escalates once', () => {
    it('selects the under-screened sample and opens ONE Author escalation naming the round', async () => {
        // Every screening answer is invalid JSON, so no `sample_reviews` row is ever persisted. The
        // sample itself is valid, so the round has a draft to select — the case that used to stall.
        const rig = await createRig({
            summarySampling: 1,
            summaryCritics: 2,
            crew: { screenAnswer: () => 'not json' }
        });

        await rig.run(24);

        // The cap is `summary_critics + 3` failed runs; the round then degrades instead of waiting.
        expect(screeningCapOf(rig.story())).toBe(5);
        expect(runs(rig, 'wi_screen_revision_0')).toEqual([
            'wi_screen_revision_0_1:failed',
            'wi_screen_revision_0_2:failed',
            'wi_screen_revision_0_3:failed',
            'wi_screen_revision_0_4:failed',
            'wi_screen_revision_0_5:failed'
        ]);
        expect(rig.store.sampleReviews.list()).toEqual([]);

        // The selection DID run: the only draft is selected, on zero reviews, and the round advanced.
        expect(rig.store.revisions.list().map((revision) => `${revision.id}:${revision.state}`)).toEqual([
            'revision_0:selected'
        ]);
        expect(rig.story().sampling_round).toBe(1);
        // §6.5's audit is still honest about what the reviews were: none, so `valid: false` — and honest
        // about the OUTCOME: this draft was installed, so it is the `accepted` line whatever the screens
        // said (H1: the reason a candidate was refused lives here, because the truncation below deletes
        // its draft and its reviews). An eligible line carries no `reject_reason`; only a refusal does.
        // `sample-select.ts:387` writes the reason on the `!eligible` branch alone, and a FIRST round is
        // never disqualified by an ungradeable screening set (`:345 ungradeable = refinement && !gradeable`
        // — there is no accepted draft to put at risk, which is what the T12/C degrade depends on), so
        // this row has no reason to carry even though `valid` is false. The refusals that DO name a
        // reason are pinned in `phase1-research.test.ts`, `phase1-hill-climb.test.ts` and
        // `api/phase1-view.test.ts`.
        // The wave's ledger rides on the entry: wave 0, the one attempt this size-1 round spent, and the
        // static ceiling (`samplingCapOf` = 1 + the retry allowance) that a clean round never extends.
        expect(rig.store.stories.require(rig.storyId).sampling_history?.[0]).toEqual(
            expect.objectContaining({
                round: 1,
                wave: 0,
                attempts: 1,
                improvements: 0,
                ceiling: samplingCapOf(rig.story()),
                unresolved_blocking: 0,
                samples: [
                    {
                        revision_id: 'revision_0',
                        critical: 0,
                        high: 0,
                        valid: false,
                        unresolved_fixes: [],
                        // It IS the accepted line, and it still says the screens answered nothing: the
                        // degrade installs on the partial set, and `valid: false` is the half of that
                        // fact the audit keeps. There is no `reject_reason`, because nothing refused it.
                        outcome: 'accepted'
                    }
                ]
            })
        );

        // ONE escalation, for the Author, naming the round and the partial screening.
        const escalations = rig.store.tasks.list().filter((task) => task.kind === 'escalation');

        expect(escalations).toHaveLength(1);
        expect({
            kind: escalations[0].kind,
            owner_role: escalations[0].owner_role,
            state: escalations[0].state,
            title: escalations[0].title
        }).toEqual({
            kind: 'escalation',
            owner_role: 'author',
            state: 'open',
            title: `${SCREENING_PARTIAL_PREFIX} 1 — selection proceeded with partial screening`
        });
        // The detail states what happened and that selection proceeded (§6.4 step 4).
        expect(escalations[0].detail).toBe(
            'round 1: revision_0 reached the 5-attempt screening cap with 2-or-fewer valid reviews each. Selection proceeded with the partial reviews (§6.5); the next round screens its own samples afresh (§6.4 step 4).'
        );

        // Generation stops buying screens: the cap is spent and the revision is no longer `drafted`.
        expect(offered(rig).filter((key) => key.startsWith('wi_screen_'))).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// D — no early selection while samples are still owed
// ---------------------------------------------------------------------------

describe('T12/D — a round selects only when its sample set exists or sampling is exhausted', () => {
    it('waits for the third sample while retries remain, and degrades only at the sampling cap', async () => {
        // sampling=3 and the SECOND sample index is always invalid. Two samples are drafted and fully
        // screened by the middle of the round; the defect was that the selector fired there, with a
        // sample still owed. `globalMaxConcurrent: 2` lets a screen land beside a sample run, which is
        // the shape a wider ceiling produces in production.
        const rig = await createRig({
            globalMaxConcurrent: 2,
            summarySampling: 3,
            summaryCritics: 1,
            crew: { sampleAnswer: ({ sampleIndex }) => (sampleIndex === 2 ? 'not json' : sampleOf(sampleIndex)) }
        });

        // Sweep 1: the first sample only.
        await rig.step();

        expect(rig.store.revisions.list().map((revision) => revision.id)).toEqual(['revision_0']);

        // Sweep 2: sample 2 fails AND revision_0's screening pass lands. Two revisions are not the
        // round's set, and the attempt cap is nowhere near spent, so nothing may be selected.
        await rig.step();

        expect(rig.store.sampleReviews.list().map((review) => review.revision_ref)).toEqual(['revision_0']);
        expect(rig.store.revisions.list().map((revision) => `${revision.id}:${revision.state}`)).toEqual([
            'revision_0:drafted'
        ]);
        expect(rig.story().sampling_round ?? 0).toBe(0);
        // The round still owes a sample, under the next attempt key.
        expect(offered(rig).filter((key) => key.startsWith('wi_sample_'))).toEqual(['wi_sample_summary_0_1_3']);

        // Drive the rest: sample index 2 stays invalid, so the remaining attempt keys all fail, and
        // only when the CAP is reached may the round degrade to the one sample it has.
        await rig.run();

        expect(samplingCapOf(rig.story())).toBe(6);
        expect(runs(rig, 'wi_sample_summary_0_1')).toEqual([
            'wi_sample_summary_0_1_1:torn_down',
            'wi_sample_summary_0_1_2:failed',
            'wi_sample_summary_0_1_3:failed',
            'wi_sample_summary_0_1_4:failed',
            'wi_sample_summary_0_1_5:failed',
            'wi_sample_summary_0_1_6:failed'
        ]);

        // The survivors were selected only after the sixth attempt spent the cap, and the audit line
        // names exactly the sample that existed (a single survivor, not three).
        expect(rig.store.revisions.list().map((revision) => `${revision.id}:${revision.state}`)).toEqual([
            'revision_0:selected'
        ]);
        // The audit line names exactly the sample that existed (a single survivor, not three), and it
        // says what the wave spent to get here: six attempts against a ceiling of six (size 3 + the
        // retry allowance), the last five of them the invalid answer. The retry allowance is a RUN
        // counter, not a row count, so the ledger has to carry it — after the truncation the failed
        // drafts are gone and this line is the only trace they left (H1/R4).
        expect(rig.store.stories.require(rig.storyId).sampling_history).toEqual([
            expect.objectContaining({
                round: 1,
                wave: 0,
                attempts: 6,
                improvements: 0,
                ceiling: 6,
                unresolved_blocking: 0,
                samples: [
                    {
                        revision_id: 'revision_0',
                        critical: 0,
                        high: 0,
                        valid: true,
                        unresolved_fixes: [],
                        outcome: 'accepted'
                    }
                ]
            })
        ]);
        expect(rig.story().sampling_round).toBe(1);

        // A partially screened selection did NOT happen here — every drafted sample had its reviews —
        // so the screening escalation stayed silent.
        expect(rig.store.tasks.list().filter((task) => task.kind === 'escalation')).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// E — the cleared sampling-failure escalation re-arms a wave
// ---------------------------------------------------------------------------

describe('T12/E — clearing the sampling-failure escalation re-arms the round as a new wave', () => {
    it('dispatches wave-scoped sample keys after the clear, and the round completes', async () => {
        let repaired = false;

        const rig = await createRig({
            summarySampling: 1,
            summaryCritics: 1,
            crew: { sampleAnswer: () => (repaired ? sampleOf(1) : 'not json') }
        });

        // Every attempt is invalid: the round spends `1 + 3` attempts and escalates with wave 0.
        await rig.run(14);

        const escalation = rig.store.tasks.list().find((task) => task.kind === 'escalation');

        expect(escalation).toMatchObject({
            kind: 'escalation',
            owner_role: 'author',
            state: 'open',
            title: `${SAMPLING_FAILURE_PREFIX} 4 attempts — the provider is not returning valid SummarySample JSON`
        });
        // The detail records the WAVE it was opened at — the guard that makes the bump happen once.
        expect(escalation?.detail).toBe(
            'round 1 produced no Summary sample after 4 one-turn attempts (wave: 0). Check the provider/model the sampler runs on, then clear this row (or change summary_sampling) and the sweep re-arms a fresh wave of samples (§6.4 step 3).'
        );
        expect(rig.store.stories.require(rig.storyId).sampling_wave).toBeUndefined();
        expect(rig.story().sampling_round ?? 0).toBe(0);

        // The Author's clear (L-36/U-1b) is `wontfix`, and the provider is fixed in the same breath.
        await rig.engine.clearPending(rig.storyId);

        expect(rig.store.tasks.require(escalation!.id).state).toBe('wontfix');

        repaired = true;

        await rig.run();

        // One bump, from the recorded-wave guard: the Story now samples wave 1, whose keys reset the
        // attempt counter the spent wave left behind.
        expect(rig.store.stories.require(rig.storyId).sampling_wave).toBe(1);
        expect(runs(rig, 'wi_sample_summary_0_1')).toEqual([
            'wi_sample_summary_0_1_1:failed',
            'wi_sample_summary_0_1_2:failed',
            'wi_sample_summary_0_1_3:failed',
            'wi_sample_summary_0_1_4:failed',
            'wi_sample_summary_0_1_w1_1:torn_down'
        ]);

        // The fresh wave's sample completed the round: drafted, screened, selected, round advanced.
        expect(rig.store.revisions.list().map((revision) => `${revision.id}:${revision.state}`)).toEqual([
            'revision_0:selected'
        ]);
        expect(rig.story().sampling_round).toBe(1);
        // The cleared row is NOT re-opened: sampling is no longer exhausted, so the sweep offers work.
        expect(rig.store.tasks.list().filter((task) => task.state === 'open' && task.kind === 'escalation')).toEqual(
            []
        );
    });
});

// ---------------------------------------------------------------------------
// H6 — R8/D-49's negative gate, read through the shipped predicate
// ---------------------------------------------------------------------------

describe('T12/H6 — round 2 arms only on an open fix task with no unconfirmed blocking finding (R8, D-49)', () => {
    it('refuses the round with no fix task and with an unconfirmed blocking finding, and arms on approved work', async () => {
        const rig = await createRig({ summarySampling: 1, summaryCritics: 1 });

        await rig.run();

        const summary = summaryOf(rig);
        const selected = rig.store.revisions.list().find((revision) => revision.state === 'selected');

        if (selected === undefined) throw new Error('the rig has no selected Summary revision');

        const story = () => rig.store.stories.require(rig.storyId);

        // Round 1 is unconditional: structure and research closed is all it asks.
        expect(samplingArmed(rig.store, story(), 1)).toBe(true);

        // Negative gate 1: a clean round with nothing approved is deliberately NOT owed a round 2.
        expect(samplingArmed(rig.store, story(), 2)).toBe(false);

        // Negative gate 2: an open fix task alone is not enough while a blocking suspicion is
        // unconfirmed — compiling an unverified complaint into the Writer's prompt would spend the
        // round on a claim the Editor has not accepted (D-33).
        const finding = seedFinding(rig.store, rig.storyId, {
            target_ref: summary.id,
            criterion_ref: 'C-14',
            cost: 'major',
            state: 'unconfirmed',
            fingerprint: 'probe|C-14',
            related_refs: [selected.id]
        });
        const task = seedTask(rig.store, rig.storyId, {
            kind: 'fix',
            title: 'probe fix: pay the promise',
            detail: `C-14 on ${summary.id} · ${summary.id}`,
            owner_role: 'writer',
            finding_ref: finding.id
        });

        expect(samplingArmed(rig.store, story(), 2)).toBe(false);

        // Both clauses hold: the approved finding's open task arms the round.
        rig.store.findings.update(
            finding.id,
            { state: 'approved' },
            { run_ref: null, why: 'probe: the Editor approved the finding' }
        );

        expect(samplingArmed(rig.store, story(), 2)).toBe(true);

        // The task is what the round is FOR: consumed, and the round is not owed.
        rig.store.tasks.update(task.id, { state: 'done' }, { run_ref: null, why: 'probe: the task was consumed' });

        expect(samplingArmed(rig.store, story(), 2)).toBe(false);

        // A MINOR unconfirmed note is blocking ONLY when the Author's dial makes minor real work, and the
        // default dial (`DEFAULT_AUTO_APPROVE_COSTS` = critical, major, minor) does — so here it holds the
        // round exactly like the major note above did (D-30's bar, read by ONE predicate: the sweep, the
        // Editor's `approveFinding`, the sign-off and this gate cannot disagree). The companion case below
        // narrows the dial and the SAME note stops holding anything.
        const second = seedTask(rig.store, rig.storyId, {
            kind: 'fix',
            title: 'probe fix 2',
            detail: `C-15 on ${summary.id}`,
            owner_role: 'writer'
        });

        seedFinding(rig.store, rig.storyId, {
            target_ref: summary.id,
            criterion_ref: 'C-15',
            cost: 'minor',
            state: 'unconfirmed',
            fingerprint: 'probe|C-15',
            related_refs: [selected.id]
        });

        expect(rig.store.tasks.require(second.id).state).toBe('open');
        expect(samplingArmed(rig.store, story(), 2)).toBe(false);
    });

    it('lets the same minor note through when the dial leaves minor out of the Author’s work', async () => {
        // The dial-driven half of the rule (D-35's one switch, now read by the blocking-cost predicate
        // instead of only by the auto-approve split). Everything else is the rig above: an approved
        // finding with its open fix task, plus an UNCONFIRMED minor note on the carried draft. With the
        // dial narrowed to critical/major the note is recorded and blocks nothing, so the round arms —
        // the loop does not spend a sampling round on a clarity note the Author said is not work.
        const rig = await createRig({
            summarySampling: 1,
            summaryCritics: 1,
            story: { auto_approve: ['critical', 'major'] }
        });

        await rig.run();

        const summary = summaryOf(rig);
        const selected = rig.store.revisions.list().find((revision) => revision.state === 'selected');

        if (selected === undefined) throw new Error('the rig has no selected Summary revision');

        const story = () => rig.store.stories.require(rig.storyId);

        expect(story().auto_approve).toEqual(['critical', 'major']);

        const finding = seedFinding(rig.store, rig.storyId, {
            target_ref: summary.id,
            criterion_ref: 'C-14',
            cost: 'major',
            state: 'approved',
            fingerprint: 'probe|C-14',
            related_refs: [selected.id]
        });

        seedTask(rig.store, rig.storyId, {
            kind: 'fix',
            title: 'probe fix: pay the promise',
            detail: `C-14 on ${summary.id} · ${summary.id}`,
            owner_role: 'writer',
            finding_ref: finding.id
        });

        // The open fix task arms the round, and nothing else is outstanding yet.
        expect(samplingArmed(rig.store, story(), 2)).toBe(true);

        seedFinding(rig.store, rig.storyId, {
            target_ref: summary.id,
            criterion_ref: 'C-15',
            cost: 'minor',
            state: 'unconfirmed',
            fingerprint: 'probe|C-15',
            related_refs: [selected.id]
        });

        // A `minor` the dial does not cover is not a blocking finding (`records.ts:summaryBlockingCost`),
        // so the negative gate still passes. A `taste` note is never blocking in phase ① at all, dial or
        // no dial — the prose it would prefer between is not written until phase ③.
        expect(samplingArmed(rig.store, story(), 2)).toBe(true);

        seedFinding(rig.store, rig.storyId, {
            target_ref: summary.id,
            criterion_ref: 'C-16',
            cost: 'taste',
            state: 'unconfirmed',
            fingerprint: 'probe|C-16',
            related_refs: [selected.id]
        });

        expect(samplingArmed(rig.store, story(), 2)).toBe(true);

        // The same Story with a `major` suspicion instead is held again: the costs the dial cannot waive
        // are exactly the ones the gate keeps enforcing.
        seedFinding(rig.store, rig.storyId, {
            target_ref: summary.id,
            criterion_ref: 'C-17',
            cost: 'major',
            state: 'unconfirmed',
            fingerprint: 'probe|C-17',
            related_refs: [selected.id]
        });

        expect(samplingArmed(rig.store, story(), 2)).toBe(false);
    });
});
