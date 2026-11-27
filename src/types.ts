// Type-only definitions shared with @underload/storyline's public wire/domain model.
//
// THIS FILE HAS NO RUNTIME CODE BY DESIGN. The UI is a client of the separate
// `@underload/storyline` package: every list, label, default, catalog and derivation it
// renders comes from the server's projections. Only the names of the records and the shapes
// the wire carries are duplicated here so the client can type what it receives. Tests may
// use their own mocks/fixtures for runtime values (see `dashboard/testing`).
//
// Generated from the server's `src/shared/types.ts` plus `CriterionLevel`; keep field names
// in step with `src/server/api/contract.ts` and the OpenAPI document in the server package.

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
/** §4.1 `phase` — the three pipeline stages. `completed` is a STATUS, never a phase. */

export type StoryPhase = 'summary' | 'plotlines' | 'chapters';
/** §4.1 `status` — whether agents may work on the Story (the sweep dispatches `ready` only, L-0). */

export type StoryStatus = 'ready' | 'pending' | 'completed' | 'stopped';
/**
 * §4.1 `pending_kind` — which flavour of waiting this is. The first four are the loop
 * waiting for the Author BY DESIGN; only `stalled` means the loop hit a wall (P14, L-37a).
 */

export type PendingKind = 'phase_signoff' | 'idea_selection' | 'finding_approval' | 'drained' | 'stalled' | 'none';
/** §4.1 `trend` — drives the `pending` transition (§6.8). Drained outranks `flat` (L-37a). */

export type Trend = 'improving' | 'flat' | 'regressing' | 'unknown';
/**
 * §4.10 `cost` / §4.1 `auto_approve` — the finding costs. One list, two jobs (D-35b): the
 * dial that decides which findings skip the Author's approval gate, and the same dial that
 * sets the drain threshold (L-37). Order is significant: it is the triage scale.
 *
 * ALL FOUR VALUES STAY, whatever the kind taxonomy does to them. `taste` is load-bearing four
 * ways over — persisted rows carry it, `costDistribution` hard-keys it (api/projections.ts), the
 * D-35b auto-approve dial lists it, and the drain/threshold math reads the ladder as a whole —
 * so D-33b narrows WHO may file at `taste` rather than deleting the word: `raiseFinding` refuses
 * a `taste`-cost `issue` and a `critical`-cost `proposal` (tools/reader.ts). The Editor's own
 * triage stays unrestricted (D-34a: its cost call is final, and it may re-cost a row to any rung).
 */

export type Cost = 'critical' | 'major' | 'minor' | 'taste';
/**
 * The dial's built-in default (D-35): on for `critical`, `major` and `minor`, off for `taste`.
 * Exported so the store, the tools and the UI cannot drift apart on it.
 */

/**
 * §4.10 `kind` (additive) — WHAT a finding claims, as distinct from `cost`, which says only how much
 * repairing it costs. The two are ORTHOGONAL, but not unrestricted: each kind owns part of the cost
 * ladder (D-33b). An `issue` is rated `critical` / `major` / `minor` — never `taste`, because "that is
 * a preference" is the sentence that makes it a Proposal. A `proposal` is rated `major` / `minor` /
 * `taste` — never `critical`, because `critical` is the ladder's word for a contradiction the text
 * cannot live with, and a suggestion the Seed never promised is not one.
 *
 * `issue` is the §4.10 claim: a defect — it breaks the story's logic, it is inconsistent with a
 * commitment, or it is a claim the artifact cannot support — and it is admissible only by quoting that
 * commitment and showing the artifact breaking it, which is why an Editor `dispute`s a claim whose
 * whole case is an ABSENCE (D-33's admissibility gate). `proposal` is the improvement the Author asked
 * for by name: word changes, a new element, linking a twist. The absence rule does not apply to it,
 * and the Editor weighs it on merit — does the change genuinely strengthen the story the Seed promises,
 * is it worth a Writer pass, does it contradict the installed text?
 *
 * `issue` is FIRST because it is the default: a row raised before this field existed claimed a defect,
 * and a raise that names no `kind` claims a defect. Order carries no other meaning (unlike `cost`,
 * whose order is the triage scale).
 */

export type FindingKind = 'issue' | 'proposal';
/**
 * §4.12 `roles[].kind` — selects the brief and the PERMISSION ROW, never the tool list
 * (D-17a, T-6a). All five kinds hold the whole catalogue; the server refuses the calls a
 * kind may not make (T-1a).
 *
 * `researcher` is the Phase-1 research pipeline's employee (documents/phase-1-research-pipeline.md
 * §3.1): it reads everything and writes only `knowledge`, so the pipeline can research the
 * period/place/facts a Story depends on without ever touching the book. Appending it (rather
 * than inserting) keeps the §4 order of the original four intact.
 */

export type RoleKind = 'writer' | 'editor' | 'critic' | 'reader' | 'researcher';
/** §4.10 `state` — the finding chain: raise (unconfirmed) → verify → approve → fix (D-33, D-34). */

export type FindingState = 'unconfirmed' | 'confirmed' | 'approved' | 'fixed' | 'disputed' | 'discarded';
/**
 * §4.17 `state` — the Idea lifecycle. `refuted`/`unverifiable` are Editor verdicts;
 * `selected`/`discarded`/`deferred` are the Author's decisions, and the decided ones are
 * the anti-loop memory for that phase only (D-32, D-36).
 */

export type IdeaState = 'proposed' | 'verified' | 'refuted' | 'unverifiable' | 'selected' | 'discarded' | 'deferred';
/** §4.4 `state` — one chapter's place in the pipeline. */

export type ChapterState = 'outlined' | 'drafting' | 'in_pass' | 'in_review' | 'needs_author' | 'done' | 'needs_recheck';
/** §4.7 `state` — the loop's work queue (D-11). */

export type TaskState = 'open' | 'claimed' | 'blocked' | 'done' | 'wontfix';
/** §4.13 `state` — one ephemeral harness, spawn to teardown (S-1, S-3, D-18). */

export type RunState = 'spawning' | 'working' | 'reporting' | 'torn_down' | 'failed' | 'abandoned';
/** §4.14 `state` — a directive the loop must propagate, not a chat message (D-19). */

export type DirectiveState = 'queued' | 'propagating' | 'done' | 'rejected';
/**
 * §4.15 `state` — competing attempts at one unit. Everything but `selected` is deleted in
 * the selection commit (P13, D-22); the states exist so the deletion and the Author's
 * restore path (D-24) are expressible, not so drafts linger.
 *
 * A Writer's draft has its own two-step life before it competes: `pending` while that Writer
 * is still working on the revision (a later `editSummary`/`editChapter` in the same run extends
 * the same row), then `drafted` once the run closes and the draft is complete enough to review.
 * Only `drafted` (and the legacy `competing` rows written before this lifecycle existed) are
 * offered to Critics, Readers and the Editor.
 */

export type RevisionState = 'pending' | 'drafted' | 'competing' | 'selected' | 'merged_into' | 'discarded';
/** §4.16 `state` — the agent→Author direction only (D-20, D-20a). */

export type ProposalState = 'pending' | 'accepted' | 'rejected';
/** §4.15 `unit_kind` — the divergence unit: chapter, plotline, or Summary (§14 item 1d). */

export type UnitKind = 'summary' | 'plotline' | 'chapter';
/** §4.6 `kind` — the ledger's fact classes. */

export type LedgerKind = 'setup' | 'payoff' | 'fact' | 'timeline' | 'world_rule';
/** §4.6 `status` — a ledger fact's standing. `conflict` blocks completion (L-25). */

export type LedgerStatus = 'open' | 'paid' | 'conflict' | 'stale';
/** §4.17 `kind` — what an Idea is: a direction, a possibility, a fact, or a warning. */

export type IdeaKind = 'direction' | 'possibility' | 'fact' | 'warning';
/** §4.9 `recommendation` — `stuck` means the reader believes the Story should go `pending`. */

export type VerdictRecommendation = 'advance' | 'fix' | 'stuck';
/** §4.17 `verification.verdict` — the Editor's fact-check answer (D-27, C-15). */

export type IdeaVerdict = 'verified' | 'refuted' | 'unverifiable';
/**
 * §4.4 / §8.1 `sections[].origin` — who produced a chapter section. `author` makes the
 * span propose-only for every agent (P9, T-2, D-37a); the section is the unit that carries
 * it, which is what makes P9 enforceable without freezing the whole chapter (T-2).
 */

export type SectionOrigin = 'writer' | 'author';
/** §4.15 / §8.2 `aggregate` — how N fresh agents inside one role answer as one (D-38). */

export type RoleAggregation = 'majority' | 'merge' | 'lead';
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
/**
 * Phase ①'s standard sampling size: how many no-tool Writers expand one Seed Brief into competing
 * `SummarySample` drafts per round. The number is a STORY setting (`summary_sampling`), not a
 * template's `attempts` — the phase-① sampler is one turn per sample (`attempts: 1`), and this is
 * the fallback `records.ts:samplingSizeOf` and the Summary pane read when the Story sets nothing.
 *
 * A ROUND IS THREE DRAFTS. Three is enough for a real choice (one kept, two discarded) without
 * turning the first pass into a lottery. Every later round is a fresh set written from the kept
 * revision plus the fix tasks, so the rail is a linear Revision 1…N history, not a tree.
 */

/**
 * Phase ①'s standard Critic count: how many no-tool screening passes judge each sample (§6.4
 * step 4), and how many deep-review Critic passes the selected revision gets (§6.4 step 6). The
 * Author may change it per Story (`summary_critics`).
 */

/** The largest sample/critic count the API accepts — a typo guard, not a model constraint. */

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
 *   - `summary_sampling` / `summary_critics` — the phase-① pipeline's two dials: how many
 *     Writer samples one Summary gets and how many Critics critique each sample. Author
 *     settings, absent means the standard above.
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
    /** Phase ①: how many Writers expand one Seed into competing Summary drafts (default 3). */
    summary_sampling?: number;
    /** Phase ①: how many Critics critique each Summary draft before the Editor sees it (default 5). */
    summary_critics?: number;
    /**
     * SUMMARY PHRASE (additive, §4 allows adding fields): which Summary authoring model this Story
     * uses.
     *
     * - `'groups'` — the Summary Phrase redesign. The five catalog groups
     *   ({@link PHRASE_GROUP_KEYS} in `shared/phrase.ts`) are the writable truth, each with its own
     *   sequential revision line ({@link GroupRevision}), and the `summaries` row's prose fields are
     *   a GENERATED MIRROR written in the same commit as a new latest group revision (R6). The
     *   whole-Summary competing-sampling machinery (draft sets, Editor/sample selection) does not
     *   run for such a Story: an accepted Writer result installs immediately (R5).
     * - `'sampling'` — the pre-redesign path: one Writer pass writes all six Summary fields as one
     *   draft, N drafts compete, and the deterministic selector installs the winner.
     *
     * ABSENT MEANS `'sampling'`, and that is what makes legacy books readable with no migration (R6):
     * a Story written before the redesign has no `phrase_groups` rows, so nothing may claim its
     * Summary is group-managed. `server/phrase/catalog.ts:isGroupManagedStory` is the ONE predicate
     * that decides, and every guard in the loop reads it from there.
     *
     * It is a Story setting rather than a derived fact because the Author owns the switch. Only two
     * things set it to `'groups'`: `engine.ts:createStory` (every NEW Story starts in the group
     * model) and the explicit legacy import (`POST /stories/:id/phrases/import`). A pure read never
     * writes it, and no code path flips a Story back to `'sampling'` behind the Author's back.
     */
    summary_mode?: 'groups' | 'sampling';
    /**
     * PHRASE ② PLOTLINES (additive) — which Plotlines authoring model this Story uses.
     *
     * THE `summary_mode` PRECEDENT EXACTLY (`Story.summary_mode` above, and
     * `server/phrase/catalog.ts:isGroupManagedStory`): ABSENT means `'classic'`, which is what every
     * book written before Phrase ② exists reads as, so no migration is needed and a pure read never
     * writes the field.
     *
     * - `'classic'` — today's Phase ②: the `plotlines` rows are the chapter contracts and the Writer
     *   builds them with the §8.1 `createPlotline`/`editPlotline` tools.
     * - `'groups'` — the Plotlines Phrase (`shared/phrase.ts:PHRASE_PLOTLINES_KEY`). Its entries are
     *   CHAPTER GROUPS (`phrase_groups` rows keyed `chapter_<n>` on the plotlines `phrases` row), each
     *   holding that chapter's precise plotpoints, and the `plotlines` rows become the GENERATED
     *   mirror written in the same commit as the chapter group's latest revision — the plotlines
     *   phrase's equivalent of the summary's legacy mirror.
     *
     * The loop wave sets this on new Stories; nothing else writes it. It is a Story SETTING rather
     * than a derived fact for the same reason `summary_mode` is: rows can exist while a start step is
     * still settling, and an Author who moves a book back must stop being phrase-managed at once.
     */
    plotlines_mode?: 'groups' | 'classic';
    /**
     * PHRASE GROUP LOCK (additive) — may the EDITOR put a Summary phrase group into the locked state?
     *
     * The Editor's judgment is a recommendation about a group the pipeline keeps wanting to rewrite:
     * the Critic's findings on it are exhausted (no issues, or no major improvement left to buy) and
     * the Reader's score and rationale say the text is doing its job. Locking the group then stops the
     * rewrites and makes that text the fixed point the OTHER groups are revised against for consistency.
     *
     * ABSENT means DISABLED — the conservative default, and what every book written before this field
     * exists reads as. Only a deliberate Author write turns it on, and it is a permission for the Editor
     * alone: the Author may lock on any group-managed Story whether this is on or not
     * (`phrase/locks.ts:lockPhraseGroup`), and neither actor may unlock but the Author
     * (`phrase/locks.ts:unlockPhraseGroup`).
     */
    editor_group_locking?: boolean;
    /**
     * Phase ①'s P11 audit for samples that were truncated (documents/phase-1-research-pipeline.md
     * §3.6/§6.6). The selection commit hard-deletes the losing `revisions` rows and their
     * `sample_reviews` (P13/D-22 as the new pipeline asks), so this line — ids, issue counts and
     * the selected id, one entry per round — is the only surviving record of what competed.
     * Appended in the `choose_sample` commit, before the deletes.
     */
    sampling_history?: Array<{
        round: number;
        at: string;
        /**
         * HILL CLIMB, ADDED (additive): the SAMPLING WAVE these attempts belong to (D-34's arm/disarm
         * counter). Attempts, improvements and the no-progress streak are scoped to a wave, not to a
         * round — clearing the Author escalation and re-arming starts a fresh baseline, and this line is
         * what lets an audit tell a stalled wave from a wave that has not started yet.
         */
        wave?: number;
        /**
         * HILL CLIMB, ADDED: the wave's attempt count AT THE MOMENT this install happened — the same
         * number `records.ts:samplingProgressOf` derives from the ledger, so the escalation, the work
         * queue and this line can never disagree, and a restart recomputes it instead of re-buying
         * attempts that were already spent (requirement 9).
         */
        attempts?: number;
        /** HILL CLIMB, ADDED: how many times this wave measured a LOWER unresolved-fix count than before. */
        improvements?: number;
        /**
         * HILL CLIMB, ADDED: the attempt ceiling this wave was allowed — the Author's sampling size
         * (`samplingCapOf`) PLUS one per measured improvement (requirement 5). `attempts >= ceiling` is
         * what the work queue reads as "buy nothing more".
         */
        ceiling?: number;
        /**
         * HILL CLIMB, ADDED: the unresolved blocking count of the draft this install put in — THE BAR the
         * next candidate has to beat, since only a strictly lower count counts as an improvement
         * (requirement 2). 0 when the wave demanded no fixes at all.
         */
        unresolved_blocking?: number;
        samples: Array<{
            revision_id: string;
            critical: number;
            high: number;
            valid: boolean;
            /**
             * H1, ADDED (additive): the fix task ids this candidate did NOT clear — its blocking
             * screening issues plus the requested fixes a Critic marked `unresolved`/`unknown`/absent.
             *
             * WHY IT MUST SURVIVE THE COMMIT: the selection truncates every losing draft AND its
             * screening reviews (§6.6, P13/D-22), so without this line the reason a candidate was
             * rejected — the evidence, not a score — is deleted with it. A rejected candidate's
             * unresolved fixes are the audit of a hill that was not climbed (R4).
             */
            unresolved_fixes?: string[];
            /**
             * HILL CLIMB, ADDED (additive) — what became of this candidate in the round:
             *   `accepted` — it is the draft the commit installed (the line's `selected` id);
             *   `eligible` — it cleared every gate and ranked below the winner;
             *   `rejected` — it was never selectable, for the reason in `reject_reason`.
             *
             * This is the field that makes a REJECTED attempt auditable after the commit deleted the
             * draft and its screening rows. A rejected candidate closed no task, closed no finding and
             * did not advance the round, so this line — not the Revision row — is the only record that
             * the attempt happened at all.
             */
            outcome?: 'accepted' | 'eligible' | 'rejected';
            /**
             * HILL CLIMB, ADDED: why a `rejected` candidate was refused, in one clause the Author can
             * act on (e.g. `fix task_1 not certified`, `introduced 1 critical / 0 major`,
             * `ungradeable screening set`). Absent on an eligible/accepted line, which owed no reason.
             */
            reject_reason?: string;
            /**
             * HILL CLIMB, ADDED: the candidate's blocking issues SPLIT BY ORIGIN relative to the
             * accepted draft it replaces. `introduced_*` are defects this draft created — any of them
             * makes the candidate ineligible — and `inherited_*` are defects the accepted text already
             * had, which cost the candidate nothing on their own. An issue whose origin the Critic
             * did not state counts in `introduced_*` (fail closed).
             */
            introduced_critical?: number;
            introduced_high?: number;
            inherited_critical?: number;
            inherited_high?: number;
            /**
             * HILL CLIMB, ADDED: the minimality of this candidate against the accepted draft — how
             * many of the six §4.2 prose fields it changed, and the size of those changes in
             * characters. THE TIE-BREAK, not a quality score (P6): among candidates that cleared the
             * same certified work, the loop takes the smallest edit, and these two numbers are the
             * whole rule. Absent in a first round, where there is no accepted text to be minimal about.
             */
            changed_fields?: number;
            changed_characters?: number;
        }>;
        selected: string;
    }>;
    /**
     * G1 — the ACCEPTED-REVISION audit: one entry per accepted Summary revision whose DEEP REVIEW has
     * closed, oldest first (the counterpart of `sampling_history`, which records candidate attempts).
     *
     * WHY A SECOND LEDGER IS NEEDED: the sampling hill (`samplingProgressOf`) bounds CANDIDATE ATTEMPTS
     * inside one round, and F1's adversarial review proved it does not bound the loop BETWEEN rounds — a
     * candidate can certify the old fix and introduce nothing (so it is eligible and installs) while the
     * accepted revision's own deep review files a fresh blocking finding, forever, one accepted revision
     * at a time. Only the count of blocking findings a review actually raised can say whether revision
     * N+1 is better than revision N, and that number cannot be re-derived later: the selection closes
     * the findings its candidate certified (`fixed`) and truncates drafts, so this line is the record.
     *
     * THE NUMBER IS COUNTED, NEVER NAMED: `blocking_found` counts FINDING ROWS raised by that revision's
     * deep-review runs and judged blocking by the dial-aware Summary bar (`critical`/`major` always,
     * `minor` only when `auto_approve` covers it, `taste` never). It never reads a title or a
     * fingerprint, so a re-worded restatement of the same defect is not progress and one defect described
     * in ten ways is not ten regressions (`records.ts:revisionBlockingFindings`).
     */
    summary_review_history?: SummaryReviewHistoryEntry[];
}
/**
 * G1 — one row of `Story.summary_review_history` (§3.6, ADDITIVE).
 *
 * Written ONCE per accepted revision, by the sweep step that finds the revision's deep review closed
 * and its blocking suspicions decided (`engine.ts:trackRevisionProgress`), and keyed by `revision_id` so
 * a restarted loop cannot append the same audit twice. `wave` is the sampling wave the entry belongs to
 * (`stories.sampling_wave` at the moment it was recorded): the plateau policy counts a WAVE's entries,
 * which is what makes the Author's clear of the plateau escalation a fresh baseline rather than a
 * longer streak (`engine.ts:rearmSamplingWave`).
 */
export interface SummaryReviewHistoryEntry {
    /** The sampling round whose selection installed this revision (§6.6). */
    round: number;
    /** The sampling wave this revision was reviewed in — the plateau's partition key. */
    wave: number;
    /** The accepted `Revision` row this audit describes. */
    revision_id: string;
    at: string;
    /**
     * How many blocking findings this revision's deep review raised — THE BAR the next accepted revision
     * has to beat. The first entry of a wave is the baseline, not an improvement; only a STRICTLY lower
     * count is progress (`records.ts:revisionReviewProgressOf`).
     */
    blocking_found: number;
    /**
     * The finding rows behind `blocking_found`, so the audit names its evidence and a later Editor
     * downgrade or discard can be reconciled against what the loop actually counted at the time.
     */
    finding_refs?: string[];
}
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
    /** A RoleKind (`writer`/`editor`/`critic`/`reader`/`researcher`) naming who does the work. */
    owner_role?: string;
    state: TaskState;
    priority: number;
    criterion_ref?: string;
    finding_ref?: string;
    /** Attempts on this task — the thing that makes "no progress" visible (L-15). */
    attempts: number;
}
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
/**
 * §4.10 — a named claim with evidence and a fingerprint: a defect (`kind: 'issue'`, the default) or
 * a proposal to improve the text (`kind: 'proposal'`).
 *
 * D-33: from a Critic or reader it starts `unconfirmed` — a suspicion worth nothing until
 * an Editor confirms it. D-34: the Editor rewrites it into the Author's reading surface and
 * sets the cost it actually deserves (D-34a: that triage is final, no appeal). D-16:
 * `fingerprint` = stable hash of (criterion, target, kind, normalised subject); a repeat report
 * bumps `seen_count` instead of creating a new row, and that dedupe is what makes "no
 * progress" detectable in an amnesiac system (§6.7, L-16a). `issue` is the unmarked form of that
 * hash (see `kind` below), so a row raised before the field existed still dedupes against a new
 * `issue` report byte for byte.
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
    /**
     * T5 (additive) — what the row CLAIMS: `issue` (a defect) or `proposal` (an improvement).
     *
     * ABSENT ⇒ `'issue'`. That is both the legacy reading (a row raised before the field existed
     * claimed a defect) and the default of a new `raiseFinding` call that names no `kind`, and it is
     * the form `tools/utilities.ts:findingFingerprint` hashes, so a legacy row and a new `issue`
     * report with the same target/criterion/title still dedupe (D-16 back-compat is mandatory).
     *
     * WHY THE FIELD EXISTS: an Editor auto-`dispute`s a claim whose whole case is an absence, because
     * the Seed is a commitment and not an outline. That gate is right for a defect and wrong for a
     * proposal — a Critic that spots a change which would genuinely improve the book was having it
     * rejected for describing something the Seed never promised. Marking the row `proposal` tells
     * the Editor to weigh the change on merit (worth a Writer pass? does it break the installed text?)
     * instead of disputing it on absence grounds.
     *
     * THE TAXONOMY IS ENFORCED AT THE GATE, not left to the reporter (D-33b, both refusals in
     * `tools/reader.ts:raiseFinding`): a `proposal` may not cost `critical` (a suggestion is not a
     * contradiction the text cannot live with), and an `issue` may not cost `taste` ("this is merely a
     * preference" is the definition of a Proposal, and a taste-cost issue would sit on the Author's
     * queue claiming to be a defect). Neither rule applies to the Editor's own `verifyFinding` cost
     * rewrite — D-34a makes that triage final, so it may move a row to any rung it can justify.
     */
    kind?: FindingKind;
    fingerprint: string;
    state: FindingState;
    /** The Editor run that confirmed it (D-33), or empty. */
    confirmed_by?: string | null;
    /** The Author, or `auto` (D-35) — the gate that starts Writer work (D-34). */
    approved_by?: string | null;
    /**
     * Phase ①'s independent second look: a Critic re-checks an Editor-confirmed finding after the
     * approval and marks it valid. The Writer's fix pass waits for this flag in the Summary phase,
     * so an Editor approval alone does not spend a Writer round on a suspicion nobody confirmed.
     */
    critic_confirmed?: boolean;
    /** The Critic run that gave the independent confirmation, for P11's audit trail. */
    critic_confirmed_by?: string | null;
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
    /**
     * SUMMARY PHRASE R3 (additive) — the `phrase_groups` ids this defect is about: one, several, or
     * (for a defect that crosses the whole Overview) all five. A group id is a UUID, so
     * `related_refs` cannot carry it unambiguously alongside chapter/plotline refs and the deep
     * review names the groups here instead.
     *
     * WHY IT IS OPTIONAL: a finding raised before the redesign, or one raised against a
     * `'sampling'` Story, names none, and that reads as UNSCOPED — the legacy reading, where the
     * defect belongs to the Summary as a whole. `server/phrase/findings.ts:findingGroupRefs` is the
     * one place that interprets absence, and `server/phrase/findings.ts:findingIsResolvedBy` is the
     * one place that closes a finding: a multi-group finding goes `fixed` only when EVERY group it
     * names has a revision written to resolve it, so a partial fix stays open (R3).
     */
    group_refs?: string[];
}
/** §5.1 `checker` — mechanical (server-side, no model call, G-3) vs. LLM judgment. */

export type CriterionChecker = 'code' | 'judge';
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
/**
 * §4.12 `roles[]` — one role inside a crew definition (D-38).
 *
 * V-1: a role assigns an EMPLOYEE kind to a job; the thread that later executes it is the agent.
 * D-38: `agents: N` + `aggregate` make one role N fresh agents of that employee kind inside ONE
 * run that return a single answer — the panel lives inside the harness, so the Author's taste is
 * applied once per decision and no vote ever reaches the loop (D-34a survives).
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
 * §4.12 — a harness template: a crew definition, not an employee and not an agent (D-38).
 *
 * D-17c: `selection_rules` is the Editor's brief in the Author's own words — the mechanism
 * by which P12 becomes executable.
 * D-17d: `attempts` is how many parallel revisions one unit spawns; with no cost constraint
 * it defaults ABOVE one, because divergence is the whole advantage of fresh threads (E-4).
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
    /**
     * SUMMARY PHRASE R4 (additive) — the `phrase_groups` ids this run holds while it works, copied
     * off the Work Item (`WorkItem.groupRefs`) by `run/executor.ts` when the row is created.
     *
     * WHY IT LIVES ON THE RUN ROW AND NOT ONLY ON THE WORK ITEM: the Writer exclusion is enforced
     * from PERSISTED state (R4/L-5/L-3). A restart re-derives "which group is already being written"
     * from the live `runs` rows the sweep already sweeps for leases, so no in-memory semaphore has to
     * agree with the book, and a batch whose group set intersects a live writer set defers instead of
     * racing the compare-and-swap on the mirror.
     *
     * Absent means "this run holds no group" — every legacy run row, and every group-less job
     * (`structure_seed`, `research`, a tool-carrying deep review). `server/phrase/exclusion.ts` is the
     * only reader.
     */
    group_refs?: string[];
}
/** §4.14 / D-19: a line of Author direction the loop must PROPAGATE — tasks, needs_recheck, and a report of what changed. */
export interface Directive extends StoredRecord {
    story_id: string;
    text: string;
    state: DirectiveState;
    /** The plotlines/chapters/ledger entries the loop determined it must touch. */
    impact: string[];
}
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
    /**
     * Why this retained row reads `discarded`, in the words of whoever discarded it. Written
     * whenever a row moves to `discarded` and stays: the sidebar needs to say WHY a revision lost,
     * and `selection_note` belongs to the winner (T-2a), so it cannot carry the loser's reason.
     *
     * Sources, in order of honesty: the Editor's mandatory `why` (`rejectAll`, `selectRevision`),
     * the Author's optional selection note, and the journal `attribution.why` on a hard delete that
     * `viewRevisions` reconstructs. Absent on rows discarded before the field existed.
     */
    discard_reason?: string;
    /**
     * Phase ① sampling (documents/phase-1-research-pipeline.md §3.5): how the draft came into
     * existence. `sampled` is a round-1 one-turn Writer answer the engine persisted from the
     * validated structured output (D-12a's engine-writes exception); `refined` is every later
     * round, written from the current revision + the open fix tasks. Absent on rows written
     * before sampling existed and on deep-review revisions that go through `editSummary`.
     */
    origin?: 'sampled' | 'refined';
    /** 1-based sampling round this sample belongs to; round 1's winner is the First Revision. */
    round?: number;
    /**
     * Byte-stable hash of the compiled first prompt that produced it (§5's cache key and P11
     * audit). Every sample of one round shares it, which is how the Author proves the prefix
     * was identical.
     */
    prompt_hash?: string;
    /**
     * Screening totals, denormalised so the deterministic selector (§6.5: fewest critical, then
     * fewest high, then fewest total, then earliest) and the dashboard do not have to re-count
     * `sample_reviews` on every read. Written by the `choose_sample` commit.
     */
    issue_counts?: {
        critical: number;
        high: number;
    };
}
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
 * §4.17 — what Critics and the Author put forward before anything is written.
 *
 * Phase-scoped and temporary (D-36): locking a phase deletes that phase's Ideas — selected,
 * discarded and deferred alike. Within the phase a discarded Idea is NEVER deleted (D-28):
 * a discarded draft is a dead alternative while a discarded Idea is a decision, and the
 * decided list is the memory that stops the next amnesiac Critic re-proposing it (D-32).
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
    /** A Critic role name, or the Author (D-26). */
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
/**
 * `knowledge.importance` — the Researcher's triage scale, ordered most to least load-bearing.
 *
 * `critical`/`high` deliberately reuse the triage words of {@link FINDING_COSTS}, because the
 * prompt compiler's filter is one comparison against that vocabulary (§5: "only critical and
 * high entries enter the prompt"); `normal`/`low` stay readable through `readKnowledge` for the
 * deep-review Critic and never enter a sampling prefix.
 */

export type KnowledgeImportance = 'critical' | 'high' | 'normal' | 'low';
/** `knowledge.kind` — what class of fact an entry is, so a prompt can pick the ones it needs. */

export type KnowledgeKind = 'fact' | 'world_rule' | 'tech' | 'period' | 'place' | 'person' | 'other';
/**
 * One citation on a Knowledge entry. Same shape as {@link IdeaSource} because T-10's rule is
 * the same rule: a source backs ONE named claim (a page cited for a claim it does not make is
 * a defect, not "mostly right").
 */
export interface KnowledgeSource {
    url_or_title: string;
    claim: string;
    accessed_at: string;
}
/**
 * §3.2 — the Researcher's artifact: one durable fact the book depends on, with its importance
 * and its sources.
 *
 * D-16's dedupe pattern is reused verbatim: `fingerprint` is a stable hash of
 * (story_id, normalised topic, normalised claim), a repeat report bumps `seen_count` and
 * refreshes the sources instead of opening a second row. `phase` is absent when the entry
 * applies to the whole book (the Researcher is assigned ALL_PHASES for exactly that reason).
 */
export interface KnowledgeEntry extends StoredRecord {
    story_id: string;
    /** Phase the entry was gathered for. Absent = applies to the whole book. */
    phase?: StoryPhase;
    kind: KnowledgeKind;
    /** Normalised topic key — one entry per topic + claim (dedupe key part). */
    topic: string;
    claim: string;
    detail?: string;
    importance: KnowledgeImportance;
    sources: KnowledgeSource[];
    /** Stable hash of (story_id, topic, normalised claim) — repeats bump seen_count, D-16 pattern. */
    fingerprint: string;
    seen_count: number;
    /** The Researcher role name/run that last wrote it (P11 attribution). */
    author: string;
}
/**
 * `seed_briefs.status` — `draft` while the Editor is still structuring, `accepted` once the
 * brief matches the current Seed and every non-optional field is present. The pipeline refuses
 * to sample until an accepted brief exists (§6.4 gate 1).
 */

export type SeedBriefState = 'draft' | 'accepted';
/**
 * §3.3 — the Editor's structured projection of the Author's Seed.
 *
 * P5 is preserved by construction: this is a DERIVED record, never an edit of `stories.idea`
 * (which stays the C-14 reference). `seed_hash` is the hash of the Seed text the brief was
 * derived from (see `src/shared/seed-hash.ts`), so a Seed edit re-arms the structuring and a
 * stale brief can never be mistaken for a current one. One accepted brief per Story; a new
 * `seed_hash` writes a new row and supersedes the old one in the same commit.
 */
export interface SeedBrief extends StoredRecord {
    story_id: string;
    /** Hash of `stories.idea` this brief was derived from (see src/shared/seed-hash.ts). */
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
    /**
     * §3.3 / D-51 — the Editor's explicit research DECISION, made while structuring (R1a).
     *
     * Each entry is one concrete external fact the requested story depends on that cannot be
     * answered from the Author's Seed or from this brief; the Researcher's pass is scoped to that
     * list. An EMPTY list is a decision, not an oversight: research is WAIVED, no research Work
     * Item is generated, and sampling proceeds (D-51). It is never derived from the title, the
     * genre or the prose — only `structureSeed` writes it, and the Editor owns it.
     *
     * OPTIONAL ON PURPOSE (backward compatibility, D-51): a brief stored before the field existed
     * carries NO property, and the gate reads that as "research needed" — the pre-D-51 behaviour.
     * The tool always writes the property for a NEW brief (including `[]`), so absence is only
     * ever a legacy reading. `records.ts:researchGate` is the one predicate that interprets it.
     */
    research_questions?: string[];
    status: SeedBriefState;
    notes?: string;
}
/**
 * `plotline_briefs.status` — the same two-position lifecycle as {@link SeedBriefState}: `draft` while
 * the Editor is still structuring, `accepted` once the brief describes the phrase's CURRENT seed. The
 * acceptance is the moment the chapter entry set is materialized, so a `draft` brief has created no
 * `phrase_groups` rows yet.
 */

export type PlotlineBriefState = 'draft' | 'accepted';
/** One chapter's line in a {@link PlotlineBrief}: the order it will hold and the seed it grows from. */
export interface PlotlineBriefChapter {
    /** 1-based. It becomes the chapter group's `order` and its key's number (`chapter_<order>`). */
    order: number;
    /** The one-or-two-sentence seed for this chapter, as the Editor wrote it. */
    seed: string;
}
/**
 * `plotline_briefs` — §3.3's shape applied to a Phrase ② seed: the Editor's structured projection of
 * one phrase's copied seed, carrying the chapter count and the per-chapter seeds.
 *
 * ONE BRIEF PER (PHRASE, SEED): `seed_hash` is the hash of the PHRASE's `seed`, not of `stories.idea`
 * (see `src/shared/seed-hash.ts` and `Phrase.seed`), so editing Phrase ① re-hashes nothing here, and
 * re-starting Phrase ② on new text writes a new row instead of silently reusing a stale structure.
 *
 * `chapter_count` is mirrored onto `summaries.chapter_count` when the brief is accepted — the ONE
 * place the phrase pipeline writes that Author-truth number (D-3b says the WRITER may not choose it;
 * the Editor's structure pass, accepted by the Author, is what declares it here).
 */
export interface PlotlineBrief extends StoredRecord {
    story_id: string;
    /** The phrase this brief structures (`Phrase.id`) — a Phrase ② row, keyed `'plotlines'`. */
    phrase_id: string;
    /** Hash of `Phrase.seed` this brief was derived from, so a stale structure can never pass the gate. */
    seed_hash: string;
    /** The Editor's decision: how many chapters this phrase's seed resolves into. 1-based and exact. */
    chapter_count: number;
    /** The per-chapter seeds, in chapter order. Absent means "the count only" — materialize still runs. */
    chapters?: PlotlineBriefChapter[];
    status: PlotlineBriefState;
    /**
     * Descriptive notes about what a chapter contract could not settle from the seed — STORED, not a gate.
     *
     * This is NOT `SeedBrief.research_questions`' D-51 decision, despite the shared field name. There the
     * list decides whether the Research job exists at all (`loop/work.ts`'s research gate); here nothing in
     * the loop reads it — Phrase ② has no research leg of its own, because the Seed's pass already ran
     * (`tools/plotlines.ts:notesListArg`'s header states the same rule). `structurePlotlines` cleans it
     * (trim, drop blanks, first-seen dedup), omits the field when the list is empty — so an ABSENT field
     * means "none noted", never "waived" — and the only reader is that tool's own result payload, which
     * echoes it back. It reaches no prompt and no gate; `chapters` is the field the Writer's law block
     * actually quotes (`run/phase1-prompt.ts`'s ACCEPTED PLOTLINE BRIEF section).
     */
    research_questions?: string[];
    notes?: string;
}
/**
 * §3.4 — one screening Critic's `critical`/`high` complaint about ONE sample.
 *
 * This is NOT a {@link Finding}: it never enters the D-33/D-34 ladder, cannot block a Writer,
 * and exists only to rank the round's samples (§6.5) and to seed the deep review's brief.
 * `criterion` is free text on purpose — `'C-14'`, `'C-15'`, or `'seed'` for a Seed-contract
 * breach — because the screening schema closes `severity`, not the criterion vocabulary.
 */
export interface SampledIssue {
    /**
     * The screening Critic's two severities. THE WORDS ARE NOT THE FINDING'S WORDS: screening's
     * `critical` is a finding at cost `critical`, and screening's `high` is a finding at cost
     * `major` — the screening schema closes at two values (§4.3) while the finding ladder has four
     * (§4.10), and the mapping is one-to-one. Everything in the loop that says "blocking" means
     * exactly this pair (`sample-select.ts`, `records.ts:summaryBlockingFindings`).
     */
    severity: 'critical' | 'high';
    /** 'C-14', 'C-15', or 'seed' for a Seed-contract breach. */
    criterion: string;
    location: string;
    quote: string;
    detail: string;
    fix_hint?: string;
    /**
     * HILL CLIMB (accepted-revision rounds), ADDED — where this blocking issue came from, relative
     * to the ACCEPTED draft the candidate replaces (the `## SELECTED DRAFT` section the screen is
     * handed whenever the round carries fix tasks).
     *
     * WHY THE CANDIDATE HAS TO SAY: an accepted Revision N already carries defects the Author has
     * not targeted yet. If a candidate inherits one, the round must not read it as the draft
     * breaking something — a rewrite that carries the same known flaw is not a regression, and
     * rejecting it for that reason is the loop refusing every draft it can write. Symmetrically, a
     * flaw the ACCEPTED text did not have is a regression, and no number of certified fixes buys it
     * (`sample-select.ts:scoreSample` makes it ineligible).
     *
     * `inherited` therefore means "this is already in the text I was told to revise" — the Critic
     * saw it in the base — and `introduced` means "this draft created it". Absent or `unknown`
     * FAILS CLOSED as `introduced` in a round that has an accepted base: a screening pass that was
     * handed the base and did not classify the issue cannot claim the round is no worse than the
     * text it replaces. In a first round (no accepted base) the field means nothing, and nothing
     * reads it.
     */
    origin?: 'introduced' | 'inherited' | 'unknown';
    /**
     * SUMMARY PHRASE R3 (additive) — the `phrase_groups` ids this complaint is about, filled in by a
     * `review_groups` pass (the structured cross-group review of an INSTALLED group revision set).
     *
     * It is the screening answer's half of the group attribution: the persisted
     * `sample_reviews.issues` row keeps the group ids, so a later pass can tell "this group's review
     * still names the defect" from "no review names it", and a legacy screening row (a `'sampling'`
     * Story, or a pre-redesign row) simply carries none.
     */
    group_refs?: string[];
}
/**
 * H1 — one screening Critic's verdict on ONE requested fix, for ONE candidate draft.
 *
 * WHY THIS EXISTS AT ALL: before this row existed, an open `fix` task was closed because a
 * selection happened (`engine.ts:trySelectSample`'s §6.8 branch), not because anything proved the
 * defect was gone. Hill climbing needs the proof BEFORE the climb: the candidate that replaces the
 * selected Summary must be certified fix-by-fix, and a candidate that fails keeps the old fixes open.
 *
 * `fix_ref` is the OPEN FIX TASK id the screen was asked about (its `finding_ref` is the defect the
 * Author approved, D-34) — the task, because that is what the prompt numbers and what closure acts
 * on. `evidence` follows D-15's rule: a verdict with no citable line about the draft is not a
 * verdict, so an empty/absent evidence line is what makes `unknown` the honest answer.
 *
 * `status` is deliberately three-valued: `unknown` covers a Critic that could not tell (the draft
 * neither shows nor contradicts the fix). It is NOT a pass — `sample-select.ts:isEligibleSample`
 * treats anything but `resolved` as unresolved, because an unverifiable fix is a fix the round has
 * not earned yet.
 */
export interface SampledFixVerification {
    fix_ref: string;
    status: 'resolved' | 'unresolved' | 'unknown';
    /** Verbatim line(s) of the CANDIDATE draft that prove the reading (D-15). */
    evidence: string;
    note?: string;
}
/**
 * §3.4 — the screening Critic's one-turn answer, persisted by the engine from the run's
 * validated structured output (§2 decision 2 — the same named exception D-12a makes for the
 * Digest; the Critic never calls a tool in this mode).
 *
 * `valid: false` means the schema-repair retry still failed: the sample is judged anyway, with
 * an explicit error, so the selector can refuse to install an unjudged draft (§6.5).
 */
export interface SampleReview extends StoredRecord {
    story_id: string;
    revision_ref: string;
    /** Critic role name that produced it. */
    critic: string;
    issues: SampledIssue[];
    /** false = the one repair retry still failed schema validation. */
    valid: boolean;
    /**
     * H1, ADDED (additive: §4 allows adding fields, forbids renaming or dropping them): the fix
     * task ids this pass was ASKED to verify, captured when the screening job was queued.
     *
     * This is the anchor that makes the verification gradeable: a candidate is only ever judged
     * against the fixes its own prompt carried, so a fix task that opened after the round's screens
     * were dispatched cannot retroactively disqualify the round, and a Critic that skips a fix it
     * was handed counts against the candidate (silence is not a pass). A legacy row carries none,
     * which reads as "this pass graded issues only" — the round then falls back to the Story's
     * open fix list rather than trusting an empty set (`records.ts:sampleFixDemand`).
     */
    fix_refs?: string[];
    /**
     * H1, ADDED: the per-fix verdicts this pass returned. Absent on a legacy row, and `[]` on a
     * round-1 screen that was handed no fixes.
     */
    fix_verifications?: SampledFixVerification[];
}
/**
 * `group_revisions.state` — the two positions one group's revision line can hold.
 *
 * R2, stated exactly: revisions are created in order, one per accepted Writer result for that
 * group; the HIGHEST number is `latest` and is the text every read of "current" serves; installing
 * a new latest flips the previous one to `archived` IN THE SAME COMMIT, so an archived row is
 * retained history (reconstructible, P11/D-12a) but is hidden from the latest view (the projection
 * lists it separately, never in place of the current text). Nothing deletes a group revision: the
 * whole point of the redesign is that a superseded group text is history, not a loser to truncate.
 *
 * D-68 (the Reviewed Summary) adds a THIRD, terminal position: `discarded`. When the Author chooses
 * the reviewed Overview, every revision that is NOT part of that choice becomes `discarded` — the row
 * PERSISTS (P11/D-12a: it is still the history, and R3's closure join still reads it, so a `fixed`
 * finding stays fixed), but no read of "current", no selection, and no Author rail lists it. It is
 * terminal in one direction only: nothing installs over a discarded row, and nothing un-discards one;
 * the group's own line keeps running, so the chosen text is a NEW `latest` at the group's next number
 * and the numbers of the discarded rows are never reused or renumbered.
 *
 * Order of the array is the lifecycle order (archived → latest → discarded), matching the enum style
 * at the top of this file; the numbers are derived per group, never globally.
 */

export type GroupRevisionState = 'archived' | 'latest' | 'discarded';
/**
 * `phrases` — one Story's phrase: the thing the Author reads as a whole, composed from its groups.
 *
 * Which phrase KINDS exist is catalog data ({@link PHRASE_CATALOG} in `shared/phrase.ts`), not code
 * shape: an entry carries `enabled` (is the kind known at all) and `starts_on_demand` (is its row
 * created with the Story, or by an explicit start step). Today that means the Summary Phrase row is
 * created at story creation and the Plotlines Phrase row is created only when the Author starts
 * Phrase ②, so a Story has one or two of these rows and neither is invented by code (R1). The row
 * carries the catalog's `title`/`description` AS WRITTEN AT CREATION TIME: the catalog is the source,
 * but a Story's rows are the record of what that Story's phrase was called, so a later catalog edit
 * cannot rewrite history (D-12a) and an import can be audited.
 *
 * `content` is the GENERATED composition of the latest revision of each group, in catalog order —
 * the Overview the deep review reads and the Author's dashboard renders. It is derived, never
 * authored, and it is rewritten in the same commit as the group revision that caused it.
 */
export interface Phrase extends StoredRecord {
    story_id: string;
    /**
     * The catalog kind — `'summary'` ({@link PHRASE_SUMMARY_KEY}) or `'plotlines'`
     * ({@link PHRASE_PLOTLINES_KEY}). An unknown key means a row whose kind has been retired from the
     * catalog: its history still renders, and nothing may delete it to match the code (D-12a).
     */
    key: string;
    title: string;
    description: string;
    /** Generated: the latest text of every group, composed in catalog order. Never hand-written. */
    content: string;
    /** Catalog order. Only one phrase exists today, so this is its definition's `order`. */
    order: number;
    /**
     * The number of group revisions this phrase has had installed — 0 until the first group draft
     * lands. It is bumped in the install commit (once per install, not once per group), so it is the
     * phrase-level "how many times has the Overview changed" counter the projection shows beside the
     * per-group numbers.
     */
    revision: number;
    /** The group ids in catalog order — the ordered key list the projection and the review brief read. */
    group_refs: string[];
    /**
     * PHRASE ② (additive) — the SEED THIS PHRASE was written from, copied in at its start.
     *
     * WHY A PHRASE CARRIES ITS OWN SEED (the user's "phrases are discrete and independent"): Phrase ①
     * and Phrase ② are separate pipelines over SEPARATE copies of the input. When the Summary is
     * compiled and pushed into the Plotlines phrase, that compiled text BECOMES the plotlines phrase's
     * seed; a later edit or deletion of Phrase ① must not reach into Phrase ②'s history, and it cannot,
     * because Phrase ② never reads `stories.idea` or Phrase ①'s rows — it reads this field. A phrase
     * whose every gate hashes this text instead of the Story's Seed therefore stays stable across
     * changes to everything above it.
     *
     * THE SUMMARY PHRASE's copy is `stories.idea` AT CREATION TIME, so for Phrase ① the content is
     * identical to what every existing gate already hashes and behavior is unchanged.
     *
     * ABSENT means "this row predates the field" and reads as `stories.idea` —
     * `server/phrase/catalog.ts:phraseSeedOf` is the ONE read that interprets it, so no gate has to
     * decide the fallback for itself.
     */
    seed?: string;
    /**
     * R12 (additive) — WHERE that copied Seed came from: `'custom'` (the Author typed or pasted it in the
     * Start request) or `'compiled'` (this Story's compiled Summary, whether the Author pressed the handoff
     * button or the Summary Accept started the phrase on their behalf).
     *
     * WHY THE PROVENANCE IS A ROW FIELD AND NOT A DERIVED READ. The whole product model is that these two
     * origins are DIFFERENT JOBS for the Editor: a Seed that came from the Author directly is text nobody
     * has proofread, so it gets the one-time cleanup (`server/run/seed-cleanup.ts`) and the Author's
     * confirm; a Seed compiled out of Phrase ① was written and reviewed by the crew, so a cleanup pass on
     * it is a model call buying nothing. That question has to be answerable AFTER the start — the desk, the
     * rail and any later wave ask it of a phrase that already exists — and nothing in the book answers it:
     * `seed` is just text, and the two arms can copy the same bytes. So the fact is recorded once, in the
     * start commit, beside the text it describes.
     *
     * ABSENT MEANS LEGACY, and it is a DIFFERENT ANSWER from either word — not a stand-in for one. A row
     * written before this field existed has a Seed whose origin nobody recorded, and no later read can
     * recover it: a `custom` Seed and a `compiled` one are byte-indistinguishable once copied (the R6
     * no-migration rule, the same shape `seed` itself and the Story's `summary_mode`/`plotlines_mode`
     * switches use — an absent field is the older book, never a defaulted new one). `api/projections.ts`
     * therefore OMITS `seed_source` from the phrase read rather than guessing `compiled` for an old row, and
     * the desk says the provenance is unknown instead of naming an arm it cannot support.
     *
     * NOT THE CATALOG'S `seed_source`: `shared/phrase.ts:PhraseDefinition.seed_source` is a definition field
     * (`'supplied'` | `'story_idea'`, what text a phrase kind is CREATED with) and is resolved at creation
     * by `phrase/catalog.ts:phraseSeedInitOf`. This one is a per-row record of the arm an Author actually
     * pressed, and its vocabulary is the Start verb's (`StartPhraseRequest.source`).
     */
    seed_source?: 'custom' | 'compiled';
    /**
     * D-68 (additive) — the Reviewed Summary the AUTHOR chose, as the group revision vector it was
     * made of (`{groupId: revisionNumber}`).
     *
     * This is a DECISION record, not a derived read: `phrase/reviewed.ts:cleanSelectionOf` answers
     * "which clean revision would the reviewed Overview be built from RIGHT NOW", and that answer moves
     * whenever a new pass or a new install moves it. The Author's choose is a moment with a consequence
     * (the texts become the live Overview and everything else is discarded), so the vector it was made
     * from is persisted here, in the same commit as the install the choice performs.
     *
     * ABSENT (or `{}`) means the Author has never chosen. A persisted vector whose rows no longer exist
     * — a Seed reset or a scrap deleted the history (`loop/invalidation.ts:scrapPhasesAfter`) — is read
     * as no choice, because `chosenSelectionOf` requires each named row to still carry its Clean stamp.
     */
    reviewed_vector?: Record<string, number>;
    /**
     * D-68 — `groupVectorHash(reviewed_vector)`: the join key of the choice. The Reader's
     * `summary_scores` rows carry the same hash (§4.19, D-65), so the rail can show the score that was
     * judged against the text the Author actually picked, rather than the newest score of a newer text.
     */
    reviewed_vector_hash?: string;
    /** D-68 — when the Author chose (the choose commit's own stamp; empty/absent = never chosen). */
    reviewed_at?: string;
}
/**
 * `phrase_groups` — one writable part of a phrase, holding its CURRENT text.
 *
 * The id is a persisted UUID (R1) rather than a `${singular}_${n}` row id, because the id is the
 * group's ADDRESS: `POST /stories/:id/phrases/groups/{groupId}/revise`, a finding's `group_refs`,
 * a run row's `group_refs` and a revision row's `group_id` all name it, and an address that is
 * stable across a restart is what makes the R4 exclusion and the R3 closure provable from the book.
 * `store.ts:createWithId` is the write that preserves it; `persist.ts:newRecordUid()` mints it.
 *
 * `key` is the catalog key ({@link PHRASE_GROUP_KEYS}) and also the legacy `summaries` field this
 * group mirrors — the identity is deliberate ({@link SUMMARY_MIRROR_FIELDS}), because the five keys
 * ARE the five Summary prose fields §4.2 already defines. `content`/`revision` are the latest
 * revision's text and number: denormalised on purpose, so "what is the current premise" is one row
 * read rather than a sort, and both are rewritten in the same commit as the revision row that made
 * them, so they cannot drift.
 *
 * There is deliberately NO `state` here: the latest/archived distinction belongs to the revision
 * row (the single source), and a second copy on the group row is a field that can disagree with it.
 */
export interface PhraseGroup extends StoredRecord {
    story_id: string;
    /** The phrase this group belongs to (its `Phrase.id`). */
    phrase_id: string;
    /**
     * The group's key WITHIN ITS PHRASE — the key namespace is PER-PHRASE (seam S1):
     * `premise` … `ending` on the Summary Phrase ({@link PHRASE_GROUP_KEYS}, which are also the legacy
     * `summaries` fields this group mirrors — the identity is deliberate, see
     * {@link SUMMARY_MIRROR_FIELDS}), and `chapter_1` … `chapter_N` on the Plotlines Phrase
     * ({@link PHRASE_CHAPTER_KEY_PREFIX}, one entry per chapter, N decided by the Plotline Brief).
     * `server/phrase/catalog.ts` and `shared/phrase.ts` therefore never ask "is this a valid key?" in
     * the abstract; they ask it of a phrase key ({@link isPhraseGroupKeyOf}).
     */
    key: string;
    title: string;
    description: string;
    /** Composition order WITHIN THE PHRASE (1-based): the Summary's definition order, or the chapter number. */
    order: number;
    /** The LATEST revision's text. `''` means the group has never been written. */
    content: string;
    /** The LATEST revision's number, 0 = never written (R2 — the first install makes this 1). */
    revision: number;
    /** The run that installed the current text (P11), or null while the group is unwritten. */
    updated_by?: string | null;
    /**
     * PHRASE GROUP LOCK (additive) — this group's CURRENT text is signed off and may not be rewritten.
     *
     * While `locked === true`: no install may write the group (`revisions.ts:installGroupRevisions`
     * refuses, so a stale Writer result cannot land through a lock), a finding's claim against it is
     * VOID — void means void, not owed: the row is discarded at lock time when every group it names is
     * locked, and a claim that also names an unlocked group stops counting against the locked one
     * (`findings.ts:findingActionableScope`) — and the other groups are the side that gets revised for
     * consistency. The lock does not change the text and does not invent a revision: it is a flag on the
     * row that already carries it.
     *
     * ABSENT or `false` means unlocked, so a book written before this field exists needs no migration.
     * The lock is set by a domain operation (`phrase/locks.ts:lockPhraseGroup`) reached from the
     * Author's route, or by the Editor when the Story enables it (`Story.editor_group_locking`); only
     * the Author may lift it (`phrase/locks.ts:unlockPhraseGroup`).
     */
    locked?: boolean;
    /**
     * The revision number the CURRENT lock fixed — the group's `revision` at the moment of locking, so
     * an audit can tell a lock from a later text that happens to carry the flag. `null` once unlocked
     * (an `update` patch cannot delete a key — `store.ts` merges through JSON — so clearing means
     * writing `null`), and `undefined` on a row that has never been locked.
     */
    locked_revision?: number | null;
    /** Who set the current lock: the Author, or the Editor on a Story that enables it. `null` = unlocked. */
    locked_by?: PhraseGroupLockActor | null;
    /** When the current lock was set (the lock commit's own stamp). `null`/absent = no live lock. */
    locked_at?: string | null;
}
/**
 * Who may put a phrase group into the locked state ({@link PhraseGroup.locked}).
 *
 * The Author owns the lock outright. The Editor may only lock on a Story that switches
 * {@link Story.editor_group_locking} on, and it may never UNLOCK — lifting a lock is the Author's
 * decision, whichever hand set it, so an Editor judgment cannot sign the book back out on its own.
 */

export type PhraseGroupLockActor = 'author' | 'editor';
/**
 * `group_revisions` — one superseded-or-current text of ONE group (R2's history).
 *
 * One row per accepted Writer result for that group, numbered from 1 within the group. The row is
 * the redesign's replacement for the whole-Summary draft set: there is no competing round and no
 * selection to lose, because the accepted result IS installed (R5) and what it replaced is kept
 * here as an `archived` row. `content` is the group's text verbatim — the Writer's answer, not a
 * body shape to interpret.
 *
 * R3 rides on `task_refs`/`finding_refs`: they say which approved work this revision was WRITTEN to
 * resolve. A resolving revision is decided from those ids rather than from timestamps, so a restart
 * re-derives the same closure from the journal instead of re-reading a clock, and a multi-group
 * finding can be proved open or closed group by group.
 */
export interface GroupRevision extends StoredRecord {
    story_id: string;
    phrase_id: string;
    /** The group this revision belongs to (its `PhraseGroup.id`, a UUID). */
    group_id: string;
    /** Denormalised catalog key, so history stays readable after a catalog title/description edit. */
    group_key: string;
    /** 1-based, sequential WITHIN the group (R2). `number` is what the Author's rail labels. */
    number: number;
    /** The group's text, verbatim, as the Writer answered it. */
    content: string;
    /**
     * {@link GROUP_REVISION_STATES}: exactly one `latest` per group; every earlier one `archived`,
     * and every row the Author's Reviewed-Summary choice (D-68) passed over `discarded` — retained,
     * never selected, never shown as current.
     */
    state: GroupRevisionState;
    /** The run that produced it (P11), or null when a legacy import seeded it. */
    run_ref?: string | null;
    /** The Work Item that asked for it, so the ledger can attribute an install to a job. */
    work_item_ref?: string;
    /**
     * R3 — the open `fix` task ids this revision was written to answer (from
     * `WorkItem.taskRefs`/`fixRefs`, frozen at dispatch so a late task cannot claim an old revision).
     */
    task_refs?: string[];
    /** R3 — the finding ids those tasks named: the closure anchor a multi-group finding is judged on. */
    finding_refs?: string[];
    /** Knowledge fingerprints the draft leaned on, for the audit and the next prompt. */
    knowledge_used?: string[];
    /** Byte-stable prompt hash (the compiler's 16-char sha256 prefix) — §5's cache key, P11. */
    prompt_hash?: string;
    /**
     * D-67 (additive) — the Clean stamp: THIS text was the group's text in a cross-group Critic pass
     * that closed with no unresolved defect on it.
     *
     * Written ONLY as `true`, by `phrase/reviewed.ts:stampCleanRevisions`, in the same settle commit
     * that closes the deep-review run that earned it; a revision nobody stamped simply has no field
     * (absent = "never earned a clean pass"), which is what keeps a pre-D-67 book honest: none of its
     * rows claims a judgement it never had.
     *
     * WHY A STAMP RATHER THAN A RE-DERIVATION: the clean verdict is a fact about a PASS, not about the
     * text — "this Critic read this combination and found nothing on this group" — and the finding that
     * pass filed can be discarded a week later. D-67 keeps the verdict permanent and puts the
     * revocation in the SELECTION read instead (`cleanSelectionOf` re-checks the open-issue set on
     * every read), so a late finding invalidates a selection naturally while a revision whose own pass
     * found a defect never becomes selectable again, even after that defect is discarded.
     */
    clean?: boolean;
    /** D-67 — the deep-review RUN whose clean pass stamped this row (P11's audit of the verdict). */
    clean_run_ref?: string;
}
/**
 * `summary_scores` — one section's score from one Reader run over one installed Overview.
 *
 * `vector_hash` is the group revision vector the score was judged against; `run_ref` and
 * `work_item_ref` say which job produced it, so the Author can open the thread behind a number.
 * `rationale` and `evidence` are required by the answer contract (D-15: a number with no quoted
 * line is not a judgement) and travel to the rail lazily — the row's `score` is what renders.
 */
export interface SummaryScore extends StoredRecord {
    story_id: string;
    /** The phrase these rows score (`Phrase.id`) — the Overview as one artifact. */
    phrase_id: string;
    /** The group revision vector this score was judged against (re-arm key, D-65). */
    vector_hash: string;
    /** The group this row scores (its `PhraseGroup.id`, a UUID — the same address R3 routes by). */
    group_id: string;
    /** Denormalised catalog key (`premise` … `ending`), so the rail labels a row without a join. */
    group_key: string;
    /** 0–100, enforced at parse time (`phrase/section-scores.ts`), never recomputed here. */
    score: number;
    /** The Reader's one-line reason for the number. */
    rationale: string;
    /** The quoted line the judgement rests on (D-15). */
    evidence: string;
    /** The run that answered (P11). */
    run_ref: string;
    /** The Work Item that asked (`wi_summary_score_<hash>`). */
    work_item_ref: string;
}
/**
 * The 20 §4 collection names plus the five this redesign appends, in §4 order.
 * Exported as data so the store, the persistence
 * layer and the dashboard can enumerate the model without hardcoding the list in three
 * places (P15: adding a collection must touch one file).
 *
 * The last three are the Phase-1 research pipeline's (§3.2-§3.4): `knowledge`, `seed_briefs`,
 * `sample_reviews`. They are APPENDED, never inserted, because the original 17 are pinned §4
 * names and their relative order is what old snapshots were written in. New collections are
 * additive: every snapshot reader walks this registry, so an old `store.json` loads with the
 * new collections empty (§11.1).
 */

export type CollectionName = 'stories' | 'summaries' | 'plotlines' | 'chapters' | 'cast' | 'ledger' | 'tasks' | 'digests' | 'verdicts' | 'findings' | 'goals' | 'templates' | 'runs' | 'directives' | 'revisions' | 'ideas' | 'proposals' | 'knowledge' | 'seed_briefs' | 'sample_reviews' | 'phrases' | 'phrase_groups' | 'group_revisions' | 'summary_scores' | 'plotline_briefs';
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
    knowledge: KnowledgeEntry;
    seed_briefs: SeedBrief;
    sample_reviews: SampleReview;
    phrases: Phrase;
    phrase_groups: PhraseGroup;
    group_revisions: GroupRevision;
    summary_scores: SummaryScore;
    plotline_briefs: PlotlineBrief;
}
/** Any §4 record — the type the journal, the audit trail and generic tool plumbing need. */
export type AnyRecord = CollectionRecords[CollectionName];
/**
 * `collection -> id singular`, used for the store's `${singular}_${n}` ids (W1). Two
 * collections need a real singular rather than a de-pluralised name (`cast` → a character
 * row, `ledger` → one entry), which is exactly why the map is explicit.
 */

/**
 * The collections whose ids are ADDRESSES their owner mints — `persist.ts:newRecordUid` creating,
 * `store.ts:createWithId` preserving — rather than `${singular}_${n}` labels this registry mints.
 *
 * WHY THIS IS A CONSTANT AND NOT A COMMENT. `store.ts:_resolveId` recognises a record's family by
 * id PREFIX, so the registry has to stay unambiguous (`types.test.ts`'s singular rule). R1 adds
 * `phrases`/`phrase_groups`, whose singulars are `phrase` and `phrase_group` — a strict prefix pair
 * that would read as that bug if it were left implicit. It is not a bug, and the reason is exactly
 * what this list states:
 *
 *   * those two collections never mint a counter id in production, so nothing in them can be shaped
 *     like `phrase_3` or `phrase_group_3`, and the two families cannot claim the same id shape; and
 *   * `group_revisions` is NOT in this list: its rows are addressed by (group id, number), and an
 *     Author reading history wants `group_revision_3`, so it takes the counter like every other
 *     collection — which is why the rule below is about COUNTER families only.
 *
 * A prefix collision is still possible in one situation, and the store answers it correctly: a row
 * hand-created by `Collection.create` (which mints a counter id whatever the family) or an id quoted
 * after its row was deleted. `_resolveId` returns the record when a family has it, and when none does
 * it reports the MOST SPECIFIC family it recognised — the registry order puts `phrase_groups` after
 * `phrases`, and `_resolveId` keeps the last prefix match. `store/record-identity.test.ts` pins both
 * halves, so this contract is a behaviour and not an intention.
 */

/** One of {@link UID_ADDRESSED_COLLECTIONS}. */
export type UidAddressedCollection = 'phrases' | 'phrase_groups';

/** One grouping key: the three phase boundaries plus the whole-Story pass, and C-12 outside them. */
export type CriterionLevel = 'summary' | 'plotlines' | 'chapters' | 'whole';
