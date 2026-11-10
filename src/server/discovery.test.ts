// R1 end to end, through the path the user chose: the endpoint folder is DISCOVERED
// by `@underload/service`, and the mount answers on a real socket.
//
// WHY THIS TEST BOOTS THE GATEWAY RATHER THAN A FAKE: the contract under test is the
// discovery itself — the scanner finding `src/server/endpoint`, the loader importing
// the three modules before it binds, Hono installing the declared routes, and the
// upgrade tier routing the WebSocket handshake to the exact path. None of that is
// observable through the handler alone.
//
// WHY THE SERVICE IS IMPORTED BY NAME: `@underload/service` publishes TypeScript
// SOURCE (`main: src/index.ts`, no `exports`/`types` map), so a static import pulls
// that package into this project's `tsc --noEmit` and reports three errors that are
// not ours to fix — its own `tsc --noEmit` fails with the same three
// (src/server/start.ts:160,400,401). A widening `string` specifier keeps the
// dependency runtime-resolved, which is how the repository gateway loads it too.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import { packageRootOf } from './config';
import { startStorylineServer, type StorylineServer } from './main';
import { clearStorylineRuntimes } from './service';

const SERVICE_MODULE: string = '@underload/service';

type GatewayUtilities = {
    findEndpointFolders: (root: string, folderName?: string) => string[];
    findEndpoints: (root: string, folderName?: string) => { folderPath: string; filePath: string }[];
};

const loadGatewayUtilities = async (): Promise<GatewayUtilities> =>
    (await import(SERVICE_MODULE)) as unknown as GatewayUtilities;

const SETTINGS = { baseURL: 'http://127.0.0.1:1/v1', apiKey: '', model: 'story/test-model' };

// The `Sec-WebSocket-Key` the RFC's own example uses, so the expected `Accept` value
// is a constant if a future assertion ever needs it.
const WEBSOCKET_KEY = 'dGhlIHNhbXBsZSBub25jZQ==';

type Response = { status: number; headers: http.IncomingHttpHeaders; body: unknown };

/** One plain HTTP request against the booted gateway, with the JSON body already parsed. */
const call = (
    server: StorylineServer,
    pathname: string,
    options: { method?: string; body?: unknown } = {}
): Promise<Response> => {
    return new Promise((resolve, reject) => {
        const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
        const request = http.request(
            {
                host: '127.0.0.1',
                port: server.port,
                path: pathname,
                method: options.method ?? 'GET',
                headers: {
                    // The harness Origin gate allows a request with no Origin at all,
                    // which is what a server-to-server or curl client sends.
                    ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
                }
            },
            (response) => {
                const chunks: Buffer[] = [];

                response.on('data', (chunk: Buffer) => chunks.push(chunk));
                response.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');

                    let body: unknown = text;

                    try {
                        body = JSON.parse(text) as unknown;
                    } catch {
                        // A non-JSON answer stays a string, so an assertion failure
                        // shows what was actually served.
                    }

                    resolve({ status: response.statusCode ?? 0, headers: response.headers, body });
                });
            }
        );

        request.on('error', reject);
        request.end(payload);
    });
};

/** The raw upgrade handshake: the `101` and its headers, or the status that refused it. */
const upgrade = (server: StorylineServer, pathname: string, protocol: string): Promise<{ status: number; protocol?: string }> => {
    return new Promise((resolve, reject) => {
        const request = http.request({
            host: '127.0.0.1',
            port: server.port,
            path: pathname,
            headers: {
                connection: 'Upgrade',
                upgrade: 'websocket',
                'sec-websocket-version': '13',
                'sec-websocket-key': WEBSOCKET_KEY,
                'sec-websocket-protocol': protocol
            }
        });

        request.on('upgrade', (response, socket) => {
            socket.destroy();
            resolve({ status: response.statusCode ?? 0, protocol: response.headers['sec-websocket-protocol'] as string | undefined });
        });

        // A refused handshake arrives as a normal response (400/426/503); report the
        // status so the assertion names what happened rather than timing out.
        request.on('response', (response) => {
            response.resume();
            resolve({ status: response.statusCode ?? 0, protocol: response.headers['sec-websocket-protocol'] as string | undefined });
        });

        request.on('error', reject);
        request.end();
    });
};

describe('gateway discovery', () => {
    it('finds the endpoint folder of this package and exactly its three route modules', async () => {
        const service = await loadGatewayUtilities();
        const root = packageRootOf();

        // The scanner recurses from the package root and stops AT an `endpoint`
        // folder, so one hit is the expected shape: the only such folder here is ours.
        expect(service.findEndpointFolders(root, 'endpoint')).toEqual([path.join(root, 'src', 'server', 'endpoint')]);

        expect(
            service
                .findEndpoints(root, 'endpoint')
                .map((endpoint) => path.basename(endpoint.filePath))
                .sort()
        ).toEqual(['service-route-root.ts', 'service-route-stream.ts', 'service-route.ts']);
    });
});

describe('booted storyline gateway', () => {
    let server: StorylineServer;

    beforeAll(async () => {
        server = await startStorylineServer({
            // `0` is resolved to a concrete free port by the entry itself (the gateway
            // never reports its bound address), which is what lets this run in parallel
            // with anything else on the machine.
            port: 0,
            // No database: the runtime stays in memory and the test leaves nothing behind.
            databaseRoot: null,
            // An empty environment plus these flags makes every value explicit, so the
            // assertions do not depend on a developer's shell or on a stale `dist/`.
            env: {},
            flags: { noStatic: true, help: false },
            settings: SETTINGS,
            defaults: { baseURL: SETTINGS.baseURL, model: SETTINGS.model, hasApiKey: false }
        });
    }, 60_000);

    afterAll(async () => {
        await server?.close();
        clearStorylineRuntimes();
    });

    it('binds a real port and reports the mounts it serves', () => {
        expect(server.port).toBeGreaterThan(0);
        expect(server.config.staticRoot).toBeNull();
        expect(server.api).toBe(`${server.url}/v1/storyline`);
        expect(server.stream).toBe(`ws://${server.url.slice('http://'.length)}/v1/storyline/stream`);
    });

    it('answers the bare mount with a boot document that names this mount', async () => {
        const response = await call(server, '/v1/storyline');

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            api_root: '/v1/storyline',
            service: 'noobscript-harness',
            capabilities: { websocket_stream: true },
            links: {
                self: '/v1/storyline',
                sessions: '/v1/storyline/sessions',
                stream: '/v1/storyline/stream'
            }
        });
        expect(JSON.stringify(response.body).includes('/v1/harness')).toBe(false);
    });

    it('advertises the provider this host resolved', async () => {
        const response = await call(server, '/v1/storyline/config');

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            defaults: { base_url: SETTINGS.baseURL, model: SETTINGS.model, has_api_key: false }
        });
    });

    it('creates a storyline session, with the roster the harness resolved', async () => {
        const response = await call(server, '/v1/storyline/sessions', { method: 'POST', body: { harness: 'storyline' } });

        expect(response.status).toBe(201);

        const session = (response.body as { session: Record<string, unknown> }).session;

        expect(session).toMatchObject({ harness: 'storyline', status: 'idle', model: SETTINGS.model });
        expect(Object.keys(session.agent_models as Record<string, string>)).toEqual(['writer', 'reader', 'editor']);
        expect(response.headers['x-harness-epoch']).toBeDefined();
        expect(response.headers['x-harness-revision']).toBe('1');
    });

    it('upgrades /v1/storyline/stream on the gateway listener with the harness.v1 subprotocol', async () => {
        const handshake = await upgrade(server, '/v1/storyline/stream', 'harness.v1');

        // `101` proves the loader's upgrade tier matched the DECLARED route and the
        // harness mount accepted the rewritten target — same host, same port, no
        // second listener.
        expect(handshake.status).toBe(101);
        expect(handshake.protocol).toBe('harness.v1');
    }, 30_000);

    it('refuses a plain GET on the stream path with the 400 the contract declares', async () => {
        const response = await call(server, '/v1/storyline/stream');

        expect(response.status).toBe(400);
        expect((response.body as { error: { message: string } }).error.message).toContain('/v1/storyline/stream');
    });

    it('serves nothing outside the scanned package — the harness package is not mounted here', async () => {
        // The scan root is this package, so `/v1/harness/*` (the harness package's own
        // endpoint folder) is absent: the dev entry is a miniature of the gateway, not
        // the whole repository's one.
        const response = await call(server, '/v1/harness/sessions');

        expect(response.status).toBe(404);
    });
});
