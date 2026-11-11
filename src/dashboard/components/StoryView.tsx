// U-4 … U-17 — the Story view: the centre region for the selected Story, and the composition
// root for everything else in this directory (W10, W11, W11b, W13).
//
// WHY IT TAKES PROPS AND NOT A CONTEXT IMPORT (judgment call, reported): T8 is writing
// `../state.ts` and `../api.ts` against the SAME pinned contract at the same time, so importing
// `useStoryline` here would make this tree unresolvable until their file lands, and would make
// every test in this directory depend on their provider. The view is therefore a pure function of
// `{ view, actions }` — T8's `StorylineApp` renders `<StoryView view={view} actions={actions} />`
// from its own state hook, and the tests here feed fixture views directly (hermetic, no api mock
// needed anywhere). `actions` is `Partial`-shaped by construction (every method optional), so a
// control whose endpoint has not landed renders disabled and names the gap rather than inventing
// an endpoint.
//
// §10.1's layout: this component owns the CENTRE region (seed → phase strip → the two big phase
// buttons → Summary → Ideas → plotlines-and-chapters → revisions → Goal → completion → cost) and
// includes the right-hand CREW/TEMPLATES rail so the regions stay in one readable tree. T8 may
// lift `CrewPanel` / `TemplatesPanel` out into their own region; they take their own props and
// render independently.
//
// U-11 is the discipline that shapes the copy throughout: no spinner for its own sake, progress
// reads as story — chapters drafted, a hole in act two, setups unpaid.
// Imported here rather than from the app shell so the story view's styles always ship with it.
// Every class is `sv-` prefixed: `styles/app.css` (T8) owns the shell, and the two files must not
// collide.
import '../styles/story.css';
import { CompletionPrompt } from './CompletionPrompt';
import { CrewPanel } from './CrewPanel';
import { GoalPanel } from './GoalPanel';
import { IdeasTray } from './IdeasTray';
import { PhaseStrip } from './PhaseStrip';
import { PlotlineChapters } from './PlotlineChapters';
import { RevisionsCompare } from './RevisionsCompare';
import { SeedCard } from './SeedCard';
// U-1a / L-23 — the stalled review surface and the four exits (see the file for why it is separate).
import { StalledReview } from './story-stalled-review';
import { SummaryPane } from './SummaryPane';
import { TemplatesPanel } from './TemplatesPanel';
import { CostDistributionPanel } from './story-cost-distribution';
import { PhaseControls, backtrackTargets } from './story-phase-controls';
import { FINDING_COSTS } from '../../shared/types';
import {
    backtrackStatement,
    buildRevisionUnits,
    isLiveRun,
    lockCheck,
    phaseLocks,
    runsStoppedByPause
} from './story-contract';
import type { StoryActions, StoryViewData } from './story-contract';

/**
 * D-29 / T-5: a selection is a recorded decision, and every write owes a `why`. The tray has no
 * note field, so the note is the fixed sentence naming the actor — the same one the shell binding
 * uses, so a selection reads the same whichever surface made it.
 */
const SELECT_NOTE = 'selected by the Author';

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
    /** L-25's clean-ledger line, when the caller has it (the pinned view carries no `ledger` collection). */
    ledgerState?: string;
}

export function StoryView({ view, actions = {}, now = new Date().toISOString(), ledgerState }: StoryViewProps) {
    const { story, goal } = view;

    // D-37: the prose editor is live only from a paused Story — the same status Stop sets (P8).
    const paused = story.status === 'stopped';
    const liveRuns = view.runs.filter(isLiveRun).length;
    const killedRuns = runsStoppedByPause(view.runs);

    // U-16's gate is computed once and shared by the Lock button and the Ideas tray's copy.
    const lock = lockCheck(view);
    const targets = backtrackTargets(story);

    // Chapter units render their drafts inline (under the prose they belong to); the summary and
    // plotline units get the standalone comparison pane (U-13).
    const units = buildRevisionUnits(view);
    const chapterIds = new Set(view.chapters.map((chapter) => chapter.id));
    const otherUnits = units.filter((unit) => !chapterIds.has(unit.unitRef));

    return (
        <div className="sv-story">
            <div className="sv-story-main">
                {/* U-4: the Seed is pinned and never scrolls away — C-14 measures the book against it. */}
                <SeedCard idea={story.idea} title={story.title} summary={view.summary} />

                <PhaseStrip phase={story.phase} locked={phaseLocks(story)} />

                <p className={`sv-story-status ${statusClass(story.status, story.pending_kind)}`}>
                    <span className="sv-story-status-badge">
                        {story.status === 'pending' ? `pending — ${story.pending_kind}` : story.status}
                    </span>
                    {/* U-1c / L-22: the reason is the Author's whole review surface, so it is never truncated here. */}
                    {story.status_reason ? <span className="sv-story-reason">{story.status_reason}</span> : null}
                    {story.consistency ? <span className="sv-story-levels">{story.consistency}</span> : null}
                    <span className="sv-story-trend">trend: {story.trend}</span>
                    {story.progress ? <span className="sv-story-progress">{story.progress}</span> : null}
                </p>

                {/* U-1a: a stalled Story is a question spread over five panes; this gathers it into one
                    review surface — stuck criteria, oldest findings, chapters involved, what the crews
                    tried across rounds, and L-23's four exits as buttons — and puts it under the status
                    line, where the Author reads first. */}
                {story.status === 'pending' && story.pending_kind === 'stalled' ? (
                    <StalledReview view={view} actions={actions} />
                ) : null}

                {/* D-35 / D-35b / U-10a: the dial sits beside the Story's own controls, and the Author
                    must never be surprised later by work the machine started on their behalf. */}
                <div className="sv-dial" aria-label="Auto-approve dial">
                    <span className="sv-dial-title">
                        auto-approve dial (D-35) — the same switch sets when the crew stops looking (D-35b)
                    </span>
                    <ul className="sv-dial-costs">
                        {FINDING_COSTS.map((cost) => {
                            const covered = story.auto_approve.includes(cost);
                            // The next state is rebuilt from the canonical cost order (FINDING_COSTS), so a
                            // toggle can never reorder the list or leave a duplicate behind — the dial is one
                            // write of the whole set, which is also what sets the drain threshold (D-35b).
                            const nextSet = FINDING_COSTS.filter((candidate) =>
                                candidate === cost ? !covered : story.auto_approve.includes(candidate)
                            );

                            return (
                                <li className={`sv-dial-cost${covered ? ' sv-dial-on' : ' sv-dial-off'}`} key={cost}>
                                    <input
                                        type="checkbox"
                                        checked={covered}
                                        disabled={!actions.setAutoApprove}
                                        title={
                                            actions.setAutoApprove
                                                ? `${covered ? `Stop auto-approving ${cost}: the crew raises it and waits for you` : `Let ${cost} findings start work without asking (D-35). This also moves when the crew stops looking (D-35b).`}`
                                                : 'The dial endpoint has not landed yet (D-35)'
                                        }
                                        aria-label={`${cost} auto-approve`}
                                        onChange={() => void actions.setAutoApprove?.(story.id, nextSet)}
                                    />
                                    <span className="sv-dial-cost-name">{cost}</span>
                                    <span className="sv-dial-cost-note">
                                        {covered
                                            ? 'starts work without asking · counts as work when draining'
                                            : 'waits for you · the crew raises it and stops'}
                                    </span>
                                </li>
                            );
                        })}
                    </ul>
                </div>

                {/* U-16: the two biggest buttons on the view, each stating what it costs. */}
                <PhaseControls view={view} actions={actions} lock={lock} />

                {view.completion_preview ? (
                    // U-14: the discard count is stated BEFORE the Accept, never after.
                    <CompletionPrompt
                        preview={view.completion_preview}
                        story={story}
                        ledgerState={ledgerState}
                        onAccept={
                            actions.acceptCompletion ? (storyId) => void actions.acceptCompletion?.(storyId) : undefined
                        }
                    />
                ) : null}

                <SummaryPane
                    story={story}
                    summary={view.summary}
                    // U-4: the pane's own Backtrack, naming the deletions (L-32).
                    backtrackNote={targets.length > 0 ? backtrackStatement(story, 'summary', view) : undefined}
                    onBacktrack={actions.backtrack ? (phase) => void actions.backtrack?.(story.id, phase) : undefined}
                    // §8.6: one assistant run on ONE field of the Summary. The pane names the field;
                    // `target` is always 'summary' because this pane owns the Summary artifact.
                    onAskAssistant={
                        actions.requestAssistant
                            ? (field) =>
                                  void actions.requestAssistant?.(story.id, {
                                      target: 'summary',
                                      text: `Rewrite the ${field}.`
                                  })
                            : undefined
                    }
                />

                {/* U-15: the tray is above everything the Author has to act on; the decided list below it. */}
                <IdeasTray
                    ideas={view.ideas}
                    phase={story.phase}
                    // D-29: a selection is a recorded decision, so the write carries the note that made it.
                    onSelect={
                        actions.selectIdea
                            ? (ideaId) => void actions.selectIdea?.(story.id, ideaId, SELECT_NOTE)
                            : undefined
                    }
                    onDiscard={
                        actions.discardIdea ? (ideaId) => void actions.discardIdea?.(story.id, ideaId) : undefined
                    }
                    onDefer={actions.deferIdea ? (ideaId) => void actions.deferIdea?.(story.id, ideaId) : undefined}
                />

                <PlotlineChapters
                    view={view}
                    actions={actions}
                    paused={paused}
                    liveRuns={liveRuns}
                    killedRuns={killedRuns}
                />

                {otherUnits.length > 0 ? (
                    <RevisionsCompare
                        units={otherUnits}
                        onSelectRevision={actions.selectRevision}
                        note="competing drafts of the Summary or a plotline — visible to the Editor and the Author, never to a Writer (D-21)"
                    />
                ) : null}

                <GoalPanel
                    goal={goal.goal}
                    phase={story.phase}
                    progress={goal.phase_progress}
                    failing={goal.failing}
                    chapterProgress={goal.chapter_progress}
                    chapters={view.chapters}
                    onPatchGoal={actions.patchGoal ? (patch) => void actions.patchGoal?.(story.id, patch) : undefined}
                    onSetChapterBar={
                        actions.setChapterBar
                            ? (chapterId, override) => void actions.setChapterBar?.(story.id, chapterId, override)
                            : undefined
                    }
                />

                <CostDistributionPanel distribution={view.cost_distribution} />

                {view.digest ? (
                    // D-12a: the Digest is derived by the engine, and any past one is reconstructible —
                    // the Author can see what a reviewer was actually told when it judged.
                    <details className="sv-digest">
                        <summary>
                            Digest rev {view.digest.rev}{' '}
                            {view.digest.stale ? '· stale — it blocks a review, never a fix (D-14)' : ''}{' '}
                            (engine-derived, no agent wrote it · D-12a)
                        </summary>
                        <pre className="sv-digest-body">{view.digest.body}</pre>
                    </details>
                ) : null}
            </div>

            <div className="sv-story-rail">
                <CrewPanel runs={view.runs} templates={view.templates} now={now} onKillRun={actions.killRun} />
                <TemplatesPanel
                    templates={view.templates}
                    story={story}
                    onCreate={actions.createTemplate}
                    onPatch={actions.patchTemplate}
                    onAssign={actions.assignTemplates}
                />
            </div>
        </div>
    );
}
