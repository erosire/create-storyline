// Test scaffolding for the W9/W12 shell: an `ApiClient` double plus fixture builders.
//
// WHY A DOUBLE INSTEAD OF `vi.mock('./api')`: `createDashboardStore` takes the client as a
// parameter, so a test injects a fake and asserts the METHOD CALLS the UI made — which is
// exactly the pinned T7 contract. Mocking the module would instead assert that the component
// imported the right symbol, and would leak module state across files.
//
// Named `shell-fakes` (not `fakes`) because the W10/W11 wave owns its own component fixtures;
// one shared file would be a cross-wave write race.
import { act, fireEvent, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import type {
    ApiClient,
    PhraseDetailView,
    PhraseEntryReviseResult,
    PhraseGroupLockResult,
    PhraseGroupReviseResult,
    PhraseGroupRow,
    PhraseGroupScore,
    PhraseReviewedChooseResult,
    PhraseReviewedGroup,
    PhraseReviewedSummary,
    PhraseStartResult,
    PhraseView,
    QueueItem,
    // R7 — the desk's cleanup read is part of the wire this file stands in for.
    SeedCleanupProposal,
    StoryRow,
    StoryView
} from '../api';
import { DashboardContext, createDashboardStore, type DashboardStore } from '../state';
import {
    DEFAULT_AUTO_APPROVE_COSTS,
    fixtureVocabulary,
    orderedPhraseGroupDefinitions,
    seedHashOf
} from './product-values';
import type { Goal, Story } from '../../types';

/** One STORIES-panel row with §4.1-plausible defaults; override what the test cares about. */
export function storyRow(id: string, overrides: Partial<StoryRow> = {}): StoryRow {
    return {
        id,
        title: `story ${id}`,
        phase: 'summary',
        status: 'ready',
        pending_kind: 'none',
        summary_locked: false,
        plotlines_locked: false,
        levels: { summary: '2/2', plotlines: 'n/a', chapters: 'n/a', whole: '2/2' },
        trend: 'unknown',
        auto_approve: [...DEFAULT_AUTO_APPROVE_COSTS],
        active_runs: 0,
        completion_proposed: false,
        ...overrides
    };
}

/** One queue item (U-10), defaulted to a confirmed `major` finding as the Editor rewrote it. */
export function queueItem(id: string, overrides: Partial<QueueItem> = {}): QueueItem {
    return {
        kind: 'finding',
        story_id: 'story_1',
        story_title: 'Hollow Sea',
        id,
        title: 'the mentor dies twice, and the second death goes unnoticed',
        detail: 'ch3 establishes the death as final; ch9 keeps him teaching with no bridge',
        evidence: 'ch3 ¶4 "he died on the beach" · ch9 ¶1 "the mentor corrected the map"',
        cost: 'major',
        created_at: '2026-11-09T10:00:00.000Z',
        ...overrides
    };
}

/** The `GET /stories/:id` read, minimal but complete — `openStory` refreshes a real view. */
export function storyView(row: StoryRow): StoryView {
    const now = '2026-11-09T10:00:00.000Z';
    const story: Story = {
        id: row.id,
        rev: 1,
        created_at: now,
        updated_at: now,
        title: row.title,
        phase: row.phase,
        idea: 'a cartographer maps the sea that ate her fleet',
        summary_locked: row.summary_locked,
        plotlines_locked: row.plotlines_locked,
        pending_kind: row.pending_kind,
        status: row.status,
        status_reason: row.status_reason,
        trend: row.trend,
        auto_approve: row.auto_approve,
        author_stop: row.status === 'stopped',
        progress: row.progress,
        blocked_on: row.blocked_on,
        digest_rev: 1,
        template_refs: [],
        chapter_deps: {}
    };
    const goal: Goal = {
        id: `goal_${row.id}`,
        rev: 1,
        created_at: now,
        updated_at: now,
        story_id: row.id,
        title: 'the book as the Author wants it',
        threshold_soft: 3,
        criteria: [],
        flat_rounds: 4,
        regress_tolerance: 2
    };
    return {
        story,
        summary: null,
        plotlines: [],
        chapters: [],
        cast: [],
        ledger: [],
        goal: { goal, phase_progress: row.levels.summary, failing: [], chapter_progress: {} },
        ideas: [],
        revisions: [],
        findings: [],
        proposals: [],
        runs: [],
        templates: [],
        cost_distribution: { confirmed_per_cost: { critical: 0, major: 0, minor: 0, taste: 0 }, downgrades: 0 },
        vocabulary: fixtureVocabulary(),
        completion_preview: null,
        digest: null
    };
}

/**
 * The D-65/T3 scoring pass the clean five-group book carries: ONE Critic run over the whole group vector, so
 * all five rows carry the same `vector_hash` and `at` (`api.ts:PhraseGroupScore`'s rule — a test may not invent
 * a per-group pass). The numbers are pinned by the shell tests: `StorylineApp.groups.test.tsx` and
 * `StoryOutline.test.tsx` print them as `84% / 76% / 70% / 88% / 66%`, and their mean (384 / 5 = 76.8 → `77%`)
 * is the phrase header's overall score.
 */
const LIVE_SCORE_HASH = 'vh-9';
const LIVE_SCORE_AT = '2026-11-09T12:00:00.000Z';
const LIVE_SCORE_VALUES: Record<string, number> = { premise: 84, promise: 76, theme: 70, tone: 88, ending: 66 };

/** One Critic score row, in the shape the projection attaches to a group (`api.ts:PhraseGroupScore`). */
function scoreRow(value: number, hash: string, at: string): PhraseGroupScore {
    return { value, vector_hash: hash, at, run_ref: `run_critic_${hash}` };
}

/**
 * ONE group's row inside the Reviewed Summary block (D-67), defaulted to the shape the block exists to show
 * when it HAS a selection: a clean revision that IS the newest text, with no open issue and no score attached.
 *
 * The defaults are readable rather than random because a test asserts the ref the selection forms: the selected
 * row's id is `rev-<key>-<number>` and the clean verdict names `run_clean_<key>`, so a pane's `title` string
 * (`SummaryGroupPane.test.tsx`'s `(run run_clean_premise)`) is derivable from the group the test names.
 *
 * A test overrides only what its case is about (`scores`, `gap`, `superseded`); `id` and `key` are required so
 * the derived defaults cannot silently point at the wrong group.
 */
export function reviewedGroup(
    overrides: Partial<PhraseReviewedGroup> & Pick<PhraseReviewedGroup, 'id' | 'key'>
): PhraseReviewedGroup {
    return {
        selected_revision: 1,
        selected_id: `rev-${overrides.key}-1`,
        clean_run_ref: `run_clean_${overrides.key}`,
        latest_revision: 1,
        superseded: false,
        issues_open: false,
        gap: null,
        scores: [],
        ...overrides
    };
}

/**
 * The Reviewed Summary block (D-67/D-68), defaulted to the EMPTY `pending` block the wire sends for a book
 * with no groups (`api/projections.ts:PhraseView.reviewed` is ALWAYS present, so the fake never omits it).
 *
 * `story-contract.ts:EMPTY_REVIEWED` is the client's tolerance for a payload that predates the feature; this is
 * the payload itself. A test that models a real state passes the fields that state has and leaves the rest.
 */
export function reviewedBlock(overrides: Partial<PhraseReviewedSummary> = {}): PhraseReviewedSummary {
    return {
        state: 'pending',
        complete: false,
        vector: {},
        vector_hash: '',
        overview: '',
        groups: [],
        chosen: null,
        stale: false,
        blocking_issues: [],
        writer_busy: false,
        ...overrides
    };
}

/**
 * R6 — the `GET /stories/:id/phrases` read, DEFAULTING TO THE SAMPLING ECHO the server sends for a legacy book
 * (`mode:'sampling'`, empty rows, never a 404 — `server/api/projections.ts`). That default is what keeps every
 * shell test written before the phrase read existed behaving exactly as it did: a Story with no `summary_mode`
 * is not grouped, so the rail has no groups to draw and the desk shows the round.
 *
 * A grouped test passes `groupedPhraseView` (or its own rows) through `fakeApi({ getPhrase })`.
 */
export function phraseView(storyId: string, overrides: Partial<PhraseView> = {}): PhraseView {
    return {
        story_id: storyId,
        mode: 'sampling',
        phrase_id: null,
        revision: 0,
        overview: '',
        groups: [],
        findings: [],
        tasks: [],
        review: {
            mode: 'sampling',
            unwritten_groups: [],
            written_groups: 0,
            vector: {},
            vector_hash: 'sampling',
            review_seats: 0,
            reviews_on_current_vector: 0,
            deep_reviews_on_current_vector: 0,
            open_findings: 0,
            blocking_findings: 0,
            open_tasks: 0,
            mirror: { summary_id: null, in_sync: true, locked: false, fields: [] }
        },
        // D-67 — the reviewed block travels on EVERY phrase read, including a sampling book's echo: the wire
        // answers `pending` with nothing in it rather than dropping the key, so the fake may not either.
        reviewed: reviewedBlock(),
        ...overrides
    };
}

/**
 * The five SUMMARY GROUPS, built from `shared/phrase`'s own catalog so a test can never drift from the product
 * data (the five keys, titles, descriptions and composition order — and World rules is NOT one of them).
 *
 * The ids are readable, not random: a selection ref is `<prefix><id>`, and a test that asserts a ref
 * (`summary-group:grp-premise`) or a stale-ref fallback reads better with names than with uuids. It also pins
 * the invariant the redesign lives or dies on — the dashboard addresses a group by its id STRING, never by an
 * index or by the shape of the id, so the server's real uuids need no client-side parsing (U2).
 *
 * Defaults: every group written once with clean text, no findings, no open tasks, nothing unwritten. A test
 * overrides the rows it cares about (`groups: [...]`, `findings: [...]`) rather than reading a story out of a
 * fixture it cannot see.
 */
export function groupedPhraseView(storyId: string, overrides: Partial<PhraseView> = {}): PhraseView {
    const groups = orderedPhraseGroupDefinitions().map((definition, index) => ({
        id: `grp-${definition.key}`,
        key: definition.key,
        title: definition.title,
        description: definition.description,
        order: definition.order,
        content: `${definition.title} — the text the Writer installed (group ${index + 1}).`,
        revision: 1,
        updated_by: 'writer',
        previous_content: '',
        history: [
            {
                id: `rev-${definition.key}-1`,
                number: 1,
                state: 'latest',
                at: '2026-11-09T10:00:00.000Z',
                run_ref: 'run_1',
                finding_refs: [],
                task_refs: [],
                chars: 48,
                // D-67 — this book's ONE revision per group is the clean one: a cross-group Critic pass closed
                // on it with no unresolved defect, which is the only thing that makes it selectable into the
                // reviewed Summary. `SummaryGroupPane.test.tsx`'s clean-stamp case pins the badge and the
                // `(run run_clean_<key>)` title off exactly these two fields.
                clean: true,
                clean_run_ref: `run_clean_${definition.key}`
            }
        ],
        owed_by_findings: [] as string[],
        writer_busy: false,
        // T3 — the one pass that scored this book's vector, attached to every group. The rail prints the number
        // and the header prints their mean; `story-contract.ts:phraseOverallScore` stays silent if any is missing.
        scores: [scoreRow(LIVE_SCORE_VALUES[definition.key], LIVE_SCORE_HASH, LIVE_SCORE_AT)]
    }));

    // D-67 — the reviewed block for the cleanest grouped book the shell tests use: every group written ONCE, and
    // that one revision is clean, so the selection is COMPLETE and `ready` — which is what lets the Overview
    // pane offer the Author's choose (`SummaryOverviewPane.test.tsx`'s "drops nothing" case) and lets every other
    // shell test keep reading a grouped book without naming the reviewed state by hand.
    const cleanGroups = groups.map((group) =>
        reviewedGroup({
            id: group.id,
            key: group.key,
            selected_revision: group.revision,
            selected_id: group.history[0].id,
            latest_revision: group.revision,
            // The wire's join is the reviewed vector's hash, and on THIS book the clean vector IS the live
            // vector — one pass, one hash, so both reads report the same rows.
            scores: group.scores ?? []
        })
    );

    return phraseView(storyId, {
        mode: 'groups',
        phrase_id: 'phrase_summary_1',
        revision: 1,
        overview: groups.map((group) => group.content).join('\n\n'),
        groups,
        review: {
            mode: 'groups',
            unwritten_groups: [],
            written_groups: groups.length,
            vector: Object.fromEntries(groups.map((group) => [group.id, group.revision])),
            // The digest the Critic pass below scored (`LIVE_SCORE_HASH`) — the same hash on the score rows, so
            // the rail's number describes the text the read is showing (D-65's join, `projections.ts`).
            vector_hash: LIVE_SCORE_HASH,
            review_seats: 1,
            reviews_on_current_vector: 1,
            deep_reviews_on_current_vector: 1,
            open_findings: 0,
            blocking_findings: 0,
            open_tasks: 0,
            mirror: { summary_id: 'sum_1', in_sync: true, locked: false, fields: [] }
        },
        reviewed: reviewedBlock({
            state: 'ready',
            complete: true,
            vector: Object.fromEntries(groups.map((group) => [group.id, group.revision])),
            vector_hash: LIVE_SCORE_HASH,
            overview: groups.map((group) => group.content).join('\n\n'),
            groups: cleanGroups
        }),
        ...overrides
    });
}

/**
 * T-W4 — PHRASE ②'s read (`GET /stories/:id/phrases/plotlines`), the second entry surface.
 *
 * THE DEFAULT IS A STARTED, GROUPED PHRASE with three chapter entries, each written once, because that is the
 * frame every Phrase ② test starts from and the one a test then narrows (`mode:'classic'`, `groups: []`, a
 * `brief` that is still a draft). Like `groupedPhraseView`, the ids are readable rather than random: a rail ref
 * is `plotlines-group:entry-chapter_1`, and a test that asserts a ref or a stale-ref fallback reads better with
 * names than with uuids.
 *
 * WHAT IS DIFFERENT FROM THE SUMMARY'S READ, on purpose:
 *   - `key:'plotlines'` and `mode:'groups'|'classic'` (the Summary's off word is `sampling`);
 *   - NO `review.mirror` — R6's legacy `summaries` prose check is the Summary's, and Phrase ②'s downstream sync
 *     is the `plotlines` contract the entry rows already show;
 *   - `seed_head`/`seed_chars`, the copied Seed's prefix and true length (the pane prints them so the Author can
 *     recognise which text the phrase was started from);
 *   - `brief`, the structure decision the chapter entries were materialized from.
 * `scores` is absent on the entry rows: nothing in the loop scores a chapter contract the way a Reader pass
 * scores a Summary section, and an invented `0` would claim a review that never ran.
 */
export function phraseDetailView(storyId: string, overrides: Partial<PhraseDetailView> = {}): PhraseDetailView {
    const chapters = [1, 2, 3];
    const groups: PhraseGroupRow[] = chapters.map((n) => ({
        id: `entry-chapter_${n}`,
        key: `chapter_${n}`,
        title: `Chapter ${n} — The Salt Road`,
        description: `The ${n}${n === 1 ? 'st' : n === 2 ? 'nd' : 'rd'} chapter's contract: what it must happen, what must change.`,
        order: n,
        content:
            `## Chapter ${n} — The Salt Road\n` +
            `- Must happen: the crossing is attempted.\n` +
            `- Must change: the mentor's price is paid.`,
        revision: 1,
        updated_by: 'writer',
        previous_content: '',
        history: [
            {
                id: `rev-chapter_${n}-1`,
                number: 1,
                state: 'latest',
                at: '2026-11-09T10:00:00.000Z',
                run_ref: 'run_1',
                finding_refs: [],
                task_refs: [],
                chars: 96,
                clean: true,
                clean_run_ref: `run_clean_chapter_${n}`
            }
        ],
        owed_by_findings: [],
        writer_busy: false
    }));

    return {
        story_id: storyId,
        key: 'plotlines',
        mode: 'groups',
        phrase_id: 'phrase_plotlines_1',
        revision: 1,
        overview: groups.map((group) => group.content).join('\n\n'),
        groups,
        findings: [],
        tasks: [],
        review: {
            mode: 'groups',
            unwritten_groups: [],
            written_groups: groups.length,
            vector: Object.fromEntries(groups.map((group) => [group.id, group.revision])),
            vector_hash: 'plotlines-vector-1',
            review_seats: 0,
            reviews_on_current_vector: 0,
            deep_reviews_on_current_vector: 0,
            open_findings: 0,
            blocking_findings: 0,
            open_tasks: 0
        },
        reviewed: reviewedBlock(),
        seed_head: 'A smuggler pays the tide to cross the salt road, and the road collects.',
        seed_chars: 67,
        brief: { status: 'accepted', chapter_count: 3, accepted_at: '2026-11-09T10:00:00.000Z' },
        ...overrides
    };
}

/**
 * The D-67/D-68 reviewed frames the Summary tab branches on. `stale` and `writer_busy` are NOT wire states —
 * the wire's three are `pending` / `ready` / `chosen` — they are the two flag combinations the panes have to
 * render differently (`reviewed.stale` beside `state:'ready'`, and `reviewed.writer_busy` refusing the choose),
 * so the fixture names them to keep a test's intent legible.
 */
export type ReviewedFixtureState = 'pending' | 'ready' | 'chosen' | 'stale' | 'writer_busy';

// The three Ending texts, and the reason all three exist: the Summary tab's whole claim is that the LIVE
// Overview appears nowhere on it, and that is only an assertion when the live and reviewed texts are DIFFERENT
// texts (`SummaryOverviewPane.test.tsx`'s D-67 cases). `newest` is what the Writer installed and no pass closed;
// `clean` is the r2 the Reviewers passed; `chose` is the text the Author took.
const LIVE_ENDING_TEXT = 'Ending — the newest text the Writer installed, which no pass has closed on.';
const CLEAN_ENDING_TEXT = 'Ending — the clean text the Reviewers passed at Revision 2.';
const CHOSEN_TEXT_SUFFIX = ' — the text the Author chose.';

/** The vector the CLEAN selection is keyed by, and the numbers that judged it (D-67's join). */
const CLEAN_VECTOR_HASH = 'vh-clean-1';
const CLEAN_SCORE_AT = '2026-11-09T13:00:00.000Z';
const CLEAN_SCORE_VALUES: Record<string, number> = { premise: 79, promise: 71, theme: 66, tone: 83, ending: 62 };

/** The vector the AUTHOR's choice adopted. It differs from the clean one, which is the only reason `stale` is true. */
const CHOSEN_VECTOR_HASH = 'vh-chosen-1';
const CHOSEN_SCORE_AT = '2026-11-09T12:00:00.000Z';
const CHOSEN_AT = '2026-11-09T14:00:00.000Z';
const STALE_CHOSEN_AT = '2026-11-08T09:00:00.000Z';
const CHOSEN_SCORE_VALUES: Record<string, number> = { premise: 74, promise: 75, theme: 76, tone: 77, ending: 78 };

/** A partial selection still has a hash; it is the one thing no Reader row claims, so the strip prints no numbers. */
const PARTIAL_VECTOR_HASH = 'vh-partial';

/** One `PhraseRevisionRow`, so the two history lists below stay one-line and cannot drift from the wire's shape. */
function fixtureRevision(
    key: string,
    number: number,
    state: string,
    chars: number,
    clean: boolean,
    at: string
): PhraseGroupRow['history'][number] {
    return {
        id: `rev-${key}-${number}`,
        number,
        state,
        at,
        run_ref: `run_write_${key}_${number}`,
        finding_refs: [],
        task_refs: [],
        chars,
        clean,
        clean_run_ref: clean ? `run_clean_${key}` : null
    };
}

/**
 * The grouped book in ONE reviewed state — the fixture the D-67/D-68 pane, store, and contract tests share.
 *
 * It deliberately models the pair of numbers the feature exists to show: the Ending's newest revision (r3) is
 * NOT the clean one, so the selection stands at r2 while the book has moved past it. The live rows carry their
 * D-65 trend scores (`vh-9`: 84/76/70/88/66) and the reviewed rows carry the DIFFERENT numbers that judged the
 * clean vector (`vh-clean-1`: 79/71/66/83/62) — a wrong join therefore prints a visible wrong number rather than
 * a plausible one (`story-contract.groups.test.ts`'s D-67 join case).
 *
 * Each state also keeps the wire's own arithmetic, because the panes read the fields independently:
 *   - `ready` — complete selection, no choice, no writer, no blocking issue;
 *   - `stale` — the SAME ready selection plus a recorded choice on a different hash (`stale` is a flag beside
 *     `state:'ready'`, never a third state — see `story-contract.ts:reviewedChooseRefusal`);
 *   - `chosen` — the choice record is the only reviewed Summary the book has: the installed rows carry no clean
 *     stamp, so the live selection is empty and the pane must read the numbers off the CHOICE (D-68);
 *   - `pending` — a PARTIAL selection (Premise r2 and Ending r1 are in, three groups are not), each missing
 *     group for a different reason, and one unresolved issue holding a clean verdict back;
 *   - `writer_busy` — `ready` while a live Writer pass holds the Ending group, the state the choose refuses on
 *     (R4: the same read the route's 409 answers with).
 */
export function reviewedPhraseView(storyId: string, state: ReviewedFixtureState = 'ready'): PhraseView {
    const base = groupedPhraseView(storyId);
    const byKey = new Map(base.groups.map((group) => [group.key, group]));

    /** The five reviewed rows for a complete selection: every group clean at r1, the Ending one revision old. */
    const cleanSelection = (groups: PhraseGroupRow[]): PhraseReviewedGroup[] =>
        groups.map((group) =>
            reviewedGroup({
                id: group.id,
                key: group.key,
                selected_revision: group.key === 'ending' ? 2 : group.revision,
                selected_id: group.key === 'ending' ? `rev-ending-2` : `rev-${group.key}-1`,
                latest_revision: group.revision,
                superseded: group.key === 'ending',
                scores: [scoreRow(CLEAN_SCORE_VALUES[group.key], CLEAN_VECTOR_HASH, CLEAN_SCORE_AT)]
            })
        );

    /** The clean Overview: the four installed groups, and the Ending's CLEAN r2 — never the live r3 text. */
    const cleanOverview = (groups: PhraseGroupRow[]): string =>
        groups.map((group) => (group.key === 'ending' ? CLEAN_ENDING_TEXT : group.content)).join('\n\n');

    /** The chosen Overview, recomposed from the rows the choice names (D-68). */
    const chosenOverview = (groups: PhraseGroupRow[]): string =>
        groups.map((group) => `${group.title}${CHOSEN_TEXT_SUFFIX}`).join('\n\n');

    const chosenRecord = (groups: PhraseGroupRow[], at: string) => ({
        vector: Object.fromEntries(groups.map((group) => [group.id, 1])),
        vector_hash: CHOSEN_VECTOR_HASH,
        at,
        overview: chosenOverview(groups),
        scores: Object.fromEntries(
            groups.map((group) => [
                group.id,
                [scoreRow(CHOSEN_SCORE_VALUES[group.key], CHOSEN_VECTOR_HASH, CHOSEN_SCORE_AT)]
            ])
        )
    });

    // ── `pending` — the mid-review book: partial selection, four different waits, one unresolved issue ──
    if (state === 'pending') {
        const groups = base.groups.map((group) =>
            group.key === 'premise'
                ? {
                      ...group,
                      revision: 2,
                      // r2 is the text a cross-group pass closed on; r1 predates the fix and never passed, which
                      // is why the selection names r2 and the history keeps both (R2's retained history).
                      history: [
                          fixtureRevision('premise', 2, 'latest', 52, true, '2026-11-09T11:30:00.000Z'),
                          { ...fixtureRevision('premise', 1, 'archived', 48, false, '2026-11-09T10:00:00.000Z'), clean_run_ref: `run_clean_premise`, clean: false }
                      ]
                  }
                : group
        );
        const idOf = (key: string): string => byKey.get(key)?.id ?? `grp-${key}`;
        const reviewedGroups = groups.map((group) => {
            if (group.key === 'premise' || group.key === 'ending') {
                return reviewedGroup({
                    id: group.id,
                    key: group.key,
                    selected_revision: group.revision,
                    selected_id: group.history[0].id,
                    latest_revision: group.revision
                });
            }

            if (group.key === 'promise') {
                // Written, never passed, and an unresolved ISSUE names it — the wait the Author can act on.
                return reviewedGroup({
                    id: group.id,
                    key: group.key,
                    selected_revision: null,
                    selected_id: null,
                    clean_run_ref: null,
                    latest_revision: group.revision,
                    issues_open: true,
                    gap: 'no_clean_revision'
                });
            }

            if (group.key === 'theme') {
                return reviewedGroup({
                    id: group.id,
                    key: group.key,
                    selected_revision: null,
                    selected_id: null,
                    clean_run_ref: null,
                    latest_revision: group.revision,
                    gap: 'unwritten'
                });
            }

            // Tone is written and clean-less with nothing open on it — the plain "awaiting a clean pass".
            return reviewedGroup({
                id: group.id,
                key: group.key,
                selected_revision: null,
                selected_id: null,
                clean_run_ref: null,
                latest_revision: group.revision,
                gap: 'no_clean_revision'
            });
        });

        return phraseView(storyId, {
            ...base,
            story_id: storyId,
            groups,
            findings: [
                {
                    id: 'f-clean-block',
                    title: 'the promise names a cost the premise never sets up',
                    cost: 'major',
                    // An ISSUE, not a proposal: only an issue holds a clean verdict back (D-67).
                    kind: 'issue',
                    state: 'confirmed',
                    seen_count: 2,
                    group_refs: [idOf('promise')],
                    unscoped: false,
                    targeted: [idOf('promise')],
                    resolved: [],
                    missing: [idOf('promise')],
                    resolved_all: false
                }
            ],
            review: { ...base.review, open_findings: 1, blocking_findings: 1 },
            reviewed: reviewedBlock({
                state: 'pending',
                complete: false,
                // A partial selection still names the groups it HAS (Premise r2, Ending r1).
                vector: { [idOf('premise')]: 2, [idOf('ending')]: 1 },
                vector_hash: PARTIAL_VECTOR_HASH,
                // `''` while the selection is partial — the rule that keeps the live Overview off the tab.
                overview: '',
                groups: reviewedGroups,
                blocking_issues: [
                    {
                        id: 'f-clean-block',
                        title: 'the promise names a cost the premise never sets up',
                        cost: 'major',
                        group_keys: ['promise']
                    }
                ]
            })
        });
    }

    // ── `chosen` — the Author took the Summary; the installed rows carry no clean stamp ──────────────
    if (state === 'chosen') {
        const groups = base.groups.map((group) => ({
            ...group,
            // The choose installs the chosen text, so it IS the live text here — and a `discarded` row is
            // hidden from `history` (D-68), which is why the list is the one row that stands.
            content: `${group.title}${CHOSEN_TEXT_SUFFIX}`,
            // Installed, not reviewed: nobody has re-read the text the choose just wrote, so the clean verdicts
            // are gone and the live selection is empty. The strip reads the CHOICE record instead.
            history: [{ ...group.history[0], clean: false, clean_run_ref: null }],
            previous_content: '',
            scores: group.scores
        }));

        return phraseView(storyId, {
            ...base,
            story_id: storyId,
            groups,
            overview: chosenOverview(groups),
            reviewed: reviewedBlock({
                state: 'chosen',
                complete: false,
                vector: {},
                vector_hash: CHOSEN_VECTOR_HASH,
                overview: '',
                groups: groups.map((group) =>
                    reviewedGroup({
                        id: group.id,
                        key: group.key,
                        selected_revision: null,
                        selected_id: null,
                        clean_run_ref: null,
                        latest_revision: group.revision,
                        gap: 'no_clean_revision'
                    })
                ),
                chosen: chosenRecord(groups, CHOSEN_AT)
            })
        });
    }

    // ── `ready` / `stale` / `writer_busy` — one complete selection, three differences beside it ──────
    const groups = base.groups.map((group) =>
        group.key === 'ending'
            ? {
                  ...group,
                  content: LIVE_ENDING_TEXT,
                  revision: 3,
                  // r3 replaced the clean r2, and r2's body is the one older text the wire still sends.
                  previous_content: CLEAN_ENDING_TEXT,
                  history: [
                      fixtureRevision('ending', 3, 'latest', 76, false, '2026-11-09T12:30:00.000Z'),
                      fixtureRevision('ending', 2, 'archived', 60, true, '2026-11-09T11:00:00.000Z'),
                      fixtureRevision('ending', 1, 'archived', 48, false, '2026-11-09T10:00:00.000Z')
                  ],
                  // R4 — the Writer holding the group is the state `writer_busy` refuses the choose on, and the
                  // SAME read the revise/choose routes 409 with (`phrase/exclusion.ts`).
                  writer_busy: state === 'writer_busy'
              }
            : group
    );
    const vector = Object.fromEntries(
        groups.map((group) => [group.id, group.key === 'ending' ? 2 : group.revision])
    );

    return phraseView(storyId, {
        ...base,
        story_id: storyId,
        groups,
        overview: groups.map((group) => group.content).join('\n\n'),
        reviewed: reviewedBlock({
            state: 'ready',
            complete: true,
            vector,
            vector_hash: CLEAN_VECTOR_HASH,
            overview: cleanOverview(groups),
            groups: cleanSelection(groups),
            // `stale` is the flag beside `state:'ready'` that renames the verb: a choice on an OLDER hash.
            chosen: state === 'stale' ? chosenRecord(groups, STALE_CHOSEN_AT) : null,
            stale: state === 'stale',
            writer_busy: state === 'writer_busy'
        })
    });
}

/**
 * The client double. Every method is a `vi.fn` so an unexpected call is loud, and every
 * default is a resolved value so a refresh-after-mutation (which `state.ts` always does)
 * never hangs a test.
 */
export function fakeApi(overrides: Partial<ApiClient> = {}): ApiClient {
    // S-5 — the fake keeps the ceiling the way the engine does: the PATCH sets it and `GET /loop`
    // reports it, so a test that writes through `setLoopLimit` can assert the control re-renders from
    // the value the server now holds rather than from the value that was typed.
    let globalMaxConcurrent = 4;

    const base: ApiClient = {
        listStories: vi.fn(async () => [] as StoryRow[]),
        createStory: vi.fn(async (input) => storyRow('story_new', { title: input.title })),
        deleteStory: vi.fn(async (storyId: string) => ({ deleted: storyId })),
        getStory: vi.fn(async (storyId) => storyView(storyRow(storyId))),
        // R6 — the phrase read is a SEPARATE route from `getStory`, and the store caches it separately
        // (`snapshot.phrases`). The default is the sampling echo, so a test that never mentions groups sees the
        // desk it saw before this read existed; a grouped test overrides it.
        getPhrase: vi.fn(async (storyId) => phraseView(storyId)),
        // R2 — the Author's rewrite of ONE group. The result carries the fresh `view`, which is what the store
        // commits immediately (one phrases fetch per mutation, so a test can count the calls).
        revisePhraseGroup: vi.fn(
            async (storyId: string, groupId: string, input): Promise<PhraseGroupReviseResult> => ({
                story_id: storyId,
                phrase_id: 'phrase_summary_1',
                revision: 2,
                installed: [{ group_id: groupId, group_key: 'premise', revision_id: `rev-${groupId}-2`, number: 2 }],
                archived: [{ group_id: groupId, group_key: 'premise', revision_id: `rev-${groupId}-1`, number: 1 }],
                mirror: { summary_id: 'sum_1', fields: ['premise'], written: true },
                view: groupedPhraseView(storyId)
            })
        ),
        // R1 — the two lock verbs, defaulted on the revise route's convention: the result carries the
        // refreshed `view` with THIS group's lock fields moved, which is what `state.ts:groupLockWrite`
        // commits. A test that wants a refusal overrides these with a rejecting `vi.fn` (a 409), so the
        // pane's refusal line is pinned against the same shape the server sends.
        lockPhraseGroup: vi.fn(
            async (storyId: string, groupId: string): Promise<PhraseGroupLockResult> => ({
                story_id: storyId,
                phrase_id: 'phrase_summary_1',
                group_id: groupId,
                locked: true,
                locked_revision: 1,
                locked_by: 'author',
                locked_at: '2026-11-09T10:00:00.000Z',
                view: groupedPhraseView(storyId, {
                    groups: groupedPhraseView(storyId).groups.map((group) =>
                        group.id === groupId
                            ? {
                                  ...group,
                                  locked: true,
                                  locked_revision: group.revision,
                                  locked_by: 'author' as const,
                                  locked_at: '2026-11-09T10:00:00.000Z'
                              }
                            : group
                    )
                })
            })
        ),
        unlockPhraseGroup: vi.fn(
            async (storyId: string, groupId: string): Promise<PhraseGroupLockResult> => ({
                story_id: storyId,
                phrase_id: 'phrase_summary_1',
                group_id: groupId,
                locked: false,
                locked_revision: null,
                locked_by: null,
                locked_at: null,
                view: groupedPhraseView(storyId)
            })
        ),
        // T-W4 — PHRASE ②'s read, on the same convention as `getPhrase`: a SEPARATE route with its own cache slot
        // (`snapshot.phraseDetails`), so the default is the plain read and a Phrase ② test overrides it
        // (`fakeApi({ getPhraseDetail: vi.fn(async () => phraseDetailView('s1', {…})) })`).
        getPhraseDetail: vi.fn(async (storyId) => phraseDetailView(storyId)),
        // T-W4 — the on-demand start. The default answers the COMPILED arm (what the handoff button sends) with the
        // started phrase read, which is what `state.ts:startPhrase` commits straight away; a test that wants the
        // 409 (already started / no compiled Summary / empty custom text) overrides this with a rejecting `vi.fn`,
        // so the refusal line is pinned against the sentence the server actually sends.
        startPhrase: vi.fn(
            async (storyId: string, key: string, input): Promise<PhraseStartResult> => ({
                story_id: storyId,
                phrase_id: 'phrase_plotlines_1',
                key,
                source: input?.source === 'custom' ? 'custom' : 'compiled',
                seed_chars: 67,
                seed_head:
                    input?.source === 'custom'
                        ? (input.text ?? '')
                        : 'A smuggler pays the tide to cross the salt road, and the road collects.',
                started: { phrase_id: 'phrase_plotlines_1', key, started_at: '2026-11-09T10:00:00.000Z' },
                // R11 — THE TWO POINTER FIELDS ARE ON THE WIRE, so the fake that stands in for the route has to
                // carry them too. This one never moves the crew (the book's Summary is not signed off in any
                // fixture), and the reason is the SERVER'S OWN sentence, character for character, so a desk test
                // that renders it under a successful start is rendering what the route would print (L-13).
                phase_opened: false,
                phase_open_reason: `the Summary is not signed off, so the crew stays on Phrase ①: POST /stories/${storyId}/lock is the act that signs phase summary off and opens phase plotlines (L-33: a phase is entered only with every earlier phase locked)`,
                view: phraseDetailView(storyId)
            })
        ),
        // R7 — the one-time Seed cleanup. THE DEFAULT IS "NOTHING TO FIX": the pass answers the Author's own draft
        // back unchanged (`changed:false`), which is the one proposal arm every fixture can render without
        // pretending a rewrite happened. A test that wants a real proposal, or a guard refusal, overrides this with
        // its own `vi.fn` — the same shape as `startPhrase`'s 409 arms.
        getPhraseSeedCleanup: vi.fn(
            async (storyId: string, key: string, seed: string): Promise<SeedCleanupProposal> => ({
                ok: true,
                // THE REAL HASH, not a stand-in: the desk compares it against the draft in the Seed box to prove a
                // proposal belongs to the text it was computed over, so a fake that invented one would hide a
                // mismatch. `shared/seed-hash.ts` is the browser-side module the desk itself dials.
                source_hash: seedHashOf(seed),
                text: seed,
                changed: false
            })
        ),
        // T-W4 — ONE CHAPTER ENTRY's hand revision: the revise envelope, but with the PHRASE ② read as `view`
        // (`routes.ts:phraseVerbView` answers the phrase that was written, never the Summary by default).
        revisePhraseEntry: vi.fn(
            async (storyId: string, groupId: string): Promise<PhraseEntryReviseResult> => ({
                story_id: storyId,
                phrase_id: 'phrase_plotlines_1',
                revision: 2,
                installed: [
                    { group_id: groupId, group_key: 'chapter_1', revision_id: `rev-${groupId}-2`, number: 2 }
                ],
                archived: [
                    { group_id: groupId, group_key: 'chapter_1', revision_id: `rev-${groupId}-1`, number: 1 }
                ],
                mirror: { summary_id: null, fields: [], written: false, reason: 'no_summary' },
                view: phraseDetailView(storyId)
            })
        ),
        // D-68 — the Author's whole-Summary choose. The default answers what the route answers: the install
        // report plus the REFRESHED read, which the projection reports as `state:'chosen'` (the rows the choose
        // installed carry no clean stamp). `state.ts` commits that `view` and then re-reads, so a test asserting
        // the frame is asserting the read, not this echo.
        choosePhraseReviewed: vi.fn(
            async (storyId: string): Promise<PhraseReviewedChooseResult> => {
                const phrase = reviewedPhraseView(storyId, 'chosen');

                return {
                    story_id: storyId,
                    phrase_id: 'phrase_summary_1',
                    revision: 7,
                    vector: Object.fromEntries(phrase.groups.map((group) => [group.id, 1])),
                    vector_hash: CHOSEN_VECTOR_HASH,
                    at: CHOSEN_AT,
                    overview: phrase.reviewed.chosen?.overview ?? '',
                    installed: phrase.groups.map((group) => ({
                        group_id: group.id,
                        group_key: group.key,
                        revision_id: `rev-${group.key}-1`,
                        number: 1
                    })),
                    // The Ending's r3 is the text the clean r2 selection passed over — the drop the pane names.
                    discarded: [
                        { group_id: 'grp-ending', group_key: 'ending', revision_id: 'rev-ending-3', number: 3 }
                    ],
                    sources: phrase.groups.map((group) => ({
                        group_id: group.id,
                        group_key: group.key,
                        source_revision: 1,
                        source_id: `rev-${group.key}-1`,
                        installed_revision: 1
                    })),
                    mirror: {
                        summary_id: 'sum_1',
                        fields: phrase.groups.map((group) => group.key),
                        written: true
                    },
                    view: phrase
                };
            }
        ),
        getStoryKnowledge: vi.fn(async (storyId) => ({
            story_id: storyId,
            story_title: storyRow(storyId).title,
            sections: [],
            degraded: false
        })),
        listAgents: vi.fn(async () => [
            {
                kind: 'writer',
                title: 'Writer',
                status: 'idle' as const,
                rank: 'A' as const,
                model: 'local/basalt',
                model_source: 'default' as const,
                template_models: [],
                working: [],
                recent: []
            },
            {
                kind: 'editor',
                title: 'Editor',
                status: 'idle' as const,
                rank: 'A' as const,
                model: 'local/basalt',
                model_source: 'default' as const,
                template_models: [],
                working: [],
                recent: []
            },
            {
                kind: 'reader',
                title: 'Reader',
                status: 'idle' as const,
                rank: 'A' as const,
                model: 'local/basalt',
                model_source: 'default' as const,
                template_models: [],
                working: [],
                recent: []
            },
            {
                kind: 'checker',
                title: 'Checker',
                status: 'idle' as const,
                rank: 'A' as const,
                model: 'local/basalt',
                model_source: 'default' as const,
                template_models: [],
                working: [],
                recent: []
            },
            // The fifth roster row (documents/phase-1-research-pipeline.md §3.1): `GET /agents`
            // answers five employees, so the panel tests must cover five tiles, not four.
            {
                kind: 'researcher',
                title: 'Researcher',
                status: 'idle' as const,
                rank: 'A' as const,
                model: 'local/basalt',
                model_source: 'default' as const,
                template_models: [],
                working: [],
                recent: []
            }
        ]),
        // U-8 — the provider catalog the roster dropdown offers.
        listAgentModels: vi.fn(async () => ({
            base_url: 'http://localhost:8800/providers/private/v1',
            models: ['local/basalt']
        })),
        // U-8 — the tile-opened thread surface: empty until a test names the threads it wants.
        listAgentThreads: vi.fn(async (kind: string) => ({ kind, threads: [] })),
        // U-8 — the model write answers the refreshed roster, exactly like the route.
        setAgentModel: vi.fn(async (kind: string, model: string | null) => [
            {
                kind,
                title: kind,
                status: 'idle' as const,
                rank: 'A' as const,
                model: model ?? 'local/basalt',
                model_source: model === null ? ('default' as const) : ('agent' as const),
                template_models: [],
                working: [],
                recent: []
            }
        ]),
        // S-5 — the loop's ceiling: the PATCH sets the number, and both reads report it. `live_runs`
        // stays 0 because the thread fixtures live on the agent rows, not on run rows.
        getLoopSettings: vi.fn(async () => ({ global_max_concurrent: globalMaxConcurrent, live_runs: 0 })),
        setGlobalMaxConcurrent: vi.fn(async (limit: number) => {
            globalMaxConcurrent = limit;

            return { global_max_concurrent: limit, live_runs: 0 };
        }),
        patchStory: vi.fn(async (storyId) => storyRow(storyId)),
        stop: vi.fn(async (storyId) => storyRow(storyId, { status: 'stopped' })),
        resume: vi.fn(async (storyId) => storyRow(storyId, { status: 'ready' })),
        clearPending: vi.fn(async (storyId) => storyRow(storyId, { status: 'ready', pending_kind: 'none' })),
        lockPhase: vi.fn(async (storyId) => storyRow(storyId, { status: 'ready', pending_kind: 'none' })),
        backtrack: vi.fn(async (storyId) => storyRow(storyId)),
        approveFinding: vi.fn(async (storyId) => storyRow(storyId)),
        discardFinding: vi.fn(async (storyId) => storyRow(storyId)),
        selectIdea: vi.fn(async (storyId) => storyRow(storyId)),
        discardIdea: vi.fn(async (storyId) => storyRow(storyId)),
        deferIdea: vi.fn(async (storyId) => storyRow(storyId)),
        editSection: vi.fn(async (storyId) => storyRow(storyId)),
        unapproveChapter: vi.fn(async (storyId) => storyRow(storyId)),
        // U-10b — the chapter's whole approval (api/routes.ts's `findings/approve-all`).
        approveChapterFindings: vi.fn(async (storyId) => storyRow(storyId)),
        acceptProposal: vi.fn(async (storyId) => storyRow(storyId)),
        rejectProposal: vi.fn(async (storyId) => storyRow(storyId)),
        undo: vi.fn(async (storyId) => storyRow(storyId)),
        // U-13 / D-24 and U-13a / D-23 — the Author's two revision verbs. Both answer with the
        // refreshed stories-row, which is the shape the real routes return.
        selectRevisionAuthor: vi.fn(async (storyId) => storyRow(storyId)),
        mergeRevisions: vi.fn(async (storyId) => storyRow(storyId)),
        requestSummaryRevision: vi.fn(async (storyId) => storyRow(storyId)),
        sendDirective: vi.fn(async (storyId) => storyRow(storyId)),
        acceptCompletion: vi.fn(async (storyId) => storyRow(storyId, { status: 'completed' })),
        assignTemplates: vi.fn(async (storyId) => storyRow(storyId)),
        patchGoal: vi.fn(async (storyId) => storyView(storyRow(storyId)).goal),
        setChapterBar: vi.fn(async (storyId) => storyRow(storyId)),
        listTemplates: vi.fn(async () => []),
        createTemplate: vi.fn(async () => ({}) as never),
        patchTemplate: vi.fn(async () => ({}) as never),
        listRuns: vi.fn(async () => []),
        killRun: vi.fn(async () => ({}) as never),
        getQueue: vi.fn(async () => [] as QueueItem[]),
        requestAssistant: vi.fn(async () => ({}) as never),
        // The stream is inert in tests: a poll would tick during assertions.
        subscribeEvents: vi.fn(() => () => undefined)
    };
    return { ...base, ...overrides };
}

/**
 * A store over the double, seeded with the rows and queue items a test describes. It hands
 * back the client too, so a test asserts the CALL the UI made rather than a rendered artefact
 * for the write paths — the pinned T7 contract is the method call.
 */
export function fakeHarness(rows: StoryRow[], queue: QueueItem[] = [], overrides: Partial<ApiClient> = {}) {
    const client = fakeApi({
        listStories: vi.fn(async () => rows),
        getQueue: vi.fn(async () => queue),
        getStory: vi.fn(async (storyId) => storyView(rows.find((row) => row.id === storyId) ?? storyRow(storyId))),
        ...overrides
    });
    return { client, store: createDashboardStore(client) };
}

/** Render inside the store's context — the only wrapper a shell component needs. */
export function renderWithStore(ui: ReactNode, store: DashboardStore) {
    return render(<DashboardContext.Provider value={store}>{ui}</DashboardContext.Provider>);
}

/**
 * The one helper the shell tests use: build the harness, load the first read BEFORE mounting
 * (so the first paint already has the rows the test describes), and mount inside `act` so the
 * store's post-write refresh chain settles without React warnings.
 */
export async function renderShell(
    ui: ReactNode,
    rows: StoryRow[] = [],
    queue: QueueItem[] = [],
    overrides: Partial<ApiClient> = {},
    openStoryId?: string
) {
    const harness = fakeHarness(rows, queue, overrides);
    await harness.store.reload();
    // A test that needs THE STORY region mounted selects the Story before mounting, so the
    // first paint is already the selected state rather than a click mid-assertion.
    if (openStoryId) {
        await harness.store.openStory(openStoryId);
    }
    let view!: ReturnType<typeof render>;
    await act(async () => {
        view = renderWithStore(ui, harness.store);
    });
    return { ...harness, ...view };
}

/** Clicks a control and lets every write + refetch the store fires afterwards settle. */
export async function click(element: Element): Promise<void> {
    await act(async () => {
        fireEvent.click(element);
        await Promise.resolve();
        await Promise.resolve();
    });
}

/** Types into a field the way a keyboard does, then settles the store. */
export async function type(element: HTMLElement, value: string): Promise<void> {
    await act(async () => {
        fireEvent.change(element, { target: { value } });
        await Promise.resolve();
    });
}
