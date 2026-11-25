// U-8 — the content area an employee tile opens: every thread that employee ever ran.
//
// VOCABULARY (V-1): the tile is an EMPLOYEE; each bar is a THREAD — the employee acting as an
// agent for one Run. The employee does not persist as an agent between threads: the thread is the
// execution, and its bar is the unit the Author judges.
//
// THE MODEL THIS RENDERS is the harness tree, not a flat log. A Story is the harness; each
// phrase is a phase session inside it; each Run (and each panel agent or delegate it spun) is one
// thread inside that session. The bars are grouped Story -> phrase (P1 Summary, P3 Plotlines,
// P4 Chapters), and inside a phrase they are oldest first, newest last. Nothing is pruned: a
// thread closed months ago is still here for revision.
//
// WHY THE DETAIL IS REQUEST + ANSWER, PLUS LIVE STEPS WHILE RUNNING: the reference harness UI
// has a clickable segment timeline; the Author does not need it here. The two things a thread is
// judged by are what it was asked and what it said, so a CLOSED bar shows exactly those two
// blocks. A RUNNING bar shows the same collapsed request and, below it, the steps the employee
// is taking right now; the answer replaces those steps the moment the thread closes. The kill
// control is part of that EXPANDED detail and never the collapsed bar: expanding is the
// confirmation, so a stray click on a bar cannot tear down a live run.
import '../styles/story.css';
import { useMemo, useState } from 'react';
import { PHASE_LABELS, PHASE_ORDER, formatElapsed } from './story-contract';
import { MarkdownText } from './MarkdownText';
import type { AgentThreadRecord } from '../api';
import type { StoryPhase } from '../../shared/types';

/**
 * The phase-session code the Author reads. The rail numbers the four reading phrases (1 Summary,
 * 2 Characters, 3 Plotlines, 4 Chapters); Characters has no loop session yet, so its threads do
 * not exist and the session codes skip P2.
 */
const PHASE_CODE: Record<StoryPhase, string> = {
    summary: 'P1',
    plotlines: 'P3',
    chapters: 'P4'
};

/** A closed-but-successful thread reads as "completed"; the engine's word stays in `data-state`. */
const STATE_LABEL: Record<AgentThreadRecord['state'], string> = {
    running: 'running',
    torn_down: 'completed',
    failed: 'failed',
    abandoned: 'abandoned'
};

/**
 * A thread that is not running now is ARCHIVED: completed (`torn_down`), failed, or abandoned.
 * The list is RUNNING-ONLY until the Author opts into that set with the tab beside the Story
 * title: clicking an employee answers "what is working now", and the closed threads the Story was
 * built out of stay one deliberate click away (U-7). The tab is never pressed on the Author's
 * behalf — nothing derives it from the data (U-22).
 */
function isArchived(thread: AgentThreadRecord): boolean {
    return thread.state !== 'running';
}

/**
 * U-7 — does this bar need a role chip? The surface is ALREADY the one employee the Author clicked
 * (the region is named "Writer threads", the tile is highlighted), so a bar that says `writer`
 * again is the same word three times on one screen. A chip that carries information the region
 * name does not — a panel sibling (`writer#agent_2`) or a delegated role (`researcher`) — stays.
 */
function isRedundantRole(roleName: string, kind: string): boolean {
    const role = roleName.trim();

    // A blank role would render an empty chip, and a role equal to the selected kind repeats it.
    return role.length === 0 || role === kind.trim();
}

interface PhaseGroup {
    phase: StoryPhase;
    threads: AgentThreadRecord[];
}

interface StoryGroup {
    storyId: string;
    storyTitle: string;
    startedAt: string;
    phases: PhaseGroup[];
}

/**
 * Story -> phrase -> thread, oldest first everywhere. The story groups are ordered by their
 * oldest thread, and phrases by the fixed P1/P3/P4 progression; a phrase's own threads are the
 * one place "oldest on top, newest at the bottom" is true of every bar.
 */ function groupThreads(threads: AgentThreadRecord[]): StoryGroup[] {
    const stories = new Map<
        string,
        { storyTitle: string; startedAt: string; phases: Map<StoryPhase, AgentThreadRecord[]> }
    >();

    for (const thread of threads) {
        let story = stories.get(thread.story_id);

        if (story === undefined) {
            story = { storyTitle: thread.story_title, startedAt: thread.started_at, phases: new Map() };
            stories.set(thread.story_id, story);
        }

        if (thread.started_at.localeCompare(story.startedAt) < 0) story.startedAt = thread.started_at;

        const phase = story.phases.get(thread.phase);

        if (phase === undefined) story.phases.set(thread.phase, [thread]);
        else phase.push(thread);
    }

    return [...stories.entries()]
        .sort((left, right) => left[1].startedAt.localeCompare(right[1].startedAt) || left[0].localeCompare(right[0]))
        .map(([storyId, story]) => ({
            storyId,
            storyTitle: story.storyTitle,
            startedAt: story.startedAt,
            phases: PHASE_ORDER.filter((phase) => story.phases.has(phase)).map((phase) => ({
                phase,
                threads: [...(story.phases.get(phase) ?? [])].sort(
                    (left, right) =>
                        left.started_at.localeCompare(right.started_at) || left.thread_id.localeCompare(right.thread_id)
                )
            }))
        }));
}

export interface AgentThreadsViewProps {
    /** The selected employee kind (`writer`, `editor`, …), used for the empty-state sentence. */
    kind: string;
    threads: AgentThreadRecord[];
    /** Injected so elapsed time is deterministic in tests (S-6: informational, never a limit). */
    now: string;
    /** P8/U-7 — the Author's cord for a live run; a panel's threads share the run it kills. */
    onKillRun?: (runId: string) => void;
}

export function AgentThreadsView({ kind, threads, now, onKillRun }: AgentThreadsViewProps) {
    const groups = useMemo(() => groupThreads(threads), [threads]);
    const [open, setOpen] = useState<Set<string>>(() => new Set());
    /** U-8: the request is collapsed by default, at every state — open the bar, then the block. */
    const [requests, setRequests] = useState<Set<string>>(() => new Set());
    /**
     * The Story ids whose archived threads the Author has OPTED INTO. Nothing is opted in at mount,
     * so the list reads as "what is working now" (U-7); the tab beside the title pulls the closed
     * threads in. This is view-local state that only the click below writes, so a refresh or a new
     * `threads` prop can never select Archived on the Author's behalf (U-22) — while an explicit
     * choice survives a same-Story refetch (U-22). Switching employees remounts the view (the shell
     * keys it by kind), which is what resets the choice per employee (U-7).
     */
    const [archivedShown, setArchivedShown] = useState<Set<string>>(() => new Set());

    const toggleArchived = (storyId: string): void => {
        setArchivedShown((current) => {
            const next = new Set(current);

            if (next.has(storyId)) next.delete(storyId);
            else next.add(storyId);

            return next;
        });
    };

    const toggle = (threadId: string): void => {
        setOpen((current) => {
            const next = new Set(current);

            if (next.has(threadId)) next.delete(threadId);
            else next.add(threadId);

            return next;
        });
    };

    const toggleRequest = (threadId: string): void => {
        setRequests((current) => {
            const next = new Set(current);

            if (next.has(threadId)) next.delete(threadId);
            else next.add(threadId);

            return next;
        });
    };

    return (
        <section className="sv-threads" data-testid="agent-threads" data-agent={kind} aria-label={`${kind} threads`}>
            {groups.map((story) => {
                const archivedCount = story.phases.reduce(
                    (count, group) => count + group.threads.filter(isArchived).length,
                    0
                );
                // U-7 — positive opt-in: `archivedShown` holds the Stories the Author has opened.
                // U-22 — the tab is a FILTER, not an addition: it answers one question at a time.
                // Unpressed the Story lists what is running now; pressed it lists only the closed
                // threads (torn_down / failed / abandoned). `isArchived` is the single predicate for
                // both branches, so a live bar can never sit in the Archived list and a closed one
                // can never leak into the live list — the rows are filtered in the DOM, not by CSS.
                const historyVisible = archivedShown.has(story.storyId);
                const wanted = historyVisible
                    ? isArchived
                    : (thread: AgentThreadRecord): boolean => !isArchived(thread);
                const phases = story.phases
                    .map((group) => ({ ...group, threads: group.threads.filter(wanted) }))
                    // A phrase with no row in this reading is not printed: an empty "P1 Summary —
                    // 0 threads" heading would be a second way of saying "nothing here".
                    .filter((group) => group.threads.length > 0);

                return (
                    <div className="sv-threads__story" data-story={story.storyId} key={story.storyId}>
                        <div className="sv-threads__story-head">
                            <h3 className="sv-threads__story-title">{story.storyTitle}</h3>
                            <button
                                type="button"
                                className="sv-threads__archive-tab"
                                aria-pressed={historyVisible}
                                data-active={historyVisible ? 'true' : 'false'}
                                title={
                                    historyVisible
                                        ? 'Hide the completed, failed and abandoned threads again — show only what is running now'
                                        : 'Show the completed, failed and abandoned threads'
                                }
                                onClick={() => toggleArchived(story.storyId)}
                            >
                                Archived
                                <span className="sv-threads__archive-count">{archivedCount}</span>
                            </button>
                        </div>

                        {/* U-22 — this sentence is an answer about the LIVE list, so it belongs to the
                            live branch only. An Archived reading with nothing to show (a Story whose
                            only thread is still running) is simply blank: "no thread is running now"
                            would be false on the screen that is showing a running employee. */}
                        {!historyVisible && phases.length === 0 ? (
                            <p className="sv-threads__empty">
                                no thread is running now — {archivedCount} archived thread
                                {archivedCount === 1 ? ' is' : 's are'} hidden.
                            </p>
                        ) : null}

                        {phases.map((group) => (
                            <section
                                className="sv-threads__phase"
                                data-phase={group.phase}
                                key={`${story.storyId}:${group.phase}`}
                            >
                                <h4 className="sv-threads__phase-title">
                                    <span className="sv-threads__phase-code">{PHASE_CODE[group.phase]}</span>
                                    {PHASE_LABELS[group.phase]}
                                    <span className="sv-threads__phase-count">
                                        {group.threads.length} thread{group.threads.length === 1 ? '' : 's'}
                                    </span>
                                </h4>

                                <ul className="sv-thread-list">
                                    {group.threads.map((thread) => {
                                        const expanded = open.has(thread.thread_id);
                                        const requestVisible = requests.has(thread.thread_id);
                                        const code = PHASE_CODE[thread.phase];
                                        // U-7 — the chip repeats the employee only when it repeats it
                                        // exactly; see `isRedundantRole`.
                                        const roleVisible = !isRedundantRole(thread.role_name, kind);
                                        const duration = formatElapsed(thread.started_at, thread.ended_at, now);
                                        const answerText =
                                            thread.answer.length > 0
                                                ? thread.answer
                                                : thread.error !== undefined
                                                  ? thread.state === 'abandoned'
                                                      ? `the thread was abandoned before answering: ${thread.error}`
                                                      : `the thread failed before answering: ${thread.error}`
                                                  : 'no answer was recorded.';

                                        return (
                                            <li
                                                className="sv-thread"
                                                data-state={thread.state}
                                                data-retained={thread.retained ? 'true' : 'false'}
                                                key={thread.thread_id}
                                            >
                                                <button
                                                    type="button"
                                                    className="sv-thread__bar"
                                                    aria-expanded={expanded}
                                                    onClick={() => toggle(thread.thread_id)}
                                                >
                                                    <span className="sv-thread__code">{code}</span>
                                                    <span className="sv-thread__title">
                                                        {thread.title.length > 0 ? thread.title : thread.role_name}
                                                    </span>
                                                    {/* U-7 — the region is already "Writer threads" and the
                                                        tile is lit, so a bar reading `writer` again is the
                                                        same word three times. The chip is dropped ONLY for
                                                        that repeat (and for a blank role); a panel sibling
                                                        (`writer#agent_2`) or a delegated role still shows.
                                                        A bar with no title still falls back to `role_name`
                                                        above, so the row is never nameless. */}
                                                    {roleVisible ? (
                                                        <span className="sv-thread__role">{thread.role_name}</span>
                                                    ) : null}
                                                    <span
                                                        className="sv-thread__duration"
                                                        title="wall-clock, informational only (S-6, E-0)"
                                                    >
                                                        {duration}
                                                    </span>
                                                    <span className="sv-thread__tokens">
                                                        {thread.tokens.toLocaleString('en-US')} tokens
                                                    </span>
                                                    <span
                                                        className={`sv-thread__state sv-thread__state--${thread.state}`}
                                                    >
                                                        {STATE_LABEL[thread.state]}
                                                    </span>
                                                </button>

                                                {/* R4 — the running thread's cord used to sit in its
                                                    own row under the COLLAPSED bar, where it was one
                                                    stray click from tearing down live work. Nothing
                                                    renders here now; the button lives inside
                                                    `sv-thread__detail` below, so a closed bar has no
                                                    kill affordance at all. */}
                                                {expanded ? (
                                                    <div className="sv-thread__detail">
                                                        <section className="sv-thread__block">
                                                            <button
                                                                type="button"
                                                                className="sv-thread__block-toggle"
                                                                aria-expanded={requestVisible}
                                                                onClick={() => toggleRequest(thread.thread_id)}
                                                            >
                                                                <span className="sv-thread__block-title">Request</span>
                                                                <span
                                                                    className="sv-thread__block-caret"
                                                                    aria-hidden="true"
                                                                >
                                                                    {requestVisible ? '▾' : '▸'}
                                                                </span>
                                                            </button>
                                                            {requestVisible ? (
                                                                <div className="sv-thread__text">
                                                                    <MarkdownText>{thread.request}</MarkdownText>
                                                                </div>
                                                            ) : null}
                                                        </section>

                                                        {/* P8 / U-7 — the Author's cord, now a sibling
                                                            of the Request block INSIDE the expanded
                                                            detail (R4). R5: the click calls
                                                            `onKillRun` once, immediately, with this
                                                            thread's run id — no confirmation and no
                                                            second-step arming, because there never
                                                            was one. R6: with no cord injected the
                                                            button stays disabled rather than hidden,
                                                            and a thread that is not running gets no
                                                            button at all. */}
                                                        {thread.state === 'running' ? (
                                                            <div className="sv-thread__actions">
                                                                <button
                                                                    type="button"
                                                                    className="sv-thread__kill"
                                                                    disabled={onKillRun === undefined}
                                                                    title="Tear this run down; the Story keeps running (P8, U-7, S-3)"
                                                                    onClick={() => onKillRun?.(thread.run_id)}
                                                                >
                                                                    kill run
                                                                </button>
                                                            </div>
                                                        ) : null}

                                                        {thread.state === 'running' ? (
                                                            /* U-8 — below the collapsed request: what the employee is
                                                           doing at this moment. The answer lands when the thread
                                                           closes, and this block is what it replaces. */
                                                            <section
                                                                className="sv-thread__block sv-thread__block--live"
                                                                aria-label="Happening now"
                                                            >
                                                                <h5 className="sv-thread__block-title">
                                                                    Happening now
                                                                </h5>
                                                                {thread.activity !== undefined &&
                                                                thread.activity.length > 0 ? (
                                                                    <ol className="sv-thread__activity">
                                                                        {thread.activity.map((step, index) => (
                                                                            <li
                                                                                className="sv-thread__activity-step"
                                                                                key={`${step.at}:${index}`}
                                                                            >
                                                                                <span className="sv-thread__activity-elapsed">
                                                                                    +
                                                                                    {formatElapsed(
                                                                                        thread.started_at,
                                                                                        step.at,
                                                                                        now
                                                                                    )}
                                                                                </span>
                                                                                <span className="sv-thread__activity-text">
                                                                                    {step.text}
                                                                                </span>
                                                                            </li>
                                                                        ))}
                                                                        <li className="sv-thread__activity-step sv-thread__activity-step--live">
                                                                            <span
                                                                                className="sv-thread__activity-elapsed"
                                                                                aria-hidden="true"
                                                                            >
                                                                                ···
                                                                            </span>
                                                                            <span className="sv-thread__activity-text">
                                                                                working…
                                                                            </span>
                                                                        </li>
                                                                    </ol>
                                                                ) : (
                                                                    <p className="sv-thread__activity-empty">
                                                                        the thread is working — no step has landed yet.
                                                                    </p>
                                                                )}
                                                            </section>
                                                        ) : (
                                                            <section className="sv-thread__block">
                                                                <h5 className="sv-thread__block-title">Answer</h5>
                                                                <div className="sv-thread__text">
                                                                    <MarkdownText>{answerText}</MarkdownText>
                                                                </div>
                                                            </section>
                                                        )}
                                                    </div>
                                                ) : null}
                                            </li>
                                        );
                                    })}
                                </ul>
                            </section>
                        ))}
                    </div>
                );
            })}
        </section>
    );
}

export default AgentThreadsView;
