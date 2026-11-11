// Acceptance for the loop engine's core walk — §12 row W4 ("a Story walks summary → plotlines →
// chapters → completed stopping at exactly three Author sign-offs") and §15's end-to-end slice.
//
// What is pinned here, and where the spec says it:
//   §15 step 0   `createStory` lands a Story at phase `summary`, `ready`, with the Seed and the declared
//                chapter count, and the Goal it will be measured against (§4.1, G-1).
//   L-29/L-6     a phase whose Goal passes goes `pending`/`phase_signoff` and receives NO further work;
//                the lock is the Author's (§6.3).
//   L-8          every chapter of the set is drafted before the phase can advance (all-chapters-together).
//   D-21/D-22    drafts compete, an Editor selects, the loser is deleted in the same commit, and the
//                winner's prose is what the chapter row holds afterwards.
//   L-35/L-36    a passed Goal is not a stop: the crew keeps working until the work DRAINS.
//   L-37/D-35b   `pending`/`drained` needs the whole pass — no authorised work, nothing awaiting
//                verification, nothing competing, and a fresh Reader+checker round that found nothing at
//                the dial — and it dispatches nothing.
//   L-25/L-25b   completion is PROPOSED, never self-applied; accepting states what it discards; discarding
//                keeps the crew working (L-30).
//
// The rig is the real store, the real `RunExecutor`, the real `CriteriaEngine` and a scripted crew
// (`./mock`): every number below is a record in the store, not a mock's memory.
import { beforeEach, describe, expect, it } from 'vitest';
import { BUILT_IN_CRITERIA } from '../../shared/criteria';
import { createRig, seedPlotlineSet, type Rig } from './mock';
import type { SweepReport } from './types';
/** The whole sweep report — every assertion below reads the decision the engine wrote, not a log. */
async function step(rig: Rig): Promise<SweepReport> {
    return rig.step();
}

/** The §15 walk up to the point the Author has to act: sweep until the Story stops moving. */
async function settle(rig: Rig, max = 30) {
    const reports = await rig.run(max);

    return reports;
}

describe('§15 step 0 — createStory', () => {
    let rig: Rig;

    beforeEach(async () => {
        rig = await createRig({
            story: {
                title: 'The Reservoir',
                idea: 'A cartographer returns to a valley redrawn by a reservoir.',
                chapter_count: 2
            }
        });
    });

    it('lands the Story at phase summary, ready, with the Seed and the declared count (P5, D-3b)', () => {
        const story = rig.story();

        expect({
            phase: story.phase,
            status: story.status,
            pending_kind: story.pending_kind,
            trend: story.trend,
            idea: story.idea,
            title: story.title,
            summary_locked: story.summary_locked,
            plotlines_locked: story.plotlines_locked,
            auto_approve: [...(story.auto_approve ?? [])].sort(),
            // The chapter ROWS are not created here: D-3b makes the count Author truth on the Summary, and
            // the rows appear when phase ③ opens, each bound to the plotline at its order (C-1, P4).
            chapters: rig.store.chapters.list().length,
            chapter_count: rig.store.summaries.list().find((row) => row.story_id === rig.storyId)?.chapter_count
        }).toEqual({
            phase: 'summary',
            status: 'ready',
            pending_kind: 'none',
            trend: 'unknown',
            idea: 'A cartographer returns to a valley redrawn by a reservoir.',
            title: 'The Reservoir',
            summary_locked: false,
            plotlines_locked: false,
            auto_approve: ['critical', 'major'],
            chapters: 0,
            chapter_count: 2
        });
    });

    it('gives the Story the Goal it will be measured against, and names it from the Story (G-1, G-4)', () => {
        const story = rig.story();
        const goal = rig.store.goals.get(story.goal_ref ?? '');

        expect({
            titled: goal?.title,
            criteria: goal?.criteria.map((criterion) => criterion.id),
            hard_flags: goal?.criteria.filter((criterion) => criterion.hard).length,
            threshold_soft: goal?.threshold_soft,
            flat_rounds: goal?.flat_rounds,
            regress_tolerance: goal?.regress_tolerance,
            story_ids: rig.store.goals.list().filter((row) => row.story_id === rig.storyId).length
        }).toEqual({
            titled: 'Consistent at every level, and written like mine',
            criteria: BUILT_IN_CRITERIA.map((criterion) => criterion.id),
            hard_flags: BUILT_IN_CRITERIA.filter((criterion) => criterion.hard).length,
            threshold_soft: 3,
            flat_rounds: 3,
            regress_tolerance: 2,
            story_ids: 1
        });
    });
});

describe('§15 steps 1-2 — phase ①', () => {
    it('writes and judges the Summary, then waits for the Author instead of advancing (L-29, L-6)', async () => {
        const rig = await createRig({ story: { chapter_count: 2 } });

        const reports = await settle(rig);
        const last = reports[reports.length - 1];

        expect(last.stories[0]).toMatchObject({
            phase: 'summary',
            status: 'pending',
            pending_kind: 'phase_signoff',
            probe: 'idle'
        });
        expect(last.stories[0].status_reason).toContain('Summary awaits your lock');
        expect(last.stories[0].status_reason).toContain('L-29');

        // A phase that is waiting on the Author receives no further work (W4's row, L-29).
        expect(last.runs_started).toBe(0);
        expect(last.stories[0].started).toEqual([]);

        // The Summary level's Goal is answered from the verdicts the checker filed (L-14, G-2).
        expect(last.stories[0].consistency).toContain('summary 2/2');
    });

    it('locks the Summary on the Author word and moves to phase ②, with the lock recorded (L-6a, §6.3)', async () => {
        const rig = await createRig({ story: { chapter_count: 2 } });

        await settle(rig);
        await rig.engine.lockPhase(rig.storyId, 'summary');

        const story = rig.story();

        expect({
            phase: story.phase,
            summary_locked: story.summary_locked,
            summary_row_locked: rig.store.summaries.list().some((row) => row.locked)
        }).toEqual({
            phase: 'plotlines',
            summary_locked: true,
            summary_row_locked: true
        });
    });
});

describe('§15 steps 3-4 — phase ②', () => {
    /** Phase ② with the plotline set the §8 catalogue has no tool for (a W2 gap; see the report). */
    async function atPlotlines() {
        const rig = await createRig({ story: { chapter_count: 2 } });

        await settle(rig);
        await rig.engine.lockPhase(rig.storyId, 'summary');
        seedPlotlineSet(rig.store, rig.storyId, 2);

        return rig;
    }

    it('writes and judges each plotline, then holds for the sign-off without touching phase ③ (L-29)', async () => {
        const rig = await atPlotlines();

        await settle(rig);

        const story = rig.story();

        expect({
            phase: story.phase,
            status: story.status,
            pending_kind: story.pending_kind,
            plotlines_locked: story.plotlines_locked
        }).toEqual({
            phase: 'plotlines',
            status: 'pending',
            pending_kind: 'phase_signoff',
            plotlines_locked: false
        });
        expect(story.status_reason).toContain('L-29');
        expect(rig.store.plotlines.list()).toHaveLength(2);
    });

    it('refuses to lock a phase the Story has not reached (L-33)', async () => {
        const rig = await atPlotlines();

        await expect(rig.engine.lockPhase(rig.storyId, 'chapters')).rejects.toThrow(/L-33/);
        expect(rig.story().phase).toBe('plotlines');
    });
});

describe('§15 steps 5-9 — phase ③, the chapter loop', () => {
    /** The Story parked at the start of phase ③, plotlines locked. */
    async function atChapters(options: Parameters<typeof createRig>[0] = {}) {
        const rig = await createRig(options);

        await settle(rig);
        await rig.engine.lockPhase(rig.storyId, 'summary');
        seedPlotlineSet(rig.store, rig.storyId, 2);
        await settle(rig);
        await rig.engine.lockPhase(rig.storyId, 'plotlines');

        expect(rig.story().phase).toBe('chapters');

        return rig;
    }

    it('drafts every chapter, judges every draft, and selects one (D-21, D-22, L-8)', async () => {
        const rig = await atChapters({ story: { chapter_count: 2 } });

        await settle(rig);

        const chapters = rig.store.chapters.list().sort((left, right) => left.order - right.order);

        // Every competing draft is gone: the Editor's choice deleted the losers in the same commit.
        expect(rig.store.revisions.list().filter((revision) => revision.state === 'competing')).toEqual([]);
        expect(
            chapters.map((chapter) => ({
                state: chapter.state,
                current_revision: chapter.current_revision,
                last_score: chapter.last_score
            }))
        ).toEqual([
            // The built-in `writer-chapters` template carries `attempts: 2` (D-17d), so each chapter has
            // two blind drafts and the Editor's choice is the one that survives — chapter 2's winner is
            // `revision_3` because chapter 1's pair took `revision_1` and `revision_2`.
            { state: 'done', current_revision: 'revision_1', last_score: '4/4' },
            { state: 'done', current_revision: 'revision_3', last_score: '4/4' }
        ]);

        // D-22: the selected draft's prose is what the chapter row carries, not the draft row.
        expect(chapters.map((chapter) => chapter.sections.map((section) => section.origin))).toEqual([
            ['author', 'writer'],
            ['author', 'writer']
        ]);
        expect(chapters[0].sections[1].text).toContain('draft wi_write_chapter_1_1_a1');

        // The select ran once per chapter, and nothing is in flight.
        expect(rig.store.runs.list().filter((run) => (run.work_item_ref ?? '').startsWith('wi_select_'))).toHaveLength(
            2
        );
        expect(rig.liveRuns()).toEqual([]);
    });

    it('does not stop when the phase Goal turns green: the crew keeps working until it drains (L-35, L-36)', async () => {
        const rig = await atChapters({ story: { chapter_count: 2 } });

        // The sweep that FIRST sees phase ③'s Goal green is the interesting one: a completion-hungry
        // loop would stop there, and L-35 forbids that — only the drain (L-37) stops phase ③.
        let green: Awaited<ReturnType<Rig['step']>>['stories'][number] | undefined;

        for (let index = 0; index < 30 && green === undefined; index += 1) {
            const entry = (await step(rig)).stories[0];

            if (entry.phase === 'chapters' && entry.goal.passed) green = entry;
        }

        expect(green).toBeDefined();
        expect({ status: green?.status, pending_kind: green?.pending_kind, started: green?.started.length }).toEqual({
            status: 'ready',
            pending_kind: 'none',
            // It is still working: the whole-Story pass or the probe round, never a halt.
            started: 1
        });
        expect(green?.status_reason).toContain('the crew keeps working until it drains (L-35, L-36)');
    });

    it('runs the whole-Story pass once, after every chapter has been judged (§5.2, L-15a)', async () => {
        const rig = await atChapters({ story: { chapter_count: 2 } });

        await settle(rig);

        const wholeRuns = rig.store.runs.list().filter((run) => (run.work_item_ref ?? '').startsWith('wi_whole_check'));

        expect(wholeRuns).toHaveLength(1);
        expect(wholeRuns[0].role).toBe('checker');
    });
});

describe('§15 steps 10-11 — drained, then completion', () => {
    /** The Story with every chapter done and the whole-Story pass behind it. */
    async function atDrain(options: Parameters<typeof createRig>[0] = {}) {
        const rig = await createRig(options);

        await settle(rig);
        await rig.engine.lockPhase(rig.storyId, 'summary');
        seedPlotlineSet(rig.store, rig.storyId, 2);
        await settle(rig);
        await rig.engine.lockPhase(rig.storyId, 'plotlines');
        await settle(rig);

        return rig;
    }

    it('goes pending/drained after a clean Reader+checker round, and dispatches nothing (L-37, W4)', async () => {
        const rig = await atDrain({ story: { chapter_count: 2 } });

        const story = rig.story();

        expect({ status: story.status, pending_kind: story.pending_kind, dispatches: rig.liveRuns() }).toEqual({
            status: 'pending',
            pending_kind: 'drained',
            dispatches: []
        });
        expect(story.status_reason).toContain('D-35b');
        expect(story.status_reason).toContain('L-37');

        // The round L-37 condition 3 demands ran: one Reader and one checker, and it came back clean.
        expect(
            rig.store.runs.list().filter((run) => (run.work_item_ref ?? '').startsWith('wi_probe_reader_'))
        ).toHaveLength(1);
        expect(
            rig.store.runs.list().filter((run) => (run.work_item_ref ?? '').startsWith('wi_probe_checker_'))
        ).toHaveLength(1);
        expect(rig.story().probe?.status).toBe('clean');

        // A drained Story holds still: another sweep starts nothing and changes nothing.
        const report = await step(rig);

        expect({
            started: report.runs_started,
            status: report.stories[0].status,
            kind: report.stories[0].pending_kind
        }).toEqual({
            started: 0,
            status: 'pending',
            kind: 'drained'
        });
    });

    it('proposes completion — it never completes itself — and names what accepting discards (L-25, L-26, L-25b)', async () => {
        const rig = await atDrain({ story: { chapter_count: 2 } });

        const proposed = rig.story().completion;

        expect(proposed).toBeDefined();
        expect({
            phase: proposed?.phase,
            accepted: proposed?.accepted,
            leftovers: proposed?.leftovers,
            status: rig.story().status
        }).toEqual({
            phase: 'chapters',
            accepted: false,
            leftovers: { findings: 0, ideas: 0 },
            status: 'pending'
        });
        expect(rig.story().status_reason).toContain('the loop proposes completion (L-25)');
    });

    it('completes on the Author acceptance, and says so with the discard count (L-25, L-25b)', async () => {
        const rig = await atDrain({ story: { chapter_count: 2 } });

        await rig.engine.acceptCompletion(rig.storyId, true);

        const story = rig.story();

        expect({
            status: story.status,
            pending_kind: story.pending_kind,
            accepted: story.completion?.accepted,
            discarded: story.completion?.discarded
        }).toEqual({
            status: 'completed',
            pending_kind: 'none',
            accepted: true,
            discarded: 0
        });
        expect(story.status_reason).toContain('L-25b');

        // Nothing more is ever dispatched for a completed Story (L-37's last move is the Author's).
        const report = await step(rig);

        expect(report.runs_started).toBe(0);
        expect(report.stories[0].status).toBe('completed');
    });

    it('keeps the crew working when the Author refuses, and retires the probe so the round re-runs (L-30)', async () => {
        const rig = await atDrain({ story: { chapter_count: 2 } });

        await rig.engine.acceptCompletion(rig.storyId, false);

        const refused = rig.story();

        // L-30: the row survives the refusal with the count of what was thrown away, because the Author's
        // "not yet" is evidence the next sweep reads, not a reset.
        expect({
            status: refused.status,
            pending_kind: refused.pending_kind,
            accepted: refused.completion?.accepted,
            discarded: refused.completion?.discarded,
            leftovers: refused.completion?.leftovers,
            probe: refused.probe?.status
        }).toEqual({
            status: 'ready',
            pending_kind: 'none',
            accepted: false,
            discarded: 1,
            leftovers: { findings: 0, ideas: 0 },
            probe: 'idle'
        });
        expect(refused.status_reason).toContain('L-30');

        // A new round is owed before the loop may propose again (L-37: the pass must be fresh).
        const report = await step(rig);

        expect(report.stories[0].started.some((id) => id.startsWith('wi_probe_'))).toBe(true);
    });

    it('is not stalled: a Story that has run out of problems reports drained (L-37a, W7)', async () => {
        const rig = await atDrain({ story: { chapter_count: 2 }, goal: { flat_rounds: 1 } });

        const story = rig.story();

        expect(story.pending_kind).toBe('drained');
        expect(story.status_reason).not.toContain('stalled');
    });
});
