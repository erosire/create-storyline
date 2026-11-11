// U-7 / D-18 / S-3 / S-6 / S-7 / U-8d — the crew panel.
//
// The right region is the CREW, not an agent list (§10.1): the Author controls the harnesses and
// watches what they are doing to the selected Story. D-18 makes `runs` the data source precisely
// so a row exists from spawn to teardown — the Author can watch a run and pull the cord on that
// one run (U-7's kill button).
//
// S-7 is the nesting rule: a delegated sub-context (D-17e) is NOT a Work Item and gets no row of
// its own, because the Author's unit of attention and of control is the dispatched run. It is
// drawn nested under its parent, and the parent stays the only row with a kill button.
//
// U-8d is the disagreement marker: when a role's N agents disagreed, the dissent is supposed to
// be named in the `selection_note`, and the Author needs to know which authoritative answers were
// unanimous and which were not (D-38). S-6's elapsed time is shown because it answers "why is
// this taking an hour?" — E-0 forbids reading it as a limit.
import { formatElapsed, isLiveRun, panelDissent } from './story-contract';
import type { RoleKind, Run, Template } from '../../shared/types';

/** U-8a: the crew that WRITES must never be confused with the crew that judges. */
function roleClass(role: RoleKind): string {
    return `sv-run-kind sv-kind-${role}${role === 'writer' ? ' sv-kind-writer' : ''}`;
}

/** The role row inside a template that carries the run's kind — the source of `agents`/`aggregate` (D-38). */
function panelOf(template: Template | undefined, role: RoleKind): { agents: number; aggregate?: string } | null {
    const match = template?.roles.find((candidate) => candidate.kind === role);
    const agents = match?.agents ?? 1;
    return agents > 1 ? { agents, aggregate: match?.aggregate } : null;
}

export interface CrewPanelProps {
    runs: Run[];
    templates: Template[];
    /** Injected so elapsed time is deterministic instead of reading the wall clock (a test must know the answer). */
    now: string;
    onKillRun?: (runId: string) => void;
}

export function CrewPanel({ runs, templates, now, onKillRun }: CrewPanelProps) {
    const live = runs.filter(isLiveRun);
    const closed = runs.filter((run) => !isLiveRun(run));

    const renderRun = (run: Run) => {
        const template = templates.find(
            (candidate) => candidate.id === run.template_ref || candidate.name === run.template_ref
        );
        const panel = panelOf(template, run.role);
        const dissent = panelDissent(run);

        return (
            <li className={`sv-run${run.role === 'writer' ? ' sv-run-writer' : ''}`} key={run.id}>
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
                                <span className="sv-delegated-note">inside this run — not a work item (S-7, T-2b)</span>
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
                        title="Tear this one harness down; the Story keeps running (D-18, S-3)"
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
        <aside className="sv-pane sv-crew" aria-label="Crew">
            <header className="sv-pane-head">
                <h3 className="sv-pane-title">Crew — live runs for this story (U-7)</h3>
                <span className="sv-pane-badge">{live.length} running</span>
            </header>

            {live.length === 0 ? <p className="sv-crew-idle">Nothing is running on this story right now.</p> : null}
            <ul className="sv-runs">{live.map(renderRun)}</ul>

            {closed.length > 0 ? (
                <details className="sv-crew-closed">
                    <summary>{closed.length} runs torn down — each row says why it ended (S-3)</summary>
                    <ul className="sv-runs">{closed.map(renderRun)}</ul>
                </details>
            ) : null}
        </aside>
    );
}
