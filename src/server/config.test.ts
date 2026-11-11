// Server config — the precedence chain pinned at exact values, with no filesystem touched.
//
// Every assertion injects `env` and `exists`, because the whole value of this module is the
// resolution order (flag -> STORYLINE_* -> default) and a test that read `process.env` would
// pass or fail depending on whose shell it ran in.
import path from 'node:path';

import {
    DEFAULT_HOST,
    DEFAULT_PORT,
    DEFAULT_STATIC_DIRECTORY,
    DEFAULT_STORE_DIRECTORY,
    parsePort,
    resolveServerConfig,
    resolveStoreRoot
} from './config';

// A synthetic package root: nothing here hits the disk, so the absolute path is just a prefix.
const ROOT = path.resolve('/pkg', 'create-storyline');
const NO_ENV: Record<string, string | undefined> = {};
const NO_BUILD: () => boolean = () => false;

describe('server config — defaults', () => {
    it('listens on the gateway port and loopback, and keeps the book under `<pkg>/temporary/storyline`', () => {
        const config = resolveServerConfig({ env: NO_ENV, packageRoot: ROOT, exists: NO_BUILD });

        expect(config).toEqual({
            port: DEFAULT_PORT,
            host: DEFAULT_HOST,
            storeRoot: path.join(ROOT, DEFAULT_STORE_DIRECTORY),
            staticRoot: null,
            flags: { noStatic: false, help: false }
        });

        // The two files W1 writes live inside that one directory, so this path IS the Author's
        // book: one rsync is a backup of the product (P1).
        expect(DEFAULT_STORE_DIRECTORY).toBe('temporary/storyline');
        expect(DEFAULT_PORT).toBe(5000);
        expect(DEFAULT_HOST).toBe('127.0.0.1');
    });

    it('serves `dist/` only once it exists, so a source checkout boots the API instead of 404ing every page (U-12)', () => {
        const distPath = path.join(ROOT, DEFAULT_STATIC_DIRECTORY);
        const built = resolveServerConfig({
            env: NO_ENV,
            packageRoot: ROOT,
            exists: (candidate) => candidate === distPath
        });

        expect(built.staticRoot).toBe(distPath);
    });
});

describe('server config — the precedence chain', () => {
    it('STORYLINE_* environment overrides every default', () => {
        const config = resolveServerConfig({
            env: {
                STORYLINE_PORT: '4599',
                STORYLINE_HOST: '0.0.0.0',
                STORYLINE_STORE_ROOT: '/volumes/book',
                STORYLINE_STATIC_ROOT: '/srv/storyline/dist'
            },
            packageRoot: ROOT,
            exists: NO_BUILD
        });

        expect(config.port).toBe(4599);
        expect(config.host).toBe('0.0.0.0');
        expect(config.storeRoot).toBe('/volumes/book');
        expect(config.staticRoot).toBe('/srv/storyline/dist');
    });

    it('a flag beats the environment, and --no-static beats both (API-only is an explicit operator decision)', () => {
        const env = {
            STORYLINE_PORT: '4599',
            STORYLINE_HOST: '0.0.0.0',
            STORYLINE_STORE_ROOT: '/volumes/book',
            STORYLINE_STATIC_ROOT: '/srv/storyline/dist'
        };

        const config = resolveServerConfig({
            flags: { port: '5050', host: '127.0.0.1', storeRoot: '/local/book', noStatic: true },
            env,
            packageRoot: ROOT,
            exists: () => true
        });

        expect(config.port).toBe(5050);
        expect(config.host).toBe('127.0.0.1');
        expect(config.storeRoot).toBe('/local/book');
        expect(config.staticRoot).toBeNull();
    });

    it('a blank or whitespace value falls through to the default for port and host', () => {
        const config = resolveServerConfig({
            env: { STORYLINE_PORT: '   ', STORYLINE_HOST: '' },
            packageRoot: ROOT,
            exists: NO_BUILD
        });

        expect(config.port).toBe(DEFAULT_PORT);
        expect(config.host).toBe(DEFAULT_HOST);
    });

    it('an explicitly BLANK store root is an in-memory run, not a directory called ""', () => {
        // The difference between "unset" and "set to nothing" is the whole switch here: `null`
        // is what the server turns into `Store.empty()` (W1), and `''` would be a bad path.
        expect(
            resolveServerConfig({ env: { STORYLINE_STORE_ROOT: '' }, packageRoot: ROOT, exists: NO_BUILD }).storeRoot
        ).toBeNull();
        expect(
            resolveServerConfig({ flags: { storeRoot: '   ' }, env: NO_ENV, packageRoot: ROOT, exists: NO_BUILD })
                .storeRoot
        ).toBeNull();

        // Unset takes the default directory, and the environment beats that but loses to a flag.
        expect(resolveStoreRoot({}, { STORYLINE_STORE_ROOT: '/volumes/book' }, ROOT)).toBe('/volumes/book');
        expect(resolveStoreRoot({ storeRoot: '/flagged' }, { STORYLINE_STORE_ROOT: '/volumes/book' }, ROOT)).toBe(
            '/flagged'
        );
        expect(resolveStoreRoot({ storeRoot: '' }, { STORYLINE_STORE_ROOT: '/volumes/book' }, ROOT)).toBeNull();
    });
});

describe('server config — parsePort', () => {
    it('accepts 0 (OS-assigned) through 65535', () => {
        expect(parsePort(undefined, '--port')).toBe(DEFAULT_PORT);
        expect(parsePort('0', '--port')).toBe(0);
        expect(parsePort('65535', '--port')).toBe(65535);
    });

    it('refuses anything else with a startup error naming the source and the value', () => {
        expect(() => parsePort('abc', '--port')).toThrow('--port must be an integer between 0 and 65535 (got "abc").');
        expect(() => parsePort('65536', 'STORYLINE_PORT')).toThrow(
            'STORYLINE_PORT must be an integer between 0 and 65535 (got "65536").'
        );
        expect(() => parsePort('-1', '--port')).toThrow('--port');
    });
});
