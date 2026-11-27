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
//   D-67 — the `Clean` stamp sits on the ONE revision a cross-group pass closed on, and a written group with
//        no score names the wait rather than printing `0%` (the Reader reads the clean vector, not the newest
//        draft, so an unscored section is the normal mid-review shape).
//
// The expected strings are read off the fixture the test builds (`fixturePhrase()` documents its own
// state), not off a screenshot: Premise is written three times with two superseded rows, Promise is
// under review, Theme is held by the Writer, Tone and Ending are named only by the unscoped finding,
// and Ending has never been written.
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { SummaryGroupPane } from './SummaryGroupPane';
import { fixtureActions, fixturePhrase, fixtureView } from '../testing/story-fixtures';
import { click, groupedPhraseView, reviewedPhraseView } from '../testing/shell-fakes';
import { phraseGroupDefinition } from '../testing/product-values';
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
 * The D-67 shape the DEFAULT fixtures do not hold: Ending's newest revision (r3) is NOT the clean one — the
 * clean stamp sits on the archived r2 — which is exactly what `reviewedPhraseView(…, 'ready')` models.
 */
function reviewedReadyView() {
    return fixtureView({ phrase: reviewedPhraseView('s1', 'ready') });
}

/** The same five clean rows with Tone's scoring trail emptied: a written group the Reader never scored. */
function unscoredToneRows() {
    return groupedPhraseView('s1').groups.map((group) =>
        group.key === 'tone' ? { ...group, scores: [] } : group
    );
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

/**
 * T2 — every block the group's prose region emitted, in DOM order, as `TAG:text`.
 *
 * The prose region is `MarkdownText` now, so a group's text is a BLOCK box rather than one string, and an exact
 * `textContent` comparison no longer says anything about whether `## Premise` became a heading or stayed a
 * literal — a heading and a literal hash produce the same words minus two characters. The blocks do say. A
 * list is flattened to its items joined by `|`, because a list's own `textContent` runs items together and a
 * dropped item would survive the assertion. Same device as `SummaryOverviewPane.test.tsx`'s `summaryBlocks`, but
 * handed the region node itself (`screen.getByTestId('group-content')`), which is how this file reads the copy.
 */
function groupBlocks(prose: ParentNode): string[] {
    return Array.from(prose.querySelectorAll('h1,h2,h3,h4,h5,h6,p,ul,ol')).map((block) =>
        block.tagName === 'UL' || block.tagName === 'OL'
            ? `${block.tagName}:${Array.from(block.querySelectorAll('li'))
                  .map((item) => item.textContent ?? '')
                  .join('|')}`
            : `${block.tagName}:${block.textContent ?? ''}`
    );
}

describe('SummaryGroupPane — the group stated by name, purpose, text and revision (U3)', () => {
    it('shows Premise by title, its current text diffed against the revision it replaced, and its revision number', () => {
        const { container } = renderGroup('grp-premise');

        expect(screen.getByTestId('group-title').textContent).toBe('Premise');
        expect(screen.getByTestId('group-revision').textContent).toBe('Revision 3');
        // R2/U3 — the current text is on screen against the text immediately before it. Only the words that
        // moved are marked: the changed run is one struck block and one added block, and the rest of the
        // sentence stays plain.
        const prose = screen.getByTestId('group-content');

        expect(prose.querySelector('del')?.textContent).toBe('starts ');
        expect(prose.querySelector('ins')?.textContent).toBe('begins ');
        // T2/AC4 — this branch is deliberately NOT the Markdown renderer. U3's rule is the WORD diff: one struck
        // run of removed words and one added run (`RevisionDiff.tsx`), which are inline HTML that
        // `react-markdown` would ESCAPE rather than render. So a group that is being compared still shows its
        // Markdown source — the spec accepts it ("the diff is prose, not a patch viewer",
        // `documents/specifications.md:1056`), and the tag plus the absence of `sv-markdown` are how the DOM says
        // which branch the Author is looking at.
        expect(prose.tagName).toBe('P');
        expect(prose.classList.contains('sv-markdown')).toBe(false);
        expect(prose.classList.contains('sv-group-diff')).toBe(true);
        expect(screen.getByTestId('group-diff-from').textContent).toBe(' · diff against Revision 2');
        // The status line is the CURRENT revision's own row: its number and its size, from the `latest`
        // history row the projection sends (R2).
        expect(screen.getByTestId('group-status').textContent).toBe('Revision 3 · 74 chars');
        expect(container.textContent).toContain('last written by writer');
    });

    it('prints a first revision as plain prose, because there is no previous revision to diff against', () => {
        renderGroup('grp-theme');

        const prose = screen.getByTestId('group-content');

        expect(prose.textContent).toBe('What the book is about: the price of a story told to keep the dark out.');
        expect(prose.querySelector('del')).toBeNull();
        expect(prose.querySelector('ins')).toBeNull();
        expect(screen.queryByTestId('group-diff-from')).toBeNull();
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
        // T2 — the reading copy is the shared Markdown renderer now, and it keeps every hook the pane and the
        // stylesheet address: ONE element (`sv-markdown` is appended, never replaced), the sizing class
        // (`sv-summary-text`, whose three-line/overflow contract `styles/story.css:1033-1060` holds), the reading
        // copy's own class, and no `aria-hidden`. The tag moved `p` → `div` with the renderer; no selector in
        // `styles/story.css` or `styles/app.css` addresses this node BY TAG, which is why the pane's sizing
        // survives the change.
        expect(prose.tagName).toBe('DIV');
        expect(prose.className).toBe('sv-markdown sv-summary-text sv-group-content');
        expect(prose.classList.contains('sv-group-content')).toBe(true);
        expect(prose.getAttribute('aria-hidden')).toBeNull();
    });

    it('renders a group’s text as Markdown, so `## Tone` is a heading and a `- ` line is a list item', () => {
        // WHAT THE PRODUCERS ACTUALLY SEND. A group's text is the prose the loop composes in the same shape
        // `shared/phrase.ts:composePhraseContent` joins the Overview from — a `## <title>` line, prose, and the
        // Markdown the Writer and the Author both type (bullets, `**bold**`). Printed as text the Author read the
        // SOURCE in the group pane, which is the complaint this change answers. The other fixtures in this file
        // pin the WORDING of single-line group texts; this one pins the READING of a shaped one.
        const markdown = [
            '## Tone',
            '',
            'Plain sentences, salt in **every** image.',
            '',
            '- no authorial wink',
            '- the sea keeps the ledger'
        ].join('\n');
        const base = groupedPhraseView('s1');
        const view = groupedView({
            groups: base.groups.map((group) => (group.key === 'tone' ? { ...group, content: markdown } : group))
        });

        const { container } = renderGroup('grp-tone', { view });
        const prose = screen.getByTestId('group-content');

        // The exact blocks, in source order: the heading is a heading, the paragraph is a paragraph with its
        // bold run, and the three bullets are ONE list of exactly those items.
        expect(groupBlocks(prose)).toEqual([
            'H2:Tone',
            'P:Plain sentences, salt in every image.',
            'UL:no authorial wink|the sea keeps the ledger'
        ]);
        expect(prose.querySelector('strong')?.textContent).toBe('every');
        // The markers a reader must not see — asserted against the WHOLE pane, because a stray `pre-wrap`
        // paragraph beside the card would keep printing them while the card itself looked right.
        expect(container.textContent).not.toContain('## ');
        expect(container.textContent).not.toContain('**');
        expect(container.textContent).not.toContain('- no authorial wink');
        // The exact text the wrapper holds, which is the payload assertion (R-T2/F6): every word the server sent
        // is here, once, in order. The `\n` runs are not paragraphing the renderer lost — `mdast-util-to-hast`
        // writes a newline TEXT NODE between sibling blocks and between list items (which is why a `pre-wrap`
        // container printed Markdown as double-spaced columns; `.sv-summary-text.sv-markdown` at
        // `styles/story.css:506-510` is what collapses them in ink). The BLOCKS above are what prove the shape.
        expect(prose.textContent).toBe(
            'Tone\nPlain sentences, salt in every image.\n\nno authorial wink\nthe sea keeps the ledger\n'
        );
        // AC2 — the full prose is still the pane's ONE accessible reading copy: nothing is hidden, and the
        // editor below is still empty rather than a second copy of the text.
        expect(prose.getAttribute('aria-hidden')).toBeNull();
        expect(container.querySelectorAll('[data-testid="group-content"]')).toHaveLength(1);
        expect((screen.getByRole('textbox', { name: 'Rewrite Tone' }) as HTMLTextAreaElement).value).toBe('');
    });

    it('counts the archived revisions and shows only the immediately previous body, as the diff (U3)', () => {
        const { container } = renderGroup('grp-premise');

        // Premise's history is [latest 74, archived 75, archived 40] (R2: metadata and `chars`; only the
        // revision directly before the latest travels as prose, for the diff).
        expect(screen.getByTestId('group-archived').textContent).toBe('2 archived');
        const text = String(container.textContent);

        for (const proseOfAnArchivedRow of ['75 chars', '40 chars']) {
            expect(text.includes(proseOfAnArchivedRow), proseOfAnArchivedRow).toBe(false);
        }
        // The one archived body on the wire is the revision the latest replaced — never the older one.
        expect(screen.getByTestId('group-content').querySelectorAll('del')).toHaveLength(1);
        // …and no control claims to open any archived revision.
        expect(screen.queryAllByRole('button', { name: /archived|history|previous/i })).toHaveLength(0);
    });

    it('states the finding count with the severity band that says which rows the band holds', () => {
        renderGroup('grp-promise');

        expect(screen.getByTestId('group-findings-count').textContent).toBe('3 open · 2 critical/major');
        expect(screen.getByTestId('group-blocking').textContent).toBe('2 critical/major findings');
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

        // The whole row, in reading order, with real word boundaries between its spans: the claim type (T3),
        // the cost, the sentence the Reviewer wrote, how often it had to be raised, the other group it aims at,
        // and the group whose text has not answered it yet (R3).
        expect(row.textContent).toBe(
            'Issue critical the promise names a cost the premise never sets up raised 3× also Theme still missing on Theme'
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
            'Proposal minor the promise restates the premise in other words approved — awaiting its revision'
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
        // The badges name the severity band the number counts, never the number alone (D-78 — never a wait,
        // either: the accept voids these rows).
        expect(screen.getByTestId('group-blocking').textContent).toBe('1 critical/major finding');
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

// ---------------------------------------------------------------------------
// T3 — the two facts the wire added to a group row.
//
// (a) WHAT a finding claims. `cost` has always said what repairing a row costs; `kind` says whether the Critic
// is calling the text BROKEN or only calling it IMPROVABLE, and the Author's answer is a different decision —
// one has to be repaired before the draft can stand, the other is weighed against the book the Seed promises.
// A findings list that prints only costs reads both in the same voice, which is how a preference gets approved
// as an emergency. The word is text, first in the row, so the linear read and a screen reader both get it
// before the price, and a row that names NO kind (the legacy case, `f-wide`) says `Issue` rather than blank.
//
// (b) The group's SCORE. The rail shows one number per group; this pane is where the number is explained — the
// mark the CURRENT clean revision carries and the mark it moved from, each with the Critic's own sentence when
// the pass wrote one. T5 replaced the dated pass-by-pass trail with those two rows: the Author's question is
// what this section scores NOW and what it scored the last time the Reader read it, and a timestamp beside a
// percentage answers neither. Both rows come from the same `PhraseGroupRow.scores` array the rail reads, so a
// pane and a row cannot disagree, and an unscored group renders NOTHING rather than a `0%` that claims a review
// that never ran.
// ---------------------------------------------------------------------------
describe('SummaryGroupPane — the claim type on a finding, and the group’s score (T3)', () => {
    it('says what each finding claims, in front of what it costs, and reads an unmarked row as an Issue (T3)', () => {
        const { container } = renderGroup('grp-promise');

        const rows = Array.from(container.querySelectorAll('li[data-testid^="finding-f"]'));

        // One chip per row, the row's FIRST words, and the class hook carries the same decision the text does
        // (the stylesheet may colour it, but it can never be the only carrier).
        expect(
            rows.map((row) => {
                const chip = row.querySelector<HTMLElement>('[data-testid$="-kind"]')!;

                return [
                    row.getAttribute('data-testid'),
                    chip.textContent,
                    chip.className,
                    // The first word of the row as a reader hears it — the chip, not the cost.
                    String(row.textContent).split(' ')[0]
                ];
            })
        ).toEqual([
            ['finding-f-cross', 'Issue', 'sv-finding-kind sv-finding-kind--issue', 'Issue'],
            ['finding-f-wide', 'Issue', 'sv-finding-kind sv-finding-kind--issue', 'Issue'],
            ['finding-f-minor', 'Proposal', 'sv-finding-kind sv-finding-kind--proposal', 'Proposal']
        ]);

        // The Proposal is the one row asking for a WORD change ("the promise restates the premise in other
        // words"), and it is the one row the Story's dial may auto-approve — the two facts belong together.
    });

    /**
     * T5 — a Premise row with `count` Reader passes, newest first. Three is enough to pin the rule: the pane
     * renders the current mark and the one it moved from, and the third pass is history rather than a row.
     */
    function premiseWithScores(count: number) {
        const phrase = fixturePhrase();
        const scores = [
            { value: 91, vector_hash: 'vh-4', at: '2026-11-12T10:00:00.000Z', run_ref: 'run_critic_vh-4' },
            { value: 84, vector_hash: 'vh-3', at: '2026-11-11T10:00:00.000Z', run_ref: 'run_critic_vh-3' },
            { value: 78, vector_hash: 'vh-2', at: '2026-11-10T10:00:00.000Z', run_ref: 'run_critic_vh-2' }
        ].slice(0, count);
        const groups = phrase.groups.map((group) => (group.key === 'premise' ? { ...group, scores } : group));

        return fixtureView({ phrase: { ...phrase, groups } });
    }

    it('prints the current clean mark and the mark it moved from, with no date on either (T5)', () => {
        const { container } = renderGroup('grp-premise');

        expect(container.querySelector('[data-testid="group-score"]')).toBeTruthy();
        expect(container.querySelector('[data-testid="group-score-value"]')?.textContent).toBe('Score 84%');
        expect(container.querySelector('[data-testid="group-score-delta"]')?.textContent).toBe('(up 6 from 78%)');
        expect(container.querySelector('[data-testid="group-score-rationale"]')?.textContent).toBe(
            'the lie is set up in the first sentence and paid for in the last'
        );

        // T5 — TWO marks, and only two. The dated trail this pane used to print is gone: a reader comparing
        // percentages is not asking WHEN the earlier one ran, and a timestamp beside a score competes with the
        // revision number that actually identifies the text. The words `Current clean revision` / `Previous
        // mark` carry which is which (D-67 put the Reader's verdict on the clean vector, which is why the
        // current one is named for the text it judged); the row's `title` still holds the pass's run and vector,
        // because one Reader pass scores all five groups against one text vector and a mark from a DIFFERENT
        // vector is a different book.
        expect(
            Array.from(container.querySelectorAll('li.sv-group-score-mark')).map((row) => [
                String(row.textContent).replace(/\s+/g, ' ').trim(),
                row.getAttribute('data-mark'),
                row.getAttribute('title')
            ])
        ).toEqual([
            [
                'Current clean revision 84% the lie is set up in the first sentence and paid for in the last',
                'current',
                'run run_critic_vh-3 · vector vh-3'
            ],
            ['Previous mark 78%', 'previous', 'run run_critic_vh-2 · vector vh-2']
        ]);

        // No date, in either row or anywhere in the score block, and the trail element itself is gone.
        expect(String(container.querySelector('[data-testid="group-score-marks"]')?.textContent)).not.toContain(
            '2026'
        );
        expect(container.querySelector('[data-testid="group-score-history"]')).toBeNull();
        // The Critic's sentence is printed ONCE — the headline line and the list cannot both claim it.
        expect(container.querySelectorAll('[data-testid="group-score-rationale"]')).toHaveLength(1);
    });

    it('says when a rewrite went backwards, says nothing when there is no previous mark, and prints no rationale the Critic never wrote (T3)', () => {
        // Tone is the regression: the group's first own revision replaced text the vh-2 pass rated 64, and the
        // vh-3 pass rated the replacement 58. The pane admits it in words, not in a colour alone.
        const tone = renderGroup('grp-tone').container;

        expect(tone.querySelector('[data-testid="group-score-value"]')?.textContent).toBe('Score 58%');
        expect(tone.querySelector('[data-testid="group-score-delta"]')?.textContent).toBe('(down 6 from 64%)');
        expect(tone.querySelector('.sv-group-score-delta')?.className).toContain('sv-group-score-delta--down');
        expect(
            Array.from(tone.querySelectorAll('li.sv-group-score-mark')).map((row) =>
                String(row.textContent).replace(/\s+/g, ' ').trim()
            )
        ).toEqual([
            'Current clean revision 58% two authorial winks survive in the middle paragraph',
            'Previous mark 64%'
        ]);

        // Theme has ONE pass, so there is nothing to move from — and inventing a zero to subtract would turn
        // "never scored before" into "was scored zero". No delta node, no previous row, no rationale node.
        const theme = renderGroup('grp-theme').container;

        expect(theme.querySelector('[data-testid="group-score-value"]')?.textContent).toBe('Score 71%');
        expect(theme.querySelector('[data-testid="group-score-delta"]')).toBeNull();
        expect(theme.querySelector('[data-testid="group-score-rationale"]')).toBeNull();
        expect(theme.querySelectorAll('li.sv-group-score-mark')).toHaveLength(1);
        expect(theme.querySelector('[data-testid="group-score-mark-previous"]')).toBeNull();

        // Promise has two passes and no rationale on either: the number and the movement, and nothing invented.
        const promise = renderGroup('grp-promise').container;

        expect(promise.querySelector('[data-testid="group-score-value"]')?.textContent).toBe('Score 62%');
        expect(promise.querySelector('[data-testid="group-score-delta"]')?.textContent).toBe('(up 7 from 55%)');
        expect(promise.querySelector('.sv-group-score-delta')?.className).toContain('sv-group-score-delta--up');
        expect(promise.querySelector('[data-testid="group-score-rationale"]')).toBeNull();
        expect(
            Array.from(promise.querySelectorAll('li.sv-group-score-mark')).map((row) =>
                String(row.textContent).replace(/\s+/g, ' ').trim()
            )
        ).toEqual(['Current clean revision 62%', 'Previous mark 55%']);
    });

    it('keeps the comparison at two marks however many passes the Reader has run (T5)', () => {
        // Three passes on one group: the current mark and the mark it moved from are the report, and the third
        // is history. A pane that printed all three turned a comparison into a changelog, which is what this
        // change replaced — and the header average and the rail row read the SAME newest pair.
        const { container } = renderGroup('grp-premise', { view: premiseWithScores(3) });

        expect(container.querySelector('[data-testid="group-score-value"]')?.textContent).toBe('Score 91%');
        expect(container.querySelector('[data-testid="group-score-delta"]')?.textContent).toBe('(up 7 from 84%)');
        expect(
            Array.from(container.querySelectorAll('li.sv-group-score-mark')).map((row) => [
                String(row.textContent).replace(/\s+/g, ' ').trim(),
                row.getAttribute('data-mark')
            ])
        ).toEqual([
            ['Current clean revision 91%', 'current'],
            ['Previous mark 84%', 'previous']
        ]);
    });

    it('shows no score block at all for a group the pass never scored (T3)', () => {
        // Ending has no `scores` key on the wire and no text to score. The pane keeps saying what it always
        // said — `No revision yet`, `not written`, the purpose line — and adds no number, because a `0%` there
        // would be the desk claiming a review the Critic never ran.
        const { container } = renderGroup('grp-ending');

        expect(container.querySelector('[data-testid="group-score"]')).toBeNull();
        expect(container.querySelector('[data-testid="group-score-history"]')).toBeNull();
        expect(String(container.textContent)).not.toContain('Score');
        expect(container.querySelector('[data-testid="group-status"]')?.textContent).toBe('not written');
    });
});

describe('SummaryGroupPane — the clean stamp and the score a clean pass has not earned yet (D-67)', () => {
    it('stamps the revision a cross-group pass closed clean on, naming the run that judged it', () => {
        // `groupedPhraseView`'s single history row IS the clean one (it is the row the default reviewed block
        // selects), so the badge belongs on it — and ONLY on it. The stamp is an audit fact (P11): this exact
        // text closed a Critic pass with no unresolved defect, which is what makes it selectable into the
        // reviewed Summary.
        const { container } = renderGroup('grp-premise', { view: groupedView({}) });

        expect(container.querySelector('[data-testid="group-clean"]')?.textContent).toBe('Clean');
        expect(container.querySelector('[data-testid="group-clean"]')?.getAttribute('title')).toBe(
            'A cross-group Critic pass closed clean on this revision (run run_clean_premise) — it is the revision the reviewed Summary can stand behind.'
        );
        // The stamp is a BADGE, not the state line: `Revision 1 · 48 chars` is the Writer's fact (the row's
        // own number and length), `Clean` is a Reviewer's, and the pane keeps them in separate elements.
        expect(container.querySelector('[data-testid="group-status"]')?.textContent).toBe('Revision 1 · 48 chars');
        expect(container.querySelector('[data-testid="group-status"]')?.textContent ?? '').not.toContain('clean');
        // And a badge, not a button: the Author chooses the reviewed Summary once, whole (D-68), not per stamp.
        expect(container.querySelectorAll('[data-testid="group-clean"] button')).toHaveLength(0);
    });

    it('says nothing about clean when the newest revision never closed a pass, even if an older one did', () => {
        // The stamp describes the ONE row on screen. An archived row may be the clean one (the `ready` fixture
        // is exactly that: Ending reviewed at r2, newest r3), and then the pane the Author is standing on must
        // not claim the newest text was read.
        const { container } = renderGroup('grp-ending', { view: reviewedReadyView() });

        expect(container.querySelector('[data-testid="group-clean"]')).toBeNull();
        // r3 is the newest text and nobody has passed it; the char count is the row's, not a verdict.
        expect(container.querySelector('[data-testid="group-status"]')?.textContent).toBe(
            'Revision 3 · 76 chars'
        );
    });

    it('names the wait when a written group has no score, instead of printing 0% or nothing at all', () => {
        // D-67 moved the scoring join onto the CLEAN vector, so an empty `scores` list on a written section is
        // the normal mid-review shape. `0%` would claim a pass that never ran; silence would read as a broken
        // wire; the line names the wait. (An UNWRITTEN group stays silent — that test is above.)
        const { container } = renderGroup('grp-tone', { view: groupedView({ groups: unscoredToneRows() }) });

        expect(container.querySelector('[data-testid="group-score"]')).toBeNull();
        expect(String(container.textContent)).not.toContain('Score 0%');
        expect(
            container.querySelector('[data-testid="group-score-none"]')?.textContent?.replace(/\s+/g, ' ').trim()
        ).toBe(
            'No Reader score for this section yet — the pass reads a section once the crew has a clean revision of it to stand behind.'
        );
        // The line is about the SCORE only: the group's own state line keeps saying what the Writer did.
        expect(container.querySelector('[data-testid="group-status"]')?.textContent).toBe('Revision 1 · 48 chars');
        expect(container.querySelector('[data-testid="group-clean"]')?.textContent).toBe('Clean');
    });
});
