// ONE STORYLINE RUNTIME PER STORE ROOT — the service cache.
//
// WHY THIS IS ITS OWN MODULE: the service route owns no request logic — it forwards a Request
// into the Hono app — but it DOES own the lifecycle of the runtime it builds. Keeping the cache
// here lets the route stay a thin forwarder and lets tests exercise the root rules with an
// injected factory, without opening real stores or starting a sweep.
//
// WHY THE KEY IS THE RESOLVED ROOT: a second runtime on one book would be a second writer on the
// same `store.json`/`journal.jsonl` (L-3: the rows are the state). `storeRoot: undefined` is not
// an opaque third store: it lets `createStorylineApp` resolve Storyline's own config default, so
// a warm-up that omitted the root and a request that spells that same default (or the same
// directory relative vs absolute, or with `.`/`..`) MUST share one runtime. Canonicalisation is
// purely lexical (`path.resolve`), deliberately touching no store: identity is needed before the
// directory exists on a first boot, and a `stat`/`realpath` would reach into the book just to
// answer a cache lookup. Two SYMLINK spellings of one directory stay distinct — resolving them
// would need the filesystem probe this cache must not do.
import path from 'node:path';
import { packageRootOf, resolveStoreRoot } from '../../config';
import type { StorylineRuntime } from '../../api/server';

/** Everything the cache needs to key and construct one Storyline runtime. */
export type StorylineRuntimeBoot = {
    /** The book location; `undefined` lets `createStorylineApp` resolve its config default. */
    storeRoot: string | null | undefined;
};

/** A constructor injection point so the cache rule is testable without a real book. */
export type StorylineRuntimeFactory = (boot: StorylineRuntimeBoot) => Promise<StorylineRuntime>;

export type StorylineRuntimeCache = {
    /** Reuse the runtime for this root; a failed boot is forgotten so the next request retries. */
    runtimeFor: (boot: StorylineRuntimeBoot) => Promise<StorylineRuntime>;
    /**
     * Stop every cached loop, close its book/knowledge store and forget the entries. The service
     * route does not call this on a normal process exit (the process owns the files), but tests
     * and an embedding host that mounts/unmounts the route need a deterministic shutdown.
     */
    dispose: () => Promise<void>;
};

/** One cache entry: the in-flight/open runtime for one resolved root. */
type CacheEntry = {
    runtime: Promise<StorylineRuntime>;
};

/**
 * The resolved root this cache keys on — the SAME root the factory will open.
 *
 * `null` is the documented in-memory book (`Store.empty()`), distinct from every path.
 * `undefined` is delegated to the SAME root-resolution helper the app boundary uses
 * (`resolveStoreRoot` via `createStorylineApp` in ../../main.ts), so the cache and the book it
 * guards cannot disagree about what "the default" is.
 */
const rootKeyOf = (storeRoot: string | null | undefined): string | null => {
    if (storeRoot === null) return null;

    const resolved =
        storeRoot === undefined ? resolveStoreRoot({}, process.env, packageRootOf()) : storeRoot;

    return resolved === null ? null : path.resolve(resolved);
};

/** The cache/error label: memory is not a path; every other key is the resolved root. */
const keyOf = (storeRoot: string | null | undefined): string => rootKeyOf(storeRoot) ?? '<memory>';

/**
 * Builds an isolated cache over `factory` (the service route supplies the real
 * `createStorylineApp` wrapper; a test supplies a stub).
 */
export const createStorylineRuntimeCache = (
    factory: StorylineRuntimeFactory
): StorylineRuntimeCache => {
    const entries = new Map<string, CacheEntry>();

    const runtimeFor = (boot: StorylineRuntimeBoot): Promise<StorylineRuntime> => {
        const key = keyOf(boot.storeRoot);
        const existing = entries.get(key);

        if (existing !== undefined) return existing.runtime;

        // The factory receives the RAW boot: `createStorylineApp` resolves its own default when
        // `storeRoot` is absent, and path spelling is preserved end to end (only the CACHE KEY is
        // canonicalised above), so opening the book behaves exactly as the host asked.
        const runtime = factory(boot);

        entries.set(key, { runtime });

        // A failed open must not poison the cache: forget THIS entry (not a newer one) so the
        // next request retries the boot.
        runtime.catch(() => {
            if (entries.get(key)?.runtime === runtime) entries.delete(key);
        });

        return runtime;
    };

    const dispose = async (): Promise<void> => {
        const cached = [...entries.values()];

        entries.clear();

        // A failed boot has no runtime and no book to close; swallow only that case so one bad
        // root cannot keep the rest of the cache from being released.
        await Promise.allSettled(
            cached.map(async ({ runtime }) => {
                const opened = await runtime;

                opened.engine.stop();
                opened.executor?.harness?.dispose?.();
                await opened.store.close();
                await opened.knowledge.close();
            })
        );
    };

    return { runtimeFor, dispose };
};
