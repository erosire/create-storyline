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
//
// ---------------------------------------------------------------------------
// H1 — the selection is now a HILL, not a draft of the least-bad text
// ---------------------------------------------------------------------------
// Ranking alone kept choosing the best of whatever a round happened to produce, and the selection
// commit then closed the round's fix tasks because a selection had happened (the old §6.8 write).
// That is a ratchet going backwards: a rewrite that discarded the draft could "fix" a defect by
// forgetting it, close the task, and start the next round from a worse book.
//
// `scoreSample` therefore computes a second, non-negotiable axis BEFORE the ranking:
//
//     eligible  ==  zero `critical` AND zero `high` screening issues
//                   AND every STILL-OPEN fix task this candidate's screens were handed is marked
//                       `resolved`, with evidence, by EVERY pass that was asked about it
//
// `selectSample` then ranks the ELIGIBLE set (see `requiresFixCertification`): a round that demanded
// fixes selects only from candidates that cleared them, so round N+1 is never worse than round N.
// Minors never appear here — the screening schema closes severity at critical/high (T-11), and the
// Summary-phase prompts cost wording and sentence-shape notes as minor/taste (R6), so a rephrasing
// preference cannot hold a round.
//
// A round with NOTHING to certify keeps §6.5's least-bad path: round 1, or a refinement whose fix
// tasks the Author has settled (H1-C1/F1 — a discarded task is no longer an outstanding promise), or a
// stored round whose screening rows predate the certificate AND owe nothing. What it does NOT cover is
// a round that OWES fixes and cannot prove them (H1-C1/F2): an ungradeable candidate is ineligible
// there, because "nobody checked" is not a clean certificate.
import type { Revision, SampledFixVerification, SampledIssue, SampleReview } from '../../shared/types';

/** One sample, ready to rank: the draft plus the counts its `sample_reviews` produced. */
export interface ScoredSample {
    revision: Revision;
    /** Issues whose severity is `critical`, across every screening review of this revision. */
    critical: number;
    /** Issues whose severity is `high`, across every screening review of this revision. */
    high: number;
    /** Every issue, both severities — the third key, so two samples with the same split differ. */
    total: number;
    /**
     * The STILL-OPEN fix task ids this round demanded of this candidate, in ascending id order
     * (`records.ts:sampleFixDemand` intersects every branch of the demand with the open fix tasks —
     * H1-C1/F1). Empty when the round carried no fixes (round 1), or when everything it carried has
     * since been settled by the Author — and then `fixesUnresolved` is empty by construction.
     */
    fixRefs: string[];
    /** Fix ids EVERY screening pass that was asked about them marked `resolved` with evidence. */
    fixesCleared: string[];
    /** `fixRefs` minus `fixesCleared` — the set that keeps this candidate off the round (R3/R5). */
    fixesUnresolved: string[];
    /**
     * True when this candidate may be selected at all: no blocking screening issue AND every demanded
     * fix cleared. This is the gate `trySelectSample` filters on before ranking.
     *
     * The exemption is ONLY "nothing demanded" (H1-C1/F2). A row that can carry no verdict at all —
     * see `legacyScreening`, or a screening leg whose attempts all failed schema validation — certifies
     * nothing, so in a round that owes fixes it cannot be eligible and cannot replace the incumbent.
     */
    eligible: boolean;
    /**
     * True when no screening review of this candidate can hold a certificate at all — neither a
     * declared `fix_refs` list nor a `fix_verifications` verdict on any row: the reviews were written
     * before fix verification existed, or every screening attempt failed.
     *
     * This is a REPORT, not an exemption (H1-C1/F2). It tells the reader of the score why
     * `fixesCleared` is empty for a candidate that had fixes to answer, and it is what the engine's
     * closure gate reads (`engine.ts:trySelectSample` closes only `fixesCleared`, never an ungradeable
     * round's tasks). A round that demands nothing stays eligible; a round that demands something and
     * has nothing to grade with is not.
     */
    legacyScreening: boolean;
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

/** Ascending id order, de-duplicated — the order `fixRefs`/`fixesUnresolved` are stored in. */
const sortedIds = (ids: Iterable<string>): string[] =>
    [...new Set([...ids].filter((id) => id.trim().length > 0))].sort((left, right) => left.localeCompare(right));

/**
 * Was THIS pass handed THIS fix — i.e. does it owe a verdict about it?
 *
 * Two ways to be handed one, and both count:
 *   * the screening job's frozen list (`review.fix_refs`, written by `engine.ts:settleJob` from
 *     `WorkItem.fixRefs`) names it — the normal case;
 *   * the pass ANSWERED about it (`fix_verifications[].fix_ref`). `IssueListSchema` keeps the
 *     per-report `fix_refs` optional so pre-H1 rows parse, so a verdict is the only trace a reviewer
 *     that echoed ids per verdict leaves behind — and a pass that claims to have checked a fix is
 *     certainly a pass that can be graded on it.
 *
 * A pass that carries neither is silent because it was never asked (a task confirmed mid-round, after
 * this Reader was dispatched), so it cannot veto the certificate.
 */
const carryingFix = (review: SampleReview, fixRef: string): boolean =>
    (review.fix_refs ?? []).includes(fixRef) ||
    (review.fix_verifications ?? []).some((verification: SampledFixVerification) => verification.fix_ref === fixRef);

/**
 * Did THIS pass certify THIS fix?
 *
 * Three things must all hold, and each one removes a way a fix could "close" without being done:
 *   * the verdict names the fix and says `resolved` — `unknown` is the Reader admitting it cannot
 *     tell, which is not a pass (R2);
 *   * it carries a non-empty `evidence` line (D-15: an unevidenced verdict is not a verdict);
 *   * the review itself is `valid` — a schema-repair failure persisted an answer nobody read, so it
 *     can disqualify a candidate (the counts still count it) but it cannot certify a fix.
 */
const certifiesFix = (review: SampleReview, fixRef: string): boolean =>
    review.valid === true &&
    (review.fix_verifications ?? []).some(
        (verification: SampledFixVerification) =>
            verification.fix_ref === fixRef &&
            verification.status === 'resolved' &&
            // The `typeof` guard is for a row read back off disk: the schema enforces the string on
            // the way in, but a persisted row predating the field must not certify anything.
            typeof verification.evidence === 'string' &&
            verification.evidence.trim().length > 0
    );

/**
 * One candidate's score: the §6.5 counts plus the H1 fix certificate.
 *
 * `reviews` is the draft's screening set (`records.ts:screensFor`, oldest first) and `fixRefs` is the
 * list the round demanded; when the caller names none, the demand is what the passes were handed
 * (their `fix_refs`, or the ids their verdicts echo). The caller passes the list because the ENGINE
 * knows what the prompt carried even when every screening attempt failed and no row declares one.
 *
 * The unanimity rule is deliberate: with `summary_readers` = 5, five independent Readers were bought,
 * and one Reader marking the fix `unresolved` is a live disagreement the loop must resolve by
 * resampling, not by averaging (P6: pass/fail, never a score).
 */
export function scoreSample(input: { revision: Revision; reviews: SampleReview[]; fixRefs?: string[] }): ScoredSample {
    const { revision, reviews } = input;
    const issues = reviews.reduce((all, review) => all.concat(review.issues), [] as SampledIssue[]);

    // Only rows that carry a fix list OR a verdict can take part in a certificate. `fix_refs: []` (a
    // round-1 screen) is a declaration; an absent property on both fields is a row from before the
    // fields existed, which grades on issues alone.
    const certifiable = reviews.filter(
        (review) => Array.isArray(review.fix_refs) || Array.isArray(review.fix_verifications)
    );
    const demanded = sortedIds(
        input.fixRefs ??
            certifiable.flatMap((review) => [
                ...(review.fix_refs ?? []),
                ...(review.fix_verifications ?? []).map((verification) => verification.fix_ref)
            ])
    );
    const fixesCleared = demanded.filter((fixRef) => {
        // The passes that were actually handed this fix. A pass screened from an earlier fix list is
        // not silent about a question it was never asked.
        const asked = certifiable.filter((review) => carryingFix(review, fixRef));

        return asked.length > 0 && asked.every((review) => certifiesFix(review, fixRef));
    });

    const critical = issues.filter((issue) => issue.severity === 'critical').length;
    const high = issues.filter((issue) => issue.severity === 'high').length;

    return {
        revision,
        critical,
        high,
        total: issues.length,
        fixRefs: demanded,
        fixesCleared,
        fixesUnresolved: demanded.filter((fixRef) => !fixesCleared.includes(fixRef)),
        // H1-C1/F2 — the ONLY exemption is "nothing was demanded". A round that owes fixes and cannot
        // show a certificate — its screening leg answered nothing, or its rows predate fix verification
        // (`legacyScreening`) — is INELIGIBLE, not clean: absence of usable verification must not install
        // a refined draft over the incumbent on the strength of a check nobody ran. A round that owes
        // nothing (round 1, or a refinement whose fix tasks the Author has since settled) keeps §6.5's
        // least-bad path, which is what the T12/C screening degrade and R5 both depend on.
        eligible: critical === 0 && high === 0 && demanded.every((fixRef) => fixesCleared.includes(fixRef)),
        legacyScreening: certifiable.length === 0
    };
}

/**
 * Does this round have to certify fixes before it may select?
 *
 * True as soon as ANY candidate was handed a fix list. False means the round promised nothing — round
 * 1, or a round whose screening rows predate fix verification — and §6.5's least-bad path stands, so
 * a clean round 1 behaves exactly as it did before (R5).
 */
export function requiresFixCertification(samples: readonly ScoredSample[]): boolean {
    return samples.some((sample) => sample.fixRefs.length > 0);
}

/** The candidates a round may choose from (R3: an invalid draft is never the winner). */
export function eligibleSamples(samples: readonly ScoredSample[]): ScoredSample[] {
    return samples.filter((sample) => sample.eligible);
}

/**
 * Fewest `critical` → fewest `high` → fewest total → lowest revision id (creation order).
 *
 * Returns `undefined` for an empty list: a round with no drafted sample has nothing to select, and
 * the caller must treat that as "not yet" rather than inventing a winner (§6.5's last paragraph).
 * After H1 the empty list has a second meaning: every candidate was screened and rejected, and the
 * caller must NOT fall back to a least-bad pick (R3) — it re-samples, and the retry allowance is what
 * bounds it (`records.ts:samplingCapOf`).
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
