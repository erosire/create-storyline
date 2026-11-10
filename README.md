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
