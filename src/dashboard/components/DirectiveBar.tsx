// §10.2 U-9 / D-19 — the DIRECTIVE BAR (W12): the Author's one channel to the EDITOR.
//
// ONE LINE, NOT A CONVERSATION (U-9): the bar writes a `directives` record addressed to the
// Editor. The Editor reviews the direction and sets the tasks the loop runs — the server reads the
// queue and opens a fresh thread for each task, which is not a delegate (V-1/V-2: a rank and a
// Work Item, not a nested conversation). There is no transcript here on purpose (§13: "not a chat
// client"): a transcript invites the Author to chat, and a chat reply from a fresh-context thread
// with no memory (P2) is theatre. What the Author gets back is the Story changing, not a message.
//
// The bar is Story-scoped because a directive is a record on one Story (T-3: a run is scoped
// to exactly one Story), so on the home view it says so instead of pretending to broadcast.
//
// WHERE IT SITS: the bar is the last child of the content region, so it is the bottom of the
// content rather than a window-wide footer. On a phone the stylesheet docks it to the viewport
// with the harness composer's minimal shape — one field and a send control, no label or hint.

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
                aria-label="Send the directive to the Editor"
                disabled={!activeStoryId || text.trim().length === 0}
            >
                <span className="directive-bar__send-label">Send</span>
                <span className="directive-bar__send-glyph" aria-hidden="true">
                    ▶
                </span>
            </button>
            <p className="directive-bar__hint">
                {story
                    ? story.status === 'stopped'
                        ? `queued for ${story.title}'s Editor — it sets the tasks when you resume (D-19, P8)`
                        : `goes to ${story.title}'s Editor — it turns your direction into the tasks the loop runs (D-19)`
                    : 'pick a Story first — its Editor is the one you talk to (T-3)'}
            </p>
        </form>
    );
}

export default DirectiveBar;
