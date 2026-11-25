// The Plotlines Phrase Writer's answer contract (Phrase ② — chapters as phrase entries).
//
// Same rule as `./group-draft`, `./group-review` and `./summary-sample`: plain draft-07-compatible
// JSON Schema data plus a TS mirror, no library, no new dependency, so the LLM transport can serialise
// the schema straight into `response_format.json_schema.schema` and `shared/**` stays browser-safe.
//
// WHY A DIFFERENT CONTRACT INSTEAD OF REUSING `GroupDraft`: a Summary group's answer IS its text —
// one prose string per group. A CHAPTER entry's answer is a set of PLOTPOINTS, because the entry is
// the chapter's contract, not the chapter's prose: what must happen, what must be different
// afterwards, whose eyes it is told through, and the setups and payoffs it carries. Those are the
// exact fields §4.3's `Plotline` record already holds and the §8.1 `createPlotline` tool already
// takes, so the answer maps onto the contract with no translation and the `plotlines` mirror stays
// lossless (`server/phrase/revisions.ts`'s plotlines branch).
//
// WHY `order` IS NOT AN ANSWER FIELD: the chapter number is the ENTRY (`chapter_3`), which the job
// named by id. A Writer that also answered an order could disagree with the entry it was asked about,
// and the loop would have to choose — the same reason `GroupDraft` has no `group_key` and
// `SummarySample` has no `chapter_count`.

/** The `response_format.json_schema.name` every ChapterDraft answer is labelled with. */
export const CHAPTER_DRAFT_SCHEMA_NAME = 'ChapterDraft';

/**
 * The TypeScript mirror of {@link ChapterDraftSchema}.
 *
 * `groups[].group_ref` is a `phrase_groups.id` on the Plotlines phrase (a persisted UUID), copied from
 * the job's `WorkItem.groupRefs` — never a key like `chapter_3`, for the same reason
 * {@link GroupDraft} states: the id is what the engine writes against and what a finding and a run row
 * also name.
 *
 * The five plotpoint fields mirror `Plotline`'s prose fields one-for-one
 * (`must_happen`/`must_change`/`pov`/`setups`/`payoffs`, plus `heading`), so installing an answer IS
 * updating that chapter's contract, and `createPlotline`'s required set survives minus the two
 * tool-only arguments (`order` comes from the entry, `why`/`expects` are tool plumbing).
 */
export type ChapterDraft = {
    groups: Array<{
        group_ref: string;
        /** The chapter's short name. Optional because §4.3's `Plotline.heading` is optional. */
        heading?: string;
        /** The events the chapter has to deliver (C-7). */
        must_happen: string;
        /** What is different at the end: state, knowledge, relationship, position (C-8/C-3). */
        must_change: string;
        /** Whose eyes the chapter is told through. */
        pov?: string;
        /** Seeds this chapter plants. */
        setups?: string;
        /** Debts this chapter pays off (C-5/C-6 check these mechanically). */
        payoffs?: string;
    }>;
    /** Knowledge entry fingerprints the draft leaned on, for the audit and the next prompt. */
    knowledge_used: string[];
};

/**
 * `ChapterDraft` as draft-07-compatible JSON Schema data.
 *
 * `minItems: 1` on `groups` and `minLength: 1` on the two required plotpoints: both are PROVIDER-side
 * hints only — the in-process validator (`server/llm/structured.ts`) ignores keywords it does not
 * implement — so the load-bearing checks (the phrase's exact arity, the non-empty plotpoints, and the
 * entry key belonging to the Plotlines phrase) live in
 * `server/phrase/plotpoints.ts:parseChapterDraftAnswer`, which refuses the whole answer
 * atomically (`phrase/controllers/plotlines.ts` is the caller that routes a `draft_entries` job to it —
 * it does not own the parser, and this pointer used to name it by mistake). The arity rule is PHRASE-SCOPED (seam S12): a Summary draft must answer the five
 * Summary groups and a chapter draft must answer the materialized chapter set, and neither number is
 * hard-coded here because neither is knowable from a schema.
 */
export const ChapterDraftSchema = {
    type: 'object',
    properties: {
        groups: {
            type: 'array',
            minItems: 1,
            items: {
                type: 'object',
                properties: {
                    group_ref: { type: 'string', minLength: 1 },
                    heading: { type: 'string', minLength: 1 },
                    must_happen: { type: 'string', minLength: 1 },
                    must_change: { type: 'string', minLength: 1 },
                    pov: { type: 'string' },
                    setups: { type: 'string' },
                    payoffs: { type: 'string' }
                },
                required: ['group_ref', 'must_happen', 'must_change'],
                additionalProperties: false
            }
        },
        // Required but MAY be empty, exactly as in `GroupDraftSchema`: a draft is allowed to lean on no
        // stored entry, and forcing a fingerprint would make the model invent one.
        knowledge_used: { type: 'array', items: { type: 'string' } }
    },
    required: ['groups', 'knowledge_used'],
    additionalProperties: false
} as const;
