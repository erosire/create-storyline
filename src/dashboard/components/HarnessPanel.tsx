// The harness listing — the agents a session can run, with Rank A called out.
//
// WHY THE RANK IS THE FIRST THING ON THE ROW: the harness's delegation rule is purely
// authority-based (`isLowerRank` in `@underload/harness`), so which agents are Rank A is not
// decoration — it is the answer to "who can hand work to whom". The card shows the Rank A
// members directly and folds the delegates away, which is also the compact reading a session
// needs: the top of the roster is the team that owns the session.
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
        <li className="hv-agent" data-rank={agent.rank} data-entry={agent.entry ? 'true' : 'false'}>
            <RankChip rank={agent.rank} />
            <span className="hv-agent__name">{agent.title}</span>
            <code className="hv-agent__id">{agent.name}</code>
            {agent.entry ? <span className="hv-agent__entry">entry</span> : null}
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

    return (
        <aside className="sv-pane sv-harnesses" data-testid="harness-panel" aria-label="Harnesses">
            <header className="sv-pane-head">
                <h3 className="sv-pane-title">Harnesses</h3>
                <span className="sv-pane-badge">
                    {harnesses.length} session{harnesses.length === 1 ? '' : 's'} · {rankACount} rank A
                </span>
            </header>

            <p className="hv-note">
                the agents available to a session, ranked A–Z. Rank A may delegate to a strictly lower rank; a same-rank
                peer is never a delegate target.
            </p>

            {harnesses.length === 0 ? (
                <p className="hv-empty">
                    {loading ? 'reading the harness catalogue…' : 'the harness catalogue is empty'}
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
