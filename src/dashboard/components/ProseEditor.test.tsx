// U-17 / U-5 / D-37 / D-37a / P11 — the prose editor: the Author\u2019s own typing surface, and the
// proposals that are the only other way an agent may touch it.
//
// The rules pinned here: the prose is READ-ONLY while the Story runs and the pane says why (D-37);
// Pause & edit states the price on its face (P8); a section write is a direct Author write (D-20a);
// proposals render as DIFFS with accept/reject/undo (U-5); and Resume names what the hand-back
// triggers, because D-37a re-derives the Digest and rechecks the declared dependents (L-9).
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ProseEditor } from './ProseEditor';
import { click, type } from '../testing/shell-fakes';
import { fixtureActions, fixtureChapters, fixtureProposals, fixtureStory } from './story-fixtures';

const C2 = fixtureChapters()[1];
const STORY = fixtureStory();

function renderEditor(props: Partial<Parameters<typeof ProseEditor>[0]> = {}) {
    return render(
        <ProseEditor
            chapter={C2}
            story={STORY}
            paused={false}
            killedRuns={1}
            liveRuns={1}
            dependents={[]}
            proposals={fixtureProposals()}
            {...props}
        />
    );
}

/** The section textareas, addressed by the section id the pane prints (D-7). */
function sectionField(sectionId: string): HTMLTextAreaElement {
    return screen.getByLabelText(`Section ${sectionId}`) as HTMLTextAreaElement;
}

describe('ProseEditor — the lock, the pause, and the diff (U-17, U-5, D-37, P11)', () => {
    it('locks the prose while the Story runs, states the rule, and prices Pause & edit on its face', async () => {
        const { actions, calls } = fixtureActions();
        renderEditor({ onPauseAndEdit: () => void actions.stop?.('s1') });

        expect(sectionField('s3').readOnly).toBe(true);
        expect(
            screen.getByText(/a write now is refused naming D-37, because a paragraph half-replaced by each side/)
        ).toBeTruthy();
        // U-17: the count is on the button, not in a tooltip.
        await click(
            screen.getByRole('button', { name: 'Pause & edit — kills 1 running run and halts dispatch (D-37)' })
        );
        expect(calls.stop).toEqual([['s1']]);
    });

    it('opens the prose from a pause, states what the pause already stopped, and writes a section directly', async () => {
        const edits: Array<{ storyId: string; chapterId: string; sectionId: string; text: string }> = [];
        const { actions, calls } = fixtureActions();
        renderEditor({
            paused: true,
            dependents: ['c4', 'c5'],
            onEditSection: (input) => void edits.push(input),
            onResume: () => void actions.resume?.('s1')
        });

        // U-17: a hand-edited Story is not a drained one, so the banner says which it is.
        expect(
            screen.getByText(
                /paused by you · 1 run stopped — the crew picks the book up exactly where it stands when you resume/
            )
        ).toBeTruthy();
        expect(sectionField('s3').readOnly).toBe(false);

        const save = screen.getAllByRole('button', { name: 'Save section' })[0];
        await type(sectionField('s3'), 'The index answered, and she answered back.');
        expect(screen.getByText('unsaved')).toBeTruthy();

        await click(save);
        // D-20a: a direct write, addressed to the section it changes (D-7's granularity).
        expect(edits).toEqual([
            { storyId: 's1', chapterId: 'c2', sectionId: 's3', text: 'The index answered, and she answered back.' }
        ]);
        expect(screen.getByText('saved')).toBeTruthy();

        // D-37a / L-9: Resume names the re-derivation and the dependents it rechecks.
        await click(
            screen.getByRole('button', {
                name: 'Resume — the Digest is re-derived and 2 dependent chapters marked for recheck (D-37a)'
            })
        );
        expect(calls.resume).toEqual([['s1']]);
        expect(
            screen.getByTitle(
                'Resume re-arms the Story and processes your edit as a commit: the Digest is re-derived from it (D-12a) and 2 dependent chapters (c4, c5) are marked needs_recheck (D-37a, L-11a).'
            )
        ).toBeTruthy();
    });

    it('shows the audit line for every paragraph — which run changed it, and why (P11)', () => {
        renderEditor();

        expect(
            within(document.querySelector('.sv-section') as HTMLElement).getByText(
                'last change — r-2 · why: C-8: the chapter must change who speaks.'
            )
        ).toBeTruthy();
        // The Writer's span and the Author's span are distinguishable (P9 / T-2).
        expect(screen.getByText('the Writer wrote this')).toBeTruthy();
    });

    it('renders pending proposals against THIS chapter as diffs, with accept, reject, and undo (U-5, D-20)', async () => {
        const { actions, calls } = fixtureActions();
        renderEditor({
            paused: true,
            onAcceptProposal: (proposalId) => void actions.acceptProposal?.('s1', proposalId),
            onRejectProposal: (proposalId) => void actions.rejectProposal?.('s1', proposalId),
            onUndo: (input) => void actions.undo?.('s1', { chapter_id: 'c2', section_id: input.targetRef })
        });

        // U-5: one proposal row for this chapter; the accepted one in chapter 1 is not listed here.
        const row = document.querySelector('.sv-proposal') as HTMLElement;
        expect(document.querySelectorAll('.sv-proposal').length).toBe(1);
        expect(within(row).getByText('pending')).toBeTruthy();
        // The row names the span twice on purpose: the target it is against (`sv-proposal-target`)
        // and the section id carried inside the patch (`sv-proposal-section`), so both are asserted
        // on their own nodes rather than as ambiguous page-wide text.
        expect(row.querySelector('.sv-proposal-target')?.textContent).toBe('section s3');
        expect(row.querySelector('.sv-proposal-section')?.textContent).toBe('section s3');
        expect(within(row).getByText('run r-2')).toBeTruthy();
        expect(
            screen.getByText('why — C-8: the chapter must change who speaks, and it does not yet (D-20).')
        ).toBeTruthy();

        // A diff, not a replaced paragraph: the removed span and the added span are both marked.
        const diff = document.querySelector('.sv-proposal-diff') as HTMLElement;
        expect(diff.querySelectorAll('.sv-diff-removed').length).toBe(2);
        expect(diff.querySelectorAll('.sv-diff-added').length).toBe(2);
        expect(within(diff).getByText('[-years-]')).toBeTruthy();
        expect(within(diff).getByText('{+—+}')).toBeTruthy();

        await click(screen.getByRole('button', { name: 'Accept' }));
        expect(calls.acceptProposal).toEqual([['s1', 'pr-1']]);
        // Undo appears right where the decision was made, and rewinds the span it touched (P11).
        await click(screen.getByRole('button', { name: 'Undo' }));
        expect(calls.undo).toEqual([['s1', { chapter_id: 'c2', section_id: 's3' }]]);
        // After deciding, the row cannot be decided twice.
        expect((screen.getByRole('button', { name: 'Accept' }) as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByText('accepted')).toBeTruthy();
    });

    it('rejects a proposal and surfaces the server\u2019s refusal naming the rule (D-20, T-1a)', async () => {
        const { actions, calls } = fixtureActions();
        renderEditor({
            paused: true,
            // T-1a: the server refuses by naming the rule; the refusal is the Author's information.
            onEditSection: () =>
                Promise.reject(new Error('P9: this section is yours, so an agent may only propose against it (D-20)')),
            onRejectProposal: (proposalId) => void actions.rejectProposal?.('s1', proposalId)
        });

        await click(screen.getByRole('button', { name: 'Reject' }));
        expect(calls.rejectProposal).toEqual([['s1', 'pr-1']]);
        expect(screen.getByText('rejected')).toBeTruthy();

        await click(screen.getAllByRole('button', { name: 'Save section' })[0]);
        expect(
            screen.getByText(
                'The server refused this write: P9: this section is yours, so an agent may only propose against it (D-20)'
            )
        ).toBeTruthy();
    });
});
