// U-6 / G-1 / G-2 — the Goal panel: the criteria list with live pass/fail, the failing
// evidence, the `fix_hint`, and the Author's controls (toggle hard, delete, add, threshold,
// per-chapter bar override).
//
// G-2 is the rule that decides most of this file's shape: progress renders as the server's own
// string ("4/7 · failing: C-4, C-5"), **per phase**, with every failure naming its `fix_hint`,
// and a bare percentage is a build defect. So the panel never does arithmetic on the counts —
// it prints `goal.phase_progress` verbatim and only ever marks a criterion failing when the
// server named it failing.
//
// G-2's other half: a phase's criteria MUST NOT read as failing before that phase is reached
// (L-14 makes an unreached level `n/a`, not `0/n`), so the levels ahead of the Story are listed
// in a collapsed "not reached" group with no pass/fail badge at all.
import { useState } from 'react';
import { LEVELS, LEVEL_LABELS, LEVEL_QUESTIONS, PER_CHAPTER } from '../../shared/criteria';
import { CRITERION_CHECKERS } from '../../shared/types';
import type { Chapter, Criterion, CriterionChecker, Goal, StoryPhase } from '../../shared/types';
import type { GoalFailingLine, GoalCriterionOp, GoalPatch } from './story-contract';

/** Which levels belong to which phase (§5.2's levels table; ③ carries the whole-Story level too). */
function phaseLevels(phase: StoryPhase): Array<'summary' | 'plotlines' | 'chapters' | 'whole'> {
    if (phase === 'summary') {
        return ['summary'];
    }
    if (phase === 'plotlines') {
        return ['plotlines'];
    }
    return ['chapters', 'whole'];
}

export interface GoalPanelProps {
    goal: Goal;
    phase: StoryPhase;
    /** G-2 — the server's per-phase progress string, printed exactly as it arrives. */
    progress: string;
    failing: GoalFailingLine[];
    /** chapter id -> the server's per-chapter progress string. */
    chapterProgress: Record<string, string>;
    chapters: Chapter[];
    /**
     * G-1: every one of these is the Author's right; absent means the endpoint has not landed.
     *
     * The patch is the ROUTE's shape (`GoalPatch` — threshold plus criterion OPS), not a whole
     * criteria list, because the two are not the same statement: sending the list says "these and
     * only these", and a threshold-only edit would then rewrite every criterion's `hard` flag from
     * a possibly stale copy. An op says exactly what changed, in order (G-1), and nothing else.
     */
    onPatchGoal?: (patch: GoalPatch) => void;
    onSetChapterBar?: (chapterId: string, override: string) => void;
}

export function GoalPanel({
    goal,
    phase,
    progress,
    failing,
    chapterProgress,
    chapters,
    onPatchGoal,
    onSetChapterBar
}: GoalPanelProps) {
    // The failing lines are keyed once so each criterion row can read its own evidence + hint.
    const failingById = new Map(failing.map((line) => [line.criterion, line]));
    const criterionById = new Map(goal.criteria.map((criterion) => [criterion.id, criterion]));

    const levels = phaseLevels(phase);
    const reached = new Set<string>([...levels.flatMap((level) => LEVELS[level]), ...PER_CHAPTER]);
    const ahead = goal.criteria.filter((criterion) => !reached.has(criterion.id));

    const [thresholdDraft, setThresholdDraft] = useState(String(goal.threshold_soft));
    const [barDrafts, setBarDrafts] = useState<Record<string, string>>(() =>
        Object.fromEntries(chapters.map((chapter) => [chapter.id, chapter.bar_override ?? '']))
    );
    const [draft, setDraft] = useState({
        id: '',
        label: '',
        question: '',
        checker: 'judge' as CriterionChecker,
        hard: false,
        fix_hint: ''
    });

    /**
     * G-1 — one edit, sent as the ops it actually is. The threshold travels only when it changed,
     * because `PATCH /stories/:id/goal` applies what arrives and a stray `threshold_soft` in a
     * delete-only patch is a second, unintended write.
     */
    const patchGoal = (criteria: GoalCriterionOp[]): void => onPatchGoal?.({ criteria });

    return (
        <section className="sv-pane sv-goal" aria-label="Goal">
            <header className="sv-pane-head">
                <h3 className="sv-pane-title">Goal — {goal.title}</h3>
                {/* P6: pass/fail criteria, never a score. G-2: and never a percentage either. */}
                <span className="sv-pane-badge">pass/fail criteria, not scores (P6)</span>
            </header>

            {/* G-2 — the number line, verbatim from the server. */}
            <p className="sv-goal-progress">{progress}</p>

            {levels.map((level) => (
                <div className="sv-goal-level" key={level}>
                    {/* G-2 renders per-phase progress per level, so the level is named, not implied. */}
                    <h4 className="sv-goal-level-title">{LEVEL_LABELS[level]}</h4>
                    <p className="sv-goal-level-question">{LEVEL_QUESTIONS[level]}</p>

                    <ul className="sv-goal-criteria">
                        {LEVELS[level].map((id) => {
                            const criterion = criterionById.get(id);
                            if (!criterion) {
                                // The Author deleted this criterion (G-1) but the roster still names it.
                                return (
                                    <li className="sv-criterion sv-criterion-missing" key={id}>
                                        <span className="sv-criterion-id">{id}</span>
                                        <span className="sv-criterion-label">
                                            removed from this Story&apos;s Goal (G-1)
                                        </span>
                                    </li>
                                );
                            }

                            const failure = failingById.get(id);

                            return (
                                <li
                                    className={`sv-criterion${failure ? ' sv-criterion-failing' : ' sv-criterion-passing'}`}
                                    key={id}
                                >
                                    <span className="sv-criterion-state" aria-label={failure ? 'failing' : 'passing'}>
                                        {failure ? '✗' : '✓'}
                                    </span>
                                    <span className="sv-criterion-id">{id}</span>
                                    <span className="sv-criterion-label">{criterion.label}</span>
                                    {/* G-3: `code` runs on the server with no model call; the badge says which is which. */}
                                    <span className="sv-criterion-checker">{criterion.checker}</span>
                                    <span
                                        className={`sv-criterion-hard${criterion.hard ? ' sv-criterion-hard-on' : ''}`}
                                    >
                                        {criterion.hard ? 'hard' : 'soft'}
                                    </span>

                                    {/* G-1: toggle hard, delete. The Author owns the Goal, not the crew (§7). */}
                                    <button
                                        type="button"
                                        className="sv-criterion-toggle"
                                        disabled={!onPatchGoal}
                                        title={
                                            onPatchGoal
                                                ? `Make ${id} ${criterion.hard ? 'soft' : 'hard'} (G-1)`
                                                : 'Goal edits land with the API'
                                        }
                                        // G-1: the hard/soft dial is the Author's, and it is one op — the
                                        // criterion stays exactly as it is apart from `hard`.
                                        onClick={() => patchGoal([{ op: 'setHard', id, hard: !criterion.hard }])}
                                    >
                                        toggle {criterion.hard ? 'soft' : 'hard'}
                                    </button>
                                    <button
                                        type="button"
                                        className="sv-criterion-delete"
                                        disabled={!onPatchGoal}
                                        title={
                                            onPatchGoal
                                                ? `Drop ${id} from this Story's Goal (G-1)`
                                                : 'Goal edits land with the API'
                                        }
                                        onClick={() => patchGoal([{ op: 'remove', id }])}
                                    >
                                        delete
                                    </button>

                                    {failure ? (
                                        <div className="sv-criterion-failure">
                                            {/* D-15: a failing line with no citation is invalid, so evidence is expected — and shown. */}
                                            {failure.evidence ? (
                                                <p className="sv-criterion-evidence">evidence — {failure.evidence}</p>
                                            ) : null}
                                            {/* G-2: every failure names the smallest change that would satisfy it. */}
                                            <p className="sv-criterion-hint">fix — {failure.fix_hint}</p>
                                        </div>
                                    ) : null}
                                </li>
                            );
                        })}
                    </ul>
                </div>
            ))}

            {ahead.length > 0 ? (
                // G-2 / L-14: an unreached level is `n/a`, so these carry no badge and no failure.
                <details className="sv-goal-ahead">
                    <summary>
                        Levels this Story has not reached ({ahead.length}) — shown without pass/fail (G-2)
                    </summary>
                    <ul className="sv-goal-criteria">
                        {ahead.map((criterion) => (
                            <li className="sv-criterion sv-criterion-ahead" key={criterion.id}>
                                <span className="sv-criterion-id">{criterion.id}</span>
                                <span className="sv-criterion-label">{criterion.label}</span>
                                <span className="sv-criterion-checker">{criterion.checker}</span>
                            </li>
                        ))}
                    </ul>
                </details>
            ) : null}

            <div className="sv-goal-controls">
                <div className="sv-goal-threshold">
                    <label htmlFor="sv-threshold">Soft threshold — soft passes needed to pass (G-1)</label>
                    <input
                        id="sv-threshold"
                        type="number"
                        min={0}
                        value={thresholdDraft}
                        disabled={!onPatchGoal}
                        onChange={(event) => setThresholdDraft(event.target.value)}
                    />
                    <button
                        type="button"
                        className="sv-goal-threshold-save"
                        disabled={!onPatchGoal}
                        onClick={() => onPatchGoal?.({ threshold_soft: Number(thresholdDraft), criteria: [] })}
                    >
                        Set threshold
                    </button>
                </div>

                {/* G-1 / §14 item 2: the bar is per-Story with a per-chapter override, so the ending can be held higher than chapter 3. */}
                <div className="sv-goal-bars">
                    <h4>Per-chapter bar override (G-1)</h4>
                    <ul className="sv-goal-bar-rows">
                        {chapters.map((chapter) => (
                            <li className="sv-goal-bar-row" key={chapter.id}>
                                <span className="sv-goal-bar-title">
                                    Ch {chapter.order} — {chapter.title}
                                </span>
                                {/* `last_score` is rendered, never re-scored (P6, §4.4). */}
                                <span className="sv-goal-bar-progress">
                                    {chapterProgress[chapter.id] ?? chapter.last_score ?? 'n/a'}
                                </span>
                                <input
                                    type="text"
                                    className="sv-goal-bar-input"
                                    placeholder="e.g. drop C-12 · +1 soft"
                                    value={barDrafts[chapter.id] ?? ''}
                                    disabled={!onSetChapterBar}
                                    onChange={(event) =>
                                        setBarDrafts((current) => ({ ...current, [chapter.id]: event.target.value }))
                                    }
                                />
                                <button
                                    type="button"
                                    className="sv-goal-bar-save"
                                    disabled={!onSetChapterBar}
                                    onClick={() => onSetChapterBar?.(chapter.id, barDrafts[chapter.id] ?? '')}
                                >
                                    Set bar
                                </button>
                                {chapter.bar_override ? (
                                    <span className="sv-goal-bar-current">current: {chapter.bar_override}</span>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                </div>

                {/* G-1: add a criterion — the full §5.1 shape, because a criterion with no `question` is a
                    criterion no fresh reviewer can answer (P4), and one with no `fix_hint` breaks G-2. */}
                <div className="sv-goal-add">
                    <h4>Add a criterion (G-1)</h4>
                    <div className="sv-goal-add-grid">
                        <input
                            type="text"
                            placeholder="id (e.g. C-16)"
                            value={draft.id}
                            onChange={(event) => setDraft({ ...draft, id: event.target.value })}
                        />
                        <input
                            type="text"
                            placeholder="label"
                            value={draft.label}
                            onChange={(event) => setDraft({ ...draft, label: event.target.value })}
                        />
                        <input
                            type="text"
                            placeholder="the exact question a reviewer answers"
                            value={draft.question}
                            onChange={(event) => setDraft({ ...draft, question: event.target.value })}
                        />
                        <select
                            value={draft.checker}
                            onChange={(event) =>
                                setDraft({ ...draft, checker: event.target.value as CriterionChecker })
                            }
                        >
                            {CRITERION_CHECKERS.map((checker) => (
                                <option key={checker} value={checker}>
                                    {checker}
                                </option>
                            ))}
                        </select>
                        <label className="sv-goal-add-hard">
                            <input
                                type="checkbox"
                                checked={draft.hard}
                                onChange={(event) => setDraft({ ...draft, hard: event.target.checked })}
                            />
                            hard
                        </label>
                        <input
                            type="text"
                            className="sv-goal-add-hint"
                            placeholder="fix_hint — the smallest change that satisfies it"
                            value={draft.fix_hint}
                            onChange={(event) => setDraft({ ...draft, fix_hint: event.target.value })}
                        />
                    </div>
                    <button
                        type="button"
                        className="sv-goal-add-save"
                        disabled={!onPatchGoal || draft.id.length === 0 || draft.label.length === 0}
                        onClick={() => {
                            // G-1: an added criterion arrives as the full §5.1 record — `question` and
                            // `fix_hint` included, because a criterion without them cannot be judged (P4, G-2).
                            patchGoal([{ op: 'add', criterion: { ...draft } }]);
                            setDraft({ id: '', label: '', question: '', checker: 'judge', hard: false, fix_hint: '' });
                        }}
                    >
                        Add criterion
                    </button>
                </div>
            </div>
        </section>
    );
}
