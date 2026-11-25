// The Reader's section-score answer contract (documents/specifications.md, D-65).
//
// Same rule as `./group-review`: plain draft-07-compatible JSON Schema data plus a TS mirror, no
// library, so the transport serialises it into `response_format.json_schema.schema` and
// `shared/**` stays browser-safe (the dashboard renders these rows off the projection, and it may
// import the mirror to type them).
//
// WHAT THIS CONTRACT IS FOR: in the group model the installed Overview IS the state (R5), and the
// Author asked for one more read of it — after every group install, a Reader reads the complete
// Summary and gives each of the five sections a score out of 100 for internal logic, consistency
// with the other sections and plausibility. It re-arms on every revision because the job is keyed
// by the group vector hash, and the rows ACCUMULATE rather than overwrite, so the rail can show a
// section's history as well as its current number.
//
// WHY IT IS DISPLAY-ONLY (the P6 exception, stated in the decision record): P6 says the loop runs on
// pass/fail criteria, not scores. Nothing here contradicts that — a score row is never read by the
// criteria engine, the drain probe, the hill-climb, the sign-off gate or the goal math
// (`grep summary_scores src/server/loop` is empty by design). It is a progress surface the Author
// reads, in the same category as the plateau line, and the schema has no verdict field to leak one.
//
// WHY `group_ref` AND NOT AN INDEX: the answer has to be attributable to a group ROW (a UUID), the
// same way R3's review issues are. An ordinal would let a reordered catalog silently re-label an old
// score, and the parse refuses an id the Story does not have rather than storing a dangling one.

/** The `response_format.json_schema.name` every section-score answer is labelled with. */
export const SECTION_SCORES_SCHEMA_NAME = 'SectionScores';

/**
 * The TypeScript mirror of {@link SectionScoresSchema}: one entry per scored section.
 *
 * The rows persist into `summary_scores` (one row per section per run), so `SectionScore` is the
 * answer's shape and `SummaryScore` is the stored shape — the engine supplies `story_id`,
 * `phrase_id`, `vector_hash`, `group_key`, `run_ref` and `work_item_ref`, none of which the Reader
 * is asked to know.
 */
export type SectionScore = { group_ref: string; score: number; rationale: string; evidence: string };

export type SectionScores = { sections: SectionScore[] };

/**
 * `SectionScores` as draft-07-compatible JSON Schema data.
 *
 * Both levels are strict (`additionalProperties: false`), every field is required, and
 * `rationale`/`evidence` carry `minLength: 1` — D-15's rule that a judgement with nothing behind it
 * is not a judgement, here applied to a number as much as to a finding.
 *
 * `minItems`/`maxItems` and the 0–100 range are deliberately NOT spelled out here: the in-process
 * validator (`server/llm/structured.ts`) ignores keywords it does not implement, so the schema is
 * only the provider-side half of the rule. The server-side half is
 * `server/phrase/section-scores.ts:parseSectionScoreAnswer`, which refuses a non-integer score, a
 * score outside 0–100, a ref that is not one of this Story's groups, and an answer that does not
 * name each of the five groups EXACTLY once — a scoring run is complete or it fails.
 */
export const SectionScoresSchema = {
    type: 'object',
    properties: {
        sections: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    // A `phrase_groups.id` UUID, copied from the OVERVIEW section of the prompt.
                    group_ref: { type: 'string', minLength: 1 },
                    // Out of 100. `integer` is honoured by the provider schema; the parse re-checks it.
                    score: { type: 'integer' },
                    rationale: { type: 'string', minLength: 1 },
                    evidence: { type: 'string', minLength: 1 }
                },
                required: ['group_ref', 'score', 'rationale', 'evidence'],
                additionalProperties: false
            }
        }
    },
    required: ['sections'],
    additionalProperties: false
} as const;
