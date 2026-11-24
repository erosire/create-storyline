/**
 * G1 — the ACCEPTED-REVISION PLATEAU in legacy sampling mode, as it lives after the Summary Phrase
 * redesign (R5) removed the Author question that used to sit on top of it.
 *
 * WHY THIS FILE EXISTS: the plateau's escalation row and its own wave bump went away with the
 * whole-Summary hill-climb they policed (`engine.ts:rearmSamplingWave` says so), but the STOP itself
 * did not: the audit write, the streak walk, the predicate and `samplingArmed`'s fourth leg are all
 * live, and with the escalation gone they had no test left. This file restores that coverage against
 * the LIVE rules only — it deliberately does not re-raise the deleted Author question or the removed
 * `SAMPLING_PLATEAU_PREFIX` row.
 *
 * What is pinned, in the order the loop meets it:
 *   1. the AUDIT WRITE (`engine.ts:trackRevisionProgress` → `records.ts:pendingRevisionReviewEntry`):
 *      one entry per accepted revision, keyed by revision id, only once the deep review has closed and
 *      only once the Editor has stopped holding a blocking suspicion;
 *   2. the WALK (`revisionReviewProgressOf`): the first entry of a wave SETS the bar, equal counts are
 *      no progress, a strict drop resets the streak, and a regression never raises the bar;
 *   3. the STOP (`samplingArmed`'s plateau leg, read through `generateWork`): a plateau buys no
 *      `sample_unit` — real work stops, not just a status line (requirement 3);
 *   4. the DRAIN: entries are partitioned by WAVE, so the fresh wave the Author's cleared escalation
 *      re-arms (`engine.ts:rearmSamplingWave`, whose row mechanics `phase1-gates.test.ts` pins) is a
 *      fresh baseline, and the sampler comes back.
 *
 * Values were read off the rig (`yarn vite-node` probe in the outer `Temp/`), not guessed.
 */
import { describe, expect, it } from 'vitest';

import { createRig, seedTask } from './mock';
import {
    pendingRevisionReviewEntry,
    revisionReviewPlateau,
    revisionReviewProgressOf,
    SAMPLING_NO_PROGRESS_STREAK,
    samplingArmed,
    summaryReviewHistoryOf
} from './records';
import { generateWork } from './work';
import type { Rig } from './mock';
import type { SummaryReviewHistoryEntry } from '../../shared/types';

/** The claim keys generation would dispatch this sweep — the same pure read `engine.sweep()` makes. */
const offered = (rig: Rig): string[] =>
    generateWork(rig.store, rig.story(), { at: new Date().toISOString(), phase: 'summary' }).map(
        (candidate) => candidate.key
    );

/** An audit row written by hand, so the test names the exact numbers the walk reads. */
const auditEntry = (wave: number, index: number, blockingFound: number): SummaryReviewHistoryEntry => ({
    round: 1,
    wave,
    revision_id: `revision_probe_${index}`,
    at: `2026-11-24T10:00:0${index}.000Z`,
    blocking_found: blockingFound,
    finding_refs: []
});

/** Replaces the whole audit, the way the sweep appends to it. */
const writeAudit = (rig: Rig, entries: SummaryReviewHistoryEntry[]) => {
    const story = rig.story();

    rig.store.stories.update(
        story.id,
        { summary_review_history: entries },
        { run_ref: null, author: true, why: 'seed: the accepted-revision audit (G1)' },
        [{ id: story.id, rev: story.rev }]
    );
};

/**
 * A round-1 book that has run to quiescence on the legacy sampler: sample, screening, selection, and the
 * deep review that audits the accepted revision.
 */
const roundOneRig = async () => {
    const rig = await createRig({ summarySampling: 1, summaryReaders: 1 });

    await rig.run();

    return rig;
};

/** The deep-review run of the rig's round 1 — the run a finding must be attributed to to count (G1). */
const reviewRunOf = (rig: Rig) =>
    rig.store.runs.list().find((run) => (run.work_item_ref ?? '').startsWith('wi_review_revision_0_a'))!;

/**
 * A defect FILED BY the deep review, which is the only way it can enter the audit:
 * `records.ts:revisionReviewFindings` attributes findings by the RUN in their create event, not by title
 * or `related_refs` (the same journal mechanism a Researcher pass's Knowledge uses). A hand-seeded row
 * attributed to the Author is deliberately invisible to the audit, so the audit's count has to be seeded
 * this way to be pinned at all.
 */
const seedReviewFinding = (
    rig: Rig,
    init: { state: 'unconfirmed' | 'approved'; cost?: 'critical' | 'major' | 'minor'; targetRef: string; relatedRefs: string[] }
) =>
    rig.store.findings.create(
        {
            story_id: rig.storyId,
            target_ref: init.targetRef,
            criterion_ref: 'C-14',
            title: 'the Overview promises a cartographer the Seed destroyed',
            detail: 'C-14 on the accepted Summary: the promise the Seed makes is not paid',
            evidence: 'summary_0 promise mentions the cartographer; the Seed says the map was destroyed',
            cost: init.cost ?? 'major',
            fingerprint: 'probe|C-14',
            state: init.state,
            seen_count: 1,
            related_refs: init.relatedRefs
        },
        {
            run_ref: reviewRunOf(rig).id,
            author: false,
            why: 'seed: the deep review of the accepted revision filed this defect (D-16, G1)'
        }
    );

/**
 * Arms round 2 the way the loop does it: an APPROVED finding (the Editor's verdict) with the open
 * writer-owned fix task its confirmation created. Without these, `samplingArmed`'s OTHER legs already
 * refuse the round and the plateau leg would prove nothing.
 */
const armRoundTwo = (rig: Rig) => {
    const summary = rig.store.summaries.list().find((row) => row.story_id === rig.storyId)!;
    const selected = rig.store.revisions.list().find((row) => row.state === 'selected')!;
    const finding = seedReviewFinding(rig, {
        state: 'approved',
        targetRef: summary.id,
        relatedRefs: [selected.id]
    });

    seedTask(rig.store, rig.storyId, {
        kind: 'fix',
        title: 'probe fix: pay the promise the Seed makes',
        detail: `C-14 on ${summary.id}`,
        owner_role: 'writer',
        finding_ref: finding.id
    });

    return { finding, summary, selected };
};

describe('G1 — the sweep audits the accepted revision its deep review judged (arming)', () => {
    it('writes exactly one entry for the selected revision, and owes nothing to audit afterwards', async () => {
        const rig = await roundOneRig();
        const entries = summaryReviewHistoryOf(rig.story());

        // One entry, for the revision the selection installed, in the wave that sampled it, and a count of
        // FINDING ROWS (the rig's crew filed none, so the bar starts at 0 — not "undefined", which would
        // let a later entry read as an improvement over nothing).
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            round: 1,
            wave: 0,
            revision_id: 'revision_0',
            blocking_found: 0,
            finding_refs: []
        });
        // `at` is a clock, so it is pinned as a shape, not as a value.
        expect(entries[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

        // Idempotence across sweeps and across a restart: the audit is keyed by revision id, and the
        // "what do I owe?" predicate says nothing, so a re-run sweep cannot count the same text twice.
        expect(pendingRevisionReviewEntry(rig.store, rig.story())).toBeUndefined();
        expect(revisionReviewProgressOf(rig.store, rig.story())).toEqual({
            wave: 0,
            entries,
            reviewed: 1,
            bestBlockingFound: 0,
            improvements: 0,
            noImprovement: 0,
            plateaued: false
        });
    });

    it('waits for the Editor: an unconfirmed blocking suspicion is not yet an audit, and approving it is', async () => {
        const rig = await roundOneRig();
        const { selected, summary } = armRoundTwo(rig);
        const other = seedReviewFinding(rig, { state: 'unconfirmed', targetRef: summary.id, relatedRefs: [selected.id] });

        // Wipe the entry the sweep already wrote so the OWED-ness predicate is the thing under test.
        writeAudit(rig, []);

        // The pass that filed it has closed, but its complaint is undecided: recording 1 here and having
        // the Editor dispute it would leave a permanent regression in the audit for a defect nobody
        // believes, so the write waits (requirement 5).
        expect(pendingRevisionReviewEntry(rig.store, rig.story())).toBeUndefined();

        rig.store.findings.update(
            other.id,
            { state: 'approved' },
            { run_ref: null, author: true, why: 'seed: the Editor approved the finding (D-33)' },
            [{ id: other.id, rev: rig.store.findings.require(other.id).rev }]
        );

        // Decided, and the entry it owes names the carried revision and every finding behind the count:
        // this wave's accepted revision was reviewed twice over and raised two blocking defects.
        const owed = pendingRevisionReviewEntry(rig.store, rig.story());

        expect(owed?.revision.id).toBe(selected.id);
        expect(owed?.blocking.map((row) => [row.id, row.cost, row.state])).toEqual([
            ['finding_0', 'major', 'approved'],
            ['finding_1', 'major', 'approved']
        ]);
    });
});

describe('G1 — the walk: the first entry sets the bar and only a strict drop is progress', () => {
    it('counts a streak of equal counts, plateaus at the shared constant, and never plateaus on a wave with nothing reviewed', async () => {
        const rig = await roundOneRig();

        // Two equal entries: 1 sets the bar, 1 does not lower it — one short of `SAMPLING_NO_PROGRESS_STREAK`.
        writeAudit(rig, [auditEntry(0, 0, 2), auditEntry(0, 1, 2)]);
        expect(revisionReviewProgressOf(rig.store, rig.story())).toMatchObject({
            wave: 0,
            reviewed: 2,
            bestBlockingFound: 2,
            improvements: 0,
            noImprovement: 1,
            plateaued: false
        });
        expect(revisionReviewPlateau(rig.store, rig.story())).toBe(false);

        // Three non-improvements: the stop. The constant is the sampling family's own — one policy, one
        // number — so the pin is against the constant, not a literal that can drift with it.
        writeAudit(rig, [auditEntry(0, 0, 2), auditEntry(0, 1, 2), auditEntry(0, 2, 2), auditEntry(0, 3, 2)]);

        const plateau = revisionReviewProgressOf(rig.store, rig.story());

        expect(plateau.reviewed).toBe(4);
        expect(plateau.noImprovement).toBe(SAMPLING_NO_PROGRESS_STREAK);
        expect(plateau.bestBlockingFound).toBe(2);
        expect(plateau.improvements).toBe(0);
        expect(plateau.plateaued).toBe(true);
        expect(revisionReviewPlateau(rig.store, rig.story())).toBe(true);

        // A strict drop resets the streak, so four reviewed revisions are not automatically a plateau.
        writeAudit(rig, [auditEntry(0, 0, 2), auditEntry(0, 1, 2), auditEntry(0, 2, 2), auditEntry(0, 3, 1)]);
        expect(revisionReviewProgressOf(rig.store, rig.story())).toMatchObject({
            bestBlockingFound: 1,
            improvements: 1,
            noImprovement: 0,
            plateaued: false
        });

        // A regression cannot re-raise the bar: the hill stays where the best revision proved it.
        writeAudit(rig, [auditEntry(0, 0, 2), auditEntry(0, 1, 1), auditEntry(0, 2, 3), auditEntry(0, 3, 3)]);
        expect(revisionReviewProgressOf(rig.store, rig.story())).toMatchObject({
            bestBlockingFound: 1,
            improvements: 1,
            noImprovement: 2,
            plateaued: false
        });

        // And the partition: the SAME rows under another wave describe history, not policy.
        writeAudit(rig, [auditEntry(1, 0, 2), auditEntry(1, 1, 2), auditEntry(1, 2, 2), auditEntry(1, 3, 2)]);
        expect(revisionReviewProgressOf(rig.store, rig.story())).toEqual({
            wave: 0,
            entries: [],
            reviewed: 0,
            bestBlockingFound: undefined,
            improvements: 0,
            noImprovement: 0,
            plateaued: false
        });
        expect(revisionReviewProgressOf(rig.store, rig.story(), 1)).toMatchObject({ wave: 1, reviewed: 4, plateaued: true });
    });
});

describe('G1 — the plateau stops the sampler, and a fresh wave re-arms it (legacy sampling)', () => {
    it('buys no `sample_unit` while the audit says the hill is flat, and dispatches one again on the next wave', async () => {
        const rig = await roundOneRig();

        armRoundTwo(rig);

        // The round arms on approved work (the other three legs hold), and the sampler is real work on the
        // queue: `wi_sample_summary_<round 2>_1`.
        expect(samplingArmed(rig.store, rig.story(), 2)).toBe(true);
        expect(offered(rig)).toEqual(['wi_sample_summary_0_2_1']);

        // The plateau: this wave has had four accepted revisions reviewed and none of the last
        // `SAMPLING_NO_PROGRESS_STREAK` lowered the bar. Re-reading the LIVE finding rows would say
        // "there is open work, keep sampling"; the stored audit is what stops it.
        writeAudit(rig, [auditEntry(0, 0, 2), auditEntry(0, 1, 2), auditEntry(0, 2, 2), auditEntry(0, 3, 2)]);

        expect(revisionReviewPlateau(rig.store, rig.story())).toBe(true);
        expect(samplingArmed(rig.store, rig.story(), 2)).toBe(false);
        expect(offered(rig)).toEqual([]);
        // Round 1 is unconditional (structure and research are the only gates), so the leg is scoped to
        // the refinement rounds exactly as `samplingArmed` states.
        expect(samplingArmed(rig.store, rig.story(), 1)).toBe(true);

        // THE DRAIN. The Author's clear of the sampling-failure escalation bumps `stories.sampling_wave`
        // (`engine.ts:rearmSamplingWave`; the row mechanics are pinned in `phase1-gates.test.ts` T12/E).
        // The stale audit does NOT carry into the new wave, so the sampler is offered again — under the
        // wave-scoped key, which is the whole point of the bump.
        rig.store.stories.update(
            rig.storyId,
            { sampling_wave: 1 },
            { run_ref: null, author: true, why: 'seed: the cleared escalation re-arms wave 1 (T12/E)' },
            [{ id: rig.storyId, rev: rig.story().rev }]
        );

        expect(revisionReviewProgressOf(rig.store, rig.story())).toEqual({
            wave: 1,
            entries: [],
            reviewed: 0,
            bestBlockingFound: undefined,
            improvements: 0,
            noImprovement: 0,
            plateaued: false
        });
        expect(samplingArmed(rig.store, rig.story(), 2)).toBe(true);
        expect(offered(rig)).toEqual(['wi_sample_summary_0_2_w1_1']);
    });
});
