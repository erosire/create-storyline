// The service runtime cache: one runtime per resolved store root.
//
// These tests use an injected factory so they exercise the root rules without opening a real
// book or starting a sweep. Storyline owns its agent/session control, so the cache has exactly
// one boot input: the book location.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStorylineRuntimeCache } from './runtime-cache';
import { STORE_ROOT_ENVIRONMENT, packageRootOf, resolveStoreRoot } from '../../config';
import type { StorylineRuntime } from '../../api/server';

// A minimal runtime stand-in: the cache only touches lifecycle members on `dispose`.
const fakeRuntime = (): StorylineRuntime & { stopped: boolean; closed: boolean } => {
    const runtime = {
        stopped: false,
        closed: false,
        engine: {
            stop: () => {
                runtime.stopped = true;
            }
        },
        store: {
            close: async () => {
                runtime.closed = true;
            }
        },
        knowledge: {
            close: async () => undefined
        }
    };

    return runtime as unknown as StorylineRuntime & { stopped: boolean; closed: boolean };
};

describe('createStorylineRuntimeCache', () => {
    it('keys different roots separately and reuses one root', async () => {
        const built: string[] = [];
        const cache = createStorylineRuntimeCache(async ({ storeRoot }) => {
            built.push(storeRoot ?? '<default>');
            return fakeRuntime();
        });

        const first = await cache.runtimeFor({ storeRoot: '/books/a' });
        const second = await cache.runtimeFor({ storeRoot: '/books/b' });
        const again = await cache.runtimeFor({ storeRoot: '/books/a' });

        expect(built).toEqual(['/books/a', '/books/b']);
        expect(first).not.toBe(second);
        expect(again).toBe(first);
    });

    it('treats an omitted root and its resolved default as one runtime', async () => {
        // The default is environment-sensitive, so pin the documented no-env branch for this
        // test and restore it afterwards. `resolveStoreRoot` is the SAME helper
        // `createStorylineApp` uses, so the expected path cannot drift from the factory's.
        const saved = process.env[STORE_ROOT_ENVIRONMENT];
        delete process.env[STORE_ROOT_ENVIRONMENT];

        try {
            const defaultRoot = resolveStoreRoot({}, process.env, packageRootOf());

            // A blank/absent env resolves to the package-relative directory by contract; the
            // throw keeps the narrowing honest (and is not an assertion the test can skip).
            if (defaultRoot === null) throw new Error('the default store root must resolve to a path');

            const built: string[] = [];
            const cache = createStorylineRuntimeCache(async ({ storeRoot }) => {
                built.push(storeRoot === null ? '<memory>' : (storeRoot ?? '<default>'));
                return fakeRuntime();
            });

            const omitted = await cache.runtimeFor({ storeRoot: undefined });
            const explicit = await cache.runtimeFor({ storeRoot: defaultRoot });
            const canonical = await cache.runtimeFor({
                storeRoot: `${defaultRoot}/../${path.basename(defaultRoot)}`
            });
            // The documented in-memory book is never folded into the default directory.
            const memory = await cache.runtimeFor({ storeRoot: null });

            expect(defaultRoot).toBe(path.join(packageRootOf(), 'temporary/storyline'));
            expect(explicit).toBe(omitted);
            expect(canonical).toBe(omitted);
            expect(memory).not.toBe(omitted);
            // One durable boot, and it received the host's raw omission — the cache canonicalises
            // only its key, never what the book opener is asked to load.
            expect(built).toEqual(['<default>', '<memory>']);
        } finally {
            if (saved === undefined) delete process.env[STORE_ROOT_ENVIRONMENT];
            else process.env[STORE_ROOT_ENVIRONMENT] = saved;
        }
    });

    it('canonicalises relative, absolute and dot-segment spellings of one root', async () => {
        const relative = 'books/relative-book';
        const absolute = path.resolve(relative);
        const dotted = `${absolute}/../${path.basename(absolute)}`;
        const built: string[] = [];
        const runtime = fakeRuntime();
        const cache = createStorylineRuntimeCache(async ({ storeRoot }) => {
            built.push(storeRoot ?? '<default>');
            return runtime;
        });

        const first = await cache.runtimeFor({ storeRoot: relative });
        const second = await cache.runtimeFor({ storeRoot: absolute });
        const third = await cache.runtimeFor({ storeRoot: dotted });

        expect(second).toBe(first);
        expect(third).toBe(first);
        expect(built).toEqual([relative]);
    });

    it('forgets a failed open so the next request retries the boot', async () => {
        let calls = 0;
        const cache = createStorylineRuntimeCache(async () => {
            calls += 1;

            if (calls === 1) throw new Error('the book is corrupt');

            return fakeRuntime();
        });

        await expect(cache.runtimeFor({ storeRoot: '/books/a' })).rejects.toThrow('the book is corrupt');
        await expect(cache.runtimeFor({ storeRoot: '/books/a' })).resolves.toBeDefined();
        expect(calls).toBe(2);
    });

    it('dispose stops and closes every open runtime, then empties the cache', async () => {
        const built: Array<ReturnType<typeof fakeRuntime>> = [];
        const cache = createStorylineRuntimeCache(async () => {
            const runtime = fakeRuntime();
            built.push(runtime);

            return runtime;
        });

        await cache.runtimeFor({ storeRoot: '/books/a' });
        await cache.runtimeFor({ storeRoot: '/books/b' });
        await cache.dispose();

        expect(built.map((runtime) => [runtime.stopped, runtime.closed])).toEqual([
            [true, true],
            [true, true]
        ]);

        // The cache is empty again, so a boot after dispose constructs a fresh runtime.
        const after = await cache.runtimeFor({ storeRoot: '/books/a' });

        expect(built).toHaveLength(3);
        expect(after).toBe(built[2]);
        expect(after).not.toBe(built[0]);
        expect(built[2]?.stopped).toBe(false);
    });
});
