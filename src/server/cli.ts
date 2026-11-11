// §10 / W9-W13 — the Storyline server CLI (T7). `yarn start` runs `./start.ts`, which calls `run()` here.
//
// ALL IT DOES IS FLAGS, BANNER, SHUTDOWN. The precedence chain (flag → `STORYLINE_*` env → default) is
// `../config.ts`'s job, the composition is `./main.ts`'s job, and the routes are `./api/`'s job; a CLI
// that also decided defaults would be a second place to change the address of the product.
//
// WHY THE BANNER LIVES HERE: it is the operator's answer to "which book did I open, and where do I
// point the dashboard". Printing the RESOLVED values rather than the flags is the point — the same
// reason `resolveServerConfig` keeps `flags` on the config it returns.
import { resolveServerConfig } from './config';
import { bootStorylineServer } from './main';
import {
    DEFAULT_PROVIDER_BASE_URL,
    PROVIDER_API_KEY_ENVIRONMENT,
    PROVIDER_BASE_URL_ENVIRONMENT,
    PROVIDER_MODEL_ENVIRONMENT,
    DEFAULT_PROVIDER_MODEL
} from './api/server';
import type { StorylineFlags } from './config';
import type { StorylineServerHandle } from './api/server';

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export const HELP_TEXT = `Storyline — the loop the Author drives.

Usage: create-storyline [options]

  --port <n>          port to listen on (0 = the OS picks one)   [${'STORYLINE_PORT'}]
  --host <addr>       interface to bind                          [${'STORYLINE_HOST'}]
  --store-root <dir>  where store.json + journal.jsonl live;
                      an empty value runs in memory              [${'STORYLINE_STORE_ROOT'}]
  --database-root     alias for --store-root
  --no-static         API only: do not serve the built dashboard [${'STORYLINE_STATIC_ROOT'}]
  -h, --help          this text

Environment: ${PROVIDER_BASE_URL_ENVIRONMENT}, ${PROVIDER_MODEL_ENVIRONMENT}, ${PROVIDER_API_KEY_ENVIRONMENT}
             point the crew at a model; everything else about the harness is on the Template cards.`;

/** The flags this CLI knows, as a set, so an unknown one is a message rather than a shrug. */
const VALUE_FLAGS: Record<string, keyof StorylineFlags> = {
    '--port': 'port',
    '--host': 'host',
    '--store-root': 'storeRoot',
    '--database-root': 'storeRoot'
};

/**
 * Parses argv into `StorylineFlags`. Both spellings of a value flag work (`--port 5000` and
 * `--port=5000`), because operators type both and a parser that accepts one reads like a bug.
 *
 * A value flag given twice keeps the LAST one, and a blank value is passed through as `""` on purpose:
 * `--store-root ""` is the documented way to ask for an in-memory run, and that distinction is the
 * difference between a book and a scratchpad (see `config.ts`'s resolution note).
 */
export function parseArgs(argv: string[]): StorylineFlags {
    const flags: StorylineFlags = { noStatic: false, help: false };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];

        if (arg === undefined) continue;

        if (arg === '--help' || arg === '-h') {
            flags.help = true;
            continue;
        }

        if (arg === '--no-static') {
            flags.noStatic = true;
            continue;
        }

        const [name, inlineValue] = arg.includes('=')
            ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
            : [arg, undefined];
        const target = VALUE_FLAGS[name];

        if (target === undefined)
            throw new Error(`unknown option "${arg}". Run with --help for the options this server takes.`);

        if (inlineValue !== undefined) {
            (flags[target] as string) = inlineValue;
            continue;
        }

        const next = argv[index + 1];

        if (next === undefined)
            throw new Error(`${arg} needs a value. Run with --help for the options this server takes.`);

        (flags[target] as string) = next;
        index += 1;
    }

    return flags;
}

// ---------------------------------------------------------------------------
// The banner
// ---------------------------------------------------------------------------

/** The two-line startup read: where the book is, where to look, and what the crew talks to. */
export function bootBanner(
    handle: StorylineServerHandle,
    book: { storeRoot: string | null },
    env: Record<string, string | undefined>
): string[] {
    return [
        `Storyline is listening on http://${handle.host}:${handle.port}/v1/storyline`,
        `dashboard: ${env.STORYLINE_DASHBOARD_HINT ?? 'http://localhost:4510 (vite dev) or the same origin once the UI is built'}`,
        `harness: ${env[PROVIDER_BASE_URL_ENVIRONMENT] ?? DEFAULT_PROVIDER_BASE_URL} · model ${env[PROVIDER_MODEL_ENVIRONMENT] ?? DEFAULT_PROVIDER_MODEL}`,
        `book: ${book.storeRoot === null ? 'in-memory — this run leaves no book behind' : `durable — store.json + journal.jsonl under ${book.storeRoot}`}`
    ];
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/**
 * Parses, resolves, boots, and installs the signal handlers. Returns the handle so a caller (the direct
 * run below, or a test) can close it; `run()` is what `yarn start` actually executes.
 */
export async function start(argv: string[] = process.argv.slice(2)): Promise<StorylineServerHandle | null> {
    let flags: StorylineFlags;

    try {
        flags = parseArgs(argv);
    } catch (error) {
        console.error(String(error instanceof Error ? error.message : error));

        return null;
    }

    if (flags.help) {
        console.log(HELP_TEXT);

        return null;
    }

    const config = resolveServerConfig({ flags });
    const handle = await bootStorylineServer({
        port: config.port,
        host: config.host,
        storeRoot: config.storeRoot,
        staticRoot: config.staticRoot
    });

    // The operator reads where the book is, where to look, and what the crew talks to (W9). The store root
    // comes from the RESOLVED config, not the flags, so a default or an env override prints honestly.
    for (const line of bootBanner(handle, { storeRoot: config.storeRoot }, process.env)) console.log(line);

    const shutdown = (signal: string): void => {
        // One shot each: a second Ctrl-C must not race a close that is already flushing the journal. The
        // line goes out BEFORE the exit — `process.exit` ends the turn, so anything chained after it is
        // never written, and an operator watching a silent hang cannot tell L-3 from a wedged store.
        console.log(`${signal} — stopping the sweep and flushing the book (L-3).`);

        handle
            .close()
            .then(() => process.exit(0))
            .catch(() => {
                console.error(
                    'the book did not flush cleanly — the journal still holds what the store never got (L-3).'
                );

                return process.exit(1);
            });
    };

    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));

    return handle;
}

/**
 * The `yarn start` path — `./start.ts` is the program and calls this. A bad store root is a startup error
 * with the store's own sentence, exit 1.
 */
export async function run(argv: string[] = process.argv.slice(2)): Promise<void> {
    try {
        await start(argv);
    } catch (error) {
        console.error(`Storyline could not start: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}

// No boot side effect here on purpose: this module is imported by `api/server.test.ts` (for the flag
// grammar and the banner) and by `./start.ts`, which is the program. See that file's header for why the
// guard cannot live here.
