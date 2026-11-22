// The OpenAPI contract against the route table it documents.
//
// The file is the server's published contract (`src/storyline-server.swagger.yaml`), and this
// suite keeps it honest two ways: the mounted Hono routes and the documented operations must
// be the SAME set, and every `$ref` must resolve. A route added without a swagger entry (or a
// stale entry left behind) fails here instead of drifting until a client notices.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildStorylineRuntime } from './server';
import { Store } from '../store/store';

interface OpenApiDocument {
    openapi: string;
    info: { title: string; version: string; description: string };
    servers: Array<{ url: string; description?: string }>;
    tags: Array<{ name: string; description?: string }>;
    paths: Record<string, Record<string, unknown>>;
    components: {
        parameters: Record<string, unknown>;
        responses: Record<string, unknown>;
        schemas: Record<string, unknown>;
    };
}

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SPEC_PATH = path.join(PACKAGE_ROOT, 'src', 'storyline-server.swagger.yaml');
const DOCUMENT = parse(readFileSync(SPEC_PATH, 'utf8')) as OpenApiDocument;

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];

/** The mounted route set, in the `/v1/storyline/stories/{id}` spelling OpenAPI uses. */
function mountedOperations(): string[] {
    const runtime = buildStorylineRuntime({
        store: Store.empty(),
        engineConfig: { autoSweep: false },
        noAssistantSeed: true,
        env: {}
    });

    return runtime.app.routes
        .filter((route) => route.path.startsWith('/v1/storyline'))
        .map((route) => `${route.method.toUpperCase()} ${route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`)
        .sort();
}

/** The documented operation set, in the same spelling. */
function documentedOperations(): string[] {
    const operations: string[] = [];

    for (const [routePath, item] of Object.entries(DOCUMENT.paths)) {
        for (const method of HTTP_METHODS) {
            if (item[method] !== undefined) operations.push(`${method.toUpperCase()} ${routePath}`);
        }
    }

    return operations.sort();
}

/** Every `$ref` in the document, resolved against the document itself. */
function unresolvedRefs(document: unknown): string[] {
    const refs = new Set<string>();

    const walk = (value: unknown): void => {
        if (Array.isArray(value)) {
            for (const entry of value) walk(entry);

            return;
        }

        if (value === null || typeof value !== 'object') return;

        for (const [key, entry] of Object.entries(value)) {
            if (key === '$ref' && typeof entry === 'string') refs.add(entry);
            else walk(entry);
        }
    };

    walk(document);

    return [...refs].filter((ref) => {
        if (!ref.startsWith('#/')) return true;

        let node: unknown = document;

        for (const part of ref.slice(2).split('/')) {
            if (node === null || typeof node !== 'object') return true;

            node = (node as Record<string, unknown>)[part];

            if (node === undefined) return true;
        }

        return false;
    });
}

describe('the Storyline OpenAPI contract', () => {
    it('is an OpenAPI 3.0 document mounted at the one root the UI dials', () => {
        expect(DOCUMENT.openapi).toBe('3.0.3');
        expect(DOCUMENT.info.title).toBe('Storyline API');
        expect(DOCUMENT.servers[0]?.url).toBe('http://127.0.0.1:5000');
        expect(DOCUMENT.info.description).toContain('/v1/storyline');
    });

    it('documents exactly the routes the server mounts', () => {
        expect(documentedOperations()).toEqual(mountedOperations());
    });

    it('gives every operation an id, a tag, a summary, a description, and at least one response', () => {
        for (const [routePath, item] of Object.entries(DOCUMENT.paths)) {
            for (const method of HTTP_METHODS) {
                const operation = item[method] as
                    | {
                          operationId?: string;
                          tags?: string[];
                          summary?: string;
                          description?: string;
                          responses?: Record<string, unknown>;
                      }
                    | undefined;

                if (operation === undefined) continue;

                expect(operation.operationId, `${method.toUpperCase()} ${routePath} operationId`).toBeTruthy();
                expect(operation.tags?.length, `${method.toUpperCase()} ${routePath} tags`).toBeGreaterThan(0);
                expect(operation.summary, `${method.toUpperCase()} ${routePath} summary`).toBeTruthy();
                expect(operation.description, `${method.toUpperCase()} ${routePath} description`).toBeTruthy();
                expect(Object.keys(operation.responses ?? {}).length, `${method.toUpperCase()} ${routePath} responses`).toBeGreaterThan(0);

                for (const tag of operation.tags ?? []) {
                    expect(
                        DOCUMENT.tags.map((entry) => entry.name),
                        `${method.toUpperCase()} ${routePath} declares an unknown tag ${tag}`
                    ).toContain(tag);
                }
            }
        }
    });

    it('resolves every component reference', () => {
        expect(unresolvedRefs(DOCUMENT)).toEqual([]);
    });
});
