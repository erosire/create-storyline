// The @underload/service mount for the whole `/v1/storyline` surface.
//
// WHY THIS FILE EXISTS AT ALL: the dashboard dials one root — `/v1/storyline` (see
// `dashboard/api.ts:API_ROOT` and the dev proxy in `vite.config.ts`, which points it at the
// gateway on :5000). The gateway only knows the routes that endpoint discovery hands it, and
// discovery is a directory scan for folders named `endpoint`/`endpoints` holding
// `service-route*.ts` modules (packages/underload/service/src/utility/endpoints.ts). This
// package had none, so every dashboard request answered the gateway's own 404 — the
// "request refused (404 Not Found)" the Author saw.
//
// HOW IT MOUNTS: the loader installs `app.all(route)` and calls the handler for every method,
// passing `(context, parameters, variables)`. The storyline server is a Hono app whose mount
// already carries the `/v1/storyline` prefix, so the handler is a single forward: hand Hono the
// ORIGINAL `Request` and return its `Response` as `{ raw }` — the loader's raw passthrough.
// That matters for two things a JSON envelope would break:
//
//   * `GET /v1/storyline/stream` is `text/event-stream` (the dashboard's live feed); it must
//     reach the browser untouched.
//   * the refusal shapes (404/409/204) are already built by the route layer with their own
//     status and body, and `{ status, response }` would re-wrap them.
//
// WHY `body: 'raw'`: the loader's default mode calls `context.req.json()` BEFORE the handler
// runs, which consumes the body stream — every POST/PATCH would then arrive at Hono empty. With
// `raw` the stream stays unread and Hono's own `c.req.json()` reads it exactly as it does when
// the server runs standalone.
//
// THE BOOK: `variables.root` is the service's shared storage boundary (DATABASE_ROOT in
// packages/underload/service/server.ts), and every distribution appends its own folder below it
// — so the Storyline book lives at `<root>/storyline`. `STORYLINE_STORE_ROOT` still wins (the
// same env switch `resolveServerConfig` documents), and a blank value keeps the documented
// in-memory run. The runtime is built once per store root and reused: it owns the Hono app, the
// loop engine and the open store, none of which may be re-created per request.
//
// STORYLINE OWNS ITS CONTROL SURFACE. The host forwards no harness catalogue: the engine
// runs the Story's four employees inside this package's per-Story harnesses, and the server's
// routes are the only control plane. `variables.root` is the one boot input besides the
// documented environment switches.
import path from 'node:path';
import { createStorylineApp } from '../../main';
import { createStorylineRuntimeCache } from './runtime-cache';
import type { StorylineRuntime } from '../../api/server';

/** The one root the dashboard dials; the wildcard covers every route below it. */
export const STORYLINE_SERVICE_ROUTE = '/v1/storyline/*';

/** The loader's context, typed structurally so this package needs no @underload/service import. */
type ServiceContext = { req: { raw: Request } };

/** The loader's third argument: `variables.root` is the shared storage boundary. */
type ServiceVariables = Record<string, unknown> | undefined;

/** What the loader understands: a raw Response passes straight through it. */
export type ServiceEndpointResult = { raw: Response };

/**
 * The store root for this mount, resolved in the same precedence order the CLI uses:
 * `STORYLINE_STORE_ROOT` (blank = in-memory) → `<variables.root>/storyline` → undefined
 * (which lets `resolveServerConfig` fall back to its own package-relative default).
 */
const storeRootFor = (variables: ServiceVariables): string | null | undefined => {
    const explicit = process.env.STORYLINE_STORE_ROOT;

    if (explicit !== undefined) {
        const trimmed = explicit.trim();

        return trimmed.length === 0 ? null : trimmed;
    }

    const root = variables?.root;

    return typeof root === 'string' && root.length > 0 ? path.join(root, 'storyline') : undefined;
};

/**
 * One open runtime per store root. A restart of the gateway drops the cache with the process.
 */
const runtimes = createStorylineRuntimeCache(async ({ storeRoot }) => {
    const runtime = await createStorylineApp({ storeRoot });

    // L-1: the loop is started, not auto-started by composition. The gateway is a
    // long-lived host, so the sweep is what makes the dashboard move at all.
    runtime.engine.start();

    return runtime;
});

/**
 * Stop and close every runtime this mount opened. The gateway owns the process lifetime, so
 * production does not need this on a normal exit; tests and an embedding host that unmounts
 * the endpoint use it for a deterministic shutdown.
 */
export const disposeStorylineServiceRuntimes = (): Promise<void> => runtimes.dispose();

const runtimeFor = (variables: ServiceVariables): Promise<StorylineRuntime> =>
    runtimes.runtimeFor({ storeRoot: storeRootFor(variables) });

/**
 * Forwards one gateway request into the storyline Hono app.
 *
 * Nothing is rewrapped and nothing is re-parsed — the Request goes in, its Response comes out.
 */
export const storylineServiceHandler = async (
    context: ServiceContext,
    _parameters?: unknown,
    variables?: ServiceVariables
): Promise<ServiceEndpointResult> => {
    const runtime = await runtimeFor(variables);

    return { raw: await runtime.app.fetch(context.req.raw) };
};

export default {
    route: STORYLINE_SERVICE_ROUTE,
    handler: storylineServiceHandler,
    // See the header: the loader must leave the body stream unread for Hono to parse.
    body: 'raw' as const
};
