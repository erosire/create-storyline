// W9 acceptance — "three Stories in three phases and three statuses; the one awaiting the
// Author is on top, and it is visibly a different kind of wait from the stalled one".
//
// THE ROW IS NOW ONE DECISION: it names the Story and says whether it needs the Author. Levels,
// the phase strip, the trend and the full status_reason live on the Story's own panes, whose rail
// highlights the artifact (`StoryOutline`). These tests pin that compact contract and the
// stop/resume/delete controls being available on the open row.
import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { StoriesPanel } from './StoriesPanel';
import { click, renderShell, storyRow } from '../testing/shell-fakes';

/** The five rows W9 names, deliberately handed to the panel in an unsorted order. */
function fixture() {
    const signoff = storyRow('story_1', {
        title: 'Hollow Sea',
        phase: 'summary',
        status: 'pending',
        pending_kind: 'phase_signoff',
        trend: 'improving',
        levels: { summary: '2/2', plotlines: 'n/a', chapters: 'n/a', whole: '2/2' },
        status_reason: 'phase ① passed its bar · the Ideas tray is empty'
    });
    const stalled = storyRow('story_2', {
        title: 'Salt Cartography',
        phase: 'plotlines',
        status: 'pending',
        pending_kind: 'stalled',
        summary_locked: true,
        trend: 'flat',
        levels: { summary: '2/2', plotlines: '5/7', chapters: 'n/a', whole: '7/9' },
        status_reason: 'C-4 has failed on chapters 6–9 for 11 rounds · the crews keep moving the mentor scene'
    });
    const working = storyRow('story_3', {
        title: 'Second Death',
        phase: 'chapters',
        status: 'ready',
        summary_locked: true,
        plotlines_locked: true,
        active_runs: 3,
        progress: 'chapters 4–7 drafted · hole in act 2',
        trend: 'improving',
        levels: { summary: '2/2', plotlines: '6/6', chapters: '7/9', whole: '9/12' }
    });
    const drained = storyRow('story_4', {
        title: 'Quiet Orchard',
        phase: 'chapters',
        status: 'pending',
        pending_kind: 'drained',
        summary_locked: true,
        plotlines_locked: true,
        trend: 'flat',
        levels: { summary: '2/2', plotlines: '6/6', chapters: '9/9', whole: '9/9' },
        status_reason: 'no critical or major left · 12 minor and 4 taste awaiting you'
    });
    const closed = storyRow('story_5', {
        title: 'Ash Lantern',
        phase: 'chapters',
        status: 'completed',
        summary_locked: true,
        plotlines_locked: true,
        trend: 'flat',
        levels: { summary: '2/2', plotlines: '6/6', chapters: '9/9', whole: '9/9' }
    });
    return [stalled, working, signoff, closed, drained];
}

const rowIds = () =>
    Array.from(document.querySelectorAll('li.story-row')).map((node) => (node as HTMLElement).dataset.story);
const rowFor = (id: string) => document.querySelector<HTMLElement>(`li.story-row[data-story="${id}"]`) as HTMLElement;

describe('StoriesPanel — the STORIES region (U-1 / U-1b / U-1c)', () => {
    it('loads the panel in chunks and appends the next one (U-1)', async () => {
        const first = Array.from({ length: 50 }, (_, index) => storyRow(`story_${index}`));
        const second = [storyRow('story_50')];
        const listStories = vi.fn(async (options?: { offset?: number }) =>
            options?.offset === 50 ? second : first
        );

        await renderShell(<StoriesPanel />, [], [], { listStories });

        expect(rowIds().length).toBe(50);
        expect(listStories).toHaveBeenCalledWith({ limit: 50, offset: 0 });

        await click(screen.getByTestId('stories-load-more'));

        expect(rowIds().length).toBe(51);
        expect(listStories).toHaveBeenLastCalledWith({ limit: 50, offset: 50 });
        expect(screen.queryByTestId('stories-load-more')).toBeNull();
    });

    it('puts the Story awaiting the Author on top, then the stall, then ready, then done (U-1)', async () => {
        await renderShell(<StoriesPanel />, fixture());
        expect(rowIds()).toEqual(['story_1', 'story_4', 'story_2', 'story_3', 'story_5']);
    });

    it('names the Story and one attention mark; the detail lives inside the Story', async () => {
        await renderShell(<StoriesPanel />, fixture());

        expect(rowFor('story_1').querySelector('.story-row__title')?.textContent).toBe('Hollow Sea');
        expect(rowFor('story_1').querySelector('.story-row__attention')?.textContent).toBe('needs your signature');
        expect(rowFor('story_2').querySelector('.story-row__attention')?.textContent).toBe('stuck');
        expect(rowFor('story_4').querySelector('.story-row__attention')?.textContent).toBe('leftovers need you');
        expect(rowFor('story_3').querySelector('.badge')?.textContent).toBe('ready');

        // The levels/trend/phase strip are no longer on the navigation row.
        expect(rowFor('story_2').querySelector('[data-level]')).toBeNull();
        expect(rowFor('story_2').querySelector('[data-trend]')).toBeNull();
        expect(rowFor('story_2').querySelector('.phase-strip')).toBeNull();
        expect(rowFor('story_2').textContent).not.toContain('C-4 has failed');
    });

    it('keeps awaiting, stalled and drained visibly different (U-1b / U-1c / L-34)', async () => {
        await renderShell(<StoriesPanel />, fixture());

        expect(rowFor('story_1').dataset.tone).toBe('awaiting');
        expect(rowFor('story_2').dataset.tone).toBe('stalled');
        expect(rowFor('story_4').dataset.tone).toBe('awaiting');
        expect(rowFor('story_4').getAttribute('data-pending-kind')).toBe('drained');

        expect(rowFor('story_1').querySelector('.story-row__attention')?.getAttribute('data-tone')).toBe('awaiting');
        expect(rowFor('story_2').querySelector('.story-row__attention')?.getAttribute('data-tone')).toBe('stalled');
        expect(rowFor('story_4').querySelector('.story-row__attention')?.getAttribute('data-tone')).toBe('finished');

        // The word "drained" is an internal name and must never reach the screen.
        expect(rowFor('story_4').textContent).not.toMatch(/drained/i);
    });

    it('shows the open Story’s controls only on the open row, and Stop pulls its cord (U-3 / P8)', async () => {
        const { client } = await renderShell(<StoriesPanel />, fixture());

        expect(rowFor('story_3').querySelector('[data-slot="controls"]')).toBeNull();

        const open = within(rowFor('story_3')).getByRole('button', { name: /Second Death/ });
        await click(open);

        const controls = rowFor('story_3').querySelector('[data-slot="controls"]') as HTMLElement;
        await click(within(controls).getByRole('button', { name: 'Stop' }));
        expect(client.stop).toHaveBeenCalledWith('story_3');
    });

    it('deletes a Story and everything it owns only after the confirming click (P1)', async () => {
        const { client } = await renderShell(<StoriesPanel />, fixture());
        const open = within(rowFor('story_5')).getByRole('button', { name: /Ash Lantern/ });
        await click(open);

        const row = rowFor('story_5');
        await click(within(row).getByRole('button', { name: 'Delete' }));
        expect(client.deleteStory).not.toHaveBeenCalled();
        expect(within(row).getByText(/Delete "Ash Lantern" and everything it owns/)).toBeTruthy();

        await click(within(row).getByRole('button', { name: 'Confirm' }));
        expect(client.deleteStory).toHaveBeenCalledWith('story_5');
    });

    it('selecting a row opens the Story (U-4)', async () => {
        const { store } = await renderShell(<StoriesPanel />, fixture());
        const open = within(rowFor('story_2')).getByRole('button', { name: /Salt Cartography/ });
        await click(open);
        expect(store.getSnapshot().activeStoryId).toBe('story_2');
        expect(rowFor('story_2').dataset.active).toBe('true');
    });

    it('clicking the open Story again closes it and returns to the desk (U-4 / U-10)', async () => {
        const { store } = await renderShell(<StoriesPanel />, fixture());
        const open = within(rowFor('story_2')).getByRole('button', { name: /Salt Cartography/ });

        await click(open);
        expect(store.getSnapshot().activeStoryId).toBe('story_2');

        await click(open);
        expect(store.getSnapshot().activeStoryId).toBeNull();
        expect(rowFor('story_2').dataset.active).toBe('false');
    });
});
