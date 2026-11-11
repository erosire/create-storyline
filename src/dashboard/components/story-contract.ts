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
    Proposal,
    Revision,
    Run,
    Story,
    StoryPhase,
    Template,
    TemplateRole,
    Verdict
} from '../../shared/types';

export type { CompletionPreview, CostDistribution, FailingCriterion };

/**
 * The pinned `getStory(id)` payload (U-4…U-17) with ONE widening: `templates` carries the
 * RESOLVED records rather than the assigned id list.
 *
 * WHY: the pinned wire carries ids (D-17b — assignment is a list of ids), but every panel that
 * draws a template needs the RECORD (U-8d needs `roles[].agents`/`aggregate`, U-8b needs
 * `selection_rules`, U-8c needs `attempts`). The shell resolves the ids against
 * `GET /templates` before rendering (`assignedTemplates`/`storyViewData` in `../shell-binding.ts`,
 * whose `ShellStoryView` is structurally this type), so no panel has to reach for the catalogue
 * itself and no panel invents a second read.
 */
export type StoryViewData = Omit<StoryView, 'templates'> & { templates: Template[] };

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
 *   - an Author write to the SUMMARY has no route either; §8.6's `requestAssistant` is the
 *     sanctioned one-field write, and that is what SummaryPane offers (U-4).
 */
export interface StoryActions {
    /** P8 / D-37 — halt dispatch and kill in-flight runs. Also the Author's Pause & edit. */
    stop?: (storyId: string) => Promise<unknown> | unknown;
    /** D-37a — re-arm to `ready`; the Author's edit is processed as a commit (Digest re-derived). */
    resume?: (storyId: string) => Promise<unknown> | unknown;
    /** U-16 — locks the CURRENT phase; the server 409s naming the Ideas tray when it is non-empty (L-7a). */
    lockPhase?: (storyId: string) => Promise<unknown> | unknown;
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

/** Decision item 8 — the UI vocabulary is Seed, Summary, plotline, chapter; the numbers are the strip. */
export const PHASE_LABELS: Record<StoryPhase, string> = {
    summary: '① Summary',
    plotlines: '② Plotlines',
    chapters: '③ Chapters'
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

/** The competing revisions of one unit (D-23: more than one and the unit cannot advance). */
export function competingRevisionsFor(revisions: Revision[], unitRef: string): Revision[] {
    return revisions.filter((revision) => revision.unit_ref === unitRef && revision.state === 'competing');
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
