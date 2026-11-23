// Structured-output parsing and validation for the research pipeline (§4).
//
// WHY THIS FILE EXISTS: a phase ① sample is ONE JSON object matching a schema the transport
// advertised (`client.ts:ResponseFormat`). This client is non-streaming, so unlike the
// story-generator pattern (§4.1) there is no truncated JSON to repair with `jsonComplete`:
// the two failure modes are (a) the assistant answered prose that is not JSON and (b) it
// answered JSON that does not match the schema. Both are REPAIR-RETRY signals — the caller
// sends `error` (and `path`) back to the model on the next turn — so the messages here are
// written for the model to read, not for a stack trace.
//
// The validator is deliberately small and generic over the plain JSON Schema literals this
// package ships (`src/shared/schemas`): object properties/required/additionalProperties,
// string/minLength, array/items, enum, and the scalar primitive types. Nested objects and
// arrays validate recursively. No JSON-Schema library and no TypeBox dependency — the brief
// for this package forbids pulling either in. Unknown schema keywords are ignored, so
// `$schema`, `title`, and `description` on a schema literal are harmless.

export interface StructuredOk<T> {
    ok: true;
    value: T;
}

export interface StructuredErr {
    ok: false;
    /** Human- and model-readable: names the JSON path and what the schema expected. */
    error: string;
    /** JSON path of the first failure, e.g. `issues[2].quote`; absent when the value itself failed. */
    path?: string;
}

type JsonObject = Record<string, unknown>;

/** Plain object test — arrays and `null` are not objects for schema purposes. */
const asObject = (value: unknown): JsonObject | null =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;

/** JavaScript's label for a value, used in "expected X, received Y" messages. */
const typeLabel = (value: unknown): string => {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (Array.isArray(value)) return 'array';

    return typeof value;
};

/** The literal as it should be echoed back to the model (strings quoted). */
const valueLabel = (value: unknown): string => {
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return JSON.stringify(value);
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return String(value);

    return typeLabel(value);
};

/**
 * Builds the failure. The path is prepended only when there is one, so a root-level type
 * failure reads `expected object, received string` rather than starting with punctuation.
 */
const fail = (path: string, detail: string): StructuredErr =>
    path.length === 0 ? { ok: false, error: detail } : { ok: false, error: `${path}: ${detail}`, path };

/** `properties.quote` and root-array `[0]` paths, matching the examples in the brief. */
const propertyPath = (base: string, key: string): string => (base.length === 0 ? key : `${base}.${key}`);
const itemPath = (base: string, index: number): string => `${base}[${index}]`;

/** Whether a value satisfies a JSON Schema `type`. The package's schemas only use these. */
const matchesType = (type: string, value: unknown): boolean => {
    switch (type) {
        case 'object':
            return asObject(value) !== null;
        case 'array':
            return Array.isArray(value);
        case 'string':
            return typeof value === 'string';
        case 'number':
            return typeof value === 'number' && Number.isFinite(value);
        case 'integer':
            return typeof value === 'number' && Number.isInteger(value);
        case 'boolean':
            return typeof value === 'boolean';
        case 'null':
            return value === null;
        default:
            // Unknown `type` keyword: this validator does not enforce it. Never reached by
            // this package's schemas, and guessing a rejection would be worse than a pass.
            return true;
    }
};

const hasOwn = (record: JsonObject, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);

/**
 * Validates one value against one schema literal, returning the FIRST failure or `null`.
 * Check order is fixed so the repair message is deterministic: type → enum → object
 * (required, then declared properties in schema order, then unknown properties) → array
 * items in index order → string constraints.
 */
const validateAt = (schema: JsonObject, value: unknown, path: string): StructuredErr | null => {
    const declaredType = schema.type;

    if (typeof declaredType === 'string' && !matchesType(declaredType, value)) {
        return fail(path, `expected ${declaredType}, received ${typeLabel(value)}`);
    }

    // `enum` is how the package caps closed value sets (e.g. severity: critical | high).
    const enumValues = schema.enum;

    if (Array.isArray(enumValues) && !enumValues.some((entry) => entry === value)) {
        return fail(path, `expected one of ${JSON.stringify(enumValues)}, received ${valueLabel(value)}`);
    }

    if (declaredType === 'object') {
        const record = asObject(value);

        // Unreachable after the type gate above, but keeps the validator total.
        if (record === null) return fail(path, `expected object, received ${typeLabel(value)}`);

        // Required keys first: a missing key is the most actionable repair instruction.
        const required = Array.isArray(schema.required) ? schema.required : [];

        for (const key of required) {
            if (typeof key === 'string' && !hasOwn(record, key)) {
                return fail(propertyPath(path, key), 'required property is missing');
            }
        }

        // Absent `properties` means "no declared fields" — the empty record keeps both loops
        // below total, and `additionalProperties: false` then rejects every own key.
        const properties = asObject(schema.properties) ?? {};

        // Only keys the schema declares; optional keys absent from the value stay absent.
        for (const key of Object.keys(properties)) {
            if (!hasOwn(record, key)) continue;

            const propertySchema = asObject(properties[key]);

            // Boolean schemas (`true`) and malformed entries carry no constraints here.
            if (propertySchema === null) continue;

            const failure = validateAt(propertySchema, record[key], propertyPath(path, key));

            if (failure !== null) return failure;
        }

        // Closed schemas reject extra keys (§4.3: `additionalProperties: false`). When the
        // keyword is absent, JSON Schema's default is to allow them, so nothing is rejected.
        if (schema.additionalProperties === false) {
            for (const key of Object.keys(record)) {
                if (!hasOwn(properties, key)) {
                    return fail(propertyPath(path, key), 'unexpected property (additionalProperties is false)');
                }
            }
        }

        return null;
    }

    if (declaredType === 'array') {
        const items = asObject(schema.items);

        // `items` is a single schema in this package's literals. A missing items schema
        // means "any element", which is the JSON Schema default.
        if (items === null) return null;

        const elements = value as unknown[];

        for (let index = 0; index < elements.length; index += 1) {
            const failure = validateAt(items, elements[index], itemPath(path, index));

            if (failure !== null) return failure;
        }

        return null;
    }

    if (declaredType === 'string') {
        const minLength = schema.minLength;

        // `minLength` is what stops an empty `quote`/`premise` from satisfying the contract.
        if (typeof minLength === 'number' && (value as string).length < minLength) {
            return fail(
                path,
                `expected a string with minLength ${minLength}, received ${JSON.stringify(value as string)}`
            );
        }
    }

    return null;
};

/**
 * Strict validation over the plain JSON Schemas this package ships (§4.2).
 * Returns the parsed value typed as `T` on success, or a path-bearing repair message.
 */
export function validateStructured<T = unknown>(
    schema: Record<string, unknown>,
    value: unknown
): StructuredOk<T> | StructuredErr {
    const failure = validateAt(schema, value, '');

    return failure ?? { ok: true, value: value as T };
}

/** Repair messages are clipped so a rambling answer cannot flood the next prompt. */
const MAX_REPAIR_TEXT = 400;

const clipText = (text: string): string => (text.length <= MAX_REPAIR_TEXT ? text : `${text.slice(0, MAX_REPAIR_TEXT)}…`);

/**
 * JSON.parse the assistant content, then validate it (§4.2 steps 1 and 3).
 *
 * There is deliberately NO streaming repair here (`jsonComplete` is not used): this client
 * is non-streaming, so invalid JSON is the model breaking the output contract, and the
 * caller's repair turn must re-ask. The clipped raw prefix travels in `error` so the model
 * can see what it actually wrote.
 */
export function parseStructuredContent<T = unknown>(
    text: string | undefined,
    schema: Record<string, unknown>
): StructuredOk<T> | StructuredErr {
    // No content is not a parse failure that a repair can fix in place; the caller must ask
    // again. The message is still explicit so a run row records why the turn was unusable.
    if (text === undefined || text.trim().length === 0) {
        return { ok: false, error: 'assistant content is missing (the provider returned no text to parse)' };
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(text);
    } catch {
        return { ok: false, error: `assistant content is not valid JSON: ${JSON.stringify(clipText(text))}` };
    }

    return validateStructured<T>(schema, parsed);
}
