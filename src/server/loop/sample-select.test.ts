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
import { describe, expect, it } from 'vitest';

import {
    eligibleSamples,
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

/** One screening issue; only the severity matters to the counts. */
const issue = (severity: SampledIssue['severity']): SampledIssue => ({
    severity,
    criterion: 'C-14',
    location: 'premise',
    quote: `sample: ${severity}`,
    detail: `a ${severity} defect`
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

const sample = (id: string, critical: number, high: number, total = critical + high): ScoredSample => ({
    revision: revision(id),
    critical,
    high,
    total,
    fixRefs: [],
    fixesCleared: [],
    fixesUnresolved: [],
    eligible: critical === 0 && high === 0,
    legacyScreening: true
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

    it('breaks a full tie on the EARLIEST sample, not the lowest string id', () => {
        // `revision_10` sorts before `revision_9` as a string; creation order is the numeric suffix,
        // so the earlier sample (revision_9) is the one §6.5's "earliest" means.
        expect(
            selectSample([sample('revision_10', 0, 0), sample('revision_9', 0, 0)])?.revision.id
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
        expect(
            scoreSample({ revision: revision('revision_1'), reviews: [review({}), review({})], fixRefs: [] })
        ).toEqual({
            revision: revision('revision_1'),
            critical: 0,
            high: 0,
            total: 0,
            fixRefs: [],
            fixesCleared: [],
            fixesUnresolved: [],
            eligible: true,
            legacyScreening: true
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
