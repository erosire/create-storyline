// The screening Reader's answer contract (documents/phase-1-research-pipeline.md §4.3).
//
// Same rule as `./summary-sample`: plain draft-07-compatible JSON Schema data, no library, no new
// dependency, so the LLM transport can serialise it straight into
// `response_format.json_schema.schema` and `shared/**` stays browser-safe.
//
// WHY `severity` IS AN ENUM IN THE SCHEMA: the request caps screening at `critical | high`, and
// the design's whole point (§4.3) is that the cap is enforced by the TRANSPORT, not by a prompt
// the model can forget. `critical`/`high` are the two words shared with `FINDING_COSTS` so the
// selector can rank the two counts without a mapping table (§6.5).
import type { SampledIssue } from '../types';

/** The `response_format.json_schema.name` every IssueList answer is labelled with. */
export const ISSUE_LIST_SCHEMA_NAME = 'IssueList';

/**
 * The TypeScript mirror of {@link IssueListSchema}. `SampledIssue` lives in `../types` because
 * `sample_reviews.issues` stores these rows; reusing it here keeps one wire shape, not two.
 */
export type IssueList = {
    issues: SampledIssue[];
};

/**
 * `IssueList` as draft-07-compatible JSON Schema data.
 *
 * The top-level object is strict (`additionalProperties: false`) and so is every issue. `quote`
 * and `detail` carry `minLength: 1` because D-15's evidence rule applies to a pre-finding too:
 * an issue with no verbatim excerpt is not a judgement the selector may act on. `fix_hint` is
 * optional (G-2 asks for one, but a screening pass must not fail schema validation when the
 * model declines to name a fix it is not yet sure of).
 */
export const IssueListSchema = {
    type: 'object',
    properties: {
        issues: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    severity: { type: 'string', enum: ['critical', 'high'] },
                    criterion: { type: 'string' },
                    location: { type: 'string' },
                    quote: { type: 'string', minLength: 1 },
                    detail: { type: 'string', minLength: 1 },
                    fix_hint: { type: 'string' }
                },
                required: ['severity', 'criterion', 'location', 'quote', 'detail'],
                additionalProperties: false
            }
        }
    },
    required: ['issues'],
    additionalProperties: false
} as const;
