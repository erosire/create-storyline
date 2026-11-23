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
    it("opens on the tabbed Author's desk, with Requests first and the input bar present (U-10)", async () => {
        const { store } = harness();
        await store.reload();
        await mount(store);

        expect(screen.getAllByTestId('station')).toHaveLength(1);
        expect(document.querySelectorAll('[data-region]')).toHaveLength(3);
        // The home desk is two tabs: Requests first, Create New Story second.
        expect(screen.getByTestId('home-desk')).toBeTruthy();
        expect(screen.getByTestId('author-queue')).toBeTruthy();
        expect(screen.queryByTestId('new-story-form')).toBeNull();
        expect(screen.getByRole('tab', { name: /Requests/ }).getAttribute('aria-selected')).toBe('true');
        // The phrases/thread history is not a rail panel; the agents roster is.
        expect(screen.getByTestId('agents-panel')).toBeTruthy();
        expect(screen.getAllByTestId('agents-panel')).toHaveLength(1);
        // The input is always there; with no Story it is the home prompt path.
        expect(screen.getByTestId('directive-bar')).toBeTruthy();
        expect(document.querySelector<HTMLElement>('.directive-bar__label')?.textContent).toBe('Directive');
    });

    it('switches to the Create New Story tab for the form and labels the prompt (U-12)', async () => {
        const { store } = harness();
        await store.reload();
        await mount(store);

        await click(screen.getByRole('tab', { name: 'Create New Story' }));

        expect(screen.getByTestId('home-create')).toBeTruthy();
        expect(screen.getByTestId('new-story-form')).toBeTruthy();
        expect(screen.getByText('Start a Story')).toBeTruthy();
        expect(screen.queryByTestId('author-queue')).toBeNull();
        expect(document.querySelector<HTMLElement>('.directive-bar__label')?.textContent).toBe(
            'Create New Story'
        );
    });

    it('swaps the queue for the story view and keeps the crew in the third column (U-1b / §10.1)', async () => {
        const { store } = harness();
        await store.reload();
        await mount(store);

        await click(screen.getByRole('button', { name: /Hollow Sea/ }));

        // The bound view reached the story view; the three regions stay side by side.
        expect(screen.getByTestId('story-view').textContent).toContain('Hollow Sea');
        expect(document.querySelectorAll('[data-region]')).toHaveLength(3);
        expect(screen.getAllByTestId('agents-panel')).toHaveLength(1);
        expect(document.querySelector('[data-region="crew"]')).toBeTruthy();
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
        // R7 — the Writer is already the selected thing (its tile is lit, the region is named after
        // it), so the heading says only what the content IS. The accessible name still names the
        // employee, which is the one place the sentence belongs.
        expect(screen.getByRole('heading', { level: 2, name: 'Threads' })).toBeTruthy();
        expect(screen.getByRole('main', { name: 'Writer threads' })).toBeTruthy();
        expect(screen.queryByRole('heading', { name: /Writer — threads/ })).toBeNull();
        // The centre changed; the roster stayed as the third column.
        expect(screen.getByTestId('agents-panel')).toBeTruthy();
        expect(screen.queryByTestId('story-view')).toBeNull();

        await click(screen.getByRole('button', { name: 'Dismiss' }));

        expect(store.getSnapshot().selectedAgent).toBeNull();
        expect(screen.getByTestId('story-view')).toBeTruthy();
        expect(screen.queryByTestId('agent-threads')).toBeNull();
    });

    it('resets the thread surface when the Author switches straight from one employee to another (R7)', async () => {
        // Every thread here is CLOSED, so the Archived tab is the only thing that can make one
        // visible: a choice the Author made in the Writer's list must not carry into the Editor's.
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
        const archivedTab = () => screen.getByRole('button', { name: /Archived/ });

        await store.reload();
        await store.openStory('story_1');
        await mount(store);

        await click(screen.getByRole('button', { name: /open Writer threads/ }));

        // R7 — Writer opens running-only, unpressed, with the zero-running sentence rather than the
        // closed pass the old default showed automatically.
        expect(archivedTab().getAttribute('aria-pressed')).toBe('false');
        expect(screen.queryByText('write the summary')).toBeNull();
        expect(screen.getByText(/no thread is running now/)).toBeTruthy();

        // R9 — the Author opens the history by hand, and it is there.
        await click(archivedTab());
        expect(archivedTab().getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByText('write the summary')).toBeTruthy();

        // A tile-to-tile switch reuses this same region, so the shell keys the surface by employee
        // kind: the Editor gets a fresh view — running-only, Archived unselected.
        await click(screen.getByRole('button', { name: /open Editor threads/ }));

        expect(store.getSnapshot().selectedAgent).toBe('editor');
        expect(client.listAgentThreads).toHaveBeenCalledWith('editor');
        expect(archivedTab().getAttribute('aria-pressed')).toBe('false');
        expect(screen.queryByText('write the summary')).toBeNull();
    });

    it('deselects the employee when the left rail opens a phrase (U-8 / U-4)', async () => {
        const { store } = harness();
        await store.reload();
        await store.openStory('story_1');
        await mount(store);

        await click(screen.getByRole('button', { name: /open Writer threads/ }));
        expect(store.getSnapshot().selectedAgent).toBe('writer');
        expect(screen.getByTestId('agent-threads')).toBeTruthy();

        // The left rail is navigation: opening a phrase changes the centre, so the employee's
        // thread surface must stop being selected in the same click.
        await click(screen.getByRole('button', { name: /Phrase 1/ }));

        expect(store.getSnapshot().selectedAgent).toBeNull();
        expect(screen.getByTestId('story-view')).toBeTruthy();
        expect(screen.queryByTestId('agent-threads')).toBeNull();
    });

    it('brings the Story back when its own row is clicked from an employee thread surface (U-4 / U-8)', async () => {
        const { store } = harness();
        await store.reload();
        await store.openStory('story_1');
        await mount(store);

        await click(screen.getByRole('button', { name: /open Writer threads/ }));
        expect(store.getSnapshot().selectedAgent).toBe('writer');

        await click(screen.getByRole('button', { name: /Hollow Sea/ }));

        expect(store.getSnapshot().selectedAgent).toBeNull();
        expect(store.getSnapshot().activeStoryId).toBe('story_1');
        expect(screen.getByTestId('story-view')).toBeTruthy();
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
