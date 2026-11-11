// §10.2 U-3 + U-11 — the top strip: the cord, and what the crews are doing in story terms.
//
// U-3: "one global Stop. Global Stop is the biggest button on the screen." The size is not
// decoration — P8 says the Author can always pull the cord, so the control must outrank
// everything else in the room, including the tempting click on a story row. `data-size="xl"`
// is what the stylesheet keys the dominance off, and what the test asserts.
//
// U-11: no "loop running ✓" spinner. The health line is STORY TEXT — the `progress` strings
// W4/W6 derive ("chapters drafted, hole in act 2, setups unpaid") — plus the counts of what
// needs the Author. An idle sweep therefore renders as nothing, which is correct: the loop
// being quiet is not news, and a spinner would be activity for its own sake.

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

export function TopBar() {
    const store = useDashboardStore();
    const { stories, error } = useDashboard();
    const counts = countWaits(stories);

    // U-11: the line is the most urgent story-shaped fact available. A stall outranks a
    // wait, a wait outranks activity — the Author reads the top strip once and knows whether
    // to act. `blocked_on` is the engine's one-line "what it is stuck on" (L-22's shape).
    const stalledRow = stories.find((row) => row.status === 'pending' && row.pending_kind === 'stalled');
    const workingRows = stories.filter((row) => row.active_runs > 0).slice(0, 2);
    const healthLine = stalledRow
        ? `${stalledRow.title}: ${stalledRow.status_reason || stalledRow.blocked_on || 'the loop stopped converging'}`
        : workingRows.length
          ? workingRows.map((row) => `${row.title}: ${row.progress || `${row.active_runs} crews on it`}`).join(' · ')
          : stories.length === 0
            ? 'no stories yet — write a Seed and the crews have something to work against'
            : 'no crew is working · the sweep will pick up anything you set ready';

    return (
        <header className="topbar">
            <div className="topbar__brand">
                <h1 className="topbar__title">Storyline</h1>
                {/* The pinned single-source version (vite.config.ts `__APP_VERSION__` define). */}
                <span className="topbar__version">v{__APP_VERSION__}</span>
            </div>

            {/* U-3: the biggest control in the shell. P8 — kills dispatch and in-flight runs
                for every Story that could still be moving; a stopped Story never auto-resumes. */}
            <button
                type="button"
                className="stop-all"
                data-size="xl"
                data-testid="global-stop"
                onClick={() => void store.stopAll()}
                title="Stop every Story now: no new dispatch, in-flight runs killed (P8)"
            >
                Stop everything
            </button>

            <p className="topbar__counts">
                {/* U-10's headline lives here too: the queue count is always reachable. */}
                <span className="count count--awaiting" data-tone="awaiting">
                    {counts.awaiting} awaiting you
                </span>
                <span className="count count--stalled" data-tone="stalled">
                    {counts.stalled} stuck
                </span>
                <span className="count count--working">{counts.working} working</span>
                <span className="count count--done">{counts.done} done</span>
            </p>

            {/* U-11: prose, never a spinner. No live-region role either — this is a status
                line, not a notification, and it must not announce on every sweep. */}
            <p className="topbar__health" data-testid="health-line">
                {healthLine}
            </p>

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
        </header>
    );
}

export default TopBar;
