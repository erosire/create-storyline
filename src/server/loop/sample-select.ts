// Phase ①'s deterministic candidate selector (documents/phase-1-research-pipeline.md §6.5).
//
// WHY THIS IS A MODULE AND NOT A FEW LINES IN THE ENGINE: the rule is the design's answer to "which
// sample becomes the next accepted Revision?", and it has to be inspectable on its own — the engine's
// selection commit is a page of record writes, and burying the ranking in it would make the one
// decision the Author needs to trust (P6: no quality score, no model) the hardest thing to read.
//
// THERE IS NO QUALITY SCORE, BY DESIGN. Every key below is a count a deterministic screening Critic
// already produced, or a diff between two stored texts. Nothing here asks a model which draft it
// likes: the selector chooses, the Author judges (P6).
//
// ---------------------------------------------------------------------------
// H1 — the selection is a HILL on an ACCEPTED revision, not a draft of the least-bad text
// ---------------------------------------------------------------------------
// Ranking alone kept choosing the best of whatever a round happened to produce, and the selection
// commit then closed the round's fix tasks because a selection had happened (the old §6.8 write).
// That is a ratchet going backwards: a rewrite that discarded the draft could "fix" a defect by
// forgetting it, close the task, and start the next round from a worse book.
//
// `scoreSample` therefore computes the gates BEFORE the ranking, and the gates are different per mode:
//
//   ROUND WITH AN ACCEPTED BASE (a refinement round — `input.base` is the draft the Summary carries):
//       eligible  ==  the screening set can certify at all
//                     AND the candidate introduces NO blocking issue of its own
//                     AND every STILL-OPEN fix task this candidate's screens were handed is marked
//                         `resolved`, with evidence, by EVERY pass that was asked about it
//
//   FIRST ROUND (no accepted base — nothing to be minimal about, nothing to regress against):
//       eligible  ==  zero `critical` AND zero `high` AND every demanded fix cleared
//
// The first mode is the one that makes the next Revision no worse than this one. The second keeps
// §6.5's initial-creation semantics for the round that has no incumbent to compare with (R5).
//
// `high` IS `major`: the screening schema closes severity at two values (§4.3) and they map
// one-to-one onto the finding ladder (`critical`→critical, `high`→major, `shared/types.ts:SampledIssue`),
// so "blocking" means the same pair of words in the screening answer, in this file, and in the
// Author's escalation.
//
// Minors never appear here. The screening schema closes severity at critical/high (T-11) and the
// Summary-phase prompts cost wording and sentence-shape notes as minor/taste (R6), so a rephrasing
// preference cannot hold a round; whether a CONFIRMED minor is work at all is the Author's dial
// (`records.ts:dialCovers`), decided before a candidate is ever scored.
//
// A round with NOTHING to certify keeps §6.5's least-bad path ONLY in a first round: §6.5 was written
// for "pick the First Revision out of the drafts the seed produced", where there is no incumbent to
// protect. From the round that has an accepted base, an empty eligible set installs NOTHING
// (`records.ts:roundInstallableCandidate`) — the round re-samples, and the improvement-bound retry
// allowance (`records.ts:samplingProgressOf`) is what bounds it.
import type { Revision, SampledFixVerification, SampledIssue, SampleReview } from '../../shared/types';

/** The six §4.2 prose blocks a Summary revision carries, in the order the prompt and the diff read them. */
const SUMMARY_PROSE_FIELDS = ['premise', 'promise', 'theme', 'tone', 'ending', 'world_rules'] as const;

/** One candidate's minimality against the accepted text: what it changed, and how much of it. */
export interface SampleMinimality {
    /** How many of the six §4.2 prose fields the candidate changed (0 when the texts are identical). */
    changedFields: number;
    /**
     * The size of those changes in characters — characters the accepted draft LOSES plus characters
     * it GAINS, summed over the changed fields. Measured as the smallest span that explains each
     * change (strip the common prefix, then the common suffix; what is left IS the edit), so a fix
     * that swaps one clause costs that clause and not the whole paragraph. Deterministic, no
     * dependency, and it never asks a model what the change was "worth".
     */
    changedCharacters: number;
}

/** One candidate, ready to rank: the draft plus the counts its `sample_reviews` produced. */
export interface ScoredSample {
    revision: Revision;
    /** Issues whose severity is `critical`, across every screening review of this revision. */
    critical: number;
    /** Issues whose severity is `high` (a finding at cost `major`), across every screening review. */
    high: number;
    /** Every issue, both severities — the third key of a first round, so two samples with the same split differ. */
    total: number;
    /**
     * Blocking issues this candidate CREATED — defects the accepted base did not carry. An absent or
     * `unknown` origin counts here (fail closed): a pass that was handed the base and did not
     * classify the issue cannot swear the draft is no worse than the text it replaces.
     */
    introducedCritical: number;
    introducedHigh: number;
    /**
     * Blocking issues the ACCEPTED base already had, which the candidate still carries. They cost the
     * candidate nothing by themselves: Revision N was accepted with them, and the Author decides
     * which of them become work. One inherited defect the Author DID target is an open fix task, and
     * that task is in `fixRefs` — so "inherited" never means "excused", it means "not a regression".
     */
    inheritedCritical: number;
    inheritedHigh: number;
    /** `introducedCritical + introducedHigh` — any of these rejects the candidate, whatever it fixed. */
    blockingIntroduced: number;
    /**
     * True when the round handed this candidate an accepted base to be measured against. It is the
     * mode flag for the ranking AND for the origin rule: with a base, an unclassified blocking issue
     * counts as introduced; without one, origin means nothing and no candidate can regress.
     */
    refinement: boolean;
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
    /** `fixesUnresolved.length` — the number the hill is climbed by (see `records.ts:samplingProgressOf`). */
    unresolvedBlocking: number;
    /** Minimality against the accepted base; `{ 0, 0 }` in a first round, where there is no base. */
    minimality: SampleMinimality;
    /**
     * False when no screening row of this candidate can carry a verdict at all — every screening
     * attempt failed the schema, or the rows predate fix verification (`legacyScreening`) — or every
     * row that exists was persisted as invalid. An ungradeable candidate is a REJECTION, never a pass:
     * "nobody checked" is not a certificate.
     */
    gradeable: boolean;
    /**
     * True when this candidate may be selected at all: no blocking issue of its own (in a refinement
     * round), or no blocking issue at all (in a first round), AND every demanded fix cleared, AND a
     * screening set able to certify it. This is the gate `trySelectSample` filters on before ranking.
     *
     * The only exemption is "nothing demanded, nothing to regress against" (H1-C1/F2): a FIRST-round
     * candidate whose screening leg answered nothing is still selectable, which is what §6.5's
     * least-bad path and the T12/C degrade both depend on (R5).
     */
    eligible: boolean;
    /**
     * Why an INELIGIBLE candidate was refused, in one clause the Author can act on. Deterministic and
     * derived from the counts above — it is the audit of a hill that was not climbed, and it is what
     * survives the selection commit once the draft and its screening rows are deleted (P11). Absent on
     * an eligible candidate, which owed no explanation.
     */
    rejectReason?: string;
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
    /** False when the candidate has no screening row at all, or one persisted as schema-invalid. */
    screenedValid: boolean;
}

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
 * this Critic was dispatched), so it cannot veto the certificate.
 */
const carryingFix = (review: SampleReview, fixRef: string): boolean =>
    (review.fix_refs ?? []).includes(fixRef) ||
    (review.fix_verifications ?? []).some((verification: SampledFixVerification) => verification.fix_ref === fixRef);

/**
 * Did THIS pass certify THIS fix?
 *
 * Three things must all hold, and each one removes a way a fix could "close" without being done:
 *   * the verdict names the fix and says `resolved` — `unknown` is the Critic admitting it cannot
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
 * Is this blocking issue a REGRESSION in this candidate — something the accepted text did not have?
 *
 * `inherited` is the only answer that is not: the Critic is saying "I saw this in the draft I was told
 * to revise", and the round must not reject a candidate for carrying a defect the Author already
 * accepted (a rewrite that keeps a known flaw is not a new flaw, and rejecting it would make every
 * draft unselectable). `introduced`, `unknown` and an absent field all count as introduced, and the
 * last two are the fail-closed half: a pass handed the base that did not classify its issue cannot
 * claim the draft is no worse than the text it replaces.
 *
 * In a FIRST round there is no base, so nothing is a regression: the caller never asks.
 */
const issueIsIntroduced = (issue: SampledIssue): boolean => issue.origin !== 'inherited';

/** The six prose fields of one stored revision body, as strings; a missing or non-string field reads as ''. */
const proseFieldsOf = (body: unknown): Record<string, string> => {
    const fields = (body as { fields?: Record<string, unknown> } | undefined)?.fields;
    const out: Record<string, string> = {};

    for (const key of SUMMARY_PROSE_FIELDS) {
        const value = fields?.[key];

        out[key] = typeof value === 'string' ? value.trim() : '';
    }

    return out;
};

/**
 * How much one draft changed relative to the accepted text: the fields it touched, and the size of
 * those edits in characters.
 *
 * WHY THIS IS A TIE-BREAK AND NOT A SCORE (P6): the round's candidates all cleared the same certified
 * work, so the loop has no honest reason to prefer one author's rephrasing over another's — but it
 * DOES have an honest reason to prefer the draft that touched the accepted Revision least. A minimal
 * edit keeps the commitments the last accepted round settled, so the next round is graded against
 * familiar text; a wholesale rewrite throws that evidence away and can silently re-open a defect the
 * Author stopped tracking. The two numbers are a diff of two stored strings, not an opinion.
 *
 * A field one side does not carry counts as changed, and its whole text counts as added or removed.
 */
export function minimalityOf(base: unknown, candidate: unknown): SampleMinimality {
    const from = proseFieldsOf(base);
    const to = proseFieldsOf(candidate);

    let changedFields = 0;
    let changedCharacters = 0;

    for (const key of SUMMARY_PROSE_FIELDS) {
        const before = from[key];
        const after = to[key];

        if (before === after) continue;

        changedFields += 1;

        // The smallest span that explains the change: strip the shared prefix, then the shared
        // suffix of what is left, and the two remainders are exactly what the edit removed and added.
        let prefix = 0;

        while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;

        let suffix = 0;

        while (
            suffix < before.length - prefix &&
            suffix < after.length - prefix &&
            before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
        )
            suffix += 1;

        changedCharacters += before.length - prefix - suffix + (after.length - prefix - suffix);
    }

    return { changedFields, changedCharacters };
}

/**
 * One candidate's score: the §6.5 counts, the H1 fix certificate, and the regression/minimality
 * measurement an accepted-revision round is gated on.
 *
 * `reviews` is the draft's screening set (`records.ts:screensFor`, oldest first) and `fixRefs` is the
 * list the round demanded; when the caller names none, the demand is what the passes were handed
 * (their `fix_refs`, or the ids their verdicts echo). The caller passes the list because the ENGINE
 * knows what the prompt carried even when every screening attempt failed and no row declares one.
 *
 * `base` is the ACCEPTED revision body this candidate replaces — present from the round that has an
 * incumbent, absent in the first round. Passing it is what switches on the origin rule (an
 * unclassified blocking issue is then a regression) and the minimality keys; omitting it keeps §6.5's
 * first-round semantics exactly (R5).
 *
 * The unanimity rule is deliberate: with `summary_critics` = 5, five independent Critics were bought,
 * and one Critic marking the fix `unresolved` is a live disagreement the loop must resolve by
 * resampling, not by averaging (P6: pass/fail, never a score).
 */
export function scoreSample(input: {
    revision: Revision;
    reviews: SampleReview[];
    fixRefs?: string[];
    base?: unknown;
}): ScoredSample {
    const { revision, reviews } = input;
    const refinement = input.base !== undefined;
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

    // The origin split only exists when there is a base to be relative to. `issueIsIntroduced` reads
    // an absent/`unknown` origin as introduced, which is the fail-closed half of the rule.
    const introducedCritical = refinement ? issues.filter((issue) => issue.severity === 'critical' && issueIsIntroduced(issue)).length : 0;
    const introducedHigh = refinement ? issues.filter((issue) => issue.severity === 'high' && issueIsIntroduced(issue)).length : 0;
    const inheritedCritical = refinement ? critical - introducedCritical : 0;
    const inheritedHigh = refinement ? high - introducedHigh : 0;
    const blockingIntroduced = introducedCritical + introducedHigh;
    const fixesOutstanding = demanded.filter((fixRef) => !fixesCleared.includes(fixRef));

    // A candidate is gradeable when at least one VALID screening row exists to certify anything. An
    // all-invalid set is not "clean": it is an answer nobody read.
    const gradeable = reviews.some((review) => review.valid === true);
    // H1-C1/F2, stated once: only a round WITH an incumbent treats an ungradeable screening set as a
    // disqualification. A first round has no accepted text to put at risk, so §6.5's degrade — install
    // the best draft the round produced even though the provider never answered the IssueList schema —
    // is still what the T12/C partial-screening path depends on (R5).
    const ungradeable = refinement && !gradeable;

    // The gates, in the order the Author reads them: an ungradeable set, then a regression, then the
    // fixes that were not certified, then (first round only) the raw blocking counts.
    const reasons: string[] = [];

    if (ungradeable) reasons.push('the screening leg answered nothing an auditor could read');
    else if (refinement && blockingIntroduced > 0)
        reasons.push(`introduced ${introducedCritical} critical / ${introducedHigh} major the accepted draft did not have`);

    if (fixesOutstanding.length > 0) reasons.push(`fix ${fixesOutstanding.join(', ')} not certified with evidence`);

    // The first round has no incumbent, so "blocking issue" means the §6.5 counts themselves; from the
    // round with a base the same sentence is carried by `blockingIntroduced` above.
    if (!refinement && critical + high > 0) reasons.push(`${critical} critical / ${high} major screening issues`);

    // A refinement round gets no help from an ungradeable screening set: the thing being risked is text
    // the Author already signed, so "nobody checked" must not install a refined draft over the
    // incumbent on the strength of a check nobody ran (H1-C1/F2). A first round keeps its exemption,
    // which is what a clean round 1 and the T12/C degrade both depend on (R5).
    const eligible =
        !ungradeable &&
        (refinement ? blockingIntroduced === 0 : critical === 0 && high === 0) &&
        demanded.every((fixRef) => fixesCleared.includes(fixRef));

    return {
        revision,
        critical,
        high,
        total: issues.length,
        introducedCritical,
        introducedHigh,
        inheritedCritical,
        inheritedHigh,
        blockingIntroduced,
        refinement,
        fixRefs: demanded,
        fixesCleared,
        fixesUnresolved: fixesOutstanding,
        unresolvedBlocking: fixesOutstanding.length,
        minimality: refinement ? minimalityOf(input.base, revision.body) : { changedFields: 0, changedCharacters: 0 },
        gradeable,
        eligible,
        ...(eligible ? {} : { rejectReason: reasons.join('; ') }),
        legacyScreening: certifiable.length === 0,
        screenedValid: reviews.length > 0 && reviews.every((review) => review.valid === true)
    };
}

/**
 * Does this round have to certify fixes before it may select?
 *
 * True as soon as ANY candidate was handed a fix list, or ANY candidate was measured against an
 * accepted base — the second half is the hill: a refinement round's floor is "no worse than the text
 * the Author signed", and that floor needs the screening set to have compared the two texts whether or
 * not a fix task happened to be open when the screens went out. False means the round promised
 * nothing — a first round — and §6.5's least-bad path stands (R5).
 */
export function requiresFixCertification(samples: readonly ScoredSample[]): boolean {
    return samples.some((sample) => sample.fixRefs.length > 0 || sample.refinement);
}

/** The candidates a round may choose from (R3: an invalid draft is never the winner). */
export function eligibleSamples(samples: readonly ScoredSample[]): ScoredSample[] {
    return samples.filter((sample) => sample.eligible);
}

/**
 * THE BEST UNRESOLVED-BLOCKING-FIX COUNT this round has proved, and whether it was proved without a
 * regression (the number the retry allowance is measured against, `records.ts:samplingProgressOf`).
 *
 * Only a gradeable, regression-free candidate is eligible to set the bar: a draft that fixed two
 * tasks and broke a third did not climb, and recording its lower count as the best would let the loop
 * keep retrying against a number no accepted text could ever match.
 */
export function bestUnresolvedBlocking(samples: readonly ScoredSample[]): number | undefined {
    const measured = samples.filter((sample) => sample.gradeable && sample.blockingIntroduced === 0);

    if (measured.length === 0) return undefined;

    return Math.min(...measured.map((sample) => sample.unresolvedBlocking));
}

/**
 * The best candidate of the pool, by mode.
 *
 * A refinement round (any candidate carrying an accepted base) ranks:
 *     fewest unresolved fixes  →  no new critical, then no new major  →  fewest changed fields  →
 *     fewest changed characters  →  the earliest candidate
 *
 * A first round keeps §6.5: fewest `critical` → fewest `high` → fewest `total` → the earliest
 * candidate. There is no incumbent there to be minimal about, and no base to regress against.
 *
 * THE LAST KEY IS CREATION ORDER, NOT THE ID. The caller hands the candidates in creation order —
 * `records.ts:roundRevisions` sorts oldest first off `created_at` plus the store's insertion order —
 * and that index is the tie-break. Ids are never parsed: §4 leaves their shape to the store, they are
 * becoming per-story and opaque, and a numeric suffix that happens to be chronological is a detail a
 * future id change would silently invert.
 *
 * Returns `undefined` for an empty list: a round with no drafted sample has nothing to select, and
 * the caller must treat that as "not yet" rather than inventing a winner (§6.5's last paragraph).
 * After H1 the empty list has a second meaning: every candidate was screened and rejected, and in a
 * round WITH an accepted base the caller must NOT fall back to a least-bad pick (R3) — it re-samples.
 *
 * The input array is not mutated: the selection commit writes rows, so a helper that reorders its
 * caller's array would make the audit line's sample order depend on the ranking.
 */
export function selectSample(samples: ScoredSample[]): ScoredSample | undefined {
    if (samples.length === 0) return undefined;

    const refinement = samples.some((sample) => sample.refinement);
    const ranked = samples.map((sample, index) => ({ sample, index })).sort((left, right) => {
        const byMeasure = refinement
            ? left.sample.unresolvedBlocking - right.sample.unresolvedBlocking ||
              left.sample.introducedCritical - right.sample.introducedCritical ||
              left.sample.introducedHigh - right.sample.introducedHigh ||
              left.sample.minimality.changedFields - right.sample.minimality.changedFields ||
              left.sample.minimality.changedCharacters - right.sample.minimality.changedCharacters
            : left.sample.critical - right.sample.critical ||
              left.sample.high - right.sample.high ||
              left.sample.total - right.sample.total;

        // The explicit index tie-break is the creation order, and it is the LAST key by design: it is
        // the only one that is not a measurement.
        return byMeasure || left.index - right.index;
    });

    return ranked[0].sample;
}
