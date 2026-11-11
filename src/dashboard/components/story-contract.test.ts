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
    diffWords,
    draftVerdicts,
    earlierDecisionOf,
    formatElapsed,
    groupChapters,
    hasEditorRole,
    isLiveRun,
    isPanelRole,
    isVerifiedIdea,
    lockCheck,
    panelDissent,
    patchOf,
    phaseLocks,
    phasesAfter,
    pendingProposalsFor,
    runsStoppedByPause,
    revisionBodyText,
    undoTargetFor
} from './story-contract';
import { NOW, fixtureCompletion, fixtureRuns, fixtureTemplates, fixtureView } from './story-fixtures';

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
            'Backtrack to ① Summary deletes 4 chapters with their 4 revisions, 2 plotlines, and the derived Digest. ' +
                'Verdicts and findings survive as provenance; the Ideas do not — the lock already deleted them (D-25, D-36, L-31). ' +
                'Story "Neon Cathedral" starts again from its Seed.'
        );
        expect(backtrackStatement(view.story, 'plotlines', view)).toBe(
            'Backtrack to ② Plotlines deletes 4 chapters with their 4 revisions and unlocks every plotline. ' +
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
