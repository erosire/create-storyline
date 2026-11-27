// The UI/server boundary, enforced instead of remembered.
//
// The dashboard is a CLIENT of the Storyline server. Production code under `src/dashboard/`
// may render shared model types, but it may not import a server module (the server is the
// separate `@underload/storyline` package/repository), import the harness engine, or perform
// network I/O outside `api.ts`. The earlier direct-harness experiment (session and record tool
// calls from the browser bundle) is exactly what this suite prevents from returning: the server
// is the only backend the UI talks to, so one route table owns every Story decision and the
// browser never holds a second vocabulary.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DASHBOARD_ROOT = path.join(PACKAGE_ROOT, 'src', 'dashboard');

/** Every production (not test) file the browser bundle may include. */
function runtimeFiles(): string[] {
    const files: string[] = [];
    const walk = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const full = path.join(directory, entry.name);

            if (entry.isDirectory()) {
                // `testing/` is the test scaffolding (fixtures, client doubles, product-data mocks);
                // it is never part of the browser bundle, so the production boundary does not apply.
                if (entry.name !== 'testing') walk(full);
                continue;
            }

            if (!/\.(ts|tsx)$/.test(entry.name)) continue;
            if (/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) continue;

            files.push(full);
        }
    };

    walk(DASHBOARD_ROOT);

    for (const relative of ['src/App.tsx', 'src/main.tsx']) {
        files.push(path.join(PACKAGE_ROOT, relative));
    }

    return files;
}

const relative = (file: string): string => path.relative(PACKAGE_ROOT, file).split(path.sep).join('/');
const sourceOf = (file: string): string => readFileSync(file, 'utf8');

describe('the dashboard is a server client and nothing else', () => {
    it('never imports a server module or the harness engine', () => {
        const banned =
            /from\s+['"](?:\.\.?\/)+server(?:\/|['"])|from\s+['"]@underload\/(?:harness|storyline)(?:\/[^'"]*)?['"]/;
        const offenders = runtimeFiles().filter((file) => banned.test(sourceOf(file)));

        expect(offenders.map(relative)).toEqual([]);
    });

    it('keeps runtime product data out of the UI: there is no src/shared module', () => {
        // The server owns the phrase catalog/composition, criteria roster, Seed hash, defaults and
        // chapter-entry formatting. The UI may keep type definitions (`src/types.ts`) and test-only
        // mocks (`src/dashboard/testing/`), but a runtime copy in the production tree would be the
        // second source of truth this package must not have.
        expect(existsSync(path.join(PACKAGE_ROOT, 'src', 'shared'))).toBe(false);
    });

    it('performs network I/O in exactly one module', () => {
        const network = /\bfetch\s*\(|new\s+EventSource\s*\(|new\s+WebSocket\s*\(|\bXMLHttpRequest\b|navigator\.sendBeacon/;
        const offenders = runtimeFiles()
            .filter((file) => network.test(sourceOf(file)))
            .map(relative)
            .sort();

        expect(offenders).toEqual(['src/dashboard/api.ts']);
    });

    it('dials the server mount and no other origin', () => {
        const api = sourceOf(path.join(DASHBOARD_ROOT, 'api.ts'));

        expect(api).toContain("export const API_ROOT = '/v1/storyline';");
        expect(api).toContain('fetch(`${API_ROOT}${path}`');
        expect(api).toContain('new EventSource(`${API_ROOT}/stream`)');
    });
});
