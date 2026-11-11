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
// WHY THE STORE IS OPENED HERE AND NOT IN `api/server.ts`: `Store.load` is async and `storeRoot` is a
// config decision (W1's two files are the Author's book). Keeping the await on this side means
// `buildStorylineRuntime` stays synchronous and testable, and the failure mode of a corrupt snapshot
// surfaces as a startup error rather than a 500 on the first request (L-3's restart guarantee is about
// the rows, not about guessing where they are).
import { resolveServerConfig } from './config';
import { Store } from './store/store';
import { buildStorylineRuntime, startStorylineServer } from './api/server';
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
    /** Where `store.json` + `journal.jsonl` live; `undefined` uses the config chain, `null` forces memory. */
    storeRoot?: string | null;
    /** Passed through to the loop; an embedding host usually keeps `autoSweep` off until it is ready. */
    engineConfig?: LoopEngineConfig;
}

/**
 * Builds the app WITHOUT listening: open the book, seed §8.6's assistant harness, wire the engines, mount
 * the route table at `/v1/storyline`. The handle carries `engine`, so a host can start and stop the loop
 * on its own terms (L-1) and close the book on shutdown.
 */
export async function createStorylineApp(options: CreateStorylineAppOptions = {}): Promise<StorylineRuntime> {
    const storeRoot =
        options.storeRoot === undefined ? resolveServerConfig({ env: options.env }).storeRoot : options.storeRoot;
    const store = options.store ?? (await openStore(storeRoot));

    return buildStorylineRuntime({ ...options, store });
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
 * The full boot: config → book → runtime → listener. `port`/`host`/`staticRoot` default through
 * `resolveServerConfig`, so the CLI can pass its parsed flags straight through and the precedence chain
 * (flag → `STORYLINE_*` env → default) is resolved in exactly one place.
 */
export async function bootStorylineServer(options: BootStorylineOptions = {}): Promise<StorylineServerHandle> {
    const resolved: StorylineServerConfig = resolveServerConfig({ env: options.env });

    // `null` is a MEANINGFUL value here, so `??` is the wrong operator: W9's in-memory switch
    // (`--store-root ""` / `STORYLINE_STORE_ROOT=`) resolves to `null` upstream, and `null ?? default`
    // would silently open the DURABLE book anyway — the banner would promise "no book behind this run"
    // while the last run's Stories were still on the wall. Only `undefined` means "the caller did not say".
    const storeRoot = options.storeRoot === undefined ? resolved.storeRoot : options.storeRoot;
    const store = options.store ?? (await openStore(storeRoot));

    return startStorylineServer({
        ...options,
        store,
        port: options.port ?? resolved.port,
        host: options.host ?? resolved.host,
        // An explicit `null` means "API only" and must not fall through to the `dist/` probe.
        staticRoot: options.staticRoot === undefined ? resolved.staticRoot : options.staticRoot
    });
}

/**
 * The env-only boot, for a host that wants a live server from the ENVIRONMENT alone — a container entry or
 * an embedding host that calls `main()` instead of going through the CLI. The CLI owns flag parsing and the
 * startup banner; this is the shortest path, and the one with no flags to get wrong.
 */
export async function main(): Promise<StorylineServerHandle> {
    return bootStorylineServer();
}
