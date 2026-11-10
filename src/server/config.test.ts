// The configuration chain (R1): every value resolves the same way — flag ->
// STORYLINE_* -> HARNESS_* -> default — and the two values that decide how the
// gateway behaves (the port and the storage boundary) are asserted exactly.
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
    DEFAULT_CHAIN_DEPTH,
    DEFAULT_CHAIN_RULE,
    DEFAULT_HOST,
    DEFAULT_MODEL,
    DEFAULT_PORT,
    DEFAULT_PROVIDER_URL,
    parseChainDepth,
    parseChainRule,
    parsePort,
    resolveChainRules,
    resolveServerConfig
} from './config';

const ROOT = path.resolve('/abs', 'create-storyline');

// `exists: () => false` is what makes `staticRoot` deterministic: without it the
// answer depends on whether this checkout happens to have a `dist/` right now.
const resolve = (input: Parameters<typeof resolveServerConfig>[0] = {}) =>
    resolveServerConfig({ packageRoot: ROOT, exists: () => false, ...input });

// The chain an empty environment resolves to, spelled out: this is the rule the banner
// prints and the orchestrator runs, and a silent change to either constant is a product
// change (R-C), so it has to break a test.
const DEFAULT_CHAIN = {
    enabled: true,
    next: { editor: 'writer', writer: 'reader', reader: 'editor' },
    maxDepth: DEFAULT_CHAIN_DEPTH,
    rule: DEFAULT_CHAIN_RULE
};

describe('storyline server configuration', () => {
    it('falls back to the gateway defaults with an empty environment', () => {
        const config = resolve({ env: {} });

        expect(config).toEqual({
            port: DEFAULT_PORT,
            host: DEFAULT_HOST,
            databaseRoot: path.join(ROOT, 'temporary', 'harness'),
            staticRoot: null,
            settings: { baseURL: DEFAULT_PROVIDER_URL, apiKey: '', model: DEFAULT_MODEL },
            defaults: { baseURL: DEFAULT_PROVIDER_URL, model: DEFAULT_MODEL, hasApiKey: false },
            chain: DEFAULT_CHAIN,
            flags: { noStatic: false, help: false }
        });
    });

    it('ranks a flag over STORYLINE_*, and STORYLINE_* over HARNESS_*', () => {
        const env = {
            STORYLINE_PORT: '5050',
            STORYLINE_HOST: '0.0.0.0',
            STORYLINE_PROVIDER_URL: 'http://storyline.example/v1',
            STORYLINE_MODEL: 'storyline/model-a',
            STORYLINE_API_KEY: 'storyline-key',
            HARNESS_BASE_URL: 'http://harness.example/v1',
            HARNESS_MODEL: 'harness/model-b',
            HARNESS_API_KEY: 'harness-key',
            OPENAI_API_KEY: 'openai-key'
        };

        expect(resolve({ env })).toMatchObject({
            port: 5050,
            host: '0.0.0.0',
            settings: {
                baseURL: 'http://storyline.example/v1',
                apiKey: 'storyline-key',
                model: 'storyline/model-a'
            },
            defaults: { baseURL: 'http://storyline.example/v1', model: 'storyline/model-a', hasApiKey: true }
        });

        expect(resolve({ env, flags: { port: '6060', noStatic: true, help: false } }).port).toBe(6060);
    });

    it('lets the harness names carry a provider when this package states none', () => {
        const config = resolve({
            env: { HARNESS_BASE_URL: 'http://harness.example/v1', HARNESS_MODEL: 'harness/model-b', OPENAI_API_KEY: 'openai-key' }
        });

        expect(config.settings).toEqual({
            baseURL: 'http://harness.example/v1',
            apiKey: 'openai-key',
            model: 'harness/model-b'
        });
    });

    it('treats an explicitly blank database root as in-memory, never as an empty path', () => {
        // `null` is the harness's documented "no persistence" argument; '' would throw
        // inside `normalizeHarnessDatabaseRoot` on the first request.
        expect(resolve({ env: { STORYLINE_DATABASE_ROOT: '' } }).databaseRoot).toBeNull();
        expect(resolve({ flags: { databaseRoot: '', noStatic: false, help: false }, env: {} }).databaseRoot).toBeNull();
        expect(resolve({ env: { STORYLINE_DATABASE_ROOT: '/srv/storyline' } }).databaseRoot).toBe('/srv/storyline');
    });

    it('serves dist/ only when it exists, and `--no-static` outranks everything', () => {
        expect(resolve({ env: {}, exists: () => true }).staticRoot).toBe(path.join(ROOT, 'dist'));

        expect(
            resolve({
                env: { STORYLINE_STATIC_ROOT: '/srv/ui' },
                exists: () => true,
                flags: { noStatic: true, help: false }
            }).staticRoot
        ).toBeNull();

        expect(resolve({ env: { STORYLINE_STATIC_ROOT: '/srv/ui' }, exists: () => false }).staticRoot).toBe('/srv/ui');
    });

    it('refuses a port that is not a port, naming the source', () => {
        expect(() => parsePort('abc', '--port')).toThrow('--port must be an integer between 0 and 65535 (got "abc").');
        expect(() => parsePort('70000', 'STORYLINE_PORT')).toThrow(
            'STORYLINE_PORT must be an integer between 0 and 65535 (got "70000").'
        );
        // `0` is legal and means "the kernel chooses" — ./main.ts turns it into a real
        // number, because the gateway never reports the bound port.
        expect(parsePort('0', '--port')).toBe(0);
    });

    it('runs the review circle by default and keeps the rule text it resolved', () => {
        // The rule and its rendering are asserted together: the banner prints `rule`, and an
        // operator compares THAT against what they set.
        expect(resolveChainRules({})).toEqual(DEFAULT_CHAIN);
        expect(resolve({ env: {} }).chain).toEqual(DEFAULT_CHAIN);
        expect(resolve({ env: { STORYLINE_PROVIDER_URL: 'http://x/v1' } }).chain).toEqual(DEFAULT_CHAIN);
    });

    it('treats an explicitly empty, off, none or disabled rule as no chaining', () => {
        // The three words and the empty string are one behaviour, and case does not matter —
        // `STORYLINE_CHAIN=OFF` in a shell is not a different product.
        const off = { enabled: false, next: {}, maxDepth: DEFAULT_CHAIN_DEPTH, rule: '' };

        for (const raw of ['', 'off', 'none', 'NONE', ' disabled ']) {
            expect(resolveChainRules({ STORYLINE_CHAIN: raw })).toEqual(off);
            expect(parseChainRule(raw)).toBeNull();
        }

        // An UNSET variable is not the same thing as an empty one: unset means "the default",
        // which is the whole reason resolveChainRules reads the raw value.
        expect(resolveChainRules({}).enabled).toBe(true);
    });

    it('parses an operator rule, skipping the malformed entries a hand-edit leaves behind', () => {
        expect(parseChainRule('writer:reader')).toEqual({ writer: 'reader' });
        expect(parseChainRule('editor : writer , writer: reader')).toEqual({ editor: 'writer', writer: 'reader' });
        // A trailing comma and a half-written pair are hand-edits, not fatal: one hop is
        // missing from a startup line that still names the whole rule.
        expect(parseChainRule('writer:reader,')).toEqual({ writer: 'reader' });
        expect(parseChainRule('writer:reader,:')).toEqual({ writer: 'reader' });
        // A name this package has never heard of is legal — the roster is the operator's.
        expect(parseChainRule('poet:scribe')).toEqual({ poet: 'scribe' });
        expect(resolveChainRules({ STORYLINE_CHAIN: 'poet:scribe' })).toEqual({
            enabled: true,
            next: { poet: 'scribe' },
            maxDepth: DEFAULT_CHAIN_DEPTH,
            rule: 'poet:scribe'
        });
        // Nothing reachable in the text is off, whatever the words were.
        expect(parseChainRule('::, ,')).toBeNull();
    });

    it('reads the depth cap, and refuses one that is not a count', () => {
        expect(parseChainDepth(undefined, 'STORYLINE_CHAIN_DEPTH')).toBe(DEFAULT_CHAIN_DEPTH);
        expect(parseChainDepth('1', 'STORYLINE_CHAIN_DEPTH')).toBe(1);
        // `0` means "the user drives every turn": one finished turn, no chaining. It is a
        // count, not a switch, so it is accepted rather than treated as unset.
        expect(parseChainDepth('0', 'STORYLINE_CHAIN_DEPTH')).toBe(0);
        expect(resolveChainRules({ STORYLINE_CHAIN_DEPTH: '7' }).maxDepth).toBe(7);

        expect(() => parseChainDepth('-1', 'STORYLINE_CHAIN_DEPTH')).toThrow(
            'STORYLINE_CHAIN_DEPTH must be a non-negative integer (got "-1").'
        );
        expect(() => parseChainDepth('two', 'STORYLINE_CHAIN_DEPTH')).toThrow(
            'STORYLINE_CHAIN_DEPTH must be a non-negative integer (got "two").'
        );
        // A bad depth is a startup error naming the variable, in the resolved config too.
        expect(() => resolve({ env: { STORYLINE_CHAIN_DEPTH: 'x' } })).toThrow(
            'STORYLINE_CHAIN_DEPTH must be a non-negative integer (got "x").'
        );
    });
});
