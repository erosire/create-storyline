/**
 * READER SCORING (D-65, gated by D-67) — the scoring seat in the live loop: when it is offered, what
 * one accepted answer writes, what a refusal costs, and everything it is NOT allowed to touch.
 *
 * The Author asked for a Reader that reads the Summary once it is REVIEWED and gives each of the five
 * sections a number out of 100, shown on the rail. That is display work, and the pins below are the ones
 * that keep it display work:
 *
 *   1. OFFERED BEHIND THE CLEAN SELECTION, ONCE PER CLEAN VECTOR (`loop/work.ts` candidate 2b). The gate
 *      is `phrase/reviewed.ts:cleanSelectionOf`, NOT "every group has text": a number on text nobody has
 *      rejected yet is the judgement the Author did not ask for. The claim key is the CLEAN selection's
 *      hash, so two things fall out and both are pinned here — an install whose newest revision still
 *      carries an open defect does NOT re-arm the seat, and the seat re-arms the moment the clean
 *      selection ADVANCES (a deep pass clears a group, or a newer clean revision supersedes an older one).
 *      "Open defect" is D-33c's HOLDING SET — `unconfirmed`, `confirmed`, `approved` — so a finding the
 *      Editor marks `disputed` never holds the seat shut (2026-11-25: a disputed row drives no work, so a
 *      book whose only outstanding note was disputed used to drain with an empty rail; pinned below).
 *   2. IT TAKES THE FIRST DISPATCH SLOT (`priority: 2`, `rank: -1`). The rigs cap concurrency at 1
 *      (`loop/mock.ts`), so a seat ranked LAST in the class would only ever score the FINAL revision of a
 *      book. The rank is what makes "one scoring run per reviewed Summary" true under a ceiling of 1, and
 *      the sweep below proves it by observing WHICH run the single slot bought.
 *   3. THE SETTLE WRITES EXACTLY FIVE ROWS, IN ONE COMMIT, AND NOTHING ELSE — no finding, no task, no
 *      verdict, no counter, and no group attempt spent. `vector_hash` is read back off the CLAIM KEY, not
 *      re-derived from the rows that exist when the run lands: the score judges the text the Reader was
 *      SHOWN (the selection the prompt was compiled from), and a Writer install during the pass must not
 *      re-stamp an old judgement onto a new book. "ONE COMMIT" is counted on the JOURNAL LABEL
 *      (`scoreWriteCommits`), not on a shared `created_at`: `store.ts:Collection.create` stamps each record
 *      with its own `new Date()`, so five inserts in one transaction may legitimately straddle a
 *      millisecond — the timestamp version of this pin failed about one run in three.
 *   4. A REFUSED ANSWER RE-ARMS, TWICE (D-67). D-65 spent the vector on any CLOSED run, which stranded a
 *      Clean book on one bad provider answer — plumbing holding a verdict. A refusal now leaves the seat
 *      armed, and `phrase/section-scores.ts:SECTION_SCORE_ATTEMPT_CAP` (2 closed passes) is what stops a
 *      permanently broken provider from buying a Reader every sweep. An ANSWERED vector is never
 *      re-offered at all: `scoredVectorHashes` says the judgement exists.
 *   5. IT NEVER HOLDS SIGN-OFF. The last pin is the P6 exception's teeth: the phase may read DRAINED with
 *      the seat still offered and zero rows written.
 *
 * Every value below was read off the rig (`yarn vite-node` probes in `Temp/tc1/`), not guessed. Group ids
 * are UUIDs the store generates, so they are referenced through the rows, never hardcoded; the ref
 * (`summary_0`), the score crew slug (`reader-score`, D-65's score-only reader — NOT the tool-carrying
 * `reader-consistency`), the numbers (60/68/76/84/92) and the sentences are pinned as literals because they
 * are the product copy.
 */
import { describe, expect, it } from 'vitest';
import { createRig, type CrewBehaviour, type Rig } from './mock';
import { drainPreconditions } from './status';
import { generateWork } from './work';
import {
    GROUP_DRAFT_ITEM_PREFIX,
    groupWriteAttempts,
    isGroupHoldingRun,
    isGroupPipelineRun,
    liveGroupSets,
    sectionScoreClaimKey,
    sectionScoreVectorHashOf,
    groupCheckSeatKey,
    groupReviewSeatKey
} from '../phrase/exclusion';
import { storyPhrase } from '../phrase/catalog';
import { cleanSelectionOf, stampCleanRevisions } from '../phrase/reviewed';
import { SECTION_SCORE_ATTEMPT_CAP } from '../phrase/section-scores';
import { groupRevisionVector, groupVectorHash, installGroupRevisions } from '../phrase/revisions';
// MAJOR 3 (2026-11-26) — the DEEP seat below is "paid" by the report its run filed, not by the row it
// closed, so this fixture also writes that seat's `verdicts` row (the one `tools/reader.ts:submitVerdict`
// files), and `storySummary` is the artifact the real deep pass judges.
import { storySummary } from './records';
import { AUTHOR_ATTR, seedFinding } from '../run/mock';
import { SectionScoresSchema, SECTION_SCORES_SCHEMA_NAME } from '../../shared/schemas';
import type { PhraseGroup, RunState, SummaryScore } from '../../shared/types';

/**
 * The phase-① rig every existing grouped fixture uses: one Critic seat per pass so the counts in the
 * drain sentences stay literals, and a waived research leg so §6.4 step 2 never enters the lists.
 */
const rigged = (crew: CrewBehaviour = {}): Promise<Rig> =>
    createRig({
        summaryMode: 'groups',
        summarySampling: 5,
        summaryCritics: 1,
        crew: { researchQuestions: [], ...crew }
    });

const groupsOf = (rig: Rig): PhraseGroup[] =>
    rig.store.phraseGroups.list().filter((group) => group.story_id === rig.storyId);

/** The vector of the text that is installed RIGHT NOW — the same read the rail and the generator use. */
const vectorHashOf = (rig: Rig): string => groupVectorHash(groupRevisionVector(rig.store, rig.storyId));

/**
 * Closes the cross-group pass over the CURRENT vector, by its effect: the Clean stamps that settle leaves
 * on the rows (D-67). The rig's own deep seat would need a `check_unit` run and a findings answer; the
 * stamp is the part the scoring seat reads, so the fixture writes exactly that, through the production
 * stamping function with the production seat key.
 */
const stampClean = (rig: Rig, runRef = 'run_check_1') =>
    stampCleanRevisions(
        rig.store,
        rig.story(),
        { seatKey: groupCheckSeatKey(vectorHashOf(rig), 1), runRef },
        AUTHOR_ATTR
    );

/** The scoring candidates in this sweep's work list, whatever else the sweep wants. */
const scoreSeats = (rig: Rig) =>
    generateWork(rig.store, rig.story(), { at: '2026-11-25T10:00:00.000Z', phase: 'summary' }).filter(
        (candidate) => candidate.item.kind === 'score_sections'
    );

/**
 * The terminal report a CONCLUDED deep-review pass leaves on the record (MAJOR 3, 2026-11-26) — the row
 * that pays a DEEP seat, and the only thing that does.
 *
 * `phrase/exclusion.ts:groupCheckSeatAnswered` asks whether one of the seat's RUNS filed a `verdicts` row,
 * and `api/projections.ts` counts the rail's deep numerator with the SAME read. A CLOSED deep row proves
 * nothing on its own: this is the tool-carrying family, and its success branch is reached whenever the
 * session merely ENDED (`run/plugins/critic-termination.ts`), so a capped or abandoned pass closes a row
 * and files nothing. The row written here is the one `tools/reader.ts:submitVerdict` files from the pass's
 * ONE terminal report — `run_ref` is the run that filed it, the join `records.ts:wholeStoryVerdicts` makes.
 */
function fileSeatReport(rig: Rig, run: { id: string; work_item_ref?: string | null }): void {
    rig.store.verdicts.create(
        {
            story_id: rig.storyId,
            target_ref: storySummary(rig.store, rig.storyId)?.id ?? rig.storyId,
            target_kind: 'summary',
            run_ref: run.id,
            template_ref: 'critic-genre',
            round: 1,
            criteria_passed: [{ criterion: 'C-14', result: true, evidence: 'no contradiction the pass could quote' }],
            hard_pass: true,
            soft_count: 1,
            recommendation: 'advance'
        },
        { run_ref: run.id, why: `seed: the deep seat's terminal report on ${run.work_item_ref} (MAJOR 3)` }
    );
}

const scoreRows = (rig: Rig): SummaryScore[] =>
    rig.store.summaryScores.list().filter((row) => row.story_id === rig.storyId);

/**
 * The score rows this Story holds, counted per COMMIT LABEL — P1's atomicity read off the journal, which
 * is the only deterministic way to prove "the five rows landed in one commit" (2026-11-27, task C).
 *
 * WHY NOT `created_at`: `store/store.ts:Collection.create` stamps every record with its OWN
 * `new Date().toISOString()`, so five inserts inside ONE transaction legitimately carry two timestamps
 * when they straddle a millisecond. The assertion this replaces — one `Set` of `created_at` of size 1 —
 * failed about one run in three while the settle stayed a single commit: a clock race presented as an
 * invariant, which is what the deterministic-test standard forbids.
 *
 * The journal IS the atomicity record: `Store.commit(label, fn)` buffers every write of the transaction
 * into one group and stamps each event with that label (`store.ts:commit`, `store.ts:_event`), and the
 * run settle opens that transaction as `loop_job_result` (`loop/engine.ts:1492`), inside which the score
 * rows are written (`loop/engine.ts`, READER SCORING block). So "one commit for the five" is exactly "all
 * five `create` events carry the settle's label, and no score row was written under any other label" —
 * the partial rail the parse refuses (`phrase/section-scores.ts:parseSectionScoreAnswer`) would show up
 * here as a short count.
 */
const scoreWriteCommits = (rig: Rig): Record<string, number> =>
    rig.store.journal.reduce<Record<string, number>>((counts, event) => {
        // `store.summaryScores` is the `summary_scores` collection — the journal keys events by the store's
        // collection name (`store.ts:784`), not by the accessor's camelCase property.
        if (event.collection !== 'summary_scores' || event.op !== 'create') return counts;

        const record = event.patch as { story_id?: string } | undefined;

        if (record?.story_id !== rig.storyId) return counts;

        counts[event.commit_label] = (counts[event.commit_label] ?? 0) + 1;

        return counts;
    }, {});

/** The score run of one vector, however it ended. */
const scoreRun = (rig: Rig, claimKey: string) =>
    rig.store.runs.list().find((run) => run.work_item_ref === claimKey)!;

/**
 * The crew ROW a seat's `templateRef` resolves to, narrowed to what the executor and the rail read (D-17a:
 * a Work Item's slug is only a crew if the store holds the row).
 *
 * WHY THIS IS PINNED AT ALL (brief item 3): `loop/engine.ts:createStory` seeds `BUILT_IN_TEMPLATES` by slug,
 * so the rig's catalogue carries the two built-ins the 2026-11-26 rewiring bound — `reader-score` here and
 * `critic-screening-plotlines` in the chapter lane. A hand-built Store fixture that seeds its own short
 * catalogue instead would arm the seat against a slug nothing can resolve, and the run would fall back to a
 * default crew while still "passing"; this read makes the row's presence, its phase scope and the role the
 * seat asks for (`name`/`kind`/`web`/`agents`) one exact value instead.
 */
const crewRowOf = (rig: Rig, name: string) => {
    const row = rig.store.templates.list().find((template) => template.name === name);

    if (row === undefined) return undefined;

    return {
        name: row.name,
        builtin: row.builtin,
        editable: row.editable,
        serves_phase: row.serves_phase,
        attempts: row.attempts,
        roles: row.roles.map((role) => ({ name: role.name, kind: role.kind, web: role.web, agents: role.agents }))
    };
};

/** Installs text for `count` of the five groups, in catalog order — the completeness dial. */
function install(rig: Rig, content: string, count = 5, workItemRef = `${GROUP_DRAFT_ITEM_PREFIX}_summary_0_test_1`) {
    return installGroupRevisions(
        rig.store,
        rig.story(),
        groupsOf(rig)
            .slice(0, count)
            .map((group) => ({ group, content: `${group.key}: ${content}` })),
        AUTHOR_ATTR,
        { runRef: 'run_writer', workItemRef }
    );
}

/** The payload of a stored score row — the four bookkeeping fields are store-generated, not the point. */
const payloadOf = (row: SummaryScore) => ({
    story_id: row.story_id,
    phrase_id: row.phrase_id,
    vector_hash: row.vector_hash,
    group_id: row.group_id,
    group_key: row.group_key,
    score: row.score,
    rationale: row.rationale,
    evidence: row.evidence,
    run_ref: row.run_ref,
    work_item_ref: row.work_item_ref
});

describe('the scoring seat is gated on the clean selection, not on installed text (D-67)', () => {
    it('waits for the last group AND for the clean pass, then pins the exact job the Reader is sent', async () => {
        const rig = await rigged();

        // Nothing is written yet: the batch owns the sweep and there is no Overview to score.
        expect(scoreSeats(rig)).toEqual([]);

        // Four of five. This is the state the review seats DO accept (one group of text already opens a
        // structured pass), and the scoring seat must not: the missing `ending` is the whole point.
        install(rig, 'the installed text.', 4);

        expect(groupsOf(rig).map((group) => [group.key, group.revision])).toEqual([
            ['premise', 1],
            ['promise', 1],
            ['theme', 1],
            ['tone', 1],
            ['ending', 0]
        ]);
        expect(scoreSeats(rig)).toEqual([]);

        // The fifth install completes the Overview and STILL does not arm the seat (D-67): five texts, no
        // clean verdict on any of them, so the rail has nothing honest to draw.
        install(rig, 'the installed text.', 5, `${GROUP_DRAFT_ITEM_PREFIX}_summary_0_test_2`);

        expect(cleanSelectionOf(rig.store, rig.story())).toMatchObject({
            complete: false,
            entries: [],
            vector: {}
        });
        expect(scoreSeats(rig)).toEqual([]);

        // The cross-group pass closes, every group is stamped, and the seat opens — keyed by the CLEAN
        // selection's hash, which at this moment is the live vector.
        stampClean(rig);

        const key = sectionScoreClaimKey(vectorHashOf(rig));
        const seats = scoreSeats(rig);

        expect(seats).toHaveLength(1);
        expect(seats[0]).toEqual({
            key,
            item: {
                id: key,
                storyId: rig.storyId,
                kind: 'score_sections',
                // D-65's SCORE-ONLY voice (2026-11-26 wiring): the seat is `toolMode: 'none'` and may file
                // nothing (P6), so its crew is the built-in whose prompt carries no `raiseFinding`,
                // `createTask` or verdict copy. `reader-consistency` is the TOOL-CARRYING review reader —
                // the one `check_unit` uses — and it is no longer this seat's label. `compileSectionScorePrompt`
                // always resolves `SCORE_TEMPLATE_SLUG` = 'reader-score' regardless of this ref, so the ref is
                // the seat's visible crew binding, and it has to agree with the prompt the run is briefed with.
                templateRef: 'reader-score',
                roleName: 'reader',
                unit: { kind: 'summary', ref: 'summary_0' },
                toolMode: 'none',
                responseSchema: { name: SECTION_SCORES_SCHEMA_NAME, schema: SectionScoresSchema },
                // ALL FIVE, always — the answer must name every group exactly once, and consistency with
                // the other sections is one of the three things each section is judged on.
                groupRefs: groupsOf(rig).map((group) => group.id)
            },
            max_concurrent: 2,
            why: `Reader scores all 5 sections of the reviewed Overview at clean vector ${key.slice('wi_summary_score_'.length)} (D-65, D-67)`,
            priority: 2,
            // Ranked BEFORE the priority-2 Critic seats (whose rank is 0) so the rail has a number before
            // the review pass that may follow it with findings — see the header's reason (2).
            rank: -1
        });
        // The seat's schema is the SAME object the transport ships, not a copy that could drift.
        expect(seats[0]!.item.responseSchema!.schema).toBe(SectionScoresSchema);
    });

    it('arms through a DISPUTED defect and a repaired one — the release, in the phase that used to wedge (D-33c, D-65, D-67)', async () => {
        const rig = await rigged();

        install(rig, 'the installed text.');

        // Five texts, no clean verdict on any of them: the seat is shut before the findings enter, so the
        // arming below cannot be credited to anything but the stamps.
        expect(scoreSeats(rig)).toEqual([]);

        // THE DESK THE DEADLOCK SHIPPED ON, at the phase level. A group-mode Summary with two findings on
        // `ending`: one the Writer has repaired (`fixed`) and one the Editor DISPUTED — the note does not
        // fit the text. Neither row owes anybody a step: the repaired one has no open fix task, and a
        // disputed claim drives no work (`phrase/exclusion.ts`), earns no verify seat (`loop/work.ts`'s
        // verify queue is `unconfirmed`-only) and never reaches the Author's desk
        // (`loop/records.ts:findingsAwaitingAuthor` wants `confirmed`). Under the old four-state reading
        // the disputed row kept `ending` out of the clean selection forever, so the seat below never
        // armed, the rail stayed empty, and the phase could only drain past a book nobody was blocking.
        const ending = groupsOf(rig).find((group) => group.key === 'ending')!;
        const repaired = seedFinding(rig.store, rig.storyId, {
            state: 'fixed',
            criterion_ref: 'C-4',
            fingerprint: 'C-4|chapter_1',
            title: 'the ending walks back the promise it sold'
        });
        const disputed = seedFinding(rig.store, rig.storyId, {
            state: 'disputed',
            criterion_ref: 'C-9',
            fingerprint: 'C-9|chapter_1',
            title: 'the ending is too fast — the text does not say so'
        });

        // The scope is a write of its own: `seedFinding` leaves `group_refs` empty (a tool-filed finding
        // names its groups at creation; a fixture says so afterwards). Scoped to `ending` only, so the
        // other four groups were never vetoed and cannot be what arms the seat. The updated rows are kept
        // because the optimistic-rev check below reads their new revs.
        const scopedRepaired = rig.store.findings.update(
            repaired.id,
            { group_refs: [ending.id] },
            AUTHOR_ATTR,
            [{ id: repaired.id, rev: repaired.rev }]
        );
        const scopedDisputed = rig.store.findings.update(
            disputed.id,
            { group_refs: [ending.id] },
            AUTHOR_ATTR,
            [{ id: disputed.id, rev: disputed.rev }]
        );
        expect([scopedRepaired.state, scopedDisputed.state]).toEqual(['fixed', 'disputed']);

        // The cross-group pass closes over the whole vector: `stampCleanRevisions` skips a group an OPEN
        // issue names, and under D-33c's holding set neither of these rows is open — so all five groups
        // carry the stamp, `ending` included.
        stampClean(rig);

        expect(
            rig.store.groupRevisions
                .list()
                .filter((row) => row.story_id === rig.storyId && row.clean === true)
                .map((row) => row.group_key)
                .sort()
        ).toEqual(['ending', 'premise', 'promise', 'theme', 'tone']);
        expect(cleanSelectionOf(rig.store, rig.story())).toMatchObject({ complete: true, gaps: [] });

        // AND THE SEAT ARMS on the clean vector — the phase resumes, which is the whole point of releasing
        // a disputed claim instead of blocking on it.
        expect(scoreSeats(rig).map((seat) => seat.key)).toEqual([sectionScoreClaimKey(vectorHashOf(rig))]);

        // THE CONTROL, from the other side of the same set, in the same book: put the note back where it
        // is still answerable (`confirmed`, the Editor's "yes, but the Writer must check") and the gate
        // closes again. Release means "not a defect", not "anything goes" — the seat is still gated on
        // D-33c's holding set, exactly as the first test's open-defect case pins.
        rig.store.findings.update(scopedDisputed.id, { state: 'confirmed' }, AUTHOR_ATTR, [
            { id: scopedDisputed.id, rev: scopedDisputed.rev }
        ]);

        expect(cleanSelectionOf(rig.store, rig.story()).gaps).toEqual([
            {
                group_id: ending.id,
                group_key: 'ending',
                reason: 'no_clean_revision',
                latest: 1,
                issues_open: true
            }
        ]);
        expect(scoreSeats(rig)).toEqual([]);
    });

    it('does NOT re-arm for an install nobody reviewed, and re-arms when the clean selection advances', async () => {
        const rig = await rigged();

        install(rig, 'the first text.');
        stampClean(rig);

        const first = vectorHashOf(rig);

        expect(scoreSeats(rig).map((seat) => seat.key)).toEqual([sectionScoreClaimKey(first)]);

        await rig.step();

        // The judgement exists at the clean vector, so the seat is done with that text.
        expect(scoreRows(rig).map((row) => row.vector_hash)).toEqual([first, first, first, first, first]);
        expect(scoreSeats(rig)).toEqual([]);

        // A Writer rewrites the book, and nothing is offered (D-67): the newest revisions carry no clean
        // verdict, so the SELECTION has not moved — it still names the five rows the Reader already
        // scored. This is the requirement's sharp edge: a score of unreviewed prose is not owed.
        install(rig, 'the rewritten text.', 5, `${GROUP_DRAFT_ITEM_PREFIX}_summary_0_test_2`);

        const second = vectorHashOf(rig);

        expect(second).not.toBe(first);
        expect(cleanSelectionOf(rig.store, rig.story()).vector_hash).toBe(first);
        expect(scoreSeats(rig)).toEqual([]);

        // The deep pass closes over the new vector and the selection ADVANCES — five newer clean rows —
        // and the seat re-arms under the new key with no counter and no engine memory anywhere.
        stampClean(rig, 'run_check_2');

        expect(cleanSelectionOf(rig.store, rig.story()).vector_hash).toBe(second);
        expect(scoreSeats(rig).map((seat) => seat.key)).toEqual([sectionScoreClaimKey(second)]);

        await rig.step();

        // ACCUMULATES, one set of five rows per judged selection: the rail is a history, not an overwrite.
        const rows = scoreRows(rig);

        expect(rows).toHaveLength(10);
        expect(new Set(rows.map((row) => row.vector_hash))).toEqual(new Set([first, second]));
        expect(rows.map((row) => row.group_key)).toEqual([
            'premise', 'promise', 'theme', 'tone', 'ending',
            'premise', 'promise', 'theme', 'tone', 'ending'
        ]);
        expect(new Set(rows.map((row) => row.run_ref)).size).toBe(2);
    });
});

describe('the settle commits five rows for the selection it read (D-65, D-67)', () => {
    it('takes the first slot of the sweep and scores every section of the reviewed Overview', async () => {
        const rig = await rigged();

        install(rig, 'the installed text.');
        stampClean(rig);

        const hash = vectorHashOf(rig);
        const key = sectionScoreClaimKey(hash);
        const phrase = storyPhrase(rig.store, rig.storyId)!;

        await rig.step();

        // The ceiling of 1 buys ONE run per sweep, and what it buys is the scoring seat — the proof that
        // `rank: -1` puts it ahead of the Critic seats in the same priority class.
        const run = scoreRun(rig, key);

        expect(rig.store.runs.list().filter((row) => (row.work_item_ref ?? '').startsWith('wi_summary_score_'))).toHaveLength(1);
        expect({
            role: run.role,
            kind: run.kind,
            state: run.state,
            template_ref: run.template_ref,
            work_item_ref: run.work_item_ref
        }).toEqual({
            role: 'reader',
            kind: 'work',
            state: 'torn_down',
            // The crew the run RESOLVED UNDER, not only the slug the candidate carried. This row said
            // `reader-consistency` before the 2026-11-26 rewiring; it is the score-only built-in now, and it
            // resolves because the rig's engine seeds `BUILT_IN_TEMPLATES` (`loop/engine.ts:createStory`).
            template_ref: 'reader-score',
            work_item_ref: key
        });

        // THE CATALOGUE THE SEAT RESOLVES FROM: the score-only reader is a seeded built-in ROW in this store,
        // with the one no-web `reader` role the seat asks for and its single-attempt budget. A fixture that
        // hand-builds a catalogue without the new built-ins leaves the seat bound to a slug the executor
        // cannot resolve, and this is where that shows.
        expect(crewRowOf(rig, 'reader-score')).toEqual({
            name: 'reader-score',
            builtin: true,
            editable: false,
            serves_phase: ['summary', 'plotlines', 'chapters'],
            attempts: 1,
            roles: [{ name: 'reader', kind: 'reader', web: false, agents: 1 }]
        });

        // Five rows, one per section, in catalog order, at the mock's scripted numbers — the same numbers
        // `integration/harness.ts` gives the full-server slices, so a score pinned here reads identically
        // there. `vector_hash` is the CLAIM's hash (the reviewed text that was in front of the Reader) and
        // `work_item_ref` is the claim key, so the rail can name the job behind the number.
        const rows = scoreRows(rig);

        expect(rows.map((row) => payloadOf(row))).toEqual(
            groupsOf(rig).map((group, index) => ({
                story_id: rig.storyId,
                phrase_id: phrase.id,
                vector_hash: hash,
                group_id: group.id,
                group_key: group.key,
                score: 60 + index * 8,
                rationale: `${group.id} holds together as written and is contradicted by none of the other sections`,
                evidence: `The ${group.id} line this story refuses to lose.`,
                run_ref: run.id,
                work_item_ref: key
            }))
        );
        expect(rows.map((row) => row.score)).toEqual([60, 68, 76, 84, 92]);
        expect(sectionScoreVectorHashOf(key)).toBe(hash);

        // ONE COMMIT for the five, counted on the JOURNAL LABEL rather than on a shared timestamp (see
        // `scoreWriteCommits` below): the rail reads the SET, so a partial write would show four numbers and
        // a missing section — the state the parse refuses. The five rows also all name the same run and the
        // same claim, which is what lets the rail label the set at all.
        expect(scoreWriteCommits(rig)).toEqual({ loop_job_result: 5 });
        expect(new Set(rows.map((row) => `${row.run_ref}|${row.work_item_ref}`))).toEqual(new Set([`${run.id}|${key}`]));

        // DISPLAY-ONLY, in the probe's own words: the pass paid no seat, so the drain still names the
        // Critic pass it never touched, and it says nothing about scores.
        expect(drainPreconditions(rig.store, rig.story())).toEqual({
            met: false,
            unmet: ['1 Critic pass still owed on the installed group Overview (R3, R5, §6.4 step 4)']
        });

        // The stamping is the other product of the same deep pass, and it is the reason the hash above is
        // an honest identity: five Clean rows, each naming the run that read them.
        expect(
            rig.store.groupRevisions
                .list()
                .filter((revision) => revision.story_id === rig.storyId && revision.clean === true)
                .map((revision) => [revision.group_key, revision.number, revision.clean_run_ref])
        ).toEqual([
            ['premise', 1, 'run_check_1'],
            ['promise', 1, 'run_check_1'],
            ['theme', 1, 'run_check_1'],
            ['tone', 1, 'run_check_1'],
            ['ending', 1, 'run_check_1']
        ]);

        // Nothing else moved: no finding, no task, no verdict-shaped row.
        expect(rig.store.findings.list().filter((finding) => finding.story_id === rig.storyId)).toEqual([]);
        expect(rig.store.tasks.list().filter((task) => task.story_id === rig.storyId)).toEqual([]);
    });

    it('refuses to score half a Summary, re-arms, and stops after its two passes (D-67)', async () => {
        const rig = await rigged();

        // A four-of-five answer: `parseSectionScoreAnswer` refuses it whole.
        const partial = await rigged({
            sectionScores: ({ groupRefs }) => ({
                sections: groupRefs.slice(0, 4).map((group_ref, index) => ({
                    group_ref,
                    score: 60 + index * 8,
                    rationale: `${group_ref} holds together`,
                    evidence: `The ${group_ref} line.`
                }))
            })
        });

        install(partial, 'the installed text.');
        stampClean(partial);

        const key = sectionScoreClaimKey(vectorHashOf(partial));

        await partial.step();

        // The refusal wrote nothing at all — not three of five sections, which is the failure this parse
        // exists to prevent (a rail showing a number for text that was never judged).
        expect(scoreRows(partial)).toEqual([]);

        const run = scoreRun(partial, key);

        expect(run).toMatchObject({
            state: 'torn_down',
            role: 'reader',
            kind: 'work',
            no_op: false,
            ended_at: expect.any(String)
        });
        // A scoring run DOES carry all five refs (it judged all five sections) — which is exactly why it
        // must not be a HOLDING kind: otherwise it would spend a write attempt on every group it names.
        expect(run.group_refs).toEqual(groupsOf(partial).map((group) => group.id));
        expect(isGroupHoldingRun(run)).toBe(false);
        expect(isGroupPipelineRun(run)).toBe(true);
        expect(partial.liveRuns()).toEqual([]);

        // D-67, the reversal: the closed run spent nothing. The vector is still Clean and still unscored,
        // so the seat is offered again — a bad provider answer may not strand a reviewed Summary.
        expect(scoreSeats(partial).map((seat) => seat.key)).toEqual([key]);
        expect(groupsOf(partial).map((group) => groupWriteAttempts(partial.store, partial.story(), group))).toEqual([
            0, 0, 0, 0, 0
        ]);

        // The retry is the last one: two CLOSED passes on one vector and the seat lets the book stay
        // unscored, which D-65 says costs nothing because the score gates nothing.
        await partial.step();

        expect(scoreRows(partial)).toEqual([]);
        expect(partial.store.runs.list().filter((row) => row.work_item_ref === key)).toHaveLength(SECTION_SCORE_ATTEMPT_CAP);
        expect(scoreSeats(partial)).toEqual([]);

        // And a GOOD answer proves the other half: the seat is offered before the run and retired after it,
        // because the judgement exists — no attempt count involved.
        install(rig, 'the installed text.');
        stampClean(rig);

        await rig.step();

        expect(scoreRun(rig, sectionScoreClaimKey(vectorHashOf(rig))).state).toBe('torn_down');
        expect(scoreRows(rig)).toHaveLength(5);
        expect(scoreSeats(rig)).toEqual([]);
        expect(rig.liveRuns()).toEqual([]);
    });
});

describe('the scoring pass never holds sign-off (P6 exception, D-65)', () => {
    it('reads drained with the seat still offered and nothing scored', async () => {
        const rig = await rigged();

        install(rig, 'the installed text.');
        stampClean(rig);

        const hash = vectorHashOf(rig);

        // Every seat the BOOK owes is paid by hand: the structured Critic pass and the deep cross-group
        // review. The scoring pass is the one job in the queue nobody has claimed.
        for (const [key, role] of [
            [groupReviewSeatKey(hash, 1), 'critic'],
            [groupCheckSeatKey(hash, 1), 'critic']
        ] as const) {
            const run = rig.store.runs.create(
                {
                    story_id: rig.storyId,
                    work_item_ref: key,
                    role,
                    state: 'torn_down' satisfies RunState,
                    started_at: '2026-11-25T10:00:01.000Z',
                    ended_at: '2026-11-25T10:00:02.000Z',
                    tokens: 4,
                    kind: 'work',
                    no_op: false,
                    delegated: [],
                    ...(key.startsWith('wi_group_check_') ? { group_refs: groupsOf(rig).map((g) => g.id) } : {})
                },
                { run_ref: null, author: true, why: `seed: the paid seat ${key}` }
            );

            // MAJOR 3 (2026-11-26): the two seats are NOT paid the same way. The structured seat is paid by
            // its `torn_down` row (`records.ts:isReportedRun` — that state's answer reached the settle); the
            // DEEP seat is paid by what it FILED, because a tool-carrying pass closes `torn_down` whenever
            // the session merely ENDED. So the deep seat also gets the `verdicts` row
            // `tools/reader.ts:submitVerdict` files, which is what
            // `phrase/exclusion.ts:groupCheckSeatAnswered` — and the rail through it — reads as reviewed.
            if (key.startsWith('wi_group_check_')) fileSeatReport(rig, run);
        }

        // The queue still wants the score, and the probe still says the phase may sign off. That is the
        // whole exception: display work is offered, never demanded.
        expect(scoreSeats(rig).map((seat) => seat.key)).toEqual([sectionScoreClaimKey(hash)]);
        expect(scoreRows(rig)).toEqual([]);
        expect(drainPreconditions(rig.store, rig.story())).toEqual({ met: true, unmet: [] });

        // A LIVE scoring run is the one case the drain DOES name — an open thread is in flight, and the
        // in-flight sentence is the only place the score family may appear in a gate.
        const live = rig.store.runs.create(
            {
                story_id: rig.storyId,
                work_item_ref: sectionScoreClaimKey('0123456789abcdef'),
                role: 'reader',
                state: 'reporting' satisfies RunState,
                started_at: '2026-11-25T10:00:03.000Z',
                ended_at: null,
                tokens: 2,
                kind: 'work',
                no_op: false,
                delegated: [],
                group_refs: groupsOf(rig).map((group) => group.id)
            },
            { run_ref: null, author: true, why: 'seed: a scoring pass still in flight' }
        );

        // In flight, yet it spends nothing: an attempt is spent only by a CLOSED run of a HOLDING kind, and
        // a scoring run is neither. (The count is 0 here because the install above was seeded as group rows
        // with no matching ledger row — `run_writer` is not a run.)
        expect(groupsOf(rig).map((group) => groupWriteAttempts(rig.store, rig.story(), group))).toEqual([0, 0, 0, 0, 0]);
        expect(isGroupHoldingRun(live)).toBe(false);
        expect(liveGroupSets(rig.store, rig.storyId)).toEqual([]);
        // The clause `loop/status.ts` adds for a scoring run names the pass WITHOUT making it owed work:
        // it is the in-flight sentence, not an unmet condition the sign-off gate waits on.
        expect(drainPreconditions(rig.store, rig.story())).toEqual({
            met: false,
            unmet: ['1 group-pipeline run still in flight (1 scoring the installed Overview) (R5, §6.4 steps 3-6)']
        });
    });
});
