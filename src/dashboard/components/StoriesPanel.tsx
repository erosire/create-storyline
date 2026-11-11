// §10.2 U-1 / U-1b / U-1c / U-2 / U-3 / U-12a — the STORIES region (W9's acceptance surface).
//
// THE ONE SORT RULE (U-1): "Stories waiting on the Author sort to the top — they are the
// ones only the Author can move." Everything else is a tie-break, so the order is:
//   awaiting (sign-off · idea pick · finding approval · drained)  ← only the Author can move
//   stalled (the loop stopped converging — still the Author's, but it is not a wait)
//   ready (the sweep has it; nothing to do)
//   stopped (the Author pulled the cord; it will not move until they say so)
//   completed (closed)
// A stalled Story ranks below an awaiting one on purpose (L-37a): the designed waits are the
// product working, and a stall is the product being honest — it must not crowd out the three
// sign-offs the whole pipeline aims at.
//
// THE TWO TONES (U-1b / L-34): `data-tone` is the whole mechanism — `awaiting` is calm,
// `stalled` is urgent, and the stylesheet makes them a different colour AND a different
// weight so the difference survives a monochrome screen (L-24: neither is an error state, so
// neither is red-on-red; a stall is amber-heavy, not "failed").
//
// DRAINED IS NEVER A NOUN ON SCREEN (U-1c): the word is an internal name. A drained row
// states what the crew stopped finding and offers exactly the two moves L-37 allows —
// work the leftovers, or complete.

import { useDashboard, useDashboardStore } from '../state';
import type { StoryRow } from '../api';
import type { PendingKind, StoryPhase, StoryStatus, Trend } from '../../shared/types';

/** U-12a: the strip is ①②③ and readable from across the room — glyph plus a short name. */
const PHASE_MARKS: Array<{ phase: StoryPhase; glyph: string; label: string }> = [
    { phase: 'summary', glyph: '①', label: 'Summary' },
    { phase: 'plotlines', glyph: '②', label: 'Plotlines' },
    { phase: 'chapters', glyph: '③', label: 'Chapters' }
];

const PHASE_ORDER: Record<StoryPhase, number> = { summary: 0, plotlines: 1, chapters: 2 };

/** U-1's status badge — the §4.1 enum values verbatim, because the Author learns these words. */
const STATUS_LABELS: Record<StoryStatus, string> = {
    ready: 'ready',
    pending: 'pending',
    completed: 'completed',
    stopped: 'stopped'
};

/**
 * U-1b: what a `pending` Story is waiting for, in the Author's terms. `drained` is the one
 * entry that must never print its own name (U-1c) — it reads as a finished thing.
 */
const WAIT_LABELS: Record<Exclude<PendingKind, 'none' | 'stalled'>, string> = {
    phase_signoff: 'awaiting your signature',
    idea_selection: 'Ideas need picking',
    finding_approval: 'findings need approving',
    drained: 'the crew found nothing left it may act on'
};

/** L-15's arrow: the trend is a direction, not a number (P6 — pass/fail, never a score). */
const TREND_ARROWS: Record<Trend, string> = {
    improving: '↑',
    flat: '→',
    regressing: '↓',
    unknown: '?'
};

/**
 * L-34's two colours. `awaiting` covers all four by-design waits including drained;
 * `stalled` is the only flavour that means trouble (P14). `running` / `halted` / `done` are
 * the non-pending states, which need no wait colour at all.
 */
export type PendingTone = 'awaiting' | 'stalled' | 'running' | 'halted' | 'done';

export function pendingTone(row: StoryRow): PendingTone {
    if (row.status === 'completed') {
        return 'done';
    }
    if (row.status === 'stopped') {
        return 'halted';
    }
    if (row.status === 'pending') {
        return row.pending_kind === 'stalled' ? 'stalled' : 'awaiting';
    }
    return 'running';
}

/** U-1's sort key: lower ranks first; `id` breaks ties so the order never jitters per read. */
export function storyRank(row: StoryRow): number {
    if (row.status === 'pending') {
        return row.pending_kind === 'stalled' ? 1 : 0;
    }
    if (row.status === 'ready') {
        return 2;
    }
    if (row.status === 'stopped') {
        return 3;
    }
    return 4;
}

export function sortStories(stories: StoryRow[]): StoryRow[] {
    return [...stories].sort((a, b) => storyRank(a) - storyRank(b) || a.id.localeCompare(b.id));
}

/**
 * U-1c's leftovers sentence. W3/L-22 make `status_reason` name the specifics ("C-4 has
 * failed on chapters 6–9 for 11 rounds…"), and for a drained Story T7 writes the triage line
 * there — "no critical or major left · 12 minor and 4 taste awaiting you". The client does
 * NOT recount findings: only the server has the dial's threshold (D-35b), and a second count
 * would be a second truth (P3).
 */
export function waitSentence(row: StoryRow): string {
    if (row.pending_kind === 'drained') {
        return row.status_reason || 'no critical or major left · nothing awaiting you above the dial';
    }
    return row.status_reason || WAIT_LABELS[row.pending_kind as Exclude<PendingKind, 'none' | 'stalled'>] || '';
}

/** The `n/m` lines (L-14). A phase not reached arrives as `n/a` from W3 — rendered as-is. */
const LEVEL_LINES: Array<{ key: keyof StoryRow['levels']; label: string }> = [
    { key: 'summary', label: 'idea→summary' },
    { key: 'plotlines', label: 'summary→plotlines' },
    { key: 'chapters', label: 'plotlines→chapters' },
    { key: 'whole', label: 'whole' }
];

/** U-12a: which phases are signed. Phase ③'s lock IS `completed` (L-25a — no fourth phase). */
function phaseLocks(row: StoryRow): boolean[] {
    return [row.summary_locked, row.plotlines_locked, row.status === 'completed'];
}

/**
 * U-1b's last sentence ("the state the whole product aims at … clear in one click") plus
 * L-37's two drained moves. Anything else gets a navigation move that lands the Author on
 * the surface where the decision actually lives.
 */
type Move = { label: string; hint: string; action: 'lock' | 'complete' | 'open' | 'queue' };

function rowMoves(row: StoryRow): Move[] {
    if (row.status === 'pending' && row.pending_kind === 'drained') {
        // L-37: exactly two moves, both the Author's.
        return [
            {
                label: 'Work the leftovers',
                hint: 'approve a sub-threshold finding — it spawns a task and returns the Story to ready (L-37)',
                action: 'queue'
            },
            {
                label: 'Complete',
                hint: 'accept the book as it stands and close the leftovers (L-26)',
                action: 'complete'
            }
        ];
    }
    if (row.status === 'pending' && row.pending_kind === 'phase_signoff') {
        const mark = PHASE_MARKS[PHASE_ORDER[row.phase]];
        return [
            {
                label: `Lock phase ${mark.glyph}`,
                hint: `signs off ${mark.label} and empties the Ideas tray (D-36)`,
                action: 'lock'
            }
        ];
    }
    if (row.status === 'pending' && row.pending_kind === 'idea_selection') {
        return [{ label: 'Pick the Ideas', hint: 'the tray is at the top of the Story view (U-15)', action: 'open' }];
    }
    if (row.status === 'pending' && row.pending_kind === 'finding_approval') {
        return [{ label: 'Approve findings', hint: 'approving is what starts Writer work (D-34)', action: 'queue' }];
    }
    if (row.pending_kind === 'stalled') {
        // U-1a / L-23: the four exits are buttons, and they live on the Story view.
        return [{ label: 'Review the stall', hint: 'the stuck criteria and the four exits (L-23)', action: 'open' }];
    }
    return [];
}

export function StoriesPanel() {
    const store = useDashboardStore();
    const { stories, activeStoryId } = useDashboard();
    const ordered = sortStories(stories);

    const runMove = (row: StoryRow, move: Move) => {
        if (move.action === 'lock') {
            void store.lockPhase(row.id);
            return;
        }
        if (move.action === 'complete') {
            void store.acceptCompletion(row.id);
            return;
        }
        if (move.action === 'queue') {
            // "Work the leftovers" stays in the panel and jumps the queue to this Story
            // (state.setQueueFilter) — the Author is picking items up, not browsing a book.
            void store.openStory(row.id);
            store.setQueueFilter(row.id);
            return;
        }
        void store.openStory(row.id);
    };

    return (
        <div className="panel panel--stories" data-testid="stories-panel">
            <h2 className="panel__title">Stories</h2>
            <p className="panel__hint">phase-first, then status: the ones only you can move are on top (U-1).</p>

            {ordered.length === 0 ? <p className="panel__empty">no stories · write a Seed below</p> : null}

            <ul className="story-list">
                {ordered.map((row) => {
                    const tone = pendingTone(row);
                    const locks = phaseLocks(row);
                    const active = row.id === activeStoryId;
                    const moves = rowMoves(row);
                    const wait = row.status === 'pending' ? waitSentence(row) : '';

                    return (
                        <li
                            key={row.id}
                            className="story-row"
                            data-story={row.id}
                            data-tone={tone}
                            data-phase={row.phase}
                            data-status={row.status}
                            data-pending-kind={row.pending_kind}
                            data-active={active ? 'true' : 'false'}
                        >
                            {/* U-1 / U-12a row header: title, strip, badge, levels, trend. */}
                            <button
                                type="button"
                                className="story-row__open"
                                data-testid="story-row-open"
                                onClick={() => void store.openStory(row.id)}
                                aria-current={active ? 'true' : undefined}
                            >
                                <span className="story-row__title">{row.title}</span>

                                <span className="phase-strip" data-testid="phase-strip" aria-label="phase strip">
                                    {PHASE_MARKS.map((mark, index) => {
                                        const state = locks[index]
                                            ? 'signed'
                                            : PHASE_ORDER[row.phase] === index
                                              ? 'current'
                                              : PHASE_ORDER[row.phase] > index
                                                ? 'past'
                                                : 'ahead';
                                        return (
                                            <span
                                                key={mark.phase}
                                                className="phase-mark"
                                                data-phase={mark.phase}
                                                data-state={state}
                                                data-locked={locks[index] ? 'true' : 'false'}
                                                title={`${mark.label} ${mark.glyph} · ${state}`}
                                                aria-label={`${mark.label} ${mark.glyph} · ${state}`}
                                            >
                                                {mark.glyph}
                                                {/* The lock glyph is the "has signed" mark (U-12a). */}
                                                {locks[index] ? (
                                                    <span className="phase-mark__lock" aria-hidden="true">
                                                        ⚿
                                                    </span>
                                                ) : null}
                                            </span>
                                        );
                                    })}
                                </span>

                                <span className={`badge badge--${row.status}`} data-tone={tone}>
                                    {STATUS_LABELS[row.status]}
                                </span>

                                {/* L-14's rendered levels — the client never recomputes them. */}
                                <span className="levels" data-testid="levels">
                                    {LEVEL_LINES.map((line) => (
                                        <span key={line.key} className="level" data-level={line.key}>
                                            <span className="level__label">{line.label}</span>
                                            <span className="level__value">{row.levels[line.key]}</span>
                                        </span>
                                    ))}
                                </span>

                                <span className="trend" data-trend={row.trend} title={`trend: ${row.trend}`}>
                                    {TREND_ARROWS[row.trend]}
                                </span>
                            </button>

                            {/* U-1b's wait line. A stalled row prints L-22's reason — the
                                specific stuck thing, never "consistency low". */}
                            {wait ? (
                                <p className="story-row__wait" data-tone={tone}>
                                    <span className="story-row__wait-label">
                                        {row.pending_kind === 'stalled'
                                            ? 'stuck'
                                            : WAIT_LABELS[row.pending_kind as Exclude<PendingKind, 'none' | 'stalled'>]}
                                    </span>
                                    <span className="story-row__wait-detail">{wait}</span>
                                </p>
                            ) : null}

                            {/* U-2: a Story with nothing blocked still says what the crew is
                                doing to it right now — in story words (U-11). */}
                            {row.active_runs > 0 || row.progress ? (
                                <p className="story-row__crew">
                                    <span className="story-row__runs">{row.active_runs} crews on it</span>
                                    <span className="story-row__progress">{row.progress || ''}</span>
                                </p>
                            ) : null}

                            <span className="story-row__moves" data-slot="moves">
                                {moves.map((move) => (
                                    <button
                                        key={move.label}
                                        type="button"
                                        className="button button--move"
                                        title={move.hint}
                                        onClick={() => runMove(row, move)}
                                    >
                                        {move.label}
                                    </button>
                                ))}
                            </span>

                            {/* U-3: per-Story Stop / Resume. A drained row gets no control —
                                it is already waiting, and the two moves above are its whole life. */}
                            <span className="story-row__controls" data-slot="controls">
                                {row.status === 'ready' || row.active_runs > 0 ? (
                                    <button
                                        type="button"
                                        className="button button--stop"
                                        title="halt dispatch and kill in-flight runs (P8)"
                                        onClick={() => void store.stop(row.id)}
                                    >
                                        Stop
                                    </button>
                                ) : null}
                                {row.status === 'stopped' ? (
                                    <button
                                        type="button"
                                        className="button button--resume"
                                        title="hand the Story back to the sweep (L-27)"
                                        onClick={() => void store.resume(row.id)}
                                    >
                                        Resume
                                    </button>
                                ) : null}
                                {row.status === 'pending' && row.pending_kind !== 'drained' ? (
                                    <button
                                        type="button"
                                        className="button button--ghost"
                                        title="drop the pending hold without changing the Goal"
                                        onClick={() => void store.clearPending(row.id)}
                                    >
                                        Clear
                                    </button>
                                ) : null}
                            </span>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

export default StoriesPanel;
