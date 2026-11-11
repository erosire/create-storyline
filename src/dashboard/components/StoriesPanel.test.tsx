// W9 acceptance — "three Stories in three phases and three statuses; the one awaiting the
// Author is on top, and it is visibly a different kind of wait from the stalled one", plus
// the W13 additions U-1b (two colours), U-1c (drained reads finished), U-12a (phase strip)
// and U-2/U-3 (crew line, Stop).
import { describe, expect, it } from 'vitest';
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

describe('StoriesPanel — the STORIES region (U-1 / U-1b / U-1c / U-12a)', () => {
    it('puts the Story awaiting the Author on top, then the stall, then ready, then done (U-1)', async () => {
        await renderShell(<StoriesPanel />, fixture());
        // Exact order, not "is first": awaiting (sign-off · drained) → stalled → ready → completed.
        expect(rowIds()).toEqual(['story_1', 'story_4', 'story_2', 'story_3', 'story_5']);
    });

    it('renders every row with its status badge, level strings, and trend arrow (U-1 / L-14)', async () => {
        await renderShell(<StoriesPanel />, fixture());

        const badge = rowFor('story_2').querySelector('.badge') as HTMLElement;
        expect(badge.textContent).toBe('pending');

        // The engine's rendered strings pass through untouched — the client never recomputes.
        const levels = rowFor('story_2').querySelectorAll('[data-level]');
        expect(Array.from(levels).map((node) => (node as HTMLElement).dataset.level)).toEqual([
            'summary',
            'plotlines',
            'chapters',
            'whole'
        ]);
        expect(rowFor('story_2').querySelector('[data-level="plotlines"] .level__value')?.textContent).toBe('5/7');
        expect(rowFor('story_2').querySelector('[data-level="chapters"] .level__value')?.textContent).toBe('n/a');

        // L-15's arrow, from the enum rather than a re-derived number.
        expect(rowFor('story_2').querySelector('[data-trend]')?.textContent).toBe('→');
        expect(rowFor('story_3').querySelector('[data-trend]')?.getAttribute('data-trend')).toBe('improving');
        expect(rowFor('story_3').querySelector('[data-trend]')?.textContent).toBe('↑');
    });

    it('marks the signed phases on the strip with lock icons and the current phase (U-12a)', async () => {
        await renderShell(<StoriesPanel />, fixture());

        const strip = within(rowFor('story_3')).getByTestId('phase-strip');
        const marks = Array.from(strip.querySelectorAll('[data-phase]')) as HTMLElement[];
        expect(marks.map((mark) => mark.dataset.phase)).toEqual(['summary', 'plotlines', 'chapters']);
        expect(marks.map((mark) => mark.dataset.locked)).toEqual(['true', 'true', 'false']);
        expect(marks.map((mark) => mark.dataset.state)).toEqual(['signed', 'signed', 'current']);
        // The lock glyph is only on signed phases (U-12a: "a lock icon on each phase it has signed").
        expect(strip.querySelectorAll('.phase-mark__lock')).toHaveLength(2);
        expect(marks[2]?.textContent).toBe('③');
    });

    it('makes an awaiting Story and a stalled Story two different kinds of wait (U-1b / L-34)', async () => {
        await renderShell(<StoriesPanel />, fixture());

        // The tone is the whole mechanism, and it is on the row AND the badge so the
        // stylesheet paints both (L-34: distinguishable at a glance).
        expect(rowFor('story_1').dataset.tone).toBe('awaiting');
        expect(rowFor('story_2').dataset.tone).toBe('stalled');
        expect(rowFor('story_1').querySelector('.badge')?.getAttribute('data-tone')).toBe('awaiting');
        expect(rowFor('story_2').querySelector('.badge')?.getAttribute('data-tone')).toBe('stalled');

        // U-1b's sign-off wait is the state the product aims at; the stall prints L-22's
        // named reason rather than "consistency low".
        expect(rowFor('story_1').querySelector('.story-row__wait-label')?.textContent).toBe('awaiting your signature');
        expect(rowFor('story_2').querySelector('.story-row__wait-label')?.textContent).toBe('stuck');
        expect(rowFor('story_2').querySelector('.story-row__wait-detail')?.textContent).toContain(
            'C-4 has failed on chapters 6–9 for 11 rounds'
        );
    });

    it('reads a drained Story as finished: what the crew stopped finding, and exactly two moves (U-1c / L-37)', async () => {
        await renderShell(<StoriesPanel />, fixture());

        const row = rowFor('story_4');
        // The leftovers sentence, verbatim from the server's projection.
        expect(row.querySelector('.story-row__wait-detail')?.textContent).toBe(
            'no critical or major left · 12 minor and 4 taste awaiting you'
        );

        // U-1c: the two moves L-37 allows, and nothing else competing with them.
        const moves = within(row.querySelector<HTMLElement>('[data-slot="moves"]') as HTMLElement)
            .getAllByRole('button')
            .map((button) => button.textContent);
        expect(moves).toEqual(['Work the leftovers', 'Complete']);
        expect(row.querySelectorAll('[data-slot="controls"] button')).toHaveLength(0);

        // The word "drained" is an internal name and must never reach the screen.
        expect(row.textContent).not.toMatch(/drained/i);
    });

    it('offers the sign-off as the one click that clears it (U-1b)', async () => {
        const { client } = await renderShell(<StoriesPanel />, fixture());
        const lock = within(rowFor('story_1')).getByRole('button', { name: 'Lock phase ①' });
        await click(lock);
        expect(client.lockPhase).toHaveBeenCalledTimes(1);
        expect(client.lockPhase).toHaveBeenCalledWith('story_1');
    });

    it('sends "work the leftovers" to that Story\'s queue and "complete" to the acceptance (L-37 / L-26)', async () => {
        const { client, store } = await renderShell(<StoriesPanel />, fixture());

        await click(within(rowFor('story_4')).getByRole('button', { name: 'Work the leftovers' }));
        // The Author stays in the panel and lands on this Story's leftovers: the queue is
        // filtered to it, and its row has been opened so the Story view is one click away.
        expect(store.getSnapshot().queueStoryFilter).toBe('story_4');
        expect(client.getStory).toHaveBeenCalledWith('story_4');

        await click(within(rowFor('story_4')).getByRole('button', { name: 'Complete' }));
        expect(client.acceptCompletion).toHaveBeenCalledWith('story_4');
    });

    it('shows what the crews are doing to a running Story, and Stop pulls the cord on it (U-2 / U-3 / U-11 / P8)', async () => {
        const { client } = await renderShell(<StoriesPanel />, fixture());

        const crew = rowFor('story_3').querySelector('.story-row__crew') as HTMLElement;
        expect(crew.textContent).toContain('3 crews on it');
        // U-11: the line is story text ("hole in act 2"), not an activity ticker.
        expect(crew.textContent).toContain('chapters 4–7 drafted · hole in act 2');

        await click(within(rowFor('story_3')).getByRole('button', { name: 'Stop' }));
        expect(client.stop).toHaveBeenCalledTimes(1);
        expect(client.stop).toHaveBeenCalledWith('story_3');
    });

    it('selecting a row opens the Story (U-4)', async () => {
        const { store } = await renderShell(<StoriesPanel />, fixture());
        const open = within(rowFor('story_2')).getByRole('button', { name: /Salt Cartography/ });
        expect(open).toBeTruthy();
        await click(open);
        expect(store.getSnapshot().activeStoryId).toBe('story_2');
        expect(rowFor('story_2').dataset.active).toBe('true');
    });
});
