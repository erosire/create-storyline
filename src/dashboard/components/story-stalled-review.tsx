// U-1a / L-23 — the STALLED screen: the Author's review surface, not a log.
//
// U-1a names five things this screen owes the Author: the stuck criteria, the oldest open findings,
// the chapters involved, WHAT THE CREWS TRIED across rounds, and L-23's four exits as buttons. The
// first three exist elsewhere on the Story view (the Goal panel and the per-chapter finding rows),
// which is exactly the problem U-1a calls out: a stalled Story is a question spread over five panes.
// This block gathers them into one review surface and puts the four exits under them, so the Author
// reads the failure and reaches a move without scrolling.
//
// "What the crews tried" is the loop's own round history (`level_history`, written every round by
// `recordRound` in server/loop/trend.ts and projected into the Story view, U-1a). It is rendered as
// L-14's level sentence — the same words the trend is computed from — because the Author's question
// is "did the numbers move?", and the answer is two `n/m` pairs side by side.
//
// THE FOUR EXITS (L-23), and why each is a BUTTON and not prose:
//   1. the contract was wrong            → backtrack to the phase that owns it (or edit the unlocked
//      contract in the panes below; the backtrack is the exit that also re-arms, so it is the button)
//   2. the crew's taste or brief was wrong → edit a template's `selection_rules`
//   3. the crew needed a decision         → issue a directive
//   4. this criterion does not matter     → lower the Goal's bar
// L-23's closing sentence is the contract this component relies on: every one of those re-arms the
// Story to `ready`, so none of them needs a Resume afterwards.
//
// Like the rest of this directory, it is a pure function of `{ view, actions }` and every control is
// disabled with its own explanation when the action has not landed, rather than inventing an endpoint.
import { useState } from 'react';
import type { CriterionLevel } from '../../shared/criteria';
import type { LevelHistoryRow } from '../api';
import { isLiveRun } from './story-contract';
import type { StoryActions, StoryViewData } from './story-contract';
import type { BacktrackTarget } from './story-contract';
import type { Finding, StoryPhase } from '../../shared/types';

/**
 * L-14's level names ("`idea→summary 4/4 · summary→plotlines 6/6`"). `server/loop/trend.ts` owns this
 * rendering — the Story row's own `consistency` sentence is built there — and the round lines repeat
 * it so the history and the row read identically. `whole` has no arrow in L-14's sentence, so it reads
 * as its own clause.
 */
const LEVEL_LABELS: Record<string, string> = {
    summary: 'idea→summary',
    plotlines: 'summary→plotlines',
    chapters: 'plotlines→chapters',
    whole: 'whole-story'
};

/** L-14's fixed order, so the round line reads the same way every time and never reshuffles. */
const LEVEL_ORDER: CriterionLevel[] = ['summary', 'plotlines', 'chapters', 'whole'];

/** One round, as one sentence: the numbers, what closed, what came back, what the trend decided. */
function roundLine(entry: LevelHistoryRow): string {
    const levels = LEVEL_ORDER.filter((level) => entry.levels[level] !== undefined)
        .map((level) => `${LEVEL_LABELS[level] ?? level} ${entry.levels[level]}`)
        .join(' · ');

    const parts = [`round ${entry.round} · ${entry.phase} · ${levels || 'no level reached yet'}`];

    // L-15's three signals, named only when they happened — a line of zeros reads as noise.
    if (entry.fingerprint_closed.length > 0) parts.push(`closed ${entry.fingerprint_closed.join(', ')}`);
    if (entry.fingerprint_reopened.length > 0) parts.push(`came back ${entry.fingerprint_reopened.join(', ')}`);
    if (entry.findings_confirmed_new.length > 0)
        parts.push(`${entry.findings_confirmed_new.length} new confirmed finding(s)`);

    // L-21: the streak is the number that produced this trend, so the Author can see the stall coming.
    parts.push(`flat streak ${entry.flat_streak} · trend ${entry.trend}`);

    return parts.join(' — ');
}

/**
 * The phase whose CONTRACT owns the stall (L-23's first exit). The stuck artifacts are the ones the
 * current phase is producing, so the contract to fix is the one they were written against: chapters
 * come from the plotlines, plotlines from the Summary, and the Summary is aimed at by the Seed.
 */
export function contractOwner(phase: StoryPhase): BacktrackTarget {
    return phase === 'chapters' ? 'plotlines' : 'summary';
}

/** The findings this screen shows: still open, oldest first (U-1a's "oldest open findings"). */
function oldestOpenFindings(view: StoryViewData): Finding[] {
    return view.findings
        .filter((finding) => finding.state !== 'fixed' && finding.state !== 'discarded')
        .slice()
        .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id))
        .slice(0, 5);
}

/** The chapters the open findings point at, by title — U-1a's "the chapters involved". */
function involvedChapters(view: StoryViewData, findings: Finding[]): string[] {
    const refs = new Set<string>();

    for (const finding of findings) {
        refs.add(finding.target_ref);
        // L-11a: a finding names the other artifacts it touches, and those chapters are involved too.
        for (const ref of finding.related_refs ?? []) refs.add(ref);
    }

    return view.chapters
        .filter((chapter) => refs.has(chapter.id))
        .map((chapter) => `ch. ${chapter.order} — ${chapter.title}`);
}

export interface StalledReviewProps {
    view: StoryViewData;
    actions: StoryActions;
}

export function StalledReview({ view, actions }: StalledReviewProps) {
    const { story, goal } = view;
    const history = view.level_history ?? [];
    const findings = oldestOpenFindings(view);
    const chapters = involvedChapters(view, findings);
    const owner = contractOwner(story.phase);
    // L-25's clean-ledger note is not this screen's problem; the runs are, because a stalled Story with
    // live runs is still being worked on while the Author reads.
    const live = view.runs.filter(isLiveRun).length;

    // L-23's exits 2 and 3 need one field of input each. Uncontrolled local state is right here: the
    // value is the Author's draft of a decision, not a projection, and it must not survive a refresh.
    const [rules, setRules] = useState('');
    const [directive, setDirective] = useState('');
    const [templateId, setTemplateId] = useState(view.templates[0]?.id ?? '');
    const currentBar = goal.goal.threshold_soft;
    const [bar, setBar] = useState(Math.max(0, currentBar - 1));

    return (
        <section className="sv-stalled-review" aria-label="The Story is stalled — the review surface (U-1a)">
            <h3 className="sv-stalled-title">Stalled — what the crews tried, and the four exits (U-1a, L-23)</h3>
            {live > 0 ? (
                <p className="sv-stalled-live">{live} run(s) still working while you read this (S-3).</p>
            ) : null}

            {/* U-1a, item 1: the stuck criteria, in the engine's own words (G-1's `fix_hint`). */}
            <div className="sv-stalled-criteria">
                <h4 className="sv-stalled-sub">Stuck criteria ({goal.failing.length})</h4>
                {goal.failing.length === 0 ? (
                    <p className="sv-stalled-none">
                        No criterion is failing — the stall is the loop running out of moves (L-21), not a rule going
                        red.
                    </p>
                ) : (
                    <ul className="sv-stalled-criteria-list">
                        {goal.failing.map((failure) => (
                            <li className="sv-stalled-criterion" key={failure.criterion}>
                                <span className="sv-stalled-criterion-id">{failure.criterion}</span>
                                <span className="sv-stalled-criterion-fix">{failure.fix_hint}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            {/* U-1a, item 2 and 3: the oldest open findings, and the chapters they involve. */}
            <div className="sv-stalled-findings">
                <h4 className="sv-stalled-sub">Oldest open findings ({findings.length})</h4>
                {findings.length === 0 ? (
                    <p className="sv-stalled-none">No open finding — nothing is waiting on the approval gate.</p>
                ) : (
                    <ul className="sv-stalled-finding-list">
                        {findings.map((finding) => (
                            <li className="sv-stalled-finding" key={finding.id}>
                                <span className={`sv-finding-cost sv-cost-${finding.cost}`}>{finding.cost}</span>
                                <span className="sv-stalled-finding-title">{finding.title}</span>
                                <span className="sv-stalled-finding-state">{finding.state}</span>
                            </li>
                        ))}
                    </ul>
                )}
                {chapters.length > 0 ? (
                    <p className="sv-stalled-chapters">Chapters involved: {chapters.join(', ')}</p>
                ) : null}
            </div>

            {/* U-1a, item 4: WHAT THE CREWS TRIED. This is the loop's own memory of the rounds, so the
                Author can see the numbers refusing to move instead of trusting the trend label. */}
            <div className="sv-stalled-rounds">
                <h4 className="sv-stalled-sub">What the crews tried across rounds (L-15, L-21)</h4>
                {history.length === 0 ? (
                    <p className="sv-stalled-none">
                        No round has been recorded yet — the crews have not completed a pass since the Story started
                        (L-15).
                    </p>
                ) : (
                    <ol className="sv-stalled-round-list">
                        {history.map((entry) => (
                            <li className="sv-stalled-round" key={entry.round}>
                                {roundLine(entry)}
                            </li>
                        ))}
                    </ol>
                )}
            </div>

            {/* L-23: the four exits, as buttons. Every one re-arms the Story to `ready`. */}
            <div className="sv-stalled-exits" aria-label="The four exits (L-23)">
                <button
                    type="button"
                    className="sv-exit sv-exit-contract"
                    disabled={!actions.backtrack}
                    title={`The contract behind these chapters is the thing that is wrong. Backtracking to ${owner} deletes what the later phases built and re-arms the Story (L-31, L-23).`}
                    onClick={() => void actions.backtrack?.(story.id, owner)}
                >
                    Fix the contract — backtrack to {owner}
                </button>

                <textarea
                    className="sv-exit-rules"
                    aria-label="Template selection rules (L-23)"
                    placeholder="The crew's taste or its brief was wrong — rewrite the selection rules (U-8, L-23)"
                    value={rules}
                    disabled={!actions.patchTemplate}
                    onChange={(event) => setRules(event.target.value)}
                />
                <select
                    className="sv-exit-template-pick"
                    aria-label="Which template (L-23)"
                    value={templateId}
                    disabled={!actions.patchTemplate}
                    onChange={(event) => setTemplateId(event.target.value)}
                >
                    {view.templates.map((template) => (
                        <option value={template.id} key={template.id}>
                            {template.name}
                        </option>
                    ))}
                </select>
                <button
                    type="button"
                    className="sv-exit sv-exit-template"
                    disabled={!actions.patchTemplate || templateId === '' || rules.trim() === ''}
                    title="Saves new selection rules on the chosen template; the next run of that role is briefed with them (U-8, L-23)."
                    onClick={() => void actions.patchTemplate?.(templateId, { selection_rules: rules })}
                >
                    Fix the brief — save these selection rules
                </button>

                <input
                    className="sv-exit-directive-text"
                    aria-label="Directive text (L-23)"
                    type="text"
                    placeholder="The crew needed a decision — say which (L-23)"
                    value={directive}
                    disabled={!actions.sendDirective}
                    onChange={(event) => setDirective(event.target.value)}
                />
                <button
                    type="button"
                    className="sv-exit sv-exit-directive"
                    disabled={!actions.sendDirective || directive.trim() === ''}
                    title="A directive is a record the crews read on their next brief, and issuing one re-arms the Story (D-9, L-23)."
                    onClick={() => void actions.sendDirective?.(story.id, directive)}
                >
                    Issue the directive
                </button>

                <select
                    className="sv-exit-bar-value"
                    aria-label="New threshold (L-23)"
                    value={bar}
                    disabled={!actions.patchGoal}
                    onChange={(event) => setBar(Number(event.target.value))}
                >
                    {barChoices(currentBar).map((choice) => (
                        <option value={choice} key={choice}>
                            {choice} of {goal.goal.criteria.length} criteria
                        </option>
                    ))}
                </select>
                <button
                    type="button"
                    className="sv-exit sv-exit-bar"
                    disabled={!actions.patchGoal || bar >= currentBar}
                    title={`The soft threshold is ${currentBar}. Lowering it is L-23's last exit: this criterion does not matter to me, and it re-arms the Story.`}
                    onClick={() => void actions.patchGoal?.(story.id, { threshold_soft: bar, criteria: [] })}
                >
                    Lower the bar to {bar}
                </button>
            </div>
            <p className="sv-stalled-note">
                Every one of these re-arms the Story to ready — no Resume afterwards (L-23). The bar and the criteria
                are the same Goal the panel below edits (G-1).
            </p>
        </section>
    );
}

/** The thresholds the bar exit offers: the current one (a no-op) and everything below it (L-23). */
function barChoices(current: number): number[] {
    return Array.from({ length: current + 1 }, (_unused, index) => current - index);
}
