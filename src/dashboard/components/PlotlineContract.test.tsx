/**
 * PlotlineContract.test.tsx — the ONE read-only rendering of a chapter's contract.
 *
 * Both readers mount this component (the classic Plotlines card via
 * `components/PlotlinesPane.tsx:40` and the chapter compare view via
 * `components/PlotlineChapters.tsx:141`), so the rules it has to keep are pinned here
 * once, rather than twice through two different panes:
 *  - beats render as an ORDERED list in stored order — the order is what C-7 measures;
 *  - dialogue renders under its own label, and an empty list renders NO section at all,
 *    mirroring the route, which omits the `Important dialogue:` block when it is blank
 *    (`server/phrase/plotpoints.ts:chapterEntryContent`);
 *  - a row written before `beats` still reads, recovered from the legacy `must_happen`
 *    prose by `story-contract.plotlineBeatsOf` — and the desk never invents a longer list;
 *  - a contract with no beats says so in the CALLER's words, and the view stays read-only.
 */
import { describe, expect, test } from 'vitest';
import { render } from '@testing-library/react';
import type { Plotline } from '../../types';
import { PlotlineContract } from './PlotlineContract';
import { fixturePlotlines } from '../testing/story-fixtures';

/** One card's worth of props, so each test changes only the row it is about. */
const viewOf = (plotline: Plotline) =>
    render(
        <PlotlineContract
            plotline={plotline}
            contractClassName="plot-card-fields"
            fieldClassName="plot-card-field"
            testId={`plot-card-${plotline.id}`}
            emptyLine="No beats recorded on this contract — C-3 has no last beat to read (P4)."
        />,
    );

describe('PlotlineContract', () => {
    test('renders the beats as an ordered list, in the order the Server stored them', () => {
        // p1 is the fixture's no-dialogue contract: two beats, the last one the change
        // C-3 reads, so this one row pins both the order and the omission.
        const [first] = fixturePlotlines();
        const screen = viewOf(first);

        expect(screen.getByTestId('plot-card-p1-contract').className).toBe('plot-card-fields');
        // `ol` and not `ul` because the position IS the content; the numbers are how the
        // Author sees which beat is last.
        const beats = screen.getByTestId('plot-card-p1-beats');
        expect(beats.tagName).toBe('OL');
        expect(beats.className).toBe('sv-contract-beats');
        expect([...beats.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
            'She is refused entry and names the refusal.',
            'She goes from archivist to trespasser.',
        ]);
        // Each row is addressable on its own, because a reader that cites a beat has to
        // name its position.
        expect(screen.getByTestId('plot-card-p1-beat-0').textContent).toBe(
            'She is refused entry and names the refusal.',
        );
        expect(screen.getByTestId('plot-card-p1-beat-1').textContent).toBe(
            'She goes from archivist to trespasser.',
        );
        // The deprecated fields are not printed as rows of their own: p1 carries
        // `pov: 'Hale'` and `setups`, and none of that is a beat.
        expect(screen.getByTestId('plot-card-p1-contract').textContent).not.toContain('Hale');
        expect(screen.getByTestId('plot-card-p1-contract').textContent).not.toContain('POV');
    });

    test('omits the dialogue section when the contract owes no lines', () => {
        const [first] = fixturePlotlines();
        const screen = viewOf(first);

        // Absent is stated by absence: the route writes no `Important dialogue:` block for
        // an empty list, so a heading over nothing would be the desk inventing a requirement.
        expect(screen.queryByTestId('plot-card-p1-dialogue')).toBeNull();
        expect(screen.getByTestId('plot-card-p1-contract').querySelectorAll('div')).toHaveLength(1);
        // The beats that do exist are untouched by the omission.
        expect(screen.getByTestId('plot-card-p1-beats').querySelectorAll('li')).toHaveLength(2);
    });

    test('renders dialogue as its own ordered-by-hand list after the beats', () => {
        const [, second] = fixturePlotlines();
        const screen = viewOf(second);

        expect([...screen.getByTestId('plot-card-p2-beats').querySelectorAll('li')].map((item) => item.textContent)).toEqual([
            'The index answers in a voice that is not hers.',
            'She stops trusting the record.',
        ]);
        // Dialogue is a `ul`, not an `ol`: the lines are a set to land, and only the beats
        // are a sequence C-7 measures.
        const dialogue = screen.getByTestId('plot-card-p2-dialogue');
        expect(dialogue.tagName).toBe('UL');
        expect(dialogue.className).toBe('sv-contract-dialogue');
        expect([...dialogue.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
            '"That is my voice, and it is not in the catalogue."',
        ]);
        expect(screen.getByTestId('plot-card-p2-dialogue-0').textContent).toBe(
            '"That is my voice, and it is not in the catalogue."',
        );
        // The dialogue rows come AFTER the beats, which is the order the entry text has
        // them in, so the two surfaces read the same contract the same way round.
        const order = [...screen.getByTestId('plot-card-p2-contract').querySelectorAll('dt')].map((item) => item.textContent);
        expect(order).toEqual(['Beats', 'Important dialogue']);
    });

    test('recovers beats line by line from a row written before the field', () => {
        const [first] = fixturePlotlines();
        // A pre-beats row: no `beats` key at all, and the one event list it ever stated in the
        // old `must_happen` prose, one event per line. The prose's own punctuation stays put —
        // the recovery splits, it does not rewrite.
        const legacy: Plotline = {
            ...first,
            id: 'p-legacy',
            beats: undefined,
            must_happen: 'The index answers in a voice that is not hers.\nShe stops trusting the record.',
            must_change: 'She stops trusting the record.',
            dialogue: undefined,
        };
        const screen = viewOf(legacy);

        expect([...screen.getByTestId('plot-card-p-legacy-beats').querySelectorAll('li')].map((item) => item.textContent)).toEqual([
            'The index answers in a voice that is not hers.',
            'She stops trusting the record.',
        ]);
        // The old fields themselves never show up as rows: the recovery is compatibility,
        // not a second contract.
        expect(screen.getByTestId('plot-card-p-legacy-contract').textContent).not.toContain('Must happen');
        expect(screen.getByTestId('plot-card-p-legacy-contract').textContent).not.toContain('Must change');
        // `must_change` is NOT added as a third beat: the old "what is different at the end"
        // sentence is the LAST beat's job now, and repeating it would invent a beat.
        expect(screen.getByTestId('plot-card-p-legacy-beats').querySelectorAll('li')).toHaveLength(2);
    });

    test('recovers beats from semicolon-separated legacy prose, without the separator', () => {
        const [first] = fixturePlotlines();
        // The other shape an old row really has: one paragraph, `;` between events. The
        // separator is punctuation, not prose, so each beat ends where the old sentence did and
        // nothing is padded on to make the row look newer than it is.
        const legacy: Plotline = {
            ...first,
            id: 'p-semi',
            beats: undefined,
            must_happen: 'The index answers in a voice that is not hers; She stops trusting the record.',
            dialogue: undefined,
        };
        const screen = viewOf(legacy);

        expect([...screen.getByTestId('plot-card-p-semi-beats').querySelectorAll('li')].map((item) => item.textContent)).toEqual([
            'The index answers in a voice that is not hers',
            'She stops trusting the record.',
        ]);
    });

    test('states an empty contract in the caller\'s words instead of an empty list', () => {
        const [first] = fixturePlotlines();
        // No beats, and no legacy prose to recover either: this is the "no contract" state
        // C-1/C-3 fail on, and it has to read as missing rather than as an empty section.
        const screen = viewOf({ ...first, id: 'p-none', beats: [], must_happen: '', dialogue: [] });

        expect(screen.queryByTestId('plot-card-p-none-beats')).toBeNull();
        expect(screen.getByTestId('plot-card-p-none-beats-none').textContent).toBe(
            'No beats recorded on this contract — C-3 has no last beat to read (P4).',
        );
        expect(screen.getByTestId('plot-card-p-none-beats-none').className).toBe('sv-contract-none');
        expect(screen.queryByTestId('plot-card-p-none-dialogue')).toBeNull();
    });

    test('is read-only: the view offers no input, no button, and no editable field', () => {
        const [, second] = fixturePlotlines();
        const screen = viewOf(second);

        // Both readers show the contract next to prose or next to findings; only the
        // Plotlines card's editor may change it, and that editor lives in PhraseEntries.
        expect(screen.container.querySelector('input')).toBeNull();
        expect(screen.container.querySelector('textarea')).toBeNull();
        expect(screen.container.querySelectorAll('button')).toHaveLength(0);
        expect(screen.container.querySelectorAll('select')).toHaveLength(0);
    });

    test('applies the caller\'s class names to the container and to each section', () => {
        const [, second] = fixturePlotlines();
        // The compare view passes its own density classes (see `PlotlineChapters.tsx:141`);
        // one component, two panes, and the tokens have to come from the pane.
        const screen = render(
            <PlotlineContract
                plotline={second}
                contractClassName="sv-plotline-fields"
                fieldClassName="sv-plotline-field"
                testId={`sv-chapter-c2`}
                emptyLine="This chapter's contract lists no beats, so C-7 has nothing to check the prose against (P4)."
            />,
        );

        const contract = screen.getByTestId('sv-chapter-c2-contract');
        expect(contract.className).toBe('sv-plotline-fields');
        const rows = [...contract.querySelectorAll('div')];
        expect(rows).toHaveLength(2);
        expect(rows.map((row) => row.className)).toEqual(['sv-plotline-field', 'sv-plotline-field']);
    });
});
