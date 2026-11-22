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
// is taking right now; the answer replaces those steps the moment the thread closes.
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
 * The Author's tab beside the Story title toggles that set, so the list can read as "what is
 * working now" without losing the closed threads the Story was built out of.
 */
function isArchived(thread: AgentThreadRecord): boolean {
    return thread.state !== 'running';
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
     * The Story ids whose archived threads the Author has folded away. Archived threads are shown
     * by default — the Story's history is the point of this surface — and the tab beside the title
     * hides them so the list reads as the threads working right now.
     */
    const [archivedHidden, setArchivedHidden] = useState<Set<string>>(() => new Set());

    const toggleArchived = (storyId: string): void => {
        setArchivedHidden((current) => {
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
                const archivedShown = !archivedHidden.has(story.storyId);
                const phases = archivedShown
                    ? story.phases
                    : story.phases
                          .map((group) => ({
                              ...group,
                              threads: group.threads.filter((thread) => !isArchived(thread))
                          }))
                          .filter((group) => group.threads.length > 0);

                return (
                    <div className="sv-threads__story" data-story={story.storyId} key={story.storyId}>
                        <div className="sv-threads__story-head">
                            <h3 className="sv-threads__story-title">{story.storyTitle}</h3>
                            <button
                                type="button"
                                className="sv-threads__archive-tab"
                                aria-pressed={archivedShown}
                                data-active={archivedShown ? 'true' : 'false'}
                                title={
                                    archivedShown
                                        ? 'Hide the completed, failed and abandoned threads — show only what is running now'
                                        : 'Show the completed, failed and abandoned threads again'
                                }
                                onClick={() => toggleArchived(story.storyId)}
                            >
                                Archived
                                <span className="sv-threads__archive-count">{archivedCount}</span>
                            </button>
                        </div>

                        {phases.length === 0 ? (
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
                                                    <span className="sv-thread__role">{thread.role_name}</span>
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
