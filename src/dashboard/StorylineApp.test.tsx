// §10.1's composition, verified with the W10/W11 panels replaced by stubs: the shell's own
// behaviour is the home-vs-story switch (U-10), the region grid (§10.1), the bound props, and
// the store lifecycle — none of which is the panels' business, and none of which should depend
// on their fixtures. The stubs keep this hermetic even while the story view is mid-write.
import { describe, expect, it, vi } from 'vitest';
import { act, screen } from '@testing-library/react';
import { StorylineApp } from './StorylineApp';
import { click, fakeHarness, renderWithStore, storyRow } from './testing/shell-fakes';
import type { DashboardStore } from './state';

vi.mock('./components/StoryView', () => ({
    // The one thing the shell owes the story view is the bound props; the stub proves they
    // arrived by reading the Story title back out of the view object.
    StoryView: (props: { view: { story: { title: string } } }) => (
        <div data-testid="story-view">{props.view.story.title}</div>
    )
}));
vi.mock('./components/CrewPanel', () => ({
    CrewPanel: () => <div data-testid="crew-panel" />
}));

/** Mounts the shell inside `act`: its mount effect starts the stream and the first reads. */
async function mount(store: DashboardStore) {
    await act(async () => {
        renderWithStore(<StorylineApp store={store} />, store);
    });
}

function harness() {
    return fakeHarness([
        storyRow('story_1', { title: 'Hollow Sea', status: 'pending', pending_kind: 'phase_signoff' })
    ]);
}

describe('StorylineApp — the four regions (§10.1)', () => {
    it("opens on the Author's queue with the crew rail and the directive bar in place (U-10)", async () => {
        const { store } = harness();
        await store.reload();
        await mount(store);

        expect(screen.getAllByTestId('station')).toHaveLength(1);
        expect(document.querySelectorAll('[data-region]')).toHaveLength(3);
        expect(screen.getByTestId('author-queue')).toBeTruthy();
        expect(screen.getByTestId('new-story-form')).toBeTruthy();
        expect(screen.getByTestId('crew-panel')).toBeTruthy();
        expect(screen.getByTestId('directive-bar')).toBeTruthy();
        // With no Story open the centre region is one column, not the spanned story+rail pair.
        expect(document.querySelector<HTMLElement>('.station__regions')?.dataset.open).toBe('false');
    });

    it('swaps the queue for the story view and hands the third column to its crew rail (U-1b / §10.1)', async () => {
        const { store } = harness();
        await store.reload();
        await mount(store);

        await click(screen.getByRole('button', { name: /Hollow Sea/ }));

        // The bound view reached the story view, and the shell's own crew region steps aside
        // because the rail inside the story view owns the third column now.
        expect(screen.getByTestId('story-view').textContent).toBe('Hollow Sea');
        expect(document.querySelector('[data-region="crew"]')).toBeNull();
        expect(document.querySelector<HTMLElement>('.station__regions')?.dataset.open).toBe('true');
        // U-9: the directive bar is scoped to the selected Story.
        expect(document.querySelector<HTMLElement>('.directive-bar')?.dataset.story).toBe('story_1');

        await click(screen.getByRole('button', { name: 'to the queue' }));
        expect(screen.getByTestId('author-queue')).toBeTruthy();
    });
});
