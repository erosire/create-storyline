// U-4 … U-17 — the Story view: the centre region, and the composition root of this directory.
//
// What is pinned here is the SURFACE the Author actually reads at once: the state line (U-1c), the
// dial (D-35/D-35b), the two big phase buttons with their gate (U-16/L-7a), the Ideas tray's write
// payload (D-29), the cost block (decision 17), the Digest (D-12a), and the crew rail (U-7/U-8).
// Every click asserts the ROUTE ARGUMENTS it produced, so a mis-wired handler cannot pass.
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { StoryView } from './StoryView';
import { click } from '../testing/shell-fakes';
import { NOW, fixtureActions, fixtureCompletion, fixtureView } from './story-fixtures';

function renderView(props: Partial<Parameters<typeof StoryView>[0]> = {}) {
    const harness = fixtureActions();
    render(<StoryView view={fixtureView()} actions={harness.actions} now={NOW} {...props} />);
    return harness;
}

/** A view whose Goal has passed and whose tray is decided — the only state the Lock allows. */
function clearedView() {
    const view = fixtureView();
    return {
        ...view,
        goal: { ...view.goal, failing: [] },
        ideas: view.ideas.map((idea) => ({ ...idea, state: 'selected' as const }))
    };
}

/**
 * The same Story parked by the loop instead of by the Author (D-2a's `pending — stalled`). U-1a makes
 * that the one state that owes the review surface, so the difference between this and the fixture
 * view is exactly one field pair.
 */
function stalledView() {
    const view = fixtureView();

    return { ...view, story: { ...view.story, status: 'pending' as const, pending_kind: 'stalled' as const } };
}

describe('StoryView — the state the Author reads first (U-1c, U-4, U-11, D-35)', () => {
    it('shows the review surface and the four exits ONLY on a stalled Story, never on an awaiting one (U-1a, L-23)', () => {
        const { container } = render(<StoryView view={stalledView()} actions={fixtureActions().actions} now={NOW} />);

        expect(container.querySelectorAll('.sv-stalled-review').length).toBe(1);
        // L-23's four exits are buttons on this screen, and they are reachable from the state line.
        expect(container.querySelectorAll('.sv-stalled-exits .sv-exit').length).toBe(4);
        expect((container.querySelector('.sv-story-status') as HTMLElement).className).toContain('sv-status-stalled');

        // The same Story awaiting the Author for a different reason is a calm desk, not a review.
        const awaiting = render(<StoryView view={fixtureView()} actions={{}} now={NOW} />);

        expect(awaiting.container.querySelectorAll('.sv-stalled-review').length).toBe(0);
    });

    it('states the status, the reason, the levels, the trend, and the progress in story terms', () => {
        renderView();

        // L-37a: awaiting the Author is stated as awaiting, never as an error.
        expect((document.querySelector('.sv-story-status-badge') as HTMLElement).textContent).toBe(
            'pending — idea_selection'
        );
        expect(
            screen.getByText('The Reader proposed three directions; the Author has not chosen one (D-28).')
        ).toBeTruthy();
        expect(
            screen.getByText('Seed→Summary 2/2 · Summary→Plotlines 6/7 · Plotlines→Chapters 1/3 · Whole Story 0/3')
        ).toBeTruthy();
        expect(screen.getByText('trend: flat')).toBeTruthy();
        // U-11: progress reads as story — chapters drafted, a hole, unpaid setups — not as a spinner.
        expect(screen.getByText('chapters 2 of 4 drafted · 1 hole in act two · 3 setups unpaid')).toBeTruthy();
        // U-4: the Seed is on the view, and the phase strip says where the Story stands.
        expect(screen.getByRole('region', { name: 'Seed' })).toBeTruthy();
        expect(screen.getByRole('navigation', { name: 'Story phases' })).toBeTruthy();
    });

    it('shows the dial as the one switch that moves both the gate and the drain threshold, and writes the whole set', async () => {
        const { actions, calls } = renderView();

        // D-35b: the label states the second job of the same switch.
        expect(
            screen.getByText('auto-approve dial (D-35) — the same switch sets when the crew stops looking (D-35b)')
        ).toBeTruthy();
        expect((screen.getByLabelText('critical auto-approve') as HTMLInputElement).checked).toBe(true);
        expect((screen.getByLabelText('taste auto-approve') as HTMLInputElement).checked).toBe(false);

        // Turning one cost off sends the whole set, in the canonical order (D-35).
        await click(screen.getByLabelText('major auto-approve'));
        expect(calls.setAutoApprove).toEqual([['s1', ['critical']]]);

        await click(screen.getByLabelText('taste auto-approve'));
        expect(calls.setAutoApprove[1]).toEqual(['s1', ['critical', 'major', 'taste']]);

        // Without the route the dial is inert and says so (U-16). A second render with an empty
        // action set leaves both mounts in the DOM, so the LAST dial is the one under test.
        render(<StoryView view={fixtureView()} actions={{}} now={NOW} />);
        const inertDial = screen.getAllByLabelText('critical auto-approve');
        expect((inertDial[inertDial.length - 1] as HTMLInputElement).disabled).toBe(true);
        void actions;
    });

    it('writes an Idea selection with the note that makes it a recorded decision (U-15, D-29)', async () => {
        const { actions, calls } = renderView();

        await click(
            within(document.querySelector('.sv-idea-verified') as HTMLElement).getByRole('button', { name: 'Select' })
        );
        expect(calls.selectIdea).toEqual([['s1', 'i-verified', 'selected by the Author']]);
    });
});

describe('StoryView — the two biggest buttons (U-16, L-7a, L-25a, L-32)', () => {
    it('refuses the lock while the Goal has not passed and the tray is open, and says both reasons', () => {
        renderView();

        const lock = document.querySelector('.sv-lock-button') as HTMLButtonElement;
        expect(lock.disabled).toBe(true);
        expect(lock.textContent).toBe('Lock phase ③ Chapters');
        // U-16: a disabled control states the blocker, in the tooltip AND on the face of the pane.
        expect(lock.getAttribute('title')).toBe(
            'Not yet: the Goal has not passed: C-8, C-11 still failing (4/7 · failing: C-8, C-11) · 3 Ideas still in the tray — each must be selected, discarded, or deferred first (L-7a)'
        );
        expect(Array.from(document.querySelectorAll('.sv-lock-reasons li')).map((node) => node.textContent)).toEqual([
            'the Goal has not passed: C-8, C-11 still failing (4/7 · failing: C-8, C-11)',
            '3 Ideas still in the tray — each must be selected, discarded, or deferred first (L-7a)'
        ]);
        expect(
            screen.getByText(
                'Accepting completion locks the chapters exactly as the Summary and plotlines were locked (L-25a), and everything still open is closed with a count on it (L-25b).'
            )
        ).toBeTruthy();
    });

    it('signs phase ③ through the completion route once the gate is clear (L-25a, L-25b)', async () => {
        const harness = fixtureActions();
        render(<StoryView view={clearedView()} actions={harness.actions} now={NOW} />);

        const lock = document.querySelector('.sv-lock-button') as HTMLButtonElement;
        expect(lock.disabled).toBe(false);

        // Two-step confirm: the sentence naming what becomes read-only is read before it is signed.
        await click(lock);
        expect(harness.calls.acceptCompletion).toBeUndefined();
        await click(screen.getByRole('button', { name: 'Confirm' }));
        expect(harness.calls.acceptCompletion).toEqual([['s1']]);
    });

    it('offers Backtrack on each signed earlier phase, and commits with the route\u2019s phase argument (L-31, L-32)', async () => {
        const { actions, calls } = renderView();

        const targets = Array.from(
            document.querySelectorAll<HTMLButtonElement>('.sv-backtrack-block .sv-backtrack-button')
        );
        expect(targets.map((button) => button.textContent)).toEqual([
            'Backtrack to ① Summary',
            'Backtrack to ② Plotlines'
        ]);

        await click(targets[1]);
        expect(
            screen.getByText(
                'Backtrack to ② Plotlines deletes 4 chapters with their 4 revisions and unlocks every plotline. Verdicts and selection notes survive (D-25, L-31). The locked Summary stays locked.'
            )
        ).toBeTruthy();
        await click(screen.getByRole('button', { name: 'Confirm' }));
        expect(calls.backtrack).toEqual([['s1', 'plotlines']]);

        // The hint states how much each target deletes, in phases (D-25).
        expect(
            screen.getByText(
                /Each target reopens its phase from the locked artifact above it and deletes everything later phases produced/
            )
        ).toBeTruthy();
        void actions;
    });
});

describe('StoryView — completion, cost, and the derived Digest (U-14, decision 17, D-12a)', () => {
    it('shows the completion prompt only when the crew has actually proposed, with the discard counted', async () => {
        const { container } = render(<StoryView view={fixtureView()} actions={{}} now={NOW} />);
        expect(container.querySelector('.sv-completion')).toBeNull();

        const harness = fixtureActions();
        const { rerender } = render(<StoryView view={fixtureView()} actions={harness.actions} now={NOW} />);
        rerender(
            <StoryView
                view={fixtureView({ completion: fixtureCompletion() })}
                actions={harness.actions}
                now={NOW}
                ledgerState="ledger: clean"
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

    it('prints the cost distribution and the downgrade count — the only check on a triage with no appeal (decision 17, D-34a)', () => {
        renderView();

        const stats = Array.from(document.querySelectorAll<HTMLElement>('.sv-cost-stat')).map((stat) => [
            stat.querySelector('.sv-cost-cost')!.textContent,
            stat.querySelector('.sv-cost-count')!.textContent
        ]);
        expect(stats).toEqual([
            ['critical', '0'],
            ['major', '4'],
            ['minor', '9'],
            ['taste', '12'],
            ['downgrades', '11']
        ]);
        // The pattern is what the Author is meant to see: fat `taste`, empty `critical`.
        expect(
            screen.getByText(
                'If this number keeps climbing while `critical` stays at 0, the Editor is filing every alarm as a whisper — edit its template, do not re-review the findings (G-7).'
            )
        ).toBeTruthy();
    });

    it('renders the engine-derived Digest and marks it as nothing an agent wrote (D-12a, D-14)', () => {
        renderView();

        const digest = document.querySelector('.sv-digest') as HTMLElement;
        expect((digest.querySelector('summary') as HTMLElement).textContent).toContain('Digest rev 7');
        expect((digest.querySelector('.sv-digest-body') as HTMLElement).textContent).toBe(
            'Derived from the Summary at rev 9 and the plotlines at rev 3. Nothing has contradicted them.'
        );
        expect(digest.textContent).toContain('engine-derived, no agent wrote it · D-12a');
    });

    it('carries the CREW and TEMPLATES rail on the same surface (U-7, U-8)', () => {
        renderView();

        expect(screen.getByRole('complementary', { name: 'Crew' })).toBeTruthy();
        expect(screen.getByRole('complementary', { name: 'Templates' })).toBeTruthy();
        expect(screen.getByRole('region', { name: 'Goal' })).toBeTruthy();
        expect(screen.getByRole('region', { name: 'Ideas tray' })).toBeTruthy();
        expect(screen.getByRole('region', { name: 'Summary' })).toBeTruthy();
        // Chapter units keep their drafts inline (under the prose they belong to); the Summary unit
        // has no prose of its own, so it gets the standalone comparison pane (U-13). Two panes, each
        // named the same region — hence the count, plus the two distinguishing markers.
        const comparisons = screen.getAllByRole('region', { name: 'Revision comparison' });
        expect(comparisons.length).toBe(2);
        expect(document.querySelector('.sv-chapter-revisions')).toBeTruthy();
        expect(comparisons[1].querySelector('.sv-chapter-revisions')).toBeNull();
        expect(screen.getByText('Summary · 1 draft (summary)')).toBeTruthy();
    });
});
