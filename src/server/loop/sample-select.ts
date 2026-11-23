// Phase ①'s deterministic sample selector (documents/phase-1-research-pipeline.md §6.5).
//
// WHY THIS IS A MODULE AND NOT A FEW LINES IN THE ENGINE: the rule is the design's answer to "which
// sample becomes the First Revision?", and it has to be inspectable on its own — the engine's
// selection commit is a page of record writes, and burying the ranking in it would make the one
// decision the Author needs to trust (P6: no quality score, no model) the hardest thing to read.
//
// THERE IS NO QUALITY SCORE, BY DESIGN. The ranking is a pure lexicographic comparison of counts a
// deterministic screening Reader already produced:
//
//     fewest `critical`  →  fewest `high`  →  fewest total  →  the earliest sample
//
// Any tie-break beyond that would be a taste judgement the loop is not allowed to make (P6: the
// selector chooses, the Author judges). The last rule is the SAMPLE ORDER — the caller hands the
// samples in creation order (`records.ts:roundRevisions` sorts oldest first), which is §6.5's "the
// earliest sample".
import type { Revision } from '../../shared/types';

/** One sample, ready to rank: the draft plus the counts its `sample_reviews` produced. */
export interface ScoredSample {
    revision: Revision;
    /** Issues whose severity is `critical`, across every screening review of this revision. */
    critical: number;
    /** Issues whose severity is `high`, across every screening review of this revision. */
    high: number;
    /** Every issue, both severities — the third key, so two samples with the same split differ. */
    total: number;
}

/**
 * The creation index behind a `revision_N` id, or -1 when the id is not shaped that way.
 *
 * Ids are minted from ONE per-collection counter, so their numeric part IS creation order — but a
 * plain string compare puts `revision_10` before `revision_9`. The tie-break needs creation order
 * (§6.5's "earliest sample"), so the numeric suffix is what it reads.
 */
const revisionIndex = (revision: Revision): number => {
    const match = /^revision_(\d+)$/.exec(revision.id);

    return match === null ? -1 : Number(match[1]);
};

/**
 * Fewest `critical` → fewest `high` → fewest total → lowest revision id (creation order).
 *
 * Returns `undefined` for an empty list: a round with no drafted sample has nothing to select, and
 * the caller must treat that as "not yet" rather than inventing a winner (§6.5's last paragraph).
 *
 * The input array is not mutated: the selection commit writes rows, so a helper that reorders its
 * caller's array would make the audit line's sample order depend on the ranking.
 */
export function selectSample(samples: ScoredSample[]): ScoredSample | undefined {
    if (samples.length === 0) return undefined;

    const ranked = [...samples].sort(
        (left, right) =>
            left.critical - right.critical ||
            left.high - right.high ||
            left.total - right.total ||
            revisionIndex(left.revision) - revisionIndex(right.revision) ||
            left.revision.id.localeCompare(right.revision.id)
    );

    return ranked[0];
}
