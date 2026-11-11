// U-3 (the biggest button) + U-11 (progress reads as story, never as an idle spinner) +
// L-34's split of the waits on the top strip.
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
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

describe('TopBar — the cord and the health line (U-3 / U-11)', () => {
    it('makes the global Stop the biggest control and pulls the cord on every Story that could still be moving (U-3 / P8)', async () => {
        const { client, container } = await renderShell(<TopBar />, rows());

        const stop = screen.getByTestId('global-stop');
        expect(stop.tagName).toBe('BUTTON');
        expect(stop.textContent).toBe('Stop everything');
        // The size contract: exactly one control in the shell carries a size, and every other
        // button is on the small `.button` scale. The stylesheet makes `xl` ~2x the height of
        // the rest, which is what makes it the biggest button on the screen (U-3).
        expect(stop.getAttribute('data-size')).toBe('xl');
        expect(container.querySelectorAll('[data-size]')).toHaveLength(1);
        expect(stop.className).toBe('stop-all');
        const smallButtons = Array.from(container.querySelectorAll('button')).filter((node) => node !== stop);
        expect(smallButtons.every((node) => node.className.includes('button'))).toBe(true);

        await click(stop);
        // `ready` and the Story with a live run get stopped; `completed` and an already
        // stopped Story are skipped, because P8's cord has nothing to halt there.
        expect(client.stop).toHaveBeenCalledTimes(2);
        expect((client.stop as unknown as { mock: { calls: string[][] } }).mock.calls.map((call) => call[0])).toEqual([
            'story_2',
            'story_3'
        ]);
    });

    it('reads the sweep as story text with no idle spinner, and a stall outranks activity (U-11)', async () => {
        const { container } = await renderShell(<TopBar />, rows());

        expect(container.querySelectorAll("[class*='spinner'], [role='progressbar'], [role='status']")).toHaveLength(0);

        const health = screen.getByTestId('health-line');
        // L-22's specific stuck thing beats the activity line: the Author reads the strip once.
        expect(health.textContent).toContain('C-4 has failed on chapters 6–9 for 11 rounds');
        expect(health.textContent).not.toMatch(/loop running|working…|loading/i);
    });

    it('counts the waits and the work separately, the way L-34 splits them (U-1b)', async () => {
        await renderShell(<TopBar />, rows());
        // 2 by-design waits (sign-off, drained) · 1 stuck · 1 working · 1 done. The stalled
        // Story is counted as stuck rather than working even though a run is still on it:
        // the wait is what the Author has to act on.
        expect(document.querySelector<HTMLElement>('.topbar__counts')?.textContent).toBe(
            '2 awaiting you1 stuck1 working1 done'
        );
    });
});
