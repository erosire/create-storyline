// U-7 / D-18 / S-3 / S-6 / S-7 / U-8d — the live-thread (crew) panel.
//
// VOCABULARY (V-1): a row here is a THREAD, not a "phrase" and not an employee. A dispatched Run
// opens one thread inside the Story phase's session (the UI's "phrase": P1/P3/P4), under the
// employee kind the template role names; the employee is the standing identity, and it is an agent
// only for the life of that thread. D-18 makes `runs` the data source precisely so a row exists
// from spawn to teardown, and the Author can watch a thread and pull the cord on that one thread
// (U-7's kill button).
//
// V-3 — AND THE WORD "PHRASE" NOW MEANS ONE THING HERE. This panel used to call every row a phrase
// ("Phrases — live on this story", "No phrase is running"), which is the same word the rail uses for a
// PIPELINE STAGE (Phrase ① Summary, Phrase ② Plotlines). The collision is what made symptom 3 legible as
// "the staff went back to Phrase 1": a thread the loop dispatched against Phrase ②'s chapter rows sat under
// a rail lit on Phrase ① with nothing on the row to say otherwise. The rows are THREADS — the word this
// file's own header has always used — and the PHRASE is now a separate, server-derived mark on the row
// (`api.ts:ProjectedRun.phrase_key`, derived in `server/api/projections.ts:runPhraseKeyOf`).
//
// S-7 is the nesting rule: a delegated sub-context (D-17e) is a THREAD the parent run spun to do a
// task, not a Work Item, so it gets no row of its own — the Author's unit of attention and of
// control is the dispatched thread. It is drawn nested under its parent, and the parent stays the
// only row with a kill button.
//
// U-8d is the disagreement marker: when a role's N agents disagreed, the dissent is supposed to
// be named in the `selection_note`, and the Author needs to know which authoritative answers were
// unanimous and which were not (D-38). S-6's elapsed time is shown because it answers "why is
// this taking an hour?" — E-0 forbids reading it as a limit.
import { formatElapsed, isLiveRun, panelDissent } from './story-contract';
// R4 — the phrase mark comes from the rail's OWN vocabulary list, so "Phrase 2 — Plotlines" is one string in the
// desk. The projection ships a phrase KEY (`api.ts:RunPhraseKey`), never a label: a rail that renumbers cannot
// leave the crew panel printing the old number.
import { ALL_STORY_PHRASES, phraseLabel } from './story-nav';
import type { ProjectedRun, RunPhraseKey } from '../api';
import type { RoleKind, Template } from '../../types';

/** U-8a: the crew that WRITES must never be confused with the crew that judges. */
function roleClass(role: RoleKind): string {
    return `sv-run-kind sv-kind-${role}${role === 'writer' ? ' sv-kind-writer' : ''}`;
}

/**
 * R4 — the phrase mark on a thread row: the words, the tooltip that says HOW they were derived, and the class
 * the row wears.
 *
 * THE HONEST HALF IS THE POINT. `'unknown'` and an absent key both print "phrase not named", and neither falls
 * back to Phrase ①. A shared-family pass (`wi_review_groups_*`, `wi_summary_score_*`, `wi_group_check_*`) is
 * keyed on a group VECTOR hash that both phrases mint, so the desk genuinely cannot say which one it served
 * from the key alone — and quietly showing Phrase ① there is the exact default R4 removes. The tooltip names
 * the witness that WOULD have answered (the group set the thread holds, or the phrase the claim key is keyed
 * on), because "we cannot tell" is only useful if the Author can tell why.
 */
function phraseMark(key: RunPhraseKey | undefined): { text: string; title: string; tone: RunPhraseKey } {
    const phrase = key === undefined || key === 'unknown' ? undefined : ALL_STORY_PHRASES.find((row) => row.key === key);

    if (phrase !== undefined && key !== undefined) {
        return {
            text: phraseLabel(phrase),
            title: `which phrase this thread belongs to, read off the group rows it holds or the phrase its claim key is keyed on (R4, V-3)`,
            tone: key
        };
    }

    return {
        text: 'phrase not named',
        title:
            key === 'unknown'
                ? 'this pass claims a group-set hash both phrases mint, and it holds no group rows, so neither phrase can be named from it — the desk says so rather than defaulting to Phrase 1 (R4)'
                : 'this row came from a route that attributes no phrase; only the crew listing does, and the desk will not invent one (R4)',
        tone: 'unknown'
    };
}

/** The role row inside a template that carries the run's kind — the source of `agents`/`aggregate` (D-38). */
function panelOf(template: Template | undefined, role: RoleKind): { agents: number; aggregate?: string } | null {
    const match = template?.roles.find((candidate) => candidate.kind === role);
    const agents = match?.agents ?? 1;
    return agents > 1 ? { agents, aggregate: match?.aggregate } : null;
}

export interface CrewPanelProps {
    /**
     * R4 — the rows are the crew listing's PROJECTED rows: each carries the phrase it belongs to
     * (`api.ts:ProjectedRun.phrase_key`), which is what lets a Phrase-② thread say so out loud.
     */
    runs: ProjectedRun[];
    templates: Template[];
    /** Injected so elapsed time is deterministic instead of reading the wall clock (a test must know the answer). */
    now: string;
    onKillRun?: (runId: string) => void;
}

export function CrewPanel({ runs, templates, now, onKillRun }: CrewPanelProps) {
    const live = runs.filter(isLiveRun);
    const closed = runs.filter((run) => !isLiveRun(run));

    const renderRun = (run: ProjectedRun) => {
        const template = templates.find(
            (candidate) => candidate.id === run.template_ref || candidate.name === run.template_ref
        );
        const panel = panelOf(template, run.role);
        const dissent = panelDissent(run);

        return (
            // S-RUNTIME: the panel lists every Story's runs when no Story is selected, and a run id is local
            // to one Story's book — two Stories both have a `run_0`. The Story id is what tells them apart
            // (the row carries it, and the crew panel's own rows are tagged), so the key is the pair.
            <li className={`sv-run${run.role === 'writer' ? ' sv-run-writer' : ''}`} key={`${run.story_id}:${run.id}`}>
                <div className="sv-run-head">
                    {/* U-7: role and kind, with the kind as a badge so the writer reads different at a glance. */}
                    <span className={roleClass(run.role)}>{run.role}</span>
                    <span className="sv-run-template">{template?.title ?? run.template_ref ?? 'no template'}</span>
                    <span className={`sv-run-state sv-run-state-${run.state}`}>{run.state}</span>
                    <span className="sv-run-elapsed" title="wall-clock, informational only (S-6, E-0)">
                        {formatElapsed(run.started_at, run.ended_at, now)}
                    </span>
                    {/* S-6 / E-0: tokens are shown and explicitly not a limit. */}
                    <span className="sv-run-tokens">
                        {run.tokens.toLocaleString('en-US')} tokens (informational — E-0)
                    </span>
                    {run.kind === 'assistant' ? (
                        <span className="sv-run-assistant">an assistant run you invoked (§8.6)</span>
                    ) : null}
                    {run.no_op ? (
                        <span className="sv-run-noop">no-op turn — it counts toward loop detection (S-4)</span>
                    ) : null}
                </div>

                <div className="sv-run-work">
                    {/* R4 / V-3 — WHICH PHRASE this thread is working on, printed beside the claim it holds. The
                        claim key alone is a machine string (`wi_draft_groups_<ref>_<hash>_a2`), and the rail's
                        lit row is the only other phrase word on screen; between them they told the Author
                        nothing about which phrase the crew was actually on. Derived server-side, never guessed
                        here. */}
                    {(() => {
                        const mark = phraseMark(run.phrase_key);

                        return (
                            <span className={`sv-run-phrase sv-run-phrase-${mark.tone}`} title={mark.title}>
                                {mark.text}
                            </span>
                        );
                    })()}
                    {/* U-7: "what it is doing, which task it holds" — the Work Item is the claim it leased (L-2). */}
                    {run.work_item_ref ? (
                        <span className="sv-run-task">holds {run.work_item_ref}</span>
                    ) : (
                        <span className="sv-run-task">no work item claimed yet</span>
                    )}
                    {template?.done_definition ? (
                        <span className="sv-run-done">done when: {template.done_definition}</span>
                    ) : null}
                </div>

                {panel ? (
                    // U-8d: "this Editor is three agents that argue and return one answer" is invisible
                    // unless the row says so, and the loop still receives exactly ONE report (D-38).
                    <p className="sv-run-panel">
                        panel of {panel.agents} {run.role} agents inside this one run · aggregate:{' '}
                        {panel.aggregate ?? 'merge'} · the loop gets one report (D-38)
                    </p>
                ) : null}

                {dissent ? (
                    // U-8d: the dissent belongs in the `selection_note`; the marker is what sends the Author there.
                    <p className="sv-run-dissent" role="status">
                        the run reported disagreement: {dissent}
                    </p>
                ) : null}

                {run.delegated.length > 0 ? (
                    // S-7: nested children, no rows of their own, no kill button of their own.
                    <ul className="sv-run-delegated">
                        {run.delegated.map((entry, index) => (
                            <li className="sv-delegated" key={`${run.id}-${entry.role}-${index}`}>
                                <span className="sv-delegated-role">{entry.role}</span>
                                <span className="sv-delegated-task">{entry.task}</span>
                                {entry.summary ? <span className="sv-delegated-summary">{entry.summary}</span> : null}
                                <span className="sv-delegated-tokens">
                                    {entry.tokens.toLocaleString('en-US')} tokens
                                </span>
                                <span className="sv-delegated-note">
                                    {/* V-3 — the sub-context is a thread THIS RUN spun, not a phrase: the word
                                        "phrase" on this line is what made a nested thread read as a pipeline stage. */}
                                    a thread this run spun — not a work item (S-7, T-2b)
                                </span>
                            </li>
                        ))}
                    </ul>
                ) : null}

                {isLiveRun(run) ? (
                    <button
                        type="button"
                        className="sv-run-kill"
                        disabled={!onKillRun}
                        // S-3: teardown is unconditional, and the row records why it ended.
                        title="Tear this thread down; the Story keeps running (D-18, S-3)"
                        onClick={() => onKillRun?.(run.id)}
                    >
                        Kill run
                    </button>
                ) : (
                    <p className="sv-run-ended">
                        ended {run.ended_at ?? '—'}
                        {run.end_reason ? ` · ${run.end_reason}` : ''}
                    </p>
                )}
            </li>
        );
    };

    return (
        // V-3 — the region names THREADS, because a row here is one dispatched run and the numbered PHRASES are
        // the rail's. The phrase each thread belongs to is the mark on the row, not the heading.
        <aside className="sv-pane sv-crew" aria-label="Crew threads">
            <header className="sv-pane-head">
                <h3 className="sv-pane-title">Threads — live on this story (U-7)</h3>
                <span className="sv-pane-badge">{live.length} running</span>
            </header>

            {live.length === 0 ? <p className="sv-crew-idle">No thread is running on this story right now.</p> : null}
            <ul className="sv-runs">{live.map(renderRun)}</ul>

            {closed.length > 0 ? (
                <details className="sv-crew-closed">
                    <summary>{closed.length} threads torn down — each row says why it ended (S-3)</summary>
                    <ul className="sv-runs">{closed.map(renderRun)}</ul>
                </details>
            ) : null}
        </aside>
    );
}
