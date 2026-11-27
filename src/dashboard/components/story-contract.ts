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
    PhraseBriefView,
    PhraseChosenSummary,
    PhraseDetailView,
    PhraseFindingRow,
    PhraseGroupRow,
    PhraseGroupScore,
    PhrasePlotpointsInput,
    PhraseReviewedGroup,
    PhraseReviewedSummary,
    PhraseRevisionRow,
    PhraseReviewState,
    PhraseStartInput,
    PhraseTaskRow,
    PhraseView,
    // R7 — the cleanup proposal and its refusal codes: the desk prints one sentence per state, so the states
    // travel as wire types rather than as strings the card invents.
    SeedCleanupProposal,
    SeedCleanupRefusal,
    StoryView,
    UndoTarget
} from '../api';
// R1 — the store's own cache key for a group's lock refusal, imported as a VALUE (see the re-export below):
// `state.ts:groupLockWrite` writes `groupLockErrors[groupLockKey(story, group)]`, and the group pane reads it
// through this module, so both sides cannot hold their own spelling of the key.
import { groupLockKey } from '../api';
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
    // R5 — the §4.3 contract row: the panes render its ORDERED beats and dialogue, and the deprecated prose fields
    // are read by exactly one function in this module (`plotlineBeatsOf`'s recovery arm).
    Plotline,
    Revision,
    Run,
    Story,
    StoryPhase,
    StoryStatus,
    Template,
    TemplateRole,
    Verdict
} from '../../types';
export type { CompletionPreview, CostDistribution, FailingCriterion };
// R6 — the group rows the Summary rail and its panes render. Aliased here (rather than imported at every
// call site) so the panels keep reading ONE module for their view contract, and so the shapes the panes
// assert are the shapes `../api` pins to the wire.
// D-67/D-68 widen the same alias with the reviewed block: the Summary tab renders it, and a pane that
// imported `../api` for one row and this module for the other would be two contracts in one component.
export type {
    PhraseBriefView,
    PhraseChosenSummary,
    PhraseDetailView,
    PhraseFindingRow,
    PhraseGroupRow,
    PhraseGroupScore,
    PhrasePlotpointsInput,
    PhraseReviewedGroup,
    PhraseReviewedSummary,
    PhraseReviewState,
    PhraseStartInput,
    PhraseView
};
// R1 — the one VALUE this module takes from the wire layer: the key the store files a group's lock refusal
// under. It is imported rather than re-typed here because `state.ts` writes that key and the pane reads it
// through this module; two spellings of one key is a refusal that never reaches the pane that raised it.
export { groupLockKey };

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
    /**
     * D-68 — the last refusal of THIS Story's Reviewed-Summary choose, the server's own sentence
     * (`state.ts:reviewedErrors`). It travels with the frame for the same reason `phraseError` does: the
     * store already shows refusals in its shell-wide line, but the Author standing on the Summary tab made
     * the choice THERE, and a 409 that names the three groups holding the clean selection is only useful
     * beside the control that raised it. Absent means no refusal — never "the choose succeeded".
     */
    reviewedError?: string | null;
    /**
     * R1 — the last refusal of each group's lock/unlock write, the server's own sentence, keyed
     * `<storyId>:<groupId>` (`state.ts:groupLockErrors`, threaded through `shell-binding.storyViewData`).
     *
     * The key carries the group because a lock is a decision about ONE row of the Summary: a refusal on Tone
     * must not be printed in Premise's pane, and the shell-wide line that `mutate` also commits is gone as soon
     * as anything else succeeds. Absent (or no entry for this group) means no refusal on the frame — which is
     * NOT the same claim as success: the pane's locked badge comes from the phrase read, never from this cache.
     */
    groupLockErrors?: Record<string, string>;
    /**
     * T-W4 — the PHRASE ② read (`GET /stories/:id/phrases/plotlines`), the chapter entries, the copied Seed's head
     * and the structure brief.
     *
     * WHY IT IS ITS OWN FIELD AND NOT `phrase`: `phrase` is the SUMMARY's read, and both surfaces can be lit in one
     * frame — the rail is on Phrase ② while the handoff line still reads the Summary's compiled state. Merging them
     * would make one read overwrite the other's rows. It is optional for the same reason `phrase` is: absent means
     * the caller has no Phrase ② surface (the read has not landed, or this frame never asked for it), which the
     * pane renders as its loading line rather than "no chapter entries".
     */
    phraseDetail?: PhraseDetailView | null;
    /**
     * T-W4 — the cached failure of THAT read, the server's own sentence (`state.ts:phraseDetailErrors`). It is kept
     * apart from `phraseError` because they are two routes: the Plotlines pane may not print the Summary read's 503
     * over the chapter entries, and a Phrase ② failure leaves the Summary surface current.
     */
    phraseDetailError?: string | null;
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
 * T3 — the Author's word for a finding's claim type: "Issue" or "Proposal".
 *
 * THE WIRE HAS THREE SPELLINGS AND THE UI HAS TWO WORDS. A row raised before the field existed carries
 * NOTHING, and both the server's default (`tools/utilities.ts:raiseFinding`'s `kind = 'issue'`) and the
 * legacy record mean the same thing: the Critic is claiming the text contradicts a commitment. A row that
 * claims the text could simply be BETTER — a word change, a new element, a twist linked up — is the other
 * type, and the token for it is mid-rename (`improvement` → `proposal`). So every findings surface reads
 * through THIS function rather than comparing tokens itself: a component that switched on `'proposal'`
 * would render a proposal as an Issue for as long as the older payload is what the desk is served, and the
 * whole point of the type is that the Author can tell the two kinds of work apart.
 *
 * It takes a bare `string | undefined` for exactly that reason — the shared `FindingKind` enum is the
 * server's and is changing under it, and an unknown token is treated as the default (Issue), never as a
 * crash and never as a proposal it was not told about.
 */
export function findingKindLabel(kind?: string): 'Issue' | 'Proposal' {
    return kind === 'proposal' || kind === 'improvement' ? 'Proposal' : 'Issue';
}

/**
 * The chip's style hook: the SAME two-value decision as {@link findingKindLabel}, in the lowercase form a
 * `data-kind` attribute and the stylesheet key on. Two exported functions rather than a `.toLowerCase()` at
 * each call site, so a surface cannot style a label its own text says differently.
 */
export function findingKindToken(kind?: string): 'issue' | 'proposal' {
    return findingKindLabel(kind) === 'Proposal' ? 'proposal' : 'issue';
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
    /**
     * R1 — the Author locks ONE SUMMARY GROUP in (`POST …/phrases/groups/:groupId/lock`). Locked content is
     * settled: the group stops being editable, its own findings are void, and the other groups adapt to the text
     * that now stands. The route addresses the group by its UUID like revise does, and refuses an unwritten
     * group and a group a live Writer holds — the same reads the pane disables its control off (R4).
     */
    lockPhraseGroup?: (storyId: string, groupId: string) => Promise<unknown> | unknown;
    /**
     * R1 — the Author opens a locked group again (`POST …/phrases/groups/:groupId/unlock`). The Editor may lock
     * a group when the Story's Setting is on, and it may never lift a lock: this verb is the Author's alone,
     * and it lifts a lock whichever of the two made it.
     */
    unlockPhraseGroup?: (storyId: string, groupId: string) => Promise<unknown> | unknown;
    /**
     * R2 — the Story's Editor-locking Setting (`PATCH /stories/:id` with `editor_group_locking`). OFF is the
     * default and the legacy state: with the Setting off, only the Author locks a group. With it on, the Editor
     * may commit one group's text on its own judgement over the CURRENT Critic findings for that group and the
     * Reader's score and rationale beside them — and only the Author unlocks.
     */
    setEditorGroupLocking?: (storyId: string, enabled: boolean) => Promise<unknown> | unknown;
    /**
     * T-W4 — the Story's Phrase ② dial (`PATCH /stories/:id` with `plotlines_mode`). `'classic'` is the default and
     * the legacy state: the §4.3 plotline tools own the contracts and the Plotlines pane shows their records. On
     * `'groups'`, the phrase materializes one chapter entry per chapter its brief declares and those entries become
     * the writable surface.
     *
     * THE DIAL CLOSES WHEN THE PHRASE STARTS. The Settings pane disables the control from `phrase_started.plotlines`
     * — the same projected flag the route's 409 is written from — and states the reason rather than letting the
     * Author click into a refusal (U-16).
     */
    setPlotlinesMode?: (storyId: string, mode: 'groups' | 'classic') => Promise<unknown> | unknown;
    /**
     * T-W4 — the Author STARTS Phrase ② (`POST /stories/:id/phrases/plotlines/start`), the handoff the Summary's
     * compiled Overview exists to make.
     *
     * `input` names the arm: `{source:'compiled'}` copies this Story's compiled Summary — the SAME text
     * `StoryView.summary_compiled` is computed from, so the enabled button and the route cannot disagree — and
     * `{source:'custom', text}` starts from the Author's own brief instead. The verb is not repeatable (D-72): the
     * copied Seed is what every entry, revision and claim key is written against, so a second start is 409 and the
     * pane shows the started state rather than a dead button.
     */
    startPhrase?: (
        storyId: string,
        phraseKey: string,
        input?: { source?: 'compiled' | 'custom'; text?: string }
    ) => Promise<unknown> | unknown;
    /**
     * R7 / R6 (W2) — the Author asks the Editor to PROOFREAD the Seed they are about to start on
     * (`POST /stories/:id/phrases/:key/seed/cleanup`, body `{ seed }`), and gets a PROPOSAL.
     *
     * IT STILL WRITES NOTHING, AND THE DESK HAS TO SAY SO: no Seed, no revision, no journal line. The pending Seed
     * has no row to read it from (the Start copies it, D-72), so the Author's draft is SENT and the answer rides
     * back as text the card can show — which is why it is not a run (P10: one tool-less turn, no work item, nothing
     * for the queue). R6 moved the draft out of the request line and into a BODY: a pasted brief is routinely
     * longer than a request target, and the ask used to die at HTTP 431 before the Editor read a word.
     *
     * THE CONFIRM IS THE NEXT PRESS. The card puts the proposal in the Seed box and the Author's next
     * `source:'custom'` press (or the create) carries it; `PhraseStartInput` grew no flag, so there is no path by
     * which a cleanup reaches the phrase without a press — which is the whole of AC3. THE SWITCH ABOVE THE ASK IS
     * THE OTHER HALF: with the Editor-cleanup switch off, this verb is never dialed and no model turn is spent.
     *
     * THE RETURN IS THE PROPOSAL, NOT A RESULT WRAPPER. `ok: true` carries `text` (+ `changed`), `ok: false`
     * carries `refusal` and NO `text`, and BOTH are 200s: a guard refusal is an answer, not a failure, and the
     * card prints `seedCleanupRefusalNotice(refusal)` inline rather than raising an error strip. `null` is the
     * one case that IS a failure — a 400/404/409 from the route, whose sentence `state.ts` has already committed
     * to the shell's error line (L-13) — and the card renders nothing, because there is no proposal to show.
     *
     * OPTIONAL like every verb here (U-16): an absent member means the shell has no such route, and the card
     * renders no cleanup control at all rather than a button that cannot be answered.
     */
    requestSeedCleanup?: (storyId: string, phraseKey: string, seed: string) => Promise<SeedCleanupProposal | null>;
    /**
     * T-W4 / R5 (W2) — the Author rewrites ONE CHAPTER ENTRY by hand. The route is the Summary group's revise; the
     * BODY is different, because a chapter entry's text is COMPOSED from its contract fields
     * (`PhrasePlotpointsInput` — the optional `heading`, the ORDERED `beats`, and the optional ORDERED `dialogue`):
     * the entry IS its beats, and the route 400s without at least one non-blank one (`contractListOf` drops the
     * blanks, so `['', ' ']` is no contract). The entry is addressed by its UUID, exactly as a Summary group is (U2).
     *
     * `revisePhraseGroup` above stays the Summary's verb and keeps its `{content, note}` body — the two writes are
     * two shapes on the wire, and one union-typed action would let a Summary pane send plotpoints by accident.
     */
    revisePhraseEntry?: (
        storyId: string,
        entryId: string,
        input: { plotpoints: PhrasePlotpointsInput; note?: string }
    ) => Promise<unknown> | unknown;
    /**
     * D-68 — the Author takes the REVIEWED Summary: the clean selection becomes the book in one commit
     * (five installs, every revision it passed over `discarded`, the choice recorded on the Phrase row).
     * This is the ONLY whole-Summary Author verb the group rail offers, and unlike `revisePhraseGroup` it
     * addresses no group — the choice is the Overview, so its only argument is the Story.
     *
     * The pane disables it off `reviewed.writer_busy` (the same read the route's 409 refuses with, R4) and
     * prints the refusal verbatim; `note` is the optional reason the route writes into the attribution line.
     */
    chooseReviewedSummary?: (storyId: string, note?: string) => Promise<unknown> | unknown;
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
     * Phase ①'s two counts: how many Writer samples one Summary gets, and how many Critics
     * critique each sample (D-17d/D-38a: the Author's settings, never engine constants).
     */
    setSummaryReview?: (storyId: string, sampling: number, critics: number) => Promise<unknown> | unknown;
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
// ("No Critic findings on this revision yet") and the lock ("1 critical/major finding still open")
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

/**
 * The Author's Critics-per-sample count (D-17d): the Story record's own setting when it carries one,
 * otherwise the server's projected default (`StoryView.vocabulary`). Both values arrive on the wire;
 * the UI keeps no copy of either.
 */
export const summaryCriticsOf = (view: Pick<StoryViewData, 'story' | 'vocabulary'>): number => {
    const raw = view.story.summary_critics;

    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 1) return Math.floor(raw);

    return view.vocabulary.summary_critics_default;
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
 * `summary_critics` in number, and a pass is answered once its claim key carries a non-live run.
 *
 * T11/F1 — THE DEFAULT IS OWED, NOT SILENT. `StoryView.runs` is a REQUIRED, uncapped projection
 * (`api.ts:StoryView`, `server/api/projections.ts`'s `runs:` line sends every row of the Story), so a
 * present slice that carries no `wi_review_` row for the winner is evidence of ONE thing: the sweep has
 * not dispatched the review yet, and all `summary_critics` passes are owed. Counting that case as zero
 * made a freshly selected revision look reviewed and let Accept light up over an unread Summary. The
 * count therefore walks the numbered passes `1..summaryCritics` and asks each one for its own key —
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

    const passes = summaryCriticsOf(view);
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
        // let a finding disable the Accept button while the opened revision read "No Critic findings on
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

    // U-16: the statement is the sentence under the control, printed while the Author is still deciding (and
    // reused verbatim as the confirm line), so it must say what THIS click does.
    //
    // WHY THE SUMMARY BRANCHES ON `isGroupSummary`: the leftover clauses (void findings / close tasks) and the
    // auto-start of Phrase 2 are what the GROUPED accept's server leg does (T12: void the phrase's open
    // findings, move its open tasks to `wontfix`, start Phrase ② from the compiled Summary — D-72). The
    // sampler's Summary has no such act on this desk — its Phrase ② start is the Author's own verb in
    // `PlotlinesHandoff` — so that book keeps the sentence it has always shown rather than being promised a
    // start this client cannot verify. Once the Summary is signed the accept has happened, so the line falls
    // back to what the lock itself did (P5, L-30, D-36).
    const summaryStatement =
        phase === 'summary' && story.summary_locked === false && isGroupSummary(view)
            ? summaryAcceptStatement(summaryAcceptLeftovers(view))
            : statements.summary;

    return {
        phase,
        canLock: reasons.length === 0,
        reasons,
        // The Summary is the only phase whose line is recomputed; ② and ③ keep their own sentences.
        statement: phase === 'summary' ? summaryStatement : statements[phase]
    };
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
// ARCHIVED IS ARCHIVED AWAY (U3), WITH ONE BODY SENT. `history` is newest-first and INCLUDES the
// `latest` row; the panes may count the `archived` rows, and the projection sends the prose of exactly
// the revision immediately before the latest (`previous_content`) so the group pane can diff the current
// text against it. Every older archived body stays server-side (`PhraseRevisionRow.chars`, not `.content`),
// so no pane may offer to open one.
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

// ---------------------------------------------------------------------------
// PHRASE ② — the Plotlines surface's reads (T-W4)
//
// THE SAME THREE RULES AS THE SUMMARY'S GROUP SECTION ABOVE, applied to the other phrase: identity is the group
// row's UUID, a phrase's mode is the Setting the server echoes (never derived from whether rows happen to exist),
// and a read that has not landed is a DIFFERENT sentence from a phrase with no rows. The reads below sit next to
// the Summary's because the panes are one shared pair (`PhraseEntries.tsx`), and a second copy of a rule for the
// second phrase is how two phrases start disagreeing about what `open` or `written` means.
// ---------------------------------------------------------------------------

/**
 * Whether this Story's Phrase ② is the CHAPTER-ENTRY model (`plotlines_mode:'groups'`), as the wire says.
 *
 * It mirrors `isGroupSummary` exactly, including the order of the two sources: the phrase detail's own `mode`
 * answers in the frame after the read lands, and `story.plotlines_mode` answers in the frame before it. Neither
 * may make a classic book look grouped — an absent `plotlines_mode` means `'classic'` (the projection echoes it
 * that way, and `phrase/catalog.ts:isPhraseGroupManaged` reads absent as classic), so a book whose Plotlines the
 * group loop never wrote keeps the §4.3 records view it has always had.
 */
export function isPlotlinesGroups(
    view: Pick<StoryViewData, 'story'> & Partial<Pick<StoryViewData, 'phraseDetail'>>
): boolean {
    const mode = view.phraseDetail?.mode;

    if (mode !== undefined) return mode === 'groups';

    return view.story.plotlines_mode === 'groups';
}

/** Whether the Phrase ② read has LANDED — the only thing that separates a load in flight from a phrase with no rows. */
export const phraseDetailReadLanded = (view: Pick<StoryViewData, 'phraseDetail'>): boolean =>
    view.phraseDetail !== undefined && view.phraseDetail !== null;

/** The cached failure sentence for the Phrase ② read; `undefined` when that read has not failed. */
export const phraseDetailReadError = (view: Pick<StoryViewData, 'phraseDetailError'>): string | undefined =>
    view.phraseDetailError ?? undefined;

/**
 * The chapter entries in composition order — the same sort `phraseGroups` applies, so the Plotlines rail, the
 * phrase overview and the phase gate cannot order the chapters three ways. `[]` for a classic book and for a read
 * that has not landed; only `phraseDetailReadLanded` may tell those two states apart.
 */
export function plotlinesEntries(view: Pick<StoryViewData, 'phraseDetail' | 'story'>): PhraseGroupRow[] {
    if (!isPlotlinesGroups(view)) return [];

    return [...(view.phraseDetail?.groups ?? [])].sort(
        (left, right) => left.order - right.order || left.key.localeCompare(right.key) || left.id.localeCompare(right.id)
    );
}

/** One chapter entry by its UUID — the address the rail's selection ref carries (U2, same rule as a Summary group). */
export function plotlinesEntryById(
    view: Pick<StoryViewData, 'phraseDetail' | 'story'>,
    entryId: string | undefined
): PhraseGroupRow | undefined {
    if (entryId === undefined) return undefined;

    return plotlinesEntries(view).find((entry) => entry.id === entryId);
}

/** The Phrase ② structure brief, or null for a phrase nobody structured (the wire's own null, never a placeholder). */
export const plotlinesBrief = (view: Pick<StoryViewData, 'phraseDetail'>): PhraseBriefView | null =>
    view.phraseDetail?.brief ?? null;

/**
 * The Phrase ② entries with NO contract installed yet — the same derivation `unwrittenGroups` applies to the
 * Summary's five groups (`revision: 0` is the loop's own "never written" line, R1), so both phrases answer
 * "which rows are still empty" from one rule.
 *
 * It is the honest sentence for a phrase whose brief was accepted but whose entries are still blank: the rows
 * EXIST, and saying "0 of 3 chapter entries written" without naming them would read like an empty phrase rather
 * than a queue the loop has not started work on.
 */
export function unwrittenPlotlinesEntries(
    view: Pick<StoryViewData, 'phraseDetail' | 'story'>
): PhraseGroupRow[] {
    return plotlinesEntries(view).filter((entry) => !isGroupWritten(entry));
}

/** Has Phrase ② been started? `story.phrase_started.plotlines`, the projection's read of the phrase row. */
export const plotlinesStarted = (view: Pick<StoryViewData, 'phrase_started'>): boolean =>
    view.phrase_started?.plotlines === true;

// ---------------------------------------------------------------------------
// R5 (W2) — THE CHAPTER CONTRACT, AS TWO ORDERED LISTS
//
// WHY THESE HELPERS EXIST CLIENT-SIDE AT ALL. The contract is `heading` + ordered `beats` + optional ordered
// `dialogue` (`phrase/plotpoints.ts:PlotpointFields`); the ENTRY's text and the §4.3 `plotlines` row are both
// DERIVED from it (`chapterEntryContent`), and the per-phrase read carries the derived text (`PhraseGroupRow.content`),
// not the fields. So the desk needs the field reading in two places: rendering a §4.3 row, and prefilling the
// Author's beat editor from the entry text it was given. Both go through the ONE pair of functions below, which are
// the client mirrors of the server's own, so a pane and a route cannot tell two stories about one contract
// (L-14: the dashboard recomputes nothing the engine already answered — this is decoding a wire field, not
// re-deriving a verdict).
//
// THE LEGACY PROSE IS COMPATIBILITY, NOT A SECOND TRUTH. `must_happen`/`must_change`/`pov`/`setups`/`payoffs` are
// deprecated on the row (`shared/types.ts:Plotline`), and NOTHING in the current generation writes them; the only
// reading left is the recovery below, which is the same rule `plotlineBeatsOf` states server-side. So the desk has
// no "Must happen"/"Must change"/"POV"/"Setups"/"Payoffs" labels any more: a legacy chapter reads as the beats it
// carries, which is what the criteria engine checks it against (C-7, and C-3/C-8 against the LAST beat).
// ---------------------------------------------------------------------------

/**
 * The one list cleaner, and the client mirror of `phrase/plotpoints.ts:contractListOf`: trim each item, drop the
 * blanks, KEEP THE ORDER. Order is the content (the beats are chronological), so a cleaner that sorted or
 * deduplicated them would be editing the contract on the way to the screen.
 */
export function contractListOf(value: unknown): string[] {
    if (!Array.isArray(value)) return [];

    return value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item !== '');
}

/**
 * THE ONE COMPATIBILITY READ — a stored contract's beats, whichever generation wrote the row.
 *
 * The rules, in the server's own order (`phrase/plotpoints.ts:plotlineBeatsOf`):
 *   1. `beats`, cleaned through {@link contractListOf}, wins when it is non-empty — a row written by the current
 *      generation never falls back, so a half-mirrored install cannot be shadowed by older prose on the same row;
 *   2. otherwise the legacy `must_happen` prose is RECOVERED as beats — split on newlines and on `;` (the two ways
 *      an old answer listed several events in one block), trimmed, blanks dropped. A one-sentence `must_happen`
 *      comes back as ONE beat, which is the honest answer, not a parsed list;
 *   3. otherwise `[]`, and each surface states its own "no contract" line rather than showing an empty list.
 *
 * `must_change`/`pov`/`setups`/`payoffs` are NOT folded in: the last beat already carries the "what is different"
 * rule (C-3/C-8), POV is not a contract field, and the ledger (C-5/C-6) was always the real source of the setups
 * check. They stay on the row as data; the desk reads nothing from them.
 */
export function plotlineBeatsOf(plotline: Plotline | undefined): string[] {
    if (plotline === undefined) return [];

    const beats = contractListOf(plotline.beats);

    if (beats.length > 0) return beats;

    // LEGACY ROW — the deprecated `must_happen` prose is the only statement this chapter's contract ever made, and
    // the split rules are the server's: an old answer listed several events either one per line or `;`-separated.
    const legacy = typeof plotline.must_happen === 'string' ? plotline.must_happen : '';

    return contractListOf(legacy.split(/[\n;]+/));
}

/**
 * A §4.3 row's required DIALOGUE, cleaned the same way the beats are (R5).
 *
 * There is no legacy arm here on purpose: dialogue is a new field, so an absent key and an empty list are the same
 * fact — the chapter owes no lines — and the surfaces render nothing rather than a blank row.
 */
export function plotlineDialogueOf(plotline: Plotline | undefined): string[] {
    if (plotline === undefined) return [];

    return contractListOf(plotline.dialogue);
}

/** One row of the Author's contract editor: the heading, the ORDERED beats, and the ORDERED dialogue. */
export interface ChapterEntryDraft {
    heading: string;
    beats: string[];
    dialogue: string[];
}

/** The block labels `chapterEntryContent` composes with, spelled ONCE so parse and render cannot drift. */
const ENTRY_HEADING_LABEL = 'Heading:';
const ENTRY_BEATS_LABEL = 'Beats:';
const ENTRY_DIALOGUE_LABEL = 'Important dialogue:';

/**
 * The contract FIELDS a chapter entry's stored text was composed from — the inverse of
 * `phrase/plotpoints.ts:chapterEntryContent`, and the reason the Author's beat editor can open PREFILLED.
 *
 * WHY PARSE THE TEXT INSTEAD OF READING FIELDS OFF THE ROW: the per-phrase read answers `PhraseGroupRow.content`
 * (the composed prose) and no field list, so the fields are only recoverable from the text the route composed. The
 * shapes are fixed by the server's own composer — `Heading: …`, then `Beats:` with `- ` items, then `Important
 * dialogue:` with `- ` items, blocks joined by a blank-free newline — so this is a decoding of a known format, not
 * a guess at prose.
 *
 * WHAT AN UNRECOGNISED TEXT MEANS (the legacy generation, or a row written before beats existed): the entry's text
 * is not thrown away and is not silently re-flowed — it comes back as ONE beat, exactly as `plotlineBeatsOf`
 * recovers a one-sentence `must_happen` into one beat. The Author sees their contract as one row, edits it into
 * ordered beats, and the send writes the current shape. A prefill that dropped the text would be a write the
 * Author did not make.
 */
export function chapterEntryDraft(content: string | undefined): ChapterEntryDraft {
    const draft: ChapterEntryDraft = { heading: '', beats: [], dialogue: [] };
    const text = typeof content === 'string' ? content : '';

    if (text.trim() === '') return draft;

    const lines = text.split('\n');
    // WHICH LIST the `- ` items belong to. `none` covers the heading line and anything before a known label, which
    // is what makes a legacy block fall through to the single-beat rule below rather than into the beat list.
    let section: 'none' | 'beats' | 'dialogue' = 'none';
    let recognised = false;

    for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed === '') continue;

        if (trimmed.startsWith(ENTRY_HEADING_LABEL)) {
            draft.heading = trimmed.slice(ENTRY_HEADING_LABEL.length).trim();
            recognised = true;
            continue;
        }
        if (trimmed === ENTRY_BEATS_LABEL) {
            section = 'beats';
            recognised = true;
            continue;
        }
        if (trimmed === ENTRY_DIALOGUE_LABEL) {
            section = 'dialogue';
            recognised = true;
            continue;
        }

        if (section === 'none') continue;

        // A bullet in the current section. The item text keeps its own inner punctuation; only the leading `- `
        // (or a bare `-`) is the label, and an item that is only whitespace is dropped by `contractListOf`'s rules.
        const item = trimmed.startsWith('-') ? trimmed.slice(1).trim() : trimmed;

        if (item === '') continue;

        if (section === 'beats') draft.beats.push(item);
        else draft.dialogue.push(item);
    }

    if (!recognised || draft.beats.length === 0) {
        // NOT A COMPOSED CONTRACT BLOCK. The text IS the contract as the previous generation wrote it, so it
        // recovers as beats through the same rule §4.3 rows use — including the `;` split, because an old
        // `must_happen` listed events that way — and an empty result leaves the editor open with one blank row.
        draft.beats = contractListOf(text.split(/[\n;]+/).map((line) => line.replace(/^-\s*/, '')));
        draft.dialogue = [];
    }

    return draft;
}

// ---------------------------------------------------------------------------
// R4 (W2) — THE CHAPTER COUNT AT THE CREATE
//
// THE INPUT IS OPTIONAL, AND OPTIONAL HAS THREE MEANINGS ON THE WIRE, so the form needs one rule with one set of
// tests rather than a `Number(value)` inlined in a submit handler:
//   · blank      → the key is OMITTED, and the row records `chapter_count_request: null` — "the Editor decides";
//   · a whole number ≥ 1 → the declaration, sent as `chapter_count` (the route validates an integer ≥ 1, and the
//     form refuses anything else BEFORE dialing so the Author reads a sentence instead of a 400);
//   · anything else (`0`, `1.5`, `seven`, a negative) → a refusal. `0` in particular is the accidental sentinel:
//     it is a number a caller could compute by accident, and the server refuses it because "no chapters" is not a
//     count the loop can honor.
// ---------------------------------------------------------------------------

/** Why the create's chapter-count box is refused, `''` when the value may be sent (or is blank, which sends nothing). */
export function chapterCountInputRefusal(value: string): string {
    const text = value.trim();

    if (text === '') return '';

    const count = Number(text);

    if (!Number.isFinite(count) || !Number.isInteger(count))
        return 'A chapter count is a whole number of chapters — a count the Editor has to honor cannot be a fraction or a word (D-3b).';

    if (count < 1)
        return 'A chapter count of 0 asks for a book with no chapters. Leave the box empty to let the Editor decide (D-3b), or name a number from 1 up.';

    return '';
}

// ---------------------------------------------------------------------------
// R4 (W2) — THE CHAPTER COUNT THE AUTHOR ACTUALLY DECLARED
//
// THREE STATES ON THE WIRE, AND THE DESK HAS TO SAY WHICH ONE IT IS LOOKING AT
// (`shared/types.ts:Story.chapter_count_request`, mirrored at `types.ts:Story`):
//   · a NUMBER — the Author declared it at the create, and the honor-the-request check reads that number;
//   · `null`   — "the Editor decides", an explicit answer rather than a missing one;
//   · ABSENT   — legacy. A book written before the field keeps the behaviour it always had (R6's no-migration
//     rule), and the desk may not read its working count back as a request the Author never made.
//
// WHY THIS IS A FUNCTION AND NOT JSX IN A PANE. `summaries.chapter_count` — the number the loop counts against,
// and what C-0 fails on — is a DIFFERENT fact from the declaration, and the actual default (1) is the value a pane
// reaches for by accident. A pane that printed `The book's measure: 1 chapter` under a heading of "your chapter
// count" told an Author they had asked for one when they had asked for nothing. The sentence lives here so the
// three states are one rule with one set of tests, and every surface that quotes a count quotes the same reading.
// ---------------------------------------------------------------------------

/**
 * The honest sentence about a Story's chapter-count DECLARATION, beside the count the book actually runs on.
 *
 * `runningCount` is `summaries.chapter_count` (D-3b's Author-truth mirror) and is optional because a book can exist
 * with no Summary row yet — an absent Summary is a state to name, not a zero to print.
 */
export function chapterCountRequestLine(
    story: Pick<Story, 'chapter_count_request'>,
    runningCount: number | undefined
): string {
    const declared = story.chapter_count_request;
    // WHAT THE BOOK COUNTS AGAINST. C-0's number, stated once per branch, because it is the fact an Author compares
    // their own declaration against — and it is NOT a restatement of the declaration (`acceptPlotlineBrief` is the
    // only writer in the phrase pipeline, so an accepted brief moves it without touching the request).
    const running =
        runningCount === undefined
            ? 'This Story has no Summary row yet, so no count is being checked against anything (D-3b).'
            : `The number the book counts against is ${runningCount}, and C-0 fails on any other count (D-3b).`;

    if (typeof declared === 'number') {
        return (
            `You asked for ${declared} ${declared === 1 ? 'chapter' : 'chapters'} — a declared count is Author truth, ` +
            `and nothing downstream may disagree with it silently (D-3b). ${running}`
        );
    }

    if (declared === null) {
        return (
            'You left the chapter count to the Editor: “you choose” was the answer you gave at the create, and that ' +
            `suppresses the old default rather than falling back to it (D-3b). ${running}`
        );
    }

    // ABSENT — and the one claim this branch must not make is that the running number is what the Author asked for.
    return (
        'No chapter count was recorded on this book — it was written before the create asked, so the number below is ' +
        `what the Story runs on, not a number you named (D-3b). ${running}`
    );
}

/**
 * The chapter entry's text as the SERVER composes it — the client mirror of
 * `phrase/plotpoints.ts:chapterEntryContent`, kept for the surfaces that render a contract from FIELDS rather than
 * from the row's stored text (a revision body carrying `plotpoints`, and the entry's own preview while the Author
 * is editing).
 *
 * The rules are the composer's and not a style choice: a blank heading emits nothing, a beat list of `['']` emits
 * nothing (no items survive `contractListOf`), and an empty dialogue section is omitted rather than printed with no
 * lines under it.
 */
export function chapterEntryText(fields: { heading?: string; beats?: unknown; dialogue?: unknown }): string {
    const heading = typeof fields.heading === 'string' ? fields.heading.trim() : '';
    const beats = contractListOf(fields.beats);
    const dialogue = contractListOf(fields.dialogue);
    const blocks: string[] = [];

    if (heading !== '') blocks.push(`${ENTRY_HEADING_LABEL} ${heading}`);
    if (beats.length > 0) blocks.push([ENTRY_BEATS_LABEL, ...beats.map((beat) => `- ${beat}`)].join('\n'));
    if (dialogue.length > 0)
        blocks.push([ENTRY_DIALOGUE_LABEL, ...dialogue.map((line) => `- ${line}`)].join('\n'));

    return blocks.join('\n');
}

/** Has Phrase ① been started? Always true for a book the loop wrote — Phrase ① is not an on-demand phrase. */
export const summaryPhraseStarted = (view: Pick<StoryViewData, 'phrase_started'>): boolean =>
    view.phrase_started?.summary === true;

/**
 * Does this Story have a compiled Summary to hand to Phrase ②?
 *
 * THE BUTTON AND THE ROUTE ARE ONE FACT. `story.summary_compiled` is computed server-side from
 * `projections.ts:compiledSummaryOf` — the same read the start route copies its Seed from — so a disabled handoff
 * control and a 409 saying "no compiled Summary" can never disagree, and this file does not re-derive the answer
 * from the group rows (L-14: the dashboard recomputes nothing the engine already answered).
 */
export const summaryIsCompiled = (view: Pick<StoryViewData, 'summary_compiled'>): boolean =>
    view.summary_compiled === true;

/**
 * Why the "start Phrase ② from the compiled Summary" control is shut, `''` when it is not.
 *
 * THREE STATES, IN THE ORDER THE AUTHOR MEETS THEM, and every one is a projected fact rather than a guess:
 *   1. the phrase already started — the copied Seed is what every entry and claim key was written against, so the
 *      verb is not repeatable (D-72). The pane shows the started state rather than a dead button;
 *   2. there is no compiled Summary yet — the route would 409, and the sentence says what to do instead;
 *   3. the shell has no verb bound — a pane rendered without a store.
 * The empty string means enabled, which is the same convention `reviewedChooseRefusal` uses.
 */
export function plotlinesHandoffRefusal(
    view: StoryViewData,
    hasAction: boolean
): string {
    if (!hasAction) return 'The phrase start route is not available in this shell.';
    if (plotlinesStarted(view))
        return 'Phrase 2 has already started on this Story: its copied Seed is the text every chapter entry, revision and claim key was written against, so a new Seed means a new Story rather than a re-start (D-72).';
    if (!summaryIsCompiled(view))
        return 'There is no compiled Summary to start Phrase 2 from yet — the Overview (or the reviewed Summary) is the text the phrase copies, so the gate is above this control (R5).';

    return '';
}

/**
 * Why the "start Phrase ② from the Author's OWN text" control is shut, `''` when it is not.
 *
 * THIS IS NOT `plotlinesHandoffRefusal` WITHOUT ITS MIDDLE CLAUSE, and the difference is the whole point
 * (R7, this wave). That function answers for the COMPILED arm, whose Seed is text this Story does not have
 * yet; the custom arm's Seed is the paragraph in the Author's hand, and the route says so — `routes.ts`
 * checks `custom` with no text (400) BEFORE it asks whether anything is compiled (the 409), so a non-empty
 * `custom` start is accepted on a book whose Summary was never written. Pinning that arm to
 * `summary_compiled` was the desk blocking a move the server allows: an Author with a summary ready of their
 * own had to run Phrase ① to start Phrase ②. Only two facts gate it, and both are still projected rather
 * than guessed: the shell must have the verb (U-16), and the phrase must not already have started (D-72 —
 * the copied Seed is what every entry, revision and claim key was written against, so a second start is the
 * 409 no control should offer).
 */
export function plotlinesCustomStartRefusal(
    view: Pick<StoryViewData, 'phrase_started'>,
    hasAction: boolean
): string {
    if (!hasAction) return 'The phrase start route is not available in this shell.';
    if (plotlinesStarted(view))
        return 'Phrase 2 has already started on this Story: its copied Seed is the text every chapter entry, revision and claim key was written against, so a new Seed means a new Story rather than a re-start (D-72).';

    return '';
}

/**
 * The sentence the card prints when the COMPILED arm is shut and the CUSTOM arm is open — `''` when there is
 * nothing to explain because both arms are live.
 *
 * WHY A SEPARATE SENTENCE INSTEAD OF RELAXING THE REFUSAL. The compiled arm's refusal is still true and the
 * Author still needs it (that button is genuinely shut, and U-16 says a shut control says why); what was
 * missing is the other half of the fact — the card is not blocked, only that one arm is. Two sentences, each
 * about the control it describes, is the honest shape; folding them would make the compiled arm look
 * optional when it is the default.
 *
 * THE CREW CLAUSE IS THE ROUTE'S, NOT THIS FILE'S OPINION. Starting a phrase moves the phase pointer only
 * when phase ① is already signed off (`routes.ts:openPlotlinesOnSignedOffSummary`, L-33), so the sentence
 * reads off `story.summary_locked` and reuses the Start receipt's own wording. That is R7's recorded
 * decision in one line: an Author may start Phrase ② on their own text at any time, and the crew does not
 * retarget onto it until they sign Phrase ① off.
 */
export function plotlinesCustomStartNotice(
    view: Pick<StoryViewData, 'story' | 'summary_compiled'>,
    hasAction: boolean
): string {
    // TWO PRECONDITIONS, both about whether the sentence would be TRUE. A compiled Summary means the compiled arm
    // is live and there is nothing to explain; no verb means NEITHER arm is live, and a line claiming
    // "“Start from your own brief” is open" above a card that renders no such button is the lie U-16 refuses —
    // that case already has its own sentence from `plotlinesHandoffRefusal`'s first clause.
    if (!hasAction || summaryIsCompiled(view)) return '';

    // THE CREW CLAUSE, capitalized because it stands as its own sentence here while the route states it mid-line.
    const phaseClause =
        view.story.summary_locked === false
            ? `The Summary is not signed off, so the crew stays on Phrase ①: POST /stories/${view.story.id}/lock is the act that signs phase summary off and opens phase plotlines (L-33: a phase is entered only with every earlier phase locked)`
            : `This Summary is signed off, so starting Phrase 2 also moves the crew into Phase 2 (the pointer follows a start only when phase ① is locked, L-33)`;

    return (
        'There is no compiled Summary to copy yet, so the compiled arm stays shut — “Start from your own brief” is open, ' +
        `and the text you write there is the Seed the phrase copies (the Start verb takes \`source: custom\` without a compiled Summary, R5 / D-76). ${phaseClause}.`
    );
}

/**
 * The custom-seed arm's own refusal: `''` when the Author has typed a Seed worth starting on.
 *
 * THE ROUTE'S 400 IS THE SHAPE OF THIS RULE (`routes.ts:PhraseStartBody`): a `'custom'` start with an empty (or
 * whitespace-only) `text` is refused, because the copied Seed is the one text every entry, revision and claim key
 * is written against — starting a phrase on an empty brief would leave a phrase with nothing to write FROM. The
 * control states that reason instead of sending a request the server will answer with a sentence.
 */
export const customSeedRefusal = (text: string): string =>
    text.trim().length === 0
        ? 'Write the Seed first — a custom start copies what you type into the phrase, and an empty Seed leaves Phrase 2 with nothing to write from (the route refuses it).'
        : '';

// ---------------------------------------------------------------------------
// R7 — the one-time Seed cleanup, in the desk's own words
//
// WHY THESE SENTENCES LIVE HERE AND NOT IN THE CARD: each one is a spec rule about a wire state
// (`SeedCleanupProposal`'s two arms, `SeedCleanupRefusal`'s four codes), and a rule that is a function of the
// wire can be pinned without a DOM — the same reason `plotlinesCustomStartRefusal` is here. The card decides
// WHICH sentence to print; this file decides what each state SAYS, so the four refusals cannot quietly become
// one shrug.
//
// WHY "YOUR OWN TEXT STANDS" APPEARS IN EVERY REFUSAL: a guard refusal is a 200 answer with no `text`, so the
// desk has no proposal to carry into the Start press — the Author's draft is what the next press copies, and
// the sentence has to say that rather than leave "the Editor declined" to be read as "your text was rejected"
// (AC3). None of them is an error strip: the request succeeded.
// ---------------------------------------------------------------------------

/**
 * Why the "ask the Editor to proofread this" control is shut, `''` when it is live.
 *
 * TWO FACTS, and neither is a gate the Start verb does not have: the shell must have the verb (U-16), and the box
 * must hold the draft the pass would read — the route 400s a blank `seed` rather than spend a model call on an
 * answer it already knows (`routes.ts:POST …/seed/cleanup`). `summary_compiled` is NOT in this list, on purpose:
 * the cleanup belongs to the arm whose Seed is text this Story does not need to have — the Author's own draft.
 *
 * R6 (W2) — AND THERE IS NO LENGTH RULE ANY MORE. The desk used to refuse a draft whose ESCAPED form passed about
 * 12,000 characters, because the ask was a GET and the draft rode in the request line the listener parses (F4's
 * measured 431 ceiling). The proofread is a POST with the draft in a BODY now
 * (`api.ts:requestPhraseSeedCleanup` / `requestSeedCleanupDraft`), which has no such ceiling — and a pasted synopsis
 * is exactly the text that used to run into it, so the rule refused the ask at the moment the proofread mattered
 * most. A long brief is therefore askable, and nothing tells the Author to paste "a chapter or two at a time".
 */
export function seedCleanupAskRefusal(text: string, hasAction: boolean): string {
    if (!hasAction) return 'This shell has no Editor proofread route wired, so there is nothing to ask.';
    if (text.trim().length === 0)
        return 'Write your brief first — the proofread reads the text in this box, and there is nothing to correct yet.';

    return '';
}

/**
 * What the Editor's guard answered, in the desk's words: the rewrite came back and a rule threw it away, so
 * there is no proposal and the Author's own draft stands. Each clause names WHICH rule, because "the Editor
 * declined" is not a fact an Author can act on (L-13).
 *
 * THE OPTIONAL `blocker` WINS THE SENTENCE (server W4/R6). A `blocker` ride-along means the `refusal` code was
 * produced by the SERVER, not by the Author's draft or the model's answer: `src/templates/seed-cleanup.md` is
 * refused, so the pass never ran and spent no call. Printing the code's own line there ("the Editor answered with
 * nothing usable") tells the Author their brief was unreadable when the unreadable file is the server's, and the
 * blocker string already names it — the loader's own sentence, file and rule — so the desk quotes it rather than
 * paraphrasing it into a second opinion (L-13). Absent `blocker` is the ordinary guard refusal, byte-identical to
 * what this function printed before the field existed.
 */
export function seedCleanupRefusalNotice(refusal: SeedCleanupRefusal, blocker?: string): string {
    // TRIMMED, because the sentence is composed into a paragraph and a padded loader line would read as a typo.
    if (typeof blocker === 'string' && blocker.trim().length > 0) {
        return `The Editor never got to read your brief — the server could not use its own proofreading instructions: ${blocker.trim()}. Nothing was written, and your own text stands exactly as the create or the Start copies it (R7).`;
    }

    switch (refusal) {
        // The provider returned nothing usable, so there is no text to weigh at all.
        case 'empty_answer':
            return 'The Editor answered with nothing usable, so there is no proposal — your own text stands, and nothing was written (R7).';
        // THE ONE THE AUTHOR WOULD OTHERWISE NOT NOTICE: a rewrite that drops a digit has changed the brief's
        // facts, not just its grammar, which is exactly why the guard runs before the Author is offered anything.
        case 'numbers_lost':
            return 'The rewrite dropped a number you wrote — a chapter count, a deadline, an age — so the Editor threw it away rather than proofread your facts away. Your own text stands (R7).';
        // A shorter answer summarised; a longer one expanded. Neither is a proofread, and the Start copies a Seed,
        // not a synopsis.
        case 'too_short':
            return 'The rewrite came back shorter than your brief, so it was summarising rather than correcting — there is no proposal, and your own text stands (R7).';
        case 'too_long':
            return 'The rewrite came back longer than your brief, so it was expanding rather than correcting — there is no proposal, and your own text stands (R7).';
    }
}

/**
 * The line under a PROPOSAL. It has to say out loud that nothing is written yet, because the card is showing the
 * Author a better sentence than the one they typed, and the natural reading of a highlighted suggestion in every
 * other editor is "this has been applied". Here it has not: the confirm is the Start press itself, and that press
 * copies whatever is in the box (R7 / D-72).
 */
export const SEED_CLEANUP_PROPOSAL_NOTE =
    'Nothing has changed yet. This is the Editor’s proofread of the brief above — grammar, spelling, punctuation and typos, nothing else — and the only act that records it is your next “Start Phrase 2 from this Seed” press, which copies the text now in the box (R7 / D-72).';

/** The `changed: false` answer: the pass read the draft and had nothing to correct. Not a failure, and no confirm needed. */
export const SEED_CLEANUP_NOTHING_TO_FIX =
    'The Editor read your brief and found nothing to fix — its grammar is already clean. Nothing was written, and the Start press copies your text exactly as it stands.';

/**
 * The line after "Use this text". It has to exist, because the box changed and an Author who watched a box change
 * reasonably assumes something was recorded: this says what did NOT happen (nothing) and which press does the
 * recording (R7 / D-72).
 */
export const SEED_CLEANUP_APPLIED_NOTE =
    'The box now holds the Editor’s version. Nothing has been recorded yet — the next “Start Phrase 2 from this Seed” press is the act that copies it into the phrase, and it copies exactly the text you can read here (R7 / D-72).';

/**
 * R12 — WHAT THE STARTED RECEIPT CALLS THE COPIED SEED, in the three words that are true for each provenance.
 *
 * THE SENTENCE USED TO CLAIM THE SUMMARY. "Its Seed is N characters of the Summary the crew compiled" was written
 * when the compiled arm was the only arm, and it stayed after the custom arm landed — so an Author who started on
 * their own brief was told the crew had written their Seed, which is the reverse of the fact. R12 put
 * `seed_source` on the row and on the read, so the receipt can now say which of the two it is.
 *
 * ABSENT MEANS UNKNOWN, AND THE SENTENCE SAYS THAT RATHER THAN PICKING A SIDE. A phrase row written before the
 * field existed carries a Seed and no word about its origin (`projections.ts` OMITS the key instead of sending
 * `null`, and R6 forbids migrating the row to guess). Choosing `compiled` there would be the desk inventing a
 * crew for text the Author may well have typed.
 */
export function plotlinesSeedOrigin(seedSource?: 'custom' | 'compiled'): string {
    if (seedSource === 'compiled') return 'the Summary the crew compiled';
    if (seedSource === 'custom') return 'the brief you wrote and started on';

    return 'text whose origin this desk never recorded — the phrase started before the Seed’s provenance was kept';
}

/**
 * T-W4 — the phrase-swap view the SHARED panes render Phrase ② through.
 *
 * WHY A SWAP AND NOT A SECOND SET OF SELECTORS: every phrase selector in this file resolves its rows through
 * `view.phrase` (`phraseGroups`, `groupOpenFindings`, `groupLockError`, the score marks), and the Phrase ② read is
 * the SAME shape with different rows. Copying those selectors for the second phrase would be two rules per rule —
 * and the two would drift the first time a finding-scoping fix landed in one and not the other. So this helper
 * hands the pane a view whose `phrase` slot holds the Phrase ② read (and whose `phraseError` is that read's own
 * failure, never the Summary's), and the selectors need no branch because they are reading the right rows already.
 *
 * It is a shallow copy on purpose: the Story row, the findings, the runs and the Goal are Story-level facts that
 * belong to both phrases, and the entries are the phrase's.
 */
export function plotlinesSurfaceView(view: StoryViewData): StoryViewData {
    return {
        ...view,
        // The two wire types differ in exactly the two places this file already handles separately: `mode` (the
        // detail's is `PhraseMode`, whose off word is `classic`) and `review.mirror` (the Summary's legacy prose
        // check, absent on Phrase ②). Nothing the swapped view is used for reads either one — the caller has
        // already decided the mode (`isPlotlinesGroups`) and the shared panes read rows, findings and install
        // metadata — so the cast states the swap rather than hiding one, and `classic` cannot reach `isGroupSummary`
        // through it: that predicate answers false on an unknown word, which is the honest answer.
        phrase: (view.phraseDetail ?? null) as StoryViewData['phrase'],
        phraseError: view.phraseDetailError ?? null
    };
}

/** The Plotlines dial's own words on the Settings pane (T-W4), next to the Editor-locking switch (R2). */
export const PLOTLINE_MODE_LABEL = 'Phrase 2 — chapter entries (the grouped Plotlines pipeline)';

/** What the Phrase ② dial does, and what closing it means, in the two sentences the Author needs. */
export const PLOTLINE_MODE_NOTE =
    "On, the Plotlines phrase writes one chapter entry per chapter its brief declares, and those entries are the surface you revise. Off (the default, and every Story written before Phrase 2), the classic §4.3 plotline tools own the contracts and the Plotlines pane shows their records. The dial closes the moment the phrase starts: the entries and the brief were written against the mode that produced them, so switching it afterwards would leave rows the new mode cannot explain.";

/**
 * The Phrase ② dial's reason for being shut, `''` when it is live.
 *
 * TWO REFUSALS, and the order is the one the Author meets: the phrase started (a started phrase's entries and brief
 * were written against the mode that produced them — the route 409s, and the Settings pane refuses from the SAME
 * projected flag rather than making the Author discover it by clicking), or the shell has no verb bound (U-16's
 * standing rule: a shut control says which route is missing).
 */
export function plotlinesModeRefusal(view: StoryViewData, hasAction: boolean): string {
    if (!hasAction) return 'The Story settings route is not available in this shell, so the Setting cannot be changed.';
    if (plotlinesStarted(view))
        return 'Phrase 2 has started on this Story: its Seed, its brief and its chapter entries were written against the mode that produced them, so the dial closed with the start — switching it now would leave rows the new mode cannot explain.';

    return '';
}

/**
 * The dial's own `title`: why it is shut, or what the NEXT click does. It states the direction of the write
 * (`checked` is the Setting's state, not local state), so the hover matches the body the `PATCH` will carry.
 */
export function plotlinesModeTitle(story: Story, refusal: string, nextOn: boolean): string {
    if (refusal !== '') return refusal;

    return nextOn
        ? 'Turn Phrase 2 onto the chapter-entry pipeline: the Plotlines phrase writes one entry per chapter its brief declares, and those entries are what you revise.'
        : `Turn Phrase 2 back to the classic plotline tools: the Plotlines pane goes back to the §4.3 records, and no chapter entries are written for this Story.`;
}

/** Is the Phrase ② dial on? `story.plotlines_mode`, where absent means classic (the projection's own default). */
export const isPlotlinesGroupsEnabled = (story: Story): boolean => story.plotlines_mode === 'groups';

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

/**
 * A finding is open while it is not settled: R6's own open set, mirror of `projections.ts`'s filter, and the
 * band `review.open_findings` counts. NOT the set the accept voids — that one also takes `disputed`
 * ({@link ACCEPT_VOIDED_FINDING_STATES}), because a lock retires an unproven claim rather than gating work on it.
 */
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
 * The open findings on this group that sit at the Summary's own COST bar (`summaryBlockingCost`, dial
 * included), so the badge, the pane and the rail cannot disagree about which rows are the critical/major
 * band. D-78 — the band is what the Reviewer weighs and what the row's `blocking` word names; it is no longer
 * a wait for the sign-off, which is why every surface that prints this number names the band rather than a
 * hold.
 */
export function groupBlockingFindings(view: StoryViewData, groupId: string): PhraseFindingRow[] {
    return groupOpenFindings(view, groupId).filter((finding) => summaryBlockingCost(view.story, finding.cost));
}

/**
 * THE QUEUE SET THE DESK MIRRORS — `projections.ts:OPEN_TASK_STATES` (`open`/`claimed`/`blocked`), the wire's
 * own constant, which `phraseProjection`'s `openTasks` filters the phrase read's `tasks` rows and
 * `review.open_tasks` by. It is the number the Overview's review line prints as "N open tasks".
 *
 * THE SERVER RUNS A SECOND, NARROWER SET, and the difference between the two is now the whole content of the
 * accept's sentence: `loop/types.ts:OPEN_TASK_STATES` (`open`/`claimed`) is what the engine dispatches
 * (`loop/records.ts:openTasks`) and therefore what the accept moves to `wontfix`
 * (`loop/records.ts:wontfixTasks`). A `blocked` row is in the queue but out of the sweep — it is the crew
 * asking the Author something, and an accept is not the Author's answer. `ACCEPT_SWEPT_TASK_STATES` below is
 * the client's mirror of the sweep, and the statement uses THAT count, never this one.
 *
 * WHY THE CLIENT CARRIES ITS OWN COPY INSTEAD OF IMPORTING THE SERVER'S: the server is a separate
 * package and repository (`@underload/storyline`), never a module this desk may import (this file's
 * standing rule — the desk derives from the WIRE it is handed), and the three-state list is the fact
 * the desk has to agree with.
 *
 * THE DEFECT THIS REMOVES: the gate used to ask `task.state !== 'done'`, which left a `wontfix` row — a task
 * the crew settled by DECLINING it — holding the Accept button greyed forever. `wontfix` is a closed state
 * in the store (`shared/types.ts:171 TASK_STATES`) and in the engine's open set, so the one difference
 * between the old filter and this one is exactly the state that should never have blocked.
 */
export const OPEN_TASK_STATES: PhraseTaskRow['state'][] = ['open', 'claimed', 'blocked'];

/**
 * The open tasks the Summary phrase's read carries — the phrase read's WHOLE queue, never a group-scoped
 * one, and never a set the client may describe as phrase-owned.
 *
 * R-T2/F3, from the server: `phraseProjection`'s `openTasks` builds the phrase read's `tasks` rows as
 * `store.tasks.list().filter(task => task.story_id === story.id && OPEN_TASK_STATES.includes(task.state))` —
 * every unfinished task of the Story — and `PhraseTaskRow` carries no group AND no phrase attribution at all,
 * so the client could not narrow them even if it wanted to. What the desk may therefore say is what it
 * actually counted: the rows the Summary phrase's read sent. The old copy promised "on this Summary or
 * anywhere in the Story", a scope claim the rows cannot support in either direction (defect 2 of T13) — the
 * sentence now names the queue the read carries, which is the same count the Author sees on the phrase's own
 * surface.
 *
 * THE SERVER HALF HAS LANDED (T15), so the old note is gone: that projection used to filter on
 * `state !== 'done'` and count a declined (`wontfix`) row as open, so the desk's count could read LOWER than
 * `review.open_tasks`. `phraseProjection`'s `openTasks` now filters on the server's own `OPEN_TASK_STATES`,
 * so the wire and this function agree state-for-state and neither counts a `wontfix` row.
 *
 * WHAT THIS COUNT IS NOT. It is the QUEUE, three states wide; it is not what the accept CLOSES. The sweep
 * takes only `open`/`claimed` (`ACCEPT_SWEPT_TASK_STATES`), so the confirm statement counts the two halves
 * separately rather than describing this number as "tasks the click closes".
 */
export function groupOpenTasks(view: Pick<StoryViewData, 'phrase'>): PhraseTaskRow[] {
    return (view.phrase?.tasks ?? []).filter((task) => OPEN_TASK_STATES.includes(task.state));
}

/**
 * THE STATES THE ACCEPT ACTUALLY CLOSES — the desk's mirror of `loop/types.ts:OPEN_TASK_STATES`
 * (`open`/`claimed`), the set `loop/records.ts:openTasks` hands to `loop/records.ts:wontfixTasks`, which is
 * the act the lock route runs inside the accept's commit (D-78 / L-25b — the count comes back to the desk as
 * `lock_receipt.wontfixed_tasks`). `blocked` is deliberately absent: a blocked row is the crew's question to
 * the Author, and an accept is not an answer to it, so the sweep leaves it standing.
 *
 * WHY A SEPARATE CONSTANT FROM `OPEN_TASK_STATES` ABOVE. The queue and the act are two different sets, and the
 * sentence under the control used to name one with the other's number: with a `blocked` row in the queue the
 * line promised "closes 3 open tasks … as wontfix" while the receipt reported 2. §10.2's U-16 rule is that a
 * line naming a leftover this book does not have is the same lie as a blocker that is not one, so the
 * statement counts the swept pair and, when blocked rows exist, names them as what the click LEAVES.
 *
 * THE GATE IS UNTOUCHED: a `blocked` row, like every other open row, is not a blocker for Accept (D-78). Only
 * the counting inside the statement changed.
 */
export const ACCEPT_SWEPT_TASK_STATES: PhraseTaskRow['state'][] = ['open', 'claimed'];

/** The queue rows the accept moves to `wontfix` — the only rows "closes N open tasks … as wontfix" may count. */
export function groupTasksClosedByAccept(view: Pick<StoryViewData, 'phrase'>): PhraseTaskRow[] {
    return (view.phrase?.tasks ?? []).filter((task) => ACCEPT_SWEPT_TASK_STATES.includes(task.state));
}

/** The open rows the sweep skips: `blocked` survives the accept, so the statement has to say so out loud. */
export function groupTasksLeftByAccept(view: Pick<StoryViewData, 'phrase'>): PhraseTaskRow[] {
    return (view.phrase?.tasks ?? []).filter((task) => task.state === 'blocked');
}

/**
 * THE FINDING STATES THE ACCEPT ACTUALLY VOIDS — the desk's mirror of `phrase/locks.ts:VOIDABLE_FINDING_STATES`
 * (`unconfirmed`/`confirmed`/`approved`/`disputed`), the state filter `phrase/locks.ts:voidFindingsOnLock` runs
 * over the rows `loop/invalidation.ts:acceptSummaryLeftovers` selects. That void is the act whose count comes
 * back to this desk as `lock_receipt.voided_findings` (D-78 / L-25b's "the count is recorded and shown").
 *
 * WHY `disputed` IS HERE AND NOT IN `OPEN_PHRASE_FINDING_STATES` ABOVE. Those two lists answer two different
 * questions and are deliberately not merged. That one is the REVIEW band — what still reads as live work — and
 * it is the wire's own `projections.ts:openFindings` set, which is what `review.open_findings` sends and what
 * D-33c's holding set (`loop/types.ts:ISSUE_HOLDING_STATES`) agrees with. This one is the LOCK set: D-33c counts
 * a dispute as a LIVE claim ("not proven yet") about text that has just stopped being writable, so a lock
 * retires it rather than leaving it unanswerable — the split `phrase/locks.ts` and §17's "Findings are voided,
 * not resolved" state for the group lock too. `fixed` and `discarded` are terminal in §4.10's ladder and are
 * left exactly as they are for either question.
 *
 * WHY A SEPARATE CONSTANT FROM `ACCEPT_SWEPT_TASK_STATES`, and the defect this removes. The findings half of the
 * confirm line used to borrow the review band's number, so a book carrying a `disputed` row printed
 * "voids 3 open findings" while the same commit discarded 4 and the receipt reported `voided_findings: 4` — the
 * same failure class the swept-tasks constant already eliminated for the "closes N" clause. §10.2's U-16 rule:
 * a line naming a leftover this book does not have is the same lie as a blocker that is not one.
 */
export const ACCEPT_VOIDED_FINDING_STATES: FindingState[] = ['unconfirmed', 'confirmed', 'approved', 'disputed'];

/**
 * THE ROWS THE ACCEPT DISCARDS — the only rows "voids N open finding(s) on the Summary phrase" may count, and
 * the exact client-side mirror of what `loop/invalidation.ts:acceptSummaryLeftovers` hands to
 * `phrase/locks.ts:voidFindingsOnLock`.
 *
 * THE STATE SET IS {@link ACCEPT_VOIDED_FINDING_STATES}. A `fixed` or `discarded` row rides in the read and is
 * never counted: the sweep leaves a terminal row where it is.
 *
 * THE SCOPE IS THE SWEEP'S, NOT THE RAIL'S. A row counts when it is the SUMMARY's own claim:
 *   - UNSCOPED (`finding.unscoped` — the row named no group): the legacy "the Overview as a whole" meaning, and
 *     the Overview IS the artifact being accepted, so it goes. The sweep takes it the same way, including on a
 *     book with no Summary Phrase row, where its own group set is empty and every claim is unscoped; and
 *   - EVERY group the claim names is one of THIS phrase read's entries — the sweep's
 *     `scope.refs.every((id) => summaryGroupIds.has(id))`, over the same ids this read's `groups` carries.
 * A MIXED claim (a Summary group PLUS a Phrase ② chapter entry) is therefore NOT counted, even though the
 * projection put it in this read: the read admits any row whose scope touches at least one of the phrase's
 * entries, while the sweep skips the mixed row on purpose — the chapter half is text the next phrase is about to
 * write — so counting it would promise a void this click does not perform (the count running HIGH is the same
 * lie, the other direction). `targeted` and `unscoped` are the wire's own resolution of
 * `phrase/findings.ts:findingGroupScope` (`projections.ts:findingRows`), the same read the sweep runs, so a ref
 * naming a group this Story does not have is already dropped there and is not re-decided at the desk. A legacy
 * row with `targeted: []` and `unscoped: false` counts too: `findingGroupScope` only empties `refs` by reading
 * the row as unscoped, which is the first branch, so the sweep discards that row as well.
 *
 * THE ONE ASYMMETRY THAT CANNOT BE CLOSED ON THIS SIDE. The desk counts the rows of the phrase read it is
 * HOLDING; the sweep reads the store at the instant the commit lands. An agent that raises or settles a finding
 * between the render and the click therefore moves `lock_receipt.voided_findings` relative to this number, and
 * that is honest rather than a mismatch: each figure was true of the book at the moment it was written, and the
 * line is the book of the frame the Author pressed in.
 */
export function groupFindingsVoidedByAccept(view: Pick<StoryViewData, 'phrase'>): PhraseFindingRow[] {
    // The Summary phrase's own entries: the same id set `acceptSummaryLeftovers` builds from
    // `phraseGroupsOf(store, story.id, phrase.id)`, read off the rows this desk is holding.
    const summaryGroupIds = new Set((view.phrase?.groups ?? []).map((group) => group.id));

    return phraseFindings(view).filter((finding) => {
        if (!ACCEPT_VOIDED_FINDING_STATES.includes(finding.state)) return false;

        // The legacy whole-Overview claim is the Summary's own, whatever the book's group set looks like.
        if (finding.unscoped) return true;

        // Every named group belongs to the phrase being completed; one Phrase ② ref and the row survives.
        return finding.targeted.every((groupId) => summaryGroupIds.has(groupId));
    });
}

/** The revisions superseded on this group — countable; only the latest's predecessor travels as prose. */
export function groupArchivedRevisions(group: PhraseGroupRow): PhraseRevisionRow[] {
    return group.history.filter((revision) => revision.state === 'archived');
}

/** The `latest` row of a group, when the history carries one (it does, once `revision > 0`). */
export function groupLatestRevision(group: PhraseGroupRow): PhraseRevisionRow | undefined {
    return group.history.find((revision) => revision.state === 'latest') ?? group.history[0];
}

// ---------------------------------------------------------------------------
// T3 — the SCORE the Reader-style pass writes against each group
//
// WHY THESE LIVE HERE AND NOT IN THE RAIL: the rail row, the phrase header's overall number and the group
// pane's progress line all answer from the SAME `PhraseGroupRow.scores` array, and each of them needs the
// same three answers — which row is the latest, which one it improved on, and what integer to print. A rule
// that is a function of the row is pinnable without a DOM, which is this module's standing argument.
//
// THE WIRE PINS THE ORDER (newest first, one pass scores all five groups with one `vector_hash`/`at`), and
// these helpers still sort: `scores[0]` being the newest is the difference between "84% (was 78%)" and the
// same pair printed backwards, and a stable sort by `at` descending is a no-op on a payload that already
// arrives in that order.
// ---------------------------------------------------------------------------

/**
 * One group's score rows, newest first, with the malformed ones dropped.
 *
 * `scores` is OPTIONAL (`api.ts:PhraseGroupRow`) and a group nobody has scored yet carries none, so the
 * honest answer for that case is an empty list — which is what makes every renderer print nothing rather
 * than `0%`. A row whose `value` is not a finite number is skipped rather than clamped: `NaN%` on the rail
 * is the bug this list prevents, and a number the projection could not name is not a score.
 */
export function groupScores(group: PhraseGroupRow): PhraseGroupScore[] {
    const scores = (group.scores ?? []).filter((score) => Number.isFinite(score?.value));

    return [...scores].sort((left, right) => String(right.at).localeCompare(String(left.at)));
}

/** The newest score row a group carries, or `undefined` when it has never been scored. */
export function groupLatestScore(group: PhraseGroupRow): PhraseGroupScore | undefined {
    return groupScores(group)[0];
}

/**
 * The pass a group's latest score IMPROVED on — the second-newest row, or `undefined` after a single run.
 *
 * This is what "the user sees how the phrase improves over time" is made of: one number says where the
 * group is, this one says where it came from. A group scored once has no history to compare against, and
 * the pane says `84%` alone rather than inventing a zero to subtract from.
 */
export function groupPreviousScore(group: PhraseGroupRow): PhraseGroupScore | undefined {
    return groupScores(group)[1];
}

/**
 * The integer percentage the Author reads, from whatever spelling the payload used.
 *
 * `value` is documented as 0–100, and a payload that sends the 0–1 fraction of the same claim (0.84) means
 * the same sentence to the Author — so a value at or below 1 is read as the fraction and scaled, and every
 * other value is already a percentage. `Math.round` is the ONE rounding rule, shared by the rail row, the
 * header average's parts and the pane, so the number on the rail and the number in the pane are the same
 * number. Clamping to 0–100 keeps a payload that overshot from printing `118%` on a 320px rail.
 */
export function phraseScorePercent(value: number): number {
    const scaled = value <= 1 ? value * 100 : value;

    return Math.min(100, Math.max(0, Math.round(scaled)));
}

/** The percentage of a group's LATEST score, or `undefined` when the group has none. */
export function groupScorePercent(group: PhraseGroupRow): number | undefined {
    const latest = groupLatestScore(group);

    return latest === undefined ? undefined : phraseScorePercent(latest.value);
}

/** The percentage of the pass a group's latest score improved on, or `undefined` on a first run. */
export function groupPreviousScorePercent(group: PhraseGroupRow): number | undefined {
    const previous = groupPreviousScore(group);

    return previous === undefined ? undefined : phraseScorePercent(previous.value);
}

// ---------------------------------------------------------------------------
// T5 — the TWO Reader marks the group pane may show
//
// WHAT THE REQUEST ASKED FOR AND WHAT THE WIRE OFFERS. The pane used to print every pass in a dated list, which
// reads like a changelog nobody compares. The Author's question is narrower: what does this section score NOW,
// and what did it score the last time the Reader read it? Two rows answer it, and the wire already orders them:
// `groupLatestScore` and `groupPreviousScore` are the same two selectors the rail's percentage and the delta
// sentence are built from, so the pane, the rail and the header average cannot print three different pairs.
//
// WHY "CURRENT CLEAN REVISION" IS THE HONEST LABEL. D-67 moved the scoring join onto the CLEAN vector: the
// Reader pass scores the revision a cross-group Critic pass closed clean on, not the newest draft. So the newest
// row is a verdict about a clean revision, and calling it "latest" or "current score" would blur the one
// distinction the desk keeps insisting on. The second row is the mark BEFORE it — the immediately previous Reader
// mark for this group — which is exactly what `scores[1]` is.
//
// NO DATES, AND NOTHING OLDER. `at` stays out of the output on purpose (the pane used to print it, and the
// report is that a timestamp beside a percentage answers neither question); a third row is history, and history
// is not on this pane.
// ---------------------------------------------------------------------------

/** One of the two marks the pane prints, in the shape a renderer can print without re-deciding anything. */
export interface GroupScoreMark {
    /** `current` = the newest Reader mark (the clean revision); `previous` = the mark immediately before it. */
    role: 'current' | 'previous';
    /** The words the row is labelled with: 'Current clean revision' / 'Previous mark'. */
    label: string;
    /** The percentage, through the ONE normalizer (`phraseScorePercent`), so the rail and the pane agree. */
    percent: number;
    /** The pass itself — for the Critic's sentence and the vector tooltip, never for a date. */
    pass: PhraseGroupScore;
    /** The Critic's sentence for THIS mark, or `undefined` when the pass wrote none. */
    rationale?: string;
}

/** The two labels, in reading order. Exported so a test pins the words without reading them off the pane. */
export const GROUP_SCORE_CURRENT_LABEL = 'Current clean revision';
export const GROUP_SCORE_PREVIOUS_LABEL = 'Previous mark';

/**
 * A group's Reader marks, AT MOST TWO, newest first, and an empty list for a group nobody has scored.
 *
 * The slice is the whole rule: `groupScores` is newest-first and drops malformed rows, so `slice(0, 2)` is the
 * current mark and the mark it moved from — and a book with twelve passes still renders two rows. Absent scores
 * answer `[]`, which is what lets the pane print its empty state instead of `0%`.
 */
export function groupScoreMarks(group: PhraseGroupRow): GroupScoreMark[] {
    return groupScores(group)
        .slice(0, 2)
        .map((pass, index) => ({
            role: index === 0 ? ('current' as const) : ('previous' as const),
            label: index === 0 ? GROUP_SCORE_CURRENT_LABEL : GROUP_SCORE_PREVIOUS_LABEL,
            percent: phraseScorePercent(pass.value),
            pass,
            ...(pass.rationale === undefined ? {} : { rationale: pass.rationale })
        }));
}

/**
 * The Summary phrase's OVERALL score: the mean of every group's latest percentage.
 *
 * ALL-OR-NOTHING BY RULE. One scoring pass scores all five groups (pinned in `api.ts:PhraseGroupScore`), so
 * a book where four groups carry a score and one does not is a book mid-write or mid-read — the pass that
 * scored four has not landed on the fifth, and printing the mean of the four that arrived would be a number
 * the server never claimed. So any group without a score makes the whole header silent, and an empty group
 * list (a phrase read that has not landed, or a sampling-mode book) is silent the same way.
 *
 * The mean is taken over the UNROUNDED percents and rounded once, so the header cannot drift a point from
 * what the five rows imply; ties round up (`Math.round`), which is the reading a person expects of "86.5".
 */
export function phraseOverallScore(view: Pick<StoryViewData, 'phrase' | 'story'>): number | undefined {
    const groups = phraseGroups(view);

    if (groups.length === 0) return undefined;

    const percents = groups.map((group) => {
        const latest = groupLatestScore(group);

        return latest === undefined ? undefined : phraseScorePercent(latest.value);
    });

    if (percents.some((percent) => percent === undefined)) return undefined;

    // The guard above is the proof, and the filter is how the compiler sees it: narrowing each element to a
    // `number` (rather than casting the sum) keeps the mean honest, and `groups.length > 0` already means the
    // list being divided by is non-empty.
    const scored = percents.filter((percent): percent is number => percent !== undefined);

    return Math.round(scored.reduce((sum, percent) => sum + percent, 0) / scored.length);
}

/** A group is written once it has a revision — `revision: 0` is the loop's "never written" (R1). */
export const isGroupWritten = (group: PhraseGroupRow): boolean => group.revision > 0;

/** A group whose text a live Writer pass is replacing right now (F8/R4). */
export const isGroupWriterBusy = (group: PhraseGroupRow): boolean => group.writer_busy;

/** Every group with no revision yet — the sign-off's first blocker (R1: an unwritten group is not an Overview). */
export function unwrittenGroups(view: Pick<StoryViewData, 'phrase' | 'story'>): PhraseGroupRow[] {
    return phraseGroups(view).filter((group) => !isGroupWritten(group));
}

// ---------------------------------------------------------------------------
// R1 — the LOCK on one SUMMARY GROUP: the state, the sentence, and what the desk may offer
//
// WHY HERE AND NOT IN THE PANE. Three surfaces read the same lock — the rail's row, the group pane's badge and
// its two controls — and all three have to agree about what `locked` absent MEANS (open), which revision the
// lock names when the wire's `locked_revision` and the row's `revision` differ, and what the words are. A rule
// that is a function of the row is pinnable without a DOM, which is this module's standing argument.
//
// ABSENCE IS THE WHOLE DESIGN. `locked`, `locked_revision`, `locked_by` and `locked_at` are all OPTIONAL on the
// wire (`api.ts:PhraseGroupRow`), and a payload from before the lock exists sends none of them. Every selector
// below reads that as "the group is open", so an old book keeps the pane it had — no badge, no unlock line —
// rather than a badge over a lock nobody made.
// ---------------------------------------------------------------------------

/** Who committed a lock, in the dashboard's own vocabulary (the wire's tokens are the same two words). */
export type PhraseLockActor = 'author' | 'editor';

/** A group whose text someone has committed to. Absent `locked` means OPEN — the legacy and normal state. */
export const isGroupLocked = (group: PhraseGroupRow): boolean => group.locked === true;

/**
 * WHO made the lock: `'author'`, `'editor'`, or `undefined` when the row does not say.
 *
 * `undefined` is a real third state rather than a synonym for Author: a payload that marks a group locked but
 * names no actor must not be reported as a lock the Author made, because the pane's whole unlock sentence rests
 * on who is allowed to lift it.
 */
export function groupLockActor(group: PhraseGroupRow): PhraseLockActor | undefined {
    return group.locked_by === 'author' || group.locked_by === 'editor' ? group.locked_by : undefined;
}

/**
 * The revision the lock stands on — the number the badge prints.
 *
 * `locked_revision` is the wire's answer and is used whenever it carries one. It falls back to the row's current
 * `revision` ONLY as the honest second reading: a lock is always made ON a revision, so a payload that says
 * `locked:true` without the number still means "the text that stands now is the text that was committed". The
 * fallback never invents a number for an unlocked group — `undefined` there, so no renderer prints one.
 */
export function groupLockRevision(group: PhraseGroupRow): number | undefined {
    if (!isGroupLocked(group)) return undefined;

    const revision = group.locked_revision;

    return typeof revision === 'number' && Number.isFinite(revision) ? revision : group.revision;
}

/** The two actor words the desk prints: capitalized because they begin a clause ("Locked … by Author"). */
export const groupLockActorLabel = (actor: PhraseLockActor | undefined): string =>
    actor === 'editor' ? 'Editor' : actor === 'author' ? 'Author' : 'Crew';

/**
 * The locked badge's exact words: the revision the lock stands on, and who made it.
 *
 * Both halves are the request, not decoration: `Locked` alone leaves the Author guessing WHICH text is frozen
 * once the loop has installed another revision, and the actor is the fact that explains why the pane is shut for
 * an Editor's hand. `by Crew` is the fallback spelling for a row that names no actor — never a guessed Author.
 */
export function groupLockBadge(group: PhraseGroupRow): string {
    const revision = groupLockRevision(group);

    return `Locked at Revision ${revision === undefined ? '?' : revision} · by ${groupLockActorLabel(groupLockActor(group))}`;
}

/**
 * The badge's tooltip: what a lock does to the group, in the same words for every surface.
 *
 * `locked_at` travels on the wire and stays HERE rather than in the badge's text: the Author compares locks, not
 * timestamps, and a date on a badge competes with the revision number that actually identifies the text.
 */
export function groupLockTooltip(group: PhraseGroupRow): string {
    const actor = groupLockActorLabel(groupLockActor(group)).toLowerCase();
    const head = `Locked in by ${actor}: this group's text cannot be revised, the findings it carries are void, and the other groups adapt to it.`;

    return group.locked_at ? `${head} Locked at ${group.locked_at}.` : head;
}

/**
 * R1 / U-16 — why the LOCK control is shut, or `''` when the Author may use it.
 *
 * Every reason is a fact off the row, never a guess from run rows: no verb in this shell, the Writer replacing
 * the text this second (the same `writer_busy` the revise route refuses with, R4), nothing written to commit
 * (R1 — `revision: 0` is the loop's own "never written"), or already locked. Order matters: the missing verb is
 * the shell's fault and comes first, and an already-locked group is not offered a second lock.
 */
export function groupLockRefusal(group: PhraseGroupRow, hasAction: boolean): string {
    if (!hasAction) return 'The group lock route is not available in this shell.';
    if (isGroupLocked(group)) return 'This group is already locked in.';
    if (isGroupWriterBusy(group)) {
        return 'The Writer is rewriting this group right now — the lock route refuses to commit text that is about to move (R4).';
    }
    if (!isGroupWritten(group)) {
        return 'Nothing is written to lock in yet — the lock commits a revision, and this group has none.';
    }
    return '';
}

/**
 * R1 / U-16 — why the UNLOCK control is shut, or `''` when the Author may use it.
 *
 * Only the Author lifts a lock, whoever made it — and the Writer hold is a refusal too, because the lock
 * may be holding off an install that was dispatched BEFORE it and is still in flight (`api/routes.ts`'s
 * unlock leg checks `liveGroupWriters` before it calls the domain, R4). Unlocking under that pass would
 * open the group for a text nobody reviewed, so the control is shut on the same `writer_busy` read the
 * route's 409 refuses with — a greyed button and a refusal cannot disagree (F8/R4). Order keeps the
 * existing reasons first: the missing verb is the shell's fault, and a group that is not locked has
 * nothing to unlock whatever else is true of it.
 */
export function groupUnlockRefusal(group: PhraseGroupRow, hasAction: boolean): string {
    if (!hasAction) return 'The group unlock route is not available in this shell.';
    if (!isGroupLocked(group)) return 'This group is not locked, so there is nothing to unlock.';
    if (isGroupWriterBusy(group)) {
        return 'The Writer is rewriting this group right now — the unlock route refuses to open a section under a pass that has not installed its text (R4).';
    }

    return '';
}

export const canAuthorLockGroup = (group: PhraseGroupRow, hasAction: boolean): boolean =>
    groupLockRefusal(group, hasAction) === '';

export const canAuthorUnlockGroup = (group: PhraseGroupRow, hasAction: boolean): boolean =>
    groupUnlockRefusal(group, hasAction) === '';

/**
 * R1 — the confirmation sentence the Author clicks twice.
 *
 * A lock has three consequences and all three are stated before the verb, because the Author cannot undo any of
 * them alone from here: the text stops being editable, the findings that were aimed at it are void, and the
 * other four groups start adapting to it. The last clause is the one that is easy to forget — the lock is a
 * promise the REST of the Summary has to keep.
 */
export function groupLockStatement(group: PhraseGroupRow): string {
    // The revision the lock COMMITS. On a locked row that is `locked_revision` (the text the lock already
    // stands on); on the OPEN group the Author is about to commit it is the row's own current revision, because
    // the text that stands now is exactly the text the lock freezes — and naming it is the whole point of the
    // confirmation. An unwritten group has no revision to name, and its control is shut before this sentence is
    // ever read (`groupLockRefusal` refuses it, R1's `revision: 0`).
    const revision = groupLockRevision(group) ?? group.revision;

    return `Locking Revision ${revision} of “${group.title}” makes it settled content: this group stops being editable, the findings aimed at it are void, and the other groups adapt to the text that now stands. Only the Author can unlock it.`;
}

/**
 * R1 — the cached refusal for THIS group, or `undefined` when the frame carries none.
 *
 * `undefined` is not "the lock succeeded": the pane's badge is read off the phrase rows, so a refusal shows the
 * sentence while an unchanged `locked` flag keeps showing the group as it stands. Keyed through
 * `api.ts:groupLockKey` — the same builder the store wrote with, so a refusal cannot miss its own pane.
 */
export function groupLockError(
    view: Pick<StoryViewData, 'groupLockErrors' | 'story'>,
    groupId: string
): string | undefined {
    return view.groupLockErrors?.[groupLockKey(view.story.id, groupId)];
}

/**
 * R2 — the Story's Editor-locking Setting, read the way every absent-by-default flag on this desk is read.
 *
 * ABSENT MEANS OFF. The key is additive on `Story` and on `PATCH /stories/:id`, and a Story written before the
 * Setting exists has no key at all; treating absence as "on" would hand the Editor a power the Author never
 * granted. `=== true` is the whole rule, so a payload that sends a string or a null reads as off.
 */
export const isEditorGroupLockingEnabled = (story: Story): boolean =>
    (story as Story & { editor_group_locking?: boolean }).editor_group_locking === true;

/** R2 — the Setting's own words, kept in one place so the pane and its test read the same label. */
export const EDITOR_GROUP_LOCKING_LABEL = 'Editor may lock phrase groups';

/** R2 — what the Setting does, in the two sentences the Author needs before turning it on. */
export const EDITOR_GROUP_LOCKING_NOTE =
    'On, the Editor may lock a Summary group in on its own judgement — it weighs the Critic findings open on that group now, with the Reader score and rationale beside them, and commits the text that stands. Off (the default), only the Author locks a group. Either way, only the Author can unlock one.';

/**
 * THE sign-off blockers the GROUP model adds to the phase gate (U5's last test), under R2's rule.
 *
 * The route itself still gates on the phase Goal and the Ideas tray (`routes.ts:POST /stories/:id/lock`),
 * and the dashboard may not invent a blocker the engine ignores — but it may not ACCEPT a ready-looking
 * gate over a Summary the group rows say is incomplete either. Each reason below is a fact off the phrase
 * read, phrased as the wait it is, and an empty list means the group surface has nothing outstanding.
 *
 * R2 — WHAT STOPPED BEING A BLOCKER, in this function's own words: an open Critic finding and an open queue
 * task used to be reasons here. They are not, because the accept VOIDS the phrase's open findings and moves
 * its open tasks to `wontfix` (T12's server leg, L-25b's precedent), so holding the control shut over them
 * asks the Author to clear work the click clears (L-36). They are counted into the accept's statement instead
 * (`summaryAcceptStatement`), which is where the Author reads what the click does with them.
 *
 * WHAT STILL BLOCKS, and why each one earns its place:
 *   - the phrase read has not landed / failed (R-T2/F1, F2) — it is the only source of every fact below;
 *   - an unwritten group (R1) — the Overview cannot be complete, so no clean Summary can exist over it;
 *   - no clean Summary to accept (R2) — one sentence naming the gap (`cleanSummaryGateReason`), never a
 *     findings/tasks list, because the gaps ARE the missing selection;
 *   - a live Writer holding a group (R4) — a Writer installing text AFTER the accept would write over a
 *     read-only Summary (P5), which is the one rule this desk may not break silently.
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

    // R1 FIRST, because it is the gap the Author can see: an unwritten group is not in the Overview at all,
    // and naming the title beats naming the state of a selection derived from it.
    const unwritten = unwrittenGroups(view);

    if (unwritten.length > 0) {
        reasons.push(
            `${reasonCount(unwritten.length, 'Summary group', 'Summary groups')} still unwritten (${unwritten
                .map((group) => group.title)
                .join(', ')}) — an unwritten group is not part of the Overview yet (R1)`
        );
    }

    // R2 — THE BAR, replacing the two rows this function used to push here. `grouped()`'s clean five-group
    // book answers `''` (no reason at all); the mid-review book answers ONE gap sentence in place of the old
    // findings line and task line. An UNSCOPED finding naming all five groups, and a `claimed` task, now ride
    // in the statement (`summaryAcceptStatement`) — they are what the accept voids and closes, not what it
    // waits for.
    const gate = cleanSummaryGateReason(view);

    if (gate !== '') reasons.push(gate);

    const groups = phraseGroups(view);
    const busy = groups.filter(isGroupWriterBusy);

    if (busy.length > 0) {
        reasons.push(
            `the Writer is rewriting ${busy.map((group) => group.title).join(', ')} right now — the text on screen is about to move (R4)`
        );
    }

    return reasons;
}

/**
 * THE leftovers the accept clears, counted off the SAME rows the gate reads — so the number the Author reads
 * in the confirm line can never disagree with the state the panes draw above it, nor with the receipt the
 * route answers with.
 *
 * WHY NO NEW WIRE FIELD (AC6): `findings` is `groupFindingsVoidedByAccept` — the phrase read's rows at the
 * states `phrase/locks.ts:voidFindingsOnLock` discards (`ACCEPT_VOIDED_FINDING_STATES`, mirror of
 * `VOIDABLE_FINDING_STATES`) and at the scope `loop/invalidation.ts:acceptSummaryLeftovers` selects (the
 * Summary's own claims: an unscoped legacy row, or a row whose every named group is one of this phrase's
 * entries). That is the set the click performs, so it is the set the "voids N …" clause may name;
 * `lock_receipt.voided_findings` reports exactly that many, for the frame the read is holding.
 *
 * IT IS NOT THE OVERVIEW'S REVIEW NUMBER, AND THE TWO NUMBERS ANSWER DIFFERENT QUESTIONS. The card's own
 * review line ("N open findings · M critical/major") is `review.open_findings` / `review.blocking_findings` —
 * a SEVERITY band over the three-state OPEN set (`OPEN_PHRASE_FINDING_STATES`, the wire's `openFindings`), which
 * counts no `disputed` row (D-33c files a dispute as archived) and takes every scope the read carries. The
 * accept's count is wider in STATES and narrower in SCOPE, because it books an act rather than a queue: it takes
 * the `disputed` row the sweep discards, and it skips the mixed-phrase claim the band still counts. On a book
 * with a `disputed` row the review line says 3 and the accept line says 4, and both are true. A count drawn from
 * `summaryBlockingCost` would be wrong again, in the other direction — the accept voids every claim the phrase
 * owns, not only the ones at the Summary's cost bar.
 *
 * THE TWO TASK NUMBERS, which is what this used to get wrong. `tasks` counts `groupTasksClosedByAccept` —
 * `open` + `claimed`, the set the route's `wontfixTasks` sweep actually moves — because the clause it feeds
 * says "closes … as wontfix", and `lock_receipt.wontfixed_tasks` reports exactly that many. `blocked` counts
 * `groupTasksLeftByAccept`: an open row the sweep skips, because a blocked task is the crew's question to the
 * Author and the accept is not an answer. The desk's QUEUE number (`groupOpenTasks`, three states, the
 * Overview's "K open tasks") is still the sum of the two, and it is deliberately not what the "closes" clause
 * carries: on a book with a blocked row, a line claiming it closed that row too promised a leftover this book
 * does not have. Both come from `view.phrase`, the one read this gate is built from.
 */
export function summaryAcceptLeftovers(view: StoryViewData): {
    findings: number;
    tasks: number;
    blocked: number;
} {
    if (!phraseReadLanded(view)) return { findings: 0, tasks: 0, blocked: 0 };

    return {
        findings: groupFindingsVoidedByAccept(view).length,
        tasks: groupTasksClosedByAccept(view).length,
        blocked: groupTasksLeftByAccept(view).length
    };
}

/**
 * The grouped Summary's confirm/statement line (U-16): what the accept DOES, in the frame before the click.
 *
 * R3/R4 move two acts into this one commit (T12's server leg), so the copy says so: the Summary phrase's own
 * claims are VOIDED and the queue's swept tasks closed as `wontfix` (L-25b's "closed with a count on it"), and
 * Phrase 2 opens from the compiled Summary as the Author's act rather than as a second verb (D-72 — the accept is
 * what starts it, and `PlotlinesHandoff` then correctly reports the phrase as started).
 *
 * WHY THE TWO LEFTOVERS GET DIFFERENT SCOPE WORDS, which is defect 2 of the reported copy: the phrase read's
 * FINDINGS are phrase-scoped, and the clause narrows them once more to what the sweep actually swallows —
 * `groupFindingsVoidedByAccept` keeps the Summary's OWN claims, meaning an unscoped legacy row (R3 reads that as
 * "the whole Overview", which is the artifact being accepted) or a row whose every named group is one of this
 * phrase's entries (`loop/invalidation.ts:acceptSummaryLeftovers`). "On the Summary phrase" is therefore a fact
 * the wire supports on BOTH sides, and a mixed Summary-plus-Phrase-② claim — which the read does show, and which
 * the sweep leaves standing for the phrase this same accept starts — is not counted. Its TASKS are not phrase
 * scoped at all (`projections.ts:phraseProjection`'s `openTasks` filters on `story_id` alone and `PhraseTaskRow`
 * carries no phrase or group id), so the task clause says "in the queue" — the count the read sent — and never
 * claims a scope the rows cannot support in either direction, which is exactly what the old "on this Summary or
 * anywhere in the Story" sentence did.
 *
 * WHY THE "voids" CLAUSE MAY NOT COUNT THE REVIEW BAND, which is defect 4 and the findings twin of defect 3: the
 * void it describes (`phrase/locks.ts:voidFindingsOnLock` over `VOIDABLE_FINDING_STATES`) takes `disputed` as
 * well — D-33c counts a dispute as a live claim about text that has just stopped being writable — while the
 * Overview's review line stays a three-state severity band. The old clause borrowed the band's number, so a book
 * carrying a disputed row printed "voids 3 open findings" over a receipt answering `voided_findings: 4`. The
 * clause is now fed by `ACCEPT_VOIDED_FINDING_STATES`, and it needs no "leaves …" twin of its own: everything the
 * accept can void, it does void, so nothing goes quietly out of the sentence.
 *
 * WHY THE "closes" CLAUSE MAY NOT COUNT THE WHOLE QUEUE, which is defect 3: the sweep it describes
 * (`loop/records.ts:wontfixTasks`) takes `open` + `claimed` only, so a `blocked` row — the crew's question to
 * the Author, which the accept is not an answer to — survives the click. The old line counted it and promised
 * to close it, so the confirm could read "closes 3 open tasks" over a receipt reporting
 * `wontfixed_tasks: 2`. §10.2's U-16 rule: a line naming a leftover this book does not have is the same lie as
 * a blocker that is not one. Hence `tasks` (the swept pair) and a separate "leaves N blocked tasks for you"
 * clause for what survives, so nothing goes quietly.
 *
 * THE CLAUSES ARE CONDITIONAL, all three of them: they appear only when the read actually carries them, because
 * an empty "voids no findings" / "leaves no blocked tasks" clause would describe a state this book is not in.
 * The blocked clause comes BEFORE the closing "and starts Phrase 2" leg so the sentence stays one list that ends
 * in the phrase's own verb, and it carries no "and" of its own for that reason.
 */
const summaryAcceptStatement = (leftovers: { findings: number; tasks: number; blocked: number }): string =>
    'Accepting the final Summary makes it read-only for every agent (P5, L-30), deletes this phase\u2019s Ideas tray in the same commit (D-36)' +
    (leftovers.findings > 0
        ? `, voids ${reasonCount(leftovers.findings, 'open finding', 'open findings')} on the Summary phrase`
        : '') +
    (leftovers.tasks > 0
        ? `, closes ${reasonCount(leftovers.tasks, 'open task', 'open tasks')} in the queue as wontfix`
        : '') +
    (leftovers.blocked > 0
        ? `, leaves ${reasonCount(leftovers.blocked, 'blocked task', 'blocked tasks')} for you`
        : '') +
    ', and starts Phrase 2 from the compiled Summary (D-72).';

// ---------------------------------------------------------------------------
// D-67 / D-68 — the REVIEWED Summary the Summary tab renders
//
// WHY THESE SELECTORS EXIST RATHER THAN THE PANE READING `view.phrase.reviewed` DIRECTLY. The reviewed block
// is a wire shape with three states, a score join keyed by GROUP UUID, and per-group gaps that arrive under
// two different tokens; the Summary tab, the choose control and (later) the rail all have to answer the same
// questions from it, and each of those answers is a RULE about the wire (which state renders which text, what
// a gap means in an Author's words, which revision a score describes). A rule that is a function of the row
// is pinnable without a DOM — this module's standing argument — and it keeps the pane from re-deciding what
// "ready" or "dropped" means.
//
// WHAT IS NEVER RE-DERIVED HERE. The selection itself (`cleanSelectionOf`, server), the score join (the
// server joins on `vector_hash` and ships the rows), and the state token (the projection computes it). The
// helpers below only pair rows with rows (a reviewed group with its catalog row, for a title) and put the
// wire's facts into sentences the Author reads.
// ---------------------------------------------------------------------------

/** The empty reviewed block: what a payload from before D-67, or a book with no groups, amounts to. */
const EMPTY_REVIEWED: PhraseReviewedSummary = {
    state: 'pending',
    complete: false,
    vector: {},
    vector_hash: '',
    overview: '',
    groups: [],
    chosen: null,
    stale: false,
    blocking_issues: [],
    writer_busy: false
};

/**
 * The reviewed block, or the EMPTY block when the phrase read has not landed or the server predates D-67.
 *
 * The wire sends it ALWAYS (`projections.ts:PhraseView.reviewed`), so this is not a loading branch —
 * `phraseReadLanded` is. It is the tolerance for an older build: the Summary tab must answer `pending`
 * rather than crash on `undefined.groups`, and it must never fill the gap with the live text.
 */
export function phraseReviewed(view: Pick<StoryViewData, 'phrase'>): PhraseReviewedSummary {
    return view.phrase?.reviewed ?? EMPTY_REVIEWED;
}

/** The state token the Summary tab branches on; `pending` for a payload that has no reviewed block at all. */
export function reviewedState(view: Pick<StoryViewData, 'phrase'>): PhraseReviewedSummary['state'] {
    return phraseReviewed(view).state;
}

/** The instant the choose committed, as the wire sent it (`YYYY-MM-DD`). Absent ⇒ `''`, and the pane prints no date. */
export function reviewedChosenDate(view: Pick<StoryViewData, 'phrase'>): string {
    const at = phraseReviewed(view).chosen?.at ?? '';

    return at.length >= 10 ? at.slice(0, 10) : at;
}

/**
 * THE Summary text the tab prints — and the one place that decides WHICH text that is.
 *
 * `ready` → the compiled reviewed Overview; `chosen` → the text the Author took; `pending` → `''`, which is
 * what keeps the tab from substituting the live composed Overview. D-67's rule is the whole point of the
 * pane: a Reader's number and the crew's standing describe the text they were shown, so the live text —
 * which may carry an open defect on one group — is not this Summary and is printed nowhere here.
 */
export function reviewedSummaryText(view: Pick<StoryViewData, 'phrase'>): string {
    const reviewed = phraseReviewed(view);

    if (reviewed.state === 'chosen') return reviewed.chosen?.overview ?? '';

    return reviewed.state === 'ready' ? reviewed.overview : '';
}

/** The live group rows by UUID and by key — the reviewed block names ids and keys but carries no title. */
const groupIndex = (view: Pick<StoryViewData, 'phrase' | 'story'>): Record<string, PhraseGroupRow> => {
    const index: Record<string, PhraseGroupRow> = {};

    for (const group of phraseGroups(view)) {
        index[group.id] = group;
        // The reviewed block's `blocking_issues[].group_keys` are CATALOG KEYS (`projections.ts:keyById`),
        // while its `groups[]` are addressed by UUID, so a title lookup needs both spellings.
        index[group.key] = group;
    }

    return index;
};

/** One reviewed group with everything a row has to print: its live sibling (title, purpose) and its score. */
export interface ReviewedGroupRow {
    /** The wire's row for this group — selection, supersession, gap and the scores that judged the selection. */
    reviewed: PhraseReviewedGroup;
    /** The live catalog row, or `undefined` when the phrase read has no sibling (a group retired mid-flight). */
    group?: PhraseGroupRow;
    /** The display title, from the live row: the rail, the pane and this row name a group identically (U6). */
    title: string;
    /** The newest score that judged THIS selection, or `undefined` when no pass reported against the hash. */
    score?: number;
    /** True when the newest text is not the reviewed one — the pair of numbers the feature exists to show. */
    superseded: boolean;
}

/**
 * The reviewed rows in the composition order the rail uses, each paired with its live sibling.
 *
 * The projection emits them in catalog order, but a pane must not depend on that: the pair is looked up by
 * id and sorted by the LIVE `order` (the same tie-break `phraseGroups` uses), so a refetch that reshuffles
 * the payload cannot reorder the tab, and a reviewed row whose group has gone keeps the server's order
 * instead of vanishing (an entry the Author is owed is not a row this file may drop).
 */
export function reviewedGroupRows(view: Pick<StoryViewData, 'phrase' | 'story'>): ReviewedGroupRow[] {
    const byId = groupIndex(view);
    const reviewed = phraseReviewed(view);
    const order = new Map(phraseGroups(view).map((group, index) => [group.id, index]));
    // The server's own position is the FALLBACK sort key, so a reviewed row whose live sibling has gone
    // stays where the wire put it rather than jumping to the front of the tab.
    const rows = reviewed.groups.map((row, index) => ({ row, index }));

    rows.sort((left, right) => {
        const leftOrder = order.get(left.row.id) ?? left.index;
        const rightOrder = order.get(right.row.id) ?? right.index;

        return leftOrder - rightOrder || left.row.key.localeCompare(right.row.key);
    });

    return rows.map(({ row }) => {
        const group = byId[row.id];
        // The newest row that judged THIS selection: the wire already filtered by `reviewed.vector_hash`
        // (`scoresForVector`), so the head of the list is the number the pane prints — and a pane that
        // reached for `groups[].scores` instead would print a score of text nobody reviewed (D-67).
        const [latest] = row.scores.filter((score) => Number.isFinite(score?.value));

        return {
            reviewed: row,
            group,
            title: group?.title ?? row.key,
            score: latest === undefined ? undefined : phraseScorePercent(latest.value),
            superseded: row.superseded
        };
    });
}

/** Why ONE group has no reviewed text, in the Author's words; `''` when it does. */
export function reviewedGapReason(row: PhraseReviewedGroup): string {
    // `unwritten` first: there is no text to review at all, which is a different wait from "written, never
    // passed". An open issue outranks `no_clean_revision` in the sentence because it names what the Author
    // can actually act on — the finding, not the missing pass.
    if (row.selected_revision !== null) return '';

    if (row.gap === 'unwritten') return 'nothing written yet';
    if (row.issues_open) return 'has open issues';
    if (row.gap === 'no_clean_revision') return 'awaiting a clean pass';

    // A row with neither a gap token nor an open issue is still unselected, so the honest sentence is the
    // missing pass; the pane never claims a reason the wire did not send.
    return row.gap === null ? 'awaiting a clean pass' : `awaiting a clean pass (${row.gap})`;
}

/** Every group the reviewed Overview is missing, with its reason — the waiting state's list (never the live text). */
export function reviewedGaps(view: Pick<StoryViewData, 'phrase' | 'story'>): Array<ReviewedGroupRow & { reason: string }> {
    return reviewedGroupRows(view)
        .map((row) => ({ ...row, reason: reviewedGapReason(row.reviewed) }))
        .filter((row) => row.reason !== '');
}

/**
 * R2 — IS THERE A CLEAN SUMMARY TO ACCEPT? The one fact the Accept control now hangs on.
 *
 * THE RULE, in the Author's words: the button opens when a clean Summary EXISTS — the reviewed selection is
 * complete, or the Author has taken one. `story-contract` mirrors the server's own state token
 * (`projections.ts:reviewedSummaryView`: `ready`/`chosen` are exactly "complete selection" and "a valid
 * recorded choice"), so the desk does not re-derive the selection from the group rows it happens to be
 * holding, and cannot disagree with the choose route about what is clean.
 *
 * WHAT THIS PREDICATE IS *NOT* A BLOCKER FOR (the reported defect): open Critic findings and open queue tasks
 * used to grey this control, which asked the Author to decide work the accept voids and closes in the same
 * commit (L-36: "an unapproved finding does not halt a Story by itself … a pending decision, not a blocked
 * Story", and L-25b's precedent for closing leftovers with a count on them). They are still READ here — they
 * are what the statement counts — they simply no longer shut the door. The waits that stay are the ones the
 * server really refuses on, or the ones a click would corrupt: the phrase read (`groupSignOffBlockers`'s
 * first clause), the Ideas tray (L-7a), the phase Goal (U-16), and a live Writer holding a group (R4 — text
 * installed after the accept would break the P5 read-only rule).
 *
 * `pending` is the false case: no complete selection AND no valid choice, which is what
 * `cleanSummaryGateReason` turns into the single gap sentence the gate prints.
 */
export function cleanSummaryExists(view: Pick<StoryViewData, 'phrase'>): boolean {
    if (!phraseReadLanded(view)) return false;

    return phraseReviewed(view).state !== 'pending';
}

/**
 * The one sentence that replaces the old findings/tasks blockers: WHY there is no clean Summary yet, naming
 * each group the reviewed Overview is missing with the wire's own reason for it (`reviewedGapReason`, so a gap
 * token the server never sent is never dressed up as one).
 *
 * WHY ONE SENTENCE AND NOT THREE: the gaps ARE the missing clean Summary. Emitting an "N open findings" and an
 * "M open tasks" bullet beside it would re-add, as a blocker, the very rows R2 stopped blocking — and on the
 * mid-review book every gap row is `issues_open`, so the Author would read the same defect twice, once as a
 * wait and once as a fact.
 *
 * WHY AN UNWRITTEN GROUP IS NOT REPEATED HERE: R1's own bullet names every group the LIVE rows say has no text
 * (`unwrittenGroups`), and that fact already explains why the selection cannot close. Naming `Ending` twice —
 * once as "still unwritten (R1)", once as "nothing written yet" — is the duplicate reason this gate was told
 * not to emit. A gap row whose live sibling IS written stays, because only this sentence can name it, and a
 * book with nothing left to name after R1 answers `''` (R1 alone is the honest single reason).
 *
 * WHY EACH CLAUSE IS LABELLED WITH A COLON: the gap reasons are predicates of a group title (`has open
 * issues`, `nothing written yet`, `awaiting a clean pass`), and a comma-joined list of bare predicates breaks
 * grammar the moment one unwritten group sits among them ("Ending nothing written yet"). `Title: reason` keeps
 * the wire's words verbatim — the reason vocabulary is pinned in `reviewedGapReason`, and this layer may not
 * re-conjugate it or invent a reason the read did not send.
 *
 * `''` means clean: the same convention `plotlinesHandoffRefusal` and `reviewedChooseRefusal` use.
 */
export function cleanSummaryGateReason(view: Pick<StoryViewData, 'phrase' | 'story'>): string {
    if (cleanSummaryExists(view)) return '';

    const gaps = reviewedGaps(view);

    if (gaps.length === 0) {
        // The wire says `pending` but sent no gap rows — an empty catalog, or a payload older than D-67. The
        // desk may name the state, but it may not invent a reason the read did not carry.
        return 'no clean Summary to accept yet — the reviewed selection has not been reported by the phrase read';
    }

    const unwritten = new Set(unwrittenGroups(view).map((group) => group.id));
    const named = gaps.filter((row) => !(row.group !== undefined && unwritten.has(row.group.id)));

    if (named.length === 0) return '';

    return `no clean Summary to accept yet — ${named.map((row) => `${row.title}: ${row.reason}`).join('; ')}`;
}

/** The unresolved issues holding a clean verdict back, each with the group TITLES it scopes to. */
export function reviewedBlockingIssues(
    view: Pick<StoryViewData, 'phrase' | 'story'>
): Array<{ id: string; title: string; cost: string; groups: string[] }> {
    const byId = groupIndex(view);

    return phraseReviewed(view).blocking_issues.map((issue) => ({
        id: issue.id,
        title: issue.title,
        cost: issue.cost,
        // Catalog KEYS become the catalog's titles here, so the tab never prints a key the Author has
        // never seen (`premise`, not `grp-1`), and an unknown key falls back to the key itself.
        groups: issue.group_keys.map((key) => byId[key]?.title ?? key)
    }));
}

/** The scores that judged the CHOSEN text for one group — keyed by GROUP UUID on the wire, never by key. */
export function chosenGroupScores(
    view: Pick<StoryViewData, 'phrase'>,
    groupId: string
): PhraseGroupScore[] {
    return phraseReviewed(view).chosen?.scores?.[groupId] ?? [];
}

/** The revision the CHOSEN vector names for one group, or null when the record does not name one. */
export function chosenGroupRevision(view: Pick<StoryViewData, 'phrase'>, groupId: string): number | null {
    return phraseReviewed(view).chosen?.vector?.[groupId] ?? null;
}

/**
 * Why the Choose control cannot run, `''` when it can (U-16: a disabled control states its reason).
 *
 * Two refusals, both the wire's, and deliberately NO third:
 *   - the shell has no binding, so the click would do nothing;
 *   - `reviewed.writer_busy` — the SAME read the route's 409 refuses with, so a greyed control and a
 *     refusal can never disagree (R4).
 *
 * WHY `stale` does NOT disable. `stale` is not a stale frame: it says the clean selection has moved PAST
 * what the Author chose, which is exactly the case the choose exists for a second time — the server's own
 * comment on `reviewedSummaryView` calls it "the choose is offered again". Greying the button on `stale`
 * would strand a book whose Author has already chosen once: they could never take newer reviewed text.
 * The pane therefore LABELS the action when stale (and its refusal list stays the wire's two).
 */
export function reviewedChooseRefusal(
    view: Pick<StoryViewData, 'phrase'>,
    hasAction: boolean
): string {
    if (!hasAction) return 'The reviewed-Summary choose route is not available in this shell.';

    if (phraseReviewed(view).writer_busy) {
        return 'The Writer is rewriting part of this Summary right now, so choosing would install under a pass that has not finished (R4).';
    }

    return '';
}

/** Every group whose newest text the choice will pass over — the drop the confirmation step names. */
export function reviewedSupersededGroups(
    view: Pick<StoryViewData, 'phrase' | 'story'>
): ReviewedGroupRow[] {
    return reviewedGroupRows(view).filter((row) => row.reviewed.superseded);
}

/** The choose's refusal sentence, verbatim from the server, or `undefined` when no refusal is on the frame. */
export const reviewedChooseError = (view: Pick<StoryViewData, 'reviewedError'>): string | undefined =>
    view.reviewedError ?? undefined;

// ---------------------------------------------------------------------------
// Findings and Ideas (D-33/D-34, D-27/D-32)
// ---------------------------------------------------------------------------

/** §4.10's stated shorthand: "Open means any of unconfirmed, confirmed, approved that is not yet fixed". */
export const OPEN_FINDING_STATES: FindingState[] = ['unconfirmed', 'confirmed', 'approved'];

export function isOpenFinding(finding: Finding): boolean {
    return OPEN_FINDING_STATES.includes(finding.state);
}

/** D-32/D-36 — the Author's decisions, which are the memory that stops the next Critic re-arguing. */
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
     * §6.2a files a reader's report against the draft it read — the Reader also appends the verdict to
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
 * §6.2a's loop B files a reader's report against the draft it read, so a draft with its own rows is
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
 *
 * WHAT EACH BRANCH RETURNS IS A CONTRACT, NOT AN INCIDENTAL, because `RevisionsCompare.tsx` renders this text
 * through `MarkdownText` and the reader's line breaks come from what is written here:
 *   - a string is returned untouched — it is the stored phrase prose, newlines and all;
 *   - a chapter body's sections are joined with a BLANK line, the same paragraphing the prose pane gives them;
 *   - an object body joins `key: value` with a SINGLE `\n` — one field per line, and no blank line between
 *     them, which is how `chapterEntryContent` (`src/server/phrase/plotpoints.ts:70-78`) stores a contract
 *     block too. Those single newlines are soft breaks in markdown, so they only stay on separate lines because
 *     `MarkdownText` runs `remark-breaks`; the node this feeds was a literal `<pre>` until U-23, i.e. it used to
 *     be the UA stylesheet that kept them apart.
 * It stays DERIVED rather than stored: the §4.15 body shape is the wire's, and flattening it here is what keeps
 * an old draft readable beside a new one instead of asking every producer to agree on one text.
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
        // R5 — A CHAPTER CONTRACT RIDES AS FIELDS, NOT AS PROSE. A revision of a chapter entry carries the
        // `plotpoints` the route composed the entry's text from (`heading` + the ordered `beats` + the ordered
        // `dialogue`), and a compare view that printed `beats: [object Object]` — or printed nothing, because the
        // generic arm below only accepts strings — would be showing half a contract and calling it a draft. So a
        // body that names beats is rendered by the SAME composer the server used to write the entry's text
        // (`chapterEntryText`), which is the one text the Author recognises as this chapter's contract.
        const record = body as Record<string, unknown>;
        const plotpoints =
            record.plotpoints !== undefined && record.plotpoints !== null && typeof record.plotpoints === 'object'
                ? (record.plotpoints as Record<string, unknown>)
                : record;

        if (Array.isArray(plotpoints.beats)) {
            return chapterEntryText({
                heading: typeof plotpoints.heading === 'string' ? plotpoints.heading : undefined,
                beats: plotpoints.beats,
                dialogue: plotpoints.dialogue
            });
        }

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
