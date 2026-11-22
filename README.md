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

The package is also a runnable application: the loop the Author drives, plus the workstation
that drives it, from one origin.

- **Server** (`src/server/`) — a Hono app started by `startStorylineServer`
  (`src/server/api/server.ts`). It owns the loop (`src/server/loop/`), the §8 tool catalogue
  (`src/server/tools/`), the brief builder (`src/server/run/`), the provider client
  (`src/server/llm/`) and the event-journal Store (`src/server/store/` — `store.json` plus
  `journal.jsonl`; the journal is the state, and a restart replays it). The REST API is mounted
  at `/v1/storyline`, and `GET /v1/storyline/stream` is a server-sent events feed of the Store's
  own commit groups (a `ready` frame first, then one frame per commit, debounced).
- **UI** (`src/dashboard/`) — the Author's desk: the Stories panel, the Author's queue, the crew
  rail, the Ideas tray, the Goal panel, the phase strip, the prose editor. It dials the same
  origin at `/v1/storyline`.
- **The contract** is `documents/specifications.md`. Every behaviour note in the code cites the
  id it serves (`L-` loop, `D-` design decision, `U-` UI, `S-` service, `T-` tool, `G-` goal,
  `E-` engine, `P-` principle, `V-` vocabulary), so a reader can go from a line of code to the
  paragraph that demanded it, and back.

### Running it

```bash
yarn workspace @erosire/create-storyline start        # vite-node src/server/start.ts
yarn workspace @erosire/create-storyline start:prod   # vite build, then start
yarn workspace @erosire/create-storyline dev          # the UI on http://localhost:4510
yarn workspace @erosire/create-storyline build        # dist/ — the dashboard bundle
yarn workspace @erosire/create-storyline test         # vitest run
yarn workspace @erosire/create-storyline typecheck    # tsc --noEmit
```

`start` serves the API at `/v1/storyline` and, when `dist/` exists, the built dashboard from the
same port. `dev` is Vite only: it proxies `/v1/storyline` to wherever the server is actually
running (`STORYLINE_DEV_TARGET`, default `http://127.0.0.1:5000`), so the browser stays
same-origin with the API while you work on the UI.

```bash
# from this package's directory
npx vite-node src/server/start.ts --port 5100 --store-root "" --no-static
```

### Flags and environment

Precedence is `flag` → `STORYLINE_*` → built-in default.

| Setting              | Flag                                     | Variable                | Default                                                  |
| -------------------- | ---------------------------------------- | ----------------------- | -------------------------------------------------------- |
| Port                 | `--port`                                 | `STORYLINE_PORT`        | `5000` ( `0` = the OS picks )                            |
| Interface            | `--host`                                 | `STORYLINE_HOST`        | `127.0.0.1`                                              |
| Where the book lives | `--store-root` (alias `--database-root`) | `STORYLINE_STORE_ROOT`  | `temporary/storyline`; an **empty value runs in memory** |
| Built dashboard      | `--no-static`                            | `STORYLINE_STATIC_ROOT` | `dist` when it exists, otherwise no static root          |

The crew needs a model. Exactly three variables say where it is, and nothing else about the
harness is configuration — the roles, the tools, the criteria and the caps are Template cards the
Author edits in the running product:

| Variable                      | Meaning                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `STORYLINE_PROVIDER_BASE_URL` | OpenAI-compatible root — `chat/completions` for runs, `models` for the roster dropdown; defaults to `http://localhost:8800/providers/private/v1` |
| `STORYLINE_PROVIDER_MODEL`    | the model every crew run asks for unless its agent or template role names one                                                                    |
| `STORYLINE_PROVIDER_API_KEY`  | its key; empty means the provider is unauthenticated                                                                                             |

Loop knobs, for an operator who needs them and for nobody else: `STORYLINE_GLOBAL_MAX_CONCURRENT`
(a hard cap on simultaneous runs), `STORYLINE_SWEEP_INTERVAL_MS` (how often the loop wakes;
`0` means the Author drives it by hand), `STORYLINE_LEASE_IDLE_MS` (when an abandoned run's lease
is stealable).

### Employees, agents, harnesses, sessions and threads

Storyline's roster members are **employees** — Writer, Editor, Reader, Checker — not agents. An
employee is the standing identity (kind, rank, model, permission row); it becomes an **agent** only
while a **thread** is executing. Only a Rank A employee may own a dispatched Work Item and act on a
phase's requirements; a Rank B employee may be added only as a delegation target inside a Rank A
thread (specification V-1/V-2). The rest of this section follows that vocabulary.

The **Editor** is the Author's one channel. The directive bar writes a `directives` record addressed
to the Editor; a `directive_work` review thread reads the direction and calls `createTask` for the
work it implies. The sweep then reads that queue and opens a fresh thread per task — the Editor
queues Work Items, while delegation (D-17e) stays inside one run. "Entry" is not a roster concept and
is never projected to the dashboard; the harness's internal session route names the Editor.

Storyline uses `@underload/harness` as an **engine only**. It does not boot the harness
server, mount a `HarnessRuntime` or accept a `HarnessBootConfiguration`; this package's Hono
server (`src/server/api/server.ts`) is the only server and owns every Story decision.

- **One harness per Story.** `src/server/run/story-engine.ts` builds an engine `harness()` for a
  Story the first time it dispatches work. The four employees are the same roster in every Story —
  **Writer, Editor, Reader, Checker** — but each Story's harness has its own tool registry,
  transcripts and threads, so no state crosses between books.
- **A phase is a session.** The engine has no session object, so Storyline owns that level: the
  Story's `summary` / `plotlines` / `chapters` phase is a session record (the UI calls it a
  "phrase", P1/P2/P3) holding the threads that phase caused.
- **A Run is a thread.** Each dispatched Work Item (and each panel agent or delegated
  sub-context) opens a host thread in its Story's harness with the assembled brief as the system
  turn. The employee named by the template role is the agent for that thread's lifetime. The
  engine executes the model/tool loop; Storyline keeps its §8 tools, permission rows, run rows,
  tally, panel aggregation and delegation rules.

`GET /v1/storyline/agents` is the global status projection the right-hand tile panel renders:
one row per employee kind, its model, and its live threads grouped by the Story + phase session
they belong to. Selecting a Story changes the centre; the employee tiles stay global. The tile
shows the model the employee asks for, and `PATCH /v1/storyline/agents/:kind` with `{ model }` sets
it (or `{ model: null }` clears it back to the template role's model, else
`STORYLINE_PROVIDER_MODEL`). The tile also lists any template role that names its own `model`
(T-6b), so a crew-specific model is never invisible.
`GET /v1/storyline/agents/models` proxies the provider's OpenAI-compatible catalog
(`{STORYLINE_PROVIDER_BASE_URL}/models`), and the tile's model editor is a dropdown over those ids —
never free text, because a model the provider does not serve cannot run.

The Explorer's browsing tools (`web.open`) use `EXA_API_KEY` or `TAVILY_API_KEY`. With neither
set, browsing is unavailable and the tool says so in the refusal — a crew with no web access
forms thinner Ideas, which is a fact about the run and not a story defect.

### How it is tested

The suites are deterministic without a model, because the crew is not asked to be clever in a
test — it is scripted from what its brief actually says:

- `src/server/llm/mock.ts` is a `ChatClient` whose answers come from a handler. The integration
  harness (`src/server/integration/harness.ts`) reads each run's BRIEF — the same bytes a real
  model would read — and answers as the template the brief names: a Writer calls `editSummary` /
  `createPlotline` / `editChapter`, a Checker calls `submitVerdict` with the criteria the brief
  briefed it on, a Reader calls `proposeIdea`. A refusal the tool layer gives is recorded with its
  rule id, so a test asserts the rule the crew hit.
- `src/server/integration/*.test.ts` boots the real server on port 0 and drives it with `fetch`:
  `slice-phases` (Seed → Summary → Plotlines, the Ideas tray and the lock gates), `slice-chapters`
  (chapters, the finding → repair ladder, the drain that proposes completion), `slice-ops`
  (stop/resume, backtrack, the section edit and undo, the assistant run, kill, restart from the
  journal). The engine's own internals stay in `src/server/loop/*.test.ts`.
- Sweeps are never the clock: every suite starts the engine with `autoSweep: false` and calls
  `engine.sweep()` / `engine.settle()` as an explicit Author action, so a test cannot pass by
  waiting.
