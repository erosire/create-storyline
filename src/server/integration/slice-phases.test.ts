// §15 steps 0→2: the slice's first two phases, driven through the real HTTP server.
//
// Everything asserted here is what `GET /stories`, `GET /stories/:id`, `GET /runs` and `GET /queue`
// answer over the wire, plus the rows the §8 tools actually wrote. The engine's internals are
// already pinned in `src/server/loop/*.test.ts`; this suite's job is the stack on top of them — the
// routes, the real tool catalogue, the real run executor, and a crew that only ever sees its brief.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
    bootStoryline,
    chapterStates,
    createSliceStory,
    crewRows,
    crewTemplates,
    ideaStates,
    openDial,
    plotlineOrders,
    queue,
    revisionStates,
    seedBriefFields,
    SLICE_SEED,
    storyRow,
    storyView,
    verdictTargets,
    type StorylineFixture
} from './harness';
import { seedHashOf } from '../../shared/seed-hash';
// A Story id is an opaque UUID under the per-story storage layout (D-34); this is the same pattern the
// registry validates against (`persist.ts:isStoryId`), so the test pins the contract, not a guess.
import { STORY_ID_PATTERN } from '../store';

/** Walks one Story to the end of a phase and locks it, the way §15's Author does. */
async function lockPhase(fixture: StorylineFixture, storyId: string) {
    await fixture.settle(async () => (await storyRow(fixture, storyId)).status === 'pending', 16);

    return fixture.api<Record<string, unknown>>('POST', `/stories/${storyId}/lock`);
}

describe('§15 steps 0→2: the Summary phase and the Plotlines phase, end to end', () => {
    let fixture: StorylineFixture;
    let storyId = '';
    /** The Summary sign-off's answer, kept for the step that pins what a lock says (L-7). */
    let summaryLock: { status: number; body: Record<string, unknown> } = { status: 0, body: {} };

    beforeAll(async () => {
        // A clean tray for the walk: the Ideas path is a suite of its own below, because §6.7's probe
        // round only runs while a phase still has work, which a passing phase ① does not.
        fixture = await bootStoryline({ criticIdeas: 0 });
        storyId = await createSliceStory(fixture, 3);
        await openDial(fixture, storyId);
    });

    afterAll(async () => {
        await fixture.close();
    });

    it('step 0: a fresh Story is reported as unreached work, not as a failure', async () => {
        const row = await storyRow(fixture, storyId);

        expect(row).toEqual({
            // Story ids are opaque UUIDs under the per-story layout (D-34): the row is matched by the id the
            // Story was created with, never by a pattern the test can guess.
            id: storyId,
            title: 'A nobody inherits a lighthouse that chooses its own keepe...',
            phase: 'summary',
            status: 'ready',
            pending_kind: 'none',
            status_reason: 'phase summary is open: the Seed is being expanded (L-29 stops it at the lock)',
            summary_locked: false,
            plotlines_locked: false,
            // L-14: a level the Story has not reached is `n/a`, never `0/n`.
            levels: { summary: '1/2 · failing: C-14', plotlines: 'n/a', chapters: 'n/a', whole: 'n/a' },
            trend: 'unknown',
            // The dial this test opened, read back exactly as the Story row carries it (D-35).
            auto_approve: ['critical', 'major', 'minor', 'taste'],
            active_runs: 0,
            completion_proposed: false
        });

        // The view the Story pane renders: the Seed verbatim, the Author's count, nothing produced.
        const view = await storyView(fixture, storyId);

        expect(view.story.idea).toBe(
            'A nobody inherits a lighthouse that chooses its own keeper, and the lamp has been waiting for her.'
        );
        expect(view.summary.chapter_count).toBe(3);
        expect(view.chapters).toEqual([]);
        expect(view.ideas).toEqual([]);
        expect(view.findings).toEqual([]);
        expect(view.revisions).toEqual([]);
        expect(view.completion_preview).toBeNull();
        expect(await queue(fixture)).toEqual([]);
    });

    it('step 1①: the Editor structures the Seed and the Researcher records the Knowledge it depends on (§6.4 steps 1-2)', async () => {
        // Phase ① opens with two priority-0 gates: the Editor's structure pass, then the Researcher's.
        // Nothing may be sampled until both have closed.
        await fixture.tick();
        await fixture.tick();

        const runs = await crewRows(fixture, storyId);

        // PHASE ①'s TWO GATES, exactly and in dispatch order, with the crew each one ran under.
        //
        // WHY THE SAMPLING LEG IS SPLIT FROM THEM INSTEAD OF ASSERTED AWAY: `harness.ts:tick` is one
        // `sweep()` plus the `settle()` passes the runs need, so a run that closes hands the next claim
        // to the SAME tick, and the Sampler's claim is ready the moment the second gate shuts. Replayed
        // under CPU contention, this step's two ticks close `wi_sample_summary_0_1_1` beside the
        // Researcher; idle, they close only the gates. Which of the two a machine buys is the loop's
        // dispatch decision — the row-for-row ledger is the next step's subject — so the leg is admitted
        // by CLAIM AND CREW, and anything that JUDGES or SIGNS OFF (a Screening, Review or escalation
        // claim, or a sampler row under another crew) is still the drift this step exists to catch.
        const claimOf = (run: Record<string, any>): string =>
            `${String(run.work_item_ref)}[${String(run.template_ref)}/${String(run.role)}]=${String(run.state)}`;
        const isGateRow = (run: Record<string, any>): boolean =>
            String(run.work_item_ref).startsWith('wi_structure_seed_') ||
            String(run.work_item_ref).startsWith('wi_research_');
        const isSamplerRow = (run: Record<string, any>): boolean =>
            /^wi_sample_[^[]*$/.test(String(run.work_item_ref)) &&
            run.template_ref === 'writer-summary-sampler' &&
            run.role === 'writer' &&
            run.state === 'torn_down';

        const gates = runs.filter(isGateRow);
        const leg = runs.filter((run) => !isGateRow(run));

        expect(gates.map(claimOf)).toEqual([
            `wi_structure_seed_${seedHashOf(SLICE_SEED)}[editor-seed-structure/editor]=torn_down`,
            'wi_research_1[researcher-story/researcher]=torn_down'
        ]);

        // The kind/no_op maps cover the gates exactly and the leg with the same rule: every row the
        // coordinator closed at this step is a real `work` row, never a `no_op` — the expected arrays are
        // built at the length the loop reached, because that length is the dispatch decision above.
        expect(gates.map((run) => run.kind)).toEqual(['work', 'work']);
        expect(gates.map((run) => run.no_op)).toEqual([false, false]);
        expect(leg.map((run) => [run.kind, run.no_op])).toEqual(leg.map(() => ['work', false]));
        expect(leg.filter((run) => !isSamplerRow(run))).toEqual([]);

        // §3.3: the Editor wrote an ACCEPTED brief derived from the current Seed. Its fields are a
        // pure function of the Seed, and the Seed itself was never touched (P5).
        const brief = fixture.store.seedBriefs.list()[0];

        expect({
            story_id: brief.story_id,
            seed_hash: brief.seed_hash,
            status: brief.status,
            ...seedBriefFields(SLICE_SEED)
        }).toEqual({
            story_id: storyId,
            seed_hash: seedHashOf(SLICE_SEED),
            status: 'accepted',
            ...seedBriefFields(SLICE_SEED)
        });

        // §3.2: one `critical` and one `high` claim, each with a source — the two importances the
        // sampling prompt carries (§5).
        expect(
            fixture.store.knowledge
                .list()
                .map((entry) => `${entry.topic}:${entry.importance}:${entry.sources.length}`)
        ).toEqual(['period and place:critical:1', 'governing rule:high:1']);

        // Both gates are closed and NOTHING HAS BEEN CHOSEN OR JUDGED. A round-1 sample row may already
        // be on the book — the leg the step above admits — so the claim is about the two things that
        // cannot happen yet: a `selected` draft (§6.5 needs the round's screening sets) and a verdict at
        // any scope (only the tool-using deep review files one).
        expect(revisionStates(fixture.store, storyId).filter((row) => row.endsWith('/selected'))).toEqual([]);
        expect(verdictTargets(fixture.store, storyId)).toEqual([]);

        const row = await storyRow(fixture, storyId);

        expect(row.levels.summary).toBe('1/2 · failing: C-14');
        expect(row.phase).toBe('summary');
        // The tool layer refused nothing in phase ①: a crew that calls §8 correctly is not punished.
        expect(fixture.refusals).toEqual([]);
    });

    it('step 1①: three no-tool samples, one screening pass each, and the engine installs the least-issue winner (§6.4 steps 3-5)', async () => {
        // Four more sweeps: three samplers (one per sweep), a screening pass per sample, and the
        // engine's selection once every sample has its full screening set.
        for (let sweep = 0; sweep < 4; sweep += 1) await fixture.tick();

        const refs = (await crewRows(fixture, storyId)).map((run) => `${run.work_item_ref}[${run.template_ref}]`);

        expect(refs.filter((ref) => ref.startsWith('wi_sample_')).sort()).toEqual([
            'wi_sample_summary_0_1_1[writer-summary-sampler]',
            'wi_sample_summary_0_1_2[writer-summary-sampler]',
            'wi_sample_summary_0_1_3[writer-summary-sampler]'
        ]);
        expect(refs.filter((ref) => ref.startsWith('wi_screen_')).sort()).toEqual([
            'wi_screen_revision_0_1[critic-screening]',
            'wi_screen_revision_1_1[critic-screening]',
            'wi_screen_revision_2_1[critic-screening]'
        ]);
        // There is no Editor `select` in phase ① any more: the selector is deterministic (§6.5).
        expect(refs.filter((ref) => ref.startsWith('wi_select_'))).toEqual([]);

        // One sample survives as `selected`; the losers and their screening reviews are truncated
        // (P13/D-22 as the pipeline asks). The `sampling_history` line is the only surviving audit.
        expect(revisionStates(fixture.store, storyId)).toEqual(['revision_0:summary_0/selected']);

        const summary = (await storyView(fixture, storyId)).summary;

        expect({
            premise: summary.premise,
            promise: summary.promise,
            theme: summary.theme,
            tone: summary.tone,
            ending: summary.ending,
            world_rules: summary.world_rules,
            chapter_count: summary.chapter_count,
            locked: summary.locked
        }).toEqual({
            premise: `sample 1: ${SLICE_SEED}`,
            promise: 'sample 1 pays the promise the Seed makes',
            theme: 'sample 1 theme',
            tone: 'sample 1 tone',
            ending: 'sample 1 ending',
            world_rules: 'sample 1 world rules',
            chapter_count: 3,
            locked: false
        });

        const story = fixture.store.stories.require(storyId);

        expect(story.sampling_round).toBe(1);
        expect((story.sampling_history ?? []).map(({ round, samples, selected }) => ({ round, samples, selected }))).toEqual([
            {
                round: 1,
                // H2 — the audit names each candidate's OUTCOME, because this line is the only surviving
                // record once P13 truncates the losers: `accepted` for the installed draft, `eligible` for
                // the two it beat on §6.5's ranking (clean counts, no fixes demanded — a first round has
                // nothing to regress against, so it carries no origin split and no minimality numbers).
                samples: [
                    { revision_id: 'revision_0', critical: 0, high: 0, valid: true, unresolved_fixes: [], outcome: 'accepted' },
                    { revision_id: 'revision_1', critical: 0, high: 0, valid: true, unresolved_fixes: [], outcome: 'eligible' },
                    { revision_id: 'revision_2', critical: 0, high: 0, valid: true, unresolved_fixes: [], outcome: 'eligible' }
                ],
                selected: 'revision_0'
            }
        ]);

        // The Goal's C-14 line is never the Sampler's: a no-tool sample files no verdict, so the line
        // belongs to the tool-using deep review, and that claim only opens once a draft is installed.
        // Whether THIS step finds the loop on one side of that line or the other is the loop's dispatch
        // decision — `harness.ts:tick` settles every run a sweep opens, so under load the review pass
        // tears down inside the sweep that installed the winner, and idle it lands in the next step — so
        // each side is pinned to the row that causes it:
        //   * no verdict yet      → the Goal still fails C-14, and nothing has been judged at any scope;
        //   * the review's verdict→ CS-VERDICT-1b (`criteria/engine.ts:summaryDraftEvidenceRefs`, built
        //     from `selectedSummaryDraftId`) reads the SELECTED draft's verdict as the Summary row's own
        //     evidence, which is what closes C-14 and takes the Goal to 2/2.
        // The exact verdict rows are pinned with the level, so a pass that closed the Goal on some other
        // evidence fails here rather than looking green.
        const targets = verdictTargets(fixture.store, storyId);
        const judged = targets.length > 0;

        expect((await storyRow(fixture, storyId)).levels.summary).toBe(judged ? '2/2' : '1/2 · failing: C-14');
        expect(targets).toEqual(judged ? [{ id: 'verdict_0', target: 'summary_0', recommendation: 'advance' }] : []);
    });

    it('step 1①: the deep review rates the selected revision, and a passing Goal stops the Story at the signoff (D-1, L-29)', async () => {
        // The selected revision gets the tool-using Critic pass (§6.4 step 6); its verdict is the
        // C-14 line, and the phase then stops at the Author's lock.
        await fixture.settle(async () => (await storyRow(fixture, storyId)).pending_kind === 'phase_signoff', 8);

        const runs = await crewRows(fixture, storyId);

        expect(runs.map((run) => `${run.work_item_ref}[${run.template_ref}/${run.role}]=${run.state}`)).toEqual([
            `wi_structure_seed_${seedHashOf(SLICE_SEED)}[editor-seed-structure/editor]=torn_down`,
            'wi_research_1[researcher-story/researcher]=torn_down',
            'wi_sample_summary_0_1_1[writer-summary-sampler/writer]=torn_down',
            'wi_sample_summary_0_1_2[writer-summary-sampler/writer]=torn_down',
            'wi_screen_revision_0_1[critic-screening/critic]=torn_down',
            'wi_sample_summary_0_1_3[writer-summary-sampler/writer]=torn_down',
            'wi_screen_revision_1_1[critic-screening/critic]=torn_down',
            'wi_screen_revision_2_1[critic-screening/critic]=torn_down',
            'wi_review_revision_0_a1[critic-genre/critic]=torn_down'
        ]);

        // The deep review rates the Summary row, which is where the criteria engine aggregates C-14.
        expect(verdictTargets(fixture.store, storyId)).toEqual([
            { id: 'verdict_0', target: 'summary_0', recommendation: 'advance' }
        ]);

        expect({ ...(await storyRow(fixture, storyId)), title: undefined, progress: undefined }).toEqual({
            id: storyId,
            title: undefined,
            phase: 'summary',
            status: 'pending',
            pending_kind: 'phase_signoff',
            status_reason:
                "phase summary's Goal passes (2/2) · the Summary awaits your lock · the Ideas tray is empty · the crew is stopped until you act (L-29)",
            summary_locked: false,
            plotlines_locked: false,
            levels: { summary: '2/2', plotlines: 'n/a', chapters: 'n/a', whole: 'n/a' },
            trend: 'unknown',
            progress: undefined,
            blocked_on: 'the Summary',
            auto_approve: ['critical', 'major', 'minor', 'taste'],
            active_runs: 0,
            completion_proposed: false
        });

        // Nothing moved on its own: the stop opened no further run, and the phase is untouched.
        expect((await crewRows(fixture, storyId)).length).toBe(9);
    });

    it("step 2: the lock is the Author's, and it is what opens phase ② (L-7, U-16)", async () => {
        summaryLock = await fixture.api<Record<string, unknown>>('POST', `/stories/${storyId}/lock`);

        expect(summaryLock.status).toBe(200);
        expect({
            phase: summaryLock.body.phase,
            status: summaryLock.body.status,
            summary_locked: summaryLock.body.summary_locked
        }).toEqual({
            phase: 'plotlines',
            status: 'ready',
            summary_locked: true
        });
        expect(summaryLock.body.status_reason).toMatch(
            /^phase summary locked by the Author at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z; phase plotlines is open \(L-7\)$/
        );
    });

    it('step 2: the loop dispatches the Plotlines Writer and reaches exactly `chapter_count` contracts', async () => {
        await fixture.settle(async () => (await plotlineOrders(fixture.store, storyId)).length === 3, 8);

        expect(await crewTemplates(fixture, storyId)).toContain('writer-plotlines');
        expect(plotlineOrders(fixture.store, storyId).map((row) => `${row.id}:${row.order}:${row.heading}`)).toEqual([
            'plotline_0:1:The 1th gallery',
            'plotline_1:2:The 2th gallery',
            'plotline_2:3:The 3th gallery'
        ]);

        const row = await storyRow(fixture, storyId);

        expect({
            phase: row.phase,
            status: row.status,
            summary_locked: row.summary_locked,
            plotlines_locked: row.plotlines_locked
        }).toEqual({
            phase: 'plotlines',
            status: 'ready',
            summary_locked: true,
            plotlines_locked: false
        });
    });

    it('step 2: C-0 is the count, and the set-level criteria are filed at the Story row (Fix A)', async () => {
        await fixture.settle(async () => (await storyRow(fixture, storyId)).levels.plotlines === '7/7', 16);

        const row = await storyRow(fixture, storyId);

        expect(row.levels).toEqual({ summary: '2/2', plotlines: '7/7', chapters: 'n/a', whole: 'n/a' });
        expect(row.phase).toBe('plotlines');

        // The criteria the engine aggregates over the Story row (`criteria/engine.ts:scopeTargets`)
        // only reach that level because the tool layer lets a verdict be filed there at all.
        const targets = verdictTargets(fixture.store, storyId);

        expect(targets.some((verdict) => verdict.target === storyId)).toBe(true);
        expect(targets.some((verdict) => verdict.target.startsWith('plotline_'))).toBe(true);

        // The races this phase produced are real refusals the crews recovered from, not silent writes:
        // `createPlotline`'s CAS rides on the Story row (writer.ts), so a concurrent attempt is refused
        // (T-4) or told which row already owns the order (T-11), and the crew re-applies (T-8).
        expect([
            ...new Set(fixture.refusals.map((refusal) => `${refusal.template}/${refusal.tool}/${refusal.rule}`))
        ]).toEqual(['writer-plotlines/createPlotline/T-4', 'writer-plotlines/createPlotline/T-11']);
    });

    it('step 2: the Plotlines lock opens phase ③ and the chapter set appears (D-3c)', async () => {
        const lock = await lockPhase(fixture, storyId);

        expect(lock.status).toBe(200);
        expect({ phase: lock.body.phase, plotlines_locked: lock.body.plotlines_locked }).toEqual({
            phase: 'chapters',
            plotlines_locked: true
        });
        expect(lock.body.status_reason).toMatch(
            /^phase plotlines locked by the Author at .*; phase chapters is open \(L-7\)$/
        );

        // The chapter set is the Author's declared count, materialised by the lock — not the Writer's.
        //
        // THE BOUNDARY: the lock's own row, read behind `quiesce()` — no in-flight run and no live run
        // row anywhere in the workspace. This step asserts what the LOCK produced before any crew has
        // touched phase ③, so the snapshot has to be taken while the desk is empty; read while a Writer
        // holds it, the same fields answer with the work in progress. With the workspace's sweep timer
        // pinned off (`harness.ts:bootStoryline`) nothing can move this row between the lock and the read
        // either — reaching `chapters: '3/3'` here was the scheduler running phase ③ on its own clock
        // while the step believed the test owned the clock.
        await fixture.quiesce();

        expect(chapterStates(fixture.store, storyId).map((chapter) => `${chapter.id}:${chapter.order}`)).toEqual([
            'chapter_0:1',
            'chapter_1:2',
            'chapter_2:3'
        ]);

        const row = await storyRow(fixture, storyId);

        // Every chapter exists and none has prose, so the chapter level and the whole-Story level are
        // both open at 0/n with the criteria the empty book fails (L-14: reached, not `n/a`).
        expect(row.levels).toEqual({
            summary: '2/2',
            plotlines: '7/7',
            chapters: '0/3 · failing: C-7, C-8, C-9',
            whole: '0/3 · failing: C-10, C-11, C-13'
        });
        // The desk is empty at this boundary, which is the whole point of the barrier above: `active_runs`
        // is the projection's own count of live run rows, so the level strings pinned here are the LOCK's
        // answer with no crew on the desk, not a snapshot of phase ③'s work in progress.
        expect(row.active_runs).toBe(0);
    });

    it("the queue stays the Author's lane: no crew artifact leaked into it", async () => {
        expect(await queue(fixture)).toEqual([]);
        expect(ideaStates(fixture.store, storyId)).toEqual([]);
    });
});

describe("§15 step 1: the Ideas tray is the Author's, and it gates the lock (L-7a, D-27)", () => {
    let fixture: StorylineFixture;
    let storyId = '';

    beforeAll(async () => {
        // The Goal must stay open long enough for a drain round to run at all: §6.7 probes a phase that
        // is still working, and phase ① stops the crew the moment its Goal passes (L-29). Withholding
        // C-14 is what makes step 1's "the Critic files Ideas during ①" reachable.
        fixture = await bootStoryline({ failCriteria: ['C-14'], criticIdeas: 2 });
        storyId = await createSliceStory(fixture, 3);
        await openDial(fixture, storyId);

        await fixture.settle(async () => (await queue(fixture)).some((item) => item.kind === 'idea'), 12);
    });

    afterAll(async () => {
        await fixture.close();
    });

    it("the probe round files Ideas that sit in the tray as the Author's decision (D-26, U-15)", async () => {
        // THE BOUNDARY: `proposed` is the tray's state BEFORE the loop's verification job has run, and the
        // sweep further down this very step is what launches that job. So the snapshot must be taken with
        // the workspace quiet — `quiesce()` waits for the probe round's runs and the settlement commits
        // chained behind them, and refuses to return while any book still carries a live run row. Read at
        // any other moment these same two rows answer `verified`, which is the SECOND half of this step
        // (pinned below) and not the state this half names — and the explicit sweep's `started` list would
        // then name a claim the scheduler had already given away.
        await fixture.quiesce();

        expect(ideaStates(fixture.store, storyId)).toEqual([
            { id: 'idea_0', state: 'proposed', kind: 'possibility' },
            { id: 'idea_1', state: 'proposed', kind: 'possibility' }
        ]);

        const items = await queue(fixture);

        expect(items.map((item) => `${item.kind}:${item.id}`).sort()).toEqual(['idea:idea_0', 'idea:idea_1']);
        expect(items[0]).toMatchObject({
            kind: 'idea',
            story_id: storyId,
            title: 'Probe Idea 1: the 1st crossing should cost the keeper her sister, not a name.',
            detail: 'possibility · phase summary'
        });

        // D-27, first half: while the verdict is missing the route refuses the pick and names the "I
        // know" escape hatch. Pinned HERE, before the sweep below, because the refusal is the live state
        // of the row rather than a mock of it.
        const blocked = await fixture.api<{ error?: string }>('POST', `/stories/${storyId}/ideas/idea_0/select`, {
            note: ''
        });

        expect(blocked.status).toBe(409);
        expect(blocked.body.error).toBe(
            'Idea idea_0 cites sources the Editor has not verified — pick it with a note, or that is the explicit "I know" this Idea has not earned (D-27, C-15).'
        );

        // D-27, second half: the tray is the Author's, but the VERIFICATION of a sourced Idea is the
        // Editor's job, and an unverified sourced Idea is loop work — not an Author action. So the drained
        // Story no longer holds this job back (D-35b's "stop while the Author has the desk" is about
        // buying more of the same drafting work; it must not strand a fact-check the Author's own pick
        // depends on). The sweep launches it, and C-15's line can actually clear itself.
        const report = await fixture.handle.engine.sweep();

        expect(report.stories[0]?.started).toEqual(['wi_verify_ideas_1_2_idea_0']);
        expect(report.stories[0]?.deferred).toEqual({});
        expect({ status: report.stories[0]?.status, pending: report.stories[0]?.pending_kind }).toEqual({
            status: 'ready',
            pending: 'none'
        });
        expect(report.stories[0]?.status_reason).toBe('1/2 · failing: C-14');

        // The verify job is a run this process started, so the barrier drains it AND its settlement
        // commits, and then proves no run row is still live, before the tray is read as `verified` — the
        // Editor's answer on the row is the run's own commit, so a tray read taken while the run was
        // still open would be a read of half an answer.
        await fixture.quiesce();

        // The Editor answered both Ideas from the one job, and the Author has still been asked for
        // nothing. §4.17's `verified` is the Editor's fact-check; the AUTHOR's decision is `selected`
        // (D-29), and that is a later test's job. C-15 refuses a verdict with no `checked_by_run`, so
        // the run id on the row is the proof the answer came from a real Editor run (D-31).
        expect(ideaStates(fixture.store, storyId)).toEqual([
            { id: 'idea_0', state: 'verified', kind: 'possibility' },
            { id: 'idea_1', state: 'verified', kind: 'possibility' }
        ]);
        expect(fixture.store.ideas.require('idea_0').verification).toMatchObject({
            verdict: 'verified',
            meets_guidelines: true
        });
        expect(/^run_\d+$/.test(fixture.store.ideas.require('idea_0').verification?.checked_by_run ?? '')).toBe(true);
    });

    it('the lock still refuses while the Editor-verified Ideas are undecided — the tray, not the Goal, answers (L-7a, U-15, U-16)', async () => {
        const { status, body } = await fixture.api<{ error?: string }>('POST', `/stories/${storyId}/lock`);

        expect(status).toBe(409);
        // L-7a / U-15: the tray is every Idea of the phase the AUTHOR has not decided. D-27's verification
        // moves a row to `verified`, but a verified row is the Editor's answer to "is the claim true?",
        // never the Author's pick (T-3b, D-29), so these two Ideas are still in the tray and the lock is
        // refused on the tray — with the Goal ALSO still failing, the tray sentence wins because the tray
        // is the gate the Author has to clear first (routes.ts defers its U-16 Goal check when the tray is
        // non-empty, so the engine's own L-7a copy is what the Author reads).
        expect(body.error).toBe(
            'cannot lock summary: 2 Ideas still in the tray — each must be selected, discarded, or deferred first (L-7a, D-29)'
        );
    });

    it('the earned pick needs no "I know" — the loop already did the verification (D-27, D-29)', async () => {
        // The Author's note was the override for a missing verdict (pinned above). With the Editor's
        // answer on the row, the pick goes through and C-15 has nothing to complain about: the selected
        // Idea carries a verified verdict with evidence and a checking run.
        const picked = await fixture.api<Record<string, unknown>>('POST', `/stories/${storyId}/ideas/idea_0/select`, {
            note: 'The lamp log idea is mine; take it.'
        });

        expect(picked.status).toBe(200);
        expect(fixture.store.ideas.require('idea_0').selection_note).toBe('The lamp log idea is mine; take it.');

        const discarded = await fixture.api('POST', `/stories/${storyId}/ideas/idea_1/discard`, {});

        expect(discarded.status).toBe(200);
        expect(await queue(fixture)).toEqual([]);
        expect(ideaStates(fixture.store, storyId)).toEqual([
            { id: 'idea_0', state: 'selected', kind: 'possibility' },
            { id: 'idea_1', state: 'discarded', kind: 'possibility' }
        ]);

        // C-15 passes: the selection is backed by the Editor's verdict, so the criterion the old flow
        // would have failed here is now green, and C-14 is the only thing holding the phase open.
        const row = await storyRow(fixture, storyId);

        expect({ status: row.status, pending: row.pending_kind, levels: row.levels.summary }).toEqual({
            status: 'ready',
            pending: 'none',
            levels: '1/2 · failing: C-14'
        });
    });

    it('with the tray empty, the phase Goal is the remaining gate — and C-15 is NOT one of the failures (U-16, D-27)', async () => {
        const { status, body } = await fixture.api<{ error?: string }>('POST', `/stories/${storyId}/lock`);

        expect(status).toBe(409);
        // L-7a's gate is RELEASED here: every row of the tray has an Author decision (selected +
        // discarded), so the refusal is no longer the tray's sentence — it is the Goal's. The sentence
        // CHANGING is the pin: the same request that named the tray a step ago now names C-14, and the
        // lock goes through as soon as the Goal passes (the next two steps).
        //
        // D-27, seen from the Goal: the Idea reached the artifact WITH the Editor's verdict, so the
        // criterion the pre-fix flow tripped on is silent and the withheld C-14 stands alone.
        expect(body.error).toBe(
            'cannot lock phase summary: its Goal is not met — 1/2 · failing: C-14 (U-16: lock only a phase whose Goal passes)'
        );
    });

    it("the Goal is the Author's to change (U-14b), and the sign-off then says the tray is empty", async () => {
        // Only ONE criterion still holds this phase open: the withheld C-14. C-15 is green because the
        // Idea reached the artifact with the Editor's verdict behind it (D-27), so the Author retires the
        // one criterion they own the decision about — and the earned C-15 stays in the Goal (U-14b).
        const { status, body } = await fixture.api<{ goal?: { criteria?: Array<{ id: string }> } }>(
            'PATCH',
            `/stories/${storyId}/goal`,
            {
                criteria: [{ op: 'remove', id: 'C-14' }]
            }
        );

        expect(status).toBe(200);
        // The route answers with the whole Goal it now holds, every level's criteria in order. C-0 is
        // still there and C-14 is gone: the patch retires ONE criterion, it does not rebuild the Goal.
        expect(body.goal?.criteria?.map((criterion) => criterion.id)).toEqual([
            'C-0',
            'C-1',
            'C-2',
            'C-3',
            'C-4',
            'C-5',
            'C-6',
            'C-7',
            'C-8',
            'C-9',
            'C-10',
            'C-11',
            'C-12',
            'C-13',
            'C-15'
        ]);

        // Phase ① now has Critic passes and an Editor choice in front of the sign-off, so the
        // walk to the stop needs more sweeps than the Writer-to-Editor shortcut did.
        await fixture.settle(async () => (await storyRow(fixture, storyId)).pending_kind === 'phase_signoff', 20);

        const row = await storyRow(fixture, storyId);

        expect({
            status: row.status,
            pending: row.pending_kind,
            reason: row.status_reason,
            levels: row.levels
        }).toEqual({
            status: 'pending',
            pending: 'phase_signoff',
            reason: "phase summary's Goal passes (1/1) · the Summary awaits your lock · the Ideas tray is empty · the crew is stopped until you act (L-29)",
            levels: { summary: '1/1', plotlines: 'n/a', chapters: 'n/a', whole: 'n/a' }
        });
    });

    it('the lock then commits the phase, and nothing is left proposed in the tray (L-7, D-36)', async () => {
        const { status, body } = await fixture.api<Record<string, unknown>>('POST', `/stories/${storyId}/lock`);

        expect(status).toBe(200);
        expect({ phase: body.phase, status: body.status, summary_locked: body.summary_locked }).toEqual({
            phase: 'plotlines',
            status: 'ready',
            summary_locked: true
        });
        expect(body.status_reason).toMatch(
            /^phase summary locked by the Author at \d{4}-\d{2}-\d{2}T.*; phase plotlines is open \(L-7\)$/
        );

        // D-36: the lock commit clears this phase's tray rows — L-17's "the tray empties on lock". The
        // decisions were taken first (selected + discarded above), so what the lock hands the next phase
        // is an empty desk, not a carried-over queue: no row, no queue item.
        expect(ideaStates(fixture.store, storyId)).toEqual([]);
        expect(((await storyView(fixture, storyId)).ideas as unknown[]).length).toBe(0);
        expect(await queue(fixture)).toEqual([]);
    });

    it("the queue is the Author's desk across every Story at once, oldest first (U-15, U-10)", async () => {
        // A second Story in the same boot, walked to its own tray: the desk is one list, not one per
        // Story, and the Author reads it top-down (§10.2 U-10's one-list rule).
        const second = await createSliceStory(fixture, 3);

        // A UUID, not a counter: each Story is a book, and books do not know each other's names (D-34).
        expect(second).toMatch(STORY_ID_PATTERN);
        expect(second).not.toBe(storyId);

        await fixture.settle(
            async () => (await queue(fixture)).filter((item) => item.story_id === second).length > 0,
            16
        );

        const items = await queue(fixture);

        // Story 2's own contribution to the desk, exactly: the two Ideas its probe round filed. The ids are
        // STORY-LOCAL — each book mints its own counters from 0 (`Store.newStory` clears `#nextIds`), so the
        // second Story's Ideas are `idea_0`/`idea_1`, not the continuation the old shared-store layout gave.
        expect(items.filter((item) => item.story_id === second).map((item) => `${item.kind}:${item.id}`)).toEqual([
            'idea:idea_0',
            'idea:idea_1'
        ]);

        // The list is one desk, not two: every entry names its Story, and it is ordered oldest first.
        expect(items.map((item) => item.created_at)).toEqual(
            [...items.map((item) => item.created_at)].sort((left, right) => (left < right ? -1 : 1))
        );
        expect(
            items.every(
                (item) =>
                    typeof item.title === 'string' && item.title.length > 0 && typeof item.story_title === 'string'
            )
        ).toBe(true);
        expect(items.length).toBeGreaterThanOrEqual(1);
    });
});
