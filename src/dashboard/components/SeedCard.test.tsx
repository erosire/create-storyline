// U-4 / C-14 / D-3b — the Seed card: the one thing the book is measured against, pinned and
// read-only, with the Author-declared chapter count beside it.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { SeedCard } from './SeedCard';
import { SEED_IDEA, fixtureSummary } from './story-fixtures';

describe('SeedCard — the measure of the book (U-4, C-14, D-3b)', () => {
    it('shows the Author\u2019s own Seed verbatim and states that no agent may write it', () => {
        render(<SeedCard idea={SEED_IDEA} title="Neon Cathedral" summary={fixtureSummary()} />);

        expect(screen.getByRole('heading', { name: 'Seed — Neon Cathedral' })).toBeTruthy();
        // The Seed is prose, not a field: the text is rendered exactly as the Author wrote it.
        expect(screen.getByText(SEED_IDEA)).toBeTruthy();
        expect(screen.getByText('Author-written · read-only for every agent, every phase, forever (P5)')).toBeTruthy();
    });

    it('states the chapter count as the C-0 measure, and says so when the Summary does not exist yet', () => {
        const measure = (ui: ReactElement) =>
            (render(ui).container.querySelector('.sv-seed-measure') as HTMLElement).textContent;

        // The sentence is one statement of Author truth, so it is asserted whole — not as a fragment.
        expect(measure(<SeedCard idea={SEED_IDEA} title="Neon Cathedral" summary={fixtureSummary()} />)).toBe(
            "The book's measure: 7 chapters — C-0 fails on any other count (D-3b)"
        );

        // No Summary record yet — the card must say the count is unknown, never imply zero chapters.
        expect(measure(<SeedCard idea={SEED_IDEA} title="Neon Cathedral" summary={null} />)).toBe(
            "The book's measure: no chapters — C-0 fails on any other count (D-3b) · the Summary record has not been written yet"
        );
    });
});
