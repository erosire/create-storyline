// U-4 … U-17 — the Story view after the phrase redesign.
//
// What is pinned here is the NEW contract: the content area renders exactly ONE phrase or folder,
// the rail's selection is the only way to change it, the Summary's tick marks review readiness,
// and the two phase controls still write the routes their panes have always written.
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { StoryView } from './StoryView';
import { click } from '../testing/shell-fakes';
import { buildRevisionUnits } from './story-contract';
import type { Finding, Revision, Verdict } from '../../shared/types';
import { NOW, fixtureActions, fixtureCompletion, fixtureReviewRuns, fixtureStory, fixtureView } from './story-fixtures';

function renderView(props: Partial<Parameters<typeof StoryView>[0]> = {}) {
    const harness = fixtureActions();
    const view = render(<StoryView view={fixtureView()} actions={harness.actions} now={NOW} {...props} />);
    return { ...harness, ...view };
}

/** A Story still in the Summary, with the fixture's failing Goal — the lock's gate has a reason. */
function summaryPhaseView() {
    const view = fixtureView();
    return {
        ...view,
        story: {
            ...view.story,
            phase: 'summary' as const,
            summary_locked: false,
            status: 'ready' as const,
            pending_kind: 'none' as const,
            status_reason: undefined
        }
    };
}

describe('StoryView — one selected phrase in the content area', () => {
    it('opens on the Summary only: no stacked Seed, dial, ideas, chapters, goal or digest', () => {
        const { container } = renderView();

        expect(container.querySelector('.sv-summary')).toBeTruthy();
        // The revision section renders; how many cards it may print is R1's, pinned below.
        expect(container.querySelector('.sv-summary-revisions')).toBeTruthy();
        expect(container.querySelector('.sv-ideas')).toBeNull();
        expect(container.querySelector('.sv-chapters')).toBeNull();
        expect(container.querySelector('.sv-goal')).toBeNull();
        expect(container.querySelector('.sv-digest')).toBeNull();
        expect(screen.queryByRole('region', { name: 'Seed' })).toBeNull();
        expect(screen.queryByRole('navigation', { name: 'Story phases' })).toBeNull();
        // U-1c: the status line is the one piece of context outside the pane.
        expect((container.querySelector('.sv-story-status-badge') as HTMLElement).textContent).toBe('needs your pick');
        expect(
            screen.getByText('The Reader proposed three directions; the Author has not chosen one (D-28).')
        ).toBeTruthy();
        // The fixture Story has a signed Summary, so the review tick is present.
        expect(container.querySelector('.sv-summary-ready')).toBeTruthy();
    });

    it('loads the clicked phrase or folder and nothing else', () => {
        const view = fixtureView();
        const harness = fixtureActions();
        const { container, rerender } = render(
            <StoryView view={view} actions={harness.actions} now={NOW} selection={{ panel: 'characters' }} />
        );

        expect(screen.getByRole('region', { name: 'Characters' })).toBeTruthy();
        expect(screen.getByText('Hale')).toBeTruthy();
        expect(container.querySelector('.sv-summary')).toBeNull();

        rerender(<StoryView view={view} actions={harness.actions} now={NOW} selection={{ panel: 'plotlines' }} />);
        expect(screen.getByRole('region', { name: 'Plotlines' })).toBeTruthy();
        expect(container.querySelectorAll('.plot-card').length).toBe(2);
        expect(container.querySelector('.sv-chapters')).toBeNull();

        rerender(<StoryView view={view} actions={harness.actions} now={NOW} selection={{ panel: 'chapters' }} />);
        expect(screen.getByRole('region', { name: 'Plotlines and chapters' })).toBeTruthy();
        expect(container.querySelectorAll('.sv-chapter-row').length).toBe(4);

        rerender(<StoryView view={view} actions={harness.actions} now={NOW} selection={{ panel: 'goal' }} />);
        expect(screen.getByRole('region', { name: 'Goal' })).toBeTruthy();

        rerender(<StoryView view={view} actions={harness.actions} now={NOW} selection={{ panel: 'findings' }} />);
        expect(screen.getByRole('region', { name: 'Findings' })).toBeTruthy();
        expect(screen.getByText('Act two changes nothing')).toBeTruthy();
    });

    it('narrows a phrase to the one entry the rail clicked', () => {
        const view = fixtureView();
        const harness = fixtureActions();
        const { container, rerender } = render(
            <StoryView view={view} actions={harness.actions} now={NOW} selection={{ panel: 'plotlines', ref: 'p2' }} />
        );

        expect(container.querySelectorAll('.plot-card').length).toBe(1);
        expect(screen.getByText('Ghost Index')).toBeTruthy();

        rerender(
            <StoryView view={view} actions={harness.actions} now={NOW} selection={{ panel: 'chapters', ref: 'c2' }} />
        );
        expect(container.querySelectorAll('.sv-chapter-row').length).toBe(1);
        expect(screen.getByText('Plotline 2 — Ghost Index')).toBeTruthy();
    });
});

describe('StoryView — the Summary review and its tick (U-4, U-13, D-21, D-24)', () => {
    it('keeps a competing draft the review recommends out of the ordinary list (R1, U-13)', () => {
        const view = fixtureView();
        const unit = buildRevisionUnits(view).find((candidate) => candidate.unitKind === 'summary')!;
        const seed = unit.revisions[0]!;
        const rival: Revision = {
            ...seed,
            id: 'rv-sum-b',
            body: { premise: 'A drowned archive elects its next reader.', ending: 'The index elects her.' },
            created_at: '2026-11-11T11:00:00.000Z',
            updated_at: '2026-11-11T11:00:00.000Z'
        };
        const verdict: Verdict = {
            id: 'v-sum',
            rev: 1,
            created_at: '2026-11-11T11:01:00.000Z',
            updated_at: '2026-11-11T11:01:00.000Z',
            story_id: 's1',
            target_ref: 'rv-sum-b',
            target_kind: 'summary',
            round: 1,
            criteria_passed: [{ criterion: 'C-14', result: true, evidence: 'the Summary speaks the Seed' }],
            hard_pass: true,
            soft_count: 1,
            recommendation: 'advance'
        };
        const reviewed = {
            ...view,
            revisions: [...view.revisions, rival],
            verdicts: [...(view.verdicts ?? []), verdict]
        };
        const harness = fixtureActions();

        render(<StoryView view={reviewed} actions={harness.actions} now={NOW} selection={{ panel: 'summary' }} />);

        // R1: nothing on this Story is `selected`, so the pane prints NO card. The draft whose newest verdict
        // advances (`recommendedRevisionId`) is still a candidate, and a candidate has no card in the ordinary
        // Summary list — its prose may not appear there at all.
        expect(document.querySelectorAll('.sv-summary-draft')).toHaveLength(0);
        expect(document.body.textContent).not.toContain('A drowned archive elects its next reader.');
        expect(document.querySelector('.sv-summary-draft-pick')).toBeNull();
        expect(document.body.textContent).not.toContain('Editor recommends');
        expect(screen.getByText('No current Summary revision.')).toBeTruthy();
        // U-13's Select was the only writer of the override route, so nothing offers it: the pane does not ask
        // the Author to re-take a decision the round owns (D-24 stays a rail/legacy path, not this list's).
        expect(document.querySelector('.sv-summary-draft-select')).toBeNull();
        expect(harness.calls.selectRevision).toBeUndefined();
    });

    it('does not claim a recommendation when no verdict advanced a draft', () => {
        renderView();

        expect(document.querySelector('.sv-summary-draft-pick')).toBeNull();
    });

    it('locks the Summary through the phase gate only while it is the current phase', async () => {
        const view = summaryPhaseView();
        const harness = fixtureActions();
        render(<StoryView view={view} actions={harness.actions} now={NOW} selection={{ panel: 'summary' }} />);

        const lock = document.querySelector('.sv-lock-button') as HTMLButtonElement;
        expect(lock.disabled).toBe(true);
        expect(lock.getAttribute('title')).toContain('the Goal has not passed: C-8, C-11 still failing');
        expect(lock.textContent).toBe('Accept final Summary → Phrase 2');

        // "Not final yet" is a queue entry, not a backtrack: no draft is deleted.
        await click(screen.getByRole('button', { name: 'Request another revision round' }));
        expect(harness.calls.requestSummaryRevision).toEqual([['s1']]);

        // The gate clears: Goal passes and the phase's tray is decided.
        const cleared = {
            ...view,
            goal: { ...view.goal, failing: [] },
            revisions: view.revisions.map((revision) =>
                revision.unit_kind === 'summary' ? { ...revision, state: 'selected' as const } : revision
            ),
            // T11/F1: a clean phase-① projection is a REVIEWED one. The round settled on `rv-sum-a`, so
            // the wire carries its five closed deep-review claims — without them the gate owes every pass,
            // which is the honest reading of an unread Summary (the next case pins that).
            runs: [...view.runs, ...fixtureReviewRuns('rv-sum-a')],
            ideas: view.ideas.map((idea) => ({ ...idea, state: 'selected' as const }))
        };
        render(<StoryView view={cleared} actions={harness.actions} now={NOW} selection={{ panel: 'summary' }} />);
        const locks = screen.getAllByRole('button', { name: 'Accept final Summary → Phrase 2' });
        const enabled = locks[locks.length - 1] as HTMLButtonElement;
        expect(enabled.disabled).toBe(false);

        await click(enabled);
        await click(screen.getByRole('button', { name: 'Confirm' }));
        expect(harness.calls.lockPhase).toEqual([['s1']]);
    });
});

describe('StoryView — the Summary pane prints ONE card, and the override lives on the opened revision (R1, T4)', () => {
    /**
     * Phase ① several rounds deep, which is what the reported screenshot was. A settled round leaves its
     * `selected` row on the record, so two rounds mean TWO `selected` rows (story-contract.ts:522-530); one
     * loser is parked with its reason, and a third draft is still `drafted`. The rail's indexes follow
     * creation order, so these are Revision 1…4 — and the pane may print only Revision 3.
     *
     * The one `advance` verdict is filed on the live draft, so `story-nav.recommendedRevisionId` names
     * `rv-round-3`: in real wiring the recommended row is always a CANDIDATE (`summaryRevisionUnit` offers
     * only those), which is exactly the row R1 keeps out of the overview (T4).
     */
    function multiRoundSummaryView() {
        const base = summaryPhaseView();

        const row = (
            id: string,
            state: Revision['state'],
            at: string,
            premise: string,
            extra: Partial<Revision> = {}
        ): Revision => ({
            id,
            rev: 1,
            created_at: at,
            updated_at: at,
            story_id: 's1',
            unit_kind: 'summary',
            unit_ref: 'sum1',
            body: { fields: { premise } },
            run_ref: 'r-pick',
            template_ref: 't-builtin',
            state,
            verdict_refs: [],
            ...extra
        });

        const recommended: Verdict = {
            id: 'v-round-3',
            rev: 1,
            created_at: '2026-11-11T10:47:00.000Z',
            updated_at: '2026-11-11T10:47:00.000Z',
            story_id: 's1',
            target_ref: 'rv-round-3',
            target_kind: 'summary',
            round: 3,
            // No `finding_ref`: the pass is the review's reading of the draft, not a claim that would
            // renumber this revision's findings and pull this case off its own subject.
            criteria_passed: [{ criterion: 'C-14', result: true, evidence: 'the draft speaks the Seed' }],
            hard_pass: true,
            soft_count: 0,
            recommendation: 'advance'
        };

        return {
            ...base,
            // The fixture's own `competing` Summary draft is dropped: this view is the settled Story, and a
            // second live draft would hold the readiness tick for a reason this case is not about.
            revisions: [
                ...base.revisions.filter((revision) => revision.unit_kind !== 'summary'),
                row('rv-round-1', 'selected', '2026-11-11T10:30:00.000Z', 'Round one: the city remembers by drowning.'),
                row('rv-round-2-loser', 'discarded', '2026-11-11T10:35:00.000Z', 'Round two, first cut: the index speaks first.', {
                    discard_reason: 'the kept draft names its price in the first paragraph'
                }),
                row('rv-round-2', 'selected', '2026-11-11T10:40:00.000Z', 'Round two: the archive keeps what the water takes.'),
                row('rv-round-3', 'drafted', '2026-11-11T10:45:00.000Z', 'Round three, still being written.')
            ],
            verdicts: [...(base.verdicts ?? []), recommended]
        };
    }

    it('renders the newest accepted revision, never the older accepted row or the live draft', () => {
        const view = multiRoundSummaryView();
        const harness = fixtureActions();

        render(<StoryView view={view} actions={harness.actions} now={NOW} selection={{ panel: 'summary' }} />);

        // `selectedSummaryRevision` resolves Revision 3 (`rv-round-2`, newest `selected`), so that row is the
        // only card. Asserted as the (state, label) pair, so neither the older accepted row nor a reshuffle
        // can pass, and the pane's own heading agrees with the card count.
        expect(
            Array.from(document.querySelectorAll<HTMLElement>('.sv-summary-draft')).map((card) => [
                card.dataset.state,
                card.querySelector('.sv-summary-draft-label')?.textContent
            ])
        ).toEqual([['selected', 'Revision 3']]);
        expect(screen.getByText('Revisions · 1')).toBeTruthy();
        expect(screen.getByText('Round two: the archive keeps what the water takes.')).toBeTruthy();

        // The three rows the record still holds — Revision 1's accepted text, Revision 2's parked text and
        // Revision 3's live draft — print nothing here, and no card is offered back to the Author.
        for (const hidden of [
            'Round one: the city remembers by drowning.',
            'Round two, first cut: the index speaks first.',
            'Round three, still being written.'
        ]) {
            expect(document.body.textContent).not.toContain(hidden);
        }
        expect(document.body.textContent).not.toContain('Use this revision');
        expect(document.body.textContent).not.toContain('Discard reason');
        // T4: the review recommends the LIVE draft (Revision 4) and R1 keeps that draft off the overview, so
        // the advisory rides with the hidden row instead of being painted on a card it cannot describe.
        expect(document.querySelector('.sv-summary-draft-pick')).toBeNull();
        expect(document.body.textContent).not.toContain('Review recommends');
        const overviewAction = document.querySelector<HTMLButtonElement>('.sv-summary-draft-select')!;

        expect([overviewAction.textContent, overviewAction.disabled]).toEqual(['Selected', true]);
        expect(harness.calls.selectRevision).toBeUndefined();
    });

    it('still opens any older revision the rail clicks, parked ones included', () => {
        const view = multiRoundSummaryView();
        const harness = fixtureActions();
        const { rerender } = render(
            <StoryView view={view} actions={harness.actions} now={NOW} selection={{ panel: 'summary' }} />
        );

        // The pane's cut is a DISPLAY cut. `story-nav.summaryRevisions` is unfiltered, so the rail still lists
        // Revision 1…4 and a click lands on the row it names — here the parked loser, whose fields and
        // recorded discard reason only ever render in the focused view (T4/R1).
        rerender(
            <StoryView
                view={view}
                actions={harness.actions}
                now={NOW}
                selection={{ panel: 'summary', ref: 'revision:rv-round-2-loser' }}
            />
        );

        const pane = screen.getByRole('region', { name: 'Summary — Revision 2' });

        expect(pane.querySelector('.sv-pane-badge')?.textContent).toBe('discarded · 0 findings');
        expect(screen.getByText('Round two, first cut: the index speaks first.')).toBeTruthy();
        expect(screen.getByText('Discard reason: the kept draft names its price in the first paragraph')).toBeTruthy();
        // T4: the row is opened for its DETAIL, not for a write — the override is printed but disabled, and
        // no advisory claims a row the review never advanced.
        const parkedAction = pane.querySelector<HTMLButtonElement>('.sv-summary-draft-select')!;

        expect([parkedAction.textContent, parkedAction.disabled]).toEqual(['Discarded', true]);
        expect(pane.querySelector('.sv-summary-draft-pick')).toBeNull();
        // The ordinary list is gone while one revision is open, exactly as before.
        expect(document.querySelector('.sv-summary-drafts')).toBeNull();
        expect(document.body.textContent).not.toContain('Round two: the archive keeps what the water takes.');
    });

    it('offers the override and the advisory on the candidate the rail opens (T4, U-13, D-24)', async () => {
        const view = multiRoundSummaryView();
        const harness = fixtureActions();
        const { rerender } = render(
            <StoryView view={view} actions={harness.actions} now={NOW} selection={{ panel: 'summary' }} />
        );

        // The rail opens Revision 4 — the live `drafted` row R1 keeps off the overview. `StoryView` resolves
        // it against `summaryRevisionUnit` (the contract's candidate list: reviewable, not superseded), so
        // this is the surface where the Author's override still exists.
        rerender(
            <StoryView
                view={view}
                actions={harness.actions}
                now={NOW}
                selection={{ panel: 'summary', ref: 'revision:rv-round-3' }}
            />
        );

        const pane = screen.getByRole('region', { name: 'Summary — Revision 4' });

        expect(pane.querySelector('.sv-pane-badge')?.textContent).toBe('drafted · 0 findings');
        expect(screen.getByText('Round three, still being written.')).toBeTruthy();
        // The advisory marks the row its verdict names, in phase ①'s own wording (T11/F5).
        expect(pane.querySelector('.sv-summary-draft-pick')?.textContent).toBe('Review recommends');

        const action = pane.querySelector<HTMLButtonElement>('.sv-summary-draft-select')!;

        expect([action.textContent, action.disabled]).toEqual(['Use this revision', false]);

        await click(action);

        // The same callback with the same signature as before the redesign: the Summary's id, then the
        // revision's (`POST /stories/s1/revisions/rv-round-3/select`, D-24).
        expect(harness.calls.selectRevision).toEqual([['sum1', 'rv-round-3']]);

        // The mark and the write do not follow the Author to a row nobody advanced: open the row ON RECORD
        // and the pane shows the state, a disabled button, and no advisory.
        rerender(
            <StoryView
                view={view}
                actions={harness.actions}
                now={NOW}
                selection={{ panel: 'summary', ref: 'revision:rv-round-2' }}
            />
        );

        const accepted = screen.getByRole('region', { name: 'Summary — Revision 3' });
        const acceptedAction = accepted.querySelector<HTMLButtonElement>('.sv-summary-draft-select')!;

        expect(accepted.querySelector('.sv-pane-badge')?.textContent).toBe('selected · 0 findings');
        expect(accepted.querySelector('.sv-summary-draft-pick')).toBeNull();
        expect([acceptedAction.textContent, acceptedAction.disabled]).toEqual(['Selected', true]);
        // Nothing else wrote the route either.
        expect(harness.calls.selectRevision).toEqual([['sum1', 'rv-round-3']]);
    });

    it('keeps the override off a drafted row the loop has already moved past (T4 supersession)', () => {
        // T11/F2's exclusion: a `drafted` row of an OLDER round is not an offer — the projection says the
        // active round is 2 while this draft's `round` is 1, so `isSupersededSummaryDraft` drops it from
        // `summaryRevisionUnit`, the same list `server/loop/phase1-round-parity.test.ts` pins as the
        // Author's override. The rail can still open it; the write stays refused.
        const base = summaryPhaseView();
        const harness = fixtureActions();
        const superseded: Revision = {
            id: 'rv-round-1-live',
            rev: 1,
            created_at: '2026-11-11T10:50:00.000Z',
            updated_at: '2026-11-11T10:50:00.000Z',
            story_id: 's1',
            unit_kind: 'summary',
            unit_ref: 'sum1',
            body: { fields: { premise: 'Round one, the cut nobody kept.' } },
            run_ref: 'r-pick',
            template_ref: 't-builtin',
            state: 'drafted',
            round: 1,
            verdict_refs: []
        };

        render(
            <StoryView
                view={{
                    ...base,
                    revisions: [
                        ...base.revisions.filter((revision) => revision.unit_kind !== 'summary'),
                        { ...superseded, id: 'rv-keep', state: 'selected', round: 1, created_at: '2026-11-11T10:30:00.000Z', body: { fields: { premise: 'The kept first revision.' } } },
                        superseded
                    ],
                    sampling: { round: 1, active_round: 2, history: [] }
                }}
                actions={harness.actions}
                now={NOW}
                selection={{ panel: 'summary', ref: 'revision:rv-round-1-live' }}
            />
        );

        const pane = screen.getByRole('region', { name: 'Summary — Revision 2' });
        const action = pane.querySelector<HTMLButtonElement>('.sv-summary-draft-select')!;

        // The row reads as what it is, and the button explains why it cannot be taken. (The label itself is
        // the card's pre-existing bucket for any state the Author cannot select — nothing widened here.)
        expect(pane.querySelector('.sv-pane-badge')?.textContent).toBe('drafted · 0 findings');
        expect(screen.getByText('Round one, the cut nobody kept.')).toBeTruthy();
        expect(action.disabled).toBe(true);
        expect(action.getAttribute('title')).toBe('This revision is drafted.');
        expect(pane.querySelector('.sv-summary-draft-pick')).toBeNull();
        expect(harness.calls.selectRevision).toBeUndefined();
    });
});

describe('StoryView — the Accept blocker is never invisible on the revision it blocks (T5, T11)', () => {
    /** The Summary on record: one `selected` draft, no round left competing, Goal and tray clean. */
    function cleanSummaryPhase(finding?: Finding) {
        const base = summaryPhaseView();
        const winner: Revision = {
            id: 'rv-picked',
            rev: 1,
            created_at: '2026-11-11T11:03:00.000Z',
            updated_at: '2026-11-11T11:03:00.000Z',
            story_id: 's1',
            unit_kind: 'summary',
            unit_ref: 'sum1',
            body: { fields: { premise: 'A flooded city keeps its memory in a sealed cathedral of data.' } },
            run_ref: 'r-pick',
            template_ref: 't-builtin',
            state: 'selected',
            // The round the projection reports as in flight (T11/F1): the deep review of THIS draft is
            // dispatchable, so its passes are work the round owes until they close.
            round: 1,
            verdict_refs: []
        };

        return {
            ...base,
            // The dial is OFF, so a `confirmed` critical is the Author's decision (D-34) — the state the
            // reported screenshot was in, where the old copy promised "the next round".
            story: { ...base.story, auto_approve: [] },
            goal: { ...base.goal, failing: [] },
            ideas: [],
            revisions: [winner],
            findings: finding === undefined ? [] : [finding],
            // T11/F1: an honest clean baseline is a REVIEWED round — five closed `wi_review_rv-picked_aN`
            // claims plus the sampling slice naming the round. `runs: []` alone would be an unread
            // Summary, and the gate says so (the case below pins that).
            runs: fixtureReviewRuns('rv-picked'),
            // T12/P1: round 1 is the round that CLOSED on `rv-picked` (its deep review is owed for it) and
            // round 2 is the one in flight; the pane's Accept gate reads the first, supersession the second.
            sampling: { round: 1, active_round: 2, history: [] }
        };
    }

    /** The whole-artifact spelling: `target_ref` is the Summary and no `related_refs` names a draft. */
    const WHOLE_ARTIFACT: Finding = {
        id: 'f-legacy',
        rev: 1,
        created_at: '2026-11-11T11:04:00.000Z',
        updated_at: '2026-11-11T11:04:00.000Z',
        story_id: 's1',
        target_ref: 'sum1',
        criterion_ref: 'C-14',
        title: 'The Summary keeps one voice too many',
        evidence: 'round 2, ¶1 — the index and the curator speak alike.',
        cost: 'critical',
        fingerprint: 'fp-legacy',
        state: 'confirmed',
        seen_count: 1
    };

    it('shows on the open Revision the finding that disables Accept, in the engine\u2019s words', () => {
        render(
            <StoryView
                view={cleanSummaryPhase(WHOLE_ARTIFACT)}
                actions={fixtureActions().actions}
                now={NOW}
                selection={{ panel: 'summary', ref: 'revision:rv-picked' }}
            />
        );

        // 1. The gate: disabled, and its reason names the finding — never an Editor choice phase ① lacks.
        const lock = document.querySelector('.sv-lock-button') as HTMLButtonElement;
        expect(lock.disabled).toBe(true);
        expect(Array.from(document.querySelectorAll('.sv-lock-reasons li')).map((line) => line.textContent)).toEqual([
            '1 critical/major finding on the selected Summary awaiting your approval — nothing is queued until the Author decides (D-34)'
        ]);
        expect(lock.getAttribute('title')).toBe(
            'Not yet: 1 critical/major finding on the selected Summary awaiting your approval — nothing is queued until the Author decides (D-34)'
        );

        // 2. The pane open on THAT revision: the same row is listed, so "No Reader findings on this
        //    revision yet" cannot sit beside the blocker (the reported contradiction).
        expect(document.querySelector('.sv-summary-focus-empty')).toBeNull();
        expect((document.querySelector('.find-title') as HTMLElement).textContent).toBe(
            'The Summary keeps one voice too many'
        );
        expect((document.querySelector('.sv-summary-current-title') as HTMLElement).textContent).toBe('Findings · 1');
    });

    it('leaves a clean selected revision enabled, with no reason list at all (no invented blocker)', () => {
        const { container } = render(
            <StoryView
                view={cleanSummaryPhase()}
                actions={fixtureActions().actions}
                now={NOW}
                selection={{ panel: 'summary', ref: 'revision:rv-picked' }}
            />
        );

        // T11/F1: this is enabled because the projection PROVES the review finished — five closed passes
        // for the winner of the round `sampling.round` reports. A projection without them is not clean.
        expect((document.querySelector('.sv-lock-button') as HTMLButtonElement).disabled).toBe(false);
        expect(container.querySelector('.sv-lock-reasons')).toBeNull();
        expect(container.querySelector('.sv-summary-focus-empty')?.textContent).toBe(
            'No Reader findings on this revision yet.'
        );
    });

    it('holds Accept over a settled round the deep review has not read yet (T11/F1)', () => {
        // Everything the Author controls is done — Goal passing, tray empty, the round settled on its
        // winner — and the review family has dispatched no pass. Accept must stay shut, naming the wait.
        render(
            <StoryView
                view={{ ...cleanSummaryPhase(), runs: [] }}
                actions={fixtureActions().actions}
                now={NOW}
                selection={{ panel: 'summary', ref: 'revision:rv-picked' }}
            />
        );

        const lock = document.querySelector('.sv-lock-button') as HTMLButtonElement;

        expect(lock.disabled).toBe(true);
        expect(Array.from(document.querySelectorAll('.sv-lock-reasons li')).map((line) => line.textContent)).toEqual([
            "5 deep-review passes still owed on the selected Summary revision — the round's evidence is not complete (§6.4 step 6)"
        ]);
    });
});

describe('StoryView — Characters can be started and updated (Phrase 2)', () => {
    it('starts the cast from the Summary with one directive, and only when there is no cast', async () => {
        const empty = { ...fixtureView(), cast: [] };
        const harness = fixtureActions();
        render(<StoryView view={empty} actions={harness.actions} now={NOW} selection={{ panel: 'characters' }} />);

        expect(screen.getByText('No characters yet')).toBeTruthy();
        await click(screen.getByRole('button', { name: 'Start Characters' }));
        expect(harness.calls.sendDirective?.[0]?.[0]).toBe('s1');
        expect(String(harness.calls.sendDirective?.[0]?.[1])).toContain('Build the Characters from the Summary');
    });

    it('shows the cast sheet and offers an update from the current Summary', async () => {
        const harness = fixtureActions();
        render(
            <StoryView view={fixtureView()} actions={harness.actions} now={NOW} selection={{ panel: 'characters' }} />
        );

        expect(screen.getAllByText('Hale').length).toBeGreaterThan(0);
        expect(screen.getByText('From archivist to trespasser to author of the record.')).toBeTruthy();
        expect(screen.getByText('Holds the refusal citation; no longer trusts the badge system.')).toBeTruthy();

        await click(screen.getByRole('button', { name: 'Update from the Summary' }));
        expect(String(harness.calls.sendDirective?.[0]?.[1])).toContain('Update the Characters');
    });
});

describe('StoryView — the folders keep their own verbs (U-10a, U-14, U-15, D-35)', () => {
    it('writes an Idea selection with the note that makes it a recorded decision (U-15, D-29)', async () => {
        const harness = fixtureActions();
        render(<StoryView view={fixtureView()} actions={harness.actions} now={NOW} selection={{ panel: 'ideas' }} />);

        await click(
            within(document.querySelector('.sv-idea-verified') as HTMLElement).getByRole('button', { name: 'Select' })
        );
        expect(harness.calls.selectIdea).toEqual([['s1', 'i-verified', 'selected by the Author']]);
    });

    it('keeps the auto-approve dial as one write of the whole set (D-35, D-35b)', async () => {
        const harness = fixtureActions();
        render(
            <StoryView view={fixtureView()} actions={harness.actions} now={NOW} selection={{ panel: 'settings' }} />
        );

        expect((screen.getByLabelText('critical auto-approve') as HTMLInputElement).checked).toBe(true);
        expect((screen.getByLabelText('taste auto-approve') as HTMLInputElement).checked).toBe(false);

        await click(screen.getByLabelText('major auto-approve'));
        expect(harness.calls.setAutoApprove).toEqual([['s1', ['critical']]]);
    });

    it('puts completion on the Chapters pane, with the discard counted before the accept (U-14, L-25b)', async () => {
        const harness = fixtureActions();
        const view = fixtureView({ completion: fixtureCompletion() });
        render(
            <StoryView
                view={view}
                actions={harness.actions}
                now={NOW}
                ledgerState="ledger: clean"
                selection={{ panel: 'chapters' }}
            />
        );

        const prompt = document.querySelector('.sv-completion') as HTMLElement;
        expect((prompt.querySelector('.sv-completion-discard') as HTMLElement).textContent).toBe(
            '47 findings and 12 Ideas will be closed without action, the oldest from chapter 2 (L-25b).'
        );
        expect(within(prompt).getByText('ledger: clean')).toBeTruthy();

        await click(screen.getByRole('button', { name: 'Accept completion' }));
        expect(harness.calls.acceptCompletion).toEqual([['s1']]);
    });

    it('renders the Digest only under its folder, and as engine-derived (D-12a, D-14)', () => {
        renderView({ selection: { panel: 'digest' } });

        const digest = document.querySelector('.sv-digest') as HTMLElement;
        expect(digest.querySelector('.sv-digest-meta')?.textContent).toContain('rev 7');
        expect(digest.querySelector('.sv-digest-body')?.textContent).toBe(
            'Derived from the Summary at rev 9 and the plotlines at rev 3. Nothing has contradicted them.'
        );
        expect(digest.textContent).toContain('engine-derived, no agent wrote it (D-12a)');
    });

    it('leaves the employee rail to the shell (U-8)', () => {
        const { container } = renderView({ selection: { panel: 'goal' } });

        expect(container.querySelector('.sv-story-rail')).toBeNull();
        expect(screen.queryByRole('complementary', { name: 'Templates' })).toBeNull();
    });
});

describe('StoryView — the stalled review still lands on the Summary (U-1a, L-23)', () => {
    it('shows the review surface and its four exits when the loop is stalled', () => {
        const view = fixtureView();
        const stalled = {
            ...view,
            story: { ...view.story, status: 'pending' as const, pending_kind: 'stalled' as const }
        };
        const { container } = render(
            <StoryView view={stalled} actions={fixtureActions().actions} now={NOW} selection={{ panel: 'summary' }} />
        );

        expect(container.querySelectorAll('.sv-stalled-review').length).toBe(1);
        expect(container.querySelectorAll('.sv-stalled-exits .sv-exit').length).toBe(4);
        expect((container.querySelector('.sv-story-status') as HTMLElement).className).toContain('sv-status-stalled');
    });

    it('does not show the review surface on a calm awaiting Story', () => {
        const { container } = renderView();
        expect(container.querySelectorAll('.sv-stalled-review').length).toBe(0);
    });
});

describe('StoryView — the research pipeline surfaces (§10, §3.3, §6.6)', () => {
    it('states the sampling round on the Story meta while the Story is in phase ①', () => {
        const view = summaryPhaseView();

        const { container, rerender } = render(
            <StoryView
                view={{ ...view, sampling: { round: 3, active_round: 4, history: [] } }}
                actions={fixtureActions().actions}
                now={NOW}
            />
        );

        expect(container.querySelector('.sv-story-sampling')?.textContent).toBe('Sampling round 3');

        // Later phases do not sample, so the line is off there even when the payload carries a round.
        const inChapters = { ...view, story: { ...view.story, phase: 'chapters' as const } };
        rerender(
            <StoryView
                view={{ ...inChapters, sampling: { round: 3, active_round: 4, history: [] } }}
                actions={fixtureActions().actions}
                now={NOW}
                selection={{ panel: 'chapters' }}
            />
        );

        expect(container.querySelector('.sv-story-sampling')).toBeNull();
    });

    it('shows the Editor’s accepted brief on the Seed folder without replacing the Seed (P5)', () => {
        const view = summaryPhaseView();
        const { container } = render(
            <StoryView
                view={{
                    ...view,
                    seed_brief: {
                        id: 'seed_brief_1',
                        seed_hash: 'seed-hash-current',
                        logline: 'A cartographer maps a sea that remembers her fleet.',
                        protagonist: 'Ilsa Vane',
                        want: 'a chart that is true',
                        obstacle: 'the sea recolours every line',
                        stakes: 'her name is next',
                        setting: 'a drowned chart',
                        promise: 'every sounding answers',
                        status: 'accepted'
                    }
                }}
                actions={fixtureActions().actions}
                now={NOW}
                selection={{ panel: 'seed' }}
            />
        );

        // The Seed is still the Author's text, verbatim and first (P5)…
        expect(container.querySelector('.sv-seed-body')?.textContent).toBe(view.story.idea);
        // …and the brief is a labelled, derived line under it.
        expect(container.querySelector('.sv-seed-brief')?.textContent).toBe(
            "The Editor's brief: A cartographer maps a sea that remembers her fleet."
        );
    });
});

describe('StoryView — phases hidden by the focused view still write their routes', () => {
    it('offers the plotline lock on the Plotlines pane when that is the current phase', () => {
        const view = fixtureView();
        const inPlotlines = {
            ...view,
            story: { ...fixtureStory(), phase: 'plotlines' as const, summary_locked: true, plotlines_locked: false }
        };
        render(
            <StoryView
                view={inPlotlines}
                actions={fixtureActions().actions}
                now={NOW}
                selection={{ panel: 'plotlines' }}
            />
        );

        expect(screen.getByRole('button', { name: 'Lock phase Plotlines' })).toBeTruthy();
    });
});
