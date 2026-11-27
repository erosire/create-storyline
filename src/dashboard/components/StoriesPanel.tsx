// §10.2 U-1 / U-1b / U-1c / U-2 / U-3 / U-12a — the STORIES region.
//
// ONE JOB: name the Story and say whether it needs the Author. The levels, the phase strip, the
// trend and the status_reason used to sit on this row; they made a navigation list read like a
// report, and the Author had to parse every Story before choosing one. The row now carries one
// attention mark, and the phrase rail inside the open Story says WHICH artifact needs the Author
// (see `story-nav.ts:storyAttention` and `StoryOutline`). The detail is still server-owned; the
// rail only points at the pane where the decision lives.
//
// THE ONE SORT RULE (U-1): Stories waiting on the Author sort to the top — they are the ones only
// the Author can move. Everything else is a tie-break: awaiting → stalled → ready → stopped →
// completed.
//
// THE TWO TONES (U-1b / L-34): `data-tone` is the whole mechanism — `awaiting` is calm, `stalled`
// is urgent, and the stylesheet makes them a different colour AND weight so the difference
// survives a monochrome screen.

import { useDashboard, useDashboardStore } from '../state';
import type { StoryRow } from '../api';
import type { PendingKind, StoryStatus } from '../../types';
import { ConfirmButton } from './story-phase-controls';

/** U-1's status badge — the §4.1 enum values verbatim, because the Author learns these words. */
const STATUS_LABELS: Record<StoryStatus, string> = {
    ready: 'ready',
    pending: 'pending',
    completed: 'completed',
    stopped: 'stopped'
};

/** The one sentence a waiting Story needs on the row; the "where" is the rail's job. */
const ATTENTION_LABELS: Record<Exclude<PendingKind, 'none'>, { label: string; tone: RowAttentionTone }> = {
    phase_signoff: { label: 'needs your signature', tone: 'awaiting' },
    idea_selection: { label: 'needs your pick', tone: 'awaiting' },
    finding_approval: { label: 'needs your approval', tone: 'awaiting' },
    drained: { label: 'leftovers need you', tone: 'finished' },
    stalled: { label: 'stuck', tone: 'stalled' }
};

/**
 * U-1c's leftovers sentence. W3/L-22 make `status_reason` name the specifics ("C-4 has failed on
 * chapters 6–9 for 11 rounds…"), and a drained Story's triage line is still the server's. The row
 * no longer prints it; this export is kept for callers that need the server's own words.
 */
export function waitSentence(row: StoryRow): string {
    if (row.pending_kind === 'drained') {
        return row.status_reason || 'no critical or major left · nothing awaiting you above the dial';
    }
    return row.status_reason || '';
}

/**
 * L-34's two colours plus the finished drained state. `awaiting` covers every by-design wait;
 * `stalled` is the only flavour that means trouble (P14).
 */
export type PendingTone = 'awaiting' | 'stalled' | 'running' | 'halted' | 'done';
export type RowAttentionTone = 'awaiting' | 'stalled' | 'finished';

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

/** The one mark a Story row paints when it is waiting on the Author. */
export function rowAttention(row: StoryRow): { label: string; tone: RowAttentionTone } | undefined {
    if (row.status !== 'pending' || row.pending_kind === 'none') {
        return undefined;
    }

    return ATTENTION_LABELS[row.pending_kind];
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

export function StoriesPanel() {
    const store = useDashboardStore();
    const { stories, storiesHasMore, activeStoryId, selectedAgent } = useDashboard();
    const ordered = sortStories(stories);

    return (
        <div className="panel panel--stories" data-testid="stories-panel">
            <h2 className="panel__title">Stories</h2>

            {ordered.length === 0 ? (
                <p className="panel__empty">no stories · write a Seed in Create New Story</p>
            ) : null}

            <ul className="story-list">
                {ordered.map((row) => {
                    const tone = pendingTone(row);
                    const active = row.id === activeStoryId;
                    const attention = rowAttention(row);

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
                            {/* U-1 / U-4: one navigation target; the open Story is a toggle. */}
                            <button
                                type="button"
                                className="story-row__open"
                                data-testid="story-row-open"
                                onClick={() => {
                                    if (active) {
                                        // An employee's thread surface sits over the Story; the
                                        // first click on the active Story brings the Story back.
                                        // A second click (no employee open) closes it as before.
                                        if (selectedAgent) {
                                            void store.selectAgent(null);
                                            return;
                                        }

                                        store.closeStory();
                                        return;
                                    }

                                    void store.openStory(row.id);
                                }}
                                aria-current={active ? 'true' : undefined}
                                title={
                                    active
                                        ? selectedAgent
                                            ? `back to ${row.title}`
                                            : `close ${row.title}`
                                        : attention
                                          ? `${row.title} — ${attention.label}`
                                          : `open ${row.title}`
                                }
                            >
                                <span className="story-row__title">{row.title}</span>
                                {attention ? (
                                    <span className="story-row__attention" data-tone={attention.tone}>
                                        {attention.label}
                                    </span>
                                ) : (
                                    <span className={`badge badge--${row.status}`} data-tone={tone}>
                                        {STATUS_LABELS[row.status]}
                                    </span>
                                )}
                            </button>

                            {/* U-3 / P1: the row is navigation; its controls are for the Story the
                                Author has actually opened. A closed Story needs no Stop/Delete row. */}
                            {active ? (
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
                                    {/* §10 / P1: deleting the Story deletes its harness — every record,
                                        the knowledge directory, its sessions and its threads. */}
                                    <ConfirmButton
                                        className="button button--delete"
                                        label="Delete"
                                        confirmText={`Delete "${row.title}" and everything it owns — every record, its knowledge, sessions and threads? This cannot be undone.`}
                                        onConfirm={() => void store.deleteStory(row.id)}
                                    />
                                </span>
                            ) : null}
                        </li>
                    );
                })}
            </ul>

            {storiesHasMore ? (
                <button
                    type="button"
                    className="button button--ghost panel__more"
                    data-testid="stories-load-more"
                    onClick={() => void store.loadMoreStories()}
                >
                    Load more stories
                </button>
            ) : null}
        </div>
    );
}

export default StoriesPanel;
