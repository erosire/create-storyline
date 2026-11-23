// S-5's ceiling control: the dropdown the Author moves the loop's fan-out with, printed in the employee
// rail's header.
//
// WHAT THIS PINS: the ceiling in effect is the number shown (never the stance list's first entry, and
// never the engine's default when nothing has been read); a pick writes the PARSED integer, not the
// string; and a rail with nothing to read or no write to make renders the control disabled rather than
// interactive-but-dead — the convention every other picker on that rail follows.
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LoopLimitControl } from './LoopLimitControl';
import type { LoopSettings } from '../api';

const settings = (overrides: Partial<LoopSettings> = {}): LoopSettings => ({
    global_max_concurrent: 4,
    live_runs: 0,
    ...overrides
});

const select = () => screen.getByRole('combobox', { name: /maximum threads the loop runs at once/i }) as HTMLSelectElement;

describe('LoopLimitControl — S-5’s ceiling, edited', () => {
    it('shows the ceiling in effect, and offers the stance set around the shipped default', () => {
        render(<LoopLimitControl loop={settings({ global_max_concurrent: 4 })} onSetLimit={vi.fn()} />);

        expect(select().value).toBe('4');
        expect(select().disabled).toBe(false);
        expect(screen.getByText('Max threads')).toBeTruthy();

        const options = screen.getAllByRole('option').map((option) => option.textContent);

        expect(options).toEqual(['1', '2', '3', '4', '6', '8', '12', '16', '24', '32']);
    });

    it('prepends a ceiling that is off the list, so the control never misreports the process’s setting', () => {
        // `STORYLINE_GLOBAL_MAX_CONCURRENT=7` at boot: the dropdown must SHOW 7, not quietly render
        // its nearest stance and let the Author change a number they cannot see.
        render(<LoopLimitControl loop={settings({ global_max_concurrent: 7 })} onSetLimit={vi.fn()} />);

        const options = screen.getAllByRole('option').map((option) => option.textContent);

        expect(options[0]).toBe('7');
        expect(select().value).toBe('7');
    });

    it('writes the chosen ceiling as a number, once, straight to the server', () => {
        const onSetLimit = vi.fn();

        render(<LoopLimitControl loop={settings()} onSetLimit={onSetLimit} />);

        fireEvent.change(select(), { target: { value: '12' } });

        expect(onSetLimit).toHaveBeenCalledTimes(1);
        // A string would reach `PATCH /loop` and be refused by its own 400 (S-5).
        expect(onSetLimit).toHaveBeenCalledWith(12);
    });

    it('says on hover what the ceiling currently means, without printing a second running count', () => {
        render(<LoopLimitControl loop={settings({ global_max_concurrent: 8, live_runs: 6 })} onSetLimit={vi.fn()} />);

        const title = select().getAttribute('title') ?? '';

        expect(title).toContain('8 threads at once across EVERY Story (S-5)');
        expect(title).toContain('6 live now');
        // The count is hover text only: the rail's header carries no panel-wide running line, and each
        // tile's own badge already answers "how many are running".
        expect(screen.queryByText(/6 live/i)).toBeNull();
    });

    it('renders an unread ceiling as an uneditable em-dash rather than the engine’s default', () => {
        render(<LoopLimitControl loop={null} onSetLimit={vi.fn()} />);

        expect(select().disabled).toBe(true);
        expect(select().getAttribute('title')).toBe('the loop’s ceiling has not been read yet');
        expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['—']);
    });

    it('stays disabled when the rail has no write to make, so a dead picker cannot pretend to save', () => {
        render(<LoopLimitControl loop={settings()} />);

        expect(select().disabled).toBe(true);
    });

    it('ignores a value that is not a whole number of threads instead of sending a 400', () => {
        const onSetLimit = vi.fn();

        render(<LoopLimitControl loop={settings()} onSetLimit={onSetLimit} />);

        fireEvent.change(select(), { target: { value: '0' } });

        expect(onSetLimit).not.toHaveBeenCalled();
    });
});
