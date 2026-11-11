/**
 * W2 — the tool layer's internal contracts (§8).
 *
 * The pinned external surface is `index.ts` (`createToolRuntime`, `ToolResult`,
 * `RunToolContext`, `ToolRuntime`), which mirrors `src/server/run/types.ts`'s
 * local mirror of this layer (T-6a/T-1a): the run layer never imports these files, so the
 * shapes below must stay assignable to that mirror.
 *
 * §7 is enforced here, never by hiding tools: every session gets the whole catalogue
 * (T-6a) and the pipeline refuses a call the role may not make, naming the rule (T-1a).
 */
import type { CollectionName, Cost, RoleKind, StoryPhase } from '../../shared/types';
import type { CAS, Store } from '../store/store';
import type { ToolSchema } from '../llm/client';

/** One §8 tool. `writes` names the §7 row that governs it (P10). */
export interface ToolDefinition {
    name: string;
    /** The line `listTools` prints (T-6c). */
    description: string;
    /** OpenAI function parameters; `describeTool` returns this verbatim (T-6c). */
    inputSchema: Record<string, unknown>;
    /** The §4 collection the tool mutates, or the one its permission row names for a read. */
    writes: CollectionName;
    /** The §7 level the call needs. A `read` is allowed for every kind except `none`. */
    level: PermissionLevel;
    /**
     * True when the call writes. Drives T-5 (a `why` is mandatory) and, when the §8 table
     * lists it, T-4 (`expects`). Set false for the two `edit*` plumbing tools that only
     * validate, and for `delegate`, which writes nothing here.
     */
    mutating: boolean;
    /**
     * True when §8's arg table lists `expects`. The pipeline then refuses a missing one
     * naming T-4. Reads and fire-and-report tools (`raiseFinding`, `createTask`,
     * `submitVerdict`, `proposeIdea`, …) are `false`: they create rows, they do not
     * read-modify-write one.
     */
    expectsArg?: boolean;
    /**
     * Arg whose text is the write's `why` when it is not literally called `why`
     * (§8.2 `selection_note`). The named arg is still validated as required.
     */
    whyField?: string;
    /**
     * True for the three report tools whose §8 row lists no `why` (`submitVerdict`,
     * `raiseFinding`, `markChapterDone`). T-5 still holds — the write carries a reason — but the
     * tool synthesises it from the call, because §8 made the arg optional there.
     */
    whyOptional?: boolean;
    /** Required args validated before the permission row (T-11). */
    requires?: string[];
    /** Arg name → enum values, kept for `describeTool`'s "what it takes" answer (T-6c). */
    enums?: Record<string, readonly string[]>;
    /**
     * Role kinds the §7 row alone would not allow, spelled out where §8 grants the tool
     * explicitly (e.g. `proposeIdea` for a Reader, D-26). Empty means: follow the row.
     */
    kinds?: RoleKind[];
    /**
     * The inverse of `kinds`, for the few tools §8 assigns to one role while §7's row is broader.
     * `selectRevision` is the case: the Writer holds `write` on `revisions` because it CREATES
     * them through `editChapter` (§7), but choosing between them is the Editor's job (T-3b), so
     * the row alone would let a Writer pick its own draft.
     */
    onlyKinds?: RoleKind[];
    /** The arg `describeTool` calls the target, so the hint can point at the right read. */
    primaryArg?: string;
    /** Runs inside one store commit; may return a Promise (web tools, `delegate`). */
    execute(ctx: ToolExecutionContext, expects: CAS[]): ToolResult | Promise<ToolResult>;
}

/** §7's level vocabulary, plus `none` for the cells that refuse. */
export type PermissionLevel = 'read' | 'propose' | 'write' | 'verify' | 'write_verify' | 'recommend' | 'none';

/** A tool result, shaped for the run layer's mirror (`RunToolResult` in `run/types.ts`). */
export interface ToolResult {
    ok: boolean;
    /** Bounded, structured payload (T-7). */
    data?: unknown;
    /** T-8: the revision the call read or produced, so the next `expects` is right first time. */
    rev?: number;
    /** T-4: the CURRENT records, so the agent re-reads and re-applies instead of forcing. */
    currents?: { id: string; record: unknown }[];
    /** T-1a: the rule id a refusal was raised under (P10, L-19, P5, D-12a…). */
    refused?: string;
    /** D-16/D-32: the call re-raised something that already exists. */
    repeat?: boolean;
    /** D-16: the existing finding a deduped `raiseFinding` pointed at. */
    finding_id?: string;
    /** D-32: the existing Idea a deduped `proposeIdea` pointed at. */
    idea_id?: string;
    /** §8.1: the proposal a propose-only path filed instead of writing. */
    proposal_id?: string;
    /** §8.2: the revision a divergence write filed. */
    revision_id?: string;
    /** §4.7: the task a report tool filed. */
    task_id?: string;
    /** One-line human string for the run log and the dashboard. */
    summary?: string;
    /** Agent-visible prose: a refusal message or a next-step note. */
    message?: string;
    /** T-4: the write was rejected because the record moved. */
    cas_conflict?: boolean;
    error?: string;
    [key: string]: unknown;
}

/** The session the run layer binds into a context (T-3: the story id comes from here). */
export interface RunSession {
    /** T-3: bound, never an argument. */
    storyId: string;
    /** §4.13 id of the run row this context belongs to (D-18); attribution rides on it. */
    runId?: string;
    /** The run attribution a write carries (P11). For a sub-context this is the parent's id. */
    runRef?: string;
    /** `'sess_' + runId` (S-1). */
    sessionRef?: string;
    templateRef?: string;
    /** Role NAME inside the template (crew panel, U-7). */
    roleName?: string;
    /** D-17a/T-6a: the kind selects the permission row; a sub-context inherits it (T-2b). */
    roleKind?: RoleKind;
    /** D-38: how many agents this run is running. */
    agents?: number;
    aggregate?: string;
    /** S-7: which nested context asked for this session. */
    delegatedRole?: string;
    /**
     * U-1e: this session belongs to §8.6's Author-invoked run. The run layer sets it (it is the only
     * layer that knows the Work Item's kind) and the tool layer copies it into every write's
     * attribution, which is what §2 asks for: a journal that can tell "the machine, on the Author's
     * instruction" from "the machine, on its own" (D-8, `store.ts`'s Attribution).
     */
    assistant?: boolean;
}

/** The hook bag the run layer answers with; `delegate` is §8.2's D-17e seam. */
export interface CreateContextHooks {
    /** `delegate(role, task)`; the run answers with an inner agent loop (T-2b). */
    delegate?: (role: string, task: string) => ToolResult | Promise<ToolResult>;
    /** Overrides `globalThis.fetch` so the web tools run offline in tests (D-37). */
    fetchImpl?: typeof fetch;
}

/**
 * The narrow answer a delegate owes the CALLING tool (D-17e/T-2b): the run layer's inner loop
 * reports `ok` plus prose, and nothing else crosses back.
 *
 * The hook bag may answer with a whole {@link ToolResult} (that is what `MockToolRuntime` and the
 * real executor do); `services.delegate` narrows it to these three fields, which is the shape the
 * run layer pins for a delegated answer. Widening it here would let a tool body start depending on
 * a field the delegate was never obliged to send.
 */
export interface DelegateAnswer {
    ok: boolean;
    summary?: string;
    error?: string;
}

/**
 * The pinned service bag a context carries (`RunToolContext.services`).
 *
 * WHY A BAG RATHER THAN A RAW HOOK: the run layer's mirror (`MockRunContext` in
 * `src/server/run/mock.ts`) reaches the delegate through `ctx.services.delegate`, so the context
 * publishes its capabilities as services while `CreateContextHooks` stays this layer's private
 * wiring (it also carries `fetchImpl`, which is a transport detail, not a capability).
 */
export interface RunToolServices {
    /** Present only when the run layer supplied the hook (D-17e); absent ⇒ `delegate` refuses. */
    delegate?: (roleName: string, task: string) => Promise<DelegateAnswer>;
}

/** What a tool body receives. Everything is bound; no tool takes a storyId (T-3). */
export interface ToolExecutionContext {
    tool: ToolDefinition;
    /** Validated args (T-11). */
    args: Record<string, unknown>;
    /** The compare-and-swap entries the call sent, already shape-checked (T-4). */
    expects: CAS[];
    store: Store;
    storyId: string;
    /** The live story row, read once by the pipeline for the guards (P8/D-2a/P5/L-7). */
    story: Story;
    /** §7's row selector. `reader` and `checker` share the last column (T-1b). */
    role: RoleKind;
    /** Role NAME inside the template, for `owner_role` and audit prose. */
    roleName: string;
    /** `roleName` or a kind fallback — what a write records as its actor. */
    actorLabel: string;
    runId?: string;
    templateRef?: string;
    /**
     * U-1e: true when this call runs inside §8.6's Author-invoked run. Copied from the session so a
     * tool body can ask the question directly (and so `buildAttribution` can record it — §2).
     */
    assistant?: boolean;
    /** Attribution for every write: run, actor and `why` (P11/T-5). */
    attribution: { run_ref?: string | null; author?: boolean; assistant?: boolean; why: string };
    /**
     * The catalogue this session holds (T-6a: the whole §8 list), set by the pipeline so
     * `listTools` and `describeTool` can answer from inside the run (T-6c) without importing the
     * registry themselves — which would close an import cycle through `context.ts`.
     */
    catalogue?: ToolDefinition[];
    /** D-17e: present only when the run layer supplied a hook. */
    delegate?: CreateContextHooks['delegate'];
    fetchImpl: typeof fetch;
}

/** The runtime the harness builds once per process (T-6: registered at session build). */
export interface ToolRuntime {
    /** The WHOLE catalogue on every session, whatever the role kind (T-6a). */
    schemas(): ToolSchema[];
    createContext(session: RunSession, hooks?: CreateContextHooks): ToolContext;
    execute(context: ToolContext, name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

/**
 * Opaque handle pairing a bound session with the catalogue.
 *
 * The run layer pairs this with `execute` and never inspects it (`RunToolContext = unknown` in
 * `src/server/run/types.ts`), but the shape is still a PINNED CONTRACT: the run layer's own fake
 * (`MockRunContext` in `src/server/run/mock.ts`) and the loop engine are written against these six
 * field names — `storyId`, `runRef`, `templateRef`, `roleName`, `roleKind`, `services` — because a
 * panel agent and a delegate both have to be attributed from the context alone (P11, D-17e). So the
 * flat view below is what a consumer reads, and the four fields after it are this layer's own
 * internals, kept because `execute` needs the raw session (runId, sessionRef, agents) and the
 * un-narrowed hook bag. `runtime.test.ts` pins the flat view with an exact-value assertion so this
 * cannot drift without a failing test.
 */
export interface ToolContext {
    /** T-3: the bound Story, trimmed. No tool takes a storyId argument, so this is the only source. */
    storyId: string;
    /** The run a write is credited to (P11); falls back to `session.runId`, which is the same id. */
    runRef: string;
    /** The template the session was spawned from ('' when the caller named none). */
    templateRef: string;
    /** Role NAME inside the template, resolved the same way `ToolExecutionContext.roleName` is. */
    roleName: string;
    /**
     * The §7 kind for this session (T-0). An unrecognised kind still carries a usable value — the
     * row it would have used — because `execute` is what refuses it, naming T-0.
     */
    roleKind: RoleKind;
    /** D-17e: the capabilities the run layer injected, resolved from `hooks` at bind time. */
    services: RunToolServices;

    // ── internals this layer owns; the run layer never reads these ──────────
    session: RunSession;
    role: RoleKind;
    /**
     * False when `session.roleKind` named something that is not a §4.12 role kind. The context
     * still carries a usable `role` (so the type stays total), and `execute` refuses the call
     * naming T-0 rather than running an unknown kind on a guessed row.
     */
    roleKnown?: boolean;
    hooks: CreateContextHooks;
}

/**
 * The context under the name the run layer's mirror uses. Kept as an alias so `index.ts` can export
 * it without re-declaring the shape, which is what stops the two definitions drifting apart.
 */
export type { ToolContext as RunToolContext };

/** Re-exported so the tool modules import one place. */
export type { CAS, CollectionName, Cost, RoleKind, StoryPhase, Store, Story };
import type { Story } from '../../shared/types';
