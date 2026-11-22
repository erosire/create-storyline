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
    it('runs the Seed review before any Writer, and holds the first draft until it closes', async () => {
        const rig = await createRig({ seedReviewed: false, summarySampling: 1, summaryReaders: 1 });
        const story = rig.story();
        const candidates = generateWork(rig.store, story, { at: new Date().toISOString(), phase: 'summary' });

        // The Editor's review is the first job; no Writer is offered while it has not run.
        expect(candidates.filter((candidate) => candidate.key.startsWith('wi_seed_review_'))).toHaveLength(1);
        expect(candidates.some((candidate) => candidate.key.startsWith('wi_write_'))).toBe(false);

        // Once the review closes, the draft work appears (one sweep is the review thread).
        await rig.step();
        const later = generateWork(rig.store, rig.store.stories.require(story.id), {
            at: new Date().toISOString(),
            phase: 'summary'
        });

        expect(later.filter((candidate) => candidate.key.startsWith('wi_seed_review_'))).toEqual([]);
        expect(later.some((candidate) => candidate.key.startsWith('wi_write_'))).toBe(true);
    });

    it('keeps each finding decision in its own thread — one verify job, one confirm job', async () => {
        const rig = await createRig({ summarySampling: 1, summaryReaders: 1 });
        const story = rig.story();
        const summary = rig.store.summaries.list().find((row) => row.story_id === story.id)!;

        const first = seedFinding(rig.store, story.id, {
            target_ref: summary.id,
            criterion_ref: 'C-14',
            cost: 'major',
            state: 'unconfirmed',
            fingerprint: 'C-14|summary_1'
        });
        const second = seedFinding(rig.store, story.id, {
            target_ref: summary.id,
            criterion_ref: 'C-13',
            cost: 'critical',
            state: 'unconfirmed',
            fingerprint: 'C-13|summary_1'
        });

        const candidates = generateWork(rig.store, rig.store.stories.require(story.id), {
            at: new Date().toISOString(),
            phase: 'summary'
        });
        const verifies = candidates.filter((candidate) => candidate.key.startsWith('wi_verify_finding_'));

        // One run per finding, not a single batched `verify_findings` job.
        expect(verifies.map((candidate) => candidate.item.findingRefs?.[0])).toEqual([
            first.id,
            second.id
        ]);
        expect(candidates.some((candidate) => candidate.key.startsWith('wi_verify_findings_'))).toBe(false);

        // A confirmed/approved finding gets its own Reader confirmation thread, only after the Editor.
        rig.store.findings.update(
            first.id,
            { state: 'approved', reader_confirmed: false },
            { run_ref: null, why: 'seed: the Editor approved the finding' },
            [{ id: first.id, rev: first.rev }]
        );

        const withApproval = generateWork(rig.store, rig.store.stories.require(story.id), {
            at: new Date().toISOString(),
            phase: 'summary'
        });

        expect(
            withApproval
                .filter((candidate) => candidate.key.startsWith('wi_confirm_finding_'))
                .map((candidate) => candidate.item.findingRefs?.[0])
        ).toEqual([first.id]);
    });

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

    it('does not send a Reader to a draft its Writer is still writing (§4.15)', async () => {
        const rig = await createRig({ summarySampling: 1, summaryReaders: 2 });
        const story = rig.story();
        const summary = rig.store.summaries.list().find((row) => row.story_id === story.id)!;

        // A Writer is live and has filed its draft's first blocks: the row is `pending`, so no
        // Reader may read it yet (this is the reported "Reader ran before the Writer finished").
        const live = rig.store.runs.create(
            {
                story_id: story.id,
                work_item_ref: 'wi_write_summary_1_1_a1',
                role: 'writer',
                state: 'working',
                started_at: new Date().toISOString(),
                tokens: 0,
                kind: 'work',
                no_op: false,
                delegated: []
            },
            { run_ref: null, why: 'seed: a live Writer run' }
        );

        rig.store.revisions.create(
            {
                story_id: story.id,
                unit_kind: 'summary',
                unit_ref: summary.id,
                body: { fields: { premise: 'the only block written so far' } },
                run_ref: live.id,
                state: 'pending',
                verdict_refs: []
            },
            { run_ref: live.id, why: 'seed: the Writer is still filling this draft' }
        );

        const candidates = generateWork(rig.store, rig.store.stories.require(story.id), {
            at: new Date().toISOString(),
            phase: 'summary'
        });

        expect(candidates.filter((candidate) => candidate.key.startsWith('wi_read_'))).toEqual([]);
        expect(candidates.filter((candidate) => candidate.key.startsWith('wi_complete_'))).toEqual([]);
    });

    it('does not read the empty Summary while the first Writer has not filed a revision yet', async () => {
        // The reported glitch: a fresh Story is opened with an empty Summary row, the first sweep
        // spawns its Writer, and the next sweep used to mistake the live Writer's `wi_write_*` row
        // for "the Summary was written in place" — five Reader passes were offered on an empty
        // artifact, and the one the capacity fill started filed C-14/C-13 while the Writer was
        // still expanding the Seed.
        const rig = await createRig({ summarySampling: 1, summaryReaders: 5 });
        const story = rig.story();
        const summary = rig.store.summaries.list().find((row) => row.story_id === story.id)!;

        expect(summary.premise).toBeUndefined();

        rig.store.runs.create(
            {
                story_id: story.id,
                work_item_ref: `wi_write_${summary.id}_1_a1`,
                role: 'writer',
                state: 'working',
                started_at: new Date().toISOString(),
                tokens: 0,
                kind: 'work',
                no_op: false,
                delegated: []
            },
            { run_ref: null, why: 'seed: the first Writer is still writing the Summary' }
        );

        const candidates = generateWork(rig.store, rig.store.stories.require(story.id), {
            at: new Date().toISOString(),
            phase: 'summary'
        });

        // Neither the in-place pass nor the drain probe may hand this empty row to a Reader.
        expect(candidates.filter((candidate) => candidate.item.roleName === 'reader')).toEqual([]);
    });

    it('hands an incomplete Summary draft back to its Writer with the missing blocks named (§4.15)', async () => {
        const rig = await createRig({ summarySampling: 1, summaryReaders: 1 });
        const story = rig.story();
        const summary = rig.store.summaries.list().find((row) => row.story_id === story.id)!;

        // The Writer's run closed, but the draft still lacks five of the six §4.2 blocks: the loop
        // owes one completion job naming exactly what is absent, not a fresh sampling round.
        const closed = rig.store.runs.create(
            {
                story_id: story.id,
                work_item_ref: 'wi_write_summary_1_1_a1',
                role: 'writer',
                state: 'torn_down',
                started_at: '2026-11-23T10:00:00.000Z',
                ended_at: '2026-11-23T10:00:10.000Z',
                tokens: 10,
                kind: 'work',
                no_op: false,
                delegated: []
            },
            { run_ref: null, why: 'seed: a closed Writer run' }
        );

        const revision = rig.store.revisions.create(
            {
                story_id: story.id,
                unit_kind: 'summary',
                unit_ref: summary.id,
                body: { fields: { premise: 'the only block that landed' } },
                run_ref: closed.id,
                state: 'pending',
                verdict_refs: []
            },
            { run_ref: closed.id, why: 'seed: an incomplete Summary draft' }
        );

        const candidates = generateWork(rig.store, rig.store.stories.require(story.id), {
            at: new Date().toISOString(),
            phase: 'summary'
        });
        const job = candidates.find((candidate) =>
            candidate.key.startsWith(`wi_complete_${summary.id}_${revision.id}`)
        );

        expect(job?.item.roleName).toBe('writer');
        expect(job?.item.note).toContain('promise');
        expect(job?.item.note).toContain('world_rules');
        expect(job?.item.note).not.toContain('premise');
        // The unit's ordinary draft does not run beside the completion job (T-4).
        expect(candidates.some((candidate) => candidate.key.startsWith('wi_write_summary_1'))).toBe(false);
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
            fingerprint: 'C-13|summary_1',
            // Phase ①'s Writer round waits for the Reader's independent confirmation.
            reader_confirmed: true
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
