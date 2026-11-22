// The GLOBAL agent roster — Writer, Editor, Reader and Checker, in tile form.
//
// WHY THIS PANEL IS NOT STORY-SCOPED: the four agents are DEFINED ONCE as a roster and added to
// every harness (each Story) and every session that harness spawns; the threads a session opens
// run under that same roster. Only the lead — the ENTRY point that routes an unfocused session —
// differs, never the agent list. Selecting a Story changes the centre (its Seed, phases and
// prose), never which agents exist or what the rest of the book is doing to them.
//
// WHAT A TILE SAYS: the agent's RANK (all four are Rank A peers, R15 — rank grants no delegation
// between them), the engine thread(s) it holds RIGHT NOW across every Story, the MODEL it will
// ask for (U-8 / T-6b), and the newest closed runs with the `end_reason` they tore down with
// (S-3). The status is therefore a live fact — `running` with the Story title and phase the
// thread belongs to, or `idle` when nothing is dispatched — while the recent runs keep a failed
// thread visible instead of letting it vanish into `idle` between sweeps.
//
// WHY THE MODEL IS PLAIN TEXT: a model the Author cannot see or change is configuration that only
// exists in an environment variable. The model on the tile is the control itself (U-8's one write,
// `PATCH /agents/:kind`): it reads as the chosen id, and clicking it opens the provider catalogue
// in the platform's own dropdown, so the Author is never configuring blind.
//
// WHY THE CHOICES ARE THE PROVIDER'S: `GET /agents/models` proxies
// `GET {STORYLINE_PROVIDER_BASE_URL}/models` — default
// `http://localhost:8800/providers/private/v1/models`. The same provider root is what the harness
// engine dials for completions, so the list can never drift from what a run can actually ask for,
// and a typo cannot become a model name no provider serves.
import type { AgentStatusRow } from '../api';

/** The fixed render order; the server returns the same order in its projection. */
const AGENT_ORDER = ['writer', 'editor', 'reader', 'checker'] as const;

const PHASE_LABEL: Record<string, string> = {
    summary: '① Summary',
    plotlines: '② Plotlines',
    chapters: '③ Chapters'
};

/** Why a closed run ended, kept to one readable line on the rail (the full row is on the run). */
const reasonLine = (reason: string | undefined, fallback: string): string => {
    const text = (reason ?? '').trim() || fallback;

    return text.length > 220 ? `${text.slice(0, 217)}…` : text;
};

const ordered = (agents: AgentStatusRow[]): AgentStatusRow[] => {
    const byKind = new Map(agents.map((agent) => [agent.kind, agent]));

    return AGENT_ORDER.map(
        (kind) =>
            byKind.get(kind) ?? {
                kind,
                title: kind,
                status: 'idle' as const,
                rank: 'A' as const,
                entry: kind === 'writer',
                model: 'not reported',
                model_source: 'default' as const,
                template_models: [],
                working: [],
                recent: []
            }
    );
};

/**
 * The dropdown's choices: the provider catalog, plus the model currently in effect when the
 * provider no longer lists it (a hand-edited setting, or a model renamed upstream). The select
 * must be able to SHOW what the agent runs — silently replacing it with the first catalog entry
 * would misreport the configuration on the face of the tile.
 */
const modelChoices = (current: string, catalog: readonly string[] = []): string[] => {
    const choices = [...new Set(catalog.map((model) => model.trim()).filter((model) => model.length > 0))];

    if (current.trim().length > 0 && !choices.includes(current)) {
        choices.unshift(current);
    }

    return choices;
};

export interface AgentsPanelProps {
    agents: AgentStatusRow[];
    /**
     * U-8 — the provider's model catalog (`GET /agents/models`). The editor is a dropdown over
     * these ids (plus whatever model is currently in effect); a blank catalog never falls back to
     * free text.
     */
    models?: string[];
    /** True while the first roster read is outstanding (the shell never shows a spinner). */
    loading?: boolean;
    /**
     * U-8 — the one write this panel owns: set the model this agent kind runs (`null` clears the
     * choice, so its template role — or the process default — takes over). Absent means the
     * endpoint has not landed and the editor renders read-only rather than pretending a change
     * saved something.
     */
    onSetModel?: (kind: string, model: string | null) => void | Promise<unknown>;
}

export function AgentsPanel({ agents, models = [], loading = false, onSetModel }: AgentsPanelProps) {
    const rows = ordered(agents);
    const working = rows.reduce((total, agent) => total + agent.working.length, 0);

    const setModel = (agent: AgentStatusRow, next: string): void => {
        // The blank option is the explicit clear: the template role, else the process model,
        // takes over (T-6b). It is offered only when a choice exists to clear.
        void onSetModel?.(agent.kind, next.trim().length === 0 ? null : next);
    };

    return (
        <aside className="sv-pane sv-agents" data-testid="agents-panel" aria-label="Agents">
            <header className="sv-pane-head">
                <h3 className="sv-pane-title">Agents — global (U-8)</h3>
                <span className="sv-pane-badge">
                    {working} thread{working === 1 ? '' : 's'} running
                </span>
            </header>

            {loading && agents.length === 0 ? <p className="sv-agents-empty">reading the agent roster…</p> : null}

            <ul className="sv-agent-tiles">
                {rows.map((agent) => {
                    const choices = modelChoices(agent.model ?? '', models);
                    const draft = agent.model ?? '';
                    // A select must always point at a real option: an unreported model falls back to
                    // the catalog's first id, and an empty catalog to its placeholder.
                    const selected = choices.includes(draft) ? draft : (choices[0] ?? '');
                    const templateModels = agent.template_models ?? [];
                    const recent = agent.recent ?? [];
                    const latest = recent[0];
                    const modelId = `sv-agent-model-${agent.kind}`;

                    return (
                        <li
                            className="sv-agent-tile"
                            data-agent={agent.kind}
                            data-status={agent.status}
                            data-rank={agent.rank ?? 'A'}
                            key={agent.kind}
                        >
                            <div className="sv-agent-tile__head">
                                <span className="sv-agent-tile__name">{agent.title}</span>
                                {/* R15: rank is the harness's authority vocabulary; all four are A. */}
                                <span
                                    className="sv-agent-tile__rank"
                                    title="every harness configures these agents at Rank A — rank alone grants no delegation between peers (R15)"
                                >
                                    Rank {agent.rank ?? 'A'}
                                </span>
                                {agent.entry ? (
                                    <span
                                        className="sv-agent-tile__entry"
                                        title="the lead of a session — routing, never authority (R15)"
                                    >
                                        entry
                                    </span>
                                ) : null}
                                <span className={`sv-agent-tile__state sv-agent-tile__state--${agent.status}`}>
                                    {agent.status}
                                </span>
                            </div>

                            {/* U-8 / T-6b: the model reads as plain text; clicking it opens the
                                provider catalogue as a dropdown and the selection is saved at once. */}
                            <p className="sv-agent-tile__model">
                                <label htmlFor={modelId}>Model:</label>
                                <span className="sv-agent-tile__model-picker">
                                    <span className="sv-agent-tile__model-text" aria-hidden="true">
                                        {selected.length > 0 ? selected : 'not reported'}
                                    </span>
                                    <select
                                        id={modelId}
                                        className="sv-agent-tile__model-select"
                                        value={selected}
                                        autoComplete="off"
                                        aria-label={`model for ${agent.title}`}
                                        title="click to choose the model this agent runs"
                                        disabled={onSetModel === undefined || choices.length === 0}
                                        onChange={(event) => setModel(agent, event.target.value)}
                                    >
                                        {choices.length === 0 ? (
                                            <option value="">the provider reported no models</option>
                                        ) : (
                                            choices.map((model) => (
                                                <option key={model} value={model}>
                                                    {model}
                                                </option>
                                            ))
                                        )}
                                        {agent.model_source === 'agent' ? (
                                            <option value="">use the template role, else the process default</option>
                                        ) : null}
                                    </select>
                                </span>
                            </p>

                            {/* T-6b: a template role that names a model governs its crew. The tile
                                says so rather than showing a default the run will not use. */}
                            {templateModels.length > 0 ? (
                                <p className="sv-agent-tile__template-models">
                                    templates set:{' '}
                                    {templateModels.map((entry) => `${entry.model} (${entry.template})`).join(' · ')} —{' '}
                                    {agent.model_source === 'agent'
                                        ? 'this agent’s model wins'
                                        : 'they win over the process default'}
                                </p>
                            ) : null}

                            {agent.working.length > 0 ? (
                                <ul className="sv-agent-tile__threads">
                                    {agent.working.map((thread) => (
                                        <li className="sv-agent-thread" key={thread.thread_id}>
                                            <span className="sv-agent-thread__story">{thread.story_title}</span>
                                            <span className="sv-agent-thread__phase">
                                                {PHASE_LABEL[thread.phase] ?? thread.phase}
                                            </span>
                                            <span className="sv-agent-thread__work">{thread.work_item}</span>
                                        </li>
                                    ))}
                                </ul>
                            ) : null}

                            {/* S-3: a torn-down run keeps its reason on the rail. Without this, a run
                                that failed every sweep is invisible the moment its thread ends. */}
                            {latest !== undefined ? (
                                <details className="sv-agent-tile__recent">
                                    <summary>
                                        <span
                                            className={`sv-agent-recent__state sv-agent-recent__state--${latest.state}`}
                                        >
                                            {latest.state}
                                        </span>{' '}
                                        last run —{' '}
                                        {reasonLine(
                                            latest.end_reason,
                                            latest.work_item.length > 0 ? latest.work_item : latest.run_id
                                        )}
                                    </summary>
                                    <ul>
                                        {recent.map((run) => (
                                            <li className="sv-agent-recent" key={run.run_id}>
                                                <span
                                                    className={`sv-agent-recent__state sv-agent-recent__state--${run.state}`}
                                                >
                                                    {run.state}
                                                </span>
                                                <span className="sv-agent-recent__story">{run.story_title}</span>
                                                <span className="sv-agent-recent__work">
                                                    {run.work_item.length > 0 ? run.work_item : run.run_id}
                                                </span>
                                                <span className="sv-agent-recent__reason">
                                                    {reasonLine(run.end_reason, 'no end reason recorded (S-3)')}
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                </details>
                            ) : null}
                        </li>
                    );
                })}
            </ul>
        </aside>
    );
}

export default AgentsPanel;
