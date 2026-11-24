// R2 / U3 — the word diff the group pane renders for the latest revision against its predecessor.
//
// Two claims are pinned here, because they are what the pane's copy promises:
//   1. the two streams reconstruct exactly — `same + removed` is the previous text, `same + added` is the
//      current one — so nothing is silently dropped or duplicated by the diff;
//   2. a changed run groups ITS removed words into one struck block and ITS added words into one green block,
//      while unchanged words stay plain. The whole sentence is never painted as changed.
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import { RevisionDiff, diffRevisions } from './RevisionDiff';
import type { DiffSegment } from './RevisionDiff';

const same = (text: string): DiffSegment => ({ kind: 'same', text });
const removed = (text: string): DiffSegment => ({ kind: 'removed', text });
const added = (text: string): DiffSegment => ({ kind: 'added', text });

describe('diffRevisions — exact words, grouped into change runs (R2, U3)', () => {
    it('marks a replaced word removed and added, and keeps the surrounding prose unchanged', () => {
        expect(diffRevisions('The sea forgets the promise.', 'The sea keeps the promise.')).toEqual([
            same('The sea '),
            removed('forgets '),
            added('keeps '),
            same('the promise.')
        ]);
    });

    it('groups a run of deleted words into ONE struck block instead of one block per word', () => {
        expect(diffRevisions('The bird is very tired and cold.', 'The bird is cold.')).toEqual([
            same('The bird is '),
            removed('very tired and '),
            same('cold.')
        ]);
    });

    it('groups each change run separately, so the unchanged words between runs stay plain', () => {
        expect(
            diffRevisions('The bird is very tired and cold.', 'The bird is rested and warm.')
        ).toEqual([
            same('The bird is '),
            removed('very tired '),
            added('rested '),
            same('and '),
            removed('cold.'),
            added('warm.')
        ]);
    });

    it('does not paint the whole changed sentence: only the words that moved are marked', () => {
        // The reported defect in its other direction: a sentence-level diff struck every word in the
        // sentence, so the Author could no longer tell `The bird reaches a nest` was untouched.
        const previous = 'The bird reaches a nest, but it is before nightfall.';
        const current = 'The bird reaches a nest, but before nightfall.';

        expect(diffRevisions(previous, current)).toEqual([
            same('The bird reaches a nest, but '),
            removed('it is '),
            same('before nightfall.')
        ]);
    });

    it('answers one unchanged run for identical texts, and nothing for two empty ones', () => {
        expect(diffRevisions('The same words.', 'The same words.')).toEqual([same('The same words.')]);
        expect(diffRevisions('', '')).toEqual([]);
    });

    it('reconstructs both sides exactly, so the diff cannot hide text', () => {
        const previous = 'One keeper, one light, and a ledger nobody reads.\n\nThe sea believes her.';
        const current = 'One keeper, a brighter light, and a ledger the whole town reads.\n\nThe sea still believes her.';
        const segments = diffRevisions(previous, current);
        const before = segments.filter((segment) => segment.kind !== 'added').map((segment) => segment.text).join('');
        const after = segments.filter((segment) => segment.kind !== 'removed').map((segment) => segment.text).join('');

        expect(before).toBe(previous);
        expect(after).toBe(current);
    });
});

describe('RevisionDiff — deletions struck red, additions green (R2, U3)', () => {
    it('renders each change run as one del and/or one ins, between plain unchanged words', () => {
        const previous = 'The bird is very tired and cold.';
        const current = 'The bird is rested and warm.';
        const { container } = render(
            <p>
                <RevisionDiff previous={previous} current={current} />
            </p>
        );

        const removedNodes = Array.from(container.querySelectorAll('del'));
        const addedNodes = Array.from(container.querySelectorAll('ins'));

        expect(removedNodes.map((node) => node.textContent)).toEqual(['very tired ', 'cold.']);
        expect(addedNodes.map((node) => node.textContent)).toEqual(['rested ', 'warm.']);
        // The unchanged words sit between the runs as plain text, not inside either colour.
        expect(container.textContent).toBe(
            'The bird is very tired rested and cold. warm.'
        );
        expect(container.querySelector('del')?.nextElementSibling).toBe(container.querySelector('ins'));
    });
});
