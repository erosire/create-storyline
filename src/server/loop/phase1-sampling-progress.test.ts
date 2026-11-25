// H2/R5 — the hill's LEDGER: what it takes to be a ledger is that it survives the restart.
//
// `records.ts:samplingProgressOf` deliberately derives the wave's numbers (attempts, best unresolved
// blocking fix, the no-improvement streak, the ceiling) from rows the Store already owns — `runs` under
// the wave's claim keys, `Revision.run_ref` attribution, and the `sampling_history` line the selection
// commit writes. There is no `story.sampling_progress` field, and that choice is only safe if the
// derivation reads EXACTLY the same numbers after the book is closed and reopened. A progress counter
// that reset on restart would let a stalled hill climb forever, which is the failure mode the whole
// no-improvement policy exists to prevent, so this file pins it against a real on-disk Store:
//
//   1. attempts / best / streak / ceiling are identical across `close()` + `Store.load`;
//   2. the persisted `sampling_wave` is what gives the Author's clear a FRESH baseline — the spent
//      wave's rows stay on the book and stop counting;
//   3. a refused candidate advances nothing: no round, no task, no finding, no Summary;
//   4. the wave bump is guarded by the wave the escalation RECORDED — the structured answer to "which
//      wave is this about" is that prose number, so the copy is part of the contract (no Task schema
//      change; see `engine.ts:rearmSamplingWave`).
//
// Ids are ZERO-BASED here from the first draft (`revision_0`), unlike the older phase-① fixtures, which
// are still being migrated to the Store's zero-based counter (`store.ts:Collection.create`, W1).
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { Store } from '../store';
import { createRig, seedFinding, seedTask } from './mock';
import { generateWork, SAMPLING_FAILURE_PREFIX } from './work';
import {
    loopAttr,
    roundSampleScores,
    samplingCapOf,
    samplingProgressOf,
    samplingWaveOf,
    selectedSummaryRevision,
    storySummary
} from './records';
import type { Rig } from './mock';
import type { SamplingProgress } from './records';
import type { Story } from '../../shared/types';

/**
 * A fresh scratch tree under the repo's own `Temp/` — never the OS temp (AGENTS.md). This is the same
 * helper `store.test.ts` uses, so a persistence row is written to the same place a Store test writes one.
 */
async function scratchDir(): Promise<string> {
    const base = path.resolve(process.cwd(), 'Temp');

    await mkdir(base, { recursive: true });

    return mkdtemp(path.join(base, 'create-storyline-sampling-progress-'));
}

function storyOf(rig: Rig): Story {
    return rig.store.stories.require(rig.storyId);
}

/** Step until `done` holds: the pipeline dispatches one job per family per sweep, so rows land late. */
async function settleUntil(rig: Rig, done: () => boolean, sweeps = 20): Promise<void> {
    for (let sweep = 0; sweep < sweeps; sweep += 1) {
        if (done()) return;

        await rig.step();
    }

    if (!done()) throw new Error('the sweep never reached the state this row asks about');
}

/**
 * The progress facts, WITHOUT the `completed` candidate set (which carries whole scored samples and
 * would make the diff unreadable). Everything here is a scalar the policy actually branches on.
 */
function ledger(progress: SamplingProgress) {
    return {
        round: progress.round,
        wave: progress.wave,
        refinement: progress.refinement,
        attempts: progress.attempts,
        invalidAttempts: progress.invalidAttempts,
        bestUnresolved: progress.bestUnresolved,
        improvements: progress.improvements,
        noImprovement: progress.noImprovement,
        ceiling: progress.ceiling,
        stalledForProgress: progress.stalledForProgress,
        spent: progress.spent
    };
}

/** The one escalation this Story is allowed to hold, or the assertion that follows has no subject. */
function escalationOf(rig: Rig) {
    const row = rig.store.tasks.list().find((task) => task.kind === 'escalation');

    if (row === undefined) throw new Error('the rig has no escalation row');

    return row;
}

/**
 * A crew whose drafts clear NOTHING from the fix list: clean screening counts, an uncertified repair.
 * That is the state the old pipeline escaped by installing the least-bad text, and it is a
 * regression-free refusal — the drafts measure the hill (best unresolved blocking fix 1) and never
 * climb it, which is the streak case rather than the regression case.
 */
const refusesTheFix = {
    screenFixes: ({ fixIds }: { fixIds: string[] }) =>
        fixIds.map((fix_ref) => ({
            fix_ref,
            status: 'unresolved' as const,
            evidence: 'ending: She floods it. — the promise the brief makes is still not paid'
        }))
};

/** The two records that arm a refinement round, written the way the dial leaves them (D-34). */
function armRefinementRound(rig: Rig) {
    const summary = storySummary(rig.store, rig.storyId);
    const selected = selectedSummaryRevision(rig.store, rig.storyId);

    if (summary === undefined || selected === undefined) throw new Error('the rig has no installed Summary');

    const finding = seedFinding(rig.store, rig.storyId, {
        target_ref: summary.id,
        criterion_ref: 'C-14',
        cost: 'major',
        state: 'approved',
        fingerprint: 'C-14|ledger',
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

/** Round 1 installed; the caller arms round 2 and watches it refuse itself. */
async function installedRig(options: { store?: Store; crew?: typeof refusesTheFix } = {}) {
    const rig = await createRig({
        store: options.store,
        summarySampling: 1,
        summaryCritics: 1,
        crew: options.crew ?? refusesTheFix
    });

    await rig.run();

    // `summary_sampling` 1 + `SAMPLING_RETRY_ALLOWANCE` 3: the static ceiling a clean wave never extends.
    expect(samplingCapOf(rig.story())).toBe(4);

    return rig;
}

describe('H2/R5 — the hill ledger is derived from stored rows, and survives the book being reopened', () => {
    it('reports the identical attempts, best, streak and ceiling after `close()` and `Store.load`', async () => {
        const root = await scratchDir();
        const rig = await installedRig({ store: await Store.load(root) });

        const { task } = armRefinementRound(rig);

        await settleUntil(rig, () =>
            rig.store.tasks.list().some((task_row) => task_row.kind === 'escalation' && task_row.state === 'open')
        );

        const before = ledger(samplingProgressOf(rig.store, storyOf(rig), 2));

        // THE POLICY, in numbers. Four attempts because the first one MEASURED the hill and the next
        // three proved nothing better (`SAMPLING_NO_PROGRESS_STREAK`); the ceiling is the static cap,
        // because nothing was ever improved. A regression rig — a draft that introduces a blocking issue
        // — never measures at all, so its streak only closes the drain and the escalation; the sample
        // queue stops on the cap (`work.ts:1537`), which is the four attempts that rig spends too
        // (`phase1-hill-climb.test.ts`, N-1).
        expect(before).toEqual({
            round: 2,
            wave: 0,
            refinement: true,
            attempts: 4,
            invalidAttempts: 0,
            bestUnresolved: 1,
            improvements: 0,
            noImprovement: 3,
            ceiling: 4,
            stalledForProgress: true,
            spent: true
        });

        await rig.store.close();

        const reloaded = await Store.load(root);
        const story = reloaded.stories.require(rig.storyId);

        expect(ledger(samplingProgressOf(reloaded, story, 2))).toEqual(before);

        // The rows the derivation read are the persisted ones — no in-memory counter is involved. Note
        // what is NOT on the book: a round that never installs writes no §6.6 audit line at all, so the
        // only surviving record of these four refused attempts is the `runs` family and the
        // `Revision.run_ref` attribution — exactly the rows the journal replays. That is why the ledger
        // is derived rather than stored.
        const audit = story.sampling_history ?? [];

        expect(story.sampling_wave).toBeUndefined();
        expect(audit.map((line) => `${line.round}:${line.wave}:${line.attempts}:${line.ceiling}`)).toEqual(['1:0:1:4']);

        // H2 — the per-candidate half of that line, in its ROUND-1 shape: the installed draft is the
        // `accepted` line, it owed no reason (it was eligible), and it carries NO origin split or
        // minimality counts. Round 1 has no accepted draft to inherit a defect from, so those fields are
        // ABSENT rather than zero — a `0` would put "this draft broke nothing" on the Author's pane when
        // the round never made that comparison (`sample-select.ts:scoreSample`, R5).
        expect(audit[0].samples).toEqual([
            {
                revision_id: 'revision_0',
                critical: 0,
                high: 0,
                valid: true,
                unresolved_fixes: [],
                outcome: 'accepted'
            }
        ]);

        // And the escalation the Author reads states the same numbers the ledger derived: the copy is a
        // rendering of the ledger, not a second count that could disagree with it. The rendering is the
        // H1/N-1 shape `documents/phase-1-research-pipeline.md` pins — the cap in the title, the wave and
        // the draft count in the head, and one `task_n (unresolved on revision_n)` clause per refused
        // draft — and only `SAMPLING_FAILURE_PREFIX` plus the head's `wave: n` marker are load-bearing for
        // the loop (`openEscalationTask`'s reuse key and `engine.ts:rearmSamplingWave`). The title tail and
        // the detail's prose are free to change; the four attempts, the wave, and the outstanding rows
        // are the row's own claim, and they still match `before` above.
        const row = reloaded.tasks
            .list()
            .find((task_row) => task_row.kind === 'escalation' && task_row.title.startsWith(SAMPLING_FAILURE_PREFIX));

        expect(row?.title).toBe(
            `${SAMPLING_FAILURE_PREFIX} 4 attempts — no draft answered the fixes this round was armed with`
        );
        expect(row?.detail).toContain('round 2 drafted 4 Summary drafts and no screening pass certified them (wave: 0).');
        expect(row?.detail).toContain(
            [
                `Outstanding: ${task.id} (unresolved on revision_1);`,
                `${task.id} (unresolved on revision_2);`,
                `${task.id} (unresolved on revision_3);`,
                `${task.id} (unresolved on revision_4).`
            ].join(' ')
        );
        expect(row?.detail).toContain(
            'The selected Summary is unchanged and every fix task is still open — nothing was closed on a draft that failed (§6.8, R4).'
        );

        await reloaded.close();
    });

    it('starts a FRESH baseline on the persisted wave after the Author clears the row', async () => {
        const root = await scratchDir();
        const rig = await installedRig({ store: await Store.load(root) });
        const { task } = armRefinementRound(rig);

        await settleUntil(rig, () =>
            rig.store.tasks.list().some((task_row) => task_row.kind === 'escalation' && task_row.state === 'open')
        );

        const stalled = escalationOf(rig);

        expect(samplingWaveOf(storyOf(rig))).toBe(0);

        // The Author's clear (L-36/U-1b): `wontfix` the row, and the next sweep re-arms a wave.
        rig.store.tasks.update(
            stalled.id,
            { state: 'wontfix' },
            loopAttr('test: the Author cleared the sampling escalation (L-36, U-1b)'),
            [{ id: stalled.id, rev: stalled.rev }]
        );

        await settleUntil(rig, () => samplingWaveOf(rig.story()) === 1);

        // The wave is a STORED number, so the restart below cannot lose it — and it is the ONLY thing
        // that separates the new wave's ledger from the spent one.
        expect(storyOf(rig).sampling_wave).toBe(1);

        // Wave 1's counters start at zero and the spent wave's rows stop counting: `sampleAttempts` and
        // `waveSampleRevisions` are scoped by the wave's claim key (`wi_sample_<summary>_<round>_w<n>_`),
        // so wave 0's four attempts are still on the book (`runs`, `revision_*`) and are not progress.
        // One attempt has run by now — the bump and the first dispatch land in the same sweep — but its
        // screening family is the NEXT sweep's job, so nothing has been measured yet and the new wave has
        // no baseline at all. `bestUnresolved` being `undefined` here is the proof the baseline did not
        // survive the bump: wave 0 proved 1, and wave 1 starts over.
        expect(ledger(samplingProgressOf(rig.store, storyOf(rig), 2, 1))).toEqual({
            round: 2,
            wave: 1,
            refinement: true,
            attempts: 1,
            invalidAttempts: 0,
            bestUnresolved: undefined,
            improvements: 0,
            noImprovement: 0,
            ceiling: 4,
            stalledForProgress: false,
            spent: false
        });

        // What the spent wave OWED is frozen in its escalation: the four drafts the wave bought, spelled
        // in its head. Re-reading wave 0 after the bump is the ROUND-family read — `records.ts:samplePrefixOf`
        // gives wave 0 the whole round prefix, so wave 1's key (`..._w1_1`) sits inside it and the count is
        // 5. That is the documented shape of the wave-0 read, and no live reader takes it: every one of
        // them passes `samplingWaveOf(story)`, which is 1 here (and the escalation below was written while
        // it was 0, so the copy still says four).
        expect(ledger(samplingProgressOf(rig.store, storyOf(rig), 2, 0)).attempts).toBe(5);
        expect(escalationOf(rig).detail).toContain(
            'round 2 drafted 4 Summary drafts and no screening pass certified them (wave: 0).'
        );

        // Let wave 1's first candidate finish being screened: it MEASURES the hill at the same height
        // wave 0 left it (one unresolved blocking fix), and measuring is not an improvement — so the
        // streak is 0, the ceiling is still the static cap, and the round is buyable again.
        await settleUntil(rig, () => samplingProgressOf(rig.store, storyOf(rig), 2, 1).bestUnresolved !== undefined);

        const waveOne = ledger(samplingProgressOf(rig.store, storyOf(rig), 2, 1));

        expect(waveOne).toEqual({
            round: 2,
            wave: 1,
            refinement: true,
            attempts: 1,
            invalidAttempts: 0,
            bestUnresolved: 1,
            improvements: 0,
            noImprovement: 0,
            ceiling: 4,
            stalledForProgress: false,
            spent: false
        });

        const wave = storyOf(rig).sampling_wave;

        await rig.store.close();

        const reloaded = await Store.load(root);
        const story = reloaded.stories.require(rig.storyId);

        expect(story.sampling_wave).toBe(wave);
        expect(ledger(samplingProgressOf(reloaded, story, 2, samplingWaveOf(story)))).toEqual(waveOne);
        // THE REASON THE LEDGER IS DERIVED, NOT STORED: a round that never installs writes NO history
        // line (§6.6's audit belongs to the selection commit), so the only surviving record of four
        // refused attempts is the `runs` family and the `Revision.run_ref` attribution — both of which
        // the journal replays. The one line on the book is still round 1's install.
        expect((story.sampling_history ?? []).map((line) => `${line.round}:${line.wave}:${line.attempts}`)).toEqual(['1:0:1']);

        // A fresh wave also means the round is buyable again: the queue offers a wave-1 sample key, and
        // the fix task the drafts refused is still the demand they are armed with.
        expect(
            generateWork(reloaded, story, { at: new Date().toISOString(), phase: 'summary' })
                .map((candidate) => candidate.key)
                .some((key) => key.startsWith('wi_sample_summary_0_2_w1_'))
        ).toBe(true);
        expect(reloaded.tasks.require(task.id).state).toBe('open');

        await reloaded.close();
    });

    it('advances nothing on a refused candidate: no round, no task, no finding, no Summary', async () => {
        const rig = await installedRig();
        const { finding, task } = armRefinementRound(rig);
        const installed = installedPremise(rig);

        await settleUntil(rig, () =>
            rig.store.tasks.list().some((task_row) => task_row.kind === 'escalation' && task_row.state === 'open')
        );

        // Four drafts competed, and every one of them is `eligible: false` — the round had nobody it was
        // allowed to install, so the hill installed NOTHING rather than the least-bad text (R3).
        const scored = roundSampleScores(rig.store, rig.storyId, 2);

        expect(scored.map((sample) => sample.revision.id)).toEqual(['revision_1', 'revision_2', 'revision_3', 'revision_4']);
        expect(scored.map((sample) => sample.eligible)).toEqual([false, false, false, false]);
        expect(scored.map((sample) => sample.fixesUnresolved)).toEqual([[task.id], [task.id], [task.id], [task.id]]);
        // Round 1's install is the only one the book has: `sampling_round` is the ACCEPTED round, and a
        // refused round cannot move it.
        expect(rig.story().sampling_round).toBe(1);
        expect(installedPremise(rig)).toBe(installed);
        expect(rig.store.tasks.require(task.id).state).toBe('open');
        expect(rig.store.findings.require(finding.id).state).toBe('approved');
        // The drafts themselves: four `drafted` rows of round 2 beside the one selected row of round 1.
        expect(
            rig.store.revisions
                .list()
                .sort((left, right) => left.id.localeCompare(right.id))
                .map((revision) => `${revision.id}:r${revision.round}:${revision.origin}:${revision.state}`)
        ).toEqual([
            'revision_0:r1:sampled:selected',
            'revision_1:r2:refined:drafted',
            'revision_2:r2:refined:drafted',
            'revision_3:r2:refined:drafted',
            'revision_4:r2:refined:drafted'
        ]);
        // Nothing left to buy, and no second question: exactly one escalation row.
        expect(rig.store.tasks.list().filter((task_row) => task_row.kind === 'escalation')).toHaveLength(1);
    });

    it('bumps the wave once, because the row records which wave it was opened at (no Task schema change)', async () => {
        const rig = await installedRig();

        armRefinementRound(rig);

        await settleUntil(rig, () =>
            rig.store.tasks.list().some((task_row) => task_row.kind === 'escalation' && task_row.state === 'open')
        );

        const stalled = escalationOf(rig);

        // `engine.ts:rearmSamplingWave` asks "which wave is this row about?" with `/wave:\s*(\d+)/` over
        // the detail — there is no structured wave field on §4.7's Task, and adding one is a schema
        // change this task explicitly does not make. So the COPY is the contract, and this is the row
        // that fails when someone rewrites it.
        const recorded = /wave:\s*(\d+)/.exec(stalled.detail ?? '');

        expect(recorded?.[0]).toBe('wave: 0');
        expect(Number(recorded?.[1])).toBe(samplingWaveOf(rig.story()));

        // Pretend the bump already happened (a second sweep, or the Author nudging the wave): closing
        // the SAME row must not bump the story that has moved past it — otherwise a cleared row re-arms
        // the wave every sweep, which is the loop the guard exists to stop.
        const story = rig.story();

        rig.store.stories.update(
            story.id,
            { sampling_wave: 1 },
            loopAttr('test: the wave is already past the row the Author is about to clear'),
            [{ id: story.id, rev: story.rev }]
        );
        rig.store.tasks.update(
            stalled.id,
            { state: 'wontfix' },
            loopAttr('test: the Author cleared the sampling escalation'),
            [{ id: stalled.id, rev: stalled.rev }]
        );

        await rig.step();

        expect(rig.story().sampling_wave).toBe(1);
        // The guard's third leg also refuses: once the wave is 1 the wave-1 family has no attempts, so
        // the round is buyable again and the sweep buys a sample rather than opening a second question.
        expect(rig.store.tasks.list().filter((task_row) => task_row.kind === 'escalation' && task_row.state === 'open')).toEqual([]);
    });
});

/** The premise the installed Summary carries — the thing a refused round must not replace. */
function installedPremise(rig: Rig): string {
    const selected = selectedSummaryRevision(rig.store, rig.storyId);

    if (selected === undefined) throw new Error('the rig has no selected Summary draft');

    return String((selected.body as { fields?: Record<string, unknown> }).fields?.premise ?? '');
}
