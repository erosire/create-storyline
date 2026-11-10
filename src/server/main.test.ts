// The boot entry's REPORTED configuration — one rule, stated once: the root handed to
// the gateway as `variables.root` is the root `config.databaseRoot` reports.
//
// WHY THIS FILE EXISTS. The banner in `runCli` prints `server.config.databaseRoot`
// (./main.ts:326). The entry used to hand the gateway
// `options.databaseRoot ?? resolved.databaseRoot` while returning the UNRESOLVED
// `resolved` inside its own config, so an in-memory run (`--database-root ""`, or a
// caller passing `null`) booted with no persistence and still printed
// `<package>/temporary/harness` — a directory that was never touched. These boots pin
// both directions of the fix; `port: 0` keeps every one of them off the shared
// gateway's 5000, and no request is made, so the lazy per-root runtime (./service.ts)
// is never built and nothing is written to disk.
import { afterAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { DEFAULT_CHAIN_DEPTH, DEFAULT_CHAIN_RULE, DEFAULT_DATABASE_DIRECTORY, packageRootOf } from './config';
import { startStorylineServer, type StartStorylineOptions, type StorylineServer } from './main';

const SETTINGS = { baseURL: 'http://127.0.0.1:1/v1', apiKey: '', model: 'story/test-model' };
const DEFAULTS = { baseURL: SETTINGS.baseURL, model: SETTINGS.model, hasApiKey: false };

// The boot options that make every value explicit: no developer shell involved, and no
// dependence on whether a `dist/` build happens to exist.
const BOOT: StartStorylineOptions = {
    port: 0,
    env: {},
    flags: { noStatic: true, help: false },
    settings: SETTINGS,
    defaults: DEFAULTS
};

describe('startStorylineServer configuration report', () => {
    const servers: StorylineServer[] = [];

    /** Boots one discovery-scoped gateway and remembers it for teardown. */
    const boot = async (options: StartStorylineOptions = {}): Promise<StorylineServer> => {
        const server = await startStorylineServer({ ...BOOT, ...options });

        servers.push(server);

        return server;
    };

    afterAll(async () => {
        for (const server of servers) await server.close();
    });

    it('reports the in-memory root it actually booted with, not the resolved default', async () => {
        // `null` is the harness's documented "no persistence" value, and it is exactly
        // what the endpoint handlers receive as their storage boundary.
        const inMemory = await boot({ databaseRoot: null });

        expect(inMemory.config.databaseRoot).toBeNull();

        // The value the resolver WOULD have used — the sentence this fix removes from
        // the banner, and what the same entry still reports when nobody names a root.
        const defaulted = await boot();

        expect(defaulted.config.databaseRoot).toBe(path.join(packageRootOf(), DEFAULT_DATABASE_DIRECTORY));
    });

    it('reports an explicit durable root verbatim', async () => {
        const durable = await boot({ databaseRoot: 'Temp/t5/durable-root' });

        expect(durable.config.databaseRoot).toBe('Temp/t5/durable-root');
    });

    it('reports the review chain the process actually runs', async () => {
        // R-C's operator surface: the banner prints `config.chain`, so what a boot reports has
        // to be what the sessions it serves will do — the default circle, or the off switch,
        // read from the environment THIS boot was given rather than the developer's shell.
        const defaulted = await boot({ databaseRoot: null });

        expect(defaulted.config.chain).toEqual({
            enabled: true,
            next: { editor: 'writer', writer: 'reader', reader: 'editor' },
            maxDepth: DEFAULT_CHAIN_DEPTH,
            rule: DEFAULT_CHAIN_RULE
        });

        const capped = await boot({ databaseRoot: null, env: { STORYLINE_CHAIN_DEPTH: '1' } });

        expect(capped.config.chain).toEqual({
            enabled: true,
            next: { editor: 'writer', writer: 'reader', reader: 'editor' },
            maxDepth: 1,
            rule: DEFAULT_CHAIN_RULE
        });

        const off = await boot({ databaseRoot: null, env: { STORYLINE_CHAIN: 'off', STORYLINE_CHAIN_DEPTH: '1' } });

        expect(off.config.chain).toEqual({ enabled: false, next: {}, maxDepth: 1, rule: '' });
    });
});
