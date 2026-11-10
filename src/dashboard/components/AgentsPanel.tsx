// The agents panel: three equal task targets and what each is doing to this Title.
//
// NOTHING HERE IS PICKED FROM A RANK (fixed contract): the panel is a roster of
// `writer`, `reader` and `editor` — no primary, no subagent. Each card states its
// phase, its thread status, its message count and the last sentence of its
// conversation, all four of which come from the server's own rows — the roster read and
// the conversation read (see plugins/agents.ts for where each fact is sourced).
//
// CLICKING A CARD points the composer at that agent — one gesture for "read this
// conversation" and "write into it" — through the agents plugin's command, which
// re-broadcasts the choice as an event the turns plugin listens for. No plugin calls
// another plugin's state directly.
import {
    AGENTS_SELECT_COMMAND,
    AGENTS_STATE,
    AGENT_OPTIONS,
    TURNS_AGENT_STATE,
    type AgentsState,
    type StorylineAgent
} from '../contract';
import { useDashboardCommand, useDashboardValue } from '../state-hooks';

/** The short sentence a card's hint carries when the roster has not answered yet. */
const rosterNote = (state: AgentsState): string => {
    if (state.phase === 'loading') return 'reading the roster…';
    if (state.error.length > 0) return `roster read failed: ${state.error}`;

    return '';
};

export function AgentsPanel() {
    const agents = useDashboardValue<AgentsState>(AGENTS_STATE);
    const target = useDashboardValue<StorylineAgent>(TURNS_AGENT_STATE);
    const selectAgent = useDashboardCommand<StorylineAgent, unknown>(AGENTS_SELECT_COMMAND);

    // The row order is the contract's order, not whatever the roster happened to
    // return: an agent with no thread still gets a card, because it is still a target.
    const rows = AGENT_OPTIONS.map((option) => ({ option, row: agents.rows.find((item) => item.agent === option.key) }));
    const note = rosterNote(agents);

    return (
        <div className="stack agents">
            {note.length > 0 ? <p className="notice">{note}</p> : null}

            <ul className="cards">
                {rows.map(({ option, row }) => {
                    const isTarget = row !== undefined && row.agent === target;

                    return (
                        <li key={option.key} className="card" data-agent={option.key} data-target={isTarget ? 'yes' : 'no'}>
                            <button
                                className="card__main"
                                type="button"
                                aria-pressed={isTarget ? 'true' : 'false'}
                                // An agent with no thread yet is still selectable: the send
                                // opens its conversation lazily (plugins/turns.ts).
                                onClick={() => void selectAgent(option.key)}
                                title={row?.threadId.length ? row.threadId : 'no thread yet'}
                            >
                                <span className="card__name">{option.label}</span>
                                <span className="badge" data-phase={row?.phase ?? 'idle'} data-status={row?.threadStatus ?? 'missing'}>
                                    {row?.phase ?? 'idle'}
                                </span>
                            </button>
                            <p className="hint">
                                {option.hint} · {row?.threadStatus === 'missing' ? 'no thread' : `thread ${row?.threadStatus}`}
                                {row && row.messageCount > 0 ? ` · ${row.messageCount} messages` : ''}
                            </p>
                            {/* The thread's own label, when the server carries one — the operator
                                recognises a conversation by its name, not by an id. */}
                            {row && row.label.length > 0 ? <p className="card__label">{row.label}</p> : null}
                            {/* The last sentence in that conversation, read from the conversation
                                itself. A chained turn has no turn row and no stream text, so this
                                line — and the transcript row beside it — is the only place its
                                prose is on screen. `task` is the prompt the chain posted, 'last
                                word' what the agent answered with. */}
                            {row && row.lastActivity.length > 0 ? (
                                <p className="card__activity" data-author={row.lastAuthor}>
                                    <span className="card__activity-who">{row.lastAuthor === 'user' ? 'task' : 'last word'}</span>
                                    {row.lastActivity}
                                </p>
                            ) : null}
                            {row && row.workingTurnId.length > 0 ? <p className="card__turn">on turn {row.workingTurnId.slice(0, 8)}</p> : null}
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
