# CreateStoryline — Product & System Specification

**Status:** normative draft. This document is the build contract. Requirement ids (`P1`, `D-3`, `T-1`, `L-4`, …) are stable: assign work by id, cite ids in commit messages and tests.

**Audience:** a swarm of agents building the Server and the Dashboard in parallel. Each workstream (§12) is independently buildable against the interfaces in §5–§9. Where a section says MUST, a build that omits it is wrong; where it says SHOULD, it is expected but a reasoned deviation is acceptable if recorded in §14.

---

## 1. Product thesis

An **Author** sits at the top of a story stack and wants many stories moving at once. They write the thing only they can write — the **Seed**, the intention of the story, and later the **lock** on each phase — and then the system does the hundreds of small, tedious, consistency-preserving jobs that make a story hold together, forever, until the Author says stop.

The system is a **loop engine**. It constantly scans every Story for unfinished work, and for each piece of work it **spawns a fresh harness** (a fresh agent crew with fresh context), hands it the story id and one job, and tears it down when it reports. The Author's screen is a queue of decisions, not a chat box.

**Rapid** is the product goal. Rapid means:

- **R1** — the Author never faces a blank page. Agents draft; the Author signs.
- **R2** — a decision costs the Author one interaction (pick, approve, reject, one line of direction).
- **R3** — work happens in parallel across stories and across chapters.
- **R4** — nothing waits on the Author that does not need to.

**Authorship is preserved.** The Author is the only terminal authority: the loop ends when the Author stops it, a chapter is done when the Author says it is done, the Seed is untouchable by agents, and so is the Summary once the Author has locked it. Speed that costs the Author their book is not speed.

**The target is fidelity, not quality.** The objective is *a story this Author would have written by hand* — not the best possible story, which is subjective and unachievable on purpose. Every template is a piece of the Author's own judgment, automated: what they like in prose, what they notice, what they would fix. A system that produces a technically better book that isn't theirs has failed. This is a requirement, not a philosophy (§5.3).

**The product is three phases, each ending in a lock.** Idea → **Summary** → **Plotlines** → **Chapters**. Each phase is a crew working until its Goal passes, then stopping for the Author's signature; the signature locks the artifact, and the next phase builds only on locked ground. The loop does not run endlessly by design: it runs *to* a sign-off, not *until* it gives up (§6.3a, §6.6).

**There is no deadline.** Runs may take days. Nothing in this product is gated on tokens or wall-clock (§11). The only failure the loop recognises is **going in circles**, and its response is to stop and tell the Author, not to give up.

---

## 2. Principles

These are load-bearing. Every later section derives from them.

**P1 — The Dashboard owns memory. Harnesses are stateless workers.**
Every turn runs in a brand-new harness instance with no history. Therefore **the only memory in the system is the Dashboard's durable store.** An agent that cannot write a fact into the store has not produced it. A harness that dies mid-run loses nothing except its own uncommitted output.

**P2 — Fresh context every turn.**
A turn MUST never reuse a previous run's session. This is the anti-context-rot mechanism: reviewers are independent because they have never seen the last review. It also means every turn pays a full re-read, which is why the **Digest** (§4.8) is mandatory rather than an optimisation.

**P3 — A story is its records.**
Nothing that is not in the store is part of the story: not a chat message, not an agent's reasoning, not a run's stdout. Prose lives in `chapters`. Structure lives in `plotlines`. Judgment lives in `verdicts` and `findings`. Direction lives in `tasks`.

**P4 — Every unit carries a contract, and the loop asks one question.**
A chapter carries a **Plotline**: what must happen in that chapter. The loop's question is never "is this good?" but **"does this artifact deliver its contract?"** — answerable by a fresh reviewer with a cited line of evidence.

**P5 — The idea is sacred; the Summary becomes sacred at the lock.**
The Author's **idea** is the seed and is read-only for every agent, forever. The **Summary** is Phase 1's *output*: the Writer expands the idea, Readers feed it alternatives researched from outside, the Editor checks that the result is logically sound, and the Author selects what to keep and **locks** it. Once locked, the Summary is the fixed point the whole loop measures against and no agent touches it again — the only way in is the Author unlocking, which backtracks (§6.3a). Before the lock the Summary is a draft like any other; after it, it is law.

**P6 — Pass/fail criteria, not scores.**
A fresh context grading 1–10 is noise. A boolean with a citation is stable. The Author controls the goal by editing a list of criteria and a threshold, never by dragging a quality slider.

**P7 — Escalate, never silently halt.**
When a loop cannot proceed — no progress, a contradiction only a human can resolve — it parks a **question for the Author**. It does not stop and go quiet, and it does not spin.

**P8 — The Author can always pull the cord.**
A Stop on a Story or a global Stop halts dispatch immediately and kills in-flight runs. A stopped Story never auto-resumes.

**P9 — Agents propose against Author prose.**
An agent never silently overwrites text the Author wrote. It files a proposal. (See §7 permissions.) This is the one respect in which the Writer's monopoly (P10) is limited: the Author's own words outrank the Writer's.
**P9a — The Author writes prose too, in the UI, and only while the Story is paused.**
The chapter editor is not a read-only view: the Author edits the book with their own hands. To keep that from colliding with a crew mid-sentence, the edit requires the Story to be `stopped` (D-37). The pause is the lock; the resume is the hand-back.

**P10 — The Writer writes everything.**
One template is the **Writer**, and the Writer is the only thing that writes story artifacts: the Summary, the plotlines, chapters, prose, cast, ledger. (The **Digest** is the one exception, and the only one: it is not part of the book, it is a derived index of it, and the engine builds it from commits — D-12a.) Every other crew — **Editor**, **Reader**, or **checker** — reads, judges, files findings, opens tasks, proposes Ideas, and requests the Author; none of them writes a story artifact. A checker that thinks it can improve a sentence files the task and lets the Writer write it. This is what keeps a hundred independent fresh reviewers from producing a hundred different prose styles: one voice, many auditors.

**P11 — Every change is attributable.**
Every mutation records who made it and carries a one-line `why`. The Author must be able to see, for any paragraph, which run changed it and for what reason — and undo it.

**P12 — Templates are the Author, not best practice.**
A Writer, Editor, or Reader template encodes *this Author's* taste and *this Author's* habits — the prose they like, the things they look out for, the calls they would make. A template is not a generic expert; it is the Author's own editorial judgment, externalised and automated. Built-in templates are starting points to be edited into the Author's likeness, never authorities to be deferred to.

**P13 — Revisions are ephemeral; one survives.**
Multiple attempts at the same chapter or plotline exist **at the same time**, side by side, and are compared by an Editor. When the Editor selects one — or merges several — **every non-selected revision is deleted.** Losing the alternatives is deliberate: a pile of rejected drafts is exactly the context rot that P2 exists to prevent, and a fresh run that reads four versions of chapter 7 has already lost the thread. The chosen text is the only thing that persists; the reasoning for the choice persists as a record, not as the drafts.

**P14 — A Story has a status, and the loop is allowed to say "I'm stuck."**
A Story is `ready` (agents may work on it), `pending` (the loop has stopped dispatching and the Author is the next mover), or `completed` (the Author has accepted the book as it stands, leftovers and all). `pending` has flavours and they are not the same news: **awaiting the Author** — a phase passed its bar, Ideas need picking, findings need approving, or the Story is **drained** and the crew has run out of work it is authorised to do — and **stalled**, the only flavour that means trouble: the loop stopped converging and hit a wall. Both are normal; neither is an error (§6.6, L-34, L-37, L-37a). A loop that quietly spins for three days on a contradiction only a human can see is worse than one that stops after an hour and asks.

**P15 — This is a build contract for the first build, not a constitution.**
The engine is expected to change. The design is settled enough to build (§15) and deliberately not settled enough to be final: the Author's own position is *"we build it out, test it in building, and then revise the engine."* Two consequences for the build: the loop, the store, and the tool surface are built so that a phase model, a role set, or a criterion can be **replaced without rewriting the store**, and anything the spec marks as deferred (recipes, sequel access, §14) stays a **named hole** rather than being quietly designed in. A section that survives contact with a real book unchanged is the surprise, not the norm.

---

## 3. Glossary

|Term|Meaning|
|---|---|
|**Story**|One work of fiction the Author is building. The unit of the loop. Identified by `storyId`.|
|**Seed**|The Author's own idea for a Story, in their words, held in `stories.idea`. Written once by the Author, read-only for every agent forever. The contract Phase 1 is measured against.|
|**Summary**|Phase 1's artifact: premise, promise, theme, tone, ending, expanded by the Writer from the Seed and locked by the Author. Once locked it is the contract everything downstream is measured against.|
|**Idea**|A proposal contributed by a Reader (or the Author) at the current phase: a claim, a possibility, a "what if", with its sources. The Editor verifies it; the Author selects it or discards it.|
|**Phase**|One of the three stages: `summary`, `plotlines`, `chapters`. A Story is in exactly one at a time.|
|**Lock**|The Author's signature ending a phase and freezing its artifact for all agents. Only an Author **backtrack** unlocks it.|
|**Backtrack**|The Author's decision to reopen an earlier phase. Everything later phases produced is scrapped, hard, and the reopened phase starts fresh.|
|**Plotline**|The per-chapter contract: what must happen, what must change, what must be set up or paid off.|
|**Chapter**|The prose for one Plotline. Has a `state` in the pipeline.|
|**Cast**|Characters, each with want / need / arc / voice.|
|**Ledger**|The continuity facts: setups and their payoffs, timeline, world rules, named facts.|
|**Digest**|The compressed standing view of a Story (§4.8) that lets a fresh reviewer judge one chapter without re-reading the book. **Derived by the loop engine from committed changes — no agent writes it** (D-12a).|
|**Pause & edit**|The Author's way of writing prose themselves: stop the Story, edit the book in the UI, resume. The pause prevents the race; the resume re-derives the Digest and re-checks dependents. (P9a, D-37, D-37a, U-17)|
|**Prequel access**|Deferred, not built: giving a sequel's phase ① crews read access to the finished previous book. The only planned exception to single-Story scoping. (D-39, §13)|
|**Goal**|The Author-owned criteria list + threshold that defines "consistent enough".|
|**Criterion**|One pass/fail check with a checker kind (`code` or `judge`) and a `hard`/`soft` flag.|
|**Finding**|A named defect against a specific artifact, with evidence and a fingerprint. From a Reader or checker it starts `unconfirmed` and is worth nothing until an Editor confirms it (D-33).|
|**Verdict**|One run's pass/fail report against a set of criteria.|
|**Task**|Work the loop or the Author has queued toward the Goal.|
|**Work Item**|A claimable unit of dispatch: one job, one story, one role. Spawns one run.|
|**Run**|One ephemeral harness instance, alive for exactly one Work Item, scoped to exactly one `storyId`.|
|**Harness Template**|A reusable crew definition: roles and their kind (Writer / Editor / Reader / checker), prompts, which phase it serves, its done-definition, its `selection_rules`, how many attempts it spawns.|
|**Recipe**|A named sequence of stages + templates + done-definitions.|
|**Directive**|A line of Author direction that the loop must propagate through the story.|
|**Writer**|The template with write access to story artifacts. It writes the Summary, the plotlines, the chapters, and the prose.|
|**Editor**|The template that **chooses**: it compares competing revisions of the same unit and selects one or merges several, by the Author's stated rules. It then deletes the losers (P13).|
|**Reader**|A crew that reads as the Author reads and is allowed to *propose*. In phase ③ it is a **judge of effect**: does this chapter diverge from its plotline, does this reference hold up, is this mystery spent too early — and it says so. In phases ① and ② it contributes **Ideas**, researched from outside the store where it needs to be. Every Reader output is a suspicion until an Editor confirms it (D-33).|
|**Researcher**|Not a fourth crew: a Reader role on a template. Every role holds the whole tool catalogue (T-6a); what makes a Reader a Reader is its **instructions** — read the story, rate it, propose, look things up (D-30).|
|**Checker**|Any crew that reads and judges, files findings/tasks/verdicts, and never writes a story artifact.|
|**Revision**|One competing attempt at the same unit — a Summary, a plotline, or a chapter — held side by side until an Editor selects or merges (P13).|
|**Status**|A Story's dispatch state: `ready`, `pending`, `completed`, `stopped`. Distinct from `phase`, which is where it is in the pipeline. `pending` is qualified by `pending_kind`, and only `stalled` means anything went wrong.|
|**Drained**|The state in which the crew has run out of work it is *authorised* to do: no task, no unconfirmed finding, no competing revision, and a fresh round of Readers found nothing at or above the dial threshold. The loop stops dispatching and the Author has two moves — work the leftovers, or complete. It is not completion and it is not a fault. (L-37, L-37a)|
|**The dial**|`stories.auto_approve` — which finding costs flow to a Writer without asking the Author. The same setting is the **drain threshold**: it decides what still counts as work, and so when the crew stops. (D-35, D-35b, L-37)|

---

## 4. Data model

The store is the Dashboard's, not the harness's. Collections below are normative in name and field; a build MAY add fields, MUST NOT rename or drop one.

### 4.1 `stories`

|field|type|notes|
|---|---|---|
|`title`|text, required|Author-set.|
|`phase`|enum|one of the three phases: `summary`, `plotlines`, `chapters`. There is no other value; `completed` is a `status`, not a phase.|
|`idea`|text, required|**Author-written.** The seed. Read-only for every agent, at every phase, forever (P5). If the Author changes it, the Story starts again from scratch (D-25a).|
|`summary_locked`|boolean|true = Phase 1 signed off; `summaries` is read-only for every agent. Author-set only.|
|`plotlines_locked`|boolean|true = Phase 2 signed off; `plotlines` are propose-only for every agent. Author-set only.|
|`pending_kind`|enum|`phase_signoff`, `idea_selection`, `finding_approval`, `drained`, `stalled`, `none`. **The first four are the loop waiting for the Author by design**, not a fault (§6.6). `drained` is the one that means "we are out of authorised work" (L-37); `stalled` is the only one that means trouble.|
|`status`|enum|whether agents may work on it: `ready`, `pending`, `completed`, `stopped`. **The sweep dispatches only `ready` Stories.** `stopped` has two causes and they are the same mechanism: the Author pulled the cord (P8), or the Author **paused it to edit the prose themselves** (D-37).|
|`status_reason`|text|why it is `pending` — the criterion that will not move, the contradiction found, the level it fell to, or (when `drained`) what the crew stopped finding and what is left awaiting the Author. Rendered on the Pending review screen (U-1a, U-1c).|
|`consistency`|text|the measured levels as a sentence: `idea→summary 4/4 · summary→plotlines 6/6 · plotlines→chapters 4/6`.|
|`trend`|enum|`improving`, `flat`, `regressing`, `unknown`. Drives the `pending` transition (§6.8).|
|`goal_ref`|text|id of the `goals` record this Story measures against.|
|`auto_approve`|strings|which finding costs skip the Author's approval gate — a subset of `critical` / `major` / `minor` / `taste`. Defaults to `critical, major` (D-35). Author-set.|
|`author_stop`|boolean|true = no dispatch, no auto-resume. Set by the Author only; distinct from `status: pending`, which the loop sets and the Author clears.|
|`progress`|text|one-line human summary the loop maintains ("7 chapters · act 2 has a hole · 3 setups unpaid").|
|`blocked_on`|text|what it is waiting for, or empty. The tree renders this.|
|`digest_rev`|integer|revision of the current Digest.|

**D-1** A Story's `phase`, `status`, `pending_kind`, and the two lock flags are owned by the loop engine and the Author, never by an agent tool. An agent has no tool that locks, unlocks, or backtracks.
**D-2** The Dashboard MUST support any number of Stories in any phase, simultaneously, and dispatch work across all of them.
**D-2a** `status` transitions, and who owns them:

|from → to|trigger|owner|
|---|---|---|
|`ready → pending`|the consistency trend is `flat` or `regressing` (§6.8)|loop|
|`pending → ready`|the Author reviews and clears it, or issues a directive|Author|
|`* → stopped`|the Author presses Stop|Author|
|`stopped → ready`|the Author presses Resume|Author|
|`ready → completed`|Phase 3 is signed off: every hard criterion passes at every level and the crew concurs (§6.9)|loop proposes, Author confirms|
|`completed → ready`|the Author edits anything, or a `needs_recheck` lands|either|
|`ready → pending` (`phase_signoff`)|a phase's Goal passes and its artifact awaits the Author's lock (§6.3a)|loop|
|`pending → ready` (`phase_signoff`)|the Author locks the phase, or declines and lets the crew keep working|Author|
|`ready → pending` (`idea_selection`)|Readers have filed Ideas that need the Author's pick before the phase can advance|loop|
|`ready → pending` (`finding_approval`)|the only remaining blockers to the phase's Goal are `confirmed` findings the Story's switch does not auto-approve (L-36)|loop|
|`ready → pending` (`drained`)|a full pass leaves no task, no unconfirmed finding, no competing revision, and one fresh round of Readers produced nothing at or above the dial threshold (L-37)|loop|
|`pending` (`drained`) `→ ready`|the Author approves any leftover finding, or issues a directive — either re-opens work|Author|
|`ready` (unchanged)|some findings await approval but other work is still possible (L-36)|loop — **no pause**|
|`* → earlier phase`|the Author **backtracks**: the later phases' artifacts are scrapped and the reopened phase starts fresh (D-25)|Author, alone|

**D-2b** A `pending` Story MUST NOT receive new work, but its records stay fully readable and the Author can inspect every verdict and finding that led there. `pending` is a pause, not a failure.

### 4.2 `summaries` — one record per Story; Phase 1's artifact

|field|type|notes|
|---|---|---|
|`story_id`|text, required||
|`chapter_count`|integer, required|**Author-declared.** How many chapters this Story has. With the prose fields below, this is the Story's source of truth.|
|`premise`|text|what the story is about.|
|`promise`|text|the promise made to the reader; the ending must pay this.|
|`theme`|text||
|`tone`|text|voice, POV, tense, register.|
|`ending`|text|known or intended.|
|`world_rules`|text||
|`locked`|boolean|mirrors `stories.summary_locked` (L-7a). true = even the assistant cannot propose an edit without an Author backtrack.|

**D-3** While `phase = summary` and `summary_locked` is false, `summaries` is writable by the **Writer** — expanding the Seed is Phase 1's whole job. It is also writable by the Author at any time, and by an **assistant run the Author explicitly invoked on the Summary field only**. Once `summary_locked` is true, every agent write is refused with a message naming P5, and the only way to change it is an Author backtrack (D-25).
**D-3b** Two things are source of truth, and they are different. `stories.idea` is **Author truth**: immutable to every agent at every phase, never proposed, never inferred, never drifted. `summaries.chapter_count` is **Author truth too**: declared by the Author, never chosen by the Writer, and a hard fact — Phase 2 produces exactly that many plotlines and a deviation is a failing criterion (C-0), not a creative choice. The Summary's *prose* is the **Phase 1 artifact**: it is negotiated until the lock and law after it.
**D-3d** The Summary draft goes through the same divergence-and-selection machinery as a chapter (§6.2a): N Writer expansions of the Seed, checkers, an Editor applying `selection_rules`, losers deleted (D-22). The Seed is short; the thing the whole book hangs off is not a place to accept the first draft.
**D-3c** A change to `chapter_count` after the plotlines lock MUST reopen Phase 2 by backtrack (D-25): added chapters enter the queue as `outlined`, removed chapters are deleted with their prose held for the Author's decision, and every dependent chapter is marked `needs_recheck`.
**D-4** The locked Summary is the root contract. Every Plotline MUST be traceable to it; the loop's first consistency check is Plotline-vs-Summary, before any chapter exists. Above the Summary sits the Seed, which the Summary itself must be traceable to (C-14) — the chain is `idea → summary → plotlines → chapters`, and every artifact names the one above it.
**D-5** Changing an **unlocked** Summary MUST mark every dependent Plotline and Chapter `needs_recheck` (§6.5). A *locked* Summary cannot be changed by an agent at all; the Author changes it by backtracking, which scraps the dependents rather than rechecking them (L-11, D-25).

### 4.3 `plotlines` — one per chapter, the chapter's contract

|field|type|notes|
|---|---|---|
|`story_id`|text, required||
|`chapter_ref`|text|the chapter this plotline governs.|
|`order`|integer, sortable|chapter sequence.|
|`heading`|text||
|`must_happen`|text|the events that must occur.|
|`must_change`|text|what must be different by the end — state, knowledge, relationship, position.|
|`pov`|text||
|`setups`|text|planted here.|
|`payoffs`|text|collected here.|
|`contract_locked`|boolean|mirrors `stories.plotlines_locked` (L-7). A locked plotline is read-only for agents; they propose.|
|`aligned`|boolean|last verdict's result against the Summary.|
|`needs_recheck`|boolean|set by invalidation (§6.5).|

**D-6** Plotlines are agent-writable until `contract_locked`, then propose-only. The Author locking the plotlines is the gate from phase `plotlines` to phase `chapters` (§6.3, L-7).

### 4.4 `chapters`

|field|type|notes|
|---|---|---|
|`story_id`|text, required||
|`plotline_ref`|text||
|`order`|integer, sortable||
|`title`|text, required||
|`summary`|text|short synopsis.|
|`content`|text|the prose.|
|`state`|enum|`outlined`, `drafting`, `in_pass`, `in_review`, `needs_author`, `done`, `needs_recheck`|
|`current_revision`|text|the revision an Editor selected; the only one that survives (P13). Empty while revisions are competing.|
|`author_locked`|boolean|true = agents propose only, never rewrite.|
|`bar_override`|text|per-chapter goal override: a criterion id to drop, or a threshold delta. Author-only.|
|`round`|integer|passes run on this chapter.|
|`last_score`|text|`n/m criteria passed`, rendered not scored.|

**D-7** `content` MUST be section-addressable: a long chapter is stored as ordered sections so a reviewer can change one paragraph without rewriting the chapter. A whole-chapter rewrite MUST be an explicit, separate operation from a section edit.
**D-8** Every write to `content` records `author_ref`, `run_ref`, and `why` (P10).

### 4.5 `cast`

`story_id`, `name`, `want`, `need`, `arc`, `voice`, `state_now`, `traits`, `gender`. **D-9** A character's `state_now` is a tracked fact: a reviewer checks behaviour against `arc` + `state_now`, not against vibes.

### 4.6 `ledger`

`story_id`, `kind` (`setup`, `payoff`, `fact`, `timeline`, `world_rule`), `subject`, `detail`, `chapter_ref`, `status` (`open`, `paid`, `conflict`, `stale`), `fingerprint`.

**D-10** Ledger checks are `code`-checked wherever the check is mechanical (a `setup` with no matching `payoff`; a `timeline` entry out of order; a `fact` contradiction on a shared key). Mechanical continuity MUST NOT be delegated to an LLM's judgment.

### 4.7 `tasks`

`story_id`, `kind`, `title`, `detail`, `owner_role`, `state` (`open`, `claimed`, `blocked`, `done`, `wontfix`), `priority`, `criterion_ref`, `finding_ref`, `attempts`.

**D-11** Tasks are the loop's work queue and are agent-writable: a reviewer that finds a defect files the task that fixes it. This is how the goal is reachable "regardless of number of turns" — the queue, not the transcript, holds the plan.

### 4.8 `digests` — one current record per Story, plus history

`story_id`, `rev`, `body` (bible recap + per-chapter one-line summary + open threads + cast state + last change notes), `stale`.

**D-12** The Digest is rebuilt or patched on every commit that changes story state.
**D-12a** **The Digest is derived, not authored.** The **loop engine** rebuilds it deterministically from the committed change history — never a crew, never the Writer (P10 excepted here deliberately). The reason is that the Digest is the one artifact every fresh run trusts without checking: if the same agent that wrote chapter 9 also summarised it, a wrong chapter 9 becomes a wrong bible and the error is invisible downstream forever. So: the engine composes it from commits and the records they touched; a crew may only file `digest_gap` (D-13) to say the derivation is insufficient; and because it is a pure function of committed history, **any past Digest is reconstructible** — the Author can see what a reviewer was actually told at the time it judged chapter 20. Its `rev` advances with the commits it summarises, and it carries no `why` because no one chose it.
**D-13** A run's brief is: `Digest + the artifact under review + the criteria`. A run MUST NOT be required to read the whole book; if the Digest is insufficient for a judgment, the run files a `digest_gap` finding and the loop repairs the Digest.
**D-14** A stale Digest blocks a review, not a fix. The loop refreshes then re-dispatches.

### 4.9 `verdicts`

`story_id`, `target_ref`, `target_kind`, `run_ref`, `template_ref`, `round`, `criteria_passed` (list of `{criterion, result, evidence, finding_ref}`), `hard_pass`, `soft_count`, `recommendation` (`advance`, `fix`, `stuck` — stuck means the checker believes the Story should go `pending`).

**D-15** A verdict with no `evidence` string on a failing criterion is invalid and MUST be rejected by the tool.

### 4.10 `findings`

`story_id`, `target_ref`, `criterion_ref`, `title`, `detail`, `evidence`, `cost` (`critical`, `major`, `minor`, `taste`), `fingerprint`, `state` (`unconfirmed`, `confirmed`, `approved`, `fixed`, `disputed`, `discarded`), `confirmed_by` (an Editor run, or empty), `approved_by` (the Author, or `auto` — D-35), `seen_count`.

**Open** means any of `unconfirmed`, `confirmed`, `approved` that is not yet `fixed` — the shorthand used throughout §6 and §10.

**D-33** A finding raised by a **Reader or checker** starts `unconfirmed`: it is a suspicion, and suspicions are wrong often enough to be worth checking before they cost a Writer a pass. An **Editor** verifies it against the artifact and either confirms it — which makes it eligible for a task and for the loop's progress accounting — or disputes it. A `critical` finding may open a task immediately, but it still needs the Editor's confirmation before it may *invalidate* anything or move the Story toward `pending`.
**D-34** **Nothing reaches the Writer without the Author's approval.** The chain is fixed: a Reader or checker **raises** (with a cost), an **Editor verifies and rewrites** the finding into something the Author can read in one pass — the claim, the evidence line, the cost it actually deserves, not the reviewer's raw prose — and the **Author approves** it, which is what creates the task. An unapproved finding generates no Writer work, however confident the reviewer sounded. This is the gate the Author asked for, and it is why the loop can run continuously without running ahead of them.
**D-35** Because the Author "will almost certainly approve" the serious ones, the Story carries an **auto-approve switch**: a per-cost dial (`critical`, `major`, `minor`, `taste`) listing which costs skip the approval wait and go straight to a task. It defaults to **on for `critical` and `major`, off for `minor` and `taste`**, and it lives beside Stop on the Story view. With it on, phase ③ runs unattended (L-35); with it off, the Author is the throttle and the loop waits for them finding by finding. Turning it off is how the Author takes the wheel without stopping the crew.
**D-35b** The dial does a second job, and this is why it is the most important control on the Story view: **it sets the drain threshold** (L-37). A cost the dial covers is a cost the loop will keep working on until none are left; a cost it does not cover is one the loop will raise, verify, and then set down in front of the Author and stop working on. So the dial answers both "what may start without asking me?" and **"how finished is finished?"** — widen it and the crew polishes further before it calls the book done; narrow it and the loop stops earlier and hands the leftovers over. One knob, one meaning: how much of this book the Author wants automated.
**D-34a** **The Editor's triage is final.** It decides what is `critical`, what is `minor`, and what is `disputed`, and there is no appeal step and no second reviewer above it. This is not an oversight: the Editor exists precisely so the Author is not swarmed by things a fresh reviewer said with confidence and meant loosely. The Author's control is upstream — the template's instructions and `selection_rules` (P12) — and downstream — approving, discarding, and completing (D-34, L-26). An Editor that files the wrong things is a template the Author edits (G-7), not a decision the Author re-makes forty times a day. The reviewer's original `title`, `detail`, and `cost` stay on the record (P11) so the call can be audited afterwards, but nothing in the UI forces that comparison and nothing in the loop waits for one.

**D-16** `fingerprint` = stable hash of (criterion, target, normalised subject). A repeat report increments `seen_count` on the existing finding rather than creating a new one. This is what makes "no progress" detectable in a system where every reviewer is amnesiac (§6.7).

### 4.11 `goals`

`story_id` (or empty = a reusable preset), `title`, `threshold_soft` (integer N), `criteria` (see §5), `flat_rounds`, `regress_tolerance`.

**G-5** There is no token field, no minute field, and no round cap on a Goal. Nothing about a Goal can *stop* a loop. `flat_rounds` and `regress_tolerance` are **loop-detection** parameters only: they decide when a Story that has stopped converging becomes `pending` for the Author (§6.8). A loop that is still improving never stops, however long it takes — and what does stop one is a sign-off, an approval wait, or **drained** (E-0a), none of which is a field on the Goal.

### 4.12 `templates` — the harness catalogue

`name`, `title`, `description`, `roles` (list of `{name, kind: 'writer' | 'editor' | 'reader' | 'checker', prompt, model?, web?, agents?, aggregate?}`), `serves_phase`, `done_definition`, `selection_rules`, `attempts`, `delegation`, `escalation_rule`, `next_phase`, `max_concurrent`, `builtin`, `editable`.

**D-38** **A template is a harness, not an agent.** It declares roles, and a role may declare `agents: N` — N fresh agents of that kind running inside one run, whose outputs the role **aggregates** to a single answer (`aggregate`: `majority` | `merge` | `lead`). A single Editor template may therefore contain three editor agents reading the same three drafts and return one selection. The aggregation is **internal to the run**: the loop still receives exactly one report, one `selection_note`, one verdict set, and one permission-bearing answer (S-1, D-17e). This is how "one Editor or a panel?" is answered without a vote anywhere in the loop — the panel lives inside the harness, so the Author's taste is still applied **once per decision**, and D-34a (the Editor's call is final) stays true. What a run MUST surface when its internals disagreed: the `selection_note` or the finding's `detail` names the dissent and the split ("2 of 3 judged this `critical`; confirmed at `major`"), because a hidden disagreement inside an authoritative answer is the one thing the Author cannot tune.
**D-38a** **The Author chooses how many of each kind exist.** Templates are the unit the Author spawns, and there is no fixed count of Writers, Editors, or Readers in the design — `max_concurrent` and `attempts` are the Author's settings, not engine constants. The one structural rule is per-unit, not per-Story: a unit with more than one `competing` revision waits for a selection (D-23). Assigning a second Writer *template* to a Story is legal and means two voices; the loop then reports style divergence between them as an ordinary `taste` finding rather than treating it as an error — the Author asked for it.

**D-17a** `roles[].kind` selects **the brief and the permission row**, never the tool list (T-0, T-6a): `writer` may write story artifacts, `editor` may select, merge, and verify, `reader` may propose Ideas and rate, `checker` may report. All four see all tools. A kind with no instructions is the actual failure mode: an agent holding `editChapter` and no rule about it will use it.
**D-17b** Write permission comes **only from a template assigned to the Story as a Writer** — no other kind may write a story artifact, however capable its tools. How many Writer templates are assigned is the Author's choice (D-38a): one is the default and the simplest case for P10's single voice, two is legal and means two voices, and `serves_phase` is how a structural Writer for ① and ② coexists with a prose Writer for ③. `editor` templates hold the selection and verification permissions and may write **only** through selection, merge, and confirmation (D-33). Duplicating the Writer is how the Author gets more than one writing voice available.
**D-17c** `selection_rules` is the Editor's brief in the Author's own words: what it prefers, what it weighs, what it refuses, and how it merges. It is the mechanism by which P12 becomes executable — an Editor with no `selection_rules` is guessing at the Author's taste.
**D-17d** `attempts` is how many parallel revisions the loop spawns for one unit (1, 3, 5…). With no cost constraint it defaults to **more than one**, because divergence is the whole advantage of a fresh-harness architecture.
**D-17e** `delegation` names the roles this template may delegate to *inside its own run* (`@underload/harness` subagent delegation). A single Editor run may therefore fan out to its own fresh sub-contexts to reach a conclusion before it commits to one revision. Delegation stays inside one run and one Story: it does not create a Work Item, and the delegating run remains the one that reports.
**D-17** The Author MUST be able to create a template from scratch and **duplicate an existing one**, then edit roles, prompts, `agents` and `aggregate` (D-38), `selection_rules`, `attempts`, and done-definition. Built-ins are duplicated, never edited in place.

### 4.13 `runs`

`story_id`, `work_item_ref`, `template_ref`, `role`, `session_ref`, `state` (`spawning`, `working`, `reporting`, `torn_down`, `failed`, `abandoned`), `started_at`, `ended_at`, `tokens`, `brief_hash`.

**D-18** `runs` is the live crew panel's data source. A run row exists from spawn to teardown so the Author can watch the crew and pull the cord on a specific one.

### 4.14 `directives`

`story_id`, `text`, `state` (`queued`, `propagating`, `done`, `rejected`), `impact` (the list of plotlines/chapters/ledger entries the loop determined it must touch).

**D-19** A directive is not a chat message. It is a decision the loop must propagate: it generates tasks, marks dependents `needs_recheck`, and reports back what it changed.

### 4.15 `revisions` — competing attempts at one unit

`story_id`, `unit_kind` (`summary` | `plotline` | `chapter`), `unit_ref`, `body`, `run_ref`, `template_ref`, `brief_hash`, `state` (`competing`, `selected`, `merged_into`, `discarded`), `verdict_refs`, `selection_note`.

**D-21** Revisions of one unit are visible **side by side** to an Editor and to the Author, and to nobody else: a Writer's brief names the unit and its contract, never its sibling drafts (P2, P13).
**D-22** When an Editor selects or merges, the server MUST delete every non-selected revision of that unit in the same commit. Deletion is hard, not a flag — a discarded draft that lingers is context rot with a badge on it. The `selection_note` and the verdicts survive; the prose does not.
**D-23** A unit with more than one `competing` revision is not eligible for the next phase. The gate is the Editor's selection, not the passage of time or a verdict count.
**D-24** The Author may always override an Editor: select a loser, restore a discarded revision from the run's own output, or write the unit by hand. The Editor's choice is the Author's choice, automated — not a verdict above the Author.
**D-25** **Backtrack is the only way a locked phase opens, and it is Author-only.** Backing up to phase N unlocks phase N and **deletes everything later phases produced** — the prose and the structure, hard, by the same rule that deletes a losing revision (D-22). The reopened phase starts from the locked artifact above it with no memory of the scrapped pass; the verdicts, findings, and `selection_note`s of that pass survive as provenance (P11) — the Ideas do not, because the lock that closed that phase already deleted them (D-36). The alternative — keeping chapters written against a plotline the Author has since rejected — is P2's context rot at book scale, and it is why the phases lock at all. One consequence worth naming: a phase that was locked has already thrown away its Ideas (D-36), so a backtrack reopens it with an **empty tray**, and the Readers may well propose again what the Author rejected last time. That is the price of a store that stays small, and the Author pays it once per backtrack rather than every run.
**D-25a** **Editing the Seed is a backtrack to phase ①, in full.** The Author's idea is the root of the whole chain (D-4), so changing it invalidates everything grown from it: the Summary, every plotline, every chapter, and every digest go the same way D-25 sends the artifacts of a scrapped phase. There is no partial version of this and no "recheck" — a new idea is a new book wearing the same title. The confirmation names that plainly, because it is the most destructive action in the product. **Spinning a sibling Story from the same idea is a manual copy, not a feature**: the Author copies the Seed text into a new Story. The product does not fork Stories, keep divergent lineages, or offer an "duplicate with history" option — one Story row, one book, and the Seed is plain text that is trivial to copy.

### 4.17 `ideas` — what Readers and the Author put forward, before anything is written

**Phase-scoped and temporary.** An Idea lives only inside the phase that raised it. Locking a phase deletes that phase's Ideas — selected, discarded, deferred alike (D-36). What persists is the artifact they produced, not the argument that produced it.

`story_id`, `phase`, `unit_ref` (empty = whole-Story), `body`, `kind` (`direction` | `possibility` | `fact` | `warning`), `author` (a Reader role or the Author), `sources` (list of `{url_or_title, claim, accessed_at}`), `fingerprint`, `seen_count`, `state` (`proposed` | `verified` | `refuted` | `unverifiable` | `selected` | `discarded` | `deferred`), `verification` (`{verdict, evidence, meets_guidelines, checked_by_run, checked_at}`), `selection_note`, `absorbed_into` (the artifact that took it, once written).

**D-31** The Editor checks every Idea against the **Author's guidelines** — the Goal criteria, the `tone` sheet, `world_rules`, and its own `selection_rules` — and records `meets_guidelines` alongside the fact-check. An Idea can be true and still unwanted; both answers are the Editor's job (D-27).

**D-26** An Idea is a **proposal, never an edit**. A Reader may not change a Summary sentence, a plotline, or a chapter; it files an Idea and the Writer is the only thing that later writes what the Author selected (P10).
**D-27** An Idea carrying `sources` MUST be verified by an **Editor before it can be selected** (C-15). A Reader's web result is a lead, not a fact: the Editor re-reads the source, or finds a second one, and records `verdict` with evidence. The Author selects among *verified* Ideas first and sees unverified ones marked as such.
**D-28** Ideas are cheap and expected to be wrong: `attempts` on a Reader role controls how many run per unit, and a phase with zero Ideas filed is reported as a **thin crew**, not a clean one. **Within its phase, a discarded Idea is never deleted** — unlike a losing revision (D-22), because a discarded draft is a dead alternative while a discarded Idea is a *decision*. The Editor and the Author both need to remember it, or the next fresh Reader proposes it again and the loop argues the same point forever. **Across a phase boundary it is deleted** (D-36): the decision did its work, the artifact carries it, and the argument is not context the next phase needs.
**D-32** Discarded and deferred Ideas are **the memory that prevents the loop** (P14) — and they are exactly as long-lived as the loop they prevent, which is one phase. Every Reader and Editor brief carries the phase's decided Ideas — `selected`, `discarded`, `deferred`, with their `selection_note`s — so an amnesiac crew cannot re-litigate a settled question. A new Idea whose `fingerprint` matches a decided one MUST be reported to the Author as a **repeat** with the earlier decision attached, not silently re-opened; a Reader that keeps re-proposing what the Author has rejected three times is a template the Author edits (G-7).
**D-36** **Locking a phase deletes that phase's Ideas.** The lock is the moment the argument becomes an artifact, so the tray is emptied in the same commit: `selected` Ideas have already been absorbed (D-29), and `discarded`, `deferred`, `refuted`, and `unverifiable` ones are deleted outright. The phase's `verdicts`, `findings`, and `selection_note`s survive as provenance (P11) — the Author must still be able to ask "why this Summary?" — but the pile of maybes does not cross into the next phase. This is what keeps a long Story's brief from filling with decisions nobody can act on any more, and it is why the memory in D-32 is scoped to a phase rather than to a Story.
**D-29** The Author's selection of an Idea is a **recorded decision**, not a chat message (P3): `state: selected` plus `selection_note`, and the Writer's brief for the next run names the selected Ideas it must absorb.

### 4.16 `proposals`

`story_id`, `target_ref`, `target_field`, `patch`, `why`, `run_ref`, `state` (`pending`, `accepted`, `rejected`). **D-20** Every P9 propose-only edit lands here, never in the target field.
**D-20a** This collection is the **agent→Author** direction only. The Author's own edit of chapter prose is a direct write, not a proposal — there is no one to approve it (D-37). An Author edit is attributed like any other mutation (P11, `run_ref` null, `author: true`) and is undoable.

---

## 5. The Goal

### 5.1 Shape

A Goal is an ordered list of **criteria**, each:

```ts
type Criterion = {
  id: string
  label: string                 // shown to the Author, plain language
  question: string              // the exact question a reviewer answers
  checker: 'code' | 'judge'     // mechanical vs. LLM
  hard: boolean                 // hard = must pass; soft = counts toward threshold
  fix_hint: string              // the smallest change that would satisfy it
}
```

A Story passes when **all hard criteria pass** and **soft passes ≥ `threshold_soft`**.

### 5.2 The built-in criteria

|#|criterion|checker|hard|
|---|---|---|---|
|C-0|the Story has exactly `chapter_count` plotlines and chapters — no more, no fewer|code|yes|
|C-1|every chapter has a plotline|code|yes|
|C-2|every plotline traces to the Summary — nothing in it contradicts premise, promise, theme, or ending|judge|yes|
|C-3|every plotline's `must_change` is actually a change, not a restatement|judge|no|
|C-4|plotlines are consistent with each other: no contradiction between adjacent chapters, no event requiring a setup that no earlier chapter makes|judge|yes|
|C-5|every `setup` in the ledger has a `payoff`, and every `payoff` has a setup|code|yes|
|C-6|timeline is monotonic; no `fact` contradiction|code|yes|
|C-7|expanded prose delivers its chapter's `must_happen`|judge|yes|
|C-8|expanded prose delivers its chapter's `must_change`|judge|yes|
|C-9|no character acts against `arc` + `state_now` without a scene that owns the change|judge|no|
|C-10|the ending pays the `promise`|judge|yes|
|C-11|no two consecutive chapters do the same job (pacing)|judge|no|
|C-12|prose quality at the level the `tone` sheet demands|judge|no|
|C-13|the prose reads as though this Author wrote it — matches the `tone` sheet and the Editor templates' `selection_rules`|judge|yes|
|C-14|the Summary delivers the Seed: nothing central to `stories.idea` is missing from it, and nothing in it contradicts the Seed|judge|yes|
|C-15|every Idea that reached a locked artifact was verified by an Editor and carries evidence|code|yes|

The criteria group into **one level per phase boundary, plus a whole-Story level**, and the loop reports them separately because they fail for different reasons:

|level|phase|criteria|question|
|---|---|---|---|
|**Seed → Summary**|1|C-14, C-15|does the Summary deliver the idea the Author actually had?|
|**Summary → Plotlines**|2|C-0, C-1, C-2, C-3, C-4, C-5, C-6|do the plotlines serve the story the Author declared, in the count the Author declared?|
|**Plotlines → Chapters**|3|C-7, C-8, C-9|does each chapter deliver the contract written for it?|
|**Whole Story**|3|C-10, C-11, C-13|does the book pay its promise, hold its pace, and sound like the Author?|

The first level is the one the Author did not name and Phase 1 requires: if the Summary quietly drifts from the Seed, every later level can pass while the book is wrong. C-12 sits outside the levels as a per-chapter quality check.

**G-1** The Author MUST be able to toggle a criterion's `hard` flag, delete one, add one, and change `threshold_soft`, per Story and per chapter.
**G-2** The loop MUST report progress as `"13 of 16 · failing: C-4, C-5, C-11"`, **per phase**, and MUST NOT show a phase's criteria as failing before that phase is reached with each failure naming its `fix_hint`. A bare percentage is a defect.
**G-3** `code` criteria MUST be evaluated by the server without a model call, and MUST be re-evaluated automatically after every commit.
**G-3a** C-13 is the criterion the whole product is measured by, and it is the one no built-in can get right: it asks whether the prose reads as the Author's own. Its evidence is the templates' `selection_rules` and the Summary's `tone` sheet, and the Author is expected to tune it until it stops failing on prose they like. A system that passes C-13 on everything is too loose; one that fails it on everything is too tight.

### 5.3 Fidelity, not quality

**G-6** No criterion may ask "is this good?" Every criterion is answerable against a stored artifact: the Summary, a plotline, the ledger, a template's `selection_rules`. A criterion whose evidence would be taste rather than citation is a build defect.
**G-7** Where a crew's judgment and the Author's stated preference conflict, **the Author's preference wins, including when it is worse.** A template that keeps filing findings the Author keeps rejecting is a template the Author edits — the loop must surface that pattern (repeated `discarded` findings against the same criterion, D-34) rather than keep arguing.
**G-8** The Goal is never "the best story". It is "consistent at every level, and written like mine".

### 5.4 The Goal is the shared target

**G-4** Every template's brief carries the same Goal. Crews do not each hold their own quality theory. The Goal is the one thing that makes many independent fresh reviewers produce a coherent result.

---

## 6. The loop

### 6.1 The scan

**L-0** The sweep dispatches **only Stories whose `status` is `ready`** (D-2a). A `pending`, `completed`, or `stopped` Story is scanned for reporting but receives no work.
**L-1** The server runs a continuous **sweep** over all Stories. Each sweep:

1. re-evaluates all `code` criteria for every Story;
2. collects open `tasks`, `needs_recheck` markers, **`unconfirmed` findings awaiting an Editor** (D-33), and **`confirmed` findings awaiting the Author's approval** (D-34) — an unverified suspicion is work, and so is an unapproved one. A `confirmed` finding on a Story whose `auto_approve` covers its cost is approved by the sweep itself, on the spot, as `approved_by: auto` (D-35);
3. checks the phase preconditions: is the current phase's Goal passed, is the Story **drained** (L-37), or are the only remaining blockers things only the Author can move? if so, mark `pending` (`phase_signoff` / `idea_selection` / `finding_approval` / `drained`) and **skip dispatch for that Story entirely** (L-29, D-29, L-36);
4. otherwise determines, per Story, the next eligible **Work Item** for the Story's current `phase` — a phase may not be entered unless every earlier phase is locked (L-33);
5. dispatches Work Items to templates that have spare `max_concurrent` capacity, across all Stories, until global concurrency is full;
6. recomputes each Story's `consistency` levels and `trend`, and moves a Story to `pending` (`stalled`) if it has stopped converging (§6.8) — **but only after checking `drained`, which is tested first and wins** (L-37a): a Story that has run out of authorised work is finished-by-standard, not stuck.

**L-2** The sweep MUST be idempotent and MUST use a **claim with lease**: a Work Item claimed by a run cannot be claimed again until the lease expires or the run reports. Two sweeps must never spawn two crews for one job.
**L-3** The sweep MUST survive a restart with no lost state, because all loop state is in the store (P1). On boot it re-adopts or abandons runs whose lease has expired.

### 6.2 The three loops

**Loop S — Summary pass** (phase `summary`). Objective: a Summary that delivers the Seed and is internally logical (C-14, C-15). Whole-Story; it runs until its Goal passes, then stops for the lock (L-29). The **Writer** expands the Seed into the Summary; **Readers** file Ideas — including ones researched from outside the store — and the **Editor verifies those Ideas independently** before the Author may select them; checkers judge the draft; an **Editor** chooses between competing Summary expansions (D-3d).

**Loop A — Plotline pass** (phase `plotlines`). Objective: every Plotline aligned with the locked Summary and with each other, and exactly `chapter_count` of them (C-0…C-6). Whole-Story, cross-chapter. The **Writer** produces the plotlines by sampling the Summary across `chapter_count` units; Readers propose plotline changes; checkers judge; an **Editor** enforces consistency and chooses between competing plotline drafts; the Author approves.

**Loop B — Chapter pass** (phase `chapters`). Objective: every chapter's prose delivers the plotline bound to it and violates nothing global (C-7…C-9, and C-10/C-11/C-13 at whole-Story level). All chapters in flight at once (L-8), running constantly. This is the **most automated phase in the product**: the Author may watch, stop, or steer, and none of those is required for it to finish (L-35).

The shape of a chapter pass, every sweep:

```
Reader / checker → "this diverges from the plotline", "this reference doesn't hold up",
                   "this spends the mystery too early"        → finding (unconfirmed)
        ↓
Editor → verify against the artifact: confirm or dispute      → finding (open | disputed)
        ↓  confirmed
Writer → fixes it (or an Editor selects between competing drafts)
        ↓
server → commit, propagate to dependent chapters (L-8a), rebuild digest
        ↓
next sweep — the Author watched, or didn't
```

**L-35** Phase ③ is the automated phase, and **the auto-approve switch is what makes it so** (D-35). With `critical` and `major` auto-approved, the chain Reader → Editor → task → Writer runs with the Author watching but touching nothing, and the phase completes on its own. With the switch off, the loop **does** wait on the Author finding by finding — that is the point of turning it off, and it is a throttle, not a stall (D-34). Either way the phase never waits on a *sign-off*: phase ③ ends when it **drains** (L-37), and the Story ends when the Author accepts it (L-26). The Author may stop or steer at any moment and is always honoured (L-10, P8).

**L-4a** Each loop MUST stop at its own sign-off (L-29). Loop S does not "keep improving the Summary" after the Goal passes: it presents, waits, and hands the phase to the Author.

**L-4** The three loops MUST have separate templates and separate done-definitions.
**L-5** Loop S and Loop A MUST NOT run while any chapter is mid-`in_pass`, and vice versa, unless the Author forces it (and neither may run at all while an earlier phase is unlocked — L-33). Two loops editing the same artifact concurrently is a defect.

### 6.2a Divergence and selection

The loop does not produce one draft and then critique it. It produces **several, independently, and then chooses** — this is the shape the architecture exists to enable.

```
Writer run ×N (fresh sessions, same brief, same contract, no sight of each other)
        ↓  N competing revisions (§4.15)
Checker runs ×M (fresh, read-only) → verdicts + findings per revision
        ↓
Editor run (fresh; may delegate to its own sub-contexts, D-17e)
        ↓  applies the Author's `selection_rules`
select one · merge several · or reject all and re-brief the Writer
        ↓
server deletes every non-selected revision in the same commit (D-22)
        ↓
next sweep
```

**L-16** The N Writer runs for one unit MUST be spawned together and MUST NOT see each other's output (P2). Divergence that knows it is being compared diverges differently.
**L-17** An Editor's decision MUST record a `selection_note` naming the rule it applied and what it preferred in each draft, so the Author can see the taste at work and edit the template when the taste is wrong (P12, G-7).
**L-18** "Reject all and re-brief the Writer" is a first-class outcome, not a failure. An Editor that cannot find a winner is reporting that the brief or the contract is wrong, and that is a finding worth filing.
**L-19** Merging is a Writer operation: an Editor selects the parts and **the Writer writes the merge**, because the Writer owns the prose (P10). An Editor may merge structure; it may not compose sentences.
**L-20** A unit with `attempts > 1` is not eligible for the next phase until an Editor has selected (D-23). The loop may not resolve divergence by picking the first one that passes.

### 6.3 The gates between phases

**L-6a** Phase 2 is not complete until the Writer has produced exactly `chapter_count` plotlines (C-0). The Writer does not choose the count, and no checker may file a finding that implies a different one — the count is Author truth (D-3b).
**L-6** Each phase transition requires an **explicit Author sign-off**, not merely "the loop reported pass": `summary → plotlines` needs the Summary locked, `plotlines → chapters` needs the plotlines locked. Agents may reach 16/16 and still be waiting on the Author. This is deliberate: expanding an 80%-agreed outline makes every downstream chapter loop burn rounds rediscovering an ambiguity the Author could have settled in one sentence.
**L-7** The Author signs Phase 2 by locking the plotlines: `stories.plotlines_locked` becomes true and every `plotlines[].contract_locked` mirrors it in the same commit. One action on the Dashboard.
**L-7a** The Author signs Phase 1 by locking the Summary: `stories.summary_locked` becomes true. The Author cannot lock a phase while Ideas are still `proposed` — each must be `selected`, `discarded`, or `deferred` first (D-29), because a locked artifact with unjudged alternatives still in the tray is a decision the machine made by silence. Locking then deletes the tray (D-36).

### 6.3a Locks, sign-off, and backtracking

This is the rhythm the Author described, and it is what stops the loop from running endlessly: **work runs to a signature, not until it gives up.**

```
phase N:  crew works (divergence → verdicts → selection → Ideas verified → Author picks Ideas)
             ↓  phase Goal passes
          status: pending · pending_kind: phase_signoff      ← the loop STOPS here
             ↓
          Author reads, edits by hand if they like, selects the Ideas they want
             ↓  LOCK
          phase N+1 opens; phase N's artifact is read-only for every agent
             ↓
          ... later, mid phase 3 ...
             ↓
          Author backtracks to phase 2 → every chapter is scrapped (D-25), phase 2 is unlocked and fresh
```

**L-29** When a phase's Goal passes, the loop MUST set `status: pending` with `pending_kind: phase_signoff` and stop dispatching that Story. A phase that keeps improving its artifact past the passing bar is a defect: the artifact is good enough by the Author's own criteria, and only the Author can say what "better" means here (P6).
**L-30** A locked artifact MUST be read-only for every agent, enforced by the **server** at the call (T-1a), not by a prompt and not by hiding the tool. A Writer that tries to `editChapter` against a locked plotline is refused with the lock named.
**D-37** **The Author edits prose in the UI, and only from a paused Story.** The chapter editor is a real editor — the Author types into the book. It is enabled **only while `status: stopped`**, and the UI action that opens it is one button: **Pause & edit**, which stops dispatch, kills in-flight runs (P8), and then unlocks the prose. An edit attempted against a running Story is refused by the server naming D-37, exactly like any other permission failure (T-1a). The reason is not politeness toward the crew: a Writer's `expects` compare-and-swap (T-4) makes a lost race *detectable*, not *resolved* — the Author would keep losing writes to a machine that retries instantly, and a paragraph half-replaced by each side is the corruption that pausing exists to prevent. Pausing is cheap here because the loop is built to be interrupted and resumed at any point with nothing in memory (L-0, L-3, P8).
**D-37a** **Resume is the hand-back, and it is a commit like any other.** Resuming re-arms the Story to `ready` (subject to the ordinary `pending` checks, L-1) and the Author's edit is processed as a committed change: the Digest is re-derived from it (D-12a), dependents are marked `needs_recheck` by the normal propagation rules (L-11a), and the edited span is marked **Author-written**, so from that point agents may only propose against it (P9, D-20) rather than overwrite it. The loop does not treat the edit as a defect and does not try to restore what it replaced; the next review simply judges the book as it now reads. A directive (D-19) is the Author's way of saying *why*, so the crew propagates the change instead of merely re-judging it.
**D-37b** **Pausing is not a mode the Story enters permanently.** Nothing about a paused Story is special on resume: there is no "author-edited" flag on the Story, no reduced trust in later runs, and no re-approval gate. The crew picks the book up where it stands, which is the same thing that happens after an edit made while the Story was already stopped for another reason (P8, U-12).
**L-31** **Backtrack is Author-only** and is the single way a lock opens (D-25). Backtracking to phase N MUST: unlock phase N, **delete every artifact of every later phase** — chapters and their revisions when backing up to `plotlines`; plotlines, chapters, digests, and per-chapter verdicts when backing up to `summary` — and reset `phase` to N with no memory of the scrapped pass. The `verdicts`, `findings`, and `selection_notes` of the scrapped work survive as provenance (P11); the **prose, the structure, and the Ideas do not** — a phase that was locked already deleted its tray (D-36), and a phase that was never locked loses it with the rest.
**L-32** Backtracking is not undo and MUST NOT be offered as "revert to an earlier draft". It is a phase decision with a confirmation naming exactly what will be deleted, because the alternative — carrying chapters forward that were written against a plotline the Author has since rejected — is the context rot of P2 at book scale.
**L-33** A phase MUST NOT be entered unless every earlier phase is locked. There is no "drafting chapters while the plotlines are still moving": the phase boundary is a hard precondition checked by the sweep, not a convention.

### 6.4 Chapter sequence

**L-8** After the plotlines lock, **all chapters are worked on together by default** — the whole chapter set is in flight at once, not one at a time. Sequential expansion is an option the Author may choose for a short Story, not the default.
**L-8a** Because chapters run together, **consistency is a cross-chapter problem and is handled automatically**: a defect found in chapter 12 that touches something chapter 1 asserts marks chapter 1 `needs_recheck` in the same commit, and the sweep dispatches a Writer to fix whichever side the plotline says is wrong. A Story whose chapters are only ever checked against its own past is a Story that discovers its contradictions at the end (C-4, C-6).
**L-9** The Story MUST carry a declared dependency set (which chapters depend on which) — not to *sequence* the work, which is what it was for before, but to say **which chapters a change must propagate to**. A chapter with no declared dependency is a chapter nobody will notice has moved.
**L-10** A chapter reaches `done` when its Goal passes **and** the Author accepts, or when the Author marks it done outright ("good enough"). The Author's word outranks the criteria in both directions.
**L-10a** Divergence and selection run concurrently for every chapter, not one chapter at a time (C-B). The unit of concurrency is the chapter; the unit of correctness is the whole chapter set.

### 6.5 Invalidation

**L-11** Within a phase, any commit that changes a Story-level artifact (a world rule, chapter order, an unlocked Summary) MUST mark every dependent plotline and chapter `needs_recheck`, and MUST reopen any chapter already `done` that the change touches. **A change to a *locked* artifact is not a commit — it is a backtrack** (L-31): the Author unlocks, the later phases are scrapped, and nothing is "rechecked" because there is nothing left to recheck.
**L-11a** Propagation runs **both directions in time**: a contradiction between chapter 1 and chapter 12 marks *both* `needs_recheck`, and the loop fixes the side the plotline says is wrong. "Fix the later one and hope the earlier one still reads" is not a rule, it is a hope (L-8a).
**L-12** A `needs_recheck` chapter is re-entered into Loop B automatically (and a `needs_recheck` Summary draft into Loop S, while phase ① is still unlocked). Without this, already-approved chapters rot silently — the exact failure P2 exists to prevent, relocated.

### 6.6 What ends work

There is **no round limit, no token limit, and no time limit** on a loop. A Story may be worked on for days. What ends work, in order of how normal it is:

1. **A phase sign-off** (`pending_kind: phase_signoff`) — the loop reached the bar the Author set and stopped. This is the designed stop, and it happens three times per Story (L-29).
2. **A decision from the Author** (`pending_kind: idea_selection` or `finding_approval`) — Readers have put alternatives on the table, or the Editor has confirmed findings the Story's switch does not auto-approve, and the phase cannot advance until the Author picks or approves (D-29, D-34). Note the qualifier: this wait only begins when **nothing else is dispatchable** (L-36). Until then the pile just grows on the Author's desk while the crew keeps working, which is the intended shape — the loop runs continuously and the Author drains it at their own pace.
2a. **Drained** (`pending_kind: drained`) — the loop has run out of work it is authorised to do: no task, no unconfirmed finding, and a fresh round of Readers produced nothing at or above the dial threshold (L-37). This is the normal end of a phase's work and the entry point to completion. The Author either picks up the leftovers or marks the Story done.
3. **Author stop** (per Story, or global). Immediate: no new dispatch, in-flight runs killed. A stopped Story never auto-resumes. (P8)
4. **Author marks a chapter or Story done**, overriding a failing Goal.
5. **Completion** — the Story is **drained**, every hard criterion passes, and the Author accepts — which discards whatever findings and Ideas are still open (L-25, L-25b) → `completed` (§6.9). Note that drained (2a) is the loop *stopping*; this is the Author *closing* it. The loop never completes a Story by itself.
6. **The loop detects it is going in circles** → `pending` with `pending_kind: stalled` (§6.8). Work pauses for the Author; it does not fail.

**L-36** **An unapproved finding does not halt a Story by itself** (D-34). A `confirmed` finding sitting in the queue is a pending *decision*, not a blocked *Story*: the Story stays `ready`, the sweep keeps dispatching everything that does not depend on that decision, and the loop keeps raising, verifying, and queueing more underneath the Author's pile (L-25b).
**L-37** **The loop runs until it is drained, and then it stops.** A Story is **drained** when, on a single full pass over the Story, all of the following hold:

1. no `approved` or `open` task remains for a Writer;
2. no finding remains `unconfirmed` — every suspicion a Reader or checker raised has been confirmed or disputed (D-33);
3. a fresh round of Readers and checkers produced **nothing at or above the dial threshold** (D-35b) — the crew is no longer finding anything it is authorised to work on;
4. no unit still has `competing` revisions awaiting an Editor (D-23).

At that point the sweep sets **`status: pending`, `pending_kind: drained`** and dispatches nothing further. The Story is not complete and not stuck: the crew has run out of work it is allowed to do. The Author now has exactly two moves, and both are theirs to make — **work the leftovers** (approve a sub-threshold finding, which spawns a task and returns the Story to `ready`), or **mark it completed** (L-25, L-26). Condition 3 is what makes drained a real state rather than a momentary gap between sweeps: one clean pass at threshold, with no cost constraint to make it expensive (E-0).
**L-37a** **Drained is checked before stalled, and it wins.** A drained Story has exactly the `trend: flat` signature that L-21 reads as "going in circles" — levels unchanged, no fingerprint closing — so without this precedence a book that has simply run out of problems would be reported to the Author as **stuck**. It is not stuck; it is finished by the standard the dial set. `pending` therefore means "the Author is next" in every case except `stalled`, which is the only one that means trouble.
**L-34** Items 1 and 2 are the loop **working**; item 6 is the loop **stuck**, and the two MUST be distinguishable on screen at a glance. A Story waiting for a signature the Author has not got round to is not the same colour as a Story that has stopped converging.

**L-13** Condition 6 MUST produce an Author-facing explanation on the Pending screen, not a log line.

### 6.7 Loop detection — the measurement

A fresh reviewer every turn (P2) makes "is it improving?" a hard question, because a new reviewer will happily re-report a finding that was already fixed and it will read as a regression. So progress is measured on **stored, deduplicated facts**, never on a run's self-report.

**L-14** The Dashboard maintains, per Story, one **consistency level per phase boundary** (the table in §5.2):

|level|measured as|
|---|---|
|`idea→summary`|C-14, C-15 passing, over the Summary draft|
|`summary→plotlines`|hard criteria C-0…C-6 passing, over the plotline set|
|`plotlines→chapters`|hard criteria C-7…C-9 passing, over the expanded chapter set|

A level for a phase the Story has not reached is `n/a`, not `0/n` — a Story in Phase 1 is not failing at chapters.

**L-15** `trend` is computed from the level history, which is retained per round:

- `improving` — any level rose, or an open finding fingerprint closed;
- `flat` — **every** level unchanged for `flat_rounds` consecutive rounds **and** no finding fingerprint closed;
- `regressing` — any level fell, or a previously-closed fingerprint reopened.

**L-15a** Only **confirmed** findings count in `trend` (D-33). An amnesiac fresh reviewer that keeps raising the same *unconfirmed* suspicion is not evidence that the Story is stuck, and confirming it is the Editor's job — not a reason to page the Author.

Only levels the Story has actually reached are consulted: a Story in Phase 1 cannot be judged on a chapter level that does not exist yet.

**L-16a** A re-reported finding is **not** a regression: it increments `seen_count` on the existing fingerprint (D-16). Only a fingerprint that had been *closed* and came back counts as going backwards. Without this rule, an amnesiac reviewer makes every long-running Story look like it is failing.

### 6.8 Going in circles → `pending`

**L-21a** `pending` has two causes and they are different machines: an **awaiting-the-Author wait** — sign-off, Idea pick, finding approval, or **drained** (L-29, D-29, D-34, L-36, L-37) — which is planned and expected, and a **stall** (L-21), which is not. Only the stall consults `trend`; the wait consults nothing but the queue, and it ends the moment the Author acts.
**L-21** Only after L-37 has been ruled out: when `trend` is `flat` for `flat_rounds` rounds, or `regressing` beyond `regress_tolerance` — counting only **confirmed** findings (L-15a) — the Story moves to **`status: pending`** and the sweep stops dispatching it (D-2a). The Author's tree shows it as needing review, with the reason.
**L-22** `status_reason` MUST name the specific stuck thing (for a sign-off wait, the artifact awaiting the lock and the empty Ideas tray count): which level, which criteria will not move, which finding fingerprints have been open the longest **and are confirmed rather than disputed**, which chapters are involved, and what the crews tried. "Consistency low" is not a reason; "C-4 has failed on chapters 6–9 for 11 rounds; the crews keep moving the mentor scene and the reader keeps objecting to it" is.
**L-23** The stalled screen MUST offer the Author the four exits, as buttons: **edit the unlocked contract, or backtrack to the phase that owns it** (the contract was wrong), **edit a template's instructions or `selection_rules`** (the crew's taste or its brief was wrong), **issue a directive** (the crew needed a decision), **lower the bar** (this criterion does not matter to me). Every one of those re-arms the Story to `ready`.
**L-24** Neither kind of `pending` is an error state, and neither MUST be rendered as one. A Story waiting for a signature is the product working; a Story that stopped converging is the product being honest. A Story that goes pending after four days of good work is the system working correctly: it found something only the Author can settle.

### 6.9 Completion

**L-25** The loop **proposes** `completed` when the Story is **drained** (L-37) and, simultaneously: every **hard** criterion passes at every level; the ledger has no `conflict` or `open`-past-deadline entries; and the soft-pass count is at or above `threshold_soft`. Drained is the trigger — the loop stops looking for work and tells the Author so — and the criteria are what makes the stop worth accepting rather than just quiet.
**L-25b** **Completion does not require an empty findings list.** The loop runs continuously and will always find something; a bar of "zero open findings" is a bar no book clears, and it would leave the Story working forever on `minor` and `taste` items the Author does not care about. What it needs is the **Author's acceptance** (L-26). Whatever is still open at that moment — findings, `proposed` Ideas — is **discarded by the act of completing**, and the count is recorded and shown, so the Author can see what they waved away rather than pretend it was never raised.
**L-25a** `completed` **is Phase 3's lock**: the Author's confirmation locks the chapters exactly as the Summary and plotline locks work, and the sweep stops dispatching. There is no fourth phase.
**L-26** Completion is then **confirmed by the Author** — the loop proposes it, the Author accepts it, and the acceptance is what closes the remaining findings and Ideas (L-25b). This is the last place the machine gets to overrule a human, and the first place a human is allowed to overrule a very long to-do list.
**L-27** `completed` is not permanent. Any Author edit (made from a pause and applied on resume — D-37), any `needs_recheck`, or any directive returns the Story to `ready`, and the sweep picks it up again. A finished book the Author keeps writing by hand stays policed forever — which is the point of a loop that never runs out of time.
**L-28** "All the agents agreed" means the *hard* criteria pass under independent fresh review, not that no reviewer has an opinion. A Reader with a `taste`-cost finding open does not block completion (D-16, G-8).
**D-39** **A completed Story is a dead end on purpose.** Nothing is exported from it and nothing is inherited by the next Story: no taste record, no "what this Author always rejects", no carry-over of the discarded Ideas the lock already deleted (D-36). The records — verdicts, findings, `selection_note`s, the run history — survive for audit and for the Author to read, and they are read by nobody automatically. A sequel is **not** a continuation of state: it is a new Story, and the feature it needs (deferred, §13) is giving its phase ① crews **read access to the prequel's artifacts** so the Writer, Editor and Readers can form the new book against the old one. That is the whole design reserved for later, and it is deliberately not built now: it is the one case that breaks the rule that a run is scoped to exactly one Story (T-3), so it gets an explicit exception when it is designed rather than a half-built second scoping path now. The Seed stays the only cross-book thing the product offers in v1 — and copying it by hand is already how siblings work (D-25a).

---

## 7. Permissions

|Artifact|Author|Assistant (Author-invoked)|**Writer**|**Editor**|Checker / **Reader** (read + report)|
|---|---|---|---|---|---|
|`stories.idea` (the Seed)|write|read|**read only**|read only|read only|
|`summaries` (prose)|write until locked|propose, one field, only when asked|**write in phase `summary` while unlocked**; read only once `summary_locked`|read only|read only|
|`summaries.chapter_count`|write|propose|**read only, always**|read only|read only|
|`ideas`|write, **discard**|read|read|**verify** (fact + guidelines, D-31)|**write** (`proposeIdea`)|
|`ideas` — a `discarded` or `selected` one|read, keep|read|**read** (D-32)|**read** (D-32)|**read** (D-32)|
|`plotlines`|write|write|write until `plotlines_locked`, then propose|**read only**|**read only**|
|`chapters.content` (agent-written)|write **only while `stopped`** (D-37)|write|write|**read only**|**read only**|
|`chapters.content` (Author-written span)|write **only while `stopped`** (D-37)|propose|**propose only**|read only|read only|
|`chapters.title/summary`|write|write|write|read only|read only|
|`revisions`|read, restore|read|**create** (via `editChapter`)|**select / merge / delete**|read only|
|`cast`, `ledger`|write|write|write|**read only**|**read only**|
|`digests`|read|read|**read only**|read only|read only — **no agent writes it**; the engine derives it (D-12a), and a crew's only move is `digest_gap` (D-13)|
|`tasks`|write|write|write|write (files the fix)|write (files the fix)|
|`verdicts`, `findings`|read; **approve / discard** (D-34)|read|write|write, **and confirm / dispute / rewrite** (D-33, D-34)|write (raises `unconfirmed`)|
|`selection_notes`|read|read|read|**write**|read|
|`goals`, `criteria`|write|propose|read only|read only|read only|
|`stories.phase`, `stories.status`, `*.state`|write — **Pause & edit is a status write** (D-37)|read|**read only**|**may recommend `done`**|read only|
|`stories.summary_locked`, `stories.plotlines_locked`, backtrack|**write, alone**|read|read only|read only|read only|
|`templates`, `recipes`|write|—|read only|read only|read only|
|`directives`|write|write|read|read|read|
|`proposals`|accept/reject|read|write|write|write|

**T-1b** The last column covers two kinds with one shared limit: a **checker** and a **Reader** both read and report, and neither writes a story artifact. A Reader's extra right is exactly one — `proposeIdea` — and it is not a write (D-26, T-9). Web access is not a right at all: everyone has it (T-6b). What actually distinguishes the two is that a **Reader is expected to propose**, and a checker is not.
**T-1a** The columns are not a soft convention. Every tool is registered everywhere (T-6a), but the **server** enforces the row: a Reader's `editChapter`, an Editor's prose write, and any agent's write to a locked artifact are refused at the call, naming the rule and the artifact (T-1). Permission is enforced at commit time, not by hiding the tool — the refusal is a teaching message inside the run, and the run changes tactic.

**T-0** Role kind on the template (`roles[].kind`) selects the brief and the permission row — all kinds get the full tool catalogue (T-6a). **How many of each kind a Story has is the Author's choice** (D-38a): the loop never hard-codes one Writer or one Reader, and `max_concurrent` / `attempts` / `agents` are template settings, not engine constants. The only hard requirements are structural: at least one Editor available once `attempts > 1` **or once any Reader or checker is assigned** — an Editor is not optional when there is more than one draft to choose between, and it is not optional when somebody else is filing findings the loop is about to act on (D-33) — and a unit with competing revisions waits for a selection (D-23).
**T-1** The tool layer enforces this table. A tool call that violates it is refused with a message naming the rule and the artifact, and the refusal is visible to the agent so it can change tactic rather than retry.
**T-2** Author-written spans are tracked at section granularity (D-7), so P9 is enforceable without freezing the whole chapter.

---

## 8. Tools

Tools are the agents' only hands (P1, P3). **Every session is built with the whole catalogue** — §8.1 through §8.5, web tools included — and the server refuses the calls a role may not make. What separates a Writer from a Reader from an Editor is therefore **its instructions and its permission row, not its tool list** (D-17a, T-1a). A crew that can see `editChapter` and is told not to use it behaves better than one that cannot see it and invents a workaround.

Two obligations come with that, and they are build obligations, not prompt policy: the catalogue must **reach everything a brief can ask for** (T-12), and it must be **readable from inside the run** (T-6c). A Writer, a Reader, and an Editor all start from the same place — the whole surface, listed, describable, and complete enough that the job in front of them is always something they can actually do.

**T-3** A run is spawned with `storyId` bound into its tool context. No story tool accepts a `storyId` argument — the runtime supplies it — so an agent physically cannot read or write another Story's records. A run exists for exactly one Story for exactly one Work Item.

### 8.1 The Writer surface

Every session sees these tools (T-6a); the **Writer is the only role the server lets use them** on a story artifact. It writes the Summary, the plotlines, the chapters, and the prose — everything that becomes part of the book.

|tool|args|notes|
|---|---|---|
|`editSummary`|`<any prose field>, expects, why`|**phase `summary` only, and only while `summary_locked` is false** (D-3). Refused with P5 named at any other time. It cannot touch `chapter_count` (D-3b).|
|`createPlotline`|`heading, order, must_happen, must_change, pov, setups, payoffs, expects, why`|propose-mode once `plotlines_locked` (L-7).|
|`editPlotline`|`plotline_id, <any field>, expects, why`||
|`createChapter`|`plotline_id, title, summary, order, expects, why`||
|`editChapter`|`chapter_id, section_id?, content?, title?, summary?, expects, why`|a section edit is the default; a whole-chapter `rewrite` is a separate explicit flag (D-7).|
|`deleteChapter`|`chapter_id, expects, why`|only meaningful after an Author changes `chapter_count` (D-3c).|
|`updateDigest`|`body, expects, why`|**registered on every session, refused for every role** (D-12a): the Digest is derived by the engine from committed changes. It stays in the catalogue so a Writer that reaches for it is refused with the reason, instead of silently writing a summary nobody asked for.|
|`proposeChange`|`target_ref, target_field, patch, why`|the only path into an Author-written span (P9).|

**T-3c** `editSummary` is the Writer's *only* write during phase ①, and it is refused the moment `summary_locked` is true (D-3, L-30). A Writer that wants the Summary changed after the lock files a finding; the Author decides whether that is worth a backtrack (D-25).
**T-3a** The Writer MUST be able to run to completion without the Author: it keeps the task queue as its work list and keeps writing until the queue is empty or it must escalate (S-4). "Regardless of number of turns" is a property of the queue, not of a single run.

### 8.2 The Editor surface

The Editor chooses. It reads the competing revisions, applies the Author's `selection_rules` (D-17c), and commits to one — or asks the Writer to merge several. It never writes prose (L-19).

|tool|args|notes|
|---|---|---|
|`listRevisions`|`unit_ref`|the competing drafts, side by side, with their verdicts (D-21).|
|`selectRevision`|`unit_ref, revision_id, selection_note`|the server deletes the losers in the same commit (D-22).|
|`requestMerge`|`unit_ref, revision_ids[], parts, why`|hands the merge to a Writer; the Editor does not compose (L-19).|
|`rejectAll`|`unit_ref, why, re_brief`|no draft is good enough; the brief or the contract is wrong (L-18).|
|`compareRevisions`|`revision_ids[], dimension`|the differences on one axis — pacing, fidelity to `must_happen`, voice — as a report, not a judgment.|
|`verifyIdea`|`idea_id, verdict, evidence, meets_guidelines, why`|**the Editor's independent check of a Reader's claim** (D-27, C-15): re-read the cited source or find a second one, then `verified` / `refuted` / `unverifiable` — **and** whether the idea fits the Author's guidelines at all (D-31). The Author may not select an unverified sourced Idea until this exists.|
|`verifyFinding`|`finding_id, verdict, cost, title?, detail?, evidence, why`|**confirm or dispute a Reader's or checker's suspicion** (D-33), and **rewrite it into the Author's reading surface** (D-34): one clear claim, the evidence line, and the cost it actually deserves — the Editor may downgrade a `critical` to a `minor` as part of confirming it. Only a confirmed finding can be approved, can spawn a task, can invalidate a chapter, or can count toward `pending`.|
|`approveFinding`|`finding_id, decision, why`|**the Author's gate** (D-34): approve → a task is created for the Writer; discard → the finding is closed with no work done. `auto` performs the same call when the Story's switch covers that cost (D-35).|
|`listIdeas`|`phase?, state?, unit_ref?`|what the Readers put forward, with their verification state.|
|`delegate`|`role, task`|fan out inside this run to fresh sub-contexts to reach a conclusion (D-17e). Distinct from a template's declared `agents: N` (D-38): delegation is ad-hoc reasoning the run chooses to do; `agents` is the shape the Author gave the role. Both stay inside one run and produce one answer.|

**T-3b** The Editor verifies Ideas and selects revisions; it does not judge them into the story. An Editor that thinks an Idea is good and writes it in has broken P10 twice — once by writing, once by deciding without the Author (D-29).

**T-2a** `selection_note` is required on every selection, and it must name the rule applied and what the Editor preferred in each draft (L-17). It is the only window the Author has into the automated taste, and it is what makes P12 tunable.
**T-2b** Delegation stays inside one run and one Story: a delegated sub-context is not a Work Item, does not appear in the crew panel as a dispatched run, and cannot write anything the parent could not.

### 8.3 The checker surface

The role kind `checker`, and `reader` apart from what §8.5 adds. Every session holds these tools; what differs is what the server **accepts** from this role: a checker's or Reader's `create*`/`edit*` call on a story artifact is refused naming P10, and their accepted output is verdicts, findings, and tasks.

|tool|args|notes|
|---|---|---|
|`submitVerdict`|`target_ref, criteria_passed[], recommendation`|the run's report; must satisfy D-15.|
|`raiseFinding`|`target_ref, criterion_ref, title, detail, evidence, cost`|`cost` is a **required enum** — the reviewer must triage it (T-11). Deduped by fingerprint (D-16). Lands `unconfirmed`, then waits for an Editor's `verifyFinding` (D-33) and the Author's approval (D-34) before any Writer touches it.|
|`createTask`|`title, detail, owner_role, criterion_ref?, finding_ref?, priority, why`|the fix a checker wants, handed to the Writer (D-11).|
|`editTask`|`task_id, state?, detail?, expects, why`|close what you saw closed.|
|`requestAuthor`|`question, options[], why`|escalation (P7). Creates the queue entry.|
|`markChapterDone`|`chapter_id`|a *recommendation*; only the Author finalises (L-10).|

### 8.4 Shared plumbing

Present on every session — Writer, Editor, Reader, and checker alike. The `edit*` variants are **permitted to the Writer only**: the tool is registered everywhere, and the server refuses anyone else's call (T-1a).

|tool|args|notes|
|---|---|---|
|`readSeed`|—|the Author's idea, **read-only for every agent at every phase** (P5, D-3b).|
|`readSummary`|—|read-only for every agent once `summary_locked`; writable by the Writer during phase `summary` (D-3).|
|`readIdeas`|`phase?, state?, unit_ref?`|what the Readers put forward and how the Editor verified it (D-27) — **including the ones already selected, discarded, or deferred**, which every Reader and Editor brief must carry (D-32).|
|`readPlotline`|`plotline_id` \| `order` \| `list`|one plotline, or the whole outline in order — the contract the Writer must satisfy (P9).|
|`readChapter`|`chapter_id, sections?`|returns Digest context headers so the agent knows what it is standing on.|
|`readCast` / `editCast`||`editCast` is Writer-only.|
|`readLedger` / `editLedger`||`editLedger` is Writer-only; ledger writes are what make C-5/C-6 checkable.|
|`readDigest`|—|the standing view (D-13).|
|`readGoals`|—|the criteria list and threshold (G-4).|
|`listTasks`|`state?, owner_role?`|the queue is agent-writable (D-11); writes go through §8.1/§8.2.|
|`readVerdicts` / `readFindings`|`target_ref?`|what the last passes concluded, so a fresh run does not re-litigate a settled point.|
|`listTools`|`?kind?`|**the catalogue this session holds**, by name and one-line purpose (T-6c). Present on every session: what a role can reach is answerable from inside the run, not only from the harness config.|
|`describeTool`|`name`|the exact shape of one tool — required fields, enum values, what `expects` to carry (T-6c). Cheaper than guessing and being refused (T-11).|
|`reportGap`|`job, needed, tried, why`|**the capability-gap record** (T-12): "this brief asks for something no tool reaches." Not a write to any artifact; it lands on the Author's queue as a tool or template request, and it is what turns an improvisation into a visible defect. Distinct from `requestAuthor`, which asks about the *story*.|

**T-4** Every mutating tool takes `expects: [{id, rev}]` compare-and-swap. A rejected write returns the current record so the agent re-reads and re-applies instead of forcing. Concurrent crews are expected, not exceptional.
**T-5** Every mutating tool takes `why` and records it (P10).
**T-6** Tools MUST be registered on the harness at session build (host-side `registerTool`/`addTool`), declared `core` so a fresh session sees them on turn one with no discovery round trip — a fresh harness every turn (P2) cannot afford a discovery turn.
**T-6a** Registration is **uniform**: every session, whatever its `kind`, gets §8.1 + §8.2 + §8.3 + §8.4 + §8.5. `kind` selects the **brief and the permission row**, not the tool list (D-17a). This is deliberate: a fresh context every turn (P2) that cannot see a tool does not abstain, it improvises — and an improvised workaround is invisible to the Author, while a refused call is a record.
**T-6c** **The catalogue is self-describing inside the run.** Every session carries `listTools` and `describeTool`. Presence is free — the names are already visible at turn one (T-6) — so discovery is never "does this tool exist"; it is "what exactly does it take", answerable in one call instead of by guessing and being refused (T-11). This is not the discovery round trip T-6 forbids: presence costs nothing, only detail is on demand.
**T-12** **The catalogue must cover the brief.** No Work Item is dispatched whose job has no reachable tool: before a template may ask for an action, §8.1–§8.5 must contain a call that performs it. When a run finds its brief asking for something the surface cannot do, it calls `reportGap` — naming the job, what it needed, and what it did instead — and the Story is not penalised in loop detection for the shortfall. A gap is a defect in the **build**, not in the crew. The alternative is the failure T-6a already describes: the agent improvises, the workaround looks like a choice, and the Author never learns a tool was missing.
**T-13** **Capabilities are registered tools, not prompt prose.** Everything §8 names is a host-side registered tool with a schema the server validates (T-6, T-11), present in every session (T-6a). Nothing in the story surface may be "the agent should know how" or "the instructions tell it to": a rule with no tool behind it is a rule a fresh context will eventually violate, and P2 guarantees a fresh context every turn. The Author's assistant (§8.6) is the only exception to uniform registration, and only by subtraction.
**T-6b** **Web tools are available to every role**, and what governs their use is the template's instructions (D-30). A Reader is told to research in order to form and check ideas; a Writer may look up whether a revolver in 1880 could actually fire six times; a checker may confirm a period fact before it files the finding. Cost is no object (E-0), so the constraint is not *who may browse* but **what counts as evidence**: a claim that reaches a locked artifact needs an Editor's verdict (C-15), whoever fetched it.

### 8.5 Research and proposal tools

Available to **every** role (T-6b); governed by the role's instructions (D-30). A Reader is the role these tools were written for — it reads the story as the Author reads it, rates it, and looks things up in order to form and check its ideas — but a Writer may verify a period fact before it writes one, and a checker may confirm before it files.

|tool|args|notes|
|---|---|---|
|`searchWeb`|`query, maxResults?`|leads, not facts. Results are untrusted excerpts; the Reader cites and the Editor checks (D-27).|
|`fetchPage`|`url, query?`|read one source properly before citing it. A search snippet is not evidence.|
|`proposeIdea`|`phase, unit_ref?, body, kind, sources[], why`|a Reader's only contribution mechanism (D-26). Never an edit. Deduped by `fingerprint` against decided Ideas (D-32).|
|`markUnverifiable`|`idea_id, why`|"cannot be checked from here" is an honest verdict, not a shrug; the Idea reaches the Author marked unverified.|

**T-9** A Reader MUST NOT write a story artifact — it *can* call `editChapter`, and the server will refuse it (T-1a). Its accepted output is `proposeIdea`, `raiseFinding`, and `submitVerdict` (D-26, P10). A Reader that rewrites chapter 4 has destroyed the independence the phase model buys it, and the refusal is what stops it from doing so quietly.
**D-30** A Reader role's instructions name **what it reads for and what it may propose**: rate the chapter as the Author reads it, flag anything that diverges from the plotline, anything that references something that does not hold up, anything that spends a mystery before it is earned — and propose freely, including ideas that are wrong. The **Editor** is what keeps those proposals inside the Author's guidelines (D-31), not a limit on what a Reader is allowed to think about.
**T-11** **The tool validates the request body, and the agent sees the error.** `cost` is a required enum on `raiseFinding`, so a Reader cannot file an untriaged finding; `evidence` is required on a failing criterion (D-15); `selection_note` is required on a selection (T-2a). A malformed call is refused naming the field and the expected shape, and the run corrects it in place — schema enforcement belongs in the tool, not in the prompt, because a prompt is something a fresh context can be tired of.
**T-10** Every `sources[]` entry records `url_or_title`, the specific `claim` it supports, and `accessed_at`. An Idea citing a page for a claim that page does not make is `refuted` by the Editor, not "mostly right" (C-15).
**T-7** Tool results are bounded and structured; a tool that hands a whole book to a reviewer breaks the reading economy (§11) and is a defect, not a convenience.
**T-8** Every tool result names the record revision it was read at, so a follow-up call in the same run can send a valid `expects` without re-reading.

### 8.6 Assistant tools

The Author's assistant (invoked by the Author, on a Summary or a Directive) gets the Author's write rights for the duration of that one run, and nothing else. It does not get the Reader's web tools, and it never writes a locked artifact.

---

## 9. Run lifecycle

```
sweep → Story is `ready`? → WorkItem claimed (lease)
      → spawn: new session from template, storyId bound, brief assembled
      → run:  agent works through tools, no chat
              (an Editor may delegate to fresh sub-contexts inside this run, D-17e)
      → report: submitVerdict / raiseFinding / createTask / requestAuthor / proposeIdea
                selectRevision / requestMerge / rejectAll / verifyIdea
      → commit: server applies, stamps, deletes non-selected revisions (D-22),
                invalidates dependents, rebuilds digest
      → teardown: session destroyed, run row closed
      → findings: confirmed by an Editor (D-33) → rewritten for the Author (D-34)
                → approved by the Author, or by the switch if the cost is covered (D-35)
                → task → dispatched to a Writer on a later sweep
      → recompute the phase's level and trend
            → phase Goal passed?  → `pending` · `phase_signoff`: STOP, wait for the lock (L-29)
            → Ideas or confirmed findings awaiting the Author, and nothing else to dispatch?
              → `pending` · `idea_selection` / `finding_approval` (D-29, D-34, L-36)
            → drained? (no task, no unconfirmed finding, one clean round at
              or above the dial threshold) → `pending` · `drained` (L-37)
            → else trend flat or regressing? → `pending` · `stalled` (§6.8, L-37a)
      → next sweep
```

**S-1** One Work Item = one Run = one fresh session. A run is never handed a second job. A session is never reused.
**S-2** The brief is assembled by the server from the store: `role prompt + phase + Goal criteria for that phase + the Seed + Digest + the artifact under review + the specific job + what changed since the last pass + the open tasks that job must clear + the selected Ideas this run must absorb (D-29)`. A Reader's brief adds the research question and the sources already cited, so two Readers do not browse to the same page. It MUST be self-contained; a run has no memory of any prior run.
**S-3** Teardown is unconditional — including on failure, timeout, and Author stop. No orphan sessions. The run row records why it ended.
**S-4** A run that ends without calling `submitVerdict`, `raiseFinding`, `createTask`, `requestAuthor`, `proposeIdea`, `verifyIdea`, `selectRevision`, or `requestMerge` is a **no-op turn**: it MUST count toward loop detection (§6.7 / L-15). A Writer run that ends without writing anything and without escalating is a bug in its brief, not a cost.
**S-4a** There is no timeout on a run and no retry cap. A run that takes four hours is fine. A run that hangs is detected by **lease expiry** (L-2), not by a clock: the lease lapses, the Work Item returns to the queue, and the run is torn down.
**S-5** Concurrency: `max_concurrent` per template, per Story, and a global cap. The sweep fills capacity across all Stories, so the crew stays busy whenever any Story has work (the Author's "constantly busy" requirement).
**S-6** A run's wall-clock and token usage are recorded and surfaced per Story, per chapter, per template — **informationally only**. Nothing may read them as a limit (E-0). They answer "why is this taking an hour?", not "can we afford this?"
**S-7** A delegated sub-context (D-17e) is not a Work Item and gets no row of its own in the crew panel; it is shown nested under the run that spawned it, because the Author's unit of attention and of control is the dispatched run.

---

## 10. The Dashboard

### 10.1 Layout

Four regions. The right region is the crew, not an agent list — the Author controls the harnesses, and watches what they are doing to the selected Story.

```
┌────────────────┬────────────────────────────┬─────────────────────┐
│ STORIES        │ THE STORY                  │ CREW                │
│ phase-first,   │ ① Summary ② Plotlines      │ live runs for this  │
│ then status:   │ ③ Chapters · Cast · Ledger │ story               │
│ awaiting →     │ Revisions · IDEAS tray     │ ──────────────────  │
│ ready → done   │ [ LOCK PHASE ] [BACKTRACK] │ TEMPLATES           │
│                │                            │ new · duplicate ·   │
│                │                            │ prompts · rules     │
├────────────────┴────────────────────────────┴─────────────────────┤
│ DIRECTIVE BAR — "kill the mentor in ch4" · "make it colder"       │
└───────────────────────────────────────────────────────────────────┘
```

### 10.2 Requirements

**U-1 Stories panel.** Every Story shows its **phase** (① Summary · ② Plotlines · ③ Chapters, with a lock icon on each phase it has signed), its **`status` badge** (`ready` / `pending` / `completed` / `stopped`), its consistency levels for the phases it has reached (`idea→summary 2/2 · summary→plotlines 6/6 · plotlines→chapters n/a`), its `trend` arrow, and `status_reason` when pending. **Stories waiting on the Author sort to the top** — they are the ones only the Author can move.
**U-1b** A `pending` Story is **two different colours**: awaiting the Author — signoff, idea pick, finding approval, or **drained** — is calm (the loop finished something, ran out of authorised work, or is waiting to be told), stalled is urgent (the loop hit a wall). L-34, L-36, L-37a. Awaiting-signoff is the state the whole product aims at, and it is the one the Author should be able to clear in one click.
**U-1c** **Drained reads as a finished thing, not an idle one**: the row says what the crew stopped finding ("no critical or major left · 12 minor and 4 taste awaiting you") and offers the two moves L-37 allows — **pick up the leftovers** or **complete**. The word "drained" should not appear on screen; it is the internal name for "we are done with what we were told to do."
**U-1a** The **stalled** screen is the Author's review surface, not a log: it shows the stuck criteria, the oldest open findings, the chapters involved, what the crews tried across rounds, and the four exits from L-23 as buttons.
**U-2** A Story with nothing blocked still shows what the crew is doing to it right now.
**U-3** Per-Story Stop / Resume, and one global Stop. Global Stop is the biggest button on the screen.
**U-4 The Story view.** The **Seed** is a pinned, read-only card at the top of every Story for every viewer — it never scrolls away, because it is the thing the book is measured against (C-14). The Summary pane is editable by the Author and by the Writer during phase ① only; once locked it is read-only with an "Ask assistant" affordance and a **Backtrack** button that says exactly what it will delete (L-32). Plotlines and chapters are shown side by side — the contract next to the prose — because the whole product is the distance between them.
**U-5** Chapter prose shows inline accept/reject per proposal, with the `why` and the run that made it, and undo. A diff, not a replaced paragraph.
**U-17 The prose is editable, and the pause is the price.** The chapter pane is a text editor, greyed out while the Story runs, with one button that makes it live: **Pause & edit** (D-37). It states what pausing costs — runs killed, dispatch halted — and **Resume** states what the edit will trigger: digest re-derived, N dependents marked for recheck (D-37a). While paused, the pane says so at the top ("paused by you · 3 runs stopped"), because a Story that looks idle and is actually being edited by hand is a different thing from one the crew has drained (U-1c).
**U-6** Goal panel: the criteria list with live pass/fail per criterion, the failing evidence, the `fix_hint`, and the Author's controls (toggle hard, delete, add, threshold, per-chapter bar override).
**U-7 Crew panel.** Live runs: role and kind (Writer / Editor / Reader / checker), template, what it is doing, which task it holds, elapsed, and a kill button per run.
**U-8 Template panel.** The catalogue. Each card: roles with their `kind` (Writer / Editor / Reader / checker) and whether a Reader role has `web`, phase it serves, done-definition, `attempts`, escalation rule. Actions: **New**, **Duplicate**, **Edit roles and prompts**, **Set agents per role** (D-38), **Set attempts**, **Assign to phase**, **Assign as a Writer of this Story** — repeatable, since the count is the Author's call (D-17b, D-38a). Built-ins duplicate-only (D-17).
**U-8a** The Writer template is visually distinct from the checkers — it is the only one that produces prose, and the Author should never confuse the crew that writes with the crew that judges.
**U-8b** An Editor template's card shows its **`selection_rules` in the Author's own words**, editable in place, because that text *is* the Author's automated taste (P12). Editing it and watching the next `selection_note` change is the core tuning loop of the product.
**U-8c** Each template card shows `attempts` — how many competing drafts it spawns — since that is the dial that turns divergence on and off.
**U-8d** Each role row shows `agents: N` and its `aggregate` mode, since "this Editor is three agents that argue and return one answer" (D-38) is invisible unless the card says so. When a run's agents disagreed, the crew panel marks that run: the dissent belongs in the `selection_note`, and the Author needs to know which authoritative answers were unanimous.

**U-9 Directive bar.** A single line of Author intent that becomes a `directives` record and propagates (D-19). Not a chat box: it does not accept conversation, it accepts decisions.
**U-10 The Author's queue.** Confirmed findings awaiting approval, Ideas awaiting a pick, and escalations, aggregated across all Stories, are the home screen. "3 stories need you." This is the loop-engineering aimed at the human (D-34).
**U-10a** Each finding in the queue reads as the **Editor wrote it**, not as the reviewer wrote it: the claim, the evidence line, the cost, and two buttons — approve, discard (D-34). The Story view shows its **auto-approve dial** beside Stop, with the costs it currently skips (D-35), because the Author should never be surprised later by work the machine started on their behalf.
**U-10b** Approving is progressive and never batched away silently: the Author may approve one finding, approve a whole chapter's worth, or turn on auto-approve for a cost and stop touching that class of problem. The queue drains at whatever pace the Author sets, and the loop keeps finding more underneath them (L-25b).
**U-11 Nothing on screen is agent activity for its own sake.** No "loop running ✓" spinner. Progress reads as story: chapters drafted, hole in act 2, setups unpaid, arcs unresolved.
**U-12** The Dashboard is usable with zero harnesses running: the Author can write the Seed, a Summary, plotlines, or chapter prose by hand at any time, and the crew simply picks it up on the next sweep. With harnesses running, chapter prose still needs the pause first (U-17, D-37) — the rule is about racing, not about permission.
**U-12a** The **phase strip** — ① Summary · ② Plotlines · ③ Chapters, each with a lock icon when signed — is the first thing on the Story view and the second thing on each Stories-panel row. The Author should be able to tell where any Story is in the pipeline from across the room.
**U-13 Revision comparison.** When a unit has competing revisions, the Story view shows them **side by side** with the checkers' verdicts and the Editor's `selection_note`. The Author can select, merge, or restore any of them before the Editor commits (D-24), and can watch the losers disappear on selection (D-22).
**U-15 The Ideas tray.** Every `proposed` Idea for the current phase, in one place, **above a collapsed list of what has already been decided** — selected, discarded, deferred, each with its `selection_note` (D-32). The tray is **phase-scoped and empties at the lock** (D-36); it is a workspace, not an archive. The decided list is not decoration: it is the only reason the next fresh Reader does not propose the same thing again, and the Author should see the crew re-raising a settled point as the repeat badge it is. who filed it, what it claims, the sources it cites, and the Editor's verdict with evidence (`verified` · `refuted` · `unverifiable`). The Author **selects** or **discards** each one; a selected Idea becomes the next Writer's brief (D-29). Unverified Ideas are visibly dimmed and cannot be selected without an explicit "I know" (D-27). The tray shows a count, and the phase cannot be locked while it is non-empty (L-7a).
**U-16 Lock and backtrack are the two biggest buttons on the Story view.** **Lock phase N** appears only when that phase's Goal passes and the Ideas tray is empty; it states in one line what becomes read-only. **Backtrack to phase N** states in one line what gets deleted, and asks once (L-31, L-32). There is no other way to change a locked artifact, and the UI should say so on every locked pane.
**U-14 Completion is a proposal.** A `completed` Story shows what made it complete — the passing levels, the ledger state — **and exactly what accepting will discard**: "47 findings and 12 Ideas will be closed without action, the oldest from chapter 2" (L-25b). The Author accepts with their eyes open, and the count is kept as a record afterwards. A green tick the machine gave itself is not information; neither is a to-do list quietly emptied.

---

## 11. Reading economy — cost is out of scope

**E-0** Neither tokens nor wall-clock are design constraints. Unlimited both, by decision. **No budget, cap, timeout, or round limit may gate a phase transition, halt a loop, or be used to argue against a design.** A Story may be worked on for days; that is expected, not a problem to solve.

**E-0a** The only scarcity the design honours is **attention and correctness**: the Author's time, and the risk that a fresh context reads too much and loses the thread. Four things replace every budget as the thing that stops work: the **phase sign-off** (L-29), the **approval wait** (D-34), and **drained** (L-37) — all three designed — and **loop detection** (§6.8), the unplanned one. Note what is *not* on that list: an unfinished to-do list. The loop keeps finding work until the Author says the book is done (L-25b) — the throttle is the Author's attention, spent through the auto-approve dial (D-35), never a cap on how much may be noticed.
**E-0b** Web reads are free in the same sense (D-27 aside): a Reader MAY fetch twenty pages to support one Idea, and any other role may look something up before it acts on it (T-6b). The constraint on research is **verification, not volume** — an unverified claim is worthless however well-sourced, and a verified one costs nothing extra to have.
**E-0c** **Sources are not archived.** A citation only has to hold for the duration of the Story being written (D-27): a book is produced in days, published or posted, and then the Author starts the next one. Link rot after publication is not this product's problem, and neither is a citation library. `accessed_at` is recorded and that is all.

What still matters is **reading economy**, because a fresh context that re-reads the whole book every turn produces *worse judgments*, not merely slower ones.

**E-1** A run's required reading is `Digest + the artifact under review + the criteria`. Roughly constant regardless of book length.
**E-2** A run that reads more than its brief asked for is a `digest_gap` signal, so the Digest improves rather than the reading silently growing.
**E-3** A run's brief MUST fit the job it is given: one judgment, or one bounded edit set. An oversized brief is what reintroduces context rot *inside* a single run, which P2 exists to prevent.

**C-B** All chapters are in flight together by default (L-8), which is safe only because every one of them is a separate session (S-1). Since cost is out of scope, expense is never a reason to sequence; the dependency set exists to say **where a fix must propagate** (L-9), not what may run when.
**C-C** There is no per-Work-Item, per-chapter, or per-Story budget. The stops are the **phase sign-off** (L-29, the designed one) and **loop detection** at Story level (§6.8, the unplanned one), and both pause rather than fail.
**E-4** Divergence is cheap and valuable: `attempts` defaults above 1 wherever an Editor template is assigned, because comparing drafts is the mechanism the whole architecture exists to provide (P13).

---

## 12. Workstreams

Each is independently buildable against §4–§9. Numbers are dependency order, not priority.

|#|workstream|builds|acceptance|
|---|---|---|---|
|W1|**Store**|§4 collections incl. **`ideas`** (with `fingerprint`; `confirmed_by`/`approved_by` on findings), revisions, compare-and-swap, invalidation marks, the two lock flags, `auto_approve`|a rejected `expects` returns the current record; `summary_locked` gates every write to `summaries`; a Seed edit scraps every later artifact (D-25a); a `discarded` Idea is readable for the rest of its phase and **gone after the lock** (D-36)|
|W2|**Tools**|§8.1 Writer, §8.2 Editor, §8.3 checker, §8.4 plumbing, **§8.5 research and proposals**, **`listTools` / `describeTool` / `reportGap` (T-6c, T-12)**, story scoping, permission table §7|**every session sees every tool**, and the server refuses what the role may not do: a Reader's `editChapter` is refused naming P10, an Editor's prose write is refused naming L-19, a write to a locked Summary is refused naming P5; an agent cannot touch another Story; every write carries `why`; **`describeTool` returns the exact shape of every tool in §8, and a brief that asks for an unbacked action produces a `reportGap` rather than a silent workaround** (T-12, T-13)|
|W3|**Criteria engine**|§5, `code` checkers run server-side, `judge` criteria collected from verdicts, **per-phase reporting**|C-0/C-1/C-5/C-6/C-15 evaluate with no model call; a plotline count that differs from `chapter_count` fails C-0; a sourced Idea reaching a locked artifact without an Editor verdict fails C-15; progress renders as `n/m · failing: …` **for the current phase only**|
|W4|**Loop engine**|§6 phases, the `status` machine (D-2a), the three sign-off gates (§6.3, §6.3a), all-chapters-together (L-8), invalidation and propagation (L-11a), **`drained` (L-37)**, §6.9 completion|a Story walks `summary → plotlines → chapters → completed` stopping at exactly three Author sign-offs; **a phase whose Goal passes goes `pending`/`phase_signoff` and receives no further work**; **a Story with no authorised work left goes `pending`/`drained` and dispatches nothing, never `stalled`** (L-37, L-37a); nothing ever halts on a budget|
|W4c|**Locks + backtrack**|D-25, D-25a, D-36, L-29…L-34, `summary_locked` / `plotlines_locked`, §7 lock rows|locking the Summary refuses every agent write to it **and empties the Ideas tray**; backtracking from ③ to ② deletes every chapter and revision and reopens ② with no trace of the scrapped prose; verdicts and `selection_note`s survive, Ideas do not|
|W4d|**Ideas + Readers**|§4.17, D-26…D-32, §8.5, `verifyIdea`, U-15|a Reader files an Idea citing a page; the Editor re-reads that page and marks it `refuted` when the page does not say that; the Author cannot lock the phase while the tray still holds `proposed` Ideas; **a Reader that re-proposes a discarded Idea is reported as a repeat, not re-opened** (D-32)|
|W4e|**Findings verification**|D-33, `verifyFinding`, the `unconfirmed` state, L-15a|a Reader's false positive is disputed and costs no Writer pass; an unconfirmed finding moves no chapter and triggers no backtrack; a confirmed one is rewritten into the Author's reading surface with the cost it deserves|
|W4f|**Approval gate + auto-approve**|D-34, D-35, **D-35b**, `approveFinding`, `stories.auto_approve`, U-10a/b, T-11|a confirmed finding spawns **no** Writer work until the Author approves it; flipping the switch to include `major` makes the next one auto-approve and the Writer moves without being asked; a malformed `raiseFinding` (missing `cost`) is refused naming the field (T-11); **the same switch moves the drain threshold** — include `minor` and the Story drains later, because findings below the old threshold now count as work (D-35b, L-37)|
|W4b|**Divergence + selection**|§4.15 revisions, §6.2a, §8.2 Editor surface, D-22 deletion, L-16…L-20|N drafts appear side by side; an Editor selects; the losers are gone in the same commit; a fresh Writer on the next chapter cannot see them|
|W5|**Sweep + spawner**|§6.1, §9, claim-with-lease, teardown, lease expiry (S-4a), restart recovery|kill the server mid-pass; on restart the loop resumes and no job runs twice|
|W6|**Digest**|§4.8, **engine-derived rebuild on commit (D-12a)**, `digest_gap` handling|a reviewer judges chapter 20 without reading chapters 1–19; **no agent can write the Digest** (`updateDigest` refused for every role, D-12a); the Digest a reviewer saw three passes ago is reconstructible from committed history|
|W7|**Consistency levels + loop detection**|§4.10 fingerprints, §6.7 L-14/L-15/L-15a/L-16a, §6.8 `pending` + the four exits, **L-37a precedence**|a re-reported finding increments `seen_count` and is **not** a regression; `flat_rounds` flat rounds move the Story to `pending` with a named reason and four buttons; **a Story that has simply run out of problems reports `drained`, not `stalled`** — the two share the flat signature, so the check order is the test (L-37a)|
|W8|**Templates**|§4.12, D-17 duplicate/edit, D-17a/b kinds, D-17c `selection_rules`, D-17d `attempts`, D-17e delegation, **D-38 `agents` + `aggregate` (a role as N agents answering once), D-38a Author-chosen counts**, session build from a template|the Author duplicates a crew, edits its `selection_rules`, and the next `selection_note` reflects it; **a role with `agents: 3` runs three fresh agents inside one run and returns one report, one verdict set, and one `selection_note`** (D-38); assigning a second Writer template is allowed and style divergence between the two voices surfaces as a `taste` finding (D-38a)|
|W9|**Dashboard: stories + queue**|U-1, U-1a, U-12a, U-2, U-3, U-10, U-11|three Stories in three phases and three statuses; the one awaiting the Author is on top, and it is visibly a different kind of wait from the stalled one|
|W10|**Dashboard: story view**|U-4, U-5, **U-17**, U-6|inline accept/reject with `why` and undo; plotline visible beside its prose; **the prose pane is editable only from Pause & edit, refuses while running, and Resume names what the edit will re-derive and re-check** (D-37, D-37a)|
|W11|**Dashboard: crew + templates**|U-7, U-8, U-8a/b/c, U-14, S-7|live runs appear and disappear with delegated children nested; duplicate a template and edit its `selection_rules` from the UI|
|W11b|**Dashboard: revisions**|U-13, D-21, D-24|competing drafts side by side with verdicts; the Author can override the Editor's pick|
|W12|**Dashboard: directives**|U-9, D-19|"kill the mentor in ch4" generates tasks, marks dependents, reports what it touched|
|W13|**Dashboard: phases + Ideas + queue**|U-1, U-1b, **U-1c**, U-10a, U-10b, U-14, U-15, U-16, L-34|the phase strip and lock icons read at a glance; awaiting-signoff, drained and stalled are three visibly different states; selecting an Idea hands it to the next Writer's brief; **a drained Story reads as finished rather than idle and offers exactly two moves without using the word "drained"** (U-1c); **the completion prompt states how much it will discard**|

---

## 13. Non-goals

- **Not a chat client.** There is no conversation surface for the loop. The composer is a directive bar.
- **Not an agent list.** The right panel is crews and templates; agents are internals of a template.
- **No reviewer prose.** A checker never writes a chapter, a plotline, or a line of dialogue. It files a finding and a task.
- **No Editor prose.** An Editor selects and merges structure; it never composes a sentence (L-19).
- **No best-story ambition.** The target is the Author's own story, automated (P12, G-8). A criterion that chases objective quality is a build defect.
- **No surviving rejected drafts.** Non-selected revisions are deleted (P13, D-22).
- **No agent chooses the chapter count.** The Author declares it, and it is read-only for every agent at every phase (D-3b).
- **No token budget, no time budget, no round cap.** Cost is out of scope by decision, not by oversight.
- **No silent spinning.** A loop that stops converging says so and waits (P14, §6.8).
- **No long-lived agent.** No session outlives its Work Item.
- **No agent edits a *locked* Summary**, and **no agent edits the Seed** — those are the Author's, and the only way in is a backtrack.
- **No Reader writes prose.** A Reader researches, rates, and proposes; it never edits — and it never decides that its own Idea is good enough (D-26, T-9).
- **No unconfirmed suspicion costs a Writer a pass.** A finding from a Reader or checker is a claim until an Editor verifies it (D-33).
- **No completion requires an empty findings list.** The loop always finds something; completion needs no work left *at the dial threshold*, not zero findings, and the Author's acceptance closes the remainder with a count on it (L-25b, L-37).
- **No appeal above the Editor's triage.** It sets the cost, disputes what it doubts, and that is the end of it; the Author edits the template, not the finding (D-34a).
- **No reporting a finished book as stuck.** Drained outranks stalled (L-37a): running out of problems is not going in circles.
- **No discarded Idea is deleted inside the phase that decided it.** A decision is memory, not an alternative (D-28, D-32) — and it is memory for that phase only (D-36).
- **No Idea outlives its phase.** Locking deletes the tray; the artifact is what remains (D-36).
- **No finding reaches the Writer unapproved.** Reader raises, Editor verifies and rewrites, Author approves — unless the Story's switch approved it for them (D-34, D-35).
- **No tool is hidden from a role.** Every session sees the whole catalogue; the server says no (T-6a, T-1a).
- **Nothing is a prompt-only rule.** Every capability §8 names is a registered, schema-validated tool. If the surface cannot do something a brief asks for, that is a build gap to be reported and filled (T-12), not something to exhort a fresh context into (T-13).
- **No phase runs past its sign-off.** A Goal that passes stops the loop (L-29); there is no "keep polishing until the Author notices".
- **No carrying work across a backtrack.** Scrapped phases leave prose behind; only their records survive (D-25).
- **No numeric quality score.** Criteria only.
- **No autonomous sign-off.** The Author locks each of the three phases and marks work done. A phase that passes its Goal waits; it does not proceed.
- **No multi-story run.** A run exists for exactly one Story.
- **Nothing survives a finished book.** `completed` means completed: no taste record, no carry-over of what the Author rejected, no export, no lessons. A book that is done leaves records behind for audit and nothing else (D-25a, D-39).
- **No sequel awareness in the first build.** A sequel is a new Story whose phase ① crews are given **read access to the prequel** — that is the shape of it, and it is deferred, not designed (D-39). It is the one place the single-Story scoping rule (T-3) will need an explicit exception, which is why it stays out of v1 rather than being half-built.
- **No agent-authored Digest.** The Writer writes everything in the book; the Digest is not in the book — it is derived from commits by the engine (D-12a).
- **No Author prose while the crew is running.** The chapter editor is live only from a pause (D-37); the product does not attempt live collaborative editing.
- **No recipes in the first build.** Templates carry it. A recipe is what gets named once several Stories have been built the same way by hand (P15).
- **No engine rewrite needed to change the design.** Not a non-goal so much as a build constraint (P15): a phase model, a role set, or a criterion must be replaceable without rewriting the store.

---

## 14. Open decisions

Record the answer here rather than inventing one silently.

**Answered by the Author (normative — these are decisions now, not questions):**

- **Seed changes → start from scratch.** No partial reopen: a new idea is a new book. (D-25a)
- **All chapters are written together, and cross-chapter consistency is the agents' job.** A contradiction between chapter 1 and chapter 12 marks both and the loop fixes the side the plotline says is wrong. (L-8, L-8a, L-11a)
- **Phase ① gets full divergence.** (D-3d)
- **Every role gets the whole tool catalogue**; a Reader is defined by its instructions — read the story, rate it, propose ideas, use web search to form and confirm them. (T-6a, D-30)
- **Discarded Ideas are never deleted *within their phase***, because the Editor must know what was already rejected or the loop re-argues it forever — and the tray is emptied when the phase locks. (D-28, D-32, D-36)
- **An approved finding is what starts a Writer.** Reader raises with a cost → Editor verifies and rewrites → Author approves (or the switch does) → task → Writer. Nothing skips the last step unless the dial says so. (D-34, D-35)
- **Completion is the Author's call, not an empty queue.** The loop proposes; the Author accepts; the rest is discarded with a count on it. (L-25b, U-14)
- **A Seed edit is a full clear.** A second book from the same idea is a hand-copied Seed in a new Story. (D-25a)
- **Readers may propose anything**; the Editor is what keeps ideas inside the Author's guidelines. No pre-filtering of what a Reader is allowed to think. (D-30, D-31)
- **Sources are not archived.** A citation only has to hold while the Story is being written. (E-0c)
- **Tools are built and registered on the harness for every role, and the catalogue is discoverable from inside the run.** Writer, Reader and Editor each hold the whole surface, can list it and read any signature without leaving the session, and report a gap when a brief asks for something no tool reaches — so nobody is ever left needing a capability they cannot find. (T-6a, T-6c, T-12, T-13)
- **Phase ③ is the automated one.** The Reader judges effect (diverges from the plotline, references something that doesn't hold up, spends a mystery early), the Editor verifies whether it is true, the Writer updates. The Author watches, stops, and steers at their own discretion — none of it is required. (Loop B, L-35, D-33)
- **Readers triage by cost; the tool enforces the schema.** `cost` is a required enum, so no finding arrives untriaged. (T-11)
- **The Editor verifies and rewrites the finding for the Author's eye.** (D-33, D-34)
- **The Author approves progressively, and nothing reaches the Writer without that approval.** The loop keeps finding more underneath them until the Author accepts completion, which discards the rest. (D-34, L-25b)
- **There is a switch to auto-approve `critical` and `major`**, because the Author would approve them anyway. (D-35)
- **Ideas persist only within their phase.** Locking a phase keeps its final artifact and deletes everything else, the tray included. Phase ③ is the only place that could pile up, and the Author is watching it, so it does not. (D-36)
- **A Seed edit clears every later phase.** To spin a second book from the same idea, copy the Seed into a new Story by hand — the product does not fork Stories. (D-25a)
- **The Author writes chapter prose in the UI, from a paused Story.** Pause & edit, type, resume; the pause is what prevents races and corruption, and the resume re-derives the Digest and re-checks dependents. (P9a, D-37, D-37a, D-37b, U-17)
- **Writer, Editor and Reader are templates — harnesses containing agents — and the Author decides how many.** A single role may be N agents that aggregate to one answer, so "one Editor or a panel" is a template setting rather than an architecture decision, and the panel's disagreement never reaches the loop as a vote. (D-38, D-38a, T-0, U-8d)
- **Nothing survives a finished book.** Finished means finished. A sequel is a later feature: a new Story whose phase ① crews can read the prequel. (D-39)
- **The Digest is built by the loop engine from committed changes**, so the history is right and no authoring agent can contaminate the thing every reviewer trusts. (D-12a)
- **The design is expected to change.** Build it out, test it in building, revise the engine; deferred things stay named holes. (P15)
- **The Editor's triage is final.** Its cost call on a finding is not appealable item by item; the Author tunes the template when it is wrong, the same way they tune prose taste. (D-34a, G-7)
- **The loop runs until the Story is drained, and then the Author decides whether the book is done.** No budget, no empty-queue test, no automatic completion: the crew stops when it has stopped finding anything at or above the dial threshold, says so, and waits. (L-37, L-25b, D-35b)

**Closed by the agent's recommendation** — the Author delegated these ("ask me anything critical"; they are the nitty ones). Each is reversible on its own and none changes the architecture:

- **1a** losing revisions: hard delete in the selection commit, no grace period (D-22 stands).
- **1d** a divergence unit is a **chapter, a plotline, or the Summary** — not acts, scenes, or endings; a wider unit is expressed as more attempts on its chapters.
- **2** the Goal is **per-Story with a per-chapter `bar_override`**, so the ending can be held higher than chapter 3 (U-6).
- **5a** "all agents agreed" = hard criteria pass under independent fresh review (L-28); no N-reviewers-in-one-round requirement, since fresh review already happens across rounds and the dial controls volume.
- **5b** a contradiction in act two does **not** halt the book: the uninvolved chapters keep being polished and `status_reason` says so (L-36 extended to the stuck case).
- **6** escalation is dialled per **Story** (`auto_approve` already lives there, D-35), not per template — the crew's taste is per template, the interruption budget is per book.
- **8** vocabulary: the UI shows **Seed, Summary, plotline, chapter, finding, Idea, Goal**; beats/promise/payoff/arc stay internal except inside a criterion's own text.
- **11** the Author **can unapprove one chapter** — keep its prose, reopen its review — and it is a different verb from backtrack (L-31). It is the one case where a chapter may legitimately sit at a different vintage than its neighbours.
- **13a** a failed web search is just a thinner Idea, not a `digest_gap`; provider is config, not spec.
- **14** **no partial phase locks** (L-33). A lock means the phase is signed.
- **15** same-criterion `taste` findings are **folded by the Editor into one entry per chapter** as part of its rewrite (D-34), since fifty "the prose felt flat here" lines are unreadable.
- **17** the Story view shows the **cost distribution of the last N rounds** — confirmed-at-each-cost and downgrades — so a systematically soft Editor is visible as a number without any per-item review. It is the only check on D-34a's no-appeal rule.
- **0 / 1d / 5 display:** the Story view groups chapters **by what the crews are doing to them** (drafting / contested / awaiting a fix / clean), not by order, because with all chapters in flight together order is no longer what is happening (L-8, U-4).



**The running log** — every question raised during the design, with its status as it was answered. Where an item still ends in "Recommended:", the recommendation block above supersedes it; the reasoning is kept because it is the record of *why* the answer is what it is.

0. **Resolved by the three-phase model:** the Author's first-class writing is the **Seed** and the **lock** — and now also **chapter prose, from a paused Story** (P9a, D-37). Phase 1 means the Author's words are structurally in the book from the first record, and the pause-to-edit rule means they stay in it at every later phase without racing the crew.
0a. **Does the Seed ever change?** — **Answered: yes, it clears every later phase, same Story row.** A second book from the same idea is a manual Seed copy into a new Story; no forking, no lineage, no "duplicate with history". (D-25a)
1. **Does the Author ever write chapter prose directly?** — **Answered: yes, in the UI, from a paused Story.** Pause & edit → type → resume; the pause is what prevents the race and the corruption, and resume re-derives the Digest and re-checks dependents. `proposals` therefore keeps its purpose in one direction only: it is how an *agent* touches Author prose (P9, D-20a), never how the Author touches their own. (P9a, D-37, D-37a, D-37b)
1a. **Who deletes the losing revisions, and when?** D-22 says the server, in the selection commit, hard. The alternative is "the Author does it, later" — which keeps the drafts around for comparison but reintroduces exactly the pile of alternatives P13 removes. Confirm hard deletion, and decide whether the Author wants a grace period (the run's output recoverable for N days) before it is truly gone.
1b. **One Editor, or a panel?** — **Answered: it is a template setting, not an architecture decision.** Writer, Editor and Reader are harnesses containing agents, and the Author chooses how many of each exist; a single Editor role may run N agents inside one run and aggregate to one answer (`agents`, `aggregate`). The loop still receives exactly one report per decision, so there is no vote anywhere in the engine and D-34a (the Editor's call is final) survives. The one obligation: internal dissent is named in the `selection_note` and shown on the run (D-38, U-8d).
1c. **Can the Editor delegate a merge to a Writer?** — **Answered by the recommendation.** The Editor *requests* a merge (`requestMerge`) and the sweep dispatches a Writer; `delegate` (D-17e) and a role's own `agents` (D-38) are for reasoning inside the run, never for writing. The write monopoly stays with the Writer (P10).
1d. **What is a "unit" for divergence?** Chapters and plotlines are named. Are whole acts, the ending, or a single scene also units that get N attempts? Wider units give more value per comparison and much larger comparisons.
2. **Is the Goal per-Story, per-chapter, or both?** Recommended: per-Story with a per-chapter override (`bar_override`), so the ending can be held to a higher bar than chapter 3.
3. **One Writer per Story, or a Writer per phase?** — **Answered by D-38a: the Author's choice, no engine rule.** A structural Writer for ① and ② and a prose Writer for ③ is just two templates assigned to different phases (`serves_phase` already exists). Two voices on the same phase is also legal; style divergence between them surfaces as a `taste` finding rather than an error.
4. **Digest ownership** — **Answered: the loop engine builds it from committed changes, so the history is right.** The Writer monopoly is broken here on purpose: the agent that wrote chapter 9 must not be the one that summarises it, because every downstream run trusts the Digest without checking (D-12a). Crews may only file `digest_gap`; staleness still blocks a review and never a fix (D-14); and any past Digest is reconstructible, so the Author can see what a reviewer was actually told when it judged.
5. **Chapter ordering default** — **Answered: all chapters together** (L-8), with the dependency set repurposed as a propagation map (L-9, C-B). Still open: **how the Author sees that** — 8 chapters all `in_pass` at once is a wall of motion. Recommended: the Story view groups them by *what the crews are doing to them* (drafting / contested / awaiting a fix / clean) rather than listing them in order, because order is no longer what's happening.
5a. **What counts as "all agents agreed" for `completed`?** L-25 says hard criteria pass + no competing revisions + clean ledger + soft threshold. Is that enough, or must N independent fresh reviewers concur within the same round? The latter is far more robust and, with no cost constraint, affordable.
5b. **Does `pending` stop the whole Story or only the stuck unit?** — **Largely answered by the approval gate** (L-36): an unapproved finding, and by extension any single stuck chapter, leaves the Story `ready` and the crew working; only a Story whose *every* remaining blocker is the Author's to move goes `pending`. Still open for the genuinely stuck case: if chapters 6–9 are a contradiction the loop cannot resolve (L-21), should chapters 1–5 keep being polished, or is a Story with an unresolved contradiction in act two better left alone? Recommended: keep working the uninvolved chapters, and say so in `status_reason` — halting the whole book over one contradiction is how the crew goes idle while the Author is asleep.
6. **Escalation frequency dial:** per template, or per Story? Too chatty and it isn't autonomous; too silent and the Author loses the book they wanted.
7. **Recipe scope** — **Answered: out of the first build, and the engine is expected to change anyway.** "It is an evolving design. Even I'm not sure how this turns out yet — we build it out, test it in building, and then revise the engine." So templates carry v1, a recipe stays a named hole (§13), and the build constraint that follows is P15: a phase model, a role set, or a criterion has to be replaceable without rewriting the store.
8. **Vocabulary budget:** how much of "beats / promise / payoff / arc" is shown to the Author versus kept internal? Decides how much of §4 the UI exposes.
9. **Does Phase 1 get full divergence?** — **Answered: yes** (D-3d). Consequence nobody has priced: the Summary is the shortest artifact and the most-read one, so `attempts` on the phase-① Writer should be *higher* than a chapter's, not lower, and the Editor's `selection_rules` must contain tone guidance for phase ① specifically — the rules that pick between two chapter drafts do not pick between two premises.
10. **How many Readers, and what angles?** — *How many* is **answered: the Author's choice** (D-38a), and a single Reader role may itself be N agents (D-38). Still open is *which angles*, and that is template content rather than a build decision. Closed by recommendation: ship four built-in Reader templates, one per angle — **genre convention**, **plausibility and fact**, **what this Author's readers complain about**, **mystery and pacing** — because "the Reader" is not one judgment; it is four, and one Reader asked to do all four does two of them badly. The Editor's verification cost is the same either way (E-0).
11. **Backtrack granularity** — **Answered: granularity exists, but it rarely matters**, because all chapters are in flight together and a problem in chapter 12 already drags chapter 1 along with it (L-8a). So the practical distinction is not *which chapter* but *which phase*. Still open: should the Author be able to **unapprove one chapter** (keep its prose, reopen its review) without a phase backtrack? Recommended: yes, and it is a different verb from backtrack — it is the one case where a single chapter may legitimately be at a different vintage than its neighbours.
12. **Are discarded Ideas deleted?** — **Answered: within the phase, never; across a phase boundary, always** (D-28, D-32, D-36). The unbounded-growth problem I raised is solved at the source — the tray is emptied at the lock — so no relevance filter is needed.
12a. **The cross-Story taste record** — **Answered: no. Nothing survives a finished book.** "A book is finished means it finished." The recommendation of a per-Author `rejections` list is rejected: the next book is not smarter by machinery, and that is a choice, not an oversight. The cross-book channel that *is* planned, later, is the prequel: a sequel's phase ① crews get read access to the previous book (D-39) — which carries the story, not the taste, and is deferred rather than half-built.
13. **Web access specifics** — Partly answered: every role may browse (T-6b), and archiving is **not** needed (E-0c). Still open: **(a)** which provider and whether a failed search is a `digest_gap`-style signal or just a thinner Idea; **(b)** whether Readers may browse **fiction itself** — the risk is the crew imitating a live author instead of the Author (C-13), and the Author's answer is that instructions decide (D-30), which means someone must actually *write* that instruction into the built-in Reader templates or the risk is real by default.
14. **Is a phase lock allowed to be partial?** — Sharper now that all chapters run together: if phase ③ never waits for a per-chapter lock, "partial lock" only means anything in phases ① and ②. Recommended: no, still.
15. **How loud is a Reader in phase ③?** — **Answered by the cost enum plus the auto-approve switch** (T-11, D-35): `critical` and `major` flow through to a Writer automatically, `minor` and `taste` sit in the queue until the Author chooses, and completion discards whatever is left (L-25b). The dial exists. Still open: **whether `taste` findings should aggregate at all** — fifty separate "the prose felt flat here" entries are unreadable, while one line per chapter is not. Recommended: the Editor folds same-criterion `taste` findings into one entry per chapter as part of its rewrite (D-34), since it is already rewriting them for the Author's eye.
16. **Does the Editor's rewrite of a finding need the Author's trust?** — **Answered: yes, and that is what the Editor is for.** Its severity call is final and there is no per-item appeal (D-34a). The Author tunes the template when the triage is wrong, exactly as with prose taste (G-7).
17. **What if the Editor is systematically wrong about severity?** With no appeal step, the only symptom of an Editor that files every `critical` as a `minor` is a book that drains too early and reads thin. Recommended: the Story view shows the **cost distribution of the last N rounds** — how many findings the Editor confirmed at each cost, and how many it downgraded — so a pattern is visible without any per-item review. That is a number, not a queue, and it costs the Author one glance.

---

## 15. Vertical slice — the thing to build first

Prove the loop before building twelve panels. One Story, all three phases, in this order:

0. Author writes a **Seed** — three sentences — and `chapter_count` = 8. Every agent can read it; nobody can write it.
1. **Phase ①.** Sweep spawns two **Writers** (fresh, blind to each other) → each `editSummary` expands the Seed into premise / promise / theme / tone / ending. A **Reader** role with `web: true` files two Ideas ("this premise is the same as X; a colder framing reads as Y"), each with a cited source. An **Editor** `verifyIdea`s one `verified` and one `refuted`, and `selectRevision`s the better Summary expansion — the loser is deleted in the same commit. The `idea→summary` level reads `2/2`.
1a. The Ideas tray holds one `proposed` Idea. **Lock Summary** is disabled. The Author selects it, and only then locks. `summary_locked` = true, `phase` → `plotlines`, a Writer's next `editSummary` is refused naming P5, **and the tray is deleted in the lock commit** (D-36) — phase ② opens with an empty one.
2. **Phase ②.** Sweep spawns a **Writer** → reads the locked Summary and the Goal, creates exactly 8 plotlines via `createPlotline`. C-0 passes at 8 and fails at 7 or 9. A **Consistency checker** files findings (it cannot edit); the next sweep hands each finding to a fresh Writer, which edits. Goal reads `4/6 · failing: C-4, C-5`, then `6/6`.
2a. Readers propose plotline changes; the Author selects; the loop stops at `phase_signoff`; the Author **locks the plotlines** → `phase` → `chapters`.
3. **Phase ③.** All 8 chapters enter `in_pass` together (L-8). A **Writer** on chapter 1 → `createChapter` + `editChapter`; a **Review crew** (fresh) → verdict against C-7…C-9 + `raiseFinding`; a **Reader** reads the chapter as the Author would and files "this spends the mentor's mystery two chapters early" — which lands `unconfirmed` (D-33). The next sweep gives that finding to an **Editor**, who `verifyFinding`s it true, which spawns the task; a fresh **Writer** fixes it. Chapter `done` on Author accept — or with no Author action at all (L-35).
3a. **The false positive.** A second Reader claims chapter 3 contradicts chapter 7. The Editor checks and **disputes** it: no Writer pass is spent, and the disagreement is visible to the Author as a disputed finding rather than as work.
3b. **The cross-chapter fix.** A confirmed finding on chapter 12 says the locket was already sold in chapter 1. Both chapters go `needs_recheck` (L-8a, L-11a); the loop fixes chapter 1, because the plotline says the sale happens there. No Author action.
3c. **The gate.** The `major` finding auto-approves (D-35) and the Writer is on it within a sweep. A `minor` one the same Reader files sits `confirmed` in the queue, **spawning no work at all**, until the Author approves it or discards it (D-34). Flip the switch to include `minor` and the next one goes through by itself — that single toggle is the difference between steering phase ③ and watching it.
3d. **The schema.** A Reader files a finding with no `cost`; the tool refuses naming the field, and the run re-sends it triaged (T-11). It calls `describeTool` on `raiseFinding` first and gets the enum values back — the correction is a lookup, not a guess (T-6c).
3e. **The gap.** Give a Reader a brief that asks for something no tool reaches ("judge whether this chapter's length matches the genre norm" — there is no word-count surface). It files its finding anyway and calls `reportGap` naming what it needed and what it did instead. The gap appears on the Author's queue as a tool request, and the Story's `trend` is untouched (T-12).
4. Author hits **Stop** mid-chapter-2. Dispatch halts, the run dies, state is intact, restart resumes at chapter 2.
4b. **The Author writes.** Mid-phase-③, the Author decides chapter 6's opening is wrong and hits **Pause & edit**: dispatch halts, in-flight runs die, and the prose pane becomes editable (D-37). Attempting the same edit without pausing is refused naming D-37. They rewrite two paragraphs, hit **Resume**, and the pane tells them what that costs: the Digest re-derived from the edit (D-12a), the chapters that depend on those paragraphs marked `needs_recheck` (D-37a, L-11a). The span is now Author-written, so the next Writer may only `proposeChange` against it (P9, D-20) — and the crew does not try to undo what the Author typed (D-37b).
4a. **Backtrack.** On chapter 5 the Author decides act two is wrong and **backtracks to phase ②**. Chapters 1–5 and their revisions are gone; the plotlines are unlocked and editable; the verdicts and Ideas of the scrapped pass are still readable as history. Nothing in the store still references a chapter that no longer exists.

Then prove the two things that make this the product rather than a pipeline:

8. **Divergence.** Set `attempts: 3` on chapter 2 (after the backtrack, chapters are being written again). Three fresh Writers produce three drafts, invisible to each other. Checkers verdict each. An **Editor** applies the Author's `selection_rules`, picks draft 2, writes a `selection_note` naming why — and drafts 1 and 3 are **gone in the same commit**. A Writer dispatched to chapter 3 cannot find them.
8a. **A harness, not an agent.** Set that Editor role to `agents: 3`. Three editor agents read the same three drafts inside one run and the role returns **one** selection, one verdict set, one `selection_note` — the loop sees a single report, and the crew panel shows the three nested under the run (D-38, S-7). When two of them prefer draft 1, the note says so ("2 of 3 preferred draft 1; selected 2 on the `must_happen` rule") rather than hiding the split. No Work Item is created for any of them, and no vote appears anywhere in the engine.
9. **Going in circles.** Make C-4 deliberately unfixable: two plotlines that contradict, and the crews keep working around the contradiction instead of through it. After `flat_rounds`, the Story moves to **`pending` with `pending_kind: stalled`** — a reason naming chapters 6–9 and the finding that will not close. The sweep stops touching it. The Author unlocks the plotlines, settles the contradiction, re-locks, and the Story returns to `ready` by itself.
10. **The kinds of waiting.** Put three Stories in the same list: one awaiting a lock, one **drained**, one stalled. They must be distinguishable without reading text (U-1b, U-1c, L-34) — this is the screen the Author lives in, and the first two are both "the loop is finished with something" while the third is "the loop is stuck".
11. **Drained comes first.** With the dial on `critical` + `major`, keep running phase ③. Eventually a full pass finds no task, no `unconfirmed` finding, no `competing` revision, and a fresh round of Readers produces nothing at or above `major` — while 12 `minor` and 4 `taste` findings sit open in the queue. The Story goes **`pending` with `pending_kind: drained`** and dispatches nothing (L-37). The row says what stopped ("no critical or major left · 16 findings awaiting you") and offers exactly two moves (U-1c). Approving one `minor` finding returns it to `ready` and the crew moves within a sweep; leaving it alone keeps it drained.
11a. **Drained is not stuck.** Set `flat_rounds` low enough that this Story's flat signature would have tripped loop detection, and confirm it reads `drained` and not `stalled` (L-37a). Then raise the dial to `critical` only and watch the same Story drain sooner — the threshold that decides what counts as work is the same switch that decides when the crew stops (D-35b).
11b. **Completion is a decision, not an empty list.** Every hard criterion passes, the Story is drained, and 16 findings plus 9 Ideas are still open. The loop proposes `completed`, and the prompt states what accepting will discard (L-25, L-25b, U-14). The Author accepts; the book is done, the leftovers close with a count against them, and the sweep stops touching it. **If the loop refuses to propose completion because the list is not empty, the build is wrong** — "nothing left to criticise" is a bar no book clears. **If it proposes completion before the Story is drained, the build is wrong in the other direction**: the crew stopped while it still had authorised work.

If step 8 feels like the Author's taste being extended rather than replaced, and step 9 feels like a helpful pause rather than a failure, the topology is right and the rest is more stages. If the Editor's pick is wrong more than half the time, fix `selection_rules` before building anything else — **that text is the product**.
