/**
 * W2 — the tool surface (§8), and the pinned external contract.
 *
 * What the rest of the server is allowed to import from this directory is exactly this barrel:
 * the run layer pairs `createToolRuntime` with its own `ToolRuntime` mirror
 * (`src/server/run/types.ts`) and never reaches into a file here, which is what keeps T-6a's
 * "every session gets the whole catalogue" and T-1a's "the server enforces the row at the call"
 * in one place. The mirror declares the context as `unknown`, so this layer exports the opaque
 * handle under the name the mirror uses (`RunToolContext`).
 *
 * Nothing in this file decides policy: §7 lives in `permissions.ts`, the §8 arg shapes in
 * `schema.ts`, the catalogue in `registry.ts`, and the call pipeline in `context.ts`.
 */

/** The runtime factory: one catalogue per process, one context per session (T-6). */
export { catalogueGroups, createToolRuntime, describeToolByName, type CreateToolRuntimeOptions } from './context';

/** The pinned shapes the run layer mirrors, plus the row vocabulary it can quote. */
export type {
    CreateContextHooks,
    DelegateAnswer,
    PermissionLevel,
    RunSession,
    RunToolServices,
    ToolContext,
    ToolDefinition,
    ToolExecutionContext,
    ToolResult,
    ToolRuntime
} from './types';

/**
 * The opaque per-session handle, exported under the name the run layer's mirror calls it
 * (`RunToolContext` in `src/server/run/types.ts`). It is deliberately opaque: the run layer pairs
 * it with `execute` and never inspects it, so this layer cannot drift the contract.
 */
export type { ToolContext as RunToolContext } from './types';

/** §7 as data, and the two pure permission questions. */
export {
    checkPermission,
    levelFor,
    mayCallKind,
    PERMISSION_ROWS,
    permissionRow,
    type PermissionRow
} from './permissions';

/** The catalogue, for the harness and for the §8 conformance test (T-6a, T-6c). */
export {
    ALL_TOOLS,
    GOVERNED_COLLECTIONS,
    GROUP_OF_TOOL,
    SPEC_TOOL_NAMES,
    TOOL_BY_NAME,
    TOOL_GROUPS,
    TOOL_NAMES
} from './registry';

/** The §8 arg schema builders, re-exported so a harness can describe a tool without a session. */
export { describeToolPayload, validateArgs } from './schema';

/** The refusal vocabulary: what a caller outside the pipeline can expect to receive. */
export { refusalResult, ToolRefusal, toFailureResult } from './utilities';
