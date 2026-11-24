// story-contract.ts — the Story-view contract the story panels render (W10, W11, W11b, W13) plus
// every PURE derivation they share.
//
// WHY THE VIEW TYPE IS RE-EXPORTED FROM `../api` RATHER THAN REDECLARED HERE: `api.ts` (T8) owns
// the wire format — `getStory(id)`'s payload, the Goal surface, the cost distribution, the
// completion preview — and it is the pinned contract's realization. Redeclaring it here would put
// two sources of truth in one build (P3's rule applied to the UI). `StoryViewData` is an alias for
// their `StoryView`; the name differs only because `StoryView` is the component's name in
// `./StoryView.tsx`.
//
// WHY `StoryActions` MIRRORS `state.ts`'s STORE METHODS EXACTLY: the shell hands each region the
// store (`useDashboardStore()`), so a store object must be assignable to `StoryActions` with no
// adapter. Every signature below is T8's, in T8's argument order. Methods are OPTIONAL so a
// control whose verb has no route renders disabled and states the gap on the spot (U-16's
// discipline) instead of inventing an endpoint. The one deliberate extension is `selectRevision`
// (D-24's Author override), which the pinned client does not have — see the note on it.
//
// WHY THE DERIVATIONS ARE PURE FUNCTIONS IN A `.ts` MODULE: each is a spec rule (L-32's delete
// sentence, L-7a's lock gate, decision 0/5's grouping, L-25b's discard sentence), and a rule that
// is a function of the view can be pinned without a DOM. The panels stay declarative.
import type {
    BacktrackPhase,
    CompletionPreview,
    CostDistribution,
    FailingCriterion,
    PhraseFindingRow,
    PhraseGroupRow,
    PhraseRevisionRow,
    PhraseReviewState,
    PhraseTaskRow,
    PhraseView,
    StoryView,
    UndoTarget
} from '../api';
import type {
    Cost,
    Criterion,
    Chapter,
    Idea,
    Finding,
    FindingState,
    IdeaState,
    PendingKind,
    Proposal,
    Revision,
    Run,
    Story,
    StoryPhase,
    StoryStatus,
    Template,
    TemplateRole,
    Verdict
} from '../../shared/types';
// Phase ①'s Readers-per-sample default. It is a SHARED constant (`shared/types.ts`, the same value
// `records.ts:screeningSizeOf` falls back to), so the dashboard's owed-review readout counts the
// passes the loop actually dispatches rather than a number this file invented.
import { DEFAULT_SUMMARY_READERS } from '../../shared/types';

export type { CompletionPreview, CostDistribution, FailingCriterion };
// R6 — the group rows the Summary rail and its panes render. Aliased here (rather than imported at every
// call site) so the panels keep reading ONE module for their view contract, and so the shapes the panes
// assert are the shapes `../api` pins to the wire.
export type { PhraseFindingRow, PhraseGroupRow, PhraseReviewState, PhraseView };

/**
 * The pinned `getStory(id)` payload (U-4…U-17) with TWO widenings: `templates` carries the
 * RESOLVED records rather than the assigned id list, and `phrase` carries the SUMMARY PHRASE read
 * (`GET /stories/:id/phrases`, R6) the shell merges in beside it.
 *
 * WHY: the pinned wire carries ids (D-17b — assignment is a list of ids), but every panel that
 * draws a template needs the RECORD (U-8d needs `roles[].agents`/`aggregate`, U-8b needs
 * `selection_rules`, U-8c needs `attempts`). The shell resolves the ids against
 * `GET /templates` before rendering (`assignedTemplates`/`storyViewData` in `../shell-binding.ts`,
 * whose `ShellStoryView` is structurally this type), so no panel has to reach for the catalogue
 * itself and no panel invents a second read.
 *
 * `phrase` is OPTIONAL because it is a SECOND read on its own route: absent means the caller has no
 * group surface for this Story (a legacy fixture, or the read has not landed), and the Summary panes
 * render that as their loading/unavailable state. It is never inferred from `view.summary` — a
 * group-managed book's legacy mirror is a compatibility copy, not the rail's source (R6).
 *
 * `phraseError` is R-T2/F2's half of that story: the store caches the FAILED phrase read per Story
 * (`state.ts:phraseErrors`), so a frame can tell "still in flight" (absent, no error) from "the route
 * answered 503" (absent, with the server's own sentence). Without it a failed read looks like a slow one
 * forever: the panes would say `reading the Summary groups…` over a book whose groups will not arrive
 * until the Author reloads. The Story payload stays current either way — the failure is the phrase read's,
 * not the Story's, so only the Summary area changes what it says.
 */
export type StoryViewData = Omit<StoryView, 'templates'> & {
    templates: Template[];
    phrase?: PhraseView | null;
    phraseError?: string | null;
};

/**
 * G-2's failing line, verbatim from the server (`criterion` + `fix_hint` + `evidence`). It is
 * aliased rather than reshaped because G-2 forbids the UI doing arithmetic or rewording: the
 * Goal panel prints what the server named, and a re-shaped row is where a percentage creeps in.
 */
export type GoalFailingLine = FailingCriterion;

/** The catalogue: `listTemplates()`'s rows, i.e. the Template records behind the assigned refs. */
export type TemplateCatalogue = Template[];

/** §6.3a — the two backtrack targets T8's route accepts (phase ③ is where the Story already is). */
export type BacktrackTarget = BacktrackPhase;

/** G-1 — one edit to the Goal, in T8's op shape (`PATCH /stories/:id/goal`). */
export type GoalPatch = { threshold_soft?: number; criteria: GoalCriterionOp[] };
export type GoalCriterionOp = { op: 'add' | 'remove' | 'setHard'; id?: string; criterion?: Criterion; hard?: boolean };

/** §8.6 — the assistant run U-4's "Ask assistant" affordance invokes: one artifact, one run. */
export type AssistantRequest = { target: 'summary' | 'directive'; text: string };

/**
 * D-24 / §8.1 — the §4.4 span an Undo rewinds (T8's `UndoTarget`).
 */
export type { UndoTarget };

/**
 * The status line's words. The machine's `pending_kind` enum is a contract field, not product
 * copy: the Author reads "needs your approval", not "finding_approval".
 */
export function storyStatusLabel(status: StoryStatus, pendingKind: PendingKind): string {
    if (status === 'pending') {
        switch (pendingKind) {
            case 'phase_signoff':
                return 'needs your signature';
            case 'idea_selection':
                return 'needs your pick';
            case 'finding_approval':
                return 'needs your approval';
            case 'drained':
                return 'leftovers need you';
            case 'stalled':
                return 'stuck';
            default:
                return 'pending';
        }
    }

    return status === 'completed' ? 'done' : status;
}

/**
 * P11 / U-5 — resolving the span a proposal or an edit points at into the pair the route needs.
 *
 * `Proposal.target_ref` is addressable at two granularities (D-7): a section id, or the chapter
 * when the patch covers the whole chapter. So the section ids of THIS chapter are tried first —
 * the honest reading — and only then the `chapter:section` spelling some writers use. A ref that
 * names neither becomes an empty `section_id`, which is the whole-chapter case: the server rewinds
 * the chapter's current section list rather than one paragraph.
 */
export function undoTargetFor(chapter: Chapter, targetRef: string): UndoTarget {
    const [prefix, suffix] = targetRef.split(/[:/#]/);
    if (suffix) {
        return { chapter_id: prefix ?? chapter.id, section_id: suffix };
    }
    if (chapter.sections.some((section) => section.id === targetRef)) {
        return { chapter_id: chapter.id, section_id: targetRef };
    }
    return { chapter_id: targetRef, section_id: '' };
}

// ---------------------------------------------------------------------------
// The actions the panels call (the pinned client surface, subset)
// ---------------------------------------------------------------------------

/**
 * Every member is one route in T8's `ApiClient` (mirrored by the store in `state.ts`), declared
 * optional so an unlanded verb disables its control rather than faking a route.
 *
 * Gaps found against the pinned contract, both reported rather than papered over:
 *   - `selectRevision` (D-24 — "the Author may always override an Editor") used to be the first of
 *     these: no route, so RevisionsCompare rendered the comparison with its Select disabled. U-13
 *     landed `POST /stories/:id/revisions/:revisionId/select`, so the control works and the shell
 *     binds it (see `shell-binding.ts`).
 *   - an Author write to the SUMMARY has no route either. The UI's channel is the pane-aware
 *     directive bar (D-19); `requestAssistant` stays on the client surface for the server's §8.6
 *     route, but no pane offers an "Ask assistant" control.
 */
export interface StoryActions {
    /** P8 / D-37 — halt dispatch and kill in-flight runs. Also the Author's Pause & edit. */
    stop?: (storyId: string) => Promise<unknown> | unknown;
    /** D-37a — re-arm to `ready`; the Author's edit is processed as a commit (Digest re-derived). */
    resume?: (storyId: string) => Promise<unknown> | unknown;
    /** U-16 — locks the CURRENT phase; the server 409s naming the Ideas tray when it is non-empty (L-7a). */
    lockPhase?: (storyId: string) => Promise<unknown> | unknown;
    /** Phase ① — "not final yet": queue another three-draft Summary round from the selected revision. */
    requestSummaryRevision?: (storyId: string, note?: string) => Promise<unknown> | unknown;
    /**
     * R2 — the Author rewrites ONE SUMMARY GROUP by hand. This is the ONLY Author prose write the group
     * rail offers, and the group is addressed by its UUID (the rail's selection ref), never by key or
     * index. `writer_busy` 409s — the pane disables the control off the same projected flag.
     */
    revisePhraseGroup?: (
        storyId: string,
        groupId: string,
        input: { content: string; note?: string }
    ) => Promise<unknown> | unknown;
    /** L-31/L-32 — the only way a lock opens; deletes every later phase's artifacts. */
    backtrack?: (storyId: string, phase: BacktrackTarget) => Promise<unknown> | unknown;
    /** D-37 / D-20a — a direct Author write, refused while the Story runs (naming D-37). */
    editSection?: (
        storyId: string,
        chapterId: string,
        sectionId: string,
        content: string
    ) => Promise<unknown> | unknown;
    /** §14 item 11 — keep a chapter's prose, reopen its review. Not a backtrack. */
    unapproveChapter?: (storyId: string, chapterId: string) => Promise<unknown> | unknown;
    /**
     * U-10b — "approve a whole chapter's worth". The server approves every `confirmed` finding aimed
     * at this chapter (by `target_ref` OR L-11a `related_refs`) as one commit each, so the audit still
     * shows every decision (D-34). `why` is required — a bulk approval with no reason is the least
     * auditable write in the book (D-8).
     */
    approveChapterFindings?: (storyId: string, chapterId: string, why: string) => Promise<unknown> | unknown;
    /** U-5 / D-20. */
    acceptProposal?: (storyId: string, proposalId: string) => Promise<unknown> | unknown;
    rejectProposal?: (storyId: string, proposalId: string) => Promise<unknown> | unknown;
    /** P11 / U-5 — rewind one §4.4 span. */
    undo?: (storyId: string, target: UndoTarget) => Promise<unknown> | unknown;
    /** U-15 / D-29 — the selection is a recorded decision, hence the note argument. */
    selectIdea?: (storyId: string, ideaId: string, note: string) => Promise<unknown> | unknown;
    discardIdea?: (storyId: string, ideaId: string) => Promise<unknown> | unknown;
    deferIdea?: (storyId: string, ideaId: string) => Promise<unknown> | unknown;
    /** U-14 / L-25, L-26 — the acceptance is what closes the leftovers (L-25b). */
    acceptCompletion?: (storyId: string) => Promise<unknown> | unknown;
    /** G-1 — threshold plus criterion ops, applied in order. */
    patchGoal?: (storyId: string, patch: GoalPatch) => Promise<unknown> | unknown;
    /** G-1 / §14 item 2 — the per-chapter bar. */
    setChapterBar?: (storyId: string, chapterId: string, barOverride: string) => Promise<unknown> | unknown;
    /** D-35 / D-35b — the dial: the approval gate and the drain threshold are the same write. */
    setAutoApprove?: (storyId: string, costs: Cost[]) => Promise<unknown> | unknown;
    /**
     * Phase ①'s two counts: how many Writer samples one Summary gets, and how many Readers
     * critique each sample (D-17d/D-38a: the Author's settings, never engine constants).
     */
    setSummaryReview?: (storyId: string, sampling: number, readers: number) => Promise<unknown> | unknown;
    /** U-8 / D-17b — the crew is a list, and the count is the Author's call (D-38a). */
    assignTemplates?: (storyId: string, templateIds: string[]) => Promise<unknown> | unknown;
    /** D-17 — New sends a template body; Duplicate names the row to copy (built-ins are duplicate-only). */
    createTemplate?: (input: { template?: Template; duplicate_of?: string }) => Promise<unknown> | unknown;
    patchTemplate?: (templateId: string, patch: Partial<Template>) => Promise<unknown> | unknown;
    /** U-7 / S-3 — teardown of one harness, with the reason recorded. */
    killRun?: (runId: string) => Promise<unknown> | unknown;
    /** §8.6 — the assistant run U-4 offers on the Summary pane. */
    requestAssistant?: (storyId: string, request: AssistantRequest) => Promise<unknown> | unknown;
    /**
     * U-13 / D-24 — the Author overriding the Editor's pick. The route is pinned
     * (`POST /stories/:id/revisions/:revisionId/select`), so this is no longer an extension point:
     * the shell binds it and the pane's Select is live. The unit ref is passed for the host's benefit
     * only — the draft row names its own unit, and the server derives the sibling deletes from it (D-22).
     */
    selectRevision?: (unitRef: string, revisionId: string) => Promise<unknown> | unknown;
    /**
     * U-13a / D-23 — the Author asks for named drafts to be merged. `parts` is the merge brief, and the
     * drafts stay competing until merged prose exists, so this is a queue entry, never a choice.
     */
    mergeRevisions?: (unitRef: string, revisionIds: string[], parts: string) => Promise<unknown> | unknown;
    /**
     * L-23 / U-1a — "issue a directive", the third stalled-screen exit. §5's directive is a record the
     * crews read on their next brief, and issuing one re-arms the Story to `ready` (L-23's closing
     * sentence), which is why it belongs beside the backtrack and the bar, not in a notes drawer.
     */
    sendDirective?: (storyId: string, text: string) => Promise<unknown> | unknown;
}

// ---------------------------------------------------------------------------
// Phase model (U-12a, U-16, D-25/L-31)
// ---------------------------------------------------------------------------

/** §4.1 — the three phases, in order. There is no fourth (`completed` is a status, L-25a). */
export const PHASE_ORDER: StoryPhase[] = ['summary', 'plotlines', 'chapters'];

/**
 * Decision item 8 — the UI vocabulary is Seed, Summary, plotline, chapter. The phrase numbers are
 * the left rail's reading order (Phrase 1 … 4); the loop's own controls name the artifact they
 * sign rather than repeating a number the four-phrase rail already carries.
 */
export const PHASE_LABELS: Record<StoryPhase, string> = {
    summary: 'Summary',
    plotlines: 'Plotlines',
    chapters: 'Chapters'
};

/** Which lock signed which phase. Phase ③'s lock IS `completed` (L-25a), hence the status test. */
export function phaseLocks(story: Story): Record<StoryPhase, boolean> {
    return {
        summary: story.summary_locked,
        plotlines: story.plotlines_locked,
        chapters: story.status === 'completed'
    };
}

/** The phases a backtrack to `target` reopens (everything strictly later than it). */
export function phasesAfter(target: StoryPhase): StoryPhase[] {
    return PHASE_ORDER.slice(PHASE_ORDER.indexOf(target) + 1);
}

/**
 * L-32 — the confirmation names EXACTLY what gets deleted, because backtrack is not undo and must
 * never read as "revert to an earlier draft". The counts come from the live view, so the sentence
 * can never promise a deletion the store does not owe.
 */
export function backtrackStatement(story: Story, target: BacktrackTarget, view: StoryViewData): string {
    const revisions = view.revisions.length;
    const head = `Backtrack to ${PHASE_LABELS[target]}`;

    // Back to ①: everything grown below the Seed goes (D-25 — "the prose and the structure, hard").
    if (target === 'summary') {
        return (
            `${head} deletes ${view.chapters.length} chapters with their ${revisions} revisions, ` +
            `${view.plotlines.length} plotlines, and the derived Digest. Verdicts and findings survive as ` +
            `provenance; the Ideas do not — the lock already deleted them (D-25, D-36, L-31). Story ` +
            `"${story.title}" starts again from its Seed.`
        );
    }

    // Back to ②: chapters and revisions only; the plotlines reopen editable.
    return (
        `${head} deletes ${view.chapters.length} chapters with their ${revisions} revisions and unlocks ` +
        `every plotline. Verdicts and selection notes survive (D-25, L-31). The locked Summary stays locked.`
    );
}

/**
 * U-16 — Lock is enabled only when the phase's Goal has passed AND the Ideas tray is empty
 * (L-7a: "a locked artifact with unjudged alternatives still in the tray is a decision the machine
 * made by silence"). The disabled state must SAY WHY, and the enabled state must state in one line
 * what becomes read-only.
 */
export interface LockCheck {
    phase: StoryPhase;
    canLock: boolean;
    reasons: string[];
    statement: string;
}

// ---------------------------------------------------------------------------
// Phase ①'s sign-off reads (T5 — ONE predicate per question)
//
// WHY THIS SECTION EXISTS: the rail ("does this Revision carry findings"), the Summary pane
// ("No Reader findings on this revision yet") and the lock ("1 critical/major finding still open")
// all answer the SAME attribution question, and while they each carried their own matching rule the
// Author got a disabled Accept next to an empty findings list — a blocker that is invisible on the
// row it blocks. Every rule below is the single dashboard-side answer; `story-nav.ts` and `lockCheck`
// both read them, so the panels cannot disagree again.
// ---------------------------------------------------------------------------

/**
 * D-30/D-34 — the two costs that can hold a sign-off WHATEVER the dial says. A `taste` note is recorded
 * and never blocks; `minor` joins the pair below when the Author's dial makes minor real work. Kept
 * exported because it is the dial-free core of both predicates and the answer the rail lists per cost.
 */
export const BLOCKING_FINDING_COSTS: Cost[] = ['critical', 'major'];

/** Is this finding at a cost that can hold the phase regardless of the dial? (D-30, D-34) */
export function isBlockingCostFinding(finding: Finding): boolean {
    return BLOCKING_FINDING_COSTS.includes(finding.cost);
}

/**
 * D-33/D-35 — does the AUTHOR have to decide this finding, or does the dial approve it on the sweep?
 * `story.auto_approve` is the projected dial (D-35b: one write sets the gate and the drain threshold),
 * which is what the loop's `findingsAwaitingAuthor`/`findingsToAutoApprove` split reads.
 */
export function dialCoversCost(story: Story, cost: Cost): boolean {
    return (story.auto_approve ?? []).includes(cost);
}

/**
 * THE SUMMARY'S BAR, the mirror of `records.ts:summaryBlockingCost`, and — like the server's — phase-
 * INDEPENDENT: the Summary is signed once and its blockers keep being read after the Story moved on
 * (the Accept tick, the pane, the lock). `critical`/`major` always; `minor` exactly when the projected
 * dial covers minor, because a dial that authorises minor makes a confirmed minor fix work that the
 * round may not stop on; `taste` never (phase ③ owns the prose it would prefer between).
 */
export function summaryBlockingCost(story: Story, cost: Cost): boolean {
    return cost === 'critical' || cost === 'major' || (cost === 'minor' && dialCoversCost(story, 'minor'));
}

/**
 * The loop's phase-aware bar, the mirror of `records.ts:isBlockingCost`: outside phase ① EVERY cost
 * blocks (D-33's all-costs rule), inside phase ① only the Summary's own set does. Read by
 * `unconfirmedBlockingFindings` below so the lock's "still unconfirmed" clause cannot drift from the
 * sign-off clause at `records.ts:unconfirmedBlockingFindings`.
 */
export function isBlockingCost(story: Story, cost: Cost): boolean {
    return story.phase !== 'summary' || summaryBlockingCost(story, cost);
}

/**
 * The round-and-draft context every revision-scope question needs (T11/F2, F4), built ONCE per view read.
 *
 * WHY A CONTEXT RATHER THAN A LOOKUP PER CALL: the dashboard and the server must answer four questions
 * the same way — is this draft retired (F2), does this finding speak about this revision (F4), does an
 * unconfirmed suspicion still hold the round (F3), and which passes does the winner still owe (F1). The
 * server answers all four from the SAME two reads (`records.ts:summaryRevisionRounds` and
 * `samplingRoundOf`), and while the dashboard guessed at them from a bare ref list it disagreed with the
 * engine about findings that name a non-draft ref (`[unitRef]`, `seed_brief_1`, a criterion) and about
 * drafts the loop has already set aside. One context object is the dashboard's single read of the same
 * facts, so `lockCheck`, the rail's badges, the pane's list, the review tick and the unconfirmed count
 * cannot drift apart again.
 */
export interface SummaryScopeContext {
    /**
     * Every known Summary draft id -> the round it was written in (`records.ts:summaryRevisionRounds`).
     * Membership is the F4 question — "do these refs name a DRAFT?" — so a draft that never recorded a
     * round is still in the map, at the round the server's own `?? revision.round ?? 1` fallback gives it.
     */
    draftRounds: Map<string, number>;
    /**
     * The round whose SELECTION the Story carries: `sampling.round` (`server/api/projections.ts:
     * samplingView`, i.e. `story.sampling_round ?? 1` — `0` after an Author reset). This is the round
     * the deep review is dispatched FOR, so the F1 dispatch guard (`work.ts:811`,
     * `records.ts:isDeepReviewSelection`) and `deepReviewProgress` below are made against THIS number.
     */
    round: number;
    /**
     * The round IN FLIGHT — the integer `records.ts:isSupersededSummaryDraft` compares a draft's round
     * against, sent by the projection as `sampling.active_round` (`records.ts:samplingRoundOf`), so the
     * rail, the attention badge, the override list and the lock count competition exactly as the engine
     * does (T12/P1).
     *
     * WHY NOT `round + 1`: the two numbers coincide only while a selection has landed. Before the first
     * selection `round` is already the in-flight round (1), and after an Author reset `round` is 0 while
     * the round being sampled is 1 again — an off-by-one guess either way, which is the bug this field
     * removes. The fallback below is the OLDER-payload case only (the slice is additive,
     * `api.ts:StoryView.sampling`): the projection names a `selected` sample iff a round COMPLETED
     * (§6.6), so `round + 1` is `samplingRoundOf`'s own answer in that branch, and with no selection on
     * the wire nothing has completed and round 1 is in flight. A malformed history row that names no
     * sample of its own is the one state that reads low here — and it can only under-claim supersession,
     * never retire live work.
     */
    activeRound: number;
    /** The round's winner, when the view has one; `undefined` while the round has not settled. */
    selectedId?: string;
    /**
     * The Summary ROW's id. It is a unit ref, never a draft, so a ref naming it is a statement about the
     * Summary as a whole (L-11a's whole-Summary findings name it) — `records.ts:findingRevisionScope`
     * excludes it from `namesDraft` for exactly that reason, and so does this file.
     */
    summaryRef?: string;
}

/** The one read of the projected revision facts; every scope predicate below takes its result. */
export function summaryScopeContext(view: StoryViewData): SummaryScopeContext {
    const draftRounds = new Map<string, number>();

    // THE SAME THREE PASSES the server runs (`records.ts:summaryRevisionRounds`), in the same order, so
    // the map cannot answer a scope question the engine would answer differently:
    //   1. `revision.round` — authoritative for anything the pipeline wrote (§6.2a);
    //   2. the capped sampling audit — the surviving round of a draft the selection hard-deleted
    //      (P13/D-22), whose row the projection recovers from the journal but which may carry no round;
    //   3. every remaining Summary row at round 1 — the round-less legacy row (T12/P2). Membership is
    //      what F4 asks ("is this id one of this Story's DRAFTS?"), and `1` is the fallback the server's
    //      own `?? revision.round ?? 1` chain gives the same row; a legacy round-1 row is exactly that.
    // The order matters: history wins over the round-less fallback, exactly as it does on the server.
    for (const revision of view.revisions) {
        if (revision.unit_kind !== 'summary') continue;

        if (typeof revision.round === 'number' && Number.isFinite(revision.round))
            draftRounds.set(revision.id, revision.round);
    }

    for (const row of view.sampling?.history ?? []) {
        for (const sample of row.samples ?? []) {
            if (!draftRounds.has(sample.revision_id)) draftRounds.set(sample.revision_id, row.round);
        }
    }

    for (const revision of view.revisions) {
        if (revision.unit_kind !== 'summary') continue;

        if (!draftRounds.has(revision.id)) draftRounds.set(revision.id, 1);
    }

    const sampling = view.sampling;
    const completed = sampling?.round ?? 1;

    return {
        draftRounds,
        round: completed,
        activeRound: sampling?.active_round ?? (sampling?.selected === undefined ? completed : completed + 1),
        selectedId: selectedSummaryRevision(view)?.id,
        summaryRef: view.summary?.id
    };
}

/**
 * Is this Summary draft a LOSER of a wave the loop has already moved past? T11/F2's single answer,
 * equivalent to `records.ts:isSupersededSummaryDraft`.
 *
 * Selection hard-deletes its losers, but a draft that was still being screened when the winner was
 * chosen survives the delete: it never entered the candidate set, and nothing else ever cleans it up. It
 * sits in the active round's revision list forever — a screening job that can never be answered, a
 * competition that can never be decided, and findings written about it that can never be confirmed. The
 * dashboard used to read it as a live round: "N Summary revisions still in this round" beside a Summary
 * whose round had already settled, which is the phantom blocker this predicate removes.
 *
 * The rule is ONE comparison against the round the loop is WORKING (`context.activeRound`, the
 * projection's `sampling.active_round`): a `drafted`/`competing` draft of an OLDER round has been set
 * aside by a choice the loop already made. `selected` and `discarded` keep their existing meanings (the
 * winner and the recorded history), and a draft of the CURRENT round or a later one is ordinary work,
 * not a corpse.
 *
 * THE FOUR STATES, identical to `records.ts:isSupersededSummaryDraft`'s table (T12/P1 — the parity test
 * is `server/loop/phase1-round-parity.test.ts`, which feeds ONE projected payload to both sides):
 * before the first selection round-1 drafts are live; after round R's selection a leftover round-R draft
 * is superseded; during R+1 its drafts are live and older ones superseded; and an Author override of an
 * older revision changes which draft the Summary carries, never the in-flight round, so that round's
 * rivals stay superseded.
 */
export function isSupersededSummaryDraft(
    view: StoryViewData,
    revision: Revision,
    context: SummaryScopeContext = summaryScopeContext(view)
): boolean {
    // Rounds only number phase ①'s sampling tree; a chapter draft's `round` is §4.4 bookkeeping, and the
    // server keeps counting every chapter draft as competition (`records.ts:unitsWithCompetingRevisions`).
    if (revision.unit_kind !== 'summary') return false;
    if (revision.state === 'selected' || revision.state === 'discarded') return false;

    return (context.draftRounds.get(revision.id) ?? revision.round ?? 1) < context.activeRound;
}

/**
 * Where a finding's weight lands, in the server's three answers (`records.ts:findingRevisionScope`).
 * Kept under the server's name so a reader can diff the two predicates side by side.
 */
export type FindingRevisionScope = 'selected' | 'superseded' | 'artifact';

export function findingRevisionScope(finding: Finding, context: SummaryScopeContext): FindingRevisionScope {
    const related = finding.related_refs ?? [];

    // No refs at all is the legacy whole-Story shape: it reads as a statement about the Summary, and the
    // server keeps its blocking weight (`summaryBlockingFindings`'s target-only clause).
    if (related.length === 0) return 'artifact';

    // T11/F4: the question is whether any ref names a KNOWN Summary DRAFT — not how many refs exist. A
    // row that names `[unitRef]`, `seed_brief_1`, a criterion or another non-draft id says nothing about
    // one draft, so it is a whole-artifact statement and keeps its weight. Retiring it on ref COUNT alone
    // is what made a real blocker invisible on the very revision it was holding.
    const namesDraft = related.filter((ref) => ref !== context.summaryRef && context.draftRounds.has(ref));

    if (namesDraft.length === 0) return 'artifact';

    return namesDraft.includes(context.selectedId ?? '') ? 'selected' : 'superseded';
}

/**
 * L-11a's attribution question, answered once for the whole Story view: does this finding speak about
 * THIS revision of the unit?
 *
 * Three answers, all from `findingRevisionScope` (T11/F4):
 *   - `artifact` — the row names no draft (no refs at all, or refs that name the Summary row, a brief, a
 *     criterion, a chapter). It is a statement about the Summary as a whole, so it is every revision of
 *     that unit's business, including the selected one: dropping it would hide a genuine blocker, and
 *     listing it in the lock but not in the pane is the contradiction this predicate removes;
 *   - `selected` / `superseded` — the row belongs to the draft(s) it names and to no other. A defect seen
 *     on Revision 2 is listed on Revision 2 (it is history the Author can still open) and never on the
 *     winner. `summaryBlockingFindings` then drops the superseded ones from the gate, exactly as
 *     `records.ts:summaryBlockingFindings` and `unconfirmedBlockingFindings` do.
 */
export function findingAppliesToRevision(
    finding: Finding,
    revisionId: string,
    unitRef: string,
    context: SummaryScopeContext
): boolean {
    return (
        findingRevisionScope(finding, context) === 'artifact'
            ? finding.target_ref === unitRef
            : (finding.related_refs ?? []).includes(revisionId)
    );
}

/**
 * The draft the Summary row carries — the text the Author signs and the deep review judges (§6.6).
 * Newest wins (`created_at`, id as the stable tie-break), because a Story that has been through several
 * rounds has one `selected` row per round and only the last one is the Summary on record.
 *
 * This lives here, not in `story-nav.ts`, because BOTH sides of the Story view need it: the rail's
 * revision list and the lock's blocker set must resolve the same draft, and `story-nav` imports this
 * module (the other direction would be a cycle).
 */
export function selectedSummaryRevision(view: StoryViewData): Revision | undefined {
    const summary = view.summary;

    if (summary === null || summary === undefined) return undefined;

    return view.revisions
        .filter(
            (revision) =>
                revision.unit_kind === 'summary' &&
                revision.unit_ref === summary.id &&
                revision.state === 'selected'
        )
        .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id))
        .slice(-1)[0];
}

/**
 * The findings that still hold the final Summary: `confirmed`/`approved` rows at a blocking cost
 * (`summaryBlockingCost`: critical/major, plus minor when the dial covers it) that apply to the SELECTED
 * revision. This is the dashboard mirror of `records.ts:summaryBlockingFindings`,
 * the set the loop holds `phase_signoff` for (`status.ts:508-531`), so the Accept button can neither
 * invent a blocker the engine ignores nor hide one it enforces.
 *
 * Findings on a DISCARDED sibling are history, not work: the next round reads the kept draft fresh.
 */
export function summaryBlockingFindings(view: StoryViewData, selected: Revision | undefined): Finding[] {
    if (selected === undefined) return [];

    // The unit the drafts belong to. `unit_ref` is the Summary row on every phase-① revision, so the
    // fallback is the same id, never a guess at one.
    const unitRef = view.summary?.id ?? selected.unit_ref;
    const context = summaryScopeContext(view);

    return view.findings.filter(
        (finding) =>
            (finding.state === 'confirmed' || finding.state === 'approved') &&
            // The Summary's own bar, dial included — the server's `summaryBlockingCost`, not the phase-
            // aware one, because these rows keep blocking after the Story leaves phase ①.
            summaryBlockingCost(view.story, finding.cost) &&
            // T11/F4: a row that names ONLY drafts the loop has already set aside is history, not work —
            // `records.ts:summaryBlockingFindings` answers `scope === 'superseded'` with `false`, and a
            // whole-artifact row keeps blocking only when its TARGET is this Summary.
            findingRevisionScope(finding, context) !== 'superseded' &&
            findingAppliesToRevision(finding, selected.id, unitRef, context)
    );
}

/**
 * D-33 / L-37's second condition, as projected: every suspicion nobody has confirmed or disputed. Phase
 * ① counts the Summary's blocking costs (critical/major, plus minor when the dial covers it — the same
 * filter `records.ts:unconfirmedBlockingFindings` applies),
 * and the sign-off waits for that set (`status.ts:494,529`). `view.findings` carries every state, so no
 * new endpoint is needed to say it out loud.
 *
 * T11/F3 adds the server's other half of the same question (`records.ts:unconfirmedBlockingFindings` +
 * `findingRevisionScope`): in phase ① a suspicion that names ONLY a draft the loop has already set aside
 * cannot hold this round either — re-verifying re-reads the KEPT draft, which never contained the defect,
 * so the round would wait on a question that can never be answered. The row stays on the record (and on
 * the rail entry of the draft it names); it is only out of THIS round's blocking set. Critical/major
 * suspicions on the current winner, and whole-artifact legacy rows, keep holding the sign-off.
 */
export function unconfirmedBlockingFindings(view: StoryViewData): Finding[] {
    const { story } = view;
    const context = summaryScopeContext(view);

    return view.findings.filter(
        (finding) =>
            finding.state === 'unconfirmed' &&
            // `&&` binds tighter than `||`, exactly as the server's filter reads: outside phase ① every
            // cost counts, inside phase ① only a blocking cost that is not superseded does.
            (story.phase !== 'summary' ||
                (summaryBlockingCost(story, finding.cost) &&
                    findingRevisionScope(finding, context) !== 'superseded'))
    );
}

/** The Author's Readers-per-sample count (D-17d) — `records.ts:screeningSizeOf`, mirrored not imported. */
export const summaryReadersOf = (story: Story): number => {
    const raw = story.summary_readers;

    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 1) return Math.floor(raw);

    return DEFAULT_SUMMARY_READERS;
};

/**
 * §16.1 job 5's claim-key family (`records.ts:deepReviewKeyOf` is `wi_review_<selected>_a<pass>`). A Run
 * row's `work_item_ref` IS its claim key (`run/executor.ts`), so the projected `runs` slice is the only
 * way the dashboard can see how far the deep review of the selected revision has got.
 */
export const DEEP_REVIEW_KEY_PREFIX = 'wi_review_';

/** One deep-review pass's claim key, spelled the way the ledger stores it (§16.1 job 5). */
export const deepReviewKeyOf = (revisionId: string, pass: number): string =>
    `${DEEP_REVIEW_KEY_PREFIX}${revisionId}_a${pass}`;

export interface DeepReviewProgress {
    /** Configured passes carrying a CLOSED run — a `failed` or `abandoned` pass counts, exactly as the ledger's own read does. */
    closed: number;
    /** Passes whose run is still alive (§4.13's live states) and has no closed row yet. */
    live: number;
    /**
     * Passes the selected revision still owes, or `0` when the round cannot dispatch them (an
     * older-round Author override) or when the payload carries no `runs` slice at all.
     */
    owed: number;
}

/**
 * How far the deep review of the SELECTED revision has got (§6.4 step 6, §16.7): the passes are
 * `summary_readers` in number, and a pass is answered once its claim key carries a non-live run.
 *
 * T11/F1 — THE DEFAULT IS OWED, NOT SILENT. `StoryView.runs` is a REQUIRED, uncapped projection
 * (`api.ts:StoryView`, `server/api/projections.ts`'s `runs:` line sends every row of the Story), so a
 * present slice that carries no `wi_review_` row for the winner is evidence of ONE thing: the sweep has
 * not dispatched the review yet, and all `summary_readers` passes are owed. Counting that case as zero
 * made a freshly selected revision look reviewed and let Accept light up over an unread Summary. The
 * count therefore walks the numbered passes `1..summaryReaders` and asks each one for its own key —
 * exactly `records.ts:deepReviewPassesOwed`'s loop — so:
 *   - a closed row for pass 3 does not answer pass 1;
 *   - an extra or suffixed key (`_a1x`, another draft's prefix) is not a numbered pass at all and cannot
 *     substitute for one;
 *   - a pass with a live row is REPORTED as live (the Author sees the work in flight) and still owed.
 *
 * ONE HONEST SILENCE SURVIVES: a payload whose `runs` slice is ABSENT (checked before iterating, so an
 * older build that never sends the collection is not mistaken for an unreviewed Story). There the
 * dashboard cannot tell "nobody has read it" from "this server does not report runs", and the lock names
 * a wait the projection proves, never one it guesses.
 *
 * THE ROUND GUARD (coordinated with the backend's owed predicate, `work.ts:811` /
 * `records.ts:isDeepReviewSelection`): the round whose selection just closed — `context.round`, NOT the
 * in-flight `context.activeRound` — is the only one whose deep review is dispatchable. A sample of the
 * round in flight has no findings to judge yet, and a pass bought for an OLDER round would be answered by
 * nobody. So an Author override of an older-round revision owes no un-dispatchable passes here, while the
 * round the Story's Summary came from owes every absent pass.
 */
export function deepReviewProgress(view: StoryViewData, selected: Revision | undefined): DeepReviewProgress {
    if (selected === undefined) return { closed: 0, live: 0, owed: 0 };

    // The legacy branch, guarded BEFORE any iteration: an absent slice says nothing about the review.
    if (view.runs === undefined || view.runs === null) return { closed: 0, live: 0, owed: 0 };

    const runsByKey = new Map<string, Run[]>();

    for (const run of view.runs) {
        const key = run.work_item_ref;

        // A row with no claim key belongs to no pass, whatever its id looks like.
        if (key === undefined || key.length === 0) continue;

        const rows = runsByKey.get(key);

        if (rows === undefined) runsByKey.set(key, [run]);
        else rows.push(run);
    }

    const passes = summaryReadersOf(view.story);
    const context = summaryScopeContext(view);
    const closedFor = (pass: number): boolean =>
        (runsByKey.get(deepReviewKeyOf(selected.id, pass)) ?? []).some((run) => !isLiveRun(run));

    let closed = 0;
    let live = 0;

    // Enumerating the passes (rather than the rows) is what turns an absent pass into a debt, and what
    // keeps another revision's ledger, or a malformed key, out of this draft's count.
    for (let pass = 1; pass <= passes; pass += 1) {
        if (closedFor(pass)) {
            closed += 1;
            continue;
        }

        const rows = runsByKey.get(deepReviewKeyOf(selected.id, pass)) ?? [];

        if (rows.length > 0) live += 1;
    }

    // An older-round override: the loop will not dispatch these passes, so it does not owe them, and the
    // lock must not hold a sign-off on work that can never run. The counts above stay honest.
    if ((selected.round ?? 1) !== context.round) return { closed, live, owed: 0 };

    return { closed, live, owed: Math.max(0, passes - closed) };
}

/** One reason line's count + noun, so every blocker sentence reads the same and the plural is never wrong. */
const reasonCount = (count: number, singular: string, pluralWord: string): string =>
    `${count} ${count === 1 ? singular : pluralWord}`;

export function lockCheck(view: StoryViewData): LockCheck {
    const { story, goal } = view;
    const phase = story.phase;
    // D-36: the tray is phase-scoped, so only this phase's undecided Ideas block the lock.
    const openIdeas = view.ideas.filter((idea) => idea.phase === phase && !isDecidedIdea(idea));

    const reasons: string[] = [];
    if (goal.failing.length > 0) {
        // G-2 renders failures as ids; the Author reads ids, never a percentage.
        reasons.push(
            `the Goal has not passed: ${goal.failing.map((line) => line.criterion).join(', ')} still failing (${goal.phase_progress})`
        );
    }
    if (openIdeas.length > 0) {
        reasons.push(
            `${openIdeas.length} Idea${openIdeas.length === 1 ? '' : 's'} still in the tray — each must be selected, discarded, or deferred first (L-7a)`
        );
    }

    // PHASE ①'S OWN BAR. The Summary is accepted only when the current round has a winner and
    // that winner has no critical/major flaw left. Minor/taste notes never hold the final Summary.
    //
    // WHY THE REASONS ARE ORDERED LIKE THIS: they follow the round's own stages — drafts still being
    // written, the round not settled yet, the winner's open defects, then the two waits the loop
    // enforces that this panel used to hide (an undecided suspicion, and §6.4 step 6's deep review).
    // `status.ts:524-535` is the engine's gate; every line below names one of its clauses, and nothing
    // here adds a wait the engine does not have.
    // R6 — THE GROUP MODEL REPLACES THIS WHOLE BAR. A grouped Story never runs the sampler pipeline: the
    // loop writes one group at a time (`loop/work.ts:draft_groups`), the deterministic selection installs no
    // whole-Summary draft, and §6.4 step 6's deep review is dispatched against the group VECTOR
    // (`wi_review_groups_<hash>`), not against `wi_review_<revision_id>`. Reading the sampling clauses for
    // a grouped book is how the gate invents a blocker the engine does not have ("no Summary revision is on
    // record yet" over a five-group Overview that is fully written), and how a real blocker — an unwritten
    // group, a finding that names one, a Writer holding a group — stays invisible. So the group bar answers
    // instead, and it is derived only from rows the phrase read sent.
    if (phase === 'summary' && story.summary_locked === false && isGroupSummary(view)) {
        reasons.push(...groupSignOffBlockers(view));
    } else if (phase === 'summary' && story.summary_locked === false && view.summary) {
        const summary = view.summary;
        // One scope read for the whole gate (T11/F2, F4): the competition count, the blocker set and the
        // unconfirmed count all answer from the same round/draft map the rail's list uses.
        const context = summaryScopeContext(view);
        const unfinished = view.revisions.filter(
            (revision) =>
                revision.unit_kind === 'summary' && revision.unit_ref === summary.id && isPendingRevision(revision)
        );
        const competing = view.revisions.filter(
            (revision) =>
                revision.unit_kind === 'summary' &&
                revision.unit_ref === summary.id &&
                isReviewableRevision(revision) &&
                // T11/F2 (`records.ts:unitsWithCompetingRevisions`): a draft the loop has already set
                // aside is not a round in flight, so it cannot hold the lock it can never be judged by.
                !isSupersededSummaryDraft(view, revision, context)
        );

        const selected = selectedSummaryRevision(view);

        if (unfinished.length > 0) {
            reasons.push(
                `${unfinished.length} Summary revision${unfinished.length === 1 ? '' : 's'} still being written — the Writer has to finish its blocks before the Summary can lock (§4.15)`
            );
        }

        if (competing.length > 0) {
            // R3 / §16.6 (D-47): phase ① has NO Editor draft choice — the round settles by a
            // deterministic engine selection (fewest critical → fewest high → fewest total → earliest
            // sample), and it fires only once every drafted sample has its full screening set
            // (§16.1 job 4). Telling the Author to "wait for the Editor's choice" points at a decision
            // that will never arrive, which is the other half of the reported contradiction. Later
            // phases really do have an Editor applying `selection_rules`, and their copy is untouched.
            reasons.push(
                `${reasonCount(competing.length, 'Summary revision', 'Summary revisions')} still in this round — the engine selects the winner once every draft has its screening reviews (§16.6)`
            );
        }

        // THE SAME PREDICATE THE PANE USES. `story-nav.ts:summaryRevisions` lists a revision's findings
        // through `findingAppliesToRevision`; counting the blockers here through anything else is what
        // let a finding disable the Accept button while the opened revision read "No Reader findings on
        // this revision yet".
        const blocking = summaryBlockingFindings(view, selected);

        // WHY THE LABEL IS DERIVED, NOT FIXED: the copy used to say "critical/major finding" because
        // those were the only costs that could block. The dial-driven minor rule (D-35's one dial, read
        // by `summaryBlockingCost`) lets a confirmed `minor` hold the Summary on a dial that covers
        // minor — and naming the wrong cost next to a row the rail labels `minor` is exactly the
        // contradiction this section exists to remove. Nothing moves when no minor is in the set: the
        // words, and every string the existing panels assert, are byte-for-byte what they were.
        const blockingWords = (rows: Finding[]): { one: string; many: string } =>
            rows.some((finding) => finding.cost === 'minor')
                ? { one: 'critical/major/minor finding', many: 'critical/major/minor findings' }
                : { one: 'critical/major finding', many: 'critical/major findings' };

        if (blocking.length > 0) {
            // D-34/D-35: the WAIT differs per state, so the copy differs. An `approved` row has already
            // armed the Writer work; a `confirmed` row the dial covers is approved on the next sweep;
            // a `confirmed` row the dial does not cover is sitting on the Author's desk, and promising it
            // "the next round" is false — nothing is queued until the Author decides.
            const armed = blocking.filter((finding) => finding.state === 'approved');
            const dialArmed = blocking.filter(
                (finding) => finding.state === 'confirmed' && dialCoversCost(story, finding.cost)
            );
            const awaitingApproval = blocking.filter(
                (finding) => finding.state === 'confirmed' && !dialCoversCost(story, finding.cost)
            );

            if (armed.length > 0) {
                reasons.push(
                    `${reasonCount(armed.length, `approved ${blockingWords(armed).one}`, `approved ${blockingWords(armed).many}`)} on the selected Summary — the next Summary round writes fresh drafts to clear them (D-34)`
                );
            }
            if (dialArmed.length > 0) {
                reasons.push(
                    `${reasonCount(dialArmed.length, blockingWords(dialArmed).one, blockingWords(dialArmed).many)} on the selected Summary at a cost your dial auto-approves — the sweep approves them and the next Summary round clears them (D-35)`
                );
            }
            if (awaitingApproval.length > 0) {
                reasons.push(
                    `${reasonCount(awaitingApproval.length, blockingWords(awaitingApproval).one, blockingWords(awaitingApproval).many)} on the selected Summary awaiting your approval — nothing is queued until the Author decides (D-34)`
                );
            }
        }

        // The clause at `status.ts:529`: a suspicion nobody has confirmed or disputed is still work, and
        // the sign-off waits for it. The row is on the revision's list, so the panel and the lock agree.
        const unconfirmed = unconfirmedBlockingFindings(view);

        if (unconfirmed.length > 0) {
            reasons.push(
                `${reasonCount(unconfirmed.length, blockingWords(unconfirmed).one, blockingWords(unconfirmed).many)} on the Summary still unconfirmed — the phase cannot sign off while a suspicion is undecided (D-33)`
            );
        }

        // The clause at `status.ts:513-515,532`: §6.4 step 6's deep review of the selected revision is
        // the phase's evidence, and owed passes hold the stop exactly like an open fix task does. T11/F1:
        // a settled round with no `wi_review_` row for its winner owes EVERY pass — the projected `runs`
        // slice is required and uncapped, so silence is "not reviewed yet", not "nothing owed".
        const review = deepReviewProgress(view, selected);

        if (review.owed > 0) {
            reasons.push(
                `${reasonCount(review.owed, 'deep-review pass', 'deep-review passes')} still owed on the selected Summary revision — the round's evidence is not complete${review.live > 0 ? ` (${review.live} still running)` : ''} (§6.4 step 6)`
            );
        }
    }

    const statements: Record<StoryPhase, string> = {
        summary:
            'Locking the Summary makes it read-only for every agent (P5, L-30) and deletes this phase\u2019s Ideas tray in the same commit (D-36).',
        plotlines:
            'Locking the plotlines makes every plotline propose-only for agents (D-6, L-7), freezes the contract every chapter is measured against (P4), and deletes the Ideas tray (D-36).',
        chapters:
            'Accepting completion locks the chapters exactly as the Summary and plotlines were locked (L-25a), and everything still open is closed with a count on it (L-25b).'
    };

    return { phase, canLock: reasons.length === 0, reasons, statement: statements[phase] };
}

// ---------------------------------------------------------------------------
// SUMMARY PHRASE — the group derivations (R1-R6)
//
// WHY THESE LIVE HERE AND NOT IN THE PANES: the rail's badges, the Overview's per-group state, the
// group detail's finding chips and the sign-off gate all answer from the SAME rows, and a rule that
// is a function of the view can be pinned without a DOM (this file's standing reason). Two rules matter
// most, and both were the reported defect class elsewhere in this package:
//
//   - IDENTITY IS THE UUID, NEVER THE ORDER (U2). `order` is composition order; a group that is
//     retitled, reordered or retired keeps its id, and a selection that stored an index would point at
//     a different group after that. So every lookup here takes an id, and the sort is only ever what
//     the rail DISPLAYS in that order.
//
//   - A FINDING'S GROUPS ARE `targeted`, NOT A REVISION MATCH (U5). `projections.ts` resolves each
//     finding against the group vector (R3), and an unscoped legacy row means "the whole Overview" —
//     which for a grouped book is every group, so it must show against all five rather than vanish or
//     claim one. Nothing here re-derives scope from `revision` numbers.
//
// ARCHIVED IS ARCHIVED AWAY (U3). `history` is newest-first and INCLUDES the `latest` row; the panes
// may count the `archived` rows and print the current text, and the projection sends no archived prose
// (`PhraseRevisionRow.chars`, not `.content`), so no pane may offer to open one.
// ---------------------------------------------------------------------------

/** Whether this Story's Summary is group-managed, as the wire says (R6's echo, with the row as backup). */
export function isGroupSummary(view: Pick<StoryViewData, 'story'> & Partial<Pick<StoryViewData, 'phrase'>>): boolean {
    const mode = view.phrase?.mode;

    // The projection echoes `story.summary_mode`; the phrase read lags the Story payload by one flight,
    // so the row answers the question in the frame before the group rows arrive. Neither source may make
    // a legacy book (`summary_mode` absent) look grouped.
    if (mode !== undefined) return mode === 'groups';

    return view.story.summary_mode === 'groups';
}

/**
 * Whether the phrase read has LANDED for this Story. The one honest answer to "is the group surface
 * loaded", and the only thing that separates a load in flight from a book with no rows (U6): `phraseGroups`
 * answers `[]` for both, and only this predicate may tell them apart.
 *
 * It lives here, next to the derivations that need it, because `groupSignOffBlockers` must not claim a
 * ready gate over rows that never arrived (R-T2/F1); `story-nav.ts` re-exports it as `phraseLoaded` for the
 * rail, which is where the loading line is drawn.
 */
export const phraseReadLanded = (view: Pick<StoryViewData, 'phrase'>): boolean =>
    view.phrase !== undefined && view.phrase !== null;

/** The cached failure sentence for this Story's phrase read; `undefined` when the read has not failed (R-T2/F2). */
export const phraseReadError = (view: Pick<StoryViewData, 'phraseError'>): string | undefined =>
    view.phraseError ?? undefined;

/** The phrase read's finding rows, or `[]` when the read has not landed. */
export function phraseFindings(view: Pick<StoryViewData, 'phrase'>): PhraseFindingRow[] {
    return view.phrase?.findings ?? [];
}

/** The composed Overview the server reads off the group rows (R2) — `''` when nothing is written. */
export function phraseOverview(view: Pick<StoryViewData, 'phrase'>): string {
    return view.phrase?.overview ?? '';
}

/**
 * The groups in composition order, with a stable id tie-break so a refetch never reshuffles the rail.
 * `[]` for a sampling-mode Story (its rail has no groups to list) and for a phrase read that has not
 * landed — the rail then renders its loading state, which is a different sentence from "no groups".
 */
export function phraseGroups(view: Pick<StoryViewData, 'phrase' | 'story'>): PhraseGroupRow[] {
    if (!isGroupSummary(view)) return [];

    return [...(view.phrase?.groups ?? [])].sort(
        (left, right) => left.order - right.order || left.key.localeCompare(right.key) || left.id.localeCompare(right.id)
    );
}

/** One group by its UUID — the address the rail's selection ref carries. */
export function phraseGroupById(
    view: Pick<StoryViewData, 'phrase' | 'story'>,
    groupId: string | undefined
): PhraseGroupRow | undefined {
    if (groupId === undefined) return undefined;

    return phraseGroups(view).find((group) => group.id === groupId);
}

/** A finding is open while it is not settled: R6's own open set, mirror of `projections.ts`'s filter. */
export const OPEN_PHRASE_FINDING_STATES: FindingState[] = ['unconfirmed', 'confirmed', 'approved'];

export function isOpenPhraseFinding(finding: PhraseFindingRow): boolean {
    return OPEN_PHRASE_FINDING_STATES.includes(finding.state);
}

/** A finding archived out of every active list: fixed, discarded or disputed (U5). */
export function isArchivedPhraseFinding(finding: PhraseFindingRow): boolean {
    return !isOpenPhraseFinding(finding);
}

/**
 * Does this finding aim at this group? `targeted` is the server's resolved scope (R3), and an UNSCOPED
 * legacy row — one that named no group — is a statement about the whole Overview, which on a grouped
 * book is every group. A pane that matched on `group_refs.length` alone would hide exactly the finding
 * the report called invisible.
 */
export function findingTargetsGroup(
    finding: PhraseFindingRow,
    groupId: string,
    groups: readonly PhraseGroupRow[] = []
): boolean {
    if (finding.targeted.includes(groupId)) return true;

    if (finding.group_refs.includes(groupId)) return true;

    return finding.unscoped && groups.some((group) => group.id === groupId);
}

/** Every group a finding is aimed at, resolved the same way, in composition order. */
export function findingGroups(finding: PhraseFindingRow, groups: readonly PhraseGroupRow[]): PhraseGroupRow[] {
    return groups.filter((group) => findingTargetsGroup(finding, group.id, groups));
}

/** The open findings that name this group — the rail badge and the detail's finding list. */
export function groupOpenFindings(view: StoryViewData, groupId: string): PhraseFindingRow[] {
    const groups = phraseGroups(view);

    return phraseFindings(view).filter(
        (finding) => isOpenPhraseFinding(finding) && findingTargetsGroup(finding, groupId, groups)
    );
}

/**
 * The open findings on this group that hold the sign-off: the Summary's own cost bar
 * (`summaryBlockingCost`, dial included), so the badge, the pane and the Accept gate cannot disagree
 * about which rows are work.
 */
export function groupBlockingFindings(view: StoryViewData, groupId: string): PhraseFindingRow[] {
    return groupOpenFindings(view, groupId).filter((finding) => summaryBlockingCost(view.story, finding.cost));
}

/**
 * The open STORY tasks the sign-off waits on (R3's other half) — NOT a group-scoped queue.
 *
 * R-T2/F3, from the server: `projections.ts:1208` builds the phrase read's `tasks` rows as
 * `store.tasks.list().filter(task => task.story_id === story.id && task.state !== 'done')` — every open task
 * of the Story, whatever phase or kind it belongs to — and `PhraseTaskRow` carries no group attribution at
 * all, so the client COULD NOT scope them even if it wanted to. The engine does gate the phase on queued
 * work (`loop/status.ts`'s `${n} task(s) still queued` and phase ①'s fix/rewrite/merge clause), so an open
 * task is a true wait; what would be a lie is calling it a "group" task. The copy says `Story task` for
 * that reason, and the count stays equal to `review.open_tasks` because the filter is the projection's own.
 */
export function groupOpenTasks(view: Pick<StoryViewData, 'phrase'>): PhraseTaskRow[] {
    return (view.phrase?.tasks ?? []).filter((task) => task.state !== 'done');
}

/** The revisions superseded on this group — countable, never expandable (the API sends no archived text). */
export function groupArchivedRevisions(group: PhraseGroupRow): PhraseRevisionRow[] {
    return group.history.filter((revision) => revision.state === 'archived');
}

/** The `latest` row of a group, when the history carries one (it does, once `revision > 0`). */
export function groupLatestRevision(group: PhraseGroupRow): PhraseRevisionRow | undefined {
    return group.history.find((revision) => revision.state === 'latest') ?? group.history[0];
}

/** A group is written once it has a revision — `revision: 0` is the loop's "never written" (R1). */
export const isGroupWritten = (group: PhraseGroupRow): boolean => group.revision > 0;

/** A group whose text a live Writer pass is replacing right now (F8/R4). */
export const isGroupWriterBusy = (group: PhraseGroupRow): boolean => group.writer_busy;

/** Every group with no revision yet — the sign-off's first blocker (R1: an unwritten group is not an Overview). */
export function unwrittenGroups(view: Pick<StoryViewData, 'phrase' | 'story'>): PhraseGroupRow[] {
    return phraseGroups(view).filter((group) => !isGroupWritten(group));
}

/**
 * The sign-off blockers the GROUP model adds to the phase gate (U5's last test).
 *
 * The route itself still gates on the phase Goal and the Ideas tray (`routes.ts:POST /stories/:id/lock`),
 * and the dashboard may not invent a blocker the engine ignores — but it may not ACCEPT a ready-looking
 * gate over a Summary the group rows say is incomplete either. Each reason below is a fact off the phrase
 * read, phrased as the wait it is, and an empty list means the group surface has nothing outstanding.
 */
export function groupSignOffBlockers(view: StoryViewData): string[] {
    if (!isGroupSummary(view)) return [];

    const reasons: string[] = [];

    // R-T2/F1 + F2 — THE READ COMES FIRST. `phraseGroups` answers `[]` for a read that has not landed, and
    // every clause below counts rows, so an in-flight or failed read would produce NO reasons and the gate
    // would claim a five-group Overview that is complete and clean. Absent groups are not an empty valid
    // Phrase: the phrase read is the only source of this gate's facts, so its state is itself the blocker.
    // The two cases get different sentences, because only one of them is fixed by waiting (F2).
    if (!phraseReadLanded(view)) {
        const failure = phraseReadError(view);

        return [
            failure === undefined
                ? 'the Summary group rows have not been read yet — the sign-off waits for the phrase read to answer'
                : `the Summary group rows could not be read: ${failure} — reload the Story before signing the Summary off`
        ];
    }

    const unwritten = unwrittenGroups(view);

    if (unwritten.length > 0) {
        reasons.push(
            `${reasonCount(unwritten.length, 'Summary group', 'Summary groups')} still unwritten (${unwritten
                .map((group) => group.title)
                .join(', ')}) — an unwritten group is not part of the Overview yet (R1)`
        );
    }

    const groups = phraseGroups(view);
    const blocking = phraseFindings(view).filter(
        (finding) => isOpenPhraseFinding(finding) && summaryBlockingCost(view.story, finding.cost)
    );

    if (blocking.length > 0) {
        const names = (rows: PhraseFindingRow[]): string =>
            rows
                .slice(0, 3)
                .map((finding) => findingGroups(finding, groups).map((group) => group.title).join('/') || 'the Overview')
                .join(', ');

        reasons.push(
            `${reasonCount(blocking.length, 'open finding', 'open findings')} on the Summary groups — ${names(
                blocking
            )} still ${
                blocking.some((finding) => finding.state === 'approved')
                    ? 'await the revision that answers them (R3)'
                    : 'await your decision (D-34)'
            }`
        );
    }

    const openTasks = groupOpenTasks(view);

    if (openTasks.length > 0) {
        // R-T2/F3: the read's task rows are every open task of the STORY (`projections.ts:1208`) and carry no
        // group attribution, so the sentence may not call them the groups' — a chapter repair task waiting in
        // the queue holds the Summary sign-off too, and that IS the engine's rule (`loop/status.ts`'s queued-
        // work clause), not a blocker this gate invented.
        reasons.push(
            `${reasonCount(
                openTasks.length,
                'Story task',
                'Story tasks'
            )} still open in the queue — the crew has work it has not closed, on this Summary or anywhere in the Story`
        );
    }

    const busy = groups.filter(isGroupWriterBusy);

    if (busy.length > 0) {
        reasons.push(
            `the Writer is rewriting ${busy.map((group) => group.title).join(', ')} right now — the text on screen is about to move (R4)`
        );
    }

    return reasons;
}

// ---------------------------------------------------------------------------
// Findings and Ideas (D-33/D-34, D-27/D-32)
// ---------------------------------------------------------------------------

/** §4.10's stated shorthand: "Open means any of unconfirmed, confirmed, approved that is not yet fixed". */
export const OPEN_FINDING_STATES: FindingState[] = ['unconfirmed', 'confirmed', 'approved'];

export function isOpenFinding(finding: Finding): boolean {
    return OPEN_FINDING_STATES.includes(finding.state);
}

/** D-32/D-36 — the Author's decisions, which are the memory that stops the next Reader re-arguing. */
export const DECIDED_IDEA_STATES: IdeaState[] = ['selected', 'discarded', 'deferred'];

export function isDecidedIdea(idea: Idea): boolean {
    return DECIDED_IDEA_STATES.includes(idea.state);
}

/**
 * D-27: an Idea may be selected once an Editor has returned `verified`. Anything else — no verdict
 * yet, `refuted`, `unverifiable` — is an unverified claim and needs the Author's explicit "I know".
 */
export function isVerifiedIdea(idea: Idea): boolean {
    return idea.verification?.verdict === 'verified';
}

/** D-32 — the earlier decision a repeat of a settled Idea must be shown with. */
export function earlierDecisionOf(idea: Idea, all: Idea[]): Idea | undefined {
    return all.find((other) => other.id !== idea.id && other.fingerprint === idea.fingerprint && isDecidedIdea(other));
}

// ---------------------------------------------------------------------------
// Chapter activity grouping (decision 0/5, L-8)
// ---------------------------------------------------------------------------

/**
 * Decision 0/5: with all chapters in flight together (L-8), ORDER is no longer what is happening,
 * so the Story view groups them by what the crews are doing to them.
 */
export type ActivityGroup = 'contested' | 'awaiting' | 'drafting' | 'clean';

/** Fixed render order: what needs the Author's eye first, the finished work last. */
export const ACTIVITY_ORDER: ActivityGroup[] = ['contested', 'awaiting', 'drafting', 'clean'];

export const ACTIVITY_LABELS: Record<ActivityGroup, string> = {
    contested: 'Contested — competing revisions await a selection (D-23)',
    awaiting: 'Awaiting a fix — approved findings and rechecks',
    drafting: 'Drafting — the crew is writing',
    clean: 'Clean — done'
};

/**
 * §4.15: a draft a reviewer may read — `drafted` once its Writer run closed, and `competing` for
 * rows written before the pending/drafted lifecycle existed.
 */
export const isReviewableRevision = (revision: Revision): boolean =>
    revision.state === 'drafted' || revision.state === 'competing';

/** A draft whose Writer is still working on it (or one waiting to be completed). */
export const isPendingRevision = (revision: Revision): boolean => revision.state === 'pending';

/** The competing revisions of one unit (D-23: more than one and the unit cannot advance). */
export function competingRevisionsFor(revisions: Revision[], unitRef: string): Revision[] {
    return revisions.filter((revision) => revision.unit_ref === unitRef && isReviewableRevision(revision));
}

/**
 * Classify one chapter. Precedence matters: a `done` chapter that picked up an approved finding is
 * awaiting a fix, not clean (L-11 reopens a done chapter a change touches), and a chapter with
 * competing drafts is contested before anything else (D-23 is the hard gate).
 */
export function classifyChapter(chapter: Chapter, view: StoryViewData): ActivityGroup {
    if (competingRevisionsFor(view.revisions, chapter.id).length > 1) {
        return 'contested';
    }

    // D-34: approval is what starts Writer work, so an approved open finding means a fix is queued.
    // `needs_recheck` is the same state seen from the propagation side (L-11a).
    const awaitingFix =
        view.findings.some(
            (finding) => finding.state === 'approved' && isOpenFinding(finding) && finding.target_ref === chapter.id
        ) || chapter.state === 'needs_recheck';
    if (awaitingFix) {
        return 'awaiting';
    }

    return chapter.state === 'done' ? 'clean' : 'drafting';
}

/** The four groups, always in ACTIVITY_ORDER, so the screen does not reshuffle itself each sweep. */
export function groupChapters(view: StoryViewData): Array<{ group: ActivityGroup; chapters: Chapter[] }> {
    return ACTIVITY_ORDER.map((group) => ({
        group,
        chapters: view.chapters.filter((chapter) => classifyChapter(chapter, view) === group)
    }));
}

// ---------------------------------------------------------------------------
// Proposals and diffs (U-5, D-20)
// ---------------------------------------------------------------------------

/**
 * The pending proposals that land on one chapter: `target_ref` is either the chapter or one of its
 * section ids (D-7 makes sections addressable and `proposeChange` names the span), so both
 * spellings are matched. Only `pending` ones are actionable.
 */
export function pendingProposalsFor(chapter: Chapter, proposals: Proposal[]): Proposal[] {
    const sectionIds = new Set(chapter.sections.map((section) => section.id));
    return proposals.filter(
        (proposal) =>
            proposal.state === 'pending' && (proposal.target_ref === chapter.id || sectionIds.has(proposal.target_ref))
    );
}

/**
 * `Revision.body` and `Proposal.patch` are `unknown` in the pinned model (§4.15/§4.16 leave the
 * shape open and P15 wants it replaceable), so reading the proposed text out of one is a tolerant,
 * TOTAL function rather than a cast. Known spellings: `text`, `content`, `value`; the section id
 * under `section_id` or `section_ref`.
 */
export function patchOf(patch: unknown): { sectionId?: string; text: string } {
    if (typeof patch === 'string') {
        return { text: patch };
    }

    if (patch && typeof patch === 'object') {
        const record = patch as Record<string, unknown>;
        const field = [record.text, record.content, record.value].find((candidate) => typeof candidate === 'string');
        const idField = [record.section_id, record.section_ref].find((candidate) => typeof candidate === 'string');
        return {
            sectionId: idField as string | undefined,
            text: typeof field === 'string' ? field : ''
        };
    }

    return { text: '' };
}

/** One span of a word diff (U-5: "A diff, not a replaced paragraph"). */
export interface DiffSegment {
    kind: 'same' | 'removed' | 'added';
    text: string;
}

/**
 * Word-level diff by LCS over whitespace-split tokens (whitespace kept as tokens so the spans read
 * as prose). Deterministic and dependency-free: an LCS table is twenty lines, and its output is
 * stable for a given pair — a fuzzy diff is a fuzzy review (P6's discipline, applied to the UI).
 */
export function diffWords(current: string, proposed: string): DiffSegment[] {
    const before = current.split(/(\s+)/);
    const after = proposed.split(/(\s+)/);

    // Classic LCS length table; O(n*m) on paragraph-sized input, which is all a section is (E-1).
    const table: number[][] = Array.from({ length: before.length + 1 }, () =>
        new Array<number>(after.length + 1).fill(0)
    );
    for (let i = before.length - 1; i >= 0; i -= 1) {
        for (let j = after.length - 1; j >= 0; j -= 1) {
            table[i][j] = before[i] === after[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
        }
    }

    const segments: DiffSegment[] = [];
    const push = (kind: DiffSegment['kind'], text: string): void => {
        const last = segments[segments.length - 1];
        // Merge runs of the same kind so the diff reads as spans, not as a token grid.
        if (last && last.kind === kind) {
            last.text += text;
            return;
        }
        segments.push({ kind, text });
    };

    let i = 0;
    let j = 0;
    while (i < before.length && j < after.length) {
        if (before[i] === after[j]) {
            push('same', before[i]);
            i += 1;
            j += 1;
        } else if (table[i + 1][j] >= table[i][j + 1]) {
            push('removed', before[i]);
            i += 1;
        } else {
            push('added', after[j]);
            j += 1;
        }
    }
    while (i < before.length) {
        push('removed', before[i]);
        i += 1;
    }
    while (j < after.length) {
        push('added', after[j]);
        j += 1;
    }

    return segments;
}

// ---------------------------------------------------------------------------
// Revisions (U-13, D-21)
// ---------------------------------------------------------------------------

/** One unit's competing drafts, labelled with the artifact they belong to. */
export interface RevisionUnit {
    unitRef: string;
    unitKind: Revision['unit_kind'];
    label: string;
    revisions: Revision[];
    /**
     * U-13 (D-21/D-22): the verdict rows that speak to each DRAFT, newest last, keyed by revision id.
     * §6.2a files a checker's report against the draft it read — the Checker also appends the verdict to
     * `revision.verdict_refs` — so this is the honest per-column judgement, matched by `target_ref`
     * because the dashboard recomputes nothing (L-14) and joins §4.9 rows per pane instead.
     */
    verdictsByRevision: Record<string, Verdict[]>;
    /**
     * Verdicts filed against the UNIT rather than a draft — the other convention §8.3's `submitVerdict`
     * produces (`target_ref` is the unit). A draft with no verdict of its own shows these, labelled as
     * the unit's judgement, because "nobody read this draft" and "nobody read this unit" are different
     * claims and only the second one is false here.
     */
    verdictsForUnit: Verdict[];
}

/**
 * U-13 — group the revisions by unit so each unit renders side by side. Labels resolve through the
 * chapter and plotline records (the Author reads "Chapter 6 — The Reservoir", never an id). Units
 * are emitted in the order the view lists them, which keeps the panel stable.
 *
 * The verdicts are sorted HERE, not in the pane: the view's `verdicts` slice is oldest-first (the
 * server's order, records.ts:verdictsFor), and "the newest report describes the artifact as it stands"
 * is the same rule the criteria engine aggregates by (criteria/engine.ts:aggregateJudge). The pane is
 * declarative, so the derivation lives in the pure module next to its rule.
 */
export function buildRevisionUnits(view: StoryViewData): RevisionUnit[] {
    const units = new Map<string, RevisionUnit>();
    // `verdicts` is additive on the wire: an older server omits the slice, and every branch below then
    // behaves exactly as it did before (refs only), rather than throwing on `undefined`.
    const verdicts = view.verdicts ?? [];

    // Oldest-first within each bucket, so the pane's last entry is the newest judgement. `updated_at`
    // is the record's own recency marker (records.ts:recency sorts by journal order, which the wire
    // preserves); a stable secondary on id keeps two rows with one timestamp in a fixed order.
    const byRecency = (left: Verdict, right: Verdict): number =>
        left.updated_at.localeCompare(right.updated_at) || left.id.localeCompare(right.id);
    const sorted = [...verdicts].sort(byRecency);

    for (const revision of view.revisions) {
        const existing = units.get(revision.unit_ref);
        if (existing) {
            existing.revisions.push(revision);
            continue;
        }

        const chapter = view.chapters.find((candidate) => candidate.id === revision.unit_ref);
        const plotline = view.plotlines.find((candidate) => candidate.id === revision.unit_ref);
        const label = chapter
            ? `Chapter ${chapter.order} — ${chapter.title}`
            : plotline
              ? `Plotline ${plotline.order}${plotline.heading ? ` — ${plotline.heading}` : ''}`
              : revision.unit_kind === 'summary'
                ? 'Summary'
                : revision.unit_ref;

        units.set(revision.unit_ref, {
            unitRef: revision.unit_ref,
            unitKind: revision.unit_kind,
            label,
            revisions: [revision],
            verdictsByRevision: {},
            verdictsForUnit: sorted.filter((verdict) => verdict.target_ref === revision.unit_ref)
        });
    }

    // The per-draft buckets are filled AFTER the grouping, and scoped to the unit being built: filling
    // one on first encounter would scatter every draft's row into the first unit's map (the buckets are
    // keyed by revision id, so the unit must scope them, not the key).
    for (const unit of units.values()) {
        const owned = new Set(unit.revisions.map((revision) => revision.id));

        for (const verdict of sorted) {
            if (!owned.has(verdict.target_ref)) continue;

            (unit.verdictsByRevision[verdict.target_ref] ??= []).push(verdict);
        }
    }

    return Array.from(units.values());
}

/**
 * The verdicts one DRAFT is shown, and where they came from (U-13, D-21, D-22).
 *
 * §6.2a's loop B files a checker's report against the draft it read, so a draft with its own rows is
 * judged on its own merits. A draft with none is NOT unjudged: §8.3's `submitVerdict` takes a
 * `target_ref` and the loop's convention for a unit-level pass is the unit, so the unit's rows are the
 * only judgement that exists. Showing nothing there would tell the Author "nobody read this draft" when
 * what happened is "nobody filed a verdict naming this draft" — different claims (the same two
 * conventions are what `unitIsChecked` accepts server-side, loop/records.ts:502).
 */
export function draftVerdicts(
    unit: RevisionUnit,
    revision: Revision
): { verdicts: Verdict[]; source: 'draft' | 'unit' } {
    const own = unit.verdictsByRevision[revision.id] ?? [];

    return own.length > 0 ? { verdicts: own, source: 'draft' } : { verdicts: unit.verdictsForUnit, source: 'unit' };
}

/**
 * The prose of one revision, tolerant of the three body shapes §4.15 allows: a Summary is its
 * prose fields, a plotline its contract fields, a chapter its `ChapterSection[]` (D-7).
 */
export function revisionBodyText(body: unknown): string {
    if (typeof body === 'string') {
        return body;
    }

    if (Array.isArray(body)) {
        // A chapter body is sections, so it renders the way the prose pane does: blank line apart.
        return body
            .map((entry) => {
                if (typeof entry === 'string') {
                    return entry;
                }
                if (entry && typeof entry === 'object') {
                    const text = (entry as Record<string, unknown>).text;
                    return typeof text === 'string' ? text : '';
                }
                return '';
            })
            .filter((line) => line.length > 0)
            .join('\n\n');
    }

    if (body && typeof body === 'object') {
        return Object.entries(body as Record<string, unknown>)
            .filter(([, value]) => typeof value === 'string')
            .map(([key, value]) => `${key}: ${value as string}`)
            .join('\n');
    }

    return '';
}

// ---------------------------------------------------------------------------
// Runs (U-7, S-7, U-8d)
// ---------------------------------------------------------------------------

/** §4.13 — the three states that mean the harness is alive right now (D-18: the row exists spawn→teardown). */
export const LIVE_RUN_STATES: Run['state'][] = ['spawning', 'working', 'reporting'];

export function isLiveRun(run: Run): boolean {
    return LIVE_RUN_STATES.includes(run.state);
}

/**
 * U-17's banner counts the runs a Pause actually stopped: rows that ended by the Author's hand or
 * by the stop, which is the same mechanism (D-37). S-3 records why every run ended, so the count is
 * read from the record rather than guessed.
 */
const PAUSE_END_PATTERN = /(author|stop|paused|kill)/i;

export function runsStoppedByPause(runs: Run[]): number {
    return runs.filter((run) => !isLiveRun(run) && PAUSE_END_PATTERN.test(run.end_reason ?? '')).length;
}

/**
 * U-8d — a run whose internal agents disagreed must be marked: a hidden disagreement inside an
 * authoritative answer is the one thing the Author cannot tune (D-38). D-38 requires the dissent to
 * be named in the `selection_note` or the finding's detail, i.e. in the run's own reported text,
 * which is exactly what this reads.
 */
const DISSENT_PATTERN = /(dissent|disagree|split|preferred|\d+ of \d+)/i;

export function panelDissent(run: Run): string | null {
    const candidates = [run.end_reason ?? '', ...run.delegated.map((entry) => entry.summary ?? '')];
    return candidates.find((text) => DISSENT_PATTERN.test(text)) ?? null;
}

/** Elapsed, rendered as a duration (S-6: informational only — E-0 forbids reading it as a limit). */
export function formatElapsed(startedAt: string, endedAt: string | null | undefined, now: string): string {
    const seconds = Math.floor((Date.parse(endedAt ?? now) - Date.parse(startedAt)) / 1000);
    if (!Number.isFinite(seconds) || seconds < 0) {
        return '0s';
    }

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
        return `${hours}h ${String(minutes).padStart(2, '0')}m`;
    }
    if (minutes > 0) {
        return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
    }
    return `${seconds}s`;
}

// ---------------------------------------------------------------------------
// Templates (U-8, D-17, D-38)
// ---------------------------------------------------------------------------

/** D-38: a role is a panel when it declares more than one agent; the card has to say so (U-8d). */
export function isPanelRole(role: TemplateRole): boolean {
    return (role.agents ?? 1) > 1;
}

/** U-8b: `selection_rules` belongs to an Editor template — that text IS the Author's taste (D-17c). */
export function hasEditorRole(template: Template): boolean {
    return template.roles.some((role) => role.kind === 'editor');
}

/**
 * The blank template **New** creates: an Author's own crew, never a built-in (P12). The
 * bookkeeping fields are placeholders the server replaces on create — the same convention
 * `defaultGoal` uses in `shared/criteria.ts`, so a create payload never carries a real id.
 *
 * `now` is a parameter (not `new Date()` inside) so a test can pin the payload exactly; the
 * panel passes the wall clock, which is fine because a create's timestamp is the server's truth.
 */
export function blankTemplatePayload(now = new Date().toISOString()): Template {
    return {
        id: 'template_new',
        rev: 1,
        created_at: now,
        updated_at: now,
        name: 'author-crew',
        title: 'Author crew',
        description: 'A crew of the Author’s own making (D-17).',
        roles: [{ name: 'writer', kind: 'writer', prompt: '' }],
        serves_phase: ['chapters'],
        done_definition: '',
        attempts: 1,
        builtin: false,
        editable: true
    };
}

// ---------------------------------------------------------------------------
// Completion (U-14 / L-25b)
// ---------------------------------------------------------------------------

/**
 * L-25b's sentence, verbatim in shape: "47 findings and 12 Ideas will be closed without action, the
 * oldest from chapter 2". The count is the point — a to-do list quietly emptied is not information,
 * so the UI states the discard BEFORE the Accept.
 */
export function completionDiscardSentence(preview: CompletionPreview): string {
    const oldest = preview.oldest ? `, the oldest from ${preview.oldest}` : '';
    return `${preview.open_findings} findings and ${preview.open_ideas} Ideas will be closed without action${oldest} (L-25b).`;
}
