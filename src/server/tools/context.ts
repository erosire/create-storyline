/**
 * The runtime and the call pipeline (T-6, T-6a, T-1a, T-4, T-5, T-11).
 *
 * `createToolRuntime` builds the catalogue ONCE per process — T-6 registers the tools host-side
 * at session build so a fresh harness sees them on turn one with no discovery round trip — and
 * `createContext` pairs one bound session with it. Everything the pipeline below does is the
 * order §8 demands:
 *
 *  1. unknown tool            → refused naming T-6c, with the nearest names (the alternative is
 *                               an agent inventing a fifth spelling of the same verb);
 *  2. the bound Story (T-3)   → a run only sees its own Story, and the id comes from the session,
 *                               never from an argument;
 *  3. the role kind (T-0)     → the kind selects the §7 row; an unknown kind is refused rather
 *                               than defaulted, because a silent default would hand a Writer's
 *                               permissions to a Reader;
 *  4. `why` (T-5)             → checked BEFORE the schema, so a missing reason is refused with its
 *                               own rule id instead of a generic malformed-call error;
 *  5. the request body (T-11) → schema validation, including the required enum and the unknown
 *                               field name, inside the tool rather than in a prompt;
 *  6. `expects` (T-4)         → a read-modify-write call that sends no guard is refused, because
 *                               an unguarded write is the race the spec says to refuse;
 *  7. the §7 row (P10)        → permission, plus the P8/D-2a story-state guards, enforced here and
 *                               never by hiding the tool (T-1a);
 *  8. the tool body           → inside one store commit (the tool opens it), with `ToolRefusal` and
 *                               `CasConflict` rendered as results, not thrown across the harness.
 *
 * A refusal is a teaching message inside the run (T-1a): it names the rule, the artifact, and the
 * read or role that fixes it.
 */
import { ROLE_KINDS, type RoleKind, type Story } from '../../shared/types';
import type { Store } from '../store/store';
import type { ToolSchema } from '../llm/client';
import { ALL_TOOLS, TOOL_BY_NAME, TOOL_GROUPS } from './registry';
import { assertPermission, guardExpects } from './permissions';
import { describeToolPayload, validateArgs } from './schema';
import { buildAttribution, expectsOf, refusalResult, toFailureResult, whyOf } from './utilities';
import type {
    CreateContextHooks,
    RunSession,
    ToolContext,
    ToolDefinition,
    ToolExecutionContext,
    ToolResult,
    ToolRuntime
} from './types';

/** Options for {@link createToolRuntime}. `fetchImpl` keeps the §8.5 web tools offline in tests. */
export interface CreateToolRuntimeOptions {
    /** Replaces `globalThis.fetch` for `searchWeb`/`fetchPage` (D-37's "no network in tests"). */
    fetchImpl?: typeof fetch;
}

/** One §8 tool rendered as the OpenAI function shape the model is given (T-6). */
function toSchema(def: ToolDefinition): ToolSchema {
    return {
        type: 'function',
        function: {
            name: def.name,
            // T-6c: the one-line purpose is what `listTools` prints, so both read the same string.
            description: def.description,
            parameters: def.inputSchema
        }
    };
}

/** The schemas, built once — the same list on every session whatever the kind (T-6a). */
const SCHEMAS: ToolSchema[] = ALL_TOOLS.map(toSchema);

/**
 * The role kind a session runs as (T-0). An empty kind defaults to `writer`, because a dispatched
 * Work Item always names one (T-0's structural requirements) and the harness reaching this layer
 * without one is the degraded case; an UNRECOGNISED kind is refused instead, since defaulting a
 * typo like `writter` would silently grant Writer permissions to someone else.
 */
function resolveRole(session: RunSession): { role: RoleKind | null; reason?: string } {
    const raw = typeof session.roleKind === 'string' ? session.roleKind.trim().toLowerCase() : '';
    if (!raw) return { role: 'writer', reason: 'no role kind on the session, so the Writer row is used (T-0)' };
    if ((ROLE_KINDS as readonly string[]).includes(raw)) return { role: raw as RoleKind };
    return {
        role: null,
        reason: `"${session.roleKind}" is not a role kind, so no §7 row can be chosen for this session`
    };
}

/** The nearest registered names, so an unknown-tool refusal is fixable in one turn (T-6c). */
function nearestNames(name: string, limit = 6): string[] {
    const lower = name.toLowerCase();
    const scored = [...TOOL_BY_NAME.keys()]
        .map((candidate) => ({ candidate, score: similarity(lower, candidate.toLowerCase()) }))
        .filter((entry) => entry.score > 0.34)
        .sort((a, b) => b.score - a.score || a.candidate.localeCompare(b.candidate));
    return scored.slice(0, limit).map((entry) => entry.candidate);
}

/** Cheap Dice-coefficient similarity on bigrams — enough to catch `editChaper` style typos. */
function similarity(a: string, b: string): number {
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const grams = new Map<string, number>();
    for (let index = 0; index < a.length - 1; index++) {
        const gram = a.slice(index, index + 2);
        grams.set(gram, (grams.get(gram) ?? 0) + 1);
    }
    let hits = 0;
    for (let index = 0; index < b.length - 1; index++) {
        const gram = b.slice(index, index + 2);
        const left = grams.get(gram) ?? 0;
        if (left > 0) {
            grams.set(gram, left - 1);
            hits += 1;
        }
    }
    return (2 * hits) / (a.length - 1 + b.length - 1);
}

/**
 * The runtime the harness builds once per process (T-6). `store` is the only memory (P1), and the
 * runtime never opens a session of its own: the run layer owns the session, this layer owns what
 * a call may do inside it.
 */
export function createToolRuntime(store: Store, options: CreateToolRuntimeOptions = {}): ToolRuntime {
    // A missing injection falls back to the platform fetch; the web tools fail soft without it
    // (they report "no provider" rather than throwing across the harness).
    const fetchImpl: typeof fetch =
        options.fetchImpl ??
        ((input: RequestInfo | URL, init?: RequestInit) => (globalThis.fetch as typeof fetch)(input, init));

    return {
        schemas(): ToolSchema[] {
            // A copy, so a caller mutating the list cannot shrink the catalogue for everyone (T-6a).
            return SCHEMAS.slice();
        },

        createContext(session: RunSession, hooks: CreateContextHooks = {}): ToolContext {
            const { role } = resolveRole(session);
            // T-0: an unrecognised kind keeps a usable row rather than `null`, because the flat view
            // is typed total; `execute` is what refuses the call, naming T-0.
            const roleKind: RoleKind = role ?? 'writer';
            // The NAME resolution is duplicated from the `ToolExecutionContext` build below on
            // purpose: both must say the same thing, or the run's attribution and the context a
            // consumer reads disagree about who made the write (P11).
            const roleName =
                typeof session.roleName === 'string' && session.roleName.trim() ? session.roleName.trim() : roleKind;
            const delegate = hooks.delegate;

            return {
                // The pinned flat view (see `ToolContext`): six fields the run layer and the loop
                // engine read. `runRef` falls back to `runId` because the executor sends both and a
                // harness that sends only one must still be attributable (P11).
                storyId: typeof session.storyId === 'string' ? session.storyId.trim() : '',
                runRef: session.runRef ?? session.runId ?? '',
                templateRef: session.templateRef ?? '',
                roleName,
                roleKind,
                services: {
                    // The hook bag's richer answer is narrowed to the pinned `DelegateAnswer` here,
                    // so a consumer of the CONTEXT can only depend on what a delegate actually owes
                    // it (D-17e). The key is OMITTED when the run sent no hook — the tool body's own
                    // `!ctx.delegate` guard (editor.ts) reads the raw hook, and both agree on
                    // "this session cannot delegate".
                    ...(delegate
                        ? {
                              delegate: async (delegatedRole: string, task: string) => {
                                  const answer = await delegate(delegatedRole, task);
                                  return {
                                      ok: answer?.ok === true,
                                      summary: answer?.summary,
                                      error: answer?.error
                                  };
                              }
                          }
                        : {})
                },
                // This layer's internals: the raw session (runId, sessionRef, agents) and the
                // un-narrowed hooks, which also carry `fetchImpl` for the §8.5 web tools (D-37).
                session,
                role: roleKind,
                roleKnown: role !== null,
                hooks
            };
        },

        async execute(context: ToolContext, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
            // The run layer treats the context as opaque (`RunToolContext = unknown`), so a foreign
            // value is reported as a wiring fault rather than crashing mid-pipeline.
            if (!context || typeof context !== 'object' || !context.session)
                return {
                    ok: false,
                    error: 'execute received a context that did not come from createContext'
                };

            const toolName = String(name ?? '').trim();
            const def = TOOL_BY_NAME.get(toolName);
            if (!def)
                return refusalResult('T-6c', `no tool "${toolName}" is registered on this session`, {
                    tool: toolName,
                    // T-6c: presence is free, so the fix is one call away, not a guess.
                    similar: nearestNames(toolName),
                    catalogue_size: ALL_TOOLS.length,
                    fix: 'call listTools for the catalogue, or describeTool for the exact shape'
                });

            const { session, hooks } = context;
            const resolved = resolveRole(session);
            if (!resolved.role)
                return refusalResult('T-0', resolved.reason ?? 'this session has no usable role kind', {
                    role_kind: session.roleKind,
                    expected_kinds: [...ROLE_KINDS],
                    fix: 'the template names the kind on roles[].kind (T-0)'
                });
            const role = resolved.role;

            // T-3: the Story is bound, and a run that cannot resolve its Story has no records to
            // work on. `get` is global for the dashboard's benefit, so the boundary is checked here.
            const storyId = typeof session.storyId === 'string' ? session.storyId.trim() : '';
            const story = storyId ? (store.stories.get(storyId) as Story | undefined) : undefined;
            if (!story)
                return refusalResult(
                    'T-3',
                    `this session is bound to Story "${storyId || '(none)'}", which does not exist`,
                    {
                        story_id: storyId,
                        fix: 'spawn the run with the storyId of an existing Story (T-3)'
                    }
                );

            const argumentBag = (args ?? {}) as Record<string, unknown>;
            const why = whyOf({ args: argumentBag, tool: def });

            // T-5 first: a write with no reason is a separate rule from a malformed body, and §12
            // reads the refusal tally, so it must carry its own id.
            if (def.mutating && def.whyOptional !== true && !why)
                return refusalResult(
                    'T-5',
                    `${def.name} is a write, so it must carry why — every write records its reason`,
                    {
                        tool: def.name,
                        field: def.whyField ?? 'why',
                        ...(def.whyField ? { note: `this tool carries the reason in ${def.whyField}` } : {}),
                        fix: 're-send with a one-line why, then the write will be attributed (P11)'
                    }
                );

            // T-11: the body is validated here, not in the prompt. A malformed call is reported
            // field by field with the accepted shape.
            const issues = validateArgs(def, argumentBag);
            if (issues.length)
                return refusalResult('T-11', `${def.name} was called with an invalid request body`, {
                    tool: def.name,
                    issues,
                    // One call to fix it, instead of another guess (T-6c).
                    shape: describeToolPayload(def)
                });

            const expects = expectsOf(argumentBag);

            const roleContext: ToolExecutionContext = {
                tool: def,
                args: argumentBag,
                expects,
                store,
                storyId,
                story,
                role,
                roleName:
                    typeof session.roleName === 'string' && session.roleName.trim() ? session.roleName.trim() : role,
                actorLabel:
                    typeof session.roleName === 'string' && session.roleName.trim() ? session.roleName.trim() : role,
                runId: session.runId,
                templateRef: session.templateRef,
                // U-1e: §8.6's Author-invoked run is a distinct writer kind (§2/D-8). The flag rides in
                // the session because only the run layer knows the Work Item's kind, and every write
                // below inherits it from this context.
                assistant: session.assistant === true,
                attribution: buildAttribution(
                    { runId: session.runId, actorLabel: role, assistant: session.assistant },
                    why || `${def.name} (read)`
                ),
                // D-17e: the tool body reads the RAW hook, not `context.services.delegate`, so a
                // delegated answer keeps every field the inner loop sent; the narrowed
                // `DelegateAnswer` on the context is what an external consumer of the context sees.
                delegate: hooks.delegate,
                fetchImpl,
                // T-6c: the catalogue answers its own question from inside the run.
                catalogue: [...ALL_TOOLS]
            };

            // T-4: a read-modify-write call without a guard is refused before the row is consulted,
            // so an unguarded write is never mistaken for a permission problem.
            const expectsGuard = guardExpects(roleContext, expects);
            if (expectsGuard) return toFailureResult(expectsGuard);

            // §7 + P8 + D-2a. Never by hiding the tool: the call exists, the refusal is the record (T-1a).
            const permission = assertPermission(roleContext, def);
            if (permission) return permission;

            try {
                const result = await def.execute(roleContext, expects);
                // A read's `rev` is attached by the tool itself (T-8); the pipeline adds nothing, so
                // there is exactly one place that decides what a result means.
                return result;
            } catch (error) {
                // `ToolRefusal` → the rule message; `CasConflict` → T-4 with the CURRENT records;
                // anything else keeps its own message. Nothing is swallowed (T-1a).
                return toFailureResult(error);
            }
        }
    };
}

/** The catalogue split by §8 group, for the harness's own diagnostics and for the W2 conformance test. */
export function catalogueGroups(): Record<string, ToolDefinition[]> {
    return { ...TOOL_GROUPS };
}

/** The §8 shape of one registered tool, without going through a session (used by the dashboard's tool view). */
export function describeToolByName(name: string): Record<string, unknown> | undefined {
    const def = TOOL_BY_NAME.get(String(name ?? '').trim());
    return def ? describeToolPayload(def) : undefined;
}
