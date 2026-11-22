// The left rail after the redesign: four phrases, their entries, and the supporting folders.
//
// The rail must say exactly that and nothing else: the old knowledge header's subtitle, note
// count and "one article per folder" sentence are the clutter the redesign removed, and the
// Summary's tick is the only status it paints.
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { StoryOutline } from './StoryOutline';
import { DEFAULT_STORY_SELECTION } from './story-nav';
import type { StorySelection } from './story-nav';
import { fixtureStory, fixtureSummary, fixtureView } from './story-fixtures';

describe('StoryOutline — the phrase rail (U-4 / the phrase redesign)', () => {
    it('lists the four phrases and the supporting folders, with no knowledge copy', () => {
        render(<StoryOutline view={fixtureView()} selection={DEFAULT_STORY_SELECTION} onSelect={() => undefined} />);

        expect(screen.getByText('Phrase 1')).toBeTruthy();
        expect(screen.getByText('Phrase 2')).toBeTruthy();
        expect(screen.getByText('Phrase 3')).toBeTruthy();
        expect(screen.getByText('Phrase 4')).toBeTruthy();

        for (const heading of ['Summary', 'Characters', 'Plotlines', 'Chapters']) {
            expect(screen.getAllByText(heading).length).toBeGreaterThan(0);
        }

        for (const folder of ['Continuity', 'Goal', 'Ideas', 'Findings', 'Digest', 'Settings']) {
            expect(screen.getByText(folder)).toBeTruthy();
        }

        // The removed clutter: a harness-memory subtitle, a note count and the per-folder sentence.
        expect(screen.queryByText(/its own harness memory/)).toBeNull();
        expect(screen.queryByText(/notes$/)).toBeNull();
        expect(screen.queryByText(/one article per folder/)).toBeNull();
        expect(screen.queryByText(/written by this story/)).toBeNull();
    });

    it('marks the Summary ready for review with a tick and keeps a signed Summary ticked', () => {
        const signed = render(
            <StoryOutline view={fixtureView()} selection={DEFAULT_STORY_SELECTION} onSelect={() => undefined} />
        );

        expect(signed.container.querySelector('.outline-ready')?.getAttribute('title')).toBe('ready for review');
        signed.unmount();

        const view = fixtureView();
        const ready = {
            ...view,
            story: { ...fixtureStory(), phase: 'summary' as const, summary_locked: false },
            summary: fixtureSummary(),
            goal: { ...view.goal, failing: [] }
        };
        const { container } = render(
            <StoryOutline view={ready} selection={DEFAULT_STORY_SELECTION} onSelect={() => undefined} />
        );
        expect(container.querySelector('.outline-ready')).toBeTruthy();

        const notReady = {
            ...ready,
            summary: {
                ...fixtureSummary(),
                premise: undefined,
                promise: undefined,
                theme: undefined,
                tone: undefined,
                ending: undefined,
                world_rules: undefined
            }
        };
        const second = render(
            <StoryOutline view={notReady} selection={DEFAULT_STORY_SELECTION} onSelect={() => undefined} />
        );
        const ticks = second.container.querySelectorAll('.outline-ready');
        expect(ticks.length).toBe(0);
    });

    it('opens the phrase or the exact entry the Author clicked', () => {
        const selections: StorySelection[] = [];
        const { getByText } = render(
            <StoryOutline
                view={fixtureView()}
                selection={DEFAULT_STORY_SELECTION}
                onSelect={(selection) => selections.push(selection)}
            />
        );

        fireEvent.click(getByText('Overview'));
        fireEvent.click(getByText('Hale'));
        fireEvent.click(getByText('Plotline 2 — Ghost Index'));
        fireEvent.click(getByText('Chapter 3 — The Water Line'));
        fireEvent.click(getByText('Findings'));

        expect(selections).toEqual([
            { panel: 'summary', ref: 'overview' },
            { panel: 'characters', ref: 'cast_member_1' },
            { panel: 'plotlines', ref: 'p2' },
            { panel: 'chapters', ref: 'c3' },
            { panel: 'findings' }
        ]);
    });

    it('keeps an empty Characters phrase clickable and childless', () => {
        const view = { ...fixtureView(), cast: [] };
        const { container } = render(
            <StoryOutline view={view} selection={DEFAULT_STORY_SELECTION} onSelect={() => undefined} />
        );

        const phrase = Array.from(container.querySelectorAll<HTMLElement>('.outline-phase')).find((element) =>
            element.textContent?.includes('Characters')
        )!;
        expect(phrase.querySelectorAll('.outline-child').length).toBe(0);
        expect(phrase.querySelector<HTMLButtonElement>('.outline-item--phrase')?.disabled).toBe(false);
        expect(phrase.querySelector('.outline-start')).toBeTruthy();
    });
});
