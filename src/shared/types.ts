// §4 — the data model. Every record and every enum in the build contract lives here.
//
// WHY THIS FILE IS THE PINNED CONTRACT: §4 states that collections "are normative in name
// and field; a build MAY add fields, MUST NOT rename or drop one". Later waves (tools W2,
// criteria W3, loop W4, dashboard W9-W13) code against these shapes, so a field name here
// is a wire format: it is what lands in `store.json` (W1) and what every tool result names
// (T-8). Renaming one is a migration, not a refactor.
//
// ENUM STYLE: each enum is a `as const` array plus a type derived from it
// (`export type X = (typeof XS)[number]`). The spec's enum names are preserved as the type
// names; the array exists because W3/W4 need the value set at RUNTIME (validation, the
// auto_approve dial's option list, the dashboard's badge switch) and a bare TS union
// erases at compile time. P15 ("a phase model, a role set, or a criterion must be
// replaceable without rewriting the store") is why the values are data, not class state.
//
// REQUIRED VS OPTIONAL, stated once (the §4 tables only mark a few fields "required"):
//   - required  -> §4 marks it required, or it is an enum/boolean/counter that has no
//                  "unset" state in the spec's own rules (states, locks, counters, the
//                  dial), or a key a named rule dedupes/looks up on (fingerprint, D-16/D-32)
//   - optional -> free text §4 describes as a plain field with no stated default
// Everything else follows the table verbatim.
//
// NO BEHAVIOUR LIVES HERE. This module is types plus enum data only — no methods, no
// imports — so it can be pulled into a browser bundle (the dashboard) and a Node process
// (the store, the loop) from the same source.

// ---------------------------------------------------------------------------
// Base record (every §4 collection carries these three bookkeeping fields)
// ---------------------------------------------------------------------------

/**
 * The bookkeeping every §4 record carries. `rev` is the compare-and-swap token of T-4:
 * every mutating tool sends `expects: [{id, rev}]` and the server refuses a stale write,
 * returning the current record instead of forcing it.
 */
export interface StoredRecord {
    id: string;
    rev: number;
    created_at: string;
    updated_at: string;
}

/**
 * A record WITHOUT the four bookkeeping fields — the payload `store.create` takes (W1) and
 * the shape factories like {@link defaultGoal} and `duplicateTemplate` hand back. Kept here
 * so a shared factory does not have to import the server-side store module (and drag
 * `node:fs` into the browser bundle) just to name the type.
 */
export type RecordInit<T extends StoredRecord> = Omit<T, 'id' | 'rev' | 'created_at' | 'updated_at'>;

// ---------------------------------------------------------------------------
// §4.1 / §4.2 / §4.4 / §4.17 enums
// ---------------------------------------------------------------------------

/** §4.1 `phase` — the three pipeline stages. `completed` is a STATUS, never a phase. */
export const STORY_PHASES = ['summary', 'plotlines', 'chapters'] as const;
export type StoryPhase = (typeof STORY_PHASES)[number];

/** §4.1 `status` — whether agents may work on the Story (the sweep dispatches `ready` only, L-0). */
export const STORY_STATUSES = ['ready', 'pending', 'completed', 'stopped'] as const;
export type StoryStatus = (typeof STORY_STATUSES)[number];

/**
 * §4.1 `pending_kind` — which flavour of waiting this is. The first four are the loop
 * waiting for the Author BY DESIGN; only `stalled` means the loop hit a wall (P14, L-37a).
 */
export const PENDING_KINDS = [
    'phase_signoff',
    'idea_selection',
    'finding_approval',
    'drained',
    'stalled',
    'none'
] as const;
export type PendingKind = (typeof PENDING_KINDS)[number];

/** §4.1 `trend` — drives the `pending` transition (§6.8). Drained outranks `flat` (L-37a). */
export const TRENDS = ['improving', 'flat', 'regressing', 'unknown'] as const;
export type Trend = (typeof TRENDS)[number];

/**
 * §4.10 `cost` / §4.1 `auto_approve` — the finding costs. One list, two jobs (D-35b): the
 * dial that decides which findings skip the Author's approval gate, and the same dial that
 * sets the drain threshold (L-37). Order is significant: it is the triage scale.
 */
export const FINDING_COSTS = ['critical', 'major', 'minor', 'taste'] as const;
export type Cost = (typeof FINDING_COSTS)[number];

/**
 * The dial's built-in default (D-35): on for `critical` and `major`, off for `minor` and
 * `taste`. Exported so the store, the tools and the UI cannot drift apart on it.
 */
export const DEFAULT_AUTO_APPROVE_COSTS: Cost[] = ['critical', 'major'];

/**
 * §4.12 `roles[].kind` — selects the brief and the PERMISSION ROW, never the tool list
 * (D-17a, T-6a). All four kinds hold the whole catalogue; the server refuses the calls a
 * kind may not make (T-1a).
 */
export const ROLE_KINDS = ['writer', 'editor', 'reader', 'checker'] as const;
export type RoleKind = (typeof ROLE_KINDS)[number];

/** §4.10 `state` — the finding chain: raise (unconfirmed) → verify → approve → fix (D-33, D-34). */
export const FINDING_STATES = ['unconfirmed', 'confirmed', 'approved', 'fixed', 'disputed', 'discarded'] as const;
export type FindingState = (typeof FINDING_STATES)[number];

/**
 * §4.17 `state` — the Idea lifecycle. `refuted`/`unverifiable` are Editor verdicts;
 * `selected`/`discarded`/`deferred` are the Author's decisions, and the decided ones are
 * the anti-loop memory for that phase only (D-32, D-36).
 */
export const IDEA_STATES = [
    'proposed',
    'verified',
    'refuted',
    'unverifiable',
    'selected',
    'discarded',
    'deferred'
] as const;
export type IdeaState = (typeof IDEA_STATES)[number];

/** §4.4 `state` — one chapter's place in the pipeline. */
export const CHAPTER_STATES = [
    'outlined',
    'drafting',
    'in_pass',
    'in_review',
    'needs_author',
    'done',
    'needs_recheck'
] as const;
export type ChapterState = (typeof CHAPTER_STATES)[number];

/** §4.7 `state` — the loop's work queue (D-11). */
export const TASK_STATES = ['open', 'claimed', 'blocked', 'done', 'wontfix'] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** §4.13 `state` — one ephemeral harness, spawn to teardown (S-1, S-3, D-18). */
export const RUN_STATES = ['spawning', 'working', 'reporting', 'torn_down', 'failed', 'abandoned'] as const;
export type RunState = (typeof RUN_STATES)[number];

/** §4.14 `state` — a directive the loop must propagate, not a chat message (D-19). */
export const DIRECTIVE_STATES = ['queued', 'propagating', 'done', 'rejected'] as const;
export type DirectiveState = (typeof DIRECTIVE_STATES)[number];

/**
 * §4.15 `state` — competing attempts at one unit. Everything but `selected` is deleted in
 * the selection commit (P13, D-22); the states exist so the deletion and the Author's
 * restore path (D-24) are expressible, not so drafts linger.
 */
export const REVISION_STATES = ['competing', 'selected', 'merged_into', 'discarded'] as const;
export type RevisionState = (typeof REVISION_STATES)[number];

/** §4.16 `state` — the agent→Author direction only (D-20, D-20a). */
export const PROPOSAL_STATES = ['pending', 'accepted', 'rejected'] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];

/** §4.15 `unit_kind` — the divergence unit: chapter, plotline, or Summary (§14 item 1d). */
export const UNIT_KINDS = ['summary', 'plotline', 'chapter'] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

/** §4.6 `kind` — the ledger's fact classes. */
export const LEDGER_KINDS = ['setup', 'payoff', 'fact', 'timeline', 'world_rule'] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

/** §4.6 `status` — a ledger fact's standing. `conflict` blocks completion (L-25). */
export const LEDGER_STATUSES = ['open', 'paid', 'conflict', 'stale'] as const;
export type LedgerStatus = (typeof LEDGER_STATUSES)[number];

/** §4.17 `kind` — what an Idea is: a direction, a possibility, a fact, or a warning. */
export const IDEA_KINDS = ['direction', 'possibility', 'fact', 'warning'] as const;
export type IdeaKind = (typeof IDEA_KINDS)[number];

/** §4.9 `recommendation` — `stuck` means the checker believes the Story should go `pending`. */
export const VERDICT_RECOMMENDATIONS = ['advance', 'fix', 'stuck'] as const;
export type VerdictRecommendation = (typeof VERDICT_RECOMMENDATIONS)[number];

/** §4.17 `verification.verdict` — the Editor's fact-check answer (D-27, C-15). */
export const IDEA_VERDICTS = ['verified', 'refuted', 'unverifiable'] as const;
export type IdeaVerdict = (typeof IDEA_VERDICTS)[number];

/**
 * §4.4 / §8.1 `sections[].origin` — who produced a chapter section. `author` makes the
 * span propose-only for every agent (P9, T-2, D-37a); the section is the unit that carries
 * it, which is what makes P9 enforceable without freezing the whole chapter (T-2).
 */
export const SECTION_ORIGINS = ['writer', 'author'] as const;
export type SectionOrigin = (typeof SECTION_ORIGINS)[number];

/** §4.15 / §8.2 `aggregate` — how N fresh agents inside one role answer as one (D-38). */
export const ROLE_AGGREGATIONS = ['majority', 'merge', 'lead'] as const;
export type RoleAggregation = (typeof ROLE_AGGREGATIONS)[number];

// ---------------------------------------------------------------------------
// §4.4 `chapters.sections` — the section-addressable prose (D-7)
// ---------------------------------------------------------------------------

/**
 * One addressable section of chapter prose (D-7): "a long chapter is stored as ordered
 * sections so a reviewer can change one paragraph without rewriting the chapter". A
 * whole-chapter rewrite is a separate explicit operation from a section edit (§8.1).
 *
 * D-8 / P11: every write records who did it and why, and this is the only place in the
 * data model where that lives ON the artifact rather than only in the journal — the Author
 * must be able to see, for any paragraph, which run changed it and for what reason (P11),
 * so `last_run_ref` and `last_why` ride on the section itself.
 *
 * T-2: `origin: 'author'` is the Author-written span marker. Agents may only `proposeChange`
 * against it (P9, D-20); D-37a sets it when the Author's edit lands on resume.
 */
export interface ChapterSection {
    id: string;
    text: string;
    origin: SectionOrigin;
    /** The run that last rewrote this section (null/empty when the Author wrote it). */
    last_run_ref?: string | null;
    /** The `why` of that write (T-5) — the audit line P11 demands. */
    last_why?: string;
}

// ---------------------------------------------------------------------------
// §4.1 `stories`
// ---------------------------------------------------------------------------

/**
 * §4.1 — one work of fiction, the unit of the loop (P3: a Story IS its records).
 *
 * D-1: `phase`, `status`, `pending_kind` and the two lock flags are owned by the loop
 * engine and the Author — no agent tool may write them.
 * D-2a: the status machine, including which transitions the loop owns and which the Author owns.
 *
 * ADDED (MAY-add, both pinned by spec rules that need a place to live):
 *   - `template_refs` — the template assignment (D-17b: write permission comes from a
 *     template ASSIGNED to the Story; T-0 validates the assignment; D-38a: the count is the
 *     Author's call, so this is a list, not a single ref).
 *   - `chapter_deps` — L-9's declared dependency set. Not for sequencing (all chapters are
 *     in flight together, L-8): it says which chapters a change must propagate to.
 */
export interface Story extends StoredRecord {
    title: string;
    phase: StoryPhase;
    /** §4.1 / P5: Author-written Seed. Read-only for every agent, every phase, forever. */
    idea: string;
    summary_locked: boolean;
    plotlines_locked: boolean;
    pending_kind: PendingKind;
    status: StoryStatus;
    status_reason?: string;
    consistency?: string;
    trend: Trend;
    goal_ref?: string;
    /** D-35: which costs skip the approval gate (and thereby set the drain threshold, D-35b). */
    auto_approve: Cost[];
    /** P8: Author-only flag — no dispatch, no auto-resume. Distinct from loop-set `pending`. */
    author_stop: boolean;
    progress?: string;
    blocked_on?: string;
    /** §4.8: revision of the current Digest — the engine bumps it when it re-derives (D-12a). */
    digest_rev: number;
    template_refs: string[];
    /** L-9: `chapter_id -> the chapter ids a change to it must propagate to`. */
    chapter_deps: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// §4.2 `summaries` — Phase 1's artifact, one record per Story
// ---------------------------------------------------------------------------

/**
 * §4.2 — the Summary the whole chain is measured against (D-4: `idea → summary → plotlines
 * → chapters`, every artifact naming the one above it).
 *
 * D-3b: two kinds of truth meet in this record. `chapter_count` is AUTHOR TRUTH — declared,
 * never chosen by the Writer, and a hard fact (a deviation is a failing C-0, not a creative
 * choice). The prose fields are the Phase 1 artifact: negotiated until the lock, law after
 * it (P5). D-3c: changing `chapter_count` after the plotlines lock reopens Phase 2 by backtrack.
 */
export interface Summary extends StoredRecord {
    story_id: string;
    chapter_count: number;
    premise?: string;
    promise?: string;
    theme?: string;
    /** Voice, POV, tense, register — the sheet C-12/C-13 are checked against (G-3a). */
    tone?: string;
    ending?: string;
    world_rules?: string;
    /** L-7a: mirrors `stories.summary_locked`. True = even the assistant cannot propose without a backtrack. */
    locked: boolean;
}

// ---------------------------------------------------------------------------
// §4.3 `plotlines` — one per chapter, the chapter's contract
// ---------------------------------------------------------------------------

/** §4.3 + P4: the chapter carries its contract, and the loop asks only "does the artifact deliver it?". */
export interface Plotline extends StoredRecord {
    story_id: string;
    chapter_ref?: string;
    order: number;
    heading?: string;
    /** The events that must occur (C-7). */
    must_happen?: string;
    /** What must be different at the end — state, knowledge, relationship, position (C-8, C-3). */
    must_change?: string;
    pov?: string;
    setups?: string;
    payoffs?: string;
    /** L-7: mirrors `stories.plotlines_locked`. A locked plotline is read-only; agents propose. */
    contract_locked: boolean;
    /** Last verdict's result against the Summary (C-2). */
    aligned: boolean;
    /** §6.5: set by invalidation (L-11, L-11a) — both directions in time. */
    needs_recheck: boolean;
}

// ---------------------------------------------------------------------------
// §4.4 `chapters`
// ---------------------------------------------------------------------------

/**
 * §4.4 — the prose for one Plotline.
 *
 * `content` is NOT a stored field: D-7 requires section-addressable prose and T-2 requires
 * author-span tracking at section granularity, so the prose is stored as `sections` and the
 * §4.4 `content` string is DERIVED from them (`chapterContent`, src/shared/chapter.ts). The
 * field is represented, not dropped — and storing both would put two sources of truth in one
 * record, which is what P3 exists to avoid.
 */
export interface Chapter extends StoredRecord {
    story_id: string;
    plotline_ref?: string;
    order: number;
    title: string;
    summary?: string;
    /** D-7: ordered, individually addressable sections — the whole §4.4 prose. */
    sections: ChapterSection[];
    state: ChapterState;
    /** The revision an Editor selected; the only one that survives (P13). Empty while competing. */
    current_revision?: string;
    /** P9: true = agents propose only, never rewrite. */
    author_locked: boolean;
    /** G-1 / §14 item 2: per-chapter goal override (criterion to drop, or threshold delta). Author-only. */
    bar_override?: string;
    /** Passes run on this chapter — the counter loop detection reads (§6.7). */
    round: number;
    /** `n/m criteria passed` — rendered, never scored (P6). */
    last_score?: string;
}

// ---------------------------------------------------------------------------
// §4.5 `cast`
// ---------------------------------------------------------------------------

/** §4.5 / D-9: `state_now` is a TRACKED fact — a reviewer checks behaviour against `arc` + `state_now`, not vibes (C-9). */
export interface CastMember extends StoredRecord {
    story_id: string;
    name: string;
    want?: string;
    need?: string;
    arc?: string;
    voice?: string;
    state_now?: string;
    traits?: string;
    gender?: string;
}

// ---------------------------------------------------------------------------
// §4.6 `ledger`
// ---------------------------------------------------------------------------

/**
 * §4.6 / D-10: the continuity facts. Mechanical checks over this collection (a setup with
 * no payoff, a timeline out of order, a fact contradiction on a shared key) are CODE
 * criteria — C-5, C-6 — and MUST NOT be delegated to an LLM's judgment (G-3).
 */
export interface LedgerEntry extends StoredRecord {
    story_id: string;
    kind: LedgerKind;
    /** The shared key a contradiction is detected on (D-10). */
    subject: string;
    detail?: string;
    chapter_ref?: string;
    status: LedgerStatus;
    fingerprint?: string;
}

// ---------------------------------------------------------------------------
// §4.7 `tasks`
// ---------------------------------------------------------------------------

/**
 * §4.7 / D-11: the loop's work queue, agent-writable — the queue, not the transcript,
 * holds the plan. `kind` is deliberately free text (P15: a new kind of work must not
 * require a schema change): the build's known values are `fix`, `merge`, `re_brief`,
 * `escalation`.
 */
export interface Task extends StoredRecord {
    story_id: string;
    kind: string;
    title: string;
    detail?: string;
    /** A RoleKind (`writer`/`editor`/`reader`/`checker`) naming who does the work. */
    owner_role?: string;
    state: TaskState;
    priority: number;
    criterion_ref?: string;
    finding_ref?: string;
    /** Attempts on this task — the thing that makes "no progress" visible (L-15). */
    attempts: number;
}

// ---------------------------------------------------------------------------
// §4.8 `digests`
// ---------------------------------------------------------------------------

/**
 * §4.8 / D-12a — the derived standing view every fresh run trusts.
 *
 * D-12a: the Digest is DERIVED, not authored — the loop engine composes it from committed
 * changes, never a crew (the one exception to P10, deliberately). Because it is a pure
 * function of committed history, any past Digest is reconstructible: the Author can see
 * what a reviewer was actually told when it judged chapter 20. It carries no `why` because
 * no one chose it (contrast P11), and the record's inherited `rev` IS `§4.8 rev` — it
 * advances with the commits it summarises.
 */
export interface Digest extends StoredRecord {
    story_id: string;
    /** Bible recap + per-chapter one line + open threads + cast state + last change notes. */
    body: string;
    /** D-14: a stale Digest blocks a review, never a fix. */
    stale: boolean;
    /**
     * ADDED (W6; §4 allows adding fields, forbids renaming or dropping them). §4.8's heading is "one
     * current record per Story, PLUS HISTORY", and the engine keeps every superseded row (D-12a's
     * reconstructibility), so something must mark which row a fresh run would be briefed with. The
     * rebuild flips the previous row to `false` and writes the new one `true`.
     */
    current?: boolean;
    /**
     * ADDED (W6): the journal `seq` this derivation read through. Two jobs, both spec-forced: it is
     * the anchor D-14's staleness test compares against ("a commit after the Digest's rev blocks a
     * review"), and it makes a past Digest LOCATABLE rather than merely guessable — the Author can
     * ask what a reviewer was told three passes ago and slice the journal at this number (D-12a, W6).
     */
    journal_seq?: number;
}

// ---------------------------------------------------------------------------
// §4.9 `verdicts`
// ---------------------------------------------------------------------------

/** §5.1 / §4.9: one pass/fail line of a verdict. D-15: a FAILING line with no evidence is invalid. */
export interface VerdictCriterion {
    criterion: string;
    result: boolean;
    evidence: string;
    finding_ref?: string;
}

/** §4.9 — one run's pass/fail report against a set of criteria (P6: pass/fail, never a score). */
export interface Verdict extends StoredRecord {
    story_id: string;
    target_ref: string;
    /**
     * What kind of artifact was judged. Left as free text on purpose (P15): §4.9 does not
     * close the set, and the build adds `story`/`summary`/`plotline`/`chapter` over
     * {@link UnitKind} as the levels in §5.2 need them.
     */
    target_kind: string;
    run_ref?: string;
    template_ref?: string;
    round: number;
    criteria_passed: VerdictCriterion[];
    hard_pass: boolean;
    /** Soft criteria passed — compared against `goals.threshold_soft` (§5.1). */
    soft_count: number;
    recommendation: VerdictRecommendation;
}

// ---------------------------------------------------------------------------
// §4.10 `findings`
// ---------------------------------------------------------------------------

/**
 * §4.10 — a named defect with evidence and a fingerprint.
 *
 * D-33: from a Reader or checker it starts `unconfirmed` — a suspicion worth nothing until
 * an Editor confirms it. D-34: the Editor rewrites it into the Author's reading surface and
 * sets the cost it actually deserves (D-34a: that triage is final, no appeal). D-16:
 * `fingerprint` = stable hash of (criterion, target, normalised subject); a repeat report
 * bumps `seen_count` instead of creating a new row, and that dedupe is what makes "no
 * progress" detectable in an amnesiac system (§6.7, L-16a).
 *
 * `confirmed_by` / `approved_by` are §12 W1's named fields: `approved_by` is the Author, or
 * the literal `auto` when the Story's dial covered the cost (D-35).
 */
export interface Finding extends StoredRecord {
    story_id: string;
    target_ref: string;
    criterion_ref: string;
    title: string;
    detail?: string;
    /** Required: D-15/T-11 — no verdict or finding without a citable line of evidence. */
    evidence: string;
    cost: Cost;
    fingerprint: string;
    state: FindingState;
    /** The Editor run that confirmed it (D-33), or empty. */
    confirmed_by?: string | null;
    /** The Author, or `auto` (D-35) — the gate that starts Writer work (D-34). */
    approved_by?: string | null;
    seen_count: number;
    /**
     * L-11a: other records this defect touches (a chapter or plotline ref each), so one finding
     * propagates across chapters instead of being re-raised unit by unit.
     *
     * Additive for W2: absent when the reporter named none. It is NOT part of the D-16 fingerprint,
     * so naming new refs on a repeat sighting merges them into the open row rather than opening a
     * second one — which is exactly how a defect first seen in chapter 3 reaches chapter 7.
     */
    related_refs?: string[];
}

// ---------------------------------------------------------------------------
// §4.11 `goals`
// ---------------------------------------------------------------------------

/** §5.1 `checker` — mechanical (server-side, no model call, G-3) vs. LLM judgment. */
export const CRITERION_CHECKERS = ['code', 'judge'] as const;
export type CriterionChecker = (typeof CRITERION_CHECKERS)[number];

/**
 * §5.1 — one pass/fail check. P6: a boolean with a citation, never a 1–10 score, because a
 * fresh context grading numbers is noise. G-6: the question is always answerable against a
 * stored artifact — a criterion whose evidence would be taste rather than citation is a
 * build defect. `hard` = must pass; soft = counts toward `threshold_soft`.
 *
 * It lives in this file rather than in criteria.ts because §4.11's `goals.criteria` field
 * holds these and this module must stay import-cycle free for the store; the roster data
 * and the built-in list live in `./criteria` (which re-exports this type).
 */
export interface Criterion {
    id: string;
    /** Plain-language label shown to the Author (G-2 renders it beside the failure). */
    label: string;
    /** The exact question a fresh reviewer answers (P4). */
    question: string;
    checker: CriterionChecker;
    hard: boolean;
    /** G-2: the smallest change that would satisfy it — every failure names one. */
    fix_hint: string;
}

/**
 * §4.11 / G-4 — the one shared target every crew's brief carries, so many independent
 * fresh reviewers produce a coherent result.
 *
 * G-5 (load-bearing for this shape): there is NO token field, NO minute field and NO round
 * cap. `flat_rounds` and `regress_tolerance` are loop-DETECTION parameters only — they
 * decide when a Story that stopped converging becomes `pending` for the Author (§6.8).
 * Nothing about a Goal can stop a loop; E-0 puts cost out of scope by decision.
 */
export interface Goal extends StoredRecord {
    /** Empty = a reusable preset rather than a Story's own Goal (§14 item 2). */
    story_id?: string;
    title: string;
    threshold_soft: number;
    /** §5.1 criteria, in order (the Author may toggle `hard`, delete, add — G-1). */
    criteria: Criterion[];
    flat_rounds: number;
    regress_tolerance: number;
}

// ---------------------------------------------------------------------------
// §4.12 `templates` — the harness catalogue
// ---------------------------------------------------------------------------

/**
 * §4.12 `roles[]` — one role inside a harness (D-38).
 *
 * D-38: `agents: N` + `aggregate` make one role N fresh agents inside ONE run that return a
 * single answer — the panel lives inside the harness, so the Author's taste is applied once
 * per decision and no vote ever reaches the loop (D-34a survives).
 * D-17a: `kind` selects the brief and the permission row, never the tool list.
 * T-6b: `web` is an instruction hint, not a right — every role may browse; what the flag
 * records is that this role's brief tells it to.
 */
export interface TemplateRole {
    name: string;
    kind: RoleKind;
    /** The brief. D-17a: a kind with no instructions is the actual failure mode. */
    prompt: string;
    model?: string;
    web?: boolean;
    /** D-38: fresh agents of this kind inside one run. */
    agents?: number;
    /** D-38: how those agents collapse to one answer (required when `agents` > 1). */
    aggregate?: RoleAggregation;
}

/**
 * §4.12 — a harness template: a crew definition, not an agent (D-38).
 *
 * D-17c: `selection_rules` is the Editor's brief in the Author's own words — the mechanism
 * by which P12 becomes executable.
 * D-17d: `attempts` is how many parallel revisions one unit spawns; with no cost constraint
 * it defaults ABOVE one, because divergence is the whole advantage of fresh harnesses (E-4).
 * D-17e: `delegation` names the roles this template may delegate to INSIDE its own run —
 * never a Work Item, never a row of its own (S-7, T-2b).
 * D-17: built-ins are duplicated, never edited in place (`builtin` + `editable`).
 * D-38a: `max_concurrent` and `attempts` are the Author's settings, not engine constants.
 */
export interface Template extends StoredRecord {
    /** Slug the Story's `template_refs` and `DEFAULT_ASSIGNMENT` name. */
    name: string;
    title: string;
    description?: string;
    roles: TemplateRole[];
    /** Which phases this harness may be dispatched for (L-4: the three loops are separate templates). */
    serves_phase: StoryPhase[];
    done_definition: string;
    /** D-17c: the Author's own taste, in prose. Editor templates MUST carry it. */
    selection_rules?: string;
    attempts: number;
    /** D-17e: role names this template may delegate to inside its run. */
    delegation?: string[];
    /** P7: when to escalate to the Author rather than halt. */
    escalation_rule?: string;
    /** The phase the Story moves to after this harness's phase signs off; empty = none. */
    next_phase?: StoryPhase | '';
    /** S-5: per-template, per-Story concurrency. */
    max_concurrent?: number;
    builtin: boolean;
    /** D-17: built-ins are duplicate-only. */
    editable: boolean;
}

// ---------------------------------------------------------------------------
// §4.13 `runs`
// ---------------------------------------------------------------------------

/**
 * §9 / S-7: one delegated sub-context (D-17e), nested on the run row that spawned it. It is
 * NOT a Work Item and gets no row of its own in the crew panel — the Author's unit of
 * attention and control is the dispatched run (T-2b: it cannot write what the parent could not).
 */
export interface RunDelegation {
    role: string;
    task: string;
    summary?: string;
    tokens: number;
}

/**
 * §4.13 — one ephemeral harness, alive for exactly one Work Item and one Story (S-1, T-3).
 * D-18: the row exists from spawn to teardown so the Author can watch the crew and kill one.
 * S-3: teardown is unconditional and the row records WHY it ended (`end_reason`).
 * S-4: a run that reported nothing is a `no_op` turn and must count toward loop detection.
 * S-6: `tokens` is informational only — E-0 forbids reading it as a limit.
 */
export interface Run extends StoredRecord {
    story_id: string;
    work_item_ref?: string;
    template_ref?: string;
    role: RoleKind;
    session_ref?: string;
    state: RunState;
    started_at: string;
    ended_at?: string | null;
    tokens: number;
    brief_hash?: string;
    /** ADDED: `work` = a dispatched Work Item; `assistant` = the Author-invoked run of §8.6. */
    kind: 'work' | 'assistant';
    /** S-4: true when the run reported nothing — it counts toward loop detection. */
    no_op?: boolean;
    /** S-3: why the run ended (teardown reason, kill, lease expiry, failure). */
    end_reason?: string;
    /** S-7: delegated sub-contexts, nested here rather than in their own rows. */
    delegated: RunDelegation[];
}

// ---------------------------------------------------------------------------
// §4.14 `directives`
// ---------------------------------------------------------------------------

/** §4.14 / D-19: a line of Author direction the loop must PROPAGATE — tasks, needs_recheck, and a report of what changed. */
export interface Directive extends StoredRecord {
    story_id: string;
    text: string;
    state: DirectiveState;
    /** The plotlines/chapters/ledger entries the loop determined it must touch. */
    impact: string[];
}

// ---------------------------------------------------------------------------
// §4.15 `revisions`
// ---------------------------------------------------------------------------

/**
 * §4.15 — one competing attempt at one unit, held side by side until an Editor selects or
 * merges (P13, D-21: visible to the Editor, the Author, and nobody else).
 *
 * `body` is `unknown` on purpose: its shape depends on `unit_kind` (a Summary's prose
 * fields, a plotline's contract fields, a chapter's `ChapterSection[]`). §4 says "body"
 * without closing the shape, and P15 wants the phase model replaceable without a store
 * rewrite; the unit's `unit_kind` is the discriminator, and W2/W4 validate the payload.
 */
export interface Revision extends StoredRecord {
    story_id: string;
    unit_kind: UnitKind;
    unit_ref: string;
    body: unknown;
    run_ref?: string;
    template_ref?: string;
    brief_hash?: string;
    state: RevisionState;
    verdict_refs: string[];
    /** T-2a / L-17: required on a selection, and it names the rule applied and what each draft was preferred for. */
    selection_note?: string;
}

// ---------------------------------------------------------------------------
// §4.17 `ideas`
// ---------------------------------------------------------------------------

/** T-10: one citation. A page cited for a claim it does not make gets the Idea `refuted`, not "mostly right" (C-15). */
export interface IdeaSource {
    url_or_title: string;
    claim: string;
    accessed_at: string;
}

/** D-27 / D-31: the Editor's two independent answers — is it TRUE, and does this Author WANT it. */
export interface IdeaVerification {
    verdict: IdeaVerdict;
    evidence: string;
    meets_guidelines: boolean;
    checked_by_run: string;
    checked_at: string;
}

/**
 * §4.17 — what Readers and the Author put forward before anything is written.
 *
 * Phase-scoped and temporary (D-36): locking a phase deletes that phase's Ideas — selected,
 * discarded and deferred alike. Within the phase a discarded Idea is NEVER deleted (D-28):
 * a discarded draft is a dead alternative while a discarded Idea is a decision, and the
 * decided list is the memory that stops the next amnesiac Reader re-proposing it (D-32).
 *
 * D-26: a proposal, never an edit. D-27: an Idea carrying `sources` must be verified by an
 * Editor before it can be selected (C-15).
 */
export interface Idea extends StoredRecord {
    story_id: string;
    phase: StoryPhase;
    /** Empty = whole-Story rather than one artifact. */
    unit_ref?: string;
    body: string;
    kind: IdeaKind;
    /** A Reader role name, or the Author (D-26). */
    author: string;
    sources: IdeaSource[];
    /** D-32: a repeat of a DECIDED Idea is reported to the Author with the earlier decision, not re-opened. */
    fingerprint: string;
    seen_count: number;
    state: IdeaState;
    /** D-27 / D-31: null until an Editor has checked it. */
    verification?: IdeaVerification | null;
    selection_note?: string;
    /** D-29: the artifact that absorbed it, once written. */
    absorbed_into?: string;
}

// ---------------------------------------------------------------------------
// §4.16 `proposals`
// ---------------------------------------------------------------------------

/**
 * §4.16 / D-20: where every P9 propose-only edit lands, never in the target field.
 * D-20a: this collection is the agent→Author direction ONLY — the Author's own prose edit is
 * a direct write (attributed `run_ref: null, author: true`), because there is nobody to approve it.
 */
export interface Proposal extends StoredRecord {
    story_id: string;
    target_ref: string;
    target_field: string;
    patch: unknown;
    why: string;
    run_ref?: string;
    state: ProposalState;
}

// ---------------------------------------------------------------------------
// Collection registry
// ---------------------------------------------------------------------------

/**
 * The 17 §4 collection names, in §4 order. Exported as data so the store, the persistence
 * layer and the dashboard can enumerate the model without hardcoding the list in three
 * places (P15: adding a collection must touch one file).
 */
export const COLLECTION_NAMES = [
    'stories',
    'summaries',
    'plotlines',
    'chapters',
    'cast',
    'ledger',
    'tasks',
    'digests',
    'verdicts',
    'findings',
    'goals',
    'templates',
    'runs',
    'directives',
    'revisions',
    'ideas',
    'proposals'
] as const;

export type CollectionName = (typeof COLLECTION_NAMES)[number];

/**
 * `collection -> record type`. The store's typed accessors and the snapshot format both
 * derive from this map, so a new collection is one entry here plus one Store field.
 */
export interface CollectionRecords {
    stories: Story;
    summaries: Summary;
    plotlines: Plotline;
    chapters: Chapter;
    cast: CastMember;
    ledger: LedgerEntry;
    tasks: Task;
    digests: Digest;
    verdicts: Verdict;
    findings: Finding;
    goals: Goal;
    templates: Template;
    runs: Run;
    directives: Directive;
    revisions: Revision;
    ideas: Idea;
    proposals: Proposal;
}

/** Any §4 record — the type the journal, the audit trail and generic tool plumbing need. */
export type AnyRecord = CollectionRecords[CollectionName];

/**
 * `collection -> id singular`, used for the store's `${singular}_${n}` ids (W1). Two
 * collections need a real singular rather than a de-pluralised name (`cast` → a character
 * row, `ledger` → one entry), which is exactly why the map is explicit.
 */
export const COLLECTION_SINGULARS: Record<CollectionName, string> = {
    stories: 'story',
    summaries: 'summary',
    plotlines: 'plotline',
    chapters: 'chapter',
    cast: 'cast_member',
    ledger: 'ledger_entry',
    tasks: 'task',
    digests: 'digest',
    verdicts: 'verdict',
    findings: 'finding',
    goals: 'goal',
    templates: 'template',
    runs: 'run',
    directives: 'directive',
    revisions: 'revision',
    ideas: 'idea',
    proposals: 'proposal'
};
