// The `SectionScores` answer contract (D-65) — the bytes the provider is handed, and the split of
// responsibility between the two halves of the rule.
//
// WHY THIS FILE EXISTS WHEN THE PARSE IS ALREADY TESTED: `server/phrase/section-scores.test.ts` proves
// what the SERVER accepts. This file pins what the MODEL is asked for, which is a different surface —
// the schema object is serialised into `response_format.json_schema.schema` by `run/executor.ts` and is
// the only instruction a remote provider honours. If it loosens, a model starts answering with an
// invented extra field or a missing rationale and the server-side parse is the thing that has to catch
// it, at the cost of a wasted run.
//
// THE DELIBERATE ABSENCES ARE PART OF THE CONTRACT, so they are pinned as data: the in-process validator
// (`server/llm/structured.ts`) ignores `minItems`/`maxItems` and numeric ranges, so spelling them here
// would read as "this contract enforces five sections between 0 and 100" while nothing enforces it. The
// enforcing half is the parse; this half is the request.
import { describe, expect, it } from 'vitest';
import {
    SECTION_SCORES_SCHEMA_NAME,
    SectionScoresSchema,
    type SectionScore,
    type SectionScores
} from './section-scores';

describe('the SectionScores answer contract (D-65)', () => {
    it('names the answer schema the transport and both crew mocks branch on', () => {
        // `run/phase1-prompt.ts` compiles the seat with this name, `loop/engine.ts` and
        // `loop/mock.ts`/`integration/harness.ts` recognise the turn by it — one string, four readers.
        expect(SECTION_SCORES_SCHEMA_NAME).toBe('SectionScores');
    });

    it('closes both levels of the answer: every field required, no field invented', () => {
        expect(SectionScoresSchema).toEqual({
            type: 'object',
            properties: {
                sections: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            // A `phrase_groups.id` UUID, copied from the OVERVIEW block of the prompt.
                            group_ref: { type: 'string', minLength: 1 },
                            // Out of 100. `integer` is honoured by the provider; the parse re-checks it.
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
        });
    });

    it('spells the count and the range nowhere, because the in-process validator would ignore them', () => {
        // Pinning the absence is how the next reader learns the split rather than guessing it: five
        // sections and 0–100 are enforced in `server/phrase/section-scores.ts`, not here.
        const serialized = JSON.stringify(SectionScoresSchema);

        for (const keyword of ['minItems', 'maxItems', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'])
            expect(serialized.includes(keyword)).toBe(false);
    });

    it('gives the TS mirror the same four fields the schema requires — no verdict field to leak one', () => {
        // D-65 is display-only (P6's exception): the answer carries no pass/fail, no recommendation and
        // no weight, precisely so the criteria engine can never be handed a number by accident. The mirror
        // is the type the engine reads, so its key list is the contract's key list.
        const answer: SectionScores = {
            sections: [
                {
                    group_ref: '00000000-0000-4000-8000-000000000001',
                    score: 72,
                    rationale: 'the promise is the one the premise grounds',
                    evidence: 'promise: the map and the territory reconcile.'
                } satisfies SectionScore
            ]
        };

        expect(Object.keys(answer)).toEqual(['sections']);
        expect(Object.keys(answer.sections[0])).toEqual(['group_ref', 'score', 'rationale', 'evidence']);
        expect(SectionScoresSchema.properties.sections.items.required).toEqual([
            'group_ref',
            'score',
            'rationale',
            'evidence'
        ]);
    });
});
