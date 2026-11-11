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
 * The nine jobs the loop can dispatch. `assistant` is the Author-invoked run of §8.6 (Author
 * write rights for one run, no web tools, never a locked artifact); everything else is a
 * dispatched Work Item. §6.2 names the first eight as the three loops' jobs.
 */
export const WORK_ITEM_KINDS = [
    'write_unit',
    'check_unit',
    'select',
    'verify_findings',
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
 * One job, one fresh harness (S-1: "one Work Item = one Run = one fresh session. A run is
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
    /** Findings to verify (D-33) or to fix (D-34). */
    findingRefs?: string[];
    /** Ideas this job must absorb or verify (D-29, D-27). */
    ideaRefs?: string[];
    /** D-19: the directive to propagate. */
    directiveRef?: string;
    /** Free-text line from the sweep (e.g. a re-brief after `rejectAll`, L-18). */
    note?: string;
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
    /** `'sess_' + runId` (S-1: one session per run, never reused). */
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
