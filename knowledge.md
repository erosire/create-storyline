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
Goal/criteria, `E-` engine, `P-` principle.

## The stack, bottom up

| Layer | Path | What it owns |
| --- | --- | --- |
| The book | `src/server/store/` | The §4 collections, the event journal, `store.json` + `journal.jsonl`. `Store.empty()` / `Store.load(root)`; the constructor is private. Commits are applied immediately, persisted on a 25ms debounce, flushed by `persist()`/`close()`. |
| Criteria | `src/server/criteria/` | Resolves a Story's Goal, aggregates verdicts into `n/m` per level, and decides which criteria a phase can still move on. |
| Tools | `src/server/tools/` | The §8 catalogue (Writer/Editor/Checker/Reader/Explorer/assistant), every guard: CAS on the row a write rides (T-4), the phase/lock gates (T-8, T-11), the `why` requirement (T-5), a verdict's target kinds, the tray rules. A refusal names its rule id and the row it refused on. |
| Brief | `src/server/run/brief.ts` | The one artefact a crew sees: `# ROLE — <role> (<kind>) of <template>`, the phase, the unit under review, the criteria briefed, the etiquette, and the Author's directives. Hashed onto the Run row (S-2). |
| Runs | `src/server/run/` | Spawn → lease → tool calls → report → teardown (S-1, S-3, S-4). A Run row exists before the first token (D-18). |
| Loop | `src/server/loop/` | The sweep (L-1), dispatch and its caps (§6.7), work-item production (`work.ts`/`listJobs`), sign-off and lock (`engine.lockPhase`), drain and completion (L-35b, L-37, L-25), directives, backtrack, kill. |
| API | `src/server/api/` | `routes.ts` is the Author's verbs; `projections.ts` is what the panel and the desk read; `server.ts` binds the process (port, provider triple, SSE at `/v1/storyline/stream`). |
| Dashboard | `src/dashboard/` | The workstation: `state.ts` (one store over an `ApiClient`), the panels in `components/`, the shell in `StorylineApp.tsx`. |

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
`POST /stories/:id/stop|resume|clear-pending|lock`, `POST /stories/:id/backtrack {phase}`,
`PATCH /stories/:id/goal {criteria:[{op:add|remove|setHard}], threshold_soft}`,
`POST /stories/:id/directives {text}`, `POST /stories/:id/assistant {target,text}`,
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
