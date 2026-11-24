// R6 — the shell carries the phrase read into the desk's one model, and one selection handler both surfaces.
//
// `StorylineApp.test.tsx` pins the shell's regions and store lifecycle with `StoryView` stubbed. This file
// keeps the stub and pins the three facts the group workspace depends on the SHELL for, none of which a
// pane suite can see:
//   - the cached `GET /stories/:id/phrases` read is merged into the `view` the panes receive (the rail's
//     group rows and the Overview's text come from it, and a pane cannot fetch it itself);
//   - the rail lists the five groups from the server's rows, and its click changes the centre;
//   - the panes' own row click navigates through the SAME handler, so a group row in the Overview clears
//     the selected employee exactly the way a rail click does.
import { describe, expect, it, vi } from 'vitest';
import { act, screen } from '@testing-library/react';

import { StorylineApp } from './StorylineApp';
import { click, fakeHarness, renderWithStore, storyRow } from './testing/shell-fakes';
import { groupedPhraseView, phraseView } from './testing/shell-fakes';
import type { DashboardStore } from './state';
import type { PhraseView } from './api';

vi.mock('./components/StoryView', () => {
    // The stub prints what the shell handed the pane: the phrase mode the store cached, the selection the
    // rail is holding, and a button that navigates the way the pane's own group row does.
    const Stub = (props: {
        view: { story: { title: string }; phrase?: { mode: string } | null; phraseError?: string | null };
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
