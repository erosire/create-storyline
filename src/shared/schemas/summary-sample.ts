// The sampling Writer's answer contract (documents/phase-1-research-pipeline.md §4.3).
//
// WHY PLAIN JSON SCHEMA AND NOT TYPEBOX: the brief for this wave forbids new npm dependencies,
// and the LLM transport only needs `Record<string, unknown>` data that it can serialise into
// `response_format.json_schema` (§4.2). A plain literal is that data with zero runtime cost, and
// it keeps `shared/**` browser-safe (no library import, no builder call at module load).
//
// WHY `additionalProperties: false` AND `minLength: 1` EVERYWHERE: the schema is the enforcement
// mechanism, not a prompt a model can forget (T-11's lesson). A missing or empty field must fail
// VALIDATION and trigger the schema-repair retry, because the engine installs this answer into the
// Summary verbatim — there is no tool call in which a second chance to fill a field could happen.

/** The `response_format.json_schema.name` every SummarySample answer is labelled with. */
export const SUMMARY_SAMPLE_SCHEMA_NAME = 'SummarySample';

/**
 * The TypeScript mirror of {@link SummarySampleSchema}. `chapter_count` is deliberately absent:
 * it is Author truth (D-3b) and the engine writes it once, never the Writer.
 */
export type SummarySample = {
    premise: string;
    promise: string;
    theme: string;
    tone: string;
    ending: string;
    world_rules: string;
    /** Knowledge entry fingerprints the draft leaned on, for the audit and the next prompt. */
    knowledge_used: string[];
};

/**
 * `SummarySample` as draft-07-compatible JSON Schema data. Serialised directly into the chat
 * completion request's `response_format.json_schema.schema` (§4.2).
 *
 * `knowledge_used` is required but MAY be empty: a draft is allowed to lean on no stored entry
 * (round 1 of a Story whose Researcher found nothing yet), and forcing a fingerprint would make
 * the model invent one. Every other field is a non-empty string because each one is a Summary
 * prose field the pipeline later checks the whole chain against.
 */
export const SummarySampleSchema = {
    type: 'object',
    properties: {
        premise: { type: 'string', minLength: 1 },
        promise: { type: 'string', minLength: 1 },
        theme: { type: 'string', minLength: 1 },
        tone: { type: 'string', minLength: 1 },
        ending: { type: 'string', minLength: 1 },
        world_rules: { type: 'string', minLength: 1 },
        knowledge_used: { type: 'array', items: { type: 'string' } }
    },
    required: ['premise', 'promise', 'theme', 'tone', 'ending', 'world_rules', 'knowledge_used'],
    additionalProperties: false
} as const;
