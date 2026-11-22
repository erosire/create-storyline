// Phase ①'s flat revision history: Revision 1…N, no Overview tree.
//
// The rules pinned here are the ones the rail cannot guess:
//   - revisions are numbered in creation order, not grouped by sampling attempt;
//   - a Reader finding is filed against the revision it names in `related_refs`;
//   - the selected revision is the one the Summary row carries;
//   - the tick waits for the round to have a winner and for critical/major work to be gone.
import { describe, expect, it } from 'vitest';
import { fixtureView } from './story-fixtures';
import {
    selectedSummaryRevision,
    summaryReadyForReview,
    summaryRevisionFocus,
    summaryRevisions
} from './story-nav';
import type { Finding, Revision, Verdict } from '../../shared/types';

const DRAFT = (id: string, created: string, extra: Partial<Revision> = {}): Revision => ({
    id,
    rev: 1,
    created_at: created,
    updated_at: created,
    story_id: 's1',
    unit_kind: 'summary',
    unit_ref: 'sum1',
    body: { fields: { premise: id, tone: 'the installed voice' } },
    run_ref: `run_${id}`,
    template_ref: 't-builtin',
    state: 'competing',
    verdict_refs: [],
    ...extra
});

const FINDING = (id: string, related: string, cost: Finding['cost'] = 'major'): Finding => ({
    id,
    rev: 1,
    created_at: '2026-11-11T11:05:00.000Z',
    updated_at: '2026-11-11T11:05:00.000Z',
    story_id: 's1',
    target_ref: 'sum1',
    criterion_ref: 'C-14',
    title: `${id} on ${related}`,
    evidence: 'the page says so',
    cost,
    fingerprint: `fp-${id}`,
    state: 'confirmed',
    seen_count: 1,
    related_refs: [related]
});

const VERDICT = (id: string, target: string, findingRef?: string): Verdict => ({
    id,
    rev: 1,
    created_at: '2026-11-11T11:06:00.000Z',
    updated_at: '2026-11-11T11:06:00.000Z',
    story_id: 's1',
    target_ref: target,
    target_kind: 'revision',
    run_ref: 'run_reader',
    template_ref: 't-reader',
    round: 1,
    criteria_passed: [
        {
            criterion: 'C-14',
            result: findingRef === undefined,
            evidence: 'seed vs draft',
            ...(findingRef === undefined ? {} : { finding_ref: findingRef })
        }
    ],
    hard_pass: findingRef === undefined,
    soft_count: 0,
    recommendation: 'fix'
});

describe('summaryRevisions — Phase ① is a flat Revision 1…N list', () => {
    it('numbers every round in creation order and files findings against one revision only', () => {
        const view = fixtureView();
        const first = DRAFT('revision_a', '2026-11-11T11:01:00.000Z', { state: 'discarded' });
        const second = DRAFT('revision_b', '2026-11-11T11:02:00.000Z', { state: 'discarded' });
        const third = DRAFT('revision_c', '2026-11-11T11:03:00.000Z', { state: 'selected' });
        const fourth = DRAFT('revision_d', '2026-11-11T11:04:00.000Z');

        const revisions = summaryRevisions({
            ...view,
            revisions: [third, first, fourth, second],
            findings: [FINDING('f-one', 'revision_a'), FINDING('f-two', 'revision_b')],
            verdicts: [
                VERDICT('v-one', 'revision_a', 'f-one'),
                VERDICT('v-two', 'revision_b', 'f-two')
            ]
        });

        expect(revisions.map((entry) => [entry.index, entry.revision.id])).toEqual([
            [1, 'revision_a'],
            [2, 'revision_b'],
            [3, 'revision_c'],
            [4, 'revision_d']
        ]);
        expect(revisions[0]?.findings.map((finding) => finding.id)).toEqual(['f-one']);
        expect(revisions[1]?.findings.map((finding) => finding.id)).toEqual(['f-two']);
        expect(revisions[2]?.findings).toEqual([]);
        expect(selectedSummaryRevision({ ...view, revisions: [first, third, fourth] })?.id).toBe('revision_c');
    });

    it('opens the revision named by the rail ref', () => {
        const view = { ...fixtureView(), revisions: [DRAFT('revision_a', '2026-11-11T11:01:00.000Z')] };
        const entry = summaryRevisionFocus(view, { panel: 'summary', ref: 'revision:revision_a' });

        expect(entry?.index).toBe(1);
        expect(summaryRevisionFocus(view, { panel: 'summary', ref: 'revision:missing' })).toBeUndefined();
    });

    it('does not tick the Summary while a round is competing or a critical/major finding is open', () => {
        const view = {
            ...fixtureView(),
            story: { ...fixtureView().story, phase: 'summary' as const, summary_locked: false },
            goal: { ...fixtureView().goal, failing: [] }
        };
        const competing = {
            ...view,
            revisions: [DRAFT('revision_a', '2026-11-11T11:01:00.000Z')]
        };

        expect(summaryReadyForReview(competing)).toBe(false);

        const selected = {
            ...view,
            revisions: [
                DRAFT('revision_a', '2026-11-11T11:01:00.000Z', { state: 'selected' }),
                DRAFT('revision_b', '2026-11-11T11:02:00.000Z', { state: 'discarded' })
            ],
            findings: [FINDING('f-one', 'revision_a')]
        };

        expect(summaryReadyForReview(selected)).toBe(false);

        const clean = {
            ...selected,
            findings: [FINDING('f-one', 'revision_a', 'minor')]
        };

        expect(summaryReadyForReview(clean)).toBe(true);
    });
});
