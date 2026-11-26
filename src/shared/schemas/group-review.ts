// The group review's answer contract (Summary Phrase redesign, R3/R5).
//
// Same rule as `./issue-list`: plain draft-07-compatible JSON Schema data plus a TS mirror, no
// library, so the transport serialises it into `response_format.json_schema.schema` and
// `shared/**` stays browser-safe.
//
// WHAT THIS CONTRACT IS FOR: in the group model an accepted Writer result is installed
// IMMEDIATELY (R5) — there is no competing round and no selection to rank — so the structured
// Critic pass that used to screen candidates before a winner was chosen now reads the INSTALLED
// text instead, and its job changes from "rank these drafts" to "name what is wrong with this
// Overview, group by group, and say fix by fix whether the approved work is in it".
//
// WHY IT IS NOT SIMPLY `IssueList` REUSED: R3's closure rule needs attribution the legacy answer
// cannot carry. A finding is closed when EVERY group it names has a revision that resolves it, and
// that is only decidable if the Critic's complaint says which groups it is about. An answer whose
// issues named no group would put a defect in the book with nothing for the loop to target, which
// is how the redesign would end up rewriting all five groups forever (R2's whole point lost).
//
// SEVERITY KEEPS THE TWO LEGACY WORDS (`critical` | `high`) ON PURPOSE: they map one-to-one onto
// the finding ladder (screening `critical` = finding `critical`, `high` = `major`), and every
// existing predicate that says "blocking" in `server/loop/records.ts` reads exactly that pair. A
// third word would split one rule across two vocabularies for no gain.
import type { SampledFixVerification, SampledIssue } from '../types';

/** The `response_format.json_schema.name` every GroupReview answer is labelled with. */
export const GROUP_REVIEW_SCHEMA_NAME = 'GroupReview';

/**
 * One extra group's evidence for a multi-group complaint. `quote`/`location` are per group because
 * the answer's primary `quote` can only prove ONE group was read; naming three groups while quoting
 * one was the impossibility this field removes. `group_ref` must be one of the issue's `group_refs`.
 */
export type GroupReviewQuote = { group_ref: string; quote: string; location?: string };

/**
 * One group review's complaint: a {@link SampledIssue} PLUS the groups it is about.
 *
 * `group_refs` holds `phrase_groups.id` values (the same UUIDs the job was dispatched with), not
 * catalog keys — the engine validates them against the story's groups before persisting, so a
 * Critic that invents an id is a refusal rather than a dangling attribution.
 *
 * `group_quotes` is the per-group evidence for a cross-group defect: the primary `quote` is the
 * group named in `location`, and every OTHER group named in `group_refs` needs one entry here. It
 * is optional on the wire for back-compat (a legacy row or a single-group issue has none), but the
 * prompts require it for every additional group a new answer names.
 */
export type GroupReviewIssue = SampledIssue & {
    group_refs: string[];
    group_quotes?: GroupReviewQuote[];
};

/**
 * The TypeScript mirror of {@link GroupReviewSchema}.
 *
 * The issue rows persist into `sample_reviews.issues` (the existing collection), so the row shape
 * stays ONE wire shape: `SampledIssue` gained an optional `group_refs` and a legacy row simply
 * carries none. `fix_verifications` keeps the legacy field and its meaning verbatim — per-fix
 * verdicts with a quoted evidence line — because a group revision's claim to have answered an
 * approved fix is graded the same way a candidate's was (silence is not a pass).
 */
export type GroupReview = {
    issues: GroupReviewIssue[];
    fix_verifications?: SampledFixVerification[];
};

/**
 * `GroupReview` as draft-07-compatible JSON Schema data.
 *
 * The top level and every issue are strict (`additionalProperties: false`), `quote`/`detail` carry
 * `minLength: 1` (D-15: an unevidenced complaint is not a judgement the loop may act on), and
 * `group_refs` is REQUIRED with `minItems: 1` — a defect that crosses the whole Overview names
 * every group it crosses. `group_quotes` is the per-group evidence for the OTHER named groups: a
 * single `quote` can only prove the group in `location`, so the old "quote every group you name"
 * rule was unsatisfiable without this array. It is optional for legacy rows and single-group
 * issues; the prompts require it for every additional group a new answer names.
 *
 * `minItems` is the provider-side half of the rule only: the in-process validator
 * (`server/llm/structured.ts`) ignores keywords it does not implement, so an empty `group_refs`
 * array passes THIS schema and is refused after validation by
 * `server/phrase/revisions.ts:parseGroupReviewAnswer`, which also refuses a ref that is not one of
 * the story's groups (an invented id is a refusal, not a dangling attribution).
 *
 * `origin` is deliberately NOT in this schema. It is the hill-climb's introduced-vs-inherited
 * distinction between a CANDIDATE and the accepted draft it replaces, and in the group model the
 * answer is installed rather than compared, so there is no candidate to grade and a field with no
 * reader would be a false affordance.
 */
export const GroupReviewSchema = {
    type: 'object',
    properties: {
        issues: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    // The two words shared with `FINDING_COSTS`, mapped one-to-one onto the ladder.
                    severity: { type: 'string', enum: ['critical', 'high'] },
                    // 'C-14', 'C-15', or 'seed' for a Seed-contract breach.
                    criterion: { type: 'string' },
                    location: { type: 'string' },
                    quote: { type: 'string', minLength: 1 },
                    detail: { type: 'string', minLength: 1 },
                    fix_hint: { type: 'string' },
                    // R3 — the groups this complaint is about. Required, and never empty.
                    group_refs: {
                        type: 'array',
                        minItems: 1,
                        items: { type: 'string', minLength: 1 }
                    },
                    // R3/D-15 — the per-group evidence for a cross-group defect. The primary
                    // `quote` proves `location`; this array proves every OTHER group the issue
                    // names, so "name three groups, quote one" is no longer the only legal answer.
                    group_quotes: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                group_ref: { type: 'string', minLength: 1 },
                                quote: { type: 'string', minLength: 1 },
                                location: { type: 'string' }
                            },
                            required: ['group_ref', 'quote'],
                            additionalProperties: false
                        }
                    }
                },
                required: ['severity', 'criterion', 'location', 'quote', 'detail', 'group_refs'],
                additionalProperties: false
            }
        },
        // OPTIONAL at the top level for the legacy reason `IssueListSchema` states: a pass with
        // nothing to verify must not be forced to invent entries. Each item still requires a
        // non-empty `evidence` line (D-15).
        fix_verifications: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    fix_ref: { type: 'string', minLength: 1 },
                    status: { type: 'string', enum: ['resolved', 'unresolved', 'unknown'] },
                    evidence: { type: 'string', minLength: 1 },
                    note: { type: 'string' }
                },
                required: ['fix_ref', 'status', 'evidence'],
                additionalProperties: false
            }
        }
    },
    required: ['issues'],
    additionalProperties: false
} as const;
