/**
 * The §8 arg schemas, the T-11 validator, and the `describeTool` payload.
 *
 * T-11 puts schema enforcement in the tool, not the prompt: "a fresh context can be tired of"
 * a prompt. So every §8 row is transcribed here as a JSON schema, and a malformed call is
 * refused naming the field and the expected shape — including the required `cost` enum on
 * `raiseFinding` and the required `evidence` on a failing criterion (D-15).
 */
import type { PermissionLevel, ToolDefinition } from './types';

/** A property schema, JSON-Schema shaped so the model sees the OpenAI wire form. */
export type PropertySchema = Record<string, unknown>;

/** Builds a string property. */
export function str(description: string): PropertySchema {
    return { type: 'string', description };
}

/** Builds an integer property. */
export function num(description: string): PropertySchema {
    return { type: 'number', description };
}

/** Builds a boolean property. */
export function bool(description: string): PropertySchema {
    return { type: 'boolean', description };
}

/** Builds an object property with nested properties and required keys. */
export function obj(
    description: string,
    properties: Record<string, PropertySchema>,
    required?: string[]
): PropertySchema {
    return { type: 'object', description, properties, ...(required ? { required } : {}) };
}

/** Builds an array property over one item schema. */
export function arr(description: string, items: PropertySchema): PropertySchema {
    return { type: 'array', description, items };
}

/** Builds an enum property — the shape T-11 demands for `cost`, `decision`, `verdict`…. */
export function enumOf(values: readonly string[], description: string): PropertySchema {
    return { type: 'string', enum: [...values], description };
}

/**
 * T-4's `expects`: the id and rev the agent read. Optional in the schema because §8 lists it
 * only on the read-modify-write tools; when a tool declares `expectsArg`, the pipeline refuses
 * a missing one naming T-4 (the schema alone cannot say "required for this tool only").
 */
export const EXPECTS_ARG: PropertySchema = arr(
    'T-4 compare-and-swap: the id and rev you read. A stale value rejects the write and returns the current record.',
    obj(
        'One guard entry.',
        {
            id: str('The record id, as read.'),
            rev: num('The record rev, as read.')
        },
        ['id', 'rev']
    )
);

/** T-5's `why`, the one-line reason every write records (P11). */
export function whyArg(description = 'One-line reason for this write; it goes into the audit trail.'): PropertySchema {
    return str(description);
}

/** `phase` for the Idea reads and writes (§4.1's three phases). */
export const PHASE_ENUM = enumOf(['summary', 'plotlines', 'chapters'], 'Which phase the record belongs to.');

/** §4.10's cost dial values — the same list drives auto-approve and the drain threshold. */
export const COST_ENUM = enumOf(
    ['critical', 'major', 'minor', 'taste'],
    'How much the repair costs (D-35b triage scale).'
);

/** §4.17's Idea kinds. */
export const IDEA_KIND_ENUM = enumOf(['direction', 'possibility', 'fact', 'warning'], 'What kind of Idea this is.');

/** §4.17's Idea states, for the list/read filters. */
export const IDEA_STATE_ENUM = enumOf(
    ['proposed', 'verified', 'refuted', 'unverifiable', 'selected', 'discarded', 'deferred'],
    'The Idea lifecycle state.'
);

/** §4.10's finding states, for the read filters. */
export const FINDING_STATE_ENUM = enumOf(
    ['unconfirmed', 'confirmed', 'approved', 'fixed', 'disputed', 'discarded'],
    'The finding chain state (D-33).'
);

/** §4.7's task states. */
export const TASK_STATE_ENUM = enumOf(['open', 'claimed', 'blocked', 'done', 'wontfix'], 'The queue state.');

/** §4.16 §6's verdict recommendations. */
export const RECOMMENDATION_ENUM = enumOf(
    ['advance', 'fix', 'stuck'],
    '`stuck` means the reviewer thinks the Story should go `pending`.'
);

/** §4.12 `roles[].kind` — the four dispatched kinds. */
export const ROLE_KIND_ENUM = enumOf(
    ['writer', 'editor', 'checker', 'reader'],
    'The role kind that should do the work.'
);

/** §4.15's unit kinds — what a competing draft can be about. */
export const UNIT_KIND_ENUM = enumOf(['summary', 'plotline', 'chapter'], 'The unit a draft belongs to.');

/** §4.6's ledger classes. */
export const LEDGER_KIND_ENUM = enumOf(
    ['setup', 'payoff', 'fact', 'timeline', 'world_rule'],
    'The kind of continuity fact.'
);

/** §4.6's ledger standings. */
export const LEDGER_STATUS_ENUM = enumOf(
    ['open', 'paid', 'conflict', 'stale'],
    "The fact's standing (a conflict blocks completion)."
);

/** A ref property, with the collections it may name spelled out for the model. */
export function refArg(description: string, kinds: readonly string[]): PropertySchema {
    return str(`${description} (${kinds.join(' | ')} — an id, an order number, or a title).`);
}

/** T-7's pagination pair, for the reads that can come back long. */
export const PAGE_ARGS: Record<string, PropertySchema> = {
    limit: num(`Maximum items to return (default is tool-specific, max 200).`),
    offset: num('Index of the first item to return (default 0).')
};

/** Collects every enum in a tool's schema, for `describeTool`'s answer (T-6c). */
export function collectEnums(parameters: Record<string, unknown>): Record<string, string[]> {
    const enums: Record<string, string[]> = {};
    const properties = (parameters.properties ?? {}) as Record<string, PropertySchema>;
    for (const [name, schema] of Object.entries(properties)) {
        if (Array.isArray(schema.enum)) enums[name] = (schema.enum as string[]).slice();
        // A nested object's enums are collected too: `criteria_passed[].result` has none, but a
        // future item schema should not be silently dropped.
        const nested = schema.properties as Record<string, PropertySchema> | undefined;
        if (nested) {
            for (const [child, childSchema] of Object.entries(nested)) {
                if (Array.isArray(childSchema.enum))
                    enums[`${name}[].${child}`] = (childSchema.enum as string[]).slice();
            }
        }
    }
    return enums;
}

/** The §8 arg table for one tool, rendered for `describeTool` (T-6c: "the exact shape"). */
export function describeToolPayload(def: ToolDefinition & { level?: PermissionLevel }): Record<string, unknown> {
    const parameters = def.inputSchema;
    const properties = (parameters.properties ?? {}) as Record<string, PropertySchema>;
    return {
        name: def.name,
        description: def.description,
        required: [...((parameters.required as string[] | undefined) ?? [])],
        // The field-by-field table the model reads instead of guessing (T-11).
        fields: Object.entries(properties).map(([name, schema]) => ({
            name,
            type: String(schema.type ?? 'unknown'),
            ...(schema.enum ? { enum: schema.enum } : {}),
            required: ((parameters.required as string[] | undefined) ?? []).includes(name),
            description: String(schema.description ?? '')
        })),
        enums: collectEnums(parameters),
        // T-4: what `expects` must carry, spelled out rather than guessed.
        expects: def.expectsArg
            ? {
                  required: true,
                  shape: '[{id, rev}]',
                  note: 'the id and rev you read; a stale value rejects the write and returns the current record'
              }
            : {
                  required: false,
                  shape: '[{id, rev}]',
                  note: 'this tool creates records, so it does not read-modify-write one'
              },
        why: def.mutating
            ? {
                  required: def.whyOptional !== true,
                  field: def.whyField ?? 'why',
                  note: 'T-5: every write records its reason'
              }
            : { required: false, note: 'a read writes nothing' },
        permission: {
            writes: def.writes,
            level: def.level,
            ...(def.kinds ? { extra_kinds: def.kinds } : {})
        }
    };
}

/** One validation error, in the shape the refusal message renders (T-11). */
interface ValidationError {
    field: string;
    expected: string;
    received?: unknown;
}

/**
 * Validates an argument object against the tool's schema BEFORE the permission row runs, so a
 * malformed call is never mistaken for a permission problem (T-11).
 *
 * Checks, in order: required fields, declared types, enum membership, unknown-field typos, and
 * an empty-after-trim required string. Deliberately does not repair values: an agent that sent
 * `cost: "Critical"` must be told the exact value set rather than silently accepted.
 */
export function validateArgs(def: ToolDefinition, args: Record<string, unknown>): ValidationError[] {
    const errors: ValidationError[] = [];
    const parameters = def.inputSchema;
    const properties = (parameters.properties ?? {}) as Record<string, PropertySchema>;
    // `def.requires` and the JSON schema's `required` list say the same thing in two places
    // (schema-side validation and permission-side defence), so the union is deduped: a missing
    // `cost` is ONE issue naming the enum, not the same line twice (T-11's answer must be
    // readable in one turn).
    const required = [...new Set([...((parameters.required as string[] | undefined) ?? []), ...(def.requires ?? [])])];

    for (const field of required) {
        const value = args[field];
        if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
            const schema = properties[field];
            errors.push({
                field,
                expected: schema ? describeSchema(schema) : 'a value',
                ...(value === undefined || value === null ? {} : { received: value })
            });
        }
    }

    for (const [field, schema] of Object.entries(properties)) {
        const value = args[field];
        if (value === undefined || value === null) continue;
        const type = String(schema.type ?? '');
        if (!matchesType(value, type)) {
            errors.push({ field, expected: describeSchema(schema), received: value });
            continue;
        }
        if (Array.isArray(schema.enum) && typeof value === 'string' && !(schema.enum as string[]).includes(value)) {
            errors.push({ field, expected: `one of ${(schema.enum as string[]).join(' | ')}`, received: value });
        }
        // An array of objects (criteria_passed, sources, revision_ids) is validated one item at
        // a time, because that is where T-10 and D-15 live.
        const itemSchema = schema.items as PropertySchema | undefined;
        if (type === 'array' && itemSchema && Array.isArray(value)) {
            value.forEach((item, index) => {
                const itemErrors = validateItem(def, `${field}[${index}]`, item, itemSchema);
                errors.push(...itemErrors);
            });
        }
    }

    // A field the tool does not declare is usually a near-miss name; naming the accepted set is
    // what lets the agent fix it in one turn instead of inventing another spelling.
    for (const field of Object.keys(args)) {
        if (field in properties || field === 'expects' || field === 'why') continue;
        errors.push({
            field,
            expected: `one of: ${Object.keys(properties).join(', ') || 'no named args'}`,
            received: args[field]
        });
    }

    return errors;
}

/** Validates one item of an array arg against its item schema. */
function validateItem(def: ToolDefinition, path: string, item: unknown, schema: PropertySchema): ValidationError[] {
    const errors: ValidationError[] = [];
    if (!matchesType(item, String(schema.type ?? ''))) {
        return [{ field: path, expected: describeSchema(schema), received: item }];
    }
    if (schema.type === 'object' && item && typeof item === 'object') {
        const properties = (schema.properties ?? {}) as Record<string, PropertySchema>;
        const required = (schema.required as string[] | undefined) ?? [];
        const record = item as Record<string, unknown>;
        for (const field of required) {
            const value = record[field];
            if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
                errors.push({
                    field: `${path}.${field}`,
                    expected: describeSchema(properties[field] ?? { type: 'string' })
                });
            }
        }
        for (const [field, child] of Object.entries(properties)) {
            const value = record[field];
            if (value === undefined || value === null) continue;
            if (!matchesType(value, String(child.type ?? ''))) {
                errors.push({ field: `${path}.${field}`, expected: describeSchema(child), received: value });
            }
            if (Array.isArray(child.enum) && typeof value === 'string' && !(child.enum as string[]).includes(value)) {
                errors.push({
                    field: `${path}.${field}`,
                    expected: `one of ${(child.enum as string[]).join(' | ')}`,
                    received: value
                });
            }
        }
    }
    void def;
    return errors;
}

/** A one-line description of a property schema, for the refusal's `expected` half. */
function describeSchema(schema: PropertySchema): string {
    const type = String(schema.type ?? 'value');
    if (Array.isArray(schema.enum)) return `one of ${(schema.enum as string[]).join(' | ')}`;
    if (type === 'array') {
        const items = schema.items as PropertySchema | undefined;
        return items ? `an array of ${describeSchema(items)}` : 'an array';
    }
    if (type === 'object') {
        const properties = schema.properties as Record<string, PropertySchema> | undefined;
        const required = (schema.required as string[] | undefined) ?? [];
        const names = Object.keys(properties ?? {});
        return `an object with ${names.length ? `${required.length ? 'required ' : ''}fields ${names.join(', ')}` : 'fields'}`;
    }
    return type;
}

/** Type check for the JSON-Schema primitives this layer uses. */
function matchesType(value: unknown, type: string): boolean {
    switch (type) {
        case 'string':
            return typeof value === 'string';
        case 'number':
        case 'integer':
            return typeof value === 'number' && Number.isFinite(value);
        case 'boolean':
            return typeof value === 'boolean';
        case 'array':
            return Array.isArray(value);
        case 'object':
            return typeof value === 'object' && value !== null && !Array.isArray(value);
        default:
            return true;
    }
}
