/**
 * §7 as data: one row per artifact, transcribed cell for cell, plus the guards the matrix
 * cannot express as a level (the two lock flags, the Author's spans, the derived Digest).
 *
 * §7's columns are Author | Assistant | Writer | Editor | Checker/Reader. Only the last four
 * matter here — the Author and the Assistant are not dispatched kinds — and `reader` and
 * `checker` share the last column except where T-1b says otherwise. Permission is enforced at
 * the call, never by hiding the tool (T-1a), and the refusal names the rule (§12 W2).
 */
import type { RoleKind } from '../../shared/types';
import type { CAS, Store } from '../store/store';
import { isCompleted, isStopped, refusalResult, rolePhrase, toFailureResult, ToolRefusal } from './utilities';
import type { PermissionLevel, ToolDefinition, ToolExecutionContext, ToolResult } from './types';

/** One §7 row: the artifact, the four dispatched kinds' levels, and the rules it encodes. */
export interface PermissionRow {
    /** Artifact as §7 names it, mapped to the §4 collection a tool writes. */
    artifact: string;
    /** The §4 collection name the tool layer keys on; `''` for a field-level row. */
    collection: string;
    writer: PermissionLevel;
    editor: PermissionLevel;
    checker: PermissionLevel;
    reader: PermissionLevel;
    /** The rules this row enforces, quoted by `describeTool` so the agent can read the law. */
    criterion_refs: string[];
    /**
     * Rule id to name instead of P10 for a specific kind, because §12 W2 demands it: an
     * Editor's prose write is refused naming L-19, not P10.
     */
    refusal_rules?: Partial<Record<RoleKind, string>>;
    /**
     * The `fix` a refusal from this row carries, when "hand this to another kind" is the wrong
     * advice. `updateDigest` is the case: nobody may write the Digest, so the only correct next
     * call is the `digest_gap` task (D-13), and a refusal that said "give it to a Writer" would
     * send the agent into a second refusal.
     */
    refusal_fix?: string;
    /** §7's prose for the row, so `describeTool` can quote the row it enforced. */
    note?: string;
}

/** §7's permission matrix, transcribed row for row (Author/Assistant columns are documentation). */
export const PERMISSION_ROWS: PermissionRow[] = [
    {
        artifact: 'stories.idea (the Seed)',
        collection: 'stories',
        writer: 'read',
        editor: 'read',
        checker: 'read',
        reader: 'read',
        criterion_refs: ['P5', 'D-3b', 'D-25a'],
        note: 'Author-written, read-only for every agent at every phase, forever'
    },
    {
        artifact: 'summaries (prose)',
        collection: 'summaries',
        writer: 'write',
        editor: 'read',
        checker: 'read',
        reader: 'read',
        criterion_refs: ['D-3', 'T-3c', 'L-30', 'P5'],
        refusal_rules: { writer: 'T-3c' },
        note: 'the Writer writes only in phase `summary` and only while `summary_locked` is false'
    },
    {
        artifact: 'summaries.chapter_count',
        collection: 'summaries',
        writer: 'read',
        editor: 'read',
        checker: 'read',
        reader: 'read',
        criterion_refs: ['D-3b', 'D-3c'],
        note: 'author truth: declared, never chosen by an agent'
    },
    {
        artifact: 'ideas',
        collection: 'ideas',
        writer: 'read',
        editor: 'verify',
        checker: 'write',
        reader: 'write',
        criterion_refs: ['D-26', 'D-27', 'D-31', 'D-32'],
        note: 'a Reader proposes; the Editor verifies; the Writer reads, including the decided ones'
    },
    {
        artifact: 'plotlines',
        collection: 'plotlines',
        writer: 'write',
        editor: 'read',
        checker: 'read',
        reader: 'read',
        criterion_refs: ['L-7', 'D-2a', 'P7', 'D-3c'],
        note: 'write until `plotlines_locked`, then propose'
    },
    {
        artifact: 'chapters.content (agent-written)',
        collection: 'chapters',
        writer: 'write',
        editor: 'read',
        checker: 'read',
        reader: 'read',
        criterion_refs: ['L-19', 'D-37', 'P7'],
        // §12 W2: "an Editor's prose write is refused naming L-19".
        refusal_rules: { editor: 'L-19', checker: 'P10', reader: 'P10' },
        note: 'the Editor chooses drafts, it never writes prose (L-19)'
    },
    {
        artifact: 'chapters.content (Author-written span)',
        collection: 'chapters',
        writer: 'propose',
        editor: 'read',
        checker: 'read',
        reader: 'read',
        criterion_refs: ['P9', 'T-2', 'D-37a'],
        refusal_rules: { writer: 'P9' },
        note: 'tracked at section granularity (`sections[].origin === "author"`), so only that span is frozen'
    },
    {
        artifact: 'chapters.title/summary',
        collection: 'chapters',
        writer: 'write',
        editor: 'read',
        checker: 'read',
        reader: 'read',
        criterion_refs: ['P7', 'D-1']
    },
    {
        artifact: 'revisions',
        collection: 'revisions',
        writer: 'write',
        editor: 'write',
        checker: 'read',
        reader: 'read',
        criterion_refs: ['D-21', 'D-22', 'D-3d', 'L-16', 'L-17', 'L-18', 'L-20'],
        note: 'the Writer creates them through `editChapter`; only the Editor selects, merges or deletes'
    },
    {
        artifact: 'cast',
        collection: 'cast',
        writer: 'write',
        editor: 'read',
        checker: 'read',
        reader: 'read',
        criterion_refs: ['D-9', 'C-9']
    },
    {
        artifact: 'ledger',
        collection: 'ledger',
        writer: 'write',
        editor: 'read',
        checker: 'read',
        reader: 'read',
        criterion_refs: ['D-10', 'C-5', 'C-6', 'L-13'],
        note: 'ledger writes are what make C-5/C-6 mechanically checkable'
    },
    {
        artifact: 'digests',
        collection: 'digests',
        writer: 'read',
        editor: 'read',
        checker: 'read',
        reader: 'read',
        criterion_refs: ['D-12a', 'D-13', 'L-21'],
        // §8.4 registers `updateDigest` on every session and §7 refuses every kind: the refusal
        // names D-12a (the engine derives the Digest), not the generic P10, because the agent has
        // to be told WHICH rule it hit in order to route the work as a `digest_gap` finding (D-13).
        refusal_rules: { writer: 'D-12a', editor: 'D-12a', checker: 'D-12a', reader: 'D-12a' },
        // U-3a: the row cannot be satisfied by handing the job to another kind, so the fix names the
        // only call that works — the `digest_gap` FINDING the loop reads back as the signal to widen
        // the Digest (src/server/digest/digest.ts's `isExpanded`). It used to send the agent to
        // `createTask with kind "digest_gap"`, which is a call §8's createTask cannot make: it takes
        // no kind field, so following that advice used to produce a T-11 naming error, and D-13's
        // repair never happened.
        refusal_fix: 'raiseFinding with criterion_ref "digest_gap" and the reason the Digest is wrong (D-13)',
        note: "derived by the engine; a crew's only move is a `digest_gap` finding (D-13)"
    },
    {
        artifact: 'tasks',
        collection: 'tasks',
        writer: 'write',
        editor: 'write',
        checker: 'write',
        reader: 'write',
        criterion_refs: ['D-11', 'L-11', 'L-18'],
        note: 'the queue holds the plan, not the transcript; every kind may file the fix it sees'
    },
    {
        artifact: 'verdicts',
        collection: 'verdicts',
        writer: 'write',
        editor: 'write_verify',
        checker: 'write',
        reader: 'write',
        criterion_refs: ['D-3', 'D-15', 'D-28', 'P6'],
        note: 'a verdict is a report; only the engine advances a chapter on it'
    },
    {
        artifact: 'findings',
        collection: 'findings',
        writer: 'write',
        editor: 'write_verify',
        checker: 'write',
        reader: 'write',
        criterion_refs: ['D-16', 'D-33', 'D-34', 'D-35'],
        note: 'any kind may raise one; the Editor confirms, disputes or rewrites it; the Author approves'
    },
    {
        artifact: 'selection_notes',
        collection: 'revisions',
        writer: 'read',
        editor: 'write',
        checker: 'read',
        reader: 'read',
        criterion_refs: ['T-2a', 'L-17'],
        note: 'rides on `selectRevision`; the only window the Author has into automated taste'
    },
    {
        artifact: 'goals, criteria',
        collection: 'goals',
        writer: 'read',
        editor: 'read',
        checker: 'read',
        reader: 'read',
        criterion_refs: ['G-4', 'L-15', 'P15'],
        note: 'a checker cannot soften the bar it is measured against'
    },
    {
        artifact: 'stories.phase, stories.status, *.state',
        collection: 'stories',
        writer: 'read',
        editor: 'recommend',
        checker: 'read',
        reader: 'read',
        criterion_refs: ['D-1', 'D-2a', 'L-10'],
        note: 'the loop engine and the Author own the state machine; an agent may only recommend `done`'
    },
    {
        artifact: 'stories.summary_locked, stories.plotlines_locked, backtrack',
        collection: 'stories',
        writer: 'read',
        editor: 'read',
        checker: 'read',
        reader: 'read',
        criterion_refs: ['D-25', 'D-25a', 'L-29', 'L-30', 'L-31', 'L-32', 'L-33', 'L-34'],
        note: 'the Author, alone'
    },
    {
        artifact: 'templates, recipes',
        collection: 'templates',
        writer: 'read',
        editor: 'read',
        checker: 'read',
        reader: 'read',
        criterion_refs: ['D-17', 'D-17c', 'L-27']
    },
    {
        artifact: 'directives',
        collection: 'directives',
        writer: 'read',
        editor: 'read',
        checker: 'read',
        reader: 'read',
        criterion_refs: ['D-19', 'U-9'],
        note: 'the Author writes them; the crew reads them in its brief'
    },
    {
        artifact: 'proposals',
        collection: 'proposals',
        writer: 'write',
        editor: 'write',
        checker: 'write',
        reader: 'write',
        criterion_refs: ['P9', 'D-20', 'D-20a'],
        note: 'the agent→Author direction only; the Author accepts or rejects'
    },
    {
        artifact: 'sub_agent_runs',
        collection: 'runs',
        writer: 'recommend',
        editor: 'recommend',
        checker: 'recommend',
        reader: 'recommend',
        criterion_refs: ['D-17e', 'T-2b', 'D-38'],
        note: '`delegate` only: in-run reasoning the run layer answers, never a dispatched Work Item'
    },
    {
        artifact: 'runs',
        collection: 'runs',
        writer: 'read',
        editor: 'read',
        checker: 'read',
        reader: 'read',
        criterion_refs: ['D-18', 'S-1'],
        note: 'the run layer writes its own row; no tool edits a run'
    }
];

/** The four dispatched kinds, in §7's column order (less Author and Assistant). */
const ROLE_ORDER: RoleKind[] = ['writer', 'editor', 'checker', 'reader'];

/**
 * A `read` requirement is satisfied by anything above `none`: §7 states read access in prose
 * ("every kind may read everything except the `none` cells") rather than as a column.
 * `verify` is the Editor's fact-check right (D-31); `write_verify` is write-plus-verify.
 */
function satisfies(level: PermissionLevel, required: PermissionLevel): boolean {
    if (level === 'none') return false;
    if (required === 'read') return true;
    if (level === required) return true;
    if (required === 'write') return level === 'write_verify';
    if (required === 'verify') return level === 'write_verify';
    // `propose` sits BELOW `write` in the lattice: §7's propose cells exist so that a kind holding
    // a full `write` can always file the weaker thing. Without this, a §7 edit that made an
    // artifact propose-only would refuse the kind that could have written it outright.
    if (required === 'propose')
        return level === 'propose' || level === 'write' || level === 'verify' || level === 'write_verify';
    if (required === 'recommend') return level === 'write' || level === 'write_verify' || level === 'verify';
    return false;
}

/** Finds a §7 row by the collection its tools write. */
export function permissionRow(collection: string): PermissionRow | undefined {
    const wanted = collection.trim().toLowerCase();
    return PERMISSION_ROWS.find((row) => row.collection === wanted);
}

/** Every §7 row that names a collection, for `describeTool` (a tool may map to several). */
export function permissionRowsFor(collection: string): PermissionRow[] {
    const wanted = collection.trim().toLowerCase();
    return PERMISSION_ROWS.filter((row) => row.collection === wanted);
}

/** The §7 level a kind holds on a collection (the first row that names it wins). */
export function levelFor(role: RoleKind, collection: string): PermissionLevel {
    const row = permissionRow(collection);
    if (!row) return 'none';
    return row[role];
}

/** Pure permission decision, so a reviewer can diff the table against §7 line by line. */
export function checkPermission(
    role: RoleKind,
    collection: string,
    required: PermissionLevel
): { allowed: boolean; level: PermissionLevel; row?: PermissionRow } {
    const row = permissionRow(collection);
    const level = row ? row[role] : 'none';
    return { allowed: row ? satisfies(level, required) : false, level, row };
}

/**
 * T-6c: whether one role kind may call one tool, computed by the SAME §7 decision the pipeline
 * makes (`listTools` and `describeTool` answer the question from inside the run, so it must not
 * have a second, drift-prone copy of the rule). `kinds` is honoured here exactly as
 * {@link assertPermission} honours it, so the catalogue never advertises a tool the call would
 * then be refused for.
 */
export function mayCallKind(
    role: RoleKind,
    def: Pick<ToolDefinition, 'writes' | 'level' | 'kinds' | 'onlyKinds'>
): boolean {
    // §8 names one role for a few tools whose §7 row is deliberately broader (the Writer holds
    // `write` on revisions because it creates them); `onlyKinds` is that narrowing.
    if (def.onlyKinds && !def.onlyKinds.includes(role)) return false;
    const decision = checkPermission(role, def.writes, def.level);
    return decision.allowed || (def.kinds?.includes(role) ?? false);
}

/**
 * Builds the permission refusal. §12 W2 names three of these by rule id, so the row carries
 * the id to use; the default is P10 ("the server enforces the row"). The message names the
 * artifact, the kind's actual level, and the kind that holds the right — the only thing an
 * agent can act on (T-1a).
 */
export function permissionRefusal(
    ctx: Pick<ToolExecutionContext, 'role' | 'storyId'>,
    def: Pick<ToolDefinition, 'name' | 'writes' | 'level'>,
    level: PermissionLevel,
    row?: PermissionRow
): ToolRefusal {
    const rule = row?.refusal_rules?.[ctx.role] ?? 'P10';
    const owner = row ? ROLE_ORDER.find((role) => satisfies(row[role], def.level)) : undefined;
    const holder = owner ? rolePhrase(owner) : 'the Author, in the dashboard';
    const artifact = row?.artifact ?? def.writes;
    // T-1a: the message names the artifact, the kind's actual level, and who holds the right.
    // A row whose level nobody holds (`digests`) supplies its own `refusal_fix`, because "hand it
    // to another kind" would be advice into a second refusal.
    return new ToolRefusal(
        rule,
        `${rolePhrase(ctx.role)} may not ${def.name} on ${artifact}: §7 gives ${rolePhrase(ctx.role)} "${level}" there. Route the job to ${holder}`,
        {
            story_id: ctx.storyId,
            artifact,
            role: ctx.role,
            level,
            required: def.level,
            ...(row ? { criterion_refs: row.criterion_refs } : {}),
            fix: row?.refusal_fix
                ? row.refusal_fix
                : owner
                  ? `hand this to ${rolePhrase(owner)}, or file a task and let the loop route it`
                  : 'this is an Author-only edit'
        }
    );
}

/**
 * Enforces the matrix for one call, then the story-level guards §7 cannot express as a level.
 * Returns null when the call may proceed, or the refusal result the pipeline should return.
 */
export function assertPermission(ctx: ToolExecutionContext, def: ToolDefinition): ToolResult | null {
    const decision = checkPermission(ctx.role, def.writes, def.level);
    // `kinds` is the narrow, spelled-out grant for the few tools §8 hands to a role the row
    // alone would not reach, and `onlyKinds` is the narrowing for the few tools §8 assigns to
    // one role; both are decided by the same predicate `listTools` reports, so the answer an
    // agent reads and the answer the call gets cannot drift (T-6c).
    if (!mayCallKind(ctx.role, def))
        // The row decides, and the refusal is rendered as a result here: the pipeline returns this
        // value verbatim, and a thrown refusal would have skipped the P8/D-2a guards below.
        return toFailureResult(permissionRefusal(ctx, def, decision.level, decision.row));

    // P8: the Author pulled the cord. Reads still work (the crew panel stays readable).
    if (def.mutating && isStopped(ctx.story)) {
        return refusalResult(
            'P8',
            `the Story is stopped (${ctx.story.status_reason ?? 'the Author paused it'}), so nothing may be written`,
            {
                story_id: ctx.storyId,
                status: ctx.story.status,
                author_stop: ctx.story.author_stop,
                fix: 'the Author resumes it; D-37 makes a prose edit a Pause & edit, not a tool write'
            }
        );
    }

    // D-2a: a completed Story is a dead end on purpose (D-39).
    if (def.mutating && isCompleted(ctx.story)) {
        return refusalResult('D-2a', 'the Story is completed, so its records are read-only', {
            story_id: ctx.storyId,
            status: ctx.story.status,
            fix: 'reads are open; the Author reopens the Story before anything else is written'
        });
    }

    return null;
}

/**
 * P5 + T-3c: the Summary is writable in phase `summary` while `summary_locked` is false, and
 * by nobody at any other time. W1's acceptance names the same gate, so the tool layer and the
 * store must refuse for the same reason (D-3).
 */
export function guardSummaryWritable(ctx: ToolExecutionContext, def: Pick<ToolDefinition, 'name'>): ToolRefusal | null {
    if (ctx.story.summary_locked) {
        return new ToolRefusal(
            'P5',
            'the Summary is locked (`summary_locked` is true), so it is read-only for every agent',
            {
                story_id: ctx.storyId,
                artifact: 'summaries',
                field: 'summary_locked',
                fix: 'a Writer that wants the Summary changed files a finding; the Author decides whether it is worth a backtrack (D-25)'
            }
        );
    }
    if (ctx.story.phase !== 'summary') {
        return new ToolRefusal(
            'T-3c',
            `the Story is in phase \`${ctx.story.phase}\`, and \`editSummary\` is the Writer's only write during phase \`summary\` (D-3)`,
            {
                story_id: ctx.storyId,
                phase: ctx.story.phase,
                artifact: 'summaries',
                fix: 'work the current phase, or file a finding if the Summary itself is wrong'
            }
        );
    }
    return null;
}

/**
 * L-7: a locked plotline (`plotlines_locked` or its `contract_locked` mirror) is read-only for
 * agents, so the write arrives as a §4.16 proposal instead. Returns whether to divert.
 */
export function guardPlotlineWritable(
    ctx: ToolExecutionContext,
    contractLocked: boolean
): ToolRefusal | 'propose' | null {
    if (ctx.story.plotlines_locked || contractLocked) return 'propose';
    return null;
}

/**
 * P9/T-2: an Author-written section may not be rewritten by an agent — it is propose-only.
 * `sectionIds` are the sections the write would replace.
 */
export function guardAuthorSpans(
    ctx: ToolExecutionContext,
    authorSectionIds: string[],
    touchedSectionIds: string[],
    targetRef: string
): ToolRefusal | 'propose' | null {
    if (ctx.role === 'checker' || ctx.role === 'reader') return null;
    const authorSet = new Set(authorSectionIds);
    const hit = touchedSectionIds.find((id) => authorSet.has(id));
    if (!hit) return null;
    // A Writer may still PROPOSE against its own chapter's Author span (P9); the Editor and
    // the report kinds have no write there at all, so they are refused (D-37a).
    if (ctx.role === 'writer') return 'propose';
    return new ToolRefusal(
        'P9',
        `section ${hit} of ${targetRef} was written by the Author, so ${rolePhrase(ctx.role)} may only propose against it`,
        { story_id: ctx.storyId, ref: targetRef, section_id: hit, fix: 'proposeChange with target_field "sections"' }
    );
}

/**
 * D-1: no agent tool may move a state field. A tool that patches one is refused rather than
 * silently allowed to smuggle a phase change through a content write.
 */
export function guardStateWrite(
    ctx: ToolExecutionContext,
    next: string | undefined,
    current: string,
    field = 'state'
): ToolRefusal | null {
    if (!next || next === current) return null;
    return new ToolRefusal(
        'D-1',
        `${rolePhrase(ctx.role)} may not change \`${field}\` from "${current}" to "${next}": the loop engine and the Author own the state machine`,
        {
            story_id: ctx.storyId,
            field,
            from: current,
            to: next,
            fix: 'file a task or a verdict and let the loop move the state'
        }
    );
}

/**
 * T-4's shape guard: a tool whose §8 row lists `expects` must receive it, or the write would
 * be unguarded. Reads and report tools are exempt because they create rows rather than
 * read-modify-writing one.
 */
export function guardExpects(ctx: ToolExecutionContext, expects: CAS[]): ToolRefusal | null {
    if (!ctx.tool.expectsArg) return null;
    if (expects.length > 0 && expects.every((entry) => entry.id && Number.isInteger(entry.rev))) return null;
    return new ToolRefusal(
        'T-4',
        `${ctx.tool.name} is a read-modify-write call, so it needs expects: [{id, rev}] taken from the read that produced the record`,
        {
            story_id: ctx.storyId,
            field: 'expects',
            fix: 're-read the record, then re-send with its id and rev'
        }
    );
}
