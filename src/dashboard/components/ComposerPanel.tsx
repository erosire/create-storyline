// The composer: the one place this workstation sends work to the agents.
//
// ONE TURN AT A TIME PER TITLE: while a Title has a running row, Send is disabled and
// Stop is offered. The contract would accept a steer into a running thread, but two
// open rows racing into one transcript is a UI this workstation does not need — and
// the refusal is stated in the panel rather than thrown at the operator.
//
// WHY THE TEXTAREA HOLDS ITS OWN TEXT: a keystroke is not a dashboard write. The store
// draft is what the PLUGIN clears after a successful send (and what it seeds when an
// agent is picked), and this component mirrors that in an effect keyed on the draft's
// IDENTITY — so clearing after a send works, and a save-style rewrite can never erase
// what the operator is typing (the same rule the chapter editor follows).
import { useEffect, useState } from 'react';
import {
    AGENT_OPTIONS,
    TITLES_ACTIVE_STATE,
    TURNS_AGENT_STATE,
    TURNS_COMPOSER_STATE,
    TURNS_SELECT_AGENT_COMMAND,
    TURNS_SEND_COMMAND,
    TURNS_STOP_COMMAND,
    TURNS_TRANSCRIPT_STATE,
    type ComposerDraft,
    type StorylineAgent,
    type TurnRow
} from '../contract';
import { useDashboardCommand, useDashboardValue } from '../state-hooks';

/** The phases in which a row still owns the composer's Send button. */
const isRunning = (row: TurnRow): boolean => row.phase === 'queued' || row.phase === 'running';

export function ComposerPanel() {
    const draft = useDashboardValue<ComposerDraft>(TURNS_COMPOSER_STATE);
    const target = useDashboardValue<StorylineAgent>(TURNS_AGENT_STATE);
    const rows = useDashboardValue<readonly TurnRow[]>(TURNS_TRANSCRIPT_STATE);
    const activeId = useDashboardValue<string>(TITLES_ACTIVE_STATE);

    const selectAgent = useDashboardCommand<StorylineAgent, StorylineAgent>(TURNS_SELECT_AGENT_COMMAND);
    const send = useDashboardCommand<string, Promise<readonly TurnRow[]>>(TURNS_SEND_COMMAND);
    const stop = useDashboardCommand<void, Promise<boolean>>(TURNS_STOP_COMMAND);

    const [text, setText] = useState('');
    const [failed, setFailed] = useState('');

    // Mirror the plugin's clears (after a send) and seeds (after an agent pick).
    useEffect(() => setText(draft.text), [draft.text]);

    const running = rows.some(isRunning);
    const blank = text.trim().length === 0;

    return (
        <form
            className="composer"
            onSubmit={(event) => {
                event.preventDefault();
                if (blank || running || activeId.length === 0) return;
                setFailed('');
                // The failure is shown rather than swallowed: a rejected submit leaves the
                // rows the plugin appended, and this sentence says why they are errored.
                void send(text).catch((error: unknown) => setFailed(error instanceof Error ? error.message : String(error)));
                setText('');
            }}
        >
            <div className="composer__agents" role="group" aria-label="Address this to">
                {AGENT_OPTIONS.map((option) => (
                    <button
                        key={option.key}
                        className="button"
                        type="button"
                        aria-pressed={option.key === target ? 'true' : 'false'}
                        title={option.hint}
                        // The agent is chosen first, then the text is addressed to it: the
                        // harness routes by THREAD, so this pick is what opens that thread.
                        onClick={() => selectAgent(option.key)}
                    >
                        {option.label}
                    </button>
                ))}
            </div>

            <textarea
                className="composer__input"
                rows={3}
                value={text}
                placeholder={activeId.length === 0 ? 'Pick a Title first' : `Ask ${target} for the next move`}
                aria-label="Prompt"
                disabled={activeId.length === 0}
                onChange={(event) => setText(event.target.value)}
            />

            <div className="composer__row">
                <button className="button button--primary" type="submit" disabled={blank || running || activeId.length === 0}>
                    Send
                </button>
                <button className="button" type="button" disabled={!running} onClick={() => void stop()}>
                    Stop
                </button>
                {running ? <span className="hint">one agent is answering this Title</span> : null}
                {failed.length > 0 ? <span className="hint hint--error">{failed}</span> : null}
            </div>
        </form>
    );
}
