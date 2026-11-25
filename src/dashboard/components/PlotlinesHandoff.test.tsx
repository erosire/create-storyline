// T-W4 — the handoff card: the one verb that turns the finished Summary into Phrase ②'s Seed.
//
// What this suite pins is the CARD'S SIDE of the contract, which no other file can:
//   1. the ENABLE condition is the projection's flag (`story.summary_compiled`), not a client-side guess from the
//      group rows — a button that enabled on its own reading would be refused by the route it is aiming at;
//   2. the START BODY names exactly one arm (`{source:'compiled'}` or `{source:'custom', text}`), because
//      `routes.ts:PhraseStartBody` reads one arm per request and a stray `text` beside `'compiled'` is a 400;
//   3. a shut control states the reason it is shut, in the wire's or the shell's own words (U-16);
//   4. once the phrase has started the card is a RECEIPT — the start is one-way (D-72), so a live button here
//      would promise a write the route refuses with a 409.
// The verb's arguments are asserted as recorded argument lists (`calls.startPhrase`), never as "was called".
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PlotlinesHandoff } from './PlotlinesHandoff';
import { fixtureActions, fixturePhrase, fixtureView } from './story-fixtures';
import type { StorySelection } from './story-nav';
import type { StoryViewData } from './story-contract';
import { phraseDetailView } from '../testing/shell-fakes';
import type { PhraseDetailView } from '../api';

/**
 * The grouped book, with the two facts the card reads set by the caller. They live on the STORY VIEW
 * (`api.ts:StoryView:319-347`) because the projection computes them; `phraseDetail` is the Phrase ② read, which
 * the receipt's sentence and its copied-Seed head come from.
 */
function handoffView(
    over: { compiled?: boolean; started?: boolean; detail?: PhraseDetailView } = {}
): StoryViewData {
    const view = fixtureView({ phrase: fixturePhrase() });

    return {
        ...view,
        phrase_started: { summary: true, plotlines: over.started === true },
        summary_compiled: over.compiled === true,
        ...(over.detail === undefined ? {} : { phraseDetail: over.detail })
    };
}

describe('PlotlinesHandoff — the compiled arm (R5)', () => {
    it('starts Phrase 2 from the compiled Summary in one press, and the body names only that source', () => {
        const { actions, calls } = fixtureActions();
        const { container } = render(<PlotlinesHandoff view={handoffView({ compiled: true })} actions={actions} />);

        // The badge states the gate's state before the button is read: `ready to start` is the compiled flag,
        // and the tone attribute is what the stylesheet colours from.
        expect(screen.getByTestId('plotlines-handoff-state').textContent).toBe('ready to start');
        expect(screen.getByTestId('plotlines-handoff-state').getAttribute('data-tone')).toBe('ready');

        const button = screen.getByTestId('plotlines-handoff-compiled');

        expect(button.hasAttribute('disabled')).toBe(false);
        expect(button.getAttribute('title')).toBe(
            'Start Phrase 2 from the compiled Summary — the Overview is copied into the phrase as its Seed (R5).'
        );
        expect(button.textContent).toBe('Start Phrase 2 from the compiled Summary');

        fireEvent.click(button);

        // THE BODY, EXACTLY: `(storyId, 'plotlines', {source:'compiled'})`. No `text` key — the route reads one
        // arm per request, and an empty or stray one is the 400 the refusal above exists to avoid.
        expect(calls.startPhrase).toEqual([['s1', 'plotlines', { source: 'compiled' }]]);
        // There is no refusal line when the control is live: a warning the Author has to dismiss is noise.
        expect(container.querySelector('[data-testid="plotlines-handoff-refusal"]')).toBeNull();
    });

    it('refuses while the Summary is not compiled, and says where the wait is rather than going dark', () => {
        const { actions, calls } = fixtureActions();
        render(<PlotlinesHandoff view={handoffView({ compiled: false })} actions={actions} />);

        expect(screen.getByTestId('plotlines-handoff-state').textContent).toBe('waiting on the Summary');

        const button = screen.getByTestId('plotlines-handoff-compiled');

        expect(button.hasAttribute('disabled')).toBe(true);
        expect(button.getAttribute('title')).toBe(
            'There is no compiled Summary to start Phrase 2 from yet — the Overview (or the reviewed Summary) is the text the phrase copies, so the gate is above this control (R5).'
        );
        // A disabled button alone does not say WHERE the wait is, so the same sentence sits under the card
        // (the contract module's copy, verbatim — L-13).
        expect(screen.getByTestId('plotlines-handoff-refusal').textContent).toBe(
            'There is no compiled Summary to start Phrase 2 from yet — the Overview (or the reviewed Summary) is the text the phrase copies, so the gate is above this control (R5).'
        );

        // A press on a shut control sends nothing, even when the click is forced through.
        fireEvent.click(button);

        expect(calls.startPhrase).toBeUndefined();
    });

    it('states the missing verb when the shell has no start action, and hides the arm that would need it', () => {
        const { container } = render(<PlotlinesHandoff view={handoffView({ compiled: true })} />);

        // U-16: a shut control says WHICH route is missing. This is a pane rendered without a store, and the
        // copy must not pretend the gate is the Summary's.
        expect(screen.getByTestId('plotlines-handoff-compiled').hasAttribute('disabled')).toBe(true);
        expect(screen.getByTestId('plotlines-handoff-refusal').textContent).toBe(
            'The phrase start route is not available in this shell.'
        );
        // The skip arm would open a form whose only verb is the missing one, so it is not rendered at all —
        // a field that cannot be submitted is a promise the shell cannot keep.
        expect(container.querySelector('[data-testid="plotlines-handoff-custom-open"]')).toBeNull();
    });
});

describe('PlotlinesHandoff — the custom-seed arm (the skip)', () => {
    it('is reached by a second click, so the one-press path stays the compiled Summary', () => {
        const { actions } = fixtureActions();
        const { container } = render(<PlotlinesHandoff view={handoffView({ compiled: true })} actions={actions} />);

        expect(container.querySelector('[data-testid="plotlines-handoff-custom"]')).toBeNull();

        fireEvent.click(screen.getByTestId('plotlines-handoff-custom-open'));

        expect(screen.getByTestId('plotlines-handoff-custom')).toBeTruthy();
        expect(screen.getByTestId('plotlines-handoff-custom-note').textContent).toBe(
            'What you write here becomes the Seed instead of the compiled Summary. The Editor ' +
                'structures it into chapters exactly as it does the Overview, and the start is still ' +
                'one-way (D-72).'
        );
        // The compiled arm stays on screen but goes shut while the form is open: the Author can see what the
        // other arm would have done, and the `title` says why it is shut (U-16).
        const compiled = screen.getByTestId('plotlines-handoff-compiled');

        expect(compiled.hasAttribute('disabled')).toBe(true);
        expect(compiled.getAttribute('title')).toBe(
            'The custom Seed form is open — “Keep the compiled Summary” closes it.'
        );
    });

    it('refuses an empty Seed with the route’s own reason, and sends the text trimmed', () => {
        const { actions, calls } = fixtureActions();
        render(<PlotlinesHandoff view={handoffView({ compiled: true })} actions={actions} />);

        fireEvent.click(screen.getByTestId('plotlines-handoff-custom-open'));

        const submit = screen.getByTestId('plotlines-handoff-custom-submit');

        // Empty, and whitespace-only, are the same state to the route (`routes.ts:PhraseStartBody`).
        expect(submit.hasAttribute('disabled')).toBe(true);
        expect(submit.getAttribute('title')).toBe(
            'Write the Seed first — a custom start copies what you type into the phrase, and an empty Seed leaves Phrase 2 with nothing to write from (the route refuses it).'
        );

        fireEvent.change(screen.getByTestId('plotlines-handoff-custom-text'), {
            target: { value: '   six chapters, alternating timeline, no frame story   ' }
        });

        expect(submit.hasAttribute('disabled')).toBe(false);
        expect(submit.getAttribute('title')).toBe('Start Phrase 2 on this text.');

        fireEvent.click(submit);

        // Trimmed, and `source:'custom'` — the two arms differ by exactly this body, so an accidental
        // `{source:'compiled', text}` is the bug this assertion catches.
        expect(calls.startPhrase).toEqual([
            ['s1', 'plotlines', { source: 'custom', text: 'six chapters, alternating timeline, no frame story' }]
        ]);
    });

    it('drops the pending text on send and on cancel, so the next arm starts from the record (P1)', () => {
        const { actions, calls } = fixtureActions();
        const { container } = render(<PlotlinesHandoff view={handoffView({ compiled: true })} actions={actions} />);

        // Cancel: the Author decided against the skip, and the typed text is not part of the record.
        fireEvent.click(screen.getByTestId('plotlines-handoff-custom-open'));
        fireEvent.change(screen.getByTestId('plotlines-handoff-custom-text'), { target: { value: 'a plan' } });
        fireEvent.click(screen.getByTestId('plotlines-handoff-custom-cancel'));

        expect(container.querySelector('[data-testid="plotlines-handoff-custom"]')).toBeNull();
        expect(calls.startPhrase).toBeUndefined();

        fireEvent.click(screen.getByTestId('plotlines-handoff-custom-open'));

        expect((screen.getByTestId('plotlines-handoff-custom-text') as HTMLTextAreaElement).value).toBe('');

        // Send: the same reset, so a receipt appearing beside a stale draft cannot misread as a second pending write.
        fireEvent.change(screen.getByTestId('plotlines-handoff-custom-text'), { target: { value: 'six chapters' } });
        fireEvent.click(screen.getByTestId('plotlines-handoff-custom-submit'));

        expect(calls.startPhrase).toEqual([['s1', 'plotlines', { source: 'custom', text: 'six chapters' }]]);
        expect(container.querySelector('[data-testid="plotlines-handoff-custom"]')).toBeNull();
    });
});

describe('PlotlinesHandoff — the started state is a receipt, not a dead button (D-72)', () => {
    it('reports the copied Seed the read carries, and offers the surface that opened', () => {
        const selections: StorySelection[] = [];
        const { actions, calls } = fixtureActions();
        const detail = phraseDetailView('s1', { seed_head: 'Premise: a flooded city.', seed_chars: 1_284 });

        render(
            <PlotlinesHandoff
                view={handoffView({ compiled: true, started: true, detail })}
                actions={actions}
                onSelect={(next) => selections.push(next)}
            />
        );

        expect(screen.getByTestId('plotlines-handoff-started').textContent).toBe('started');
        expect(screen.getByTestId('plotlines-handoff-seed').textContent).toBe(
            'Phrase 2 has started on this Story. Its Seed is 1284 characters of the Summary the crew compiled, and every chapter entry, revision and claim key is written against it (D-72).'
        );
        expect(screen.getByTestId('plotlines-handoff-seed-head').textContent).toBe('Premise: a flooded city.');

        fireEvent.click(screen.getByTestId('plotlines-handoff-open'));

        expect(selections).toEqual([{ panel: 'plotlines' }]);
        // Nothing here can start the phrase again: no live button, and no press.
        expect(screen.queryByTestId('plotlines-handoff-compiled')).toBeNull();
        expect(calls.startPhrase).toBeUndefined();
    });

    it('keeps to the flag it has when the phrase read is not in the frame', () => {
        const { container } = render(
            <PlotlinesHandoff view={handoffView({ started: true })} actions={fixtureActions().actions} />
        );

        // The receipt never invents a character count or a Seed head: with no read it states the flag alone,
        // and the head paragraph is absent rather than empty.
        expect(screen.getByTestId('plotlines-handoff-seed').textContent).toBe(
            'Phrase 2 has started on this Story: its Seed is copied, and every chapter entry, revision and claim key is written against it (D-72).'
        );
        expect(container.querySelector('[data-testid="plotlines-handoff-seed-head"]')).toBeNull();
        // And the live card's badge is gone, not merely hidden: a second status word on the same decision is noise.
        expect(container.querySelector('[data-testid="plotlines-handoff-state"]')).toBeNull();
    });

    it('renders the started state even when the Summary stopped looking compiled', () => {
        const { actions } = fixtureActions();
        render(<PlotlinesHandoff view={handoffView({ started: true, compiled: false })} actions={actions} />);

        // A started phrase's receipt does not depend on the compiled flag: the Summary may move on (a backtrack
        // rewrites it), and the phrase's start is still a fact about the past.
        expect(screen.getByTestId('plotlines-handoff-started').textContent).toBe('started');
        expect(screen.queryByTestId('plotlines-handoff-refusal')).toBeNull();
    });
});
