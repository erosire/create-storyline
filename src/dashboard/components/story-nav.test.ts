// Phase ①'s flat revision history: Revision 1…N, no Overview tree.
//
// The rules pinned here are the ones the rail cannot guess:
//   - revisions are numbered in creation order, not grouped by sampling attempt;
//   - a Reader finding is filed against the revision it names in `related_refs`;
//   - the selected revision is the one the Summary row carries;
//   - the tick waits for the round to have a winner and for critical/major work to be gone.
import { describe, expect, it } from 'vitest';
import { fixtureReviewRuns, fixtureView } from './story-fixtures';
import { lockCheck } from './story-contract';
import type { StoryViewData } from './story-contract';
// The wire slice (`api.ts:SamplingView`), typed so a fixture cannot quietly drop the in-flight round
// number the supersession comparison now reads (T12/P1).
import type { SamplingView } from '../api';
import {
    selectedSummaryRevision,
    storyAttention,
    summaryReadyForReview,
    summaryRevisionFocus,
    summaryRevisions,
    summaryRevisionUnit
} from './story-nav';
import type { Finding, Revision, Verdict } from '../../shared/types';

const DRAFT = (id: string, created: string, extra: Partial<Revision> = {}): Revision => ({
    id,
    rev: 1,
    created_at: created,
    updated_at: created,
    story_id: 's1',
    unit_kind: 'summary',
    unit_ref: 'sum1',
    body: { fields: { premise: id, tone: 'the installed voice' } },
    run_ref: `run_${id}`,
    template_ref: 't-builtin',
    state: 'competing',
    verdict_refs: [],
    ...extra
});

const FINDING = (id: string, related: string, cost: Finding['cost'] = 'major'): Finding => ({
    id,
    rev: 1,
    created_at: '2026-11-11T11:05:00.000Z',
    updated_at: '2026-11-11T11:05:00.000Z',
    story_id: 's1',
    target_ref: 'sum1',
    criterion_ref: 'C-14',
    title: `${id} on ${related}`,
    evidence: 'the page says so',
    cost,
    fingerprint: `fp-${id}`,
    state: 'confirmed',
    seen_count: 1,
    related_refs: [related]
});

const VERDICT = (id: string, target: string, findingRef?: string): Verdict => ({
    id,
    rev: 1,
    created_at: '2026-11-11T11:06:00.000Z',
    updated_at: '2026-11-11T11:06:00.000Z',
    story_id: 's1',
    target_ref: target,
    target_kind: 'revision',
    run_ref: 'run_reader',
    template_ref: 't-reader',
    round: 1,
    criteria_passed: [
        {
            criterion: 'C-14',
            result: findingRef === undefined,
            evidence: 'seed vs draft',
            ...(findingRef === undefined ? {} : { finding_ref: findingRef })
        }
    ],
    hard_pass: findingRef === undefined,
    soft_count: 0,
    recommendation: 'fix'
});

describe('summaryRevisions — Phase ① is a flat Revision 1…N list', () => {
    it('numbers every round in creation order and files findings against one revision only', () => {
        const view = fixtureView();
        const first = DRAFT('revision_a', '2026-11-11T11:01:00.000Z', { state: 'discarded' });
        const second = DRAFT('revision_b', '2026-11-11T11:02:00.000Z', { state: 'discarded' });
        const third = DRAFT('revision_c', '2026-11-11T11:03:00.000Z', { state: 'selected' });
        const fourth = DRAFT('revision_d', '2026-11-11T11:04:00.000Z');

        const revisions = summaryRevisions({
            ...view,
            revisions: [third, first, fourth, second],
            findings: [FINDING('f-one', 'revision_a'), FINDING('f-two', 'revision_b')],
            verdicts: [
                VERDICT('v-one', 'revision_a', 'f-one'),
                VERDICT('v-two', 'revision_b', 'f-two')
            ]
        });

        expect(revisions.map((entry) => [entry.index, entry.revision.id])).toEqual([
            [1, 'revision_a'],
            [2, 'revision_b'],
            [3, 'revision_c'],
            [4, 'revision_d']
        ]);
        expect(revisions[0]?.findings.map((finding) => finding.id)).toEqual(['f-one']);
        expect(revisions[1]?.findings.map((finding) => finding.id)).toEqual(['f-two']);
        expect(revisions[2]?.findings).toEqual([]);
        expect(selectedSummaryRevision({ ...view, revisions: [first, third, fourth] })?.id).toBe('revision_c');
    });

    it('opens the revision named by the rail ref', () => {
        const view = { ...fixtureView(), revisions: [DRAFT('revision_a', '2026-11-11T11:01:00.000Z')] };
        const entry = summaryRevisionFocus(view, { panel: 'summary', ref: 'revision:revision_a' });

        expect(entry?.index).toBe(1);
        expect(summaryRevisionFocus(view, { panel: 'summary', ref: 'revision:missing' })).toBeUndefined();
    });

    it('does not tick the Summary while a round is competing or a critical/major finding is open', () => {
        const view = {
            ...fixtureView(),
            story: { ...fixtureView().story, phase: 'summary' as const, summary_locked: false },
            goal: { ...fixtureView().goal, failing: [] }
        };
        const competing = {
            ...view,
            revisions: [DRAFT('revision_a', '2026-11-11T11:01:00.000Z')]
        };

        expect(summaryReadyForReview(competing)).toBe(false);

        const selected = {
            ...view,
            revisions: [
                DRAFT('revision_a', '2026-11-11T11:01:00.000Z', { state: 'selected' }),
                DRAFT('revision_b', '2026-11-11T11:02:00.000Z', { state: 'discarded' })
            ],
            findings: [FINDING('f-one', 'revision_a')]
        };

        expect(summaryReadyForReview(selected)).toBe(false);

        const clean = {
            ...selected,
            findings: [FINDING('f-one', 'revision_a', 'minor')]
        };

        expect(summaryReadyForReview(clean)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// T5 / R3 — one attribution decision, three readers of it.
//
// The rail's badge, the Summary pane's per-revision list, the rail's review tick and the Accept gate all
// answer "does this finding speak about this revision?". While they each carried their own rule, a
// whole-artifact finding (the legacy `target_ref`-only spelling, which the server still treats as
// blocking) made the gate say "1 critical/major finding still open" while the opened revision said "No
// Reader findings on this revision yet". Every case below pins BOTH answers of one pair.
// ---------------------------------------------------------------------------

/**
 * Phase ① with every REAL gate clean apart from the facts a case adds: Goal passing, the phase's tray
 * decided, the round settled on one `selected` draft, that round's five deep-review passes CLOSED, and the
 * sampling slice naming the round the drafts belong to (T11/F1).
 *
 * The closed `wi_review_revision_sel_a1…a5` rows are not decoration: `runs` is a required, uncapped
 * slice, so a projection without them is an UNREAD Summary and the gate owes every pass. A case that is
 * about the review says so by overriding `runs` itself.
 */
function phase1(overrides: Partial<StoryViewData> = {}): StoryViewData {
    const view = fixtureView();

    return {
        ...view,
        story: { ...view.story, phase: 'summary', summary_locked: false, auto_approve: [] },
        goal: { ...view.goal, failing: [] },
        ideas: [],
        revisions: SETTLED_ROUND(),
        runs: fixtureReviewRuns('revision_sel'),
        // T12/P1: both round numbers. Round 1 is the round whose selection closed (the deep review is owed
        // for it), and round 2 is the one in flight (what supersession is measured against).
        sampling: { round: 1, active_round: 2, history: [] } satisfies SamplingView,
        ...overrides
    };
}

/** The settled round: Revision 1 discarded, Revision 2 the Summary on record. */
const SETTLED_ROUND = (): Revision[] => [
    DRAFT('revision_old', '2026-11-11T11:01:00.000Z', { state: 'discarded', round: 1 }),
    DRAFT('revision_sel', '2026-11-11T11:03:00.000Z', { state: 'selected', round: 1 })
];

/**
 * The slice of a round that has NOT settled (T12/P1): nothing has completed, so the in-flight round IS
 * round 1 and its drafted samples are live work. `phase1`'s baseline says round 1 CLOSED, so a fixture
 * that overrides the drafts without overriding the slice is describing an older round's leftovers.
 */
const ROUND_ONE_IN_FLIGHT = { round: 1, active_round: 1, history: [] } satisfies SamplingView;

/**
 * The whole-artifact spelling: `target_ref` is the Summary and NO `related_refs` names a draft — what a
 * legacy row, and phase ①'s whole-Summary critique, look like (`records.ts:summaryBlockingFindings`'s
 * target-only clause keeps it blocking the final choice).
 */
const WHOLE_ARTIFACT_FINDING = (
    id: string,
    cost: Finding['cost'] = 'critical',
    state: Finding['state'] = 'confirmed'
): Finding => ({ ...FINDING(id, 'unused'), cost, state, related_refs: undefined });

describe('summaryRevisions — the pane and the Accept gate decide the same thing about the same finding (T5)', () => {
    it('lists on the selected Revision the whole-artifact finding that disables Accept', () => {
        const view = phase1({
            revisions: SETTLED_ROUND(),
            findings: [WHOLE_ARTIFACT_FINDING('f-legacy')],
            verdicts: []
        });

        // The pane's list: a whole-artifact row is every revision of that unit's business, so the opened
        // (and selected) Revision cannot read "No Reader findings on this revision yet".
        const listed = summaryRevisions(view).map((entry) => ({
            index: entry.index,
            revision: entry.revision.id,
            findings: entry.findings.map((finding) => finding.id)
        }));

        expect(listed).toEqual([
            { index: 1, revision: 'revision_old', findings: ['f-legacy'] },
            { index: 2, revision: 'revision_sel', findings: ['f-legacy'] }
        ]);

        // The gate: the SAME row is the blocker, named exactly once, with no Editor-choice language.
        expect(lockCheck(view)).toEqual({
            phase: 'summary',
            canLock: false,
            reasons: [
                '1 critical/major finding on the selected Summary awaiting your approval — nothing is queued until the Author decides (D-34)'
            ],
            statement:
                'Locking the Summary makes it read-only for every agent (P5, L-30) and deletes this phase\u2019s Ideas tray in the same commit (D-36).'
        });

        // The rail's tick reads the same predicate, so it never claims readiness over the blocker.
        expect(summaryReadyForReview(view)).toBe(false);
    });

    it('keeps a finding aimed at another Revision off both the selected Revision and the gate', () => {
        const view = phase1({
            revisions: SETTLED_ROUND(),
            findings: [FINDING('f-old', 'revision_old')],
            verdicts: []
        });

        expect(summaryRevisions(view).map((entry) => [entry.index, entry.findings.map((finding) => finding.id)])).toEqual([
            [1, ['f-old']],
            [2, []]
        ]);
        expect(lockCheck(view)).toEqual({
            phase: 'summary',
            canLock: true,
            reasons: [],
            statement:
                'Locking the Summary makes it read-only for every agent (P5, L-30) and deletes this phase\u2019s Ideas tray in the same commit (D-36).'
        });
        expect(summaryReadyForReview(view)).toBe(true);
    });

    it('pairs the draft-scoped blocker the same way: listed on its own Revision, nowhere else', () => {
        const view = phase1({
            revisions: SETTLED_ROUND(),
            findings: [FINDING('f-on-winner', 'revision_sel'), FINDING('f-on-loser', 'revision_old', 'critical')],
            verdicts: []
        });

        expect(summaryRevisions(view).map((entry) => entry.findings.map((finding) => finding.id))).toEqual([
            ['f-on-loser'],
            ['f-on-winner']
        ]);
        // Only the winner's row holds the phase: a defect on a discarded sibling is history, not work.
        expect(lockCheck(view).reasons).toEqual([
            '1 critical/major finding on the selected Summary awaiting your approval — nothing is queued until the Author decides (D-34)'
        ]);
    });
});

// ---------------------------------------------------------------------------
// T5 / R3 — the rail chip's copy.
//
// An open Summary draft is a round that has not settled. In phase ① nothing asks anyone to settle it:
// the engine selects the winner deterministically (§6.5, §16.6, D-47) once every draft has its screening
// set, so a chip telling the Author to "choose a draft" names a decision the loop never brings. A
// `competing`/`drafted` Summary row in a LATER phase is a pre-§16.6 legacy row, and §16.8 supersedes the
// Editor's `selection_rules` for phase ① only — so the old chip stays correct there.
// ---------------------------------------------------------------------------

describe('storyAttention — the Summary chip names who settles the round (§16.6, D-47)', () => {
    /** A round that has not settled: two `drafted` samples, no winner installed. */
    const OPEN_ROUND = (): Revision[] => [
        DRAFT('revision_a', '2026-11-11T11:01:00.000Z', { state: 'drafted' }),
        DRAFT('revision_b', '2026-11-11T11:02:00.000Z', { state: 'drafted' })
    ];

    it('phase ① says the engine selects, and never offers a choice the phase does not have', () => {
        const view = phase1({ sampling: ROUND_ONE_IN_FLIGHT, revisions: OPEN_ROUND() });
        const chip = storyAttention(view).find((item) => item.panel === 'summary');

        expect(chip).toEqual({ panel: 'summary', label: 'engine selects a draft', tone: 'awaiting' });
        // The reported contradiction's rail half: no draft-picking language, and no Editor either.
        expect(chip?.label).not.toContain('choose');
    });

    it('a later phase keeps the Editor-choice chip for a legacy Summary draft (§16.8)', () => {
        const view = phase1({ sampling: ROUND_ONE_IN_FLIGHT, revisions: OPEN_ROUND() });
        const chip = storyAttention({ ...view, story: { ...view.story, phase: 'chapters' } }).find(
            (item) => item.panel === 'summary'
        );

        expect(chip).toEqual({ panel: 'summary', label: 'choose a draft', tone: 'awaiting' });
    });

    it('settles out of the chip once the round has a winner', () => {
        const view = phase1({ revisions: SETTLED_ROUND() });

        expect(storyAttention(view).find((item) => item.panel === 'summary')).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// T11/F2, F4, F6 — the round map, the ref map, and the copy that reads them.
//
// F2: `records.ts:isSupersededSummaryDraft` retires a `drafted`/`competing` Summary row of a wave the
// loop has driven past, and the SAME predicate now answers the rail chip, the review tick, the Author
// override candidate list and the lock. F4: the attribution question is "do these refs name a known
// Summary DRAFT", not "are there refs" — `[unitRef]`, a Seed Brief or a criterion is a whole-Summary
// statement that blocks and must be visible. F6: the scope travels with the row so the pane's copy is
// that decision, not a second guess per card.
// ---------------------------------------------------------------------------

describe('a retired Summary draft is not live competition, and a non-draft ref is the whole Summary (T11)', () => {
    /**
     * The reviewer's example, stated honestly (T12/P1): round 3 CLOSED on `revision_sel`, so the round in
     * flight is 4, and a round-1 `drafted` row is a screening job that can never be answered.
     */
    const RETIRED_ROUND = (): Revision[] => [
        DRAFT('revision_old', '2026-11-11T11:01:00.000Z', { state: 'discarded', round: 1 }),
        DRAFT('revision_zombie', '2026-11-11T11:02:00.000Z', { state: 'drafted', round: 1 }),
        DRAFT('revision_sel', '2026-11-11T11:03:00.000Z', { state: 'selected', round: 3 })
    ];

    const ROUND_THREE = (): Partial<StoryViewData> => ({
        sampling: {
            round: 3,
            active_round: 4,
            history: [{ round: 3, at: '2026-11-11T11:03:00.000Z', samples: [], selected: 'revision_sel' }]
        } satisfies SamplingView,
        revisions: RETIRED_ROUND(),
        runs: fixtureReviewRuns('revision_sel')
    });

    it('settles the chip, the tick, the override list and the gate out of a wave already chosen', () => {
        const view = phase1(ROUND_THREE());

        // The chip this row used to raise: "engine selects a draft", for a selection the loop made two
        // rounds ago.
        expect(storyAttention(view).find((item) => item.panel === 'summary')).toBeUndefined();
        // The tick the same row used to hold.
        expect(summaryReadyForReview(view)).toBe(true);
        // The Author-override candidate it used to offer (`summaryRevisionUnit` is what the pane's Select
        // and the recommendation read come from).
        expect(summaryRevisionUnit(view)).toBeUndefined();
        // And the gate: no competition line, nothing owed.
        expect(lockCheck(view)).toMatchObject({ canLock: true, reasons: [] });
    });

    it('keeps the retired draft in the rail, and still offers a current-round draft for selection', () => {
        const view = phase1(ROUND_THREE());

        // Retirement changes the GATE, not the record: the rail is the Author's history of every draft.
        expect(summaryRevisions(view).map((entry) => [entry.index, entry.revision.id])).toEqual([
            [1, 'revision_old'],
            [2, 'revision_zombie'],
            [3, 'revision_sel']
        ]);

        // The mirror case: a `drafted` row of the round IN FLIGHT (rounds 1-2 closed, so `round: 2` and
        // `active_round: 3`) is ordinary competition, and every surface says so — including the one that
        // was retired above.
        const inFlight = phase1({
            sampling: { round: 2, active_round: 3, history: [] } satisfies SamplingView,
            revisions: [
                DRAFT('revision_old', '2026-11-11T11:01:00.000Z', { state: 'discarded', round: 1 }),
                DRAFT('revision_now', '2026-11-11T11:04:00.000Z', { state: 'drafted', round: 3 })
            ],
            runs: []
        });

        expect(summaryRevisionUnit(inFlight)?.revisions.map((revision) => revision.id)).toEqual(['revision_now']);
        expect(storyAttention(inFlight).find((item) => item.panel === 'summary')).toEqual({
            panel: 'summary',
            label: 'engine selects a draft',
            tone: 'awaiting'
        });
        expect(summaryReadyForReview(inFlight)).toBe(false);
    });

    it('files a finding whose refs name no draft on every revision of the Summary (T11/F4, F6)', () => {
        const view = phase1({
            revisions: SETTLED_ROUND(),
            findings: [FINDING('f-seed', 'seed_brief_1'), FINDING('f-unit', 'sum1')],
            verdicts: []
        });

        const listed = summaryRevisions(view);

        // Neither ref names a draft, so neither row is a draft's private history: the whole-Summary
        // critique sits on the selected revision, where the Accept button says it is holding the lock.
        expect(listed.map((entry) => entry.findings.map((finding) => finding.id))).toEqual([
            ['f-seed', 'f-unit'],
            ['f-seed', 'f-unit']
        ]);
        expect(listed[0]?.findingScopes).toEqual({ 'f-seed': 'artifact', 'f-unit': 'artifact' });
        expect(listed[1]?.findingScopes).toEqual({ 'f-seed': 'artifact', 'f-unit': 'artifact' });

        // And the gate agrees it is a blocker, named once.
        expect(lockCheck(view).reasons).toEqual([
            '2 critical/major findings on the selected Summary awaiting your approval — nothing is queued until the Author decides (D-34)'
        ]);
    });

    it('files a finding naming only a retired draft on that draft, never on the winner (T11/F4, F6)', () => {
        const view = phase1({
            revisions: RETIRED_ROUND(),
            sampling: { round: 3, active_round: 4, history: [] } satisfies SamplingView,
            runs: fixtureReviewRuns('revision_sel'),
            findings: [FINDING('f-retired', 'revision_zombie')],
            verdicts: []
        });

        const listed = summaryRevisions(view);

        expect(listed.map((entry) => [entry.revision.id, entry.findings.map((finding) => finding.id)])).toEqual([
            ['revision_old', []],
            ['revision_zombie', ['f-retired']],
            ['revision_sel', []]
        ]);
        // The row stays visible where it is honest, and the pane's copy can say what it is: a finding
        // about a draft the loop set aside, not about the Summary the Author is signing.
        expect(listed[1]?.findingScopes).toEqual({ 'f-retired': 'superseded' });
        expect(lockCheck(view)).toMatchObject({ canLock: true, reasons: [] });
    });
});

// ---------------------------------------------------------------------------
// T4/R1 — why a draft was parked, derived ONCE and read by both surfaces.
//
// `Revision.discard_reason` is optional: rows written before it landed carry none, and the selection
// commit may write a blank. `summaryRevisions` therefore derives ONE trimmed value and OMITS it when
// empty, which is what lets the rail mark a draft discarded while the pane stays silent. The dashboard
// may never invent a reason, and may never borrow the winner's `selection_note` for a loser — that
// sentence belongs to the draft that won.
// ---------------------------------------------------------------------------
describe('summaryRevisions — the discard explanation is derived, never invented (T4/R1)', () => {
    it('trims the reason on a discarded draft, and omits it on a blank or legacy row', () => {
        const rows = summaryRevisions({
            ...fixtureView(),
            revisions: [
                DRAFT('revision_reason', '2026-11-11T11:01:00.000Z', {
                    state: 'discarded',
                    discard_reason: '  the later draft states its price sooner  '
                }),
                DRAFT('revision_blank', '2026-11-11T11:02:00.000Z', { state: 'discarded', discard_reason: '   ' }),
                // The legacy shape: a `discarded` row with no field at all. It must still read as a
                // discard — with no reason, and never with an invented one.
                DRAFT('revision_legacy', '2026-11-11T11:03:00.000Z', { state: 'discarded' }),
                // The winner carries `selection_note`, and that is ITS sentence. It is not the reason any
                // loser was parked, so it must not arrive as `discardReason`.
                DRAFT('revision_win', '2026-11-11T11:04:00.000Z', {
                    state: 'selected',
                    selection_note: 'the draft that names its price earliest wins (L-17)'
                }),
                // A draft a backtrack put BACK on record still carries the reason an earlier round parked it.
                // It reads as nothing here: the row is the Summary on record, not a discard, and a stale
                // explanation would say otherwise.
                DRAFT('revision_restored', '2026-11-11T11:05:00.000Z', {
                    state: 'selected',
                    discard_reason: 'parked in the round before the backtrack'
                })
            ],
            findings: [],
            verdicts: []
        });

        expect(rows.map((entry) => entry.discardReason)).toEqual([
            'the later draft states its price sooner',
            undefined,
            undefined,
            undefined,
            undefined
        ]);
        // The winner's note keeps its OWN slot, so the two explanations cannot be confused downstream.
        expect(rows[3]?.editorNote?.note).toBe('the draft that names its price earliest wins (L-17)');
    });

    it('carries the reason to the revision the rail ref opens, and none for a legacy row', () => {
        const view = {
            ...fixtureView(),
            revisions: [
                DRAFT('revision_a', '2026-11-11T11:01:00.000Z', {
                    state: 'discarded',
                    discard_reason: 'the bell stays under the water'
                })
            ]
        };

        expect(summaryRevisionFocus(view, { panel: 'summary', ref: 'revision:revision_a' })?.discardReason).toBe(
            'the bell stays under the water'
        );

        const legacy = {
            ...view,
            revisions: [DRAFT('revision_b', '2026-11-11T11:02:00.000Z', { state: 'discarded' })]
        };

        // `undefined`, not '': the pane's `entry.discardReason ? … : null` is what keeps a legacy draft
        // from rendering an empty "Discard reason:" line.
        expect(summaryRevisionFocus(legacy, { panel: 'summary', ref: 'revision:revision_b' })?.discardReason).toBe(
            undefined
        );
    });
});
