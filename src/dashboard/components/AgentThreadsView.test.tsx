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

    it('collapses the request by default and shows Request + Answer for a closed thread (U-8)', () => {
        render(<AgentThreadsView kind="writer" threads={[thread({})]} now={NOW} />);

        const bar = screen.getByRole('button', { name: /write_unit summary summary_1/ });
        expect(screen.queryByText('Write the Summary from the Seed.')).toBeNull();

        fireEvent.click(bar);

        const request = screen.getByRole('button', { name: 'Request' });
        expect(request.getAttribute('aria-expanded')).toBe('false');
        // The brief is collapsed: only its header is rendered.
        expect(screen.queryByText('Write the Summary from the Seed.')).toBeNull();
        expect(screen.getByText('Answer')).toBeTruthy();
        expect(screen.getByText('The Summary is written.')).toBeTruthy();

        fireEvent.click(request);

        expect(request.getAttribute('aria-expanded')).toBe('true');
        expect(screen.getByText('Write the Summary from the Seed.')).toBeTruthy();

        fireEvent.click(bar);
        expect(screen.queryByText('Write the Summary from the Seed.')).toBeNull();
    });

    it('outputs what a running thread is doing below the collapsed request, then drops it on close (U-8)', () => {
        const { rerender } = render(
            <AgentThreadsView
                kind="writer"
                threads={[
                    thread({
                        state: 'running',
                        ended_at: undefined,
                        answer: '',
                        activity: [{ at: '2026-11-22T12:00:05.000Z', text: 'readChapter — Chapter 1 read' }]
                    })
                ]}
                now={NOW}
            />
        );

        fireEvent.click(screen.getByRole('button', { name: /write_unit summary summary_1/ }));

        expect(screen.getByText('Happening now')).toBeTruthy();
        expect(screen.getByText('readChapter — Chapter 1 read')).toBeTruthy();
        expect(screen.getByText('+5s')).toBeTruthy();
        // The request is still collapsed, and a running thread has no answer block yet.
        expect(screen.getByRole('button', { name: 'Request' }).getAttribute('aria-expanded')).toBe('false');
        expect(screen.queryByText('Write the Summary from the Seed.')).toBeNull();
        expect(screen.queryByText('Answer')).toBeNull();

        rerender(<AgentThreadsView kind="writer" threads={[thread({})]} now={NOW} />);

        expect(screen.queryByText('Happening now')).toBeNull();
        expect(screen.getByText('Answer')).toBeTruthy();
        expect(screen.getByText('The Summary is written.')).toBeTruthy();
    });

    it('renders the request and the answer as formatted Markdown (U-8)', () => {
        render(
            <AgentThreadsView
                kind="writer"
                threads={[
                    thread({
                        request: '# ROLE — writer\n\nRead the Seed with `readSeed`.\n\n## Criteria\n\n- C-14\n- C-13',
                        answer: '## What happened\n\n- **Read** the Seed\n- Wrote the Summary\n\n```ts\nconst ok = true;\n```'
                    })
                ]}
                now={NOW}
            />
        );

        fireEvent.click(screen.getByRole('button', { name: /write_unit summary summary_1/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Request' }));

        const blocks = screen.getByTestId('agent-threads').querySelectorAll('.sv-markdown');
        expect(blocks).toHaveLength(2);

        const request = blocks[0]!;
        expect(request.querySelector('h1')?.textContent).toBe('ROLE — writer');
        expect(request.querySelector('p code')?.textContent).toBe('readSeed');
        expect(Array.from(request.querySelectorAll('li')).map((item) => item.textContent)).toEqual(['C-14', 'C-13']);

        const answer = blocks[1]!;
        expect(answer.querySelector('h2')?.textContent).toBe('What happened');
        expect(answer.querySelector('li strong')?.textContent).toBe('Read');
        expect(answer.querySelector('pre code')?.textContent).toContain('const ok = true;');

        // The blocks are prose, not preformatted text that shows the Markdown source.
        expect(screen.getByTestId('agent-threads').querySelector('pre.sv-thread__text')).toBeNull();
    });

    it('toggles the archived threads — completed, failed, abandoned — from the tab beside the Story title', () => {
        render(
            <AgentThreadsView
                kind="reader"
                threads={[
                    thread({
                        thread_id: 't-run',
                        run_id: 'run_live',
                        title: 'live pass',
                        state: 'running',
                        started_at: '2026-11-22T12:00:01.000Z',
                        ended_at: undefined,
                        answer: ''
                    }),
                    thread({
                        thread_id: 't-done',
                        run_id: 'run_done',
                        title: 'completed pass',
                        started_at: '2026-11-22T12:00:02.000Z'
                    }),
                    thread({
                        thread_id: 't-failed',
                        run_id: 'run_failed',
                        title: 'failed pass',
                        state: 'failed',
                        started_at: '2026-11-22T12:00:03.000Z'
                    })
                ]}
                now={NOW}
            />
        );

        const tab = screen.getByRole('button', { name: /Archived/ });
        expect(tab.getAttribute('aria-pressed')).toBe('true');

        const view = screen.getByTestId('agent-threads');
        const titles = (): string[] =>
            Array.from(view.querySelectorAll<HTMLElement>('.sv-thread__title')).map((bar) => bar.textContent ?? '');

        // The Story's whole history is the default surface.
        expect(titles()).toEqual(['live pass', 'completed pass', 'failed pass']);
        expect(within(view).getByText('3 threads')).toBeTruthy();

        fireEvent.click(tab);

        // Archived is every thread that is not running now: only the live pass is left.
        expect(tab.getAttribute('aria-pressed')).toBe('false');
        expect(titles()).toEqual(['live pass']);
        expect(within(view).getByText('1 thread')).toBeTruthy();
        expect(screen.queryByText('failed')).toBeNull();

        fireEvent.click(tab);

        expect(tab.getAttribute('aria-pressed')).toBe('true');
        expect(titles()).toEqual(['live pass', 'completed pass', 'failed pass']);
    });

    it('says the archive is hidden when no thread is running, and toggles each Story on its own', () => {
        const threads = [
            thread({ thread_id: 't-a', story_id: 'story_1', title: 'story one pass' }),
            thread({
                thread_id: 't-b',
                story_id: 'story_2',
                story_title: 'Salt Year',
                title: 'story two pass',
                state: 'running',
                ended_at: undefined,
                answer: ''
            })
        ];

        render(<AgentThreadsView kind="reader" threads={threads} now={NOW} />);

        const tabs = screen.getAllByRole('button', { name: /Archived/ });
        expect(tabs).toHaveLength(2);

        fireEvent.click(tabs[0]!);

        const view = screen.getByTestId('agent-threads');
        expect(view.querySelectorAll('.sv-threads__phase')).toHaveLength(1);
        expect(within(view).getByText('story two pass')).toBeTruthy();
        expect(within(view).getByText(/no thread is running now — 1 archived thread is hidden\./)).toBeTruthy();
        expect(tabs[1]!.getAttribute('aria-pressed')).toBe('true');
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
