// The GLOBAL agent roster — Writer, Editor, Reader and Checker, in tile form.
//
// WHY THIS PANEL IS NOT STORY-SCOPED: an agent is the SAME agent across every Story. Each Story
// gets its own harness instance (so its transcripts, tools and threads are isolated), but the
// roster itself is one Author-configured set. That is why the panel is rendered outside the
// Story view: selecting a Story changes the centre (its Seed, phases and prose), never which
// agents exist or what the rest of the book is doing to them.
//
// WHAT A TILE SAYS: the engine thread(s) the agent holds RIGHT NOW, across every Story. The
// status is therefore a live fact — `running` with the Story title and phase the thread belongs
// to, or `idle` when nothing is dispatched. The server owns that projection (`GET /agents`); the
// dashboard never derives it from local run guesses.
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
        (kind) => byKind.get(kind) ?? { kind, title: kind, status: 'idle' as const, working: [] }
    );
};

export interface AgentsPanelProps {
    agents: AgentStatusRow[];
    /** True while the first roster read is outstanding (the shell never shows a spinner). */
    loading?: boolean;
}

export function AgentsPanel({ agents, loading = false }: AgentsPanelProps) {
    const rows = ordered(agents);
    const working = rows.reduce((total, agent) => total + agent.working.length, 0);

    return (
        <aside className="sv-pane sv-agents" data-testid="agents-panel" aria-label="Agents">
            <header className="sv-pane-head">
                <h3 className="sv-pane-title">Agents — global (U-8)</h3>
                <span className="sv-pane-badge">
                    {working} thread{working === 1 ? '' : 's'} running
                </span>
            </header>

            <p className="sv-agents-note">
                The same four agents work every Story. Each Story owns its own harness, so a
                thread here never crosses books; selecting a Story only changes the middle.
            </p>

            {loading && agents.length === 0 ? <p className="sv-agents-empty">reading the agent roster…</p> : null}

            <ul className="sv-agent-tiles">
                {rows.map((agent) => (
                        <li
                            className="sv-agent-tile"
                            data-agent={agent.kind}
                            data-status={agent.status}
                            key={agent.kind}
                        >
                            <header className="sv-agent-tile__head">
                                <span className="sv-agent-tile__name">{agent.title}</span>
                                <span className={`sv-agent-tile__state sv-agent-tile__state--${agent.status}`}>
                                    {agent.status}
                                </span>
                            </header>

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
                        </li>
                    ))}
            </ul>
        </aside>
    );
}

export default AgentsPanel;
