// §6.5's deterministic sample selector — the one decision phase ① makes with no model at all.
//
// The ranking is a pure lexicographic comparison and every tie-break is pinned here, because the
// rule's whole value is that two people (and two runs) reading the same counts reach the same draft:
// fewest `critical` → fewest `high` → fewest total → the earliest sample. There is NO quality score.
//
// H1 added the axis the ranking runs INSIDE: a candidate is only eligible once its screening passes
// have CERTIFIED the fixes the round handed it, so the round climbs instead of re-drawing. The cases
// below pin every way a certificate can be faked — silence, a verdict with no evidence, a pass that
// was never asked, an invalid pass, and a majority vote.
//
// THE HILL CLIMB added the third axis, and it is not a score either: with an accepted Summary Revision
// as the base, a candidate is judged on the fixes it CERTIFIED, the critical/major it INTRODUCED (its
// own, not the ones it INHERITED — `IssueItem.origin`), and how little of the accepted text it CHANGED
// (`minimalityOf`, the tie-break among candidates that did the same work). A refinement round with no
// eligible candidate has NO winner: `selectSample` returns `undefined` and the caller re-samples rather
// than installing a draft worse than the one the Author signed (requirement 7).
import { describe, expect, it } from 'vitest';

import {
    bestUnresolvedBlocking,
    eligibleSamples,
    minimalityOf,
    requiresFixCertification,
    scoreSample,
    selectSample,
    type ScoredSample
} from './sample-select';
import type { Revision, SampledFixVerification, SampledIssue, SampleReview } from '../../shared/types';

/** A Summary revision with only the fields the selector reads (`id`, for the tie-break). */
const revision = (id: string): Revision => ({
    id,
    rev: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    story_id: 'story_1',
    unit_kind: 'summary',
    unit_ref: 'summary_1',
    body: { fields: { premise: id } },
    state: 'drafted',
    verdict_refs: []
});

/** A Summary revision carrying an explicit set of §4.2 prose fields (the minimality cases need more than one). */
const revisionWith = (id: string, fields: Record<string, string>): Revision => ({
    ...revision(id),
    body: { fields }
});

/**
 * One screening issue; `origin` is the hill's question — did THIS draft create it, or did it inherit it
 * from the accepted text? Absent and `unknown` are the Reader declining to say, and the scorer refuses to
 * take that as "not this draft's fault" (fail closed).
 */
const issue = (severity: SampledIssue['severity'], origin?: SampledIssue['origin']): SampledIssue => ({
    severity,
    criterion: 'C-14',
    location: 'premise',
    quote: `sample: ${severity}`,
    detail: `a ${severity} defect`,
    ...(origin === undefined ? {} : { origin })
});

/**
 * One screening pass. `fixRefs` is the list the WORK ITEM handed it (the demand the certificate is
 * graded against), and `resolved` names the subset it marked `resolved` with evidence — everything
 * else in `fixRefs` it left silent, which is not a pass (H1/R2).
 */
const review = (input: {
    issues?: SampledIssue[];
    fixRefs?: string[];
    resolved?: string[];
    verdicts?: SampledFixVerification[];
    valid?: boolean;
}): SampleReview => ({
    id: 'sample_review_1',
    rev: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    story_id: 'story_1',
    revision_ref: 'revision_1',
    reader: 'reader-screening',
    issues: input.issues ?? [],
    valid: input.valid ?? true,
    ...(input.fixRefs === undefined ? {} : { fix_refs: input.fixRefs }),
    ...(input.verdicts !== undefined
        ? { fix_verifications: input.verdicts }
        : input.fixRefs === undefined
          ? {}
          : {
                fix_verifications: input.fixRefs.map((fixRef) => ({
                    fix_ref: fixRef,
                    status: (input.resolved ?? []).includes(fixRef) ? 'resolved' : 'unknown',
                    evidence: (input.resolved ?? []).includes(fixRef) ? `ending: ${fixRef} is paid off.` : ''
                }))
            })
});

/**
 * A ready-ranked candidate for the §6.5 ranking cases. Every field `ScoredSample` requires is spelled
 * out — the hill added the introduced/inherited split, `unresolvedBlocking`, `minimality`, `gradeable`
 * and `screenedValid`, and a partial literal here would silently stop typechecking the real shape.
 * The overrides let a ranking case name the key it is about without hand-writing 18 defaults.
 */
const sample = (
    id: string,
    critical: number,
    high: number,
    total = critical + high,
    overrides: Partial<ScoredSample> = {}
): ScoredSample => ({
    revision: revision(id),
    critical,
    high,
    total,
    introducedCritical: 0,
    introducedHigh: 0,
    inheritedCritical: 0,
    inheritedHigh: 0,
    blockingIntroduced: 0,
    refinement: false,
    fixRefs: [],
    fixesCleared: [],
    fixesUnresolved: [],
    unresolvedBlocking: 0,
    minimality: { changedFields: 0, changedCharacters: 0 },
    gradeable: true,
    eligible: critical === 0 && high === 0,
    legacyScreening: true,
    screenedValid: true,
    ...overrides
});

describe('§6.5 — selectSample', () => {
    it('returns undefined for an empty round rather than inventing a winner', () => {
        // After H1 the empty pool has a second meaning: every candidate was rejected, and falling
        // back to a least-bad pick here is exactly what the hill-climb removes (R3).
        expect(selectSample([])).toBeUndefined();
    });

    it('ranks fewest critical first, even when a sibling has fewer high or fewer total', () => {
        // A: 1 critical / 0 high (total 1) — B: 0 critical / 4 high (total 4). A critical beats any
        // number of highs: that is the whole point of the two-word severity cap (§4.3).
        expect(selectSample([sample('revision_1', 1, 0), sample('revision_2', 0, 4)])?.revision.id).toBe(
            'revision_2'
        );
    });

    it('breaks a critical tie on fewest high, then on fewest total', () => {
        expect(
            selectSample([sample('revision_1', 0, 2, 3), sample('revision_2', 0, 1, 5)])?.revision.id
        ).toBe('revision_2');

        // Same critical and high counts, different totals (a total can exceed the two severities when
        // a review carried an issue the counts did not attribute).
        expect(
            selectSample([sample('revision_1', 1, 1, 2), sample('revision_2', 1, 1, 3)])?.revision.id
        ).toBe('revision_1');
    });

    it('breaks a full tie on CREATION ORDER — the caller’s array index, never a parsed id', () => {
        // Requirement: ids are never parsed. §4 leaves their shape to the store, they are becoming
        // per-story and opaque, and a numeric suffix that happens to be chronological is a detail an id
        // change would silently invert. The caller (`records.ts:roundRevisions`) hands the candidates in
        // creation order, so the FIRST entry wins — here, the candidate whose id sorts WORSE.
        expect(
            selectSample([sample('revision_10', 0, 0), sample('revision_9', 0, 0)])?.revision.id
        ).toBe('revision_10');

        // …and the same rule the other way: id order and creation order agree on the winner only when
        // the earlier candidate also sorts first, so the assertion above cannot be read as "lowest id".
        expect(
            selectSample([sample('revision_9', 0, 0), sample('revision_10', 0, 0)])?.revision.id
        ).toBe('revision_9');
    });

    it('ranks a refinement round by the hill, not by the §6.5 counts', () => {
        // With an accepted base the ranking is: fewest unresolved fixes → fewest new critical → fewest
        // new major → fewest changed fields → fewest changed characters → creation order. The counts
        // `critical`/`high`/`total` no longer decide anything, because they describe the candidate, not
        // the step it took from the accepted text (requirements 2 and 3).
        const fewerFixes = sample('revision_1', 4, 4, 8, { refinement: true, unresolvedBlocking: 1 });
        const moreFixes = sample('revision_2', 0, 0, 0, { refinement: true, unresolvedBlocking: 2 });

        expect(selectSample([moreFixes, fewerFixes])?.revision.id).toBe('revision_1');

        // Equal unresolved count, equal new-critical: the one with no NEW major wins, whatever its own
        // issue counts say.
        const cleanMajor = sample('revision_1', 3, 3, 6, { refinement: true, unresolvedBlocking: 0 });
        const newMajor = sample('revision_2', 0, 1, 1, {
            refinement: true,
            unresolvedBlocking: 0,
            introducedHigh: 1,
            blockingIntroduced: 1
        });

        expect(selectSample([newMajor, cleanMajor])?.revision.id).toBe('revision_1');

        // …and new critical outranks new major.
        const oneNewCritical = sample('revision_1', 0, 0, 0, {
            refinement: true,
            unresolvedBlocking: 0,
            introducedCritical: 1,
            introducedHigh: 1,
            blockingIntroduced: 2
        });
        const oneNewMajor = sample('revision_2', 0, 0, 0, {
            refinement: true,
            unresolvedBlocking: 0,
            introducedCritical: 0,
            introducedHigh: 1,
            blockingIntroduced: 1
        });

        expect(selectSample([oneNewCritical, oneNewMajor])?.revision.id).toBe('revision_2');

        // Fully tied on the measurements: the SMALLEST change of the accepted text wins, and only then
        // creation order. This is the P6 tie-break — a tie-break, not a quality score.
        const biggerEdit = sample('revision_1', 0, 0, 0, {
            refinement: true,
            minimality: { changedFields: 1, changedCharacters: 120 }
        });
        const smallerEdit = sample('revision_2', 0, 0, 0, {
            refinement: true,
            minimality: { changedFields: 1, changedCharacters: 7 }
        });

        expect(selectSample([biggerEdit, smallerEdit])?.revision.id).toBe('revision_2');

        const fewerFields = sample('revision_1', 0, 0, 0, {
            refinement: true,
            minimality: { changedFields: 1, changedCharacters: 400 }
        });
        const moreFields = sample('revision_2', 0, 0, 0, {
            refinement: true,
            minimality: { changedFields: 2, changedCharacters: 9 }
        });

        expect(selectSample([fewerFields, moreFields])?.revision.id).toBe('revision_1');

        // Identical on every measurement, including minimality: creation order, first entry wins.
        expect(
            selectSample([
                sample('revision_9', 0, 0, 0, { refinement: true }),
                sample('revision_1', 0, 0, 0, { refinement: true })
            ])?.revision.id
        ).toBe('revision_9');
    });

    it('does not reorder the caller’s array — the selection commit writes rows in sample order', () => {
        const input = [sample('revision_1', 2, 0), sample('revision_2', 0, 0)];

        selectSample(input);

        expect(input.map((entry) => entry.revision.id)).toEqual(['revision_1', 'revision_2']);
    });

    it('returns the sample itself, counts and all, so the commit can write issue_counts from it', () => {
        expect(selectSample([sample('revision_1', 0, 1), sample('revision_2', 0, 0)])).toEqual(
            sample('revision_2', 0, 0)
        );
    });
});

describe('H1/R2/R3 — scoreSample: the fix certificate', () => {
    it('scores a clean unverified round as eligible with nothing to certify', () => {
        // Round 1 keeps §6.5's shape: no fix list, no certificate, and the counts alone decide (R5).
        // The full object is pinned because the hill added eight fields to this shape, and a candidate
        // with NO accepted base must score them as "nothing measured" (minimality 0/0, no introduced and
        // no inherited counts), not as a regression.
        expect(
            scoreSample({ revision: revision('revision_1'), reviews: [review({}), review({})], fixRefs: [] })
        ).toEqual({
            revision: revision('revision_1'),
            critical: 0,
            high: 0,
            total: 0,
            introducedCritical: 0,
            introducedHigh: 0,
            inheritedCritical: 0,
            inheritedHigh: 0,
            blockingIntroduced: 0,
            refinement: false,
            fixRefs: [],
            fixesCleared: [],
            fixesUnresolved: [],
            unresolvedBlocking: 0,
            minimality: { changedFields: 0, changedCharacters: 0 },
            gradeable: true,
            eligible: true,
            legacyScreening: true,
            screenedValid: true
        });
    });

    it('splits the counts by severity across every pass, and counts nothing for an empty round', () => {
        const scored = scoreSample({
            revision: revision('revision_1'),
            reviews: [
                review({ issues: [issue('critical'), issue('high')] }),
                review({ issues: [issue('high')], fixRefs: [] })
            ]
        });

        expect({ critical: scored.critical, high: scored.high, total: scored.total }).toEqual({
            critical: 1,
            high: 2,
            total: 3
        });
    });

    it('certifies a fix every pass that was asked marked resolved with evidence', () => {
        const scored = scoreSample({
            revision: revision('revision_2'),
            reviews: [
                review({ fixRefs: ['task_1'], resolved: ['task_1'] }),
                review({ fixRefs: ['task_1'], resolved: ['task_1'] })
            ],
            fixRefs: ['task_1']
        });

        expect({
            fixRefs: scored.fixRefs,
            fixesCleared: scored.fixesCleared,
            fixesUnresolved: scored.fixesUnresolved,
            eligible: scored.eligible,
            legacyScreening: scored.legacyScreening
        }).toEqual({
            fixRefs: ['task_1'],
            fixesCleared: ['task_1'],
            fixesUnresolved: [],
            eligible: true,
            legacyScreening: false
        });
    });

    it('rejects a candidate ONE pass marked unresolved — the certificate is unanimous, not a majority', () => {
        // With `summary_readers` = 5 a 4-1 vote is a live disagreement, and the loop resolves it by
        // resampling rather than by averaging (P6: pass/fail, never a score).
        const scored = scoreSample({
            revision: revision('revision_2'),
            reviews: [
                review({ fixRefs: ['task_1'], resolved: ['task_1'] }),
                review({ fixRefs: ['task_1'], resolved: [] }),
                review({ fixRefs: ['task_1'], resolved: ['task_1'] })
            ],
            fixRefs: ['task_1']
        });

        expect({ fixesCleared: scored.fixesCleared, fixesUnresolved: scored.fixesUnresolved, eligible: scored.eligible }).toEqual(
            { fixesCleared: [], fixesUnresolved: ['task_1'], eligible: false }
        );
    });

    it('refuses a resolved verdict that carries no evidence line (D-15)', () => {
        const scored = scoreSample({
            revision: revision('revision_2'),
            reviews: [
                review({
                    fixRefs: ['task_1'],
                    verdicts: [{ fix_ref: 'task_1', status: 'resolved', evidence: '   ' }]
                })
            ],
            fixRefs: ['task_1']
        });

        expect(scored.eligible).toBe(false);
        expect(scored.fixesUnresolved).toEqual(['task_1']);
    });

    it('refuses `unknown`, which is the Reader admitting it cannot tell (R2)', () => {
        const scored = scoreSample({
            revision: revision('revision_2'),
            reviews: [
                review({
                    fixRefs: ['task_1'],
                    verdicts: [{ fix_ref: 'task_1', status: 'unknown', evidence: 'the draft is silent' }]
                })
            ],
            fixRefs: ['task_1']
        });

        expect(scored.eligible).toBe(false);
    });

    it('refuses a verdict from a pass that failed schema validation — nobody read it', () => {
        const scored = scoreSample({
            revision: revision('revision_2'),
            reviews: [
                review({ fixRefs: ['task_1'], resolved: ['task_1'] }),
                review({ fixRefs: ['task_1'], resolved: ['task_1'], valid: false })
            ],
            fixRefs: ['task_1']
        });

        // The counts above still weigh an invalid review (it is the provider's answer), but silence
        // is what it certifies: an unread judgement cannot mark a defect fixed.
        expect(scored.fixesUnresolved).toEqual(['task_1']);
        expect(scored.eligible).toBe(false);
    });

    it('treats a pass that was never asked as not silent about the fix', () => {
        // A fix task confirmed mid-round joins the demand later; a pass screened from the earlier
        // list cannot be held quiet about a question it was never handed.
        const scored = scoreSample({
            revision: revision('revision_2'),
            reviews: [review({ fixRefs: [], resolved: [] }), review({ fixRefs: ['task_2'], resolved: ['task_2'] })],
            fixRefs: ['task_2']
        });

        expect({ fixesCleared: scored.fixesCleared, eligible: scored.eligible }).toEqual({
            fixesCleared: ['task_2'],
            eligible: true
        });
    });

    it('treats a pass handed a fix and saying nothing as a failed certificate', () => {
        const scored = scoreSample({
            revision: revision('revision_2'),
            reviews: [{ ...review({ fixRefs: ['task_1'] }), fix_verifications: [] }],
            fixRefs: ['task_1']
        });

        expect(scored.fixesUnresolved).toEqual(['task_1']);
        expect(scored.eligible).toBe(false);
    });

    it('takes the demand from the passes when the caller names none, in ascending id order', () => {
        const scored = scoreSample({
            revision: revision('revision_2'),
            reviews: [review({ fixRefs: ['task_2', 'task_1'], resolved: ['task_1', 'task_2'] })]
        });

        expect(scored.fixRefs).toEqual(['task_1', 'task_2']);
        expect(scored.fixesCleared).toEqual(['task_1', 'task_2']);
        expect(scored.eligible).toBe(true);
    });

    it('grades a reviewer that echoed the fix id on its verdict instead of declaring fix_refs', () => {
        // `IssueListSchema` keeps the per-report `fix_refs` optional (a pre-H1 row must still parse) and
        // requires the id on every verdict, so `fix_verifications[].fix_ref` is a legitimate second
        // record of the demand. Reading it as "nothing was asked" would let a certification-shaped report
        // walk past the gate on a formatting choice the model made.
        const scored = scoreSample({
            revision: revision('revision_2'),
            reviews: [review({ verdicts: [{ fix_ref: 'task_2', status: 'unresolved', evidence: 'ending: still unearned.' }] })],
            fixRefs: ['task_2']
        });

        expect({
            fixRefs: scored.fixRefs,
            fixesCleared: scored.fixesCleared,
            fixesUnresolved: scored.fixesUnresolved,
            eligible: scored.eligible,
            legacyScreening: scored.legacyScreening
        }).toEqual({
            fixRefs: ['task_2'],
            fixesCleared: [],
            fixesUnresolved: ['task_2'],
            // A pass that answered about the fix owes a passing answer: this one failed it, and the row
            // is not legacy silence, so the candidate is off the round (R3).
            eligible: false,
            legacyScreening: false
        });
    });

    it('certifies a verdict-echo pass that answered resolved with evidence, and infers its demand', () => {
        const verdicts = [{ fix_ref: 'task_2', status: 'resolved' as const, evidence: 'ending: the map pays off.' }];
        const input = { revision: revision('revision_2'), reviews: [review({ verdicts })] };

        // The caller (records.ts) names the demand; with nothing named, the verdict ids ARE the demand,
        // in ascending id order like every other list the selector stores.
        expect(scoreSample({ ...input, fixRefs: ['task_2'] })).toEqual(
            scoreSample({ ...input, fixRefs: undefined })
        );
        expect(scoreSample(input).fixesCleared).toEqual(['task_2']);
        expect(scoreSample(input).eligible).toBe(true);
    });

    it('refuses a verdict-echo pass whose resolved verdict carries no evidence', () => {
        const scored = scoreSample({
            revision: revision('revision_2'),
            reviews: [review({ verdicts: [{ fix_ref: 'task_1', status: 'resolved', evidence: '   ' }] })],
            fixRefs: ['task_1']
        });

        expect({ fixesCleared: scored.fixesCleared, fixesUnresolved: scored.fixesUnresolved, eligible: scored.eligible }).toEqual(
            { fixesCleared: [], fixesUnresolved: ['task_1'], eligible: false }
        );
    });

    it('keeps a blocking screening issue fatal even when every fix is certified (R3)', () => {
        const scored = scoreSample({
            revision: revision('revision_2'),
            reviews: [review({ fixRefs: ['task_1'], resolved: ['task_1'], issues: [issue('high')] })],
            fixRefs: ['task_1']
        });

        expect({ critical: scored.critical, high: scored.high, eligible: scored.eligible }).toEqual({
            critical: 0,
            high: 1,
            eligible: false
        });
    });

    it('refuses a legacy screening set in a round that owes a fix (F2: no verification is not a clean certificate)', () => {
        // A pre-H1 `sample_reviews` row — or a screening leg whose every attempt failed the schema —
        // carries no list and no verdict, so it certifies NOTHING. In a round that owes open fixes that
        // is ineligibility: the incumbent keeps the Summary and the loop resamples, instead of a refined
        // draft replacing it on the strength of a check nobody ran.
        const scored = scoreSample({
            revision: revision('revision_2'),
            reviews: [review({})],
            fixRefs: ['task_1']
        });

        expect({
            fixRefs: scored.fixRefs,
            fixesCleared: scored.fixesCleared,
            fixesUnresolved: scored.fixesUnresolved,
            eligible: scored.eligible,
            legacyScreening: scored.legacyScreening
        }).toEqual({
            fixRefs: ['task_1'],
            fixesCleared: [],
            fixesUnresolved: ['task_1'],
            eligible: false,
            legacyScreening: true
        });

        // A blocking issue is fatal the same way, and for the same reason: nothing was verified.
        expect(
            scoreSample({
                revision: revision('revision_2'),
                reviews: [review({ issues: [issue('critical')] })],
                fixRefs: ['task_1']
            }).eligible
        ).toBe(false);
    });

    it('judges a round that demanded nothing on its counts alone (R5: round 1, and a settled demand)', () => {
        // The one exemption is "nothing outstanding": round 1's draft was handed no fixes, and a
        // refinement whose fix tasks the Author has discarded demands nothing either (F1). A legacy
        // screening set is then not a fault — the round owed no certificate, so §6.5's counts decide.
        expect(
            scoreSample({ revision: revision('revision_1'), reviews: [review({})], fixRefs: [] })
        ).toMatchObject({ fixRefs: [], fixesCleared: [], fixesUnresolved: [], eligible: true, legacyScreening: true });

        // …and the counts still guard it: an unverified round 1 draft with a blocking issue loses.
        expect(
            scoreSample({
                revision: revision('revision_1'),
                reviews: [review({ issues: [issue('critical')] })],
                fixRefs: []
            }).eligible
        ).toBe(false);
    });

    it('does not mutate the reviews it is handed — the selection commit reads them again', () => {
        const reviews = [review({ fixRefs: ['task_1'], resolved: ['task_1'], issues: [issue('high')] })];

        scoreSample({ revision: revision('revision_2'), reviews, fixRefs: ['task_1'] });

        expect(reviews).toEqual([
            {
                id: 'sample_review_1',
                rev: 1,
                created_at: '2026-01-01T00:00:00.000Z',
                updated_at: '2026-01-01T00:00:00.000Z',
                story_id: 'story_1',
                revision_ref: 'revision_1',
                reader: 'reader-screening',
                issues: [issue('high')],
                valid: true,
                fix_refs: ['task_1'],
                fix_verifications: [
                    { fix_ref: 'task_1', status: 'resolved', evidence: 'ending: task_1 is paid off.' }
                ]
            }
        ]);
    });
});

describe('H1/R3 — the pool a round may choose from', () => {
    const clean = scoreSample({ revision: revision('revision_3'), reviews: [review({ fixRefs: ['task_1'], resolved: ['task_1'] })], fixRefs: ['task_1'] });
    const failed = scoreSample({ revision: revision('revision_2'), reviews: [review({ fixRefs: ['task_1'], resolved: [] })], fixRefs: ['task_1'] });
    const firstRound = scoreSample({ revision: revision('revision_1'), reviews: [review({})], fixRefs: [] });

    it('requires certification as soon as one candidate was handed a fix list', () => {
        expect(requiresFixCertification([firstRound, failed])).toBe(true);
        // Round 1, and any stored round whose rows predate the fields: nothing was promised yet.
        expect(requiresFixCertification([firstRound])).toBe(false);
        expect(requiresFixCertification([])).toBe(false);
    });

    it('drops the uncertified candidate from the pool, keeping creation order', () => {
        expect(eligibleSamples([firstRound, failed, clean]).map((entry) => entry.revision.id)).toEqual([
            'revision_1',
            'revision_3'
        ]);
    });

    it('leaves an all-rejected round with no winner at all — which is the retry, not the least-bad pick', () => {
        // The engine selects from `eligibleSamples` only, so this is the exact state that makes the
        // queue draft again (`work.ts:phase1Candidates`) and, once the cap is spent, escalate (R3).
        expect(selectSample(eligibleSamples([failed]))).toBeUndefined();
        // The same round with nothing to certify still installs its best draft (R5).
        expect(selectSample(requiresFixCertification([firstRound]) ? eligibleSamples([firstRound]) : [firstRound])?.revision.id).toBe(
            'revision_1'
        );
    });

    it('falls back to the earliest eligible sample, because a certifying round has no counts left to rank', () => {
        // The screening schema closes severity at critical/high (T-11), so ANY issue a valid pass
        // reports makes its candidate ineligible: inside a certifying round every survivor scores
        // 0/0/0 and §6.5's last tie-break — creation order — is what decides. That is the honest
        // shape of a hill: the round picks the first draft that cleared, not a taste winner.
        const noisy = scoreSample({
            revision: revision('revision_4'),
            reviews: [review({ fixRefs: ['task_1'], resolved: ['task_1'], issues: [issue('high')] })],
            fixRefs: ['task_1']
        });

        expect(noisy.eligible).toBe(false);
        expect(selectSample(eligibleSamples([noisy, clean]))?.revision.id).toBe('revision_3');
    });
});

// ---------------------------------------------------------------------------
// THE HILL — an accepted Summary Revision is a STATE, so the only questions about a candidate are (a)
// did it fix what was demanded, and (b) did it create a new critical/major OF ITS OWN. `origin` is how
// the screening Reader answers (b), and `minimality` is the tie-break among candidates that did the same
// certified work. Requirements 3, 5 and 7 live or die on these numbers, and none of them is a score.
// ---------------------------------------------------------------------------
describe('HILL CLIMB — origin, minimality and the bar the hill is climbed by', () => {
    /** The accepted text the candidates are measured against (the base switches the origin rule on). */
    const base = { fields: { premise: 'the keeper lies at dawn', ending: 'she forgives him', tone: 'elegiac' } };
    const body = (fields: Record<string, string>) => ({ fields });

    it('splits blocking issues into introduced and inherited when the round has an accepted base', () => {
        // One inherited critical (the accepted draft already had it) and one UNCLASSIFIED high. The
        // inherited one costs the candidate nothing; the unclassified one is counted against it.
        const scored = scoreSample({
            revision: revisionWith('revision_2', { ...base.fields, premise: 'the keeper waits at dawn' }),
            reviews: [
                review({
                    issues: [
                        issue('critical', 'inherited'),
                        issue('high')
                    ],
                    fixRefs: ['task_1'],
                    resolved: ['task_1']
                })
            ],
            fixRefs: ['task_1'],
            base
        });

        expect({
            critical: scored.critical,
            high: scored.high,
            total: scored.total,
            introducedCritical: scored.introducedCritical,
            introducedHigh: scored.introducedHigh,
            inheritedCritical: scored.inheritedCritical,
            inheritedHigh: scored.inheritedHigh,
            blockingIntroduced: scored.blockingIntroduced,
            refinement: scored.refinement,
            eligible: scored.eligible,
            rejectReason: scored.rejectReason
        }).toEqual({
            critical: 1,
            high: 1,
            total: 2,
            introducedCritical: 0,
            introducedHigh: 1,
            inheritedCritical: 1,
            inheritedHigh: 0,
            blockingIntroduced: 1,
            refinement: true,
            eligible: false,
            rejectReason: 'introduced 0 critical / 1 major the accepted draft did not have'
        });
    });

    it('fails an origin the Reader did not state CLOSED (requirement 3)', () => {
        // A pass handed the accepted text that does not classify its own issue cannot swear the draft is
        // no worse than the text it replaces — so `unknown` and absent both land in `introduced_*`.
        for (const origin of ['unknown', undefined] as const) {
            const scored = scoreSample({
                revision: revisionWith('revision_2', { ...base.fields, premise: 'the keeper waits at dawn' }),
                reviews: [
                    review({ issues: [issue('critical', origin)], fixRefs: ['task_1'], resolved: ['task_1'] })
                ],
                fixRefs: ['task_1'],
                base
            });

            expect({
                origin,
                introducedCritical: scored.introducedCritical,
                inheritedCritical: scored.inheritedCritical,
                blockingIntroduced: scored.blockingIntroduced,
                eligible: scored.eligible
            }).toEqual({
                origin,
                introducedCritical: 1,
                inheritedCritical: 0,
                blockingIntroduced: 1,
                eligible: false
            });
        }
    });

    it('makes an `inherited` claim worth nothing when there is no base to inherit from', () => {
        // Without a base the origin field is INERT: there is no accepted draft to be relative to, so the
        // split reports 0/0 and §6.5's first-round rule decides on its own counts — a critical is still a
        // critical. That is the fail-closed half of the rule seen from the other side: a candidate cannot
        // buy an excuse in round 1 that only a round WITH an incumbent could ever grant it.
        const scored = scoreSample({
            revision: revisionWith('revision_1', base.fields),
            reviews: [review({ issues: [issue('critical', 'inherited')] })],
            fixRefs: []
        });

        expect({
            refinement: scored.refinement,
            critical: scored.critical,
            introducedCritical: scored.introducedCritical,
            inheritedCritical: scored.inheritedCritical,
            blockingIntroduced: scored.blockingIntroduced,
            eligible: scored.eligible
        }).toEqual({
            refinement: false,
            critical: 1,
            introducedCritical: 0,
            inheritedCritical: 0,
            blockingIntroduced: 0,
            eligible: false
        });
    });

    it('clears a candidate whose only blocking issues are the base’s own (a fix is not punished for them)', () => {
        const scored = scoreSample({
            revision: revisionWith('revision_2', { ...base.fields, premise: 'the keeper waits at dawn' }),
            reviews: [
                review({
                    issues: [issue('critical', 'inherited'), issue('high', 'inherited')],
                    fixRefs: ['task_1'],
                    resolved: ['task_1']
                })
            ],
            fixRefs: ['task_1'],
            base
        });

        expect({
            blockingIntroduced: scored.blockingIntroduced,
            inheritedCritical: scored.inheritedCritical,
            inheritedHigh: scored.inheritedHigh,
            unresolvedBlocking: scored.unresolvedBlocking,
            eligible: scored.eligible,
            minimality: scored.minimality
        }).toEqual({
            blockingIntroduced: 0,
            inheritedCritical: 1,
            inheritedHigh: 1,
            unresolvedBlocking: 0,
            eligible: true,
            // 'the keeper lies at dawn' → 'the keeper waits at dawn' is one field and the smallest span
            // that explains it — the shared 's' at the end of both words is not part of the edit.
            minimality: { changedFields: 1, changedCharacters: 7 }
        });
    });

    it('measures minimality as the smallest span that explains each change, per prose field', () => {
        // P6: this is a TIE-BREAK, not a quality score. The numbers are hand-checked: only the six §4.2
        // prose fields count, an unchanged field costs 0, and a change costs (chars removed + chars
        // added) over the span left after the shared prefix and suffix are stripped.
        expect([
            // Identical text: nothing changed.
            minimalityOf(base, base),
            // One clause appended: the 16 appended characters, nothing else.
            minimalityOf(base, body({ ...base.fields, premise: 'the keeper lies at dawn beside the tide' })),
            // 'lies' → 'waits' inside the same sentence: 3 removed + 4 added (the trailing 's' is shared).
            minimalityOf(base, body({ ...base.fields, premise: 'the keeper waits at dawn' })),
            // Two fields changed: the two spans, summed.
            minimalityOf(
                base,
                body({ ...base.fields, premise: 'the keeper waits at dawn', ending: 'she never speaks of it' })
            ),
            // All three fields rewritten.
            minimalityOf(base, body({ premise: 'x', ending: 'y', tone: 'z' })),
            // A field the candidate dropped reads as empty text, so it costs its whole length.
            minimalityOf(base, body({ premise: 'the keeper lies at dawn' }))
        ]).toEqual([
            { changedFields: 0, changedCharacters: 0 },
            { changedFields: 1, changedCharacters: 16 },
            { changedFields: 1, changedCharacters: 7 },
            { changedFields: 2, changedCharacters: 37 },
            { changedFields: 3, changedCharacters: 49 },
            { changedFields: 2, changedCharacters: 23 }
        ]);
    });

    it('lets only a gradeable, regression-free candidate set the bar the retry is measured against', () => {
        // `records.ts:samplingProgressOf` extends the wave's budget only while a candidate proves a
        // LOWER unresolved-fix count WITHOUT a new critical/major. A regression that fixed more than the
        // incumbent did must not move the bar, or a draft nobody would install keeps buying attempts.
        const incumbent = sample('revision_1', 0, 0, 0, {
            refinement: true,
            gradeable: true,
            blockingIntroduced: 0,
            unresolvedBlocking: 2
        });
        const regression = sample('revision_2', 0, 1, 1, {
            refinement: true,
            gradeable: true,
            blockingIntroduced: 1,
            unresolvedBlocking: 0
        });
        const ungradeable = sample('revision_3', 0, 0, 0, {
            refinement: true,
            gradeable: false,
            blockingIntroduced: 0,
            unresolvedBlocking: 0
        });
        const climber = sample('revision_4', 0, 0, 0, {
            refinement: true,
            gradeable: true,
            blockingIntroduced: 0,
            unresolvedBlocking: 1
        });

        expect(bestUnresolvedBlocking([incumbent, regression])).toBe(2);
        expect(bestUnresolvedBlocking([incumbent, regression, climber])).toBe(1);
        expect(bestUnresolvedBlocking([regression])).toBeUndefined();
        expect(bestUnresolvedBlocking([ungradeable])).toBeUndefined();
        expect(bestUnresolvedBlocking([])).toBeUndefined();
    });

    it('requires certification in ANY refinement round, even one that currently demands nothing', () => {
        // The mode flag is `refinement`, not "are there fix ids right now": a round with an accepted base
        // is a hill, and its candidates are graded against the incumbent. A first round is the only
        // round that can be judged on counts alone (R5).
        const firstRound = sample('revision_1', 0, 0, 0, { refinement: false, fixRefs: [] });
        const settledDemand = sample('revision_2', 0, 0, 0, { refinement: true, fixRefs: [] });

        expect(requiresFixCertification([firstRound])).toBe(false);
        expect(requiresFixCertification([settledDemand])).toBe(true);
    });
});
