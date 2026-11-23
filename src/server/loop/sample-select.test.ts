// §6.5's deterministic sample selector — the one decision phase ① makes with no model at all.
//
// The ranking is a pure lexicographic comparison and every tie-break is pinned here, because the
// rule's whole value is that two people (and two runs) reading the same counts reach the same draft:
// fewest `critical` → fewest `high` → fewest total → the earliest sample. There is NO quality score.
import { describe, expect, it } from 'vitest';

import { selectSample, type ScoredSample } from './sample-select';
import type { Revision } from '../../shared/types';

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

const sample = (id: string, critical: number, high: number, total = critical + high): ScoredSample => ({
    revision: revision(id),
    critical,
    high,
    total
});

describe('§6.5 — selectSample', () => {
    it('returns undefined for an empty round rather than inventing a winner', () => {
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
