// U-4 / decision 0/5 / L-8 — plotlines and chapters, side by side, grouped by what the crews
// are doing to them.
//
// "Plotlines and chapters are shown side by side — the contract next to the prose — because the
// whole product is the distance between them" (U-4). Every row is therefore one chapter and its
// own plotline: P4's question ("does this artifact deliver its contract?") is only answerable on
// a screen where both are visible at once.
//
// Decision 0/5 is the layout rule: with all chapters in flight together (L-8), ORDER is no
// longer what is happening, so the chapter set is grouped by what the crews are doing to it —
// contested / awaiting a fix / drafting / clean. Group order is fixed (see `ACTIVITY_ORDER`) so
// the screen does not reshuffle itself on every sweep.
//
// §14 item 11 is the one per-chapter verb worth a button: the Author can UNAPPROVE a single
// chapter — keep its prose, reopen its review — which is a different verb from backtrack, and
// the only case where one chapter legitimately sits at a different vintage than its neighbours.
import { RevisionsCompare } from './RevisionsCompare';
import { ProseEditor } from './ProseEditor';
import {
    ACTIVITY_LABELS,
    buildRevisionUnits,
    competingRevisionsFor,
    groupChapters,
    undoTargetFor
} from './story-contract';
import type { StoryActions, StoryViewData } from './story-contract';
import type { Chapter, Plotline } from '../../shared/types';

/** The plotline that governs one chapter (D-4: every artifact names the one above it). */
function plotlineFor(chapter: Chapter, plotlines: Plotline[]): Plotline | undefined {
    return (
        plotlines.find((plotline) => plotline.id === chapter.plotline_ref) ??
        // A chapter that names no plotline is a C-1 failure; match on the reverse ref so the
        // contract still renders (C-1 is the loop's problem, not a reason to blind the Author).
        plotlines.find((plotline) => plotline.chapter_ref === chapter.id)
    );
}

export interface PlotlineChaptersProps {
    view: StoryViewData;
    actions: StoryActions;
    /** D-37: prose editing requires the paused Story. */
    paused: boolean;
    /** The runs Pause & edit would kill (P8). */
    liveRuns: number;
    /** The runs the pause already stopped (U-17's banner). */
    killedRuns: number;
}

export function PlotlineChapters({ view, actions, paused, liveRuns, killedRuns }: PlotlineChaptersProps) {
    const units = buildRevisionUnits(view);

    return (
        <section className="sv-pane sv-chapters" aria-label="Plotlines and chapters">
            <header className="sv-pane-head">
                <h3 className="sv-pane-title">Plotlines and chapters — the contract beside the prose (U-4)</h3>
                {/* L-8: the wall of motion is the point, so the grouping is what the Author reads. */}
                <span className="sv-pane-badge">
                    all chapters are in flight together, so the view groups them by what the crews are doing (L-8,
                    decision 0/5)
                </span>
            </header>

            {view.chapters.length === 0 ? (
                <p className="sv-chapters-none">No chapters yet — phase ② has not produced a contract to expand.</p>
            ) : null}

            {groupChapters(view).map(({ group, chapters }) =>
                chapters.length === 0 ? null : (
                    // Decision 0/5: the group heading is the sentence, so the Author reads state, not counts.
                    <section
                        className={`sv-activity sv-activity-${group}`}
                        key={group}
                        aria-label={ACTIVITY_LABELS[group]}
                    >
                        <h4 className="sv-activity-title">
                            {ACTIVITY_LABELS[group]} · {chapters.length}
                        </h4>

                        <div className="sv-activity-rows">
                            {chapters.map((chapter) => {
                                const plotline = plotlineFor(chapter, view.plotlines);
                                const unit = units.find((candidate) => candidate.unitRef === chapter.id);
                                const competing = competingRevisionsFor(view.revisions, chapter.id);
                                // D-34: an approved finding is queued Writer work — that is what "awaiting a fix" means.
                                // L-11a: a finding raised against another chapter but naming THIS one in
                                // `related_refs` is this chapter's problem too — the same test the server's
                                // bulk approve uses (`approve-all` in api/routes.ts), so the number on the
                                // button is the number of findings the click approves.
                                const chapterFindings = view.findings.filter(
                                    (finding) =>
                                        (finding.target_ref === chapter.id ||
                                            (finding.related_refs ?? []).includes(chapter.id)) &&
                                        finding.state !== 'fixed' &&
                                        finding.state !== 'discarded'
                                );
                                // U-10b: only the queue's rows move — an `unconfirmed` finding is the Editor's
                                // triage, and an `approved` one is already authorised work (D-34).
                                const approvable = chapterFindings.filter((finding) => finding.state === 'confirmed');

                                return (
                                    <article className="sv-chapter-row" key={chapter.id}>
                                        <div className="sv-chapter-contract">
                                            <h5 className="sv-chapter-contract-title">
                                                Plotline {plotline ? plotline.order : '—'} —{' '}
                                                {plotline?.heading || 'no contract yet'}
                                            </h5>
                                            {!plotline ? (
                                                <p className="sv-chapter-no-contract">
                                                    This chapter has no plotline: C-1 fails, and nothing can judge it
                                                    (P4).
                                                </p>
                                            ) : (
                                                <dl className="sv-plotline-fields">
                                                    <div className="sv-plotline-field">
                                                        <dt>Must happen (C-7)</dt>
                                                        <dd>{plotline.must_happen || '—'}</dd>
                                                    </div>
                                                    <div className="sv-plotline-field">
                                                        <dt>Must change (C-8)</dt>
                                                        <dd>{plotline.must_change || '—'}</dd>
                                                    </div>
                                                    <div className="sv-plotline-field">
                                                        <dt>POV</dt>
                                                        <dd>{plotline.pov || '—'}</dd>
                                                    </div>
                                                    <div className="sv-plotline-field">
                                                        <dt>Setups / payoffs (C-5)</dt>
                                                        <dd>
                                                            {plotline.setups || '—'} / {plotline.payoffs || '—'}
                                                        </dd>
                                                    </div>
                                                </dl>
                                            )}
                                            <div className="sv-chapter-badges">
                                                {plotline?.contract_locked ? (
                                                    <span className="sv-badge sv-badge-lock">
                                                        plotline locked — agents propose (D-6)
                                                    </span>
                                                ) : null}
                                                {plotline && !plotline.aligned ? (
                                                    <span className="sv-badge sv-badge-warn">
                                                        plotline not aligned to the Summary (C-2)
                                                    </span>
                                                ) : null}
                                                {plotline?.needs_recheck ? (
                                                    <span className="sv-badge sv-badge-warn">
                                                        plotline marked needs_recheck (L-11)
                                                    </span>
                                                ) : null}
                                                {chapter.state === 'needs_recheck' ? (
                                                    // L-11a: propagation runs both directions in time.
                                                    <span className="sv-badge sv-badge-warn">
                                                        chapter marked needs_recheck — a change somewhere else touched
                                                        this one (L-11a)
                                                    </span>
                                                ) : null}
                                            </div>

                                            {chapterFindings.length > 0 ? (
                                                // U-11: progress reads as story, so the open findings are named here.
                                                <ul className="sv-chapter-findings">
                                                    {chapterFindings.map((finding) => (
                                                        <li className="sv-chapter-finding" key={finding.id}>
                                                            <span className={`sv-finding-cost sv-cost-${finding.cost}`}>
                                                                {finding.cost}
                                                            </span>
                                                            <span className="sv-finding-title">{finding.title}</span>
                                                            <span className="sv-finding-state">{finding.state}</span>
                                                            {finding.seen_count > 1 ? (
                                                                <span className="sv-finding-seen">
                                                                    {finding.seen_count}× seen (D-16)
                                                                </span>
                                                            ) : null}
                                                        </li>
                                                    ))}
                                                </ul>
                                            ) : null}

                                            {/*
                                                U-10b — the chapter-scale approval. The queue (U-10a) stays
                                                one-finding at a time on purpose; this is the OTHER move U-10b
                                                names, and it only appears when the chapter holds confirmed
                                                findings, so it is never a blind batch. The audit line is fixed
                                                copy, because the click is itself the reason (D-8).
                                            */}
                                            {approvable.length > 0 ? (
                                                <button
                                                    type="button"
                                                    className="sv-chapter-approve"
                                                    disabled={!actions.approveChapterFindings}
                                                    title="Approves every confirmed finding on this chapter, including the ones raised elsewhere that name it (L-11a). Each one stays its own audit entry (D-34, U-10b)."
                                                    onClick={() =>
                                                        void actions.approveChapterFindings?.(
                                                            view.story.id,
                                                            chapter.id,
                                                            'approved from the chapter row by the Author (U-10b)'
                                                        )
                                                    }
                                                >
                                                    Approve this chapter’s findings — {approvable.length}
                                                </button>
                                            ) : null}

                                            {/* Item 11: keep the prose, reopen the review — not a backtrack (L-31). */}
                                            {chapter.state === 'done' ? (
                                                <button
                                                    type="button"
                                                    className="sv-chapter-unapprove"
                                                    disabled={!actions.unapproveChapter}
                                                    title="Keeps every word and reopens this chapter's review. A different verb from backtrack: nothing is deleted (§14 item 11)."
                                                    onClick={() =>
                                                        void actions.unapproveChapter?.(view.story.id, chapter.id)
                                                    }
                                                >
                                                    Unapprove review — keep the prose, reopen the review
                                                </button>
                                            ) : null}
                                        </div>

                                        <div className="sv-chapter-prose">
                                            <ProseEditor
                                                chapter={chapter}
                                                story={view.story}
                                                paused={paused}
                                                killedRuns={killedRuns}
                                                liveRuns={liveRuns}
                                                // L-9: the declared dependency set is the set D-37a's recheck walks.
                                                dependents={view.story.chapter_deps[chapter.id] ?? []}
                                                proposals={view.proposals}
                                                // The prose editor speaks LOCAL shapes (one story, `(id)` / `({input})`) while
                                                // the actions speak the pinned route shapes. Currying the Story id here keeps
                                                // both halves honest: the editor needs no story, the store gets its scope.
                                                onEditSection={
                                                    actions.editSection
                                                        ? (input) =>
                                                              void actions.editSection?.(
                                                                  view.story.id,
                                                                  input.chapterId,
                                                                  input.sectionId,
                                                                  input.text
                                                              )
                                                        : undefined
                                                }
                                                onPauseAndEdit={
                                                    actions.stop ? () => void actions.stop?.(view.story.id) : undefined
                                                }
                                                onResume={
                                                    actions.resume
                                                        ? () => void actions.resume?.(view.story.id)
                                                        : undefined
                                                }
                                                onAcceptProposal={
                                                    actions.acceptProposal
                                                        ? (proposalId) =>
                                                              void actions.acceptProposal?.(view.story.id, proposalId)
                                                        : undefined
                                                }
                                                onRejectProposal={
                                                    actions.rejectProposal
                                                        ? (proposalId) =>
                                                              void actions.rejectProposal?.(view.story.id, proposalId)
                                                        : undefined
                                                }
                                                onUndo={
                                                    actions.undo
                                                        ? (input) =>
                                                              void actions.undo?.(
                                                                  view.story.id,
                                                                  undoTargetFor(chapter, input.targetRef)
                                                              )
                                                        : undefined
                                                }
                                            />
                                        </div>

                                        {unit && competing.length > 1 ? (
                                            // U-13: the drafts a chapter is contested between appear under it,
                                            // and on selection the losers disappear (D-22) because the view stops listing them.
                                            <div className="sv-chapter-revisions">
                                                <RevisionsCompare
                                                    units={[unit]}
                                                    onSelectRevision={actions.selectRevision}
                                                    note={`${competing.length} competing drafts — the unit cannot advance until an Editor selects (D-23, L-20)`}
                                                />
                                            </div>
                                        ) : null}
                                    </article>
                                );
                            })}
                        </div>
                    </section>
                )
            )}
        </section>
    );
}
