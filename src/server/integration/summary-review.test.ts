// Phase ①'s published order — Writer → Reader → Editor, per Summary sample.
//
// The Author's requirement is a pipeline, not a stage: each Writer sample is read as soon as it
// exists, each Reader report is verified by the Editor as soon as it closes, and only then may the
// Editor choose. A valid critique goes back to the Writer as one corrected draft of the same unit,
// and the corrected draft gets its own Reader passes. These tests pin that order against the real
// HTTP server, the real tool catalogue and a crew that only ever sees its brief.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
    bootStoryline,
    createSliceStory,
    crewRows,
    openDial,
    storyRow,
    storyView,
    type StorylineFixture
} from './harness';

describe("phase ①: the Author's Writer → Reader → Editor loop", () => {
    it('reads every sample before the Editor chooses, and never sends the Summary to a checker', async () => {
        const fixture = await bootStoryline({ readerIdeas: 0 });
        const storyId = await createSliceStory(fixture, 1, { sampling: 2, readers: 2 });
        await openDial(fixture, storyId);

        await fixture.settle(async () => (await storyRow(fixture, storyId)).pending_kind === 'phase_signoff', 40);

        const rows = await crewRows(fixture, storyId);
        const refs = rows.map((row) => String(row.work_item_ref));

        // Two samples is the fixture's sampling size. The scripted Writer can re-apply a CAS
        // conflict and file an extra draft, so the assertion is the floor, not an exact count.
        expect(refs.filter((ref) => ref.startsWith('wi_write_summary_1')).length).toBeGreaterThanOrEqual(2);

        // Two Reader passes for every competing draft: `revision_1`, `revision_2`, and any
        // retry's draft. Each passage names its revision in the claim key because the draft — not
        // the unit — is what it reads.
        const readerRefs = refs.filter((ref) => ref.startsWith('wi_read_revision_'));
        const drafts = new Set(readerRefs.map((ref) => /^wi_read_(revision_\d+)_/.exec(ref)?.[1]));

        expect(drafts.size).toBeGreaterThanOrEqual(2);
        expect(readerRefs.length).toBe(drafts.size * 2);

        // The Editor's choice is one job, after every Reader pass, and it is not a checker's job.
        expect(refs.filter((ref) => ref.startsWith('wi_check_summary'))).toEqual([]);
        expect(refs.filter((ref) => ref.startsWith('wi_select_'))).toEqual(['wi_select_1_summary_1']);
        expect(refs.lastIndexOf('wi_select_1_summary_1')).toBeGreaterThan(
            Math.max(...readerRefs.map((ref) => refs.indexOf(ref)))
        );

        const view = await storyView(fixture, storyId);

        // D-22: one installed expansion (the Editor's pick), and the Summary row is the artifact.
        expect(
            (view.revisions as Array<{ state: string }>).filter((revision) => revision.state === 'selected')
        ).toHaveLength(1);
        expect(view.summary?.premise).toContain('A nobody inherits a lighthouse');
    });

    it('keeps an incomplete Summary out of the review, then sends one Writer to add the missing block (§4.15)', async () => {
        // The first attempt ends its run short of `ending`. The row stays `pending` — no Reader may
        // read it — and the sweep hands it back with the block named; that run writes the whole set.
        const fixture = await bootStoryline({ readerIdeas: 0, omitSummaryField: 'ending' });
        const storyId = await createSliceStory(fixture, 1, { sampling: 1, readers: 1 });
        await openDial(fixture, storyId);

        await fixture.settle(async () => (await storyRow(fixture, storyId)).pending_kind === 'phase_signoff', 60);

        const refs = (await crewRows(fixture, storyId)).map((row) => String(row.work_item_ref));
        const completion = refs.findIndex((ref) => ref.startsWith('wi_complete_summary_1_'));
        const firstReader = refs.findIndex((ref) => ref.startsWith('wi_read_revision_'));

        expect(completion).toBeGreaterThanOrEqual(0);
        // The Reader only started after the completion Writer had closed its draft.
        expect(firstReader).toBeGreaterThan(completion);

        const view = await storyView(fixture, storyId);

        expect(view.summary?.ending).toContain('The last keeper climbs the last gallery');
    });

    it('writes three drafts per round, keeps one, and starts the next round from it', async () => {
        // One defect on the first draft of the first round, then clean. The first Editor choice
        // keeps revision_1; the next round must write three NEW revisions (4, 5, 6) from it.
        const fixture = await bootStoryline({
            readerIdeas: 0,
            readerFinds: (ctx) => (ctx.draftIds[0] === 'revision_1' ? ('major' as const) : undefined)
        });
        const storyId = await createSliceStory(fixture, 1, { sampling: 3, readers: 1 });
        await openDial(fixture, storyId);

        await fixture.settle(async () => (await storyRow(fixture, storyId)).pending_kind === 'phase_signoff', 120);

        const rows = await crewRows(fixture, storyId);
        const refs = rows.map((row) => String(row.work_item_ref));

        // The first round is three blind drafts; the fix round is three more.
        expect(refs.filter((ref) => ref.startsWith('wi_write_summary_1_1_')).length).toBe(3);
        expect(refs.filter((ref) => ref.startsWith('wi_fix_summary_1_1_')).length).toBe(3);

        const view = await storyView(fixture, storyId);
        const drafts = (view.revisions as Array<{ unit_kind: string; state: string; id: string }>).filter(
            (revision) => revision.unit_kind === 'summary'
        );

        // Six revisions, flat: one selected and five kept as discarded history.
        expect(drafts.length).toBe(6);
        expect(drafts.filter((revision) => revision.state === 'selected')).toHaveLength(1);
        expect(drafts.filter((revision) => revision.state === 'discarded').length).toBe(5);
    });

    it('runs three drafts with five Reader passes each and keeps two as discarded history', async () => {
        const fixture = await bootStoryline({ readerIdeas: 0 });
        const storyId = await createSliceStory(fixture, 1, { sampling: 3, readers: 5 });
        await openDial(fixture, storyId);

        await fixture.settle(async () => (await storyRow(fixture, storyId)).pending_kind === 'phase_signoff', 200);

        const rows = await crewRows(fixture, storyId);
        const refs = rows.map((row) => String(row.work_item_ref));
        const readerRefs = refs.filter((ref) => ref.startsWith('wi_read_revision_'));
        const draftIds = new Set(readerRefs.map((ref) => /^wi_read_(revision_\d+)_/.exec(ref)?.[1]));

        expect(draftIds.size).toBe(3);
        expect(readerRefs.length).toBe(15);

        const view = await storyView(fixture, storyId);
        const drafts = (view.revisions as Array<{ unit_kind: string; state: string }>).filter(
            (revision) => revision.unit_kind === 'summary'
        );

        expect(drafts).toHaveLength(3);
        expect(drafts.filter((revision) => revision.state === 'selected')).toHaveLength(1);
        expect(drafts.filter((revision) => revision.state === 'discarded')).toHaveLength(2);
    });

    it('lets the Author ask for another round instead of accepting the final Summary', async () => {
        const fixture = await bootStoryline({ readerIdeas: 0 });
        const storyId = await createSliceStory(fixture, 1, { sampling: 2, readers: 1 });
        await openDial(fixture, storyId);

        await fixture.settle(async () => (await storyRow(fixture, storyId)).pending_kind === 'phase_signoff', 60);
        const before = ((await storyView(fixture, storyId)).revisions as Array<{ unit_kind: string }>).filter(
            (revision) => revision.unit_kind === 'summary'
        ).length;

        const reply = await fixture.api('POST', `/stories/${storyId}/summary/revise`, {
            note: 'The ending is too neat; try a colder one.'
        });

        expect(reply.status).toBe(200);

        await fixture.settle(async () => {
            const view = await storyView(fixture, storyId);
            const drafts = (view.revisions as Array<{ unit_kind: string }>).filter(
                (revision) => revision.unit_kind === 'summary'
            ).length;

            return drafts >= before + 2 && (await storyRow(fixture, storyId)).pending_kind === 'phase_signoff';
        }, 80);

        const after = ((await storyView(fixture, storyId)).revisions as Array<{ unit_kind: string; state: string }>).filter(
            (revision) => revision.unit_kind === 'summary'
        );

        expect(after.length).toBe(before + 2);
        expect(after.filter((revision) => revision.state === 'selected')).toHaveLength(1);
    });

    it('does not hold the Editor choice or the sign-off for a minor Reader note (D-30, D-34)', async () => {
        // A minor note is recorded, not a show-stopper: the Editor still chooses, the Writer gets no
        // correction pass, and the phase can reach its sign-off. Only critical/major hold that bar.
        const fixture = await bootStoryline({ readerIdeas: 0, readerFinds: 'minor' });
        const storyId = await createSliceStory(fixture, 1, { sampling: 2, readers: 1 });
        await openDial(fixture, storyId);

        await fixture.settle(async () => (await storyRow(fixture, storyId)).pending_kind === 'phase_signoff', 60);

        const refs = (await crewRows(fixture, storyId)).map((row) => String(row.work_item_ref));

        expect(refs.filter((ref) => ref.startsWith('wi_select_'))).toHaveLength(1);
        expect(refs.filter((ref) => ref.startsWith('wi_fix_'))).toEqual([]);

        const finding = fixture.store.findings.list().find((row) => row.story_id === storyId);
        expect(finding).toMatchObject({ cost: 'minor' });
    });

    it('marks a Reader critique valid, sends it back to the Writer, and re-reads the corrected draft', async () => {
        // The defect is a one-round event: the first sample has one flaw, the corrected draft is
        // clean, so the loop can reach its sign-off instead of re-filing the same finding forever.
        const fixture = await bootStoryline({
            readerIdeas: 0,
            readerFinds: (ctx) => (ctx.draftIds[0] === 'revision_1' ? ('major' as const) : undefined)
        });
        const storyId = await createSliceStory(fixture, 1, { sampling: 2, readers: 2 });
        await openDial(fixture, storyId);

        await fixture.settle(async () => (await storyRow(fixture, storyId)).pending_kind === 'phase_signoff', 60);

        const rows = await crewRows(fixture, storyId);
        const refs = rows.map((row) => String(row.work_item_ref));

        // The Editor's turn between the Readers and the Writer: the unconfirmed finding is
        // verified BEFORE the fix pass that answers it (D-33, D-34).
        const verifyAt = refs.findIndex((ref) => ref.startsWith('wi_verify_finding_'));
        const fixAt = refs.findIndex((ref) => ref.startsWith('wi_fix_summary_1'));

        expect(verifyAt).toBeGreaterThanOrEqual(0);
        expect(fixAt).toBeGreaterThan(verifyAt);

        // The Writer's correction is a NEW competing draft of the same unit, and it gets its own
        // Reader passes before the second (clean) choice.
        const readerPasses = refs.filter((ref) => ref.startsWith('wi_read_revision_')).length;
        const firstChoice = refs.indexOf('wi_select_1_summary_1');

        expect(refs.filter((ref) => ref.startsWith('wi_select_'))).toHaveLength(2);
        expect(refs.lastIndexOf('wi_select_2_summary_1')).toBeGreaterThan(firstChoice);
        // Two samples × two Readers, plus the corrected draft's own two passes (at least).
        expect(readerPasses).toBeGreaterThanOrEqual(6);

        // Phase ①'s Editor IS the approval gate: this granular thread confirmed AND approved the
        // finding with no Author tap, the Reader confirmed it independently, and the fix pass closed it.
        const finding = fixture.store.findings.list().find((row) => row.story_id === storyId);

        expect(finding).toMatchObject({
            criterion_ref: 'C-14',
            cost: 'major',
            state: 'fixed',
            approved_by: 'auto',
            reader_confirmed: true
        });

        const row = await storyRow(fixture, storyId);

        expect(row.phase).toBe('summary');
        expect(row.status).toBe('pending');
        expect(row.levels.summary).toBe('2/2');

        // The second selection leaves exactly one installed draft and keeps the earlier samples as
        // `discarded` — the material for Overview 1…N's Findings/Revisions in the rail.
        const view = await storyView(fixture, storyId);
        const summaryDrafts = (view.revisions as Array<{ unit_kind: string; state: string }>).filter(
            (revision) => revision.unit_kind === 'summary'
        );

        expect(summaryDrafts.filter((revision) => revision.state === 'selected')).toHaveLength(1);
        expect(summaryDrafts.some((revision) => revision.state === 'discarded')).toBe(true);
    });
});
