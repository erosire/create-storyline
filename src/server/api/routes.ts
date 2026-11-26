// §10 / W9-W13 — the `/v1/storyline` HTTP surface (T7).
//
// WHAT THIS FILE OWNS: the route table the pinned dashboard client (`src/dashboard/api.ts`) calls, the
// JSON body validation in front of it, and the MAPPING from an HTTP request to a verb on the real
// `LoopEngine` (W4's `EngineApi`). It owns no business rule: every mutation is delegated to the engine
// so the rules live in one place (L-0/L-6/L-7/L-17/L-25/L-31), and every projection is delegated to
// `./projections` so the criteria engine stays the only level calculator (L-14/W3).
//
// THE PUBLISHED CONTRACT is `src/storyline-server.swagger.yaml`. Every path, request body, response
// shape and error class in this table has one entry there; `./contract.test.ts` fails when the two
// sets drift. The dashboard is a CLIENT of that contract — it has no second transport and no server
// import, and `src/dashboard/server-boundary.test.ts` enforces the boundary.
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
// D-33d: the approve-all route asks the loop's own "does this Story still hold an unresolved defect?"
// before it approves anything, so a bulk approve cannot approve a `proposal` over open issues while
// the single-approve route (engine.approveFinding) refuses the very same call.
import { authorAttr, competingRevisions, liveRuns, openIssueFindings, requireStory, undecidedIdeas } from '../loop/records';
import { rememberGlobalMaxConcurrent } from '../loop/ceiling';
import { isAgentKind, setAgentModel } from '../run/agent-models';
import { listProviderModels } from '../run/provider-models';
// U-13's two routes install and queue drafts, so they use the tool layer's own §4.15 body codec and
// its task opener: the Editor's `selectRevision`/`requestMerge` read the SAME functions, so an
// Author's choice and a Reader's choice cannot disagree about what a stored draft says (D-22, D-23).
import { openTask, revisionBodyFields, revisionBodySections } from '../tools/artifacts';
// SUMMARY PHRASE (R2/R5/R6) — the group domain, for the three routes that expose it and for the two
// legacy routes that must REFUSE a group-managed book. The refusal matters: `revisions/:id/select` and
// `revisions/merge` are decisions about a COMPETING DRAFT SET, and a group book has no draft set (an
// accepted result installs immediately — R5). Answering them with 409 keeps the dashboard from
// silently installing a `revisions` row the group loop never created.
import {
    // D-68 — the Author's choose: the reviewed Overview becomes the book, in one commit.
    chooseReviewedSummary,
    cleanSelectionOf,
    importLegacySummary,
    installGroupRevisions,
    isGroupManagedStory,
    // T-W3 — the PER-PHRASE gate. `revise`/`lock`/`unlock` used to ask `isGroupManagedStory` (the book's
    // Summary switch) whatever group the path named; they now resolve the group's OWN phrase and ask the
    // dial that phrase answers to, so a grouped chapter entry is writable on a book whose Summary is
    // `sampling`, and vice versa. The Summary's refusal strings stay byte-identical (pinned).
    isPhraseGroupManaged,
    // F8 — the Author's edit and the Writer's install race on ONE group row. The rail disables the
    // button off the same read the route refuses with (`projections.ts:writer_busy`), so the 409 is the
    // server's answer to a request the UI already tried to prevent, not a surprise.
    liveGroupWriters,
    phraseGroupById,
    phraseGroupsOf,
    // GROUP LOCK (R1) — the Author's two writes on one group's current text, and the result shapes the
    // route answers with. The refusals come back as thrown `PhraseLockRefusal`s, which `refusal()` already
    // renders as the 409 the rail prints; the route never re-implements a lock rule.
    lockPhraseGroup,
    unlockPhraseGroup,
    // T-W3 — the phrase CONTROLLERS and the on-demand start. `POST …/phrases/:key/start` is generic: it
    // looks the kind up here and calls THAT controller's `start`, which copies the seed onto the row. The
    // compiled Summary the button copies is composed by the projection's own read, so the rail's preview
    // and the copied text cannot disagree.
    phraseController,
    storyPhraseByKey,
    // The labeled plotpoint block a chapter entry's text is composed from — the SAME derivation the
    // loop's install uses, so a hand edit of a chapter entry and a Writer's answer write one text.
    chapterEntryContent,
    type GroupInstallResult,
    type PhraseImportResult,
    type PhraseLockResult,
    type PhraseStartResult,
    type PhraseUnlockResult,
    type PlotpointFields,
    type ReviewedChooseResult
} from '../phrase';
import type { Store } from '../store';
import type { Context } from 'hono';
import type { WorkItem } from '../run/types';
import type { RunExecutor } from '../run/executor';
import type { DigestBuilder } from '../digest/digest';
import type { CriteriaEngine } from '../criteria/engine';
import type {
    EngineApi,
    GoalPatch as EngineGoalPatch,
    // T12 — the lock's receipt, the shape the `/lock` response's `lock_receipt` is built from.
    PhaseLockReceipt,
    ResolvedEngineConfig
} from '../loop/types';
import type { StoryRuntimeContext, StoryRuntimes } from '../runtime';
import type { ServerConfig } from '../runtime/server-config';
import {
    SUMMARY_REVIEW_LIMIT,
    type Cost,
    type Criterion,
    // T-W3 — the phrase ENTRY row, named by the per-phrase gate helper below (`phraseGateOf` resolves a
    // `:groupId` to its group and that group's phrase, and returns the row it found, which may be none).
    type PhraseGroup,
    type Revision,
    type Run,
    type Story,
    type StoryPhase,
    type Template
} from '../../shared/types';
import type { GoalCriterionOp } from '../../dashboard/api';
import type { StoryKnowledge } from '../knowledge';
import type { StoryThreadLog } from '../run/thread-log';
import {
    agentThreads,
    agentThreadsAcross,
    // T-W3 — the compiled Summary, composed by the SAME read the rail's preview uses (a complete reviewed
    // Overview when one exists, else the Overview as it stands). The Start verb seeds from this, so the
    // text the handoff button shows and the text the phrase copies are one function's answer.
    compiledSummaryOf,
    feedEvents,
    goalSurface,
    mergeAgentStatuses,
    // T-W3 — the per-phrase read: the pinned `phraseView` shape plus that phrase's deltas.
    phraseDetailView,
    phraseView,
    queueItems,
    queueItemsAcross,
    runsAcross,
    storyRow,
    storyRows,
    storyRowsAcross,
    storyView
} from './projections';
import type { FeedEvent, ProjectionDeps } from './projections';
// The two phrase KIND KEYS, from the catalog that owns them (R1: the keys are product data). The gates
// name these rather than a string literal, so a retired kind is a compile error here and not a 409 that
// quotes a phrase the catalog no longer has.
import { PHRASE_PLOTLINES_KEY, PHRASE_SUMMARY_KEY } from '../../shared/phrase';

/** §8.6 — the Author-invoked harness. Seeded at boot by `./server` (D-17: built-in, duplicate-only). */
export const ASSISTANT_TEMPLATE = 'assistant';
export const ASSISTANT_ROLE = 'assistant';

/** The four costs the D-35 dial may name, for body validation. */
const COSTS: string[] = ['critical', 'major', 'minor', 'taste'];

/** §6.3a L-32 — the only two backtrack targets (phase ③ is where the Story already is). */
const BACKTRACK_PHASES: string[] = ['summary', 'plotlines'];

/**
 * S-RUNTIME: the loop the routes call, in its two shapes.
 *
 * A single-store server passes the one `LoopEngine` it built — every test does this, and the shape is
 * unchanged. A workspace of per-Story books passes `StoryRuntimes`, which implements the same verbs and
 * chooses the context by the Story id the path names (`runtime/story-runtimes.ts`). Widening the type to
 * `EngineApi` plus the two reads the route table makes is what lets both shapes share one route table:
 * no handler knows which topology it is serving.
 */
export type StoryLoop = EngineApi & {
    /** L-1's switch, as the dashboard's loop control reads it. */
    readonly started: boolean;
    /** The ceiling and cadence the sweep is running under (`/loop`). */
    readonly config: ResolvedEngineConfig;
    /** S-5: moving the one ceiling (`PATCH /loop`). */
    setGlobalMaxConcurrent(limit: number): void;
};

/** Everything the routes need. Built once per process by `./server`. */
export interface StorylineRoutesDeps extends ProjectionDeps {
    engine: StoryLoop;
    /**
     * The spawner of the single-store shape — the run-kill route and the retained-thread route read its
     * harness. In registry mode each Story has its own executor (`runtimes.contexts_()`), so there is no
     * one to name here and the routes take it from the Story's context instead.
     */
    executor?: RunExecutor;
    /**
     * S-RUNTIME: the per-Story runtimes, present when the server has more than one book (registry mode).
     * Absent means the single-store shape: `store` is the whole workspace, and every Story id is looked up
     * in it — which is exactly how this file behaved before the per-Story layout.
     */
    runtimes?: StoryRuntimes;
    /**
     * S-RUNTIME: the app book (`<root>/server/`), where the crew catalogue and the host settings live.
     * When present, `/templates*` and the roster write HERE and the change is then mirrored into every
     * Story book (`StoryRuntimes.syncConfig`); when absent they write `store`, as before.
     */
    config?: ServerConfig;
    /** The Story's durable knowledge projection (harness knowledge engine, outside every session). */
    knowledge: StoryKnowledge;
    /** The retained thread log (request + answer for every thread that ever ran). */
    threadLog: StoryThreadLog;
    /**
     * U-8 — the provider root the harness engine dials (`STORYLINE_PROVIDER_BASE_URL`). The roster's
     * model choices are read from this root's OpenAI-compatible catalog, `GET {base}/models`, because
     * the dropdown must offer exactly the models the runs can ask for.
     */
    providerBaseUrl: string;
    /** The transport's optional bearer; the catalog request sends the same one. */
    providerApiKey?: string;
    /** Test seam for the catalog fetch; defaults to `globalThis.fetch`. */
    fetchImpl?: typeof fetch;
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

/**
 * S-RUNTIME — a run id is book-LOCAL (`run_0` exists in every Story's book), so the lookup that finds the
 * book to stop a run IN can come back with more than one holder. This sentinel is how that lookup says so,
 * and `POST /runs/:runId/kill` answers it with the 409 that names the missing `story_id` rather than
 * aborting one of the holders because it was first in book order.
 */
const AMBIGUOUS = Symbol('more than one Story holds this run id');

/** The book a run id lives in: its ledger, the executor that can abort it, and the Story the row belongs to. */
interface RunScope {
    store: Store;
    executor: RunExecutor;
    storyId: string;
}

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
// T12 / R4 — the Summary accept's second move: Phrase ② starts from the text just locked
// ---------------------------------------------------------------------------

/** What the auto-start reports — the two fields the lock response carries about Phrase ②. */
interface PhraseAcceptStart {
    /** True ONLY when THIS accept created the Phrase ② row; a no-op says so rather than claiming a start. */
    phrase_started: boolean;
    /** `''` when it started. Otherwise the sentence the rail shows under a successful accept. */
    phrase_start_reason: string;
}

/**
 * R4 — "Phrase ② can start automatically, using the compiled Phrase ① as seed. This means Phrase ① is
 * complete." The lock has already committed when this runs, and it runs in its OWN commit:
 *
 * WHY NOT INSIDE `lockWrites`: the lock's one-commit contract is pinned (`loop/engine.ts:lockPhase`,
 * `integration/slice-phases.test.ts`, `loop/d36-tray.test.ts`), and a start that can be refused must not
 * be able to roll the accept back. Two commits, in the order the Author experienced them: the Summary is
 * final, and THEN the next phrase begins. A start that fails leaves a locked Summary and an honest receipt.
 *
 * WHY HERE AND NOT IN THE ENGINE: the seed is `projections.ts:compiledSummaryOf` — the same read the
 * handoff button previews — and the start is the same controller the manual verb calls
 * (`phrase/controller.ts:PhraseController.start`, i.e. `phrase/controllers/plotlines.ts:startPlotlinesPhrase`
 * under the idempotent wrapper). Neither belongs in the phase machine, which has no reason to know what a
 * compiled Overview is. Reaching for the projection and the controller from HERE is what keeps the seed the
 * button showed and the seed the row copies one function's answer (D-72).
 *
 * THE THREE WAYS IT DOES NOT START, each reported rather than thrown:
 *   - this Story runs Phrase ② on the classic §4.3 tools (`phrase/catalog.ts:isPhraseGroupManaged` reads
 *     an absent `plotlines_mode` as `'classic'`) — there is no Phrase ② row on that lane, and starting one
 *     would freeze the dial under P4 on a legacy book that never asked for it;
 *   - the phrase is ALREADY started (R4's idempotence): the row is the identity its entries, revisions and
 *     claim keys name, so the accept touches nothing (D-72); and
 *   - there is no compiled Summary to copy — the WEAKER question the rail asks too
 *     (`projections.ts:summaryIsCompiled`). The lock stays; the manual Start verb keeps its one-time 409.
 *
 * THE LLM NEVER RUNS HERE: a start creates a `phrases` row and copies text, which is why one more commit
 * is cheap and why a failure is a sentence rather than a rewind.
 */
async function startPlotlinesFromAcceptedSummary(store: Store, storyId: string): Promise<PhraseAcceptStart> {
    const controller = phraseController(PHRASE_PLOTLINES_KEY);

    // R1: `starts_on_demand` is catalog data. A build without Phrase ② has nothing to start, and the
    // Summary the Author just accepted is still locked.
    if (controller === undefined) {
        return {
            phrase_started: false,
            phrase_start_reason:
                'the Plotlines Phrase is not an enabled catalog kind in this build (R1), so the accept had nothing to start.'
        };
    }

    const story = requireStory(store, storyId);

    if (!isPhraseGroupManaged(story, PHRASE_PLOTLINES_KEY)) {
        return {
            phrase_started: false,
            phrase_start_reason: `this Story writes its chapter contracts with the classic plotline tools (\`plotlines_mode\` is not 'groups', R11), so there is no Phrase ② to start; PATCH /stories/${storyId} moves the dial and POST /stories/${storyId}/phrases/plotlines/start starts the phrase whenever the Author chooses (R5).`
        };
    }

    // IDEMPOTENT, R4. Read BEFORE the commit so an already-started phrase performs no write at all, and so
    // the reason can name the row the accept left alone — the same fact the manual verb's 409 carries, told
    // here as a no-op because the accept is not a request to re-seed anything.
    const existing = controller.phraseOf(store, storyId);

    if (existing !== undefined) {
        return {
            phrase_started: false,
            phrase_start_reason: `the ${controller.definition.key} Phrase is already started on this Story (${existing.id}); its copied seed is the text every entry, revision and claim key was written against, so the accept left it alone (D-72).`
        };
    }

    // THE SEED, from the projection the rail previews — `source: compiled`, exactly the manual verb's
    // default. Trimmed for the same reason the Start route trims: a blank seed would be hashed by every
    // Phrase ② gate as though the Author had handed over something.
    const seed = compiledSummaryOf(store, story).trim();

    if (seed === '') {
        return {
            phrase_started: false,
            phrase_start_reason: `this Story has no compiled Summary to start the ${controller.definition.key} Phrase from, so the Summary is locked and Phrase ② is unchanged; POST /stories/${storyId}/phrases/import turns the flat Summary into groups, and a written Overview is what gets copied (R5, D-76).`
        };
    }

    // ONE COMMIT, the same label the manual Start writes, so the journal shows one kind of act either way.
    // `started` is the CONTROLLER's flag — false means something started it in the same moment, which is a
    // successful no-op rather than a failure, and the reason says which.
    let started = false;

    try {
        await store.commit('phrase_start', () => {
            const result = controller.start(
                store,
                requireStory(store, storyId),
                authorAttr(
                    authorWhy(
                        'POST /stories/:id/lock',
                        storyId,
                        `the ${controller.definition.title} was started from the compiled Summary the Author accepted (D-72, R4)`
                    )
                ),
                { seedText: seed }
            );

            started = result.started;
        });
    } catch (error) {
        // R4's tolerance, stated rather than swallowed: the accept happened, and the sentence names the
        // one move that finishes the job by hand.
        return {
            phrase_started: false,
            phrase_start_reason: `the Summary stayed locked; the ${controller.definition.title} did not start: ${
                error instanceof Error ? error.message : String(error)
            }`
        };
    }

    return started
        ? { phrase_started: true, phrase_start_reason: '' }
        : {
              phrase_started: false,
              phrase_start_reason: `the ${controller.definition.key} Phrase was already started by the time the accept reached it, so its seed is the text that row was written against (D-72).`
          };
}

// ---------------------------------------------------------------------------
// T-W3 — the PER-PHRASE gate the group verbs share
// ---------------------------------------------------------------------------

/**
 * THE ENTRY NOUN a phrase's refusal uses, so one sentence serves both phrases without pretending the
 * chapter entries are a Summary. The Summary's copy is the pinned one (`this Summary`); Phrase ②'s
 * entries are chapters, and the live-Writer refusal is the sentence this feeds.
 */
const phraseEntryNoun = (phraseKey: string): string =>
    phraseKey === PHRASE_PLOTLINES_KEY ? 'the chapter entries' : 'this Summary';

/**
 * THE refusal a phrase-verb prints when the phrase the path names is not run as entries on this book.
 *
 * The Summary arm is reproduced BYTE FOR BYTE — four sentences in it are pinned verbatim by
 * `phrase-routes.test.ts`, `phrase-lock-routes.test.ts`, `dashboard/api.phrases.test.ts` and
 * `dashboard/real-server-phrases.test.tsx`, and the dashboard is only allowed to relay them. The
 * Plotlines arm names the two moves that would make the verb work, because a refusal the Author cannot
 * act on is a dead end: the dial (`plotlines_mode`) and the phrase's own start verb. It points at neither
 * `summary_mode` nor the import route, which are Phrase ①'s business and would send the Author to change
 * the wrong Setting.
 */
const groupModeRefusal = (
    storyId: string,
    phraseKey: string,
    /** The rule tokens the Summary's sentence ends with — pinned per verb (`R6`, `R1, R6`, `R6, D-68`). */
    summaryTokens: string,
    /** The same tokens for the Plotlines arm: that phrase's rule is P4's, not R1/R6's. */
    plotlinesTokens = 'P4'
): string =>
    phraseKey === PHRASE_PLOTLINES_KEY
        ? `this Story's chapter entries are not its writable surface (\`plotlines_mode\` is not 'groups', so contracts are still written by the classic plotline tools); set \`plotlines_mode\` to 'groups' with PATCH /stories/${storyId} and start the phrase with POST /stories/${storyId}/phrases/plotlines/start (${plotlinesTokens}).`
        : `this Story's Summary is still written as one text (no group catalog); POST /stories/${storyId}/phrases/import turns the flat Summary into groups first (${summaryTokens}).`;

/**
 * WHICH phrase a `:groupId` addresses, and the key its gate reads (T-W3).
 *
 * The gate used to be `isGroupManagedStory(story)` — the book's Summary switch — asked of whatever group
 * the path happened to name, which was right only while a book had one phrase. It now resolves the
 * GROUP'S phrase and asks that phrase's dial (`phrase/catalog.ts:isPhraseGroupManaged`), so a chapter
 * entry is writable on a book whose Summary is `sampling`, and a Summary group stays writable on a book
 * whose `plotlines_mode` is `classic`.
 *
 * AN ID THE BOOK DOES NOT HOLD resolves to the SUMMARY's dial rather than to a 404. That is deliberate
 * and it is what keeps a legacy book's answer unchanged: a `sampling` book has no group rows at all, so
 * every `:groupId` a stale rail or a typo sends is "the Summary verb on a book with no catalog", the 409
 * that names the import — the same sentence the pre-Phrase-② route produced and the tests pin. Only a
 * row that really exists can move a verb onto the Plotlines gate.
 */
const phraseGateOf = (
    store: Store,
    story: Story,
    groupId: string
): { group: PhraseGroup | undefined; phraseKey: string } => {
    const group = phraseGroupById(store, story.id, groupId);

    if (group === undefined) return { group: undefined, phraseKey: PHRASE_SUMMARY_KEY };

    return { group, phraseKey: store.phrases.get(group.phrase_id)?.key ?? PHRASE_SUMMARY_KEY };
};

/**
 * THE `view` a phrase verb answers with — the pinned Summary shape, or this phrase's wider one.
 *
 * `GET …/phrases`' shape is a PINNED contract (`phrase-routes.test.ts` asserts the verb responses equal it
 * key for key, and `dashboard/api.ts` consumes it field-for-field), so a group verb acting on the Summary
 * must keep answering exactly that object and may not smuggle the Phrase ② deltas in. A verb acting on a
 * Phrase ② entry answers `phraseDetailView` instead, which is the same projection plus `key`,
 * `seed_head`, `seed_chars`, `brief` and WITHOUT `review.mirror` (R6's mirror is the Summary's legacy prose,
 * and a chapter entry has none). One helper, so all three group verbs and the start verb agree about which
 * phrase's read they return rather than each handler deciding.
 */
const phraseVerbView = (store: Store, story: Story, phraseKey: string) =>
    phraseKey === PHRASE_SUMMARY_KEY ? phraseView(store, story) : phraseDetailView(store, story, phraseKey);

/**
 * The Author's contract fields for ONE chapter entry, validated the way the domain validates a Writer's
 * answer (`phrase/plotpoints.ts:parseChapterDraftAnswer`): the two required plotpoints must be non-blank,
 * because an entry that says neither what happens nor what changes is a chapter title, not a contract,
 * and the `plotlines` row the install mirrors would otherwise keep the previous pass's plotpoints (P4).
 *
 * `undefined` means "this body does not carry a contract" — the route turns it into its own 400 rather
 * than letting the install throw a domain sentence at an Author who never saw the field list.
 */
const plotpointsFromBody = (value: unknown): PlotpointFields | undefined => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;

    const fields = value as Record<string, unknown>;
    const text = (key: string): string => (typeof fields[key] === 'string' ? fields[key].trim() : '');
    const mustHappen = text('must_happen');
    const mustChange = text('must_change');

    if (mustHappen === '' || mustChange === '') return undefined;

    // The optional plotpoints travel only when they say something, which is the same rule
    // `chapterEntryContent` applies when it composes the entry's stored text: a blank label in a contract
    // block reads like a promise the chapter makes and pays with nothing.
    return {
        must_happen: mustHappen,
        must_change: mustChange,
        ...(text('heading') === '' ? {} : { heading: text('heading') }),
        ...(text('pov') === '' ? {} : { pov: text('pov') }),
        ...(text('setups') === '' ? {} : { setups: text('setups') }),
        ...(text('payoffs') === '' ? {} : { payoffs: text('payoffs') })
    };
};

// ---------------------------------------------------------------------------
// Body shapes (pinned by `src/dashboard/api.ts`; validated, never trusted)
// ---------------------------------------------------------------------------

interface StoryCreateBody {
    title?: unknown;
    idea?: unknown;
    chapter_count?: unknown;
    /** Phase ①'s sampling size (defaults to the standard five). */
    summary_sampling?: unknown;
    /** Phase ①'s Critic passes per sample (defaults to the standard five). */
    summary_critics?: unknown;
    /**
     * SUMMARY PHRASE R1/R6 — `'groups'` (the default for a NEW Story: five catalog groups, one Writer
     * batch at a time, an accepted result installed immediately) or `'sampling'` (the pre-redesign
     * whole-Summary hill-climb). The existing suites and any client that has not heard about the
     * redesign pass `'sampling'` to stay exactly where they were; omitting it is the new product
     * default, not the old behaviour — an EXISTING book with no `summary_mode` on its row is legacy by
     * definition and needs no migration.
     */
    summary_mode?: unknown;
    /**
     * PHRASE ② (T-W3) — `'groups'` (the default the engine gives a NEW Story: the chapter entries of the
     * Plotlines phrase, structured from that phrase's own copied seed) or `'classic'` (the §4.3 + §8.1
     * plotline tool path every book written before Phrase ② existed runs, because its row carries no
     * `plotlines_mode` at all). Validated the same way `summary_mode` is: the two words name two
     * pipelines, and a typo would otherwise be accepted as the new default and book the Author into work
     * they did not ask for.
     */
    plotlines_mode?: unknown;
}

interface StoryPatchBody {
    title?: unknown;
    idea?: unknown;
    chapter_count?: unknown;
    auto_approve?: unknown;
    /** Phase ①'s sampling size (Writer expansions of the Seed). */
    summary_sampling?: unknown;
    /** Phase ①'s Critic passes per sample. */
    summary_critics?: unknown;
    /**
     * GROUP LOCK R1 — may the EDITOR lock a phrase group on this Story?
     *
     * An OPTIONAL BOOLEAN, and ABSENT MEANS LEAVE IT ALONE (the same discipline every other field here
     * uses): a body that omits the key cannot flip a Setting the Author set weeks ago. Explicit `false`
     * DOES write, because taking the Editor's power back is itself a decision the rail sends. The rule
     * itself lives in `phrase/locks.ts:editorGroupLockingEnabled` (absent = disabled); this route only
     * validates the shape and stores the boolean.
     */
    editor_group_locking?: unknown;
    /**
     * PHRASE ②'s dial (T-W3) — `'groups'` or `'classic'`, settable ONLY while the Plotlines phrase has
     * not been started. Starting the phrase is the moment its copied seed, its entries and its claim keys
     * exist, and the lane the loop writes into is decided by this dial from then on; moving it afterwards
     * would leave a started phrase whose entries are written by a pipeline nobody chose. The 409 names the
     * phrase row that made the dial unmovable.
     */
    plotlines_mode?: unknown;
}

/**
 * T-W3 — the body of `POST /stories/:id/phrases/:key/start`: WHERE the seed comes from.
 *
 * `source: 'compiled'` (the default) copies Phrase ①'s compiled Summary; `'custom'` copies the Author's
 * own `text`, which is how a book skips Phrase ①'s pipeline entirely. Both arms end in the same call and
 * the same copy — the phrase row stores the string it was handed, so nothing either phrase does later can
 * reach it. `text` is read only for `'custom'`; a stray `text` beside `'compiled'` is ignored rather than
 * half-applied, because a request that sends both is asking for one of them and the route refuses to guess
 * which one the client meant.
 */
interface PhraseStartBody {
    source?: unknown;
    text?: unknown;
}

/**
 * T-W3 — the body of the Author's hand revision of ONE phrase entry.
 *
 * `content` is the Summary group's new prose. For a CHAPTER ENTRY the body carries `plotpoints` instead:
 * a chapter entry's stored text is a DERIVATION of its contract fields
 * (`phrase/plotpoints.ts:chapterEntryContent`), and the install refuses a plotlines entry with no
 * plotpoints because the `plotlines` row it mirrors would keep the previous pass's contract while the
 * entry text moved on (P4). A `content` key beside `plotpoints` is not read — deriving the text is the
 * point — and a chapter entry body with neither is the 400 that names the contract.
 */
interface PhraseGroupReviseBody {
    content?: unknown;
    note?: unknown;
    plotpoints?: unknown;
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
    refs?: unknown;
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

/** U-8 — one employee's model on the global roster. `null` clears the choice (template role → process default). */
interface AgentModelBody {
    model?: unknown;
}

/**
 * S-5 — the loop's fan-out ceiling, the one engine setting the workstation may move. Unknown here
 * rather than `number`: the route answers 400 with its own sentence for a value that is not a whole
 * number of threads, and a body the client mis-shaped must not become a 500.
 */
interface LoopSettingsBody {
    global_max_concurrent?: unknown;
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
 * Author's desk asks for the same thing a Reader does: "take this half of this draft and that half
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

    // -------------------------------------------------------------------------
    // S-RUNTIME — which BOOK a request acts on
    // -------------------------------------------------------------------------
    //
    // A Story is a book (`store/story-stores.ts`), and one server now serves several of them. Two rules
    // make that invisible to the handlers below:
    //
    //   1. a Story-scoped handler shadows `store` with the book its `:id` names, so every read and write in
    //      its body — including the direct `store.commit` writes this file uses for the Author's edits —
    //      lands in that Story's book and cannot touch a sibling's rows;
    //   2. an id this server does not hold resolves to the deps book, so the handler's own lookup misses and
    //      answers the 404 sentence this file already owns. A foreign Story is therefore absent, not wrong:
    //      the same answer the store's `story_id` fence gives at the row level.
    //
    // In the single-store shape `runtimes` is absent and both rules are identity: one book, every id in it.
    const runtimes = deps.runtimes;
    // S-RUNTIME: host configuration is a separate book in registry mode (the app book at `<root>/server/`),
    // and `deps.store` IS that book. In single-store/adopted mode it is the Story's own book, which makes
    // `synced()` below a plain persist of the one book the caller just wrote.
    const config = deps.config;

    /**
     * S-RUNTIME: flush a HOST-CONFIGURATION write and re-copy it into every Story's runtime.
     *
     * A configuration row (the harness catalogue, a per-agent model, the loop ceiling) belongs to the app book:
     * journaled into one Story it would sit in that Story's journal and mark every other Story's Digest stale
     * forever. But each Story's runtime reads its OWN copy — that is what an agent's turn and a harness brief
     * actually resolve — so the write is mirrored down. Both halves are best effort on the mirror only: a book
     * that refuses the copy (a revision conflict) keeps the previous one and says so, and the next write retries.
     */
    const synced = async (): Promise<void> => {
        if (config !== undefined) await config.persist();

        // A hand-wired host may mount this route table without a coordinator (one injected book, no
        // registry); then there is no set of books to mirror into, and the app-level write above is the
        // whole of the sync.
        await runtimes?.syncConfig();
    };

    /** The aggregate's books, read fresh so a Story created after boot joins every cross-Story listing. */
    const books = (): Store[] => (runtimes !== undefined ? runtimes.stores() : [store]);

    /** The projection inputs for ONE book: the criteria engine and Digest builder are pure, the book is not. */
    const projections = (book: Store): ProjectionDeps => ({ store: book, criteria, digest });

    /** The book a Story id lives in (see the note above for what a miss answers as). */
    const bookOfId = (storyId: string): Store => runtimes?.storeFor(storyId) ?? store;

    /** The same resolution from the request's `:id` — what a Story-scoped handler shadows `store` with. */
    const bookOf = (c: Context): Store => bookOfId(param(c, 'id'));

    /** The Story a path names, in the book that holds it, or the 404 this layer answers before any engine call. */
    const storyOf = (book: Store, id: string): Story | undefined => book.stories.get(id);

    /**
     * The Story's knowledge projection. Per-Story books each own a projection rooted in their own directory
     * (`<root>/stories/<uuid>/harness/knowledge/`), so an article read here is the article THIS Story's
     * crews would read in a run's prompt. Single-store mode keeps the one projection the server opened.
     */
    const knowledgeFor = (storyId: string): StoryKnowledge =>
        runtimes?.contextOf(storyId)?.knowledge ?? deps.knowledge;

    /** The thread log of the book a Story lives in — the same per-Story file, for `GET /agents/:kind/threads`. */
    const threadLogFor = (book: Store): StoryThreadLog =>
        (runtimes !== undefined
            ? runtimes.contexts_().find((context: StoryRuntimeContext) => context.store === book)?.threadLog
            : undefined) ?? deps.threadLog;

    /**
     * The book a run id lives in, WITH the executor that can stop it — optionally narrowed to one Story.
     *
     * The executor half is not decoration: `RunExecutor.kill` looks up the controller of a run THIS
     * executor started, so a kill routed through the wrong book's executor would abort nothing and answer
     * 200 anyway. `undefined` is the 404 the caller answers with.
     *
     * WHY THE SCOPE: a run id is book-LOCAL (`run_0` exists in every Story's book), so an unscoped lookup
     * over several books can find more than one holder. Guessing — "the first book that holds it", which is
     * what this did — silently aborts a thread the Author never pointed at, so the lookup now reports the
     * ambiguity instead and the caller names the Story with `?story_id=`.
     *
     * A per-Story book is addressed by its own id; one AGGREGATE book (the adopted/hand-injected shape,
     * keyed by `runtime/story-runtimes.ts:SHARED_STORE_ID`) is addressed by the `story_id` the row itself
     * carries, which is how a scoped kill still reaches the one executor in that shape.
     */
    const bookOfRun = (runId: string, storyId?: string): RunScope | typeof AMBIGUOUS | undefined => {
        /** Does this book's row answer to the Story the caller named (or to no Story at all)? */
        const answers = (row: Run | undefined, bookStoryId: string): boolean =>
            row !== undefined && (storyId === undefined || bookStoryId === storyId || row.story_id === storyId);

        if (runtimes === undefined) {
            // The single-store shape still needs an executor to abort with; a route table built without one
            // can read a run row but cannot stop it, which is the honest answer rather than a silent no-op.
            // One book means one holder, so an unscoped kill is never a guess in this shape.
            if (executor === undefined) return undefined;

            const row = store.runs.get(runId);

            if (!answers(row, store.storyId ?? '')) return undefined;

            return { store, executor, storyId: row?.story_id ?? store.storyId ?? '' };
        }

        const holders = runtimes.contexts_().flatMap((context: StoryRuntimeContext) => {
            const row = context.store.runs.get(runId);

            return answers(row, context.storyId)
                ? [{ store: context.store, executor: context.executor, storyId: row?.story_id ?? context.storyId }]
                : [];
        });

        if (holders.length === 0) return undefined;

        // More than one holder is only possible when the caller named no Story: one Story can live in only
        // one book, so a scope matches at most one holder and the kill is exact.
        if (holders.length > 1) return AMBIGUOUS;

        return holders[0];
    };
    const missing = (c: Context, kind: string, id: string) =>
        errorResponse(c, 404, `no ${kind} named ${id} is in the book (P1: the store is the memory)`);

    /**
     * S-RUNTIME — the ONE purge path a Story deletion takes, so nothing else can delete the same Story
     * twice and nothing can write to a book whose folder is already gone.
     *
     * Under the coordinator, `runtime/story-runtimes.ts:removeStory` owns the whole order — pause the Story
     * so no sweep starts a run behind the delete, kill and settle the runs in flight, delete the §4 rows and
     * forget the harness session in one commit, prune the retained thread log, remove and close the Story's
     * knowledge projection, drop the runtime, then close the book and remove `<root>/stories/<uuid>/`. The
     * route therefore must NOT also call `engine.deleteStory`: that would be a second `delete_story` commit,
     * and after the folder is gone the commit's debounced snapshot would re-create the directory the Author
     * just deleted, which restarts as a ghost book.
     *
     * The fallback is a hand-wired host that mounts this table with a bare store and no coordinator: the same
     * order, minus the folder (no registry to remove it), and the book's own projection and thread log are
     * PRUNED rather than closed, because they belong to every Story in the book.
     */
    const purgeStory = async (storyId: string): Promise<void> => {
        if (runtimes !== undefined) {
            await runtimes.removeStory(storyId);

            return;
        }

        // The pieces the fallback prunes: in this shape both resolve to `deps`, i.e. the one book's own.
        const book = bookOfId(storyId);
        const knowledge = knowledgeFor(storyId);

        await engine.deleteStory(storyId);

        knowledge.removeStory(storyId);
        await knowledge.flush();
        threadLogFor(book).removeStory(storyId);
    };

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
     *
     * S-RUNTIME: the lookup runs in the book the Story lives in. `chapter_3` exists in every book, so the
     * T-3 rule ("another Story's row is a miss") needs the book to be the right one to be enforceable at all.
     */
    const revisionUnit = (
        storyId: string,
        unitRef: string
    ): { unit_kind: Revision['unit_kind']; id: string; rev: number } | undefined => {
        const store = bookOfId(storyId);
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

    /**
     * Runs one engine verb and returns the fresh row — the shape every Story mutation answers with.
     *
     * S-RUNTIME: the fresh row is read from the Story's OWN book, because that is the book the verb (routed
     * by Story id through `StoryRuntimes`) just wrote. Reading it from the deps book would answer a Story
     * mutation with the app catalogue's rows, which hold no Stories at all in registry mode.
     */
    const verb = async (c: Context, storyId: string, run: () => Promise<unknown>): Promise<Response> => {
        try {
            await run();
        } catch (error) {
            return refusal(c, error);
        }

        const book = bookOfId(storyId);

        return c.json(storyRow(projections(book), book.stories.require(storyId)), 200);
    };

    // -------------------------------------------------------------------------
    // Stories (U-1, U-4…U-17)
    // -------------------------------------------------------------------------

    /**
     * U-1 — the Stories panel, awaiting-the-Author first.
     *
     * S-RUNTIME: one row per Story ACROSS books, ranked exactly as one book's rows are ranked
     * (`projections.storyRowsAcross`). A Story created after this route table was built still appears,
     * because the book list is read per request.
     */
    app.get('/stories', (c) => c.json(storyRowsAcross(books().map(projections)), 200));

    /** §15 step 0 — the Seed, the declared count, and the default Goal (D-3b: the count is Author truth). */
    app.post('/stories', async (c) => {
        const parsed = await readBody<StoryCreateBody>(c);

        if (!parsed.ok) return parsed.response;

        const { title, idea, chapter_count, summary_sampling, summary_critics, summary_mode, plotlines_mode } =
            parsed.body;

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

        for (const [field, value] of [
            ['summary_sampling', summary_sampling],
            ['summary_critics', summary_critics]
        ] as const) {
            if (
                value !== undefined &&
                (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > SUMMARY_REVIEW_LIMIT)
            ) {
                return errorResponse(
                    c,
                    400,
                    `\`${field}\` must be a whole number from 1 to ${SUMMARY_REVIEW_LIMIT} (D-17d/D-38a: the count is the Author's setting).`
                );
            }
        }

        // SUMMARY PHRASE R1/R6: the switch is validated here rather than defaulted, because the two
        // values name two different pipelines and a typo ('group', 'grouping') would otherwise be
        // quietly accepted as the new default and book the Author into work they did not ask for.
        if (
            summary_mode !== undefined &&
            summary_mode !== 'groups' &&
            summary_mode !== 'sampling'
        ) {
            return errorResponse(
                c,
                400,
                '`summary_mode` must be `\'groups\'` (the five Summary groups, revised one batch at a time) or `\'sampling\'` (the whole-Summary sampler).'
            );
        }

        // PHRASE ② (T-W3) — the same rule one phrase over: the two words name two pipelines, and a typo
        // ('group', 'chapter') would otherwise be accepted as the new default and book the Author into
        // chapter-entry work they did not ask for. Note the off-word is `classic`, NOT `sampling` — that word
        // belongs to Phrase ①'s switch, and a client that sends it here is asking for the other phase.
        // Omitting the key is the engine's NEW default (`'groups'`), while an EXISTING row with no field is a
        // classic book (R6 applied to this dial, §4.1): neither reading is a migration, and neither is a guess.
        if (
            plotlines_mode !== undefined &&
            plotlines_mode !== 'groups' &&
            plotlines_mode !== 'classic'
        ) {
            return errorResponse(
                c,
                400,
                '`plotlines_mode` must be `\'groups\'` (the chapter entries, one per chapter the Plotlines brief declares) or `\'classic\'` (the §4.3 plotline tools, the pipeline every book written before Phrase ② runs).'
            );
        }

        let storyId: string;

        try {
            const created = await engine.createStory({
                ...(typeof title === 'string' && title.trim().length > 0 ? { title } : {}),
                idea,
                ...(chapter_count === undefined ? {} : { chapter_count }),
                ...(summary_sampling === undefined ? {} : { summary_sampling: summary_sampling as number }),
                ...(summary_critics === undefined ? {} : { summary_critics: summary_critics as number }),
                ...(summary_mode === undefined ? {} : { summary_mode: summary_mode as 'groups' | 'sampling' }),
                // T-W3 — passed only when the Author named it: the engine's own default is `'groups'`, and an
                // omitted key must reach that default rather than a route-invented one (R6 applied to this dial keeps the absent
                // field on existing books meaning `classic`).
                ...(plotlines_mode === undefined ? {} : { plotlines_mode: plotlines_mode as 'groups' | 'classic' })
            });

            storyId = created.story_id;
        } catch (error) {
            return refusal(c, error);
        }

        // S-RUNTIME: the row is read from the book the Story was just created IN. `POST /stories` is the one
        // verb that has no Story id to route on: in registry mode the coordinator allocates the book and the
        // id, so this is the first read of a book that did not exist a moment ago.
        const book = bookOfId(storyId);

        return c.json(storyRow(projections(book), book.stories.require(storyId)), 200);
    });

    /** U-4…U-17 — the whole Story region in one read (W9: one round trip, not fifteen). */
    app.get('/stories/:id', (c) => {
        // S-RUNTIME: the book this Story lives in, shadowing the deps store for the rest of the handler.
        const store = bookOf(c);
        const story = storyOf(store, c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        return c.json(storyView(projections(store), story), 200);
    });

    /**
     * The Story's knowledge directory. One read, eight folders, one article per folder.
     *
     * THE WRITE-BEFORE-READ IS DELIBERATE: the tree is a projection of the book, and a commit
     * that landed since the last sync must be visible in this response. `tree()` re-derives the
     * Story's sections synchronously, then `flush()` makes the bytes durable before answering —
     * so a harness that is destroyed immediately after this response cannot take the directory
     * with it.
     */
    app.get('/stories/:id/knowledge', async (c) => {
        const storyId = c.req.param('id');

        if (storyOf(bookOfId(storyId), storyId) === undefined) return missing(c, 'story', storyId);

        // S-RUNTIME: the projection of THIS Story's book, which is the directory under its own folder.
        const knowledge = knowledgeFor(storyId);
        const tree = knowledge.tree(storyId);

        if (tree === null) return missing(c, 'story', storyId);

        await knowledge.flush();

        return c.json(tree, 200);
    });

    // -------------------------------------------------------------------------
    // SUMMARY PHRASE — the group surface (R1, R2, R3, R6)
    // -------------------------------------------------------------------------

    /**
     * R6 — the Summary Phrase view: the five groups with their current text and retained history, the
     * composed Overview, every finding with its group scope and R3's resolution, the open group tasks,
     * and whether the legacy `summaries` mirror still agrees with the groups.
     *
     * A pure read, so it is safe on a legacy book: one with no `summary_mode` answers `mode:'sampling'`
     * with empty groups rather than 404 — the rail then shows that book its old sampling panel, and
     * nothing about the redesign has touched its rows (R6's "readable, not migrated").
     */
    app.get('/stories/:id/phrases', (c) => {
        const store = bookOf(c);
        const story = storyOf(store, c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        return c.json(phraseView(store, story), 200);
    });

    /**
     * R6 — the one-step upgrade of a legacy flat Summary into groups.
     *
     * This is the ONLY way a book written before the redesign becomes group-managed: a read never
     * migrates anything, and the redesign's rule is that the Author decides when their prose moves into
     * a group history. It is idempotent by SKIPPING — a group that already has a revision is left
     * exactly as it is — so a second press writes nothing, and a partial first attempt is safe to
     * retry. Each group whose legacy field is non-empty gets revision 1 (`state:'latest'`, `run_ref:
     * null`, because no run wrote it: the Author's existing text is preserved, not re-authored); an
     * empty group stays at revision 0, which the loop reads as first-draft work.
     */
    app.post('/stories/:id/phrases/import', async (c) => {
        const store = bookOf(c);
        const story = storyOf(store, c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        try {
            // `Store.commit` answers "did the write happen", not what it produced, so the result is
            // captured in the closure and read after the commit lands (the same shape the merge route
            // uses). The closure runs synchronously inside the commit, so `imported` is set whenever the
            // commit did.
            let imported: PhraseImportResult | undefined;

            await store.commit('phrase_legacy_import', () => {
                imported = importLegacySummary(
                    store,
                    requireStory(store, story.id),
                    authorAttr(authorWhy('POST /stories/:id/phrases/import', story.id, 'the flat Summary became five groups (R6)'))
                );
            });

            if (imported === undefined) {
                return errorResponse(
                    c,
                    409,
                    'the Summary Phrase catalog has no enabled group, so there is nothing to import into (R1).'
                );
            }

            return c.json(
                {
                    story_id: story.id,
                    phrase_id: imported.phrase.id,
                    imported: imported.seeded.length,
                    seeded: imported.seeded,
                    story_switched: imported.story_switched,
                    view: phraseView(store, requireStory(store, story.id))
                },
                200
            );
        } catch (error) {
            return refusal(c, error);
        }
    });

    /**
     * R11 / D-76 — ONE phrase's rail read: `GET /stories/:id/phrases/:key` (T-W3).
     *
     * This is the read the Plotlines rail (and Phrase ③'s, unchanged) needs, and it is the pinned
     * `GET …/phrases` projection scoped to the phrase the path names: its entry rows, its vector, its
     * findings, its live Writers — plus `key`, the copied Seed's preview, and that phrase's `brief`.
     *
     * WHY A `:key` 404 AND NOT A DEFAULT TO THE SUMMARY: the catalog is the Server's (R1), so a path cannot
     * invent a phrase, and a rail that mistypes `plotlines` must learn that from a 404 rather than be shown
     * the Summary's five sections under a Plotlines heading.
     *
     * AN UNWRITTEN PHRASE IS NOT A 404: `plotlines` on a book nobody has started answers the EMPTY shape
     * with `mode: classic` (or `groups`, once the dial is set) and `brief: null`, because R6's rule for the
     * Summary — readable, never migrated, never gated on having rows — is generalised to every phrase. The
     * rail's "start this phrase" row is exactly that read.
     */
    app.get('/stories/:id/phrases/:key', (c) => {
        const store = bookOf(c);
        const story = storyOf(store, c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        const phraseKey = c.req.param('key');

        if (phraseController(phraseKey) === undefined) return missing(c, 'phrase', phraseKey);

        return c.json(phraseDetailView(store, story, phraseKey), 200);
    });

    /**
     * R5 / D-76 — the Author STARTS an on-demand phrase: `POST /stories/:id/phrases/:key/start` (T-W3).
     *
     * WHAT THE ROUTE OWNS vs WHAT THE DOMAIN OWNS: this handler resolves the phrase KIND (the catalog's),
     * decides where the Seed comes from, and turns the two domain refusals into Author-shaped answers. It
     * then calls THAT phrase's controller (`phrase/controller.ts:phraseController` → `start`), which owns
     * the copy — the seed lands on the Phrase row as the text this phrase is written from, and the
     * `supplied` / `story_idea` distinction is a catalog fact, not a branch here. A third phrase is one more
     * catalog entry with `starts_on_demand: true`; this route does not change.
     *
     * THE SEED IS COPIED, NOT REFERENCED (D-72, and the property the whole phrase-independence rule rests
     * on): `startPlotlinesPhrase` writes the string it is handed onto `phrases.seed`, and every later read
     * of this phrase goes through `phrase/catalog.ts:phraseSeedOf`. Editing `stories.idea` or the Summary
     * after a start therefore cannot move Phrase ② — which is why the rail shows the copied text
     * (`seed_head`) rather than re-deriving it, and why a `GET` after a Seed edit still says the same thing.
     *
     * NO PHASE GATE, ON PURPOSE: the loop's phase counter says nothing about whether the Author may start
     * Phrase ②. Starting is an Author decision (R5), so the only refusals here are about the STATE of the
     * text being handed over — never about "phase ① is not locked yet".
     *
     * THE REFUSALS, each with its own sentence:
     *   - 400 — `source: 'custom'` without a non-blank `text`. This verb does not author the Seed;
     *   - 409 — `source: 'compiled'` and there is no compiled Summary to copy. The sentence names the move
     *     that produces one (the import verb), because "there is nothing to copy" is otherwise a dead end;
     *   - 409 — the phrase is ALREADY started. `startPlotlinesPhrase` refuses a re-seed outright (its seed
     *     is the input every entry, revision and claim key was written against), and the route says so
     *     before running a write it knows will throw; and
     *   - 409 — the kind is not `starts_on_demand` (Phrase ①). 409 rather than 404: the phrase exists and the
     *     loop writes it, so "start it by hand" is the impossible part, not the name.
     *
     * THE `view` IS THE POINT OF THE RESPONSE: one round trip gives the rail its started phrase, its empty
     * entry set and its copied Seed preview, so the press does not need a follow-up `GET` to show anything.
     */
    app.post('/stories/:id/phrases/:key/start', async (c) => {
        const store = bookOf(c);
        const story = storyOf(store, c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        const phraseKey = c.req.param('key');
        const controller = phraseController(phraseKey);

        if (controller === undefined) return missing(c, 'phrase', phraseKey);

        // A CATALOG PHRASE THE LOOP WRITES (Phrase ①) is 409, not 404: the phrase exists and the verb does
        // not know how to fail more precisely than "this one has no seed to hand over". `starts_on_demand` is
        // catalog DATA (R1), so the refusal is read off the definition rather than named here — a third kind
        // that starts on demand lands in the 200 arm without this route changing.
        if (!controller.definition.starts_on_demand) {
            return errorResponse(
                c,
                409,
                `the ${phraseKey} Phrase is not an on-demand start: its entry set comes from the catalog and the loop writes it, so there is no seed for the Author to hand over. POST /stories/${story.id}/phrases/plotlines/start is the verb that takes one (R1: \`starts_on_demand\` is catalog data, and this route reads it).`
            );
        }

        // A body is OPTIONAL here (the published contract says so): absent means `source: compiled`. A body
        // that arrives and is not an object is still the shared 400 sentence — the route refuses to guess
        // what `[...]` or `"compiled"` was meant to be.
        const raw = await c.req.json().catch(() => undefined);

        if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
            return errorResponse(c, 400, 'this route needs a JSON object body.');
        }

        const body = (raw ?? {}) as PhraseStartBody;
        const source = body.source === undefined ? 'compiled' : body.source;

        if (source !== 'compiled' && source !== 'custom') {
            return errorResponse(
                c,
                400,
                "`source` must be 'compiled' (this Story's compiled Summary, the default) or 'custom' (the Author's own `text`)."
            );
        }

        // 409 BEFORE the write, so the Author is told what stands rather than what threw: the domain's own
        // refusal (`startPlotlinesPhrase`) carries the same fact, and this sentence is the one the rail prints.
        const startedAlready = controller.phraseOf(store, story.id);

        if (startedAlready !== undefined) {
            return errorResponse(
                c,
                409,
                `the ${phraseKey} Phrase is already started on this Story (${startedAlready.id}); its copied seed is the text every entry, revision and claim key was written against, so a new seed means a new phrase, not a re-start (D-72).`
            );
        }

        // THE SEED, from the arm the Author chose. `compiled` goes through the SAME projection read the rail
        // previews (`projections.ts:compiledSummaryOf` — the complete reviewed Overview if the crew produced
        // one, else the Overview as it stands), so the text the button showed and the text the phrase stores
        // cannot disagree. `custom` is trimmed but otherwise untouched: the Author's words are the Seed.
        const rawSeed =
            source === 'compiled'
                ? compiledSummaryOf(store, story)
                : typeof body.text === 'string'
                  ? body.text
                  : '';
        const seed = rawSeed.trim();

        if (source === 'custom' && seed === '') {
            return errorResponse(
                c,
                400,
                "`source` is 'custom', so `text` must be a non-empty string — it is the seed this Phrase is written from, and this route does not write it for you (D-76)."
            );
        }

        if (seed === '') {
            return errorResponse(
                c,
                409,
                `this Story has no compiled Summary to start the ${phraseKey} Phrase from; POST /stories/${story.id}/phrases/import turns the flat Summary into groups, and a written Overview is what gets copied (R5, D-76).`
            );
        }

        try {
            // Captured in the closure like every other phrase verb: `Store.commit` answers "did it happen",
            // and the row this call minted is the answer the rail needs. One commit, because the phrase row
            // and its journal line are one decision — a phrase that exists without its start recorded in the
            // journal is a phrase the Author cannot explain afterwards.
            let started: PhraseStartResult | undefined;

            await store.commit('phrase_start', () => {
                started = controller.start(
                    store,
                    requireStory(store, story.id),
                    authorAttr(
                        authorWhy(
                            'POST /stories/:id/phrases/:key/start',
                            story.id,
                            `the ${controller.definition.title} was started from ${source === 'compiled' ? "the Story's compiled Summary" : "the Author's own text"} (D-72)`
                        )
                    ),
                    { seedText: seed }
                );
            });

            if (started === undefined) return refusal(c, new Error('the phrase start produced no result'));

            // Read back AFTER the commit, from the row: `seed_head`/`seed_chars` here are the phrase's own
            // projection fields, so the receipt and the rail cannot drift about what was copied, and the
            // response carries no second copy of the truncation rule.
            const view = phraseDetailView(store, requireStory(store, story.id), started.phrase.key);

            return c.json(
                {
                    story_id: story.id,
                    phrase_id: started.phrase.id,
                    key: started.phrase.key,
                    source,
                    seed_chars: view.seed_chars,
                    seed_head: view.seed_head,
                    started: started.started,
                    view
                },
                200
            );
        } catch (error) {
            return refusal(c, error);
        }
    });

    /**
     * R2 — the Author rewrites ONE group by hand.
     *
     * The same install the loop uses (`phrase/revisions.ts:installGroupRevisions`), so an Author edit
     * gets the identical guarantees: a new revision row at the group's next number, the text it replaces
     * archived and retained, the siblings untouched with their own numbers unchanged, the Overview
     * recomposed, and the legacy mirror rewritten in the SAME commit (R6).
     *
     * It deliberately claims to resolve NOTHING: `finding_refs` and `task_refs` stay off the row, so a
     * hand edit cannot close a finding on R3's evidence rule (that claim belongs to the pass that was
     * dispatched to answer the finding). A `summary_mode:'sampling'` book is a 409 rather than a
     * surprise: it has no group rows, and importing is an explicit decision (R6).
     */
    app.post('/stories/:id/phrases/groups/:groupId/revise', async (c) => {
        const store = bookOf(c);
        const story = storyOf(store, c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        // T-W3 — WHICH PHRASE this group belongs to is a read of the GROUP ROW, and the dial the verb asks is
        // that phrase's (`phrase/catalog.ts:isPhraseGroupManaged`), not the book's Summary switch. A chapter
        // entry is therefore writable on a book whose Summary is `sampling`, and a Summary section stays
        // writable on a book whose Phrase ② is `classic`. An id the book does not hold resolves to the
        // Summary's dial — see `phraseGateOf` — which is what keeps a legacy book's answer byte-identical: a
        // `sampling` book has no rows, so every id a stale rail sends still lands on the import sentence.
        const groupId = c.req.param('groupId');
        const { group, phraseKey } = phraseGateOf(store, story, groupId);

        if (!isPhraseGroupManaged(story, phraseKey)) {
            return errorResponse(c, 409, groupModeRefusal(story.id, phraseKey, 'R6'));
        }

        // 404 only once a REAL row could have answered: the gate above is about the book, this one is about
        // the address (the route's long-standing order, kept because a pinned test asserts 409-before-404).
        if (group === undefined) return missing(c, 'phrase group', groupId);

        const parsed = await readBody<PhraseGroupReviseBody>(c);

        if (!parsed.ok) return parsed.response;

        // THE TEXT, taken from the field THIS phrase writes. A Summary section's text is the Author's prose,
        // verbatim (R2). A chapter entry's text is a DERIVATION of its contract fields
        // (`phrase/plotpoints.ts:chapterEntryContent`), the same function the loop's install composes with,
        // so a hand edit and a Writer's answer leave one text — and the contract travels with it, because
        // `installGroupRevisions` refuses a plotlines entry with no plotpoints rather than mirroring a stale
        // `plotlines` row under new prose (P4). A `content` key beside `plotpoints` is not read.
        let content: string;
        let plotpoints: PlotpointFields | undefined;

        if (phraseKey === PHRASE_PLOTLINES_KEY) {
            const fields = plotpointsFromBody(parsed.body.plotpoints);

            if (fields === undefined) {
                return errorResponse(
                    c,
                    400,
                    '`plotpoints` is a chapter entry\'s text: `must_happen` and `must_change` must both be non-empty strings, and the entry\'s text and its `plotlines` contract are composed from them together (P4).'
                );
            }

            plotpoints = fields;
            content = chapterEntryContent(group, fields);
        } else {
            content = typeof parsed.body.content === 'string' ? parsed.body.content.trim() : '';

            if (content === '') {
                return errorResponse(
                    c,
                    400,
                    '`content` is the group\'s new text and must be a non-empty string (R2: an empty group text is a refusal, not a revision).'
                );
            }
        }

        const note = typeof parsed.body.note === 'string' ? parsed.body.note.trim() : '';

        // F8 / R4 — the Author's hand edit IS a Writer op on that group row: it installs a new revision
        // and archives the one it replaces. A live `draft_groups` run on the same group would install
        // over it (or be installed over) with neither pass having read the other's text, and R4 forbids
        // exactly that race for the loop's own writers. Refusing is honest where "last write wins" is
        // not: the group's history would keep both texts, but only one Overview, and nobody could say
        // which sentences the review actually read. The rail disables the button off the same read
        // (`projections.ts:writer_busy`), so a 409 here answers a request the UI already tried to stop.
        const holders = liveGroupWriters(store, story.id, groupId);

        if (holders.length > 0) {
            return errorResponse(
                c,
                409,
                `the Writer is rewriting ${group.key} right now (${holders
                    .map((run) => run.id)
                    .join(', ')}), so a hand edit would install over text it has not finished with — the same edit lands once that run closes (R4: one Writer op per group, and this route is one).`
            );
        }

        try {
            // Captured in the closure for the same reason as the import route above: `Store.commit`
            // returns nothing, and the install's per-group report is what the Author's rail needs to
            // show WHICH row is current now and which one moved into history (R2).
            let install: GroupInstallResult | undefined;

            await store.commit('phrase_group_revise', () => {
                install = installGroupRevisions(
                    store,
                    requireStory(store, story.id),
                    // The row is re-read INSIDE the commit (the CAS discipline every phrase verb uses), and
                    // `plotpoints` rides along only on the chapter leg — on a Summary section it is absent,
                    // which is what tells the install's sync there is no `plotlines` contract to write (P4).
                    [{ group: store.phraseGroups.require(groupId), content, ...(plotpoints === undefined ? {} : { plotpoints }) }],
                    authorAttr(
                        authorWhy(
                            'POST /stories/:id/phrases/groups/:groupId/revise',
                            story.id,
                            `${group.key} was rewritten by hand${note === '' ? '' : `: ${note}`} (R2)`
                        )
                    ),
                    // `runRef: null` is the honest attribution: no run produced this text. The install
                    // stamps it onto the revision row and onto the group's `updated_by`, so the rail can
                    // still tell an Author edit from a Writer pass.
                    { runRef: null }
                );
            });

            if (install === undefined) return refusal(c, new Error('the group install produced no result'));

            return c.json(
                {
                    story_id: story.id,
                    phrase_id: install.phrase.id,
                    revision: install.phrase.revision,
                    installed: install.installed.map((row) => ({
                        group_id: row.group_id,
                        group_key: row.group_key,
                        revision_id: row.id,
                        number: row.number
                    })),
                    archived: install.archived.map((row) => ({
                        group_id: row.group_id,
                        group_key: row.group_key,
                        revision_id: row.id,
                        number: row.number
                    })),
                    mirror: install.mirror,
                    // THE PHRASE THAT WAS WRITTEN answers, not the Summary by default: on a chapter entry the
                    // rail needs its own entry rows and its `brief`, and the pinned `PhraseView` shape stays
                    // reserved for the Summary's verbs.
                    view: phraseVerbView(store, requireStory(store, story.id), phraseKey)
                },
                200
            );
        } catch (error) {
            return refusal(c, error);
        }
    });

    /**
     * R1 — the Author locks ONE group in: its current text becomes settled content.
     *
     * WHAT THE ROUTE OWNS vs WHAT THE DOMAIN OWNS: this handler decides the ADDRESSING and the RACE — the
     * Story exists, the book is group-managed, the group is one of THIS Story's, no Writer is inside that
     * group — and then hands the decision to `phrase/locks.ts:lockPhraseGroup`, which owns every lock rule
     * (written text, not already locked, who may act) and the two writes (the group's four lock fields, and
     * the findings whose whole scope just became un-writable). Nothing is duplicated here on purpose: a
     * second copy of "is it lockable" is how the rail and the loop start disagreeing about what is settled.
     *
     * WHY THE LIVE-WRITER REFUSAL COMES BEFORE THE DOMAIN CALL: a lock fixes the revision that stands, and
     * a `draft_groups` pass in flight is about to replace it. Locking under that pass would freeze a text
     * nobody has read (and `installGroupRevisions` would then refuse the install, so the Writer's work would
     * be lost rather than deferred). The message names the run ids — the Author's next action is "wait for
     * that pass", not "guess" — and it is the SAME read the rail disables the button off
     * (`projections.ts:writer_busy`, F8/R4), so a greyed control and this 409 cannot disagree.
     *
     * THE ANSWER IS THE REVISE ROUTE'S ENVELOPE (R2/D-68): the fresh phrase `view` rides with the verdict, so
     * the rail's badge moves with the write rather than with a later poll. `voided_findings` is reported
     * because the lock just shortened the Author's queue, and an unexplained silence there reads as a bug.
     *
     * NO BODY: the verdict is "this text stands", and WHO made it is this route's own attribution (the
     * Author — the Editor's leg is the crew's tool surface, not the dashboard's), so a client has nothing
     * to assert about itself. A body that arrives is simply not read.
     */
    app.post('/stories/:id/phrases/groups/:groupId/lock', async (c) => {
        const store = bookOf(c);
        const story = storyOf(store, c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        // T-W3 — the gate is THIS group's phrase's dial (`phraseGateOf` resolves the row, then its kind), so a
        // chapter entry is lockable on a `sampling` Summary book and a Summary section stays lockable while
        // Phrase ② is classic. On the Summary leg the sentence, the tokens and the 409-before-404 order are
        // the pinned ones: a `sampling` book has no rows, so every id a stale rail sends still answers the
        // import sentence rather than a 404 about an id that could never exist here.
        const groupId = c.req.param('groupId');
        const { group, phraseKey } = phraseGateOf(store, story, groupId);

        if (!isPhraseGroupManaged(story, phraseKey)) {
            return errorResponse(c, 409, groupModeRefusal(story.id, phraseKey, 'R1, R6'));
        }

        // 404 for an address this book never minted, checked before any verb (the revise route's rule): a
        // typo must not reach a commit and come back as a 409 that reads like a refusal about real content.
        if (group === undefined) return missing(c, 'phrase group', groupId);

        const holders = liveGroupWriters(store, story.id, groupId);

        if (holders.length > 0) {
            return errorResponse(
                c,
                409,
                `the Writer is rewriting ${group.key} right now (${holders
                    .map((run) => run.id)
                    .join(', ')}), so a lock would fix text that has not finished moving — the same lock lands once that run closes (R1, R4).`
            );
        }

        try {
            // Captured in the closure because `Store.commit` answers "did it happen", and the lock's report
            // (the revision it fixed, who set it, the findings it voided) is what the rail prints. A throw
            // inside the commit rolls everything back, so `locked === undefined` is the only honest reading
            // of "nothing moved" — the route never claims a lock it did not write.
            let locked: PhraseLockResult | undefined;

            await store.commit('phrase_group_lock', () => {
                locked = lockPhraseGroup(
                    store,
                    requireStory(store, story.id),
                    groupId,
                    authorAttr(
                        authorWhy(
                            'POST /stories/:id/phrases/groups/:groupId/lock',
                            story.id,
                            `${group.key} revision ${group.revision} was locked in as settled content (R1)`
                        )
                    ),
                    // The Author's route, so the Author is the actor. The Editor's power
                    // (`Story.editor_group_locking`) is reached from the crew's own surface, never claimed
                    // by the dashboard's verb.
                    { actor: 'author' }
                );
            });

            if (locked === undefined) return refusal(c, new Error('the group lock produced no result'));

            // The read of the phrase the GROUP belongs to (T-W3): the lock badge on a chapter row lives on
            // the Plotlines rail, and that rail has no use for the Summary's five sections.
            const view = phraseVerbView(store, requireStory(store, story.id), phraseKey);

            return c.json(
                {
                    story_id: story.id,
                    ...(view.phrase_id === null ? {} : { phrase_id: view.phrase_id }),
                    group_id: groupId,
                    locked: true,
                    locked_revision: locked.locked_revision,
                    locked_by: locked.locked_by,
                    locked_at: locked.locked_at,
                    // The claims the lock made un-workable, with the state each one had before: the queue
                    // getting shorter without this list is the Author wondering whether the rail ate a finding.
                    voided_findings: locked.voided_findings,
                    view
                },
                200
            );
        } catch (error) {
            return refusal(c, error);
        }
    });

    /**
     * R1 — the Author lifts a group's lock. Author-only, whatever hand set the lock.
     *
     * WHY NO EDITOR PATH IS OFFERED HERE: `phrase/locks.ts:unlockPhraseGroup` refuses one outright
     * (`editor_unlock`) — a crew that just closed a defect must not sign the book back out — so the route
     * passing `'author'` is not a shortcut, it is the only actor this verb has. A client that calls this
     * route from the crew's leg is still refused by the domain when it goes through the tool surface.
     *
     * THE LIVE-WRITER GUARD IS NOT DEPTH FOR ITS OWN SAKE: the lock may be holding off an install that was
     * dispatched before the lock and is still in flight. Unlocking under that pass lets a text nobody has
     * reviewed land on the group the Author just reopened, in the same window — so the lock comes off once
     * the pass is done, which is also when the loop can offer the group again.
     *
     * An unlock writes no timestamp of its own (§4's row carries the LOCK's stamp), so the response answers
     * with the three metadata fields at `null`: the state the route left the group in, stated as the row
     * states it. Same `view` envelope as the lock and the revise routes.
     */
    app.post('/stories/:id/phrases/groups/:groupId/unlock', async (c) => {
        const store = bookOf(c);
        const story = storyOf(store, c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        // T-W3 — the same per-phrase gate as the lock verb, for the same reason: the flag is on a row of ONE
        // phrase, and the dial that makes it liftable is that phrase's. The Summary's sentence and tokens
        // stay byte-identical.
        const groupId = c.req.param('groupId');
        const { group, phraseKey } = phraseGateOf(store, story, groupId);

        if (!isPhraseGroupManaged(story, phraseKey)) {
            return errorResponse(c, 409, groupModeRefusal(story.id, phraseKey, 'R1, R6'));
        }

        if (group === undefined) return missing(c, 'phrase group', groupId);

        const holders = liveGroupWriters(store, story.id, groupId);

        if (holders.length > 0) {
            return errorResponse(
                c,
                409,
                `the Writer is rewriting ${group.key} right now (${holders
                    .map((run) => run.id)
                    .join(', ')}), so unlocking would open the group under a pass that has not installed its text — the lock comes off once that run closes (R1, R4).`
            );
        }

        try {
            let opened: PhraseUnlockResult | undefined;

            await store.commit('phrase_group_unlock', () => {
                opened = unlockPhraseGroup(
                    store,
                    requireStory(store, story.id),
                    groupId,
                    authorAttr(
                        authorWhy(
                            'POST /stories/:id/phrases/groups/:groupId/unlock',
                            story.id,
                            `${group.key} stopped being settled content and rejoined the loop (R1)`
                        )
                    ),
                    { actor: 'author' }
                );
            });

            if (opened === undefined) return refusal(c, new Error('the group unlock produced no result'));

            // The phrase the GROUP belongs to (T-W3) — same rule as on the lock verb.
            const view = phraseVerbView(store, requireStory(store, story.id), phraseKey);

            return c.json(
                {
                    story_id: story.id,
                    ...(view.phrase_id === null ? {} : { phrase_id: view.phrase_id }),
                    group_id: groupId,
                    locked: false,
                    // `null`, not absent: the route is saying "no live lock stands on this group", and the
                    // row itself carries nulls for exactly that reason (`locks.ts:unlockPhraseGroup`).
                    locked_revision: null,
                    locked_by: null,
                    locked_at: null,
                    view
                },
                200
            );
        } catch (error) {
            return refusal(c, error);
        }
    });

    /**
     * D-68 — the Author chooses the Reviewed Summary.
     *
     * WHAT IT DOES, in ONE commit (`phrase/reviewed.ts:chooseReviewedSummary`): installs the selected
     * text of every group as its next `latest` — the same install the loop and the hand-edit route use,
     * so the Overview recomposes from the rows and R6's legacy mirror is rewritten in the same commit —
     * marks every revision the choice passed over `discarded`, and records the chosen vector on the
     * Phrase row so the rail keeps showing the text the Author took after the pipeline moves on.
     *
     * WHAT IT DELIBERATELY DOES NOT DO: it does not lock the phase (choosing is not locking — the loop
     * keeps running and the next cross-group pass may yet find a defect in the chosen text), and it
     * claims to resolve nothing: the new rows carry no `finding_refs` and no `task_refs`, so R3's
     * closure rule is untouched, exactly as on the hand-edit route above. A choice is a decision about
     * the Summary, not evidence that a defect was fixed.
     *
     * THE REFUSALS are all 409s, because every one is a STATE of the book rather than a malformed body:
     *   - a `'sampling'` book has no group catalog, so there is nothing to choose (the import route is
     *     the Author's opt-in, R6);
     *   - no Reviewed Summary exists — some group has no clean revision, so the crew stands behind no
     *     text for it. The message names each group and the reason, which is the difference between the
     *     rail saying "not yet" and the Author knowing what to wait for; and
     *   - a live Writer holds any group. The choose reads the clean selection and installs under the
     *     Writer's feet, which is the R4 race the hand-edit route refuses one group at a time; here the
     *     choice writes five texts at once, so one live Writer anywhere is enough to refuse.
     */
    app.post('/stories/:id/phrases/reviewed/choose', async (c) => {
        const store = bookOf(c);
        const story = storyOf(store, c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        if (!isGroupManagedStory(story)) {
            return errorResponse(
                c,
                409,
                `this Story's Summary is still written as one text (no group catalog); POST /stories/${story.id}/phrases/import turns the flat Summary into groups first (R6, D-68).`
            );
        }

        const parsed = await readBody<{ note?: unknown }>(c);

        if (!parsed.ok) return parsed.response;

        const note = typeof parsed.body.note === 'string' ? parsed.body.note.trim() : '';

        // T-W3 — THE GATE AND THE SCAN ARE THE SUMMARY's, and now say so. With Phrase ② started on the same
        // book, an unscoped read would mix the chapter rows into the selection (`complete` would then demand
        // a clean CHAPTER selection too, so a book that merely also has chapters could never have a Reviewed
        // Summary) and would let a chapter Writer refuse the Summary's choose. Passing the Summary's phrase id
        // — even when the book has no Summary row at all, which is the legacy shape a pinned test asserts —
        // keeps this verb answering the one question it has always answered.
        const summaryPhraseId = storyPhraseByKey(store, story.id, PHRASE_SUMMARY_KEY)?.id;

        // THE GATE, read from the ONE function the scoring seat also arms on
        // (`phrase/reviewed.ts:cleanSelectionOf`). Checking it here instead of letting the domain call
        // throw keeps the refusal Author-shaped: the response lists the groups and says whether each one
        // is unwritten, has no clean revision, or is being held open by an unresolved issue. The domain
        // call still throws — the guard is for every other caller — but a route should not answer a 409
        // by formatting an exception.
        const selection = cleanSelectionOf(store, story, summaryPhraseId);

        if (!selection.complete) {
            return errorResponse(
                c,
                409,
                `this Story has no Reviewed Summary to choose: ${selection.gaps
                    .map((gap) => `${gap.group_key} (${gap.issues_open ? 'an unresolved issue names it' : gap.reason})`)
                    .join(', ')} — a group joins the reviewed Overview only once a cross-group Critic pass closes with no unresolved defect on it (D-67, D-68).`
            );
        }

        // R4, across the whole choice: the run ids travel in the message because the Author's next action
        // is "wait for that run", and the read is the one the rail's disabled button uses
        // (`projections.ts:reviewed.writer_busy`), so a greyed-out control and this 409 agree.
        const holders = new Set<string>();

        // SCOPED TO THE SUMMARY's entries (T-W3): a live CHAPTER pass is not a Writer inside the reviewed
        // Overview, and refusing the Summary's choose for it would be a 409 the Author cannot act on.
        for (const group of phraseGroupsOf(store, story.id, summaryPhraseId)) {
            for (const run of liveGroupWriters(store, story.id, group.id)) holders.add(run.id);
        }

        if (holders.size > 0) {
            return errorResponse(
                c,
                409,
                `the Writer is rewriting part of ${phraseEntryNoun(PHRASE_SUMMARY_KEY)} right now (${[...holders].join(', ')}), so choosing the reviewed Overview would install under a pass that has not finished — the same choice lands once those runs close (R4, D-68).`
            );
        }

        try {
            // Captured in the closure because `Store.commit` returns nothing and the choose's report is
            // what the rail shows: which five rows are current now, which rows the choice set aside, and
            // whether the legacy mirror moved (R6).
            let chosen: ReviewedChooseResult | undefined;

            await store.commit('phrase_reviewed_choose', () => {
                chosen = chooseReviewedSummary(
                    store,
                    requireStory(store, story.id),
                    authorAttr(
                        authorWhy(
                            'POST /stories/:id/phrases/reviewed/choose',
                            story.id,
                            `the reviewed Overview at vector ${selection.vector_hash} was chosen${note === '' ? '' : `: ${note}`} (D-68)`
                        )
                    )
                );
            });

            if (chosen === undefined) return refusal(c, new Error('the reviewed-Summary choose produced no result'));

            return c.json(
                {
                    story_id: story.id,
                    phrase_id: chosen.phrase.id,
                    revision: chosen.phrase.revision,
                    vector: chosen.chosen.vector,
                    vector_hash: chosen.chosen.vector_hash,
                    at: chosen.chosen.at,
                    overview: chosen.chosen.overview,
                    installed: chosen.installed.map((row) => ({
                        group_id: row.group_id,
                        group_key: row.group_key,
                        revision_id: row.id,
                        number: row.number
                    })),
                    // The rows the choice set aside. They are RETAINED (a finding they closed stays
                    // `fixed`), which is why the response reports them rather than the commit silently
                    // deleting them — the Author's rail lists what was passed over, and R3's join can
                    // still walk it.
                    discarded: chosen.discarded.map((row) => ({
                        group_id: row.group_id,
                        group_key: row.group_key,
                        revision_id: row.id,
                        number: row.number
                    })),
                    sources: chosen.chosen.sources,
                    mirror: chosen.mirror,
                    view: phraseView(store, requireStory(store, story.id))
                },
                200
            );
        } catch (error) {
            return refusal(c, error);
        }
    });

    /**
     * U-10a/U-16/U-4 — the four Author edits that live on the Story row. Each keeps its own engine verb
     * where one exists: the Seed is a backtrack (`editSeed`, D-25a) and the count is a growth/shrink
     * decision (`changeChapterCount`, D-3c); the title and the dial are plain row edits.
     */
    app.patch('/stories/:id', async (c) => {
        // S-RUNTIME: the book this Story lives in, shadowing the deps store for the rest of the handler.
        const store = bookOf(c);
        const story = storyOf(store, c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        const parsed = await readBody<StoryPatchBody>(c);

        if (!parsed.ok) return parsed.response;

        const body = parsed.body;
        const hasEdit =
            body.title !== undefined ||
            body.idea !== undefined ||
            body.chapter_count !== undefined ||
            body.auto_approve !== undefined ||
            body.summary_sampling !== undefined ||
            body.summary_critics !== undefined ||
            // R1 — the Editor-locking Setting is a field this verb knows. The refusal sentence below is
            // deliberately NOT widened to name it: that copy is pinned verbatim (L-13, the Author reads it
            // as the list of verbs), and a body that carries THIS field with the wrong type gets the
            // field's own 400 one line later, which is the accurate sentence for that mistake.
            body.editor_group_locking !== undefined ||
            // T-W3 — Phrase ②'s dial, for the same reason and with the same pinned sentence left alone: a
            // body carrying `plotlines_mode` IS a field this verb knows (so it must clear the `hasEdit`
            // gate), and its own 400/409 name it one line later.
            body.plotlines_mode !== undefined;

        if (!hasEdit)
            return errorResponse(
                c,
                400,
                'PATCH /stories/:id got no field it knows: title, idea, chapter_count, auto_approve, summary_sampling, summary_critics (D-35, D-17d).'
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

        for (const [field, value] of [
            ['summary_sampling', body.summary_sampling],
            ['summary_critics', body.summary_critics]
        ] as const) {
            if (
                value !== undefined &&
                (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > SUMMARY_REVIEW_LIMIT)
            ) {
                return errorResponse(
                    c,
                    400,
                    `\`${field}\` must be a whole number from 1 to ${SUMMARY_REVIEW_LIMIT} (D-17d/D-38a: the count is the Author's setting).`
                );
            }
        }

        // R1 — the Editor-locking Setting is a BOOLEAN, not a truthy blob: the Setting's whole effect is a
        // yes/no permission (`phrase/locks.ts:editorGroupLockingEnabled` reads `=== true`), so a string
        // `"false"` arriving here would otherwise store a value the domain reads as ON. Absent is handled
        // by the `hasEdit` gate and the spread below (leave it alone), so only a PRESENT value is checked.
        if (body.editor_group_locking !== undefined && typeof body.editor_group_locking !== 'boolean') {
            return errorResponse(
                c,
                400,
                '`editor_group_locking` must be a boolean: true lets the Editor lock a phrase group, false takes that power back, and omitting it leaves the Story as it is (R1).'
            );
        }

        // PHRASE ②'s dial (T-W3): the same two words, each naming a pipeline, so the same strict validation.
        if (
            body.plotlines_mode !== undefined &&
            body.plotlines_mode !== 'groups' &&
            body.plotlines_mode !== 'classic'
        ) {
            return errorResponse(
                c,
                400,
                "`plotlines_mode` must be 'groups' (the chapter entries) or 'classic' (the plotline tools); omitting it leaves the Story as it is (R11)."
            );
        }

        // THE START GATE (P4, and the one field on this row with a start-time rule): a started Phrase ② owns
        // its copied seed, its entries and its claim-family keys, and the lane the loop writes into is
        // decided by this dial FROM THEN ON. Moving it afterwards would leave a phrase whose entries are
        // written by a pipeline nobody chose — so the dial is Author-movable exactly while the row does not
        // exist, and the 409 names the row that made it unmovable.
        //
        // A value equal to the effective one is NOT refused: it is a no-op the rail can send by re-PUTting the
        // row it read, and refusing a write that changes nothing would make an idempotent client fail. The
        // effective value is `story.plotlines_mode ?? 'classic'`, the same reading the projection and the
        // gate predicate use (R6 applied to this dial: an absent field is the old pipeline, never a silently-open phrase).
        if (body.plotlines_mode !== undefined && (story.plotlines_mode ?? 'classic') !== body.plotlines_mode) {
            const plotlinesPhrase = storyPhraseByKey(store, story.id, PHRASE_PLOTLINES_KEY);

            if (plotlinesPhrase !== undefined) {
                return errorResponse(
                    c,
                    409,
                    `this Story's Plotlines Phrase is already started (${plotlinesPhrase.id}), so \`plotlines_mode\` no longer moves: its copied seed, its chapter entries and its claim keys were written under the pipeline that was chosen at the start, and switching lanes now would leave entries nobody chose (P4).`
                );
            }
        }

        return verb(c, story.id, async () => {
            if (
                body.title !== undefined ||
                body.auto_approve !== undefined ||
                body.summary_sampling !== undefined ||
                body.summary_critics !== undefined ||
                body.editor_group_locking !== undefined ||
                // T-W3 — Phrase ②'s dial rides on the same row edit: it is a Story-row Setting like the dial
                // and the locking permission, not an engine verb, and `idea`/`chapter_count` keep their own
                // engine legs below.
                body.plotlines_mode !== undefined
            ) {
                await store.commit('patch_story', () => {
                    const fresh = requireStory(store, story.id);

                    store.stories.update(
                        fresh.id,
                        {
                            ...(body.title === undefined ? {} : { title: body.title as string }),
                            ...(body.auto_approve === undefined ? {} : { auto_approve: body.auto_approve as Cost[] }),
                            ...(body.summary_sampling === undefined
                                ? {}
                                : { summary_sampling: body.summary_sampling as number }),
                            ...(body.summary_critics === undefined
                                ? {}
                                : { summary_critics: body.summary_critics as number }),
                            // R1 — the Setting travels as the boolean the route validated. `false` is a
                            // WRITE, not an absence: the store's patch merges through JSON, so `false` lands
                            // and disables (the Editor's lock power is `=== true`), while an absent key never
                            // reaches this object at all.
                            ...(body.editor_group_locking === undefined
                                ? {}
                                : { editor_group_locking: body.editor_group_locking as boolean }),
                            // T-W3 — one of the two words, validated above, written as the Author named it.
                            // This branch is reached only when the value DIFFERS from the effective one or the
                            // phrase is un-started, so a stored `plotlines_mode` always says which pipeline the
                            // Author chose rather than repeating a default the row never needed.
                            ...(body.plotlines_mode === undefined
                                ? {}
                                : { plotlines_mode: body.plotlines_mode as 'groups' | 'classic' })
                        },
                        authorAttr(
                            authorWhy(
                                'PATCH /stories/:id',
                                story.id,
                                body.auto_approve !== undefined
                                    ? `the dial is now [${(body.auto_approve as string[]).join(', ')}] (D-35)`
                                    : body.title !== undefined
                                      ? 'title'
                                      : // R1 — its own journal line, because "the Editor may lock a group"
                                        // is a permission the Author granted or took back, and a future read
                                        // of the journal has to say which.
                                        body.editor_group_locking !== undefined
                                        ? `the Editor may${body.editor_group_locking === true ? '' : ' not'} lock a phrase group (R1)`
                                        : // T-W3 — its own journal line, because "Phrase ② writes its chapters
                                          // as entries" vs "the plotline tools still write the contracts" is a
                                          // decision about who writes a whole phase, and a future read of the
                                          // journal has to say which way the Author moved it and when.
                                          body.plotlines_mode !== undefined
                                          ? `Phrase ② now writes ${body.plotlines_mode === 'groups' ? 'its chapter entries' : 'its plotlines through the classic tools'} (R11)`
                                          : `phase ① now samples ${body.summary_sampling ?? 'the existing'} Writers with ${body.summary_critics ?? 'the existing'} Critics per draft`
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

    /**
     * §10 / P1 — delete a Story and everything its harness owns.
     *
     * One call, one owner: `purgeStory` (the coordinator's `StoryRuntimes.removeStory`) pauses the Story so
     * no sweep starts a run behind the delete, kills and settles the runs in flight, deletes the §4 rows and
     * disposes the harness session in the engine's one commit, prunes the retained thread log, removes and
     * closes the Story's knowledge projection, takes the runtime out of the set, and only then closes the
     * book and removes `<root>/stories/<uuid>/` — `store.json`, `journal.jsonl` and the whole `harness/`
     * directory with it. A restarted workspace therefore never reopens a Story the Author deleted (§10, P1).
     *
     * Nothing else moves: the app book at `<root>/server/` keeps its catalogue, roster and ceiling, and every
     * sibling Story keeps its own folder, journal, threads and rows. The receipt names the Story that is gone.
     */
    app.delete('/stories/:id', async (c) => {
        // S-RUNTIME: the book this Story lives in; `storyOf` answering `undefined` is the 404 this layer
        // owns, checked before any verb so a typo cannot reach a teardown and answer 409.
        const story = storyOf(bookOf(c), c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        try {
            await purgeStory(story.id);
        } catch (error) {
            return refusal(c, error);
        }

        return c.json({ deleted: story.id }, 200);
    });

    /** D-37 / U-17 — Pause & edit: the only thing that opens the prose pane. */
    app.post('/stories/:id/stop', (c) => {
        // S-RUNTIME: the book this Story lives in, shadowing the deps store for the rest of the handler.
        const store = bookOf(c);
        const story = storyOf(store, c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        return verb(c, story.id, () => engine.pauseStory(story.id));
    });

    /** D-37a/D-37b — the hand-back: re-derives the Digest and marks dependents for recheck. */
    app.post('/stories/:id/resume', (c) => {
        // S-RUNTIME: the book this Story lives in, shadowing the deps store for the rest of the handler.
        const store = bookOf(c);
        const story = storyOf(store, c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        return verb(c, story.id, () => engine.resumeStory(story.id));
    });

    /**
     * Phase ①'s "not final yet": the Author asks for another round of three Summary drafts.
     * It queues a rewrite task on the selected Summary; nothing is deleted, and the next sweep
     * dispatches the writers. Accepting instead is the ordinary phase lock.
     */
    app.post('/stories/:id/summary/revise', async (c) => {
        // S-RUNTIME: the book this Story lives in, shadowing the deps store for the rest of the handler.
        const store = bookOf(c);
        const story = storyOf(store, c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        // F6 / R5 — the verb queues a rewrite task on the selected Summary, and the ONLY thing that ever
        // consumed one was the whole-Summary sampler. A group-managed book has no sampler, so the task
        // would sit open forever: the rail would show work nobody can do, and the Author would wait for
        // a round that cannot arrive. Refusing names the verb that DOES exist; translating it into
        // "rewrite all five groups" would be a bigger claim than the Author made (they asked for another
        // round, not for five new drafts), and R2's whole point is that one rewrite touches one group.
        if (isGroupManagedStory(story)) {
            return errorResponse(
                c,
                409,
                `this Story's Summary is written group by group, so there is no whole-Summary round to ask for — a Writer result installs when it is accepted, and one group is rewritten with POST /stories/${story.id}/phrases/groups/:groupId/revise (R2, R5).`
            );
        }

        const parsed = await readBody<NoteBody>(c);

        if (!parsed.ok) return parsed.response;

        const note = typeof parsed.body.note === 'string' ? parsed.body.note : '';

        return verb(c, story.id, () => engine.requestSummaryRevision(story.id, note));
    });

    /** L-36 / U-1b — the one click that clears the tasks keeping a `pending` Story waiting. */
    app.post('/stories/:id/clear-pending', (c) => {
        // S-RUNTIME: the book this Story lives in, shadowing the deps store for the rest of the handler.
        const store = bookOf(c);
        const story = storyOf(store, c.req.param('id'));

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
     *
     * NEITHER GATE MENTIONS FINDINGS OR TASKS, and T12 left that alone on purpose: accepting a Summary was
     * never gated on a clean queue (L-25b — "completion does not require an empty findings list"). What the
     * accept DOES about the queue is the engine's, in the lock commit: the Summary phrase's open findings
     * are voided and its open tasks go `wontfix` (R3), and the counts ride back on `lock_receipt` because
     * L-25b asks for the count to be "recorded and shown", not for a gate that hides the work.
     *
     * THE RESPONSE IS THE STORY ROW PLUS `lock_receipt` (additive — every row field is byte-stable, so
     * `dashboard/api.ts:lockPhase`'s `StoryRow` keeps working): the accept has leftovers to declare, and a
     * client that has to re-read the rail to find out what the button did is a client that shows the Author
     * a queue that just emptied without saying why.
     *
     * PHASE ① ALSO STARTS PHRASE ② (R4) — see `startPlotlinesFromAcceptedSummary`: a second commit, after
     * the lock, seeded from `projections.ts:compiledSummaryOf`, reported rather than thrown. A
     * `plotlines`/`chapters` lock starts nothing and says nothing about Phrase ②.
     */
    app.post('/stories/:id/lock', async (c) => {
        // S-RUNTIME: the book this Story lives in, shadowing the deps store for the rest of the handler.
        const store = bookOf(c);
        const story = storyOf(store, c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        const phase = story.phase;
        let lock: PhaseLockReceipt = { deleted_ideas: 0, next_phase: null };
        let accepted: PhraseAcceptStart | undefined;

        try {
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

            lock = await engine.lockPhase(story.id, phase);

            // R4, strictly AFTER the lock: a start that is refused leaves a locked Summary and an honest
            // receipt, so it runs outside the lock's commit and its throw is caught, not re-thrown.
            accepted = phase === 'summary' ? await startPlotlinesFromAcceptedSummary(store, story.id) : undefined;
        } catch (error) {
            return refusal(c, error);
        }

        // The same row `verb` answers with, read from the Story's own book after both commits.
        const book = bookOfId(story.id);

        return c.json(
            {
                ...storyRow(projections(book), book.stories.require(story.id)),
                // WHAT THE ACCEPT DID, as one object so a legacy client that ignores it is unaffected and a
                // new one reads the counts and the Phrase ② answer from a single place. `voided_findings`
                // and `wontfixed_tasks` are ABSENT on a plotlines/chapters lock (that leg voids nothing);
                // `phrase_started`/`phrase_start_reason` likewise, and `phrase_started: false` on the
                // summary leg means a no-op with the reason beside it — never a failed lock.
                lock_receipt: {
                    phase,
                    deleted_ideas: lock.deleted_ideas,
                    next_phase: lock.next_phase,
                    ...(lock.voided_findings === undefined ? {} : { voided_findings: lock.voided_findings }),
                    ...(lock.wontfixed_tasks === undefined ? {} : { wontfixed_tasks: lock.wontfixed_tasks }),
                    ...(accepted === undefined ? {} : accepted)
                }
            },
            200
        );
    });

    /** L-31/L-32 — the only way a lock opens; the client confirms first and the engine does the scrap. */
    app.post('/stories/:id/backtrack', async (c) => {
        // S-RUNTIME: the book this Story lives in, shadowing the deps store for the rest of the handler.
        const store = bookOf(c);
        const story = storyOf(store, c.req.param('id'));

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
        // S-RUNTIME: the book this Story lives in, shadowing the deps store for the rest of the handler.
        const store = bookOf(c);
        const story = storyOf(store, c.req.param('id'));

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
        // S-RUNTIME: the book this Story lives in, shadowing the deps store for the rest of the handler.
        const store = bookOf(c);
        const story = storyOf(store, c.req.param('id'));

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

        // D-33d — the bulk approve passes through the same issues-first rule the single approve does
        // (`engine.approveFinding` throws it, `tools/editor.ts:approveFinding` refuses it, the dial
        // skips it, and `raiseFinding` will not file over an open issue — D-33c). Here it is a SKIP
        // rather than a refusal on purpose: U-10b's whole point is that the Author clears a stalled
        // chapter in one click, and a 409 raised by the first proposal in the batch would abort the
        // ISSUES the rule wants approved first.
        //
        // `approved` is NOT `resolved` — an approved issue still has a Writer in front of it — so the
        // issues this same batch approves do not unlock the proposals in it. The proposal stays
        // `confirmed`, still in the Author's queue, and the next click (or the next sweep) takes it
        // once every issue has left the holding set (`records.ts:isOpenIssueFinding` — `fixed`,
        // `discarded` or `disputed`, the last of them needing no Author tap at all).
        //
        // The route's shape is unchanged: the journal shows one approve per finding approved and none
        // for a skipped row, and the projected Story row still lists the proposal as awaiting
        // approval, which IS the report.
        const batchIssues = openIssueFindings(store, story.id);
        const approved =
            batchIssues.length === 0 ? targets : targets.filter((candidate) => candidate.kind !== 'proposal');

        try {
            for (const finding of approved) await engine.approveFinding(finding.id, { by: 'author', note: why });
        } catch (error) {
            return refusal(c, error);
        }

        // S-RUNTIME: the row is projected from the Story's own book (the shadowed `store`).
        return c.json(storyRow(projections(store), store.stories.require(story.id)), 200);
    });

    /**
     * D-34 — the discard. No engine verb exists for it (delta 2), so the state move happens here with
     * Author attribution; `discarded` is one of `CLOSED_FINDING_STATES` (loop/types.ts), which is exactly
     * what L-15a/L-16a read, so loop detection sees the closure without any further bookkeeping.
     */
    app.post('/stories/:id/findings/:findingId/discard', async (c) => {
        // S-RUNTIME: the book this Story lives in, shadowing the deps store for the rest of the handler.
        const store = bookOf(c);
        const story = storyOf(store, c.req.param('id'));

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
        // S-RUNTIME: the book this Story lives in, shadowing the deps store for the rest of the handler.
        const store = bookOf(c);
        const story = storyOf(store, c.req.param('id'));

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
        // S-RUNTIME: the book this Story lives in (the route factories take a plain `Context`).
        const store = bookOf(c);
        const story = storyOf(store, param(c, 'id'));

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
        // S-RUNTIME: the book this Story lives in, shadowing the deps store for the rest of the handler.
        const store = bookOf(c);
        const story = storyOf(store, c.req.param('id'));

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

        // S-RUNTIME: the row is projected from the Story's own book (the shadowed `store`).
        return c.json(storyRow(projections(store), store.stories.require(story.id)), 200);
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
     * so an Author's choice and a Reader's choice cannot render two different texts).
     *
     * D-22's commit discipline holds: install, mark `selected`, delete every sibling draft in ONE
     * commit, so no fresh run can see two texts for one unit. No §7 row is consulted — this is a
     * direct Author write, attributed `author: true` with no run behind it (D-20a).
     */
    app.post('/stories/:id/revisions/:revisionId/select', async (c) => {
        // S-RUNTIME: the book this Story lives in, shadowing the deps store for the rest of the handler.
        const store = bookOf(c);
        const story = storyOf(store, c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        // SUMMARY PHRASE R5/R6: the same refusal as `revisions/merge`, narrowed to the Summary unit for
        // the same reason — a group-managed book still runs phases ②/③, where competing chapter drafts
        // and the Author's choice between them remain the design. Only the Summary stopped having a
        // draft set: an accepted Writer result installs on acceptance and its predecessor is archived in
        // the same commit, so a Summary select would install a `revisions` row the loop never reads.
        const draft = store.revisions.get(c.req.param('revisionId'));

        if (draft === undefined || draft.story_id !== story.id)
            return missing(c, 'revision', c.req.param('revisionId'));

        if (isGroupManagedStory(story) && draft.unit_kind === 'summary') {
            return errorResponse(
                c,
                409,
                `this Story's Summary is written group by group, so there is no Summary draft set to select from — a Writer result is installed when it is accepted, and the Author edits one group with POST /stories/${story.id}/phrases/groups/:groupId/revise (R5, R6).`
            );
        }

        const parsed = await readBody<RevisionSelectBody>(c);

        if (!parsed.ok) return parsed.response;

        // L-13: the note is the sentence the next run reads in the draft's `selection_note`, so a bare
        // click still has to say who chose — that is the default, and the Author may type their own.
        const authorNote = typeof parsed.body.note === 'string' ? parsed.body.note.trim() : '';
        const note = authorNote.length > 0 ? authorNote : 'selected by the Author (D-24)';

        // §4.15: a `pending` draft is still being written by its Writer. Installing it would make
        // the Summary the half-filled text its own Writer has not finished — the Author's override
        // is a choice between DRAFTS, not a way to skip the completeness gate.
        if (draft.state === 'pending') {
            return errorResponse(
                c,
                409,
                `revision ${draft.id} is still pending — its Writer has not finished it, so there is nothing complete to install yet (§4.15)`
            );
        }

        const unit = revisionUnit(story.id, draft.unit_ref);

        if (unit === undefined) return missing(c, 'unit', draft.unit_ref);

        try {
            await store.commit('author_revision_select', () => {
                const decision = `the Author selected ${draft.id} for ${draft.unit_ref} (D-24, U-13)`;
                const attribution = authorAttr(decision);
                // R1: a row this selection sets aside needs its own reason in the row, so the rail can
                // say why it is `discarded`. The Author's own sentence when they typed one; otherwise
                // the attribution sentence naming this decision — never blank, and never words the
                // Author did not supply. `note` itself is the winner's `selection_note` (T-2a) and its
                // default is unchanged, so `note` stays optional on the wire.
                const discardReason = authorNote.length > 0 ? authorNote : decision;

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

                // D-22 / P13: losing drafts leave the unit in the same commit. For a Summary they
                // are KEPT as `discarded` history — the Revision 1…N rail is the Author's record of
                // what the round tried. Every other unit still deletes hard, as D-22 requires.
                const losing: string[] = [];

                for (const sibling of store.revisions
                    .list()
                    .filter(
                        (row) =>
                            row.story_id === story.id &&
                            row.unit_kind === draft.unit_kind &&
                            row.unit_ref === draft.unit_ref &&
                            row.id !== draft.id
                    )) {
                    if (draft.unit_kind === 'summary') {
                        losing.push(sibling.id);
                        store.revisions.update(
                            sibling.id,
                            { state: 'discarded', discard_reason: discardReason },
                            attribution,
                            [{ id: sibling.id, rev: sibling.rev }]
                        );
                    } else {
                        store.revisions.delete(sibling.id, attribution, [{ id: sibling.id, rev: sibling.rev }]);
                    }
                }

                if (draft.unit_kind === 'summary') {
                    const loserIds = new Set(losing);

                    for (const finding of store.findings.list()) {
                        if (finding.story_id !== story.id) continue;
                        if (
                            finding.state !== 'unconfirmed' &&
                            finding.state !== 'confirmed' &&
                            finding.state !== 'approved'
                        )
                            continue;
                        if (!(finding.related_refs ?? []).some((ref) => loserIds.has(ref))) continue;

                        store.findings.update(finding.id, { state: 'discarded' }, attribution);

                        for (const task of store.tasks.list()) {
                            if (task.story_id !== story.id || task.finding_ref !== finding.id) continue;
                            if (task.state !== 'open' && task.state !== 'claimed') continue;
                            store.tasks.update(task.id, { state: 'wontfix' }, attribution);
                        }
                    }

                    for (const task of store.tasks.list()) {
                        if (task.story_id !== story.id || task.kind !== 'merge') continue;
                        if (task.state !== 'open' && task.state !== 'claimed') continue;
                        if (task.detail?.includes(draft.unit_ref) !== true && !task.title.includes(draft.unit_ref))
                            continue;
                        store.tasks.update(task.id, { state: 'wontfix' }, attribution);
                    }
                }
            });
        } catch (error) {
            return refusal(c, error);
        }

        // S-RUNTIME: the row is projected from the Story's own book (the shadowed `store`).
        return c.json(storyRow(projections(store), store.stories.require(story.id)), 200);
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
        // S-RUNTIME: the book this Story lives in, shadowing the deps store for the rest of the handler.
        const store = bookOf(c);
        const story = storyOf(store, c.req.param('id'));

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

            // SUMMARY PHRASE R5/R6: the same refusal as `revisions/:id/select`, narrowed to the Summary
            // unit — a group-managed book still writes chapters and plotlines through phases ②/③, where
            // competing drafts and D-23's merge remain the design. Only the Summary stopped having a
            // draft set, so only a Summary merge is a question this book cannot answer.
            if (isGroupManagedStory(story) && draft.unit_kind === 'summary') {
                return errorResponse(
                    c,
                    409,
                    `this Story's Summary is written group by group, so there are no Summary drafts to merge — its text is the group vector, and the Author rewrites one group with POST /stories/${story.id}/phrases/groups/:groupId/revise (R5, R6).`
                );
            }

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
                        // and a Reader's into one row (T-24's no-progress signal counts once).
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

        // S-RUNTIME: the row is projected from the Story's own book (the shadowed `store`).
        return c.json(storyRow(projections(store), store.stories.require(story.id)), 200);
    });

    /** L-10 — the Author's word outranks the criteria: the chapter wakes the crew. */
    app.post('/stories/:id/chapters/:chapterId/unapprove', (c) => {
        // S-RUNTIME: the book this Story lives in, shadowing the deps store for the rest of the handler.
        const store = bookOf(c);
        const story = storyOf(store, c.req.param('id'));

        if (story === undefined) return missing(c, 'story', c.req.param('id'));

        const chapter = store.chapters.get(c.req.param('chapterId'));

        if (chapter === undefined || chapter.story_id !== story.id)
            return missing(c, 'chapter', c.req.param('chapterId'));

        return verb(c, story.id, () => engine.unapproveChapter(chapter.id));
    });

    /** G-1 / §14 item 2 — the per-chapter bar, as the one text field §4.4 stores. */
    app.patch('/stories/:id/chapters/:chapterId/bar', async (c) => {
        // S-RUNTIME: the book this Story lives in, shadowing the deps store for the rest of the handler.
        const store = bookOf(c);
        const story = storyOf(store, c.req.param('id'));

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
        // S-RUNTIME: the book this Story lives in (the route factories take a plain `Context`).
        const store = bookOf(c);
        const story = storyOf(store, param(c, 'id'));

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
        // S-RUNTIME: the book this Story lives in, shadowing the deps store for the rest of the handler.
        const store = bookOf(c);
        const story = storyOf(store, c.req.param('id'));

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

    /**
     * U-9 / D-19 — one line addressed to the Editor. It records a `directives` row and the server's
     * propagation starts at once; the Editor's review thread queues the tasks on the next sweep.
     * Not a chat.
     */
    app.post('/stories/:id/directives', async (c) => {
        // S-RUNTIME: the book this Story lives in, shadowing the deps store for the rest of the handler.
        const store = bookOf(c);
        const story = storyOf(store, c.req.param('id'));

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

        if (
            parsed.body.refs !== undefined &&
            (!Array.isArray(parsed.body.refs) || parsed.body.refs.some((ref) => typeof ref !== 'string'))
        ) {
            return errorResponse(
                c,
                400,
                '`refs` must be a list of artifact ids — the pane the Author was looking at (U-9, D-19).'
            );
        }

        return verb(c, story.id, () =>
            engine.processDirective(
                story.id,
                parsed.body.text as string,
                (parsed.body.refs as string[] | undefined) ?? []
            )
        );
    });

    /**
     * U-13 / L-25b / L-26 — accepting completion, with the discard count the preview promised. The engine
     * also owns the "declined" branch (L-30); the dashboard's route is the accept, and a Story that has
     * nothing proposed is a 409 from the engine's own words.
     */
    app.post('/stories/:id/complete', (c) => {
        // S-RUNTIME: the book this Story lives in, shadowing the deps store for the rest of the handler.
        const store = bookOf(c);
        const story = storyOf(store, c.req.param('id'));

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
        // S-RUNTIME: the book this Story lives in, shadowing the deps store for the rest of the handler.
        const store = bookOf(c);
        const story = storyOf(store, c.req.param('id'));

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

        // S-RUNTIME: the row is projected from the Story's own book (the shadowed `store`).
        return c.json(storyRow(projections(store), store.stories.require(story.id)), 200);
    });

    /**
     * U-6 / G-1 — the Goal panel's write. Delta 3: the engine replaces the criteria list wholesale, so
     * the pinned ORDERED OPS are folded into the Story's evaluated criteria here.
     */
    app.patch('/stories/:id/goal', async (c) => {
        // S-RUNTIME: the book this Story lives in, shadowing the deps store for the rest of the handler.
        const store = bookOf(c);
        const story = storyOf(store, c.req.param('id'));

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
        return c.json(goalSurface(projections(store), store.stories.require(story.id)), 200);
    });

    /**
     * §8.6 — "Ask assistant" from a locked pane. Not a chat: the answer is an artifact change made by a
     * real run, so the response is the RUN ROW (U-7's crew panel is where the Author watches it).
     */
    app.post('/stories/:id/assistant', async (c) => {
        // S-RUNTIME: the book this Story lives in, shadowing the deps store for the rest of the handler.
        const store = bookOf(c);
        const story = storyOf(store, c.req.param('id'));

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

        // S-RUNTIME: the Author's ask spawns THROUGH THE STORY'S OWN executor. `RunExecutor` writes its run
        // row into the book it was built over, and in the workspace shape `deps.executor` is built over the APP
        // book (`<root>/server/`), which holds no Story to attach the run to: spawning there produced a row no
        // Story book could read, and this route answered 409 for a run that had in fact started. In the
        // single-store shape there is one executor and this is the one the route always used.
        const spawner =
            runtimes?.contexts_().find((context: StoryRuntimeContext) => context.store === store)?.executor ??
            executor;

        try {
            // Fire-and-forget ON PURPOSE: `RunExecutor.execute` creates the run row synchronously before
            // its first await (D-18: the row exists before the first token so Stop has something to point
            // at), so the row can be read back here while the run works behind the response. The run
            // closes its own row in `finally` whatever happens (S-3), so nothing may be thrown by dropping
            // the promise.
            if (spawner !== undefined) {
                const running = spawner.execute(item);

                running.catch(() => undefined);
                run = store.runs.list().find((candidate) => candidate.work_item_ref === item.id);
            }
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
    /**
     * U-8's roster as the Author sees it: the harness projection, sorted ALPHABETICALLY by employee
     * kind — Critic, Editor, Reader, Researcher, Writer.
     *
     * WHY THE SORT LIVES HERE (T12/F1): the harness projects the roster in CATALOGUE order (Writer,
     * Editor, Critic, Reader, Researcher), which is a registration order and carries no meaning for
     * the Author. U-8 and the design document say the roster lists alphabetically, and the order is a
     * presentation question, so the route sorts a copy of the projection — the harness keeps its own
     * order for every other caller (`GET /agents/:kind/threads`, the run catalogue).
     *
     * ONE function for GET and PATCH, because `PATCH /agents/:kind` promises to answer "the same
     * projection `GET /agents` answers": two sorts would let the tiles re-order under the Author's
     * click.
     */
    /**
     * The roster, merged across books (S-RUNTIME). One harness per book (`run/story-engine.ts` is built
     * over one store), so the five tiles are the merge of what each book's harness reports — an employee is
     * `running` if it has a live thread in ANY Story, and the threads keep their `story_id` so a click can
     * still scope to the Story that ran it.
     *
     * THE EMPTY WORKSPACE STILL HAS A ROSTER: the five employees come from the catalogue, not from a Story,
     * and U-8 says the Author sees them without selecting a Story. A workspace with no book open has no
     * per-Story harness to ask, so the app-level harness (`deps.executor.harness`, built over the app book's
     * catalogue) answers the tiles idle — which is the same answer the single-store shape always gave.
     */
    const agentRoster = () =>
        mergeAgentStatuses(
            runtimes !== undefined && runtimes.contexts_().length > 0
                ? runtimes.contexts_().map((context: StoryRuntimeContext) => context.executor.harness.statuses())
                : [deps.executor?.harness.statuses() ?? []]
        ).sort((left, right) => left.kind.localeCompare(right.kind));

    /**
     * U-8 — the GLOBAL employee roster, alphabetically (see `agentRoster`). Each row carries every
     * live engine thread that employee is currently running as an agent, across every Story, with the
     * Story title and phase session. No Story has to be selected, and no thread has to be running,
     * for the Author to see the roster.
     */
    app.get('/agents', (c) => c.json(agentRoster(), 200));

    /**
     * U-8 — the threads one employee ran, across every Story and every phrase session, oldest
     * first. The employee tile opens this in the content area: each bar is one engine thread, its
     * `request` and `answer` are the detail, and nothing is pruned from the retained log.
     */
    app.get('/agents/:kind/threads', (c) => {
        const kind = param(c, 'kind');

        if (!isAgentKind(kind)) {
            return errorResponse(
                c,
                404,
                `no agent named "${kind}" — the global roster is writer, editor, reader, critic and researcher (U-8).`
            );
        }

        // S-RUNTIME: one book's threads are already correct for that book (its run-row folding keys on
        // book-local run ids, and its retained log is the file under that Story's own `harness/`). The
        // aggregate is the merge of those answers, oldest first, keyed by `story_id` + `thread_id` so two
        // Stories' `run_7` bars stay two bars.
        const perBook =
            runtimes !== undefined
                ? runtimes.contexts_().map((context: StoryRuntimeContext) =>
                      agentThreads(
                          context.store,
                          kind,
                          context.executor.harness.threads(kind),
                          context.threadLog.list(kind)
                      )
                  )
                : [agentThreads(store, kind, deps.executor?.harness.threads(kind) ?? [], deps.threadLog.list(kind))];

        return c.json({ kind, threads: agentThreadsAcross(perBook) }, 200);
    });

    /**
     * U-8 — the model catalog the roster's dropdown offers. The harness engine dials one provider
     * root (the env triple's base URL, default `http://localhost:8800/providers/private/v1`), and its
     * OpenAI-compatible catalog is `GET {base}/models`. The dashboard never asks the browser to reach
     * that origin directly: one origin, and a provider that is down becomes this server's sentence
     * (L-13) rather than an unreadable cross-origin failure.
     */
    app.get('/agents/models', async (c) => {
        try {
            const catalog = await listProviderModels({
                baseUrl: deps.providerBaseUrl,
                ...(deps.providerApiKey === undefined ? {} : { apiKey: deps.providerApiKey }),
                ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl })
            });

            return c.json(catalog, 200);
        } catch (error) {
            // 502, not 409: the provider is outside this server, so the request was not refused by a
            // Storyline rule — the upstream that owns the catalog did not answer.
            return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
        }
    });

    /**
     * U-8 — the Author sets which model one global employee asks for. The roster is not a §4 record:
     * the choice is a host setting beside the book, and the response is the same projection
     * `GET /agents` answers, so the tile can show the new model in the frame the click lands.
     *
     * `model: null` clears the choice, returning the employee to its template role model, else the
     * process model (T-6b); an empty or missing string is a 400 rather than a silent clear, because
     * a typo must not unset a running configuration. A template role that names its own model is
     * listed on the tile, so the Author knows what a clear would fall back to.
     */
    app.patch('/agents/:kind', async (c) => {
        const kind = param(c, 'kind');

        if (!isAgentKind(kind)) {
            return errorResponse(
                c,
                404,
                `no agent named "${kind}" — the global roster is writer, editor, reader, critic and researcher (U-8).`
            );
        }

        const parsed = await readBody<AgentModelBody>(c);

        if (!parsed.ok) return parsed.response;

        if (!('model' in parsed.body)) {
            return errorResponse(
                c,
                400,
                '`model` is required — send a model name, or null to clear the agent’s choice (T-6b).'
            );
        }

        const model = parsed.body.model;

        if (model !== null && (typeof model !== 'string' || model.trim().length === 0)) {
            return errorResponse(
                c,
                400,
                '`model` must be a non-empty string, or null to clear the agent’s choice (T-6b).'
            );
        }

        try {
            setAgentModel(store, kind, model);
        } catch (error) {
            return refusal(c, error);
        }

        // S-RUNTIME: the roster is host configuration and lives in the app book; each Story's runtime reads
        // its OWN copy (that is what an agent's turn actually resolves), so the write is mirrored.
        await synced();

        // The SAME projection GET /agents answers — including its alphabetical order (T12/F1).
        return c.json(agentRoster(), 200);
    });

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

            // S-RUNTIME: the catalogue is APP configuration — the same row is handed to every Story's
            // context, so it is written to the app book and mirrored, never into one Story's journal.
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

            await synced();

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

            await synced();

            return c.json(row, 200);
        } catch (error) {
            return refusal(c, error);
        }
    });

    /**
     * U-7 — the crew panel. `story_id` omitted lists every Story's runs.
     *
     * S-RUNTIME: books in book order, each book's rows in their own order — deliberately NOT re-sorted,
     * because the panel is a list of run rows and run ids are local to a book: two Stories' `run_7` are two
     * rows, distinguished by the `story_id` the caller filtered on or the row itself carries.
     */
    app.get('/runs', (c) => {
        const storyId = c.req.query('story_id');

        return c.json(runsAcross(books(), storyId), 200);
    });

    /**
     * P8 / U-7 — the Author's cord. `RunExecutor.kill` aborts the run's own controller and the row closes
     * in the executor's `finally` (S-3: teardown is unconditional), so the row returned here is the
     * `killed`-in-flight row; the `runs` SSE event carries the closed one a moment later.
     *
     * S-RUNTIME: a run id is LOCAL to one book, so the route finds the book that holds the row and stops the
     * run THROUGH THAT BOOK's executor — the executor owns the controller map of the runs it started, and a
     * sibling's executor killing `run_7` would abort another Story's thread. Three answers:
     *
     *   * `?story_id=` given — that Story's executor, exactly, and a Story the workspace does not hold is
     *     the same 404 the single-book shape answers;
     *   * no scope and exactly one book holds the id — the kill is unambiguous, so it stays valid (a
     *     workspace with one Story, and every host that predates the scope);
     *   * no scope and SEVERAL books hold the id — 409, and nothing is killed. Guessing by book order used
     *     to abort whichever `run_0` happened to be first, with a 200 and the other Story none the wiser.
     */
    app.post('/runs/:runId/kill', (c) => {
        const runId = c.req.param('runId');
        const scope = c.req.query('story_id');
        const found = bookOfRun(runId, scope);

        if (found === undefined) return missing(c, 'run', runId);

        if (found === AMBIGUOUS) {
            return errorResponse(
                c,
                409,
                `\`run ${runId}\` is a Story-local id and more than one Story in this workspace holds it, while the ` +
                    'request named none — send `?story_id=` with the Story the run belongs to, so the kill stops that ' +
                    'thread and no other (S-RUNTIME: one book per Story).'
            );
        }

        const { store: book, executor: owner } = found;

        owner.kill(runId);

        return c.json(
            book.runs.get(runId) ?? book.runs.list().find((run) => run.id === runId) ?? { id: runId, story_id: found.storyId },
            200
        );
    });

    /**
     * U-10 — the cross-Story desk, the dashboard's home screen.
     *
     * S-RUNTIME: every book's desk, in `queueOrder` (Story, then creation, then row id). The item's id is
     * local to its Story, and every row already carries `story_id`, so a `finding_0` from one Story and a
     * `finding_0` from another stay two clickable rows — which is the whole reason the merge is per book.
     */
    app.get('/queue', (c) => c.json(queueItemsAcross(books()), 200));

    // -------------------------------------------------------------------------
    // The loop's own ceiling (S-5)
    // -------------------------------------------------------------------------

    /**
     * S-5 — the loop's live fan-out ceiling, and how many of those slots a thread occupies right now.
     * This is the one engine setting the Author may move from the workstation: it is not a §4 record
     * (the ceiling belongs to the process, not to a Story), so it has no Story row to PATCH and the
     * projection here is the only read of it.
     */
    // S-RUNTIME: the live count is the sum over every book, because the ceiling is one number for the whole
    // workspace and the tile that shows it is a workspace tile. The shape of the response is unchanged.
    const loopSettings = () => ({
        global_max_concurrent: runtimes !== undefined ? runtimes.ceilingView.limit : engine.config.globalMaxConcurrent,
        live_runs: runtimes !== undefined ? runtimes.liveRuns() : liveRuns(store).length
    });

    app.get('/loop', (c) => c.json(loopSettings(), 200));

    /**
     * S-5 — moving the ceiling. One field, so one 400 sentence: the value has to be a whole number of
     * threads, and `0` is not one (a ceiling of zero would leave the sweep with nothing to dispatch and
     * no way to say why). Lowering it cancels no run: the runs in flight finish and the loop stops
     * claiming new ones until the live count falls under it, which is the same courtesy a Story stop
     * pays (L-10).
     */
    app.patch('/loop', async (c) => {
        const parsed = await readBody<LoopSettingsBody>(c);

        if (!parsed.ok) return parsed.response;

        if (!('global_max_concurrent' in parsed.body)) {
            return errorResponse(
                c,
                400,
                '`global_max_concurrent` is required — send the number of threads the loop may run at once (S-5).'
            );
        }

        const limit = parsed.body.global_max_concurrent;

        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
            return errorResponse(
                c,
                400,
                '`global_max_concurrent` must be a whole number of threads, at least 1 — it is the hard cap on simultaneous runs (S-5).'
            );
        }

        try {
            engine.setGlobalMaxConcurrent(limit);
            // And remembered, so the ceiling survives the restart the Author will eventually cause:
            // this is host configuration, not a fact about the book, so it rides the store's `settings`
            // section and never the journal — the same seam the roster's model choices use (U-8).
            rememberGlobalMaxConcurrent(store, limit);
            // S-RUNTIME: one ceiling for the whole workspace, so the number is mirrored into every context's
            // book too — each engine reads its OWN setting, and a context created next minute reads the
            // app book. `setGlobalMaxConcurrent` has already moved the shared counter and every engine's copy.
            await synced();
        } catch (error) {
            return refusal(c, error);
        }

        // The SAME projection GET /loop answers, so the control re-renders from the server's number
        // rather than from what the Author typed (P1: the server is the memory).
        return c.json(loopSettings(), 200);
    });

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

            // S-RUNTIME: every book, including the ones created while this stream is open. A Story created
            // after the client connected would otherwise be a pane that never moves until the Author
            // reloaded, and the dashboard's own fallback (a 5s poll, L-24) would mask that for days.
            // The frame's Story id is derived from the events themselves (`projections.ts:feedEvents`), which
            // is the id the writing book owns, so a shared feed still says which Story moved.
            const unsubscribe =
                runtimes !== undefined
                    ? runtimes.subscribeCommits((commit) => {
                          for (const frame of feedEvents([...commit.events])) queue.push(frame);

                          if (timer === undefined) timer = setTimeout(() => void flush(), debounceMs);
                      })
                    : store.onCommit((events) => {
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
