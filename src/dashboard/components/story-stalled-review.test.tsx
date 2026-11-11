// U-1a / L-23 — the stalled review surface.
//
// U-1a says the stalled screen is a REVIEW surface, not a log, and names what it must hold: the stuck
// criteria, the oldest open findings, the chapters involved, what the crews TRIED across rounds, and
// L-23's four exits as buttons. Every assertion below is an exact value, because the whole point of
// the screen is that the Author reads a sentence and reaches for a button — a paraphrased round line
// or a missing exit is the failure mode this pane exists to prevent.
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { StalledReview } from './story-stalled-review';
import { click, type } from '../testing/shell-fakes';
import { fixtureActions, fixtureView } from './story-fixtures';

function renderPane(options: { withActions?: boolean; noHistory?: boolean } = {}) {
    const { actions, calls } = fixtureActions();
    const view = fixtureView();

    if (options.noHistory) view.level_history = [];

    const ui = (
        <StalledReview
            view={view}
            // The no-actions case is the shipped default shape of `StoryActions` (every method
            // optional): the exits must render DISABLED rather than vanish or throw.
            actions={options.withActions === false ? {} : actions}
        />
    );

    return { ...render(ui), calls, view };
}

/** The rendered round lines, in the order the pane prints them (oldest first, as stored). */
function roundLines(): string[] {
    return Array.from(document.querySelectorAll<HTMLElement>('.sv-stalled-round')).map((row) => row.textContent!);
}

/** The four L-23 exits, as `[class, label, disabled]`. */
function exits(): Array<[string, string, boolean]> {
    return Array.from(document.querySelectorAll<HTMLButtonElement>('.sv-stalled-exits .sv-exit')).map((button) => [
        button.className,
        button.textContent!,
        button.disabled
    ]);
}

describe('StalledReview — the review surface and the four exits (U-1a, L-23)', () => {
    it('prints what the crews tried, one exact line per round, L-14 level sentence first', () => {
        renderPane();

        expect(roundLines()).toEqual([
            'round 6 · chapters · idea→summary 4/4 · summary→plotlines 6/6 · plotlines→chapters 4/6 · whole-story 2/5 — closed fp-c4-no-change — 1 new confirmed finding(s) — flat streak 0 · trend improving',
            // The numbers are IDENTICAL to round 6 and a fingerprint came back: that pair is L-21's
            // stall, and the line says so without editorialising.
            'round 7 · chapters · idea→summary 4/4 · summary→plotlines 6/6 · plotlines→chapters 4/6 · whole-story 2/5 — came back fp-c4-no-change — flat streak 2 · trend flat'
        ]);
    });

    it('says there is no round history instead of inventing one (L-15)', () => {
        renderPane({ noHistory: true });

        expect(roundLines()).toEqual([]);
        expect(document.querySelector('.sv-stalled-rounds .sv-stalled-none')!.textContent).toBe(
            'No round has been recorded yet — the crews have not completed a pass since the Story started (L-15).'
        );
    });

    it('lists the stuck criteria in the engine\u2019s own words, and the oldest open findings with the chapters they involve (U-1a)', () => {
        renderPane();

        expect(
            Array.from(document.querySelectorAll<HTMLElement>('.sv-stalled-criterion')).map((row) => [
                row.querySelector('.sv-stalled-criterion-id')!.textContent,
                row.querySelector('.sv-stalled-criterion-fix')!.textContent
            ])
        ).toEqual([
            ['C-8', 'Change who speaks by the end of chapter 2 (C-8).'],
            ['C-11', 'Pay the promise the Summary makes, in act two (C-11).']
        ]);

        // `f2` is `fixed`, so it is not an OPEN finding; `f1` is the only row the screen owes.
        expect(
            Array.from(document.querySelectorAll<HTMLElement>('.sv-stalled-finding')).map((row) => [
                row.querySelector('.sv-finding-cost')!.textContent,
                row.querySelector('.sv-stalled-finding-title')!.textContent,
                row.querySelector('.sv-stalled-finding-state')!.textContent
            ])
        ).toEqual([['major', 'Act two changes nothing', 'approved']]);

        // L-11a: the chapters involved come from `target_ref` AND `related_refs`, named by order and title.
        expect(document.querySelector('.sv-stalled-chapters')!.textContent).toBe(
            'Chapters involved: ch. 4 — Act Two, Drowned'
        );
    });

    it('offers exactly L-23\u2019s four exits as buttons, and disables every one when the action has not landed', () => {
        const { container } = renderPane({ withActions: false });

        expect(Array.from(container.querySelectorAll('.sv-stalled-exits .sv-exit')).length).toBe(4);
        expect(exits()).toEqual([
            ['sv-exit sv-exit-contract', 'Fix the contract — backtrack to plotlines', true],
            ['sv-exit sv-exit-template', 'Fix the brief — save these selection rules', true],
            ['sv-exit sv-exit-directive', 'Issue the directive', true],
            ['sv-exit sv-exit-bar', 'Lower the bar to 2', true]
        ]);
    });

    it('every exit calls its own verb, and each one is the re-arm L-23 promises', async () => {
        const { calls } = renderPane();

        // 1. the contract was wrong: the phase that OWNS the stall. Chapters come from plotlines, so
        //    the backtrack target is `plotlines` (L-23, L-31).
        await click(document.querySelector('.sv-exit-contract')!);
        expect(calls.backtrack).toEqual([['s1', 'plotlines']]);

        // 2. the crew\u2019s taste or brief was wrong: new selection rules on the assigned template.
        await type(document.querySelector('.sv-exit-rules') as HTMLElement, 'prefer the draft that pays off the map');
        await click(document.querySelector('.sv-exit-template')!);
        expect(calls.patchTemplate).toEqual([
            ['t-chapters', { selection_rules: 'prefer the draft that pays off the map' }]
        ]);

        // 3. the crew needed a decision: a directive, aimed at the Story the Author is looking at.
        await type(document.querySelector('.sv-exit-directive-text') as HTMLElement, 'the ridge is seen, never named');
        await click(document.querySelector('.sv-exit-directive')!);
        expect(calls.sendDirective).toEqual([['s1', 'the ridge is seen, never named']]);

        // 4. this criterion does not matter: the Goal\u2019s soft threshold, one notch down (G-1).
        await click(document.querySelector('.sv-exit-bar')!);
        expect(calls.patchGoal).toEqual([['s1', { threshold_soft: 2, criteria: [] }]]);
    });

    it('refuses to fire the directive or the rules exit on empty input — an empty write is not a decision', async () => {
        const { calls } = renderPane();

        expect((document.querySelector('.sv-exit-directive') as HTMLButtonElement).disabled).toBe(true);
        expect((document.querySelector('.sv-exit-template') as HTMLButtonElement).disabled).toBe(true);

        await click(document.querySelector('.sv-exit-directive')!);
        await click(document.querySelector('.sv-exit-template')!);

        expect(calls.sendDirective).toBeUndefined();
        expect(calls.patchTemplate).toBeUndefined();
    });
});
