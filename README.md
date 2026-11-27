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

## Storyline UI

This package is the Author's desk — the browser workstation that renders what the Storyline server
sends. It is **UI only**: the server (the loop, the Store, the tool catalogue, the REST/SSE transport)
lives in the separate `@underload/storyline` package/repository and is never imported here.

- **The UI** (`src/dashboard/`) — the compact Stories panel with the phrase rail, the tabbed home desk,
  the pane-aware directive bar, the crew rail, the Ideas tray, the Goal panel, the prose editor and the
  phrase panes (Summary groups, Plotlines chapters, Seed views). It holds no authoritative state:
  components render store snapshots, and `src/dashboard/api.ts` is the only transport.
- **The wire types** (`src/types.ts`) — TYPE DEFINITIONS ONLY: the §4 record shapes the server sends.
  There is no runtime product data in this package (no phrase catalog/composition, criteria roster,
  Seed hash or default dials); those live in `@underload/storyline` and arrive in the Story projection
  (`StoryView.vocabulary`) or in the phrase reads. Test-only mocks live under `src/dashboard/testing/`.
- **The transport** — one root, `/v1/storyline`. `vite.config.ts` proxies it in development
  (`STORYLINE_DEV_TARGET`, default `http://127.0.0.1:5000`), and `GET /v1/storyline/stream` is the SSE
  feed the store follows. Listing reads are requested in chunks (`?limit=&offset=`, default 50 rows);
  Stories, the queue, runs and employee threads each append the next chunk from a "Load more" control
  instead of fetching the whole workspace up front. The OpenAPI contract lives with the server
  (`@underload/storyline`'s `src/storyline-server.swagger.yaml`).
- **The product contract** — `documents/specifications.md`. The server package's `knowledge.md` is the
  map to it, and the code here cites the same requirement ids (`L-`, `D-`, `U-`, `S-`, `T-`, `G-`, `E-`,
  `P-`, `V-`) the documents define.

### Running it

```bash
yarn workspace @erosire/create-storyline dev        # the UI on http://localhost:4510
yarn workspace @erosire/create-storyline build      # dist/ — the dashboard bundle
yarn workspace @erosire/create-storyline preview    # serve the built bundle
yarn workspace @erosire/create-storyline test       # vitest run
yarn workspace @erosire/create-storyline typecheck  # tsc --noEmit
```

`dev` is Vite only: it proxies `/v1/storyline` to wherever the server is actually running, so the
browser stays same-origin with the API while you work on the UI. Build the UI and serve `dist/` from
the server when you want one origin.

```bash
# from this package's directory
yarn vite dev
```

### Server boundary

The dashboard is a client of the server and nothing else. `src/dashboard/server-boundary.test.ts`
enforces it: production code under `src/dashboard/` may import the type-only `src/types.ts`, but it may not
import a server module or `@underload/harness`, and network I/O lives in exactly one file
(`src/dashboard/api.ts`). The server package has no dependency on this one either — the only agreement
between them is the wire.
