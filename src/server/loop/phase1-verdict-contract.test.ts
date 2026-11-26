// Phase ①'s deep-review VERDICT CONTRACT — the wording a real Reviewer is actually given, and both
// records it has to file against (C-14, §6.4 step 6, D-21/D-30 — CS-VERDICT-1 and CS-VERDICT-1b).
//
// WHY THIS FILE SITS AT THE LOOP LEVEL: the failure it pins lived in three layers at once.
// `loop/work.ts` wrote the sweep note, `run/brief.ts` clipped that note at 600 characters, and
// `criteria/engine.ts` graded C-14 against the Summary row alone. A unit test in any ONE of those
// files can pass while the shipped combination still fails — which is exactly what shipped: twenty
// Critic deep reviews filed at `revision_*`, no verdict at `summary_17`, and a phase-① Goal stuck at
// `1/2 · failing: C-14 / summary_17: no verdict yet`, which is what holds the Author's lock (and
// Phrase 2) shut. So the assertions below run on the Work Item the real sweep dispatched and the
// brief the real executor assembled for it, with the store's own minted ids.
//
// The criterion side of the contract (what the engine accepts as C-14's evidence, and in what recency
// order) is pinned in `criteria/engine.test.ts`; this file pins only the instruction.
import { describe, expect, it } from 'vitest';

import { createRig } from './mock';
// D-33c: the LIVE STATE line in a Critic brief is this exact predicate, so the rig assertion below
// compares the brief against the loop's answer rather than against a number typed into the test.
import { openIssueFindings, selectedSummaryRevision } from './records';
import type { Rig } from './mock';

/** `run/brief.ts:renderJob` clips the sweep's note at this many characters (S-2's budget). */
const NOTE_CHAR_CLIP = 600;

/**
 * The brief the chat double was really handed for the deep-review run. A tool-carrying REVIEW pass is
 * the only job that carries this banner — the screening passes run with no tools and get the compiled
 * §5 prompt instead — so the match cannot land on the wrong job (S-2, §4.13 `brief_hash`).
 */
function reviewBriefOf(rig: Rig): string {
    const request = rig.requests.find((candidate) =>
        candidate.messages.some((message) => message.content.includes('PASS MODE — REVIEW'))
    );

    if (request === undefined) throw new Error('the rig never dispatched a tool-using phase-① deep review');

    return request.messages.map((message) => message.content).join('\n\n');
}

/**
 * The engine-owned BANNER paragraph — `run/brief.ts:CRITIC_REVIEW_MODE` is one paragraph and the LIVE
 * STATE line is the NEXT one, so the slice ends at the first blank line. Absence assertions run against
 * this slice rather than the whole brief on purpose: the role prompt underneath it is the Author's copy
 * (`templates.ts`, edited by whoever owns the templates) and may still carry a retired sentence without
 * the ENGINE contradicting the tool.
 */
function bannerOf(text: string): string {
    const at = text.indexOf('PASS MODE — REVIEW');

    if (at === -1) throw new Error('the review brief carries no PASS MODE banner');

    const end = text.indexOf('\n\n', at);

    return text.slice(at, end === -1 ? text.length : end);
}

/** The LIVE STATE paragraph — `run/brief.ts:criticOpenIssueState`, the count read out of the store. */
function liveStateOf(text: string): string {
    const at = text.indexOf('LIVE STATE — ');

    if (at === -1) throw new Error('the review brief carries no LIVE STATE line');

    const end = text.indexOf('\n\n', at);

    return text.slice(at, end === -1 ? text.length : end);
}

/**
 * The job statement — `run/brief.ts:renderJob`'s FIRST block, ahead of the sweep's note (which the
 * brief clips at 600 characters) and ahead of the next section heading. Like the banner, this is the
 * slice whose retired wording the engine is answerable for.
 */
function jobStatementOf(text: string): string {
    const heading = '# THE JOB\n';
    const at = text.indexOf(heading);

    if (at === -1) throw new Error('the review brief carries no THE JOB section');

    const body = text.slice(at + heading.length);
    const boundaries = [
        body.indexOf("\nThe sweep's note on this job:"),
        body.indexOf('\n# ')
    ].filter((index) => index > -1);

    return boundaries.length === 0 ? body : body.slice(0, Math.min(...boundaries));
}

describe('phase ① deep review — the verdict contract a real Reviewer is given (C-14, CS-VERDICT-1)', () => {
    it('names BOTH verdict targets with the store’s real ids — the Summary unit and the selected draft — in the job and the done-line', async () => {
        // One sample, one Critic angle: the smallest book that still walks selection → deep review.
        const rig = await createRig({ summarySampling: 1, summaryCritics: 1 });

        await rig.run();

        const selected = selectedSummaryRevision(rig.store, rig.storyId);

        // ZERO-BASED ids (W1): the one sampled draft is the first revision its story mints, and the
        // Summary unit it belongs to is the first one, so both targets are `_0`.
        expect(selected?.id).toBe('revision_0');
        expect(selected?.unit_ref).toBe('summary_0');

        // The Work Item the sweep actually dispatched for the pass (`records.ts:deepReviewKeyOf`).
        // Its key embeds the revision id, so it moves with the id.
        const item = rig.items.get('wi_review_revision_0_a1');

        expect(item?.kind).toBe('check_unit');
        expect(item?.unit).toEqual({ kind: 'summary', ref: 'summary_0' });
        expect(item?.revisionRef).toBe('revision_0');

        const text = reviewBriefOf(rig);

        // -- The job line requires both verdict LINES, by id, in ONE call, and says which one the Goal
        //    reads. (2026-11-26: the pin moved from "Report the verdict TWICE with `submitVerdict`" to
        //    the single-terminal-report wording. The rule is the same two-line contract in the same
        //    order with the same ids — what changed is that it is now the CONTENT of one call, because
        //    the old phrasing read as two tool calls and a Critic pass spent round-trips on it.) ------
        expect(text).toContain('Put BOTH verdict lines in the pass\u2019s ONE terminal report');
        expect(text).toContain(
            'first at `target_ref` `summary_0` — the Summary unit the Goal\u2019s criteria are graded against, and the line the Goal actually reads'
        );
        expect(text).toContain('then at `target_ref` `revision_0`, the draft this brief carries');
        expect(text).toContain('Those two lines are one call, the last one this pass makes');

        // -- The pass's own done-definition names the SAME two targets, so the two cannot be read
        //    apart (D-30: the banner and the done-line are the binding mode of the review pass).
        expect(text).toContain(
            'BOTH verdict lines sit in the ONE terminal `submitVerdict` report you end with, at `target_ref` `summary_0` AND at `target_ref` `revision_0`'
        );

        // -- The shipped draft-only instruction cannot come back from either section.
        expect(text).not.toContain('against the revision named above');
        expect(text).not.toContain('Rate the sample with `submitVerdict`');
        expect(text).not.toContain('Report the verdict TWICE');
        // THE SWEEP NOTE CARRIES THE SAME RETIREMENT (2026-11-26): its leading clause used to order "File
        // TWO verdicts with submitVerdict", which is the same two-call shape the job line above bans. The
        // note is part of the brief, so the ban covers it too.
        expect(text).not.toContain('File TWO verdicts with submitVerdict');

        // -- The findings contract is unchanged: the unit is the target, the draft is a `related_ref`
        //    (D-21's attribution, `records.ts:findingRevisionScope`).
        expect(text).toContain('raiseFinding');
        expect(text).toContain('related_refs');

        // -- LIVE STATE (D-33c, 2026-11-26): the count the Critic used to have to discover by calling a
        //    tool is in the brief before any call. DERIVED, NOT COPIED: the expected sentence is built
        //    from `openIssueFindings` on the store this rig actually ended with, so the assertion pins
        //    parity with the gate in `tools/reader.ts:dismissedProposal`, not a fixture number. This rig
        //    reaches the deep review with nothing open, which is also the branch that must NOT claim a
        //    proposal is blocked.
        const openIssues = openIssueFindings(rig.store, rig.storyId);
        const liveState = liveStateOf(text);

        expect(openIssues).toEqual([]);
        expect(liveState).toContain(
            'LIVE STATE — no issue is open on this Story right now, so a Proposal you are certain of is admissible in this pass'
        );
        expect(liveState).not.toContain('dismissed');

        // Rendered by the REAL executor, ahead of the Author-editable angle prompt and of the tool
        // catalogue: the plumbing needs no new field on the Work Item, because `run/brief.ts` already
        // holds the store.
        expect(text.indexOf('PASS MODE — REVIEW')).toBeLessThan(text.indexOf('LIVE STATE — '));
        expect(text.indexOf('LIVE STATE — ')).toBeLessThan(text.indexOf('# THE JOB'));
        expect(text.indexOf('LIVE STATE — ')).toBeLessThan(text.indexOf('# TOOLS AND HOW TO END'));
    });

    it('sends the two-target instruction inside the note window that survives the 600-character clip', async () => {
        const rig = await createRig({ summarySampling: 1, summaryCritics: 1 });

        await rig.run();

        const text = reviewBriefOf(rig);
        const noteHeading = "The sweep's note on this job: ";
        const noteAt = text.indexOf(noteHeading);

        expect(noteAt).toBeGreaterThan(-1);

        // The note is longer than the clip, so the brief carries a TRUNCATED note — proof the window
        // assertions below are about the clipped form, not about a fixture that was short to begin
        // with. (This truncation is what hid the verdict instruction in the shipped build.)
        expect(text).toContain('… [clipped for the brief: ');

        const carriedNote = text.slice(noteAt + noteHeading.length, noteAt + noteHeading.length + NOTE_CHAR_CLIP);

        expect(carriedNote).toContain('File ONE submitVerdict with both verdict lines');
        expect(carriedNote).toContain('the goal verdict at target_ref summary_0');
        expect(carriedNote).toContain('and the draft\u2019s own line at target_ref revision_0');
        // The note never contradicts the job it accompanies.
        expect(carriedNote).not.toContain('never at the draft');
        // And the authoritative job line states the Summary target BEFORE the note is ever reached.
        expect(text.indexOf('`target_ref` `summary_0`')).toBeLessThan(noteAt);
    });

    it('hands a real Reviewer the Seed-silence rule in the durable sections AND inside the note window (T3)', async () => {
        // WHY THIS IS ASSERTED ON THE RIG AND NOT A FIXTURE: the Author's complaint was about behaviour
        // the unit-level tests could not see. The rule lives in three places at once — the engine banner
        // (`run/brief.ts:CRITIC_REVIEW_MODE`), the job line (`run/brief.ts:jobStatement`, `check_unit` +
        // `critic`), and the sweep note (`loop/work.ts`), which the brief CLIPS at 600 characters. A
        // change to any one of them can leave the shipped combination without the clause, which is how
        // `THE SEED IS GENERAL` came to sit at character 950 of a note nobody was sending.
        const rig = await createRig({ summarySampling: 1, summaryCritics: 1 });

        await rig.run();

        const text = reviewBriefOf(rig);

        // -- The unclipped job line: the permission, what it makes inadmissible, and the quote test ----
        expect(text).toContain(
            'The Seed is general and is not an outline: where it is silent, or names a question in `open_questions`, the Writer may invent any specific that does not contradict it.'
        );
        expect(text).toContain('are NOT defects and never a C-14 finding');
        expect(text).toContain(
            'Admissible proof is a quotation: file what you can quote the draft contradicting, and nothing that rests on an absence alone.'
        );
        // -- The engine banner ahead of the Author-editable angle prompt (D-30's binding mode) ---------
        expect(text).toContain(
            'WHAT COUNTS AS AN ISSUE: the Seed and its Brief are commitments, not an exhaustive outline'
        );
        // -- The gates T3 keeps, in the same pass: contradiction, the central commitment, and the
        //    phase-②/③ setup-and-payoff review that the Summary stand-down must not leak into.
        expect(text).toContain(
            'In later phases the chapter and plotline setup-and-payoff checks (C-4, C-5, C-6) stay exactly as they are.'
        );

        // -- The decisive clause also survives the note clip, with the store's own short ids.
        const noteHeading = "The sweep's note on this job: ";
        const noteAt = text.indexOf(noteHeading);

        expect(noteAt).toBeGreaterThan(-1);

        const carriedNote = text.slice(noteAt + noteHeading.length, noteAt + noteHeading.length + NOTE_CHAR_CLIP);

        expect(carriedNote).toContain('THIS IS THE OVERVIEW, NOT PROSE; THE SEED IS GENERAL, NOT AN OUTLINE');
        expect(carriedNote).toContain(
            'Added detail, an open Seed question, an unstated stake and unplanted setup are NOT defects'
        );
        // The rule is not ONLY in the clipped note: the job line states it before the note is reached, so
        // a note edit that pushes the clause out of the window costs emphasis, never the instruction.
        expect(text.indexOf('The Seed is general and is not an outline')).toBeLessThan(noteAt);
    });

    it('hands the same Reviewer the one D-33c rule and its live count, in the banner and the job line', async () => {
        // WHY THIS IS PINNED HERE RATHER THAN IN `brief.test.ts`: the rule is enforced in the tool
        // (`tools/reader.ts:dismissedProposal`), and the only copy of it the model ever sees is the brief
        // the executor assembles for a REAL dispatch — banner (`run/brief.ts:CRITIC_REVIEW_MODE`) ahead of
        // the Author-editable angle prompt, plus the job line (`run/brief.ts:jobStatement`, `check_unit` +
        // `critic`). Both are engine-owned, so an Author rewriting `critic-genre` still gets them; and
        // both are ahead of the sweep note, which `renderJob` clips at 600 characters. T3 is the precedent
        // for what happens when the durable copies drift and only the note carries the rule.
        //
        // THE TEST USED TO SAY "BOTH RULES". There is one now: the mirror rule ("an issue and a proposal
        // never share a pass") was removed with the dismissal on 2026-11-26
        // (`documents/specifications.md:333`), and the assertion set below is what that removal looks
        // like from the brief's side — the surviving rule, the dismissal's SHAPE (an answer that does not
        // invite another call), and the absence of the two retry sentences the retired rule came with.
        const rig = await createRig({ summarySampling: 1, summaryCritics: 1 });

        await rig.run();

        const text = reviewBriefOf(rig);
        const banner = bannerOf(text);
        const job = jobStatementOf(text);

        // -- The banner: ONE rule, stated with what the tool actually does ----------------------------
        expect(banner).toContain(
            'ISSUES COME FIRST, and the tool enforces it on the call (D-33c): while any issue on this Story is unresolved'
        );
        // The answer is a DISMISSAL, and the sentence says what that costs — no row, no work, no retry —
        // because the old wording ("refused and told how many issues are open") was an invitation to send
        // the same claim again, which is the round-trip the owner's complaint is about.
        expect(banner).toContain(
            'a `kind: proposal` claim is DISMISSED rather than refused — nothing is written, no work is armed, and the answer offers no retry'
        );
        // The resolution bar is stated in the same breath as the rule, because `approved` is the state a
        // crew reads as "done" and it is not, while `disputed` is the state a crew reads as "blocked" and
        // is not either: the holding set is exactly `unconfirmed`/`confirmed`/`approved`
        // (`loop/types.ts:ISSUE_HOLDING_STATES`).
        expect(banner).toContain(
            '(only `unconfirmed`, `confirmed` and `approved` hold one open; an issue marked `disputed`, `fixed` or `discarded` releases it)'
        );
        // …and the rule never strands the pass: an empty review is a valid answer, which is the half that
        // stops a Critic filing an absence to avoid standing down.
        expect(banner).toContain(
            'A pass that files nothing and reports that the text holds is a completed pass: S-4 counts a run that never REPORTS, never a run that filed no finding, so an empty pass is a valid, good outcome'
        );

        // -- The job line: the same rule in the sentence a tool-using pass acts on -------------------
        expect(job).toContain(
            'This is a REVIEW PASS: report defects and file genuine Proposals as `kind: proposal` findings — do not propose Ideas. ISSUES COME FIRST (D-33c): while any issue on this Story is unresolved'
        );
        expect(job).toContain(
            'a `kind: proposal` claim is DISMISSED on the call — no row, no work armed, and no retry to spend'
        );
        expect(job).toContain(
            'a pass that files nothing and reports that the text holds is a valid outcome, not a wasted run'
        );

        // -- The retired sentences are ABSENT from the two engine-owned sections, in any casing. The
        //    whole brief is NOT the assertion surface here: the angle prompt under the banner is the
        //    Author's copy in `templates.ts`, owned by another pass, and an Author may keep a sentence
        //    the engine no longer says.
        for (const retired of [
            'never share a pass',
            'refuses a `kind: proposal`',
            'call is refused and told how many issues are open',
            'bring it in a pass that has none left',
            'bring the improvement once the book has no defect left',
            'in the next review'
        ]) {
            expect(banner.toLowerCase()).not.toContain(retired);
            expect(job.toLowerCase()).not.toContain(retired);
        }

        // -- Everything above is in the unclipped parts: no note edit can push it out of the brief ----
        const noteAt = text.indexOf("The sweep's note on this job: ");

        expect(noteAt).toBeGreaterThan(-1);
        expect(text.indexOf('ISSUES COME FIRST, and the tool enforces it on the call')).toBeLessThan(noteAt);
        expect(text.indexOf('ISSUES COME FIRST (D-33c): while any issue on this Story is unresolved')).toBeLessThan(
            noteAt
        );
    });
});
