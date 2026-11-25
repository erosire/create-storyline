// The Editor's group-LOCK decision contract (R-lock / R3, `Story.editor_group_locking`).
//
// Same rule as `./section-scores` and `./group-review`: plain draft-07-compatible JSON Schema data
// plus a TS mirror, no library, so the transport serialises it into
// `response_format.json_schema.schema` and `shared/**` stays browser-safe.
//
// WHAT THIS CONTRACT IS FOR: a locked phrase group is immutable and is the consistency law for every
// unlocked group (`server/phrase/locks.ts`). The Author may lock from the rail at any time; when the
// Story switches `editor_group_locking` ON, the Editor gets ONE more seat — per group, per CLEAN
// vector — where it reads that group's clean text, the Reader's score AND its rationale, and the
// Critic's open claims and proposals, and answers one question: is this section finished?
//
// WHY A JUDGEMENT RATHER THAN A THRESHOLD: the Author chose Editor judgment over a numeric cutoff on
// purpose. A score is an input to this decision, never the decision: `88` whose rationale points at a
// seam the Editor can quote is a section that still owes work, and `71` whose rationale names only a
// taste the Reader would personally have changed is a section that does not. So the schema carries NO
// number and no threshold field — a `score_cutoff` in here would quietly re-introduce the rule the
// design refused: the server-side reader of this contract reads the score row for its RATIONALE and
// never compares its number to anything.
//
// WHY `rationale` IS REQUIRED FOR BOTH ANSWERS: a lock freezes the text against the whole crew and
// voids the findings against it, and a `false` is the sentence the Author reads when the rail asks why
// the loop kept rewriting the section. D-15 applies unchanged: a verdict with nothing behind it is not
// a verdict. The server-side half (`server/loop/editor-lock.ts:parseGroupLockAnswer`) refuses a blank
// one, because the in-process validator ignores `minLength`.
//
// WHY ONE `group_ref` AND NOT A LIST: the seat is per group (`wi_group_lock_<cleanVectorHash>_<groupId>`),
// which is what keeps one Editor pass from spending the decision for all five sections at once, and
// what makes a lock on `premise` leave `tone`'s seat armed. An answer naming another group is refused
// rather than re-attributed — the decision was made about the text that was on screen.

/** The `response_format.json_schema.name` every group-lock answer is labelled with. */
export const GROUP_LOCK_SCHEMA_NAME = 'GroupLockDecision';

/**
 * The TypeScript mirror of {@link GroupLockDecisionSchema}.
 *
 * Nothing here is persisted as its own row: the seat's product is either a lock on the `phrase_groups`
 * row (through `phrase/locks.ts:lockPhraseGroup`, which stamps `locked_by: 'editor'`) or the absence of
 * one, and the answer itself lives in the run's retained thread. A decision therefore has no id, no
 * score and no timestamp of its own — the lock's own `locked_at` is the clock.
 */
export type GroupLockDecision = {
    /** The `phrase_groups.id` this seat was claimed for — copied from the CANDIDATE SECTION heading. */
    group_ref: string;
    /** Lock the section (true) or leave it to the loop (false). */
    lock: boolean;
    /** Non-blank either way: the claims weighed and what in the section settles each (D-15). */
    rationale: string;
};

/**
 * `GroupLockDecision` as draft-07-compatible JSON Schema data.
 *
 * Strict at the one level it has (`additionalProperties: false`), every field required, `rationale`
 * carries `minLength: 1` — the provider-side half of D-15. The rule that `lock: true` needs two things
 * to hold (no remaining issue, no major improvement) cannot be stated in JSON Schema at all, so it is
 * engine-owned prompt text (`run/phase1-prompt.ts:GROUP_LOCK_INSTRUCTION`) and it is enforced in the
 * prompt rather than in a numeric gate.
 */
export const GroupLockDecisionSchema = {
    type: 'object',
    properties: {
        // A `phrase_groups.id` UUID, copied from the CANDIDATE SECTION heading of the prompt.
        group_ref: { type: 'string', minLength: 1 },
        lock: { type: 'boolean' },
        rationale: { type: 'string', minLength: 1 }
    },
    required: ['group_ref', 'lock', 'rationale'],
    additionalProperties: false
} as const;
