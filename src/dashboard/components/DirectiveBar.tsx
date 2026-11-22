// §10.2 U-9 / D-19 — the Author's one input, always at the foot of the content column.
//
// ONE INPUT, NOT A CONVERSATION (U-9): the line becomes a `directives` record addressed to the
// Editor. On a Story the Editor reviews it and sets the tasks the loop runs; on the home desk the
// same line opens a Story and sends it to that Story's Editor.
//
// IT SPEAKS FOR THE PANE (U-4 / U-9): on a Story the label and artifact refs follow the rail's
// selection, so "make it colder" while looking at chapter 4 reaches the Editor as a direction
// about chapter 4. On the home desk the label is the action: `Create New Story` on the create tab.
//
// WHERE IT SITS: the bar is the last child of the content region, so it is the bottom of the
// content rather than a window-wide footer, and it exists on every view (including Requests).

import { useState } from 'react';
import { useDashboard, useDashboardStore } from '../state';
import { DEFAULT_STORY_SELECTION, directiveFocus } from './story-nav';
import type { StorySelection } from './story-nav';
import type { HomeTab } from './HomeDesk';

export interface DirectiveBarProps {
    /** The phrase or folder the Author is reading; omitted means the Summary, a Story's opening pane. */
    selection?: StorySelection;
    /** The home desk's tab; only used while no Story is open. */
    homeTab?: HomeTab;
}

export function DirectiveBar({ selection = DEFAULT_STORY_SELECTION, homeTab = 'requests' }: DirectiveBarProps) {
    const store = useDashboardStore();
    const { activeStoryId, storyViews } = useDashboard();
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const view = activeStoryId ? storyViews[activeStoryId] : undefined;
    const focus = view ? directiveFocus(view, selection) : undefined;
    const label = activeStoryId
        ? (focus?.label ?? 'Directive')
        : homeTab === 'create'
          ? 'Create New Story'
          : 'Directive';

    const send = async () => {
        const line = text.trim();
        if (!line || busy) {
            return;
        }
        // Optimistic clear, but only kept when the write lands: a refused directive keeps its
        // text so the Author does not retype it.
        setBusy(true);
        setText('');

        let landed: boolean;
        if (activeStoryId) {
            landed = (await store.sendDirective(activeStoryId, line, focus?.refs ?? [])) !== null;
        } else {
            // The prompt path is the same API the form uses: the Story is opened from the line,
            // then the line goes to its Editor as the first direction.
            const row = await store.createStory({ idea: line });
            landed = row !== null && (await store.sendDirective(row.id, line)) !== null;
        }

        if (!landed) {
            setText(line);
        }
        setBusy(false);
    };

    return (
        <form
            className="directive-bar"
            data-testid="directive-bar"
            data-story={activeStoryId ?? ''}
            data-focus={focus?.label ?? ''}
            onSubmit={(event) => {
                event.preventDefault();
                void send();
            }}
        >
            <label className="directive-bar__field" htmlFor="directive-input">
                <span className="directive-bar__label">{label}</span>
                <input
                    id="directive-input"
                    className="directive-bar__input"
                    data-testid="directive-input"
                    name="directive"
                    autoComplete="off"
                    spellCheck={false}
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                />
            </label>
            <button
                type="submit"
                className="button button--send"
                data-testid="directive-send"
                aria-label="Send the directive to the Editor"
                disabled={busy || text.trim().length === 0}
            >
                <span className="directive-bar__send-label">Send</span>
                <span className="directive-bar__send-glyph" aria-hidden="true">
                    ▶
                </span>
            </button>
        </form>
    );
}

export default DirectiveBar;
