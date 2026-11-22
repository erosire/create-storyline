// The GLOBAL EMPLOYEE ROSTER — Writer, Editor, Reader and Checker, in tile form.
//
// VOCABULARY (V-1): a tile is an EMPLOYEE, not an agent. The employee is the standing identity
// (kind, rank, model) configured once and shared by every Story; it becomes an AGENT only while a
// thread is executing under it. The tile's `running` badge therefore means the employee has at
// least one live thread, and the thread surface (AgentThreadsView) is that employee's execution
// history.
//
// WHY THIS PANEL IS NOT STORY-SCOPED: the four employees are DEFINED ONCE as a roster and added to
// every harness (each Story) and every session that harness spawns; the threads a session opens
// run as agents under that same roster. The Author's channel is the EDITOR — a directive is
// addressed to it, and it turns the direction into the tasks the loop runs — but that is routing,
// not a rank and not a delegation, so it never changes the employee list. Selecting a Story changes
// the centre (its Seed, phases and prose), never which employees exist or what the rest of the
// book is doing to them.
//
// WHAT A TILE SAYS: the employee's RANK (all four are Rank A peers, R15 — rank alone delegates to
// nobody between peers; V-2 restricts Work Items to Rank A and allows a Rank B employee only as a
// delegation target), the MODEL it will ask for (U-8 / T-6b), and whether it is running right now.
// The thread DETAIL deliberately does not live on this rail: a thread belongs to a Story's phase
// session (the UI's "phrase"), and the tile opens that history in the content area instead (see
// AgentThreadsView). The rail names the employee; the centre shows what its threads did.
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

/**
 * The fixed render order: alphabetical by employee title. Writer is not first for any reason;
 * the Editor is the Author's channel, not an authority above its peers (R15), so the rail sorts
 * like any other roster.
 */
const AGENT_ORDER = ['checker', 'editor', 'reader', 'writer'] as const;

const ordered = (agents: AgentStatusRow[]): AgentStatusRow[] => {
    const byKind = new Map(agents.map((agent) => [agent.kind, agent]));

    return AGENT_ORDER.map(
        (kind) =>
            byKind.get(kind) ?? {
                kind,
                title: kind,
                status: 'idle' as const,
                rank: 'A' as const,
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
 * must be able to SHOW what the employee runs — silently replacing it with the first catalog entry
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
     * U-8 — the one write this panel owns: set the model this employee kind runs (`null` clears
     * the choice, so its template role — or the process default — takes over). Absent means the
     * endpoint has not landed and the editor renders read-only rather than pretending a change
     * saved something.
     */
    onSetModel?: (kind: string, model: string | null) => void | Promise<unknown>;
    /**
     * U-8 — the tile's one verb: open this employee's retained threads in the content area. Absent
     * means the roster is being rendered read-only (the tile still names the employee and its model).
     */
    onSelectAgent?: (kind: string) => void;
    /** The employee whose thread surface is open, so the tile reads as the active one. */
    selectedAgent?: string | null;
}

export function AgentsPanel({
    agents,
    models = [],
    loading = false,
    onSetModel,
    onSelectAgent,
    selectedAgent = null
}: AgentsPanelProps) {
    const rows = ordered(agents);

    const setModel = (agent: AgentStatusRow, next: string): void => {
        // The blank option is the explicit clear: the template role, else the process model,
        // takes over (T-6b). It is offered only when a choice exists to clear.
        void onSetModel?.(agent.kind, next.trim().length === 0 ? null : next);
    };

    return (
        <aside className="sv-pane sv-agents" data-testid="agents-panel" aria-label="Employees">
            {/* The header names the roster and nothing else: each tile's own badge already says
                whether that employee is idle or how many threads it is running, so a panel-wide
                "N threads running" line is a second answer to a question already on screen. */}
            <header className="sv-pane-head">
                <h3 className="sv-pane-title">Employee</h3>
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
                    const modelId = `sv-agent-model-${agent.kind}`;
                    const active = selectedAgent === agent.kind;

                    // U-8: the whole tile is the content-area switch — its padding, the rank and
                    // status badges, the model line's blank space, and the template note all land on
                    // the tile. The head button carries the keyboard and screen-reader path; the
                    // model dropdown itself is the one spot that keeps its click.
                    return (
                        <li
                            className="sv-agent-tile"
                            data-agent={agent.kind}
                            data-status={agent.status}
                            data-rank={agent.rank ?? 'A'}
                            data-selected={active ? 'true' : 'false'}
                            key={agent.kind}
                            onClick={() => onSelectAgent?.(agent.kind)}
                        >
                            {/* U-8: the head remains a real button so keyboard users get the same
                                switch, and the model dropdown beside it stays its own control. */}
                            <button
                                type="button"
                                className="sv-agent-tile__open"
                                aria-pressed={active}
                                aria-label={`open ${agent.title} threads`}
                                title={`open every ${agent.title} thread in the content area (U-8)`}
                                onClick={(event) => {
                                    // The tile's own handler would otherwise fire twice for this one.
                                    event.stopPropagation();
                                    onSelectAgent?.(agent.kind);
                                }}
                            >
                                <span className="sv-agent-tile__head">
                                    <span className="sv-agent-tile__name">{agent.title}</span>
                                    {/* R15: rank is the harness's authority vocabulary; all four are A (V-2). */}
                                    <span
                                        className="sv-agent-tile__rank"
                                        title="every harness configures these employees at Rank A — rank alone grants no delegation between peers (R15); only Rank A owns a Work Item (V-2)"
                                    >
                                        Rank {agent.rank ?? 'A'}
                                    </span>
                                    <span
                                        className={`sv-agent-tile__state sv-agent-tile__state--${agent.status}`}
                                        title={
                                            agent.status === 'running'
                                                ? `${agent.working.length} thread${agent.working.length === 1 ? '' : 's'} running`
                                                : 'idle — no thread right now'
                                        }
                                        aria-label={
                                            agent.status === 'running'
                                                ? `${agent.working.length} thread${agent.working.length === 1 ? '' : 's'} running`
                                                : `${agent.title} is idle`
                                        }
                                    >
                                        {/* The badge IS the count while the employee works: "RUNNING"
                                            only says something is running, but the Author needs to know
                                            how many threads that is. */}
                                        {agent.status === 'running' ? agent.working.length : agent.status}
                                    </span>
                                </span>
                            </button>

                            {/* U-8 / T-6b: the model reads as plain text; clicking it opens the
                                provider catalogue as a dropdown and the selection is saved at once.
                                Only the dropdown stops its click — the rest of the line is tile. */}
                            <p className="sv-agent-tile__model">
                                <span className="sv-agent-tile__model-label">Model:</span>
                                <span className="sv-agent-tile__model-picker">
                                    <span className="sv-agent-tile__model-text" aria-hidden="true">
                                        {selected.length > 0 ? selected : 'not reported'}
                                    </span>
                                    {/* The dropdown is its own control: its click never becomes a
                                        tile toggle, while the text and space around it do. */}
                                    <select
                                        id={modelId}
                                        className="sv-agent-tile__model-select"
                                        value={selected}
                                        autoComplete="off"
                                        aria-label={`model for ${agent.title}`}
                                        title="click to choose the model this employee runs"
                                        disabled={onSetModel === undefined || choices.length === 0}
                                        onClick={(event) => event.stopPropagation()}
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
                                        ? 'this employee’s model wins'
                                        : 'they win over the process default'}
                                </p>
                            ) : null}
                        </li>
                    );
                })}
            </ul>
        </aside>
    );
}

export default AgentsPanel;
