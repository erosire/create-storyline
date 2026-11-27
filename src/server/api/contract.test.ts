// The OpenAPI contract against the route table it documents.
//
// The file is the server's published contract (`src/storyline-server.swagger.yaml`), and this
// suite keeps it honest three ways: the mounted Hono routes and the documented operations must
// be the SAME set, every `$ref` must resolve, and — since R11 — the documented FIELD SET of the
// receipts the desk reads must be the field set a live response actually answers with. A route
// added without a swagger entry (or a stale entry left behind) fails here instead of drifting
// until a client notices, and so does a wire field the document never learned about.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildStorylineRuntime } from './server';
import { MockChatClient, msg } from '../llm/mock';
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

    // R11 — THE FIELDS THE SERVER ALREADY SENDS ARE THE FIELDS THE CONTRACT NAMES. `phase_opened` and
    // `phase_open_reason` have been on the Start receipt since the phase pointer existed, and every one of the
    // other eight keys is read by the desk's rail; until this round the document named none of the pair, so a
    // generated client could not see that a start that opened no phase is a SUCCESS with a reason attached.
    // Pinning the key set against a live response is the only form this check can take: a prose contract
    // cannot drift from itself, but it can quietly fall behind a route, which is what happened.
    it('answers the Start receipt with exactly the fields `StartPhraseResult` documents (R11)', async () => {
        const runtime = buildStorylineRuntime({
            store: Store.empty(),
            engineConfig: { autoSweep: false },
            noAssistantSeed: true,
            env: {}
        });

        const created = await runtime.app.request('http://localhost/v1/storyline/stories', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'The Salt Cartographer', idea: 'A mapmaker redraws her own coastline.', chapter_count: 2 })
        });
        const story = (await created.json()) as { id: string };

        const started = await runtime.app.request(`http://localhost/v1/storyline/stories/${story.id}/phrases/plotlines/start`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ source: 'custom', text: 'Six chapters, alternating timeline, no frame story.' })
        });
        const receipt = (await started.json()) as Record<string, unknown>;

        expect(started.status).toBe(200);

        const schema = DOCUMENT.components.schemas.StartPhraseResult as {
            required: string[];
            properties: Record<string, unknown>;
        };

        // THE SAME KEYS, BOTH WAYS. `additionalProperties: false` is in the document, so an undocumented wire
        // field is a failure here just as a documented one the route stopped sending would be — and the pair
        // this round added can no longer be re-dropped by accident.
        expect(Object.keys(receipt).sort()).toEqual(Object.keys(schema.properties).sort());
        expect(schema.required.sort()).toEqual(Object.keys(schema.properties).sort());
        expect(Object.keys(receipt).sort()).toEqual(
            [
                'key',
                'phrase_id',
                'phase_open_reason',
                'phase_opened',
                'seed_chars',
                'seed_head',
                'source',
                'started',
                'story_id',
                'view'
            ].sort()
        );

        // THE PAIR ITSELF, as the document describes it: a boolean that is false on an ordinary start (the
        // Summary is not signed off, so the pointer does not move), and the sentence naming that state.
        expect(receipt.phase_opened).toBe(false);
        expect(typeof receipt.phase_open_reason).toBe('string');
        expect(receipt.phase_open_reason).toContain('lock');
    });

    // R11 — THE CLEANUP PROPOSAL, SAME RULE. The desk's confirm control reads `ok` to decide whether it has
    // anything to carry into the Start press, so a field set that drifts here is a desk offering "confirm"
    // over a proposal that is not there. The pass is scripted, so this reads the LIVE wire shape without
    // dialing a provider — the arm pinned is the PASSING one; the four guard refusals are pinned, key for
    // key, in `phrase-seed-cleanup-routes.test.ts`, whose subject is the refusal arm.
    it('answers the Seed cleanup with exactly the fields `SeedCleanupProposal` documents (R11)', async () => {
        const seed = 'A mapmaker she redraws her own coastline.';
        const runtime = buildStorylineRuntime({
            store: Store.empty(),
            engineConfig: { autoSweep: false },
            noAssistantSeed: true,
            env: {},
            // The provider answers the brief back UNCHANGED, which is the one answer every guard accepts by
            // construction: nothing was dropped and nothing was added, so `ok` cannot hinge on the fixture.
            chat: new MockChatClient(() => ({ message: msg({ content: seed }) }))
        });

        const created = await runtime.app.request('http://localhost/v1/storyline/stories', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'The Salt Cartographer', idea: 'A mapmaker redraws her own coastline.', chapter_count: 2 })
        });
        const story = (await created.json()) as { id: string };

        const reply = await runtime.app.request(
            `http://localhost/v1/storyline/stories/${story.id}/phrases/plotlines/seed/cleanup?seed=${encodeURIComponent(seed)}`
        );
        const proposal = (await reply.json()) as Record<string, unknown>;

        expect(reply.status).toBe(200);

        const schema = DOCUMENT.components.schemas.SeedCleanupProposal as { required: string[]; properties: Record<string, unknown> };

        // THE DOCUMENT: five named fields, of which only the two every answer carries are required — the
        // `ok`/`refusal` split is what `additionalProperties: false` still allows because BOTH are listed here.
        expect(Object.keys(schema.properties).sort()).toEqual(['changed', 'ok', 'refusal', 'source_hash', 'text']);
        expect(schema.required).toEqual(['ok', 'source_hash']);

        // THE RESPONSE, one for one against the `ok: true` arm: no `refusal`, and no field the document does
        // not name. `source_hash` is the 8-hex-digit FNV-1a digest of the trimmed draft, which is the whole
        // of the binding between a proposal and the text it was computed over.
        expect(Object.keys(proposal).sort()).toEqual(['changed', 'ok', 'source_hash', 'text']);
        expect(proposal.ok).toBe(true);
        expect(proposal.changed).toBe(false);
        expect(proposal.text).toBe(seed);
        expect(proposal.source_hash).toMatch(/^[0-9a-f]{8}$/);
    });
});
