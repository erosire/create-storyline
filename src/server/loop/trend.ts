// L-14's consistency levels, L-15's trend, and §6.8's stall — the measurement half of the loop.
//
// Everything here is computed from STORED, DEDUPLICATED facts and never from a run's self-report
// (L-14's preamble): a fresh reviewer will happily re-report a defect it already saw fixed, and if the
// measurement trusted that, every long Story would read as failing (L-16a). So:
//   * levels come from the criteria engine's `levelStatus` (code criteria evaluated here, judge
//     criteria aggregated from verdicts — G-3), compared round to round against `level_history`;
//   * closures come from the finding FINGERPRINT ledger, not from finding rows, because D-16's dedupe
//     bumps `seen_count` instead of opening a second row;
//   * only CONFIRMED findings count at all (L-15a) — an `unconfirmed` suspicion is the Editor's job,
//     not evidence for paging the Author, and a `disputed` one is the Editor's verdict of "not a
//     defect" (D-33, D-34a).
//
// No clock is consulted inside these functions except the `at` stamp they write, and the round
// counter is a store field rather than a process variable, so the streak survives a restart (L-3).
import { CLOSED_FINGERPRINT_LIMIT, LEVEL_HISTORY_LIMIT, type LevelHistoryEntry, type LoopStory } from './types';
import { confirmedOpenFingerprints, last, loopStory, oldestConfirmedFinding } from './records';
import type { LevelReport, LevelStatus } from '../criteria/engine';
import type { CriterionLevel } from '../../shared/criteria';
import type { Goal, Story, StoryPhase, Trend } from '../../shared/types';
import type { Store } from '../store';

/**
 * §5.2's level names rendered as L-14's arrows ("`idea→summary 4/4 · summary→plotlines 6/6 ·
 * plotlines→chapters 4/6`"). `whole` is §5.2's fourth level; it is rendered as its own clause because
 * the criteria engine reports it separately and L-14's sentence has no arrow for it.
 */
const LEVEL_LABELS: Record<string, string> = {
    summary: 'idea→summary',
    plotlines: 'summary→plotlines',
    chapters: 'plotlines→chapters',
    whole: 'whole-story'
};

/** The levels in L-14's order, so the rendered sentence and the history read the same way every time. */
const LEVEL_ORDER: CriterionLevel[] = ['summary', 'plotlines', 'chapters', 'whole'];

/** L-14: `n/m` for a reached level, `n/a` for one the Story has not reached (never `0/n`). */
export const levelPair = (level: LevelStatus | 'n/a' | undefined): string =>
    level === undefined || level === 'n/a' ? 'n/a' : `${level.passed}/${level.total}`;

/** The map form rendered back into L-14's sentence — shared by `renderConsistency` and `recordRound`. */
export function renderPairs(levels: Record<string, string>): string {
    return LEVEL_ORDER.filter((level) => levels[level] !== undefined)
        .map((level) => `${LEVEL_LABELS[level] ?? level} ${levels[level]}`)
        .join(' · ');
}

/** §4.1's `consistency` sentence, exactly as L-14 specifies it. */
export function renderConsistency(report: LevelReport): string {
    return renderPairs(levelPairs(report));
}

/** The same numbers as a map, which is the form `level_history` stores and the trend compares. */
export function levelPairs(report: LevelReport): Record<string, string> {
    const pairs: Record<string, string> = {};

    for (const level of LEVEL_ORDER) {
        if (report.levels[level] !== undefined) pairs[level] = levelPair(report.levels[level]);
    }

    return pairs;
}

/** `n/m` parsed back into a number, or `null` for `n/a` — the comparison the trend performs. */
function passedOf(pair: string | undefined): number | null {
    if (pair === undefined || pair === 'n/a') return null;

    const passed = Number.parseInt(pair.split('/')[0] ?? '', 10);

    return Number.isNaN(passed) ? null : passed;
}

/** One level's `n/m` out of the map, for the reason sentences. */
export const pairOf = (entry: LevelHistoryEntry | undefined, level: string): string => entry?.levels[level] ?? 'n/a';

// ---------------------------------------------------------------------------
// The round
// ---------------------------------------------------------------------------

/**
 * What changed between the last recorded round and now.
 *
 * `levelDelta` is the sum of the falls, which is the number `goals.regress_tolerance` is compared
 * against (L-21's "regressing beyond `regress_tolerance`"): a tolerance of 1 tolerates one criterion
 * slipping on one level, and two is a slide. Summing rather than counting levels-that-fell keeps a
 * 6/6 → 4/6 collapse and a 6/6 → 5/6 wobble distinguishable.
 */
export interface RoundDelta {
    trend: Trend;
    flat_streak: number;
    levelDelta: number;
    /** Confirmed fingerprints that closed since the last round (L-15's `improving`). */
    closed: string[];
    /** Fingerprints in the closed ledger that are confirmed-open again (L-15/L-16a's `regressing`). */
    reopened: string[];
    /** Confirmed findings first seen this round, for the reason sentence and the probe verdict. */
    confirmedNew: string[];
    /** False for the very first round: there is nothing to compare against, and §4.1's `unknown` is honest. */
    measured: boolean;
}

/**
 * The comparison itself, pure over the story's history plus the current measurements.
 *
 * L-15's three clauses, in the order the rule states them:
 *   improving  — any level rose, or an open fingerprint closed;
 *   flat       — EVERY level unchanged for consecutive rounds AND no fingerprint closed;
 *   regressing — any level fell, or a previously-closed fingerprint reopened.
 * A round that both rose and fell reads `improving`: L-15 lists it first, and L-21's stall should not
 * fire on a Story that is also making progress somewhere.
 */
export function measureRound(
    story: Story,
    levels: Record<string, string>,
    closedFingerprints: string[],
    confirmedOpen: string[]
): RoundDelta {
    const loop = loopStory(story);
    const previous = last(loop.level_history);
    const ledger = loop.closed_fingerprints ?? [];

    // Closure is detected against the durable ledger, not against a snapshot of last round's open set:
    // `level_history` is bounded (L-15a), so the only place "this fingerprint has been closed before"
    // survives is `closed_fingerprints`. Anything newly present in the closed set is therefore a
    // closure that happened this round (L-15's `improving` trigger).
    const newlyClosed = closedFingerprints.filter((fingerprint) => !ledger.includes(fingerprint));

    // L-16a: reopened = confirmed-open now AND present in the closed ledger. A fingerprint that was
    // never closed cannot reopen, which is exactly the false regression L-16a exists to prevent.
    const reopened = confirmedOpen.filter((fingerprint) => ledger.includes(fingerprint));

    // A level reaching its boundary for the first time (`n/a` -> `4/6`) counts as rising when it has
    // anything passing: L-15's `improving` is about artefacts getting better, and a level that arrives
    // already at 4/6 is better than the level that did not exist. Arriving at 0/n is not a fall, and
    // a level losing its boundary (a backtrack) is neither — `passedOf` reads `n/a` as nothing.
    let rose = false;
    let fell = 0;

    if (previous !== undefined) {
        for (const level of Object.keys(levels)) {
            const before = passedOf(previous.levels[level]) ?? 0;
            const after = passedOf(levels[level]);

            if (after === null) continue;

            if (after > before) rose = true;
            if (after < before) fell += before - after;
        }
    }

    if (previous === undefined) {
        // The very first round has nothing to compare against; §4.1's `unknown` is the honest answer,
        // and a Story cannot stall before it has been measured (L-21: "only after L-37 has been ruled
        // out" and then only on a trend that exists).
        return {
            trend: 'unknown',
            flat_streak: 0,
            levelDelta: 0,
            closed: newlyClosed,
            reopened,
            confirmedNew: [],
            measured: false
        };
    }

    // A re-reported finding is NOT a regression and NOT a stall signal on its own (L-16a): a fresh
    // confirmed finding with a fingerprint that was never closed just means the crew found something,
    // which is L-34's first kind — the loop working.
    const confirmedNew = confirmedOpen.filter(
        (fingerprint) => !ledger.includes(fingerprint) && !previous.fingerprint_closed.includes(fingerprint)
    );

    if (rose || newlyClosed.length > 0) {
        return {
            trend: 'improving',
            flat_streak: 0,
            levelDelta: fell,
            closed: newlyClosed,
            reopened,
            confirmedNew,
            measured: true
        };
    }

    if (fell > 0 || reopened.length > 0) {
        // The flat streak resets: L-15's `flat` demands levels UNCHANGED, and a fall is a change.
        return {
            trend: 'regressing',
            flat_streak: 0,
            levelDelta: fell,
            closed: newlyClosed,
            reopened,
            confirmedNew,
            measured: true
        };
    }

    // `flat` is "EVERY level unchanged" — so the comparison is over the levels BOTH rounds measured.
    // A level that is `n/a` on either side is skipped: it cannot be unchanged or changed, and treating
    // a boundary crossing as a change would make a backtrack or a first arrival read as movement.
    const unchanged = Object.keys(levels)
        .filter((level) => passedOf(previous.levels[level]) !== null && passedOf(levels[level]) !== null)
        .every((level) => passedOf(previous.levels[level]) === passedOf(levels[level]));

    const flat = unchanged && newlyClosed.length === 0;

    return {
        trend: flat ? 'flat' : 'unknown',
        flat_streak: flat ? (loop.flat_streak ?? 0) + 1 : 0,
        levelDelta: fell,
        closed: newlyClosed,
        reopened,
        confirmedNew,
        measured: true
    };
}

/**
 * Records the round: L-15's retained level history plus the round counter, the flat streak, the trend,
 * and the closed-fingerprint ledger that makes L-16a decidable.
 *
 * Returns the entry it wrote (or `undefined` when nothing changed enough to count as a round), so a
 * sweep report can carry the measurement without re-reading the record.
 *
 * THE LEDGER IS WRITTEN FORWARD, NOT REBUILT: a fingerprint joins `closed_fingerprints` the round it
 * closes and stays there for the rest of the Story's life. That is what lets a reopening be detected
 * after the finding row has been re-raised and re-deduplicated (D-16 turns the second sighting into a
 * `seen_count` bump on a row that is now open again, so the row alone cannot say "this came back").
 * The ledger is bounded (L-16a's reasoning holds for memory too); the oldest entries drop first, and
 * dropping one can only ever lose a regression signal, never invent one.
 */
export function recordRound(
    store: Store,
    story: Story,
    input: {
        levels: Record<string, string>;
        closedFingerprints: string[];
        phase: StoryPhase;
        at: string;
        delta: RoundDelta;
        /** The Story's closed-run count this sweep — see `LevelHistoryEntry.runs_closed`. */
        closedRunCount?: number;
    }
): LevelHistoryEntry | undefined {
    const loop = loopStory(story);
    const round = (loop.round ?? 0) + 1;

    const entry: LevelHistoryEntry = {
        round,
        at: input.at,
        phase: input.phase,
        levels: input.levels,
        fingerprint_closed: input.delta.closed,
        fingerprint_reopened: input.delta.reopened,
        findings_confirmed_new: input.delta.confirmedNew,
        flat_streak: input.delta.flat_streak,
        trend: input.delta.trend,
        // L-15's round marker: the next sweep compares its own closed-run count against this number.
        runs_closed: input.closedRunCount
    };

    const history = [...(loop.level_history ?? []), entry].slice(-LEVEL_HISTORY_LIMIT);
    const closedLedger = [...new Set([...(loop.closed_fingerprints ?? []), ...input.delta.closed])].slice(
        -CLOSED_FINGERPRINT_LIMIT
    );

    store.stories.update(
        story.id,
        {
            round,
            flat_streak: input.delta.flat_streak,
            level_history: history,
            closed_fingerprints: closedLedger,
            trend: input.delta.trend,
            // L-14: the level block is a rendered sentence on the Story, and the tree renders it.
            consistency: renderPairs(input.levels)
        },
        { run_ref: null, why: `round ${round}: level history and trend recomputed (L-14, L-15, L-15a)` },
        [{ id: story.id, rev: story.rev }]
    );

    return entry;
}

// ---------------------------------------------------------------------------
// The stall (§6.8)
// ---------------------------------------------------------------------------

/**
 * The trend as it LAST stood, for a sweep that did not measure a round.
 *
 * L-15's round is a pass, and a pass closes at the boundaries `engine.ts` documents (the drain probe's
 * round, or a finished work cycle after the whole-Story pass) — so most sweeps have no new measurement
 * to report, and the decision still has to answer L-21. The honest answer is the last measured one: a
 * Story cannot become stalled on a sweep that measured nothing, and it cannot STOP being stalled
 * because a sweep happened.
 */
export function carriedDelta(story: Story): RoundDelta {
    const loop = loopStory(story);
    const entry = last(loop.level_history);

    return {
        trend: entry?.trend ?? story.trend,
        flat_streak: loop.flat_streak ?? 0,
        levelDelta: 0,
        closed: [],
        reopened: [],
        confirmedNew: [],
        measured: entry !== undefined
    };
}

/**
 * L-21: flat for `flat_rounds` rounds, or regressing beyond `regress_tolerance`.
 *
 * Only ever consulted AFTER L-37 has been ruled out (L-37a: a drained Story has exactly this flat
 * signature and must read as finished, not stuck), and only while the Story has been measured at all
 * — an unmeasured Story is `unknown`, which is §4.1's honest value, not a stall.
 */
export function isStalled(story: Story, goal: Goal, delta: RoundDelta): boolean {
    const loop = loopStory(story);

    if (!delta.measured) return false;

    if (delta.trend === 'flat' && (loop.flat_streak ?? 0) >= goal.flat_rounds) return true;

    return delta.trend === 'regressing' && delta.levelDelta > goal.regress_tolerance;
}

/**
 * L-22's reason sentence: the level and criteria that will not move, the oldest CONFIRMED fingerprint,
 * the chapters involved, and what the crews tried. "Consistency low" is explicitly not a reason, so
 * every clause names a record the Author can open.
 *
 * "What the crews tried" comes from the queue's own attempt counters (D-11: the queue holds the plan,
 * and §4.7's `attempts` is L-15's "the thing that makes no progress visible") plus the number of runs
 * the Story has spent. It is a count, not a narrative, because a narrative would be a guess.
 */
export function stalledReason(store: Store, story: Story, report: LevelReport, goal: Goal): string {
    const loop = loopStory(story);
    const streak = loop.flat_streak ?? 0;
    // L-22 names only the levels that are REACHED (`!== 'n/a'`) and SHORT of their boundary. A level
    // the Story has not reached is not a reason, and a full level is not a reason either.
    const levelLines = LEVEL_ORDER.map((level) => ({ level, status: report.levels[level] }))
        .filter(
            (row): row is { level: CriterionLevel; status: LevelStatus } =>
                row.status !== undefined && row.status !== 'n/a'
        )
        .filter((row) => row.status.passed < row.status.total)
        .map((row) => `${LEVEL_LABELS[row.level] ?? row.level} ${levelPair(row.status)}`);

    const oldest = oldestConfirmedFinding(store, story.id);
    const tried = store.tasks
        .list()
        .filter((task) => task.story_id === story.id)
        .reduce((sum, task) => sum + (task.attempts ?? 0), 0);

    const parts: string[] = [];

    parts.push(
        deltaKind(story, goal, streak) +
            (levelLines.length > 0 ? ` — ${levelLines.join(', ')} will not move` : ' — no level will move')
    );

    if (report.failing.length > 0) parts.push(`failing: ${[...new Set(report.failing)].join(', ')}`);

    if (oldest !== undefined) {
        parts.push(
            `oldest confirmed finding ${oldest.fingerprint} (seen ${oldest.seen_count}×, on ${oldest.target_ref})`
        );
    }

    const chapters = [...new Set(storyChaptersTouched(store, story.id))];

    if (chapters.length > 0) parts.push(`chapters involved: ${chapters.slice(0, 6).join(', ')}`);

    parts.push(
        `the crews tried ${tried} task attempts across ${store.runs.list().filter((run) => run.story_id === story.id).length} runs`
    );

    return parts.join(' · ');
}

function deltaKind(story: Story, goal: Goal, streak: number): string {
    const loop = loopStory(story);

    return loop.trend === 'regressing'
        ? `levels falling past the tolerance of ${goal.regress_tolerance}`
        : `every level unchanged for ${streak} of the ${goal.flat_rounds} rounds that trip loop detection`;
}

/** Chapter ids named by the Story's confirmed findings — L-22's "which chapters are involved". */
function storyChaptersTouched(store: Store, storyId: string): string[] {
    const chapterIds = new Set(
        store.chapters
            .list()
            .filter((chapter) => chapter.story_id === storyId)
            .map((chapter) => chapter.id)
    );
    const touched: string[] = [];

    for (const finding of store.findings.list()) {
        if (finding.story_id !== storyId) continue;
        if (!['confirmed', 'approved'].includes(finding.state)) continue;

        for (const ref of [finding.target_ref, ...(finding.related_refs ?? [])]) {
            if (chapterIds.has(ref)) touched.push(ref);
        }
    }

    return touched;
}

/** Convenience for the sweep: the confirmed fingerprints as they stand right now (L-15a's input). */
export const confirmedFingerprintsNow = (store: Store, storyId: string): string[] =>
    confirmedOpenFingerprints(store, storyId);
