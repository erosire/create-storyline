// R6 / U1-U3 + U6 — the content column's routing between the TWO Summary surfaces.
//
// `StoryView.test.tsx` pins the phrase redesign's routing for a sampling book. This file pins the other
// half: which surface a GROUP-managed book gets, and what the group selection does to the rest of the
// column. The distinction is the acceptance criterion — a grouped book must not be shown the sampler's
// round (its numbers were never produced), and a sampling book must not be shown five groups it does not
// have. Neither pane carries a branch for the other; `StoryView` chooses, on `story.summary_mode`.
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { StoryView } from './StoryView';
import { fixtureActions, fixturePhrase, fixtureView } from './story-fixtures';
import { groupedPhraseView, reviewedPhraseView } from '../testing/shell-fakes';
import { NOW } from './story-fixtures';
import type { PhraseView } from '../api';
import type { StoryViewData } from './story-contract';

/**
 * A grouped book in phase ①, Goal passing, Ideas tray empty: the frame in which the phase gate is allowed
 * to render, so a test can tell "the gate is gone" from "the gate had no reason to be there".
 */
function groupedView(phrase: PhraseView = fixturePhrase()) {
    const view = fixtureView({ phrase });

    return {
        ...view,
        story: {
            ...view.story,
            phase: 'summary' as const,
            summary_locked: false,
            status: 'ready' as const,
            pending_kind: 'none' as const,
            status_reason: undefined
        },
        goal: { ...view.goal, failing: [], phase_progress: '4/4' },
        ideas: []
    };
}

/** The same book before the phrase read lands: the Story row says `groups`, the rows have not arrived. */
function pendingGroupedView() {
    const view = groupedView();

    return { ...view, phrase: undefined };
}

/** A sampling book in phase ① — the surface this workspace shipped, which the redesign leaves alone. */
function samplingView() {
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

function renderView(props: Partial<Parameters<typeof StoryView>[0]> = {}, view: StoryViewData = groupedView()) {
    const harness = fixtureActions();

    return {
        ...harness,
        ...render(<StoryView view={view} actions={harness.actions} now={NOW} {...props} />)
    };
}

describe('StoryView — a group-managed book gets the grouped Overview, not the round (U1, U3)', () => {
    it('renders the Overview pane and none of the sampler’s ledger', () => {
        const { container } = renderView();

        expect(screen.getByTestId('summary-overview')).toBeTruthy();
        expect(container.querySelectorAll('.sv-group-row')).toHaveLength(5);
        // The sampling surface is absent in both shapes it takes: the revision ledger and the dials.
        expect(container.querySelector('.sv-summary-revisions')).toBeNull();
        expect(container.querySelector('.sv-summary-dials')).toBeNull();
        expect(container.querySelectorAll('input[type="number"]')).toHaveLength(0);
        // …and the verb the sampler needed is gone from the gate under it (U3).
        expect(screen.queryByRole('button', { name: 'Request another revision round' })).toBeNull();
    });

    it('hands the Overview the action object, so the Author\'s choose is a live verb (D-68)', () => {
        // The pane's Choose button is enabled only when `actions.chooseReviewedSummary` exists — so this is
        // the one place that can tell "the shell bound the verb" from "the pane rendered a dead button".
        // `reviewedPhraseView(…, 'ready')`, not the mid-review fixture: the fixture's reviewed block is
        // `pending`, and a pending book offers no Choose at all (D-67).
        const { calls, container } = renderView({}, groupedView(reviewedPhraseView('s1', 'ready')));
        const submit = container.querySelector('[data-testid="reviewed-choose-submit"]') as HTMLButtonElement;

        expect(submit.disabled).toBe(false);

        // Clicking arms the confirmation step first; only the confirm reaches the verb (D-68).
        fireEvent.click(submit);
        fireEvent.click(screen.getByTestId('reviewed-choose-confirm'));

        expect(calls.chooseReviewedSummary).toEqual([['s1']]);
    });

    it('leaves the choose bound to nothing when the shell hands down no actions, and the pane says so', () => {
        const { container } = render(
            <StoryView view={groupedView(reviewedPhraseView('s1', 'ready'))} actions={undefined} now={NOW} />
        );
        const submit = container.querySelector('[data-testid="reviewed-choose-submit"]') as HTMLButtonElement;

        expect(submit.disabled).toBe(true);
        expect(submit.getAttribute('title')).toBe('The reviewed-Summary choose route is not available in this shell.');
    });

    it('keeps the phase gate on the Overview only, and only once (U5)', () => {
        const { container } = renderView();

        expect(container.querySelectorAll('.sv-phase-controls')).toHaveLength(1);
        // The gate is the Author's sign-off, so its reasons are on screen where the Overview is.
        expect(container.querySelector('.sv-lock-block')).toBeTruthy();
        expect(container.textContent).toContain('1 Summary group still unwritten (Ending)');
        // The grouped blockers reached the gate rather than the gate inventing the sampler's ones.
        expect(container.textContent).toContain('the Writer is rewriting Theme right now');
        expect(container.textContent).not.toContain('still in this round');
    });

    it('shows its own loading line while the phrase read is in flight, with no groups invented (U6)', () => {
        const { container } = renderView({}, pendingGroupedView());

        expect(screen.getByTestId('summary-overview-pending')).toBeTruthy();
        expect(container.querySelector('.sv-group-rows')).toBeNull();
        expect(container.querySelector('.sv-summary-revisions')).toBeNull();
    });

    it('leaves a sampling book on the round, with its verbs intact (U1)', () => {
        const { container } = renderView({}, samplingView());

        expect(screen.queryByTestId('summary-overview')).toBeNull();
        expect(container.querySelector('.sv-summary-revisions')).toBeTruthy();
        // The one verb the sampler's round still needs is still there for the book that runs the sampler.
        expect(screen.getByRole('button', { name: 'Request another revision round' })).toBeTruthy();
        expect(container.textContent).not.toContain('Summary group still unwritten');
    });

    it('prints the sampler’s round number for a sampling book, and never for a grouped one (U3)', () => {
        const sampling = {
            ...samplingView(),
            sampling: { round: 3, active_round: 4, history: [] }
        };
        const { container: samplingPane } = renderView({}, sampling);

        expect(samplingPane.querySelector('.sv-story-sampling')?.textContent).toBe('Sampling round 3');

        const grouped = { ...groupedView(), sampling: { round: 3, active_round: 4, history: [] } };
        const { container: groupedPane } = renderView({}, grouped);

        // The loop writes five groups; a round number over its Overview would be a number the engine
        // never produced.
        expect(groupedPane.querySelector('.sv-story-sampling')).toBeNull();
    });
});

describe('StoryView — the rail’s group ref opens that group and closes the Overview (U2)', () => {
    it('renders one group pane, addressed by the ref’s uuid', () => {
        const { container } = renderView({ selection: { panel: 'summary', ref: 'summary-group:grp-promise' } });

        expect(screen.getByTestId('group-pane-promise')).toBeTruthy();
        expect(screen.getByTestId('group-title').textContent).toBe('Promise');
        expect(screen.queryByTestId('summary-overview')).toBeNull();
        // The gate belongs to the Summary as a whole, so a group's pane does not carry it.
        expect(container.querySelector('.sv-phase-controls')).toBeNull();
        // …and no other phrase or folder crept in with it.
        expect(container.querySelector('.sv-ideas')).toBeNull();
        expect(container.querySelector('.sv-chapters')).toBeNull();
        expect(container.querySelector('.sv-summary-revisions')).toBeNull();
    });

    it('follows the uuid across a refetch that delivers the rows in another order (U2)', () => {
        const reversed = groupedView({ ...fixturePhrase(), groups: [...fixturePhrase().groups].reverse() });
        const { rerender, ...first } = renderView(
            { selection: { panel: 'summary', ref: 'summary-group:grp-tone' } },
            reversed
        );

        expect(screen.getByTestId('group-pane-tone')).toBeTruthy();
        expect(screen.getByTestId('group-title').textContent).toBe('Tone');

        // A second read of the same rows, and the pane has not moved.
        rerender(
            <StoryView
                view={groupedView({ ...fixturePhrase(), groups: [...fixturePhrase().groups].reverse() })}
                actions={first.actions}
                now={NOW}
                selection={{ panel: 'summary', ref: 'summary-group:grp-tone' }}
            />
        );
        expect(screen.getByTestId('group-title').textContent).toBe('Tone');
    });

    it('falls back to the Overview when the ref names a group this book does not have (U6)', () => {
        // The selection is what the rail was holding; the read says the group is gone (a re-import, or the
        // book switched back to `sampling`). The Author lands on the Overview, not on an empty pane.
        const { container } = renderView({ selection: { panel: 'summary', ref: 'summary-group:grp-retired' } });

        expect(screen.getByTestId('summary-overview')).toBeTruthy();
        expect(screen.queryByTestId('group-pane-stale')).toBeNull();
        expect(container.querySelector('.sv-group-row')).toBeTruthy();
    });

    it('falls back on a story switch, in the same frame the new book arrives (U6)', () => {
        const first = groupedView();
        const { rerender, ...harness } = renderView({ selection: { panel: 'summary', ref: 'summary-group:grp-tone' } }, first);

        expect(screen.getByTestId('group-pane-tone')).toBeTruthy();

        // The new book's groups carry different ids — as two real books' always do.
        const otherBook: PhraseView = {
            ...groupedPhraseView('s2'),
            groups: groupedPhraseView('s2').groups.map((group) => ({ ...group, id: `${group.key}-of-s2` }))
        };

        rerender(
            <StoryView
                view={groupedView(otherBook)}
                actions={harness.actions}
                now={NOW}
                selection={{ panel: 'summary', ref: 'summary-group:grp-tone' }}
            />
        );

        expect(screen.getByTestId('summary-overview')).toBeTruthy();
        expect(screen.queryByTestId('group-pane-tone')).toBeNull();
    });

    it('holds the selection while the rows have not arrived, and shows one honest loading line (U6)', () => {
        // Before the read lands the dashboard cannot tell a deleted group from an unseen one, so the rail
        // keeps its selection (`story-nav.ts:selectionExists`) and the column resolves the ref to nothing.
        // The Overview's loading line is the single sentence that is true in both readings; the group pane's
        // own pending state is the same sentence for a pane handed an unresolved read directly.
        const { container } = renderView(
            { selection: { panel: 'summary', ref: 'summary-group:grp-promise' } },
            pendingGroupedView()
        );

        expect(screen.getByTestId('summary-overview-pending')).toBeTruthy();
        expect(container.querySelector('.sv-group-rows')).toBeNull();
        expect(screen.queryByTestId('group-pane-promise')).toBeNull();
        expect(screen.queryByTestId('group-pane-stale')).toBeNull();
    });

    it('sends the same selection object a rail click would, so the two cannot drift (U2)', () => {
        const onSelect = vi.fn();

        renderView({ onSelect });

        const themeRow = document.querySelector('[data-testid="summary-group-theme"] button') as HTMLButtonElement;
        themeRow.click();

        expect(onSelect).toHaveBeenLastCalledWith({ panel: 'summary', ref: 'summary-group:grp-theme' });
    });
});

describe('StoryView — the folders and the Seed still route as they did (U1)', () => {
    it('routes a folder selection to its own pane, with no Summary surface beside it', () => {
        const { container } = renderView({ selection: { panel: 'ideas' } });

        expect(container.querySelector('.sv-ideas')).toBeTruthy();
        expect(screen.queryByTestId('summary-overview')).toBeNull();
        expect(container.querySelector('.sv-summary-revisions')).toBeNull();
    });

    it('routes the Seed to its own pane, grouped book or not', () => {
        const { container } = renderView({ selection: { panel: 'seed' } });

        expect(screen.queryByTestId('summary-overview')).toBeNull();
        expect(screen.queryByTestId('group-pane-promise')).toBeNull();
        expect(container.querySelector('.sv-group-row')).toBeNull();
    });
});
