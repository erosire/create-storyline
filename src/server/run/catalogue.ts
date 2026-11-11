// The tool-name registry the run layer needs — and the three questions it answers are all
// spec questions, not implementation preferences:
//
//   S-4   which calls make a run "not a no-op"?           → isReportTool
//   D-38  which calls may a panel agent make as PROPOSALS → isMutatingTool
//   D-38  when do two agents "want the same thing"?        → proposalKey
//
// WHY NAMES AND NOT SCHEMA INTROSPECTION: T-6a registers the same catalogue on every session
// and T3 owns the schemas, so this layer classifies by NAME only. The classification is
// deliberately prefix-based for reads (T-3b grows the catalogue over time, and a new `readX`
// must not silently become a proposal inside a panel) and explicit for the report set, because
// S-4's list is a closed normative list that loop detection depends on.
//
// (The one place a RESULT is inspected — "was this call intercepted?" — lives in
// `isProposedResult`, next to the result type itself, in ./types.)

/**
 * S-4's report surface, in the order S-4 names it. S-4's sentence lists eight tools; the §9
 * lifecycle diagram adds `rejectAll` (and L-18 makes rejecting everything a first-class
 * outcome, not a silence), and the delegation contract this build was given adds
 * `verifyFinding` to the list — so the set is the union, and a run that did any of these is
 * not a no-op. The union is stated rather than silently widened: a report tool the loop does
 * not count is a run that "did work" the loop will re-dispatch.
 */
export const REPORT_TOOLS = [
    'submitVerdict',
    'raiseFinding',
    'createTask',
    'requestAuthor',
    'proposeIdea',
    'verifyIdea',
    'verifyFinding',
    'selectRevision',
    'requestMerge',
    'rejectAll'
] as const;

/** Reads and lookups: these execute for real everywhere, including inside a panel agent (D-38). */
const READ_TOOLS = [
    'readSeed',
    'readSummary',
    'readIdeas',
    'readPlotline',
    'readChapter',
    'readCast',
    'readLedger',
    'readDigest',
    'readGoals',
    'readVerdicts',
    'readFindings',
    'listTasks',
    'listTools',
    'listIdeas',
    'listRevisions',
    'describeTool',
    'compareRevisions',
    'searchWeb',
    'fetchPage'
] as const;

/** Name prefixes that identify a read (T-7/T-8 reads are the only tools that never write). */
const READ_NAME_PREFIXES = ['read', 'list', 'describe', 'compare', 'search', 'fetch'] as const;

/**
 * `delegate` is neither a read nor a write: the run layer answers it with an inner agent loop
 * (D-17e) and the sub-context's own calls are what touch the store — so it must never be
 * classified as a mutating proposal inside a panel.
 */
export const DELEGATE_TOOL = 'delegate';

/** A call that touches nothing in the store (T-3b's catalogue grows; prefixes keep it correct). */
export const isReadOnlyTool = (name: string): boolean =>
    name === DELEGATE_TOOL ||
    (READ_TOOLS as readonly string[]).includes(name) ||
    READ_NAME_PREFIXES.some((prefix) => name.startsWith(prefix));

/** D-38: everything else is a write — inside a panel agent it becomes a proposal. */
export const isMutatingTool = (name: string): boolean => name !== DELEGATE_TOOL && !isReadOnlyTool(name);

/** S-4: did this call report? A run that never called one of these is a no-op turn. */
export const isReportTool = (name: string): boolean => (REPORT_TOOLS as readonly string[]).includes(name);

/** §8.5's two web tools — the only ones that reach outside the book (§7's last column). */
export const RUN_WEB_TOOLS = ['searchWeb', 'fetchPage'] as const;

/** The name inside a declared schema — the OpenAI envelope this build's runtime declares with (§T-6). */
const schemaName = (schema: { function?: { name?: string } }): string => schema.function?.name ?? '';

/**
 * U-1e: the tools a run of this Work Item kind may be OFFERED (§7's table).
 *
 * An `assistant` run (§8.6) has no web row in §7 — the Author's ask is about the book, not about the
 * internet — so its session must not carry `searchWeb`/`fetchPage`, even on a model that would
 * advertise them. The tool layer's §7 permission row remains what refuses a call (T-1a: the call
 * exists and the refusal is the record); this is the "do not offer what you will refuse" half, and it
 * is what makes §7's empty cell real for a model rather than a promise.
 *
 * Every other kind gets the catalogue exactly as the runtime declares it (T-6a). Filtering the
 * DECLARED list rather than the registry is also what keeps T-6a intact: nothing is hidden from a
 * dispatched run, and `listTools` still answers from the registry.
 */
export const toolsForRunKind = <T extends { function?: { name?: string } }>(schemas: T[], kind: string): T[] =>
    kind === 'assistant'
        ? schemas.filter((schema) => !(RUN_WEB_TOOLS as readonly string[]).includes(schemaName(schema)))
        : schemas;

/**
 * The arguments that say WHICH decision a proposal is making. Two agents "agree" when their
 * primary action names the same target and verdict, so everything else in the payload
 * (their prose, their `why`) is excluded: D-38 counts decisions, not wording.
 *
 * `expects` and `why` are excluded EVERYWHERE (see {@link normalizeArgs}) — two agents that
 * want the identical change but read the record at different revs are the same preference,
 * and treating a rev difference as a disagreement would make every panel split by accident.
 */
const PRIMARY_ACTION_ARGS: Record<string, string[]> = {
    selectRevision: ['revision_id'],
    requestMerge: ['unit_ref'],
    rejectAll: ['unit_ref'],
    verifyFinding: ['finding_id', 'verdict'],
    verifyIdea: ['idea_id', 'verdict'],
    markUnverifiable: ['idea_id'],
    approveFinding: ['finding_id', 'decision'],
    raiseFinding: ['criterion_ref', 'target_ref'],
    createTask: ['title'],
    submitVerdict: ['target_ref', 'recommendation'],
    proposeIdea: ['kind', 'unit_ref'],
    editSummary: ['__summary__'],
    editChapter: ['chapter_id'],
    editPlotline: ['plotline_id'],
    createChapter: ['plotline_id'],
    deleteChapter: ['chapter_id'],
    editTask: ['task_id'],
    markChapterDone: ['chapter_id']
};

/** Strips the volatile fields so two identical intentions hash identically (see the note above). */
const normalizeArgs = (args: Record<string, unknown>): string => {
    const stable: Record<string, unknown> = {};

    for (const key of Object.keys(args).sort()) {
        if (key === 'expects' || key === 'why') continue;

        stable[key] = args[key];
    }

    return JSON.stringify(stable);
};

/**
 * The grouping key for "the same primary mutating action" (D-38). Falls back to the whole
 * (stabilised) payload for a tool this layer does not know, so an unknown write still groups
 * correctly when two agents make the same call.
 */
export const proposalKey = (tool: string, args: Record<string, unknown>): string => {
    const keys = PRIMARY_ACTION_ARGS[tool];

    if (keys === undefined) return `${tool}|${normalizeArgs(args)}`;

    // `__summary__` is a sentinel: `editSummary` has no id argument (the record is the Story's
    // one Summary), so its key is the tool plus its content.
    if (keys.length === 1 && keys[0] === '__summary__') return `${tool}|${normalizeArgs(args)}`;

    const picked: Record<string, unknown> = {};

    for (const key of keys) if (args[key] !== undefined) picked[key] = args[key];

    return `${tool}|${JSON.stringify(picked)}`;
};

/**
 * A short human label for a proposal, used in the dissent line D-38 demands
 * ("2 of 3 preferred draft 1; selected 2 on the must_happen rule"). Falls back to the tool
 * name plus its primary args so an unknown tool is still nameable in the note.
 */
export const describeProposal = (tool: string, args: Record<string, unknown>): string => {
    switch (tool) {
        case 'selectRevision':
            return String(args.revision_id ?? args.unit_ref ?? 'a revision');
        case 'requestMerge':
            return `merge of ${String(args.unit_ref ?? 'the unit')}`;
        case 'rejectAll':
            return 'rejecting every draft';
        case 'verifyFinding':
            return `${String(args.finding_id ?? 'the finding')} as ${String(args.verdict ?? '?')}`;
        case 'verifyIdea':
            return `${String(args.idea_id ?? 'the idea')} as ${String(args.verdict ?? '?')}`;
        case 'submitVerdict':
            return `a verdict of ${String(args.recommendation ?? '?')}`;
        case 'raiseFinding':
            return `a finding on ${String(args.criterion_ref ?? args.target_ref ?? 'the artifact')}`;
        case 'createTask':
            return `a task "${String(args.title ?? '')}"`;
        case 'proposeIdea':
            return `a ${String(args.kind ?? 'direction')} idea`;
        default:
            return `${tool} ${normalizeArgs(args)}`.trim();
    }
};

/** The tool whose call expresses an agent's final position (used for the D-38 majority count). */
export const isPrimaryAction = (tool: string): boolean => (REPORT_TOOLS as readonly string[]).includes(tool);

/**
 * An agent's primary action = its LAST report call, else its last mutating call. The last
 * report is the answer it chose to give the loop; a checker that filed a finding and then
 * submitted its verdict is reporting the verdict, and counting both would double-weight it.
 */
export const primaryActionOf = (
    proposals: { tool: string; args: Record<string, unknown> }[]
): { tool: string; args: Record<string, unknown> } | undefined => {
    const reports = proposals.filter((proposal) => isPrimaryAction(proposal.tool));

    // `slice(-1)[0]` rather than `.at(-1)`: the package's tsconfig lib is pre-ES2022, and a
    // runtime method the type checker does not know is a build break, not a style choice.
    return reports[reports.length - 1] ?? proposals[proposals.length - 1];
};

/** D-38's note-surgery targets: where the dissent text rides on each kind of winning call. */
export const dissentFieldFor = (tool: string): 'selection_note' | 'detail' | undefined => {
    if (tool === 'selectRevision') return 'selection_note';

    // D-38 names the finding's `detail` as the other surface; `raiseFinding` is included
    // because a checker panel's disagreement belongs in the finding it files.
    if (tool === 'verifyFinding' || tool === 'raiseFinding') return 'detail';

    return undefined;
};
