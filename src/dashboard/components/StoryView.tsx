// U-4 … U-17 — the Story view: the centre region for the selected Story.
//
// THE CONTENT AREA SHOWS ONE THING. The rail's selection names a phrase (Summary, Characters,
// Plotlines, Chapters) or a folder (Seed, Continuity, Goal, Ideas, Findings, Digest, Settings),
// and this component renders exactly that pane. The old stacked view — Seed + strip + status +
// dial + controls + Summary + tray + contracts + Goal + costs + Digest all at once — is gone on
// purpose: the Author is reading one artifact, not scrolling a dashboard.
//
// THE RAIL IS THE SHELL'S. `StorylineApp` owns the selection (it renders the rail and this view
// from one state) and passes it down. A view whose selected entry disappeared — a cast member the
// crew renamed, a selected draft whose sibling was deleted — falls back to the phrase's own pane,
// so a stale click can never blank the screen.
//
// WHAT REMAINS OUTSIDE THE PANES: the story's status line (U-1c) is one line of chrome above the
// artifact. The employee rail is the shell's third column, not part of this content region.
import '../styles/story.css';
import { CharactersPane } from './CharactersPane';
import { CompletionPrompt } from './CompletionPrompt';
import { GoalPanel } from './GoalPanel';
import { IdeasTray } from './IdeasTray';
import { PlotlineChapters } from './PlotlineChapters';
import { PlotlinesPane } from './PlotlinesPane';
import { StalledReview } from './story-stalled-review';
import { SummaryPane } from './SummaryPane';
import { PhaseControls } from './story-phase-controls';
import { ContinuityPane, DigestPane, FindingsPane, SeedPane, SettingsPane } from './story-folders';
import {
    DEFAULT_STORY_SELECTION,
    recommendedRevisionId,
    selectionExists,
    summaryReadyForReview,
    summaryRevisionFocus,
    summaryRevisions,
    summaryRevisionUnit
} from './story-nav';
import type { StorySelection } from './story-nav';
import { isLiveRun, backtrackStatement, lockCheck, runsStoppedByPause, storyStatusLabel } from './story-contract';
import type { StoryActions, StoryViewData } from './story-contract';

/** D-2a/L-34/L-37a: awaiting the Author is calm, stalled is urgent — and neither is an error. */
function statusClass(status: string, pendingKind: string): string {
    if (status === 'pending' && pendingKind === 'stalled') {
        return 'sv-status-stalled';
    }
    if (status === 'pending') {
        return 'sv-status-awaiting';
    }
    if (status === 'stopped') {
        return 'sv-status-paused';
    }
    if (status === 'completed') {
        return 'sv-status-done';
    }
    return 'sv-status-ready';
}

export interface StoryViewProps {
    view: StoryViewData;
    /** The pinned client surface. Every method is optional; absent means the control says so (see `StoryActions`). */
    actions?: StoryActions;
    /** Injected so run elapsed time is deterministic in tests (S-6 shows it, E-0 says it is never a limit). */
    now?: string;
    /** L-25's clean-ledger line, when the caller has it (the pinned view carries no `ledger` state string). */
    ledgerState?: string;
    /** The rail's selection; absent means the Summary, which is the phrase a Story opens on. */
    selection?: StorySelection;
}

export function StoryView({ view, actions = {}, ledgerState, selection = DEFAULT_STORY_SELECTION }: StoryViewProps) {
    const { story } = view;
    const active: StorySelection = selectionExists(view, selection) ? selection : { panel: selection.panel };

    // D-37: the prose editor is live only from a paused Story — the same status Stop sets (P8).
    const paused = story.status === 'stopped';
    const liveRuns = view.runs.filter(isLiveRun).length;
    const killedRuns = runsStoppedByPause(view.runs);
    const lock = lockCheck(view);

    const summaryUnit = summaryRevisionUnit(view);
    const recommended = recommendedRevisionId(summaryUnit);
    // Phase ①'s rail opens one flat Revision; the pane renders that version and its findings.
    const revisionFocus = summaryRevisionFocus(view, active);
    const revisions = summaryRevisions(view);
    // U-13 / D-24 — the Author's pick among the Summary's competing revisions.
    const onSelectRevision = actions.selectRevision
        ? (unitRef: string, revisionId: string) => void actions.selectRevision?.(unitRef, revisionId)
        : undefined;

    return (
        <div className="sv-story">
            <div className="sv-story-main">
                <p className={`sv-story-status ${statusClass(story.status, story.pending_kind)}`}>
                    <span className="sv-story-status-badge">{storyStatusLabel(story.status, story.pending_kind)}</span>
                    {story.status_reason ? <span className="sv-story-reason">{story.status_reason}</span> : null}
                    {/* §10 / §6.6 — phase ①'s sampling round, the one number that tells the Author
                        which round the Summary panes are showing. Only phase ① samples, so the line
                        stays off later phases (and off a payload that predates the projection). */}
                    {story.phase === 'summary' && view.sampling !== undefined ? (
                        <span className="sv-story-sampling">Sampling round {view.sampling.round}</span>
                    ) : null}
                </p>

                {active.panel === 'seed' ? <SeedPane view={view} /> : null}

                {active.panel === 'summary' ? (
                    <>
                        {story.status === 'pending' && story.pending_kind === 'stalled' ? (
                            <StalledReview view={view} actions={actions} />
                        ) : null}

                        <SummaryPane
                            story={story}
                            summary={view.summary}
                            revisions={revisions}
                            recommendedRevisionId={recommended}
                            onSelectRevision={onSelectRevision}
                            focus={revisionFocus}
                            readyForReview={summaryReadyForReview(view)}
                            sampling={story.summary_sampling}
                            readers={story.summary_readers}
                            onSetSummaryReview={
                                actions.setSummaryReview
                                    ? (sampling, readers) =>
                                          void actions.setSummaryReview?.(story.id, sampling, readers)
                                    : undefined
                            }
                            // U-4: the pane's own Backtrack, naming the deletions (L-32).
                            backtrackNote={
                                story.summary_locked ? backtrackStatement(story, 'summary', view) : undefined
                            }
                            onBacktrack={
                                actions.backtrack ? (phase) => void actions.backtrack?.(story.id, phase) : undefined
                            }
                        />

                        {story.phase === 'summary' ? <PhaseControls view={view} actions={actions} lock={lock} /> : null}
                    </>
                ) : null}

                {active.panel === 'characters' ? (
                    <CharactersPane view={view} actions={actions} selectedRef={active.ref} />
                ) : null}

                {active.panel === 'plotlines' ? (
                    <>
                        <PlotlinesPane view={view} selectedRef={active.ref} />
                        {story.phase === 'plotlines' || story.plotlines_locked ? (
                            <PhaseControls
                                view={view}
                                actions={actions}
                                lock={lock}
                                showLock={story.phase === 'plotlines'}
                            />
                        ) : null}
                    </>
                ) : null}

                {active.panel === 'chapters' ? (
                    <>
                        <PlotlineChapters
                            view={view}
                            actions={actions}
                            paused={paused}
                            liveRuns={liveRuns}
                            killedRuns={killedRuns}
                            title="Chapters — Phrase 4"
                            onlyChapterRef={active.ref}
                        />
                        {story.phase === 'chapters' && view.completion_preview && story.status !== 'completed' ? (
                            <CompletionPrompt
                                preview={view.completion_preview}
                                story={story}
                                ledgerState={ledgerState}
                                onAccept={
                                    actions.acceptCompletion
                                        ? (storyId) => void actions.acceptCompletion?.(storyId)
                                        : undefined
                                }
                            />
                        ) : null}
                        {story.phase === 'chapters' && !view.completion_preview ? (
                            <PhaseControls view={view} actions={actions} lock={lock} />
                        ) : null}
                        {story.status === 'completed' ? (
                            <PhaseControls view={view} actions={actions} lock={lock} showLock={false} />
                        ) : null}
                    </>
                ) : null}

                {active.panel === 'continuity' ? <ContinuityPane view={view} /> : null}
                {active.panel === 'goal' ? (
                    <GoalPanel
                        goal={view.goal.goal}
                        phase={story.phase}
                        progress={view.goal.phase_progress}
                        failing={view.goal.failing}
                        chapterProgress={view.goal.chapter_progress}
                        chapters={view.chapters}
                        onPatchGoal={
                            actions.patchGoal ? (patch) => void actions.patchGoal?.(story.id, patch) : undefined
                        }
                        onSetChapterBar={
                            actions.setChapterBar
                                ? (chapterId, override) => void actions.setChapterBar?.(story.id, chapterId, override)
                                : undefined
                        }
                    />
                ) : null}
                {active.panel === 'ideas' ? (
                    <IdeasTray
                        ideas={view.ideas}
                        phase={story.phase}
                        onSelect={
                            actions.selectIdea
                                ? (ideaId) => void actions.selectIdea?.(story.id, ideaId, 'selected by the Author')
                                : undefined
                        }
                        onDiscard={
                            actions.discardIdea ? (ideaId) => void actions.discardIdea?.(story.id, ideaId) : undefined
                        }
                        onDefer={actions.deferIdea ? (ideaId) => void actions.deferIdea?.(story.id, ideaId) : undefined}
                    />
                ) : null}
                {active.panel === 'findings' ? <FindingsPane view={view} /> : null}
                {active.panel === 'digest' ? <DigestPane view={view} /> : null}
                {active.panel === 'settings' ? <SettingsPane view={view} actions={actions} /> : null}
            </div>
        </div>
    );
}
