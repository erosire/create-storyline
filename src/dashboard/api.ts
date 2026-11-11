// §10 / W9-W13 — the browser-side client for the pinned `/v1/storyline` surface.
//
// WHY THIS FILE IS ALSO A CONTRACT: T7 builds the server against the SAME pinned shape at
// the same time this wave builds the UI. Everything the dashboard renders therefore lives
// here under a name both sides agreed to: the method names (T9 imports exactly these), the
// row/view projections (`StoryRow`, `StoryView`, `QueueItem`), and the SSE event names. The
// record shapes themselves are NOT redefined — they come from `src/shared/types.ts` (§4 is
// normative in name and field), and only the server-computed PROJECTIONS are declared here.
//
// PROJECTIONS VS RECORDS: `StoryRow` is not `Story` — it carries the criteria engine's
// rendered strings (`levels`, `progress`, `blocked_on`, §6.7 L-14/W3 "renders as
// `n/m · failing: …` for the current phase only"). The dashboard must never recompute a
// level client-side: W3 owns the engine, and a second implementation would drift from L-14.
//
// ERRORS: every non-2xx response carries `{error: string}` and is thrown as `ApiError`
// with the SERVER's text. This matters beyond plumbing: the 409s are the product's
// sentences — "the Ideas tray still holds 3 proposed Ideas" (L-7a), "D-37: pause the Story
// before editing prose" — and the Author reads exactly what the server said (L-13: an
// explanation, not a log line).
//
// NO `import.meta.env` READ: the root is one constant, `/v1/storyline`, which
// `vite.config.ts` proxies to the gateway in dev. A configurable root would be a second
// source of truth for something the proxy already decides.

import type {
    Cost,
    Criterion,
    Chapter,
    Digest,
    Finding,
    Goal,
    Idea,
    Proposal,
    Revision,
    Run,
    Story,
    StoryPhase,
    StoryStatus,
    Summary,
    Plotline,
    Template,
    PendingKind,
    Trend,
    Verdict
} from '../shared/types';

/** The one root the UI dials (dev proxy → gateway; see `vite.config.ts`). */
export const API_ROOT = '/v1/storyline';

/** SSE topics the server emits (`data:` is the affected story id, empty for workspace-wide). */
export type StreamKind = 'story' | 'runs' | 'queue';

/** Poll cadence for the no-`EventSource` fallback (§10 clients refetch on event; W9). */
const FALLBACK_POLL_MS = 5000;

// ---------------------------------------------------------------------------
// Projections (server-computed; the dashboard renders, never recomputes)
// ---------------------------------------------------------------------------

/**
 * §6.7 L-14 / W3 — the three phase-boundary levels plus the whole-story level, each already
 * rendered as `n/m`, `n/a` (a phase not reached is `n/a`, never `0/n`), or the failing list.
 */
export interface StoryLevels {
    summary: string;
    plotlines: string;
    chapters: string;
    whole: string;
}

/**
 * §10.2 U-1 — one STORIES-panel row. `pending_kind` + `status` drive the two-tone wait
 * (U-1b / L-34); `levels`/`trend` are W3's and W7's rendered output; `active_runs` +
 * `progress` are U-2's "what the crew is doing to it right now" (U-11: prose, not a spinner).
 */
export interface StoryRow {
    id: string;
    title: string;
    phase: StoryPhase;
    status: StoryStatus;
    pending_kind: PendingKind;
    status_reason?: string;
    summary_locked: boolean;
    plotlines_locked: boolean;
    levels: StoryLevels;
    trend: Trend;
    progress?: string;
    blocked_on?: string;
    auto_approve: Cost[];
    active_runs: number;
    completion_proposed: boolean;
}

/** §10.2 U-6 — one failing criterion with the smallest change that would clear it (G-2). */
export interface FailingCriterion {
    criterion: string;
    fix_hint: string;
    evidence?: string;
}

/** §5.1 / U-6 — the Goal plus live pass/fail per phase and per chapter (rendered by W3). */
export interface GoalSurface {
    goal: Goal;
    phase_progress: string;
    failing: FailingCriterion[];
    chapter_progress: Record<string, string>;
}

/** U-10a / D-35 — what the dial is currently skipping, and how often the Editor downgraded. */
export interface CostDistribution {
    confirmed_per_cost: Record<Cost, number>;
    downgrades: number;
}

/**
 * U-14 / L-25b — what accepting completion will discard, stated as a count so the Author
 * waves things away with their eyes open rather than pretending they were never raised.
 */
export interface CompletionPreview {
    open_findings: number;
    open_ideas: number;
    oldest?: string;
}

/**
 * `GET /stories/:id` — everything THE STORY region (U-4…U-17) needs in one read, so a
 * refresh is one round trip rather than fifteen. Each slice is the §4 collection as-is.
 */
export interface StoryView {
    story: Story;
    summary: Summary | null;
    plotlines: Plotline[];
    chapters: Chapter[];
    goal: GoalSurface;
    ideas: Idea[];
    revisions: Revision[];
    /**
     * §4.9's verdict rows for this Story. Additive: U-13 (D-21 side-by-side) renders each draft's own
     * verdict, and §6.2a files those against a `revision_N` — the Checker appends the verdict to
     * `revision.verdict_refs` (server/tools/checker.ts), but the rows still travel as their own slice so
     * the dashboard can match them by `target_ref` without joining ref lists client-side (L-14: the
     * dashboard recomputes nothing).
     */
    verdicts?: Verdict[];
    findings: Finding[];
    proposals: Proposal[];
    runs: Run[];
    /** The §4.12 template ids assigned to this Story (D-17b: a list, the count is the Author's call). */
    templates: string[];
    cost_distribution: CostDistribution;
    completion_preview: CompletionPreview | null;
    digest: Digest | null;
    /**
     * U-1a — "what the crews tried across rounds", the third thing the stalled screen has to show.
     * The server projects it from the loop's round bookkeeping (`level_history` on the Story row,
     * written by `recordRound` in server/loop/trend.ts, whose `LevelHistoryEntry` is the authority for
     * these fields). Additive and optional: a Story that has never finished a round sends none, and
     * the pane says so instead of inventing history (L-15a bounds the list, oldest first).
     */
    level_history?: LevelHistoryRow[];
}

/**
 * One round of the loop as the stalled screen reads it (U-1a). Field-for-field the server's
 * `LevelHistoryEntry`; declared here because the client contract lives in this file (projections.ts
 * imports its own return types from here, so the server cannot drift from the shape).
 */
export interface LevelHistoryRow {
    round: number;
    at: string;
    phase: StoryPhase;
    /** level -> `passed/total`, the same numbers L-14's `consistency` sentence renders. */
    levels: Record<string, string>;
    fingerprint_closed: string[];
    fingerprint_reopened: string[];
    findings_confirmed_new: string[];
    flat_streak: number;
    trend: Trend;
    runs_closed?: number;
}

/** §10.2 U-10 — the four flavours the Author's queue aggregates (findings, Ideas, escalations, tool gaps). */
export const QUEUE_ITEM_KINDS = ['finding', 'idea', 'escalation', 'tool_gap'] as const;
export type QueueItemKind = (typeof QUEUE_ITEM_KINDS)[number];

/**
 * U-10 / U-10a — one item on the Author's desk, aggregated across Stories. `title`/`detail`
 * are the EDITOR's rewrite (D-34a): the claim in the Author's reading surface, not the
 * reviewer's wording, because the queue is the loop-engineering aimed at the human.
 */
export interface QueueItem {
    kind: QueueItemKind;
    story_id: string;
    story_title: string;
    id: string;
    title: string;
    detail?: string;
    evidence: string;
    cost?: Cost;
    created_at: string;
}

// ---------------------------------------------------------------------------
// Mutation payloads (bodies are pinned by the route table; the ops are the §5.1 dial verbs)
// ---------------------------------------------------------------------------

/** `POST /stories` body. `chapter_count` is Author truth — declared, never agent-chosen (D-3b). */
export interface CreateStoryInput {
    title: string;
    idea: string;
    chapter_count: number;
}

/**
 * `PATCH /stories/:id` body. `auto_approve` is the D-35 dial, which doubles as the drain
 * threshold (D-35b): including `minor` makes the Story drain later, and the sweep re-reads it.
 */
export interface StoryPatch {
    title?: string;
    idea?: string;
    chapter_count?: number;
    auto_approve?: Cost[];
}

/** §6.3a L-32 — the two backtrack targets; Phase ③ is the current phase, so only ①/② are reachable. */
export type BacktrackPhase = 'summary' | 'plotlines';

/** §7 / U-6 — one edit to the Goal's criterion list. */
export interface GoalCriterionOp {
    op: 'add' | 'remove' | 'setHard';
    id?: string;
    criterion?: Criterion;
    hard?: boolean;
}

/** `PATCH /stories/:id/goal` — threshold plus the criterion edits, in order (G-1). */
export interface GoalPatch {
    threshold_soft?: number;
    criteria: GoalCriterionOp[];
}

/** D-24 / §8.1 — undo one section write; the pair addresses the §4.4 span. */
export interface UndoTarget {
    chapter_id: string;
    section_id: string;
}

/** §8.6 — the Author-invoked assistant run, aimed at one artifact (never a chat reply). */
export interface AssistantRequest {
    target: 'summary' | 'directive';
    text: string;
}

/** §4.12 / D-17 — `template` for New, `duplicate_of` for Duplicate (built-ins are duplicate-only). */
export interface CreateTemplateInput {
    template?: Template;
    duplicate_of?: string;
}

/**
 * U-13a / D-23 — the Author's merge request, field for field what §8.2's `requestMerge` takes.
 * `parts` is the merge brief ("the opening of revision_1, the ending of revision_2"): the Writer who
 * picks the task up works from that sentence and nothing else, so the Author's taste has to be IN it
 * (D-23: the merged text is a new draft, and the drafts being merged stay competing until it exists).
 */
export interface RevisionMergeRequest {
    unit_ref: string;
    revision_ids: string[];
    parts: string;
    why?: string;
}

/** The full method set T9 imports — one entry per route in the pinned table. */
export interface ApiClient {
    listStories(): Promise<StoryRow[]>;
    createStory(input: CreateStoryInput): Promise<StoryRow>;
    getStory(storyId: string): Promise<StoryView>;
    patchStory(storyId: string, patch: StoryPatch): Promise<StoryRow>;
    stop(storyId: string): Promise<StoryRow>;
    resume(storyId: string): Promise<StoryRow>;
    clearPending(storyId: string): Promise<StoryRow>;
    /** U-16 — locks the CURRENT phase; 409 naming the Ideas tray when it is non-empty (L-7a). */
    lockPhase(storyId: string): Promise<StoryRow>;
    /** L-32 — 409-style text names what would be deleted; the client confirms first. */
    backtrack(storyId: string, phase: BacktrackPhase): Promise<StoryRow>;
    approveFinding(storyId: string, findingId: string, why: string): Promise<StoryRow>;
    /**
     * U-10b — "approve a whole chapter's worth" in one call. The server approves every `confirmed`
     * finding aimed at the chapter (by `target_ref` OR by L-11a `related_refs`), one journaled
     * approval each; it is the chapter-scale move U-10b names next to approving one finding.
     */
    approveChapterFindings(storyId: string, chapterId: string, why: string): Promise<StoryRow>;
    discardFinding(storyId: string, findingId: string, why: string): Promise<StoryRow>;
    selectIdea(storyId: string, ideaId: string, note: string): Promise<StoryRow>;
    discardIdea(storyId: string, ideaId: string): Promise<StoryRow>;
    deferIdea(storyId: string, ideaId: string): Promise<StoryRow>;
    /** P9a / D-37 — an Author prose edit; 409 naming D-37 unless the Story is stopped. */
    editSection(storyId: string, chapterId: string, sectionId: string, content: string): Promise<StoryRow>;
    unapproveChapter(storyId: string, chapterId: string): Promise<StoryRow>;
    acceptProposal(storyId: string, proposalId: string): Promise<StoryRow>;
    rejectProposal(storyId: string, proposalId: string): Promise<StoryRow>;
    /** P11 / U-5 — undo one section write back to the previous revision. */
    undo(storyId: string, target: UndoTarget): Promise<StoryRow>;
    /**
     * U-13 / D-24 — the Author takes one competing draft as the version that stands. `note` lands in
     * the draft's `selection_note`; omitted, the server writes its own "selected by the Author".
     */
    selectRevisionAuthor(storyId: string, revisionId: string, note?: string): Promise<StoryRow>;
    /** U-13a / D-23 — the Author asks for named drafts to be merged; the drafts stay competing. */
    mergeRevisions(storyId: string, request: RevisionMergeRequest): Promise<StoryRow>;
    /** U-9 / D-19 — one line of intent that becomes a `directives` record and propagates. */
    sendDirective(storyId: string, text: string): Promise<StoryRow>;
    /** L-26 — the Author's acceptance is what closes the leftovers (L-25b). */
    acceptCompletion(storyId: string): Promise<StoryRow>;
    /** D-17b — the assignment list, replaceable wholesale (the count is the Author's call). */
    assignTemplates(storyId: string, templateIds: string[]): Promise<StoryRow>;
    patchGoal(storyId: string, patch: GoalPatch): Promise<GoalSurface>;
    /** G-1 / §14 item 2 — per-chapter bar override. */
    setChapterBar(storyId: string, chapterId: string, barOverride: string): Promise<StoryRow>;
    listTemplates(): Promise<Template[]>;
    createTemplate(input: CreateTemplateInput): Promise<Template>;
    patchTemplate(templateId: string, patch: Partial<Template>): Promise<Template>;
    /** §4.13 — `storyId` omitted lists every Story's runs. */
    listRuns(storyId?: string): Promise<Run[]>;
    /** S-3 — teardown with a recorded reason; the Author's kill (U-7). */
    killRun(runId: string): Promise<Run>;
    /** U-10 — the cross-Story queue that is the home screen. */
    getQueue(): Promise<QueueItem[]>;
    /** §8.6 — the assistant tool the locked panes offer (U-4). */
    requestAssistant(storyId: string, request: AssistantRequest): Promise<Run>;
    /**
     * §10 — the SSE channel. Emits `(kind, storyId?)`; the caller refetches the touched
     * resource rather than trusting a pushed payload (P1/P3: the store is the memory).
     * Returns the teardown. Falls back to a {@link FALLBACK_POLL_MS} poll when `EventSource`
     * is missing or fails, so a proxy that buffers SSE still yields a live dashboard.
     */
    subscribeEvents(onEvent: (kind: StreamKind, storyId?: string) => void): () => void;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** A refused request, carrying the server's own sentence (L-13) and its status code. */
export class ApiError extends Error {
    readonly status: number;
    readonly storyId?: string;

    constructor(status: number, message: string, storyId?: string) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.storyId = storyId;
    }
}

/**
 * One JSON round trip. Failure handling is deliberately loud-but-plain: the `{error}` text
 * is the product copy, so it is re-thrown verbatim; only a body that is not JSON yields the
 * generic line. A 204 (no body) resolves to `undefined as T`.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${API_ROOT}${path}`, {
        ...init,
        headers: {
            accept: 'application/json',
            ...(init?.body ? { 'content-type': 'application/json' } : {}),
            ...init?.headers
        }
    });

    if (!response.ok) {
        let message = `request refused (${response.status} ${response.statusText})`;
        try {
            const body = (await response.json()) as { error?: string };
            if (typeof body?.error === 'string' && body.error) {
                message = body.error;
            }
        } catch {
            // A non-JSON error body (a proxy's HTML 502 page) is exactly the case the
            // generic message above is for — nothing to log, the status already says it.
        }
        throw new ApiError(response.status, message);
    }

    if (response.status === 204) {
        return undefined as T;
    }
    return (await response.json()) as T;
}

/** `POST` with an optional body — most of the surface is verbs, not documents. */
function post<T>(path: string, body?: unknown): Promise<T> {
    return request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
}

/** `PATCH` with a partial document. */
function patch<T>(path: string, body: unknown): Promise<T> {
    return request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}

/** Story-scoped prefix — kept as a function so no path is assembled twice. */
const storyPath = (storyId: string, suffix = ''): string => `/stories/${encodeURIComponent(storyId)}${suffix}`;

/**
 * EventSource with a polling fallback.
 *
 * WHY A FALLBACK AT ALL: the gateway sits in front of the stream, and a proxy that buffers
 * `text/event-stream` (or a browser extension that blocks it) would otherwise leave the
 * dashboard frozen on a page that looks healthy. Degrading to a 5s refetch cadence keeps
 * U-2's "right now" honest enough without pretending it is the transport (L-24: the UI
 * should not lie about what it is doing, so the degraded mode is a real, slower poll).
 */
function subscribeEvents(onEvent: (kind: StreamKind, storyId?: string) => void): () => void {
    let timer: ReturnType<typeof setInterval> | null = null;
    let source: EventSource | null = null;
    let closed = false;

    const startPoll = (): (() => void) => {
        if (closed) {
            return () => undefined;
        }
        timer = setInterval(() => {
            // A poll re-reads everything, so it announces all three topics in order: the
            // store's handler is idempotent and refetches, which is the same work an event
            // would have triggered.
            onEvent('story');
            onEvent('runs');
            onEvent('queue');
        }, FALLBACK_POLL_MS);
        return () => {
            if (timer !== null) {
                clearInterval(timer);
                timer = null;
            }
        };
    };

    if (typeof EventSource === 'undefined') {
        return startPoll();
    }

    try {
        source = new EventSource(`${API_ROOT}/stream`);
    } catch {
        return startPoll();
    }

    const handlers: Array<[StreamKind, EventListener]> = (['story', 'runs', 'queue'] as StreamKind[]).map((kind) => [
        kind,
        (event: Event) => {
            // `data` is the story id, or empty for a workspace-wide change (runs/queue
            // aggregate across Stories, so the server may omit it).
            const data = (event as MessageEvent).data;
            onEvent(kind, typeof data === 'string' && data.length > 0 ? data : undefined);
        }
    ]);
    for (const [kind, listener] of handlers) {
        source.addEventListener(kind, listener);
    }

    // A stream that errors is retried by EventSource itself; if it errors again the socket
    // is not usable in this environment, so switch once to polling rather than retrying
    // forever behind a spinner the spec forbids (U-11).
    source.onerror = () => {
        if (closed || timer !== null) {
            return;
        }
        const dead = source;
        source = null;
        dead?.close();
        startPoll();
    };

    return () => {
        closed = true;
        if (timer !== null) {
            clearInterval(timer);
            timer = null;
        }
        source?.close();
        source = null;
    };
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/** The pinned surface, as data — injected wholesale by `state.ts` and by the tests. */
export const api: ApiClient = {
    listStories: () => request<StoryRow[]>('/stories'),
    createStory: (input) => post<StoryRow>('/stories', input),
    getStory: (storyId) => request<StoryView>(storyPath(storyId)),
    patchStory: (storyId, body) => patch<StoryRow>(storyPath(storyId), body),
    stop: (storyId) => post<StoryRow>(storyPath(storyId, '/stop')),
    resume: (storyId) => post<StoryRow>(storyPath(storyId, '/resume')),
    clearPending: (storyId) => post<StoryRow>(storyPath(storyId, '/clear-pending')),
    lockPhase: (storyId) => post<StoryRow>(storyPath(storyId, '/lock')),
    backtrack: (storyId, phase) => post<StoryRow>(storyPath(storyId, '/backtrack'), { phase }),
    approveFinding: (storyId, findingId, why) =>
        post<StoryRow>(storyPath(storyId, `/findings/${encodeURIComponent(findingId)}/approve`), { why }),
    // U-10b. The chapter's whole approval in one fetch; the server does one commit per finding, so the
    // audit still shows each decision (D-34) rather than one anonymous batch.
    approveChapterFindings: (storyId, chapterId, why) =>
        post<StoryRow>(storyPath(storyId, `/chapters/${encodeURIComponent(chapterId)}/findings/approve-all`), { why }),
    discardFinding: (storyId, findingId, why) =>
        post<StoryRow>(storyPath(storyId, `/findings/${encodeURIComponent(findingId)}/discard`), { why }),
    selectIdea: (storyId, ideaId, note) =>
        post<StoryRow>(storyPath(storyId, `/ideas/${encodeURIComponent(ideaId)}/select`), { note }),
    discardIdea: (storyId, ideaId) =>
        post<StoryRow>(storyPath(storyId, `/ideas/${encodeURIComponent(ideaId)}/discard`)),
    deferIdea: (storyId, ideaId) => post<StoryRow>(storyPath(storyId, `/ideas/${encodeURIComponent(ideaId)}/defer`)),
    editSection: (storyId, chapterId, sectionId, content) =>
        post<StoryRow>(
            storyPath(storyId, `/chapters/${encodeURIComponent(chapterId)}/sections/${encodeURIComponent(sectionId)}`),
            { content }
        ),
    unapproveChapter: (storyId, chapterId) =>
        post<StoryRow>(storyPath(storyId, `/chapters/${encodeURIComponent(chapterId)}/unapprove`)),
    acceptProposal: (storyId, proposalId) =>
        post<StoryRow>(storyPath(storyId, `/proposals/${encodeURIComponent(proposalId)}/accept`)),
    rejectProposal: (storyId, proposalId) =>
        post<StoryRow>(storyPath(storyId, `/proposals/${encodeURIComponent(proposalId)}/reject`)),
    undo: (storyId, target) => post<StoryRow>(storyPath(storyId, '/undo'), target),
    // U-13 / D-24. The note is optional in the body: the server's default is its own sentence, and an
    // empty string is not the same thing as no note (L-13 — the note is what the next run reads).
    selectRevisionAuthor: (storyId, revisionId, note) =>
        post<StoryRow>(
            storyPath(storyId, `/revisions/${encodeURIComponent(revisionId)}/select`),
            note === undefined ? {} : { note }
        ),
    // U-13a / D-23. Same task the Checker's `requestMerge` opens; the desk shows one entry either way.
    mergeRevisions: (storyId, request) => post<StoryRow>(storyPath(storyId, '/revisions/merge'), request),
    sendDirective: (storyId, text) => post<StoryRow>(storyPath(storyId, '/directives'), { text }),
    acceptCompletion: (storyId) => post<StoryRow>(storyPath(storyId, '/complete')),
    assignTemplates: (storyId, template_ids) => post<StoryRow>(storyPath(storyId, '/templates'), { template_ids }),
    patchGoal: (storyId, body) => patch<GoalSurface>(storyPath(storyId, '/goal'), body),
    setChapterBar: (storyId, chapterId, bar_override) =>
        patch<StoryRow>(storyPath(storyId, `/chapters/${encodeURIComponent(chapterId)}/bar`), { bar_override }),
    listTemplates: () => request<Template[]>('/templates'),
    createTemplate: (input) => post<Template>('/templates', input),
    patchTemplate: (templateId, body) => patch<Template>(`/templates/${encodeURIComponent(templateId)}`, body),
    listRuns: (storyId) => request<Run[]>(`/runs${storyId ? `?story_id=${encodeURIComponent(storyId)}` : ''}`),
    killRun: (runId) => post<Run>(`/runs/${encodeURIComponent(runId)}/kill`),
    getQueue: () => request<QueueItem[]>('/queue'),
    requestAssistant: (storyId, body) => post<Run>(storyPath(storyId, '/assistant'), body),
    subscribeEvents
};

export default api;
