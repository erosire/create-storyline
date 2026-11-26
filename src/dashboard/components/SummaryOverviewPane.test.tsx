// R6 / U2 + U3 — the grouped Summary's OVERVIEW pane.
//
// What is pinned here is the surface the rail's Summary header opens on a group-managed book:
//   U2 — the compiled Overview, plus one honest row per group carrying that group's state and findings.
//   U3 — what the sampling instrument panel used to hold is GONE: no dials, no candidate cards, no
//        pick/merge/serve verbs, no critic-seat count, no `Request another revision round`.
//   R1 — the five rows come from `shared/phrase`'s own catalog, so `World rules` (a Summary SECTION,
//        never a group) can never appear as a sixth row.
//   U4 — the empty Overview states why it is empty and what would fill it.
//   U6 — the phrase read is a separate route, so "not loaded yet" is its own line, never five rows.
//
// Every expected string below is derived from the fixture the test builds, not from a screenshot of the
// pane: `fixturePhrase()` documents the state it models (Premise written twice, Promise under review,
// Theme held by the Writer, Tone the target of the unscoped finding, Ending unwritten), and each
// assertion says exactly what that state has to read as.
//
// D-67/D-68 — THE SUMMARY THIS PANE PRINTS IS THE REVIEWED ONE. The mid-review fixture's reviewed block is
// `pending` (Ending unwritten, and every group named by an open issue), so that book now renders the waiting
// state rather than a Summary, and the reviewed states are pinned against `reviewedPhraseView` — fixtures
// whose live text and reviewed text DIFFER by a whole Ending sentence, because "the live text appears nowhere
// on this tab" is only a test when the two texts are different texts.
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import { SummaryOverviewPane } from './SummaryOverviewPane';
import { fixturePhrase, fixtureView } from './story-fixtures';
import { summaryGroupRef } from './story-nav';
// T14/AC2 — the pane prints `reviewedSummaryText(view)`; this test calls the SAME selector to prove the
// decoration is applied at render and never written into the text the selector answers.
import { reviewedSummaryText } from './story-contract';
import {
    click,
    fakeApi,
    fakeHarness,
    groupedPhraseView,
    reviewedBlock,
    reviewedGroup,
    reviewedPhraseView,
    storyRow
} from '../testing/shell-fakes';
import { createDashboardStore } from '../state';
import { composePhraseContent, orderedPhraseGroupDefinitions } from '../../shared/phrase';
import type { PhraseFindingRow, PhraseGroupScore, PhraseView } from '../api';

/** The mid-review grouped book: the fixture phrase, wired into the view the panes read. */
function midReviewView() {
    return fixtureView({ phrase: fixturePhrase() });
}

/** A grouped view whose phrase read has NOT landed: the Story row says `groups`, the rows are absent. */
function pendingView() {
    const view = midReviewView();

    return { ...view, phrase: undefined };
}

/**
 * A grouped view built row-by-row, for the states `fixturePhrase()` deliberately does not model
 * (a clean book, a note that costs nothing, an unwritten everything). Only the fields the pane reads
 * are overridden; the catalog's own titles, descriptions and order come from `groupedPhraseView`.
 */
function groupedView(phrase: Partial<PhraseView>): ReturnType<typeof fixtureView> {
    return fixtureView({ phrase: groupedPhraseView('s1', phrase) });
}

/** One open finding row, scoped the way the projection scopes it (R3). */
function finding(overrides: Partial<PhraseFindingRow> & { id: string }): PhraseFindingRow {
    const targeted = overrides.targeted ?? ['grp-promise'];

    return {
        title: 'a sentence the Reviewer is not satisfied with',
        cost: 'minor',
        state: 'unconfirmed',
        seen_count: 1,
        group_refs: targeted,
        unscoped: false,
        targeted,
        resolved: [],
        missing: targeted,
        resolved_all: false,
        ...overrides
    };
}

describe('SummaryOverviewPane — the compiled Overview and the five groups (U2)', () => {
    it('prints no Summary at all while the reviewed Summary is pending, and names what is missing (D-67)', () => {
        // The mid-review book: Ending unwritten and every group inside an open ISSUE's scope, so the reviewed
        // selection is partial and there is NO reviewed Overview to print. D-67's rule is that the pane does
        // not fill that gap with the live composed text — the newest Ending is text nobody passed, and
        // printing it under this heading would say the opposite.
        const view = midReviewView();

        render(<SummaryOverviewPane view={view} />);

        expect(screen.queryByTestId('summary-text')).toBeNull();
        // The live Overview — the four written groups joined by a blank line — appears nowhere in the pane.
        const text = String(screen.getByTestId('summary-overview').textContent);
        expect(text).not.toContain('A keeper of a lighthouse begins lying to the sea');
        expect(text).not.toContain('Plain sentences, salt in every image');
        // What replaces it: the wait, and the reasons, in the wire's own shape (5 groups, 5 gaps).
        expect(screen.getByTestId('reviewed-waiting').textContent).toBe(
            'No reviewed Summary yet — 5 of 5 groups are not in the selection, so the crew stands behind no Summary to choose.'
        );
        expect(
            Array.from(document.querySelectorAll('[data-testid^="reviewed-gap-"]')).map((row) => row.textContent)
        ).toEqual([
            'Premise: has open issues',
            'Promise: has open issues',
            'Theme: has open issues',
            'Tone: has open issues',
            'Ending: nothing written yet'
        ]);
        // The ISSUE rows, in the read's order, with the groups each one scopes to — the half that turns
        // "not yet" into something the Author can act on. `f-minor` is a proposal and `f-fixed` is archived,
        // so neither appears.
        expect(
            Array.from(document.querySelectorAll('[data-testid^="reviewed-issue-"]')).map((row) => row.textContent)
        ).toEqual([
            'Holding a clean pass back: the promise names a cost the premise never sets up (critical) on Promise, Theme',
            'Holding a clean pass back: the Overview never says who the keeper is lying for (major) on Premise, Promise, Theme, Tone, Ending'
        ]);
        expect(view.phrase?.reviewed.state).toBe('pending');
    });

    it("counts the written groups with the server's own numbers, not a count of its own (R1)", () => {
        render(<SummaryOverviewPane view={midReviewView()} />);

        expect(screen.getByTestId('summary-written').textContent).toBe('4 of 5 groups written');
        expect(screen.getByTestId('summary-unwritten').textContent).toBe(
            '1 of 5 groups still have no content: Ending.'
        );
    });

    it('lists exactly the five catalog groups, in composition order, and never World rules (R1)', () => {
        const { container } = render(<SummaryOverviewPane view={midReviewView()} />);
        const rows = Array.from(container.querySelectorAll('[data-testid^="summary-group-"]')).filter(
            // The per-row findings span carries the same prefix; the rows are the `li`s.
            (node) => node.tagName === 'LI'
        );

        expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
            'summary-group-premise',
            'summary-group-promise',
            'summary-group-theme',
            'summary-group-tone',
            'summary-group-ending'
        ]);
        expect(rows.map((row) => within(row as HTMLElement).getByText(/^(Premise|Promise|Theme|Tone|Ending)$/).textContent)).toEqual([
            'Premise',
            'Promise',
            'Theme',
            'Tone',
            'Ending'
        ]);
        // `world_rules` is a SECTION of the legacy Summary, not one of the five groups. A sixth row here
        // would be a group the loop never writes.
        expect(container.textContent).not.toContain('World rules');
        expect(rows).toHaveLength(5);
    });

    it('states each group by the state the wire reports, in the priority the gate uses', () => {
        const { container } = render(<SummaryOverviewPane view={midReviewView()} />);

        const toneOf = (key: string): string | null =>
            container.querySelector(`[data-testid="summary-group-${key}"] .sv-group-row-state`)?.getAttribute('data-tone') ??
            null;

        // Premise / Promise / Tone each carry a finding at a blocking cost (the critical cross-group one,
        // or the unscoped major) → `blocking`. Theme is held by the Writer, which outranks its findings:
        // the text is moving, not waiting. Ending has no revision → `to write` (R1). The `data-tone` is the
        // stylesheet's hook and is a tone name, so it is checked separately from the word a reader sees.
        expect(toneOf('premise')).toBe('blocking');
        expect(toneOf('promise')).toBe('blocking');
        expect(toneOf('theme')).toBe('writer');
        expect(toneOf('tone')).toBe('blocking');
        expect(toneOf('ending')).toBe('todo');

        expect(
            container.querySelector('[data-testid="summary-group-theme"] .sv-group-row-state')?.textContent
        ).toBe('writer');
        expect(
            container.querySelector('[data-testid="summary-group-ending"] .sv-group-row-state')?.textContent
        ).toBe('to write');
    });

    it('counts the open findings per group and the critical/major band beside them (U2)', () => {
        const { container } = render(<SummaryOverviewPane view={midReviewView()} />);

        const findingsLine = (key: string): string | null =>
            container.querySelector(`[data-testid="summary-group-${key}-findings"]`)?.textContent ?? null;

        // The counts are the derivations', not the pane's: Premise is named only by the unscoped major
        // (1 open, and it is in the band); Promise is named by the critical, the minor note and the unscoped
        // major (3 open, 2 of them critical/major — the minor note is out of the band); Theme by the critical
        // and the unscoped major; Tone and Ending by the unscoped major alone — including Ending, because an
        // UNSCOPED finding is a statement about the whole Overview, so it aims at a group that has no text
        // yet (R3). R2/T15 — the second number names the COST BAND, not a wait: D-78 has the accept void
        // these rows, so `holds the sign-off` contradicted the confirm line under the same rows.
        expect(findingsLine('premise')).toBe('1 open finding · 1 critical/major');
        expect(findingsLine('promise')).toBe('3 open findings · 2 critical/major');
        expect(findingsLine('theme')).toBe('2 open findings · 2 critical/major');
        expect(findingsLine('tone')).toBe('1 open finding · 1 critical/major');
        expect(findingsLine('ending')).toBe('1 open finding · 1 critical/major');
        // What the findings line replaces: the archived count is only printed when nothing is open, so a
        // row never has to choose between two numbers. An unwritten group says so in its state word.
        expect(
            container.querySelectorAll('[data-testid="summary-group-ending"] .sv-group-row-quiet')
        ).toHaveLength(0);
        // The fixed finding is archived out of every active list (U5), so it reaches no row's count and no
        // row's text.
        expect(container.textContent).not.toContain('the lighthouse was a different colour');
    });

    it('shows the archived count for a written group instead of the archived prose (U3)', () => {
        const base = groupedPhraseView('s1');
        const withHistory = base.groups.map((group) =>
            group.key === 'premise'
                ? {
                      ...group,
                      // The `latest` row is part of `history` (R2), and only the two below it are archived.
                      history: [
                          ...group.history,
                          { ...group.history[0], id: 'rev-premise-2', number: 2, state: 'archived', chars: 41 },
                          { ...group.history[0], id: 'rev-premise-1', number: 1, state: 'archived', chars: 33 }
                      ]
                  }
                : group
        );
        const { container } = render(
            <SummaryOverviewPane view={groupedView({ groups: withHistory })} />
        );

        // Nothing is open on this book, so the quiet span carries the count — the COUNT, because the
        // projection sends `chars` for a superseded revision and no prose (R2).
        expect(
            container.querySelector('[data-testid="summary-group-premise"] .sv-group-row-quiet')?.textContent
        ).toBe('2 archived');
        expect(container.textContent).not.toContain('41 chars');
        // And nothing here pretends to open one. Scoped to the LIVE rows on purpose: D-67's reviewed strip adds
        // five more buttons above these, and they are not group panes, so they must not be counted as rows.
        expect(container.querySelectorAll('[data-testid="summary-group-rows"] button')).toHaveLength(5);
        expect(screen.queryAllByRole('button', { name: /^(Show|Open|Expand|History)/i })).toHaveLength(0);
    });

    it('says a group is only OPEN when its findings cost less than the sign-off bar (the note case)', () => {
        // One minor note on Promise, and this Story's dial (`auto_approve: ['critical','major']`) does not
        // cover minor. The row must read `open`, not `blocking`, and must not claim the sign-off.
        const view = groupedView({
            findings: [finding({ id: 'f-note', title: 'the promise restates the premise', cost: 'minor' })],
            review: {
                ...groupedPhraseView('s1').review,
                open_findings: 1,
                blocking_findings: 0
            }
        });
        const { container } = render(<SummaryOverviewPane view={view} />);

        expect(container.querySelector('[data-testid="summary-group-promise"]')?.getAttribute('data-tone')).toBe('open');
        expect(
            container.querySelector('[data-testid="summary-group-promise"] .sv-group-row-state')?.textContent
        ).toBe('open');
        expect(
            container.querySelector('[data-testid="summary-group-promise-findings"]')?.textContent
        ).toBe('1 open finding');
        // Every other group is written with nothing open on it → `clean`.
        expect(container.querySelector('[data-testid="summary-group-premise"] .sv-group-row-state')?.textContent).toBe(
            'clean'
        );
    });

    it('reports the review the last pass left, as the server counts it', () => {
        render(<SummaryOverviewPane view={midReviewView()} />);

        // open_findings 3 (the critical, the unscoped major, the minor note — `fixed` is archived),
        // blocking_findings 2, open_tasks 2 (`t-theme` claimed + `t-ending` open; `t-tone` is done).
        // R2/T15 — the middle count names the COST BAND (`review.blocking_findings` is the critical/major
        // subset of the open pile), not a wait: the accept signs a clean Summary off over these rows and voids
        // them, so "holding the sign-off" contradicted the confirm line this pane sits under.
        expect(screen.getByTestId('summary-review').textContent).toBe(
            '3 open findings · 2 critical/major · 2 open tasks'
        );
    });

    it('is an empty pane with a reason when nothing has been written (U4)', () => {
        // The catalog's own five rows, each back at `revision: 0` with no content: the loop's "never
        // written" (R1). Nothing about the book is invented here — the rows come from the same fake the
        // shell-fakes suite pins — and the reviewed block is `pending` with every group unwritten, because a
        // book with no text has no clean selection either.
        const base = groupedPhraseView('s1');
        const unwritten = base.groups.map((group) => ({
            ...group,
            content: '',
            revision: 0,
            updated_by: null,
            history: []
        }));
        const view = groupedView({
            groups: unwritten,
            overview: '',
            review: {
                ...base.review,
                written_groups: 0,
                unwritten_groups: orderedPhraseGroupDefinitions().map((definition) => definition.key)
            },
            reviewed: reviewedBlock({
                state: 'pending',
                complete: false,
                vector: {},
                vector_hash: '',
                overview: '',
                groups: base.groups.map((group) => ({
                    ...reviewedGroup({ id: group.id, key: group.key }),
                    selected_revision: null,
                    selected_id: null,
                    clean_run_ref: null,
                    latest_revision: 0,
                    gap: 'unwritten' as const,
                    scores: []
                })),
                chosen: null
            })
        });

        const { container } = render(<SummaryOverviewPane view={view} />);

        // U4's purposeful empty state survives D-67 in the waiting list: the pane says what is missing and who
        // fills it, and the badge states the reviewed state rather than a Summary that is not there.
        expect(screen.getByTestId('reviewed-state').textContent).toBe('no reviewed Summary yet');
        expect(
            Array.from(document.querySelectorAll('[data-testid^="reviewed-gap-"]')).map((row) => row.textContent)
        ).toEqual([
            'Premise: nothing written yet',
            'Promise: nothing written yet',
            'Theme: nothing written yet',
            'Tone: nothing written yet',
            'Ending: nothing written yet'
        ]);
        expect(screen.queryByTestId('summary-text')).toBeNull();
        // AC5 — the placeholder is still a `<p>` of prose, not an empty markdown card: the renderer is
        // mounted over text that exists, so the empty state keeps the exact node count it had before.
        expect(container.querySelectorAll('.sv-markdown')).toHaveLength(0);
        expect(screen.getByTestId('summary-written').textContent).toBe('0 of 5 groups written');
    });

    it('has a purposeful empty state and keeps all five rows when the Overview is empty (U4)', () => {
        // The rows survive the empty Overview: an unwritten group is a fact about the book, and the
        // Author's next move is one of those five panes.
        const { container } = render(<SummaryOverviewPane view={groupedView({ overview: '' })} />);

        expect(container.querySelectorAll('.sv-group-row')).toHaveLength(5);
        // The live Overview being empty does NOT empty the card: this pane prints the REVIEWED text (D-67),
        // so the renderer is still mounted — and it is the only markdown block in the pane.
        expect(container.querySelectorAll('[data-testid="summary-text"].sv-markdown')).toHaveLength(1);
    });
});

describe('SummaryOverviewPane — the rail selects the group, the pane navigates (U2)', () => {
    it('navigates by the group UUID the rail would carry, never by index or order', () => {
        const onSelect = vi.fn();

        const { container } = render(<SummaryOverviewPane view={midReviewView()} onSelect={onSelect} />);

        const row = container.querySelector('[data-testid="summary-group-theme"] button') as HTMLButtonElement;
        row.click();

        // The ref is the group's id STRING, exactly as `summaryGroupRef` spells it, so the Overview's row
        // and the rail's row produce the same selection from the same read.
        expect(onSelect).toHaveBeenCalledTimes(1);
        expect(onSelect.mock.calls[0]?.[0]).toEqual({
            panel: 'summary',
            ref: summaryGroupRef('grp-theme')
        });
    });

    it('says nothing about superseding when there is nothing superseded (R-T2/F5)', () => {
        // Every row here is at its FIRST revision: `0 archived` is not a fact about the book, and beside a
        // `clean` row it read like a defect. The quiet span still renders — its copy changes — so the row's
        // accessible name keeps the same shape either way.
        const { container } = render(<SummaryOverviewPane view={groupedView({})} />);

        expect(container.querySelector('[data-testid="summary-group-tone"] .sv-group-row-quiet')?.textContent).toBe(
            'nothing superseded'
        );
        expect(container.textContent).not.toContain('0 archived');

        // …while an unwritten group still says what is missing, which is a fact (U4). Ending carries no
        // findings in this frame, so the quiet span is the one that renders.
        const base = groupedPhraseView('s1');
        const unwrittenEnding = groupedView({
            groups: base.groups.map((group) =>
                group.key === 'ending' ? { ...group, content: '', revision: 0, history: [] } : group
            )
        });
        const mid = render(<SummaryOverviewPane view={unwrittenEnding} />);

        expect(
            mid.container.querySelector('[data-testid="summary-group-ending"] .sv-group-row-quiet')?.textContent
        ).toBe('nothing written yet');
    });

    it('lights the row the rail is standing on and no other', () => {
        const { container } = render(
            <SummaryOverviewPane
                view={midReviewView()}
                selection={{ panel: 'summary', ref: summaryGroupRef('grp-tone') }}
            />
        );

        const selected = Array.from(container.querySelectorAll('.sv-group-row')).filter(
            (row) => row.getAttribute('data-selected') === 'true'
        );

        expect(selected).toHaveLength(1);
        expect(selected[0]?.getAttribute('data-testid')).toBe('summary-group-tone');
    });

    it('is a named list of five groups that says which one is the pane on screen (R-T2/F4)', () => {
        // F4's two halves, both asked of the ACCESSIBLE tree rather than of class names: the rows are a named
        // list (so a reader hears "list, 5 items" and can navigate them as a set), and the row that IS the
        // open pane carries `aria-current="true"` — the selected semantics for a control that navigates. The
        // rail's own rows are untouched: this pane is the wide desk surface, and only its list is labelled.
        render(
            <SummaryOverviewPane
                view={midReviewView()}
                selection={{ panel: 'summary', ref: summaryGroupRef('grp-tone') }}
            />
        );

        const list = screen.getByRole('list', { name: 'Summary groups' });
        const items = within(list).getAllByRole('listitem');

        expect(items).toHaveLength(5);
        // The five catalog names, in composition order — the list's own order, read off the tree.
        expect(
            items.map((item) => (item.querySelector('button')?.textContent ?? '').split(' ')[0])
        ).toEqual(['Premise', 'Promise', 'Theme', 'Tone', 'Ending']);

        const buttons = within(list).getAllByRole('button');
        const current = buttons.filter((button) => button.getAttribute('aria-current') === 'true');

        expect(current).toHaveLength(1);
        expect(current[0]?.textContent?.startsWith('Tone ')).toBe(true);
        for (const button of buttons) {
            if (button === current[0]) continue;
            // Exactly one row may claim to be the current one, or a reader cannot tell which pane is open.
            expect(button.hasAttribute('aria-current')).toBe(false);
        }
    });

    it('names a row by what it is and what it owes, so a reader gets the state without opening it (U7)', () => {
        const { container } = render(<SummaryOverviewPane view={midReviewView()} />);
        const row = container.querySelector('[data-testid="summary-group-promise"] button') as HTMLButtonElement;

        // The accessible name is the row's whole text: title, state word, and the findings count with the
        // sentence saying what the count means. Word boundaries between the three are real spaces, so a
        // screen reader never announces "Promiseblocking3 open findings".
        expect(row.textContent).toBe('Promise blocking 3 open findings · 2 critical/major');
    });
});

describe('SummaryOverviewPane — what the sampling panel had, and this surface does not (U3)', () => {
    it('carries none of the sampler’s instruments: no dials, no cards, no seats, no another-round', () => {
        const { container } = render(<SummaryOverviewPane view={midReviewView()} />);
        const text = String(container.textContent);

        // These are the sampler's controls on the legacy pane. A grouped Story runs no sampler, so
        // printing them would put numbers on screen the engine never produced.
        for (const removed of [
            'Request another revision round',
            'Merge',
            'Serve',
            'Recommend',
            'Sample size',
            'Critics per draft',
            'seats',
            'round'
        ]) {
            expect(text.includes(removed), removed).toBe(false);
        }

        // …and none of the legacy pane's DOM: the dial block, the candidate list, the revision ledger.
        expect(container.querySelector('.sv-summary-dials')).toBeNull();
        expect(container.querySelector('.sv-summary-revisions')).toBeNull();
        expect(container.querySelectorAll('.sv-revision-card')).toHaveLength(0);
        expect(container.querySelectorAll('input[type="number"]')).toHaveLength(0);
        // The Overview is a read: the only controls are the five group rows.
        expect(container.querySelectorAll('button')).toHaveLength(5);
    });

    it('renders its own one-line answer for a sampling book, with no invented groups', () => {
        // Defensive: `StoryView` routes a `mode:'sampling'` book to `SummaryPane`. If one arrives here,
        // five empty rows would claim a shape the wire never sent.
        const { container } = render(<SummaryOverviewPane view={fixtureView()} />);

        expect(container.querySelector('[data-testid="summary-overview-legacy"]')).toBeTruthy();
        expect(container.querySelector('.sv-group-rows')).toBeNull();
    });

    it('names a FAILED phrase read instead of promising rows that will never arrive (R-T2/F2)', () => {
        // The frame the review caught: a grouped Story whose phrase read answered 503. `phrase` is absent, which
        // the pane used to read as "still arriving" — so it printed a loading line forever. With the store's
        // cached sentence in the model, the Summary area states what failed and what to do, and claims nothing
        // about the book.
        const failure = '503: the phrase read is offline (maintenance)';
        const { container } = render(
            <SummaryOverviewPane view={{ ...pendingView(), phraseError: failure }} />
        );

        expect(container.querySelector('[data-testid="summary-overview-error"]')).toBeTruthy();
        expect(container.querySelector('[data-testid="summary-overview-pending"]')).toBeNull();
        expect(container.querySelector('[data-testid="summary-read-error"]')?.textContent).toBe(
            `The Summary group rows could not be read: ${failure}`
        );
        // The actionable half, in the warning notice: the groups exist, the READ failed, and the way out is a
        // reload. No rows, no counts, no "unwritten" — those would be claims about a book the desk has not read.
        expect(container.querySelector('.sv-group-notice--warn')).toBeTruthy();
        expect(container.textContent).toContain('reload the Story');
        expect(container.textContent).not.toContain('still have no content');
        expect(container.querySelector('.sv-group-rows')).toBeNull();
        // And the Story payload is still the Story payload: this pane never claims the whole Story failed.
        expect(container.textContent).not.toContain('This Story has no Summary');
    });

    it('separates "the phrase read has not landed" from "nothing is written" (U6)', () => {
        const { container } = render(<SummaryOverviewPane view={pendingView()} />);

        expect(container.querySelector('[data-testid="summary-overview-pending"]')).toBeTruthy();
        // An unwritten group is a fact about the book; a read in flight is not that fact, so no rows and
        // no unwritten sentence until the rows arrive.
        expect(container.querySelector('.sv-group-rows')).toBeNull();
        expect(container.textContent).not.toContain('still have no content');
    });
});

// ---------------------------------------------------------------------------
// D-67 / D-68 — the reviewed Summary is THE Summary of this tab
//
// `reviewedPhraseView()`'s three states, pinned against fixtures whose LIVE and REVIEWED texts differ: the
// book's Ending is at Revision 3 with newer text no pass has closed on, while the selection stands at the
// clean Revision 2. That difference is what makes "the live text appears nowhere" an assertion instead of a
// tautology, and it is the exact shape the feature was built for (the pair of numbers the rail exists to
// show). Every expected string below is written from the fixture's data, not from a render of the pane.
// ---------------------------------------------------------------------------

/** The grouped book in one reviewed state, wired into the view the panes read. */
function reviewedView(state: 'pending' | 'ready' | 'chosen' | 'stale' | 'writer_busy') {
    return fixtureView({ phrase: reviewedPhraseView('s1', state) });
}

/** The reviewed strip's rows, in DOM order, as the exact text a reader hears. */
function reviewedRowTexts(root: ParentNode = document): string[] {
    return Array.from(root.querySelectorAll('li[data-testid^="reviewed-group-"]')).map((row) =>
        // textContent joins a row's spans with whatever whitespace the markup holds; normalising it keeps the
        // assertion one readable line per group.
        String(row.textContent).replace(/\s+/g, ' ').trim()
    );
}

/**
 * THE SUMMARY CARD, BLOCK BY BLOCK, as `TAG:text` in DOM order.
 *
 * The Overview this card prints is MARKDOWN (`shared/phrase.ts:composePhraseContent` joins the groups as
 * `## <title>\n<content>`, and `server/phrase/reviewed.ts:composeReviewedOverview` compiles the reviewed one
 * the same way), so it is rendered by `MarkdownText` rather than printed. The paragraphing therefore moved
 * out of the string and into block elements: `getByTestId('summary-text').textContent` is no longer the
 * source, and a `toBe(source)` here would be an assertion about the SOURCE rather than about what a reader
 * sees. This helper keeps the same exactness — one exact string per rendered block, in order — plus the tag,
 * which is what proves a heading was read as a heading and a group as a paragraph.
 */
function summaryBlocks(root: ParentNode = document): string[] {
    const card = root.querySelector('[data-testid="summary-text"]');

    if (card === null) throw new Error('no `summary-text` card in this render');

    return Array.from(card.querySelectorAll('h1,h2,h3,h4,h5,h6,p')).map(
        (block) => `${block.tagName}:${block.textContent ?? ''}`
    );
}

describe('SummaryOverviewPane — only the reviewed version is the Summary (D-67)', () => {
    it('prints the reviewed Overview as THE Summary, and the live composed text nowhere', () => {
        const phrase = reviewedPhraseView('s1', 'ready');
        const { container } = render(<SummaryOverviewPane view={reviewedView('ready')} />);
        const text = String(container.textContent);

        // The printed text is `reviewed.overview`: the four groups the Writer installed (which ARE the
        // selected rows) plus the CLEAN Ending — not the Ending the live Overview carries. The five sentences
        // are asserted exactly, one per rendered block, in the order the Overview composes them.
        expect(summaryBlocks(container)).toEqual([
            'P:Premise — the text the Writer installed (group 1).',
            'P:Promise — the text the Writer installed (group 2).',
            'P:Theme — the text the Writer installed (group 3).',
            'P:Tone — the text the Writer installed (group 4).',
            'P:Ending — the clean text the Reviewers passed at Revision 2.'
        ]);
        // This fixture's Overview has no headings; what it DOES pin is that nothing renders as raw source —
        // no `## ` marker, and no `<p>` count higher than the five groups.
        expect(container.querySelector('[data-testid="summary-text"] h2')).toBeNull();
        expect(container.textContent).not.toContain('## ');
        // The card is the shared renderer: the pane's sizing class and the Markdown block scale sit on ONE
        // element, which is what keeps the pane's height/scroll rule working.
        expect(container.querySelector('[data-testid="summary-text"]')?.className).toBe(
            'sv-markdown sv-summary-text'
        );
        // The live Overview is absent, whole and in part: the pane does not print it, does not print it
        // "smaller" under a label, and does not print its Ending line at all.
        expect(phrase.overview).toContain('Ending — the newest text the Writer installed');
        expect(text).not.toContain('Ending — the newest text the Writer installed');
        expect(text).not.toContain(phrase.overview);
        expect(screen.queryAllByTestId('summary-live-text')).toHaveLength(0);
        expect(screen.getByTestId('reviewed-state').textContent).toBe('reviewed Summary ready');
    });

    it('renders the compiled Overview as Markdown, so `## Premise` reads as a heading', () => {
        // THE SHAPE THE PRODUCER ACTUALLY SENDS. `shared/phrase.ts:composePhraseContent` maps every entry to
        // `` `## ${title}\n${content}` `` and joins them with `\n\n`, and `server/phrase/reviewed.ts` compiles
        // the reviewed Overview the same way — which is the whole defect this change fixes: printed as text,
        // the Author read `## Premise` on the card instead of a heading over the group's prose. The
        // heading-free fixtures above pin the WORDING; this one pins the READING.
        const overview = [
            '## Premise',
            'A keeper of a lighthouse begins lying to the sea.',
            '',
            '## Promise',
            "A sealed cathedral of data holds the city's memory.",
            '',
            '## Tone',
            'Plain sentences, salt in every image.'
        ].join('\n');

        const { container } = render(
            <SummaryOverviewPane
                view={groupedView({
                    overview,
                    reviewed: reviewedBlock({
                        state: 'ready',
                        complete: true,
                        vector_hash: 'vector-1',
                        overview
                    })
                })}
            />
        );

        const card = screen.getByTestId('summary-text') as HTMLElement;

        // The headings are headings, in composition order, and the prose under each is its own paragraph.
        expect(Array.from(card.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((h) => h.textContent)).toEqual([
            'Premise',
            'Promise',
            'Tone'
        ]);
        expect(card.querySelector('h2')?.textContent).toBe('Premise');
        expect(summaryBlocks(container)).toEqual([
            'H2:Premise',
            'P:A keeper of a lighthouse begins lying to the sea.',
            'H2:Promise',
            "P:A sealed cathedral of data holds the city's memory.",
            'H2:Tone',
            'P:Plain sentences, salt in every image.'
        ]);
        // The marker is gone everywhere in the pane — not just from the card, which is where a `pre-wrap`
        // paragraph would otherwise have kept it — and the paragraphing is three paragraphs, not three
        // paragraphs plus the blank lines the old `textContent` render used to print.
        expect(container.textContent).not.toContain('## ');
        expect(card.querySelectorAll('p')).toHaveLength(3);
        // The heading is INSIDE the card the pane's sizing rule addresses, so the pane's height and scroll
        // behaviour still apply to the rendered prose.
        expect(card.className).toBe('sv-markdown sv-summary-text');
    });

    it('puts every line of the compiled Overview on its own line, including the ones with no markdown in them (U-23)', () => {
        // THE OTHER HALF OF THE RENDERED READING, and the half markdown alone gets wrong. The Overview is composed
        // entry-by-entry as `## <title>\n<content>` — the heading renders, done — but a group's `<content>` is
        // LINE-oriented text: an agent wraps a paragraph mid-sentence, and a §4.2 sheet like Tone is written as
        // `Label: value` lines, which is exactly how `server/phrase/plotpoints.ts:chapterEntryContent` stores a
        // chapter entry too. Those lines are separated by a SINGLE `\n`, which is a soft break: with no
        // `white-space: pre-wrap` left on the card (`styles/story.css:506-513`), markdown alone would print the
        // whole sheet as one running sentence. `MarkdownText` keeps the writer's line breaks (`remark-breaks`).
        //
        // The payload is BUILT by the producer — `shared/phrase.ts:composePhraseContent` — rather than typed here,
        // so the single-vs-blank newline distinction this test is about is the real one.
        const overview = composePhraseContent([
            { key: 'premise', title: 'Premise', content: 'A keeper of a lighthouse\nbegins lying to the sea' },
            { key: 'tone', title: 'Tone', content: 'Voice: spare\nPOV: third\nTense: past' }
        ]);

        expect(overview).toBe(
            '## Premise\nA keeper of a lighthouse\nbegins lying to the sea\n\n' +
                '## Tone\nVoice: spare\nPOV: third\nTense: past'
        );

        const { container } = render(
            <SummaryOverviewPane
                view={groupedView({
                    overview,
                    reviewed: reviewedBlock({
                        state: 'ready',
                        complete: true,
                        vector_hash: 'vector-1',
                        overview
                    })
                })}
            />
        );

        const card = screen.getByTestId('summary-text') as HTMLElement;
        const paragraphs = Array.from(card.querySelectorAll('p'));

        // The two sections are still sections — this test is about what sits UNDER them, not instead of them.
        expect(Array.from(card.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((h) => h.textContent)).toEqual([
            'Premise',
            'Tone'
        ]);
        expect(container.textContent).not.toContain('## ');
        // Two paragraph boxes (the blank line between entries is a block break, not a break) holding three real
        // line breaks — one for the wrapped sentence, two for the three lines of the sheet.
        expect(paragraphs).toHaveLength(2);
        expect(card.querySelectorAll('br')).toHaveLength(3);
        expect(paragraphs[0]!.innerHTML).toBe('A keeper of a lighthouse<br>\nbegins lying to the sea');
        expect(paragraphs[1]!.innerHTML).toBe('Voice: spare<br>\nPOV: third<br>\nTense: past');
        // The card the pane's sizing rule addresses is still the renderer's wrapper, so neither the height floor
        // nor the scroll container moved when the text became blocks and breaks.
        expect(card.className).toBe('sv-markdown sv-summary-text');
    });

    it('shows each group the revision it stands behind, the score that judged it, and the newer one it fell past', () => {
        render(<SummaryOverviewPane view={reviewedView('ready')} />);

        // Five rows, catalog order, and the score printed beside each is the number that judged the CLEAN
        // vector (79/71/66/83/62) — NOT the live rows' trend scores (84/76/70/88/66), which describe text
        // nobody reviewed. A pane that read `groups[].scores` here would print 84%.
        expect(reviewedRowTexts()).toEqual([
            'Premise reviewed Revision 1 Score 79%',
            'Promise reviewed Revision 1 Score 71%',
            'Theme reviewed Revision 1 Score 66%',
            'Tone reviewed Revision 1 Score 83%',
            // The pair the feature exists to show, in one line: reviewed r2, newest r3.
            'Ending reviewed Revision 2 Score 62% Revision 3 is newer'
        ]);
        // Supersession is marked subtly, and in words: a separate quiet span, never the state word.
        const ending = document.querySelector('[data-testid="reviewed-group-ending"]');

        expect(ending?.getAttribute('data-tone')).toBe('superseded');
        expect(document.querySelector('[data-testid="reviewed-newer-ending"]')?.textContent).toBe(
            'Revision 3 is newer'
        );
        expect(document.querySelector('[data-testid="reviewed-newer-premise"]')).toBeNull();
    });

    it('waits with a reason per group when the selection is partial, and prints no substitute text', () => {
        const phrase = reviewedPhraseView('s1', 'pending');
        const { container } = render(<SummaryOverviewPane view={reviewedView('pending')} />);
        const text = String(container.textContent);

        // The waiting state shows NO Summary text — `pending` never borrows the live Overview — and no choose,
        // because there is nothing to choose. The renderer is absent altogether, not present-but-empty: the
        // markdown wrapper is only ever mounted over text that exists, so an empty card cannot pad the pane.
        expect(screen.queryByTestId('summary-text')).toBeNull();
        expect(container.querySelectorAll('.sv-markdown')).toHaveLength(0);
        expect(container.querySelector('[data-testid="reviewed-choose"]')).toBeNull();
        expect(screen.getByTestId('reviewed-state').textContent).toBe('no reviewed Summary yet');
        expect(phrase.overview).not.toBe('');
        expect(text).not.toContain('the text the Writer installed');

        // MIXED gaps, each in its own words: unwritten is a different wait from never-passed, and an open
        // issue is the one the Author can act on. The group that IS selected (Premise r2) is not a gap row.
        expect(
            Array.from(document.querySelectorAll('[data-testid^="reviewed-gap-"]')).map((row) => row.textContent)
        ).toEqual([
            'Promise: has open issues',
            'Theme: nothing written yet',
            'Tone: awaiting a clean pass'
        ]);
        expect(
            Array.from(document.querySelectorAll('[data-testid^="reviewed-issue-"]')).map((row) => row.textContent)
        ).toEqual([
            'Holding a clean pass back: the promise names a cost the premise never sets up (major) on Promise'
        ]);
        // A partial selection has a hash no score row carries (the Reader only ever claims a complete one),
        // so the strip prints the selection it has and NO number beside it.
        expect(reviewedRowTexts()).toEqual([
            'Premise reviewed Revision 2',
            'Promise has open issues',
            'Theme nothing written yet',
            'Tone awaiting a clean pass',
            'Ending reviewed Revision 1'
        ]);
        expect(container.querySelector('[data-testid="reviewed-score-premise"]')).toBeNull();
    });

    it('marks the chosen Summary as chosen, with the date and the dropped revisions named', () => {
        const { container } = render(<SummaryOverviewPane view={reviewedView('chosen')} />);

        expect(screen.getByTestId('reviewed-state').textContent).toBe('reviewed Summary chosen');
        // The CHOSEN text, block by block — the same five sentences, asserted exactly, and each one inside a
        // rendered paragraph rather than one preformatted string.
        expect(summaryBlocks(container)).toEqual([
            'P:Premise — the text the Author chose.',
            'P:Promise — the text the Author chose.',
            'P:Theme — the text the Author chose.',
            'P:Tone — the text the Author chose.',
            'P:Ending — the text the Author chose.'
        ]);
        expect(container.textContent).not.toContain('## ');
        // The date is the wire's `chosen.at`, printed as the wire sent it: `2026-11-09T14:00:00.000Z` →
        // `2026-11-09`. The time of day is noise on a Summary the Author compares day against day.
        expect(screen.getByTestId('reviewed-caption').textContent).toBe(
            'The Summary the Author chose on 2026-11-09. The revisions it passed over were dropped from the book (D-68).'
        );
        expect(screen.getByTestId('reviewed-dropped').textContent).toBe(
            'Everything this choice passed over was dropped from the Summary — the numbers below name the revision each section was taken from.'
        );
        // The numbers come off the CHOICE record (`chosen.vector`, `chosen.scores`, keyed by group UUID), not
        // off the live selection, which is empty in this state: after a choose the installed rows carry no
        // clean stamp, so a pane reading the selection would print five gaps over the Author's own choice.
        expect(reviewedRowTexts()).toEqual([
            'Premise taken from Revision 1 Score 74%',
            'Promise taken from Revision 1 Score 75%',
            'Theme taken from Revision 1 Score 76%',
            'Tone taken from Revision 1 Score 77%',
            'Ending taken from Revision 1 Score 78%'
        ]);
        // The choice is made: no Choose verb is offered over a Summary the Author already took, and there is
        // nothing newer standing (`stale` would move the state back to `ready`, which the next test pins).
        expect(container.querySelector('[data-testid="reviewed-choose"]')).toBeNull();
    });

    it('offers the newer reviewed Summary when the crew has reviewed past the Author\'s choice', () => {
        // The actions object is what makes the verb live at all (the next describe pins the refusal when it is
        // missing), so this fixture passes one even though nothing is clicked here.
        const actions = { chooseReviewedSummary: vi.fn(async () => ({})) };
        const { container } = render(<SummaryOverviewPane view={reviewedView('stale')} actions={actions} />);
        const submit = screen.getByTestId('reviewed-choose-submit') as HTMLButtonElement;

        expect(screen.getByTestId('reviewed-stale').textContent).toBe(
            'You chose a Summary on 2026-11-08, and the crew has reviewed a newer one since — choosing takes the newer text.'
        );
        // `stale` is not a stale frame: it says newer reviewed TEXT exists, which is the case the choose
        // exists for a second time. So it changes the label and the sentence, never the enabled state — an
        // Author who already chose must be able to take the newer text (see `reviewedChooseRefusal`).
        expect(submit.textContent).toBe('Choose the newer reviewed Summary');
        expect(submit.disabled).toBe(false);
        expect(submit.getAttribute('title')).toBe(
            'Install the reviewed Summary and drop the revisions it passes over (D-68).'
        );
        expect(screen.getByTestId('summary-text').textContent).toContain(
            'Ending — the clean text the Reviewers passed at Revision 2.'
        );
        // The chosen record stays visible as the caption's subject, but the pane is in `ready`, so the chosen
        // note and the chosen date line are not drawn.
        expect(container.querySelector('[data-testid="reviewed-dropped"]')).toBeNull();
    });
});

/** The choose calls the fake client recorded, as plain argument tuples (`state.phrases.test.ts:phraseCalls`). */
function chooseCalls(client: ReturnType<typeof fakeApi>): unknown[][] {
    return (
        client.choosePhraseReviewed as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls;
}

describe('SummaryOverviewPane — the Author chooses the reviewed Summary (D-68)', () => {
    it('arms on the first click, names what will be dropped, and sends only on the confirm', async () => {
        const actions = { chooseReviewedSummary: vi.fn(async () => ({})) };

        render(<SummaryOverviewPane view={reviewedView('ready')} actions={actions} />);

        // Click one: the pane states the consequence — five installs, and the newer Ending row discarded —
        // and sends NOTHING. A verb that discards revisions gets a step that says so before it runs.
        await click(screen.getByTestId('reviewed-choose-submit'));

        expect(actions.chooseReviewedSummary).not.toHaveBeenCalled();
        expect(screen.getByTestId('reviewed-choose-note').textContent).toBe(
            'Choosing installs this Summary for all five groups and drops the newer texts it passes over (D-68): Ending Revision 3.'
        );

        // Click two: the route call, addressed by the Story the pane is showing and with no note.
        await click(screen.getByTestId('reviewed-choose-confirm'));

        expect(actions.chooseReviewedSummary).toHaveBeenCalledTimes(1);
        expect(actions.chooseReviewedSummary.mock.calls[0]).toEqual(['s1']);
        // The step is dropped, so what the Author reads next is the record the server returned.
        expect(screen.queryByTestId('reviewed-choose-confirm')).toBeNull();
        expect(screen.queryByTestId('reviewed-choose-note')).toBeNull();
    });

    it('cancels the confirmation without touching the route', async () => {
        const actions = { chooseReviewedSummary: vi.fn(async () => ({})) };

        render(<SummaryOverviewPane view={reviewedView('ready')} actions={actions} />);

        await click(screen.getByTestId('reviewed-choose-submit'));
        await click(screen.getByTestId('reviewed-choose-cancel'));

        expect(actions.chooseReviewedSummary).not.toHaveBeenCalled();
        expect(screen.queryByTestId('reviewed-choose-note')).toBeNull();
        // Back on step one, the verb is offered again — the cancel is not a lockout.
        expect((screen.getByTestId('reviewed-choose-submit') as HTMLButtonElement).disabled).toBe(false);
    });

    it('says so when the choice drops nothing, rather than promising a drop it cannot name', async () => {
        // Every reviewed group here IS the newest revision, so there is no newer text standing. A sentence
        // about dropping revisions would be a claim the wire never made.
        const actions = { chooseReviewedSummary: vi.fn(async () => ({})) };

        render(<SummaryOverviewPane view={groupedView({})} actions={actions} />);

        await click(screen.getByTestId('reviewed-choose-submit'));

        expect(screen.getByTestId('reviewed-choose-note').textContent).toBe(
            'Choosing installs this Summary for all five groups. No group has a newer text standing, so nothing is dropped (D-68).'
        );
    });

    it('is disabled while the Writer holds a group, with the reason on the control (R4, U-16)', () => {
        const actions = { chooseReviewedSummary: vi.fn(async () => ({})) };

        render(<SummaryOverviewPane view={reviewedView('writer_busy')} actions={actions} />);

        const submit = screen.getByTestId('reviewed-choose-submit') as HTMLButtonElement;

        expect(submit.disabled).toBe(true);
        // The SAME read the route's 409 refuses with, so a greyed control and a refusal cannot disagree.
        expect(submit.title).toBe(
            'The Writer is rewriting part of this Summary right now, so choosing would install under a pass that has not finished (R4).'
        );
        // Arming is impossible while it is disabled, so no confirm step is offered either.
        fireEvent.click(submit);
        expect(document.querySelector('[data-testid="reviewed-choose-note"]')).toBeNull();
    });

    it('states the shell\'s own refusal when the choose verb is not bound', () => {
        const { container } = render(<SummaryOverviewPane view={reviewedView('ready')} />);
        const submit = container.querySelector('[data-testid="reviewed-choose-submit"]') as HTMLButtonElement;

        expect(submit.disabled).toBe(true);
        expect(submit.title).toBe('The reviewed-Summary choose route is not available in this shell.');
    });

    it('prints the route\'s 409 sentence verbatim, beside the control that raised it', () => {
        // One of the three refusals, exactly as `routes.ts` writes it. The pane rewords nothing: the sentence
        // names the groups and the rule, and that is the Author's next action.
        const refusal =
            'this Story has no Reviewed Summary to choose: ending (unwritten), promise (an unresolved issue names it) ' +
            '— a group joins the reviewed Overview only once a cross-group Critic pass closes with no unresolved defect on it (D-67, D-68).';

        render(<SummaryOverviewPane view={{ ...reviewedView('ready'), reviewedError: refusal }} />);

        expect(screen.getByTestId('reviewed-choose-error').textContent).toBe(refusal);
        expect(screen.getByTestId('summary-text').textContent).toContain(
            'Ending — the clean text the Reviewers passed at Revision 2.'
        );
    });

    it('commits the record the choose route returns, then lands on whatever the phrase read reports', async () => {
        // The store's contract (`state.ts:chooseReviewedSummary`): the choose's own `view` is committed
        // immediately, and `mutate`'s post-write refetch (R6) then makes the phrase read authoritative. The
        // fake answers like the real server does — `ready` before the choose, `chosen` after it, because the
        // installed rows carry no clean stamp once the Author's choice is installed.
        let reads = 0;
        // The store test drives the STORE, not the panes, so it needs no `summary_mode` on the row (that field
        // is what `story-contract.isGroupSummary` reads, and it is not what routes the read here): the phrase
        // read itself is the five-group projection, which is the only fact these assertions care about.
        const { client, store } = fakeHarness([storyRow('s1')], [], {
            getPhrase: async () => reviewedPhraseView('s1', reads++ === 0 ? 'ready' : 'chosen')
        });

        await store.reload();
        await store.openStory('s1');

        expect(store.getSnapshot().phrases.s1?.reviewed.state).toBe('ready');

        await act(async () => {
            await store.chooseReviewedSummary('s1');
        });

        expect(client.choosePhraseReviewed).toHaveBeenCalledTimes(1);
        // The choose addresses the WHOLE reviewed Overview: story id plus an empty body, since the pane sends
        // no note (an empty string would print an empty attribution line).
        expect(chooseCalls(client)).toEqual([['s1', {}]]);
        expect(store.getSnapshot().phrases.s1?.reviewed.state).toBe('chosen');
        expect(store.getSnapshot().phrases.s1?.reviewed.chosen?.overview).toContain('the text the Author chose.');
        // A successful choose clears any refusal that was on the frame.
        expect(store.getSnapshot().reviewedErrors.s1).toBeUndefined();
    });

    it('the pane’s verb reaches the route through the store it is bound to', async () => {
        // The wiring hop the feature depends on: the pane's `actions.chooseReviewedSummary` is the store's own
        // method (`StorylineApp.tsx` binds it, exactly as it binds `reviseSummaryGroup`), so the pane never
        // calls a client by hand and the store owns the record. The view stays the one already on screen —
        // this test pins the CALL, and the two tests above pin what the store commits.
        let reads = 0;
        const client = fakeApi({
            getPhrase: async (storyId: string) => reviewedPhraseView(storyId, reads++ === 0 ? 'ready' : 'chosen')
        });
        const store = createDashboardStore(client);

        await store.reload();
        await store.openStory('s1');

        const actions = { chooseReviewedSummary: (storyId: string) => store.chooseReviewedSummary(storyId) };

        render(<SummaryOverviewPane view={fixtureView({ phrase: store.getSnapshot().phrases.s1 })} actions={actions} />);

        await click(screen.getByTestId('reviewed-choose-submit'));
        await click(screen.getByTestId('reviewed-choose-confirm'));

        expect(client.choosePhraseReviewed).toHaveBeenCalledTimes(1);
        expect(chooseCalls(client)).toEqual([['s1', {}]]);
        expect(store.getSnapshot().phrases.s1?.reviewed.state).toBe('chosen');
    });

    it('caches a refusal per Story so the Summary tab can print it verbatim', async () => {
        const refusal =
            'the Writer is rewriting part of this Summary right now (run_write_groups_1), so choosing the reviewed Overview ' +
            'would install under a pass that has not finished — the same choice lands once those runs close (R4, D-68).';
        const { store } = fakeHarness([storyRow('s1')], [], {
            getPhrase: async () => reviewedPhraseView('s1', 'ready'),
            choosePhraseReviewed: async () => {
                throw new Error(refusal);
            }
        });

        await store.reload();
        await store.openStory('s1');

        const result = await act(async () => {
            let value: unknown;
            await (async () => {
                value = await store.chooseReviewedSummary('s1');
            })();
            return value;
        });

        // `mutate` swallows for its callers (every other verb behaves this way) and raises the sentence into
        // the shell-wide line; the per-Story cache is what lets the pane print it beside its own button.
        expect(result).toBeNull();
        expect(store.getSnapshot().reviewedErrors.s1).toBe(refusal);
        expect(store.getSnapshot().error).toBe(refusal);
        // The phrase read is NOT replaced by a failed choose: the reviewed Summary on screen is still the one
        // the Author was refused about.
        expect(store.getSnapshot().phrases.s1?.reviewed.state).toBe('ready');

        const { container } = render(
            <SummaryOverviewPane
                view={{ ...fixtureView({ phrase: store.getSnapshot().phrases.s1 }), reviewedError: refusal }}
            />
        );

        expect(container.querySelector('[data-testid="reviewed-choose-error"]')?.textContent).toBe(refusal);
    });
});

// -----------------------------------------------------------------------------
// T14 — THE SECTION HEADING CARRIES THE CLEAN REVISION AND THE READER'S NUMBER.
//
// The user's format is `Premise (v2) 100%`, and the whole rule lives in `summary-heading.ts` as a pure text
// transform (its own `.test.ts` pins every edge of the matching). What is pinned HERE is the two things only a
// render can pin: that the card's `h2` says the decorated words — through `MarkdownText`, `remark-gfm` and
// `remark-breaks` intact — and that the decoration changed nothing about the TEXT the pane was handed, because
// that text is what Phrase ② copies onto its Seed and hashes (§4.20 / D-72) and because D-65 keeps a Reader's
// number out of stored content.
//
// The fixtures below therefore state BOTH sides in the same test: `reviewed.overview` (the wire, undecorated)
// and the `h2` (the render, decorated). A fixture whose reviewed rows carry no groups — which is what every
// pre-existing Markdown case above uses — answers no rows at all, which is why those `H2:Premise` pins still
// hold and why the decoration needed a fixture of its own.

/** One Critic score row, in the shape the projection attaches to a reviewed group (`api.ts:PhraseGroupScore`). */
function vectorScore(value: number): PhraseGroupScore {
    return { value, vector_hash: 'vh-t14', at: '2026-11-09T13:00:00.000Z', run_ref: 'run_critic_vh-t14' };
}

/** One group the reviewed Overview holds: its wire id, and the two numbers T14 prints. */
interface DecoratedRow {
    id: string;
    key: string;
    /** `null` is the wire's "no clean revision" — the heading then carries no `(v<n>)`. */
    revision: number | null;
    /** Absent means no pass reported against the selection's hash, and the heading carries no `<pct>%`. */
    score?: number;
}

/**
 * A grouped book whose reviewed Overview is the PRODUCER's shape (`## <title>` per section) and whose reviewed
 * rows carry the clean revision and the score the strip already prints. `groupedView`'s catalog rows supply the
 * TITLES the heading matcher compares against, so the match under test is against real catalog titles (`Premise
 * …`), not against strings this file invented.
 *
 * `chosenFor` switches the frame to D-68's `chosen` book, where the numbers come off the CHOICE record
 * (`chosen.vector` / `chosen.scores`) instead of the live selection — and where a group the choice did not name
 * answers neither number, which is the real "no numbers" state on this surface.
 */
function decoratedView(overview: string, rows: DecoratedRow[], chosenFor?: DecoratedRow[]) {
    const chosen = chosenFor === undefined;

    return groupedView({
        overview,
        reviewed: reviewedBlock({
            state: chosen ? 'ready' : 'chosen',
            complete: true,
            vector_hash: chosen ? 'vh-t14' : 'vh-t14-chosen',
            overview,
            groups: rows.map((entry) =>
                reviewedGroup({
                    id: entry.id,
                    key: entry.key,
                    selected_revision: chosen ? entry.revision : 1,
                    // `latest_revision` is the group's NEWEST number and is never null on the wire (0 when the
                    // group is unwritten), so a null selection reads as 0 here rather than as `null`.
                    latest_revision: chosen ? (entry.revision ?? 0) : 1,
                    // The score rows that judged THIS selection — `story-contract.reviewedGroupRows` reads the
                    // first finite one and hands `phraseScorePercent`'s number to the heading, so an entry with
                    // no `score` here is the fixture's "no pass reported against this hash" case.
                    scores: chosen && entry.score !== undefined ? [vectorScore(entry.score)] : []
                })
            ),
            chosen: chosen
                ? null
                : {
                      // A choice record that names NO revision and NO score for one group is what leaves that
                      // section's heading plain: both numbers are absent, so the rule writes neither.
                      vector: Object.fromEntries(
                          chosenFor.filter((entry) => entry.revision !== null).map((entry) => [entry.id, entry.revision as number])
                      ),
                      vector_hash: 'vh-t14-chosen',
                      at: '2026-11-09T14:00:00.000Z',
                      overview,
                      scores: Object.fromEntries(
                          chosenFor
                              .filter((entry) => entry.score !== undefined)
                              .map((entry) => [entry.id, [vectorScore(entry.score as number)]])
                      )
                  }
        })
    });
}

describe('SummaryOverviewPane — the Overview heading carries the revision and the reader\'s number (T14)', () => {
    /** The producer's own payload, built by `composePhraseContent` rather than typed out. */
    const THREE_SECTIONS = composePhraseContent([
        { key: 'premise', title: 'Premise', content: 'A keeper of a lighthouse begins lying to the sea.' },
        { key: 'promise', title: 'Promise', content: "A sealed cathedral of data holds the city's memory." },
        { key: 'tone', title: 'Tone', content: 'Plain sentences, salt in every image.' }
    ]);

    it('renders `Premise (v7) 100%` as the heading, and each section carries its own numbers (AC1)', () => {
        const view = decoratedView(THREE_SECTIONS, [
            { id: 'grp-premise', key: 'premise', revision: 7, score: 100 },
            { id: 'grp-promise', key: 'promise', revision: 2, score: 74 },
            // No score row against this selection: the heading carries the revision and nothing else, which is
            // the same honesty the rail and the strip already keep (an absence is not a zero).
            { id: 'grp-tone', key: 'tone', revision: 4 }
        ]);

        render(<SummaryOverviewPane view={view} />);

        const card = screen.getByTestId('summary-text') as HTMLElement;

        // THE EXACT RENDERED CARD, block by block: the decorated heading, its body as its own paragraph, in
        // composition order. `v7` is the CLEAN revision the selection stands behind and `100%` is the number
        // that judged exactly that text — the user's `Premise (v2) 100%`, in the producer's section order.
        expect(summaryBlocks()).toEqual([
            'H2:Premise (v7) 100%',
            'P:A keeper of a lighthouse begins lying to the sea.',
            'H2:Promise (v2) 74%',
            "P:A sealed cathedral of data holds the city's memory.",
            'H2:Tone (v4)',
            'P:Plain sentences, salt in every image.'
        ]);
        expect(Array.from(card.querySelectorAll('h2')).map((heading) => heading.textContent)).toEqual([
            'Premise (v7) 100%',
            'Promise (v2) 74%',
            'Tone (v4)'
        ]);
        // The marker is still gone from the whole pane, not just from the card.
        expect(document.querySelector('[data-testid="summary-overview"]')?.textContent).not.toContain('## ');
        // The card is still the one wrapper the pane's sizing rule addresses, so no markup moved.
        expect(card.className).toBe('sv-markdown sv-summary-text');
        // The numbers appear on the strip exactly as before — the heading ADDS a place to read them, it does not
        // move them, and the strip still carries the gap reasons and the `Revision N is newer` case.
        expect(reviewedRowTexts()).toEqual([
            'Premise reviewed Revision 7 Score 100%',
            'Promise reviewed Revision 2 Score 74%',
            'Tone reviewed Revision 4'
        ]);
    });

    it('decorates at render and leaves the wire text exactly as it arrived (AC2)', () => {
        const view = decoratedView(THREE_SECTIONS, [
            { id: 'grp-premise', key: 'premise', revision: 7, score: 100 },
            { id: 'grp-promise', key: 'promise', revision: 2, score: 74 },
            { id: 'grp-tone', key: 'tone', revision: 4, score: 88 }
        ]);

        // THE WIRE SIDE, asserted before any render: the stored text is the producer's bytes, heading and all.
        // Nothing in this feature can reach it — no new field, no rewritten `overview` — because Phrase ②'s Start
        // copies this text verbatim onto its Seed and hashes it, and D-65 refuses a Reader's number as content.
        expect(view.phrase?.reviewed.overview).toBe(THREE_SECTIONS);
        expect(reviewedSummaryText(view)).toBe(
            '## Premise\nA keeper of a lighthouse begins lying to the sea.\n\n' +
                "## Promise\nA sealed cathedral of data holds the city's memory.\n\n" +
                '## Tone\nPlain sentences, salt in every image.'
        );
        expect(reviewedSummaryText(view)).toContain('## Premise\n');
        expect(reviewedSummaryText(view)).not.toContain('(v7)');

        render(<SummaryOverviewPane view={view} />);

        // …and THE RENDERED SIDE, from the same fixture: the numbers are only ever on the card.
        expect(screen.getByTestId('summary-text').textContent).toContain('Premise (v7) 100%');
        expect(screen.getByTestId('summary-text').textContent).not.toContain('## Premise');
    });

    it('leaves a section no reviewed row names, and every `## ` inside a fenced block, exactly as written', () => {
        // THREE THINGS A NAIVE REPLACE WOULD BREAK. (1) `## Something the catalog never named` is a section of
        // the TEXT but not one of the book, so it renders as a heading with no numbers — matching is by exact
        // title against the rows, never by position. (2) A Writer can quote its own Overview back inside a
        // fence, and code is not a heading: that `## Premise` stays literal characters. (3) The body's own line
        // breaks are the writer's (`remark-breaks`) and the decoration must not disturb them.
        const overview = [
            '## Premise',
            'A keeper of a lighthouse',
            'begins lying to the sea.',
            '',
            '## Something the catalog never named',
            'A section no reviewed row addresses.',
            '',
            '```',
            '## Premise',
            'the Overview quoted back at the Author',
            '```',
            '',
            '## Tone',
            'Voice: spare',
            'POV: third'
        ].join('\n');

        const { container } = render(
            <SummaryOverviewPane
                view={decoratedView(overview, [
                    { id: 'grp-premise', key: 'premise', revision: 7, score: 100 },
                    { id: 'grp-tone', key: 'tone', revision: 4, score: 61 }
                ])}
            />
        );
        const card = screen.getByTestId('summary-text') as HTMLElement;

        // One `h2` per heading in the text — the decorated two, and the un-named one plain.
        expect(Array.from(card.querySelectorAll('h2')).map((heading) => heading.textContent)).toEqual([
            'Premise (v7) 100%',
            'Something the catalog never named',
            'Tone (v4) 61%'
        ]);
        // The fenced copy stays source: `## Premise` is CODE there, and it is the only place on the card the
        // marker still shows. (A fixture with a fence therefore cannot reuse the pane's `not.toContain('## ')`
        // pin — the pin is about the rendered prose, which is what the `h2` list above asserts.)
        expect(card.querySelector('pre code')?.textContent).toBe('## Premise\nthe Overview quoted back at the Author\n');
        // The decoration survives `remark-breaks`: the heading is still ONE heading element (a break inside it
        // would have split it), and each body keeps its own line breaks in its own paragraph.
        const paragraphs = Array.from(card.querySelectorAll('p'));

        expect(paragraphs).toHaveLength(3);
        expect(paragraphs[0]!.innerHTML).toBe('A keeper of a lighthouse<br>\nbegins lying to the sea.');
        expect(paragraphs[1]!.innerHTML).toBe('A section no reviewed row addresses.');
        expect(paragraphs[2]!.innerHTML).toBe('Voice: spare<br>\nPOV: third');
        // Nothing in the fenced block became a heading: three `h2`, and no `h2` inside the `<pre>`.
        expect(card.querySelectorAll('pre h2')).toHaveLength(0);
        expect(container.querySelector('[data-testid="summary-text"]')).toBe(card);
    });

    it('leaves a section the choice names no revision and no score exactly as `## <title>`', () => {
        // D-68's `chosen` book is where BOTH numbers are genuinely absent at once: the choice record carries
        // `vector` and `scores` per group, and a group it does not name answers neither. The rule writes no
        // suffix then — and the heading is still a heading, because the producer's `##` is unchanged.
        const overview = composePhraseContent([
            { key: 'premise', title: 'Premise', content: 'A keeper pays the tide to cross.' },
            { key: 'theme', title: 'Theme', content: 'The ledger is the debt.' }
        ]);

        render(
            <SummaryOverviewPane
                view={decoratedView(
                    overview,
                    // The live selection's rows still exist in the `chosen` frame; the pane reads the numbers
                    // off the CHOICE, which is what makes Tone answer neither.
                    [
                        { id: 'grp-premise', key: 'premise', revision: 7, score: 100 },
                        { id: 'grp-theme', key: 'theme', revision: 7, score: 100 }
                    ],
                    [
                        { id: 'grp-premise', key: 'premise', revision: 3, score: 76 },
                        { id: 'grp-theme', key: 'theme', revision: null }
                    ]
                )}
            />
        );

        expect(summaryBlocks()).toEqual([
            'H2:Premise (v3) 76%',
            'P:A keeper pays the tide to cross.',
            'H2:Theme',
            'P:The ledger is the debt.'
        ]);
        // The numbers come from the CHOICE, not from the live selection: `v3 76%`, never `v7 100%`.
        expect(screen.getByTestId('reviewed-state').textContent).toBe('reviewed Summary chosen');
    });

    it('prints no markdown wrapper at all when the reviewed Overview is empty, decorated or not', () => {
        // The empty branch is untouched by T14: `summary-text` appears only over text that exists (D-67), and a
        // decoration of `''` is still `''`, so no empty card can pad the pane.
        const { container } = render(
            <SummaryOverviewPane
                view={groupedView({
                    overview: '',
                    reviewed: reviewedBlock({
                        state: 'ready',
                        complete: true,
                        vector_hash: 'vh-t14-empty',
                        overview: '',
                        groups: [reviewedGroup({ id: 'grp-premise', key: 'premise', selected_revision: 7, scores: [vectorScore(100)] })]
                    })
                })}
            />
        );

        expect(screen.getByTestId('summary-empty').textContent).toBe(
            'No reviewed Overview yet — the selection has no composed text to show.'
        );
        expect(screen.queryByTestId('summary-text')).toBeNull();
        expect(container.querySelectorAll('.sv-markdown')).toHaveLength(0);
    });
});
