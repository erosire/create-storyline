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
    loopStory,
    storyChapters,
    storyFindings,
    storyIdeas,
    storyPlotlines,
    storySummary,
    undecidedIdeas,
    verdictsFor
} from '../loop/records';
import type {
    CompletionPreview,
    CostDistribution,
    FailingCriterion,
    GoalSurface,
    QueueItem,
    StoryLevels,
    StoryRow,
    StoryView
} from '../../dashboard/api';
import type { CriteriaEngine, LevelReport, LevelStatus } from '../criteria/engine';
import type { DigestBuilder } from '../digest/digest';
import type { CommitEvent, Store } from '../store';
import type { Cost, Finding, Idea, Story, Task } from '../../shared/types';
import type { StreamKind } from '../../dashboard/api';

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

    for (const event of store.journal) {
        if (event.collection !== 'findings') continue;

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

// ---------------------------------------------------------------------------
// §10.2 U-4…U-17 — the whole Story view (one round trip, W9)
// ---------------------------------------------------------------------------

/**
 * `GET /stories/:id` — every slice THE STORY region renders, in the order the panes read them. The
 * §4 collections are returned as-is (P1: the dashboard reads records, it does not receive copies of
 * them); only the computed slices (`goal`, `cost_distribution`, `completion_preview`) are built here.
 */
export function storyView(deps: ProjectionDeps, story: Story): StoryView {
    const { store, criteria, digest } = deps;
    const summary = storySummary(store, story.id) ?? null;

    return {
        story,
        summary,
        plotlines: storyPlotlines(store, story.id),
        chapters: storyChapters(store, story.id),
        goal: goalSurface(deps, story),
        ideas: storyIdeas(store, story.id),
        revisions: store.revisions.list().filter((revision) => revision.story_id === story.id),
        // U-13 (D-21): the side-by-side panes must show the judgement that goes with each draft. §6.2a
        // files verdicts per revision — the Checker appends the verdict to `revisions.verdict_refs`
        // (tools/checker.ts) — and the §4.9 rows still travel as their own slice so the panes can match
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
        level_history: levelHistoryOf(story)
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

/** Collections whose rows the STORY region renders, so a write there is a `story` event. */
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
    'ledger'
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
