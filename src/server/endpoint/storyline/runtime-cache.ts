// ONE STORYLINE RUNTIME PER (STORE ROOT, HARNESS BOOT CONFIGURATION) — the service cache.
//
// WHY THIS IS ITS OWN MODULE: the service route owns no request logic — it forwards a Request
// into the Hono app — but it DOES own the lifecycle of the runtime it builds. Keeping the cache
// here lets the route stay a thin forwarder and lets tests exercise the conflict rule with an
// injected factory, without opening real stores or starting a sweep.
//
// THE CONFLICT RULE (R5): the first request for a root decides the harness catalogue/plugins/
// toolbox for the life of the process, because a second runtime on the same root would be a
// second writer on the same `store.json`/`journal.jsonl` (L-3: the rows are the state). A later
// request whose `variables.harness` differs must fail loudly instead of silently reusing the
// first runtime and hiding the host's configuration. Identity is `harnessBootSignature` over the
// RAW configuration (the same value the host passes), because resolution compiles fresh preset
// factories each time and would make two equivalent declarations look different.
//
// `undefined` means Storyline's explicit default and is compared as that default, so an
// unconfigured warm-up followed by a request that spells out the shipped catalogue is NOT a
// conflict — while an explicit `{}` (the harness zero floor) is. Configuration is fixed per
// process per root; a host that needs a different catalogue restarts the gateway (or mounts it
// with its configuration in place from the first request).
//
// THE ROOT KEY IS THE RESOLVED ROOT, NOT THE RAW SPELLING. `storeRoot: undefined` is not an
// opaque third store: it lets `createStorylineApp` resolve Storyline's own config default, so a
// warm-up that omitted the root and a request that spells that same default (or the same
// directory relative vs absolute, or with `.`/`..`) MUST share one runtime. Keying the raw
// value made them two entries and therefore two writers on one `store.json`/`journal.jsonl`.
// Canonicalisation is purely lexical (`path.resolve`), deliberately touching no store: identity
// is needed before the directory exists on a first boot, and a `stat`/`realpath` would reach into
// the book just to answer a cache lookup. That also means two SYMLINK spellings of one directory
// stay distinct — resolving them would need the filesystem probe this cache must not do.
import path from 'node:path';
import { harnessBootSignature } from '@underload/harness/server';
import type { HarnessBootConfiguration } from '@underload/harness/server';
import { STORYLINE_HARNESS_CONFIGURATION } from '../../harness-config';
import { packageRootOf, resolveStoreRoot } from '../../config';
import type { StorylineRuntime } from '../../api/server';

/** Everything the cache needs to key and construct one Storyline runtime. */
export type StorylineRuntimeBoot = {
    /** The book location; `undefined` lets `createStorylineApp` resolve its config default. */
    storeRoot: string | null | undefined;
    /** Omitted = Storyline's shipped configuration; `{}` = the harness zero floor. */
    harness?: HarnessBootConfiguration;
};

/** A constructor injection point so the cache rule is testable without a real book. */
export type StorylineRuntimeFactory = (boot: StorylineRuntimeBoot) => Promise<StorylineRuntime>;

export type StorylineRuntimeCache = {
    /** Reuse the runtime for this root when the configuration matches; reject when it differs. */
    runtimeFor: (boot: StorylineRuntimeBoot) => Promise<StorylineRuntime>;
    /**
     * Stop every cached loop, close its book/knowledge store and forget the entries. The service
     * route does not call this on a normal process exit (the process owns the files), but tests
     * and an embedding host that mounts/unmounts the route need a deterministic shutdown.
     */
    dispose: () => Promise<void>;
};

/** One cache entry: the in-flight/open runtime and the signature that produced it. */
type CacheEntry = {
    signature: string;
    runtime: Promise<StorylineRuntime>;
};

/**
 * The resolved root this cache keys on — the SAME root the factory will open.
 *
 * `null` is the documented in-memory book (`Store.empty()`), distinct from every path.
 * `undefined` is delegated to the SAME root-resolution helper the app boundary uses
 * (`resolveStoreRoot` via `createStorylineApp` in ../../main.ts), so the cache and the book it
 * guards cannot disagree about what "the default" is. Using that helper rather than
 * `resolveServerConfig` is deliberate: the cache needs the store root only, and must not start
 * failing requests because an unrelated `STORYLINE_PORT`/`STORYLINE_STATIC_ROOT` value is
 * malformed.
 *
 * The path is then canonicalised lexically with `path.resolve`, which normalises separators,
 * `.`/`..` and relative-vs-absolute spellings of the same directory. No filesystem call is made:
 * canonicalising identity must not create, read or probe the store (first boot has no directory
 * yet), so symlink aliases remain separate keys.
 */
const rootKeyOf = (storeRoot: string | null | undefined): string | null => {
    if (storeRoot === null) return null;

    const resolved =
        storeRoot === undefined ? resolveStoreRoot({}, process.env, packageRootOf()) : storeRoot;

    return resolved === null ? null : path.resolve(resolved);
};

/** The cache/error label: memory is not a path; every other key is the resolved root. */
const keyOf = (storeRoot: string | null | undefined): string => rootKeyOf(storeRoot) ?? '<memory>';

/** The effective signature: an absent configuration means Storyline's default, not "empty". */
const signatureOf = (harness: HarnessBootConfiguration | undefined): string =>
    harnessBootSignature(harness ?? STORYLINE_HARNESS_CONFIGURATION);

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
        const signature = signatureOf(boot.harness);
        const existing = entries.get(key);

        if (existing !== undefined) {
            if (existing.signature !== signature) {
                throw new Error(
                    `The Storyline runtime for "${key}" was already created with a DIFFERENT harness boot configuration. ` +
                        'The first request decides the harness catalogue, plugins and toolbox for a store root, so pass the SAME `variables.harness` to every request under that root (or restart the gateway with the new configuration).'
                );
            }

            return existing.runtime;
        }

        // The factory receives the RAW boot: `createStorylineApp` resolves its own default when
        // `storeRoot` is absent, and path spelling is preserved end to end (only the CACHE KEY is
        // canonicalised above), so opening the book behaves exactly as the host asked.
        const runtime = factory(boot);

        entries.set(key, { signature, runtime });

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
                await opened.store.close();
                await opened.knowledge.close();
            })
        );
    };

    return { runtimeFor, dispose };
};
