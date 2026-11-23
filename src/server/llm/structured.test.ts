// Structured-output contract (§4.2): strict validation over the schemas this package ships,
// and JSON.parse-then-validate for one assistant turn.
//
// Every assertion is the EXACT repair value the caller sends back to the model, including
// the JSON path. These strings are product surface — a vague message is a wasted repair turn.
import { describe, expect, it } from 'vitest';
import { parseStructuredContent, validateStructured } from './structured';

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
