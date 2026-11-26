/**
 * MAJOR 3 (2026-11-26) — THE DEEP REVIEW SEAT IS PAID BY ITS REPORT, NOT BY ITS RUN ROW.
 *
 * The deep cross-group pass (`wi_group_check_<vectorHash>_<pass>`) is the loop's only TOOL-CARRYING review:
 * it reads the book with tools and ends by calling `submitVerdict`. That is also why it is the one review
 * family whose CLOSED state proves nothing — the executor reaches its success branch whenever the session
 * merely ENDED, so a pass capped at its turn ceiling or abandoned mid-flight leaves a `torn_down`
 * (or `abandoned`) row and NOTHING on the record (`run/plugins/critic-termination.ts`, whose header
 * measures this pass at 6-17 minutes and 200k-380k tokens). Before this fix the sign-off gate and the drain
 * asked "does a closed run row exist?" and the Author's rail asked "did a run ANSWER?", and on this family
 * those two questions have different answers — so a vector could offer `phase_signoff` with nothing owed
 * while the rail still read "0 of 5 deep reviews". These tests pin the repair:
 *
 *   1. ONE PREDICATE. `phrase/exclusion.ts:groupCheckSeatAnswered` (a `verdicts` row whose `run_ref` is one
 *      of the seat's runs — `submitVerdict` being the call that ENDS the pass) is the answer read for the
 *      queue (`loop/work.ts`, both deep legs), the owed count (`phrase/exclusion.ts:groupPipelineOwed`), the
 *      sign-off gate (`loop/status.ts` through that owed count) and the rail
 *      (`api/projections.ts:reportedDeepSeatsFor` → `review.deep_reviews_on_current_vector`).
 *      `records.ts:isReportedRun` — right for the STRUCTURED seats, where `torn_down` does imply an answer —
 *      is deliberately NOT used here, and these tests show the two readings disagree on a silent pass.
 *   2. A BOUNDED CEILING. A seat that never reports is re-armed, so re-arming needs a stop: the family
 *      parks at `groupCheckAttemptCap(critics) = critics + SAMPLING_RETRY_ALLOWANCE` — the loop's one
 *      existing retry budget (`records.ts:screeningCapOf` for a draft's screens,
 *      `groupReviewAttemptCap` for the structured seats), not a new number. On the default dial that is 5
 *      owed passes + 3 retries = at most 8 deep passes per vector, never one per sweep.
 *   3. GATE AND RAIL MOVE TOGETHER, on the SAME seat set, from the SAME rows. The pair
 *      (`groupPipelineOwed().deepReviews`, `review.deep_reviews_on_current_vector`) is asserted together at
 *      every state of one ledger, because "the seat is settled" and "the seat is counted reviewed" being
 *      different numbers is the exact defect. The one deliberate asymmetry is the parked family: exhaustion
 *      stops the loop BUYING passes (the gate stops re-arming) without ever letting the rail claim an
 *      unfiled review — so a parked vector reads `deepReviews: 0` beside `deep_reviews_on_current_vector: 0`
 *      and the Author is never told a silent pass was a review.
 *
 * VALUES: seat keys and vector hashes are derived from the rows (they are content hashes the store mints);
 * the numbers the Author's dials and this rule decide — seat counts, attempt counts, ceiling arithmetic and
 * both rail counters — are pinned as literals, because those are the product's promises.
 */
import { describe, expect, it } from 'vitest';
import { createRig, type Rig } from './mock';
import { generateWork } from './work';
import { isLiveRun, isReportedRun, runsForItem, SAMPLING_RETRY_ALLOWANCE, screeningSizeOf, storySummary } from './records';
import {
    GROUP_DRAFT_ITEM_PREFIX,
    groupCheckAttemptCap,
    groupCheckAttempts,
    groupCheckSeatAnswered,
    groupCheckSeatKey,
    groupCheckSeatSettled,
    groupPipelineOwed,
    groupReviewSeatKey
} from '../phrase/exclusion';
import { groupRevisionVector, groupVectorHash, installGroupRevisions } from '../phrase/revisions';
import { phraseView } from '../api/projections';
import { AUTHOR_ATTR } from '../run/mock';
import { DEFAULT_SUMMARY_CRITICS } from '../../shared/types';
import type { Store } from '../store';
import type { Run } from '../../shared/types';

/**
 * The Critic dial is TWO seats, not the default five: the ceiling arithmetic is `critics + allowance`, so a
 * small dial keeps every attempt count in this file enumerable by hand (2 + 3 = 5) while the rule under test
 * stays the one the default dial runs. The default is pinned separately, as arithmetic.
 */
const CRITICS = 2;

const rigged = (): Promise<Rig> =>
    createRig({
        summaryMode: 'groups',
        summarySampling: 5,
        summaryCritics: CRITICS,
        crew: { researchQuestions: [] }
    });

const groupsOf = (store: Store, storyId: string) =>
    store.phraseGroups.list().filter((group) => group.story_id === storyId);

/** The vector of the text installed RIGHT NOW — what every deep seat key hashes. */
const vectorOf = (store: Store, storyId: string): string => groupVectorHash(groupRevisionVector(store, storyId));

/** The deep seat's claim key for one pass — built by the production builder, never by hand. */
const deepKey = (store: Store, storyId: string, pass: number): string =>
    groupCheckSeatKey(vectorOf(store, storyId), pass);

/**
 * A CLOSED run for one seat key. `state` defaults to `torn_down` because that is what a healthy pass
 * leaves; the MAJOR 3 cases pass `abandoned` (the shape `run/executor.ts` writes when the provider died)
 * with `tokens: 0` and `no_op: true` — the ledger signature of a pass that ran and brought back nothing.
 */
function seedRun(rig: Rig, key: string, state: Run['state'] = 'torn_down'): Run {
    const groupIds = groupsOf(rig.store, rig.storyId).map((group) => group.id);

    return rig.store.runs.create(
        {
            story_id: rig.storyId,
            work_item_ref: key,
            role: 'critic',
            state,
            started_at: '2026-11-25T10:00:01.000Z',
            ended_at: '2026-11-25T10:00:02.000Z',
            tokens: state === 'torn_down' ? 4 : 0,
            kind: 'work',
            // A dead pass is `no_op` — the flag `records.ts:isReportedRun` refuses to call an answer.
            no_op: state !== 'torn_down',
            delegated: [],
            group_refs: groupIds
        },
        { run_ref: null, author: true, why: `seed: a closed ${state} pass on ${key}` }
    );
}

/**
 * The terminal report of a CONCLUDED deep pass — what `tools/reader.ts:submitVerdict` writes, keyed to the
 * filing run by `run_ref` (the join `records.ts:wholeStoryVerdicts` already makes). The deep group pass
 * judges the COMPOSED Overview, so the target is the Story's Summary row.
 *
 * `fail` only changes the verdict's CONTENT, never the thing these tests are about: any filed row settles
 * the seat, because the predicate asks "did this seat's run report?", not "did the book pass?".
 */
function fileReport(rig: Rig, run: Run): void {
    rig.store.verdicts.create(
        {
            story_id: rig.storyId,
            target_ref: storySummary(rig.store, rig.storyId)?.id ?? rig.storyId,
            target_kind: 'summary',
            run_ref: run.id,
            template_ref: 'critic-deep',
            round: 1,
            criteria_passed: [{ criterion: 'C-14', result: false, evidence: 'a contradiction quoted against the Overview' }],
            hard_pass: false,
            soft_count: 0,
            recommendation: 'fix'
        },
        { run_ref: run.id, why: `seed: the deep pass's terminal report on ${run.work_item_ref}` }
    );
}

/**
 * The state every case starts from: text installed in all five sections, and the STRUCTURED family fully
 * ANSWERED (one `torn_down` seat per pass, which is also what `loop/work.ts` leg 3 requires before it will
 * arm a deep seat at all — R5's sequencing). A failing verdict keeps the phase Goal short of green, so the
 * sweep keeps dispatching instead of offering a sign-off, and the queue stays readable.
 */
async function grouped(): Promise<{ rig: Rig; vector: string }> {
    const rig = await rigged();

    installGroupRevisions(
        rig.store,
        rig.story(),
        groupsOf(rig.store, rig.storyId).map((group) => ({
            group: rig.store.phraseGroups.require(group.id),
            content: `${group.key}: the installed text.`
        })),
        AUTHOR_ATTR,
        { runRef: 'run_writer', workItemRef: `${GROUP_DRAFT_ITEM_PREFIX}_summary_0_test_1` }
    );

    const vector = vectorOf(rig.store, rig.storyId);
    const groupIds = groupsOf(rig.store, rig.storyId).map((group) => group.id);

    for (let pass = 1; pass <= CRITICS; pass += 1) {
        const run = seedRun(rig, groupReviewSeatKey(vector, pass));

        // The structured seat IS paid by its `torn_down` row (`groupReviewSeatAnswered` →
        // `records.ts:isReportedRun`), so no verdict row is needed here — and none is filed, which is the
        // STRUCTURED family's rule, not the deep one. Pinning that difference is part of the contract.
        expect(isReportedRun(run)).toBe(true);
    }

    expect(groupPipelineOwed(rig.store, rig.story()).structuredReviews).toBe(0);

    return { rig, vector };
}

/** The deep seats this sweep's queue offers, in pass order — the queue's side of the parity pair. */
function deepSeats(rig: Rig): string[] {
    return generateWork(rig.store, rig.story(), { at: '2026-11-25T10:00:00.000Z', phase: 'summary' })
        .filter((seat) => (seat.key ?? '').startsWith('wi_group_check_'))
        .map((seat) => seat.key)
        .sort();
}

/** The rail's deep numerator — the number the Author reads beside the lock button. */
const railDeep = (rig: Rig): number => phraseView(rig.store, rig.story()).review.deep_reviews_on_current_vector;

describe('a deep pass that filed nothing leaves its seat owed (MAJOR 3)', () => {
    it('re-arms a capped seat the old closed-row read had already retired, and refuses to count it', async () => {
        const { rig, vector } = await grouped();
        const seat = deepKey(rig.store, rig.storyId, 1);

        // ONE dead deep pass: `abandoned`, zero tokens, no report. This is the exact ledger a provider
        // dying mid-review leaves, and it is the row that used to pay the seat.
        const dead = seedRun(rig, seat, 'abandoned');

        // THE OLD READ, stated as a number so the repair is measurable: a CLOSED row existed, so
        // `runsForItem(key).length > 0` (the queue's old test) and `closedOn(key)` (the owed count's old
        // test) both said DONE. `isReportedRun` also says true for a `torn_down` silent row — the reading
        // that would have let the rail call a silent pass reviewed.
        expect(runsForItem(rig.store, seat)).toHaveLength(1);
        expect(runsForItem(rig.store, seat).some((run) => !isLiveRun(run))).toBe(true);
        expect(dead.state).toBe('abandoned');
        // The structured-family predicate, which is NOT the deep family's, still grades the state:
        // `abandoned` is closed but unreported, so even `isReportedRun` refuses this row.
        expect(isReportedRun(dead)).toBe(false);

        // THE NEW READ: the seat produced no report, the family has attempts left, so it is neither settled
        // nor owed-nothing.
        expect(groupCheckSeatAnswered(rig.store, rig.storyId, seat)).toBe(false);
        expect(groupCheckAttempts(rig.store, vector)).toBe(1);
        expect(groupCheckSeatSettled(rig.store, rig.storyId, vector, CRITICS, 1)).toBe(false);

        // …so all three readers still owe it, and none of them calls it reviewed.
        expect(groupPipelineOwed(rig.store, rig.story())).toEqual({ drafts: 0, structuredReviews: 0, deepReviews: CRITICS });
        expect(railDeep(rig)).toBe(0);
        expect(deepSeats(rig)).toEqual([deepKey(rig.store, rig.storyId, 1), deepKey(rig.store, rig.storyId, 2)]);
    });

    it('refuses a `torn_down` deep row that filed nothing — the state the structured seats are allowed to trust', async () => {
        const { rig, vector } = await grouped();
        const seat = deepKey(rig.store, rig.storyId, 1);

        // A Critic that ran out of TURNS still closes `torn_down` (`run/plugins/critic-termination.ts`
        // exists to catch exactly that), so this is the more dangerous shape: the state the STRUCTURED
        // family reads as an answer (`records.ts:isReportedRun`) is true here, and it is still not a report.
        const silent = seedRun(rig, seat, 'torn_down');

        expect(isReportedRun(silent)).toBe(true);
        expect(groupCheckSeatAnswered(rig.store, rig.storyId, seat)).toBe(false);
        // Which is why the deep family cannot borrow the structured predicate: it would settle this seat and
        // the rail would then count a review that was never filed.
        expect(groupCheckSeatSettled(rig.store, rig.storyId, vector, CRITICS, 1)).toBe(false);
        expect(groupPipelineOwed(rig.store, rig.story()).deepReviews).toBe(CRITICS);
        expect(railDeep(rig)).toBe(0);
        expect(deepSeats(rig)).toEqual([deepKey(rig.store, rig.storyId, 1), deepKey(rig.store, rig.storyId, 2)]);
    });

    it('retires the seat the moment the report is filed, on the same run row', async () => {
        const { rig } = await grouped();
        const seat = deepKey(rig.store, rig.storyId, 1);

        // The SAME ledger as above — one closed row — plus the row that pass should have written. Nothing
        // about the RUN changes; the report is the whole difference, which is what "the gate is the report"
        // has to mean for a restart too.
        const dead = seedRun(rig, seat, 'abandoned');

        expect(groupCheckSeatAnswered(rig.store, rig.storyId, seat)).toBe(false);

        fileReport(rig, dead);

        expect(groupCheckSeatAnswered(rig.store, rig.storyId, seat)).toBe(true);
        expect(groupCheckSeatSettled(rig.store, rig.storyId, vectorOf(rig.store, rig.storyId), CRITICS, 1)).toBe(true);
        expect(groupPipelineOwed(rig.store, rig.story()).deepReviews).toBe(CRITICS - 1);
        expect(railDeep(rig)).toBe(1);
        expect(deepSeats(rig)).toEqual([deepKey(rig.store, rig.storyId, 2)]);
    });

    it('does not count a report filed by ANOTHER seat, and does not need a child run for a delegation', async () => {
        const { rig } = await grouped();
        const first = deepKey(rig.store, rig.storyId, 1);
        const second = deepKey(rig.store, rig.storyId, 2);

        const run = seedRun(rig, first);

        fileReport(rig, run);

        // A report belongs to the seat its run claimed: seat 2 has no rows at all, so it is owed even
        // though the book holds a filed deep verdict. Attribution is `run_ref`, not "the story has verdicts".
        expect(groupCheckSeatAnswered(rig.store, rig.storyId, second)).toBe(false);
        expect(groupPipelineOwed(rig.store, rig.story()).deepReviews).toBe(CRITICS - 1);

        // Delegation writes under the PARENT run (`run/executor.ts:delegate` records the child in
        // `runs.delegated` and creates no child `runs` row), so the verdict join survives a delegated pass:
        // a second verdict from the same run_ref lands on the same seat, once.
        fileReport(rig, run);

        expect(groupCheckSeatAnswered(rig.store, rig.storyId, first)).toBe(true);
        expect(groupPipelineOwed(rig.store, rig.story()).deepReviews).toBe(CRITICS - 1);
        expect(railDeep(rig)).toBe(1);
    });
});

describe('a silent deep family parks at the ceiling instead of buying a pass every sweep (MAJOR 3)', () => {
    it('counts the ceiling as critics + SAMPLING_RETRY_ALLOWANCE, on this dial and the default one', () => {
        expect(SAMPLING_RETRY_ALLOWANCE).toBe(3);
        // The expression, not a number invented here: it is `groupReviewAttemptCap`'s and
        // `records.ts:screeningCapOf`'s, so one grace is spent the same way in every family.
        expect(groupCheckAttemptCap(CRITICS)).toBe(CRITICS + SAMPLING_RETRY_ALLOWANCE);
        expect(groupCheckAttemptCap(CRITICS)).toBe(5);
        // The Author's default dial: 5 owed passes + 3 retries. The ceiling is what keeps the expensive
        // family bounded — 8 passes at the measured 6-17 min each, rather than one per sweep forever.
        expect(DEFAULT_SUMMARY_CRITICS).toBe(5);
        expect(groupCheckAttemptCap(DEFAULT_SUMMARY_CRITICS)).toBe(8);
        expect(groupCheckAttemptCap(DEFAULT_SUMMARY_CRITICS)).toBe(
            DEFAULT_SUMMARY_CRITICS + SAMPLING_RETRY_ALLOWANCE
        );
    });

    it('keeps re-arming while attempts remain, and stops the sweep at the cap', async () => {
        const { rig, vector } = await grouped();
        const first = deepKey(rig.store, rig.storyId, 1);
        const second = deepKey(rig.store, rig.storyId, 2);

        // FOUR silent attempts (two per seat), still under the cap of 5 — the retry is real work, and the
        // queue must keep offering it rather than stranding the vector on the first dead pass.
        seedRun(rig, first, 'abandoned');
        seedRun(rig, first, 'abandoned');
        seedRun(rig, second, 'abandoned');
        seedRun(rig, second, 'abandoned');

        expect(groupCheckAttempts(rig.store, vector)).toBe(4);
        expect(groupCheckSeatSettled(rig.store, rig.storyId, vector, CRITICS, 1)).toBe(false);
        expect(groupPipelineOwed(rig.store, rig.story())).toEqual({ drafts: 0, structuredReviews: 0, deepReviews: CRITICS });
        expect(deepSeats(rig)).toEqual([first, second]);
        // One candidate PER SEAT per sweep — the ceiling is a family budget, but the fan-out is still the
        // dial, so a retry can never widen `types.ts:DEFAULT_GLOBAL_MAX_CONCURRENT`'s budget.
        expect(deepSeats(rig)).toHaveLength(CRITICS);

        // THE FIFTH closed pass spends the last attempt.
        seedRun(rig, first, 'abandoned');

        expect(groupCheckAttempts(rig.store, vector)).toBe(groupCheckAttemptCap(CRITICS));
        // Exhaustion SETTLES both seats — the clause that keeps the drain and the sign-off off a provider
        // the loop cannot reach.
        expect(groupCheckSeatSettled(rig.store, rig.storyId, vector, CRITICS, 1)).toBe(true);
        expect(groupCheckSeatSettled(rig.store, rig.storyId, vector, CRITICS, 2)).toBe(true);
        expect(groupPipelineOwed(rig.store, rig.story())).toEqual({ drafts: 0, structuredReviews: 0, deepReviews: 0 });
        // The queue has nothing left to buy, and a second look at the same rows says the same — the family
        // stays parked instead of drifting one pass per sweep.
        expect(deepSeats(rig)).toEqual([]);
        expect(deepSeats(rig)).toEqual([]);
        // The rail does NOT call the parked seats reviewed: parking stops the buying, it never invents a
        // review the Author never got.
        expect(railDeep(rig)).toBe(0);
    });

    it('parks a real sweep: one more step buys no further deep pass', async () => {
        const { rig, vector } = await grouped();
        const first = deepKey(rig.store, rig.storyId, 1);
        const second = deepKey(rig.store, rig.storyId, 2);

        for (let attempt = 0; attempt < groupCheckAttemptCap(CRITICS); attempt += 1)
            seedRun(rig, attempt % 2 === 0 ? first : second, 'abandoned');

        const before = groupCheckAttempts(rig.store, vector);

        await rig.step();

        // A sweep through the engine — not just a candidate list: the deep family's closed-pass count is
        // unchanged, so the loop spent no further 6-17 minute pass on a vector it has already given up on.
        expect(groupCheckAttempts(rig.store, vector)).toBe(before);
        expect(groupCheckAttempts(rig.store, vector)).toBe(groupCheckAttemptCap(CRITICS));
    });
});

describe('the gate and the rail answer for one seat set (MAJOR 3)', () => {
    it('moves both readings with one verdict row, on one ledger', async () => {
        const { rig } = await grouped();
        const first = deepKey(rig.store, rig.storyId, 1);
        const second = deepKey(rig.store, rig.storyId, 2);

        // Seat 1 concluded; seat 2 ran and was capped. THE PAIR THIS DEFECT BROKE: the gate read two closed
        // rows and owed nothing, while the rail counted one review. Both readings come from the rows below,
        // in one fixture, at one moment.
        const answered = seedRun(rig, first);

        fileReport(rig, answered);
        seedRun(rig, second, 'abandoned');

        expect(groupPipelineOwed(rig.store, rig.story()).deepReviews).toBe(1);
        expect(railDeep(rig)).toBe(1);
        // The queue names exactly the seat both other readers say is owed — one key, not "some work".
        expect(deepSeats(rig)).toEqual([second]);

        // The structured family's numbers are untouched by any of this: same dial, same answered seats.
        const view = phraseView(rig.store, rig.story()).review;

        expect([view.review_seats, view.reviews_on_current_vector]).toEqual([CRITICS, CRITICS]);
        expect(view.vector_hash).toBe(vectorOf(rig.store, rig.storyId));

        // Seat 2's report lands. The gate and the rail cross to the same side together: nothing owed,
        // both seats counted, and the queue empty of deep work.
        const secondRuns = runsForItem(rig.store, second);

        fileReport(rig, secondRuns[secondRuns.length - 1]);

        expect(groupPipelineOwed(rig.store, rig.story()).deepReviews).toBe(0);
        expect(railDeep(rig)).toBe(2);
        expect(deepSeats(rig)).toEqual([]);
        // The invariant the defect violated, in the one state where it can be stated without a caveat:
        // seats the gate has stopped owing are seats the rail counts, until the ceiling takes over.
        expect(railDeep(rig)).toBe(CRITICS - groupPipelineOwed(rig.store, rig.story()).deepReviews);
    });

    it('never shows the rail ahead of the gate, and never lets the gate settle a reported seat away', async () => {
        const { rig } = await grouped();
        const first = deepKey(rig.store, rig.storyId, 1);

        // A report FILED while the family is still under the cap: the seat is settled BY THE REPORT, so the
        // ceiling has nothing to do with it and the rail counts it. This is the pairing the ceiling clause
        // must not blur.
        const run = seedRun(rig, first);

        fileReport(rig, run);

        expect(groupCheckAttempts(rig.store, vectorOf(rig.store, rig.storyId))).toBe(1);
        expect(groupCheckSeatSettled(rig.store, rig.storyId, vectorOf(rig.store, rig.storyId), CRITICS, 1)).toBe(true);
        expect(railDeep(rig)).toBe(1);

        // A retry under the cap can only ADD an attempt, never double-count the seat: the rail counts seats,
        // not rows, so a re-armed seat that answers on its second try still reads 1.
        const retry = seedRun(rig, first, 'abandoned');

        fileReport(rig, retry);

        expect(groupCheckAttempts(rig.store, vectorOf(rig.store, rig.storyId))).toBe(2);
        expect(railDeep(rig)).toBe(1);
        expect(groupPipelineOwed(rig.store, rig.story()).deepReviews).toBe(CRITICS - 1);
    });

    it('is scoped to one Story: another book cannot borrow this one\u2019s reports', async () => {
        const { rig } = await grouped();
        const first = deepKey(rig.store, rig.storyId, 1);

        fileReport(rig, seedRun(rig, first));

        // Same seat keys are minted from the vector hash, so a cross-book collision would be invisible in
        // the count unless the predicate is Story-scoped (the projection that reads it is Story-scoped).
        const other = await rigged();
        const otherVector = vectorOf(other.store, other.storyId);

        expect(otherVector).not.toBe(vectorOf(rig.store, rig.storyId));
        expect(groupCheckSeatAnswered(other.store, other.storyId, groupCheckSeatKey(otherVector, 1))).toBe(false);
        expect(railDeep(other)).toBe(0);
        expect(railDeep(rig)).toBe(1);
    });
});

describe('the dial the seats key on', () => {
    it('keeps the Story\u2019s Critic dial as the seat count, and re-arms on an install', async () => {
        const { rig, vector } = await grouped();

        expect(screeningSizeOf(rig.story())).toBe(CRITICS);

        const first = deepKey(rig.store, rig.storyId, 1);

        fileReport(rig, seedRun(rig, first));

        expect(groupPipelineOwed(rig.store, rig.story()).deepReviews).toBe(CRITICS - 1);

        // AN INSTALL moves the vector, and a new vector owes its own seats: the seat's identity is the
        // `(vector, pass)` pair, so a report for the old text never pays for the new one — no clock, and no
        // counters to reset (the rows the vector hash names are the whole state).
        installGroupRevisions(
            rig.store,
            rig.story(),
            groupsOf(rig.store, rig.storyId).map((group) => ({
                group: rig.store.phraseGroups.require(group.id),
                content: `${group.key}: the SECOND text.`
            })),
            AUTHOR_ATTR,
            { runRef: 'run_writer', workItemRef: `${GROUP_DRAFT_ITEM_PREFIX}_summary_0_test_2` }
        );

        const next = vectorOf(rig.store, rig.storyId);

        expect(next).not.toBe(vector);
        expect(groupCheckSeatAnswered(rig.store, rig.storyId, groupCheckSeatKey(next, 1))).toBe(false);
        expect(groupCheckAttempts(rig.store, next)).toBe(0);
        // The structured family re-arms too (R5's sequencing), so the owed object reports the structured
        // seats first and the deep count as 0 — the deep seats are only owed once the structured ones answer.
        expect(groupPipelineOwed(rig.store, rig.story())).toEqual({ drafts: 0, structuredReviews: CRITICS, deepReviews: 0 });
        expect(railDeep(rig)).toBe(0);
    });
});
