// §10 / W9-W13 — the browser-side client for the server's `/v1/storyline` surface.
//
// THE ONE NETWORK LAYER. The server owns the HTTP contract in `src/storyline-server.swagger.yaml`;
// this module is the dashboard's only implementation of it. Components render store snapshots and
// call store methods; neither imports a server module, calls the model provider, opens a harness
// socket, or executes a harness tool. A second transport in the UI would be a second backend, and
// the dashboard is deliberately a client of the Storyline server and nothing else.
//
// Everything the dashboard renders therefore lives here under a name both sides agreed to: the
// method names (T9 imports exactly these), the row/view projections (`StoryRow`, `StoryView`,
// `QueueItem`), and the SSE event names. The record shapes themselves are NOT redefined — they
// come from `src/shared/types.ts` (§4 is normative in name and field), and only the server-computed
// PROJECTIONS are declared here.
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
    CastMember,
    Cost,
    Criterion,
    Chapter,
    Digest,
    Finding,
    FindingKind,
    Goal,
    Idea,
    LedgerEntry,
    Proposal,
    Revision,
    Run,
    SeedBriefState,
    Story,
    StoryPhase,
    StoryStatus,
    Summary,
    Plotline,
    Task,
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
 * §10 / §3.3 — the ACCEPTED Seed Brief as the Story view carries it: the Editor's derived,
 * machine-readable projection of the Seed, TRIMMED to the reading surface (the arrays —
 * `world_rules`, `constraints`, `open_questions` — belong to the prompt compiler, not the pane).
 * Read-only by construction: the Seed itself stays `stories.idea` and is never edited (P5).
 */
export interface SeedBriefView {
    id: string;
    /** Hash of the Seed text this brief was derived from; a Seed edit re-arms the structuring (§3.3). */
    seed_hash: string;
    logline: string;
    protagonist: string;
    want: string;
    obstacle: string;
    stakes: string;
    setting: string;
    promise: string;
    /** `accepted` for every brief this projection sends null-less; the state travels for the pane's badge. */
    status: SeedBriefState;
}

/**
 * One sample's screening tally, as the selector ranked it (§6.5: critical, then high, then total),
 * PLUS the half of the record that only the hill-climb audit carries.
 *
 * `outcome` is why a candidate is on this line at all: `accepted` (the one the round installed),
 * `eligible` (it could have been, and lost to a smaller change), or `rejected` (the gate refused it).
 * The selection commit hard-deletes the losing draft AND its `sample_reviews` rows (P13/§6.6), so this
 * field and `reject_reason` are the only surviving answer to "why did the round not install it" — a
 * count tells the Author the draft had a high; the reason says whether it was a regression, an
 * uncertified fix, or a screening leg that never answered.
 *
 * The origin split (`introduced_*` / `inherited_*`) and the minimality counts (`changed_*`) exist only
 * for a candidate measured AGAINST AN ACCEPTED DRAFT: in round 1 there is nothing to inherit and
 * nothing to be minimal about, so their absence is a fact about the round, not a missing value. A
 * history line written before the hill exists omits all of them.
 */
export interface SamplingSample {
    revision_id: string;
    critical: number;
    high: number;
    outcome?: 'accepted' | 'eligible' | 'rejected';
    reject_reason?: string;
    introduced_critical?: number;
    introduced_high?: number;
    inherited_critical?: number;
    inherited_high?: number;
    changed_fields?: number;
    changed_characters?: number;
}

/**
 * One completed sampling round's P11 audit line (`Story.sampling_history`, shared/types.ts §3.6).
 * The losing samples are hard-deleted by the selection commit (P13/D-22), so this row — ids, issue
 * counts, validity, the fixes each one left outstanding, and the selected id — is the only surviving
 * record of what competed (§2 item 5).
 *
 * `unresolved_fixes` is H1's half of that record (H1-C1/F3): the round's rejection is not a count, it
 * is the `fix` task the candidate failed, and the task rows themselves may already be `wontfix` by the
 * time the Author reads this pane. The projection sends it as a list on EVERY row — `[]` means "this
 * candidate owed nothing, or cleared everything it owed", and a history line written before the field
 * existed is normalised to `[]` rather than sent as absent, so a consumer never branches on the build.
 *
 * THE HILL'S LEDGER (H2) is the other half: which WAVE this round ran in, how many attempts the wave
 * spent, how many improvements it proved, the ceiling that bounded it, and the unresolved-blocking bar
 * the install left behind. They are sent as a group and only when the row recorded them: unlike
 * `unresolved_fixes`, a zero here would be a FALSE fact rather than an empty list — a pre-hill row does
 * not know how many attempts it spent — so the absence is the honest payload and the pane renders it as
 * "not recorded" rather than as 0. The wave number is what tells the Author whether the row predates
 * their clear (wave 0) or came after it (wave 1+), which is the difference between a hill that stalled
 * and a hill that was restarted.
 */
export interface SamplingHistoryRow {
    round: number;
    at: string;
    samples: Array<SamplingSample & { valid: boolean; unresolved_fixes: string[] }>;
    selected: string;
    wave?: number;
    attempts?: number;
    improvements?: number;
    ceiling?: number;
    unresolved_blocking?: number;
}

/**
 * §10 / §6.5-§6.6 — phase ①'s sampling state: the last COMPLETED round, the round the loop is
 * working, the sample the last selection installed (with the counts that won it), and the bounded
 * audit history.
 *
 * WHY `round` AND `active_round` ARE BOTH ON THE WIRE (T12/P1) — they are two different questions,
 * and one number cannot answer both:
 *   - `round` is the round whose SELECTION the Story carries (`story.sampling_round ?? 1`, exactly
 *     `records.ts:deepReviewRoundOf`). It is what §10's pane prints and what the deep review is
 *     dispatched for, and it is 0 on a Story whose counter an Author reset (§16.7's backtrack).
 *   - `active_round` is the round the loop is WRITING now (`records.ts:samplingRoundOf`, i.e.
 *     `(sampling_round ?? 0) + 1`). It is what decides whether a `drafted` Summary row is live work
 *     or a loser the loop set aside (`records.ts:isSupersededSummaryDraft`), and a payload that only
 *     carries `round` cannot tell "round 1 never completed" from "round 1 completed" — both say 1.
 * The dashboard is forbidden from recomputing either one (L-14/W3), so the projection sends both.
 */
export interface SamplingView {
    /** Last COMPLETED round (`sampling_round ?? 1`); the round the deep review is owed for (§6.6). */
    round: number;
    /**
     * The round IN FLIGHT (`(sampling_round ?? 0) + 1`, `records.ts:samplingRoundOf`): round 1 before
     * the first selection, R + 1 while nothing of round R + 1 has been written yet. Required whenever
     * `sampling` is present — the shipped server always sends it; a payload without the slice at all
     * is the older-build case `story-contract.ts:summaryScopeContext` documents.
     */
    active_round: number;
    /** The last round's chosen sample and its issue counts. Absent until a selection has happened. */
    selected?: SamplingSample;
    /** The Story's `sampling_history` rows, capped at the last 5, newest first. */
    history: SamplingHistoryRow[];
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
    /**
     * §4.5 — the cast sheet. The Characters phrase reads it as the story's people and the state
     * they carry; the records themselves are Writer-owned (§7), so this is a projection, never a
     * second copy the dashboard may edit directly.
     */
    cast: CastMember[];
    /**
     * §4.6 — the continuity facts. The Continuity folder renders the ledger as it stands; the
     * mechanical checks C-5/C-6 stay on the server (G-3).
     */
    ledger: LedgerEntry[];
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
    /**
     * §10 / §3.3 — the accepted Seed Brief, or null while the Editor has not structured this Seed
     * (phase ①'s gate 1, §6.4). Optional on the wire consumer's side purely as the additive-field
     * convention: the shipped server always sends the key, and an older payload omits it rather than
     * pretending a brief exists.
     */
    seed_brief?: SeedBriefView | null;
    /**
     * §10 / §6.6 — phase ①'s sampling round, the selected sample and the capped audit history. Same
     * additive convention: the shipped server always sends it (`round: sampling_round ?? 1`).
     */
    sampling?: SamplingView;
}

// ---------------------------------------------------------------------------
// SUMMARY PHRASE — the group read (`GET /stories/:id/phrases`), R1-R6
//
// WHY A SECOND READ AND NOT A WIDER `StoryView`: `StoryView` is the PINNED wire contract the whole
// desk renders from, and the group rail is a new surface rather than a field of the old one
// (`server/api/projections.ts`'s phrase section says the same thing from the server's side). The
// shapes below are field-for-field the projection's: this file is the dashboard's copy of the wire,
// so the panes never import a server module and a server that renames a field breaks the client
// contract test rather than a component.
//
// WHAT THE GROUPS ARE (R1): the Summary is five named, separately revisable groups — premise,
// promise, theme, tone, ending — that compose into one Overview. WHICH groups exist, their titles,
// their descriptions and their order is SERVER/product data on the rows; nothing here hardcodes the
// five labels, and `world_rules` is deliberately not one of them (R1 retires it as a group).
//
// NO FULL ARCHIVED TEXT (R2): a group row carries the CURRENT text; `history` is the retained
// ledger of superseded revisions with metadata and a char count only. The one exception is
// `previous_content` — the revision immediately before the latest — which the pane diffs the
// current text against; every older body stays off the wire.
// ---------------------------------------------------------------------------

/** One revision of one group, current or archived. `chars` is its length, never its text (R2). */
export interface PhraseRevisionRow {
    id: string;
    /** 1-based, per group (R2) — the number the detail pane labels its status with. */
    number: number;
    /** `latest` for the row that stands, `archived` for one a later install superseded. */
    state: string;
    at: string;
    /** The run that wrote it, or null for an Author edit / legacy import. */
    run_ref: string | null;
    /** R3: the findings this text was written to answer — the anchor a closure is judged on. */
    finding_refs: string[];
    task_refs: string[];
    chars: number;
}

/** One group: its current text, its number, its retained history, and the findings it still owes. */
export interface PhraseGroupRow {
    /** The UUID the rail addresses this group by — a selection ref, never an array index (U2). */
    id: string;
    key: string;
    title: string;
    description: string;
    /** Composition order; the rail and the Overview both follow it, and it is NOT an identity. */
    order: number;
    content: string;
    revision: number;
    updated_by: string | null;
    /**
     * R2 / U3 — the revision immediately before the latest one, verbatim, or `''` at revision 1.
     * It is the ONLY archived body on the wire: the pane renders the current text as a diff against
     * it, and every older revision stays metadata.
     */
    previous_content: string;
    /** Newest first, `latest` included. Metadata only — see the note above. */
    history: PhraseRevisionRow[];
    /** Open findings that target this group and have no revision of ITS own answering them (R3). */
    owed_by_findings: string[];
    /**
     * F8 / R4 — a live Writer pass holds this group right now, so the text on screen is about to
     * move. It is the SAME read the revise route refuses with, so a disabled button and a 409 cannot
     * disagree: the control is disabled off this flag, never off a guess from run rows.
     */
    writer_busy: boolean;
}

/** A finding with its group attribution and R3's resolution against the book as it stands. */
export interface PhraseFindingRow {
    id: string;
    title: string;
    cost: Cost;
    state: Finding['state'];
    seen_count: number;
    /** The ids on the record; empty is the legacy "the whole Overview" reading. */
    group_refs: string[];
    /** True when the record named none — spelled out so a pane never infers it from an empty array. */
    unscoped: boolean;
    /** Every group this finding is aimed at; `unscoped` means every group of this Story. */
    targeted: string[];
    resolved: string[];
    missing: string[];
    /** R3: every targeted group has a revision written to answer it, so the row may close. */
    resolved_all: boolean;
}

/** A task in the group queue, with what it is waiting on. */
export interface PhraseTaskRow {
    id: string;
    title: string;
    state: Task['state'];
    owner_role: string | null;
    attempts: number;
    finding_ref: string | null;
}

/** The state of the group pipeline: what is written, what is reviewed, and whether the mirror agrees. */
export interface PhraseReviewState {
    /** `story.summary_mode`, echoed — the switch is a Setting, not a derived fact (R6). */
    mode: 'groups' | 'sampling';
    /** Catalog keys with no revision yet; empty means the Overview is fully written. */
    unwritten_groups: string[];
    written_groups: number;
    /** `{groupId: revisionNumber}` — the identity reviews and deferrals are keyed by. */
    vector: Record<string, number>;
    vector_hash: string;
    /** Reader seats the Author's dial asks for on this vector, and how many have reported. */
    review_seats: number;
    reviews_on_current_vector: number;
    deep_reviews_on_current_vector: number;
    open_findings: number;
    /** The critical/major rows the sign-off treats as blocking (§6.8's bar, unchanged by R6). */
    blocking_findings: number;
    open_tasks: number;
    /** R6's compatibility mirror: does the legacy `summaries` prose still say what the groups say? */
    mirror: { summary_id: string | null; in_sync: boolean; locked: boolean; fields: string[] };
}

/** The whole group surface for one Story — the one read the Summary rail and its panes render (R6). */
export interface PhraseView {
    story_id: string;
    mode: 'groups' | 'sampling';
    phrase_id: string | null;
    /** The Overview's revision number (the phrase row), or 0 when the book has no phrase row. */
    revision: number;
    /** The composed Overview, from the group rows as they are (R2: the composition is a read). */
    overview: string;
    groups: PhraseGroupRow[];
    findings: PhraseFindingRow[];
    tasks: PhraseTaskRow[];
    review: PhraseReviewState;
}

/**
 * `POST /stories/:id/phrases/groups/:groupId/revise` body (R2) — the Author rewrites ONE group.
 * The route trims `content` and refuses an empty one, and it deliberately claims to resolve no
 * finding: `finding_refs` stay off the row, so a hand edit cannot close a finding on R3's evidence rule.
 */
export interface PhraseGroupReviseInput {
    content: string;
    note?: string;
}

/** One group's install, as the route reports it: which number is current, which one moved to history. */
export interface PhraseGroupInstallRow {
    group_id: string;
    group_key: string;
    revision_id: string;
    number: number;
}

/** What the group revise route answers — including the refreshed `view`, so the pane re-reads nothing by hand. */
export interface PhraseGroupReviseResult {
    story_id: string;
    phrase_id: string;
    revision: number;
    installed: PhraseGroupInstallRow[];
    archived: PhraseGroupInstallRow[];
    /** What happened to the legacy `summaries` mirror (R6): `written: false` with a reason is a fact, not a failure. */
    mirror: { summary_id: string | null; fields: string[]; written: boolean; reason?: 'locked' | 'no_summary' };
    view: PhraseView;
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
    /**
     * T5 (additive) — the FINDING's claim type, on the `finding` rows only. It cannot be called `kind`:
     * that field is already this row's queue discriminator ('finding' | 'idea' | ...). Absent on the
     * other three flavours, and `'issue'` for a finding raised before the field existed.
     */
    finding_kind?: FindingKind;
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

/**
 * `POST /stories` body. `chapter_count` is Author truth — declared, never agent-chosen (D-3b).
 * The route lets the server name an untitled Story from its Seed, which is what the Create Story
 * tab's "tell the Editor" path uses; the form still sends all three fields.
 */
export interface CreateStoryInput {
    title?: string;
    idea: string;
    chapter_count?: number;
    /** Phase ①: Writer samples per Summary (standard 5 when omitted). */
    summary_sampling?: number;
    /** Phase ①: Reader passes per sample (standard 5 when omitted). */
    summary_readers?: number;
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
    /** Phase ①: how many Writer samples one Summary gets (standard 5). */
    summary_sampling?: number;
    /** Phase ①: how many Readers critique each sample (standard 5). */
    summary_readers?: number;
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

/**
 * `GET /stories/:id/knowledge` — the Story's durable knowledge directory.
 *
 * Each section is one harness knowledge article (tags `story:<id>` + `section:<key>`), stored
 * outside every phrase at `<storeRoot>/harness/knowledge/`. The client renders the directory;
 * it never re-derives an entry from the book (the same rule L-14 applies to levels).
 */
export interface StoryKnowledgeEntry {
    key: string;
    title: string;
    body: string;
    tags: string[];
}

export interface StoryKnowledgeSection {
    key: string;
    title: string;
    article_id: string | null;
    updated_at: string | null;
    entries: StoryKnowledgeEntry[];
}

export interface StoryKnowledgeTree {
    story_id: string;
    story_title: string;
    sections: StoryKnowledgeSection[];
    /** True when a section article could not be materialised (the knowledge store is unavailable). */
    degraded: boolean;
}

/**
 * U-8 — the provider's model catalog (`GET /agents/models`), the only choices the roster's
 * dropdown offers. `base_url` is the provider root the harness engine dials.
 */
export interface AgentModelCatalog {
    base_url: string;
    models: string[];
}

/**
 * S-5 — the loop's live fan-out ceiling, read from `GET /loop`. ONE number across EVERY Story: the
 * sweep fills up to it and no further, so it is the throttle on how many threads the crew may run at
 * once (the per-template `max_concurrent` on a template card is a second, smaller ceiling under it).
 *
 * It is host configuration, not a Story record — remembered with the roster's model choices, and pinned
 * at boot by `STORYLINE_GLOBAL_MAX_CONCURRENT` when an operator set one (`server/loop/ceiling.ts` states
 * the precedence) — which is why the control that edits it sits on the GLOBAL employee rail rather than
 * on a Story pane.
 */
export interface LoopSettings {
    global_max_concurrent: number;
    /** Threads live right now, counted from the durable run rows (S-5, L-2). */
    live_runs: number;
}

/** One closed run row, kept on a tile so a failed thread does not vanish into `idle` (S-3, U-8). */
export interface AgentRecentRun {
    run_id: string;
    story_id: string;
    story_title: string;
    work_item: string;
    state: 'spawning' | 'working' | 'reporting' | 'torn_down' | 'failed' | 'abandoned';
    started_at: string;
    ended_at?: string;
    end_reason?: string;
    no_op: boolean;
    tokens: number;
}

/** One employee on the global roster, with every Story thread it is currently working. */
export interface AgentStatusRow {
    /** `writer` | `editor` | `reader` | `checker` — the Storyline role, shared by every Story. */
    kind: string;
    title: string;
    status: 'idle' | 'running';
    /** The harness rank this employee holds; `A` is a peer, not a lead (R15, V-2). */
    rank?:
        | 'A'
        | 'B'
        | 'C'
        | 'D'
        | 'E'
        | 'F'
        | 'G'
        | 'H'
        | 'I'
        | 'J'
        | 'K'
        | 'L'
        | 'M'
        | 'N'
        | 'O'
        | 'P'
        | 'Q'
        | 'R'
        | 'S'
        | 'T'
        | 'U'
        | 'V'
        | 'W'
        | 'X'
        | 'Y'
        | 'Z';
    /**
     * U-8 / T-6b — the roster's model for this employee, or the process model when the Author has
     * set none. Optional on the client contract so an older/fake projection still renders: the
     * tile says "not reported" rather than inventing a model.
     */
    model?: string;
    /** `agent` when the Author set it on this roster; `default` for the process model. */
    model_source?: 'agent' | 'default';
    /**
     * Template roles that name their own model for this kind. A role model wins until the Author
     * sets a roster choice here; listing them is what stops the tile misreporting the crew (T-6b).
     */
    template_models?: Array<{ template: string; role: string; model: string }>;
    working: Array<{
        story_id: string;
        story_title: string;
        phase: 'summary' | 'plotlines' | 'chapters';
        role_name: string;
        work_item: string;
        thread_id: string;
        started_at: number;
    }>;
    /** The newest closed threads of this kind, newest first — the tile's "why did it end" (S-3). */
    recent?: AgentRecentRun[];
}

/** The four states a retained thread bar can read. */
export type AgentThreadState = 'running' | 'torn_down' | 'failed' | 'abandoned';

/**
 * U-8 — one step a RUNNING thread has taken. The Author reads these below the (collapsed)
 * request to see what the employee is doing right now; a closed thread drops them, because a
 * finished bar is judged on its request and its answer only.
 */
export interface AgentThreadActivity {
    /** When the step landed (ISO 8601). */
    at: string;
    /** One line: the tool it called (with its result), or the prose turn it produced. */
    text: string;
}

/**
 * One thread of one employee, as the employee tile's content surface renders it. A thread is the
 * employee acting as an agent for one Run.
 * harness's execution unit: the Story is the harness, the phase is its session, and this row is
 * one conversation inside that session. A closed thread's detail is `request` + `answer`; a
 * running thread also carries `activity`, the steps it is taking right now (U-8).
 */
export interface AgentThreadRecord {
    /** The engine thread id; unique for the life of the record. */
    thread_id: string;
    /** The Storyline Run row this thread belongs to (a panel's N threads share one id). */
    run_id: string;
    story_id: string;
    story_title: string;
    /** The phrase (session) the thread ran in — P1 Summary, P3 Plotlines, P4 Chapters. */
    phase: 'summary' | 'plotlines' | 'chapters';
    role: string;
    /** The role name on the bar (`writer`, `editor#agent_2`, a delegated role). */
    role_name: string;
    /** What the thread was asked to do, in one line. */
    title: string;
    state: AgentThreadState;
    started_at: string;
    ended_at?: string;
    tokens: number;
    request: string;
    answer: string;
    error?: string;
    /**
     * Live steps of a thread that is still RUNNING, oldest first. Absent on a closed thread:
     * when the thread completes the bar shows only Request and Answer (U-8).
     */
    activity?: AgentThreadActivity[];
    /** False for a legacy Run row whose pre-retention transcript is gone. */
    retained: boolean;
}

/** `GET /agents/:kind/threads` — every retained thread of one employee, oldest first. */
export interface AgentThreadList {
    kind: string;
    threads: AgentThreadRecord[];
}

/** The full method set T9 imports — one entry per route in the pinned table. */
export interface ApiClient {
    listStories(): Promise<StoryRow[]>;
    createStory(input: CreateStoryInput): Promise<StoryRow>;
    /**
     * §10 / P1 — hard-delete a Story and everything it owns: every §4 record, the knowledge
     * directory, and the Story's harness (its sessions and threads). Answers the id it removed.
     */
    deleteStory(storyId: string): Promise<{ deleted: string }>;
    getStory(storyId: string): Promise<StoryView>;
    /**
     * R6 — the SUMMARY PHRASE read: the five groups with their current text, numbers and retained
     * history, the composed Overview, every finding with its group scope and R3's resolution, the open
     * group tasks, and whether the legacy Summary mirror still agrees.
     *
     * A pure read, so it is safe on a legacy book: a Story with no `summary_mode` answers
     * `mode:'sampling'` with empty groups rather than 404, and the rail shows that book its compact
     * upgrade state instead of the group rail (R6's "readable, not migrated").
     */
    getPhrase(storyId: string): Promise<PhraseView>;
    /**
     * R2 — the Author rewrites ONE group by hand. Same install the loop uses, so the group gets a new
     * numbered revision, the text it replaces is archived and retained, its siblings keep their own
     * numbers, the Overview recomposes, and the legacy mirror is rewritten in the same commit (R6).
     *
     * 409 while a Writer holds that group (F8/R4 — `PhraseGroupRow.writer_busy` is the same read, so the
     * control is already disabled), and 409 on a `summary_mode:'sampling'` book, which has no group rows
     * to revise. It answers the refreshed `view`, which is what the store commits.
     */
    revisePhraseGroup(storyId: string, groupId: string, input: PhraseGroupReviseInput): Promise<PhraseGroupReviseResult>;
    /** The durable knowledge directory for one Story (eight section articles, harness-owned). */
    getStoryKnowledge(storyId: string): Promise<StoryKnowledgeTree>;
    /** The global employee roster: Writer/Editor/Reader/Checker, their models and live threads. */
    listAgents(): Promise<AgentStatusRow[]>;
    /** U-8 — the provider's model catalog, the roster dropdown's only choices. */
    listAgentModels(): Promise<AgentModelCatalog>;
    /**
     * U-8 — every thread one employee ran, across every Story and every phrase session, oldest
     * first.
     * This is what clicking the employee tile opens in the content area; `request` and `answer`
     * are the detail of each bar.
     */
    listAgentThreads(kind: string): Promise<AgentThreadList>;
    /**
     * U-8 — set (or clear, with `null`) one employee's model on the global roster. Answers the
     * whole refreshed projection, because every tile's model line is server-owned.
     */
    setAgentModel(kind: string, model: string | null): Promise<AgentStatusRow[]>;
    /**
     * S-5 — the loop's live fan-out ceiling and the threads occupying it right now. Global: it belongs
     * to the process, not to any Story, so it has no Story row to read it off.
     */
    getLoopSettings(): Promise<LoopSettings>;
    /**
     * S-5 — moving that ceiling while the loop runs. The next sweep fills the new capacity; lowering it
     * cancels no thread already in flight. Answers the same projection `getLoopSettings` does, so the
     * control re-renders from the server's number rather than from what was typed.
     */
    setGlobalMaxConcurrent(limit: number): Promise<LoopSettings>;
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
    /** Phase ① — "not final yet": queue another three-draft Summary round from the selected revision. */
    requestSummaryRevision(storyId: string, note?: string): Promise<StoryRow>;
    /**
     * U-9 / D-19 — one line addressed to the Editor; it records a `directives` row and propagates.
     * `refs` names the artifact the Author is looking at, so the Editor updates the focused pane
     * even when the sentence never spells out a chapter or plotline.
     */
    sendDirective(storyId: string, text: string, refs?: string[]): Promise<StoryRow>;
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
    /**
     * S-3 — teardown with a recorded reason; the Author's kill (U-7). S-RUNTIME: a run id is LOCAL to one
     * Story's book, so `storyId` names which book's executor aborts the thread. Omit it only when the id is
     * unique across the workspace's books — several Stories holding the same local id answer 409, because
     * stopping one of them by book order would stop a thread the Author never pointed at.
     */
    killRun(runId: string, storyId?: string): Promise<Run>;
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

/** `DELETE` — the Author's hard delete; the server answers the id it removed. */
function del<T>(path: string): Promise<T> {
    return request<T>(path, { method: 'DELETE' });
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
    deleteStory: (storyId) => del<{ deleted: string }>(storyPath(storyId)),
    getStory: (storyId) => request<StoryView>(storyPath(storyId)),
    // R6 — the group read. One route per Story, because the rail is one read of the whole Summary Phrase.
    getPhrase: (storyId) => request<PhraseView>(storyPath(storyId, '/phrases')),
    // R2 — the Author's hand edit of ONE group. The group is addressed by its UUID, so a refetch that
    // reorders the catalog cannot move the write onto a sibling group.
    revisePhraseGroup: (storyId, groupId, input) =>
        post<PhraseGroupReviseResult>(
            storyPath(storyId, `/phrases/groups/${encodeURIComponent(groupId)}/revise`),
            input.note === undefined ? { content: input.content } : { content: input.content, note: input.note }
        ),
    getStoryKnowledge: (storyId) => request<StoryKnowledgeTree>(storyPath(storyId, '/knowledge')),
    listAgents: () => request<AgentStatusRow[]>('/agents'),
    listAgentModels: () => request<AgentModelCatalog>('/agents/models'),
    listAgentThreads: (kind) => request<AgentThreadList>(`/agents/${encodeURIComponent(kind)}/threads`),
    setAgentModel: (kind, model) => patch<AgentStatusRow[]>(`/agents/${encodeURIComponent(kind)}`, { model }),
    // S-5 — the loop's ceiling. One global pair of routes, because the number is the process's and no
    // Story owns it; the PATCH answers the fresh projection, never what the Author typed.
    getLoopSettings: () => request<LoopSettings>('/loop'),
    setGlobalMaxConcurrent: (limit) => patch<LoopSettings>('/loop', { global_max_concurrent: limit }),
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
    requestSummaryRevision: (storyId, note) =>
        post<StoryRow>(storyPath(storyId, '/summary/revise'), note === undefined ? {} : { note }),
    sendDirective: (storyId, text, refs) =>
        post<StoryRow>(storyPath(storyId, '/directives'), refs && refs.length > 0 ? { text, refs } : { text }),
    acceptCompletion: (storyId) => post<StoryRow>(storyPath(storyId, '/complete')),
    assignTemplates: (storyId, template_ids) => post<StoryRow>(storyPath(storyId, '/templates'), { template_ids }),
    patchGoal: (storyId, body) => patch<GoalSurface>(storyPath(storyId, '/goal'), body),
    setChapterBar: (storyId, chapterId, bar_override) =>
        patch<StoryRow>(storyPath(storyId, `/chapters/${encodeURIComponent(chapterId)}/bar`), { bar_override }),
    listTemplates: () => request<Template[]>('/templates'),
    createTemplate: (input) => post<Template>('/templates', input),
    patchTemplate: (templateId, body) => patch<Template>(`/templates/${encodeURIComponent(templateId)}`, body),
    listRuns: (storyId) => request<Run[]>(`/runs${storyId ? `?story_id=${encodeURIComponent(storyId)}` : ''}`),
    killRun: (runId, storyId) =>
        post<Run>(`/runs/${encodeURIComponent(runId)}/kill${storyId ? `?story_id=${encodeURIComponent(storyId)}` : ''}`),
    getQueue: () => request<QueueItem[]>('/queue'),
    requestAssistant: (storyId, body) => post<Run>(storyPath(storyId, '/assistant'), body),
    subscribeEvents
};

export default api;
