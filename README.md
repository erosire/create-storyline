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
  `journal.jsonl`; the journal is the state, and a restart replays it). **A Story is a book**: the
  server opens a workspace at the store root — one `Store` per Story under `<root>/stories/<uuid>/`
  (with that Story's harness files beside it) and an app book at `<root>/server/` for the crew
  catalogue and the host settings — and `src/server/runtime/` gives each book its own isolated
  runtime (loop, executor, knowledge projection, thread log) behind one sweep, one fan-out ceiling and
  one SSE feed. The REST API is mounted
  at `/v1/storyline`, and `GET /v1/storyline/stream` is a server-sent events feed of the Store's
  own commit groups (a `ready` frame first, then one frame per commit, debounced).
- **UI** (`src/dashboard/`) — the Author's desk: the compact Stories panel with an attention-first
  phrase rail, the tabbed home desk (Requests / Create New Story), the pane-aware directive bar, the
  crew rail, the Ideas tray, the Goal panel and the prose editor. It dials the same origin at
  `/v1/storyline` and holds no authoritative state; `src/dashboard/api.ts` is its only transport.
- **The Summary workspace** — the rail's one phrase is Summary, and under it the rail lists the
  Summary's five **groups** (Premise, Promise, Theme, Tone, Ending), each badged with what it owes:
  `to write` while it has no revision, a Writer mark while a live pass is replacing its text, and the
  count of open blocking findings. The Summary pane is the composed **Overview** plus one pane per
  group; each group pane shows that group's own revision number, its text, its findings, and a
  **Revise** control that rewrites that group alone. Superseded revisions are counted, not listed —
  the history stays in the book. A Story whose Summary is still written as one text (the legacy
  `summary_mode: 'sampling'` shape) keeps the older sampling-round pane instead, including its two
  counts and its revision list; nothing has to be migrated for that book to read correctly.
- **The HTTP contract** is `src/storyline-server.swagger.yaml` (OpenAPI 3.0.3), the same pattern as
  the harness server's contract: every route, body, projection, status code, and the SSE feed at
  `/v1/storyline/stream` in one document. The UI renders server projections and mutates only through
  these operations; it never imports a server module, calls the model provider, or executes a harness
  tool directly. The Summary's own verbs are `GET /v1/storyline/stories/{id}/phrases` (the
  grouped view; a legacy book answers `mode: 'sampling'`), `POST .../phrases/import` (the Author's
  explicit, idempotent move of a legacy Summary onto groups), `POST
  .../phrases/groups/{groupId}/revise` (rewriting ONE group — `409` while a Writer pass holds it,
  naming the runs that hold it, and `409` while the group stands **locked**, naming the revision and who
  locked it — the unlock verb releases it), and the pair that settles a group's status — `POST
  .../phrases/groups/{groupId}/lock` and `POST .../phrases/groups/{groupId}/unlock`. Both answer `404` for
  a group the book does not have and `409` for a group with nothing written, one already locked (or not
  locked), a group a Writer pass holds, or a Story whose Summary is still the legacy whole-text shape (the
  refusal names `.../phrases/import`). The Author's hand needs no setting; the Editor's seat is the only
  path gated on `editor_group_locking`.
  The whole-Summary verbs — `summary/revise`, `revisions/{id}/select`,
  `revisions/merge` — answer `409` on a grouped Story and the refusal names the verb to use instead;
  the crew's tools for the same moves are refused on that book too — `editSummary`, a Summary
  `selectRevision`, and a `requestMerge` whose advice now points at a finding rather than at the
  selection workflow — so nothing, Author or employee, is directed at the model the group design
  replaced.
- **The product contract** is `documents/specifications.md`. Every behaviour note in the code cites the
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
harness is runtime configuration — the roles, the tools, the criteria and the caps are templates
defined in code at server boot; changing them is a code change and a restart:

| Variable                      | Meaning                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `STORYLINE_PROVIDER_BASE_URL` | OpenAI-compatible root — `chat/completions` for runs, `models` for the roster dropdown; defaults to `http://localhost:8800/providers/private/v1` |
| `STORYLINE_PROVIDER_MODEL`    | the model every crew run asks for unless its agent or template role names one                                                                    |
| `STORYLINE_PROVIDER_API_KEY`  | its key; empty means the provider is unauthenticated                                                                                             |

Loop knobs, for an operator who needs them and for nobody else: `STORYLINE_GLOBAL_MAX_CONCURRENT`
(a hard cap on simultaneous runs — and the one of these the Author may also move on screen, as the
**Max threads** dropdown beside the employee roster's name: the rail's choice is remembered with the
book and rules when this variable is unset, and when the variable IS set it outranks the rail on every
boot), `STORYLINE_SWEEP_INTERVAL_MS` (how often the loop wakes; `0` means the Author drives it by hand),
`STORYLINE_LEASE_IDLE_MS` (when an abandoned run's lease is stealable).

**What the Summary asks of you.** A Story's Summary is written group by group: a Writer pass rewrites
a batch of groups (`summary_sampling` is how many groups one pass may take) and its answer installs
the moment it is accepted — there is no set of competing drafts to compare, and the text it replaces
stays in the book as that group's history. An install also **re-arms the reading**: the new text is a
new thing to read, so `summary_critics` structured seats open over the Overview as installed, then the
same number of deep-review passes, and what they report becomes findings that name the groups they are
about. An open finding is what routes the next rewrite, and a finding naming several groups is closed
only once every group it names has been rewritten — a three-group complaint under a batch of one is
three sweeps of work, and the finding stays open (with its repair task open) until the last group
answers it. A group gets **two** rewrite attempts **against the text it holds at that moment** — that
is a bound on re-drafting ONE text, not a lifetime ceiling on the group: a successful install resets
the count, so a group rewritten cleanly and criticised again has a fresh pair against the NEW text, a
rewritten Seed resets the allowance along with the text, and the reading passes never spend it. When
the two are spent the loop stops paying for that group and leaves the finding open in your review rail
with its attempts visible, so the recovery is on the finding — decide it, or rewrite the group yourself
with the Revise control. Nothing installs a least-bad text and nothing re-arms a stall by itself. The
Summary is not offered for sign-off until that reading has happened: while seats or deep passes are
owed on the text currently installed, the loop keeps the Story `ready` instead of offering
`phase_signoff`, and the Accept button stays blocked while a group is unwritten, a blocking finding is
open, or a Writer is mid-rewrite on a group. A Story whose Summary is still the legacy whole-Summary
shape (`summary_mode: 'sampling'`) keeps the older rules and their escalation rows: it writes
`summary_sampling` competing drafts per round, installs only one, and a round that finds nothing
acceptable installs NOTHING — it keeps the text it had, buys attempts while each measurably improves on
the best it has proved, and stops (with one question in your queue) when the attempts stop proving
anything. Deleting a Story is a purge: its rows — the Summary's groups, its Overview and their revision
history included — its harness, its threads and its `<root>/stories/<uuid>/` folder go together, and a
root still holding a flat `store.json` is refused rather than silently migrated.

**Locking a group is opt-in, and only you can turn it on.** Group locking is off by default: the Story's
settings carry **Editor may lock phrase groups** (`editor_group_locking`, absent means off), and its tooltip
says what turning it on gives the Editor. The lock control itself is always there — every group pane has
**Lock this group in**, which asks you to confirm twice because a lock commits a revision: it stops that
group being editable, voids the findings aimed at it, and starts the other four groups adapting to the text
that now stands. The control is disabled, with the reason in its tooltip, when the group has nothing
written, is already locked, or is held by a live Writer pass. With the setting on, the Editor gains one
review that is not a rewrite: once per section per clean reviewed Overview — and only when that section's
current text IS the clean selection's text, its Reader score row for that exact Overview carries a written
rationale, no Writer holds it, and it has not answered before — its seat reads the section, the Critic's
open claims and Proposals naming it, the Reader's rationale, and the locked peers, then locks the group or
declines, in either case with the reasons it weighed. There is no score line to hit: the number is evidence,
never a threshold, and no setting tunes one. A lock holds the text — the pane's Revise block shuts, the
revise verb answers `409`, and a Writer install that names a locked group is refused whole rather than
half-applied — and it retires the claims that can no longer be worked: a finding whose EVERY group is
locked becomes `discarded`, one that also names an unlocked group keeps those groups as its scope, and the
crew is refused when it files a new finding aimed only at locked text. What a lock does NOT do is sign the
phase off: that is the separate **Lock** on the phase (`summary_locked`), and the Summary still owes its
reading passes whether or not any group stands — the lock seat is an offer, never owed work, so turning the
setting on changes no acceptance rule, no drain line and no count. Only you can lift a lock, whoever set
it, with **Unlock this group** — and that control is shut, with the same Writer-hold reason the lock's
carries, while a pass is replacing the group, because the unlock verb answers `409` for exactly that
(R4). Flipping the setting off changes no lock, it only stops the Editor being
asked again. Locks do not outlive the rows they anchor: a rewritten Seed takes every group back to revision
0 and lifts its locks with it (a lock over an empty section would freeze something nobody judged), and a
**backtrack** lifts them too — it keeps each group's words but deletes the revision history the lock is a
record about, so the flag would name a row that no longer exists and block every install that named the
group. What keeps a lock is a backtrack that deletes no revision history at all (backing up to the chapters
phase): there the flag still names live text.

### Employees, agents, harnesses, sessions and threads

Storyline's roster members are **employees** — Writer, Editor, Researcher, Critic, Reader — not agents. An
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
  Story the first time it dispatches work. The five employees are the same roster in every Story —
  **Writer, Editor, Researcher, Critic, Reader** — but each Story's harness has its own tool registry,
  transcripts and threads, so no state crosses between books.
- **A phase is a session.** The engine has no session object, so Storyline owns that level: the
  Story's `summary` / `plotlines` / `chapters` phase is a session record (the UI calls it a
  "phrase", P1/P2/P3) holding the threads that phase caused. Note the two uses of the word: the
  rail's "phrase" is this SESSION/reading surface — today exactly one, Summary — while the
  **Summary Phrase**'s *groups* are the five writable parts inside it (`shared/phrase.ts`). They are
  different levels, and nothing in the store branches on the rail's word.
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
  model would read — and answers as the template the brief names: a Writer calls `createPlotline` /
  `editChapter` (a grouped Summary's `draft_groups` run answers with a structured `GroupDraft` —
  one `{group_ref, content}` per group in its batch — and no tool call; on a legacy book the sampler
  answers with a structured `SummarySample`; a grouped book's `score_sections` run answers with a
  structured `SectionScores` — one `{group_ref, score, rationale, evidence}` per section, a number the
  loop displays and never decides on), a Reader calls `submitVerdict` with the criteria the
  brief briefed it on, a Critic files findings (a `review_groups` seat answers with a structured
  `GroupReview`, every issue carrying its `group_refs`; a legacy screening Critic answers with an
  `IssueList`). A refusal the tool layer gives is recorded with its rule id, so a test asserts the
  rule the crew hit.
- `src/server/integration/*.test.ts` boots the real server on port 0 and drives it with `fetch`:
  `slice-phases` (Seed → Summary → Plotlines, the Ideas tray and the lock gates), `slice-chapters`
  (chapters, the finding → repair ladder, the drain that proposes completion), `slice-ops`
  (stop/resume, backtrack, the section edit and undo, the assistant run, kill, restart from the
  journal). The engine's own internals stay in `src/server/loop/*.test.ts`.
- Sweeps are never the clock: every suite starts the engine with `autoSweep: false` and calls
  `engine.sweep()` / `engine.settle()` as an explicit Author action, so a test cannot pass by
  waiting.
