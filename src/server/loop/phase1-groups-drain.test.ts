/**
 * HARDENING (item 5) — the drain probe and the phase-① SIGN-OFF read the GROUP pipeline, not the
 * sampling rows it never writes.
 *
 * Both rules were written against the sampler and simply had nothing to say about a group book:
 *
 *   1. `drainPreconditions` (§6.7, L-37's condition 3) enumerated sample drafts, screening passes and
 *      the round's arm. A grouped book has none of them, so the probe answered "nothing owed" while
 *      five groups still had no text and its Critic seats had never reported — the Author saw
 *      `drained` ("out of authorised work", L-37a) on a Summary that was not written yet;
 *   2. the sign-off gate held on `deepReviewPassesOwed(selectedSummaryRevision)`, and a grouped book
 *      has NO selected Summary revision, so that read returned 0 and the sweep offered the LOCK over an
 *      Overview the seats had not read (L-29 signed a verdict nobody finished).
 *
 * Both now answer from ONE place — `phrase/exclusion.ts:groupPipelineOwed`, built from the same gates
 * `loop/work.ts:phase1GroupCandidates` builds its candidates from — so the queue and the probe cannot
 * tell two stories about one book. That parity is what these pins hold, stage by stage:
 *
 *   * stage by stage, the exact sentences the Author reads, in the order §6.4's steps run;
 *   * the seat claim keys the probe counts are the keys the GENERATOR dispatches (the drift this defect
 *     hides — the probe and the queue spelling one key two ways);
 *   * D-65's scoring seat takes the FIRST dispatch slot of a new vector (`loop/work.ts` candidate 2b,
 *     `rank: -1`), and it is in the in-flight sentence while it runs yet in no owed count — so the
 *     sign-off test below counts the score row and the seat row across two sweeps, and the lock is still
 *     held by the engine rather than handed to the Author early;
 *   * the sign-off waits for the seats and still opens once they have reported (the gate got TIGHTER to
 *     match the rail, never looser);
 *   * a legacy sampling book is untouched: no group line ever appears in its drain, and the grouped read
 *     answers zero there.
 *
 * Values were read off the rig, not guessed. Runs are seeded as rows (`store.runs.create`) so each stage
 * is one state, and a closed run — not a live one — is what pays a seat (`records.ts:deepReviewPassesOwed`
 * applies the same evidence rule to the legacy deep review).
 */
import { describe, expect, it } from 'vitest';

import { createRig, type Rig } from './mock';
import { drainPreconditions } from './status';
import { generateWork } from './work';
import {
    GROUP_DRAFT_ITEM_PREFIX,
    groupCheckSeatKey,
    groupPipelineOwed,
    groupReviewSeatKey,
    sectionScoreClaimKey
} from '../phrase/exclusion';
import { groupRevisionVector, groupVectorHash, installGroupRevisions } from '../phrase/revisions';
import { AUTHOR_ATTR } from '../run/mock';
import type { PhraseGroup, RunState } from '../../shared/types';

/** The phase-① drain lines, in the order §6.4's steps run — copied so a wording change breaks here. */
const NO_BRIEF = 'no accepted Seed Brief describes the current Seed — the Editor has not structured it yet (§6.4 step 1)';
const STEP_3 = (n: number) => `${n} group${n === 1 ? '' : 's'} still owe the Overview a draft or a fix pass (R2, §6.4 step 3)`;
const IN_FLIGHT = (n: number) => `${n} group-pipeline run${n === 1 ? '' : 's'} still in flight (R5, §6.4 steps 3-6)`;
// The generic live-Writer clause (L-37's "single full pass" guard) — it fires on ANY live Writer run, so
// on a grouped book it says the same moment at the coarser granularity. Both lines are correct; the
// grouped one names the pipeline, this one names the artifact that is mid-write.
const WRITING = (n: number) => `${n} Writer${n === 1 ? '' : 's'} still running (§4.15: no draft has been filed yet)`;
const STRUCTURED = (n: number) =>
    `${n} Critic pass${n === 1 ? '' : 'es'} still owed on the installed group Overview (R3, R5, §6.4 step 4)`;
const DEEP = (n: number) =>
    `${n} deep-review pass${n === 1 ? '' : 'es'} still owed for the installed group Overview (§6.4 step 6, R5)`;

/** A group book with NO sweeps: every stage below is built by hand, so each unmet list is one state. */
async function rigged(): Promise<Rig> {
    return createRig({
        summaryMode: 'groups',
        summarySampling: 5,
        // One Critic seat per pass: `summary_critics` IS `screeningSizeOf`, so the seat counts stay small
        // and every owed-count below is a literal.
        summaryCritics: 1,
        // D-51 waiver: the brief asks no research, so §6.4 step 2 never enters these lists.
        crew: { researchQuestions: [] }
    });
}

const groupsOf = (rig: Rig): PhraseGroup[] =>
    rig.store.phraseGroups.list().filter((group) => group.story_id === rig.storyId);

/** The vector the seats of the CURRENT text are keyed by — the same read the rail and the generator use. */
const vectorHashOf = (rig: Rig): string => groupVectorHash(groupRevisionVector(rig.store, rig.storyId));

const drain = (rig: Rig) => drainPreconditions(rig.store, rig.story());

/** One run row of the group pipeline — `state` decides whether it holds the drain or pays a seat. */
function seedRun(rig: Rig, key: string, state: RunState, groupRefs?: string[]): void {
    rig.store.runs.create(
        {
            story_id: rig.storyId,
            work_item_ref: key,
            role: groupRefs === undefined ? 'critic' : 'writer',
            state,
            started_at: '2026-11-24T10:00:00.000Z',
            ended_at: state === 'torn_down' ? '2026-11-24T10:00:01.000Z' : null,
            tokens: 12,
            kind: 'work',
            no_op: false,
            delegated: [],
            ...(groupRefs === undefined ? {} : { group_refs: groupRefs })
        },
        { run_ref: null, author: true, why: `seed: a ${state} group-pipeline run on ${key}` }
    );
}

/** The accepted answer of a draft pass, installed for real: five `latest` revisions, mirror in sync (R6). */
function installAll(rig: Rig): void {
    installGroupRevisions(
        rig.store,
        rig.story(),
        groupsOf(rig).map((group) => ({ group, content: `${group.key}: the installed text.` })),
        AUTHOR_ATTR,
        { runRef: 'run_writer', workItemRef: `${GROUP_DRAFT_ITEM_PREFIX}_summary_0_probe_1` }
    );
}

describe('the drain probe names the group pipeline stage by stage (§6.7, R2/R3/R5)', () => {
    it('holds on the Seed Brief, the batch, the live pass, and each unpaid seat — in that order', async () => {
        const rig = await rigged();

        // Stage 0 — the rig's scripted Editor has already structured the Seed (`mock.ts:seedPhase1Structure`
        // with `crew.researchQuestions: []`, D-51's waiver), so §6.4 steps 1-2 are paid and the only
        // sentence is the batch: five unwritten groups. This is the state the sampler's clauses skipped
        // past into "drained".
        expect(drain(rig)).toEqual({ met: false, unmet: [STEP_3(5)] });

        // Stage 0b — a Seed the Editor has NOT structured yet (here: the Author changed the Seed, so the
        // accepted brief describes the old one — `records.ts:currentSeedBrief` counts that as none). The
        // step-1 sentence replaces the batch line, exactly as it does on a sampling book.
        const original = rig.story();

        rig.store.stories.update(
            original.id,
            { idea: 'A lighthouse keeper trades places with the sea.' },
            { run_ref: null, author: true, why: 'seed: the Author rewrote the Seed (D-25a)' },
            [{ id: original.id, rev: original.rev }]
        );

        expect(drain(rig)).toEqual({ met: false, unmet: [NO_BRIEF] });

        const stale = rig.story();

        rig.store.stories.update(
            stale.id,
            { idea: original.idea },
            { run_ref: null, author: true, why: 'seed: the Seed is the one the accepted brief describes' },
            [{ id: stale.id, rev: stale.rev }]
        );

        expect(groupPipelineOwed(rig.store, rig.story())).toEqual({
            drafts: 5,
            structuredReviews: 0,
            deepReviews: 0
        });
        expect(drain(rig)).toEqual({ met: false, unmet: [STEP_3(5)] });

        // Stage 2 — the batch is in flight: the live row is named, and the groups are still owed until it
        // installs (a live run has not reported, and holds its groups, R4).
        seedRun(rig, `${GROUP_DRAFT_ITEM_PREFIX}_summary_0_probe_1`, 'working', groupsOf(rig).map((g) => g.id));

        expect(drain(rig)).toEqual({ met: false, unmet: [WRITING(1), IN_FLIGHT(1), STEP_3(5)] });

        // Stage 3 — the pass lands and the text exists, so the seats open. The draft line goes silent and
        // the structured seat speaks: this is the sentence the sampler's "0 of N samples" used to cover.
        const live = rig.store.runs.list().find((run) => run.state === 'working')!;

        rig.store.runs.update(
            live.id,
            { state: 'torn_down', ended_at: '2026-11-24T10:00:02.000Z' },
            { run_ref: null, author: true, why: 'seed: the batch closed without installing' },
            [{ id: live.id, rev: live.rev }]
        );
        installAll(rig);

        expect(groupPipelineOwed(rig.store, rig.story())).toEqual({
            drafts: 0,
            structuredReviews: 1,
            deepReviews: 0
        });
        expect(drain(rig)).toEqual({ met: false, unmet: [STRUCTURED(1)] });

        // THE DRIFT PIN: the seat the probe counts is the seat the GENERATOR dispatches — one key, two
        // readers of it. If the generator ever spells the seat differently, the probe would report an
        // owed pass the queue can never pay (or the reverse).
        const hash = vectorHashOf(rig);

        expect(
            generateWork(rig.store, rig.story(), { at: '2026-11-24T10:00:03.000Z', phase: 'summary' })
                .filter((candidate) => candidate.item.kind === 'review_groups')
                .map((candidate) => candidate.key)
        ).toEqual([groupReviewSeatKey(hash, 1)]);

        // Stage 4 — the structured seat has reported (a CLOSED run, not a live one), so the deep
        // cross-group pass becomes the owed work: §6.4 step 6, the tool-carrying pass (R5).
        seedRun(rig, groupReviewSeatKey(hash, 1), 'torn_down');

        expect(groupPipelineOwed(rig.store, rig.story())).toEqual({
            drafts: 0,
            structuredReviews: 0,
            deepReviews: 1
        });
        expect(drain(rig)).toEqual({ met: false, unmet: [DEEP(1)] });

        // A LIVE seat is not a reported one: the same seat with a live row still owes the pass, and the
        // in-flight line names it while it runs.
        rig.store.runs.deleteWhere(
            (run) => run.work_item_ref === groupReviewSeatKey(hash, 1),
            { run_ref: null, author: true, why: 'seed: replace the closed seat with a live one' }
        );
        seedRun(rig, groupReviewSeatKey(hash, 1), 'reporting');

        expect(drain(rig)).toEqual({ met: false, unmet: [IN_FLIGHT(1), STRUCTURED(1)] });

        // Stage 5 — every seat paid: the phase may read drained, with nothing to say.
        rig.store.runs.deleteWhere(
            (run) => run.work_item_ref === groupReviewSeatKey(hash, 1),
            { run_ref: null, author: true, why: 'seed: the live seat is replaced by its closed ledger row' }
        );
        seedRun(rig, groupReviewSeatKey(hash, 1), 'torn_down');
        seedRun(rig, groupCheckSeatKey(hash, 1), 'torn_down');

        expect(groupPipelineOwed(rig.store, rig.story())).toEqual({ drafts: 0, structuredReviews: 0, deepReviews: 0 });
        expect(drain(rig)).toEqual({ met: true, unmet: [] });
    });

    it('refuses the lock while the seats have not reported, and offers it once they have (L-29, R5)', async () => {
        const rig = await rigged();

        installAll(rig);

        // THE FIX: the Goal passes and the book has no competing drafts (a grouped book has none — each
        // group installs its own revision), so before this pass the sweep handed the Author the lock with
        // every Critic seat still unpaid. It now holds and dispatches the seat instead.
        const swept = await rig.step();

        expect({ status: swept.stories[0]?.status, pending: swept.stories[0]?.pending_kind }).toEqual({
            status: 'ready',
            pending: 'none'
        });

        // D-67 changed WHICH job takes the first slot. The scoring seat is armed by the CLEAN selection
        // (`phrase/reviewed.ts:cleanSelectionOf`), and this book has five installed revisions and no
        // cross-group verdict yet, so nothing here is scoreable — the first sweep dispatches the review seat
        // this test is about, and the guarantee below is unchanged. (The scoring seat's `rank: -1`
        // precedence is pinned where the fixture stamps a vector clean: `loop/section-scores.test.ts`.)
        expect(rig.store.runs.list().map((run) => run.work_item_ref)).toEqual([
            groupReviewSeatKey(vectorHashOf(rig), 1)
        ]);

        await rig.step();

        // Still no score seat after two sweeps: the deep pass has not CLOSED over this vector, so no group
        // carries a Clean stamp, and the queue goes on paying the review seats the phase actually owes.
        expect(rig.store.runs.list().map((run) => run.work_item_ref)).not.toContain(
            sectionScoreClaimKey(vectorHashOf(rig))
        );
        expect(rig.store.runs.list()).toHaveLength(2);

        // The rest of the pipeline runs to idle, and THEN the lock is offered: the gate opened on the
        // phase's evidence, exactly as the rail counts it.
        await rig.run();

        expect({ status: rig.story().status, pending_kind: rig.story().pending_kind }).toEqual({
            status: 'pending',
            pending_kind: 'phase_signoff'
        });
        expect(groupPipelineOwed(rig.store, rig.story())).toEqual({ drafts: 0, structuredReviews: 0, deepReviews: 0 });
    });
});

describe('a legacy sampling book keeps its own drain clauses', () => {
    it('never sees a group line, and the grouped read answers zero there', async () => {
        const rig = await createRig({ summarySampling: 1, summaryCritics: 1, crew: { researchQuestions: [] } });

        const state = drainPreconditions(rig.store, rig.story());

        // The sampler's clauses, unchanged — and no group sentence anywhere in them.
        expect(state.unmet.length).toBeGreaterThan(0);
        expect(state.unmet.filter((line) => line.includes('group'))).toEqual([]);
        expect(state.unmet.filter((line) => line.includes('§6.4 step 1'))).toEqual([]);

        // The grouped reads are inert on this book: no catalog, so nothing owed.
        expect(groupPipelineOwed(rig.store, rig.story())).toEqual({ drafts: 0, structuredReviews: 0, deepReviews: 0 });
        expect(rig.store.phrases.list()).toEqual([]);
    });
});
