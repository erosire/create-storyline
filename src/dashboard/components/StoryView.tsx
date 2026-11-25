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
import { SummaryGroupPane } from './SummaryGroupPane';
import { SummaryOverviewPane } from './SummaryOverviewPane';
import { SummaryPane } from './SummaryPane';
import { PhaseControls } from './story-phase-controls';
import { ContinuityPane, DigestPane, FindingsPane, SeedPane, SettingsPane } from './story-folders';
import {
    DEFAULT_STORY_SELECTION,
    recommendedRevisionId,
    selectionExists,
    summaryGroupFocus,
    summaryReadyForReview,
    summaryRevisionFocus,
    summaryRevisions,
    summaryRevisionUnit
} from './story-nav';
import type { StorySelection } from './story-nav';
import { isGroupSummary, isLiveRun, backtrackStatement, lockCheck, runsStoppedByPause, selectedSummaryRevision, storyStatusLabel } from './story-contract';
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
    /**
     * R6 — the group rows in the Summary panes navigate, so the content column needs the rail's verb. Absent
     * (a pane rendered without a shell) leaves the rows as text: the panes still read, they just cannot move.
     */
    onSelect?: (selection: StorySelection) => void;
}

export function StoryView({
    view,
    actions = {},
    ledgerState,
    selection = DEFAULT_STORY_SELECTION,
    onSelect
}: StoryViewProps) {
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
    // R1: the ordinary Summary pane prints the ONE revision the record names, so the id comes from the
    // contract's own authority — `selectedSummaryRevision` is the newest `state: 'selected'` row for this
    // Summary (story-contract.ts:531-545), the same draft `summaryBlockingFindings` and the Accept gate
    // read. Several rounds leave several `selected` rows, which is why an id is passed rather than the
    // pane guessing at a state. It is NOT `view.sampling.selected.revision_id`: the Author's override
    // (§6.6) changes the row's state without appending sampling history, so that field can lag the record.
    const onRecordRevision = selectedSummaryRevision(view);
    // T4: the Author's override (U-13, D-24) and the review's recommendation of a candidate now live on the
    // revision the rail OPENS, because R1 keeps candidates out of the overview. The authority is the
    // contract's own candidate list — `summaryUnit` above is `story-nav.summaryRevisionUnit`, i.e.
    // `isReviewableRevision` minus `isSupersededSummaryDraft` (story-nav.ts:128-141, the same list
    // `server/loop/phase1-round-parity.test.ts` pins as the Author's override). So a `drafted` row an older
    // round already lost keeps its disabled button, and no row gains an action the API would refuse.
    const focusSelectable =
        revisionFocus !== undefined &&
        (summaryUnit?.revisions ?? []).some((revision) => revision.id === revisionFocus.revision.id);
    // U-13 / D-24 — the Author's pick among the Summary's competing revisions.
    const onSelectRevision = actions.selectRevision
        ? (unitRef: string, revisionId: string) => void actions.selectRevision?.(unitRef, revisionId)
        : undefined;
    // R6 — the one question that decides which Summary SURFACE the column holds: a group-managed book opens the
    // compiled Overview and its five group panes, a sampling book keeps the round. `isGroupSummary` answers from
    // `story.summary_mode` (the Setting the server echoes), so the surface cannot drift from the wire, and a
    // legacy book with no `summary_mode` on its row is never made to look grouped.
    const grouped = isGroupSummary(view);
    // The group the rail's ref addresses, resolved against the live rows; `undefined` means the Overview. A stale
    // ref is already gone by here — `active` applied `selectionExists`, which drops a ref that names no live
    // group once the phrase read has landed — and a ref whose read has NOT landed resolves to `undefined` too, so
    // the Overview's own pending line is what the Author reads while the rows are on their way (U6).
    const groupFocus = grouped ? summaryGroupFocus(view, active) : undefined;

    return (
        <div className="sv-story">
            <div className="sv-story-main">
                <p className={`sv-story-status ${statusClass(story.status, story.pending_kind)}`}>
                    <span className="sv-story-status-badge">{storyStatusLabel(story.status, story.pending_kind)}</span>
                    {story.status_reason ? <span className="sv-story-reason">{story.status_reason}</span> : null}
                    {/* §10 / §6.6 — phase ①'s sampling round, the one number that tells the Author
                        which round the Summary panes are showing. Only phase ① samples, so the line
                        stays off later phases (and off a payload that predates the projection).
                        R6: and off a GROUP-managed book, which runs no sampler at all — the loop writes
                        five groups, so a round number over its Overview would be a number the engine
                        never produced (U3). */}
                    {story.phase === 'summary' && view.sampling !== undefined && !grouped ? (
                        <span className="sv-story-sampling">Sampling round {view.sampling.round}</span>
                    ) : null}
                </p>

                {active.panel === 'seed' ? <SeedPane view={view} /> : null}

                {active.panel === 'summary' ? (
                    // U1 — the MAIN Summary item's own column: the stalled screen, the Summary surface, and the
                    // phase-level controls that belong to that surface. The wrapper is what makes "on the
                    // main Summary item" a DOM fact rather than a reading: `.sv-summary-column` is the scope
                    // the acceptance tests count the phase controls inside. It is a flex column with the same
                    // gap as `.sv-story-main` (styles/story.css), so nesting the pair changes the spacing not
                    // at all — the reported defect is about WHICH surface renders the block, not where it sits.
                    //
                    // R6 — THE COLUMN HOLDS ONE OF TWO SUMMARY SURFACES. A group-managed book shows the compiled
                    // Overview and its five group rows, or the ONE group the rail's ref addresses; a sampling book
                    // keeps the round (`SummaryPane`) exactly as it was. The group panes and the round are not
                    // merged: the round's dials, candidate cards and selection verbs describe a pipeline a grouped
                    // Story never runs (U3), and printing them over a five-group Overview would put numbers on
                    // screen that the engine never produced.
                    <div className="sv-summary-column">
                        {story.status === 'pending' && story.pending_kind === 'stalled' ? (
                            <StalledReview view={view} actions={actions} />
                        ) : null}

                        {grouped ? (
                            groupFocus === undefined ? (
                                // The Overview: the REVIEWED Summary (D-67), the Author's Choose (D-68), and one
                                // honest row per group. `active` carries the selection so the lit row is the one
                                // the rail is on; `actions` carries the choose verb, which is the pane's only write.
                                <SummaryOverviewPane
                                    view={view}
                                    actions={actions}
                                    selection={active}
                                    onSelect={onSelect}
                                />
                            ) : (
                                // One group: its purpose, its current text, its revision number, its open findings
                                // with the other groups they span. The revise verb is here, not on the Overview.
                                <SummaryGroupPane
                                    view={view}
                                    actions={actions}
                                    groupId={groupFocus.id}
                                    onSelect={onSelect}
                                />
                            )
                        ) : (
                            <SummaryPane
                                story={story}
                                summary={view.summary}
                                revisions={revisions}
                                onRecordRevisionId={onRecordRevision?.id}
                                recommendedRevisionId={recommended}
                                onSelectRevision={onSelectRevision}
                                focus={revisionFocus}
                                focusSelectable={focusSelectable}
                                readyForReview={summaryReadyForReview(view)}
                                sampling={story.summary_sampling}
                                critics={story.summary_critics}
                                onSetSummaryReview={
                                    actions.setSummaryReview
                                        ? (sampling, critics) =>
                                              void actions.setSummaryReview?.(story.id, sampling, critics)
                                        : undefined
                                }
                                // U-4: the pane's own Backtrack, naming the deletions (L-32).
                                backtrackNote={
                                    story.summary_locked ? backtrackStatement(story, 'summary', view) : undefined
                                }
                                onBacktrack={
                                    actions.backtrack
                                        ? (phase) => void actions.backtrack?.(story.id, phase)
                                        : undefined
                                }
                            />
                        )}

                        {/* U1 (the reported defect) — these controls are PHASE-① SUMMARY-level: accepting the
                            final Summary, the lock gate and its failing Goal/revision/finding reasons, "Request
                            another revision round", and the backtrack/lock information. They describe the whole
                            phase, so they render on the main Summary item and on NO Revision. The gate is the
                            selection, not a new flag: `revisionFocus === undefined` IS "this is the main Summary
                            item", because `story-nav.summaryRevisionFocus` returns an entry exactly when the rail
                            carries a `revision:<id>` ref (and a stale ref already falls back to the overview via
                            `selectionExists` above, so a deleted draft can never hide the Author's controls).
                            `SummaryPane`'s focus branch (`SummaryRevisionPane`) is therefore the Revision surface
                            the report describes: the draft's fields, its Findings, its verdict rows, and its own
                            override — nothing else. `story.phase === 'summary'` and the wiring (`lock`, `actions`)
                            are untouched, so the main item keeps the same commands, disabled reasons and pending
                            states, and later phases' `PhaseControls` (Plotlines/Chapters) are unaffected.

                            R6: the same rule reads `groupFocus === undefined` for a grouped book — the gate signs
                            off the WHOLE Summary, so it belongs under the Overview and not under one group. Its
                            blockers come from `lockCheck`'s group branch (`groupSignOffBlockers`: unwritten groups,
                            open findings at the Summary's blocking costs, open group tasks, a Writer holding a
                            group), which is what keeps the button from claiming a five-group Overview is ready when
                            two groups are empty (U5). The round verb inside the block is dropped for grouped books
                            in `story-phase-controls`. */}
                        {story.phase === 'summary' && revisionFocus === undefined && groupFocus === undefined ? (
                            <PhaseControls view={view} actions={actions} lock={lock} />
                        ) : null}
                    </div>
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
