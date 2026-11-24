# @erosire/create-storyline Knowledge

The loop the Author drives: a Story is a Goal plus a crew that keeps working on it until it runs
out of work, and an Author who owns every decision the loop stops for.

> **Last verified:** 2026-11-24, against the tree as it stands AFTER the Summary Phrase redesign AND
> the same-day hardening pass on its server edges: phase ① is a hill-climb over **five independent
> Phrase Groups** — `src/shared/phrase.ts` (`PHRASE_GROUPS`, `SUMMARY_MIRROR_FIELDS`,
> `composePhraseContent`), `src/server/phrase/` (`catalog.ts:ensurePhraseCatalog`/`importLegacySummary`,
> `revisions.ts:installGroupRevisions`, `exclusion.ts:liveGroupSets`/`groupPipelineOwed`,
> `findings.ts:findingGroupScope`), `loop/work.ts:phase1GroupCandidates`, the group install in the
> settle path (`loop/engine.ts:1445-1528` — install + archive + mirror, never `select`), the
> group-aware drain and sign-off reads (`loop/status.ts:phase1Unmet`'s group branch and
> `decideStory`), and the three routes `GET /stories/:id/phrases`,
> `POST /stories/:id/phrases/import`, `POST /stories/:id/phrases/groups/:groupId/revise`. The tests
> that pin it are `src/server/phrase/{catalog,revisions,exclusion,findings}.test.ts`,
> `loop/phase1-groups.test.ts`, `loop/phase1-groups-restart.test.ts`,
> `loop/phase1-groups-drain.test.ts`, `loop/group-seed-reset.test.ts`,
> `loop/group-findings-batch-cap.test.ts`, `tools/group-mode-writes.test.ts`,
> `api/phrase-routes.test.ts`, `api/story-delete.test.ts`,
> `integration/summary-groups.test.ts` and `tools/checker-group-attribution.test.ts`, plus the
> dashboard's `components/story-nav.groups.test.ts`, `components/story-contract.groups.test.ts`,
> `StorylineApp.groups.test.tsx`, `components/StoryView.groups.test.tsx`,
> `api.phrases.test.ts`, `state.phrases.test.ts`, `real-server-phrases.test.tsx`,
> `components/SummaryOverviewPane.test.tsx` and `components/SummaryGroupPane.test.tsx`.
> The whole-Summary **sampling round** (`sample_unit`/`screen_samples`, `loop/sample-select.ts`,
> `sampling_history`, `trySelectSample`, `loop/sample-select.test.ts`,
> `integration/summary-sampling.test.ts`, `loop/phase1-plateau.test.ts`) still EXISTS and is still the
> contract for `'sampling'` books — this file records what it is supposed to do, not a test run: the
> commands to prove any of it are §"How to verify" below. A book runs sampling only when
> `stories.summary_mode` is `'sampling'`, and no new story is created in that mode.

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
| The book  | `src/server/store/`       | The §4 collections, the event journal, `store.json` + `journal.jsonl` — ONE BOOK PER STORY: `StoryStores.open(root)` loads `<root>/stories/<uuid>/` and mints a uuid book for a new Story, and `<root>/server/` is the app book (`Store.load`), which holds no Story rows at all. A root still carrying a flat `store.json` is refused with `StoryLayoutError` (no migration). `Store.empty()` / `Store.load(root)` / `Store.loadStory(id, dir)`; the constructor is private. Commits are applied immediately, persisted on a 25ms debounce, flushed by `persist()`/`close()`. Child ids (`run_0`, `finding_3`) are unique per book, never across the workspace; the `story_id` fence (T-3) refuses a foreign row. A group-managed book additionally holds the three Summary Phrase collections — `phrases`, `phrase_groups`, `group_revisions` (`store.ts:682-687`; the first two carry counter ids, a revision is addressed by `(group id, number)` so `group_revisions` does not). A legacy book holds none of them, and THAT is the R6 contract: no migration, `summary_mode` absent means `'sampling'`, and nothing may infer group management from the presence of rows. |
| Criteria  | `src/server/criteria/`    | Resolves a Story's Goal, aggregates verdicts into `n/m` per level, and decides which criteria a phase can still move on.                                                                                                                                                                                       |
| Tools     | `src/server/tools/`       | The §8 catalogue (Writer/Editor/Checker/Reader/Researcher/assistant) plus the phase-① knowledge group (`tools/knowledge.ts`: `structureSeed`, `writeKnowledge`, `readKnowledge`, `retireKnowledge`, `reportNoResearch`), every guard: CAS on the row a write rides (T-4), the phase/lock gates (T-8, T-11), the `why` requirement (T-5), a verdict's target kinds, the tray rules, and the group-book refusals (`tools/writer.ts:editSummary` → `R6`, `tools/editor.ts:selectRevision` on the Summary unit → `R5`, `tools/checker.ts:raiseFinding` on a grouped Summary → `R3`), each refusal carrying a `fix` that points at GROUPED work, not at the retired selection. A refusal names its rule id and the row it refused on. |
| Brief     | `src/server/run/brief.ts` | The artefact a tool-carrying crew sees: `# ROLE — <role> (<kind>) of <template>`, the phase, the unit under review, the criteria briefed, the etiquette, and the Author's directives. Hashed onto the Run row (S-2). A `toolMode: 'none'` run is given the compiled phase-① prompt instead (`run/phase1-prompt.ts`), and its hash is what the row carries. |
| Runs      | `src/server/run/`         | Spawn → lease → tool calls → report → teardown (S-1, S-3, S-4). A Run row exists before the first token (D-18). The model/tool loop itself runs on the `@underload/harness` engine, in the Story's own harness thread (`run/story-engine.ts`) — EXCEPT a `toolMode: 'none'` run (phase ①'s group drafts and group reviews, and, on a legacy book, its samples and screens), which calls `chat.complete` directly from `run/executor.ts`, gets no tool context and therefore opens no engine thread. The Run row is where a group batch lives: `run/executor.ts` copies the Work Item's `group_refs` onto it, and `phrase/exclusion.ts` reads THAT as the live hold.                                                                 |
| Loop      | `src/server/loop/`        | The sweep (L-1), dispatch and its caps (§6.7), work-item production (`work.ts`/`listJobs` — phase ① is `phase1GroupCandidates` now, `phase1PipelineCandidates` on a legacy book), the group install in the settle path (`engine.ts:1445-1528` → `phrase/revisions.ts:installGroupRevisions`), the sweep's group-finding reconciliation (`engine.ts:560-595`, group books only), phase ①'s LEGACY deterministic sample selection (`engine.trySelectSample` + `sample-select.ts`), sign-off and lock (`engine.lockPhase`, and `status.ts:decideStory` which reads `phrase/exclusion.ts:groupPipelineOwed` on a group book), drain and completion (L-35b, L-37, L-25 — `status.ts:phase1Unmet` has a group branch and a sampling branch, never both), directives, backtrack, kill. |
| Runtime   | `src/server/runtime/`     | S-RUNTIME: one ISOLATED runtime per Story book — its own `LoopEngine`, `RunExecutor`, tool catalogue, knowledge projection and thread log — behind `StoryRuntimes`, which is the loop the HTTP layer talks to (`EngineApi` + routing by the Story id the path names, `ownerOf` for child ids). It owns the ONE sweep timer (contexts are built `autoSweep: false` and sweep sequentially, because the shared ceiling is a view over the books), the one S-5 ceiling (`runtime/ceiling.ts`), the commit fan-in for `/stream`, and shutdown (settle → dispose → close every book). `runtime/server-config.ts` is the app book's side: the crew catalogue and the host settings, copied non-journaled into each Story's book (`_state()`/`_restore()`) and re-mirrored when the Author edits a crew, a roster choice or the ceiling. |
| API       | `src/server/api/`         | `routes.ts` is the Author's verbs — a Story-scoped handler shadows `store` with the book its `:id` names, so a sibling's rows cannot be touched, and a Story id no book holds is a 404, not a wrong row; `projections.ts` is what the panel and the desk read (an aggregate is the union of each book's correct answer, never a merge of same-named child ids); `server.ts` binds the process (port, provider triple, SSE at `/v1/storyline/stream`) and composes both shapes — `openStorylineRuntime` for a workspace, sync `buildStorylineRuntime` for one book. `src/storyline-server.swagger.yaml` is the OpenAPI contract for every route; `src/dashboard/api.ts` is the UI's only transport. |
| Dashboard | `src/dashboard/`          | The workstation: `state.ts` (one store over an `ApiClient`, with `phrases` + `phraseErrors` beside the §4 rows), the panels in `components/` (`SummaryOverviewPane` + `SummaryGroupPane` for a grouped Summary, `SummaryPane` for a legacy one), the rail rules in `components/story-nav.ts`, the sign-off derivations in `components/story-contract.ts`, the shell in `StorylineApp.tsx`.                                                                                                                                                                          |

## The Summary Phrase system — the architecture phase ① actually runs (2026-11-24)

**Read this before anything that says "sampling round".** A Story created by `POST /stories` today
is **group-managed**: `loop/engine.ts:createStory` writes `stories.summary_mode: 'groups'` and
ensures the phrase catalog in the SAME commit. The whole-Summary machinery the rest of this file
describes — `sample_unit`/`screen_samples`, N competing drafts, deterministic selection,
`sampling_history`, `sampling_round`, the plateau ladder — still exists and still carries its own
contract and its own tests,
but it is the **legacy** path and runs only when `stories.summary_mode` is `'sampling'` (the mode no
new Story is created in). `phrase/catalog.ts:isGroupManagedStory` is the ONE predicate that decides
which book is which; every guard in the loop reads it from there.

### What a Summary is now (R1, R2, R6)

- **Five Phrase Groups, in composition order**: `premise`, `promise`, `theme`, `tone`, `ending`
  (Author-facing titles Premise / Promise / Theme / Tone / Ending). The set is PRODUCT DATA —
  `src/shared/phrase.ts:PHRASE_CATALOG`, `PHRASE_GROUP_KEYS`, `phraseGroupDefinition` — and neither
  `shared/types.ts` nor `server/store/**` nor `loop/**` branches on a group name (R1 "data-driven":
  adding, retitling or reordering a group is an edit to that module and nothing else).
- **Five groups, SIX legacy fields — and that is not a contradiction.** §4.2's `Summary` record has
  six prose fields; five of them became groups, and the sixth, `world_rules`, **is not a group**
  (R1): no `phrase_groups` row, no revision line, no writer, and the mirror never writes it.
  `shared/phrase.ts:WORLD_RULES_FIELD` names the deprecated field once so no other module spells
  it. The legacy sampling path is the one that still writes six
  (`loop/engine.ts:SUMMARY_PROSE_KEYS`, `engine.ts:1726-1730`); the group path writes five.
- **Each group has its own revision line.** A `group_revisions` row is
  `{group_ref, number, content, state: 'latest' | 'archived', run_ref, work_item_ref, task_refs,
  finding_refs, knowledge_used, prompt_hash, created_at}`; exactly one `latest` per group (installs
  run under a CAS that archives the one it replaces), and the rows it replaces are RETAINED as
  `archived` — history is read, never truncated (R2). Numbers come from that group's own line, so
  **Premise can sit at revision 2 while Promise is still at revision 1**: independence between
  groups is the requirement (R2), not an optimisation.
- **One `phrases` row per enabled phrase kind** (`key: 'summary'`, title "Summary Phrase") carries
  the composed Overview text, generated by `shared/phrase.ts:composePhraseContent`: one
  `## <title>` heading per group that has non-empty text, entries separated by a single blank line,
  in `order` rank order, NO trailing newline. A group with no text is SKIPPED, not rendered as an
  empty heading, and a key the catalog does not know sorts LAST instead of disappearing
  (`phraseGroupRank`) so a retired group's text stays readable.
- **The legacy record stays in sync (R6).** `shared/phrase.ts:SUMMARY_MIRROR_FIELDS` is an IDENTITY
  map (`premise→premise`, …), written from the same texts in the SAME commit as the install, so the
  Digest, phases ②/③, `readSummary` and every pre-redesign reader keep reading `summaries` and can
  never see a new group text beside a stale mirror.

### Where the code lives

| Concern | Path |
| --- | --- |
| The catalog as data; mirror map; composition format | `src/shared/phrase.ts` (`PHRASE_CATALOG`, `PHRASE_GROUP_KEYS`, `SUMMARY_MIRROR_FIELDS`, `composePhraseContent`, `phraseGroupRank`) |
| Catalog ensure + legacy import | `src/server/phrase/catalog.ts` — `ensurePhraseCatalog` (idempotent; creates the `phrases` row and the five `phrase_groups` rows), `importLegacySummary` (idempotent; lifts a flat Summary's five fields into first revisions), `isGroupManagedStory` |
| The install | `src/server/phrase/revisions.ts:installGroupRevisions` — one caller commit: new `latest` per written group → archive the rows it replaces → recompose `phrases.content` → rewrite the mirror. It NEVER writes `chapter_count` and NEVER writes `world_rules`, and it skips the mirror when the Summary row is locked or absent |
| The Writer exclusion (live holds) | `src/server/phrase/exclusion.ts` — `GROUP_HOLDING_KINDS = ['draft_groups']`, `liveGroupRefs`, `liveGroupSets`, `liveGroupWriters`, `partitionGroupRefs` |
| The write allowance and what the pipeline still OWES | `src/server/phrase/exclusion.ts` — `GROUP_WRITE_ATTEMPT_CAP` (215), `groupWriteAttempts` (288), the journal baseline `writeBaselineOf` (264), the seat keys `groupReviewSeatKey`/`groupCheckSeatKey` (366/370), `isGroupPipelineRun` (384) and `groupPipelineOwed` (415) — the one read the queue, the drain and the sign-off share |
| The drain and the sign-off on a group book | `src/server/loop/status.ts` — `phase1Unmet`'s group branch (252-283, the four §6.4 sentences) and `decideStory`'s owed-seat clause (650-657) |
| The crew's group-book refusals | `src/server/tools/writer.ts:editSummary` → `R6`, `tools/editor.ts:selectRevision` → `R5` and `requestMerge`'s branching `fix`, `tools/checker.ts:raiseFinding` → `R3` twice (unknown id 547-566, missing groups 568-586) |
| Finding scope and closure | `src/server/phrase/findings.ts` — `findingGroupScope`, `findingGroupsStillOwed`, `closeFindingWhenGroupsResolved`, `closeFindingAnsweredByInstalls` (re-run by the sweep at `loop/engine.ts:560-595`, group books only) |
| Purge and reset of the group book | `src/server/loop/engine.ts` — `deleteStory`'s three Phrase deletes (2673-2675), `editSeed`'s in-place row reset (3111-3135); `src/server/loop/invalidation.ts:scrapPhasesAfter`'s `groupRevisions` count (313/319/344-359) |
| The grouped loop | `src/server/loop/work.ts:phase1GroupCandidates` (batch, review seats, deep review) and `groupWorkTargets`/`groupWriteAttempts`/`GROUP_WRITE_ATTEMPT_CAP`; the install fires in the settle path at `src/server/loop/engine.ts:1445-1528`; what the pipeline still OWES is read from `src/server/phrase/exclusion.ts:groupPipelineOwed`, which `loop/status.ts` uses for both the drain and the sign-off |
| The Author's phrase verbs | `src/server/api/routes.ts` — `GET /stories/:id/phrases` (720), `POST /stories/:id/phrases/import` (740), `POST /stories/:id/phrases/groups/:groupId/revise` (798); group-book refusals at 1106 (`summary/revise`), 1581 (`revisions/:id/select`), 1765 (`revisions/merge`) |
| The projection | `src/server/api/projections.ts` — the `PhraseView` the desk reads: the phrase row, the five groups with `revision`, `writer_busy` and open finding/task counts, and the group-scoped findings |
| The desk | `src/dashboard/components/SummaryOverviewPane.tsx` (the Overview) + `SummaryGroupPane.tsx` (one per group, with the Revise control); rail items in `story-nav.ts` (`STORY_PHRASES`); the sign-off gate in `story-contract.ts:groupSignOffBlockers`; transport `src/dashboard/api.ts:getPhrase`/`revisePhraseGroup`; store slice `state.phrases` + `state.phraseErrors` |

### The grouped loop (R2, R3, R4, R5)

1. **Who owes text** (`work.ts:groupWorkTargets`, L-3: read from records, never engine memory):
   a group with `revision: 0` (never written), or a group an open finding targets that no revision
   of THAT group resolves (`findings.ts:findingGroupsStillOwed`). A finding with NO `group_refs`
   means "the whole Overview" — the legacy reading — so an old complaint still routes work, it just
   routes more of it.
2. **The batch** is `max(1, stories.summary_sampling)` groups from that set after R4's exclusion
   (`exclusion.ts:partitionGroups`), claimed as the family
   `wi_draft_groups_<summaryRef>_<group-set hash>_<attempt>`; `run/executor.ts` copies the batch's
   `group_refs` onto the Run row, and THAT is the lock — the key is ledger identity.
   `parseGroupDraftAnswer` refuses the whole batch when it is not schema-valid, so a partial answer
   installs nothing (no half-rewritten Overview).
3. **An accepted answer installs immediately** (R5): `engine.ts:1445-1528` calls
   `installGroupRevisions` in the commit that closes the run. There is no selection step, no
   `select`, no `revisions/merge`, no whole-Summary `revise` — those routes answer 409 on a group
   book, each with a sentence naming the route to use instead, and the TOOLS are refused there too:
   `tools/editor.ts:selectRevision` aimed at the Summary unit answers `R5` (its `fix` says to raise a
   finding naming the groups), and `tools/writer.ts:editSummary` answers `R6` instead of writing the
   mirror by hand. A legacy `'sampling'` book keeps both tools exactly as they were.
4. **The review is keyed by the group vector** (`revisions.ts:groupVectorHash` — sha256-16 over the
   sorted `<groupId>:<number>` pairs, so the SAME set of texts in any order gives one hash). An
   install moves the vector, so the reading seats re-arm by themselves:
   `wi_review_groups_<vectorHash>_<pass>` for `pass` 1…`stories.summary_readers`, each a
   no-tools `review_groups` run over EVERY group (a defect that crosses groups must be able to name
   every group it crosses), answered against `GroupReviewSchema`.
5. **The deep review** (`check_unit`, tool-carrying, `reader`) opens only once every structured seat
   for that vector has reported: `wi_group_check_<vectorHash>_<pass>`, the same count. This is the
   pass that turns "the Reader noticed something" into a FINDING, and the one thing it must do that
   the legacy pass never had to is say **which groups** each complaint is about.
6. **Findings close across groups, not one at a time** (R3). A group "resolves" a finding only by
   the EXPLICIT claim on the row — a `group_revisions` row whose `finding_refs` names the finding
   (`findings.ts:groupResolvesFinding`, newest such row wins). `findingResolution` reports
   `{targeted, resolved, missing, resolved_all}`, and `closeFindingWhenGroupsResolved` flips the
   finding to `fixed` only when `resolved_all` is true AND the finding's state is `approved` — an
   unapproved (`unconfirmed`/`confirmed`) row must not close over the Author's gate (D-33/D-34), and
   a `fixed`/`discarded`/`disputed` row is left alone, so a replayed install changes nothing. There
   is no "partly fixed" state: the open finding with its `missing` groups IS the honest answer, and
   `findingGroupsStillOwed` routes exactly those groups into the next batch — so a finding naming
   THREE groups under a batch size of 1 stays `approved` with its task `open` across three sweeps,
   because closing on the first install would report a defect as answered while two of the five
   groups still said the thing the Author complained about. A Writer can also install the answer
   BEFORE the approval lands, and then the planner stops dispatching for it, so the SWEEP re-runs the
   same read every round (`engine.ts:560-595`, the `loop_reconcile_findings` step →
   `findings.ts:closeFindingAnsweredByInstalls`, which re-reads the row rather than trusting the
   caller's copy) and closes the fix tasks that named the now-`fixed` finding. That step is scoped to
   `isGroupManagedStory` books, because with no phrase rows `findingResolution` answers
   `resolved_all: true` VACUOUSLY and acting on that would delete a sampling round's fix work. A
   Checker `raiseFinding` on a group book's Summary that omits `group_refs` is REFUSED
   (`tools/checker.ts`, "R3"), as is a `group_refs` entry naming an unknown group id — and the
   unknown-id refusal no longer offers "omit the list" on a group book, because a grouped Summary has
   no unscoped path to omit into.
7. **Retry, bounded, per group — and the bound is per TEXT, not a lifetime maximum** (R4):
   `GROUP_WRITE_ATTEMPT_CAP = 2` (`phrase/exclusion.ts:215`). `groupWriteAttempts` counts CLOSED
   **holding** runs whose JOURNAL POSITION is after the write that produced the text the group holds
   NOW — `writeBaselineOf` takes the `latest` revision's create event, or, when the group has no
   revision rows, the LAST create-or-update event on the group row. Three consequences: a successful
   install MOVES the baseline, so a group that was rewritten cleanly and is criticised again has a
   fresh pair of attempts against the NEW text; the pass that installed the current text predates its
   own revision row and so is not an attempt AGAINST it, which is why a just-written group reads 0; and
   a Seed reset re-baselines through the reset's own update event, so the scrapped Seed's passes are
   never charged to the new one. A LIVE run is never counted, and a `review_groups` seat or a deep
   review is never counted — they carry `group_refs` but install nothing, so reading the Overview does
   not spend the budget for rewriting it (F1). When the cap is hit the group is PARKED, and
   `groupPipelineOwed` refuses to count a parked group as owed: the loop stops paying for a provider
   that cannot answer the schema without holding the drain hostage, and the open finding, with its
   attempts visible in the rail, is the escalation.

**Three facts that are easy to get wrong from the outside.** (a) **The drain and the sign-off now read
the group pipeline.** `loop/status.ts:phase1Unmet` has TWO branches and never both: a group book takes
the group branch (252-282) and a `'sampling'` book takes the sampling branch below it, so the claim
that "the drain probe is sampling-only" is out of date. On a group book the probe names, in §6.4's
order: `"…group-pipeline run(s) still in flight (R5, §6.4 steps 3-6)"` (live runs matched by
`phrase/exclusion.ts:isGroupPipelineRun`), `"…group(s) still owe the Overview a draft or a fix pass
(R2, §6.4 step 3)"`, `"…Reader pass(es) still owed on the installed group Overview (R3, R5, §6.4 step
4)"` and `"…deep-review pass(es) still owed for the installed group Overview (§6.4 step 6, R5)"`. Every
number comes from ONE predicate, `phrase/exclusion.ts:groupPipelineOwed`, which is built from the same
gates `work.ts:phase1GroupCandidates` builds its candidates from — queue and probe cannot tell two
stories about one book, and the seat keys the probe counts are the generator's own keys. The practical
consequence for the role loop: **an install re-arms a whole reading cycle**, because `groupPipelineOwed`
counts the structured seats of the NEW vector first and reports the deep-review count as zero until
every seat has closed — so an accepted draft means `summary_readers` more `review_groups` passes and
then that many `check_unit` passes before the Story may read `drained`, and `decideStory` holds the
`pending / phase_signoff` offer over the same owed passes (`status.ts:650-657`; the gate got TIGHTER to
match the rail, never looser). The HTTP lock route is unchanged (`routes.ts`'s tray gate L-7a, then the
Goal U-16): what changed is that the sweep no longer OFFERS the sign-off while the current vector is
unread. The desk's own blocker sentences are a different read
(`src/dashboard/components/story-contract.ts:groupSignOffBlockers`: the phrase read not landed or
failed, unwritten groups, open blocking findings, open Story tasks, a live Writer on a group) — the
owed-seat obligation is deliberately NOT one of its sentences, so it surfaces as the Story staying
`ready` plus the drain line above. (b) **A live hold blocks an authoring write, never a reading seat.**
A `draft_groups` run holds its batch from dispatch until it closes; that hold is what makes "who last
edited this group?" answerable (R4), what makes the Revise refusal honest, and what makes a restart
re-claim the same batch instead of re-billing it. Two corollaries the code enforces: if every group of a
batch goes busy the generator offers NO Writer candidate that sweep — the batch waits, and no claim key is
spent on an empty answer (deferral, never cancellation: a held group is `deferred` by
`phrase/exclusion.ts:partitionGroupRefs`, and R4's whole point is that the next sweep runs it), and a
`review_groups` seat may run before, during or after a write — its verdict is about the vector that
existed when it started, which is why the projection carries `review.vector_hash` at all. (c) **A group
row's identity outlives its text.** A Seed reset and a backtrack keep the `phrase_groups` rows and their
UUIDs (`engine.ts:3111-3135`, `invalidation.ts:344-359`); only the texts, the Overview and the revision
history go. Anything that re-mints the catalog instead of resetting the rows has broken R1's addresses,
the attempt baseline, and every open finding's `group_refs` at once.

### The Author's phrase verbs (R5, R6)

- `GET /stories/:id/phrases` — the grouped view (phrase row + five groups + group-scoped findings).
  A legacy `'sampling'` book is not an error on this read: it answers `mode: 'sampling'` with
  `phrase_id: null`, `revision: 0`, `overview: ''` and empty `groups` (`projections.ts:phraseView`'s own
  note says that IS the truth about the book). The legacy revisions are not on this wire — the desk reads
  `GET /stories/:id`'s `sampling`/`revisions` projection for the legacy panel, so one surface never
  pretends to be the other.
- `POST /stories/:id/phrases/import` — the explicit, idempotent switch of a legacy book onto groups:
  `importLegacySummary` lifts the five prose fields into first revisions and sets
  `summary_mode: 'groups'`. Nothing does this silently (R6: no migration, and no read writes the flag).
- `POST /stories/:id/phrases/groups/:groupId/revise` `{content, note?}` — the Author rewriting ONE
  group. `:groupId` is the `phrase_groups.id` UUID the `GET …/phrases` view reports, NOT the catalog
  key (`premise`), and an unknown id is a 404. `400` on blank content, `409` on a non-group book
  (naming `/phrases/import`), and `409`
  while a live Writer pass holds that group — the refusal names the holding run ids, because "try
  again" without a reason is indistinguishable from a hang (F8).
- Locked, on a group book, with the route naming the verb to use instead: `POST
  /stories/:id/summary/revise`, `POST /stories/:id/revisions/:id/select` and `POST
  /stories/:id/revisions/merge` (R5 — "there is no whole-Summary draft set to select from").
- **The crew's tools are refused on the same book, with grouped fixes.** `editSummary` answers
  `R6` (the five prose fields are the install's mirror; the hint names the `draft_groups` job and the
  per-group revise route — the refusal sits after the lock/phase guard and BEFORE argument parsing, so
  it never depends on the args being valid); `selectRevision` aimed at the Summary unit answers `R5`
  (its `fix` is "raiseFinding with `group_refs` naming every group the defect crosses");
  `raiseFinding` on a grouped Summary answers `R3` when the groups are missing or unknown, and on a
  group book the unknown-id hint says name every id rather than "omit the list". Chapter and plotline
  selection, and every tool on a `'sampling'` book, behave exactly as they always did.
- The two legacy counts keep their names and change their meaning (no new fields, no migration):
  `summary_sampling` is now **how many groups one Writer pass may rewrite** and `summary_readers` is
  **how many reading seats each installed Overview gets** — both still bounded by
  `SUMMARY_REVIEW_LIMIT` (20) in `routes.ts`.

### What the desk shows (T2)

The rail carries ONE phrase — `story-nav.ts:STORY_PHRASES` is `[{key: 'summary', number: 1, title:
'Summary'}]`; `ALL_STORY_PHRASES` keeps the four-phrase vocabulary for panes that still address a
phrase directly, and the rail renders no row for Characters, Plotlines or Chapters. Under the
Summary row the rail lists the FIVE GROUP ROWS in composition order
(`StoryOutline.tsx:groupChildren` ← `story-nav.ts:summaryGroupEntries`), each named by its own title
and badged: `writer` while a live Writer pass is replacing it, `to write` while it has no revision,
plus the count of blocking (critical/major, open) findings — the same read the Overview pane and the
sign-off gate use, so a badge can never disagree with the pane it points at. `Revision 1 … N` rows
are gone from this rail: a grouped Story's rows are groups, not drafts, and a group's revision
number lives in its own pane. Archived history is not a rail row either, because the projection sends
metadata for superseded rows and only the revision immediately before the latest (the body the group
pane diffs the current text against).

Inside the Summary pane: `SummaryOverviewPane` (the composed Overview, one row per group with its
revision number and its archived COUNT — never the archived text, and `0 archived` is printed only
when it is worth reading, `SummaryOverviewPane.tsx:141-147`) and one `SummaryGroupPane` per group
(its text, `Revision N` / "No revision yet", its findings, its Writer-busy sentence, and the Revise
control that calls `revisePhraseGroup`). `SummaryPane` + `StoryView.tsx:193-198`'s two dials
(`setSummaryReview` → `PATCH /stories/:id`) are the LEGACY `'sampling'` rendering; U3 removed the
dials, the candidate cards and the pick/merge controls from the grouped surface. The sign-off gate
reads the phrase view: `story-contract.ts:groupSignOffBlockers` refuses to call a Summary ready while
the phrase read has not landed or failed, a group is unwritten, a blocking-cost finding is open on a
group, the queue holds an open task (the sentence says "open Story task", because the read's task rows
carry no group attribution), or a live Writer is rewriting a group — the text on screen is about to
move. Two gates sit behind that list and neither is the desk's invention: the sweep withholds the
`pending / phase_signoff` OFFER while the current vector's Reader seats or deep passes are still owed
(`loop/status.ts:decideStory` → `phrase/exclusion.ts:groupPipelineOwed`), and the HTTP lock keeps its
own, unchanged gate (the Ideas tray, then the phase Goal). What the desk does NOT do is print the
owed-seat count as a blocker sentence: that obligation surfaces as the Story staying `ready` and as the
drain line naming the passes still owed, which is why the rail, the drain and the Accept button all
come back to the same predicate.

### ADR — whole-Summary sampling is superseded by per-group revisions (2026-11-24)

**Decision.** A Summary is five independently revisable groups, not one text with one revision
line. A group's ADDRESS is a persisted UUID (`phrase_groups.id`), so the hold, the finding scope and
the revision line survive a restart and a catalog retitle; the catalog key (`premise`, …) is for
humans and prompts only. Accepted Writer output installs immediately per group (R5), history is
archived and retained rather than deleted, the legacy `summaries` fields become a generated mirror
(R6), findings carry `group_refs` and close only when every group they name is resolved (R3), and a
live Writer pass holds exactly the groups it is rewriting (R4).

**Why the old model was retired.** Whole-Summary sampling asked N Writers to rewrite all five (six,
with `world_rules`) fields end to end, then deleted N−1 of the drafts. One complaint therefore cost
a rewrite of everything, the deleted losers left only `sampling_history` behind, and the "revision
1…N" the rail showed was a chain of whole-Overview winners with no way to say "Tone is fixed,
Premise still isn't". Independence plus retention is what the loop can act on.

**What is superseded, and what is retained.**

| Superseded for a group book | Retained |
| --- | --- |
| `sample_unit` waves and N competing Summary drafts; `screen_samples` screening; the deterministic selector (`loop/sample-select.ts`) and the `choose_sample` commit; the selection's hard-delete of the losers; `sampling_round` advancement; the plateau ladder over whole-Summary rounds (`loop/phase1-plateau.test.ts`); `POST summary/revise`, `revisions/:id/select`, `revisions/merge` for the Summary unit | The Seed Brief and research gates (`phase1PipelineCandidates`'s `researchGate` is the SAME predicate the group pipeline reads — the redesign changed what a Writer is asked to write, not what it must answer first); citation and evidence rules; the deep-review Reader passes; `stories.summary_mode` as the Author's switch, with ABSENT meaning `'sampling'` so legacy books read with no migration; `GET /stories/:id`'s `sampling` projection as the legacy audit; the `summaries` record as a read surface; `revisions`/`sample_reviews` rows for legacy books |

**Two examples worth memorising.**
- *Group independence:* a Reader files a finding about the Promise's stakes. The Writer batch rewrites
  Promise alone. Promise goes revision 1 → 2, the Overview recomposes, and **Premise, Theme, Tone and
  Ending stay at revision 1 with their text untouched** — their `writer_busy` flags never flip and
  their attempt allowances are untouched, because the batch, not the Story, is the unit of the commit.
- *A multi-group finding:* a Checker files "the Ending resolves what the Premise never set up" with
  `group_refs: [premise, ending]`. It buys ONE draft pass over both groups (`groupWorkTargets` unions
  them into one batch when both are free), the install stamps `finding_refs: [that finding]` on BOTH
  new revisions, and the finding stays open until BOTH groups carry a revision claiming it — closing
  it when only Ending moved would re-open the same complaint next sweep. (`integration/summary-groups.test.ts`
  is that example end to end.)
- *The same finding, three groups deep, with the Author slow:* a finding naming THREE groups on a book
  whose `summary_sampling` is 1 is fixed over three sweeps, and §4.10 has no "partly fixed" state, so
  the row stays `approved` with its task `open` until the LAST group installs a claiming revision. If
  the approval lands AFTER the last install — the Writer answered the defect while the row was still
  `confirmed` — the install-time close correctly declines (D-34's gate), the planner has nothing left
  to dispatch, and the sweep's `loop_reconcile_findings` step (`engine.ts:560-595`) closes the finding
  and its tasks one round later. Before that step the row sat `approved`, answered, and never closed.
  Pinned by `loop/group-findings-batch-cap.test.ts`.

**Hardening addendum, same date — four consequences the first version left implicit.**
1. **The write path is closed at the TOOL layer, not only at the route.** On a group book
   `tools/writer.ts:editSummary` refuses with `R6` rather than writing the mirror by hand, and
   `tools/editor.ts:selectRevision` refuses with `R5` when aimed at the Summary unit. Both refusals
   carry a `fix` that points at GROUPED work — the `draft_groups` job, the per-group revise route, or
   `raiseFinding` with `group_refs` — and never at the retired selection. `tools/checker.ts:raiseFinding`'s
   unknown-group refusal likewise no longer offers "omit `group_refs`" on a group book, because there is
   no unscoped Summary path to omit into. Phases ②/③ selection and every legacy book keep the workflow
   they always had.
2. **Sign-off and the drain read the group pipeline, from one predicate.** `phrase/exclusion.ts:
   groupPipelineOwed` is the single source for live group runs, groups owing a draft or fix pass, the
   structured seats of the CURRENT vector and its deep-review passes; `status.ts:phase1Unmet` and
   `status.ts:decideStory` both read it, so the queue, the drain line and the sign-off offer cannot
   disagree. The visible consequence: **an accepted install re-arms a whole reading cycle** — the seats
   of the NEW vector are counted first, and the deep-review count is reported only once every seat has
   closed — so the Story stays `ready` (no sign-off offered) until `summary_readers` `review_groups`
   passes and then that many `check_unit` passes have closed. Pinned by `phase1-groups-drain.test.ts`.
3. **The group book is purged and reset like every other artifact.** `deleteStory` deletes the three
   Phrase collections in its one commit; `editSeed` resets the five group rows in place (same UUIDs,
   `''`/`0`/null) and clears the Overview and the mirror; `scrapPhasesAfter` clears the group revision
   HISTORY and reports it as `counts.groupRevisions`; a backtrack to `summary` keeps the texts and drops
   the history, per L-31. Pinned by `api/story-delete.test.ts` and `loop/group-seed-reset.test.ts`.
4. **The attempt cap is per text, not per Story.** The baseline is a journal position
   (`writeBaselineOf`), an install moves it, and a Seed reset re-baselines; reading never counts. So
   "two attempts" is a bound on re-drafting ONE text, never a lifetime ceiling on how many revisions a
   group may have.

### How to verify

```bash
# from the repo root — the group suite, file by file
yarn vitest run packages/erosire/create-storyline/src/server/phrase/catalog.test.ts
yarn vitest run packages/erosire/create-storyline/src/server/phrase/revisions.test.ts
yarn vitest run packages/erosire/create-storyline/src/server/phrase/exclusion.test.ts
yarn vitest run packages/erosire/create-storyline/src/server/phrase/findings.test.ts
yarn vitest run packages/erosire/create-storyline/src/server/loop/phase1-groups.test.ts
yarn vitest run packages/erosire/create-storyline/src/server/loop/phase1-groups-restart.test.ts
# the 2026-11-24 hardening pins
yarn vitest run packages/erosire/create-storyline/src/server/loop/phase1-groups-drain.test.ts        # the four group drain sentences; probe keys == generator keys; sign-off opens only once the seats have reported
yarn vitest run packages/erosire/create-storyline/src/server/loop/group-seed-reset.test.ts           # Seed edit resets the five rows in place (same ids, ''/0/null); backtrack keeps the texts and drops the history; ensurePhraseCatalog re-press is a no-op
yarn vitest run packages/erosire/create-storyline/src/server/loop/group-findings-batch-cap.test.ts   # a three-group finding under a batch of 1 closes only on the LAST install; late approval reconciles a sweep later; the vacuous legacy read never closes
yarn vitest run packages/erosire/create-storyline/src/server/api/story-delete.test.ts               # the delete commit also purges phrases / phrase_groups / group_revisions
yarn vitest run packages/erosire/create-storyline/src/server/tools/group-mode-writes.test.ts         # the grouped refusals AND the exact `fix` copy they return, with the legacy book's unchanged advice pinned beside them
yarn vitest run packages/erosire/create-storyline/src/server/api/phrase-routes.test.ts
yarn vitest run packages/erosire/create-storyline/src/server/integration/summary-groups.test.ts
yarn vitest run packages/erosire/create-storyline/src/server/tools/checker-group-attribution.test.ts
yarn vitest run packages/erosire/create-storyline/src/dashboard   # the *.groups.* and *.phrases.* tests
# the whole package
yarn --cwd packages/erosire/create-storyline test
# one-off probes against the catalog/composition, without a test runner
# (scratch lives in the OUTER repo root's Temp/ — this package is a nested git repo)
yarn vite-node Temp/create-storyline-orchestrator/<task>/<probe>.ts   # never `node`, never `tsx`
```

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
  `write_unit` and no `select`**. On a group book (R5) its work is `draft_groups` → `review_groups`
  → `check_unit` over ONE text per group (`loop/work.ts:phase1GroupCandidates`), and an accepted
  answer installs immediately — there is no competing set to choose between. Only a LEGACY
  `'sampling'` book still runs the sampling round (`summary_sampling`,
  `loop/work.ts:phase1PipelineCandidates`, `loop/sample-select.ts`). `writer-summary-sampler` is
  `attempts: 1` under both readings — one run is one pass. The dial itself is `PATCH /stories/:id`
  with `auto_approve: Cost[]` (D-35), and it is the whole ladder: verify → approve → task → repair.
- **`chapter_count` lives on the Summary**, not on the Story (D-3b), and the chapter set is
  materialised by the Plotlines **lock** (D-3c) — not by a Writer. Neither Summary writer touches it:
  the group install writes five mirror fields (`phrase/revisions.ts`), the LEGACY selection installs
  the six prose fields (`engine.ts:SUMMARY_PROSE_KEYS`, `engine.ts:1726-1730`), and **neither** writes
  `chapter_count`, because a Writer cannot carry Author truth.
- **A LEGACY sampling round is read from three record families, plus its run rows.** `revisions` rows whose
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
- **A group book has no Summary `revisions` rows, no `sample_reviews` rows and no
  `sampling_round`.** Its texts are `group_revisions` rows and its history is the union of the five
  group lines, so anything that reads `store.revisions` for `unit_ref === <summary id>` sees the
  LEGACY audit only. `GET /stories/:id` still projects `sampling` for that reason; the grouped desk
  reads `GET /stories/:id/phrases` instead, and the grouped rail shows each group's latest text plus
  a count of its archived revisions — the archived bodies are not on the wire, except the one the
  latest revision replaced, which the group pane renders as its latest-vs-previous diff.
- **The group path never feeds the loop's sampling vocabulary, and since the 2026-11-24 hardening the
  drain probe reads the GROUP pipeline.** `loop/status.ts:phase1Unmet` branches: a group book answers
  from `phrase/exclusion.ts:groupPipelineOwed` (live group runs, groups owing a draft or fix pass, the
  structured seats of the CURRENT vector, then its deep-review passes), and the sampling clauses
  (samples, screening sets, the round arm, the plateau) apply only to a `'sampling'` book. The engine
  still SKIPS sampling, wave and plateau work for a group book (`loop/work.ts`'s mode switch,
  `loop/engine.ts:1606`, `1994`, `2073`). So: a group book's drain reason DOES name groups and seats,
  and a group book never gets a sampling reason, a wave, or a plateau STOP. Two gates read the same
  predicate: `decideStory` withholds `pending / phase_signoff` while the current vector's seats or deep
  passes are owed, and the desk lists its own group blockers
  (`story-contract.ts:groupSignOffBlockers`). The HTTP lock gate is unchanged (Ideas tray, then Goal).
- **A live group Writer holds EXACTLY its batch, and the hold is derived from rows, never from a
  semaphore** (R4, L-3/L-5): `phrase/exclusion.ts:liveGroupSets` reads the live `draft_groups` runs'
  persisted `group_refs`. Three consequences people get wrong: a holding run with NO `group_refs`
  holds EVERY group (fail-closed — one deferred sweep beats two writers installing over each other);
  a held batch is SHRUNK, not cancelled (`partitionGroupRefs`, so `{premise, tone}` with premise live
  offers `{tone}` rather than nothing); and a `review_groups`/deep-review run carries `group_refs`
  for all five groups yet is NOT a holding run (`isGroupHoldingRun`), which is why reading an
  Overview never spends a group's two Writer attempts.
- **An unbound Editor job binds `editor-general` because it is FIRST in `DEFAULT_ASSIGNMENT`.**
  `records.ts:templatesFor` returns the assigned templates of a role kind in assignment order and
  `work.ts:candidate` takes the first, so `verify_findings`, `verify_ideas`, `directive_work` and
  `select` all run on `editor-general` — and the phase-① structuring pass binds
  `editor-seed-structure` explicitly to stay off it. The ordering is load-bearing: putting the
  structurer first made every phase-① verification run the structuring prompt.
- **A `toolMode: 'none'` run has no engine thread.** Phase ①'s `sample_unit`/`screen_samples` runs —
  and the grouped model's `draft_groups`/`review_groups`, which inherited the mechanism unchanged —
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

`POST /stories` (Seed + `chapter_count` → Story + empty Summary + Goal; the Story is born
`summary_mode: 'groups'` and `phrase/catalog.ts:ensurePhraseCatalog` creates the `phrases` row and
the five `phrase_groups` rows in the same commit, `loop/engine.ts:createStory`), `GET /stories`,
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

`PATCH /stories/:id` also carries phase ①'s two counts — `summary_sampling` and `summary_readers`,
both integer-bounded to `SUMMARY_REVIEW_LIMIT` (20) by `routes.ts`; `SummaryPane`'s two number
inputs call the same fields. **Their meaning changed with the group model and their names did not**:
on a group book `summary_sampling` is how many GROUPS one Writer pass may rewrite (the batch size,
`loop/work.ts:phase1GroupCandidates`) and `summary_readers` is how many READING SEATS each installed
Overview gets (the structured `review_groups` passes, and the deep-review passes that follow them);
on a legacy `'sampling'` book they are still the sample count and the screening count. The
Summary-Phrase verbs are `GET /stories/:id/phrases` (the grouped view; a legacy book answers
`mode: 'sampling'` with `phrase_id: null` and empty groups, and its revisions come from
`GET /stories/:id` instead), `POST /stories/:id/phrases/import` (the explicit,
idempotent move of a legacy book onto groups — nothing does it silently), and `POST
/stories/:id/phrases/groups/:groupId/revise` `{content, note?}` (the id is the `phrase_groups.id`
UUID) for the Author rewriting ONE group;
that last one answers `400` on blank content, `409` on a `'sampling'` book (naming
`/phrases/import`), and `409` naming the holding run ids while a Writer pass is rewriting that group
(`phrase/exclusion.ts:liveGroupWriters`) — "try again" without a reason is indistinguishable from a
hang (F8). The three whole-Summary verbs are refused on a group book, each with the verb to use
instead: `POST /stories/:id/summary/revise` (refusal at `routes.ts:1106`), `POST
/stories/:id/revisions/:revisionId/select` (`routes.ts:1581`) and `POST /stories/:id/revisions/merge`
(`routes.ts:1765`). The same three doors are closed to the CREW as tools: `editSummary` answers `R6`,
Summary-unit `selectRevision` answers `R5`, and a grouped Summary `raiseFinding` without `group_refs`
answers `R3` — each with a `fix` naming the grouped move (`draft_groups`, the per-group revise route, or
`raiseFinding` with the group ids), so a run that reaches for the retired selection is told where the
current door is.
Reading a Story: `GET /stories/:id` projects `seed_brief` (the accepted Seed Brief trimmed to its
reading fields; `null` before gate 1) and `sampling` (`{round, active_round, selected?, history}` —
`round` is the last COMPLETED round and the deep review's round, `active_round` is the round IN FLIGHT
through the loop's own predicate, since one number cannot answer both; history newest-first and capped
at five, and each line carries the candidates' `outcome`/`reject_reason`/`unresolved_fixes`/origin
split/minimality and the wave's ledger, because the selection commit deleted the drafts those fields
describe) beside the §4 collections. That projection is the **LEGACY audit**: on a grouped Story the
stored `sampling_round` never advances (the projection prints `sampling_round ?? 1`, so a grouped book
reads as "round 1" with an EMPTY `history` and no wave recorded), because no grouped job writes those
counters, and the Summary's real history is the union of the five `group_revisions` lines on
`GET …/phrases` instead (`api/projections.ts:samplingView`). The knowledge
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

- **`engine.deleteStory`'s purge list NOW includes the Summary Phrase collections** — the deviation
  this file recorded on 2026-11-24 is closed. The original finding: the probe
  `Temp/create-storyline-orchestrator/T4/phrase-delete-probe.ts` (run through `yarn vite-node`)
  measured `phrases=1 phrase_groups=5` surviving a delete, because the purge list named §4's rows and
  the three research collections but never the group rows. `engine.ts:2673-2675` deletes `phrases`,
  `phrase_groups` and `group_revisions` in the SAME `delete_story` commit as the Story row, after the
  live runs are killed with `'delete'` and settled (a run that outlived its Story would teardown into
  rows the commit had already removed). Phrase findings, fix tasks and group-review verdicts ride the
  existing `findings`/`tasks`/`verdicts` deletes; P1 gives the delete no lock exemption, so a locked
  Summary goes with the book. Pinned by `api/story-delete.test.ts`, which seeds a group book through
  `installGroupRevisions` and asserts the three collections come back empty.
- **The Seed edit and the backtrack now reset the group book — the second 2026-11-24 deviation, also
  closed.** What used to be true: `editSeed` cleared only the legacy mirror, and `scrapPhasesAfter`
  deleted nothing group-shaped, so a changed Seed left the OLD Seed's five group texts driving every
  rule — `groupWorkTargets` saw five written groups and offered no first draft, the review seats stayed
  keyed to the stale vector, and the archived `group_revisions` kept their claim on the attempt baseline
  and on R3's closure join. What is true now, in one commit per flow:
  - `loop/invalidation.ts:scrapPhasesAfter` (313, 319, 344-359) deletes every `group_revisions` row of
    the scrapped phase when the phase rank is below `chapters` and the book is group-managed, and
    REPORTS the number as `counts.groupRevisions` beside `revisions`/`ideas`/`digests`/`verdicts`.
  - `loop/engine.ts:editSeed` (3111-3135) resets the five `phrase_groups` rows IN PLACE to the fresh
    catalog triple — `content: ''`, `revision: 0`, `updated_by: null`, **same UUIDs** — and the
    `phrases` row to `content: ''`, `revision: 0`, with the mirror cleared beside them. The next Writer
    batch is the five unwritten groups again, and a re-pressed `ensurePhraseCatalog` is a no-op on
    those ids (R1's addresses outlive the text).
  - `loop/engine.ts:backtrack('summary')` keeps L-31's convention instead: the reopened phase's OWN
    artifact survives — the group texts and their mirror stay in sync as the base for another round —
    while `scrapPhasesAfter` takes the group revision HISTORY with the scrapped work, and the sampling
    counters and `summary_review_history` restart. So "reset the current text" is the Seed edit's call
    and "keep the current text, drop the history" is the backtrack's, exactly as the legacy prose flow
    already decided it; neither flow re-mints the catalog.
  - The reason the row reset needs a JOURNAL baseline: `phrase/exclusion.ts:writeBaselineOf` falls back
    to `lastWriteSeqOf('phrase_groups', id)` when there is no `latest` row, so the reset's own `update`
    event becomes the boundary. Counting from the group row's CREATE instead would charge every pre-reset
    pass against the new Seed, park the group, and — because a parked group is never owed — let a book
    with an EMPTY Overview read as drained.
  Pinned by `loop/group-seed-reset.test.ts` (all four cases, including a sibling Story's catalog staying
  untouched).
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
  (`records.ts:sampleAttempts`/`screenAttempts`), and nothing un-runs a row. A sampling round's budget is
  `samplingCapOf` (`summary_sampling + 3`) EXTENDED by one attempt per improvement the wave proves, and a
  refinement round is stopped EARLIER by `SAMPLING_NO_PROGRESS_STREAK` (3) attempts in a row that beat
  nothing (`records.ts:samplingProgressOf`), so neither a moving hill nor a stalled one burns a number
  nobody chose. Either stop is recovered by a wave (T12/E): the Author clears the failure escalation, and
  the next sweep bumps `stories.sampling_wave` (guarded by the `wave: <n>` recorded in the row's detail,
  so it happens once per cleared row), which moves the claim prefix to
  `wi_sample_<summary>_<round>_w<wave>_` and starts the counter at 1 — the spent rows stay as audit, and
  the new wave starts with NO baseline and NO streak, because a fresh wave is a fresh baseline.
  Screening has no wave on purpose: a draft whose `summary_readers + 3` screening attempts are spent
  counts as screened (`records.ts:isFullyScreened`) and the round selects on the reviews it has, so
  there is nothing to reset. `editSeed` and a backtrack to `summary` restart the round at wave 0 with
  every revision scrapped. **A group book has none of that machinery**: its only counter is the
  per-group write allowance, whose baseline is a JOURNAL POSITION that an install moves and a Seed reset
  re-establishes, and a spent group is PARKED rather than escalated — with the Seed reset now clearing
  the group rows too, the allowance genuinely starts over (`loop/group-seed-reset.test.ts`, and the
  Seed-reset entry above).
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
   (last write won, T-4 races) and the Editor's select job was never produced. (Both halves of that
   fix are `'sampling'`-book behaviour now: a grouped Summary has no divergence mode and no selection
   job, and on that book `editSummary` is refused `R6` so the install owns the mirror — R5/D-61.)
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
   *(That was 2026-11-23, and it is why the tests carry those replacements permanently. The ids
   `U-18`/`U-19` were free to re-adopt, and the grouped Summary took them on 2026-11-24: they are now
   the real UI requirements for the phrase rail and the group panes — `specifications.md` §10.2 and
   §17.12. Nothing in `src/` cites them, so no test comment is pointing at a retired id.)*

## Where to start reading

Start with the group path: `src/shared/phrase.ts` (the catalog, the mirror map, the composition
format), `src/server/phrase/` (`catalog.ts`, `revisions.ts`, `exclusion.ts`, `findings.ts` — the four
rules R1/R6, R2/R5, R4 and R3), `src/server/loop/work.ts` (`phase1GroupCandidates` is phase ① now;
`groupWorkTargets` and `groupWriteAttempts` are the gates around it), `src/server/loop/engine.ts`
(the sweep, the states, the group install at `1445-1528`, the group-finding reconciliation at
`560-595`, and `trySelectSample` for the legacy path),
`src/server/run/phase1-prompt.ts` (`compileGroupDraftPrompt` / `compileGroupReviewPrompt`, and the
sampling/screening compilers it still also serves), `src/server/loop/status.ts` (`phase1Unmet`'s two
branches, `decideStory`'s owed-seat clause, and the four drain sentences),
`src/server/loop/invalidation.ts` (`scrapPhasesAfter`, and the `groupRevisions` count it reports),
`src/server/run/executor.ts` (the no-tool turn),
`src/server/api/routes.ts` (the three phrase verbs) and `src/server/api/projections.ts`
(`phraseView`, and what the Author is told). Then `src/server/loop/sample-select.ts` (the LEGACY
ranking, alone) and `src/server/integration/harness.ts` (a crew that only ever sees its brief).
`documents/specifications.md` §17 is the group contract, §16 the legacy pipeline, and §15 the walk
all of it is built to survive.

## The knowledge directory and the employee roster (2026-11-22)

The dashboard's left rail carries the Story's phrase navigator and its right rail carries the
global employee roster. Both are projections, and neither is a second source of truth:

- **The directory** (`src/server/knowledge/story-knowledge.ts`) writes through the harness's
  cross-session knowledge engine (`createKnowledgeEngine` + `loadKnowledgeFileStore`) — the same
  engine the `knowledge` tool uses. One article per section; the nine sections are Research (FIRST,
  mirroring `store.knowledge` — the Researcher's entries with importance and sources), Summary,
  Plotlines, Chapters, Characters, Continuity, Goal, Ideas, Findings. The bytes live at
  `<storeRoot>/harness/knowledge/` — and inside a workspace, `<root>/stories/<uuid>/harness/knowledge/`:
  each Story's runtime opens its OWN projection over its own book (`runtime/story-runtimes.ts:build`),
  so one Story's articles are never another Story's. Outside every session either way, so a destroyed harness or a restart
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
  retained log lives at `<root>/stories/<uuid>/harness/threads.jsonl` — one file per Story, opened by
  that Story's runtime (`<storeRoot>/harness/threads.jsonl` for a server with a single book),
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

### The phrase rail and the focused content area (2026-11-22, partly superseded 2026-11-24)

> **SUPERSEDED IN PART.** The four-phrase rail and the flat `Revision 1 … N` Summary history
> described below are the 2026-11-22 shape. The rail today offers ONE phrase —
> `story-nav.ts:STORY_PHRASES` is `[{key: 'summary', number: 1, title: 'Summary'}]` — plus the Seed
> leaf and the folders, and the Summary pane is `SummaryOverviewPane` + one `SummaryGroupPane` per
> group (`SummaryPane.tsx` and the Select/merge chrome are the LEGACY `'sampling'` rendering). The
> full four-phrase vocabulary survives as `ALL_STORY_PHRASES` because `StoryView` still routes a
> `panel` prop to the panes that address a phrase directly. Read the rest of this section as the
> history of how the desk got here.

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

- **Summary (the group model, current)** — `SummaryOverviewPane` plus one `SummaryGroupPane` per
  catalog group, fed by `GET /stories/:id/phrases` (`state.phrases`, transport
  `api.ts:getPhrase`). The overview shows the composed Overview text, one row per group with its
  revision number and its archived COUNT, the review's own counts, and the sign-off state from
  `story-contract.ts:groupSignOffBlockers`; each group pane
  shows ITS OWN revision number, its text, its open findings, its Writer-busy state (`writer_busy` →
  the Revise control is disabled, because a live pass is rewriting that text — R4/F8) and a
  `POST …/phrases/groups/:groupId/revise` control. There is no Select, no merge, no whole-Summary
  Revise and no sampling dial on this surface (U3 removed them): those routes answer 409 on a group
  book, and the dials stay on the legacy `SummaryPane`. Archived revisions are counted, not
  listed — the grouped wire carries latest text, not the archived bodies.
- **Summary (the LEGACY `'sampling'` book)** — `SummaryPane`. It marks the phrase with a tick when
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
file saw on 2026-11-22; the pipeline it hands over to (the 2026-11-23 section at the foot of this
file) is itself the LEGACY `'sampling'` mode since 2026-11-24, and what a new Story runs is the
Summary Phrase system described near the top.
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

## A draft is Pending until its Writer returns, then Drafted for the review crew (2026-11-23, LEGACY since 2026-11-24)

> **LEGACY `'sampling'` mode.** `revisions` rows and the `pending → drafted` promotion are the
> whole-Summary draft model. A group-managed Story never files a Summary `revisions` row: its Writer
> answer becomes `group_revisions` rows in the install commit
> (`phrase/revisions.ts:installGroupRevisions`), which has no `pending` stage to promote through and
> no "every §4.2 block present" gate — the `GroupDraft` schema answers all the groups in its batch or
> the whole batch is refused (`parseGroupDraftAnswer`). Phases ②/③ keep this model unchanged.

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

## Phase ① is structure → research → sample → screen → select → deep review → refine (2026-11-23, LEGACY since 2026-11-24)

> **LEGACY MODE — read this whole section against `stories.summary_mode: 'sampling'`.** It is the
> pipeline this file verified on 2026-11-23, and it is still exactly what a legacy book runs and what
> `loop/phase1-research.test.ts`, `loop/sample-select.test.ts`, `loop/phase1-sampling-progress.test.ts`,
> `loop/phase1-plateau.test.ts` and `integration/summary-sampling.test.ts` still pin. As of 2026-11-24
> it is NOT what a new Story runs: `POST /stories` creates a `'groups'` book (see "The Summary Phrase
> system" near the top of this file). What that means for the details below, stated once so each does
> not have to be re-marked:
>
> | What this section says | What a group book does instead |
> | --- | --- |
> | `summary_sampling` one-turn samples compete; the deterministic selector ranks them and installs the winner | `summary_sampling` is the SIZE OF A GROUP BATCH; there is no competing set and no ranking — an accepted `draft_groups` answer installs per group the moment it is accepted (R5) |
> | `M` screens score each candidate draft | `summary_readers` structured `review_groups` seats read the INSTALLED Overview, keyed by the group vector, not a candidate |
> | The selection installs the six prose fields (`premise…world_rules`) and advances `sampling_round` | The install writes the FIVE group mirror fields, archives the rows it replaces, and touches neither `sampling_round` nor `world_rules` nor `chapter_count` |
> | `sampling_history` is the memory of the deleted losers | Nothing is deleted: every superseded text stays as an `archived` `group_revisions` row (R2) |
> | `loop/sample-select.ts`'s origin-aware eligibility, minimality over the six fields, the wave ceiling, `samplingProgressOf`'s hill budget and the plateau escalation gate the phase | None of it runs for a group book: the engine skips sampling, wave and plateau work when `isGroupManagedStory` (`loop/engine.ts:1606`, `1994`, `2073`). The group loop's bound is `GROUP_WRITE_ATTEMPT_CAP = 2` per group over one text, and its escalation is the open finding in the rail — the loop parks the group rather than asking the Author a second question about the same defect |
> | A finding is verified against `selected` / `superseded` / `artifact` revisions (`records.ts:findingRevisionScope`) | A finding is scoped by `group_refs` and closes when EVERY group it names has a revision claiming it (`phrase/findings.ts:findingResolution`) |
> | `POST revisions/:id/select` is the Author's override | It is a 409 on a group book; the Author's verb is `POST …/phrases/groups/:groupId/revise` |
>
> What survives unchanged in BOTH modes: the Seed Brief and the research gates (the group pipeline
> reads the SAME `researchGate` predicate — `loop/work.ts:1080-1086`), the citation/evidence rules and
> the Knowledge triage, the deep-review `check_unit` passes and their four Reader angles, the Ideas
> tray and lock gates, `verify_findings`, the D-35 dial, and backtrack.

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
OWES NO MORE SAMPLES — the full `summary_sampling` set exists, or the wave's attempt ceiling is spent
(`records.ts:samplingProgressOf` → `samplingBudgetSpent`: `samplingCapOf` = `summary_sampling +
SAMPLING_RETRY_ALLOWANCE`, EXTENDED by one per proven improvement, or cut short by the no-progress
streak — see "The hill's budget" below), or the round's sampling LEG has closed (D-52, below) — every
`drafted` sample is SCREENED (its full `summary_readers` set, or its screening attempts reached
`summary_readers + 3`, in which case the selection commit opens the partial-screening escalation), and
no live `wi_sample_*`/`wi_screen_*` run remains.

**Eligibility comes before ranking, and it is origin-aware (H1).** `loop/sample-select.ts:scoreSample`
computes the gates first, and the gates differ by mode, because the question a refinement round asks is
not the question round 1 asks:

- **Round with an ACCEPTED base** (the Summary carries Revision N, so `input.base` is real text): a
  candidate is eligible only when its screening set CAN certify at all, it introduces **no blocking
  issue of its own**, and every STILL-OPEN fix task its own screens were handed is marked `resolved`
  with non-empty `evidence` by **EVERY** pass that carried it (`certifiesFix`; unanimity is deliberate —
  one Reader saying `unresolved` is a live disagreement the loop resolves by resampling, not by
  averaging). `unknown` is the Reader admitting it cannot tell, which is not a pass; an unevidenced
  `resolved` is not a verdict (D-15); a schema-invalid pass can disqualify a draft but can never
  certify a fix.
- **First round** (no accepted base): §6.5's creation semantics stand — **zero `critical` AND zero
  `high`**, plus every demanded fix cleared.

The origin split is the whole point of the refinement gate. `introduced_*` are blocking issues THIS
draft created, and any one of them makes it ineligible whatever it fixed; `inherited_*` are blocking
issues the accepted text already had, which cost the candidate nothing on their own (Revision N was
accepted with them; the Author decides which become work — and one inherited issue the Author DID
target is an open fix task inside the candidate's demand, so "inherited" never means "excused"). An
issue whose origin no pass stated counts in `introduced_*`: **fail closed** — a pass handed the base and
silent about the origin cannot swear the draft is no worse than the text it replaces. `high` IS
`major` (`shared/types.ts:SampledIssue`), so "blocking" is the same pair of words in the screening
answer, in the selector, and in the Author's escalation. Minors never hold a round here: the screening
schema closes severity at critical/high (T-11) and the Summary prompts cost wording notes as
minor/taste (R6) — whether a CONFIRMED minor is work at all is the Author's dial, decided before a
candidate is scored ("The deep review" below).

**Then the ranking is a deterministic best, and among equals the smallest change (H1).** A refinement
round orders eligible candidates by **fewest unresolved fixes → no new `critical` → no new `high` →
fewest changed prose fields → fewest changed characters → the earliest candidate**; a first round keeps
§6.5's **fewest `critical` → fewest `high` → fewest total → the earliest sample**. Minimality
(`sample-select.ts:minimalityOf`) counts how many of the six §4.2 prose fields the draft touched and
the size of those edits in characters (common prefix and suffix stripped, so a one-clause fix costs the
clause, not the paragraph). It is a TIE-BREAK, not a quality score (P6): among candidates that cleared
the same certified work, the loop takes the smallest edit. The last key is CREATION ORDER and never an
id — ids are becoming per-book and opaque, so a numeric suffix that happens to be chronological is a
detail a later id change would silently invert.

**A refined round never falls back to the least-bad draft (R3).** An empty eligible set in a round WITH
an accepted base installs NOTHING: the incumbent keeps the Summary, the round re-samples inside the
wave's budget, and the exhaustion escalation is the Author's stop. Selecting the least-bad of a set the
round's own Readers rejected would install rejected text and close the fix tasks on the strength of
installing it — the loop running backwards. §6.5's least-bad path survives only where nothing is
outstanding: round 1, and a refinement whose fix tasks the Author has already settled.

One commit then installs the winner's six prose fields on the Summary — `premise`, `promise`, `theme`,
`tone`, `ending`, `world_rules`, and NEVER `chapter_count` — marks it `selected` with its
`issue_counts`, appends the round's `sampling_history` line BEFORE any delete (including the wave's
ledger and every candidate's `outcome`/`reject_reason`/`unresolved_fixes`/origin split/minimality —
that line is the only surviving record of a rejected attempt, because the same commit hard-deletes
every other revision of the round and every `sample_reviews` row pointing at one — and, since D-52,
every `drafted`/`competing` leftover of an EARLIER round too, together with the findings that named only
those drafts (retired to `discarded`) and the open tasks they queued (closed `wontfix`)), closes **only
the WINNER's `fixesCleared`** tasks as `done` and their findings as `fixed` (R4: proof, not an event),
and advances `sampling_round`. **A rejected candidate closes nothing and advances nothing** — its tasks
stay `open` and its finding stays `approved`, which is what arms the next round
(`records.ts:samplingArmed`). The losers exist afterwards only as that history line and as the
journal's delete payload (the Story view still renders them as `discarded`); no route restores one. Rows
the TOOLS parked as `discarded` (`commitSelection` sets losers aside for the dashboard) are never
deleted by the sweep — `records.ts:isReviewableDraft` is that guard.

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

**The Seed is a commitment, not an outline — and the rule lives where a model cannot lose it.** The
Seed and its Brief commit what they STATE; where they are silent, or name a gap in `open_questions`,
the Writer supplies any specific that contradicts nothing. So an added detail, a Seed question left
open, a stake the Seed never stated and setup a Summary did not promise are NOT defects at phase ① and
never a `C-14` finding, and phrasing is `taste`/`minor` because phase ③ writes the sentences. What
remains reportable is unchanged: a contradiction of the Seed, of critical Knowledge, or of the
artifact's own promise; a real contradiction inside the artifact; and a commitment the Seed states
EXPLICITLY that the draft does not carry (`criteria.ts:C-14`'s label is that test, and
`criteria/engine.ts` still grades C-14 against the raw Seed). Proof is a quotation, so a finding that
quotes only an absence is inadmissible **as an `issue`** — the Editor `dispute`s it (`verify_findings`,
`confirm_finding`) instead of confirming that something is missing, and the Reader's honest alternative
is a marked `improvement` (D-33b, next paragraph) rather than a defect claim. The rule is stated in FOUR
places on purpose, two of them engine-owned and unclipped: `run/brief.ts:READER_REVIEW_MODE` and that
file's
`check_unit` reader job line (the four angle templates are Author-editable copies, §4.12),
`run/brief.ts:jobStatement` for `write_unit`/`verify_findings`/`confirm_finding`/`structure_seed`,
`run/phase1-prompt.ts:SCREEN_INSTRUCTION` plus `SEED_CONTRACT_NOTE` on the tool-less paths, and the
first 600 characters of the sweep note (`loop/work.ts`) — `renderJob` clips that note at 600, so a
clause written past the window is a clause the model never reads. A required Seed Brief field the Seed
leaves silent renders as `OPEN_SCALAR_MARKER`'s explicit "the Seed states nothing here" line rather
than a blank, because a `stakes:` line with nothing after it reads as an unpaid promise. Phases ② and
③ keep every setup-and-payoff check (C-4, C-5, C-6): the four angle prompts scope the stand-down with
`When the artifact under review is a SUMMARY (phase ①)` and say the later phases keep it.

**An improvement is a proposal, not a defect, and `kind` tells the Editor which rule to run (D-33b).**
The rule above is a correct answer to "is this a defect" and a wrong answer to "is this worth doing":
a Reader that compared the Overview to the Seed, found the Seed silent about something, and reported the
silence earned a `dispute` it deserved — while the same pass had no honest way to say "here is a change
that would make the book better", because the review pass bans Ideas (D-26, D-30). §4.10 therefore
carries `kind`: `issue` (the default, and the reading of every row written before the field existed) or
`improvement`, normalised on write by `tools/checker.ts:raiseFinding` and refused at `cost: 'critical'`
— `critical` is the ladder's contradiction word and it is on the auto-approve dial by default, so a wish
wearing `critical` buys a Writer pass and walks past the Author's gate. The Reader files it with a title
that PROPOSES, `evidence` quoting the passage the change would improve, and `detail` saying what to
change and why the pass is worth it.

The Editor's `verify_findings` thread then answers a DIFFERENT question for that row, and the row itself
says so: the brief's "Findings in front of you" bracket prints `, improvement` (only for those rows, so
a plain issue renders byte-identically), and the job line scopes the absence rule to issues while
sending improvements to a merit check — does the change strengthen the story the Seed promises, is it
worth a pass, does it contradict the installed text — and forbids disputing one merely because the Seed
never promised it (`run/brief.ts:jobStatement`, the `editor-general` template's FINDINGS paragraph,
`tools/editor.ts:verifyFinding`'s description, and the sweep note in `loop/work.ts`). The same
distinction reaches the Writer, because delivering a proposal is not repairing a break: an approved
improvement carries `Kind: improvement` in the task detail and `kind: improvement (a proposal, not a
defect)` in the compiled fix prompt (`tools/editor.ts:approveFinding`,
`run/phase1-prompt.ts:renderFixTask`).

Two rules make the field cheap to add to a running system. **Deduping:** the kind is a fingerprint
component, and `issue` deliberately keeps the pre-field three-part form
(`tools/utilities.ts:findingFingerprint`), so a legacy row and a new `issue` report still bump
`seen_count` on one row while an improvement beside it stays a separate claim with its own verdict.
**Plumbing:** `kind` rides every projection that enumerates fields instead of spreading the record —
`tools/plumbing.ts:readFindings`, `readChapter.open_findings`, `tools/editor.ts:verifyFinding`'s
original/result payloads, `api/projections.ts:phraseView`'s finding rows, the knowledge surface
(`knowledge/story-knowledge.ts:findingEntries`), and `api/projections.ts:queueItems`, where it is named
`finding_kind` because the queue row's own `kind` is its discriminator. The dashboard draws no badge and
the Digest counts costs kind-blind: this field decides which rule a verifier runs, not what the loop
treats as blocking work. The tool-less screening and group-review paths stay as they were — an
`IssueList`/`GroupReview` answer has no findings to mark, so no kind to carry (R6's closed schema).

**A Summary `minor` continues only when the dial says so — and every path reads that one rule.** In
phase ① the blocking bar is `critical`/`major`, PLUS `minor` exactly when `auto_approve` includes
`minor` (`records.ts:summaryBlockingCost`, the D-35 dial read as plain membership): with the dial wide,
a confirmed minor is authorised work, it arms the next round, holds the sign-off and buys the fix pass
like any other blocker; with the dial narrow, the finding stays `confirmed` and NON-blocking — it
neither arms a round nor holds the sign-off, and the Story drains with it sitting on the record.
`taste` is never blocking in phase ①, dial or no dial: the prose it would prefer between does not exist
until phase ③ (R6). This is a consistency rule, not a new gate — the ENGINE's sweep, the Editor's
`confirm_finding`/approval path (`records.ts:findingsToAutoApprove`,
`findingsAwaitingAuthor`, `actionableFindings`) and the STATUS reads (`unconfirmedBlockingFindings`,
`summaryBlockingFindings`, `isBlockingCost`) all go through the same predicate, so one finding cannot be
work on one path and a dead end on another. Later phases keep D-33's all-costs rule.

**A refinement round waits for approved work.** Round 1 samples as soon as the brief and its research
are closed. Round N+1 is armed only when a `fix` task is `open` AND no `critical`/`major` finding is
still `unconfirmed` (`records.ts:samplingArmed`). Its compiled prompt carries the previous round's
selected draft and those tasks, and its own selection consumes them. If the dial does not cover the
confirmed costs, no task exists and the Story waits at `pending`/`finding_approval` until the Author
approves one. A refinement round is additionally held while a Researcher prerequisite is unanswered
(H2/R1, below).

**The hill's budget: retry buys work only while the hill moves (H2).** The retry allowance is no longer
a flat `summary_sampling + 3` burn. `records.ts:samplingProgressOf` derives the wave's state from the
ledger on every read (P11/L-3: the engine keeps no memory, so a restart recomputes exactly this) and
answers four questions: what is the BEST unresolved-blocking count this wave has proved, how many
attempts it spent, how many improvements it proved, and whether the streak has stopped it.

- The FIRST regression-free, readable candidate MEASURES the hill — it sets the baseline and is not
  counted as an improvement, because nothing was beaten. From then on only a STRICTLY LOWER
  unresolved-blocking count is an improvement.
- Each proven improvement EXTENDS the ceiling by one attempt (`samplingCapOf(story) + improvements`,
  where `samplingCapOf` = `summary_sampling + SAMPLING_RETRY_ALLOWANCE`), so a hill that keeps moving is
  never stopped by a static number, and a hill that stopped moving is stopped early.
- `SAMPLING_NO_PROGRESS_STREAK` (3) completed attempts in a row that did NOT lower the baseline — a
  regression counts as no-improvement, because the count it proved belongs to a draft the loop would
  never install — stop the round with ONE Author escalation (`work.ts:samplingExhausted`,
  `SAMPLING_FAILURE_PREFIX`, its detail naming the wave and whether the stop was the streak or the
  ceiling). An attempt that produced no readable candidate at all (a provider failure) neither sets the
  baseline nor extends the streak; those stay bounded by the static cap.
- Only a round with an ACCEPTED base is measured at all: round 1 is producing the sample set the Author
  asked for, not retrying a climb, so it keeps §6.5's cap and its least-bad install (R5).
- The Author's clear of the escalation bumps `stories.sampling_wave` (`engine.ts:rearmSamplingWave`), and
  every number above is scoped to a wave, so a clear is a FRESH baseline with no streak and no spent
  attempts. Nothing re-arms the stop by itself — "no progress" cannot become an endless retry loop, and
  it cannot be silently forgotten by a restart.

**The plateau across reviewed accepted revisions (LEGACY mode only, and SHORTER than it used to be).** The
streak above bounds one ROUND. Its sibling bounds the phase across rounds: after each selection the
accepted revision is deep-reviewed as always, and the review's blocking-finding count is compared against
the best blocking-finding count the wave has EVER seen on an accepted revision
(`records.ts:revisionReviewProgressOf`, partitioned by wave). Three accepted revisions reviewed in a row
that do not beat that best-ever bar stop further sampling for the wave — `samplingArmed` says no, and the
drain's `unmet` list names the plateau so the queue, the arming rule and the Author's screen cannot
disagree (`loop/status.ts:36`). **What the redesign took away (R5): the plateau no longer raises an Author
escalation and no longer bumps the wave.** `openRevisionPlateauTask` and `SAMPLING_PLATEAU_PREFIX` are
gone, and the re-arm sweep that used to answer that row now answers the sampling-FAILURE row alone
(`engine.ts:1969-1971`, `engine.ts:2110-2113`). On a group book the audit itself is skipped
(`engine.ts:2073`), because the per-group attempt cap and the open finding ARE the retry policy there: a
streak that does not improve routes work instead of asking. The stop, in both readings, is a STOP plus
nothing more: the accepted revision the plateau stops on stays the Summary's text, no least-bad draft is
installed, and nothing the rejected attempts failed to certify is closed (R4).

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
6. **Sampling and screening carry attempt budgets, and sampling's is no longer a flat `+ 3`.** The
   sampling ceiling starts at `summary_sampling + SAMPLING_RETRY_ALLOWANCE` (3) and GROWS by one per
   PROVEN improvement in the wave, so a hill that keeps moving is never stopped by a static number
   (`records.ts:samplingProgressOf`/`samplingBudgetSpent`); `SAMPLING_NO_PROGRESS_STREAK` (3)
   consecutive attempts that fail to lower the wave's best unresolved-blocking count stop the round
   EARLY, with the same ONE `escalation` task for the Author (title prefix "Phase ① sampling failed
   after", reused across sweeps, its `detail` recording the wave and whether the stop was the streak or
   the ceiling). Only the attempts that produced NO readable candidate — the provider-failure shape — are
   still bounded by the static cap alone. Clearing the row makes the sweep bump `stories.sampling_wave`
   and re-arm the round under `wi_sample_<summary>_<round>_w<wave>_1` with a FRESH baseline (T12/E: the
   promised recovery is real, and a fresh wave is a fresh baseline — nothing re-arms a no-progress stop
   by itself). A sample whose `summary_readers + 3` screening attempts are spent counts as screened; the
   round selects on the partial reviews and opens ONE `Phase ① screening incomplete in round <n>`
   escalation (T12/C). A round also refuses to select while samples are genuinely still owed: the full
   `summary_sampling` set must exist, or the wave's budget must be spent (T12/D).
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
13. **Selection is gated on an origin-aware ELIGIBILITY set, not on the ranking (H1), and a refined
    round with no eligible candidate installs nothing (R3).** §6.5's ranking is the LAST step: a
    candidate measured against an accepted base must certify every still-open fix task it was handed
    (unanimously, with evidence) and introduce no blocking issue of its own — an unclassified origin
    counts as introduced, fail closed — while a first round still owes zero `critical` and zero `high`
    (`loop/sample-select.ts:scoreSample`; the tie-break is `minimalityOf`'s changed fields then changed
    characters, creation order last). The audit line and the Story projection carry the outcome of EVERY
    attempt — `outcome`, `reject_reason`, `unresolved_fixes`, `introduced_*`/`inherited_*`,
    `changed_fields`/`changed_characters`, and the wave's `wave`/`attempts`/`improvements`/`ceiling`/
    `unresolved_blocking` — precisely because the selection commit deletes the drafts and their screening
    rows (P11/§6.6), and a rejected attempt closed no task and advanced no round. The stop across ROUNDS
    is the cross-revision plateau: three accepted revisions deep-reviewed in a row that do not beat the
    wave's best-ever blocking-finding count stop buying samples for the wave — and since R5 that is ALL
    it does: no Author row, no wave bump (`loop/phase1-plateau.test.ts`), because on a group book the
    per-group attempt cap and the open finding are the retry policy (the within-round sibling of that
    rule is item 6).

The tests that pin all of it: `src/server/loop/phase1-research.test.ts` (the whole loop: gates,
samples, screens, selection, truncation, round 2, sign-off),
`src/server/loop/phase1-lifecycle.test.ts` (the round's STOP and its three stranding bugs: a clean round
settles at "reviewed, ask the Author" with nothing queued, a disarmed round that already sampled still
selects, findings and drafts that belong to a superseded revision stop blocking at the selection that
retires them, and an undecided verification queue caps at four passes and escalates to the Author — driven
by the rig's `crew.verifyReports` knob),
`src/server/loop/phase1-hill-climb.test.ts` (the H1 gates and the retry budget: an uncertified or
regressing draft is refused and closes NOTHING, the improvement-extended ceiling, the
`SAMPLING_NO_PROGRESS_STREAK` stop and the wave re-arm that clears it on a FRESH baseline, and the two
escalation axes), `src/server/loop/phase1-sampling-progress.test.ts` (the wave's progress state derived
from the ledger — attempts, improvements, the best-ever bar, and the fresh baseline a re-armed wave
starts from),
`src/server/loop/phase1-gates.test.ts` (the degradation and retry rules: scrapped revisions take
their screening reviews, screening exhaustion selects partially and escalates, no early selection,
the wave re-arm, R8's negative gate), `src/server/loop/restart.test.ts` (a mid-round restart
re-buys the lost sample under a new key and selects once), `src/server/loop/sample-select.test.ts`
(the eligibility set, both rankings, and the minimality tie-break),
`src/server/api/phase1-view.test.ts` (the sampling projection: `active_round` beside `round`, the
per-candidate audit fields, and a pre-H1 history line normalised to `unresolved_fixes: []`),
`src/server/run/phase1-prompt.test.ts` (the byte-stable hash, the importance filter,
the round-2 sections), `src/server/tools/runtime.test.ts` (the phase-① `raiseFinding` attribution rule
across all four ref shapes), `src/server/integration/summary-sampling.test.ts` (the real server), and
`src/server/llm/structured.test.ts` (the transport fallback and the validator). **That list is the
LEGACY sampling suite**; the group path's tests — `src/server/phrase/*`,
`loop/phase1-groups.test.ts`, `loop/phase1-groups-restart.test.ts`, `api/phrase-routes.test.ts`,
`integration/summary-groups.test.ts`, `tools/checker-group-attribution.test.ts` and the dashboard's
`*.groups.*` / `*.phrases.*` files — are listed under "The Summary Phrase system" near the top of this
file, and `src/server/loop/phase1-plateau.test.ts` is the legacy plateau WITHOUT the deleted Author
question.
