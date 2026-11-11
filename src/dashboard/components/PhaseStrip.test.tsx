// U-12a — the phase strip: ① Summary ② Plotlines ③ Chapters, each signed with a lock.
// The Author must read where a Story stands from across the room, so the current phase is marked
// with `aria-current` AND text, and a signed phase states that only a backtrack opens it (L-31).
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PhaseStrip } from './PhaseStrip';
import { fixtureStory } from './story-fixtures';

function story() {
    return fixtureStory();
}

describe('PhaseStrip — where the Story stands (U-12a)', () => {
    it('renders the three phases in order with the current one marked and the signed ones locked', () => {
        const { container } = render(
            <PhaseStrip phase={story().phase} locked={{ summary: true, plotlines: true, chapters: false }} />
        );
        const items = container.querySelectorAll('.sv-phase-item');

        // Order is load-bearing: the strip is the pipeline, not a set of tabs.
        expect(Array.from(items).map((item) => item.textContent)).toEqual([
            '① Summary🔒',
            '② Plotlines🔒',
            '③ Chapters'
        ]);

        const current = items[2];
        expect(current.getAttribute('aria-current')).toBe('step');
        expect(current.className).toContain('sv-phase-current');
        // A signed phase is locked in both the class and the accessible name (L-34: never colour alone).
        expect(items[0].className).toContain('sv-phase-locked');
        expect(items[0].getAttribute('title')).toBe('① Summary is signed — the only way in is a backtrack (L-31)');
        expect(items[0].querySelector('.sv-phase-lock')!.getAttribute('aria-label')).toBe('① Summary locked');
        // The unsigned phase says nothing about locks, and has no icon.
        expect(items[2].querySelector('.sv-phase-lock')).toBeNull();
        expect(items[2].getAttribute('title')).toBe('③ Chapters');
    });

    it('jumps between panes when the caller can jump, and is a pure readout when it cannot', () => {
        const locked = { summary: true, plotlines: true, chapters: false };
        const jumps: string[] = [];
        const { rerender, container } = render(
            <PhaseStrip phase="chapters" locked={locked} onSelect={(phase) => jumps.push(phase)} />
        );

        fireEvent.click(container.querySelectorAll('.sv-phase-item')[0]);
        fireEvent.click(container.querySelectorAll('.sv-phase-item')[1]);
        expect(jumps).toEqual(['summary', 'plotlines']);

        // Without a handler the strip must not look clickable (U-16: a control states its state).
        rerender(<PhaseStrip phase="chapters" locked={locked} />);
        expect(
            Array.from(container.querySelectorAll('.sv-phase-item')).map((item) => (item as HTMLButtonElement).disabled)
        ).toEqual([true, true, true]);
    });
});
