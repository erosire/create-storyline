// §10 / W9-W13 — the dashboard's read model: one external store over `api.ts`.
//
// WHY `useSyncExternalStore` RATHER THAN A STATE LIBRARY: the dashboard has exactly one
// kind of state — a mirror of the server's store (P1: the durable store is the only memory,
// so the client holds no authoritative state of its own). A context-of-reducers would
// still need manual tearing guarantees once the SSE handler refetches from outside React;
// `useSyncExternalStore` is the primitive that already has that guarantee, needs no
// dependency, and lets a test build a store around a fake `ApiClient` with no mounting at
// all. No external state library, per the wave's constraint.
//
// THE REFETCH MODEL (this is the important part, not the plumbing): the stream events carry
// only WHICH story changed, never the new state (T7's contract). Every handler therefore
// refetches the touched resource — a push that is dropped, duplicated, or reordered is
// harmless, because the store is re-read rather than patched. That is why a poll fallback in
// `api.ts` is a complete degradation path rather than a lossy one.
//
// ONE FLIGHT PER RESOURCE: sweeps commit constantly (W5/W6), so events arrive in bursts.
// `inFlight` collapses concurrent refreshes of the same resource into the call already
// running — the burst resolves into one render per resource instead of one per event.

import { createContext, createElement, useContext, useSyncExternalStore, type ReactNode } from 'react';
import {
    api,
    ApiError,
    type ApiClient,
    type GoalPatch,
    type GoalSurface,
    type QueueItem,
    type StoryRow,
    type StoryView,
    type StreamKind,
    type UndoTarget,
    type BacktrackPhase,
    type CreateStoryInput,
    type StoryPatch,
    type CreateTemplateInput,
    type AssistantRequest,
    type RevisionMergeRequest
} from './api';
import type { Cost, Run, Template } from '../shared/types';

/** Everything a render may read. One immutable object, replaced wholesale on every change. */
export interface DashboardSnapshot {
    /** U-1 — the STORIES panel's rows, unsorted (the panel owns the awaiting→ready→done order). */
    stories: StoryRow[];
    /** The Story THE STORY region shows; `null` is the Author's queue (U-10 home view). */
    activeStoryId: string | null;
    /** `story_id -> the last full read`, refetched on every event and every local mutation. */
    storyViews: Record<string, StoryView>;
    /** U-10 — the cross-Story queue, in the server's order (already triaged by W3/W4f). */
    queue: QueueItem[];
    /** U-7 — runs for the active Story, or every Story when none is selected. */
    runs: Run[];
    /** U-8 — the §4.12 catalogue. */
    templates: Template[];
    /** U-1c — "work the leftovers" jumps the queue to one Story without leaving the panel. */
    queueStoryFilter: string | null;
    /** U-11 / L-13 — the last refusal, shown as the server wrote it, never swallowed. */
    error: string | null;
    /** True while the first read of a resource is outstanding (the shell shows text, no spinner). */
    loading: boolean;
}

const EMPTY_SNAPSHOT: DashboardSnapshot = {
    stories: [],
    activeStoryId: null,
    storyViews: {},
    queue: [],
    runs: [],
    templates: [],
    queueStoryFilter: null,
    error: null,
    loading: true
};

/** Server-sent sentence for a failure; a non-`ApiError` still has to say something (L-13). */
function failureText(error: unknown): string {
    if (error instanceof ApiError) {
        return error.message;
    }
    if (error instanceof Error) {
        return error.message;
    }
    return `request failed: ${String(error)}`;
}

/**
 * The store. Built over an injected `ApiClient` so the whole shell is testable without a
 * network (`createDashboardStore(fakeClient)`), while the app uses the real one.
 */
export function createDashboardStore(client: ApiClient = api) {
    let snapshot: DashboardSnapshot = EMPTY_SNAPSHOT;
    const listeners = new Set<() => void>();
    /** Resource key -> an already-running refresh, so an event burst refetches once. */
    const inFlight = new Map<string, Promise<void>>();

    /** Shallow-merge and notify. Always a NEW object: `useSyncExternalStore` compares by identity. */
    const commit = (patch: Partial<DashboardSnapshot>): void => {
        snapshot = { ...snapshot, ...patch };
        for (const listener of listeners) {
            listener();
        }
    };

    /** Coalesced read: one call per resource key at a time, and its result lands in the snapshot. */
    const refresh = (key: string, work: () => Promise<Partial<DashboardSnapshot>>): Promise<void> => {
        const running = inFlight.get(key);
        if (running) {
            return running;
        }
        const flight = work()
            .then((patch) => {
                commit(patch);
            })
            .catch((error) => {
                // A failed read is reported, not retried blindly: the next event or the poll
                // fallback re-reads it, and the Author sees why the panel looks stale.
                commit({ error: failureText(error) });
            })
            .finally(() => {
                inFlight.delete(key);
            });
        inFlight.set(key, flight);
        return flight;
    };

    const refreshStories = (): Promise<void> =>
        refresh('stories', async () => ({ stories: await client.listStories(), loading: false }));

    const refreshQueue = (): Promise<void> => refresh('queue', async () => ({ queue: await client.getQueue() }));

    const refreshTemplates = (): Promise<void> =>
        refresh('templates', async () => ({ templates: await client.listTemplates() }));

    const refreshRuns = (): Promise<void> =>
        refresh('runs', async () => ({ runs: await client.listRuns(snapshot.activeStoryId ?? undefined) }));

    const refreshStory = (storyId: string): Promise<void> =>
        refresh(`story:${storyId}`, async () => {
            const view = await client.getStory(storyId);
            const storyViews = { ...snapshot.storyViews, [storyId]: view };
            // The active Story's runs are the crew panel's content (U-7); the view already
            // carries them, so a story refresh keeps `runs` honest without a second request.
            return storyId === snapshot.activeStoryId
                ? { storyViews, runs: view.runs, loading: false }
                : { storyViews, loading: false };
        });

    /**
     * Every mutation follows the same choreography: send, then re-read what the server may
     * have changed. The re-read is not caution, it is the design — a `lock` also empties the
     * Ideas tray (D-36), a `select` hands the Idea to the next Writer's brief (D-29), a
     * leftover approval returns the Story to `ready` (L-37) — side effects only the server
     * knows, and the Author must see them in the same frame they clicked in.
     */
    const mutate = async <T>(work: () => Promise<T>, touchedStoryId?: string): Promise<T | null> => {
        try {
            const result = await work();
            const refetch: Array<Promise<void>> = [refreshStories(), refreshQueue(), refreshRuns()];
            if (touchedStoryId) {
                refetch.push(refreshStory(touchedStoryId));
            }
            await Promise.all(refetch);
            // Cleared only after the refetch, so a refusal from the refresh still surfaces.
            commit({ error: null });
            return result;
        } catch (error) {
            commit({ error: failureText(error) });
            return null;
        }
    };

    // Declared outside the object literal because `stopAll` below reuses it: a method that
    // referenced `store.stop` would be a self-reference inside the initializer, which TS
    // cannot infer (implicit-any error 7022).
    const stopStory = (storyId: string) => mutate(() => client.stop(storyId), storyId);

    const store = {
        // ---- external-store contract -------------------------------------------------
        subscribe(listener: () => void): () => void {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        getSnapshot(): DashboardSnapshot {
            return snapshot;
        },

        /** The selected Story's full read, or `null` on the home view (U-10). */
        selectedStory(): StoryView | null {
            return snapshot.activeStoryId ? (snapshot.storyViews[snapshot.activeStoryId] ?? null) : null;
        },

        /** Reads STORIES rows for the queue jump without re-reading the server. */
        storyRow(storyId: string): StoryRow | undefined {
            return snapshot.stories.find((row) => row.id === storyId);
        },

        // ---- lifecycle ---------------------------------------------------------------
        /**
         * First paint + the stream. Called from the shell's effect; safe to mount twice
         * (React StrictMode) because the teardown really does unsubscribe.
         */
        start(): () => void {
            void refreshStories();
            void refreshQueue();
            void refreshTemplates();
            void refreshRuns();
            // The callback captures `snapshot` lazily, so a `runs` event after a story
            // switch lists the NEW active Story's runs rather than the previous one's.
            const unsubscribe = client.subscribeEvents((kind: StreamKind, storyId?: string) => {
                if (kind === 'queue') {
                    void refreshQueue();
                    return;
                }
                if (kind === 'runs') {
                    void refreshRuns();
                    return;
                }
                if (storyId) {
                    if (storyId === snapshot.activeStoryId) {
                        void refreshStory(storyId);
                    }
                    void refreshStories();
                    void refreshQueue();
                    return;
                }
                void refreshStories();
                void refreshQueue();
            });
            return unsubscribe;
        },

        // ---- navigation --------------------------------------------------------------
        /** Selecting a Story always re-reads it: a cached view would render a stale lock (P1). */
        openStory(storyId: string): Promise<StoryRow | null> {
            commit({ activeStoryId: storyId, loading: true });
            return mutate(async () => {
                await Promise.all([refreshStory(storyId), refreshRuns(), refreshStories()]);
                return snapshot.stories.find((row) => row.id === storyId) ?? null;
            });
        },
        /** Back to the Author's queue — the home screen (U-10). */
        closeStory(): void {
            commit({ activeStoryId: null, queueStoryFilter: null });
            void refreshRuns();
        },
        setQueueFilter(storyId: string | null): void {
            commit({ queueStoryFilter: storyId });
        },

        // ---- reads -------------------------------------------------------------------
        reload(): Promise<void> {
            return Promise.all([refreshStories(), refreshQueue(), refreshTemplates(), refreshRuns()]).then(
                () => undefined
            );
        },

        // ---- story control (U-3 / P8) ------------------------------------------------
        createStory(input: CreateStoryInput): Promise<StoryRow | null> {
            return mutate(async () => {
                const row = await client.createStory(input);
                // The new Story is immediately THE STORY: the Author just wrote a Seed and the
                // next thing they do is work phase ① (U-12: usable with zero harnesses).
                commit({ activeStoryId: row.id });
                await Promise.all([refreshStory(row.id), refreshStories()]);
                return row;
            });
        },
        stop: stopStory,
        resume: (storyId: string) => mutate(() => client.resume(storyId), storyId),
        clearPending: (storyId: string) => mutate(() => client.clearPending(storyId), storyId),
        /**
         * U-3's biggest button. The pinned route table has no global endpoint, so a global
         * Stop is the client issuing P8's cord for every Story that could still be working:
         * `ready` stories and any Story with a live run. `completed` is skipped (nothing is
         * in flight) and an already-`stopped` Story is skipped rather than re-stopped.
         */
        stopAll(): Promise<Array<StoryRow | null>> {
            const targets = snapshot.stories.filter((row) => row.status === 'ready' || row.active_runs > 0);
            return Promise.all(targets.map((row) => stopStory(row.id)));
        },

        // ---- gates (U-16 / §6.3a) ----------------------------------------------------
        lockPhase: (storyId: string) => mutate(() => client.lockPhase(storyId), storyId),
        backtrack: (storyId: string, phase: BacktrackPhase) => mutate(() => client.backtrack(storyId, phase), storyId),

        // ---- the Author's queue (U-10a/b, D-34, D-35) --------------------------------
        approveFinding: (storyId: string, findingId: string, why: string) =>
            mutate(() => client.approveFinding(storyId, findingId, why), storyId),
        // U-10b — the chapter-scale approval. Same `mutate` shape, because the response is a StoryRow
        // and the panes re-read from it (L-1c: the Author's action never patches local state by hand).
        approveChapterFindings: (storyId: string, chapterId: string, why: string) =>
            mutate(() => client.approveChapterFindings(storyId, chapterId, why), storyId),
        discardFinding: (storyId: string, findingId: string, why: string) =>
            mutate(() => client.discardFinding(storyId, findingId, why), storyId),
        selectIdea: (storyId: string, ideaId: string, note: string) =>
            mutate(() => client.selectIdea(storyId, ideaId, note), storyId),
        discardIdea: (storyId: string, ideaId: string) => mutate(() => client.discardIdea(storyId, ideaId), storyId),
        deferIdea: (storyId: string, ideaId: string) => mutate(() => client.deferIdea(storyId, ideaId), storyId),

        // ---- prose (U-5 / U-17 / P9a) -------------------------------------------------
        editSection: (storyId: string, chapterId: string, sectionId: string, content: string) =>
            mutate(() => client.editSection(storyId, chapterId, sectionId, content), storyId),
        unapproveChapter: (storyId: string, chapterId: string) =>
            mutate(() => client.unapproveChapter(storyId, chapterId), storyId),
        acceptProposal: (storyId: string, proposalId: string) =>
            mutate(() => client.acceptProposal(storyId, proposalId), storyId),
        rejectProposal: (storyId: string, proposalId: string) =>
            mutate(() => client.rejectProposal(storyId, proposalId), storyId),
        undo: (storyId: string, target: UndoTarget) => mutate(() => client.undo(storyId, target), storyId),
        // U-13 / D-24 — the Author's pick from the comparison pane. Named `...Author` so it cannot be
        // confused with the crew's `selectRevision` tool, which goes through §7 and the Editor's rules;
        // this one is a direct Author write (D-20a), so there is no permission row to fail.
        selectRevisionAuthor: (storyId: string, revisionId: string, note?: string) =>
            mutate(() => client.selectRevisionAuthor(storyId, revisionId, note), storyId),
        // U-13a / D-23 — the Author's merge request. It queues a task; it does not choose a draft.
        mergeRevisions: (storyId: string, request: RevisionMergeRequest) =>
            mutate(() => client.mergeRevisions(storyId, request), storyId),

        // ---- direction, completion, dial (U-9 / U-14 / U-10a / U-6) -------------------
        sendDirective: (storyId: string, text: string) => mutate(() => client.sendDirective(storyId, text), storyId),
        acceptCompletion: (storyId: string) => mutate(() => client.acceptCompletion(storyId), storyId),
        patchStory: (storyId: string, body: StoryPatch) => mutate(() => client.patchStory(storyId, body), storyId),
        /** D-35 / D-35b — one dial write: the gate AND the drain threshold move together. */
        setAutoApprove: (storyId: string, costs: Cost[]) =>
            mutate(() => client.patchStory(storyId, { auto_approve: costs }), storyId),
        assignTemplates: (storyId: string, templateIds: string[]) =>
            mutate(() => client.assignTemplates(storyId, templateIds), storyId),
        /** The Goal surface is re-read whole: W3 re-derives levels from the new criteria (W3). */
        patchGoal: async (storyId: string, body: GoalPatch): Promise<GoalSurface | null> => {
            const result = await mutate(() => client.patchGoal(storyId, body), storyId);
            return result;
        },
        setChapterBar: (storyId: string, chapterId: string, barOverride: string) =>
            mutate(() => client.setChapterBar(storyId, chapterId, barOverride), storyId),

        // ---- crew + templates (U-7 / U-8) ---------------------------------------------
        killRun: (runId: string) =>
            mutate(async () => {
                const run = await client.killRun(runId);
                await Promise.all([refreshRuns(), refreshStories()]);
                return run;
            }, snapshot.activeStoryId ?? undefined),
        listTemplates: async (): Promise<Template[]> => {
            await refreshTemplates();
            return snapshot.templates;
        },
        createTemplate: async (input: CreateTemplateInput): Promise<Template | null> => {
            const created = await mutate(() => client.createTemplate(input));
            if (created) {
                await refreshTemplates();
            }
            return created;
        },
        patchTemplate: async (templateId: string, body: Partial<Template>): Promise<Template | null> => {
            const patched = await mutate(() => client.patchTemplate(templateId, body));
            if (patched) {
                await refreshTemplates();
            }
            return patched;
        },
        dismissError(): void {
            commit({ error: null });
        },
        requestAssistant: (storyId: string, body: AssistantRequest) =>
            mutate(async () => {
                const run = await client.requestAssistant(storyId, body);
                await Promise.all([refreshRuns(), refreshStory(storyId)]);
                return run;
            }, storyId)
    };

    return store;
}

export type DashboardStore = ReturnType<typeof createDashboardStore>;

// ---------------------------------------------------------------------------
// React binding
// ---------------------------------------------------------------------------

/** The provider is exported (rather than a `<Provider>` wrapper component) to keep this `.ts`. */
export const DashboardContext = createContext<DashboardStore | null>(null);

/**
 * Thin wrapper so a test can mount the shell over a fake client:
 * `<DashboardProvider store={createDashboardStore(fake)}>…</DashboardProvider>`.
 * Written with `createElement` because a `.ts` file cannot hold JSX.
 */
export function DashboardProvider(props: {
    store: DashboardStore;
    children?: ReactNode;
}): ReturnType<typeof createElement> {
    return createElement(DashboardContext.Provider, { value: props.store }, props.children);
}

let defaultStore: DashboardStore | null = null;

/** The app-wide store (real `api`), created on first use so importing this module is side-effect free. */
export function defaultDashboardStore(): DashboardStore {
    if (!defaultStore) {
        defaultStore = createDashboardStore(api);
    }
    return defaultStore;
}

/** The store from context, falling back to the app-wide one when rendered bare. */
export function useDashboardStore(): DashboardStore {
    return useContext(DashboardContext) ?? defaultDashboardStore();
}

/** The reactive read model — re-renders the subscriber on every committed change. */
export function useDashboard(): DashboardSnapshot {
    const store = useDashboardStore();
    return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
