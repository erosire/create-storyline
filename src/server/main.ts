// §10 / W9-W13 — the composition and mount entry for the Storyline server (T7).
//
// WHAT THIS FILE IS FOR: one place that turns a RESOLVED CONFIG into a running thing, so there are
// exactly two ways to bring the server up and they share every step:
//
//   * `createStorylineApp` — the mount entry. An embedding host (the @underload/service gateway, which is
//     what `vite.config.ts`'s `/v1/storyline` dev proxy points at) opens the book, gets back the Hono app
//     plus the engine handle, and mounts it in ITS listener. Nothing listens here and nothing sweeps yet,
//     because the host owns the process lifecycle (L-1: the loop is started, not auto-started).
//   * `bootStorylineServer` — the standalone entry the CLI calls: the same app plus its own listener.
//
// WHY THE WORKSPACE IS OPENED HERE AND NOT IN `api/server.ts`: opening it is async (a durable knowledge
// projection has to be loaded per Story) and `storeRoot` is a config decision (W1's two files are the
// Author's book). Keeping the awaits on this side means `buildStorylineRuntime` stays synchronous and
// testable, and the failure mode of a corrupt snapshot — or of a root still in the pre-Story flat layout —
// surfaces as a startup error rather than a 500 on the first request (L-3's restart guarantee is about the
// rows, not about guessing where they are).
import { resolveServerConfig } from './config';
import { Store } from './store/store';
import { StoryKnowledge } from './knowledge';
import { StoryThreadLog } from './run/thread-log';
import { buildStorylineRuntime, openStorylineRuntime, startStorylineServer } from './api/server';
import type { StorylineServerConfig } from './config';
import type { StorylineRuntime, StorylineRuntimeOptions, StorylineServerHandle } from './api/server';
import type { LoopEngineConfig } from './loop/types';

// ---------------------------------------------------------------------------
// The book
// ---------------------------------------------------------------------------

/**
 * Opens the store the config names. `null` is the deliberate in-memory case
 * (`STORYLINE_STORE_ROOT=` / `--store-root ""`): `Store.empty()` never persists, which is what a demo or
 * a disposable run wants. A missing directory is not an error — `Store.load` treats an absent snapshot as
 * the first boot and the first persist creates the files (L-3).
 */
export async function openStore(storeRoot: string | null): Promise<Store> {
    return storeRoot === null ? Store.empty() : Store.load(storeRoot);
}

// ---------------------------------------------------------------------------
// The mount entry
// ---------------------------------------------------------------------------

export interface CreateStorylineAppOptions extends StorylineRuntimeOptions {
    /**
     * The workspace root: `<root>/server/` for app configuration and `<root>/stories/<uuid>/` for one book
     * per Story. `undefined` uses the config chain; `null` forces the in-memory workspace.
     */
    storeRoot?: string | null;
    /** Passed through to the loop; an embedding host usually keeps `autoSweep` off until it is ready. */
    engineConfig?: LoopEngineConfig;
}

/**
 * Builds the app WITHOUT listening: open the workspace, seed §8.6's assistant harness, wire the engines,
 * mount the route table at `/v1/storyline`. The handle carries `engine` (the coordinator's router) and
 * `runtimes`, so a host can start and stop the loop on its own terms (L-1) and close every book on shutdown.
 *
 * THREE SHAPES, decided by what the caller hands in — and only one of them is the shipped default:
 *
 *   * `runtimes` — an open coordinator, used as is (a host that owns the books, or a test that built one);
 *   * `store` — one book the caller owns, which stays the whole workspace, with the durable projection and
 *     the retained thread log opened beside `storeRoot` exactly as before;
 *   * neither — the workspace: `<root>/server/` plus `<root>/stories/<uuid>/`, one runtime per Story.
 *
 * The last shape is where a legacy root goes loud: a `<root>/store.json` from before the per-Story layout is
 * refused by the registry's own layout error, because a server that ignored that file would answer requests
 * about Stories it no longer holds. There is no migration, and nothing here guesses.
 */
export async function createStorylineApp(options: CreateStorylineAppOptions = {}): Promise<StorylineRuntime> {
    if (options.runtimes !== undefined)
        return buildStorylineRuntime({
            ...options,
            store: options.store ?? options.runtimes.appConfig.book
        });

    if (options.store !== undefined) {
        const storeRoot =
            options.storeRoot === undefined ? resolveServerConfig({ env: options.env }).storeRoot : options.storeRoot;
        const knowledge = options.knowledge ?? (await StoryKnowledge.open(options.store, storeRoot));
        const threadLog = options.threadLog ?? StoryThreadLog.open(storeRoot);

        return buildStorylineRuntime({ ...options, store: options.store, knowledge, threadLog });
    }

    const storeRoot =
        options.storeRoot === undefined ? resolveServerConfig({ env: options.env }).storeRoot : options.storeRoot;

    return openStorylineRuntime({ ...options, storeRoot, harnessRoot: storeRoot });
}

// ---------------------------------------------------------------------------
// The standalone entry
// ---------------------------------------------------------------------------

export interface BootStorylineOptions extends CreateStorylineAppOptions {
    port?: number;
    host?: string;
    staticRoot?: string | null;
}

/**
 * The full boot: config → workspace → runtimes → listener. `port`/`host`/`staticRoot` default through
 * `resolveServerConfig`, so the CLI can pass its parsed flags straight through and the precedence chain
 * (flag → `STORYLINE_*` env → default) is resolved in exactly one place.
 *
 * The CLI's default boot is a WORKSPACE (`storeRoot`), so each Story gets its own book, loop, executor,
 * knowledge projection and thread log, and an old flat root is refused at startup rather than half-read. A
 * caller that hands in its own `store` keeps the single-book shape — that is what an embed with one book, and
 * every test that wants one durable file, asks for.
 */
export async function bootStorylineServer(options: BootStorylineOptions = {}): Promise<StorylineServerHandle> {
    const resolved: StorylineServerConfig = resolveServerConfig({ env: options.env });

    // `null` is a MEANINGFUL value here, so `??` is the wrong operator: W9's in-memory switch
    // (`--store-root ""` / `STORYLINE_STORE_ROOT=`) resolves to `null` upstream, and `null ?? default`
    // would silently open the DURABLE book anyway — the banner would promise "no book behind this run"
    // while the last run's Stories were still on the wall. Only `undefined` means "the caller did not say".
    const storeRoot = options.storeRoot === undefined ? resolved.storeRoot : options.storeRoot;
    const listener = {
        port: options.port ?? resolved.port,
        host: options.host ?? resolved.host,
        // An explicit `null` means "API only" and must not fall through to the `dist/` probe.
        staticRoot: options.staticRoot === undefined ? resolved.staticRoot : options.staticRoot
    };

    if (options.store === undefined && options.runtimes === undefined)
        return startStorylineServer({ ...options, ...listener, storeRoot, harnessRoot: storeRoot });

    const store = options.store ?? (await openStore(storeRoot));
    const knowledge = options.knowledge ?? (await StoryKnowledge.open(store, storeRoot));
    const threadLog = options.threadLog ?? StoryThreadLog.open(storeRoot);

    return startStorylineServer({ ...options, ...listener, store, knowledge, threadLog });
}

/**
 * The env-only boot, for a host that wants a live server from the ENVIRONMENT alone — a container entry or
 * an embedding host that calls `main()` instead of going through the CLI. The CLI owns flag parsing and the
 * startup banner; this is the shortest path, and the one with no flags to get wrong.
 */
export async function main(): Promise<StorylineServerHandle> {
    return bootStorylineServer();
}
