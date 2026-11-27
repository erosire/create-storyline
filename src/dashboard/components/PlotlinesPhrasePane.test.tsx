// T-W4 — Phrase ②'s surface: the phrase brief, the chapter-entry rows, and ONE entry's contract write.
//
// The rows and the entry pane are the SHARED phrase components (`PhraseEntries.tsx`) driven by
// `PLOTLINE_SURFACE`, so this file does not re-pin the Summary's badges, scores or lock copy. What it pins is
// everything Phrase ② owns and no other file can:
//   1. the surface's own test-id namespace (`plotlines-entry-<key>` / `plotlines-pane-<key>`) and its refs
//      (`plotlines-group:<uuid>`) — the ids the rail and the store both address rows by;
//   2. the brief card's three states (no brief, drafted, accepted), which is the fact that decides whether the
//      entries exist at all;
//   3. the CONTRACT EDITOR (R5): the entry's beats as ORDERED rows, opened prefilled from the text on the record,
//      with an optional ordered dialogue section, and a body that carries the optional keys ONLY when they say
//      something (the route composes the entry's prose from the fields, so a blank sent upstream would overwrite a
//      contract the loop wrote) — and the legacy prose labels are not on this surface at all;
//   4. the three read states (in flight / failed / not this model), which `phraseDetailReadLanded` tells apart —
//      "the read is slow" and "there are no entries" are different claims.
// The view handed to these panes is the PHRASE-SWAPPED one (`story-contract.plotlinesSurfaceView`, applied by
// `StoryView.tsx`), so the tests build it the same way and the swap itself is exercised here.
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PlotlinesEntryPane, PlotlinesOverviewPane } from './PlotlinesPhrasePane';
// R5 — the sentence the shut button prints is the SURFACE's, not a string this file retypes: the same object the
// pane reads (`PhraseEntries.tsx:PLOTLINE_SURFACE`) is what makes the two surfaces unable to disagree.
import { PLOTLINE_SURFACE } from './PhraseEntries';
import { fixtureActions, fixturePhrase, fixtureView } from '../testing/story-fixtures';
import { plotlinesSurfaceView, type StoryViewData } from './story-contract';
import { phraseDetailView } from '../testing/shell-fakes';
import { chapterEntryContent } from '../testing/product-values';
import type { PhraseDetailView, PhraseGroupRow } from '../api';
import type { PhraseGroup } from '../../types';
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

    it('prints no Markdown source of its own — the phrase’s prose is the entry record, and it is rendered', () => {
        // T2/AC3 — where Phrase ②'s raw-Markdown problem could have hidden a second time. The phrase read carries
        // a composed `overview` that IS Markdown (`## Chapter 1 …` per entry, joined with blank lines), and this
        // Overview pane prints no prose at all: rows, the brief card, the counts. So the pane is checked in BOTH
        // directions — it may not print the phrase's overview as source, and it may not print a row's Markdown
        // un-rendered. The one prose region on the surface is `PlotlinesEntryPane`'s, and the case below pins it
        // rendering as blocks rather than printing them.
        const detail = phraseDetailView('s1');
        const { container } = render(<PlotlinesOverviewPane view={surfaceView({ detail })} />);

        // The source really does carry the records as TEXT (R5's `Heading:`/`Beats:` blocks, joined per entry by
        // `phraseDetailView`), so the negatives below are assertions rather than vacuums.
        expect(detail.overview).toContain('Heading: The Salt Road');
        expect(detail.overview).toContain('Beats:');
        expect(detail.overview).toContain('- The crossing is attempted.');
        expect(container.textContent).not.toContain('## ');
        // R5 — a row's record is now `Beats:` with one `- ` bullet per beat. This pane prints rows and counts, so
        // neither the label nor a single bullet's text may appear in it.
        expect(container.textContent).not.toContain('Beats:');
        expect(container.textContent).not.toContain('- The crossing is attempted.');
        // And this pane holds no prose region: `group-content` is the entry pane's node.
        expect(container.querySelector('[data-testid="group-content"]')).toBeNull();
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

    /**
     * The same pane with ONE entry's stored text replaced by bytes a producer wrote, so a test can pin a shape
     * `phraseDetailView` does not model (the labelled block) without touching the shared fixture every other
     * suite reads. The row keeps its id, state and empty `previous_content`, which is what keeps this the
     * whole-text branch rather than the word diff.
     */
    function labelledEntryPane(content: string, key = 'chapter_1') {
        const detail = phraseDetailView('s1');
        const rendered = entryPane({
            detail: {
                ...detail,
                groups: detail.groups.map((row) => (row.key === key ? { ...row, content } : row))
            }
        });

        return { ...rendered, prose: screen.getByTestId('group-content') as HTMLElement };
    }

    /** The rows of one section (`group-beat` / `group-dialogue`), IN ORDER — array order IS the contract, so the
     *  array, not the set, is the assertion (R5). */
    function rowValues(section: string): string[] {
        return Array.from(
            document.querySelectorAll<HTMLInputElement>(`[data-testid^="${section}-input-"]`)
        ).map((row) => row.value);
    }

    /** The number printed beside each row, which is what makes an Up/Down press an act the Author can aim at. */
    function rowOrder(section: string): string[] {
        return Array.from(
            document.querySelectorAll<HTMLElement>(`[data-testid^="${section}-order-"]`)
        ).map((cell) => cell.textContent ?? '');
    }

    it('opens the entry the ref addresses, with its contract as rows prefilled from the record (R-T2/F6 / R5)', () => {
        const { calls, container } = entryPane();

        expect(container.querySelector('[data-testid="plotlines-pane-chapter_1"]')).toBeTruthy();
        expect(screen.getByTestId('group-title').textContent).toBe('Chapter 1 — The Salt Road');
        // THE CLOSED EDITOR SHOWS THE RECORD THE SERVER COMPOSED — R5's text, in order: `Heading:`, `Beats:` with
        // one `- ` bullet per beat, and `Important dialogue:` with its own bullets. The rendering is pinned by the
        // two cases below; what this case pins is the WORDS and the ORDER.
        const prose = screen.getByTestId('group-content');

        // Every line of the record is on screen. The `- ` markers belong to the markdown source and the renderer
        // consumes them (the block-level case below pins the exact structure), so the WORDS are what this reads.
        for (const line of [
            'Heading: The Salt Road',
            'Beats:',
            'The crossing is attempted.',
            "The mentor's price is paid.",
            'Important dialogue:',
            'The road collects its own toll.'
        ]) {
            expect(prose.textContent).toContain(line);
        }
        // R5 — the legacy prose labels are NOT on this surface: they were the old chapter contract, and a desk
        // that printed them beside the beats would describe one contract with two vocabularies.
        for (const legacy of ['Must happen', 'Must change', 'POV', 'Setups', 'Payoffs']) {
            expect(container.textContent).not.toContain(legacy);
        }
        // There is no prose textarea on this surface at all: editing the composition would be editing a rendering.
        expect(container.querySelector('textarea')).toBeNull();
        // THE EDITOR STARTS CLOSED, and the button names the act of opening it rather than a write (U-16).
        expect(screen.queryByTestId('group-plotpoints-fields')).toBeNull();
        expect(screen.getByTestId('group-contract-closed').textContent).toBe(
            '“Revise this chapter entry” opens Chapter 1 — The Salt Road’s contract as rows — its heading, its beats in the order they happen, and the lines of dialogue it owes. The rows start as the contract on the record, and nothing is sent until you press again (R5).'
        );

        const submit = screen.getByTestId('group-revise-submit');

        expect(submit.hasAttribute('disabled')).toBe(false);
        expect(submit.textContent).toBe('Revise this chapter entry');
        expect(submit.getAttribute('title')).toBe(PLOTLINE_SURFACE.openWriteLine);

        // THE FIRST PRESS OPENS THE ROWS AND SENDS NOTHING (R5). An empty form the Author has to retype from
        // memory would be the failure mode here, so the rows are read back as the fixture's own record.
        fireEvent.click(submit);

        expect(calls.revisePhraseEntry).toBeUndefined();
        expect((screen.getByTestId('group-plotpoint-heading-input') as HTMLInputElement).value).toBe(
            'The Salt Road'
        );
        expect(rowValues('group-beat')).toEqual([
            'The crossing is attempted.',
            "The mentor's price is paid."
        ]);
        expect(rowValues('group-dialogue')).toEqual(['The road collects its own toll.']);
        expect(rowOrder('group-beat')).toEqual(['1', '2']);
        expect(screen.getByTestId('group-beat-label').textContent).toBe('Beats *');
        expect(screen.getByTestId('group-dialogue-label').textContent).toBe('Important dialogue');
        // NO DUPLICATED READING CONTENT (R5): the composed prose steps aside while the rows carry the same words,
        // and it says where the text went.
        expect(screen.queryByTestId('group-content')).toBeNull();
        expect(screen.getByTestId('group-content-rows').textContent).toBe(
            'Chapter 1 — The Salt Road’s contract is in the rows below — its heading, its beats in the order they happen, and the lines of dialogue it owes. Send them and the text here is composed from the new ones (P4).'
        );
        // A contract keeps its last beat (`minRows`): an entry with no non-blank beat is the write the route
        // refuses, so the desk does not offer a removal into that state.
        expect(screen.getByTestId('group-beat-remove-0').hasAttribute('disabled')).toBe(false);
        expect(screen.getByTestId('group-beat-up-0').hasAttribute('disabled')).toBe(true);
        expect(
            (screen.getByTestId('group-beat-input-0') as HTMLInputElement).title
        ).toBe(
            'One event this chapter has to put on the page, in the order it happens. C-7 checks the prose against every beat, and C-3/C-8 against the last one — so the order is the contract, and the Up/Down buttons are part of the write.'
        );
    });

    it('leaves the contract as it was when the rows are closed, and sends nothing (R5)', () => {
        const { calls } = entryPane();

        fireEvent.click(screen.getByTestId('group-revise-submit'));
        fireEvent.change(screen.getByTestId('group-beat-input-0'), { target: { value: 'a beat nobody meant to keep' } });
        fireEvent.click(screen.getByTestId('group-contract-cancel'));

        // The desk keeps no draft of its own (P1): the record is back, the rows are gone, and no write happened.
        expect(calls.revisePhraseEntry).toBeUndefined();
        expect(screen.queryByTestId('group-plotpoints-fields')).toBeNull();
        expect(screen.getByTestId('group-content').textContent).toContain('Beats:');
        // And the button is back to the open-line state, not a half-remembered edit.
        expect(screen.getByTestId('group-revise-submit').textContent).toBe('Revise this chapter entry');
    });

    it('renders the composed chapter record as Markdown, so Phrase ② reads prose and not `## Chapter 1`', () => {
        // T2/AC3 — the whole reason this change is not Phrase ①'s. Rendered as text — which is what this pane did
        // — the Author of a chapter-entry book read the source of the composition the route had just generated
        // from their own two fields. WHAT THIS FIXTURE SENDS is the composed shape: `phraseDetailView`'s rows
        // carry a `## <chapter>` heading and one `- ` bullet per field, which is what
        // `shared/phrase.ts:composePhraseContent` puts in front of an entry when it joins a phrase's whole text
        // (and what this pane's Overview shows). The text the wire STORES on one entry is the labelled
        // `Label: value` block instead — that shape is pinned by the next test, against the producer's own
        // function, because the two shapes need different things from the renderer.
        const { container } = entryPane();
        const prose = screen.getByTestId('group-content');

        // One wrapper, carrying every hook: the pane's sizing class, the reading copy's class, and the block
        // scale — and it is the ONLY copy of the record (the six fields below are the write, not a second prose
        // node), and nothing hides it from assistive tech.
        expect(container.querySelectorAll('[data-testid="group-content"]')).toHaveLength(1);
        expect(prose.tagName).toBe('DIV');
        expect(prose.className).toBe('sv-markdown sv-summary-text sv-group-content');
        expect(prose.getAttribute('aria-hidden')).toBeNull();

        // THE BLOCKS, IN SOURCE ORDER, EXACTLY. `Heading:` and `Beats:` are one paragraph (the composer joins its
        // blocks with a single `\n`, and `MarkdownText` keeps that break as a real break rather than folding it
        // away), and the `- ` lines are the list. THE ONE MARKDOWN WRINKLE, pinned rather than smoothed over: a
        // label line that follows a list item is a LAZY CONTINUATION of that item, so `Important dialogue:` rides
        // inside the last beat's `<li>` — which is why the AUTHORITATIVE reading of the contract is the structured
        // one (`PlotlineContract.tsx`, and the rows this pane edits), and the composed prose is the record.
        expect(Array.from(prose.querySelectorAll('h1,h2,h3,h4,h5,h6,p,ul')).map((block) =>
            block.tagName === 'UL'
                ? `UL:${Array.from(block.querySelectorAll('li'))
                      .map((item) => item.textContent ?? '')
                      .join('|')}`
                : `${block.tagName}:${block.textContent ?? ''}`
        )).toEqual([
            'P:Heading: The Salt Road\nBeats:',
            'UL:The crossing is attempted.|The mentor\'s price is paid.\nImportant dialogue:|The road collects its own toll.'
        ]);
        // The markers are gone from the whole pane, not only from the region that renders them.
        expect(container.textContent).not.toContain('## ');
        expect(container.textContent).not.toContain('- Beats:');
        // And no revision is being compared here (`previous_content` is empty), so this is the prose branch — the
        // word diff is the one surface that still prints Markdown source, and it is a `<p>`, not this node.
        expect(prose.querySelectorAll('del,ins')).toHaveLength(0);
    });

    it('renders a legacy entry’s stored block with its breaks kept, and edits it as beats (R5 compatibility)', () => {
        // THE OTHER GENERATION ON THE SAME SURFACE. A row written before the beats list carries one `Label: value`
        // line per field, with no markdown syntax in it at all — markdown alone would run the labels together into
        // one sentence, so the writer's newlines have to become real breaks. This is the COMPATIBILITY arm: the
        // reading copy is kept whole, and the write the pane offers is still the beats
        // (`story-contract.chapterEntryDraft` recovers them from the old prose, which the case below pins).
        const stored =
            'Heading: The Salt Road\nMust happen: the crossing is attempted\nMust change: the mentor\'s price is paid';

        const detail = phraseDetailView('s1');
        const { prose, container } = labelledEntryPane(stored);

        // Nothing invented: the stored text has no heading, so the prose region has none — the chapter's title is
        // its own `group-title` node outside the record — and it has no list, because the labels are not bullets.
        expect(prose.querySelectorAll('h1,h2,h3,h4,h5,h6')).toHaveLength(0);
        expect(prose.querySelectorAll('ul,ol,li')).toHaveLength(0);
        expect(screen.getByTestId('group-title').textContent).toBe('Chapter 1 — The Salt Road');
        // One paragraph box, one break per stored newline, and the three fields on three lines — spelled as
        // markup, because `textContent` reads the same whether the breaks are there or not.
        expect(prose.querySelectorAll('p')).toHaveLength(1);
        expect(prose.querySelectorAll('br')).toHaveLength(2);
        expect(prose.innerHTML).toBe(
            '<p>Heading: The Salt Road<br>\n' +
                'Must happen: the crossing is attempted<br>\n' +
                "Must change: the mentor's price is paid</p>"
        );
        // The pane's own hooks are untouched by the renderer: the record is ONE node carrying BOTH of its classes,
        // it is not hidden from assistive tech, and there is still no prose textarea on the surface.
        expect(container.querySelectorAll('[data-testid="group-content"]')).toHaveLength(1);
        expect(prose.className).toBe('sv-markdown sv-summary-text sv-group-content');
        expect(prose.getAttribute('aria-hidden')).toBeNull();
        expect(container.querySelector('textarea')).toBeNull();

        // THE WRITE IS STILL BEATS (R5): opening this legacy row recovers one beat per old field, in the old
        // field's order, and the dialogue section is empty because the old shape had none.
        fireEvent.click(screen.getByTestId('group-revise-submit'));

        // The whole old block IS the contract, so it recovers as one beat per line the old prose used — heading
        // line included, because a legacy row has no `Beats:` label to keep it out of the list
        // (`story-contract.chapterEntryDraft`'s fallback, the same read §4.3's rows use).
        expect((screen.getByTestId('group-plotpoint-heading-input') as HTMLInputElement).value).toBe('The Salt Road');
        expect(rowValues('group-beat')).toEqual([
            'Heading: The Salt Road',
            'Must happen: the crossing is attempted',
            "Must change: the mentor's price is paid"
        ]);
        expect(rowValues('group-dialogue')).toEqual([]);
    });

    it('composes the record the current route stores: heading, beats in order, dialogue only when it owes lines (R5)', () => {
        // THE COMPOSER THIS DESK MIRRORS (`phrase/plotpoints.ts:chapterEntryContent`, mirrored in
        // `testing/product-values.ts`): `Heading:`, then `Beats:` with one `- ` item per beat IN ARRAY ORDER, then
        // `Important dialogue:` ONLY when the section is non-empty. A blank line dropped by `cleanRows` cannot
        // print an empty section, and the order of the array is the order of the text.
        expect(
            chapterEntryContent({ id: 'chapter_1', key: 'chapter_1' } as unknown as PhraseGroup, {
                heading: 'The Salt Road',
                beats: ['the toll is refused', 'the road collects'],
                dialogue: ['Hale: “The gate is open.”']
            })
        ).toBe(
            'Heading: The Salt Road\nBeats:\n- the toll is refused\n- the road collects\nImportant dialogue:\n- Hale: “The gate is open.”'
        );
        // The two optional blocks are off the text when they say nothing — not printed empty.
        expect(
            chapterEntryContent({ id: 'chapter_1', key: 'chapter_1' } as unknown as PhraseGroup, {
                beats: ['the toll is refused']
            })
        ).toBe('Beats:\n- the toll is refused');
    });

    it('sends the beats in the order the rows hold them, addressed by the entry uuid (R5)', () => {
        const { calls } = entryPane();

        fireEvent.click(screen.getByTestId('group-revise-submit'));
        // A beat is trimmed on the way out (the route's `contractListOf` drops the same blanks), and a NEW beat
        // added at the end is moved EARLIER by the row's own button — array order is the contract, so the Up press
        // is part of the write, not a cosmetic reorder.
        fireEvent.change(screen.getByTestId('group-beat-input-0'), {
            target: { value: '  the crossing is attempted, and the toll is refused  ' }
        });
        fireEvent.click(screen.getByTestId('group-beat-add'));
        // The rows hold what the Author typed, SPACES AND ALL — the trim belongs to the send (the route's
        // `contractListOf` drops the same blanks), and the new row starts blank, ready to type into.
        expect(rowValues('group-beat')).toEqual([
            '  the crossing is attempted, and the toll is refused  ',
            "The mentor's price is paid.",
            ''
        ]);
        fireEvent.change(screen.getByTestId('group-beat-input-2'), { target: { value: 'the toll is paid twice over' } });
        fireEvent.click(screen.getByTestId('group-beat-up-2'));
        expect(rowValues('group-beat')).toEqual([
            '  the crossing is attempted, and the toll is refused  ',
            'the toll is paid twice over',
            "The mentor's price is paid."
        ]);

        const submit = screen.getByTestId('group-revise-submit');

        expect(submit.hasAttribute('disabled')).toBe(false);
        expect(submit.textContent).toBe('Send this contract');
        expect(submit.getAttribute('title')).toBe('Send this contract to the chapter entry as a new revision (R2).');

        fireEvent.click(submit);

        // `(storyId, entryId, body)` with the uuid, never the row's position. The heading and the dialogue travel
        // because they say something; the deprecated prose (`must_happen`/`must_change`) is not on the body at all.
        expect(calls.revisePhraseEntry).toEqual([
            [
                's1',
                'entry-chapter_1',
                {
                    plotpoints: {
                        beats: [
                            'the crossing is attempted, and the toll is refused',
                            'the toll is paid twice over',
                            "The mentor's price is paid."
                        ],
                        heading: 'The Salt Road',
                        dialogue: ['The road collects its own toll.']
                    }
                }
            ]
        ]);
        // The draft is dropped on send: the next thing on screen is the server's answer, not a half-remembered
        // request (P1), and the rows close back to the record.
        expect(screen.queryByTestId('group-plotpoints-fields')).toBeNull();
        expect(screen.getByTestId('group-revise-submit').textContent).toBe('Revise this chapter entry');
    });

    it('omits a blank heading and an empty dialogue section, and sends a note only when there is one (R5)', () => {
        // Chapter 3 is the fixture's dialogue-free chapter, so the empty section is the record's own state rather
        // than a state this test typed its way into.
        const pane = entryPane({ ref: 'plotlines-group:entry-chapter_3' });
        const { calls } = pane;

        fireEvent.click(screen.getByTestId('group-revise-submit'));

        expect(screen.getByTestId('group-title').textContent).toBe('Chapter 3 — The Salt Road');
        expect(rowValues('group-beat')).toEqual([
            'The crossing is attempted.',
            "The mentor's price is paid."
        ]);
        // An empty dialogue section is not a dead control: it opens as one blank row to type into.
        expect(rowValues('group-dialogue')).toEqual([]);
        fireEvent.click(screen.getByTestId('group-dialogue-add'));
        expect(rowValues('group-dialogue')).toEqual(['']);

        // Blank the heading, leave the added line blank, and add a note.
        fireEvent.change(screen.getByTestId('group-plotpoint-heading-input'), {
            target: { value: '   ' }
        });
        fireEvent.change(screen.getByLabelText('Note for the Editor'), {
            target: { value: '   make the toll concrete   ' }
        });
        fireEvent.click(screen.getByTestId('group-revise-submit'));

        // `heading` and `dialogue` are ABSENT from the body — the same rule `plotpointsFromBody` applies
        // server-side, mirrored so the client never sends a blank that would overwrite a contract the loop wrote.
        expect(calls.revisePhraseEntry).toEqual([
            [
                's1',
                'entry-chapter_3',
                {
                    plotpoints: {
                        beats: ['The crossing is attempted.', "The mentor's price is paid."]
                    },
                    note: 'make the toll concrete'
                }
            ]
        ]);
        // The note is dropped with the fields, so a second write starts from the record (P1). Read off the DOM
        // property rather than a matcher this package does not install.
        expect((screen.getByLabelText('Note for the Editor') as HTMLInputElement).value).toBe('');
        pane.unmount();

        // THE OTHER DIRECTION: a chapter that DOES owe lines sends them, and removing the last one takes the key
        // off the body rather than sending an empty list.
        const first = entryPane();

        fireEvent.click(screen.getByTestId('group-revise-submit'));
        fireEvent.click(screen.getByTestId('group-dialogue-remove-0'));
        expect(rowValues('group-dialogue')).toEqual([]);
        fireEvent.click(screen.getByTestId('group-revise-submit'));

        expect(first.calls.revisePhraseEntry).toEqual([
            [
                's1',
                'entry-chapter_1',
                {
                    plotpoints: {
                        beats: ['The crossing is attempted.', "The mentor's price is paid."],
                        heading: 'The Salt Road'
                    }
                }
            ]
        ]);
        first.unmount();
    });

    it('refuses a send with no non-blank beat, and says what the route would refuse (R5 / P4)', () => {
        const { calls } = entryPane();

        fireEvent.click(screen.getByTestId('group-revise-submit'));
        fireEvent.change(screen.getByTestId('group-beat-input-0'), { target: { value: '   ' } });
        fireEvent.change(screen.getByTestId('group-beat-input-1'), { target: { value: '' } });

        const submit = screen.getByTestId('group-revise-submit');

        // `['', '  ']` is a non-empty array that carries no beat — the route 400s on it, and the button says so
        // before the Author spends the press (U-16).
        expect(submit.hasAttribute('disabled')).toBe(true);
        expect(submit.getAttribute('title')).toBe(PLOTLINE_SURFACE.emptyWriteLine);

        fireEvent.click(submit);

        expect(calls.revisePhraseEntry).toBeUndefined();
        // THE REMOVAL FLOOR (`minRows: 1`): two beats are both removable, and it is the LAST one the route refuses
        // to live without — so the desk stops offering removals at one row rather than letting the Author delete
        // into the state the write would 400 on.
        expect(screen.getByTestId('group-beat-remove-0').hasAttribute('disabled')).toBe(false);
        expect(screen.getByTestId('group-beat-remove-1').hasAttribute('disabled')).toBe(false);

        fireEvent.click(screen.getByTestId('group-beat-remove-1'));

        expect(rowValues('group-beat')).toEqual(['   ']);
        expect(screen.getByTestId('group-beat-remove-0').hasAttribute('disabled')).toBe(true);
        // Still nothing to send: the only row left is blank, which is the same absence as no row at all.
        expect(screen.getByTestId('group-revise-submit').hasAttribute('disabled')).toBe(true);
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
        // Reading stays open: the row is a row, and only editing it waits (U5). The press that would open the
        // rows is refused, so no field is ever editable over a Writer pass the route would refuse (R4).
        fireEvent.click(screen.getByTestId('group-revise-submit'));

        expect(screen.queryByTestId('group-plotpoints-fields')).toBeNull();
        expect(busyPane.calls.revisePhraseEntry).toBeUndefined();
        busyPane.unmount();

        const locked = phraseDetailView('s1', {
            groups: phraseDetailView('s1').groups.map((row) =>
                row.key === 'chapter_1'
                    ? { ...row, locked: true, locked_by: 'author', locked_revision: 1 }
                    : row
            )
        });

        const lockedPane = entryPane({ detail: locked });

        // The edit block is shut rather than hidden, and says what to do instead (R1).
        expect(screen.getByTestId('group-revise-locked').textContent).toBe(
            'Locked content is settled and cannot be revised (R1). Unlock Chapter 1 — The Salt Road to write the next revision.'
        );
        expect(screen.getByTestId('group-revise-submit').getAttribute('title')).toBe(
            'Chapter 1 — The Salt Road is locked in — locked content is settled and cannot be revised (R1). Unlock it first to write a new revision.'
        );
        fireEvent.click(screen.getByTestId('group-revise-submit'));

        expect(lockedPane.calls.revisePhraseEntry).toBeUndefined();
        expect(screen.queryByTestId('group-plotpoints-fields')).toBeNull();
        lockedPane.unmount();
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
