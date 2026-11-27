/**
 * PHRASE SCOPE AT THE LOOP LAYER (R8/R9 follow-up) — which PHRASE's work a sweep is allowed to buy.
 *
 * The report this answers: "when Phrase ② starts, despite coming from Phrase ①, the staff start working
 * on Phrase ① again." The loop has one pointer (`shared/types.ts:308 Story.phase`), and once it says
 * `plotlines` the Summary is signed-off text (L-33). Two reads still answered "every claim on the book":
 *
 *   1. `work.ts`'s D-33 verify queue — it iterated EVERY unconfirmed finding, so a Phrase-① claim kept
 *      buying an Editor thread about settled text every sweep (the real book: 11 open Phrase-① claims, a
 *      fresh `wi_verify_finding_finding_16_1` in the last recorded sweep); and
 *   2. the Summary lane's group read — `phraseGroupsOf` WITHOUT a phrase id is EVERY phrase's rows
 *      (`phrase/catalog.ts:150-156`: "a caller that means one phrase — which is every pipeline caller —
 *      passes `phraseId`"), so the Summary's Critic, score and deep-review seats carried `chapter_1…N`
 *      beside `premise…ending` the moment the Author opened Phrase ②.
 *
 * WHY THESE TESTS GO THROUGH `generateWork` AND `drainPreconditions` RATHER THAN a full walk: the claim is
 * about the CANDIDATE SET — which Editor run exists, under which claim key, carrying which finding — and
 * about the sentence the Author's drain row shows beside it. A walk would report whatever the mock crew
 * happened to settle last, not the planner's decision.
 *
 * THE FOUR CLAIM SHAPES are the point of the first block, so the fix is proven NARROW: a claim about
 * Phrase ① alone drops out; an UNSCOPED claim (a `'classic'` book's whole-Overview meaning,
 * `phrase/findings.ts:findingGroupScope`), a claim about a chapter entry, and a claim that names groups
 * on BOTH phrases all keep their thread exactly as before. The mixed arm is not an accident: the accept
 * keeps mixed-scope claims alive on purpose (`loop/invalidation.ts:742-756`).
 *
 * EXACT VALUES: claim keys and finding ids come out of the same counter the planner reads
 * (`finding_0…finding_3`, `wi_verify_finding_<id>_1`), the group sets are asserted as GROUP KEYS (a UUID
 * proves nothing a reader can check), and the drain clauses are pinned as literal sentences because that
 * string is the product (L-22).
 *
 * F1 ADDS THE THIRD SITE. The first two blocks scope the QUEUE and the DRAIN; the last one walks the same
 * book to its sign-off and pins that the LOCK counts the rows the queue services (`phase2-work-scope.test.ts`'s
 * final block), which is where the scoping left the Phase-② lock barred forever with nobody able to clear it.
 */
import { describe, expect, it } from 'vitest';

import { createRig, walkTo } from './mock';
import { generateWork } from './work';
import { drainPreconditions, unconfirmedFindingsOwed } from './status';
import { AUTHOR_ATTR } from '../run/mock';
import { storyPhraseByKey } from '../phrase/catalog';
import { acceptPlotlineBrief, createPlotlineBrief, startPlotlinesPhrase } from '../phrase/controllers/plotlines';
import { PHRASE_PLOTLINES_KEY, PHRASE_SUMMARY_KEY } from '../../shared/phrase';
import type { Rig } from './mock';
import type { Finding, Story } from '../../shared/types';
import type { Store } from '../store';

/** The five Summary sections, in catalog order — the set the Summary lane's seats must always carry. */
const SUMMARY_KEYS = ['premise', 'promise', 'theme', 'tone', 'ending'];

/** A Story walked through phase ① and LOCKED into phase ②: the state the crew works Phrase ② in. */
const laneRig = async (): Promise<Rig> => {
    const rig = await createRig({ summaryMode: 'groups', summarySampling: 5, summaryCritics: 1 });

    await walkTo(rig, 'plotlines');
    await rig.engine.lockPhase(rig.storyId, 'summary');

    expect(rig.story()).toMatchObject({ phase: 'plotlines', summary_locked: true });

    return rig;
};

/** The Author's Start verb + structure pass, so the chapter entries exist as real rows. */
const structureLane = (rig: Rig, chapterCount = 2) => {
    const { phrase } = startPlotlinesPhrase(rig.store, rig.story(), 'A keeper refuses the relief boat.', AUTHOR_ATTR);
    const brief = createPlotlineBrief(rig.store, rig.story(), phrase, { chapter_count: chapterCount }, AUTHOR_ATTR);
    const accepted = acceptPlotlineBrief(rig.store, rig.story(), brief, AUTHOR_ATTR);

    return { phrase, chapters: accepted.groups };
};

/** One §4.10 `unconfirmed` claim, with or without `group_refs` — the shape `tools/reader.ts` files. */
const seedClaim = (
    store: Store,
    story: Story,
    groupRefs: string[] | undefined,
    fingerprint: string
): Finding =>
    store.findings.create(
        {
            story_id: story.id,
            target_ref: 'summary_0',
            criterion_ref: 'C-7',
            title: `an unconfirmed claim (${fingerprint})`,
            evidence: 'a line of the Overview contradicts another',
            cost: 'major',
            kind: 'issue',
            fingerprint,
            state: 'unconfirmed',
            seen_count: 1,
            ...(groupRefs === undefined ? {} : { group_refs: groupRefs })
        },
        AUTHOR_ATTR
    ) as Finding;

/** One Summary group's id, by catalog key. */
const summaryGroupId = (rig: Rig, key: string): string => {
    const summary = storyPhraseByKey(rig.store, rig.storyId, PHRASE_SUMMARY_KEY)!;

    return rig.store.phraseGroups
        .list()
        .filter((group) => group.phrase_id === summary.id && group.key === key)
        .map((group) => group.id)[0];
};

/** The D-33 verify queue, as `claim key -> finding id` pairs (the exact thing the report is about). */
const verifyQueue = (store: Store, story: Story): string[] =>
    generateWork(store, story, { at: new Date().toISOString(), phase: story.phase })
        .filter((job) => job.item.kind === 'verify_findings')
        .map((job) => `${job.key} -> ${(job.item.findingRefs ?? []).join(',')}`);

/** Every seat the Summary lane armed, as `kind -> the GROUP KEYS it carries`. */
const seatsWithGroupKeys = (store: Store, story: Story): string[] =>
    generateWork(store, story, { at: new Date().toISOString(), phase: story.phase })
        .filter((job) => job.item.groupRefs !== undefined)
        .map(
            (job) =>
                `${job.item.kind} -> ${JSON.stringify(
                    (job.item.groupRefs ?? []).map((id) => store.phraseGroups.get(id)?.key ?? id)
                )}`
        );

describe('Phase ② buys no Editor run about the signed-off Summary (R9)', () => {
    it('drops the Phrase-① claim from the verify queue and keeps the other three shapes', async () => {
        const rig = await laneRig();
        const { chapters } = structureLane(rig);
        const premiseId = summaryGroupId(rig, 'premise');

        // THE FOUR SHAPES, in one fixture, so the set difference is the whole answer.
        const settled = seedClaim(rig.store, rig.story(), [premiseId], 'phrase-1-only');
        const unscoped = seedClaim(rig.store, rig.story(), undefined, 'unscoped');
        const chapter = seedClaim(rig.store, rig.story(), [chapters[0].id], 'phrase-2');
        const mixed = seedClaim(rig.store, rig.story(), [premiseId, chapters[1].id], 'mixed');

        // Ids follow creation order off the store's counter, so the claim keys are stateable up front.
        expect([settled.id, unscoped.id, chapter.id, mixed.id]).toEqual([
            'finding_0',
            'finding_1',
            'finding_2',
            'finding_3'
        ]);

        // AFTER: three threads, and none of them is about Phrase ①. Before this change the same fixture
        // answered FOUR keys including `wi_verify_finding_finding_0_1` (`Temp/c4/r9a-before.out`), which is
        // the sweep "working on Phrase ① again".
        expect(verifyQueue(rig.store, rig.story())).toEqual([
            'wi_verify_finding_finding_1_1 -> finding_1',
            'wi_verify_finding_finding_2_1 -> finding_2',
            'wi_verify_finding_finding_3_1 -> finding_3'
        ]);

        // THE DRAIN AND THE QUEUE AGREE (L-37). The Author's row counts the three claims the crew still
        // owes a verdict on — not four; before, it said `4 findings still unconfirmed (D-33)` while the
        // sweep bought four threads, and it would have said 4 while buying three. The lane's own clause is
        // untouched and stays beside it.
        expect(drainPreconditions(rig.store, rig.story()).unmet).toEqual([
            '3 findings still unconfirmed (D-33)',
            '2 chapter contracts still owe the chapter set a draft or a fix pass (R2, §6.4 step 3)'
        ]);

        // NOTHING WAS VOIDED to get there: the settled claim is still the row the Author raised, in the
        // state the Author left it (P11 — the sweep stops WORKING on it, it does not rewrite the record).
        expect(rig.store.findings.require(settled.id)).toMatchObject({
            state: 'unconfirmed',
            group_refs: [premiseId]
        });
    });

    it('keeps that claim working while phase ① is still the live phase (no regression)', async () => {
        const rig = await createRig({ summaryMode: 'groups', summarySampling: 5, summaryCritics: 1 });
        const premiseId = summaryGroupId(rig, 'premise');
        const settled = seedClaim(rig.store, rig.story(), [premiseId], 'phrase-1-live');

        // Phase ①, the Summary unsigned: an identical row is ordinary D-33 work. `walkTo`/`lockPhase` above
        // is what makes the same claim settled text — the state, not the row, is what the predicate reads.
        expect(rig.story()).toMatchObject({ phase: 'summary', summary_locked: false });
        expect(verifyQueue(rig.store, rig.story())).toEqual([`wi_verify_finding_${settled.id}_1 -> ${settled.id}`]);
        expect(drainPreconditions(rig.store, rig.story()).unmet).toContain('1 finding still unconfirmed (D-33)');
    });

    it('keeps it working on a book whose later phase has no signed-off Summary (a restored book)', async () => {
        const rig = await laneRig();
        const premiseId = summaryGroupId(rig, 'premise');
        const settled = seedClaim(rig.store, rig.story(), [premiseId], 'phrase-1-unlocked');

        // The fail-open arm: L-33 pairs phase ② with a locked Summary, and a restored or hand-edited book
        // can sit in phase ② with the flag off. Nothing is settled there, so the claim keeps its thread —
        // the predicate refuses to infer a sign-off the record does not show.
        const story = rig.story();

        rig.store.stories.update(
            story.id,
            { summary_locked: false },
            { run_ref: null, author: true, why: 'seed: a restored book with the flag off' },
            [{ id: story.id, rev: story.rev }]
        );

        expect(rig.story()).toMatchObject({ phase: 'plotlines', summary_locked: false });
        expect(verifyQueue(rig.store, rig.story())).toEqual([`wi_verify_finding_${settled.id}_1 -> ${settled.id}`]);
    });
});

describe('the Summary lane reads the Summary phrase, not every phrase on the book (R9)', () => {
    it('carries the five sections on every seat, and still after Phrase ② opened on the same book', async () => {
        const rig = await createRig({ summaryMode: 'groups', summarySampling: 5, summaryCritics: 1 });

        // THE THREE SEATS, one per sweep, as the mock crew installs the Overview: the structured Critic
        // pass, then the tool-carrying deep pass, then the Reader's score of the reviewed vector. Each one
        // carries the group set the crew is asked to judge, and each one carries the five sections.
        const armed: string[][] = [];

        for (let sweep = 1; sweep <= 3; sweep += 1) {
            await rig.step();

            const seats = seatsWithGroupKeys(rig.store, rig.story());

            expect(seats).toHaveLength(1);
            expect(seats[0]).toContain(JSON.stringify(SUMMARY_KEYS));
            armed.push(seats);
        }

        expect(armed.map((seats) => seats[0].split(' -> ')[0])).toEqual([
            'review_groups',
            'check_unit',
            'score_sections'
        ]);

        // THE AUTHOR OPENS PHRASE ② WHILE PHASE ① IS STILL LIVE (the Start verb runs no phase gate, and the
        // crew stays on Phrase ① — R8's other half). Two chapter entries now sit on the SAME book, at
        // `order` 1 and 2, which is exactly where an unscoped group read interleaves them with `premise`.
        const { chapters } = structureLane(rig, 2);

        expect(chapters.map((group) => group.key)).toEqual(['chapter_1', 'chapter_2']);
        expect(rig.story().phase).toBe('summary');

        // THE SEAT SET AND ITS GROUP SET ARE UNCHANGED. Measured before the fix, this same seat carried
        // ["premise","chapter_1","promise","chapter_2","theme","tone","ending"] — seven refs against a
        // five-group vector hash, on a seat whose answer contract (`phrase/section-scores.ts`) refuses an
        // incomplete run — see `Temp/c4/r9b-before.out` against `Temp/c4/r9b-after.out`.
        expect(seatsWithGroupKeys(rig.store, rig.story())).toEqual([
            `score_sections -> ${JSON.stringify(SUMMARY_KEYS)}`
        ]);

        // And the lane's own claim key did not move: the vector is still the Summary's five, so opening a
        // second phrase cannot spend the Summary's review or score attempts.
        const [scoreSeat] = generateWork(rig.store, rig.story(), {
            at: new Date().toISOString(),
            phase: 'summary'
        }).filter((job) => job.item.kind === 'score_sections');

        expect(scoreSeat.key).toMatch(/^wi_summary_score_/);
        expect(chapters.length).toBe(2);
    });

    it('leaves the classic phase-② verification legs alone (the lane is not a mute)', async () => {
        const rig = await laneRig();
        const { chapters } = structureLane(rig);

        // A `'classic'` book has no group rows to scope by, and a group book's UNSCOPED claim has the same
        // legacy meaning. Either way the Editor still owes the claim a verdict — the fix removes Phrase-①
        // claims from a signed-off book's queue, not the D-33 leg itself.
        const unscoped = seedClaim(rig.store, rig.story(), undefined, 'legacy-phase-2');

        expect(verifyQueue(rig.store, rig.story())).toEqual([
            `wi_verify_finding_${unscoped.id}_1 -> ${unscoped.id}`
        ]);
        expect(chapters.map((group) => group.phrase_id)).toEqual([
            storyPhraseByKey(rig.store, rig.storyId, PHRASE_PLOTLINES_KEY)!.id,
            storyPhraseByKey(rig.store, rig.storyId, PHRASE_PLOTLINES_KEY)!.id
        ]);
    });
});

// ---------------------------------------------------------------------------
// F1 (L-37) — THE SIGN-OFF GATE COUNTS EXACTLY WHAT THE QUEUE SERVICES
// ---------------------------------------------------------------------------

/**
 * The third site of the R9 fix, and the one the Author actually feels. `work.ts:2404-2407` refuses to
 * arm a `verify_findings` thread for a claim about a phrase the Story settled and left behind, and
 * `drainPreconditions` subtracts the same row — but the PHASE SIGN-OFF (`status.ts:decideStory`'s
 * `findingsUnconfirmed === 0` clause) still counted the whole unscoped set. On a drained Phase-② book
 * holding one such claim, the probe said "nothing owed" while the lock said "1 finding still
 * unconfirmed", and since NO run is ever dispatched for that claim, nobody can ever settle it: the
 * clause is unsatisfiable. Measured before the fix (`Temp/c9/probe-f1-before.out`, sweeps `after 1-3`):
 * the Story fell to `ready` and, once the score seats were spent, to `pending/drained` — "1 finding
 * below the threshold, left open" — and the Phase-② lock was never offered again.
 *
 * WHY THE DECISION IS READ OFF `engine.sweep()` RATHER THAN `decideStory` DIRECTLY: the sweep is what
 * assembles the real `DecisionInput` (the Goal report, the round delta, the dispatchable count), and it
 * COMMITS the answer to the Story row (P1), so `status`/`pending_kind` are the product. `sweep()` (not
 * `step()`) is deliberate: it decides BEFORE the mock crew answers anything, so a claim the queue DOES
 * service is still unconfirmed when the gate is asked — arming a settle would erase the very row the arm
 * is about.
 *
 * THE DRAINED LANE is the fixture, and it is reached by sweeping, not by seeding rows: `structureLane`
 * hands the lane its chapter set and the mock crew then owes the structured review, the deep pass and
 * the score seats in turn (`loop/phase2-groups.test.ts` pins those seats one by one). The sweep count is
 * pinned as an exact number because the whole point is that the lane reaches the lock on its own.
 */
describe('the Phase ② sign-off counts what the queue owes (F1, L-37)', () => {
    /**
     * Sweeps the chapter lane until the Story stops being `ready`, i.e. until the crew's own work is
     * gone and a gate (the lock, or an Author wait) takes over. Returns the sweep count so the caller can
     * pin the fixture's determinism rather than trust it.
     */
    const drainLane = async (rig: Rig, max = 10): Promise<number> => {
        for (let sweep = 1; sweep <= max; sweep += 1) {
            await rig.step();

            if (rig.story().pending_kind !== 'none') return sweep;
        }

        throw new Error(`the chapter lane never went pending within ${max} sweeps`);
    };

    it('offers the lock when the only unconfirmed claim is settled Phrase ① text', async () => {
        const rig = await laneRig();

        structureLane(rig);

        // THE BASELINE: the lane's own work is what the crew spends, and when it is gone the Author's
        // lock is offered with nothing else outstanding.
        expect(await drainLane(rig)).toBe(6);
        expect(rig.story()).toMatchObject({ phase: 'plotlines', pending_kind: 'phase_signoff' });

        const premiseId = summaryGroupId(rig, 'premise');
        const settled = seedClaim(rig.store, rig.story(), [premiseId], 'phrase-1-signoff');

        // (a) THE QUEUE: no `verify_findings` candidate for a claim about settled text — the lane keeps
        // its score seat, and nothing is asked of the Editor.
        expect(verifyQueue(rig.store, rig.story())).toEqual([]);
        // (b) THE DRAIN AND THE GATE AGREE: the clause list is empty AND the read the sign-off consults is
        // empty. Before the fix these two disagreed silently — the drain said nothing, the lock counted 1.
        expect(drainPreconditions(rig.store, rig.story()).unmet).toEqual([]);
        expect(unconfirmedFindingsOwed(rig.store, rig.story())).toEqual([]);
        // (c) THE DECISION: the Phase-② lock is still offered. Before the fix this row was
        // `ready / none` ("the crew keeps working until it drains") for a debt the crew will never run.
        const report = await rig.engine.sweep();

        expect(report.stories[0]).toMatchObject({
            status: 'pending',
            pending_kind: 'phase_signoff'
        });

        // P11 — the decision stopped WORKING on the claim; it did not rewrite it. The Author still reads
        // the row in the state they left it (and the accept that discards it is still the Author's act).
        expect(rig.store.findings.require(settled.id)).toMatchObject({
            state: 'unconfirmed',
            group_refs: [premiseId]
        });
    });

    it('still withholds the lock for the three claim shapes the queue does service', async () => {
        const rig = await laneRig();
        const { chapters } = structureLane(rig);

        await drainLane(rig);

        // THE SAME BOOK, three claims that are NOT settled text: the legacy unscoped meaning, a chapter
        // entry, and a claim naming groups on BOTH phrases (`loop/invalidation.ts:742-756` keeps those
        // alive through the accept). The scoping must subtract Phrase ①'s rows, not the phase's work.
        const unscoped = seedClaim(rig.store, rig.story(), undefined, 'signoff-unscoped');
        const chapter = seedClaim(rig.store, rig.story(), [chapters[0].id], 'signoff-phrase-2');
        const mixed = seedClaim(
            rig.store,
            rig.story(),
            [summaryGroupId(rig, 'premise'), chapters[1].id],
            'signoff-mixed'
        );

        expect([unscoped.id, chapter.id, mixed.id]).toEqual(['finding_0', 'finding_1', 'finding_2']);

        expect(verifyQueue(rig.store, rig.story())).toEqual([
            'wi_verify_finding_finding_0_1 -> finding_0',
            'wi_verify_finding_finding_1_1 -> finding_1',
            'wi_verify_finding_finding_2_1 -> finding_2'
        ]);
        // Both sides count all three, in the same number and the same sentence (L-37).
        expect(unconfirmedFindingsOwed(rig.store, rig.story()).map((finding) => finding.id)).toEqual([
            'finding_0',
            'finding_1',
            'finding_2'
        ]);
        expect(drainPreconditions(rig.store, rig.story()).unmet).toEqual([
            '3 findings still unconfirmed (D-33)',
            // The lane's own clause comes along because a claim naming a chapter ENTRY also arms that
            // entry's next pass (`phrase/exclusion.ts:groupWorkTargets`' second reason). It is the second
            // half of the same honest answer, not a second count of the findings.
            '2 chapter contracts still owe the chapter set a draft or a fix pass (R2, §6.4 step 3)'
        ]);

        const report = await rig.engine.sweep();

        expect(report.stories[0]).toMatchObject({ status: 'ready', pending_kind: 'none' });
    });

    it('agrees with the queue on a book that holds both a settled claim and an owed one', async () => {
        const rig = await laneRig();
        const { chapters } = structureLane(rig);

        await drainLane(rig);

        const premiseId = summaryGroupId(rig, 'premise');
        const settled = seedClaim(rig.store, rig.story(), [premiseId], 'signoff-mixed-book');
        const owed = seedClaim(rig.store, rig.story(), [chapters[0].id], 'signoff-owed');

        // THE SHARPEST FORM OF THE PIN: the two claims are one row apart in the same book, the queue
        // services exactly one of them, and the gate must count exactly that one. Subtracting both would
        // have reached the same `phase_signoff` as the fix for the wrong reason.
        expect(verifyQueue(rig.store, rig.story())).toEqual([
            `wi_verify_finding_${owed.id}_1 -> ${owed.id}`
        ]);
        expect(unconfirmedFindingsOwed(rig.store, rig.story()).map((finding) => finding.id)).toEqual([owed.id]);
        expect(drainPreconditions(rig.store, rig.story()).unmet).toEqual([
            '1 finding still unconfirmed (D-33)',
            // The chapter clause belongs here: the owed claim names a chapter ENTRY, and an open finding
            // on an entry arms that entry's next pass (`phrase/exclusion.ts:groupWorkTargets`).
            '1 chapter contract still owe the chapter set a draft or a fix pass (R2, §6.4 step 3)'
        ]);

        const report = await rig.engine.sweep();

        expect(report.stories[0]).toMatchObject({ status: 'ready', pending_kind: 'none' });
        expect(rig.store.findings.require(settled.id).state).toBe('unconfirmed');
    });
});
