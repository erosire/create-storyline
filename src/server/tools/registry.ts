/**
 * The §8 catalogue as one flat list (T-6a).
 *
 * §8 groups the tools by who asks for them — §8.1 Writer, §8.2 Editor, §8.3 checker, §8.4 shared,
 * §8.5 research — and the grouping is documentation about the BRIEF, not about registration:
 * T-6a says every session gets §8.1 + §8.2 + §8.3 + §8.4 + §8.5, and "kind selects the brief and
 * the permission row, not the tool list". So this module flattens the five groups into the one
 * list every session holds, and nothing else may decide what a session can see.
 *
 * Two invariants are checked when this module loads, because both are silent failures otherwise:
 *  - a name registered twice would shadow a §8 row (the second definition never runs);
 *  - a tool naming a collection with no §7 row would be refused `none` for every kind, which
 *    looks like a permission bug at runtime and is a transcription bug here.
 */
import { PERMISSION_ROWS } from './permissions';
import { checkerTools } from './checker';
import { editorTools } from './editor';
import { plumbingTools } from './plumbing';
import { researchTools } from './research';
import { writerTools } from './writer';
import type { ToolDefinition } from './types';

/** §8's five groups, in §8's order, kept separate so a reviewer can diff them against the spec. */
export const TOOL_GROUPS: Record<'writer' | 'editor' | 'checker' | 'plumbing' | 'research', ToolDefinition[]> = {
    writer: writerTools,
    editor: editorTools,
    checker: checkerTools,
    plumbing: plumbingTools,
    research: researchTools
};

/** Which group a tool came from, for `describeTool` and for the §8 conformance test. */
export const GROUP_OF_TOOL: ReadonlyMap<string, string> = new Map(
    Object.entries(TOOL_GROUPS).flatMap(([group, tools]) => tools.map((tool) => [tool.name, group] as [string, string]))
);

/**
 * Flattens the groups and refuses a duplicate name. A `throw` at module load is deliberate: a
 * duplicate is a transcription mistake against §8, and the run must not start with a silently
 * smaller catalogue than the spec registers (T-6a).
 */
function flatten(): ToolDefinition[] {
    const seen = new Map<string, ToolDefinition>();
    for (const tools of Object.values(TOOL_GROUPS)) {
        for (const tool of tools) {
            const clash = seen.get(tool.name);
            if (clash)
                throw new Error(
                    `duplicate tool "${tool.name}" registered by two §8 groups; the catalogue would silently lose one of them (T-6a)`
                );
            seen.set(tool.name, tool);
        }
    }
    return [...seen.values()];
}

/** The whole §8 surface, registered on every session whatever the role kind (T-6a). */
export const ALL_TOOLS: readonly ToolDefinition[] = flatten();

/** name → definition, so `execute` and `describeTool` never scan the list. */
export const TOOL_BY_NAME: ReadonlyMap<string, ToolDefinition> = new Map(ALL_TOOLS.map((tool) => [tool.name, tool]));

/** Every registered name, in registration order (the order §8 lists them, which the agent reads). */
export const TOOL_NAMES: readonly string[] = ALL_TOOLS.map((tool) => tool.name);

/**
 * The collections §7 gives a level to. A tool that writes a collection outside this set would be
 * refused for every kind by {@link checkPermission}, so the omission is caught here rather than
 * discovered as a mysterious P10 in a live run.
 */
export const GOVERNED_COLLECTIONS: readonly string[] = [...new Set(PERMISSION_ROWS.map((row) => row.collection))];

/**
 * The names §8.1–§8.5 register, as a set, for the conformance test that pins the catalogue
 * against the spec (T-6c: "what a role can reach is answerable from inside the run").
 */
export const SPEC_TOOL_NAMES: readonly string[] = [
    // §8.1 — the Writer surface
    'editSummary',
    'createPlotline',
    'editPlotline',
    'createChapter',
    'editChapter',
    'deleteChapter',
    'updateDigest',
    'proposeChange',
    // §8.2 — the Editor surface
    'listRevisions',
    'selectRevision',
    'requestMerge',
    'rejectAll',
    'compareRevisions',
    'verifyIdea',
    'verifyFinding',
    'approveFinding',
    'listIdeas',
    'delegate',
    // §8.3 — the checker surface
    'submitVerdict',
    'raiseFinding',
    'createTask',
    'editTask',
    'requestAuthor',
    'markChapterDone',
    // §8.4 — shared plumbing
    'readSeed',
    'readSummary',
    'readIdeas',
    'readPlotline',
    'readChapter',
    'readCast',
    'editCast',
    'readLedger',
    'editLedger',
    'readDigest',
    'readGoals',
    'listTasks',
    'readVerdicts',
    'readFindings',
    'listTools',
    'describeTool',
    'reportGap',
    // §8.5 — research and proposal
    'searchWeb',
    'fetchPage',
    'proposeIdea',
    'markUnverifiable'
];
