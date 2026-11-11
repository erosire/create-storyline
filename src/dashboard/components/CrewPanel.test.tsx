// U-7 / D-18 / S-3 / S-6 / S-7 / U-8d — the crew panel.
//
// The right region is the CREW: the Author controls the harnesses, so a row exists from spawn to
// teardown (D-18) and carries what it is doing, what it costs in wall-clock (S-6, informational
// only per E-0), whether its internal panel disagreed (D-38), and the cord for that one run (U-7).
// A delegated sub-context is nested and gets no row and no kill button of its own (S-7).
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { CrewPanel } from './CrewPanel';
import { click } from '../testing/shell-fakes';
import { NOW, fixtureActions, fixtureRuns, fixtureTemplates } from './story-fixtures';

function renderCrew(runs = fixtureRuns(), handlers: Partial<Parameters<typeof CrewPanel>[0]> = {}) {
    return render(<CrewPanel runs={runs} templates={fixtureTemplates()} now={NOW} {...handlers} />);
}

/** The live rows (the closed ones are inside a collapsed details, and read differently). */
function liveRows(): HTMLElement[] {
    const list = document.querySelector('.sv-runs') as HTMLElement;
    return Array.from(list.querySelectorAll<HTMLElement>(':scope > .sv-run'));
}

describe('CrewPanel — the harnesses and what they are doing (U-7, D-18, S-3, S-6, S-7, U-8d)', () => {
    it('lists the live run with its kind, work item, elapsed time, and token count', () => {
        renderCrew();

        expect(screen.getByText('Crew — live runs for this story (U-7)')).toBeTruthy();
        expect(screen.getByText('1 running')).toBeTruthy();

        const [row] = liveRows();
        expect(liveRows().length).toBe(1);
        // U-8a: the crew that writes reads different from the crew that judges.
        expect((row.querySelector('.sv-run-kind') as HTMLElement).textContent).toBe('writer');
        expect(row.className).toContain('sv-run-writer');
        expect(within(row).getByText('Chapter crew')).toBeTruthy();
        expect(within(row).getByText('working')).toBeTruthy();
        expect(within(row).getByText('holds w-9')).toBeTruthy();
        expect(
            within(row).getByText('done when: every criterion the plotline names is answerable from the prose')
        ).toBeTruthy();

        // S-6: elapsed is shown, and the tooltip refuses to let it read as a limit (E-0).
        expect((row.querySelector('.sv-run-elapsed') as HTMLElement).textContent).toBe('2m 30s');
        expect(row.querySelector('.sv-run-elapsed')!.getAttribute('title')).toBe(
            'wall-clock, informational only (S-6, E-0)'
        );
        expect(within(row).getByText('1,234 tokens (informational — E-0)')).toBeTruthy();
    });

    it('says what a panel role inside the run is, and marks the answer that was not unanimous (D-38, U-8d)', () => {
        renderCrew();
        const [row] = liveRows();

        expect(
            within(row).getByText(
                'panel of 3 writer agents inside this one run · aggregate: merge · the loop gets one report (D-38)'
            )
        ).toBeTruthy();
        expect(
            within(row).getByText(
                'the run reported disagreement: 1 of 3 preferred the earlier cut — dissent recorded in the selection note.'
            )
        ).toBeTruthy();

        // S-7 / T-2b: the delegated sub-context is nested — no row, no cord of its own.
        const nested = row.querySelector('.sv-delegated') as HTMLElement;
        expect(within(nested).getByText('checker')).toBeTruthy();
        expect(within(nested).getByText('check C-8 against the plotline')).toBeTruthy();
        expect(
            within(nested).getByText('1 of 3 preferred the earlier cut — dissent recorded in the selection note.')
        ).toBeTruthy();
        expect(within(nested).getByText('300 tokens')).toBeTruthy();
        expect(within(nested).getByText('inside this run — not a work item (S-7, T-2b)')).toBeTruthy();
        expect(nested.querySelector('.sv-run-kill')).toBeNull();
    });

    it('gives the live run exactly one cord, and records why a closed run ended (U-7, S-3, D-18)', async () => {
        const { actions, calls } = fixtureActions();
        renderCrew(fixtureRuns(), { onKillRun: (runId) => void actions.killRun?.(runId) });

        const [row] = liveRows();
        await click(within(row).getByRole('button', { name: 'Kill run' }));
        expect(calls.killRun).toEqual([['r-5']]);

        // The torn-down run is collapsed below, and its row says why it ended (S-3).
        const closed = document.querySelector('.sv-crew-closed') as HTMLElement;
        expect(within(closed).getByText('1 runs torn down — each row says why it ended (S-3)')).toBeTruthy();
        const ended = closed.querySelector('.sv-run-ended') as HTMLElement;
        expect(ended.textContent).toBe('ended 2026-11-11T11:34:20.000Z · killed by author stop (D-37)');
        expect(closed.querySelector('.sv-run-kill')).toBeNull();
        // Its elapsed time is measured to `ended_at`, not to now.
        expect((closed.querySelector('.sv-run-elapsed') as HTMLElement).textContent).toBe('4m 20s');
    });

    it('says so plainly when nothing is running, and keeps the cord disabled without the route', () => {
        const { rerender } = renderCrew(fixtureRuns().slice(1));

        expect(screen.getByText('Nothing is running on this story right now.')).toBeTruthy();
        expect(screen.getByText('0 running')).toBeTruthy();

        rerender(<CrewPanel runs={fixtureRuns()} templates={fixtureTemplates()} now={NOW} />);
        const [row] = liveRows();
        const kill = within(row).getByRole('button', { name: 'Kill run' }) as HTMLButtonElement;
        expect(kill.disabled).toBe(true);
        expect(kill.getAttribute('title')).toBe('Tear this one harness down; the Story keeps running (D-18, S-3)');
    });
});
