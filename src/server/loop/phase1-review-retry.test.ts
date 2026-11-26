/**
 * W5 — a structured review seat that produced NOTHING is tried again, up to a stated ceiling.
 *
 * THE DEFECT, from the Author's report ("Critics take a long time to file their issues") and the Bird
 * Brain store dump (`Temp/general/store.copy.json`, monorepo root). That book has 16 `wi_review_groups_*`
 * run rows; 3 of them are
 *
 *   abandoned  tokens: 0  no_op: true
 *   end_reason: "abandoned — its provider request outlived the request-liveness ceiling (S-4a)"
 *
 * i.e. killed at `run/executor.ts:STRUCTURED_REQUEST_MAX_MS` = 600_000ms — half an hour of wall clock
 * per pass, and the store holds exactly 13 `sample_reviews` rows for those 16 seats, so each of the
 * three dead passes wrote NOTHING (`loop/engine.ts:1756` persists the review behind `groupReview.ok`).
 * The vector those seats keyed on (`d9a92b3a8e5b958b`) still ran its five tool-carrying deep passes at
 * 07:29+, on the strength of run rows three of which had reported nothing.
 *
 * WHY IT WAS PERMANENT: both review legs of the generator gated on
 * `if (runsForItem(store, key).length > 0) continue` (`loop/work.ts` leg 2 / leg 3), and the predicate
 * `allReviewSeatsReported` replaced (with `groupPipelineOwed`'s `closedOn`) read the same "a row exists"
 * fact. A row is not
 * a result, so an `abandoned` or `failed` seat paid itself: the 5 Critic reads the Author's dial asked
 * for (`DEFAULT_SUMMARY_CRITICS`, `shared/types.ts:284`) silently became 2, until a Writer happened to
 * move the group vector.
 *
 * THE FIX THIS FILE PINS (`phrase/exclusion.ts:groupReviewSeatSettled` and its three reads):
 *   * a seat is DONE when it ANSWERED — `records.ts:isReportedRun`, the one closed state
 *     (`torn_down`) whose structured answer reached the settle and wrote a review row — or when its
 *     vector's seat family SPENT its attempt cap (the degrade path `records.ts:isFullyScreened` uses
 *     for screens, so a permanently broken provider parks the vector instead of buying a Critic per
 *     sweep or stranding the drain forever);
 *   * the ceiling is `groupReviewAttemptCap(critics) = critics + SAMPLING_RETRY_ALLOWANCE`, the same
 *     expression `records.ts:screeningCapOf` uses for a draft's screening family — not a new number;
 *   * the seat KEY is unchanged (`wi_review_groups_<vectorHash>_<pass>`), so a retry is a second RUN ROW
 *     under the same key: one candidate per seat per sweep, never a minted duplicate.
 *
 * Determinism: every expected value below is a literal derived from the rig's own dial
 * (`summaryCritics: 2` → 2 seats, cap 2 + 3 = 5) and the doctrine constants, not read back off the
 * implementation. Runs are seeded as rows (`store.runs.create`), with the `tokens`/`no_op`/`end_reason`
 * of the measured rows, so each stage is one state and no provider is involved.
 */
import { describe, expect, it } from 'vitest';

import { createRig, type Rig } from './mock';
import { generateWork } from './work';
import { isReportedRun, runsForItem, SAMPLING_RETRY_ALLOWANCE, screeningCapOf, screeningSizeOf } from './records';
import {
    allReviewSeatsReported,
    GROUP_DRAFT_ITEM_PREFIX,
    GROUP_REVIEW_ITEM_PREFIX,
    groupCheckSeatKey,
    groupPipelineOwed,
    groupReviewAttemptCap,
    groupReviewAttempts,
    groupReviewSeatAnswered,
    groupReviewSeatFamily,
    groupReviewSeatKey,
    groupReviewSeatSettled
} from '../phrase/exclusion';
import { groupRevisionVector, groupVectorHash, installGroupRevisions } from '../phrase/revisions';
import { AUTHOR_ATTR } from '../run/mock';
import { DEFAULT_SUMMARY_CRITICS, type PhraseGroup, type Run, type RunState } from '../../shared/types';
import { ISSUE_HOLDING_STATES } from './types';

/** The rig's dial: two seats, so every count below is a small literal. */
const CRITICS = 2;

/** The cap this book's review family is allowed to spend: the owed passes plus the loop's one allowance. */
const CAP = CRITICS + SAMPLING_RETRY_ALLOWANCE;

/** The sentence a real killed pass wrote on its row (the same text `run/executor.ts:ABORT_TEXT.deadline` emits). */
const DEAD = 'abandoned — its provider request outlived the request-liveness ceiling (S-4a)';

const groupsOf = (rig: Rig): PhraseGroup[] =>
    rig.store.phraseGroups.list().filter((group) => group.story_id === rig.storyId);

/** The vector the current text's seats key on — the same read the generator and the drain use. */
const vectorHashOf = (rig: Rig): string => groupVectorHash(groupRevisionVector(rig.store, rig.storyId));

/** One group book: the catalog exists, the Overview is installed, and NOTHING has run yet. */
async function rigged(): Promise<Rig> {
    const rig = await createRig({
        summaryMode: 'groups',
        summarySampling: 5,
        summaryCritics: CRITICS,
        // D-51 waiver: the Seed Brief asks no research, so no sampler job competes with the seats.
        crew: { researchQuestions: [] }
    });

    installAll(rig);

    // The determinism pin: the ledger starts EMPTY, so every attempt counted below is one this test wrote.
    expect(rig.store.runs.list()).toEqual([]);

    return rig;
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

/** The keys one sweep would dispatch for the structured review seats, in `pass` order. */
function reviewSeats(rig: Rig): string[] {
    return generateWork(rig.store, rig.story(), { at: '2026-11-24T10:00:03.000Z', phase: 'summary' })
        .filter((candidate) => candidate.item.kind === 'review_groups')
        .map((candidate) => candidate.key);
}

/** The keys one sweep would dispatch for the deep cross-group pass (the leg the review gate opens). */
function deepSeats(rig: Rig): string[] {
    return generateWork(rig.store, rig.story(), { at: '2026-11-24T10:00:03.000Z', phase: 'summary' })
        .filter((candidate) => candidate.item.kind === 'check_unit')
        .map((candidate) => candidate.key);
}

/**
 * One closed review-pass row — `state` decides whether the seat it closes brought an answer.
 *
 * The `tokens`/`no_op`/`end_reason` mirror the measured rows: an answered pass reports and carries its
 * usage, a killed one reports nothing and spends no token. A live row has no `ended_at`.
 */
function seedRun(rig: Rig, key: string, state: RunState): void {
    // `torn_down` is the state `records.ts:isReportedRun` calls an answer (pinned directly in the last
    // block); every other state in `RUN_STATES` writes a row with nothing on the record.
    const reported = state === 'torn_down';
    const closed = state === 'torn_down' || state === 'failed' || state === 'abandoned';

    rig.store.runs.create(
        {
            story_id: rig.storyId,
            work_item_ref: key,
            role: 'critic',
            state,
            started_at: '2026-11-24T10:00:00.000Z',
            ended_at: closed ? '2026-11-24T10:30:01.000Z' : null,
            tokens: reported ? 11_958 : 0,
            kind: 'work',
            no_op: !reported,
            delegated: [],
            ...(state === 'abandoned' ? { end_reason: DEAD } : {}),
            // Every group, because a structured seat judges the installed Overview as a whole (R3).
            group_refs: groupsOf(rig).map((group) => group.id)
        },
        { run_ref: null, author: true, why: `seed: a ${state} structured review pass on ${key}` }
    );
}

describe('a resultless structured review seat is armed again (W5/F1)', () => {
    it('re-arms the SAME seat key after an abandoned pass, and stops once a pass answers', async () => {
        const rig = await rigged();
        const hash = vectorHashOf(rig);
        const seat1 = groupReviewSeatKey(hash, 1);
        const seat2 = groupReviewSeatKey(hash, 2);

        // Both seats open on the installed vector, before anything has run.
        expect(reviewSeats(rig)).toEqual([seat1, seat2]);

        // THE MEASURED STATE: pass 1 died at the request-liveness ceiling — closed row, `tokens: 0`, and
        // (asserted below) no review row, because `engine.ts:1756` writes one only behind `groupReview.ok`.
        seedRun(rig, seat1, 'abandoned');

        // THE PREDICATE THAT CHANGED, stated as a fact about this state: a run row EXISTS, which is all
        // the old gate (`runsForItem(store, key).length > 0`) required, so before W5 this seat was paid
        // and never bought again. The new gate reads the ANSWER, so the sweep dispatches it a second time.
        expect(runsForItem(rig.store, seat1).length).toBe(1);
        expect(groupReviewSeatAnswered(rig.store, hash, 1)).toBe(false);
        expect(reviewSeats(rig)).toEqual([seat1, seat2]);

        // The same for a provider fault (`failed`) — also no persisted review, also re-armed.
        seedRun(rig, seat1, 'failed');

        expect(groupReviewAttempts(rig.store, hash)).toBe(2);
        expect(reviewSeats(rig)).toEqual([seat1, seat2]);

        // And it stops the moment an answer lands: the answered seat is never re-bought, so a retry costs
        // the book one review, not an argument about how many reviews a vector may have.
        seedRun(rig, seat1, 'torn_down');

        expect(groupReviewSeatAnswered(rig.store, hash, 1)).toBe(true);
        expect(groupReviewSeatSettled(rig.store, hash, CRITICS, 1)).toBe(true);
        expect(reviewSeats(rig)).toEqual([seat2]);
    });
});

describe('the retry is bounded by the family cap (W5/F2)', () => {
    it('re-arms while attempts remain, then parks the vector and opens the deep pass', async () => {
        const rig = await rigged();
        const hash = vectorHashOf(rig);
        const seat1 = groupReviewSeatKey(hash, 1);
        const seat2 = groupReviewSeatKey(hash, 2);

        // The ceiling, as arithmetic — one pass per seat plus the loop's universal retry allowance
        // (`SAMPLING_RETRY_ALLOWANCE`, the same addend `records.ts:screeningCapOf` uses).
        expect(groupReviewAttemptCap(CRITICS)).toBe(CAP);
        expect(groupReviewAttemptCap(DEFAULT_SUMMARY_CRITICS)).toBe(DEFAULT_SUMMARY_CRITICS + 3);

        // Three dead passes on seat 1, one on seat 2: four attempts, still inside a cap of five.
        seedRun(rig, seat1, 'abandoned');
        seedRun(rig, seat1, 'abandoned');
        seedRun(rig, seat1, 'abandoned');
        seedRun(rig, seat2, 'failed');

        expect(groupReviewAttempts(rig.store, hash)).toBe(CAP - 1);
        expect(reviewSeats(rig)).toEqual([seat1, seat2]);

        // THE CEILING. One more dead pass spends the family budget, and both seats become settled-by-
        // exhaustion: the loop stops re-arming rather than buying a Critic every sweep forever.
        seedRun(rig, seat2, 'abandoned');

        expect(groupReviewAttempts(rig.store, hash)).toBe(CAP);
        expect(groupReviewSeatSettled(rig.store, hash, CRITICS, 1)).toBe(true);
        expect(groupReviewSeatSettled(rig.store, hash, CRITICS, 2)).toBe(true);
        expect(allReviewSeatsReported(rig.store, hash, CRITICS)).toBe(true);
        // Twice, because "stops re-arming" is a claim about repeated sweeps, not one.
        expect(reviewSeats(rig)).toEqual([]);
        expect(reviewSeats(rig)).toEqual([]);

        // Exhaustion DEGRADES rather than deadlocks: the vector is no longer owed a structured read, so
        // the drain is clear of it and the tool-carrying deep pass arms on the five-group Overview.
        expect(groupPipelineOwed(rig.store, rig.story())).toEqual({
            drafts: 0,
            structuredReviews: 0,
            deepReviews: CRITICS
        });
        expect(deepSeats(rig)).toEqual([groupCheckSeatKey(hash, 1), groupCheckSeatKey(hash, 2)]);
    });

    it('holds the drain and the deep pass while a dead seat still has attempts (parity)', async () => {
        const rig = await rigged();
        const hash = vectorHashOf(rig);
        const seat1 = groupReviewSeatKey(hash, 1);

        seedRun(rig, seat1, 'abandoned');

        // THE DRIFT PIN, W5's shape: the seat the GENERATOR re-arms is the seat the DRAIN counts owed,
        // one key read by both. A dead seat with attempts left holds the drain and keeps the deep pass
        // shut — which is the sequencing the old gate could not guarantee, and why the measured vector
        // reached five deep passes on two answers.
        expect(reviewSeats(rig)).toEqual([seat1, groupReviewSeatKey(hash, 2)]);
        expect(groupPipelineOwed(rig.store, rig.story())).toEqual({
            drafts: 0,
            structuredReviews: CRITICS,
            deepReviews: 0
        });
        expect(deepSeats(rig)).toEqual([]);
        expect(allReviewSeatsReported(rig.store, hash, CRITICS)).toBe(false);
    });
});

describe('one seat is never armed twice in one sweep (W5/F3)', () => {
    it('dispatches each resultless seat exactly once, under its stable key', async () => {
        const rig = await rigged();
        const hash = vectorHashOf(rig);
        const seat1 = groupReviewSeatKey(hash, 1);
        const seat2 = groupReviewSeatKey(hash, 2);

        seedRun(rig, seat1, 'abandoned');
        seedRun(rig, seat2, 'abandoned');

        // Two dead seats, two candidates — and the keys are the ORIGINAL `(vector, pass)` pair, with no
        // attempt segment minted beside them, so a retry cannot fan out into a second concurrent seat.
        expect(reviewSeats(rig)).toEqual([seat1, seat2]);
        expect(reviewSeats(rig).filter((key) => key === seat1)).toHaveLength(1);
        expect(reviewSeats(rig).filter((key) => key === seat2)).toHaveLength(1);

        // The in-flight seat is not re-minted either: `candidate()`'s own claim check (`isClaimed`) drops
        // a key a live run holds, so the same seat has at most one run at a time — while its sibling,
        // which is not claimed, still goes out.
        seedRun(rig, seat2, 'reporting');

        expect(reviewSeats(rig)).toEqual([seat1]);
        expect(groupReviewAttempts(rig.store, hash)).toBe(2); // the live row is not an attempt
    });
});

describe('the doctrine dials and the seat key are untouched by W5 (F4)', () => {
    it('keeps the review-seat spelling, the constants and the screening cap exactly as they were', async () => {
        const rig = await rigged();

        // The key shape three readers outside this package parse or count (`api/projections.ts:1945`,
        // `GROUP_PIPELINE_RUN_PREFIXES`, the dashboard's seat view) is byte-identical to the pre-W5 literal.
        expect(GROUP_REVIEW_ITEM_PREFIX).toBe('wi_review_groups');
        expect(groupReviewSeatKey('590ac70fe3cccdb3', 1)).toBe('wi_review_groups_590ac70fe3cccdb3_1');
        expect(groupReviewSeatFamily('590ac70fe3cccdb3')).toBe('wi_review_groups_590ac70fe3cccdb3_');

        // The retry allowance and the Author's review dial: unchanged doctrine, asserted from the outside.
        expect(SAMPLING_RETRY_ALLOWANCE).toBe(3);
        expect(DEFAULT_SUMMARY_CRITICS).toBe(5);
        expect(ISSUE_HOLDING_STATES).toEqual(['unconfirmed', 'confirmed', 'approved']);

        // `screeningCapOf` keeps its own definition — W5 borrowed the EXPRESSION for the review family
        // and changed nothing about the screening one: this rig's draft screens are owed 2 passes.
        expect(screeningSizeOf(rig.story())).toBe(CRITICS);
        expect(screeningCapOf(rig.story())).toBe(CRITICS + SAMPLING_RETRY_ALLOWANCE);

        // `isReportedRun` — the predicate the whole fix rests on — over all six `RUN_STATES`: only the
        // state the executor writes from its success branch counts as an answer.
        expect(
            (['spawning', 'working', 'reporting', 'torn_down', 'failed', 'abandoned'] as const).map(
                (state): [RunState, boolean] => [state, isReportedRun({ state } as Run)]
            )
        ).toEqual([
            ['spawning', false],
            ['working', false],
            ['reporting', false],
            ['torn_down', true],
            ['failed', false],
            ['abandoned', false]
        ]);
    });
});
