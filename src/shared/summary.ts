// Phase ①'s Summary completeness rule, in one place.
//
// A Writer's draft reaches the Critics only when every prose block of §4.2 is present: a draft
// that names a premise but not its tone cannot be read as the Overview the whole chain is judged
// against. The tool layer uses this to say what a partial draft is missing, the loop uses it to
// decide whether a closed Writer run leaves a `pending` draft or promotes it to `drafted`, and the
// Writer re-work is told exactly which blocks to add.
import type { Revision } from './types';

/** §4.2's prose blocks, in the order the Writer writes and the pane renders them. */
export const SUMMARY_PROSE_FIELDS = ['premise', 'promise', 'theme', 'tone', 'ending', 'world_rules'] as const;

export type SummaryProseField = (typeof SUMMARY_PROSE_FIELDS)[number];

/**
 * The structure a Seed has to carry before it can be expanded into §4.2's six Summary blocks.
 * Phase ①'s first Editor pass checks these areas (and asks the Author for the missing ones) so
 * the Writers expand a structured Seed rather than inventing the missing story.
 */
export const SEED_STRUCTURE_AREAS = [
    'protagonist',
    'want',
    'obstacle',
    'stakes',
    'world',
    'change'
] as const;

export type SeedStructureArea = (typeof SEED_STRUCTURE_AREAS)[number];

/** The prose blocks one field set still lacks — empty means the draft is complete. */
export function missingSummaryBlocks(fields: Record<string, unknown>): SummaryProseField[] {
    return SUMMARY_PROSE_FIELDS.filter((field) => {
        const value = fields[field];

        return typeof value !== 'string' || value.trim().length === 0;
    });
}

/** True when every Summary block is present and non-blank. */
export function summaryBlocksComplete(fields: Record<string, unknown>): boolean {
    return missingSummaryBlocks(fields).length === 0;
}

/**
 * The prose fields a draft's §4.15 `body` carries. A Summary draft is stored as `{fields: {...}}`
 * (`tools/artifacts.ts:fileRevision`); the bare object shape is accepted because §4.15 leaves
 * `body` open and an older draft may have left it behind.
 */
export function summaryDraftFields(body: unknown): Record<string, unknown> {
    const record = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : undefined;
    const fields = record?.fields;

    if (fields !== null && typeof fields === 'object' && !Array.isArray(fields)) {
        return fields as Record<string, unknown>;
    }

    return record ?? {};
}

/** One draft's missing Summary blocks (empty for a complete draft). */
export function missingSummaryBlocksOf(revision: Pick<Revision, 'body'>): SummaryProseField[] {
    return missingSummaryBlocks(summaryDraftFields(revision.body));
}
