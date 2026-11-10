// Server configuration for the storyline gateway entry (R1).
//
// ONE resolution order, stated once and applied to every value:
//
//     CLI flag  ->  STORYLINE_* environment  ->  the harness environment name
//     ->  the built-in default
//
// WHY `HARNESS_*` IS THIRD AND NOT FIRST: this package runs INSIDE an
// `@underload/service` gateway, and the harness engine reads `HARNESS_BASE_URL` /
// `HARNESS_API_KEY` / `HARNESS_MODEL` for its own sessions
// (packages/underload/harness/src/server/config.ts). An operator who already runs a
// harness deployment should need no new variables to point a storyline session at
// the same provider; `STORYLINE_*` exists so the two can be run side by side with
// different providers from one shell.
//
// WHY THE PORT DEFAULT IS 5000 AND NOT A PRIVATE PORT: this server IS the gateway
// (`startServer({ root: <this package> })`), and the gateway is the only port a
// client ever dials. The dev proxy in vite.config.ts targets `http://127.0.0.1:5000`
// for exactly that reason — a private 5181-style listener would need a second mount
// story, and the user's decision was gateway-only discovery.
//
// WHY THE CHAIN VARIABLES HAVE NO `HARNESS_*` FALLBACK: `STORYLINE_CHAIN` /
// `STORYLINE_CHAIN_DEPTH` (R-C) decide who reviews whose work after a turn lands, and
// that is this package's behaviour — the harness has no equivalent setting to inherit.
// An operator who wants no chaining sets `STORYLINE_CHAIN=` (empty) or `off`; the
// difference between "unset" and "set to nothing" is the whole switch, so the chain
// resolver reads the raw variable instead of the blank-swallowing `firstOf`.
//
// WHY THIS FILE IS PURE: `./main.ts` binds sockets and installs signal handlers;
// the resolution rules are the part worth pinning with exact-value tests, so they
// live here with no I/O beyond one injected `existsSync` probe for the static root.
import { existsSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// The built-in defaults (the last resort of every value)
// ---------------------------------------------------------------------------

/** The gateway port — `@underload/service`'s own default, and the vite proxy target. */
export const DEFAULT_PORT = 5000;

// Loopback by default. The service's own default is `0.0.0.0`, which every
// distribution here accepts on purpose; this package's dev entry defaults to
// loopback so a story draft is not published to the LAN by `yarn start`, and
// `--host 0.0.0.0` is the documented way to widen it (the harness Origin gate
// accepts loopback and same-origin browsers either way).
export const DEFAULT_HOST = '127.0.0.1';

// The reference private-provider relay the harness package ships with, and the
// model that relay serves for it. Restating the pair here is deliberate: this
// package supplies `settings` explicitly to the runtime, which bypasses the
// harness's own fallbacks, and an empty base URL would leave every storyline
// session with no provider at all.
export const DEFAULT_PROVIDER_URL = 'http://localhost:5500/providers/private/v1';
export const DEFAULT_MODEL = 'local/basalt';

/** Durable state under this package (the harness writes `<root>/harness/state.json`). */
export const DEFAULT_DATABASE_DIRECTORY = 'temporary/harness';

/** The built UI this gateway serves at `/`, when it has been built. */
export const DEFAULT_STATIC_DIRECTORY = 'dist';

// ---------------------------------------------------------------------------
// The review chain (R-C) — who reviews whom, and how deep that goes
// ---------------------------------------------------------------------------

// The default is a circle, not a line: the editor revises the plan, the writer turns the
// revision into prose, the reader critiques the prose, and the editor repairs what the
// critique names. A circle is what "the entire Title makes sense" needs — a straight line
// ends with nobody responsible for the last finding — while `STORYLINE_CHAIN_DEPTH` is
// what stops the circle from running forever.
export const DEFAULT_CHAIN_RULE = 'editor:writer,writer:reader,reader:editor';

// Three chained turns per user turn. Deep enough to carry one full lap of the circle,
// shallow enough that a runaway pair of agents cannot spend a session's budget while the
// user is away.
export const DEFAULT_CHAIN_DEPTH = 3;

/** The environment names, exported so the help text and the tests name the same thing. */
export const CHAIN_RULE_ENVIRONMENT = 'STORYLINE_CHAIN';
export const CHAIN_DEPTH_ENVIRONMENT = 'STORYLINE_CHAIN_DEPTH';

/** The rule values that mean "no chaining at all" (alongside an explicitly empty value). */
export const CHAIN_DISABLED_VALUES = ['off', 'none', 'disabled'] as const;

export type StorylineChainRules = {
    /** False when chaining is off; the observer then watches and never speaks. */
    enabled: boolean;
    /** `agent -> the agent that reviews that agent's finished turn`. */
    next: Record<string, string>;
    /** How many CHAINED turns one user turn may cause, counted from the user's own turn. */
    maxDepth: number;
    /** The rule text this resolved to (the banner, and the exact-value tests). */
    rule: string;
};

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type StorylineServerConfig = {
    port: number;
    host: string;
    /** The `variables.root` handed to every endpoint; `null` means in-memory. */
    databaseRoot: string | null;
    /** Absolute directory served at `/`, or `null` for an API-only gateway. */
    staticRoot: string | null;
    /** The provider triple the storyline runtime builds sessions with. */
    settings: { baseURL: string; apiKey: string; model: string };
    /** The key-free document `GET /v1/storyline/config` advertises. */
    defaults: { baseURL: string; model: string; hasApiKey: boolean };
    /** R-C: the review chain this process runs (who reviews whom, and how deep). */
    chain: StorylineChainRules;
    /** Parsed CLI flags, kept for the startup banner and for tests. */
    flags: StorylineFlags;
};

export type StorylineFlags = {
    port?: string;
    host?: string;
    databaseRoot?: string;
    /** `--no-static` (API only) — the static root otherwise follows `dist/` when present. */
    noStatic: boolean;
    help: boolean;
};

export type ResolveConfigInput = {
    /** Parsed CLI flags (the camelCase form, mapped from `parseArgs` by ./main.ts). */
    flags?: Partial<StorylineFlags>;
    /** Defaults to `process.env`; injected so the precedence chain is testable. */
    env?: NodeJS.ProcessEnv;
    /** This package's root; defaults to the directory inferred from this module. */
    packageRoot?: string;
    /** Directory probe; defaults to `node:fs`'s `existsSync`, guarded. */
    exists?: (candidate: string) => boolean;
};

/** The package root, from this module's location (identical under src and dist). */
export const packageRootOf = (): string => path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

const text = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;

    const trimmed = value.trim();

    return trimmed.length === 0 ? undefined : trimmed;
};

/** First non-blank value in the list — the whole precedence rule, in one place. */
const firstOf = (...candidates: Array<string | undefined>): string | undefined => {
    for (const candidate of candidates) {
        const resolved = text(candidate);

        if (resolved !== undefined) return resolved;
    }

    return undefined;
};

/**
 * `--port` accepts 0 (OS-assigned) and a real TCP port; anything else is a startup
 * error naming the value. A silent coercion here would boot the gateway on a port
 * nobody asked for, and every endpoint module would then be reachable somewhere the
 * UI's proxy does not point.
 */
export const parsePort = (raw: string | undefined, source: string): number => {
    const value = firstOf(raw);

    if (value === undefined) return DEFAULT_PORT;

    if (!/^\d+$/.test(value)) {
        throw new Error(`${source} must be an integer between 0 and 65535 (got "${value}").`);
    }

    const port = Number(value);

    if (port > 65_535) throw new Error(`${source} must be an integer between 0 and 65535 (got "${value}").`);

    return port;
};

// ---------------------------------------------------------------------------
// The chain resolvers
// ---------------------------------------------------------------------------

/**
 * The rule text -> the map the orchestrator walks.
 *
 * An entry is `agent:next`, and the ONLY validation is structural: both sides name an
 * agent, so an operator's typo is visible in the resolved rule rather than silently
 * dropping a hop. An unknown agent name is legal here on purpose — the orchestrator
 * ignores a `next` it cannot reach, and a rule may legitimately name a roster this
 * deployment changed.
 *
 * `null` is the answer for "chaining is off": an empty value (the operator said so by
 * setting the variable to nothing) and the words `off` / `none` / `disabled` all mean
 * it. A caller that means "the operator declared nothing" passes the DEFAULT text, so
 * this function only ever reads a rule that somebody actually wrote.
 */
export const parseChainRule = (raw: string): Record<string, string> | null => {
    const rule = raw.trim();

    if (rule.length === 0) return null;
    if ((CHAIN_DISABLED_VALUES as readonly string[]).includes(rule.toLowerCase())) return null;

    const next: Record<string, string> = {};

    for (const entry of rule.split(',')) {
        const [from, to] = entry.split(':').map((part) => part.trim());

        // A malformed entry is skipped rather than fatal: a trailing comma in a shell
        // variable is a hand-edit, and the worst outcome is one hop missing from a
        // startup log line that names the whole rule.
        if (from === undefined || to === undefined || from.length === 0 || to.length === 0) continue;

        next[from] = to;
    }

    return Object.keys(next).length === 0 ? null : next;
};

/** `STORYLINE_CHAIN_DEPTH`: a non-negative integer, or a startup error naming the value. */
export const parseChainDepth = (raw: string | undefined, source: string): number => {
    const value = firstOf(raw);

    if (value === undefined) return DEFAULT_CHAIN_DEPTH;

    if (!/^\d+$/.test(value)) {
        throw new Error(`${source} must be a non-negative integer (got "${value}").`);
    }

    return Number(value);
};

/**
 * The chain this process runs with: `flag -> STORYLINE_CHAIN[_DEPTH] -> default`, with
 * no `HARNESS_*` name behind it because chaining is this package's behaviour and the
 * harness has no equivalent to inherit.
 */
export const resolveChainRules = (env: NodeJS.ProcessEnv = process.env): StorylineChainRules => {
    const declared = env[CHAIN_RULE_ENVIRONMENT];
    const depth = parseChainDepth(env[CHAIN_DEPTH_ENVIRONMENT], CHAIN_DEPTH_ENVIRONMENT);

    // An UNSET variable takes the default rule; a variable set to nothing takes NOTHING.
    // That difference is the whole `off` story, and it is why this function reads the raw
    // value instead of routing it through `firstOf` (which cannot tell the two apart).
    const next = declared === undefined ? parseChainRule(DEFAULT_CHAIN_RULE) : parseChainRule(declared);

    if (next === null) return { enabled: false, next: {}, maxDepth: depth, rule: '' };

    return { enabled: true, next, maxDepth: depth, rule: normalisedRule(next) };
};

/** A resolved map rendered back into `a:b,c:d` order, so the log matches the map. */
const normalisedRule = (next: Record<string, string>): string =>
    Object.entries(next)
        .map(([from, to]) => `${from}:${to}`)
        .join(',');

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

export const resolveServerConfig = (input: ResolveConfigInput = {}): StorylineServerConfig => {
    const env = input.env ?? process.env;
    const flags = { noStatic: false, help: false, ...input.flags };
    const root = input.packageRoot ?? packageRootOf();
    const exists = input.exists ?? existsSyncSafe;

    // port: --port -> STORYLINE_PORT -> default. The harness has no port variable of
    // its own, because a harness never owns the listener here — the gateway does.
    const portSource = flags.port !== undefined ? '--port' : 'STORYLINE_PORT';
    const port = parsePort(firstOf(flags.port, env.STORYLINE_PORT), portSource);

    const host = firstOf(flags.host, env.STORYLINE_HOST) ?? DEFAULT_HOST;

    // databaseRoot: an explicit path wins, then the env, then `<pkg>/temporary/harness`.
    // An EXPLICIT blank value (`--database-root ""` / `STORYLINE_DATABASE_ROOT=`)
    // means in-memory and maps to `null`, NOT to '': the harness throws on a
    // blank-but-present root, and `null` is its documented "no persistence" argument.
    // This value becomes the endpoint `variables.root`, i.e. the storage boundary the
    // harness runtime keys its store by — it is never the scanned source root.
    const databaseRoot =
        flags.databaseRoot !== undefined
            ? text(flags.databaseRoot) ?? null
            : env.STORYLINE_DATABASE_ROOT !== undefined
              ? text(env.STORYLINE_DATABASE_ROOT) ?? null
              : path.join(root, DEFAULT_DATABASE_DIRECTORY);

    // staticRoot: `--no-static` wins over everything (an explicit "API only"), then
    // the env override, then `dist/` WHEN IT EXISTS — a source checkout with no build
    // must boot the API rather than 404 every page.
    const staticRoot = flags.noStatic
        ? null
        : (firstOf(env.STORYLINE_STATIC_ROOT) ?? (exists(path.join(root, DEFAULT_STATIC_DIRECTORY))
              ? path.join(root, DEFAULT_STATIC_DIRECTORY)
              : null));

    const baseURL = firstOf(env.STORYLINE_PROVIDER_URL, env.HARNESS_BASE_URL) ?? DEFAULT_PROVIDER_URL;
    const apiKey = firstOf(env.STORYLINE_API_KEY, env.HARNESS_API_KEY, env.OPENAI_API_KEY) ?? '';
    const model = firstOf(env.STORYLINE_MODEL, env.HARNESS_MODEL) ?? DEFAULT_MODEL;

    return {
        port,
        host,
        databaseRoot,
        staticRoot,
        settings: { baseURL, apiKey, model },
        defaults: { baseURL, model, hasApiKey: apiKey.trim().length > 0 },
        chain: resolveChainRules(env),
        flags
    };
};

// One helper for the probe so the resolver never thinks about a host without a
// filesystem (a browser bundle of this module has none, and never calls it), and so
// a test can substitute its own answer.
const existsSyncSafe = (candidate: string): boolean => {
    try {
        return existsSync(candidate);
    } catch {
        return false;
    }
};
