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
import { orderedPhraseGroupDefinitions } from '../../shared/phrase';
import type { PhraseFindingRow, PhraseView } from '../api';

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

    it('counts the open findings per group and says which of them hold the sign-off (U2)', () => {
        const { container } = render(<SummaryOverviewPane view={midReviewView()} />);

        const findingsLine = (key: string): string | null =>
            container.querySelector(`[data-testid="summary-group-${key}-findings"]`)?.textContent ?? null;

        // The counts are the derivations', not the pane's: Premise is named only by the unscoped major
        // (1 open, and it is blocking); Promise is named by the critical, the minor note and the unscoped
        // major (3 open, 2 of them blocking); Theme by the critical and the unscoped major; Tone and
        // Ending by the unscoped major alone — including Ending, because an UNSCOPED finding is a statement
        // about the whole Overview, so it aims at a group that has no text yet (R3).
        expect(findingsLine('premise')).toBe('1 open finding · holds the sign-off');
        expect(findingsLine('promise')).toBe('3 open findings · holds the sign-off');
        expect(findingsLine('theme')).toBe('2 open findings · holds the sign-off');
        expect(findingsLine('tone')).toBe('1 open finding · holds the sign-off');
        expect(findingsLine('ending')).toBe('1 open finding · holds the sign-off');
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
        expect(screen.getByTestId('summary-review').textContent).toBe(
            '3 open findings · 2 holding the sign-off · 2 open tasks'
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

        render(<SummaryOverviewPane view={view} />);

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
        expect(screen.getByTestId('summary-written').textContent).toBe('0 of 5 groups written');
    });

    it('has a purposeful empty state and keeps all five rows when the Overview is empty (U4)', () => {
        // The rows survive the empty Overview: an unwritten group is a fact about the book, and the
        // Author's next move is one of those five panes.
        const { container } = render(<SummaryOverviewPane view={groupedView({ overview: '' })} />);

        expect(container.querySelectorAll('.sv-group-row')).toHaveLength(5);
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
        expect(row.textContent).toBe('Promise blocking 3 open findings · holds the sign-off');
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

describe('SummaryOverviewPane — only the reviewed version is the Summary (D-67)', () => {
    it('prints the reviewed Overview as THE Summary, and the live composed text nowhere', () => {
        const phrase = reviewedPhraseView('s1', 'ready');
        const { container } = render(<SummaryOverviewPane view={reviewedView('ready')} />);
        const text = String(container.textContent);

        // The printed text is `reviewed.overview`: the four groups the Writer installed (which ARE the
        // selected rows) plus the CLEAN Ending — not the Ending the live Overview carries.
        expect(screen.getByTestId('summary-text').textContent).toBe(
            [
                'Premise — the text the Writer installed (group 1).',
                'Promise — the text the Writer installed (group 2).',
                'Theme — the text the Writer installed (group 3).',
                'Tone — the text the Writer installed (group 4).',
                'Ending — the clean text the Reviewers passed at Revision 2.'
            ].join('\n\n')
        );
        // The live Overview is absent, whole and in part: the pane does not print it, does not print it
        // "smaller" under a label, and does not print its Ending line at all.
        expect(phrase.overview).toContain('Ending — the newest text the Writer installed');
        expect(text).not.toContain('Ending — the newest text the Writer installed');
        expect(text).not.toContain(phrase.overview);
        expect(screen.queryAllByTestId('summary-live-text')).toHaveLength(0);
        expect(screen.getByTestId('reviewed-state').textContent).toBe('reviewed Summary ready');
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
        // because there is nothing to choose.
        expect(screen.queryByTestId('summary-text')).toBeNull();
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
        expect(screen.getByTestId('summary-text').textContent).toBe(
            [
                'Premise — the text the Author chose.',
                'Promise — the text the Author chose.',
                'Theme — the text the Author chose.',
                'Tone — the text the Author chose.',
                'Ending — the text the Author chose.'
            ].join('\n\n')
        );
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
