// The Story's navigation model: four PHRASES plus the folders that support them.
//
// WHY THIS IS A SEPARATE PURE MODULE: the rail, the pane header and the Summary's review badge all
// read the same handful of rules ("is the Summary ready for review", "which overview did the
// Editor's verdict recommend"), and a rule that lives in a component would be a second copy the
// moment another surface needs it. The server still owns every record; this file only names the
// sections and derives the two UI-facing readouts (a tick and a recommendation) from them.
//
// THE PHRASES AND THE LOOP'S PHASES ARE NOT THE SAME NUMBERING ANY MORE. The Author's pipeline is
// four reading phrases — Summary, Characters, Plotlines, Chapters. The loop's `story.phase` still
// moves through its three locked artifacts; Characters is a supporting sheet the crew builds from
// the Summary, so it has no `StoryPhase` of its own yet (the "Phrase 2 can be started" step).
import type { Chapter, Finding, Plotline, Revision, Run, Verdict } from '../../shared/types';
import type { PhraseGroupRow } from './story-contract';
import {
    buildRevisionUnits,
    findingAppliesToRevision,
    findingGroups,
    findingRevisionScope,
    groupBlockingFindings,
    groupOpenFindings,
    groupOpenTasks,
    isDecidedIdea,
    isGroupSummary,
    isGroupWriterBusy,
    isGroupWritten,
    isPendingRevision,
    isReviewableRevision,
    isSupersededSummaryDraft,
    phraseGroupById,
    phraseGroups,
    phraseReadLanded,
    selectedSummaryRevision,
    summaryBlockingFindings,
    summaryScopeContext,
    unwrittenGroups
} from './story-contract';
import type { FindingRevisionScope, RevisionUnit, StoryViewData } from './story-contract';

/** The four reading phrases, in the Author's order. */
export type StoryPhraseKey = 'summary' | 'characters' | 'plotlines' | 'chapters';

/** The supporting folders under the phrases. */
export type StoryFolderKey = 'continuity' | 'goal' | 'ideas' | 'findings' | 'digest' | 'settings';

/** The one legacy leaf the rail still offers: the Seed is pinned truth, not a phrase. */
export type StoryPanelKey = StoryPhraseKey | StoryFolderKey | 'seed';

/**
 * What the content area is showing. `ref` names one entry inside a phrase (a cast member, a
 * plotline, a chapter); absent means the phrase's own overview. A folder never carries a ref.
 */
export interface StorySelection {
    panel: StoryPanelKey;
    ref?: string;
}

export const DEFAULT_STORY_SELECTION: StorySelection = { panel: 'summary' };

export interface StoryPhraseSpec {
    key: StoryPhraseKey;
    number: number;
    title: string;
}

/**
 * The rail's PHRASES. U1 is the product's decision, not a rendering detail: for now the Author's Story
 * workspace has ONE phrase — Summary — and the folders that support it. Characters, Plotlines and
 * Chapters are later phases: their panes, their rail helpers and their tests stay in the build, and the
 * rail offers no row, card or dropdown that navigates to them, so an Author on the Summary workspace
 * cannot click through to a phase the product has not turned on yet.
 *
 * This is the ACTIVE list. `ALL_STORY_PHRASES` below keeps the full four-phrase vocabulary for the panes
 * that still address a phrase directly (`StoryView` routes a `panel` prop, and a later phase hands the
 * same selection object in), so narrowing the rail never means a pane's title reads "The story".
 */
export const STORY_PHRASES: readonly StoryPhraseSpec[] = [
    { key: 'summary', number: 1, title: 'Summary' }
];

/** The full phrase vocabulary, in reading order: the rail shows {@link STORY_PHRASES}, the panes route on all four. */
export const ALL_STORY_PHRASES: readonly StoryPhraseSpec[] = [
    { key: 'summary', number: 1, title: 'Summary' },
    { key: 'characters', number: 2, title: 'Characters' },
    { key: 'plotlines', number: 3, title: 'Plotlines' },
    { key: 'chapters', number: 4, title: 'Chapters' }
];

export interface StoryFolderSpec {
    key: StoryFolderKey;
    title: string;
}

export const STORY_FOLDERS: readonly StoryFolderSpec[] = [
    { key: 'continuity', title: 'Continuity' },
    { key: 'goal', title: 'Goal' },
    { key: 'ideas', title: 'Ideas' },
    { key: 'findings', title: 'Findings' },
    { key: 'digest', title: 'Digest' },
    { key: 'settings', title: 'Settings' }
];

/** The rail's heading for a phrase: "Phrase 1 — Summary". */
export function phraseLabel(spec: StoryPhraseSpec): string {
    return `Phrase ${spec.number} — ${spec.title}`;
}

// ---------------------------------------------------------------------------
// Summary readiness and the Editor's recommendation
// ---------------------------------------------------------------------------

/**
 * U-4's review step: the Summary is reviewable when its goal has passed (the loop has nothing
 * left to improve) or when the Author has already signed it. A locked Summary keeps its tick —
 * the rail should not make a signed artifact look unfinished.
 *
 * The defect check goes through `summaryBlockingFindings`, the SAME read `lockCheck` uses, so the tick
 * and the Accept button can never disagree about which revision a finding sits on (T5).
 */
export function summaryReadyForReview(view: StoryViewData): boolean {
    if (storyInSummaryPhase(view) && isGroupSummary(view)) {
        // R6 — THE GROUP DERIVATION. A grouped Summary is ready when the Overview is fully written and
        // nothing on it is outstanding: no unwritten group (R1), no open finding at the Summary's blocking
        // costs scoped to any group (R3), no open group task, and no live Writer pass holding a group (R4 —
        // a Summary that is about to move is not ready to sign). None of this reads `sampling.active_round`,
        // which is a sampler-pipeline number a grouped Story never runs.
        // R-T2/F1 — THE READ IS A PRECONDITION, NOT ONE OF THE CHECKS. Every clause below counts rows, and
        // `phraseGroups` answers `[]` for a phrase read that has not landed, so an in-flight (or failed) read
        // would fall through all four checks and the rail would tick a five-group Summary it has never seen —
        // while the Accept button, which reads `groupSignOffBlockers`, refuses on exactly that fact. An
        // already-locked book is no exception: with no rows the desk cannot show what was signed.
        if (!phraseReadLanded(view)) return false;
        if (view.story.summary_locked) return true;
        if (view.goal.failing.length > 0) return false;
        if (unwrittenGroups(view).length > 0) return false;
        if (phraseGroups(view).some(isGroupWriterBusy)) return false;
        if (groupOpenTasks(view).length > 0) return false;

        return phraseGroups(view).every((group) => groupBlockingFindings(view, group.id).length === 0);
    }

    if (view.story.summary_locked) {
        return true;
    }

    const summary = view.summary;
    const prose =
        summary !== null &&
        summary !== undefined &&
        [summary.premise, summary.promise, summary.theme, summary.tone, summary.ending, summary.world_rules].some(
            (field) => typeof field === 'string' && field.trim().length > 0
        );

    if (!storyInSummaryPhase(view) || !prose || view.goal.failing.length > 0) return false;
    if (summaryHasCompetingRevisions(view)) return false;

    // No selected draft means the round has not settled yet, and there is no winner to hold a defect
    // against; `summaryBlockingFindings` answers the empty case with an empty list.
    return summaryBlockingFindings(view, selectedSummaryRevision(view)).length === 0;
}

function storyInSummaryPhase(view: StoryViewData): boolean {
    return view.story.phase === 'summary';
}

/**
 * The standalone Summary review unit U-13 renders. Only COMPETING drafts are offered: a revision
 * that is already `selected` is the Summary on record, and re-presenting it as a choice would
 * ask the Author to decide something twice. `undefined` when no draft is waiting.
 *
 * T11/F2: a `drafted`/`competing` row from an OLDER round is not an offer either. The loop set it
 * aside when it chose this round's winner, so `POST /revisions/:id/select` is the one thing the Author
 * cannot meaningfully do with it — the same exclusion `work.ts`'s candidates and
 * `records.ts:isSupersededSummaryDraft` apply.
 */
export function summaryRevisionUnit(view: StoryViewData): RevisionUnit | undefined {
    const unit = buildRevisionUnits(view).find((candidate) => candidate.unitKind === 'summary');

    if (!unit) {
        return undefined;
    }

    const context = summaryScopeContext(view);
    const competing = unit.revisions.filter(
        (revision) => isReviewableRevision(revision) && !isSupersededSummaryDraft(view, revision, context)
    );

    return competing.length === 0 ? undefined : { ...unit, revisions: competing };
}

/**
 * The draft the last verdict on THAT DRAFT advanced. The book records a recommendation, not an
 * author, on §4.9; `advance` on a hard pass is the only combination that reads as "take this one".
 * A verdict filed against the unit is deliberately NOT used here: it judges the set, not one
 * overview, and picking a column from it would invent a preference nobody stated.
 */
export function recommendedRevisionId(unit: RevisionUnit | undefined): string | undefined {
    if (!unit) {
        return undefined;
    }

    let best: { id: string; at: string } | undefined;

    for (const revision of unit.revisions) {
        const own = unit.verdictsByRevision[revision.id] ?? [];
        const latest = newestAdvancingVerdict(own);

        if (latest === undefined) {
            continue;
        }

        if (best === undefined || latest.updated_at > best.at) {
            best = { id: revision.id, at: latest.updated_at };
        }
    }

    return best?.id;
}

function newestAdvancingVerdict(verdicts: Verdict[]): Verdict | undefined {
    const advancing = verdicts
        .filter((verdict) => verdict.hard_pass && verdict.recommendation === 'advance')
        .sort((left, right) => left.updated_at.localeCompare(right.updated_at) || left.id.localeCompare(right.id));

    return advancing[advancing.length - 1];
}

// ---------------------------------------------------------------------------
// Phase ①'s flat revision history — Revision 1…N and the findings filed against each
// ---------------------------------------------------------------------------

/**
 * Phase ①'s Summary history is a FLAT list, not a sampling tree:
 *
 *     Summary
 *     - Revision 1
 *     - Revision 2
 *     …
 *     - Revision 6
 *
 * Every round writes three complete drafts (Revision 1, 2, 3), the engine's deterministic selection
 * keeps one (§16.6, D-47 — no Editor picks a column in phase ①), and the drafts it did not keep read as
 * `discarded` history. The rows are never deleted by the rail; the rail is the Author's record of every
 * version tried.
 */
export interface SummaryRevisionEntry {
    revision: Revision;
    /** The rail's 1-based label, in creation order. */
    index: number;
    /** Findings the Readers filed against THIS revision. */
    findings: Finding[];
    /**
     * How each listed finding is scoped, keyed by finding id (T11/F6). The pane needs it because the
     * finding's own refs do not read as prose: a whole-artifact row (`records.ts:findingRevisionScope`
     * answers `artifact`) is a statement about the Summary, and labelling it "on this revision" on every
     * card would put the same sentence under six different drafts. `selected`/`superseded` rows name the
     * draft they are about, and only that card may claim them.
     */
    findingScopes: Record<string, FindingRevisionScope>;
    /** The Editor's verdicts that judged this revision or one of its findings. */
    editorVerdicts: Verdict[];
    /** The Editor's note if this revision won a selection. */
    editorNote?: { note: string; at: string };
    /**
     * Why a `discarded` draft was parked, for the rail's marker and the opened revision (T4/R1).
     *
     * Derived from `Revision.discard_reason` — the explanation the selection commit writes alongside the
     * state. It is TRIMMED, it is read only while the row's state really is `discarded` (a draft a backtrack
     * re-selects keeps its old reason on the record, and this is not a statement about a draft on record),
     * and it is ABSENT when the row carries none, because legacy rows (and blank writes) predate the field:
     * the dashboard may mark a draft as discarded without a reason, but it may never invent one. It is NOT
     * `selection_note` — that one belongs to the draft that WON, and putting it on a loser would present the
     * winner's praise as the loser's fault. The wording stays NEUTRAL ("Discard reason", never "Editor's"):
     * phase ① settles a round by the deterministic selector (§16.6, D-47), so nothing in a phase-① discard
     * is an Editor's sentence.
     */
    discardReason?: string;
}

const SUMMARY_REVISION_PREFIX = 'revision:';

/** The rail ref for one Summary revision. */
export const summaryRevisionRef = (revisionId: string): string => `${SUMMARY_REVISION_PREFIX}${revisionId}`;

/** Reads a rail ref back into the revision id. */
export function parseSummaryRevisionRef(ref: string | undefined): string | undefined {
    if (ref === undefined || !ref.startsWith(SUMMARY_REVISION_PREFIX)) return undefined;

    const id = ref.slice(SUMMARY_REVISION_PREFIX.length);

    return id.length > 0 ? id : undefined;
}

/** The rail's revision selection, resolved against the live rows. */
export function summaryRevisionFocus(
    view: StoryViewData,
    selection: StorySelection
): SummaryRevisionEntry | undefined {
    if (selection.panel !== 'summary') return undefined;

    const id = parseSummaryRevisionRef(selection.ref);

    return id === undefined ? undefined : summaryRevisions(view).find((entry) => entry.revision.id === id);
}

/** Oldest first, with a stable id tie-break so a refetch never reshuffles the rail. */
function byDraftAge(left: Revision, right: Revision): number {
    return left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id);
}

/** Every Summary revision in creation order, with the findings filed against it. */
export function summaryRevisions(view: StoryViewData): SummaryRevisionEntry[] {
    const summary = view.summary;

    if (summary === null || summary === undefined) return [];

    const verdicts = view.verdicts ?? [];
    const runById = new Map<string, Run>(view.runs.map((run) => [run.id, run]));
    // ONE scope read for the whole list (T11/F4): the rail's badges, the pane's rows and their copy, the
    // review tick and `lockCheck`'s blocker count all answer from the same round/draft map, so a finding
    // cannot be a blocker on one surface and invisible on another.
    const context = summaryScopeContext(view);
    const drafts = view.revisions
        .filter((revision) => revision.unit_kind === 'summary' && revision.unit_ref === summary.id)
        .sort(byDraftAge);

    return drafts.map((revision, position) => {
        const draftVerdicts = verdicts.filter((verdict) => verdict.target_ref === revision.id);
        const findingIds = new Set<string>();

        for (const verdict of draftVerdicts) {
            for (const line of verdict.criteria_passed) {
                if (line.finding_ref !== undefined) findingIds.add(line.finding_ref);
            }
        }

        const findings = view.findings
            .filter(
                (finding) =>
                    findingIds.has(finding.id) ||
                    // T5 + T11/F4: the pane's attribution rule IS `findingAppliesToRevision`, the same one
                    // the lock counts blockers with. A whole-artifact row — no refs, or refs that name the
                    // Summary row, a brief or a criterion rather than a draft — is therefore listed HERE
                    // too, on the selected revision, exactly where the Accept button says it is holding
                    // the lock; a row naming another draft is listed on THAT draft and never on the
                    // winner. Neither half may be silently dropped.
                    findingAppliesToRevision(finding, revision.id, summary.id, context)
            )
            .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));

        // The scope rides with the row so the pane's copy is the SAME decision, not a second guess
        // (T11/F6). Only the listed rows are keyed; a retired draft's findings are still visible there.
        const findingScopes: Record<string, FindingRevisionScope> = {};

        for (const finding of findings) {
            findingScopes[finding.id] = findingRevisionScope(finding, context);
        }

        const editorVerdicts = verdicts.filter((verdict) => {
            const run = verdict.run_ref === undefined ? undefined : runById.get(verdict.run_ref);
            const judge = run?.role ?? '';

            if (judge !== 'editor' && !/editor/i.test(verdict.template_ref ?? '')) return false;

            if (verdict.target_ref === revision.id) return true;

            return verdict.criteria_passed.some(
                (line) => line.finding_ref !== undefined && findingIds.has(line.finding_ref)
            );
        });

        // T4/R1: the discard explanation is narrow on purpose, twice over.
        //   - it is read ONLY while the row really is `discarded`: a draft a backtrack re-selects keeps its
        //     old reason on the record, and showing it there would tell the Author this draft is parked when
        //     it is the one on record;
        //   - it is TRIMMED and OMITTED when blank, so a legacy `discarded` row (no field, or a blank write)
        //     yields `undefined` and the surfaces mark the discard without fabricating a reason (L-17).
        const discardReason = revision.state === 'discarded' ? (revision.discard_reason ?? '').trim() : '';

        return {
            revision,
            index: position + 1,
            findings,
            findingScopes,
            editorVerdicts,
            ...((revision.selection_note ?? '').trim().length > 0
                ? { editorNote: { note: (revision.selection_note ?? '').trim(), at: revision.updated_at } }
                : {}),
            ...(discardReason.length > 0 ? { discardReason } : {})
        };
    });
}

// ---------------------------------------------------------------------------
// SUMMARY PHRASE — the group rail's refs and focus (R6 / U2)
//
// A GROUP REF IS A UUID WITH A PREFIX. The rail addresses a group by `summary-group:<uuid>`, so:
//   - the selection survives a phrase refetch, a server restart, and a catalog reorder — the id is the
//     row's identity, and `order`/index is only what the rail displays in that order;
//   - a group that stops existing (a Story switched back to `sampling`, a deleted book) fails
//     `selectionExists` and falls back to the Summary overview instead of opening an empty pane;
//   - the prefix keeps a group ref distinguishable from the legacy `revision:<id>` ref the same panel
//     used before the redesign, so a payload from an older build cannot be read as a group.
// ---------------------------------------------------------------------------

const SUMMARY_GROUP_PREFIX = 'summary-group:';

/** The rail ref for one Summary group. */
export const summaryGroupRef = (groupId: string): string => `${SUMMARY_GROUP_PREFIX}${groupId}`;

/** Reads a rail ref back into the group id; `undefined` for anything that is not a group ref. */
export function parseSummaryGroupRef(ref: string | undefined): string | undefined {
    if (ref === undefined || !ref.startsWith(SUMMARY_GROUP_PREFIX)) return undefined;

    const id = ref.slice(SUMMARY_GROUP_PREFIX.length);

    return id.length > 0 ? id : undefined;
}

/**
 * True once the phrase read has landed for this Story — what separates "loading" from "stale" (U6).
 *
 * R-T2/F1 moved the ANSWER into `story-contract` (as `phraseReadLanded`): the sign-off gate needs the same
 * predicate, and a contract module may not import from the rail's navigation model. The rail keeps reading
 * it as `phraseLoaded`, which is the name its loading line is written against.
 */
export const phraseLoaded = phraseReadLanded;

/** The rail's group selection, resolved against the live rows; `undefined` names no live group. */
export function summaryGroupFocus(
    view: StoryViewData,
    selection: StorySelection
): PhraseGroupRow | undefined {
    if (selection.panel !== 'summary') return undefined;

    const id = parseSummaryGroupRef(selection.ref);

    return id === undefined ? undefined : phraseGroupById(view, id);
}

/**
 * The rail's children of the Summary phrase: the server's group rows, in composition order, each with
 * the badge the rail paints and the ref it navigates by.
 *
 * NO REVISION ROWS HERE (U2). The old rail listed `Revision 1 … Revision N` because phase ① wrote whole
 * Summary drafts; the group model writes five named parts, so the rail's children are the GROUPS and the
 * revision number belongs in the group's own detail (U3). Archived history is not a rail row either: the
 * projection keeps it as metadata (R2), and a row a reader cannot open would be decoration.
 */
export interface SummaryGroupEntry {
    group: PhraseGroupRow;
    /** The selection ref — `summary-group:<uuid>`. */
    ref: string;
    /** Open findings at the Summary's blocking costs that name this group; 0 draws no badge. */
    blockingFindings: number;
    /** Every open finding that names this group, including the costs the dial tolerates. */
    openFindings: number;
    /** The Writer holds this group's text right now (F8/R4). */
    writerBusy: boolean;
    /** Written at least once: `revision > 0` is the loop's "never written" line (R1). */
    written: boolean;
}

export function summaryGroupEntries(view: StoryViewData): SummaryGroupEntry[] {
    return phraseGroups(view).map((group) => ({
        group,
        ref: summaryGroupRef(group.id),
        blockingFindings: groupBlockingFindings(view, group.id).length,
        openFindings: groupOpenFindings(view, group.id).length,
        writerBusy: isGroupWriterBusy(group),
        written: isGroupWritten(group)
    }));
}

/**
 * The revision the Summary row carries, for the "final Summary" decision (§6.6).
 *
 * The IMPLEMENTATION moved to `story-contract.ts` (T5): the lock needs the same draft and cannot import
 * this module (story-nav imports story-contract, not the reverse). The name stays re-exported here so
 * every rail/pane call site keeps reading its own module.
 */
export { selectedSummaryRevision };

/**
 * True while a Summary round has not settled: drafts are still `drafted`/`competing`, or a Writer is
 * still filling a block.
 *
 * The wording matters after R3: phase ①'s round is settled by the engine's deterministic selection
 * (§16.6, D-47), not by an Editor picking a column, so nothing here waits for a choice that never
 * arrives — it waits for the round to finish.
 */
export function summaryHasCompetingRevisions(view: StoryViewData): boolean {
    const summary = view.summary;

    if (summary === null || summary === undefined) return false;

    const context = summaryScopeContext(view);

    // Pending drafts are not competition yet, but they are still open work: the Summary must not
    // look ready for review while a Writer is still filling its blocks (§4.15). A REVIEWABLE draft of an
    // older round is neither: the loop already chose past it (T11/F2), so it must not hold the tick the
    // settled round has earned (`records.ts:unitsWithCompetingRevisions` makes the same cut).
    return view.revisions.some(
        (revision) =>
            revision.unit_kind === 'summary' &&
            revision.unit_ref === summary.id &&
            (isPendingRevision(revision) ||
                (isReviewableRevision(revision) && !isSupersededSummaryDraft(view, revision, context)))
    );
}

// ---------------------------------------------------------------------------
// The phrases' entries
// ---------------------------------------------------------------------------

/** The cast in the order the crew created it (the sheet is stable; sorting by name would jump). */
export function castMembers(view: StoryViewData) {
    return [...view.cast].sort(
        (left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id)
    );
}

export function plotlinesInOrder(view: StoryViewData): Plotline[] {
    return [...view.plotlines].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

export function chaptersInOrder(view: StoryViewData): Chapter[] {
    return [...view.chapters].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

/** A phrase has been started when the artifact behind it exists. */
export function phraseStarted(view: StoryViewData, phrase: StoryPhraseKey): boolean {
    if (phrase === 'summary') {
        return view.summary !== null;
    }
    if (phrase === 'characters') {
        return view.cast.length > 0;
    }
    if (phrase === 'plotlines') {
        return view.plotlines.length > 0;
    }
    return view.chapters.length > 0;
}

/** U-4's title for the content area, resolved from the selection and the records. */
export function selectionTitle(view: StoryViewData, selection: StorySelection): string {
    if (selection.panel === 'seed') {
        return 'Seed';
    }

    // `ALL_STORY_PHRASES`, not the rail's one-phrase list: a later phase can hand this selection in
    // directly, and a title that fell through to "The story" would be a lie about what is on screen.
    const phrase = ALL_STORY_PHRASES.find((candidate) => candidate.key === selection.panel);

    if (phrase) {
        const entry = selection.ref ? phraseEntryTitle(view, phrase.key, selection.ref) : undefined;
        return entry ? `${phraseLabel(phrase)} · ${entry}` : phraseLabel(phrase);
    }

    const folder = STORY_FOLDERS.find((candidate) => candidate.key === selection.panel);
    return folder?.title ?? 'The story';
}

function phraseEntryTitle(view: StoryViewData, phrase: StoryPhraseKey, ref: string): string | undefined {
    if (phrase === 'summary') {
        // R6 — the rail's Summary children are GROUPS, so the opened entry is named by its own title
        // ("Premise"), never by a revision number and never by a label this file invented (U2/U7).
        const groupId = parseSummaryGroupRef(ref);
        const group = groupId === undefined ? undefined : phraseGroupById(view, groupId);

        if (group !== undefined) return group.title;

        // The legacy ref shape, for a selection a sampling-mode book is still holding.
        const id = parseSummaryRevisionRef(ref);
        const entry = id === undefined ? undefined : summaryRevisions(view).find((row) => row.revision.id === id);

        return entry === undefined ? undefined : `Revision ${entry.index}`;
    }
    if (phrase === 'characters') {
        return view.cast.find((member) => member.id === ref)?.name;
    }
    if (phrase === 'plotlines') {
        const plotline = view.plotlines.find((candidate) => candidate.id === ref);
        return plotline ? `Plotline ${plotline.order}${plotline.heading ? ` — ${plotline.heading}` : ''}` : undefined;
    }
    const chapter = view.chapters.find((candidate) => candidate.id === ref);
    return chapter ? `Chapter ${chapter.order} — ${chapter.title}` : undefined;
}

/** Whether the small entry point named by the selection still exists (a deletion falls back). */
export function selectionExists(view: StoryViewData, selection: StorySelection): boolean {
    if (selection.ref === undefined) {
        return true;
    }

    if (selection.panel === 'summary') {
        const groupId = parseSummaryGroupRef(selection.ref);

        if (groupId !== undefined) {
            // U6's stale-ref rule, stated honestly in both directions: until the phrase read has landed the
            // dashboard cannot tell a deleted group from one it has not seen yet, so the selection is kept
            // and the pane shows its loading state. Once the read HAS landed and the UUID is not among the
            // rows, the group is gone (a Story switched back to `sampling`, a re-import) and the selection
            // falls back to the Summary overview rather than opening an empty pane.
            if (!phraseLoaded(view)) return true;

            return phraseGroupById(view, groupId) !== undefined;
        }

        const id = parseSummaryRevisionRef(selection.ref);

        return id !== undefined && summaryRevisions(view).some((entry) => entry.revision.id === id);
    }
    if (selection.panel === 'characters') {
        return view.cast.some((member) => member.id === selection.ref);
    }
    if (selection.panel === 'plotlines') {
        return view.plotlines.some((plotline) => plotline.id === selection.ref);
    }
    if (selection.panel === 'chapters') {
        return view.chapters.some((chapter) => chapter.id === selection.ref);
    }

    return true;
}

// ---------------------------------------------------------------------------
// Attention — what the rail highlights, and what the directive bar addresses
// ---------------------------------------------------------------------------

/** The tone a rail highlight uses: a wait is calm, a stall is urgent, leftovers are finished. */
export type StoryAttentionTone = 'awaiting' | 'stalled' | 'finished';

/** One place in the rail that needs the Author. */
export interface StoryAttention {
    panel: StoryPanelKey;
    ref?: string;
    label: string;
    tone: StoryAttentionTone;
}

/** The phrase the loop is currently in, as the rail's own key. */
function currentPhrase(story: StoryViewData['story']): StoryPhraseKey {
    return story.phase;
}

/**
 * Everything the rail should highlight. This is the inverse of the old Stories-panel row: the
 * row now says only "needs you", and the detail of *where* lives on the rail the Author is about
 * to use. A record can add attention even when `pending_kind` names a different hold — an open
 * finding is still open while the Story waits on a sign-off.
 */
export function storyAttention(view: StoryViewData): StoryAttention[] {
    const { story } = view;
    const items: StoryAttention[] = [];
    const add = (item: StoryAttention): void => {
        if (!items.some((existing) => existing.panel === item.panel && (existing.ref ?? '') === (item.ref ?? ''))) {
            items.push(item);
        }
    };

    if (story.pending_kind === 'stalled') {
        add({ panel: currentPhrase(story), label: 'stuck', tone: 'stalled' });
    } else if (story.pending_kind === 'phase_signoff') {
        add({ panel: currentPhrase(story), label: 'sign off', tone: 'awaiting' });
    } else if (story.pending_kind === 'idea_selection') {
        add({ panel: 'ideas', label: 'pick an Idea', tone: 'awaiting' });
    } else if (story.pending_kind === 'finding_approval') {
        add({ panel: 'findings', label: 'approve findings', tone: 'awaiting' });
    } else if (story.pending_kind === 'drained') {
        add({ panel: 'findings', label: 'leftovers', tone: 'finished' });
    }

    const findings = view.findings.filter(
        (finding) =>
            finding.state === 'confirmed' &&
            !(story.auto_approve ?? []).includes(finding.cost) &&
            // Phase ①'s minor/taste notes are recorded, not approval work (the Summary bar is
            // critical/major). Later phases keep the full dial.
            !(story.phase === 'summary' && (finding.cost === 'minor' || finding.cost === 'taste'))
    );
    if (findings.length > 0) {
        add({
            panel: 'findings',
            label: `${findings.length} finding${findings.length === 1 ? '' : 's'} to approve`,
            tone: 'awaiting'
        });

        // The chapters the findings point at are the ones the Author will have to reopen; mark
        // them in the rail too, so "where" is visible without opening the Findings folder.
        for (const finding of findings) {
            for (const ref of [finding.target_ref, ...(finding.related_refs ?? [])]) {
                if (view.chapters.some((chapter) => chapter.id === ref)) {
                    add({ panel: 'chapters', ref, label: 'open finding', tone: 'awaiting' });
                }
            }
        }
    }

    const ideas = view.ideas.filter((idea) => idea.phase === story.phase && !isDecidedIdea(idea));
    if (ideas.length > 0) {
        add({
            panel: 'ideas',
            label: `${ideas.length} Idea${ideas.length === 1 ? '' : 's'} to decide`,
            tone: 'awaiting'
        });

        for (const idea of ideas) {
            if (idea.unit_ref && view.chapters.some((chapter) => chapter.id === idea.unit_ref)) {
                add({ panel: 'chapters', ref: idea.unit_ref, label: 'Idea for this chapter', tone: 'awaiting' });
            }
            if (idea.unit_ref && view.plotlines.some((plotline) => plotline.id === idea.unit_ref)) {
                add({ panel: 'plotlines', ref: idea.unit_ref, label: 'Idea for this plotline', tone: 'awaiting' });
            }
        }
    }

    const context = summaryScopeContext(view);
    // R6 — in the GROUP model a Summary draft row is a legacy artifact, not a round in flight: the loop
    // writes group revisions, and no engine selection is pending on a whole-Summary draft. So the chip that
    // told the Author to wait for the winner is turned off for a grouped book, and the group rows below
    // carry the real work instead. (A `sampling`-mode Story keeps the chip exactly as it was.)
    const summaryDrafts = isGroupSummary(view)
        ? []
        : view.revisions.filter(
              (revision) =>
                  revision.unit_kind === 'summary' &&
                  isReviewableRevision(revision) &&
                  // T11/F2: a draft from a round the loop has already settled is not a round in flight, so
                  // it earns no chip — the rail would point at a selection that has already happened.
                  !isSupersededSummaryDraft(view, revision, context)
          );
    if (summaryDrafts.length > 0) {
        // PHASE ① COPY ONLY (T5 / R3, §16.6 + D-47). An open Summary draft is a round that has not
        // settled, and in phase ① NOTHING asks the Author or an Editor to settle it: the engine picks the
        // winner deterministically (fewest critical → fewest high → fewest total → earliest, §6.5) once
        // every draft has its screening set (§16.1 job 4). "choose a draft" pointed at a decision that
        // never arrives, which is the half of the reported contradiction the rail still carried.
        // A `competing`/`drafted` Summary row in a LATER phase is a pre-§16.6 legacy row whose Editor
        // really does apply `selection_rules` (§16.8 supersedes them for phase ① only), so its wording
        // is untouched.
        add({
            panel: 'summary',
            label: story.phase === 'summary' ? 'engine selects a draft' : 'choose a draft',
            tone: 'awaiting'
        });
    }

    // R6 / U5 — WORK MARKS ON THE GROUP ROWS. A finding that names a group is that group's business, and the
    // rail says which group without the Author opening the Findings folder: the badge is the count, this mark
    // is the "come here". A live Writer is NOT attention — it is the crew working, and the row shows it in its
    // own words — and a `fixed` finding never reaches here, because the phrase rows it returns are scoped and
    // resolved, and R3 closes the row once every targeted group has answered it.
    //
    // WHY THE LABEL CARRIES NO NUMBER: a group row is the first rail row that can carry BOTH a findings badge
    // and an attention mark, and an accessible name is built by concatenating them. "1 open Critical or Major
    // finding" plus "1 open finding on Premise" makes a reader hear the same count twice, and the group title
    // again, on a row whose visible label already says which group it is. The count is the badge's job — it
    // carries the number AND what the number means — so this mark says only the direction the count is pointing
    // at, which is the part the badge cannot spell.
    if (isGroupSummary(view)) {
        for (const group of phraseGroups(view)) {
            const blocking = groupBlockingFindings(view, group.id);

            if (blocking.length === 0) continue;

            add({
                panel: 'summary',
                ref: summaryGroupRef(group.id),
                label: 'open findings to answer',
                tone: 'awaiting'
            });
        }
    }

    if (view.completion_preview && story.status !== 'completed') {
        add({ panel: 'chapters', label: 'completion proposed', tone: 'finished' });
    }

    return items;
}

/** The attention item, if any, that belongs to one rail entry. */
export function attentionFor(
    view: StoryViewData,
    panel: StorySelection['panel'],
    ref?: string
): StoryAttention | undefined {
    return storyAttention(view).find((item) => item.panel === panel && (item.ref ?? undefined) === ref);
}

// ---------------------------------------------------------------------------
// The directive bar's focus
// ---------------------------------------------------------------------------

/**
 * What the Author is looking at, in the terms the Editor's brief needs. `refs` are the artifact
 * rows the direction is about; the server resolves them one hop wider (dependents), so the Editor
 * receives the focused Summary/chapter/plotline even when the sentence itself never names it.
 */
export interface DirectiveFocus {
    /** The bar's label, e.g. "Summary → Editor" or "Chapter 3 — The Water Line → Editor". */
    label: string;
    /** The sentence it is talking about, e.g. "the Summary" or "this chapter". */
    target: string;
    placeholder: string;
    refs: string[];
}

/** The slices the directive bar reads; the raw `getStory` payload satisfies it too (plus the phrase read, R6). */
export type DirectiveFocusView = Pick<
    StoryViewData,
    'story' | 'summary' | 'cast' | 'plotlines' | 'chapters' | 'phrase'
>;

/** The focus the directive bar should show for the rail's current selection. */
export function directiveFocus(view: DirectiveFocusView, selection: StorySelection): DirectiveFocus {
    if (selection.panel === 'seed') {
        return {
            label: 'Seed → Editor',
            target: 'the Seed (read-only for every agent — P5)',
            placeholder: 'what should the Editor do with this Seed?',
            refs: []
        };
    }

    if (selection.panel === 'summary') {
        // R6 / U5 — A GROUP DIRECTIVE ADDRESSES THE GROUP. With a Summary group open, the sentence is about
        // that part of the Overview and the ref is the group's UUID, which is the address the loop's group
        // work and the revise route both take. The label names the path the Author is standing on
        // (`Summary → Premise`) rather than collapsing five different panes into one "the Summary".
        const groupId = parseSummaryGroupRef(selection.ref);
        const group = groupId === undefined ? undefined : phraseGroupById(view, groupId);

        if (group !== undefined) {
            return {
                label: `Summary → ${group.title} → Editor`,
                target: `the ${group.title} group of the Summary`,
                placeholder: `e.g. rewrite the ${group.title.toLowerCase()} · keep the rest of the Overview`,
                refs: [group.id]
            };
        }

        return {
            label: 'Summary → Editor',
            target: 'the Summary',
            placeholder: 'e.g. tighten the premise · keep the ending',
            refs: view.summary ? [view.summary.id] : view.phrase?.phrase_id ? [view.phrase.phrase_id] : []
        };
    }

    if (selection.panel === 'characters') {
        const member = selection.ref ? view.cast.find((candidate) => candidate.id === selection.ref) : undefined;
        return {
            label: member ? `${member.name || member.id} → Editor` : 'Characters → Editor',
            target: member ? `${member.name || member.id}'s sheet` : 'the cast sheet',
            placeholder: 'e.g. give Hale a want that fights her need',
            refs: member ? [member.id] : []
        };
    }

    if (selection.panel === 'plotlines') {
        const plotline = selection.ref ? view.plotlines.find((candidate) => candidate.id === selection.ref) : undefined;
        return {
            label: plotline
                ? `Plotline ${plotline.order}${plotline.heading ? ` — ${plotline.heading}` : ''} → Editor`
                : 'Plotlines → Editor',
            target: plotline ? 'this plotline' : 'the plotline set',
            placeholder: 'e.g. make this plotline pay off the set-up · keep the order',
            refs: plotline
                ? [plotline.id]
                : [...view.plotlines].sort((left, right) => left.order - right.order).map((row) => row.id)
        };
    }

    if (selection.panel === 'chapters') {
        const chapter = selection.ref ? view.chapters.find((candidate) => candidate.id === selection.ref) : undefined;
        return {
            label: chapter ? `Chapter ${chapter.order} — ${chapter.title} → Editor` : 'Chapters → Editor',
            target: chapter ? 'this chapter' : 'the chapter set',
            placeholder: 'e.g. kill the mentor here · make it colder',
            refs: chapter
                ? [chapter.id]
                : [...view.chapters].sort((left, right) => left.order - right.order).map((row) => row.id)
        };
    }

    const folder = STORY_FOLDERS.find((candidate) => candidate.key === selection.panel);
    const placeholders: Partial<Record<StoryPanelKey, string>> = {
        continuity: 'e.g. make the ledger agree on the drowned road',
        goal: 'e.g. add a hard criterion for point of view',
        ideas: 'e.g. take the hum idea · discard the repeat',
        findings: 'e.g. approve the C-14 finding · discard the minor ones',
        digest: 'e.g. re-derive the Digest from the current Summary',
        settings: 'e.g. auto-approve minor findings for this Story'
    };

    return {
        label: `${folder?.title ?? 'Story'} → Editor`,
        target: `the ${folder?.title ?? 'Story'} folder`,
        placeholder: placeholders[selection.panel] ?? 'what should change here?',
        refs: []
    };
}
