// §10 / W9-W13 — the `/v1/storyline` HTTP surface (T7).
//
// WHAT THIS FILE OWNS: the route table the pinned dashboard client (`src/dashboard/api.ts`) calls, the
// JSON body validation in front of it, and the MAPPING from an HTTP request to a verb on the real
// `LoopEngine` (W4's `EngineApi`). It owns no business rule: every mutation is delegated to the engine
// so the rules live in one place (L-0/L-6/L-7/L-17/L-25/L-31), and every projection is delegated to
// `./projections` so the criteria engine stays the only level calculator (L-14/W3).
//
// ERROR SHAPE — the product's sentences, not log lines (L-13). Every non-2xx body is `{error: string}`
// and the client re-throws that text verbatim (`ApiError`), so:
//   * 400 — the body was not the shape the route needs (a missing/ill-typed field).
//   * 404 — a path id this server has never heard of, checked BEFORE any engine call so a typo cannot
//     reach a verb and produce a 409 that reads like a refusal.
//   * 409 — every refusal the ENGINE raises, with its message passed through untouched. That is how
//     L-7a's tray sentence, D-37's pause sentence, and D-29's decision copy reach the Author exactly as
//     W4's acceptance tests pinned them. `CasConflict` (T-4) lands here too: a stale write is a refusal
//     to re-read, not a malformed request.
//
// ENGINE-API DELTAS THIS ROUTE LAYER COVERS (reported upstream, not hidden):
//   1. `EngineApi.lockPhase` refuses a non-empty Ideas tray (L-7a) and checks phase ORDER (L-33), but it
//      does NOT check that the phase's Goal passes — U-16's "appears only when that phase's Goal passes"
//      is enforced here (`/lock`), and the tray case is deliberately routed THROUGH the engine so its
//      exact L-7a sentence is the one the Author reads.
//   2. There is no engine verb for discarding a Finding or deferring/discarding an Idea, so those three
//      routes write the state directly through `store.commit` with `{author: true, why}` attribution
//      (D-8/P11). `approveFinding`/`decideIdea` are the ones that carry real machinery, and those DO go
//      through the engine.
//   3. `EngineApi.setGoal` replaces the criteria list WHOLESALE (`GoalPatch.criteria: Criterion[]`),
//      while the pinned `GoalPatch` body is a list of ORDERED OPS (G-1: add/remove/setHard). The ops are
//      folded into the Story's evaluated criteria here before the engine is called.
//   4. `undoLast(chapterId)` is chapter-scoped (L-17a "restores the most recent change to that chapter");
//      the pinned `UndoTarget` also names a `section_id`, which this layer logs into the attribution and
//      otherwise passes through.
//   5. §8.6's assistant run is dispatched straight to `RunExecutor.execute` (the sweep never produces
//      `assistant` items). The run row is created synchronously inside `execute` (D-18), so the route can
//      return the row and let the run finish behind it — the crew panel is a list of RUN ROWS (U-7), and
//      §8.6's answer is a change to an artifact, not a chat reply.
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { duplicateTemplate, validateTemplate } from '../templates/templates';
import { authorAttr, competingRevisions, requireStory, undecidedIdeas } from '../loop/records';
// U-13's two routes install and queue drafts, so they use the tool layer's own §4.15 body codec and
// its task opener: the Editor's `selectRevision`/`requestMerge` read the SAME functions, so an
// Author's choice and a Checker's choice cannot disagree about what a stored draft says (D-22, D-23).
import { openTask, revisionBodyFields, revisionBodySections } from '../tools/artifacts';
import type { Store } from '../store';
import type { Context } from 'hono';
import type { WorkItem } from '../run/types';
import type { RunExecutor } from '../run/executor';
import type { DigestBuilder } from '../digest/digest';
import type { CriteriaEngine } from '../criteria/engine';
import type { GoalPatch as EngineGoalPatch } from '../loop/types';
import type { LoopEngine } from '../loop/engine';
import type { Cost, Criterion, Revision, Run, Story, StoryPhase, Template } from '../../shared/types';
import type { GoalCriterionOp } from '../../dashboard/api';
import { feedEvents, goalSurface, queueItems, storyRow, storyRows, storyView } from './projections';
import type { FeedEvent, ProjectionDeps } from './projections';

/** §8.6 — the Author-invoked harness. Seeded at boot by `./server` (D-17: built-in, duplicate-only). */
export const ASSISTANT_TEMPLATE = 'assistant';
export const ASSISTANT_ROLE = 'assistant';

/** The four costs the D-35 dial may name, for body validation. */
const COSTS: string[] = ['critical', 'major', 'minor', 'taste'];

/** §6.3a L-32 — the only two backtrack targets (phase ③ is where the Story already is). */
const BACKTRACK_PHASES: string[] = ['summary', 'plotlines'];

/** Everything the routes need. Built once per process by `./server`. */
export interface StorylineRoutesDeps extends ProjectionDeps {
    engine: LoopEngine;
    executor: RunExecutor;
    /** SSE debounce: one commit bursts into one frame per topic, so a sweep cannot flood the client. */
    streamDebounceMs?: number;
}

// ---------------------------------------------------------------------------
// Request/response plumbing
// ---------------------------------------------------------------------------

/** L-13: the body is the sentence the Author reads. Nothing else goes in it. */
const errorResponse = (c: Context, status: 400 | 404 | 409, message: string) => c.json({ error: message }, status);

/**
 * Maps anything a verb threw onto a status. `CasConflict` (T-4) and every engine refusal are 409s with
 * the engine's own words; a genuine fault (a bug, not a rule) keeps its message too, because a 500 that
 * says nothing is worse for the Author than a 409 that names the rule.
 */
const refusal = (c: Context, error: unknown) =>
    errorResponse(c, 409, error instanceof Error ? error.message : String(error));

/** Reads a JSON body, or answers 400 for the caller (a body that is not an object is not a body). */
async function readBody<T>(c: Context): Promise<{ ok: true; body: T } | { ok: false; response: Response }> {
    const raw = await c.req.json().catch(() => undefined);

    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, response: errorResponse(c, 400, 'this route needs a JSON object body.') };
    }

    return { ok: true, body: raw as T };
}

/** The `why` every Author-initiated write carries (D-8, P11, T-5: the store refuses a blank one). */
const authorWhy = (route: string, storyId: string, detail = '') =>
    `the Author used ${route} on ${storyId}${detail ? ` — ${detail}` : ''} (§10 dashboard write)`;

// ---------------------------------------------------------------------------
// Body shapes (pinned by `src/dashboard/api.ts`; validated, never trusted)
// ---------------------------------------------------------------------------

interface StoryCreateBody {
    title?: unknown;
    idea?: unknown;
    chapter_count?: unknown;
}

interface StoryPatchBody {
    title?: unknown;
    idea?: unknown;
    chapter_count?: unknown;
    auto_approve?: unknown;
}

interface WhyBody {
    why?: unknown;
}

interface NoteBody {
    note?: unknown;
}

interface BacktrackBody {
    phase?: unknown;
}

interface SectionBody {
    content?: unknown;
}

interface UndoBody {
    chapter_id?: unknown;
    section_id?: unknown;
}

interface DirectiveBody {
    text?: unknown;
}

interface TemplateAssignBody {
    template_ids?: unknown;
}

interface BarBody {
    bar_override?: unknown;
}

interface GoalPatchBody {
    threshold_soft?: unknown;
    criteria?: unknown;
}

interface AssistantBody {
    target?: unknown;
    text?: unknown;
}

/**
 * U-13 / D-24 — the Author's selection of one draft. `note` is the sentence the next run reads in
 * the draft's `selection_note`; §4.15's own wording is the default so a bare click is still attributed.
 */
interface RevisionSelectBody {
    note?: unknown;
}

/**
 * U-13a — the Author's merge request. The same four fields §8.2's `requestMerge` takes, because the
 * Author's desk asks for the same thing a Checker does: "take this half of this draft and that half
 * of that one" (D-23). `why` is optional here and defaults to the Author's own sentence.
 */
interface RevisionMergeBody {
    unit_ref?: unknown;
    revision_ids?: unknown;
    parts?: unknown;
    why?: unknown;
}

interface TemplateBody {
    template?: unknown;
    duplicate_of?: unknown;
}

// ---------------------------------------------------------------------------
// The route table
// ---------------------------------------------------------------------------

export function createStorylineRoutes(deps: StorylineRoutesDeps): Hono {
    const { store, engine, criteria, digest, executor } = deps;
    const projectionDeps: ProjectionDeps = { store, criteria, digest };
    const debounceMs = deps.streamDebounceMs ?? 100;
    const app = new Hono();

    /** The Story a path names, or the 404 this layer answers before any engine call. */
    const storyOf = (id: string): Story | undefined => store.stories.get(id);
    const missing = (c: Context, kind: string, id: string) =>
        errorResponse(c, 404, `no ${kind} named ${id} is in the book (P1: the store is the memory)`);

    /**
     * Reads a path param from a handler whose route types Hono cannot infer (the two route factories
     * below take a plain `Context`). A missing param reads as `''`, which simply misses every lookup and
     * answers 404 — the same answer a wrong id gets.
     */
    const param = (c: Context, name: string): string => c.req.param(name) ?? '';

    /**
     * §4.12 rows are addressed by id OR by slug, exactly as `run/harness.ts:findTemplate` resolves a
     * `template_ref` — the catalogue's name IS its handle in the Story's `template_refs`, so a client that
     * only ever saw slugs can still patch the card it is looking at (D-17b).
     */
    const templateOf = (ref: string): Template | undefined =>
        store.templates.get(ref) ?? store.templates.list().find((row) => row.name === ref);

    /**
     * §4.15's unit of a draft, resolved from a bare id (D-21). A revision row names its unit only by
     * `unit_ref`, so the two U-13 routes need the kind back — and the three collections are the whole
     * vocabulary §4.15 allows. T-3 holds: a row from another Story reads as a miss, not as a unit.
     */
    const revisionUnit = (
        storyId: string,
        unitRef: string
    ): { unit_kind: Revision['unit_kind']; id: string; rev: number } | undefined => {
        const chapter = store.chapters.get(unitRef);

        if (chapter !== undefined)
            return chapter.story_id === storyId
                ? { unit_kind: 'chapter', id: chapter.id, rev: chapter.rev }
                : undefined;

        const plotline = store.plotlines.get(unitRef);

        if (plotline !== undefined)
            return plotline.story_id === storyId
                ? { unit_kind: 'plotline', id: plotline.id, rev: plotline.rev }
                : undefined;

        const summary = store.summaries.get(unitRef);

        if (summary !== undefined)
            return summary.story_id === storyId
                ? { unit_kind: 'summary', id: summary.id, rev: summary.rev }
                : undefined;

        return undefined;
    };

    /** Runs one engine verb and returns the fresh row — the shape every Story mutation answers with. */
    const verb = async (c: Context, storyId: string, run: () => Promise<unknown>): Promise<Response> => {
        try {
            await run();
        } catch (error) {
            return refusal(c, error);
        }

        return c.json(storyRow(projectionDeps, store.stories.require(storyId)), 200);
    };

    // -------------------------------------------------------------------------
    // Stories (U-1, U-4…U-17)
    // -------------------------------------------------------------------------

    /** U-1 — the Stories panel, awaiting-the-Author first. */
    app.get('/stories', (c) => c.json(storyRows(projectionDeps), 200));

    /** §15 step 0 — the Seed, the declared count, and the default Goal (D-3b: the count is Author truth). */
    app.post('/stories', async (c) => {
        const parsed = await readBody<StoryCreateBody>(c);

        if (!parsed.ok) return parsed.response;

        const { title, idea, chapter_count } = parsed.body;

        if (typeof idea !== 'string' || idea.trim().length === 0) {
            return errorResponse(
                c,
                400,
                'a Story needs a Seed: `idea` must be a non-empty string (P5: it is what the book is measured against).'
            );
        }

        if (
            chapter_count !== undefined &&
            (typeof chapter_count !== 'number' || !Number.isInteger(chapter_count) || chapter_count < 1)
        ) {
            return errorResponse(
                c,
                400,
                '`chapter_count` must be a whole number of chapters at least 1 (D-3b: declared, never agent-chosen).'
            );
        }

        let storyId: string;

        try {
            const created = await engine.createStory({
                ...(typeof title === 'string' && title.trim().length > 0 ? { title } : {}),
                idea,
                ...(chapter_count === undefined ? {} : { chapter_count })
            });

            storyId = created.story_id;
        } catch (error) {
            return refusal(c, error);
        }

        return c.json(storyRow(projectionDeps, store.stories.require(storyId)), 200);
    });

    /** U-4…U-17 — the whole Story region in one read (W9: one round trip, not fifteen). */
    app.get('/stories/:id', (c) => {
        const story = storyOf(c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        return c.json(storyView(projectionDeps, story), 200);
    });

    /**
     * U-10a/U-16/U-4 — the four Author edits that live on the Story row. Each keeps its own engine verb
     * where one exists: the Seed is a backtrack (`editSeed`, D-25a) and the count is a growth/shrink
     * decision (`changeChapterCount`, D-3c); the title and the dial are plain row edits.
     */
    app.patch('/stories/:id', async (c) => {
        const story = storyOf(c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        const parsed = await readBody<StoryPatchBody>(c);

        if (!parsed.ok) return parsed.response;

        const body = parsed.body;
        const hasEdit =
            body.title !== undefined ||
            body.idea !== undefined ||
            body.chapter_count !== undefined ||
            body.auto_approve !== undefined;

        if (!hasEdit)
            return errorResponse(
                c,
                400,
                'PATCH /stories/:id got no field it knows: title, idea, chapter_count, auto_approve (D-35).'
            );

        if (body.title !== undefined && (typeof body.title !== 'string' || body.title.trim().length === 0)) {
            return errorResponse(c, 400, '`title` must be a non-empty string.');
        }

        if (body.idea !== undefined && (typeof body.idea !== 'string' || body.idea.trim().length === 0)) {
            return errorResponse(c, 400, '`idea` must be a non-empty string (P5).');
        }

        if (
            body.chapter_count !== undefined &&
            (typeof body.chapter_count !== 'number' || !Number.isInteger(body.chapter_count) || body.chapter_count < 1)
        ) {
            return errorResponse(c, 400, '`chapter_count` must be a whole number of chapters at least 1 (D-3b).');
        }

        if (
            body.auto_approve !== undefined &&
            (!Array.isArray(body.auto_approve) || body.auto_approve.some((cost) => !COSTS.includes(String(cost))))
        ) {
            return errorResponse(
                c,
                400,
                '`auto_approve` must be a list of the four costs: critical, major, minor, taste (D-35).'
            );
        }

        return verb(c, story.id, async () => {
            if (body.title !== undefined || body.auto_approve !== undefined) {
                await store.commit('patch_story', () => {
                    const fresh = requireStory(store, story.id);

                    store.stories.update(
                        fresh.id,
                        {
                            ...(body.title === undefined ? {} : { title: body.title as string }),
                            ...(body.auto_approve === undefined ? {} : { auto_approve: body.auto_approve as Cost[] })
                        },
                        authorAttr(
                            authorWhy(
                                'PATCH /stories/:id',
                                story.id,
                                typeof body.auto_approve === 'undefined'
                                    ? 'title'
                                    : `the dial is now [${(body.auto_approve as string[]).join(', ')}] (D-35)`
                            )
                        ),
                        [{ id: fresh.id, rev: fresh.rev }]
                    );
                });
            }

            // D-25a: editing the Seed is not an edit, it is a full backtrack to phase ① — the confirm is
            // already granted because the dashboard's Seed card asks the Author first.
            if (body.idea !== undefined) await engine.editSeed(story.id, body.idea as string, { confirm: true });

            // D-3c: growing creates `outlined` chapters; shrinking removes them, and the engine only does
            // that on an explicit confirm. The pinned `StoryPatchBody` carries no confirm channel — the
            // dashboard asks the Author BEFORE sending (D-3c is a UI gate, not a server one), so this route
            // always grants it. Same reasoning as `assignTemplates` above, whose `confirm_required` is
            // dropped for the same reason; the engine's refusal paths stay reachable for a caller that does
            // ask (the §11 MCP surface), and `loop/engine.test.ts` pins both.
            if (body.chapter_count !== undefined)
                await engine.changeChapterCount(story.id, body.chapter_count as number, { confirm: true });
        });
    });

    /** D-37 / U-17 — Pause & edit: the only thing that opens the prose pane. */
    app.post('/stories/:id/stop', (c) => {
        const story = storyOf(c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        return verb(c, story.id, () => engine.pauseStory(story.id));
    });

    /** D-37a/D-37b — the hand-back: re-derives the Digest and marks dependents for recheck. */
    app.post('/stories/:id/resume', (c) => {
        const story = storyOf(c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        return verb(c, story.id, () => engine.resumeStory(story.id));
    });

    /** L-36 / U-1b — the one click that clears the tasks keeping a `pending` Story waiting. */
    app.post('/stories/:id/clear-pending', (c) => {
        const story = storyOf(c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        return verb(c, story.id, () => engine.clearPending(story.id));
    });

    /**
     * U-16 — locks the CURRENT phase. Two gates, in the engine's order of precedence:
     *
     *   1. the Ideas tray (L-7a) — when it is non-empty the engine's own sentence is the product copy,
     *      so the request goes THROUGH `lockPhase` and its 409 is the Author's answer;
     *   2. the phase's Goal (U-16: "appears only when that phase's Goal passes") — the engine checks
     *      phase ORDER (L-33) and the tray, but not the Goal, so this layer refuses it here, naming the
     *      failing criteria the Goal panel already shows (G-2).
     */
    app.post('/stories/:id/lock', (c) => {
        const story = storyOf(c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        const phase = story.phase;

        return verb(c, story.id, async () => {
            // L-7a's tray gate reads the UNDECIDED tray (`records.ts:undecidedIdeas`): a `verified`,
            // `refuted` or `unverifiable` row is still the Author's call (T-3b), so it holds the lock
            // exactly as a `proposed` one does. Same reader the engine's own `lockPhase` gate uses.
            const tray = undecidedIdeas(store, story.id, phase);

            if (tray.length === 0) {
                const status = criteria.phaseGoalStatus(store, story);

                if (!status.passed) {
                    throw new Error(
                        `cannot lock phase ${phase}: its Goal is not met — ${status.progress} (U-16: lock only a phase whose Goal passes)`
                    );
                }
            }

            await engine.lockPhase(story.id, phase);
        });
    });

    /** L-31/L-32 — the only way a lock opens; the client confirms first and the engine does the scrap. */
    app.post('/stories/:id/backtrack', async (c) => {
        const story = storyOf(c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        const parsed = await readBody<BacktrackBody>(c);

        if (!parsed.ok) return parsed.response;

        const phase = parsed.body.phase;

        if (typeof phase !== 'string' || !BACKTRACK_PHASES.includes(phase)) {
            return errorResponse(
                c,
                400,
                '`phase` must be "summary" or "plotlines" — phase ③ is where the Story already is (L-32).'
            );
        }

        return verb(c, story.id, () => engine.backtrack(story.id, phase as StoryPhase));
    });

    // -------------------------------------------------------------------------
    // The Author's queue actions (U-10a, U-15)
    // -------------------------------------------------------------------------

    /** D-34/D-35 — the approval that starts Writer work; `by: author` keeps it out of the auto lane (D-41c). */
    app.post('/stories/:id/findings/:findingId/approve', async (c) => {
        const story = storyOf(c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        const finding = store.findings.get(c.req.param('findingId'));

        if (finding === undefined || finding.story_id !== story.id)
            return missing(c, 'finding', c.req.param('findingId'));

        const parsed = await readBody<WhyBody>(c);

        if (!parsed.ok) return parsed.response;

        const why = typeof parsed.body.why === 'string' ? parsed.body.why : '';

        if (why.trim().length === 0)
            return errorResponse(c, 400, '`why` is required: an approval with no reason is not auditable (D-8, T-5).');

        return verb(c, story.id, () => engine.approveFinding(finding.id, { by: 'author', note: why }));
    });

    /**
     * U-10b — "approve a whole chapter's worth", the bulk move the spec names beside approving one
     * finding and turning on the dial. Without it the Author approves forty findings one click each,
     * which is the batching U-10b's sentence exists to prevent.
     *
     * WHICH ROWS BELONG TO THE CHAPTER: the same test the loop uses when it routes a finding's work
     * (`findingTouchesUnit` in `loop/work.ts:229`) — `target_ref` OR `related_refs`. L-11a's related
     * refs are part of a finding's blast radius, so an approval that ignored them would leave the
     * chapter's own fixes sitting in the queue under a different chapter's name.
     *
     * WHICH STATES: `confirmed` only — that is the queue (U-10, D-34). An `unconfirmed` finding is the
     * Editor's triage problem, and an `approved` one is already work.
     *
     * The set is computed BEFORE anything is approved, on purpose: `approveFinding` spawns Writer work
     * and can lift the Story out of `pending` (D-2a), so re-reading the list between approvals could
     * approve a row that arrived mid-loop or skip one whose rev moved. Each approval is its own commit
     * (the engine's `approve_finding`), which is what U-10b's "progressive, never batched away
     * silently" asks for — the journal shows one approve per finding, not one anonymous bulk write.
     */
    app.post('/stories/:id/chapters/:chapterId/findings/approve-all', async (c) => {
        const story = storyOf(c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        const chapter = store.chapters.get(c.req.param('chapterId'));

        if (chapter === undefined || chapter.story_id !== story.id)
            return missing(c, 'chapter', c.req.param('chapterId'));

        const parsed = await readBody<WhyBody>(c);

        if (!parsed.ok) return parsed.response;

        const why = typeof parsed.body.why === 'string' ? parsed.body.why : '';

        if (why.trim().length === 0) {
            return errorResponse(
                c,
                400,
                '`why` is required: an approval with no reason is not auditable, and a bulk one least of all (D-8, T-5).'
            );
        }

        const targets = store.findings
            .list()
            .filter(
                (candidate) =>
                    candidate.story_id === story.id &&
                    candidate.state === 'confirmed' &&
                    (candidate.target_ref === chapter.id || (candidate.related_refs ?? []).includes(chapter.id))
            );

        try {
            for (const finding of targets) await engine.approveFinding(finding.id, { by: 'author', note: why });
        } catch (error) {
            return refusal(c, error);
        }

        return c.json(storyRow(projectionDeps, store.stories.require(story.id)), 200);
    });

    /**
     * D-34 — the discard. No engine verb exists for it (delta 2), so the state move happens here with
     * Author attribution; `discarded` is one of `CLOSED_FINDING_STATES` (loop/types.ts), which is exactly
     * what L-15a/L-16a read, so loop detection sees the closure without any further bookkeeping.
     */
    app.post('/stories/:id/findings/:findingId/discard', async (c) => {
        const story = storyOf(c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        const finding = store.findings.get(c.req.param('findingId'));

        if (finding === undefined || finding.story_id !== story.id)
            return missing(c, 'finding', c.req.param('findingId'));

        const parsed = await readBody<WhyBody>(c);

        if (!parsed.ok) return parsed.response;

        const why = typeof parsed.body.why === 'string' ? parsed.body.why : '';

        if (why.trim().length === 0)
            return errorResponse(
                c,
                400,
                "`why` is required: the queue is the Author's desk, and a disappearance with no reason is not information (D-34)."
            );

        return verb(c, story.id, () =>
            store.commit('author_discard_finding', () => {
                const fresh = requireStory(store, story.id);
                const row = store.findings.require(finding.id);

                store.findings.update(
                    row.id,
                    { state: 'discarded' },
                    authorAttr(`the Author discarded this finding: ${why} (D-34)`),
                    [{ id: row.id, rev: row.rev }]
                );

                // U-1c/L-36: a Story parked waiting on this pile must not stay parked with an empty desk.
                if (
                    fresh.pending_kind === 'finding_approval' &&
                    store.findings
                        .list()
                        .every((candidate) => candidate.story_id !== fresh.id || candidate.state !== 'confirmed')
                ) {
                    store.stories.update(
                        fresh.id,
                        {
                            pending_kind: 'none',
                            status: 'ready',
                            status_reason: 'the Author decided the last finding on the desk (L-36)'
                        },
                        authorAttr('the desk is empty, so the crew has its authorisation back (D-34, L-36)'),
                        [{ id: fresh.id, rev: fresh.rev }]
                    );
                }
            })
        );
    });

    /**
     * U-15 / D-27 / D-29 — selecting an Idea. The engine does the machinery (`decideIdea` absorbs the
     * tray and files the absorb work); this layer enforces D-27's gate: an Idea that CITES SOURCES may
     * not be picked over an Editor verdict that has not come back `verified`, unless the Author has
     * given the explicit "I know" — which, on this pinned body, is a non-blank `note`.
     */
    app.post('/stories/:id/ideas/:ideaId/select', async (c) => {
        const story = storyOf(c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        const idea = store.ideas.get(c.req.param('ideaId'));

        if (idea === undefined || idea.story_id !== story.id) return missing(c, 'idea', c.req.param('ideaId'));

        const parsed = await readBody<NoteBody>(c);

        if (!parsed.ok) return parsed.response;

        const note = typeof parsed.body.note === 'string' ? parsed.body.note : '';
        const sourced = (idea.sources?.length ?? 0) > 0;

        if (sourced && idea.verification?.verdict !== 'verified' && note.trim().length === 0) {
            return errorResponse(
                c,
                409,
                `Idea ${idea.id} cites sources the Editor has not verified — pick it with a note, or that is the explicit "I know" this Idea has not earned (D-27, C-15).`
            );
        }

        return verb(c, story.id, () =>
            // D-29 / P1: the pick AND its reason are one decision, so they are one commit. `decideIdea`
            // takes the note (engine.ts:1527) and writes it into §4.17's `selection_note` inside the same
            // transaction as the tray sweep, so the journal carries ONE group (`decide_idea`) instead of
            // a decision plus a follow-up `author_idea_note` patch. A blank note is not a reason: the
            // engine falls back to its own sentence rather than storing an empty note (verbs.ts's pin),
            // which is what a no-note select used to produce anyway.
            engine.decideIdea(idea.id, [idea.id], note)
        );
    });

    /** U-15 — the two other tray decisions (delta 2: direct state moves with Author attribution). */
    const ideaDecision = (state: 'discarded' | 'deferred') => async (c: Context) => {
        const story = storyOf(param(c, 'id'));

        if (story === undefined) return missing(c, 'story', param(c, 'id'));

        const idea = store.ideas.get(param(c, 'ideaId'));

        if (idea === undefined || idea.story_id !== story.id) return missing(c, 'idea', param(c, 'ideaId'));

        return verb(c, story.id, () =>
            store.commit(`author_${state}_idea`, () => {
                const fresh = requireStory(store, story.id);
                const row = store.ideas.require(idea.id);

                store.ideas.update(
                    row.id,
                    { state },
                    authorAttr(`the Author ${state} this Idea for phase ${row.phase} (D-29, D-32)`),
                    [{ id: row.id, rev: row.rev }]
                );

                // L-7a/D-36: the tray is what blocks the lock; emptying it is the Author's move, and the
                // Story comes back to the crew rather than sitting on a sign-off that is now clearable.
                // The reader is the UNDECIDED tray (`records.ts:undecidedIdeas`), the same set the lock
                // gate above and the engine's `lockPhase` gate count — flipping on a narrower set would
                // offer the sign-off while a `verified` row still refused the lock.
                if (
                    undecidedIdeas(store, fresh.id, row.phase).length === 0 &&
                    fresh.pending_kind === 'idea_selection' &&
                    fresh.status === 'pending'
                ) {
                    store.stories.update(
                        fresh.id,
                        {
                            pending_kind: 'phase_signoff',
                            status_reason: `phase ${row.phase}'s tray is empty — the lock is the Author's to take (L-7a, L-29)`
                        },
                        authorAttr('the last undecided Idea in the phase was decided (L-7a)'),
                        [{ id: fresh.id, rev: fresh.rev }]
                    );
                }
            })
        );
    };

    app.post('/stories/:id/ideas/:ideaId/discard', ideaDecision('discarded'));
    app.post('/stories/:id/ideas/:ideaId/defer', ideaDecision('deferred'));

    // -------------------------------------------------------------------------
    // Prose, revisions, proposals, undo (U-5, U-13, U-17)
    // -------------------------------------------------------------------------

    /**
     * P9a / D-37 / U-17 — the Author's section edit. `applyAuthorEdit` is the D-37 enforcer: it refuses
     * anything but a stopped Story and names D-37, and that refusal is the 409 the greyed-out pane's
     * tooltip shows.
     *
     * D-24 / U-13 (delta 6): when the chapter has COMPETING drafts, the Author's edit outranks them. The
     * drafts are deleted in one commit (`author_revision_override`) — D-22's "the losers disappear" — and
     * the newest one is kept as the record of what was overridden, marked `selected` with the Author's
     * note, because §4.15's states exist to make this restore path expressible.
     */
    app.post('/stories/:id/chapters/:chapterId/sections/:sectionId', async (c) => {
        const story = storyOf(c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        const chapter = store.chapters.get(c.req.param('chapterId'));

        if (chapter === undefined || chapter.story_id !== story.id)
            return missing(c, 'chapter', c.req.param('chapterId'));

        const sectionId = c.req.param('sectionId');

        if (!chapter.sections.some((section) => section.id === sectionId)) {
            return errorResponse(
                c,
                404,
                `chapter ${chapter.id} has no section ${sectionId} (D-7: sections are individually addressable).`
            );
        }

        const parsed = await readBody<SectionBody>(c);

        if (!parsed.ok) return parsed.response;

        if (typeof parsed.body.content !== 'string') {
            return errorResponse(c, 400, '`content` must be a string — the section text, not a patch (D-7).');
        }

        const content = parsed.body.content;
        const drafts = competingRevisions(store, story.id, chapter.id);

        try {
            await engine.applyAuthorEdit(chapter.id, sectionId, content);
        } catch (error) {
            return refusal(c, error);
        }

        if (drafts.length > 0) {
            try {
                await store.commit('author_revision_override', () => {
                    // Highest id = the newest draft (the store hands out ids in creation order), so the
                    // surviving row is the one the Author most recently looked at in the comparison (U-13).
                    const winner = [...drafts].sort((left, right) => right.id.localeCompare(left.id))[0];
                    const fresh = store.chapters.require(chapter.id);

                    for (const draft of drafts) {
                        if (draft.id === winner.id) continue;

                        store.revisions.delete(
                            draft.id,
                            authorAttr(`the Author's own edit replaced every competing draft (D-24, D-22)`),
                            [{ id: draft.id, rev: draft.rev }]
                        );
                    }

                    store.revisions.update(
                        winner.id,
                        {
                            state: 'selected',
                            selection_note: 'selected by the Author (D-24) — their own edit is the version that stands'
                        },
                        authorAttr('the Author overrode the Editor selection (D-24, U-13)'),
                        [{ id: winner.id, rev: winner.rev }]
                    );

                    store.chapters.update(
                        fresh.id,
                        { current_revision: winner.id },
                        authorAttr(`the Author's override points ${fresh.id} at ${winner.id} (D-24)`),
                        [{ id: fresh.id, rev: fresh.rev }]
                    );
                });
            } catch (error) {
                return refusal(c, error);
            }
        }

        return c.json(storyRow(projectionDeps, store.stories.require(story.id)), 200);
    });

    /**
     * U-13 / D-24 — the Author takes one competing draft as the version that stands.
     *
     * THE GAP THIS CLOSES: §6.2a gives the Author this move on the comparison pane, and D-24 says the
     * Editor's selection is always overridable — but §10.1 named no endpoint for it, so the pinned
     * client had no verb and the pane's "Use this" was a tooltip (the review caught the comment that
     * said exactly that). The route now exists, and the shell binds the pane's callback to it.
     *
     * WHY IT LOOKS LIKE THE AUTHOR'S OVERRIDE ABOVE AND IS NOT THE SAME CALL: the section route's
     * override fires as a SIDE EFFECT of the Author typing new prose (U-17/D-37), so it has to pick a
     * surviving draft by recency. This one is the choice itself: the Author names the draft, and the
     * draft's stored body is what installs (§4.15's `body` codec is `revisionBodySections`/
     * `revisionBodyFields` in ../tools/artifacts — the same pair the Editor's `selectRevision` reads,
     * so an Author's choice and a Checker's choice cannot render two different texts).
     *
     * D-22's commit discipline holds: install, mark `selected`, delete every sibling draft in ONE
     * commit, so no fresh run can see two texts for one unit. No §7 row is consulted — this is a
     * direct Author write, attributed `author: true` with no run behind it (D-20a).
     */
    app.post('/stories/:id/revisions/:revisionId/select', async (c) => {
        const story = storyOf(c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        const draft = store.revisions.get(c.req.param('revisionId'));

        if (draft === undefined || draft.story_id !== story.id)
            return missing(c, 'revision', c.req.param('revisionId'));

        const parsed = await readBody<RevisionSelectBody>(c);

        if (!parsed.ok) return parsed.response;

        // L-13: the note is the sentence the next run reads in the draft's `selection_note`, so a bare
        // click still has to say who chose — that is the default, and the Author may type their own.
        const note =
            typeof parsed.body.note === 'string' && parsed.body.note.trim().length > 0
                ? parsed.body.note.trim()
                : 'selected by the Author (D-24)';

        const unit = revisionUnit(story.id, draft.unit_ref);

        if (unit === undefined) return missing(c, 'unit', draft.unit_ref);

        try {
            await store.commit('author_revision_select', () => {
                const attribution = authorAttr(`the Author selected ${draft.id} for ${draft.unit_ref} (D-24, U-13)`);

                // The install is per unit kind (§4.15 stores `body: unknown`), and the chapter path
                // records `current_revision` so the restore path stays expressible (D-24).
                if (draft.unit_kind === 'chapter') {
                    store.chapters.update(
                        draft.unit_ref,
                        { sections: revisionBodySections(draft), current_revision: draft.id },
                        attribution,
                        [{ id: unit.id, rev: unit.rev }]
                    );
                } else if (draft.unit_kind === 'plotline') {
                    store.plotlines.update(draft.unit_ref, revisionBodyFields(draft), attribution, [
                        { id: unit.id, rev: unit.rev }
                    ]);
                } else {
                    store.summaries.update(draft.unit_ref, revisionBodyFields(draft), attribution, [
                        { id: unit.id, rev: unit.rev }
                    ]);
                }

                store.revisions.update(draft.id, { state: 'selected', selection_note: note }, attribution, [
                    { id: draft.id, rev: draft.rev }
                ]);

                // D-22: the losers disappear in the same commit, whoever made the choice.
                for (const sibling of store.revisions
                    .list()
                    .filter(
                        (row) =>
                            row.story_id === story.id &&
                            row.unit_kind === draft.unit_kind &&
                            row.unit_ref === draft.unit_ref &&
                            row.id !== draft.id
                    )) {
                    store.revisions.delete(sibling.id, attribution, [{ id: sibling.id, rev: sibling.rev }]);
                }
            });
        } catch (error) {
            return refusal(c, error);
        }

        return c.json(storyRow(projectionDeps, store.stories.require(story.id)), 200);
    });

    /**
     * U-13a — the Author asks for the competing drafts to be merged instead of choosing one.
     *
     * §8.2's `requestMerge` is the crew's version of this move; this is the Author's, and it opens the
     * SAME task row (`kind: 'merge'`, the same dedupe title, `owner_role: writer`) so the Author's desk
     * shows one entry whoever asked for it (L-11a's dedupe is what makes that true — two phrasings
     * would queue the merge twice). D-23 holds: the drafts stay `competing` until merged prose exists,
     * so the unit keeps waiting rather than pretending one draft won.
     */
    app.post('/stories/:id/revisions/merge', async (c) => {
        const story = storyOf(c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        const parsed = await readBody<RevisionMergeBody>(c);

        if (!parsed.ok) return parsed.response;

        const unitRef = typeof parsed.body.unit_ref === 'string' ? parsed.body.unit_ref.trim() : '';
        const requested = (Array.isArray(parsed.body.revision_ids) ? parsed.body.revision_ids : []).map((id) =>
            String(id).trim()
        );
        const parts = typeof parsed.body.parts === 'string' ? parsed.body.parts.trim() : '';

        if (unitRef.length === 0)
            return errorResponse(c, 400, '`unit_ref` names the unit whose drafts are to be merged (§8.2, D-23).');

        const unit = revisionUnit(story.id, unitRef);

        if (unit === undefined) return missing(c, 'unit', unitRef);

        if (requested.length < 2)
            return errorResponse(
                c,
                400,
                '`revision_ids` must name at least two drafts — one draft is already a decision (D-23).'
            );

        if (parts.length === 0)
            return errorResponse(c, 400, '`parts` is the merge brief: which half of which draft to take (§8.2).');

        for (const id of requested) {
            const draft = store.revisions.get(id);

            if (draft === undefined || draft.story_id !== story.id) return missing(c, 'revision', id);

            if (draft.unit_ref !== unitRef)
                return errorResponse(
                    c,
                    400,
                    `revision ${id} belongs to ${draft.unit_ref}, not to ${unitRef}, so it cannot be merged with it (T-3).`
                );
        }

        const why =
            typeof parsed.body.why === 'string' && parsed.body.why.trim().length > 0
                ? parsed.body.why.trim()
                : `the Author asked for ${requested.join(', ')} to be merged (D-23)`;

        try {
            await store.commit('author_merge_request', () => {
                openTask(
                    store,
                    story.id,
                    {
                        kind: 'merge',
                        // The tool's exact title shape, so `findOpenTask` dedupes the Author's request
                        // and a Checker's into one row (T-24's no-progress signal counts once).
                        title: `Merge ${requested.length} drafts for ${unitRef}`,
                        detail: `${parts}\nDrafts: ${requested.join(', ')}\nWhy: ${why}`,
                        owner_role: 'writer'
                    },
                    authorAttr(why)
                );
            });
        } catch (error) {
            return refusal(c, error);
        }

        return c.json(storyRow(projectionDeps, store.stories.require(story.id)), 200);
    });

    /** L-10 — the Author's word outranks the criteria: the chapter wakes the crew. */
    app.post('/stories/:id/chapters/:chapterId/unapprove', (c) => {
        const story = storyOf(c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        const chapter = store.chapters.get(c.req.param('chapterId'));

        if (chapter === undefined || chapter.story_id !== story.id)
            return missing(c, 'chapter', c.req.param('chapterId'));

        return verb(c, story.id, () => engine.unapproveChapter(chapter.id));
    });

    /** G-1 / §14 item 2 — the per-chapter bar, as the one text field §4.4 stores. */
    app.patch('/stories/:id/chapters/:chapterId/bar', async (c) => {
        const story = storyOf(c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        const chapter = store.chapters.get(c.req.param('chapterId'));

        if (chapter === undefined || chapter.story_id !== story.id)
            return missing(c, 'chapter', c.req.param('chapterId'));

        const parsed = await readBody<BarBody>(c);

        if (!parsed.ok) return parsed.response;

        if (typeof parsed.body.bar_override !== 'string') {
            return errorResponse(
                c,
                400,
                '`bar_override` must be a string — the criteria engine parses `-C-7` drops and `+1` deltas (G-1).'
            );
        }

        // The engine takes the token list; §4.4 stores the text. Splitting on whitespace is the whole
        // translation, and an empty string clears the override (back to the Story's bar).
        const tokens = parsed.body.bar_override.trim().length === 0 ? [] : parsed.body.bar_override.trim().split(/\s+/);

        return verb(c, story.id, () => engine.setChapterBar(story.id, chapter.id, tokens));
    });

    /** D-20/D-20a — the propose-only tray. Same decision surface as an Idea (the engine says so). */
    const decideProposals = (verdict: 'accepted' | 'rejected') => async (c: Context) => {
        const story = storyOf(param(c, 'id'));

        if (story === undefined) return missing(c, 'story', param(c, 'id'));

        const proposal = store.proposals.get(param(c, 'proposalId'));

        if (proposal === undefined || proposal.story_id !== story.id)
            return missing(c, 'proposal', param(c, 'proposalId'));

        return verb(c, story.id, () => engine.decideProposal(proposal.id, verdict));
    };

    app.post('/stories/:id/proposals/:proposalId/accept', decideProposals('accepted'));
    app.post('/stories/:id/proposals/:proposalId/reject', decideProposals('rejected'));

    /** P11 / U-5 — undo one write. Delta 4: the engine's undo is per chapter (L-17a). */
    app.post('/stories/:id/undo', async (c) => {
        const story = storyOf(c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        const parsed = await readBody<UndoBody>(c);

        if (!parsed.ok) return parsed.response;

        const chapterId = parsed.body.chapter_id;
        const sectionId = parsed.body.section_id;

        if (typeof chapterId !== 'string' || typeof sectionId !== 'string') {
            return errorResponse(
                c,
                400,
                '`chapter_id` and `section_id` are both required (the §4.4 span the Author is undoing).'
            );
        }

        const chapter = store.chapters.get(chapterId);

        if (chapter === undefined || chapter.story_id !== story.id) return missing(c, 'chapter', chapterId);

        return verb(c, story.id, () => engine.undoLast(chapterId));
    });

    // -------------------------------------------------------------------------
    // Directive bar, completion, templates, Goal (U-9, U-13, U-8, U-6)
    // -------------------------------------------------------------------------

    /** U-9 / D-19 — one line of intent that becomes a `directives` record and propagates (not a chat). */
    app.post('/stories/:id/directives', async (c) => {
        const story = storyOf(c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        const parsed = await readBody<DirectiveBody>(c);

        if (!parsed.ok) return parsed.response;

        if (typeof parsed.body.text !== 'string' || parsed.body.text.trim().length === 0) {
            return errorResponse(
                c,
                400,
                '`text` is the decision. The directive bar does not accept conversation (U-9, D-19).'
            );
        }

        return verb(c, story.id, () => engine.processDirective(story.id, parsed.body.text as string));
    });

    /**
     * U-13 / L-25b / L-26 — accepting completion, with the discard count the preview promised. The engine
     * also owns the "declined" branch (L-30); the dashboard's route is the accept, and a Story that has
     * nothing proposed is a 409 from the engine's own words.
     */
    app.post('/stories/:id/complete', (c) => {
        const story = storyOf(c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        return verb(c, story.id, () => engine.acceptCompletion(story.id, true));
    });

    /**
     * D-17b / D-38a — the assignment list, replaced wholesale. A bad assignment is a 409 naming T-0.
     * `confirm: true` is always granted: the pinned body has no confirm field, and the dashboard's own
     * confirm dialog (D-38a: it warns about live runs) happens before the request, so the engine's
     * `confirm_required` answer cannot be produced by this contract.
     */
    app.post('/stories/:id/templates', async (c) => {
        const story = storyOf(c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        const parsed = await readBody<TemplateAssignBody>(c);

        if (!parsed.ok) return parsed.response;

        const ids = parsed.body.template_ids;

        if (!Array.isArray(ids) || ids.some((ref) => typeof ref !== 'string')) {
            return errorResponse(c, 400, '`template_ids` must be a list of §4.12 template ids (D-17b).');
        }

        let result: Awaited<ReturnType<typeof engine.assignTemplates>>;

        try {
            result = await engine.assignTemplates(story.id, ids as string[], { confirm: true });
        } catch (error) {
            return refusal(c, error);
        }

        const errors = result.errors ?? [];

        if (errors.length > 0)
            return errorResponse(c, 409, `that assignment is refused: ${errors.join('; ')} (T-0, D-17b)`);

        return c.json(storyRow(projectionDeps, store.stories.require(story.id)), 200);
    });

    /**
     * U-6 / G-1 — the Goal panel's write. Delta 3: the engine replaces the criteria list wholesale, so
     * the pinned ORDERED OPS are folded into the Story's evaluated criteria here.
     */
    app.patch('/stories/:id/goal', async (c) => {
        const story = storyOf(c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        const parsed = await readBody<GoalPatchBody>(c);

        if (!parsed.ok) return parsed.response;

        const body = parsed.body;

        if (body.threshold_soft !== undefined && typeof body.threshold_soft !== 'number') {
            return errorResponse(
                c,
                400,
                '`threshold_soft` must be a number — how many soft criteria may fail and the phase still pass (G-1).'
            );
        }

        if (body.criteria !== undefined && !Array.isArray(body.criteria)) {
            return errorResponse(c, 400, '`criteria` must be a list of ops: {op: add | remove | setHard} (G-1).');
        }

        const base = criteria.resolveGoal(store, story);
        const patch: EngineGoalPatch = {};

        if (body.threshold_soft !== undefined) patch.threshold_soft = body.threshold_soft as number;

        if (body.criteria !== undefined) {
            let criteriaList: Criterion[] = [...base.criteria];

            for (const raw of body.criteria as GoalCriterionOp[]) {
                const applied = applyCriterionOp(criteriaList, raw);

                if (applied === undefined) {
                    return errorResponse(
                        c,
                        400,
                        `criterion op ${JSON.stringify(raw)} is not one of add/remove/setHard with the fields it needs (G-1).`
                    );
                }

                criteriaList = applied;
            }

            patch.criteria = criteriaList;
        }

        try {
            await engine.setGoal(story.id, patch);
        } catch (error) {
            return refusal(c, error);
        }

        // The pinned client types this response as `GoalSurface`, not a Story row: the Goal panel
        // re-reads its own surface after the write (U-6).
        return c.json(goalSurface(projectionDeps, store.stories.require(story.id)), 200);
    });

    /**
     * §8.6 — "Ask assistant" from a locked pane. Not a chat: the answer is an artifact change made by a
     * real run, so the response is the RUN ROW (U-7's crew panel is where the Author watches it).
     */
    app.post('/stories/:id/assistant', async (c) => {
        const story = storyOf(c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        const parsed = await readBody<AssistantBody>(c);

        if (!parsed.ok) return parsed.response;

        const target = parsed.body.target;
        const text = parsed.body.text;

        if (target !== 'summary' && target !== 'directive') {
            return errorResponse(
                c,
                400,
                '`target` must be "summary" or "directive" (§8.6: the assistant is aimed at an artifact, not at a conversation).'
            );
        }

        if (typeof text !== 'string' || text.trim().length === 0) {
            return errorResponse(c, 400, '`text` is what the Author is asking for.');
        }

        // §8.6: the run is aimed at one artifact. A locked Summary is still a `summary` target — the
        // harness's own write permission (and the Summary's `locked` flag, L-7a) is what keeps the
        // Author's ask from silently rewriting a signed-off artifact.
        const summary = store.summaries.list().find((row) => row.story_id === story.id);
        const item: WorkItem = {
            // The claim key (§9) has to be unique per ask so a second "ask assistant" is not deduped into
            // a live run's shadow; the run count is the book's own monotonic counter.
            id: `assistant_${story.id}_${store.runs.count() + 1}`,
            kind: 'assistant',
            storyId: story.id,
            templateRef: ASSISTANT_TEMPLATE,
            roleName: ASSISTANT_ROLE,
            ...(target === 'summary' && summary !== undefined
                ? { unit: { kind: 'summary' as const, ref: summary.id } }
                : {}),
            note: `the Author asked, from the ${target} pane: ${text}`
        };

        let run: Run | undefined;

        try {
            // Fire-and-forget ON PURPOSE: `RunExecutor.execute` creates the run row synchronously before
            // its first await (D-18: the row exists before the first token so Stop has something to point
            // at), so the row can be read back here while the run works behind the response. The run
            // closes its own row in `finally` whatever happens (S-3), so nothing may be thrown by dropping
            // the promise.
            const running = executor.execute(item);

            running.catch(() => undefined);
            run = store.runs.list().find((candidate) => candidate.work_item_ref === item.id);
        } catch (error) {
            return refusal(c, error);
        }

        if (run === undefined) {
            return errorResponse(c, 409, 'the assistant run could not be spawned (S-1: no run row, no run).');
        }

        return c.json(run, 200);
    });

    // -------------------------------------------------------------------------
    // The catalogue (U-8) and the crew (U-7)
    // -------------------------------------------------------------------------

    /** U-8 — the template catalogue, as rows (§4.12 as-is). */
    app.get('/templates', (c) => c.json(store.templates.list(), 200));

    /**
     * U-8 — New and Duplicate. Both validate against the §4.12 rules (T-0) and answer 409 with the
     * engine's own list of problems, because "a template that cannot be briefed is not a template" and
     * the Author has to see WHICH rule it breaks. Built-ins are duplicate-only (D-17).
     */
    app.post('/templates', async (c) => {
        const parsed = await readBody<TemplateBody>(c);

        if (!parsed.ok) return parsed.response;

        const { template, duplicate_of } = parsed.body;

        if (duplicate_of === undefined && template === undefined) {
            return errorResponse(
                c,
                400,
                'one of `template` (New) or `duplicate_of` (Duplicate) is required (§4.12, D-17).'
            );
        }

        let candidate: Template;

        if (duplicate_of !== undefined) {
            const sourceId = String(duplicate_of);
            const source = templateOf(sourceId);

            if (source === undefined) return missing(c, 'template', sourceId);

            candidate = duplicateTemplate(source, `${source.name}-copy`);
        } else {
            candidate = template as Template;

            if (
                candidate === null ||
                typeof candidate !== 'object' ||
                typeof candidate.name !== 'string' ||
                candidate.name.trim().length === 0
            ) {
                return errorResponse(c, 400, '`template.name` is the slug the Story assigns (D-17b).');
            }

            if (store.templates.list().some((row) => row.name === candidate.name)) {
                return errorResponse(
                    c,
                    409,
                    `a template named ${candidate.name} is already in the catalogue — duplicate it and edit the copy (D-17).`
                );
            }

            // An Author's own template is always editable and never built-in, whatever the client sent.
            candidate = { ...candidate, builtin: false, editable: true };
        }

        const problems = validateTemplate(candidate);

        if (problems.length > 0)
            return errorResponse(c, 409, `that template is refused: ${problems.join('; ')} (T-0).`);

        try {
            const row = store.templates.create(
                {
                    name: candidate.name,
                    title: candidate.title,
                    ...(candidate.description === undefined ? {} : { description: candidate.description }),
                    roles: candidate.roles,
                    serves_phase: candidate.serves_phase,
                    done_definition: candidate.done_definition,
                    ...(candidate.selection_rules === undefined ? {} : { selection_rules: candidate.selection_rules }),
                    attempts: candidate.attempts,
                    ...(candidate.delegation === undefined ? {} : { delegation: candidate.delegation }),
                    ...(candidate.escalation_rule === undefined ? {} : { escalation_rule: candidate.escalation_rule }),
                    ...(candidate.next_phase === undefined ? {} : { next_phase: candidate.next_phase }),
                    ...(candidate.max_concurrent === undefined ? {} : { max_concurrent: candidate.max_concurrent }),
                    builtin: candidate.builtin,
                    editable: candidate.editable
                },
                authorAttr(
                    duplicate_of === undefined
                        ? 'the Author wrote a new harness template (§4.12, D-17b)'
                        : `the Author duplicated ${duplicate_of} to edit it (D-17)`
                )
            );

            return c.json(row, 200);
        } catch (error) {
            return refusal(c, error);
        }
    });

    /** U-8/U-8b/U-8c/U-8d — edit a template. A built-in answers 409 naming D-17. */
    app.patch('/templates/:templateId', async (c) => {
        const templateId = c.req.param('templateId');
        const template = templateOf(templateId);

        if (template === undefined) return missing(c, 'template', templateId);

        const parsed = await readBody<Partial<Template>>(c);

        if (!parsed.ok) return parsed.response;

        if (template.builtin || !template.editable) {
            return errorResponse(
                c,
                409,
                `template ${template.name} is built-in — duplicate it and edit the copy (D-17).`
            );
        }

        try {
            // The bookkeeping fields are the store's to manage (`UpdatePatch` omits them); a PATCH that
            // echoes them back must not try to rewrite them.
            const { id: _id, rev: _rev, created_at: _created_at, updated_at: _updated_at, ...patch } = parsed.body;
            const merged = { ...template, ...patch } as Template;

            // T-0 again on the way in: an edit that leaves a role with no prompt is a template that
            // cannot be briefed, and the Author has to be told which rule the card now breaks.
            const problems = validateTemplate(merged);

            if (problems.length > 0)
                return errorResponse(c, 409, `that edit is refused: ${problems.join('; ')} (T-0).`);

            const row = store.templates.update(
                template.id,
                patch,
                authorAttr(
                    'the Author tuned this harness — the prompts, the rules, or the divergence count (D-17c, D-17d, D-38)'
                ),
                [{ id: template.id, rev: template.rev }]
            );

            return c.json(row, 200);
        } catch (error) {
            return refusal(c, error);
        }
    });

    /** U-7 — the crew panel. `story_id` omitted lists every Story's runs. */
    app.get('/runs', (c) => {
        const storyId = c.req.query('story_id');

        return c.json(storyId ? store.runs.list().filter((run) => run.story_id === storyId) : store.runs.list(), 200);
    });

    /**
     * P8 / U-7 — the Author's cord. `RunExecutor.kill` aborts the run's own controller and the row closes
     * in the executor's `finally` (S-3: teardown is unconditional), so the row returned here is the
     * `killed`-in-flight row; the `runs` SSE event carries the closed one a moment later.
     */
    app.post('/runs/:runId/kill', (c) => {
        const runId = c.req.param('runId');
        const run = store.runs.get(runId);

        if (run === undefined) return missing(c, 'run', runId);

        executor.kill(runId);

        return c.json(store.runs.get(runId) ?? run, 200);
    });

    /** U-10 — the cross-Story desk, the dashboard's home screen. */
    app.get('/queue', (c) => c.json(queueItems(store), 200));

    // -------------------------------------------------------------------------
    // §10 — the SSE channel
    // -------------------------------------------------------------------------

    /**
     * The stream. The store's commit groups are the only source (P1/P3: the journal IS the state
     * change), debounced so a sweep that commits forty times is one frame per topic, and the `data:` is
     * the affected story id because the client refetches rather than trusting a payload.
     *
     * A first `ready` frame goes out before any commit so the client can tell a live stream from a
     * buffered proxy (the client's own fallback is a 5s poll, and L-24 says a degraded mode must be real).
     */
    app.get('/stream', (c) =>
        streamSSE(c, async (stream) => {
            let queue: FeedEvent[] = [];
            let timer: ReturnType<typeof setTimeout> | undefined;

            const flush = async (): Promise<void> => {
                timer = undefined;

                const frames = queue;

                queue = [];

                for (const frame of frames) {
                    await stream.writeSSE({ event: frame.kind, data: frame.storyId ?? '' });
                }
            };

            const unsubscribe = store.onCommit((events) => {
                for (const frame of feedEvents(events)) {
                    queue.push(frame);
                }

                if (timer === undefined) timer = setTimeout(() => void flush(), debounceMs);
            });

            await stream.writeSSE({ event: 'ready', data: '' });

            await new Promise<void>((resolve) => {
                stream.onAbort(() => resolve());
            });

            if (timer !== undefined) clearTimeout(timer);

            unsubscribe();
        })
    );

    return app;
}

// ---------------------------------------------------------------------------
// The Goal op folding (delta 3)
// ---------------------------------------------------------------------------

/**
 * Applies one §7 op to the criteria list, in order, returning the new list or `undefined` when the op is
 * malformed (the route turns that into a 400).
 *
 * `add` needs the criterion record; `remove`/`setHard` need only its id, and a remove of an id that is
 * not in the list is a no-op rather than an error (the panel may send a checkbox state that just changed).
 */
function applyCriterionOp(list: Criterion[], op: GoalCriterionOp): Criterion[] | undefined {
    switch (op?.op) {
        case 'add': {
            const criterion = op.criterion;

            if (criterion === undefined || typeof criterion !== 'object' || typeof criterion.id !== 'string')
                return undefined;

            return [...list.filter((entry) => entry.id !== criterion.id), criterion];
        }

        case 'remove': {
            if (typeof op.id !== 'string') return undefined;

            return list.filter((entry) => entry.id !== op.id);
        }

        case 'setHard': {
            if (typeof op.id !== 'string' || typeof op.hard !== 'boolean') return undefined;

            return list.map((entry) => (entry.id === op.id ? { ...entry, hard: op.hard as boolean } : entry));
        }

        default:
            return undefined;
    }
}
