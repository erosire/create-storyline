/**
 * PHRASE ② at the LOOP layer (wave T-W2) — the chapter lane as the planner BOOKS it and as the drain
 * probe REPORTS it, on the rig's mock crew.
 *
 * What the neighbours prove, and why only this file can prove this:
 *
 *   `phrase/plotlines.test.ts`               — the three domain operations (start → brief → accept) and
 *                                              the install's mirror onto the `plotlines` rows, with every
 *                                              id handed to the controller;
 *   `integration/plotlines-groups.test.ts`   — the same pipeline with a REAL server, a real crew, and the
 *                                              defect round-trip; slow, and it can only say what the whole
 *                                              Story ended up doing;
 *   `run/phase1-prompt-plotlines.test.ts`    — the bytes of the four compiled Phrase ② turns;
 *   THIS FILE                                — the PLANNER's decisions in isolation: which candidate exists
 *                                              in which state, under which claim key, with which unit, and
 *                                              what the Author's drain row says while the lane is owed.
 *
 * WHY `phase2GroupCandidates` IS CALLED DIRECTLY. `generateWork` also runs the classic phase-② legs, and
 * those legs carry their own gates (units, findings, the drain probes); a lane assertion made through it
 * would be a statement about whichever classic leg happened to sort first. The one test that DOES go
 * through `generateWork` (the last block) is the one whose subject is the switch itself.
 *
 * EXACT VALUES: ids are the rig's, read out of the book and hashed with the same helpers the planner uses
 * (`phrase/revisions.ts`, `phrase/exclusion.ts`, `loop/records.ts`), never copied off a transcript. The
 * drain clauses are pinned as literal sentences because that string IS the product — it is the line the
 * Author reads to know whose step is next.
 */
import { describe, expect, it } from 'vitest';

import { createRig, walkTo } from './mock';
import { generateWork, needsReader, phase2GroupCandidates } from './work';
import { drainPreconditions } from './status';
import { plotlinePhraseSeedHashOf, plotlinesStructureKeyOf } from './records';
import { AUTHOR_ATTR } from '../run/mock';
import { storyPhraseByKey } from '../phrase/catalog';
import { acceptPlotlineBrief, createPlotlineBrief, startPlotlinesPhrase } from '../phrase/controllers/plotlines';
import {
    groupCheckSeatKey,
    groupDraftClaimRef,
    groupReviewSeatKey,
    sectionScoreClaimKey
} from '../phrase/exclusion';
import { groupRevisionVector, groupVectorHash, installGroupRevisions } from '../phrase/revisions';
import { cleanSelectionOf } from '../phrase/reviewed';
import { PHRASE_PLOTLINES_KEY, PHRASE_SUMMARY_KEY } from '../../shared/phrase';
import type { Rig } from './mock';
import type { Phrase, PhraseGroup, Story } from '../../shared/types';

/** The clause `loop/status.ts:phase2Unmet` writes for a book that has the phase but not the phrase. */
const UNSTARTED_CLAUSE =
    'Phrase ② has not been started — the compiled Summary (or the Author’s own text) has to be pushed into the Plotlines Phrase before any chapter contract is drafted (R1, one phrase down)';

/** The clause for a started phrase whose chapter COUNT nobody has declared yet. */
const NO_BRIEF_CLAUSE =
    'no accepted Plotline Brief declares the chapter count — the Editor has not structured the Phrase ② seed yet (P5, D-3b)';

/** A Story walked through phase ① and locked into phase ②, on the GROUP model with one Critic pass. */
const laneRig = async (): Promise<Rig> => {
    const rig = await createRig({ summaryMode: 'groups', summarySampling: 5, summaryCritics: 1 });

    await walkTo(rig, 'plotlines');
    await rig.engine.lockPhase(rig.storyId, 'summary');

    expect(rig.story().phase).toBe('plotlines');

    return rig;
};

/** The Author's act the loop cannot do for itself: push the compiled Summary into Phrase ②. */
const startLane = (rig: Rig) => {
    const summary = storyPhraseByKey(rig.store, rig.storyId, PHRASE_SUMMARY_KEY)!;
    const started = startPlotlinesPhrase(rig.store, rig.story(), summary.content, AUTHOR_ATTR);

    expect(started.phrase.key).toBe(PHRASE_PLOTLINES_KEY);

    return { phrase: started.phrase, story: rig.story() };
};

/** The compiled Summary Phrase ② was seeded from — the text the structure note has to carry verbatim. */
const seedTextOf = (rig: Rig): string => storyPhraseByKey(rig.store, rig.storyId, PHRASE_SUMMARY_KEY)!.content;

/** Started PLUS a declared chapter set: the state the draft batch is cut against. */
const structureLane = (rig: Rig, chapterCount = 3) => {
    const { phrase, story } = startLane(rig);
    const brief = createPlotlineBrief(rig.store, story, phrase, { chapter_count: chapterCount }, AUTHOR_ATTR);
    const accepted = acceptPlotlineBrief(rig.store, rig.story(), brief, AUTHOR_ATTR);

    return { phrase, brief, chapters: accepted.groups, story: rig.story() };
};

/** The lane's chapter entries, in the order the accept step materialized them. */
const chaptersOf = (rig: Rig, phrase: Phrase): PhraseGroup[] =>
    rig.store.phraseGroups
        .list()
        .filter((group) => group.phrase_id === phrase.id)
        .sort((left, right) => left.order - right.order);

/** The lane's candidates as the planner's own tuples: kind, claim key, unit, and the crew it bound. */
const laneJobs = (rig: Rig, story: Story) =>
    phase2GroupCandidates(rig.store, story).map((job) => ({
        kind: job.item.kind,
        key: job.key,
        unit: job.item.unit,
        role: job.item.roleName,
        template: job.item.templateRef,
        refs: (job.item.groupRefs ?? []).length,
        why: job.why
    }));

describe('a Phrase ② the Author has not started', () => {
    it('generates no lane work, and the drain names the Author as the next move', async () => {
        const rig = await laneRig();
        const story = rig.story();

        // The lane's whole candidate list is empty — not "deprioritised". The loop cannot invent the seed
        // the chapters are read from, so a book with the phase but not the phrase has no chapter work at all.
        expect(laneJobs(rig, story)).toEqual([]);

        // And the drain probe says so in the Author's words. The array is pinned WHOLE: a second clause
        // appearing here means a lane leg started claiming the phase while no seed existed to draft against.
        expect(drainPreconditions(rig.store, story)).toEqual({ met: false, unmet: [UNSTARTED_CLAUSE] });
    });

    it('says nothing on a classic book, whose phase ② always ran the §4.3 tools', async () => {
        const rig = await laneRig();

        const story = rig.store.stories.update(
            rig.storyId,
            { plotlines_mode: 'classic' },
            AUTHOR_ATTR,
            [{ id: rig.storyId, rev: rig.story().rev }]
        );

        expect(phase2GroupCandidates(rig.store, story)).toEqual([]);
        // The clause is a lane statement. An Author who put the book back on the classic path must not be
        // told to start a phrase the pipeline it runs never reads (R6 — the switch is a setting, both
        // values are supported, and neither value may inherit the other's obligations).
        expect(drainPreconditions(rig.store, story).unmet).toEqual([]);
    });
});

describe('the structure gate: nothing below it is answerable', () => {
    it('offers one priority-0 structuring job on its own family, and refuses every other lane job', async () => {
        const rig = await laneRig();
        const { phrase, story } = startLane(rig);

        expect(chaptersOf(rig, phrase)).toEqual([]);

        // The lane is EXACTLY this one job while the chapter count is undeclared — no draft batch (no entry
        // set), no review seat (no installed text), no score seat, no lock seat, no deep pass.
        expect(laneJobs(rig, story)).toEqual([
            {
                kind: 'structure_seed',
                key: plotlinesStructureKeyOf(phrase, story),
                unit: undefined,
                role: 'editor',
                template: 'editor-plotlines-structure',
                refs: 0,
                why: 'structure the Plotlines Phrase seed into a chapter set before any contract is drafted (P5, D-3b)'
            }
        ]);

        // A DIFFERENT family from phase ①'s `wi_structure_seed_<seed hash>`, even though the two phrases
        // hold the SAME text here (the seed Phrase ② was given is the compiled Summary): one family would
        // let phase ①'s accepted structuring silently satisfy Phrase ② and skip the chapter set entirely.
        expect(plotlinesStructureKeyOf(phrase, story)).toBe(
            `wi_structure_plotlines_${plotlinePhraseSeedHashOf(phrase, story)}`
        );
        expect(plotlinesStructureKeyOf(phrase, story)).not.toBe(
            `wi_structure_seed_${plotlinePhraseSeedHashOf(phrase, story)}`
        );

        // The seed and its hash travel in the note because the briefing renders the note and
        // `tools/plotlines.ts:structurePlotlines` refuses a hash it did not print.
        const note = phase2GroupCandidates(rig.store, story)[0]!.item.note ?? '';

        expect(note).toContain(`PHRASE SEED (seed_hash=${plotlinePhraseSeedHashOf(phrase, story)}):\n${seedTextOf(rig)}`);

        expect(drainPreconditions(rig.store, story)).toEqual({ met: false, unmet: [NO_BRIEF_CLAUSE] });
    });

    it('generates nothing when an accepted brief has no entries — the accept step is the only writer', async () => {
        const rig = await laneRig();
        const { phrase, story } = structureLane(rig);

        // The state a store restored from before the entries existed is in. The lane refuses to plan around
        // it: re-cutting the structuring job is meaningless (the brief is accepted) and a draft batch over
        // an empty set would install nothing, so the honest answer is no work and a phase that holds.
        for (const group of chaptersOf(rig, phrase)) rig.store.phraseGroups.delete(group.id, AUTHOR_ATTR);

        expect(chaptersOf(rig, phrase)).toEqual([]);
        expect(laneJobs(rig, rig.story())).toEqual([]);
    });
});

describe('the draft batch: the lane installs the chapter contracts', () => {
    it('cuts one batch over the whole chapter set, under the phrase row id, with no unit', async () => {
        const rig = await laneRig();
        const { phrase, chapters, story } = structureLane(rig);

        const claimRef = groupDraftClaimRef(rig.store, story, phrase.id);
        const family = `wi_draft_groups_${claimRef}_${groupVectorHash(Object.fromEntries(chapters.map((g) => [g.id, 0])))}`;

        // THE CLAIM REF IS THE PHRASE ROW, not the `summaries` row (seam S8). The Summary's batches are
        // `wi_draft_groups_summary_0_…`, so the two phrases on one book can never spend each other's
        // attempts, and a restart reproduces each family from its own rows.
        expect(claimRef).toBe(phrase.id);

        expect(laneJobs(rig, story)).toEqual([
            {
                kind: 'draft_groups',
                key: `${family}_1`,
                // The batch's artifact is the SET of contracts, so the Work Item carries NO unit
                // (architecture point 7): `wholeStoryUnit('plotlines')` is what a multi-chapter job means,
                // and naming one chapter here would brief the Writer on one contract while asking for three.
                unit: undefined,
                role: 'writer',
                template: 'writer-plotlines-sampler',
                refs: 3,
                why: 'rewrite 3 chapter contract(s) — chapter_1, chapter_2, chapter_3 — in one structured pass (R2, R5)'
            }
        ]);

        // The answer contract comes from the CONTROLLER (seam S12): a chapter answer is plotpoints, and the
        // arity the engine checks is the materialized chapter set — not the catalog's five sections.
        const job = phase2GroupCandidates(rig.store, story)[0]!.item;

        expect([job.toolMode, job.responseSchema?.name]).toEqual(['none', 'ChapterDraft']);
        expect(job.groupRefs).toEqual(chapters.map((group) => group.id));
    });

    it('installs every chapter and mirrors it onto its `plotlines` row by order', async () => {
        const rig = await laneRig();
        const { phrase, chapters } = structureLane(rig);

        await rig.run();

        // The crew's scripted `ChapterDraft` answer installed all three chapters: the arity is the
        // materialized set, and a batch that skipped one would have been refused atomically.
        expect(chaptersOf(rig, phrase).map((group) => [group.key, group.revision])).toEqual([
            ['chapter_1', 1],
            ['chapter_2', 1],
            ['chapter_3', 1]
        ]);

        // The mirror is the reason the lane can coexist with the classic §4.3 path: phase ③ and the Goals
        // keep reading ONE artifact, the `plotlines` table, ordered as the brief declared it.
        const mirrors = rig.store.plotlines
            .list()
            .filter((row) => row.story_id === rig.storyId)
            .sort((left, right) => left.order - right.order);

        // ONE row per chapter, at the order the brief declared, and each one carries THAT chapter's text —
        // the mock's answer is worded off the group ref the job named, so the id inside the sentence proves
        // the mirror came from this install rather than from another chapter's contract.
        expect(mirrors.map((row) => [row.order, row.must_happen])).toEqual([
            [1, `What ${chapters[0]!.id} has to put on the page: the event the chapter exists to deliver.`],
            [2, `What ${chapters[1]!.id} has to put on the page: the event the chapter exists to deliver.`],
            [3, `What ${chapters[2]!.id} has to put on the page: the event the chapter exists to deliver.`]
        ]);

        // The seats the install re-armed. Phase ① ran its OWN seats on this same Story before the lock, so
        // the book now holds TWO phrases' seat rows, and the only thing that separates them is the vector:
        // a Summary seat is keyed by the five summary group ids, a chapter seat by the three chapter
        // entries. Pinning both sets, side by side, is the claim-key disjointness rule (R3/R5) made visible
        // — one shared family, two hashes, and no seat that can answer for the other phrase's text.
        const writtenHash = groupVectorHash(Object.fromEntries(chapters.map((group) => [group.id, 1])));
        const summaryHash = groupVectorHash(groupRevisionVector(rig.store, rig.storyId));

        expect(summaryHash).not.toBe(writtenHash);

        const seatRows = (hash: string) =>
            rig.store.runs
                .list()
                .filter((run) =>
                    [groupReviewSeatKey(hash, 1), groupCheckSeatKey(hash, 1)].includes(String(run.work_item_ref ?? ''))
                )
                .map((run) => `${run.work_item_ref}[${run.role}]`);

        expect(seatRows(writtenHash)).toEqual([
            `${groupReviewSeatKey(writtenHash, 1)}[critic]`,
            `${groupCheckSeatKey(writtenHash, 1)}[critic]`
        ]);
        expect(seatRows(summaryHash)).toEqual([
            `${groupReviewSeatKey(summaryHash, 1)}[critic]`,
            `${groupCheckSeatKey(summaryHash, 1)}[critic]`
        ]);
        // The lane's seat rows are keyed by the CHAPTER hash and by nothing else — a chapter seat that
        // claimed the Summary's vector would read the wrong five sections and call them a chapter set.
        expect(seatRows(writtenHash).join(' ')).not.toContain(summaryHash);
    });
});

describe('the Reader score seat is armed by the PHRASE clean selection', () => {
    it('claims the chapter vector, and never the Summary clean selection beside it', async () => {
        const rig = await laneRig();
        const { phrase, story } = structureLane(rig);

        await rig.run();

        const chapterReviewed = cleanSelectionOf(rig.store, story, phrase.id);
        // Unscoped, this is the SUMMARY's clean selection — the read that would arm a chapter seat against
        // text the chapters never held (the bug the phrase argument exists to prevent).
        const summaryReviewed = cleanSelectionOf(rig.store, story);

        expect(chapterReviewed.complete).toBe(true);
        expect(chapterReviewed.vector_hash).toBe(
            groupVectorHash(groupRevisionVector(rig.store, rig.storyId, phrase.id))
        );
        // Two phrases, two clean selections, two different hashes — the Summary's was stamped rounds ago and
        // says nothing about whether chapter 2's contract survived a cross-chapter pass.
        expect(summaryReviewed.vector_hash).not.toBe(chapterReviewed.vector_hash);

        const scoreSeats = phase2GroupCandidates(rig.store, rig.story())
            .filter((job) => job.item.kind === 'score_sections')
            .map((job) => ({
                key: job.key,
                template: job.item.templateRef,
                refs: (job.item.groupRefs ?? []).length,
                rank: job.rank
            }));

        expect(scoreSeats).toEqual([
            {
                key: sectionScoreClaimKey(chapterReviewed.vector_hash),
                template: 'reader-consistency',
                refs: 3,
                rank: -1
            }
        ]);
        expect(scoreSeats[0]!.key).not.toBe(sectionScoreClaimKey(summaryReviewed.vector_hash));
    });
});

describe('the hybrid switch in `generateWork`', () => {
    it('offers the lane through the real generator, and never the Editor’s choice', async () => {
        const rig = await laneRig();

        structureLane(rig);

        // BEFORE the install the lane is the only thing phase ② can offer: the classic §4.3 legs act on
        // `plotlines` rows, and the rows this book will read are created by the install that has not run
        // yet. Pinning the whole array is what makes "the lane silently replaced phase ②'s queue" visible.
        const before = generateWork(rig.store, rig.story(), { at: new Date().toISOString(), phase: 'plotlines' });

        expect(before.map((job) => job.item.kind)).toEqual(['draft_groups']);

        await rig.run();

        // AFTER the install the queue is still the lane's — the contracts now exist, so the seat that reads
        // them is armed, and the one classic claim this pipeline removes is absent by CONSTRUCTION, not by
        // priority. `select` is an Editor choosing between competing drafts; in this model the install IS
        // the choice (R5), so the claim must never appear rather than dispatch a run whose answer would
        // overwrite an installed contract.
        const after = generateWork(rig.store, rig.story(), { at: new Date().toISOString(), phase: 'plotlines' });

        expect(after.map((job) => job.item.kind)).toEqual(['score_sections']);
        expect(after.filter((job) => String(job.key).startsWith('wi_select_'))).toEqual([]);
        // And it stays absent through the whole phase, whatever the crew answers: the ledger is the proof.
        expect(
            rig.store.runs
                .list()
                .filter((run) => String(run.work_item_ref ?? '').startsWith('wi_select_'))
                .map((run) => run.work_item_ref)
        ).toEqual([]);
    });
});

// ── T-W2b — THE CHAPTER CONTRACT HAS ONE WRITING SURFACE (R2) ─────────────────────────────────
//
// WHAT THIS BLOCK HOLDS, and why the file's earlier blocks cannot: they pin what the lane OFFERS. The
// correction T-W2b made is about what phase ② no longer offers — the classic `write_unit` pair, in both
// of its shapes — and about the consequence of removing it: the artifact is now written by an INSTALL,
// which the reader gate used to read as "nobody has written this yet". Three claims, one per test:
//
//   1. `needsReader` sees the lane's install as the write. Its run-ledger test looks for a
//      `wi_write_<unit>_*` run, and on this dial there never is one — the `draft_groups` batch installs
//      the chapter ENTRY and `phrase/plotpoints.ts:syncPlotlineContract` mirrors it onto the row in the
//      install's commit, under a claim key that names the PHRASE row. Answering `false` left every
//      contract unjudged: no reader pass, no C-2/C-3 verdict lines at the row, and a phase Goal that
//      could not complete. The flag is a PARAMETER (`installedByPhrase`), so this predicate stays
//      byte-for-byte the old answer for every book that does not run the lane;
//   2. the ledger says it: the reader legs ran and no `wi_write_*`, `wi_fix_*` or `wi_select_*` claim
//      ever opened, on a book that walked the whole lane;
//   3. an approved defect on a contract row arms the chapter ENTRY (the layer-2 join: `group_refs` is
//      what `phrase/exclusion.ts:groupWorkTargets` arms a redraft from), and the same book on
//      `plotlines_mode: 'classic'` still gets the classic Writer fix pass — the filter is keyed on the
//      per-phrase dial and on the JOB'S KIND, never on `story.phase`.
describe('the chapter contract has one writing surface in phase ② (T-W2b)', () => {
    /** The Story's contract rows in `order` — the artifact the classic legs act on. */
    const contractRows = (rig: Rig) =>
        rig.store.plotlines
            .list()
            .filter((row) => row.story_id === rig.storyId)
            .sort((left, right) => left.order - right.order);

    /** The generator's claim keys, in queue order, for the phase the Story is in. */
    const claimKeys = (rig: Rig) =>
        generateWork(rig.store, rig.story(), { at: new Date().toISOString(), phase: 'plotlines' }).map((job) => job.key);

    it('treats the lane install as the write that arms the reader', async () => {
        const rig = await laneRig();
        const { chapters } = structureLane(rig);

        // A HAND install: the same commit the lane's batch makes — entry text, `group_revisions` row, and
        // the `plotlines` mirror — with NO crew run behind it. That absence is the whole point: the run
        // ledger holds nothing naming a contract unit, which is the state `needsReader` used to answer
        // `false` for. (The lane's own batch was pinned in the block above; here the install is direct so
        // the reader gate is the only thing under test.)
        installGroupRevisions(
            rig.store,
            rig.story(),
            chapters.map((group) => ({
                group,
                content: `${group.key}: the installed contract.`,
                plotpoints: {
                    must_happen: `chapter ${group.order} reaches the dam gate`,
                    must_change: `the valley is flooded on purpose by chapter ${group.order}`
                }
            })),
            AUTHOR_ATTR,
            { runRef: null }
        );

        // The mirror ran with the install: three rows, one per entry, in the order the brief declared.
        expect(contractRows(rig).map((row) => row.order)).toEqual([1, 2, 3]);
        const [first] = contractRows(rig);
        // No run names the unit, so the ledger-only answer is still `false` — the pre-T-W2b reading, kept
        // honest for the classic book that reaches this function with the flag off.
        expect(
            rig.store.runs.list().filter((run) => String(run.work_item_ref ?? '').startsWith(`wi_write_${first.id}`))
        ).toEqual([]);
        expect(needsReader(rig.store, rig.story(), first.id)).toBe(false);
        // With the phrase's own record of the write (`PhraseGroup.revision > 0`, which is what the caller
        // reads), the unit needs judging — and nothing has judged it.
        expect(needsReader(rig.store, rig.story(), first.id, true)).toBe(true);

        // THE GENERATOR SUPPLIES THE FLAG ITSELF. The caller is `generateWork`, which has the phrase dial
        // and the entry rows, so the queue is the proof that the flag is not a caller's courtesy: one
        // reader pass per contract row, in each row's own `wi_check_<row>_<gen>_unit` family.
        expect(claimKeys(rig).filter((key) => key.startsWith('wi_check_'))).toEqual(
            contractRows(rig).map((row) => `wi_check_${row.id}_1_unit`)
        );
        // And no writing surface beside them: the blind draft pair is not offered for a contract unit.
        expect(claimKeys(rig).filter((key) => key.startsWith('wi_write_'))).toEqual([]);
    });

    it('walks the whole lane with no classic write or fix claim on the ledger', async () => {
        const rig = await laneRig();

        structureLane(rig);
        await rig.run();

        const claims = rig.store.runs.list().map((run) => String(run.work_item_ref ?? ''));

        // THE BLIND DRAFT PAIR. Before the correction this book ran `wi_write_plotline_<n>_1_a<n>` twice
        // per chapter (`Temp/w2b/probe-before.out`: 6 runs) and each pass was refused into the ledger as a
        // phantom T-4/T-11, because the order it wrote was the one the install already held.
        expect(claims.filter((claim) => claim.startsWith('wi_write_'))).toEqual([]);
        // THE FINDING-ARMED FIX PAIR — `wi_fix_<unit>_*`, the other classic `write_unit` shape.
        expect(claims.filter((claim) => claim.startsWith('wi_fix_'))).toEqual([]);
        // The Editor's choice between competing drafts, which T-W2 removed and this wave keeps removed.
        expect(claims.filter((claim) => claim.startsWith('wi_select_'))).toEqual([]);
        // THE READING LEGS, which the hybrid keeps: one consistency pass per contract row, dispatched from
        // the install. Without layer 1c these three rows are absent from the ledger and the phase Goal
        // stalls at 5/7 (`Temp/w2b/probe-after2.out`), because nothing ever judged C-2 or C-3.
        expect(claims.filter((claim) => claim.startsWith('wi_check_'))).toEqual(
            contractRows(rig).map((row) => `wi_check_${row.id}_1_unit`)
        );
    });

    it('arms the owed chapter entry for an approved contract defect, and the classic dial its Writer pass', async () => {
        const rig = await laneRig();
        const { phrase, chapters } = structureLane(rig);

        await rig.run();

        const row = contractRows(rig)[0];
        const entry = chapters.find((group) => group.order === row.order)!;

        // The shape `tools/reader.ts:raiseFinding` now files: the defect is ON the contract ROW (that is
        // what the reader was shown), and its `group_refs` name the ENTRY whose revise path can close it.
        const finding = rig.store.findings.create(
            {
                story_id: rig.storyId,
                target_ref: row.id,
                criterion_ref: 'C-7',
                title: 'chapter 1 never reaches the dam gate',
                detail: 'the contract never delivers the gate the Ending depends on',
                evidence: `${row.id} must_happen: no dam gate`,
                cost: 'critical',
                kind: 'issue',
                state: 'approved',
                approved_by: 'Author',
                fingerprint: 'phase2-groups:contract-defect',
                seen_count: 1,
                group_refs: [entry.id]
            },
            AUTHOR_ATTR
        );

        // ONE job answers it, and it is the lane's: the batch over the owed entry, carrying the finding.
        // `phrase/exclusion.ts:groupWorkTargets` arms a group from `findingGroupsStillOwed`, so the entry
        // id in `group_refs` is the join — an unscoped row would have armed all three contracts instead.
        const jobs = generateWork(rig.store, rig.story(), { at: new Date().toISOString(), phase: 'plotlines' });

        expect(jobs.map((job) => `${job.key}[${job.item.kind}]`)).toEqual([
            `wi_draft_groups_${phrase.id}_${groupVectorHash({ [entry.id]: 0 })}_1[draft_groups]`
        ]);
        expect([jobs[0].item.groupRefs, jobs[0].item.findingRefs, jobs[0].priority]).toEqual([
            [entry.id],
            [finding.id],
            2
        ]);
        // No `wi_fix_plotline_*` beside it: a Writer pass on the mirrored row is not how this book fixes a
        // contract, and its `editPlotline` write is refused (R6) — the refusal ledger below is the proof.
        expect(jobs.filter((job) => String(job.key).startsWith('wi_fix_'))).toEqual([]);

        // THE DIAL, NOT THE ROWS, IS THE SWITCH. Same installed rows, same installed entries, same approved
        // finding — `plotlines_mode: 'classic'` alone puts the classic fix pass back, which is what keeps
        // every pre-lane book working and shows the filter is one clause rather than a phase check.
        rig.store.stories.update(
            rig.storyId,
            { plotlines_mode: 'classic' },
            { run_ref: null, author: true, why: 'T-W2b pin: the classic dial keeps its classic Writer' },
            [{ id: rig.storyId, rev: rig.story().rev }]
        );

        expect(
            generateWork(rig.store, rig.story(), { at: new Date().toISOString(), phase: 'plotlines' }).map(
                (job) => `${job.key}[${job.item.kind}]`
            )
        ).toEqual([`wi_fix_${row.id}_1_${finding.id}_[write_unit]`]);
    });
});
