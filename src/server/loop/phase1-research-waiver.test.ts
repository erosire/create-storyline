// D-51 — phase ①'s RESEARCH WAIVER and the empty research report, on the loop rig.
//
// What this file pins, and why each row is the interesting one:
//
//   R1b  a Seed Brief whose `research_questions` list is EMPTY generates NO research Work Item, the
//        sampling gate treats the pass as satisfied, and the drain probe never asks for a pass that
//        was never owed. The claim key (`wi_research_<rev>`) is the gate's whole mechanism, so "no
//        candidate" and "no run row" are the same fact seen twice — both are asserted.
//   R1c  a non-empty list still gates sampling, and the Editor's QUESTIONS reach the dispatched
//        Researcher through the job note (`work.ts` → `brief.ts:renderJob`), which is the only reason
//        the pass is scoped to the book instead of to the whole setting.
//   R1a  a brief that PREDATES the field (no property at all) is read as `needed`, never as waived:
//        an upgrade must not silently cancel a pass an existing Story was owed.
//   R1d  a pass that WAS dispatched and concludes "nothing needs research" closes the gate with a
//        REPORT — zero Knowledge rows, the run is `torn_down` with `no_op: false` (S-4), and the next
//        job is the sample rather than a second Researcher inventing a topic to justify the first.
//
// The one predicate all four rows read is `records.ts:researchGate`; this file asserts through it as
// well as through the generated work, because gate/drain/generation disagreeing is the failure mode.
import { describe, expect, it } from 'vitest';

import { createRig } from './mock';
import { researchGate, researchKeyOf } from './records';
import { drainPreconditions } from './status';
import { generateWork } from './work';
import { seedHashOf } from '../../shared/seed-hash';
import type { Rig } from './mock';
import type { SeedBrief } from '../../shared/types';

/** §6.7: the drain reason `status.ts:phase1Unmet` prints when a research pass is still owed. */
const RESEARCH_UNMET =
    'the Seed Brief has no closed research pass — the Researcher has not recorded the Knowledge it depends on (§6.4 step 2)';

/** Every run row as `claim key:state`, oldest first — the dispatch order the sweep produced. */
function runs(rig: Rig, prefix = ''): string[] {
    return rig.store.runs
        .list()
        .filter((run) => (run.work_item_ref ?? '').startsWith(prefix))
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((run) => `${run.work_item_ref ?? run.id}:${run.state}`);
}

/** The claim keys the sweep would generate RIGHT NOW, in generation order. */
function keys(rig: Rig): string[] {
    return generateWork(rig.store, rig.store.stories.require(rig.storyId), {
        at: new Date().toISOString(),
        phase: 'summary'
    }).map((candidate) => candidate.key);
}

/** The candidates themselves, when a test has to read the NOTE the dispatched run will be given. */
function candidates(rig: Rig) {
    return generateWork(rig.store, rig.store.stories.require(rig.storyId), {
        at: new Date().toISOString(),
        phase: 'summary'
    });
}

/** The rig's Seed Brief, failing loudly rather than reading a `undefined` field as a waiver. */
function briefOf(rig: Rig): SeedBrief {
    const brief = rig.store.seedBriefs.list()[0];

    if (brief === undefined) throw new Error('the rig has no Seed Brief row');

    return brief;
}

describe('D-51 — the research waiver: an empty `research_questions` list closes phase ①\u2019s second gate', () => {
    it('dispatches no Researcher at all for a waived brief, and samples without waiting (R1b)', async () => {
        // `seedStructured: false` so the waiver is WRITTEN by the Editor's run (the scripted
        // structureSeed call carries `research_questions: []`) rather than seeded by the rig.
        const rig = await createRig({
            seedStructured: false,
            summarySampling: 1,
            summaryReaders: 1,
            crew: { researchQuestions: [] }
        });
        const story = rig.story();

        // Gate 1 is untouched: structuring is still the only job until the brief exists.
        expect(keys(rig)).toEqual([`wi_structure_seed_${seedHashOf(story.idea)}`]);
        expect((await rig.step()).stories[0].started).toEqual([`wi_structure_seed_${seedHashOf(story.idea)}`]);

        const brief = briefOf(rig);

        // The waiver is ON THE RECORD as an empty array, not as an absent field — the distinction is
        // what separates "the Editor decided" from "the row predates the field".
        expect(brief.research_questions).toEqual([]);
        expect(researchGate(rig.store, rig.store.stories.require(rig.storyId), brief)).toBe('waived');
        // The key the pass WOULD have owned. Asserting it is what makes the next two rows meaningful:
        // the gate is satisfied by absence, not by a row that happens to exist.
        expect(researchKeyOf(brief)).toBe('wi_research_1');

        // Gate 2 generates NOTHING, so the very next job is the first sample (R1b).
        expect(keys(rig)).toEqual(['wi_sample_summary_0_1_1']);
        // …and nothing research-shaped was ever written: no run row, for any revision.
        expect(runs(rig, 'wi_research')).toEqual([]);

        // §6.7: the drain probe reads the SAME gate, so a waived Story is not held open by a pass that
        // was never owed. Its sampling clause may still speak — that is a different stage.
        const unmet = drainPreconditions(rig.store, rig.store.stories.require(rig.storyId)).unmet;

        expect(unmet).not.toContain(RESEARCH_UNMET);

        // The sample really does run on the waived brief: the gate was never going to block it.
        expect((await rig.step()).stories[0].started).toEqual(['wi_sample_summary_0_1_1']);
    });

    it('starts a waived Story straight at sampling when the rig seeds the closed state (R1b, seeded)', async () => {
        // The other half of the same rule: the rig's SEEDED phase ① honours the waiver too, by
        // leaving the research run out entirely rather than faking a closed one.
        const rig = await createRig({ summarySampling: 1, summaryReaders: 1, crew: { researchQuestions: [] } });

        expect(briefOf(rig).research_questions).toEqual([]);
        expect(runs(rig, 'wi_research')).toEqual([]);
        expect(keys(rig)).toEqual(['wi_sample_summary_0_1_1']);
    });

    it('still gates sampling on a listed question, and hands the Researcher the Editor\u2019s questions (R1c)', async () => {
        const question = 'What did the 1911 survey map actually measure?';
        const rig = await createRig({
            seedStructured: false,
            summarySampling: 1,
            summaryReaders: 1,
            crew: { researchQuestions: [question] }
        });

        expect((await rig.step()).stories[0].started).toEqual([
            `wi_structure_seed_${seedHashOf(rig.story().idea)}`
        ]);

        const built = candidates(rig);

        expect(built.map((candidate) => candidate.key)).toEqual(['wi_research_1']);
        expect({
            kind: built[0].item.kind,
            roleName: built[0].item.roleName,
            templateRef: built[0].item.templateRef,
            priority: built[0].priority
        }).toEqual({ kind: 'research', roleName: 'researcher', templateRef: 'researcher-story', priority: 0 });

        // The questions ride in the note because the job briefing renders it (`brief.ts:renderJob`);
        // an unscoped Researcher surveys the whole setting, and D-51 exists to stop paying for that.
        const note = built[0].item.note ?? '';

        expect(note).toContain(`The Editor's research questions for this brief (1): "${question}"`);
        expect(note).toContain('close the pass with reportNoResearch');
        // The report sentence comes FIRST: the briefing clips the note at 600 chars, and the questions
        // are the variable-length part, so an agent that never reaches the list still knows how to end.
        expect(note.indexOf('reportNoResearch')).toBeLessThan(note.indexOf('The Editor'));

        // Sampling still waits, and the drain probe still asks for the pass.
        expect(keys(rig)).toEqual(['wi_research_1']);
        expect(drainPreconditions(rig.store, rig.store.stories.require(rig.storyId)).unmet).toContain(RESEARCH_UNMET);

        // The default scripted Researcher writes Knowledge, the pass closes, and the sample is next.
        expect((await rig.step()).stories[0].started).toEqual(['wi_research_1']);
        expect(researchGate(rig.store, rig.store.stories.require(rig.storyId), briefOf(rig))).toBe('closed');
        expect(keys(rig)).toEqual(['wi_sample_summary_0_1_1']);
        expect(runs(rig, 'wi_research')).toEqual(['wi_research_1:torn_down']);
    });

    it('reads a brief that predates the field as NEEDED, never as waived (R1a, compatibility)', async () => {
        // No `crew.researchQuestions` at all: the scripted structureSeed call sends the pre-D-51 arg
        // list, and the row that lands has NO `research_questions` property.
        const rig = await createRig({ seedStructured: false, summarySampling: 1, summaryReaders: 1 });

        expect((await rig.step()).stories[0].started).toEqual([
            `wi_structure_seed_${seedHashOf(rig.story().idea)}`
        ]);

        const brief = briefOf(rig);

        expect(Object.prototype.hasOwnProperty.call(brief, 'research_questions')).toBe(false);

        const story = rig.store.stories.require(rig.storyId);

        expect(researchGate(rig.store, story, brief)).toBe('needed');
        expect(keys(rig)).toEqual(['wi_research_1']);
        expect(drainPreconditions(rig.store, story).unmet).toContain(RESEARCH_UNMET);

        // A legacy brief names no questions, so the job says so instead of inventing a scope.
        expect(candidates(rig)[0].item.note ?? '').toContain('(the brief predates the research_questions field');

        expect((await rig.step()).stories[0].started).toEqual(['wi_research_1']);
        expect(researchGate(rig.store, rig.store.stories.require(rig.storyId), briefOf(rig))).toBe('closed');
        expect(keys(rig)).toEqual(['wi_sample_summary_0_1_1']);
    });

    it('closes the gate on a report of "nothing needs research", with no Knowledge and no re-dispatch (R1d)', async () => {
        const rig = await createRig({
            seedStructured: false,
            summarySampling: 1,
            summaryReaders: 1,
            crew: {
                researchQuestions: ['What did the 1911 survey map actually measure?'],
                // The pass WAS dispatched, and it answers `reportNoResearch` instead of writing.
                researchCalls: 'report'
            }
        });

        expect((await rig.step()).stories[0].started).toEqual([
            `wi_structure_seed_${seedHashOf(rig.story().idea)}`
        ]);
        expect((await rig.step()).stories[0].started).toEqual(['wi_research_1']);

        const researchRun = rig.store.runs.list().find((run) => run.work_item_ref === 'wi_research_1');

        if (researchRun === undefined) throw new Error('the research run has no row');

        // S-4: a report that writes NOTHING is still a report. `no_op: false` is the whole claim — a
        // run counted as a no-op turn would read as a failed pass and re-dispatch the same questions.
        expect({ role: researchRun.role, state: researchRun.state, no_op: researchRun.no_op }).toEqual({
            role: 'researcher',
            state: 'torn_down',
            no_op: false
        });

        // R1d's "nothing is manufactured": the pass wrote no Knowledge row, no source and no task.
        expect(rig.store.knowledge.list()).toEqual([]);

        const story = rig.store.stories.require(rig.storyId);

        // The gate closes from the RUN, not from a rewrite of the Editor's decision: the list is still
        // non-empty (`closed`, not `waived`), and that is what keeps one story of the decision.
        expect(briefOf(rig).research_questions).toEqual(['What did the 1911 survey map actually measure?']);
        expect(researchGate(rig.store, story, briefOf(rig))).toBe('closed');
        expect(drainPreconditions(rig.store, story).unmet).not.toContain(RESEARCH_UNMET);

        // The next job is the sample — NOT a second Researcher, and NOT the same pass again.
        expect(keys(rig)).toEqual(['wi_sample_summary_0_1_1']);
        expect(runs(rig, 'wi_research')).toEqual(['wi_research_1:torn_down']);
    });
});
