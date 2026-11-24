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
    type RevisionMergeRequest,
    type AgentStatusRow,
    type AgentThreadRecord,
    type LoopSettings,
    type PhraseGroupReviseInput,
    type PhraseGroupReviseResult,
    type PhraseView,
    type StoryKnowledgeTree
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
    /**
     * `story_id -> the last SUMMARY PHRASE read` (R6): the five groups, the composed Overview, the
     * findings' group scope and the review state. A SEPARATE cache from `storyViews` because the wire is
     * a separate read (`GET /stories/:id/phrases`), and the group rail must not look like it loaded while
     * only the Story payload landed. Absent means "not loaded" (or it failed — see `phraseErrors`), which
     * is what the panes render as their loading/unavailable state rather than an empty Summary.
     */
    phrases: Record<string, PhraseView>;
    /**
     * `story_id -> the phrase read's last refusal`, the server's own sentence (L-13). A failed phrase read
     * keeps its `storyViews` entry — the rest of the desk is still current — so the Summary pane needs its
     * own honest error line instead of silently rendering the empty state.
     */
    phraseErrors: Record<string, string>;
    /** `story_id -> the durable knowledge directory`, one article per section. */
    knowledge: Record<string, StoryKnowledgeTree>;
    /** U-10 — the cross-Story queue, in the server's order (already triaged by W3/W4f). */
    queue: QueueItem[];
    /** U-7 — runs for the active Story, or every Story when none is selected. */
    runs: Run[];
    /** U-8 — the §4.12 catalogue. */
    templates: Template[];
    /** The global employee roster and every Story thread each employee is working right now. */
    agents: AgentStatusRow[];
    /**
     * U-8 — the employee whose retained threads the content area is showing, or null for the Story
     * (or the Author's queue). Selecting a tile IS this value; the detail lives in the centre.
     */
    selectedAgent: string | null;
    /** `employee kind -> every retained thread, oldest first` (the tile-opened content surface). */
    agentThreads: Record<string, AgentThreadRecord[]>;
    /**
     * U-8 — the provider's model catalog (`GET /agents/models`). The employee tiles offer exactly
     * these ids; an empty list means the catalog has not answered yet, never that typing is allowed.
     */
    agentModels: string[];
    /**
     * S-5 — the loop's fan-out ceiling and its live count (`GET /loop`). `null` until the first read
     * lands: the control renders no number rather than the engine's default, because a default the
     * server never reported is a guess about a setting the Author is about to change.
     */
    loop: LoopSettings | null;
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
    phrases: {},
    phraseErrors: {},
    knowledge: {},
    queue: [],
    runs: [],
    templates: [],
    agents: [],
    selectedAgent: null,
    agentThreads: {},
    agentModels: [],
    loop: null,
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

    const refreshAgents = (): Promise<void> => refresh('agents', async () => ({ agents: await client.listAgents() }));

    /**
     * U-8 — the selected tile's retained threads. One read per employee kind, invalidated by the
     * `runs` event and by every mutation, because a thread closes on the run's own schedule.
     */
    const refreshAgentThreads = (kind: string): Promise<void> =>
        refresh(`agentThreads:${kind}`, async () => {
            const list = await client.listAgentThreads(kind);

            return { agentThreads: { ...snapshot.agentThreads, [kind]: list.threads } };
        });

    /** U-8 — the provider's catalog. Read once per page; a provider restart is a later reload's job. */
    const refreshAgentModels = (): Promise<void> =>
        refresh('agentModels', async () => ({ agentModels: (await client.listAgentModels()).models }));

    /**
     * S-5 — the loop's ceiling, with the live count that gives it meaning. Read at first paint and
     * after the one write that changes it; NOT on the `runs` event, because a thread closing does not
     * move the ceiling and the rail's own tile badges already show what is live (the panel-wide
     * running count is deliberately absent from the employee header).
     */
    const refreshLoop = (): Promise<void> => refresh('loop', async () => ({ loop: await client.getLoopSettings() }));

    const refreshKnowledge = (storyId: string): Promise<void> =>
        refresh(`knowledge:${storyId}`, async () => {
            const tree = await client.getStoryKnowledge(storyId);

            return { knowledge: { ...snapshot.knowledge, [storyId]: tree } };
        });

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

    /** Drops one key from a cached record without mutating the previous snapshot object. */
    const withoutKey = <T,>(cache: Record<string, T>, key: string): Record<string, T> => {
        const next = { ...cache };
        delete next[key];
        return next;
    };

    /**
     * R6 — the SUMMARY PHRASE read, on the same coalesced path as every other resource, so the group rail
     * moves with the stream and with every mutation rather than with a component's own `useEffect`.
     *
     * WHY THE FAILURE IS CAUGHT HERE RATHER THAN LEFT TO `refresh`: a phrase refusal must not blank the
     * desk — the Story payload, the queue and the crew are still current — but it must not look like an
     * unloaded Summary either. So the refusal is CACHED PER STORY (`phraseErrors`, the server's own
     * sentence, L-13) AND raised into the shell-wide `error`, and the cache entry stays absent, which is
     * what the Summary pane renders as "the Summary Phrase read failed" instead of "nothing is written".
     * The next event or poll retries it, exactly as it retries every other failed read.
     */
    const refreshPhrase = (storyId: string): Promise<void> =>
        refresh(`phrase:${storyId}`, async () => {
            try {
                const phrase = await client.getPhrase(storyId);

                return {
                    phrases: { ...snapshot.phrases, [storyId]: phrase },
                    phraseErrors: withoutKey(snapshot.phraseErrors, storyId)
                };
            } catch (error) {
                return {
                    phrases: withoutKey(snapshot.phrases, storyId),
                    phraseErrors: { ...snapshot.phraseErrors, [storyId]: failureText(error) },
                    error: failureText(error)
                };
            }
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
            const refetch: Array<Promise<void>> = [refreshStories(), refreshQueue(), refreshRuns(), refreshAgents()];
            if (touchedStoryId) {
                // R6: the group rail is part of "what the server may have changed". An approval changes a
                // finding's scope, a Writer install moves a group's number, a dispatched pass sets
                // `writer_busy` — all of it rows the phrase read projects, so the Author sees the group
                // rail answer in the same frame they clicked in.
                refetch.push(refreshStory(touchedStoryId), refreshKnowledge(touchedStoryId), refreshPhrase(touchedStoryId));
            }
            if (snapshot.selectedAgent) {
                refetch.push(refreshAgentThreads(snapshot.selectedAgent));
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

        /**
         * The selected Story's SUMMARY PHRASE read (R6), or `null` on the home view. `null` while the read
         * is in flight or has failed is the honest state the Summary panes render — they never fall back to
         * the legacy `view.summary` fields for a group-managed book.
         */
        selectedPhrase(): PhraseView | null {
            return snapshot.activeStoryId ? (snapshot.phrases[snapshot.activeStoryId] ?? null) : null;
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
            void refreshAgents();
            void refreshAgentModels();
            void refreshLoop();
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
                    void refreshAgents();
                    if (snapshot.selectedAgent) void refreshAgentThreads(snapshot.selectedAgent);
                    return;
                }
                if (storyId) {
                    if (storyId === snapshot.activeStoryId) {
                        void refreshStory(storyId);
                        void refreshKnowledge(storyId);
                        // The group rail is the Author's Summary surface: a Writer install, a finding
                        // scope change or a dispatched group pass all land on this Story's phrase rows, so
                        // the stream re-reads them on the same event rather than on a timer.
                        void refreshPhrase(storyId);
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
            // Opening a Story is the explicit way back from an employee's thread surface.
            commit({ activeStoryId: storyId, selectedAgent: null, loading: true });
            return mutate(async () => {
                await Promise.all([
                    refreshStory(storyId),
                    refreshKnowledge(storyId),
                    // R6: the rail's group rows come from the phrase read, so the Story is not "open"
                    // until it has answered. Its failure is cached per Story (see `refreshPhrase`), which
                    // is why this stays one flight rather than a thrown error.
                    refreshPhrase(storyId),
                    refreshRuns(),
                    refreshStories()
                ]);
                return snapshot.stories.find((row) => row.id === storyId) ?? null;
            });
        },
        /** Back to the Author's queue — the home screen (U-10). */
        closeStory(): void {
            commit({ activeStoryId: null, selectedAgent: null, queueStoryFilter: null });
            void refreshRuns();
        },
        /**
         * U-8 — the tile's one verb: the content area becomes that employee's thread surface. A
         * null closes the surface and returns the centre to whatever was underneath it.
         */
        selectAgent(kind: string | null): Promise<void> {
            commit({ selectedAgent: kind });

            return kind === null ? Promise.resolve() : refreshAgentThreads(kind);
        },
        setQueueFilter(storyId: string | null): void {
            commit({ queueStoryFilter: storyId });
        },

        // ---- reads -------------------------------------------------------------------
        reload(): Promise<void> {
            return Promise.all([
                refreshStories(),
                refreshQueue(),
                refreshTemplates(),
                refreshAgents(),
                refreshAgentModels(),
                refreshLoop(),
                refreshRuns(),
                // R6: the group rail reloads with everything else, so "reload the desk" is one verb
                // rather than a rail that quietly keeps last poll's group rows.
                ...(snapshot.activeStoryId ? [refreshPhrase(snapshot.activeStoryId)] : []),
                ...(snapshot.selectedAgent ? [refreshAgentThreads(snapshot.selectedAgent)] : [])
            ]).then(() => undefined);
        },

        // ---- story control (U-3 / P8) ------------------------------------------------
        createStory(input: CreateStoryInput): Promise<StoryRow | null> {
            return mutate(async () => {
                const row = await client.createStory(input);
                // The new Story is immediately THE STORY: the Author just wrote a Seed and the
                // next thing they do is work phase ① (U-12: usable with zero harnesses).
                commit({ activeStoryId: row.id, selectedAgent: null });
                await Promise.all([
                    refreshStory(row.id),
                    refreshKnowledge(row.id),
                    // R6: a new Story is group-managed from its first commit, so the rail has five groups
                    // to show the moment the Author lands on the Summary.
                    refreshPhrase(row.id),
                    refreshStories()
                ]);
                return row;
            });
        },
        /** §10 / P1 — the hard delete: close the Story's view and drop its cached projections. */
        deleteStory(storyId: string): Promise<{ deleted: string } | null> {
            return mutate(async () => {
                const result = await client.deleteStory(storyId);
                const storyViews = { ...snapshot.storyViews };
                const knowledge = { ...snapshot.knowledge };

                delete storyViews[storyId];
                delete knowledge[storyId];

                commit({
                    ...(snapshot.activeStoryId === storyId ? { activeStoryId: null } : {}),
                    storyViews,
                    knowledge,
                    // R6: the deleted book's group rows are gone with it, including a cached refusal —
                    // a Story id can be re-opened, and a stale error would outlive the delete.
                    phrases: withoutKey(snapshot.phrases, storyId),
                    phraseErrors: withoutKey(snapshot.phraseErrors, storyId)
                });

                return result;
            });
        },
        stop: stopStory,
        resume: (storyId: string) => mutate(() => client.resume(storyId), storyId),
        clearPending: (storyId: string) => mutate(() => client.clearPending(storyId), storyId),
        // Phase ①'s "not final yet": queue another three-draft round without touching history. This is
        // the WHOLE-Summary verb, so it belongs to a `summary_mode:'sampling'` book only — the route 409s
        // it on a grouped Story, naming the group revise below (R5).
        requestSummaryRevision: (storyId: string, note?: string) =>
            mutate(() => client.requestSummaryRevision(storyId, note), storyId),
        /**
         * R2 — the Author rewrites ONE GROUP by hand (`POST /stories/:id/phrases/groups/:groupId/revise`).
         * The group is addressed by the UUID the rail carries, so a catalog reorder cannot move the write
         * onto a sibling, and a `writer_busy` group 409s — the control that would click it is disabled off
         * the same projected flag, so the refusal is the guard rather than the routine path.
         *
         * The route answers the whole refreshed phrase view, and it is committed straight away: the pane
         * shows the group's new number and its archived count from the server's own install report, and
         * `mutate`'s choreography then re-reads the Story, the rail and the desk (P1: the durable store is
         * the only memory, so nothing here is patched by hand beyond what the response carried).
         */
        revisePhraseGroup: (storyId: string, groupId: string, input: PhraseGroupReviseInput) =>
            mutate(async () => {
                const result = await client.revisePhraseGroup(storyId, groupId, input);

                commit({ phrases: { ...snapshot.phrases, [storyId]: result.view } });

                return result;
            }, storyId),
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
        sendDirective: (storyId: string, text: string, refs: string[] = []) =>
            mutate(() => client.sendDirective(storyId, text, refs), storyId),
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
        /**
         * U-8 — one employee's model on the global roster. `mutate` already refreshes `agents`, so a
         * tile can never keep showing the model it had before the Author's click.
         */
        setAgentModel: (kind: string, model: string | null) => mutate(() => client.setAgentModel(kind, model)),
        /**
         * S-5 — the ceiling the employee rail edits. `mutate`'s choreography re-reads stories, queue
         * and runs, none of which owns this number, so the action re-reads `loop` itself: the value the
         * control shows afterwards is the one the engine is running, never the one that was typed.
         */
        setLoopLimit: (limit: number) =>
            mutate(async () => {
                const settings = await client.setGlobalMaxConcurrent(limit);
                await refreshLoop();
                return settings;
            }),
        /**
         * U-7's cord. S-RUNTIME: a run id is LOCAL to one Story's book, so the click has to name the Story the
         * run belongs to — the row's own `story_id` when the panel has the row (the cross-Story crew lists
         * every book, and two of them can hold `run_0`), and otherwise the Story the Author is looking at.
         * An unscoped kill is a 409 the moment more than one Story holds the id, so the server never has to
         * guess which thread to abort and the panel never kills a sibling Story's run.
         */
        killRun: (runId: string) =>
            mutate(async () => {
                const storyId =
                    snapshot.runs.find((row) => row.id === runId)?.story_id ?? snapshot.activeStoryId ?? undefined;
                const run = await client.killRun(runId, storyId);
                await Promise.all([refreshRuns(), refreshStories(), refreshAgents()]);
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
                await Promise.all([refreshRuns(), refreshStory(storyId), refreshAgents()]);
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
