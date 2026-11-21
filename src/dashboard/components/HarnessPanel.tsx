// The global agent catalogue — the agents every story's phrases run, with Rank A called out.
//
// WHY THE RANK IS THE FIRST THING ON THE ROW: the harness's delegation rule is purely
// authority-based (`isLowerRank` in `@underload/harness`), so which agents are Rank A is not
// decoration — it is the answer to "who can hand work to whom". The card shows the Rank A
// members directly and folds the delegates away, which is also the compact reading a phrase
// needs: the top of the roster is the team it can hand work to.
//
// THESE AGENTS ARE GLOBAL, AND THERE IS NO MAIN AGENT. The roster is configuration: the Author
// shapes it once in the template catalogue, and every story's phrases run it. No row here is a
// lead — the loop is fully autonomous from the Goal the Author types into the directive, and a
// phrase is started because the Goal still has work, not because an entry agent chose to. The
// server does report an `entry` member for unfocused harness submits; the dashboard
// deliberately does not surface it as a lead agent.
import type { HarnessAgentListing, HarnessListing } from '../api';

function RankChip({ rank }: { rank: string }) {
    return (
        <span className="hv-rank" data-rank={rank} title={`rank ${rank} authority`}>
            {rank}
        </span>
    );
}

function AgentRow({ agent }: { agent: HarnessAgentListing }) {
    return (
        <li className="hv-agent" data-rank={agent.rank}>
            <RankChip rank={agent.rank} />
            <span className="hv-agent__name">{agent.title}</span>
            <code className="hv-agent__id">{agent.name}</code>
            {agent.description ? <p className="hv-agent__description">{agent.description}</p> : null}
        </li>
    );
}

function HarnessCard({ harness }: { harness: HarnessListing }) {
    const rankA = harness.agents.filter((agent) => agent.rank === 'A');
    const delegates = harness.agents.filter((agent) => agent.rank !== 'A');

    return (
        <li className="hv-card" data-harness={harness.name}>
            <header className="hv-card__head">
                <div className="hv-card__identity">
                    <h4 className="hv-card__title">{harness.title}</h4>
                    <code className="hv-card__name">{harness.name}</code>
                </div>
                <span className="pill pill--quiet">{harness.tool_count} tools</span>
            </header>

            <p className="hv-card__description">{harness.description}</p>

            <div className="hv-card__section">
                <span className="hv-card__label">
                    Rank A <span className="hv-card__label-count">{rankA.length}</span>
                </span>
                <ul className="hv-agents">
                    {rankA.map((agent) => (
                        <AgentRow key={agent.name} agent={agent} />
                    ))}
                </ul>
            </div>

            {delegates.length > 0 ? (
                <details className="hv-card__delegates">
                    <summary>
                        {delegates.length} delegate{delegates.length === 1 ? '' : 's'} below Rank A
                    </summary>
                    <ul className="hv-agents">
                        {delegates.map((agent) => (
                            <AgentRow key={agent.name} agent={agent} />
                        ))}
                    </ul>
                </details>
            ) : null}
        </li>
    );
}

export interface HarnessPanelProps {
    harnesses: HarnessListing[];
    /** True while the first catalogue read is outstanding (the shell never shows a spinner). */
    loading?: boolean;
}

export function HarnessPanel({ harnesses, loading = false }: HarnessPanelProps) {
    const rankACount = harnesses.reduce((total, harness) => total + harness.rank_a.length, 0);
    const agentCount = harnesses.reduce((total, harness) => total + harness.agents.length, 0);

    return (
        <aside className="sv-pane sv-harnesses" data-testid="harness-panel" aria-label="Agents">
            <header className="sv-pane-head">
                <h3 className="sv-pane-title">Agents — global (U-8)</h3>
                <span className="sv-pane-badge">
                    {agentCount} agent{agentCount === 1 ? '' : 's'} · {rankACount} Rank A
                </span>
            </header>

            <p className="hv-note">
                every agent here is global — the Author configures the roster once and every story&apos;s phrases run
                it. Rank A may delegate to a strictly lower rank; a same-rank peer is never a delegate target, and no
                agent owns the loop.
            </p>

            {harnesses.length === 0 ? (
                <p className="hv-empty">
                    {loading ? 'reading the agent catalogue…' : 'the agent catalogue is empty'}
                </p>
            ) : (
                <ul className="hv-cards">
                    {harnesses.map((harness) => (
                        <HarnessCard key={harness.name} harness={harness} />
                    ))}
                </ul>
            )}
        </aside>
    );
}

export default HarnessPanel;
