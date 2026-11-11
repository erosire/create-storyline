// Server configuration — deliberately small, because this build's server owns state.
//
// WHY THERE IS ALMOST NOTHING HERE: P1 makes the Dashboard's store the only memory in the
// system and L-3 makes the loop restart from it with no lost state, so the process needs no
// session store, no queue backend, and no cache to configure. What a deployment genuinely
// has to choose is where it listens and WHERE THE BOOK LIVES — `<storeRoot>/store.json` +
// `<storeRoot>/journal.jsonl` (W1), the two files the whole product is built on.
//
// WHY THE PROVIDER TRIPLE IS NOT HERE: §8's harness transport is a later wave's wiring, and
// E-0 puts cost out of scope — a base URL, key and model belong with whatever spawns runs,
// not with the store's address. Restating them here would invent a third place to configure
// what one wave owns (P15: build the hole named, not half-filled).
//
// RESOLUTION ORDER, stated once and applied to every value:
//
//     CLI flag  ->  STORYLINE_* environment  ->  the built-in default
//
// An explicitly BLANK value means "off" rather than "fall through": for the store root that
// is the difference between the default directory and an in-memory run (`Store.empty()`), and
// the distinction is the whole switch — the same reasoning that makes `STORYLINE_STORE_ROOT=`
// different from leaving it unset.
import { existsSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** The gateway port the UI's dev proxy dials (see vite.config.ts's `/v1/storyline` target). */
export const DEFAULT_PORT = 5000;

/** Loopback by default: a story draft is not published to the LAN by `yarn start` (U-3's Stop is the cord). */
export const DEFAULT_HOST = '127.0.0.1';

/**
 * Durable state under this package. The store keeps exactly two files here (W1: `store.json`
 * is the memory, `journal.jsonl` is the D-12a derivation source), so this one path is the
 * Author's book — a backup of it is a backup of the product.
 */
export const DEFAULT_STORE_DIRECTORY = 'temporary/storyline';

/** The built UI this server serves at `/`, when it has been built. */
export const DEFAULT_STATIC_DIRECTORY = 'dist';

/** The environment names, exported so the help text, the banner and the tests name the same thing. */
export const PORT_ENVIRONMENT = 'STORYLINE_PORT';
export const HOST_ENVIRONMENT = 'STORYLINE_HOST';
export const STORE_ROOT_ENVIRONMENT = 'STORYLINE_STORE_ROOT';
export const STATIC_ROOT_ENVIRONMENT = 'STORYLINE_STATIC_ROOT';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type StorylineFlags = {
    port?: string;
    host?: string;
    storeRoot?: string;
    /** `--no-static` — API-only. The store is never optional, so there is no `--no-store`. */
    noStatic: boolean;
    help: boolean;
};

export type StorylineServerConfig = {
    port: number;
    host: string;
    /** Where `store.json` + `journal.jsonl` live; `null` = in-memory (`Store.empty()`, no persistence). */
    storeRoot: string | null;
    /** Absolute directory served at `/`, or `null` for an API-only server. */
    staticRoot: string | null;
    /** Parsed flags, kept for the startup banner and the exact-value tests. */
    flags: StorylineFlags;
};

export type ResolveConfigInput = {
    flags?: Partial<StorylineFlags>;
    /** Defaults to `process.env`; injected so the precedence chain is testable without touching the shell. */
    env?: Record<string, string | undefined>;
    /** This package's root; defaults to the directory inferred from this module. */
    packageRoot?: string;
    /** Directory probe; defaults to a guarded `existsSync` (a browser bundle of this module has none). */
    exists?: (candidate: string) => boolean;
};

// ---------------------------------------------------------------------------
// Resolution primitives
// ---------------------------------------------------------------------------

/** The package root, from this module's location (identical under `src` and `dist`). */
export const packageRootOf = (): string => path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

/** A blank or whitespace-only value is treated as ABSENT — the caller decides what "off" means. */
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
 * `--port` / `STORYLINE_PORT`: 0 (OS-assigned) through 65535, or a startup error naming the
 * value. A silent coercion here would boot the server somewhere the UI's proxy does not point.
 */
export const parsePort = (raw: string | undefined, source: string): number => {
    const value = firstOf(raw);

    if (value === undefined) return DEFAULT_PORT;

    if (!/^\d+$/.test(value)) throw new Error(`${source} must be an integer between 0 and 65535 (got "${value}").`);

    const port = Number(value);

    if (port > 65_535) throw new Error(`${source} must be an integer between 0 and 65535 (got "${value}").`);

    return port;
};

/**
 * The store root, resolved with the blank-means-in-memory rule (see the file header): an
 * explicit `--store-root ""` or `STORYLINE_STORE_ROOT=` is the operator asking for a run with
 * no durable book, which is exactly `Store.empty()`, so it maps to `null` and not to `''`.
 */
export const resolveStoreRoot = (
    flags: Partial<StorylineFlags>,
    env: Record<string, string | undefined>,
    packageRoot: string
): string | null => {
    // An EXPLICIT flag wins outright, including when it is present-but-blank.
    if (flags.storeRoot !== undefined) return text(flags.storeRoot) ?? null;
    if (env[STORE_ROOT_ENVIRONMENT] !== undefined) return text(env[STORE_ROOT_ENVIRONMENT]) ?? null;

    return path.join(packageRoot, DEFAULT_STORE_DIRECTORY);
};

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

export const resolveServerConfig = (input: ResolveConfigInput = {}): StorylineServerConfig => {
    const env = input.env ?? process.env;
    const flags: StorylineFlags = { noStatic: false, help: false, ...input.flags };
    const root = input.packageRoot ?? packageRootOf();
    const exists = input.exists ?? existsSyncSafe;

    const portSource = flags.port !== undefined ? '--port' : PORT_ENVIRONMENT;
    const port = parsePort(firstOf(flags.port, env[PORT_ENVIRONMENT]), portSource);
    const host = firstOf(flags.host, env[HOST_ENVIRONMENT]) ?? DEFAULT_HOST;

    // staticRoot: `--no-static` wins over everything (an explicit "API only"), then the env
    // override, then `dist/` WHEN IT EXISTS — a source checkout with no build must boot the
    // API rather than 404 every page (U-12: the Dashboard is a client of this server, never a
    // dependency of it).
    const staticRoot = flags.noStatic
        ? null
        : (firstOf(env[STATIC_ROOT_ENVIRONMENT]) ??
          (exists(path.join(root, DEFAULT_STATIC_DIRECTORY)) ? path.join(root, DEFAULT_STATIC_DIRECTORY) : null));

    return { port, host, storeRoot: resolveStoreRoot(flags, env, root), staticRoot, flags };
};

/** One helper for the probe so a host without a filesystem never reaches for one. */
const existsSyncSafe = (candidate: string): boolean => {
    try {
        return existsSync(candidate);
    } catch {
        return false;
    }
};
