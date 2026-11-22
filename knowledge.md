# @erosire/create-storyline Knowledge

The loop the Author drives: a Story is a Goal plus a crew that keeps working on it until it runs
out of work, and an Author who owns every decision the loop stops for.

> **Last verified:** 2026-11-11, against the tree as it stood after the §15 integration suites
> landed (`src/server/integration/`). Every path and sentence quoted here was read out of a
> running server — the values come from the integration tests that assert them, and those tests
> pass. Behaviour this file claims but no test pins is marked as such. No code was touched by
> this pass beyond the four fixes named in [Fixes this pass made](#fixes-this-pass-made).

## What the product is

`documents/specifications.md` is the contract; this file is the map to it. The one sentence that
explains the shape of everything: **the loop never decides anything the Author has reserved, and
the Author never does the work the loop owns.** A run stops at a sign-off rather than rolling
into the next phase (L-29); a criterion the crew cannot judge is the Author's call, not a score
(L-22); an Idea in the tray is a decision nobody else may take (U-15).

The requirement ids in code comments are the wiring between a line and the paragraph that
demanded it: `L-` loop, `D-` design decision, `U-` UI, `S-` service/run, `T-` tool layer, `G-`
Goal/criteria, `E-` engine, `P-` principle, `V-` vocabulary (Actor, employee, agent, thread, rank).

## The stack, bottom up

| Layer     | Path                      | What it owns                                                                                                                                                                                                                                                                                                   |
| --------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The book  | `src/server/store/`       | The §4 collections, the event journal, `store.json` + `journal.jsonl`. `Store.empty()` / `Store.load(root)`; the constructor is private. Commits are applied immediately, persisted on a 25ms debounce, flushed by `persist()`/`close()`.                                                                      |
| Criteria  | `src/server/criteria/`    | Resolves a Story's Goal, aggregates verdicts into `n/m` per level, and decides which criteria a phase can still move on.                                                                                                                                                                                       |
| Tools     | `src/server/tools/`       | The §8 catalogue (Writer/Editor/Checker/Reader/Explorer/assistant), every guard: CAS on the row a write rides (T-4), the phase/lock gates (T-8, T-11), the `why` requirement (T-5), a verdict's target kinds, the tray rules. A refusal names its rule id and the row it refused on.                           |
| Brief     | `src/server/run/brief.ts` | The one artefact a crew sees: `# ROLE — <role> (<kind>) of <template>`, the phase, the unit under review, the criteria briefed, the etiquette, and the Author's directives. Hashed onto the Run row (S-2).                                                                                                     |
| Runs      | `src/server/run/`         | Spawn → lease → tool calls → report → teardown (S-1, S-3, S-4). A Run row exists before the first token (D-18). The model/tool loop itself runs on the `@underload/harness` engine, in the Story's own harness thread (`run/story-engine.ts`).                                                                 |
| Loop      | `src/server/loop/`        | The sweep (L-1), dispatch and its caps (§6.7), work-item production (`work.ts`/`listJobs`), sign-off and lock (`engine.lockPhase`), drain and completion (L-35b, L-37, L-25), directives, backtrack, kill.                                                                                                     |
| API       | `src/server/api/`         | `routes.ts` is the Author's verbs; `projections.ts` is what the panel and the desk read; `server.ts` binds the process (port, provider triple, SSE at `/v1/storyline/stream`). `src/storyline-server.swagger.yaml` is the OpenAPI contract for every route; `src/dashboard/api.ts` is the UI's only transport. |
| Dashboard | `src/dashboard/`          | The workstation: `state.ts` (one store over an `ApiClient`), the panels in `components/`, the shell in `StorylineApp.tsx`.                                                                                                                                                                                     |

## Things that are easy to get wrong

- **A Story row has no `state`.** The panel's `status` (`ready` / `pending` / `stopped` /
  `completed` / `sealed`) and `pending_kind` (`none` / `phase_signoff` / `idea_selection` /
  `finding_review` / `proposal_review` / `completion` / `drained` / `stopped`) are both derived by
  `projections.ts:storyRow` from the Story's flags plus the Goal. `blocked_on` and `status_reason`
  are the human half of the same decision. A stop is a `status`, not a pending kind.
- **`levels` is `n/m`, and an unreached level is `n/a` (L-14).** A fresh Story reads
  `{"summary":"1/2 · failing: C-14","plotlines":"n/a","chapters":"n/a","whole":"n/a"}` — the
  failing list is the point of the string, not decoration. `completion_preview` and the queue are
  on the Story **view**, not on the panel row.
- **The Story row is a ref target.** C-4/C-10/C-11/C-13 aggregate over the Story row
  (`criteria/engine.ts:scopeTargets`), so `submitVerdict`/`raiseFinding` must resolve a `story_1`
  reference — `tools/artifacts.ts:RESOLVABLE` lists `stories` first and `inStoryScope()` treats a
  Story row's own id as its scope, because a §4.1 Story row carries no `story_id`.
- **Divergence is not a dial field.** `tools/artifacts.ts:isDivergenceMode` reads
  `stories.template_refs`; every built-in Writer carries `attempts > 1`, so a default Story files
  competing drafts from its first attempt (D-3d). The dial itself is `PATCH /stories/:id` with
  `auto_approve: Cost[]` (D-35), and it is the whole ladder: verify → approve → task → repair.
- **`chapter_count` lives on the Summary**, not on the Story (D-3b), and the chapter set is
  materialised by the Plotlines **lock** (D-3c) — not by a Writer.
- **A phase's unit ref differs per phase**: phase ① is the Summary row id, phase ②'s set-level
  work is the empty ref `''`, phase ③'s units are chapter ids. `loop/work.ts` treats `''` as the
  set, and a `ref === ''` unit is not "already drafted" (see Fixes below).
- **Sweeps are Author actions.** `engine.sweep()` returns `{stories: [{status, pending_kind,
dispatched, deferred}]}`; `engine.settle()` drains the in-flight runs. Tests drive both
  explicitly (`autoSweep: false`) so nothing passes by waiting.
- **The Ideas tray is gated by the phase Goal, and probe rounds only fire while the phase still
  has work.** A phase whose Goal passes short-circuits to `pending/phase_signoff` with its probe
  round deferred — `{ "wi_probe_reader_summary_1": "not dispatched: phase_signoff" }` — and a
  `drained` Story defers the tray's verify jobs — `{ "wi_verify_ideas_1_2_idea_1": "not
dispatched: drained" }`. Ideas land while a phase is still working, which is why §15 step 1's
  "tray blocks the lock" needs a withheld criterion to be reachable at all.

## The Author's verbs (routes.ts)

`POST /stories` (Seed + `chapter_count` → Story + empty Summary + Goal), `GET /stories`,
`GET /stories/:id`, `PATCH /stories/:id` (title/idea/chapter_count/`auto_approve`),
`DELETE /stories/:id` (P1: stop, delete the knowledge directory, every story-scoped §4 row and the
Story, then dispose its harness — sessions and threads go with it),
`POST /stories/:id/stop|resume|clear-pending|lock`, `POST /stories/:id/backtrack {phase}`,
`PATCH /stories/:id/goal {criteria:[{op:add|remove|setHard}], threshold_soft}`,
`POST /stories/:id/directives {text, refs?}`, `POST /stories/:id/assistant {target,text}`,
`POST /stories/:id/complete`, `POST /stories/:id/templates`,
`POST /stories/:id/chapters/:chapterId/sections/:sectionId {content}` (D-37: only while stopped),
`POST /stories/:id/chapters/:chapterId/unapprove`, `PATCH /stories/:id/chapters/:chapterId/bar`,
`POST /stories/:id/chapters/:chapterId/findings/approve-all {why}` (U-10b's "approve a whole chapter's
worth": every `confirmed` finding whose `target_ref` OR L-11a `related_refs` name the chapter, one
`approve_finding` commit each — pinned by `api/approve-all.test.ts`),
`POST /stories/:id/revisions/:revisionId/select {note?}` (U-13 / D-24: the Author's override, which
installs the draft, deletes the siblings and sets `current_revision`) and
`POST /stories/:id/revisions/merge {unit_ref,revision_ids,parts}` (U-13a / D-23: opens a `merge` task;
the drafts stay competing), pinned by `api/revision-routes.test.ts`,
`POST /stories/:id/undo {chapter_id, section_id}`, the finding `approve|discard` and Idea
`select|discard|defer` decisions, the proposal `accept|reject` pair, `POST /runs/:id/kill`,
`GET /queue` (a bare array, every Story, oldest first), `GET /runs?story_id=`,
`GET /stream` (SSE: a `ready` frame, then one per commit group).

Lock gates, in order: the Ideas tray first (`cannot lock <phase>: N Ideas still in the tray — each
must be selected, discarded, or deferred first (L-7a, D-29)` — the tray is every UNDECIDED Idea of the
phase, `loop/records.ts:undecidedIdeas`, so an Editor verdict on a row does not release the lock), then
the Goal (`cannot lock phase <phase>: its Goal is not met — 6/7 · failing: C-0 (U-16…)`). A completed
Story answers `status: "completed"`, and completing it discards whatever the tray still held — which is
the number U-14's prompt states, counted from the same `DISCARDABLE_IDEA_STATES` set
(`loop/status.ts:leftovers`, `api/projections.ts:completionPreview`).

## Holes and honest deviations

- **No turn cap in a session** (E-0): a crew that re-issues a refused call grows the transcript
  until the process dies. The test crew caps itself at three turns; a real model stops asking.
- **A finding a crew re-files after it was repaired restarts the ladder.** T-10's `already_open`
  guard only covers a finding that is still open; a scripted Checker that files the same flaw
  every round keeps the loop repairing chapter 3 forever.
- **`POST /complete` has no tray gate.** `engine.acceptCompletion` completes over a tray of
  undecided Ideas and discards them; only the phase lock refuses on the tray (L-7a).
- **The assistant run reports `role: "writer"`** on its Run row and `work_item_ref:
"assistant_<story>_<run>"`; the plumbing role is reused rather than a distinct one. §7's assistant
  COLUMN is now real in two places the row alone used to hide it: the run is offered no web tools
  (`run/catalogue.ts:toolsForRunKind`, U-1e — pinned by `run/assistant-run.test.ts`), and every write
  it makes records `attribution.assistant: true` so the audit tells "the machine, on the Author's
  instruction" from a dispatched crew run (§2/D-8 — `tools/assistant-attribution.test.ts`).
- **A Task row DOES carry a finding pointer** — §4.7's `finding_ref` (`shared/types.ts:399`) — and it
  is how the sweep finds the fix work again (`loop/records.ts:findingsTasks`,
  `loop/invalidation.ts:createFixTask`). What is NOT on the row is the unit: the unit comes from the
  finding's own `target_ref`, so a task whose finding was discarded has no way back to a unit except
  through the journal.
- **No route restores a superseded Revision.** `POST /undo` rewinds one §4.4 SPAN (L-17a), and the
  Author's select deletes the losing drafts (D-22); a draft lost to a selection is recoverable only by
  reading the journaled row. P11's "attributable" holds; "revertible" does not.
- **The merge verb has no pane control.** `mergeRevisions` exists on the client, the store and the
  shell, and `RevisionsCompare` explains it, but there is no widget that collects the `parts` prose the
  route requires — the merge brief has nowhere to be typed yet, so the route is driven from the API.
- **The stalled screen's first exit is a backtrack, not a contract editor.** L-23's exit 1 is "edit the
  unlocked contract, OR backtrack"; `story-stalled-review.tsx` ships the backtrack button and points at
  the Summary/plotline panes below for the edit, because editing a locked contract is a propose-only
  proposal (D-6), not a write from this pane.
- **`api/projections.ts:TOOL_GAP_TASK_KINDS` lists a `digest_gap` task kind that never exists.**
  `digest_gap` is a FINDING criterion ref (`server/digest/digest.ts:DIGEST_GAP_CRITERION`); D-13's
  repair is routed through the finding, never through a task of that kind, so the third entry is dead
  and the queue's tool-gap flavour is really two kinds.
- **Directives propagate synchronously** in the route (`state: 'done'` when the POST answers), and
  at phase ① their `impact` list is legitimately empty — there are no plotlines or chapters for a
  sentence to land on.
- **No server-side "current verb" projection** for the crew rail (U-8c): a Run row carries
  `work_item_ref/kind/role/state/no_op/delegated/tokens/brief_hash/end_reason`, so the pane shows
  the work item, not a verb.
- **The prose pane's undo stack is per-chapter and only as deep as the Author's edits**
  (`nothing to undo on chapter_1 — the chapter has no undo stack (L-17a)`).

## Fixes this pass made

Three tool-layer/loop bugs the §15 walk exposed, each pinned by an integration test:

1. `tools/artifacts.ts` + `tools/checker.ts` — a Story row is now a resolvable ref target and a
   legal verdict target. Before: `submitVerdict(target_ref: "story_1")` was refused
   (`T-11 "story_1" is a story, not a summary or plotline or chapter`), so C-4 and every
   whole-level criterion could never be filed and a phase could never pass.
2. `tools/writer.ts:editSummary` — in divergence mode a competing Summary attempt files a draft
   instead of overwriting the row. Before: three blind writers each wrote the Summary in place
   (last write won, T-4 races) and the Editor's select job was never produced.
3. `loop/work.ts:draftedBefore` — the set-level unit (`ref === ''`) is not "already drafted", the
   same way `judgedBefore` already treats it. Before: the `wi_write_` prefix matched every Writer
   run in the phase, so phase ② never dispatched its own Writer and C-0 sat at 0/3 forever.

## Fixes the review pass made (round 2)

Eight spec gaps the review found, each pinned by a test that names the spec id:

1. **U-3a** — the `digest_gap` acceptance gate was keyed on the wrong condition, so a crew's
   `digest_gap` finding never widened the Digest it was complaining about. `tools/checker.ts` now
   accepts it by criterion ref (not by cost), and the builder's next pass renders the expanded detail
   (`digest.ts`'s header line reads `… expanded detail (open digest_gap, D-13)`). Refusal copy in
   `permissions.ts` / `writer.ts` / `plumbing.ts` says which rule and which fix.
   Pinned by `tools/digest-gap.test.ts`, including the expansion round-trip.
2. **U-13 / U-13a** — the Author's revision verbs (`…/revisions/:rid/select`, `…/revisions/merge`)
   existed only as a button whose comment promised an API. Both routes exist now, with the D-22 sibling
   delete and the D-23 `merge` task, and the shell binds them. `api/revision-routes.test.ts`.
3. **U-1e** — §7's assistant row has no web column: an `assistant` Work Item's session is no longer
   offered `searchWeb`/`fetchPage` (`run/catalogue.ts:toolsForRunKind`, applied in
   `run/executor.ts:RunScope.tools` and forwarded to the panel and the delegate), and its writes carry
   `attribution.assistant`. `run/assistant-run.test.ts`, `tools/assistant-attribution.test.ts`.
4. **C-0** — the chapter-count criterion passed on a shortfall while the Story had zero chapters and
   ignored surplus. `criteria/engine.ts:checkChapterCount`; four cases in `criteria/engine.test.ts`
   (both right, 7-of-8, surplus, and the vacuous zero-chapter case, which stays a pass — L-14).
5. **D-36** — the lock emptied the tray in two places that disagreed, and one of them spared
   `selected` rows. `invalidation.ts:deletePhaseTray` now calls `records.ts:deletePhaseIdeas`, which is
   the single definition and deletes every state of the phase. `loop/d36-tray.test.ts`.
6. **U-10b** — "approve a whole chapter's worth": the route, the client verb, the store action, the
   shell binding and a button on the chapter row that counts the same rows the server approves
   (`target_ref` OR `related_refs`, L-11a). `api/approve-all.test.ts`, `PlotlineChapters.test.tsx`,
   `shell-binding.test.ts`.
7. **U-1a / L-23** — the stalled screen was a status line. `level_history` is projected into the Story
   view (`api/projections.ts`, `api/level-history.test.ts`) and
   `components/story-stalled-review.tsx` renders the review surface: stuck criteria, oldest open
   findings, chapters involved, one line per round in L-14's own level sentence, and L-23's four exits
   as buttons (backtrack / selection_rules / directive / lower the bar). `sendDirective` is now bound
   in the shell.
8. **Housekeeping** — every source file formatted (`prettier --check` clean), and three invented spec
   ids in the §15 integration tests replaced with the real ones (`U-18`→`L-31, L-32`;
   `U-19`→`U-5, P11`; `U-23`→`U-10`).

## Where to start reading

`src/server/loop/engine.ts` (the sweep and the states), `src/server/loop/work.ts` (what work the
loop can even propose), `src/server/api/projections.ts` (what the Author is told),
`src/server/tools/index.ts` (what the crew may do), `src/server/integration/harness.ts` (a crew
that only ever sees its brief), and `documents/specifications.md` §15 for the walk all of it is
built to survive.

## The knowledge directory and the employee roster (2026-11-22)

The dashboard's left rail carries the Story's phrase navigator and its right rail carries the
global employee roster. Both are projections, and neither is a second source of truth:

- **The directory** (`src/server/knowledge/story-knowledge.ts`) writes through the harness's
  cross-session knowledge engine (`createKnowledgeEngine` + `loadKnowledgeFileStore`) — the same
  engine the `knowledge` tool uses. One article per section; the eight sections are Summary,
  Plotlines, Chapters, Characters, Continuity, Goal, Ideas, Findings. The bytes live at
  `<storeRoot>/harness/knowledge/`, outside every session, so a destroyed harness or a restart
  cannot take them away. The book is still the authority: every store commit re-derives the
  section articles, and an empty section keeps a placeholder paragraph so its folder stays
  visible. `GET /stories/:id/knowledge` syncs, flushes, and answers the whole tree. **The rail no
  longer renders this directory** (2026-11-22): it is a server projection for the `knowledge`
  tool and a future reading surface, while the left rail is now the Story's phrase navigator
  (`src/dashboard/components/StoryOutline.tsx`).
- **The employee roster** (`src/server/run/story-engine.ts`) is fixed and global: Writer, Editor,
  Reader and Checker, all at Rank A (the harness's peers, so rank alone delegates to nobody). The
  Editor is the Author's one channel — a directive is addressed to it, and it turns the direction
  into the tasks the loop runs. That is routing, not a rank and not an entry role: `entry` no longer
  exists on the client contract or the roster projection, and the harness's own session route names
  the Editor (`STORY_AGENT_ENTRY`).
  VOCABULARY (specification V-1): these four are EMPLOYEES, not agents. An employee is the standing
  identity (kind, rank, model, permission row); it becomes an AGENT only while a thread executes.
  Only a Rank A employee may own a dispatched Work Item and act on a phase's requirements; a Rank B
  employee may be added only as a delegation target inside a Rank A thread (V-2). `GET /agents`
  projects one row per employee kind with its model and live status. The right-hand tile panel
  renders that projection; selecting a Story never changes the roster. The thread DETAIL is not on
  the rail: clicking a tile calls `GET /agents/:kind/threads`, which projects every thread that
  employee ever ran (across every Story and phase session — the UI's "phrase", P1/P3/P4, oldest
  first) and the dashboard replaces the centre with those bars. Each bar is one thread, labelled
  P1/P3/P4 for the phase session it belongs to; opening it shows the request and the answer. The
  retained log lives at `<storeRoot>/harness/threads.jsonl`
  (`src/server/run/thread-log.ts`), so a harness disposal or a process restart does not prune the
  history; legacy Run rows with no retained transcript are still listed from the book with
  `retained: false`. Each tile's model line is the same resolution the executor uses
  (`src/server/run/agent-models.ts`): the Author's explicit choice for that employee kind wins, then
  the template role's own model, then the process model. The tile also lists the template roles
  that name a model, so clearing a choice cannot silently fall back to something the Author did not
  expect. The choice is set by `PATCH /agents/:kind` and persisted in the store snapshot's
  `settings` section — host configuration, deliberately outside §4's journal. `GET /agents/models`
  proxies the provider's OpenAI-compatible catalog
  (`{STORYLINE_PROVIDER_BASE_URL}/models`, default `http://localhost:8800/providers/private/v1/models`)
  and the tile's model editor is a dropdown over that catalog, so a name the harness cannot ask for
  cannot be selected.
- **One harness per Story, one session per phase, one thread per Run.** `StoryHarnessManager`
  owns a lazily-built engine `harness()` per Story, so tool registries, transcripts and threads
  are isolated by book. The Story's phase is Storyline's session record (the engine has no session
  object), and every dispatched Work Item, panel agent or delegated sub-context opens a thread
  inside it. The engine executes the loop; Storyline keeps the §8 catalogue, permission rows, the
  brief, the run rows, the panel and the template delegation rules.
- **The server is Storyline's.** `@underload/harness` is imported as the engine only. There is no
  `HarnessBootConfiguration`, no harness-server session store and no `variables.harness`: the
  service route forwards only `variables.root`, and the Storyline Hono app remains the one control
  plane.
- The components are `src/dashboard/components/StoryOutline.tsx`, `StoryView.tsx`,
  `AgentsPanel.tsx` and `AgentThreadsView.tsx`; the dashboard store keeps
  `knowledge: story_id -> tree`, `agents`, `selectedAgent` and `agentThreads: kind -> thread[]`
  beside the §4 rows.

### The phrase rail and the focused content area (2026-11-22)

The left rail is the Story's navigator, not its knowledge listing. `StoryOutline.tsx` renders
the four reading phrases in order — **Phrase 1 Summary**, **Phrase 2 Characters**, **Phrase 3
Plotlines**, **Phrase 4 Chapters** — each with the entries under it (the Summary's `Overview`;
one child per cast member, plotline and chapter), then the **Seed** leaf and the supporting
folders: **Continuity**, **Goal**, **Ideas**, **Findings**, **Digest** and **Settings**. The old
knowledge header's subtitle, note count and "one article per folder" sentence are gone: the
rail makes one decision (which pane is open), so it carries no commentary.

`StoryView.tsx` renders exactly the selected phrase or folder. The stacked view (Seed + phase
strip + status + dial + Summary + Ideas + plotlines/chapters + revisions + Goal + costs + Digest)
was replaced; the status line is the one piece of chrome above the pane, and the right-hand rail
carries the employee roster. The three columns stay in place on every view. The pane switch:

- **Summary** — `SummaryPane`. It marks the phrase with a tick when
  `story-nav.ts:summaryReadyForReview` is true (the Summary is signed, or the Summary phase's
  Goal passes with prose present). Competing Summary revisions (`unit_kind: 'summary'`) render as
  overview candidates; the newest verdict filed **on a draft** with `hard_pass` and
  `recommendation: 'advance'` marks that draft "Editor recommends", and every draft has its own
  Select (`POST /stories/:id/revisions/:revisionId/select`, D-24). A unit-level verdict never
  names a column, so it does not create a recommendation.
- **Characters** — `CharactersPane`. It reads `view.cast` (the §4.5 sheet added to the Story view
  beside `view.ledger`) and shows want / need / arc / voice / state now. It can ask the Editor to
  start or update the cast through the directive route; **Characters is a supporting phrase, not
  yet a `StoryPhase`**, so the loop does not dispatch a crew for it.
- **Plotlines** — `PlotlinesPane`, the contracts only; **Chapters** — `PlotlineChapters` with
  `onlyChapterRef`, the prose (and its contract) under one chapter or the whole grouped set.
- The folders render `GoalPanel`, `IdeasTray`, the new `FindingsPane` / `ContinuityPane` /
  `DigestPane` / `SettingsPane` (the D-35 dial and the cost distribution), and `SeedPane`.

`GET /stories/:id` now also projects `cast` and `ledger` (both ordinary §4 collections) so the
Characters and Continuity panes never re-derive a record client-side. `PHASE_LABELS` no longer
carries circled numbers: the four-phrase rail owns the numbering, and the loop controls name the
artifact they sign ("Lock phase Summary").

## The Author's channel, and the directive flow (2026-11-22)

The Author talks only to the **Editor**. A directive is one line of direction, recorded as a
`directives` row and then reviewed by a real Editor thread:

1. `POST /stories/:id/directives` calls `engine.processDirective` → `recordDirective`
   (`src/server/loop/directives.ts`). That half is the server's: resolve the artifacts the sentence
   names, widen them one hop through `chapter_deps`, mark `needs_recheck`, stop the runs writing
   into a changed artifact, answer an open escalation, re-arm a `pending` Story to `ready`, and
   re-open a `completed` one (L-27). The row stays `propagating` with `tasks_created: 0`.
2. The next sweep sees it through `pendingDirectives` and `generateWork` opens one
   `directive_work` Work Item at priority 0, assigned to the Editor (`work.ts`). The brief
   (`run/brief.ts`) carries the directive text and the artifact refs the server resolved; the
   Editor's job is `createTask` calls for the work, never a story artifact of its own.
3. `settleJob` closes the directive when the review thread ends (`completeDirective`), counting the
   task rows the run created via the journal's `run_ref`. If the review queued nothing — or the
   thread failed — `createDirectiveFallbackTasks` queues the deterministic one-task-per-artifact
   plan so the Author's direction is never dropped. A Story with no Editor assigned falls back the
   same way in the route.

This is the boundary the user drew between the Editor and a **delegate**: the Editor queues Work,
and the server's sweep opens a fresh thread per Work Item (S-1). The Editor never fans out to
Writers inside its own run.

The UI follows that model:

- The Story row in the left rail is a toggle: clicking the open Story closes it and returns the
  Author to the queue, not only the centre's Dismiss. While an employee's thread surface is open,
  the first click on that Story row returns to the Story; a left-rail phrase/folder click also
  clears the employee selection, because both rails are navigation (U-4/U-8).
- `DirectiveBar` is the last child of the content region (`StorylineApp.tsx`), so it sits at the
  bottom of the content, not as a window-wide footer. It speaks for the rail's selection: the label
  and placeholder name the Summary, a chapter, a plotline, etc., and `sendDirective` carries that
  artifact's refs so the Editor updates the content in focus even when the sentence never names it
  (2026-11-22). On screens at or below 820px the stylesheet docks it to the viewport as a minimal
  composer — one field and a send glyph, no label row or hint, with `safe-area-inset-bottom`
  respected.
- `AgentsPanel` renders the roster only: rank, model, status. The old `entry` chip and the
  `AgentStatusRow.entry` field are gone. The roster and its templates are defined in code at server
  boot; the UI offers no template editor.

## Phase ① is a sampled Writer → Reader → Editor pipeline (2026-11-22)

The Summary is no longer drafted and immediately handed to an Editor. The Author set the phase to
a sampled review loop, and both counts are the Author's settings:

- **The Seed is reviewed before it is expanded.** One Editor thread (`wi_seed_review_<story>_<hash>`)
  reads the Author's Seed for the six things a Summary needs (protagonist, want, obstacle, stakes,
  world, change) and reports with `reviewSeed`. `accept` lets the Writers start; `restructure` queues
  an Author escalation naming the missing structure. The key follows the Seed TEXT, so an Author edit
  (D-25a) re-arms the review and `writeTrigger` refuses the first draft until the new review closes.
- **Sampling** — `writer-summary` ships `attempts: 5`, and a Story may override it with
  `stories.summary_sampling` (`POST /stories` or `PATCH /stories/:id`). Ten means ten Writers
  expanding the Seed into ten competing Summary drafts.
- **Readers per sample** — `stories.summary_readers`, standard five, set by the same routes and by
  the two count controls in `SummaryPane`. Each completed draft gets that many Reader passes.
- **The order is per draft, not per stage.** A Writer files its revision as `pending` and keeps
  extending the same row until its run returns; when the run closes, the loop promotes the draft to
  `drafted` and only then generates Reader jobs (`wi_read_<revision>_a<n>`). So a Reader starts on
  the first finished sample while other Writers are still running, and never on a half-written one.
  A revised draft is a new revision with fresh Readers.
- **Readers read the Seed and ONE draft.** The Work Item carries `revisionRef`, and the brief's
  revision section renders only that draft (D-21 keeps the rest from a Reader). The job tells the
  Reader to file `raiseFinding` with an evidence line and to rate the draft with `submitVerdict`;
  a Reader never edits (D-26, D-30, T-9).
- **The Editor verifies each critique in its own thread before choosing.** One
  `wi_verify_finding_<finding>` run per report (never a batch across findings); `verifyFinding`
  confirms or disputes it, and `approveFinding decision:auto` lets the Story's dial create the fix
  task for a covered `critical`/`major` finding. The Editor's `select` waits until every competing
  draft has all its Reader passes closed and no finding is unconfirmed — the choice is the last
  look, never the first.
- **A Reader then confirms the approved finding independently.** One
  `wi_confirm_finding_<finding>` run per `critical`/`major` approval; `confirmFinding` records the
  Reader's own check as `reader_confirmed`. Phase ①'s Writer fix waits for that flag
  (`fixWork`), and a `dispute` withdraws the queued fix in the same commit — so no Writer spends a
  round on a claim only the Editor believed.
- **A revision is one corrected draft.** `divergenceGap` stops sampling once an Editor selection
  exists, so a valid critique sends back one `wi_fix_*` Writer job, not the whole sampling set
  again. That draft gets its own Readers, the Editor verifies them, and the loop repeats until a
  selection leaves no valid finding and the phase Goal passes. A phase sign-off also waits while a
  confirmed finding's fix task is still open, so the correction is never parked by the stop.
- No consistency checker runs in phase ① in this pipeline: the review crew is the Readers and the
  Editor, as the Author specified. Checkers still serve phases ② and ③.

`src/server/loop/summary-pipeline.test.ts` pins the plan (two drafts × five Readers each, no
Editor choice early) and `src/server/integration/summary-review.test.ts` pins the real-server
order, including a valid critique returning to the Writer as a new read-then-selected draft.

## A draft is Pending until its Writer returns, then Drafted for the review crew (2026-11-23)

§4.15's two new states are the phase ① order made mechanical:

- **`pending`** — the row a Writer files on its first `editSummary`/`editChapter`. A later write in
  the same run extends that row instead of filing a second, partial draft. No Reader, Checker or
  Editor is offered a `pending` row.
- **`drafted`** — the row after the Writer's run closes. `loop/engine.ts:settleJob` promotes it in
  the same commit that closes the run, and a sweep-time `reconcileDrafts` catches a draft written
  after its run ended (or recovered after a restart). For a Summary, `drafted` also requires every
  §4.2 block to be present (`shared/summary.ts`).
- **The incomplete case is Writer work, not a stall.** A Summary short of a block stays `pending`,
  and `loop/work.ts:summaryCompletionJobs` opens ONE `wi_complete_<unit>_<revision>_<n>` Writer job
  whose think-note the brief renders (`THE JOB` — "is still pending: it is missing …"). That run
  adopts the same draft (`tools/artifacts.ts:pendingDraftFor`, completion runs only — a fresh
  sampling attempt stays blind, L-16) and adds the blocks. Readers start only after it is complete.
- `competing` stays in the enum as the historical spelling of a reviewable draft, so a store written
  before this change still reads correctly. `pending`/`drafted` are in the Swagger enum and in
  `documents/specifications.md` §4.15.

## The Writer thread that died at its context limit (2026-11-23)

`StoryHarness` correlates a model request to its Run by the seeded brief, because the engine's
stream request carries no thread id. That mapping used to be deleted when `sendThreadInput`
resolved — but the engine's `context-compaction` plugin ends a host turn on its own SUMMARY and
continues the conversation as a SECOND run on the SAME thread, so the continuation's request found
no brief and the harness answered "the writer harness received a request whose brief names no
Storyline Run". The Author saw a Writer thread fail at ~297k tokens with that sentence. The mapping
now lives for the thread's life (`run/story-engine.ts:run`/`prune`), so compaction can continue the
conversation; pinned by `run/story-engine.test.ts` ("keeps a thread's brief after its run
resolves").

## The Reader threads that died with the same sentence (2026-11-23)

The same sentence had a second cause, and it was the harness's, not Storyline's: the engine's
request-only shrink (`planCompactionRequest`) clipped **every** head entry in its first pass,
including the LEADING `system` entry — a host's standing instruction. Storyline's brief IS that
entry, so the shrink clipped an 11,194-character Reader brief to 240 characters plus
`… [truncated by compaction]`, and the Reader's next turn could no longer be attributed to its run.
A delivery-relief pass (`relieveDeliveryWeight`, raised when `listRevisions`/`readVerdicts` came
back between requests) was the pass that did it: five Reader passes on `revision_42` each died after
two provider turns, ~30k tokens in. `planCompactionRequest`'s Pass A now exempts the leading
`system` run (the rule Pass B and `planCompactionRetention` already followed for DROPS — clipping a
standing instruction is worse, because it is silently rewritten rather than withheld); pinned by
the harness's `engine/plugin/context-compaction.test.ts` ("never CLIPS a leading system entry").
Storyline needs no change: the brief still reaches the model verbatim on every turn.

## The compact story row and the tabbed desk (2026-11-22)

The left rail's Story row is now a navigation decision, not a report: title plus **one** mark —
`needs your signature`, `needs your pick`, `needs your approval`, `nothing left to act on`, or
`stuck` — and nothing else. The levels, phase strip, trend, `status_reason`, crew line and the
per-row moves left the row. The Story's own phrase rail carries the detail: `story-nav.ts`'s
`storyAttention` turns `pending_kind` plus the open Findings, Ideas, Summary drafts and completion
preview into highlighted rail entries (`StoryOutline`), so opening a Story shows _where_ the Author
is needed without repeating the server's report in the list. Stop/Resume/Clear/Delete appear on the
open row only.

The home view is two tabs (`components/HomeDesk.tsx`):

- **Requests** — the Author's queue (`AuthorQueue`). A finding, Idea, escalation or capability gap
  only appears when it needs a decision; the server's auto-approve dial already removed the findings
  the loop covers. An escalation carries its answer box on the request itself, and the answer is a
  directive to that Story's Editor.
- **Create New Story** — the title/Seed/chapter form. The input at the foot of the content is the
  prompt path: its label reads **Create New Story**, and the line opens the Story from its text and
  sends it to that Story's Editor, which queues the work and can use `requestAuthor` (P7) if the
  direction leaves a question, which then appears under Requests.

The old per-field `Ask assistant` control is gone from `SummaryPane`; the Author's channel is the
directive bar, addressed to the Editor. The bar is present on every view, including Requests, and
carries only one input field with a floating label.
