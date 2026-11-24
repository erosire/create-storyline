// The group Writer's answer contract (Summary Phrase redesign, R1/R2/R5).
//
// Same rule as `./summary-sample` and `./issue-list`: plain draft-07-compatible JSON Schema data
// plus a TS mirror, no library, no new dependency, so the LLM transport can serialise the schema
// straight into `response_format.json_schema.schema` and `shared/**` stays browser-safe.
//
// WHY A DIFFERENT CONTRACT INSTEAD OF REUSING `SummarySample`: `SummarySample` writes all six
// legacy prose fields in one answer, which is exactly the thing the redesign removes — a Writer
// asked to rewrite a Theme also rewrites Premise, Promise, Tone and Ending, and four unasked
// rewrites are four unasked regressions (R2). This contract answers ONLY for the groups the job
// named, by their PERSISTED ids, so the engine can refuse an answer that writes a group it was not
// asked for (or skips one it was) atomically, before a single row moves.
//
// WHY `additionalProperties: false` AND `minLength: 1` ON `content`: the schema is the enforcement
// mechanism, not a prompt a model can forget (T-11's lesson). The engine installs this answer as
// the group's latest text verbatim — there is no later tool call in which a second chance to fill a
// field could happen — so an empty or extra field must fail VALIDATION and trigger the schema-repair
// retry rather than land as an empty group.

/** The `response_format.json_schema.name` every GroupDraft answer is labelled with. */
export const GROUP_DRAFT_SCHEMA_NAME = 'GroupDraft';

/**
 * The TypeScript mirror of {@link GroupDraftSchema}.
 *
 * `groups[].group_ref` is a `phrase_groups.id` (a persisted UUID, R1) copied from the job's
 * `WorkItem.groupRefs` — never a catalog key like `premise`, because the id is what the engine
 * writes against and what a finding and a run row also name. The engine maps id → group before
 * validating, so a key-shaped answer is a REFUSAL (unknown group), not a lenient lookup.
 *
 * `chapter_count` is absent for the same reason it is absent from `SummarySample`: it is Author
 * truth (D-3b) and the engine writes it once, never the Writer.
 */
export type GroupDraft = {
    groups: Array<{ group_ref: string; content: string }>;
    /** Knowledge entry fingerprints the draft leaned on, for the audit and the next prompt. */
    knowledge_used: string[];
};

/**
 * `GroupDraft` as draft-07-compatible JSON Schema data.
 *
 * `minItems: 1` on `groups`: a Writer dispatched for at least one group must answer for at least
 * one. Two honest caveats, both load-bearing:
 *   - the in-process validator (`server/llm/structured.ts`) ignores keywords it does not implement,
 *     so `minItems` is a PROVIDER-side hint here, not the enforcement;
 *   - the EXACT-SET rule (every named group answered, no extra group answered, no duplicate) is a
 *     job-scoped fact the schema cannot state anyway — it does not know the job.
 * Both are enforced after validation by `server/phrase/revisions.ts:parseGroupDraftAnswer`, which
 * refuses the whole answer atomically (R2: one bad group must not install a partial batch and
 * revise three groups while the fourth silently keeps its text).
 */
export const GroupDraftSchema = {
    type: 'object',
    properties: {
        groups: {
            type: 'array',
            minItems: 1,
            items: {
                type: 'object',
                properties: {
                    group_ref: { type: 'string', minLength: 1 },
                    content: { type: 'string', minLength: 1 }
                },
                required: ['group_ref', 'content'],
                additionalProperties: false
            }
        },
        // Required but MAY be empty, exactly as in `SummarySampleSchema`: a draft is allowed to lean
        // on no stored entry, and forcing a fingerprint would make the model invent one.
        knowledge_used: { type: 'array', items: { type: 'string' } }
    },
    required: ['groups', 'knowledge_used'],
    additionalProperties: false
} as const;
