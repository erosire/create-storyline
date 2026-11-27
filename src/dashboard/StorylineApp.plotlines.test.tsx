// T-W4 — the shell carries Phrase ② into the desk's one model, and Phrase ② is the rail's second phrase.
//
// `StorylineApp.groups.test.tsx` pins the same three facts for the Summary's read; this file keeps that stub and
// pins Phrase ②'s, none of which a pane suite can see because a pane receives the model rather than building it:
//
//   - the `GET /stories/:id/phrases/plotlines` read is cached per Story and merged into the `view` the panes
//     receive, as `phraseDetail` — NOT as `phrase`, because both phrases can be lit in one frame and one read may
//     not overwrite the other's rows;
//   - the read is asked for on the Story's OWN dial (`phraseDetailWanted`): opening a classic Story stays one
//     fewer flight, which is the whole reason §4.3's records view still exists;
//   - the dial's word and the two handoff flags (`phrase_started`, `summary_compiled`) ride the same frame, so the
//     handoff button and the Settings dial decide from what the server projected rather than from row counts;
//   - the three Phrase ② verbs are bound on the action object in the LOCAL shapes the panes call, and each binding
//     addresses the pinned route with the Story the Author is standing on;
//   - the rail lists two phrases (Summary, Plotlines) with Characters moved off the numbered rail into
//     Supplements, and a Phrase ② row's address is `plotlines-group:<uuid>` beside the Summary's
//     `summary-group:<uuid>` — the prefix, not a row count, is what tells the two panes apart.
import { describe, expect, it, vi } from 'vitest';
import { act, screen } from '@testing-library/react';

import { StorylineApp } from './StorylineApp';
import { click, fakeHarness, phraseDetailView, renderWithStore, storyRow, storyView } from './testing/shell-fakes';
import { groupedPhraseView } from './testing/shell-fakes';
import type { DashboardStore } from './state';
import type { PhraseDetailView, PhraseStartResult, StoryView } from './api';

vi.mock('./components/StoryView', () => {
    // The stub prints whatever the shell put on the model, in the same `field:value` style the group suite uses:
    // a fact the shell failed to thread is a line that says `none`, which is a different state from a value.
    const Stub = (props: {
        view: {
            story: { title: string; plotlines_mode?: string };
            /** The SUMMARY's read, printed to prove Phrase ② never took its slot. */
            phrase?: { mode: string } | null;
            phraseError?: string | null;
            /** PHRASE ②'s read — the chapter entries, their mode, and their own failure sentence. */
            phraseDetail?: { mode: string; groups?: unknown[] } | null;
            phraseDetailError?: string | null;
            phrase_started?: { summary: boolean; plotlines: boolean };
            summary_compiled?: boolean;
        };
        actions?: {
            setPlotlinesMode?: (mode: 'groups' | 'classic') => void;
            // The shell's LOCAL shape: the Story is dropped, and the phrase key takes its place. The panes
            // themselves call the pinned 3-arg shape (they always know the Story), which `PlotlinesHandoff` pins.
            startPhrase?: (
                storyIdOrKey?: string,
                keyOrInput?: { source?: 'compiled' | 'custom'; text?: string }
            ) => void;
            revisePhraseEntry?: (
                entryId: string,
                input: { plotpoints: { must_happen: string; must_change: string }; note?: string }
            ) => void;
        };
        selection?: { panel: string; ref?: string };
        onSelect?: (selection: { panel: string; ref?: string }) => void;
    }) => (
        <div data-testid="story-view">
            {`title:${props.view.story.title}`}
            {/* The dial's word as the wire said it. `absent` is the legacy state and must stay distinguishable
                from `classic`: an old book carries no key at all, and a pane that read the two alike would move
                it onto a pipeline whose rows do not exist. */}
            {`mode:${props.view.story.plotlines_mode ?? 'absent'}`}
            {`started:${props.view.phrase_started?.plotlines ? 'yes' : 'no'}`}
            {`compiled:${props.view.summary_compiled ? 'yes' : 'no'}`}
            {`detail:${props.view.phraseDetail ? props.view.phraseDetail.mode : 'none'}`}
            {`entries:${props.view.phraseDetail?.groups ? props.view.phraseDetail.groups.length : 'none'}`}
            {`detailError:${props.view.phraseDetailError ?? 'none'}`}
            {/* The SUMMARY's read, printed beside Phrase ②'s: a Phrase ② read that is pending or refused leaves the
                Summary surface exactly as it was, and `phrase:none` beside `detail:none` is a different frame from
                a book that has neither read. */}
            {`phrase:${props.view.phrase ? props.view.phrase.mode : 'none'}`}
            {/* Phrase ②'s failure must NOT arrive in the Summary read's slot — they are two routes about two
                surfaces, and the Summary pane may not print a sentence about chapter entries. */}
            {`error:${props.view.phraseError ?? 'none'}`}
            {`setMode:${typeof props.actions?.setPlotlinesMode === 'function' ? 'bound' : 'none'}`}
            {`start:${typeof props.actions?.startPhrase === 'function' ? 'bound' : 'none'}`}
            {`revise:${typeof props.actions?.revisePhraseEntry === 'function' ? 'bound' : 'none'}`}
            {`ref:${props.selection?.ref ?? 'header'}`}
            {/* The three writes, fired in the LOCAL shape each pane uses (the shell's binding is what drops the
                Story id), so a binding that lost the scope would address the wrong book below. */}
            <button type="button" onClick={() => props.actions?.setPlotlinesMode?.('classic')}>
                pane turns the dial off
            </button>
            <button type="button" onClick={() => props.actions?.startPhrase?.()}>
                pane starts the phrase
            </button>
            <button
                type="button"
                onClick={() => props.actions?.startPhrase?.('plotlines', { source: 'custom', text: 'a road that collects' })}
            >
                pane starts from a custom seed
            </button>
            <button
                type="button"
                onClick={() =>
                    props.actions?.revisePhraseEntry?.('entry-chapter_2', {
                        plotpoints: {
                            must_happen: 'the crossing is attempted, and the toll is refused',
                            must_change: 'the mentor stops paying for the road'
                        },
                        note: 'make the toll concrete'
                    })
                }
            >
                pane revises one entry
            </button>
        </div>
    );

    return { StoryView: Stub };
});

/** The Phrase ② wire facts, as the projection answers them for one Story (`api.ts:StoryView`). */
interface Wire {
    /** `story.plotlines_mode` — absent means the book was written before Phrase ②. */
    mode?: 'groups' | 'classic';
    started?: boolean;
    compiled?: boolean;
}

/**
 * The desk over one Story, with the T-W4 fields on the payload and on the row (the projection echoes the dial in
 * both places, and `story-fixtures` pins that a test sets both). `state.ts:phraseDetailWanted` reads the VIEW's
 * word, and `story-contract.isPlotlinesGroups` reads the ROW's until the read lands.
 */
function plotlinesHarness(
    wire: Wire = {},
    detail?: PhraseDetailView | ((storyId: string) => Promise<PhraseDetailView>)
) {
    // `started` is MUTABLE on purpose: the rail's tick has to come from the read the server answers after the
    // start, not from the receipt, so the fake only flips the flag once the start route has been called.
    let started = wire.started === true;
    let startCalls = 0;

    const view = (storyId: string): StoryView => {
        const base = storyView(storyRow(storyId, { title: 'Hollow Sea' }));

        return {
            ...base,
            ...(wire.mode === undefined ? {} : { plotlines_mode: wire.mode }),
            phrase_started: { summary: true, plotlines: started },
            summary_compiled: wire.compiled !== false,
            story: { ...base.story, ...(wire.mode === undefined ? {} : { plotlines_mode: wire.mode }) }
        };
    };

    const harness = fakeHarness([storyRow('story_1', { title: 'Hollow Sea' })], [], {
        getStory: vi.fn(async (storyId: string) => view(storyId)),
        // The Summary read answers the five-group projection too, so a test can put a Summary row and a Phrase ②
        // row in the same frame and watch which pane each address opens.
        getPhrase: vi.fn(async (storyId: string) => groupedPhraseView(storyId)),
        getPhraseDetail: vi.fn(async (storyId: string) =>
            typeof detail === 'function' ? detail(storyId) : detail ?? phraseDetailView(storyId)
        ),
        startPhrase: vi.fn(
            async (storyId: string, key: string, input?: { source?: string; text?: string }): Promise<PhraseStartResult> => {
                startCalls += 1;
                started = true;

                return {
                    story_id: storyId,
                    phrase_id: 'phrase_plotlines_1',
                    key,
                    source: input?.source === 'custom' ? 'custom' : 'compiled',
                    seed_chars: 67,
                    seed_head:
                        input?.source === 'custom'
                            ? String(input.text ?? '')
                            : 'A smuggler pays the tide to cross the salt road, and the road collects.',
                    started: { phrase_id: 'phrase_plotlines_1', key, started_at: '2026-11-09T10:00:00.000Z' },
                    // R11 — the two pointer fields every Start receipt carries. This fake's book has an unsigned
                    // Summary, so the crew does not move, and the reason is the route's own sentence.
                    phase_opened: false,
                    phase_open_reason: `the Summary is not signed off, so the crew stays on Phrase ①: POST /stories/${storyId}/lock is the act that signs phase summary off and opens phase plotlines (L-33: a phase is entered only with every earlier phase locked)`,
                    // The receipt's own view is `groups`: the mode the start created is immutable, so the read the
                    // desk commits cannot disagree with the receipt about which pipeline this book is on.
                    view: phraseDetailView(storyId)
                };
            }
        )
    });

    return { ...harness, started: () => started, startCalls: () => startCalls };
}

/** Mounts the shell over one Story, with the Story region already open (so the first paint is the desk). */
async function mount(store: DashboardStore) {
    await act(async () => {
        renderWithStore(<StorylineApp store={store} />, store);
    });
}

/** The full choreography: load the list, open the Story, mount. */
async function mountPlotlines(
    wire: Wire = {},
    detail?: PhraseDetailView | ((storyId: string) => Promise<PhraseDetailView>)
) {
    const harness = plotlinesHarness(wire, detail);

    await harness.store.reload();
    await harness.store.openStory('story_1');
    await mount(harness.store);

    return harness;
}

const desk = (): string => String(screen.getByTestId('story-view').textContent);

describe('StorylineApp — Phrase ②’s read reaches the desk’s one model (T-W4)', () => {
    it('carries the chapter entries into the model as their own field, on the story’s own dial', async () => {
        const { client, store } = await mountPlotlines({ mode: 'groups' });

        expect(desk()).toContain('detail:groups');
        // The three materialized entries, as the server's rows — the pane may not invent a chapter.
        expect(desk()).toContain('entries:3');
        // One read, issued by the store when the Story opened, addressing Phrase ② by its catalog key.
        expect(client.getPhraseDetail).toHaveBeenCalledTimes(1);
        expect(client.getPhraseDetail).toHaveBeenCalledWith('story_1', 'plotlines');
        expect(store.getSnapshot().phraseDetails.story_1?.groups.map((entry) => entry.id)).toEqual([
            'entry-chapter_1',
            'entry-chapter_2',
            'entry-chapter_3'
        ]);
    });

    it('asks for no Phrase ② read on a book whose dial the loop never turned on', async () => {
        // THE COST HALF OF THE GATE. A classic Story's Plotlines pane renders §4.3 records off the Story payload
        // it already has; fetching entry rows for it would invent a surface the book does not have — and pay for it
        // on every stream event.
        const { client, store } = await mountPlotlines();

        expect(desk()).toContain('mode:absent');
        expect(desk()).toContain('detail:none');
        expect(client.getPhraseDetail).not.toHaveBeenCalled();
        expect(store.getSnapshot().phraseDetails.story_1).toBeUndefined();
    });

    it("leaves Phrase ②'s slot empty while the read is merely in flight, and keeps the Summary's read intact", async () => {
        // A pending Phrase ② read is NOT a failure and not "no entries": the pane picks its loading line from this
        // absence. And the Summary read still lands, because the two routes are independent.
        const harness = plotlinesHarness({ mode: 'groups' }, () => new Promise<PhraseDetailView>(() => undefined));

        await harness.store.reload();
        await mount(harness.store);

        // `openStory` AWAITS every refetch it starts, including this one, so its own promise never settles here —
        // which is the only way to catch the desk mid-flight. The bounded microtask flush below is not a wait for
        // a duration: every fake resolves on an already-settled promise, so the reads that CAN answer have all
        // committed by tick 20, and the one that cannot is still in flight.
        void harness.store.openStory('story_1');
        await act(async () => {
            for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
        });

        expect(desk()).toContain('title:Hollow Sea');
        expect(desk()).toContain('detail:none');
        expect(desk()).toContain('detailError:none');
        expect(desk()).toContain('phrase:groups');
    });

    it('threads a FAILED Phrase ② read as its own sentence, beside the Summary read that did not fail', async () => {
        const refusal = '503: the chapter entries are unread (the gateway is not answering)';
        const { store } = await mountPlotlines({ mode: 'groups' }, async () => {
            throw new Error(refusal);
        });

        const frame = desk();

        expect(frame).toContain(`detailError:${refusal}`);
        // The Summary read is untouched by a sibling route's failure, and the Story payload survived it.
        expect(frame).toContain('error:none');
        expect(frame).toContain('title:Hollow Sea');
        expect(frame).toContain('detail:none');
        // Cached PER STORY, in its own slot — the Plotlines pane's line, not the Summary's.
        expect(store.getSnapshot().phraseDetailErrors.story_1).toBe(refusal);
        expect(store.getSnapshot().phraseErrors.story_1).toBeUndefined();
    });

    it('hands the handoff flags through verbatim, so the button decides from the projection (D-76)', async () => {
        // The button's enable condition is `summary_compiled`, and its after-state is `phrase_started.plotlines`.
        // Both are the server's predicate; a desk that re-derived them from group rows would disagree with the
        // route's own 409, and the Author would click into a refusal the desk had hidden.
        const harness = await mountPlotlines({ mode: 'classic', started: false, compiled: true });

        expect(desk()).toContain('mode:classic');
        expect(desk()).toContain('started:no');
        expect(desk()).toContain('compiled:yes');
        // A classic book is still a book the Summary can be handed off FROM, and the flags arrive whether or not
        // the Phrase ② rows were fetched — the handoff decision comes before the read does.
        expect(desk()).toContain('detail:none');
        expect(harness.startCalls()).toBe(0);
    });

    it('reports a Summary nobody compiled, which is the arm the button cannot offer', async () => {
        // `compiled:false` is a real state of its own, not "the read is slow": the projection answers the same
        // predicate the start route copies its Seed from, so this is the frame in which the compiled arm would 409.
        const harness = await mountPlotlines({ mode: 'groups', started: false, compiled: false });

        expect(desk()).toContain('compiled:no');
        expect(desk()).toContain('started:no');
        expect(harness.startCalls()).toBe(0);
    });
});

describe('StorylineApp — the Phrase ② verbs are bound on the model’s action object', () => {
    it('binds all three, in the local shapes the panes actually call', async () => {
        await mountPlotlines({ mode: 'groups' });

        const frame = desk();

        expect(frame).toContain('setMode:bound');
        expect(frame).toContain('start:bound');
        expect(frame).toContain('revise:bound');
    });

    it('sends the dial as an explicit mode word on the Story the Author is standing on', async () => {
        const { client } = await mountPlotlines({ mode: 'groups' });

        await click(screen.getByRole('button', { name: 'pane turns the dial off' }));

        // The word travels even though `classic` is the default: a body that omitted the key means "the Author
        // never touched the dial", which is a different request from turning it off.
        expect(client.patchStory).toHaveBeenCalledWith('story_1', { plotlines_mode: 'classic' });
    });

    it('starts the compiled arm by default, and the custom arm with its own text', async () => {
        const { client } = await mountPlotlines({ mode: 'groups' });

        // The handoff button sends nothing: the route resolves an absent body to `compiled`, and a stray `text`
        // beside `compiled` is IGNORED rather than half-applied, so this client never sends both keys.
        await click(screen.getByRole('button', { name: 'pane starts the phrase' }));
        expect(client.startPhrase).toHaveBeenNthCalledWith(1, 'story_1', 'plotlines', undefined);

        // THE LOCAL SHAPE: the pane that does not name the Story still names the phrase, and the body sits in the
        // slot the Story used to hold. A binding that read the body only out of the third slot would start the
        // phrase from the COMPILED Summary and throw the Author's seed away without a word.
        await click(screen.getByRole('button', { name: 'pane starts from a custom seed' }));
        expect(client.startPhrase).toHaveBeenNthCalledWith(2, 'story_1', 'plotlines', {
            source: 'custom',
            text: 'a road that collects'
        });
    });

    it('revises ONE chapter entry by its uuid, with the contract fields rather than prose', async () => {
        const { client } = await mountPlotlines({ mode: 'groups' });

        await click(screen.getByRole('button', { name: 'pane revises one entry' }));

        // `plotpoints`, never `content`: the entry's prose is composed from the contract fields server-side (P4),
        // and the ENTRY is addressed by uuid, so a refetch that reorders the chapters cannot move the write.
        expect(client.revisePhraseEntry).toHaveBeenCalledWith('story_1', 'entry-chapter_2', {
            plotpoints: {
                must_happen: 'the crossing is attempted, and the toll is refused',
                must_change: 'the mentor stops paying for the road'
            },
            note: 'make the toll concrete'
        });
    });

    it('starts the phrase and takes the rail’s tick from the refreshed read, not from the receipt', async () => {
        // THE HANDOFF'S AFTER-STATE, end to end: the desk clicks, the route commits, the post-write re-read answers
        // with `phrase_started.plotlines:true`, and that is what the frame shows. A receipt-driven tick would
        // survive the click and then lie the moment the stream re-read the book.
        const harness = await mountPlotlines({ mode: 'groups', started: false });

        expect(desk()).toContain('started:no');

        await click(screen.getByRole('button', { name: 'pane starts the phrase' }));

        expect(harness.startCalls()).toBe(1);
        expect(desk()).toContain('started:yes');
        // The started phrase keeps its rows on the frame: the pane's surface does not disappear when it starts.
        expect(desk()).toContain('detail:groups');
        expect(desk()).toContain('entries:3');
    });
});

describe('StorylineApp — the rail lists two phrases and keeps the two addresses apart', () => {
    it('numbers Summary ① and Plotlines ②, and moves Characters off the rail into Supplements', async () => {
        await mountPlotlines({ mode: 'groups' });

        const outline = screen.getByTestId('story-outline');

        // The numbered rail is the pipeline: two phrases, in order. Chapters is not on the rail at all, and
        // Characters is no longer a numbered phrase.
        expect(
            Array.from(outline.querySelectorAll('.outline-item--phrase .outline-name')).map((row) => row.textContent)
        ).toEqual(['Summary', 'Plotlines']);

        const characters = Array.from(outline.querySelectorAll<HTMLButtonElement>('button')).find(
            (row) => row.textContent?.includes('Characters')
        );

        expect(characters ?? null).not.toBeNull();
        expect(characters?.closest('[data-testid="outline-supplements"]') ?? null).not.toBeNull();
        // A supplement wears the folder row's class, not the phrase row's: the tick and the phrase state belong to
        // the pipeline, and Characters has neither.
        expect(characters?.className).not.toContain('outline-item--phrase');
    });

    it('addresses a Phrase ② entry as plotlines-group:<uuid> beside the Summary’s summary-group:<uuid>', async () => {
        // Both reads are cached in this one frame, so the rail lists both lists. The PREFIX is the whole
        // difference: the same numeric ref would open the wrong contract in the wrong pane.
        await mountPlotlines({ mode: 'groups' });

        const outline = screen.getByTestId('story-outline');
        const entries = Array.from(
            outline.querySelectorAll<HTMLButtonElement>('#outline-children-plotlines button.outline-child')
        );

        // The row's NAME is the entry's title (`StoryOutline.tsx`'s child row), and its address is the uuid — the
        // two things a rail must not get wrong about a chapter. U-25 puts the phrase's Seed row FIRST, so the
        // entries start at 1 — and the Seed's own address is the synthetic seed ref on the SAME panel, which is the
        // pair `StoryView` routes to that phrase's Seed pane.
        expect(
            entries.map((row) => row.querySelector('.outline-name')?.textContent)
        ).toEqual(['Seed', 'Chapter 1 — The Salt Road', 'Chapter 2 — The Salt Road', 'Chapter 3 — The Salt Road']);

        await click(entries[0]!);
        expect(desk()).toContain('ref:phrase-seed');

        await click(entries[2]!);
        expect(desk()).toContain('ref:plotlines-group:entry-chapter_2');

        const groups = Array.from(
            outline.querySelectorAll<HTMLButtonElement>('#outline-children-summary button.outline-child')
        );

        // U-25 — six: the Summary's Seed row, then the five groups.
        expect(groups).toHaveLength(6);

        await click(groups[4]!);
        expect(desk()).toContain('ref:summary-group:grp-tone');

        // The phrase header still drops the ref and opens that phrase's Overview (U-21).
        const phraseRows = Array.from(outline.querySelectorAll<HTMLButtonElement>('.outline-item--phrase'));
        const plotlinesRow = phraseRows.find((row) => row.textContent?.includes('Plotlines'))!;

        await click(plotlinesRow);
        expect(desk()).toContain('ref:header');
    });
});
