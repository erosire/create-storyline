// R7 (this wave) — the Phrase-② STRUCTURE SEAT's job sentence, on the section the brief may drop.
//
// WHY A FILE THIS SMALL: one sentence in the seat's law was telling the Editor something the brief no longer
// guarantees. `run/brief.ts`'s seat-aware trim rung (`brief.ts:1207-1222`, `renderWithinBudget`'s
// `seatTrimHeading`) drops the derived phase-① `SEED BRIEF` section when the brief runs over budget — the ONE
// section it will trade for a character count, because the seat's own job sentence demoted it to context. The
// sentence said, unconditionally, that the `SEED` and `SEED BRIEF` sections "are above". On an over-budget
// chapter brief the seat was told to look for a heading that had been trimmed away, which is the kind of
// instruction an agent follows by inventing the missing material.
//
// WHAT THIS PINS:
//   1. THE SENTENCE IS CONDITIONAL, and says so — it names the section that can be gone and tells the seat not
//      to go looking for it, while keeping the two things that must not move: `SEED`/`SEED BRIEF` stay demoted
//      to context, and the `PHRASE SEED` stays the only text the seat structures and hashes.
//   2. THE OLD SENTENCE IS GONE VERBATIM, so the fix cannot be re-softened back into a promise.
//   3. F3 — the CONDITIONAL WORDING ITSELF was still a presence claim ("`SEED BRIEF` beside it"), and the rung
//      it warns about is not a rare event: this seat's brief is over `BRIEF_CHAR_BUDGET` on the built-in
//      template at every seed size measured (14,247 chars at a 422-char seed, 38,248 at 24k — the probe log
//      `Temp/c9/probe-f3.out` shows `has_seed_brief: false` on all five rows), so in production the section is
//      NEVER there and the copy was still pointing at it. The sentence now states the trade and nothing about
//      presence, which is the only form that cannot go stale: `run/brief.ts` decides the trim AFTER the job
//      text is composed. Fitting the budget is a separate recorded hole, deliberately not attempted here.
//
// The instruction text lives in the CONTROLLER (D-70: each phrase owns its own law) and reaches the seat
// through `run/brief.ts:jobStatement`, which this file deliberately does not reach into — the brief's own
// placement of the section is pinned in `run/brief.test.ts`.
import { describe, expect, it } from 'vitest';
import { plotlinesPhraseController } from './controllers/plotlines';
import { seedStory } from '../run/mock';
import { Store } from '../store/store';
import { seedHashOf } from '../../shared/seed-hash';

/** THE SENTENCE AS IT MUST READ, spelled out whole so a future softening shows up as a diff. */
const CONDITIONAL_SENTENCE =
    'Phrase ①’s `SEED` section above is context only, and so is the derived `SEED BRIEF` — and that second ' +
    'heading is NOT one this brief guarantees you: it is the single section the seat-aware rung in `run/brief.ts` ' +
    'trades for a character count when the brief runs over budget, so read the headings that are actually in front ' +
    'of you and never go looking for one that is not there. Neither section is the text you are structuring, ' +
    'either: that is the `PHRASE SEED`, and the hash you answer with is that text’s.';

/** The promise that used to stand in its place, kept here so its absence is a pinned fact (AC6). */
const STALE_SENTENCE =
    'The `SEED` and `SEED BRIEF` sections above are Phrase ①’s material and they are context only';

/**
 * F3 — the SECOND promise, the one that survived the first fix. `beside it` asserted the section's PRESENCE,
 * and presence is exactly what the seat-aware rung does not guarantee: on the built-in template this seat's
 * brief is over `BRIEF_CHAR_BUDGET` at every seed size (14,247 characters on a 422-character compiled
 * Overview → 38,248 on a 24k one; `Temp/c9/probe-f3.out`), so the rung drops the section on every real run
 * and the copy was pointing at a heading nobody was shown. A seat told to read a section it never received is
 * a seat that invents one.
 */
const STALE_PRESENCE_CLAIM = '`SEED BRIEF` beside it';

/**
 * A Story with no Phrase ② row: `plotlinesStructureJob` then reads its seed through `phraseSeedOf`'s
 * documented fallback (`stories.idea`), so the hash it prints is a value this file can state rather than
 * one it has to invent. The job sentence's shape does not depend on the phrase existing.
 */
function rig() {
    const store = Store.empty();
    const story = seedStory(store, {
        idea: 'Six chapters, alternating timeline, and no frame story — the coast is the only narrator.',
        title: 'The Salt Cartographer'
    });

    return { store, story };
}

describe('the Phrase ② structure seat is told which sections the brief guarantees (AC6)', () => {
    it('names the trimmable section conditionally, and still points only at the PHRASE SEED', () => {
        const { store, story } = rig();

        // The seat's law is DATA on the controller (D-70), and this is the exact call `run/brief.ts` makes.
        const job = plotlinesPhraseController.instructions.structure.job({ store, story });

        expect(job).toContain(CONDITIONAL_SENTENCE);
        // The old promise is gone, verbatim: it is the sentence the trim rung made false.
        expect(job).not.toContain(STALE_SENTENCE);
        // F3 — and so is the sentence that replaced it once before. The copy may demote the section, explain the
        // trade, or tell the seat to read what is on the page; what it may never do again is assert that the
        // heading is THERE, because the rung that decides presence runs after this string was composed.
        expect(job).not.toContain(STALE_PRESENCE_CLAIM);
        // The two facts the fix must NOT move: the phase-① material is context, and the phrase seed is the
        // artifact. A seat that lost either one is the seat that structures Phrase ① by mistake.
        expect(job).toContain('Structure the `PHRASE SEED` section of this brief BEFORE any chapter contract is drafted');
        expect(job).toContain(`and seed_hash=${seedHashOf(story.idea)}`);
    });

    it('keeps the seed section itself whole: the heading carries the hash the tool has to answer with', () => {
        const { store, story } = rig();

        // `seedSection` is the unclipped artifact the seat structures (E-1/D-13), and it is what makes the
        // hash printable at all: the job NOTE is clipped to 600 characters, so a long compiled Overview would
        // otherwise arrive cut and unhashable. With no phrase row, `phraseSeedOf` falls back to the Story's
        // idea, which is the documented answer rather than a placeholder.
        expect(plotlinesPhraseController.instructions.structure.seedSection({ store, story })).toEqual({
            heading: `PHRASE SEED — the text Phrase ② resolves into chapters (read-only for you, P5 one phrase down) · seed_hash=${seedHashOf(story.idea)}`,
            body:
                `${story.idea}\n\n` +
                `seed_hash=${seedHashOf(story.idea)} — \`structurePlotlines\` checks THIS text against that value and refuses any other with P5. It is ` +
                'not the Story’s Seed above, and not the top-level `seed_hash` `readSeed` prints; that read prints this one as the ' +
                'Plotlines entry of its `phrases[]`. The text is GENERAL, not an outline with unfilled boxes: the chapter set is what it ' +
                'resolves into, and a detail it leaves silent stays the Writers’ choice (P7, D-17c). Never edit it (P5).'
        });
    });
});
