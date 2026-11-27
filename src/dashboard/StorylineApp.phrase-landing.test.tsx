// C2a / R4 (symptom 3, first half) — the desk MOVES to the phrase the Author just opened.
//
// WHAT THE AUTHOR SAW. They accepted the final Summary, or pressed "Start Phrase 2", and the rail kept showing
// Phrase ① lit while the crew worked Phrase ②. The rail's selection is the shell's one piece of UI state
// (`StorylineApp.tsx`): the pane, its title and the directive bar all resolve from it, so a selection that never
// moved is a desk that never moved — and the crew rows, which had no phrase word on them at all, could not
// contradict it.
//
// THE RULE UNDER TEST, in the three places it lives:
//   1. `shell-binding.ts:ShellVerbHooks.onPhraseOpened` fires ONLY after a verb that can open a phrase has
//      SUCCEEDED — every store verb answers `null` when the server refused (`mutate`'s contract), so a 409 moves
//      nothing and the Author stays on the pane that raised the sentence;
//   2. `shell-binding.ts:storyFrame` re-reads the frame FROM THE STORE after the write, so the decision comes from
//      the payload the server just answered rather than from the props the click captured;
//   3. `story-nav.ts:phraseLandingSelection` answers `{panel:'plotlines'}` only when the projection's
//      `phrase_started.plotlines` says the phrase row exists, and `undefined` otherwise. `undefined` means "stay
//      put" — the NON-DESTRUCTIVE half: an Accept that did not start Phrase ②, and a frame whose read has not
//      landed, keep the pane the Author was standing on.
//
// The real rail is mounted (only `StoryView` is stubbed), so each case pins BOTH the model's selection and the
// row the Author actually sees lit (`aria-current="page"`).
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';

import { StorylineApp } from './StorylineApp';
import {
    fakeHarness,
    groupedPhraseView,
    phraseDetailView,
    renderWithStore,
    storyRow,
    storyView
} from './testing/shell-fakes';
import {
    ApiError,
    type CreateStoryInput,
    type PhraseDetailView,
    type PhraseStartResult,
    type StoryRow,
    type StoryView
} from './api';
import type { DashboardStore } from './state';

vi.mock('./components/StoryView', () => {
    // The stub prints the selection it was handed — `panel` and `ref` — because the landing IS a selection change.
    // `ref:header` is the "no ref" state, so a landing that rewrote a stale ref onto the new phrase would read
    // `ref:summary-group:grp-tone` here and fail.
    const Stub = (props: {
        view: { story: { title: string }; phrase_started?: { summary: boolean; plotlines: boolean } };
        actions?: {
            startPhrase?: (storyIdOrKey?: string, keyOrInput?: { source?: string; text?: string }) => void;
            lockPhase?: (storyId?: string) => void;
        };
        selection?: { panel: string; ref?: string };
        onSelect?: (selection: { panel: string; ref?: string }) => void;
    }) => (
        <div data-testid="story-view">
            {`title:${props.view.story.title}`}
            {`started:${props.view.phrase_started?.plotlines ? 'yes' : 'no'}`}
            {`panel:${props.selection?.panel ?? 'none'}`}
            {`ref:${props.selection?.ref ?? 'header'}`}
            <button type="button" onClick={() => props.actions?.startPhrase?.()}>
                pane starts the phrase
            </button>
            <button type="button" onClick={() => props.actions?.lockPhase?.()}>
                pane accepts the final summary
            </button>
            {/* The Author mid-navigation: a Summary GROUP pane, addressed by a ref. The landing must open Phrase ②'s
                OVERVIEW, and a landing that carried this ref across phrases would open a group that Phrase ② has no
                row for. */}
            <button
                type="button"
                onClick={() => props.onSelect?.({ panel: 'summary', ref: 'summary-group:grp-tone' })}
            >
                pane opens a summary group
            </button>
        </div>
    );

    return { StoryView: Stub };
});

/** The wire facts one case cares about, as the projection answers them. */
interface Wire {
    /** `phrase_started.plotlines` — the projection's read of the PHRASE ROW, never a row count (L-14). */
    started?: boolean;
    /** The start route refuses (409): the verb answers `null`, so nothing may move. */
    startRefuses?: boolean;
    /** The Accept also starts Phrase ② in the same call — the shape the handoff route answers. */
    acceptStarts?: boolean;
    /** The Phrase ② dial, which decides whether the desk would even have entry rows to show. */
    mode?: 'groups' | 'classic';
}

/**
 * The desk over one Story. `started` is MUTABLE because the landing must come from the payload the server answers
 * AFTER the write — the fake flips it only when the route that starts the phrase has run.
 */
function landingHarness(wire: Wire = {}) {
    let started = wire.started === true;
    let startCalls = 0;
    let acceptCalls = 0;

    const view = (storyId: string): StoryView => {
        const base = storyView(storyRow(storyId, { title: 'Hollow Sea' }));

        return {
            ...base,
            ...(wire.mode === undefined ? {} : { plotlines_mode: wire.mode }),
            phrase_started: { summary: true, plotlines: started },
            summary_compiled: true,
            story: { ...base.story, ...(wire.mode === undefined ? {} : { plotlines_mode: wire.mode }) }
        };
    };

    const harness = fakeHarness([storyRow('story_1', { title: 'Hollow Sea' })], [], {
        getStory: vi.fn(async (storyId: string) => view(storyId)),
        getPhrase: vi.fn(async (storyId: string) => groupedPhraseView(storyId)),
        getPhraseDetail: vi.fn(async (storyId: string) => phraseDetailView(storyId)),
        startPhrase: vi.fn(
            async (storyId: string, key: string, input?: { source?: string; text?: string }): Promise<PhraseStartResult> => {
                startCalls += 1;

                if (wire.startRefuses === true) {
                    // The server's own sentence, verbatim — the desk must print it and stay put.
                    throw new ApiError(
                        409,
                        'there is no compiled Summary to start Phrase 2 from: accept the final Summary first'
                    );
                }

                started = true;

                return {
                    story_id: storyId,
                    phrase_id: 'phrase_plotlines_1',
                    key,
                    source: input?.source === 'custom' ? 'custom' : 'compiled',
                    seed_chars: 67,
                    seed_head: 'A smuggler pays the tide to cross the salt road, and the road collects.',
                    started: { phrase_id: 'phrase_plotlines_1', key, started_at: '2026-11-09T10:00:00.000Z' },
                    // R11 — the two pointer fields the Start receipt really carries. This book's Summary is not
                    // signed off, so the crew stays on Phrase ①, and the sentence is the route's own (L-13).
                    phase_opened: false,
                    phase_open_reason: `the Summary is not signed off, so the crew stays on Phrase ①: POST /stories/${storyId}/lock is the act that signs phase summary off and opens phase plotlines (L-33: a phase is entered only with every earlier phase locked)`,
                    view: phraseDetailView(storyId)
                };
            }
        ),
        // `POST …/lock` — the Accept. On the handoff book the same call starts Phrase ②, and the projection's
        // `phrase_started` is what says so; a fake that flipped the flag before the route ran would let a guess pass.
        lockPhase: vi.fn(async (storyId: string) => {
            acceptCalls += 1;
            if (wire.acceptStarts === true) started = true;

            return storyRow(storyId, { status: 'ready', pending_kind: 'none' });
        })
    });

    return { ...harness, started: () => started, startCalls: () => startCalls, acceptCalls: () => acceptCalls };
}

/** Loads the list, opens the Story, mounts — so the first paint is already the desk. */
async function mountDesk(wire: Wire = {}) {
    const harness = landingHarness(wire);

    await harness.store.reload();
    await harness.store.openStory('story_1');
    await act(async () => {
        renderWithStore(<StorylineApp store={harness.store} />, harness.store);
    });

    return harness;
}

/**
 * Presses a pane control and lets the verb's whole chain settle: the route, the store's commit, `mutate`'s refetch
 * fan-out, the `onPhraseOpened` continuation, and React's re-render. Bounded microtask ticks (not a timed wait) —
 * every fake here settles on an already-resolved promise, so tick 12 is "everything that can answer, answered".
 */
async function press(name: string): Promise<void> {
    await act(async () => {
        fireEvent.click(screen.getByRole('button', { name }));
        for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();
    });
}

const desk = (): string => String(screen.getByTestId('story-view').textContent);

/** Which phrase row the rail lights — the OTHER half of the symptom, the thing the Author actually looks at. */
function litPhrase(): string {
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.outline-item--phrase'));
    const lit = rows.find((row) => row.getAttribute('aria-current') === 'page');

    return lit?.querySelector('.outline-name')?.textContent ?? 'none';
}

describe('StorylineApp — the desk lands on the phrase the Author just opened (C2a/R4)', () => {
    it('opens Phrase 2 in the rail and the content area when the start succeeds', async () => {
        const harness = await mountDesk();

        // The desk opens where it has always opened: Phrase ①, until a verb proves otherwise.
        expect(desk()).toContain('panel:summary');
        expect(desk()).toContain('started:no');
        expect(litPhrase()).toBe('Summary');

        await press('pane starts the phrase');

        // The model's selection AND the lit rail row move together, off the server's answer (`started:yes`).
        expect(desk()).toContain('panel:plotlines');
        expect(desk()).toContain('ref:header');
        expect(desk()).toContain('started:yes');
        expect(litPhrase()).toBe('Plotlines');
        expect(harness.startCalls()).toBe(1);
    });

    it('keeps the desk on Phrase 1 when the start is refused, and prints the server’s own sentence', async () => {
        const harness = await mountDesk({ startRefuses: true });

        await press('pane starts the phrase');

        // `mutate` answers `null` for a refusal, so the verb never claims a phrase opened: the pane, the rail and
        // the Author's place all stay put.
        expect(desk()).toContain('panel:summary');
        expect(litPhrase()).toBe('Summary');
        expect(desk()).toContain('started:no');
        expect(harness.store.getSnapshot().error).toBe(
            'there is no compiled Summary to start Phrase 2 from: accept the final Summary first'
        );
        expect(harness.startCalls()).toBe(1);
    });

    it('does not move the desk for an Accept that did not start Phrase 2', async () => {
        // THE NON-DESTRUCTIVE HALF. Phrase ①'s rows come from the catalog and the loop writes them, so an Accept is
        // the Author staying WITH Phrase ① — a rail that jumped on the verb alone would yank them out of the
        // phrase they are still working in.
        const harness = await mountDesk({ started: false });

        await press('pane accepts the final summary');

        expect(desk()).toContain('panel:summary');
        expect(litPhrase()).toBe('Summary');
        expect(harness.acceptCalls()).toBe(1);
        expect(harness.started()).toBe(false);
    });

    it('follows an Accept that DOES start Phrase 2, on the same projection flag', async () => {
        const harness = await mountDesk({ acceptStarts: true });

        await press('pane accepts the final summary');

        expect(desk()).toContain('panel:plotlines');
        expect(litPhrase()).toBe('Plotlines');
        expect(harness.started()).toBe(true);
    });

    it('lands on the Phrase 2 OVERVIEW from mid-navigation, rather than carrying the old ref across phrases', async () => {
        await mountDesk();

        await press('pane opens a summary group');

        expect(desk()).toContain('panel:summary');
        expect(desk()).toContain('ref:summary-group:grp-tone');

        await press('pane starts the phrase');

        // The landing is the phrase's OWN overview (`{panel:'plotlines'}`, no ref): a stale Summary-group ref
        // pointed at a row Phrase ② has no entry for, and the pane would open a group that does not exist.
        expect(desk()).toContain('panel:plotlines');
        expect(desk()).toContain('ref:header');
        expect(litPhrase()).toBe('Plotlines');
    });

    it('still OPENS every story on Phrase 1 — the landing rule changes no default (regression)', async () => {
        // A classic book with Phrase ② already started: the desk must not auto-jump on open. The rule is a
        // verb-completion rule, not a "wherever the loop got to" rule; nothing else may move the Author's place.
        const harness = await mountDesk({ started: true, mode: 'classic' });

        expect(desk()).toContain('panel:summary');
        expect(litPhrase()).toBe('Summary');
        expect(harness.store.getSnapshot().phraseDetails.story_1).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// R1 (W2) — the SAME landing rule applied to the create form's `start_phrase`.
//
// THE SYMPTOM. An Author writes the Seed, picks "Plotlines" from the catalog and presses create. The engine starts
// that phrase in the SAME commit as the Story row (`routes.ts`), so the book is open ON Phrase ②'s work — but the
// rail's default is the Summary, and a Summary pane is the one surface a book that never wrote one does not have.
// The desk has to move, and it may only move on PROOF: `story-nav.phraseLandingSelection` reads the projection
// (`phrase_started`), never the fact that a verb ran.
//
// TWO HONEST STATES THIS COVERAGE KEEPS APART:
//   - the create asked for a phrase and the read says it started  -> the rail moves, once;
//   - the create asked and the read has not caught up (or says no) -> the desk stays on the Summary AND the hint is
//     still spent, because a hint that outlived its own create would move the rail on a later, unrelated open.
// The third case is the one the plan cares about most: a create that named NO phrase must request no Phrase ② read
// at all, so the desk cannot claim work the loop was never pointed at.
// ---------------------------------------------------------------------------
describe('StorylineApp — a create that started a phrase lands the desk on that phrase (R1)', () => {
    /**
     * The desk with NO story open: the create is the act that opens one, so the landing is the
     * whole story. `started` is the projection on the read of the book the create just made, and
     * a fake that flipped it before `GET /stories/:id` ran would let the shell pass on a guess.
     */
    function createHarness(wire: { started?: boolean } = {}) {
        const rows: StoryRow[] = [];
        const createInputs: CreateStoryInput[] = [];
        /** Every `GET /stories/:id/phrases/:key` this create caused, in call order. */
        const detailKeys: string[] = [];

        const view = (storyId: string): StoryView => ({
            ...storyView(storyRow(storyId, { title: 'Hollow Sea' })),
            phrase_started: { summary: true, plotlines: wire.started === true },
            summary_compiled: true
        });

        const harness = fakeHarness([], [], {
            listStories: vi.fn(async () => [...rows]),
            createStory: vi.fn(async (input: CreateStoryInput): Promise<StoryRow> => {
                // The body is pinned as received, because the store must hand `start_phrase` to the
                // route verbatim — a default it invented here would look identical on screen.
                createInputs.push({ ...input });
                const row = storyRow('story_new', { title: input.title ?? 'Untitled' });
                rows.push(row);

                return row;
            }),
            getStory: vi.fn(async (storyId: string) => view(storyId)),
            getPhrase: vi.fn(async (storyId: string) => groupedPhraseView(storyId)),
            getPhraseDetail: vi.fn(async (storyId: string, key: string) => {
                detailKeys.push(key);

                return phraseDetailView(storyId);
            })
        });

        return { ...harness, createInputs, detailKeys };
    }

    /** Mounts the home desk with one pre-loaded read, so the first paint is not a spinner. */
    async function mountHome(wire: { started?: boolean } = {}) {
        const harness = createHarness(wire);

        await harness.store.reload();
        await act(async () => {
            renderWithStore(<StorylineApp store={harness.store} />, harness.store);
        });

        return harness;
    }

    /**
     * Runs the create and lets the store's whole post-write chain settle: the row, the re-reads, the
     * hint commit, the shell's landing effect, and the re-render. The hint lands AFTER the re-reads by
     * design (`state.ts:createStory`), so a single tick is not enough to see the landing.
     */
    async function createWith(harness: ReturnType<typeof createHarness>, input: CreateStoryInput) {
        await act(async () => {
            await harness.store.createStory(input);
            for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();
        });
    }

    it('lands on Phrase 2 in the rail and the content area, and spends the hint once', async () => {
        const harness = await mountHome({ started: true });

        // Nothing is open yet: the desk is the home screen, and the landing is what changes that.
        expect(screen.queryByTestId('story-view')).toBeNull();

        await createWith(harness, { title: 'Hollow Sea', idea: 'A smuggler pays the tide to cross the salt road.', start_phrase: 'plotlines' });

        // The body the route got: the phrase key the Author picked, and no invented fields.
        expect(harness.createInputs).toEqual([
            { title: 'Hollow Sea', idea: 'A smuggler pays the tide to cross the salt road.', start_phrase: 'plotlines' }
        ]);
        // The pane AND the lit rail row move together — the symptom was a rail that never moved.
        expect(desk()).toContain('panel:plotlines');
        expect(desk()).toContain('ref:header');
        expect(desk()).toContain('started:yes');
        expect(litPhrase()).toBe('Plotlines');
        // Phrase ②'s own read is fetched with the key the Author picked, on the create alone: the
        // cache starts empty on a book one frame old, and the pane's SEED (R3) comes from this read.
        expect(harness.detailKeys).toEqual(['plotlines']);
        expect(harness.store.getSnapshot().phraseDetails.story_new).toBeDefined();
        // The hint is one-shot. A frame that kept it would move the rail again on the next open of
        // the same book, which is the C2a bug wearing a different coat.
        expect(harness.store.getSnapshot().phraseLanding).toBeNull();
        expect(harness.store.takePhraseLanding()).toBeNull();
    });

    it('asks for no Phrase 2 read at all when the create named no phrase', async () => {
        const harness = await mountHome();

        await createWith(harness, { title: 'Hollow Sea', idea: 'A smuggler pays the tide to cross the salt road.' });

        // No `start_phrase` on the body, so no hint and no Phrase ② read: the desk opens where it
        // always has, and the desk never claims work the loop was not pointed at.
        expect(harness.createInputs).toEqual([
            { title: 'Hollow Sea', idea: 'A smuggler pays the tide to cross the salt road.' }
        ]);
        expect(desk()).toContain('panel:summary');
        expect(litPhrase()).toBe('Summary');
        expect(harness.client.getPhraseDetail).not.toHaveBeenCalled();
        expect(harness.store.getSnapshot().phraseDetails.story_new).toBeUndefined();
        expect(harness.store.getSnapshot().phraseLanding).toBeNull();
    });

    it('stays on the Summary when the read does not prove the start, and still spends the hint', async () => {
        const harness = await mountHome({ started: false });

        await createWith(harness, { title: 'Hollow Sea', idea: 'A smuggler pays the tide.', start_phrase: 'plotlines' });

        // The projection says the phrase is not open, so the shell does not jump into a pane with no
        // rows behind it — the same non-destructive half the start-phrase tests pin.
        expect(desk()).toContain('panel:summary');
        expect(desk()).toContain('started:no');
        expect(litPhrase()).toBe('Summary');
        // The read was still requested (the create asked for the phrase, whatever the read answers),
        // and the hint is spent anyway so it cannot move a later open of this book.
        expect(harness.detailKeys).toEqual(['plotlines']);
        expect(harness.store.getSnapshot().phraseLanding).toBeNull();
        expect(harness.store.takePhraseLanding()).toBeNull();
    });
});
