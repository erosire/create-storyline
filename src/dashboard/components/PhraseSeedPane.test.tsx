// U-25 — the Seed row under Phrase ② shows THAT phrase's Seed.
//
// The Author's words this suite exists for: "The Seed (The Author's Idea) belongs to the Phrase 1 … Phrase 2 have
// different seed (which is really the compiled version of Phrase 1 used as seed, but Author can paste his own seed
// in). Each Phrase are discrete, separate from each other". The desk used to answer a Seed question with `story.idea`
// for every phrase, so a Seed row under Phrase ② printed the Author's idea and read as if that were the phrase's
// own text. Three things have to hold, and each is pinned against the wire's fields rather than a paraphrase:
//
//   1. THE TEXT IS THE PHRASE'S OWN — `phraseDetail.seed_head`/`seed_chars` (`api.ts:PhraseDetailView`), never
//      `story.idea`, and the pane proves it by following a changed `seed_head` while `story.idea` stands still;
//   2. THE START CHOICE IS HERE while the phrase has no copied text — the compiled Phrase ① Overview, or the
//      Author's paste — and each arm sends exactly one source (`routes.ts:PhraseStartBody` refuses both keys);
//   3. A STARTED PHRASE IS READ-ONLY, because D-72 makes the copied Seed the text every chapter entry, revision
//      and claim key is written against; the pane states the rule instead of showing a button the route 409s.
//
// Copy is asserted as the literals the component prints, and the two refusal sentences come from the contract
// module's helpers — the same call the pane makes — so a copy edit lands in one place and this suite says so.
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { PhraseSeedPane } from './PhraseSeedPane';
import { customSeedRefusal, plotlinesCustomStartNotice, plotlinesHandoffRefusal } from './story-contract';
import { ALL_STORY_PHRASES, phraseLabel } from './story-nav';
import { SEED_IDEA, fixtureActions, fixturePhrase, fixtureView } from '../testing/story-fixtures';
import { phraseDetailView } from '../testing/shell-fakes';
import type { PhraseDetailView, PhraseView } from '../api';
import type { StoryPhraseSpec } from './story-nav';
import type { StoryViewData } from './story-contract';

/** The phrase this pane is built for: the one the platform starts from a copied Seed. */
const PHRASE_TWO: StoryPhraseSpec = ALL_STORY_PHRASES[1]!;
/** A phrase the desk has no start verb for, so its Seed row has nothing to read (Phrase ③). */
const PHRASE_THREE: StoryPhraseSpec = ALL_STORY_PHRASES[2]!;

/**
 * The grouped book with the two projected facts the pane reads, set by the caller. `phraseDetail` is the Phrase ②
 * read its own — `summary_compiled` and `phrase_started` are the two flags the route's own refusals are computed
 * from, so a control here can never disagree with the 409 it is aiming at.
 */
function seedView(
    over: {
        compiled?: boolean;
        started?: boolean;
        detail?: PhraseDetailView | null;
        error?: string;
        /** R6 — the Summary read this pane compares its copied Seed against; the fixture's is `pending`.
         * `null` is the OTHER absent: the read has not landed, which is not the same claim as `pending`. */
        phrase?: PhraseView | null;
    } = {}
): StoryViewData {
    // `phrase: null` is the read NOT having landed; anything else (including `undefined`, i.e. the caller
    // asking for nothing) is the fixture's own pending book.
    const view = fixtureView({ ...(over.phrase === null ? {} : { phrase: over.phrase ?? fixturePhrase() }) });

    if (over.phrase === null) {
        return {
            ...view,
            phrase: null,
            plotlines_mode: 'groups' as const,
            phrase_started: { summary: true, plotlines: over.started === true },
            summary_compiled: over.compiled === true,
            ...(over.detail === undefined ? {} : { phraseDetail: over.detail })
        };
    }

    return {
        ...view,
        plotlines_mode: 'groups',
        phrase_started: { summary: true, plotlines: over.started === true },
        summary_compiled: over.compiled === true,
        ...(over.detail === undefined ? {} : { phraseDetail: over.detail }),
        // A failed read is `phraseDetail: null` plus this field (`state.ts`), and the pane prints the server's
        // sentence from it — the two travel together, so the helper sets them together.
        ...(over.error === undefined ? {} : { phraseDetailError: over.error })
    };
}

/**
 * R6 — a Phrase ① read in the state the Summary tab branches on, with the Overview text the tab would print.
 * `ready` prints `reviewed.overview` and `chosen` prints `chosen.overview` (`story-contract.ts:reviewedSummaryText`),
 * which is the text the pane compares the copied Seed against, so the fixture sets the field that decides it.
 */
function summaryRead(state: 'ready' | 'chosen', overview: string) {
    const base = fixturePhrase();

    return fixturePhrase({
        overview,
        reviewed: {
            ...base.reviewed,
            state,
            complete: state === 'ready',
            overview: state === 'ready' ? overview : '',
            chosen:
                state === 'chosen'
                    ? { vector: {}, vector_hash: 'vh-chosen', at: '2026-11-26T12:00:00.000Z', overview, scores: {} }
                    : base.reviewed.chosen
        }
    });
}

/** Mounts the pane for one phrase, returning the recording action stub the click assertions read. */
function mount(view: StoryViewData, phrase: StoryPhraseSpec = PHRASE_TWO, withActions = true) {
    const { actions, calls } = fixtureActions();
    const rendered = render(
        <PhraseSeedPane view={view} actions={withActions ? actions : {}} phrase={phrase} />
    );

    return { ...rendered, actions, calls };
}

describe('PhraseSeedPane — a started phrase’s Seed is its own text, read-only (U-25 / D-72)', () => {
    it('prints the copied Seed the phrase read carries, and never the Author’s idea', () => {
        const { container } = mount(seedView({ compiled: true, started: true, detail: phraseDetailView('s1') }));

        expect(screen.getByTestId('phrase-seed-state').textContent).toBe('started');
        // `seed_chars` is the wire's true length, printed beside the prefix so a truncated head says how much
        // text it stands for (the full Seed is not on the wire, and this pane does not pretend otherwise).
        expect(screen.getByTestId('phrase-seed-chars').textContent).toBe(
            // The pinned sentence is byte-for-byte what `real-server-seed.test.tsx` and spec §18.13 pin (those
            // strings are outside this wave's scope); R6's honesty lives in `phrase-seed-preview` below it, which
            // says how much of that length is actually on screen.
            `${phraseLabel(PHRASE_TWO)} started on its own Seed: these 67 characters, copied once at Start — the compiled Phrase 1 Overview, or the words you typed instead.`
        );
        expect(screen.getByTestId('phrase-seed-head').textContent).toBe(
            'A smuggler pays the tide to cross the salt road, and the road collects.'
        );
        // THE DEFECT THIS REQUIREMENT RETIRES, pinned as an absence: the Author's idea belongs to Phrase ①, and a
        // pane that printed it here is what made the Author say the Seed belonged to Phrase 1.
        expect(container.textContent).not.toContain(SEED_IDEA);
        // Read-only, so neither Start control exists: a live one would promise a write the route refuses (D-72).
        expect(screen.queryByTestId('phrase-seed-compiled')).toBeNull();
        expect(screen.queryByTestId('phrase-seed-custom')).toBeNull();
        expect(screen.getByTestId('phrase-seed-oneway').textContent).toBe(
            'Read-only, and there is nothing here to re-seed it: a new Seed means a new Story rather than a new start (D-72).'
        );
    });

    it('follows the phrase read rather than the Story, with the same idea on the Story', () => {
        // Same book, two different copied Seeds: only the phrase read moved, so a pane reading `story.idea` would
        // render these two identically and this test would fail.
        const first = phraseDetailView('s1', {
            seed_head: '## Premise\nA keeper starts lying to the sea, and the sea believes her.',
            seed_chars: 74
        });
        const second = phraseDetailView('s1', {
            seed_head: 'The archive burns at dawn, and the courier is already gone.',
            seed_chars: 59
        });

        const firstView = mount(seedView({ compiled: true, started: true, detail: first }));
        expect(within(screen.getByTestId('phrase-seed-head')).getByRole('heading', { name: 'Premise' })).toBeTruthy();
        expect(screen.getByTestId('phrase-seed-chars').textContent).toContain('these 74 characters');
        // The copied Seed IS markdown (it is the compiled Overview's bytes), so it renders as structures.
        expect(within(screen.getByTestId('phrase-seed-head')).getByRole('paragraph').textContent).toBe(
            'A keeper starts lying to the sea, and the sea believes her.'
        );
        firstView.unmount();

        mount(seedView({ compiled: true, started: true, detail: second }));
        expect(screen.getByTestId('phrase-seed-head').textContent).toBe(
            'The archive burns at dawn, and the courier is already gone.'
        );
        expect(screen.getByTestId('phrase-seed-chars').textContent).toContain('these 59 characters');
    });

    it('says the read is on its way while the phrase has started and its text has not landed', () => {
        mount(seedView({ compiled: true, started: true }));

        // `phraseDetail === undefined` is "on its way", and it is NOT renderable as "no Seed": the pane prints the
        // projected fact alone, with no invented prefix.
        expect(screen.getByTestId('phrase-seed-chars').textContent).toBe(
            `${phraseLabel(PHRASE_TWO)} has started on this Story: its Seed is copied, and every chapter entry, revision and claim key is written against it (D-72).`
        );
        expect(screen.getByTestId('phrase-seed-pending').textContent).toBe('reading this phrase’s Seed…');
        expect(screen.queryByTestId('phrase-seed-head')).toBeNull();
    });

    it('answers a failed phrase read with the server’s own sentence', () => {
        // The store's failure shape: the read is `null` and its error string rides beside it, so the pane prints
        // the server's sentence rather than an empty Seed.
        mount(seedView({ compiled: true, started: true, detail: null, error: 'the phrase read answered 503' }));

        const line = screen.getByTestId('phrase-seed-error');
        expect(line.textContent).toBe('This phrase’s Seed is unread: the phrase read answered 503');
        // The raw failure rides the `title` so the Author can read it without opening the console.
        expect(line.getAttribute('title')).toBe('the phrase read answered 503');
        expect(screen.queryByTestId('phrase-seed-head')).toBeNull();
    });

    it('gives a phrase with no copied Seed on the wire its absence, not Phrase ①’s idea', () => {
        const { container } = mount(seedView({ compiled: true, started: true }), PHRASE_THREE);

        // Phrase ③ has no start verb, so it has no copied Seed: the honest answer is the absence, and printing the
        // Author's idea in its place is the defect this requirement retires.
        expect(screen.getByTestId('phrase-seed-state').textContent).toBe('no Seed copied yet');
        expect(screen.getByTestId('phrase-seed-unavailable').textContent).toBe(
            'This phrase has no Seed on the wire: the desk reads a phrase’s Seed from its own phrase read, and the only phrase the platform starts with a copied Seed is Phrase 2 (U-20).'
        );
        expect(container.textContent).not.toContain(SEED_IDEA);
        expect(screen.queryByTestId('phrase-seed-compiled')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// R6 / AC4 — THE PREVIEW SAYS WHERE IT STOPS, AND THE COPY SAYS WHAT IT IS
//
// The Author's report was "it doesn't copy the complete compile Seed correctly" on a book whose Seed was
// complete: `seed_head` is a 400-character prefix by contract (`projections.ts:SEED_HEAD_CHARS`, D-76) and the
// pane rendered it with no boundary, so a 3,602-character copy looked truncated and its last word was cut in
// half. These pins are about the WINDOW, not about changing it: `seed_head`/`seed_chars` go out exactly as the
// OpenAPI contract and `phrase-start-routes.test.ts:513` (`seed_head.length === 400`) already pin them, and what
// changed is that the pane states the cut and names the text the cut stands for.
// ---------------------------------------------------------------------------

/** A prose block long enough to be a real compiled Overview, and the window the read would carry for it.
 * The 53-character unit is chosen so the 400-cut lands mid-WORD, which is the shape the Author read as an
 * incomplete copy (a cut after a space would hide the very thing this pin is about). */
const LONG_SEED = `## Premise\n${'The chart disagrees with the coast she drew herself. '.repeat(80)}`;
const SEED_HEAD_400 = LONG_SEED.slice(0, 400);

describe('PhraseSeedPane — the 400-character preview is labelled as a preview (R6 / AC4)', () => {
    it('names the window it shows and the residue the read does not carry', () => {
        // A mid-word cut, which is the shape the Author read as "an incomplete copy".
        expect(SEED_HEAD_400.length).toBe(400);
        expect(SEED_HEAD_400.endsWith(' ')).toBe(false);

        mount(
            seedView({
                compiled: true,
                started: true,
                detail: phraseDetailView('s1', { seed_head: SEED_HEAD_400, seed_chars: LONG_SEED.length })
            })
        );

        const preview = screen.getByTestId('phrase-seed-preview');

        expect(preview.getAttribute('data-cut')).toBe('true');
        expect(preview.textContent).toBe(
            `A preview, not the whole Seed: this read carries the first 400 of ${LONG_SEED.length} characters and stops mid-word (D-76). The other ${LONG_SEED.length - 400} characters are on the phrase’s row and are part of the Seed — the copy is ${LONG_SEED.length} characters long, and nothing about the preview shortens it.`
        );
        // AC4, the other half: the window itself is the wire's `seed_head`, unchanged — heading and all.
        expect(screen.getByTestId('phrase-seed-head').textContent).toContain('Premise');
    });

    it('says the whole Seed is on the read when the head is the whole text', () => {
        const whole = 'A smuggler pays the tide to cross the salt road, and the road collects.';

        mount(seedView({ compiled: true, started: true, detail: phraseDetailView('s1', { seed_head: whole, seed_chars: whole.length }) }));

        const preview = screen.getByTestId('phrase-seed-preview');

        expect(preview.getAttribute('data-cut')).toBe('false');
        expect(preview.textContent).toBe(
            `The whole Seed is on this read — all ${whole.length} characters, with nothing cut off (D-76) — and it is read-only, exactly as it was copied (D-72).`
        );
    });

    it('names the accepted Summary as the text the copy is, when it is the Summary the rail shows (AC1 on the desk)', () => {
        // The recovered book's state, at fixture scale: the rail prints the reviewed Overview, and the copied Seed
        // is that same text — so the pane says so, in characters, rather than leaving the Author to diff two panes.
        mount(
            seedView({
                compiled: true,
                started: true,
                phrase: summaryRead('ready', LONG_SEED),
                detail: phraseDetailView('s1', { seed_head: SEED_HEAD_400, seed_chars: LONG_SEED.length })
            })
        );

        const provenance = screen.getByTestId('phrase-seed-provenance');

        expect(provenance.getAttribute('data-match')).toBe('match');
        expect(provenance.textContent).toBe(
            `This Seed is the Summary this rail shows you today: the same ${LONG_SEED.length} characters, the reviewed Overview the crew stands behind (D-67, D-78). Accepting the Summary copies THAT text whole.`
        );
    });

    it('says out loud when the copy and today’s Summary differ, and that a differ is not a truncated copy', () => {
        // D-72's normal case: the Seed is a copy and the Summary kept moving under it. The pane names both
        // lengths and the rule, which is the "visible and explained" half of R6.
        const moved = `${LONG_SEED}\n\n## Ending\nending was rewritten after the Start.`;

        mount(
            seedView({
                compiled: true,
                started: true,
                phrase: summaryRead('chosen', moved),
                detail: phraseDetailView('s1', { seed_head: SEED_HEAD_400, seed_chars: LONG_SEED.length })
            })
        );

        const provenance = screen.getByTestId('phrase-seed-provenance');

        expect(provenance.getAttribute('data-match')).toBe('differs');
        expect(provenance.textContent).toBe(
            `This Seed is ${LONG_SEED.length} characters; the Summary this rail shows today is ${moved.length}. They are different texts, and that is expected, not a truncated copy: a Seed is copied ONCE and never re-seeded (D-72), so a Summary that moved after the Start leaves this Seed where it was — and this read carries no source field, so it cannot tell that apart from a Seed you typed yourself (D-76).`
        );
    });

    it('prints no provenance claim at all while the Summary read has not landed', () => {
        // An absent Phrase ① read is a read in flight, not a book without a reviewed Summary (R-T2/F1's
        // distinction). Saying "this Story has no reviewed Summary to accept" over it would be exactly the
        // un-kept promise the pane's other absent states are written to avoid.
        mount(
            seedView({
                compiled: true,
                started: true,
                phrase: null,
                detail: phraseDetailView('s1', { seed_head: SEED_HEAD_400, seed_chars: LONG_SEED.length })
            })
        );

        // The preview line is the phrase's own read, so it prints; the comparison against the Summary does not.
        expect(screen.getByTestId('phrase-seed-preview').getAttribute('data-cut')).toBe('true');
        expect(screen.queryByTestId('phrase-seed-provenance')).toBeNull();
    });

    it('names the composed Overview as the source when the book has no reviewed Summary to accept', () => {
        // The `pending` arm of `compiledSummaryOf`: the rail shows no Overview text at all, so what the Start
        // copied is the live composed Overview — the one difference the Summary tab never shows, and the pane
        // does. `fixturePhrase()` is already a pending book, so this is its live `overview`.
        const live = fixturePhrase();

        mount(
            seedView({
                compiled: true,
                started: true,
                phrase: live,
                detail: phraseDetailView('s1', { seed_head: SEED_HEAD_400, seed_chars: LONG_SEED.length })
            })
        );

        const provenance = screen.getByTestId('phrase-seed-provenance');

        expect(provenance.getAttribute('data-match')).toBe('pending');
        expect(provenance.textContent).toBe(
            `This Seed is ${LONG_SEED.length} characters, and this Story has no reviewed Summary to accept: the rail shows no Overview text, so what the Start copied is the Overview the five groups held as they stood (D-78). Its ${live.overview.length} characters are the live composed Overview, which the Summary tab prints nowhere (D-67).`
        );
    });
});

describe('PhraseSeedPane — an unstarted phrase is offered both Starts (U-25 / D-61)', () => {
    it('names the choice before the phrase has any copied text', () => {
        const { container } = mount(seedView({ compiled: true }));

        expect(screen.getByTestId('phrase-seed-state').textContent).toBe('ready to start');
        expect(screen.getByTestId('phrase-seed-note').textContent).toBe(
            `${phraseLabel(PHRASE_TWO)} has no Seed yet. Starting it copies the compiled Phrase 1 Overview into the phrase as that phrase’s own Seed — the text the Editor structures into chapters, and the one text every chapter entry, revision and claim key is written against from here on. You can write the Seed yourself instead. The start is not repeatable (D-72).`
        );
        // The Seed does not exist yet, so there is nothing to print — and no Author text to mistake for it.
        expect(screen.queryByTestId('phrase-seed-head')).toBeNull();
        expect(container.textContent).not.toContain(SEED_IDEA);
        expect(screen.getByTestId('phrase-seed-compiled').textContent).toBe(
            'Start Plotlines from the compiled Summary'
        );
        expect(screen.getByTestId('phrase-seed-compiled').getAttribute('title')).toBe(
            'Start this phrase from the compiled Summary — the Overview is copied into the phrase as its Seed (R5).'
        );
        expect(screen.getByTestId('phrase-seed-custom-open').textContent).toBe('Start from your own brief');
    });

    it('starts from the compiled Overview in one press, naming only that source', () => {
        const { calls } = mount(seedView({ compiled: true }));

        fireEvent.click(screen.getByTestId('phrase-seed-compiled'));

        // ONE ARM PER REQUEST (`routes.ts:PhraseStartBody`): a stray `text` beside `'compiled'` is the 400 the
        // refusal line above exists to avoid, so the body carries nothing but the source.
        expect(calls.startPhrase).toEqual([['s1', 'plotlines', { source: 'compiled' }]]);
        expect(screen.queryByTestId('phrase-seed-refusal')).toBeNull();
    });

    it('refuses the compiled Start while the Summary is not compiled, and leaves the paste arm open (AC6)', () => {
        const view = seedView({ compiled: false });
        const { calls } = mount(view);

        expect(screen.getByTestId('phrase-seed-state').textContent).toBe('waiting on the Summary');

        const compiled = screen.getByTestId('phrase-seed-compiled');
        const refusal = plotlinesHandoffRefusal(view, true);

        expect(compiled.hasAttribute('disabled')).toBe(true);
        expect(compiled.getAttribute('title')).toBe(refusal);
        // The same sentence sits under the buttons: a shut control alone does not say where the gate is (U-16, L-13).
        expect(screen.getByTestId('phrase-seed-refusal').textContent).toBe(refusal);

        // R7 / AC6 — THE PASTE ARM IS NOT SHUT, and that is the whole point of this test. `summary_compiled` is the
        // compiled arm's Seed problem; the paste arm's Seed is text the Author has in their hand, and the Start
        // verb checks an empty `custom` body (400) BEFORE it asks whether anything is compiled (the 409). Pinning
        // this button to the compiled arm's gate was the desk blocking a move the server allows — an Author with a
        // brief ready of their own had to run Phrase ① to write it down. The refusal sentence above stays true, and
        // the notice below is the other half of the fact: the pane is not blocked, only that one arm is.
        const open = screen.getByTestId('phrase-seed-custom-open');

        expect(open.hasAttribute('disabled')).toBe(false);
        expect(open.getAttribute('title')).toBe(
            'Start this phrase on a Seed you write here, instead of the compiled Summary — no compiled Summary is needed for this arm.'
        );
        expect(screen.getByTestId('phrase-seed-custom-notice').textContent).toBe(plotlinesCustomStartNotice(view, true));

        // AND THE ARM IS USABLE, not merely enabled: arming it produces the field, and typing produces a Start the
        // pane will send. This is the move R7 records as legal — the route accepts it on a book with no Summary.
        fireEvent.click(open);

        fireEvent.change(screen.getByTestId('phrase-seed-custom-text'), {
            target: { value: 'Six chapters, alternating timeline, no frame story.' }
        });
        fireEvent.click(screen.getByTestId('phrase-seed-custom-submit'));

        expect(calls.startPhrase).toEqual([
            ['s1', 'plotlines', { source: 'custom', text: 'Six chapters, alternating timeline, no frame story.' }]
        ]);
    });

    it('pastes the Author’s own Seed and starts the phrase on it', () => {
        const { calls } = mount(seedView({ compiled: true }));

        fireEvent.click(screen.getByTestId('phrase-seed-custom-open'));

        expect(screen.getByTestId('phrase-seed-custom-note').textContent).toBe(
            'What you write here becomes the Seed instead of the compiled Summary. The Editor structures it into chapters exactly as it does the Overview, and the start is still one-way (D-72).'
        );
        expect(screen.getByTestId('phrase-seed-custom-text').getAttribute('placeholder')).toBe(
            'the chapter plan you want this phrase built from — e.g. six chapters, alternating timeline, no frame story'
        );

        // An empty paste is the route's 400, stated as a refusal before the request (D-61).
        const submit = screen.getByTestId('phrase-seed-custom-submit');
        expect(submit.hasAttribute('disabled')).toBe(true);
        expect(submit.getAttribute('title')).toBe(customSeedRefusal(''));

        fireEvent.change(screen.getByTestId('phrase-seed-custom-text'), {
            target: { value: '  six chapters, alternating timeline, no frame story  ' },
        });
        expect(submit.hasAttribute('disabled')).toBe(false);

        fireEvent.click(submit);

        // The paste is trimmed, and the body names the other arm alone.
        expect(calls.startPhrase).toEqual([['s1', 'plotlines', { source: 'custom', text: 'six chapters, alternating timeline, no frame story' }]]);
        // The form closes on send: what appears next is the server's answer, not the Author's draft (P1).
        expect(screen.queryByTestId('phrase-seed-custom')).toBeNull();
    });

    it('drops an unsubmitted paste and starts nothing', () => {
        const { calls } = mount(seedView({ compiled: true }));

        fireEvent.click(screen.getByTestId('phrase-seed-custom-open'));
        fireEvent.change(screen.getByTestId('phrase-seed-custom-text'), { target: { value: 'a brief nobody meant to send' } });
        fireEvent.click(screen.getByTestId('phrase-seed-custom-cancel'));

        expect(screen.queryByTestId('phrase-seed-custom')).toBeNull();
        expect(calls.startPhrase).toBeUndefined();

        // Re-arming opens an EMPTY field: the cancelled draft is gone rather than lying about in the pane.
        fireEvent.click(screen.getByTestId('phrase-seed-custom-open'));
        expect((screen.getByTestId('phrase-seed-custom-text') as HTMLTextAreaElement).value).toBe('');
    });

    it('shuts the compiled Start while the paste arm is open, and says which button closes it', () => {
        mount(seedView({ compiled: true }));

        fireEvent.click(screen.getByTestId('phrase-seed-custom-open'));

        const compiled = screen.getByTestId('phrase-seed-compiled');
        expect(compiled.hasAttribute('disabled')).toBe(true);
        expect(compiled.getAttribute('title')).toBe(
            'The custom Seed form is open — “Keep the compiled Summary” closes it.'
        );
        // Two ways to arm the same form is two states to keep in sync, so the arm button retires itself while armed.
        expect(screen.queryByTestId('phrase-seed-custom-open')).toBeNull();
    });

    it('states the shell’s own refusal when no start verb is bound', () => {
        const view = seedView({ compiled: true });
        mount(view, PHRASE_TWO, false);

        const compiled = screen.getByTestId('phrase-seed-compiled');
        expect(compiled.hasAttribute('disabled')).toBe(true);
        expect(compiled.getAttribute('title')).toBe('The phrase start route is not available in this shell.');
        expect(screen.getByTestId('phrase-seed-refusal').textContent).toBe(
            plotlinesHandoffRefusal(view, false)
        );
        // The paste arm is bound to the same verb, so it is absent rather than a field that sends nothing.
        expect(screen.queryByTestId('phrase-seed-custom-open')).toBeNull();
    });
});
