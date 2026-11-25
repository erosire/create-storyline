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
//
// THE SHAPE (the composer shape the chat workstation uses, packages/loadscript/chat): a quiet
// metadata line — the label — above a recessed field well, with the send control docked inside
// the well's right edge. Before that, the label floated INSIDE the field's border and the field
// was an `<input>` painted in the region's own `--surface`: the box read as a caption rather than
// as somewhere to type, a one-line field hid a long direction, and nothing said what to write.
// The field is now a one-row `<textarea>` that grows with the draft (see `resizeDirectiveField`),
// so a paragraph-long Seed is readable while it is being written.

import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { useDashboard, useDashboardStore } from '../state';
import { DEFAULT_STORY_SELECTION, directiveFocus } from './story-nav';
import type { DirectiveFocusView, StorySelection } from './story-nav';
import type { HomeTab } from './HomeDesk';

export interface DirectiveBarProps {
    /** The phrase or folder the Author is reading; omitted means the Summary, a Story's opening pane. */
    selection?: StorySelection;
    /** The home desk's tab; only used while no Story is open. */
    homeTab?: HomeTab;
}

// Vertical thickness of the field's frame (1px top + 1px bottom, matching `app.css`). It is a
// CONSTANT, not a computed read, because `scrollHeight` EXCLUDES the frame: without adding it back
// a one-row box comes out 2px short, the line overflows the content area, and `overflow-y: auto`
// delivers a jittery 2px scrollbar.
const FIELD_VERTICAL_BORDER = 2;

// Growth cap in rows. The bar is the foot of the content column, not a writing surface, so the
// draft gets six rows and then the field scrolls internally.
const MAX_ROWS = 6;

// Fallback line box (px) when the environment reports no usable line-height (jsdom's empty
// computed style): 13.5px text at the skin's 1.5 line-height.
const FALLBACK_LINE_HEIGHT = 20.25;

/**
 * Resize the field from its content height: floor at one row, cap at {@link MAX_ROWS}. Heights are
 * OUTER (border-box), which is why the frame is added back to `scrollHeight`. `rows={1}` in the
 * markup is what makes the `height: 'auto'` measurement a genuine one-row box instead of the
 * browser's two-row textarea default.
 */
export const resizeDirectiveField = (element: HTMLTextAreaElement): void => {
    element.style.height = 'auto';
    const computed = window.getComputedStyle(element);
    const lineHeight = Number.parseFloat(computed.lineHeight) || FALLBACK_LINE_HEIGHT;
    const verticalPadding =
        (Number.parseFloat(computed.paddingTop) || 0) + (Number.parseFloat(computed.paddingBottom) || 0);
    const oneRowHeight = lineHeight + verticalPadding + FIELD_VERTICAL_BORDER;
    const maxHeight = lineHeight * MAX_ROWS + verticalPadding + FIELD_VERTICAL_BORDER;
    const contentHeight = Math.max(element.scrollHeight + FIELD_VERTICAL_BORDER, oneRowHeight);
    element.style.height = `${Math.min(contentHeight, maxHeight)}px`;
};

export function DirectiveBar({ selection = DEFAULT_STORY_SELECTION, homeTab = 'requests' }: DirectiveBarProps) {
    const store = useDashboardStore();
    const { activeStoryId, storyViews, phrases } = useDashboard();
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const view = activeStoryId ? storyViews[activeStoryId] : undefined;
    // R6: the directive's artifact refs come from the phrase read, because a Summary GROUP is addressed by its
    // uuid — the Story payload alone cannot name one. So the bar reads the phrase the store cached beside the
    // Story, and `directiveFocus` resolves the rail's `summary-group:<uuid>` ref into the group's title, sentence
    // and id. Without the phrase the label still describes the pane; only the group ref is missing.
    const phrase = activeStoryId ? phrases[activeStoryId] : undefined;
    // Built field by field (not spread) so the bar depends on the five slices the focus actually reads, and a
    // payload change in any other slice cannot silently change what a directive is addressed to.
    const focusView: DirectiveFocusView | undefined = view
        ? {
              story: view.story,
              summary: view.summary,
              cast: view.cast,
              plotlines: view.plotlines,
              chapters: view.chapters,
              ...(phrase === undefined ? {} : { phrase })
          }
        : undefined;
    const focus = focusView ? directiveFocus(focusView, selection) : undefined;
    const label = activeStoryId
        ? (focus?.label ?? 'Directive')
        : homeTab === 'create'
          ? 'Create New Story'
          : 'Directive';
    // What the empty well says. The label above already names what the line is ADDRESSED to; the
    // placeholder says what to put in it, and with no Story open the line opens one (U-12), so the
    // home copy names that verb rather than the Editor.
    const placeholder = activeStoryId ? 'Tell the Editor what to change…' : 'Describe the Story you want…';

    const fieldRef = useRef<HTMLTextAreaElement | null>(null);

    // Keeps the box in sync with every write to the draft — a typed line, the optimistic clear on
    // send, and the text restored when a refused directive comes back.
    useEffect(() => {
        const field = fieldRef.current;
        if (field !== null) {
            resizeDirectiveField(field);
        }
    }, [text]);

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

    const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
        setText(event.target.value);
        // Grow on the same keystroke, without waiting for the state round-trip.
        resizeDirectiveField(event.currentTarget);
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        // A textarea keeps the newline the old `<input>` could not, so the two verbs split:
        // Enter sends, Shift+Enter writes one. Confirming an IME candidate also fires Enter, so
        // `isComposing` is checked FIRST and half-composed text is never sent.
        if (event.nativeEvent.isComposing || event.key !== 'Enter' || event.shiftKey) {
            return;
        }
        event.preventDefault();
        void send();
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
            <label className="directive-bar__label" htmlFor="directive-input">
                {label}
            </label>
            <div className="directive-bar__field">
                <textarea
                    ref={fieldRef}
                    id="directive-input"
                    className="directive-bar__input"
                    data-testid="directive-input"
                    name="directive"
                    // one row by default: the browser's two-row default would survive the 'auto'
                    // measurement and lock an empty bar at two rows.
                    rows={1}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={placeholder}
                    value={text}
                    onChange={handleChange}
                    onKeyDown={handleKeyDown}
                />
                {/* Docked inside the well's right edge, so the one verb travels with the field
                    instead of standing off to the side of it. It stays put through the whole
                    growth cap (`app.css` centres it in the box, not on the first line), and it is
                    visible but inert while the draft is empty. */}
                <button
                    type="submit"
                    className="directive-bar__send"
                    data-testid="directive-send"
                    aria-label="Send the directive to the Editor"
                    disabled={busy || text.trim().length === 0}
                >
                    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                        <path
                            d="M6 3.5 10.5 8 6 12.5"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                    </svg>
                </button>
            </div>
        </form>
    );
}

export default DirectiveBar;
