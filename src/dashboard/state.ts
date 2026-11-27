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
    type PhraseGroupLockResult,
    groupLockKey,
    PHRASE_PLOTLINES_KEY,
    type PhraseDetailView,
    type PhraseEntryReviseInput,
    // R1 — the create form's phrase arm renders this list, so the store's snapshot has to name it.
    type PhraseCatalogEntry,
    type PhraseStartInput,
    type PhraseView,
    // R7 — the store's cleanup verb hands the PROPOSAL back to the card that asked (see the verb below).
    type SeedCleanupProposal,
    type StoryKnowledgeTree,
    PAGE_SIZE
} from './api';
// R4 — `ProjectedRun` is the crew listing's row shape (the §4.13 record plus its phrase attribution); `Run`
// itself no longer appears in this file, because every run this store holds came from that listing.
import type { ProjectedRun } from './api';
import type { Cost, Template } from '../types';

/** Everything a render may read. One immutable object, replaced wholesale on every change. */
export interface DashboardSnapshot {
    /** U-1 — the STORIES panel's rows, unsorted (the panel owns the awaiting→ready→done order). */
    stories: StoryRow[];
    /** True while the server holds a chunk after the last row loaded. */
    storiesHasMore: boolean;
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
    /**
     * `story_id -> the last refusal of the Reviewed-Summary choose` (D-68), the server's own sentence.
     *
     * WHY IT IS CACHED RATHER THAN LEFT TO THE SHELL'S `error` LINE. Every mutation already raises its
     * refusal there (L-13), but the three choose refusals are long, group-shaped sentences ("premise
     * (unwritten), ending (an unresolved issue names it) …"), and the decision was made on the Summary tab:
     * the Author needs the sentence beside the Choose button that produced it, and it has to survive the
     * refresh the refusal triggers. It is cleared by the next successful choose and by deleting the Story,
     * so a stale refusal can never sit on a Summary the Author has since chosen.
     */
    reviewedErrors: Record<string, string>;
    /**
     * R1 — `"<story_id>:<group_id>" -> the last refusal of THAT group's lock or unlock`, the server's own sentence.
     *
     * WHY A CACHE RATHER THAN THE SHELL'S `error` LINE. `mutate` already raises every refusal there (L-13), but a
     * lock refusal is about one row of one Summary — "the Writer is rewriting this group", "nothing is written to
     * lock in yet" — and the Author made the decision standing on that group's pane, where the badge and the
     * button are. The shell-wide line is gone the moment anything else succeeds; the cached entry survives the
     * refresh the refusal triggers, so the pane can keep saying WHY the group is not locked instead of showing an
     * unlocked group as if the click had never happened. Keyed by group as well as Story, because a refusal on
     * Tone must not follow the Author into Premise's pane.
     */
    groupLockErrors: Record<string, string>;
    /**
     * T-W4 — `story_id -> the last PHRASE ② read` (`GET /stories/:id/phrases/plotlines`): the chapter entries, the
     * copied Seed's head, the structure brief and that phrase's own review counts.
     *
     * A SECOND CACHE, keyed like `phrases`, because it is a second route and a second phrase. One slot would force
     * the two surfaces to overwrite each other: the rail can be standing on Phrase ② while the Summary's handoff
     * line still reads the Summary's compiled state, and both frames are true at once. Absent means "not loaded"
     * (or it failed — see `phraseDetailErrors`), which is what the Plotlines pane renders as its loading line
     * rather than "this Story has no chapter entries".
     */
    phraseDetails: Record<string, PhraseDetailView>;
    /**
     * T-W4 — `story_id -> the last refusal of THAT phrase's read`, the server's own sentence (L-13). It is kept
     * apart from `phraseErrors` because the two failures are about different surfaces: the Plotlines pane may not
     * print the Summary read's 503 over its chapter entries, and a Phrase ② failure leaves the Summary current.
     */
    phraseDetailErrors: Record<string, string>;
    /** `story_id -> the durable knowledge directory`, one article per section. */
    knowledge: Record<string, StoryKnowledgeTree>;
    /** U-10 — the cross-Story queue, in the server's order (already triaged by W3/W4f). */
    queue: QueueItem[];
    /** True while the server holds another queue chunk. */
    queueHasMore: boolean;
    /**
     * U-7 — runs for the active Story, or every Story when none is selected.
     *
     * R4 — these are the PROJECTED rows (`api.ts:ProjectedRun`): each one carries the phrase it belongs to, which
     * is what the desk prints so a Phrase-② thread cannot read as Phrase-① work (`StoryView.tsx`'s crew line,
     * and `CrewPanel`'s row mark).
     * R10 — BOTH fills now label. `refreshRuns` takes the labelled crew listing, and `refreshStory` below parks
     * the Story payload's `runs` slice in this same slot — a slice that used to carry the plain §4.13 rows, which
     * is why a desk fed by `GET /stories/:id` could only print "phrase not named". `server/api/projections.ts`'s
     * `storyView` runs the identical rule (`projectRunRow`), so the slot reads alike whichever route answered.
     * The field stays OPTIONAL because other routes still answer bare rows (`POST /runs/:id/kill`, the assistant
     * spawn) and the desk renders those with the same honest line rather than inventing a phrase.
     */
    runs: ProjectedRun[];
    /** True while the server holds another runs chunk for the current scope. */
    runsHasMore: boolean;
    /** U-8 — the §4.12 catalogue. */
    templates: Template[];
    /**
     * R1 (W2) — the STARTABLE PHRASE CATALOG (`GET /phrases`), in the server's catalog order, or `null` while it
     * has not landed (or failed — see `phraseCatalogError`).
     *
     * WHY `null` INSTEAD OF `[]`: those two answers reach the Author differently. `null` is "the desk does not know
     * which kinds a Story may start on", and the create form then shows only its "start nothing" arm; `[]` is a
     * server whose catalog offers no on-demand phrase at all, which is a fact about the build, not a missing read.
     * An empty array invented from a failed read would render the second sentence over the first.
     *
     * WHY IT IS CACHED IN THE STORE AND NOT FETCHED BY THE FORM: the same list is the legal `start_phrase` value
     * set and the target of both cleanup verbs, and the store is the desk's only mirror of the server (P1). A form
     * that owned its own fetch would be a second cache with a second idea of "loaded".
     */
    phraseCatalog: PhraseCatalogEntry[] | null;
    /** R1 — the catalog read's own refusal, the server's sentence (L-13), so the form says WHY it offers no phrase. */
    phraseCatalogError: string | null;
    /**
     * R1 (W2) — ONE PENDING LANDING after a create that started a phrase: the Story the create returned, and the
     * phrase key the Author picked.
     *
     * WHY THE STORE HOLDS A NAVIGATION HINT AT ALL: the shell resets the rail to the Summary whenever
     * `activeStoryId` changes (`StorylineApp.tsx`), and a book created straight onto Phrase ② is the one case where
     * that default is a lie — the Author is standing in the phrase's work, not on the Summary. The hint is written
     * by the create and CONSUMED once by the shell, on the frame that proves the phrase started
     * (`story-nav.phraseLandingSelection`), so it never moves the desk on a guess and never outlives the create
     * that asked for it.
     */
    phraseLanding: { story_id: string; phrase_key: string } | null;
    /** The global employee roster and every Story thread each employee is working right now. */
    agents: AgentStatusRow[];
    /**
     * U-8 — the employee whose retained threads the content area is showing, or null for the Story
     * (or the Author's queue). Selecting a tile IS this value; the detail lives in the centre.
     */
    selectedAgent: string | null;
    /** `employee kind -> every retained thread, oldest first` (the tile-opened content surface). */
    agentThreads: Record<string, AgentThreadRecord[]>;
    /** `employee kind -> true while the server holds another thread chunk`. */
    agentThreadsHasMore: Record<string, boolean>;
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
    storiesHasMore: false,
    activeStoryId: null,
    storyViews: {},
    phrases: {},
    phraseErrors: {},
    reviewedErrors: {},
    groupLockErrors: {},
    phraseDetails: {},
    phraseDetailErrors: {},
    knowledge: {},
    queue: [],
    queueHasMore: false,
    runs: [],
    runsHasMore: false,
    templates: [],
    // R1 — the catalog starts UNREAD, not empty: `null` is the state the create form renders as "no phrase offered
    // yet", and only a read that answered `[]` may say the build offers no on-demand phrase at all.
    phraseCatalog: null,
    phraseCatalogError: null,
    phraseLanding: null,
    agents: [],
    selectedAgent: null,
    agentThreads: {},
    agentThreadsHasMore: {},
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

    /** How many rows to ask for on a refresh: at least one chunk, and every chunk already on screen. */
    const loadedLimit = (loaded: number): number => Math.max(PAGE_SIZE, loaded);

    const refreshStories = (): Promise<void> =>
        refresh('stories', async () => {
            const limit = loadedLimit(snapshot.stories.length);
            const stories = await client.listStories({ limit, offset: 0 });

            return { stories, storiesHasMore: stories.length === limit, loading: false };
        });

    const refreshQueue = (): Promise<void> =>
        refresh('queue', async () => {
            const limit = loadedLimit(snapshot.queue.length);
            const queue = await client.getQueue({ limit, offset: 0 });

            return { queue, queueHasMore: queue.length === limit };
        });

    const refreshTemplates = (): Promise<void> =>
        refresh('templates', async () => ({ templates: await client.listTemplates() }));

    /**
     * R1 (W2) — the STARTABLE PHRASE CATALOG, read once with the rest of the desk rather than by the create form.
     *
     * THE FAILURE KEEPS THE SLOT `null` AND CACHES ITS OWN SENTENCE, the `refreshPhrase` pattern one resource over
     * (`state.ts:refreshPhrase`): the form must be able to tell "the desk does not know what a Story can start on"
     * from "this build offers no on-demand phrase", and an empty array committed from a 503 would print the second
     * sentence over the first. The server's sentence rides `phraseCatalogError` (L-13) AND the shell's `error`, the
     * same two channels every other cached refusal uses.
     */
    const refreshPhraseCatalog = (): Promise<void> =>
        refresh('phraseCatalog', async () => {
            try {
                return {
                    phraseCatalog: await client.getPhraseCatalog(),
                    phraseCatalogError: null
                };
            } catch (error) {
                return {
                    // Absent is the honest word: the read did not answer, so the catalog is unknown, not empty.
                    phraseCatalog: null,
                    phraseCatalogError: failureText(error),
                    error: failureText(error)
                };
            }
        });

    const refreshAgents = (): Promise<void> => refresh('agents', async () => ({ agents: await client.listAgents() }));

    /**
     * U-8 — the selected tile's retained threads. One read per employee kind, invalidated by the
     * `runs` event and by every mutation, because a thread closes on the run's own schedule.
     */
    const refreshAgentThreads = (kind: string): Promise<void> =>
        refresh(`agentThreads:${kind}`, async () => {
            const loaded = snapshot.agentThreads[kind] ?? [];
            const limit = loadedLimit(loaded.length);
            const list = await client.listAgentThreads(kind, { limit, offset: 0 });

            return {
                agentThreads: { ...snapshot.agentThreads, [kind]: list.threads },
                agentThreadsHasMore: { ...snapshot.agentThreadsHasMore, [kind]: list.threads.length === limit }
            };
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
        refresh('runs', async () => {
            const limit = loadedLimit(snapshot.runs.length);
            const runs = await client.listRuns(snapshot.activeStoryId ?? undefined, { limit, offset: 0 });

            return { runs, runsHasMore: runs.length === limit };
        });

    const refreshStory = (storyId: string): Promise<void> =>
        refresh(`story:${storyId}`, async () => {
            const view = await client.getStory(storyId);
            const storyViews = { ...snapshot.storyViews, [storyId]: view };
            // The active Story's runs are the crew panel's content (U-7); the view already
            // carries them, so a story refresh keeps `runs` honest without a second request.
            // R10 — that carried slice is LABELLED at the source (`projections.ts:storyView` → `projectRunRow`),
            // so this shortcut cannot leave the crew slot with unlabelled rows while `GET /runs` has labels.
            return storyId === snapshot.activeStoryId
                ? { storyViews, runs: view.runs, runsHasMore: false, loading: false }
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
     * T-W4 — the PHRASE ② read, on the same coalesced path as every other resource (`refreshPhrase`'s shape, for
     * the same reasons): the chapter entries must move with the stream and with each mutation, and a refusal must
     * not blank the desk.
     *
     * WHY IT IS LOADED ON DEMAND RATHER THAN WITH THE STORY. `mutate` and `selectStory` refresh this read only when
     * the surface is ALREADY open (`phraseDetails[storyId]` is cached, or a Phrase ② verb just ran), because the
     * desk's default frame is the Summary and a Story whose Plotlines are classic can never show the entries. A
     * poll that fetched the Phrase ② rows for every Story on the desk would be paying for a surface nobody is
     * looking at — and `story.plotlines_mode` already answers the mode question without the rows.
     *
     * The failure is cached per Story in its own slot (`phraseDetailErrors`), never in `phraseErrors`: the two
     * routes fail about different surfaces, and the Plotlines pane may not print the Summary read's sentence.
     *
     * R1 (W2) — THE PHRASE KEY IS AN ARGUMENT, NOT A DEFAULT THE CALLER FORGOT. `POST /stories`' `start_phrase` can
     * name any startable kind, and the create that opens a book on a phrase has to read THAT phrase's surface — a
     * client that quietly re-read `'plotlines'` for a create that started something else is the same hardcoded pair
     * the catalog read exists to remove (P15). The parameter defaults to Phrase ② because that is the only kind with
     * a pane today, and every existing call site means exactly that.
     */
    const refreshPhraseDetail = (storyId: string, phraseKey = PHRASE_PLOTLINES_KEY): Promise<void> =>
        refresh(`phrase-detail:${storyId}:${phraseKey}`, async () => {
            try {
                const phrase = await client.getPhraseDetail(storyId, phraseKey);

                return {
                    phraseDetails: { ...snapshot.phraseDetails, [storyId]: phrase },
                    phraseDetailErrors: withoutKey(snapshot.phraseDetailErrors, storyId)
                };
            } catch (error) {
                return {
                    phraseDetails: withoutKey(snapshot.phraseDetails, storyId),
                    phraseDetailErrors: { ...snapshot.phraseDetailErrors, [storyId]: failureText(error) },
                    error: failureText(error)
                };
            }
        });

    /**
     * T-W4 — does this Story's Phrase ② read belong in the frame at all?
     *
     * TWO HONEST REASONS, and nothing else: the dial says the entries are the surface (`story.plotlines_mode`), or
     * the surface is already open in this session and has to keep up with the stream. A classic book therefore pays
     * for no Phrase ② reads — its Plotlines pane renders the §4.3 records off the Story payload it already has —
     * and a Story whose dial the Author just turned on starts fetching them with that write (see `setPlotlinesMode`).
     */
    const phraseDetailWanted = (storyId: string): boolean =>
        snapshot.phraseDetails[storyId] !== undefined || snapshot.storyViews[storyId]?.plotlines_mode === 'groups';

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

                // T-W4 — Phrase ② is part of "what the server may have changed" WHILE ITS SURFACE IS OPEN. The
                // entries move under the same writes the groups do (a Writer install, a finding's scope, a lock), and
                // an Author standing on a chapter entry has to see it move in the frame they clicked in. The cache
                // check is what keeps the desk from fetching a surface nobody opened: `phraseDetails[storyId]` is
                // present from the moment the rail selects Phrase ② or a Phrase ② verb runs, and absent for every
                // classic book, whose Plotlines pane needs no rows.
                if (phraseDetailWanted(touchedStoryId)) {
                    refetch.push(refreshPhraseDetail(touchedStoryId));
                }
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

    /**
     * R1 — the refreshed phrase read out of a lock/unlock response, TOLERANT BY CONSTRUCTION.
     *
     * The revise and choose routes both answer `{…, view}` and the store commits that object (R2/D-68). The lock
     * routes are being landed by another wave, so the client accepts either of the two bodies that wave can
     * honestly send — the `{…, view}` envelope, or the phrase read itself — and falls back to `undefined` for
     * anything else. `undefined` is not "nothing changed": it means the response carried no rows, so `mutate`'s
     * own `refreshPhrase(touchedStoryId)` is what puts the new lock state on screen. A cache entry invented from
     * a body that never carried group rows WOULD be a lie, so nothing is written in that case.
     */
    const lockViewOf = (result: unknown): PhraseView | undefined => {
        const body = result as (PhraseGroupLockResult & Partial<PhraseView>) | undefined;
        const candidate = (body?.view ?? body) as PhraseView | undefined;

        // `groups` is the phrase read's own discriminator (`api.ts:PhraseView`), so this cannot mistake a Story
        // row or an install report for group rows.
        return candidate !== undefined && Array.isArray(candidate.groups) ? candidate : undefined;
    };

    /**
     * T-W4 — WHICH PHRASE a group row belongs to, read off the caches rather than guessed from the verb.
     *
     * The lock and unlock routes address a group ROW by its UUID, and every phrase's rows carry their own UUIDs, so
     * the row itself decides which surface a write lands on — and the route answers with THAT phrase's read
     * (`routes.ts:phraseVerbView`: the Summary's `PhraseView`, Phrase ②'s `PhraseDetailView`). Committing a chapter
     * entry's refreshed read into `phrases[]` would put chapter rows in the Summary's slot, so the store asks its
     * own caches which one holds the id.
     *
     * R5 — THE `'summary'` FALLBACK IS GONE. It used to answer Summary for a row neither cache held, on the
     * theory that `mutate`'s own re-read would sort it out afterwards. That guess is how a chapter entry ended
     * up rendered inside the Summary surface: a Phrase-② read that has not landed yet — or a stale copy written
     * before the entry existed — reports no such row, so the row's phrase was decided by ABSENCE, and the
     * Summary slot was left holding five sections plus a chapter. The answers now are the ones the desk can
     * defend:
     *
     *   1. `'plotlines'` / `'summary'` — one of the two caches HOLDS the row. Present is present;
     *   2. `'unassigned'` — neither cache holds it and the refreshed read names no phrase either, so NOTHING is
     *      committed into either slot: a row the desk has not read is a row it may not file;
     *   3. before (2) is reached, a Phrase-② read this Story wants but has not landed (or has landed without the
     *      row) is fetched ONCE — `refresh` is coalesced, so that is at most one flight — because "not loaded"
     *      is exactly the state the mis-slot came from.
     *
     * A classic book, whose Plotlines pane needs no entry rows, is never asked (the same `phraseDetailWanted`
     * gate every other Phrase-② read uses), and the Summary path does not move: a Summary section IS in the
     * Summary cache, so rule (1) answers it before any of this runs.
     */
    type PhraseSurface = 'summary' | 'plotlines' | 'unassigned';

    const groupSurfaceOf = (storyId: string, groupId: string): PhraseSurface => {
        if (snapshot.phraseDetails[storyId]?.groups.some((row) => row.id === groupId) === true) return 'plotlines';
        if (snapshot.phrases[storyId]?.groups.some((row) => row.id === groupId) === true) return 'summary';

        return 'unassigned';
    };

    /**
     * R5 — the phrase the ROUTE'S OWN ANSWER names, the most authoritative witness available.
     *
     * `routes.ts:phraseVerbView` picks the refreshed read from the GROUP ROW's phrase, so a chapter entry's lock
     * answers with the Phrase-② read — and that read carries `key:'plotlines'` (`api.ts:PhraseDetailView`), the
     * catalog kind it is scoped to. The Summary's `PhraseView` has no `key` field at all, so the ABSENCE of one is
     * itself the Summary's signature. Either way the store is reading an answer rather than inferring from which
     * cache happens to be warm. A key naming a phrase this desk does not slot (the catalog has two today) stays
     * `'unassigned'`: filing it under the Summary would be the same invention R5 removes.
     */
    const surfaceOfLockView = (view: PhraseView): 'summary' | 'plotlines' | 'unassigned' => {
        const key = (view as Partial<PhraseDetailView>).key;

        if (key === undefined) return 'summary';
        if (key === PHRASE_PLOTLINES_KEY) return 'plotlines';

        return 'unassigned';
    };

    /**
     * R5 — the slot a lock/unlock response belongs in, in the order the answers arrive: the response's own `key`,
     * then the cache that holds the row, then one forced Phrase-② read, then "nowhere".
     */
    const phraseSurfaceFor = async (storyId: string, groupId: string, view: PhraseView): Promise<PhraseSurface> => {
        const named = surfaceOfLockView(view);

        if (named !== 'unassigned') return named;

        const cached = groupSurfaceOf(storyId, groupId);

        if (cached !== 'unassigned') return cached;
        if (!phraseDetailWanted(storyId)) return 'unassigned';

        await refreshPhraseDetail(storyId);

        return groupSurfaceOf(storyId, groupId);
    };

    /**
     * R1 — one group lock/unlock write, in `chooseReviewedSummary`'s exact choreography (see the two verbs
     * below for what each route is for). `verb` is the cache's own name for the failure line, never a claim
     * about what the route did.
     */
    const groupLockWrite = (
        verb: 'lock' | 'unlock',
        storyId: string,
        groupId: string,
        run: () => Promise<PhraseGroupLockResult>
    ): Promise<PhraseGroupLockResult | null> =>
        mutate(async () => {
            const key = groupLockKey(storyId, groupId);

            try {
                const result = await run();
                const view = lockViewOf(result);
                // R5 — the slot is decided from the ANSWER, and only when there is one. A route that sent no group
                // rows (`lockViewOf` → `undefined`) commits nothing either way, so there is no surface to work out
                // and no Phrase-② read to chase in order to work it out.
                const surface = view === undefined ? 'unassigned' : await phraseSurfaceFor(storyId, groupId, view);

                commit({
                    ...(view === undefined || surface === 'unassigned'
                        ? {}
                        : surface === 'plotlines'
                          ? // The refreshed read a Phrase ② route answers with is a `PhraseDetailView`; the lock
                            // routes may also send the plain rows, and `surfaceOfLockView` proved its key says
                            // plotlines — which is what makes this cast an answer rather than a guess.
                            { phraseDetails: { ...snapshot.phraseDetails, [storyId]: view as PhraseDetailView } }
                          : { phrases: { ...snapshot.phrases, [storyId]: view } }),
                    // Cleared on the way through, so a stale refusal from an earlier click on THIS group cannot
                    // outlive the write that answered it.
                    groupLockErrors: withoutKey(snapshot.groupLockErrors, key)
                });

                return result;
            } catch (cause) {
                // The server's own sentence, verbatim (L-13) — and the verb named, so a pane printing it says
                // which click refused even after the Author has moved to another group.
                const sentence = failureText(cause);

                commit({
                    groupLockErrors: {
                        ...snapshot.groupLockErrors,
                        [key]: `${verb === 'lock' ? 'Locking' : 'Unlocking'} this group was refused: ${sentence}`
                    }
                });
                throw cause;
            }
        }, storyId);

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

        /**
         * The selected Story's PHRASE ② read (T-W4), or `null` on the home view and `null` while that read is in
         * flight or has failed. Its cache is per-Story like every other one here, and the Plotlines pane renders the
         * two nulls apart through `phraseDetailError` — a read still on its way is not "this Story has no entries".
         */
        selectedPhraseDetail(): PhraseDetailView | null {
            return snapshot.activeStoryId ? (snapshot.phraseDetails[snapshot.activeStoryId] ?? null) : null;
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
            // R1 — the create form's phrase arm reads the catalog, and the desk is standing on that form for an
            // Author with no Story open; a catalog that arrives after the form paints is a selector that fills in
            // under the Author's hand.
            void refreshPhraseCatalog();
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
                        // T-W4 — and the same for the chapter entries, while that surface is the Story's
                        // (`phraseDetailWanted`), so an install on a chapter entry moves the pane the Author is on.
                        if (phraseDetailWanted(storyId)) void refreshPhraseDetail(storyId);
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
                // T-W4 — the Phrase ② rows arrive with the Story only when the dial says they are the surface
                // (`phraseDetailWanted`), so opening a classic Story stays one fewer flight and a grouped Story
                // never renders a Phrase ② pane that says "the read has not landed" when it never started.
                if (phraseDetailWanted(storyId)) {
                    await refreshPhraseDetail(storyId);
                }
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

        /** U-1 — fetch the next Stories chunk and append it. */
        async loadMoreStories(): Promise<void> {
            if (!snapshot.storiesHasMore) return;

            try {
                const items = await client.listStories({ limit: PAGE_SIZE, offset: snapshot.stories.length });

                commit({
                    stories: [...snapshot.stories, ...items],
                    storiesHasMore: items.length === PAGE_SIZE
                });
            } catch (error) {
                commit({ error: failureText(error) });
            }
        },
        /** U-10 — fetch the next queue chunk and append it. */
        async loadMoreQueue(): Promise<void> {
            if (!snapshot.queueHasMore) return;

            try {
                const items = await client.getQueue({ limit: PAGE_SIZE, offset: snapshot.queue.length });

                commit({ queue: [...snapshot.queue, ...items], queueHasMore: items.length === PAGE_SIZE });
            } catch (error) {
                commit({ error: failureText(error) });
            }
        },
        /** U-7 — fetch the next crew chunk for the current Story scope. */
        async loadMoreRuns(): Promise<void> {
            if (!snapshot.runsHasMore) return;

            try {
                const items = await client.listRuns(snapshot.activeStoryId ?? undefined, {
                    limit: PAGE_SIZE,
                    offset: snapshot.runs.length
                });

                commit({ runs: [...snapshot.runs, ...items], runsHasMore: items.length === PAGE_SIZE });
            } catch (error) {
                commit({ error: failureText(error) });
            }
        },
        /** U-8 — fetch the next thread chunk for one employee and append it. */
        async loadMoreAgentThreads(kind: string): Promise<void> {
            if (!(snapshot.agentThreadsHasMore[kind] ?? false)) return;

            try {
                const loaded = snapshot.agentThreads[kind] ?? [];
                const list = await client.listAgentThreads(kind, { limit: PAGE_SIZE, offset: loaded.length });

                commit({
                    agentThreads: { ...snapshot.agentThreads, [kind]: [...loaded, ...list.threads] },
                    agentThreadsHasMore: {
                        ...snapshot.agentThreadsHasMore,
                        [kind]: list.threads.length === PAGE_SIZE
                    }
                });
            } catch (error) {
                commit({ error: failureText(error) });
            }
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
                // R1 — "reload the desk" re-reads the catalog too: a phrase kind the server turned on mid-session
                // should reach the create form on the same press that reloads everything else.
                refreshPhraseCatalog(),
                // R6: the group rail reloads with everything else, so "reload the desk" is one verb
                // rather than a rail that quietly keeps last poll's group rows.
                ...(snapshot.activeStoryId ? [refreshPhrase(snapshot.activeStoryId)] : []),
                ...(snapshot.selectedAgent ? [refreshAgentThreads(snapshot.selectedAgent)] : [])
            ]).then(() => undefined);
        },

        // ---- story control (U-3 / P8) ------------------------------------------------
        /**
         * R1 / R2 / R4 (W2) — the create, with the three things the Author just decided: the Seed, WHICH PHRASE the
         * book opens on (`start_phrase`, a catalog key), and the chapter count they declared or left to the Editor
         * (`chapter_count`).
         *
         * THE PHRASE START IS NOT A SECOND PRESS, AND THE DESK MUST NOT WAIT FOR ONE. The engine starts that
         * phrase's controller in the SAME commit as the Story rows and moves the pointer to the phase its catalog
         * row names (`routes.ts`), so `GET /stories/:id` already answers `phrase_started[key] === true` when this
         * verb's re-read lands. Two consequences, both handled here:
         *
         *   1. the phrase's OWN read is fetched (`refreshPhraseDetail`) even though `phraseDetailWanted` is still
         *      false — the cache is empty on a book that is one frame old, and the Plotlines pane would otherwise
         *      print "no entries" at a phrase the create just started (and `PhraseSeedPane` would have no Seed to
         *      show, which is R3's whole point); and
         *   2. the shell is handed the landing hint (`phraseLanding`), because the rail's default is the Summary and
         *      a book created onto Phrase ② is open ON its work. The hint is consumed by the frame that PROVES the
         *      start (`story-nav.phraseLandingSelection`), so a create whose read has not landed still opens on the
         *      Summary rather than on a guess.
         *
         * A create with NO `start_phrase` changes none of that: no hint, and the Phrase ② read stays unrequested for
         * a book that has not started the phrase (the store fetches no surface a Story does not have).
         */
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
                    refreshStories(),
                    // R1 — the phrase the create itself started. Addressed by the key the Author picked, never by a
                    // default, and only when they picked one.
                    ...(input.start_phrase === undefined
                        ? []
                        : [refreshPhraseDetail(row.id, input.start_phrase), refreshPhrase(row.id)])
                ]);
                // R1 — the landing hint rides the SUCCESS, after the re-reads, so the shell's next frame can check
                // it against a payload that has had its chance to answer.
                if (input.start_phrase !== undefined) {
                    commit({ phraseLanding: { story_id: row.id, phrase_key: input.start_phrase } });
                }
                return row;
            });
        },
        /**
         * R1 — the shell consumes the pending create landing. One read, and it CLEARS: a hint that outlived the
         * frame it was written for would move the rail on a later, unrelated open of the same Story.
         */
        takePhraseLanding(): { story_id: string; phrase_key: string } | null {
            const pending = snapshot.phraseLanding;

            if (pending === null) return null;

            commit({ phraseLanding: null });

            return pending;
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
                    phraseErrors: withoutKey(snapshot.phraseErrors, storyId),
                    // T-W4 — the Phrase ② read and its failure go with the Story: a deleted Story has no phrase to
                    // read, and a cached refusal would outlive the thing it refused.
                    phraseDetails: withoutKey(snapshot.phraseDetails, storyId),
                    phraseDetailErrors: withoutKey(snapshot.phraseDetailErrors, storyId),
                    // D-68: a Story id can be re-opened, and a choose refusal from the deleted book would
                    // otherwise sit on the Summary tab of whatever took its id.
                    reviewedErrors: withoutKey(snapshot.reviewedErrors, storyId),
                    // R1: the same rule per GROUP — the keys are `<storyId>:<groupId>`, so every entry the
                    // deleted book owned goes with it rather than greeting the next Story that takes the id.
                    groupLockErrors: Object.fromEntries(
                        Object.entries(snapshot.groupLockErrors).filter(
                            ([key]) => !key.startsWith(`${storyId}:`)
                        )
                    )
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
         * R1 — the Author locks one group in, and opens it again (`POST …/groups/:id/lock` and `…/unlock`).
         *
         * SAME CHOREOGRAPHY AS THE REVISE AND THE CHOOSE, for the same reasons: the route answers the refreshed
         * phrase read (R2/D-68's convention), the store commits it straight away so the badge and the rail move
         * in the frame the Author clicked in, and `mutate` then re-reads the Story, the rail and the desk
         * (P1 — nothing is patched by hand beyond what the response carried).
         *
         * THE REFUSAL IS CACHED PER GROUP, not only in the shell-wide `error`: the two refusals this route can
         * raise are row-shaped sentences ("the Writer is replacing this text", "there is nothing written to lock
         * in yet"), and the Author needs them beside the button that raised them, through the refresh the refusal
         * triggers. It is rethrown so `mutate` still commits its own `error` and answers `null`, like every other
         * verb — and because the answer is `null`, the pane never reads a refused lock as success: the badge it
         * prints comes from the phrase read the server sent, which still says the group is unlocked.
         */
        lockPhraseGroup: (storyId: string, groupId: string) =>
            groupLockWrite('lock', storyId, groupId, () => client.lockPhraseGroup(storyId, groupId)),
        unlockPhraseGroup: (storyId: string, groupId: string) =>
            groupLockWrite('unlock', storyId, groupId, () => client.unlockPhraseGroup(storyId, groupId)),
        /**
         * R2 — the Story's Editor-locking Setting, one `PATCH /stories/:id` key (the `setAutoApprove` shape).
         *
         * It is written as an explicit boolean rather than by omitting the key, so turning the Setting OFF is a
         * body the server can tell apart from a body that never mentioned it (absent means off, and every other
         * dial on this pane is written the same additive way).
         */
        setEditorGroupLocking: (storyId: string, enabled: boolean) =>
            mutate(() => client.patchStory(storyId, { editor_group_locking: enabled }), storyId),
        /**
         * T-W4 — the Story's Phrase ② dial, one `PATCH /stories/:id` key (`setEditorGroupLocking`'s shape, and the
         * reason for the explicit value is the same: absent means the default, so turning a dial OFF has to be a body
         * the server can tell apart from a body that never mentioned it).
         *
         * THE READ FOLLOWS THE DIAL, not the other way round. Turning the dial ON is the moment the chapter entries
         * become this Story's surface, and `mutate`'s refetch ran against the payload BEFORE the write — so this verb
         * loads the Phrase ② rows itself afterwards. Without that line the Author turns the dial on and the Plotlines
         * pane says the read never started.
         */
        setPlotlinesMode: async (storyId: string, mode: 'groups' | 'classic') => {
            const result = await mutate(() => client.patchStory(storyId, { plotlines_mode: mode }), storyId);

            if (mode === 'groups') {
                await refreshPhraseDetail(storyId);
            }

            return result;
        },
        /**
         * T-W4 — the Author STARTS an on-demand phrase (`POST /stories/:id/phrases/:key/start`, R5 / D-76).
         *
         * THE ROUTE ANSWERS THE PHRASE'S OWN READ, so the store commits it straight away: the rail's tick, the copied
         * Seed's head and the entry rows come from the server's receipt rather than from a later poll, and `mutate`
         * then re-reads the Story (whose `phrase_started` flag is what disables the handoff) and the desk (P1 — the
         * durable store is the only memory).
         *
         * THE REFUSAL IS THE SHELL'S LINE, NOT A PHRASE CACHE ENTRY. The three start refusals (already started, no
         * compiled Summary, empty custom text) are about the handoff control, and the Plotlines pane's own error slot
         * (`phraseDetailErrors`) means "the READ failed" — writing a 409 there would render a failed read over rows
         * that arrived fine. So the server's sentence goes up verbatim through `mutate`'s `error` (L-13) and a
         * success clears the slot.
         */
        startPhrase: (storyId: string, phraseKey: string, input?: PhraseStartInput) =>
            mutate(async () => {
                const result = await client.startPhrase(storyId, phraseKey, input);

                commit({
                    phraseDetails: { ...snapshot.phraseDetails, [storyId]: result.view },
                    phraseDetailErrors: withoutKey(snapshot.phraseDetailErrors, storyId)
                });

                return result;
            }, storyId),
        /**
         * R7 / R6 (W2) — the Author asks for a PROOFREAD of the Seed they are about to start on
         * (`POST /stories/:id/phrases/:key/seed/cleanup`, body `{ seed }`), and the PROPOSAL goes back to the card that asked.
         *
         * NO `mutate`, AND THAT IS THE POINT (P10). Every other verb here is wrapped because it WRITES a row, and
         * the row is what the shell re-reads (P1: the durable store is the only memory). This one writes nothing —
         * no Seed (the Start copies it, D-72), no revision, no journal line — so there is no row to re-read, and a
         * refetch would re-render the handoff card out from under a draft the Author is still typing and a proposal
         * the card is still holding. The proposal is not a record either: it lives in component state and is thrown
         * away the moment the box changes. So the verb commits nothing to the snapshot except, at most, the shell's
         * error line.
         *
         * THE TWO ARMS OF A 200 BOTH COME BACK AS VALUES (AC3). `{ok: false, refusal}` is an ANSWER — the model
         * replied and a guard threw its rewrite away — so it is returned untouched and the card prints
         * `story-contract.seedCleanupRefusalNotice` inline; turning it into the shell's error strip would render a
         * failure over a request that succeeded, and would read like "your brief was rejected".
         *
         * `null` IS THE FAILURE, and only the failure: the route's 400 (no draft named), 404 (no such Story or
         * phrase), and the three 409s (a phrase the Author does not seed, a phrase already started, a server with
         * no transport). Those sentences are the server's and go up verbatim through the shell's `error` (L-13) —
         * the same channel `startPhrase`'s refusals use, because both are about the same control.
         */
        requestSeedCleanup: async (
            storyId: string,
            phraseKey: string,
            seed: string
        ): Promise<SeedCleanupProposal | null> => {
            try {
                const proposal = await client.requestPhraseSeedCleanup(storyId, phraseKey, seed);

                // A SUCCESS CLEARS THE LINE, as `mutate` does: the previous sentence may have been this very
                // control's 409, and an error that outlives the request which raised it is the desk describing a
                // moment that has passed.
                commit({ error: null });

                return proposal;
            } catch (cause) {
                commit({ error: failureText(cause) });

                return null;
            }
        },
        /**
         * R2 (W2) — the SAME proofread on a brief with NO Story yet, addressed by the catalog key the create will
         * send as `start_phrase` (`POST /phrases/:key/seed/cleanup`, body `{ seed }`).
         *
         * WHY THE CREATE FORM NEEDS ITS OWN VERB: the Seed the Author is typing has no row anywhere — the create
         * copies it into the Story and the Start copies it into the phrase (D-72) — so the pre-create arm is the
         * only proofread available before the first press. The story-scoped verb cannot stand in for it: its route
         * addresses a Story that does not exist yet, and 404s before it ever reaches the model.
         *
         * IDENTICAL HONESTY RULES to the verb above, because it is the same pass: NO `mutate` (nothing is written,
         * P10), the two 200 arms both come back as VALUES, and `null` is only the transport/route failure, whose
         * server sentence goes up through the shell's `error` (L-13). THE SWITCH DECIDES WHETHER THIS IS DIALED AT
         * ALL — with the Editor-cleanup switch off, the form never calls it and no model turn is spent.
         */
        requestSeedCleanupDraft: async (
            phraseKey: string,
            seed: string
        ): Promise<SeedCleanupProposal | null> => {
            try {
                const proposal = await client.requestSeedCleanupDraft(phraseKey, seed);

                commit({ error: null });

                return proposal;
            } catch (cause) {
                commit({ error: failureText(cause) });

                return null;
            }
        },
        /**
         * T-W4 — the Author rewrites ONE CHAPTER ENTRY (`POST …/phrases/groups/:id/revise`, the entry leg).
         *
         * Same route as the Summary group's revise, and the same choreography, but the response's `view` is the
         * PHRASE ② read (`routes.ts:phraseVerbView` picks it from the group row's phrase), so it is committed into
         * `phraseDetails` rather than the Summary's slot — the one place a wrong cache would put chapter rows under
         * the Summary's five groups.
         */
        revisePhraseEntry: (storyId: string, entryId: string, input: PhraseEntryReviseInput) =>
            mutate(async () => {
                const result = await client.revisePhraseEntry(storyId, entryId, input);

                commit({ phraseDetails: { ...snapshot.phraseDetails, [storyId]: result.view } });

                return result;
            }, storyId),
        /**
         * D-68 — the Author takes the Reviewed Summary (`POST /stories/:id/phrases/reviewed/choose`).
         *
         * It is the whole-Summary sibling of `revisePhraseGroup` and follows the same choreography: the
         * route answers the refreshed phrase view, which is committed straight away, and `mutate` then
         * re-reads the Story, the rail and the desk (P1 — the durable store is the only memory, so a choose
         * that installs five rows is not patched into the cache by hand).
         *
         * THE REFUSAL IS ALSO CACHED PER STORY. `mutate` raises every refusal into the shell-wide `error`,
         * which is right for the top bar and useless beside the control that raised it: the choose's three
         * 409s are group-shaped sentences, and the refresh `mutate` runs afterwards re-renders the pane
         * that has to print one. So the refusal goes into `reviewedErrors[storyId]` — and is rethrown, so
         * `mutate` still commits its own `error` and returns `null` like every other verb (the pane reads
         * the cache, the top bar reads the shell line, and neither has to know the other exists).
         */
        chooseReviewedSummary: (storyId: string, note?: string) =>
            mutate(async () => {
                try {
                    const result = await client.choosePhraseReviewed(storyId, note === undefined ? {} : { note });

                    commit({
                        phrases: { ...snapshot.phrases, [storyId]: result.view },
                        reviewedErrors: withoutKey(snapshot.reviewedErrors, storyId)
                    });

                    return result;
                } catch (cause) {
                    commit({ reviewedErrors: { ...snapshot.reviewedErrors, [storyId]: failureText(cause) } });
                    throw cause;
                }
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
