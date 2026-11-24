// R6 / U3 + U4 + U7 — ONE SUMMARY GROUP's pane: the buttons the rail's five group rows open.
//
// What is pinned here:
//   U3 — the pane states the group by TITLE, prints its PURPOSE line, its CURRENT content, its
//        `Revision N` status, its open findings, and the COUNT of archived revisions.
//   U4 — the findings a group carries, including the ones that span groups (the cross-group chips),
//        the finding the Reviewer never scoped (which names ALL FIVE groups), a fixed finding (which
//        is archived out and appears nowhere), and a purposeful empty state for an unwritten group.
//   U5 — `writer_busy` shuts the Author's one write, and the control SAYS why (U-16).
//   U2/U6 — the pane is addressed by the group's UUID; a ref that names no live group falls back to a
//        line that says so, never to a blank pane that looks like an unwritten group.
//   U7 — every control has an honest accessible name, and the row text a reader hears is spaced.
//
// The expected strings are read off the fixture the test builds (`fixturePhrase()` documents its own
// state), not off a screenshot: Premise is written three times with two superseded rows, Promise is
// under review, Theme is held by the Writer, Tone and Ending are named only by the unscoped finding,
// and Ending has never been written.
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { SummaryGroupPane } from './SummaryGroupPane';
import { fixtureActions, fixturePhrase, fixtureView } from './story-fixtures';
import { click, groupedPhraseView } from '../testing/shell-fakes';
import { phraseGroupDefinition } from '../../shared/phrase';
import type { PhraseView } from '../api';

/** The mid-review grouped book. */
function midReviewView() {
    return fixtureView({ phrase: fixturePhrase() });
}

/** A grouped view over `groupedPhraseView`'s clean five rows, for the states the fixture omits. */
function groupedView(phrase: Partial<PhraseView> = {}) {
    return fixtureView({ phrase: groupedPhraseView('s1', phrase) });
}

/**
 * Mounts one group's pane.
 *
 * `actions` defaults to a FRESH recording harness, so a read test gets a bound verb (and can assert it was
 * not called), while a test that wants the unbound shell passes `actions={{}}` explicitly.
 */
function renderGroup(
    groupId: string,
    options: {
        view?: ReturnType<typeof midReviewView>;
        actions?: Parameters<typeof SummaryGroupPane>[0]['actions'];
        onSelect?: Parameters<typeof SummaryGroupPane>[0]['onSelect'];
    } = {}
) {
    const harness = fixtureActions();

    return {
        calls: harness.calls,
        ...render(
            <SummaryGroupPane
                view={options.view ?? midReviewView()}
                actions={options.actions ?? harness.actions}
                groupId={groupId}
                onSelect={options.onSelect}
            />
        )
    };
}

describe('SummaryGroupPane — the group stated by name, purpose, text and revision (U3)', () => {
    it('shows Premise by title, its current content, and the revision number the rail stopped printing', () => {
        const { container } = renderGroup('grp-premise');

        expect(screen.getByTestId('group-title').textContent).toBe('Premise');
        expect(screen.getByTestId('group-revision').textContent).toBe('Revision 3');
        expect(screen.getByTestId('group-content').textContent).toBe(
            'A keeper of a lighthouse begins lying to the sea, and the sea believes her.'
        );
        // The status line is the CURRENT revision's own row: its number and its size, from the `latest`
        // history row the projection sends (R2).
        expect(screen.getByTestId('group-status').textContent).toBe('Revision 3 · 74 chars');
        expect(container.textContent).toContain('last written by writer');
    });

    it('prints the catalog’s own purpose line for every group, so five panes are five sections of a book', () => {
        for (const key of ['premise', 'promise', 'theme', 'tone', 'ending']) {
            const { unmount } = renderGroup(`grp-${key}`);

            // The words come from `shared/phrase`, the same catalog the server composes the Overview
            // from — a pane that reworded them would be writing product copy of its own.
            expect(screen.getByTestId('group-purpose').textContent).toBe(
                phraseGroupDefinition(key)?.description
            );
            unmount();
        }
    });

    it('shows no archived count on a group whose current revision is its first (R-T2/F5)', () => {
        // These rows are each at revision 1 with one `latest` history row: NOTHING superseded. The pane's job
        // is the COUNT of superseded revisions (U3), and zero of them is not a fact about the book — beside
        // `Revision 1` it read as a defect, so the span is absent rather than printing `0 archived`.
        renderGroup('grp-tone', { view: groupedView() });

        expect(screen.getByTestId('group-revision').textContent).toBe('Revision 1');
        expect(screen.queryByTestId('group-archived')).toBeNull();
        expect(document.body.textContent).not.toContain('archived');
    });

    it('hands over a multi-line group text whole, so a three-line section is not cut to two (R-T2/F6)', () => {
        // The prose region is the group's ONE reading copy, so it has to be the COMPLETE copy as well: the
        // stylesheet gives it three lines of room (`flex: none` plus a three-line min-height, because the base
        // rule's `flex: 1 1 18rem` is a shrinkable HEIGHT basis inside a column pane) and lets a long token
        // break. This is the payload half of that: every line the server sent reaches the node.
        const threeLines =
            'A keeper inherits the light, and the logbook that came with it.\n' +
            'She lies to the sea every night, and the sea keeps the ledger.\n' +
            'By spring the ledger has her name in it twice.';
        const base = groupedPhraseView('s1');
        const view = groupedView({
            groups: base.groups.map((group) => (group.key === 'tone' ? { ...group, content: threeLines } : group))
        });

        renderGroup('grp-tone', { view });

        const prose = screen.getByTestId('group-content');

        expect(prose.textContent).toBe(threeLines);
        expect(prose.classList.contains('sv-group-content')).toBe(true);
        expect(prose.getAttribute('aria-hidden')).toBeNull();
    });

    it('counts the archived revisions and shows none of their prose, because the wire sends none (U3)', () => {        const { container } = renderGroup('grp-premise');

        // Premise's history is [latest 74, archived 61, archived 40] (R2: metadata and `chars`, never text).
        expect(screen.getByTestId('group-archived').textContent).toBe('2 archived');
        const text = String(container.textContent);

        for (const proseOfAnArchivedRow of ['61 chars', '40 chars']) {
            expect(text.includes(proseOfAnArchivedRow), proseOfAnArchivedRow).toBe(false);
        }
        // …and no control claims to open one.
        expect(screen.queryAllByRole('button', { name: /archived|history|previous/i })).toHaveLength(0);
    });

    it('states the finding count with the sentence that says what the count costs', () => {
        renderGroup('grp-promise');

        expect(screen.getByTestId('group-findings-count').textContent).toBe('3 open · 2 hold the sign-off');
        expect(screen.getByTestId('group-blocking').textContent).toBe('2 holding the sign-off');
    });
});

describe('SummaryGroupPane — the findings a group owes, and the groups they span (U4)', () => {
    it('lists the open findings in the order the phrase read sent them, and drops the fixed one (U5)', () => {
        const { container } = renderGroup('grp-promise');

        const rows = Array.from(container.querySelectorAll('li[data-testid^="finding-"]'));

        // `f-cross` (critical), `f-wide` (the unscoped major), `f-minor` (the note). `f-fixed` is a `fixed`
        // row against Premise, and a fixed finding is archived out of every active list (U5).
        expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
            'finding-f-cross',
            'finding-f-wide',
            'finding-f-minor'
        ]);
        expect(rows.map((row) => `${row.getAttribute('data-cost')}/${row.getAttribute('data-state')}`)).toEqual([
            'critical/confirmed',
            'major/unconfirmed',
            'minor/approved'
        ]);
        expect(container.textContent).not.toContain('the lighthouse was a different colour');
    });

    it('names the other groups a cross-group finding spans, in the engine’s titles (U4)', () => {
        const { container } = renderGroup('grp-promise');

        const row = container.querySelector('[data-testid="finding-f-cross"]') as HTMLElement;

        // The whole row, in reading order, with real word boundaries between its spans: cost, the sentence
        // the Reviewer wrote, how often it had to be raised, the other group it aims at, and the group whose
        // text has not answered it yet (R3).
        expect(row.textContent).toBe(
            'critical the promise names a cost the premise never sets up raised 3× also Theme still missing on Theme'
        );
        expect(
            (container.querySelector('[data-testid="finding-f-cross-groups"]') as HTMLElement).textContent
        ).toBe('also Theme');
        expect(row.querySelectorAll('.sv-group-finding-chip')).toHaveLength(1);
    });

    it('says when one finding stands against all five groups, and names every one of them (U4, R3)', () => {
        // The finding the Reviewer never scoped (`unscoped`, no `group_refs`) is a statement about the whole
        // Overview. A pane that matched on `group_refs` alone would print "nothing open on this group" over
        // the one finding that concerns all five — the invisibility this redesign exists to fix.
        const { container } = renderGroup('grp-promise');
        const wide = container.querySelector('[data-testid="finding-f-wide"]') as HTMLElement;

        expect(wide.getAttribute('data-cost')).toBe('major');
        expect(
            (container.querySelector('[data-testid="finding-f-wide-groups"]') as HTMLElement).textContent
        ).toBe('also Premise also Theme also Tone also Ending');
        expect(wide.querySelectorAll('.sv-group-finding-chip')).toHaveLength(4);
        expect(wide.textContent).toContain('still missing on Premise, Theme, Tone, Ending');
    });

    it('marks a finding the Author has already approved as waiting on its revision, not on the Author', () => {
        const { container } = renderGroup('grp-promise');
        const minor = container.querySelector('[data-testid="finding-f-minor"]') as HTMLElement;

        // `approved` is still an OPEN state (it awaits the Writer), and the row says which wait it is. The
        // finding is scoped to Promise alone, so it carries no cross-group chips.
        expect(minor.textContent).toBe(
            'minor the promise restates the premise in other words approved — awaiting its revision'
        );
        expect(minor.querySelector('[data-testid="finding-f-minor-groups"]')).toBeNull();
    });

    it('shows the debt the next revision has to answer, from the server’s own field (R3)', () => {
        renderGroup('grp-theme');

        expect(screen.getByTestId('group-owed').textContent).toBe('1 finding its next revision must answer');
        // A group the wire does not owe anything gets no row at all — not a row that says zero.
        const premise = renderGroup('grp-promise');

        expect(premise.container.querySelector('[data-testid="group-owed"]')).toBeNull();
    });

    it('gives an unwritten group an empty state that says why and what fills it (U4)', () => {
        const { container } = renderGroup('grp-ending');

        expect(screen.getByTestId('group-revision').textContent).toBe('No revision yet');
        expect(screen.getByTestId('group-status').textContent).toBe('not written');
        expect(screen.getByTestId('group-empty').textContent).toBe(
            'No content yet. The loop writes this group when the Editor puts it in the queue, or you can write it below.'
        );
        expect(screen.queryByTestId('group-content')).toBeNull();
        // R-T2/F5: the archived count renders only when it is a number worth reading. An unwritten group has
        // no history at all, and `0 archived` beside `not written` is noise that reads like a defect.
        expect(screen.queryByTestId('group-archived')).toBeNull();
        expect(container.textContent).not.toContain('0 archived');
        // `updated_by` is null on a group nobody has written, and the pane does not print the word "null".
        expect(container.textContent).not.toContain('last written by');
    });

    it('says plainly when a group has nothing open on it', () => {
        const { container } = render(<SummaryGroupPane view={groupedView()} groupId="grp-tone" />);

        expect(screen.getByTestId('group-findings-empty').textContent).toBe('Nothing open on this group.');
        expect(container.querySelector('.sv-group-findings')).toBeNull();
        expect(screen.getByTestId('group-findings-count').textContent).toBe('none open');
    });
});

describe('SummaryGroupPane — the Writer holding a group shuts the write (U5, R4)', () => {
    it('disables the textarea, the note and the send, and states the reason on the control (U-16)', () => {
        const harness = fixtureActions();

        renderGroup('grp-theme', { actions: harness.actions });

        const area = screen.getByRole('textbox', { name: 'Rewrite Theme' }) as HTMLTextAreaElement;
        const note = screen.getByRole('textbox', { name: 'Note for the Editor' }) as HTMLInputElement;
        const submit = screen.getByRole('button', { name: 'Revise this group' }) as HTMLButtonElement;

        expect(area.disabled).toBe(true);
        expect(note.disabled).toBe(true);
        expect(submit.disabled).toBe(true);
        // The reason is the wire's own state — the same read the route refuses with — not a guess (F8/R4).
        expect(submit.title).toBe(
            'The Writer is rewriting this group right now — the revise route refuses the write until it lands (R4).'
        );
        expect(screen.getByTestId('group-writer').textContent).toBe('Writer busy');
        expect(screen.getByTestId('group-busy').textContent).toBe(
            'The Writer is replacing this text right now. The pane shows the new revision when it lands.'
        );
        // Reading is never blocked: the text that IS on the wire stays on screen, so the Author can read the
        // revision the Writer is replacing.
        expect(screen.getByTestId('group-content').textContent).toBe(
            'What the book is about: the price of a story told to keep the dark out.'
        );
        // The pane's own tone says WHY it is shut, for the stylesheet and for a reader who inspects the node.
        expect(document.querySelector('[data-testid="group-pane-theme"]')?.getAttribute('data-tone')).toBe(
            'writer'
        );

        fireEvent.click(submit);
        // A disabled control never reaches the route — the 409 stays on the wire where it belongs.
        expect(harness.calls.revisePhraseGroup).toBeUndefined();
    });

    it('states the shell’s own refusal when the verb is not bound', () => {
        renderGroup('grp-premise', { actions: {} });

        const submit = screen.getByRole('button', { name: 'Revise this group' }) as HTMLButtonElement;

        expect(submit.disabled).toBe(true);
        expect(submit.title).toBe('The group revise route is not available in this shell.');
    });
});

describe('SummaryGroupPane — the Author’s one write against a group (R2)', () => {
    it('sends the edited text and the note to the group addressed by its UUID', async () => {
        const harness = fixtureActions();

        renderGroup('grp-tone', { view: groupedView(), actions: harness.actions });

        const area = screen.getByRole('textbox', { name: 'Rewrite Tone' }) as HTMLTextAreaElement;

        // R-T2/F6 — the field does NOT mirror the record. The prose region above is the group's ONE reading
        // copy; a textarea prefilled with the same paragraphs made a screen reader announce the whole text
        // twice, once as prose and once as the field's value. The field starts empty and its placeholder names
        // what it replaces, so an empty field cannot be misread as "the book says nothing".
        expect(area.value).toBe('');
        expect(area.getAttribute('placeholder')).toBe('Write the new Tone text — the current revision is above');

        // …and the text is on the screen exactly once, as prose, and not hidden from assistive tech.
        const copies = Array.from(document.querySelectorAll('[data-testid="group-content"]'));

        expect(copies).toHaveLength(1);
        expect(copies[0]?.textContent).toBe('Tone — the text the Writer installed (group 4).');
        expect(copies[0]?.getAttribute('aria-hidden')).toBeNull();

        fireEvent.change(area, { target: { value: 'Plain sentences, salt in every image.' } });
        fireEvent.change(screen.getByRole('textbox', { name: 'Note for the Editor' }), {
            target: { value: 'the last revision lost the salt' }
        });

        await click(screen.getByRole('button', { name: 'Send this text' }));

        // The exact route arguments: Story id, group UUID, and the input the revise route takes. The group
        // is addressed by its id STRING — never an index or an `order` — so a refetch cannot move the write.
        expect(harness.calls.revisePhraseGroup).toEqual([
            [
                's1',
                'grp-tone',
                { content: 'Plain sentences, salt in every image.', note: 'the last revision lost the salt' }
            ]
        ]);
    });

    it('waits for the Author to write something before it will send (R-T2/F6)', () => {
        // F6's field starts EMPTY, so the pane needs a stated "nothing to send yet" — the route refuses an
        // empty group text (R2, and the wire's 400 says so), and a click that would send the record back
        // unchanged is exactly the accident the field used to invite.
        const harness = fixtureActions();

        renderGroup('grp-tone', { view: groupedView(), actions: harness.actions });

        const submit = screen.getByRole('button', { name: 'Revise this group' }) as HTMLButtonElement;

        expect(submit.disabled).toBe(true);
        expect(submit.title).toBe(
            'Write the new text above first — the route refuses an empty group text (R2), so there is nothing to send yet.'
        );
        fireEvent.click(submit);
        expect(harness.calls.revisePhraseGroup).toBeUndefined();

        // Spaces are still nothing: the guard trims before it decides.
        const area = screen.getByRole('textbox', { name: 'Rewrite Tone' }) as HTMLTextAreaElement;

        fireEvent.change(area, { target: { value: '   ' } });
        expect((screen.getByRole('button', { name: 'Send this text' }) as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(screen.getByRole('button', { name: 'Send this text' }));
        expect(harness.calls.revisePhraseGroup).toBeUndefined();

        // Real words open the route again.
        fireEvent.change(area, { target: { value: 'Salt in every image.' } });
        fireEvent.click(screen.getByRole('button', { name: 'Send this text' }));

        expect(harness.calls.revisePhraseGroup).toEqual([['s1', 'grp-tone', { content: 'Salt in every image.' }]]);
    });

    it('sends no note key when the Author left the note empty, and trims one that is only spaces', async () => {
        const harness = fixtureActions();

        renderGroup('grp-tone', { view: groupedView(), actions: harness.actions });

        fireEvent.change(screen.getByRole('textbox', { name: 'Rewrite Tone' }), {
            target: { value: 'A colder ending, then.' }
        });
        fireEvent.change(screen.getByRole('textbox', { name: 'Note for the Editor' }), {
            target: { value: '   sharper cost   ' }
        });
        await click(screen.getByRole('button', { name: 'Send this text' }));

        fireEvent.change(screen.getByRole('textbox', { name: 'Rewrite Tone' }), {
            target: { value: 'And no authorial wink.' }
        });
        await click(screen.getByRole('button', { name: 'Send this text' }));

        expect(harness.calls.revisePhraseGroup).toEqual([
            ['s1', 'grp-tone', { content: 'A colder ending, then.', note: 'sharper cost' }],
            ['s1', 'grp-tone', { content: 'And no authorial wink.' }]
        ]);
        // `toEqual` treats an explicit `undefined` as absent, so the KEY list is checked too: the pane must
        // not send a `note` field the route did not receive a value for.
        expect(Object.keys(harness.calls.revisePhraseGroup[1]?.[2] as object)).toEqual(['content']);
    });

    it('drops the draft after sending, so the pane shows the record rather than the Author’s keys', async () => {
        const harness = fixtureActions();

        renderGroup('grp-tone', { view: groupedView(), actions: harness.actions });

        const area = screen.getByRole('textbox', { name: 'Rewrite Tone' }) as HTMLTextAreaElement;
        const note = screen.getByRole('textbox', { name: 'Note for the Editor' }) as HTMLInputElement;

        fireEvent.change(area, { target: { value: 'temporary words' } });
        fireEvent.change(note, { target: { value: 'temporary note' } });
        await click(screen.getByRole('button', { name: 'Send this text' }));

        // The pane owns no claim about the record: what appears next is what the server returns, and a
        // poll landing under the Author's fingers cannot corrupt it. The field goes back to EMPTY (R-T2/F6) —
        // the record is the prose region above, which is still the text the server has for this group.
        expect(area.value).toBe('');
        expect(note.value).toBe('');
        expect(screen.getByTestId('group-content').textContent).toBe(
            'Tone — the text the Writer installed (group 4).'
        );
    });

    it('lets the Author write the first revision of a group nobody has written (U4)', async () => {
        const harness = fixtureActions();

        renderGroup('grp-ending', { actions: harness.actions });

        const area = screen.getByRole('textbox', { name: 'Rewrite Ending' }) as HTMLTextAreaElement;

        expect(area.disabled).toBe(false);
        expect(area.value).toBe('');

        fireEvent.change(area, { target: { value: 'The light goes out, and she walks into the dark.' } });
        // The empty state changes as soon as there is a draft: it stops describing the queue and starts
        // describing what the Author is doing.
        expect(screen.getByTestId('group-empty').textContent).toBe(
            'Nothing is on the record yet — what you write here is the first revision.'
        );

        await click(screen.getByRole('button', { name: 'Send this text' }));

        expect(harness.calls.revisePhraseGroup).toEqual([
            ['s1', 'grp-ending', { content: 'The light goes out, and she walks into the dark.' }]
        ]);
    });
});

describe('SummaryGroupPane — the rail’s ref, and what a stale one says (U2, U6)', () => {
    it('opens the group the ref addresses, not the row that happens to be first', () => {
        for (const key of ['premise', 'promise', 'theme', 'tone', 'ending']) {
            const { unmount } = renderGroup(`grp-${key}`);

            expect(screen.getByTestId(`group-pane-${key}`).getAttribute('data-testid')).toBe(
                `group-pane-${key}`
            );
            expect(screen.getByTestId('group-title').textContent).toBe(
                phraseGroupDefinition(key)?.title
            );
            unmount();
        }
    });

    it('keeps the right group after a refetch that reorders the rows (U2)', () => {
        // Same five groups, ids unchanged, delivered in reverse composition order. `phraseGroups` sorts by
        // `order`, and the pane looks the group up BY ID, so the pane cannot move.
        const reordered = [...fixturePhrase().groups].reverse();
        const phrase = { ...fixturePhrase(), groups: reordered };

        renderGroup('grp-promise', { view: fixtureView({ phrase }) });

        expect(screen.getByTestId('group-title').textContent).toBe('Promise');
        expect(screen.getByTestId('group-revision').textContent).toBe('Revision 2');
    });

    it('says the group is gone rather than showing an empty pane that looks unwritten (U6)', async () => {
        const seen: unknown[] = [];
        const handler = (selection: unknown): void => {
            seen.push(selection);
        };

        render(<SummaryGroupPane view={midReviewView()} groupId="grp-retired" onSelect={handler} />);

        expect(screen.getByTestId('group-pane-stale')).toBeTruthy();
        expect(document.body.textContent).toContain('This group is no longer part of the Summary.');
        // Not an unwritten group's empty state — that would be a lie about a group that no longer exists.
        expect(screen.queryByTestId('group-empty')).toBeNull();

        await click(screen.getByRole('button', { name: 'Open Summary' }));
        // The fallback is the Summary header's own selection shape, which is what the rail falls back to too.
        expect(seen).toEqual([{ panel: 'summary' }]);
    });

    it('shows its own loading line while the phrase read is still in flight (U6)', () => {
        const view = { ...midReviewView(), phrase: undefined };

        render(<SummaryGroupPane view={view} groupId="grp-promise" />);

        expect(screen.getByTestId('group-pane-pending')).toBeTruthy();
        expect(document.body.textContent).toContain('Their content arrives with the phrase read.');
    });

    it('states a FAILED phrase read as a failure, not as a wait (R-T2/F2)', () => {
        // Same frame as the loading line above, with the store's cached sentence attached: the pane may not
        // promise content "arriving" from a route that already refused. The message names the failure in the
        // server's own words and says what to do; the Story payload stays untouched (that failure, if any, is
        // the top bar's sentence, L-13).
        const failure = '503: the phrase read is offline (maintenance)';
        const view = { ...midReviewView(), phrase: undefined, phraseError: failure };

        render(<SummaryGroupPane view={view} groupId="grp-promise" />);

        expect(screen.getByTestId('group-pane-error')).toBeTruthy();
        expect(screen.queryByTestId('group-pane-pending')).toBeNull();
        expect(screen.getByTestId('group-read-error').textContent).toBe(
            `The Summary group rows could not be read: ${failure}`
        );
        expect(document.body.textContent).toContain('reload the Story to try again');
        // No group furniture is invented over an unread book: no prose, no revision badge, no revise field.
        expect(screen.queryByTestId('group-content')).toBeNull();
        expect(screen.queryByTestId('group-revision')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Revise this group' })).toBeNull();
    });

    it('has no groups to open on a sampling-mode book', () => {
        render(<SummaryGroupPane view={fixtureView()} groupId="grp-promise" />);

        expect(screen.getByTestId('group-pane-legacy')).toBeTruthy();
        expect(document.body.textContent).toContain('so it has no groups to open.');
    });
});

describe('SummaryGroupPane — a reader hears the pane the author sees (U7)', () => {
    it('names every control it puts in the Author’s hands', () => {
        const harness = fixtureActions();

        renderGroup('grp-premise', { actions: harness.actions });

        // Roles + names, not classes: a screen reader's whole view of this pane.
        expect(screen.getByRole('heading', { name: 'Premise', level: 3 })).toBeTruthy();
        expect(screen.getByRole('textbox', { name: 'Rewrite Premise' })).toBeTruthy();
        expect(screen.getByRole('textbox', { name: 'Note for the Editor' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Revise this group' })).toBeTruthy();
        // The badges say what the number costs, never the number alone.
        expect(screen.getByTestId('group-blocking').textContent).toBe('1 holding the sign-off');
        expect(screen.queryByTestId('group-writer')).toBeNull();
    });

    it('never puts a raw id or an object where the Author reads a sentence', () => {
        const { container } = renderGroup('grp-promise');
        const text = String(container.textContent);

        for (const internal of ['grp-', '[object', 'undefined', 'writer_busy', 'unscoped', 'seen_count']) {
            expect(text.includes(internal), internal).toBe(false);
        }
    });
});
