// U-8 — the content area an employee tile opens: bars of threads grouped Story -> phrase (P1, P3, P4),
// oldest first, each bar expanding to its request and answer only.
//
// R7/R8/R9 — the list opens on RUNNING threads only; Archived is an explicit, per-Story opt-in that
// no data or refresh can select for the Author, and that survives a same-Story refetch.
// R9 also makes the tab a FILTER: the Archived reading holds only the terminal threads
// (torn_down / failed / abandoned), and a live bar never appears in it.
// R7 — the bar's role chip is dropped where it only repeats the employee the region is about.
// R4/R5/R6 — the kill cord exists only inside a RUNNING thread's expanded detail, fires once on the
// first click with that thread's run id, and stays disabled (not hidden) when no cord is injected.
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

/**
 * R7 — archived threads are OPT-IN now: opening an employee lists what is running. Every test that
 * reads a CLOSED thread (its bar, its request, its answer) has to pull the history in exactly the
 * way the Author does, so one helper keeps that click deliberate instead of repeating it inline.
 */
function showArchivedHistory(): void {
    for (const tab of screen.getAllByRole('button', { name: /Archived/ })) {
        if (tab.getAttribute('aria-pressed') !== 'true') fireEvent.click(tab);
    }
}

/** The thread titles the list renders right now, top to bottom — the cheapest read of the filter. */
function threadTitles(): string[] {
    return Array.from(
        screen.getByTestId('agent-threads').querySelectorAll<HTMLElement>('.sv-thread__title')
    ).map((bar) => bar.textContent ?? '');
}

/** The states of every THREAD ROW in the DOM right now — a filter check CSS could otherwise fake. */
function threadStates(): string[] {
    return Array.from(screen.getByTestId('agent-threads').querySelectorAll<HTMLElement>('.sv-thread')).map(
        (row) => row.dataset.state ?? ''
    );
}

/** The role chips the bars print, in order — R7 keeps only the ones that carry information. */
function roleChips(): string[] {
    return Array.from(screen.getByTestId('agent-threads').querySelectorAll<HTMLElement>('.sv-thread__role')).map(
        (chip) => chip.textContent ?? ''
    );
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
        // Every fixture here is closed, so the grouping is only visible once history is opted into.
        showArchivedHistory();

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
        // R7 — the fixture is a completed thread, so it sits behind the Archived tab.
        showArchivedHistory();

        const bar = screen.getByRole('button', { name: /write_unit summary summary_1/ });

        expect(within(bar).getByText('P1')).toBeTruthy();
        expect(within(bar).getByText('4s')).toBeTruthy();
        expect(within(bar).getByText('13,275 tokens')).toBeTruthy();
        expect(within(bar).getByText('completed')).toBeTruthy();
    });

    it('keeps the cord inside a RUNNING thread’s expanded detail and drops it on close (P8, U-7, R4)', () => {
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

        // R4 — a COLLAPSED running bar carries no cord at all: the accidental click is impossible.
        expect(screen.queryByRole('button', { name: 'kill run' })).toBeNull();
        expect(screen.getByTestId('agent-threads').querySelector('.sv-thread__actions')).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: /live summary attempt/ }));

        // R4 — expanding reveals it, INSIDE the expanded detail subtree rather than beside the card.
        const detail = screen.getByTestId('agent-threads').querySelector<HTMLElement>('.sv-thread__detail')!;
        expect(detail).toBeTruthy();
        const kill = within(detail).getByRole('button', { name: 'kill run' });
        expect(kill).toBeTruthy();
        // R4 — and it is no longer a row of the card itself, sitting under the collapsed bar.
        const card = detail.parentElement!;
        expect(card.classList.contains('sv-thread')).toBe(true);
        expect(card.querySelector(':scope > .sv-thread__actions')).toBeNull();

        // R5 — one click, exactly once, with this thread's run id: no confirmation, no arming step.
        fireEvent.click(kill);
        expect(onKillRun).toHaveBeenCalledTimes(1);
        expect(onKillRun).toHaveBeenCalledWith('run_1');

        rerender(
            <AgentThreadsView
                kind="writer"
                threads={[thread({ state: 'torn_down' })]}
                now={NOW}
                onKillRun={onKillRun}
            />
        );

        // R6 — a thread that is not running has no cord, and no actions row to hold one.
        expect(screen.queryByRole('button', { name: 'kill run' })).toBeNull();
        expect(screen.getByTestId('agent-threads').querySelector('.sv-thread__actions')).toBeNull();
    });

    it('gives an EXPANDED closed thread no cord, and disables rather than hides it with no callback (R6)', () => {
        const onKillRun = vi.fn();
        const { rerender } = render(
            <AgentThreadsView kind="writer" threads={[thread({})]} now={NOW} onKillRun={onKillRun} />
        );

        showArchivedHistory();
        fireEvent.click(screen.getByRole('button', { name: /write_unit summary summary_1/ }));

        // The detail is open (its Answer block proves it) and still offers no way to kill.
        expect(screen.getByText('Answer')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'kill run' })).toBeNull();

        // R9 — the tab is a filter, so the RUNNING thread below belongs to the LIVE reading: the
        // Author clicks Archived back off (the same click that made the closed bar appear, undone)
        // and the cord is tested where a live thread actually renders. The bar's own expanded state
        // is view state keyed by thread id, so it survives both the toggle and the refetch.
        fireEvent.click(screen.getByRole('button', { name: /Archived/ }));
        expect(threadStates()).toEqual([]);

        // Same running thread, no cord injected: the button stays, disabled, with its semantics intact.
        rerender(
            <AgentThreadsView
                kind="writer"
                threads={[thread({ state: 'running', ended_at: undefined, answer: '' })]}
                now={NOW}
            />
        );

        expect(threadStates()).toEqual(['running']);

        const kill = screen.getByRole('button', { name: 'kill run' });
        expect(kill.hasAttribute('disabled')).toBe(true);
        expect(kill.getAttribute('title')).toBe('Tear this run down; the Story keeps running (P8, U-7, S-3)');
        // A disabled cord is inert: clicking it must not invent a kill call.
        fireEvent.click(kill);
        expect(onKillRun).not.toHaveBeenCalled();
    });

    it('collapses the request by default and shows Request + Answer for a closed thread (U-8)', () => {
        render(<AgentThreadsView kind="writer" threads={[thread({})]} now={NOW} />);
        // R7 — a closed thread is history: the Author opts into it before opening the bar.
        showArchivedHistory();

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

        // R9 — a RUNNING thread is the live reading: it needs no Archived click, and none is made.
        expect(screen.getByRole('button', { name: /Archived/ }).getAttribute('aria-pressed')).toBe('false');
        expect(threadStates()).toEqual(['running']);

        fireEvent.click(screen.getByRole('button', { name: /write_unit summary summary_1/ }));

        expect(screen.getByText('Happening now')).toBeTruthy();
        expect(screen.getByText('readChapter — Chapter 1 read')).toBeTruthy();
        expect(screen.getByText('+5s')).toBeTruthy();
        // The request is still collapsed, and a running thread has no answer block yet.
        expect(screen.getByRole('button', { name: 'Request' }).getAttribute('aria-expanded')).toBe('false');
        expect(screen.queryByText('Write the Summary from the Seed.')).toBeNull();
        expect(screen.queryByText('Answer')).toBeNull();

        // R7 — the thread closes in the rerender below, so it leaves the live list at once; the
        // Archived choice then has to be made once, by click, and it survives that refetch (R9).
        rerender(<AgentThreadsView kind="writer" threads={[thread({})]} now={NOW} />);

        expect(threadStates()).toEqual([]);
        expect(screen.queryByText('Happening now')).toBeNull();
        // R9 — the live branch is the only one allowed to say what is not running.
        expect(screen.getByText(/no thread is running now — 1 archived thread is hidden\./)).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: /Archived/ }));

        expect(threadStates()).toEqual(['torn_down']);
        expect(screen.getByText('Answer')).toBeTruthy();
        expect(screen.getByText('The Summary is written.')).toBeTruthy();
        // The Archived reading never repeats that sentence: it is showing the archived thread.
        expect(screen.queryByText(/no thread is running now/)).toBeNull();
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

        // R7 — both blocks belong to a closed thread, so history is opted into first.
        showArchivedHistory();

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

    it('lists running threads first and reveals the archived ones only when the tab is clicked (R7, R9)', () => {
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

        // R7 — nothing auto-selects Archived: opening an employee answers "what is working now",
        // so the live pass is the only bar and the tab sits unpressed beside the title.
        expect(tab.getAttribute('aria-pressed')).toBe('false');
        expect(tab.getAttribute('data-active')).toBe('false');
        expect(threadTitles()).toEqual(['live pass']);
        expect(threadStates()).toEqual(['running']);
        expect(within(screen.getByTestId('agent-threads')).getByText('1 thread')).toBeTruthy();
        // The tab's total is the Story's ARCHIVED threads, never the rows currently on screen: it is
        // the same number before and after the click, so it stays a count of what the tab reaches.
        expect(tab.querySelector<HTMLElement>('.sv-threads__archive-count')?.textContent).toBe('2');
        expect(screen.queryByText('failed')).toBeNull();

        fireEvent.click(tab);

        // R9 — the click FILTERS rather than adds: the Archived reading is every thread that is not
        // running (completed, failed, abandoned) and nothing else. The live pass leaves the DOM
        // entirely; it is not merely styled away.
        expect(tab.getAttribute('aria-pressed')).toBe('true');
        expect(tab.getAttribute('data-active')).toBe('true');
        expect(threadTitles()).toEqual(['completed pass', 'failed pass']);
        expect(threadStates()).toEqual(['torn_down', 'failed']);
        expect(within(screen.getByTestId('agent-threads')).getByText('2 threads')).toBeTruthy();
        expect(tab.querySelector<HTMLElement>('.sv-threads__archive-count')?.textContent).toBe('2');

        fireEvent.click(tab);

        // It is still a toggle: the Author gets the running-only reading back on the second click.
        expect(tab.getAttribute('aria-pressed')).toBe('false');
        expect(threadTitles()).toEqual(['live pass']);
        expect(threadStates()).toEqual(['running']);
    });

    it('shows running threads only per Story by default, and opens each Story’s history on its own tab (R7, R9)', () => {
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
        // R7 — neither Story is auto-selected; R9 — both tabs stay available as manual access.
        expect(tabs).toHaveLength(2);
        expect(tabs.map((tab) => tab.getAttribute('aria-pressed'))).toEqual(['false', 'false']);

        const view = screen.getByTestId('agent-threads');

        // story_1 is closed-out: with the running-only default its zero-running state is the
        // sentence that names what is folded away, and story_2 still shows its live pass.
        expect(within(view).queryByText('story one pass')).toBeNull();
        expect(within(view).getByText('story two pass')).toBeTruthy();
        expect(within(view).getByText(/no thread is running now — 1 archived thread is hidden\./)).toBeTruthy();

        fireEvent.click(tabs[0]!);

        // R9 — one Story's tab opens only that Story: the empty state is gone, the closed pass is
        // here, and story_2 keeps the running-only reading the Author never asked to change.
        expect(within(view).getByText('story one pass')).toBeTruthy();
        expect(within(view).queryByText(/no thread is running now/)).toBeNull();
        // R9 — story_1's Archived list is its closed thread ONLY: no running row appears inside the
        // Story the tab was pressed on, while story_2 (unpressed) still shows its live pass.
        const storyOne = view.querySelector<HTMLElement>('[data-story="story_1"]')!;
        const storyTwo = view.querySelector<HTMLElement>('[data-story="story_2"]')!;

        expect(
            Array.from(storyOne.querySelectorAll<HTMLElement>('.sv-thread')).map((row) => row.dataset.state)
        ).toEqual(['torn_down']);
        expect(
            Array.from(storyTwo.querySelectorAll<HTMLElement>('.sv-thread')).map((row) => row.dataset.state)
        ).toEqual(['running']);
        expect(
            screen.getAllByRole('button', { name: /Archived/ }).map((tab) => tab.getAttribute('aria-pressed'))
        ).toEqual(['true', 'false']);
        expect(within(view).getByText('story two pass')).toBeTruthy();
    });

    it('leaves the Archived reading blank when only a running thread exists, and says nothing false (R9)', () => {
        render(
            <AgentThreadsView
                kind="writer"
                threads={[
                    thread({
                        thread_id: 't-run',
                        title: 'live pass',
                        state: 'running',
                        ended_at: undefined,
                        answer: ''
                    })
                ]}
                now={NOW}
            />
        );

        const tab = screen.getByRole('button', { name: /Archived/ });

        expect(threadStates()).toEqual(['running']);
        // The tab already says there is nothing to reach, and it is still unpressed (R7/R8).
        expect(tab.querySelector<HTMLElement>('.sv-threads__archive-count')?.textContent).toBe('0');
        expect(tab.getAttribute('aria-pressed')).toBe('false');

        fireEvent.click(tab);

        // R9 — clicking Archived asks for the closed threads, and this Story has none: the live pass
        // leaves the DOM rather than staying behind as an archived row.
        expect(threadTitles()).toEqual([]);
        expect(threadStates()).toEqual([]);

        // R9 — and the blank Archived screen stays blank. "no thread is running now — 0 archived
        // threads are hidden." would be a false statement on the reading the Author just chose, and
        // a pointless one about a Story whose whole point is the thread still running.
        expect(screen.queryByText(/no thread is running now/)).toBeNull();

        fireEvent.click(tab);

        // Toggling back restores the live row exactly as it was: the filter lost nothing.
        expect(tab.getAttribute('aria-pressed')).toBe('false');
        expect(threadTitles()).toEqual(['live pass']);
        expect(threadStates()).toEqual(['running']);
    });

    it('prints the role chip only where it says more than the selected employee (R7)', () => {
        // Every bar here is RUNNING, so the live reading shows all of them without an Archived click.
        const live = (overrides: Partial<AgentThreadRecord>): AgentThreadRecord =>
            thread({ state: 'running', ended_at: undefined, answer: '', ...overrides });

        const threads = [
            live({ thread_id: 't-self', title: 'plain writer pass', started_at: '2026-11-22T12:00:01.000Z' }),
            live({
                thread_id: 't-sibling',
                title: 'sibling pass',
                role_name: 'writer#agent_2',
                started_at: '2026-11-22T12:00:02.000Z'
            }),
            live({
                thread_id: 't-delegated',
                title: 'delegated pass',
                role_name: 'researcher',
                started_at: '2026-11-22T12:00:03.000Z'
            }),
            live({
                thread_id: 't-blank',
                title: 'blank role pass',
                role_name: '',
                started_at: '2026-11-22T12:00:04.000Z'
            }),
            // An UNTITLED thread falls back to `role_name` for its name: dropping the chip must not
            // leave the row nameless, even when the chip itself is redundant.
            live({ thread_id: 't-untitled', title: '', started_at: '2026-11-22T12:00:05.000Z' })
        ];

        render(<AgentThreadsView kind="writer" threads={threads} now={NOW} />);

        const view = screen.getByTestId('agent-threads');

        // R7 — the region keeps its accessible name (that is the sentence that says WHOSE threads
        // these are), and the heading above it repeats it in print; the bars no longer do.
        expect(view.getAttribute('aria-label')).toBe('writer threads');
        expect(threadTitles()).toEqual([
            'plain writer pass',
            'sibling pass',
            'delegated pass',
            'blank role pass',
            'writer'
        ]);

        // Only the chips that carry information survive: a panel sibling and a delegated role. The
        // exact repeat of the selected kind, and a blank role, render no chip at all.
        expect(roleChips()).toEqual(['writer#agent_2', 'researcher']);
        expect(view.querySelectorAll<HTMLElement>('.sv-thread__role')).toHaveLength(2);
        // Untitled row still names itself by its role, chip or no chip.
        expect(within(view).getByText('writer')).toBeTruthy();
    });

    it('never selects Archived on a rerender, and keeps the click across a same-Story refetch (R8, R9)', () => {
        const closed = [thread({ thread_id: 't-done', title: 'completed pass' })];
        const { rerender } = render(<AgentThreadsView kind="reader" threads={closed} now={NOW} />);

        // R7 — an archived-only Story still opens running-only; it does not fall back to Archived.
        expect(screen.getByRole('button', { name: /Archived/ }).getAttribute('aria-pressed')).toBe('false');
        expect(threadTitles()).toEqual([]);
        // R9 — with nothing running, the LIVE branch is the one allowed to name what is folded away.
        expect(screen.getByText(/no thread is running now — 1 archived thread is hidden\./)).toBeTruthy();

        // R8 — a plain refetch (new array, same content) changes nothing on the Author's behalf.
        rerender(<AgentThreadsView kind="reader" threads={[...closed]} now={NOW} />);
        expect(screen.getByRole('button', { name: /Archived/ }).getAttribute('aria-pressed')).toBe('false');
        expect(threadTitles()).toEqual([]);

        // R9 — the click is the only writer, and it survives the next refetch of the same employee.
        fireEvent.click(screen.getByRole('button', { name: /Archived/ }));
        expect(threadTitles()).toEqual(['completed pass']);
        expect(threadStates()).toEqual(['torn_down']);
        // R9 — the Archived reading shows the closed pass, so the live sentence is gone with it.
        expect(screen.queryByText(/no thread is running now/)).toBeNull();

        const later = thread({
            thread_id: 't-later',
            title: 'newest pass',
            started_at: '2026-11-22T12:00:07.000Z'
        });

        rerender(<AgentThreadsView kind="reader" threads={[...closed, later]} now={NOW} />);

        expect(screen.getByRole('button', { name: /Archived/ }).getAttribute('aria-pressed')).toBe('true');
        expect(threadTitles()).toEqual(['completed pass', 'newest pass']);
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

        // R7 — the legacy pass is a FAILED thread, i.e. archived: the tab is how it comes back.
        fireEvent.click(screen.getByRole('button', { name: /Archived/ }));

        fireEvent.click(screen.getByRole('button', { name: /wi_check_chapters_1/ }));

        expect(screen.getByText('failed — provider fault')).toBeTruthy();
        expect(screen.getByTestId('agent-threads').querySelector('.sv-thread')?.getAttribute('data-retained')).toBe(
            'false'
        );
    });
});
