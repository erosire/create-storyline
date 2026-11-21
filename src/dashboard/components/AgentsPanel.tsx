// The GLOBAL agent roster — Writer, Editor, Reader and Checker, in tile form.
//
// WHY THIS PANEL IS NOT STORY-SCOPED: an agent is the SAME agent across every Story. Each Story
// gets its own harness instance (so its transcripts, tools and threads are isolated), but the
// roster itself is one Author-configured set. That is why the panel is rendered outside the
// Story view: selecting a Story changes the centre (its Seed, phases and prose), never which
// agents exist or what the rest of the book is doing to them.
//
// WHAT A TILE SAYS: the engine thread(s) the agent holds RIGHT NOW, across every Story, and the
// MODEL it will ask for (U-8 / T-6b). The status is therefore a live fact — `running` with the
// Story title and phase the thread belongs to, or `idle` when nothing is dispatched. The server
// owns that projection (`GET /agents`); the dashboard never derives it from local run guesses.
//
// WHY THE TILE IS CLICKABLE: a model the Author cannot see or change is configuration that only
// exists in an environment variable. Clicking a tile opens the one write this panel owns — the
// global agent's model (`PATCH /agents/:kind`) — and the line above the editor always states the
// model currently in effect, so the Author is never configuring blind.
//
// WHY THE EDITOR IS A DROPDOWN: the choices are the provider's own catalog (`GET /agents/models`,
// which proxies `GET {STORYLINE_PROVIDER_BASE_URL}/models` — default
// `http://localhost:8800/providers/private/v1/models`). The same provider root is what the harness
// engine dials for completions, so the list can never drift from what a run can actually ask for,
// and a typo cannot become a model name no provider serves.
import { useState } from 'react';
import type { AgentStatusRow } from '../api';

/** The fixed render order; the server returns the same order in its projection. */
const AGENT_ORDER = ['writer', 'editor', 'reader', 'checker'] as const;

const PHASE_LABEL: Record<string, string> = {
    summary: '① Summary',
    plotlines: '② Plotlines',
    chapters: '③ Chapters'
};

const ordered = (agents: AgentStatusRow[]): AgentStatusRow[] => {
    const byKind = new Map(agents.map((agent) => [agent.kind, agent]));

    return AGENT_ORDER.map(
        (kind) =>
            byKind.get(kind) ?? {
                kind,
                title: kind,
                status: 'idle' as const,
                model: 'not reported',
                model_source: 'default' as const,
                template_models: [],
                working: []
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
     * endpoint has not landed and the editor renders read-only rather than pretending a click
     * saved something.
     */
    onSetModel?: (kind: string, model: string | null) => void | Promise<unknown>;
}

export function AgentsPanel({ agents, models = [], loading = false, onSetModel }: AgentsPanelProps) {
    const rows = ordered(agents);
    const working = rows.reduce((total, agent) => total + agent.working.length, 0);

    // One tile open at a time: the roster is four small cards, and four open editors would push
    // the live threads the Author is watching off the rail.
    const [openKind, setOpenKind] = useState<string | null>(null);
    const [drafts, setDrafts] = useState<Record<string, string>>({});

    const toggle = (agent: AgentStatusRow): void => {
        if (openKind === agent.kind) {
            setOpenKind(null);
            return;
        }

        setOpenKind(agent.kind);
        // Opening always starts from the server's current model, never a stale draft.
        setDrafts((current) => ({ ...current, [agent.kind]: agent.model ?? '' }));
    };

    const save = (agent: AgentStatusRow): void => {
        const choices = modelChoices(agent.model ?? '', models);
        const next = (drafts[agent.kind] ?? agent.model ?? choices[0] ?? '').trim();

        if (next.length === 0) {
            return;
        }

        void onSetModel?.(agent.kind, next);
        setOpenKind(null);
    };

    const useDefault = (agent: AgentStatusRow): void => {
        void onSetModel?.(agent.kind, null);
        setOpenKind(null);
    };

    return (
        <aside className="sv-pane sv-agents" data-testid="agents-panel" aria-label="Agents">
            <header className="sv-pane-head">
                <h3 className="sv-pane-title">Agents — global (U-8)</h3>
                <span className="sv-pane-badge">
                    {working} thread{working === 1 ? '' : 's'} running
                </span>
            </header>

            <p className="sv-agents-note">
                The same four agents work every Story. Each Story owns its own harness, so a thread here never crosses
                books; selecting a Story only changes the middle. Click an agent to set the model it runs.
            </p>

            {loading && agents.length === 0 ? <p className="sv-agents-empty">reading the agent roster…</p> : null}

            <ul className="sv-agent-tiles">
                {rows.map((agent) => {
                    const open = openKind === agent.kind;
                    const choices = modelChoices(agent.model ?? '', models);
                    const draft = drafts[agent.kind] ?? agent.model ?? '';
                    // A select must always point at a real option: an unreported model falls back to
                    // the catalog's first id, and an empty catalog to its placeholder.
                    const selected = choices.includes(draft) ? draft : (choices[0] ?? '');
                    const templateModels = agent.template_models ?? [];
                    const draftKey = `sv-agent-model-${agent.kind}`;
                    const configId = `sv-agent-config-${agent.kind}`;

                    return (
                        <li
                            className={`sv-agent-tile${open ? ' sv-agent-tile--open' : ''}`}
                            data-agent={agent.kind}
                            data-status={agent.status}
                            key={agent.kind}
                        >
                            <button
                                type="button"
                                className="sv-agent-tile__head"
                                aria-expanded={open}
                                aria-controls={open ? configId : undefined}
                                title={`Set the model ${agent.title} runs (U-8)`}
                                onClick={() => toggle(agent)}
                            >
                                <span className="sv-agent-tile__name">{agent.title}</span>
                                <span className={`sv-agent-tile__state sv-agent-tile__state--${agent.status}`}>
                                    {agent.status}
                                </span>
                            </button>

                            {/* U-8 / T-6b: the model is always on the face of the tile, not hidden
                                behind the editor — the Author should be able to read it at a glance. */}
                            <p className="sv-agent-tile__model">
                                model: <code>{agent.model ?? 'not reported'}</code>{' '}
                                <span className="sv-agent-tile__model-source">
                                    {agent.model_source === 'agent' ? 'set for this agent' : 'process default'}
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

                            {agent.working.length === 0 ? (
                                <p className="sv-agent-tile__idle">idle — no thread right now</p>
                            ) : (
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
                            )}

                            {open ? (
                                <form
                                    id={configId}
                                    className="sv-agent-tile__config"
                                    onSubmit={(event) => {
                                        event.preventDefault();
                                        save(agent);
                                    }}
                                >
                                    <label htmlFor={draftKey}>
                                        model for {agent.title} — this choice wins over its template role models (T-6b)
                                    </label>
                                    <select
                                        id={draftKey}
                                        className="sv-agent-tile__model-select"
                                        value={selected}
                                        autoComplete="off"
                                        title="the choices come from the provider's model catalog (GET /agents/models)"
                                        disabled={onSetModel === undefined || choices.length === 0}
                                        onChange={(event) =>
                                            setDrafts((current) => ({
                                                ...current,
                                                [agent.kind]: event.target.value
                                            }))
                                        }
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
                                    </select>
                                    <div className="sv-agent-tile__config-actions">
                                        <button
                                            type="submit"
                                            disabled={onSetModel === undefined || choices.length === 0}
                                        >
                                            Save model
                                        </button>
                                        <button
                                            type="button"
                                            disabled={onSetModel === undefined}
                                            title="Clear this agent's choice — its template role, else STORYLINE_PROVIDER_MODEL, takes over"
                                            onClick={() => useDefault(agent)}
                                        >
                                            Clear this agent&apos;s choice
                                        </button>
                                    </div>
                                </form>
                            ) : null}
                        </li>
                    );
                })}
            </ul>
        </aside>
    );
}

export default AgentsPanel;
