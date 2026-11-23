# Phase 1 — Research → Sampling → Screening → Refinement

**Status:** design proposal (not yet normative). `documents/specifications.md` remains the build
contract until this document is folded into §4, §5, §6, §7 and §8 and the tests below land.

**Scope:** Phase 1 (`summary`, the UI's "phrase 1") end to end, plus the parts of the whole design
that the new pipeline forces: a Researcher employee, a durable Knowledge collection, structured
one-turn sampling, a screening Reader mode, deterministic sample selection, and the refinement loop
that follows a deep review. Phase 2 and 3 keep the Checker and gain the Knowledge lookup.

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
6. **Readers screen the samples.** One turn each, **no tools**, returning only `critical`/`high`
   issues as structured `IssueList`s. Each list is stored against its sample.
7. **The system picks the First Revision.** Fewest `critical`, then fewest `high`, then fewest
   total, then oldest sample. No quality score (P6).
8. **The First Revision gets the real review.** Readers with tools read it; the Editor verifies
   their findings (D-33); the Author/dial approves (D-34); tasks are queued.
9. **The refinement loop.** The compiler rebuilds the first prompt from the chosen revision + the
   open tasks; N new samples; one-turn screening; pick the least-issue sample; truncate the rest;
   deep review again. Repeat until the Goal passes and the Author locks.

The Checker stays in Phase 2 and 3. Phase 1's screening Reader is a **run mode of the existing
Reader employee**, not a Checker.

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
- **The Checker keeps its place** for consistency and prose (Phase 2/3), and the whole-Story pass
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
- **"Readers … disable all tool."** The screening Reader is the same. Only the deep-review Reader
  gets the tool catalogue.

---

## 3. Records

All new records follow `shared/types.ts` conventions (`StoredRecord`, `RecordInit`, enum arrays).

### 3.1 `RoleKind` gains `researcher`

```ts
// src/shared/types.ts:100
export const ROLE_KINDS = ['writer', 'editor', 'reader', 'checker', 'researcher'] as const;
```

`researcher` is **Rank A** (`src/server/run/story-engine.ts:96`):

```ts
export const STORY_AGENT_RANKS: Record<RoleKind, AgentRank> = {
    writer: 'A', editor: 'A', reader: 'A', checker: 'A', researcher: 'A'
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

### 3.4 `sample_reviews` — the screening Reader's one-turn answer (new collection)

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
    /** Reader role name/run that produced it. */
    reader: string;
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
  stay readable through `readKnowledge` for the deep-review Reader, never in the sampling prefix.
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

### 6.1 New Work Item kinds

Add to `src/server/run/types.ts:26-38`:

```ts
export const WORK_ITEM_KINDS = [
    'seed_review',          // legacy
    'structure_seed',       // new: Editor → SeedBrief
    'research',             // new: Researcher → Knowledge
    'sample_unit',          // new: Writer, one turn, structured
    'screen_samples',       // new: Reader, one turn, structured
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
2. **`research`** — priority 0, one per accepted SeedBrief revision (`wi_research_<brief_rev>`).
   Refuses sampling until it closes. A `knowledge_gap` finding re-arms it.
3. **`sample_unit` × `summary_sampling`** — priority 2, one per sample:
   `wi_sample_<unit>_<round>_<i>`. Each carries `toolMode: 'none'`,
   `responseSchema: SummarySample`, `sampleIndex: i-1`.
4. **`screen_samples` × `summary_readers` per sample** — priority 2 (same class, ordered after its
   sample), claim `wi_screen_<revision>_<pass>`, `toolMode: 'none'`,
   `responseSchema: IssueList`. A screening job is generated only once its sample exists and its
   Writer run is closed.
5. **`choose_sample`** — priority 1, generated when every sample of the round has every screening
   pass closed (`sample_reviews` count = `summary_sampling × summary_readers`). Engine-side
   selection; writes the selected revision, `issue_counts`, `sampling_history`, and deletes the
   losers.
6. **Deep review** — the existing `check_unit` Reader passes (tools on) against the selected
   revision, the existing `verify_findings` Editor jobs, the existing `confirm_finding` Reader
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

`drainPreconditions` (`src/server/loop/status.ts:101-133`) gains four unmet reasons:

- no accepted `SeedBrief`;
- no closed `research` run for the current brief;
- samples still being written (`sample_unit` live or owed);
- screening passes still owed for a written sample.

`phase_signoff` is not offered while any of those hold. The drain probe still runs (L-37), but in
this pipeline its Reader half is a tool-using Reader and its Checker half is unchanged — Phase 1's
screening is a separate, cheap pass.

### 6.8 The refinement loop, precisely

```
round 1:  samples(seedBrief, knowledge)         → screen → choose  → First Revision
          deep review (Readers + Editor + dial) → fix tasks
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
| `readKnowledge` | every kind | `importance?, phase?, kind?, topic?` | — | The sampling compiler uses the same filter server-side; the tool is for the deep-review Reader and the Editor. |
| `retireKnowledge` | researcher | `knowledge_id, expects, why` | `knowledge` | Mark a stale entry `low`/`retired` instead of deleting it (audit). |
| `submitSample` | — (engine) | — | — | Not a tool: the sampling Writer has no tools. The engine persists the validated answer. |
| `reportSampleIssues` | — (engine) | — | — | Not a tool: the screening Reader's answer is persisted by the engine. |

`structureSeed` and `writeKnowledge` carry `why` and `expects` like every other mutating tool (T-4,
T-5, T-11). The no-tool runs carry no tool calls at all; their `why` is synthesised from the job
line and the prompt hash, exactly as `submitVerdict` synthesises its optional `why`
(`src/server/tools/checker.ts:251-253`).

### 7.2 Permission matrix

`src/server/tools/permissions.ts` transcribes §7 with one column per dispatched kind. Add
`researcher` to `PermissionRow` (`permissions.ts:16-41`) and to every row:

| artifact | writer | editor | checker | reader | **researcher** | rule |
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
**P10**, the same as a Checker/Reader.

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
   commit to a framing (L-16). Done definition: a schema-valid `SummarySample`.
4. **`reader-screening`** — kind `reader`, `serves_phase: ['summary']`, `attempts: 1`, `web: false`.
   Prompt: you have no tools; answer once with `IssueList`; report only `critical` and `high`
   problems; a `critical` is a contradiction with the Seed Brief or a `critical` Knowledge entry, a
   `high` is a promised element the draft fails to deliver; quote the offending field verbatim;
   return `{"issues":[]}` when the draft holds. Done definition: a schema-valid `IssueList`.
5. **`reader-deep-review`** — the existing reader templates (`reader-genre` etc.) reused with the
   current tool catalogue, pointed at the selected revision.
6. **`editor-general`** — unchanged, but its prompt gains one paragraph: in Phase 1 it verifies the
   deep-review findings against the selected revision; the screening issues have already chosen the
   draft and are not re-litigated.

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
- `api/agents-route.test.ts` — five rows, alphabetically: Checker, Editor, Reader, Researcher,
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
- **The Checker is unchanged** in Phase 1: it is still skipped (`work.ts:906-908`). The screening
  Reader is a Reader mode, not a Checker return.

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
- **`GET /agents` is alphabetical** — Checker, Editor, Reader, Researcher, Writer — because the route
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
