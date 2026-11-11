// U-17 / D-37 / D-37a — the prose editor: the Author writes the book, and the pause is the price.
//
// D-37 is the rule the whole pane is built around: the chapter editor is live ONLY while the
// Story is `stopped`, and the single action that opens it is **Pause & edit**, which stops
// dispatch, kills in-flight runs (P8) and then unlocks the prose. An edit attempted against a
// RUNNING Story is refused by the server naming D-37 (T-1a) — so the Save control stays live
// while running and the refusal is surfaced, because §15 step 4b makes "attempting the same edit
// without pausing is refused naming D-37" an acceptance condition. A UI that pre-empts the
// server with a disabled button hides the rule it exists to teach.
//
// U-17's copy requirements are literal, so they are rendered literally:
//   - Pause & edit states its cost: runs killed, dispatch halted.
//   - While paused the pane says so at the top: "paused by you · N runs stopped".
//   - Resume states what the edit will trigger: Digest re-derived, N dependents rechecked
//     (D-37a) — N comes from the Story's declared dependency set (L-9), which is exactly the set
//     propagation runs over (L-11a), and falls back to the generic line when the set is empty.
//
// P9 / T-2: a section the Author wrote is marked, because from that point agents may only
// `proposeChange` against it — the mark is the Author seeing their own handwriting protected.
import { useState } from 'react';
import { pendingProposalsFor } from './story-contract';
import { ProposalRow } from './story-proposal-row';
import type { Chapter, Proposal, Story } from '../../shared/types';

export interface ProseEditorProps {
    chapter: Chapter;
    story: Story;
    /** D-37: the prose is live only while the Story is `stopped`. */
    paused: boolean;
    /** U-17's banner count — the runs the pause actually stopped (S-3 records why each run ended). */
    killedRuns: number;
    /** Live runs, i.e. the ones Pause & edit will kill (P8). */
    liveRuns: number;
    /** L-9: this chapter's declared dependents — the set D-37a's recheck walks. */
    dependents: string[];
    /** Pending proposals against this chapter, rendered inline as diffs (U-5). */
    proposals: Proposal[];
    onEditSection?: (input: {
        storyId: string;
        chapterId: string;
        sectionId: string;
        text: string;
    }) => Promise<unknown> | unknown;
    onPauseAndEdit?: () => Promise<unknown> | unknown;
    onResume?: () => Promise<unknown> | unknown;
    onAcceptProposal?: (proposalId: string) => Promise<unknown> | unknown;
    onRejectProposal?: (proposalId: string) => Promise<unknown> | unknown;
    onUndo?: (input: { targetRef: string; runRef?: string | null }) => Promise<unknown> | unknown;
}

export function ProseEditor({
    chapter,
    story,
    paused,
    killedRuns,
    liveRuns,
    dependents,
    proposals,
    onEditSection,
    onPauseAndEdit,
    onResume,
    onAcceptProposal,
    onRejectProposal,
    onUndo
}: ProseEditorProps) {
    // Drafts are per-section and local: the store is the only memory (P1), so an unsaved draft
    // is scratch, never a record.
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    // T-1a: a refusal naming the rule is the Author's information, so it is shown, not swallowed.
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState<string | null>(null);

    const pending = pendingProposalsFor(chapter, proposals);

    const saveSection = async (sectionId: string): Promise<void> => {
        if (!onEditSection) {
            return;
        }
        try {
            setError(null);
            setSaved(null);
            await onEditSection({ storyId: story.id, chapterId: chapter.id, sectionId, text: drafts[sectionId] ?? '' });
            setSaved(sectionId);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    };

    return (
        <section
            className={`sv-prose${paused ? ' sv-prose-paused' : ' sv-prose-running'}`}
            aria-label={`Prose — ${chapter.title}`}
        >
            <header className="sv-prose-head">
                <h4 className="sv-prose-title">
                    Ch {chapter.order} — {chapter.title}
                </h4>
                <span className="sv-prose-state">{chapter.state}</span>
                {/* P6 / §4.4: `n/m criteria passed` is rendered, never turned into a score. */}
                {chapter.last_score ? <span className="sv-prose-score">{chapter.last_score}</span> : null}
                <span className="sv-prose-round">round {chapter.round}</span>
                {chapter.bar_override ? <span className="sv-prose-bar">bar: {chapter.bar_override}</span> : null}
            </header>

            {paused ? (
                // U-17: a Story that looks idle and is being edited by hand is a different thing
                // from one the crew has drained (U-1c), so the pane has to say which it is.
                <p className="sv-prose-banner">
                    paused by you · {killedRuns} run{killedRuns === 1 ? '' : 's'} stopped — the crew picks the book up
                    exactly where it stands when you resume (D-37b)
                </p>
            ) : (
                <p className="sv-prose-locked">
                    {/* The rule stated before the exception: writing now loses to a machine that retries instantly (D-37). */}
                    The Story is running, so the prose is read-only: a write now is refused naming D-37, because a
                    paragraph half-replaced by each side is the corruption the pause exists to prevent.
                </p>
            )}

            <ul className="sv-sections">
                {chapter.sections.map((section) => {
                    const draft = drafts[section.id] ?? section.text;
                    const dirty = drafts[section.id] !== undefined && draft !== section.text;

                    return (
                        <li
                            className={`sv-section${section.origin === 'author' ? ' sv-section-author' : ''}`}
                            key={section.id}
                        >
                            <div className="sv-section-head">
                                <span className="sv-section-id">{section.id}</span>
                                {section.origin === 'author' ? (
                                    // P9 / T-2: the Author's own span, protected at section granularity.
                                    <span className="sv-section-origin">
                                        you wrote this · agents may only propose against it (P9)
                                    </span>
                                ) : (
                                    <span className="sv-section-origin sv-section-origin-writer">
                                        the Writer wrote this
                                    </span>
                                )}
                                {dirty ? <span className="sv-section-dirty">unsaved</span> : null}
                                {saved === section.id ? <span className="sv-section-saved">saved</span> : null}
                            </div>

                            {/* D-7: the section is the addressable unit, so the editor is one textarea per section.
                                `readOnly` while running makes the lock visible without pretending the save is impossible. */}
                            <textarea
                                className="sv-section-text"
                                rows={6}
                                readOnly={!paused}
                                aria-label={`Section ${section.id}`}
                                value={draft}
                                onChange={(event) =>
                                    setDrafts((current) => ({ ...current, [section.id]: event.target.value }))
                                }
                            />

                            <div className="sv-section-actions">
                                <button
                                    type="button"
                                    className="sv-section-save"
                                    disabled={!onEditSection}
                                    // U-16's discipline, applied here: a disabled control names its blocker.
                                    title={
                                        onEditSection
                                            ? 'Save this section as a direct Author write (D-20a)'
                                            : 'Section writes land with the API (D-37)'
                                    }
                                    onClick={() => void saveSection(section.id)}
                                >
                                    Save section
                                </button>
                                {/* P11: for any paragraph, the Author can see which run changed it and why. */}
                                {section.last_run_ref || section.last_why ? (
                                    <span className="sv-section-why">
                                        last change — {section.last_run_ref || 'the Author'}
                                        {section.last_why ? ` · why: ${section.last_why}` : ''}
                                    </span>
                                ) : null}
                            </div>
                        </li>
                    );
                })}
            </ul>

            {error ? (
                // D-37's refusal, surfaced (T-1a): the message names the rule and the artifact.
                <p className="sv-prose-error" role="alert">
                    The server refused this write: {error}
                </p>
            ) : null}

            {pending.length > 0 ? (
                // U-5: proposals are how an agent touches this prose — and they ride inline.
                <div className="sv-prose-proposals">
                    <h5 className="sv-prose-proposals-title">
                        Proposals against this chapter ({pending.length}) — a diff, not a replacement (U-5)
                    </h5>
                    <ul className="sv-proposals">
                        {pending.map((proposal) => {
                            const section = chapter.sections.find((candidate) => candidate.id === proposal.target_ref);
                            return (
                                <ProposalRow
                                    key={proposal.id}
                                    proposal={proposal}
                                    currentText={section ? section.text : ''}
                                    targetLabel={section ? `section ${section.id}` : chapter.title}
                                    onAccept={onAcceptProposal}
                                    onReject={onRejectProposal}
                                    onUndo={onUndo}
                                />
                            );
                        })}
                    </ul>
                </div>
            ) : null}

            <footer className="sv-prose-controls">
                {paused ? (
                    <button
                        type="button"
                        className="sv-prose-resume"
                        disabled={!onResume}
                        // D-37a: Resume is the hand-back, and the pane states what the hand-back triggers.
                        title={
                            dependents.length > 0
                                ? `Resume re-arms the Story and processes your edit as a commit: the Digest is re-derived from it (D-12a) and ${dependents.length} dependent chapter${dependents.length === 1 ? '' : 's'} (${dependents.join(', ')}) are marked needs_recheck (D-37a, L-11a).`
                                : 'Resume re-arms the Story and processes your edit as a commit: the Digest is re-derived from it (D-12a) and its dependents are marked needs_recheck (D-37a, L-11a). No dependents are declared for this chapter (L-9).'
                        }
                        onClick={() => void onResume?.()}
                    >
                        {dependents.length > 0
                            ? `Resume — the Digest is re-derived and ${dependents.length} dependent chapter${dependents.length === 1 ? '' : 's'} marked for recheck (D-37a)`
                            : 'Resume — the Digest is re-derived and its dependents are rechecked (D-37a)'}
                    </button>
                ) : (
                    <button
                        type="button"
                        className="sv-prose-pause"
                        disabled={!onPauseAndEdit}
                        title="Stops dispatch, kills the in-flight runs, then unlocks the prose (D-37). The crew never auto-resumes (P8)."
                        onClick={() => void onPauseAndEdit?.()}
                    >
                        {/* U-17: the button states the price on its face, not in a tooltip. */}
                        {`Pause & edit — kills ${liveRuns} running run${liveRuns === 1 ? '' : 's'} and halts dispatch (D-37)`}
                    </button>
                )}
            </footer>
        </section>
    );
}
