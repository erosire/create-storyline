// §10 / W9-W13 — the server boot: composition of the runtime and the listener (T7).
//
// TWO HALVES, ON PURPOSE:
//
//   * `buildStorylineRuntime` — wires the store, the criteria engine, the Digest builder, the tool
//     runtime, the chat transport, the run executor, the loop engine and the route table into one object
//     with a Hono `app`. No port, no filesystem choice, no timers started. This is what an embedding host
//     (the §10 gateway mounting `/v1/storyline`) and every test use: `app.request(...)` is a real request
//     through the real routes against the real store.
//   * `startStorylineServer` — the same runtime plus `@hono/node-server`, the built UI, and the graceful
//     close. Only the CLI calls it.
//
// WHY THE SEAMS ARE OPTIONAL PROPS RATHER THAN A CONTAINER: P1/L-3 say the ROWS are the state, so a test
// that wants the whole loop needs a real `Store` and a real `RunExecutor`, and everything else is either
// injected (a scripted `MockChatClient`, a `Store.empty()`) or defaulted (the provider triple from the
// environment). A dependency-injection framework would be a second way to build one object.
//
// THE PROVIDER TRIPLE LIVES HERE AND NOT IN `../config.ts`: `config.ts` deliberately owns "where the
// process listens and where the book lives"; the transport that spawns runs belongs with the thing that
// spawns runs (that file's header says so). Reading it here keeps that file's precedence tests honest.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createOpenAICompatClient } from '../llm/client';
import { createToolRuntime } from '../tools/context';
import { CriteriaEngine } from '../criteria/engine';
import { DigestBuilder } from '../digest/digest';
import { RunExecutor } from '../run/executor';
import { LoopEngine } from '../loop/engine';
import { storedGlobalMaxConcurrent } from '../loop/ceiling';
import { StoryKnowledge } from '../knowledge';
import { Store } from '../store/store';
import { StoryStores } from '../store/story-stores';
import { ServerConfig } from '../runtime/server-config';
import { StoryRuntimes } from '../runtime/story-runtimes';
import { StoryThreadLog } from '../run/thread-log';
import { ASSISTANT_ROLE, ASSISTANT_TEMPLATE, createStorylineRoutes } from './routes';
import type { ChatClient } from '../llm/client';
import type { ToolRuntime } from '../run/types';
import type { RunExecutor as RunExecutorType } from '../run/executor';
import type { LoopEngineConfig } from '../loop/types';
import type { StoryCommit } from '../store/story-stores';
import type { StoryLoop } from './routes';
import type { Template } from '../../shared/types';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// The provider seam (see the file header for why this is not `config.ts`)
// ---------------------------------------------------------------------------

export const PROVIDER_BASE_URL_ENVIRONMENT = 'STORYLINE_PROVIDER_BASE_URL';
export const PROVIDER_MODEL_ENVIRONMENT = 'STORYLINE_PROVIDER_MODEL';
export const PROVIDER_API_KEY_ENVIRONMENT = 'STORYLINE_PROVIDER_API_KEY';

/** The §8.5 web-tool fetch is behind the same transport, so one base URL covers it. */
export const DEFAULT_PROVIDER_BASE_URL = 'http://localhost:8800/providers/private/v1';

/** Any OpenAI-compatible relay name; the local dev relay serves a single default model. */
export const DEFAULT_PROVIDER_MODEL = 'local/basalt';

/**
 * Loop-level env overrides for the sweep (S-5's ceiling, L-1's cadence, S-4a's lease).
 *
 * `STORYLINE_GLOBAL_MAX_CONCURRENT` is also the one number of the three the Author may move from the
 * workstation (the employee rail's "Max threads", `PATCH /loop`). The env var therefore means something
 * specific: it is the OPERATOR's pin, and it outranks the stored choice on every boot — an unset env var
 * (the usual case) is what lets the Author's choice persist. `loop/ceiling.ts` states that precedence.
 */
export const GLOBAL_MAX_CONCURRENT_ENVIRONMENT = 'STORYLINE_GLOBAL_MAX_CONCURRENT';
export const SWEEP_INTERVAL_MS_ENVIRONMENT = 'STORYLINE_SWEEP_INTERVAL_MS';
export const LEASE_IDLE_MS_ENVIRONMENT = 'STORYLINE_LEASE_IDLE_MS';

// ---------------------------------------------------------------------------
// §8.6 — the Author-invoked harness
// ---------------------------------------------------------------------------

/**
 * §8.6's assistant, as a built-in template row.
 *
 * WHY THE ROLE IS A `writer` KIND: `RoleKind` (§4.12) has exactly four values — writer, editor, reader,
 * checker — and the permission row is selected by KIND (`tools/permissions.ts`, T-1a). The assistant has
 * to answer an Author's question by CHANGING an artifact, and only the writer row holds the Summary and
 * chapter writes; a checker-kind assistant could read and report and nothing else, which is the chat
 * reply §8.6 explicitly rules out. `web: false` is the §8.6 "no web tools" half — whether a run may call
 * `searchWeb`/`fetchPage` is decided by the run layer's hook wiring, which this layer does not own
 * (reported as a delta), so the flag records the intent on the card the Author sees (U-8).
 */
export const assistantTemplate = (): Omit<Template, 'id' | 'rev' | 'created_at' | 'updated_at'> => ({
    name: ASSISTANT_TEMPLATE,
    title: 'Assistant',
    description:
        'The Author-invoked harness behind "Ask assistant" (U-4). One artifact in, one artifact changed out — never a chat reply (§8.6).',
    roles: [
        {
            name: ASSISTANT_ROLE,
            kind: 'writer',
            web: false,
            prompt: [
                'You are the Storyline assistant, invoked by the Author from a locked pane (U-4, §8.6).',
                'Read the artifact named in the brief with the read tools, then make the smallest change that',
                'answers the ask — a Summary line, a section, a plotline field — with the write tools, and say',
                'in one sentence what you changed and why. The Seed is read-only for you, as for every agent',
                '(P5). A locked artifact stays locked: propose instead of overwriting when the lock forbids a',
                'write, and say so plainly rather than working around the rule.'
            ].join(' ')
        }
    ],
    serves_phase: ['summary', 'plotlines', 'chapters'],
    done_definition: 'the Author asked for one thing, and the artifact named in the brief now answers it.',
    selection_rules: 'prefer the smallest edit that answers the ask; never rewrite what the Author did not ask about.',
    attempts: 1,
    delegation: [],
    escalation_rule: 'if the ask needs a decision only the Author can make, ask instead of guessing (P7).',
    max_concurrent: 1,
    builtin: true,
    editable: false
});

/**
 * Idempotent boot seed. The engine seeds `BUILT_IN_TEMPLATES` by slug inside `createStory`
 * (`loop/engine.ts`), so seeding here as well is safe on a restart: the row already there is returned
 * rather than duplicated. Returns the row so the CLI banner can name the catalogue honestly.
 */
export function seedAssistantTemplate(store: Store): Template {
    const existing = store.templates.list().find((row) => row.name === ASSISTANT_TEMPLATE);

    if (existing !== undefined) return existing;

    return store.templates.create(assistantTemplate(), {
        run_ref: null,
        author: true,
        why: 'the Author-invoked assistant harness ships with the catalogue (§8.6, U-4)'
    });
}

// ---------------------------------------------------------------------------
// The runtime
// ---------------------------------------------------------------------------

export interface StorylineRuntimeOptions {
    /**
     * S-RUNTIME — the single-book shape: one Story book, one runtime. With no `runtimes`, every Story row in
     * this book is adopted into its own runtime (`runtime/story-runtimes.ts:adopt`), which is the same code
     * path the registry uses, so a one-Story host and a many-Story server differ only in the book list.
     * Defaults to `Store.empty()`.
     */
    store?: Store;
    /**
     * S-RUNTIME — the workspace root (`<root>/server/` + `<root>/stories/<uuid>/`). Needs `openStorylineRuntime`.
     * `null` (or `''`) is the documented in-memory workspace: the same layout in RAM, nothing written — which
     * is what `--store-root ""` means, and why the type is nullable rather than optional-only.
     */
    storeRoot?: string | null;
    /** S-RUNTIME — an open coordinator (`openStorylineRuntime`, or a test that built one). Wins over `store`. */
    runtimes?: StoryRuntimes;
    /** S-RUNTIME — the app-config book behind that coordinator. */
    config?: ServerConfig;
    /**
     * The Story knowledge projection. Defaults to an in-memory one over the same book; the CLI
     * loads a durable one beside `store.json` so a destroyed harness cannot take it away.
     */
    knowledge?: StoryKnowledge;
    /** Retained thread history. Defaults to memory; the CLI opens the durable log beside the book. */
    threadLog?: StoryThreadLog;
    /** The model transport. Defaults to the OpenAI-compatible client from the provider env triple. */
    chat?: ChatClient;
    /** The §8 tool catalogue. Defaults to `createToolRuntime(store)`. */
    runtime?: ToolRuntime;
    /** The spawner. Defaults to `new RunExecutor({store, runtime, chat})`. */
    executor?: RunExecutorType;
    /** The loop. Defaults to a `LoopEngine` over the executor. */
    engine?: LoopEngine;
    /** Sweep settings. The server turns `autoSweep` ON; tests turn it off and drive every sweep. */
    engineConfig?: LoopEngineConfig;
    /** Defaults to `process.env`. */
    env?: Record<string, string | undefined>;
    /** SSE debounce (one frame per topic per commit burst). */
    streamDebounceMs?: number;
    /** Passed to the tool runtime and the U-8 model-catalog route so neither touches the network in tests. */
    fetchImpl?: typeof fetch;
    /** Skips the §8.6 template seed (a test that asserts the catalogue is exactly the built-ins). */
    noAssistantSeed?: boolean;
}

export interface StorylineRuntime {
    app: Hono;
    /** S-RUNTIME: in registry mode this is the APP-CONFIG book (`<root>/server/`); Story rows are elsewhere. */
    store: Store;
    /** S-RUNTIME: the coordinator that owns one runtime per Story uuid; the route table routes through it. */
    runtimes: StoryRuntimes;
    /** S-RUNTIME: the app-config side (the harness catalogue, the roster's models, the loop ceiling). */
    config: ServerConfig;
    /** The app-level knowledge projection — a fallback; each Story's runtime owns its own directory. */
    knowledge: StoryKnowledge;
    /** The app-level thread log — a fallback; each Story's runtime owns `harness/threads.jsonl`. */
    threadLog: StoryThreadLog;
    criteria: CriteriaEngine;
    digest: DigestBuilder;
    executor: RunExecutorType;
    /** The loop: the coordinator's router in every shipped shape, a bare `LoopEngine` for a hand-wired host. */
    engine: StoryLoop;
    /** The model name every run defaults to when its template names none (T-6b). */
    defaultModel: string;
}

/** First non-blank string, so an explicitly empty env var falls through to the default. */
const text = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;

    const trimmed = value.trim();

    return trimmed.length === 0 ? undefined : trimmed;
};

/** A positive-integer env override, or undefined to leave the engine's own default in place. */
const positiveInt = (value: string | undefined): number | undefined => {
    const raw = text(value);

    if (raw === undefined) return undefined;

    const parsed = Number(raw);

    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
};

/**
 * Builds the whole server without starting anything. Everything is defaulted from the environment and
 * everything is overridable, which is what makes the route tests real integration tests: an injected
 * `MockChatClient` and an in-memory store are the only doubles, and the store, criteria engine, Digest
 * builder, executor and engine are the shipped ones.
 */
/** The provider triple, defaulted from the environment (both shapes resolve it the same way). */
const resolveProvider = (options: StorylineRuntimeOptions) => {
    const env = options.env ?? process.env;
    const baseUrl = text(env[PROVIDER_BASE_URL_ENVIRONMENT]) ?? DEFAULT_PROVIDER_BASE_URL;
    const defaultModel = text(env[PROVIDER_MODEL_ENVIRONMENT]) ?? DEFAULT_PROVIDER_MODEL;
    const apiKey = text(env[PROVIDER_API_KEY_ENVIRONMENT]);
    const chat =
        options.chat ??
        createOpenAICompatClient({ baseUrl, ...(apiKey === undefined ? {} : { apiKey }), model: defaultModel });

    return { env, baseUrl, defaultModel, apiKey, chat };
};

/** The sweep settings, with the operator's env pins applied over an injected config (S-5, L-1, S-4a). */
const resolveEngineConfig = (env: Record<string, string | undefined>, options: StorylineRuntimeOptions) => {
    // A started loop sweeps on a timer (L-1); the default here is ON because a server with no sweep is a
    // dashboard that never moves. Tests inject `autoSweep: false` and become the clock.
    const config: LoopEngineConfig = { autoSweep: true, ...options.engineConfig };

    // S-5's ceiling, in the precedence `loop/ceiling.ts` states: the operator's env pin, then a config the
    // caller injected (a test or an embed), then the number the Author last chose in the employee rail, and
    // otherwise nothing — which leaves the loop on `DEFAULT_GLOBAL_MAX_CONCURRENT`. Under the coordinator the
    // SAME precedence resolves the one shared ceiling (`runtime/story-runtimes.ts`), whose env pin is this.
    config.globalMaxConcurrent = positiveInt(env[GLOBAL_MAX_CONCURRENT_ENVIRONMENT]) ?? config.globalMaxConcurrent;
    config.sweepIntervalMs = positiveInt(env[SWEEP_INTERVAL_MS_ENVIRONMENT]) ?? config.sweepIntervalMs;
    config.leaseIdleMs = positiveInt(env[LEASE_IDLE_MS_ENVIRONMENT]) ?? config.leaseIdleMs;

    return config;
};

/** The §8.5 web-tool fetch seam, threaded into every tool runtime this file builds. */
const toolOptions = (options: StorylineRuntimeOptions) =>
    options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl };

export function buildStorylineRuntime(options: StorylineRuntimeOptions = {}): StorylineRuntime {
    const { env, baseUrl, defaultModel, apiKey, chat } = resolveProvider(options);
    const config = resolveEngineConfig(env, options);
    const criteria = new CriteriaEngine();
    const digest = new DigestBuilder();

    // S-RUNTIME — shape 1: the coordinator is already open (`openStorylineRuntime`), and this function is the
    // route wiring only. `deps.store` is the APP book (`<root>/server/`), the engine is the router, and each
    // Story's own executor, knowledge projection and thread log live in its context — so the two app-level
    // fallbacks below are in-memory by default and are never asked a question a Story could answer.
    if (options.runtimes !== undefined) {
        const runtimes = options.runtimes;
        const appConfig = options.config ?? runtimes.appConfig;
        const store = appConfig.book;

        if (options.noAssistantSeed !== true) seedAssistantTemplate(store);

        const knowledge = options.knowledge ?? StoryKnowledge.memory(store);
        const threadLog = options.threadLog ?? StoryThreadLog.memory();
        const runtime = options.runtime ?? createToolRuntime(store, toolOptions(options));
        const executor =
            options.executor ?? new RunExecutor({ store, runtime, chat, defaultModel, threadLog });

        return wire({
            app: new Hono(),
            store,
            runtimes,
            config: appConfig,
            knowledge,
            threadLog,
            criteria,
            digest,
            executor,
            engine: runtimes,
            baseUrl,
            apiKey,
            defaultModel,
            options
        });
    }

    // S-RUNTIME — shapes 2 and 3: ONE book, adopted into one runtime. It may be Story-bound (a host that
    // owns `<root>/stories/<uuid>/`) or flat (`Store.empty()` for tests). The router is built either way, so
    // the route table, the ceiling and the sweep are the same code in every shape; the router adopts the
    // executor, the loop, the projection and the thread log handed in below, verbatim.
    const store = options.store ?? Store.empty();
    const knowledge = options.knowledge ?? StoryKnowledge.memory(store);
    const threadLog = options.threadLog ?? StoryThreadLog.memory();

    if (options.noAssistantSeed !== true) seedAssistantTemplate(store);

    const runtime = options.runtime ?? createToolRuntime(store, toolOptions(options));
    const executor = options.executor ?? new RunExecutor({ store, runtime, chat, defaultModel, threadLog });

    // The coordinator owns the one sweep timer (`start()`/`stop()` are its switch), so the engine it adopts is
    // built with its OWN timer off — otherwise a started workspace would sweep twice per tick, once by the
    // router and once by the engine's own interval, and the second sweep would race the first.
    const engine =
        options.engine ??
        new LoopEngine({ store, executor, criteria, digest, config: { ...config, autoSweep: false } });

    const runtimes =
        options.runtimes ??
        StoryRuntimes.adopt({
            store,
            chat,
            defaultModel,
            engine,
            executor,
            runtime,
            knowledge,
            threadLog,
            harnessRoot: store.rootDir,
            // S-5's precedence, unchanged for this shape: the operator's env pin, then an injected config,
            // then the number the Author last chose (which in a single book lives IN that book).
            engineConfig: {
                ...config,
                globalMaxConcurrent: config.globalMaxConcurrent ?? storedGlobalMaxConcurrent(store)
            }
        });

    return wire({
        app: new Hono(),
        store,
        runtimes,
        // No app book was opened for a single store: its catalogue and settings are the book itself, and
        // the router's in-memory placeholder is never written to (a rail write lands in this book, because
        // the route that moves the ceiling remembers it in `deps.store` too).
        config: options.config ?? runtimes.appConfig,
        knowledge,
        threadLog,
        criteria,
        digest,
        executor,
        // S-RUNTIME: the router is the loop the server starts and the routes call, in BOTH shapes — a host
        // that reads `runtime.engine` gets the workspace's verbs, and `start()`/`stop()` reach every Story.
        engine: runtimes,
        baseUrl,
        apiKey,
        defaultModel,
        options
    });
}

/** One place to mount the route table, so both shapes answer with the same routes and the same deps. */
function wire(input: {
    app: Hono;
    store: Store;
    runtimes: StoryRuntimes;
    config: ServerConfig;
    knowledge: StoryKnowledge;
    threadLog: StoryThreadLog;
    criteria: CriteriaEngine;
    digest: DigestBuilder;
    executor: RunExecutorType;
    engine: StoryLoop;
    baseUrl: string;
    apiKey?: string;
    defaultModel: string;
    options: StorylineRuntimeOptions;
}): StorylineRuntime {
    const { options } = input;

    input.app.route(
        '/v1/storyline',
        createStorylineRoutes({
            store: input.store,
            engine: input.engine,
            runtimes: input.runtimes,
            config: input.config,
            executor: input.executor,
            criteria: input.criteria,
            digest: input.digest,
            knowledge: input.knowledge,
            threadLog: input.threadLog,
            // U-8 — the roster's dropdown reads the SAME provider root the transport dials.
            providerBaseUrl: input.baseUrl,
            ...(input.apiKey === undefined ? {} : { providerApiKey: input.apiKey }),
            ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
            ...(options.streamDebounceMs === undefined ? {} : { streamDebounceMs: options.streamDebounceMs })
        })
    );

    return {
        app: input.app,
        store: input.store,
        runtimes: input.runtimes,
        config: input.config,
        knowledge: input.knowledge,
        threadLog: input.threadLog,
        criteria: input.criteria,
        digest: input.digest,
        executor: input.executor,
        engine: input.engine,
        defaultModel: input.defaultModel
    };
}

// ---------------------------------------------------------------------------
// S-RUNTIME — the registry boot: a workspace of per-Story books
// ---------------------------------------------------------------------------

export interface StorylineOpenOptions extends Omit<
    StorylineRuntimeOptions,
    'store' | 'runtimes' | 'engine' | 'executor' | 'runtime' | 'knowledge' | 'threadLog'
> {
    /**
     * The workspace root: `<root>/server/` for app configuration and `<root>/stories/<uuid>/` for one book
     * per Story (`store/persist.ts`). `''` or null is the in-memory workspace, which behaves identically and
     * writes nothing — what `--store-root ""` means.
     */
    storeRoot?: string | null;
    /** An open registry, instead of opening `storeRoot` (an embed that owns its books). */
    stories?: StoryStores;
    /** An open app-config book, instead of opening `<storeRoot>/server/` (an embed that owns its catalogue). */
    appConfig?: ServerConfig;
    /** Where a harness's scratch files go; defaults to the workspace root. */
    harnessRoot?: string | null;
    /** Every commit of every book, for a host that mirrors the feed elsewhere (the §10 gateway's SSE). */
    onCommit?: (commit: StoryCommit) => void;
}

/**
 * Opens a WORKSPACE: the app book, the Story registry, and one runtime per Story book — each with its own
 * loop, executor, knowledge projection and thread log — behind the same route table.
 *
 * This is the only composition that awaits, because a durable knowledge projection has to be loaded per
 * Story; `buildStorylineRuntime` stays synchronous for an embed and for every route test. A legacy flat
 * root (a `store.json` at `<root>`) is refused HERE, by the registry's own layout error: there is no
 * migration, and a half-read old book would answer requests about Stories it no longer holds.
 */
export async function openStorylineRuntime(options: StorylineOpenOptions = {}): Promise<StorylineRuntime> {
    const { env, defaultModel, chat } = resolveProvider(options);
    const engineConfig = resolveEngineConfig(env, options);
    const root = options.storeRoot === undefined || options.storeRoot === '' ? null : options.storeRoot;
    const stories = options.stories ?? (await StoryStores.open(root));
    const appConfig = options.appConfig ?? (root === null ? ServerConfig.inMemory() : await ServerConfig.open(root));

    const runtimes = await StoryRuntimes.open({
        stories,
        config: appConfig,
        chat,
        defaultModel,
        engineConfig,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        ...(options.harnessRoot === null ? {} : { harnessRoot: options.harnessRoot ?? root ?? undefined }),
        ...(options.onCommit === undefined ? {} : { onCommit: options.onCommit })
    });

    return buildStorylineRuntime({
        ...options,
        store: appConfig.book,
        runtimes,
        config: appConfig,
        engineConfig
    });
}

// ---------------------------------------------------------------------------
// The built UI (U-12: the dashboard is a CLIENT of this server, never a dependency)
// ---------------------------------------------------------------------------

/** The handful of types a `dist/` bundle needs; anything else ships as `application/octet-stream`. */
const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.map': 'application/json'
};

/**
 * Serves `staticRoot` at `/`, with the SPA fallback a client-routed dashboard needs (any extension-less
 * GET is the app shell). Deliberately tiny: no caching layer, no compression — the gateway in front of
 * this process owns both, and an in-memory cache here would be a second source of truth about `dist/`.
 */
function mountStatic(app: Hono, staticRoot: string): void {
    const serveFile = async (relative: string): Promise<Response | undefined> => {
        const target = path.join(staticRoot, relative);

        // Path escape: `..` in a URL must not read outside `dist/`.
        if (!target.startsWith(staticRoot)) return undefined;

        try {
            const body = await readFile(target);
            const type = MIME_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream';

            // `Uint8Array` rather than the Buffer itself: it is unambiguously a `BodyInit` member in both
            // the DOM and the node type sets, and it copies nothing (Buffer already IS one).
            return new Response(new Uint8Array(body), { status: 200, headers: { 'content-type': type } });
        } catch {
            return undefined;
        }
    };

    app.get('/*', async (c) => {
        const requested = decodeURIComponent(new URL(c.req.url).pathname);
        const direct = await serveFile(requested === '/' ? 'index.html' : requested.replace(/^\//, ''));

        if (direct !== undefined) return direct;

        // Extension-less paths are client routes; a miss on a real asset is a real 404.
        if (path.extname(requested) !== '') {
            return c.json({ error: `${requested} is not in the built dashboard.` }, 404);
        }

        const shell = await serveFile('index.html');

        if (shell === undefined) {
            return c.json(
                { error: 'the dashboard is not built — run `yarn build`, or use `yarn dev` for the Vite dev server.' },
                404
            );
        }

        return shell;
    });
}

// ---------------------------------------------------------------------------
// The listener
// ---------------------------------------------------------------------------

export type StorylineServerOptions = StorylineRuntimeOptions &
    StorylineOpenOptions & {
        port?: number;
        host?: string;
        /** The built UI to serve at `/`, or `null`/undefined for an API-only server. */
        staticRoot?: string | null;
    };

export interface StorylineServerHandle {
    /** The port ACTUALLY bound — what `--port 0` and every test read back. */
    port: number;
    host: string;
    app: Hono;
    /** S-RUNTIME: the APP book (`<root>/server/`) when a workspace was opened; the one book otherwise. */
    store: Store;
    /** S-RUNTIME: the loop is the coordinator's router — `runtimes` reaches each Story's own pieces. */
    engine: StoryLoop;
    runtimes: StoryRuntimes;
    defaultModel: string;
    /** Stops the sweep, closes the listener, flushes every book (L-3: the journal carries the rest). */
    close: () => Promise<void>;
}

/** One listener per process. `port: 0` is the OS's choice, which is why the handle reports it. */
export async function startStorylineServer(options: StorylineServerOptions = {}): Promise<StorylineServerHandle> {
    // S-RUNTIME: a server opened on a WORKSPACE (a store root, or an embed's own registry and app book) goes
    // through `openStorylineRuntime`, because each Story's knowledge projection has to be loaded from disk. A
    // server on one injected book keeps the synchronous shape it always had.
    const runtime =
        options.runtimes !== undefined ||
        options.stories !== undefined ||
        options.appConfig !== undefined ||
        options.storeRoot !== undefined
            ? await openStorylineRuntime(options)
            : buildStorylineRuntime(options);
    const host = options.host ?? '127.0.0.1';
    const requestedPort = options.port ?? 0;

    if (options.staticRoot) mountStatic(runtime.app, options.staticRoot);

    // L-1: the loop is started with the server, and stopping it is the first thing the shutdown does, so
    // no sweep is mid-commit when the listener goes away. The coordinator starts every Story at once and
    // owns the one sweep timer (S-5), which is why this is one call and not one per book.
    runtime.engine.start();

    const server = serve({ fetch: runtime.app.fetch, port: requestedPort, hostname: host });

    try {
        // The bind is async; waiting for `listening` (or the first `error`) is what turns a port clash or
        // a privileged port into a startup message rather than a half-booted server.
        await new Promise<void>((resolve, reject) => {
            server.once('listening', () => resolve());
            server.once('error', (error) => reject(error));
        });
    } catch (error) {
        // A failed bind means the workspace is thrown away: every Story's files are open, and leaving them
        // would leak a persist timer per book for the life of the process.
        await runtime.runtimes.close();

        throw error;
    }

    const address = server.address() as AddressInfo | null;
    const port = address?.port ?? requestedPort;

    return {
        port,
        host,
        app: runtime.app,
        store: runtime.store,
        engine: runtime.engine,
        runtimes: runtime.runtimes,
        defaultModel: runtime.defaultModel,
        async close() {
            // L-1 then L-3: stop scheduling, stop taking requests, and only then let in-flight work land and
            // flush. `StoryRuntimes.close()` is the old shutdown order (settle → dispose the harness → close
            // the projection → flush the book), applied to every Story, and it closes the app book last.
            runtime.runtimes.stop();

            await new Promise<void>((resolve) => {
                server.close(() => resolve());
            });

            await runtime.runtimes.close();
        }
    };
}
