// §10 / W9-W13 — the browser-side client for the server's `/v1/storyline` surface.
//
// THE ONE NETWORK LAYER. The server owns the HTTP contract in the separate `@underload/storyline`
// package (`src/storyline-server.swagger.yaml` there); this module is the dashboard's only
// implementation of it. Components render store snapshots and
// call store methods; neither imports a server module, calls the model provider, opens a harness
// socket, or executes a harness tool. A second transport in the UI would be a second backend, and
// the dashboard is deliberately a client of the Storyline server and nothing else.
//
// Everything the dashboard renders therefore lives here under a name both sides agreed to: the
// method names (T9 imports exactly these), the row/view projections (`StoryRow`, `StoryView`,
// `QueueItem`), and the SSE event names. The record shapes themselves are NOT redefined — they
// come from `src/types.ts` (§4 is normative in name and field), and only the server-computed
// PROJECTIONS are declared here.
//
// PROJECTIONS VS RECORDS: `StoryRow` is not `Story` — it carries the criteria engine's
// rendered strings (`levels`, `progress`, `blocked_on`, §6.7 L-14/W3 "renders as
// `n/m · failing: …` for the current phase only"). The dashboard must never recompute a
// level client-side: W3 owns the engine, and a second implementation would drift from L-14.
//
// ERRORS: every non-2xx response carries `{error: string}` and is thrown as `ApiError`
// with the SERVER's text. This matters beyond plumbing: the 409s are the product's
// sentences — "the Ideas tray still holds 3 proposed Ideas" (L-7a), "D-37: pause the Story
// before editing prose" — and the Author reads exactly what the server said (L-13: an
// explanation, not a log line).
//
// NO `import.meta.env` READ: the root is one constant, `/v1/storyline`, which
// `vite.config.ts` proxies to the gateway in dev. A configurable root would be a second
// source of truth for something the proxy already decides.

import type {
    CastMember,
    Cost,
    Criterion,
    CriterionChecker,
    CriterionLevel,
    Chapter,
    Digest,
    Finding,
    Goal,
    Idea,
    LedgerEntry,
    Proposal,
    Revision,
    Run,
    SeedBriefState,
    Story,
    StoryPhase,
    StoryStatus,
    Summary,
    Plotline,
    Task,
    Template,
    PendingKind,
    Trend,
    Verdict
} from '../types';

/** The one root the UI dials (dev proxy → gateway; see `vite.config.ts`). */
export const API_ROOT = '/v1/storyline';

/** The chunk size the desk asks list routes for; the server caps a chunk at 500. */
export const PAGE_SIZE = 50;

/** A list request's chunk window. Both fields are omitted on the pre-pagination calls. */
export interface PageOptions {
    limit?: number;
    offset?: number;
}

/** SSE topics the server emits (`data:` is the affected story id, empty for workspace-wide). */
export type StreamKind = 'story' | 'runs' | 'queue';

/** Poll cadence for the no-`EventSource` fallback (§10 clients refetch on event; W9). */
const FALLBACK_POLL_MS = 5000;

/**
 * R1 — the key the store's cached lock refusals are filed under, and the pane's lookup reads the same helper.
 *
 * It lives in `api.ts` (not here, not in the contract) because BOTH sides need one spelling: `state.ts` writes
 * `groupLockErrors[groupLockKey(story, group)]` and `SummaryGroupPane` reads it through
 * `story-contract.groupLockError`. A string built in two places is a cache that misses silently.
 */
export const groupLockKey = (storyId: string, groupId: string): string => `${storyId}:${groupId}`;

// ---------------------------------------------------------------------------
// Projections (server-computed; the dashboard renders, never recomputes)
// ---------------------------------------------------------------------------

/**
 * §6.7 L-14 / W3 — the three phase-boundary levels plus the whole-story level, each already
 * rendered as `n/m`, `n/a` (a phase not reached is `n/a`, never `0/n`), or the failing list.
 */
export interface StoryLevels {
    summary: string;
    plotlines: string;
    chapters: string;
    whole: string;
}

/**
 * §10.2 U-1 — one STORIES-panel row. `pending_kind` + `status` drive the two-tone wait
 * (U-1b / L-34); `levels`/`trend` are W3's and W7's rendered output; `active_runs` +
 * `progress` are U-2's "what the crew is doing to it right now" (U-11: prose, not a spinner).
 */
export interface StoryRow {
    id: string;
    title: string;
    phase: StoryPhase;
    status: StoryStatus;
    pending_kind: PendingKind;
    status_reason?: string;
    summary_locked: boolean;
    plotlines_locked: boolean;
    levels: StoryLevels;
    trend: Trend;
    progress?: string;
    blocked_on?: string;
    auto_approve: Cost[];
    active_runs: number;
    completion_proposed: boolean;
}

/**
 * T12 — what ONE phase lock did, as the `/lock` response's additive `lock_receipt` (swagger's
 * `PhaseLockReceipt`; the object `server/api/routes.ts:/stories/:id/lock` builds).
 *
 * WHY IT IS ADDITIVE AND OPTIONAL. The pinned client reads the lock response as a `StoryRow`, and every row
 * field is byte-stable across the change — the accept's accounting is a NEW OBJECT beside the row, not a wider
 * row, so a client that ignores it is unaffected. `lock_receipt` is therefore optional on the response type:
 * a body from before the receipt exists is one this client still has to survive.
 *
 * WHY THE THREE OPTIONAL FIELDS ARE OPTIONAL RATHER THAN ZERO-BY-DEFAULT: they are Summary-leg facts. A
 * `plotlines` or `chapters` lock voids no finding, closes no task and starts no phrase, so a `0` there would
 * report a decision the Author never took — absent means "that leg writes no such rows" (L-25b's accounting,
 * recorded from inside the lock commit by `loop/invalidation.ts:lockWrites`). Likewise `phrase_started: false`
 * on the summary leg is a successful NO-OP with its reason beside it (already started, nothing compiled to
 * copy, or the classic lane), never a failed lock.
 *
 * TYPING ONLY — NOTHING RENDERS IT. The desk computes the accept's counts off its own phrase read
 * (`story-contract.ts:summaryAcceptLeftovers`), so this type exists so the client and the wire agree, not so
 * the rail can read the receipt instead.
 */
export interface PhaseLockReceipt {
    /** The phase the lock closed — the phase the Story was on when the request landed. */
    phase: StoryPhase;
    /** D-36 — the phase's Ideas rows the lock deleted, decided rows included. */
    deleted_ideas: number;
    /** L-7 — the phase the Story moved to; null when the lock IS the completion (L-25a). */
    next_phase: StoryPhase | null;
    /** R3 — findings on the SUMMARY PHRASE the accept voided to `discarded`. Summary leg only. */
    voided_findings?: number;
    /** R3 — queued jobs the accept closed as `wontfix`. Summary leg only. */
    wontfixed_tasks?: number;
    /** R4 — true only when THIS accept created the Plotlines Phrase, seeded from the compiled Summary. */
    phrase_started?: boolean;
    /** `''` when it started; otherwise the sentence the rail shows under a successful accept. */
    phrase_start_reason?: string;
}

/** `POST /stories/:id/lock` — the Story row the desk already reads, plus the receipt beside it. */
export type PhaseLockResult = StoryRow & { lock_receipt?: PhaseLockReceipt };

/** §10.2 U-6 — one failing criterion with the smallest change that would clear it (G-2). */
export interface FailingCriterion {
    criterion: string;
    fix_hint: string;
    evidence?: string;
}

/** One Goal level, as the server projects its label, question and criterion set (U-6 / §5.2). */
export interface GoalLevelView {
    key: CriterionLevel;
    label: string;
    question: string;
    criteria: string[];
}

/**
 * The product vocabulary a Story frame carries — every list and default the desk renders that the
 * server owns. The UI does not keep a second copy of these values: the projection sends them, and a
 * test may stand in its own mock (`dashboard/testing/product-values.ts`).
 */
export interface StoryVocabulary {
    finding_costs: Cost[];
    default_auto_approve: Cost[];
    summary_sampling_default: number;
    summary_critics_default: number;
    summary_review_limit: number;
    criterion_checkers: CriterionChecker[];
    goal_levels: GoalLevelView[];
    per_chapter_criteria: string[];
}

/** §5.1 / U-6 — the Goal plus live pass/fail per phase and per chapter (rendered by W3). */
export interface GoalSurface {
    goal: Goal;
    phase_progress: string;
    failing: FailingCriterion[];
    chapter_progress: Record<string, string>;
}

/** U-10a / D-35 — what the dial is currently skipping, and how often the Editor downgraded. */
export interface CostDistribution {
    confirmed_per_cost: Record<Cost, number>;
    downgrades: number;
}

/**
 * U-14 / L-25b — what accepting completion will discard, stated as a count so the Author
 * waves things away with their eyes open rather than pretending they were never raised.
 */
export interface CompletionPreview {
    open_findings: number;
    open_ideas: number;
    oldest?: string;
}

/**
 * §10 / §3.3 — the ACCEPTED Seed Brief as the Story view carries it: the Editor's derived,
 * machine-readable projection of the Seed, TRIMMED to the reading surface (the arrays —
 * `world_rules`, `constraints`, `open_questions` — belong to the prompt compiler, not the pane).
 * Read-only by construction: the Seed itself stays `stories.idea` and is never edited (P5).
 */
export interface SeedBriefView {
    id: string;
    /** Hash of the Seed text this brief was derived from; a Seed edit re-arms the structuring (§3.3). */
    seed_hash: string;
    logline: string;
    protagonist: string;
    want: string;
    obstacle: string;
    stakes: string;
    setting: string;
    promise: string;
    /** `accepted` for every brief this projection sends null-less; the state travels for the pane's badge. */
    status: SeedBriefState;
}

/**
 * One sample's screening tally, as the selector ranked it (§6.5: critical, then high, then total),
 * PLUS the half of the record that only the hill-climb audit carries.
 *
 * `outcome` is why a candidate is on this line at all: `accepted` (the one the round installed),
 * `eligible` (it could have been, and lost to a smaller change), or `rejected` (the gate refused it).
 * The selection commit hard-deletes the losing draft AND its `sample_reviews` rows (P13/§6.6), so this
 * field and `reject_reason` are the only surviving answer to "why did the round not install it" — a
 * count tells the Author the draft had a high; the reason says whether it was a regression, an
 * uncertified fix, or a screening leg that never answered.
 *
 * The origin split (`introduced_*` / `inherited_*`) and the minimality counts (`changed_*`) exist only
 * for a candidate measured AGAINST AN ACCEPTED DRAFT: in round 1 there is nothing to inherit and
 * nothing to be minimal about, so their absence is a fact about the round, not a missing value. A
 * history line written before the hill exists omits all of them.
 */
export interface SamplingSample {
    revision_id: string;
    critical: number;
    high: number;
    outcome?: 'accepted' | 'eligible' | 'rejected';
    reject_reason?: string;
    introduced_critical?: number;
    introduced_high?: number;
    inherited_critical?: number;
    inherited_high?: number;
    changed_fields?: number;
    changed_characters?: number;
}

/**
 * One completed sampling round's P11 audit line (`Story.sampling_history`, shared/types.ts §3.6).
 * The losing samples are hard-deleted by the selection commit (P13/D-22), so this row — ids, issue
 * counts, validity, the fixes each one left outstanding, and the selected id — is the only surviving
 * record of what competed (§2 item 5).
 *
 * `unresolved_fixes` is H1's half of that record (H1-C1/F3): the round's rejection is not a count, it
 * is the `fix` task the candidate failed, and the task rows themselves may already be `wontfix` by the
 * time the Author reads this pane. The projection sends it as a list on EVERY row — `[]` means "this
 * candidate owed nothing, or cleared everything it owed", and a history line written before the field
 * existed is normalised to `[]` rather than sent as absent, so a consumer never branches on the build.
 *
 * THE HILL'S LEDGER (H2) is the other half: which WAVE this round ran in, how many attempts the wave
 * spent, how many improvements it proved, the ceiling that bounded it, and the unresolved-blocking bar
 * the install left behind. They are sent as a group and only when the row recorded them: unlike
 * `unresolved_fixes`, a zero here would be a FALSE fact rather than an empty list — a pre-hill row does
 * not know how many attempts it spent — so the absence is the honest payload and the pane renders it as
 * "not recorded" rather than as 0. The wave number is what tells the Author whether the row predates
 * their clear (wave 0) or came after it (wave 1+), which is the difference between a hill that stalled
 * and a hill that was restarted.
 */
export interface SamplingHistoryRow {
    round: number;
    at: string;
    samples: Array<SamplingSample & { valid: boolean; unresolved_fixes: string[] }>;
    selected: string;
    wave?: number;
    attempts?: number;
    improvements?: number;
    ceiling?: number;
    unresolved_blocking?: number;
}

/**
 * §10 / §6.5-§6.6 — phase ①'s sampling state: the last COMPLETED round, the round the loop is
 * working, the sample the last selection installed (with the counts that won it), and the bounded
 * audit history.
 *
 * WHY `round` AND `active_round` ARE BOTH ON THE WIRE (T12/P1) — they are two different questions,
 * and one number cannot answer both:
 *   - `round` is the round whose SELECTION the Story carries (`story.sampling_round ?? 1`, exactly
 *     `records.ts:deepReviewRoundOf`). It is what §10's pane prints and what the deep review is
 *     dispatched for, and it is 0 on a Story whose counter an Author reset (§16.7's backtrack).
 *   - `active_round` is the round the loop is WRITING now (`records.ts:samplingRoundOf`, i.e.
 *     `(sampling_round ?? 0) + 1`). It is what decides whether a `drafted` Summary row is live work
 *     or a loser the loop set aside (`records.ts:isSupersededSummaryDraft`), and a payload that only
 *     carries `round` cannot tell "round 1 never completed" from "round 1 completed" — both say 1.
 * The dashboard is forbidden from recomputing either one (L-14/W3), so the projection sends both.
 */
export interface SamplingView {
    /** Last COMPLETED round (`sampling_round ?? 1`); the round the deep review is owed for (§6.6). */
    round: number;
    /**
     * The round IN FLIGHT (`(sampling_round ?? 0) + 1`, `records.ts:samplingRoundOf`): round 1 before
     * the first selection, R + 1 while nothing of round R + 1 has been written yet. Required whenever
     * `sampling` is present — the shipped server always sends it; a payload without the slice at all
     * is the older-build case `story-contract.ts:summaryScopeContext` documents.
     */
    active_round: number;
    /** The last round's chosen sample and its issue counts. Absent until a selection has happened. */
    selected?: SamplingSample;
    /** The Story's `sampling_history` rows, capped at the last 5, newest first. */
    history: SamplingHistoryRow[];
}

/**
 * `GET /stories/:id` — everything THE STORY region (U-4…U-17) needs in one read, so a
 * refresh is one round trip rather than fifteen. Each slice is the §4 collection as-is.
 */
export interface StoryView {
    story: Story;
    summary: Summary | null;
    plotlines: Plotline[];
    chapters: Chapter[];
    /**
     * §4.5 — the cast sheet. The Characters phrase reads it as the story's people and the state
     * they carry; the records themselves are Writer-owned (§7), so this is a projection, never a
     * second copy the dashboard may edit directly.
     */
    cast: CastMember[];
    /**
     * §4.6 — the continuity facts. The Continuity folder renders the ledger as it stands; the
     * mechanical checks C-5/C-6 stay on the server (G-3).
     */
    ledger: LedgerEntry[];
    goal: GoalSurface;
    ideas: Idea[];
    revisions: Revision[];
    /**
     * §4.9's verdict rows for this Story. Additive: U-13 (D-21 side-by-side) renders each draft's own
     * verdict, and §6.2a files those against a `revision_N` — the Reader appends the verdict to
     * `revision.verdict_refs` (server/tools/reader.ts), but the rows still travel as their own slice so
     * the dashboard can match them by `target_ref` without joining ref lists client-side (L-14: the
     * dashboard recomputes nothing).
     */
    verdicts?: Verdict[];
    findings: Finding[];
    proposals: Proposal[];
    /**
     * §4.13's rows for this Story. R10 — each row also carries the additive `phrase_key` the crew listing
     * sends (`ProjectedRun`), derived by the same `server/api/projections.ts:projectRunRow`; the field stays out
     * of this interface's row type because the slice has always been typed as the plain record, and a surface
     * reading it must treat an absent key as "not attributed", never as Phrase ①.
     */
    runs: Run[];
    /** The §4.12 template ids assigned to this Story (D-17b: a list, the count is the Author's call). */
    templates: string[];
    cost_distribution: CostDistribution;
    completion_preview: CompletionPreview | null;
    digest: Digest | null;
    /** Server-owned labels, lists and defaults the desk renders (see `StoryVocabulary`). */
    vocabulary: StoryVocabulary;
    /**
     * U-1a — "what the crews tried across rounds", the third thing the stalled screen has to show.
     * The server projects it from the loop's round bookkeeping (`level_history` on the Story row,
     * written by `recordRound` in server/loop/trend.ts, whose `LevelHistoryEntry` is the authority for
     * these fields). Additive and optional: a Story that has never finished a round sends none, and
     * the pane says so instead of inventing history (L-15a bounds the list, oldest first).
     */
    level_history?: LevelHistoryRow[];
    /**
     * §10 / §3.3 — the accepted Seed Brief, or null while the Editor has not structured this Seed
     * (phase ①'s gate 1, §6.4). Optional on the wire consumer's side purely as the additive-field
     * convention: the shipped server always sends the key, and an older payload omits it rather than
     * pretending a brief exists.
     */
    seed_brief?: SeedBriefView | null;
    /**
     * §10 / §6.6 — phase ①'s sampling round, the selected sample and the capped audit history. Same
     * additive convention: the shipped server always sends it (`round: sampling_round ?? 1`).
     */
    sampling?: SamplingView;
    /**
     * T-W4 — PHRASE ②'s per-phrase dial (`story.plotlines_mode`), echoed rather than derived.
     *
     * WHY IT IS A SETTING AND NOT A FACT: the same reason `summary_mode` above is one (`StoryPatch.summary_mode`,
     * R6/D-35) — the Author owns the switch, and rows can exist while a start step is still in flight, so a
     * derived answer would change underneath a dial the Author is looking at. `projections.ts` sends this key
     * ALWAYS and answers `'classic'` when the Story row has no value, so a classic book keeps the records view it
     * has always had; the client types it optional only as the additive-field convention (an older payload omits
     * the key instead of inventing a mode).
     */
    plotlines_mode?: 'groups' | 'classic';
    /**
     * T-W4 — which on-demand phrases have been STARTED (`projections.ts:phrase_started`).
     *
     * This is the rail's tick and the handoff button's after-state: a phrase that has started has a copied Seed
     * that every entry, revision and claim key was written against, so its start is not repeatable (the start
     * route 409s on it). Both keys are always present on the wire, and `summary` answers `true` for every book
     * the loop wrote, because Phrase ① is not an on-demand phrase.
     */
    phrase_started?: { summary: boolean; plotlines: boolean };
    /**
     * T-W4 — whether THIS Story has a compiled Summary the Plotlines phrase can be started from.
     *
     * IT IS THE HANDOFF BUTTON'S ENABLE CONDITION, and it has exactly one definition in the build: the projection
     * answers the same predicate the start route copies its seed from (`projections.ts:compiledSummaryOf` — the
     * complete reviewed Overview when the crew produced one, else the Overview as it stands). A button disabled
     * here and a route that would have accepted the start are therefore the same fact, and the desk never
     * re-derives "is the Summary compiled" from group rows on its own (L-14).
     */
    summary_compiled?: boolean;
}

// ---------------------------------------------------------------------------
// SUMMARY PHRASE — the group read (`GET /stories/:id/phrases`), R1-R6
//
// WHY A SECOND READ AND NOT A WIDER `StoryView`: `StoryView` is the PINNED wire contract the whole
// desk renders from, and the group rail is a new surface rather than a field of the old one
// (`server/api/projections.ts`'s phrase section says the same thing from the server's side). The
// shapes below are field-for-field the projection's: this file is the dashboard's copy of the wire,
// so the panes never import a server module and a server that renames a field breaks the client
// contract test rather than a component.
//
// WHAT THE GROUPS ARE (R1): the Summary is five named, separately revisable groups — premise,
// promise, theme, tone, ending — that compose into one Overview. WHICH groups exist, their titles,
// their descriptions and their order is SERVER/product data on the rows; nothing here hardcodes the
// five labels, and `world_rules` is deliberately not one of them (R1 retires it as a group).
//
// NO FULL ARCHIVED TEXT (R2): a group row carries the CURRENT text; `history` is the retained
// ledger of superseded revisions with metadata and a char count only. The one exception is
// `previous_content` — the revision immediately before the latest — which the pane diffs the
// current text against; every older body stays off the wire.
// ---------------------------------------------------------------------------

/** One revision of one group, current or archived. `chars` is its length, never its text (R2). */
export interface PhraseRevisionRow {
    id: string;
    /** 1-based, per group (R2) — the number the detail pane labels its status with. */
    number: number;
    /** `latest` for the row that stands, `archived` for one a later install superseded. */
    state: string;
    at: string;
    /** The run that wrote it, or null for an Author edit / legacy import. */
    run_ref: string | null;
    /** R3: the findings this text was written to answer — the anchor a closure is judged on. */
    finding_refs: string[];
    task_refs: string[];
    chars: number;
    /**
     * D-67 — P11's audit of a verdict: this text closed a cross-group Critic pass with no unresolved defect
     * on it, which is the ONLY thing that makes a revision selectable into the Reviewed Summary.
     *
     * OPTIONAL ON PURPOSE: a payload from before D-67 sends neither key, and `false`/absent are the same
     * claim to the desk (this text was never certified clean). The dashboard reads it for a badge only —
     * the selection itself is the server's (`reviewed.groups[].selected_revision`), never re-derived here.
     */
    clean?: boolean;
    /** The deep-review run whose clean pass earned the stamp; null with no stamp (P11: every verdict names its run). */
    clean_run_ref?: string | null;
}

/**
 * T3 — ONE scoring pass over the Summary's group vector, as the projection attaches it to a group row.
 *
 * WHY THE VALUE IS NOT A LABEL: the rail prints a percentage and the pane prints the Critic's sentence, and
 * both read the SAME row — a score the UI had to re-derive from findings would be a number the desk invented
 * (L-14's rule against the client doing the engine's arithmetic). One run scores ALL FIVE groups at once, so
 * the rows carry the same `vector_hash` and `at` for a given pass, and the rail's header average is a read
 * over those rows rather than a sixth number nobody wrote.
 *
 * ORDER IS NEWEST FIRST (`scores[0]` is the latest pass) — the same direction `history` travels (R2), so a
 * pane that reads the newest row of one field cannot read the oldest of the other.
 */
export interface PhraseGroupScore {
    /**
     * The score, as a 0–100 percentage. `story-contract.ts:phraseScorePercent` is the ONE normalizer the
     * UI reads it through: it also accepts the 0–1 fraction spelling and clamps, so a payload from either
     * side of that convention renders one honest number instead of `0.84%` or `NaN%`.
     */
    value: number;
    /** The group-vector digest this pass scored — ties the number to the exact text it judged. */
    vector_hash: string;
    /** ISO instant the pass ran; the rail's "improves over time" read sorts on this. */
    at: string;
    /** The run that scored it, or `''` when the projection has no run to name. */
    run_ref: string;
    /** The Critic's sentence about this group, when the pass wrote one. Absent ⇒ the pane prints nothing. */
    rationale?: string;
}

/** One group: its current text, its number, its retained history, and the findings it still owes. */
export interface PhraseGroupRow {
    /** The UUID the rail addresses this group by — a selection ref, never an array index (U2). */
    id: string;
    key: string;
    title: string;
    description: string;
    /** Composition order; the rail and the Overview both follow it, and it is NOT an identity. */
    order: number;
    content: string;
    revision: number;
    updated_by: string | null;
    /**
     * R2 / U3 — the revision immediately before the latest one, verbatim, or `''` at revision 1.
     * It is the ONLY archived body on the wire: the pane renders the current text as a diff against
     * it, and every older revision stays metadata.
     */
    previous_content: string;
    /** Newest first, `latest` included. Metadata only — see the note above. */
    history: PhraseRevisionRow[];
    /** Open findings that target this group and have no revision of ITS own answering them (R3). */
    owed_by_findings: string[];
    /**
     * F8 / R4 — a live Writer pass holds this group right now, so the text on screen is about to
     * move. It is the SAME read the revise route refuses with, so a disabled button and a 409 cannot
     * disagree: the control is disabled off this flag, never off a guess from run rows.
     */
    writer_busy: boolean;
    /**
     * T3 — the Critic's score for THIS group, newest pass first (see `PhraseGroupScore`).
     *
     * ADDITIVE AND OPTIONAL ON PURPOSE: a scoring run is a server-side job that has not happened for every
     * book yet, and a rail row whose group has never been scored renders NO number at all — absence is a
     * fact about the book, not a zero. One pass scores all five groups, so the phrase header's overall score
     * appears only when every group carries one (a partial average would be a made-up number).
     */
    scores?: PhraseGroupScore[];
    /**
     * R1 — the Author's (or, with the Setting on, the Editor's) lock-in of THIS group's text.
     *
     * A locked group is settled content: it cannot be revised, its own findings are voided by the lock, and
     * the other groups adapt to it. ABSENT MEANS UNLOCKED — the legacy reading, and the normal state of every
     * group until someone commits to a text — so a payload from before the lock exists renders exactly the
     * pane it rendered before, with no badge and no unlock control.
     */
    locked?: boolean;
    /**
     * The group revision the lock stands on — the number the lock was made AT.
     *
     * It travels rather than being read off `revision`, because the two facts can differ: the lock names the
     * text a person committed to, and `revision` is whatever the loop has installed since. The pane prints
     * this number, so `Locked at Revision 4` can never claim the lock sits on text that has moved.
     */
    locked_revision?: number;
    /** WHO committed the lock. It decides the pane's sentence, and whether the desk offers an unlock. */
    locked_by?: PhraseGroupLockActor;
    /** ISO instant the lock was made, as the wire sent it. The pane keeps it in the badge's tooltip only. */
    locked_at?: string;
}

/**
 * R1 — who may hold a group's lock.
 *
 * The Author always may. The Editor may only when the Story's `editor_group_locking` Setting is on, and it
 * never lifts a lock: `locked_by:'editor'` still unlocks through the Author alone. The token is the wire's,
 * so the desk states who locked a group rather than guessing from `updated_by`.
 */
export type PhraseGroupLockActor = 'author' | 'editor';

/**
 * T3 — the claim type on the wire, as the dashboard READS it: `issue` or `proposal`.
 *
 * WHY NOT the shared `FindingKind` union: that enum is the server's and its proposal token is mid-rename
 * (`improvement` → `proposal`), and the dashboard must render BOTH spellings — a legacy payload whose row
 * says `improvement` and a current one that says `proposal` are the same kind of claim to the Author, and
 * one that says neither is an Issue. `story-contract.ts:findingKindLabel` is the single place that decides
 * the wording, so widening the mirror to `string` costs no type safety the UI was actually using, and a
 * stricter shared union would make this file fail to compile against a payload from the other side.
 */
export type FindingKindWire = string;

/** A finding with its group attribution and R3's resolution against the book as it stands. */
export interface PhraseFindingRow {
    id: string;
    title: string;
    cost: Cost;
    /**
     * T3 — what the row CLAIMS: `issue` (a defect the commitment set is measured against) or `proposal`
     * (a change that would improve the text). ABSENT ⇒ Issue, the legacy reading of a row raised before
     * the field existed, which is also the default of a raise that named no kind.
     */
    kind?: FindingKindWire;
    state: Finding['state'];
    seen_count: number;
    /** The ids on the record; empty is the legacy "the whole Overview" reading. */
    group_refs: string[];
    /** True when the record named none — spelled out so a pane never infers it from an empty array. */
    unscoped: boolean;
    /** Every group this finding is aimed at; `unscoped` means every group of this Story. */
    targeted: string[];
    resolved: string[];
    missing: string[];
    /** R3: every targeted group has a revision written to answer it, so the row may close. */
    resolved_all: boolean;
}

/** A task in the group queue, with what it is waiting on. */
export interface PhraseTaskRow {
    id: string;
    title: string;
    state: Task['state'];
    owner_role: string | null;
    attempts: number;
    finding_ref: string | null;
}

/** The state of the group pipeline: what is written, what is reviewed, and whether the mirror agrees. */
export interface PhraseReviewState {
    /** `story.summary_mode`, echoed — the switch is a Setting, not a derived fact (R6). */
    mode: 'groups' | 'sampling';
    /** Catalog keys with no revision yet; empty means the Overview is fully written. */
    unwritten_groups: string[];
    written_groups: number;
    /** `{groupId: revisionNumber}` — the identity reviews and deferrals are keyed by. */
    vector: Record<string, number>;
    vector_hash: string;
    /** Critic seats the Author's dial asks for on this vector, and how many have reported. */
    review_seats: number;
    reviews_on_current_vector: number;
    deep_reviews_on_current_vector: number;
    open_findings: number;
    /**
     * The open rows at §6.8's critical/major severity bar (unchanged by R6) — the cost band the Reviewer
     * weighs, and the number the desk prints as "N critical/major". A SEVERITY band, not a gate: the Summary
     * accept does not wait on these rows, it voids them in the lock commit (D-78).
     */
    blocking_findings: number;
    open_tasks: number;
    /** R6's compatibility mirror: does the legacy `summaries` prose still say what the groups say? */
    mirror: { summary_id: string | null; in_sync: boolean; locked: boolean; fields: string[] };
}

// ---------------------------------------------------------------------------
// D-67 / D-68 — the REVIEWED Summary and the Author's choose
//
// WHY A WHOLE SECOND BLOCK BESIDE `review`. `review` answers "what is the pipeline doing with the CURRENT
// text"; `reviewed` answers "what text has been READ and passed, what was it scored at, and what did the
// Author take". They disagree during exactly the window the feature exists for — the newest Ending has an
// open defect while the reviewed Ending is the earlier clean one — so the Summary tab shows the reviewed
// reading and leaves the live one to the group panes and the rail. Field-for-field the server's
// `api/projections.ts:PhraseReviewedSummary`; the shapes are duplicated here because the client contract
// lives in this file (the projection imports its own return types from here), so neither side may drift.
// ---------------------------------------------------------------------------

/**
 * One group INSIDE the reviewed block (D-67): the pair of numbers the feature exists to show.
 * `latest_revision: 5` beside `selected_revision: 4` IS "Ending r5 has an issue, so the reviewed Ending is r4".
 */
export interface PhraseReviewedGroup {
    /** The group's UUID — the same address the rail's selection ref carries (U2). */
    id: string;
    key: string;
    /** The Clean revision the reviewed Overview is built from, or null while this group has none. */
    selected_revision: number | null;
    /** The row behind `selected_revision`; carried so a pane can name the row without re-deriving it. */
    selected_id: string | null;
    /** The deep-review run whose clean pass earned the verdict; null with no selection. */
    clean_run_ref: string | null;
    /** The group's newest revision number (0 when unwritten) — the number the selection fell back past. */
    latest_revision: number;
    /** True when the newest text is NOT the reviewed one — the state the Author acts on. */
    superseded: boolean;
    /** An unresolved ISSUE names this group, which holds its clean verdicts out of the selection. */
    issues_open: boolean;
    /** Why there is no selection: `'unwritten'` | `'no_clean_revision'`; null when there is one. */
    gap: string | null;
    /**
     * The scores that judged THIS reviewed vector, newest first — joined on `reviewed.vector_hash` and
     * nothing else, because a Reader's number describes the text it was shown.
     *
     * D-67 moved scoring onto the clean vector, so `groups[].scores` (the live rows' trend list) is EMPTY
     * until a clean selection exists; a pane that printed the live rows in this block would print a number
     * for a combination nobody reviewed.
     */
    scores: PhraseGroupScore[];
}

/** What the Author chose (D-68), read back off the Phrase row, or null when none is valid. */
export interface PhraseChosenSummary {
    /** `{groupId: revisionNumber}` — the vector the choice adopted; its rows are the live `latest` now. */
    vector: Record<string, number>;
    vector_hash: string;
    /** When the choose committed (the Phrase row's `reviewed_at`); `''` when the row carries no instant. */
    at: string;
    /** The composed text that was chosen, recomposed from the rows the vector names. */
    overview: string;
    /**
     * The scores that judged THAT text, per group, newest first — the number the choice was made under.
     *
     * KEYED BY GROUP UUID (`entry.group.id` in the projection), not by catalog key: a lookup by `key`
     * silently misses every row and the pane prints no number. See `story-contract.chosenGroupScores`.
     */
    scores: Record<string, PhraseGroupScore[]>;
}

/** The Reviewed Summary: the Clean selection, the score that judged it, and the Author's choice. */
export interface PhraseReviewedSummary {
    /**
     * `pending` — no complete clean selection and no valid recorded choice;
     * `ready` — a complete reviewed Overview the Author may choose, not the one they chose (this is also
     * the state after a choose once the pipeline reviews a different combination, i.e. `stale: true`);
     * `chosen` — the Author's recorded choice stands, whether or not newer reviewed text exists.
     */
    state: 'pending' | 'ready' | 'chosen';
    /** Every group has a selectable Clean revision — the gate a choose and a scoring pass both hang on. */
    complete: boolean;
    /** The live clean selection, catalog order; PARTIAL when `complete` is false. */
    vector: Record<string, number>;
    vector_hash: string;
    /** The composed reviewed Overview; `''` while the selection is partial. */
    overview: string;
    /** One entry per catalog group, in catalog order — always all five on a grouped book. */
    groups: PhraseReviewedGroup[];
    /** The Author's choice, or null when they never chose or the chosen history is gone (a Seed reset). */
    chosen: PhraseChosenSummary | null;
    /** True when the clean selection has moved PAST what the Author chose: newer reviewed text to take. */
    stale: boolean;
    /** The unresolved issues holding a clean verdict back, with the group KEYS each one scopes to. */
    blocking_issues: Array<{ id: string; title: string; cost: Cost; group_keys: string[] }>;
    /**
     * A live Writer pass holds at least one group, so a choose would refuse — the SAME read the route's 409
     * and `groups[].writer_busy` use, so a greyed-out control and a refusal can never disagree (R4).
     */
    writer_busy: boolean;
}

/** The whole group surface for one Story — the one read the Summary rail and its panes render (R6). */
export interface PhraseView {
    story_id: string;
    mode: 'groups' | 'sampling';
    phrase_id: string | null;
    /** The Overview's revision number (the phrase row), or 0 when the book has no phrase row. */
    revision: number;
    /** The composed Overview, from the group rows as they are (R2: the composition is a read). */
    overview: string;
    groups: PhraseGroupRow[];
    findings: PhraseFindingRow[];
    tasks: PhraseTaskRow[];
    review: PhraseReviewState;
    /**
     * D-67/D-68 — the Reviewed Summary and the Author's choice. ALWAYS present on the wire (a book with no
     * groups reports `pending` with nothing in it), so the Summary tab never branches on absence; the
     * panes still read it through `story-contract.phraseReviewed`, which answers the same empty block for
     * a payload from before the feature so an older server cannot crash the desk.
     */
    reviewed: PhraseReviewedSummary;
}

/**
 * `POST /stories/:id/phrases/reviewed/choose` body (D-68) — the Author takes the Reviewed Summary.
 * `note` is optional: the route records it in the attribution line, and an empty one is sent as absent.
 */
export interface PhraseReviewedChooseInput {
    note?: string;
}

/**
 * One group's install in the choose's report — same shape as the revise route's, with the group KEY
 * spelled out because the choose installs all five at once and the pane lists them by name.
 */
export interface PhraseReviewedChooseInstallRow {
    group_id: string;
    group_key: string;
    revision_id: string;
    number: number;
}

/**
 * What the choose route answers, including the refreshed `view` so the pane re-reads nothing by hand.
 *
 * `discarded` is the half the Author acted on: every revision the choice passed over is flipped to the
 * terminal `discarded` state (retained for R3's closure join, hidden from every current read), and the
 * pane names them so the drop is not silent.
 */
export interface PhraseReviewedChooseResult {
    story_id: string;
    phrase_id: string;
    revision: number;
    /** The vector that was adopted — `{groupId: revisionNumber}`. */
    vector: Record<string, number>;
    vector_hash: string;
    /** When the choose committed (the Phrase row's `reviewed_at`). */
    at: string;
    /** The composed Overview the Author took. */
    overview: string;
    installed: PhraseReviewedChooseInstallRow[];
    discarded: PhraseReviewedChooseInstallRow[];
    /** Where each chosen text came from: the source row and the number that now holds it (catalog order). */
    sources: Array<{
        group_id: string;
        group_key: string;
        source_revision: number;
        source_id: string;
        installed_revision: number;
    }>;
    /** What happened to the legacy `summaries` mirror (R6): a `written: false` with a reason is a fact, not a failure. */
    mirror: { summary_id: string | null; fields: string[]; written: boolean; reason?: 'locked' | 'no_summary' };
    view: PhraseView;
}

/**
 * `POST /stories/:id/phrases/groups/:groupId/revise` body (R2) — the Author rewrites ONE group.
 * The route trims `content` and refuses an empty one, and it deliberately claims to resolve no
 * finding: `finding_refs` stay off the row, so a hand edit cannot close a finding on R3's evidence rule.
 */
export interface PhraseGroupReviseInput {
    content: string;
    note?: string;
}

/** One group's install, as the route reports it: which number is current, which one moved to history. */
export interface PhraseGroupInstallRow {
    group_id: string;
    group_key: string;
    revision_id: string;
    number: number;
}

/** What the group revise route answers — including the refreshed `view`, so the pane re-reads nothing by hand. */
export interface PhraseGroupReviseResult {
    story_id: string;
    phrase_id: string;
    revision: number;
    installed: PhraseGroupInstallRow[];
    archived: PhraseGroupInstallRow[];
    /** What happened to the legacy `summaries` mirror (R6): `written: false` with a reason is a fact, not a failure. */
    mirror: { summary_id: string | null; fields: string[]; written: boolean; reason?: 'locked' | 'no_summary' };
    view: PhraseView;
}

/**
 * R1 — what the group lock and unlock routes answer.
 *
 * THE SHAPE IS THE REVISE ROUTE'S, NOT A NEW ONE. `POST …/groups/:id/revise` and `POST …/reviewed/choose` both
 * answer the refreshed phrase `view`, and the store commits it straight away so the rail and the pane move with
 * the write rather than with a later poll (R2/D-68). Lock and unlock are the same kind of verb — they change a
 * group row the phrase read projects — so they carry the same `view`, and the store's `mutate` re-reads the
 * Story and the rail afterwards exactly as it does for a revise.
 *
 * `view` IS OPTIONAL FOR ONE HONEST REASON: these two routes are being landed by another wave, and a body that
 * carries only the lock verdict (or only the Story row) is a body this client must survive. Every field below
 * is therefore read for a badge, never for arithmetic, and the store falls back to `mutate`'s own re-read when
 * the route sends no `view`.
 */
export interface PhraseGroupLockResult {
    story_id?: string;
    phrase_id?: string;
    group_id?: string;
    /** The state the route is leaving the group in: `true` from lock, `false` from unlock. */
    locked: boolean;
    /** The revision the lock was made on, or `null`/absent once the group is open again. */
    locked_revision?: number | null;
    locked_by?: PhraseGroupLockActor | null;
    locked_at?: string | null;
    /** The refreshed phrase read, on the revise route's convention. Absent means "re-read it", not "nothing changed". */
    view?: PhraseView;
}

// ---------------------------------------------------------------------------
// PHRASE ② — the per-phrase read, the Author's start, and a chapter entry's contract (T-W4)
//
// WHY A SECOND PHRASE SHAPE AND NOT A WIDER `PhraseView`: `GET /stories/:id/phrases` is the PINNED Summary
// contract (`phrase-routes.test.ts` asserts the verb responses key for key), so the Phrase ② deltas ride on
// `GET /stories/:id/phrases/:key` instead — the same projection plus `key`, `mode`, `seed_head`, `seed_chars`
// and `brief`, and WITHOUT `review.mirror`, which is the Summary's legacy `summaries` prose check and has no
// meaning for a phrase with no legacy record. Field-for-field the server's (`server/api/projections.ts:
// PhraseDetailView`), because this file is the dashboard's copy of the wire.
// ---------------------------------------------------------------------------

/**
 * The dial word a phrase view echoes (`projections.ts:PhraseMode`).
 *
 * THE TWO PHRASES' OFF WORDS DIFFER ON PURPOSE: the Summary's is `'sampling'` (the pre-redesign sampler that
 * actually ran) and the Plotlines' is `'classic'` (the §4.3 + §8.1 tool path). A client that reads
 * `mode:'classic'` is looking at the classic plotline pipeline, and a rail that conflated the two words would
 * offer a group surface to a book whose Plotlines the group loop never wrote.
 */
export type PhraseMode = 'groups' | 'sampling' | 'classic';

/**
 * The Plotlines phrase's structure decision, as the rail shows it: what the Editor concluded about the phrase's
 * copied Seed, and whether the Author has accepted it. The count is the number the chapter entries were
 * materialized from, and `accepted_at` is present only once the brief is accepted — the full brief (per-chapter
 * seeds, research questions, notes) stays off this read.
 */
export interface PhraseBriefView {
    /** `draft` until the Author accepts it; `accepted` is the moment the chapter entries exist. */
    status: string;
    /** The Editor's chapter count — the number `chapter_1…chapter_N` were materialized from (D-3b). */
    chapter_count: number;
    /** The accept's stamp; absent while the brief is still a draft. */
    accepted_at?: string;
}

/** One phrase's whole surface — the pinned Summary view plus that phrase's deltas. */
export interface PhraseDetailView extends Omit<PhraseView, 'mode' | 'review'> {
    /** The catalog kind this read is scoped to (`phrases.key`). */
    key: string;
    /** THIS phrase's dial; the off word is per-phrase, never one shared word. */
    mode: PhraseMode;
    /** This phrase's pipeline state, with no `mirror` — R6's legacy prose check belongs to the Summary. */
    review: Omit<PhraseReviewState, 'mode' | 'mirror'> & {
        mode: PhraseMode;
        mirror?: PhraseReviewState['mirror'];
    };
    /** A PREFIX of the phrase's copied Seed, never the whole text (the rail only needs to recognise it). */
    seed_head: string;
    /** The Seed's true length, so a truncated head still says how much text it stands for. */
    seed_chars: number;
    /** The Plotlines structure brief, or `null` for any other phrase and for a phrase nobody structured. */
    brief: PhraseBriefView | null;
    /**
     * R12 — WHERE THE COPIED SEED CAME FROM, recorded once at the start and never rewritten: `'custom'` is text
     * the Author pressed (with or without a cleanup they confirmed), `'compiled'` is the Overview Phrase ① wrote.
     *
     * ABSENT IS NOT A THIRD VALUE: a phrase row written before the field existed carries no word about its
     * origin, and the projection OMITS the key rather than sending `null` or guessing `'compiled'` — guessing
     * would tell an Author their own typed brief was the crew's Overview. So `undefined` means "legacy, unknown",
     * and the desk must not render a provenance line it cannot stand behind.
     */
    seed_source?: 'custom' | 'compiled';
}

/**
 * `POST /stories/:id/phrases/:key/start` body (`routes.ts:PhraseStartBody`) — WHERE the phrase's Seed comes from.
 *
 * The route treats an absent body as `{source:'compiled'}`, and a stray `text` beside `'compiled'` is IGNORED
 * rather than half-applied: a request that sends both is asking for one of them, and the route refuses to guess
 * which one the Author meant. So this client never sends both keys, exactly as `revisePhraseGroup` never sends
 * an empty `note`.
 */
export interface PhraseStartInput {
    source?: 'compiled' | 'custom';
    text?: string;
}

/**
 * What the start verb answers — a receipt, not a second write.
 *
 * `seed_head`/`seed_chars` are read back off the phrase row AFTER the commit (the projection's own fields), so the
 * receipt and the rail cannot disagree about what was copied. `view` is the refreshed `PhraseDetailView`, which is
 * what the store commits; the desk re-reads nothing by hand.
 */
export interface PhraseStartResult {
    story_id: string;
    phrase_id: string;
    key: string;
    /** Which arm actually supplied the Seed — the route echoes the resolved source, not the request. */
    source: 'compiled' | 'custom';
    seed_chars: number;
    seed_head: string;
    /** The domain's own start record (the journal line), so the rail's tick has a source row. */
    started: unknown;
    /**
     * R11 — TRUE ONLY WHEN THIS PRESS MOVED THE CREW, i.e. the Story entered phase `plotlines` because of it
     * (L-33). The pointer follows a Phrase ② start only once the Summary is signed off, so `false` is the
     * ORDINARY answer on a book whose Summary is not accepted yet, and it is not a failure: the phrase started,
     * the crew stays on Phrase ①, and `phase_open_reason` says so. Documented in
     * `storyline-server.swagger.yaml:StartPhraseResult` and pinned field-for-field by `server/api/contract.test.ts`.
     */
    phase_opened: boolean;
    /**
     * R11 — `''` when `phase_opened` is true; otherwise the sentence to print UNDER A SUCCESSFUL START, naming
     * which no-move state this is (Summary not signed off, another phase already current, or the phrase owns no
     * phase). The start succeeded in every case: a pointer the start could not move is reported, never rewound,
     * so the desk must not turn this into an error strip.
     */
    phase_open_reason: string;
    view: PhraseDetailView;
}

/**
 * R7 — THE CODE the cleanup pass answers with when it has no proposal: the model replied and a guard decided the
 * rewrite was not still the Author's brief. Each one is a RULE, not a mood (`run/seed-cleanup.ts`):
 *
 * - `empty_answer` — the provider returned nothing usable;
 * - `numbers_lost` — a digit the Author wrote is missing from the rewrite, so a chapter count or a deadline would
 *   have been proofread away;
 * - `too_short` / `too_long` — the rewrite left the length envelope of the draft, i.e. it summarised or expanded
 *   instead of correcting.
 *
 * All four are 200 answers with NO `text`, which is what makes AC3's "silently confirmed" unreachable: the desk
 * has no proposal to carry into the Start press.
 */
export type SeedCleanupRefusal = 'empty_answer' | 'numbers_lost' | 'too_short' | 'too_long';

/**
 * R7 — the Editor's one-shot proofread of the Author's pending Seed (`GET …/seed/cleanup`), field-for-field the
 * server's (`storyline-server.swagger.yaml:SeedCleanupProposal`).
 *
 * THE TWO ARMS ARE TOLD APART BY `ok`, and only `ok` and `source_hash` are ever both present:
 *
 * - `ok: true` → `text` (the proposal) + `changed` (whether it differs from the draft). `changed: false` is the
 *   honest "nothing to fix" answer, not a failure, and not a reason to hide the Start button;
 * - `ok: false` → `refusal`, and NO `text`. The desk says which rule fired and keeps the Author's own draft.
 *
 * NOTHING HERE IS WRITTEN ANYWHERE. `source_hash` is `shared/seed-hash.ts` over the TRIMMED draft the pass read —
 * the same 8 hex digits the Start commit journals beside the copied length — so the desk can prove WHICH draft a
 * proposal belongs to and refuse to confirm a proposal onto text it was never computed over. The Seed's text is
 * deliberately not echoed back on the refusal arm: the desk is holding it.
 */
export type SeedCleanupProposal =
    | { ok: true; source_hash: string; text: string; changed: boolean }
    | { ok: false; source_hash: string; refusal: SeedCleanupRefusal };

/**
 * The Author's contract fields for ONE chapter entry (`routes.ts:plotpointsFromBody`).
 *
 * A chapter entry's stored text is a DERIVATION of these fields, so the revise body carries the fields and not the
 * prose: `must_happen` and `must_change` must both be non-empty (the route 400s otherwise), and the optional ones
 * travel only when they say something — a blank label in a contract block reads like a promise the chapter makes
 * and pays with nothing. A `content` key beside `plotpoints` is not read: deriving the text is the point (P4).
 */
export interface PhrasePlotpointsInput {
    must_happen: string;
    must_change: string;
    heading?: string;
    pov?: string;
    setups?: string;
    payoffs?: string;
}

/**
 * `POST …/phrases/groups/:groupId/revise` body for a CHAPTER ENTRY: the contract fields, plus the optional note.
 *
 * It is a SEPARATE type from `PhraseGroupReviseInput` rather than a union inside it, so every existing Summary call
 * site keeps its `{content, note}` shape and the compiler still refuses a Summary revise that forgets the prose.
 */
export interface PhraseEntryReviseInput {
    plotpoints: PhrasePlotpointsInput;
    note?: string;
}

/** What the chapter-entry revise answers: the install report, with the refreshed PHRASE ② read. */
export interface PhraseEntryReviseResult extends Omit<PhraseGroupReviseResult, 'view'> {
    view: PhraseDetailView;
}

// ---------------------------------------------------------------------------
// R4 (symptom 3) — WHICH PHRASE a crew row is working on
//
// THE WORD "PHRASE" HAS MEANT TWO THINGS ON THIS DESK (V-3, specifications.md:106): the rail uses it for a
// pipeline stage (Phrase ① Summary, Phrase ② Plotlines) and the crew panel has used it for one dispatched
// run ("No phrase is running"). The rail's numbering is the one the Author navigates, so a thread that says
// "working" while the rail is lit on Phrase ① reads as Phrase-① work even when the loop dispatched it against
// Phrase ②'s chapter rows. `GET /runs` therefore ATTRIBUTES each row to a phrase, in the rail's own key
// vocabulary, and `CrewPanel` prints that attribution beside the claim key.
//
// WHY IT IS PROJECTED RATHER THAN STORED: `Run` (§4.13) has no phrase field and needs none. The attribution
// is a READ of rows the book already holds — the group rows the run holds (`Run.group_refs`, the
// authoritative answer when present), then the claim key's family (`work_item_ref`) — and a stored field
// would be a second answer that a restart, a back-track or a hand-armed row could leave out of step (P1).
// The derivation lives in `server/api/projections.ts:runPhraseKeyOf`; the type lives HERE because this file
// is the wire contract the server imports its return types from (the file's own preamble rule).
// ---------------------------------------------------------------------------

/**
 * The phrase a crew row belongs to, in the rail's key vocabulary (`shared/phrase.ts` keys).
 *
 * `'unknown'` is AN ANSWER, not a shrug: it means the row carries neither a group set nor a key the desk can
 * read a phrase out of — every shared-family pass (`wi_review_groups_*`, `wi_summary_score_*`,
 * `wi_group_check_*`) whose claim key is a group VECTOR hash that both phrases can mint. A surface that got
 * `'unknown'` says so; it may not fall back to Phrase ①, which is the defect R4 names.
 */
export type RunPhraseKey = 'summary' | 'plotlines' | 'unknown';

/**
 * One `GET /runs` row: the §4.13 record plus the phrase attribution.
 *
 * The field is OPTIONAL on the client because not every route that answers a `Run` is the crew listing —
 * `POST /runs/:id/kill` and `POST …/assistant` answer the plain row, and a desk that read `phrase_key` as
 * always-present would print "Phrase undefined" over a row it killed a second ago. Absent means "this route
 * never attributed it", which the crew panel renders with the same honest line as `'unknown'`.
 *
 * R10 — the two routes that DO attribute are `GET /runs` and `GET /stories/:id`: the Story payload's `runs`
 * slice (declared as `Run[]` on `StoryView` below, because the §4.13 record is what that slice has always
 * carried) ships the same additive `phrase_key` on every row, from the same projection function
 * (`server/api/projections.ts:projectRunRow`). One rule, one answer on both paths — pinned by
 * `server/api/run-phrase-attribution-story-view.test.ts`.
 */
export type ProjectedRun = Run & { phrase_key?: RunPhraseKey };

/**
 * One round of the loop as the stalled screen reads it (U-1a). Field-for-field the server's
 * `LevelHistoryEntry`; declared here because the client contract lives in this file (projections.ts
 * imports its own return types from here, so the server cannot drift from the shape).
 */
export interface LevelHistoryRow {
    round: number;
    at: string;
    phase: StoryPhase;
    /** level -> `passed/total`, the same numbers L-14's `consistency` sentence renders. */
    levels: Record<string, string>;
    fingerprint_closed: string[];
    fingerprint_reopened: string[];
    findings_confirmed_new: string[];
    flat_streak: number;
    trend: Trend;
    runs_closed?: number;
}

/** §10.2 U-10 — the four flavours the Author's queue aggregates (findings, Ideas, escalations, tool gaps). */
export const QUEUE_ITEM_KINDS = ['finding', 'idea', 'escalation', 'tool_gap'] as const;
export type QueueItemKind = (typeof QUEUE_ITEM_KINDS)[number];

/**
 * U-10 / U-10a — one item on the Author's desk, aggregated across Stories. `title`/`detail`
 * are the EDITOR's rewrite (D-34a): the claim in the Author's reading surface, not the
 * reviewer's wording, because the queue is the loop-engineering aimed at the human.
 */
export interface QueueItem {
    kind: QueueItemKind;
    /**
     * T5 (additive) — the FINDING's claim type, on the `finding` rows only. It cannot be called `kind`:
     * that field is already this row's queue discriminator ('finding' | 'idea' | ...). Absent on the
     * other three flavours, and `'issue'` for a finding raised before the field existed.
     *
     * T3 — typed as the dashboard's `FindingKindWire` rather than the shared enum, for the reason named
     * there: the proposal token is mid-rename server-side, and this row's ONLY consumer is
     * `story-contract.ts:findingKindLabel`, which reads both spellings and defaults absence to Issue.
     */
    finding_kind?: FindingKindWire;
    story_id: string;
    story_title: string;
    id: string;
    title: string;
    detail?: string;
    evidence: string;
    cost?: Cost;
    created_at: string;
}

// ---------------------------------------------------------------------------
// Mutation payloads (bodies are pinned by the route table; the ops are the §5.1 dial verbs)
// ---------------------------------------------------------------------------

/**
 * `POST /stories` body. `chapter_count` is Author truth — declared, never agent-chosen (D-3b).
 * The route lets the server name an untitled Story from its Seed, which is what the Create Story
 * tab's "tell the Editor" path uses; the form still sends all three fields.
 */
export interface CreateStoryInput {
    title?: string;
    idea: string;
    chapter_count?: number;
    /** Phase ①: Writer samples per Summary (standard 5 when omitted). */
    summary_sampling?: number;
    /** Phase ①: Critic passes per sample (standard 5 when omitted). */
    summary_critics?: number;
}

/**
 * `PATCH /stories/:id` body. `auto_approve` is the D-35 dial, which doubles as the drain
 * threshold (D-35b): including `minor` makes the Story drain later, and the sweep re-reads it.
 */
/**
 * T-W4 — the catalog key the Phrase ② routes address (`phrases.key`), spelled ONCE.
 *
 * The server's phrase catalog owns the word (`server/phrase/catalog.ts`), and every route takes it in the path, so
 * the store, the panes and the fakes all address the same phrase through this constant. A component that typed
 * `'plotlines'` by hand would be a second spelling of a server identifier — the failure mode this file's other
 * aliases exist to prevent.
 */
export const PHRASE_PLOTLINES_KEY = 'plotlines';

export interface StoryPatch {
    title?: string;
    idea?: string;
    chapter_count?: number;
    auto_approve?: Cost[];
    /** Phase ①: how many Writer samples one Summary gets (standard 5). */
    summary_sampling?: number;
    /** Phase ①: how many Critics critique each sample (standard 5). */
    summary_critics?: number;
    /**
     * R2 — the Setting that lets the Editor lock a SUMMARY GROUP in, on its own judgement over the Critic's
     * findings for that group and the Reader's score and rationale beside them.
     *
     * ABSENT MEANS OFF, which is what keeps every legacy `PATCH` body and every Story written before the
     * Setting exists behaving exactly as it did: the Editor has no group-lock power, and the Author still
     * locks and unlocks groups by hand. It is a Story setting rather than a derived fact because the Author
     * owns the switch — the same reason `auto_approve` and `summary_mode` are settings (D-35, R6).
     */
    editor_group_locking?: boolean;
    /**
     * T-W4 — PHRASE ②'s dial, on the same `PATCH /stories/:id` route (`routes.ts` validates the two words exactly
     * as `summary_mode`'s are validated).
     *
     * `'groups'` turns the chapter entries into the Author's writable surface (the loop materializes one entry per
     * chapter the Plotlines brief declares); `'classic'` keeps the §4.3 plotline tools' pipeline, which is what
     * every book written before Phrase ② runs. ABSENT MEANS `'classic'` — the projection echoes it that way and the
     * catalog reads an absent value as classic, so a Story from before the dial keeps its records view.
     *
     * THE DIAL CLOSES WHEN THE PHRASE STARTS (`phrase_started.plotlines`): the entry rows and the brief are written
     * against the mode that produced them, so switching it afterwards would leave rows the new mode cannot explain.
     * The route refuses with a 409 that names the two controls the Author CAN still act on; the Settings pane
     * disables the dial from the same projected flag rather than waiting for the refusal.
     */
    plotlines_mode?: 'groups' | 'classic';
}

/** §6.3a L-32 — the two backtrack targets; Phase ③ is the current phase, so only ①/② are reachable. */
export type BacktrackPhase = 'summary' | 'plotlines';

/** §7 / U-6 — one edit to the Goal's criterion list. */
export interface GoalCriterionOp {
    op: 'add' | 'remove' | 'setHard';
    id?: string;
    criterion?: Criterion;
    hard?: boolean;
}

/** `PATCH /stories/:id/goal` — threshold plus the criterion edits, in order (G-1). */
export interface GoalPatch {
    threshold_soft?: number;
    criteria: GoalCriterionOp[];
}

/** D-24 / §8.1 — undo one section write; the pair addresses the §4.4 span. */
export interface UndoTarget {
    chapter_id: string;
    section_id: string;
}

/** §8.6 — the Author-invoked assistant run, aimed at one artifact (never a chat reply). */
export interface AssistantRequest {
    target: 'summary' | 'directive';
    text: string;
}

/** §4.12 / D-17 — `template` for New, `duplicate_of` for Duplicate (built-ins are duplicate-only). */
export interface CreateTemplateInput {
    template?: Template;
    duplicate_of?: string;
}

/**
 * U-13a / D-23 — the Author's merge request, field for field what §8.2's `requestMerge` takes.
 * `parts` is the merge brief ("the opening of revision_1, the ending of revision_2"): the Writer who
 * picks the task up works from that sentence and nothing else, so the Author's taste has to be IN it
 * (D-23: the merged text is a new draft, and the drafts being merged stay competing until it exists).
 */
export interface RevisionMergeRequest {
    unit_ref: string;
    revision_ids: string[];
    parts: string;
    why?: string;
}

/**
 * `GET /stories/:id/knowledge` — the Story's durable knowledge directory.
 *
 * Each section is one harness knowledge article (tags `story:<id>` + `section:<key>`), stored
 * outside every phrase at `<storeRoot>/harness/knowledge/`. The client renders the directory;
 * it never re-derives an entry from the book (the same rule L-14 applies to levels).
 */
export interface StoryKnowledgeEntry {
    key: string;
    title: string;
    body: string;
    tags: string[];
}

export interface StoryKnowledgeSection {
    key: string;
    title: string;
    article_id: string | null;
    updated_at: string | null;
    entries: StoryKnowledgeEntry[];
}

export interface StoryKnowledgeTree {
    story_id: string;
    story_title: string;
    sections: StoryKnowledgeSection[];
    /** True when a section article could not be materialised (the knowledge store is unavailable). */
    degraded: boolean;
}

/**
 * U-8 — the provider's model catalog (`GET /agents/models`), the only choices the roster's
 * dropdown offers. `base_url` is the provider root the harness engine dials.
 */
export interface AgentModelCatalog {
    base_url: string;
    models: string[];
}

/**
 * S-5 — the loop's live fan-out ceiling, read from `GET /loop`. ONE number across EVERY Story: the
 * sweep fills up to it and no further, so it is the throttle on how many threads the crew may run at
 * once (the per-template `max_concurrent` on a template card is a second, smaller ceiling under it).
 *
 * It is host configuration, not a Story record — remembered with the roster's model choices, and pinned
 * at boot by `STORYLINE_GLOBAL_MAX_CONCURRENT` when an operator set one (`server/loop/ceiling.ts` states
 * the precedence) — which is why the control that edits it sits on the GLOBAL employee rail rather than
 * on a Story pane.
 */
export interface LoopSettings {
    global_max_concurrent: number;
    /** Threads live right now, counted from the durable run rows (S-5, L-2). */
    live_runs: number;
}

/** One closed run row, kept on a tile so a failed thread does not vanish into `idle` (S-3, U-8). */
export interface AgentRecentRun {
    run_id: string;
    story_id: string;
    story_title: string;
    work_item: string;
    state: 'spawning' | 'working' | 'reporting' | 'torn_down' | 'failed' | 'abandoned';
    started_at: string;
    ended_at?: string;
    end_reason?: string;
    no_op: boolean;
    tokens: number;
}

/** One employee on the global roster, with every Story thread it is currently working. */
export interface AgentStatusRow {
    /** `writer` | `editor` | `critic` | `reader` — the Storyline role, shared by every Story. */
    kind: string;
    title: string;
    status: 'idle' | 'running';
    /** The harness rank this employee holds; `A` is a peer, not a lead (V-2, D-38a). */
    rank?:
        | 'A'
        | 'B'
        | 'C'
        | 'D'
        | 'E'
        | 'F'
        | 'G'
        | 'H'
        | 'I'
        | 'J'
        | 'K'
        | 'L'
        | 'M'
        | 'N'
        | 'O'
        | 'P'
        | 'Q'
        | 'R'
        | 'S'
        | 'T'
        | 'U'
        | 'V'
        | 'W'
        | 'X'
        | 'Y'
        | 'Z';
    /**
     * U-8 / T-6b — the roster's model for this employee, or the process model when the Author has
     * set none. Optional on the client contract so an older/fake projection still renders: the
     * tile says "not reported" rather than inventing a model.
     */
    model?: string;
    /** `agent` when the Author set it on this roster; `default` for the process model. */
    model_source?: 'agent' | 'default';
    /**
     * Template roles that name their own model for this kind. A role model wins until the Author
     * sets a roster choice here; listing them is what stops the tile misreporting the crew (T-6b).
     */
    template_models?: Array<{ template: string; role: string; model: string }>;
    working: Array<{
        story_id: string;
        story_title: string;
        phase: 'summary' | 'plotlines' | 'chapters';
        role_name: string;
        work_item: string;
        thread_id: string;
        started_at: number;
    }>;
    /** The newest closed threads of this kind, newest first — the tile's "why did it end" (S-3). */
    recent?: AgentRecentRun[];
}

/** The four states a retained thread bar can read. */
export type AgentThreadState = 'running' | 'torn_down' | 'failed' | 'abandoned';

/**
 * U-8 — one step a RUNNING thread has taken. The Author reads these below the (collapsed)
 * request to see what the employee is doing right now; a closed thread drops them, because a
 * finished bar is judged on its request and its answer only.
 */
export interface AgentThreadActivity {
    /** When the step landed (ISO 8601). */
    at: string;
    /** One line: the tool it called (with its result), or the prose turn it produced. */
    text: string;
}

/**
 * One thread of one employee, as the employee tile's content surface renders it. A thread is the
 * employee acting as an agent for one Run.
 * harness's execution unit: the Story is the harness, the phase is its session, and this row is
 * one conversation inside that session. A closed thread's detail is `request` + `answer`; a
 * running thread also carries `activity`, the steps it is taking right now (U-8).
 */
export interface AgentThreadRecord {
    /** The engine thread id; unique for the life of the record. */
    thread_id: string;
    /** The Storyline Run row this thread belongs to (a panel's N threads share one id). */
    run_id: string;
    story_id: string;
    story_title: string;
    /** The phrase (session) the thread ran in — P1 Summary, P3 Plotlines, P4 Chapters. */
    phase: 'summary' | 'plotlines' | 'chapters';
    role: string;
    /** The role name on the bar (`writer`, `editor#agent_2`, a delegated role). */
    role_name: string;
    /** What the thread was asked to do, in one line. */
    title: string;
    state: AgentThreadState;
    started_at: string;
    ended_at?: string;
    tokens: number;
    request: string;
    answer: string;
    error?: string;
    /**
     * Live steps of a thread that is still RUNNING, oldest first. Absent on a closed thread:
     * when the thread completes the bar shows only Request and Answer (U-8).
     */
    activity?: AgentThreadActivity[];
    /** False for a legacy Run row whose pre-retention transcript is gone. */
    retained: boolean;
}

/** `GET /agents/:kind/threads` — every retained thread of one employee, oldest first. */
export interface AgentThreadList {
    kind: string;
    threads: AgentThreadRecord[];
}

/** The full method set T9 imports — one entry per route in the pinned table. */
export interface ApiClient {
    listStories(options?: PageOptions): Promise<StoryRow[]>;
    createStory(input: CreateStoryInput): Promise<StoryRow>;
    /**
     * §10 / P1 — hard-delete a Story and everything it owns: every §4 record, the knowledge
     * directory, and the Story's harness (its sessions and threads). Answers the id it removed.
     */
    deleteStory(storyId: string): Promise<{ deleted: string }>;
    getStory(storyId: string): Promise<StoryView>;
    /**
     * R6 — the SUMMARY PHRASE read: the five groups with their current text, numbers and retained
     * history, the composed Overview, every finding with its group scope and R3's resolution, the open
     * group tasks, and whether the legacy Summary mirror still agrees.
     *
     * A pure read, so it is safe on a legacy book: a Story with no `summary_mode` answers
     * `mode:'sampling'` with empty groups rather than 404, and the rail shows that book its compact
     * upgrade state instead of the group rail (R6's "readable, not migrated").
     */
    getPhrase(storyId: string): Promise<PhraseView>;
    /**
     * R2 — the Author rewrites ONE group by hand. Same install the loop uses, so the group gets a new
     * numbered revision, the text it replaces is archived and retained, its siblings keep their own
     * numbers, the Overview recomposes, and the legacy mirror is rewritten in the same commit (R6).
     *
     * 409 while a Writer holds that group (F8/R4 — `PhraseGroupRow.writer_busy` is the same read, so the
     * control is already disabled), and 409 on a `summary_mode:'sampling'` book, which has no group rows
     * to revise. It answers the refreshed `view`, which is what the store commits.
     */
    revisePhraseGroup(storyId: string, groupId: string, input: PhraseGroupReviseInput): Promise<PhraseGroupReviseResult>;
    /**
     * R1 — the Author locks ONE group in (`POST /stories/:id/phrases/groups/:groupId/lock`).
     *
     * Locked content is settled: the group cannot be revised, its own findings are void, and the other groups
     * adapt to it. The Editor may call the same route when the Story's `editor_group_locking` Setting is on —
     * that is the Setting's whole effect — and the route answers with the refreshed phrase read on the revise
     * route's convention.
     *
     * The refusals are the Author's next action, so they surface verbatim (`ApiError`, L-13): a group nobody has
     * written yet cannot be locked in (there is no text to stand behind), and a group a live Writer is replacing
     * is refused for the same reason revise is (`PhraseGroupRow.writer_busy` is the same read, R4).
     */
    lockPhraseGroup(storyId: string, groupId: string): Promise<PhraseGroupLockResult>;
    /**
     * R1 — the Author opens a locked group again (`POST /stories/:id/phrases/groups/:groupId/unlock`).
     *
     * Only the Author lifts a lock: an Editor that locked a group in cannot release its own decision, so an
     * unlock that arrives from the crew's leg is the refusal a pane would print, not a retry. Same refreshed
     * `view` as the lock route.
     */
    unlockPhraseGroup(storyId: string, groupId: string): Promise<PhraseGroupLockResult>;
    /**
     * D-68 — the Author takes the Reviewed Summary: the clean selection becomes the book in ONE commit.
     *
     * It installs the reviewed text of all five groups as their next revision, flips every revision the
     * choice passed over to the terminal `discarded` state, and records the chosen vector on the Phrase row
     * — so the Summary tab keeps showing the text the Author took after the pipeline moves on. It does NOT
     * lock the phase and claims to resolve nothing (R3's closure rule is untouched).
     *
     * THREE 409 REFUSALS, each an Author-shaped sentence the pane prints verbatim:
     *   - a `'sampling'` book has no group catalog, so there is nothing to choose (the import route first);
     *   - no complete clean selection, naming each group and whether it is unwritten, has `no_clean_revision`,
     *     or is held by an unresolved issue;
     *   - a live Writer holds ANY group — the choice writes five texts at once, so one live pass anywhere
     *     is enough to refuse (R4). `reviewed.writer_busy` is the same read, which is why the control is
     *     disabled rather than clicked into a refusal.
     */
    choosePhraseReviewed(
        storyId: string,
        input?: PhraseReviewedChooseInput
    ): Promise<PhraseReviewedChooseResult>;
    /**
     * T-W4 — ONE PHRASE's own read: `GET /stories/:id/phrases/:key`.
     *
     * It is the Summary's pinned group read, scoped to the phrase the path names, plus that phrase's deltas (its
     * `mode`, the copied Seed's head, its structure `brief`). A mistyped key is a 404 rather than the Summary under
     * a new heading — the catalog is the Server's (R1) — and an UNWRITTEN phrase is not: `plotlines` on a book
     * nobody started answers the empty shape with `mode:'classic'` and `brief:null`, because R6's rule for the
     * Summary (readable, never migrated, never gated on having rows) is generalised to every phrase. That is
     * exactly the read the rail's "start this phrase" row needs.
     */
    getPhraseDetail(storyId: string, key: string): Promise<PhraseDetailView>;
    /**
     * T-W4 — the Author STARTS an on-demand phrase: `POST /stories/:id/phrases/:key/start` (R5 / D-76).
     *
     * ONE START PER PHRASE, and the route refuses a second one with a 409: the copied Seed is the text every entry,
     * revision and claim key was written against, so a new Seed means a new phrase, not a re-start. A `'compiled'`
     * start (the default, and what an absent body means) copies the same text `StoryView.summary_compiled` is
     * computed from — the button and the route cannot disagree about whether there is anything to copy.
     *
     * THE REFUSALS THE DESK PRINTS VERBATIM (L-13): 409 when the phrase is already started; 409 when a `'compiled'`
     * start has no compiled Summary to copy; 400 when `source` is `'custom'` and `text` is empty; 409 for a phrase
     * the loop writes (Phrase ①), which has no seed for an Author to hand over.
     */
    startPhrase(storyId: string, key: string, input?: PhraseStartInput): Promise<PhraseStartResult>;
    /**
     * R7 — the ONE-TIME Seed cleanup, asked BEFORE the start: `GET /stories/:id/phrases/:key/seed/cleanup`.
     *
     * THE VERB IS A READ, AND THAT IS THE WHOLE DESIGN. The pending Seed has no row to read it from (the Start
     * copies it, D-72), so the Author's draft travels in `?seed=` and the answer is a PROPOSAL: text the desk
     * can show, and nothing else. Nothing is written — no Seed, no revision, no journal line — so a cleanup the
     * Author ignores costs one tool-less model turn and no record, which is what keeps it out of the run layer
     * (P10) and out of the Seed's lifecycle (D-76 / §18.13).
     *
     * THE CONFIRM IS THE NEXT START PRESS, NOT A FLAG ON THIS RESPONSE. The desk puts `text` in the Seed box and
     * the Author's next `source:'custom'` press carries it; `StartPhraseRequest` grew nothing, so there is no
     * path by which a cleanup lands on the phrase without a press.
     *
     * `refusal` IS NOT AN ERROR AND COMES BACK 200: `empty_answer` / `numbers_lost` / `too_short` / `too_long`
     * mean the model answered and a guard threw the rewrite away. Such an answer carries NO `text`, so the desk
     * has nothing to confirm and the Author's own draft stands. The refusals that ARE errors (400 no `seed`,
     * 404 no such story or phrase, 409 a phrase that is not Author-seeded / already started / has no transport)
     * arrive as `ApiError` from `request`, and the desk prints the server's sentence (L-13).
     *
     * THE ONE COST OF A GET: the draft rides in the request line, so a brief longer than the server's request-line
     * ceiling (Node's 16 KiB by default) fails at the transport rather than at a rule. The Seed box holds a brief,
     * not a manuscript, and the ceiling is documented on the yaml operation.
     */
    getPhraseSeedCleanup(storyId: string, key: string, seed: string): Promise<SeedCleanupProposal>;
    /**
     * T-W4 — the Author rewrites ONE CHAPTER ENTRY (`POST …/phrases/groups/:groupId/revise`, the entry leg).
     *
     * Same route as the Summary group's revise, different body: an entry's text is composed from its contract
     * fields, so this verb sends `plotpoints` and the route derives the prose (`phrase/plotpoints.ts`). It refuses
     * a plotlines entry with no plotpoints rather than mirroring a stale `plotlines` contract under new prose (P4),
     * and the refreshed `view` is the PHRASE ② read rather than the Summary's.
     */
    revisePhraseEntry(
        storyId: string,
        groupId: string,
        input: PhraseEntryReviseInput
    ): Promise<PhraseEntryReviseResult>;
    /** The durable knowledge directory for one Story (eight section articles, harness-owned). */
    getStoryKnowledge(storyId: string): Promise<StoryKnowledgeTree>;
    /** The global employee roster: Writer/Editor/Critic/Reader, their models and live threads. */
    listAgents(): Promise<AgentStatusRow[]>;
    /** U-8 — the provider's model catalog, the roster dropdown's only choices. */
    listAgentModels(): Promise<AgentModelCatalog>;
    /**
     * U-8 — every thread one employee ran, across every Story and every phrase session, oldest
     * first.
     * This is what clicking the employee tile opens in the content area; `request` and `answer`
     * are the detail of each bar.
     */
    listAgentThreads(kind: string, options?: PageOptions): Promise<AgentThreadList>;
    /**
     * U-8 — set (or clear, with `null`) one employee's model on the global roster. Answers the
     * whole refreshed projection, because every tile's model line is server-owned.
     */
    setAgentModel(kind: string, model: string | null): Promise<AgentStatusRow[]>;
    /**
     * S-5 — the loop's live fan-out ceiling and the threads occupying it right now. Global: it belongs
     * to the process, not to any Story, so it has no Story row to read it off.
     */
    getLoopSettings(): Promise<LoopSettings>;
    /**
     * S-5 — moving that ceiling while the loop runs. The next sweep fills the new capacity; lowering it
     * cancels no thread already in flight. Answers the same projection `getLoopSettings` does, so the
     * control re-renders from the server's number rather than from what was typed.
     */
    setGlobalMaxConcurrent(limit: number): Promise<LoopSettings>;
    patchStory(storyId: string, patch: StoryPatch): Promise<StoryRow>;
    stop(storyId: string): Promise<StoryRow>;
    resume(storyId: string): Promise<StoryRow>;
    clearPending(storyId: string): Promise<StoryRow>;
    /** U-16 — locks the CURRENT phase; 409 naming the Ideas tray when it is non-empty (L-7a). */
    lockPhase(storyId: string): Promise<PhaseLockResult>;
    /** L-32 — 409-style text names what would be deleted; the client confirms first. */
    backtrack(storyId: string, phase: BacktrackPhase): Promise<StoryRow>;
    approveFinding(storyId: string, findingId: string, why: string): Promise<StoryRow>;
    /**
     * U-10b — "approve a whole chapter's worth" in one call. The server approves every `confirmed`
     * finding aimed at the chapter (by `target_ref` OR by L-11a `related_refs`), one journaled
     * approval each; it is the chapter-scale move U-10b names next to approving one finding.
     */
    approveChapterFindings(storyId: string, chapterId: string, why: string): Promise<StoryRow>;
    discardFinding(storyId: string, findingId: string, why: string): Promise<StoryRow>;
    selectIdea(storyId: string, ideaId: string, note: string): Promise<StoryRow>;
    discardIdea(storyId: string, ideaId: string): Promise<StoryRow>;
    deferIdea(storyId: string, ideaId: string): Promise<StoryRow>;
    /** P9a / D-37 — an Author prose edit; 409 naming D-37 unless the Story is stopped. */
    editSection(storyId: string, chapterId: string, sectionId: string, content: string): Promise<StoryRow>;
    unapproveChapter(storyId: string, chapterId: string): Promise<StoryRow>;
    acceptProposal(storyId: string, proposalId: string): Promise<StoryRow>;
    rejectProposal(storyId: string, proposalId: string): Promise<StoryRow>;
    /** P11 / U-5 — undo one section write back to the previous revision. */
    undo(storyId: string, target: UndoTarget): Promise<StoryRow>;
    /**
     * U-13 / D-24 — the Author takes one competing draft as the version that stands. `note` lands in
     * the draft's `selection_note`; omitted, the server writes its own "selected by the Author".
     */
    selectRevisionAuthor(storyId: string, revisionId: string, note?: string): Promise<StoryRow>;
    /** U-13a / D-23 — the Author asks for named drafts to be merged; the drafts stay competing. */
    mergeRevisions(storyId: string, request: RevisionMergeRequest): Promise<StoryRow>;
    /** Phase ① — "not final yet": queue another three-draft Summary round from the selected revision. */
    requestSummaryRevision(storyId: string, note?: string): Promise<StoryRow>;
    /**
     * U-9 / D-19 — one line addressed to the Editor; it records a `directives` row and propagates.
     * `refs` names the artifact the Author is looking at, so the Editor updates the focused pane
     * even when the sentence never spells out a chapter or plotline.
     */
    sendDirective(storyId: string, text: string, refs?: string[]): Promise<StoryRow>;
    /** L-26 — the Author's acceptance is what closes the leftovers (L-25b). */
    acceptCompletion(storyId: string): Promise<StoryRow>;
    /** D-17b — the assignment list, replaceable wholesale (the count is the Author's call). */
    assignTemplates(storyId: string, templateIds: string[]): Promise<StoryRow>;
    patchGoal(storyId: string, patch: GoalPatch): Promise<GoalSurface>;
    /** G-1 / §14 item 2 — per-chapter bar override. */
    setChapterBar(storyId: string, chapterId: string, barOverride: string): Promise<StoryRow>;
    listTemplates(): Promise<Template[]>;
    createTemplate(input: CreateTemplateInput): Promise<Template>;
    patchTemplate(templateId: string, patch: Partial<Template>): Promise<Template>;
    /**
     * §4.13 — `storyId` omitted lists every Story's runs.
     *
     * R4 — every row arrives with its PHRASE ATTRIBUTION (`phrase_key`), which the server derives from the
     * run's own `group_refs` and `work_item_ref`. The desk renders no phrase words of its own, so a crew row
     * standing under a Phrase-① rail cannot silently be Phrase-② work.
     */
    listRuns(storyId?: string, options?: PageOptions): Promise<ProjectedRun[]>;
    /**
     * S-3 — teardown with a recorded reason; the Author's kill (U-7). S-RUNTIME: a run id is LOCAL to one
     * Story's book, so `storyId` names which book's executor aborts the thread. Omit it only when the id is
     * unique across the workspace's books — several Stories holding the same local id answer 409, because
     * stopping one of them by book order would stop a thread the Author never pointed at.
     */
    killRun(runId: string, storyId?: string): Promise<Run>;
    /** U-10 — the cross-Story queue that is the home screen. */
    getQueue(options?: PageOptions): Promise<QueueItem[]>;
    /** §8.6 — the assistant tool the locked panes offer (U-4). */
    requestAssistant(storyId: string, request: AssistantRequest): Promise<Run>;
    /**
     * §10 — the SSE channel. Emits `(kind, storyId?)`; the caller refetches the touched
     * resource rather than trusting a pushed payload (P1/P3: the store is the memory).
     * Returns the teardown. Falls back to a {@link FALLBACK_POLL_MS} poll when `EventSource`
     * is missing or fails, so a proxy that buffers SSE still yields a live dashboard.
     */
    subscribeEvents(onEvent: (kind: StreamKind, storyId?: string) => void): () => void;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** A refused request, carrying the server's own sentence (L-13) and its status code. */
export class ApiError extends Error {
    readonly status: number;
    readonly storyId?: string;

    constructor(status: number, message: string, storyId?: string) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.storyId = storyId;
    }
}

/**
 * One JSON round trip. Failure handling is deliberately loud-but-plain: the `{error}` text
 * is the product copy, so it is re-thrown verbatim; only a body that is not JSON yields the
 * generic line. A 204 (no body) resolves to `undefined as T`.
 */
/** The `?limit=&offset=` suffix a chunked call carries; nothing when no window was asked for. */
function pageParams(options?: PageOptions): Record<string, string> {
    const params: Record<string, string> = {};

    if (options?.limit !== undefined) params.limit = String(options.limit);
    if (options?.offset !== undefined) params.offset = String(options.offset);

    return params;
}

/** A query string from a parameter record, or `''` when it is empty. */
function queryString(params: Record<string, string | undefined>): string {
    const entries = Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined);

    if (entries.length === 0) return '';

    return `?${new URLSearchParams(entries).toString()}`;
}

function pageQuery(options?: PageOptions): string {
    return queryString(pageParams(options));
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${API_ROOT}${path}`, {
        ...init,
        headers: {
            accept: 'application/json',
            ...(init?.body ? { 'content-type': 'application/json' } : {}),
            ...init?.headers
        }
    });

    if (!response.ok) {
        let message = `request refused (${response.status} ${response.statusText})`;
        try {
            const body = (await response.json()) as { error?: string };
            if (typeof body?.error === 'string' && body.error) {
                message = body.error;
            }
        } catch {
            // A non-JSON error body (a proxy's HTML 502 page) is exactly the case the
            // generic message above is for — nothing to log, the status already says it.
        }
        throw new ApiError(response.status, message);
    }

    if (response.status === 204) {
        return undefined as T;
    }
    return (await response.json()) as T;
}

/** `POST` with an optional body — most of the surface is verbs, not documents. */
function post<T>(path: string, body?: unknown): Promise<T> {
    return request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
}

/** `PATCH` with a partial document. */
function patch<T>(path: string, body: unknown): Promise<T> {
    return request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}

/** `DELETE` — the Author's hard delete; the server answers the id it removed. */
function del<T>(path: string): Promise<T> {
    return request<T>(path, { method: 'DELETE' });
}

/** Story-scoped prefix — kept as a function so no path is assembled twice. */
const storyPath = (storyId: string, suffix = ''): string => `/stories/${encodeURIComponent(storyId)}${suffix}`;

/**
 * EventSource with a polling fallback.
 *
 * WHY A FALLBACK AT ALL: the gateway sits in front of the stream, and a proxy that buffers
 * `text/event-stream` (or a browser extension that blocks it) would otherwise leave the
 * dashboard frozen on a page that looks healthy. Degrading to a 5s refetch cadence keeps
 * U-2's "right now" honest enough without pretending it is the transport (L-24: the UI
 * should not lie about what it is doing, so the degraded mode is a real, slower poll).
 */
function subscribeEvents(onEvent: (kind: StreamKind, storyId?: string) => void): () => void {
    let timer: ReturnType<typeof setInterval> | null = null;
    let source: EventSource | null = null;
    let closed = false;

    const startPoll = (): (() => void) => {
        if (closed) {
            return () => undefined;
        }
        timer = setInterval(() => {
            // A poll re-reads everything, so it announces all three topics in order: the
            // store's handler is idempotent and refetches, which is the same work an event
            // would have triggered.
            onEvent('story');
            onEvent('runs');
            onEvent('queue');
        }, FALLBACK_POLL_MS);
        return () => {
            if (timer !== null) {
                clearInterval(timer);
                timer = null;
            }
        };
    };

    if (typeof EventSource === 'undefined') {
        return startPoll();
    }

    try {
        source = new EventSource(`${API_ROOT}/stream`);
    } catch {
        return startPoll();
    }

    const handlers: Array<[StreamKind, EventListener]> = (['story', 'runs', 'queue'] as StreamKind[]).map((kind) => [
        kind,
        (event: Event) => {
            // `data` is the story id, or empty for a workspace-wide change (runs/queue
            // aggregate across Stories, so the server may omit it).
            const data = (event as MessageEvent).data;
            onEvent(kind, typeof data === 'string' && data.length > 0 ? data : undefined);
        }
    ]);
    for (const [kind, listener] of handlers) {
        source.addEventListener(kind, listener);
    }

    // A stream that errors is retried by EventSource itself; if it errors again the socket
    // is not usable in this environment, so switch once to polling rather than retrying
    // forever behind a spinner the spec forbids (U-11).
    source.onerror = () => {
        if (closed || timer !== null) {
            return;
        }
        const dead = source;
        source = null;
        dead?.close();
        startPoll();
    };

    return () => {
        closed = true;
        if (timer !== null) {
            clearInterval(timer);
            timer = null;
        }
        source?.close();
        source = null;
    };
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/** The pinned surface, as data — injected wholesale by `state.ts` and by the tests. */
export const api: ApiClient = {
    listStories: (options) => request<StoryRow[]>(`/stories${pageQuery(options)}`),
    createStory: (input) => post<StoryRow>('/stories', input),
    deleteStory: (storyId) => del<{ deleted: string }>(storyPath(storyId)),
    getStory: (storyId) => request<StoryView>(storyPath(storyId)),
    // R6 — the group read. One route per Story, because the rail is one read of the whole Summary Phrase.
    getPhrase: (storyId) => request<PhraseView>(storyPath(storyId, '/phrases')),
    // R2 — the Author's hand edit of ONE group. The group is addressed by its UUID, so a refetch that
    // reorders the catalog cannot move the write onto a sibling group.
    revisePhraseGroup: (storyId, groupId, input) =>
        post<PhraseGroupReviseResult>(
            storyPath(storyId, `/phrases/groups/${encodeURIComponent(groupId)}/revise`),
            input.note === undefined ? { content: input.content } : { content: input.content, note: input.note }
        ),
    // R1 — the lock pair. The GROUP is addressed by its UUID in the path, exactly as revise does, so a catalog
    // reorder cannot move the write onto a sibling row. No body: the verdict is "this text stands", and who made
    // it is the route's own attribution (the Author, or the Editor while the Setting is on), never a field the
    // desk asserts about itself.
    lockPhraseGroup: (storyId, groupId) =>
        post<PhraseGroupLockResult>(storyPath(storyId, `/phrases/groups/${encodeURIComponent(groupId)}/lock`)),
    unlockPhraseGroup: (storyId, groupId) =>
        post<PhraseGroupLockResult>(storyPath(storyId, `/phrases/groups/${encodeURIComponent(groupId)}/unlock`)),
    // D-68 — the Author's choose. No group id in the path: the choose addresses the WHOLE reviewed
    // Overview (five installs, one commit), and the note is optional, so an absent one sends no key rather
    // than an empty string the attribution line would print.
    choosePhraseReviewed: (storyId, input) =>
        post<PhraseReviewedChooseResult>(
            storyPath(storyId, '/phrases/reviewed/choose'),
            input?.note === undefined || input.note === '' ? {} : { note: input.note }
        ),
    // T-W4 — the PHRASE ② read. The key is a catalog word, not a UUID, but it still goes through
    // `encodeURIComponent`: a route parameter is a route parameter, and a client that interpolated raw text into
    // a path segment would be one mistyped selection away from addressing the wrong resource.
    getPhraseDetail: (storyId, key) =>
        request<PhraseDetailView>(storyPath(storyId, `/phrases/${encodeURIComponent(key)}`)),
    // T-W4 — the on-demand start. The body carries exactly the keys the Author chose: `'custom'` sends its text,
    // `'compiled'` sends NO text (the route ignores a stray one, and this client does not make it ignore one), and
    // an absent input sends `{}` — which the route resolves to `'compiled'`, the same default it documents.
    startPhrase: (storyId, key, input) =>
        post<PhraseStartResult>(
            storyPath(storyId, `/phrases/${encodeURIComponent(key)}/start`),
            input === undefined
                ? {}
                : input.source === 'custom'
                  ? { source: 'custom', text: input.text ?? '' }
                  : { source: 'compiled' }
        ),
    // R7 — THE SEED CLEANUP, and the reason the draft rides in the QUERY rather than a body: the verb is a GET, so
    // the one-time proofread stays a read the desk can retry, cancel or ignore without a write to undo (P10). The
    // text is `encodeURIComponent`-escaped because a brief is prose: an `&`, a `#` or a `+` in the Author's
    // sentence is ordinary, and a client that interpolated it raw would silently ask about a different draft.
    // `refusal` comes back 200 (see `SeedCleanupProposal`), so the desk reads the arm off `ok` and never off a
    // status code; the 400/404/409 arms arrive as `ApiError`, whose `message` is the server's own sentence.
    getPhraseSeedCleanup: (storyId, key, seed) =>
        request<SeedCleanupProposal>(
            storyPath(storyId, `/phrases/${encodeURIComponent(key)}/seed/cleanup?seed=${encodeURIComponent(seed)}`)
        ),
    // T-W4 — ONE CHAPTER ENTRY's hand revision. The body carries `plotpoints`, never `content`: the entry's prose
    // is composed from the contract fields server-side, and a `content` key beside them is not read (P4). The group
    // is addressed by its UUID, exactly as the Summary group's revise does, so a refetch that reorders the entries
    // cannot move the write onto a sibling chapter.
    revisePhraseEntry: (storyId, groupId, input) =>
        post<PhraseEntryReviseResult>(
            storyPath(storyId, `/phrases/groups/${encodeURIComponent(groupId)}/revise`),
            input.note === undefined
                ? { plotpoints: input.plotpoints }
                : { plotpoints: input.plotpoints, note: input.note }
        ),
    getStoryKnowledge: (storyId) => request<StoryKnowledgeTree>(storyPath(storyId, '/knowledge')),
    listAgents: () => request<AgentStatusRow[]>('/agents'),
    listAgentModels: () => request<AgentModelCatalog>('/agents/models'),
    listAgentThreads: (kind, options) =>
        request<AgentThreadList>(`/agents/${encodeURIComponent(kind)}/threads${pageQuery(options)}`),
    setAgentModel: (kind, model) => patch<AgentStatusRow[]>(`/agents/${encodeURIComponent(kind)}`, { model }),
    // S-5 — the loop's ceiling. One global pair of routes, because the number is the process's and no
    // Story owns it; the PATCH answers the fresh projection, never what the Author typed.
    getLoopSettings: () => request<LoopSettings>('/loop'),
    setGlobalMaxConcurrent: (limit) => patch<LoopSettings>('/loop', { global_max_concurrent: limit }),
    patchStory: (storyId, body) => patch<StoryRow>(storyPath(storyId), body),
    stop: (storyId) => post<StoryRow>(storyPath(storyId, '/stop')),
    resume: (storyId) => post<StoryRow>(storyPath(storyId, '/resume')),
    clearPending: (storyId) => post<StoryRow>(storyPath(storyId, '/clear-pending')),
    // T12 — the row PLUS `lock_receipt` (additive, see `PhaseLockReceipt`). The desk ignores the receipt and
    // keeps computing its own accept counts; the type only keeps this file honest about the wire.
    lockPhase: (storyId) => post<PhaseLockResult>(storyPath(storyId, '/lock')),
    backtrack: (storyId, phase) => post<StoryRow>(storyPath(storyId, '/backtrack'), { phase }),
    approveFinding: (storyId, findingId, why) =>
        post<StoryRow>(storyPath(storyId, `/findings/${encodeURIComponent(findingId)}/approve`), { why }),
    // U-10b. The chapter's whole approval in one fetch; the server does one commit per finding, so the
    // audit still shows each decision (D-34) rather than one anonymous batch.
    approveChapterFindings: (storyId, chapterId, why) =>
        post<StoryRow>(storyPath(storyId, `/chapters/${encodeURIComponent(chapterId)}/findings/approve-all`), { why }),
    discardFinding: (storyId, findingId, why) =>
        post<StoryRow>(storyPath(storyId, `/findings/${encodeURIComponent(findingId)}/discard`), { why }),
    selectIdea: (storyId, ideaId, note) =>
        post<StoryRow>(storyPath(storyId, `/ideas/${encodeURIComponent(ideaId)}/select`), { note }),
    discardIdea: (storyId, ideaId) =>
        post<StoryRow>(storyPath(storyId, `/ideas/${encodeURIComponent(ideaId)}/discard`)),
    deferIdea: (storyId, ideaId) => post<StoryRow>(storyPath(storyId, `/ideas/${encodeURIComponent(ideaId)}/defer`)),
    editSection: (storyId, chapterId, sectionId, content) =>
        post<StoryRow>(
            storyPath(storyId, `/chapters/${encodeURIComponent(chapterId)}/sections/${encodeURIComponent(sectionId)}`),
            { content }
        ),
    unapproveChapter: (storyId, chapterId) =>
        post<StoryRow>(storyPath(storyId, `/chapters/${encodeURIComponent(chapterId)}/unapprove`)),
    acceptProposal: (storyId, proposalId) =>
        post<StoryRow>(storyPath(storyId, `/proposals/${encodeURIComponent(proposalId)}/accept`)),
    rejectProposal: (storyId, proposalId) =>
        post<StoryRow>(storyPath(storyId, `/proposals/${encodeURIComponent(proposalId)}/reject`)),
    undo: (storyId, target) => post<StoryRow>(storyPath(storyId, '/undo'), target),
    // U-13 / D-24. The note is optional in the body: the server's default is its own sentence, and an
    // empty string is not the same thing as no note (L-13 — the note is what the next run reads).
    selectRevisionAuthor: (storyId, revisionId, note) =>
        post<StoryRow>(
            storyPath(storyId, `/revisions/${encodeURIComponent(revisionId)}/select`),
            note === undefined ? {} : { note }
        ),
    // U-13a / D-23. Same task the Reader's `requestMerge` opens; the desk shows one entry either way.
    mergeRevisions: (storyId, request) => post<StoryRow>(storyPath(storyId, '/revisions/merge'), request),
    requestSummaryRevision: (storyId, note) =>
        post<StoryRow>(storyPath(storyId, '/summary/revise'), note === undefined ? {} : { note }),
    sendDirective: (storyId, text, refs) =>
        post<StoryRow>(storyPath(storyId, '/directives'), refs && refs.length > 0 ? { text, refs } : { text }),
    acceptCompletion: (storyId) => post<StoryRow>(storyPath(storyId, '/complete')),
    assignTemplates: (storyId, template_ids) => post<StoryRow>(storyPath(storyId, '/templates'), { template_ids }),
    patchGoal: (storyId, body) => patch<GoalSurface>(storyPath(storyId, '/goal'), body),
    setChapterBar: (storyId, chapterId, bar_override) =>
        patch<StoryRow>(storyPath(storyId, `/chapters/${encodeURIComponent(chapterId)}/bar`), { bar_override }),
    listTemplates: () => request<Template[]>('/templates'),
    createTemplate: (input) => post<Template>('/templates', input),
    patchTemplate: (templateId, body) => patch<Template>(`/templates/${encodeURIComponent(templateId)}`, body),
    listRuns: (storyId, options) =>
        request<ProjectedRun[]>(
            `/runs${queryString({
                ...(storyId === undefined ? {} : { story_id: storyId }),
                ...pageParams(options)
            })}`
        ),
    killRun: (runId, storyId) =>
        post<Run>(`/runs/${encodeURIComponent(runId)}/kill${storyId ? `?story_id=${encodeURIComponent(storyId)}` : ''}`),
    getQueue: (options) => request<QueueItem[]>(`/queue${pageQuery(options)}`),
    requestAssistant: (storyId, body) => post<Run>(storyPath(storyId, '/assistant'), body),
    subscribeEvents
};

export default api;
