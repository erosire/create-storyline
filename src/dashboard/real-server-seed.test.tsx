// THE SEED ROWS, CLICKED ON THE REAL RAIL, OVER THE REAL SERVER (U-25, R4).
//
// WHY THIS FILE EXISTS AT ALL. Every other suite that clicks a rail row replaces `StoryView` with a stub
// (`StorylineApp.plotlines.test.tsx`, `StorylineApp.groups.test.tsx`) because the shell suite is asserting what
// travels INTO the view; every suite that renders the real panes is handed a selection prop rather than a rail click
// (`components/StoryView.test.tsx`, `components/StoryView.plotlines.test.tsx`). So the one fact U-25 lives or dies
// on — a click on the row under Phrase ① opening the Author's idea and a click on the row under Phrase ② opening
// THAT phrase's copied text — was pinned only as two model-level halves (`story-nav.seed.test.ts`: the ref is
// accepted; and a pane test: the pane renders when handed the selection). Nothing joined them. Here the rail row, the
// shell's selection state, `selectionExists`, `StoryView`'s routing and the pane are all the real thing, over
// payloads a booted Storyline server actually answered — no fixture is in the frame.
//
// WHY THE BOOK IS BUILT BY ROUTES RATHER THAN SEEDED. `POST …/phrases/groups/:groupId/revise` composes the Overview,
// and `POST …/phrases/plotlines/start` copies it onto the Phrase ② row (`routes.ts:1194-1332`: the seed is COPIED,
// D-72). So `seed_head`/`seed_chars` below are the projection's own bytes, the same prefix the pane prints, and the
// `started` mark is the projection's own `phrase_started`. The phrase lane is reached without walking the loop: the
// start route documents NO phase gate (an Author's decision, R5), which is what makes both dials reachable here.
//
// THE SECOND BOOK IS THE ONE THAT WAS BROKEN. A classic-dial Phrase ② that has started is a real book (the dial
// moves while the phrase is unstarted, and the start itself never checks it), and the store asks for the Phrase ②
// read only on the grouped dial (`state.ts:phraseDetailWanted`). Such a book has no copied text in the frame and
// never will — the pane must say that rather than wait for a read nobody requests.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, screen, within } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';

import { StorylineApp } from './StorylineApp';
import { click, fakeHarness, renderWithStore } from './testing/shell-fakes';
import {
    bootStoryline,
    createSliceStory,
    queue,
    SLICE_SEED,
    storyView,
    type StorylineFixture
} from '../server/integration/harness';
import type { PhraseDetailView, PhraseView, QueueItem, StoryRow, StoryView } from './api';
import type { ApiClient } from './api';

/** The hand-written Premise group, in the shape `real-server-phrases.test.tsx` installs through the same route. */
const HAND_TEXT = 'A premise the Author wrote by hand.';

/**
 * THE SEED PHRASE ② IS STARTED FROM, and it is the projection's composition rather than a string this file chose:
 * one written group renders as `## Premise\n<content>` (`real-server-phrases.test.tsx:215` pins the same Overview
 * out of the same route), and the start route TRIMS what it copies (`routes.ts:1281`) without otherwise touching it.
 * 46 characters, which is the number the pane prints.
 */
const COPIED_SEED = `## Premise\n${HAND_TEXT}`;
const COPIED_SEED_CHARS = 46;

/** What a booted book carries into the shell: the rows and reads the desk's client would fetch, all of them real. */
interface RealBook {
    storyId: string;
    rows: StoryRow[];
    items: QueueItem[];
    view: StoryView;
    phrase: PhraseView;
    detail: PhraseDetailView;
    runs: Array<Record<string, unknown>>;
}

/** The exact copy `PhraseSeedPane` prints when the phrase has started and no read is coming for this dial. */
const NO_READ_LINE =
    'This phrase started on the classic Plotlines pipeline: the desk reads a phrase’s copied Seed from that phrase’s chapter-entry read (U-20), and this dial never asks for it, so the text the Start copied stays on the server. The started mark above is the Story row’s, not a read’s, and nothing here is waiting.';

/**
 * Boots a Storyline server and walks ONE book, by route, to a started Phrase ② on the dial the caller names.
 *
 * `plotlinesMode` is set BEFORE the start, because the dial closes with the start (the route 409s afterwards) — and
 * the value the Story answers with afterwards is what decides whether the store fetches the Phrase ② read at all.
 */
async function bootStartedPhraseBook(plotlinesMode: 'groups' | 'classic'): Promise<{ fixture: StorylineFixture; book: RealBook }> {
    const fixture = await bootStoryline();
    // `mode:'groups'` is the SUMMARY dial: a sampling book has no group catalog and 409s the revise below.
    const storyId = await createSliceStory(fixture, 3, { mode: 'groups' });

    // ① — one group written by hand, so the Overview exists and is the text the Start will copy.
    const phrase = (await fixture.api<PhraseView>('GET', `/stories/${storyId}/phrases`)).body;
    const premise = phrase.groups.find((group) => group.key === 'premise')!;
    const revised = await fixture.api<{ view: PhraseView }>(
        'POST',
        `/stories/${storyId}/phrases/groups/${premise.id}/revise`,
        { content: HAND_TEXT, note: 'the Author wrote the premise' }
    );

    expect(revised.status).toBe(200);
    // The receipt carries the fresh phrase read, and its Overview is the composition the Start copies below.
    expect(revised.body.view.overview).toBe(COPIED_SEED);

    // ② — the dial, then the start. The route refuses neither for the phase nor for the mode (R5: starting is the
    // Author's decision), so the same walk reaches both pipelines and only `plotlines_mode` differs.
    const patched = await fixture.api<unknown>('PATCH', `/stories/${storyId}`, {
        plotlines_mode: plotlinesMode
    });

    expect(patched.status).toBe(200);

    const started = await fixture.api<{ seed_chars: number; seed_head: string }>(
        'POST',
        `/stories/${storyId}/phrases/plotlines/start`,
        { source: 'compiled' }
    );

    expect(started.status).toBe(200);
    // THE COPIED SEED, off the receipt the projection builds: the pane's character count and prefix are these bytes.
    expect({ chars: started.body.seed_chars, head: started.body.seed_head }).toEqual({
        chars: COPIED_SEED_CHARS,
        head: COPIED_SEED
    });

    const detail = (await fixture.api<PhraseDetailView>('GET', `/stories/${storyId}/phrases/plotlines`)).body;
    const view = (await storyView(fixture, storyId)) as StoryView;

    // THE FRAME THIS FILE DEPENDS ON, pinned before anything is rendered: a started phrase on the dial named above,
    // with a compiled Overview to have been copied from. Without this the two describes could quietly be the book.
    expect({
        plotlines_mode: view.plotlines_mode,
        story_plotlines_mode: view.story.plotlines_mode,
        phrase_started: view.phrase_started,
        summary_compiled: view.summary_compiled,
        detail_key: detail.key,
        detail_mode: detail.mode
    }).toEqual({
        plotlines_mode: plotlinesMode,
        story_plotlines_mode: plotlinesMode,
        phrase_started: { summary: true, plotlines: true },
        summary_compiled: true,
        detail_key: 'plotlines',
        // The phrase read echoes THIS Story's dial (`projections.ts:phraseModeOf`), which is the field
        // `story-contract.isPlotlinesGroups` consults first — so a pane handed the read on the classic dial reads a
        // classic phrase out of it too, and cannot mistake an unrequested read (absent) for a refused one.
        detail_mode: plotlinesMode
    });

    const book: RealBook = {
        storyId,
        rows: (await fixture.api<StoryRow[]>('GET', '/stories')).body,
        items: (await queue(fixture)) as QueueItem[],
        view,
        phrase: (await fixture.api<PhraseView>('GET', `/stories/${storyId}/phrases`)).body,
        detail,
        runs: (await fixture.api<Array<Record<string, unknown>>>('GET', `/runs?story_id=${storyId}`)).body
    };

    return { fixture, book };
}

/**
 * Mounts the WHOLE shell over one real book: the rail, the content column and the store's own reads. Every payload
 * is the server's answer captured above, and `getPhraseDetail` rides as a spy so a test can prove whether the desk
 * asked for the Phrase ② read at all (`state.ts:phraseDetailWanted`).
 */
async function mountRealShell(book: RealBook) {
    const getPhraseDetail = vi.fn(async () => book.detail);
    const overrides: Partial<ApiClient> = {
        getStory: async () => book.view,
        getPhrase: async () => book.phrase,
        getPhraseDetail,
        listRuns: async () => book.runs as never
    };
    const harness = fakeHarness(book.rows, book.items, overrides);

    await harness.store.reload();
    await harness.store.openStory(book.storyId);

    let rendered!: RenderResult;

    await act(async () => {
        rendered = renderWithStore(<StorylineApp store={harness.store} />, harness.store);
    });

    return { ...harness, ...rendered, getPhraseDetail };
}

/** The rail's Seed row inside one phrase's child list — the row the Author clicks, by phrase. */
function seedRowOf(container: HTMLElement, panel: 'summary' | 'plotlines'): HTMLElement {
    const row = container.querySelector<HTMLElement>(`#outline-children-${panel} [data-testid="outline-seed"]`);

    // A missing row is a failure, not a skip: the row's existence per phrase is half of what this file proves.
    expect(row === null ? null : row.textContent).toBe('Seed');

    return row!;
}

describe('the rail’s Seed rows over the real server (U-25)', () => {
    let fixture: StorylineFixture;
    let book: RealBook;

    beforeAll(async () => {
        const booted = await bootStartedPhraseBook('groups');
        fixture = booted.fixture;
        book = booted.book;
    });

    afterAll(async () => {
        await fixture?.close();
    });

    it('opens each phrase’s own Seed pane from the row under that phrase — not the other phrase’s text', async () => {
        const { container, getPhraseDetail } = await mountRealShell(book);

        // TWO SEED ROWS, one per phrase, each inside its phrase's own child list (U-25: the Seed is a phrase child,
        // and there is no story-level row above the phrases any more).
        const summaryRow = seedRowOf(container, 'summary');
        const plotlinesRow = seedRowOf(container, 'plotlines');

        // ── PHRASE ① — the row under Summary opens the Author's idea, and the Summary surface is gone.
        await click(summaryRow);

        const ideaPane = container.querySelector<HTMLElement>('.sv-seed-pane');

        expect(ideaPane).not.toBeNull();
        expect(ideaPane!.querySelector('.sv-pane-title')?.textContent).toBe(
            "Phrase 1 — Summary · Seed — the Author's idea"
        );
        // The real Seed, verbatim off `stories.idea` — the §15 seed this book was created with.
        expect(ideaPane!.querySelector('.sv-seed-body')?.textContent).toBe(SLICE_SEED);
        // P5 — the badge is the pane's claim, and the real server's Seed carries it unchanged.
        expect(ideaPane!.querySelector('.sv-pane-badge')?.textContent).toBe(
            'Author-written · read-only for every agent, every phrase, forever (P5)'
        );
        // NOT the Summary surface the phrase header opens: no Overview, no group rows, no revision list, and not the
        // other phrase's Seed pane either.
        expect(container.querySelector('.sv-summary')).toBeNull();
        expect(container.querySelector('[data-testid="summary-overview"]')).toBeNull();
        expect(container.querySelector('[data-testid="phrase-seed-pane"]')).toBeNull();

        // ── PHRASE ② — the row under Plotlines opens THAT phrase's copied Seed.
        await click(plotlinesRow);

        // The OLD defect, pinned as an absence: the Author's idea appears nowhere in the content column once a
        // Phrase ② Seed row is open.
        expect(container.querySelector('.sv-seed-pane')).toBeNull();
        expect(container.textContent).not.toContain(SLICE_SEED);

        const pane = screen.getByTestId('phrase-seed-pane');

        expect(within(pane).getByTestId('phrase-seed-state').textContent).toBe('started');
        // The wire's true length, printed beside the prefix (`seed_chars` = 46, pinned against the receipt above).
        expect(within(pane).getByTestId('phrase-seed-chars').textContent).toBe(
            `Phrase 2 — Plotlines started on its own Seed: these ${COPIED_SEED_CHARS} characters, copied once at Start — the compiled Phrase 1 Overview, or the words you typed instead.`
        );
        // THE COPIED OVERVIEW ITSELF, rendered as the markdown it is (U-23): the copied bytes were
        // `## Premise\n…`, so the pane shows a Premise heading over the Author's premise rather than the literal.
        expect(within(pane).getByRole('heading', { name: 'Premise' })).toBeTruthy();
        expect(within(screen.getByTestId('phrase-seed-head')).getByRole('paragraph').textContent).toBe(HAND_TEXT);
        // The read landed on this dial, so nothing is waiting and nothing failed.
        expect(within(pane).queryByTestId('phrase-seed-pending')).toBeNull();
        expect(within(pane).queryByTestId('phrase-seed-no-read')).toBeNull();
        expect(within(pane).queryByTestId('phrase-seed-error')).toBeNull();
        // NOT the entries surface: the Seed leaf replaces the phrase's overview and its chapter-entry rows, while the
        // phase-level controls stay off this pane (they describe the phrase's output).
        expect(container.querySelector('[data-testid="plotlines-overview"]')).toBeNull();
        expect(container.querySelector('[data-testid="plotlines-group-rows"]')).toBeNull();

        // And the desk did ask for this book's Phrase ② read — the precondition the next file's book lacks.
        expect(getPhraseDetail).toHaveBeenCalledTimes(1);
    });
});

describe('a classic-dial Phrase ② over the real server (U-25)', () => {
    let fixture: StorylineFixture;
    let book: RealBook;

    beforeAll(async () => {
        const booted = await bootStartedPhraseBook('classic');
        fixture = booted.fixture;
        book = booted.book;
    });

    afterAll(async () => {
        await fixture?.close();
    });

    it('says the copied Seed is not on the desk, instead of waiting for a read that is never requested', async () => {
        const { container, getPhraseDetail } = await mountRealShell(book);

        // THE PRECONDITION, from the store itself: this dial never asks for the Phrase ② read
        // (`state.ts:phraseDetailWanted`), so the frame has no `seed_head` to print — and no failure to print either.
        expect(getPhraseDetail).not.toHaveBeenCalled();

        await click(seedRowOf(container, 'plotlines'));

        const pane = screen.getByTestId('phrase-seed-pane');

        // The phrase IS started — the `started` mark comes from the Story row, which is the only read this frame has.
        expect(within(pane).getByTestId('phrase-seed-state').textContent).toBe('started');
        expect(within(pane).getByTestId('phrase-seed-chars').textContent).toBe(
            'Phrase 2 — Plotlines has started on this Story: its Seed is copied, and every chapter entry, revision and claim key is written against it (D-72).'
        );
        // THE DEFECT, pinned as an absence: the pane used to print its one in-flight line for every absent read, and
        // on this book that line was permanent — the row the Author clicked to read this Seed never had one.
        expect(within(pane).queryByTestId('phrase-seed-pending')).toBeNull();
        expect(pane.textContent).not.toContain('reading this phrase’s Seed');
        expect(within(pane).queryByTestId('phrase-seed-error')).toBeNull();
        // The honest state, worded off the two projections the desk really holds.
        expect(within(pane).getByTestId('phrase-seed-no-read').textContent).toBe(NO_READ_LINE);
        // Still the phrase's own pane, still never Phrase ①'s idea standing in for the copied text.
        expect(container.querySelector('.sv-seed-pane')).toBeNull();
        expect(pane.textContent).not.toContain(SLICE_SEED);
    });
});
