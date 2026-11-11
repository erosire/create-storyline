// Loop engine types: the `EngineApi` the dashboard and the MCP server call (§6, §9), the deps the
// engine is built from, and the §4-legal additions the loop keeps in the store.
//
// Why the additions exist: §4 is the schema in force (spec:127) — "a build MAY add fields, MUST NOT
// rename or drop one" — and four loop-owned fields have no §4 row yet: the drain probe (L-37's
// condition 3 is a ROUND, so its state must outlive the sweep that started it), the per-round level
// history (L-15: "the level history, which is retained per round"), the closed-fingerprint ledger
// (L-16a: only a fingerprint that had been CLOSED and came back counts as a regression), and the
// per-chapter undo stack (L-17a). `shared/types.ts` is landed and owned by another workstream, so
// the additions are declared HERE as optional interfaces and read through defaulted accessors: a
// record written by any other module loads unchanged, and the loop's own fields ride alongside.
//
// NO BEHAVIOUR LIVES HERE (same rule as `shared/types.ts`): types, plus the constants the loop's own
// rules need at runtime so the dashboard can import them without pulling the engine.
import type { Chapter, Cost, Directive, Finding, Idea, Story, StoryPhase, Task, Template } from '../../shared/types';
import type { GoalStatus, LevelReport } from '../criteria/engine';
import type { DigestBuilder } from '../digest';
import type { CriteriaEngine } from '../criteria';
import type { RunExecutor } from '../run/executor';
import type { WorkItem } from '../run/types';
import type { Store } from '../store';

// ---------------------------------------------------------------------------
// The §4-legal additions the loop maintains (L-3: all loop state is in the store, P1)
// ---------------------------------------------------------------------------

/** L-37's condition 3 is a round of fresh reading, so its state must outlive the sweep that ran it. */
export const PROBE_STATES = ['idle', 'running', 'clean'] as const;
export type ProbeStateKind = (typeof PROBE_STATES)[number];

/**
 * The drain probe — L-37's condition 3, judged at the dial threshold (D-35b).
 *
 * `journal_seq` is the round's watermark: findings and Ideas created after it are what decide
 * whether the round was clean, and the journal's `seq` is the only ordering in this system that
 * survives a restart — timestamps collide inside a sweep, which is why digest.ts:206-231 anchors
 * staleness on the same number (D-14).
 *
 * `dial` is stored so that WIDENING the auto-approve switch invalidates a round that was clean at
 * the old threshold: that is D-35b's "the same switch decides when the crew stops". Narrowing keeps
 * the round valid — a round that found nothing at {critical, major} has, by construction, also found
 * nothing at {critical} alone.
 */
export interface ProbeState {
    status: ProbeStateKind;
    /** The phase the round was run for; a phase change invalidates it (L-37's pass is per phase). */
    phase: StoryPhase;
    /** The checker job's Work Item id, so its verdicts can be tied back to the round (L-14). */
    checker_item_id: string | null;
    /** The reader job's Work Item id — the "fresh round of Readers" half of L-37's condition 3. */
    reader_item_id: string | null;
    /** Journal watermark: anything created after this seq counts as "found this round". */
    journal_seq: number;
    /** The `auto_approve` set the round was judged at, sorted (D-35b). */
    dial: string[];
    started_at: string;
    /** Set when a round finished with nothing at or above the dial; re-confirmed while drained holds. */
    clean_since: string | null;
}

/**
 * L-15's retained level history: one entry per ROUND, oldest first, capped at `LEVEL_HISTORY_LIMIT`.
 *
 * `levels` is stored as rendered counts (`passed`/`total` per level) rather than as criterion ids
 * because L-15 compares levels, not criteria, and because a criterion list is an Author artifact that
 * can be edited mid-flight — an entry that stored criterion ids would read as a level falling purely
 * because the Goal changed. `fingerprint_closed` is L-15's `improving` trigger and
 * `fingerprint_reopened` its `regressing` trigger (L-16a), recorded at the time so the comparison
 * never has to re-derive a past state.
 */
export interface LevelHistoryEntry {
    round: number;
    at: string;
    phase: StoryPhase;
    /** level -> `passed/total`; the same numbers `stories.consistency` renders (L-14). */
    levels: Record<string, string>;
    /** Fingerprints that closed during this round (L-15's `improving`). */
    fingerprint_closed: string[];
    /** Fingerprints that had been closed and came back (L-15/L-16a's `regressing`). */
    fingerprint_reopened: string[];
    /** Findings raised this round that are `confirmed` — L-15a: only confirmed ones count. */
    findings_confirmed_new: string[];
    /** The stall counters as they stood after this round (L-21). */
    flat_streak: number;
    trend: Story['trend'];
    /**
     * Closed runs in the store when this round was measured. A round advances when THIS Story's
     * closed-run count has grown since the last entry (L-15: a round is a pass in which the crew did
     * something), and the streak has to survive a restart (L-3), so the number the comparison used is
     * stored beside the levels it compared.
     */
    runs_closed?: number;
}

/** L-29's sign-off gate and L-25's completion proposal, with L-25b's discard count. */
export interface CompletionProposal {
    proposed_at: string;
    phase: StoryPhase;
    /** What accepting will discard (U-13/U-14: "the prompt states how much it will discard"). */
    leftovers: { findings: number; ideas: number };
    /** L-26: the loop proposes; nothing about this row closes anything until the Author accepts. */
    accepted: boolean;
    /** L-30: a discard is a real signal and survives the proposal being cleared. */
    discarded: number;
}

/** L-17a: one snapshot pushed by an undoable Author verb, newest last. */
export interface UndoEntry {
    at: string;
    /** The verb that pushed it (`applyAuthorEdit`, `undoLast` itself is not undoable). */
    verb: string;
    /** The section the change touched, so the row can name it (U-4's undo affordance). */
    section_id: string;
    /** What the verb did, in one line — the journal's `why` for the same change (P11). */
    summary: string;
    /** The whole chapter as it was before the change; this is the payload `undoLast` re-commits. */
    snapshot: Chapter;
}

/**
 * §4.14's `impact` field is the list of refs the directive touched (spec, §4.14). The ADDITION below
 * carries what answering the directive DID to the open work — the report W12's acceptance row demands
 * ("reports what it touched") and the L-24/L-27 answer an escalation needs to be auditable.
 */
export interface DirectiveReport {
    /** Runs killed because they were working on an artifact the directive just changed (P8's mechanism). */
    runs_stopped: number;
    /** Fix work the directive created (D-19: "tasks"). */
    tasks_created: number;
    /** Queue rows that answered escalation made moot (P7) — superseded, not done (D-11 keeps the plan). */
    tasks_superseded: number;
    /** Chapters and plotlines that took a `needs_recheck` marker (L-11a). */
    needs_recheck: string[];
    /** Ledger entries the directive named (§4.14's impact includes ledger entries). */
    ledger_touched: string[];
    /** The escalation this answer resolved (P7, L-24), or null. */
    answered_task_id: string | null;
    /** L-27: a directive on a completed Story returns it to `ready` — the report says so. */
    completed_reopened: boolean;
}

// ---------------------------------------------------------------------------
// The additive aliases: read any record through these to see the loop's fields
// ---------------------------------------------------------------------------

/**
 * `Story` plus the loop-owned additions.
 *
 * `flat_streak` lives here too: L-21 counts rounds, and §4.1's Story row carries `trend` but not the
 * counter that produced it, so the counter would otherwise have to be re-derived from
 * `level_history` on every sweep (it can, but only while the history cap has not dropped the
 * rounds that matter).
 */
export interface LoopStoryAdditions {
    /** L-15's round counter: a round is a sweep in which at least one of this Story's runs reported. */
    round?: number;
    /** L-21: consecutive rounds in which every reached level was unchanged (L-15's `flat`). */
    flat_streak?: number;
    /** L-37's condition 3 — the drain probe. Absent means "never probed". */
    probe?: ProbeState;
    /** L-15's per-round level history, oldest first. */
    level_history?: LevelHistoryEntry[];
    /** L-16a: fingerprints that have closed at least once, so a reappearance is a regression. */
    closed_fingerprints?: string[];
    /** L-25/L-26: the completion proposal the Author has not answered yet. */
    completion?: CompletionProposal;
}

export type LoopStory = Story & LoopStoryAdditions;

/**
 * THE ADDITIVE FIELDS, DECLARED WHERE THE STORE TYPES ITS PATCHES.
 *
 * §4 says collections "are normative in name and field; a build MAY add fields, MUST NOT rename or
 * drop one" (spec:§4 preamble). The loop's bookkeeping — round counter, level history, the drain
 * probe, the fingerprint ledger, the completion proposal, the per-chapter undo stack, the directive's
 * impact report — is exactly that: added fields. Declaring them once through interface merging is
 * how the build states the allowance in TypeScript, so `store.stories.update(id, { probe })` and
 * `store.chapters.get(id).undo_stack` both typecheck without a cast at every call site, and a
 * dashboard that wants to show the probe reads the same declaration.
 *
 * The augmentation adds fields only: nothing here renames or drops a §4 field, and none of these
 * fields is required, so a Story written by another module is still a valid Story.
 */
declare module '../../shared/types' {
    interface Story extends LoopStoryAdditions {}
    interface Chapter extends LoopChapterAdditions {}
    interface Directive extends LoopDirectiveAdditions {}
}

/** L-17a's per-chapter undo stack. Newest last, capped at `UNDO_STACK_LIMIT`. */
export interface LoopChapterAdditions {
    undo_stack?: UndoEntry[];
}

export type LoopChapter = Chapter & LoopChapterAdditions;

/** D-19's impact report, beside §4.14's `impact` ref list. */
export interface LoopDirectiveAdditions {
    report?: DirectiveReport;
}

export type LoopDirective = Directive & LoopDirectiveAdditions;

/**
 * L-32's "a `related` field each" — §4.10 already carries `related_refs` (spec:515-523), so the loop
 * writes its propagation hints there rather than inventing a second field. No addition needed; the
 * alias exists so call sites read as loop-owned.
 */
export type LoopFinding = Finding;

/** L-19/D-29: an Idea the loop has queued for a Writer is still just an Idea in a known state. */
export type LoopIdea = Idea;

/** §4.7's `kind` is free text on purpose (P15); these are the kinds THIS build's queue uses. */
export const TASK_KINDS = {
    /** Fix one confirmed finding — the D-34 gate's output, and what `owner_role: writer` runs on. */
    fix: 'fix',
    /** Re-brief after the Editor rejected every draft (L-18). */
    rewrite: 'rewrite',
    /** The Editor's merge request: parts named, the Writer composes (L-19). */
    merge: 'merge',
    /** Absorb an Idea the Author selected (D-29). */
    absorb: 'absorb',
    /** Propagate an Author directive (D-19). */
    directive: 'directive',
    /** A run's escalation awaiting the Author (`requestAuthor`, P7) — the queue's blocked row. */
    escalation: 'escalation',
    /** The phase sign-off the Author owes (L-29); the loop's own marker, never a Writer job. */
    signoff: 'signoff'
} as const;

/** Task kinds a Writer or Editor can act on — L-37's condition 1 reads exactly this set. */
export const DISPATCHABLE_TASK_KINDS: string[] = [
    TASK_KINDS.fix,
    TASK_KINDS.rewrite,
    TASK_KINDS.merge,
    TASK_KINDS.absorb,
    TASK_KINDS.directive
];

/** Task states that are still waiting for a crew (L-37's condition 1). `blocked` is the Author's. */
export const OPEN_TASK_STATES: Task['state'][] = ['open', 'claimed'];

/** Finding states that still count as work (L-37's condition 2 covers `unconfirmed` explicitly). */
export const OPEN_FINDING_STATES: Finding['state'][] = ['unconfirmed', 'confirmed', 'approved', 'disputed'];

/**
 * L-15a: the finding states that count toward `trend` and the stall — `confirmed` (and anything
 * downstream of confirmation). An `unconfirmed` suspicion re-raised by an amnesiac reviewer is not
 * evidence the Story is stuck, and `disputed` is the Editor's "not a defect" (D-33, D-34a).
 */
export const CONFIRMED_FINDING_STATES: Finding['state'][] = ['confirmed', 'approved'];

/** A fingerprint is closed when its finding reached one of these (L-15's `improving`, L-16a). */
export const CLOSED_FINDING_STATES: Finding['state'][] = ['fixed', 'discarded'];

/** Idea states that need the Author before the phase can advance (L-7a, D-29). */
export const UNDECIDED_IDEA_STATES: Idea['state'][] = ['proposed', 'verified', 'refuted', 'unverifiable'];

/**
 * D-35's approval marker. §4.10 names the value `auto` in prose ("the literal `auto`"), and the
 * dashboard's U-10a row distinguishes it from the Author's name, so this is the string the store
 * holds in `findings.approved_by`.
 */
export const AUTO_APPROVED_BY = 'auto';

/** The Author's own marker for writes the engine performed on their instruction (P11 attribution). */
export const AUTHOR_ATTRIBUTION = 'author:engine';

/** L-15a/W7: how many rounds of level history the Story keeps. The spec leaves the window open. */
export const LEVEL_HISTORY_LIMIT = 50;

/** L-16a: the closed-fingerprint ledger is bounded so a long Story cannot grow it forever. */
export const CLOSED_FINGERPRINT_LIMIT = 200;

/** L-17a: how many undo steps one chapter keeps. §14 leaves the depth open; 8 is a working guess. */
export const UNDO_STACK_LIMIT = 8;

/** S-5's global fan-out ceiling default, used when the config omits one. */
export const DEFAULT_GLOBAL_MAX_CONCURRENT = 4;

/** D-36/S-4a: a run row untouched for this long has a dead owner and its lease has lapsed. */
export const DEFAULT_LEASE_IDLE_MS = 120_000;

/** L-1's cadence. Tests drive the sweep directly; this only bounds the idle wait between sweeps. */
export const DEFAULT_SWEEP_INTERVAL_MS = 500;

/**
 * §4.10's `approved_by` for the two approval paths. The dial writes `auto` (D-35: the Story's setting
 * approved it, not the Author) and the Author's click writes `author`; D-34a's "who approved this?" is
 * answerable from the row because the two paths cannot be confused.
 */
export const AUTHOR_APPROVED_BY = 'author';

// ---------------------------------------------------------------------------
// What a sweep decides and dispatches
// ---------------------------------------------------------------------------

/**
 * One job the loop has chosen to run, before the claim and the capacity cut.
 *
 * `item.id` is the claim key (L-2): it is deterministic for the job, so "already claimed" is a query
 * over live `runs` rows by `work_item_ref` rather than a flag the engine could lose. `why` is the
 * dispatch reason, surfaced on the sweep report and in the story's `status_reason` neighbours.
 */
export interface WorkCandidate {
    /** Deterministic claim key, carried as `WorkItem.id` and therefore as `runs.work_item_ref`. */
    key: string;
    item: WorkItem;
    /** Per-template, per-Story cap (S-5); the global cap comes from the engine config. */
    max_concurrent: number;
    why: string;
    /** Queue priority (S-5 fills capacity in this order; 1 is most urgent). */
    priority: number;
    /**
     * Order WITHIN a priority class, lowest first, for the rare case where the class itself does not
     * decide who goes next. The checker rotation in `work.ts` is that case: three drafts of one chapter
     * all sit at priority 2, and the claim-key tie-break would hand the same draft to every sweep.
     * Absent means 0. Like the priority and the key, it is a pure function of the records (the rotation
     * comes from the dispatch count), so a restarted engine picks the same next draft (L-3).
     */
    rank?: number;
}

/** One Story's sweep outcome, returned so tests and the dashboard need no logs to read a decision. */
export interface StorySweepReport {
    story_id: string;
    phase: StoryPhase;
    status: Story['status'];
    pending_kind: Story['pending_kind'];
    status_reason: string;
    /** L-14's rendered sentence, exactly as `stories.consistency` now holds it. */
    consistency: string;
    /** The phase Goal as the criteria engine renders it (`n/m · failing: …`, G-2). */
    goal: GoalStatus;
    trend: Story['trend'];
    /** The drain probe's state after this sweep (L-37). */
    probe: ProbeStateKind;
    /** True when this sweep raised the completion proposal (L-25). */
    completion_proposed: boolean;
    /** Jobs this Story wanted before capacity cut them. */
    wanted: WorkCandidate[];
    /** Work Item ids this Story started. */
    started: string[];
    /** Claim key -> why it was held back (L-2's dedupe, S-5's capacity, a lapsed lease). */
    deferred: Record<string, string>;
    /** Findings the dial approved this sweep (D-35), by id. */
    auto_approved: string[];
    /** Run rows whose lease lapsed (S-4a) or that a stop killed (P8). */
    killed_runs: string[];
    /** Chapters that took a `needs_recheck` marker from propagation this sweep (L-11a). */
    rechecks: string[];
}

/** One `sweep()` across every Story (L-1). */
export interface SweepReport {
    at: string;
    stories: StorySweepReport[];
    runs_started: number;
    /** Runs this sweep observed closing, so a caller can await a slice by watching the counters. */
    runs_finished: number;
    /** Work Item ids whose lease lapsed this sweep (S-4a). */
    /** The Work Item keys whose runs lost their lease this sweep (S-4a) — the job that came back. */
    leases_lapsed: string[];
    /** Set when the loop-level switch refused the sweep entirely (L-1, `setStopped`). */
    skipped: boolean;
}

// ---------------------------------------------------------------------------
// The API (§6/§9's pinned surface: the dashboard and the MCP server call exactly these)
// ---------------------------------------------------------------------------

/** L-1/L-16b: `setGoal` merges a patch into the Goal record the Story measures against. */
export type GoalPatch = Partial<
    Pick<import('../../shared/types').Goal, 'title' | 'threshold_soft' | 'flat_rounds' | 'regress_tolerance'>
> & {
    /** The §5.1 criteria list, replaced wholesale (G-1: the Author toggles, deletes, adds). */
    criteria?: import('../../shared/types').Criterion[];
};

/** What `createStory` accepts. Everything is optional because §15 step 0 is a UI flow, not an API contract. */
export interface CreateStoryInput {
    /** §4.1 `title`, Author-set. Defaults to the Seed's first line. */
    title?: string;
    /** §4.1 `idea` — the Seed. Author truth, read-only for every agent forever (P5). */
    idea?: string;
    /** §4.2 `chapter_count`, Author-declared (D-3b). Defaults to 1 so C-0 has a fact to count. */
    chapter_count?: number;
    /** The Goal row's initial shape; omitting it leaves the evaluated default in place. */
    goal?: GoalPatch;
    /** D-35's dial. Defaults to `['critical', 'major']` (D-35). */
    auto_approve?: Cost[];
    /** §4.12 slugs to assign. Defaults to `DEFAULT_ASSIGNMENT` (D-17b). */
    template_refs?: string[];
}

/** What `changeChapterCount` returns, because D-3c's removal needs an explicit confirmation first. */
export interface ChapterCountResult {
    /** Set when chapters would be removed and `opts.confirm` was not given — nothing was deleted. */
    pending_confirm?: true;
    /** Chapters created as `outlined` (D-3c). */
    created?: string[];
    /** Chapters removed after the confirm (D-3c). */
    removed?: string[];
    /** Chapters marked `needs_recheck` because the sequence moved (D-3c, L-11). */
    needs_recheck?: string[];
}

/** What `assignTemplates` returns: the assignment is refused while runs are live unless confirmed. */
export interface AssignTemplatesResult {
    /** Live runs the change would strand; the caller confirms and retries to force it. */
    changed_live_runs?: number;
    /** Set when `opts.confirm` was required and absent — nothing was written. */
    confirm_required?: true;
    /** §4.12 slugs the Story now holds. */
    assigned?: string[];
    /** T-0/D-17b problems with the assignment, empty when it validates. */
    errors?: string[];
}

/**
 * The loop API. Every method that changes state does it inside ONE `store.commit` (P1's transaction
 * discipline) and takes the store's compare-and-set on every record it rewrites.
 *
 * SIGNATURE NOTE: the brief pinned these as synchronous. `Store.commit` is asynchronous, so the
 * implementations return the commit's promise. That is source-compatible with a `void`-returning
 * interface (TypeScript accepts a promise where `void` is declared), so a dashboard that does not
 * await still compiles — but it should await, or it cannot tell a committed change from a refused
 * one. This is an API delta against the brief, not a deviation from it.
 */
export interface EngineApi {
    /** L-1: starts the sweep. The engine is built stopped so a restart can recover before it moves. */
    start(): void;
    /** L-1/L-2: stops scheduling. In-flight runs are left alone; a later sweep re-adopts or abandons them. */
    stop(): void;

    /** §15 step 0: a Story starts at phase `summary`, `ready`, with the Seed and the declared count. */
    createStory(input?: CreateStoryInput): Promise<{ story_id: string }>;

    /** L-1: the loop-level switch, independent of any Story's own status. */
    setStopped(stopped: boolean): void;

    /**
     * D-37's **Pause & edit**: the Story-level cord. It is NOT the loop switch above — the other Stories
     * keep being swept — and it is the only way the prose pane opens: `applyAuthorEdit` refuses anything
     * but a stopped Story, naming D-37. `resumeStory` is the hand-back (D-37a, D-37b).
     */
    pauseStory(storyId: string): Promise<void>;

    /**
     * D-2a/D-37b: the Author's clear. Un-pauses a `pending` or `stopped` Story and re-derives from the
     * records — a resume after a prose edit re-derives the Digest and propagates `needs_recheck`
     * (D-37a), and nothing about the edit is treated as a defect (D-37b).
     */
    resumeStory(storyId: string): Promise<void>;

    /** L-36/U-1b: one click removes the tasks that would otherwise be dispatched. */
    clearPending(storyId: string): Promise<void>;

    /** L-6a/L-7/L-7a: the sign-off. Locks the phase's artifact, empties that phase's Ideas (D-36). */
    lockPhase(storyId: string, phase: StoryPhase): Promise<void>;

    /** L-31/D-25: the only way a lock opens. Scraps every later artifact, keeps the provenance. */
    backtrack(storyId: string, phase: StoryPhase): Promise<void>;

    /** D-3c: grow creates `outlined` chapters; shrink needs a confirm and holds the prose. */
    changeChapterCount(storyId: string, count: number, opts?: { confirm?: boolean }): Promise<ChapterCountResult>;

    /** D-25a: editing the Seed is a full backtrack to phase `summary`; the Idea record is the Seed. */
    editSeed(storyId: string, text: string, opts?: { confirm?: boolean }): Promise<void>;

    /** D-34/D-35: the approval that starts Writer work. `by` distinguishes `auto` from the Author (D-41c). */
    approveFinding(findingId: string, opts?: { cost?: Cost; by?: string; note?: string }): Promise<void>;

    /** D-29: the Author's pick, recorded as a decision; the rest of the tray is decided in the same pass. */
    decideIdea(ideaId: string, picked: string[], note?: string): Promise<void>;

    /** D-37/D-37a: the Author's own prose edit — refused while the Story runs, undoable, marks the span Author-written. */
    applyAuthorEdit(chapterId: string, sectionId: string, text: string, opts?: { undoable?: boolean }): Promise<void>;

    /** L-10: the Author's word outranks the criteria — re-opening a chapter wakes the crew. */
    unapproveChapter(chapterId: string): Promise<void>;

    /** D-20: the propose-only tray. This is the same decision surface as an Idea, not a separate flow. */
    decideProposal(proposalId: string, verdict: 'accepted' | 'rejected' | 'deferred', reason?: string): Promise<void>;

    /** L-17a: restores the most recent change to that chapter. */
    undoLast(chapterId: string): Promise<void>;

    /** D-19/L-24/L-27: answering an escalation, with the impact the loop determined. */
    processDirective(
        storyId: string,
        text: string,
        refs?: string[]
    ): Promise<{ directive_id: string; impact: DirectiveReport }>;

    /** L-25/L-26/L-25b: accepting is the last sign-off; discarding keeps the crew working. */
    acceptCompletion(storyId: string, accept: boolean): Promise<void>;

    /** G-1/L-16b: editing the Goal re-derives everything the criteria read (the next sweep does it). */
    setGoal(storyId: string, patch: GoalPatch): Promise<void>;

    /** G-1/§14 item 2: the per-chapter bar, written into §4.4's `bar_override` text. */
    setChapterBar(storyId: string, chapterId: string, criteria: string[]): Promise<void>;

    /** D-17b/D-38a/L-4: changing the assignment re-derives on the next sweep; live runs need a confirm. */
    assignTemplates(
        storyId: string,
        assignments: Record<string, string[]> | string[],
        opts?: { confirm?: boolean }
    ): Promise<AssignTemplatesResult>;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/** L-5/S-5's caps and D-36/S-4a's lease window. */
export interface LoopEngineConfig {
    /** S-5: the global fan-out ceiling, on top of each template's own `max_concurrent`. */
    globalMaxConcurrent?: number;
    /** How often `sweep()` runs when the loop is started. Tests call `sweep()` by hand instead. */
    sweepIntervalMs?: number;
    /**
     * D-36/S-4a: a run row untouched for this long has a dead owner, so its lease has lapsed and the
     * Work Item returns to the queue. The heartbeat is the run row's `updated_at`, which the executor
     * bumps on every state transition; the sweep checks it (no clock, no timeout — S-4a).
     */
    leaseIdleMs?: number;
    /** Auto-sweep on `start()`. Defaults to false so a test drives every sweep itself (L-1). */
    autoSweep?: boolean;
}

/**
 * The engine reads nothing but the store, and never imports the tool layer (§6's independence rule:
 * the loop dispatches Work Items; what a harness does with its tools is the run layer's business).
 */
export interface LoopEngineDeps {
    store: Store;
    executor: RunExecutor;
    criteria: CriteriaEngine;
    digest: DigestBuilder;
    config?: LoopEngineConfig;
}

/** The resolved form of the config, so no method has to re-default it. */
export interface ResolvedEngineConfig {
    globalMaxConcurrent: number;
    sweepIntervalMs: number;
    leaseIdleMs: number;
    autoSweep: boolean;
}

/** Re-exported so the loop's own modules and the dashboard read one source for these two shapes. */
export type { LevelReport, Template };
