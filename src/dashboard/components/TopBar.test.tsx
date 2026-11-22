// U-3 (the cord is always reachable) + U-11 (progress reads as story, never as an idle spinner) +
// L-34's split of the waits. The header is ONE WORD ("Idle" / "Working" / "Awaiting you" /
// "Stuck"); the click opens the dialog with the to-do list and the kill switch.
import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { TopBar } from './TopBar';
import { click, renderShell, storyRow } from '../testing/shell-fakes';

function rows() {
    return [
        storyRow('story_1', { title: 'Hollow Sea', status: 'pending', pending_kind: 'phase_signoff' }),
        storyRow('story_2', {
            title: 'Salt Cartography',
            status: 'pending',
            pending_kind: 'stalled',
            active_runs: 1,
            status_reason: 'C-4 has failed on chapters 6–9 for 11 rounds'
        }),
        storyRow('story_3', {
            title: 'Second Death',
            status: 'ready',
            active_runs: 2,
            progress: 'chapters 4–7 drafted · hole in act 2'
        }),
        storyRow('story_4', { title: 'Quiet Orchard', status: 'pending', pending_kind: 'drained' }),
        storyRow('story_5', { title: 'Ash Lantern', status: 'completed' })
    ];
}

describe('TopBar — one word, and the dialog behind it (U-3 / U-11)', () => {
    it('reads the sweep as ONE word: a stall outranks a wait, a wait outranks activity (U-11 / L-34)', async () => {
        const { container } = await renderShell(<TopBar />, rows());

        const status = screen.getByTestId('crew-status');
        expect(status.tagName).toBe('BUTTON');
        expect(status.textContent).toBe('Stuck');
        expect(status.getAttribute('data-state')).toBe('stuck');
        // Nothing else competes for the eye: no counters, no health prose, no visible cord.
        expect(screen.queryByTestId('crew-counts')).toBeNull();
        expect(screen.queryByTestId('health-line')).toBeNull();
        expect(screen.queryByTestId('global-stop')).toBeNull();
        expect(container.querySelectorAll("[class*='spinner'], [role='progressbar'], [role='status']")).toHaveLength(0);
    });

    it('says Awaiting you, Working or Idle when nothing is stuck', async () => {
        const awaiting = await renderShell(<TopBar />, [
            storyRow('story_1', { status: 'pending', pending_kind: 'phase_signoff' }),
            storyRow('story_2', { status: 'ready', active_runs: 1 })
        ]);
        expect(screen.getByTestId('crew-status').textContent).toBe('Awaiting you');
        awaiting.unmount();

        const working = await renderShell(<TopBar />, [storyRow('story_1', { status: 'ready', active_runs: 1 })]);
        expect(screen.getByTestId('crew-status').textContent).toBe('Working');
        working.unmount();

        await renderShell(<TopBar />, []);
        expect(screen.getByTestId('crew-status').textContent).toBe('Idle');
    });

    it('opens the dialog with the to-do list, the counts and the health prose (U-11)', async () => {
        await renderShell(<TopBar />, rows());

        await click(screen.getByTestId('crew-status'));

        const dialog = screen.getByRole('dialog');
        expect(dialog.getAttribute('aria-modal')).toBe('true');

        // L-22's specific stuck thing beats the activity line: the Author reads it once.
        const health = within(dialog).getByTestId('health-line');
        expect(health.textContent).toContain('C-4 has failed on chapters 6–9 for 11 rounds');
        expect(health.textContent).not.toMatch(/loop running|working…|loading/i);

        // 2 by-design waits (sign-off, drained) · 1 stuck · 1 working · 1 done.
        expect(within(dialog).getByTestId('crew-counts').textContent).toBe(
            '2 awaiting you1 stuck1 working1 done'
        );

        // Every Story that needs the Author is named, stuck first.
        const todos = Array.from(dialog.querySelectorAll('[data-testid^="crew-todo-"]')).map((node) =>
            node.getAttribute('data-testid')
        );
        expect(todos).toEqual(['crew-todo-story_2', 'crew-todo-story_1', 'crew-todo-story_4', 'crew-todo-story_3']);
        expect(within(dialog).getByTestId('crew-todo-story_2').textContent).toContain(
            'C-4 has failed on chapters 6–9 for 11 rounds'
        );
    });

    it('puts the cord in the dialog and pulls it on every Story that could still be moving (U-3 / P8)', async () => {
        const { client, container } = await renderShell(<TopBar />, rows());

        await click(screen.getByTestId('crew-status'));
        const dialog = screen.getByRole('dialog');
        const stop = within(dialog).getByTestId('global-stop');

        expect(stop.tagName).toBe('BUTTON');
        expect(stop.textContent).toBe('Stop everything');
        // The size contract: exactly one control carries a size, and the stylesheet makes `xl`
        // ~2x the height of the rest — the cord is the biggest control in the shell (U-3).
        expect(stop.getAttribute('data-size')).toBe('xl');
        expect(container.querySelectorAll('[data-size]')).toHaveLength(1);
        expect(stop.className).toBe('stop-all');

        await click(stop);
        // `ready` and the Story with a live run get stopped; `completed` and an already
        // stopped Story are skipped, because P8's cord has nothing to halt there.
        expect(client.stop).toHaveBeenCalledTimes(2);
        expect((client.stop as unknown as { mock: { calls: string[][] } }).mock.calls.map((call) => call[0])).toEqual([
            'story_2',
            'story_3'
        ]);
        // Pulling the cord closes the panel it was pulled from.
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('makes each to-do row the way to do it: the click opens that Story', async () => {
        const { client } = await renderShell(<TopBar />, rows());

        await click(screen.getByTestId('crew-status'));
        await click(screen.getByTestId('crew-todo-story_1'));

        expect(client.getStory).toHaveBeenCalledWith('story_1');
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('closes the dialog without acting when the Author dismisses it', async () => {
        await renderShell(<TopBar />, rows());

        await click(screen.getByTestId('crew-status'));
        await click(screen.getByTestId('crew-dialog-close'));

        expect(screen.queryByRole('dialog')).toBeNull();
        expect(screen.getByTestId('crew-status').getAttribute('aria-expanded')).toBe('false');
    });
});
