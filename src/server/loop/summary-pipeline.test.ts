// Phase ①'s two counts are the Author's settings: three complete Summaries per round, five
// Readers per draft.
//
// This pins the WORK GENERATION side, not a walk: the sweep must offer one Reader pass per sample
// for every competing Summary draft, and it must offer them before the Editor's choice. The
// end-to-end order is pinned in `integration/summary-review.test.ts`; here the question is only
// "did the plan name the right number of jobs, on the right drafts".
import { describe, expect, it } from 'vitest';

import { DEFAULT_SUMMARY_READERS, DEFAULT_SUMMARY_SAMPLING } from '../../shared/types';
import { seedFinding, seedRevision, seedTask } from '../run/mock';
import { createRig } from './mock';
import { generateWork, summarySamplingOf } from './work';
import type { Story } from '../../shared/types';

describe('phase ① planning — sample × readers, per draft', () => {
    it('falls back to the published three samples, not a template’s older attempts value', () => {
        // A Story with no Author override reads DEFAULT_SUMMARY_SAMPLING. The Summary pane shows
        // that same five in its dial; reading a persisted template's stale `attempts: 3` here made
        // the screen promise five samples while the loop bought three.
        expect(summarySamplingOf({ summary_sampling: undefined } as Story)).toBe(DEFAULT_SUMMARY_SAMPLING);
        expect(summarySamplingOf({ summary_sampling: 3 } as Story)).toBe(3);
    });

    it('defaults to three Writer samples and five Reader passes on each sample', async () => {
        expect(DEFAULT_SUMMARY_SAMPLING).toBe(3);
        expect(DEFAULT_SUMMARY_READERS).toBe(5);

        const rig = await createRig({
            summarySampling: DEFAULT_SUMMARY_SAMPLING,
            summaryReaders: DEFAULT_SUMMARY_READERS
        });
        const story = rig.story();
        const summary = rig.store.summaries.list().find((row) => row.story_id === story.id);

        expect(summary).toBeDefined();

        // Both counts are set to the published standard here. The Story row is the Author's setting;
        // an absent override reads the same standard (DEFAULT_SUMMARY_SAMPLING), never a template's
        // older `attempts` value.
        expect(story.summary_sampling).toBe(3);
        expect(story.summary_readers).toBe(5);

        seedRevision(rig.store, story.id, summary?.id ?? '', 'first sample', 'run_seed_1', {
            unit_kind: 'summary'
        });
        seedRevision(rig.store, story.id, summary?.id ?? '', 'second sample', 'run_seed_2', {
            unit_kind: 'summary'
        });

        const candidates = generateWork(rig.store, rig.store.stories.require(story.id), {
            at: new Date().toISOString(),
            phase: 'summary'
        });
        const readers = candidates.filter((candidate) => candidate.key.startsWith('wi_read_revision_'));

        // Two drafts × five passes. A revised draft is a new revision and gets its own set; the
        // claim key names the draft, which is how the passes stay independent.
        expect(readers.map((candidate) => candidate.item.revisionRef)).toEqual([
            'revision_1',
            'revision_1',
            'revision_1',
            'revision_1',
            'revision_1',
            'revision_2',
            'revision_2',
            'revision_2',
            'revision_2',
            'revision_2'
        ]);
        expect(new Set(readers.map((candidate) => candidate.key)).size).toBe(10);
        expect(readers.every((candidate) => candidate.item.roleName === 'reader')).toBe(true);

        // The Editor is not offered a choice over drafts nobody has read yet (L-20: the choice is
        // the last step, after the Reader passes).
        expect(candidates.some((candidate) => candidate.key.startsWith('wi_select_'))).toBe(false);
    });

    it('starts a round with three complete Summary drafts', async () => {
        const rig = await createRig({ summarySampling: 3, summaryReaders: 5 });
        const story = rig.story();
        const candidates = generateWork(rig.store, story, {
            at: new Date().toISOString(),
            phase: 'summary'
        });
        const writes = candidates
            .filter((candidate) => candidate.key.startsWith('wi_write_summary_1_1_'))
            .map((candidate) => candidate.key);

        expect(writes).toEqual([
            'wi_write_summary_1_1_a1',
            'wi_write_summary_1_1_a2',
            'wi_write_summary_1_1_a3'
        ]);
    });

    it("dispatches the Writer's merge even while the Editor's drafts are still competing", async () => {
        const rig = await createRig({ summarySampling: 1, summaryReaders: 1 });
        const story = rig.story();
        const summary = rig.store.summaries.list().find((row) => row.story_id === story.id)!;

        seedRevision(rig.store, story.id, summary.id, 'first', 'run_a', { unit_kind: 'summary' });
        seedRevision(rig.store, story.id, summary.id, 'second', 'run_b', { unit_kind: 'summary' });
        const merge = seedTask(rig.store, story.id, {
            kind: 'merge',
            title: 'Merge 2 drafts for summary_1',
            detail: 'revision_1 + revision_2; take the first half of each · summary_1',
            owner_role: 'writer'
        });

        const candidates = generateWork(rig.store, story, {
            at: new Date().toISOString(),
            phase: 'summary'
        });
        const job = candidates.find((candidate) => candidate.key.startsWith('wi_fix_summary_1'));

        expect(job?.item.taskRefs).toContain(merge.id);
    });

    it('sends a blocking Summary fix back as three drafts, not one patch', async () => {
        const rig = await createRig({ summarySampling: 3, summaryReaders: 1 });
        const story = rig.story();
        const summary = rig.store.summaries.list().find((row) => row.story_id === story.id)!;
        const selected = seedRevision(rig.store, story.id, summary.id, 'incoming', 'run_selected', {
            unit_kind: 'summary',
            state: 'selected'
        });
        const finding = seedFinding(rig.store, story.id, {
            target_ref: summary.id,
            criterion_ref: 'C-13',
            cost: 'major',
            state: 'approved',
            related_refs: [selected.id],
            fingerprint: 'C-13|summary_1'
        });
        seedTask(rig.store, story.id, {
            kind: 'fix',
            title: 'fix major: the Summary breaks its own tone law',
            detail: `C-13 on ${summary.id} · ${summary.id}`,
            owner_role: 'writer',
            finding_ref: finding.id
        });

        const candidates = generateWork(rig.store, story, {
            at: new Date().toISOString(),
            phase: 'summary'
        });
        const jobs = candidates.filter((candidate) => candidate.key.startsWith('wi_fix_summary_1'));

        expect(jobs).toHaveLength(3);
        expect(jobs.map((candidate) => candidate.item.taskRefs?.[0])).toEqual([
            'task_1',
            'task_1',
            'task_1'
        ]);
    });
});
