// The `/v1/storyline` gateway mount (R1) — a thin remount of the harness API.
//
// WHAT THIS FILE IS FOR. `@underload/service` discovers our `endpoint/storyline`
// folder and calls the handler we default-export with Hono's context. The API that
// answers is `@underload/harness`'s own dispatcher, and that dispatcher is welded
// to one mount: `createHarnessApi`'s dispatch throws 404 for any mount other than
// `HARNESS_API_ROOT` (packages/underload/harness/src/server/api.ts:4845), and the
// service adapter hands it `mount: SERVICE_MOUNT` unconditionally
// (packages/underload/harness/src/server/service.ts:568-573). The user's decision
// for this package is a SEPARATE mount — REST `/v1/storyline/*` and the WS stream
// `/v1/storyline/stream` — so the adapter does the one thing a mount rename needs:
//
//   1. IN  — rewrite the request target `/v1/storyline/...` -> `/v1/harness/...`
//      before the harness adapter or the stream mount ever sees it (the stream mount
//      compares `request.url` against its own `path`, default
//      `HARNESS_WS_STREAM_PATH`, packages/underload/harness/src/server/stream/
//      mount.ts:128-135);
//   2. OUT — rewrite the mount back into the STRUCTURAL fields of the JSON body and
//      into the headers, because the dispatcher builds them from the mount it was
//      handed (`api_root` and every `links` map, api.ts:1647-1662, plus the sentences in
//      the closed `{ error: { message } }` envelope). Without this the storyline UI would
//      boot at `/v1/storyline` and be handed `/v1/harness/sessions` to follow. The
//      rewrite is field-keyed on purpose: an earlier version rewrote the token in EVERY
//      string, so story text that quoted `/v1/harness` came back edited by the transport.
//
// WHY THERE IS NO CLEANER SEAM. `HarnessServiceHandlerOptions` (harness
// src/server/service.ts:285) offers `runtime`, `root` and `execution` only — no mount —
// and `HarnessApiRequest.mount` (api.ts:378-397) is hard-checked against
// `HARNESS_API_ROOT` at api.ts:4845, so the dispatcher cannot be addressed at a
// different root at all. The rename therefore lives here, and it renames only the
// fields the dispatcher derived from that root.
//
// Everything else stays the harness's: the Origin gate, the body caps, SSE, the
// epoch/revision headers, the persistence rules, and the subprotocol
// (`harness.v1`). This file adds no second API and forks nothing.
//
// WHAT THIS MOUNT ADDS BESIDES THE RENAME (R-A + R-B). One awaited post-create step on
// `POST <mount>/sessions`: the default Title name when the client sent none, and the two
// record collections (`outlines`, `storyline`) every story session owns. Both belong in
// the SERVER's create path — a browser is not the right owner of a session's shape, and a
// preset factory cannot await a tool call — so a create that answers 201 has already
// produced a session the sidebar can render. See `finalizeStorylineSessionCreate`.
//
// IMPORT SAFETY: nothing here opens a listener, reads `.env`, or builds a store at
// import time. Route modules call `createStorylineServiceHandler()` at import, which
// only closes over the options — the runtime is resolved on the FIRST request,
// because the loader imports every `service-route*.ts` module before it serves
// anything and the database root only exists as a request variable.
//
// Cross-references:
//   - ./presets.ts        — the storyline preset the resolved registry must carry
//   - ./endpoint/storyline/service-route*.ts — the three declared routes
//   - ./main.ts           — the dev entry that boots the real discovery path
import {
    SERVICE_MOUNT,
    createHarnessServiceHandler,
    createHarnessServiceUpgrade,
    getHarnessRuntime,
    normalizeHarnessDatabaseRoot
} from '@underload/harness/server';
import type {
    HarnessRuntime,
    RunnerSettings,
    ServiceEndpointContext,
    ServiceEndpointHandler,
    ServiceEndpointParameters,
    ServiceEndpointResult,
    ServiceUpgradeHandler
} from '@underload/harness/server';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { ensureStorylineCollections } from './collections';
import { createStorylineHarnessRegistry, ensureStorylinePreset, STORYLINE_PRESET_NAME } from './presets';

// ---------------------------------------------------------------------------
// The mount (one place, so the three route modules cannot drift)
// ---------------------------------------------------------------------------

/** The URL root this package serves on the gateway. */
export const STORYLINE_MOUNT = '/v1/storyline';

/** The bare mount — its own module, because Hono's `/*` wildcard misses the bare path. */
export const STORYLINE_ROOT_ROUTE = STORYLINE_MOUNT;

/** Everything below the mount. */
export const STORYLINE_WILDCARD_ROUTE = `${STORYLINE_MOUNT}/*`;

/** The WebSocket upgrade path (subprotocol `harness.v1`, which the harness owns). */
export const STORYLINE_STREAM_ROUTE = `${STORYLINE_MOUNT}/stream`;

// The token the harness API believes it is mounted at, and the token clients are
// told. `SERVICE_MOUNT` is `/v1/harness`; naming it here keeps the rename honest if
// the harness ever moves its canonical root.
const HARNESS_TOKEN = SERVICE_MOUNT;
const STORYLINE_TOKEN = STORYLINE_MOUNT;

// ---------------------------------------------------------------------------
// Runtime resolution (lazy, root-keyed)
// ---------------------------------------------------------------------------

export type StorylineServiceOptions = {
    /** Inject a runtime (a test that owns its store); skips root resolution entirely. */
    runtime?: HarnessRuntime;
    /** Force a database root instead of the loader's `variables.root`. */
    root?: string | null;
};

// ---------------------------------------------------------------------------
// The boot-time provider document
// ---------------------------------------------------------------------------

export type StorylineRuntimeSettings = {
    /** The credential-bearing triple every storyline session dials. */
    settings?: RunnerSettings;
    /** The key-free advertisement `GET /v1/storyline/config` returns. Derived from the triple. */
    defaults?: { baseURL: string; model: string; hasApiKey: boolean };
};

// Set ONCE by ./main.ts before the gateway starts, and read on the first request per
// root. It has to be module state: the gateway imports the route modules cold and
// never calls through this package's entry, so an option passed to `main` would
// otherwise have no path to the runtime the handler resolves. An EMPTY value is a
// real state too — a bare `@underload/service` gateway that hosts this folder without
// our entry leaves it empty, and then the harness's own `HARNESS_*` environment rules
// (packages/underload/harness/src/server/config.ts) decide the provider, which is the
// behaviour an operator wiring the shared gateway expects.
let bootRuntimeSettings: StorylineRuntimeSettings = {};

/** Install the provider document for runtimes this mount builds from now on. */
export const configureStorylineRuntime = (next: StorylineRuntimeSettings = {}): void => {
    bootRuntimeSettings = { ...next };
};

/** The installed provider document (the startup banner, and the tests that pin the wiring). */
export const storylineRuntimeSettings = (): StorylineRuntimeSettings => ({ ...bootRuntimeSettings });

// Root-keyed cache of THIS package's runtimes. `getHarnessRuntime` already caches per
// root inside the harness, so the map is not a second store — it is what stops
// `createStorylineHarnessRegistry()` (a full preset-catalogue copy) from being built
// on every request when this mount is the first caller for that root. Key is the
// resolved root, and `''` is the in-memory runtime.
const storylineRuntimes = new Map<string, HarnessRuntime>();

/** How many root-keyed storylines this process has built (diagnostics and the import-safety test). */
export const storylineRuntimeCount = (): number => storylineRuntimes.size;

/** Drop the cached runtimes. Production never calls it; a test that re-boots a new root must. */
export const clearStorylineRuntimes = (): void => {
    storylineRuntimes.clear();
};

// The loader's storage boundary, read exactly like the harness adapter reads it:
// an OWN `root` property (even `null`) means "the operator named a boundary" and is
// normalized — `null`/undefined means in-memory, a blank string THROWS, so a typo is
// never silently ignored. `normalizeHarnessDatabaseRoot` is the harness's own helper
// (./persistence.ts:430), reused rather than re-derived.
const rootFromVariables = (variables: Record<string, unknown> | undefined): string | null | undefined => {
    if (variables === undefined || !Object.prototype.hasOwnProperty.call(variables, 'root')) return undefined;

    return normalizeHarnessDatabaseRoot(variables.root as string | null | undefined);
};

/**
 * Resolve (once per root) the runtime that serves this mount, and guarantee it can
 * build a storyline session.
 *
 * Two cases matter, and they are the whole reason this function exists:
 *   - this package's gateway: we are the first caller for the root, so we hand
 *     `getHarnessRuntime` OUR registry and the preset is simply there;
 *   - a wider gateway that already built the same root for the harness package's own
 *     `/v1/harness` mount: `getHarnessRuntime` returns THAT runtime and our registry
 *     argument is ignored, so `ensureStorylinePreset` injects the preset into the
 *     live registry instead of pretending the create call carried it.
 */
const resolveStorylineRuntime = (
    options: StorylineServiceOptions,
    variables?: Record<string, unknown>
): HarnessRuntime => {
    if (options.runtime !== undefined) {
        ensureStorylinePreset(options.runtime.registry);

        return options.runtime;
    }

    const root = options.root !== undefined ? normalizeHarnessDatabaseRoot(options.root) : rootFromVariables(variables);
    const key = root ?? '';
    const cached = storylineRuntimes.get(key);

    if (cached !== undefined) {
        // Cheap (`registry.find`), and it is what keeps the wider-gateway case
        // correct if the preset was removed from a live registry between requests.
        ensureStorylinePreset(cached.registry);

        return cached;
    }

    const created = getHarnessRuntime({
        root,
        registry: createStorylineHarnessRegistry(),
        // Only consulted on this, the creating call: `getHarnessRuntime` caches per
        // root, and `createHarnessRuntime` documents that a later call for an
        // existing root cannot change its settings. Passing the resolved triple is
        // what makes `--flag -> STORYLINE_* -> HARNESS_* -> default` (./config.ts)
        // actually reach a session instead of being recomputed by the engine.
        ...(bootRuntimeSettings.settings === undefined ? {} : { settings: bootRuntimeSettings.settings }),
        ...(bootRuntimeSettings.defaults === undefined ? {} : { defaults: bootRuntimeSettings.defaults })
    });

    storylineRuntimes.set(key, created);
    ensureStorylinePreset(created.registry);

    return created;
};

// ---------------------------------------------------------------------------
// The remount helpers
// ---------------------------------------------------------------------------

// `/v1/storyline` -> `/v1/harness`, `/v1/storyline/sessions` ->
// `/v1/harness/sessions`. Anything that does not start with the mount is passed
// through untouched: the loader registers the declared route, so a foreign target
// means the handler was reached some other way and the dispatcher's own 404 is the
// honest answer.
const mountIntoHarness = (target: string): string => {
    if (target !== STORYLINE_MOUNT && !target.startsWith(`${STORYLINE_MOUNT}/`)) return target;

    return `${HARNESS_TOKEN}${target.slice(STORYLINE_MOUNT.length)}`;
};

// One string, every occurrence of the mount token. Applied only to a value the
// dispatcher MINTED from the mount it was handed (see the field rules below); a
// structural value can hold the token twice — a link built on a link — and replacing
// every occurrence keeps even that honest.
const remountString = (value: string): string => value.split(HARNESS_TOKEN).join(STORYLINE_TOKEN);

// The field whose value IS the mount: the bootstrap document's own root
// (`ServiceInfo.api_root`, harness src/shared/harness-api.ts:359, produced at
// src/server/api.ts:1662).
const API_ROOT_KEY = 'api_root';

// The fields whose OBJECT holds only server-built strings, checked against every
// producer rather than guessed:
//
//   links   every mount-rooted URL map — the boot document (api.ts:1647-1658), the task
//           receipt (api.ts:2797-2804), the transcript write receipt (api.ts:4371-4374)
//           and the turn block row (api.ts:4723-4725);
//   error   the ONE closed error envelope (`ErrorBody`, harness-api.ts:288-292 — exactly
//           `{ error: { message } }`), whose sentences the dispatcher mints FROM the
//           mount: the mount-mismatch 404 (api.ts:4846), `Unknown API route: GET
//           /v1/harness/...` (:4849), the 405 (:4870), the stream 400 (harness
//           src/server/service.ts:472-479) and the tool idle guards (:3581, :3684,
//           :3801, :3849, :3905).
//
// EVERYTHING ELSE IS DATA, and data must survive the mount untouched. The blunt
// split/join this file used to run over the WHOLE body rewrote the token wherever it
// sat, so a chapter whose text happened to quote `/v1/harness` read back altered — the
// transport editing the story. Record bodies, transcript messages, agent prose and
// tool previews now pass through byte-identical.
const ROUTE_MAP_KEYS = new Set(['links', 'error']);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

// Everything under a structural key is a route or a server sentence, at whatever depth
// the dispatcher assembled it, so every string in there is rewritten.
const remountRoutes = (value: unknown): unknown => {
    if (typeof value === 'string') return remountString(value);
    if (Array.isArray(value)) return value.map(remountRoutes);

    if (isRecord(value)) {
        const remounted: Record<string, unknown> = {};

        for (const [key, entry] of Object.entries(value)) remounted[key] = remountRoutes(entry);

        return remounted;
    }

    return value;
};

// Walk the JSON document. Recursive on purpose: links ride INSIDE rows (a session, a
// turn, a receipt nested in a page of items), and a shallow pass would leave half of
// them pointing at a root this server does not serve. Responses are bounded by the
// harness's own body caps, so one O(size) walk is the price of an honest mount.
const remountValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(remountValue);

    // A string here is USER content: story text, a transcript message, a preview. It is
    // returned as it arrived, which is the whole point of this function.
    if (!isRecord(value)) return value;

    const remounted: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(value)) {
        if (key === API_ROOT_KEY && typeof entry === 'string') {
            remounted[key] = remountString(entry);
            continue;
        }

        if (ROUTE_MAP_KEYS.has(key) && isRecord(entry)) {
            remounted[key] = remountRoutes(entry);
            continue;
        }

        remounted[key] = remountValue(entry);
    }

    return remounted;
};

// A header bag is flat and entirely server-built (the dispatcher answers epoch and
// revision only — api.ts:1497 `json`/`withHeaders`), so every value is rewritten. There
// is no length in it to keep in step either: `response` leaves this handler as a value
// and the gateway serializes and measures it afterwards.
const remountHeaders = (headers: Record<string, string> | undefined): Record<string, string> | undefined => {
    if (headers === undefined) return undefined;

    return remountRoutes(headers) as Record<string, string>;
};

// The request the harness adapter reads: the same header access and the same raw
// request (its `body`/`signal`/`method` are what the streaming body cap and the SSE
// abort depend on), only with the mount renamed.
const remountContext = (context: ServiceEndpointContext): ServiceEndpointContext => ({
    req: {
        path: mountIntoHarness(context.req.path),
        header: (name: string) => context.req.header(name),
        ...(context.req.raw === undefined ? {} : { raw: context.req.raw })
    }
});

// ---------------------------------------------------------------------------
// The post-create hook (R-A + R-B)
// ---------------------------------------------------------------------------

/**
 * The title a storyline session gets when the client created one without naming it.
 *
 * A SESSION is a Title in this product, and a Title the sidebar cannot label is not a
 * folder the user can find again. The harness deliberately leaves an unnamed session
 * untitleled — `POST /sessions` only renames when the body carried a name
 * (packages/underload/harness/src/server/api.ts:2551-2555), and `SessionSummary.title` is
 * optional (`shared/harness-api.ts:945-958`) — so the default belongs HERE, in the create
 * path of the mount the story UI talks to, and nowhere that would surprise a
 * non-storyline client of the same engine.
 */
export const STORYLINE_DEFAULT_TITLE = 'Untitled Title';

/** The create route, in both spellings this handler can be reached with. */
const SESSION_CREATE_TARGETS = new Set([`${STORYLINE_MOUNT}/sessions`, `${HARNESS_TOKEN}/sessions`]);

/** The verb + route this hook answers: exactly `POST <mount>/sessions`. */
const isSessionCreate = (target: string, method: string): boolean => method === 'POST' && SESSION_CREATE_TARGETS.has(target);

/** The method the loader saw. `raw.method` is what the harness dispatcher itself uses. */
const methodOf = (context: ServiceEndpointContext): string => {
    const raw = context.req.raw as { method?: unknown } | undefined;

    return typeof raw?.method === 'string' ? raw.method.toUpperCase() : 'GET';
};

/**
 * Finish a storyline session create before the client sees the 201.
 *
 * WHY HERE AND NOT IN THE PRESET. A preset's `create()` is synchronous (harness
 * src/server/harnesses/types.ts:201), while defining a collection is an awaited tool call
 * — so a preset can only fire it and forget it, and on a RESTARTED session that floating
 * promise races the store's own `restore()` of the durable snapshot (the collections the
 * snapshot already carries would be re-`define`d, and a re-`define` is refused). This
 * handler has the opposite shape: the dispatcher has already answered, the session row and
 * its harness exist, nothing else has touched them yet, and the hook can await. Both facts
 * are what make the 201 honest — by the time the UI's create call resolves, the Title has
 * its name and its two folders, so the first render of the tree has something to open.
 *
 * WHY NOTHING HERE CAN FAIL THE CREATE. The session was created by the dispatcher and is
 * already durable when this runs. A Title that comes back untitleled, or a session whose
 * folders arrive on the UI's own idempotent ensure, is a degraded start; a 500 for a
 * session that EXISTS would be a lie. So each step is guarded and reported on its own.
 */
export const finalizeStorylineSessionCreate = async (runtime: HarnessRuntime, result: ServiceEndpointResult): Promise<void> => {
    if (result.status !== 201) return;

    const body = result.response;

    if (!isRecord(body)) return;

    const session = body.session;

    // The hook is keyed on the CARD, not on the mount: a wider gateway may create a
    // storyline session through `/v1/harness/sessions`, and then the same two resources are
    // what a story session needs. Any other preset's session passes through untouched.
    if (!isRecord(session) || session.harness !== STORYLINE_PRESET_NAME) return;

    const sessionId = typeof session.id === 'string' ? session.id : undefined;

    if (sessionId === undefined) return;

    const record = runtime.store.peekSession(sessionId);

    // Torn down between the create and here (a DELETE on another socket). The response is
    // still the honest receipt of a create that did happen.
    if (record === undefined) return;

    if (typeof session.title !== 'string' || session.title.trim().length === 0) {
        try {
            // Durable on purpose: `renameSession` writes the document before it answers
            // (harness src/server/sessions.ts:1914), so the default name survives a restart
            // exactly like a name the user typed.
            await runtime.store.renameSession(sessionId, STORYLINE_DEFAULT_TITLE);
            session.title = STORYLINE_DEFAULT_TITLE;
        } catch (error) {
            console.warn(`[storyline] "${sessionId}" kept no title: ${messageOf(error)}`);
        }
    }

    try {
        await ensureStorylineCollections(record.harness);
    } catch (error) {
        // The UI's own ensure is the documented second owner of this guarantee, and it is
        // idempotent — a session that gets here without the folders is repaired on first
        // read rather than reported as a failed create.
        console.warn(`[storyline] could not define the Title's collections for "${sessionId}": ${messageOf(error)}`);
    }
};

/** Error text that survives a non-Error throw (the harness throws plain values sometimes). */
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------------------
// The endpoint factories
// ---------------------------------------------------------------------------

/**
 * The REST handler for `/v1/storyline` and `/v1/storyline/*`.
 *
 * It is a factory (not a value) for the same reason the harness's is: each route
 * module needs its own closure, and `options.runtime` lets a test bring its own
 * store. The per-request work is a path rewrite, one runtime lookup, and a mount
 * rewrite on the way out.
 */
export const createStorylineServiceHandler = (options: StorylineServiceOptions = {}): ServiceEndpointHandler => {
    // `parameters` defaults to an EMPTY object rather than staying optional: the
    // adapter's raw-body signal is `parameters.body === undefined`, so `{}` and
    // `undefined` mean exactly the same thing to it, and the loader always supplies a
    // real one (with `path`/`query`, which the paginated routes depend on).
    return async (
        context: ServiceEndpointContext,
        parameters: ServiceEndpointParameters = {},
        variables?: Record<string, unknown>
    ): Promise<ServiceEndpointResult> => {
        let runtime: HarnessRuntime;

        try {
            runtime = resolveStorylineRuntime(options, variables);
        } catch (error) {
            // An invalid database root is the harness's own persistence error. The
            // adapter below would have answered 500 with the real message for the
            // same failure, so the mount answers it the same way rather than
            // letting it become an unhandled rejection in the loader.
            return {
                status: 500,
                response: { error: { message: error instanceof Error ? error.message : String(error) } }
            };
        }

        const result = await createHarnessServiceHandler({ runtime })(remountContext(context), parameters, variables);

        // `raw` is an already-built Response (SSE). Its frames are produced by the
        // stream layer, not by the JSON dispatcher, and rewriting a live byte stream
        // is not this adapter's job — noted rather than hidden.
        if (result.raw !== undefined) return result;

        // R-A + R-B: a storyline create is not finished when the dispatcher answers. The
        // Title's default name and its two record collections are installed HERE, awaited,
        // so the 201 the UI reads already describes them (the hook's comment states why the
        // preset factory cannot do this instead). It runs on the pre-rewrite body: the two
        // fields this touches are a session id and a title, and neither is a mount token.
        if (isSessionCreate(mountIntoHarness(context.req.path), methodOf(context))) {
            await finalizeStorylineSessionCreate(runtime, result);
        }

        return {
            ...result,
            response: remountValue(result.response),
            ...(result.headers === undefined ? {} : { headers: remountHeaders(result.headers) })
        };
    };
};

/**
 * The WebSocket upgrade handler for `/v1/storyline/stream`.
 *
 * The mount's own handshake compares the request target against its `path`
 * (default `/v1/harness/stream`), so the target is rewritten before the hand-off and
 * restored afterwards: the socket has already been taken over, and any later reader
 * of `request.url` (a log line, an origin check) should still see the URL the client
 * actually asked for.
 *
 * The runtime is resolved HERE and injected, so the stream and the REST mount are
 * served by one store — one epoch, one subscription set, one revision counter. A
 * `false` return means "not this path", which is how the gateway keeps trying the
 * next candidate endpoint.
 */
export const createStorylineServiceUpgrade = (options: StorylineServiceOptions = {}): ServiceUpgradeHandler => {
    return (request: IncomingMessage, socket: Duplex, head: Buffer, variables?: Record<string, unknown>): boolean => {
        let runtime: HarnessRuntime;

        try {
            runtime = resolveStorylineRuntime(options, variables);
        } catch (error) {
            // Same rule as the harness mount: an upgrade cannot answer a JSON 500, so
            // refuse on the socket with the real message rather than dropping it.
            socket.end(`503 ${(error instanceof Error ? error.message : String(error))}\r\n\r\n`);

            return true;
        }

        const declared = request.url;

        request.url = typeof declared === 'string' ? mountIntoHarness(declared.split('?')[0]) : HARNESS_TOKEN;

        try {
            return createHarnessServiceUpgrade({ runtime })(request, socket, head, variables);
        } finally {
            request.url = declared;
        }
    };
};
