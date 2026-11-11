// W3 — the criteria engine: §5's Goal evaluated against the store, with no model anywhere.
//
// WHY THIS MODULE EXISTS AND WHY IT READS THE STORE DIRECTLY: G-3 requires `code` criteria to be
// "evaluated by the server without a model call" and "re-evaluated automatically after every
// commit", and D-10 requires mechanical continuity (an unpaid setup, a timeline out of order, a
// fact contradiction on a shared key) to be code-checked because "mechanical continuity MUST NOT be
// delegated to an LLM's judgment". So the checkers below are pure functions of committed records:
// nothing in this file can reach a model (it imports no `../llm`, no `fetch`, and only the store's
// TYPES, which erase at runtime). That is a testable property, not a claim — see engine.test.ts.
//
// THE JUDGE SIDE IS AGGREGATION, NOT JUDGMENT (P6, D-15): this engine never asks whether prose is
// good. A `judge` criterion is answered by a fresh checker run through `submitVerdict` (§8.3) and
// lands in `verdicts.criteria_passed`; here those answers are COLLECTED per target and collapsed by
// the rule W3 states — a criterion passes only when every in-scope target's LATEST verdict passes
// it. An older pass cannot outvote a newer fail, because every reviewer is amnesiac (P2) and the
// newest report is the one that describes the artifact as it now stands.
//
// LEVELS, NOT SCORES (§5.2, L-14, G-2): the criteria group into one level per phase boundary plus a
// whole-Story level, "reported separately because they fail for different reasons", and a level the
// Story has not reached is `n/a`, never `0/n` — "a Story in Phase 1 is not failing at chapters".
// Progress renders as `n/m · failing: …` for the CURRENT phase only (W3 acceptance, G-2): a phase
// the Author has not reached must not appear as failing, and every failure names its `fix_hint`.
//
// READ-ONLY BY CONSTRUCTION (G-3, D-10): evaluation never writes. The one tempting mutation is
// marking a contradicting ledger entry `status: 'conflict'` — that write belongs to the loop/tools
// surface (W2/W4), which can attribute it and dedupe the finding it spawns (D-16). The engine only
// names the conflict in evidence.
import {
    type Chapter,
    type Criterion,
    type Goal,
    type LedgerEntry,
    type Plotline,
    type Story,
    type StoryPhase,
    type Summary,
    type Verdict
} from '../../shared/types';
import { criterionById, defaultGoal, LEVELS, PER_CHAPTER, type CriterionLevel } from '../../shared/criteria';
// Type-only import: the engine must not pull the store's runtime (or anything it reaches) into a
// check the server runs after every commit (G-3), and this is what makes that provable.
import type { Store } from '../store';

// ---------------------------------------------------------------------------
// Public result shapes (the contract U-6's Goal panel, W4's goal check and W7's level history read)
// ---------------------------------------------------------------------------

/** §5.1 / §4.9 — one criterion's answer, with the citation P6/G-6 demand and who answered it. */
export interface CriterionResult {
    criterion: string;
    passed: boolean;
    /** The citable line behind the answer (D-15: a failing line without evidence is invalid). */
    evidence?: string;
    /** The finding this failure is tracked by, when the verdict named one (D-16). */
    finding_ref?: string;
    /** 'code' = decided here, server-side; 'verdict' = collected from a checker run's report. */
    source: 'code' | 'verdict';
}

/** L-14's `n/m` for one level. */
export interface LevelStatus {
    passed: number;
    total: number;
}

/** G-2: every failure names the smallest change that would satisfy it. */
export interface FailingCriterion {
    criterion: string;
    fix_hint: string;
    evidence?: string;
}

/** §5.1's pass rule made concrete: all hard pass AND soft passes ≥ `threshold_soft`. */
export interface GoalStatus {
    passed: boolean;
    /** G-2 / W3: `n/m · failing: C-4, C-5` — the CURRENT phase only, never a bare percentage. */
    progress: string;
    failing: FailingCriterion[];
    softPassed: number;
    /** The Goal's `threshold_soft`, with any per-chapter `bar_override` delta applied (G-1). */
    softThreshold: number;
}

/** G-1 / §14 item 2: the per-chapter bar, plus what the engine had to ignore while parsing it. */
export interface ChapterGoalStatus extends GoalStatus {
    warnings: string[];
}

/** L-14's per-Story level block: reached levels carry `n/m`, unreached ones carry the string `'n/a'`. */
export interface LevelReport {
    levels: Record<CriterionLevel, LevelStatus | 'n/a'>;
    /** Every failing criterion across the reached levels, in level order (U-1a names these). */
    failing: string[];
}

// ---------------------------------------------------------------------------
// Placement tables (§5.2)
// ---------------------------------------------------------------------------

/**
 * A criterion's home: one of the four levels, or `'per-chapter'` for C-12, which §5.2 keeps
 * OUTSIDE the levels ("C-12 sits outside the levels as a per-chapter quality check") while still
 * judging it against each chapter.
 */
type Placement = CriterionLevel | 'per-chapter';

/** §5.2's level order — the order the Goal panel and the progress line read top to bottom. */
const LEVEL_ORDER: CriterionLevel[] = ['summary', 'plotlines', 'chapters', 'whole'];

/** id → level, built once from §5.2's table so an edit to `LEVELS` cannot drift from this engine. */
const BUILT_IN_PLACEMENT: Map<string, Placement> = (() => {
    const map = new Map<string, Placement>();

    for (const level of LEVEL_ORDER) for (const id of LEVELS[level]) map.set(id, level);

    for (const id of PER_CHAPTER) map.set(id, 'per-chapter');

    return map;
})();

/** Which levels each phase's Goal covers (W3: "per-phase reporting"). */
const PHASE_LEVELS: Record<StoryPhase, CriterionLevel[]> = {
    // Loop S — the Summary pass judges the Seed→Summary level and nothing else (L-4a).
    summary: ['summary'],
    // Loop A — the plotline pass, C-0…C-6 (§6.2).
    plotlines: ['plotlines'],
    // Loop B — the chapter pass carries BOTH the per-chapter level and the whole-Story level,
    // because pacing and promise-payment are only answerable once the chapter set exists (§6.2).
    chapters: ['chapters', 'whole']
};

/**
 * L-14: "a level for a phase the Story has not reached is `n/a`, not `0/n`". A level is reached
 * once the Story's phase has arrived at its boundary; `whole` shares phase 3's rank because §5.2's
 * table gives it the same phase.
 */
const LEVEL_RANK: Record<CriterionLevel, number> = { summary: 0, plotlines: 1, chapters: 2, whole: 2 };
const PHASE_RANK: Record<StoryPhase, number> = { summary: 0, plotlines: 1, chapters: 2 };

/** The code checkers this build implements, in §5.2's order (C-0, C-1, C-5, C-6, C-15). */
const CODE_CHECKER_IDS = ['C-0', 'C-1', 'C-5', 'C-6', 'C-15'];

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/**
 * D-10's "shared key": two ledger entries speak about the same thing when their subjects agree
 * after trimming, lowering and collapsing whitespace. Deliberately NOT a stemmer or a fuzzy match —
 * a mechanical check that guesses is a check the Author cannot debug, and a near-miss reads as a
 * clean ledger (D-10 is about mechanical certainty).
 *
 * Exported because the Digest groups open threads by the same key (D-12a) and a second, slightly
 * different normalisation there would put two sources of truth in one server (P3).
 */
export function normalizeKey(value: string): string {
    return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Collapses a stored blob into one digest/evidence-safe line and clamps it (T-7's economy). */
export function clampLine(value: string, limit = 200): string {
    const flat = value.replace(/\s+/g, ' ').trim();

    if (flat.length <= limit) return flat;

    return `${flat.slice(0, Math.max(0, limit - 1))}…`;
}

function codeResult(criterion: string, passed: boolean, evidence: string): CriterionResult {
    return { criterion, passed, evidence, source: 'code' };
}

/** G-2's render: `n/m` always, `· failing: …` only when something fails, never a percentage. */
function progressLine(results: CriterionResult[]): string {
    const passed = results.filter((result) => result.passed).length;
    const failing = results.filter((result) => !result.passed).map((result) => result.criterion);

    return failing.length === 0
        ? `${passed}/${results.length}`
        : `${passed}/${results.length} · failing: ${failing.join(', ')}`;
}

/**
 * Recency order for two verdicts about the SAME target (W3: "the latest verdict passes it").
 * `created_at` is the primary key; `rev` then `id` break ties so two verdicts written in the same
 * millisecond still produce a deterministic answer — a flaky criteria engine would make the whole
 * loop's trend accounting flaky (L-15).
 */
function verdictRecency(left: Verdict, right: Verdict): number {
    if (left.created_at !== right.created_at) return left.created_at < right.created_at ? -1 : 1;

    if (left.rev !== right.rev) return left.rev - right.rev;

    return left.id < right.id ? -1 : 1;
}

// ---------------------------------------------------------------------------
// Scoped reads (T-3: every read is scoped to one Story; a Story IS its records, P3)
// ---------------------------------------------------------------------------

function storySummary(store: Store, storyId: string): Summary | undefined {
    // §4.2 keeps one Summary per Story; if an Author's store somehow carries two, the first
    // (insertion order) is the one §4.2's one-record rule points at, and C-0 counts against it.
    return store.summaries.list().find((summary) => summary.story_id === storyId);
}

function storyPlotlines(store: Store, storyId: string): Plotline[] {
    return store.plotlines
        .list()
        .filter((plotline) => plotline.story_id === storyId)
        .sort((left, right) =>
            left.order === right.order ? left.id.localeCompare(right.id) : left.order - right.order
        );
}

function storyChapters(store: Store, storyId: string): Chapter[] {
    return store.chapters
        .list()
        .filter((chapter) => chapter.story_id === storyId)
        .sort((left, right) =>
            left.order === right.order ? left.id.localeCompare(right.id) : left.order - right.order
        );
}

function storyLedger(store: Store, storyId: string): LedgerEntry[] {
    return store.ledger.list().filter((entry) => entry.story_id === storyId);
}

// ---------------------------------------------------------------------------
// The code checkers (G-3, D-10) — every one a pure read, no model, no write
// ---------------------------------------------------------------------------

/**
 * C-0 — "the Story has exactly `chapter_count` plotlines and chapters — no more, no fewer"
 * (§5.2, L-6a, D-3b). The count is AUTHOR truth: the Writer does not choose it and no checker may
 * file a finding that implies a different one.
 *
 * BOTH HALVES ARE CHECKED, in the order the phases create the artifacts (§5.3: a criterion is
 * answerable against a stored artifact):
 *
 *   plotlines — always. Phase 2's product, and `chapter_count` is the number it has to hit.
 *   chapters  — as soon as ANY chapter exists. U-1b (review fix 4): the chapter half used to be
 *     REPORTED in the evidence line and never judged, so a Story with 7 chapters against a declared
 *     8 passed C-0 while the criterion's own question asks for "exactly `chapter_count` chapters".
 *     That is the L-6a failure the criterion names, and a completion prompt that quotes a passing C-0
 *     over a short book is the product lying to the Author.
 *
 * WHY THE CHAPTER HALF STAYS VACUOUS AT ZERO (L-14): a Story in phase ② or ③ has no chapters, and
 * failing it for that is the `0/n`-vs-`n/a` confusion L-14 forbids — the phase has not been asked to
 * write any yet. The first chapter is the moment the count starts being attempted, and from there a
 * shortfall is a hard failure. Per-chapter delivery stays C-1/C-7/C-8's job.
 */
function checkChapterCount(store: Store, storyId: string): CriterionResult {
    const summary = storySummary(store, storyId);

    if (!summary) {
        return codeResult(
            'C-0',
            false,
            `no Summary record exists for ${storyId}, so chapter_count is undeclared and C-0 has nothing to count against (D-3b)`
        );
    }

    const plotlines = storyPlotlines(store, storyId);
    const chapters = storyChapters(store, storyId);

    if (plotlines.length !== summary.chapter_count) {
        const direction = plotlines.length > summary.chapter_count ? 'delete the surplus' : 'create the missing one(s)';

        return codeResult(
            'C-0',
            false,
            `${plotlines.length} plotline${plotlines.length === 1 ? '' : 's'} exist for a declared chapter_count of ${summary.chapter_count} — no more, no fewer: ${direction} (D-3b, L-6a)`
        );
    }

    // U-1b (review fix 4): the OTHER half of the sentence. Vacuous at zero chapters (L-14 — phase ②
    // has not been asked to write any), hard from the first chapter, which is where the declared count
    // starts being attempted. The evidence line names both numbers, because the Author is the only one
    // who may change either of them (D-3b).
    if (chapters.length > 0 && chapters.length !== summary.chapter_count) {
        const direction =
            chapters.length > summary.chapter_count
                ? "the surplus is the Author's to re-declare, not the crew's to ignore"
                : `write the missing ${summary.chapter_count - chapters.length}`;
        const quantity = chapters.length === 1 ? '1 chapter is drafted' : `${chapters.length} chapters are drafted`;
        // Verb agreement, because this string is product copy the Author reads in the criteria pane.
        const counted = plotlines.length === 1 ? '1 plotline matches' : `${plotlines.length} plotlines match`;

        return codeResult(
            'C-0',
            false,
            `${counted} the declared chapter_count of ${summary.chapter_count}, but ${chapters.length > summary.chapter_count ? '' : 'only '}${quantity} — no more, no fewer: ${direction} (D-3b, L-6a)`
        );
    }

    return codeResult(
        'C-0',
        true,
        `${plotlines.length} plotlines and ${chapters.length} chapter${chapters.length === 1 ? '' : 's'} for a declared chapter_count of ${summary.chapter_count} — no more, no fewer`
    );
}

/**
 * C-1 — "every chapter has a plotline" (§5.2, P4). A chapter whose `plotline_ref` is empty, or
 * points at a plotline that does not exist, has no contract, so nothing downstream can answer
 * "does the artifact deliver it?" (P4) — C-7/C-8 become unjudgeable for it.
 *
 * Vacuous pass when the Story has no chapters: there is nothing to be missing, and phase 2's Goal
 * must not fail on artifacts phase 3 has not created (L-14's reasoning again).
 */
function checkChapterContracts(store: Store, storyId: string): CriterionResult {
    const chapters = storyChapters(store, storyId);

    if (chapters.length === 0) {
        return codeResult(
            'C-1',
            true,
            'no chapter exists yet, so C-1 has no orphan to find — it re-checks per chapter in phase 3'
        );
    }

    const plotlineIds = new Set(storyPlotlines(store, storyId).map((plotline) => plotline.id));
    const orphans = chapters.filter((chapter) => !chapter.plotline_ref || !plotlineIds.has(chapter.plotline_ref));

    if (orphans.length === 0) {
        return codeResult(
            'C-1',
            true,
            `all ${chapters.length} chapter${chapters.length === 1 ? '' : 's'} name a plotline that exists`
        );
    }

    const detail = orphans
        .map(
            (chapter) =>
                `${chapter.id} (order ${chapter.order}, ${chapter.plotline_ref ? `plotline_ref ${chapter.plotline_ref} is missing` : 'no plotline_ref'})`
        )
        .join('; ');

    return codeResult(
        'C-1',
        false,
        `${orphans.length} of ${chapters.length} chapters have no resolvable plotline: ${detail}`
    );
}

/**
 * C-5 — "every `setup` in the ledger has a `payoff`, and every `payoff` has a setup" (§5.2, D-10).
 *
 * Matching is on the NORMALISED subject (D-10's "shared key"); the pairing must exist in BOTH
 * directions, because an unbacked payoff is as much a continuity break as an unpaid promise — the
 * reader notices a rescue nobody earned as readily as a gun that never fires (Chekhov, stated in
 * §4.6's field list).
 *
 * `status: 'stale'` entries are excluded from both sides: `stale` (§4.6) is the store's word for a
 * fact a backtrack retired, and a retired promise cannot be outstanding. The engine does not write
 * that reasoning into the ledger — the loop owns ledger writes.
 */
function checkLedgerThreads(store: Store, storyId: string): CriterionResult {
    const entries = storyLedger(store, storyId).filter(
        (entry) => (entry.kind === 'setup' || entry.kind === 'payoff') && entry.status !== 'stale'
    );

    const setups = entries.filter((entry) => entry.kind === 'setup');
    const payoffs = entries.filter((entry) => entry.kind === 'payoff');

    const payoffKeys = new Set(payoffs.map((entry) => normalizeKey(entry.subject)));
    const setupKeys = new Set(setups.map((entry) => normalizeKey(entry.subject)));

    // Reported by DISPLAY subject (the Author's own wording) but deduped by key, so the same thread
    // reported twice with different capitalisation cannot fill the evidence line.
    const unpaid = distinctSubjects(setups.filter((entry) => !payoffKeys.has(normalizeKey(entry.subject))));
    const unbacked = distinctSubjects(payoffs.filter((entry) => !setupKeys.has(normalizeKey(entry.subject))));

    if (unpaid.length === 0 && unbacked.length === 0) {
        return codeResult(
            'C-5',
            true,
            `${setups.length} setup and ${payoffs.length} payoff entries pair off on their normalised subjects — no open thread`
        );
    }

    const parts: string[] = [];

    if (unpaid.length > 0) parts.push(`setup with no payoff: ${unpaid.join(', ')}`);
    if (unbacked.length > 0) parts.push(`payoff with no setup: ${unbacked.join(', ')}`);

    return codeResult('C-5', false, parts.join(' · '));
}

/** The display subjects of a set of ledger entries, deduped by normalised key, in first-seen order. */
function distinctSubjects(entries: LedgerEntry[]): string[] {
    const seen = new Set<string>();
    const subjects: string[] = [];

    for (const entry of entries) {
        const key = normalizeKey(entry.subject);

        if (seen.has(key)) continue;

        seen.add(key);
        subjects.push(`"${entry.subject.trim()}"`);
    }

    return subjects;
}

/**
 * C-6 — "timeline is monotonic; no `fact` contradiction" (§5.2, D-10). Two mechanical halves:
 *
 * 1. TIMELINE. §4.6 gives a `timeline` entry no date field of its own — the only position available
 *    is the chapter it is attached to. So monotonic means: reading the timeline entries in the order
 *    the ledger recorded them, the ORDER OF THE CHAPTER THEY ANCHOR TO must never go backwards. An
 *    entry that anchors to an earlier chapter than its predecessor is the ledger saying the story's
 *    timeline went backwards (or that the entry was attached to the wrong chapter). Entries with no
 *    resolvable `chapter_ref` are unanchored and are skipped, but counted in the evidence line so
 *    the Author can see how much of the timeline the check actually covered.
 * 2. FACT CONTRADICTION. `fact` entries sharing a normalised subject must carry the same normalised
 *    detail (D-10's "a `fact` contradiction on a shared key"). Two details that differ is the break.
 *
 * `stale` entries are excluded (same rule as C-5: a retired fact cannot contradict a live one).
 * Nothing is written: marking the entry `status: 'conflict'` is the loop's move, not the checker's.
 */
function checkLedgerTimeline(store: Store, storyId: string): CriterionResult {
    const entries = storyLedger(store, storyId);
    const chapters = new Map(storyChapters(store, storyId).map((chapter) => [chapter.id, chapter] as const));
    const failures: string[] = [];

    // -- 1. timeline monotonicity ----------------------------------------------------------------
    const timeline = entries.filter((entry) => entry.kind === 'timeline' && entry.status !== 'stale');
    let anchored = 0;
    let unanchored = 0;
    let previous: { id: string; subject: string; order: number } | undefined;

    for (const entry of timeline) {
        const chapter = entry.chapter_ref ? chapters.get(entry.chapter_ref) : undefined;

        if (!chapter) {
            unanchored += 1;
            continue;
        }

        anchored += 1;

        if (previous && chapter.order < previous.order) {
            failures.push(
                `timeline goes backwards: ${entry.id} ("${entry.subject.trim()}", chapter ${chapter.id} order ${chapter.order}) is recorded after ${previous.id} (chapter order ${previous.order})`
            );
        }

        previous = { id: entry.id, subject: entry.subject, order: chapter.order };
    }

    // -- 2. fact contradiction on a shared key ---------------------------------------------------
    const facts = entries.filter((entry) => entry.kind === 'fact' && entry.status !== 'stale');
    const bySubject = new Map<string, { display: string; details: Map<string, string[]> }>();

    for (const entry of facts) {
        const key = normalizeKey(entry.subject);
        const detailKey = normalizeKey(entry.detail ?? '');
        const group = bySubject.get(key) ?? { display: entry.subject.trim(), details: new Map<string, string[]>() };

        group.details.set(detailKey, [...(group.details.get(detailKey) ?? []), entry.id]);
        bySubject.set(key, group);
    }

    for (const group of bySubject.values()) {
        if (group.details.size < 2) continue;

        const readings = [...group.details.entries()].map(
            ([detail, ids]) => `${ids.join('/')} says "${detail || '(no detail)'}"`
        );

        failures.push(`fact contradiction on "${group.display}": ${readings.join(' vs ')}`);
    }

    if (failures.length === 0) {
        const coverage =
            unanchored > 0
                ? `; ${unanchored} timeline entry(ies) carry no resolvable chapter_ref and were not ordered`
                : '';

        return codeResult(
            'C-6',
            true,
            `${anchored} anchored timeline entries in non-decreasing chapter order and no fact key with two readings${coverage}`
        );
    }

    return codeResult('C-6', false, failures.join(' · '));
}

/**
 * C-15 — "every Idea that reached a locked artifact was verified by an Editor and carries evidence"
 * (§5.2, D-27, D-31, T-10).
 *
 * The stored proxy for "reached a locked artifact" is `state: 'selected'`: selection is the Author's
 * decision that the Idea's content goes INTO the artifact (D-29), so checking selected Ideas is the
 * mechanical reading of the criterion and it is checked before the lock can pass (W3 acceptance:
 * "a sourced Idea selected without an Editor verdict fails C-15").
 *
 * A verification counts only when it is a real Editor answer: `verdict === 'verified'`, a non-empty
 * evidence line (D-15: an assertion with no citation is not evidence; T-10: a page cited for a
 * claim it does not make is `refuted`, not "mostly right"), and a non-empty `checked_by_run` naming
 * who checked it (D-31: the Editor's verdict is a record, not a vibe).
 */
function checkIdeaVerification(store: Store, storyId: string): CriterionResult {
    const selected = store.ideas.list().filter((idea) => idea.story_id === storyId && idea.state === 'selected');

    if (selected.length === 0) {
        return codeResult('C-15', true, 'no Idea is `selected`, so nothing unverified has reached an artifact (D-29)');
    }

    const offenders: string[] = [];

    for (const idea of selected) {
        const verification = idea.verification;
        let reason = '';

        if (!verification) reason = 'no Editor verification at all';
        else if (verification.verdict !== 'verified') reason = `the Editor verdict is \`${verification.verdict}\``;
        else if (verification.evidence.trim().length === 0) reason = 'the verdict carries no evidence line (D-15)';
        else if (verification.checked_by_run.trim().length === 0)
            reason = 'no Editor run is recorded as having checked it';

        if (reason)
            offenders.push(
                `${idea.id}${idea.sources.length > 0 ? ` (${idea.sources.length} source${idea.sources.length === 1 ? '' : 's'})` : ''}: ${reason}`
            );
    }

    if (offenders.length === 0) {
        return codeResult(
            'C-15',
            true,
            `${selected.length} selected Idea${selected.length === 1 ? '' : 's'} all carry a verified Editor verdict with evidence and a checking run (D-27)`
        );
    }

    return codeResult(
        'C-15',
        false,
        `${offenders.length} selected Idea${offenders.length === 1 ? '' : 's'} reached an artifact without a checked Editor verdict — ${offenders.join('; ')}`
    );
}

/** The registry the code half of the engine runs from (G-3: server-side, no model, no write). */
const CODE_CHECKERS: Record<string, (store: Store, storyId: string) => CriterionResult> = {
    'C-0': checkChapterCount,
    'C-1': checkChapterContracts,
    'C-5': checkLedgerThreads,
    'C-6': checkLedgerTimeline,
    'C-15': checkIdeaVerification
};

// ---------------------------------------------------------------------------
// §4.6/D-16 normalisation for `bar_override` (G-1, §14 item 2)
// ---------------------------------------------------------------------------

/** The parsed form of `chapters[].bar_override`: what to drop, how to move the soft bar, what to ignore. */
interface BarOverride {
    drop: Set<string>;
    thresholdDelta: number;
    warnings: string[];
}

/**
 * Parses the Author's per-chapter override text (§4.4 `bar_override`: "a criterion id to drop, or a
 * threshold delta. Author-only."). Grammar the build supports:
 *
 *     -C-11          drop that criterion for this chapter (G-1's "delete one", per chapter)
 *     +1 / -1 / 2    move `threshold_soft` by that delta — the ending can be held higher than ch3
 *
 * Parsing is LENIENT on purpose: a Goal override is prose the Author types in a text box, and a
 * rejected token must not fail a chapter or halt the loop. An unrecognisable token is ignored and
 * reported in `warnings`, which U-6 renders next to the override (G-2: the Author is told, never
 * silently overruled).
 */
function parseBarOverride(raw: string | undefined): BarOverride {
    const override: BarOverride = { drop: new Set<string>(), thresholdDelta: 0, warnings: [] };

    if (!raw || raw.trim().length === 0) return override;

    for (const token of raw.split(/[\s,;]+/)) {
        if (token.length === 0) continue;

        if (/^-C-\S+$/i.test(token)) {
            // Canonicalise so `-c-11` matches the criterion id `C-11` the Goal carries.
            override.drop.add(token.slice(1).toUpperCase());
            continue;
        }

        if (/^[+-]?\d+$/.test(token)) {
            override.thresholdDelta += Number(token);
            continue;
        }

        override.warnings.push(
            `ignoring unrecognised bar_override token "${token}" — expected -C-<id> or a ± threshold delta`
        );
    }

    return override;
}

// ---------------------------------------------------------------------------
// CriteriaEngine
// ---------------------------------------------------------------------------

/**
 * The Goal evaluator. Construct it once per process (it holds no state — every method reads the
 * store that is handed to it), call `evaluateCode` after every commit (G-3), and call the goal
 * methods when the loop needs the phase's answer (W4) or the Goal panel needs a row (U-6).
 */
export class CriteriaEngine {
    // -- the code half (G-3) ---------------------------------------------------------------------

    /**
     * Every `code` criterion this build implements, evaluated from the store alone: C-0, C-1, C-5,
     * C-6, C-15 (§5.2). No model, no write, and deterministic for a given committed state — which is
     * what lets the engine re-run it after every commit (G-3) and lets W7 diff level history (L-15).
     */
    evaluateCode(store: Store, storyId: string): CriterionResult[] {
        return CODE_CHECKER_IDS.map((id) => CODE_CHECKERS[id](store, storyId));
    }

    /**
     * One `code` criterion by id. A criterion the Author ADDED (G-1) whose `checker` says `code`
     * has no implementation, and inventing one silently would put an unasked question in the
     * Author's Goal: it fails, and the evidence says exactly why (G-6: a criterion whose evidence
     * is not citable is a build defect — the same honesty applies to an unimplemented checker).
     */
    evaluateCodeCriterion(store: Store, storyId: string, criterion: Criterion): CriterionResult {
        const checker = CODE_CHECKERS[criterion.id];

        if (checker) return checker(store, storyId);

        return codeResult(
            criterion.id,
            false,
            `no built-in code checker implements ${criterion.id}, so the server cannot decide it without a model call (G-3) — make it a judge criterion or implement the checker`
        );
    }

    // -- the judge half (aggregation, §4.9/D-15) -------------------------------------------------

    /**
     * Collects a checker run's answers for the given criterion ids (W3: "judge criteria collected
     * from verdicts"). A criterion passes when EVERY in-scope target's latest verdict passes it:
     *
     * - no verdict for a target at all → not passed, evidence names that (a criterion nobody has
     *   judged is not a criterion that passed — P6's boolean needs a citation, and it has none);
     * - the latest verdict for a target that speaks to this criterion wins, so a chapter that
     *   regressed after a pass reads as failing (every reviewer is fresh, P2, and the newest report
     *   describes the artifact as it stands);
     * - failing evidence comes from the verdict line, falling back to the finding it links (D-15).
     *
     * A caller that passes a `code` criterion id gets verdict aggregation anyway — the level
     * evaluation below routes by `checker`, so only the tool surface could ask for this.
     */
    aggregateJudge(store: Store, storyId: string, criterionIds: string[]): CriterionResult[] {
        return criterionIds.map((id) => this.aggregateJudgeFor(store, storyId, id));
    }

    /** The single-target override form: judge `criterionId` against exactly these targets. */
    private aggregateJudgeWithTargets(
        store: Store,
        storyId: string,
        criterionId: string,
        targetRefs: string[]
    ): CriterionResult {
        const verdicts = store.verdicts.list().filter((verdict) => verdict.story_id === storyId);

        if (targetRefs.length === 0) {
            return {
                criterion: criterionId,
                passed: false,
                source: 'verdict',
                evidence: `no artifact exists for ${storyId} at this criterion's level, so ${criterionId} has no verdict yet — nothing has been judged`
            };
        }

        const failing: string[] = [];
        let findingRef: string | undefined;

        for (const targetRef of targetRefs) {
            // Latest verdict FOR THIS TARGET that actually speaks to this criterion. A later verdict
            // that is silent about the criterion does not erase the earlier answer: §8.3 lets a run
            // report a subset (`submitVerdict(target_ref, criteria_passed[])`), so silence is scope,
            // not a retraction.
            const candidates = verdicts
                .filter(
                    (verdict) =>
                        verdict.target_ref === targetRef &&
                        verdict.criteria_passed.some((line) => line.criterion === criterionId)
                )
                .sort(verdictRecency);

            const latest = candidates[candidates.length - 1];

            if (!latest) {
                failing.push(`${targetRef}: no verdict yet`);
                continue;
            }

            const line = latest.criteria_passed.find((entry) => entry.criterion === criterionId);

            if (!line) continue;

            if (line.result) continue;

            if (!findingRef && line.finding_ref) findingRef = line.finding_ref;

            failing.push(`${targetRef}: ${evidenceOf(store, line, criterionId)}`);
        }

        if (failing.length === 0) {
            return {
                criterion: criterionId,
                passed: true,
                source: 'verdict',
                evidence: `the latest verdict for each of ${targetRefs.length} target(s) passes ${criterionId}`
            };
        }

        const result: CriterionResult = {
            criterion: criterionId,
            passed: false,
            source: 'verdict',
            // U-6 renders this verbatim, so it is clamped: the panel shows the failures, not a stack
            // of every checker's prose (§10.2 U-1a's "stuck criteria" must read in one pass).
            evidence: `${failing
                .slice(0, 3)
                .map((failure) => clampLine(failure))
                .join(' · ')}${failing.length > 3 ? ` · and ${failing.length - 3} more` : ''}`
        };

        if (findingRef) result.finding_ref = findingRef;

        return result;
    }

    /** Judge one criterion against whatever §5.2 says its scope is. */
    private aggregateJudgeFor(store: Store, storyId: string, criterionId: string): CriterionResult {
        return this.aggregateJudgeWithTargets(
            store,
            storyId,
            criterionId,
            this.scopeTargets(store, storyId, criterionId)
        );
    }

    /**
     * §5.2's scope per level:
     * - `summary` → the Story's Summary record (one per Story, §4.2);
     * - `plotlines` → each plotline, EXCEPT C-4, which is a cross-plotline consistency check and so
     *   is judged against the set as a whole — the Story record, the only id that names the set
     *   (§8.3's `submitVerdict` takes a `target_ref`, and for "these plotlines contradict each
     *   other" that target is the Story);
     * - `chapters` and the per-chapter C-12 → each chapter;
     * - `whole` → the Story record.
     * A criterion the Author added has no §5.2 placement and is judged against the Story, the
     * broadest scope (evaluating it nowhere would let it vanish from the Goal silently).
     */
    private scopeTargets(store: Store, storyId: string, criterionId: string): string[] {
        const placement = placementOf(criterionId);
        const level: CriterionLevel = placement === 'per-chapter' ? 'chapters' : placement;

        switch (level) {
            case 'summary': {
                const summary = storySummary(store, storyId);

                return summary ? [summary.id] : [];
            }
            case 'plotlines':
                return criterionId === 'C-4'
                    ? [storyId]
                    : storyPlotlines(store, storyId).map((plotline) => plotline.id);
            case 'chapters':
                return storyChapters(store, storyId).map((chapter) => chapter.id);
            case 'whole':
                return [storyId];
        }
    }

    // -- the Goal -----------------------------------------------------------------------------

    /**
     * The Goal this Story is measured against (G-4: one shared target for every crew).
     *
     * Resolution order: the Goal `stories.goal_ref` names → the Story's own `goals` row → the
     * built-in default shape. The default is EVALUATED, never written: a Goal row is an Author
     * artifact (G-1), and an engine that materialises one on read would be an agent writing story
     * state, which P10 and D-1 both forbid.
     */
    resolveGoal(store: Store, story: Story): Goal {
        if (story.goal_ref) {
            const named = store.goals.get(story.goal_ref);

            if (named) return named;
        }

        const own = store.goals.list().find((goal) => goal.story_id === story.id);

        if (own) return own;

        return defaultGoal(story.id);
    }

    /**
     * L-14's block: one `n/m` per level the Story has reached, `'n/a'` for the ones it has not.
     *
     * This is the rule that stops the Author reading a Phase 1 Story as "failing at chapters":
     * unreached levels are absent-by-rendering here, and the dashboard prints `n/a` (U-1).
     */
    levelStatus(store: Store, story: Story): LevelReport {
        const goal = this.resolveGoal(store, story);
        const reached = PHASE_RANK[story.phase];
        const levels = {} as Record<CriterionLevel, LevelStatus | 'n/a'>;
        const failing: string[] = [];

        for (const level of LEVEL_ORDER) {
            if (LEVEL_RANK[level] > reached) {
                levels[level] = 'n/a';
                continue;
            }

            const criteria = levelCriteria(goal, level);
            const results = this.evaluateSet(store, story, criteria);

            levels[level] = { passed: results.filter((result) => result.passed).length, total: criteria.length };

            for (const result of results) if (!result.passed) failing.push(result.criterion);
        }

        return { levels, failing };
    }

    /**
     * The phase Goal (W3's "per-phase reporting", §5.1's pass rule, G-2's render).
     *
     * - criteria: the levels §6.2 assigns the phase — phase 3 carries the chapter level AND the
     *   whole-Story level, because C-10/C-11/C-13 are unanswerable before the chapter set exists;
     * - `passed` = every HARD criterion passes AND `softPassed >= threshold_soft` (§5.1);
     * - `progress` names only the current phase's failures, which is what makes G-2's "MUST NOT show
     *   a phase's criteria as failing before that phase is reached" true by construction: no other
     *   level's criteria are even in the set;
     * - `failing` carries each failure's `fix_hint` (G-2: "each failure naming its fix_hint").
     */
    phaseGoalStatus(store: Store, story: Story): GoalStatus {
        const goal = this.resolveGoal(store, story);
        const criteria = phaseCriteria(goal, story.phase);
        const results = this.evaluateSet(store, story, criteria);

        return tally(criteria, results, goal.threshold_soft);
    }

    /**
     * One chapter's Goal: the chapter level (C-7, C-8 hard; C-9 soft) plus per-chapter C-12, judged
     * against THIS chapter alone (§14 item 2's per-chapter bar, G-1's "per Story and per chapter").
     *
     * `bar_override` can drop a criterion for this chapter and move its soft threshold, so the
     * climax can be held to a higher bar than chapter 3 without editing the Story's Goal (D-14's
     * cousin: the Author's taste, applied locally). Threshold floors at 0 — a negative soft bar is
     * meaningless and a nonsense override must not quietly make every chapter pass.
     */
    chapterGoalStatus(store: Store, story: Story, chapterId: string): ChapterGoalStatus {
        const chapter = store.chapters.get(chapterId);

        if (!chapter)
            throw new Error(
                `no chapter named ${chapterId} in the chapters collection — the per-chapter Goal has nothing to measure`
            );

        // T-3: one Story per run. Reading another Story's chapter into this Story's Goal would let a
        // crew pass a criterion by pointing at someone else's artifact.
        if (chapter.story_id !== story.id) {
            throw new Error(
                `chapter ${chapterId} belongs to ${chapter.story_id}, not ${story.id} — T-3 scopes every read to one Story`
            );
        }

        const goal = this.resolveGoal(store, story);
        const override = parseBarOverride(chapter.bar_override);
        const criteria = levelCriteria(goal, 'chapters').concat(perChapterCriteria(goal));
        const kept = criteria.filter((criterion) => !override.drop.has(criterion.id.toUpperCase()));

        // Every criterion in this set is chapter-scoped, so the whole set is judged against this one id.
        const results = this.evaluateSet(store, story, kept, [chapter.id]);
        const threshold = Math.max(0, goal.threshold_soft + override.thresholdDelta);
        const status = tally(kept, results, threshold);
        const warnings = [...override.warnings];

        for (const dropped of override.drop) {
            if (!criteria.some((criterion) => criterion.id.toUpperCase() === dropped)) {
                warnings.push(
                    `bar_override drops ${dropped}, which this chapter's criteria do not contain — the token changed nothing`
                );
            }
        }

        return { ...status, warnings };
    }

    /** Code criteria go to the server's checkers, judge criteria to the verdict aggregation (G-3). */
    private evaluateSet(store: Store, story: Story, criteria: Criterion[], chapterScope?: string[]): CriterionResult[] {
        return criteria.map((criterion) => {
            if (criterion.checker === 'code') return this.evaluateCodeCriterion(store, story.id, criterion);

            if (chapterScope) return this.aggregateJudgeWithTargets(store, story.id, criterion.id, chapterScope);

            return this.aggregateJudgeFor(store, story.id, criterion.id);
        });
    }
}

// ---------------------------------------------------------------------------
// Set arithmetic (shared by the phase and chapter Goals)
// ---------------------------------------------------------------------------

/** §5.2's placement of a criterion id; Author-added criteria fall to `whole` (see `scopeTargets`). */
function placementOf(criterionId: string): Placement {
    return BUILT_IN_PLACEMENT.get(criterionId) ?? 'whole';
}

/** The criteria of one level, in the Goal's own order (§4.11 "criteria, in order"). */
function levelCriteria(goal: Goal, level: CriterionLevel): Criterion[] {
    return goal.criteria.filter((criterion) => placementOf(criterion.id) === level);
}

/** C-12 and anything else §5.2 keeps outside the levels but judges per chapter. */
function perChapterCriteria(goal: Goal): Criterion[] {
    return goal.criteria.filter((criterion) => placementOf(criterion.id) === 'per-chapter');
}

/** Every criterion the phase's Goal covers, de-duplicated by id and in level order (W3, §6.2). */
function phaseCriteria(goal: Goal, phase: StoryPhase): Criterion[] {
    const seen = new Set<string>();
    const criteria: Criterion[] = [];

    for (const level of PHASE_LEVELS[phase]) {
        for (const criterion of levelCriteria(goal, level)) {
            if (seen.has(criterion.id)) continue;

            seen.add(criterion.id);
            criteria.push(criterion);
        }
    }

    return criteria;
}

/**
 * §5.1's pass rule + G-2's render, applied to one evaluated set.
 *
 * `passed` deliberately requires EVERY HARD criterion to pass (not "every criterion": a soft
 * shortfall blocks the Goal through the threshold, and L-28 says a Reader holding a `taste` finding
 * open does not block completion — that nuance is the soft count's job, not the hard line's).
 *
 * THE ONE RECONCILIATION (reported to the orchestrator): §5.1 states `soft passes ≥ threshold_soft`
 * flatly, but `threshold_soft` belongs to the WHOLE Goal while the phase Goal is evaluated over one
 * LEVEL, and a level can hold fewer soft criteria than the Story's threshold. With the built-in
 * Goal (threshold 3) the plotlines level has exactly one soft criterion, C-3, so the literal rule
 * would make phase 2 unsignable for every Story forever — and W4's sign-off (L-6, L-29) would never
 * fire. So the bar is capped at the number of soft criteria actually in scope: the Author's number
 * is honoured wherever it is reachable, and the unreachable remainder cannot silently stall the
 * pipeline. `softThreshold` therefore reports the bar that was actually applied.
 */
function tally(criteria: Criterion[], results: CriterionResult[], softThreshold: number): GoalStatus {
    const byId = new Map(results.map((result) => [result.criterion, result] as const));
    const failing: FailingCriterion[] = [];
    let softPassed = 0;

    for (const criterion of criteria) {
        const result = byId.get(criterion.id);

        if (!result) continue;

        if (result.passed) {
            if (!criterion.hard) softPassed += 1;

            continue;
        }

        // G-1 lets the Author delete a criterion from the built-in roster, so the built-in lookup is
        // a fallback, not the source: the Goal's own copy carries the hint the Author last edited.
        const fixHint =
            criterion.fix_hint ||
            criterionById(criterion.id)?.fix_hint ||
            'no fix_hint is recorded for this criterion (G-2)';

        failing.push(
            result.evidence
                ? { criterion: criterion.id, fix_hint: fixHint, evidence: result.evidence }
                : { criterion: criterion.id, fix_hint: fixHint }
        );
    }

    // Only HARD criteria gate the pass (see the note above); the soft line is the threshold test.
    const hardAllPass = criteria
        .filter((criterion) => criterion.hard)
        .every((criterion) => byId.get(criterion.id)?.passed === true);
    const softAvailable = criteria.filter((criterion) => !criterion.hard).length;
    const softRequired = Math.min(softThreshold, softAvailable);

    return {
        // A Goal whose soft criteria the Author deleted (G-1) is satisfiable on hard alone:
        // `softRequired` falls to 0, which is right — a threshold over an empty set is vacuous.
        passed: hardAllPass && softPassed >= softRequired,
        progress: progressLine(results),
        failing,
        softPassed,
        softThreshold: softRequired
    };
}

/**
 * D-15: a failing verdict line with no `evidence` is invalid, but it may already be in the store
 * (a tool-side rejection is W2's job). Rather than answer with an empty string, fall back to the
 * evidence of the finding the line links — the defect is still named, and it stays citable.
 */
function evidenceOf(
    store: Store,
    line: { criterion: string; evidence: string; finding_ref?: string },
    criterionId: string
): string {
    const own = line.evidence?.trim();

    if (own) return own;

    if (line.finding_ref) {
        const finding = store.findings.get(line.finding_ref);

        if (finding?.evidence?.trim()) return `${line.finding_ref}: ${finding.evidence.trim()}`;
    }

    return `${criterionId} failed with no evidence on the verdict line (D-15)`;
}
