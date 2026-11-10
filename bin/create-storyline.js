#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// bin/create-storyline.js — zero-dependency initializer CLI for
// @erosire/create-storyline.
//
// INVOCATION (npm executes the `create-storyline` bin of the
// `@erosire/create-storyline` package; cross-ref package.json "bin"):
//   npm create @erosire/storyline [dir]      → create-storyline [dir]
//   yarn create @erosire/storyline [dir]     → create-storyline [dir]  (yarn@1 maps
//                                            the scoped create to the literal
//                                            unscoped `create-storyline` bin)
//   pnpm create @erosire/storyline [dir]     → create-storyline [dir]
//
// BEHAVIOUR
//   1. Parse `[target-dir]` + `-h|--help` (a stray `--` separator is dropped first).
//   2. No target dir + interactive stdin  → prompt for it (default: storyline-project).
//   3. No target dir + non-interactive    → print usage, exit 1 (CI/npx must be explicit).
//   4. Refuse a target that already exists and is NOT empty → clear error, exit 1
//      (no overwrite/merge, so a typo can never wipe a real project).
//   5. Copy template/ into the target, renaming `_gitignore` → `.gitignore`
//      (npm strips `.gitignore` files from published tarballs, so the template
//      ships the underscore form — same convention as create-vite).
//   6. Rewrite the generated package.json "name" to the slugified target basename.
//   7. Replace the generated README's placeholder heading with the same slug.
//   8. Print next steps, exit 0.
//
// ZERO DEPENDENCIES on purpose: an initializer must install and start instantly,
// so only node builtins are used (node:fs/promises, node:path, node:readline/promises,
// node:url). ESM with no build step (package.json "type": "module").
// ─────────────────────────────────────────────────────────────────────────────

import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

// bin/ → package root → template/. Resolved from the module URL (not cwd) so the
// CLI works from any directory and through the npx/npm-create symlink farm.
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_DIR = join(PACKAGE_ROOT, 'template');

// Fallback package name when the target basename cannot be slugified (e.g. "/").
const DEFAULT_PROJECT_NAME = 'storyline-project';

// create-vite convention: `_gitignore` in the published template → `.gitignore` in the project.
const IGNORE_SOURCE_NAME = '_gitignore';
const IGNORE_TARGET_NAME = '.gitignore';

const USAGE = `Usage: create-storyline [target-dir] [options]

Scaffolds a minimal TypeScript starter project (strict tsconfig, src/index.ts,
npm scripts for build/start, ready-to-commit .gitignore).

Arguments:
  target-dir        Directory to scaffold into. Prompted for when stdin is a TTY;
                    required when stdin is not interactive (CI, plain piping).

Options:
  -h, --help        Show this help and exit
  -v, --version     Show the package version and exit

Examples:
  npm create @erosire/storyline my-app
  pnpm create @erosire/storyline ./my-app
  yarn create @erosire/storyline my-app`;

/**
 * User-facing failure: the message is already formatted (no stack noise), so the
 * top-level catch prints it verbatim and exits 1. Anything that is neither a
 * CliError nor an AbortedError is treated as an unexpected crash and reported
 * with its stack.
 */
class CliError extends Error {}

/**
 * User-initiated abort: the interactive prompt could not be answered (Ctrl+C,
 * Ctrl+D/EOF, or stdin closing under readline). The top-level handler prints a
 * short "Aborted." line with no stack, because cancelling is not a crash.
 */
class AbortedError extends Error {}

/**
 * Minimal argv parsing — `npm create` forwards everything after `--` to the bin,
 * so only a single optional positional plus the help/version flags are accepted.
 * Any other flag or a second positional is a hard error: silently ignoring typos
 * (e.g. `--tile my-app`) would scaffold into the wrong place.
 */
const parseArgs = (argv) => {
    const result = { target: null, help: false, version: false };
    // npm/yarn/pnpm normally consume the `--` separator themselves, but invoking the
    // bin directly (`node bin/create-storyline.js -- my-app`) forwards it verbatim.
    // Drop every bare `--` token before parsing (create-vite-style tolerance) so the
    // remaining arguments behave exactly as if the separator had never been passed;
    // `--` before a flag (`-- --help`) likewise resolves to that flag.
    for (const arg of argv.filter((value) => value !== '--')) {
        if (arg === '-h' || arg === '--help') {
            result.help = true;
            continue;
        }
        if (arg === '-v' || arg === '--version') {
            result.version = true;
            continue;
        }
        if (arg.startsWith('-')) {
            throw new CliError(`Unknown option: ${arg}\n\n${USAGE}`);
        }
        if (result.target !== null) {
            throw new CliError(`Unexpected extra argument: ${arg}\n\n${USAGE}`);
        }
        result.target = arg;
    }
    return result;
};

/**
 * Turns a directory basename into a valid npm package name:
 * lowercase, every run of invalid characters collapsed into a single `-`,
 * leading/trailing separators stripped ("npm name cannot be empty" guard →
 * DEFAULT_PROJECT_NAME). Mirrors what other initializers do (create-vite).
 */
const slugifyProjectName = (value) => {
    const slug = value
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^[-._]+|[-._]+$/g, '');
    return slug === '' ? DEFAULT_PROJECT_NAME : slug;
};

/**
 * Guard for step 4: the target may be missing (normal) or an EXISTING EMPTY
 * directory (e.g. a freshly created folder from a GUI), both of which are fine.
 * Anything else — a non-empty directory or a regular file — aborts, because this
 * CLI never overwrites and never merges.
 */
const ensureTargetAvailable = async (target) => {
    let info;
    try {
        info = await stat(target);
    } catch (error) {
        // ENOENT is the expected path (target will be created below); anything
        // else (EACCES, ELOOP, ...) is a genuine problem worth reporting.
        if (error.code === 'ENOENT') return;
        throw new CliError(`Cannot inspect ${target}: ${error.message}`);
    }
    if (!info.isDirectory()) {
        throw new CliError(`Target path is a file, not a directory: ${target}`);
    }
    const existing = await readdir(target);
    if (existing.length > 0) {
        throw new CliError(
            `Target directory already exists and is not empty: ${target}\n` +
                `Refusing to overwrite ${existing.length} existing entr${existing.length === 1 ? 'y' : 'ies'}. ` +
                'Pick a different target directory.'
        );
    }
};

/**
 * Recursive template copy (replaces `fs.cp` so the `_gitignore` rename and the
 * node_modules skip can happen while walking). copyFile preserves the source
 * mode bits; the template contains only plain files and directories.
 */
const copyTemplate = async (source, destination) => {
    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries) {
        // Defensive: a local `npm install` inside template/ must never leak into a scaffold.
        if (entry.name === 'node_modules') continue;

        const from = join(source, entry.name);
        const to = join(destination, entry.name === IGNORE_SOURCE_NAME ? IGNORE_TARGET_NAME : entry.name);

        if (entry.isDirectory()) {
            await mkdir(to, { recursive: true });
            await copyTemplate(from, to);
            continue;
        }
        await copyFile(from, to);
    }
};

/**
 * Name substitution: the copied package.json gets the slugified target basename.
 * Re-serialised with 4-space indent + trailing newline (repo JSON convention, see
 * scripts/sync-versions.ts:124) and with key order preserved, because JSON.parse
 * keeps insertion order of the template file.
 * A parse failure is downgraded to a warning + verbatim copy: a broken template
 * name should not abort an otherwise complete scaffold.
 */
const applyProjectName = async (target, slug) => {
    const packageJsonPath = join(target, 'package.json');
    const raw = await readFile(packageJsonPath, 'utf8');
    try {
        const pkg = JSON.parse(raw);
        pkg.name = slug;
        await writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 4)}\n`, 'utf8');
    } catch (error) {
        console.warn(`Warning: could not rewrite package.json name (${error.message}); kept the template name.`);
    }
};

/**
 * README title substitution: the template README opens with the placeholder
 * heading `# storyline-project` (same placeholder as the package.json name), so a
 * generated project would otherwise still say "storyline-project". Only the exact
 * leading heading text is swapped for `# <slug>` — the remainder of the file is
 * re-written untouched (no line splitting, so line endings are preserved) and the
 * rest of the template README stays verbatim.
 * A read/write failure only warns: a cosmetic title must not abort a complete scaffold.
 */
const applyProjectTitle = async (target, slug) => {
    const readmePath = join(target, 'README.md');
    // DEFAULT_PROJECT_NAME is the template placeholder ("storyline-project"), so
    // the heading to look for is derived from it rather than hard-coded twice.
    const heading = `# ${DEFAULT_PROJECT_NAME}`;
    try {
        const raw = await readFile(readmePath, 'utf8');
        if (!raw.startsWith(heading)) return;
        await writeFile(readmePath, `# ${slug}${raw.slice(heading.length)}`, 'utf8');
    } catch (error) {
        console.warn(`Warning: could not rewrite README title (${error.message}); kept the template title.`);
    }
};

/**
 * Interactive prompt (step 2) — only ever called when stdin is a TTY. node's
 * readline/promises rejects the pending question() when the prompt is cut short:
 * Ctrl+D/EOF raises AbortError ("Aborted with Ctrl+D") and the input stream
 * closing rejects it the same way. Neither is actionable as a stack trace, so both
 * become an AbortedError the top-level handler reports as a clean `Aborted.` line.
 */
const promptForTarget = async () => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = await rl.question(`Project directory [${DEFAULT_PROJECT_NAME}]: `);
        return answer.trim() === '' ? DEFAULT_PROJECT_NAME : answer.trim();
    } catch {
        throw new AbortedError();
    } finally {
        // close() in finally so a Ctrl+C / rejected question still releases stdin.
        rl.close();
    }
};

/** Prints the package version (read from package.json — no build-time injection needed). */
const printVersion = async () => {
    const pkg = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    console.log(`${pkg.name}@${pkg.version}`);
};

/** Success output: relative path when it sits inside cwd, absolute otherwise. */
const printNextSteps = (target, slug) => {
    const fromCwd = relative(process.cwd(), target);
    const display = fromCwd === '' ? '.' : fromCwd;
    console.log(`\nCreated ${slug} in ${resolve(target)}`);
    console.log(`\nNext steps:\n  cd ${display}\n  npm install\n  npm run build\n  npm start`);
    console.log('\nAdjust the package manager in the commands above if you use yarn or pnpm.');
};

const main = async () => {
    const args = parseArgs(process.argv.slice(2));

    if (args.help) {
        console.log(USAGE);
        return;
    }
    if (args.version) {
        await printVersion();
        return;
    }

    let rawTarget = args.target;
    if (rawTarget === null) {
        // Step 3: non-interactive runs must be explicit about the directory.
        if (!process.stdin.isTTY) {
            throw new CliError(`No target directory given and stdin is not interactive.\n\n${USAGE}`);
        }
        rawTarget = await promptForTarget();
    }

    const target = resolve(process.cwd(), rawTarget);

    // Fail fast with a helpful message if the published package is missing its template.
    try {
        await stat(TEMPLATE_DIR);
    } catch {
        throw new CliError(`Template directory not found next to the CLI: ${TEMPLATE_DIR}`);
    }

    await ensureTargetAvailable(target);
    await mkdir(target, { recursive: true });
    await copyTemplate(TEMPLATE_DIR, target);

    // Slug derived from the RESOLVED target basename, so `./my-app/` and `/x/my-app`
    // both produce `my-app`; slugifyProjectName covers the `/` root case (basename '').
    const slug = slugifyProjectName(basename(target));
    await applyProjectName(target, slug);
    await applyProjectTitle(target, slug);

    printNextSteps(target, slug);
};

// Top-level handler: CliError → plain message, AbortedError → bare "Aborted." (a
// cancelled prompt is not a failure worth a stack), anything else → stack for
// debugging. process.exitCode (not process.exit) so queued stdout writes flush first.
main().catch((error) => {
    if (error instanceof CliError) {
        console.error(`\nError: ${error.message}`);
    } else if (error instanceof AbortedError) {
        console.error('\nAborted.');
    } else {
        console.error(`\nUnexpected failure: ${error?.stack ?? error}`);
    }
    process.exitCode = 1;
});
