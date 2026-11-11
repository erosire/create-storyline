// U-4 / U-16 / L-30 / §8.6 — the Summary pane.
//
// Three things are pinned here: a LOCKED pane states that Backtrack is the only way in and offers
// it with the deletion sentence (L-31, L-32); the confirm is two-step, so the destructive sentence
// is read before the click that commits it; and every field carries §8.6's Ask-assistant affordance,
// which is the only field-level write v1 has (the read-only-in-v1 gap is stated on the pane).
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { SummaryPane } from './SummaryPane';
import { click } from '../testing/shell-fakes';
import { fixtureActions, fixtureStory, fixtureSummary } from './story-fixtures';

const DELETION_SENTENCE =
    'Backtrack to ① Summary deletes 4 chapters with their 4 revisions, 2 plotlines, and the derived Digest. ' +
    'Verdicts and findings survive as provenance; the Ideas do not — the lock already deleted them (D-25, D-36, L-31). ' +
    'Story "Neon Cathedral" starts again from its Seed.';

describe('SummaryPane — locked law, and the one way in (U-4, U-16, L-30, L-32)', () => {
    it('marks the locked Summary read-only for every agent and names Backtrack as the only move', async () => {
        const { actions, calls } = fixtureActions();
        render(
            <SummaryPane
                story={fixtureStory()}
                summary={fixtureSummary()}
                onBacktrack={(phase) => void actions.backtrack?.('s1', phase)}
                backtrackNote={DELETION_SENTENCE}
            />
        );

        expect(screen.getByText('locked — read-only for every agent (P5, L-30)')).toBeTruthy();
        expect(screen.getByText(/the only move is a Backtrack/)).toBeTruthy();

        const pane = screen.getByRole('region', { name: 'Summary' });
        const confirm = within(pane);
        // The Author's writes are absent by design: no textarea is pretending to save (the gap is stated).
        expect(pane.querySelectorAll('textarea').length).toBe(0);

        // Step 1: the button asks; nothing is sent yet (L-32 wants the sentence read, not clicked past).
        await click(confirm.getByRole('button', { name: 'Backtrack' }));
        expect(calls.backtrack).toBeUndefined();
        expect(screen.getByText(DELETION_SENTENCE)).toBeTruthy();

        // Cancel leaves the record untouched.
        await click(screen.getByRole('button', { name: 'Cancel' }));
        expect(calls.backtrack).toBeUndefined();

        // Step 2: the confirm commits, with the route's exact arguments.
        await click(confirm.getByRole('button', { name: 'Backtrack' }));
        await click(screen.getByRole('button', { name: 'Confirm' }));
        expect(calls.backtrack).toEqual([['s1', 'summary']]);
    });

    it('prints every §4.2 field read-only, and calls a missing field what it is', () => {
        const summary = { ...fixtureSummary(), ending: undefined };
        render(<SummaryPane story={{ ...fixtureStory(), summary_locked: false }} summary={summary} />);

        expect(screen.getByText('A flooded city keeps its memory in a sealed cathedral of data.')).toBeTruthy();
        expect(screen.getByText('Close third, present tense, spare and technical; no irony.')).toBeTruthy();
        // G-3a: the tone sheet is labelled with what it is graded against.
        expect(screen.getByText('Tone (voice · POV · tense · register)')).toBeTruthy();
        expect(screen.getAllByText('not written yet').length).toBe(1);
        // D-3b: the chapter count is Author truth, marked as such.
        expect(screen.getByText('7')).toBeTruthy();
        expect(screen.getByText('Author-declared · read-only for every agent (D-3b)')).toBeTruthy();
        // The v1 gap is stated, not hidden (U-16's discipline applied to a missing endpoint).
        expect(screen.getByText(/read-only in v1: the pinned API has no Author summary write/)).toBeTruthy();
    });

    it('offers §8.6\u2019s one-field assistant run per field, and disables it when the route is absent', async () => {
        const { actions, calls } = fixtureActions();
        const { rerender } = render(
            <SummaryPane
                story={fixtureStory()}
                summary={fixtureSummary()}
                onAskAssistant={(field) =>
                    void actions.requestAssistant?.('s1', { target: 'summary', text: `Rewrite the ${field}.` })
                }
            />
        );

        // One affordance per field (D-3): a field-level run, not a pane-level one.
        expect(screen.getAllByRole('button', { name: 'Ask assistant' }).length).toBe(6);
        await click(screen.getAllByRole('button', { name: 'Ask assistant' })[0]);
        expect(calls.requestAssistant).toEqual([['s1', { target: 'summary', text: 'Rewrite the premise.' }]]);

        // Without the verb, the control stays visible and says the endpoint has not landed.
        rerender(<SummaryPane story={fixtureStory()} summary={fixtureSummary()} />);
        const disabled = screen.getAllByRole('button', { name: 'Ask assistant' });
        expect(disabled.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
        expect(disabled[0].getAttribute('title')).toBe('Assistant runs land with the API (§8.6)');
    });
});
