// §15 steps 3→5: the chapter phase, the repair ladder, and the completion proposal — end to end.
//
// The crew is scripted from its briefs, so the Story walks the shipped rules rather than a mocked
// happy path: phase ③'s competing drafts are D-3d drafts, the critical finding goes through the real
// verify/approve ladder (L-24), and the drain that stops the loop is the real L-35b/L-37 exhaustion.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
    advanceUntil,
    bootStoryline,
    chapterStates,
    createSliceStory,
    findingStates,
    ideaStates,
    openDial,
    queue,
    revisionStates,
    storyRow,
    storyView,
    type StorylineFixture
} from './harness';

describe('§15 step 3: chapters, the repair ladder, and the loop running itself out', () => {
    let fixture: StorylineFixture;
    let storyId = '';

    beforeAll(async () => {
        // `raiseFindings: 'critical'` is the crew filing §15 step 3a's finding on the chapter units it
        // judges, so the dial's ladder (verify → approve → task → repair) has something to walk; it
        // files once, because a crew that re-files a repaired flaw would spin the loop forever. The
        // Idea the L-37 round files is §15 step 5's completion tray.
        fixture = await bootStoryline({ raiseFindings: 'critical', readerIdeas: 1 });
        storyId = await createSliceStory(fixture, 3);
        await openDial(fixture, storyId);

        // ① and ② are the other suite's subject; this walk only has to get past them, and the walk
        // itself is the Author's verbs: lock what is ready, clear the desk when the loop stops.
        await advanceUntil(fixture, async () => (await storyRow(fixture, storyId)).phase === 'chapters', 60);
    });

    afterAll(async () => {
        await fixture.close();
    });

    it('step 3: the Plotlines lock materialises exactly `chapter_count` chapters, none of them written yet (D-3c, L-8)', async () => {
        expect(chapterStates(fixture.store, storyId)).toEqual([
            { id: 'chapter_1', order: 1, state: 'outlined' },
            { id: 'chapter_2', order: 2, state: 'outlined' },
            { id: 'chapter_3', order: 3, state: 'outlined' }
        ]);

        const row = await storyRow(fixture, storyId);

        expect({ phase: row.phase, status: row.status, pending: row.pending_kind }).toEqual({
            phase: 'chapters',
            status: 'ready',
            pending: 'none'
        });
        expect(row.levels).toEqual({
            summary: '2/2',
            plotlines: '7/7',
            chapters: '0/3 · failing: C-7, C-8, C-9',
            whole: '0/3 · failing: C-10, C-11, C-13'
        });
    });

    it('step 3: every chapter gets its competing drafts, and the Editor leaves one selected per chapter (D-3d, D-3b, D-22)', async () => {
        await fixture.settle(
            async () =>
                (await storyRow(fixture, storyId)).levels.chapters === '3/3' &&
                revisionStates(fixture.store, storyId).every((revision) => !revision.endsWith('/competing')),
            20
        );

        // Two attempts per chapter, one survivor: the losers are deleted at selection rather than kept
        // as a second row, so the ledger is exactly one `selected` draft per unit.
        expect(revisionStates(fixture.store, storyId)).toEqual([
            'revision_1:summary_1/selected',
            'revision_4:chapter_1/selected',
            'revision_6:chapter_2/selected',
            'revision_8:chapter_3/selected'
        ]);

        const runs = (await fixture.api<Array<Record<string, unknown>>>('GET', `/runs?story_id=${storyId}`)).body;

        expect(
            runs
                .filter((run) => String(run.work_item_ref).startsWith('wi_write_chapter_'))
                .map((run) => `${run.work_item_ref}[${run.template_ref}]`)
                .sort()
        ).toEqual([
            'wi_write_chapter_1_1_a1[writer-chapters]',
            'wi_write_chapter_1_1_a2[writer-chapters]',
            'wi_write_chapter_2_1_a1[writer-chapters]',
            'wi_write_chapter_2_1_a2[writer-chapters]',
            'wi_write_chapter_3_1_a1[writer-chapters]',
            'wi_write_chapter_3_1_a2[writer-chapters]'
        ]);
    });

    it('step 3a: the finding the crew filed walks the dial to a repair task on its own (L-24, L-22)', async () => {
        // The dial was open when the finding landed, so the whole ladder ran without an Author click:
        // open → verified → approved → task → repaired. Settling on the task being `done` is the proof
        // the ladder completed; what the finding row then reads is asserted below.
        await fixture.settle(async () => findingStates(fixture.store, storyId).includes('finding_1:fixed/major'), 24);

        expect(findingStates(fixture.store, storyId)).toEqual(['finding_1:fixed/major']);

        const view = await storyView(fixture, storyId);

        // The finding is the Checker's (`raiseFinding` on the chapter unit, C-7), and the cost the
        // ledger ends on is `major`: the Editor's verification is what re-weights it (L-23), which is
        // why the row reads `fixed/major` rather than the `critical` it was filed as.
        expect(view.findings[0]).toMatchObject({
            id: 'finding_1',
            cost: 'major',
            state: 'fixed',
            target_ref: 'chapter_3',
            criterion_ref: 'C-7',
            title: 'Chapter 3 does not deliver its contract'
        });

        // A Task is the loop's unit of assigned repair, and it carries no finding pointer of its own:
        // the chain lives in the work item refs the runs were spawned for (§5.1's Task shape).
        expect(fixture.store.tasks.list().map((task) => `${task.id}:${task.state}/${task.kind}`)).toEqual([
            'task_1:done/fix'
        ]);

        // The repair was a Writer run on the finding's own unit, and the crew hit no tool rule doing it.
        expect(
            (await fixture.api<Array<Record<string, unknown>>>('GET', `/runs?story_id=${storyId}`)).body.map((run) =>
                String(run.work_item_ref)
            )
        ).toContain('wi_fix_chapter_3_1_finding_1_task_1');
        expect([
            ...new Set(fixture.refusals.map((refusal) => `${refusal.template}/${refusal.tool}/${refusal.rule}`))
        ]).toEqual(['writer-plotlines/createPlotline/T-4', 'writer-plotlines/createPlotline/T-11']);
    });

    it('step 3b: every chapter reaches `done` while the loop still owns the work (L-35)', async () => {
        await fixture.settle(
            async () => chapterStates(fixture.store, storyId).every((chapter) => chapter.state === 'done'),
            14
        );

        expect(chapterStates(fixture.store, storyId)).toEqual([
            { id: 'chapter_1', order: 1, state: 'done' },
            { id: 'chapter_2', order: 2, state: 'done' },
            { id: 'chapter_3', order: 3, state: 'done' }
        ]);

        const row = await storyRow(fixture, storyId);

        expect(row.levels).toEqual({ summary: '2/2', plotlines: '7/7', chapters: '3/3', whole: '3/3' });
    });

    it("step 3c: the loop stops by exhaustion and proposes completion, with the tray still the Author's (L-35b, L-37, L-25)", async () => {
        await fixture.settle(async () => (await storyRow(fixture, storyId)).status === 'pending', 24);

        const row = await storyRow(fixture, storyId);

        expect({
            status: row.status,
            pending: row.pending_kind,
            completion: row.completion_proposed,
            blocked: row.blocked_on
        }).toEqual({
            status: 'pending',
            pending: 'drained',
            completion: true,
            blocked: 'the Author: work the leftovers or accept completion'
        });
        // U-14 / L-25b: the drained row states the number the acceptance really throws away. This Idea is
        // `verified` — the LOOP answered "is the claim true?" (D-27), never "is it in the book?" (T-3b) —
        // so it is still the Author's undecided tray, still refuses the lock (L-7a), and `acceptCompletion`
        // discards it with everything else in `DISCARDABLE_IDEA_STATES` (status.ts). Counting only the
        // strict `proposed` rows here reported a tray of 0 Ideas and let the Author click "Complete"
        // without knowing a row they never picked was going away; the tray line and `completion_preview`
        // below both read the discardable set now, so they agree with the accept.
        expect(row.status_reason).toBe(
            'no critical, major, minor or taste left to work on (D-35b) · a fresh round of Readers and checkers found nothing at that threshold (L-37) · 1 undecided Idea in the tray, which accepting discards (L-25b, U-14) · every hard criterion passes at every reached level — the loop proposes completion (L-25)'
        );

        // The proposal is a fact the Author can read: the tray it is waiting on, and the Idea in it.
        // `completion_preview` is the Story view's field, not the panel row's, and its counts are the
        // SAME discardable sets the accept iterates (api/projections.ts:completionPreview) — the one
        // verified Idea IS the discard, so `open_ideas` says 1 rather than the old, flattering 0.
        expect((await storyView(fixture, storyId)).completion_preview).toEqual({
            open_findings: 0,
            open_ideas: 1,
            // With a discardable row on the book the preview names it (U-14's "oldest thing you are
            // waving away"), and the only such row is the probe round's Idea the Author never picked.
            oldest: 'Probe Idea 1: the 1st crossing should cost the keeper her sister, not a name.'
        });
        // U-15 / U-10: the desk shows the Idea the Author still owes a decision on. The loop verified it
        // (D-27), and a `verified` row is NOT a decision — L-7a's lock stays refused while it sits in the
        // tray — so hiding it here was the "decision the machine made by silence" in dashboard form.
        // The queue, the drained row and the preview now count the same rows from the same sets, so the
        // Author cannot be shown a decision in one pane and a zero in another.
        expect((await queue(fixture)).map((item) => `${item.kind}:${item.id}`)).toEqual(['idea:idea_1']);
        // §4.17: `verified` is the EDITOR's answer (D-27/C-15), and the Editor run that filed it is the
        // loop's own — the Author never had to clear the desk first for the fact-check to happen.
        expect(ideaStates(fixture.store, storyId)).toEqual([{ id: 'idea_1', state: 'verified', kind: 'possibility' }]);

        // The ledger the pane reads: one current Digest, and the chapter set it was written from.
        const digests = fixture.store.digests.list();

        expect(digests.filter((digest) => digest.current).map((digest) => digest.id)).toEqual([
            digests[digests.length - 1].id
        ]);
        expect(digests[digests.length - 1].body).toContain('3 · Chapter 3 — The 3th gallery');
        expect(fixture.store.findings.require('finding_1').state).toBe('fixed');
    });

    it('step 5: the Author accepting the proposal is what completes the Story, tray and all (L-25, U-17)', async () => {
        // There is no tray gate on this verb: `POST /complete` is `engine.acceptCompletion`, and the
        // D-29 gate the tray has is the PHASE lock's (L-7a), proved in the phases suite. The proposal
        // itself already says what is open, so completing over it is an Author decision, not a bypass.
        const done = await fixture.api<Record<string, unknown>>('POST', `/stories/${storyId}/complete`);

        expect(done.status).toBe(200);
        // The Story's own word for it is `completed`, and the pending kind is cleared with the proposal.
        expect({ status: done.body.status, pending_kind: done.body.pending_kind }).toEqual({
            status: 'completed',
            pending_kind: 'none'
        });

        const row = await storyRow(fixture, storyId);

        expect({ status: row.status, pending: row.pending_kind, completion: row.completion_proposed }).toEqual({
            status: 'completed',
            pending: 'none',
            // The proposal is answered, so the row stops showing it: what the Author sees now is a
            // finished Story, not a proposal still waiting on the desk.
            completion: false
        });
        // The row keeps saying why, in the engine's own words. And the tray is cleared by completion:
        // an Idea nobody decided is decided FOR them once the Story is finished (D-36's other half).
        expect(String(row.status_reason)).toMatch(/complet/i);
        expect(ideaStates(fixture.store, storyId)).toEqual([{ id: 'idea_1', state: 'discarded', kind: 'possibility' }]);
    });
});
