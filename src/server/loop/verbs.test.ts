/**
 * Acceptance for the Author-verb half of the loop — §12 rows W4c and W12, and decisions D-19, D-25,
 * D-25a, D-31, D-3c, D-17b, D-29, D-37, D-37a, G-1, L-10, L-17a, L-24, L-27.
 *
 * Each test pins the ROWS a verb writes, because §12's W12 row is about the records changing, not about
 * a return value looking plausible: which locks flipped, how many chapters and verdicts a backtrack
 * scrapped, which section carries the Author's prose, which chapter went `needs_recheck`.
 *
 * The destructive verbs (D-25's Seed edit, D-3c's count change) answer with a confirm step first, so
 * both halves are pinned: what the confirm would remove, and what the confirmed call actually did.
 */
import { describe, expect, it } from 'vitest';
import { BUILT_IN_CRITERIA } from '../../shared/criteria';

import { createRig, seedIdea, walkToChapters, walkToDrain, type Rig } from './mock';

/** The Story rows a destructive verb touches, in one object, so a comparison reads as one fact. */
function footprints(rig: Rig) {
    const story = rig.story();

    return {
        phase: story.phase,
        status: story.status,
        pending_kind: story.pending_kind,
        summary_locked: story.summary_locked,
        plotlines_locked: story.plotlines_locked,
        chapters: rig.store.chapters.list().length,
        plotlines: rig.store.plotlines.list().length,
        revisions: rig.store.revisions.list().length,
        verdicts: rig.store.verdicts.list().length
    };
}

/** A Story with both sign-offs taken and the first chapters drafted (§15 steps 1-6). */
async function atChapters(chapterCount = 2) {
    const rig = await walkToChapters(await createRig({ story: { chapter_count: chapterCount } }), chapterCount);

    await rig.run();

    return rig;
}

describe('D-31 / D-25 — opening a lock scraps the work above it', () => {
    it('backtracking to the plotlines deletes the chapters and their verdicts, and unlocks only phase ②', async () => {
        const rig = await atChapters();

        expect(footprints(rig)).toEqual({
            phase: 'chapters',
            // The crew finishes the book and stops: a clean two-chapter Story with both sign-offs
            // taken is `pending/drained`, which is what the Author verbs below are acting on (L-37).
            status: 'pending',
            pending_kind: 'drained',
            summary_locked: true,
            plotlines_locked: true,
            chapters: 2,
            plotlines: 2,
            revisions: 2,
            // 15 unit/story verdicts + 4 filed against a competing DRAFT (§6.2a/D-21: the Checker judges
            // one draft per run, so each chapter's selected draft carries its own verdict row).
            verdicts: 19
        });

        await rig.engine.backtrack(rig.storyId, 'plotlines');

        expect(footprints(rig)).toEqual({
            phase: 'plotlines',
            status: 'ready',
            pending_kind: 'none',
            // L-31: exactly the phase being reopened loses its lock. The Summary stays signed.
            summary_locked: true,
            plotlines_locked: false,
            chapters: 0,
            plotlines: 2,
            // The drafts and the verdicts about them are gone: they were built on the plotlines the
            // Author is about to change (D-31's "scraps every later artifact, keeps the provenance").
            revisions: 0,
            // 4 of the 19 go with the drafts they judged: they are `target_kind: 'chapter'` rows, and the
            // backtrack sweep deletes every per-chapter verdict (L-31 / invalidation.ts:342). Deltas only:
            // whether verdicts are provenance that survives (D-25/D-22) or scrap is unsettled upstream.
            verdicts: 15
        });
        // Nothing is left queued for artifacts that no longer exist.
        expect(rig.store.tasks.list()).toEqual([]);

        // Reopening phase ② unlocks the plotlines rather than deleting them: that is what the Author
        // went back to edit, and §8's catalogue gives no agent a plotline tool to rewrite them with.
        expect(rig.store.plotlines.list().map((plotline) => `${plotline.order}:${plotline.contract_locked}`)).toEqual([
            '1:false',
            '2:false'
        ]);
    });

    it('editing the Seed is a full backtrack to phase ①, and the Idea record is the Seed (D-25a)', async () => {
        const rig = await atChapters();

        await rig.engine.editSeed(rig.storyId, 'A cartographer burns every map she draws.', { confirm: true });

        const summary = rig.store.summaries.list().find((row) => row.story_id === rig.storyId);

        expect({
            ...footprints(rig),
            idea: rig.story().idea,
            premise: summary?.premise
        }).toEqual({
            phase: 'summary',
            status: 'ready',
            pending_kind: 'none',
            // Everything downstream of a changed Seed is unproven, so both locks come off (D-25a).
            summary_locked: false,
            plotlines_locked: false,
            chapters: 0,
            plotlines: 0,
            revisions: 0,
            // Same 15 that survive the plotline backtrack above: per-chapter verdicts go (L-31), the
            // summary-level rows stay because phase ①'s artifact is rewritten, not deleted (D-25a).
            verdicts: 15,
            idea: 'A cartographer burns every map she draws.',
            // The Summary draft is cleared rather than deleted: the crew rewrites it from the new Seed.
            premise: ''
        });
    });

    it('refuses the Seed edit until the Author confirms what it throws away (L-32)', async () => {
        const rig = await atChapters();

        await expect(rig.engine.editSeed(rig.storyId, 'A cartographer burns every map she draws.')).rejects.toThrow(
            /confirm/i
        );

        // The refusal changes nothing: the confirm step is the whole point of the round trip.
        expect(footprints(rig)).toMatchObject({ phase: 'chapters', chapters: 2, plotlines: 2 });
    });
});

describe("D-3c — the chapter count is the Author's, and changing it after the lock reopens phase ②", () => {
    /** Phase ③ with two drafted chapters, plotlines locked. */
    async function drafted() {
        return atChapters();
    }

    it('asks what it will delete before growing, then re-materialises the whole chapter set', async () => {
        const rig = await drafted();

        // The count changed after the plotlines were locked, so the chapters that exist were built from
        // a plotline set that no longer matches the count: the confirm names them (L-32).
        expect(await rig.engine.changeChapterCount(rig.storyId, 4)).toEqual({
            pending_confirm: true,
            removed: ['chapter_1', 'chapter_2']
        });

        const result = await rig.engine.changeChapterCount(rig.storyId, 4, { confirm: true });

        // The confirmed call rebuilds the set from scratch — the old rows are gone, and the new ids
        // continue the collection rather than reusing them (P11's ids are never reissued).
        expect(result).toEqual({ created: ['chapter_3', 'chapter_4', 'chapter_5', 'chapter_6'], needs_recheck: [] });
        expect(
            rig.store.chapters
                .list()
                .map((chapter) => `${chapter.order}:${chapter.state}:${chapter.current_revision || 'none'}`)
        ).toEqual(['1:outlined:none', '2:outlined:none', '3:outlined:none', '4:outlined:none']);

        // D-3c: after the lock, ANY count change reopens phase ② by backtrack, so the plotlines are up
        // for revision again and the chapters are unbound until phase ③ opens.
        const story = rig.story();

        expect({ phase: story.phase, plotlines_locked: story.plotlines_locked }).toEqual({
            phase: 'plotlines',
            plotlines_locked: false
        });
        expect(rig.store.summaries.list().find((row) => row.story_id === rig.storyId)?.chapter_count).toBe(4);
    });

    it('shrinking deletes the last chapter and keeps the rest (D-3c)', async () => {
        const rig = await drafted();

        await rig.engine.changeChapterCount(rig.storyId, 4, { confirm: true });

        expect(await rig.engine.changeChapterCount(rig.storyId, 3)).toEqual({
            pending_confirm: true,
            removed: ['chapter_6']
        });
        expect(await rig.engine.changeChapterCount(rig.storyId, 3, { confirm: true })).toEqual({
            removed: ['chapter_6'],
            // Nothing else in the sequence moved, so nothing else has to be re-read (D-3c, L-11).
            needs_recheck: []
        });
        expect(rig.store.chapters.list().map((chapter) => `${chapter.order}:${chapter.state}`)).toEqual([
            '1:outlined',
            '2:outlined',
            '3:outlined'
        ]);
        expect(rig.store.summaries.list().find((row) => row.story_id === rig.storyId)?.chapter_count).toBe(3);
    });
});

describe('D-37 / D-37a / L-17a — Pause & edit, then hand the book back', () => {
    it('refuses the prose edit while the Story runs, naming D-37', async () => {
        const rig = await atChapters(1);
        const chapter = rig.store.chapters.list()[0];

        await expect(
            rig.engine.applyAuthorEdit(chapter.id, 'sec_1', 'The water came back over the road first.')
        ).rejects.toThrow(/D-37/);
        expect(
            rig.store.chapters.get(chapter.id)?.sections.map((section) => `${section.id}:${section.origin}`)
        ).toEqual(['sec_1:author', 'sec_2:writer']);
    });

    it('the pause kills the live runs, the edit marks the span Author-written, and the undo restores it', async () => {
        const rig = await atChapters(1);
        const chapter = rig.store.chapters.list()[0];

        expect(
            chapter.sections.map((section) => `${section.id}:${section.origin}:${section.text.slice(0, 24)}`)
        ).toEqual(['sec_1:author:', 'sec_2:writer:draft wi_write_chapter_1']);

        await rig.engine.pauseStory(rig.storyId);

        // D-37 "immediate: no new dispatch, in-flight runs killed" — and the cord is Story-level, so
        // `author_stop` is what the sweep reads rather than the loop-wide switch.
        expect({ status: rig.story().status, author_stop: rig.story().author_stop, live: rig.liveRuns() }).toEqual({
            status: 'stopped',
            author_stop: true,
            live: []
        });

        await rig.engine.applyAuthorEdit(chapter.id, 'sec_1', 'The water came back over the road first.');

        // D-37a: the span is Author-written, which is what stops the crew from "fixing" it back.
        expect(
            rig.store.chapters
                .get(chapter.id)
                ?.sections.map((section) => `${section.id}:${section.origin}:${section.text.slice(0, 24)}`)
        ).toEqual(['sec_1:author:The water came back over', 'sec_2:writer:draft wi_write_chapter_1']);

        await rig.engine.resumeStory(rig.storyId);

        expect({
            status: rig.story().status,
            author_stop: rig.story().author_stop,
            pending_kind: rig.story().pending_kind
        }).toEqual({
            status: 'ready',
            author_stop: false,
            pending_kind: 'none'
        });

        // L-17a: the undo restores the most recent change to that chapter, and it is the chapter's own
        // undo stack that carries it — the store is the memory (P11).
        await rig.engine.undoLast(chapter.id);

        expect(
            rig.store.chapters
                .get(chapter.id)
                ?.sections.map((section) => `${section.id}:${section.origin}:${section.text.slice(0, 24)}`)
        ).toEqual(['sec_1:author:', 'sec_2:writer:draft wi_write_chapter_1']);
    });

    it('an Author edit dirties the chapters that depend on it before anyone runs (D-37a, L-11a)', async () => {
        const rig = await atChapters();
        const [first] = rig.store.chapters.list().sort((left, right) => left.order - right.order);

        await rig.engine.pauseStory(rig.storyId);
        await rig.engine.applyAuthorEdit(first.id, 'sec_2', 'She burned the survey and kept the ash.');

        // The crew has to be told, not trusted to notice (D-37a's first named consequence). What gets
        // told is the dependency graph, not the chapter list: chapter 1 owes chapter 2 nothing in this
        // Story, so chapter 2 keeps its `done` (L-11a propagates along refs, and this edit named none).
        expect(rig.store.chapters.list().map((chapter) => `${chapter.order}:${chapter.state}`)).toEqual([
            '1:needs_recheck',
            '2:done'
        ]);
        expect(rig.store.chapters.get(first.id)?.state).toBe('needs_recheck');

        await rig.engine.resumeStory(rig.storyId);
        await rig.step();

        // The crew takes the hint, re-reads the chapter, and the book is finished again: the resume is
        // not a special case with its own path back (D-37b) — the sweep re-derives the same drain.
        expect({ status: rig.story().status, pending_kind: rig.story().pending_kind }).toEqual({
            status: 'pending',
            pending_kind: 'drained'
        });
    });

    it('unapproving a chapter outranks the criteria and wakes the crew (L-10)', async () => {
        const rig = await atChapters();
        const done = rig.store.chapters.list().sort((left, right) => left.order - right.order)[0];

        expect(done.state).toBe('done');

        await rig.engine.unapproveChapter(done.id);

        expect(rig.store.chapters.get(done.id)?.state).toBe('needs_recheck');
        // A chapter the Author has taken back is authorised work again — no phase can be "done" while
        // it sits open (L-10, L-35).
        expect({ status: rig.story().status, pending_kind: rig.story().pending_kind }).toEqual({
            status: 'ready',
            pending_kind: 'none'
        });
    });
});

describe('D-19 / L-24 — one line of intent becomes a record with impact the loop worked out', () => {
    it('creates the propagate task, marks the targets, and closes the directive with its impact', async () => {
        const rig = await atChapters();
        const chapter = rig.store.chapters.list().sort((left, right) => left.order - right.order)[0];

        const result = await rig.engine.processDirective(rig.storyId, 'cut the 1911 survey map entirely', [chapter.id]);

        expect(result).toEqual({
            directive_id: 'directive_1',
            impact: {
                runs_stopped: 0,
                tasks_created: 1,
                tasks_superseded: 0,
                needs_recheck: [chapter.id],
                ledger_touched: [],
                answered_task_id: null,
                completed_reopened: false
            }
        });

        const directive = rig.store.directives.get('directive_1');

        expect({ state: directive?.state, impact: directive?.impact }).toEqual({
            // The directive is answered by the task it created, and it names the artifact it touched.
            state: 'done',
            impact: [chapter.id]
        });
        expect(rig.store.tasks.list().map((task) => `${task.kind}:${task.state}:${task.title.slice(0, 30)}`)).toEqual([
            'fix:open:propagate: cut the 1911 survey'
        ]);
    });

    it("leaves §4.7's `finding_ref` empty — a directive is not a finding (D-19, §4.7)", async () => {
        const rig = await atChapters();
        const chapter = rig.store.chapters.list().sort((left, right) => left.order - right.order)[0];

        await rig.engine.processDirective(rig.storyId, 'cut the 1911 survey map entirely', [chapter.id]);

        const task = rig.store.tasks.list().sort((left, right) => left.id.localeCompare(right.id))[0];

        expect({
            kind: task.kind,
            priority: task.priority,
            // §4.7's `finding_ref` is a ref into `findings`. A Directive row is a different collection
            // (D-19), and the sweep reads this column as a finding id (work.ts:unitRefInTask,
            // records.ts:tasksForFinding), so putting the directive id here aimed the ref at a row
            // `store.findings` never held.
            finding_ref: task.finding_ref ?? '',
            criterion_ref: task.criterion_ref ?? '',
            // The directive is still nameable from the row: `detail` carries the id, which is where the
            // sweep and the Writer's brief read refs from (D-11: the queue holds the plan).
            detail: task.detail
        }).toEqual({
            kind: 'fix',
            priority: 1,
            finding_ref: '',
            criterion_ref: '',
            detail: `directive_1 · ${chapter.id} · ${chapter.id}`
        });

        // The journal says what created the work, since the finding-approval sentence would lie (P11).
        expect(
            rig.store.journal
                .filter((event) => event.op === 'create' && event.id === task.id)
                .map((event) => event.attribution.why)
        ).toEqual([`directive_1 propagated the Author's directive onto ${chapter.id} (D-19, D-11)`]);
    });
});

describe("D-29 — the selection note IS the record of the Author's decision", () => {
    it("stores the Author's own words on the picked Idea, and the default only when no note was given (D-29, U-15, D-32)", async () => {
        // §4.17's `selection_note` is the half of D-29 that makes a pick a DECISION rather than a chat
        // message: U-15 renders it in the tray's decided list and the next fresh Reader reads it as the
        // reason a point is settled (D-32). So the engine stores what the Author actually said, and the
        // generic sentence is only the fallback for a call that carried no note at all.
        const rig = await createRig({ story: { chapter_count: 2 } });

        await rig.run();

        const NOTE = 'The log is the spine of the book — keep it literal, not dreamy.';

        seedIdea(rig.store, rig.storyId, {
            phase: 'summary',
            state: 'proposed',
            kind: 'possibility',
            fingerprint: 'lamp-log-read-aloud',
            body: 'the keeper reads the lamp log aloud to the light'
        });
        seedIdea(rig.store, rig.storyId, {
            phase: 'summary',
            state: 'proposed',
            kind: 'possibility',
            fingerprint: 'bell-under-water',
            body: 'the steeple bell rings under the water'
        });

        await rig.engine.decideIdea('idea_1', ['idea_1'], NOTE);

        const picked = rig.store.ideas.require('idea_1');
        const loser = rig.store.ideas.require('idea_2');

        expect({ state: picked.state, selection_note: picked.selection_note }).toEqual({
            state: 'selected',
            selection_note: NOTE
        });
        // The Idea that was not picked keeps the D-28 sentence: it has the Author's decision (discarded),
        // just not a reason the Author typed.
        expect({ state: loser.state, selection_note: loser.selection_note }).toEqual({
            state: 'discarded',
            selection_note: 'not selected when the tray was decided (D-28)'
        });

        // P11: the journal carries the same words as the row, so the audit trail shows the reason too.
        expect(
            rig.store.journal
                .filter((event) => event.op === 'update' && event.id === 'idea_1')
                .map((event) => event.attribution.why)
        ).toEqual([`the Author selected idea_1: ${NOTE} (D-29)`]);

        // D-29's other half still fires off the same commit: the pick becomes the next Writer's job.
        expect(
            rig.store.tasks
                .list()
                .filter((task) => task.kind === 'absorb')
                .map((task) => `${task.state}:${task.detail ?? ''}`)
        ).toEqual(['open:idea_1 · story_1']);

        // The fallback is for a note-less call only — a blank note is not a reason, so it falls back too.
        seedIdea(rig.store, rig.storyId, {
            phase: 'summary',
            state: 'proposed',
            kind: 'possibility',
            fingerprint: 'keeper-never-names-the-light',
            body: 'the keeper never names the light'
        });

        await rig.engine.decideIdea('idea_3', ['idea_3'], '   ');

        expect({
            state: rig.store.ideas.require('idea_3').state,
            selection_note: rig.store.ideas.require('idea_3').selection_note
        }).toEqual({
            state: 'selected',
            selection_note: 'the Author selected this Idea (D-29)'
        });
    });
});

describe('G-1 / D-17b — the Goal, the per-chapter bar, and the crew assignment', () => {
    it('setGoal rewrites the Goal the criteria read, and the next sweep re-derives from it (L-16b)', async () => {
        const rig = await atChapters(1);

        // §4.3's Goal row holds the criterion RECORDS, not ids: the ladder and the level placement are
        // read off `criterion.id` (server/criteria/engine.ts:900), so the patch carries the two records
        // the Author kept.
        await rig.engine.setGoal(rig.storyId, {
            threshold_soft: 2,
            criteria: BUILT_IN_CRITERIA.filter((criterion) => criterion.id === 'C-7' || criterion.id === 'C-8')
        });

        // §4.3's Goal row: the soft threshold, the loop-detection limits, and the criterion list the
        // ladder is built from — all one row, read by the criteria engine (G-4).
        expect(
            rig.store.goals
                .list()
                .map(
                    (goal) =>
                        `${goal.threshold_soft}/${goal.flat_rounds}/${goal.regress_tolerance}:${goal.criteria.map((criterion) => criterion.id).join(',')}`
                )
        ).toEqual(['2/3/2:C-7,C-8']);

        await rig.step();

        // The Goal edit is not a defect: nothing was raised, and the ladder is now built from the two
        // criteria the Author kept (G-1: the Author changed the bar, so the board shows a different bar).
        expect(rig.store.findings.list()).toEqual([]);
        expect(rig.story().status_reason).not.toBe('');
    });

    it("setChapterBar writes §4.4's override as the include/exclude text the criteria read (G-1)", async () => {
        const rig = await atChapters(1);
        const chapter = rig.store.chapters.list()[0];

        await rig.engine.setChapterBar(rig.storyId, chapter.id, ['C-7', 'C-9']);

        // A per-chapter bar is an exclusion list (these criteria do not apply to THIS chapter), which is
        // how §14 item 2's "only for this chapter" is expressed in a text field.
        expect(rig.store.chapters.get(chapter.id)?.bar_override).toBe('-C-7 -C-9');
    });

    it('an assignment that does not validate is refused with the reasons, and the row keeps the old crew (D-17b, T-0)', async () => {
        const rig = await atChapters(1);
        const before = rig.story().template_refs;

        expect(await rig.engine.assignTemplates(rig.storyId, { 'writer-chapters': ['nope'] })).toEqual({
            errors: [
                'assignment names "nope", which is not a template in the catalogue (D-17b)',
                'assignment has no Writer template — write permission comes only from a template assigned as a Writer (D-17b, P10)'
            ],
            assigned: before
        });
        expect(rig.story().template_refs).toEqual(before);
    });

    it('a valid assignment lands on the Story row, and live runs need the confirm first (D-38a, L-4)', async () => {
        const rig = await atChapters(1);

        // Every phase needs its own Writer (L-4's three loops, three template sets), and the catalogue's
        // built-ins are the only templates in this store.
        const crew = [
            'writer-summary',
            'writer-plotlines',
            'writer-chapters',
            'editor-general',
            'reader-genre',
            'checker-consistency'
        ];

        expect(await rig.engine.assignTemplates(rig.storyId, crew)).toEqual({
            assigned: crew,
            changed_live_runs: 0
        });
        expect(rig.story().template_refs).toEqual(crew);
    });
});

describe('L-27 — clear Pending means the queue stops being work', () => {
    it('retires the dispatchable tasks without touching the artifacts they were about to change', async () => {
        const rig = await walkToDrain(await createRig({ story: { chapter_count: 1 } }), 1);

        // A clean drained Story has nothing to clear, and clearing it must not disturb the drain.
        expect(rig.store.tasks.list()).toEqual([]);
        await rig.engine.clearPending(rig.storyId);
        expect({
            status: rig.story().status,
            pending_kind: rig.story().pending_kind,
            tasks: rig.store.tasks.list()
        }).toEqual({
            status: 'pending',
            pending_kind: 'drained',
            tasks: []
        });

        // L-25b: the acceptance that follows is what closes the book, and it says what it discarded.
        await rig.engine.acceptCompletion(rig.storyId, true);
        expect([rig.story().status, rig.story().pending_kind, rig.story().status_reason]).toEqual([
            'completed',
            'none',
            'the Author accepted completion: 0 findings and 0 Ideas were discarded (L-25b)'
        ]);
    });
});
