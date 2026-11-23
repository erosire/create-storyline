// Phase ①'s research pipeline (documents/phase-1-research-pipeline.md §1, §6.4-§6.8), end to end on
// the loop rig:
//
//   structure_seed → research → N × sample_unit → M × screen_samples per sample
//     → the engine's deterministic selection (§6.5) → deep review on the selected revision
//     → an approved fix task arms round 2 (whose prompt carries the base revision + the tasks)
//     → round 2's selection consumes the tasks → a clean round signs the phase off.
//
// Every value asserted below is a store row or a dispatched Work Item. The rig's sampler derives its
// six prose fields from the Seed Brief the compiled prompt carries (`sample <i>: <logline>`), so the
// installed Summary provably came from the round's prompt; `sampleAnswer`/`screenAnswer` let a test
// make ONE sample lose the comparison or fail schema validation.
import { describe, expect, it } from 'vitest';

import { createRig, seedFinding, seedTask } from './mock';
import { generateWork, SAMPLING_FAILURE_PREFIX } from './work';
import { seedHashOf } from '../../shared/seed-hash';
import type { Rig } from './mock';
import type { WorkItem } from '../run/types';

/** Every run row as `claim key:state`, oldest first — the dispatch order the sweep produced. */
function runs(rig: Rig, prefix = ''): string[] {
    return rig.store.runs
        .list()
        .filter((run) => (run.work_item_ref ?? '').startsWith(prefix))
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((run) => `${run.work_item_ref ?? run.id}:${run.state}`);
}

/** The Summary row of the rig's Story. */
function summaryOf(rig: Rig) {
    const summary = rig.store.summaries.list().find((row) => row.story_id === rig.storyId);

    if (summary === undefined) throw new Error('the rig has no Summary row');

    return summary;
}

/**
 * The compiled prompt a `toolMode: 'none'` sampler was given (§5). A structured run sends no tools,
 * so it is identified by the output contract its system turn ends with — the same sentence every
 * sampling prompt carries and no tool-carrying brief does.
 */
function samplePromptOf(rig: Rig): string {
    const request = rig.requests.find((candidate) =>
        candidate.messages.some((message) => message.content.includes('`SummarySample` schema'))
    );

    return request === undefined ? '' : request.messages.map((message) => message.content).join('\n\n');
}

describe('§6.4 steps 1-2 — the Seed is structured and researched before anything is sampled', () => {
    it('runs structure_seed, then research, and samples only once both have closed', async () => {
        const rig = await createRig({ seedStructured: false, summarySampling: 1, summaryReaders: 1 });
        const story = rig.story();

        // Gate 1: the Editor's structuring pass is the ONLY job, and it is priority 0.
        const first = generateWork(rig.store, story, { at: new Date().toISOString(), phase: 'summary' });

        expect(first.map((candidate) => candidate.key)).toEqual([`wi_structure_seed_${seedHashOf(story.idea)}`]);
        expect({
            kind: first[0].item.kind,
            roleName: first[0].item.roleName,
            templateRef: first[0].item.templateRef,
            priority: first[0].priority
        }).toEqual({ kind: 'structure_seed', roleName: 'editor', templateRef: 'editor-seed-structure', priority: 0 });

        // The Editor's run writes the brief; no sample may be offered until an ACCEPTED brief exists.
        expect((await rig.step()).stories[0].started).toEqual([`wi_structure_seed_${seedHashOf(story.idea)}`]);

        const briefs = rig.store.seedBriefs.list();

        expect(briefs.map((brief) => `${brief.id}:${brief.status}:${brief.seed_hash}`)).toEqual([
            `seed_brief_1:accepted:${seedHashOf(story.idea)}`
        ]);

        // Gate 2: the brief's research pass, and still no sampling.
        const second = generateWork(rig.store, rig.store.stories.require(story.id), {
            at: new Date().toISOString(),
            phase: 'summary'
        });

        expect(second.map((candidate) => candidate.key)).toEqual(['wi_research_1']);
        expect({ kind: second[0].item.kind, roleName: second[0].item.roleName, templateRef: second[0].item.templateRef })
            .toEqual({ kind: 'research', roleName: 'researcher', templateRef: 'researcher-story' });

        expect((await rig.step()).stories[0].started).toEqual(['wi_research_1']);

        // The Researcher's two claims, with the importances the prompt filter reads (§5).
        expect(
            rig.store.knowledge
                .list()
                .map((entry) => `${entry.topic}:${entry.importance}:${entry.sources.length}`)
        ).toEqual(['period and place:critical:1', 'governing rule:high:1']);

        // Both gates satisfied: the first sample is owed and nothing else is.
        const third = generateWork(rig.store, rig.store.stories.require(story.id), {
            at: new Date().toISOString(),
            phase: 'summary'
        });

        expect(third.map((candidate) => candidate.key)).toEqual(['wi_sample_summary_1_1_1']);

        // The sample really runs, and the compiled prompt it was given carries the accepted brief and
        // the critical/high Knowledge — the byte-stable prefix §5 describes.
        expect((await rig.step()).stories[0].started).toEqual(['wi_sample_summary_1_1_1']);

        const prompt = samplePromptOf(rig);

        expect(prompt).toContain('## SEED BRIEF');
        expect(prompt).toContain('logline: A cartographer returns to the valley she mapped as a girl');
        expect(prompt).toContain('## KNOWLEDGE — critical and high only');
        expect(prompt).toContain('[mock|story_1|period and place|the seed names the place the story happens in · critical · place]');
        expect(rig.store.revisions.list().map((revision) => revision.id)).toEqual(['revision_1']);
    });

    it('re-arms the structuring when the Seed changes, and resets the sampling round (§3.3, P5, §6.6)', async () => {
        const rig = await createRig({ summarySampling: 1, summaryReaders: 1 });

        await rig.run();

        // Round 1 ran: one selected revision, one audit line, and the counter that makes the next
        // round number.
        expect(rig.store.stories.require(rig.storyId).sampling_round).toBe(1);
        expect((rig.store.stories.require(rig.storyId).sampling_history ?? []).length).toBe(1);

        // D-25a: editing the Seed was already a full backtrack; the brief's `seed_hash` is the second
        // half of the rule — a brief derived from the old text describes a book nobody is writing.
        await rig.engine.editSeed(rig.storyId, 'A cartographer burns every map she draws.', { confirm: true });

        const story = rig.store.stories.require(rig.storyId);

        // The new Seed starts at round 1 (`origin: 'sampled'`), and the audit lines that named the
        // deleted revisions are gone with them.
        expect({ round: story.sampling_round, history: story.sampling_history }).toEqual({
            round: 0,
            history: []
        });

        const candidates = generateWork(rig.store, story, {
            at: new Date().toISOString(),
            phase: 'summary'
        });

        expect(candidates.map((candidate) => candidate.key)).toEqual([
            `wi_structure_seed_${seedHashOf('A cartographer burns every map she draws.')}`
        ]);
        expect(candidates.some((candidate) => candidate.key.startsWith('wi_sample_'))).toBe(false);
    });

    it('binds the structure pass to editor-seed-structure and unbound Editor jobs to editor-general', async () => {
        // `work.ts:candidate` binds pool[0] for every Editor job that does not name a template, so
        // the DEFAULT_ASSIGNMENT order decides whether a verification runs on the general Editor's
        // prompt or on the Seed structurer's (the wart this pins). The structure pass is the one
        // phase-① Editor job with an explicit `templateRef`, so it must be unaffected by the order.
        const fresh = await createRig({ seedStructured: false, summarySampling: 1, summaryReaders: 1 });
        const structure = generateWork(fresh.store, fresh.story(), {
            at: new Date().toISOString(),
            phase: 'summary'
        }).find((candidate) => candidate.item.kind === 'structure_seed');

        expect(structure?.item.templateRef).toBe('editor-seed-structure');

        // A phase-① verification is unbound: `verify_findings` must resolve to `editor-general`.
        const rig = await createRig({ summarySampling: 1, summaryReaders: 1 });

        await rig.run();

        const summary = summaryOf(rig);

        seedFinding(rig.store, rig.storyId, {
            target_ref: summary.id,
            criterion_ref: 'C-14',
            cost: 'major',
            state: 'unconfirmed',
            fingerprint: 'C-14|summary_1'
        });

        const verify = generateWork(rig.store, rig.store.stories.require(rig.storyId), {
            at: new Date().toISOString(),
            phase: 'summary'
        }).find((candidate) => candidate.item.kind === 'verify_findings');

        expect({ templateRef: verify?.item.templateRef, roleName: verify?.item.roleName }).toEqual({
            templateRef: 'editor-general',
            roleName: 'editor'
        });
    });
});

describe('§6.4 steps 3-4 — N no-tool samples, then M no-tool screens per sample', () => {
    it('dispatches one structured sample at a time, then M screening passes for each drafted sample', async () => {
        const rig = await createRig({ summarySampling: 3, summaryReaders: 2 });

        expect((await rig.step()).stories[0].started).toEqual(['wi_sample_summary_1_1_1']);
        expect((await rig.step()).stories[0].started).toEqual(['wi_sample_summary_1_1_2']);
        expect((await rig.step()).stories[0].started).toEqual(['wi_sample_summary_1_1_3']);

        // Three complete samples — no Editor choice, no `write_unit` (the engine persists them).
        expect(rig.store.revisions.list().map((revision) => `${revision.id}:${revision.unit_kind}:${revision.origin}:r${revision.round}`)).toEqual([
            'revision_1:summary:sampled:r1',
            'revision_2:summary:sampled:r1',
            'revision_3:summary:sampled:r1'
        ]);

        // The sampler's Work Item: ONE no-tool turn, the SummarySample schema, the 1-based sample index
        // (the provider seed), and the round the compiler reads (§6.2/§6.4).
        const sample = rig.items.get('wi_sample_summary_1_1_2');

        expect({
            kind: sample?.kind,
            toolMode: sample?.toolMode,
            schema: sample?.responseSchema?.name,
            sampleIndex: sample?.sampleIndex,
            round: sample?.round,
            templateRef: sample?.templateRef,
            roleName: sample?.roleName,
            unit: sample?.unit
        }).toEqual({
            kind: 'sample_unit',
            toolMode: 'none',
            schema: 'SummarySample',
            sampleIndex: 2,
            round: 1,
            templateRef: 'writer-summary-sampler',
            roleName: 'writer',
            unit: { kind: 'summary', ref: 'summary_1' }
        });

        // Two passes per sample, and the pass that is owed next is the one the key names.
        expect((await rig.step()).stories[0].started).toEqual(['wi_screen_revision_1_1']);
        expect((await rig.step()).stories[0].started).toEqual(['wi_screen_revision_1_2']);

        const screen = rig.items.get('wi_screen_revision_1_2');

        expect({
            kind: screen?.kind,
            toolMode: screen?.toolMode,
            schema: screen?.responseSchema?.name,
            revisionRef: screen?.revisionRef,
            templateRef: screen?.templateRef
        }).toEqual({
            kind: 'screen_samples',
            toolMode: 'none',
            schema: 'IssueList',
            revisionRef: 'revision_1',
            templateRef: 'reader-screening'
        });

        await rig.run();

        // Six screening answers, two per sample, all VALID (the engine persisted each) — and the
        // round then selected, so the losers and their reviews are gone.
        expect(
            rig.store.runs
                .list()
                .filter((run) => (run.work_item_ref ?? '').startsWith('wi_screen_'))
                .map((run) => run.work_item_ref)
                .sort()
        ).toEqual([
            'wi_screen_revision_1_1',
            'wi_screen_revision_1_2',
            'wi_screen_revision_2_1',
            'wi_screen_revision_2_2',
            'wi_screen_revision_3_1',
            'wi_screen_revision_3_2'
        ]);
        expect(
            rig.store.sampleReviews.list().map((review) => `${review.revision_ref}:${review.reader}:${review.valid}`)
        ).toEqual(['revision_1:reader:true', 'revision_1:reader:true']);
    });
});

describe('§6.5/§6.6 — the deterministic selection, in one commit', () => {
    it('picks the sample with the fewest critical issues, installs its fields, and truncates the rest', async () => {
        // Three samples; the SECOND one is clean while the first carries a critical and the third a
        // high. The winner is therefore not the first draft — the ranking, not creation order, decides.
        const rig = await createRig({
            summarySampling: 3,
            summaryReaders: 2,
            crew: {
                screenAnswer: ({ revisionId }) =>
                    revisionId === 'revision_1'
                        ? {
                              issues: [
                                  {
                                      severity: 'critical',
                                      criterion: 'seed',
                                      location: 'ending',
                                      quote: 'sample 1 ending',
                                      detail: 'the ending contradicts the promise the Seed makes'
                                  }
                              ]
                          }
                        : revisionId === 'revision_3'
                          ? {
                                issues: [
                                    {
                                        severity: 'high',
                                        criterion: 'C-14',
                                        location: 'premise',
                                        quote: 'sample 3 premise',
                                        detail: 'the premise never pays the promise'
                                    }
                                ]
                            }
                          : { issues: [] }
            }
        });

        await rig.run();

        const story = rig.store.stories.require(rig.storyId);
        const summary = summaryOf(rig);

        // The installed Summary is sample 2's six prose blocks, and `chapter_count` is untouched
        // (Author truth, D-3b — a sample may never propose one).
        expect({
            premise: summary.premise,
            promise: summary.promise,
            theme: summary.theme,
            tone: summary.tone,
            ending: summary.ending,
            world_rules: summary.world_rules,
            chapter_count: summary.chapter_count
        }).toEqual({
            premise: `sample 2: ${story.idea.split('\n')[0].trim()}`,
            promise: 'sample 2 pays the promise the Seed makes',
            theme: 'sample 2 theme',
            tone: 'sample 2 tone',
            ending: 'sample 2 ending',
            world_rules: 'sample 2 world rules',
            chapter_count: 1
        });

        // One revision survives: the winner, `selected`, carrying its screening counts.
        expect(
            rig.store.revisions
                .list()
                .map((revision) => `${revision.id}:${revision.state}:${JSON.stringify(revision.issue_counts)}`)
        ).toEqual(['revision_2:selected:{"critical":0,"high":0}']);

        // The losers' screening reviews went with the losers: only the winner's two remain.
        expect(
            rig.store.sampleReviews.list().map((review) => review.revision_ref)
        ).toEqual(['revision_2', 'revision_2']);

        // §6.6's P11 audit line names every sample and the choice, BEFORE the deletes made the losers
        // unrecoverable; `sampling_round` is what makes the next round `+1`.
        const history = story.sampling_history ?? [];

        expect(history).toHaveLength(1);
        expect({
            round: history[0].round,
            samples: history[0].samples,
            selected: history[0].selected
        }).toEqual({
            round: 1,
            // The counts are per SAMPLE, across ALL its screening passes (§6.5): two passes each, so
            // the critical on sample 1 is counted twice and the high on sample 3 twice.
            samples: [
                { revision_id: 'revision_1', critical: 2, high: 0, valid: true },
                { revision_id: 'revision_2', critical: 0, high: 0, valid: true },
                { revision_id: 'revision_3', critical: 0, high: 2, valid: true }
            ],
            selected: 'revision_2'
        });
        expect(story.sampling_round).toBe(1);
    });
});

describe('§6.4 step 3 — a failed sample costs an attempt, not the round', () => {
    it('re-arms the sample when the answer is invalid JSON twice, under the next claim key', async () => {
        // The executor asks twice per attempt (the answer + one schema-repair turn): two unusable
        // answers fail the attempt, and the third call is the next attempt's first turn.
        let calls = 0;

        const rig = await createRig({
            summarySampling: 1,
            summaryReaders: 1,
            crew: {
                sampleAnswer: () => {
                    calls += 1;

                    return calls <= 2 ? 'not json' : {
                        premise: 'the retry landed',
                        promise: 'the retry pays the promise',
                        theme: 'retry theme',
                        tone: 'retry tone',
                        ending: 'retry ending',
                        world_rules: 'retry world rules',
                        knowledge_used: []
                    };
                }
            }
        });

        await rig.step();

        // The attempt produced NO revision — the generation counter, not the row count, is the memory.
        expect(rig.store.revisions.list()).toEqual([]);

        await rig.run();

        expect(runs(rig, 'wi_sample_summary_1_1')).toEqual([
            'wi_sample_summary_1_1_1:failed',
            'wi_sample_summary_1_1_2:torn_down'
        ]);
        expect(rig.store.revisions.list().map((revision) => revision.id)).toEqual(['revision_1']);
        expect(summaryOf(rig).premise).toBe('the retry landed');
    });

    it('escalates to the Author once the round has spent its retry allowance with no sample', async () => {
        const rig = await createRig({
            summarySampling: 1,
            summaryReaders: 1,
            crew: { sampleAnswer: () => 'not json' }
        });

        await rig.run(12);

        // 1 sample + the 3-attempt allowance = 4 attempts, every one a failed run.
        expect(runs(rig, 'wi_sample_summary_1_1')).toEqual([
            'wi_sample_summary_1_1_1:failed',
            'wi_sample_summary_1_1_2:failed',
            'wi_sample_summary_1_1_3:failed',
            'wi_sample_summary_1_1_4:failed'
        ]);
        expect(rig.store.revisions.list()).toEqual([]);

        // ONE escalation row, addressed to the Author, reused across sweeps rather than re-queued.
        const escalation = rig.store.tasks.list().find((task) => task.kind === 'escalation');

        expect(escalation).toMatchObject({
            kind: 'escalation',
            owner_role: 'author',
            state: 'open',
            title: `${SAMPLING_FAILURE_PREFIX} 4 attempts — the provider is not returning valid SummarySample JSON`
        });

        // Generation has stopped offering samples: nothing more is bought on later sweeps.
        expect(
            generateWork(rig.store, rig.store.stories.require(rig.storyId), {
                at: new Date().toISOString(),
                phase: 'summary'
            }).some((candidate) => candidate.key.startsWith('wi_sample_'))
        ).toBe(false);
    });
});

describe('§6.4 step 6 — the deep review runs on the SELECTED revision, with tools', () => {
    it('points every Reader pass at the winner, rotating only the four review angles', async () => {
        const rig = await createRig({ summarySampling: 2, summaryReaders: 3 });

        await rig.run();

        const reviews = [...rig.items.values()].filter((item: WorkItem) => (item.id ?? '').startsWith('wi_review_'));

        expect(reviews.map((item) => item.id)).toEqual([
            'wi_review_revision_1_a1',
            'wi_review_revision_1_a2',
            'wi_review_revision_1_a3'
        ]);
        expect(reviews.map((item) => item.revisionRef)).toEqual(['revision_1', 'revision_1', 'revision_1']);
        // §14 item 10's four angles, and NEVER the one-turn screening template: a deep-review pass
        // holds the tool catalogue, and `reader-screening` is the no-tool mode.
        expect(reviews.map((item) => item.templateRef)).toEqual([
            'reader-genre',
            'reader-plausibility',
            'reader-audience'
        ]);
        expect(reviews.map((item) => item.roleName)).toEqual(['reader', 'reader', 'reader']);
        expect(reviews.map((item) => item.toolMode ?? 'tools')).toEqual(['tools', 'tools', 'tools']);
    });

    it('reaches the phase sign-off on a round whose deep review found nothing', async () => {
        const rig = await createRig({ summarySampling: 1, summaryReaders: 1 });

        await rig.run();

        const story = rig.story();

        expect({ phase: story.phase, status: story.status, pending: story.pending_kind }).toEqual({
            phase: 'summary',
            status: 'pending',
            pending: 'phase_signoff'
        });
        // One selected Summary revision, no competing drafts, nothing queued: L-29's gate holds.
        expect(
            rig.store.revisions.list().map((revision) => `${revision.id}:${revision.state}`)
        ).toEqual(['revision_1:selected']);
        expect(rig.store.tasks.list()).toEqual([]);
    });
});

describe('§6.8 — the refinement loop: a fix task arms round 2, whose selection consumes it', () => {
    it('samples round 2 from the base revision and the open tasks, then marks the task done', async () => {
        const rig = await createRig({ summarySampling: 1, summaryReaders: 1 });

        await rig.run();

        const summary = summaryOf(rig);
        const selected = rig.store.revisions.list().find((revision) => revision.state === 'selected');

        if (selected === undefined) throw new Error('the rig has no selected Summary revision');

        // The deep review's finding, verified+approved by the Editor, and the task D-34's approval
        // created: exactly the records that arm the next round (`records.ts:samplingArmed`).
        const finding = seedFinding(rig.store, rig.storyId, {
            target_ref: summary.id,
            criterion_ref: 'C-14',
            cost: 'major',
            state: 'approved',
            fingerprint: 'C-14|summary_1',
            related_refs: [selected.id]
        });
        const task = seedTask(rig.store, rig.storyId, {
            kind: 'fix',
            title: 'fix major: the ending does not pay the promise',
            detail: `C-14 on ${summary.id} · ${summary.id}`,
            owner_role: 'writer',
            finding_ref: finding.id
        });

        const armed = generateWork(rig.store, rig.store.stories.require(rig.storyId), {
            at: new Date().toISOString(),
            phase: 'summary'
        });
        const sample = armed.find((candidate) => candidate.key.startsWith('wi_sample_'));

        // The round number rides the item because the prompt compiler cannot derive it (§6.8): round 2
        // reads the PREVIOUS round's selected revision and the open tasks.
        expect({ key: sample?.key, round: sample?.item.round, sampleIndex: sample?.item.sampleIndex }).toEqual({
            key: 'wi_sample_summary_1_2_1',
            round: 2,
            sampleIndex: 1
        });

        await rig.run();

        // Round 2's sample is `refined` (round 1's was `sampled`), and it is the selected one.
        expect(
            rig.store.revisions
                .list()
                .map((revision) => `${revision.id}:r${revision.round}:${revision.origin}:${revision.state}`)
        ).toEqual(['revision_1:r1:sampled:selected', 'revision_2:r2:refined:selected']);

        // §6.8: the round's prompt carried the task, so the resample answers it — done, and the finding
        // closes with its task (a re-raise would read as a regression, L-16a).
        expect(rig.store.tasks.require(task.id).state).toBe('done');
        expect(rig.store.findings.require(finding.id).state).toBe('fixed');

        const story = rig.store.stories.require(rig.storyId);

        expect(story.sampling_round).toBe(2);
        expect((story.sampling_history ?? []).map((entry) => `${entry.round}:${entry.selected}`)).toEqual([
            '1:revision_1',
            '2:revision_2'
        ]);

        // The round-2 prompt really carried the base revision and the fix task (§6.8's compiled input).
        const roundTwo = rig.requests.find(
            (request) =>
                request.messages.some((message) => message.content.includes('## BASE REVISION')) &&
                request.messages.some((message) => message.content.includes('## FIX TASKS'))
        );

        expect(roundTwo?.messages.map((message) => message.content).join('\n\n')).toContain(task.title);
    });
});
