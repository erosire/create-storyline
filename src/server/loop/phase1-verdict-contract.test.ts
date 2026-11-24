// Phase ①'s deep-review VERDICT CONTRACT — the wording a real Reviewer is actually given, and both
// records it has to file against (C-14, §6.4 step 6, D-21/D-30 — CS-VERDICT-1 and CS-VERDICT-1b).
//
// WHY THIS FILE SITS AT THE LOOP LEVEL: the failure it pins lived in three layers at once.
// `loop/work.ts` wrote the sweep note, `run/brief.ts` clipped that note at 600 characters, and
// `criteria/engine.ts` graded C-14 against the Summary row alone. A unit test in any ONE of those
// files can pass while the shipped combination still fails — which is exactly what shipped: twenty
// Reader deep reviews filed at `revision_*`, no verdict at `summary_17`, and a phase-① Goal stuck at
// `1/2 · failing: C-14 / summary_17: no verdict yet`, which is what holds the Author's lock (and
// Phrase 2) shut. So the assertions below run on the Work Item the real sweep dispatched and the
// brief the real executor assembled for it, with the store's own minted ids.
//
// The criterion side of the contract (what the engine accepts as C-14's evidence, and in what recency
// order) is pinned in `criteria/engine.test.ts`; this file pins only the instruction.
import { describe, expect, it } from 'vitest';

import { createRig } from './mock';
import { selectedSummaryRevision } from './records';
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

describe('phase ① deep review — the verdict contract a real Reviewer is given (C-14, CS-VERDICT-1)', () => {
    it('names BOTH verdict targets with the store’s real ids — the Summary unit and the selected draft — in the job and the done-line', async () => {
        // One sample, one Reader angle: the smallest book that still walks selection → deep review.
        const rig = await createRig({ summarySampling: 1, summaryReaders: 1 });

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

        // -- The job line requires both filing forms, by id, and says which one the Goal reads ------
        expect(text).toContain('Report the verdict TWICE with `submitVerdict`');
        expect(text).toContain(
            'first at `target_ref` `summary_0` — the Summary unit the Goal\u2019s criteria are graded against, and the line the Goal actually reads'
        );
        expect(text).toContain('then at `target_ref` `revision_0`, the draft this brief carries');

        // -- The pass's own done-definition names the SAME two targets, so the two cannot be read
        //    apart (D-30: the banner and the done-line are the binding mode of the review pass).
        expect(text).toContain(
            'the goal verdict is filed with `submitVerdict` at `target_ref` `summary_0` AND at `target_ref` `revision_0`'
        );

        // -- The shipped draft-only instruction cannot come back from either section.
        expect(text).not.toContain('against the revision named above');
        expect(text).not.toContain('Rate the sample with `submitVerdict`');

        // -- The findings contract is unchanged: the unit is the target, the draft is a `related_ref`
        //    (D-21's attribution, `records.ts:findingRevisionScope`).
        expect(text).toContain('raiseFinding');
        expect(text).toContain('related_refs');
    });

    it('sends the two-target instruction inside the note window that survives the 600-character clip', async () => {
        const rig = await createRig({ summarySampling: 1, summaryReaders: 1 });

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

        expect(carriedNote).toContain('File TWO verdicts with submitVerdict');
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
        // (`run/brief.ts:READER_REVIEW_MODE`), the job line (`run/brief.ts:jobStatement`, `check_unit` +
        // `reader`), and the sweep note (`loop/work.ts`), which the brief CLIPS at 600 characters. A
        // change to any one of them can leave the shipped combination without the clause, which is how
        // `THE SEED IS GENERAL` came to sit at character 950 of a note nobody was sending.
        const rig = await createRig({ summarySampling: 1, summaryReaders: 1 });

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
});
