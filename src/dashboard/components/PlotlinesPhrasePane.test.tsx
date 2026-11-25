// T-W4 — Phrase ②'s surface: the phrase brief, the chapter-entry rows, and ONE entry's contract write.
//
// The rows and the entry pane are the SHARED phrase components (`PhraseEntries.tsx`) driven by
// `PLOTLINE_SURFACE`, so this file does not re-pin the Summary's badges, scores or lock copy. What it pins is
// everything Phrase ② owns and no other file can:
//   1. the surface's own test-id namespace (`plotlines-entry-<key>` / `plotlines-pane-<key>`) and its refs
//      (`plotlines-group:<uuid>`) — the ids the rail and the store both address rows by;
//   2. the brief card's three states (no brief, drafted, accepted), which is the fact that decides whether the
//      entries exist at all;
//   3. the CONTRACT EDITOR: six fields that start empty, two of them required, and a body that carries the
//      optional fields ONLY when they say something (the route composes the entry's prose from them, so a blank
//      sent upstream would overwrite a contract the loop wrote);
//   4. the three read states (in flight / failed / not this model), which `phraseDetailReadLanded` tells apart —
//      "the read is slow" and "there are no entries" are different claims.
// The view handed to these panes is the PHRASE-SWAPPED one (`story-contract.plotlinesSurfaceView`, applied by
// `StoryView.tsx`), so the tests build it the same way and the swap itself is exercised here.
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PlotlinesEntryPane, PlotlinesOverviewPane } from './PlotlinesPhrasePane';
import { fixtureActions, fixturePhrase, fixtureView } from './story-fixtures';
import { plotlinesSurfaceView, type StoryViewData } from './story-contract';
import { phraseDetailView } from '../testing/shell-fakes';
import type { PhraseDetailView, PhraseGroupRow } from '../api';
import type { StorySelection } from './story-nav';

/**
 * A grouped book, viewed the way the panes see it: `phrase`/`phraseError` swapped over to Phrase ②'s read.
 * `detail: null` means the read FAILED (with `error` as the server's sentence); absent means it has not landed.
 */
function surfaceView(over: { mode?: 'groups' | 'classic'; detail?: PhraseDetailView | null; error?: string } = {}) {
    const view: StoryViewData = {
        ...fixtureView({ phrase: fixturePhrase() }),
        plotlines_mode: over.mode ?? 'groups',
        phrase_started: { summary: true, plotlines: true },
        summary_compiled: true,
        story: { ...fixtureView({ phrase: fixturePhrase() }).story, plotlines_mode: over.mode ?? 'groups' },
        ...(over.detail === undefined || over.detail === null
            ? over.error === undefined
                ? {}
                : { phraseDetailError: over.error }
            : { phraseDetail: over.detail })
    };

    return plotlinesSurfaceView(view);
}

/** The entry rows as (test id, name, state word, findings/quiet line) — the whole list, so a reorder fails. */
function rowLines(container: HTMLElement): Array<Array<string | null>> {
    return Array.from(container.querySelectorAll<HTMLElement>('[data-testid^="plotlines-entry-"]')).map((row) => [
        row.getAttribute('data-testid'),
        row.querySelector('.sv-group-row-name')?.textContent ?? null,
        row.querySelector('.sv-group-row-state')?.textContent ?? null,
        (row.querySelector('.sv-group-row-findings') ?? row.querySelector('.sv-group-row-quiet'))?.textContent ?? null
    ]);
}

/** The same read with the marks a mid-flight phrase carries: one writer-busy entry, one unwritten one. */
function mixedRead(): PhraseDetailView {
    const base = phraseDetailView('s1');

    return {
        ...base,
        groups: base.groups.map((row): PhraseGroupRow =>
            row.key === 'chapter_2'
                ? { ...row, writer_busy: true }
                : row.key === 'chapter_3'
                  ? { ...row, revision: 0, content: '', previous_content: '', history: [], writer_busy: false }
                  : row
        ),
        review: { ...base.review, written_groups: 2, unwritten_groups: ['entry-chapter_3'] }
    };
}

describe('PlotlinesOverviewPane — the chapter-entry rows (T-W4)', () => {
    it('lists one row per chapter entry in composition order, and navigates by the entry’s uuid', () => {
        const selections: StorySelection[] = [];
        const { container } = render(
            <PlotlinesOverviewPane
                view={surfaceView({ detail: phraseDetailView('s1') })}
                selection={{ panel: 'plotlines', ref: 'plotlines-group:entry-chapter_1' }}
                onSelect={(next) => selections.push(next)}
            />
        );

        // The rows live under the phrase's own list id, and each row is addressed by its KEY — the Summary's
        // pinned `summary-group-*` ids stay untouched because the namespace comes from the surface descriptor.
        expect(container.querySelector('[data-testid="plotlines-group-rows"]')).toBeTruthy();
        expect(rowLines(container)).toEqual([
            ['plotlines-entry-chapter_1', 'Chapter 1 — The Salt Road', 'clean', 'nothing superseded'],
            ['plotlines-entry-chapter_2', 'Chapter 2 — The Salt Road', 'clean', 'nothing superseded'],
            ['plotlines-entry-chapter_3', 'Chapter 3 — The Salt Road', 'clean', 'nothing superseded']
        ]);

        // R-T2/F4: the selected row says so in the accessibility tree, not only in ink.
        const first = screen.getByTestId('plotlines-entry-chapter_1');

        expect(first.getAttribute('data-selected')).toBe('true');
        expect(first.querySelector('button')?.getAttribute('aria-current')).toBe('true');
        expect(screen.getByTestId('plotlines-entry-chapter_2').getAttribute('data-selected')).toBeNull();

        fireEvent.click(screen.getByTestId('plotlines-entry-chapter_2').querySelector('button')!);

        expect(selections).toEqual([{ panel: 'plotlines', ref: 'plotlines-group:entry-chapter_2' }]);
    });

    it('states the state the wire reports per row — writer, to write, clean (R4)', () => {
        const { container } = render(<PlotlinesOverviewPane view={surfaceView({ detail: mixedRead() })} />);

        expect(rowLines(container)).toEqual([
            ['plotlines-entry-chapter_1', 'Chapter 1 — The Salt Road', 'clean', 'nothing superseded'],
            [
                'plotlines-entry-chapter_2',
                'Chapter 2 — The Salt Road',
                'writer',
                'nothing superseded'
            ],
            ['plotlines-entry-chapter_3', 'Chapter 3 — The Salt Road', 'to write', 'nothing written yet']
        ]);

        // The count in the header is the SERVER's (`review.written_groups`), not a count this pane took from the
        // rows: a row list that disagreed with the review block would be the bug this pin catches.
        expect(screen.getByTestId('plotlines-written').textContent).toBe('2 of 3 chapter entries written');
    });

    it('names the entries that still have no contract, and says nothing when all of them do', () => {
        const mixed = render(<PlotlinesOverviewPane view={surfaceView({ detail: mixedRead() })} />);

        expect(mixed.getByTestId('plotlines-unwritten').textContent).toBe(
            '1 of 3 chapter entries still have no contract: Chapter 3 — The Salt Road.'
        );
        mixed.unmount();

        const all = render(<PlotlinesOverviewPane view={surfaceView({ detail: phraseDetailView('s1') })} />);

        expect(all.container.querySelector('[data-testid="plotlines-unwritten"]')).toBeNull();
        expect(all.getByTestId('plotlines-written').textContent).toBe('3 of 3 chapter entries written');
    });

    it('says the brief has to be accepted when the phrase started with no entries (a real state, not a wait)', () => {
        const { container } = render(
            <PlotlinesOverviewPane
                view={surfaceView({
                    detail: phraseDetailView('s1', {
                        groups: [],
                        overview: '',
                        brief: { status: 'draft', chapter_count: 0 },
                        review: { ...phraseDetailView('s1').review, written_groups: 0, unwritten_groups: [] }
                    })
                })}
            />
        );

        expect(screen.getByTestId('plotlines-empty').textContent).toBe(
            'No chapter entries yet — the brief has to be accepted before the chapters exist.'
        );
        // There is no row list to draw and no pending line: the read answered, and it answered with nothing.
        expect(container.querySelector('[data-testid="plotlines-group-rows"]')).toBeNull();
        expect(container.querySelector('[data-testid="plotlines-overview-pending"]')).toBeNull();
        expect(screen.getByTestId('plotlines-written').textContent).toBe('0 of 0 chapter entries written');
    });
});

describe('PlotlinesOverviewPane — the phrase brief card', () => {
    it('accepts the three states of the wire’s brief field, and prints the accept stamp only when there is one', () => {
        const base = phraseDetailView('s1');

        // Accepted (the fixture's own state): the count rides the state word, because a count alone reads as a
        // verdict when the structure behind it is still a draft.
        const accepted = render(<PlotlinesOverviewPane view={surfaceView({ detail: base })} />);

        expect(accepted.getByTestId('plotlines-brief-state').textContent).toBe('brief accepted — 3 chapters');
        expect(accepted.getByTestId('plotlines-brief-state').getAttribute('data-tone')).toBe('ready');
        expect(accepted.getByTestId('plotlines-brief-accepted-at').textContent).toBe(
            'accepted 2026-11-09T10:00:00.000Z'
        );
        expect(accepted.getByTestId('plotlines-brief-note').textContent).toBe(
            'The chapter entries below were materialized from this brief, one per chapter it declares.'
        );
        accepted.unmount();

        // Drafted: no accept stamp exists, so the paragraph is absent rather than blank.
        const drafted = render(
            <PlotlinesOverviewPane
                view={surfaceView({ detail: phraseDetailView('s1', { brief: { status: 'draft', chapter_count: 4 } }) })}
            />
        );

        expect(drafted.getByTestId('plotlines-brief-state').textContent).toBe('brief drafted — 4 chapters');
        expect(drafted.getByTestId('plotlines-brief-state').getAttribute('data-tone')).toBe('pending');
        expect(drafted.container.querySelector('[data-testid="plotlines-brief-accepted-at"]')).toBeNull();
        expect(drafted.getByTestId('plotlines-brief-note').textContent).toBe(
            'The brief is drafted, not accepted, so the entries below carry its count without a clean verdict behind it.'
        );
        drafted.unmount();

        // No brief at all (`brief: null`): the pane prints the wire's null rather than inventing "0 chapters",
        // and names the verb that produces one (the directive bar).
        const none = render(
            <PlotlinesOverviewPane view={surfaceView({ detail: phraseDetailView('s1', { brief: null }) })} />
        );

        expect(none.getByTestId('plotlines-brief-state').textContent).toBe('no structure brief yet');
        expect(none.getByTestId('plotlines-brief-note').textContent).toBe(
            'Nobody has structured this phrase yet: the chapter entries are materialized from the brief the Editor writes, once its structure is accepted, and the directive bar is how you ask for that.'
        );
    });
});

describe('PlotlinesOverviewPane — the read’s three answers (U6, R-T2/F2)', () => {
    it('separates a read in flight from a read that failed from a book that is not on this model', () => {
        // In flight: the pane names what is arriving, and does not claim the entries are missing.
        const pending = render(<PlotlinesOverviewPane view={surfaceView({})} />);

        expect(pending.getByTestId('plotlines-overview-pending').textContent).toBe(
            'This Plotlines phrase is written as chapter entries. The brief and the entry rows arrive with the phrase read.'
        );
        pending.unmount();

        // Failed: the server's own sentence is printed verbatim, and the notice says the entries EXIST — a
        // failure line that read like an empty phrase would be a verdict about the book the route never made.
        const failed = render(
            <PlotlinesOverviewPane view={surfaceView({ detail: null, error: 'the gateway is not answering' })} />
        );

        expect(failed.getByTestId('plotlines-read-error').textContent).toBe(
            'The Plotlines chapter entries could not be read: the gateway is not answering'
        );
        expect(failed.getByTestId('plotlines-overview-error').textContent).toBe(
            'The Plotlines chapter entries could not be read: the gateway is not answering' +
                'This Story started Phrase 2 on the chapter-entry pipeline, so the entries exist — the read that lists their state failed. Nothing here is a verdict about the contracts; reload the Story to read the entries again.'
        );
        failed.unmount();

        // Not this model: the classic dial answers even before the read lands, and the pane points at the records.
        const legacy = render(<PlotlinesOverviewPane view={surfaceView({ mode: 'classic' })} />);

        expect(legacy.getByTestId('plotlines-overview-legacy').textContent).toBe(
            "This Story's Plotlines are still written by the classic plotline tools, so it has no chapter entries. The records are the Plotlines pane."
        );
        expect(legacy.container.querySelector('[data-testid="plotlines-group-rows"]')).toBeNull();
    });
});

describe('PlotlinesEntryPane — the contract write (T-W4)', () => {
    /** The pane with one entry open, exactly as the rail's ref addresses it. */
    function entryPane(
        over: {
            mode?: 'groups' | 'classic';
            detail?: PhraseDetailView | null;
            error?: string;
            ref?: string;
            actions?: boolean;
        } = {}
    ) {
        const harness = fixtureActions();
        // `detail: null` is the FAILED read; the pane's own `phrase` slot is then empty, and the cached sentence
        // (`phraseDetailError`, swapped in by `plotlinesSurfaceView`) is what tells the pane that.
        const detail = over.detail === null ? undefined : (over.detail ?? phraseDetailView('s1'));
        const selections: StorySelection[] = [];

        const rendered = render(
            <PlotlinesEntryPane
                view={surfaceView({
                    mode: over.mode ?? 'groups',
                    detail,
                    ...(over.error === undefined ? {} : { error: over.error })
                })}
                actions={over.actions === false ? {} : harness.actions}
                selection={{ panel: 'plotlines', ref: over.ref ?? 'plotlines-group:entry-chapter_1' }}
                onSelect={(next) => selections.push(next)}
            />
        );

        return { ...rendered, ...harness, selections };
    }

    it('opens the entry the ref addresses, with six empty contract fields (R-T2/F6)', () => {
        const { container } = entryPane();

        expect(container.querySelector('[data-testid="plotlines-pane-chapter_1"]')).toBeTruthy();
        expect(screen.getByTestId('group-title').textContent).toBe('Chapter 1 — The Salt Road');
        // The prose region is the RECORD the server composed from the fields; the fields below are the write.
        expect(screen.getByTestId('group-content').textContent).toContain('Must happen: the crossing is attempted.');
        // There is no prose textarea on this surface at all: editing the composition would be editing a rendering.
        expect(container.querySelector('textarea')).toBeNull();

        expect(
            Array.from(container.querySelectorAll<HTMLElement>('[data-testid^="group-plotpoint-"]')).map((field) => [
                field.getAttribute('data-testid'),
                field.querySelector('.sv-group-plotpoint-label')?.textContent,
                (field.querySelector('input') as HTMLInputElement).value
            ])
        ).toEqual([
            ['group-plotpoint-heading', 'Heading', ''],
            ['group-plotpoint-must_happen', 'Must happen (C-7) *', ''],
            ['group-plotpoint-must_change', 'Must change (C-8) *', ''],
            ['group-plotpoint-pov', 'POV', ''],
            ['group-plotpoint-setups', 'Setups (C-5)', ''],
            ['group-plotpoint-payoffs', 'Payoffs (C-5)', '']
        ]);

        // The two required fields say so in their own `title`, which is where the route's 400 becomes a decision
        // the Author can make before clicking (U-16).
        expect(
            (screen.getByTestId('group-plotpoint-must_happen').querySelector('input') as HTMLInputElement).title
        ).toBe('What this chapter has to put on the page. The route refuses an entry without it.');

        // The write starts shut, and says which two fields are missing.
        const submit = screen.getByTestId('group-revise-submit');

        expect(submit.hasAttribute('disabled')).toBe(true);
        expect(submit.textContent).toBe('Revise this chapter entry');
        expect(submit.getAttribute('title')).toBe(
            "Write Must happen and Must change first — the route composes the entry's text and its plotlines contract from those two together, and refuses an entry without them (P4)."
        );
    });

    it('sends the two required fields and nothing else, addressed by the entry uuid', () => {
        const { calls } = entryPane();

        fireEvent.change(screen.getByLabelText('Must happen (C-7) for Chapter 1 — The Salt Road'), {
            target: { value: '  the crossing is attempted, and the toll is refused  ' }
        });
        fireEvent.change(screen.getByLabelText('Must change (C-8) for Chapter 1 — The Salt Road'), {
            target: { value: 'the mentor stops paying for the road' }
        });

        const submit = screen.getByTestId('group-revise-submit');

        expect(submit.hasAttribute('disabled')).toBe(false);
        expect(submit.textContent).toBe('Send this contract');
        expect(submit.getAttribute('title')).toBe('Send this contract to the chapter entry as a new revision (R2).');

        fireEvent.click(submit);

        // `(storyId, entryId, body)` with the uuid, never the row's position. Only the two required fields travel:
        // an empty optional would overwrite a contract line the loop wrote with a blank.
        expect(calls.revisePhraseEntry).toEqual([
            [
                's1',
                'entry-chapter_1',
                {
                    plotpoints: {
                        must_happen: 'the crossing is attempted, and the toll is refused',
                        must_change: 'the mentor stops paying for the road'
                    }
                }
            ]
        ]);
        // The draft is dropped on send: the next thing on screen is the server's answer, not a half-remembered
        // request (P1), and the button goes back to its shut state.
        expect(
            (screen.getByTestId('group-plotpoint-must_happen').querySelector('input') as HTMLInputElement).value
        ).toBe('');
        expect(screen.getByTestId('group-revise-submit').hasAttribute('disabled')).toBe(true);
    });

    it('sends an optional field only when it says something, and a note only when there is one', () => {
        const { calls } = entryPane();

        fireEvent.change(screen.getByLabelText('Heading for Chapter 1 — The Salt Road'), {
            target: { value: 'The Salt Road' }
        });
        fireEvent.change(screen.getByLabelText('Must happen (C-7) for Chapter 1 — The Salt Road'), {
            target: { value: 'the toll is refused' }
        });
        fireEvent.change(screen.getByLabelText('Must change (C-8) for Chapter 1 — The Salt Road'), {
            target: { value: 'the road collects' }
        });
        fireEvent.change(screen.getByLabelText('POV for Chapter 1 — The Salt Road'), { target: { value: 'Hale' } });
        fireEvent.change(screen.getByLabelText('Note for the Editor'), {
            target: { value: '   make the toll concrete   ' }
        });

        fireEvent.click(screen.getByTestId('group-revise-submit'));

        // `setups` and `payoffs` stayed blank and are ABSENT from the body — the same rule
        // `plotpointsFromBody` applies server-side, mirrored so the client never sends a blank to drop.
        expect(calls.revisePhraseEntry).toEqual([
            [
                's1',
                'entry-chapter_1',
                {
                    plotpoints: {
                        must_happen: 'the toll is refused',
                        must_change: 'the road collects',
                        heading: 'The Salt Road',
                        pov: 'Hale'
                    },
                    note: 'make the toll concrete'
                }
            ]
        ]);
        // The note is dropped with the fields, so a second write starts from the record (P1). Read off the DOM
        // property rather than a matcher this package does not install.
        expect((screen.getByLabelText('Note for the Editor') as HTMLInputElement).value).toBe('');
    });

    it('refuses the write while the Writer holds the entry, and while the entry is locked (R4, R1)', () => {
        const busy = phraseDetailView('s1', {
            groups: phraseDetailView('s1').groups.map((row) =>
                row.key === 'chapter_1' ? { ...row, writer_busy: true } : row
            )
        });
        const busyPane = entryPane({ detail: busy });

        expect(screen.getByTestId('group-revise-submit').getAttribute('title')).toBe(
            'The Writer is rewriting this chapter entry right now — the revise route refuses the write until it lands (R4).'
        );
        // Reading stays open: the row is a row, and only editing it waits (U5).
        expect(
            (screen.getByTestId('group-plotpoint-must_happen').querySelector('input') as HTMLInputElement).disabled
        ).toBe(true);
        busyPane.unmount();

        const locked = phraseDetailView('s1', {
            groups: phraseDetailView('s1').groups.map((row) =>
                row.key === 'chapter_1'
                    ? { ...row, locked: true, locked_by: 'author', locked_revision: 1 }
                    : row
            )
        });

        entryPane({ detail: locked });

        // The edit block is shut rather than hidden, and says what to do instead (R1).
        expect(screen.getByTestId('group-revise-locked').textContent).toBe(
            'Locked content is settled and cannot be revised (R1). Unlock Chapter 1 — The Salt Road to write the next revision.'
        );
        expect(screen.getByTestId('group-revise-submit').getAttribute('title')).toBe(
            'Chapter 1 — The Salt Road is locked in — locked content is settled and cannot be revised (R1). Unlock it first to write a new revision.'
        );
    });

    it('names a ref that no longer addresses an entry, and offers the phrase instead of an empty pane (U6)', () => {
        const { selections } = entryPane({ ref: 'plotlines-group:retired' });

        // The LINE, not the card: the card also holds the button that offers the way out, and pinning the card
        // would fold the button's label into the sentence.
        expect(screen.getByTestId('plotlines-pane-stale').querySelector('.pane-state')?.textContent).toBe(
            'This chapter entry is no longer part of the phrase.'
        );

        fireEvent.click(screen.getByText('Open Plotlines'));

        expect(selections).toEqual([{ panel: 'plotlines' }]);
    });

    it('separates a slow read from a failed one in the entry pane, under its own ids (R-T2/F2)', () => {
        // Failed: the store cached the route's sentence, and the pane prints it under Phrase ②'s ids rather
        // than the Summary's (`plotlines-pane-error`, not `group-pane-error`).
        const failed = entryPane({ detail: null, error: 'the gateway is not answering' });

        expect(failed.getByTestId('plotlines-pane-error').querySelector('.pane-state')?.textContent).toBe(
            'The Plotlines chapter entries could not be read: the gateway is not answering'
        );
        failed.unmount();

        // In flight: no sentence, so the pane waits out loud instead of claiming the entry is missing.
        const pending = entryPane({ detail: null });

        expect(pending.getByTestId('plotlines-pane-pending').textContent).toBe(
            'This Plotlines phrase is written as chapter entries. Their contracts arrive with the phrase read.'
        );
    });

    it('refuses to render an entry over a classic book, where no entries exist (D-33)', () => {
        // The read's own `mode` answers FIRST (it is the phrase's dial), and the Story row answers when the read
        // has not landed — both readings have to reach the same legacy line, or a slow route would paint
        // "no chapter entries" over a book the classic tools own.
        const fromRead = entryPane({ detail: phraseDetailView('s1', { mode: 'classic' }) });

        expect(fromRead.getByTestId('plotlines-pane-legacy').textContent).toBe(
            "This Story's Plotlines are still written by the classic plotline tools, so it has no chapter entries to open."
        );
        fromRead.unmount();

        const fromRow = entryPane({ mode: 'classic', detail: null });

        expect(fromRow.getByTestId('plotlines-pane-legacy').textContent).toBe(
            "This Story's Plotlines are still written by the classic plotline tools, so it has no chapter entries to open."
        );
    });

    it('says so when the shell has no revise verb bound (U-16)', () => {
        entryPane({ actions: false });

        expect(screen.getByTestId('group-revise-submit').getAttribute('title')).toBe(
            'The chapter entry revise route is not available in this shell.'
        );
    });
});
