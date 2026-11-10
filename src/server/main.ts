// The storyline server: this package's own `@underload/service` gateway (R1).
//
// WHAT THIS BOOTS. The user's decision for this package is gateway-only discovery,
// so the entry does NOT open a private harness listener (`startHarnessServer`, whose
// REST root is fixed at `/v1/harness`). It boots the REAL discovery path —
// `startServer({ root: <this package> })` — and lets the gateway find
// `src/server/endpoint/storyline/service-route*.ts` exactly the way the repository
// gateway would: the scan is recursive and gitignore-aware
// (packages/underload/service/src/utility/endpoints.ts:158), each module is imported
// before the listener answers, and each declared `route` is installed with
// `app.all(...)`. Scoping `root` to this package is what keeps the dev entry honest
// and cheap: the only endpoint folder in it is ours, so `/v1/storyline` is served
// precisely as the shared gateway would serve it, and no sibling package's routes
// appear.
//
// WHAT THE PACKAGE CONTRIBUTES ON TOP OF THE GATEWAY:
//   1. the configuration chain (./config.ts — flag -> STORYLINE_* -> HARNESS_* ->
//      default), installed into the runtime through `configureStorylineRuntime`;
//   2. the `storyline` preset and its registry (./presets.ts), which the endpoint's
//      runtime resolution guarantees;
//   3. the `/v1/storyline` <-> `/v1/harness` remount (./service.ts), because the
//      harness dispatcher serves one canonical root and this package serves another;
//   4. the process plumbing: CLI flags, the startup banner, and SIGINT/SIGTERM.
//
// IMPORT SAFETY: importing this module binds NOTHING. The listener exists only after
// `startStorylineServer`, and `./cli.ts` is the only file that runs the CLI — the
// same rule `@underload/harness` documents for its own barrels and the reason a test
// can import the factory and boot on an OS-assigned port.
import net from 'node:net';
import { parseArgs } from 'node:util';
import {
    DEFAULT_CHAIN_DEPTH,
    DEFAULT_CHAIN_RULE,
    resolveServerConfig,
    DEFAULT_PORT,
    packageRootOf,
    type StorylineFlags,
    type StorylineServerConfig
} from './config';
import { STORYLINE_PRESET_NAME } from './presets';
import { STORYLINE_DEFAULT_TITLE, STORYLINE_MOUNT, STORYLINE_STREAM_ROUTE, configureStorylineRuntime } from './service';

// ---------------------------------------------------------------------------
// The gateway, loaded by name
// ---------------------------------------------------------------------------

// The slice of the `@underload/service` contract this package calls
// (packages/underload/service/src/server/start.ts:23-127). Restated rather than
// imported because of the loader below.
type GatewayWebRoute = { route: string; root: string; index?: string };

type GatewayOptions = {
    /** Directory scanned recursively for `endpoint` folders. */
    root?: string;
    /** The one port clients dial; `0` would be bound but never reported back. */
    port?: number;
    host?: string;
    /** Passed as the third argument to every endpoint handler. */
    variables?: Record<string, unknown>;
    /** Built single-page apps served at the raw layer, before Hono. */
    webRoutes?: GatewayWebRoute[];
};

type GatewayInstance = { close: () => Promise<void> };

// A `string`, not a literal, ON PURPOSE. `@underload/service` publishes TypeScript
// SOURCE (`main: src/index.ts` with no `exports`/`types` map), so a static import
// pulls that package's sources into THIS project's `tsc --noEmit` and reports three
// pre-existing type errors that are not ours to fix (verified: the service package
// fails its own `tsc --noEmit` with the same three). A widening variable defeats
// literal-specifier resolution, so the dependency stays runtime-resolved — which is
// precisely how the repository gateway loads it (`yarn start-service` runs
// `vite-node packages/underload/service/server.ts`) — and the shape we call is the
// declared one above.
const GATEWAY_MODULE: string = '@underload/service';

/**
 * Boot the `@underload/service` gateway. Throws when the package is not installed,
 * naming what to install, rather than failing inside a destructuring.
 */
export const startGateway = async (options: GatewayOptions): Promise<GatewayInstance> => {
    const loaded = (await import(/* @vite-ignore */ GATEWAY_MODULE)) as {
        startServer?: (options: GatewayOptions) => Promise<GatewayInstance>;
    };

    if (typeof loaded.startServer !== 'function') {
        throw new Error('`@underload/service` is installed but exports no `startServer`.');
    }

    return loaded.startServer(options);
};

export type StorylineServer = {
    /** The origin the gateway is listening on, e.g. `http://127.0.0.1:5000`. */
    url: string;
    port: number;
    host: string;
    /** The storyline REST mount, e.g. `http://127.0.0.1:5000/v1/storyline`. */
    api: string;
    /** The storyline WebSocket mount (same origin, subprotocol `harness.v1`). */
    stream: string;
    /** The resolved configuration this listener booted with. */
    config: StorylineServerConfig;
    close: () => Promise<void>;
};

export type StartStorylineOptions = {
    /** Overrides the resolved gateway port. `0` asks for an OS-assigned free port. */
    port?: number;
    host?: string;
    /** `null` runs the harness in memory; otherwise the durable storage boundary. */
    databaseRoot?: string | null;
    /** `null` serves no UI. Otherwise an absolute directory, mounted at `/storyline`. */
    staticRoot?: string | null;
    settings?: { baseURL: string; apiKey: string; model: string };
    defaults?: { baseURL: string; model: string; hasApiKey: boolean };
    /** Directory to scan for `endpoint` folders; defaults to this package's root. */
    root?: string;
    /** Injected for tests: the environment and CLI flags the resolver reads. */
    env?: NodeJS.ProcessEnv;
    flags?: Partial<StorylineFlags>;
    packageRoot?: string;
    exists?: (candidate: string) => boolean;
};

/**
 * Ask the kernel for a free TCP port.
 *
 * `startServer` returns only `{ close }` — it never reports the bound address — so
 * `port: 0` is unusable as an "ephemeral port" request: the caller could not learn
 * where to dial, and `killPort(0)` is skipped anyway
 * (packages/underload/service/src/server/start.ts:239-242). Allocating here means
 * the gateway is always told a concrete port and the caller always knows it. The
 * close-then-rebind window is a race in principle and a non-issue on loopback; a
 * port taken between the two probes fails loudly at `listen`, which is the honest
 * outcome rather than a silent move to a port nobody chose.
 */
export const allocateFreePort = async (host: string): Promise<number> => {
    const probe = net.createServer();

    await new Promise<void>((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(0, host, () => resolve());
    });

    const address = probe.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    await new Promise<void>((resolve) => probe.close(() => resolve()));

    return port;
};

/**
 * Boot the storyline gateway: resolve the configuration, install the provider
 * document, and start the discovery-scoped server.
 *
 * The provider triple is installed BEFORE `startServer` because the runtime that
 * needs it is built on the first request, from the module state `./service.ts` keeps
 * for exactly that reason — the route modules are imported cold by the gateway, and
 * a bare gateway that never runs this function keeps the harness's own environment
 * rules.
 *
 * `variables.root` is the STORAGE boundary handed to every endpoint as its third
 * argument; the scanner root (`root`) is the source tree and must never become a data
 * directory. An explicit `null` is preserved rather than dropped: the harness reads
 * an own `root` property, and `null` is its documented "in-memory, no persistence"
 * value. Omitting the key entirely would hand the endpoints the scanned source root.
 */
export const startStorylineServer = async (options: StartStorylineOptions = {}): Promise<StorylineServer> => {
    const resolved = resolveServerConfig({
        ...(options.flags === undefined ? {} : { flags: options.flags }),
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
        ...(options.exists === undefined ? {} : { exists: options.exists })
    });

    const settings = options.settings ?? resolved.settings;

    // `defaults` is not decorative: `GET <mount>/config` advertises it and a session
    // created without an explicit model takes its provider model from that document.
    // So when a caller pins `settings` without a document, the document is DERIVED
    // from the same triple — a UI can never be told one provider while its sessions
    // dial another.
    const defaults =
        options.defaults ??
        (options.settings === undefined
            ? resolved.defaults
            : { baseURL: settings.baseURL, model: settings.model, hasApiKey: settings.apiKey.trim().length > 0 });

    configureStorylineRuntime({ settings, defaults });

    const host = options.host ?? resolved.host;
    const requestedPort = options.port ?? resolved.port;
    const port = requestedPort === 0 ? await allocateFreePort(host) : requestedPort;

    const staticRoot = options.staticRoot !== undefined ? options.staticRoot : resolved.staticRoot;

    // The storage boundary this listener ACTUALLY boots with: an explicit option (and
    // `null` is explicit — it means in-memory) wins over the resolved default. One value,
    // used twice: it is handed to the endpoints as their `variables.root` AND reported as
    // `config.databaseRoot`, because `runCli` prints that field in the banner and the two
    // used to disagree — an in-memory run announced the `<package>/temporary/harness`
    // directory it never created.
    const databaseRoot = options.databaseRoot !== undefined ? options.databaseRoot : resolved.databaseRoot;

    const server = await startGateway({
        // The scan root: only this package's `endpoint` folder is discovered, which is
        // what makes `yarn start` a faithful miniature of the shared gateway.
        root: options.root ?? options.packageRoot ?? packageRootOf(),
        port,
        host,
        variables: { root: databaseRoot },
        // The built UI, when it exists, at `/storyline` — NOT at `/`. A web mount
        // resolves its prefix by stripping the trailing slash, so `/` becomes the empty
        // prefix and swallows every GET including `/v1/storyline/*`
        // (packages/underload/service/src/server/web.ts:164-170): the API would answer
        // index.html instead of JSON. `/storyline` cannot collide with the API mount.
        webRoutes: staticRoot === null ? [] : [{ route: '/storyline', root: staticRoot }]
    });

    const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;

    return {
        url,
        port,
        host,
        api: `${url}${STORYLINE_MOUNT}`,
        stream: `${url.replace(/^http/, 'ws')}${STORYLINE_STREAM_ROUTE}`,
        config: { ...resolved, port, host, databaseRoot, staticRoot, settings, defaults },
        close: () => server.close()
    };
};

// ---------------------------------------------------------------------------
// The CLI (`yarn workspace @erosire/create-storyline start`)
// ---------------------------------------------------------------------------

const USAGE = `@erosire/create-storyline — the storyline server (an @underload/service gateway)

Usage:
  yarn workspace @erosire/create-storyline start [options]
  npx vite-node src/server/cli.ts [options]        (development)
  yarn start:prod                                   (vite build + the same entry)

The entry is src/server/cli.ts, NOT src/server/main.ts: main.ts only exports the
bootstrap, and vite-node consumes the script path from process.argv, so running
main.ts directly would parse no flags and bind nothing.

This process IS the gateway: it scans this package for \`endpoint\` folders and mounts
what it finds. REST lives at ${STORYLINE_MOUNT} (the harness API, remounted), the live
stream at ${STORYLINE_STREAM_ROUTE} (WebSocket subprotocol harness.v1), and — when
\`dist/\` has been built — the UI at /storyline. One origin for all three.

Options:
  --port <port>          Gateway port (default ${DEFAULT_PORT}; 0 = OS-assigned)
  --host <host>          Host (default 127.0.0.1; 0.0.0.0 for the LAN)
  --database-root <path> Durable root; state lands at <root>/harness/state.json
                         (default <package>/temporary/harness; "" = in-memory)
  --no-static            API only: serve no UI
  -h, --help             Show this help

Environment (precedence: flag -> STORYLINE_* -> HARNESS_* -> default):
  STORYLINE_PORT | STORYLINE_HOST | STORYLINE_DATABASE_ROOT | STORYLINE_STATIC_ROOT
  STORYLINE_PROVIDER_URL (-> HARNESS_BASE_URL)
  STORYLINE_API_KEY (-> HARNESS_API_KEY -> OPENAI_API_KEY)
  STORYLINE_MODEL (-> HARNESS_MODEL)

The review chain (who reviews a finished turn, and how deep that goes):
  STORYLINE_CHAIN        default "${DEFAULT_CHAIN_RULE}"; "" or "off" or "none" disables it
  STORYLINE_CHAIN_DEPTH  default ${DEFAULT_CHAIN_DEPTH} chained turns per user turn

Sessions are created with \`{"harness":"${STORYLINE_PRESET_NAME}"}\`: a writer, a reader
and an editor over one Title. Each session owns the four collections that Title is made of
— \`chapters\`, \`profiles\`, and the ordered sections \`outlines\` and \`storyline\` — with the
three record tools already declared on every turn, and the session title IS the Title's
name (a create that names nothing is filed as "${STORYLINE_DEFAULT_TITLE}").
`;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The CLI body: parse the flags, boot the gateway, print where everything is, and
 * install the signal handlers.
 *
 * Exported and NOT auto-invoked, so importing this file from a test boots nothing;
 * ./cli.ts is the two-line file that calls it (see the note in ./cli.ts about why a
 * file-level entry is the only reliable trigger under vite-node).
 */
export const runCli = async (): Promise<void> => {
    let values: {
        port?: string;
        host?: string;
        'database-root'?: string;
        'no-static'?: boolean;
        help?: boolean;
    };

    try {
        ({ values } = parseArgs({
            allowPositionals: false,
            options: {
                port: { type: 'string' },
                host: { type: 'string' },
                'database-root': { type: 'string' },
                'no-static': { type: 'boolean', default: false },
                help: { type: 'boolean', short: 'h', default: false }
            }
        }));
    } catch (error) {
        process.stderr.write(`${messageOf(error)}\n\n`);
        process.stdout.write(USAGE);
        process.exitCode = 1;

        return;
    }

    if (values.help === true) {
        process.stdout.write(USAGE);

        return;
    }

    try {
        const server = await startStorylineServer({
            flags: {
                ...(values.port === undefined ? {} : { port: values.port }),
                ...(values.host === undefined ? {} : { host: values.host }),
                ...(values['database-root'] === undefined ? {} : { databaseRoot: values['database-root'] }),
                noStatic: values['no-static'] === true,
                help: false
            }
        });

        // The shape the harness dev launcher prints (URL / API / STREAM / DB), with
        // the two facts only this host knows: which preset a session is created from,
        // and where the built UI was mounted (or why there is none).
        console.log(`Storyline gateway listening at ${server.url}`);
        console.log(`  API     ${server.api}`);
        console.log(`  STREAM  ${server.stream} (subprotocol harness.v1)`);
        console.log(`  PRESET  ${server.config.settings.model} via the "${STORYLINE_PRESET_NAME}" harness`);
        // R-C: the one operator-visible fact about the chain — which rule is live, or that
        // an operator turned it off, which is the first thing to check when an agent
        // "forgot" to review.
        console.log(
            server.config.chain.enabled
                ? `  CHAIN   ${server.config.chain.rule} (up to ${server.config.chain.maxDepth} chained turns per turn)`
                : '  CHAIN   off (STORYLINE_CHAIN is empty)'
        );

        if (server.config.staticRoot !== null) {
            console.log(`  UI      ${server.url}/storyline  (${server.config.staticRoot})`);
        } else {
            console.log('  UI      not served (run `yarn build`, or drop --no-static)');
        }

        console.log(`  DB      ${server.config.databaseRoot ?? 'in-memory (no --database-root)'}`);
        console.log('Ctrl+C to stop.');

        const shutdown = (): void => {
            void server.close().then(
                () => process.exit(0),
                () => process.exit(1)
            );
        };

        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
    } catch (error) {
        process.stderr.write(`storyline gateway failed: ${messageOf(error)}\n`);
        process.exitCode = 1;
    }
};

// Nothing runs at import: ./cli.ts is the process entry that calls `runCli()`, which
// is what keeps `import { startStorylineServer } from './main'` free of a bound
// listener (the same import-safety contract `@underload/harness` documents for its
// own barrels).
