// R6 / U2 + U3 — the grouped Summary's OVERVIEW pane.
//
// What is pinned here is the surface the rail's Summary header opens on a group-managed book:
//   U2 — the compiled Overview, plus one honest row per group carrying that group's state and findings.
//   U3 — what the sampling instrument panel used to hold is GONE: no dials, no candidate cards, no
//        pick/merge/serve verbs, no reader-seat count, no `Request another revision round`.
//   R1 — the five rows come from `shared/phrase`'s own catalog, so `World rules` (a Summary SECTION,
//        never a group) can never appear as a sixth row.
//   U4 — the empty Overview states why it is empty and what would fill it.
//   U6 — the phrase read is a separate route, so "not loaded yet" is its own line, never five rows.
//
// Every expected string below is derived from the fixture the test builds, not from a screenshot of the
// pane: `fixturePhrase()` documents the state it models (Premise written twice, Promise under review,
// Theme held by the Writer, Tone the target of the unscoped finding, Ending unwritten), and each
// assertion says exactly what that state has to read as.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { SummaryOverviewPane } from './SummaryOverviewPane';
import { fixturePhrase, fixtureView } from './story-fixtures';
import { summaryGroupRef } from './story-nav';
import { groupedPhraseView } from '../testing/shell-fakes';
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
    it('prints the Overview the server composed from the written groups, untouched', () => {
        render(<SummaryOverviewPane view={midReviewView()} />);

        // The pane composes nothing: it prints `phrase.overview`, which is the written groups joined by a
        // blank line — Ending has no content, so it is NOT in the string (R1).
        expect(screen.getByTestId('summary-text').textContent).toBe(
            [
                'A keeper of a lighthouse begins lying to the sea, and the sea believes her.',
                'The reader is promised that the lie will cost her the light itself.',
                'What the book is about: the price of a story told to keep the dark out.',
                'Plain sentences, salt in every image, and no authorial wink.'
            ].join('\n\n')
        );
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
        // And nothing here pretends to open one: the five row buttons are the pane's only controls.
        expect(container.querySelectorAll('button')).toHaveLength(5);
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
        // shell-fakes suite pins.
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
            }
        });

        render(<SummaryOverviewPane view={view} />);

        expect(screen.getByTestId('summary-empty').textContent).toBe(
            'No Overview yet — 5 of 5 groups have no content for the system to compile.'
        );
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
            'Readers per draft',
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
