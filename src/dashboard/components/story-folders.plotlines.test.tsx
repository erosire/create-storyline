// T-W4 — Phrase ②'s dial on the Settings pane: the switch that decides WHICH Plotlines model this Story runs.
//
// The wire's rule is "absent means classic", exactly as R2's Editor-locking switch reads "absent means off", and
// the three states a test can distinguish are the three this file pins:
//
//   1. a Story that never carries the key (`fixtureStory()` — every book written before Phrase ②) renders
//      UNCHECKED and live; treating `undefined` as enabled would silently move an old book onto a pipeline whose
//      rows do not exist (L-13: absence is a value);
//   2. the click sends an EXPLICIT mode word — turning the dial off is a body the server can tell apart from a
//      body that never mentioned the dial, so `classic` has to travel even though it is the default;
//   3. once the phrase has STARTED the dial is shut (D-71): the Seed, the brief and the entries were written
//      against the mode that produced them, and a later click would strand rows the new mode cannot explain. The
//      box stays ticked and disabled — a control that disappeared would hide which pipeline the book is on.
//
// The click assertions read the recorder: `calls.setPlotlinesMode` is the exact `(storyId, mode)` pair the
// settings route receives, so a dial wired to the wrong Story or the wrong word fails here, not in front of the
// Author. The refusal sentences come from `story-contract` (L-13), and the pane prints them verbatim.
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SettingsPane } from './story-folders';
import { fixtureActions, fixtureView } from '../testing/story-fixtures';
import { PLOTLINE_MODE_LABEL, PLOTLINE_MODE_NOTE, plotlinesModeRefusal } from './story-contract';
import type { StoryViewData } from './story-contract';

/** The Settings pane with one Story's payload and a fresh recorder. */
function desk(options: { mode?: 'groups' | 'classic'; started?: boolean; unwired?: boolean } = {}) {
    const { actions, calls } = fixtureActions();
    const base = fixtureView();
    const view: StoryViewData = {
        ...base,
        // The dial's word travels on the Story ROW (what `PATCH /stories/:id` writes) and on the projected view;
        // an absent option here means the payload omits the key, which is the whole point of the first test.
        ...(options.mode === undefined ? {} : { plotlines_mode: options.mode }),
        phrase_started: { summary: true, plotlines: options.started === true },
        story: {
            ...base.story,
            ...(options.mode === undefined ? {} : { plotlines_mode: options.mode })
        }
    };

    return {
        calls,
        view,
        element: (
            <SettingsPane
                view={view}
                actions={options.unwired ? { ...actions, setPlotlinesMode: undefined } : actions}
            />
        )
    };
}

describe('SettingsPane — which Plotlines pipeline this Story runs (T-W4)', () => {
    it('is OFF for a Story that never carries the dial, which is the rule the wire runs on', () => {
        const { container } = render(desk().element);

        const box = screen.getByTestId('plotlines-mode') as HTMLInputElement;

        expect(box.checked).toBe(false);
        expect(box.disabled).toBe(false);
        // The label and the note are the contract module's, so the Setting's words cannot drift from the panes
        // that read the same dial (`isPlotlinesGroups`).
        expect(box.getAttribute('aria-label')).toBe(PLOTLINE_MODE_LABEL);
        expect(screen.getByTestId('setting-plotlines-mode-row').textContent).toBe(PLOTLINE_MODE_LABEL);
        expect(screen.getByTestId('plotlines-mode-note').textContent).toBe(PLOTLINE_MODE_NOTE);
        // The hover states the direction of the write the next click will send, so it cannot disagree with the
        // body (`plotlinesModeTitle`).
        expect(box.getAttribute('title')).toBe(
            'Turn Phrase 2 onto the chapter-entry pipeline: the Plotlines phrase writes one entry per chapter its brief declares, and those entries are what you revise.'
        );
        // Nothing is "closed" on a dial the phrase has not started.
        expect(container.querySelector('[data-testid="plotlines-mode-closed"]')).toBeNull();
        expect(container.querySelector('[data-testid="plotlines-mode-refusal"]')).toBeNull();
    });

    it('is ON for the chapter-entry pipeline, and the click that turns it off sends the explicit classic word', () => {
        const harness = desk({ mode: 'groups' });

        render(harness.element);

        const box = screen.getByTestId('plotlines-mode') as HTMLInputElement;

        expect(box.checked).toBe(true);
        expect(box.getAttribute('title')).toBe(
            'Turn Phrase 2 back to the classic plotline tools: the Plotlines pane goes back to the §4.3 records, and no chapter entries are written for this Story.'
        );

        fireEvent.click(box);

        // OFF is a word, not an omission: the patch body has to be distinguishable from a body that never
        // mentioned the dial.
        expect(harness.calls.setPlotlinesMode).toEqual([['s1', 'classic']]);
    });

    it('sends the grouped word when the Author turns it on', () => {
        const harness = desk();

        render(harness.element);

        fireEvent.click(screen.getByTestId('plotlines-mode'));

        expect(harness.calls.setPlotlinesMode).toEqual([['s1', 'groups']]);
    });

    it('closes with the start: ticked, shut, and the sentence says why (D-71)', () => {
        const harness = desk({ mode: 'groups', started: true });

        render(harness.element);

        const box = screen.getByTestId('plotlines-mode') as HTMLInputElement;

        // Which pipeline the book runs on is still readable — the tick stays, and the word beside it says the
        // dial is shut rather than leaving greyed ink as the only clue.
        expect(box.checked).toBe(true);
        expect(box.disabled).toBe(true);
        expect(screen.getByTestId('plotlines-mode-closed').textContent).toBe('closed with the start');

        // The refusal is the contract module's, printed twice on purpose: in the hover, and as the sentence the
        // Author reads without hovering (U-16), both the same string the route would 409 with.
        const refusal = plotlinesModeRefusal(harness.view, true);

        expect(refusal).toBe(
            'Phrase 2 has started on this Story: its Seed, its brief and its chapter entries were written against the mode that produced them, so the dial closed with the start — switching it now would leave rows the new mode cannot explain.'
        );
        expect(box.getAttribute('title')).toBe(refusal);
        expect(screen.getByTestId('setting-plotlines-mode-row').getAttribute('title')).toBe(refusal);
        expect(screen.getByTestId('plotlines-mode-refusal').textContent).toBe(refusal);

        // A forced click on a shut control sends nothing.
        fireEvent.click(box);

        expect(harness.calls.setPlotlinesMode).toBeUndefined();
        // The switch beside it is untouched by this dial's state: two settings, two independent verbs (D-33).
        expect((screen.getByTestId('editor-group-locking') as HTMLInputElement).disabled).toBe(false);
    });
});

describe('SettingsPane — the dial without a bound verb (U-16)', () => {
    it('states which route is missing, and still reports which way the Story currently stands', () => {
        const harness = desk({ mode: 'groups', unwired: true });

        render(harness.element);

        const box = screen.getByTestId('plotlines-mode') as HTMLInputElement;

        // A disabled control that hides the state is the defect U-16 exists to catch: the tick still says
        // `groups`, and the sentence says the SETTINGS route is what is missing — not the phrase's start.
        expect(box.checked).toBe(true);
        expect(box.disabled).toBe(true);
        expect(box.getAttribute('title')).toBe(
            'The Story settings route is not available in this shell, so the Setting cannot be changed.'
        );

        fireEvent.click(box);

        expect(harness.calls.setPlotlinesMode).toBeUndefined();
    });
});
