// U-4 … U-17 — the Story view: the centre region for the selected Story.
//
// THE CONTENT AREA SHOWS ONE THING. The rail's selection names a phrase (Summary, Characters,
// Plotlines, Chapters) or a folder (Continuity, Goal, Ideas, Findings, Digest, Settings), and this
// component renders exactly that pane. The old stacked view — Seed + strip + status +
// dial + controls + Summary + tray + contracts + Goal + costs + Digest all at once — is gone on
// purpose: the Author is reading one artifact, not scrolling a dashboard.
//
// U-25 — AND A PHRASE'S SEED IS ONE OF ITS ENTRIES. The Seed is no longer a panel key: `{panel:<phrase>,
// ref: phraseSeedRef()}` opens that phrase's Seed pane, Phrase ① showing the Author's idea and Phrase ② showing the
// text its own Start copied. The two are different artifacts and neither one borrows the other's words.
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
// T-W4 — Phrase ②'s surface (the brief, the chapter entries and the entry pane) and the Summary column's handoff card.
import { PlotlinesEntryPane, PlotlinesOverviewPane } from './PlotlinesPhrasePane';
import { PlotlinesHandoff } from './PlotlinesHandoff';
// U-25 — a phrase's OWN Seed pane (the text it was copied from), for the rail's Seed child.
import { PhraseSeedPane } from './PhraseSeedPane';
import { StalledReview } from './story-stalled-review';
import { SummaryGroupPane } from './SummaryGroupPane';
import { SummaryOverviewPane } from './SummaryOverviewPane';
import { SummaryPane } from './SummaryPane';
import { PhaseControls } from './story-phase-controls';
import { ContinuityPane, DigestPane, FindingsPane, SeedPane, SettingsPane } from './story-folders';
import {
    ALL_STORY_PHRASES,
    // R10 — the crew line's words come from the rail's vocabulary, exactly as `CrewPanel`'s mark does.
    crewPhraseMarks,
    DEFAULT_STORY_SELECTION,
    isPhraseSeedRef,
    plotlineGroupFocus,
    recommendedRevisionId,
    selectionExists,
    summaryGroupFocus,
    summaryReadyForReview,
    summaryRevisionFocus,
    summaryRevisions,
    summaryRevisionUnit
} from './story-nav';
import type { StorySelection } from './story-nav';
import {
    isGroupSummary,
    // T-W4 — the phrase question and the phrase-swap view: the route picks the surface from the Setting, and the
    // shared entry components read the phrase slot, so Phrase ② renders through the swapped view.
    isPlotlinesGroups,
    plotlinesSurfaceView,
    isLiveRun,
    backtrackStatement,
    lockCheck,
    runsStoppedByPause,
    selectedSummaryRevision,
    storyStatusLabel
} from './story-contract';
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
    // R10 — WHICH PHRASE the crew is on, from the same rows the count above reads. The wire sends the label
    // (`projections.ts:projectRunRow` on both `GET /runs` and this payload's runs slice), so the desk prints an
    // answer rather than a guess; rows the server could not attribute come back as their own mark.
    const crewMarks = crewPhraseMarks(view.runs);
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
    // T-W4 — the same pair of questions for Phrase ②: WHICH surface (the chapter entries, or the §4.3 records) and
    // WHICH entry the rail's ref addresses. `plotlineGroupFocus` resolves `plotlines-group:<uuid>` against the
    // phrase's live rows, so a stale or cross-phrase ref lands on the overview rather than an empty pane, and the
    // pane itself keeps looking rows up by id (U2).
    const groupedPlotlines = isPlotlinesGroups(view);
    const plotlinesFocus = groupedPlotlines ? plotlineGroupFocus(view, active) : undefined;
    // U-25 — THE SEED IS A PHRASE CHILD: `{panel:<phrase>, ref: phraseSeedRef()}`. `story-nav.selectionExists`
    // accepts that ref for every phrase, so it survives the stale-ref guard above (which would otherwise replace the
    // selection and silently land the Author on the Overview), and while it is open the Seed's own pane is the WHOLE
    // content area: a phrase's overview, its entry rows and the phase-level controls all describe the phrase's
    // OUTPUT, and the Author is reading its input.
    const seedOpen = isPhraseSeedRef(active.ref);
    // WHICH phrase's Seed is open. Phrase ①'s Seed IS `story.idea` (`server/phrase/catalog.ts:phraseSeedOf`), so its
    // row opens the existing read-only Seed pane; every other phrase's Seed is the text its Start copied, which is
    // what `PhraseSeedPane` prints from that phrase's own read. Characters is a supplementary sheet the rail never
    // offers a Seed row for, and `CharactersPane` already falls back to the sheet for a ref it cannot resolve, so
    // leaving it ungated is the honest fallback rather than a blank content area.
    const seedPhrase = seedOpen
        ? ALL_STORY_PHRASES.find((candidate) => candidate.key === active.panel)
        : undefined;

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

                    {/* R10 (symptom 3, the half the Author actually sees) — WHICH PHRASE the crew is working on,
                        on the one line that is above the fold on EVERY pane. The rail's lit row is the only other
                        phrase word on screen, and it names what the Author is READING, not what the staff is
                        doing; a Phrase-② Writer therefore used to sit under a rail lit on Phrase ① with nothing on
                        the desk to say otherwise. The words are the rail's own vocabulary (`story-nav.crewPhraseMarks`
                        → `phraseLabel`), and the key behind them is derived server-side
                        (`server/api/projections.ts:runPhraseKeyOf`) — never guessed here. An unattributable thread
                        gets its own honest chip rather than Phrase ①, which is the default this requirement removes.
                        It renders for live threads only: closed rows are history, and the line above the pane is
                        the Author's answer to "what are they doing right now". */}
                    {crewMarks.map((mark) => (
                        <span
                            className={`sv-story-crew sv-story-crew-${mark.key}`}
                            data-testid={`crew-phrase-${mark.key}`}
                            key={mark.key}
                            title={[
                                `which phrase the crew's live threads belong to — read off the group rows each thread holds or the phrase its claim key is keyed on (R4, V-3, R10)`,
                                mark.count > 1 ? `${mark.count} threads on it` : '1 thread on it',
                                mark.claimKeys.length > 0 ? `claims: ${mark.claimKeys.join(', ')}` : 'no work item claimed yet'
                            ].join(' · ')}
                        >
                            crew: {mark.text}
                            {mark.count > 1 ? ` ×${mark.count}` : ''}
                        </span>
                    ))}
                </p>

                {/* U-25 — THE SEED PANES, ONE PER PHRASE. `panel:'seed'` is gone from the nav model, so the Seed opens
                    through its phrase: Phrase ①'s row shows the Author's idea (the P5 badge, the Editor's accepted
                    brief, the D-3b measure), Phrase ②'s row shows the text THAT phrase was started from — never the
                    Author's idea, which is the defect the request named. Both are read-only: the desk has no Seed
                    write verb for Phrase ①, and D-72 forbids re-seeding a started phrase. */}
                {seedPhrase === undefined ? null : seedPhrase.key === 'summary' ? (
                    <SeedPane view={view} phrase={seedPhrase} />
                ) : (
                    <PhraseSeedPane view={view} actions={actions} phrase={seedPhrase} />
                )}

                {active.panel === 'summary' && !seedOpen ? (
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
                                sampling={story.summary_sampling ?? view.vocabulary.summary_sampling_default}
                                critics={story.summary_critics ?? view.vocabulary.summary_critics_default}
                                reviewLimit={view.vocabulary.summary_review_limit}
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

                        {/* T-W4 — THE HANDOFF, R5's step ②, and it lives on the MAIN Summary item for one reason:
                            the text it copies is the Summary. The gate is the same one the phase controls use
                            (`revisionFocus === undefined && groupFocus === undefined` IS "the main Summary item"),
                            so a Revision pane or a group pane never grows a second copy of the verb. It renders
                            while the phrase has NOT started (the button, or the sentence saying why not) and as the
                            receipt afterwards, so the Author who starts the phrase from here sees the copied Seed
                            and the way into Phrase 2 without losing the frame they pressed in.
                            It is NOT gated on `story.phase === 'summary'`: the compiled Summary stays the phrase's
                            Seed after phase ① signs off, and an Author who reaches the Summary late still has to be
                            able to start the next phrase. */}
                        {revisionFocus === undefined && groupFocus === undefined ? (
                            <PlotlinesHandoff view={view} actions={actions} onSelect={onSelect} />
                        ) : null}
                    </div>
                ) : null}

                {active.panel === 'characters' ? (
                    <CharactersPane view={view} actions={actions} selectedRef={active.ref} />
                ) : null}

                {active.panel === 'plotlines' && !seedOpen ? (
                    // T-W4 — TWO PLOTLINES SURFACES, ONE ROUTE. A book on the grouped pipeline gets the phrase's
                    // own surface: the brief, the chapter entries, and the ONE entry the rail's ref addresses
                    // (rendered through `plotlinesSurfaceView`, which puts Phrase ②'s read in the slot the shared
                    // entry components read). A classic book keeps `PlotlinesPane`'s §4.3 records exactly as they
                    // were, because nothing about Phrase ② changes what those rows say. The question is the
                    // Setting's (`isPlotlinesGroups`: the phrase read's `mode`, else `story.plotlines_mode`), never
                    // a count of rows, so a slow read cannot flip a book's surface mid-frame.
                    <>
                        {isPlotlinesGroups(view) ? (
                            plotlinesFocus === undefined ? (
                                <PlotlinesOverviewPane
                                    view={plotlinesSurfaceView(view)}
                                    actions={actions}
                                    selection={active}
                                    onSelect={onSelect}
                                />
                            ) : (
                                <PlotlinesEntryPane
                                    view={plotlinesSurfaceView(view)}
                                    actions={actions}
                                    selection={active}
                                    onSelect={onSelect}
                                />
                            )
                        ) : (
                            <PlotlinesPane view={view} selectedRef={active.ref} />
                        )}
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

                {active.panel === 'chapters' && !seedOpen ? (
                    <>
                        <PlotlineChapters
                            view={view}
                            actions={actions}
                            paused={paused}
                            liveRuns={liveRuns}
                            killedRuns={killedRuns}
                            // T-W4 — the numbering moved with the rail: Phrase ② is Plotlines, so Chapters is ③.
                            // The pane's heading and the rail's vocabulary are one fact (`story-nav.ALL_STORY_PHRASES`).
                            title="Chapters — Phrase 3"
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
                        levels={view.vocabulary.goal_levels}
                        perChapter={view.vocabulary.per_chapter_criteria}
                        criterionCheckers={view.vocabulary.criterion_checkers}
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
