// Structured-output contract (§4.2): strict validation over the schemas this package ships,
// and JSON.parse-then-validate for one assistant turn.
//
// Every assertion is the EXACT repair value the caller sends back to the model, including
// the JSON path. These strings are product surface — a vague message is a wasted repair turn.
import { describe, expect, it } from 'vitest';
import { parseStructuredContent, validateStructured } from './structured';
// H1/R2 — the SHIPPED screening schema, not a stand-in: the sample selection is gated on the
// `fix_verifications` array (`loop/sample-select.ts:scoreSample`), so its shape is product surface.
import { IssueListSchema } from '../../shared/schemas';

// A SummarySample-shaped schema: closed object, two strings, one string array (§4.3).
const summarySchema: Record<string, unknown> = {
    type: 'object',
    properties: {
        premise: { type: 'string', minLength: 1 },
        theme: { type: 'string', minLength: 1 },
        knowledge_used: { type: 'array', items: { type: 'string' } }
    },
    required: ['premise', 'theme', 'knowledge_used'],
    additionalProperties: false
};

const validSummary = {
    premise: 'A city that forgets one street every night.',
    theme: 'memory',
    knowledge_used: ['fp_1', 'fp_2']
};

// An IssueList-shaped schema: an array of closed objects, an enum, and an optional field.
const issueListSchema: Record<string, unknown> = {
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
};

const issue = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    severity: 'high',
    criterion: 'promise-kept',
    location: 'chapter 3',
    quote: 'The river ran backwards.',
    detail: 'The promise said the river never reverses.',
    ...overrides
});

describe('validateStructured — accepted values', () => {
    it('passes a closed object with all required keys, preserving the value exactly', () => {
        expect(validateStructured(summarySchema, validSummary)).toEqual({ ok: true, value: validSummary });
    });

    it('passes an IssueList whose optional fix_hint is absent', () => {
        const value = { issues: [issue()] };

        expect(validateStructured(issueListSchema, value)).toEqual({ ok: true, value });
    });
});

describe('validateStructured — rejected values carry an actionable path', () => {
    it('rejects an unknown property when additionalProperties is false', () => {
        expect(validateStructured(summarySchema, { ...validSummary, chapter_count: 12 })).toEqual({
            ok: false,
            error: 'chapter_count: unexpected property (additionalProperties is false)',
            path: 'chapter_count'
        });
    });

    it('rejects a missing required property', () => {
        const { theme: _theme, ...withoutTheme } = validSummary;

        expect(validateStructured(summarySchema, withoutTheme)).toEqual({
            ok: false,
            error: 'theme: required property is missing',
            path: 'theme'
        });
    });

    it('rejects an empty string when minLength is 1', () => {
        expect(validateStructured(summarySchema, { ...validSummary, premise: '' })).toEqual({
            ok: false,
            error: 'premise: expected a string with minLength 1, received ""',
            path: 'premise'
        });
    });

    it('rejects an enum violation', () => {
        expect(validateStructured(issueListSchema, { issues: [issue({ severity: 'low' })] })).toEqual({
            ok: false,
            error: 'issues[0].severity: expected one of ["critical","high"], received "low"',
            path: 'issues[0].severity'
        });
    });

    it('names the failing path inside a nested array item (issues[2].quote)', () => {
        const value = { issues: [issue(), issue({ severity: 'critical' }), issue({ quote: '' })] };

        expect(validateStructured(issueListSchema, value)).toEqual({
            ok: false,
            error: 'issues[2].quote: expected a string with minLength 1, received ""',
            path: 'issues[2].quote'
        });
    });

    it('reports a root type failure without a path', () => {
        expect(validateStructured(summarySchema, [])).toEqual({
            ok: false,
            error: 'expected object, received array'
        });
    });

    it('validates every element of a primitive array', () => {
        expect(validateStructured(summarySchema, { ...validSummary, knowledge_used: ['fp_1', 7] })).toEqual({
            ok: false,
            error: 'knowledge_used[1]: expected string, received number',
            path: 'knowledge_used[1]'
        });
    });
});

describe('parseStructuredContent', () => {
    it('parses valid JSON and returns the validated value', () => {
        expect(parseStructuredContent(JSON.stringify(validSummary), summarySchema)).toEqual({
            ok: true,
            value: validSummary
        });
    });

    it('returns a clear repair error when the answer is not JSON', () => {
        expect(parseStructuredContent('I cannot answer that.', summarySchema)).toEqual({
            ok: false,
            error: 'assistant content is not valid JSON: "I cannot answer that."'
        });
    });

    it('parses JSON but still rejects a schema violation, keeping the path', () => {
        expect(parseStructuredContent(JSON.stringify({ ...validSummary, premise: '' }), summarySchema)).toEqual({
            ok: false,
            error: 'premise: expected a string with minLength 1, received ""',
            path: 'premise'
        });
    });

    it('reports missing content without pretending it was invalid JSON', () => {
        expect(parseStructuredContent(undefined, summarySchema)).toEqual({
            ok: false,
            error: 'assistant content is missing (the provider returned no text to parse)'
        });
        expect(parseStructuredContent('   ', summarySchema)).toEqual({
            ok: false,
            error: 'assistant content is missing (the provider returned no text to parse)'
        });
    });
});

// H1/R2 — the fix certificate, over the schema the screening Critic is actually answered against.
//
// WHY THESE CASES ARE HERE AND NOT IN A SCHEMA FILE: the selection is gated on this array
// (`loop/sample-select.ts:scoreSample`), and the gate is only as strong as the transport that
// enforces it. A verdict the model may leave unevidenced, a status it may invent, or a score it may
// attach are each a way a fix "closes" without anyone checking the draft — so the shape is product
// surface, and the strings below are the repair text that goes back to the model.
const verification = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    fix_ref: 'task_1',
    status: 'resolved',
    evidence: 'ending: she floods it, and the flood is why the map reconciles.',
    ...overrides
});

describe('IssueListSchema — the fix certificate H1/R2 gates selection on', () => {
    it('accepts a certificate beside the issues, and a bare issues answer for a round with no fixes', () => {
        const certified = { issues: [], fix_verifications: [verification()] };

        expect(validateStructured(IssueListSchema, certified)).toEqual({ ok: true, value: certified });

        // A round-1 screen is handed no fix list, and must not be forced to invent entries (the
        // optionality argument §4.3 makes for `fix_hint`).
        const bare = { issues: [] };

        expect(validateStructured(IssueListSchema, bare)).toEqual({ ok: true, value: bare });
    });

    it('refuses a verdict with no evidence line — D-15 over the wire, not in a prompt', () => {
        expect(
            validateStructured(IssueListSchema, { issues: [], fix_verifications: [verification({ evidence: '' })] })
        ).toEqual({
            ok: false,
            error: 'fix_verifications[0].evidence: expected a string with minLength 1, received ""',
            path: 'fix_verifications[0].evidence'
        });
        expect(
            validateStructured(IssueListSchema, {
                issues: [],
                fix_verifications: [{ fix_ref: 'task_1', status: 'unknown' }]
            })
        ).toEqual({
            ok: false,
            error: 'fix_verifications[0].evidence: required property is missing',
            path: 'fix_verifications[0].evidence'
        });
    });

    it('closes the status vocabulary, so an invented word cannot buy a pass', () => {
        expect(
            validateStructured(IssueListSchema, {
                issues: [],
                fix_verifications: [verification({ status: 'probably' })]
            })
        ).toEqual({
            ok: false,
            error: 'fix_verifications[0].status: expected one of ["resolved","unresolved","unknown"], received "probably"',
            path: 'fix_verifications[0].status'
        });
    });

    it('refuses a verdict that names no task, and one that smuggles a score (P6)', () => {
        expect(
            validateStructured(IssueListSchema, {
                issues: [],
                fix_verifications: [{ status: 'resolved', evidence: 'ending: she floods it.' }]
            })
        ).toEqual({
            ok: false,
            error: 'fix_verifications[0].fix_ref: required property is missing',
            path: 'fix_verifications[0].fix_ref'
        });
        // The loop ranks by counts, never by a model's number, and `additionalProperties: false` is
        // where that is decided — a prompt cannot hold a model to it.
        expect(
            validateStructured(IssueListSchema, { issues: [], fix_verifications: [verification({ score: 9 })] })
        ).toEqual({
            ok: false,
            error: 'fix_verifications[0].score: unexpected property (additionalProperties is false)',
            path: 'fix_verifications[0].score'
        });
    });

    it('keeps `issues` required, so a certificate is never the whole answer by accident', () => {
        expect(validateStructured(IssueListSchema, { fix_verifications: [verification()] })).toEqual({
            ok: false,
            error: 'issues: required property is missing',
            path: 'issues'
        });
    });
});
