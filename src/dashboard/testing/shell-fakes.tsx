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
import type {
    ApiClient,
    PhraseGroupLockResult,
    PhraseGroupReviseResult,
    PhraseView,
    QueueItem,
    StoryRow,
    StoryView
} from '../api';
import { DashboardContext, createDashboardStore, type DashboardStore } from '../state';
import { DEFAULT_AUTO_APPROVE_COSTS, type Goal, type Story } from '../../shared/types';
import { orderedPhraseGroupDefinitions } from '../../shared/phrase';

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
        cast: [],
        ledger: [],
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
 * R6 — the `GET /stories/:id/phrases` read, DEFAULTING TO THE SAMPLING ECHO the server sends for a legacy book
 * (`mode:'sampling'`, empty rows, never a 404 — `server/api/projections.ts`). That default is what keeps every
 * shell test written before the phrase read existed behaving exactly as it did: a Story with no `summary_mode`
 * is not grouped, so the rail has no groups to draw and the desk shows the round.
 *
 * A grouped test passes `groupedPhraseView` (or its own rows) through `fakeApi({ getPhrase })`.
 */
export function phraseView(storyId: string, overrides: Partial<PhraseView> = {}): PhraseView {
    return {
        story_id: storyId,
        mode: 'sampling',
        phrase_id: null,
        revision: 0,
        overview: '',
        groups: [],
        findings: [],
        tasks: [],
        review: {
            mode: 'sampling',
            unwritten_groups: [],
            written_groups: 0,
            vector: {},
            vector_hash: 'sampling',
            review_seats: 0,
            reviews_on_current_vector: 0,
            deep_reviews_on_current_vector: 0,
            open_findings: 0,
            blocking_findings: 0,
            open_tasks: 0,
            mirror: { summary_id: null, in_sync: true, locked: false, fields: [] }
        },
        ...overrides
    };
}

/**
 * The five SUMMARY GROUPS, built from `shared/phrase`'s own catalog so a test can never drift from the product
 * data (the five keys, titles, descriptions and composition order — and World rules is NOT one of them).
 *
 * The ids are readable, not random: a selection ref is `<prefix><id>`, and a test that asserts a ref
 * (`summary-group:grp-premise`) or a stale-ref fallback reads better with names than with uuids. It also pins
 * the invariant the redesign lives or dies on — the dashboard addresses a group by its id STRING, never by an
 * index or by the shape of the id, so the server's real uuids need no client-side parsing (U2).
 *
 * Defaults: every group written once with clean text, no findings, no open tasks, nothing unwritten. A test
 * overrides the rows it cares about (`groups: [...]`, `findings: [...]`) rather than reading a story out of a
 * fixture it cannot see.
 */
export function groupedPhraseView(storyId: string, overrides: Partial<PhraseView> = {}): PhraseView {
    const groups = orderedPhraseGroupDefinitions().map((definition, index) => ({
        id: `grp-${definition.key}`,
        key: definition.key,
        title: definition.title,
        description: definition.description,
        order: definition.order,
        content: `${definition.title} — the text the Writer installed (group ${index + 1}).`,
        revision: 1,
        updated_by: 'writer',
        previous_content: '',
        history: [
            {
                id: `rev-${definition.key}-1`,
                number: 1,
                state: 'latest',
                at: '2026-11-09T10:00:00.000Z',
                run_ref: 'run_1',
                finding_refs: [],
                task_refs: [],
                chars: 48
            }
        ],
        owed_by_findings: [] as string[],
        writer_busy: false
    }));

    return phraseView(storyId, {
        mode: 'groups',
        phrase_id: 'phrase_summary_1',
        revision: 1,
        overview: groups.map((group) => group.content).join('\n\n'),
        groups,
        review: {
            mode: 'groups',
            unwritten_groups: [],
            written_groups: groups.length,
            vector: Object.fromEntries(groups.map((group) => [group.id, group.revision])),
            vector_hash: 'grp-hash-1',
            review_seats: 1,
            reviews_on_current_vector: 1,
            deep_reviews_on_current_vector: 1,
            open_findings: 0,
            blocking_findings: 0,
            open_tasks: 0,
            mirror: { summary_id: 'sum_1', in_sync: true, locked: false, fields: [] }
        },
        ...overrides
    });
}

/**
 * The client double. Every method is a `vi.fn` so an unexpected call is loud, and every
 * default is a resolved value so a refresh-after-mutation (which `state.ts` always does)
 * never hangs a test.
 */
export function fakeApi(overrides: Partial<ApiClient> = {}): ApiClient {
    // S-5 — the fake keeps the ceiling the way the engine does: the PATCH sets it and `GET /loop`
    // reports it, so a test that writes through `setLoopLimit` can assert the control re-renders from
    // the value the server now holds rather than from the value that was typed.
    let globalMaxConcurrent = 4;

    const base: ApiClient = {
        listStories: vi.fn(async () => [] as StoryRow[]),
        createStory: vi.fn(async (input) => storyRow('story_new', { title: input.title })),
        deleteStory: vi.fn(async (storyId: string) => ({ deleted: storyId })),
        getStory: vi.fn(async (storyId) => storyView(storyRow(storyId))),
        // R6 — the phrase read is a SEPARATE route from `getStory`, and the store caches it separately
        // (`snapshot.phrases`). The default is the sampling echo, so a test that never mentions groups sees the
        // desk it saw before this read existed; a grouped test overrides it.
        getPhrase: vi.fn(async (storyId) => phraseView(storyId)),
        // R2 — the Author's rewrite of ONE group. The result carries the fresh `view`, which is what the store
        // commits immediately (one phrases fetch per mutation, so a test can count the calls).
        revisePhraseGroup: vi.fn(
            async (storyId: string, groupId: string, input): Promise<PhraseGroupReviseResult> => ({
                story_id: storyId,
                phrase_id: 'phrase_summary_1',
                revision: 2,
                installed: [{ group_id: groupId, group_key: 'premise', revision_id: `rev-${groupId}-2`, number: 2 }],
                archived: [{ group_id: groupId, group_key: 'premise', revision_id: `rev-${groupId}-1`, number: 1 }],
                mirror: { summary_id: 'sum_1', fields: ['premise'], written: true },
                view: groupedPhraseView(storyId)
            })
        ),
        // R1 — the two lock verbs, defaulted on the revise route's convention: the result carries the
        // refreshed `view` with THIS group's lock fields moved, which is what `state.ts:groupLockWrite`
        // commits. A test that wants a refusal overrides these with a rejecting `vi.fn` (a 409), so the
        // pane's refusal line is pinned against the same shape the server sends.
        lockPhraseGroup: vi.fn(
            async (storyId: string, groupId: string): Promise<PhraseGroupLockResult> => ({
                story_id: storyId,
                phrase_id: 'phrase_summary_1',
                group_id: groupId,
                locked: true,
                locked_revision: 1,
                locked_by: 'author',
                locked_at: '2026-11-09T10:00:00.000Z',
                view: groupedPhraseView(storyId, {
                    groups: groupedPhraseView(storyId).groups.map((group) =>
                        group.id === groupId
                            ? {
                                  ...group,
                                  locked: true,
                                  locked_revision: group.revision,
                                  locked_by: 'author' as const,
                                  locked_at: '2026-11-09T10:00:00.000Z'
                              }
                            : group
                    )
                })
            })
        ),
        unlockPhraseGroup: vi.fn(
            async (storyId: string, groupId: string): Promise<PhraseGroupLockResult> => ({
                story_id: storyId,
                phrase_id: 'phrase_summary_1',
                group_id: groupId,
                locked: false,
                locked_revision: null,
                locked_by: null,
                locked_at: null,
                view: groupedPhraseView(storyId)
            })
        ),
        getStoryKnowledge: vi.fn(async (storyId) => ({
            story_id: storyId,
            story_title: storyRow(storyId).title,
            sections: [],
            degraded: false
        })),
        listAgents: vi.fn(async () => [
            {
                kind: 'writer',
                title: 'Writer',
                status: 'idle' as const,
                rank: 'A' as const,
                model: 'local/basalt',
                model_source: 'default' as const,
                template_models: [],
                working: [],
                recent: []
            },
            {
                kind: 'editor',
                title: 'Editor',
                status: 'idle' as const,
                rank: 'A' as const,
                model: 'local/basalt',
                model_source: 'default' as const,
                template_models: [],
                working: [],
                recent: []
            },
            {
                kind: 'reader',
                title: 'Reader',
                status: 'idle' as const,
                rank: 'A' as const,
                model: 'local/basalt',
                model_source: 'default' as const,
                template_models: [],
                working: [],
                recent: []
            },
            {
                kind: 'checker',
                title: 'Checker',
                status: 'idle' as const,
                rank: 'A' as const,
                model: 'local/basalt',
                model_source: 'default' as const,
                template_models: [],
                working: [],
                recent: []
            },
            // The fifth roster row (documents/phase-1-research-pipeline.md §3.1): `GET /agents`
            // answers five employees, so the panel tests must cover five tiles, not four.
            {
                kind: 'researcher',
                title: 'Researcher',
                status: 'idle' as const,
                rank: 'A' as const,
                model: 'local/basalt',
                model_source: 'default' as const,
                template_models: [],
                working: [],
                recent: []
            }
        ]),
        // U-8 — the provider catalog the roster dropdown offers.
        listAgentModels: vi.fn(async () => ({
            base_url: 'http://localhost:8800/providers/private/v1',
            models: ['local/basalt']
        })),
        // U-8 — the tile-opened thread surface: empty until a test names the threads it wants.
        listAgentThreads: vi.fn(async (kind: string) => ({ kind, threads: [] })),
        // U-8 — the model write answers the refreshed roster, exactly like the route.
        setAgentModel: vi.fn(async (kind: string, model: string | null) => [
            {
                kind,
                title: kind,
                status: 'idle' as const,
                rank: 'A' as const,
                model: model ?? 'local/basalt',
                model_source: model === null ? ('default' as const) : ('agent' as const),
                template_models: [],
                working: [],
                recent: []
            }
        ]),
        // S-5 — the loop's ceiling: the PATCH sets the number, and both reads report it. `live_runs`
        // stays 0 because the thread fixtures live on the agent rows, not on run rows.
        getLoopSettings: vi.fn(async () => ({ global_max_concurrent: globalMaxConcurrent, live_runs: 0 })),
        setGlobalMaxConcurrent: vi.fn(async (limit: number) => {
            globalMaxConcurrent = limit;

            return { global_max_concurrent: limit, live_runs: 0 };
        }),
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
        requestSummaryRevision: vi.fn(async (storyId) => storyRow(storyId)),
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
