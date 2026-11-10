// The transcript: this Title's conversation, and only this Title's.
//
// PER TITLE BY CONSTRUCTION (R-I): the rows come from `storyline.turns.transcript`,
// which the turns plugin keeps as one bucket per session id and re-paints whenever the
// active Title changes. So a turn from the Title in the next branch of the tree can
// never appear here — there is no filter to forget, and a test pins it by switching
// Titles and reading the cell.
//
// WHAT A ROW IS: a question the operator sent, an agent's answer, or the task the
// server's review chain posted into an agent's conversation. A row the story pipeline
// started (not this composer) is marked `triggered` and carries no turn id, because "who
// asked for this" is a fact the UI must state rather than imply — and for a chained turn
// this panel is the ONLY place it can be read: that turn has no turn row, no display
// document and no stream text of its own (src/dashboard/plugins/turns.ts).
import { TITLES_ACTIVE_STATE, TITLES_STATE, TURNS_TRANSCRIPT_STATE, type TitlesState, type TurnRow } from '../contract';
import { useDashboardValue } from '../state-hooks';

/** The phase a row is rendered with; an unknown harness state reads as queued. */
const phaseOf = (row: TurnRow): string => row.phase;

/**
 * Who a row is attributed to, in words an operator reads.
 *
 * `system` is the prompt the server's review chain posted into an agent's conversation:
 * nobody typed it, so calling it "you" would be a lie and calling it by the agent's name
 * would hide that a task arrived rather than an answer. The word avoids the server's
 * vocabulary on purpose — the workstation never says "harness" or "session".
 */
const authorOf = (row: TurnRow): string => {
    if (row.role === 'user') return 'you';
    if (row.role === 'system') return 'story chain';

    return row.agent === '' ? 'story' : row.agent;
};

export function TranscriptPanel() {
    const rows = useDashboardValue<readonly TurnRow[]>(TURNS_TRANSCRIPT_STATE);
    const titles = useDashboardValue<TitlesState>(TITLES_STATE);
    const activeId = useDashboardValue<string>(TITLES_ACTIVE_STATE);

    const title = titles.rows.find((row) => row.id === activeId)?.label ?? '';

    if (rows.length === 0) {
        return <p className="notice">{activeId.length === 0 ? 'No Title open.' : `No conversation yet for “${title}”.`}</p>;
    }

    return (
        <ol className="transcript" data-session={activeId} aria-label={`Conversation for ${title}`}>
            {rows.map((row) => (
                <li key={row.id} className="turn" data-role={row.role} data-phase={phaseOf(row)} data-triggered={row.triggered ? 'yes' : 'no'}>
                    <p className="turn__head">
                        <span className="turn__who">
                            {/* The operator, the agent, or the chain that asked for this — never a
                                guess at one of the three when the flow is unknown. */}
                            {authorOf(row)}
                        </span>
                        <span className="turn__phase">{phaseOf(row)}</span>
                        {row.triggered ? <span className="tag">started by the story</span> : null}
                    </p>
                    <p className="turn__text">{row.text.length > 0 ? row.text : '…'}</p>
                </li>
            ))}
        </ol>
    );
}
