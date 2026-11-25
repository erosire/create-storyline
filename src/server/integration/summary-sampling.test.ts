// Phase ①'s research pipeline, end to end through the REAL server
// (documents/phase-1-research-pipeline.md §1, §6.4-§6.8):
//
//   structure_seed → research → N × sample_unit → M × screen_samples per sample
//     → the engine's deterministic selection (§6.5) → deep review on the selected revision
//     → an approved fix task arms round 2 (whose prompt carries the base revision + the tasks)
//     → round 2's screening passes CERTIFY the repair by task id → only a certified candidate may
//       win, and only then does the task close → a clean deep review signs the phase off.
//
// H1 (the hill-climb) is what the last two `describe` blocks pin: an uncertified draft is ineligible,
// the round drafts again inside the attempt cap, a spent cap asks the Author instead of installing the
// least-bad text, and the fix task stays open on every draft that failed.
//
// Everything asserted here is a store row, a run row or an HTTP projection: the crew is scripted
// from its brief (harness.ts) and the clock is the test's explicit sweep/settle. The sampler's
// default answer derives its `premise` from the compiled prompt's Seed Brief (`sample <i>: <logline>`),
// so the installed Summary provably came from the round's prompt; `sampleAnswer`/`screenAnswer`
// let one test make a sample lose the comparison or fail schema validation.
import { describe, expect, it } from 'vitest';

import {
    bootStoryline,
    createSliceStory,
    crewRows,
    defaultSampleAnswer,
    openDial,
    seedBriefFields,
    SLICE_SEED,
    storyRow,
    type StorylineFixture
} from './harness';
import { seedHashOf } from '../../shared/seed-hash';
import type { IssueList, SummarySample } from '../../shared/schemas';

/** The claim key of the Editor's structuring pass for the slice's Seed. */
const STRUCTURE_KEY = `wi_structure_seed_${seedHashOf(SLICE_SEED)}`;

/**
 * Phase ①'s two priority-0 gates, in DISPATCH ORDER, torn down — the rows every §6.4 steps 1-2
 * assertion in this file pins.
 */
const GATE_LINES = [
    `${STRUCTURE_KEY}[editor-seed-structure/editor]=torn_down`,
    'wi_research_1[researcher-story/researcher]=torn_down'
];

/**
 * The two GATE claim prefixes. Anything outside them is the sampling leg, and how far the leg has
 * got at a given sweep is the loop's dispatch decision: `harness.ts:tick` is one `sweep()` plus
 * however many `settle()` passes the runs take, so a run that closes can hand the next claim to the
 * same tick. A loaded run therefore tears down `wi_research_1` beside the structure pass, and the
 * first Sampler claim beside the Researcher — verified by replaying these two sweeps under CPU
 * contention, where the list is one claim longer than an idle run's.
 *
 * That is why the gate rows are pinned EXACTLY (they are the subject of the step) while the leg
 * behind them is pinned by CLAIM AND CREW: admitting a Sampler claim and nothing else keeps the
 * step honest — a Screening, Review or sign-off claim this early means the loop judged a draft
 * before both gates were shut — without asserting a row count the loop never promised.
 */
const isGateLine = (line: string): boolean => line.startsWith('wi_structure_seed_') || line.startsWith('wi_research_');

/** A Sampler claim, torn down, under the Sampler's own template and role — the only crew past the gates. */
const isSamplerLine = (line: string): boolean =>
    /^wi_sample_[^[]*\[writer-summary-sampler\/writer\]=torn_down$/.test(line);

/** Every run row as `claim key[template/role]=state`, in dispatch order. */
const runLines = async (fixture: StorylineFixture, storyId: string): Promise<string[]> =>
    (await crewRows(fixture, storyId)).map(
        (row) => `${row.work_item_ref}[${row.template_ref}/${row.role}]=${row.state}`
    );

/** The two Knowledge fingerprints the scripted Researcher writes, in the prompt compiler's order. */
const knowledgeRefs = (fixture: StorylineFixture): string[] => {
    const rows = fixture.store.knowledge.list();

    return rows
        .slice()
        .sort(
            (left, right) =>
                (left.importance === 'critical' ? 0 : 1) - (right.importance === 'critical' ? 0 : 1) ||
                left.fingerprint.localeCompare(right.fingerprint)
        )
        .map((row) => row.fingerprint);
};

/** A SummarySample with every prose block present and a distinctive premise. */
const screenedSample = (premise: string): SummarySample => ({
    ...defaultSampleAnswer(1, SLICE_SEED),
    premise
});

describe('§6.4 steps 1-2: the Seed is structured and researched before anything is sampled', () => {
    it('writes one accepted Seed Brief, then two sourced Knowledge entries, and samples nothing before both close', async () => {
        const fixture = await bootStoryline({ criticIdeas: 0 });
        const storyId = await createSliceStory(fixture, 1);

        try {
            // Sweep 1: the Editor's structure pass. readSeed supplies the hash; structureSeed writes
            // the DERIVED brief. Nothing may be sampled while the brief is missing.
            await fixture.tick();

            const sweep1 = await runLines(fixture, storyId);

            // THE STRUCTURE PASS RAN, AND RAN FIRST — and it is the ONLY thing that ran. The Researcher's
            // claim depends on the SEED rather than on the brief the Editor is writing, so the coordinator
            // dispatches it in the same sweep and a loaded run has it torn down here too (`isGateLine`'s
            // note); that prefix is admitted. NO Sampler claim is: a sample needs the brief AND the
            // Knowledge rows, and neither existed when this sweep computed its work items — which is the
            // "samples nothing before both close" the step is named for, and what the empty revisions list
            // below proves from the other side.
            expect(sweep1[0]).toBe(GATE_LINES[0]);
            expect(sweep1.filter(isGateLine)).toEqual(GATE_LINES.slice(0, sweep1.filter(isGateLine).length));
            expect(sweep1.filter((line) => !isGateLine(line))).toEqual([]);

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
            expect(fixture.store.revisions.list()).toEqual([]);

            // Sweep 2: the Researcher reads what is already recorded, then writes one `critical` and
            // one `high` claim — the two importances the sampling prompt is allowed to carry (§5).
            await fixture.tick();

            const sweep2 = await runLines(fixture, storyId);

            // BOTH GATES ARE SHUT, pinned exactly and in dispatch order, and the only thing that may
            // follow them is a Sampler claim — the leg the loop is entitled to start now. A Screening,
            // Review or sign-off row here would be the drift this pins.
            expect(sweep2.filter(isGateLine)).toEqual(GATE_LINES);
            expect(sweep2.filter((line) => !isGateLine(line) && !isSamplerLine(line))).toEqual([]);
            expect(
                fixture.store.knowledge
                    .list()
                    .map((entry) => `${entry.topic}:${entry.kind}:${entry.importance}:${entry.sources.length}`)
            ).toEqual(['period and place:place:critical:1', 'governing rule:world_rule:high:1']);
            expect(fixture.store.knowledge.require('knowledge_entry_0').sources).toEqual([
                {
                    url_or_title: 'the Author\u2019s Seed',
                    claim: 'it names the story\u2019s setting',
                    accessed_at: '2000-01-01T00:00:00.000Z'
                }
            ]);
            // NOTHING HAS BEEN CHOSEN. A Sampler claim may already be torn down at this sweep — the gates
            // closed at the end of the last one, so sampling is legitimate work now, and a loaded sweep
            // does exactly that — but §6.5 installs a draft only once the round's screening sets exist,
            // and a `selected` row is the install (`records.ts` truncates the losers with it). Asserting
            // the absence of a SELECTION rather than of a revision is the timing-proof form of the claim,
            // and it still fails the drift: a loop that skipped a gate and installed prose anyway lands
            // here.
            expect(fixture.store.revisions.list().filter((revision) => revision.state === 'selected')).toEqual([]);
            expect(fixture.refusals).toEqual([]);
        } finally {
            await fixture.close();
        }
    });
});

describe('§6.4 steps 3-4: N no-tool samples, M no-tool screens per sample, one deterministic winner', () => {
    it('samples three times, screens each sample five times, and installs the least-issue sample', async () => {
        const fixture = await bootStoryline({ criticIdeas: 0 });
        const storyId = await createSliceStory(fixture, 1, { sampling: 3, critics: 5 });

        try {
            await fixture.settle(async () => (await storyRow(fixture, storyId)).pending_kind === 'phase_signoff', 80);

            const lines = await runLines(fixture, storyId);

            expect(lines.filter((line) => line.startsWith('wi_structure_seed_'))).toEqual([
                `${STRUCTURE_KEY}[editor-seed-structure/editor]=torn_down`
            ]);
            expect(lines.filter((line) => line.startsWith('wi_research_'))).toEqual([
                'wi_research_1[researcher-story/researcher]=torn_down'
            ]);
            expect(lines.filter((line) => line.startsWith('wi_sample_')).sort()).toEqual([
                'wi_sample_summary_0_1_1[writer-summary-sampler/writer]=torn_down',
                'wi_sample_summary_0_1_2[writer-summary-sampler/writer]=torn_down',
                'wi_sample_summary_0_1_3[writer-summary-sampler/writer]=torn_down'
            ]);
            expect(lines.filter((line) => line.startsWith('wi_screen_')).sort()).toEqual([
                // The screen key carries the SAMPLE's own revision id (`records.ts:screenPrefixOf`), and
                // revision ids are story-local counters from 0 — so sample N (1-based, in `wi_sample_*`) is
                // `revision_${N - 1}` here. Sample 1's five screens are `revision_0_1..5`.
                ...[1, 2, 3].flatMap((sample) =>
                    [1, 2, 3, 4, 5].map(
                        (pass) => `wi_screen_revision_${sample - 1}_${pass}[critic-screening/critic]=torn_down`
                    )
                )
            ]);

            // An all-clean round ties on every count, so §6.5's last tie-break (the earliest sample)
            // chooses sample 1. The losers are truncated with their screening reviews, and the audit
            // line names what competed before they went.
            expect(
                fixture.store.revisions
                    .list()
                    .map((revision) => `${revision.id}:${revision.unit_ref}/${revision.state}:r${revision.round}:${revision.origin}`)
            ).toEqual(['revision_0:summary_0/selected:r1:sampled']);
            expect(fixture.store.revisions.require('revision_0').issue_counts).toEqual({ critical: 0, high: 0 });
            expect(
                fixture.store.sampleReviews
                    .list()
                    .map((review) => `${review.revision_ref}:${review.valid}:${review.issues.length}`)
            ).toEqual([
                'revision_0:true:0',
                'revision_0:true:0',
                'revision_0:true:0',
                'revision_0:true:0',
                'revision_0:true:0'
            ]);

            // The engine installed the winner's six prose blocks (§6.6). `chapter_count` is Author
            // truth and was never in the sample, so it is untouched (D-3b).
            const summary = fixture.store.summaries.require('summary_0');
            const expected = defaultSampleAnswer(1, SLICE_SEED, knowledgeRefs(fixture));

            // The Summary carries the six prose blocks only: `knowledge_used` is the sample's audit
            // field and stays on the revision (§3.5/§4.2), never on the installed Summary.
            expect({
                premise: summary.premise,
                promise: summary.promise,
                theme: summary.theme,
                tone: summary.tone,
                ending: summary.ending,
                world_rules: summary.world_rules,
                chapter_count: summary.chapter_count
            }).toEqual({
                premise: expected.premise,
                promise: expected.promise,
                theme: expected.theme,
                tone: expected.tone,
                ending: expected.ending,
                world_rules: expected.world_rules,
                chapter_count: 1
            });
            // Every Knowledge fingerprint the prompt carried is in the sample's audit list.
            expect(expected.knowledge_used).toEqual(knowledgeRefs(fixture));
            expect((fixture.store.revisions.require('revision_0').body as { fields: unknown }).fields).toEqual(expected);

            const story = fixture.store.stories.require(storyId);

            expect(story.sampling_round).toBe(1);
            expect((story.sampling_history ?? []).map(({ round, samples, selected }) => ({ round, samples, selected }))).toEqual([
                {
                    round: 1,
                    // H2 — every candidate carries its OUTCOME now: the winner is `accepted`, the two it
                    // beat were `eligible` (they owed nothing and broke nothing; they simply changed less
                    // … or rather, in round 1, lost §6.5's tie-break). A round-1 line has NO origin split
                    // and no minimality numbers, because there is no accepted draft to regress against.
                    samples: [
                        { revision_id: 'revision_0', critical: 0, high: 0, valid: true, unresolved_fixes: [], outcome: 'accepted' },
                        { revision_id: 'revision_1', critical: 0, high: 0, valid: true, unresolved_fixes: [], outcome: 'eligible' },
                        { revision_id: 'revision_2', critical: 0, high: 0, valid: true, unresolved_fixes: [], outcome: 'eligible' }
                    ],
                    selected: 'revision_0'
                }
            ]);

            // The deep review is the tool-using Critic pass on the winner, one per angle (§6.4 step 6).
            expect(lines.filter((line) => line.startsWith('wi_review_'))).toEqual([
                'wi_review_revision_0_a1[critic-genre/critic]=torn_down',
                'wi_review_revision_0_a2[critic-plausibility/critic]=torn_down',
                'wi_review_revision_0_a3[critic-audience/critic]=torn_down',
                'wi_review_revision_0_a4[critic-mystery/critic]=torn_down',
                'wi_review_revision_0_a5[critic-genre/critic]=torn_down'
            ]);
            expect(
                fixture.store.verdicts
                    .list()
                    .map((verdict) => `${verdict.target_ref}:${verdict.recommendation}`)
            ).toEqual([
                'summary_0:advance',
                'summary_0:advance',
                'summary_0:advance',
                'summary_0:advance',
                'summary_0:advance'
            ]);
            expect(fixture.refusals).toEqual([]);
        } finally {
            await fixture.close();
        }
    });
});

describe('§6.5/§6.6: the deterministic selection', () => {
    it('picks the clean sample when its siblings carry a critical, and truncates their drafts and reviews', async () => {
        // Samples 2 and 3 contradict the Seed Brief on their premise; sample 1 is clean. The winner
        // is therefore not a creation-order accident — the least-critical rule decides (§6.5).
        const fixture = await bootStoryline({
            criticIdeas: 0,
            screenAnswer: ({ sampleIndex }): IssueList =>
                sampleIndex === 1
                    ? { issues: [] }
                    : {
                          issues: [
                              {
                                  severity: 'critical',
                                  criterion: 'C-14',
                                  location: 'premise',
                                  quote: `sample ${sampleIndex}: ${SLICE_SEED}`,
                                  detail: 'the premise contradicts the Seed Brief'
                              }
                          ]
                      }
        });
        const storyId = await createSliceStory(fixture, 1, { sampling: 3, critics: 1 });

        try {
            await fixture.settle(async () => (await storyRow(fixture, storyId)).pending_kind === 'phase_signoff', 80);

            // Sample 1's fields are installed — the clean sample, not merely the first one written.
            const summary = fixture.store.summaries.require('summary_0');
            const expected = defaultSampleAnswer(1, SLICE_SEED, knowledgeRefs(fixture));

            expect({
                premise: summary.premise,
                promise: summary.promise,
                theme: summary.theme,
                tone: summary.tone,
                ending: summary.ending,
                world_rules: summary.world_rules
            }).toEqual({
                premise: expected.premise,
                promise: expected.promise,
                theme: expected.theme,
                tone: expected.tone,
                ending: expected.ending,
                world_rules: expected.world_rules
            });

            // The losers are gone from the book: no revision and no screening review survives them.
            expect(
                fixture.store.revisions
                    .list()
                    .map((revision) => `${revision.id}:${revision.unit_ref}/${revision.state}`)
            ).toEqual(['revision_0:summary_0/selected']);
            expect(fixture.store.sampleReviews.list().map((review) => review.revision_ref)).toEqual(['revision_0']);

            // ...but the P11 audit line keeps every sample and its issue counts, and the selected id.
            const story = fixture.store.stories.require(storyId);

            expect({ round: story.sampling_round, history: story.sampling_history?.map(({ round, samples, selected }) => ({ round, samples, selected })) }).toEqual({
                round: 1,
                history: [
                    {
                        round: 1,
                        // H2 — the two samples that carried a critical are `rejected`, and each says WHY
                        // in the words the selector used. In a first round the reason is the §6.5 counts
                        // themselves (there is no incumbent to regress against), and the winner carries
                        // no reason at all.
                        samples: [
                            { revision_id: 'revision_0', critical: 0, high: 0, valid: true, unresolved_fixes: [], outcome: 'accepted' },
                            {
                                revision_id: 'revision_1',
                                critical: 1,
                                high: 0,
                                valid: true,
                                unresolved_fixes: [],
                                outcome: 'rejected',
                                reject_reason: '1 critical / 0 major screening issues'
                            },
                            {
                                revision_id: 'revision_2',
                                critical: 1,
                                high: 0,
                                valid: true,
                                unresolved_fixes: [],
                                outcome: 'rejected',
                                reject_reason: '1 critical / 0 major screening issues'
                            }
                        ],
                        selected: 'revision_0'
                    }
                ]
            });

            // The run rows remain as history (the ledger is never rewritten), and the deep review is
            // pointed at the winner only.
            const lines = await runLines(fixture, storyId);

            expect(lines.filter((line) => line.startsWith('wi_sample_')).sort()).toEqual([
                'wi_sample_summary_0_1_1[writer-summary-sampler/writer]=torn_down',
                'wi_sample_summary_0_1_2[writer-summary-sampler/writer]=torn_down',
                'wi_sample_summary_0_1_3[writer-summary-sampler/writer]=torn_down'
            ]);
            expect(lines.filter((line) => line.startsWith('wi_review_'))).toEqual([
                'wi_review_revision_0_a1[critic-genre/critic]=torn_down'
            ]);
        } finally {
            await fixture.close();
        }
    });
});

describe('§6.4 step 6 / §6.8: the deep review, the dial, and the refinement round', () => {
    it('verifies and approves a finding, arms round 2 with the base + fix task, and consumes the task on selection', async () => {
        /** Every round-2 prompt the sampler compiled, to prove the base revision and tasks travelled. */
        const refinedPrompts: string[] = [];
        /** How many deep-review passes have already filed their defect (the first one only). */
        let filed = 0;

        const fixture = await bootStoryline({
            criticIdeas: 0,
            // The first deep-review pass files one major defect on round 1's selected draft; its four
            // sibling passes and all of round 2's passes file nothing. A crew that re-filed the
            // repaired flaw would spin a third round forever.
            criticFinds: (ctx) => {
                if (ctx.draftIds[0] !== 'revision_0') return undefined;

                filed += 1;

                return filed === 1 ? 'major' : undefined;
            },
            sampleAnswer: (turn) => {
                if (turn.prompt.includes('## FIX TASKS')) refinedPrompts.push(turn.prompt);

                return turn.prompt.includes('## BASE REVISION')
                    ? screenedSample('refined: sample 1')
                    : defaultSampleAnswer(turn.sampleIndex, SLICE_SEED);
            }
        });
        const storyId = await createSliceStory(fixture, 1, { sampling: 1, critics: 5 });

        try {
            await openDial(fixture, storyId);
            await fixture.settle(async () => (await storyRow(fixture, storyId)).pending_kind === 'phase_signoff', 100);

            // The finding walked D-33/D-34 on its own: the Editor verified it, the dial approved it,
            // and the approval queued the fix work round 2 must answer.
            const findings = fixture.store.findings.list();

            expect(findings.map((finding) => `${finding.id}:${finding.state}/${finding.cost}`)).toEqual([
                'finding_0:fixed/major'
            ]);
            expect(findings[0]).toMatchObject({
                target_ref: 'summary_0',
                criterion_ref: 'C-14',
                approved_by: 'auto',
                related_refs: ['revision_0']
            });

            const tasks = fixture.store.tasks.list();

            expect(tasks).toHaveLength(1);
            expect(tasks[0]).toMatchObject({
                kind: 'fix',
                state: 'done',
                finding_ref: 'finding_0',
                criterion_ref: 'C-14'
            });
            // `approveFinding` queues the task in the Editor's own thread (D-34), so it keeps the
            // Critic's finding title verbatim; the loop's dedupe then finds it and queues nothing.
            expect(tasks[0].title).toBe('Critic: the draft drifts from the Seed (critic-genre)');

            // Round 1's winner stays; round 2's refined sample becomes the second selected revision.
            expect(
                fixture.store.revisions
                    .list()
                    .map((revision) => `${revision.id}:r${revision.round}:${revision.origin}:${revision.state}`)
            ).toEqual(['revision_0:r1:sampled:selected', 'revision_1:r2:refined:selected']);
            expect(fixture.store.summaries.require('summary_0').premise).toBe('refined: sample 1');

            const story = fixture.store.stories.require(storyId);

            expect(story.sampling_round).toBe(2);
            expect(
                (story.sampling_history ?? []).map(({ round, samples, selected }) => ({
                    round,
                    samples: samples.map((sample) => `${sample.revision_id}:${sample.critical}:${sample.valid}`),
                    selected
                }))
            ).toEqual([
                { round: 1, samples: ['revision_0:0:true'], selected: 'revision_0' },
                { round: 2, samples: ['revision_1:0:true'], selected: 'revision_1' }
            ]);

            // §6.8's compiled input, seen from the sampler: the base draft and the open fix task.
            expect(refinedPrompts).toHaveLength(1);
            expect(refinedPrompts[0]).toContain('## BASE REVISION');
            expect(refinedPrompts[0]).toContain('premise: sample 1: ' + SLICE_SEED);
            expect(refinedPrompts[0]).toContain('## FIX TASKS');
            expect(refinedPrompts[0]).toContain(tasks[0].title);

            // The run ledger: round 2's sample key carries the round, and each round's selected
            // revision got the full five deep-review passes (§6.4 step 6, `wi_review_<rev>_a1..5`).
            const refs = (await crewRows(fixture, storyId)).map((row) => String(row.work_item_ref));

            expect(refs.filter((ref) => ref.startsWith('wi_sample_'))).toEqual([
                'wi_sample_summary_0_1_1',
                'wi_sample_summary_0_2_1'
            ]);
            expect(refs.filter((ref) => ref.startsWith('wi_review_')).sort()).toEqual([
                'wi_review_revision_0_a1',
                'wi_review_revision_0_a2',
                'wi_review_revision_0_a3',
                'wi_review_revision_0_a4',
                'wi_review_revision_0_a5',
                'wi_review_revision_1_a1',
                'wi_review_revision_1_a2',
                'wi_review_revision_1_a3',
                'wi_review_revision_1_a4',
                'wi_review_revision_1_a5'
            ]);

            // The Goal passes with nothing owed: the phase signs off, and the Author's lock moves it.
            expect(await storyRow(fixture, storyId)).toMatchObject({
                phase: 'summary',
                status: 'pending',
                pending_kind: 'phase_signoff',
                levels: { summary: '2/2' }
            });

            await fixture.handle.engine.lockPhase(storyId, 'summary');

            expect(fixture.store.stories.require(storyId)).toMatchObject({
                phase: 'plotlines',
                summary_locked: true
            });
            expect(fixture.store.summaries.require('summary_0').locked).toBe(true);
        } finally {
            await fixture.close();
        }
    });
});

// H1 — the two rows that make phase ① a HILL rather than a re-draw. Both start from the same state
// the test above reaches: round 1 is installed, the deep review filed one major defect, the Author's
// dial approved it, and its fix task armed round 2. What differs is only what round 2's screening
// passes say about the repair, because that answer — not the prose — is what the selection reads.
describe('H1/R2-R5 — round 2 certifies the fix before it may select', () => {
    it('refuses the draft its own Critics refused, installs the one that certified the fix, then closes the task', async () => {
        /** Every refinement prompt the sampler compiled, to prove the contract travelled with the fix. */
        const refinedPrompts: string[] = [];
        /** How many deep-review passes have already filed their defect (the first one only). */
        let filed = 0;

        const fixture = await bootStoryline({
            criticIdeas: 0,
            criticFinds: (ctx) => {
                if (ctx.draftIds[0] !== 'revision_0') return undefined;

                filed += 1;

                return filed === 1 ? 'major' : undefined;
            },
            sampleAnswer: (turn) => {
                if (turn.prompt.includes('## BASE REVISION')) refinedPrompts.push(turn.prompt);

                return defaultSampleAnswer(turn.sampleIndex, SLICE_SEED);
            },
            // Two refinement drafts and one question between them: sample 1 kept the ending it was
            // given, sample 2 paid the promise. The Critics answer by TASK ID, and that answer — not
            // their issue counts, which are 0/0 for both — decides the round (H1/R2).
            screenFixes: ({ fixIds, sampleIndex }) =>
                fixIds.map((fix_ref) => ({
                    fix_ref,
                    status: sampleIndex === 1 ? 'unresolved' : 'resolved',
                    evidence: `ending: sample ${sampleIndex} ending`
                }))
        });
        const storyId = await createSliceStory(fixture, 1, { sampling: 2, critics: 1 });

        try {
            await openDial(fixture, storyId);
            await fixture.settle(async () => (await storyRow(fixture, storyId)).pending_kind === 'phase_signoff', 100);

            // Sample 1 was drafted first, so it is `revision_2` — and it is gone. An uncertified draft
            // is not the round's answer, even though it tied on every §6.5 count, and §6.6's
            // truncation deleted it with its screening reviews.
            expect(
                fixture.store.revisions
                    .list()
                    .map((revision) => `${revision.id}:r${revision.round}:${revision.origin}:${revision.state}`)
            ).toEqual(['revision_0:r1:sampled:selected', 'revision_3:r2:refined:selected']);
            // The Summary now reads the CERTIFIED draft, not merely the earliest one.
            expect(fixture.store.summaries.require('summary_0').premise).toBe(`sample 2: ${SLICE_SEED}`);

            // R4: the task and its finding close on the winner's certificate. Neither moved when the
            // failed draft was screened, and neither would have moved had the round selected it.
            expect(fixture.store.tasks.list().map((task) => `${task.id}:${task.state}`)).toEqual(['task_0:done']);
            expect(fixture.store.findings.list().map((finding) => `${finding.id}:${finding.state}`)).toEqual([
                'finding_0:fixed'
            ]);

            // R4's audit: the loser's `sample_reviews` rows are deleted by the selection commit, so the
            // history line is the only surviving record of which fix it failed.
            const story = fixture.store.stories.require(storyId);

            expect(story.sampling_round).toBe(2);
            expect(
                (story.sampling_history ?? []).map(({ round, samples, selected }) => ({
                    round,
                    samples: samples.map(
                        (sample) =>
                            `${sample.revision_id}:${sample.critical}:${((sample.unresolved_fixes ?? []).join('+')) || 'clear'}:${sample.outcome ?? 'unrecorded'}`
                    ),
                    selected
                }))
            ).toEqual([
                {
                    round: 1,
                    samples: ['revision_0:0:clear:accepted', 'revision_1:0:clear:eligible'],
                    selected: 'revision_0'
                },
                {
                    // H2 — the OUTCOME rides with the outstanding fix: `revision_2` is `rejected` for the
                    // fix task, `revision_3` is the draft the round installed, and `revision_1` was
                    // eligible and simply lost round 1's tie-break. `unrecorded` never appears on a line
                    // this build wrote — it is the shape a history line from before the hill has.
                    round: 2,
                    samples: ['revision_2:0:task_0:rejected', 'revision_3:0:clear:accepted'],
                    selected: 'revision_3'
                }
            ]);

            // …and the refusal is recorded in the selector's own words, not a score: this is the sentence
            // that survives §6.6's truncation of the draft and its screening rows (H1-C1/F3, H2).
            expect(story.sampling_history?.[1]?.samples[0]?.reject_reason).toBe(
                'fix task_0 not certified with evidence'
            );

            // No retry was bought: the round held a certifiable draft, so the hill-climb never had to
            // reach for its allowance (R3: the retry is for a stalled round, not a decided one).
            const refs = (await crewRows(fixture, storyId)).map((row) => String(row.work_item_ref));

            expect(refs.filter((ref) => ref.startsWith('wi_sample_'))).toEqual([
                'wi_sample_summary_0_1_1',
                'wi_sample_summary_0_1_2',
                'wi_sample_summary_0_2_1',
                'wi_sample_summary_0_2_2'
            ]);
            expect(refs.filter((ref) => ref.startsWith('wi_escalation'))).toEqual([]);

            // H1/R1, seen from the Writer: the fix travelled with its evidence AND with the contract
            // that keeps the round a revision of the draft it replaces.
            expect(refinedPrompts).toHaveLength(2);
            expect(refinedPrompts[0]).toContain('## BASE REVISION');
            expect(refinedPrompts[0]).toContain('## REVISION CONTRACT');
            expect(refinedPrompts[0]).toContain('## FIX TASKS');
            expect(refinedPrompts[0]).toContain('defect:');
            expect(refinedPrompts[0]).toContain('evidence:');
        } finally {
            await fixture.close();
        }
    });

    it('drafts again while nothing can certify the fix, then asks the Author without closing anything', async () => {
        /** Every refinement prompt, so the retry count is read from what the Writer was actually sent. */
        const refinedPrompts: string[] = [];
        let filed = 0;

        const fixture = await bootStoryline({
            criticIdeas: 0,
            criticFinds: (ctx) => {
                if (ctx.draftIds[0] !== 'revision_0') return undefined;

                filed += 1;

                return filed === 1 ? 'major' : undefined;
            },
            sampleAnswer: (turn) => {
                if (!turn.prompt.includes('## BASE REVISION')) return defaultSampleAnswer(turn.sampleIndex, SLICE_SEED);

                refinedPrompts.push(turn.prompt);

                // Four attempts at the same text: the sampler keeps its word, and the Critics keep
                // theirs. This is the case the old pipeline got wrong — the prose is clean, so the
                // counts are clean, and only the certificate says the defect is still there.
                return screenedSample('refined: the same ending again');
            },
            screenFixes: ({ fixIds }) =>
                fixIds.map((fix_ref) => ({
                    fix_ref,
                    status: 'unresolved' as const,
                    evidence: 'ending: refined: the same ending again — the promise is still not paid'
                }))
        });
        const storyId = await createSliceStory(fixture, 1, { sampling: 1, critics: 1 });

        try {
            await openDial(fixture, storyId);
            await fixture.settle(async () => fixture.store.tasks.list().some((task) => task.kind === 'escalation'), 80);

            // One sample the Author asked for, plus `SAMPLING_RETRY_ALLOWANCE` (3) retries: the extra
            // drafts are the hill-climb, and the cap is what bounds it (R3). Each retry is a fresh
            // prompt over the same base draft, so the Writer is asked to revise, never to start over.
            expect(refinedPrompts).toHaveLength(4);
            const refs = (await crewRows(fixture, storyId)).map((row) => String(row.work_item_ref));

            expect(refs.filter((ref) => ref.startsWith('wi_sample_'))).toEqual([
                'wi_sample_summary_0_1_1',
                'wi_sample_summary_0_2_1',
                'wi_sample_summary_0_2_2',
                'wi_sample_summary_0_2_3',
                'wi_sample_summary_0_2_4'
            ]);

            const story = fixture.store.stories.require(storyId);

            // Nothing was installed and nothing was closed: round 1's text is still the Summary, the
            // round never advanced, and the fix task and its finding are exactly where the deep review
            // left them (R4 — the old behaviour closed them on a selection that had not earned it).
            expect(story.sampling_round).toBe(1);
            expect(story.sampling_history?.map((line) => line.round)).toEqual([1]);
            expect(fixture.store.summaries.require('summary_0').premise).toBe(`sample 1: ${SLICE_SEED}`);
            expect(
                fixture.store.revisions
                    .list()
                    .map((revision) => `${revision.id}:r${revision.round}:${revision.origin}:${revision.state}`)
            ).toEqual([
                'revision_0:r1:sampled:selected',
                'revision_1:r2:refined:drafted',
                'revision_2:r2:refined:drafted',
                'revision_3:r2:refined:drafted',
                'revision_4:r2:refined:drafted'
            ]);
            expect(
                fixture.store.tasks.list().map((task) => `${task.id}:${task.kind}:${task.state}`)
            ).toEqual(['task_0:fix:open', 'task_1:escalation:open']);
            expect(fixture.store.findings.list().map((finding) => `${finding.id}:${finding.state}`)).toEqual([
                'finding_0:approved'
            ]);

            // The escalation is the OTHER sampling failure — not the provider one — and it names the
            // fix it could not certify, on the drafts that were tried (R3: surfaced, not hidden).
            const escalation = fixture.store.tasks.list().find((task) => task.kind === 'escalation');

            expect(escalation?.title).toBe(
                'Phase ① sampling failed after 4 attempts — no draft answered the fixes this round was armed with'
            );
            expect(escalation?.detail).toContain('task_0 (unresolved on revision_1)');
            expect(escalation?.detail).toContain('wave: 0');
            expect(escalation?.detail).toContain('every fix task is still open');
        } finally {
            await fixture.close();
        }
    });
});

describe('§6.4 step 3: a sampler that never validates costs attempts, then escalates', () => {
    it('retries the schema once per attempt, spends the retry allowance, and opens the Author escalation', async () => {
        /** Every structured provider call, counted so the repair retry is observable. */
        let calls = 0;

        const fixture = await bootStoryline({
            criticIdeas: 0,
            // Withholding C-14 parks the Story: the empty Summary cannot reach a sign-off, so the
            // only state worth asserting is the escalation the sampling failure raises.
            failCriteria: ['C-14'],
            sampleAnswer: () => {
                calls += 1;

                // Schema-INVALID on purpose: `SummarySample` requires every prose field non-empty.
                return JSON.stringify({
                    premise: '',
                    promise: '',
                    theme: '',
                    tone: '',
                    ending: '',
                    world_rules: '',
                    knowledge_used: []
                });
            }
        });
        const storyId = await createSliceStory(fixture, 1, { sampling: 1, critics: 1 });

        try {
            await fixture.settle(
                async () => fixture.store.tasks.list().some((task) => task.kind === 'escalation'),
                40
            );

            // 1 sample + `SAMPLING_RETRY_ALLOWANCE` (3) attempts, each answered twice: the answer and
            // the one schema-repair turn (`executor.ts:STRUCTURED_ATTEMPTS`).
            const samples = (await crewRows(fixture, storyId))
                .filter((row) => String(row.work_item_ref).startsWith('wi_sample_'))
                .sort((left, right) => String(left.work_item_ref).localeCompare(String(right.work_item_ref)));

            expect(samples.map((row) => `${row.work_item_ref}=${row.state}`)).toEqual([
                'wi_sample_summary_0_1_1=failed',
                'wi_sample_summary_0_1_2=failed',
                'wi_sample_summary_0_1_3=failed',
                'wi_sample_summary_0_1_4=failed'
            ]);
            expect(samples.map((row) => row.end_reason)).toEqual([
                'failed: Error: structured answer failed schema validation after 2 attempts: premise: expected a string with minLength 1, received ""',
                'failed: Error: structured answer failed schema validation after 2 attempts: premise: expected a string with minLength 1, received ""',
                'failed: Error: structured answer failed schema validation after 2 attempts: premise: expected a string with minLength 1, received ""',
                'failed: Error: structured answer failed schema validation after 2 attempts: premise: expected a string with minLength 1, received ""'
            ]);
            expect(calls).toBe(8);

            expect(fixture.store.revisions.list()).toEqual([]);
            expect(fixture.store.sampleReviews.list()).toEqual([]);
            expect(fixture.store.tasks.list()).toMatchObject([
                {
                    kind: 'escalation',
                    owner_role: 'author',
                    state: 'open',
                    title: 'Phase ① sampling failed after 4 attempts — the provider is not returning valid SummarySample JSON'
                }
            ]);

            // Generation stops buying samples once the allowance is spent: two more sweeps add none.
            await fixture.tick();
            await fixture.tick();

            expect(
                (await crewRows(fixture, storyId)).filter((row) => String(row.work_item_ref).startsWith('wi_sample_'))
            ).toHaveLength(4);
            // H2/R2 — the settled row reads as the AUTHOR's wait, not `ready`: the sampling escalation
            // it just opened is an open, Author-owned question, and with no sample left to buy and no
            // run live there is nothing for the crew to dispatch. Before this fix the decision machine
            // read only `blocked` escalation rows as a question, so a phase-① failure row (which is
            // deliberately `open`, because the rearm/reuse/clear reads key on that shape) walked past
            // step 4 and the Story claimed `ready` — the Working pill — while nothing could run.
            const settled = await storyRow(fixture, storyId);

            expect(settled).toMatchObject({
                status: 'pending',
                pending_kind: 'drained',
                blocked_on: 'the Author: an open question',
                active_runs: 0,
                levels: { summary: '1/2 · failing: C-14' }
            });
            expect(String(settled.status_reason)).toContain('the crew asked you');
            expect(String(settled.status_reason)).toContain('Phase ① sampling failed after');
        } finally {
            await fixture.close();
        }
    });
});
