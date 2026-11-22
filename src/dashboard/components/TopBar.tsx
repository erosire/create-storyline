// §10.2 U-3 + U-11 — the top strip: one word of crew state, and the dialog behind it.
//
// THE HEADER IS ONE WORD. Idle, Working, Awaiting you, Stuck — the most urgent story-shaped fact
// the sweep has right now (L-34: a stall outranks a wait, a wait outranks activity). No counters,
// no prose, no buttons competing for the Author's eye: this is the line the Author glances at a
// hundred times an hour, and everything else belongs one click away.
//
// THE CLICK IS THE CONTROL PANEL. The dialog carries the three things the strip used to spend a
// row on: the health prose (U-11: story text, never a spinner), the Stories that need the Author
// — each row opens its Story so the to-do list is also the way to do it — and U-3's cord,
// "Stop everything". The cord is still the biggest control in the shell (`data-size="xl"`, the
// stylesheet keys the dominance off it); U-3's point is that the Author can always pull it, not
// that it has to shout while the loop is behaving.
//
// U-11: no "loop running ✓" spinner. The health line is STORY TEXT — the `progress` strings
// W4/W6 derive ("chapters drafted, hole in act 2, setups unpaid") — plus the counts of what
// needs the Author. An idle sweep therefore renders as the single word "Idle", which is correct:
// the loop being quiet is not news, and a spinner would be activity for its own sake.

import { useEffect, useState } from 'react';
import { useDashboard, useDashboardStore } from '../state';
import type { StoryRow } from '../api';

/** U-1b counts, split the way L-34 splits them: a wait is not a stall. */
function countWaits(stories: StoryRow[]) {
    let awaiting = 0;
    let stalled = 0;
    let working = 0;
    let done = 0;
    for (const row of stories) {
        if (row.status === 'completed') {
            done += 1;
        } else if (row.status === 'pending') {
            if (row.pending_kind === 'stalled') {
                stalled += 1;
            } else {
                awaiting += 1;
            }
        } else if (row.status === 'ready' || row.active_runs > 0) {
            working += 1;
        }
    }
    return { awaiting, stalled, working, done };
}

/** The one word the header shows: a stall outranks a wait, a wait outranks activity. */
function crewWord(counts: ReturnType<typeof countWaits>): string {
    if (counts.stalled > 0) return 'Stuck';
    if (counts.awaiting > 0) return 'Awaiting you';
    if (counts.working > 0) return 'Working';
    return 'Idle';
}

/** What the Author's decision is, per wait kind — the to-do list has to name the verb. */
const PENDING_VERBS: Record<StoryRow['pending_kind'], string> = {
    phase_signoff: 'sign off the phase',
    idea_selection: 'pick an Idea from the tray',
    finding_approval: 'approve or discard a Finding',
    drained: 'work the leftovers',
    stalled: 'unstick it — the loop stopped converging',
    none: 'look at it'
};

/** One row of the dialog's to-do list: the Story, and the one line that says why it is here. */
interface TodoRow {
    id: string;
    title: string;
    note: string;
    tone: 'awaiting' | 'stalled' | 'working';
}

/**
 * What needs the Author, most urgent first: stuck Stories, then the by-design waits, then the
 * crews still working (so the dialog also answers "is anything moving at all?").
 */
function todoRows(stories: StoryRow[]): TodoRow[] {
    const rows: TodoRow[] = [];
    for (const row of stories) {
        if (row.status === 'pending' && row.pending_kind === 'stalled') {
            rows.push({
                id: row.id,
                title: row.title,
                note: row.status_reason || row.blocked_on || 'the loop stopped converging',
                tone: 'stalled'
            });
        }
    }
    for (const row of stories) {
        if (row.status === 'pending' && row.pending_kind !== 'stalled') {
            rows.push({
                id: row.id,
                title: row.title,
                note: `${PENDING_VERBS[row.pending_kind]} — ${row.phase}`,
                tone: 'awaiting'
            });
        }
    }
    for (const row of stories) {
        if (row.status !== 'pending' && row.status !== 'completed' && (row.status === 'ready' || row.active_runs > 0)) {
            rows.push({
                id: row.id,
                title: row.title,
                note: row.progress || `${row.active_runs} crew${row.active_runs === 1 ? '' : 's'} on it`,
                tone: 'working'
            });
        }
    }
    return rows;
}

export function TopBar() {
    const store = useDashboardStore();
    const { stories, error } = useDashboard();
    const counts = countWaits(stories);
    const word = crewWord(counts);
    const [open, setOpen] = useState(false);
    const todos = todoRows(stories);

    // Escape closes the dialog: a panel this small should not trap the Author.
    useEffect(() => {
        if (!open) return undefined;
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open]);

    // U-11: the line is the most urgent story-shaped fact available. `blocked_on` is the
    // engine's one-line "what it is stuck on" (L-22's shape).
    const stalledRow = stories.find((row) => row.status === 'pending' && row.pending_kind === 'stalled');
    const workingRows = stories.filter((row) => row.active_runs > 0).slice(0, 2);
    const healthLine = stalledRow
        ? `${stalledRow.title}: ${stalledRow.status_reason || stalledRow.blocked_on || 'the loop stopped converging'}`
        : workingRows.length
          ? workingRows.map((row) => `${row.title}: ${row.progress || `${row.active_runs} crews on it`}`).join(' · ')
          : stories.length === 0
            ? 'no stories yet — write a Seed and the crews have something to work against'
            : 'no crew is working · the sweep will pick up anything you set ready';

    const pullCord = (): void => {
        setOpen(false);
        void store.stopAll();
    };

    return (
        <header className="topbar">
            <div className="topbar__brand">
                <span className="topbar__mark" aria-hidden="true">
                    S
                </span>
                <div className="topbar__title-block">
                    <h1 className="topbar__title">Storyline</h1>
                    {/* The pinned single-source version (vite.config.ts `__APP_VERSION__` define). */}
                    <span className="topbar__version">v{__APP_VERSION__}</span>
                </div>
            </div>

            {/* The header: one word. It opens the dialog with the to-do list and the cord. */}
            <button
                type="button"
                className="crew-state"
                data-state={word.toLowerCase().replace(/\s+/g, '-')}
                data-testid="crew-status"
                aria-haspopup="dialog"
                aria-expanded={open}
                onClick={() => setOpen(true)}
                title="what the crews are doing — click for what needs you and the kill switch"
            >
                {word}
            </button>

            {/* L-13: a refusal says why, in the server's own words. U-11's no-noise rule is
                about idle animation, not about hiding a rejection. */}
            {error ? (
                <p className="topbar__error" data-testid="error-line">
                    <span className="topbar__error-text">{error}</span>
                    <button type="button" className="button button--ghost" onClick={() => store.dismissError()}>
                        dismiss
                    </button>
                </p>
            ) : null}

            {open ? (
                <div
                    className="crew-dialog__backdrop"
                    onClick={(event) => {
                        if (event.target === event.currentTarget) setOpen(false);
                    }}
                >
                    <div className="crew-dialog" role="dialog" aria-modal="true" aria-label="Crew status">
                        <header className="crew-dialog__head">
                            <h2 className="crew-dialog__title">What needs you</h2>
                            <button
                                type="button"
                                className="button button--ghost"
                                data-testid="crew-dialog-close"
                                onClick={() => setOpen(false)}
                            >
                                Close
                            </button>
                        </header>

                        {/* U-1b: the counts live here now, split the way L-34 splits them. */}
                        <p className="crew-dialog__counts" data-testid="crew-counts">
                            <span data-tone="awaiting">{counts.awaiting} awaiting you</span>
                            <span data-tone="stalled">{counts.stalled} stuck</span>
                            <span data-tone="working">{counts.working} working</span>
                            <span data-tone="done">{counts.done} done</span>
                        </p>

                        {/* U-11: prose, never a spinner. */}
                        <p className="crew-dialog__health" data-testid="health-line">
                            {healthLine}
                        </p>

                        {todos.length > 0 ? (
                            <ul className="crew-dialog__list">
                                {todos.map((todo) => (
                                    <li key={`${todo.tone}:${todo.id}`}>
                                        <button
                                            type="button"
                                            className="crew-dialog__row"
                                            data-tone={todo.tone}
                                            data-testid={`crew-todo-${todo.id}`}
                                            onClick={() => {
                                                setOpen(false);
                                                void store.openStory(todo.id);
                                            }}
                                        >
                                            <span className="crew-dialog__row-title">{todo.title}</span>
                                            <span className="crew-dialog__row-note">{todo.note}</span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="crew-dialog__empty">nothing needs you — the loop is quiet.</p>
                        )}

                        <footer className="crew-dialog__foot">
                            {/* U-3: the cord. P8 — kills dispatch and in-flight runs for every
                                Story that could still be moving; a stopped Story never
                                auto-resumes. */}
                            <button
                                type="button"
                                className="stop-all"
                                data-size="xl"
                                data-testid="global-stop"
                                onClick={pullCord}
                                title="Stop every Story now: no new dispatch, in-flight runs killed (P8)"
                            >
                                Stop everything
                            </button>
                        </footer>
                    </div>
                </div>
            ) : null}
        </header>
    );
}

export default TopBar;
