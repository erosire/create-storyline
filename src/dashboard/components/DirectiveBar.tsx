// §10.2 U-9 / D-19 — the DIRECTIVE BAR (W12).
//
// ONE LINE, NOT A CONVERSATION (U-9): the bar writes a `directives` record whose whole job is
// to PROPAGATE — tasks get opened, dependents get `needs_recheck`, and the crew reports what
// it touched (D-19). There is no transcript here on purpose (§13: "not a chat client"): a
// transcript invites the Author to chat, and a chat reply from a fresh-context harness with
// no memory (P2) is theatre. What the Author gets back is the Story changing, not a message.
//
// The bar is Story-scoped because a directive is a record on one Story (T-3: a run is scoped
// to exactly one Story), so on the home view it says so instead of pretending to broadcast.

import { useState } from 'react';
import { useDashboard, useDashboardStore } from '../state';

export function DirectiveBar() {
    const store = useDashboardStore();
    const { activeStoryId, stories } = useDashboard();
    const [text, setText] = useState('');
    const story = activeStoryId ? stories.find((row) => row.id === activeStoryId) : undefined;

    const send = async () => {
        const line = text.trim();
        if (!line || !activeStoryId) {
            return;
        }
        // Optimistic clear, but only kept when the write lands: a refused directive (a
        // stopped Story, a locked phase) keeps its text so the Author does not retype it.
        setText('');
        const result = await store.sendDirective(activeStoryId, line);
        if (result === null) {
            setText(line);
        }
    };

    return (
        <form
            className="directive-bar"
            data-testid="directive-bar"
            data-story={activeStoryId ?? ''}
            onSubmit={(event) => {
                event.preventDefault();
                void send();
            }}
        >
            <label className="directive-bar__label" htmlFor="directive-input">
                Directive
            </label>
            <input
                id="directive-input"
                className="directive-bar__input"
                data-testid="directive-input"
                name="directive"
                // U-9's own example copy: the bar accepts decisions, and the placeholder says
                // so in the shape of one ("kill the mentor in ch4" · "make it colder").
                placeholder="kill the mentor in ch4 · make it colder"
                autoComplete="off"
                spellCheck={false}
                disabled={!activeStoryId}
                value={text}
                onChange={(event) => setText(event.target.value)}
            />
            <button
                type="submit"
                className="button button--send"
                data-testid="directive-send"
                disabled={!activeStoryId || text.trim().length === 0}
            >
                Send
            </button>
            <p className="directive-bar__hint">
                {story
                    ? `goes to ${story.title} as a directive: tasks, rechecks, and a report of what it touched (D-19)`
                    : 'pick a Story first — a directive belongs to one book (T-3)'}
            </p>
        </form>
    );
}

export default DirectiveBar;
