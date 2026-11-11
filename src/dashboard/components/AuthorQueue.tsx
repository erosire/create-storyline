// §10.2 U-10 / U-10a / U-10b — THE AUTHOR'S QUEUE, the home screen.
//
// WHY THIS SCREEN EXISTS (D-34): the approval gate is the one place the loop deliberately
// waits for a human, so the human's desk is the product's front page. Confirmed findings
// awaiting approval, Ideas awaiting a pick, escalations, and tool-gap requests, aggregated
// across every Story ("3 stories need you").
//
// U-10a — a finding reads as the EDITOR wrote it (D-34a's rewrite is final, no appeal), with
// the evidence line (D-15/T-11: no finding without a citable line) and the cost it deserves.
// The queue item carries the server's projection of exactly those three things; this
// component adds nothing to the wording.
//
// U-10b — approval is PROGRESSIVE. There is deliberately no "approve all" HERE: a batch button
// on the cross-Story desk would be the machine quietly starting Writers on the Author's behalf.
// The dial in the Story view (U-10a) is the one-click-per-CLASS control; this list is
// one-click-per-item. U-10b's third move — "approve a whole chapter's worth" — is on the chapter
// row in PlotlineChapters, where the Author is looking at exactly that chapter's findings.

import { useDashboard, useDashboardStore } from '../state';
import type { QueueItem } from '../api';

/** One click, one decision. `why` is the audit line P11 demands on every write (T-5). */
const APPROVE_WHY = 'approved from the queue by the Author';
const DISCARD_WHY = 'discarded from the queue by the Author';
const SELECT_NOTE = 'selected from the queue by the Author';

/** Heading copy: U-10's "3 stories need you", with the singular handled honestly. */
export function queueHeadline(groupCount: number): string {
    if (groupCount === 0) {
        return 'nothing needs you';
    }
    return `${groupCount} ${groupCount === 1 ? 'story' : 'stories'} need you`;
}

/** U-10 grouping — one section per Story, in first-seen queue order (the server's triage). */
export function groupByStory(items: QueueItem[]): Array<{ storyId: string; storyTitle: string; items: QueueItem[] }> {
    const groups: Array<{ storyId: string; storyTitle: string; items: QueueItem[] }> = [];
    for (const item of items) {
        const existing = groups.find((group) => group.storyId === item.story_id);
        if (existing) {
            existing.items.push(item);
        } else {
            groups.push({ storyId: item.story_id, storyTitle: item.story_title, items: [item] });
        }
    }
    return groups;
}

export function AuthorQueue() {
    const store = useDashboardStore();
    const { queue, queueStoryFilter } = useDashboard();
    const visible = queueStoryFilter ? queue.filter((item) => item.story_id === queueStoryFilter) : queue;
    const groups = groupByStory(visible);

    if (groups.length === 0) {
        // U-10's empty state, in plain words. Not "all clear" — the loop always finds
        // something eventually (L-25b), so an empty desk is a moment, not a status.
        return (
            <div className="queue" data-testid="author-queue">
                <p className="queue__empty">nothing needs you</p>
            </div>
        );
    }

    return (
        <div className="queue" data-testid="author-queue">
            <div className="queue__head">
                <h2 className="queue__headline" data-testid="queue-headline">
                    {queueHeadline(groups.length)}
                </h2>
                <p className="queue__hint">
                    one click, one decision — approving is what starts a Writer (D-34), and the loop keeps finding more
                    underneath you (L-25b).
                </p>
                {queueStoryFilter ? (
                    <button type="button" className="button button--ghost" onClick={() => store.setQueueFilter(null)}>
                        every story
                    </button>
                ) : null}
            </div>

            {groups.map((group) => (
                <section
                    key={group.storyId}
                    className="queue-group"
                    data-story={group.storyId}
                    data-testid="queue-group"
                >
                    <h3 className="queue-group__title">
                        <button
                            type="button"
                            className="queue-group__link"
                            onClick={() => void store.openStory(group.storyId)}
                        >
                            {group.storyTitle}
                        </button>
                        <span className="queue-group__count">{group.items.length}</span>
                    </h3>

                    <ul className="queue-list">
                        {group.items.map((item) => (
                            <li
                                key={`${item.kind}:${item.id}`}
                                className="queue-item"
                                data-kind={item.kind}
                                data-cost={item.cost ?? ''}
                            >
                                {item.kind === 'finding' ? (
                                    <>
                                        {/* U-10a: claim · evidence · cost · two buttons. */}
                                        <h4 className="queue-item__claim">{item.title}</h4>
                                        {item.detail ? <p className="queue-item__detail">{item.detail}</p> : null}
                                        <p className="queue-item__evidence">
                                            <span className="queue-item__evidence-label">evidence</span>
                                            <span className="queue-item__evidence-text">{item.evidence}</span>
                                        </p>
                                        <p className="queue-item__meta">
                                            <span className="cost-chip" data-cost={item.cost ?? ''}>
                                                {item.cost ?? 'unpriced'}
                                            </span>
                                            {item.cost ? (
                                                <span className="queue-item__dial-note">
                                                    the dial on this Story decides whether you see the next one
                                                </span>
                                            ) : null}
                                        </p>
                                        <span className="queue-item__actions">
                                            <button
                                                type="button"
                                                className="button button--approve"
                                                onClick={() =>
                                                    void store.approveFinding(item.story_id, item.id, APPROVE_WHY)
                                                }
                                            >
                                                Approve
                                            </button>
                                            <button
                                                type="button"
                                                className="button button--discard"
                                                onClick={() =>
                                                    void store.discardFinding(item.story_id, item.id, DISCARD_WHY)
                                                }
                                            >
                                                Discard
                                            </button>
                                        </span>
                                    </>
                                ) : null}

                                {item.kind === 'idea' ? (
                                    <>
                                        {/* U-15's decisions, surfaced without leaving the desk. */}
                                        <h4 className="queue-item__claim">{item.title}</h4>
                                        {item.detail ? <p className="queue-item__detail">{item.detail}</p> : null}
                                        <p className="queue-item__evidence">
                                            <span className="queue-item__evidence-label">
                                                {item.evidence ? 'Editor verdict' : 'unverified'}
                                            </span>
                                            <span className="queue-item__evidence-text">{item.evidence}</span>
                                        </p>
                                        <span className="queue-item__actions">
                                            <button
                                                type="button"
                                                className="button button--select"
                                                onClick={() =>
                                                    void store.selectIdea(item.story_id, item.id, SELECT_NOTE)
                                                }
                                            >
                                                Select
                                            </button>
                                            <button
                                                type="button"
                                                className="button button--discard"
                                                onClick={() => void store.discardIdea(item.story_id, item.id)}
                                            >
                                                Discard
                                            </button>
                                            <button
                                                type="button"
                                                className="button button--ghost"
                                                onClick={() => void store.deferIdea(item.story_id, item.id)}
                                            >
                                                Defer
                                            </button>
                                        </span>
                                    </>
                                ) : null}

                                {item.kind === 'escalation' ? (
                                    <>
                                        {/* P7: the loop parks a QUESTION here, it does not go quiet. */}
                                        <h4 className="queue-item__question">{item.title}</h4>
                                        {item.detail ? <p className="queue-item__detail">{item.detail}</p> : null}
                                        {item.evidence ? (
                                            <p className="queue-item__evidence">
                                                <span className="queue-item__evidence-label">what it saw</span>
                                                <span className="queue-item__evidence-text">{item.evidence}</span>
                                            </p>
                                        ) : null}
                                        <span className="queue-item__actions">
                                            <button
                                                type="button"
                                                className="button button--move"
                                                onClick={() => void store.openStory(item.story_id)}
                                            >
                                                answer in the story
                                            </button>
                                        </span>
                                    </>
                                ) : null}

                                {item.kind === 'tool_gap' ? (
                                    <>
                                        {/* T-6c / T-12: a brief asked for an action no tool backs,
                                            so it asked rather than improvising (the named hole). */}
                                        <h4 className="queue-item__claim">a crew asked for a tool it does not have</h4>
                                        <p className="queue-item__detail">{item.title}</p>
                                        {item.detail ? <p className="queue-item__detail">{item.detail}</p> : null}
                                        {item.evidence ? (
                                            <p className="queue-item__evidence">
                                                <span className="queue-item__evidence-label">wanted for</span>
                                                <span className="queue-item__evidence-text">{item.evidence}</span>
                                            </p>
                                        ) : null}
                                        <span className="queue-item__actions">
                                            <button
                                                type="button"
                                                className="button button--move"
                                                onClick={() => void store.openStory(item.story_id)}
                                            >
                                                open the template
                                            </button>
                                        </span>
                                    </>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                </section>
            ))}
        </div>
    );
}

export default AuthorQueue;
