// T5 — the run layer's pinned surface: the Work Item the sweep hands a harness (W5), the
// RunResult the loop engine reads back (T6), and the LOCAL MIRROR of the tool runtime T3 owns.
//
// WHY A LOCAL MIRROR RATHER THAN AN IMPORT FROM `server/tools`: W5/W2 land in parallel, and §9
// makes the run layer independent of how the catalogue is built (T-6a registers the tools, the
// run layer only calls them). Every type below is STRUCTURAL and PERMISSIVE on purpose:
// a parameter typed `unknown` or an object type whose fields are all optional accepts whatever
// T3 actually ships (TS compares method parameters bivariantly), so integration is a report of
// the delta rather than a rewrite. Where the real shape differs, THIS file is the side that
// adapts — `src/server/tools/**` is not touched by this workstream.
import type { Store } from '../store';
import type { ChatClient, ToolSchema } from '../llm';
import type { RoleAggregation, UnitKind } from '../../shared/types';

// ---------------------------------------------------------------------------
// The Work Item (§9 `sweep → Work Item claimed (lease)`, S-1)
// ---------------------------------------------------------------------------

/**
 * The jobs the loop can dispatch. `assistant` is the Author-invoked run of §8.6 (Author
 * write rights for one run, no web tools, never a locked artifact); everything else is a
 * dispatched Work Item. §6.2 names the original eight as the three loops' jobs; phase ① adds
 * granular jobs — the Seed structuring, the research pass and the two one-turn structured
 * passes — so no thread has to carry a whole batch of decisions.
 *
 * PHASE-1 RESEARCH PIPELINE (documents/phase-1-research-pipeline.md §6.1):
 *   - `structure_seed` — the Editor derives the Seed Brief from the Author's Seed (no brief =
 *     no sampling, §6.4 gate 1); the Seed itself is never written (P5).
 *   - `research` — the Researcher gathers Knowledge for the accepted Seed Brief (§6.4 gate 2).
 *   - `sample_unit` — the Writer's one-turn, NO-TOOL structured sample (`toolMode: 'none'`).
 *   - `screen_samples` — the screening Critic's one-turn, NO-TOOL structured IssueList.
 * `seed_review` was REPLACED by `structure_seed` (no backward compatibility: the sweep and the
 * brief are the only readers of this vocabulary and both moved in the same wave).
 */
/**
 * SUMMARY PHRASE (R2/R5): the two jobs that REPLACE phase ①'s competing sampling for a
 * group-managed Story, and the reason `sample_unit`/`screen_samples` are still in this union.
 *
 *   - `draft_groups` — the Writer's one-turn, NO-TOOL structured answer (`GroupDraft`), for ONE or
 *     MANY groups at once (`WorkItem.groupRefs`). An accepted answer is INSTALLED immediately
 *     (R5): there is no round, no competing set, and no selection to lose. It is the only kind that
 *     HOLDS a group, which is what makes R4's exclusion meaningful.
 *   - `review_groups` — the Critic's one-turn, NO-TOOL structured answer (`GroupReview`), reading
 *     the INSTALLED Overview and naming, group by group, what is wrong with it (R3) and fix by fix
 *     whether the approved work is in it.
 *
 * `sample_unit` and `screen_samples` stay in the union, and stay renderable in `run/brief.ts`,
 * because run rows and work items written before the redesign still name them (R6: a legacy book is
 * readable with no migration). A group-managed Story simply never generates either of them.
 */
export const WORK_ITEM_KINDS = [
    'structure_seed',
    'research',
    'sample_unit',
    'screen_samples',
    'draft_groups',
    'review_groups',
    // READER SCORING (D-65): the one-turn, NO-TOOL `SectionScores` pass over the installed Overview.
    // It is the only kind whose whole product is a display row — it files no finding, no task and no
    // verdict, and nothing in `loop/**` reads what it writes.
    'score_sections',
    // PHRASE GROUP LOCK (R-lock): the Editor's one-turn, NO-TOOL `GroupLockDecision` pass over ONE
    // section of the clean Overview, offered only on a Story that enables `editor_group_locking`. Its
    // product is a flag on the `phrase_groups` row (`phrase/locks.ts:lockPhraseGroup`, actor `editor`)
    // or nothing at all — it writes no row of its own, holds no write allowance, and is never owed
    // work, so an unscored or undecided section never holds the drain or the sign-off gate.
    'group_lock',
    'write_unit',
    'check_unit',
    'select',
    'verify_findings',
    'confirm_finding',
    'verify_ideas',
    'merge',
    'whole_story_check',
    'directive_work',
    'assistant'
] as const;

export type WorkItemKind = (typeof WORK_ITEM_KINDS)[number];

/** §4.15 `unit_kind` + the record the job is about — the unit named in the brief (S-2). */
export interface WorkUnitRef {
    kind: UnitKind;
    ref: string;
}

/**
 * One job, one fresh thread (S-1: "one Work Item = one Run = one fresh thread. A thread is
 * never handed a second job"). The claim/lease lives with the sweep (L-2, W5); this is the
 * payload it hands over, and it is deliberately ref-only (tasks, findings, Ideas, directives
 * are read from the store, so the brief is assembled from ONE source — S-2, P1).
 */
export interface WorkItem {
    id: string;
    storyId: string;
    kind: WorkItemKind;
    /** Template id or slug (§4.12 `name`); resolved against `store.templates`. */
    templateRef: string;
    /** Role name inside that template (`roles[].name`), or a role KIND. */
    roleName: string;
    unit?: WorkUnitRef;
    /** Open tasks this job must clear (S-2: "the open tasks that job must clear"). */
    taskRefs?: string[];
    /**
     * H1 (R1/R2) — the OPEN `fix` task ids this job's compiled prompt carries, captured when the job
     * was queued. Set on phase ①'s `sample_unit` (the Writer must see the fixes with their evidence,
     * not just their titles) and `screen_samples` (the Critic grades the candidate against them).
     *
     * WHY THE JOB CARRIES THE LIST INSTEAD OF EVERY RUN READING THE STORE: two reasons, both load
     * -bearing. (1) §5's cache rule wants every sample of one round to send a byte-identical prompt,
     * and a list re-read at dispatch time can grow mid-round; (2) the screening verdict is only
     * gradeable against the fixes the Critic was actually handed, so the engine persists this list
     * onto the `sample_reviews` row (`fix_refs`) and a fix task that opened after the round's screens
     * were dispatched cannot retroactively disqualify the round.
     *
     * It is NOT `taskRefs`: that field is work the run must CLOSE (`settleJob` marks each one `done`
     * when the run completes), and a sampling round closes nothing — closure waits for the
     * verification evidence (R4).
     */
    fixRefs?: string[];
    /**
     * SUMMARY PHRASE R2/R4 — the `phrase_groups` ids this job writes or reads, in CATALOG ORDER.
     *
     * WHY THE JOB CARRIES THE SET AT ALL, three separate reasons, all of them load-bearing:
     *   - R4's exclusion is enforced from PERSISTED state. `run/executor.ts` copies this list onto the
     *     Run row (`Run.group_refs`) when the row is created, so a restart re-derives "which groups
     *     are already being written" from the live rows the lease sweep already walks — no in-memory
     *     semaphore has to agree with the book;
     *   - R2's atomicity needs the EXPECTED set. The Writer's `GroupDraft` answer is validated
     *     against it (`phrase/revisions.ts:parseGroupDraftAnswer`): an answer that skips a named group
     *     or writes one nobody asked for is refused whole, rather than installing a partial batch;
     *   - a review pass must be able to name the groups it judged, and its findings' `group_refs`
     *     (R3) have to be ids that were actually in front of it.
     *
     * It is NOT `taskRefs`: that field means "tasks this run CLOSES when it finishes" (`settleJob`
     * marks them `done`), and a group draft closes nothing on completion — the fix tasks and their
     * findings close on the EVIDENCE the install and the review leave in the book. Same distinction
     * `fixRefs` already draws for a sampling job.
     */
    groupRefs?: string[];
    /** Findings to verify (D-33) or to fix (D-34). */
    findingRefs?: string[];
    /** Ideas this job must absorb or verify (D-29, D-27). */
    ideaRefs?: string[];
    /** D-19: the directive to propagate. */
    directiveRef?: string;
    /**
     * §4.15's competing draft this job reads. A Critic review judges ONE Summary sample, and
     * D-21 keeps the other samples out of its brief; the Editor's `select` carries none because
     * it is the one role that may see the whole set.
     */
    revisionRef?: string;
    /** Free-text line from the sweep (e.g. a re-brief after `rejectAll`, L-18). */
    note?: string;
    /**
     * `'tools'` (default, every existing run) or `'none'` — phase ①'s single-turn
     * sampling/screening execution mode (§2 decision 3, §6.4). It is an EXECUTION mode, never a
     * permission change: the permission row and the catalogue stay uniform; a `'none'` run is
     * simply never offered a tool (`toolsForRunKind` returns `[]`) and the transport asks for a
     * schema-constrained answer instead of tool calls.
     */
    toolMode?: 'tools' | 'none';
    /**
     * Structured-output contract for a no-tool run: the schema NAME and the plain JSON Schema
     * literal from `src/shared/schemas` (`SummarySample`, `IssueList`). Absent means the run is
     * a tool-carrying prose run.
     */
    responseSchema?: { name: string; schema: Record<string, unknown> };
    /** 1-based sample index within its round — drives the provider `seed` (§5's diversity knob). */
    sampleIndex?: number;
    /**
     * The compiled prompt's hash (the compiler's 16-char sha256 prefix), recorded onto the
     * revision for cache/audit (P11, §5). The executor also copies it onto `RunResult.promptHash`
     * and the run row's `brief_hash`, because that IS the memory this run was given.
     */
    promptHash?: string;
    /**
     * The sampling round this job belongs to (1-based; absent means 1). It is not derivable from
     * the store — a round-2 sample must read the previous round's SELECTED revision — so the
     * sweep states it on the item and the compiler consumes it (§5's base-revision rule).
     */
    round?: number;
}

// ---------------------------------------------------------------------------
// The RunResult (§9 teardown → the loop's input for L-15/L-37 accounting)
// ---------------------------------------------------------------------------

/**
 * What the run layer reports to the loop engine. `no_op` is S-4's flag (a run that called no
 * report tool counts toward loop detection); `toolsCalled` is what actually EXECUTED — a
 * proposal intercepted inside a D-38 panel is not an execution, so it is not listed here.
 * `tokens` is S-6/E-0: informational, never a limit.
 */
export interface RunResult {
    runId: string;
    /**
     * `completed` = the model returned no tool_calls and teardown closed the row
     * naturally; `killed` = the signal aborted (Author Stop P8/U-7, or lease expiry S-4a —
     * the run row says which via `end_reason`); `failed` = the LLM or a store fault threw.
     */
    ended: 'completed' | 'killed' | 'failed';
    no_op: boolean;
    tokens: number;
    toolsCalled: string[];
    error?: string;
    /**
     * The validated JSON answer of a `toolMode: 'none'` run (a `SummarySample` or an
     * `IssueList`, validated against `item.responseSchema`), or undefined. The engine persists
     * it from here — the Writer/Critic never calls a tool in this mode (§2 decision 2).
     */
    structured?: unknown;
    /** Byte-stable prompt hash, copied onto the revision's `prompt_hash` (§3.5, §5's cache key). */
    promptHash?: string;
    /**
     * Cache accounting, INFORMATIONAL ONLY (E-0): the summed provider usage of the (at most two)
     * requests the structured run made. `cached_input` is what a cache-aware provider reports,
     * and nothing in this build branches on it.
     */
    usage?: { input: number; output: number; cached_input: number };
}

// ---------------------------------------------------------------------------
// The T3 tool runtime, as the run layer needs it (pinned interface)
// ---------------------------------------------------------------------------

/**
 * A tool result, mirrored from T3's pinned `ToolResult` (`src/server/tools/types.ts`) with the
 * fields this layer actually reasons about plus the ones it must not lose.
 *
 * The run layer JSON-serialises the WHOLE object into the transcript, so T-4's `currents`, T-8's
 * read revision and T-1a's `refused` rule id reach the model exactly as the tool layer wrote them
 * (S-2's "the refusal is a teaching message inside the run" depends on that). Only `ok` is read
 * here — and `proposed`, which is NOT a T3 field: it is this layer's own D-38 marker, written by
 * the panel's runtime wrapper and by nothing else.
 */
export type ToolResult = {
    ok?: boolean;
    summary?: string;
    error?: string;
    /** T3's payload for a read (T-7: bounded and structured). */
    data?: unknown;
    /** T-8: the revision the call read or produced, so the next `expects` is right first time. */
    rev?: number;
    /** T-1a: the rule id a refusal was raised under (P10, L-19, P5, D-12a…). */
    refused?: string;
    /** T3's human-readable message (a refusal, or anything the agent must be told). */
    message?: string;
    /** T-4: the write was rejected because the record moved. */
    cas_conflict?: boolean;
    /** T-4: the CURRENT records, so the agent re-reads and re-applies instead of forcing. */
    currents?: { id: string; record: unknown }[];
    /** D-16/D-32: the call re-raised something that already exists. */
    repeat?: boolean;
    /** D-16/D-32: the existing finding a deduped `raiseFinding` pointed at. */
    finding_id?: string;
    /** D-38 only: this layer's interception marker — the call was recorded, not applied. */
    proposed?: boolean;
};

/**
 * True when a result is a D-38 interception record rather than an executed write.
 *
 * The marker is written by THIS layer ({@link interceptingRuntime} in ./panel), never by the tool
 * layer: T3's `ToolResult` has no `proposed` field, and it should not — a proposal is a property
 * of the panel, not of the tool. The loop uses this to keep a proposal out of `toolsCalled` and
 * out of S-4's no-op accounting, while the agent still gets a `summary` explaining that its write
 * was recorded rather than applied.
 */
export const isProposedResult = (result: ToolResult): boolean => result.proposed === true;

/**
 * The session T3 builds its tool context from. All fields optional so T3's own session shape
 * stays assignable in at least one direction; the run layer always fills every one of them,
 * because T-3 needs `storyId` bound (no tool takes a storyId argument) and P11/T-5 need the
 * run identity to attribute writes.
 */
export type RunToolSession = {
    storyId?: string;
    /** §4.13 id of the run row this context belongs to (D-18). */
    runId?: string;
    /** The run attribution a write carries (P11). For a sub-context this is the PARENT's id. */
    runRef?: string;
    /** `'sess_' + runId` — the tool-runtime context id for this Run's thread; one per run, never reused. */
    sessionRef?: string;
    templateRef?: string;
    /**
     * Role NAME within the template (crew panel, U-7). Named `roleName`, not `role`, because that
     * is the field the tool layer binds into its context (`RunSession.roleName` in
     * `src/server/tools/types.ts`); the `runs` RECORD's field is `role` and is a RoleKind, which is
     * a different thing and is set by the executor from the resolved kind.
     */
    roleName?: string;
    /** D-17a/T-6a: the kind selects the permission row — and a sub-context inherits it (T-2b). */
    roleKind?: string;
    /** D-38: how many agents this run is running, for the runtime's own diagnostics. */
    agents?: number;
    aggregate?: string;
    /** S-7: which nested context asked for this session (`<role>#agent_2`, or a delegate name). */
    delegatedRole?: string;
    /**
     * U-1e: true when this session belongs to §8.6's Author-invoked run (`WorkItemKind === 'assistant'`).
     * It is what makes every write the run makes record `attribution.assistant` (§2), and the run
     * layer sets it rather than inferring it, because the tool layer must not re-derive run kinds from
     * role names (T-0's lesson: an inferred identity is a permission bug waiting to happen).
     */
    assistant?: boolean;
};

/**
 * The hook bag the run layer hands the runtime: exactly what the tool layer's `CreateContextHooks`
 * declares today (`src/server/tools/types.ts`) — the D-17e/T-2b `delegate` seam, where the run
 * answers a `delegate` tool call with an inner agent loop.
 *
 * D-38's panel interception is deliberately NOT a hook here: the tool layer has no interception
 * seam, and this layer does not own its files, so the panel wraps the runtime instead
 * ({@link interceptingRuntime} in ./panel) and keeps the contract between the two layers exactly
 * what T3 pinned. Both fields stay optional because the runtime declares its own hook bag as
 * optional (`createContext(session, hooks?)`); this layer always fills `delegate`.
 */
export type RunToolHooks = {
    delegate?: (role: string, task: string) => ToolResult | Promise<ToolResult>;
};

/**
 * The opaque context `createContext` returns. `unknown` is the point: the run layer pairs a
 * context with `execute` and never inspects it, so T3's context type cannot drift this layer.
 */
export type RunToolContext = unknown;

/** T3's contract, mirrored (schemas for the model, a context per session, one execute). */
export interface ToolRuntime {
    schemas(): ToolSchema[];
    createContext(session: RunToolSession, hooks?: RunToolHooks): RunToolContext;
    execute(context: RunToolContext, name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// The executor's dependency bag
// ---------------------------------------------------------------------------

/** Everything a run needs: the store (the only memory, P1), the tools, the transport, the model. */
export interface RunExecutorDeps {
    store: Store;
    runtime: ToolRuntime;
    chat: ChatClient;
    defaultModel: string;
    /**
     * The per-Story engine harness registry. Omitted means the executor builds its own over the
     * same store/chat/runtime; the server passes the one it owns so `GET /agents` and the run
     * path observe the same threads.
     */
    harness?: import('./story-engine').StoryHarnessManager;
    /** The retained thread history, written when each thread closes (request + answer). */
    threadLog?: import('./thread-log').StoryThreadLog;
}

/** How many journal entries the "what changed since the last pass" section carries (S-2). */
export const CHANGE_NOTE_LIMIT = 10;

/**
 * The panel's nested crew label (S-7): delegated sub-contexts are shown under the run that
 * spawned them rather than in their own rows, so they are keyed by role, not by run id.
 */
export const panelAgentRoleLabel = (roleName: string, index: number): string => `${roleName}#agent_${index}`;

/** Resolves an aggregation mode, defaulting to `majority` when a role declares agents without one. */
export const resolveAggregation = (agents: number, aggregate?: RoleAggregation): RoleAggregation =>
    agents > 1 ? (aggregate ?? 'majority') : 'majority';
