// The pure spec rules the story panels share, pinned without a DOM (W10–W13).
//
// Every expectation below is an EXACT value read off the fixtures, not a range: these functions
// are the sentences the Author reads (L-32's deletion list, L-7a's lock reasons, L-25b's discard
// count), so a reworded string is a product change and must fail a test.
import { describe, expect, it } from 'vitest';
import {
    ACTIVITY_ORDER,
    backtrackStatement,
    blankTemplatePayload,
    buildRevisionUnits,
    competingRevisionsFor,
    completionDiscardSentence,
    deepReviewProgress,
    diffWords,
    draftVerdicts,
    earlierDecisionOf,
    findingAppliesToRevision,
    findingRevisionScope,
    formatElapsed,
    groupChapters,
    hasEditorRole,
    isLiveRun,
    isPanelRole,
    isSupersededSummaryDraft,
    isVerifiedIdea,
    lockCheck,
    panelDissent,
    patchOf,
    phaseLocks,
    phasesAfter,
    pendingProposalsFor,
    plotlinesCustomStartNotice,
    plotlinesCustomStartRefusal,
    plotlinesHandoffRefusal,
    // R7 — the cleanup's sentences and the receipt's provenance clause: every one is a wire state's words, so each
    // is pinned as a literal here rather than re-typed inside a component test.
    plotlinesSeedOrigin,
    // F4 — the transport budget the ask is shut at, pinned as a number here so the margin below the measured
    // 431 ceiling is a reviewed value rather than a constant buried in a component.
    SEED_CLEANUP_ASK_URL_LIMIT,
    SEED_CLEANUP_APPLIED_NOTE,
    SEED_CLEANUP_NOTHING_TO_FIX,
    SEED_CLEANUP_PROPOSAL_NOTE,
    seedCleanupAskRefusal,
    seedCleanupRefusalNotice,
    runsStoppedByPause,
    revisionBodyText,
    summaryIsCompiled,
    summaryScopeContext,
    undoTargetFor,
    unconfirmedBlockingFindings
} from './story-contract';
import { NOW, fixtureCompletion, fixtureRuns, fixtureTemplates, fixtureView } from './story-fixtures';
import type { StoryViewData } from './story-contract';
// The wire slice (`api.ts:SamplingView`), typed so the fixtures below cannot quietly drop one of the two
// round numbers the projection sends (T12/P1).
import type { SamplingView } from '../api';
// The same default the loop dispatches the deep review by (`records.ts:screeningSizeOf`), so the clean
// baselines spell out the pass count the engine actually owes rather than a number this file picked.
import { DEFAULT_SUMMARY_CRITICS } from '../../shared/types';
import type { Cost, Finding, FindingState, Revision, Run, Story } from '../../shared/types';

describe('story-contract — phases, locks and backtrack (U-16, L-31, L-32)', () => {
    it('maps which lock signed which phase, with phase ③ signed only by `completed` (L-25a)', () => {
        const view = fixtureView();
        expect(phaseLocks(view.story)).toEqual({ summary: true, plotlines: true, chapters: false });
        expect(phasesAfter('summary')).toEqual(['plotlines', 'chapters']);
        expect(phasesAfter('chapters')).toEqual([]);
    });

    it('names the exact deletions of each backtrack target, counted from the live view (L-32, D-25)', () => {
        const view = fixtureView();

        expect(backtrackStatement(view.story, 'summary', view)).toBe(
            'Backtrack to Summary deletes 4 chapters with their 4 revisions, 2 plotlines, and the derived Digest. ' +
                'Verdicts and findings survive as provenance; the Ideas do not — the lock already deleted them (D-25, D-36, L-31). ' +
                'Story "Neon Cathedral" starts again from its Seed.'
        );
        expect(backtrackStatement(view.story, 'plotlines', view)).toBe(
            'Backtrack to Plotlines deletes 4 chapters with their 4 revisions and unlocks every plotline. ' +
                'Verdicts and selection notes survive (D-25, L-31). The locked Summary stays locked.'
        );
    });

    it('refuses the lock and states BOTH blockers, goal first (U-16, L-7a, G-2, D-36)', () => {
        // The fixture Story is at phase ③ with two failing criteria and three undecided Ideas.
        expect(lockCheck(fixtureView())).toEqual({
            phase: 'chapters',
            canLock: false,
            reasons: [
                'the Goal has not passed: C-8, C-11 still failing (4/7 · failing: C-8, C-11)',
                '3 Ideas still in the tray — each must be selected, discarded, or deferred first (L-7a)'
            ],
            statement:
                'Accepting completion locks the chapters exactly as the Summary and plotlines were locked (L-25a), and everything still open is closed with a count on it (L-25b).'
        });
    });
});

describe('story-contract — chapter activity grouping (decision 0/5, L-8, D-23, D-34)', () => {
    it('groups the fixture chapters one per activity group, always in ACTIVITY_ORDER', () => {
        const groups = groupChapters(fixtureView());

        expect(groups.map((entry) => [entry.group, entry.chapters.map((chapter) => chapter.id)])).toEqual([
            ['contested', ['c2']],
            ['awaiting', ['c4']],
            ['drafting', ['c3']],
            ['clean', ['c1']]
        ]);
        // The order is the render order, so the screen cannot reshuffle itself between sweeps.
        expect(groups.map((entry) => entry.group)).toEqual(ACTIVITY_ORDER);
    });

    it('treats a `done` chapter with an approved finding as awaiting, not clean (D-34, L-11)', () => {
        const view = fixtureView();
        // c1 is `done`; approving the open finding on it moves it out of `clean`.
        const c1 = view.chapters.find((chapter) => chapter.id === 'c1')!;
        const withApprovedFinding = {
            ...view,
            findings: [
                ...view.findings,
                { ...view.findings[0], id: 'f-open', target_ref: 'c1', state: 'approved' as const }
            ]
        };

        expect(groupChapters(view)[3].chapters.map((chapter) => chapter.id)).toEqual(['c1']);
        // Within a group the chapters stay in record order (c1 before c4) — the GROUP is the
        // ordering signal, the chapter list inside it is not reshuffled (L-8).
        expect(groupChapters(withApprovedFinding)[1].chapters.map((chapter) => chapter.id)).toEqual(['c1', 'c4']);
        expect(c1.state).toBe('done');
    });
});

describe('story-contract — revisions, spans and undo (U-13, D-23, P11)', () => {
    it('labels each revision unit with the artifact it belongs to, in view order (U-13)', () => {
        expect(buildRevisionUnits(fixtureView())).toMatchObject([
            {
                unitRef: 'c2',
                unitKind: 'chapter',
                label: 'Chapter 2 — Ghost Index',
                revisions: [{ id: 'rv-c2-a' }, { id: 'rv-c2-b' }]
            },
            {
                unitRef: 'c1',
                unitKind: 'chapter',
                label: 'Chapter 1 — The Sealed Stack',
                revisions: [{ id: 'rv-sel-1' }]
            },
            { unitRef: 'sum1', unitKind: 'summary', label: 'Summary', revisions: [{ id: 'rv-sum-a' }] }
        ]);
        expect(competingRevisionsFor(fixtureView().revisions, 'c2').map((revision) => revision.id)).toEqual([
            'rv-c2-a',
            'rv-c2-b'
        ]);
    });

    it('buckets the §4.9 verdict rows by target: a draft reads its own, newest last (U-13, D-21)', () => {
        const view = fixtureView();
        const [c2, c1, summary] = buildRevisionUnits(view);

        // Only rows naming a REVISION land in the per-draft bucket, and only the drafts THIS unit owns
        // (the buckets are keyed by revision id, so the unit scopes them). The unit-targeted row (v-3 on
        // c2) is the OTHER convention §8.3's `submitVerdict` produces, and it rides separately so the
        // pane can label it instead of implying the draft was judged on its own.
        expect(Object.keys(c2.verdictsByRevision)).toEqual(['rv-c2-a']);
        expect(c2.verdictsByRevision['rv-c2-a']?.map((verdict) => verdict.id)).toEqual(['v-1', 'v-2']);
        expect(c2.verdictsForUnit.map((verdict) => verdict.id)).toEqual(['v-3']);
        expect(c1.verdictsByRevision['rv-sel-1']?.map((verdict) => verdict.id)).toEqual(['v-4']);
        expect(c1.verdictsForUnit).toEqual([]);
        // The Summary unit's row `rv-sum-a` was never judged, and no verdict names `sum1`.
        expect(summary.verdictsByRevision).toEqual({});
        expect(summary.verdictsForUnit).toEqual([]);

        // The pane reads the LAST row of a bucket as the current judgement (the criteria engine
        // aggregates the same way), so the sort is part of the contract. Fed the rows in reverse, the
        // bucket still ends on the newer verdict.
        const reversed = buildRevisionUnits({ ...view, verdicts: [...(view.verdicts ?? [])].reverse() });

        expect(reversed[0]?.verdictsByRevision['rv-c2-a']?.map((verdict) => verdict.id)).toEqual(['v-1', 'v-2']);

        // Which judgement a column shows — the draft's own when it exists, the unit's otherwise. The
        // strings differ for a reason: "this draft was read" and "the unit was read" are different claims.
        expect(draftVerdicts(c2, view.revisions.find((revision) => revision.id === 'rv-c2-a')!)).toEqual({
            verdicts: c2.verdictsByRevision['rv-c2-a'],
            source: 'draft'
        });
        expect(draftVerdicts(c2, view.revisions.find((revision) => revision.id === 'rv-c2-b')!)).toEqual({
            verdicts: c2.verdictsForUnit,
            source: 'unit'
        });

        // An older server omits the additive slice: every bucket is simply empty, rather than a crash.
        const bare = buildRevisionUnits({ ...view, verdicts: undefined });

        expect(bare.map((unit) => [unit.unitRef, unit.verdictsForUnit.length])).toEqual([
            ['c2', 0],
            ['c1', 0],
            ['sum1', 0]
        ]);
    });

    it('reads a revision body in all three shapes §4.15 allows', () => {
        const view = fixtureView();

        expect(revisionBodyText(view.revisions.find((revision) => revision.id === 'rv-c2-b')!.body)).toBe(
            'The index answered in her own voice, and she did not recognise it.'
        );
        expect(revisionBodyText(view.revisions.find((revision) => revision.id === 'rv-c2-a')!.body)).toBe(
            'The index answered before she touched it, in a voice she had heard read aloud years earlier.'
        );
        // A Summary body is its fields, rendered as the field lines the Author reads.
        expect(revisionBodyText(view.revisions.find((revision) => revision.id === 'rv-sum-a')!.body)).toBe(
            'premise: A flooded city keeps its memory in a sealed cathedral of data.\nending: She seals the index with her own voice in it.'
        );
    });

    it('resolves an Undo target to the §4.4 span it names (P11, D-7)', () => {
        const chapter = fixtureView().chapters.find((entry) => entry.id === 'c2')!;

        // A bare section id of THIS chapter, the `chapter:section` spelling, and a ref that is
        // neither (the whole-chapter case, which sends an empty section id).
        expect(undoTargetFor(chapter, 's3')).toEqual({ chapter_id: 'c2', section_id: 's3' });
        expect(undoTargetFor(chapter, 'c9:s7')).toEqual({ chapter_id: 'c9', section_id: 's7' });
        expect(undoTargetFor(chapter, 's99')).toEqual({ chapter_id: 's99', section_id: '' });
    });
});

describe('story-contract — proposals and diffs (U-5, D-20)', () => {
    it('diffs at word level into exact spans (U-5: a diff, not a replaced paragraph)', () => {
        expect(
            diffWords(
                'The index answered before she touched it, in a voice she had heard read aloud years earlier.',
                'The index answered before she touched it, in a voice she had heard read aloud — and it was hers.'
            )
        ).toEqual([
            { kind: 'same', text: 'The index answered before she touched it, in a voice she had heard read aloud ' },
            { kind: 'removed', text: 'years' },
            { kind: 'added', text: '—' },
            { kind: 'same', text: ' ' },
            { kind: 'removed', text: 'earlier.' },
            { kind: 'added', text: 'and it was hers.' }
        ]);
    });

    it('reads a patch tolerantly and lists only PENDING proposals for this chapter (U-5, D-7)', () => {
        const view = fixtureView();
        const c2 = view.chapters.find((chapter) => chapter.id === 'c2')!;

        expect(patchOf({ section_id: 's3', text: 'x' })).toEqual({ sectionId: 's3', text: 'x' });
        expect(patchOf('plain')).toEqual({ text: 'plain' });
        expect(patchOf(undefined)).toEqual({ text: '' });
        // pr-1 targets section s3 (D-7 makes the section addressable); pr-2 targets s1 in chapter 1.
        expect(pendingProposalsFor(c2, view.proposals).map((proposal) => proposal.id)).toEqual(['pr-1']);
    });
});

describe('story-contract — runs, ideas, templates, completion (U-7, D-27/D-32, D-38, L-25b)', () => {
    it('counts the runs a Pause stopped and marks the run whose panel disagreed (U-17, S-3, D-38)', () => {
        const runs = fixtureRuns();

        expect(runs.map(isLiveRun)).toEqual([true, false]);
        expect(runsStoppedByPause(runs)).toBe(1);
        expect(panelDissent(runs[0])).toBe(
            '1 of 3 preferred the earlier cut — dissent recorded in the selection note.'
        );
        expect(panelDissent(runs[1])).toBeNull();
        // S-6: elapsed is measured against the injected clock, so the row is a known number.
        expect(runs.map((run) => formatElapsed(run.started_at, run.ended_at, NOW))).toEqual(['2m 30s', '4m 20s']);
    });

    it('orders the tray by verification and surfaces the earlier decision of a repeat (D-27, D-32)', () => {
        const ideas = fixtureView().ideas;
        const repeat = ideas.find((idea) => idea.id === 'i-repeat')!;
        const verified = ideas.find((idea) => idea.id === 'i-verified')!;

        expect(isVerifiedIdea(verified)).toBe(true);
        expect(isVerifiedIdea(repeat)).toBe(false);
        expect(earlierDecisionOf(repeat, ideas)!.id).toBe('i-old');
        expect(earlierDecisionOf(verified, ideas)).toBeUndefined();
    });

    it('states the discard count completion carries, before the Accept (L-25b)', () => {
        expect(completionDiscardSentence(fixtureCompletion())).toBe(
            '47 findings and 12 Ideas will be closed without action, the oldest from chapter 2 (L-25b).'
        );
    });

    it('distinguishes a panel role and an Editor role on the card (U-8d, U-8b, D-38)', () => {
        const [chapters, builtin] = fixtureTemplates();

        expect(chapters.roles.map(isPanelRole)).toEqual([true, false, true]);
        expect(builtin.roles.map(isPanelRole)).toEqual([false]);
        expect(hasEditorRole(chapters)).toBe(true);
        expect(hasEditorRole(builtin)).toBe(false);
    });

    it('builds the New payload as an Author crew, never a built-in (D-17, P12)', () => {
        expect(blankTemplatePayload(NOW)).toEqual({
            id: 'template_new',
            rev: 1,
            created_at: NOW,
            updated_at: NOW,
            name: 'author-crew',
            title: 'Author crew',
            description: 'A crew of the Author’s own making (D-17).',
            roles: [{ name: 'writer', kind: 'writer', prompt: '' }],
            serves_phase: ['chapters'],
            done_definition: '',
            attempts: 1,
            builtin: false,
            editable: true
        });
    });
});

// ---------------------------------------------------------------------------
// Phase ①'s Accept gate (T5 / R3, T11) — every sentence behind a disabled "Accept final Summary".
//
// These cases are the stable Author decision point R3 asked for: after a clean review the lock must be
// ENABLED with no invented blocker; when something really does hold the phase, the reason must name the
// wait the loop actually owes (the engine's selection, an armed fix, the sweep's dial, the Author's own
// approval, an undecided suspicion, §6.4 step 6's review) — never "wait for the Editor's choice", which
// phase ① (D-47, §16.6) does not have.
//
// T11 ADDED THE PROJECTION HONESTY RULE: the baselines below are FULLY REVIEWED projections. A settled
// round carries five closed `wi_review_<winner>_aN` rows (`runs` is required and uncapped on the wire),
// and the drafts carry the round `sampling.round` says is in flight. `runs: []` alone is not a clean
// Story — it is an unread Summary, and every case pinned here says which of the two it means.
// ---------------------------------------------------------------------------

/** One instant for every local row: these cases are about STATES, and only one revision is selected. */
const AT = '2026-11-11T11:02:00.000Z';

/**
 * One Summary draft of the fixture Summary (`sum1`) — §16.6's engine settles the round over rows like
 * these. `state` has NO default on purpose: the gate cases differ precisely in which draft is
 * `selected`, which is `discarded`, and which is still `drafted`, so an implicit state would hide what
 * the case asserts (a row that is not `selected` is not the Summary on record — see `gateView`).
 *
 * `round` defaults to 1, the round the baseline projection reports (`sampling.round: 1`). A case that is
 * about a LATER round passes it explicitly: the round number is what makes a draft current-round work, an
 * Author override of an older round, or a draft the loop has set aside (T11/F1, F2).
 */
function draft(id: string, state: Revision['state'], created = AT, round = 1): Revision {
    return {
        id,
        rev: 1,
        created_at: created,
        updated_at: created,
        story_id: 's1',
        unit_kind: 'summary',
        unit_ref: 'sum1',
        body: { premise: 'A flooded city keeps its memory in a sealed cathedral of data.' },
        run_ref: `run_${id}`,
        template_ref: 't-builtin',
        state,
        round,
        verdict_refs: []
    };
}

/**
 * A Critic finding. PASSING NO `related` reproduces the legacy/whole-artifact spelling (`target_ref`
 * only, no L-11a refs) — the shape whose old mismatch produced "no findings" beside a blocking reason.
 * T11/F4: refs that name a NON-draft id (the Summary row, a Seed Brief, a criterion) are the same
 * whole-artifact answer, and a case passes them to pin that.
 */
function findingOn(id: string, cost: Cost, state: FindingState, related?: string[]): Finding {
    return {
        id,
        rev: 1,
        created_at: AT,
        updated_at: AT,
        story_id: 's1',
        target_ref: 'sum1',
        criterion_ref: 'C-14',
        title: `${id} on the Summary`,
        evidence: 'round 2, ¶1 — the page says so',
        cost,
        fingerprint: `fp-${id}`,
        state,
        seen_count: 1,
        ...(related === undefined ? {} : { related_refs: related })
    };
}

/** §16.1 job 5's deep-review Run row: the `work_item_ref` claim key is the projection's only read of the review. */
function reviewRun(revisionId: string, pass: number, state: Run['state'] = 'torn_down'): Run {
    return {
        id: `run_review_${revisionId}_a${pass}`,
        rev: 1,
        created_at: AT,
        updated_at: AT,
        story_id: 's1',
        work_item_ref: `wi_review_${revisionId}_a${pass}`,
        template_ref: 't-critic',
        role: 'critic',
        state,
        started_at: AT,
        ended_at: state === 'working' ? null : AT,
        tokens: 100,
        kind: 'work',
        delegated: []
    };
}

/** The closed passes 1…n for one draft — the rows a settled round's review leaves on the wire. */
function closedPasses(revisionId: string, passes: number): Run[] {
    return Array.from({ length: passes }, (_, index) => reviewRun(revisionId, index + 1));
}

type GateOverrides = Omit<Partial<StoryViewData>, 'story'> & { story?: Partial<Story> };

/**
 * Phase ① with every REAL gate clean — Goal passing, the phase's tray decided, the round settled on
 * `revision_sel`, no findings, the round's five deep-review passes CLOSED, and the sampling slice naming
 * the round these drafts belong to. A case overrides the one fact it is about.
 *
 * `revision_sel` carries `state: 'selected'` because that is how the server marks a round's winner
 * (`engine.ts:1287`, `routes.ts:1081`) and it is the only spelling `selectedSummaryRevision` resolves
 * (`records.ts:212`, mirrored by `story-contract.ts:selectedSummaryRevision`). A settled round with no
 * `selected` row is a state the loop cannot produce, and the blocker set below would silently be empty.
 *
 * `auto_approve: []` is deliberate: with the dial off, a `confirmed` finding is Author work, which is
 * what the state-split reasons need. The Ideas are emptied rather than marked decided, because the tray
 * reason belongs to the L-7a case already pinned above.
 */
function gateView(overrides: GateOverrides = {}): StoryViewData {
    const view = fixtureView();
    const { story: storyOverrides, ...rest } = overrides;

    return {
        ...view,
        story: { ...view.story, phase: 'summary', summary_locked: false, auto_approve: [], ...storyOverrides },
        goal: { ...view.goal, failing: [] },
        ideas: [],
        revisions: [
            draft('revision_old', 'discarded', '2026-11-11T11:01:00.000Z'),
            draft('revision_sel', 'selected')
        ],
        findings: [],
        // T11/F1: an honest clean projection shows the review having RUNN. `runs` is required and uncapped
        // (`api.ts:StoryView`, `server/api/projections.ts`), so the shipped server carries these five
        // closed claims; `runs: []` would be a Summary nobody read, and the gate owes all five passes.
        runs: closedPasses('revision_sel', DEFAULT_SUMMARY_CRITICS),
        // §10: the shipped server always sends the slice, and BOTH round numbers (T12/P1). The drafts
        // above carry round 1 and one of them is `selected`, so round 1 is the COMPLETED round the deep
        // review is owed for (`round`), and round 2 is the one in flight (`active_round`) — the number the
        // supersession comparison uses. A case about a live round says `active_round: 1` instead.
        sampling: ROUND_ONE_DONE,
        ...rest
    };
}

/**
 * The slice a round leaves when it CLOSES: `round` is the completed one, `active_round` the one after it
 * (§6.6 — `sampling_round` advances on the selection, `records.ts:samplingRoundOf` is one past it).
 */
const ROUND_ONE_DONE: SamplingView = {
    round: 1,
    active_round: 2,
    history: [{ round: 1, at: AT, samples: [], selected: 'revision_sel' }]
};

/** The slice of a Story that has never selected: the in-flight round IS round 1, and `round` says 1 too. */
const ROUND_ONE_IN_FLIGHT: SamplingView = { round: 1, active_round: 1, history: [] };

/** The clean baseline's selected draft, for the reads that take it explicitly. */
const SELECTED = (): Revision => draft('revision_sel', 'selected');

describe('story-contract — Phase ①\u2019s Accept gate names the waits the engine actually has (R3, §16.6)', () => {
    it('says the engine selects the round\u2019s winner — phase ① has no Editor draft choice (D-47)', () => {
        const gate = lockCheck(
            gateView({
                // Nothing has been selected here, so the round in flight IS round 1 (`active_round: 1`) and
                // both drafts are live work — the state the baseline's CLOSED round is not (T12/P1).
                sampling: ROUND_ONE_IN_FLIGHT,
                revisions: [draft('revision_a', 'drafted', '2026-11-11T11:01:00.000Z'), draft('revision_b', 'drafted')]
            })
        );

        expect(gate.phase).toBe('summary');
        expect(gate.canLock).toBe(false);
        expect(gate.reasons).toEqual([
            '2 Summary revisions still in this round — the engine selects the winner once every draft has its screening reviews (§16.6)'
        ]);
        // The reported contradiction's first half: a wait on a decision phase ① never makes.
        expect(gate.reasons.join(' ')).not.toContain('Editor');
    });

    it('leaves later phases alone: a plotlines-phase lock still names the Goal and nothing about drafts', () => {
        const view = fixtureView();
        const inPlotlines = {
            ...view,
            story: { ...view.story, phase: 'plotlines' as const, summary_locked: true, plotlines_locked: false }
        };
        const gate = lockCheck(inPlotlines);

        // `rv-sum-a` is still `competing` in the fixtures, and phase ② keeps its own Editor-selection
        // rules (§16.8 supersedes them for phase ① only), so no phase-① line may leak in here.
        expect(gate.reasons).toEqual([
            'the Goal has not passed: C-8, C-11 still failing (4/7 · failing: C-8, C-11)'
        ]);
    });

    it('splits the open-finding reason by what is owed: armed round, dial sweep, or the Author (D-34, D-35)', () => {
        const gate = lockCheck(
            gateView({
                story: { auto_approve: ['critical'] },
                findings: [
                    findingOn('f-armed', 'major', 'approved', ['revision_sel']),
                    findingOn('f-dial', 'critical', 'confirmed', ['revision_sel']),
                    findingOn('f-desk', 'major', 'confirmed', ['revision_sel'])
                ]
            })
        );

        expect(gate.canLock).toBe(false);
        expect(gate.reasons).toEqual([
            '1 approved critical/major finding on the selected Summary — the next Summary round writes fresh drafts to clear them (D-34)',
            '1 critical/major finding on the selected Summary at a cost your dial auto-approves — the sweep approves them and the next Summary round clears them (D-35)',
            '1 critical/major finding on the selected Summary awaiting your approval — nothing is queued until the Author decides (D-34)'
        ]);
    });

    it('does not promise a round to a finding that is waiting on the Author\u2019s decision (D-34)', () => {
        const gate = lockCheck(gateView({ findings: [findingOn('f-desk', 'major', 'confirmed', ['revision_sel'])] }));

        expect(gate.reasons).toEqual([
            '1 critical/major finding on the selected Summary awaiting your approval — nothing is queued until the Author decides (D-34)'
        ]);
        expect(gate.reasons.join(' ')).not.toContain('the next Summary round');
    });

    it('names the two sign-off waits the loop enforces, from the projected state (D-33, §6.4 step 6)', () => {
        const gate = lockCheck(
            gateView({
                story: { summary_critics: 3 },
                findings: [findingOn('f-open', 'major', 'unconfirmed', ['revision_sel'])],
                runs: [reviewRun('revision_sel', 1), reviewRun('revision_sel', 2, 'working')]
            })
        );

        // 3 passes are owed in total (the Author's own `summary_critics`); pass 1 is closed, pass 2 is
        // alive, so exactly one more is owed — and the reason says which wait it is, not "another round".
        expect(gate.reasons).toEqual([
            '1 critical/major finding on the Summary still unconfirmed — the phase cannot sign off while a suspicion is undecided (D-33)',
            "2 deep-review passes still owed on the selected Summary revision — the round's evidence is not complete (1 still running) (§6.4 step 6)"
        ]);
        expect(gate.canLock).toBe(false);
    });

    it('keeps a clean selected revision ENABLED, with no invented finding, competition or review blocker', () => {
        const gate = lockCheck(
            gateView({
                // Recorded notes at the costs phase ① never blocks on (D-30), plus an undecided taste
                // note, which `unconfirmedBlockingFindings` also filters out at this phase.
                findings: [
                    findingOn('f-minor', 'minor', 'confirmed', ['revision_sel']),
                    findingOn('f-taste', 'taste', 'unconfirmed')
                ]
            })
        );

        expect(gate.canLock).toBe(true);
        expect(gate.reasons).toEqual([]);
    });

    it('neither blocks nor lists a finding aimed at another revision (revision attribution holds)', () => {
        const gate = lockCheck(gateView({ findings: [findingOn('f-old', 'critical', 'approved', ['revision_old'])] }));

        expect(gate.canLock).toBe(true);
        expect(gate.reasons).toEqual([]);
    });

    it('counts a whole-artifact (legacy, no related_refs) finding against the SELECTED revision', () => {
        const gate = lockCheck(gateView({ findings: [findingOn('f-legacy', 'critical', 'confirmed')] }));

        // The pane shows the same row on this revision (`story-nav.test.ts` pins the pair), so the
        // screenshot's "No Critic findings on this revision yet" cannot stand beside this reason.
        expect(gate.canLock).toBe(false);
        expect(gate.reasons).toEqual([
            '1 critical/major finding on the selected Summary awaiting your approval — nothing is queued until the Author decides (D-34)'
        ]);
    });

    it('answers the attribution question once, for every panel that asks it', () => {
        const view = gateView();
        const context = summaryScopeContext(view);

        // Draft-scoped rows belong to the draft they name — and to no other.
        const onWinner = findingOn('f-a', 'major', 'confirmed', ['revision_sel']);
        const onLoser = findingOn('f-b', 'major', 'confirmed', ['revision_old']);

        expect(findingAppliesToRevision(onWinner, 'revision_sel', 'sum1', context)).toBe(true);
        expect(findingAppliesToRevision(onLoser, 'revision_sel', 'sum1', context)).toBe(false);
        expect(findingAppliesToRevision(onLoser, 'revision_old', 'sum1', context)).toBe(true);

        // Whole-artifact rows apply to every revision of THAT unit, and to no other unit.
        const whole = findingOn('f-legacy', 'major', 'confirmed');

        expect(findingAppliesToRevision(whole, 'revision_sel', 'sum1', context)).toBe(true);
        expect(findingAppliesToRevision({ ...whole, target_ref: 'c1' }, 'revision_sel', 'sum1', context)).toBe(false);
    });

    // -----------------------------------------------------------------------
    // T11/F4 — the server's attribution is "do the refs name a known Summary DRAFT", not "are there refs".
    // A row naming `[unitRef]`, a Seed Brief or a criterion with `target_ref === sum1` is a whole-artifact
    // finding: it blocks, and it must be visible on the selected revision. A row naming ONLY a retired
    // draft is history. `records.ts:findingRevisionScope` is the source; these are its answers.
    // -----------------------------------------------------------------------
    it('reads finding scope the way the server does: artifact, selected, superseded (T11/F4)', () => {
        const view = gateView();
        const context = summaryScopeContext(view);

        // The map the whole decision rests on: both drafts are known, and `sum1` is the unit, not a draft.
        expect([...context.draftRounds.entries()]).toEqual([
            ['revision_old', 1],
            ['revision_sel', 1]
        ]);
        expect(context).toMatchObject({ round: 1, activeRound: 2, selectedId: 'revision_sel', summaryRef: 'sum1' });

        expect(findingRevisionScope(findingOn('f-empty', 'major', 'confirmed'), context)).toBe('artifact');
        // Refs that name no draft — the Summary row itself, a brief, a criterion, a chapter — are the
        // legacy whole-Story shape and keep their blocking weight.
        expect(findingRevisionScope(findingOn('f-unit', 'major', 'confirmed', ['sum1']), context)).toBe('artifact');
        expect(
            findingRevisionScope(findingOn('f-seed', 'major', 'confirmed', ['seed_brief_1', 'C-14']), context)
        ).toBe('artifact');
        // Refs naming drafts decide between the winner and the set-aside.
        expect(findingRevisionScope(findingOn('f-win', 'major', 'confirmed', ['revision_sel']), context)).toBe(
            'selected'
        );
        expect(findingRevisionScope(findingOn('f-loser', 'major', 'confirmed', ['revision_old']), context)).toBe(
            'superseded'
        );
        // A row naming BOTH names the winner, so the round still answers it (the server's `includes` rule).
        expect(
            findingRevisionScope(findingOn('f-both', 'major', 'confirmed', ['revision_old', 'revision_sel']), context)
        ).toBe('selected');
    });

    it('blocks on a whole-artifact finding that names non-draft refs, and shows it on the revision', () => {
        for (const related of [['sum1'], ['seed_brief_1'], ['C-14', 'c2'], ['sum1', 'seed_brief_1']]) {
            const gate = lockCheck(gateView({ findings: [findingOn('f-whole', 'critical', 'confirmed', related)] }));

            // The invisible blocker must not survive: the row that holds the lock is the row the pane lists.
            expect(gate.canLock).toBe(false);
            expect(gate.reasons).toEqual([
                '1 critical/major finding on the selected Summary awaiting your approval — nothing is queued until the Author decides (D-34)'
            ]);
            expect(findingAppliesToRevision(findingOn('f-whole', 'critical', 'confirmed', related), 'revision_sel', 'sum1', summaryScopeContext(gateView()))).toBe(true);
        }
    });

    it('does not block on an unconfirmed suspicion that names only a retired draft (T11/F3)', () => {
        const view = gateView({
            revisions: [
                draft('revision_old', 'discarded', '2026-11-11T11:01:00.000Z'),
                draft('revision_sel', 'selected')
            ],
            findings: [
                findingOn('f-stale', 'critical', 'unconfirmed', ['revision_old']),
                findingOn('f-whole', 'major', 'unconfirmed'),
                findingOn('f-live', 'critical', 'unconfirmed', ['revision_sel'])
            ]
        });

        // The retired draft's suspicion is off the round's blocking set (the review re-reads the KEPT
        // draft, which never contained the defect); the winner's and the whole-Summary one stay.
        expect(unconfirmedBlockingFindings(view).map((finding) => finding.id)).toEqual(['f-whole', 'f-live']);

        const gate = lockCheck(view);

        expect(gate.canLock).toBe(false);
        expect(gate.reasons).toEqual([
            '2 critical/major findings on the Summary still unconfirmed — the phase cannot sign off while a suspicion is undecided (D-33)'
        ]);
    });

    // -----------------------------------------------------------------------
    // T11/F2 — a `drafted` row of an OLDER round is a loser the selection did not delete, not a round in
    // flight (`records.ts:isSupersededSummaryDraft`). The reviewer's example: drafted round 1 while the
    // winner is round 3. T12/P1 fixed which number that comparison uses: `sampling.round` names the round
    // whose SELECTION closed (round 3), and `active_round` names the one in flight (round 4), so BOTH a
    // round-1 loser and the round-3 leftover the selection outran are retired — and only a round-4 draft
    // is live work. The server-side twin of this case is `server/loop/phase1-round-parity.test.ts`.
    // -----------------------------------------------------------------------
    it('retires a drafted Summary row from an older round instead of holding the lock (T11/F2)', () => {
        const rounds = {
            // Round 3 closed; the loop is sampling round 4 (§6.6, `records.ts:samplingRoundOf`).
            sampling: {
                round: 3,
                active_round: 4,
                history: [{ round: 3, at: AT, samples: [], selected: 'revision_sel' }]
            } satisfies SamplingView,
            revisions: [
                draft('revision_old', 'discarded', '2026-11-11T11:01:00.000Z', 1),
                draft('revision_zombie', 'drafted', '2026-11-11T11:02:00.000Z', 1),
                draft('revision_late', 'drafted', '2026-11-11T11:02:30.000Z', 3),
                draft('revision_sel', 'selected', AT, 3)
            ],
            // The round that closed is the one whose winner's review is dispatchable, so the clean
            // baseline owes it all five closed passes (T11/F1).
            runs: closedPasses('revision_sel', DEFAULT_SUMMARY_CRITICS)
        };
        const view = gateView(rounds);
        const context = summaryScopeContext(view);

        expect({ round: context.round, activeRound: context.activeRound }).toEqual({ round: 3, activeRound: 4 });
        expect(
            isSupersededSummaryDraft(
                view,
                view.revisions.find((revision) => revision.id === 'revision_zombie')!,
                context
            )
        ).toBe(true);
        // The row T12/P1 adds: the round that JUST closed, still short of a selection when the engine
        // moved on. The old comparison (`round` = 3) read it as live competition.
        expect(
            isSupersededSummaryDraft(view, view.revisions.find((revision) => revision.id === 'revision_late')!, context)
        ).toBe(true);
        // The winner and the recorded history keep their existing meanings, and a draft of the round IN
        // FLIGHT is ordinary competition.
        expect(
            isSupersededSummaryDraft(view, view.revisions.find((revision) => revision.id === 'revision_sel')!, context)
        ).toBe(false);
        expect(
            isSupersededSummaryDraft(view, view.revisions.find((revision) => revision.id === 'revision_old')!, context)
        ).toBe(false);
        expect(
            isSupersededSummaryDraft(
                { ...view, revisions: [draft('revision_now', 'drafted', AT, 4)] },
                draft('revision_now', 'drafted', AT, 4),
                context
            )
        ).toBe(false);

        const gate = lockCheck(view);

        expect(gate.canLock).toBe(true);
        expect(gate.reasons).toEqual([]);
        // The phantom blocker this removes, spelled the way the old gate wrote it.
        expect(gate.reasons.join(' ')).not.toContain('still in this round');
    });

    // -----------------------------------------------------------------------
    // T11/F1 — the deep review of a FRESH selection. `runs` is required and uncapped, so a review family
    // with no row for the winner means "not reviewed yet": every pass is owed, exactly
    // `records.ts:deepReviewPassesOwed`. Only an absent `runs` slice stays silent.
    // -----------------------------------------------------------------------
    it('holds Accept over a fresh selection whose review has not dispatched a single pass (T11/F1)', () => {
        const gate = lockCheck(
            gateView({
                story: { summary_critics: 5 },
                // Present-but-empty review family: the ONLY rows are another family (the round's sampling).
                runs: [{ ...fixtureRuns()[0], work_item_ref: 'wi_sample_sum1_r1_a1' }]
            })
        );

        expect(gate.canLock).toBe(false);
        expect(gate.reasons).toEqual([
            "5 deep-review passes still owed on the selected Summary revision — the round's evidence is not complete (§6.4 step 6)"
        ]);
    });

    it('holds Accept over a partly reviewed winner, and counts the pass still running', () => {
        const gate = lockCheck(
            gateView({
                story: { summary_critics: 4 },
                runs: [...closedPasses('revision_sel', 2), reviewRun('revision_sel', 3, 'working')]
            })
        );

        expect(gate.canLock).toBe(false);
        expect(gate.reasons).toEqual([
            "2 deep-review passes still owed on the selected Summary revision — the round's evidence is not complete (1 still running) (§6.4 step 6)"
        ]);
    });

    it('releases Accept once every configured pass has a closed run (the clean projection)', () => {
        const gate = lockCheck(gateView({ story: { summary_critics: 3 }, runs: closedPasses('revision_sel', 5) }));

        // Extra closed rows do not create a debt, and a dial set to fewer critics than the ledger carries
        // is satisfied by its own numbered passes.
        expect(gate.canLock).toBe(true);
        expect(gate.reasons).toEqual([]);
    });

    it('counts the deep review per numbered pass, and stays silent only for an absent runs slice', () => {
        const selected = SELECTED();

        // T11/F1: a PRESENT but empty review family is evidence, not silence — all five passes are owed.
        expect(deepReviewProgress(gateView({ story: { summary_critics: 5 }, runs: [] }), selected)).toEqual({
            closed: 0,
            live: 0,
            owed: 5
        });

        // A review family of ANOTHER draft's rows says nothing about this one; the passes stay owed.
        expect(
            deepReviewProgress(gateView({ story: { summary_critics: 5 }, runs: [reviewRun('revision_old', 1)] }), selected)
        ).toEqual({ closed: 0, live: 0, owed: 5 });

        // A suffixed or extra key is not a numbered pass and cannot substitute for one.
        expect(
            deepReviewProgress(
                gateView({
                    story: { summary_critics: 5 },
                    runs: [
                        { ...reviewRun('revision_sel', 1), work_item_ref: 'wi_review_revision_sel_a1x' },
                        { ...reviewRun('revision_sel', 11), work_item_ref: 'wi_review_revision_sel_a11' }
                    ]
                }),
                selected
            )
        ).toEqual({ closed: 0, live: 0, owed: 5 });

        // Partial: two closed keys (a failed retry of pass 1 is still ONE pass), one live, and another
        // revision's review rows are not this draft's evidence.
        expect(
            deepReviewProgress(
                gateView({
                    story: { summary_critics: 5 },
                    runs: [
                        reviewRun('revision_sel', 1),
                        reviewRun('revision_sel', 1, 'failed'),
                        reviewRun('revision_sel', 2),
                        reviewRun('revision_sel', 3, 'working'),
                        reviewRun('revision_old', 1)
                    ]
                }),
                selected
            )
        ).toEqual({ closed: 2, live: 1, owed: 3 });

        // Complete: every pass has a closed run, so the round's evidence is in.
        expect(
            deepReviewProgress(
                gateView({ story: { summary_critics: 2 }, runs: [reviewRun('revision_sel', 1), reviewRun('revision_sel', 2)] }),
                selected
            )
        ).toEqual({ closed: 2, live: 0, owed: 0 });

        // The pass count is the Author's `summary_critics` (§16.1 job 5); an unset Story falls back to the
        // SHARED default (5), the same one the loop dispatches by.
        expect(deepReviewProgress(gateView({ runs: [reviewRun('revision_sel', 1)] }), selected)).toEqual({
            closed: 1,
            live: 0,
            owed: 4
        });

        // THE ONE LEGACY BRANCH: a payload whose `runs` collection is absent (checked before iterating)
        // says nothing about the review, so nothing is claimed owed.
        expect(
            deepReviewProgress({ ...gateView(), runs: undefined } as unknown as StoryViewData, selected)
        ).toEqual({ closed: 0, live: 0, owed: 0 });
    });

    it('owes no un-dispatchable passes for an Author override of an older-round revision (T11/F1)', () => {
        // The guard the backend dispatches by (work.ts:811): only the round whose selection just closed —
        // `(selected.round ?? 1) === (view.sampling?.round ?? 1)` — can have its review dispatched.
        const olderRound = draft('revision_sel', 'selected', AT, 1);
        const view = gateView({
            story: { summary_critics: 5 },
            // Round 3 is the COMPLETED round (`round`), so `active_round` is 4. The deep-review guard is
            // made against the completed round — `records.ts:deepReviewRoundOf` — NOT the in-flight one:
            // a pass bought for a draft the loop moved past would be answered by nobody (T10/F7).
            sampling: { round: 3, active_round: 4, history: [] } satisfies SamplingView,
            runs: [reviewRun('revision_sel', 1)]
        });

        expect(deepReviewProgress(view, olderRound)).toEqual({ closed: 1, live: 0, owed: 0 });

        // The same rows over the CURRENT round's winner owe every absent pass.
        expect(
            deepReviewProgress({ ...view, sampling: { round: 1, active_round: 2, history: [] } }, SELECTED())
        ).toEqual({
            closed: 1,
            live: 0,
            owed: 4
        });

        // And the gate shows it: an older-round override is not held by work the loop will never run.
        const gate = lockCheck(
            gateView({
                story: { summary_critics: 5 },
                sampling: { round: 3, active_round: 4, history: [] } satisfies SamplingView,
                revisions: [draft('revision_old', 'discarded', '2026-11-11T11:01:00.000Z', 1), olderRound],
                runs: []
            })
        );

        expect(gate.canLock).toBe(true);
        expect(gate.reasons).toEqual([]);
    });

    it('compares supersession against the in-flight round, and falls back honestly without it (T12/P1)', () => {
        // Round 1 closed with `revision_sel`; a round-1 draft the selection outran is retired by
        // `active_round: 2` — the number the projection sends. Drop the field (an older build's payload)
        // and the slice's own `selected` sample is the same evidence: a round COMPLETED, so round 2.
        const closedRoundOne = {
            revisions: [
                draft('revision_old', 'discarded', '2026-11-11T11:01:00.000Z', 1),
                draft('revision_zombie', 'drafted', '2026-11-11T11:02:00.000Z', 1),
                draft('revision_sel', 'selected', AT, 1)
            ],
            findings: []
        };
        const withField = gateView({
            ...closedRoundOne,
            sampling: {
                round: 1,
                active_round: 2,
                history: [{ round: 1, at: AT, samples: [], selected: 'revision_sel' }]
            }
        });

        expect(summaryScopeContext(withField).activeRound).toBe(2);
        expect(
            isSupersededSummaryDraft(
                withField,
                withField.revisions.find((revision) => revision.id === 'revision_zombie')!,
                summaryScopeContext(withField)
            )
        ).toBe(true);

        // The same rows on a payload that predates `active_round`: the projection names the last round's
        // chosen sample iff a selection COMPLETED (§6.6), so the fallback still retires the loser.
        const legacyPayload: StoryViewData = {
            ...withField,
            sampling: { round: 1, history: [], selected: { revision_id: 'revision_sel', critical: 0, high: 0 } } as unknown as SamplingView
        };
        const legacyContext = summaryScopeContext(legacyPayload);

        expect(legacyContext).toMatchObject({ round: 1, activeRound: 2 });
        expect(
            isSupersededSummaryDraft(
                legacyPayload,
                legacyPayload.revisions.find((revision) => revision.id === 'revision_zombie')!,
                legacyContext
            )
        ).toBe(true);

        // And a payload with NO completed round anywhere — no slice at all, the oldest build — answers
        // round 1 for both questions, so nothing is retired on a guess.
        const barePayload: StoryViewData = { ...withField, sampling: undefined };

        expect(summaryScopeContext(barePayload)).toMatchObject({ round: 1, activeRound: 1 });
        expect(
            isSupersededSummaryDraft(
                barePayload,
                barePayload.revisions.find((revision) => revision.id === 'revision_zombie')!,
                summaryScopeContext(barePayload)
            )
        ).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// R7 (this wave) — the CUSTOM-seed arm answers to its OWN gate, not the compiled arm's.
//
// The bug these pins exist for: `PlotlinesHandoff.tsx` gated "Start from your own brief" on
// `plotlinesHandoffRefusal`, whose middle clause is "there is no compiled Summary". That clause is true about the
// COMPILED arm and irrelevant to this one — `server/api/routes.ts` validates `custom` with no `text` (400) BEFORE
// it asks whether anything is compiled (the 409), so a non-empty `custom` start is accepted on a Story whose
// Summary was never written (pinned over there by `api/phrase-start-routes.test.ts`). The desk was blocking a move
// the server allows. Two refusals, each naming the control it describes, is the fix; the notice is the half the
// Author was missing. Every string below is the sentence the Author reads, so it is pinned as an exact value.
// ---------------------------------------------------------------------------
describe('story-contract — the custom-seed start gate (R7, D-76)', () => {
    /** The card's two inputs, as projected facts: the phrase row's started-ness and the compiled flag. */
    const handoffView = (over: { compiled?: boolean; started?: boolean; locked?: boolean } = {}): StoryViewData => {
        const view = fixtureView();

        return {
            ...view,
            story: { ...view.story, summary_locked: over.locked !== false },
            phrase_started: { summary: true, plotlines: over.started === true },
            summary_compiled: over.compiled === true
        };
    };

    const STARTED_SENTENCE =
        'Phrase 2 has already started on this Story: its copied Seed is the text every chapter entry, revision and claim key was written against, so a new Seed means a new Story rather than a re-start (D-72).';

    it('opens the custom arm with no compiled Summary, while the compiled arm stays shut', () => {
        const view = handoffView({ compiled: false });

        expect(summaryIsCompiled(view)).toBe(false);
        // THE ARM IS OPEN. No compiled Summary is one of the two facts this gate reads.
        expect(plotlinesCustomStartRefusal(view, true)).toBe('');
        // And the compiled arm's sentence survives unchanged — the card is partly shut, not blocked, and the
        // default arm is still the one the Author has to wait on (U-16 names the reason for the button that IS shut).
        expect(plotlinesHandoffRefusal(view, true)).toBe(
            'There is no compiled Summary to start Phrase 2 from yet — the Overview (or the reviewed Summary) is the text the phrase copies, so the gate is above this control (R5).'
        );
    });

    it('shuts the custom arm only for the missing verb and a started phrase, the same words the compiled arm uses', () => {
        // U-16: no verb means the field could not be submitted, and the sentence names the shell, not the Summary.
        expect(plotlinesCustomStartRefusal(handoffView({ compiled: false }), false)).toBe(
            'The phrase start route is not available in this shell.'
        );
        // D-72: one-way start. Both arms answer this state with ONE sentence, so the card cannot offer a button the
        // route would refuse with a 409.
        expect(plotlinesCustomStartRefusal(handoffView({ compiled: false, started: true }), true)).toBe(
            STARTED_SENTENCE
        );
        expect(plotlinesHandoffRefusal(handoffView({ compiled: false, started: true }), true)).toBe(STARTED_SENTENCE);
        // A started phrase on a book that IS compiled: still the D-72 sentence, not the R5 one (the order of the
        // clauses is the order the Author meets them).
        expect(plotlinesCustomStartRefusal(handoffView({ compiled: true, started: true }), true)).toBe(
            STARTED_SENTENCE
        );
    });

    it('explains the partly-shut card, and names where the crew goes after the start (L-33)', () => {
        // UNSIGNED — the crew stays on Phrase ①, and the sentence is the Start route's own guard wording
        // (`routes.ts:openPlotlinesOnSignedOffSummary`), capitalized here because it stands alone.
        expect(
            plotlinesCustomStartNotice(handoffView({ compiled: false, locked: false }), true)
        ).toBe(
            'There is no compiled Summary to copy yet, so the compiled arm stays shut — “Start from your own brief” is open, ' +
                'and the text you write there is the Seed the phrase copies (the Start verb takes `source: custom` without a compiled Summary, R5 / D-76). ' +
                'The Summary is not signed off, so the crew stays on Phrase ①: POST /stories/s1/lock is the act that signs phase summary off and opens phase plotlines (L-33: a phase is entered only with every earlier phase locked).'
        );
        // SIGNED OFF — the pointer follows the start, which is the other half of the same rule.
        expect(plotlinesCustomStartNotice(handoffView({ compiled: false }), true)).toBe(
            'There is no compiled Summary to copy yet, so the compiled arm stays shut — “Start from your own brief” is open, ' +
                'and the text you write there is the Seed the phrase copies (the Start verb takes `source: custom` without a compiled Summary, R5 / D-76). ' +
                'This Summary is signed off, so starting Phrase 2 also moves the crew into Phase 2 (the pointer follows a start only when phase ① is locked, L-33).'
        );
        // Nothing to explain when both arms are live…
        expect(plotlinesCustomStartNotice(handoffView({ compiled: true }), true)).toBe('');
        // …and nothing when NEITHER is: with no verb the card renders no custom button at all, so a line claiming
        // that arm is open would be U-16's lie rather than an explanation.
        expect(plotlinesCustomStartNotice(handoffView({ compiled: false }), false)).toBe('');
    });

    // R7 — THE CLEANUP'S SENTENCES. Four guard codes, one sentence each: `SeedCleanupRefusal` is a closed
    // vocabulary (`run/seed-cleanup.ts`), so a desk that folded two of them into one shrug would hide WHICH rule
    // fired — and "the Editor declined" is not something an Author can act on (L-13). Every sentence also says the
    // one thing AC3 needs the Author to know: their own text still stands, because there was no proposal to confirm.
    it('names the proofread’s four refusals apart, and never as a failure', () => {
        expect(seedCleanupRefusalNotice('empty_answer')).toBe(
            'The Editor answered with nothing usable, so there is no proposal — your own text stands, and nothing was written (R7).'
        );
        // THE ONE AN AUTHOR WOULD OTHERWISE NOT NOTICE: a dropped digit changes the brief's facts, not its grammar.
        expect(seedCleanupRefusalNotice('numbers_lost')).toBe(
            'The rewrite dropped a number you wrote — a chapter count, a deadline, an age — so the Editor threw it away rather than proofread your facts away. Your own text stands (R7).'
        );
        expect(seedCleanupRefusalNotice('too_short')).toBe(
            'The rewrite came back shorter than your brief, so it was summarising rather than correcting — there is no proposal, and your own text stands (R7).'
        );
        expect(seedCleanupRefusalNotice('too_long')).toBe(
            'The rewrite came back longer than your brief, so it was expanding rather than correcting — there is no proposal, and your own text stands (R7).'
        );
    });

    it('gates the ask on the two facts the route gates it on', () => {
        // NO VERB: U-16's standing rule — a shut control names the missing route.
        expect(seedCleanupAskRefusal('Six chapters, alternating timeline.', false)).toBe(
            'This shell has no Editor proofread route wired, so there is nothing to ask.'
        );
        // A BLANK BOX: the route 400s rather than spend a model call on an answer it already knows.
        expect(seedCleanupAskRefusal('   \n  ', true)).toBe(
            'Write your brief first — the proofread reads the text in this box, and there is nothing to correct yet.'
        );
        // LIVE. Note what is NOT in this gate: `summary_compiled` — the cleanup belongs to the arm whose Seed is
        // already in the Author's hand, and the compiled arm's wait is not this control's problem (AC6).
        expect(seedCleanupAskRefusal('Six chapters, alternating timeline.', true)).toBe('');
    });

    // F4 — THE THIRD FACT, and the only one the route cannot tell the desk about. The proofread read carries the
    // draft in the address (`dashboard/api.ts:1870` → `?seed=${encodeURIComponent(seed)}`), so an over-long
    // draft dies in the listener's request line BEFORE routing: the desk gets HTTP 431, no
    // `SeedCleanupRefusal`, and nothing to print. Measured on the real listener — the route answers (404, i.e.
    // it routed) at an escaped seed of 16,200 and returns 431 at 16,300, and the same 431 lands at an escaped
    // 18,080 while an escaped 12,056 still routes (`Temp/c9/probe-f4.ts`, `Temp/c9/probe-f4.out`). The limit is
    // the round number under that: 12,000 escaped characters, ≈4,300 (≈26 %) of margin below the failure point,
    // which also covers the 53-character path prefix and the rest of the request line.
    it('shuts the ask when the draft will not fit the address it travels in (F4)', () => {
        expect(SEED_CLEANUP_ASK_URL_LIMIT).toBe(12_000);

        // The sentence, in full, because a refusal an Author reads IS the product (L-13): it names the fix
        // (paste less), says the text is untouched (AC3), and never reads as a failure the desk caused.
        const TOO_LONG =
            'That draft is too long for this ask — the proofread sends it inside the request’s address, and an ' +
            'address past about 12,000 escaped characters comes back refused (HTTP 431) before the Editor reads a ' +
            'word. Paste the part you want proofread — a chapter or two at a time — and the ask opens again; your ' +
            'text in this box stands.';

        // EXACTLY AT THE LIMIT: the guard fires past the budget, not at it, and the escaped form is the axis.
        const atLimit = 'x'.repeat(SEED_CLEANUP_ASK_URL_LIMIT);

        expect(atLimit.length).toBe(12_000);
        expect(encodeURIComponent(atLimit).length).toBe(12_000);
        expect(seedCleanupAskRefusal(atLimit, true)).toBe('');

        // ONE PAST IT: refused, in the desk's own words.
        const overLimit = 'x'.repeat(SEED_CLEANUP_ASK_URL_LIMIT + 1);

        expect(encodeURIComponent(overLimit).length).toBe(12_001);
        expect(seedCleanupAskRefusal(overLimit, true)).toBe(TOO_LONG);

        // THE ARM THAT MAKES THE GUARD NECESSARY — pasted characters are not wire characters. A space is `%20`,
        // so 9,006 characters of ordinary prose escape to 12,008: a guard on the pasted length would dial the
        // very request the transport refuses, which is the bug this clause closes.
        const pasted = 'light '.repeat(1_501);

        expect(pasted.length).toBe(9_006);
        expect(encodeURIComponent(pasted).length).toBe(12_008);
        expect(seedCleanupAskRefusal(pasted, true)).toBe(TOO_LONG);

        // The other two clauses keep their precedence: with no verb the missing-route sentence is still the
        // answer, and a blank box is blank before it is long.
        expect(seedCleanupAskRefusal(overLimit, false)).toBe(
            'This shell has no Editor proofread route wired, so there is nothing to ask.'
        );
        // AC3's standing clause.
        expect(TOO_LONG).toContain('your text in this box stands');
    });

    it('says what the card may claim about the text it is showing (R7 / D-72)', () => {
        // A SUGGESTION THAT LOOKS APPLIED. The card is showing the Author a better sentence than the one they
        // typed, and the natural reading of a highlighted suggestion in every other editor is "done". Here nothing
        // is done until the Start press, so the note has to say so in the same breath.
        expect(SEED_CLEANUP_PROPOSAL_NOTE).toBe(
            'Nothing has changed yet. This is the Editor’s proofread of the brief above — grammar, spelling, punctuation and typos, nothing else — and the only act that records it is your next “Start Phrase 2 from this Seed” press, which copies the text now in the box (R7 / D-72).'
        );
        // `changed: false` is an ANSWER, not a miss, and the Author needs to hear that the pass actually read it.
        expect(SEED_CLEANUP_NOTHING_TO_FIX).toBe(
            'The Editor read your brief and found nothing to fix — its grammar is already clean. Nothing was written, and the Start press copies your text exactly as it stands.'
        );
        // AFTER "Use this text": the box changed on screen, so the line has to name what did NOT happen.
        expect(SEED_CLEANUP_APPLIED_NOTE).toBe(
            'The box now holds the Editor’s version. Nothing has been recorded yet — the next “Start Phrase 2 from this Seed” press is the act that copies it into the phrase, and it copies exactly the text you can read here (R7 / D-72).'
        );
    });

    // R12 — THE RECEIPT CREDITS THE RIGHT HAND. `seed_source` is written once, at the start, by the Start route;
    // the projection OMITS it for a row that predates the field, and the desk has three wordings because there are
    // three facts. Guessing `compiled` for the third would tell an Author their own typed brief was the crew's
    // Overview, which is the reverse of what R12 records.
    it('calls a copied Seed by the name the row actually carries (R12)', () => {
        expect(plotlinesSeedOrigin('compiled')).toBe('the Summary the crew compiled');
        expect(plotlinesSeedOrigin('custom')).toBe('the brief you wrote and started on');
        // ABSENT MEANS UNKNOWN — and the wording says "never recorded", not "the crew's".
        expect(plotlinesSeedOrigin(undefined)).toBe(
            'text whose origin this desk never recorded — the phrase started before the Seed’s provenance was kept'
        );
    });
});
