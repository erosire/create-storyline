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
import type { Revision, Verdict } from '../../shared/types';
import { NOW, fixtureActions, fixtureCompletion, fixtureStory, fixtureView } from './story-fixtures';

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
        expect(container.querySelector('.sv-summary-drafts')).toBeTruthy();
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
    it('marks the recommended overview and lets the Author take it or choose the other', async () => {
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

        const drafts = Array.from(document.querySelectorAll<HTMLElement>('.sv-summary-draft'));
        expect(drafts.length).toBe(2);
        expect(drafts[1].dataset.recommended).toBe('true');
        expect(within(drafts[1]).getByText('Editor recommends')).toBeTruthy();

        await click(screen.getByRole('button', { name: 'Take the recommended overview' }));
        expect(harness.calls.selectRevision).toEqual([['sum1', 'rv-sum-b']]);
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
        expect(lock.textContent).toBe('Lock phase Summary');

        // The gate clears: Goal passes and the phase's tray is decided.
        const cleared = {
            ...view,
            goal: { ...view.goal, failing: [] },
            ideas: view.ideas.map((idea) => ({ ...idea, state: 'selected' as const }))
        };
        render(<StoryView view={cleared} actions={harness.actions} now={NOW} selection={{ panel: 'summary' }} />);
        const locks = screen.getAllByRole('button', { name: 'Lock phase Summary' });
        const enabled = locks[locks.length - 1] as HTMLButtonElement;
        expect(enabled.disabled).toBe(false);

        await click(enabled);
        await click(screen.getByRole('button', { name: 'Confirm' }));
        expect(harness.calls.lockPhase).toEqual([['s1']]);
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
