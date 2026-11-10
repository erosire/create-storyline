# @erosire/create-storyline

Zero-dependency initializer that scaffolds a minimal TypeScript starter project for Storyline.

## Usage

```bash
npm create @erosire/storyline            # prompted for the directory
npm create @erosire/storyline my-app     # explicit directory
npm create @erosire/storyline@latest my-app
```

```bash
yarn create @erosire/storyline my-app
pnpm create @erosire/storyline my-app
```

Every form resolves this package (`npm create X` runs `create-X`) and executes its
`create-storyline` bin. Extra flags: `-h, --help` prints usage, `-v, --version` prints the version.

## What you get

```
package.json    private ESM package, scripts: build (tsc) / start (node dist/index.js) / typecheck
tsconfig.json   strict, ES2022 target, NodeNext module + resolution, rootDir src → outDir dist
src/index.ts    small strictly-typed demo entry
.gitignore      node_modules, dist, coverage, logs, .DS_Store
README.md       install/build/start instructions
```

The generated `package.json` `name` is derived from the target directory name
(lowercased, invalid characters replaced with `-`), defaulting to
`storyline-project`. The template ships `_gitignore`, which the CLI renames to
`.gitignore` because npm strips `.gitignore` files from published tarballs.

## Behaviour notes

- The target directory is prompted for when stdin is a TTY; non-interactive runs
  must pass it explicitly, otherwise the CLI prints usage and exits `1`.
- An existing, non-empty target directory aborts with a clear error — nothing is
  ever overwritten or merged.

## Requirements

- Node.js >= 20

## Storyline app

This package is also a runnable application, not only an initializer: a storyline
server plus the workstation UI that drives it.

- **Server** (`src/server/`) — an `@underload/service` gateway endpoint that wraps
  `@underload/harness`. It registers the `storyline` preset — a `writer` (primary), a
  `reader` and an `editor` — with the harness's built-in `chapters` and `profiles`
  record tools pre-enabled, and serves it at REST `/v1/storyline/*` and over the live
  stream `/v1/storyline/stream` (WebSocket subprotocol `harness.v1`).
- **UI** (`src/dashboard/`) — a `@underload/dashboard` composition: chapter rail,
  agent stage, and story library, talking to that mount
  (`src/api/root.ts` pins the client root to `/v1/storyline`).

### Running it

```bash
yarn workspace @erosire/create-storyline dev      # UI on http://localhost:4510
yarn workspace @erosire/create-storyline start    # package-scoped gateway on :5000
yarn workspace @erosire/create-storyline build    # dist/, which `start` then serves at /storyline
```

`dev` proxies `/v1/storyline` (REST **and** the socket upgrade) to the gateway on
`http://127.0.0.1:5000`; point it elsewhere with `STORYLINE_DEV_TARGET`.

`start` is its own gateway: it scans **only this package** for `endpoint` folders, so
one origin serves `/v1/storyline`, `/v1/storyline/stream`, and — once built — the UI at
`/storyline`.

```bash
yarn start-service                               # repo root: the shared gateway
```

The shared gateway scans the whole repository, so it auto-discovers
`packages/erosire/create-storyline/src/server/endpoint/storyline` and mounts
`/v1/storyline` beside `/v1/harness`. It resolves endpoints **at startup**: a gateway
that is already running needs a restart before the storyline route appears.

### Environment

Precedence is always `CLI flag` → `STORYLINE_*` → `HARNESS_*` → built-in default, so an
existing harness deployment needs no new variables while `STORYLINE_*` still allows the
two to run side by side with different providers.

| Variable | Fallback | Default |
| --- | --- | --- |
| `STORYLINE_PORT` | — (the harness has no port variable) | `5000` |
| `STORYLINE_HOST` | — | `127.0.0.1` |
| `STORYLINE_DATABASE_ROOT` | — | `temporary/harness` (`""` = in-memory) |
| `STORYLINE_STATIC_ROOT` | — | `dist` when it exists |
| `STORYLINE_PROVIDER_URL` | `HARNESS_BASE_URL` | `http://localhost:5500/providers/private/v1` |
| `STORYLINE_API_KEY` | `HARNESS_API_KEY` → `OPENAI_API_KEY` | empty |
| `STORYLINE_MODEL` | `HARNESS_MODEL` | `local/basalt` |

### Port 5000 caveat

`start` **is** a gateway, and a gateway calls `killPort` on its port before binding
(`packages/underload/service/src/server/start.ts:241`). At the default that means
`yarn start` takes over `:5000` — the port the shared `yarn start-service` gateway uses
— so with the shared gateway running, start this one elsewhere:
`start --port 5100` (or `STORYLINE_PORT=5100`), and point the dev proxy at it with
`STORYLINE_DEV_TARGET=http://127.0.0.1:5100 yarn dev`.

