// U-15 / D-27 / D-29 / D-32 / D-36 — the Ideas tray.
//
// The tray is the Author's decision queue, and three rules decide what a test can see:
// it is PHASE-scoped (D-36), a verified Idea is selectable and an unverified one needs the explicit
// "I know" (D-27), and a repeat of a settled Idea arrives wearing its earlier decision (D-32).
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { IdeasTray } from './IdeasTray';
import { click } from '../testing/shell-fakes';
import { fixtureActions, fixtureIdeas } from './story-fixtures';

/** Renders the tray wired the way `StoryView` wires it, so the payloads are the route's. */
function renderTray(
    actions: ReturnType<typeof fixtureActions>['actions'],
    calls: ReturnType<typeof fixtureActions>['calls']
) {
    return render(
        <IdeasTray
            ideas={fixtureIdeas()}
            phase="chapters"
            onSelect={(ideaId) => void actions.selectIdea?.('s1', ideaId, 'selected by the Author')}
            onDiscard={(ideaId) => void actions.discardIdea?.('s1', ideaId)}
            onDefer={(ideaId) => void actions.deferIdea?.('s1', ideaId)}
        />
    );
}

/** The tray rows, in the order rendered — the order IS the D-27 rule. */
function trayBodies(): string[] {
    return Array.from(document.querySelectorAll('.sv-ideas-tray .sv-idea-body')).map((element) => element.textContent!);
}

describe('IdeasTray — the decision queue (U-15, D-27, D-32, D-36)', () => {
    it('shows only this phase\u2019s undecided Ideas, counts them, and states the lock gate (D-36, L-7a)', () => {
        renderTray(fixtureActions().actions, {});

        // D-36: the count in the heading is the phase's tray count, and it is the lock gate.
        expect((screen.getByRole('heading', { level: 3 }) as HTMLElement).textContent).toBe(
            'Ideas — ③ Chapters tray · 3 open'
        );
        expect(
            screen.getByText(
                'the phase cannot be locked while the tray is non-empty (L-7a) · locking empties it (D-36)'
            )
        ).toBeTruthy();

        // D-36: phase ①'s Idea is another tray's business.
        expect(screen.queryByText('Open the book on the flood, not the archive.')).toBeNull();
        // D-28: an empty tray reads as a thin crew — that copy appears only when there is nothing to decide.
        expect(screen.queryByText(/thin crew/)).toBeNull();
    });

    it('puts the verified Idea first and gates the unverified one behind \u201cI know\u201d (D-27)', async () => {
        const { actions, calls } = fixtureActions();
        renderTray(actions, calls);

        expect(trayBodies()).toEqual([
            'Let the archive hum only when she lies.',
            'Make the curator an early copy of the archivist.',
            'Cut the relay scene: it repeats the chapter before it.'
        ]);

        // Verified: one click is a decision, and the write carries the note D-29 requires.
        await click(
            within(document.querySelector('.sv-idea-verified') as HTMLElement).getByRole('button', { name: 'Select' })
        );
        expect(calls.selectIdea).toEqual([['s1', 'i-verified', 'selected by the Author']]);

        // Unverified: the first click asks, and NOTHING is written yet (D-27).
        const unverified = Array.from(document.querySelectorAll<HTMLElement>('.sv-idea-dim')).find((element) =>
            element.textContent!.includes('Make the curator an early copy')
        )!;
        await click(within(unverified).getByRole('button', { name: 'Select' }));
        expect(calls.selectIdea.length).toBe(1);
        expect(
            screen.getByText(
                'Unverified: no Editor has returned `verified` with evidence (D-27, C-15). Select it anyway?'
            )
        ).toBeTruthy();

        // The explicit \u201cI know\u201d outranks the Editor (D-24's principle, applied one level down).
        await click(within(unverified).getByRole('button', { name: 'I know' }));
        expect(calls.selectIdea).toEqual([
            ['s1', 'i-verified', 'selected by the Author'],
            ['s1', 'i-repeat', 'selected by the Author']
        ]);
    });

    it('shows a repeat wearing its earlier decision, and the Editor\u2019s evidence with the verdict (D-32, D-27, D-31)', () => {
        renderTray(fixtureActions().actions, {});

        const repeat = Array.from(document.querySelectorAll<HTMLElement>('.sv-idea')).find((element) =>
            element.textContent!.includes('Make the curator an early copy')
        )!;
        expect(within(repeat).getByText('3× seen — repeat (D-32)')).toBeTruthy();
        expect(within(repeat).getByText('unverifiable')).toBeTruthy();
        expect(
            within(repeat).getByText("Editor's evidence — No record of the curator precedes chapter 3 (C-15).")
        ).toBeTruthy();
        // D-31: the two questions are answered separately — is it true, and does THIS Author want it.
        expect(within(repeat).getByText('against your guidelines, even if it is true (D-31)')).toBeTruthy();
        expect(
            within(repeat).getByText(
                'Already decided: discarded — Refuted at the phase ② lock — too early to land. (D-32)'
            )
        ).toBeTruthy();

        // T-10: a citation names the source, the claim, and when it was read.
        const verified = document.querySelector('.sv-idea-verified') as HTMLElement;
        expect(within(verified).getByText('City Water Bulletin 14')).toBeTruthy();
        expect(within(verified).getByText('The stacks resonate at 40 Hz when the pumps cycle.')).toBeTruthy();
        expect(within(verified).getByText('accessed 2026-11-11T11:15:00.000Z')).toBeTruthy();
        expect(
            within(verified).getByText('fits your guidelines — criteria, tone, world rules, selection_rules (D-31)')
        ).toBeTruthy();
    });

    it('keeps the decided Ideas below the tray with the note that decided them, and sends discard/defer (U-15, D-29, D-32)', async () => {
        const { actions, calls } = fixtureActions();
        renderTray(actions, calls);

        const decided = document.querySelector('.sv-ideas-decided') as HTMLElement;
        expect(
            within(decided).getByText(
                '2 decided — selected · discarded · deferred, with the note that decided it (D-32)'
            )
        ).toBeTruthy();
        expect(within(decided).getByText('Taken — becomes the next Writer’s brief (D-29).')).toBeTruthy();
        expect(within(decided).getByText('absorbed into w-9 (D-29)')).toBeTruthy();
        expect(within(decided).getByText('discarded')).toBeTruthy();
        expect(within(decided).getByText('selected')).toBeTruthy();

        const warning = Array.from(document.querySelectorAll<HTMLElement>('.sv-idea')).find((element) =>
            element.textContent!.includes('Cut the relay scene')
        )!;
        await click(within(warning).getByRole('button', { name: 'Discard' }));
        await click(within(warning).getByRole('button', { name: 'Defer' }));
        expect(calls.discardIdea).toEqual([['s1', 'i-warning']]);
        expect(calls.deferIdea).toEqual([['s1', 'i-warning']]);
    });

    it('reads an empty tray as a thin crew, never a clean one (D-28)', () => {
        render(<IdeasTray ideas={fixtureIdeas().filter((idea) => idea.phase === 'summary')} phase="chapters" />);

        expect(
            screen.getByText('No Ideas filed this phase — that reads as a thin crew, not a clean one (D-28).')
        ).toBeTruthy();
        expect(screen.getByText('tray empty — the phase can be locked (L-7a)')).toBeTruthy();
        // With no verbs supplied, every control is present and says the endpoint is missing (U-16).
        const selects = Array.from(document.querySelectorAll<HTMLButtonElement>('.sv-idea-select'));
        expect(selects.length).toBe(0);
    });
});
