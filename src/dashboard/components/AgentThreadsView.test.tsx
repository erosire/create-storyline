// U-8 — the content area an employee tile opens: bars of threads grouped Story -> phrase (P1, P3, P4),
// oldest first, each bar expanding to its request and answer only.
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { AgentThreadsView } from './AgentThreadsView';
import type { AgentThreadRecord } from '../api';

const NOW = '2026-11-22T12:00:10.000Z';

function thread(overrides: Partial<AgentThreadRecord>): AgentThreadRecord {
    return {
        thread_id: 'thread-1',
        run_id: 'run_1',
        story_id: 'story_1',
        story_title: 'Hollow Sea',
        phase: 'summary',
        role: 'writer',
        role_name: 'writer',
        title: 'write_unit summary summary_1',
        state: 'torn_down',
        started_at: '2026-11-22T12:00:00.000Z',
        ended_at: '2026-11-22T12:00:04.000Z',
        tokens: 13275,
        request: 'Write the Summary from the Seed.',
        answer: 'The Summary is written.',
        retained: true,
        ...overrides
    };
}

describe('AgentThreadsView — one agent, every thread, grouped by the harness tree', () => {
    it('groups by Story then phrase and keeps each phrase oldest first (U-8)', () => {
        const threads = [
            thread({
                thread_id: 't-summary-new',
                phase: 'summary',
                started_at: '2026-11-22T12:00:05.000Z',
                title: 'newer summary attempt'
            }),
            thread({
                thread_id: 't-chapters',
                phase: 'chapters',
                started_at: '2026-11-22T12:00:06.000Z',
                title: 'write chapter_1'
            }),
            thread({
                thread_id: 't-summary-old',
                phase: 'summary',
                started_at: '2026-11-22T12:00:01.000Z',
                title: 'older summary attempt'
            }),
            thread({
                thread_id: 't-other-story',
                story_id: 'story_2',
                story_title: 'Salt Year',
                phase: 'plotlines',
                started_at: '2026-11-22T12:00:02.000Z',
                title: 'write plotlines'
            })
        ];

        render(<AgentThreadsView kind="writer" threads={threads} now={NOW} />);

        const view = screen.getByTestId('agent-threads');
        const stories = view.querySelectorAll<HTMLElement>('.sv-threads__story');

        expect(Array.from(stories).map((story) => story.dataset.story)).toEqual(['story_1', 'story_2']);

        const first = stories[0]!;
        const phases = first.querySelectorAll<HTMLElement>('.sv-threads__phase');
        expect(Array.from(phases).map((phase) => phase.dataset.phase)).toEqual(['summary', 'chapters']);

        const summary = phases[0]!;
        expect(summary.querySelector('.sv-threads__phase-code')?.textContent).toBe('P1');
        expect(within(summary).getByText('Summary')).toBeTruthy();
        expect(within(summary).getByText('2 threads')).toBeTruthy();

        const bars = summary.querySelectorAll<HTMLElement>('.sv-thread__title');
        // Oldest on top, newest at the bottom.
        expect(Array.from(bars).map((bar) => bar.textContent)).toEqual([
            'older summary attempt',
            'newer summary attempt'
        ]);
    });

    it('labels the bar with the phase code, duration, tokens and retained state (U-8)', () => {
        render(<AgentThreadsView kind="writer" threads={[thread({})]} now={NOW} />);

        const bar = screen.getByRole('button', { name: /write_unit summary summary_1/ });

        expect(within(bar).getByText('P1')).toBeTruthy();
        expect(within(bar).getByText('4s')).toBeTruthy();
        expect(within(bar).getByText('13,275 tokens')).toBeTruthy();
        expect(within(bar).getByText('completed')).toBeTruthy();
    });

    it('keeps the Author’s cord on a running thread and removes it once the thread closes (P8, U-7)', () => {
        const onKillRun = vi.fn();
        const { rerender } = render(
            <AgentThreadsView
                kind="writer"
                threads={[
                    thread({
                        state: 'running',
                        ended_at: undefined,
                        answer: '',
                        title: 'live summary attempt'
                    })
                ]}
                now={NOW}
                onKillRun={onKillRun}
            />
        );

        fireEvent.click(screen.getByRole('button', { name: 'kill run' }));
        expect(onKillRun).toHaveBeenCalledWith('run_1');

        rerender(
            <AgentThreadsView
                kind="writer"
                threads={[thread({ state: 'torn_down' })]}
                now={NOW}
                onKillRun={onKillRun}
            />
        );

        expect(screen.queryByRole('button', { name: 'kill run' })).toBeNull();
    });

    it('shows exactly the request and the answer when a bar is opened', () => {
        render(<AgentThreadsView kind="writer" threads={[thread({})]} now={NOW} />);

        const bar = screen.getByRole('button', { name: /write_unit summary summary_1/ });
        expect(screen.queryByText('Write the Summary from the Seed.')).toBeNull();

        fireEvent.click(bar);

        expect(screen.getByText('Request')).toBeTruthy();
        expect(screen.getByText('Write the Summary from the Seed.')).toBeTruthy();
        expect(screen.getByText('Answer')).toBeTruthy();
        expect(screen.getByText('The Summary is written.')).toBeTruthy();

        fireEvent.click(bar);
        expect(screen.queryByText('Write the Summary from the Seed.')).toBeNull();
    });

    it('renders nothing when the agent has no threads, and still shows a legacy run’s retained answer', () => {
        const { rerender } = render(<AgentThreadsView kind="checker" threads={[]} now={NOW} />);

        expect(screen.queryByText(/No checker thread has run yet/)).toBeNull();
        expect(screen.queryByRole('button')).toBeNull();

        rerender(
            <AgentThreadsView
                kind="checker"
                threads={[
                    thread({
                        thread_id: 'legacy',
                        role: 'checker',
                        role_name: 'checker',
                        title: 'wi_check_chapters_1',
                        answer: 'failed — provider fault',
                        retained: false,
                        state: 'failed'
                    })
                ]}
                now={NOW}
            />
        );

        fireEvent.click(screen.getByRole('button', { name: /wi_check_chapters_1/ }));

        expect(screen.getByText('failed — provider fault')).toBeTruthy();
        expect(screen.getByTestId('agent-threads').querySelector('.sv-thread')?.getAttribute('data-retained')).toBe(
            'false'
        );
    });
});
