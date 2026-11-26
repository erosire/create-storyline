/**
 * THE GROUP LANES' CRITIC NOTE IS A ONE-CALL CONTRACT, AND THE WINDOW THE MODEL IS HANDED IS PINNED (G3).
 *
 * WHAT THIS FILE PINS, and why nothing else did. Two Work Items tell a Critic how to end its pass and
 * neither of them had a single assertion on its wording before this file: the Summary lane's deep seat
 * (`loop/work.ts:phase1GroupCandidates` leg 3, the `note:` literal at 1511-1516) and the chapter lane's
 * deep seat (`loop/work.ts:phase2GroupCandidates` leg 4, `note:` at 1875-1881). The two files that pin
 * the OTHER Critic note could not reach them:
 *
 *   * `run/brief.test.ts:deepReviewNote` extracts a note by scanning from `note: \`Critic pass` to the
 *     NEXT backtick, which is the legacy single-line note (`work.ts:2225`); the group notes are built
 *     from THREE concatenated template literals with a `groups.map(...)` hole inside, so that scan stops
 *     after the first fragment and silently pins a third of a sentence.
 *   * `loop/phase1-verdict-contract.test.ts` drives `createRig` at the rig default `summaryMode:
 *     'sampling'`, so its book has no phrase groups and never dispatches a group seat at all.
 *
 * So a wording edit to either group lane could — and did — move without any test noticing. That is the
 * gap this file closes: it renders the notes through the REAL planner and the REAL brief builder, and it
 * asserts the shipped phrases, the retired phrases' absence, and the exact 600-character window.
 *
 * THE CONTRACT (2026-11-26, G1 close-out). `submitVerdict` is the call that ENDS a Critic pass — the
 * termination plugin stops the thread at the next boundary after the tool ANSWERS successfully
 * (`run/plugins/critic-termination.ts`, pinned in `run/plugins/critic-termination.test.ts`) — and its
 * `findings[]` array is the `raiseFinding` body lifted UNCHANGED (`tools/reader.ts:submitVerdict`), so
 * both verdict lines AND every finding ride in that one report. The retired shape sent the seat to two
 * endpoints ("File the critical and major issues with raiseFinding on …" then "File the goal verdict
 * with submitVerdict at …"); the second call filed nothing, because the first had already closed the
 * thread. Both notes now say the one-call shape, and the angle prompts they are attached to already said
 * it (`templates/templates.ts:125`, `CRITIC_TERMINAL_REPORT`).
 *
 * THE WINDOW — MEASURED, NOT ASSUMED. `run/brief.ts:renderJob` keeps only `clip(item.note, 600)`, and
 * these two notes are 1,915 and 2,078 characters, so the model sees a TRUNCATED note. Unlike the legacy
 * sampling note — whose verdict instruction is front-loaded and IS inside the window (pinned by
 * `run/brief.test.ts` and `phase1-verdict-contract.test.ts`) — the group notes' one-call filing clause
 * begins at character 682 (Summary) and 954 (chapters), i.e. PAST the clip: their heads carry the
 * Seed-silence and cost rules first, and G1's edit was window-NEUTRAL precisely because the clause sits
 * outside it (`work.ts:1502-1510` and `:1869-1874` record the floor arithmetic). What the window has to
 * guarantee, then, is the negative half — the visible part must not order a second call — and that is
 * pinned here as an exact byte-level window (length, tail, and the absence of BOTH tool names), together
 * with the positive half where it actually ships: the unclipped, engine-owned surfaces of the SAME brief
 * (`run/brief.ts:jobStatement`'s check_unit/critic line and `run/brief.ts:criticReviewDone`). Those two
 * surfaces are PHASE-AWARE now, which changes what "one report" means per lane: the Summary lane's done
 * line still carries BOTH verdict lines in the one terminal report (`BOTH verdict lines sit in the ONE
 * terminal \`submitVerdict\` report you end with`), while the chapter lane — a whole-Story judgement with
 * no draft to rate — files ONE goal verdict at the Story row and every finding in the same call
 * (`is filed as a \`findings[]\` entry of the ONE terminal \`submitVerdict\` you end with, at \`target_ref\`
 * \`story_0\``). Both shapes are one call; only the Summary row has two lines in it. A note edit that drags
 * the two-call shape into the window, or that pushes the one-call clause further out than the pinned
 * offsets, fails here rather than in the run's token bill.
 *
 * DETERMINISM. Ids are the rig's own (`story_0`, `summary_0`, the catalog's five group keys,
 * `chapter_1..chapter_3`), and the seat vector is always 16 hex characters, so every length and offset
 * below is fixed even though the hash VALUE varies with the store's mint order. Nothing is read back off
 * the implementation: the expected sentences are the shipped strings, written out.
 */
import { describe, expect, it } from 'vitest';

import { createRig, walkTo, type Rig } from './mock';
import { generateWork, phase2GroupCandidates } from './work';
import { AUTHOR_ATTR } from '../run/mock';
import {
    GROUP_DRAFT_ITEM_PREFIX,
    groupCheckSeatKey,
    groupReviewSeatKey
} from '../phrase/exclusion';
import { storyPhraseByKey } from '../phrase/catalog';
import { acceptPlotlineBrief, createPlotlineBrief, startPlotlinesPhrase } from '../phrase/controllers/plotlines';
import { groupRevisionVector, groupVectorHash, installGroupRevisions } from '../phrase/revisions';
import { PHRASE_PLOTLINES_KEY, PHRASE_SUMMARY_KEY } from '../../shared/phrase';
import type { PhraseGroup } from '../../shared/types';

/** `run/brief.ts:renderJob`'s budget for the sweep's note — `clip(item.note, 600)`. */
const NOTE_CHAR_CLIP = 600;

/** The heading `renderJob` puts in front of the clipped note, so the window can be sliced out of a brief. */
const NOTE_HEADING = "The sweep's note on this job: ";

/** The two-call shape BOTH group lanes used to send, and must never send again. */
const RETIRED_TWO_CALL = [
    'File the critical and major issues with raiseFinding',
    'File the goal verdict with submitVerdict'
];

/** The findings clause both lanes ship: the entries ride in the call that ENDS the pass. */
const FILING_CLAUSE =
    'File the critical and major issues you are certain of as findings[] entries of the ONE submitVerdict this pass ends with';

/** The verdict clause both lanes ship: the goal line joins that same report, at the seat's own target. */
const GOAL_CLAUSE = 'File the goal verdict in that SAME submitVerdict, at target_ref ';

/** What the report is: the pass's last call, filed once, with nothing after it. */
const ONE_REPORT_CLAUSE =
    '— ONE report, the last call this pass makes, its thread over the moment it fires, so the findings and the verdict go together and nothing is filed after it.';

/** The narrowed minor clause (the angle prompts' words, not the open permission the note used to grant). */
const MINOR_CLAUSE =
    'A minor note belongs in that report only when it is already obvious, never because the shelf was searched';

/** The one-call contract, in the exact words both lanes ship. Shared because the two notes agree verbatim. */
const ONE_CALL_LINES = [FILING_CLAUSE, GOAL_CLAUSE, ONE_REPORT_CLAUSE, MINOR_CLAUSE];

/** The engine-owned done-line sentence for the SUMMARY lane (`run/brief.ts:criticReviewDone`). */
const DONE_LINE_ONE_CALL = 'BOTH verdict lines sit in the ONE terminal `submitVerdict` report you end with';

/** The engine-owned job-line sentence for the SUMMARY lane (`run/brief.ts:jobStatement`, `check_unit` + `critic`). */
const JOB_LINE_ONE_CALL =
    'The pass ends with ONE terminal `submitVerdict` report carrying both verdict lines and every finding you are sure of';

/**
 * The SAME two surfaces on the CHAPTER lane, where the artifact is the whole contract chain and there is
 * no draft row to rate: ONE goal verdict at the Story row, every finding in the same call. `story.id` is
 * interpolated by the engine, so the pin includes the row id this book mints.
 */
const CHAPTER_DONE_LINE_ONE_CALL =
    'is filed as a `findings[]` entry of the ONE terminal `submitVerdict` you end with, at `target_ref` `story_0`';

const CHAPTER_JOB_LINE_ONE_CALL =
    'Put the goal verdict in the pass’s ONE terminal report, at `target_ref` `story_0` — the whole Story the chapter contracts are graded against. The findings ride in that same report as `findings[]`; there is no draft line to file.';

/** The phase banner `run/brief.ts:criticReviewModeOf` picks for a chapter-contract seat. */
const CHAPTER_REVIEW_BANNER =
    'PASS MODE — CHAPTER-CONTRACT REVIEW (this overrides any wider instruction in the role prompt below). The chapter contracts and the phrase seed are in this brief';

const AT = '2026-11-24T10:00:03.000Z';

/** One rendered lane: the note the sweep attaches, and the brief the executor really assembled for it. */
interface Lane {
    /** The seat's claim key, so a test can prove the note it read is the note the seat ran with. */
    key: string;
    /** The UNCLIPPED note `loop/work.ts` built for the deep seat. */
    note: string;
    /** The whole brief the chat double was handed for that seat — note clipped at `NOTE_CHAR_CLIP`. */
    brief: string;
}

/** The phrase entries one lane owns, in the order the catalog / brief materialized them. */
const groupsFor = (rig: Rig, phraseId?: string): PhraseGroup[] =>
    rig.store.phraseGroups
        .list()
        .filter((group) => group.story_id === rig.storyId && (phraseId === undefined || group.phrase_id === phraseId))
        .sort((left, right) => left.order - right.order);

/**
 * An ANSWERED structured review pass. The deep seat arms only once every review seat for the vector has
 * reported (`phrase/exclusion.ts:allReviewSeatsReported`), and `torn_down` is the one closed state the
 * engine counts as an answer (`loop/records.ts:isReportedRun`), so the seat is armed by a row rather than
 * by a model.
 */
const answerReviewSeats = (rig: Rig, vectorHash: string, groupIds: string[]): void => {
    rig.store.runs.create(
        {
            story_id: rig.storyId,
            work_item_ref: groupReviewSeatKey(vectorHash, 1),
            role: 'critic',
            state: 'torn_down',
            started_at: '2026-11-24T10:00:00.000Z',
            ended_at: '2026-11-24T10:30:01.000Z',
            tokens: 11_958,
            kind: 'work',
            no_op: false,
            delegated: [],
            group_refs: groupIds
        },
        { run_ref: null, author: true, why: 'pin: the structured review seat for this vector answered' }
    );
};

/** The brief that carries a given note, out of the rig's request log (the real dispatch, not a fixture). */
const briefFor = (rig: Rig, marker: string): string => {
    const request = rig.requests.find((candidate) =>
        candidate.messages.some((message) => (message.content ?? '').includes(marker))
    );

    if (request === undefined) throw new Error(`the rig never dispatched a seat whose brief carries "${marker}"`);

    return request.messages.map((message) => message.content).join('\n\n');
};

/** The 600-character window a brief actually shows for its note. */
const windowOf = (brief: string): string => {
    const at = brief.indexOf(NOTE_HEADING);

    if (at === -1) throw new Error('the dispatched brief carries no sweep note');

    return brief.slice(at + NOTE_HEADING.length, at + NOTE_HEADING.length + NOTE_CHAR_CLIP);
};

/** Builds a lane once per process: the scene is read-only, and a rig is the expensive part. */
const once = <T>(build: () => Promise<T>) => {
    let built: Promise<T> | undefined;

    return (): Promise<T> => {
        if (built === undefined) built = build();

        return built;
    };
};

/**
 * PHRASE ①'s group lane: five installed Overview groups, one Critic seat, the review gate opened by hand.
 * The candidate is taken from `generateWork` (what the planner attaches), and the brief from the sweep that
 * dispatches it — the two are asserted equal inside the window, so a note that stopped being the seat's own
 * would fail rather than drift.
 */
const summaryLane = once(async (): Promise<Lane> => {
    const rig = await createRig({
        summaryMode: 'groups',
        summarySampling: 5,
        summaryCritics: 1,
        // D-51 waiver, so no sampler job competes with the seat for the sweep's one slot.
        crew: { researchQuestions: [] }
    });

    const groups = groupsFor(rig);

    installGroupRevisions(
        rig.store,
        rig.story(),
        groups.map((group) => ({ group, content: `${group.key}: the installed Overview text.` })),
        AUTHOR_ATTR,
        { runRef: 'run_writer', workItemRef: `${GROUP_DRAFT_ITEM_PREFIX}_summary_0_probe_1` }
    );

    const vectorHash = groupVectorHash(groupRevisionVector(rig.store, rig.storyId));

    answerReviewSeats(rig, vectorHash, groups.map((group) => group.id));

    const seat = generateWork(rig.store, rig.story(), { at: AT, phase: 'summary' }).find(
        (candidate) => candidate.key === groupCheckSeatKey(vectorHash, 1)
    );

    if (seat === undefined) throw new Error('the group Overview deep seat never armed');

    // The real dispatch: `run/brief.ts` clips the note on the way to the model, and the chat double's
    // request log is the only place that clipping is observable.
    await rig.step();

    return {
        key: seat.key,
        note: seat.item.note ?? '',
        brief: briefFor(rig, 'on the installed group Overview at vector')
    };
});

/**
 * PHRASE ②'s chapter lane: the lane started and structured by the controllers, its contracts installed by
 * hand (so no crew pass mints a second vector), and its review seat answered. The deep pass is armed and
 * dispatched like the Summary lane's, on the CHAPTER vector.
 */
const chapterLane = once(async (): Promise<Lane> => {
    const rig = await createRig({
        summaryMode: 'groups',
        summarySampling: 5,
        summaryCritics: 1,
        crew: { researchQuestions: [] }
    });

    await walkTo(rig, 'plotlines');
    await rig.engine.lockPhase(rig.storyId, 'summary');

    const summary = storyPhraseByKey(rig.store, rig.storyId, PHRASE_SUMMARY_KEY);
    const started = startPlotlinesPhrase(rig.store, rig.story(), summary!.content, AUTHOR_ATTR);
    const brief = createPlotlineBrief(rig.store, rig.story(), started.phrase, { chapter_count: 3 }, AUTHOR_ATTR);
    const accepted = acceptPlotlineBrief(rig.store, rig.story(), brief, AUTHOR_ATTR);

    installGroupRevisions(
        rig.store,
        rig.story(),
        accepted.groups.map((group) => ({
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

    const vectorHash = groupVectorHash(groupRevisionVector(rig.store, rig.storyId, started.phrase.id));

    answerReviewSeats(rig, vectorHash, accepted.groups.map((group) => group.id));

    const seat = phase2GroupCandidates(rig.store, rig.story()).find(
        (candidate) => candidate.key === groupCheckSeatKey(vectorHash, 1)
    );

    if (seat === undefined) throw new Error('the chapter-contracts deep seat never armed');

    // The lane's seat arms only between the other legs' sweeps, so the walk — not one step — is what
    // reaches the dispatch. The note asserted below is still this seat's own: the window equality proves it.
    await rig.run();

    return {
        key: seat.key,
        note: seat.item.note ?? '',
        brief: briefFor(rig, 'on the installed chapter contracts at vector')
    };
});

describe('the group lanes end their pass in ONE submitVerdict, in the shipped words (G1 close-out, G3 pin)', () => {
    it('the Summary lane names one report for the findings AND the goal verdict, and never a second endpoint', async () => {
        const lane = await summaryLane();

        for (const line of ONE_CALL_LINES) expect(lane.note).toContain(line);

        // The two targets the one report carries, by the store's own ids (CS-VERDICT-1's shape, group edition).
        expect(lane.note).toContain('each at target_ref summary_0: detail');
        expect(lane.note).toContain('File the goal verdict in that SAME submitVerdict, at target_ref summary_0 — ONE report');
        // R3's scope clause, which is the whole reason this lane exists beside the legacy one.
        expect(lane.note).toContain('`group_refs` naming every group the defect is about, as the group ids in the brief.');

        // THE RETIRED SHAPE, absent rather than merely not-first: a second filing endpoint would cost the
        // pass a round-trip after the thread is already closed.
        for (const retired of RETIRED_TWO_CALL) expect(lane.note).not.toContain(retired);
        // And the note never mentions the standalone filing call at all, so it cannot read as two reports.
        expect(lane.note).not.toContain('raiseFinding');
    });

    it('the chapter lane says the same contract about chapter contracts, and never a second endpoint', async () => {
        const lane = await chapterLane();

        for (const line of ONE_CALL_LINES) expect(lane.note).toContain(line);

        // A chapter seat targets the Story row, because the artifact is the whole contract chain.
        expect(lane.note).toContain('each at target_ref story_0: detail');
        expect(lane.note).toContain('File the goal verdict in that SAME submitVerdict, at target_ref story_0 — ONE report');
        expect(lane.note).toContain('`group_refs` naming EVERY chapter the defect crosses, as the chapter group ids in the brief.');
        // The chain question this lane asks and the Overview lane does not.
        expect(lane.note).toContain('THE CHAIN IS THE THING TO CHECK');

        for (const retired of RETIRED_TWO_CALL) expect(lane.note).not.toContain(retired);
        expect(lane.note).not.toContain('raiseFinding');
    });
});

describe('the 600-character window is what the model receives, and it orders no second call', () => {
    it('the Summary lane: the brief carries exactly the first 600 characters, byte-identical and tool-free', async () => {
        const lane = await summaryLane();
        const window = windowOf(lane.brief);

        // The note is longer than the clip, so this IS a truncation and not a short fixture.
        expect(lane.note.length).toBe(1_915);
        expect(lane.brief).toContain('… [clipped for the brief: ');
        expect(window.length).toBe(NOTE_CHAR_CLIP);

        // The window is the note's own head — proof the seat that ran carried the note this test reads.
        expect(window).toBe(lane.note.slice(0, NOTE_CHAR_CLIP));

        // Byte-identical tail: G1's edit had to land past the clip, and this is the pin that says it did.
        expect(window.endsWith("register are a PROPOSAL (kind 'proposal', cost 'ta")).toBe(true);

        // The retired sentences are gone from the whole note, so a fortiori from the window — and the
        // window names NEITHER tool, so the visible part of the note can never order a second call.
        for (const retired of RETIRED_TWO_CALL) expect(window).not.toContain(retired);
        expect(window).not.toContain('raiseFinding');
        expect(window).not.toContain('submitVerdict');

        // The one-call instruction sits just past the window, at the pinned offsets: 682 for the filing
        // clause and 769 for the first mention of the tool (the floor with every id empty is 662 —
        // `work.ts:1507-1509`). Pinning the offsets is what makes a head edit that pushes the clause out
        // of the note visible: the legacy note's instruction is inside the window, this one is not, and
        // the rule reaches the model through the unclipped brief surfaces asserted below.
        expect(lane.note.indexOf(FILING_CLAUSE)).toBe(682);
        expect(lane.note.indexOf('submitVerdict')).toBe(769);
        expect(lane.note.indexOf(GOAL_CLAUSE)).toBe(1_373);
    });

    it('the chapter lane: the same window guarantee, at this lane\u2019s own offsets', async () => {
        const lane = await chapterLane();
        const window = windowOf(lane.brief);

        expect(lane.note.length).toBe(2_078);
        expect(lane.brief).toContain('… [clipped for the brief: ');
        expect(window.length).toBe(NOTE_CHAR_CLIP);
        expect(window).toBe(lane.note.slice(0, NOTE_CHAR_CLIP));
        expect(window.endsWith('judge it as a contract, not as a ')).toBe(true);

        for (const retired of RETIRED_TWO_CALL) expect(window).not.toContain(retired);
        expect(window).not.toContain('raiseFinding');
        expect(window).not.toContain('submitVerdict');

        // Floor with every id empty is 940 (`work.ts:1872-1874`); 954 with this book's chapter ids.
        expect(lane.note.indexOf(FILING_CLAUSE)).toBe(954);
        expect(lane.note.indexOf('submitVerdict')).toBe(1_041);
        expect(lane.note.indexOf(GOAL_CLAUSE)).toBe(1_538);
    });
});

describe('the note and the engine-owned brief surfaces say ONE call in the same brief (run/brief.ts)', () => {
    it('the Summary lane: the done-line and the job line precede the note, and the note never contradicts them', async () => {
        const lane = await summaryLane();

        // The two engine-owned surfaces (`criticReviewDone` and `jobStatement`) are in the dispatched brief
        // verbatim — this is the wording `documents/specifications.md` D-33c converged the crew on.
        expect(lane.brief).toContain(DONE_LINE_ONE_CALL);
        expect(lane.brief).toContain(JOB_LINE_ONE_CALL);

        // Both sit in the unclipped part of the brief, AHEAD of the note, so no note edit can push the
        // instruction out of the run: the note adds emphasis, it is never the only copy (T3's precedent).
        expect(lane.brief.indexOf(DONE_LINE_ONE_CALL)).toBeLessThan(lane.brief.indexOf(NOTE_HEADING));
        expect(lane.brief.indexOf(JOB_LINE_ONE_CALL)).toBeLessThan(lane.brief.indexOf(NOTE_HEADING));

        // The two surfaces cannot be read apart: the done-line says the verdict lines sit in the ONE
        // terminal report, and the note says the same in its own words — and never routes a finding to a
        // separate `raiseFinding` call, which is the only shape that would contradict it.
        expect(lane.note).toContain('the ONE submitVerdict this pass ends with');
        expect(lane.note).toContain('ONE report, the last call this pass makes');
        expect(lane.note).not.toContain('raiseFinding');
    });

    it('the chapter lane: the same one-report agreement, on a seat that carries no unit ref of its own', async () => {
        const lane = await chapterLane();

        // This seat is the phase-② lane's: no unit, so `run/brief.ts:criticReviewModeOf` reads the STORY
        // phase and picks the chapter-contract banner, and the done-line and job line drop the Summary's
        // two-line contract — there is no draft row here to rate, so the one report carries ONE goal
        // verdict at the Story row plus the findings.
        expect(lane.brief).toContain(CHAPTER_REVIEW_BANNER);
        expect(lane.brief).toContain(CHAPTER_DONE_LINE_ONE_CALL);
        expect(lane.brief).toContain(CHAPTER_JOB_LINE_ONE_CALL);
        expect(lane.brief.indexOf(CHAPTER_DONE_LINE_ONE_CALL)).toBeLessThan(lane.brief.indexOf(NOTE_HEADING));
        expect(lane.brief.indexOf(CHAPTER_JOB_LINE_ONE_CALL)).toBeLessThan(lane.brief.indexOf(NOTE_HEADING));

        // The Summary-only shape cannot leak into a whole-Story seat: it would send the pass looking for a
        // draft verdict line that does not exist at this phase.
        expect(lane.brief).not.toContain('BOTH verdict lines');

        expect(lane.note).toContain('the ONE submitVerdict this pass ends with');
        expect(lane.note).toContain('ONE report, the last call this pass makes');
        expect(lane.note).not.toContain('raiseFinding');
    });
});
