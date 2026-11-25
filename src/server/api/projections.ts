// §10 / W9-W13 — the server-side PROJECTIONS the dashboard renders.
//
// WHY THIS FILE EXISTS SEPARATELY FROM THE ROUTES: `src/dashboard/api.ts` is the pinned wire contract
// (`StoryRow`, `StoryView`, `QueueItem`, `GoalSurface`, …), and the dashboard is forbidden from
// recomputing anything (L-14 / W3: a second criteria implementation would drift from the engine). Every
// string in here is therefore produced from the CRITERIA ENGINE's own output, never re-derived, and the
// return types are imported straight out of the client module so the server cannot drift from the shape
// the UI was built against (a rename on either side is a compile error, not a runtime surprise).
//
// WHAT A PROJECTION IS ALLOWED TO DO: read rows, call `CriteriaEngine`/`DigestBuilder`, and render.
// It never writes and never calls the engine's verbs — the routes own mutation, this file owns
// presentation.
import { LEVELS, type CriterionLevel } from '../../shared/criteria';
import { FINDING_COSTS } from '../../shared/types';
import { CONFIRMED_FINDING_STATES, type LevelHistoryEntry, type LoopStory } from '../loop/types';
import { DISCARDABLE_FINDING_STATES, DISCARDABLE_IDEA_STATES } from '../loop/status';
import {
    findingsAwaitingAuthor,
    // SUMMARY PHRASE R6: the view says "has this text been reviewed?" from CLOSED run rows, so it needs
    // the same liveness test the loop uses (`isLiveRun`) and the Author's seat count (`screeningSizeOf`),
    // rather than a second opinion about what "running" and "how many Critics" mean.
    isLiveRun,
    // D-67 — the rail names the defects holding a clean verdict back, over D-33c's ONE open-issue read
    // (`isOpenIssueFinding` behind it), so the sentence on the rail and the gate in the stamp can never
    // disagree about which states still hold a group open.
    openIssueFindings,
    loopStory,
    samplingRoundOf,
    screeningSizeOf,
    storyChapters,
    storyFindings,
    storyIdeas,
    storyPlotlines,
    storySummary,
    undecidedIdeas,
    verdictsFor
} from '../loop/records';
// SUMMARY PHRASE (R2/R3/R6) — the group domain's read side. Every rule the view states (a group's
// history order, a finding's group scope, R3's resolution, the vector hash a review is keyed by, the
// composition of the Overview, and the legacy field map the mirror is checked against) comes from the
// module that OWNS it, so the projection cannot invent a second version of a loop rule.
import {
    composeGroupContentFrom,
    // T-W3 — the compiled Summary: the reviewed composition and the selection it is made of. The Start
    // verb's `source: 'compiled'` seed and `StoryView.summary_compiled` both read THIS, so the button the
    // dashboard enables and the text the verb copies cannot disagree about what "Phrase 1 is done" means.
    composeReviewedContentFrom,
    findingGroupScope,
    findingResolution,
    groupRevisionHistory,
    groupRevisionVector,
    groupVectorHash,
    isGroupManagedStory,
    // T-W3 — the PER-PHRASE dial (`story.plotlines_mode` / `story.summary_mode`), the scoped entry read,
    // and the phrase's own copied seed. The per-phrase view needs all three; the Summary's own read keeps
    // using `isGroupManagedStory`, whose strings are pinned.
    isPhraseGroupManaged,
    // R1 — the ONE predicate for "is this group's current text locked?". Projected rather than
    // re-derived, so the rail's badge and the loop's refusal read the same flag
    // (`phrase/catalog.ts:isPhraseGroupLocked`).
    isPhraseGroupLocked,
    // F8 / R4 — the same held-group read the dispatch and the Author's 409 use, so the rail's disabled
    // button and the server's refusal can never disagree about who is writing this group.
    liveGroupRefs,
    phraseGroupsOf,
    phraseGroupsOfPhrase,
    phraseSeedOf,
    // D-67/D-68 — the Reviewed Summary's three reads, all from the module that owns the rule: the live
    // clean selection, the Author's recorded choice (re-validated against the rows), and the composed
    // reviewed text. A projection that reimplemented "newest clean revision" would be a fourth opinion
    // on the same rows, and the rail would disagree with the seat that arms on it.
    cleanSelectionOf,
    chosenSelectionOf,
    composeReviewedOverview,
    storyPhrase,
    // T-W3 — a phrase row BY KIND KEY, the read every per-phrase projection and verb addresses on.
    storyPhraseByKey
} from '../phrase';
import {
    PHRASE_PLOTLINES_KEY,
    PHRASE_SUMMARY_KEY,
    SUMMARY_MIRROR_FIELDS,
    // Seam S7 — the composition rank INSIDE a phrase, so a chapter set composes in chapter order.
    phraseGroupRankOf
} from '../../shared/phrase';
// §6.4 gate 1's read: "the accepted brief" has exactly one definition in the build — the prompt
// compiler's deterministic pick (`created_at` then id) — so the Story view reuses it rather than
// opening a second interpretation of "accepted" that could disagree with what a Writer is told.
import { acceptedSeedBrief } from '../run/phase1-prompt';
import type {
    AgentThreadRecord,
    CompletionPreview,
    CostDistribution,
    FailingCriterion,
    GoalSurface,
    QueueItem,
    SamplingHistoryRow,
    SamplingView,
    SeedBriefView,
    StoryLevels,
    StoryRow,
    StoryView
} from '../../dashboard/api';
import type { CriteriaEngine, LevelReport, LevelStatus } from '../criteria/engine';
import type { DigestBuilder } from '../digest/digest';
import type { CommitEvent, Store } from '../store';
import type {
    Cost,
    Finding,
    FindingKind,
    Idea,
    // The reviewed block's signature names both stored rows (the Phrase row carries the Author's choice,
    // the group rows are what its selection picks), so the projection states its shape in stored types.
    Phrase,
    PhraseGroup,
    // R1 — the lock actor ('author' | 'editor') the group row projects verbatim.
    PhraseGroupLockActor,
    Revision,
    RoleKind,
    Run,
    Story,
    StoryPhase,
    Task
} from '../../shared/types';
import type { StreamKind } from '../../dashboard/api';
import type { StoryThreadRecord } from '../run/thread-log';
// The roster's tile shape, so the cross-book merge below produces the same rows a single book does.
import type { StoryAgentStatus } from '../run/story-engine';

/** Everything a projection needs: the book, and the two read-only engines that interpret it. */
export interface ProjectionDeps {
    store: Store;
    criteria: CriteriaEngine;
    digest: DigestBuilder;
}

/** §5.2's level order — the same order `LevelReport.failing` lists failures in (U-1a). */
const LEVEL_ORDER: CriterionLevel[] = ['summary', 'plotlines', 'chapters', 'whole'];

/** The `pending_kind`s that mean "the loop finished something and only the Author can move it" (U-1b). */
const AWAITING_AUTHOR: string[] = ['phase_signoff', 'idea_selection', 'finding_approval', 'drained'];

// ---------------------------------------------------------------------------
// L-14's level strings
// ---------------------------------------------------------------------------

/**
 * L-14: one level renders as `n/m`, or `n/a` when the Story has not reached it (never `0/n`), or
 * `n/m · failing: C-4, C-5` when it is reached and failing. The `n/m` comes from the engine's
 * `LevelStatus`; the failing list is the engine's `LevelReport.failing` intersected with that level's
 * criteria, because the report aggregates across levels and U-1a wants them attributed.
 */
const levelString = (level: CriterionLevel, status: LevelStatus | 'n/a', failing: string[]): string => {
    if (status === 'n/a') return 'n/a';

    const names = (LEVELS[level] ?? []).filter((criterion) => failing.includes(criterion));

    return names.length === 0
        ? `${status.passed}/${status.total}`
        : `${status.passed}/${status.total} · failing: ${names.join(', ')}`;
};

/** §10.2 U-1 — the four level strings one Stories-panel row shows. */
export function storyLevels(store: Store, criteria: CriteriaEngine, story: Story): StoryLevels {
    const report: LevelReport = criteria.levelStatus(store, story);
    const out: Record<CriterionLevel, string> = { summary: 'n/a', plotlines: 'n/a', chapters: 'n/a', whole: 'n/a' };

    for (const level of LEVEL_ORDER) out[level] = levelString(level, report.levels[level], report.failing);

    return { summary: out.summary, plotlines: out.plotlines, chapters: out.chapters, whole: out.whole };
}

// ---------------------------------------------------------------------------
// Completion (U-13/U-14/L-25b)
// ---------------------------------------------------------------------------

/**
 * L-25/L-26/L-30: the completion prompt is live while a proposal is unanswered. `acceptCompletion`
 * leaves the row behind in BOTH branches (accepted on accept, `discarded + 1` with the Story back to
 * `ready` on discard), so "unanswered" is `completion && !accepted && status !== 'ready'` — the
 * discard case must not keep offering a button the Author already declined (L-30).
 */
export const completionProposed = (story: Story): boolean => {
    const completion = loopStory(story).completion;

    if (completion === undefined || completion.accepted === true) return false;

    return story.status !== 'ready';
};

/**
 * U-14 / L-25b — what accepting will discard, counted from the SAME state sets the engine's
 * `acceptCompletion` iterates (`DISCARDABLE_FINDING_STATES` / `DISCARDABLE_IDEA_STATES` in
 * `src/server/loop/status.ts`), so the number the Author waves away is the number that actually gets
 * waved away. Null when no completion is on the table: the UI shows no "will discard" line for a Story
 * nobody has proposed finishing.
 */
export function completionPreview(store: Store, story: Story): CompletionPreview | null {
    if (!completionProposed(story)) return null;

    // Both filters read the discardable sets, NOT the narrower "still open" / "still proposed" reads:
    // accepting moves every row in these two sets to `discarded` (engine.ts:acceptCompletion), and a
    // `verified` / `refuted` / `unverifiable` Idea is one of them. Counting only `proposed` here told the
    // Author "0 Ideas will be closed" while the accept threw their undecided rows away — U-14 asks for
    // the eyes-open number, so it has to be the true one.
    const findings = storyFindings(store, story.id).filter((finding) =>
        DISCARDABLE_FINDING_STATES.includes(finding.state)
    );
    const ideas = storyIdeas(store, story.id).filter((idea) => DISCARDABLE_IDEA_STATES.includes(idea.state));
    const oldest = [...findings, ...ideas].sort((left, right) => left.created_at.localeCompare(right.created_at))[0];

    return {
        open_findings: findings.length,
        open_ideas: ideas.length,
        ...(oldest === undefined ? {} : { oldest: oldestTitle(oldest) })
    };
}

/** An Idea's `body` IS its claim; a Finding has a title. Both are one line the Author can read. */
const oldestTitle = (row: Finding | Idea): string => ('title' in row ? row.title : row.body);

// ---------------------------------------------------------------------------
// U-10a — the dial's cost histogram
// ---------------------------------------------------------------------------

/**
 * U-10a / D-35 — what the dial is currently skipping, and how often the Editor downgraded.
 *
 * `confirmed_per_cost` counts the findings sitting in `confirmed`/`approved` (D-34's two live states)
 * by their CURRENT cost, all four keys always present so the UI never has to handle a missing bar.
 *
 * `downgrades` is read off the JOURNAL rather than the records: §4.10 has no `raised_cost` field, so
 * the only place the cost a finding was RAISED at survives is the `create` event's patch, and the only
 * place the Editor's re-costing survives is the later `update` patches. A downgrade is the current
 * cost sitting LOWER on the triage scale than the cost it was raised at (FINDING_COSTS order is the
 * scale, so a higher index is a lesser cost).
 */
export function costDistribution(store: Store, storyId: string): CostDistribution {
    const confirmed_per_cost = { critical: 0, major: 0, minor: 0, taste: 0 } as Record<Cost, number>;

    for (const finding of store.findings.list()) {
        if (finding.story_id !== storyId) continue;
        if (!CONFIRMED_FINDING_STATES.includes(finding.state)) continue;

        confirmed_per_cost[finding.cost] += 1;
    }

    const raised = new Map<string, number>();
    const current = new Map<string, number>();

    // S-RUNTIME: a journal event names a record by its LOCAL id, and one Story's `finding_0` is not
    // another Story's `finding_0`. Under the per-Story layout (`store/story-stores.ts`) `store.journal`
    // is one Story's journal and the fence below cannot exclude anything; in a book that holds several
    // Stories it is what stops one Story's create from being paired with another Story's cost change —
    // a downgrade the Author never made. A finding the book no longer holds (deleted, purged) has no
    // owner to compare, so its events still count, which is what the audit line wants anyway.
    const owners = new Map(store.findings.list().map((finding) => [finding.id, finding.story_id]));

    for (const event of store.journal) {
        if (event.collection !== 'findings') continue;

        const owner = owners.get(event.id);

        if (owner !== undefined && owner !== storyId) continue;

        const cost = costOfPatch(event.patch);

        if (cost === undefined) continue;

        if (event.op === 'create') raised.set(event.id, FINDING_COSTS.indexOf(cost));
        else current.set(event.id, FINDING_COSTS.indexOf(cost));
    }

    let downgrades = 0;

    for (const [findingId, raisedRank] of raised) {
        const now = current.get(findingId);

        if (now !== undefined && now > raisedRank) downgrades += 1;
    }

    return { confirmed_per_cost, downgrades };
}

/** The `cost` inside a journaled findings patch, if that patch touched cost at all. */
const costOfPatch = (patch: unknown): Cost | undefined => {
    if (patch === null || typeof patch !== 'object') return undefined;

    const cost = (patch as { cost?: unknown }).cost;

    return (FINDING_COSTS as readonly unknown[]).includes(cost) ? (cost as Cost) : undefined;
};

// ---------------------------------------------------------------------------
// §10.2 U-1 — the Stories row
// ---------------------------------------------------------------------------

/**
 * U-1/U-1b/U-1c/U-2 — one STORIES-panel row. Everything the panel renders and refuses to recompute:
 * the phase/lock booleans come straight off the record, the level strings come from the criteria
 * engine, `active_runs` is the live-run count (U-7's crew), and `completion_proposed` drives U-13's
 * completion prompt.
 */
export function storyRow(deps: ProjectionDeps, story: Story): StoryRow {
    const { store, criteria } = deps;
    const report = criteria.levelStatus(store, story);
    const awaiting = story.status === 'pending' && AWAITING_AUTHOR.includes(story.pending_kind);

    // U-1a: a pending Story names what it is stuck on. The engine maintains `blocked_on`; when it has
    // not (a Story parked at a sign-off, which is not a blockage), the failing criteria ARE the answer.
    const blocked_on =
        story.blocked_on && story.blocked_on.length > 0
            ? story.blocked_on
            : story.status === 'ready'
              ? undefined
              : report.failing.length > 0
                ? `criteria failing: ${report.failing.join(', ')}`
                : undefined;

    return {
        id: story.id,
        title: story.title,
        phase: story.phase,
        status: story.status,
        pending_kind: story.pending_kind,
        ...(story.status_reason === undefined ? {} : { status_reason: story.status_reason }),
        summary_locked: story.summary_locked,
        plotlines_locked: story.plotlines_locked,
        levels: storyLevels(store, criteria, story),
        trend: story.trend,
        ...(story.progress === undefined ? {} : { progress: story.progress }),
        ...(blocked_on === undefined ? {} : { blocked_on }),
        auto_approve: [...story.auto_approve],
        active_runs: store.runs
            .list()
            .filter(
                (run) =>
                    run.story_id === story.id &&
                    (run.state === 'spawning' || run.state === 'working' || run.state === 'reporting')
            ).length,
        completion_proposed: completionProposed(story)
    };
}

/**
 * U-1's ordering rule: "Stories waiting on the Author sort to the top". A stalled Story outranks even
 * those (U-1b: stalled is the urgent colour), then awaiting-the-Author, then everything else; `id`
 * breaks ties so the list is stable across refetches (P1: the store is the memory, not the sort).
 */
const storyRank = (story: Story): number => {
    if (story.status !== 'pending') return 2;

    return story.pending_kind === 'stalled' ? 0 : AWAITING_AUTHOR.includes(story.pending_kind) ? 1 : 2;
};

export const storyRows = (deps: ProjectionDeps): StoryRow[] =>
    deps.store.stories
        .list()
        .slice()
        .sort((left, right) => storyRank(left) - storyRank(right) || left.id.localeCompare(right.id))
        .map((story) => storyRow(deps, story));

// ---------------------------------------------------------------------------
// §10.2 U-6 — the Goal surface
// ---------------------------------------------------------------------------

/**
 * U-6 — the Goal plus live pass/fail. `resolveGoal` is the engine's evaluated Goal (defaults filled in,
 * §5.1), `phase_progress`/`failing` are the phase Goal's rendered answer (G-2: every failure names the
 * smallest change), and `chapter_progress` is one rendered `n/m` per chapter so the bar override's
 * effect is visible per chapter (G-1/§14 item 2).
 */
export function goalSurface(deps: ProjectionDeps, story: Story): GoalSurface {
    const { store, criteria } = deps;
    const status = criteria.phaseGoalStatus(store, story);
    const failing: FailingCriterion[] = status.failing.map((entry) => ({
        criterion: entry.criterion,
        fix_hint: entry.fix_hint,
        ...(entry.evidence === undefined ? {} : { evidence: entry.evidence })
    }));
    const chapter_progress: Record<string, string> = {};

    for (const chapter of storyChapters(store, story.id)) {
        chapter_progress[chapter.id] = criteria.chapterGoalStatus(store, story, chapter.id).progress;
    }

    return { goal: criteria.resolveGoal(store, story), phase_progress: status.progress, failing, chapter_progress };
}

/**
 * The Summary sampling history for the rail. Live rows are the authority; a hard-deleted Summary
 * draft from an older selection is recovered from the journal, which stores the deleted record as
 * the `delete` event's patch (P11's undo source). Without this, a Story that selected a Summary
 * before phase ① kept its samples would show only the winner and its latest correction — the rail's
 * Overview 1…N would silently lose the Writer samples the Author asked for.
 *
 * The recovered row is presented as `discarded`, which is the truthful reading after a later
 * selection: it is no longer the installed or competing text, but its findings and the Editor's
 * note are still provenance. Its `discard_reason` keeps the row's own reason when one was written
 * before the delete, and otherwise quotes the delete event's `attribution.why` — the journal's
 * record of the decision that removed it, which is why a phase ① truncation is never dressed up as
 * an Editor's judgment. Chapter/plotline deletions are not resurrected; D-22's hard delete
 * still owns those surfaces.
 */
function viewRevisions(store: Store, story: Story): Revision[] {
    const live = store.revisions.list().filter((revision) => revision.story_id === story.id);
    const summary = storySummary(store, story.id);

    if (summary === null || summary === undefined) return live;

    const liveIds = new Set(live.map((revision) => revision.id));
    const archived = new Map<string, Revision>();

    for (const event of store.journal) {
        if (event.collection !== 'revisions' || event.op !== 'delete') continue;

        const deleted = event.patch as Revision | undefined;

        if (
            deleted === undefined ||
            deleted.story_id !== story.id ||
            deleted.unit_kind !== 'summary' ||
            deleted.unit_ref !== summary.id ||
            liveIds.has(deleted.id) ||
            archived.has(deleted.id)
        ) {
            continue;
        }

        // R1: a recovered row still has to say why it is `discarded`. The row's own
        // `discard_reason` wins when it was written before the delete; otherwise the delete event's
        // `attribution.why` is the journal's own sentence about the decision that removed it
        // (T-5 makes it mandatory and non-blank, store.ts:188), so nothing is invented here — a
        // phase ① truncation reads as a truncation, not as an Editor's judgment.
        const persisted = typeof deleted.discard_reason === 'string' ? deleted.discard_reason.trim() : '';
        const journaled = typeof event.attribution?.why === 'string' ? event.attribution.why.trim() : '';
        const reason = persisted.length > 0 ? persisted : journaled;

        archived.set(deleted.id, {
            ...deleted,
            state: 'discarded',
            // Absent rather than empty: a row with no reason anywhere stays readable the way it was
            // before the field existed, and the rail shows no reason instead of a blank one.
            ...(reason.length > 0 ? { discard_reason: reason } : {})
        });
    }

    return [...archived.values(), ...live].sort(
        (left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id)
    );
}

// ---------------------------------------------------------------------------
// §10 / §3.3 — phase ①'s Seed Brief and sampling state (the research pipeline's two slices)
// ---------------------------------------------------------------------------

/** How many completed sampling rounds the view carries (§10: the last five, newest first). */
const SAMPLING_HISTORY_CAP = 5;

/**
 * §10 / §3.3 — the ACCEPTED Seed Brief, trimmed to the fields the Story view reads. `null` is the
 * honest answer before phase ①'s gate 1 (§6.4): a Story whose Editor has not structured the Seed
 * genuinely has no brief, and the pane must say so rather than render an empty object.
 *
 * The arrays (`world_rules`, `constraints`, `open_questions`) and `tone_hints` stay in the record:
 * they are the prompt compiler's material, not a reading surface, and copying them here would put
 * two renderings of the same brief on the wire.
 */
function seedBriefView(store: Store, story: Story): SeedBriefView | null {
    const brief = acceptedSeedBrief(store, story.id);

    if (brief === undefined) return null;

    return {
        id: brief.id,
        seed_hash: brief.seed_hash,
        logline: brief.logline,
        protagonist: brief.protagonist,
        want: brief.want,
        obstacle: brief.obstacle,
        stakes: brief.stakes,
        setting: brief.setting,
        promise: brief.promise,
        status: brief.status
    };
}

/**
 * §10 / §6.5-§6.6 — phase ①'s sampling state for the Story view.
 *
 * TWO ROUND NUMBERS, deliberately (`active_round` is T12/P1's addition, and both are read by the
 * dashboard because the loop itself uses both — one for the review, one for supersession):
 *
 *   * `round` is `sampling_round ?? 1` — the LAST COMPLETED round, the round whose selection the
 *     Story carries. It is `records.ts:deepReviewRoundOf` spelled exactly, which is what §10 asks the
 *     view to report (the pane prints it, and the deep review is dispatched for THAT round). A
 *     backtrack or a Seed edit resets the counter to 0 (engine.ts's `scrapPhasesAfter` branches) so
 *     the reopened phase samples round 1 again; the view reports that stored 0 as-is rather than
 *     re-deriving a second time.
 *   * `active_round` is `records.ts:samplingRoundOf(story)` — the round IN FLIGHT, `(sampling_round ??
 *     0) + 1`, the integer `records.ts:isSupersededSummaryDraft` compares a draft's round against. It
 *     is sent because `round` alone is AMBIGUOUS at the boundary that matters: a Story that has never
 *     selected says `round: 1` (in-flight round 1, its drafts are live work) and a Story whose round 1
 *     just closed also says `round: 1` (in-flight round 2, round-1 leftovers are set aside). Guessing
 *     the +1 on the client is the off-by-one that made the rail show a retired draft as live
 *     competition while the engine had already moved past it, so the projection answers with the
 *     loop's own read and the dashboard recomputes nothing (L-14/W3).
 *
 * `selected` is read off the NEWEST history row rather than the live `revisions` rows: the selection
 * commit hard-deletes the losers (P13/D-22) and bumps `sampling_round`, so the history line is the
 * only record that couples the winning id to the counts that won it. A row whose `selected` id is not
 * among its own samples is a malformed snapshot, and the projection states the absence instead of
 * inventing counts.
 *
 * `history` is capped at the last five rows, NEWEST FIRST: the selection commit appends, so a Story
 * that has refined many rounds keeps its recent provenance (the older rounds stay in the book).
 */
function samplingView(story: Story): SamplingView {
    const history: SamplingHistoryRow[] = [...(story.sampling_history ?? [])]
        .sort((left, right) => left.round - right.round)
        .slice(-SAMPLING_HISTORY_CAP)
        .reverse()
        .map((row) => ({
            round: row.round,
            at: row.at,
            samples: row.samples.map((sample) => ({
                revision_id: sample.revision_id,
                critical: sample.critical,
                high: sample.high,
                valid: sample.valid,
                // H1-C1/F3 — the fixes this candidate left outstanding, which is the ONLY surviving
                // record of why a round was refused: the selection commit hard-deletes the losers and
                // their `sample_reviews` rows (P13/§6.6), so without this line the Author's pane shows
                // counts and no reason. The `?? []` is the pre-H1 history line, normalised rather than
                // optional: a consumer reads one shape and never has to ask which build wrote the row.
                unresolved_fixes: sample.unresolved_fixes ?? [],
                // H2 — the hill's per-candidate outcome: `accepted` / `eligible` / `rejected`, the
                // reason a refusal refused, and (refinement rounds only) the origin split and how much
                // of the accepted text the draft touched. These travel WHEN RECORDED and not as zeros:
                // a row from before the hill has no outcome to report, and inventing one — or reporting
                // `0` introduced criticals, which reads as "this draft broke nothing" — would put a fact
                // on the pane that the book never recorded.
                ...(sample.outcome === undefined ? {} : { outcome: sample.outcome }),
                ...(sample.reject_reason === undefined ? {} : { reject_reason: sample.reject_reason }),
                ...(sample.introduced_critical === undefined ? {} : { introduced_critical: sample.introduced_critical }),
                ...(sample.introduced_high === undefined ? {} : { introduced_high: sample.introduced_high }),
                ...(sample.inherited_critical === undefined ? {} : { inherited_critical: sample.inherited_critical }),
                ...(sample.inherited_high === undefined ? {} : { inherited_high: sample.inherited_high }),
                ...(sample.changed_fields === undefined ? {} : { changed_fields: sample.changed_fields }),
                ...(sample.changed_characters === undefined
                    ? {}
                    : { changed_characters: sample.changed_characters })
            })),
            selected: row.selected,
            // H2 — the wave's ledger, same rule as the sample fields: present when the row recorded it.
            // `wave` is the one that changes what the pane MEANS: two rows for the same round, one at
            // wave 0 and one at wave 1, are a stall and the restart after the Author's clear, and an
            // Author who cannot see the wave cannot tell "the hill stalled again" from "the hill moved".
            ...(row.wave === undefined ? {} : { wave: row.wave }),
            ...(row.attempts === undefined ? {} : { attempts: row.attempts }),
            ...(row.improvements === undefined ? {} : { improvements: row.improvements }),
            ...(row.ceiling === undefined ? {} : { ceiling: row.ceiling }),
            ...(row.unresolved_blocking === undefined ? {} : { unresolved_blocking: row.unresolved_blocking })
        }));

    const latest = history[0];
    const chosen = latest?.samples.find((sample) => sample.revision_id === latest.selected);

    return {
        // The last COMPLETED round, as stored (`0` on a Story an Author reset) — the deep review's
        // round, and the number §10's pane prints.
        round: (story as LoopStory).sampling_round ?? 1,
        // The round the loop is working, through the loop's OWN predicate — the value supersession is
        // measured by (`records.ts:isSupersededSummaryDraft` ← `records.ts:samplingRoundOf`).
        active_round: samplingRoundOf(story),
        ...(chosen === undefined
            ? {}
            : { selected: { revision_id: chosen.revision_id, critical: chosen.critical, high: chosen.high } }),
        history
    };
}

// ---------------------------------------------------------------------------
// §10.2 U-4…U-17 — the whole Story view (one round trip, W9)
// ---------------------------------------------------------------------------

/**
 * `GET /stories/:id` — the pinned `StoryView` plus the three additive fields the phrase rail needs
 * (T-W3).
 *
 * WHY AN INTERSECTION AND NOT NEW FIELDS ON THE CLIENT TYPE: `dashboard/api.ts`'s `StoryView` is the
 * pinned wire contract and this wave does not own that file, so the server's read type WIDENS it instead
 * of editing it. Every existing consumer still sees exactly `StoryView` (an intersection is assignable to
 * it, never the other way round), and the dashboard wave narrows to these three keys when it builds the
 * phrase rail and its handoff button.
 */
export type StorylineStoryView = StoryView & {
    /**
     * THE PER-PHRASE ② DIAL, echoed rather than derived (`story.plotlines_mode`, and ABSENT MEANS
     * `'classic'` — the value every book written before Phrase ② exists reads as, exactly as
     * `phrase/catalog.ts:isPhraseGroupManaged` reads it). The rail reads it to decide whether a chapter
     * entry is the writable surface or the classic §4.3 tool path is; the record itself carries the same
     * value under `story.plotlines_mode`.
     */
    plotlines_mode: 'groups' | 'classic';
    /**
     * Which phrases have been STARTED on this book — the rail's two rows (T-W3). A phrase row is the
     * record of a start (`phrase/controllers/plotlines.ts:startPlotlinesPhrase` copies the seed and mints
     * it), so this is a read of rows, not of a counter: an un-started Phrase ② is exactly the state the
     * handoff button exists to leave.
     */
    phrase_started: { summary: boolean; plotlines: boolean };
    /**
     * Can Phrase ② be seeded from Phrase ① right now? THE HANDOFF BUTTON'S ENABLE CONDITION, and the one
     * read behind it (`summaryIsCompiled`): a complete reviewed Overview, or any non-empty composed
     * Overview. The Start verb's 409 on an empty compiled Summary is the server's answer to the same
     * question, so a rail that greyed the button off this field can never offer a press the server
     * refuses for a different reason.
     */
    summary_compiled: boolean;
};

/**
 * `GET /stories/:id` — every slice THE STORY region renders, in the order the panes read them. The
 * §4 collections are returned as-is (P1: the dashboard reads records, it does not receive copies of
 * them); only the computed slices (`goal`, `cost_distribution`, `completion_preview`) are built here.
 * `revisions` is the one history-aware slice: phase ①'s flat Revision history also reads the Summary
 * samples an older selection hard-deleted (see `viewRevisions`).
 */
export function storyView(deps: ProjectionDeps, story: Story): StorylineStoryView {
    const { store, criteria, digest } = deps;
    const summary = storySummary(store, story.id) ?? null;

    return {
        story,
        summary,
        plotlines: storyPlotlines(store, story.id),
        chapters: storyChapters(store, story.id),
        // §4.5/§4.6 — the two supporting sheets. Both are ordinary §4 collections; the Characters
        // and Continuity folders read them as records rather than as prose.
        cast: store.cast.list().filter((member) => member.story_id === story.id),
        ledger: store.ledger.list().filter((entry) => entry.story_id === story.id),
        goal: goalSurface(deps, story),
        ideas: storyIdeas(store, story.id),
        // Phase ①'s sampling tree reads the Summary drafts' full history (see `viewRevisions`).
        revisions: viewRevisions(store, story),
        // U-13 (D-21): the side-by-side panes must show the judgement that goes with each draft. §6.2a
        // files verdicts per revision — the Reader appends the verdict to `revisions.verdict_refs`
        // (tools/reader.ts) — and the §4.9 rows still travel as their own slice so the panes can match
        // them by `target_ref` without walking every revision's ref list client-side.
        verdicts: verdictsFor(store, story.id),
        findings: storyFindings(store, story.id),
        proposals: store.proposals.list().filter((proposal) => proposal.story_id === story.id),
        runs: store.runs.list().filter((run) => run.story_id === story.id),
        templates: [...story.template_refs],
        cost_distribution: costDistribution(store, story.id),
        completion_preview: completionPreview(store, story),
        digest: digest.currentDigest(store, story.id) ?? null,
        // U-1a: the stalled screen is a review surface, and one of the four things it must show is
        // WHAT THE CREWS TRIED across rounds. That history is loop bookkeeping on the Story row
        // (`level_history`, written by `recordRound` in ../loop/trend.ts), not a §4.1 field — so it is
        // projected as its own slice instead of relying on the row's additive fields surviving a
        // serialisation. Bounded by the loop's own cap (L-15a), oldest first, exactly as stored.
        level_history: levelHistoryOf(story),
        // §10 — the research pipeline's two slices, both ADDITIVE (§4's preamble: a build may add
        // fields). `seed_brief` is null before gate 1; `sampling` always answers with a round so the
        // pane never has to decide what "no sampling yet" looks like.
        seed_brief: seedBriefView(store, story),
        sampling: samplingView(story),
        // ---------------------------------------------------------------------
        // T-W3 — the phrase rail's three additive fields, built LAST so every pinned key keeps the exact
        // order `routes.test.ts` asserts. Each one is a READ OF ROWS, not a bookkeeping flag: the rail
        // that draws "Phrase 1 ▸ done — copy this into Phrase 2" and the Start verb that answers that
        // press ask the same two functions, so the button and the server cannot disagree about whether
        // there is anything to copy.
        // ---------------------------------------------------------------------
        // The dial echoed, with the phrase's own OFF value: an existing row that carries no
        // `plotlines_mode` is a classic book (`catalog.ts:isPhraseGroupManaged` reads absent as classic).
        plotlines_mode: story.plotlines_mode ?? 'classic',
        phrase_started: {
            summary: storyPhraseByKey(store, story.id, PHRASE_SUMMARY_KEY) !== undefined,
            plotlines: storyPhraseByKey(store, story.id, PHRASE_PLOTLINES_KEY) !== undefined
        },
        summary_compiled: summaryIsCompiled(store, story)
    };
}

/**
 * The Story's round history, read through the loop's additive alias (../loop/types' `LoopStory`).
 * A Story that has never finished a round has none, and the stalled screen says so rather than
 * inventing a row.
 */
function levelHistoryOf(story: Story): LevelHistoryEntry[] {
    return (story as LoopStory).level_history ?? [];
}

// ---------------------------------------------------------------------------
// U-8 — the employee's retained threads (the content the tile opens)
// ---------------------------------------------------------------------------

/** §4.13's run states -> the four states a thread bar reads. */
const THREAD_STATE_OF_RUN: Record<Run['state'], AgentThreadRecord['state']> = {
    spawning: 'running',
    working: 'running',
    reporting: 'running',
    torn_down: 'torn_down',
    failed: 'failed',
    abandoned: 'abandoned'
};

/**
 * Which phase session (the UI's "phrase") a legacy Run row belonged to. The row does not carry the
 * phase (§4.13), so the work item's own name is the only exact hint left; the Story's CURRENT phase
 * is the honest fallback for a pre-retention row whose job name says nothing.
 */
function legacyPhase(store: Store, run: Run): StoryPhase {
    const hint = `${run.work_item_ref ?? ''} ${run.template_ref ?? ''}`.toLowerCase();

    if (hint.includes('summary')) return 'summary';
    if (hint.includes('plotline')) return 'plotlines';
    if (hint.includes('chapter') || hint.includes('prose')) return 'chapters';

    return (store.stories.get(run.story_id) as Story | undefined)?.phase ?? 'chapters';
}

/**
 * U-8 — every thread one employee kind ran, oldest first.
 *
 * THREE SOURCES, ONE LIST (deliberately):
 *   - live + this-process history (`harness`) carries every engine thread, including panel
 *     agents and delegated sub-contexts that never get a Run row of their own;
 *   - the retained log (`recorded`) carries the same records across a restart;
 *   - the journaled Run rows are the legacy safety net — the pre-retention threads that were on
 *     the old crew/threads panel before this surface existed. They have no request/answer text, so
 *     `retained` is false and the UI renders the row metadata the record still owns.
 */
export function agentThreads(
    store: Store,
    kind: Run['role'],
    harness: StoryThreadRecord[],
    recorded: StoryThreadRecord[]
): AgentThreadRecord[] {
    const byThread = new Map<string, AgentThreadRecord>();

    for (const record of [...recorded, ...harness]) {
        if (record.role !== kind) continue;

        const story = store.stories.get(record.story_id) as Story | undefined;

        byThread.set(record.thread_id, {
            ...record,
            story_title: story?.title ?? record.story_title
        });
    }

    // A run row is the parent of the live/retained threads its label names (`run_7`,
    // `run_7#agent_2`); it must not appear a second time as a legacy bar.
    const coveredRuns = new Set([...byThread.values()].map((record) => record.run_id.split('#')[0]));

    for (const run of store.runs.list()) {
        if (run.role !== kind || coveredRuns.has(run.id)) continue;

        const story = store.stories.get(run.story_id) as Story | undefined;
        const state = THREAD_STATE_OF_RUN[run.state];

        byThread.set(`run_row:${run.id}`, {
            thread_id: `run_row:${run.id}`,
            run_id: run.id,
            story_id: run.story_id,
            story_title: story?.title ?? run.story_id,
            phase: legacyPhase(store, run),
            role: run.role,
            role_name: run.role,
            title: run.work_item_ref ?? run.id,
            state,
            started_at: run.started_at,
            ...(run.ended_at === undefined || run.ended_at === null ? {} : { ended_at: run.ended_at }),
            tokens: run.tokens,
            request: [
                `Work item: ${run.work_item_ref ?? '—'}`,
                `Template: ${run.template_ref ?? '—'}`,
                `Brief hash: ${run.brief_hash ?? '—'}`
            ].join('\n'),
            answer: run.end_reason ?? (state === 'torn_down' ? 'completed' : ''),
            ...(run.end_reason === undefined ? {} : { error: run.end_reason }),
            retained: false
        });
    }

    return [...byThread.values()].sort(
        (left, right) =>
            left.started_at.localeCompare(right.started_at) || left.thread_id.localeCompare(right.thread_id)
    );
}

// ---------------------------------------------------------------------------
// §10.2 U-10 — the cross-Story queue (the home screen)
// ---------------------------------------------------------------------------

/** The task kinds that mean "the harness asked for a tool it does not have" (W2's reported gap). */
const TOOL_GAP_TASK_KINDS: string[] = ['capability_gap', 'tool_gap', 'digest_gap'];

/** The task states that are still on the desk (`done`/`wontfix` rows are the answered ones, D-11). */
const OPEN_TASK_STATES: Task['state'][] = ['open', 'claimed', 'blocked'];

/** One row per kind: the queue is sorted by Story, then by creation, so a refetch is stable. */
const queueOrder = (left: QueueItem, right: QueueItem): number =>
    left.story_id.localeCompare(right.story_id) ||
    left.created_at.localeCompare(right.created_at) ||
    left.id.localeCompare(right.id);

/**
 * U-10/U-10a — the four flavours the Author's desk aggregates across Stories:
 *
 *   finding     — `confirmed` findings the dial does NOT already auto-approve (`findingsAwaitingAuthor`,
 *                 D-34: this is literally "the pile on the Author's desk"), in the Editor's words.
 *   idea        — the current phase's UNDECIDED tray (L-7a: exactly the rows that block a lock,
 *                 including the ones that carry an Editor verdict — `records.ts:undecidedIdeas`).
 *   escalation  — a run's `requestAuthor` row (P7), the queue's blocked row.
 *   tool_gap    — a capability the crew asked for and the harness does not have (W2's gap report).
 */
export function queueItems(store: Store): QueueItem[] {
    const titles = new Map(store.stories.list().map((story) => [story.id, story.title]));
    const items: QueueItem[] = [];

    const titleFor = (storyId: string): string => titles.get(storyId) ?? storyId;

    for (const story of store.stories.list()) {
        for (const finding of findingsAwaitingAuthor(store, story)) {
            items.push({
                kind: 'finding',
                story_id: story.id,
                story_title: titleFor(story.id),
                id: finding.id,
                title: finding.title,
                // T5: the finding's own kind, under a name that cannot collide — this row's `kind` is
                // already the queue discriminator (`'finding'`), so `finding_kind` is the honest spelling.
                // Absence on a legacy row reads as `issue`, exactly as the record and the fingerprint do.
                finding_kind: finding.kind ?? 'issue',
                ...(finding.detail === undefined ? {} : { detail: finding.detail }),
                evidence: finding.evidence,
                cost: finding.cost,
                created_at: finding.created_at
            });
        }

        // U-10/U-15: the desk lists the whole tray, so an Idea the Editor has answered (a `verified` row
        // is precisely what the Author is meant to select) is never hidden from the queue while it still
        // refuses the lock.
        for (const idea of undecidedIdeas(store, story.id, story.phase)) {
            items.push({
                kind: 'idea',
                story_id: story.id,
                story_title: titleFor(story.id),
                id: idea.id,
                title: idea.body,
                detail: `${idea.kind} · phase ${idea.phase}${idea.unit_ref ? ` · ${idea.unit_ref}` : ''}`,
                // D-27: the Editor's verdict and evidence is what makes an Idea selectable at all.
                evidence: idea.verification?.evidence ?? idea.sources?.[0]?.url_or_title ?? idea.author,
                created_at: idea.created_at
            });
        }

        for (const task of store.tasks.list()) {
            if (task.story_id !== story.id || !OPEN_TASK_STATES.includes(task.state)) continue;

            const isEscalation = task.kind === 'escalation';
            const isGap = TOOL_GAP_TASK_KINDS.includes(task.kind);

            if (!isEscalation && !isGap) continue;

            items.push({
                kind: isEscalation ? 'escalation' : 'tool_gap',
                story_id: story.id,
                story_title: titleFor(story.id),
                id: task.id,
                title: task.title,
                ...(task.detail === undefined ? {} : { detail: task.detail }),
                // A task has no evidence field; the criterion it cites is the closest honest thing.
                evidence: task.criterion_ref ?? task.kind,
                created_at: task.created_at
            });
        }
    }

    return items.sort(queueOrder);
}

// ---------------------------------------------------------------------------
// §10 — the SSE feed's event mapping (pure half; the writer lives in routes.ts)
// ---------------------------------------------------------------------------

/** One frame the feed emits: an event name plus the affected story id (empty = workspace-wide). */
export interface FeedEvent {
    kind: StreamKind;
    storyId?: string;
}

/**
 * Collections whose rows the STORY region renders, so a write there is a `story` event.
 *
 * The last three are the research pipeline's (§3.2-§3.4): the Story view now carries the accepted
 * Seed Brief and the sampling line, and the knowledge pane renders the `knowledge` rows through the
 * directory. A write to any of them must refresh the region the way a Summary write does — a
 * Researcher whose entries never appear until the next unrelated commit is a stale reading surface.
 * `sample_reviews` travels with them because the round's screening counts are what the revision
 * comparison shows (§10); the projection reads them through `revisions.issue_counts`.
 */
const STORY_COLLECTIONS: string[] = [
    'stories',
    'summaries',
    'plotlines',
    'chapters',
    'goals',
    'ideas',
    'digests',
    'revisions',
    'verdicts',
    'proposals',
    'cast',
    'ledger',
    'seed_briefs',
    'knowledge',
    'sample_reviews'
];

/** Collections the CREW panel reads. */
const RUN_COLLECTIONS: string[] = ['runs'];

/** Collections the Author's queue aggregates. */
const QUEUE_COLLECTIONS: string[] = ['tasks', 'findings'];

/**
 * Which Story a journaled event touched: the story row's id for a `stories` event, else the
 * `story_id` the patch carries (create/update/delete all journal the payload — `delete` journals the
 * deleted record precisely so P11's undo is possible). Undefined means "workspace-wide", which the
 * client treats as "refetch everything" — the safe direction for a feed the spec says is a hint, not
 * a payload (P1/P3: the client refetches rather than trusting the push).
 */
const storyIdOf = (event: CommitEvent): string | undefined => {
    if (event.collection === 'stories') return event.id;

    const patch = event.patch;

    if (patch === null || typeof patch !== 'object') return undefined;

    const story_id = (patch as { story_id?: unknown }).story_id;

    return typeof story_id === 'string' ? story_id : undefined;
};

/**
 * Maps one commit group to the frames the dashboard needs, de-duplicated (one commit touches a dozen
 * rows; the client refetches once per topic, not once per row). A Story-scoped write is always also a
 * `story` event, because U-1's row and U-4's view read the same records.
 */
export function feedEvents(events: CommitEvent[]): FeedEvent[] {
    const seen = new Map<string, FeedEvent>();
    const push = (kind: StreamKind, storyId?: string): void => {
        seen.set(`${kind}:${storyId ?? ''}`, storyId === undefined ? { kind } : { kind, storyId });
    };

    for (const event of events) {
        const storyId = storyIdOf(event);

        if (STORY_COLLECTIONS.includes(event.collection)) push('story', storyId);

        if (RUN_COLLECTIONS.includes(event.collection)) {
            // U-7's crew panel AND U-1's `active_runs` both move when a run row moves.
            push('runs', storyId);
            push('story', storyId);
        }

        if (QUEUE_COLLECTIONS.includes(event.collection)) {
            push('queue', storyId);
            push('story', storyId);
        }
    }

    return [...seen.values()];
}

// ---------------------------------------------------------------------------
// S-RUNTIME — the aggregate reads, across SEVERAL books
// ---------------------------------------------------------------------------
//
// Since the per-Story layout, one server serves several books and a Story's ids are LOCAL to its book
// (`store/story-stores.ts`): two books both hold `finding_0`, both hold `run_7`, and both hold a thread
// called `thread_3`. Every helper below therefore MERGES PER BOOK rather than re-deriving one view over a
// combined row set, because the second reading is where two Stories' same-named records would collapse
// into one row the Author cannot click. What stays identical is each book's own projection: the aggregate
// is a union of correct per-Story answers, sorted by a key that includes the Story id, so the same
// workspace state always produces the same listing.

/** S-RUNTIME: the Stories panel (U-1) across several books, ranked as `storyRows` ranks one book's rows. */
export const storyRowsAcross = (books: ProjectionDeps[]): StoryRow[] =>
    books
        .flatMap((deps) => storyRows(deps))
        .sort((left, right) => storyRankOfRow(left) - storyRankOfRow(right) || left.id.localeCompare(right.id));

/**
 * The row-level reading of `storyRank`. U-1's row carries the two fields the rank is computed from, and
 * re-deriving the rank from the ROW (rather than from a `Story` the row was built from) is what lets the
 * aggregate sort rows from several books without holding every Story row in memory. Same rule, one
 * function, no drift: `storyRank` is the source and this only reads through it.
 */
const storyRankOfRow = (row: StoryRow): number =>
    storyRank({ status: row.status, pending_kind: row.pending_kind } as Story);

/** S-RUNTIME: the Author's desk (U-10) across several books. `queueOrder` is Story-keyed, so the merge is stable. */
export const queueItemsAcross = (books: Store[]): QueueItem[] =>
    books.flatMap((store) => queueItems(store)).sort(queueOrder);

/**
 * S-RUNTIME: the crew panel (U-7) across several books, newest first.
 *
 * A run id is local to its book, so the rows are NOT de-duplicated by id — two Stories' `run_7` are two
 * runs, and the panel needs to show both. Callers pass `story_id` when they want one Story's panel, which
 * is the single-book read again.
 */
export const runsAcross = (books: Store[], storyId?: string): Run[] =>
    books
        .flatMap((store) => store.runs.list())
        // The filter is on the ROW's Story, not on the book: a single-store workspace holds several Stories in
        // one book, and `?story_id=` has always answered that Story's panel, not the book's whole ledger.
        .filter((run) => storyId === undefined || run.story_id === storyId)
        .sort((left, right) => left.started_at.localeCompare(right.started_at) || left.id.localeCompare(right.id));

/**
 * S-RUNTIME: the employee roster (U-8) across several books, merged per KIND.
 *
 * The roster is five employees for the whole workspace, not five per book, so a per-kind merge is the
 * honest aggregate: an employee is `running` if it has a live thread in ANY Story, `working` carries every
 * live thread (each one already names its Story, and the dashboard opens a thread scoped to it), and
 * `recent` keeps the newest closed runs across all of them. The model fields come from the FIRST book that
 * answers for the kind, which is the book whose roster the runs read: the choice is one host setting, and
 * `runtime/server-config.ts` mirrors it into every book, so a divergence would be a bug, not a choice.
 */
export const mergeAgentStatuses = (perBook: StoryAgentStatus[][]): StoryAgentStatus[] => {
    const byKind = new Map<RoleKind, StoryAgentStatus>();

    for (const statuses of perBook) {
        for (const status of statuses) {
            const merged = byKind.get(status.kind);

            if (merged === undefined) {
                // The first book answers the identity fields (rank, title, model) — see the note above.
                byKind.set(status.kind, { ...status, working: [...status.working], recent: [...status.recent] });

                continue;
            }

            merged.working.push(...status.working);
            merged.recent.push(...status.recent);

            if (status.status === 'running') merged.status = 'running';
        }
    }

    for (const status of byKind.values()) {
        status.working.sort((left, right) => left.started_at - right.started_at || left.thread_id.localeCompare(right.thread_id));

        // The tile's "why did it end" list stays bounded (the same cap one book applies), newest first,
        // so a workspace of twenty Stories cannot grow it past what the rail has room to show.
        status.recent = status.recent
            .sort((left, right) => right.started_at.localeCompare(left.started_at))
            .slice(0, RECENT_RUNS_LIMIT);
    }

    return [...byKind.values()];
};

/** The tile's bounded "why did it end" list — mirrors `run/story-engine.ts:RECENT_RUNS`. */
const RECENT_RUNS_LIMIT = 3;

/**
 * S-RUNTIME: the threads one employee ever ran (U-8's tile), across several books, oldest first.
 *
 * Each book's `agentThreads` answer is already correct for that book — including its own run-row folding,
 * which keys on run ids that are LOCAL to it. Concatenating those answers and sorting by start time is
 * therefore both the merge and the reason two Stories' `run_7` stay two bars.
 */
export const agentThreadsAcross = (perBook: AgentThreadRecord[][]): AgentThreadRecord[] =>
    perBook
        .flatMap((threads) => threads)
        .sort(
            (left, right) =>
                left.started_at.localeCompare(right.started_at) ||
                left.story_id.localeCompare(right.story_id) ||
                left.thread_id.localeCompare(right.thread_id)
        );

// ---------------------------------------------------------------------------
// SUMMARY PHRASE — the group view (R6)
//
// WHY A SEPARATE READ INSTEAD OF WIDENING `storyView`: the dashboard's `StoryView` is the PINNED wire
// contract (`src/dashboard/api.ts`), and the redesign's rail is a new surface rather than a field of
// the old one. A projection may only READ (the header rule), so everything below is a rendering of
// rows the loop already owns: the group rows, their archived history, the findings' group scope and
// resolution (`phrase/findings.ts`, the one place R3's rule is written), and the run rows that say
// which Critic seats have already reported on the Overview as it stands.
//
// WHAT THE AUTHOR CAN SEE FROM IT, in one pass: which groups are written and to what number, what the
// Overview says right now, which defect names which groups and which of those groups still owe it a
// revision, whether the legacy Summary still agrees with the groups (R6's mirror), and whether the
// current text has been reviewed at all.
// ---------------------------------------------------------------------------

/** One revision of one group, current or archived, as the history rail renders it (R2's retained history). */
export interface PhraseRevisionRow {
    id: string;
    /** 1-based, per group (R2) — the number the rail labels a row with. */
    number: number;
    state: string;
    at: string;
    /** The run that wrote it, or null for a legacy import's seed row. */
    run_ref: string | null;
    /** R3: the findings this text was written to answer — the anchor a closure is judged on. */
    finding_refs: string[];
    /** The fix tasks it answered. */
    task_refs: string[];
    /** The text's length; the body itself is on the group row (latest) and costs a second read otherwise. */
    chars: number;
    /**
     * D-67 — the Clean stamp: this text was the group's text in a cross-group Critic pass that closed
     * with no unresolved defect on the group. It is a VERDICT ABOUT THAT PASS, so it never moves when a
     * later finding is raised or discarded; what a later event moves is the SELECTION (see `reviewed`).
     */
    clean: boolean;
    /** D-67 — the deep-review run whose clean pass earned the stamp, or null for an unstamped row. */
    clean_run_ref: string | null;
}

/** One group: current text, its number, its retained history, and the findings it still owes. */
export interface PhraseGroupRow {
    id: string;
    key: string;
    title: string;
    description: string;
    order: number;
    content: string;
    revision: number;
    updated_by: string | null;
    /**
     * R2 / U3 — the revision IMMEDIATELY BEFORE the latest one, verbatim, or `''` when this is the first.
     *
     * This is the ONE exception to "history is metadata only": the pane shows the latest revision as a
     * diff against the text it replaced, so that one body has to be on the wire. Older archived revisions
     * stay server-side (their `history` rows carry `chars`, never prose).
     */
    previous_content: string;
    /**
     * Newest first, `latest` included — R2 keeps every superseded text, so the rail can show it.
     *
     * D-68 EXCLUDES `discarded` rows (the texts the Author's Reviewed-Summary choice passed over). The
     * rows PERSIST — R3's closure join still walks them, so a `fixed` finding stays fixed — but they are
     * not candidates any more, and a history rail that listed them next to the live line would read as
     * "these are still on the table". The reviewed block below is where the choice is reported.
     */
    history: PhraseRevisionRow[];
    /** Open findings that target this group and have no revision of IT resolving them (R3). */
    owed_by_findings: string[];
    /**
     * F8 / R4 — a live Writer pass holds this group right now, so the text shown is about to move.
     *
     * Derived from the live `runs` rows (`phrase/exclusion.ts`), not from a flag anyone sets: the rail
     * disables "revise this group" off exactly the read the route refuses with, so a button and a 409
     * cannot disagree, and a restart of the server changes the answer with no bookkeeping of ours.
     */
    writer_busy: boolean;
    /**
     * READER SCORING (D-65) — this section's scores, NEWEST FIRST, one entry per scoring run.
     *
     * A section accumulates scores instead of holding one, because the Author asked for "several Reader
     * runs over time" and a single number would throw the trend away: the rail shows the current value
     * and can still say what it was before the last install. The entries are keyed to the group VECTOR
     * they were judged against (`vector_hash`), so a score is never read as a judgement of text that has
     * since been rewritten, and `run_ref` reaches the thread behind the number.
     *
     * PINNED WIRE CONTRACT: `value` / `vector_hash` / `at` / `run_ref` / `rationale` are the field names
     * the dashboard rail consumes. `evidence` stays server-side — the rail draws a percentage, and the
     * quote is in the run's thread when the Author wants to see why.
     */
    scores: PhraseGroupScoreRow[];
    /**
     * PHRASE GROUP LOCK (R1) — this group's CURRENT text is signed off and settled.
     *
     * ALL FOUR FIELDS ARE ADDITIVE AND ABSENCE IS THE MEANING: a row that carries no `locked` key is
     * unlocked — the reading of every book written before the lock exists, and of a group whose lock the
     * Author lifted (`locks.ts:unlockPhraseGroup` writes `locked: false` plus three `null`s). The
     * projection therefore emits `locked` ONLY while a live lock stands, and each metadata field only when
     * the row actually holds it: a store patch cannot delete a key, so an unlocked row carries `null`
     * (`shared/types.ts:PhraseGroup.locked_revision`), and `null` on the wire would be a number-shaped or
     * string-shaped lie rather than an absence. The rail reads `locked_revision` rather than `revision`
     * because the lock names the text a person committed to, which a later install moves past.
     */
    locked?: boolean;
    /** The revision number the live lock fixed — the text that stands. */
    locked_revision?: number;
    /** WHO committed the lock: the Author, or the Editor on a Story that enables it. */
    locked_by?: PhraseGroupLockActor;
    /** ISO instant the lock commit wrote. */
    locked_at?: string;
}

/**
 * One Reader score of one section (D-65) — the projection row, not the stored row.
 *
 * The stored `summary_scores` record carries the ids a join needs; this carries only what the rail
 * draws, which is why `group_id`/`group_key` are absent (the row is already inside its group) and
 * `rationale` is optional (a display line, not a D-15 judgement the loop acts on).
 */
export interface PhraseGroupScoreRow {
    /** 0–100, exactly as the Reader answered it — the projection never re-scales or averages. */
    value: number;
    /** The group revision vector this score judged, so the rail can say which text it describes. */
    vector_hash: string;
    /** When the row was written (the stored record's `created_at`), newest first across the list. */
    at: string;
    /** The run that produced it — the thread the Author can open. */
    run_ref: string;
    /** The Reader's one-line reason, when it gave one. */
    rationale?: string;
}

/** A finding, its group attribution, and R3's resolution against the book as it stands. */
export interface PhraseFindingRow {
    id: string;
    title: string;
    cost: Cost;
    /**
     * T5 (additive) — the claim type, defaulted so a rail never has to interpret absence: `issue` for
     * a row raised before the field existed. The rail stays kind-blind in its layout; the field is here
     * because a proposal and a defect are different work, and hiding that from the read forces a
     * renderer to guess it from the title.
     */
    kind: FindingKind;
    state: Finding['state'];
    seen_count: number;
    /** The ids on the record; empty is the legacy "the whole Overview" reading. */
    group_refs: string[];
    /** True when the record named none, spelled out so a UI need not infer it from an empty array. */
    unscoped: boolean;
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

/**
 * One group INSIDE the Reviewed Summary block (D-67) — what the reviewed Overview stands behind for
 * this section, and why it stands behind THAT text rather than the newest one.
 *
 * This is the rail's answer to the question the Author actually asks ("which revision is my ending,
 * and what happened to the one I liked?"). The live `groups[]` rows answer "what does the book say
 * now"; this answers "what does the crew stand behind, and what has been REJECTED since?". Both are
 * needed because they legitimately differ: the user's Ending example (r1 issue, r2 clean, r3 issue,
 * r4 clean, r5 issue) shows `latest_revision: 5` beside `selected_revision: 4`.
 */
export interface PhraseReviewedGroup {
    id: string;
    key: string;
    /** The Clean revision the reviewed Overview is built from, or null while this group has none. */
    selected_revision: number | null;
    /** The row behind `selected_revision`, so the rail can open the text itself. */
    selected_id: string | null;
    /** The deep-review run whose clean pass earned the verdict; null with no selection. */
    clean_run_ref: string | null;
    /** The group's newest revision number (0 when unwritten) — the number the selection fell back past. */
    latest_revision: number;
    /** True when the newest text is NOT the reviewed one: the state the Author acts on (R5's evidence). */
    superseded: boolean;
    /** An unresolved ISSUE names this group, which blocks its clean verdicts from being selected. */
    issues_open: boolean;
    /** Why there is no selection — `unwritten` / `no_clean_revision`; null when there is one. */
    gap: string | null;
    /**
     * The scores judged against THIS reviewed vector, newest first (D-65 rows, D-67 join).
     *
     * The join is the row's `vector_hash` and nothing else: a Reader's number describes the text it was
     * shown, so a score of an older or newer combination is not this section's reviewed score. The rows
     * are still ALSO on `groups[].scores` with their own hashes (D-65's trend list) — the rail never has
     * to reconcile two copies, because both are views of the same rows.
     */
    scores: PhraseGroupScoreRow[];
}

/** What the Author chose, read back off the Phrase row (D-68), or null when none is valid. */
export interface PhraseChosenSummary {
    /** `{groupId: revisionNumber}` — the vector the choice adopted (its rows are now `latest`). */
    vector: Record<string, number>;
    vector_hash: string;
    /** When the choose committed (the Phrase row's `reviewed_at`). */
    at: string;
    /** The composed text that was chosen, recomposed from the rows the vector names. */
    overview: string;
    /** The scores that judged THAT text, per group, newest first — the number the choice was made under. */
    scores: Record<string, PhraseGroupScoreRow[]>;
}

/** The Reviewed Summary: the Clean selection, the score that judged it, and the Author's choice. */
export interface PhraseReviewedSummary {
    /**
     * `pending` — no complete clean selection and no valid recorded choice;
     * `ready` — a complete reviewed Overview the Author may choose, not the one they chose;
     * `chosen` — the Author's recorded choice stands, whether or not newer reviewed text exists.
     */
    state: 'pending' | 'ready' | 'chosen';
    /** Every group has a selectable Clean revision — the gate a choose and a scoring pass both hang on. */
    complete: boolean;
    /** The live clean selection, catalog order, PARTIAL when `complete` is false. */
    vector: Record<string, number>;
    vector_hash: string;
    /** The composed reviewed Overview; `''` while the selection is partial. */
    overview: string;
    groups: PhraseReviewedGroup[];
    /** The Author's choice, or null when they never chose or the chosen history is gone (a reset). */
    chosen: PhraseChosenSummary | null;
    /** True when the clean selection has moved PAST what the Author chose: newer reviewed text to take. */
    stale: boolean;
    /** The unresolved issues holding a clean verdict back, with the group KEYS each one names. */
    blocking_issues: Array<{ id: string; title: string; cost: Cost; group_keys: string[] }>;
    /**
     * A live Writer pass holds at least one group, so a choose would refuse (D-68's 409 preview).
     *
     * The same `liveGroupRefs` read the route refuses with and the group rows' `writer_busy` uses, so a
     * disabled Choose button and a 409 can never disagree — and the run ids behind it are on
     * `groups[].writer_busy` / the route's own refusal body.
     */
    writer_busy: boolean;
}

/** The state of the group pipeline: what is written, what is reviewed, and whether the mirror agrees. */
export interface PhraseReviewState {
    /** `story.summary_mode`, echoed — the switch is a Setting, not a derived fact (R6). */
    mode: 'groups' | 'sampling';
    /** Catalog keys with no revision yet; empty means the Overview is fully written. */
    unwritten_groups: string[];
    written_groups: number;
    /** `{groupId: revisionNumber}` — the identity the reviews and the deferrals are keyed by. */
    vector: Record<string, number>;
    vector_hash: string;
    /** Critic seats the Author's dial asks for on this vector, and how many have produced a review. */
    review_seats: number;
    reviews_on_current_vector: number;
    deep_reviews_on_current_vector: number;
    open_findings: number;
    /** The critical/major rows the sign-off treats as blocking (§6.8's bar, unchanged by the redesign). */
    blocking_findings: number;
    open_tasks: number;
    /**
     * R6's compatibility mirror: does the legacy `summaries` prose still say what the groups say?
     * `in_sync: false` with `locked: true` is the Author's own doing (L-7a: signed prose is not
     * rewritten under them), which is why the reason travels with the flag.
     */
    mirror: { summary_id: string | null; in_sync: boolean; locked: boolean; fields: string[] };
}

/** The whole group surface for one Story — one read for the Author's rail (R6). */
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
     * The Reviewed Summary (D-67) and the Author's choice (D-68) — ALWAYS present, empty for a book
     * that has no groups, so the rail never has to branch on absence.
     *
     * WHY IT IS A SIBLING OF `review` AND NOT A FIELD ON IT: `review` answers "what is the pipeline
     * doing with the CURRENT text" (seats run, mirror in sync, groups owed); this answers "what text has
     * been READ and passed, what was it scored at, and what did the Author take". They disagree during
     * exactly the window the feature exists for — the newest Ending has an open defect while the reviewed
     * Ending is the earlier clean one — and a single block would have to be wrong in one of those reads.
     */
    reviewed: PhraseReviewedSummary;
}

// ---------------------------------------------------------------------------
// T-W3 — the PER-PHRASE read (`GET /stories/:id/phrases/:key`)
//
// WHY A SECOND SHAPE RATHER THAN EXTRA FIELDS ON `PhraseView`: `GET /stories/:id/phrases` is the
// dashboard's pinned Summary rail — its key list is asserted in order by `phrase-routes.test.ts` and
// consumed field-for-field by `dashboard/api.ts` — so the per-phrase deltas (which phrase this is, its
// copied seed, its structure brief) ride on a NEW read instead of widening the pinned one. The base is
// the SAME projection: `phraseDetailView` is `phraseView`'s shape plus four keys in front and a
// phrase-scoped `review.mirror` omission, built by one shared function, so the two reads can never
// tell two stories about the same rows.
//
// WHAT IS PHRASE-SCOPED IN BOTH: the entry rows, `review.unwritten_groups` / `review.vector`, the
// findings the phrase's entries own, and the reviewed selection. Wave 1 gave every one of those reads a
// `phraseId`; before T-W3 the Summary view called them UNSCOPED, which was the same answer only while
// the book had one phrase.
// ---------------------------------------------------------------------------

/**
 * The dial word a phrase view echoes. The two phrases' OFF words are different on purpose
 * (`phrase/catalog.ts:isPhraseGroupManaged`): the Summary's is `sampling` (the pre-redesign sampler that
 * actually ran) and the Plotlines' is `classic` (the §4.3 + §8.1 tool path), so a client reading
 * `mode: 'classic'` knows it is looking at the classic plotline pipeline rather than a Summary mode.
 */
export type PhraseMode = 'groups' | 'sampling' | 'classic';

/**
 * The Plotlines phrase's structure decision, as the rail shows it (T-W3): what the Editor concluded
 * about the phrase's copied seed, and whether the Author has accepted it.
 *
 * THE MINIMAL THREE FIELDS: the count is the number the chapter entries were materialized from (the
 * accepted brief's, synced onto `summaries.chapter_count` — D-3b), and the status is what tells the rail
 * whether the entries exist yet. The full brief (per-chapter seeds, research questions, notes) stays off
 * this read: the rail's job is "has Phrase ② been structured, and into how many chapters".
 */
export interface PhraseBriefView {
    /** `draft` until the Author accepts it; `accepted` is the moment the chapter entries exist. */
    status: string;
    /** The Editor's chapter count — the number `chapter_1…chapter_N` were materialized from. */
    chapter_count: number;
    /**
     * The accept's stamp, and PRESENT ONLY ONCE THE BRIEF IS ACCEPTED. `plotline_briefs` carries no
     * timestamp of its own (§4's row carries the status), so this is the row's `updated_at` — the moment
     * the accept wrote `status: 'accepted'`, which is the only thing that moves it after creation.
     */
    accepted_at?: string;
}

/** One phrase's whole surface — the pinned view plus that phrase's deltas. */
export interface PhraseDetailView extends Omit<PhraseView, 'mode' | 'review'> {
    /** The catalog kind this read is scoped to (`phrases.key`). */
    key: string;
    /** THIS phrase's dial — see {@link PhraseMode}; the off word is per-phrase, not one shared word. */
    mode: PhraseMode;
    /**
     * This phrase's pipeline state. `mirror` (R6's legacy `summaries` prose check) is the SUMMARY's
     * compatibility report, so it is absent on a phrase with no legacy record to agree with — Phrase ②'s
     * downstream sync is the `plotlines` contract, which the entry rows already show.
     */
    review: Omit<PhraseReviewState, 'mode' | 'mirror'> & {
        mode: PhraseMode;
        mirror?: PhraseReviewState['mirror'];
    };
    /**
     * A PREFIX of the phrase's copied seed, never the whole text (T-W3): the seed is the Author's input,
     * it can be a compiled Overview long enough to bloat every rail poll, and the rail only needs to
     * recognise which text this phrase was written from. The full seed stays on the row.
     */
    seed_head: string;
    /** The seed's true length, so a truncated head still says how much text it stands for. */
    seed_chars: number;
    /** The Plotlines structure brief, or `null` for any other phrase and for a phrase nobody structured. */
    brief: PhraseBriefView | null;
}

/**
 * What the shared projection builds, before either public read narrows it: the pinned view's shape with
 * the two per-phrase fields widened to the per-phrase vocabulary. `phraseView` narrows `mode` back to the
 * Summary's two words and proves `review.mirror` is present; `phraseDetailView` keeps the wide words and
 * makes the mirror optional. Neither cast invents a value the phrase in question cannot send.
 */
type PhraseProjection = Omit<PhraseView, 'mode' | 'review'> & {
    mode: PhraseMode;
    review: Omit<PhraseReviewState, 'mode' | 'mirror'> & {
        mode: PhraseMode;
        mirror?: PhraseReviewState['mirror'];
    };
};

/** How much of a phrase's seed travels on the wire. A prefix, cut at a whole character, never a summary. */
const SEED_HEAD_CHARS = 400;

/**
 * THE compiled Summary — the one text Phrase ② copies when the Author presses the handoff button (T-W3).
 *
 * THE PREFERENCE IS THE SAME ONE the reviewed block reports, in the same order the D-68 choose uses:
 * a COMPLETE clean selection wins (that is the text the crew stands behind, and it is byte-identical to
 * the reviewed Overview the rail shows), and until then the phrase's composed Overview is what the
 * Author has. Answering "compiled" from the live groups alone would copy an Overview some section's open
 * defect is still holding, and answering from the selection alone would say a half-written book has
 * nothing to hand on.
 *
 * `''` is the honest answer for a book with no Summary phrase, and it is the Start verb's 409.
 */
export function compiledSummaryOf(store: Store, story: Story): string {
    const phrase = storyPhraseByKey(store, story.id, PHRASE_SUMMARY_KEY);

    if (phrase === undefined) return '';

    const selection = cleanSelectionOf(store, story, phrase.id);

    return selection.complete ? composeReviewedContentFrom(selection.entries) : phrase.content;
}

/**
 * May Phrase ② be seeded from Phrase ①? The handoff button's enable condition (T-W3).
 *
 * It is deliberately the WEAKER of the two reads: a complete reviewed Overview, or any non-empty composed
 * Overview. The button asks "is there text to copy", and the 409 on the Start verb is what says when the
 * answer is no — a rail that re-derived this rule would be a second opinion about what "Phrase 1 is done"
 * means, and the desk would enable a button the server refuses.
 */
export function summaryIsCompiled(store: Store, story: Story): boolean {
    const phrase = storyPhraseByKey(store, story.id, PHRASE_SUMMARY_KEY);

    if (phrase === undefined) return false;

    return cleanSelectionOf(store, story, phrase.id).complete || phrase.content.trim() !== '';
}

/** The dial word one phrase echoes: `groups`, or that phrase's own off value (see {@link PhraseMode}). */
function phraseModeOf(story: Story, phraseKey: string): PhraseMode {
    if (isPhraseGroupManaged(story, phraseKey)) return 'groups';

    return phraseKey === PHRASE_PLOTLINES_KEY ? 'classic' : 'sampling';
}

/**
 * The newest structure brief of one phrase, in the same pick order the loop's prompt compiler uses for
 * the Seed brief (`created_at` then id, newest first). An accepted brief is preferred over a draft only
 * through that order — an accept moves `updated_at`, not `created_at` — so this stays one rule, and a
 * re-structured phrase shows the structure the Editor wrote LAST.
 */
function plotlineBriefView(store: Store, phraseId: string): PhraseBriefView | null {
    const brief = store.plotlineBriefs
        .list()
        .filter((row) => row.phrase_id === phraseId)
        .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id))[0];

    if (brief === undefined) return null;

    return {
        status: brief.status,
        chapter_count: brief.chapter_count,
        ...(brief.status === 'accepted' ? { accepted_at: brief.updated_at } : {})
    };
}

/** Closed runs of one claim family — the "has this seat reported yet?" read (L-3: the rows are the state). */
function closedRunsFor(store: Store, storyId: string, prefix: string): number {
    return store.runs.list().filter(
        (run) => run.story_id === storyId && !isLiveRun(run) && (run.work_item_ref ?? '').startsWith(prefix)
    ).length;
}

/**
 * The Story's Reader scores, transposed onto their groups, NEWEST FIRST (D-65).
 *
 * One read for the whole view rather than one per group, for the reason the finding debt above gets the
 * same treatment: five groups asking the same collection the same question five times is five sorts of
 * the same rows. Order is `created_at` descending with the row id as the tie-break, so two rows written
 * inside one commit still list deterministically and the rail's "current score" is the same row after a
 * restart (L-3: the rows are the state, and so is the order they read back in).
 */
function sectionScoresByGroup(store: Store, storyId: string): Map<string, PhraseGroupScoreRow[]> {
    const byGroup = new Map<string, PhraseGroupScoreRow[]>();

    const rows = store.summaryScores
        .list()
        .filter((row) => row.story_id === storyId)
        .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id));

    for (const row of rows) {
        const entry: PhraseGroupScoreRow = {
            value: row.score,
            vector_hash: row.vector_hash,
            at: row.created_at,
            run_ref: row.run_ref,
            ...(row.rationale === '' ? {} : { rationale: row.rationale })
        };

        byGroup.set(row.group_id, [...(byGroup.get(row.group_id) ?? []), entry]);
    }

    return byGroup;
}

/**
 * The scores that judged ONE exact group vector, transposed onto their groups (D-67's join).
 *
 * Filtering keeps the source's newest-first order, so the rail's "current reviewed score" is the same
 * row before and after a restart. An empty hash matches nothing: a partial selection has a hash but no
 * Overview, and the seat only ever claims a COMPLETE one, so score rows never carry a partial hash.
 */
function scoresForVector(
    byGroup: Map<string, PhraseGroupScoreRow[]>,
    vectorHash: string
): Map<string, PhraseGroupScoreRow[]> {
    const matched = new Map<string, PhraseGroupScoreRow[]>();

    if (vectorHash === '') return matched;

    for (const [groupId, rows] of byGroup) {
        const rowsAtHash = rows.filter((row) => row.vector_hash === vectorHash);

        if (rowsAtHash.length > 0) matched.set(groupId, rowsAtHash);
    }

    return matched;
}

/**
 * The Reviewed Summary block (D-67, D-68) — the Clean selection, its Reader score, and the choice.
 *
 * EVERY NUMBER HERE IS A READ OF ROWS, which is what makes the block survive a restart with no
 * bookkeeping: the selection is `phrase/reviewed.ts:cleanSelectionOf` (the newest Clean revision per
 * group whose group carries no unresolved issue), the choice is `chosenSelectionOf` (the Phrase row's
 * vector, re-validated against the rows), and the scores are joined by vector hash. Nothing is cached,
 * nothing is set by a hook, and a rail that polls this twice in a row cannot see two different answers.
 *
 * THE THREE STATES, spelled here because they are the part a reader argues about:
 *   - `pending`: no complete selection and no valid choice — the rail has nothing to show but the gaps;
 *   - `ready`: a complete reviewed Overview exists that the Author has NOT chosen (this includes the
 *     case where they chose earlier and the pipeline has since reviewed a different combination — that
 *     is `stale: true`, and the choose is offered again); and
 *   - `chosen`: the Author's choice stands and there is nothing newer to take. Immediately after a
 *     choose this is the state even though the selection looks empty: the chosen rows are the live
 *     `latest` rows, they carry no Clean stamp (nobody has re-read them), and the choice record is the
 *     only reviewed Summary the book has.
 */
function reviewedSummaryView(
    store: Store,
    story: Story,
    phrase: Phrase | undefined,
    groups: readonly PhraseGroup[],
    scoresByGroup: Map<string, PhraseGroupScoreRow[]>,
    /** The live Writer-held group ids, read ONCE by `phraseProjection` for the group rows too (F8's read). */
    held: Set<string>
): PhraseReviewedSummary {
    // T-W3 — every read here is scoped to THIS phrase. Wave 1 gave `cleanSelectionOf` a `phraseId` for
    // exactly this: unscoped, a chapter entry of Phrase ② would have to be clean before the reviewed
    // SUMMARY existed, and the per-phrase read would report the Summary's choice beside the chapter rows.
    // `''` is the "no such phrase" idiom (`phraseGroupsOf`'s filter then matches nothing), which is the
    // same empty answer a book with no rows for this phrase gets anyway.
    const scoped = phrase?.id ?? '';
    const selection = cleanSelectionOf(store, story, scoped);
    const chosen = chosenSelectionOf(store, story, scoped);
    const gaps = new Map(selection.gaps.map((gap) => [gap.group_id, gap]));
    const selected = new Map(selection.entries.map((entry) => [entry.group.id, entry]));
    const reviewedScores = scoresForVector(scoresByGroup, selection.vector_hash);
    const chosenScores = scoresForVector(scoresByGroup, chosen?.vector_hash ?? '');
    const keyById = new Map(groups.map((group) => [group.id, group.key]));

    const reviewedGroups: PhraseReviewedGroup[] = groups.map((group) => {
        const entry = selected.get(group.id);
        const gap = gaps.get(group.id);

        return {
            id: group.id,
            key: group.key,
            selected_revision: entry?.revision.number ?? null,
            selected_id: entry?.revision.id ?? null,
            clean_run_ref: entry?.revision.clean_run_ref ?? null,
            // R2 keeps the group row's number and its newest revision row in step, so this is the
            // "newest text" the fallback passed over — no second history walk needed.
            latest_revision: group.revision,
            superseded: entry !== undefined && entry.revision.number !== group.revision,
            issues_open: gap?.issues_open ?? false,
            gap: gap?.reason ?? null,
            scores: reviewedScores.get(group.id) ?? []
        };
    });

    // An unresolved issue names a group, so the rail can say WHICH defect is holding a clean verdict
    // back instead of leaving the Author to guess why the reviewed Ending is three revisions old. The
    // scope is R3's read, so an unscoped finding lists all five keys — the same reading that blocks it.
    const keysOf = new Set(groups.map((group) => group.id));
    const blockingIssues = openIssueFindings(store, story.id).map((finding) => ({
        id: finding.id,
        title: finding.title,
        cost: finding.cost,
        group_keys: findingGroupScope(store, story, finding).refs
            .filter((groupId) => keysOf.has(groupId))
            .map((groupId) => keyById.get(groupId) ?? groupId)
    }));

    const chosenAtChosenHash = chosen !== undefined && chosen.vector_hash === selection.vector_hash;

    return {
        state: selection.complete
            ? chosenAtChosenHash
                ? 'chosen'
                : 'ready'
            : chosen === undefined
              ? 'pending'
              : 'chosen',
        complete: selection.complete,
        vector: selection.vector,
        vector_hash: selection.vector_hash,
        overview: selection.complete ? composeReviewedOverview(selection) : '',
        groups: reviewedGroups,
        chosen:
            chosen === undefined
                ? null
                : {
                      vector: chosen.vector,
                      vector_hash: chosen.vector_hash,
                      at: phrase?.reviewed_at ?? '',
                      overview: composeReviewedOverview(chosen),
                      scores: Object.fromEntries(
                          chosen.entries.map((entry) => [entry.group.id, chosenScores.get(entry.group.id) ?? []])
                      )
                  },
        stale: chosen !== undefined && selection.complete && !chosenAtChosenHash,
        blocking_issues: blockingIssues,
        // T-W3 — the SAME scoped held-set the group rows read (`phraseProjection` computes it once per
        // phrase). The old unscoped `liveGroupRefs` read every phrase's entries, so a chapter pass in
        // flight greyed out the Summary's Choose button on a book whose Summary nobody was writing.
        writer_busy: groups.some((group) => held.has(group.id))
    };
}

/**
 * THE phrase-scoped projection — one phrase's whole surface, built once per read (R6, generalized by
 * T-W3).
 *
 * It answers "what does this phrase say, who wrote each entry, what is wrong with it, and what has been
 * reviewed?" without ever writing — a pure read of `phrases`, `phrase_groups`, `group_revisions`,
 * `findings`, `tasks` and the run ledger, so opening the rail cannot move a book (R6's "legacy stories
 * stay readable with no destructive migration" holds in both directions).
 *
 * EVERY READ IS SCOPED TO `phraseKey`, and that is the whole of the generalization: the Summary read
 * (`PHRASE_SUMMARY_KEY`) is byte-identical to the one this file has always produced, because a book with
 * one phrase gets the same rows from a scoped read and an unscoped one. The moment a second phrase is
 * started, the unscoped forms start answering for two artifacts at once — `phraseGroupsOf` interleaves
 * `chapter_1` and `premise` because both are `order: 1`, an unscoped finding's scope is EVERY entry on
 * the book, and `liveGroupRefs` lets a chapter pass grey out the Summary's buttons — so the scoped forms
 * are what this projection uses now (wave 1 gave each of those reads its `phraseId` parameter).
 *
 * A LEGACY Story (no `summary_mode`, so no phrase rows) is not an error: the view comes back with
 * `mode: 'sampling'` and empty groups, which is the truth about that book. The rail shows the legacy
 * sampling panel for it, and `POST /stories/:id/phrases/import` is how the Author opts into groups.
 */
function phraseProjection(store: Store, story: Story, phraseKey: string): PhraseProjection {
    const phrase = storyPhraseByKey(store, story.id, phraseKey);
    // ONE phrase's entries, in that phrase's composition order. An un-started phrase has NONE — `[]` is
    // the honest answer, where the unscoped read would have handed back another phrase's rows.
    const groups = phrase === undefined ? [] : phraseGroupsOfPhrase(store, story.id, phrase.id);
    const groupIds = new Set(groups.map((group) => group.id));
    // T-W3 — WHICH findings belong to this phrase's read. A finding is here when its RESOLVED R3 scope
    // names at least one of this phrase's entries, and an UNSCOPED finding (whose scope is every entry on
    // the book, `findings.ts:findingGroupScope`) is therefore every phrase's debt. The one exception is a
    // Summary read with NO phrase row — a legacy book, where there is no second phrase that could own a
    // claim and the pre-Phrase-② read showed the Author everything. `GET /stories/:id/phrases` keeps its
    // exact findings list on every book that has one phrase.
    const findings = storyFindings(store, story.id).filter(
        (finding) =>
            (phrase === undefined && phraseKey === PHRASE_SUMMARY_KEY) ||
            findingGroupScope(store, story, finding).refs.some((id) => groupIds.has(id))
    );

    // R3's per-group debt, computed once per finding and then transposed onto the group rows: the rail
    // must be able to say "Premise still owes finding_3 a revision" without a second resolution pass.
    const owedByGroup = new Map<string, string[]>();

    const findingRows = findings.map((finding) => {
        const scope = findingGroupScope(store, story, finding);
        const resolution = findingResolution(store, story, finding);

        if (resolution.missing.length > 0) {
            for (const groupId of resolution.missing) {
                owedByGroup.set(groupId, [...(owedByGroup.get(groupId) ?? []), finding.id]);
            }
        }

        return {
            id: finding.id,
            title: finding.title,
            cost: finding.cost,
            // T5: defaulted on the way out, so the rail reads one shape for a pre-field row and a new
            // one. No renderer changes: this is data the read carries, not a badge it draws.
            kind: finding.kind ?? 'issue',
            state: finding.state,
            seen_count: finding.seen_count,
            group_refs: [...(finding.group_refs ?? [])],
            unscoped: scope.unscoped,
            targeted: resolution.targeted,
            resolved: resolution.resolved,
            missing: resolution.missing,
            resolved_all: resolution.resolved_all
        };
    });

    // F8 — read once for the whole view: the groups a live Writer pass of THIS phrase holds (R4). A group
    // with no `group_refs` on its live run counts as held for EVERY group of that phrase, which is
    // `liveGroupRefs`'s fail-closed reading — the rail then disables five buttons rather than let an edit
    // race a writer — and the scoping is what stops a chapter pass holding the Summary's buttons.
    const held = liveGroupRefs(store, story.id, phrase?.id ?? '');
    // D-65 — the Reader's scores, likewise read once and transposed onto the group rows. A book with
    // no scoring run yet gets an empty list on every group: the rail shows "not scored", not a zero.
    const scoresByGroup = sectionScoresByGroup(store, story.id);


    const groupRows: PhraseGroupRow[] = groups.map((group) => {
        const history = groupRevisionHistory(store, group.id);
        // R1 — the live lock, read once so the four projected keys below agree with each other (a row
        // that says `locked` but names no revision is a badge over a claim the read cannot support).
        const lockLive = isPhraseGroupLocked(group);
        // The newest `archived` row IS the revision the latest one replaced. One body only: the pane's
        // latest-vs-previous diff needs it, and nothing else in the history belongs on this read.
        //
        // D-68 adds a second source: a choose discards every row it passed over, so the text the chosen
        // revision replaced is `discarded`, not `archived`. Falling back rather than reporting an empty
        // `previous_content` keeps the diff working across a choose — the alternative is a rail that
        // silently loses its "before" side on the one transition the Author cares about.
        const replaced =
            history.find((revision) => revision.state === 'archived') ??
            history.find((revision) => revision.state === 'discarded');

        return {
            id: group.id,
            key: group.key,
            title: group.title,
            description: group.description,
            order: group.order,
            content: group.content,
            revision: group.revision,
            updated_by: group.updated_by ?? null,
            previous_content: replaced?.content ?? '',
            // D-68: `discarded` rows stay in the store (R3's closure join walks them) and never come back
            // as candidates, so the live line hides them; `reviewed` is where the choice is reported.
            history: history
                .filter((revision) => revision.state !== 'discarded')
                .map((revision) => ({
                    id: revision.id,
                    number: revision.number,
                    state: revision.state,
                    at: revision.created_at,
                    run_ref: revision.run_ref ?? null,
                    finding_refs: [...(revision.finding_refs ?? [])],
                    task_refs: [...(revision.task_refs ?? [])],
                    chars: revision.content.length,
                    // D-67: the Clean stamp rides with its row, so the history rail can mark the text a
                    // cross-group pass passed without a second read of the reviewed block.
                    clean: revision.clean === true,
                    clean_run_ref: revision.clean_run_ref ?? null
                })),
            owed_by_findings: owedByGroup.get(group.id) ?? [],
            writer_busy: held.has(group.id),
            // D-65, newest first; `[]` until a scoring run has answered for this vector.
            scores: scoresByGroup.get(group.id) ?? [],
            // R1 — the lock's four fields, each present ONLY when the row actually carries it (see the
            // note on `PhraseGroupRow.locked`). An unlocked group keeps the exact row it sent before the
            // lock existed, which is what a rail rendering a pre-lock payload expects.
            ...(lockLive ? { locked: true as const } : {}),
            ...(lockLive && typeof group.locked_revision === 'number' ? { locked_revision: group.locked_revision } : {}),
            ...(lockLive && (group.locked_by === 'author' || group.locked_by === 'editor')
                ? { locked_by: group.locked_by }
                : {}),
            ...(lockLive && typeof group.locked_at === 'string' ? { locked_at: group.locked_at } : {})
        };
    });

    const openFindings = findings.filter(
        (finding) => finding.state !== 'fixed' && finding.state !== 'discarded' && finding.state !== 'disputed'
    );
    const openTasks = store.tasks.list().filter((task) => task.story_id === story.id && task.state !== 'done');

    const vector = groupRevisionVector(store, story.id, phrase?.id ?? '');
    const vectorHash = groupVectorHash(vector);
    const seats = screeningSizeOf(story);

    // R6's mirror, READ rather than trusted: the legacy fields are compared against the group texts
    // they are supposed to mirror. A drift means either a locked Summary (the Author's choice) or a
    // book whose groups were written by something that skipped the mirror — and the rail says so
    // instead of silently showing two different answers to "what is the premise?".
    //
    // T-W3 — it is the SUMMARY phrase's report (`SUMMARY_MIRROR_FIELDS` is the five `summaries` prose
    // fields, and `phrase/revisions.ts:syncSummaryMirror` is the only arm that writes them), so the
    // per-phrase read drops it for any phrase that has no legacy record to agree with; Phrase ②'s
    // downstream sync is the `plotlines` contract, and its entries are the rows the same read lists.
    const summary = storySummary(store, story.id);
    const inSync =
        summary === undefined
            ? groups.length === 0
            : groups.every((group) => {
                  const field = SUMMARY_MIRROR_FIELDS[group.key as keyof typeof SUMMARY_MIRROR_FIELDS];
                  const value = field === undefined ? undefined : (summary as unknown as Record<string, unknown>)[field];

                  return typeof value === 'string' ? value.trim() === group.content.trim() : group.content.trim() === '';
              });

    return {
        story_id: story.id,
        // THE PER-PHRASE DIAL (`isPhraseGroupManaged`), not the book's Summary switch: a grouped Plotlines
        // phrase on a sampling book is group-managed for Phrase ②, and the read says so for that phrase.
        // For Phrase ① this is the same predicate `isGroupManagedStory` always used, same words, same value.
        mode: phraseModeOf(story, phraseKey),
        phrase_id: phrase?.id ?? null,
        revision: phrase?.revision ?? 0,
        // THE PHRASE'S OWN COMPOSITION ORDER (seam S7): the Summary's five catalog keys, a chapter set's
        // chapter numbers. The Summary rank is the same function this read always used, so its Overview is
        // byte-identical; a chapter set composed under the Summary rank would rely on unknown keys tying.
        overview: groups.length === 0 ? '' : composeGroupContentFrom(groups, (key) => phraseGroupRankOf(phraseKey, key)),
        groups: groupRows,
        findings: findingRows,
        tasks: openTasks.map((task) => ({
            id: task.id,
            title: task.title,
            state: task.state,
            owner_role: task.owner_role ?? null,
            attempts: task.attempts ?? 0,
            finding_ref: task.finding_ref ?? null
        })),
        review: {
            mode: phraseModeOf(story, phraseKey),
            unwritten_groups: groups.filter((group) => group.revision === 0).map((group) => group.key),
            written_groups: groups.filter((group) => group.revision > 0).length,
            vector,
            vector_hash: vectorHash,
            review_seats: seats,
            // Keyed by the vector hash the generator uses (`loop/work.ts:phase1GroupCandidates`), so the
            // count answers "has this TEXT been read?" and a new install re-arms the seats by itself.
            // The hash is built from THIS phrase's ids, so a chapter vector and a Summary vector count
            // their own passes.
            reviews_on_current_vector: closedRunsFor(store, story.id, `wi_review_groups_${vectorHash}_`),
            deep_reviews_on_current_vector: closedRunsFor(store, story.id, `wi_group_check_${vectorHash}_`),
            open_findings: openFindings.length,
            // The blocking bar is §6.8's, unchanged by the redesign: `critical` and `major` (the two
            // words `FINDING_COSTS` gates on), never a cost the sign-off tolerates.
            blocking_findings: openFindings.filter(
                (finding) => finding.cost === 'critical' || finding.cost === 'major'
            ).length,
            // T-W3 — `tasks` stays the Story's open queue, in both reads: a `Task` row carries a
            // `finding_ref` and no entry scope of its own, so there is nothing to scope it BY, and
            // inventing a join here would be the projection guessing what the loop booked.
            open_tasks: openTasks.length,
            mirror: {
                summary_id: summary?.id ?? null,
                in_sync: inSync,
                locked: summary?.locked ?? false,
                fields: Object.keys(SUMMARY_MIRROR_FIELDS)
            }
        },
        // D-67/D-68 — the reviewed block. Computed AFTER `review` because it reads the same rows the
        // group rows and the score transpose already read (no second pass over the collections), and it
        // is always present: a legacy book simply reports `pending` with no groups.
        reviewed: reviewedSummaryView(store, story, phrase, groups, scoresByGroup, held)
    };
}

/**
 * THE pinned Summary rail read — `GET /stories/:id/phrases` (R6).
 *
 * T-W3 kept this function's OUTPUT byte-identical and made its BODY the Summary arm of one shared
 * projection: the dashboard's contract is its exact key list and its exact per-group rows, both pinned
 * by `phrase-routes.test.ts` and consumed field-for-field by `dashboard/api.ts`, so the phrase
 * generalization had to arrive underneath it rather than on top of it. The one visible consequence is a
 * fix, not a change of contract: with a Plotlines phrase started on the book, this read is now scoped to
 * the Summary's own entries (its `groups`, its vector, its findings, its live Writers) instead of
 * interleaving the chapter entries by `order`.
 */
export function phraseView(store: Store, story: Story): PhraseView {
    const base = phraseProjection(store, story, PHRASE_SUMMARY_KEY);

    // The Summary phrase always has a legacy prose mirror to report (`review.mirror`), and its dial's
    // off word is `sampling`, so the two narrowings below are facts about THIS phrase, not casts that
    // hide a value the Summary can send. Key ORDER is preserved: re-assigning a key that already exists
    // keeps the position the projection built it in.
    return {
        ...base,
        mode: base.mode as PhraseView['mode'],
        review: base.review as PhraseView['review']
    };
}

/**
 * `GET /stories/:id/phrases/:key` — one phrase's read, deltas and all (T-W3).
 *
 * THE DELTAS, and why each one is a delta rather than a change to the pinned view:
 *   - `key` says which phrase this is, so a client that asked for `plotlines` can tell the read from a
 *     mis-routed Summary read instead of inferring it from the entry keys;
 *   - `seed_head`/`seed_chars` are the phrase's copied SEED, previewed rather than sent: the seed is the
 *     text this phrase is written from, and it is exactly the fact the rail has to show next to a
 *     handoff button so the Author can see WHICH text got copied (and see that it did not change when
 *     Phrase ① was edited later). The full text stays on the row;
 *   - `brief` is the Plotlines structure decision — the Editor's chapter count and whether the Author has
 *     accepted it, which is what tells the rail the chapter entries exist yet. Every other phrase answers
 *     `null`, so the key is always there and no client has to feature-detect it;
 *   - `review.mirror` is dropped for a phrase with no legacy prose record to agree with (R6's mirror is
 *     the `summaries` fields, and Phrase ②'s downstream sync is the `plotlines` contract, visible as the
 *     entries' own text).
 *
 * Works for `summary` too — the deltas are the same four keys over the same projection the pinned read
 * returns, so a client that wants one shape for both phrases can call this route and ignore the extras.
 */
export function phraseDetailView(store: Store, story: Story, phraseKey: string): PhraseDetailView {
    const base = phraseProjection(store, story, phraseKey);
    const phrase = storyPhraseByKey(store, story.id, phraseKey);
    // THE COPIED SEED, through the one read that interprets `Phrase.seed` (`phrase/catalog.ts:phraseSeedOf`):
    // a row created before the field exists falls back to the Story's Seed, which is the only text that
    // phrase could have been written from. Never the whole text on the wire — see the field note.
    const seed = phraseSeedOf(phrase, story);
    const { mirror, ...reviewRest } = base.review;

    return {
        key: phraseKey,
        ...base,
        // DESTRUCTURED, not `mirror: undefined`, so the key is genuinely absent from the payload for a
        // phrase that has no mirror to report rather than riding along with a null-ish value.
        ...(mirror === undefined || phraseKey === PHRASE_SUMMARY_KEY ? { review: base.review } : { review: reviewRest }),
        seed_head: seed.slice(0, SEED_HEAD_CHARS),
        seed_chars: seed.length,
        brief: phrase === undefined || phraseKey !== PHRASE_PLOTLINES_KEY ? null : plotlineBriefView(store, phrase.id)
    };
}
