// The screening Critic's answer contract (documents/phase-1-research-pipeline.md §4.3).
//
// Same rule as `./summary-sample`: plain draft-07-compatible JSON Schema data, no library, no new
// dependency, so the LLM transport can serialise it straight into
// `response_format.json_schema.schema` and `shared/**` stays browser-safe.
//
// WHY `severity` IS AN ENUM IN THE SCHEMA: the request caps screening at `critical | high`, and
// the design's whole point (§4.3) is that the cap is enforced by the TRANSPORT, not by a prompt
// the model can forget. The two words map ONE-ON-ONE onto the finding ladder — screening
// `critical` is a finding at cost `critical` and screening `high` is a finding at cost `major`
// (`shared/types.ts:SampledIssue`) — so "no blocking issue" means the same thing in the screening
// answer, in the selector, and in the Author's escalation, and the selector can rank the two
// counts without a mapping table (§6.5).
import type { SampledFixVerification, SampledIssue } from '../types';

/** The `response_format.json_schema.name` every IssueList answer is labelled with. */
export const ISSUE_LIST_SCHEMA_NAME = 'IssueList';

/**
 * The TypeScript mirror of {@link IssueListSchema}. `SampledIssue` lives in `../types` because
 * `sample_reviews.issues` stores these rows; reusing it here keeps one wire shape, not two.
 *
 * H1: `fix_verifications` is the candidate-side fix audit (§6.4 step 4, R2). It sits NEXT TO
 * `issues`, not inside them, because the two answer different questions — "what is wrong with this
 * draft" and "did this draft actually do the work the Author approved" — and a screening pass that
 * reports no issues still has to say, fix by fix, whether each requested fix is in the draft. An
 * absent array reads as "this pass graded issues only" (a legacy row, or a round that was handed no
 * fixes); the selector then refuses to CLOSE a fix rather than refusing to select, so round 1 is
 * unaffected.
 */
export type IssueList = {
    issues: SampledIssue[];
    fix_verifications?: SampledFixVerification[];
};

/**
 * `IssueList` as draft-07-compatible JSON Schema data.
 *
 * The top-level object is strict (`additionalProperties: false`) and so is every issue. `quote`
 * and `detail` carry `minLength: 1` because D-15's evidence rule applies to a pre-finding too:
 * an issue with no verbatim excerpt is not a judgement the selector may act on. `fix_hint` is
 * optional (G-2 asks for one, but a screening pass must not fail schema validation when the
 * model declines to name a fix it is not yet sure of).
 *
 * HILL CLIMB: `origin` is the candidate's own statement of whether a blocking issue is NEW in this
 * draft or was ALREADY in the accepted text it replaces. It is OPTIONAL for the same transport
 * reason `fix_hint` is — a row written before the field exists, and a first-round screen with no
 * base to compare against, must both keep parsing — and an absent value FAILS CLOSED as
 * `introduced` in a round that has an accepted base (`sample-select.ts:issueIsIntroduced`), so the
 * optionality can never be read as a clean bill of health.
 */
export const IssueListSchema = {
    type: 'object',
    properties: {
        issues: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    // `critical`/`high` are the two words shared with `FINDING_COSTS`, and they map
                    // one-to-one onto the finding ladder: screening `critical` = finding `critical`,
                    // screening `high` = finding `major`.
                    severity: { type: 'string', enum: ['critical', 'high'] },
                    // Where the issue came from, relative to the accepted draft the candidate
                    // replaces. `unknown` is the Critic admitting it cannot tell, and the selector
                    // treats it exactly as `introduced`.
                    origin: { type: 'string', enum: ['introduced', 'inherited', 'unknown'] },
                    criterion: { type: 'string' },
                    location: { type: 'string' },
                    quote: { type: 'string', minLength: 1 },
                    detail: { type: 'string', minLength: 1 },
                    fix_hint: { type: 'string' }
                },
                required: ['severity', 'criterion', 'location', 'quote', 'detail'],
                additionalProperties: false
            }
        },
        // H1 (R2) — the per-fix verdicts. OPTIONAL at the top level on the same transport argument
        // `fix_hint` uses: a round with nothing to verify must not be forced to invent entries. Each
        // item is closed and requires a non-empty `evidence` line, because an unevidenced "resolved"
        // is exactly the unchecked claim this array exists to remove (D-15).
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
