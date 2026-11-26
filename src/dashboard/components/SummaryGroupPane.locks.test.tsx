// T5 / R1 + R2 — the lock-in controls on ONE group's pane: the badge, the two verbs, and the refusal.
//
// What is pinned here, in the order the Author meets it on the pane:
//   R1 — an OPEN group offers exactly one verb (`Lock this group in`), and it is ARMED rather than fired: the
//        first click puts the sentence above the verb, and only the second click sends the route call with the
//        Story id and the group's UUID. A cancel sends nothing.
//   R1 — a LOCKED group says so twice — the head's badge naming the revision the lock stands on and who made
//        it, and a notice naming the consequences — and its one write is shut, with the reason on the control
//        (U-16). The Author's unlock is the way out and has no confirm step, because unlocking destroys nothing.
//   R4 — the unlock is shut while a Writer pass holds the group, on the same `writer_busy` read the unlock
//        route 409s with, and the two older refusal reasons (no verb, not locked) still come first.
//   R1 — WHO made the lock is a fact the pane prints rather than infers: an Editor's lock reads as the
//        Editor's, and a row that names no actor reads as `Crew` rather than as a guessed Author.
//   R1 — a refusal the SERVER sent is printed verbatim beside the verb that raised it, and it never paints a
//        locked badge over a group the phrase read still describes as open: the badge comes from the rows, the
//        sentence from the store's cache, and a refused lock is BOTH sentences at once.
//   R2 — one line says who else may lock on this Story, and it follows the Setting rather than a guess.
//   R6 — a lock does not hide the work still open: the findings a group carries, and the ones that span groups,
//        stay on the pane, because the OTHER groups are the half of the promise the lock creates.
//
// Expected strings are read off the fixture this file builds and off the words the contract module owns
// (`story-contract.groupLockStatement` and friends, quoted literally below), never off a screenshot.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SummaryGroupPane } from './SummaryGroupPane';
import { fixtureActions, fixturePhrase, fixtureView } from './story-fixtures';
import { click, groupedPhraseView } from '../testing/shell-fakes';
import type { PhraseGroupRow } from '../api';

/**
 * The clean grouped book: five written rows, no findings, none Writer-held (`testing/shell-fakes` owns the
 * shape). This is the state where a lock verb is live, and where an unlock is absent.
 */
function groupedView(options: { editorGroupLocking?: boolean } = {}) {
    return fixtureView({
        editorGroupLocking: options.editorGroupLocking === true,
        phrase: groupedPhraseView('s1')
    });
}

/**
 * The mid-review GROUPED book. `fixtureView()` with no `phrase` is a sampling-mode Story — the pane answers it
 * with the "no groups to open" line — so every case here passes the five fixture rows explicitly (the same
 * shape the pane's own test file uses). `editorGroupLocking` opts the Story into R2's Setting.
 */
function midReviewView(options: { editorGroupLocking?: boolean } = {}) {
    return fixtureView({
        editorGroupLocking: options.editorGroupLocking === true,
        phrase: fixturePhrase()
    });
}

/**
 * The same five groups with Premise moved into a lock state. `fixturePhrase()` is the mid-review book (Premise
 * is written three times and is not Writer-held, so it is the one row the lock route would accept), and only
 * the keys a case names are set — an absent `locked` is the wire's "open", so everything else in the fixture
 * keeps its meaning.
 */
function viewWithPremise(overrides: Partial<PhraseGroupRow>, editorGroupLocking = false) {
    const phrase = fixturePhrase();
    const groups: PhraseGroupRow[] = phrase.groups.map((group) =>
        group.key === 'premise' ? { ...group, ...overrides } : group
    );

    return fixtureView({
        editorGroupLocking,
        phrase: { ...phrase, groups },
    });
}

/** Premise, locked in by the Author at Revision 4 — the number the badge has to repeat. */
function authorLockedView() {
    return viewWithPremise({
        locked: true,
        locked_revision: 4,
        locked_by: 'author',
        locked_at: '2026-11-11T09:00:00.000Z'
    });
}

describe('SummaryGroupPane — locking a group in (R1)', () => {
    it('offers one verb on an open group, and nothing about a lock the desk never made', () => {
        // The clean five rows (`shell-fakes.groupedPhraseView`): every group written once and none Writer-held,
        // which is the state where the lock verb is live. The mid-review fixture's Premise is at Revision 3 and
        // its Theme is held by the Writer, so it cannot stand in for "a group the route would take".
        render(
            <SummaryGroupPane
                view={groupedView()}
                actions={fixtureActions().actions}
                groupId="grp-premise"
            />
        );

        expect(screen.getByRole('button', { name: 'Lock this group in' }).hasAttribute('disabled')).toBe(false);
        expect(screen.queryByRole('button', { name: 'Unlock this group' })).toBeNull();
        expect(screen.queryByTestId('group-locked')).toBeNull();
        expect(screen.queryByTestId('group-locked-notice')).toBeNull();
        expect(screen.queryByTestId('group-lock-confirm-block')).toBeNull();
    });

    it('arms the confirmation on the first click, says all three consequences, and sends nothing yet', async () => {
        const harness = fixtureActions();

        render(<SummaryGroupPane view={midReviewView()} actions={harness.actions} groupId="grp-premise" />);

        await click(screen.getByRole('button', { name: 'Lock this group in' }));

        // The sentence is the decision: a lock freezes the text, voids this group's findings, and promises the
        // text to the OTHER four groups — all three have to be readable before the commit.
        expect(screen.getByTestId('group-lock-note').textContent).toBe(
            'Locking Revision 3 of “Premise” makes it settled content: this group stops being editable, the findings aimed at it are void, and the other groups adapt to the text that now stands. Only the Author can unlock it.'
        );
        expect(screen.getByRole('button', { name: 'Lock it in' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Leave it open' })).toBeTruthy();
        // Armed is not sent: the route call belongs to the confirm, and nothing has been committed.
        expect(harness.calls.lockPhraseGroup).toBeUndefined();
    });

    it('sends the lock for THIS Story and THIS group on the confirm, and drops the confirmation with it', async () => {
        const harness = fixtureActions();

        render(<SummaryGroupPane view={midReviewView()} actions={harness.actions} groupId="grp-premise" />);

        await click(screen.getByRole('button', { name: 'Lock this group in' }));
        await click(screen.getByRole('button', { name: 'Lock it in' }));

        // The UUID, never a key or an index: the route addresses the group the way every other group verb does.
        expect(harness.calls.lockPhraseGroup).toEqual([['s1', 'grp-premise']]);
        expect(screen.queryByTestId('group-lock-confirm-block')).toBeNull();
    });

    it('leaves the group open when the Author backs out of the confirmation', async () => {
        const harness = fixtureActions();

        render(<SummaryGroupPane view={midReviewView()} actions={harness.actions} groupId="grp-premise" />);

        await click(screen.getByRole('button', { name: 'Lock this group in' }));
        await click(screen.getByRole('button', { name: 'Leave it open' }));

        expect(screen.queryByTestId('group-lock-confirm-block')).toBeNull();
        expect(harness.calls.lockPhraseGroup).toBeUndefined();
        // Backing out also re-arms the verb, so the next click is a fresh decision rather than a queued send.
        expect(screen.getByRole('button', { name: 'Lock this group in' }).hasAttribute('disabled')).toBe(false);
    });
});

describe('SummaryGroupPane — a group that is already locked in (R1)', () => {
    it('badges the revision the lock stands on and the hand that made it, and says what the lock does', () => {
        render(<SummaryGroupPane view={authorLockedView()} groupId="grp-premise" />);

        // Both halves are the request: `Locked` alone cannot say WHICH text is frozen once the loop has
        // installed another revision (the row is at Revision 3, the lock stands at Revision 4).
        expect(screen.getByTestId('group-locked').textContent).toBe('Locked at Revision 4 · by Author');
        expect(screen.getByTestId('group-locked-notice').textContent).toBe(
            'This group is locked in by author: the text is settled content, it cannot be revised from this pane, and the findings aimed at it are void. The other groups adapt to it. Only the Author can unlock it.'
        );
        // The badge belongs to the head's status furniture, and the pane's own state line stays the Writer's
        // account of the text — a lock is a person's decision, not a revision fact.
        expect(screen.getByTestId('group-status').textContent).toBe('Revision 3 · 74 chars');
    });

    it('names the Editor when the Editor made the lock, and never guesses an Author', () => {
        render(
            <SummaryGroupPane
                view={viewWithPremise({ locked: true, locked_revision: 2, locked_by: 'editor' })}
                groupId="grp-premise"
            />
        );

        expect(screen.getByTestId('group-locked').textContent).toBe('Locked at Revision 2 · by Editor');
        expect(screen.getByTestId('group-locked-notice').textContent).toContain('locked in by editor');
    });

    it('says `Crew` for a row that marks the group locked but names no actor, rather than inventing one', () => {
        render(<SummaryGroupPane view={viewWithPremise({ locked: true })} groupId="grp-premise" />);

        // `locked_revision` is absent too, so the honest fallback is the text that stands now — Revision 3.
        expect(screen.getByTestId('group-locked').textContent).toBe('Locked at Revision 3 · by Crew');
    });

    it('shuts the whole write and says why, so the Author is not left typing into a settled section', () => {
        const { container } = render(
            <SummaryGroupPane view={authorLockedView()} actions={fixtureActions().actions} groupId="grp-premise" />
        );

        expect(screen.getByTestId('group-revise-locked').textContent).toBe(
            'Locked content is settled and cannot be revised (R1). Unlock Premise to write the next revision.'
        );
        expect(screen.getByRole('textbox', { name: 'Rewrite Premise' }).hasAttribute('disabled')).toBe(true);
        expect(screen.getByRole('textbox', { name: 'Note for the Editor' }).hasAttribute('disabled')).toBe(true);

        const submit = screen.getByRole('button', { name: 'Revise this group' });

        expect(submit.hasAttribute('disabled')).toBe(true);
        // U-16: the reason is on the control, and it is the LOCK rather than a busy-flag that would expire.
        expect(submit.getAttribute('title')).toBe(
            'Premise is locked in — locked content is settled and cannot be revised (R1). Unlock it first to write a new revision.'
        );
        const revise = container.querySelector('[data-testid="group-revise"]');

        // Typing into a locked group cannot smuggle a revision through: the pane's own submit refuses it.
        expect(revise?.textContent).toContain('Locked content is settled');
    });

    it('offers the Author an unlock with no second guesswork, and sends it for this group', async () => {
        const harness = fixtureActions();

        render(<SummaryGroupPane view={authorLockedView()} actions={harness.actions} groupId="grp-premise" />);

        // One click: unlocking destroys nothing, and a confirm on the way OUT of a decision is friction on the
        // only exit an Editor's lock has.
        expect(screen.queryByTestId('group-lock')).toBeNull();
        await click(screen.getByRole('button', { name: 'Unlock this group' }));

        expect(harness.calls.unlockPhraseGroup).toEqual([['s1', 'grp-premise']]);
    });

    it('keeps the findings the group carries — including the one that spans every group — on a locked pane', () => {
        const { container } = render(<SummaryGroupPane view={authorLockedView()} groupId="grp-premise" />);

        // Premise's own finding list is the UNSCOPED `f-wide`, whose R3 resolution names all five groups. A lock
        // voids this group's own findings in the ROUTE, but the pane that has to explain the lock is the wrong
        // place to hide the work the other four groups still owe — the lock is a promise THEY have to keep.
        expect(
            Array.from(container.querySelectorAll('li[data-testid^="finding-f"]')).map((row) =>
                String(row.getAttribute('data-testid'))
            )
        ).toEqual(['finding-f-wide']);
        expect(screen.getByTestId('group-findings-count').textContent).toBe('1 open · 1 critical/major');
    });

    it('keeps the same finding on the matching UNLOCKED pane, so the lock is not what prints it', () => {
        const { container } = render(<SummaryGroupPane view={midReviewView()} groupId="grp-premise" />);

        expect(
            Array.from(container.querySelectorAll('li[data-testid^="finding-f"]')).map((row) =>
                String(row.getAttribute('data-testid'))
            )
        ).toEqual(['finding-f-wide']);
    });
});

describe('SummaryGroupPane — the lock route said no (R1, L-13)', () => {
    it('prints the refusal beside the verb that raised it, and keeps the group exactly as the read describes it', async () => {
        const harness = fixtureActions();
        // The store caches the server's sentence per group (`state.ts:groupLockWrite`) and the frame carries it
        // to the pane (`story-contract.groupLockError`). The route refused; `locked` never moved.
        const view = {
            ...midReviewView(),
            groupLockErrors: {
                's1:grp-premise':
                    'Locking this group was refused: 409: the Writer is replacing this group right now (R4).'
            }
        };

        render(<SummaryGroupPane view={view} actions={harness.actions} groupId="grp-premise" />);

        expect(screen.getByTestId('group-lock-error').getAttribute('role')).toBe('alert');
        expect(screen.getByTestId('group-lock-error').textContent).toBe(
            'Locking this group was refused: 409: the Writer is replacing this group right now (R4).'
        );
        // A refusal is not a success: no badge appears over a group the phrase read still calls open, and the
        // write is still available — the Author has a next action, not a dead end.
        expect(screen.queryByTestId('group-locked')).toBeNull();
        expect(screen.getByRole('button', { name: 'Lock this group in' }).hasAttribute('disabled')).toBe(false);
        expect(harness.calls.lockPhraseGroup).toBeUndefined();
    });

    it('names which verb was refused, so an unlock refusal cannot be read as a lock refusal', () => {
        const view = {
            ...authorLockedView(),
            groupLockErrors: {
                's1:grp-premise': 'Unlocking this group was refused: 403: only the Author lifts a lock (R1).'
            }
        };

        render(<SummaryGroupPane view={view} groupId="grp-premise" />);

        expect(screen.getByTestId('group-lock-error').textContent).toBe(
            'Unlocking this group was refused: 403: only the Author lifts a lock (R1).'
        );
        // The lock still stands — the refusal did not quietly undo it.
        expect(screen.getByTestId('group-locked').textContent).toBe('Locked at Revision 4 · by Author');
    });

    it('shows a refusal for one group on that group only', () => {
        const view = {
            ...midReviewView(),
            groupLockErrors: { 's1:grp-tone': 'Locking this group was refused: 409: unwritten group.' }
        };

        render(<SummaryGroupPane view={view} groupId="grp-premise" />);

        expect(screen.queryByTestId('group-lock-error')).toBeNull();
    });
});

describe('SummaryGroupPane — why a lock control is shut (R1, R4, U-16)', () => {
    it('refuses to lock a group that has nothing written, in the wire’s own terms', () => {
        render(
            <SummaryGroupPane view={midReviewView()} actions={fixtureActions().actions} groupId="grp-ending" />
        );

        const lock = screen.getByRole('button', { name: 'Lock this group in' });

        expect(lock.hasAttribute('disabled')).toBe(true);
        expect(lock.getAttribute('title')).toBe(
            'Nothing is written to lock in yet — the lock commits a revision, and this group has none.'
        );
    });

    it('refuses to lock a group the Writer is replacing, which is the same read the route refuses with (R4)', () => {
        render(
            <SummaryGroupPane view={midReviewView()} actions={fixtureActions().actions} groupId="grp-theme" />
        );

        const lock = screen.getByRole('button', { name: 'Lock this group in' });

        expect(lock.hasAttribute('disabled')).toBe(true);
        expect(lock.getAttribute('title')).toBe(
            'The Writer is rewriting this group right now — the lock route refuses to commit text that is about to move (R4).'
        );
    });

    // R4 (T8 finding 4) — the UNLOCK carries the same hold as the LOCK, because the route in front of it
    // does: `api/routes.ts`'s unlock leg checks `liveGroupWriters` before it calls `unlockPhraseGroup`, so
    // a rail that offered the verb would be offering a 409. The lock may be holding off an install that was
    // dispatched before it, and opening the section under that pass would land unreviewed text.
    it('refuses to unlock a group the Writer is replacing, which is the read the unlock route refuses with (R4)', async () => {
        const harness = fixtureActions();

        render(
            <SummaryGroupPane
                view={viewWithPremise({
                    locked: true,
                    locked_revision: 4,
                    locked_by: 'author',
                    locked_at: '2026-11-11T09:00:00.000Z',
                    writer_busy: true
                })}
                actions={harness.actions}
                groupId="grp-premise"
            />
        );

        const unlock = screen.getByRole('button', { name: 'Unlock this group' });

        expect(unlock.hasAttribute('disabled')).toBe(true);
        expect(unlock.getAttribute('title')).toBe(
            'The Writer is rewriting this group right now — the unlock route refuses to open a section under a pass that has not installed its text (R4).'
        );
        // U-16 with teeth: a shut control sends nothing, so the rail cannot race the install the route is
        // about to refuse. The lock still stands, and the badge says so.
        await click(unlock);

        expect(harness.calls.unlockPhraseGroup).toBeUndefined();
        expect(screen.getByTestId('group-locked').textContent).toBe('Locked at Revision 4 · by Author');
    });

    it('keeps the not-locked and no-verb refusals ahead of the Writer hold, so an open group is never told to wait', () => {
        const harness = fixtureActions();

        // A Writer-held group that is NOT locked: the blocker is that there is nothing to unlock, not the
        // hold, and the unlock verb is not even rendered on an open pane.
        const open = render(
            <SummaryGroupPane
                view={viewWithPremise({ writer_busy: true })}
                actions={harness.actions}
                groupId="grp-premise"
            />
        );

        expect(open.queryByRole('button', { name: 'Unlock this group' })).toBeNull();
        // The LOCK control keeps its own hold refusal, unchanged by this rule (R4).
        expect(open.getByRole('button', { name: 'Lock this group in' }).getAttribute('title')).toBe(
            'The Writer is rewriting this group right now — the lock route refuses to commit text that is about to move (R4).'
        );
        open.unmount();

        // A locked group in a shell with no unlock verb still hears about the shell first — the missing verb
        // is the shell's fault, and it is the reason the control can never fire.
        const noVerb = render(
            <SummaryGroupPane
                view={viewWithPremise({
                    locked: true,
                    locked_revision: 4,
                    locked_by: 'author',
                    locked_at: '2026-11-11T09:00:00.000Z',
                    writer_busy: true
                })}
                actions={{}}
                groupId="grp-premise"
            />
        );

        expect(noVerb.getByRole('button', { name: 'Unlock this group' }).getAttribute('title')).toBe(
            'The group unlock route is not available in this shell.'
        );
        expect(harness.calls.unlockPhraseGroup).toBeUndefined();
    });

    it('says so when the shell has no lock verb, rather than offering a dead button', () => {
        const open = render(<SummaryGroupPane view={midReviewView()} actions={{}} groupId="grp-premise" />);
        const lock = open.getByRole('button', { name: 'Lock this group in' });

        expect(lock.hasAttribute('disabled')).toBe(true);
        expect(lock.getAttribute('title')).toBe('The group lock route is not available in this shell.');
        open.unmount();

        // A locked group in the same shell says the same thing about its way out (U-16).
        const locked = render(<SummaryGroupPane view={authorLockedView()} actions={{}} groupId="grp-premise" />);
        const unlock = locked.getByRole('button', { name: 'Unlock this group' });

        expect(unlock.hasAttribute('disabled')).toBe(true);
        expect(unlock.getAttribute('title')).toBe('The group unlock route is not available in this shell.');
    });

    it('is not offered twice on a group that is already locked', () => {
        render(<SummaryGroupPane view={authorLockedView()} groupId="grp-premise" />);

        expect(screen.queryByRole('button', { name: 'Lock this group in' })).toBeNull();
    });
});

describe('SummaryGroupPane — who else may lock on this Story (R2)', () => {
    it('names the Editor when the Setting is on, and the Author alone when it is off', () => {
        const on = render(
            <SummaryGroupPane view={midReviewView({ editorGroupLocking: true })} groupId="grp-premise" />
        );

        expect(on.getByTestId('group-lock-who').textContent).toBe(
            'This Story lets the Editor lock a group in too, on its own judgement over the Critic findings and the Reader score for it. Only you can unlock one.'
        );
        on.unmount();

        const off = render(<SummaryGroupPane view={midReviewView()} groupId="grp-premise" />);

        // ABSENT MEANS OFF: a Story written before the Setting exists keeps the rule the Author always had.
        expect(off.getByTestId('group-lock-who').textContent).toBe(
            'Only the Author locks a group in on this Story — the Editor-locking Setting is off in Settings.'
        );
    });
});
