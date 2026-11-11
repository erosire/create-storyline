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
import { Store } from '../store/store';
import { ASSISTANT_ROLE, ASSISTANT_TEMPLATE, createStorylineRoutes } from './routes';
import type { ChatClient } from '../llm/client';
import type { ToolRuntime } from '../run/types';
import type { RunExecutor as RunExecutorType } from '../run/executor';
import type { LoopEngineConfig } from '../loop/types';
import type { Template } from '../../shared/types';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// The provider seam (see the file header for why this is not `config.ts`)
// ---------------------------------------------------------------------------

export const PROVIDER_BASE_URL_ENVIRONMENT = 'STORYLINE_PROVIDER_BASE_URL';
export const PROVIDER_MODEL_ENVIRONMENT = 'STORYLINE_PROVIDER_MODEL';
export const PROVIDER_API_KEY_ENVIRONMENT = 'STORYLINE_PROVIDER_API_KEY';

/** The §8.5 web-tool fetch is behind the same transport, so one base URL covers it. */
export const DEFAULT_PROVIDER_BASE_URL = 'http://localhost:5500/providers/private/v1';

/** Any OpenAI-compatible relay name; the local dev relay serves a single default model. */
export const DEFAULT_PROVIDER_MODEL = 'local/basalt';

/** Loop-level env overrides for the sweep (S-5's ceiling, L-1's cadence, S-4a's lease). */
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
    /** The book. Defaults to `Store.empty()`; the CLI passes `Store.load(storeRoot)`. */
    store?: Store;
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
    /** Passed to the tool runtime so the §8.5 web tools never touch the network in tests. */
    fetchImpl?: typeof fetch;
    /** Skips the §8.6 template seed (a test that asserts the catalogue is exactly the built-ins). */
    noAssistantSeed?: boolean;
}

export interface StorylineRuntime {
    app: Hono;
    store: Store;
    criteria: CriteriaEngine;
    digest: DigestBuilder;
    executor: RunExecutorType;
    engine: LoopEngine;
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
export function buildStorylineRuntime(options: StorylineRuntimeOptions = {}): StorylineRuntime {
    const env = options.env ?? process.env;
    const store = options.store ?? Store.empty();
    const criteria = new CriteriaEngine();
    const digest = new DigestBuilder();

    if (options.noAssistantSeed !== true) seedAssistantTemplate(store);

    const baseUrl = text(env[PROVIDER_BASE_URL_ENVIRONMENT]) ?? DEFAULT_PROVIDER_BASE_URL;
    const defaultModel = text(env[PROVIDER_MODEL_ENVIRONMENT]) ?? DEFAULT_PROVIDER_MODEL;
    const apiKey = text(env[PROVIDER_API_KEY_ENVIRONMENT]);
    const chat =
        options.chat ??
        createOpenAICompatClient({ baseUrl, ...(apiKey === undefined ? {} : { apiKey }), model: defaultModel });
    const runtime =
        options.runtime ??
        createToolRuntime(store, options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl });
    const executor = options.executor ?? new RunExecutor({ store, runtime, chat, defaultModel });

    // A started loop sweeps on a timer (L-1); the default here is ON because a server with no sweep is a
    // dashboard that never moves. Tests inject `autoSweep: false` and become the clock.
    const config: LoopEngineConfig = { autoSweep: true, ...options.engineConfig };

    config.globalMaxConcurrent = positiveInt(env[GLOBAL_MAX_CONCURRENT_ENVIRONMENT]) ?? config.globalMaxConcurrent;
    config.sweepIntervalMs = positiveInt(env[SWEEP_INTERVAL_MS_ENVIRONMENT]) ?? config.sweepIntervalMs;
    config.leaseIdleMs = positiveInt(env[LEASE_IDLE_MS_ENVIRONMENT]) ?? config.leaseIdleMs;

    const engine = options.engine ?? new LoopEngine({ store, executor, criteria, digest, config });

    const app = new Hono();

    app.route(
        '/v1/storyline',
        createStorylineRoutes({
            store,
            engine,
            executor,
            criteria,
            digest,
            ...(options.streamDebounceMs === undefined ? {} : { streamDebounceMs: options.streamDebounceMs })
        })
    );

    return { app, store, criteria, digest, executor, engine, defaultModel };
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

export interface StorylineServerOptions extends StorylineRuntimeOptions {
    port?: number;
    host?: string;
    /** The built UI to serve at `/`, or `null`/undefined for an API-only server. */
    staticRoot?: string | null;
}

export interface StorylineServerHandle {
    /** The port ACTUALLY bound — what `--port 0` and every test read back. */
    port: number;
    host: string;
    app: Hono;
    store: Store;
    engine: LoopEngine;
    defaultModel: string;
    /** Stops the sweep, closes the listener, flushes the book (L-3: the journal carries the rest). */
    close: () => Promise<void>;
}

/** One listener per process. `port: 0` is the OS's choice, which is why the handle reports it. */
export async function startStorylineServer(options: StorylineServerOptions = {}): Promise<StorylineServerHandle> {
    const runtime = buildStorylineRuntime(options);
    const host = options.host ?? '127.0.0.1';
    const requestedPort = options.port ?? 0;

    if (options.staticRoot) mountStatic(runtime.app, options.staticRoot);

    // L-1: the loop is started with the server, and stopping it is the first thing the shutdown does, so
    // no sweep is mid-commit when the listener goes away.
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
        runtime.engine.stop();

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
        defaultModel: runtime.defaultModel,
        async close() {
            runtime.engine.stop();

            await new Promise<void>((resolve) => {
                server.close(() => resolve());
            });

            await runtime.store.close();
        }
    };
}
