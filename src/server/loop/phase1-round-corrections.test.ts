// T10 — the round-level review findings (F5) and the two integration rows the review asked for
// (a waived-research round that stops cleanly, and the DEFAULT 3×5 pipeline at its real scale).
//
//   F5    A sampling round that has already started STAYS started across a wave bump. The started read
//         was scoped to the current sampling wave, so the failure escalation the Author clears — the very
//         act that bumps `stories.sampling_wave` — rewrote history: the round's own drafts were there, the
//         ledger said "never sampled", `samplingLegClosed` refused, and the round stranded its own drafts
//         with the sign-off gated on a selection nobody would offer.
//   R1+R2 A WAIVED research leg (D-51) reaches the same clean Stop as a researched one: the waiver writes
//         no run row, the round samples, screens, selects, deep-reviews, and the Story sits `pending`
//         with `phase_signoff` offered and the drain met — and it stays there across further sweeps.
//   Scale The pipeline runs at the published default (`summary_sampling` 3, `summary_readers` 5): three
//         samples, five screening passes EACH, five deep-review passes on the winner, the losers
//         hard-deleted, and one clean Stop. The 1/1 fixtures elsewhere are the rig's clock, not the
//         product's numbers, so this row is what pins the counts the Author's dial advertises.
import { describe, expect, it } from 'vitest';

import { createRig, seedFinding, seedTask } from './mock';
import { authorAttr } from './records';
import { drainPreconditions } from './status';
import { generateWork } from './work';
import {
    deepReviewPassesOwed,
    isDeepReviewSelection,
    researchGate,
    sampleAttempts,
    samplingCapOf,
    samplingLegClosed,
    samplingRoundOf,
    samplingRoundStarted,
    samplingWaveOf,
    selectedSummaryRevision
} from './records';
import { seedHashOf } from '../../shared/seed-hash';
import type { Rig } from './mock';
import type { Story } from '../../shared/types';
import { DEFAULT_SUMMARY_READERS, DEFAULT_SUMMARY_SAMPLING } from '../../shared/types';

/** Every run row as its claim key, in clock order — the dispatch order the rules below are about. */
function runKeys(rig: Rig, prefix = ''): string[] {
    return rig.store.runs
        .list()
        .filter((run) => (run.work_item_ref ?? '').startsWith(prefix))
        .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id))
        .map((run) => run.work_item_ref ?? run.id);
}

/** Every Summary draft as `id:round:state`. */
function revisionRows(rig: Rig): string[] {
    return rig.store.revisions
        .list()
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((revision) => `${revision.id}:r${revision.round}:${revision.state}`);
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

/** What the sweep would dispatch right now, in generation order. */
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

describe('T10/F5 — a round that started stays started across a sampling-wave bump', () => {
    it('reaches selection after the wave bump instead of stranding the drafts it already had', async () => {
        // Three samples per round and one screening Reader: round 1 completes, and the approved finding
        // plus its fix task arm round 2 (`records.ts:samplingArmed`).
        const rig = await createRig({ summarySampling: 3, summaryReaders: 1, crew: { verifyReports: 'silent' } });

        await rig.run();

        armRefinementRound(rig);

        // One round-2 sample lands; the round still owes two more.
        await rig.step();

        expect(storyOf(rig).sampling_round).toBe(1);
        expect(revisionRows(rig)).toEqual(['revision_1:r1:selected', 'revision_4:r2:drafted']);
        expect(samplingWaveOf(storyOf(rig))).toBe(0);
        expect(samplingRoundStarted(rig.store, storyOf(rig), 2)).toBe(true);

        // The sampling failure and the Author's clear: `engine.ts:rearmSamplingWave` bumps the wave so the
        // retry cap restarts, while every spent run row stays on the ledger (T12/E). Nothing about the
        // ROUND changes — the draft made in wave 0 is still round 2's.
        rig.store.stories.update(
            rig.storyId,
            { sampling_wave: 1 },
            { run_ref: null, why: 'test: the Author cleared the sampling escalation, re-arming wave 1 (T12/E)' }
        );

        // …and BEFORE any new-wave sample exists, the round is disarmed underneath itself: a review files
        // an unconfirmed critical suspicion nobody decides, so `samplingArmed` refuses the next sample.
        seedSummaryFinding(rig, {
            fingerprint: 'C-14|wave-disarm',
            cost: 'critical',
            state: 'unconfirmed',
            refs: ['revision_1']
        });

        const story = storyOf(rig);

        // The three facts, read the way the engine reads them. The round started (wave-AGNOSTIC), the
        // active wave has spent nothing (that is the re-arm contract), and the leg is closed because the
        // round started and is no longer armed — which is what lets selection proceed.
        expect(samplingWaveOf(story)).toBe(1);
        expect(samplingRoundStarted(rig.store, story, 2)).toBe(true);
        expect(sampleAttempts(rig.store, summaryOf(rig).id, 2, samplingWaveOf(story))).toBe(0);
        expect(samplingLegClosed(rig.store, story, 2)).toBe(true);

        for (let sweep = 0; sweep < 10; sweep += 1) await rig.step();

        const closed = storyOf(rig);

        // The round closed on the draft it had: screened, selected, `sampling_round` advanced. Before this
        // fix the sweep returned at the "still owes samples" gate — the wave-scoped started-read said the
        // round had never sampled — and these rows sat `drafted` forever.
        expect(closed.sampling_round).toBe(2);
        expect(revisionRows(rig)).toEqual(['revision_1:r1:selected', 'revision_4:r2:selected']);

        // Exactly one round-2 attempt, and it is the OLD wave's key: the round was disarmed before the new
        // wave bought anything, so the wave bump neither re-counted the spent attempt nor faked a sample.
        expect(runKeys(rig, 'wi_sample_')).toEqual([
            'wi_sample_summary_1_1_1',
            'wi_sample_summary_1_1_2',
            'wi_sample_summary_1_1_3',
            'wi_sample_summary_1_2_1'
        ]);
        expect(runKeys(rig, 'wi_screen_revision_4')).toEqual(['wi_screen_revision_4_1']);

        // The round's own work is finished and reported: the fix task it carried is consumed, and the
        // sign-off is offered — the strand used to leave this at `ready` with nothing to run.
        expect(closed.status).toBe('pending');
        expect(closed.pending_kind).toBe('phase_signoff');
        expect(drainPreconditions(rig.store, closed)).toEqual({ met: true, unmet: [] });

        // A round that has NEVER sampled still refuses (D-49): round 3 has no run of its own, so the
        // started read says no and the leg stays open until it is armed and sampled.
        expect(samplingRoundOf(closed)).toBe(3);
        expect(samplingRoundStarted(rig.store, closed, 3)).toBe(false);
        expect(samplingLegClosed(rig.store, closed, 3)).toBe(false);
    });
});

describe('T10 R1+R2 — a waived research leg reaches the same clean Stop', () => {
    it('waives the Researcher, samples, screens, selects, deep-reviews, and holds phase_signoff (D-51, L-29)', async () => {
        // `seedStructured: false` so the waiver is WRITTEN by the Editor's own `structureSeed` call rather
        // than seeded — the composition under test is the tool's decision and the loop's reading of it.
        const rig = await createRig({
            seedStructured: false,
            summarySampling: 1,
            summaryReaders: 1,
            crew: { researchQuestions: [] }
        });

        expect((await rig.step()).stories[0].started).toEqual([
            `wi_structure_seed_${seedHashOf(rig.story().idea)}`
        ]);

        const brief = rig.store.seedBriefs.list()[0];

        expect(brief.research_questions).toEqual([]);
        expect(researchGate(rig.store, storyOf(rig), brief)).toBe('waived');

        await rig.run();

        // The whole ledger the round produced — structure, one sample, its screening set, the deep review
        // of the winner. No `wi_research_*` row at all: the waiver removed the Work Item, not just the wait.
        expect(runKeys(rig)).toEqual([
            `wi_structure_seed_${seedHashOf(rig.story().idea)}`,
            'wi_sample_summary_1_1_1',
            'wi_screen_revision_1_1',
            'wi_review_revision_1_a1'
        ]);
        expect(runKeys(rig, 'wi_research')).toEqual([]);
        expect(revisionRows(rig)).toEqual(['revision_1:r1:selected']);
        expect(rig.store.knowledge.list()).toEqual([]);

        // R2's side of the composition: the selected draft IS the current round's review target, and its
        // configured passes are closed — the state that made the sign-off offerable in the first place.
        const story = storyOf(rig);
        const selected = carriedOf(rig, 'the waived-research round selection');

        expect(story.sampling_round).toBe(1);
        expect(isDeepReviewSelection(story, selected)).toBe(true);
        expect(deepReviewPassesOwed(rig.store, story, selected)).toBe(0);

        // T12: the waiver's whole ledger signature is EMPTINESS. No Researcher means no notes and no
        // findings, so the clean Stop is a board with nothing on it — `phase_signoff` over zero findings
        // and zero fix tasks, not a gate stacked on top of review debt.
        expect(rig.store.findings.list()).toEqual([]);
        expect(rig.store.tasks.list()).toEqual([]);

        expect({ phase: story.phase, status: story.status, pending: story.pending_kind }).toEqual({
            phase: 'summary',
            status: 'pending',
            pending: 'phase_signoff'
        });
        expect(drainPreconditions(rig.store, story)).toEqual({ met: true, unmet: [] });

        // STABLE: further sweeps mint nothing. The sign-off holds dispatch, so the waiver cannot drift
        // back into a research dispatch and the review cannot re-owe a closed pass.
        const before = runKeys(rig);

        for (let sweep = 0; sweep < 3; sweep += 1) await rig.step();

        expect(runKeys(rig)).toEqual(before);
        expect(offers(rig)).toEqual(['wi_probe_checker_summary_1', 'wi_probe_reader_summary_1']);
    });
});

describe('T10 — the pipeline at the default scale (3 samples, 5 Reader passes)', () => {
    it('runs 3 samples through 5 screening passes each, selects once, and deep-reviews the winner 5 times', async () => {
        // The published standard, not the rig's 1/1 clock: `DEFAULT_SUMMARY_SAMPLING` / `DEFAULT_SUMMARY_READERS`.
        const rig = await createRig({
            summarySampling: DEFAULT_SUMMARY_SAMPLING,
            summaryReaders: DEFAULT_SUMMARY_READERS
        });

        await rig.run(60);

        // 1 research pass (seeded closed by the rig), 3 samples, 3 × 5 screening passes, 5 deep-review
        // passes on the winner. Every count here is the configured number, not a range.
        expect(runKeys(rig)).toEqual([
            'wi_research_1',
            'wi_sample_summary_1_1_1',
            'wi_sample_summary_1_1_2',
            'wi_sample_summary_1_1_3',
            'wi_screen_revision_1_1',
            'wi_screen_revision_1_2',
            'wi_screen_revision_1_3',
            'wi_screen_revision_1_4',
            'wi_screen_revision_1_5',
            'wi_screen_revision_2_1',
            'wi_screen_revision_2_2',
            'wi_screen_revision_2_3',
            'wi_screen_revision_2_4',
            'wi_screen_revision_2_5',
            'wi_screen_revision_3_1',
            'wi_screen_revision_3_2',
            'wi_screen_revision_3_3',
            'wi_screen_revision_3_4',
            'wi_screen_revision_3_5',
            'wi_review_revision_1_a1',
            'wi_review_revision_1_a2',
            'wi_review_revision_1_a3',
            'wi_review_revision_1_a4',
            'wi_review_revision_1_a5'
        ]);

        // Selection retired the losers (§16.6): the round's three drafts became one carried draft, and
        // `sampling_history` is the audit line that still names all three.
        expect(revisionRows(rig)).toEqual(['revision_1:r1:selected']);
        expect(storyOf(rig).sampling_history?.map((entry) => `${entry.round}:${entry.selected}`)).toEqual(['1:revision_1']);
        expect(
            storyOf(rig).sampling_history?.[0].samples.map(
                (sample) => `${sample.revision_id}:${sample.critical}/${sample.high}/${sample.valid}`
            )
        ).toEqual(['revision_1:0/0/true', 'revision_2:0/0/true', 'revision_3:0/0/true']);

        // The Stop: five reviews closed, so the deep review is complete, the drain is met, and the Story
        // waits on the Author's lock — the retirement/selection half and the clean-stop half in one round.
        const story = storyOf(rig);
        const selected = carriedOf(rig, 'the default-scale selection');

        expect(story.sampling_round).toBe(1);
        expect(deepReviewPassesOwed(rig.store, story, selected)).toBe(0);
        expect({ phase: story.phase, status: story.status, pending: story.pending_kind }).toEqual({
            phase: 'summary',
            status: 'pending',
            pending: 'phase_signoff'
        });
        expect(drainPreconditions(rig.store, story)).toEqual({ met: true, unmet: [] });
    });
});

describe('T12/P3 — the drain counts the sampling retry cap in the wave the engine spends it in', () => {
    /**
     * A round's retry budget is spent by RUN ROWS, one per sampling claim key (`records.ts:sampleAttempts`
     * counts `runs.work_item_ref` under `samplePrefixOf`), not by task rows — so the ledger is seeded here
     * exactly as a failed sampling attempt leaves it: a torn-down run under the wave's claim key.
     */
    function seedSampleAttempt(rig: Rig, key: string) {
        const at = new Date().toISOString();

        rig.store.runs.create(
            {
                story_id: rig.storyId,
                work_item_ref: key,
                role: 'writer',
                template_ref: 't-builtin',
                state: 'torn_down',
                started_at: at,
                ended_at: at,
                tokens: 10,
                kind: 'work',
                delegated: []
            },
            authorAttr('test: spend one sampling attempt')
        );
    }

    it('reads the cap per wave: a spent wave goes silent, the re-armed wave owes samples again (T12/E)', async () => {
        // 1 sample per round so the arithmetic is one-at-a-time: the retry cap is 4 attempts per round,
        // and the §6.4 step-3 sentence is the only sampling clause in play (no samples exist yet).
        const rig = await createRig({ summarySampling: 1, summaryReaders: 1 });

        await rig.run();

        // Round 2 is ARMED: an approved major finding on the carried draft and its fix task (§16.6).
        armRefinementRound(rig);

        const summary = summaryOf(rig);

        // The two round reads, kept apart on purpose: `sampling_round` is the round that COMPLETED (1),
        // `samplingRoundOf` is the round the Story owes work in now (2) — the one §6.4 step 3 counts.
        expect(storyOf(rig).sampling_round).toBe(1);
        expect(samplingRoundOf(storyOf(rig))).toBe(2);
        expect(samplingWaveOf(storyOf(rig))).toBe(0);
        expect(samplingCapOf(storyOf(rig))).toBe(4);
        expect(sampleAttempts(rig.store, summary.id, 2, 0)).toBe(0);

        // Wave 0, nothing spent: the sampler is offered and the drain says the round owes its sample.
        expect(offers(rig)).toEqual(['wi_sample_summary_1_2_1']);
        expect(drainPreconditions(rig.store, storyOf(rig))).toEqual({
            met: false,
            unmet: ['1 task still queued', '0 of 1 sample exist for round 2 and retries remain (§6.4 step 3)']
        });

        // The wave spends its cap: four torn-down attempts under round 2's wave-0 claim keys. The leg is
        // closed (`samplingLegClosed`: armed no more once the cap is spent) and the sentence goes SILENT,
        // because the honest answer is "no sample is coming in this wave" — the escalation owns the round.
        for (let attempt = 1; attempt <= 4; attempt += 1) seedSampleAttempt(rig, `wi_sample_summary_1_2_${attempt}`);

        expect(sampleAttempts(rig.store, summary.id, 2, 0)).toBe(4);
        expect(offers(rig)).toEqual([]);
        expect(drainPreconditions(rig.store, storyOf(rig))).toEqual({ met: false, unmet: ['1 task still queued'] });

        // The Author clears the escalation: `engine.ts:rearmSamplingWave` bumps `stories.sampling_wave`, so
        // the SAME round retries under a NEW wave's claim keys. Every spent wave-0 row stays on the ledger
        // (the family read still counts 4), while the wave the engine is about to spend reads 0.
        rig.store.stories.update(
            rig.storyId,
            { sampling_wave: 1 },
            { run_ref: null, why: 'test: the Author cleared the sampling escalation, re-arming wave 1 (T12/E)' }
        );

        expect(samplingWaveOf(storyOf(rig))).toBe(1);
        expect(sampleAttempts(rig.store, summary.id, 2, 1)).toBe(0);
        expect(sampleAttempts(rig.store, summary.id, 2, 0)).toBe(4);

        // The half the count used to get wrong: read over the whole round family, the cap looked spent and
        // this sentence went silent over a sample the sweep was about to dispatch — the dashboard showed a
        // round waiting on nothing while the sampler ran. Scoped to the active wave it says what is true:
        // wave 1 has spent nothing, the round owes its sample, and the offer is the WAVE-1 claim key.
        expect(offers(rig)).toEqual(['wi_sample_summary_1_2_w1_1']);
        expect(drainPreconditions(rig.store, storyOf(rig))).toEqual({
            met: false,
            unmet: ['1 task still queued', '0 of 1 sample exist for round 2 and retries remain (§6.4 step 3)']
        });

        // …and the sweep makes it real: the wave-1 attempt runs under the wave-scoped key, so the round
        // finally has its draft while the wave-0 rows stay where the audit can read them.
        await rig.step();

        expect(runKeys(rig, 'wi_sample_summary_1_2_w1')).toEqual(['wi_sample_summary_1_2_w1_1']);
        expect(sampleAttempts(rig.store, summary.id, 2, 1)).toBe(1);
        expect(sampleAttempts(rig.store, summary.id, 2, 0)).toBe(5);
        expect(revisionRows(rig)).toEqual(['revision_1:r1:selected', 'revision_2:r2:drafted']);
    });
});
