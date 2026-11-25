// T5 / R2 — the Editor-locking Setting: one checkbox on the Settings pane, and the Author's decision it records.
//
// The wire's rule is "absent means off", so the three states a test can distinguish are exactly the three this
// file pins, and none of them is "the box looked enabled":
//
//   1. A Story that never carries the key (`fixtureStory()` — every Story written before the Setting exists, and
//      every `PATCH` body that did not mention it) renders UNCHECKED. A pane that treated `undefined` as
//      enabled-by-default would hand the Editor a power the Author never granted (L-13: absence is a value).
//   2. A Story that carries `editor_group_locking: true` renders CHECKED, and the click that turns it off sends
//      the explicit `false` (`state.ts:setEditorGroupLocking`) — OFF has to be a body the server can tell apart
//      from a body that stayed silent.
//   3. With no verb bound (a shell that has not landed the settings route), the box is DISABLED and says why, and
//      it still reports which way the Story currently stands — a disabled control that hides the state is the
//      defect U-16 exists to catch.
//
// The click assertion reads the recorder, not the DOM: `calls.setEditorGroupLocking` is the exact
// `(storyId, enabled)` pair the route receives, so a switch wired to the wrong Story or the inverted boolean
// fails here rather than in front of the Author.
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SettingsPane } from './story-folders';
import { fixtureActions, fixtureView } from './story-fixtures';
import { EDITOR_GROUP_LOCKING_LABEL, EDITOR_GROUP_LOCKING_NOTE } from './story-contract';

/** The pane with one Story's payload and a fresh recorder. */
function desk(options: { editorGroupLocking?: boolean; unwired?: boolean } = {}) {
    const { actions, calls } = fixtureActions();

    return {
        calls,
        element: (
            <SettingsPane
                view={fixtureView({ editorGroupLocking: options.editorGroupLocking === true })}
                actions={options.unwired ? { ...actions, setEditorGroupLocking: undefined } : actions}
            />
        )
    };
}

describe('SettingsPane — who may lock a phrase group (R2)', () => {
    it('is OFF for a Story that never carries the key, which is the rule the wire runs on', () => {
        render(desk().element);

        const box = screen.getByTestId('editor-group-locking') as HTMLInputElement;

        // Absent is not "unknown" and not "on by default": a Story from before the Setting keeps the rule the
        // Author has always had — only the Author commits a group.
        expect(box.checked).toBe(false);
        expect(box.disabled).toBe(false);
        // The label names the actor, and the sentence under the box is what the Author decides against: what the
        // Editor weighs, and the fact that only the Author can undo it. Both come from `story-contract`, so the
        // Setting's words cannot drift from the pane's badge copy.
        expect(box.getAttribute('aria-label')).toBe(EDITOR_GROUP_LOCKING_LABEL);
        expect(screen.getByTestId('setting-editor-group-locking-row').textContent).toBe(
            `${EDITOR_GROUP_LOCKING_LABEL}`
        );
        expect(screen.getByTestId('editor-group-locking-note').textContent).toBe(EDITOR_GROUP_LOCKING_NOTE);
    });

    it('is ON for a Story the Author opted into, and the click that turns it off sends the explicit false', () => {
        const { calls, element } = desk({ editorGroupLocking: true });

        render(element);

        const box = screen.getByTestId('editor-group-locking') as HTMLInputElement;

        expect(box.checked).toBe(true);

        fireEvent.click(box);

        // The pair the route takes: THIS Story, and the boolean the box settled on. An omitted key here would read
        // as "the body never mentioned it", which is OFF on the wire but not a decision the server can audit.
        expect(calls.setEditorGroupLocking).toEqual([['s1', false]]);
    });

    it('sends the explicit true for a Story that has never had the Setting', () => {
        const { calls, element } = desk();

        render(element);
        fireEvent.click(screen.getByTestId('editor-group-locking'));

        expect(calls.setEditorGroupLocking).toEqual([['s1', true]]);
    });

    it('sends the explicit false for a Story the Author opted in, and nothing before the click', () => {
        const { calls, element } = desk({ editorGroupLocking: true });

        render(element);

        // Rendering the Setting is not a write: the box reflects the Story, and only the Author's click PATCHes.
        expect(calls.setEditorGroupLocking).toBeUndefined();
        fireEvent.click(screen.getByTestId('editor-group-locking'));

        expect(calls.setEditorGroupLocking).toEqual([['s1', false]]);
    });

    it('disables the switch and says why when the shell binds no verb, and still reports the Story’s state (U-16)', () => {
        const { element } = desk({ editorGroupLocking: true, unwired: true });

        render(element);

        const box = screen.getByTestId('editor-group-locking') as HTMLInputElement;

        // Disabled, and the reason in the control's own tooltip — not a box that looks clickable and does nothing.
        expect(box.disabled).toBe(true);
        expect(box.getAttribute('title')).toBe(
            'The Story settings route is not available in this shell, so the Setting cannot be changed.'
        );
        // The state survives the missing verb: the Author can still read which way this Story stands, which is
        // what they need before deciding to change it.
        expect(box.checked).toBe(true);
        expect(screen.getByTestId('editor-group-locking-note').textContent).toBe(EDITOR_GROUP_LOCKING_NOTE);
    });

    it('offers the power in the tooltip while the Setting is off', () => {
        render(desk().element);

        // OFF → the tooltip offers the power, and names who holds it back.
        expect(screen.getByTestId('editor-group-locking').getAttribute('title')).toBe(
            'Let the Editor lock a phrase group in, on its own judgement over the Critic findings and the Reader score for it. Only you can unlock one.'
        );
    });

    it('says what turning it off restores while the Setting is on', () => {
        render(desk({ editorGroupLocking: true }).element);

        // ON → a different sentence, so the hover is never the same reassurance in both states.
        expect(screen.getByTestId('editor-group-locking').getAttribute('title')).toBe(
            'Stop letting the Editor lock phrase groups: only you would commit a group again.'
        );
    });
});
