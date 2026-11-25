// R6 — the shell carries the phrase read into the desk's one model, and one selection handler both surfaces.
//
// `StorylineApp.test.tsx` pins the shell's regions and store lifecycle with `StoryView` stubbed. This file
// keeps the stub and pins the three facts the group workspace depends on the SHELL for, none of which a
// pane suite can see:
//   - the cached `GET /stories/:id/phrases` read is merged into the `view` the panes receive (the rail's
//     group rows and the Overview's text come from it, and a pane cannot fetch it itself);
//   - the rail lists the five groups from the server's rows, and its click changes the centre;
//   - the panes' own row click navigates through the SAME handler, so a group row in the Overview clears
//     the selected employee exactly the way a rail click does;
//   - D-68 — the action object the panes receive carries the Reviewed-Summary choose, and the route's cached
//     409 rides into the same model, because only the shell can keep a refusal alive across the refresh the
//     refusal itself triggers.
import { describe, expect, it, vi } from 'vitest';
import { act, screen } from '@testing-library/react';

import { StorylineApp } from './StorylineApp';
import { click, fakeHarness, renderWithStore, storyRow } from './testing/shell-fakes';
import { groupedPhraseView, phraseView, reviewedPhraseView } from './testing/shell-fakes';
import type { DashboardStore } from './state';
import type { PhraseView } from './api';
import { ApiError } from './api';

vi.mock('./components/StoryView', () => {
    // The stub prints what the shell handed the pane: the phrase mode the store cached, the selection the
    // rail is holding, and a button that navigates the way the pane's own group row does.
    const Stub = (props: {
        view: { story: { title: string }; phrase?: { mode: string } | null; phraseError?: string | null; reviewedError?: string | null };
        actions?: { chooseReviewedSummary?: unknown };
        selection?: { panel: string; ref?: string };
        onSelect?: (selection: { panel: string; ref?: string }) => void;
    }) => (
        <div data-testid="story-view">
            {`title:${props.view.story.title}`}
            {`phrase:${props.view.phrase ? props.view.phrase.mode : 'none'}`}
            {/* R-T2/F2 — the phrase read's cached FAILURE is part of the model the shell hands the panes, so
                the stub prints it the same way it prints the mode: a pane that cannot tell a 503 from a slow
                read has no way to render an actionable state. */}
            {`error:${props.view.phraseError ?? 'none'}`}
            {/* D-68 — the choose's cached 409 rides the SAME model, and the pane has to see it to print it
                beside its own button. `none` is a real state: no refusal, which is not the claim "success". */}
            {`reviewed:${props.view.reviewedError ?? 'none'}`}
            {/* D-68 — the action object is the panes' only write surface, so the stub reports whether the
                choose verb is actually bound. A shell that forgot it leaves the button disabled and this
                line saying `choose:none`. */}
            {`choose:${typeof props.actions?.chooseReviewedSummary === 'function' ? 'bound' : 'none'}`}
            {`ref:${props.selection?.ref ?? 'header'}`}
            <button type="button" onClick={() => props.onSelect?.({ panel: 'summary', ref: 'summary-group:grp-tone' })}>
                pane navigates
            </button>
        </div>
    );

    return { StoryView: Stub };
});

/** Mounts the shell over one Story, with the Story region already open. */
async function mount(store: DashboardStore) {
    await act(async () => {
        renderWithStore(<StorylineApp store={store} />, store);
    });
}

/** The shell over a group-managed book: the phrase read is the five-group projection. */
async function mountGrouped(phrase: PhraseView = groupedPhraseView('story_1')) {
    const harness = fakeHarness([storyRow('story_1', { title: 'Hollow Sea' })], [], {
        getPhrase: vi.fn(async () => phrase)
    });

    await harness.store.reload();
    await harness.store.openStory('story_1');
    await mount(harness.store);

    return harness;
}

describe('StorylineApp — the phrase read reaches the desk’s one model (R6)', () => {
    it("passes the store's cached group rows into the story view, unrequested by any pane", async () => {
        const { client, store } = await mountGrouped();

        expect(screen.getByTestId('story-view').textContent).toContain('phrase:groups');
        // One read, issued by the store when the Story opened — not one per surface that renders a group.
        expect(client.getPhrase).toHaveBeenCalledTimes(1);
        expect(store.selectedPhrase()?.groups).toHaveLength(5);
    });

    it('leaves the phrase absent on a book whose read has not landed, so the pane says so itself (U6)', async () => {
        const harness = fakeHarness([storyRow('story_1', { title: 'Hollow Sea' })], [], {
            getPhrase: vi.fn(async () => {
                throw new Error('the phrase read is unavailable');
            })
        });

        await harness.store.reload();
        await harness.store.openStory('story_1');
        await mount(harness.store);

        expect(screen.getByTestId('story-view').textContent).toContain('phrase:none');
        // The desk is still standing: the Story payload arrived, and one failed read did not take it.
        expect(screen.getByTestId('story-view').textContent).toContain('title:Hollow Sea');
    });

    it('threads a FAILED 503 phrase read into the model as its own state, beside the Story payload (R-T2/F2)', async () => {
        // THE STATE HALF OF F2. `phrases[storyId]` absent cannot say whether the route is still in flight or
        // has already refused; the store caches the server's sentence per Story, and the shell threads it into
        // the one model the panes render. Without that thread the Summary area would draw its loading line
        // over a refusal forever, and the Author would have no way to tell what failed.
        const refusal = '503: the phrase read is offline (maintenance)';
        const harness = fakeHarness([storyRow('story_1', { title: 'Hollow Sea' })], [], {
            getPhrase: vi.fn(async () => {
                throw new Error(refusal);
            })
        });

        await harness.store.reload();
        await harness.store.openStory('story_1');
        await mount(harness.store);

        const desk = String(screen.getByTestId('story-view').textContent);

        expect(desk).toContain('title:Hollow Sea');
        expect(desk).toContain('phrase:none');
        expect(desk).toContain(`error:${refusal}`);
        // The group surface is still empty — the failure is not a claim that the book has no groups — while
        // the Story's own payload is exactly as it was.
        expect(harness.store.selectedPhrase()).toBeNull();
        expect(harness.store.getSnapshot().phraseErrors.story_1).toBe(refusal);
    });

    it('says `none` for the phrase error while the read is merely in flight (F2’s other frame)', async () => {
        // A read that has not answered yet must NOT look like a failure: the panes choose their loading state
        // from exactly this absence, and a pane that printed a failure sentence here would be guessing.
        await mountGrouped();

        expect(String(screen.getByTestId('story-view').textContent)).toContain('error:none');
    });

    it('shows a legacy book its own echo, and no groups anywhere in the rail (U1)', async () => {
        await mountGrouped(phraseView('story_1'));

        expect(screen.getByTestId('story-view').textContent).toContain('phrase:sampling');
        // The rail is the other half of the same read: no group rows, because this book has none.
        for (const title of ['Premise', 'Promise', 'Theme', 'Tone', 'Ending']) {
            expect(screen.queryByRole('button', { name: new RegExp(`^${title}`) })).toBeNull();
        }
    });
});

describe('StorylineApp — the Reviewed Summary verb and its refusal reach the pane (D-68)', () => {
    /** The shell over a book whose reviewed Summary is `ready`, with the choose route under the test's control. */
    async function mountReviewable(choosePhraseReviewed?: () => Promise<never>) {
        // No `summary_mode` on the row: the stub does not read it, and the phrase read this book answers is
        // already the five-group projection, which is the fact the assertions below are about.
        const harness = fakeHarness([storyRow('story_1', { title: 'Hollow Sea' })], [], {
            getPhrase: vi.fn(async () => reviewedPhraseView('story_1', 'ready')),
            ...(choosePhraseReviewed ? { choosePhraseReviewed: vi.fn(choosePhraseReviewed) } : {})
        });

        await harness.store.reload();
        await harness.store.openStory('story_1');
        await mount(harness.store);

        return harness;
    }

    it('binds the choose verb on the model’s action object, so the tab can offer the choice', async () => {
        const { client, store } = await mountReviewable();

        expect(screen.getByTestId('story-view').textContent).toContain('choose:bound');

        // And the binding is the store's, not a stub: firing it as the pane would is ONE route call, and the
        // frame settles from the read the server answers with.
        await act(async () => {
            await store.chooseReviewedSummary('story_1');
        });

        expect(client.choosePhraseReviewed).toHaveBeenCalledTimes(1);
        // The frame ends on the phrase READ, not on the write's echo: `mutate` re-reads the book after every
        // verb, and this fake keeps answering `ready` (the server would answer `chosen`). That is the point —
        // the tab shows what the server reports, never what the response happened to carry.
        expect(store.getSnapshot().phrases.story_1?.reviewed.state).toBe('ready');
        expect(store.getSnapshot().reviewedErrors.story_1).toBeUndefined();
    });

    it("keeps the choose's 409 sentence on the frame after the refresh, so the pane can print it verbatim", async () => {
        // The full loop through the shell: the route refuses, `state.ts` caches the sentence PER STORY, the
        // post-write refresh re-renders the pane (which would otherwise lose an in-component error), and the
        // shell threads the cache back into the same model. Anything shorter and the Author gets a silent
        // greyed button instead of the sentence that names the groups to fix.
        const refusal =
            'this Story has no Reviewed Summary to choose: ending (unwritten), promise (an unresolved issue names it) ' +
            '— a group joins the reviewed Overview only once a cross-group Critic pass closes with no unresolved defect on it (D-67, D-68).';
        const { store } = await mountReviewable(async () => {
            throw new ApiError(409, refusal);
        });

        await act(async () => {
            await store.chooseReviewedSummary('story_1');
        });

        const desk = String(screen.getByTestId('story-view').textContent);

        expect(desk).toContain(`reviewed:${refusal}`);
        // The Summary on screen is still the one the Author was refused about, and the book is intact.
        expect(desk).toContain('phrase:groups');
        expect(store.getSnapshot().phrases.story_1?.reviewed.state).toBe('ready');
        expect(store.getSnapshot().reviewedErrors.story_1).toBe(refusal);
    });

    it('says `none` for the reviewed refusal on a book that has never been refused', async () => {
        // The absence is a state of its own: the pane must not print a refusal sentence it did not receive,
        // and a refusal from ANOTHER book must not follow the Author here.
        const { store } = await mountReviewable();

        expect(screen.getByTestId('story-view').textContent).toContain('reviewed:none');

        await act(async () => {
            await store.chooseReviewedSummary('story_2');
        });

        expect(screen.getByTestId('story-view').textContent).toContain('reviewed:none');
    });
});

describe('StorylineApp — the rail’s group row and the pane’s group row are the same verb', () => {
    it('lists the five groups by title, and a rail click moves the centre to that group', async () => {
        await mountGrouped();

        // The rail's one phrase, then its five groups — the server's rows, in the server's order.
        expect(screen.getByRole('button', { name: /Summary/ })).toBeTruthy();
        for (const [title, ref] of [
            ['Premise', 'summary-group:grp-premise'],
            ['Promise', 'summary-group:grp-promise'],
            ['Theme', 'summary-group:grp-theme'],
            ['Tone', 'summary-group:grp-tone'],
            ['Ending', 'summary-group:grp-ending']
        ]) {
            const row = screen.getByRole('button', { name: new RegExp(`^${title}`) });

            expect(row.closest('[data-testid="story-outline"]')).toBeTruthy();
            await click(row);
            expect(screen.getByTestId('story-view').textContent).toContain(`ref:${ref}`);
        }
    });

    // T3 — the same five rows also arrive WITH scores, and the rail is the one surface where the Author
    // compares them. `groupedPhraseView` scores every group in one pass (84/76/70/88/66), so each row prints
    // its own percentage and the phrase header prints the average those five imply — 384 / 5 = 76.8 → `77%`.
    // Pinned at the shell level on purpose: it proves the number the rail shows is the server's row read
    // through the store, with no re-scoring between the fetch and the column.
    it('prints each group’s percentage on its row and the phrase average on the header (T3)', async () => {
        await mountGrouped();

        const outline = screen.getByTestId('story-outline');

        expect(
            Array.from(outline.querySelectorAll('[data-testid="outline-group-score"]')).map((row) => row.textContent)
        ).toEqual(['84%', '76%', '70%', '88%', '66%']);
        expect(screen.getByTestId('outline-phrase-score').textContent).toBe('77%');
    });

    it('returns to the Overview when the rail’s phrase header is clicked', async () => {
        await mountGrouped();

        await click(screen.getByRole('button', { name: new RegExp('^Theme') }));
        expect(screen.getByTestId('story-view').textContent).toContain('ref:summary-group:grp-theme');

        await click(screen.getByRole('button', { name: /Summary/ }));
        expect(screen.getByTestId('story-view').textContent).toContain('ref:header');
    });

    it('takes the pane’s own navigation through the same handler, clearing the employee view', async () => {
        const { store } = await mountGrouped();

        // The Overview's group row is not a second verb: it is the rail's handler, handed down.
        await click(screen.getByRole('button', { name: 'pane navigates' }));
        expect(screen.getByTestId('story-view').textContent).toContain('ref:summary-group:grp-tone');

        // Standing on an employee's tile, the centre IS the thread surface — the pane is not rendered, so a
        // pane row cannot be the way back.
        await act(async () => {
            await store.selectAgent('writer');
        });

        expect(store.getSnapshot().selectedAgent).toBe('writer');
        expect(screen.queryByTestId('story-view')).toBeNull();

        // …and a group row in the RAIL is a navigation, so it takes the centre back to the Story. One
        // handler for both surfaces is what makes the two behave identically (U2).
        await click(screen.getByRole('button', { name: /^Theme/ }));

        expect(store.getSnapshot().selectedAgent).toBeNull();
        expect(screen.getByTestId('story-view').textContent).toContain('ref:summary-group:grp-theme');
    });
});
