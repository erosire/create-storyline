// Test scaffolding for the W9/W12 shell: an `ApiClient` double plus fixture builders.
//
// WHY A DOUBLE INSTEAD OF `vi.mock('./api')`: `createDashboardStore` takes the client as a
// parameter, so a test injects a fake and asserts the METHOD CALLS the UI made — which is
// exactly the pinned T7 contract. Mocking the module would instead assert that the component
// imported the right symbol, and would leak module state across files.
//
// Named `shell-fakes` (not `fakes`) because the W10/W11 wave owns its own component fixtures;
// one shared file would be a cross-wave write race.
import { act, fireEvent, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import type { ApiClient, QueueItem, StoryRow, StoryView } from '../api';
import { DashboardContext, createDashboardStore, type DashboardStore } from '../state';
import { DEFAULT_AUTO_APPROVE_COSTS, type Goal, type Story } from '../../shared/types';

/** One STORIES-panel row with §4.1-plausible defaults; override what the test cares about. */
export function storyRow(id: string, overrides: Partial<StoryRow> = {}): StoryRow {
    return {
        id,
        title: `story ${id}`,
        phase: 'summary',
        status: 'ready',
        pending_kind: 'none',
        summary_locked: false,
        plotlines_locked: false,
        levels: { summary: '2/2', plotlines: 'n/a', chapters: 'n/a', whole: '2/2' },
        trend: 'unknown',
        auto_approve: [...DEFAULT_AUTO_APPROVE_COSTS],
        active_runs: 0,
        completion_proposed: false,
        ...overrides
    };
}

/** One queue item (U-10), defaulted to a confirmed `major` finding as the Editor rewrote it. */
export function queueItem(id: string, overrides: Partial<QueueItem> = {}): QueueItem {
    return {
        kind: 'finding',
        story_id: 'story_1',
        story_title: 'Hollow Sea',
        id,
        title: 'the mentor dies twice, and the second death goes unnoticed',
        detail: 'ch3 establishes the death as final; ch9 keeps him teaching with no bridge',
        evidence: 'ch3 ¶4 "he died on the beach" · ch9 ¶1 "the mentor corrected the map"',
        cost: 'major',
        created_at: '2026-11-09T10:00:00.000Z',
        ...overrides
    };
}

/** The `GET /stories/:id` read, minimal but complete — `openStory` refreshes a real view. */
export function storyView(row: StoryRow): StoryView {
    const now = '2026-11-09T10:00:00.000Z';
    const story: Story = {
        id: row.id,
        rev: 1,
        created_at: now,
        updated_at: now,
        title: row.title,
        phase: row.phase,
        idea: 'a cartographer maps the sea that ate her fleet',
        summary_locked: row.summary_locked,
        plotlines_locked: row.plotlines_locked,
        pending_kind: row.pending_kind,
        status: row.status,
        status_reason: row.status_reason,
        trend: row.trend,
        auto_approve: row.auto_approve,
        author_stop: row.status === 'stopped',
        progress: row.progress,
        blocked_on: row.blocked_on,
        digest_rev: 1,
        template_refs: [],
        chapter_deps: {}
    };
    const goal: Goal = {
        id: `goal_${row.id}`,
        rev: 1,
        created_at: now,
        updated_at: now,
        story_id: row.id,
        title: 'the book as the Author wants it',
        threshold_soft: 3,
        criteria: [],
        flat_rounds: 4,
        regress_tolerance: 2
    };
    return {
        story,
        summary: null,
        plotlines: [],
        chapters: [],
        goal: { goal, phase_progress: row.levels.summary, failing: [], chapter_progress: {} },
        ideas: [],
        revisions: [],
        findings: [],
        proposals: [],
        runs: [],
        templates: [],
        cost_distribution: { confirmed_per_cost: { critical: 0, major: 0, minor: 0, taste: 0 }, downgrades: 0 },
        completion_preview: null,
        digest: null
    };
}

/**
 * The client double. Every method is a `vi.fn` so an unexpected call is loud, and every
 * default is a resolved value so a refresh-after-mutation (which `state.ts` always does)
 * never hangs a test.
 */
export function fakeApi(overrides: Partial<ApiClient> = {}): ApiClient {
    const base: ApiClient = {
        listStories: vi.fn(async () => [] as StoryRow[]),
        createStory: vi.fn(async (input) => storyRow('story_new', { title: input.title })),
        getStory: vi.fn(async (storyId) => storyView(storyRow(storyId))),
        patchStory: vi.fn(async (storyId) => storyRow(storyId)),
        stop: vi.fn(async (storyId) => storyRow(storyId, { status: 'stopped' })),
        resume: vi.fn(async (storyId) => storyRow(storyId, { status: 'ready' })),
        clearPending: vi.fn(async (storyId) => storyRow(storyId, { status: 'ready', pending_kind: 'none' })),
        lockPhase: vi.fn(async (storyId) => storyRow(storyId, { status: 'ready', pending_kind: 'none' })),
        backtrack: vi.fn(async (storyId) => storyRow(storyId)),
        approveFinding: vi.fn(async (storyId) => storyRow(storyId)),
        discardFinding: vi.fn(async (storyId) => storyRow(storyId)),
        selectIdea: vi.fn(async (storyId) => storyRow(storyId)),
        discardIdea: vi.fn(async (storyId) => storyRow(storyId)),
        deferIdea: vi.fn(async (storyId) => storyRow(storyId)),
        editSection: vi.fn(async (storyId) => storyRow(storyId)),
        unapproveChapter: vi.fn(async (storyId) => storyRow(storyId)),
        // U-10b — the chapter's whole approval (api/routes.ts's `findings/approve-all`).
        approveChapterFindings: vi.fn(async (storyId) => storyRow(storyId)),
        acceptProposal: vi.fn(async (storyId) => storyRow(storyId)),
        rejectProposal: vi.fn(async (storyId) => storyRow(storyId)),
        undo: vi.fn(async (storyId) => storyRow(storyId)),
        // U-13 / D-24 and U-13a / D-23 — the Author's two revision verbs. Both answer with the
        // refreshed stories-row, which is the shape the real routes return.
        selectRevisionAuthor: vi.fn(async (storyId) => storyRow(storyId)),
        mergeRevisions: vi.fn(async (storyId) => storyRow(storyId)),
        sendDirective: vi.fn(async (storyId) => storyRow(storyId)),
        acceptCompletion: vi.fn(async (storyId) => storyRow(storyId, { status: 'completed' })),
        assignTemplates: vi.fn(async (storyId) => storyRow(storyId)),
        patchGoal: vi.fn(async (storyId) => storyView(storyRow(storyId)).goal),
        setChapterBar: vi.fn(async (storyId) => storyRow(storyId)),
        listTemplates: vi.fn(async () => []),
        createTemplate: vi.fn(async () => ({}) as never),
        patchTemplate: vi.fn(async () => ({}) as never),
        listRuns: vi.fn(async () => []),
        killRun: vi.fn(async () => ({}) as never),
        getQueue: vi.fn(async () => [] as QueueItem[]),
        requestAssistant: vi.fn(async () => ({}) as never),
        // The stream is inert in tests: a poll would tick during assertions.
        subscribeEvents: vi.fn(() => () => undefined)
    };
    return { ...base, ...overrides };
}

/**
 * A store over the double, seeded with the rows and queue items a test describes. It hands
 * back the client too, so a test asserts the CALL the UI made rather than a rendered artefact
 * for the write paths — the pinned T7 contract is the method call.
 */
export function fakeHarness(rows: StoryRow[], queue: QueueItem[] = [], overrides: Partial<ApiClient> = {}) {
    const client = fakeApi({
        listStories: vi.fn(async () => rows),
        getQueue: vi.fn(async () => queue),
        getStory: vi.fn(async (storyId) => storyView(rows.find((row) => row.id === storyId) ?? storyRow(storyId))),
        ...overrides
    });
    return { client, store: createDashboardStore(client) };
}

/** Render inside the store's context — the only wrapper a shell component needs. */
export function renderWithStore(ui: ReactNode, store: DashboardStore) {
    return render(<DashboardContext.Provider value={store}>{ui}</DashboardContext.Provider>);
}

/**
 * The one helper the shell tests use: build the harness, load the first read BEFORE mounting
 * (so the first paint already has the rows the test describes), and mount inside `act` so the
 * store's post-write refresh chain settles without React warnings.
 */
export async function renderShell(
    ui: ReactNode,
    rows: StoryRow[] = [],
    queue: QueueItem[] = [],
    overrides: Partial<ApiClient> = {},
    openStoryId?: string
) {
    const harness = fakeHarness(rows, queue, overrides);
    await harness.store.reload();
    // A test that needs THE STORY region mounted selects the Story before mounting, so the
    // first paint is already the selected state rather than a click mid-assertion.
    if (openStoryId) {
        await harness.store.openStory(openStoryId);
    }
    let view!: ReturnType<typeof render>;
    await act(async () => {
        view = renderWithStore(ui, harness.store);
    });
    return { ...harness, ...view };
}

/** Clicks a control and lets every write + refetch the store fires afterwards settle. */
export async function click(element: Element): Promise<void> {
    await act(async () => {
        fireEvent.click(element);
        await Promise.resolve();
        await Promise.resolve();
    });
}

/** Types into a field the way a keyboard does, then settles the store. */
export async function type(element: HTMLElement, value: string): Promise<void> {
    await act(async () => {
        fireEvent.change(element, { target: { value } });
        await Promise.resolve();
    });
}
