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
    // arrived by reading the Story title back out of the view object and by painting the
    // global rail lead the shell handed it.
    StoryView: (props: { view: { story: { title: string } }; railLead?: unknown }) => (
        <div data-testid="story-view">
            {props.view.story.title}
            {props.railLead as never}
        </div>
    )
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
    it("opens on the Author's queue with the agents rail and the directive bar in place (U-10)", async () => {
        const { store } = harness();
        await store.reload();
        await mount(store);

        expect(screen.getAllByTestId('station')).toHaveLength(1);
        expect(document.querySelectorAll('[data-region]')).toHaveLength(3);
        expect(screen.getByTestId('author-queue')).toBeTruthy();
        expect(screen.getByTestId('new-story-form')).toBeTruthy();
        // The phrases/thread history is not a rail panel; the agents roster is.
        expect(screen.getByTestId('agents-panel')).toBeTruthy();
        expect(screen.getAllByTestId('agents-panel')).toHaveLength(1);
        // The directive bar is the content column's footer, not a window-wide strip.
        expect(screen.getByTestId('directive-bar')).toBeTruthy();
        expect(document.querySelector('[data-region="story"] > .directive-bar')).toBe(
            screen.getByTestId('directive-bar')
        );
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
        expect(screen.getByTestId('story-view').textContent).toContain('Hollow Sea');
        // The employee tiles stay on the right rail, global to every Story, while the centre changes.
        expect(screen.getAllByTestId('agents-panel')).toHaveLength(1);
        expect(document.querySelector('[data-region="crew"]')).toBeNull();
        expect(document.querySelector<HTMLElement>('.station__regions')?.dataset.open).toBe('true');
        // U-9: the directive bar is the content column's footer and is scoped to the selected Story.
        expect(document.querySelector('[data-region="story"] > .directive-bar')).toBe(
            screen.getByTestId('directive-bar')
        );
        expect(document.querySelector<HTMLElement>('.directive-bar')?.dataset.story).toBe('story_1');

        await click(screen.getByRole('button', { name: 'Dismiss' }));
        expect(screen.getByTestId('author-queue')).toBeTruthy();
    });

    it('turns the tile click into the agent thread surface, and back to the Story (U-8)', async () => {
        const threads = [
            {
                thread_id: 'thread-1',
                run_id: 'run_1',
                story_id: 'story_1',
                story_title: 'Hollow Sea',
                phase: 'summary' as const,
                role: 'writer',
                role_name: 'writer',
                title: 'write the summary',
                state: 'torn_down' as const,
                started_at: '2026-11-22T10:00:00.000Z',
                ended_at: '2026-11-22T10:00:02.000Z',
                tokens: 12,
                request: 'Write the Summary.',
                answer: 'Written.',
                retained: true
            }
        ];
        const { store, client } = fakeHarness([storyRow('story_1', { title: 'Hollow Sea' })], [], {
            listAgentThreads: vi.fn(async (kind: string) => ({ kind, threads }))
        });

        await store.reload();
        await store.openStory('story_1');
        await mount(store);

        await click(screen.getByRole('button', { name: /open Writer threads/ }));

        expect(store.getSnapshot().selectedAgent).toBe('writer');
        expect(client.listAgentThreads).toHaveBeenCalledWith('writer');
        expect(screen.getByTestId('agent-threads')).toBeTruthy();
        // The centre changed; the roster stayed as the third column, and the story rail stepped aside.
        expect(document.querySelector<HTMLElement>('.station__regions')?.dataset.open).toBe('false');
        expect(screen.getByTestId('agents-panel')).toBeTruthy();
        expect(screen.queryByTestId('story-view')).toBeNull();

        await click(screen.getByRole('button', { name: 'Dismiss' }));

        expect(store.getSnapshot().selectedAgent).toBeNull();
        expect(screen.getByTestId('story-view')).toBeTruthy();
        expect(screen.queryByTestId('agent-threads')).toBeNull();
    });

    it('deselects the employee when the open tile itself is clicked again (U-8)', async () => {
        const { store } = harness();
        await store.reload();
        await mount(store);

        await click(screen.getByRole('button', { name: /open Writer threads/ }));
        expect(store.getSnapshot().selectedAgent).toBe('writer');
        expect(screen.getByTestId('agent-threads')).toBeTruthy();

        // The whole tile is the switch, so clicking its face deselects just like its title does.
        const writerTile = document.querySelector<HTMLElement>('.sv-agent-tile[data-agent="writer"]')!;
        await click(writerTile);

        expect(store.getSnapshot().selectedAgent).toBeNull();
        expect(screen.queryByTestId('agent-threads')).toBeNull();
    });
});
