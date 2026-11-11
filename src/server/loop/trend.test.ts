/**
 * Acceptance for loop detection — §12 row W7 and decisions L-15, L-15a, L-16, L-16a, L-21, L-22, L-23,
 * L-37a.
 *
 * Two halves, because the row asks for two different things:
 *   * the integration stall (L-21/L-22): a Story whose rounds keep coming back with a NEW objection, so
 *     no level ever moves, has to stop and page the Author with a reason that says WHICH limit tripped,
 *     WHICH finding has been open longest, and WHAT the crews already tried;
 *   * the trend rules themselves (L-15/L-16a), which are pure functions over the Story's own ledger and
 *     are pinned directly: closing a fingerprint is progress even with an unchanged ladder, and a
 *     fingerprint that was never closed cannot "reopen" — the false regression L-16a exists to prevent.
 */
import { describe, expect, it } from 'vitest';

import { measureRound, recordRound } from './trend';
import { oldestConfirmedFinding } from './records';
import { createRig, walkToChapters, type Rig } from './mock';

/** The ladder shape `trend.ts` reads: `<passed>/<total>` per level (G-2's rendered rungs). */
const LADDER = { 'per chapter': '2/2', 'whole book': '3/4' };
const OTHER_LADDER = { 'per chapter': '2/2', 'whole book': '4/4' };

describe('L-21 / L-22 — the stall that pages the Author, and the reason it has to give', () => {
    /**
     * Every probe round files a NEW objection (a different criterion each round), so D-16's dedupe never
     * merges them, no round is clean, and the ladder never moves. `flat_rounds: 2` is the Goal saying how
     * many of those rounds it is willing to watch before it asks.
     */
    async function stalling() {
        const rig = await createRig({
            story: { chapter_count: 2 },
            goal: { flat_rounds: 2 },
            crew: {
                probeFinds: (round: number) => ({
                    cost: 'major',
                    criterion: ['C-11', 'C-10', 'C-13'][round % 3],
                    title: 'the mentor scene is out of order'
                })
            }
        });

        await walkToChapters(rig, 2);

        return rig;
    }

    it('stops with `stalled`, naming the limit, the oldest confirmed finding, and the attempts', async () => {
        const rig = await stalling();

        let stalled = false;

        for (let index = 0; index < 24 && !stalled; index += 1) {
            await rig.step();

            stalled = rig.story().pending_kind === 'stalled';
        }

        const story = rig.story();

        expect({
            status: story.status,
            pending_kind: story.pending_kind,
            trend: story.trend,
            flat_streak: story.flat_streak,
            blocked_on: story.blocked_on
        }).toEqual({
            status: 'pending',
            pending_kind: 'stalled',
            trend: 'flat',
            // The Goal's own limit, read back off the Story row — this is the number the reason quotes.
            flat_streak: 2,
            blocked_on: "flat past the Goal's loop-detection limits"
        });

        // L-22's three sentences, in the order the Author reads them: what stopped moving, the oldest
        // thing still open, and what the crews already spent trying to move it.
        expect(story.status_reason).toBe(
            'every level unchanged for 2 of the 2 rounds that trip loop detection — no level will move · oldest confirmed finding C-10|story_1 (seen 1×, on story_1) · the crews tried 0 task attempts across 22 runs'
        );
    });

    it('the finding the sentence names is the one the store says is oldest and confirmed (L-22)', async () => {
        const rig = await stalling();

        let stalled = false;

        for (let index = 0; index < 24 && !stalled; index += 1) {
            await rig.step();

            stalled = rig.story().pending_kind === 'stalled';
        }

        const oldest = oldestConfirmedFinding(rig.store, rig.storyId);

        // The stall sentence is generated from the records rather than from anything the engine
        // remembered, so a restarted engine would page the Author with the same finding.
        expect({ criterion: `${oldest?.criterion_ref}|${oldest?.target_ref}`, seen: oldest?.seen_count }).toEqual({
            criterion: 'C-10|story_1',
            seen: 1
        });
        expect(rig.story().status_reason).toContain(`oldest confirmed finding C-10|story_1 (seen 1×, on story_1)`);
    });

    it('the exits are not sticky: changing the Goal re-arms the loop (L-23)', async () => {
        const rig = await stalling();

        for (let index = 0; index < 24 && rig.story().pending_kind !== 'stalled'; index += 1) await rig.step();

        expect(rig.story().pending_kind).toBe('stalled');

        // L-23's first exit: the Goal itself. `flat_rounds: 9` lifts the limit that tripped, and because
        // the stall is re-derived from the records on every sweep, the Story is work again without a
        // "resume" verb existing anywhere.
        await rig.engine.setGoal(rig.storyId, { flat_rounds: 9 });

        const report = await rig.step();

        expect({
            status: rig.story().status,
            pending_kind: rig.story().pending_kind,
            blocked_on: rig.story().blocked_on
        }).toEqual({
            status: 'ready',
            pending_kind: 'none',
            blocked_on: ''
        });
        expect(report.stories[0].started.length).toBeGreaterThan(0);
    });

    it('a Story that has run out of problems is drained, not stalled (L-37a, W7)', async () => {
        // The same walk with nothing to complain about: `flat_rounds: 1` is the tightest possible loop
        // detector, and the clean book still reaches `drained` rather than `stalled` — L-37a says a Story
        // out of WORK is finished, not stuck.
        const rig = await createRig({ story: { chapter_count: 2 }, goal: { flat_rounds: 1 } });

        await walkToChapters(rig, 2);
        await rig.run();

        // A book that never had a bad round never earns a trend: no round is measured on the way to a
        // clean drain, so `unknown` is the honest value. That is the difference L-37a draws — `stalled`
        // is a verdict about rounds, `drained` is a verdict about work, and only the second one applies
        // here.
        expect({
            pending_kind: rig.story().pending_kind,
            trend: rig.story().trend,
            blocked_on: rig.story().blocked_on
        }).toEqual({
            pending_kind: 'drained',
            trend: 'unknown',
            // The only thing left on a clean book is the Author's answer about completion.
            blocked_on: 'the Author: work the leftovers or accept completion'
        });
    });
});

describe('L-15 / L-16a — the ledger rules, pinned at the function the sweep calls', () => {
    /** A Story whose rounds are recorded by hand, so each rule is isolated from the crew. */
    async function ledger() {
        const rig = await walkToChapters(await createRig({ story: { chapter_count: 1 } }), 1);

        return rig;
    }

    /** One measured round, written the way the sweep writes it. */
    function round(rig: Rig, levels: Record<string, string>, closed: string[], open: string[], at: string) {
        const story = rig.story();
        const delta = measureRound(story, levels, closed, open);

        recordRound(rig.store, story, {
            levels,
            closedFingerprints: closed,
            phase: story.phase,
            at,
            delta,
            closedRunCount: 1
        });

        return delta;
    }

    it('an unchanged ladder is flat, and the streak counts the rounds that were measured', async () => {
        const rig = await ledger();

        expect(round(rig, LADDER, [], [], '2026-01-01T00:00:00.000Z').trend).toBe('unknown');
        expect(round(rig, LADDER, [], [], '2026-01-01T00:01:00.000Z')).toMatchObject({
            trend: 'flat',
            flat_streak: 1,
            levelDelta: 0,
            reopened: []
        });
        expect(round(rig, LADDER, [], [], '2026-01-01T00:02:00.000Z')).toMatchObject({ trend: 'flat', flat_streak: 2 });
        expect(rig.story().flat_streak).toBe(2);
    });

    it('closing a fingerprint is progress even when no level moved (L-15a)', async () => {
        const rig = await ledger();

        round(rig, LADDER, [], [], '2026-01-01T00:00:00.000Z');

        // The ladder is the same as last round; the only difference is that a defect reached `fixed`.
        // A loop that reads only the ladder would call this flat and start counting toward a stall.
        const delta = round(rig, LADDER, ['fp-map-contradicts-survey'], [], '2026-01-01T00:01:00.000Z');

        expect(delta).toMatchObject({ trend: 'improving', flat_streak: 0 });
        expect(delta.closed).toEqual(['fp-map-contradicts-survey']);

        // The durable ledger is what "was closed before" is read from, because `level_history` is bounded.
        expect(rig.story().closed_fingerprints).toEqual(['fp-map-contradicts-survey']);
    });

    it('a closed fingerprint seen again is a regression, and one never closed is not (L-16a)', async () => {
        const rig = await ledger();

        round(rig, LADDER, [], [], '2026-01-01T00:00:00.000Z');
        round(rig, LADDER, ['fp-map-contradicts-survey'], [], '2026-01-01T00:01:00.000Z');

        // The same objection is confirmed open again after the fix: the fingerprint is in the ledger, so
        // this reads as the defect coming back, which is the ONLY way a fingerprint regression is allowed
        // to be claimed.
        const reopened = round(
            rig,
            LADDER,
            ['fp-map-contradicts-survey'],
            ['fp-map-contradicts-survey'],
            '2026-01-01T00:02:00.000Z'
        );

        expect(reopened.trend).toBe('regressing');
        expect(reopened.reopened).toEqual(['fp-map-contradicts-survey']);

        // The false positive L-16a prevents: a brand new defect on a ladder that did not move is a new
        // finding, not a regression.
        const fresh = round(
            rig,
            LADDER,
            ['fp-map-contradicts-survey'],
            ['fp-something-new'],
            '2026-01-01T00:03:00.000Z'
        );

        expect(fresh.reopened).toEqual([]);
        expect(fresh.trend).not.toBe('regressing');
    });

    it('a level falling is a regression, and a level rising is not (L-16)', async () => {
        const rig = await ledger();

        round(rig, LADDER, [], [], '2026-01-01T00:00:00.000Z');

        expect(round(rig, OTHER_LADDER, [], [], '2026-01-01T00:01:00.000Z')).toMatchObject({
            trend: 'improving',
            levelDelta: 0
        });

        const fell = round(rig, { 'per chapter': '1/2', 'whole book': '4/4' }, [], [], '2026-01-01T00:02:00.000Z');

        // The fall is counted in level POINTS, which is what `regress_tolerance` is compared against.
        expect(fell.trend).toBe('regressing');
        expect(fell.levelDelta).toBe(1);
    });
});
