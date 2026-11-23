# @erosire/create-storyline Knowledge

The loop the Author drives: a Story is a Goal plus a crew that keeps working on it until it runs
out of work, and an Author who owns every decision the loop stops for.

> **Last verified:** 2026-11-23, against the tree as it stood after the Phase-① research pipeline
> landed (`src/server/loop/work.ts:phase1PipelineCandidates`, `src/server/run/phase1-prompt.ts`,
> `src/server/loop/engine.ts:trySelectSample`) and after the T12 fix pass (Story delete covers the
> three research collections, a backtrack scraps the reviews of the revisions it deletes, screening
> exhaustion degrades to a partial selection, a round cannot select before its sample set exists,
> a cleared sampling failure re-arms a wave, `/agents` answers alphabetically, and the Researcher's
> `proposals` cell is `read`). The tests that pin it are `src/server/loop/phase1-research.test.ts`,
> `loop/phase1-gates.test.ts`, `loop/restart.test.ts`, `loop/sample-select.test.ts`,
> `run/phase1-prompt.test.ts` and `integration/summary-sampling.test.ts`.

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
| Tools     | `src/server/tools/`       | The §8 catalogue (Writer/Editor/Checker/Reader/Researcher/assistant) plus the phase-① knowledge group (`tools/knowledge.ts`: `structureSeed`, `writeKnowledge`, `readKnowledge`, `retireKnowledge`, `reportNoResearch`), every guard: CAS on the row a write rides (T-4), the phase/lock gates (T-8, T-11), the `why` requirement (T-5), a verdict's target kinds, the tray rules. A refusal names its rule id and the row it refused on. |
| Brief     | `src/server/run/brief.ts` | The artefact a tool-carrying crew sees: `# ROLE — <role> (<kind>) of <template>`, the phase, the unit under review, the criteria briefed, the etiquette, and the Author's directives. Hashed onto the Run row (S-2). A `toolMode: 'none'` run is given the compiled phase-① prompt instead (`run/phase1-prompt.ts`), and its hash is what the row carries. |
| Runs      | `src/server/run/`         | Spawn → lease → tool calls → report → teardown (S-1, S-3, S-4). A Run row exists before the first token (D-18). The model/tool loop itself runs on the `@underload/harness` engine, in the Story's own harness thread (`run/story-engine.ts`) — EXCEPT a `toolMode: 'none'` run (phase ①'s samples and screens), which calls `chat.complete` directly from `run/executor.ts`, gets no tool context and therefore opens no engine thread.                                                                 |
| Loop      | `src/server/loop/`        | The sweep (L-1), dispatch and its caps (§6.7), work-item production (`work.ts`/`listJobs` — phase ①'s pipeline is `phase1PipelineCandidates`), phase ①'s deterministic sample selection (`engine.trySelectSample` + `sample-select.ts`), sign-off and lock (`engine.lockPhase`), drain and completion (L-35b, L-37, L-25), directives, backtrack, kill. |
| API       | `src/server/api/`         | `routes.ts` is the Author's verbs; `projections.ts` is what the panel and the desk read; `server.ts` binds the process (port, provider triple, SSE at `/v1/storyline/stream`). `src/storyline-server.swagger.yaml` is the OpenAPI contract for every route; `src/dashboard/api.ts` is the UI's only transport. |
| Dashboard | `src/dashboard/`          | The workstation: `state.ts` (one store over an `ApiClient`), the panels in `components/`, the shell in `StorylineApp.tsx`.                                                                                                                                                                                     |

## Things that are easy to get wrong

- **A Story has no separate `state` field.** `stories.status` (`ready` / `pending` / `completed` /
  `stopped`, `shared/types.ts:STORY_STATUSES`) and `stories.pending_kind` (`phase_signoff` /
  `idea_selection` / `finding_approval` / `drained` / `stalled` / `none`) are written by the loop
  engine and the Author (D-1, D-2a); `api/projections.ts:storyRow` only lifts them onto the panel
  row beside the derived `levels`, `trend`, `blocked_on`, `active_runs` and `completion_proposed`.
  A stop is a `status`, not a pending kind; a completion proposal is `completion_proposed` on the
  panel row, never a status.
- **`levels` is `n/m`, and an unreached level is `n/a` (L-14).** A fresh Story reads
  `{"summary":"1/2 · failing: C-14","plotlines":"n/a","chapters":"n/a","whole":"n/a"}` — the
  failing list is the point of the string, not decoration. `completion_preview` and the queue are
  on the Story **view**, not on the panel row.
- **The Story row is a ref target.** C-4/C-10/C-11/C-13 aggregate over the Story row
  (`criteria/engine.ts:scopeTargets`), so `submitVerdict`/`raiseFinding` must resolve a `story_1`
  reference — `tools/artifacts.ts:RESOLVABLE` lists `stories` first and `inStoryScope()` treats a
  Story row's own id as its scope, because a §4.1 Story row carries no `story_id`.
- **Divergence is not a dial field, and phase ① no longer uses it.** `tools/artifacts.ts:isDivergenceMode`
  reads `stories.template_refs`; `writer-plotlines` and `writer-chapters` carry `attempts: 2`, so
  phases ②/③ file competing drafts and an Editor selects (D-3d, §6.2a). Phase ① has **no
  `write_unit` and no `select`**: its divergence is the sampling round (`summary_sampling`,
  `loop/work.ts:phase1PipelineCandidates`), its drafts are samples the engine persists, and its
  selection is deterministic (`loop/sample-select.ts`). `writer-summary-sampler` is `attempts: 1` —
  one run is one sample. The dial itself is `PATCH /stories/:id` with `auto_approve: Cost[]` (D-35),
  and it is the whole ladder: verify → approve → task → repair.
- **`chapter_count` lives on the Summary**, not on the Story (D-3b), and the chapter set is
  materialised by the Plotlines **lock** (D-3c) — not by a Writer. Phase ①'s selection installs the
  six prose fields and **never** `chapter_count` (`engine.ts:SUMMARY_PROSE_KEYS`), because a sample
  cannot carry Author truth.
- **A sampling round is read from three record families, plus its run rows.** `revisions` rows whose
  `round` is the in-flight round (`records.ts:roundRevisions`), the `sample_reviews` of those revisions
  (`screensFor`), and `stories.sampling_round`, which counts COMPLETED rounds — the in-flight round
  is `(sampling_round ?? 0) + 1` (`samplingRoundOf`). Nothing about a round lives in engine memory,
  so a restart mid-round resumes from those rows (L-3); `engine.trySelectSample` runs once per sweep
  for exactly that reason.
- **The losing samples are hard-deleted; `sampling_history` is the stored memory of them.** The
  selection commit deletes every other revision of the round and every `sample_reviews` row pointing
  at one, after appending the round's line (ids + issue counts + selected id) to
  `stories.sampling_history`. The Story view can still RENDER a deleted loser because
  `api/projections.ts:viewRevisions` reads the journal's delete payload and marks it `discarded` —
  that is a reading surface, not a surviving row, and no route restores one (D-24's restore is not
  available for a truncated sample).
- **An unbound Editor job binds `editor-general` because it is FIRST in `DEFAULT_ASSIGNMENT`.**
  `records.ts:templatesFor` returns the assigned templates of a role kind in assignment order and
  `work.ts:candidate` takes the first, so `verify_findings`, `verify_ideas`, `directive_work` and
  `select` all run on `editor-general` — and the phase-① structuring pass binds
  `editor-seed-structure` explicitly to stay off it. The ordering is load-bearing: putting the
  structurer first made every phase-① verification run the structuring prompt.
- **A `toolMode: 'none'` run has no engine thread.** Phase ①'s `sample_unit`/`screen_samples` runs
  call `chat.complete` directly (`run/executor.ts:runStructuredTurn`): the run row is the ordinary
  `spawning → working → torn_down` record and the request/answer pair is retained in the thread log
  (`single_<runId>`). `GET /agents`'s live `working` list is the harness's engine threads MERGED with
  the live run rows (`run/story-engine.ts:StoryHarnessManager.mergeJournaledRuns`, which drops a row
  that a live thread of that kind already names), so a sampling run DOES hold one working tile
  thread — keyed `run_row:<runId>` — while it runs, and afterwards reads in `recent` (run rows) and
  in the employee's retained thread history.
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
  dispatched: drained" }`. Ideas land while a phase is still working, which is why exercising L-7a
  needs a tray someone filled. Phase ①'s shipped crew files NO Ideas: the screening Reader has no
  tools and the deep-review pass is told to report defects, so the tray stays empty in a default
  phase-① Story.

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

`PATCH /stories/:id` also carries phase ①'s two counts — `summary_sampling` (how many one-turn
samples a round owes, standard 3) and `summary_readers` (how many screening passes judge each, and
how many deep-review passes the selected revision owes, standard 5), both integer-bounded to
`SUMMARY_REVIEW_LIMIT` (20) by `routes.ts`; `SummaryPane`'s two number inputs call the same fields.
Reading a Story: `GET /stories/:id` projects `seed_brief` (the accepted Seed Brief trimmed to its
reading fields; `null` before gate 1) and `sampling` (`{round, selected?, history}`, history
newest-first and capped at five) beside the §4 collections (`api/projections.ts`). The knowledge
tree from `GET /stories/:id/knowledge` now has NINE sections and `research` is FIRST, mirroring
`store.knowledge`; the left rail still does not render that tree — it is the `knowledge` tool's
durable directory and a future reading surface.

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
  guard only covers a finding that is still open. A consumed phase-① fix task closes its finding
  `fixed` in the selection commit (`engine.ts:trySelectSample`) and a classic fix pass does the same
  in `settleJob`; a re-raise is then a FRESH row with the same fingerprint, which L-16a reads as a
  regression. A scripted Checker that files the same flaw every round keeps the loop repairing
  chapter 3 forever.
- **`POST /complete` has no tray gate.** `engine.acceptCompletion` completes over a tray of
  undecided Ideas and discards them; only the phase lock refuses on the tray (L-7a).
- **The assistant run reports `role: "writer"`** on its Run row and `work_item_ref:
"assistant_<story>_<run>"`; the plumbing role is reused rather than a distinct one. §7's assistant
  COLUMN is now real in two places the row alone used to hide it: the run is offered no web tools
  (`run/catalogue.ts:toolsForRunKind`, U-1e — pinned by `run/assistant-run.test.ts`), and every write
  it makes records `attribution.assistant: true` so the audit tells "the machine, on the Author's
  instruction" from a dispatched crew run (§2/D-8 — `tools/assistant-attribution.test.ts`).
- **A Task row DOES carry a finding pointer** — §4.7's `finding_ref` (`shared/types.ts:462`) — and it
  is how the sweep finds the fix work again (`loop/records.ts:tasksForFinding`,
  `loop/invalidation.ts:createFixTask`). What is NOT on the row is the unit: the unit comes from the
  finding's own `target_ref`, so a task whose finding was discarded has no way back to a unit except
  through the journal.
- **No route restores a superseded Revision.** `POST /undo` rewinds one §4.4 SPAN (L-17a), and the
  Author's select deletes the losing drafts (D-22). Phase ①'s selection is harsher still: the engine
  hard-deletes the losing samples AND their `sample_reviews` in its own commit, so a truncated sample
  survives only as a journaled delete payload (`api/projections.ts:viewRevisions` renders it
  `discarded` for the rail) and as its `sampling_history` counts. P11's "attributable" holds;
  "revertible" does not, and `D-24`'s Author override cannot reach a sample the engine truncated.
- **Phase ①'s attempt counters survive, so recovery is a WAVE (sampling) or a degrade (screening).**
  A sampling/screening attempt counter is the count of run rows under its claim family
  (`records.ts:sampleAttempts`/`screenAttempts`), and nothing un-runs a row. A sampling round that
  spent its `summary_sampling + 3` cap is recovered by a wave (T12/E): the Author clears the failure
  escalation, and the next sweep bumps `stories.sampling_wave` (guarded by the `wave: <n>` recorded in
  the row's detail, so it happens once per cleared row), which moves the claim prefix to
  `wi_sample_<summary>_<round>_w<wave>_` and starts the counter at 1 — the spent rows stay as audit.
  Screening has no wave on purpose: a draft whose `summary_readers + 3` screening attempts are spent
  counts as screened (`records.ts:isFullyScreened`) and the round selects on the reviews it has, so
  there is nothing to reset. `editSeed` and a backtrack to `summary` restart the round at wave 0 with
  every revision scrapped.
- **Screening exhaustion degrades instead of stalling, and says so.** A sample that cannot collect
  its `summary_readers` valid reviews inside the cap no longer holds the round: the selection runs on
  the partial set and the selection commit opens ONE Author escalation titled
  `Phase ① screening incomplete in round <n> — selection proceeded with partial screening`
  (`owner_role: 'author'`), whose detail names the sample(s), the cap and the fact that selection
  proceeded. The zero-sample case is separate and unchanged: `loop/work.ts:samplingExhausted` +
  `openSamplingFailureTask` ("Phase ① sampling failed after …") for a round that has no draft at all.
- **`confirm_finding` is dormant.** The Work Item kind and the `confirmFinding` tool still exist, but
  no job in any phase generates either now and the `reader_confirmed` gate is gone
  (`loop/records.ts:summaryBlockingFindings` says so where the old gate used to be). The deep review
  plus the Editor's verification is what accepts a finding.
- **There is no `pipeline` flag and no classic phase ①.** The research pipeline is the only phase-①
  algorithm; `write_unit`, `select` and a Checker pass are phases ②/③'s code paths, and
  `writer-summary` is not in the template catalogue at all.
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

`src/server/loop/engine.ts` (the sweep, the states, and `trySelectSample`), `src/server/loop/work.ts`
(what work the loop can even propose — `phase1PipelineCandidates` is phase ①),
`src/server/loop/sample-select.ts` (the ranking, alone), `src/server/run/phase1-prompt.ts` (the
sampling/screening prompt compiler), `src/server/run/executor.ts` (the no-tool turn),
`src/server/api/projections.ts` (what the Author is told), `src/server/tools/index.ts` (what the crew
may do), `src/server/integration/harness.ts` (a crew that only ever sees its brief), and
`documents/specifications.md` §16 for the phase-① pipeline and §15 for the walk all of it is built to
survive.

## The knowledge directory and the employee roster (2026-11-22)

The dashboard's left rail carries the Story's phrase navigator and its right rail carries the
global employee roster. Both are projections, and neither is a second source of truth:

- **The directory** (`src/server/knowledge/story-knowledge.ts`) writes through the harness's
  cross-session knowledge engine (`createKnowledgeEngine` + `loadKnowledgeFileStore`) — the same
  engine the `knowledge` tool uses. One article per section; the nine sections are Research (FIRST,
  mirroring `store.knowledge` — the Researcher's entries with importance and sources), Summary,
  Plotlines, Chapters, Characters, Continuity, Goal, Ideas, Findings. The bytes live at
  `<storeRoot>/harness/knowledge/`, outside every session, so a destroyed harness or a restart
  cannot take them away. The book is still the authority: every store commit re-derives the
  section articles, and an empty section keeps a placeholder paragraph so its folder stays
  visible. `GET /stories/:id/knowledge` syncs, flushes, and answers the whole tree. **The rail no
  longer renders this directory** (2026-11-22): it is a server projection for the `knowledge`
  tool and a future reading surface, while the left rail is now the Story's phrase navigator
  (`src/dashboard/components/StoryOutline.tsx`).
- **The employee roster** (`src/server/run/story-engine.ts`) is fixed and global: Writer, Editor,
  Reader, Checker and Researcher, all at Rank A (the harness's peers, so rank alone delegates to
  nobody). The Researcher is the phase-① addition: it reads everything and writes only `knowledge`
  (plus a queue task), and a write that reaches for the book is refused naming P10. The
  Editor is the Author's one channel — a directive is addressed to it, and it turns the direction
  into the tasks the loop runs. That is routing, not a rank and not an entry role: `entry` no longer
  exists on the client contract or the roster projection, and the harness's own session route names
  the Editor (`STORY_AGENT_ENTRY`).
  VOCABULARY (specification V-1): these five are EMPLOYEES, not agents. An employee is the standing
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
- **The loop's thread ceiling is one host setting, and the employee rail edits it.** `GET /loop` answers
  `{ global_max_concurrent, live_runs }`; `PATCH /loop` moves the number and the next sweep fills to it
  (`loop/engine.ts:dispatch` reads `engine.config.globalMaxConcurrent` fresh on every dispatch, so a write
  needs no restart), and lowering it cancels no run already in flight (L-10). S-5 makes it ONE cap across
  every Story, so the control is a dropdown in the roster header (`components/LoopLimitControl.tsx`,
  rendered by `AgentsPanel`) and not on a Story pane — a per-book ceiling does not exist. It is written
  through `store.setSetting` under `loop_global_max_concurrent` (`loop/ceiling.ts`): host configuration
  beside the roster's models, never journaled, so it cannot reach the Digest's derivation (D-12a).
  Precedence at boot is `STORYLINE_GLOBAL_MAX_CONCURRENT` (an operator's pin) → the Author's stored
  choice → `DEFAULT_GLOBAL_MAX_CONCURRENT` (12).
- **One harness per Story, one session per phase, one thread per Run.** `StoryHarnessManager`
  owns a lazily-built engine `harness()` per Story, so tool registries, transcripts and threads
  are isolated by book. The Story's phase is Storyline's session record (the engine has no session
  object), and every dispatched Work Item, panel agent or delegated sub-context opens a thread
  inside it — except a `toolMode: 'none'` phase-① sample/screen, which calls the provider directly
  and keeps only its run row plus a synthesised retained-thread record (`single_<runId>`). The engine
  executes the loop; Storyline keeps the §8 catalogue, permission rows, the
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
  Goal passes with prose present, no competing draft and no `confirmed`/`approved`
  `critical`/`major` finding on the selected draft). That tick is NOT the server's sign-off gate:
  it does not consult the owed deep-review passes or the unconfirmed findings `loop/status.ts`
  requires, so the rail can tick a phase the sweep would still hold.
  Phase ①'s history is a FLAT `Revision 1 … N` list: `api/projections.ts`
  returns the live revisions plus the losers it recovers from the journal's delete payloads
  (marked `discarded`), and `story-nav.ts:summaryRevisions` labels them in creation order. The RAIL
  shows all of them and a rail click opens any one — parked rows and their `discard_reason` included.
  The pane's own overview shows the Summary on record, the two sampling counts, and exactly ONE
  revision card: the row `story-contract.ts:selectedSummaryRevision` names, i.e. the newest
  `state: 'selected'` draft. Several rounds leave several `selected` rows and only the last is on
  record, which is why the overview is keyed on that id and not on `sampling.selected.revision_id`
  (the Author's override changes the row's state without appending sampling history). An older round's
  accepted row, a `drafted`/`pending` draft and a parked loser print no card, and with nothing
  accepted the pane says so instead of falling back to the drafts. The engine's pick is the
  row with `state: 'selected'` (and the `sampling` slice's `selected` counts); "Editor recommends"
  appears only when a verdict was filed **on a draft** with `hard_pass` and
  `recommendation: 'advance'` — phase ①'s deep-review Readers file against the unit, so normally
  none does. That verdict names a CANDIDATE, and R1 keeps candidates off the overview, so the mark and the
  Author's Select (`POST /stories/:id/revisions/:revisionId/select`, D-24) both sit on the revision the rail
  OPENS (T4): `StoryView` offers the Select only to a row `summaryRevisionUnit` lists — reviewable and not
  superseded — and the row's own state is the second gate, so the accepted row reads `Selected`, a `pending`
  block `Pending` and a parked one `Discarded`, each disabled. The overview's single card therefore carries
  neither the mark nor an enabled write.
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

## Phase ① was a sampled Writer → Reader → Editor pipeline (2026-11-22)

This is HISTORY, kept because earlier notes and commits point at it. It describes the build this
file saw on 2026-11-22; the shipped phase ① is the 2026-11-23 section at the foot of this file.
None of the phase-① families it names — `wi_seed_review_*`, `wi_read_*`, `wi_confirm_finding_*`,
`wi_fix_*`, and an Editor `select` — is generated for phase ① any more; only
`wi_verify_finding_*` survives, fed by the deep review instead.

In that build an Editor reviewed the Seed first (`wi_seed_review_<story>_<hash>` with `reviewSeed`),
`writer-summary` sampled it with `attempts > 1`, each finished draft got `summary_readers`
tool-using Reader passes (`wi_read_<revision>_a<n>`), an Editor verified each critique
(`wi_verify_finding_<finding>_<n>`) and selected among the drafted revisions (`select`), and a Reader
then confirmed each approved finding (`wi_confirm_finding_<finding>`, `reader_confirmed`) before
`wi_fix_*` Writer work was queued. The tests that pinned it
(`loop/summary-pipeline.test.ts`, `integration/summary-review.test.ts`) were replaced by
`loop/phase1-research.test.ts` and `integration/summary-sampling.test.ts`.

## A draft is Pending until its Writer returns, then Drafted for the review crew (2026-11-23)

§4.15's two states serve the tool-using Writers of phases ②/③; a phase-① sample is born `drafted`:

- **`pending`** — the row a Writer files on its first `editSummary`/`editChapter`. A later write in
  the same run extends that row instead of filing a second, partial draft. No Reader, Checker or
  Editor is offered a `pending` row.
- **`drafted`** — the row after the Writer's run closes. `loop/engine.ts:settleJob` promotes it in
  the same commit that closes the run, and a sweep-time `reconcileDrafts` catches a draft written
  after its run ended (or recovered after a restart). For a Summary, `drafted` also requires every
  §4.2 block to be present (`shared/summary.ts`).
- **Phase ①'s samples skip `pending` entirely.** `settleJob` creates the revision `drafted` in the
  commit that closes the sampling run, because the engine persists a whole validated
  `SummarySample` — there is no half-written sample to promote. The classic completion job
  (`wi_complete_*`, `summaryCompletionJobs`) is gone with the classic pipeline: a Summary draft
  short of a block is simply never reviewable (`reconcileDrafts` leaves it `pending`), and no run
  adopts another run's partial draft (`tools/artifacts.ts:pendingDraftFor` returns only the same
  run's row — L-16's siblings stay blind).
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

## Phase ① is structure → research → sample → screen → select → deep review → refine (2026-11-23)

The Summary is no longer written by a tool-using Writer. The shipped phase ① is a research pipeline,
and every stage is a record the sweep can read after a restart. In order:

```
the Editor structures the Seed    (structure_seed)      → seed_briefs: one accepted SeedBrief
the Researcher gathers Knowledge  (research)            → knowledge: sourced, importance-triaged entries
N no-tool one-turn samples        (sample_unit)         → revisions: `drafted`, origin sampled/refined, round set
M no-tool one-turn screens        (screen_samples)      → sample_reviews: critical/high IssueLists
the ENGINE selects                (engine settle)       → Summary prose + sampling_history
the deep review with tools        (check_unit)          → findings on the selected revision
the Editor verifies               (verify_findings)     → confirm/dispute, one finding per thread
the dial auto-approves            (D-35)                → a `fix` task
round N+1's prompt carries BASE REVISION + FIX TASKS    → …until a clean round signs the phase off
```

**The Seed is never edited (P5).** `structureSeed` writes a DERIVED `seed_briefs` row — logline,
protagonist, want/need, obstacle, stakes, setting, world_rules, promise, tone hints, constraints,
open questions, and the `research_questions` list that decides the next stage (D-51) — and refuses a
`seed_hash` that is not the current Seed's, naming P5. One accepted brief per Story; a re-dispatched
Editor converges on the existing row, and a new Seed hash supersedes the old brief in the same
commit. A brief whose hash no longer matches the Seed counts as NO brief
(`loop/records.ts:currentSeedBrief`), so an Author edit re-arms the structuring and every later
stage waits.

**The Researcher is the fifth employee.** `researcher-story` runs at Rank A, holds the web and the
whole catalogue, and writes only `knowledge` (plus a queue task). `writeKnowledge` records one
sourced claim per entry with an `importance` that means something — `critical`, `high`, `normal`,
`low`, and only the first two ever reach a sampling prompt — at least one `{url_or_title, claim,
accessed_at}` citation (T-10), and a `fingerprint` that dedupes (D-16: a repeat bumps `seen_count`,
merges the sources and takes the new triage). `readKnowledge` is the bounded lookup (40 rows,
`critical` → `low`, newest first within a level) the deep-review Reader and Editor hold;
`retireKnowledge` marks a stale entry `low` and appends `(retired)` to its detail instead of deleting
it; `reportNoResearch` closes a pass that found nothing to record (D-51, below). Every session holds
all five tools (T-6a); §7's permission rows decide who may call them.

**Research happens only when the Editor said it must (D-51).** `structureSeed` REQUIRES
`research_questions` — an array of world-fact questions the draft cannot get from the Seed alone, or
`[]` to say the premise is self-contained and the leg is waived. Omitting it is a T-11 refusal, so an
Editor can never leave the question undecided; and nothing in the loop reads the title, the genre or
the prose to guess it. `loop/records.ts:researchGate()` is the ONE implementation of the rule
(`'waived' | 'needed' | 'closed'`): `phase1PipelineCandidates` holds the sampling gate on it,
`phase1Unmet`'s drain clause reads it, and a waived brief queues no `wi_research_<rev>` at all —
the `research` family simply never appears in the status panel. A stored brief with NO field is a row
written before the field existed and keeps D-40's gate (`needed`), never a waiver (D-5). A non-empty
list scopes the pass: the Work candidate's `note` carries the exact questions, so the Researcher
answers those and not a guess.

When the pass IS dispatched and the reading concludes there is nothing to record — the premise is
self-contained after all, or `readKnowledge` already answers the questions — the Researcher calls
`reportNoResearch(rationale)`: researcher-only, zero writes (no Knowledge row, because
`writeKnowledge` demands a citation and an invented fact is worse than none — P7), and the call is
classified READ **and** REPORT (`run/catalogue.ts`): `READ_TOOLS` because it touches no record, which
is what makes a D-38 panel agent ANSWER it rather than propose a write that does not exist, and
`REPORT_TOOLS` because it is the run's report — the distinction S-4 counts, so the run is
`no_op: false` and the loop does not burn its attempts re-dispatching a closed pass. A silent end,
with neither tool called, stays a counted no-op (S-4) — but it still CLOSES the pass, because
`records.ts:researchClosed` reads any closed run of `wi_research_<brief.rev>`, not the tool call: the
Researcher is not bought again, and what the tool adds is the reason on the record plus the
`no_op: false` that keeps S-4's no-progress stop off a Story whose pass did answer. That silence is
the failure mode the tool exists to prevent.

**Sampling is tool-less, one turn and the same prompt for every sample.** `summary_sampling`
(standard 3) is how many samples a round owes. Each `sample_unit` run is one assistant turn with an
empty offered-tool list and a `response_format` contract — `SummarySample` (premise, promise, theme,
tone, ending, world_rules, knowledge_used; `additionalProperties: false`; no `chapter_count`) — built
by `run/phase1-prompt.ts`. The system turn is the `writer-summary-sampler` role prompt plus the
output contract and is identical for every sample of every round; the user turn is the Seed Brief,
the `critical`/`high` Knowledge (sorted by importance then fingerprint), and from round 2 the BASE
REVISION (the previous round's selected draft) plus the FIX TASKS. Diversity is the provider `seed`
(the sample's 1-based index); the prompt is byte-identical, and its sha256 (first 16 hex chars) lands
on the run row's `brief_hash` and the revision's `prompt_hash`. There is no TypeBox: the schemas are
plain JSON Schema literals in `shared/schemas/`; the client asks for `json_schema`, downgrades once
to `json_object` if the provider rejects the field, and the executor allows exactly ONE schema-repair
retry before the run fails and persists nothing.

**Screening is the same mode with a different contract.** `summary_readers` (standard 5) is both the
number of screening passes per sample and the number of deep-review passes the selected revision
owes. Each `screen_samples` run answers an `IssueList` — `severity` closed to `critical`/`high`,
verbatim `quote`, field `location`, `criterion` in `C-14`/`C-15`/`seed` — and the engine persists it
as one `sample_reviews` row. These are not findings: they never enter D-33/D-34, cannot block a
Writer, and exist to rank the round and seed the deep review. A failed screen persists no row, so
the attempt counter — not the row count — is what buys the retry.

**Selection is the engine's, and it is deterministic.** `engine.trySelectSample` runs after every
sample/screen settlement and once per sweep. It fires only when the in-flight round
(`sampling_round + 1`) has a `drafted` revision, no revision of it is already `selected`, the round
OWES NO MORE SAMPLES — the full `summary_sampling` set exists, or the round's sample attempts (current
wave) reached `summary_sampling + 3` so the survivors are all there will be, or the round's sampling
LEG has closed (D-52, below) — every `drafted` sample is
SCREENED (its full `summary_readers` set, or its screening attempts reached `summary_readers + 3`, in
which case the selection commit opens the partial-screening escalation), and no live
`wi_sample_*`/`wi_screen_*` run remains.
`loop/sample-select.ts` ranks them: **fewest `critical` → fewest `high` → fewest total → the earliest
sample** (creation order; id last). One commit then installs the winner's six prose fields on the
Summary — `premise`, `promise`, `theme`, `tone`, `ending`, `world_rules`, and NEVER `chapter_count` —
marks it `selected` with its `issue_counts`, appends the round's `sampling_history` line BEFORE any
delete, hard-deletes every other revision of the round and every `sample_reviews` row pointing at
one — and, since D-52, every `drafted`/`competing` leftover of an EARLIER round too, together with the
findings that named only those drafts (retired to `discarded`) and the open tasks they queued (closed
`wontfix`) — marks the open `fix` tasks `done`, closes each finding they named — while still
`confirmed`/`approved` — as `fixed`, and advances `sampling_round`. The
losers exist afterwards only as that history line and as the journal's delete payload (the Story view
still renders them as `discarded`); no route restores one. Rows the TOOLS parked as `discarded`
(`commitSelection` sets losers aside for the dashboard) are never deleted by the sweep —
`records.ts:isReviewableDraft` is that guard.

**A disarmed round is still a round (D-52).** The arming rule gates NEW samples, never a round that
already sampled. A refinement round's leg can close under itself — a deep review files an unconfirmed
`critical`/`major` while the round's first draft is still being screened, and `samplingArmed` then
refuses the next sample — and if selection waited on the full set, the round would strand: the sign-off
needs a selection that can never happen, and the loop waits on work it stopped buying itself. Two facts
are read separately from the ledger, and deliberately at DIFFERENT scopes: the cap arm counts the CURRENT
WAVE (`records.ts:sampleAttempts` at `stories.sampling_wave` — that is the re-arm contract of T12/E), while
`records.ts:samplingRoundStarted` asks the ROUND question wave-agnostically: any
`wi_sample_<summary>_<round>_*` key, current wave or not (`records.ts:sampleRoundPrefixOf`), because a wave
bump is a retry of the same round and the drafts made before it are still this round's.
`records.ts:samplingLegClosed` is the pair: that round spent the cap, OR started and is no longer armed. A round
that never started keeps refusing, exactly as D-49 says; a round that started has a CLOSED leg, and the
selection proceeds on the drafts that exist. Screening never depends on arming — what the leg closing
cancels is a NEW sample, not the passes an existing draft owes — and D-33 still holds the sign-off while
a finding is unconfirmed, so the round is shorter, not weaker. The same settlement then retires the
earlier rounds' leftovers (§16.6 step 4 of D-52): `records.ts:isSupersededSummaryDraft` (round < the
loop's current round, not `selected`, not already parked `discarded`), and rounds are read from BOTH
`revisions.round` and the `sampling_history` lines, because the sweep's delete drops the rows and the
history is what proves a round was chosen past. Those drafts, their reviews, the findings that named
only them (`discarded`) and the open tasks those findings queued (`wontfix`) go in the same commit —
otherwise a dead draft's review keeps blocking the sign-off and its task re-arms the next round forever.

**A finding belongs to one draft (D-53).** Phase ① reads the owner off `related_refs` with
`records.ts:findingRevisionScope`, and the answer is one of `selected` / `superseded` / `artifact`:

- `selected` — it names the revision the Summary row carries. It blocks and it is verified.
- `superseded` — every ref names a Summary draft this Story already had (its row, or the round's
  `sampling_history` line names it) and none names the carried draft. The complaint describes a text the
  Summary no longer holds: it stays `unconfirmed` for the Author, and it neither blocks a gate nor buys
  another verification pass, because the pass re-reads the KEPT draft and can never decide it.
- `artifact` — no ref names a draft, or a ref names something that is not one (the Summary row itself, a
  criterion, a chapter). L-11a's whole-Story shape keeps its full blocking weight and is never silently
  dropped; an id NOTHING names counts as `artifact`. A draft the sweep DELETED is the exception the audit
  covers: `records.ts:summaryRevisionRounds` reads `revisions.round` AND the `sampling_history` lines, so an
  id a history line still names is `superseded`, never `artifact`.

The scope feeds the sign-off's blocking set (`summaryBlockingFindings`), the verification queue
(`unconfirmedBlockingFindings`), the drain probe and the selection's retirement, so no two gates disagree
about which draft a complaint describes — and it feeds `status.ts:unitsWithCompetingRevisions`, which is
why a set-aside draft stopped holding both the sign-off and the drain. Because that reading is the only
attribution a finding carries, `raiseFinding` ASKS FOR IT AT FILING in phase ①: on a Summary target, in
phase `summary`, once a selection has installed a draft, the raise is refused naming **D-33**
(`field: 'related_refs'`, `expected: [the carried id]`) unless the refs name that revision. A
`stories`-targeted whole-Story finding, a chapter/plotline finding, and a filing before the round's first
selection stay free — and the refusal runs BEFORE the D-16 fingerprint dedupe, so asking the caller to
attribute an existing complaint must never silently fold it into the old row.

And the queue is BOUNDED. The verify family is anchored per finding (`wi_verify_finding_<id>_`, the
trailing `_` so `finding_1`'s budget is never spent by `finding_10`) and stops at `FINDING_VERIFY_CAP` =
one pass plus `SAMPLING_RETRY_ALLOWANCE` retries (4 today). An undecided `verify_findings` run leaves the
finding `unconfirmed`, which is a D-33 hold, so an uncapped queue bought the same question on every sweep
forever: never drained, never stalled, never explained. The stalled list excludes two findings besides the
superseded-draft case: one whose LAST bought pass is still live (the budget is spent on the run count, and
opening an Author question over the head of an Editor run that has not answered would have to close a row that
should never have opened — `records.ts:verifyFindingLive`), and one whose scope is a set-aside draft. On the
sweep after the budget is spent, with neither exclusion holding,
`engine.escalateVerifyStall` opens ONE Author escalation — "the crew asked you", `owner_role: 'author'`,
`finding_ref` set — and closes it (`done`) as soon as the finding leaves `unconfirmed`. The reuse lookup that
keeps it at ONE per finding matches the row's `finding_ref`, not just the title, and the title prefix it
matches on is anchored with the ` —` separator: ids come from one counter, so a bare `finding_1` prefix is
also a prefix of `finding_10`, and one finding's question would otherwise be handed to another finding's
sweep. The row is `blocked`, not `open`, because a `blocked` row is not dispatchable work: it is the
shape `tools/checker.ts:requestAuthor` already uses, and `decideStory`'s step 4 renders it as the Author
question. This is a convention for THAT family, not a rule about escalation rows in general — a phase-①
sampling/prerequisite escalation is deliberately opened `open` (its reuse lookup, drain-hold and
`rearmSamplingWave`'s clear-and-rearm all key on the open row), and step 4 reads an `open` row that is
`owner_role: 'author'` as the same question when `dispatchable === 0` and no run is live (H2/R2); see
"Fix ownership and the two Author questions" below.
`records.ts:findingsVerifyStalled` is the one list both halves read, so generation and escalation cannot
disagree about which findings stalled — and that is also why the OPENING of the row is phase-scoped while the
CLOSING is not: outside phase ① the list is empty by definition, so `engine.escalateVerifyStall` still runs
its close pass and retires a `blocked` row whose finding was decided after the Story moved on (the row would
otherwise sit on the tray forever, holding the queue the sweep already answered).

**The deep review is where the Readers get their tools back.** Once a round has selected, the winner
gets `summary_readers` `check_unit` passes — `wi_review_<selected>_a<pass>` — rotating over
`reader-genre`, `reader-plausibility`, `reader-audience` and `reader-mystery`, with the whole
catalogue and the web. Their findings (any cost) each get their own Editor `verify_findings` thread
(`wi_verify_finding_<finding>_<n>`), and the Story's dial auto-approves what it covers, which
creates the `fix` task.

**A refinement round waits for approved work.** Round 1 samples as soon as the brief and its research
are closed. Round N+1 is armed only when a `fix` task is `open` AND no `critical`/`major` finding is
still `unconfirmed` (`records.ts:samplingArmed`). Its compiled prompt carries the previous round's
selected draft and those tasks, and its own selection consumes them. If the dial does not cover the
confirmed costs, no task exists and the Story waits at `pending`/`finding_approval` until the Author
approves one. A refinement round is additionally held while a Researcher prerequisite is unanswered
(H2/R1, below).

**Fix ownership, and the two Author questions phase ① can ask (H2/R1, H2/R2).** A `fix` task's
`owner_role` (§4.7) decides which crew, if any, can settle it, and every phase-① read uses one
predicate — `records.ts:isWriterActionableFix` (`''`/`writer`, or a `writer-*` template id such as the
`writer-prose` the assignment layer writes). Only those rows are the round's demand: they are what
`run/phase1-prompt.ts` puts in the Writer's block and the screening Reader is asked to grade, what the
`fix_refs` of a Work Item carries, what `sampleFixDemand` certifies, and what a certified selection
closes (`engine.trySelectSample`). Grading a draft against a row no draft can settle is what made every
candidate ineligible at once (a Reader's honest `unknown` is not a pass, `sample-select.ts:certifiesFix`)
while the round spent its cap.

* A `researcher`-owned row is an external fact, and phase ① already runs that role: it becomes a real
  `research` job, key `wi_research_fix_<task>_a<n>` (attempt-scoped like every family here), priority 0,
  `researcher-story`, unit `{ kind: 'summary', ref }` (F1 — `brief.ts` renders ARTIFACT UNDER REVIEW and
  scopes Ideas from `item.unit`, so the unit must be a `WorkUnitRef` or the pass is dispatched with an
  empty artifact section), `taskRefs`/`findingRefs` carrying the task and finding it must settle. The
  budget is the loop's existing allowance — `records.ts:RESEARCH_PREREQUISITE_CAP` =
  `FINDING_VERIFY_CAP` (4) — and the pass counter is journal-derived, so it survives a restart.
* It settles only on EVIDENCE: `records.ts:researchPrerequisiteEvidence` is the `knowledge`
  create/update events attributed to a run in that task's family, and `engine.settleFixPrerequisites`
  (beside `escalateVerifyStall`) is its only writer. A run that ends without writing — `reportNoResearch`
  — spends the attempt and changes nothing; the note on the job says so, because the two answers look the
  same to the crew that was asked to make them.
* Budget spent with no evidence opens `Phase ① research prerequisite exhausted on <task> — …`, and a row
  whose owner has no phase-① job at all opens `Phase ① fix task has no crew that can work it <task> — …`.
  Both are `owner_role: 'author'`, `state: 'open'`, ONE per task (the reuse key is the anchored
  `<prefix> <task.id> —`), and `settleFixPrerequisites` closes the row the moment the task leaves the set
  that opened it — the Author's answer, not a second question, is what retires it.
* **A finding is retired only by its last open fix row** (`records.ts:findingFixWorkSettled`, F3). One
  finding can carry rows for several owners — the live shape was a Researcher grounding row and a Writer
  repair row on the same finding — so settling one marks that row `done` and leaves the finding
  `confirmed`/`approved` while any other open row names it. Both writes are gated the same way: the
  prerequisite settlement and the certified-selection closure. A finding with no remaining rows closes
  exactly as it did before; a `wontfix`/`discarded` row is settled, not successful, and closes nothing.
* With nothing dispatchable and no run live, `status.ts:decideStory` step 4 reads an OPEN Author-owned
  escalation as `pending`/`drained` + `the crew asked you: "<title>"`, and the row keeps its `open` state
  (the fix is in the read, never in rewriting the row). A `blocked` crew row still wins. The row also
  counts as a queued task (`records.ts:dispatchableTasks` admits any row with an `owner_role`), so the
  drain's own preconditions stay unmet and the clean-drain sentence cannot be reported over a question
  that is still unanswered — while `decideStory`'s `dispatchable` input is the CANDIDATE count, which is
  why the same row holds the drain and still leaves the sweep with nothing to run. `drain.test.ts` pins
  both halves: the question read on a drained fixture, and a pending directive review (crew work) keeping
  the question out of the reading.

Pinned by `loop/phase1-hill-climb.test.ts` (the `H2/R1-R2` describe: routing, the evidence rule and its
negative half, the cap and its question, the shared-finding lifecycle, and the sweep's own
`pending`/`drained` read), `loop/drain.test.ts`, `run/brief.test.ts` (F1's artifact section) and
`integration/summary-sampling.test.ts` (the settled row after a spent sampling cap).

**Sign-off and drain.** `phase_signoff` needs the Goal (C-14/C-15) passed plus no competing draft, no
`pending` draft, no sourced Idea awaiting verification, no unconfirmed blocking finding, no
phase-① `fix`/`rewrite`/`merge` task, no `critical`/`major` finding open on the selected revision,
every deep-review pass closed, and an empty tray. The lock itself is unchanged. The drain adds the
pipeline's stages to L-37's four (`loop/status.ts:phase1Unmet`): an accepted brief for the current
Seed, a closed research pass, no live sample/screen, no open Researcher-owned `fix` prerequisite (the
round cannot answer an external fact a draft was never asked to ground — `openResearchFixPrerequisites`
names it with its pass count, H2/R1), the in-flight round complete (selected) or
deliberately not owed, and the deep review closed. Both resets are explicit: `editSeed` and a
backtrack to `summary` set `sampling_round` to 0, `sampling_history` to empty and `sampling_wave` to
0, because both scrap the revisions and samples those fields describe.

Two exclusions keep the round's own leftovers from becoming a permanent stop (D-52/D-53), and they are
applied in BOTH the sign-off gate and `phase1Unmet` — the two read the same predicates, so the UI cannot
offer the button and name the same row as unmet work: a `drafted`/`competing` Summary revision of a round
the loop has already chosen past is a leftover, not competition, and is not owed screening
(`records.ts:isSupersededSummaryDraft`, used by `status.ts:unitsWithCompetingRevisions`); and a finding
whose refs name only such a draft is not an unconfirmed blocker (`records.ts:summaryBlockingFindings`, D-53) —
while a finding naming NO draft keeps its whole-Story weight and still blocks when its target is the Summary
row itself (L-11a). The round's clean Stop is therefore a real state: the
selected draft reviewed, the crew asked the Author what to change, and the Story `pending` with
`phase_signoff` offered.

The job keys, which are the whole ledger:

| job | key | notes |
| --- | --- | --- |
| `structure_seed` | `wi_structure_seed_<seedHash>` | one per Seed hash; priority 0; binds `editor-seed-structure` explicitly |
| `research` | `wi_research_<brief.rev>` | one per accepted brief revision; priority 0; `researcher-story`; **skipped entirely when the brief's `research_questions` is `[]` (D-51)** — a legacy brief without the field keeps the pass |
| `research` (fix prerequisite) | `wi_research_fix_<task>_a<n>` | one per Researcher-owned `fix` row (H2/R1); priority 0; `researcher-story`; unit `{ kind: 'summary', ref }`; family = the budget, at most `RESEARCH_PREREQUISITE_CAP` (= `FINDING_VERIFY_CAP`) passes, then ONE `open` Author escalation; settles only on Knowledge attributed to the family |
| `sample_unit` | `wi_sample_<summary>_<round>_<attempt>`, or `wi_sample_<summary>_<round>_w<wave>_<attempt>` after a re-armed wave | `<attempt>` is 1-based and store-derived; ONE per sweep per round while no sampler is live |
| `screen_samples` | `wi_screen_<revision>_<attempt>` | one owed pass per drafted sample; per-revision family |
| `check_unit` (deep review) | `wi_review_<selected>_a<pass>` | one per pass, rotating the four Reader angles; tools ON |
| `verify_findings` | `wi_verify_finding_<finding>_<n>` | `<n>` is the dispatch generation; one thread per finding; binds `editor-general` (FIRST in `DEFAULT_ASSIGNMENT`); the FAMILY `wi_verify_finding_<finding>_` is the budget — one finding gets at most `FINDING_VERIFY_CAP` passes (D-53), then one `blocked` Author escalation |

The deviations from the design document, stated plainly because the docs describe the CODE:

1. **Selection is an engine settlement, not a dispatched `choose_sample` Work Item.** The kind was
   never shipped; `trySelectSample` is called from `settleJob` and from the sweep.
2. **There is no `pipeline` flag.** New and existing Stories run the same phase ①; `seed_review` is
   not in `WORK_ITEM_KINDS` (it was replaced by `structure_seed`), and `writer-summary` is not in the
   catalogue at all.
3. **No TypeBox.** The schemas are plain JSON Schema literals; the transport negotiates
   `json_schema` → `json_object`; the client is non-streaming, so there is no streaming repair — one
   model-side repair retry instead.
4. **`confirm_finding` is no longer dispatched in phase ① and the `reader_confirmed` gates are
   gone.** The Work Item kind and the `confirmFinding` tool remain in the vocabulary/catalogue; the
   deep review + Editor verification replaced the confirmation thread.
5. **A consumed fix task closes its finding (`fixed`); a re-raise is a fresh row (L-16a).** The
   selection commit closes the finding the task named; a sample that did not fix the defect re-files
   the fingerprint and reads as a regression rather than trusting the write.
6. **Sampling and screening carry implicit attempt caps of size + 3.** A sampling round with no
   sample after `summary_sampling + 3` attempts raises ONE `escalation` task for the Author (title
   prefix "Phase ① sampling failed after", reused across sweeps). Its `detail` records the wave, and
   clearing the row makes the sweep bump `stories.sampling_wave` and re-arm the round under
   `wi_sample_<summary>_<round>_w<wave>_1` (T12/E: the promised recovery is real). A sample whose
   `summary_readers + 3` screening attempts are spent counts as screened; the round selects on the
   partial reviews and opens ONE `Phase ① screening incomplete in round <n>` escalation (T12/C). A
   round also refuses to select while samples are genuinely still owed: the full `summary_sampling`
   set must exist, or the sampling cap must be spent (T12/D).
7. **Sign-off and drain also wait for every deep-review pass of the selected revision**
   (`records.ts:deepReviewPassesOwed`), so the phase is not signed on a half-reviewed draft — but only
   when that revision IS the review target. `records.ts:isDeepReviewSelection` (the draft's `round` is
   the Story's `sampling_round`) is the ONE condition both the `wi_review_*` queue and the debt read,
   so selecting an OLDER-round draft from the Summary pane cannot owe `summary_readers` passes the loop
   will never dispatch — the sign-off would wait on a debt nobody can pay.
8. **`editSeed`/backtrack-to-summary reset `sampling_round`, `sampling_history` and `sampling_wave`.**
9. **C-16/C-17 were NOT added.** The Goal's summary level is still C-14/C-15; the Seed Brief is an
   input, never the contract C-14 measures against.
10. **A no-tool run has no engine THREAD, yet it still counts as one live tile thread.** It calls
    `chat.complete` directly, so the harness has no thread to show; `GET /agents`' `working` list
    MERGES the live engine threads with the live run rows
    (`run/story-engine.ts:StoryHarnessManager.mergeJournaledRuns`, deduped by `run_id`), which is
    what stops the tile reading `idle` while such a run works. Its run row
    (`spawning → working → torn_down`) and its retained thread record (`single_<runId>`) are the
    history once it closes.
11. **Selection waits on the round's sampling LEG, not on the arming rule (D-52).** The arming rule still
    gates every NEW sample, but a round that already sampled and was then disarmed (or spent its cap) is
    selected on the drafts it has — `records.ts:samplingLegClosed` — and the same commit retires the
    earlier rounds' leftover drafts with the findings that named only them (`discarded`) and the open tasks
    those findings queued (`wontfix`). Without the first half a round strands with nothing running and
    nothing offered; without the second half a dead draft's review holds the sign-off and its task re-arms
    the next round forever.
12. **A finding's `related_refs` decide what they block, and the verify family is capped (D-53).**
    `records.ts:findingRevisionScope` separates the carried draft, a superseded draft and a non-draft ref;
    a superseded finding stays on the record and blocks/verifies nothing, the whole-Summary shape keeps its
    weight, `raiseFinding` asks for the carried revision at filing (D-33), and one finding gets at most
    `FINDING_VERIFY_CAP` verification passes before the loop stops and asks the Author (a `blocked`
    escalation, `finding_ref` set, closed when the finding leaves `unconfirmed`).

The tests that pin all of it: `src/server/loop/phase1-research.test.ts` (the whole loop: gates,
samples, screens, selection, truncation, round 2, sign-off),
`src/server/loop/phase1-lifecycle.test.ts` (the round's STOP and its three stranding bugs: a clean round
settles at "reviewed, ask the Author" with nothing queued, a disarmed round that already sampled still
selects, findings and drafts that belong to a superseded revision stop blocking at the selection that
retires them, and an undecided verification queue caps at four passes and escalates to the Author — driven
by the rig's `crew.verifyReports` knob),
`src/server/loop/phase1-gates.test.ts` (the degradation and retry rules: scrapped revisions take
their screening reviews, screening exhaustion selects partially and escalates, no early selection,
the wave re-arm, R8's negative gate), `src/server/loop/restart.test.ts` (a mid-round restart
re-buys the lost sample under a new key and selects once), `src/server/loop/sample-select.test.ts`
(the ranking), `src/server/run/phase1-prompt.test.ts` (the byte-stable hash, the importance filter,
the round-2 sections), `src/server/tools/runtime.test.ts` (the phase-① `raiseFinding` attribution rule
across all four ref shapes), `src/server/integration/summary-sampling.test.ts` (the real server), and
`src/server/llm/structured.test.ts` (the transport fallback and the validator).
