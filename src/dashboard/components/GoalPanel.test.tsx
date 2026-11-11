// U-6 / G-1 / G-2 — the Goal panel: the server's own progress strings, the failing evidence and
// `fix_hint`, the unreached levels WITHOUT pass/fail (L-14), and the Author's edits sent as ops.
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { GoalPanel } from './GoalPanel';
import { click, type } from '../testing/shell-fakes';
import { fixtureActions, fixtureGoal, fixtureChapters } from './story-fixtures';

/** Renders the panel at phase ③ (the chapters + whole-Story levels are the reached ones). */
function renderGoal(props: Partial<Parameters<typeof GoalPanel>[0]> = {}): ReactElement {
    const goal = fixtureGoal();
    return (
        <GoalPanel
            goal={goal.goal}
            phase="chapters"
            progress={goal.phase_progress}
            failing={goal.failing}
            chapterProgress={goal.chapter_progress}
            chapters={fixtureChapters()}
            {...props}
        />
    );
}

/** One criterion row, addressed by its id — the row is the unit the Author reads. */
function row(id: string): HTMLElement {
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.sv-criterion'));
    const found = rows.find((element) => element.querySelector('.sv-criterion-id')?.textContent === id);
    if (!found) {
        throw new Error(`no goal row for ${id}`);
    }
    return found;
}

describe('GoalPanel — pass/fail, never a score (U-6, G-1, G-2)', () => {
    it('prints the server\u2019s progress string verbatim and marks failing rows by the server\u2019s own list', () => {
        render(renderGoal());

        // G-2: the number line is the server's sentence, printed as it arrives.
        expect((document.querySelector('.sv-goal-progress') as HTMLElement).textContent).toBe(
            '4/7 · failing: C-8, C-11'
        );
        expect(screen.getByText('4/7 · failing: C-8, C-11')).toBeTruthy();
        // P6: and it is labelled as pass/fail so the number is never read as a score.
        expect(screen.getByText('pass/fail criteria, not scores (P6)')).toBeTruthy();

        // G-2's other half: every failure names the evidence and the smallest change that fits.
        expect(row('C-8').className).toContain('sv-criterion-failing');
        expect(within(row('C-8')).getByText('✗')).toBeTruthy();
        expect(
            within(row('C-8')).getByText('evidence — ch. 2, ¶1 — the index answers, and she is unchanged by it.')
        ).toBeTruthy();
        expect(within(row('C-8')).getByText('fix — Change who speaks by the end of chapter 2 (C-8).')).toBeTruthy();
        expect(row('C-11').className).toContain('sv-criterion-failing');

        // A criterion the server did NOT name is passing — the panel never does arithmetic (G-2).
        expect(row('C-9').className).toContain('sv-criterion-passing');
        expect(within(row('C-9')).getByText('✓')).toBeTruthy();
        expect(row('C-9').querySelector('.sv-criterion-failure')).toBeNull();
        // G-3: `code` and `judge` are distinguishable, because they cost different things.
        expect(within(row('C-9')).getByText('judge')).toBeTruthy();
        // The hard/soft dial is visible (G-1).
        expect(within(row('C-9')).getByText('soft')).toBeTruthy();
        expect(within(row('C-8')).getByText('hard')).toBeTruthy();
    });

    it('lists the levels the Story has not reached without any pass/fail badge (G-2, L-14)', () => {
        render(renderGoal());

        const ahead = Array.from(document.querySelectorAll('.sv-criterion-ahead'));
        expect(ahead.map((element) => element.querySelector('.sv-criterion-id')?.textContent)).toEqual(['C-0', 'C-14']);
        // `n/a` is the point: an unreached level carries no state glyph at all.
        expect(ahead.every((element) => element.querySelector('.sv-criterion-state') === null)).toBe(true);
        expect(screen.getByText('Levels this Story has not reached (2) — shown without pass/fail (G-2)')).toBeTruthy();
    });

    it('shows a criterion the Author deleted as deleted, not as passing (G-1)', () => {
        const goal = fixtureGoal().goal;
        render(
            renderGoal({ goal: { ...goal, criteria: goal.criteria.filter((criterion) => criterion.id !== 'C-9') } })
        );

        expect(row('C-9').className).toContain('sv-criterion-missing');
        expect(within(row('C-9')).getByText("removed from this Story's Goal (G-1)")).toBeTruthy();
        expect(row('C-9').querySelector('.sv-criterion-state')).toBeNull();
    });

    it('sends every Goal edit as the op it actually is — never a rewritten list (G-1)', async () => {
        const { actions, calls } = fixtureActions();
        render(renderGoal({ onPatchGoal: (patch) => void actions.patchGoal?.('s1', patch) }));

        // C-8 is hard in the built-in roster, so "toggle" means make it soft (G-1's dial).
        await click(within(row('C-8')).getByRole('button', { name: 'toggle soft' }));
        expect(calls.patchGoal).toEqual([['s1', { criteria: [{ op: 'setHard', id: 'C-8', hard: false }] }]]);

        await click(within(row('C-11')).getByRole('button', { name: 'delete' }));
        expect(calls.patchGoal[1]).toEqual(['s1', { criteria: [{ op: 'remove', id: 'C-11' }] }]);

        // A threshold edit travels alone: it must not re-assert every criterion on the way past.
        await type(screen.getByLabelText(/Soft threshold/), '4');
        await click(screen.getByRole('button', { name: 'Set threshold' }));
        expect(calls.patchGoal[2]).toEqual(['s1', { criteria: [], threshold_soft: 4 }]);
    });

    it('requires the full §5.1 shape before adding a criterion, then sends it whole (G-1, G-2, P4)', async () => {
        const { actions, calls } = fixtureActions();
        render(renderGoal({ onPatchGoal: (patch) => void actions.patchGoal?.('s1', patch) }));

        const add = screen.getByRole('button', { name: 'Add criterion' });
        expect((add as HTMLButtonElement).disabled).toBe(true);

        await type(screen.getByPlaceholderText('id (e.g. C-16)'), 'C-16');
        await type(screen.getByPlaceholderText('label'), 'every chapter ends on a question');
        expect((add as HTMLButtonElement).disabled).toBe(false);

        await type(
            screen.getByPlaceholderText('the exact question a reviewer answers'),
            'Does each chapter end on an open question?'
        );
        await type(
            screen.getByPlaceholderText('fix_hint — the smallest change that satisfies it'),
            'Move the last paragraph of ch. 3 (C-16).'
        );
        await click(screen.getByLabelText('hard'));
        await click(add);

        // `question` and `fix_hint` ride along, because a criterion without them cannot be judged.
        expect(calls.patchGoal).toEqual([
            [
                's1',
                {
                    criteria: [
                        {
                            op: 'add',
                            criterion: {
                                id: 'C-16',
                                label: 'every chapter ends on a question',
                                question: 'Does each chapter end on an open question?',
                                checker: 'judge',
                                hard: true,
                                fix_hint: 'Move the last paragraph of ch. 3 (C-16).'
                            }
                        }
                    ]
                }
            ]
        ]);
        // The form resets, so the next criterion starts from nothing.
        expect((screen.getByPlaceholderText('id (e.g. C-16)') as HTMLInputElement).value).toBe('');
    });

    it('edits the per-chapter bar and prints the server\u2019s per-chapter progress (§14 item 2, G-1, P6)', async () => {
        const { actions, calls } = fixtureActions();
        render(
            renderGoal({
                onSetChapterBar: (chapterId, override) => void actions.setChapterBar?.('s1', chapterId, override)
            })
        );

        const rows = Array.from(document.querySelectorAll<HTMLElement>('.sv-goal-bar-row'));
        expect(rows.length).toBe(4);
        // G-2: the chapter line is the server's string; `last_score` is rendered, never re-scored.
        expect(within(rows[1]).getByText('Ch 2 — Ghost Index')).toBeTruthy();
        expect(within(rows[1]).getByText('2/5 criteria passed')).toBeTruthy();
        // An existing override is shown as the current value, and prefilled for editing.
        expect(within(rows[1]).getByText('current: drop C-12 · +1 soft')).toBeTruthy();
        expect((rows[1].querySelector('.sv-goal-bar-input') as HTMLInputElement).value).toBe('drop C-12 · +1 soft');

        await type(rows[1].querySelector('.sv-goal-bar-input') as HTMLInputElement, 'drop C-12 · +1 hard');
        await click(within(rows[1]).getByRole('button', { name: 'Set bar' }));
        expect(calls.setChapterBar).toEqual([['s1', 'c2', 'drop C-12 · +1 hard']]);

        // A chapter with no override says `n/a` rather than inventing a number.
        expect(within(rows[2]).getByText('n/a')).toBeTruthy();
    });

    it('disables every Goal control and names the missing endpoint when the API has not landed', () => {
        render(renderGoal());

        const buttons = Array.from(
            document.querySelectorAll<HTMLButtonElement>(
                '.sv-criterion-toggle, .sv-criterion-delete, .sv-goal-threshold-save, .sv-goal-add-save, .sv-goal-bar-save'
            )
        );
        // 6 criteria in the reached levels (C-7/8/9 + C-10/11/13) x toggle+delete, the threshold
        // save, the add save, and one bar save per chapter.
        expect(buttons.length).toBe(6 * 2 + 1 + 1 + 4);
        expect(buttons.every((button) => button.disabled)).toBe(true);
        expect(row('C-8').querySelector('.sv-criterion-toggle')!.getAttribute('title')).toBe(
            'Goal edits land with the API'
        );
        expect((screen.getByLabelText(/Soft threshold/) as HTMLInputElement).disabled).toBe(true);
    });
});
