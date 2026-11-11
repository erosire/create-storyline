// U-13 / D-21 / D-22 / D-24 — revision comparison: the drafts of one unit side by side.
//
// The Author's window onto divergence is literal columns (U-13), the §4.9 verdict rows and the Editor's
// `selection_note` ride with each draft (D-21, L-17), and the Select control states the missing endpoint
// rather than pretending the Author's override exists (D-24).
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { RevisionsCompare } from './RevisionsCompare';
import { buildRevisionUnits } from './story-contract';
import { click } from '../testing/shell-fakes';
import { fixtureActions, fixtureView } from './story-fixtures';

/** The unit the fixture Story is contested on (D-23: it cannot advance until one is chosen). */
function contestedUnit() {
    return buildRevisionUnits(fixtureView()).filter((unit) => unit.unitRef === 'c2');
}

describe('RevisionsCompare — the Author\u2019s window onto divergence (U-13, D-21, D-24)', () => {
    it('renders each draft as its own column, with its state, template, run, and its own verdict rows', () => {
        render(
            <RevisionsCompare
                units={contestedUnit()}
                note="2 competing drafts — the unit cannot advance until an Editor selects (D-23, L-20)"
            />
        );

        expect(screen.getByText('Chapter 2 — Ghost Index · 2 drafts (chapter)')).toBeTruthy();
        const columns = Array.from(document.querySelectorAll<HTMLElement>('.sv-revision-col'));
        expect(columns.length).toBe(2);
        expect(columns.map((column) => column.className)).toEqual([
            'sv-revision-col sv-revision-competing',
            'sv-revision-col sv-revision-competing'
        ]);

        // U-13 / D-21: the verdicts are the REAL §4.9 rows, not the bare refs the pane printed while the
        // view had no `verdicts` slice. rv-c2-a was judged twice — a failing pass and a newer pass.
        const verdictsOf = (column: HTMLElement) =>
            Array.from(column.querySelectorAll<HTMLElement>('.sv-revision-verdict')).map(
                (node) =>
                    `${node.querySelector('.sv-revision-verdict-state')?.textContent}|${node.querySelector('.sv-revision-verdict-id')?.textContent}|${node.querySelector('.sv-revision-verdict-recommendation')?.textContent}`
            );

        expect(verdictsOf(columns[0])).toEqual([
            'hard fail|v-1 · chapter · round 1|recommends fix',
            'hard pass|v-2 · chapter · round 2|recommends advance'
        ]);

        // D-15: the failing line is shown WITH its citation — the evidence is the point of the row.
        expect(
            (columns[0].querySelector('.sv-revision-verdict-fail .sv-revision-verdict-failure') as HTMLElement)
                .textContent
        ).toBe('C-8 failing — the 1911 survey is named once and never paid off (D-15 evidence) (finding f-2)');

        // rv-c2-b has no verdict naming it, so the pane says which judgement it is showing rather than
        // passing the unit's rows off as the draft's own.
        expect(verdictsOf(columns[1])).toEqual(['hard fail|v-3 · chapter · round 1|recommends fix']);
        expect(within(columns[1]).getByText('no verdict names this draft — these were filed against c2')).toBeTruthy();
        expect(within(columns[0]).getByText('t-chapters')).toBeTruthy();
        expect(within(columns[0]).getByText('run r-5')).toBeTruthy();
        expect(within(columns[1]).getByText('run r-6')).toBeTruthy();

        // A chapter body is its sections, rendered as the prose reads (D-7).
        expect((columns[0].querySelector('.sv-revision-body') as HTMLElement).textContent).toBe(
            'The index answered before she touched it, in a voice she had heard read aloud years earlier.'
        );
        expect((columns[1].querySelector('.sv-revision-body') as HTMLElement).textContent).toBe(
            'The index answered in her own voice, and she did not recognise it.'
        );

        // D-22: the losers are deleted by the selection commit, and nothing promises a restore.
        expect(
            screen.getByText(
                "A discarded draft is not restorable in this view: the selection commit deletes it hard (D-22), and D-24's restore needs the run's own output, which lands with the run-transcript endpoint."
            )
        ).toBeTruthy();
        expect(
            screen.getByText('the losers are deleted in the selection commit; the note survives (D-22)')
        ).toBeTruthy();
    });

    it('disables Select only when the host passes no callback, and says which state that is', () => {
        render(<RevisionsCompare units={contestedUnit()} />);

        const selects = Array.from(document.querySelectorAll<HTMLButtonElement>('.sv-revision-select'));
        expect(selects.length).toBe(2);
        expect(selects.every((button) => button.disabled)).toBe(true);
        // The route exists, so a disabled control is a mounting question and the tooltip says so — the
        // copy used to blame a missing endpoint that has since landed (U-13).
        expect(selects[0].getAttribute('title')).toBe(
            'This pane was mounted without a selection callback, so the Author cannot choose from here (D-24)'
        );
    });

    it('lets the Author override the Editor once the route exists, with the unit and the draft it names (D-24)', async () => {
        const { actions, calls } = fixtureActions();
        render(
            <RevisionsCompare
                units={contestedUnit()}
                onSelectRevision={(unitRef, revisionId) => void actions.selectRevision?.(unitRef, revisionId)}
            />
        );

        // The second column is the draft the Editor did not pick — the Author's override target (D-24).
        await click(
            within(document.querySelectorAll<HTMLElement>('.sv-revision-col')[1]).getByRole('button', {
                name: 'Select this draft'
            })
        );
        expect(calls.selectRevision).toEqual([['c2', 'rv-c2-b']]);
    });

    it('shows the Editor\u2019s selection note on the draft that was chosen — the Author\u2019s only view of automated taste (L-17, T-2a)', () => {
        const selected = buildRevisionUnits(fixtureView()).filter((unit) => unit.unitRef === 'c1');
        render(<RevisionsCompare units={selected} />);

        expect(screen.getByText('Chapter 1 — The Sealed Stack · 1 draft (chapter)')).toBeTruthy();
        expect(
            screen.getByText(
                'selection note — Chose the citation line: it makes the refusal a fact she can quote (D-24).'
            )
        ).toBeTruthy();
        expect((document.querySelector('.sv-revision-state') as HTMLElement).textContent).toBe('selected');
    });

    it('renders nothing at all when there is nothing to compare', () => {
        const { container } = render(<RevisionsCompare units={[]} />);
        expect(container.innerHTML).toBe('');
    });
});
