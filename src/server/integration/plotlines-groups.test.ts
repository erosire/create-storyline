// PHRASE ② — the chapter group pipeline, end to end through the REAL server (wave T-W2).
//
// WHAT THIS FILE IS FOR, as distinct from the unit files beside it:
//
//   `phrase/plotlines.test.ts`      — the controller's three domain operations (start → structure →
//                                     accept) against a seeded store, where every id is handed to it;
//   `run/phase1-prompt.test.ts`     — the exact bytes of the four compiled Phrase ② turns;
//   `loop/work.test.ts` (the T-W2 block) — the candidate gates, the claim-key families, and the
//                                     classic legs the lane keeps;
//   THIS FILE                       — the pipeline nobody can seed: the chapter set is DECLARED by an
//                                     Editor run's tool call, the contracts are installed by a Writer
//                                     batch the loop cut by itself, the defect is FILED by the deep
//                                     review's `raiseFinding`, and the lock that opens phase ③ is the
//                                     Author's answer to a sign-off the Story reached on its own.
//
// WHY THE PHRASE START SITS IN THE TEST AND NOT IN THE LOOP. `startPlotlinesPhrase` is an Author act:
// the seed Phrase ② reads is the compiled Summary the phase-① lock produced (`phrases.content`), copied
// into the phrase row so the two phrases stay discrete (R1, "one phrase down"). The API route that hands
// it over is the NEXT wave; the server-side truth this test pins is what the loop does once the row
// exists — and what it refuses to do before it does (the drain clause in `loop/status.ts:phase2Unmet`).
//
// WHAT IS PINNED AS A NUMBER AND WHY IT MAY BE ONE: the ids are real UUIDs issued per boot, so every
// claim key is RECOMPUTED from the store's rows through the same helpers the planner uses
// (`records.ts:plotlinesStructureKeyOf`, `exclusion.ts:groupDraftClaimRef`, `revisions.ts:groupVectorHash`)
// — no hash is copied off a run. The lane's ledger is pinned as the SET of families it opened, with the
// crew each one ran under, because that is the part a regression moves: a seat that stops running, a job
// that binds the wrong crew, or a chapter job that lands under a Summary claim family all change the set.
//
// THE CLASSIC LEGS ARE PART OF THE LEDGER ON PURPOSE, and T-W2b says WHICH ones. The wave's design is a
// HYBRID: the lane adds the structure/draft/review/score/lock legs and keeps the classic VERIFICATION
// legs (`check_unit`, `verify_findings`, the drain probes) running on the SAME `plotlines` rows the
// install mirrors, while the Editor's `select` choice — the one thing this pipeline removes — goes away.
// The classic WRITE legs go too (R2: one writing surface per entry): the chapter contract IS installed by
// the lane's batch, so no `wi_write_plotline_*` or `wi_fix_plotline_*` claim exists on this dial, and the
// §8.1 tools refuse a write into a mirrored row. The reader's verdict lines are what complete the phase
// Goal now — the install is the write it judges — which is why the ledger below pins `wi_check_*` rows and
// an EMPTY `wi_write_*` set, and why the mirror assertions read the rows the install wrote.
import { describe, expect, it } from 'vitest';
import { bootStoryline, createSliceStory, crewRows, openDial, storyRow, type StorylineFixture } from './harness';
import { startPlotlinesPhrase } from '../phrase';
import { PHRASE_PLOTLINES_KEY, PHRASE_SUMMARY_KEY } from '../../shared/phrase';
import { drainPreconditions } from '../loop/status';
import { plotlinesStructureKeyOf } from '../loop/records';
import { groupDraftClaimRef, groupCheckSeatKey, groupReviewSeatKey } from '../phrase/exclusion';
import { groupRevisionVector, groupVectorHash } from '../phrase/revisions';
import { cleanSelectionOf } from '../phrase/reviewed';
import type { Store } from '../store/store';

/** Every run row as `claim key[template/role]=state`, in dispatch order. */
const runLines = async (fixture: StorylineFixture, storyId: string): Promise<string[]> =>
    (await crewRows(fixture, storyId)).map((row) => `${row.work_item_ref}[${row.template_ref}/${row.role}]=${row.state}`);

/** One Story's chapter entries, in the order the pipeline materialized them (`phrase_groups.order`). */
const chapterGroupsOf = (store: Store, phraseId: string) =>
    store.phraseGroups
        .list()
        .filter((group) => group.phrase_id === phraseId)
        .sort((left, right) => left.order - right.order);

/** The Story's `plotlines` contract rows, in `order` — the artifact phase ③ reads (D-3b). */
const plotlinesOf = (store: Store, storyId: string) =>
    store.plotlines
        .list()
        .filter((row) => row.story_id === storyId)
        .sort((left, right) => left.order - right.order);

/** Walks ticks until `stop` holds, so a step reads one coherent sweep boundary. */
async function settle(fixture: StorylineFixture, stop: () => boolean | Promise<boolean>, max = 60): Promise<boolean> {
    for (let round = 0; round < max; round += 1) {
        if (await stop()) return true;
        await fixture.tick();
    }

    return false;
}

describe('PHRASE ② — the chapter group pipeline, from the Summary lock to the chapter lock', () => {
    it('structures the phrase seed, installs the chapter contracts, answers a chapter defect, and locks the phase', async () => {
        // The crew is the harness's default cooperative one, with two decisions scripted: the chapter
        // COUNT the Editor's `structurePlotlines` call declares (3 — the number the Author asked the
        // Story for, so a lane switch cannot silently change the book's shape), and ONE round of defect
        // from the deep review: it files while no chapter has been revised twice, and goes clean after
        // the redraft, so the ladder terminates instead of grinding to the attempt cap.
        const fixture = await bootStoryline({
            criticIdeas: 0,
            plotlineChapters: () => 3,
            // THE CREW SCRIPT, and why the defect is gated on `ctx.chapterPass`: the seat that files a
            // chapter defect is the deep cross-chapter review, and the harness recognizes it from the sweep
            // note `loop/work.ts` writes (`Critic pass N/M on the installed chapter contracts at vector …`).
            // Gating on it rather than on "the story is in phase ②" keeps phase ①'s review clean — a
            // fixture that filed in both phases would hold the Summary open over a defect that is not its
            // artifact, and the Summary level would never pass. The predicate then files EXACTLY ONE
            // round: once any chapter has been redrawn (revision ≥ 2) the pass goes clean, so the ladder
            // terminates instead of grinding to the attempt cap.
            criticFinds: (ctx) => {
                if (!ctx.chapterPass) return undefined;

                const phrase = ctx.store.phrases
                    .list()
                    .find((row) => row.story_id === ctx.story?.id && row.key === PHRASE_PLOTLINES_KEY);

                if (phrase === undefined) return undefined;

                const redrafted = ctx.store.phraseGroups
                    .list()
                    .some((group) => group.phrase_id === phrase.id && group.revision >= 2);

                return redrafted ? undefined : 'critical';
            }
        });

        // Phase ① runs the GROUP model (`mode: 'groups'`), because the artifact Phrase ② is seeded from
        // is the composed `phrases.content` — the legacy sampler book has no phrase text to hand down.
        const storyId = await createSliceStory(fixture, 3, { mode: 'groups', sampling: 5, critics: 1 });

        await openDial(fixture, storyId);

        try {
            // ① — the Summary leg completes and the Author locks it. This is the existing pipeline; it is
            // walked rather than seeded so the lock, the level strings, and the phase move are the
            // product's own (§15's Author verbs).
            const reachedSignoff = await settle(fixture, async () => (await storyRow(fixture, storyId)).status === 'pending');

            expect(reachedSignoff).toBe(true);

            const afterLock = await fixture.api<Record<string, unknown>>('POST', `/stories/${storyId}/lock`);

            expect({ status: afterLock.status, phase: afterLock.body.phase, summary_locked: afterLock.body.summary_locked }).toEqual({
                status: 200,
                phase: 'plotlines',
                summary_locked: true
            });

            const store = fixture.store;
            const story = store.stories.get(storyId)!;

            // The dial the lane reads is the PHRASE's own, and a new Story gets it by default: the classic
            // §4.3 tools stay reachable for a book the Author puts back on them (`plotlines_mode:
            // 'classic'`), and an old row with no field reads classic.
            expect(story.plotlines_mode).toBe('groups');

            // ② — PHRASE ② UNSTARTED: the lane generates nothing, and the drain says so in the Author's
            // own terms. This is the state every pre-Phrase-② book is in, and it must not be reported as
            // "the crew is done" while the chapter pipeline nobody started is still owed (L-37's condition
            // 1 is answered by a probe that has to look at the work). The clause is pinned byte for byte
            // because the drain ROW is what the Author reads to know what to do next.
            const unstarted = store.stories.get(storyId)!;

            expect(unstarted.phase).toBe('plotlines');
            expect(drainPreconditions(store, unstarted)).toEqual({
                met: false,
                unmet: [
                    'Phrase ② has not been started — the compiled Summary (or the Author’s own text) has to be pushed into the Plotlines Phrase before any chapter contract is drafted (R1, one phrase down)'
                ]
            });

            // ③ — the Author pushes the compiled Summary into Phrase ②. The copied seed IS the phase-①
            // phrase's composed text: nothing recomposes it, and the hash every Phrase ② gate hashes is
            // the hash of THAT text (P5, one phrase down).
            const summaryPhrase = store.phrases.list().find((row) => row.story_id === storyId && row.key === PHRASE_SUMMARY_KEY)!;
            const started = startPlotlinesPhrase(store, store.stories.get(storyId)!, summaryPhrase.content, {
                author: true,
                why: 'the Author pushed the locked Summary into Phrase ② (R1, one phrase down)'
            });

            expect(started.started).toBe(true);
            expect(started.phrase.seed).toBe(summaryPhrase.content.trim());
            expect(started.phrase.key).toBe(PHRASE_PLOTLINES_KEY);
            expect(chapterGroupsOf(store, started.phrase.id)).toEqual([]);

            const ledgerBefore = await runLines(fixture, storyId);
            const structureKey = plotlinesStructureKeyOf(started.phrase, store.stories.get(storyId)!);

            // ④ — the structure gate. Priority 0, its own claim FAMILY (`wi_structure_plotlines_<phrase
            // seed hash>`, not the Summary's `wi_structure_seed_<seed hash>` — the two phrases can hold
            // the same text, and one family would let phase ①'s accepted structure satisfy Phrase ②), and
            // its own crew: an unbound Editor job is `editor-general`, so a structure job that lost its
            // `templateRef` would run the general Editor crew and still "work", which is exactly the
            // silent change this pin catches.
            await settle(fixture, async () => (await runLines(fixture, storyId)).length > ledgerBefore.length);

            const structureRows = store.runs.list().filter((run) => (run.work_item_ref ?? '') === structureKey);

            expect(structureRows.map((run) => `${run.template_ref}/${run.role}`)).toEqual(['editor-plotlines-structure/editor']);

            // The ONE write of the structure pass: a brief that says 3, the chapter set at N=3, and the
            // Author's count moved to the same number — in one commit (`tools/plotlines.ts`).
            const briefs = store.plotlineBriefs.list().filter((row) => row.story_id === storyId);

            expect(briefs.map((row) => [row.status, row.chapter_count, row.phrase_id])).toEqual([['accepted', 3, started.phrase.id]]);
            // The count the classic phase ③ surface reads. `summaries.id` is its own row id, not the
            // Story's, so the lookup goes by `story_id` (the lane's accept step moves this field in the
            // same commit that creates the chapter rows).
            expect(store.summaries.list().find((row) => row.story_id === storyId)?.chapter_count).toBe(3);
            expect(chapterGroupsOf(store, started.phrase.id).map((group) => [group.key, group.order, group.revision])).toEqual([
                ['chapter_1', 1, 0],
                ['chapter_2', 2, 0],
                ['chapter_3', 3, 0]
            ]);

            // ⑤ — the draft batch installs the CONTRACTS. The claim ref is the PHRASE ROW id (seam S8), so
            // the family string below is not the Summary's family with a different hash: it is a different
            // family. The crew is `writer-plotlines-sampler`, the tool-less contract writer.
            const claimRef = groupDraftClaimRef(store, store.stories.get(storyId)!, started.phrase.id);

            expect(claimRef).toBe(started.phrase.id);

            await settle(fixture, async () => chapterGroupsOf(store, started.phrase.id).every((group) => group.revision >= 1));

            // The chapter entry ids in the order the brief declared them, and the TWO vectors the lane
            // keys off: the DRAFT family hashes the group set with every revision pinned at 0 (a first
            // draft and a fix of the same group share one family and differ only in the attempt number),
            // while the SEATS hash the vector the entries are actually AT — revision 1 for the text the
            // first install produced. Confusing the two would pin a claim key that exists in no family.
            const chapterIds = chapterGroupsOf(store, started.phrase.id).map((group) => group.id);
            const draftFamilyHash = groupVectorHash(Object.fromEntries(chapterIds.map((id) => [id, 0])));
            const writtenVectorHash = groupVectorHash(Object.fromEntries(chapterIds.map((id) => [id, 1])));
            const draftRows = store.runs
                .list()
                .filter((run) => (run.work_item_ref ?? '').startsWith(`wi_draft_groups_${claimRef}_`));

            expect(draftRows.map((run) => `${run.template_ref}/${run.role}`)).toEqual(['writer-plotlines-sampler/writer']);
            expect(draftRows.map((run) => run.work_item_ref)).toEqual([`wi_draft_groups_${claimRef}_${draftFamilyHash}_1`]);

            // The install wrote every chapter the brief declared — the arity is the materialized set, not
            // the catalog's five (seam S12), and an answer that skipped a chapter would have been refused
            // atomically, leaving revision 0 rows here.
            expect(chapterGroupsOf(store, started.phrase.id).map((group) => [group.key, group.revision])).toEqual([
                ['chapter_1', 1],
                ['chapter_2', 1],
                ['chapter_3', 1]
            ]);

            // The contract mirror: the install mirrors each chapter entry onto its `plotlines` row BY
            // ORDER, which is the whole reason the lane can coexist with the classic §4.3 path — phase ③
            // and the Goals keep reading one artifact. Each mirror carries THAT chapter's own contract
            // text, because the harness's chapter answer is worded off the `### … key=chapter_N` heading
            // the batch printed: the key inside every field proves the row came from that entry and not
            // from a neighbour. (`pov` is the one field whose text is prompt-independent, so it is pinned
            // whole; the others end in a line of the prompt, which is why they are pinned by prefix.)
            expect(
                plotlinesOf(store, storyId).map((row) => [
                    row.order,
                    row.must_happen?.startsWith(`chapter_${row.order} must deliver:`) ?? false,
                    row.must_change?.startsWith(`chapter_${row.order} leaves the book different:`) ?? false,
                    row.pov === `chapter_${row.order} is told through the protagonist`,
                    row.setups?.startsWith(`chapter_${row.order} plants:`) ?? false
                ])
            ).toEqual([
                [1, true, true, true, true],
                [2, true, true, true, true],
                [3, true, true, true, true]
            ]);

            // ⑥ — the review seats and the deep review over the installed chapter set, both keyed by the
            // CHAPTER vector. The two phrases' seats cannot collide because a vector is a map of one
            // phrase's group ids, so the hash below is the chapter vector and no Summary row is in it.
            await settle(fixture, async () => {
                const lines = await runLines(fixture, storyId);

                return (
                    lines.some((line) => line.startsWith(`wi_review_groups_${writtenVectorHash}_`)) &&
                    lines.some((line) => line.startsWith(`wi_group_check_${writtenVectorHash}_`))
                );
            });

            // The seat keys are the SAME families phase ① uses, and the vector is what keeps the two
            // phrases apart: `writtenVectorHash` is a map of the CHAPTER rows' ids, so no Summary seat can
            // answer for it. The crew is the deep-review rotation's first angle — Phase ② has no
            // `critic-screening` in its pool, so the seats rotate the assigned angles.
            expect(groupReviewSeatKey(writtenVectorHash, 1)).toBe(`wi_review_groups_${writtenVectorHash}_1`);

            expect(
                store.runs
                    .list()
                    .filter((run) => (run.work_item_ref ?? '').startsWith(`wi_review_groups_${writtenVectorHash}_`))
                    .map((run) => `${run.work_item_ref}[${run.template_ref}/${run.role}]`)
            ).toEqual([`${groupReviewSeatKey(writtenVectorHash, 1)}[critic-genre/critic]`]);

            expect(groupCheckSeatKey(writtenVectorHash, 1)).toBe(`wi_group_check_${writtenVectorHash}_1`);

            // ⑦ — the defect leg, produced rather than seeded: the deep review filed a chapter defect
            // scoped to the chapter entries (R3's join), the Editor verified it, and the loop cut a SECOND
            // draft batch to answer it. A finding with no `group_refs` here would plan "the whole book"
            // against the Summary's rows, and the batch below would name summary groups instead.
            //
            // THE WALK IS STEERED TO THE SIGN-OFF, and only then reads the claim. The finding's closure is a
            // JOIN the install performs on the next sweep after the chapters move (R3), so a step that read
            // the row the moment the revisions bumped would assert a state that is one tick behind the
            // signal it waited for. The sign-off is the sweep boundary that proves every closure ran, and it
            // is the phase's own progress signal — not the finding row's state.
            const drained = await settle(fixture, async () => (await storyRow(fixture, storyId)).pending_kind === 'phase_signoff');

            const findings = store.findings.list().filter((finding) => finding.story_id === storyId);

            // PHASE ② OWNS THIS ROW. The target is the Story id because the seat has no unit — the artifact
            // is a SET of contracts, and `criteria/engine.ts:scopeTargets` grades the phase-② level at the
            // Story row — and the criterion is C-7, the contract criterion, because C-14 (Seed fidelity)
            // is scoped to the Summary artifact and cannot be graded against a chapter.
            expect(findings.map((finding) => [finding.state, finding.kind, finding.cost, finding.criterion_ref, finding.target_ref])).toEqual([
                ['fixed', 'issue', 'critical', 'C-7', storyId]
            ]);

            const chapterFindings = findings.filter((finding) =>
                (finding.group_refs ?? []).every((ref) => chapterGroupsOf(store, started.phrase.id).some((group) => group.id === ref))
            );

            // The scope is exactly the three chapter entries, in the order the brief declared them — the
            // Summary's five groups are NOT in it, which is what stops one chapter complaint from buying a
            // Summary rewrite (the finding's `group_refs` are how the repair is routed).
            expect(chapterFindings.map((finding) => finding.group_refs)).toEqual([chapterIds]);
            expect(chapterFindings.map((finding) => finding.state)).toEqual(['fixed']);

            // The redraft: one more batch, and every chapter the finding named moved to revision 2. The
            // family is the SAME as ⑤'s (the group set is unchanged, so the vector at revision 0 is the
            // family's identity) — only the attempt number moves, which is what makes "one defect, one
            // retry per group" readable in the ledger.
            const draftFamilies = [
                ...new Set(
                    store.runs
                        .list()
                        .filter((run) => (run.work_item_ref ?? '').startsWith(`wi_draft_groups_${claimRef}_`))
                        .map((run) => String(run.work_item_ref))
                )
            ];

            expect(draftFamilies).toEqual([
                `wi_draft_groups_${claimRef}_${draftFamilyHash}_1`,
                `wi_draft_groups_${claimRef}_${draftFamilyHash}_2`
            ]);
            expect(chapterGroupsOf(store, started.phrase.id).map((group) => [group.key, group.revision])).toEqual([
                ['chapter_1', 2],
                ['chapter_2', 2],
                ['chapter_3', 2]
            ]);

            // The Editor's verdict on the claim is its own leg of the lane: `verify_findings` runs on the
            // finding, and without it the fix batch would have been cut for a claim nobody confirmed.
            const chapterFinding = findings[0]!;

            expect(
                store.runs
                    .list()
                    .filter((run) => (run.work_item_ref ?? '').startsWith('wi_verify_finding_'))
                    .map((run) => `${run.work_item_ref}[${run.template_ref}/${run.role}]`)
            ).toEqual([`wi_verify_finding_${chapterFinding.id}_1[editor-general/editor]`]);

            // ⑧ — clean: the redrawn vector is reviewed, and the CLEAN STAMP is phrase-scoped — the read
            // that arms the Reader's score seat and the Editor's lock seat. Unscoped, this would report the
            // SUMMARY's selection (which was stamped ages ago) and a chapter seat would be armed against a
            // vector the chapters are not at.
            const redrawnVectorHash = groupVectorHash(Object.fromEntries(chapterIds.map((id) => [id, 2])));

            expect(
                store.runs
                    .list()
                    .filter((run) => (run.work_item_ref ?? '').startsWith(`wi_group_check_${redrawnVectorHash}_`))
                    .map((run) => run.work_item_ref)
            ).toEqual([groupCheckSeatKey(redrawnVectorHash, 1)]);

            const reviewed = cleanSelectionOf(store, store.stories.get(storyId)!, started.phrase.id);

            expect(reviewed.complete).toBe(true);
            // The stamp is the SECOND vector, not the first: the install's text was reviewed, found broken,
            // and replaced, and a stamp that still pointed at the redrawn-away vector would arm the score
            // and lock seats against text the chapters no longer hold.
            expect(reviewed.vector_hash).toBe(redrawnVectorHash);
            expect(reviewed.vector_hash).toBe(groupVectorHash(groupRevisionVector(store, storyId, started.phrase.id)));

            // ⑨ — the phase drains and the sign-off is offered: the Plotlines Goal passes 7/7 over the
            // installed contracts. Had the drain clause been missing, this row would have been offered
            // while the review seats and the fix batch were still owed (L-37).
            //
            // WHAT THIS WALK DOES NOT SHOW, ON PURPOSE: the Reader's `score_sections` seat and the Editor's
            // `group_lock` seat are ARMED by the phrase-scoped clean stamp (⑧) but are display/Author
            // surfaces, not work the drain waits on, so the sign-off is reached before either is dispatched
            // — exactly as in phase ①, where the same two seats are pinned against the store in
            // `loop/section-scores.test.ts` and `loop/phase1-editor-lock.test.ts`. The Phrase ② half of
            // their behaviour — a score run whose rows land on the PLOTLINES phrase, and a lock answer that
            // freezes a chapter entry — is pinned there and in the lane's focused files, not here.
            const signoff = await storyRow(fixture, storyId);

            expect(drained).toBe(true);
            expect({ phase: signoff.phase, status: signoff.status, levels: signoff.levels.plotlines }).toEqual({
                phase: 'plotlines',
                status: 'pending',
                levels: '7/7'
            });

            // ⑩ — the lock materializes the chapters the contracts describe, each one bound to the contract
            // row it came from (`plotline_ref`). This is the seam the whole lane exists for: phase ③'s
            // Writer drafts against a chapter that carries its contract, and C-0/C-1 grade the chapter set
            // against the phrase seed and the contracts.
            const lock = await fixture.api<Record<string, unknown>>('POST', `/stories/${storyId}/lock`);

            expect({ status: lock.status, phase: lock.body.phase, plotlines_locked: lock.body.plotlines_locked }).toEqual({
                status: 200,
                phase: 'chapters',
                plotlines_locked: true
            });

            const chapters = store.chapters
                .list()
                .filter((row) => row.story_id === storyId)
                .sort((left, right) => left.order - right.order);

            expect(chapters.map((row) => [row.order, plotlinesOf(store, storyId).some((plot) => plot.id === row.plotline_ref)])).toEqual([
                [1, true],
                [2, true],
                [3, true]
            ]);

            // The chapter leg opens with the contracts in place: the denominator is the CHAPTER COUNT the
            // brief declared (3, not the catalog's five — seam S12), and the only criteria failing are the
            // three that need prose the phase has not written yet. The progress line is pinned EXACTLY as
            // the classic lane pins it (`integration/slice-ops.test.ts`): phase ③ counts PROSE, not
            // contracts, so three materialized chapters with no text is the same string a classic lock
            // produces. The lane changes what the chapters CARRY, not what the rail counts.
            const chaptersRow = await storyRow(fixture, storyId);

            expect(chaptersRow.levels.chapters).toBe('0/3 · failing: C-7, C-8, C-9');
            expect(chaptersRow.progress).toBe('0 chapters · 0 done');

            // THE LEDGER, in dispatch order, for the phase-② half of the walk. The lane's families
            // (structure, draft, review seat, deep review, finding verification) are pinned beside the
            // classic legs the hybrid keeps, so a leg that quietly stops running is a hole here rather than
            // a greener suite. Each family appears ONCE, with the crew it ran under, because that is the
            // part a regression moves: an unbound job falls back to `editor-general`/`writer-general` and
            // still "works" while reading the wrong law block.
            const phase2Lines = (await runLines(fixture, storyId)).slice(ledgerBefore.length);

            expect(phase2Lines).toEqual(
                expect.arrayContaining([
                    `${structureKey}[editor-plotlines-structure/editor]=torn_down`,
                    `wi_draft_groups_${claimRef}_${draftFamilyHash}_1[writer-plotlines-sampler/writer]=torn_down`,
                    `wi_draft_groups_${claimRef}_${draftFamilyHash}_2[writer-plotlines-sampler/writer]=torn_down`,
                    `${groupReviewSeatKey(writtenVectorHash, 1)}[critic-genre/critic]=torn_down`,
                    `${groupCheckSeatKey(writtenVectorHash, 1)}[critic-genre/critic]=torn_down`,
                    `wi_verify_finding_${chapterFinding.id}_1[editor-general/editor]=torn_down`
                ])
            );

            // T-W2b — THE LANE IS THE ONE WRITING SURFACE (R2). On this dial the classic draft pair is
            // gone: the contracts exist because the draft batch's INSTALL wrote them (and mirrored them),
            // so no `wi_write_*` claim exists in phase ② at all. A fix pass is equally absent — an
            // approved contract defect reaches the text through revise → install → mirror, and a classic
            // `wi_fix_plotline_*` run would write the mirrored row out of band (its refusal ledger is the
            // 15 phantom T-4/T-11 rows this correction removed).
            expect(phase2Lines.filter((line) => line.startsWith('wi_write_'))).toEqual([]);
            expect(phase2Lines.filter((line) => line.startsWith('wi_fix_'))).toEqual([]);
            // What the hybrid KEEPS is the READING leg: one `check_unit` pass per contract row, judged by
            // the consistency reader, in the rows' own `wi_check_<row>_<gen>_unit` family. The install
            // counts as the write that arms it (`loop/work.ts:contractInstalledByPhrase`), which is what
            // lets the phase Goal reach 7/7 on a book with no Writer run beside the lane's batches.
            expect(phase2Lines.filter((line) => line.startsWith('wi_check_'))).toEqual(
                plotlinesOf(store, storyId).map(
                    (row) => `wi_check_${row.id}_1_unit[reader-consistency/reader]=torn_down`
                )
            );
            // The choice this pipeline removed: no `wi_select_` claim anywhere on a group-managed phase ②.
            expect(phase2Lines.filter((line) => line.startsWith('wi_select_'))).toEqual([]);
            // ZERO refusals across the whole walk, in either direction: the classic Writer leg no longer
            // reaches `createPlotline`/`editPlotline`, so the T-W2 overlap's phantom T-4/T-11 rows are
            // gone, and the R6 ownership guards never have to fire either — nothing asks the tools to
            // write a contract the lane owns. A refusal here means a second writing surface is back.
            expect(fixture.refusals.map((refusal) => [refusal.template, refusal.tool, refusal.rule])).toEqual([]);
        } finally {
            await fixture.close();
        }
    });
});
