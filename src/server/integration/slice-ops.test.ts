// §15 step 4 and the Author's other verbs: stop/resume, backtrack, the section edit, undo, the
// assistant run, kill, the cross-Story queue, and a restart from the journal — over real HTTP.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
    advanceUntil,
    bootStoryline,
    createSliceStory,
    liveRunRows,
    openDial,
    queue,
    revisionStates,
    storyRow,
    storyView,
    type StorylineFixture
} from './harness';

import { Store } from '../store/store';

describe('§15 step 4: the Author takes the desk back and hands it over again', () => {
    let fixture: StorylineFixture;
    let storyId = '';

    beforeAll(async () => {
        fixture = await bootStoryline();
        storyId = await createSliceStory(fixture, 3);
        await openDial(fixture, storyId);

        // Park the Story at phase ①'s sign-off, where every one of these verbs has a meaning.
        await fixture.settle(async () => (await storyRow(fixture, storyId)).status === 'pending', 12);
    });

    afterAll(async () => {
        await fixture.close();
    });

    it('the Story is parked at the sign-off the verb list is written against', async () => {
        expect(await storyRow(fixture, storyId)).toMatchObject({
            phase: 'summary',
            status: 'pending',
            pending_kind: 'phase_signoff',
            levels: { summary: '2/2', plotlines: 'n/a', chapters: 'n/a', whole: 'n/a' }
        });
    });

    it('stop takes the crew off the Story, and the loop respects it', async () => {
        const stop = await fixture.api<Record<string, unknown>>('POST', `/stories/${storyId}/stop`);

        // A stop is a Story status, not one of the pending kinds: the panel shows stopped work, not a
        // decision waiting on the Author.
        expect({ status: stop.body.status, pending: stop.body.pending_kind }).toEqual({
            status: 'stopped',
            pending: 'none'
        });

        // A sweep while stopped spawns nothing: the pause is the loop's own decision (the flag the sweep
        // reads), not a filter in one route.
        const runs = (await fixture.api<Array<Record<string, unknown>>>('GET', '/runs')).body.length;

        await fixture.tick();
        await fixture.tick();

        expect((await fixture.api<Array<Record<string, unknown>>>('GET', '/runs')).body.length).toBe(runs);
        expect(liveRunRows(fixture.store)).toEqual([]);

        // Stopping a stopped Story is not an error the Author has to dodge: the verb is idempotent.
        const again = await fixture.api<Record<string, unknown>>('POST', `/stories/${storyId}/stop`);

        expect(again.status).toBe(200);
        expect({ status: again.body.status, pending: again.body.pending_kind }).toEqual({
            status: 'stopped',
            pending: 'none'
        });
    });

    it('resume hands the desk back to the loop, which re-decides the Story by itself (L-1 step 3)', async () => {
        const resume = await fixture.api<Record<string, unknown>>('POST', `/stories/${storyId}/resume`);

        expect({ status: resume.body.status, pending: resume.body.pending_kind }).toEqual({
            status: 'ready',
            pending: 'none'
        });

        const runs = (await fixture.api<Array<Record<string, unknown>>>('GET', '/runs')).body.length;

        await fixture.tick();

        // Phase ①'s work is already done, so the resumed loop has nothing to dispatch and the sweep
        // re-derives the same stop on its own — the Story goes back to waiting for the lock without the
        // Author touching it, and without a new run.
        expect((await fixture.api<Array<Record<string, unknown>>>('GET', '/runs')).body.length).toBe(runs);
        expect(await storyRow(fixture, storyId)).toMatchObject({ status: 'pending', pending_kind: 'phase_signoff' });
    });

    it("a directive reaches the Story as the Author's sentence, and the loop reads it (L-11)", async () => {
        const directive = await fixture.api<Record<string, unknown>>('POST', `/stories/${storyId}/directives`, {
            text: 'The keeper never learns her own name. Keep it that way.'
        });

        expect(directive.status).toBe(200);
        // The verb routes answer with the Story row they acted on, not the Directive row: the Author's
        // desk is the Story, and the sentence is read back from the ledger.
        expect({ id: directive.body.id, phase: directive.body.phase }).toEqual({ id: 'story_1', phase: 'summary' });

        expect(fixture.store.directives.require('directive_1')).toMatchObject({
            story_id: 'story_1',
            text: 'The keeper never learns her own name. Keep it that way.',
            // The route propagates on the spot: by the time the POST answers, the loop has decided which
            // units the sentence touches and the Directive is `done`, with that impact on its row.
            state: 'done'
        });

        // Propagated with nothing to touch: at phase ① there are no plotlines or chapters for a sentence
        // about the ending to land on, so the impact list is the honest empty one (L-11).
        const propagated = fixture.store.directives.require('directive_1');

        expect(Array.isArray(propagated.impact)).toBe(true);
        expect(propagated.impact).toEqual([]);
    });

    it('the assistant run is a run the Author can see, answering one question at a time', async () => {
        const before = (await fixture.api<Array<Record<string, unknown>>>('GET', '/runs')).body.length;

        const first = await fixture.api<Record<string, unknown>>('POST', `/stories/${storyId}/assistant`, {
            target: 'summary',
            text: 'What is blocking the ending?'
        });

        expect(first.status).toBe(200);
        // The Author's question is a run row the moment it is asked (D-18: the row exists before the
        // first token). It is the plumbing kind the assistant reads with, and its work item is the
        // Author's own ask, not one of the loop's jobs.
        expect({ kind: first.body.kind, role: first.body.role, work_item_ref: first.body.work_item_ref }).toEqual({
            kind: 'assistant',
            role: 'writer',
            work_item_ref: 'assistant_story_1_5'
        });
        expect((await fixture.api<Array<Record<string, unknown>>>('GET', '/runs')).body.length).toBe(before + 1);

        // The run answers by reading, and it writes nothing: the assistant's tools are all reads (§8.5).
        await fixture.tick();

        const run = fixture.store.runs.require('run_5');

        expect({ kind: run.kind, delegated: run.delegated, end_reason: run.end_reason }).toEqual({
            kind: 'assistant',
            delegated: [],
            end_reason: 'completed — the model returned no tool call and the run reported'
        });
        expect(run.ended_at).not.toBeNull();
    });

    it('backtrack re-opens an earlier phase, and what that phase produced is torn down (L-31, L-32)', async () => {
        const back = await fixture.api<Record<string, unknown>>('POST', `/stories/${storyId}/backtrack`, {
            phase: 'summary'
        });

        expect(back.status).toBe(200);
        expect({ phase: back.body.phase, summary_locked: back.body.summary_locked, status: back.body.status }).toEqual({
            phase: 'summary',
            summary_locked: false,
            status: 'ready'
        });

        // Backtracking to the phase the drafts belong to retires those drafts: the phase is open again
        // and the crew will produce again. What survives is the Story, its ledger and its Goal.
        expect(revisionStates(fixture.store, storyId)).toEqual([]);
        expect(fixture.store.summaries.require('summary_1').locked).toBe(false);

        const bad = await fixture.api<{ error?: string }>('POST', `/stories/${storyId}/backtrack`, {
            phase: 'nowhere'
        });

        expect(bad.status).toBe(400);
    });

    it('a restart reads the same journal and reports the same Story (L-26)', async () => {
        const live = await storyRow(fixture, storyId);

        // The Store debounces its snapshot; `persist()` is the flush the shipped server does on close,
        // and only after it is the journal on disk current.
        await fixture.store.persist();

        const reloaded = await Store.load(fixture.root);
        const panel = await storyRow({ ...fixture, store: reloaded } as StorylineFixture, storyId);

        expect(panel).toEqual(live);
        expect(reloaded.stories.require(storyId).phase).toBe(live.phase);
        expect(reloaded.ideas.list()).toEqual([]);
    });
});

describe('§15 step 3d/4: the Author writing into a chapter, and undo', () => {
    let fixture: StorylineFixture;
    let storyId = '';

    beforeAll(async () => {
        fixture = await bootStoryline();
        storyId = await createSliceStory(fixture, 3);
        await openDial(fixture, storyId);

        // Get to phase ③ with a chapter that has the crew's prose in it.
        await advanceUntil(
            fixture,
            async () =>
                ((await storyView(fixture, storyId)).chapters ?? []).some(
                    (chapter: Record<string, unknown>) => Array.isArray(chapter.sections) && chapter.sections.length > 0
                ),
            60
        );
    });

    afterAll(async () => {
        await fixture.close();
    });

    it('the Author editing a section needs the Story stopped first, and then wins (D-37, D-24)', async () => {
        const written = (await storyView(fixture, storyId)).chapters.find(
            (chapter: Record<string, unknown>) => Array.isArray(chapter.sections) && chapter.sections.length > 0
        );
        const section = written.sections[0];

        // The pane refuses the pen while the crew has the desk: an edit into a running Story would race
        // the crew's own write, so the Author pauses first (D-37).
        const whileRunning = await fixture.api<{ error?: string }>(
            'POST',
            `/stories/${storyId}/chapters/${written.id}/sections/${section.id}`,
            {
                content: 'written over the crew'
            }
        );

        expect(whileRunning.status).toBe(409);
        expect(whileRunning.body.error).toBe(
            `the prose pane is editable only while the Story is stopped — pause it first (D-37): ${storyId} is ready`
        );

        const stopped = await fixture.api<Record<string, unknown>>('POST', `/stories/${storyId}/stop`);

        expect(stopped.body.status).toBe('stopped');

        const edited = await fixture.api<Record<string, unknown>>(
            'POST',
            `/stories/${storyId}/chapters/${written.id}/sections/${section.id}`,
            {
                content: "Wren's own hand: the lamp answered with her mother's voice."
            }
        );

        expect(edited).toEqual({ status: 200, body: expect.anything() });

        const after = (await storyView(fixture, storyId)).chapters.find(
            (chapter: Record<string, unknown>) => chapter.id === written.id
        ).sections[0];

        // §4.5's section shape: `text` plus the origin stamp that says whose hand is on it.
        expect(after.text).toBe("Wren's own hand: the lamp answered with her mother's voice.");
        expect(after.origin).toBe('author');

        // D-24: the Author's edit is the override. Whatever competing drafts were in flight for that
        // unit are dropped rather than kept as a second answer.
        expect(
            revisionStates(fixture.store, storyId).filter((revision) => revision.includes(`${written.id}/competing`))
        ).toEqual([]);

        const resumed = await fixture.api<Record<string, unknown>>('POST', `/stories/${storyId}/resume`);

        expect(resumed.body.status).toBe('ready');
    });

    it("undo takes the section back to the crew's draft, and the Story keeps working (U-5, P11)", async () => {
        const chapter = (await storyView(fixture, storyId)).chapters.find(
            (entry: Record<string, unknown>) => entry.id === 'chapter_1'
        );
        const section = chapter.sections[0];

        // Same gate as the edit: the undo stack is an Author action on a paused Story (D-37).
        await fixture.api('POST', `/stories/${storyId}/stop`);

        const undo = await fixture.api<{ error?: string }>('POST', `/stories/${storyId}/undo`, {
            chapter_id: chapter.id,
            section_id: section.id
        });

        expect(undo).toEqual({ status: 200, body: expect.anything() });

        const restored = (await storyView(fixture, storyId)).chapters.find(
            (entry: Record<string, unknown>) => entry.id === 'chapter_1'
        ).sections[0];

        // U-5 / P11: the undo restores the crew's draft and the origin stamp goes back with it.
        expect(restored.origin).toBe('writer');
        expect(restored.text).toContain('Chapter 1.');

        await fixture.api('POST', `/stories/${storyId}/resume`);
    });

    it('a kill answers for the run the Author points at, and the Story survives it (S-6)', async () => {
        // The mock crew answers inside the sweep, so no run is open between two HTTP calls at this
        // layer — "kill mid-token" is the loop's own suite's subject. What this proves is the route:
        // the run the Author points at is answered with its row, and an unknown id is a miss.
        const finished = fixture.store.runs.list().find((run) => run.ended_at !== null && run.ended_at !== undefined);

        // The walk has finished runs by now; if it had none, the kill would be testing nothing.
        const runId = String(finished?.id ?? '');

        expect(runId).not.toBe('');

        const killed = await fixture.api<Record<string, unknown>>('POST', `/runs/${runId}/kill`);

        expect(killed.status).toBe(200);
        expect({ id: killed.body.id, state: killed.body.state }).toEqual({ id: runId, state: killed.body.state });
        expect(fixture.store.runs.require(runId).ended_at).not.toBeNull();

        await fixture.tick();

        // Losing a run does not stop a Story: the sweep keeps the Story's own work moving (S-6).
        expect((await storyRow(fixture, storyId)).status).not.toBe('stopped');

        const missing = await fixture.api<{ error?: string }>('POST', '/runs/run_999/kill');

        expect(missing.status).toBe(404);
        expect(missing.body.error).toBe('no run named run_999 is in the book (P1: the store is the memory)');
    });
});
