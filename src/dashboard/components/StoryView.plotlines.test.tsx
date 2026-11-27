// T-W4 — the content column's routing between the TWO Plotlines surfaces, and the handoff's one home.
//
// `StoryView.groups.test.tsx` pins the Summary half of the routing; this file pins the half Phrase ② added, where
// a wrong answer is invisible in any one screenshot:
//
//   1. WHICH Plotlines pane the panel opens is the Setting's answer (`isPlotlinesGroups`: the phrase read's
//      `mode`, else `story.plotlines_mode`) — never a count of rows, so a slow read cannot flip a classic book
//      onto the chapter-entry surface mid-frame, and a grouped book is never shown the §4.3 records its loop
//      did not write;
//   2. the entry the rail's `plotlines-group:<uuid>` ref opens is that entry, resolved by id;
//   3. the handoff card lives on the MAIN Summary item and on no group or revision pane — the text it copies IS
//      the Summary, and a second copy of the verb under a group would be two buttons for one decision;
//   4. the numbering the Author reads matches the rail's: Chapters is Phrase 3, and Characters — off the
//      numbered rail — carries no number at all.
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { StoryView } from './StoryView';
import { fixtureActions, fixturePhrase, fixtureView, NOW, SEED_IDEA } from '../testing/story-fixtures';
import { phraseDetailView } from '../testing/shell-fakes';
import type { PhraseDetailView } from '../api';
import type { StoryViewData } from './story-contract';
// U-25 — the Seed row's ref, imported rather than spelled: the routing test must send the token the rail sends.
import { phraseSeedRef } from './story-nav';
import type { StorySelection } from './story-nav';

/**
 * The grouped book Phrase ② is written into: `plotlines_mode` on both the row and the view (the projection
 * echoes the dial), the two projected flags the handoff reads, and the phrase read the entries come from.
 */
function phraseTwoView(
    over: {
        mode?: 'groups' | 'classic';
        started?: boolean;
        compiled?: boolean;
        detail?: PhraseDetailView | null;
    } = {}
): StoryViewData {
    const view = fixtureView({ phrase: fixturePhrase() });

    return {
        ...view,
        plotlines_mode: over.mode ?? 'groups',
        phrase_started: { summary: true, plotlines: over.started === true },
        summary_compiled: over.compiled === true,
        story: {
            ...view.story,
            plotlines_mode: over.mode ?? 'groups',
            phase: 'summary' as const,
            summary_locked: false,
            status: 'ready' as const,
            pending_kind: 'none' as const
        },
        ...(over.detail === undefined || over.detail === null
            ? {}
            : { phraseDetail: over.detail })
    };
}

function renderView(selection: StorySelection, view: StoryViewData = phraseTwoView()) {
    const harness = fixtureActions();

    return {
        ...harness,
        ...render(<StoryView view={view} actions={harness.actions} now={NOW} selection={selection} />)
    };
}

describe('StoryView — the Plotlines panel opens the surface the Setting chose (D-33)', () => {
    it('opens the chapter entries for a grouped book, with the brief and one row per entry', () => {
        const { container } = renderView(
            { panel: 'plotlines' },
            phraseTwoView({ started: true, compiled: true, detail: phraseDetailView('s1') })
        );

        expect(screen.getByTestId('plotlines-overview')).toBeTruthy();
        // The list is addressed by its test id (the shared rows component carries no DOM id).
        expect(container.querySelectorAll('[data-testid="plotlines-group-rows"] .sv-group-row')).toHaveLength(3);
        // The §4.3 records pane is absent, and so is its badge: a grouped book's loop never wrote those rows,
        // and showing them beside the entries would be two Plotlines lists on one screen.
        expect(container.querySelector('section.sv-plotlines')).toBeNull();
        expect(screen.queryByText('the §4.3 contracts the plotline tools write, one per chapter, measured against the Summary')).toBeNull();
    });

    it('opens the chapter entry the rail’s ref addresses, by its id', () => {
        const { container } = renderView(
            { panel: 'plotlines', ref: 'plotlines-group:entry-chapter_2' },
            phraseTwoView({ started: true, compiled: true, detail: phraseDetailView('s1') })
        );

        expect(container.querySelector('[data-testid="plotlines-pane-chapter_2"]')).toBeTruthy();
        expect(container.querySelector('[data-testid="plotlines-pane-chapter_1"]')).toBeNull();
        expect(container.querySelector('[data-testid="plotlines-overview"]')).toBeNull();
        expect(screen.getByTestId('group-title').textContent).toBe('Chapter 2 — The Salt Road');
    });

    it('keeps the §4.3 records for a classic book, with none of the phrase furniture', () => {
        // A book whose dial never moved: `PlotlinesPane`, its rows, and no chapter-entry surface at all — even
        // though the phrase read has not landed to say so either way.
        const { container } = renderView({ panel: 'plotlines' }, phraseTwoView({ mode: 'classic' }));

        expect(container.querySelector('section.sv-plotlines')).toBeTruthy();
        expect(container.querySelectorAll('.plot-list .sv-plotline, .plot-list > *').length).toBeGreaterThan(0);
        expect(container.querySelector('[data-testid="plotlines-overview"]')).toBeNull();
        expect(container.querySelector('[data-testid="plotlines-brief"]')).toBeNull();
    });

    it('refuses to guess the surface from a row count while the read is coming', () => {
        // The dial says `groups`, the rows have not arrived: the pane owns the loading line, and the classic
        // records must NOT appear in the frame the read has not answered yet.
        const { container } = renderView({ panel: 'plotlines' }, phraseTwoView({ detail: null }));

        expect(container.querySelector('section.sv-plotlines')).toBeNull();
        expect(screen.getByTestId('plotlines-overview-pending').textContent).toBe(
            'This Plotlines phrase is written as chapter entries. The brief and the entry rows arrive with the phrase read.'
        );
    });
});

describe('StoryView — the handoff has one home: the main Summary item (R5)', () => {
    it('renders the card under the Overview, and not under a group or a revision', () => {
        // The compiled flag is what enables the button, so this case names it: the default fixture's Summary is
        // not compiled, and a card over it would be shut (the other test in this file pins that state).
        const main = renderView({ panel: 'summary' }, phraseTwoView({ compiled: true }));

        expect(screen.getByTestId('plotlines-handoff')).toBeTruthy();
        expect(main.getByTestId('plotlines-handoff-compiled').hasAttribute('disabled')).toBe(false);
        main.unmount();

        // A group pane: the gate that decides the card is the same one the phase controls use, and a group ref
        // fails it — one verb, one place.
        const group = renderView(
            { panel: 'summary', ref: 'summary-group:grp-premise' },
            phraseTwoView({ compiled: true })
        );

        expect(group.container.querySelector('[data-testid="plotlines-handoff"]')).toBeNull();
        group.unmount();

        // The receipt after the start, in the same place, so the Author who pressed there sees what was copied.
        const started = renderView(
            { panel: 'summary' },
            phraseTwoView({ started: true, compiled: true, detail: phraseDetailView('s1') })
        );

        expect(started.getByTestId('plotlines-handoff-started').textContent).toBe('started');
        expect(started.container.querySelector('[data-testid="plotlines-handoff-compiled"]')).toBeNull();
    });

    it('is absent from every other pane, including Phrase ②’s own', () => {
        const plotlines = renderView(
            { panel: 'plotlines' },
            phraseTwoView({ started: true, compiled: true, detail: phraseDetailView('s1') })
        );

        expect(plotlines.container.querySelector('[data-testid="plotlines-handoff"]')).toBeNull();
        plotlines.unmount();

        const settings = renderView({ panel: 'settings' });

        expect(settings.container.querySelector('[data-testid="plotlines-handoff"]')).toBeNull();
    });
});

describe('StoryView — the headings the rail’s numbering has to agree with (T-W4)', () => {
    it('calls Chapters Phrase 3, because Phrase 2 is now Plotlines', () => {
        renderView({ panel: 'chapters' });

        expect(screen.getByText('Chapters — Phrase 3')).toBeTruthy();
        expect(screen.queryByText('Chapters — Phrase 3 · ')).toBeNull();
    });

    it('gives Characters no phrase number at all', () => {
        renderView({ panel: 'characters' });

        const title = screen.getByText('Characters');

        expect(title.classList.contains('sv-pane-title')).toBe(true);
        // The claim T-W4 retires: a number beside the cast sheet says the loop signs off a Characters phase.
        expect(title.textContent).toBe('Characters');
        expect(document.body.textContent).not.toContain('Phrase 2 — Characters');
    });

    it('opens the chapter entries from the rail without renumbering the Summary above them', () => {
        const { container } = renderView(
            { panel: 'plotlines' },
            phraseTwoView({ started: true, compiled: true, detail: phraseDetailView('s1') })
        );

        // The Summary pane is not mounted on this selection, so nothing here may print its phrase number twice.
        expect(container.querySelector('[data-testid="summary-overview"]')).toBeNull();
        expect(screen.getByTestId('plotlines-brief')).toBeTruthy();
    });
});

// U-25 — THE PHRASE'S SEED ROW HAS A PANE OF ITS OWN, INSIDE ITS PHRASE. `{panel:'plotlines', ref: phraseSeedRef()}`
// is the selection the rail's Seed row emits, and `story-nav.selectionExists` accepts it; if it did not, the stale-ref
// guard at the top of `StoryView` would drop the ref and this render would land on the Plotlines Overview instead —
// a UI no-op that no pane suite would notice. So the routing is pinned here, on both pipelines, and for the one
// selection shape that has no rail row yet (Phrase ③).
describe('StoryView — a phrase’s Seed row opens that phrase’s Seed pane (U-25)', () => {
    it('replaces the Phrase ② surface with its Seed pane, on the grouped pipeline', () => {
        const { container } = renderView(
            { panel: 'plotlines', ref: phraseSeedRef() },
            phraseTwoView({ started: true, compiled: true, detail: phraseDetailView('s1') })
        );

        expect(screen.getByTestId('phrase-seed-pane')).toBeTruthy();
        // The phrase's own surfaces are gone: the Seed leaf is not the phrase's Overview, and the phase-level
        // controls describe the phrase's output, so none of them ride this pane (the same rule `revisionFocus` and
        // `groupFocus` encode for Phrase ①).
        expect(screen.queryByTestId('plotlines-overview')).toBeNull();
        expect(container.querySelector('[data-testid="plotlines-group-rows"]')).toBeNull();
        expect(container.querySelector('.sv-phase-controls')).toBeNull();
        // The handoff stays on the main Summary item, where the text it copies is on screen (T-W4).
        expect(container.querySelector('[data-testid="plotlines-handoff"]')).toBeNull();
        // What IS printed is the phrase's copied text — and not the Author's idea standing in for it.
        expect(screen.getByTestId('phrase-seed-head').textContent).toBe(
            'A smuggler pays the tide to cross the salt road, and the road collects.'
        );
        expect(container.textContent).not.toContain(SEED_IDEA);
    });

    it('routes the Seed on the classic pipeline too, where the phrase has no entry rows at all', () => {
        const { container } = renderView(
            { panel: 'plotlines', ref: phraseSeedRef() },
            phraseTwoView({ mode: 'classic', started: true, compiled: true })
        );

        expect(screen.getByTestId('phrase-seed-pane')).toBeTruthy();
        // The §4.3 records pane is the phrase's surface, not the Seed's: a classic book gets its Seed one click
        // away, and the two never share the column.
        expect(container.querySelector('section.sv-plotlines')).toBeNull();
    });

    it('says no Seed read is coming, for a started Phrase ② on the classic dial (U-25)', () => {
        // THE STATE THAT WAS A DEFECT. `state.ts:phraseDetailWanted` asks for the Phrase ② read only while the
        // Story's dial is on `groups` (or the read is already cached in the session), so on a classic book
        // `view.phraseDetail` is `undefined` FOR GOOD — the phrase started, and its copied text will never arrive in
        // the frame. The pane used to print its one "on its way" line for every absent read, which made the row the
        // Author clicked to read this phrase's Seed sit there saying `reading this phrase’s Seed…` forever.
        const { container } = renderView(
            { panel: 'plotlines', ref: phraseSeedRef() },
            phraseTwoView({ mode: 'classic', started: true, compiled: true })
        );

        expect(screen.getByTestId('phrase-seed-pane')).toBeTruthy();
        // No waiting wording — not as a node, and not anywhere in the text the Author reads.
        expect(screen.queryByTestId('phrase-seed-pending')).toBeNull();
        expect(container.textContent).not.toContain('reading this phrase’s Seed');
        // And no invented failure either: nothing failed here, the desk simply never requested the read.
        expect(screen.queryByTestId('phrase-seed-error')).toBeNull();
        // The honest state, worded off the same two projections the pane already reads: what the desk holds (the
        // Story row's `started` mark), what it does not (the read carrying `seed_head`/`seed_chars`), and the fact
        // that this is a permanent state of the pipeline rather than a wait.
        expect(screen.getByTestId('phrase-seed-no-read').textContent).toBe(
            'This phrase started on the classic Plotlines pipeline: the desk reads a phrase’s copied Seed from that phrase’s chapter-entry read (U-20), and this dial never asks for it, so the text the Start copied stays on the server. The started mark above is the Story row’s, not a read’s, and nothing here is waiting.'
        );
        // Routing still holds in this frame: the Seed pane is the column, the phrase's records are not, and the
        // absent read never becomes an excuse to print Phrase ①'s idea (the defect U-25 retires).
        expect(container.querySelector('section.sv-plotlines')).toBeNull();
        expect(container.textContent).not.toContain(SEED_IDEA);
    });

    it('offers the Start choice from the Seed pane while the phrase has not started', () => {
        const { container } = renderView(
            { panel: 'plotlines', ref: phraseSeedRef() },
            phraseTwoView({ started: false, compiled: true })
        );

        expect(screen.getByTestId('phrase-seed-compiled')).toBeTruthy();
        expect(screen.getByTestId('phrase-seed-custom-open')).toBeTruthy();
        // The paste arm is one click away, not on screen by default — the compiled path stays the one-press route.
        expect(container.querySelector('textarea')).toBeNull();
        expect(screen.getByTestId('phrase-seed-note').textContent).toContain('has no Seed yet');
    });

    it('leaves the cast sheet alone, because Characters has no Seed row to open', () => {
        const { container } = renderView({ panel: 'characters', ref: phraseSeedRef() });

        // A ref the sheet cannot resolve falls back to the sheet rather than blanking the column, and the Seed pane
        // is NOT mounted for a panel the rail never offers the row on.
        expect(screen.queryByTestId('phrase-seed-pane')).toBeNull();
        expect(container.querySelector('.sv-pane')).toBeTruthy();
    });
});
