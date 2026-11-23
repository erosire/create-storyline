// Phase ①'s research pipeline, end to end through the REAL server
// (documents/phase-1-research-pipeline.md §1, §6.4-§6.8):
//
//   structure_seed → research → N × sample_unit → M × screen_samples per sample
//     → the engine's deterministic selection (§6.5) → deep review on the selected revision
//     → an approved fix task arms round 2 (whose prompt carries the base revision + the tasks)
//     → round 2's selection consumes the task → a clean deep review signs the phase off.
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
        const fixture = await bootStoryline({ readerIdeas: 0 });
        const storyId = await createSliceStory(fixture, 1);

        try {
            // Sweep 1: the Editor's structure pass. readSeed supplies the hash; structureSeed writes
            // the DERIVED brief. Nothing may be sampled while the brief is missing.
            await fixture.tick();

            expect(await runLines(fixture, storyId)).toEqual([`${STRUCTURE_KEY}[editor-seed-structure/editor]=torn_down`]);

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

            expect(await runLines(fixture, storyId)).toEqual([
                `${STRUCTURE_KEY}[editor-seed-structure/editor]=torn_down`,
                'wi_research_1[researcher-story/researcher]=torn_down'
            ]);
            expect(
                fixture.store.knowledge
                    .list()
                    .map((entry) => `${entry.topic}:${entry.kind}:${entry.importance}:${entry.sources.length}`)
            ).toEqual(['period and place:place:critical:1', 'governing rule:world_rule:high:1']);
            expect(fixture.store.knowledge.require('knowledge_entry_1').sources).toEqual([
                {
                    url_or_title: 'the Author\u2019s Seed',
                    claim: 'it names the story\u2019s setting',
                    accessed_at: '2000-01-01T00:00:00.000Z'
                }
            ]);
            expect(fixture.store.revisions.list()).toEqual([]);
            expect(fixture.refusals).toEqual([]);
        } finally {
            await fixture.close();
        }
    });
});

describe('§6.4 steps 3-4: N no-tool samples, M no-tool screens per sample, one deterministic winner', () => {
    it('samples three times, screens each sample five times, and installs the least-issue sample', async () => {
        const fixture = await bootStoryline({ readerIdeas: 0 });
        const storyId = await createSliceStory(fixture, 1, { sampling: 3, readers: 5 });

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
                'wi_sample_summary_1_1_1[writer-summary-sampler/writer]=torn_down',
                'wi_sample_summary_1_1_2[writer-summary-sampler/writer]=torn_down',
                'wi_sample_summary_1_1_3[writer-summary-sampler/writer]=torn_down'
            ]);
            expect(lines.filter((line) => line.startsWith('wi_screen_')).sort()).toEqual([
                ...[1, 2, 3].flatMap((sample) =>
                    [1, 2, 3, 4, 5].map(
                        (pass) => `wi_screen_revision_${sample}_${pass}[reader-screening/reader]=torn_down`
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
            ).toEqual(['revision_1:summary_1/selected:r1:sampled']);
            expect(fixture.store.revisions.require('revision_1').issue_counts).toEqual({ critical: 0, high: 0 });
            expect(
                fixture.store.sampleReviews
                    .list()
                    .map((review) => `${review.revision_ref}:${review.valid}:${review.issues.length}`)
            ).toEqual([
                'revision_1:true:0',
                'revision_1:true:0',
                'revision_1:true:0',
                'revision_1:true:0',
                'revision_1:true:0'
            ]);

            // The engine installed the winner's six prose blocks (§6.6). `chapter_count` is Author
            // truth and was never in the sample, so it is untouched (D-3b).
            const summary = fixture.store.summaries.require('summary_1');
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
            expect((fixture.store.revisions.require('revision_1').body as { fields: unknown }).fields).toEqual(expected);

            const story = fixture.store.stories.require(storyId);

            expect(story.sampling_round).toBe(1);
            expect((story.sampling_history ?? []).map(({ round, samples, selected }) => ({ round, samples, selected }))).toEqual([
                {
                    round: 1,
                    samples: [
                        { revision_id: 'revision_1', critical: 0, high: 0, valid: true },
                        { revision_id: 'revision_2', critical: 0, high: 0, valid: true },
                        { revision_id: 'revision_3', critical: 0, high: 0, valid: true }
                    ],
                    selected: 'revision_1'
                }
            ]);

            // The deep review is the tool-using Reader pass on the winner, one per angle (§6.4 step 6).
            expect(lines.filter((line) => line.startsWith('wi_review_'))).toEqual([
                'wi_review_revision_1_a1[reader-genre/reader]=torn_down',
                'wi_review_revision_1_a2[reader-plausibility/reader]=torn_down',
                'wi_review_revision_1_a3[reader-audience/reader]=torn_down',
                'wi_review_revision_1_a4[reader-mystery/reader]=torn_down',
                'wi_review_revision_1_a5[reader-genre/reader]=torn_down'
            ]);
            expect(
                fixture.store.verdicts
                    .list()
                    .map((verdict) => `${verdict.target_ref}:${verdict.recommendation}`)
            ).toEqual([
                'summary_1:advance',
                'summary_1:advance',
                'summary_1:advance',
                'summary_1:advance',
                'summary_1:advance'
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
            readerIdeas: 0,
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
        const storyId = await createSliceStory(fixture, 1, { sampling: 3, readers: 1 });

        try {
            await fixture.settle(async () => (await storyRow(fixture, storyId)).pending_kind === 'phase_signoff', 80);

            // Sample 1's fields are installed — the clean sample, not merely the first one written.
            const summary = fixture.store.summaries.require('summary_1');
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
            ).toEqual(['revision_1:summary_1/selected']);
            expect(fixture.store.sampleReviews.list().map((review) => review.revision_ref)).toEqual(['revision_1']);

            // ...but the P11 audit line keeps every sample and its issue counts, and the selected id.
            const story = fixture.store.stories.require(storyId);

            expect({ round: story.sampling_round, history: story.sampling_history?.map(({ round, samples, selected }) => ({ round, samples, selected })) }).toEqual({
                round: 1,
                history: [
                    {
                        round: 1,
                        samples: [
                            { revision_id: 'revision_1', critical: 0, high: 0, valid: true },
                            { revision_id: 'revision_2', critical: 1, high: 0, valid: true },
                            { revision_id: 'revision_3', critical: 1, high: 0, valid: true }
                        ],
                        selected: 'revision_1'
                    }
                ]
            });

            // The run rows remain as history (the ledger is never rewritten), and the deep review is
            // pointed at the winner only.
            const lines = await runLines(fixture, storyId);

            expect(lines.filter((line) => line.startsWith('wi_sample_')).sort()).toEqual([
                'wi_sample_summary_1_1_1[writer-summary-sampler/writer]=torn_down',
                'wi_sample_summary_1_1_2[writer-summary-sampler/writer]=torn_down',
                'wi_sample_summary_1_1_3[writer-summary-sampler/writer]=torn_down'
            ]);
            expect(lines.filter((line) => line.startsWith('wi_review_'))).toEqual([
                'wi_review_revision_1_a1[reader-genre/reader]=torn_down'
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
            readerIdeas: 0,
            // The first deep-review pass files one major defect on round 1's selected draft; its four
            // sibling passes and all of round 2's passes file nothing. A crew that re-filed the
            // repaired flaw would spin a third round forever.
            readerFinds: (ctx) => {
                if (ctx.draftIds[0] !== 'revision_1') return undefined;

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
        const storyId = await createSliceStory(fixture, 1, { sampling: 1, readers: 5 });

        try {
            await openDial(fixture, storyId);
            await fixture.settle(async () => (await storyRow(fixture, storyId)).pending_kind === 'phase_signoff', 100);

            // The finding walked D-33/D-34 on its own: the Editor verified it, the dial approved it,
            // and the approval queued the fix work round 2 must answer.
            const findings = fixture.store.findings.list();

            expect(findings.map((finding) => `${finding.id}:${finding.state}/${finding.cost}`)).toEqual([
                'finding_1:fixed/major'
            ]);
            expect(findings[0]).toMatchObject({
                target_ref: 'summary_1',
                criterion_ref: 'C-14',
                approved_by: 'auto',
                related_refs: ['revision_1']
            });

            const tasks = fixture.store.tasks.list();

            expect(tasks).toHaveLength(1);
            expect(tasks[0]).toMatchObject({
                kind: 'fix',
                state: 'done',
                finding_ref: 'finding_1',
                criterion_ref: 'C-14'
            });
            // `approveFinding` queues the task in the Editor's own thread (D-34), so it keeps the
            // Reader's finding title verbatim; the loop's dedupe then finds it and queues nothing.
            expect(tasks[0].title).toBe('Reader: the draft drifts from the Seed (reader-genre)');

            // Round 1's winner stays; round 2's refined sample becomes the second selected revision.
            expect(
                fixture.store.revisions
                    .list()
                    .map((revision) => `${revision.id}:r${revision.round}:${revision.origin}:${revision.state}`)
            ).toEqual(['revision_1:r1:sampled:selected', 'revision_2:r2:refined:selected']);
            expect(fixture.store.summaries.require('summary_1').premise).toBe('refined: sample 1');

            const story = fixture.store.stories.require(storyId);

            expect(story.sampling_round).toBe(2);
            expect(
                (story.sampling_history ?? []).map(({ round, samples, selected }) => ({
                    round,
                    samples: samples.map((sample) => `${sample.revision_id}:${sample.critical}:${sample.valid}`),
                    selected
                }))
            ).toEqual([
                { round: 1, samples: ['revision_1:0:true'], selected: 'revision_1' },
                { round: 2, samples: ['revision_2:0:true'], selected: 'revision_2' }
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
                'wi_sample_summary_1_1_1',
                'wi_sample_summary_1_2_1'
            ]);
            expect(refs.filter((ref) => ref.startsWith('wi_review_')).sort()).toEqual([
                'wi_review_revision_1_a1',
                'wi_review_revision_1_a2',
                'wi_review_revision_1_a3',
                'wi_review_revision_1_a4',
                'wi_review_revision_1_a5',
                'wi_review_revision_2_a1',
                'wi_review_revision_2_a2',
                'wi_review_revision_2_a3',
                'wi_review_revision_2_a4',
                'wi_review_revision_2_a5'
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
            expect(fixture.store.summaries.require('summary_1').locked).toBe(true);
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
            readerIdeas: 0,
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
        const storyId = await createSliceStory(fixture, 1, { sampling: 1, readers: 1 });

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
                'wi_sample_summary_1_1_1=failed',
                'wi_sample_summary_1_1_2=failed',
                'wi_sample_summary_1_1_3=failed',
                'wi_sample_summary_1_1_4=failed'
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
            expect(await storyRow(fixture, storyId)).toMatchObject({ status: 'ready', levels: { summary: '1/2 · failing: C-14' } });
        } finally {
            await fixture.close();
        }
    });
});
