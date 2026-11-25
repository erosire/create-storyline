// The shell's binding layer: the store → the props the W10/W11 panels declare.
//
// WHY THIS FILE EXISTS. The wave boundary is the component file: `components/story-contract.ts`
// pins the props the story panels render, `api.ts`/`state.ts` pin the wire. T9's `StoryActions`
// already carries the pinned route signatures (it imports `StoryView`, `BacktrackPhase`,
// `GoalPatch`… from `./api`), so most of this is a pass-through — except for three real seams,
// each of which is why this is a module rather than one line:
//
//  1. TEMPLATES — the pinned `getStory` payload carries the assigned template IDS (D-17b: an
//     assignment list, because the count is the Author's call), while the CREW rail draws
//     template RECORDS (U-8d needs each role's `agents`/`aggregate`; U-8b needs
//     `selection_rules`). The shell resolves the ids against `GET /templates`, so the rail draws
//     crews rather than keys. An id with no card is dropped: a dangling assignment is a
//     server-side inconsistency, not something to draw.
//
//  2. ARGUMENT SHAPES — T9's interface speaks the route shapes, while several of its panels call
//     their own older local shapes. Both are real and both arrive at the same handler:
//       ProseEditor      → editSection({ storyId, chapterId, sectionId, text })   [object]
//       ProposalRow      → undo({ targetRef }) · accept() · reject()              [object / none]
//       IdeasTray        → selectIdea(ideaId) · discardIdea(ideaId) · deferIdea  [one id]
//       GoalPanel        → patchGoal(goalId, { criteria }) · setChapterBar(chapterId, override)
//       PlotlineChapters → unapproveChapter(chapterId)                            [one id]
//       StoryView rail   → createTemplate(body)
//     Every binding below accepts either form and fills the missing scope from the Story the
//     shell is showing — the shell is the only thing that knows it. Where an id is genuinely
//     unrecoverable the call rejects with a NAMED message (the top bar shows it, L-13) instead of
//     dialling `/proposals/undefined/accept` and blaming the server for a client bug.
//
//  3. WHY A SEPARATE `ShellActions` TYPE. T9's action names are still moving (`askAssistant` vs
//     the pinned `requestAssistant`). `ShellActions` declares the tolerant signatures as METHODS —
//     method parameters are bivariant, so one tolerant handler satisfies whichever precise signature
//     the interface lands on — and the object is returned as a variable, so a key their interface has
//     not adopted yet is simply ignored rather than a compile error in the shell. `selectRevision`
//     used to be left OUT of the returned object because no pinned route named it (D-24); U-13 landed
//     that route (`POST /stories/:id/revisions/:revisionId/select`), so the binding exists now and the
//     comparison pane's Select is no longer a tooltip.

import type { Chapter, Cost, Criterion, StoryPhase, Template } from '../shared/types';
import type {
    AssistantRequest,
    BacktrackPhase,
    CreateTemplateInput,
    GoalCriterionOp,
    GoalPatch,
    PhraseDetailView,
    PhraseEntryReviseInput,
    PhraseGroupReviseInput,
    PhraseStartInput,
    PhraseView,
    StoryView as ApiStoryView,
    UndoTarget
} from './api';
// T-W4 — the Phrase ② catalog key, imported as a VALUE so the shell's tolerant `startPhrase` binding and
// `state.ts:refreshPhraseDetail` address the same phrase without either spelling the word twice.
import { PHRASE_PLOTLINES_KEY } from './api';
import type { DashboardStore } from './state';
import type { StoryViewData } from './components/story-contract';

/** The view the panels render: the pinned payload with its assignment ids resolved (seam 1). */
export type ShellStoryView = Omit<StoryViewData, 'templates'> & { templates: Template[] };

/** A write a panel could not address — named so the top bar can say it (L-13). */
function unaddressed(verb: string): Promise<null> {
    return Promise.reject(new Error(`${verb} was called without the id the route needs`));
}

/** §6.3a / L-31 — ③ is the current phase, so only ① and ② can be backed into. */
const BACKTRACK_PHASES: StoryPhase[] = ['summary', 'plotlines'];

/** D-29: a selection is a recorded decision, so it carries a `why` (T-5). */
const SELECT_NOTE = 'selected by the Author';

/** The template records behind a Story's assignment ids, in assignment order. */
export function assignedTemplates(view: ApiStoryView, catalogue: Template[]): Template[] {
    const byId = new Map(catalogue.map((template) => [template.id, template]));
    return view.templates.map((id) => byId.get(id)).filter((template): template is Template => template !== undefined);
}

/**
 * The pinned payload, shaped for the panels that render it.
 *
 * R6's third argument is the SUMMARY PHRASE read the store keeps beside the Story payload: the group rail
 * and the Summary panes render group rows, and the wire sends them on their own route
 * (`GET /stories/:id/phrases`), so the shell merges the two reads into the one object the panes take.
 * `undefined` means that read has not landed (or failed) — the panes render their loading/unavailable
 * state from it rather than treating a group-managed Story as an unwritten Summary. Absent means the
 * caller has no phrase read at all, which is what keeps every existing `StoryViewData` fixture compiling.
 *
 * R-T2/F2's fourth argument is the CACHED FAILURE of that read (`state.ts:phraseErrors[storyId]`, the
 * server's own sentence). Absent `phrase` on its own cannot say whether the route is still in flight or has
 * already answered 503, and a pane that cannot tell draws a loading line over a failure forever; with the
 * sentence threaded through, the Summary area states what failed while the Story payload stays on screen.
 *
 * D-68's fifth argument is the CACHED REFUSAL of the Reviewed-Summary choose (`state.ts:reviewedErrors[storyId]`),
 * threaded the same way for the same reason: the Summary tab is where the Author clicked Choose, so the 409's
 * own sentence belongs there rather than only in the shell-wide line — and it survives the refresh the refusal
 * triggers, because the store cached it. Absent means no refusal, which is not the same claim as success: the
 * pane prints the sentence only when one is on the frame.
 *
 * R1's sixth argument is the CACHED REFUSAL SET of the group lock and unlock routes
 * (`state.ts:groupLockErrors`, keyed `<storyId>:<groupId>`). It rides the frame for the same reason the two above
 * do — the Author locked THAT GROUP from THIS pane, and a refusal that only reaches the top bar leaves an
 * unlocked group looking like a click that did nothing — and it is the whole record rather than one Story's
 * entry because the key carries the Story id, so a refusal from another book can never be looked up here.
 */
export function storyViewData(
    view: ApiStoryView,
    catalogue: Template[],
    phrase?: PhraseView | null,
    phraseError?: string | null,
    reviewedError?: string | null,
    groupLockErrors?: Record<string, string>,
    phraseDetail?: PhraseDetailView | null,
    phraseDetailError?: string | null
): ShellStoryView {
    return {
        ...view,
        ...(phrase ? { phrase } : {}),
        ...(phraseError === undefined ? {} : { phraseError }),
        ...(reviewedError === undefined ? {} : { reviewedError }),
        ...(groupLockErrors === undefined ? {} : { groupLockErrors }),
        // T-W4 — Phrase ② rides the frame exactly as the Summary read does, for the same three reasons: it is a
        // second route with its own in-flight state, its own failure sentence, and rows the pane may not invent.
        // Absent on the frame means the caller never asked for that surface, which is what keeps every existing
        // `StoryViewData` fixture compiling unchanged.
        ...(phraseDetail ? { phraseDetail } : {}),
        ...(phraseDetailError === undefined ? {} : { phraseDetailError }),
        templates: assignedTemplates(view, catalogue)
    };
}

/**
 * G-1's list edits → the route's ops. Removals first (they only apply while the criterion is
 * still there), then the surviving list in the Author's own order: a new criterion is an `add`, a
 * changed one is a `setHard`, an unchanged one says NOTHING — so a threshold-only edit never
 * rewrites the Goal.
 */
export function criteriaOps(current: Criterion[], next?: Criterion[]): GoalCriterionOp[] {
    if (!next) {
        return [];
    }
    const ops: GoalCriterionOp[] = [];
    const nextIds = new Set(next.map((criterion) => criterion.id));
    const currentById = new Map(current.map((criterion) => [criterion.id, criterion]));

    for (const criterion of current) {
        if (!nextIds.has(criterion.id)) {
            ops.push({ op: 'remove', id: criterion.id });
        }
    }
    for (const criterion of next) {
        const before = currentById.get(criterion.id);
        if (!before) {
            ops.push({ op: 'add', criterion });
        } else if (before.hard !== criterion.hard) {
            ops.push({ op: 'setHard', id: criterion.id, hard: criterion.hard });
        }
    }
    return ops;
}

/** The tolerant verb set the story panels receive (seam 2). Method syntax on purpose. */
export interface ShellActions {
    stop(storyId?: string): Promise<unknown>;
    resume(storyId?: string): Promise<unknown>;
    lockPhase(storyId?: string): Promise<unknown>;
    backtrack(storyId?: string, phase?: StoryPhase): Promise<unknown>;
    editSection(input: unknown, chapterId?: unknown, sectionId?: unknown, content?: unknown): Promise<unknown>;
    acceptProposal(storyIdOrProposalId?: string, proposalId?: string): Promise<unknown>;
    rejectProposal(storyIdOrProposalId?: string, proposalId?: string): Promise<unknown>;
    undo(input: unknown, target?: unknown): Promise<unknown>;
    selectIdea(storyIdOrIdeaId?: string, ideaIdOrNote?: string, note?: string): Promise<unknown>;
    discardIdea(storyIdOrIdeaId?: string, ideaId?: string): Promise<unknown>;
    deferIdea(storyIdOrIdeaId?: string, ideaId?: string): Promise<unknown>;
    acceptCompletion(storyId?: string): Promise<unknown>;
    patchGoal(
        storyIdOrGoalId?: string,
        patch?: GoalPatch | { criteria?: Criterion[]; threshold_soft?: number }
    ): Promise<unknown>;
    setChapterBar(storyIdOrChapterId?: string, chapterIdOrOverride?: string, barOverride?: string): Promise<unknown>;
    unapproveChapter(storyIdOrChapterId?: string, chapterId?: string): Promise<unknown>;
    /**
     * U-10b — "approve a whole chapter's worth". The pane calls it with the chapter id it already
     * knows; the Story is the shell's scope, and `why` is the audit line the server insists on (D-8).
     */
    approveChapterFindings(storyIdOrChapterId?: string, chapterIdOrWhy?: string, why?: string): Promise<unknown>;
    setAutoApprove(storyId?: string, costs?: Cost[]): Promise<unknown>;
    setSummaryReview(storyId: string, sampling: number, critics: number): Promise<unknown>;
    assignTemplates(storyId?: string, templateIds?: string[]): Promise<unknown>;
    createTemplate(input: CreateTemplateInput | Partial<Template>): Promise<unknown>;
    patchTemplate(templateId: string, patch: Partial<Template>): Promise<unknown>;
    killRun(runId: string): Promise<unknown>;
    requestAssistant(storyId?: string, request?: AssistantRequest): Promise<unknown>;
    /** The locked pane's affordance (U-4) — the same route, called with the pane's own argument. */
    askAssistant(input: {
        storyId?: string;
        field?: string;
        note?: string;
        target?: AssistantRequest['target'];
        text?: string;
    }): Promise<unknown>;
    /**
     * U-13 / D-24 — the Author takes one of a unit's competing drafts. Bound now that the route exists
     * (`POST /stories/:id/revisions/:revisionId/select`); the unit ref the panel passes is not needed
     * by the server, because the draft row carries its own `unit_ref` and D-22's sibling delete is
     * derived from it. A one-argument call reads as the draft id.
     */
    selectRevision?(unitRef?: string, revisionId?: string): Promise<unknown>;
    /**
     * U-13a / D-23 — the Author asks for named drafts to be merged instead of picking one. The drafts
     * stay competing; what lands is a `merge` task a Writer picks up.
     */
    mergeRevisions?(unitRef?: string, revisionIds?: string[], parts?: string): Promise<unknown>;
    /**
     * L-23 / U-1a — the stalled screen's "issue a directive" exit. The pane supplies only the text;
     * the Story is the shell's scope (D-29's rule, same as every other local call).
     */
    sendDirective?(storyIdOrText?: string, text?: string, refs?: string[]): Promise<unknown>;
    /** Phase ① — "not final yet": the Story is the shell's scope, the note optional. */
    requestSummaryRevision?(storyId?: string, note?: string): Promise<unknown>;
    /**
     * R2 — the Author's hand edit of ONE GROUP. The pane calls it with the group UUID the rail carries;
     * the Story is the shell's scope, exactly as with every other local call, and the tolerant shape means
     * a `(groupId, content)` call and the pinned `(storyId, groupId, input)` call both land.
     */
    revisePhraseGroup?(storyIdOrGroupId?: string, groupIdOrInput?: string, input?: PhraseGroupReviseInput): Promise<unknown>;
    /**
     * D-68 — the Author takes the Reviewed Summary. One verb, no group: the choice is the whole Overview,
     * so the only argument the route needs is the Story. The pane calls it pinned `(storyId, note?)`; a
     * bare `(note)` call is the local shape every other verb here accepts, and the Story stays the shell's
     * scope (D-29's rule). The three 409s travel back as the store's cached refusal (`state.ts:reviewedErrors`).
     */
    chooseReviewedSummary?(storyIdOrNote?: string, note?: string): Promise<unknown>;
    /**
     * R1 — the Author locks ONE GROUP in (`POST …/phrases/groups/:groupId/lock`). Like every other verb here,
     * two call shapes arrive: the pinned `(storyId, groupId)` the group pane uses, and the local `(groupId)` with
     * the Story being the shell's scope. The group is the addressed thing in both, and a call that names none is
     * a named refusal rather than a POST to `/phrases/groups/undefined/lock` (L-13).
     */
    lockPhraseGroup?(storyIdOrGroupId?: string, groupId?: string): Promise<unknown>;
    /** R1 — the Author opens a locked group again (`POST …/phrases/groups/:groupId/unlock`). Same two shapes. */
    unlockPhraseGroup?(storyIdOrGroupId?: string, groupId?: string): Promise<unknown>;
    /**
     * R2 — the Story's Editor-locking Setting. Pinned `(storyId, enabled)`; a bare `(enabled)` call is the local
     * shape every other dial here accepts (D-29's rule — the Story is the shell's scope).
     */
    setEditorGroupLocking?(storyIdOrEnabled?: string | boolean, enabled?: boolean): Promise<unknown>;
    /**
     * T-W4 — the Story's Phrase ② dial (`PATCH /stories/:id` with `plotlines_mode`). Pinned `(storyId, mode)`; the
     * local `(mode)` is the shape every dial on the Settings pane calls with (D-29's rule — the Story is the shell's
     * scope). Unlike the boolean dials, an unaddressed mode is a NAMED REFUSAL rather than a default: guessing
     * `'groups'` would hand a classic Story's Plotlines pane an entry list it never had.
     */
    setPlotlinesMode?(storyIdOrMode?: string, mode?: 'groups' | 'classic'): Promise<unknown>;
    /**
     * T-W4 — the Author STARTS an on-demand phrase (`POST …/phrases/:key/start`), the Summary→Plotlines handoff.
     * Pinned `(storyId, key, {source, text})`; the local shape drops the Story, and a call naming no phrase means
     * Phrase ② — the only on-demand phrase this desk can start, since Phrase ①'s entry set comes from the catalog
     * and the loop writes it (R1: `starts_on_demand` is catalog data).
     */
    startPhrase?(storyIdOrKey?: string, keyOrInput?: string | PhraseStartInput, input?: PhraseStartInput): Promise<unknown>;
    /**
     * T-W4 — the Author's hand edit of ONE CHAPTER ENTRY. Two call shapes like `revisePhraseGroup` above: the pinned
     * `(storyId, entryId, {plotpoints, note})` and the local `(entryId, {plotpoints, note})`. The ENTRY is the
     * addressed thing in both — its UUID comes from the rail's selection ref — and a call that names none is a named
     * refusal, not a POST to `/phrases/groups/undefined/revise`.
     */
    revisePhraseEntry?(
        storyIdOrEntryId?: string,
        entryIdOrInput?: string | PhraseEntryReviseInput,
        input?: PhraseEntryReviseInput
    ): Promise<unknown>;
}

/**
 * The bindings. `storyId` is the Story the shell is showing — the scope every local-shape call
 * leaves out, and the reason the shell rather than a panel has to own this mapping.
 */
export function shellActions(store: DashboardStore, storyId: string): ShellActions {
    /** The Story a call belongs to: its own id in the pinned shape, the shell's otherwise. */
    const scopeOf = (first?: string): string => {
        const view = store.selectedStory();
        if (!first) {
            return storyId;
        }
        if (first === storyId || first === store.getSnapshot().activeStoryId) {
            return first;
        }
        // The Goal panel passes the GOAL id (G-1 edits a Goal, not a Story); the route wants the Story.
        if (view && first === view.goal.goal.id) {
            return view.story.id;
        }
        return storyId;
    };

    /** A bare artifact id that came where a Story id was expected (the one-arg local shapes). */
    const idOr = (first?: string, second?: string): string | undefined => second ?? first;

    /** `undo` rewinds a §4.4 SPAN (D-7): a written pair, or a bare section id resolved below. */
    const undoTarget = (ref: string): UndoTarget => {
        const parts = ref.split(/[:/#]/).filter((part) => part.length > 0);
        if (parts.length >= 2) {
            return { chapter_id: parts[0] as string, section_id: parts[parts.length - 1] as string };
        }
        const sectionId = parts[0] ?? ref;
        const chapter: Chapter | undefined = store
            .selectedStory()
            ?.chapters.find((candidate) => candidate.sections.some((section) => section.id === sectionId));
        return { chapter_id: chapter?.id ?? '', section_id: sectionId };
    };

    /** GoalPanel's criterion LIST → the route's OPS; an op list passes through untouched. */
    const goalPatch = (
        patch: GoalPatch | { criteria?: Criterion[]; threshold_soft?: number } | undefined
    ): GoalPatch => {
        const criteria = patch?.criteria as GoalCriterionOp[] | Criterion[] | undefined;
        const thresholdSoft = patch?.threshold_soft;
        if (!criteria || criteria.length === 0) {
            return { threshold_soft: thresholdSoft, criteria: [] };
        }
        if (typeof (criteria[0] as GoalCriterionOp).op === 'string') {
            return { threshold_soft: thresholdSoft, criteria: criteria as GoalCriterionOp[] };
        }
        return {
            threshold_soft: thresholdSoft,
            criteria: criteriaOps(store.selectedStory()?.goal.goal.criteria ?? [], criteria as Criterion[])
        };
    };

    /** One finding/idea/proposal/chapter verb, called either pinned (storyId, id) or locally (id). */
    const scoped = (
        verb: string,
        first: string | undefined,
        second: string | undefined,
        run: (storyId: string, id: string) => Promise<unknown>
    ): Promise<unknown> => {
        const id = idOr(first, second);
        if (!id) {
            return unaddressed(verb);
        }
        return run(scopeOf(first), id);
    };

    return {
        stop: (id) => store.stop(scopeOf(id)),
        resume: (id) => store.resume(scopeOf(id)),
        // §6.3a — the route locks the CURRENT phase, so a phase argument is advisory.
        lockPhase: (id) => store.lockPhase(scopeOf(id)),
        backtrack: (id, phase) => {
            const target = phase as BacktrackPhase;
            if (!BACKTRACK_PHASES.includes(target)) {
                return Promise.resolve(null);
            }
            return store.backtrack(scopeOf(id), target);
        },
        editSection: (input, chapterId, sectionId, content) => {
            if (typeof input === 'object' && input !== null) {
                const body = input as {
                    storyId?: string;
                    chapterId?: string;
                    sectionId?: string;
                    text?: string;
                    content?: string;
                };
                if (!body.chapterId || !body.sectionId) {
                    return unaddressed('editSection');
                }
                return store.editSection(
                    scopeOf(body.storyId),
                    body.chapterId,
                    body.sectionId,
                    body.text ?? body.content ?? ''
                );
            }
            if (typeof input !== 'string' || typeof chapterId !== 'string' || typeof sectionId !== 'string') {
                return unaddressed('editSection');
            }
            return store.editSection(input, chapterId, sectionId, typeof content === 'string' ? content : '');
        },
        acceptProposal: (first, second) =>
            scoped('acceptProposal', first, second, (id, proposalId) => store.acceptProposal(id, proposalId)),
        rejectProposal: (first, second) =>
            scoped('rejectProposal', first, second, (id, proposalId) => store.rejectProposal(id, proposalId)),
        undo: (input, target) => {
            if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
                const body = input as { targetRef?: string };
                if (!body.targetRef) {
                    return unaddressed('undo');
                }
                // A proposal's `target_ref` names the span; the Story is the one on screen.
                return store.undo(storyId, undoTarget(body.targetRef));
            }
            if (typeof input === 'string' && typeof target === 'object' && target !== null) {
                return store.undo(scopeOf(input), target as UndoTarget);
            }
            if (typeof input === 'string') {
                return store.undo(storyId, undoTarget(input));
            }
            return unaddressed('undo');
        },
        // D-29 — IdeasTray hands over only the Idea id; the note is the shell's, because the
        // route requires one and a selection is a recorded decision (T-5).
        selectIdea: (first, second, note) => {
            const ideaId = idOr(first, second);
            if (!ideaId) {
                return unaddressed('selectIdea');
            }
            return store.selectIdea(scopeOf(first), ideaId, note ?? SELECT_NOTE);
        },
        discardIdea: (first, second) =>
            scoped('discardIdea', first, second, (id, ideaId) => store.discardIdea(id, ideaId)),
        deferIdea: (first, second) => scoped('deferIdea', first, second, (id, ideaId) => store.deferIdea(id, ideaId)),
        acceptCompletion: (id) => store.acceptCompletion(scopeOf(id)),
        patchGoal: (id, patch) => store.patchGoal(scopeOf(id), goalPatch(patch)),
        setChapterBar: (first, second, third) => {
            if (!second) {
                return unaddressed('setChapterBar');
            }
            // Pinned: (storyId, chapterId, override). Local (GoalPanel): (chapterId, override).
            return third !== undefined
                ? store.setChapterBar(first as string, second, third)
                : store.setChapterBar(storyId, first as string, second);
        },
        unapproveChapter: (first, second) =>
            scoped('unapproveChapter', first, second, (id, chapterId) => store.unapproveChapter(id, chapterId)),
        // U-10b. Pinned: (storyId, chapterId, why). Local to the chapter row: (chapterId, why) — the
        // Story is the shell's scope, exactly as with `setChapterBar` above.
        approveChapterFindings: (first, second, third) => {
            if (!second) {
                return unaddressed('approveChapterFindings');
            }

            return third !== undefined
                ? store.approveChapterFindings(first as string, second, third)
                : store.approveChapterFindings(storyId, first as string, second);
        },
        setAutoApprove: (id, costs) => store.setAutoApprove(scopeOf(id), costs ?? []),
        // Phase ①'s two dials: the sample count and the Critic passes per sample. One write so the
        // pane can never save a sampling value against a stale critic count.
        setSummaryReview: (id, sampling, critics) =>
            store.patchStory(scopeOf(id), { summary_sampling: sampling, summary_critics: critics }),
        assignTemplates: (id, templateIds) => store.assignTemplates(scopeOf(id), templateIds ?? []),
        createTemplate: (input) =>
            store.createTemplate(
                'template' in input || 'duplicate_of' in input
                    ? (input as CreateTemplateInput)
                    : { template: input as CreateTemplateInput['template'] }
            ),
        patchTemplate: (templateId, patch) => store.patchTemplate(templateId, patch),
        killRun: (runId) => store.killRun(runId),
        requestAssistant: (id, request) => {
            if (!request) {
                return unaddressed('requestAssistant');
            }
            return store.requestAssistant(scopeOf(id), request);
        },
        askAssistant: (input) =>
            store.requestAssistant(scopeOf(input.storyId), {
                // A note on the Summary is a `summary` request; anything else is written as a directive.
                target: input.target ?? (input.field === 'directive' ? 'directive' : 'summary'),
                text: input.text ?? input.note ?? ''
            }),
        // U-13 / D-24 — the comparison pane's "Select this draft". The pane calls it with
        // (unitRef, revisionId); a one-argument call names the draft alone, which is enough: the row
        // carries its own `unit_ref` and the server derives D-22's sibling delete from it. The Story
        // scope is the shell's (`scopeOf` would read the UNIT ref as a Story id, so it is not used).
        selectRevision: (unitRef, revisionId) => {
            const draftId = revisionId ?? unitRef;

            if (!draftId) {
                return unaddressed('selectRevision');
            }

            return store.selectRevisionAuthor(storyId, draftId);
        },
        // U-13a / D-23 — the same pane's merge request. It queues work; it never picks a winner.
        mergeRevisions: (unitRef, revisionIds, parts) => {
            if (!unitRef) {
                return unaddressed('mergeRevisions');
            }

            return store.mergeRevisions(storyId, {
                unit_ref: unitRef,
                revision_ids: revisionIds ?? [],
                parts: parts ?? ''
            });
        },
        // L-23 / U-1a — the stalled screen's directive exit. The pane hands over only the sentence, so
        // a one-argument call reads as the TEXT and the shell supplies the Story; the pinned
        // (storyId, text) shape passes straight through (D-29's rule, as for the Idea tray).
        sendDirective: (first, second, refs) =>
            second === undefined
                ? store.sendDirective(storyId, first ?? '', refs)
                : store.sendDirective(first ?? storyId, second, refs),
        requestSummaryRevision: (id, note) => store.requestSummaryRevision(scopeOf(id), note),
        // R2 — the group pane's hand edit. Two call shapes arrive here, as everywhere in this file: the
        // pinned `(storyId, groupId, { content, note })`, and the pane's local `(groupId, content)` with
        // the Story being the shell's scope. The GROUP is the addressed thing in both, so a one-argument
        // object call still lands on the right row, and a missing group is a named refusal rather than a
        // POST to `/phrases/groups/undefined/revise` (L-13).
        revisePhraseGroup: (first, second, input) => {
            /** The last argument that carries the text: a plain string is the content, an object is the body. */
            const bodyOf = (value: unknown): PhraseGroupReviseInput | undefined => {
                if (typeof value === 'string') return { content: value };
                if (value && typeof value === 'object' && !Array.isArray(value)) {
                    const body = value as PhraseGroupReviseInput;

                    return { content: body.content ?? '', ...(body.note ? { note: body.note } : {}) };
                }
                return undefined;
            };

            const pinned = bodyOf(input);

            if (pinned !== undefined && typeof second === 'string') {
                return store.revisePhraseGroup(scopeOf(first), second, pinned);
            }

            const local = bodyOf(second);

            if (local === undefined || typeof first !== 'string') {
                return unaddressed('revisePhraseGroup');
            }

            return store.revisePhraseGroup(storyId, first, local);
        },
        // D-68 — the Author's whole-Summary choose. Two call shapes, as everywhere in this file: the pinned
        // `(storyId, note)` and the pane-local `(note)` with the Story being the shell's scope. Only an
        // argument that ACTUALLY names this book is read as the Story — `scopeOf` alone would take a
        // free-text note and hand it to the route table as an id, which is how L-13's named refusals exist.
        chooseReviewedSummary: (first, second) => {
            const view = store.selectedStory();
            const namesStory =
                first !== undefined &&
                (first === storyId ||
                    first === store.getSnapshot().activeStoryId ||
                    first === view?.goal.goal.id);

            return store.chooseReviewedSummary(scopeOf(first), second ?? (namesStory ? undefined : first));
        },
        // R1 — the lock pair. Both take the pinned `(storyId, groupId)` and the pane-local `(groupId)`, and the
        // GROUP is what they address, so `scopeOf` is only consulted when a second argument proves the first one
        // was a Story id. A call naming no group is L-13's named refusal, not a POST to `…/groups/undefined/lock`.
        lockPhraseGroup: (first, second) => {
            const groupId = second ?? (typeof first === 'string' && second === undefined ? first : undefined);

            if (!groupId) {
                return unaddressed('lockPhraseGroup');
            }

            return store.lockPhraseGroup(second === undefined ? storyId : scopeOf(first), groupId);
        },
        unlockPhraseGroup: (first, second) => {
            const groupId = second ?? (typeof first === 'string' && second === undefined ? first : undefined);

            if (!groupId) {
                return unaddressed('unlockPhraseGroup');
            }

            return store.unlockPhraseGroup(second === undefined ? storyId : scopeOf(first), groupId);
        },
        // R2 — the Editor-locking dial. `setAutoApprove` above is the sibling: one Story patch, one boolean, and
        // the Story is the shell's scope when the pane calls it locally. A bare `(storyId)` with no value reads
        // as ENABLE — the way every other dial in this file reads a call that omits its argument — so the value
        // the Setting shows afterwards is still the one the server echoed, never the one the call implied.
        setEditorGroupLocking: (first, second) =>
            typeof first === 'boolean'
                ? store.setEditorGroupLocking(storyId, first)
                : store.setEditorGroupLocking(scopeOf(first), second ?? true),
        // T-W4 — the Phrase ② dial, `setEditorGroupLocking`'s sibling with one difference that matters: the value is
        // a WORD, and there is no safe default for it. A boolean dial can read a missing argument as "on" and stay
        // honest, because the Author just clicked it; a pipeline dial that guessed `'groups'` would restyle a whole
        // Story from a call that never named a mode. So an unaddressed mode is L-13's named refusal.
        setPlotlinesMode: (first, second) => {
            const mode =
                second === 'groups' || second === 'classic'
                    ? second
                    : first === 'groups' || first === 'classic'
                      ? first
                      : undefined;

            if (mode === undefined) {
                return unaddressed('setPlotlinesMode');
            }

            return store.setPlotlinesMode(mode === first ? storyId : scopeOf(first), mode);
        },
        // T-W4 — the handoff. Pinned `(storyId, key, {source, text})`; the local shape drops the Story, and the
        // phrase is Phrase ② either way — the only on-demand phrase this desk offers, since a phrase the loop writes
        // refuses the verb outright (R1: `starts_on_demand` is catalog data). The body is whatever argument actually
        // carries an object, so `{source:'custom', text}` survives both shapes and a bare call means `'compiled'`.
        startPhrase: (first, second, input) => {
            const bodyOf = (value: unknown): PhraseStartInput | undefined =>
                value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
                    ? (value as PhraseStartInput)
                    : undefined;

            const key =
                typeof second === 'string'
                    ? second
                    : typeof first === 'string' && first !== storyId && first !== store.getSnapshot().activeStoryId
                      ? first
                      : PHRASE_PLOTLINES_KEY;

            return store.startPhrase(scopeOf(first), key, bodyOf(input) ?? bodyOf(second));
        },
        // T-W4 — ONE CHAPTER ENTRY's hand edit, in `revisePhraseGroup`'s two-shape pattern. The body must carry
        // `plotpoints`: that IS the entry's text (the route composes the prose from the contract fields and refuses
        // an entry without them, P4), so a call whose body names only `content` is unaddressed here rather than a
        // Summary revise wearing the wrong verb.
        revisePhraseEntry: (first, second, input) => {
            /** The body of a chapter-entry revise: `plotpoints` is the text, so an object without them is no body. */
            const bodyOf = (value: unknown): PhraseEntryReviseInput | undefined => {
                if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
                    return undefined;
                }

                const body = value as PhraseEntryReviseInput;

                if (body.plotpoints === undefined || typeof body.plotpoints !== 'object') return undefined;

                return { plotpoints: body.plotpoints, ...(body.note ? { note: body.note } : {}) };
            };

            const pinned = bodyOf(input);

            if (pinned !== undefined && typeof second === 'string') {
                return store.revisePhraseEntry(scopeOf(first), second, pinned);
            }

            const local = bodyOf(second);

            if (local === undefined || typeof first !== 'string') {
                return unaddressed('revisePhraseEntry');
            }

            return store.revisePhraseEntry(storyId, first, local);
        }
    };
}
