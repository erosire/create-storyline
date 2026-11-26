// S-RUNTIME — one runtime per Story, and the one place that knows how many there are.
//
// WHAT THIS OWNS. Since P1 a Story is a directory (`store/story-stores.ts`), and a Story-bound `Store`
// refuses a record whose `story_id` is not its own. A `Store` is not the only per-Story memory:
//
//   * the loop engine keeps the runs THIS process started, its round-boundary counters and its sweep
//     timer (`loop/engine.ts`);
//   * the run executor keeps the run controllers it started, and the engine-harness sessions beside them
//     (`run/executor.ts`, `run/story-engine.ts`);
//   * the knowledge projection writes a nine-article directory for every Story it can see
//     (`knowledge/story-knowledge.ts`);
//   * the thread log appends the request/answer history of the threads one Story ran
//     (`run/thread-log.ts`);
//   * the §8 tool catalogue is bound to one book, so a tool write cannot land in another Story's rows
//     (`tools/context.ts:createToolRuntime`).
//
// Those are five per-Story objects, and before this module each was ONE object over a shared book — which
// is how one Story's `finding_0` could answer for another Story's, how one Story's sweep timer drove
// another Story's work, and how a `--store-root` of two Stories shared one knowledge directory and one
// thread file. A `StoryRuntimeContext` bundles those five per Story; `StoryRuntimes` owns the set and the
// three things that must stay singular: the sweep timer, the fan-out ceiling (`runtime/ceiling.ts`) and
// the app configuration every new book is seeded from (`runtime/server-config.ts`).
//
// WHY A COORDINATOR RATHER THAN "HANDLERS RESOLVE THE STORE THEMSELVES". A handler could look up the book
// and call an engine on it — but it would still not know who owns the sweep timer, the shared ceiling, the
// SSE fan-in or the catalogue seeding, and each of those wants exactly one owner. So the coordinator also
// implements `EngineApi` (the `engine` the route table holds): every verb names its Story, and the Story
// id chooses which context runs it. A foreign Story id resolves to no context, which is the HTTP face of
// the same rule the store enforces with its `story_id` fence (`store/store.ts:_assertStoryScope`).
//
// TWO MODES, ONE SURFACE.
//   * REGISTRY MODE (the shipped server): a `StoryStores` registry, one context per open book, opened
//     asynchronously at boot so a restart recovers every Story — each engine abandons the orphaned runs in
//     its own book the moment it is constructed (L-3).
//   * SINGLE-STORE MODE: a `Store` handed in directly (`Store.empty()`, or an aggregate book an embed
//     owns). One context over that book, no registry, no book creation. Every route and server test builds
//     this today, and it is why the loop's isolation rules have to be real rather than incidental: in one
//     book holding several Stories, `loop/records.ts` and `loop/work.ts` scope a claim, a budget and a
//     retry counter to the Story that OWNS the local id. The registry makes the same rule unbreakable.
import { LoopEngine } from '../loop/engine';
import { GlobalCeiling } from './ceiling';
import { ServerConfig } from './server-config';
import { CriteriaEngine } from '../criteria/engine';
import { DigestBuilder } from '../digest/digest';
import { RunExecutor } from '../run/executor';
import { StoryKnowledge } from '../knowledge';
import { StoryThreadLog } from '../run/thread-log';
import { createToolRuntime } from '../tools/context';
import { StoryStores, type StoryCommit, type StoryEntry } from '../store/story-stores';
import { StoryLayoutError } from '../store/persist';
import { liveRuns } from '../loop/records';
import {
    DEFAULT_GLOBAL_MAX_CONCURRENT,
    DEFAULT_LEASE_IDLE_MS,
    DEFAULT_SWEEP_INTERVAL_MS,
    type ResolvedEngineConfig
} from '../loop/types';
import type { ChatClient } from '../llm/client';
// `StoryPhase` is a §4 shared record type, not an engine type: the engine's own module re-exports nothing.
import type { Cost, StoryPhase } from '../../shared/types';
import type { Store } from '../store';
import type {
    AssignTemplatesResult,
    ChapterCountResult,
    CreateStoryInput,
    DirectiveReport,
    EngineApi,
    GoalPatch,
    LoopEngineConfig,
    // T12 — the lock's receipt, forwarded verbatim: the per-Story runtime owns no part of the answer, and
    // the Author's accept reads the same fields whichever topology the server runs under.
    PhaseLockReceipt,
    SweepReport
} from '../loop/types';
import type { StoryHarnessManager } from '../run/story-engine';
import type { ToolRuntime } from '../run/types';

/**
 * The story id a single-store context reports when the book is not story-bound. It is a real map key, not
 * a wildcard: `contextOf` only answers for a Story the injected book actually holds.
 */
export const SHARED_STORE_ID = '';

/** One Story's whole runtime: the five per-Story objects, plus where its files live. */
export interface StoryRuntimeContext {
    /** The Story this context belongs to, or `SHARED_STORE_ID` for a book that is not story-bound. */
    readonly storyId: string;
    /** The Story's directory (`<root>/stories/<uuid>/`), or `null` when nothing is persisted. */
    readonly root: string | null;
    /** The book this Story IS (P1). */
    readonly store: Store;
    /** This Story's loop: its own in-flight runs, its own counters, never a shared sweep timer. */
    readonly engine: LoopEngine;
    /** This Story's run layer: the run controllers it started, and the harness registry beside them. */
    readonly executor: RunExecutor;
    /** The §8 tool catalogue bound to this book. */
    readonly runtime: ToolRuntime;
    /** The nine-article knowledge projection, under `<root>/harness/knowledge/`. */
    readonly knowledge: StoryKnowledge;
    /** The retained threads, under `<root>/harness/threads.jsonl`. */
    readonly threadLog: StoryThreadLog;
    /** The engine-harness sessions of this book (`run/story-engine.ts`). */
    readonly harness: StoryHarnessManager;
}

/** The ceiling as the dashboard reads it: the one number, what is running under it, over how many books. */
export interface CeilingView {
    limit: number;
    live_runs: number;
    stories: number;
}

export interface StoryRuntimesOptions {
    /**
     * REGISTRY MODE: the open books, normally `await StoryStores.open(root)`. With neither this nor
     * `store`, an in-memory registry is used (`--store-root ""`), which behaves identically and writes
     * nothing.
     */
    stories?: StoryStores;
    /** The app book: the crew catalogue and the host settings every new Story is seeded with. */
    config?: ServerConfig;
    /**
     * SINGLE-STORE MODE: a book the caller owns, story-bound or not. It wins over `stories`, and no new
     * book is ever created — `createStory` runs on this store, which is what the route tests assume.
     */
    store?: Store;
    /** The model transport. A built context needs one; a pre-supplied `executor`/`engine` does not. */
    chat?: ChatClient;
    /** The model every run defaults to when its crew names none (T-6b). */
    defaultModel?: string;
    /**
     * Sweep settings. `autoSweep` gates the workspace's ONE timer (`start()`); a per-Story engine is always
     * built with its own timer off, so the flag means "the coordinator schedules", never "each Story
     * schedules". Omitting it keeps L-1's default — a started loop sweeps — and an explicit `false` hands the
     * clock to the caller, which still drives every sweep by hand (`sweep()` stays callable, because closing
     * the timer does not close the per-Story scheduling gates).
     */
    engineConfig?: LoopEngineConfig;
    /** Passed to `createToolRuntime` so a test never touches the network (§8.5's web tools). */
    fetchImpl?: typeof fetch;
    /** A pre-built run layer, used verbatim for the single-store context (the route tests inject one). */
    executor?: RunExecutor;
    /** A pre-built loop, used verbatim for the single-store context. */
    engine?: LoopEngine;
    /** The §8 tool catalogue, when the caller built one (`adopt`; a built context makes its own). */
    runtime?: ToolRuntime;
    /** The knowledge projection, when the caller opened one (`adopt`; a built context opens its own). */
    knowledge?: StoryKnowledge;
    /** The retained thread log, when the caller opened one (`adopt`). */
    threadLog?: StoryThreadLog;
    /** Where a single-store context's harness files go; a registry context always uses its own book. */
    harnessRoot?: string | null;
    /** Called with every commit of every book, tagged with the Story it happened in. */
    onCommit?: (commit: StoryCommit) => void;
}

/**
 * Folds the per-book passes into the one pass the workspace ran (`StoryRuntimes.sweep`).
 *
 * `stories` is CONCATENATED, never deduped: each entry is one Story and carries its own `story_id`, so two
 * books' `finding_0` stay two entries. The counters sum, because the ceiling that produced them is one number
 * for the whole workspace (S-5). With no book swept the shape stays the shape — an empty story list — so a
 * caller never has to branch on "is this one report or a list of them".
 */
function mergeSweepReports(reports: readonly SweepReport[]): SweepReport {
    if (reports.length === 0) {
        return {
            at: new Date().toISOString(),
            stories: [],
            runs_started: 0,
            runs_finished: 0,
            leases_lapsed: [],
            skipped: false
        };
    }

    return {
        // The first book's timestamp is the pass's: every book was swept after it and before the last.
        at: reports[0]!.at,
        stories: reports.flatMap((report) => report.stories),
        runs_started: reports.reduce((total, report) => total + report.runs_started, 0),
        runs_finished: reports.reduce((total, report) => total + report.runs_finished, 0),
        leases_lapsed: reports.flatMap((report) => report.leases_lapsed),
        // "Skipped" means the loop switch refused the sweep; with books swept, that is only true when EVERY
        // book refused, which is the same answer one engine gives.
        skipped: reports.every((report) => report.skipped)
    };
}

/**
 * The set of Story runtimes, and the loop the HTTP layer talks to.
 *
 * Lifetime: `await StoryRuntimes.open(options)` → requests and sweeps → `close()`. A new Story is created
 * through `createStory`, which allocates the book FIRST (the registry owns story identity, and the folder
 * name is the id the engine's Story row must carry) and only then builds the runtime over it, so a failed
 * build cannot leave a half-open Story that restarts as a book the Author never asked for. Its mirror is
 * `removeStory`, the one path that takes a Story out again — runs, rows, harness, projection, threads,
 * registry entry and folder — so a deleted Story never restarts as a ghost book either.
 */
export class StoryRuntimes implements EngineApi {
    /** The app book this workspace configures itself from (`runtime/server-config.ts`). */
    readonly appConfig: ServerConfig;

    private readonly contexts = new Map<string, StoryRuntimeContext>();
    private readonly order: string[] = [];

    /** The registry, or `null` in single-store mode. */
    private readonly registry: StoryStores | null;
    /** The injected book, or `null` in registry mode. */
    private readonly shared: Store | null;

    /** The one ceiling, shared by every context's sweep (`runtime/ceiling.ts`). */
    private readonly ceiling: GlobalCeiling;

    /** The criteria engine and the Digest builder are pure over the rows they are handed (L-3): one each. */
    private readonly criteria = new CriteriaEngine();
    private readonly digest = new DigestBuilder();

    private readonly chat?: ChatClient;
    private readonly defaultModel: string;
    private readonly engineConfig: LoopEngineConfig;
    private readonly fetchImpl?: typeof fetch;
    private readonly injectedExecutor?: RunExecutor;
    private readonly injectedEngine?: LoopEngine;
    private readonly harnessRoot: string | null;
    private readonly commitSink?: (commit: StoryCommit) => void;

    /** The one sweep timer for the workspace: contexts never schedule; the coordinator drives. */
    private timer: ReturnType<typeof setInterval> | undefined;
    private running = false;
    private sweeping: Promise<SweepReport> | undefined;
    private unsubscribe: (() => void) | null = null;
    private closed = false;

    private constructor(options: StoryRuntimesOptions, config: ServerConfig) {
        this.shared = options.store ?? null;
        this.registry = this.shared === null ? (options.stories ?? null) : null;
        this.appConfig = config;
        this.chat = options.chat;
        this.defaultModel = options.defaultModel ?? '';
        this.engineConfig = { ...options.engineConfig };
        this.fetchImpl = options.fetchImpl;
        this.injectedExecutor = options.executor;
        this.injectedEngine = options.engine;
        this.harnessRoot = options.harnessRoot ?? this.shared?.rootDir ?? null;
        this.commitSink = options.onCommit;

        // S-5's one number, in the precedence `loop/ceiling.ts` states minus the env pin (which the caller
        // applies by passing `engineConfig.globalMaxConcurrent`): an injected config outranks an embed's
        // test, the Author's stored rail choice outranks the shipped standard.
        const resolved =
            options.engineConfig?.globalMaxConcurrent ?? config.getGlobalMaxConcurrent() ?? DEFAULT_GLOBAL_MAX_CONCURRENT;

        this.ceiling = new GlobalCeiling(resolved);
    }

    // -----------------------------------------------------------------------
    // Boot
    // -----------------------------------------------------------------------

    /**
     * Opens every existing Story: each book is seeded from the app configuration, then gets its own
     * runtime, in book order.
     *
     * The catalogue is seeded into the APP book first, because that is where the Author's own crews live
     * and where `/templates` writes; each Story book then receives a copy (`ServerConfig.applyTo`).
     */
    static async open(options: StoryRuntimesOptions = {}): Promise<StoryRuntimes> {
        const runtimes = new StoryRuntimes(options, options.config ?? ServerConfig.inMemory());

        runtimes.appConfig.seedCatalogue();

        for (const entry of runtimes.bookEntries()) await runtimes.register(entry);

        // The fan-in attaches after the existing books (a boot must not replay old commits) and covers
        // books created later — which is what one SSE feed over all Stories needs. A single store keeps its
        // own `Store.onCommit`, which is what the route table already subscribes to.
        if (runtimes.commitSink !== undefined && runtimes.registry !== null) {
            const sink = runtimes.commitSink;

            runtimes.unsubscribe = runtimes.registry.onCommit((commit) => sink(commit));
        }

        return runtimes;
    }

    /**
     * ADOPT mode — the synchronous single-store composition, for an embed and for every route test.
     *
     * `open()` is async for one reason: a durable knowledge projection has to be loaded. A caller that
     * already holds its pieces (the server's `buildStorylineRuntime`, which injects the store, the
     * executor, the engine, the projection and the thread log) needs no awaits at all, and a sync surface
     * is what keeps that function's shape — and the tests built on it — unchanged.
     *
     * It builds exactly ONE context over the store handed in, adopts the injected pieces verbatim, and
     * leaves the store's ownership with the caller: the coordinator still routes by Story id, still shares
     * one ceiling, and still refuses a Story the book does not hold.
     */
    static adopt(options: StoryRuntimesOptions & { store: Store }): StoryRuntimes {
        const runtimes = new StoryRuntimes(options, options.config ?? ServerConfig.inMemory());

        if (options.store === undefined) throw new StoryLayoutError('StoryRuntimes.adopt needs a store');

        // The catalogue goes into the app book only when the caller gave us an app book; an injected store
        // that already carries its rows (a test fixture) keeps them, because `seedCatalogue` is idempotent
        // by name and `applyTo` is additive.
        if (options.config !== undefined) runtimes.appConfig.seedCatalogue();

        const entry = runtimes.bookEntries()[0];
        const context = runtimes.buildSync(entry, options);

        runtimes.contexts.set(entry.id, context);
        runtimes.order.push(entry.id);
        runtimes.ceiling.attach(() => runtimes.liveRuns());

        return runtimes;
    }

    /** The sync sibling of `build`: every piece is already open, so nothing here awaits. */
    private buildSync(entry: StoryEntry, options: StoryRuntimesOptions): StoryRuntimeContext {
        const { id, root, store } = entry;

        if (options.config !== undefined) this.appConfig.applyTo(store);

        const knowledge = options.knowledge ?? StoryKnowledge.memory(store);
        const threadLog = options.threadLog ?? StoryThreadLog.memory();
        const runtime =
            options.runtime ?? createToolRuntime(store, this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl });

        if (this.injectedExecutor === undefined || this.injectedEngine === undefined) {
            throw new StoryLayoutError('StoryRuntimes.adopt needs an injected `executor` and `engine`');
        }

        return {
            storyId: id,
            root: root ?? this.harnessRoot,
            store,
            engine: this.injectedEngine,
            executor: this.injectedExecutor,
            runtime,
            knowledge,
            threadLog,
            harness: this.injectedExecutor.harness
        };
    }

    /** The books to build contexts for: every open book, or the one the caller handed in. */
    private bookEntries(): StoryEntry[] {
        if (this.shared !== null) {
            // A story-bound book reports its Story; an aggregate book reports none, and its single context
            // is keyed by `SHARED_STORE_ID` (`contextOf` still resolves a Story id the book holds).
            return [{ id: this.shared.storyId ?? SHARED_STORE_ID, root: this.shared.rootDir, store: this.shared }];
        }

        return this.registry?.list() ?? [];
    }

    // -----------------------------------------------------------------------
    // The set
    // -----------------------------------------------------------------------

    /** Every context, in book order (the registry loads folders sorted by story id). */
    contexts_(): StoryRuntimeContext[] {
        return this.order.map((id) => this.contexts.get(id) as StoryRuntimeContext);
    }

    /** How many runtimes are open. */
    count(): number {
        return this.order.length;
    }

    /** The open books, in the order the Stories panel lists them. */
    books(): StoryEntry[] {
        return this.registry !== null ? this.registry.list() : this.bookEntries();
    }

    /**
     * The context a Story belongs to.
     *
     * Registry mode is exact: one book per Story, and an id from another root is a MISS. Single-store mode
     * answers with the one context ONLY when the injected book holds that Story — because "the store is the
     * memory" means an unknown id has to be a 404, not a call into some other Story's rows.
     */
    contextOf(storyId: unknown): StoryRuntimeContext | undefined {
        if (typeof storyId !== 'string') return undefined;

        const direct = this.contexts.get(storyId);

        if (direct !== undefined) return direct;

        if (this.shared === null || storyId === SHARED_STORE_ID) return undefined;

        const shared = this.contexts.get(SHARED_STORE_ID);

        return shared !== undefined && shared.store.stories.get(storyId) !== undefined ? shared : undefined;
    }

    /** The context a Story belongs to, or the error every caller would otherwise have to invent. */
    requires(storyId: unknown): StoryRuntimeContext {
        const context = this.contextOf(storyId);

        if (context !== undefined) return context;

        throw new StoryLayoutError(
            `no story ${typeof storyId === 'string' ? storyId : String(storyId)} has a runtime here — every Story is ` +
                `its own stories/<uuid>/ book, and an id from another book has no runtime to act in`
        );
    }

    /** The book a request acts on: that Story's own, or the injected single store. */
    storeFor(storyId: unknown): Store | undefined {
        return this.contextOf(storyId)?.store;
    }

    /** Every distinct book (single-store mode has one; registry mode has one per Story). */
    stores(): Store[] {
        return [...new Set(this.contexts_().map((context) => context.store))];
    }

    /**
     * Subscribes to every book's commits — the open ones AND the ones created later — and returns the
     * unsubscribe. This is what one SSE feed over all Stories attaches to: a per-store `Store.onCommit`
     * would miss the next Story the Author creates, which is a stream that goes quite silently dead.
     *
     * The commit arrives tagged with the Story it happened in (`story-stores.ts:StoryCommit`), because two
     * books both journal `finding_0` at `seq` 1 and a shared feed has to say which one moved.
     */
    subscribeCommits(listener: (commit: StoryCommit) => void): () => void {
        if (this.registry !== null) return this.registry.onCommit(listener);

        // Single-store mode has one journal and one Story tag — the book's own, which for an unbound store is
        // `SHARED_STORE_ID`, exactly the key `contextOf` answers on.
        const shared = this.shared as Store;

        return shared.onCommit((events) =>
            listener({ storyId: shared.storyId ?? SHARED_STORE_ID, root: shared.rootDir, events })
        );
    }

    /** The shared ceiling, for the routes that report or move it. */
    get ceilingView(): CeilingView {
        return { limit: this.ceiling.limit(), live_runs: this.liveRuns(), stories: this.count() };
    }

    /**
     * The config shape `/loop` reads. Under a coordinator the ceiling is the shared number, so the engine
     * config a caller passed is the cadence and the lease only — and `globalMaxConcurrent` reports what the
     * sweep actually fills against, not what a config object happens to hold.
     *
     * `autoSweep: false` here is the PER-STORY answer and stays false whatever the caller asked for: no
     * context's `LoopEngine` ever owns a timer (`build` forces it off, and `loop/engine.ts:241` is the only
     * place that flag is read). Whether the WORKSPACE schedules is a different question, answered by
     * `engineConfig.autoSweep` in `start()` — do not read it back out of this shape.
     */
    get config(): ResolvedEngineConfig {
        return {
            globalMaxConcurrent: this.ceiling.limit(),
            sweepIntervalMs: this.engineConfig.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS,
            leaseIdleMs: this.engineConfig.leaseIdleMs ?? DEFAULT_LEASE_IDLE_MS,
            autoSweep: false
        };
    }

    // -----------------------------------------------------------------------
    // Building one context
    // -----------------------------------------------------------------------

    /**
     * Builds the five per-Story objects over one book.
     *
     * The ORDER is load-bearing. The app configuration lands in the book first, because the engine seeds
     * crews into the book it is given (`loop/engine.ts:createStory`) and `assignTemplates` resolves crew
     * rows out of the SAME store — a Story whose book lacks the Author's crews cannot be assigned them.
     * The knowledge projection and the thread log then open INSIDE the Story's directory, which is where
     * the per-Story file layout comes from: `StoryKnowledge.open(store, dir)` writes `<dir>/harness/
     * knowledge/`, `StoryThreadLog.open(dir)` appends `<dir>/harness/threads.jsonl`.
     *
     * `autoSweep: false` is forced per context: with a timer per Story, N books sweep on N independent
     * schedules and the shared ceiling never gets to arbitrate between them (`start()` owns the one timer).
     */
    private async build(entry: StoryEntry): Promise<StoryRuntimeContext> {
        const { id, root, store } = entry;
        const single = this.shared !== null;

        // A brand-new book starts with the app's crews and host settings (non-journaled, idempotent).
        this.appConfig.applyTo(store);

        // A registry context roots its files in its own book; a single-store context uses the root the
        // caller named (`harnessRoot`), which is what keeps an embedded host's directory choices its own.
        const files = single ? this.harnessRoot : root;

        const knowledge = await StoryKnowledge.open(store, files);
        const threadLog = StoryThreadLog.open(files);
        const runtime = createToolRuntime(store, this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl });

        let executor = this.injectedExecutor;
        let engine = this.injectedEngine;

        if (executor === undefined) {
            if (this.chat === undefined) {
                // A run has to talk to somebody. The shipped server always passes a transport; a caller
                // that supplies its own executor (the route tests) never reaches this branch.
                throw new StoryLayoutError('a Story runtime needs a `chat` transport or an injected `executor`');
            }

            executor = new RunExecutor({
                store,
                runtime,
                chat: this.chat,
                defaultModel: this.defaultModel,
                ...(threadLog === undefined ? {} : { threadLog })
            });
        }

        if (engine === undefined) {
            engine = new LoopEngine({
                store,
                executor,
                criteria: this.criteria,
                digest: this.digest,
                ceiling: this.ceiling,
                config: { ...this.engineConfig, autoSweep: false }
            });
        }

        return {
            storyId: id,
            root: single ? this.harnessRoot : root,
            store,
            engine,
            executor,
            runtime,
            knowledge,
            threadLog,
            harness: executor.harness
        };
    }

    /** Adds a context, keeping the insertion order the listings read, and refreshes the ceiling's counter. */
    private async register(entry: StoryEntry): Promise<StoryRuntimeContext> {
        const context = await this.build(entry);

        this.contexts.set(entry.id, context);

        if (!this.order.includes(entry.id)) this.order.push(entry.id);

        // A Story created while the workspace is running joins the running loop (D-1: the Author's next
        // Story works without a restart); one created while it is stopped joins it stopped, which is what
        // the sweep's per-Story gate reads. The context's own sweep timer is off (`build` forces
        // `autoSweep: false`), so this only flips the Story's scheduling flag — the workspace's one timer
        // stays the only clock, and an injected engine is expected to be built the same way.
        if (this.running) context.engine.start();

        // The live count is what the shared ceiling compares its limit against, so the ceiling recomputes it
        // from the open books on every read — never a number that has to be remembered (`ceiling.ts`).
        this.ceiling.attach(() => this.liveRuns());

        return context;
    }

    // -----------------------------------------------------------------------
    // The Story lifecycle
    // -----------------------------------------------------------------------

    /**
     * Creates a Story: the registry allocates `<root>/stories/<uuid>/` and its bound book FIRST — so the
     * id in the folder name is the id the engine's Story row must carry — and only then does the engine
     * write §15 step 0 into that book.
     *
     * Anything that throws removes the book the registry just made (`rollback`); otherwise a folder the
     * server never finished with restarts as a Story the Author never asked for.
     */
    async createStory(input: CreateStoryInput = {}): Promise<{ story_id: string }> {
        // SINGLE-STORE MODE: the injected book owns the Story, exactly as the route tests assume.
        if (this.shared !== null) {
            const existing = this.contexts.get(SHARED_STORE_ID);
            const context = existing ?? (await this.register(this.bookEntries()[0]));

            return context.engine.createStory(input);
        }

        const registry = this.registry ?? StoryStores.inMemory();
        const entry = await registry.create();

        let context: StoryRuntimeContext;

        try {
            context = await this.register(entry);
        } catch (error) {
            // `rollback` removes the half-made book and re-throws, so this branch never produces a value;
            // returning it (rather than awaiting it) is what tells the type checker the flow ends here.
            return this.rollback(entry.id, error);
        }

        try {
            const created = await context.engine.createStory(input);

            // The bound book mints the registry's UUID as its single Story id, so a disagreement is a layout
            // bug rather than a user error — and it would leave a folder holding another Story's book.
            if (created.story_id !== entry.id) {
                throw new StoryLayoutError(
                    `the engine created ${created.story_id} inside the book bound to ${entry.id}`
                );
            }

            return created;
        } catch (error) {
            // Same as above: the rollback re-throws, and returning it keeps the function's exits honest.
            return this.rollback(entry.id, error);
        }
    }

    /** Removes the partial Story a failed create left behind, then re-throws what failed. */
    private async rollback(storyId: string, cause: unknown): Promise<never> {
        this.drop(storyId);

        try {
            await this.registry?.remove(storyId);
        } catch {
            // The folder is the only thing a failed create can leave behind, and a second failure there
            // must not bury the first one the Author is being told about.
        }

        throw cause;
    }

    /** Takes a context out of the set (the book itself is someone else's to close). */
    private drop(storyId: string): void {
        this.contexts.delete(storyId);

        const at = this.order.indexOf(storyId);

        if (at >= 0) this.order.splice(at, 1);

        this.ceiling.attach(() => this.liveRuns());
    }

    /**
     * THE deletion path — the one thing `api/routes.ts:DELETE /stories/:id` calls, so there is no second
     * caller to double-delete the rows and no writer left holding a folder once it is gone.
     *
     * A Story is not only its rows: it is its in-flight runs, its harness session, its nine knowledge
     * articles, its retained threads, its entry in this set, and `<root>/stories/<uuid>/` on disk. Purging
     * means all of it, in this order, and the order is the contract:
     *
     *   1. PAUSE — `pauseStory` writes the Story's own cord (`author_stop`), which is what makes the one
     *      sweep timer skip this book (`loop/engine.ts:431`), so no NEW run can start behind the delete;
     *      it then aborts the runs already in flight and awaits them. Stopping first is not tidiness: a
     *      run that outlives the book it writes to tears down into rows that no longer exist.
     *   2. ROWS — `engine.deleteStory` deletes every story-scoped §4 record in ONE commit and forgets the
     *      harness session. That commit is the last write this book ever takes.
     *   3. THREADS — the retained thread log is pruned while the folder still exists: `StoryThreadLog`
     *      `mkdirSync`s its directory on every write, so running it after the purge would re-create the
     *      `<uuid>/harness/` tree the delete just removed, and a restarted workspace would reopen a Story
     *      the Author deleted (a ghost book with no Story row in it).
     *   4. PROJECTION — the articles go, then the projection flushes and closes, again while its directory
     *      is still there. Its commit listener is what a still-open projection would use to re-materialise
     *      articles behind the delete, so the listener has to be off before the folder is.
     *   5. SET — the context leaves the map (the ceiling recounts live runs, the sweep stops visiting it).
     *   6. BOOK — `StoryStores.remove` closes the Store (which cancels its debounced persist, so nothing
     *      can write into a deleted directory afterwards) and `rm -r`s the one validated folder. The app
     *      book at `<root>/server/` and every sibling folder are not touched.
     *
     * SINGLE-BOOK MODE (`adopt`, or a hand-injected book) has no registry and no folder of its own: steps
     * 1-4 still run, the projection and the thread log are pruned to this Story's records rather than
     * closed, and the context stays — the book and its other Stories outlive the Story being deleted.
     */
    async removeStory(storyId: string): Promise<void> {
        const context = this.contextOf(storyId);

        if (context === undefined) {
            // Nothing open to close, but the folder may still exist (a book the boot could not open).
            if (this.registry !== null) await this.registry.remove(storyId);

            return;
        }

        // Only registry mode has a context that IS a whole book, and only for the id that book is bound
        // to (`bookEntries`); an adopted aggregate book answers for several Stories under `SHARED_STORE_ID`.
        const wholeBook = this.registry !== null && context.storyId === storyId;

        // A folder whose Story row never landed (the half-finished book a failed create can leave, or one a
        // restart could not fully load) has nothing for `pauseStory`/`deleteStory` to find, and their
        // `requireStory` would refuse the very purge the Author is asking for. Those cases still get the
        // cord-free half of the teardown: kill what is live, settle, forget the harness session.
        const hasStoryRow = context.store.stories.get(storyId) !== undefined;

        if (hasStoryRow) {
            await context.engine.pauseStory(storyId);

            await context.engine.deleteStory(storyId);
        } else {
            for (const run of liveRuns(context.store, storyId)) context.executor.kill(run.id, 'delete');

            await context.engine.settle();

            context.executor.harness.forget(storyId);
        }

        // 3 and 4 — both writers run BEFORE the folder goes, for the reasons in the order note above.
        context.threadLog.removeStory(storyId);

        // The nine articles are a projection of the rows, not rows themselves (P1's §4 boundary), so they
        // are the coordinator's to remove — the engine never sees them.
        context.knowledge.removeStory(storyId);
        await context.knowledge.flush();

        if (!wholeBook) {
            // One shared book: this Story's rows, threads and articles are gone, and the projection stays
            // open for the Stories the book still holds.
            return;
        }

        await context.knowledge.close();

        this.drop(storyId);

        // The registry owns the folder; `remove` is also what closes the Store, and it re-validates the id
        // before any `rm -r`, so a bad id can never aim the delete at the store root.
        await this.registry?.remove(storyId);
    }

    // -----------------------------------------------------------------------
    // The loop, across every Story
    // -----------------------------------------------------------------------

    /** Live run rows across every book — the number the shared ceiling compares its limit against. */
    liveRuns(): number {
        return this.stores().reduce((total, store) => total + liveRuns(store).length, 0);
    }

    /**
     * Moving the one ceiling. Every context's sweep reads it on its next dispatch, and lowering it cancels
     * nothing — the runs in flight finish their pass (`loop/engine.ts:setGlobalMaxConcurrent`'s reasoning).
     * The app book remembers it, so the Author's number survives a restart like every other host setting.
     */
    setGlobalMaxConcurrent(limit: number): void {
        this.ceiling.setLimit(limit);

        // Each engine's own config number moves too, so a context used on its own (a test that grabbed one)
        // agrees with the workspace instead of quietly keeping the old cap.
        for (const context of this.contexts_()) context.engine.setGlobalMaxConcurrent(limit);

        this.appConfig.setGlobalMaxConcurrent(limit);
    }

    /**
     * Whether the workspace runs its own clock (L-1).
     *
     * `!== false` and NOT `=== true`: the shipped server names `autoSweep: true` explicitly
     * (`api/server.ts:resolveEngineConfig`), and an omitted flag has always meant "a started loop sweeps" —
     * that is what L-1's switch IS, and what the gateway mount at
     * `endpoint/storyline/service-route.ts:82` relies on. Only an explicit `false` closes the timer, which is
     * the contract a test or an embed asks for when it wants to be the clock (`api/server.ts:174`).
     */
    private get autoSweeps(): boolean {
        return this.engineConfig.autoSweep !== false;
    }

    /**
     * L-1's switch, for every Story at once. The coordinator owns the one sweep timer.
     *
     * Every engine starts whether or not the workspace schedules, and that order is the contract:
     * `context.engine.started` is the per-book gate `sweepAll` reads, so with `autoSweep: false` each Story is
     * still sweepable BY HAND — closing the timer must not close the scheduling cord, or the caller that named
     * the flag to become the clock could not sweep at all. `started` reports the scheduling state either way,
     * and `stop()` is the exact inverse in both modes.
     *
     * `timer !== undefined` is what makes repeated `start()` calls idempotent: a second start must not arm a
     * second interval, or the workspace would sweep twice per tick and race its own re-entrancy guard.
     */
    start(): void {
        this.running = true;

        for (const context of this.contexts_()) context.engine.start();

        if (this.timer !== undefined || !this.autoSweeps) return;

        this.timer = setInterval(() => void this.sweep(), this.engineConfig.sweepIntervalMs ?? 500);

        // A sweep timer must not keep the process alive, exactly as the store's debounced persist does not.
        (this.timer as unknown as { unref?: () => void })?.unref?.();
    }

    /** Stops scheduling. In-flight runs are left alone; the next sweep re-adopts or abandons them (L-1). */
    stop(): void {
        this.running = false;

        if (this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }

        for (const context of this.contexts_()) context.engine.stop();
    }

    /** L-1's switch, named as the API names it. */
    setStopped(stopped: boolean): void {
        if (stopped) this.stop();
        else this.start();
    }

    /** True while the workspace schedules work. */
    get started(): boolean {
        return this.running;
    }

    /**
     * One sweep over every Story, in book order, reported as the ONE pass it was.
     *
     * The report is MERGED, not listed: the sweep is one pass under one ceiling (S-5), and
     * `SweepReport.stories` is already per Story — every entry carries its own `story_id`, so folding the
     * books together cannot fuse two Stories' same-named local ids. Keeping the shape identical to
     * `LoopEngine.sweep()` is also what lets the route table, the integration harness and the dashboard read
     * one engine or a hundred books with one piece of code (`loop/types.ts:EngineApi`).
     *
     * Two sweeps cannot overlap — the second joins the first, the same re-entrancy guard one engine applies
     * (`loop/engine.ts:sweep`).
     */
    async sweep(): Promise<SweepReport> {
        if (this.sweeping !== undefined) return this.sweeping;

        this.sweeping = this.sweepAll().finally(() => {
            this.sweeping = undefined;
        });

        return this.sweeping;
    }

    /**
     * The book passes, SEQUENTIALLY. Parallel would be faster and wrong: the shared ceiling is a VIEW over
     * the books, so two Stories deciding at once both read "there is capacity" and both launch — which is how
     * a ceiling of 4 becomes 8. Book order is stable, so the same workspace state produces the same sweep
     * outcome (L-3's predictability, and the dashboard's honest reading of one number).
     */
    private async sweepAll(): Promise<SweepReport> {
        const reports: SweepReport[] = [];

        for (const context of this.contexts_()) {
            if (!context.engine.started) continue;

            reports.push(await context.engine.sweep());
        }

        return mergeSweepReports(reports);
    }

    /** Awaits every run this process started, in every Story. The only place the workspace waits. */
    async settle(): Promise<void> {
        for (const context of this.contexts_()) await context.engine.settle();
    }

    /** Flushes every book (the debounced persist timers are the only thing outstanding). */
    async persistAll(): Promise<void> {
        if (this.registry !== null) {
            await this.registry.persistAll();

            return;
        }

        for (const store of this.stores()) await store.persist();
    }

    /**
     * Shuts the workspace down: stop scheduling, let in-flight work land, release each Story's harness
     * sessions and knowledge projection, then flush and close every book and the app book.
     *
     * This is the server's old shutdown order (`engine.stop` → harness dispose → store flush → knowledge
     * close), applied per Story. Knowledge closes last because a run's teardown may still ask the
     * projection a question, and a closed projection answers with a missing article rather than a throw.
     */
    async close(): Promise<void> {
        if (this.closed) return;

        this.closed = true;
        this.stop();

        await this.settle();

        for (const context of this.contexts_()) {
            context.executor.harness.dispose();

            await context.knowledge.close();
        }

        this.unsubscribe?.();
        this.unsubscribe = null;

        if (this.registry !== null) await this.registry.close();
        else for (const store of this.stores()) await store.close();

        // The app book flushes last: a Story's teardown may still ask the catalogue a question, and the
        // app book is the one thing a restart reads before any Story exists.
        await this.appConfig.close();
    }

    /** Whether `close()` has run; the shutdown ordering may read it. */
    isClosed(): boolean {
        return this.closed;
    }

    // -----------------------------------------------------------------------
    // The app configuration
    // -----------------------------------------------------------------------

    /**
     * Re-materialises the app configuration into every open book, so the Author's crew edits and roster
     * choices reach the Stories that already exist (a new Story picks the same configuration up when its
     * book is made). A book this considers current is skipped (`ServerConfig.matches`), and a Story that
     * forked a crew of its own keeps its fork — only the app's own rows, and the host settings, are pushed.
     *
     * This is what makes a catalogue write more than a write to the app book: each Story briefs its harness
     * from its OWN copy, so an edit that stopped at the app book would leave every running Story working to
     * the card the Author replaced. Returns the Stories whose book changed, which is what the route reports.
     */
    syncConfig(): string[] {
        const changed: string[] = [];

        for (const context of this.contexts_()) {
            if (this.appConfig.matches(context.store)) continue;

            this.appConfig.applyTo(context.store);
            changed.push(context.storyId);
        }

        return changed;
    }

    // -----------------------------------------------------------------------
    // `EngineApi` — the loop the route table talks to
    // -----------------------------------------------------------------------
    //
    // Every verb names its Story (`createStory` allocates one; the workspace switch, sweep and settle are
    // above), so routing is one lookup: the Story's context. A Story id from another book resolves to no
    // context and the verb throws, which the route answers the way it answers any id the book never had.
    //
    // The verbs that name a CHILD record instead (`approveFinding`, `decideIdea`, `applyAuthorEdit`,
    // `unapproveChapter`, `decideProposal`, `undoLast`) carry only a local id, and a local id is unique
    // only inside one book. `ownerOf` asks each book which one holds that record — the look the registry
    // makes necessary and the single-store shape never needed.

    /** The loop of one Story, for the routes that read engine state directly. */
    engineOf(storyId: unknown): LoopEngine | undefined {
        return this.contextOf(storyId)?.engine;
    }

    /** The one lookup every verb below runs. */
    private verb(storyId: string): LoopEngine {
        return this.requires(storyId).engine;
    }

    pauseStory(storyId: string): Promise<void> {
        return this.verb(storyId).pauseStory(storyId);
    }

    deleteStory(storyId: string): Promise<void> {
        // The §4-row half of the deletion, for a caller that owns the book itself (an embed, or the §11 MCP
        // surface). The route's DELETE does NOT call this: it calls `removeStory`, which runs this verb
        // inside the full purge and then releases the projection, the registry entry and the folder.
        return this.verb(storyId).deleteStory(storyId);
    }

    resumeStory(storyId: string): Promise<void> {
        return this.verb(storyId).resumeStory(storyId);
    }

    clearPending(storyId: string): Promise<void> {
        return this.verb(storyId).clearPending(storyId);
    }

    requestSummaryRevision(storyId: string, note?: string): Promise<void> {
        return this.verb(storyId).requestSummaryRevision(storyId, note);
    }

    /** T12: the lock's receipt passes through — see `EngineApi.lockPhase` in `loop/types.ts`. */
    lockPhase(storyId: string, phase: StoryPhase): Promise<PhaseLockReceipt> {
        return this.verb(storyId).lockPhase(storyId, phase);
    }

    backtrack(storyId: string, phase: StoryPhase): Promise<void> {
        return this.verb(storyId).backtrack(storyId, phase);
    }

    changeChapterCount(storyId: string, count: number, opts?: { confirm?: boolean }): Promise<ChapterCountResult> {
        return this.verb(storyId).changeChapterCount(storyId, count, opts);
    }

    editSeed(storyId: string, text: string, opts?: { confirm?: boolean }): Promise<void> {
        return this.verb(storyId).editSeed(storyId, text, opts);
    }

    approveFinding(findingId: string, opts?: { cost?: Cost; by?: string; note?: string }): Promise<void> {
        return this.verb(this.ownerOf(findingId, 'findings')).approveFinding(findingId, opts);
    }

    decideIdea(ideaId: string, picked: string[] = [], note = ''): Promise<void> {
        return this.verb(this.ownerOf(ideaId, 'ideas')).decideIdea(ideaId, picked, note);
    }

    applyAuthorEdit(
        chapterId: string,
        sectionId: string,
        text: string,
        opts?: { undoable?: boolean }
    ): Promise<void> {
        return this.verb(this.ownerOf(chapterId, 'chapters')).applyAuthorEdit(chapterId, sectionId, text, opts);
    }

    unapproveChapter(chapterId: string): Promise<void> {
        return this.verb(this.ownerOf(chapterId, 'chapters')).unapproveChapter(chapterId);
    }

    decideProposal(
        proposalId: string,
        verdict: 'accepted' | 'rejected' | 'deferred',
        reason?: string
    ): Promise<void> {
        return this.verb(this.ownerOf(proposalId, 'proposals')).decideProposal(proposalId, verdict, reason);
    }

    undoLast(chapterId: string): Promise<void> {
        return this.verb(this.ownerOf(chapterId, 'chapters')).undoLast(chapterId);
    }

    processDirective(
        storyId: string,
        text: string,
        refs?: string[]
    ): Promise<{ directive_id: string; impact: DirectiveReport }> {
        return this.verb(storyId).processDirective(storyId, text, refs);
    }

    acceptCompletion(storyId: string, accept: boolean): Promise<void> {
        return this.verb(storyId).acceptCompletion(storyId, accept);
    }

    setGoal(storyId: string, patch: GoalPatch): Promise<void> {
        return this.verb(storyId).setGoal(storyId, patch);
    }

    setChapterBar(storyId: string, chapterId: string, criteria: string[]): Promise<void> {
        return this.verb(storyId).setChapterBar(storyId, chapterId, criteria);
    }

    assignTemplates(
        storyId: string,
        assignments: Record<string, string[]> | string[],
        opts?: { confirm?: boolean }
    ): Promise<AssignTemplatesResult> {
        // Crew rows resolve out of the Story's own book (D-1/D-2), which is exactly why the app catalogue
        // has to be materialised there before an Author's own crew can be assigned. The id is forwarded
        // like every other verb: `LoopEngine.assignTemplates(storyId, assignments, opts)` takes it first,
        // and dropping it made the engine read the CREW LIST as the story id and the opts bag as the crews.
        return this.verb(storyId).assignTemplates(storyId, assignments, opts);
    }

    /**
     * The Story that owns a record addressed by its LOCAL id — `finding_3` names one of ten books'
     * `finding_3`, so the registry has to look, and the look is the isolation claim: an id from another
     * Story cannot be routed into this Story's engine, because there is no book to route it to.
     *
     * A single store answers immediately (its one book holds every id it knows). When no book holds the
     * record, the answer is the shared key, and the verb then fails the way a missing record fails in the
     * single-store shape — the route's 404 rather than a guess about which Story meant it.
     */
    private ownerOf(id: string, collection: 'findings' | 'ideas' | 'chapters' | 'proposals'): string {
        for (const store of this.stores()) {
            const row = store[collection].get(id) as { story_id?: string } | undefined;

            if (row?.story_id !== undefined) return row.story_id;
        }

        return SHARED_STORE_ID;
    }
}
