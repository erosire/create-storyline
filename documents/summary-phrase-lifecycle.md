# The Summary Phrase — the life cycle of a revision

**Status:** descriptive, non-normative, and derived from the shipped code on 2026-11-26. It adds no requirement and mints no id: every claim below carries a `src/...:line` citation, and every rule it repeats belongs to `documents/specifications.md`, which this file cites by section (`§4.19`, `§17.4`, `§17.5`, `§17.13`) and by id (`R2`, `R6`, `R12`, `R13`, `D-45`, `D-66`, `D-67`, `D-68`, `D-69`, `D-79`, `L-29`, `S-1`, `P5`). Where this file and that one disagree, that one wins.

**Scope:** exactly one thread, drawn end to end — how a Summary group's text becomes a `group_revisions` row, what positions such a row can hold, what a new row re-arms, and the reported defect: an install whose text is identical to the group's current text still mints a new revision. The defect is documented in §3, at the step where it happens, and it is left as an **open decision** (§3.4), not a requirement.

**Read this first (2026-11-26).** The state words here are verbatim from source and are never synonyms: `latest` / `archived` / `discarded` are the three values of `group_revisions.state` (`src/shared/types.ts:1504`, with the lifecycle prose at `:1483-1503`); `clean` is a flag on a revision row (`src/shared/types.ts:1735,1737`), not a state; `locked` is four fields on the **group** row (`src/shared/types.ts:1649,1656,1658,1660`), not on a revision; and `revision: 0` **is** the "never written" marker (`src/server/api/projections.ts:2021-2022`; the dashboard's predicate at `src/dashboard/components/story-contract.ts:1785`).

**Paths** are relative to `packages/erosire/create-storyline/` — this package is its own git repository (`tsconfig.json:3-5`), so a path beginning `Temp/` is the **outer** monorepo root's scratch directory, not this package's. Diagrams are ASCII fences: the dashboard's own Markdown renderer carries only `remark-gfm` and `remark-breaks` and no `rehype-raw` (`src/dashboard/components/MarkdownText.tsx:31-35,66`), so a Mermaid fence in a document this pane renders would degrade to a literal `<pre>` — there is also no Mermaid precedent anywhere in this repository.

---

## 1. The states, in one picture

The spine is one rule with twelve steps around it: **a `group_revisions` row is created in exactly two places.** Step ⑦, the install, is the only door **the loop** can open; step ②, the Author's legacy import, creates its rows directly (`src/server/phrase/catalog.ts:509-525`). Nothing else mints a row, and step ⑦ has no memory of what the group already said — that absence is §3.

```
   ①  CATALOG MINTED — the `phrases` row + 5 groups   ← `revision === 0` means never written
      five groups at `revision: 0`, `content: ''`     ← no `group_revisions` row exists yet
   ②  LEGACY IMPORT — the other row creator           ← skipped whole when `revision > 0`
      one row: `number: 1`, `latest`, no `run_ref`    ← `catalog.ts:509-525` creates it
        ↓
   ③  IS THE GROUP OWED?  `revision: 0` or a finding  ← minus locked groups, minus cap-parked ones
        ↓
   ④  BATCH CUT + CLAIM  wi_draft_groups_<set>_<n>    ← D-66 keeps one defect in one pass
        ↓
   ⑤  WRITER TURN — one turn, `toolMode: 'none'`      ← byte-stable prompt: an unchanged batch
                                                      ← replays byte-identically (§3.1a)
        ↓
   ⑥  ANSWER PARSED against the JOB's group set       ← the only content test is "not empty"
        ↓
   ⑦  THE INSTALL — the loop's ONLY door to a row     ← one commit: `installGroupRevisions`
        ├─ the previous `latest`  ────────→  `archived`   (retained, hidden, never deleted)
        ├─ a new row at revision + 1 ─────→  `latest`     (text, provenance, `clean: false`)
        ├─ the group row ─────────────────→  `content` · `revision` · `updated_by`
        └─ the phrase row + the mirror ───→  recomposed, `phrases.revision` + 1
        ↓
        NOTHING IN ①-⑦ COMPARES THE INCOMING TEXT (§3)
        ↓
   ⑧  FINDINGS CLOSE on the row's `finding_refs`      ← the tasks follow in the same settle
        ↓
   ⑨  REVIEW AND DEEP SEATS RE-ARM (vector moved)     ← the Reader's SCORE seat keys on the CLEAN
                                                      ← selection, not the vector — see §4.1
        ↓
   ⑩  CLEAN STAMP (D-67) — refused if it moved        ← `clean: true` + `clean_run_ref` stamped
        ├────▷ BACK TO ③ — the vector moved, so the seats are owed again
          … the cycle runs until findings settle, the two-attempt allowance
          is spent (`exclusion.ts:289`), the group is locked (D-69), or L-29 signs off
        ↓
   ⑪  THE AUTHOR ACTS, in parallel with the loop      ← revise one group: a NEW row, old archived
        ├─ lock / unlock a group ─────────→  the group row's four fields; NO revision row
        └─ choose the reviewed Overview (D-68)
             ├─ each group's newest `clean` row → a NEW `latest` at its next number
             └─ every row the choice passed over ─→  `discarded`   (terminal)
        ↓
   ⑫  THE POSITIONS THAT END A LINE
      `archived` and `discarded` never return; the group's own line keeps counting
      a backtrack DELETES the rows · `edit_seed` resets the rows to `revision: 0`
```

The loop's shape is the point, and the drawing carries it: the `├────▷ BACK TO ③` edge out of ⑩ **is** the cycle — the install moved the vector, the review and deep seats are owed again, and the next sweep re-asks ③. A group keeps cycling ③-⑩ until its findings settle, the two-attempt allowance is spent (`src/server/phrase/exclusion.ts:289`), the group is locked (D-69), or the phase is signed off (L-29). Each cycle costs the Author a revision number whether or not the words moved. The Reader's score seat is the one seat that does **not** ride that edge, and §4.1 says why.

### 1.1 Rows and states — one containment view

```
┌─ Story · summary_mode: 'groups' ───────────────────────────────────────────────────────────┐
│                                                                                            │
│  ┌─ phrases · key 'summary' ────────────────────────────┐  the text the Author reads       │
│  │ content            composed, never typed             │  derived from the rows (§4.19)   │
│  │ revision           +1 per install                    │  not per changed group (§17.4)   │
│  │ reviewed_vector · reviewed_vector_hash               │  the choose writes these (D-68)  │
│  │ reviewed_at                                          │                                  │
│  └─────────────────────┬────────────────────────────────┘  one phrase owns five groups     │
│  ┌─────────────────────┴────────────────────────────────┐  … and its four siblings:        │
│  │ phrase_groups · premise                              │  promise, theme, tone, ending    │
│  │ content · revision · updated_by                      │  each on its OWN revision line   │
│  │ locked · locked_revision · locked_by                 │  its OWN lock, its OWN two       │
│  │ no `state` field — deliberate (:1606-1607)           │  attempts (§17.6, D-69)          │
│  └─────────────────────┬────────────────────────────────┘  the state machine lives HERE    │
│  ┌─────────────────────┴────────────────────────────────┐                                  │
│  │ group_revisions · premise                            │  exactly ONE `latest` per group  │
│  │ r7  latest     clean: true   clean_run_ref: run_114  │  the flip is CAS-guarded         │
│  │ r6  archived                                         │  retained, never deleted         │
│  │ r5  discarded                                        │  terminal; hidden from reads     │
│  └──────────────────────────────────────────────────────┘                                  │
│                                                                                            │
├─ the five groups, in composition order ────────────────────────────────────────────────────┤
│ premise → promise → theme → tone → ending   an empty group is SKIPPED, never an            │
│ empty heading, and a key the catalog does not know sorts LAST (R1, §4.19)                  │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

The middle box deliberately has **no** `state` field: "the latest/archived distinction belongs to the revision row (the single source), and a second copy on the group row is a field that can disagree with it" (`src/shared/types.ts:1606-1607`). What the group row carries instead is the *current* text and number (`:1628,1630`) plus its four lock fields (`:1649,1656,1658,1660`), rewritten in the same commit as the revision row that produced them (`src/server/phrase/revisions.ts:545`). The three-state vocabulary lives only on the bottom box (`src/shared/types.ts:1687-1738`).

### 1.2 The transition table

| from → to | trigger | owner |
| --- | --- | --- |
| *(no rows)* → `latest` #1 | story creation leaves the group at `revision: 0` and mints no row at all — the first row appears on the first install, or by the import in the row below (`src/server/phrase/catalog.ts:413-420`) | the loop |
| *(no rows)* → `latest` #1 | the Author presses `POST /stories/:id/phrases/import`; `phrase_legacy_import` (`src/server/api/routes.ts:1119`) writes one row at `number: 1` with `run_ref: null` and `work_item_ref: 'phrase_import'`, and **skips a group already at `revision > 0`** (`src/server/phrase/catalog.ts:503,509-525`) | the Author |
| `latest` n → `latest` n + 1 | `installGroupRevisions` (`src/server/phrase/revisions.ts:412`): the new row is `number: entry.group.revision + 1` (`:523`), `content: entry.content.trim()` (`:524`), `state: 'latest'` (`:525`) — **unconditionally, identical text included** (§3) | the loop, or the Author's revise route |
| `latest` n → `archived` | the same commit, immediately before the create: the row read at `revisions.ts:494` is flipped at `:494-511` under a CAS, so exactly one `latest` survives a concurrent install (R2, §17.4 step 2 — §17.4 numbers the create 1 and the archive 2 (`documents/specifications.md:1581-1582`), while this table and §2.1 follow the commit's order, archive first, so their item 1 is that step 2) | the loop, or the Author |
| `latest` **or** `archived` → `discarded` | the Author's choose (D-68) sweeps every row of the phrase that is not in its chosen set: `reviewed.ts:570-578` installs, `:598-619` sweeps | the Author |
| `discarded` → *(nothing)* | terminal: "nothing installs over a discarded row, and nothing un-discards one" (`src/shared/types.ts:1497-1501`) | — |
| `archived` → *(nothing)* | also never current again; it stays readable as history, and it is what the pane's diff reads (§3.2) | — |
| any → **deleted** | `scrapPhasesAfter` on a backtrack to Summary deletes the rows and clears the locks that named them (`src/server/loop/invalidation.ts:485-491,493-505`); `deleteStory` purges the collection (`src/server/loop/engine.ts:3044-3046`) | the loop, or the Author |
| `clean: false` → `clean: true` | the cross-group review seat closes with no unresolved defect and the vector unmoved — `stampCleanRevisions` (`src/server/phrase/reviewed.ts:354-431`), called from the settle path at `src/server/loop/engine.ts:1812-1822`; it writes no row (D-67) | the loop |
| unlocked → `locked` | the lock seat recommends, the Author (or the Editor behind `editor_group_locking`) signs: `lockPhraseGroup` (`src/server/phrase/locks.ts:249-338`), commit `phrase_group_lock` (`src/server/api/routes.ts:1564`). This is a fact about the **group row**, and it writes no revision (D-69) | the Author |
| `locked` → unlocked | `unlockPhraseGroup` (`src/server/phrase/locks.ts:359-412`) clears the four fields at `:396-400`; commit `phrase_group_unlock` (`src/server/api/routes.ts:1660`) | the Author only |

Two rows are easy to misread. `clean` and `locked` are **not** members of `GROUP_REVISION_STATES`; they are a revision-row flag and a group-row quad, and neither moves a `state`. And the `latest` n → `latest` n+1 row has no "…only if the text differs" clause — §3 is about exactly that missing clause.

---

## 2. What writes a revision: the install commit

One job kind mints rows on a grouped book, and one Author route mirrors it. The stages below are the whole life of a batch, with what each one writes and where.

| stage / job | who | what it writes |
| --- | --- | --- |
| ① `createStory` → `ensurePhraseCatalog` | the engine, in the story-creation commit | the `phrases` row and five `phrase_groups` rows at `revision: 0`, `content: ''` — `src/server/loop/engine.ts:2907-2913` → `src/server/phrase/catalog.ts:359-442`, the row shape at `:413-420`. **No revision row.** |
| ② `importLegacySummary` | the Author, once, by hand | one `group_revisions` row per unwritten group at `number: 1`, `state: 'latest'`, `run_ref: null`, `work_item_ref: 'phrase_import'`, plus the group row and, when it moved the mode, `stories.summary_mode` — `src/server/phrase/catalog.ts:488-569` (`:503` skip, `:509-525` the row, `:547-561` the switch), commit `phrase_legacy_import` at `src/server/api/routes.ts:1119` |
| ③ `groupOwed` / `findingGroupsStillOwed` | the sweep | nothing — a read. Exactly two reasons owe a write (`revision === 0`, or an open/approved finding that group has not resolved), then locked groups and cap-parked groups are removed: `src/server/phrase/exclusion.ts:400-458` (`:452-456`) |
| ④ `phase1GroupCandidates` | the sweep | one `WorkItem` under `wi_draft_groups_<summaryRef>_<group-set hash>_<attempt>`, `templateRef: 'writer-summary-sampler'`, `roleName: 'writer'`, `toolMode: 'none'`, one `GroupDraft` response schema — `src/server/loop/work.ts:1073`, the batch leg at `:1104-1178` (`:1125` the family, `:1150-1151`, `:1172-1173`). D-66's cut (R12) lives in `exclusion.ts:planGroupDraftBatch` (§17.15) |
| ⑤ the Writer's turn | one fresh thread (S-1) | one provider answer. The prompt is compiled byte-stable (`src/server/run/phase1-prompt.ts:1113-1187`) and hashed `sha256(system + "\n\n--phase1--\n\n" + user)[0..16]` (`:18-19,1656-1662` = D-45). No `temperature` (`src/server/run/executor.ts:1006-1007`); `seed` rides only `sampleIndex`, which a group batch never sets (`:1013`); at most two requests (`:1002`, `STRUCTURED_ATTEMPTS = 2` at `:242`); and there is no repo-side response cache, so an unchanged batch reproduces the same bytes |
| ⑥ the answer, validated | the engine, before the commit | nothing yet — a refusal or a plan. `parseGroupDraftAnswer` checks shape, exact ids, no duplicates, nothing missing (`src/server/phrase/revisions.ts:177-250`), called from `src/server/loop/engine.ts:1425`. The one content test is `content === ''` at `:204` |
| ⑦ **the install** | the engine's settle path, commit `loop_job_result` (`src/server/loop/engine.ts:1492,1666-1672`); or the Author's revise route, commit `phrase_group_revise` (`src/server/api/routes.ts:1444`) | **six writes, in this order** (§2.1 — the same six writes, numbered differently in §17.4). The only stage that **creates** a `group_revisions` row, and the only one the loop can open: ② creates rows too, by hand, and ⑩ stamps a row that already exists (`src/server/phrase/reviewed.ts:415-418`) while the choose flips the rows it passed over to `discarded` (`reviewed.ts:610-612`) — neither mints one |
| ⑧ finding closure | the same commit, then every sweep | `fixed` on a finding whose every targeted group now has a revision carrying its id — `closeFindingWhenGroupsResolved` (`src/server/phrase/findings.ts:236-284`), the evidence read at `:144-158` (`groupResolvesFinding`) and `:192-211` (`findingResolution`); the tasks follow at `src/server/loop/engine.ts:1713-1740`; the re-run is `loop_reconcile_findings` (`src/server/loop/engine.ts:617-639`) |
| ⑨ seats re-armed | the next sweep | nothing — two reads of the **vector** hash and one of the **selection** hash: review seats `work.ts:1186-1209` over `exclusion.ts:679`, deep seats over `exclusion.ts:769`, and the score seat `work.ts:1247-1319` over `exclusion.ts:924,935` keyed on `cleanSelectionOf(...).vector_hash` (`work.ts:1268-1271`), which the install does NOT move — so this step re-arms the two Critic families only (§4, §4.1) |
| ⑩ the Clean stamp | the review seat's own settle | `clean: true` + `clean_run_ref` on the row that was current when the seat was claimed (`src/server/phrase/reviewed.ts:415-427`), refused outright when the vector moved mid-pass (`:371-379`). It writes no row (D-67 / R13, §17.16) |
| ⑪ the Author's revise | `POST …/phrases/groups/:groupId/revise` (`src/server/api/routes.ts:1356-1496`) | the same install as ⑦, through the same function; blank text is a 400 (`:1406-1414`), a live Writer on that group is a 409 (`:1426-1436`) |
| ⑪ the Author's choose | `POST …/phrases/reviewed/choose` (`src/server/api/routes.ts:1726`), commit `phrase_reviewed_choose` (`:1797`) | each group's newest **clean** row installed at its **next** number (`src/server/phrase/reviewed.ts:198-202,570-578`), locked groups retained un-installed (`:542-543`), every passed-over row swept to `discarded` (`:598-619`), and the decision recorded on the phrase row (`:623-636`) — D-68, §17.17 |
| ⑫ refusals that keep the model honest | everywhere but here | the whole-Summary revise answers 409 on a grouped book (`src/server/api/routes.ts:2121-2149`), and the crew's `editSummary` is refused the same way (`src/server/tools/writer.ts:153-161`), so the install has no side door (R6) |

### 2.1 The six writes, in the order the commit makes them

`installGroupRevisions` (`src/server/phrase/revisions.ts:412`) does, per group in the batch, in one commit. The order below is the **code's**; `documents/specifications.md` §17.4 lists the **same six writes** with the create as step 1 and the archive as step 2 (spec `:1581-1582`), so "§17.4 step n" and "item n below" are not the same pointer for the first two — steps 3 to 6 line up.

1. archive the row it replaces — read at `:494` **only to compute the number**, flipped at `:494-511` (§17.4's step 2);
2. create the new row: `number: entry.group.revision + 1` (`:523`), `content: entry.content.trim()` (`:524`), `state: 'latest'` (`:525`), plus its provenance — `:513-538` carries `run_ref` (`:526`), `work_item_ref` (`:527`), `task_refs` (`:528-530`), `finding_refs` (`:531-533`), `knowledge_used` (`:534`) and `prompt_hash` (`:535`), and §3.3 shows what each one is load-bearing for (§17.4's step 1);
3. rewrite the group row's `content` / `revision` / `updated_by` (`:544-551`) so "what is the current premise" is one row read;
4. recompose `phrases.content` from the rows **as they now are** and set `revision: phrase.revision + 1` (`:567-582`, the bump at `:578`);
5. rewrite the legacy `summaries` mirror in the same commit (`:593-594` → `syncSummaryMirror`, `:625-666`) — R6;
6. never `world_rules`, and if the Summary row is locked the mirror waits while the install stands (R6, §17.4 step 6).

### 2.2 The guards that exist — and the one that does not

| guard | where | what it refuses |
| --- | --- | --- |
| empty batch | `src/server/phrase/revisions.ts:420-422` | a dispatch with no entries |
| blank content | `:424-427` | an entry whose trimmed text is `''` — "an empty group text is a refusal, not a revision" |
| the group lock | `:436-446` | the **whole batch**, before the first write, if any target is locked (R-lock, D-69) |
| missing phrase row | `:455-461` | a batch whose phrase is absent |
| a chapter entry without both plotpoint fields | `:473-480` | Phrase ② entries written as raw prose |
| an unknown phrase kind | `:481-485` | a batch naming a phrase kind with no sync |
| blank text on the Author's route | `src/server/api/routes.ts:1406-1414` | a hand revise with `content: ''` → 400 |
| a live Writer on the group | `src/server/api/routes.ts:1426-1436` | a hand revise racing a run → 409 (R4) |
| the four lock refusals | `src/server/phrase/locks.ts:259-294` | `group_not_found` — the id is not one of this Story's groups (`:259-265`); `group_unwritten` — `revision === 0` **or** blank `content`, because a lock is a fact ABOUT a revision and locking an empty one "would freeze an empty section into every future Overview" (`:267-276`); `already_locked` (`:278-286`); `editor_locking_disabled` — an Editor on a Story without the `editor_group_locking` dial, absent = disabled (`:288-294`). Those are the whole list: a lock naming a row that is no longer current is NOT refused — `locked_revision` is stamped from the book's current number, not the caller's copy (`:298-302`) |
| an incomplete selection | `src/server/phrase/reviewed.ts:516-524` | a choose whose vector has no pick for some group |
| a vector that moved mid-review | `src/server/phrase/reviewed.ts:371-379` | the Clean stamp, for the whole vector |
| a live Writer hold | `src/server/phrase/exclusion.ts:138,185` | the dispatch, and the Author's route (R4) |
| the two-attempt allowance | `src/server/phrase/exclusion.ts:289,362-373` (the filter at `:456`) | a third pass against the same text (§17.6) |

**What is absent from that table is content equality.** Nothing in ③, ⑤, ⑥ or ⑦ compares the incoming text with `group.content`, or with the `latest` row the install is about to archive.

---

## 3. When nothing changed, nothing changed — the reported defect

The Author's report — *"it shouldn't be a new revision if nothing changes"* — is a description of shipped behaviour, not of a broken invariant. The code says so out loud in the module that refuses to re-date a lock: an install is held to a standard the install itself does not meet — "(an install over an unchanged text still makes a revision row)" (`src/server/phrase/locks.ts:34-35`). A test comment records the same fact from the other side: replaying a dead pass's key "would install the same text twice and move the group's number for an answer nobody read" (`src/server/loop/phase1-groups-restart.test.ts:225-227`).

The mechanism is one line wide: `installGroupRevisions` reads the current `latest` row at `src/server/phrase/revisions.ts:494` **for its number and nothing else** — `latestGroupRevision` feeds the archive flip (`:494-511`) and `number: entry.group.revision + 1` (`:523`) — and never reads its `content`. `content: entry.content.trim()` (`:524`) is written whether or not it is the string the archived row already held.

### 3.1 The three ways to reach it

| # | how the text arrives unchanged | is the behaviour pinned? | citation |
| --- | --- | --- | --- |
| a | **The Writer re-emits the same paragraph.** The GROUPS block shows each group's **current text** and instructs "Where the group already has a current text, REVISE it" (`src/server/run/phase1-prompt.ts:1148-1158`, `GROUP_DRAFT_INSTRUCTION` at `:230-261`, the sentence at `:235`), so an identical answer is a legal answer. With no `seed`, no `temperature` and no response cache, an unchanged batch compiles a byte-identical prompt (`src/server/run/phase1-prompt.ts:1113-1187`; `src/server/run/executor.ts:1002,1006-1007,1013`) — so this is not exotic | **neither way**: no rule and no test | `revisions.ts:200-227` (shape only), `:513-538` |
| b | **The Author's choose,** when a group's newest clean row is already the live text. `cleanSelectionOf` picks the newest non-discarded `clean` row (`src/server/phrase/reviewed.ts:198-202`) and the choose installs it at the next number (`:570-578`) | **by design, pinned** — the reviewed Overview "installs byte-identical prose" (`src/server/phrase/reviewed.test.ts:232`), and the install suite asserts each group's next number (`:529-566`) | `reviewed.ts:198-202,570-578` |
| c | **The Author's hand revise with the same sentence.** The route trims and installs; only *emptiness* is refused (`src/server/api/routes.ts:1406-1414`), never sameness | unpinned: no test asserts either direction | `src/server/api/routes.ts:1389-1415,1444` |

Case (b) is the interesting one: it is the *same* transition as (a) and (c), and it is asserted by name. Any guard against identical text therefore has to say which of the three it means, because (b) is a documented outcome (D-68) and (a)/(c) are the report.

### 3.2 Why it surfaces as "new revision, no diff"

The Author does not see a row count; the Author sees the group pane. Every read on that path is honest, and none of them asks the one question that would notice.

```
   the loop installs a text identical to the group's current text
              ↓
   r6 → `archived`,  r7 → `latest`            src/server/phrase/revisions.ts:494-538
   group row: revision 6 → 7, content SAME    src/server/phrase/revisions.ts:544-551
              ↓
   the projection: `previous_content` = the newest `archived` row,
                   else the newest `discarded`  src/server/api/projections.ts:1909,1922
              ↓                … which IS the text r7 just replaced: the SAME words
   the pane's gate: `previous !== ''`          src/dashboard/components/PhraseEntries.tsx:975,982
              ↓                never `previous !== current`, because emptiness is the flag
   the diff: one `same` run over every word    src/dashboard/components/RevisionDiff.tsx:173-200
              ↓                pinned: `diffRevisions(x, x)` is one unchanged run
   WHAT THE AUTHOR READS
   ──────────────────────────────────────────────────────────────────────────────
   "Current content · diff against Revision 6", and a wall of plain text:
   N words in, N words out, nothing struck red, nothing added  →  "a new revision,
   no diff" — the number moved, so the pane is not lying, and the words did not.
```

Three reads conspire, and each is correct on its own terms. `previous_content` is *the revision immediately before the latest* (`src/server/api/projections.ts:1909-1922`), which is exactly what U3's rule asks for; the pane's caption gate is emptiness, because before the first revision there is nothing to compare against (`src/dashboard/components/PhraseEntries.tsx:973-980`); and the word-level diff is a diff, not a change detector — identical inputs give one `same` run, pinned at `src/dashboard/components/RevisionDiff.test.tsx:62-65`. So the "no diff" is not a rendering bug; it is the true picture of a row that changed nothing but its number.

**Observed, not normative.** The evidence is one live run captured 2026-11-26, kept in the capture **directory** `Temp/general/verify/` in the outer repository — and `Temp/` is git-ignored and disposable at any time, so this paragraph may be pointing at files that no longer exist. The per-pair verdicts are in `live-out.txt`; the **totals** are in `live-README.md:99`: **32 consecutive pairs → 21 byte-identical, 1 fold-equal-only, 10 genuinely different**. The fold-equal pair is Ending r1→r2 (`live-out.txt:903`, filed there as `EQUAL AFTER CASE/PUNCTUATION FOLD`) and it differs by one glyph, `bird’s` against `bird's` — U+2019 → `'` (`live-out.txt:337`, `live-README.md:86`). **And the report is about case (a), and only case (a):** all 21 identical installs carry `commit_label = loop_job_result`, the engine's own settle commit (`src/server/loop/engine.ts:1492`), and none carries `phrase_reviewed_choose` (`src/server/api/routes.ts:1797`) or `phrase_group_revise` (`:1444`) — so every identical install in this capture came down the loop's Writer path, and the capture says nothing about the Author's choose or a hand edit. It also reports the pane's diff empty on four of the five groups. These are measurements of one book, not a claim about every book.

### 3.3 What today's behaviour carries

A guard placed at ⑦ does not only stop a row; it changes four things that read rows. Any decision has to keep these honest (they are the reasons a skip is not a one-line patch).

| what depends on a row existing | how it reads | if the install were skipped |
| --- | --- | --- |
| finding closure (R3) | a finding closes when every targeted group has a revision whose `finding_refs` name it — `src/server/phrase/findings.ts:144-158,192-211,236-284` | the fix landed in prose and the finding stays open forever; a skip needs a substitute witness, which today exists **only** on the revision row |
| the write allowance (R4) | `writeBaselineOf` takes the `latest` row's journal position, so a successful install RESETS that group's two attempts — `src/server/phrase/exclusion.ts:271-277,338-346,362-373` | a group that skipped twice is parked at `GROUP_WRITE_ATTEMPT_CAP` with no fresh pair, i.e. parked forever (`:289,456`) |
| the review and deep seats | both key on the vector hash (`src/server/phrase/revisions.ts:105-137`); "an install moves one number, which re-arms the seats by themselves" | a re-armed seat stays spent: the vector did not move, so no Critic reads the answer that arrived — D-79's asymmetry made sharper (§17.5, §17.12) |
| the Reader's score seat | it keys on the **clean selection's** hash, not the live vector's (`src/server/loop/work.ts:1261-1265,1268-1271`), so an unchanged install does not re-arm it at all (§4.1) | nothing — this seat was already not being re-armed, so it is the one consequence a guard at ⑦ does NOT have to defend |
| provenance (P11) | `run_ref`, `work_item_ref`, `task_refs`, `finding_refs`, `knowledge_used`, `prompt_hash` live **only** on the revision row (`src/shared/types.ts:1705-1718`) | the run that did the work leaves no evidence in the book at all |
| the Digest | derived from the journal, not from a staleness flag (`src/server/digest/digest.ts:105-148`) | nothing breaks; a no-op commit is simply not made |
| the Reviewed choose (D-68) | the install at `src/server/phrase/reviewed.ts:570-578` is what makes a choose leave history | the choose's own precedent is nearby, and narrower than it first reads: on an all-locked book the **install** is synthesized and writes no rows (`:546-569` — `installed: []`, `archived: []`, and the comment at `:548-553` says the choose "still writes the decision record"), but the choose itself still writes the discard sweep (`:598-619`) and the decision record (`:623-636`). "Install succeeded, zero rows" is already a legal outcome; "this choose wrote nothing" is not |

The last row is the strongest existing evidence that a skip is expressible in this model at all: the all-locked choose already returns a successful install with `installed: []`.

### 3.4 Candidate guard points — an **open decision**

No requirement is asserted here. These are the places a guard could live, with what each one would touch; the decision belongs in `documents/specifications.md` §17.4 (the install's six steps) and would carry a new `D-` id minted there, not one invented in this file.

| candidate | where | what it decides | what it endangers |
| --- | --- | --- | --- |
| compare at the archive step | `src/server/phrase/revisions.ts:494` — after `latestGroupRevision`, both texts are in scope, and `GroupInstallResult` already reports per-group `installed` / `archived` / `groups`, so a per-group skip is representable | skips per group, keeping R2's independence: a batch of five whose three texts moved revises three groups | §3.3 in full — finding evidence, the allowance reset, the seat re-arm and the provenance all need a replacement claim |
| refuse in pre-write validation | the loop at `:424-447`, where blank content and the lock already refuse the **whole batch** | an all-or-nothing rule matching the existing atomicity: one unchanged text fails the batch | the Writer batch becomes unfixable by re-answering: a same-text answer would spend the two attempts (`exclusion.ts:362-373`) with nothing installed |
| refuse in the answer parser | `:200-227`, next to `content === ''` | the model is told "REVISE, do not repeat" and pays for it | **a refusal inside `loop_job_result` rolls back the task-attempt writes in the same commit** (`src/server/store/store.ts:973-983`), so the attempts the pass earned would vanish with it |
| guard the Author's route only | `src/server/api/routes.ts:1406-1415` | the smallest, safest answer to the report as filed: a hand revise that changes nothing is a 409, exactly as blank text already is | leaves (a) and (b) standing — the loop still mints the row, which is what the live capture shows |
| treat it as display | no store change; make the pane say "unchanged" when `previous === current` (`src/dashboard/components/PhraseEntries.tsx:973-980`) | answers the complaint where it is seen, and keeps every row of history and every seat key honest | the revision numbers keep counting, and the group's history keeps rows nobody can tell apart |

The honest framing for the Author's decision: the numbers are the group's clock (R2), the Critic seats key on them (§17.5 — and §4.1 for the one seat that does not), and findings are closed by them (R3). Making a no-change install write no row is not a cosmetic fix — it moves three load-bearing reads off that row. That is why this file documents the position and stops there.

---

## 4. What a new revision re-arms

The group vector is the accepted state of a Summary: one `<group id>:<number>` pair per group, sorted, hashed to 16 hex characters (`groupRevisionVector` / `groupVectorHash`, `src/server/phrase/revisions.ts:105-137`). The two **Critic** families key on that hash — the reading seats and the deep passes — which is why an install's effect reaches further than the row: **any install moves the hash.** The source states the other half of the rule about the groups the install did NOT write — "an install moves one number, which re-arms the seats by themselves, and a group whose text did not move leaves the hash alone" (`src/server/phrase/revisions.ts:120-122`) — so the distinction the diagram below draws is: an **untouched** group still contributes the same pair it already contributed and leaves the hash alone, while a group **installed with identical text** has moved its own number (`:523`) and therefore moves the hash like any other install. That second case is §3, and it is why a wasted install still costs a full Critic round. The Reader's score seat is the one seat that does NOT ride that rule, and §4.1 keeps it apart from it.

```
   BEFORE the install   vector { premise: 6, promise: 2, … }   hash A
     review seats  wi_review_groups_<A>_1 … _<critics>      all spent
     deep seats    wi_group_check_<A>_1  … _<critics>       all spent
     score seat    wi_summary_score_<C>  (clean selection)  spent (§4.1)

                          ↓  one install moves ONE number (revisions.ts:523)

   AFTER the install    vector { premise: 7, promise: 2, … }   hash B ≠ A
     review seats  wi_review_groups_<B>_1 … _<critics>      fresh — owed again
     deep seats    wi_group_check_<B>_1  … _<critics>       fresh — owed again
     score seat    wi_summary_score_<C>  (clean selection)  still spent (§4.1)
```

The `<C>` in the score row is deliberate: that seat's key never moves here, and §4.1 says why. The key builders are single points: `groupReviewSeatKey` (`src/server/phrase/exclusion.ts:679`), `groupCheckSeatKey` (`:769`), `sectionScoreClaimKey` (`:924`) with the vector read back off the key at `:935` rather than re-derived at settlement, so a Writer install mid-pass cannot re-stamp an old judgement onto a new book (D-65). The generator legs are `src/server/loop/work.ts:1186-1209` (review, one candidate per key per sweep) and `:1247-1319` (the score seat, keyed the way §4.1 describes). A seat is settled when it ANSWERED or when its family spent its allowance, never merely when a run row closed — D-79 (§17.12).

The one thing that refuses to follow the vector is the Clean stamp: it re-reads the vector and gives up if it moved since the seat was claimed (`src/server/phrase/reviewed.ts:371-379`), because "run X stamped it" is not the claim — the claim is that this text was clean in a clean read of *that* combination (D-67). So an install arriving during a review pass costs that pass its stamp, and the next pass is owed on the new hash.

### 4.1 The Reader's score seat keys on the CLEAN selection, not the vector (D-67)

The gate is `cleanSelectionOf`, and the shipped code states the two consequences inside the very range that arms the seat (`src/server/loop/work.ts:1255-1271`): every group must hold a **Clean** revision before the seat exists at all, and "the hash the seat claims is the CLEAN selection's, not the live vector's" (`:1258-1259`) — the key is built from `cleanSelectionOf(...).vector_hash` at `:1268-1271`. That hash is `groupVectorHash` over the **selected** rows' numbers (`src/server/phrase/reviewed.ts:225`): per group, the newest row that carries the stamp and has no open issue. So the install step ⑦ draws above moves the vector — and does not move this key:

```
   the install mints premise r7, text unchanged: vector A → B (§4)
     review seats  key = vector  A → B           fresh — the Critic re-reads
     deep seats    key = vector  A → B           fresh — the Critic re-reads
     score seat    key = CLEAN selection  C → C  spent — NOT re-armed

   C = groupVectorHash over the NEWEST CLEAN row per group
   (reviewed.ts:225). r7 is not clean, so the selection still says r6.
```

Both readings are the code's own, quoted: "a Writer install whose newest revision still has an unresolved defect does NOT re-arm this seat — nothing reviewable changed, and a score of unreviewed text is the number the Author asked not to be shown" (`work.ts:1261-1263`), and "the seat re-arms the first time the clean selection ADVANCES (a deep pass clears the group, or a later clean revision supersedes an older one), because the key is that selection's hash" (`:1264-1265`). For the defect in §3 that is the one mercy in the picture: a no-change install re-arms the two Critic families and costs the group a revision number, but it never puts a fresh number on the rail.

**The divergence to keep in mind.** `documents/specifications.md` §17.5 still carries the older D-65 wording — "any install moves the hash" (`:1592`) and "the **scoring seat is keyed the same way** (D-65): `wi_summary_score_<vectorHash>` is one pass per vector" (`:1596`). D-67 superseded it: §17.16, "the gate on the score (R13)", states the shipped rule — "its claim key is `wi_summary_score_<cleanVectorHash>` — the SELECTION's hash, not the live vector's" (`:1834`), and calls it "the §17.5 re-arm rule, moved one level up" (`:1837`). So §17.5 is quoted above as history, not as the code's behaviour, and §17.16 is the normative text for this seat.

---

## 5. Terminal and non-terminal positions

| position | lives on | what it means | can it come back? |
| --- | --- | --- | --- |
| `latest` | `group_revisions.state` | the text every read of "current" serves; exactly one per group, CAS-guarded at the flip (`src/server/phrase/revisions.ts:494-511`) | it is the position; the next install moves it to `archived` |
| `archived` | `group_revisions.state` | retained history, hidden from current reads, still readable in the book, and the source of the pane's `previous_content` (`src/server/api/projections.ts:1909-1922`) | no — nothing resurrects it (`src/shared/types.ts:1483-1503`) |
| `discarded` | `group_revisions.state` | a row a choose passed over: persisted, terminal, out of every read of current, selection and rail — and still walked by R3's closure join (`src/shared/types.ts:1493-1501`; `src/server/phrase/reviewed.ts:598-619`) | no — "nothing installs over a discarded row, and nothing un-discards one" |
| `revision: 0` | `phrase_groups.revision` | never written: the group has no rows at all, and it is the one reason a brand-new Story generates work (`src/server/api/projections.ts:2021-2022`; `src/dashboard/components/story-contract.ts:1785`) | it is the start, not a state; the first install replaces it |
| `clean` | `group_revisions.clean` / `.clean_run_ref` | this text was the group's current text in a cross-group read that filed no unresolved defect (D-67). A flag, not a state (`src/shared/types.ts:1735,1737`) | it is set once, on the row that was current when the seat was claimed |
| `locked` | `phrase_groups.locked` + `locked_revision` / `locked_by` / `locked_at` | settled text stops being work: the Author's declaration that this text is law (P5), in its per-group form (D-69) — an install naming a locked group refuses the whole batch (`src/server/phrase/revisions.ts:436-446`), and a locked group's newest row is retained across a choose (`src/server/phrase/reviewed.ts:542-543`) | Author-unlocked (`src/server/phrase/locks.ts:359-412`); the legacy whole-Summary `summary_locked` is a different flag on a different record |

Three ways a line ends without a state change, because the rows themselves go away:

- **backtrack to Summary** — `scrapPhasesAfter` deletes every `group_revisions` row of the Story and clears the locks that named them, because a lock is a fact *about* one of those rows (`src/server/loop/invalidation.ts:485-491,493-505`, D-25/D-69);
- **`edit_seed`** — the group rows are reset in place to `content: ''`, `revision: 0` and no authorship, with the locks lifted, and the history is already gone with the scrap (`src/server/loop/engine.ts:3538-3568`);
- **delete the Story** — `phrases`, `phrase_groups` and `group_revisions` are purged in one commit (`src/server/loop/engine.ts:3044-3046`).

The legacy `Revision` table (`src/shared/types.ts:1048-1092`) plays no part in any of this on a grouped book: the selection pass that would have written it returns early (`src/server/loop/engine.ts:1964-1968`), and the whole-Summary verbs that once drove it answer 409 (R5, §17.9).

---

## 6. Where this lives in code

| Concern | Path |
| --- | --- |
| The three states, and the prose that fixes their meaning | `src/shared/types.ts:1504` (`GROUP_REVISION_STATES`), lifecycle note at `:1483-1503`; the entities `Phrase` (`:1523-1588`), `PhraseGroup` (`:1609-1661`, no `state` at `:1606-1607`), `GroupRevision` (`:1687-1738`) |
| **The install — the loop's only door to a row** | `src/server/phrase/revisions.ts:412` `installGroupRevisions`: guards `:420-447`, the archive read `:494`, the flip `:494-511`, the create `:513-538` (number `:523`, trim `:524`), the group row `:544-551`, the phrase recompose `:567-582`, the mirror `:593-594` → `syncSummaryMirror` `:625-666` |
| The OTHER creator, by hand | `src/server/phrase/catalog.ts:488-569` `importLegacySummary`: the skip at `:503`, the row at `:509-525`, the mode switch at `:547-561` — the only path that mints a `group_revisions` row outside the install |
| The answer validator (the one content test) | `src/server/phrase/revisions.ts:177-250`, empty check at `:204`; called from `src/server/loop/engine.ts:1425` |
| The settle that runs it | `src/server/loop/engine.ts:1492` (`loop_job_result`), install `:1666-1672`, finding closure `:1689-1705`, tasks `:1713-1740`, Clean stamp `:1812-1822`, sweep re-reconcile `:617-639` |
| The vector, and the seats that key on it | `src/server/phrase/revisions.ts:105-137`; `src/server/phrase/exclusion.ts:679,769,924,935`; `src/server/loop/work.ts:1073,1104-1178,1186-1209,1247-1319` — the score seat is the exception: its key is the CLEAN selection's hash (`work.ts:1261-1265,1268-1271`; §4.1) |
| What is owed, and what is capped | `src/server/phrase/exclusion.ts:400-458` (the two reasons), `:289,338-346,362-373` (the allowance and its reset), `:138,185` (the live hold), `:1002` (`groupPipelineOwed`) |
| R3's closure evidence | `src/server/phrase/findings.ts:144-158,192-211,236-284,299,383` |
| Clean stamp, reviewed Overview, choose | `src/server/phrase/reviewed.ts:354-431` (stamp), `:173-202` (the pick), `:510-665` (the choose: retained locks `:542-543`, all-locked zero-row install `:546-569`, install `:570-578`, discard sweep `:598-619`, decision record `:623-636`) |
| Locks | `src/server/phrase/locks.ts:249-338` (lock, refusals at `:259-294`), `:359-412` (unlock, the four-field clear at `:396-400`); the module header at `:34-35` is the sentence about an unchanged install |
| The Author's verbs | `src/server/api/routes.ts:1119` (import), `:1356-1496` (revise, 400 at `:1406-1414`, 409 at `:1426-1436`), `:1564`/`:1660` (lock/unlock), `:1726,1797` (choose), `:2121-2149` (the legacy revise refusal) |
| The reads that draw the pane | `src/server/api/projections.ts:1909,1922` (`previous_content`), `:2021-2022` (unwritten/written); `src/dashboard/components/PhraseEntries.tsx:973-996`; `src/dashboard/components/RevisionDiff.tsx:173-200` |
| Purge, reset, backtrack | `src/server/loop/invalidation.ts:485-491,493-505`; `src/server/loop/engine.ts:3044-3046,3538-3568`; `src/server/digest/digest.ts:105-148` |
| The prompt, and why it is reproducible | `src/server/run/phase1-prompt.ts:18-19,230-261,1113-1187,1656-1662`; `src/server/run/executor.ts:242,1002,1006-1013` |

---

## How this is verified

This file documents behaviour; it is not itself tested. The commands below are the ones that pin every transition drawn above — run from the **outer** repository root, since the paths name this package (root `AGENTS.md` keeps the whole monorepo on `vite`, `vite-node` and `vitest`, never `node`, never `tsx`):

```bash
# the install itself: the six writes, the guards in §2.2, and R2's per-group independence
yarn vitest run packages/erosire/create-storyline/src/server/phrase/revisions.test.ts
# the catalog's first rows (`revision: 0`, `content: ''`) and the idempotent legacy import
yarn vitest run packages/erosire/create-storyline/src/server/phrase/catalog.test.ts
# what is owed, the live hold, D-66's cut, and the two-attempt allowance (§3.3)
yarn vitest run packages/erosire/create-storyline/src/server/phrase/exclusion.test.ts
# R3's closure evidence — the read a skipped install would strand (§3.3)
yarn vitest run packages/erosire/create-storyline/src/server/phrase/findings.test.ts
# D-67's stamp and D-68's choose, including the byte-identical prose case (b) in §3.1
yarn vitest run packages/erosire/create-storyline/src/server/phrase/reviewed.test.ts
# D-69's lock, and the §2.2 refusal that lands before the first write
yarn vitest run packages/erosire/create-storyline/src/server/phrase/locks.test.ts
yarn vitest run packages/erosire/create-storyline/src/server/api/phrase-routes.test.ts
yarn vitest run packages/erosire/create-storyline/src/server/api/phrase-lock-routes.test.ts
# the replay that must NOT double-install — the §3 comment a guard has to keep true
yarn vitest run packages/erosire/create-storyline/src/server/loop/phase1-groups.test.ts
yarn vitest run packages/erosire/create-storyline/src/server/loop/phase1-groups-restart.test.ts
yarn vitest run packages/erosire/create-storyline/src/server/loop/group-seed-reset.test.ts
# the score seat's key: gated on the CLEAN selection, and NOT re-armed by an install (§4.1)
yarn vitest run packages/erosire/create-storyline/src/server/loop/section-scores.test.ts
# D-79's seat parity — the re-arm in §4 that a skipped install would not buy
yarn vitest run packages/erosire/create-storyline/src/server/loop/phase1-review-retry.test.ts
yarn vitest run packages/erosire/create-storyline/src/server/loop/phase1-deep-review-retry.test.ts
# the diff that says "no change" in §3.2, pinned for identical inputs
yarn vitest run packages/erosire/create-storyline/src/dashboard/components/RevisionDiff.test.tsx
# end to end: the §17.7 examples on one book
yarn vitest run packages/erosire/create-storyline/src/server/integration/summary-groups.test.ts
# scratch probes go in the OUTER root's Temp/ — never `node`, never `tsx`
yarn vite-node Temp/coding/<probe>.ts
```

**What none of these tests pin** — and this is the honest gap behind §3.4: not one test asserts what happens when an installed text is identical to the group's current text, in either direction. Case (b) in §3.1 is pinned as an outcome of a choose; cases (a) and (c) are simply unobserved by the suite. Before a guard is written, a test for each of the three cases has to be written first, or the guard will be chosen by whichever reading of this file was read last.
