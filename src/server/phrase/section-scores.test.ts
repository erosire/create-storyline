// READER SCORING (D-65) — the seat's claim key and the validation of a `SectionScores` answer.
//
// WHAT THESE PINS HOLD:
//
//   1. the claim key (`phrase/exclusion.ts:sectionScoreClaimKey`) is the group VECTOR, so the scoring
//      pass re-arms by itself when a Writer install moves the Overview, and the hash the settled rows are
//      stamped with is read back off the key (`sectionScoreVectorHashOf`) rather than re-derived — a
//      install DURING the pass would otherwise file an old judgement under a new book;
//   2. `scoredVectorHashes` + `SECTION_SCORE_ATTEMPT_CAP` are the D-67 half of the seat's ledger: the
//      cap counts CLOSED runs on ONE vector hash, so the offer is spent only while nobody has scored
//      that book (an ANSWERED vector is never re-offered), and the rows answer the question the
//      projection asks — "has THIS Overview been judged" — which an unkeyed D-65 row cannot;
//   3. `parseSectionScoreAnswer` refuses a partial or invented answer whole, in a fixed order
//      (unknown ref → duplicate → bad number → missing text → missing sections), and the REFUSAL SENTENCE
//      is the product copy the Author reads in the held task's history — so each one is pinned verbatim,
//      not matched loosely. The one thing it does NOT police: an `evidence` quote may come from the section
//      the scored one CONTRADICTS (the cross-section rule in `run/phase1-prompt.ts:SECTION_SCORE_INSTRUCTION`),
//      and the parse keeps the neighbour's line verbatim instead of refusing a quote that is not inside the
//      scored row — D-15 says the quote is the Reader's, not the loop's to reconcile.
//
// WHY EXACT VALUES: a half-accepted answer is the failure mode this module exists for. If it stored
// three of five sections, the rail would draw a number for two sections that were never judged, and a
// score is the one thing in phase ① the loop is not allowed to act on (P6 — D-65's display-only
// exception), so an honest display is the entire job. Every expected string below was read out of the
// production template literal, and the happy-path entries are pinned as whole objects.
import { describe, expect, it } from 'vitest';
import { Store } from '../store';
import { AUTHOR_ATTR, seedStory } from '../run/mock';
import { recordUidAt } from '../store/persist';
import { ensurePhraseCatalog, phraseGroupsOf } from './catalog';
import {
    parseSectionScoreAnswer,
    scoredVectorHashes,
    SECTION_SCORE_ATTEMPT_CAP,
    SECTION_SCORE_MAX,
    SECTION_SCORE_MIN
} from './section-scores';
import { SECTION_SCORE_ITEM_PREFIX, sectionScoreClaimKey, sectionScoreVectorHashOf } from './exclusion';
import type { PhraseGroup } from '../../shared/types';

/** A Story plus its five catalog groups, with pinned ids, and every group holding text (scorable). */
function seedBook() {
    const store = Store.empty();
    const story = seedStory(store, { phase: 'summary' });
    let next = 0;
    const ensured = ensurePhraseCatalog(store, story, AUTHOR_ATTR, { newId: () => recordUidAt(next++) })!;

    for (const group of ensured.groups) {
        store.phraseGroups.update(
            group.id,
            { content: `${group.key}: the line the Author committed to.`, revision: 1 },
            { run_ref: null, author: true, why: 'seed: the group has text, so the Overview is scorable' }
        );
    }

    // The rows are re-read AFTER the writes: `ensured.groups` are the objects the catalog CREATED, whose
    // `content` is still empty, and a fixture handing those to a scorer would test an unfinished book.
    return { store, story, groups: phraseGroupsOf(store, story.id) };
}

/** The five group ids in catalog order — the set one answer must name exactly once. */

/** A complete answer over the book's groups, optionally reversed or overridden entry-by-entry. */
const answer = (groups: readonly PhraseGroup[], overrides: Partial<Record<string, unknown>> = {}) => ({
    sections: groups.map((group, index) => ({
        group_ref: group.id,
        score: 60 + index * 8,
        rationale: `${group.key} holds together as written`,
        evidence: `${group.key}: the line the Author committed to.`,
        ...overrides
    }))
});

describe('the scoring seat is keyed by the group vector (D-65)', () => {
    it('names the family prefix, builds the key from it, and reads the hash back off the key', () => {
        // One spelling, three readers (`loop/work.ts` builds it, `loop/engine.ts` settles against it,
        // `loop/status.ts` recognises a live run by it), so the pieces are pinned together.
        expect(SECTION_SCORE_ITEM_PREFIX).toBe('wi_summary_score');
        expect(sectionScoreClaimKey('cb34f094051bb701')).toBe('wi_summary_score_cb34f094051bb701');
        expect(sectionScoreVectorHashOf('wi_summary_score_cb34f094051bb701')).toBe('cb34f094051bb701');
    });

    it('re-arms on a new vector — one scoring pass per Summary revision, never one per book', () => {
        const first = sectionScoreClaimKey('a845a411fa6d617a');
        const second = sectionScoreClaimKey('5484a99d71aa9186');

        // The claim key is what `records.ts:runsForItem` counts, so two hashes are two seats: the first
        // vector's closed run does not pay for the second one.
        expect(first).not.toBe(second);
        expect([sectionScoreVectorHashOf(first), sectionScoreVectorHashOf(second)]).toEqual([
            'a845a411fa6d617a',
            '5484a99d71aa9186'
        ]);
    });

    it('leaves a key it does not own unchanged rather than guessing a hash', () => {
        // A settle on a non-scoring key must not slice a fragment of another family's claim and stamp it
        // onto a score row.
        expect(sectionScoreVectorHashOf('wi_review_groups_cb34f094051bb701_1')).toBe(
            'wi_review_groups_cb34f094051bb701_1'
        );
    });
});

describe('the scoring ledger answers "has THIS Overview been judged" (D-65, D-67)', () => {
    /**
     * Files one Reader's answer over the book — five rows, one per section, all stamped with the vector
     * hash the pass was CLAIMED under (`engine.ts:settleJob` reads that hash off the claim key). One
     * helper, because the ledger is a Set of hashes: the number of rows per vector must not matter.
     */
    const fileAnswer = (book: ReturnType<typeof seedBook>, vectorHash: string, runRef = 'run-score-1') => {
        const { store, story, groups } = book;

        for (const [index, group] of groups.entries()) {
            store.summaryScores.create(
                {
                    story_id: story.id,
                    phrase_id: group.phrase_id,
                    vector_hash: vectorHash,
                    group_id: group.id,
                    group_key: group.key,
                    score: 60 + index * 8,
                    rationale: `${group.key} holds together as written`,
                    evidence: `${group.key}: the line the Author committed to.`,
                    run_ref: runRef,
                    work_item_ref: `${SECTION_SCORE_ITEM_PREFIX}_${vectorHash}`
                },
                { run_ref: runRef, author: false, why: 'seed: a Reader answered this vector (D-65)' }
            );
        }
    };

    it('starts empty — an installed, complete book has been judged by nobody yet', () => {
        // D-67: completeness alone no longer means "scored". The seat arms on the CLEAN selection and
        // stops when this Set contains the selection's hash, so the empty answer is what owes a Reader.
        const book = seedBook();

        expect(Array.from(scoredVectorHashes(book.store, book.story.id))).toEqual([]);
    });

    it('holds the vector a pass was claimed under — once, however many sections the answer judged', () => {
        // Five rows, one hash. `loop/work.ts` candidate 2b asks `scored.has(vectorHash)`, and the cap
        // counts CLOSED runs on that key, so a Set element per row would read as five scorings.
        const book = seedBook();
        fileAnswer(book, 'a845a411fa6d617a');

        expect(Array.from(scoredVectorHashes(book.store, book.story.id))).toEqual(['a845a411fa6d617a']);
    });

    it('keeps two vectors apart — an install re-arms the seat by moving the hash, not by spending a clock', () => {
        // The D-65 re-arm idiom survives D-67 unchanged: a Writer install is a new vector, so the old
        // judgement stays true of the text it judged and the new book is offered its own Reader.
        const book = seedBook();
        fileAnswer(book, 'a845a411fa6d617a', 'run-score-1');
        fileAnswer(book, '5484a99d71aa9186', 'run-score-2');

        expect(Array.from(scoredVectorHashes(book.store, book.story.id)).sort()).toEqual([
            '5484a99d71aa9186',
            'a845a411fa6d617a'
        ]);
    });

    it('answers for one story only, and treats a row with no vector as inert', () => {
        // A pre-D-65 row carries `vector_hash: ''` (`sectionScoreVectorHashOf` answers `''` for a legacy
        // claim key). It joins nothing and scores nothing: the Set carries the empty string, and the
        // seat's read is a real 16-hex hash, so the two can never collide.
        const book = seedBook();
        fileAnswer(book, '');

        expect(Array.from(scoredVectorHashes(book.store, book.story.id))).toEqual(['']);
        expect(scoredVectorHashes(book.store, book.story.id).has('a845a411fa6d617a')).toBe(false);
        expect(Array.from(scoredVectorHashes(book.store, 'story_some_other'))).toEqual([]);
    });

    it('spends two passes on one reviewed Overview, then lets it stay unscored', () => {
        // D-67's re-arm needs a ceiling: an answered vector is never re-offered (the Set says it is
        // judged), so these two slots can only be spent by REFUSALS — one pass and one retry.
        expect(SECTION_SCORE_ATTEMPT_CAP).toBe(2);
    });
});

describe('parseSectionScoreAnswer accepts a complete answer and orders it by the catalog', () => {
    it('returns every section in CATALOG order with the Reader\'s own numbers and words', () => {
        const { store, story, groups } = seedBook();
        // The answer arrives in REVERSE catalog order: the parse takes the ORDER from the book's rows and
        // the NUMBERS from the answer, so the rail lists its sections identically on every pass while a
        // model that answered backwards still gets its own judgement attached to the right section.
        const reversed = [...groups].reverse();
        const decision = parseSectionScoreAnswer(store, story.id, answer(reversed));

        expect(decision.ok).toBe(true);
        expect(decision).toEqual({
            ok: true,
            scores: groups.map((group, index) => ({
                group,
                // 60 + 8 × the position in the ANSWER, which is the mirror of the catalog position.
                score: 60 + (groups.length - 1 - index) * 8,
                rationale: `${group.key} holds together as written`,
                evidence: `${group.key}: the line the Author committed to.`
            }))
        });
    });

    it('takes both ends of the range exactly — 0 and 100 are displayable, so they are judgements', () => {
        const { store, story, groups } = seedBook();

        expect([SECTION_SCORE_MIN, SECTION_SCORE_MAX]).toEqual([0, 100]);

        const edges = {
            sections: groups.map((group, index) => ({
                group_ref: group.id,
                score: index === 0 ? 0 : 100,
                rationale: `${group.key} judged at the end of the scale`,
                evidence: `${group.key}: the line the Author committed to.`
            }))
        };
        const decision = parseSectionScoreAnswer(store, story.id, edges);

        expect(decision.ok).toBe(true);
        expect((decision as { scores: { score: number }[] }).scores.map((entry) => entry.score)).toEqual([
            0,
            100,
            100,
            100,
            100
        ]);
    });

    it('keeps the Reader\'s text verbatim apart from trimming, never re-scaling a number', () => {
        const { store, story, groups } = seedBook();
        const padded = {
            sections: groups.map((group) => ({
                group_ref: group.id,
                score: 72,
                rationale: `  ${group.key} needs its stakes on the page  `,
                evidence: `  ${group.key}: the line the Author committed to.  `
            }))
        };
        const decision = parseSectionScoreAnswer(store, story.id, padded);

        expect(decision).toEqual({
            ok: true,
            scores: groups.map((group) => ({
                group,
                score: 72,
                rationale: `${group.key} needs its stakes on the page`,
                evidence: `${group.key}: the line the Author committed to.`
            }))
        });
    });
    it('accepts an evidence quote from the section the scored one CONTRADICTS, untouched (D-15)', () => {
        // THE SEAT'S CONTRACT, AT THE VALIDATOR'S DOOR: the score prompt lets a cross-section fault quote the
        // section it contradicts, provided the `rationale` names that other section
        // (`run/phase1-prompt.ts:SECTION_SCORE_INSTRUCTION`, pinned in `run/phase1-prompt.test.ts`). What the
        // parse must NOT do is police WHICH section the line came from: the quote is the Reader's evidence, not
        // the loop's to reconcile with the row (D-15), and a membership check would refuse the honest answer
        // and leave the reviewed vector unscored while the rail draws "not scored". So the neighbour's line and
        // the rationale that names it survive byte-for-byte.
        const { store, story, groups } = seedBook();
        const crossSection = answer(groups).sections.map((entry, index) =>
            index === 0
                ? {
                      ...entry,
                      rationale: 'premise fights the ending — it plants a map the ending then burns',
                      evidence: `${groups[4].key}: the line the Author committed to.`
                  }
                : entry
        );

        expect(parseSectionScoreAnswer(store, story.id, { sections: crossSection })).toEqual({
            ok: true,
            scores: groups.map((group, index) => ({
                group,
                // The numbers come from the ANSWER's positions, which here are the catalog's.
                score: 60 + index * 8,
                rationale:
                    index === 0
                        ? 'premise fights the ending — it plants a map the ending then burns'
                        : `${group.key} holds together as written`,
                evidence:
                    index === 0
                        ? 'ending: the line the Author committed to.'
                        : `${group.key}: the line the Author committed to.`
            }))
        });
    });
});

describe('parseSectionScoreAnswer refuses a partial or invented answer whole (D-15, D-65)', () => {
    /**
     * One refusal case: the answer the model gave, and the exact sentence the Author is shown.
     * The expectation is a FUNCTION of the fixture's group ids and keys, because the ids a Story mints
     * are addresses — a hardcoded id would pin this file to one boot and break on the next.
     */
    const refused = (build: (groups: readonly PhraseGroup[]) => unknown, refusalFor: (groups: readonly PhraseGroup[]) => string): void => {
        const { store, story, groups } = seedBook();

        expect(parseSectionScoreAnswer(store, story.id, build(groups))).toEqual({
            ok: false,
            refusal: refusalFor(groups)
        });
    };

    it('refuses an answer with no `sections` array', () => {
        refused(() => ({ scores: [] }), () => 'the SectionScores answer carried no `sections` array');
    });

    it('refuses an answer that carried nothing at all', () => {
        refused(() => undefined, () => 'the SectionScores answer carried no `sections` array');
    });

    it('refuses a ref that is not one of this Story\'s groups', () => {
        // An invented id is the invention class R3 already refuses in a review issue: a row no rail can
        // label, and since the real ids are UIDs a plausible-looking string is exactly what a model invents.
        refused(
            (groups) => ({
                sections: [{ group_ref: 'group_0', score: 70, rationale: 'invented', evidence: 'quoted' }, ...answer(groups).sections.slice(1)]
            }),
            () => `an entry named "group_0" outside this Story's groups — every section score has to say which group it scored (D-65)`
        );
    });

    it('refuses an entry with no `group_ref` at all', () => {
        refused(
            (groups) => ({
                sections: [{ score: 70, rationale: 'unattributed', evidence: 'quoted' }, ...answer(groups).sections.slice(1)]
            }),
            () => 'an entry named "(no group_ref)" outside this Story\'s groups — every section score has to say which group it scored (D-65)'
        );
    });

    it('refuses the same group scored twice', () => {
        refused(
            (groups) => {
                const sections = answer(groups).sections;

                return { sections: [sections[0], sections[0], ...sections.slice(2)] };
            },
            (groups) =>
                `premise was scored twice (${groups[0].id}) — one score per section, so a rail cannot show two answers for the same text (D-65)`
        );
    });

    it('refuses a fraction, a string, and either side of the range', () => {
        for (const bad of [72.5, 'eighty', 101, -1]) {
            refused(
                (groups) => ({
                    sections: answer(groups).sections.map((entry, index) =>
                        index === 0 ? { ...entry, score: bad } : entry
                    )
                }),
                () =>
                    `premise was scored ${JSON.stringify(bad)} — a section score must be a whole number from ${SECTION_SCORE_MIN} to ${SECTION_SCORE_MAX} (D-65)`
            );
        }
    });

    it('refuses a score with no reason and a score with no quoted line (D-15)', () => {
        refused(
            (groups) => ({
                sections: answer(groups).sections.map((entry, index) =>
                    index === 0 ? { ...entry, rationale: '   ' } : entry
                )
            }),
            () => 'premise was scored 60 with no rationale — a score has to say why and quote the line it judged (D-15, D-65)'
        );
        refused(
            (groups) => ({
                sections: answer(groups).sections.map((entry, index) =>
                    index === 2 ? { ...entry, evidence: '' } : entry
                )
            }),
            () => 'theme was scored 76 with no evidence quote — a score has to say why and quote the line it judged (D-15, D-65)'
        );
    });

    it('refuses an answer that leaves a section unscored, naming every missing one', () => {
        refused(
            (groups) => ({ sections: answer(groups).sections.slice(0, 4) }),
            () => 'the answer left ending unscored — a scoring run covers every section of the Overview or it scores nothing (D-65)'
        );
        refused(
            (groups) => ({ sections: answer(groups).sections.slice(0, 3) }),
            () => 'the answer left tone, ending unscored — a scoring run covers every section of the Overview or it scores nothing (D-65)'
        );
    });

    it('refuses the specific defect before the generic one — a bad number outranks a missing section', () => {
        // Both faults are present. The model is sent home with the concrete one, which is the difference
        // between an answer that can be repaired and a retry that invents a different complaint.
        refused(
            (groups) => {
                const sections = answer(groups).sections.map((entry, index) =>
                    index === 0 ? { ...entry, score: 140 } : entry
                );

                return { sections: sections.slice(0, 4) };
            },
            () => 'premise was scored 140 — a section score must be a whole number from 0 to 100 (D-65)'
        );
    });
});
