// U-14 / §6.9 / L-25 / L-25b / L-26 — completion is a proposal, and the prompt is where the
// Author accepts it with their eyes open.
//
// The sentence is the test: L-25b forbids a quietly emptied to-do list, so the count of what
// Acceptance throws away has to be readable BEFORE the button is pressed.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CompletionPrompt } from './CompletionPrompt';
import { click } from '../testing/shell-fakes';
import { fixtureActions, fixtureCompletion, fixtureStory } from './story-fixtures';

function renderPrompt(props: Partial<Parameters<typeof CompletionPrompt>[0]> = {}) {
    return render(<CompletionPrompt preview={fixtureCompletion()} story={fixtureStory()} {...props} />);
}

describe('CompletionPrompt — the count, before the Accept (U-14, L-25b, L-26)', () => {
    it('states the discard in the server\u2019s own numbers, including the oldest open item', () => {
        renderPrompt({ ledgerState: 'ledger: 2 setups unpaid · 1 conflict' });

        // THE sentence (L-25b), kept as the acceptance text rather than a tooltip.
        expect((document.querySelector('.sv-completion-discard') as HTMLElement).textContent).toBe(
            '47 findings and 12 Ideas will be closed without action, the oldest from chapter 2 (L-25b).'
        );
        expect(screen.getByText('The crew proposes the book is done')).toBeTruthy();
        // L-26: the loop stopped looking for work; it is the Author who closes it.
        expect(
            screen.getByText('the loop stopped looking for work — it is the Author who completes it (L-26)')
        ).toBeTruthy();

        // G-2: the levels are the server's sentence, and the ledger state rides along when the caller has it (L-25).
        expect(
            screen.getByText('Seed→Summary 2/2 · Summary→Plotlines 6/7 · Plotlines→Chapters 1/3 · Whole Story 0/3')
        ).toBeTruthy();
        expect(screen.getByText('ledger: 2 setups unpaid · 1 conflict')).toBeTruthy();
        expect(screen.getByText('flat')).toBeTruthy();
    });

    it('accepts completion as the Story\u2019s own sign-off, and says when the endpoint is missing (L-25a)', async () => {
        const { actions, calls } = fixtureActions();
        const { rerender } = renderPrompt({ onAccept: (storyId) => void actions.acceptCompletion?.(storyId) });

        await click(screen.getByRole('button', { name: 'Accept completion' }));
        expect(calls.acceptCompletion).toEqual([['s1']]);

        rerender(<CompletionPrompt preview={fixtureCompletion()} story={fixtureStory()} />);
        const disabled = screen.getByRole('button', { name: 'Accept completion' }) as HTMLButtonElement;
        expect(disabled.disabled).toBe(true);
        expect(disabled.getAttribute('title')).toBe('The completion endpoint has not landed yet.');
    });

    it('omits the ledger line rather than inventing one, and says so when no levels are measured', () => {
        renderPrompt({ story: { ...fixtureStory(), consistency: undefined } });

        expect(document.querySelector('.sv-completion-facts .sv-completion-fact:nth-of-type(2) dt')?.textContent).toBe(
            'Trend'
        );
        expect(screen.getByText('no levels measured yet')).toBeTruthy();
    });
});
