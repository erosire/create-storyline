// READER SCORING — the SectionScores answer, validated (documents/specifications.md, D-65).
//
// WHAT THIS MODULE IS: the server-side half of the `score_sections` contract. The JSON Schema in
// `shared/schemas/section-scores.ts` closes the SHAPE for the provider; everything that is only
// knowable from the BOOK is decided here, because the in-process validator
// (`server/llm/structured.ts`) ignores the keywords this contract depends on (`minItems`, the 0–100
// range) — exactly the split `phrase/revisions.ts:parseGroupReviewAnswer` already draws for a review
// answer, and for the same reason: a partial or invented answer must be REFUSED, never half-stored.
//
// THE THREE REFUSALS, and why each one is a refusal rather than a repair:
//   1. a `group_ref` that is not one of this Story's groups — an attribution nothing can render or
//      close, and the same class of invention R3 refuses in a review issue;
//   2. a score that is not an integer in 0–100 — the rail draws a percentage, so `72.5`, `"eighty"`
//      or `140` is not a number the display can show honestly, and clamping it would invent a
//      judgement the Reader never made;
//   3. an answer that does not name every group EXACTLY once — a scoring run is complete or it
//      fails. A half answer would put a number on three sections and nothing on two, which reads as
//      "those two are fine" on a rail that has no way to say "nobody looked".
//
// A refusal costs the book nothing: `loop/engine.ts:settleJob` writes rows only for an `ok` answer, and
// a scoring run spends no group attempt, opens no task and pays no seat. D-68 changed what a refusal
// COSTS: the seat used to be spent by any closed run, so a provider that fumbled one answer left a
// reviewed Summary unscored until a Writer happened to rewrite the book — plumbing stranding a verdict.
// A refusal now re-arms, and `SECTION_SCORE_ATTEMPT_CAP` below is what stops a permanently broken
// provider from buying a Reader every sweep.
import type { SectionScore, SectionScores } from '../../shared/schemas';
import type { PhraseGroup } from '../../shared/types';
import type { Store } from '../store';
import { phraseGroupsOf, primaryPhraseOf } from './catalog';

/** The score's inclusive bounds — the rail renders a percentage, so nothing outside this is displayable. */
export const SECTION_SCORE_MIN = 0;
export const SECTION_SCORE_MAX = 100;

/** One validated section score, bound to the group row it belongs to (catalog order). */
export interface SectionScoreDecisionEntry {
    group: PhraseGroup;
    score: number;
    rationale: string;
    evidence: string;
}

/** A complete, attributed `SectionScores` answer — or the reason the answer was refused. */
export type SectionScoreDecision =
    | { ok: true; scores: SectionScoreDecisionEntry[] }
    | { ok: false; refusal: string };

/**
 * The vectors of this Story's Overview that a Reader has ALREADY scored (D-65/D-67).
 *
 * THE READ THE SCORING SEAT ARMS ON. A `summary_scores` row is the only evidence a judgement exists,
 * and it is stamped with the vector hash the pass was CLAIMED under (`engine.ts:settleJob` reads it off
 * the claim key, never off the rows), so "has this exact Overview been scored?" is one set membership —
 * no counter, no engine memory, and the same answer after a restart (L-3).
 *
 * It replaces the old `isScorableSummary` completeness gate as the seat's precondition (D-67): the seat
 * now arms only for the CLEAN selection (`phrase/reviewed.ts:cleanSelectionOf`), and a complete
 * selection implies five non-blank texts, because `installGroupRevisions` refuses an empty group text
 * outright. So the "never score half a Summary" intent survives through the selection, and the score
 * can no longer describe a Summary whose newest text has an open defect on it.
 *
 * WHY THE READ LIVES HERE rather than in the planner: §17.14's mechanical grep check —
 * `grep -rn "summary_scores" src/server/loop` may match only the module that WRITES the rows — and the
 * seat's arming rule has to read these rows. Putting the read in the domain that owns the answer
 * contract keeps the boundary checkable instead of eroding it.
 *
 * Two edges worth naming, because both look like bugs from the outside: a hash with rows for SOME
 * groups is in the set (the five rows land in one commit and a partial answer is refused at parse, so
 * the seat treats a half-written vector as judged rather than buying another Reader to fill a hole no
 * writer opens); and a vector that has been SCORED stays in the set even after the selection advances
 * past it, which is what makes a choose harmless to history — the chosen vector's rows keep lining up
 * with the hash the rail reports beside them.
 */
export const scoredVectorHashes = (store: Store, storyId: string): Set<string> =>
    new Set(
        store.summaryScores
            .list()
            .filter((row) => row.story_id === storyId)
            .map((row) => row.vector_hash)
    );

/**
 * How many CLOSED scoring passes one reviewed vector may spend before the seat stops offering it (D-67).
 *
 * Without a cap, D-67's re-arm rule ("a refused pass must not strand a clean vector") would make the
 * seat permanent for a provider that cannot answer the `SectionScores` schema: no rows, so the seat
 * re-arms every sweep, forever, at `rank: -1` — the highest-priority job in the phase, bought
 * infinitely. The number is the group pipeline's own (`GROUP_WRITE_ATTEMPT_CAP` is 2 for the same
 * reason), and the escalation is the same shape: the vector simply stays unscored, which D-65 says
 * costs nothing, because the score gates nothing and the rail draws "not scored", never a zero.
 *
 * What the cap COUNTS is the part a reader will check: `loop/work.ts` candidate 2b skips a vector that
 * already has score rows, so an ANSWERED pass is never offered again and the two slots can only be
 * spent by refusals — one pass and one retry of the same reviewed text.
 */
export const SECTION_SCORE_ATTEMPT_CAP = 2;

/** Whether one answered number is an integer the rail can render. */
const isScoreValue = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= SECTION_SCORE_MIN && value <= SECTION_SCORE_MAX;

/**
 * Validates a `SectionScores` answer against the book (D-65).
 *
 * Returns the entries in CATALOG ORDER, taken from the Story's own group rows rather than from the
 * answer's order — the same rule `installGroupRevisions` follows, so two identical answers journal
 * identical rows, and a model that answered backwards cannot make the rail list its sections in a
 * different order on the next pass.
 *
 * The answer's text is kept VERBATIM (D-15: the rationale and the quote are the Reader's, not the
 * loop's to tidy). Nothing here recomputes, averages or re-ranks a score.
 */
export function parseSectionScoreAnswer(
    store: Store,
    storyId: string,
    structured: unknown,
    phraseId?: string
): SectionScoreDecision {
    const answer = structured as SectionScores | undefined;
    const sections = Array.isArray(answer?.sections) ? answer.sections : undefined;

    if (sections === undefined) return { ok: false, refusal: 'the SectionScores answer carried no `sections` array' };

    // The PHRASE's sections, in composition order — the set the job was dispatched with, and the only set
    // an answer may name (seam S12: "name every section exactly once" is phrase arity, five for the
    // Summary and the materialized chapter count for Phrase ②, so the number comes from the rows and not
    // from a constant). `section_score` rows are addressed by group UUID, so an id from another book — or
    // from the other phrase on this one — would be a row the rail can never label.
    const groups = phraseGroupsOf(store, storyId, phraseId ?? primaryPhraseOf(store, storyId)?.id);
    const byId = new Map(groups.map((group) => [group.id, group]));
    const seen = new Map<string, SectionScore>();

    for (const section of sections as SectionScore[]) {
        const ref = typeof section?.group_ref === 'string' ? section.group_ref : '';
        const group = byId.get(ref);

        if (group === undefined) {
            return {
                ok: false,
                refusal: `an entry named "${ref === '' ? '(no group_ref)' : ref}" outside this Story's groups — every section score has to say which group it scored (D-65)`
            };
        }

        if (seen.has(ref)) {
            return {
                ok: false,
                refusal: `${group.key} was scored twice (${ref}) — one score per section, so a rail cannot show two answers for the same text (D-65)`
            };
        }

        // The range/integer check runs BEFORE the text checks: a bad number is the failure the Author
        // would notice first, and refusing on it keeps a nonsense score out of the row entirely.
        if (!isScoreValue(section.score)) {
            return {
                ok: false,
                refusal: `${group.key} was scored ${JSON.stringify(section?.score)} — a section score must be a whole number from ${SECTION_SCORE_MIN} to ${SECTION_SCORE_MAX} (D-65)`
            };
        }

        // D-15, applied to a number: a score with no reason and no quoted line is not a judgement, and
        // the schema's `minLength` is not enforced by the in-process validator, so this is the only
        // place the rule exists.
        const rationale = typeof section.rationale === 'string' ? section.rationale.trim() : '';
        const evidence = typeof section.evidence === 'string' ? section.evidence.trim() : '';

        if (rationale === '' || evidence === '') {
            return {
                ok: false,
                refusal: `${group.key} was scored ${section.score} with no ${rationale === '' ? 'rationale' : 'evidence quote'} — a score has to say why and quote the line it judged (D-15, D-65)`
            };
        }

        seen.set(ref, { group_ref: ref, score: section.score, rationale, evidence });
    }

    // Completeness: every group exactly once. The order of the check (unknown refs and bad numbers
    // refused first) is deliberate — it sends the model home with the specific defect rather than a
    // generic "you left sections out" when a section was also malformed.
    const missing = groups.filter((group) => !seen.has(group.id));

    if (missing.length > 0) {
        return {
            ok: false,
            refusal: `the answer left ${missing.map((group) => group.key).join(', ')} unscored — a scoring run covers every section of the Overview or it scores nothing (D-65)`
        };
    }

    return {
        ok: true,
        scores: groups.map((group) => {
            const entry = seen.get(group.id)!;

            return { group, score: entry.score, rationale: entry.rationale, evidence: entry.evidence };
        })
    };
}
