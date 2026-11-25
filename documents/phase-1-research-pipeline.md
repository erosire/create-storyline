# Phase 1 — Research → Sampling → Screening → Refinement

**Status:** design proposal (not yet normative). `documents/specifications.md` remains the build
contract until this document is folded into §4, §5, §6, §7 and §8 and the tests below land.

**Read this first (2026-11-24).** The title names the LEGACY model. A Story created now runs
`summary_mode: 'groups'`: the research leg below is **exactly as written and still current**, and so is
the one-turn/no-tools structured transport — but steps 4–9 change unit. Sampling, screening,
deterministic selection and truncation are what a legacy `'sampling'` book still does; on a grouped
book the unit of work is a **phrase GROUP**, the sample becomes a `draft_groups` pass whose accepted
answer INSTALLS immediately, screening becomes a `review_groups` pass over the whole group vector, and
there is no selection step to run. §15's closing entry, **T4**, states the pipeline as it runs today,
and `documents/specifications.md` §17 is the normative version. Sections below that describe a round, a
winner, a wave or a plateau are the legacy book's rules — retained, not deleted, and still enforced for
`'sampling'` Stories.

**Scope:** Phase 1 (`summary`, the UI's "phrase 1") end to end, plus the parts of the whole design
that the new pipeline forces: a Researcher employee, a durable Knowledge collection, structured
one-turn sampling, a screening Critic mode, deterministic sample selection, and the refinement loop
that follows a deep review. Phase 2 and 3 keep the Reader and gain the Knowledge lookup.

---

## 1. The requested pipeline, restated

1. **The Author writes the Seed.** It is immutable (P5) — the Editor never edits it.
2. **An Editor structures the Seed.** It validates the Seed and writes a derived, machine-readable
   *Seed Brief* (logline, protagonist, want/need, obstacle, stakes, setting, world rules, promise,
   tone hints, constraints, open questions). The raw Seed stays `stories.idea`.
3. **A Researcher researches the story.** It searches the web, writes *Knowledge* entries with an
   importance level (`critical | high | normal | low`) and sources, and keeps them current.
4. **The prompt compiler builds the Writer's first prompt.** Seed Brief + `critical`/`high`
   Knowledge + (from round 2) the current revision and the open fix tasks. Stable, byte-identical
   prefix across samples so providers can serve it from prompt cache.
5. **The Writer samples.** N fresh threads, **no tools, one turn each**, each answering with a
   structured Summary object. Every answer becomes a `revisions` row (`origin: sampled`).
6. **Critics screen the samples.** One turn each, **no tools**, returning only `critical`/`high`
   issues as structured `IssueList`s. Each list is stored against its sample.
7. **The system picks the First Revision.** Fewest `critical`, then fewest `high`, then fewest
   total, then oldest sample. No quality score (P6).
8. **The First Revision gets the real review.** Critics with tools read it; the Editor verifies
   their findings (D-33); the Author/dial approves (D-34); tasks are queued.
9. **The refinement loop.** The compiler rebuilds the first prompt from the chosen revision + the
   open tasks; N new samples; one-turn screening; pick the least-issue sample; truncate the rest;
   deep review again. Repeat until the Goal passes and the Author locks.

The Reader stays in Phase 2 and 3. Phase 1's screening Critic is a **run mode of the existing
Critic employee**, not a Reader.

### 1.1 What this changes outside Phase 1

- **Knowledge is a pipeline-wide input.** The compiler is unit-agnostic: the Phase 2 Plotline
  Writer and the Phase 3 Chapter Writer prepend the same `critical`/`high` filter to their first
  prompt. The Researcher is assigned `ALL_PHASES` for that reason.
- **Sampling/screening is a unit-generic mechanism.** `sample_unit` names `{unit_kind, unit_ref}`;
  Phase 1 uses `summary`, and the same jobs can later drive plotline or chapter divergence without
  a second algorithm. The `sample_reviews` + selector + truncate pattern is the general form of
  today's `attempts`/`revisions` divergence.
- **The Seed Brief is an input, never the contract.** Phase 2/3 read the locked Summary (P5); the
  Seed Brief only informs prompts, and C-14 still measures against the raw Seed.
- **The Reader keeps its place** for consistency and prose (Phase 2/3), and the whole-Story pass
  is unchanged.

---

## 2. Decisions taken (and the rules they touch)

The request conflicts with four existing rules. The proposal follows the request and resolves each
conflict explicitly rather than silently.

| # | Conflict | Resolution |
| - | -------- | ---------- |
| 1 | P5: the Seed is "read-only for every agent, forever", but the Editor must "clean up" the Seed. | The Editor writes a **derived** `SeedBrief` record. The Seed itself is never written, and C-14 keeps measuring the Summary against the raw Seed. "Clean up and structure" is a projection, not an edit. |
| 2 | P10: only the Writer writes story artifacts; T-4/T-5: every write is a tool call with `why`. Sampling Writers call no tool at all. | The **engine** persists a sample from the run's validated structured answer, the same way it derives the Digest (D-12a's named exception). The Writer still authored it; the record is attributed to the run. Deep-review revisions still go through `editSummary`. |
| 3 | T-6a: every session holds the whole tool catalogue; the Writer must always answer in the tool protocol. | A run may be dispatched with `toolMode: 'none'` (single assistant turn, schema-constrained). This is an **execution mode**, not a permission change: the permission row and the catalogue stay uniform; the transport simply sends `tools: []`. |
| 4 | D-34: nothing reaches the Writer without the Author's approval. The requested loop compiles tasks automatically. | Keep the gate, but the Story's `auto_approve` dial (D-35) covers `critical`/`major`, so the phase-1 loop proceeds without a click. An Author who wants to gate every task clears the dial. |
| 5 | D-24: the Author can restore a losing draft; the request says truncate the losers. | Losers are hard-deleted in the selection commit (P13/D-22 as the request asks). A compact `sampling_history` line on the Story keeps the P11 audit (ids, issue counts, selected id) without keeping the prose. |

Two smaller decisions, made literally from the request:

- **"Writer doesn't need any tool."** The sampling run sends no tools and is capped at one assistant
  turn plus at most one schema-repair retry. It cannot call `editSummary`, `raiseFinding` or
  anything else.
- **"Critics … disable all tool."** The screening Critic is the same. Only the deep-review Critic
  gets the tool catalogue.

---

## 3. Records

All new records follow `shared/types.ts` conventions (`StoredRecord`, `RecordInit`, enum arrays).

### 3.1 `RoleKind` gains `researcher`

```ts
// src/shared/types.ts:100
export const ROLE_KINDS = ['writer', 'editor', 'critic', 'reader', 'researcher'] as const;
```

`researcher` is **Rank A** (`src/server/run/story-engine.ts:96`):

```ts
export const STORY_AGENT_RANKS: Record<RoleKind, AgentRank> = {
    writer: 'A', editor: 'A', critic: 'A', reader: 'A', researcher: 'A'
};
```

It owns a dispatched Work Item (V-2), reads everything, and writes only `knowledge`.

### 3.2 `knowledge` — the Researcher's artifact (new collection)

```ts
export const KNOWLEDGE_IMPORTANCE = ['critical', 'high', 'normal', 'low'] as const;
export type KnowledgeImportance = (typeof KNOWLEDGE_IMPORTANCE)[number];
// The request's "Important, High, Low" maps to this scale as critical → high → normal → low.
// `critical`/`high` reuse the existing triage words (`FINDING_COSTS`), so "the Writer gets
// Important and High only" is one filter: importance ∈ {critical, high}.

export const KNOWLEDGE_KINDS = ['fact', 'world_rule', 'tech', 'period', 'place', 'person', 'other'] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

export interface KnowledgeSource {
    url_or_title: string;
    claim: string;        // the specific claim this source supports (T-10)
    accessed_at: string;
}

export interface KnowledgeEntry extends StoredRecord {
    story_id: string;
    /** Phase the entry was gathered for. `undefined` = applies to the whole book. */
    phase?: StoryPhase;
    kind: KnowledgeKind;
    /** Normalised topic key — the dedupe key (one entry per topic + claim). */
    topic: string;
    claim: string;
    detail?: string;
    importance: KnowledgeImportance;
    sources: KnowledgeSource[];
    /** stable hash of (story, topic, normalised claim) — D-16's pattern, reused. */
    fingerprint: string;
    seen_count: number;
    /** The Researcher role name/run that last wrote it (P11). */
    author: string;
}
```

Registered in `COLLECTION_NAMES`, `CollectionRecords`, `COLLECTION_SINGULARS`, and `Store` as
`readonly knowledge: Collection<KnowledgeEntry>` (`src/server/store/store.ts:455-472`). No existing
collection is renamed or dropped.

`StoryKnowledge` (`src/server/knowledge/story-knowledge.ts`) mirrors these rows into the durable
directory as a `Research` article, so the Author's knowledge pane shows the same entries.

### 3.3 `seed_briefs` — the Editor's structured Seed (new collection)

```ts
export interface SeedBrief extends StoredRecord {
    story_id: string;
    /** Hash of `stories.idea` this brief was derived from. A Seed edit re-arms the structuring. */
    seed_hash: string;
    logline: string;
    protagonist: string;
    want: string;
    need?: string;
    obstacle: string;
    stakes: string;
    setting: string;
    world_rules: string[];
    promise: string;
    tone_hints?: string;
    constraints: string[];
    open_questions: string[];
    status: 'draft' | 'accepted';
    notes?: string;
}
```

One accepted brief per Story; a new `seed_hash` creates a new row and supersedes the old one in the
same commit. The Engine reads the accepted row; the raw Seed remains the C-14 reference.

### 3.4 `sample_reviews` — the screening Critic's one-turn answer (new collection)

```ts
export interface SampledIssue {
    severity: 'critical' | 'high';
    criterion: string;       // 'C-14', 'C-15', or 'seed' for a contract breach
    location: string;        // field name or section reference
    quote: string;           // exact excerpt (D-15's evidence rule, applied to a pre-finding)
    detail: string;
    fix_hint?: string;
}

export interface SampleReview extends StoredRecord {
    story_id: string;
    revision_ref: string;
    /** Critic role name/run that produced it. */
    critic: string;
    issues: SampledIssue[];
    /** false = the schema-repair retry still failed; the sample is judged, with an explicit error. */
    valid: boolean;
}
```

These are **not** `findings`: they do not enter the D-33/D-34 ladder and cannot block a Writer.
They exist to choose a sample and to seed the deep review's brief.

### 3.5 `revisions` additions

```ts
export interface Revision {
    // … existing fields …
    /** How this draft came into existence. */
    origin?: 'sampled' | 'refined';
    /** 1-based sampling round; 1 is the First Revision's round. */
    round?: number;
    /** Byte-stable hash of the compiled first prompt that produced it (cache key, audit). */
    prompt_hash?: string;
    /** Number of screening issues, denormalised for the selector and the dashboard. */
    issue_counts?: { critical: number; high: number };
}
```

No §4 field is renamed or dropped (the §4 preamble allows adding).

### 3.6 `stories` additions

```ts
export interface Story {
    // … existing fields …
    /** Which Phase-1 algorithm this Story runs. New Stories default to `research`. */
    pipeline?: 'classic' | 'research';
    /** P11 audit for truncated samples: ids, issue counts, selected id. One line per round. */
    sampling_history?: Array<{
        round: number;
        at: string;
        samples: Array<{ revision_id: string; critical: number; high: number; valid: boolean }>;
        selected: string;
    }>;
}
```

`pipeline: 'classic'` keeps today's behaviour for Stories written before the change, so the
migration is opt-in per existing Story and the default for new ones.

---

## 4. Structured output

### 4.1 What the story-generator does (the pattern to reuse)

`distribution/story-generator/src/server/endpoints/generations/story-utils.ts:45-53` calls a
client method that dispatches between tool-calling and native structured output:

```ts
export const callStructured = <T extends TSchema>(
    client: ReturnType<typeof createStoryClient>,
    config: { request: string; response: T; onUpdate?: (update: string) => Promise<void> }
) => (useApiMethod === 'format' ? client.format(config) : client.structure(config));
```

and the schema is TypeBox (`story-utils.ts:302-308`):

```ts
response: Type.Object({
    title: Type.String({ description: 'the title of the expanded chapter' }),
    content: Type.String({ description: 'the content of the expanded chapter' })
})
```

Streaming repair uses `jsonComplete` from `@presource/core`
(`packages/presource/core/src/json/complete.ts:31`).

### 4.2 What create-storyline adds

`create-storyline`'s transport is plain `fetch` to `chat/completions` and has no structured-output
concept (`src/server/llm/client.ts:54-59`, payload at `182-188`). Extend the pinned surface:

```ts
export interface ResponseFormat {
    name: string;
    schema: Record<string, unknown>;   // JSON Schema, produced from TypeBox
    strict?: boolean;                  // default true
}

export interface ChatRequest {
    model: string;
    messages: ChatMessage[];
    tools?: ToolSchema[];
    signal?: AbortSignal;
    /** Sampling knobs. No cap; E-0 still applies. */
    temperature?: number;
    seed?: number;
    responseFormat?: ResponseFormat;
}
```

Payload:

```ts
if (request.temperature !== undefined) body.temperature = request.temperature;
if (request.seed !== undefined) body.seed = request.seed;
if (request.responseFormat) {
    body.response_format = {
        type: 'json_schema',
        json_schema: {
            name: request.responseFormat.name,
            strict: request.responseFormat.strict ?? true,
            schema: request.responseFormat.schema
        }
    };
}
```

Capability negotiation, in this order:

1. `json_schema` (preferred).
2. If the provider rejects the field with a 4xx naming `response_format`/`json_schema`, retry once
   with `{ type: 'json_object' }` and keep the full schema in the prompt.
3. If that fails too, fail the run with an `LlmError` — never silently accept free prose.

Parsing: `parseStructuredContent(text, schema)` in `src/server/llm/structured.ts`:

1. `JSON.parse`.
2. On failure, `jsonComplete(text)` (vendored or imported from `@presource/core`).
3. Validate with TypeBox `Value.Check`; on failure return a typed `{ error, path }` for the repair
   retry.
4. Clip and log the raw answer on failure (the run row's `end_reason`).

Add `@sinclair/typebox` to `packages/erosire/create-storyline/package.json` (it is already used by
`distribution/story-generator`, so the workspace has it). `jsonComplete` comes from
`@presource/core` or a small local copy; either way it is not a new runtime service.

### 4.3 The two schemas

The grouped model keeps both — a legacy book still answers them, and `SampledIssue` gained an optional
`group_refs` so one wire shape covers both readers — and adds two siblings: `GroupDraftSchema` (one
`{group_ref, content}` per group in the batch, plus `knowledge_used`) and `GroupReviewSchema` (the same
issue list, every issue naming the groups it crosses). They are specified in `shared/phrase.ts` and
restated in §15's T4 entry and `specifications.md` §17.2.

```ts
// src/shared/schemas/summary-sample.ts
export const SummarySampleSchema = Type.Object(
    {
        premise: Type.String({ minLength: 1 }),
        promise: Type.String({ minLength: 1 }),
        theme: Type.String({ minLength: 1 }),
        tone: Type.String({ minLength: 1 }),
        ending: Type.String({ minLength: 1 }),
        world_rules: Type.String({ minLength: 1 }),
        /** Knowledge entry fingerprints the draft leaned on, for the audit and the next prompt. */
        knowledge_used: Type.Array(Type.String())
    },
    { additionalProperties: false }
);
```

`chapter_count` is deliberately absent: it is Author truth (D-3b) and the engine writes it once.

```ts
// src/shared/schemas/issue-list.ts
export const IssueListSchema = Type.Object(
    {
        issues: Type.Array(
            Type.Object(
                {
                    severity: Type.Union([Type.Literal('critical'), Type.Literal('high')]),
                    criterion: Type.String(),
                    location: Type.String(),
                    quote: Type.String({ minLength: 1 }),
                    detail: Type.String({ minLength: 1 }),
                    fix_hint: Type.Optional(Type.String())
                },
                { additionalProperties: false }
            )
        )
    },
    { additionalProperties: false }
);
```

`severity` is capped at `critical | high` by the schema, so "critical and high only" is enforced by
the transport, not by a prompt the model can forget (T-11's lesson).

---

## 5. Prompt compiler and prompt cache

`src/server/run/phase1-prompt.ts` (new) exports one pure function:

```ts
export interface CompileInput {
    story: Story;
    seedBrief: SeedBrief | undefined;
    knowledge: KnowledgeEntry[];      // filtered by importance and phase
    base?: SummarySnapshot;           // the chosen revision, from round 2
    tasks?: Task[];                   // open/confirmed fix tasks, from round 2
    round: number;
}

export interface CompiledPrompt {
    system: string;                   // role prompt + output contract + schema name
    user: string;                     // the first prompt
    hash: string;                     // sha256(system + '\n--\n' + user)
    knowledgeRefs: string[];          // fingerprints included
}

export function compilePhase1Prompt(input: CompileInput): CompiledPrompt;
```

Rules that make the cache work:

- **Deterministic ordering.** Knowledge sorted by `(importance rank, fingerprint)`; tasks by
  `(priority desc, id)`; no `Date.now()`, no run ids, no revision ids in the text.
- **Stable prefix.** `system` carries the Writer role prompt, the JSON contract and the tone
  contract. It is identical for every sample of a round. `user` starts with the Seed Brief, then
  the included Knowledge. Round 1 has no base revision; round N appends base + tasks.
- **Diversity without prefix churn.** Samples differ only by `temperature` (and `seed` where the
  provider supports it). The prompt text is byte-identical, so prefix caching survives.
- **Importance filter.** Only `critical` and `high` entries enter the prompt. `normal` and `low`
  stay readable through `readKnowledge` for the deep-review Critic, never in the sampling prefix.
- **Audit.** `prompt_hash` lands on every `Revision` row and the Run row's `brief_hash`, so the
  Author can prove two samples shared a prefix.

Prompt shape (abridged):

```
SYSTEM
You are the Writer for phase ① of one Story. Answer with one JSON object matching
SummarySample. You have no tools in this run. …

USER
## SEED BRIEF (structured from the Author's Seed — the Seed itself is law, P5)
logline: …
protagonist: … / want: … / obstacle: … / stakes: …
world_rules:
- …
promise: …
constraints:
- …

## KNOWLEDGE — critical and high only
[K-… · critical · period] 1880 revolvers hold six rounds. (source: …)
[K-… · high · place] The harbour freezes in January. (source: …)

## BASE REVISION (round N only)
premise: …
…

## FIX TASKS (round N only — every one must be visible in the new draft)
[T-… priority 30] the ending does not pay the promise … evidence: …
```

The JSON output contract is repeated in `system` (not in `user`) so the cacheable prefix never
mentions a round number.

---

## 6. Loop mechanics

**On a grouped book (2026-11-24) §6.1–§6.8 below are the LEGACY half of this section** — they are still
enforced for a `summary_mode: 'sampling'` Story, and nothing in them was deleted. The grouped job kinds,
claim keys, batch math, install commit and per-group attempt budget are §15's **T4** entry, with the
normative statement in `documents/specifications.md` §17. What did NOT change is the part this document
was really about: the research jobs and their claim keys (§6.1's `wi_research_seed_<seedHash>` /
`wi_research_<questionHash>`), the D-40/D-51 gates, `toolMode: 'none'` and its structured transport
(§4.2), the citation and evidence rules, and the Author's dial deciding what becomes a task.

### 6.1 New Work Item kinds

Add to `src/server/run/types.ts:26-38`:

```ts
export const WORK_ITEM_KINDS = [
    'seed_review',          // legacy
    'structure_seed',       // new: Editor → SeedBrief
    'research',             // new: Researcher → Knowledge
    'sample_unit',          // new: Writer, one turn, structured
    'screen_samples',       // new: Critic, one turn, structured
    'choose_sample',        // new: engine-side, no model call (kept as a job for the audit trail)
    'write_unit',
    'check_unit',
    'select',
    'verify_findings',
    'confirm_finding',
    'verify_ideas',
    'merge',
    'whole_story_check',
    'directive_work',
    'assistant'
] as const;
```

`choose_sample` is not a model run; it is a deterministic settlement step recorded as a job so the
sweep report and the dashboard can show why a sample won. It is listed here so the job vocabulary
is one list (P15).

### 6.2 WorkItem additions

```ts
export interface WorkItem {
    // … existing fields …
    /** 'tools' (default) or 'none' — the single-turn sampling/screening mode. */
    toolMode?: 'tools' | 'none';
    /** Structured-output contract for a no-tool run. */
    responseSchema?: { name: string; schema: Record<string, unknown> };
    /** Which sample index this job produces (0-based); the run reads it from the item. */
    sampleIndex?: number;
}
```

### 6.3 RunResult additions

```ts
export interface RunResult {
    // … existing …
    /** The validated JSON answer of a structured run (`toolMode: 'none'`), or undefined. */
    structured?: unknown;
    /** Byte-stable prompt hash, copied onto the revision. */
    prompt_hash?: string;
    /** Cache accounting, informational only (E-0). */
    usage?: { input: number; output: number; cached_input: number };
}
```

### 6.4 Dispatch order (Phase 1, `pipeline: 'research'`)

Replace the `seed_review` block in `src/server/loop/work.ts:630-653` with:

1. **`structure_seed`** — priority 0, one per `seed_hash`.
   Claim: `wi_structure_seed_<hash>`. Refuses `sample_unit` until an `accepted` SeedBrief exists.
2. **`research`** — priority 0, one per accepted SeedBrief revision (`wi_research_<brief.rev>`).
   Refuses sampling until it closes. A `knowledge_gap` finding re-arms it.
3. **`sample_unit` × `summary_sampling`** — priority 2, one per sample:
   `wi_sample_<unit>_<round>_<i>`. Each carries `toolMode: 'none'`,
   `responseSchema: SummarySample`, `sampleIndex: i-1`.
4. **`screen_samples` × `summary_critics` per sample** — priority 2 (same class, ordered after its
   sample), claim `wi_screen_<revision>_<pass>`, `toolMode: 'none'`,
   `responseSchema: IssueList`. A screening job is generated only once its sample exists and its
   Writer run is closed.
5. **`choose_sample`** — priority 1, generated when every sample of the round has every screening
   pass closed (`sample_reviews` count = `summary_sampling × summary_critics`). Engine-side
   selection; writes the selected revision, `issue_counts`, `sampling_history`, and deletes the
   losers.
6. **Deep review** — the existing `check_unit` Critic passes (tools on) against the selected
   revision, the existing `verify_findings` Editor jobs, the existing `confirm_finding` Critic
   jobs. Unchanged code paths, new target: the selected revision.
7. **Fix tasks → next round** — when every confirmed/approved `critical`/`major` finding has a fix
   task and no unconfirmed finding remains, the next round is armed:
   `wi_sample_<unit>_<round+1>_<i>` for `i = 1…N`, with the compiled base + tasks.

Round 1 is the only round whose samples are `origin: 'sampled'`; every later round is
`origin: 'refined'`. The First Revision is simply the round-1 winner.

### 6.5 Selection (deterministic, no model call)

`src/server/loop/sample-select.ts`:

```ts
export interface ScoredSample {
    revision: Revision;
    critical: number;
    high: number;
    total: number;
    valid: boolean;
    index: number;
}

/** Fewest critical, then fewest high, then fewest total, then the earliest sample. */
export function selectSample(samples: ScoredSample[]): ScoredSample | undefined;
```

There is no numeric quality score (P6). A sample whose screening failed schema validation is
`valid: false`; if every sample is invalid, the round is re-armed with a `requestAuthor` escalation
rather than accepting an unjudged draft.

### 6.6 Truncation

In the `choose_sample` commit:

- set the winner `state: 'selected'` and install its body into the Summary;
- delete every other `Revision` and its `SampleReview` rows;
- append the `sampling_history` line (ids + counts + selected id) before deleting, so P11 keeps the
  audit;
- bump the Summary `rev` in the same commit (T-4).

This is a hard truncate as requested. It replaces D-22's "Summary keeps discarded history"; the
`sampling_history` line is the replacement audit trail.

### 6.7 Status and drain

`drainPreconditions` (`src/server/loop/status.ts:134-171`) gains four unmet reasons:

- no accepted `SeedBrief`;
- no closed `research` run for the current brief;
- samples still being written (`sample_unit` live or owed);
- screening passes still owed for a written sample.

`phase_signoff` is not offered while any of those hold. The drain probe still runs (L-37), but in
this pipeline its Critic half is a tool-using Critic and its Reader half is unchanged — Phase 1's
screening is a separate, cheap pass.

**Update for the grouped book (2026-11-24 hardening).** The four reasons above are the `'sampling'`
branch. A `summary_mode: 'groups'` Story answers from `phrase/exclusion.ts:groupPipelineOwed` instead —
group-pipeline runs in flight, groups owing the Overview a draft or a fix pass, Critic passes owed on the
installed vector, deep-review passes owed for it — and the sign-off offer is withheld over the same read,
so the probe and the work queue cannot disagree (`specifications.md` §17.8, pinned by
`loop/phase1-groups-drain.test.ts`). The Seed Brief and research reasons are shared by both branches.

### 6.8 The refinement loop, precisely

```
round 1:  samples(seedBrief, knowledge)         → screen → choose  → First Revision
          deep review (Critics + Editor + dial) → fix tasks
round N:  samples(baseRevision, knowledge, tasks) → screen → choose → Revision N
          deep review … → fix tasks
stop when: Goal passes AND no critical/high open AND no task queued → phase_signoff
```

Every round recompiles the prompt from committed records (P1/P3). A killed run loses nothing but
its own uncommitted sample (P2). The Deep review's findings are the only items that ever reach a
Writer (D-34), so screening issues cannot spend a Writer round.

---

## 7. Employees, tools and permissions

### 7.1 New tools

| tool | kind | args | writes | notes |
| ---- | ---- | ---- | ------ | ----- |
| `structureSeed` | editor | `seed_hash, logline, protagonist, want, need?, obstacle, stakes, setting, world_rules[], promise, tone_hints?, constraints[], open_questions[], why` | `seed_briefs` | Refuses if `seed_hash` ≠ the current Seed. An accepted brief supersedes the previous one. |
| `writeKnowledge` | researcher | `topic, kind, claim, detail?, importance, sources[], phase?, why` | `knowledge` | Deduped by fingerprint (D-16 pattern); a repeat bumps `seen_count` and refreshes sources. |
| `readKnowledge` | every kind | `importance?, phase?, kind?, topic?` | — | The sampling compiler uses the same filter server-side; the tool is for the deep-review Critic and the Editor. |
| `retireKnowledge` | researcher | `knowledge_id, expects, why` | `knowledge` | Mark a stale entry `low`/`retired` instead of deleting it (audit). |
| `submitSample` | — (engine) | — | — | Not a tool: the sampling Writer has no tools. The engine persists the validated answer. |
| `reportSampleIssues` | — (engine) | — | — | Not a tool: the screening Critic's answer is persisted by the engine. |

`structureSeed` and `writeKnowledge` carry `why` and `expects` like every other mutating tool (T-4,
T-5, T-11). The no-tool runs carry no tool calls at all; their `why` is synthesised from the job
line and the prompt hash, exactly as `submitVerdict` synthesises its optional `why`
(`src/server/tools/reader.ts:251-253`).

### 7.2 Permission matrix

`src/server/tools/permissions.ts` transcribes §7 with one column per dispatched kind. Add
`researcher` to `PermissionRow` (`permissions.ts:16-41`) and to every row:

| artifact | writer | editor | reader | critic | **researcher** | rule |
| -------- | ------ | ------ | ------- | ------ | -------------- | ---- |
| Seed | read | read | read | read | **read** | P5 |
| summaries / plotlines / chapters / revisions / cast / ledger / digests | as today | as today | as today | as today | **read** | P10 |
| ideas | read | verify | write | write | **read** | D-26 |
| knowledge | read | read | read | read | **write** | new |
| seed_briefs | read | write | read | read | **read** | new |
| sample_reviews | read | read | read | read | **read** | new |
| tasks / verdicts / findings | as today | as today | as today | as today | **write** (tasks only) | D-11 |
| goals / stories / templates | read | read | read | read | **read** | G-4 |

The Researcher may file a `fix`/`research` task (`createTask`) but may not raise findings about
prose; its output is Knowledge. `refusal_rules` for a Researcher writing a story artifact name
**P10**, the same as a Reader/Critic.

### 7.3 Employee roster surfaces

- `STORY_AGENT_CATALOGUE` (`src/server/run/story-engine.ts:338-360`): add
  `{ kind: 'researcher', title: 'Researcher', description: 'Searches the web, keeps the Story knowledge current, and never writes the book.' }`.
- `STORY_AGENT_KINDS` (`story-engine.ts:65`) gains `researcher`.
- Swagger `RoleKind` enum (`src/storyline-server.swagger.yaml:1434`): add `researcher`.
- `GET /agents` and `PATCH /agents/:kind` are kind-generic; only their tests need the fifth row.
- Dashboard `AgentsPanel`/`shell-fakes.tsx:161-162` gain a Researcher tile; the tile shows
  `knowledge` write activity, not a Story artifact.

---

## 8. Templates (the prompts)

Add to `src/server/templates/templates.ts`:

1. **`editor-seed-structure`** — kind `editor`, `serves_phase: ['summary']`, `attempts: 1`.
   Prompt: validate the Seed against the structural checklist; write `structureSeed`; where the Seed
   is silent, write `open_questions` and do not invent a fact; `requestAuthor` only when the Seed
   contradicts itself. Done definition: an `accepted` `SeedBrief` whose `seed_hash` matches the
   current Seed, with every non-optional field present.
2. **`researcher-story`** — kind `researcher`, `serves_phase: ALL_PHASES`, `attempts: 1`,
   `web: true`. Prompt: read the Seed Brief and the current Summary/plotlines; research the period,
   place, technology and facts the story depends on; write one `writeKnowledge` per claim with a
   source and an importance that means something (`critical` = the book contradicts the world if
   ignored; `high` = a reader would notice; `normal`/`low` = useful colour). Never write story
   artifacts. Done definition: the facts the Seed Brief's `world_rules` and the promised setting
   depend on are covered, every `critical`/`high` entry cites a source, and no entry duplicates an
   open one.
3. **`writer-summary-sampler`** — kind `writer`, `serves_phase: ['summary']`, `attempts: 1`,
   `web: false`. Prompt: you have no tools; answer once with the `SummarySample` JSON; the Seed
   Brief and the `critical`/`high` Knowledge are the contract; contradict nothing in the Seed
   (C-14); do not invent facts the Knowledge does not support; this is one of N independent samples,
   commit to a framing (L-16). The Seed and its Brief commit what they **state**: where they are
   silent, or a question sits in `open_questions`, the Writer supplies any specific that contradicts
   nothing — a place, a consequence, a stake, a custom. That licence is engine-owned text
   (`run/phase1-prompt.ts:SEED_CONTRACT_NOTE`), appended to the SEED BRIEF section of the compiled
   prompt, because the role prompt above it is an Author-editable copy (§8, §4.12). A required brief
   field the Seed leaves silent renders as an explicit **open** marker rather than a blank, so the
   model cannot read a silence as an unpaid promise. Done definition: a schema-valid `SummarySample`.
4. **`critic-screening`** — kind `critic`, `serves_phase: ['summary']`, `attempts: 1`, `web: false`.
   Prompt: you have no tools; answer once with `IssueList`; report only `critical` and `high`
   problems; a `critical` is a contradiction with the Seed Brief or a `critical` Knowledge entry, a
   `high` leaves unpaid a commitment the Seed Brief states **explicitly**; the Seed is general and is
   not an outline, so an added detail, a Seed question left open, a stake the Seed never stated and
   setup the Summary did not promise are not issues and never a `C-14` issue — what stays reportable is
   a contradiction and a central commitment the draft plainly does not carry; wording is phase ③'s
   business (`minor`/`taste`, never ranked at this level — and by D-33b a `taste` row is a `kind:
   proposal`, never an `issue`, since "merely a preference" is exactly what a Proposal claims to be); quote the offending field verbatim; return
   `{"issues":[]}` when the draft holds. Done definition: a schema-valid `IssueList`.
5. **`critic-deep-review`** — the existing critic templates (`critic-genre` etc.) reused with the
   current tool catalogue, pointed at the selected revision. Each angle prompt carries a
   `When the artifact under review is a SUMMARY (phase ①)` clause that stands the setup-and-payoff
   complaints down at ① and says in the same breath that phases ② and ③ keep them. The engine states
   the same rule where the Author cannot edit it away: the review banner
   (`run/brief.ts:CRITIC_REVIEW_MODE`) and that file's `check_unit` job line carry the admissibility
   test — quote the contradiction, or the finding is not admissible — because the sweep's note is
   clipped at 600 characters (`run/brief.ts:renderJob`) and those two are not.
6. **`editor-general`** — unchanged, but its prompt gains two paragraphs: in Phase 1 it verifies the
   deep-review findings against the selected revision, and the screening issues have already chosen the
   draft and are not re-litigated; and admissibility comes before accuracy — a finding whose whole case
   is an ABSENCE is an invalid finding and gets `disputed`, however true the silence is (the same test
   is in the engine's `verify_findings` and `confirm_finding` job lines).

`DEFAULT_ASSIGNMENT` gains `editor-seed-structure` and `researcher-story`; the writer-summary
assignment switches from `writer-summary` to `writer-summary-sampler` for new Stories.
`writer-summary` stays in the catalogue for `pipeline: 'classic'`.

---

## 9. Criteria

Phase 1's Goal level stays `summary: ['C-14', 'C-15']` (`src/shared/criteria.ts:216`). Two additions,
both optional and both `code` so a model cannot grade itself:

- **C-16 (new, soft): "every `critical` Knowledge entry the Seed Brief depends on is cited in the
  Summary's `world_rules` or premise."** Reads `knowledge` + `seed_briefs` + `summaries`; mechanical.
- **C-17 (new, soft): "the selected revision is the round's least-issue valid sample."** Reads
  `sampling_history` + `sample_reviews`; mechanical. It makes the selection auditable without
  turning it into a score.

If the Author does not want new criteria, both can be left out; the pipeline does not depend on
them.

---

## 10. API and dashboard

**Grouped addition (2026-11-24):** the surface above is what a legacy book reads. A grouped Story's
surface is one read — `GET /stories/:id/phrases` — carrying the mode, the composed Overview, the five
groups with their own revision numbers, history COUNTS and live holds, the findings with their
`group_refs`, the tasks, and the review block (the vector hash, the seats reported against it, and the
mirror state). `GET /stories/:id`'s `sampling` projection stays exactly as described below and remains
the legacy book's audit; on a grouped Story it reports the loop's own round number (`sampling_round ??
1`) over an EMPTY `history` with no wave recorded, because no grouped job touches those counters. The
Author's three grouped verbs and their refusals are §17.9 of `specifications.md`.

- `GET /stories/:id/knowledge` already exists; extend the projection with `importance`, `sources`
  and the entry ids so the pane can filter. The `knowledge` tool read path is unchanged.
- `GET /stories/:id` projection gains `seed_brief` (accepted row, read-only) and `sampling`
  (current round, samples, issue counts, selected id).
- `GET /agents` gains the Researcher row.
- Swagger: `RoleKind` + the two new schemas (`KnowledgeEntry`, `SampleReview`) + the revision
  additions.
- Dashboard:
  - the Stories panel's phrase rail shows `Research` between the Seed and the Summary;
  - the Knowledge pane renders importance badges and sources;
  - the revision comparison (U-13) shows `critical/high` counts per sample and which one the system
    chose;
  - a `Pipeline` badge on the Story view says `classic` or `research`.

---

## 11. Migration and rollout

1. **New collections are additive.** `COLLECTION_NAMES` grows; every snapshot reader uses the
   registry (`store.ts:509`), so old stores load with empty collections.
2. **`pipeline` defaults to `research` for new Stories, `classic` for existing ones.** `createStory`
   writes it from the template assignment; `PATCH /stories/:id` may switch it only while the Story
   is stopped (D-37), because a mid-phase switch would leave half a round in flight.
3. **Model capability.** A provider without `response_format` degrades to `json_object`; a provider
   without that fails the sampling run with a clear `end_reason`. The Story does not silently fall
   back to free prose.
4. **Prompt cache.** Providers that support prefix caching get the benefit automatically; providers
   that do not still work. `usage.cached_input` is informational only (E-0).
5. **No §4 renames or drops.** All additions are optional fields or new collections.

---

## 12. Implementation plan (ordered, each step shippable)

| Step | Files | What lands |
| ---- | ----- | ---------- |
| 1 | `src/shared/types.ts`, `src/server/store/store.ts` | `researcher` kind, `knowledge` / `seed_briefs` / `sample_reviews` collections, revision/story additions. Update `shared/types.test.ts` (the ROLE_KINDS assertion at `types.test.ts:58`). |
| 2 | `src/server/tools/permissions.ts`, `src/server/run/story-engine.ts`, `src/storyline-server.swagger.yaml` | Researcher column in every permission row; rank A; catalogue entry; swagger enum. |
| 3 | `src/server/tools/knowledge.ts`, `src/server/tools/registry.ts`, `src/server/tools/types.ts` | `writeKnowledge`, `readKnowledge`, `retireKnowledge`, `structureSeed`; the registry's group list. |
| 4 | `src/server/run/brief.ts` | Render the Seed Brief, the filtered Knowledge, the base revision and the fix tasks; a `toolMode: 'none'` banner; keep the prefix deterministic. |
| 5 | `src/server/llm/client.ts`, `src/server/llm/structured.ts`, `package.json` | `response_format`, `temperature`, `seed`; TypeBox + `jsonComplete`; `parseStructuredContent`. |
| 6 | `src/server/run/executor.ts`, `src/server/run/loop.ts` | One-turn mode: one model call, no tools, schema validation, one repair retry; `RunResult.structured` / `prompt_hash` / `usage`. |
| 7 | `src/server/run/phase1-prompt.ts` | The compiler, the filter, the byte-stable hash. Unit tests for determinism. |
| 8 | `src/server/loop/work.ts`, `src/server/loop/records.ts` | `structure_seed`, `research`, `sample_unit`, `screen_samples`, `choose_sample`; gates; claim keys; status preconditions. |
| 9 | `src/server/loop/engine.ts` | `settleJob` for the new kinds: persist a revision, a `SampleReview`, run the selector, truncate, append `sampling_history`, arm the next round. |
| 10 | `src/server/templates/templates.ts` | The five templates and the new default assignment. |
| 11 | `src/server/api/*`, `src/dashboard/*`, `src/storyline-server.swagger.yaml` | Projections, routes, Researcher tile, Knowledge pane, sampling view. |
| 12 | `src/server/loop/*.test.ts`, `src/server/integration/*.test.ts` | The tests below; retire the classic summary-pipeline assertions behind `pipeline: 'classic'`. |

Each step is independently testable; steps 1–7 do not change Phase 1's behaviour, so the existing
suite stays green while the new path is built.

---

## 13. Test plan

**The plan below is the legacy plan and it still runs** — every case in it is a `'sampling'` book's
behaviour, and every file it names still exists. The grouped cases are a SEPARATE suite that this
document does not enumerate: `src/server/phrase/{catalog,revisions,exclusion,findings}.test.ts`,
`src/server/loop/phase1-groups.test.ts`, `src/server/loop/phase1-groups-restart.test.ts`,
`src/server/api/phrase-routes.test.ts`, `src/server/integration/summary-groups.test.ts`,
`src/server/tools/reader-group-attribution.test.ts`, and the dashboard's `*.groups.*` / `*.phrases.*`
files. The 2026-11-24 hardening of the grouped server edges adds five more, and they pin the behaviour
§15's T4 entry now states as current: `src/server/loop/phase1-groups-drain.test.ts` (the drain and the
sign-off read the group pipeline, key-for-key with the generator), `src/server/loop/group-seed-reset.test.ts`
(the Seed edit resets the group rows in place; the backtrack keeps the texts and drops the history),
`src/server/loop/group-findings-batch-cap.test.ts` (three groups under a batch of one, a late approval,
and the vacuous legacy read that must not close anything), `src/server/api/story-delete.test.ts` (the
delete commit purges the three Phrase collections), and `src/server/tools/group-mode-writes.test.ts`
(the tool-layer refusals and the exact `fix` copy each one hands the crew, with the legacy book's
unchanged advice pinned beside them). `specifications.md` §17.13 lists the focused commands.

**Unit**

- `shared/schemas/*.test.ts` — both schemas reject extra fields, empty quotes, unknown severities.
- `run/phase1-prompt.test.ts` — same inputs produce the same `hash`; a round number never enters
  the system prefix; `normal`/`low` knowledge is excluded; task order is stable.
- `loop/sample-select.test.ts` — critical beats high; high beats total; ties pick the earliest;
  invalid samples never win unless every sample is invalid.
- `llm/structured.test.ts` — `json_schema` → `json_object` fallback; truncated JSON repaired;
  validation error carries a path.

**Loop**

- `loop/phase1-research.test.ts` — Seed → SeedBrief → Research → 3 samples → 15 screening passes
  → winner installed → losers gone → `sampling_history` written.
- `loop/phase1-refine.test.ts` — a confirmed finding produces a fix task; round 2's prompt contains
  the task; round 2 truncates round 1's winner; the loop stops at the Goal.
- `loop/phase1-tools-off.test.ts` — a `toolMode: 'none'` run receives no tool schemas and a tool call
  is impossible/ignored; a malformed answer gets exactly one repair retry.
- `loop/restart.test.ts` — a restart mid-round resumes from `revisions` + `sample_reviews`, not
  from memory.

**API / integration**

- `api/knowledge-route.test.ts` — the projection carries importance and sources.
- `api/agents-route.test.ts` — five rows, alphabetically: Reader, Critic, Editor, Researcher,
  Writer.
- `integration/slice-phases.test.ts` — the first phase under `pipeline: 'research'` end to end;
  the classic path remains covered under `pipeline: 'classic'`.

**Update in place**

- `shared/types.test.ts:58` (ROLE_KINDS), `run/brief.test.ts` (new sections), `tools/runtime.test.ts`
  (permission columns), `dashboard/shell-binding.test.ts` and `AgentsPanel.test.tsx` (fifth tile),
  `api/routes.test.ts` (a researcher template with no prompt is still refused by validation),
  `story-engine.test.ts` (ranks and catalogue).

---

## 14. Risks and open edges

- **Provider support for `response_format`.** Mitigated by the two-step negotiation and a clear run
  failure; no silent prose.
- **Prompt cache is a provider feature.** The design only guarantees a byte-stable prefix; it does
  not promise a discount. `usage.cached_input` is recorded to prove the hit.
- **A schema-valid but empty sample.** `SummarySample` requires every field non-empty; the engine
  additionally runs `missingSummaryBlocksOf` and re-arms the sample rather than installing an
  incomplete Summary (§4.15).
- **Hard truncation loses D-24's restore.** Accepted per the request; `sampling_history` keeps the
  audit. If the Author wants restore back, keep the prose in `sampling_history` behind a flag.
- **Researcher cost.** E-0 keeps cost out of scope; the Researcher can be capped only by the
  Author's `max_concurrent` template setting, never by a token budget.
- **The Reader is unchanged** in Phase 1: it is still skipped (`work.ts:906-908`). The screening
  Critic is a Critic mode, not a Reader return. **(Amended 2026-11-25 for the grouped model, D-65:** a
  `groups`-mode Story — every Story created since 2026-11-24, so not the model this document describes —
  runs exactly ONE Reader pass per group vector, `score_sections`, and it is a display pass, not a
  review: no finding, no task, no verdict, and no gate that waits on it. The legacy `'sampling'` ladder
  this section documents still skips the Reader completely, and `specifications.md` §17.14 is the
  normative text for the exception.)
  **(Amended again the same day, D-67:** the pass no longer runs per group VECTOR. It arms on the
  **reviewed Overview** — the newest CLEAN revision of every group, where Clean means a deep cross-group
  Critic pass over that combination closed with no unresolved defect on the group — and its claim key is
  the hash of THAT selection, so an install that leaves a defect on the newest text buys no Reader, the
  seat re-arms when the reviewed Overview advances, and a refusal re-arms up to
  `SECTION_SCORE_ATTEMPT_CAP` (2) rather than stranding a clean Summary. The text the Reader is shown,
  the text it scores and the `vector_hash` on the rows are the same bytes by construction, and the Reader
  answers on the compiled reviewed Overview rather than on whatever the five `latest` rows happen to say.
  `specifications.md` §17.16 is the normative text; `phrase/reviewed.ts` is the rule, and
  `phrase/reviewed.test.ts` the pin. The Author can then TAKE that Overview — `specifications.md`
  §17.17, D-68 — which changes the live book but still nothing in this ladder's math.)

---

## 15. As-built deviations (2026-11-23)

What the shipped package actually does where this document's plan differs. The body above is left as
written; this appendix is the truthful as-built record (pinned by the tests named in §13 and by
`src/server/loop/phase1-gates.test.ts`).

- **Selection is an engine settlement, not a Work Item.** There is no `choose_sample` job (nor a phase-①
  `select`): `engine.ts:trySelectSample` runs after every sample/screen settlement and once per sweep.
  §6.6's ranking and its one commit are unchanged.
- **No `pipeline` flag.** Phase ① is always the research pipeline; no Story needs a migration and no
  classic phase-① path remains (`writer-summary` is not in the catalogue, `seed_review` became
  `structure_seed`).
- **Plain JSON Schema, not TypeBox.** `src/shared/schemas/` holds object literals; the client asks for
  `json_schema`, downgrades once to `json_object` if the provider rejects the field, and the executor
  allows exactly ONE schema-repair retry. The client is non-streaming, so there is no streaming repair.
- **`SampleReview.valid: false` is never written.** A screening answer that fails validation twice
  fails the run and persists NOTHING; the attempt counter (not the row count) buys the next try, and
  every stored review is `valid: true`. §3.4's column stays for readers of the record.
- **`sampleIndex` is 1-based** and is the transport `seed` — the round's only diversity knob.
- **Samples are seeded, not temperatured.** No `temperature` is sent; the prompt is byte-identical
  across samples of a round and the seed is what differs (§5).
- **`GET /agents` is alphabetical** — Critic, Editor, Reader, Researcher, Writer — because the route
  sorts the harness projection (whose catalogue order appends the Researcher last). `PATCH /agents/:kind`
  answers the same sorted projection.
- **The Researcher writes `knowledge` and `tasks` only.** Its `proposals` cell is `read` (§7.2 as
  corrected by T12/F2): a §4.16 proposal is an opinion about a story artifact, which the Researcher does
  not make.
- **Deleting a Story deletes the three new collections in the same commit** (`seed_briefs`, `knowledge`,
  `sample_reviews`) — §11.1's "every story-scoped row" includes them (T12/A). The knowledge FILES are
  the route's projection deletion.
- **A backtrack / `editSeed` deletes the screening reviews of the revisions it scraps** (T12/B): a
  `sample_reviews` row is scoped to its `revision_ref`, so an orphan is not provenance. The kept
  revision's reviews survive; the selection commit's truncation of the losers' reviews is unchanged.
- **The attempt caps have two real recovery paths (§16.5, D-50).** Sampling exhausts into an
  `escalation` whose `detail` records its `wave`; clearing it bumps `stories.sampling_wave` and re-arms
  the round under `wi_sample_<summary>_<round>_w<wave>_<attempt>`. Screening exhausts into a
  degrade: a draft whose attempts are spent counts as screened, the round selects on the partial set,
  and ONE `Phase ① screening incomplete in round <n>` escalation reports it.
- **Selection waits for the owed samples.** A round fires only when its full `summary_sampling` set
  exists OR its sampling attempts reached the cap (T12/D) — the early-selection bug an independent
  review found is gone.
- **The research leg is the Editor's decision, not a heuristic (D-51, 2026-11-23).** §6.4's step 2 read
  as an unconditional stage; as built, `structureSeed` REQUIRES a `research_questions` array (T-11 when
  the arg is omitted) and `[]` WAIVES the pass: `loop/records.ts:researchGate()` returns `'waived'` and
  §6.4's step 3 proceeds with the pass never existing: no `wi_research_<brief.rev>` Work Item, no run
  row, and the §6.7 drain reason at `loop/status.ts` ("the Seed Brief has no closed research pass")
  never fires for that Story. There is no research row in the status payload or the dashboard that a
  waiver would hide or show — what it changes is the queue and the drain reason, nothing else. A
  non-empty list keeps §6.4's ordering and is carried verbatim in
  the Work candidate's `note`, so the Researcher answers the questions the Editor wrote rather than a
  guess. A stored brief with no field — a row written before it existed — keeps the gate (`needed`):
  absence is never a waiver. The same predicate closes gate 2 and satisfies the §9 drain clause, so there
  is one rule, not three. `research_questions` is an optional property on `SeedBriefStructure`
  (§3.2's record) precisely so an older row still parses.
- **A dispatched pass that finds nothing answers with a report, not silence (D-51).** `reportNoResearch`
  (researcher-only, one required `rationale`, ZERO writes — no Knowledge row, no task, no invented fact,
  P7) is the fifth tool of the §8.7 knowledge group. It is classified as a READ tool
  (`run/catalogue.ts:READ_TOOLS`)
  *and* a REPORT tool (`REPORT_TOOLS`): the first makes a D-38 panel agent answer it rather than propose a
  write that does not exist, the second is what S-4 counts, so the run ends `torn_down` with
  `no_op === false` and the brief's research key is closed for good. Ending the pass without calling
  either tool is a counted silent no-op (S-4) whose closed run row STILL closes the gate —
  `records.ts:researchClosed` reads any closed run, not the tool call — so the pass is not bought
  again; what the report adds is the reason on the record and the `no_op === false` that keeps S-4's
  no-progress stop off a Story whose pass did answer. `structureSeed`'s §8.7 argument list gains
  the required `research_questions`; the catalogue is 52 tools, and per-kind totals are unchanged because
  the new tool is researcher-only. Pinned by `src/server/loop/phase1-research-waiver.test.ts` and the
  D-51 cases in `src/server/tools/runtime.test.ts`.
- **H1: phase ① hill-climbs — selection is gated on a fix certificate, not on the counts (2026-11-23).**
  §6.5's ranking now runs INSIDE an eligibility floor (`loop/sample-select.ts:scoreSample`), and the
  floor is ORIGIN-AWARE, so its wording differs per mode. A candidate measured against an ACCEPTED base
  is selectable only when it introduces NO blocking issue OF ITS OWN — the screening schema's `high` IS a
  finding at cost `major` (`shared/types.ts:SampledIssue`), so the pair is critical/major everywhere —
  AND every fix task its own screening passes were handed is marked `resolved` with a non-empty
  `evidence` line by EVERY pass that carried it (`carryingFix`, `certifiesFix`). Blocking issues the
  accepted draft already had (`inherited_*`) cost the candidate nothing: Revision N was accepted with
  them, and the Author decides which become work — one inherited issue the Author DID target is an open
  fix task inside the candidate's demand, so "inherited" means "not a regression", never "excused". An
  issue whose origin no pass stated counts as INTRODUCED: fail closed, because a pass handed the base and
  silent about the origin cannot swear the new text is no worse than the text it replaces. A FIRST round,
  where there is no incumbent to regress against, keeps §6.5's floor verbatim — zero `critical` AND zero
  `high`, plus every demanded fix cleared (R5). Unanimity rather than a majority is deliberate: with
  `summary_critics` = 5, one Critic marking the fix `unresolved` is a live disagreement the loop resolves
  by resampling, not by averaging (P6). `unknown` is the Critic admitting it cannot tell, which is not a
  pass (R2); an unevidenced `resolved` is not a verdict (D-15); a pass that failed schema validation can
  disqualify a draft but cannot certify a fix; and silence from a pass that was never handed the task (a
  finding confirmed after its prompt was compiled) is not a failure. Minors never hold a round — the
  screening schema closes severity at critical/high (T-11) and the Summary prompts cost wording and
  sentence-shape notes as minor/taste (R6) — where a `taste` row is a `kind: proposal` by D-33b, so the
  ladder's preference rung never arrives labelled as a defect — while chapter prose keeps the §9 wording.
  D-33c/D-33d add the ORDER to that sentence rather than changing it: a `kind: proposal` is filed in a
  review pass that has no unresolved `issue` on the Story and never in the same pass as one, and it cannot
  be approved while an issue is still open, so a round spends its Writer capacity on the defects first and
  the improvement comes in the pass that has none left (`tools/reader.ts:raiseFinding`,
  `tools/editor.ts:approveFinding`, `loop/records.ts:openIssueFindings`).
- **H1-C1/F2 — an ungradeable round that OWES fixes is refused, not accepted (2026-11-23).** The one
  eligibility exemption is "nothing is outstanding". A candidate whose screening set cannot hold a
  certificate at all — no `fix_refs` and no verdict on any row (`ScoredSample.legacyScreening`), which is
  also the shape of a screening leg whose every attempt failed the schema and of a row written before H1 —
  is INELIGIBLE in a round that still owes an open fix task, so it never replaces the incumbent prose:
  "nobody checked" is not a clean certificate. `legacyScreening` is therefore a REPORT on the score (it
  explains an empty `fixesCleared`, and the closure gate still closes only `fixesCleared`), never a
  waiver. The no-winner path is the existing bounded one — another sample inside `samplingCapOf`, then the
  rejection escalation — never a silent round of competing drafts. Round 1 keeps the T12/C degrade
  untouched (it owed no certificate), which is pinned on both sides: the round-1 row in
  `src/server/loop/phase1-gates.test.ts` and the new round-2 row in `phase1-hill-climb.test.ts`.
- **The fix demand is a record, not a query — and only of what is STILL open (H1-C1/F1).** Each screening
  Work Item freezes the open fix ids at dispatch (`run/types.ts:WorkItem.fixRefs` — deliberately its own
  field, not `taskRefs`, which `settleJob` marks done) and the engine copies them onto the
  `sample_reviews` row it persists (`fix_refs`) beside the verdicts the Critic actually answered
  (`fix_verifications`). `loop/records.ts:sampleFixDemand` reads the demand back off those rows, so every
  candidate is graded against exactly what ITS screeners held and nothing else; a row that declares nothing
  falls back first to the ids its verdicts echo (the schema keeps `fix_refs` optional so a pre-H1 row still
  parses, §11's additive rule), then to the Story's open fix tasks for a REFINED draft nobody graded, then
  to NOTHING for a round-1 draft. EVERY rung is then intersected with `openFixTaskIds` — the same set the
  Writer's prompt compiles and the arming rule counts — so a task the Author settled (`wontfix`, or `done`
  out of band) stops demanding: an Author who follows the escalation's own advice ("discard the fix tasks")
  resolves the round instead of deadlocking it. Before that intersection the round sat with no eligible
  candidate, no armed sample (`samplingArmed` needs an OPEN fix task), no spent cap and no escalation, and
  the round-1 Summary stayed in place under a drain that could not clear; the settled rows also stay
  settled — the selection does not relabel them `done`/`fixed`. Freezing per job also keeps the round's
  prompts byte-identical (P1), and it means a task confirmed mid-round burdens only the drafts whose later
  pass carried it — the hill-climb re-aiming at the outstanding work, not a rule that moves the goalposts
  under a draft already screened. `engine.ts:rearmSamplingWave` does not burn a wave on such a round: its
  `samplingExhausted` guard is false once the demand empties, so the round simply selects (wave 0, no new
  sample needed).
- **A stalled round climbs instead of installing the least-bad draft (R3).** `loop/work.ts` offers one
  extra sample per sweep while the round is selection-ready but holds no eligible candidate, bounded by
  the wave's budget (`records.ts:samplingProgressOf`): the ceiling starts at `samplingCapOf` (stage size
  + `SAMPLING_RETRY_ALLOWANCE` = 3, so 8 attempts at the 5/5 product standards and the 1-sample loop
  rig's 4) and GROWS by one attempt per PROVEN improvement, and
  `SAMPLING_NO_PROGRESS_STREAK` (3) completed attempts in a row that beat nothing stop the round EARLY —
  an allowance, not a new round cap, and no new trend rule. Exhaustion reuses `work.ts:SAMPLING_FAILURE_PREFIX` with a second title
  (`Phase ① sampling failed after <cap> attempts — no draft answered the fixes this round was armed
  with`, its detail naming the wave and each outstanding `task_n (unresolved on revision_n)`) so the wave
  re-arm in `engine.ts` recovers it through the existing Author path. Only the PREFIX is a contract —
  `openEscalationTask`'s reuse key and `engine.ts:rearmSamplingWave` match `SAMPLING_FAILURE_PREFIX` plus
  the detail's `wave: n`, so the title tail is free to state the truth (H1-C2/N-1 below). §6.5's least-bad
  pick survives exactly where nothing is outstanding: round 1, and a refinement whose fix tasks the
  Author has settled. A refined round that still owes an open fix task does NOT fall back to it — not
  when its screening rows predate the certificate, and not when the screening leg answered nothing
  (H1-C1/F2 above).
- **H1-C2/N-1 — the rejection escalation names the axis that actually failed (2026-11-23).** Eligibility
  has two axes, so exhaustion has two honest explanations, and the row now reads from each candidate's
  score (`roundSampleScores`) instead of assuming the fix axis: with NO certified candidate it keeps the
  H1 wording ("no draft answered the fixes this round was armed with" / "no screening pass certified
  them"); with at least one candidate that cleared every fix it was handed, the title becomes
  `… — no draft was both fixed and free of critical/high screening issues` and the detail names those
  candidates, states that every fix was certified with evidence, and lists the counts that refused each
  draft (`revision_n (0 critical, 1 high)`). A mixed round says which drafts cleared and which left fixes
  unresolved rather than claiming nothing was certified. The recovery lever is axis-specific too: a round
  whose work list is answered is not invited to discard the tasks it already satisfied. `unresolved` and
  `never screened` are kept apart — a draft whose screening leg produced no valid verdict was not graded,
  so its lever is the provider, not the draft. Minors are never described as a blocker, and they cannot
  be: severity closes at critical/high (T-11) and the Summary prompts cost wording notes as minor (R6).
- **A selection is proof, not an event (R4).** `engine.ts:trySelectSample` closes a `fix` task and moves
  its finding to `fixed` only for the ids in the WINNER's `fixesCleared`. Before H1 the commit closed
  whatever the prompt had listed, so a rewrite that discarded the draft could "fix" a defect by
  forgetting it, close the task, and start the next round from a worse book. A rejected draft leaves its
  tasks `open` and its finding `approved`, which is what arms the next round
  (`records.ts:samplingArmed`) — the climb continues, and the failure is auditable.
- **The audit line records the rejection — and the wire carries it (H1-C1/F3).**
  `stories.sampling_history[].samples[]` gains `unresolved_fixes` on EVERY sample line, not only on failed
  runs: §6.6's hard truncate deletes the losers and their `sample_reviews` rows in the same commit, so
  without it the certificate — and the reason a round was refused — would vanish with them. The phase-①
  Story view now projects it (`api/projections.ts:samplingView` → `dashboard/api.ts:SamplingHistoryRow`),
  normalised to `[]` on a line written before the field existed, so an API consumer reads one shape and
  never has to know which build wrote the row. Note what the line records: the demand as it stood at the
  SELECTION, so a round whose task the Author settled before it selected reads `[]` — the refusal itself
  lives on in the escalation row's detail, which outlives the task it names (P11).
- **The crew doubles certify by default.** `loop/mock.ts:CrewBehaviour.screenFixes` and
  `integration/harness.ts` mark demanded fixes `resolved` with evidence unless a row overrides it, so the
  existing pipeline rows keep exercising the ENGINE's reaction to a certificate rather than a model's
  wording; the failure rows name the override they need.
- **H2 — a `fix` row's owner decides what phase ① does with it (2026-11-24).** §6.8's demand assumed every
  open `fix` task is prose work. The live Story disproved it: `finding_332` carried a Researcher-owned
  grounding row AND a Writer-owned repair row, and the round was armed and graded against BOTH — a draft
  cannot pass "is the pet rule sourced?", a Critic's honest `unknown` is not a pass
  (`sample-select.ts:certifiesFix`), and the round spent its cap with nothing eligible. Three rules follow,
  all keyed on the task's `owner_role` through ONE predicate (`records.ts:isWriterActionableFix`: `''`,
  `writer`, or a `writer-*` template id — the assignment layer writes `writer-prose`):
  1. **Writer rows are the demand.** `openFixTaskIds` filters to them, so they alone reach the Writer's
     prompt block (`run/phase1-prompt.ts`), the screening `fix_refs`, `sampleFixDemand`, and the closure
     list in `engine.ts:trySelectSample`.
  2. **A Researcher row becomes the phase-① job that already exists**: a `research` pass, key
     `wi_research_fix_<task>_a<n>`, priority 0, `researcher-story`, unit
     `{ kind: 'summary', ref }` (F1 — `run/brief.ts` renders ARTIFACT UNDER REVIEW from `item.unit.kind`
     and scopes Ideas from `item.unit?.ref`, so a bare artifact id dispatches the pass with an EMPTY
     artifact section, asked to ground a fact about a Summary it was never shown), `taskRefs`/`findingRefs`
     naming what it settles. It is offered as stage 0, ahead of the round's own jobs. The budget reuses the
     loop's existing allowance — `records.ts:RESEARCH_PREREQUISITE_CAP` = `FINDING_VERIFY_CAP` (4) — and
     counts runs in the family from the journal, so a restart cannot buy five more passes.
  3. **Any other owner is a question, not silence**: `Phase ① fix task has no crew that can work it
     <task> — …`, `owner_role: 'author'`.
  The prerequisite settles only on EVIDENCE — `records.ts:researchPrerequisiteEvidence` is the `knowledge`
  create/update events attributed to a run in that task's family, and `engine.settleFixPrerequisites`
  (beside `escalateVerifyStall`) is its only writer. A run that ends with `reportNoResearch` (D-51) spent
  the attempt and answered nothing, so it must not settle the row; the job's note says so, because the two
  answers look identical to a crew asked to make them. Budget spent with no evidence opens
  `Phase ① research prerequisite exhausted on <task> — …`. Both rows are ONE per task (anchored reuse key
  `<prefix> <task.id> —`) and close the moment the task leaves the set that opened it — the Author's
  answer retires them, not a second question. A refinement round is additionally HELD while a
  prerequisite is unanswered: `status.ts:phase1Unmet` names it, so the sweep cannot report a clean drain
  over an external fact the loop still owes.
- **H2/F3 — a finding is retired by its LAST open fix row.** One finding can carry rows for several
  owners, so settling one marks THAT row `done` and leaves the finding `confirmed`/`approved` while any
  other open `fix` row names it (`records.ts:findingFixWorkSettled`; `OPEN_TASK_STATES` is the unfinished
  set). Both writes are gated identically — the prerequisite settlement and the certified-selection
  closure, §15's R4 proof rule — because store ordering otherwise let either one retire the shared finding
  out from under work still owed. A premature `fixed` is not cosmetic: it drops a major from the blocking
  set and writes a line into the closed-fingerprint history the trend reads forever, where a re-raised
  fingerprint then reads as a regression (L-16a). A finding whose rows are all settled closes exactly as
  before; a `wontfix`/`discarded` row is settled, not successful, and closes nothing new.
- **H2/R2 — an OPEN Author question is the wait it describes.** Phase ① escalations are opened `open`
  with `owner_role: 'author'`, not `blocked`: the reuse lookup, the drain-hold and
  `engine.ts:rearmSamplingWave`'s clear-and-rearm all key on the OPEN row, so a row's STATE cannot be what
  makes it a wait. `status.ts:decideStory` step 4 read only `blocked` rows, so the sampling-cap state fell
  through to `ready` — the dashboard's Working pill — with no candidate to dispatch and no run live. Step 4
  now reads an open, Author-owned escalation as `pending`/`drained` +
  `blocked_on: 'the Author: an open question'` + `the crew asked you: "<title>"`, and only at
  `dispatchable === 0` (the CANDIDATE count `engine.ts` hands it, L-36) with zero live runs. The row keeps
  its `open` state — the fix is in the read, never in rewriting the row — and because
  `records.ts:dispatchableTasks` admits any row carrying an `owner_role`, it also holds L-37's condition 1,
  so the clean-drain sentence can never be reported over an unanswered question.
- **H3 — the retry budget follows IMPROVEMENT, and three flat attempts stop the wave (2026-11-24).** The
  sampling allowance stopped being a flat `stage size + 3` burn: `loop/records.ts:samplingProgressOf`
  derives the wave's state from the ledger on every read (P11/L-3 — the engine keeps no memory, so a
  restart recomputes exactly the same numbers), and the wave now carries a BASELINE (the lowest
  unresolved-blocking count any regression-free, readable candidate has proved), an improvement count, and
  a no-improvement streak. The FIRST such candidate measures the hill and is not an improvement (it beat
  nothing); from then on only a STRICTLY LOWER count is one. Each proven improvement extends the ceiling by
  one attempt (`samplingCapOf + improvements`), and `SAMPLING_NO_PROGRESS_STREAK` = 3 completed attempts in
  a row that did not lower it stop the round with ONE Author escalation — so a hill that moves is never
  stopped by a static number, and a hill that stopped moving is not allowed to keep buying attempts. A
  candidate that regressed (any introduced blocking issue) cannot set or lower the bar — the count belongs
  to a draft the loop would never install — so it counts as no-improvement; and an attempt with NO readable
  candidate (the provider-failure shape) neither sets a baseline nor extends the streak, so those attempts
  stay bounded by the static cap the provider-failure escalation already speaks of. Only a round WITH an
  accepted base is measured at all: round 1 is producing the sample set the Author asked for, not retrying
  a climb, so it keeps §6.5's cap and its least-bad install (R5). Nothing re-arms the stop by itself — the
  Author's clear bumps `stories.sampling_wave`, every number above is scoped to a wave, and the fresh wave
  starts with no baseline and no streak, because a fresh wave IS a fresh baseline.
- **H3 — the ranking inside the eligible set is the deterministic BEST, and among equals the SMALLEST
  change (2026-11-24).** With an accepted base, `loop/sample-select.ts:selectSample` orders eligible
  candidates by fewest unresolved fixes → no new `critical` → no new `high` → fewest changed prose fields →
  fewest changed characters → the earliest candidate; a first round keeps §6.5's fewest-critical →
  fewest-high → fewest-total → earliest, because there is no incumbent there to be minimal about or to
  regress against. Minimality (`minimalityOf`) is a TIE-BREAK, not a quality score (P6): how many of the six
  §4.2 prose fields the draft touched, and the size of those edits in characters, measured as the smallest
  span that explains each change (common prefix and suffix stripped, so a one-clause fix costs the clause,
  not the paragraph). The last key is CREATION ORDER and never an id — §4 leaves id shape to the store and
  ids are per-book and opaque, so parsing a numeric suffix is an inversion waiting to happen.
- **H4 — the plateau is measured across REVIEWED ACCEPTED revisions, not only inside one round
  (2026-11-24, LANDED with the current change set).** The H3 streak bounds one round's attempts; its
  sibling bounds the phase across rounds, because a loop that selects a fresh accepted revision every round
  can keep sampling forever without ever proving the book got better. The rule: every accepted revision is
  deep-reviewed as §6.4 step 6 already requires, its blocking-finding count is compared against the best
  count the WAVE has ever seen on an accepted revision, and after THREE reviewed accepted revisions in a row
  that do not beat that best-ever bar the loop stops sampling for the wave and opens ONE Author escalation.
  Clearing it starts a fresh wave with a fresh baseline, exactly as the within-round stop does, and nothing
  re-arms a plateau by itself. It is a stop plus a question, never a replacement: the accepted revision the
  plateau stops on keeps the Summary, no least-bad draft is installed, and nothing a rejected attempt failed
  to certify is closed (§15's R4 proof rule). THE LANDSHAPE it landed on: the hill lives in ONE additive
  field, `Story.summary_review_history` (`shared/types.ts`) — a frozen entry per reviewed accepted
  revision, written at settle time by `engine.ts:trackRevisionProgress` — and the walk over that audit,
  partitioned by wave so the Author's clear is a fresh baseline, is `records.ts:revisionReviewProgressOf`
  behind the single predicate `records.ts:revisionReviewPlateau` that the arming rule, the queue and the
  drain probe all read. The bar is the same `records.ts:SAMPLING_NO_PROGRESS_STREAK` (3) the within-round
  rule uses, not a second number; the Author's row is `work.ts:openRevisionPlateauTask` under
  `work.ts:SAMPLING_PLATEAU_PREFIX`, recovered by the same `engine.ts:rearmSamplingWave` path as the
  sampling-failure row.
- **A Summary `minor` continues only when the Author's dial says so, and one predicate decides it
  (2026-11-24).** Phase ①'s blocking bar is `critical`/`major` PLUS `minor` exactly when `auto_approve`
  includes `minor` (`loop/records.ts:summaryBlockingCost` — D-35's dial read as plain membership): with the
  dial wide, a confirmed minor is authorised work that arms the next round, holds the sign-off and buys the
  fix pass; with the dial narrow it stays `confirmed` and NON-blocking — it arms nothing, holds nothing, and
  the Story drains with it sitting on the record. `taste` is never blocking in phase ①, dial or no dial: the
  prose it would prefer between does not exist until phase ③ (R6) — and `taste` is a `proposal`'s cost, not
  an `issue`'s (D-33b), so a preference can never be counted as a defect by the blocking reads above. The fix was CONSISTENCY, not a new gate:
  the engine's sweep skipped phase-① minors unconditionally while the Editor's approval path authorised them
  whenever the dial said so, so the same finding was work on one path and a dead end on another; the engine,
  the approval reads (`findingsToAutoApprove`, `findingsAwaitingAuthor`, `actionableFindings`) and the status
  reads (`unconfirmedBlockingFindings`, `summaryBlockingFindings`, `isBlockingCost`) now go through that one
  predicate. Later phases keep D-33's all-costs rule.
- **Current state of the storage layout the pipeline runs on (2026-11-24).** §11's "additive, no renames"
  rollout is now a matter of record rather than a plan: a Story is a BOOK — `<root>/stories/<uuid>/` holds
  its own `store.json`, `journal.jsonl`, knowledge projection and retained thread log, and `<root>/server/`
  is the app book for the crew catalogue and the host settings, with no Story rows of its own. Collection
  ids are per-book and ZERO-BASED (`run_0`, `finding_3` are unique inside one book, never across the
  workspace), so every aggregate row carries `story_id` and a follow-up verb is addressed through the Story
  that owns it — which is why `POST /runs/{runId}/kill` takes a `?story_id=` scope instead of guessing a
  holder (more than one holder with no scope is a 409 that names the scope, not a coin flip between two
  Stories' `run_0`), and why `DELETE /stories/:id` is
  ONE ordered purge that takes the rows, the harness session, the thread log, the knowledge projection, the
  runtime and finally the DIRECTORY. This build carries NO migration and NO back-compat shim: a store root
  still holding a flat `store.json` is refused, not converted. Everything §3.5/§3.6 add to the records is
  still additive on the row, and the projections normalise a pre-H1 sampling-history line rather than
  teaching the client about builds.
- Pinned by `src/server/loop/phase1-hill-climb.test.ts` (cap-bounded retry → escalation with nothing
  closed → wave re-arm closing on the certificate; the R5 least-bad round; the demand ladder including the
  `wontfix`/`done` intersection and the verdict-echo rung; the F1 Author-discard run that used to deadlock,
  drain clauses included; the F2 row whose screening leg never answered, which now reads
  `task_n (never screened on revision_n)`; and the N-1 row whose drafts all certify the fixes and are
  refused on a high issue, asserting the screening-axis title, the per-draft counts, the axis-specific
  lever, and the wave-1 recovery), the certificate cases in
  `src/server/loop/sample-select.test.ts` (ungradeable-but-owing is ineligible; a round that demands
  nothing is judged on its counts), the prompt bytes in `src/server/run/phase1-prompt.test.ts`,
  `src/shared/schemas`' certificate cases in `src/server/llm/structured.test.ts`, the
  `unresolved_fixes` wire rows (pass-through and pre-H1 normalisation) in
  `src/server/api/phase1-view.test.ts`, and the two multi-round enforcement rows in
  `src/server/integration/summary-sampling.test.ts`. The H2 block above is pinned by the `H2/R1-R2` describe
  in the same file (the Writer-only demand and the two routed owners; the prerequisite job's payload, unit
  included; the evidence rule and its `reportNoResearch` negative half; the 4-pass cap and the question it
  opens; the shared-finding lifecycle through the certified selection; and the settled sweep's own
  `pending`/`drained` read), plus `src/server/loop/drain.test.ts` (the question read on a drained Story,
  and a pending directive review keeping it out of the reading), `src/server/run/brief.test.ts` (F1's
  Summary-scoped artifact section), and the settled row of
  `src/server/integration/summary-sampling.test.ts`. The H3 budget is pinned by
  `src/server/loop/phase1-sampling-progress.test.ts` (the ledger-derived attempt/improvement/streak state,
  the improvement-extended ceiling, and the FRESH baseline a re-armed wave starts from) and by the
  `SAMPLING_NO_PROGRESS_STREAK` cases in `src/server/loop/phase1-hill-climb.test.ts`; the origin split and
  minimality are pinned by the ranking cases in `src/server/loop/sample-select.test.ts` and asserted on the
  wire by `src/server/api/phase1-view.test.ts`. The H4 plateau is pinned by
  `src/server/loop/phase1-plateau.test.ts` (written 2026-11-24 for the coverage that file's namesake
  never had — the audit written for every accepted revision and the
  3 non-improvements that stop real work, not just the status text; a strict reduction as progress, a
  repeat as none, and a regression never raising the bar, with the minor-dial and Editor-verdict halves;
  the one plateau question and its clear into a fresh wave with a fresh baseline; and the audit reset with
  the sampling counters on a Seed edit or a backtrack). **Update, same date:** the STOP and the audit
  stand for a legacy book, but the plateau's Author escalation (`SAMPLING_PLATEAU_PREFIX`) and its wave
  bump were removed when the grouped model landed, so the "one plateau question … into a fresh wave"
  case in that file is now the legacy-half behaviour and has no group-book equivalent — on a grouped
  Story the escalation is the open finding (§17.4), and the plateau leg of `phase1Unmet` is skipped
  entirely.

- **T3 — the Seed is a commitment, not an outline, and every pass is told so where it cannot be
  clipped away (2026-11-24).** The contracts this document started with read as checklists AGAINST the
  Seed: §8's screening prompt called a `high` "a promised element the draft fails to deliver", the
  deep-review cost ladder called `major` "a promised element broken or missing", and §5.2's C-14 asked
  whether "nothing central to `stories.idea` is missing from it". A Summary is a set of facts about the
  book, not a plan for the whole book, so all three turned a Seed SILENCE into an unmet promise. The
  Author's two screenshots were exactly that shape — a refuge with no earlier planting, and `the
  Overview never says what the bird loses` — and each one was confirmed, auto-approved, turned into a
  `fix` task and paid for with a sampling round. The rule now runs the other way, in one wording
  everywhere a model reads it: the Seed and its Brief commit what they STATE, and where they are silent
  — or name a gap in `open_questions` — the Writer supplies any specific that contradicts nothing,
  invention included. The gates do not move: a contradiction of the Seed, of critical Knowledge or of
  the artifact's own promise, a real contradiction inside the artifact, and a commitment the Seed states
  EXPLICITLY that the draft plainly does not carry (`shared/criteria.ts:C-14`, whose label is now that
  test — `checker: judge` and `hard: true` are untouched) all still cost what they costed, and the
  chapter/plotline setup-and-payoff review (C-4, C-5, C-6) still runs in phases ② and ③. Proof is a
  QUOTATION, so a finding that can quote only an absence is inadmissible and the Editor `dispute`s it.
  Placement is the whole design: the rule is carried by the two engine-owned, never-clipped texts a
  Reviewer is guaranteed to read (`run/brief.ts:CRITIC_REVIEW_MODE` and its `check_unit` critic job
  line), by `run/brief.ts:jobStatement` for `write_unit`, `structure_seed`, `verify_findings` and
  `confirm_finding`, by the tool-less paths (`run/phase1-prompt.ts:SCREEN_INSTRUCTION` and the
  `SEED_CONTRACT_NOTE` appended to the SEED BRIEF section of both compiled prompts), and inside the
  FIRST 600 characters of the sweep note (`loop/work.ts`) because `run/brief.ts:renderJob` clips that
  note — the shipped note put `THIS IS THE OVERVIEW, NOT PROSE` at character 950 and the phrasing rule
  at 1,320, so the passes that kept costing rounds were never sent the sentence that would have stopped
  them. The four angle templates are Author-editable copies (§4.12), which is why the durable wording
  is engine-owned, and why each of them states the stand-down under
  `When the artifact under review is a SUMMARY (phase ①)` with the later phases named in the same
  breath. One storage-visible consequence stays source-only: a required Seed Brief field the Seed leaves
  silent is recorded as `''` plus an `open_questions` row and renders as `OPEN_SCALAR_MARKER`'s "the
  Seed states nothing here" line, because `stakes:` followed by nothing is what a Critic read as a
  broken promise. Pinned by `src/shared/criteria.test.ts` (the §5.2 mirror and the contradiction
  wording), the T3 cases in `src/server/templates/templates.test.ts` (the sampler's licence, the
  screening gates, the four angles' phase isolation, the Editor's dispute of an absence, the
  Seed-structuring Editor's open-field recording), `src/server/run/phase1-prompt.test.ts` (the screening
  contract, the engine-owned SEED BRIEF note surviving an Author-written role prompt, the open-field
  render), `src/server/run/brief.ts`'s own test file (the unclipped job line and banner, the note's
  surviving window with the store's short AND long ids, and both verification gates) and the rig-level
  case in `src/server/loop/phase1-verdict-contract.test.ts`.

- **T4 — the Summary is authored GROUP by GROUP, and this pipeline's steps 4–9 changed with it
  (2026-11-24).** The unit of phase-① work is no longer the whole Summary: it is a **phrase GROUP**,
  and every part of the loop that was written against "one text, N competing drafts" was rewritten
  against "five parts, each with its own revision line". The reason is the one this document's own
  economics could not fix: under sampling, one sentence of criticism costs a rewrite of all six prose
  fields and the deletion of the other N−1 attempts (D-22), a Writer budget is spent re-drafting a whole
  book to fix one clause, and a "Revision 1 … N" rail cannot say *Tone is fixed and Premise still isn't*.
  Steps 1–3 — the Seed, the Seed Brief, the Researcher, the gates — are **untouched and still current**;
  so are `toolMode: 'none'` and its structured transport (§4.2), the citation and evidence rules, the
  deep-review cost ladder, and the dial that decides what becomes a task. Steps 4–9, restated as they run
  on a `summary_mode: 'groups'` Story (normative form: `specifications.md` §17):

   4. **The compiler builds one prompt per Writer BATCH, not per sample.** §5's compiler gains a group
      branch: `run/phase1-prompt.ts:compileGroupDraftPrompt` assembles the Seed section, the `critical`/
      `high` Knowledge filter, the FIX TASKS block **only when the batch carries any** (a first draft is
      handed none, because there is nothing to answer yet and an empty heading reads as an unanswered
      demand), and **`## GROUPS` — the batch's groups in catalog order, each with its duty line
      (`phrase_groups.description`, the group saying in its own words what it owes) and its CURRENT text**,
      followed by the engine-owned `GROUP_DRAFT_INSTRUCTION`. Current text is not decoration: a group
      revision is a revision OF a specific text (R2), and a Writer handed only fix tasks would rewrite a
      group it cannot see. The open findings reach the batch as the fix tasks they became (D-34/D-35). The
      system turn is the sampler's role prompt plus the `GroupDraft` answer contract, and group ids, group
      count and round number never enter it — two batches that share the state share the cacheable prefix,
      and the digest lands on the revision row (`prompt_hash`, §5's cache rule). The rules that MUST hold
      (the exact-set answer, "content not restatement", revise-don't-rewrite, and — since D-66 — "every
      group a fix names is already in THIS batch, so answer the whole defect or claim nothing") are
      engine-owned text, so an
      Author's rewrite of the template cannot quietly drop them.
   5. **A Writer writes the batch.** `draft_groups`, `role: 'writer'`, `toolMode: 'none'`, one turn,
      answering `GroupDraftSchema` (`{group_ref, content}` per group plus `knowledge_used`). The batch is
      whole FINDING-SETS cut by `phrase/exclusion.ts:planGroupDraftBatch` (D-66, R12): the groups that OWE
      text — unwritten, or named by an open finding no revision of that group resolves — are grouped into
      indivisible sets (`findingGroupSets`, a union-find over shared finding ids), a set with a group held
      by a live Writer waits WHOLE rather than being shrunk, a set missing one of a finding's still-owed
      groups is withheld rather than answered in part, and
      `max(1, stories.summary_sampling)` caps only the sets AFTER the first, which is taken at any size.
      So a defect naming three groups on a `summary_sampling: 1` book is ONE pass, not three sweeps: the
      dial counts passes the sweep may buy, and it was never a knob for how much of one defect a pass may
      answer. An
      invalid answer fails the **whole batch** (`phrase/revisions.ts:parseGroupDraftAnswer`), and so does an
      answer that skipped a group the job carried — the engine installs only on `ok`, because half
      an installed Overview is not an Overview. **Acceptance installs**: `engine.ts:1445-1528` calls
      `installGroupRevisions` in the commit that closes the run — one new `latest` revision per written
      group, the rows they replace go `archived` and are never deleted, the Overview recomposes from the
      catalog's order, and §4.2's five prose fields are re-mirrored from the same texts through the identity
      map in `shared/phrase.ts:SUMMARY_MIRROR_FIELDS`. The install is the mirror's ONLY writer on a grouped
      book: the crew's `editSummary` answers `R6` there (hardening, D-61), so no run can put prose into those
      fields behind the groups' backs — and the permission that used to make a hand write legal (T-3c's
      Writer-only §4.2 write) now only explains why a `'sampling'` book keeps the tool.
   6. **Critics review the whole vector, and the review is keyed by it.** `review_groups`, `role: 'critic'`,
      `toolMode: 'none'`, `summary_critics` seats, each reading EVERY group — a defect that crosses groups
      has to be able to name all the groups it crosses. Their prompt
      (`run/phase1-prompt.ts:compileGroupReviewPrompt`) is the mirror image of a screening pass: a screen
      judged one CANDIDATE against its siblings before a winner was chosen, a group review judges the
      INSTALLED Overview, all five groups with their revision numbers — the combination under review, which
      is the key the job was claimed under. The work item is claimed as
      `wi_review_groups_<vectorHash>_<pass>`, where the vector is the sorted `<groupId>:<revision>` pairs
      hashed by `phrase/revisions.ts:groupVectorHash`; an install moves the vector, so the reading seats
      re-arm by themselves and the projection reports `reviews_on_current_vector` rather than guessing.
      The answer is `GroupReviewSchema`, every issue naming its groups, and a pass handed fix tasks is the
      only pass entitled to certify them — the same silence-is-not-a-pass grading a screening row used
      (`records.ts:sampleFixDemand`), so the group path invents no weaker evidence standard.
   7. **There is no step 7.** No selection, no minimality rule, no truncation, no `selectRevision`, no
      merge — a `draft_groups` run never calls any report verb, and the §6.5 selector and §6.6 truncation
      are skipped for a grouped book (`engine.ts:1606`, `1994`, `2073`). The Writer's answer IS the record.
      The retired step is now closed from the crew's side as well: an Editor that calls `selectRevision` on a
      grouped Summary is refused `R5`, and an Editor that asks for a Summary `requestMerge` gets the `D-23`
      refusal with a `fix` that names `raiseFinding` + `group_refs` instead of the selection workflow (hardening,
      D-61) — a hint pointing at a removed tool is a hang the Author has to diagnose.
   8. **The real review comes after every seat has reported on that vector.** `check_unit`, tool-carrying,
      `critic`, claimed as `wi_group_check_<vectorHash>_<pass>` for as many passes as there are seats, the
      same four angles as before. The one thing it must now do is say **which groups** a complaint is about:
      `raiseFinding` on a grouped Summary that omits `group_refs` is refused, as is an id the catalog does
      not know (`tools/reader.ts`, and the dedupe rule D-16 is not allowed to swallow a complaint that
      names more groups than the one already open). The advice that comes back with an unknown id now
      BRANCHES by book: a legacy Story is told it may omit the list — there, an empty list really does mean
      the whole Overview — and a grouped Story is told to name every group the defect crosses, because a
      grouped Summary has no unscoped path to omit into (hardening, D-61). The D-33 rule that a phase-①
      Summary finding must name the draft it describes is skipped on this book: there is no competing draft
      to name (R5).
   9. **The refinement loop is per group.** An approved finding queues its `fix` task, and the next batch is
      exactly the groups the finding names (`phrase/findings.ts:findingGroupsStillOwed` — a finding with NO
      `group_refs` means "the whole Overview", the legacy reading, so an old complaint still routes work, it
      just routes more of it). That set is ONE pass whatever the batch dial says (D-66, R12): the loop may
      not schedule, install or report half of a finding, and the dial caps how many passes a sweep buys
      (§17.15). A group is "resolved" only by the **explicit claim** on the row: a
      `group_revisions` row whose `finding_refs` names the finding. `findingResolution` reports
      `{targeted, resolved, missing, resolved_all}`, and the finding goes `fixed` only when `resolved_all`
      is true and the row is `approved` — an unconfirmed finding does not close over the Author's gate
      (D-33/D-34), and a replayed install cannot re-close a closed finding. **A finding about Premise and
      Ending is owed until BOTH have a newer revision claiming it**: a group cannot settle a cross-group
      complaint by rewriting itself.
      **The budget is the escalation — per TEXT, not per lifetime.** `GROUP_WRITE_ATTEMPT_CAP = 2` rewrite
      attempts per group, counted over CLOSED holding runs whose JOURNAL POSITION is after the write that
      produced the group's current text (`writeBaselineOf`: that text's `latest` row when there is one, else
      the last create-or-update event on the group row). It never counts a live run, never counts a reading
      seat, and RESETS when an install succeeds — so a group that was rewritten cleanly and is criticised
      again has a fresh pair against the NEW text, a rewritten Seed re-baselines with the reset, and nothing
      about the number caps how many revisions a group can ever have. When the pair is spent the loop stops
      paying for that group: **no Author escalation, no wave bump, no least-bad install** — the open finding,
      in the review rail with its attempts visible, is the question, and the Author's moves are to decide it
      or rewrite the group by hand (`POST …/phrases/groups/:groupId/revise`, refused with `409` naming the
      holding runs while a Writer pass is in flight). That removal is deliberate: asking the Author to re-say
      what the crew already said spends an agent to produce an echo. A spent group is PARKED, and a parked
      group is deliberately NOT counted as owed, or a provider that cannot answer the schema would make the
      Story undrainable.
      **Closure and the sweep.** Closure is a join on claims in both orderings: an install closes an
      `approved` finding once every group it names carries a claiming revision, and because the planner cuts
      batches off OPEN findings, a Writer can install the answer BEFORE the approval lands — so the sweep
      re-runs the same read every round (`engine.ts:560-595`, `loop_reconcile_findings` →
      `closeFindingAnsweredByInstalls`) and closes the fix tasks that named the now-`fixed` finding. The step
      runs on group books only, because with no phrase rows `findingResolution` answers `resolved_all: true`
      vacuously and acting on that would delete a sampling round's fix work (hardening, D-64).
      **What the drain and the sign-off wait for.** A grouped book's §6.7 drain reasons come from
      `phrase/exclusion.ts:groupPipelineOwed`, not from the sampling rows it never writes: group-pipeline runs
      still in flight, groups owing the Overview a draft or a fix pass, Critic passes still owed on the
      installed vector, then deep-review passes owed for it — and `decideStory` withholds the
      `pending / phase_signoff` offer over the same owed passes, so an install re-arms a full reading cycle
      before the Story may read `drained` (§6.7 as restated in `specifications.md` §17.8; the HTTP lock's own
      gate — Ideas tray, then Goal — is unchanged).

  **What a grouped Story never writes:** `sampling_round`, `sampling_wave`, `sampling_history`, the six
  §4.15 `revisions` rows, `origin: 'sampled'`, `selected_sample_id`, the plateau audit's escalation row, and
  any Author task from the sampling path. **What stays identical:** the Seed Brief and its one claim family,
  the Researcher jobs and the D-40/D-51 gates (`records.ts:researchGate`, `researchKeyOf`), the citation
  rules, `toolMode: 'none'` and the structured transport, the deep-review angles and the dial (D-34/D-35),
  the lock gate (Ideas tray first, then the phase Goal), and phases ② and ③.

  **The two honest gaps this pass found are closed, and they are named here with their provenance rather
  than quietly deleted.** (a) `deleteStory`'s purge list did not name `phrases`, `phrase_groups` or
  `group_revisions`, so deleting a Story left one phrase row and five group rows behind; the measurement
  survives — `Temp/create-storyline-orchestrator/T4/phrase-delete-probe.ts`, run through `yarn vite-node`,
  reported `phrases=1 phrase_groups=5`. `engine.ts:2673-2675` now deletes all three in the same
  `delete_story` commit, after the live runs are killed and settled, and `api/story-delete.test.ts` seeds a
  group book through `installGroupRevisions` to assert it. (b) Nothing group-shaped was reset by a Seed edit
  or a backtrack: `editSeed` (D-25a, "the Summary goes") cleared the mirror and left all five texts and all
  five revision numbers standing, so the next batch saw a fully written Overview and the archived history
  kept its claim on the attempt baseline and on R3's closure join. Both flows now do their own honest work:
  `invalidation.ts:scrapPhasesAfter` deletes the story's `group_revisions` rows and reports the number as
  `counts.groupRevisions`; `engine.ts:editSeed` resets the five `phrase_groups` rows IN PLACE — `''` / `0` /
  null, **same UUIDs**, so R1's addresses outlive the text — and clears the Overview and the mirror with
  them; `engine.ts:backtrack('summary')` keeps L-31's split instead, preserving the reopened phase's own
  artifact (the texts and their mirror, as the base for another round) while the revision history goes with
  the scrapped work. `loop/group-seed-reset.test.ts` pins all of it, including the sibling Story whose
  catalog must not move. The write allowance rides a JOURNAL baseline (`writeBaselineOf`) precisely so these
  resets are resets: counting from the group row's create would charge the old Seed's passes to the new one
  and park every group, which would let an EMPTY Overview read as drained.
