// U-4 / U-16 / L-30 — the Summary pane.
//
// Phase ① is a flat Revision 1…N history. The pane shows the Summary on record, the review counts, and the
// ONE revision the record names (R1) — an older round's `selected` row, the drafts still in flight and the
// history a round parked are all kept out of that list, while the rail stays the record of every version
// tried; opening one revision (parked ones included) shows that version and its findings.
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { SummaryPane } from './SummaryPane';
import { click } from '../testing/shell-fakes';
import { fixtureRevisions, fixtureStory, fixtureSummary } from './story-fixtures';
import type { SummaryRevisionEntry } from './story-nav';

const DELETION_SENTENCE =
    'Backtrack to ① Summary deletes 4 chapters with their 4 revisions, 2 plotlines, and the derived Digest. ' +
    'Verdicts and findings survive as provenance; the Ideas do not — the lock already deleted them (D-25, D-36, L-31). ' +
    'Story "Neon Cathedral" starts again from its Seed.';

/**
 * The Summary round's dial hint, verbatim (T5 / R3, §6.5 + §16.6, D-47). It is pinned as ONE exact
 * string, not a fragment, because the sentence is the claim under test: phase ① settles a round by the
 * engine's deterministic selection, so the pane may not tell the Author an Editor keeps a draft.
 * `SummaryPane.tsx`'s `DEFAULT_SUMMARY_SAMPLING` renders the 3.
 */
const ROUND_DIALS_HINT =
    'Phase ① writes 3 complete Summaries per round. The Critics critique each draft, and the round settles ' +
    'by itself: the engine keeps the draft with the fewest findings — fewest critical, then fewest high, ' +
    'then fewest total, then the earliest sample (§6.5, §16.6) — and parks the rest as discarded history. ' +
    'No Editor picks a column in phase ①. Both counts are yours.';

const REVISION = fixtureRevisions().find((revision) => revision.unit_kind === 'summary')!;

/**
 * The scope map `story-nav.summaryRevisions` normally computes (T11/F6). A hand-built entry carries it
 * explicitly so the pane's copy is pinned per row rather than inferred by the test.
 */
const ENTRY: SummaryRevisionEntry = {
    revision: { ...REVISION, state: 'competing' },
    index: 3,
    findings: [
        {
            id: 'finding_draft',
            rev: 1,
            created_at: '2026-11-11T11:00:00.000Z',
            updated_at: '2026-11-11T11:00:00.000Z',
            story_id: 's1',
            target_ref: 'sum1',
            criterion_ref: 'C-14',
            title: 'The draft loses the stray',
            evidence: 'premise names a keeper',
            cost: 'major',
            fingerprint: 'fp-draft',
            state: 'confirmed',
            seen_count: 1
        }
    ],
    // This row names no draft, so it is a statement about the Summary as a whole — the shape whose copy
    // must not read "on this revision" (T11/F6).
    findingScopes: { finding_draft: 'artifact' },
    editorVerdicts: []
};

/** A second row for the same focus pane: this one DOES name the draft it was filed against. */
const DRAFT_SCOPED_FINDING = {
    id: 'finding_scoped',
    rev: 1,
    created_at: '2026-11-11T11:01:00.000Z',
    updated_at: '2026-11-11T11:01:00.000Z',
    story_id: 's1',
    target_ref: 'sum1',
    criterion_ref: 'C-11',
    title: 'The ending repeats the premise',
    evidence: '¶4 — the same sentence twice',
    cost: 'minor' as const,
    fingerprint: 'fp-scoped',
    state: 'confirmed' as const,
    seen_count: 1,
    related_refs: [REVISION.id]
};

// ---------------------------------------------------------------------------
// R5 then R1 — the overview lists ONE revision: the row the record names.
//
// R5 reported the parked draft under the one on record ("as though a parked draft were still a contender").
// R1 reported the rest of the same list: the screenshot read "Revisions · 9" with `selected` Revision 1 AND
// `selected` Revision 4 side by side, because the state filter admitted every settled row plus the live
// drafts. These are the shapes both cases need: the draft on record, an older round's settled row, a parked
// draft that carries its reason, the other parked spelling (`merged_into`, §4.17), and the round in flight.
// Each is hand-built from `ENTRY` so the pane's copy and the card's `data-state` are pinned per row.
// ---------------------------------------------------------------------------

/** The draft on record — the card R5 must keep visible (the screenshot's Revision 1). */
const SELECTED: SummaryRevisionEntry = {
    ...ENTRY,
    revision: { ...REVISION, id: 'rv-sum-keep', state: 'selected' },
    index: 1
};

/** The draft the round parked, WITH its recorded reason — the card R5 must hide from the overview. */
const PARKED: SummaryRevisionEntry = {
    ...ENTRY,
    revision: { ...REVISION, id: 'rv-sum-parked', state: 'discarded' },
    index: 2,
    discardReason: 'the kept draft names its price in the first paragraph'
};

/** The other history state: a draft folded into another one, equally not current. */
const MERGED: SummaryRevisionEntry = {
    ...ENTRY,
    revision: { ...REVISION, id: 'rv-sum-merged', state: 'merged_into' },
    index: 3
};

/**
 * An OLDER round's winner. A settled round leaves its `selected` row on the record, so a Story that has been
 * through several rounds carries one `selected` row PER ROUND (story-contract.ts:522-530) — that is the pair
 * the reported screenshot showed ("Revisions · 9", Revision 1 AND Revision 4 both selected). R1 hides every
 * one of them except the newest.
 */
const SELECTED_EARLIER: SummaryRevisionEntry = {
    ...ENTRY,
    revision: { ...REVISION, id: 'rv-sum-round-1', state: 'selected' },
    index: 1
};

/** The round still in flight: `drafted`/`competing`/`pending` are live work, and R1 keeps them out of the
 *  ordinary list too — the pane's one card is the ACCEPTED revision, not the work in progress. Indexes start
 *  at 4 so these rows sit after SELECTED_EARLIER/PARKED/SELECTED in the rail's order. */
const LIVE: SummaryRevisionEntry[] = (['drafted', 'competing', 'pending'] as const).map(
    (state, offset) =>
        ({
            ...ENTRY,
            revision: { ...REVISION, id: `rv-sum-${state}`, state },
            index: offset + 4
        }) satisfies SummaryRevisionEntry
);

/**
 * `ENTRY` is the CANDIDATE the T4 cases open from the rail: its state is `competing`, §4.15's legacy spelling
 * of a reviewable draft, so it is the shape `story-nav.summaryRevisionUnit` offers to the Author. R1 keeps its
 * CARD out of the overview, which is why the recommendation mark and the override are pinned on the FOCUSED
 * view — pinning them on an overview card would pin UI the real wiring can no longer reach.
 */

describe('SummaryPane — locked law, and the one way in (U-4, U-16, L-30, L-32)', () => {
    it('marks the locked Summary read-only for every agent and names Backtrack as the only move', async () => {
        render(
            <SummaryPane
                story={fixtureStory()}
                summary={fixtureSummary()}
                onBacktrack={() => undefined}
                backtrackNote={DELETION_SENTENCE}
            />
        );

        expect(screen.getByText('locked — read-only for every agent (P5, L-30)')).toBeTruthy();
        expect(screen.getByText(/the only move is a Backtrack/)).toBeTruthy();

        const pane = screen.getByRole('region', { name: 'Summary' });
        const confirm = within(pane);
        expect(pane.querySelectorAll('textarea').length).toBe(0);

        await click(confirm.getByRole('button', { name: 'Backtrack' }));
        expect(screen.getByText(DELETION_SENTENCE)).toBeTruthy();
        await click(screen.getByRole('button', { name: 'Cancel' }));
        await click(confirm.getByRole('button', { name: 'Backtrack' }));
        await click(screen.getByRole('button', { name: 'Confirm' }));
    });

    it('prints every §4.2 field read-only, and calls a missing field what it is', () => {
        const summary = { ...fixtureSummary(), ending: undefined };
        render(<SummaryPane story={{ ...fixtureStory(), summary_locked: false }} summary={summary} />);

        expect(screen.getByText('A flooded city keeps its memory in a sealed cathedral of data.')).toBeTruthy();
        expect(screen.getByText('Close third, present tense, spare and technical; no irony.')).toBeTruthy();
        expect(screen.getByText('Tone (voice · POV · tense · register)')).toBeTruthy();
        expect(screen.getAllByText('not written yet').length).toBe(1);
        expect(screen.getByText('7')).toBeTruthy();
        expect(screen.getByText('Author-declared · read-only for every agent (D-3b)')).toBeTruthy();
    });

    it('does not put a chapter count on the phase-① Summary', () => {
        render(
            <SummaryPane
                story={{ ...fixtureStory(), phase: 'summary', summary_locked: false }}
                summary={{ ...fixtureSummary(), chapter_count: 3, locked: false }}
            />
        );

        expect(screen.queryByText('Chapter count')).toBeNull();
        expect(screen.queryByText('Author-declared · read-only for every agent (D-3b)')).toBeNull();
    });

    it('carries the phase-① round and critic counts, saved as one Author write', async () => {
        const calls: Array<[number, number]> = [];

        render(
            <SummaryPane
                story={{ ...fixtureStory(), summary_locked: false }}
                summary={{ ...fixtureSummary(), locked: false }}
                sampling={3}
                critics={5}
                onSetSummaryReview={(sampling, critics) => calls.push([sampling, critics])}
            />
        );

        expect(screen.getByText(ROUND_DIALS_HINT)).toBeTruthy();
        // R3 / §16.6 (D-47): phase ① has no Editor draft choice, so the pane may not describe one.
        expect(screen.queryByText(/the Editor keeps one/)).toBeNull();
        fireEvent.change(screen.getByLabelText('Writers per Summary round'), { target: { value: '6' } });
        fireEvent.change(screen.getByLabelText('Critics per revision'), { target: { value: '7' } });
        await click(screen.getByRole('button', { name: 'Set review counts' }));

        expect(calls).toEqual([[6, 7]]);
    });

    it('hides the counts once the Summary is locked, exactly like every other Author write (P5, L-30)', () => {
        render(<SummaryPane story={fixtureStory()} summary={fixtureSummary()} />);

        expect(screen.queryByRole('button', { name: 'Set review counts' })).toBeNull();
        expect(screen.queryByLabelText('Writers per Summary round')).toBeNull();
    });

    it('has no per-field assistant control — the directive bar is the Author’s channel', () => {
        render(
            <SummaryPane
                story={{ ...fixtureStory(), summary_locked: false }}
                summary={{ ...fixtureSummary(), locked: false }}
            />
        );

        expect(screen.queryByRole('button', { name: 'Ask assistant' })).toBeNull();
        expect(screen.getByText(/Use the directive bar below/)).toBeTruthy();
    });

    it('prints the revision on record and never offers it back to the Author (U-13, D-24, R1)', () => {
        const calls: Array<[string, string]> = [];

        render(
            <SummaryPane
                story={{ ...fixtureStory(), phase: 'summary', summary_locked: false }}
                summary={{ ...fixtureSummary(), locked: false }}
                revisions={[SELECTED, ENTRY]}
                // `ENTRY` is a live `competing` draft: R1 keeps it out of the list, so the only card is the
                // accepted row and the Author's override route never fires from this pane.
                onRecordRevisionId={SELECTED.revision.id}
                onSelectRevision={(unitRef, revisionId) => calls.push([unitRef, revisionId])}
            />
        );

        expect(screen.getByText('Revision 1')).toBeTruthy();
        // The field appears once on the Summary on record and once on the revision card — exactly twice also
        // proves the competing draft printed no card, since its body carries the same sentence.
        expect(screen.getAllByText('A flooded city keeps its memory in a sealed cathedral of data.').length).toBe(2);
        expect(screen.queryByRole('button', { name: 'Use Revision' })).toBeNull();

        const button = document.querySelector<HTMLButtonElement>('.sv-summary-draft-select')!;

        expect(button.textContent).toBe('Selected');
        expect(button.disabled).toBe(true);
        expect(button.getAttribute('title')).toBe('This revision is selected.');
        expect(calls).toEqual([]);
    });

    it('opens one revision with only its findings', () => {
        render(
            <SummaryPane
                story={{ ...fixtureStory(), phase: 'summary', summary_locked: false }}
                summary={fixtureSummary()}
                focus={ENTRY}
            />
        );

        expect(screen.getByText('Summary — Revision 3')).toBeTruthy();
        expect(screen.getByText('The draft loses the stray')).toBeTruthy();
        expect(screen.queryByText('Summary — Phrase 1')).toBeNull();
        expect(screen.queryByText('The Summary on record')).toBeNull();
        expect(screen.queryByText(/Revisions ·/)).toBeNull();

        // The cost and the state are one unit on one line: "major confirmed", not a state
        // floated to the far edge of the row, and the state names its own colour (D-33/D-34).
        const row = screen.getByText('The draft loses the stray').closest('.find-row')!;
        const tags = row.querySelector('.find-tags')!;
        const state = row.querySelector('.find-state')!;
        expect(tags.textContent).toBe('majorconfirmed');
        expect(tags.contains(state)).toBe(true);
        expect(state.className).toContain('find-state--confirmed');

        // T3 — the claim type leads the head, and it is a SIBLING of that cost+state unit, never a third word
        // inside it: "major confirmed" is one fact about the row and adding a third token would read as a state
        // the engine never recorded. This fixture row carries no `kind` at all — a finding raised before the
        // field existed — so the chip says `Issue`, which is both the legacy reading and the server's default.
        const head = row.querySelector('.find-head')!;

        expect(head.firstElementChild?.textContent).toBe('Issue');
        expect(head.firstElementChild?.className).toBe('sv-finding-kind sv-finding-kind--issue');
        expect(tags.contains(head.firstElementChild as HTMLElement)).toBe(false);
    });

    // T3 — the branch the row above cannot reach: a finding the Critic MARKS as a Proposal. Both kinds sit on
    // one Revision here, because the point is the pair — a row that says the text breaks a promise and a row
    // that only asks for a better word have to read apart on the same screen, at the same cost tier.
    it('names a Proposal row as a Proposal, and leaves the cost+state unit untouched (T3)', () => {
        const finding = ENTRY.findings[0]!;
        const both: SummaryRevisionEntry = {
            ...ENTRY,
            findings: [
                finding,
                {
                    ...finding,
                    id: 'finding_draft_proposal',
                    title: 'The draft restates the premise in other words',
                    // §4.10 — `major` is a cost a Proposal may carry, so the two rows share a cost tier and
                    // only the kind separates them.
                    cost: 'major',
                    kind: 'proposal'
                }
            ],
            findingScopes: {
                finding_draft: 'artifact',
                finding_draft_proposal: 'artifact'
            }
        };

        render(
            <SummaryPane
                story={{ ...fixtureStory(), phase: 'summary', summary_locked: false }}
                summary={fixtureSummary()}
                focus={both}
            />
        );

        const rows = Array.from(document.querySelectorAll<HTMLElement>('.find-row'));

        expect(
            rows.map((row) => [
                row.querySelector('.find-title')?.textContent,
                row.querySelector('.sv-finding-kind')?.textContent,
                row.querySelector('.sv-finding-kind')?.className,
                // The chip leads the head — it is the first thing the row says.
                row.querySelector('.find-head')?.firstElementChild?.textContent,
                // …and it is NOT part of the cost+state unit, which stays the two words it always was.
                row.querySelector('.find-tags')?.textContent,
                // The testid is the row's own handle, so the two rows cannot be confused by a re-sort.
                row.querySelector('[data-testid^="finding-"]')?.getAttribute('data-testid')
            ])
        ).toEqual([
            [
                'The draft loses the stray',
                'Issue',
                'sv-finding-kind sv-finding-kind--issue',
                'Issue',
                'majorconfirmed',
                'finding-finding_draft-kind'
            ],
            [
                'The draft restates the premise in other words',
                'Proposal',
                'sv-finding-kind sv-finding-kind--proposal',
                'Proposal',
                'majorconfirmed',
                'finding-finding_draft_proposal-kind'
            ]
        ]);
    });

    // -----------------------------------------------------------------------
    // T11/F6 — the scope sentence the gate already decided, printed once per row.
    //
    // A whole-artifact finding is every revision's business, so the rail lists it on all of them; the old
    // copy then claimed each card owned it ("on this revision"), which reads as six separate defects. The
    // row naming a draft keeps that wording; the row naming none says what it is about.
    // -----------------------------------------------------------------------
    it('says what each finding is about — the Summary as a whole, or this revision (T11/F6)', () => {
        render(
            <SummaryPane
                story={{ ...fixtureStory(), phase: 'summary', summary_locked: false }}
                summary={fixtureSummary()}
                focus={{
                    ...ENTRY,
                    findings: [ENTRY.findings[0], DRAFT_SCOPED_FINDING],
                    findingScopes: { finding_draft: 'artifact', finding_scoped: 'selected' }
                }}
            />
        );

        expect(
            Array.from(document.querySelectorAll('.find-meta')).map((line) => line.textContent)
        ).toEqual([
            'C-14 · about the Summary as a whole (finding_draft)',
            'C-11 · on this revision (finding_scoped)'
        ]);
    });

    // -----------------------------------------------------------------------
    // T11/F5 — phase ① has no Editor draft choice (D-47, §16.6), so the advisory on a revision may not name
    // one. Later phases do have an Editor applying `selection_rules` (§16.8), and the `StoryView` suite pins
    // that copy at phase ③. T4 moved WHERE the mark can appear: `recommendedRevisionId` names a CANDIDATE,
    // and R1 keeps candidates out of the overview, so the rail-opened revision is the seam the real wiring
    // can reach — pinning the copy on an overview card would pin unreachable UI.
    // -----------------------------------------------------------------------
    it('phase ① marks the advisory as the review\u2019s reading, never an Editor\u2019s pick (T11/F5, T4)', () => {
        render(
            <SummaryPane
                story={{ ...fixtureStory(), phase: 'summary', summary_locked: false }}
                summary={{ ...fixtureSummary(), locked: false }}
                focus={ENTRY}
                focusSelectable
                recommendedRevisionId={REVISION.id}
                onSelectRevision={() => undefined}
            />
        );

        const pane = screen.getByRole('region', { name: 'Summary — Revision 3' });

        expect(pane.querySelector('.sv-summary-draft-pick')?.textContent).toBe('Review recommends');
        // The old sentence, asserted absent: phase ① settles by the engine's counts, and nothing here is
        // an Editor recommending a column.
        expect(screen.queryByText('Editor recommends')).toBeNull();
        expect(document.body.textContent).not.toContain('Editor recommends');
    });

    it('a later phase keeps the Editor\u2019s recommendation on the focused revision (§16.8, T4)', () => {
        render(
            <SummaryPane
                story={fixtureStory()}
                summary={fixtureSummary()}
                focus={ENTRY}
                focusSelectable
                recommendedRevisionId={REVISION.id}
                onSelectRevision={() => undefined}
            />
        );

        expect(document.querySelector('.sv-summary-draft-pick')?.textContent).toBe('Editor recommends');
    });

    it('marks the recommendation on the draft it advanced, and on no other focused revision (T4)', () => {
        const story = { ...fixtureStory(), phase: 'summary' as const, summary_locked: false };
        const summary = { ...fixtureSummary(), locked: false };

        // A parked row, while the advisory still names the live candidate: a row nobody advanced wears nothing.
        const { rerender } = render(
            <SummaryPane story={story} summary={summary} focus={PARKED} recommendedRevisionId={REVISION.id} />
        );

        expect(document.querySelector('.sv-summary-draft-pick')).toBeNull();

        // Neither does the row on record, whose own verdicts long settled.
        rerender(<SummaryPane story={story} summary={summary} focus={SELECTED} recommendedRevisionId={REVISION.id} />);
        expect(document.querySelector('.sv-summary-draft-pick')).toBeNull();

        // Only the draft the verdict advanced, and only while the rail has it open.
        rerender(
            <SummaryPane
                story={story}
                summary={summary}
                focus={ENTRY}
                focusSelectable
                recommendedRevisionId={REVISION.id}
                onSelectRevision={() => undefined}
            />
        );

        expect(document.querySelector('.sv-summary-draft-pick')?.textContent).toBe('Review recommends');
    });

    // -----------------------------------------------------------------------
    // T4 — the Author's override (U-13, D-24) on the revision the rail opens.
    //
    // R1 removed the candidate CARDS from the overview, which is what the Author asked for, but the same cut
    // removed the only Summary control that wrote `POST /stories/:id/revisions/:revisionId/select`. The
    // rail-opened revision is the surface that can print a candidate, so the action lives there, with the
    // row's own state (§4.15) and the contract's candidate list (`story-nav.summaryRevisionUnit`, which drops
    // a draft an older round already lost) still deciding whether it is enabled — no row gains a write the
    // API would refuse.
    // -----------------------------------------------------------------------
    it('lets the Author take the reviewable revision the rail opens, same callback and id (T4, U-13, D-24)', async () => {
        const calls: Array<[string, string]> = [];

        render(
            <SummaryPane
                story={{ ...fixtureStory(), phase: 'summary', summary_locked: false }}
                summary={{ ...fixtureSummary(), locked: false }}
                focus={ENTRY}
                focusSelectable
                onSelectRevision={(unitRef, revisionId) => calls.push([unitRef, revisionId])}
            />
        );

        const pane = screen.getByRole('region', { name: 'Summary — Revision 3' });
        const button = pane.querySelector<HTMLButtonElement>('.sv-summary-draft-select')!;

        expect(button.textContent).toBe('Use Revision');
        expect(button.disabled).toBe(false);
        expect(button.getAttribute('title')).toBe(
            'Make this revision the Summary. The other drafts stay as discarded history.'
        );
        // The focused row keeps everything it printed before (R1 hid the card, never the record), and an
        // un-recommended row wears no mark.
        expect(pane.querySelectorAll('.sv-summary-draft-field')).toHaveLength(6);
        expect(pane.querySelector('.sv-summary-draft-pick')).toBeNull();

        await click(button);

        // The signature is the one this callback has always had: the Summary's id, then the revision's.
        expect(calls).toEqual([['sum1', REVISION.id]]);
    });

    it('keeps the override off every focused row that is not a candidate (T4)', () => {
        const story = { ...fixtureStory(), phase: 'summary' as const, summary_locked: false };
        const summary = { ...fixtureSummary(), locked: false };

        const button = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>('.sv-summary-draft-select')!;

        // The row on record: the pane does not ask the Author to take the decision the round already made.
        const { rerender } = render(
            <SummaryPane story={story} summary={summary} focus={SELECTED} onSelectRevision={() => undefined} />
        );

        expect([button().textContent, button().disabled]).toEqual(['Selected', true]);

        // A `pending` block, EVEN when a caller offers it: §4.15 refuses a draft whose Writer has not closed.
        rerender(
            <SummaryPane story={story} summary={summary} focus={LIVE[2]!} focusSelectable onSelectRevision={() => undefined} />
        );

        expect([button().textContent, button().disabled]).toEqual(['Pending', true]);

        // A parked draft: opened for its detail and its reason, never for a write — so it prints no control
        // at all, only the state named as plain text where the button would sit.
        rerender(
            <SummaryPane story={story} summary={summary} focus={PARKED} focusSelectable onSelectRevision={() => undefined} />
        );

        expect(document.querySelector('.sv-summary-draft-select')).toBeNull();
        expect(document.querySelector('.sv-summary-draft-parked')?.textContent).toBe('Discarded');

        // The other parked spelling (`merged_into`, §4.17) reads exactly the same.
        rerender(
            <SummaryPane story={story} summary={summary} focus={MERGED} focusSelectable onSelectRevision={() => undefined} />
        );

        expect(document.querySelector('.sv-summary-draft-select')).toBeNull();
        expect(document.querySelector('.sv-summary-draft-parked')?.textContent).toBe('Discarded');

        // A shell without the route keeps the control honest: labelled what it would do, and disabled.
        rerender(<SummaryPane story={story} summary={summary} focus={ENTRY} focusSelectable />);

        expect([button().textContent, button().disabled]).toEqual(['Use Revision', true]);
    });

    // -----------------------------------------------------------------------
    // T4/R1 — a discarded revision says WHY it was discarded, in neutral wording.
    //
    // `Revision.discard_reason` reaches the dashboard on the revision record and is OPTIONAL: a row from
    // before the field landed has none. Both halves matter — the reason must be readable where the Author
    // lands, and the pane may not fabricate one. The wording is neutral because phase ① settles a round by
    // the engine's deterministic counts (§16.6, D-47): no Editor parked this draft, so the pane may not
    // say one did.
    //
    // R5 moved the CARD half of this: the overview no longer lists parked drafts at all, so the reason is
    // read on the revision the rail has open. The focus cases below are therefore the contract, and the R5
    // cases underneath pin that hiding the card did not hide the record.
    // -----------------------------------------------------------------------
    it('names the discard reason on the opened revision, in wording that blames no Editor (T4/R1)', () => {
        render(
            <SummaryPane
                story={{ ...fixtureStory(), phase: 'summary', summary_locked: false }}
                summary={fixtureSummary()}
                focus={{
                    ...ENTRY,
                    revision: { ...REVISION, state: 'discarded' },
                    discardReason: 'the other draft named its price in the first paragraph'
                }}
            />
        );

        expect(
            screen.getByText('Discard reason: the other draft named its price in the first paragraph')
        ).toBeTruthy();
        // The forbidden phrasings: phase ① has no Editor draft pick (D-47), and the discard reason is not
        // the winner's `selection_note` re-labelled.
        expect(document.body.textContent).not.toContain('Editor’s discard reason');
        expect(document.body.textContent).not.toContain('Editor’s note on this revision');
    });

    it('prints nothing when a legacy discard has no recorded reason (T4/R1)', () => {
        render(
            <SummaryPane
                story={{ ...fixtureStory(), phase: 'summary', summary_locked: false }}
                summary={fixtureSummary()}
                // A row from before `discard_reason` landed: the pane prints the state and stops there —
                // no empty label, and no invented sentence.
                focus={{ ...ENTRY, revision: { ...REVISION, state: 'discarded' } }}
            />
        );

        expect(screen.getByText('Summary — Revision 3')).toBeTruthy();
        expect(document.querySelectorAll('.sv-summary-draft-note')).toHaveLength(0);
        expect(document.body.textContent).not.toContain('Discard reason');
        // A reason the server never wrote is not the dashboard's to make up: an absent field must not reach
        // the pane as the word "undefined".
        expect(document.body.textContent).not.toContain('undefined');
    });

    // -----------------------------------------------------------------------
    // R5 then R1 — "selecting Summary displays only the latest accepted revision".
    //
    // The overview is the pane's answer to "what IS the Summary now", and that is ONE row, not a list: R1
    // names the accepted revision (`onRecordRevisionId`, i.e. `story-contract.selectedSummaryRevision`), so
    // an older round's `selected` row, the drafts still in flight and the parked history all stay out. What
    // R5 already kept out (parked drafts) stays out; what R5 also kept IN — `drafted`/`competing`/`pending`
    // as "current work" — is what R1 supersedes, on the Author's explicit "only". Every one of those rows is
    // still in the rail (that is where `story-nav.summaryRevisions` still lists it), and the rail's row still
    // opens it, fields and reason included. The card list and the count are one set, and a round with nothing
    // accepted says so truthfully instead of showing its drafts as a fallback.
    // -----------------------------------------------------------------------
    it('shows the revision on record and none of the history beside it (R5)', () => {
        render(
            <SummaryPane
                story={{ ...fixtureStory(), phase: 'summary', summary_locked: false }}
                summary={{ ...fixtureSummary(), locked: false }}
                revisions={[SELECTED, PARKED]}
                onRecordRevisionId={SELECTED.revision.id}
                onSelectRevision={() => undefined}
            />
        );

        const drafts = Array.from(document.querySelectorAll<HTMLElement>('.sv-summary-draft'));

        // One card, asserted as the whole pair (state, label) rather than a count, so neither a leaked parked
        // row nor a reshuffled list can pass.
        expect(
            drafts.map((card) => [card.dataset.state, card.querySelector('.sv-summary-draft-label')?.textContent])
        ).toEqual([['selected', 'Revision 1']]);
        // The heading counts CARDS, not history: the rail beside it still reads Revision 1…2.
        expect(screen.getByText('Revisions · 1')).toBeTruthy();
        // Nothing of the parked draft reaches the overview — not its row, not its reason.
        expect(document.body.textContent).not.toContain('Revision 2');
        expect(document.body.textContent).not.toContain('Discard reason');
        // The card that IS shown behaves as it always did: the draft on record is not offered back.
        expect(drafts[0]!.querySelector('.sv-summary-draft-select')?.textContent).toBe('Selected');
    });

    it('shows one card when several rounds left several `selected` rows — the accepted one (R1)', () => {
        // The reported screenshot, shape for shape: nine rows on the record, `selected` Revision 1 (an older
        // round's winner) and `selected` Revision 4 (this round's), plus the parked loser and a round still
        // being written. `selectedSummaryRevision` answers the NEWEST `selected` row (story-contract.ts:522-545)
        // and `StoryView` passes its id, so Revision 4 is the only card.
        const accepted: SummaryRevisionEntry = { ...SELECTED, index: 4 };

        render(
            <SummaryPane
                story={{ ...fixtureStory(), phase: 'summary', summary_locked: false }}
                summary={{ ...fixtureSummary(), locked: false }}
                revisions={[SELECTED_EARLIER, PARKED, MERGED, accepted, ...LIVE]}
                onRecordRevisionId={accepted.revision.id}
                recommendedRevisionId={LIVE[1]!.revision.id}
                onSelectRevision={() => undefined}
            />
        );

        const drafts = Array.from(document.querySelectorAll<HTMLElement>('.sv-summary-draft'));

        // Exactly one card, asserted as (state, label) — the older accepted row did not join it, and the live
        // drafts did not either.
        expect(
            drafts.map((card) => [card.dataset.state, card.querySelector('.sv-summary-draft-label')?.textContent])
        ).toEqual([['selected', 'Revision 4']]);
        expect(screen.getByText('Revisions · 1')).toBeTruthy();
        // Nothing else the record holds reaches the overview: no offer for a live draft, no parked row, and no
        // recommendation mark — the recommended draft is a candidate, and a candidate has no card here.
        expect(document.body.textContent).not.toContain('Use Revision');
        expect(document.body.textContent).not.toContain('Pending');
        expect(document.body.textContent).not.toContain('Discard reason');
        expect(document.querySelector('.sv-summary-draft-pick')).toBeNull();
        expect(document.body.textContent).not.toContain('Review recommends');
        // The accepted row says what it is; the Author's override is not this list's decision to re-take.
        expect(drafts[0]!.querySelector('.sv-summary-draft-select')?.textContent).toBe('Selected');
    });

    it('gives the empty state, never the live drafts, when nothing is accepted (R1)', () => {
        render(
            <SummaryPane
                story={{ ...fixtureStory(), phase: 'summary', summary_locked: false }}
                summary={{ ...fixtureSummary(), locked: false }}
                // `onRecordRevisionId` absent is `selectedSummaryRevision` answering `undefined`: the round is
                // still in flight. R1's "only" rules out printing those drafts instead.
                revisions={[...LIVE, PARKED]}
                onSelectRevision={() => undefined}
            />
        );

        expect(document.querySelectorAll('.sv-summary-draft')).toHaveLength(0);
        expect(document.querySelector('.sv-summary-drafts')).toBeNull();
        expect(screen.getByText('Revisions · 0')).toBeTruthy();
        expect(screen.getByText('No current Summary revision.')).toBeTruthy();
        expect(document.body.textContent).not.toContain('Use Revision');
        expect(document.body.textContent).not.toContain('Pending');
    });

    it('says there is no CURRENT revision when the whole history is parked, never that nothing landed (R5)', () => {
        const { unmount } = render(
            <SummaryPane
                story={{ ...fixtureStory(), phase: 'summary', summary_locked: false }}
                summary={{ ...fixtureSummary(), locked: false }}
                revisions={[PARKED, MERGED]}
                onSelectRevision={() => undefined}
            />
        );

        // No invalid card is shown as a fallback: that fallback is the R5 complaint, not an empty state.
        expect(document.querySelectorAll('.sv-summary-draft')).toHaveLength(0);
        expect(document.querySelector('.sv-summary-drafts')).toBeNull();
        expect(screen.getByText('Revisions · 0')).toBeTruthy();
        // The honest sentence. The old copy promised nothing had landed, which is false over a parked round.
        expect(screen.getByText('No current Summary revision.')).toBeTruthy();
        expect(screen.queryByText('No Summary revision has landed yet.')).toBeNull();
        unmount();

        // With no revision record at all, the pane keeps the sentence that IS true.
        render(
            <SummaryPane
                story={{ ...fixtureStory(), phase: 'summary', summary_locked: false }}
                summary={{ ...fixtureSummary(), locked: false }}
            />
        );

        expect(screen.getByText('No Summary revision has landed yet.')).toBeTruthy();
        expect(screen.queryByText('No current Summary revision.')).toBeNull();
    });

    it('still opens a parked revision from the rail, with its fields and its recorded reason (R5, T4/R1)', () => {
        render(
            <SummaryPane
                story={{ ...fixtureStory(), phase: 'summary', summary_locked: false }}
                summary={fixtureSummary()}
                focus={PARKED}
            />
        );

        // The FOCUS path is not filtered: R5 hides parked history from the card list, and the rail is still
        // the Author's record of every version tried, so the opened draft keeps every §4.2 field, its state,
        // its findings and the reason it was parked.
        const pane = screen.getByRole('region', { name: 'Summary — Revision 2' });

        expect(pane.querySelector('.sv-pane-badge')?.textContent).toBe('discarded · 1 finding');
        expect(pane.querySelectorAll('.sv-summary-draft-field')).toHaveLength(6);
        expect(screen.getByText('Discard reason: the kept draft names its price in the first paragraph')).toBeTruthy();
        expect(screen.getByText('The draft loses the stray')).toBeTruthy();
    });
});
