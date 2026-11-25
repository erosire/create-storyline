// W1 — the store: the §4 collections, compare-and-swap, the attribution journal, and the
// two-file durability behind them.
//
// WHY THE STORE IS THE WHOLE PRODUCT'S FOUNDATION: P1 makes it the only memory in the system
// ("an agent that cannot write a fact into the store has not produced it"), P3 makes a Story
// identical to its records, and L-3 makes the loop restartable because nothing else holds
// state. So this module owns three obligations and nothing else:
//   1. the collections are the ONLY way a record changes, so every change is attributable (P11);
//   2. a stale write is DETECTED and the current record is handed back, never forced (T-4);
//   3. a multi-record change either lands entirely or not at all (D-22 selection deletes,
//      L-7 lock mirrors, D-25/L-31 backtrack, D-36 tray deletion).
// It owns NO loop policy, no permissions (W2), no criteria (W3): those read these
// collections, they do not live here.
//
// CONCURRENCY MODEL (deliberate, and load-bearing for T-4/L-2): every write path here is
// synchronous over an in-memory model, and the process is single-threaded, so a tool call is
// atomic with respect to other tool calls — no lock is needed and none is taken. Two runs
// racing on one record is therefore not a corruption but a REV RACE, which is exactly the
// case T-4 turns into a visible rejection instead of a lost update (D-37 explains why the
// Author's UI writes go through a pause rather than through this same race).
//
// WHY ONE PRODUCTION STORE IS ONE STORY: the durable layout is `<root>/stories/<uuid>/`, and the
// folder is the story's identity boundary (P3: a Story IS its records — so its records, its journal
// and its harness live in one directory, and deleting that directory is the only way a story dies).
// Two shapes of Store therefore exist, and only two:
//   * UNBOUND — `Store.empty()`, or `Store.load(root)` with no `storyId`. The generic book: the
//     unit tests, the in-memory run, and (later) the server-level templates/settings store.
//   * STORY-BOUND — `Store.emptyStory(uuid)` / `Store.loadStory(uuid, dir)`, always built by the
//     `StoryStores` registry. Such a store (a) mints the story's own UUID as the id of its single
//     `stories` record instead of `story_<n>`, (b) refuses a second story record, (c) refuses any
//     write whose `story_id` names a DIFFERENT story, and (d) records `story_id` in `store.json`,
//     which `loadStory` cross-checks. Every child id (`finding_0`, `revision_0`, …) is local to the
//     one store and starts at zero, so two stories may hold the same id and mean different things.
import {
    COLLECTION_NAMES,
    COLLECTION_SINGULARS,
    type AnyRecord,
    type Chapter,
    type CastMember,
    type CollectionName,
    type Digest,
    type Directive,
    type Finding,
    type Goal,
    type GroupRevision,
    type Idea,
    type KnowledgeEntry,
    type LedgerEntry,
    type Phrase,
    type PhraseGroup,
    type Plotline,
    type Proposal,
    type Revision,
    type Run,
    type SampleReview,
    type SeedBrief,
    type Story,
    type StoredRecord,
    type Summary,
    type SummaryScore,
    type Task,
    type Template,
    type Verdict,
    type RecordInit
} from '../../shared/types';
import {
    SNAPSHOT_VERSION,
    STORIES_DIRECTORY,
    appendJournal,
    assertStoryId,
    isRecordUid,
    readJournal,
    readSnapshot,
    storeFilePath,
    writeSnapshot,
    type StoreSnapshot
} from './persist';

// Re-exported so a server-side caller can reach the §4.4 derived read without importing a
// second path (the browser dashboard imports it from `shared/chapter` directly).
export { chapterContent } from '../../shared/chapter';

// ---------------------------------------------------------------------------
// The contract types later waves code against
// ---------------------------------------------------------------------------

/**
 * P11 — every mutation records who made it and a one-line `why`.
 *
 * The three writer kinds are distinguishable from these flags alone: an agent run sets
 * `run_ref`; the Author's own edit sets `author: true` with `run_ref: null` (D-20a: the
 * Author's prose edit is a direct write, not a proposal, because there is nobody to approve
 * it); the Author-invoked assistant of §8.6 sets `assistant: true` AND its `run_ref`, so the
 * audit can tell "the machine, on the Author's instruction" from "the machine, on its own".
 *
 * `why` is required and non-blank (T-5, D-8): the store refuses a write that arrives without
 * one, because an unattributed change is the thing P11 exists to prevent, and a prompt is not
 * a guard (T-13).
 */
export interface Attribution {
    run_ref?: string | null;
    author?: boolean;
    assistant?: boolean;
    why: string;
}

/** T-4 — the compare-and-swap token: `{id, rev}` for every record the write assumes it read. */
export interface CAS {
    id: string;
    rev: number;
}

/** The three journal operations — the whole vocabulary of a change (P3). */
export type CommitOperation = 'create' | 'update' | 'delete';

/**
 * One journaled mutation (P11 audit; D-12a digest source; D-8 "which run changed it, and
 * why").
 *
 * `patch` carries what changed, and for a `delete` it carries the deleted record: P11 asks
 * that a change be undoable, and a journal that says "chapter_7 was deleted" cannot support
 * an undo. For an `update` it is the patch as sent, not the previous values — the previous
 * values are one journal line earlier.
 *
 * `commit_label` is the one field added on top of the pinned event shape, and it is added for
 * a reason D-12a forces: the Digest is derived from "commits and the records they touched",
 * so the journal must say which decision a group of events was ("select_revision",
 * "lock_summary", "backtrack_to_plotlines"). Events are grouped by that label and by
 * adjacency; `seq` stays the authority for ordering.
 */
export interface CommitEvent {
    seq: number;
    at: string;
    collection: CollectionName;
    op: CommitOperation;
    id: string;
    attribution: Attribution;
    patch?: unknown;
    commit_label: string;
}

/** A listener sees one commit group at a time — the unit the SSE feed (W2/the dashboard) replays. */
export type CommitListener = (events: CommitEvent[]) => void;

/** A partial record for `update`; the bookkeeping fields are the store's to manage. */
export type UpdatePatch<T> = Partial<Omit<T, 'id' | 'rev' | 'created_at' | 'updated_at'>>;

/** A predicate for {@link Collection.deleteWhere} — the bulk scrap D-25/D-25a and D-36 use. */
export type RecordPredicate<T> = (record: T) => boolean;

/**
 * Debounce window for the automatic persist. 25ms is long enough to swallow a whole commit
 * burst and short enough that an ungraceful stop loses almost nothing; L-3's restart
 * guarantee does not depend on it, because `close()` and every awaited `persist()` are the
 * durable path and the journal carries anything in between.
 */
const PERSIST_DEBOUNCE_MS = 25;

/** Everything the store can reject a write over that is not a rev conflict. */
export class StoreError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'StoreError';
    }
}

/**
 * T-4 — "a rejected write RETURNS the current record so the agent re-reads and re-applies
 * instead of forcing". That return value is this error: `currents` holds one entry per
 * `expects` item, each carrying the record as it is NOW (or `undefined` when it has been
 * deleted since it was read). Nothing was written when this is thrown.
 */
export class CasConflict extends Error {
    readonly currents: { id: string; record: unknown }[];

    constructor(currents: { id: string; record: unknown }[], message: string) {
        super(message);
        this.name = 'CasConflict';
        this.currents = currents;
    }
}

/**
 * The id one collection must hand out, supplied by whoever owns the story's identity (the
 * `StoryStores` registry, which names the folder before the folder names a store).
 *
 * It replaces the `${singular}_${n}` minting for that collection — a story-bound store's
 * `stories.create` therefore produces the story UUID rather than `story_0`, which is what keeps
 * the `story_id` fields, the folder name and the `store.json` binding the same string.
 */
export type StoryIdFactory = () => string;

/** Options for opening a book. `storyId` is the only option today, and it is the whole difference. */
export interface StoreOptions {
    /**
     * Bind the store to one Story (a UUID, validated before anything is read or written). Absent
     * or null = an unbound generic book with no story rules.
     */
    storyId?: string | null;
}

// ---------------------------------------------------------------------------
// Small internal helpers (kept here so the store's rules are readable in one place)
// ---------------------------------------------------------------------------

// Records handed out are COPIES. A caller that mutates what `get()` returned cannot reach the
// store, so the journal stays the only way a change exists (P11) and a handed-out record
// cannot go stale in someone's hands. The copy is a JSON round-trip rather than
// `structuredClone` because every §4 record is JSON by construction (it is persisted that
// way), and because the jsdom test environment does not reliably expose the latter.
function copyIn<T>(value: T): T {
    // `JSON.stringify(undefined)` is `undefined`, and `JSON.parse("undefined")` throws — so a
    // CAS check that resolved an id to a DELETED record would crash instead of conflicting.
    // Absent records are handed back exactly as they are (T-4 reports them as `undefined`).
    if (value === undefined || value === null) return value;

    return JSON.parse(JSON.stringify(value)) as T;
}

/** D-8/T-5 guard: no mutation without a `why`. */
function requireAttribution(attribution: Attribution, collection: string, op: string): void {
    if (!attribution || typeof attribution !== 'object') {
        throw new StoreError(
            `${op} on ${collection} needs an attribution — P11 requires every change to record who made it`
        );
    }

    if (typeof attribution.why !== 'string' || attribution.why.trim().length === 0) {
        throw new StoreError(
            `${op} on ${collection} needs attribution.why — T-5/D-8 require every write to carry a one-line reason`
        );
    }
}

/**
 * The counter a collection must boot with: one past the largest `<singular>_<n>` suffix present.
 *
 * Ids are ZERO-BASED (`finding_0` is the first finding), so the persisted counter is the NEXT id to
 * mint, and a store holding `finding_0…finding_2` must continue at 3. An empty collection returns
 * 0 — NOT 1 — or a freshly created book would skip its first id. The "+1 over the highest live
 * suffix" half is what stops a hand-edited or half-persisted book from minting a live id twice.
 */
function nextIdCounter(singular: string, ids: readonly string[]): number {
    let highest = -1;

    for (const id of ids) {
        if (!id.startsWith(`${singular}_`)) continue;

        const suffix = Number(id.slice(singular.length + 1));

        // `Number('')` is 0, which would silently resurrect `<singular>_0`; require real digits.
        if (!/^\d+$/.test(id.slice(singular.length + 1))) continue;

        if (suffix > highest) highest = suffix;
    }

    return highest + 1;
}

/** Snapshot journal + log journal, deduplicated by `seq` and ordered (either file may lead). */
function mergeEvents(snapshotJournal: readonly unknown[], logged: readonly unknown[]): CommitEvent[] {
    const bySeq = new Map<number, CommitEvent>();

    for (const candidate of [...snapshotJournal, ...logged]) {
        const event = candidate as CommitEvent;

        if (typeof event?.seq !== 'number' || bySeq.has(event.seq)) continue;

        bySeq.set(event.seq, event);
    }

    return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}

/**
 * The per-story binding, checked against the file rather than trusted.
 *
 * Two failures are refused, both because they would put one story's facts in another story's book
 * and the build promises NO migration:
 *   * the snapshot names a different story — `stories/<a>/store.json` opened as story `b`;
 *   * the snapshot names no story at all — a book written by an unbound store (the pre-per-story
 *     flat layout, or the server-level store) sitting where a story folder is expected.
 * A missing snapshot is not a failure: that is a story folder's first boot.
 */
function assertSnapshotBinding(storyId: string, rootDir: string, snapshot: StoreSnapshot | null): void {
    if (snapshot === null) return;

    const bound = snapshot.story_id;

    if (bound === undefined || bound === null) {
        throw new StoreError(
            `${storeFilePath(rootDir)} is not bound to a story (it has no story_id) — this build does not migrate ` +
                `the old flat layout, so move it to stories/<uuid>/ or remove it`
        );
    }

    if (bound === storyId) return;

    throw new StoreError(
        `${storeFilePath(rootDir)} belongs to story ${String(bound)}, not story ${storyId} — one story is one ` +
            `folder, so it must be opened from stories/${String(bound)}/`
    );
}

// ---------------------------------------------------------------------------
// Collection<T>
// ---------------------------------------------------------------------------

/** The mutable state of one collection — the unit `Store.commit` snapshots and rolls back. */
interface CollectionState<T> {
    records: Map<string, T>;
    counter: number;
    /**
     * Whether this collection's externally-assigned (story UUID) id has already been issued. It
     * has to ride the rollback or a commit that created the Story and then threw would leave the
     * store refusing a second Story it never actually wrote.
     */
    fixedIssued: boolean;
}

/**
 * One §4 collection: an ordered (insertion-order) id → record map with the store's write
 * rules applied. Typed accessors live on {@link Store} (`store.chapters`, `store.ideas`, …),
 * so nothing outside the store constructs one.
 *
 * `T` is constrained to records carrying the §4 bookkeeping fields, which is what makes
 * `rev`-based CAS and the `updated_at` stamp type-safe for all collections at once (the 20 §4
 * ones plus the three the Summary Phrase redesign appends).
 */
export class Collection<T extends StoredRecord> {
    readonly name: CollectionName;
    readonly singular: string;

    private readonly owner: Store;
    private readonly records = new Map<string, T>();

    /** The NEXT id to mint — ids are zero-based, so a fresh collection's first create is `_0`. */
    private counter = 0;

    /**
     * Set on the `stories` collection of a story-bound store (`Store` calls `_setIdFactory`): the
     * id comes from the store's story identity instead of the counter, and it can be issued once.
     */
    private idFactory: StoryIdFactory | null = null;
    private fixedIssued = false;

    constructor(owner: Store, name: CollectionName) {
        this.owner = owner;
        this.name = name;
        this.singular = COLLECTION_SINGULARS[name];
    }

    // -- reads (copies: see `copyIn`) ------------------------------------------------------

    /** Every record, in insertion order. The sweep's scan and the dashboard's list read. */
    list(): T[] {
        return [...this.records.values()].map(copyIn);
    }

    /** The record, or `undefined` — the read a tool call uses when absence is a valid answer. */
    get(id: string): T | undefined {
        const found = this.records.get(id);

        return found === undefined ? undefined : copyIn(found);
    }

    /** The record, or a thrown error naming the collection and id — the read a tool call uses when absence is a caller bug. */
    require(id: string): T {
        const found = this.records.get(id);

        if (found === undefined) {
            throw new StoreError(`no ${this.singular} named ${id} in the ${this.name} collection`);
        }

        return copyIn(found);
    }

    count(): number {
        return this.records.size;
    }

    // -- writes (each one journals, and each one must explain itself) --------------------

    /**
     * Creates a record. The id is minted `${singular}_${n}` from the collection's monotonic
     * counter (W1) — ZERO-BASED, so the first finding in a story is `finding_0` and the ids are
     * story-local (two stories may both hold `finding_0`, and they are different findings).
     * A story-bound store's `stories` collection takes its id from the store's story UUID
     * instead (`_setIdFactory`), and `rev` starts at 1 and the timestamps are the store's — a
     * caller cannot set any of the three, which is what keeps ids and revs trustworthy as CAS
     * tokens.
     */
    create(init: RecordInit<T>, attribution: Attribution): T {
        requireAttribution(attribution, this.name, 'create');

        const id = this.idFactory ? this.nextFixedId() : `${this.singular}_${this.counter++}`;
        const at = new Date().toISOString();
        const record = { ...copyIn(init), id, rev: 1, created_at: at, updated_at: at } as unknown as T;

        // A story-bound store may hold no other story's records (see `Store._assertStoryScope`);
        // this runs before the map is touched, so a refusal writes and journals nothing.
        this.owner._assertStoryScope(this.name, record);

        this.records.set(id, record);
        this.owner._event(this.name, 'create', id, attribution, record);

        return copyIn(record);
    }

    /**
     * Creates a record under an EXTERNALLY-ASSIGNED uid — the write behind a group id that is an
     * ADDRESS rather than a label (R1: `phrases`, `phrase_groups`, `group_revisions`).
     *
     * The rules are the same as {@link create}'s and deliberately as strict: `rev` starts at 1, the
     * timestamps are the store's, the caller may set none of them, the story scope is checked before
     * the map is touched, and the write journals. What differs is only where the id comes from: the
     * caller (usually `newRecordUid()` in `persist.ts`, injected so a test can pin ids) rather than
     * the collection's counter.
     *
     * WHY THE ID IS VALIDATED AS A UUID: an id that will be quoted back by a route, a finding and a
     * model's structured answer has to be unambiguous and unparsable-by-accident. A `${singular}_n`
     * id handed here would be accepted by `Map.set` and then read as a DIFFERENT group by
     * `nextIdCounter` on the next boot, which is exactly the class of drift this store refuses at the
     * door rather than discovering in a projection.
     *
     * The counter does NOT advance: uid ids are not counter ids, and `nextIdCounter` skips
     * non-`${singular}_` ids when a book hydrates, so the two schemes cannot collide in one collection.
     */
    createWithId(id: string, init: RecordInit<T>, attribution: Attribution): T {
        requireAttribution(attribution, this.name, 'create');

        if (this.idFactory !== null) {
            throw new StoreError(
                `the ${this.name} collection takes its id from the store's story identity, not from a caller — ` +
                    `createWithId is for the collections whose ids are minted by their owner (phrase, group, revision)`
            );
        }

        if (!isRecordUid(id)) {
            throw new StoreError(
                `the ${this.singular} id ${JSON.stringify(id)} is not a UUID (8-4-4-4-12 hexadecimal) — an ` +
                    `externally-assigned id is quoted by routes, findings and structured answers, so it must be minted by newRecordUid()`
            );
        }

        if (this.records.has(id)) {
            throw new StoreError(
                `the ${this.singular} id ${id} is already in the ${this.name} collection — an externally-assigned id ` +
                    `is issued once, so minting it twice means the caller re-created a row it already has (P1: the store is the memory)`
            );
        }

        const at = new Date().toISOString();
        const record = { ...copyIn(init), id, rev: 1, created_at: at, updated_at: at } as unknown as T;

        // Same story-scope guard as `create`, before the map is touched: a refusal writes and journals nothing.
        this.owner._assertStoryScope(this.name, record);

        this.records.set(id, record);
        this.owner._event(this.name, 'create', id, attribution, record);

        return copyIn(record);
    }

    /**
     * The externally-assigned id (a story UUID): issued exactly once, because one story-bound
     * Store IS one story. The refusal survives a delete of the record — a new story means a new
     * folder and a new UUID from `StoryStores`, never a second story in this book.
     */
    private nextFixedId(): string {
        if (this.fixedIssued || this.records.size > 0) {
            throw new StoreError(
                `this store already holds the story ${this.owner.storyId ?? ''} — one Store is one story, ` +
                    `so a new story is a new story folder (StoryStores.create), not a second stories record`
            );
        }

        const id = assertStoryId(this.idFactory!(), 'the id assigned to the stories collection');

        this.fixedIssued = true;

        return id;
    }

    /**
     * Applies a patch and bumps `rev` (the CAS token advances).
     *
     * `expects` is checked AFTER the record is found and BEFORE anything is written: every
     * entry is resolved across the whole store, because T-4 lets a tool declare the revs of
     * records other than the one it writes (a `selectRevision` that assumes a chapter's rev
     * is a cross-collection expect). Any mismatch throws {@link CasConflict} carrying every
     * current record, and the collection is left untouched.
     */
    update(id: string, patch: UpdatePatch<T>, attribution: Attribution, expects?: CAS[]): T {
        requireAttribution(attribution, this.name, 'update');

        const current = this.records.get(id);

        if (current === undefined) {
            throw new StoreError(
                `no ${this.singular} named ${id} to update — T-4: re-read the record and re-send the write with an expects that matches it`
            );
        }

        if (expects && expects.length > 0) this.owner._assertCas(expects);

        const next = {
            ...current,
            ...copyIn(patch),
            id,
            rev: current.rev + 1,
            updated_at: new Date().toISOString()
        } as T;

        // A patch cannot move a record into (or out of) this story: the story is the store's
        // identity, so `story_id` is only writable when it agrees with it.
        this.owner._assertStoryScope(this.name, next);

        this.records.set(id, next);
        this.owner._event(this.name, 'update', id, attribution, patch);

        return copyIn(next);
    }

    /** Hard delete (P13/D-22: deletion is hard, not a flag). Same CAS rules as `update`. */
    delete(id: string, attribution: Attribution, expects?: CAS[]): void {
        requireAttribution(attribution, this.name, 'delete');

        const current = this.records.get(id);

        if (current === undefined) {
            throw new StoreError(`no ${this.singular} named ${id} to delete`);
        }

        if (expects && expects.length > 0) this.owner._assertCas(expects);

        this.records.delete(id);
        this.owner._event(this.name, 'delete', id, attribution, current);
    }

    /**
     * Bulk delete — the scrap primitive (D-25/L-31 backtrack deleting a phase's artifacts,
     * D-25a a Seed edit clearing every later phase, D-36 emptying the Ideas tray, D-22
     * deleting the losing revisions). Returns how many records went.
     *
     * Each removal is journaled as its own event rather than as one aggregate write, because
     * P11's audit and the digest derivation are per record: "5 chapters deleted" does not
     * tell the Author which paragraphs are gone. Call it inside `Store.commit` when the scrap
     * must land together with other writes, which is the normal case.
     */
    deleteWhere(pred: RecordPredicate<T>, attribution: Attribution): number {
        requireAttribution(attribution, this.name, 'deleteWhere');

        let removed = 0;

        for (const [id, record] of [...this.records.entries()]) {
            if (!pred(record)) continue;

            this.records.delete(id);
            removed += 1;
            this.owner._event(this.name, 'delete', id, attribution, record);
        }

        return removed;
    }

    // -- store-internal plumbing (not part of the tool-facing contract) ------------------

    /** @internal Un-copied read for CAS resolution and predicates. */
    _find(id: string): T | undefined {
        return this.records.get(id);
    }

    /** @internal Live values for a snapshot; the Map itself is copied so rollback is cheap. */
    _values(): IterableIterator<T> {
        return this.records.values();
    }

    /** @internal The id counter, read without copying the map for it. */
    _counter(): number {
        return this.counter;
    }

    /** @internal */
    _state(): CollectionState<T> {
        return { records: new Map(this.records), counter: this.counter, fixedIssued: this.fixedIssued };
    }

    /** @internal */
    _restore(state: CollectionState<T>): void {
        this.records.clear();

        for (const [id, record] of state.records) this.records.set(id, record);

        this.counter = state.counter;
        this.fixedIssued = state.fixedIssued;
    }

    /**
     * @internal Binds an externally-assigned id to this collection (only the `stories`
     * collection of a story-bound Store). The factory is the story UUID the registry chose when it
     * named the folder, so `stories.create` and the folder name can never disagree.
     */
    _setIdFactory(factory: StoryIdFactory): void {
        this.idFactory = factory;
    }

    /**
     * @internal Boot hydration (L-3: restart with no lost state). The counter is the HIGHER
     * of the persisted "next id" and one past the largest id suffix present, so a hand-edited or
     * partially-persisted store cannot cause a duplicate id on the next create.
     */
    _hydrate(records: readonly unknown[], persistedCounter = 0): void {
        this.records.clear();

        const materialised: T[] = [];

        for (const candidate of records) {
            const record = candidate as T;

            if (!record || typeof record.id !== 'string') continue;

            this.records.set(record.id, record);
            materialised.push(record);
        }

        this.counter = Math.max(
            persistedCounter,
            nextIdCounter(
                this.singular,
                materialised.map((record) => record.id)
            )
        );

        // A book that already has its one Story record has spent its externally-assigned id; the
        // UUID itself is not a `<singular>_<n>` suffix, so the counter cannot tell us this.
        if (this.idFactory !== null) this.fixedIssued = materialised.length > 0;
    }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * The durable, journaled, in-memory-at-runtime store over the §4 model.
 *
 * Lifetime: `Store.load(root)` (or `Store.empty()` for tests and for the in-memory case)
 * → reads and writes → `close()` flushes. Writes are applied immediately and durably in the
 * order they happen; a debounced persist keeps the file current without paying one snapshot
 * per tool call, and `persist()`/`close()` are the explicit flush a caller uses before it
 * inspects the files.
 */
export class Store {
    // The 20 §4 collections, named exactly as §4 names them (MUST NOT rename — W1), plus the three
    // the Summary Phrase redesign appends (`phrases`, `phrase_groups`, `group_revisions`).
    readonly stories: Collection<Story>;
    readonly summaries: Collection<Summary>;
    readonly plotlines: Collection<Plotline>;
    readonly chapters: Collection<Chapter>;
    readonly cast: Collection<CastMember>;
    readonly ledger: Collection<LedgerEntry>;
    readonly tasks: Collection<Task>;
    readonly digests: Collection<Digest>;
    readonly verdicts: Collection<Verdict>;
    readonly findings: Collection<Finding>;
    readonly goals: Collection<Goal>;
    readonly templates: Collection<Template>;
    readonly runs: Collection<Run>;
    readonly directives: Collection<Directive>;
    readonly revisions: Collection<Revision>;
    readonly ideas: Collection<Idea>;
    readonly proposals: Collection<Proposal>;

    // The three Phase-1 research collections (§3.2-§3.4 of the research-pipeline doc). They are
    // appended to the registry, so a snapshot written before they existed hydrates them empty.
    /** §3.2 — the Researcher's durable facts; the Writer prompt reads `critical`/`high` only. */
    readonly knowledge: Collection<KnowledgeEntry>;
    /** §3.3 — the Editor's derived, machine-readable projection of the Seed (never the Seed). */
    readonly seedBriefs: Collection<SeedBrief>;
    /** §3.4 — the screening Critic's one-turn issue list per sample; feeds the selector. */
    readonly sampleReviews: Collection<SampleReview>;
    // The Summary Phrase collections (R1/R2). `phrases` and `phrase_groups` are created with
    // `createWithId` (a uid ADDRESS, because a group id is named by routes, findings and run rows);
    // `group_revisions` keeps counter ids, because a revision is addressed by (group id, number).
    readonly phrases: Collection<Phrase>;
    readonly phraseGroups: Collection<PhraseGroup>;
    readonly groupRevisions: Collection<GroupRevision>;
    // READER SCORING (D-65) — one Reader run per group vector, five rows per run, accumulating
    // across revisions. Display-only: no loop predicate reads it (see `SummaryScore`).
    readonly summaryScores: Collection<SummaryScore>;

    /** The single registry every generic path (snapshot, CAS resolution, rollback) walks. */
    private readonly collections: Record<CollectionName, Collection<AnyRecord>>;

    private readonly events: CommitEvent[] = [];
    private readonly listeners = new Set<CommitListener>();

    /**
     * Host settings that are not §4 records (today: the employee roster's models, U-8, and the loop's
     * fan-out ceiling, S-5). They are persisted in `store.json` but never journaled: a model name and a
     * thread count are host configuration, not story facts, so neither may feed the Digest derivation
     * (D-12a). The map is kept separate from the collections so no §4 path can see or enumerate it.
     */
    private readonly settings = new Map<string, unknown>();

    /**
     * The commit under construction. Non-null inside `commit()`; a mutation that lands there
     * is buffered so the group can be rolled back as a unit and so listeners see one
     * decision at a time (D-22's "in the same commit" is this buffer, nothing else).
     */
    private group: CommitEvent[] | null = null;
    private groupLabel = '';
    private depth = 0;
    private seq = 0;

    /** Serialised file writes: one append/snapshot at a time, in the order they were asked for. */
    private writeChain: Promise<void> = Promise.resolve();
    private timer: ReturnType<typeof setTimeout> | undefined;

    /** Where the two durable files live; `null` is the in-memory store (no persist target). */
    readonly rootDir: string | null;

    /**
     * The Story this book belongs to, or `null` for a generic book (`Store.empty()`, the
     * server-level store). Story-bound stores mint the story UUID as their one `stories` id,
     * refuse another story's records, and stamp `story_id` into `store.json`.
     */
    readonly storyId: string | null;

    private constructor(rootDir: string | null, storyId?: string | null) {
        this.rootDir = rootDir;

        // Validated in the constructor, not at the first write: an unbound id must not get as far
        // as a path join or a record id, and `null`/undefined is the deliberate unbound case.
        this.storyId = storyId === undefined || storyId === null ? null : assertStoryId(storyId, 'Store storyId');

        this.collections = {} as Record<CollectionName, Collection<AnyRecord>>;

        for (const name of COLLECTION_NAMES) {
            this.collections[name] = new Collection<AnyRecord>(this, name);
        }

        // The story's own identity is the id its `stories` record carries, so `stories.create`
        // yields the folder UUID instead of `story_0` (see `Collection.nextFixedId`).
        if (this.storyId !== null) {
            const assigned = this.storyId;

            this.collections.stories._setIdFactory(() => assigned);
        }

        // The typed aliases are the SAME objects as the registry entries (one state per
        // collection); the cast is sound because `CollectionRecords` names each record type
        // for its collection.
        this.stories = this.collections.stories as unknown as Collection<Story>;
        this.summaries = this.collections.summaries as unknown as Collection<Summary>;
        this.plotlines = this.collections.plotlines as unknown as Collection<Plotline>;
        this.chapters = this.collections.chapters as unknown as Collection<Chapter>;
        this.cast = this.collections.cast as unknown as Collection<CastMember>;
        this.ledger = this.collections.ledger as unknown as Collection<LedgerEntry>;
        this.tasks = this.collections.tasks as unknown as Collection<Task>;
        this.digests = this.collections.digests as unknown as Collection<Digest>;
        this.verdicts = this.collections.verdicts as unknown as Collection<Verdict>;
        this.findings = this.collections.findings as unknown as Collection<Finding>;
        this.goals = this.collections.goals as unknown as Collection<Goal>;
        this.templates = this.collections.templates as unknown as Collection<Template>;
        this.runs = this.collections.runs as unknown as Collection<Run>;
        this.directives = this.collections.directives as unknown as Collection<Directive>;
        this.revisions = this.collections.revisions as unknown as Collection<Revision>;
        this.ideas = this.collections.ideas as unknown as Collection<Idea>;
        this.proposals = this.collections.proposals as unknown as Collection<Proposal>;
        this.knowledge = this.collections.knowledge as unknown as Collection<KnowledgeEntry>;
        this.seedBriefs = this.collections.seed_briefs as unknown as Collection<SeedBrief>;
        this.sampleReviews = this.collections.sample_reviews as unknown as Collection<SampleReview>;
        this.phrases = this.collections.phrases as unknown as Collection<Phrase>;
        this.phraseGroups = this.collections.phrase_groups as unknown as Collection<PhraseGroup>;
        this.groupRevisions = this.collections.group_revisions as unknown as Collection<GroupRevision>;
        this.summaryScores = this.collections.summary_scores as unknown as Collection<SummaryScore>;
    }

    // -- construction -------------------------------------------------------------------

    /**
     * An UNBOUND store with no files behind it — the test path and the "run it in memory" case.
     * It is generic on purpose: ids are `story_0`, `finding_0`, … and nothing is bound to a story,
     * so a unit test never needs a UUID or a filesystem.
     */
    static empty(): Store {
        return new Store(null);
    }

    /**
     * An in-memory store bound to one story UUID — the multi-story test path (two of these hold
     * `finding_0` each, independently, with no filesystem writes).
     *
     * The id is REQUIRED and validated: asking for a story store and quietly getting an unbound
     * one is how two stories end up sharing a journal again. `Store.empty()` is the unbound call.
     */
    static emptyStory(storyId: string): Store {
        return new Store(null, assertStoryId(storyId, 'Store.emptyStory storyId'));
    }

    /**
     * Opens `<rootDir>/store.json` + `<rootDir>/journal.jsonl`. A missing snapshot is not an
     * error: it is the first boot, and the store starts empty pointed at that directory so
     * the first persist creates it (L-3 restart-with-no-lost-state needs both branches).
     *
     * The journal is merged from BOTH files by `seq`. The log is the append-only source and
     * the snapshot's array is the cache; either may be one commit ahead of the other
     * depending on where a kill landed, and merging is what makes that harmless rather than a
     * lost event.
     *
     * `options.storyId` binds the book to one story and cross-checks it against the snapshot, so
     * this directory cannot quietly be another story's book (see {@link Store.loadStory}).
     */
    static async load(rootDir: string, options: StoreOptions = {}): Promise<Store> {
        const storyId = options.storyId ?? null;
        const store = new Store(rootDir, storyId);
        const snapshot = await readSnapshot(rootDir);
        const logged = await readJournal(rootDir);

        if (storyId !== null) assertSnapshotBinding(storyId, rootDir, snapshot);

        // A malformed section (a hand-edit, a half-written array) hydrates as empty for that
        // collection rather than throwing: `readSnapshot` already refused a corrupt FILE, and
        // one bad section must not cost the Author the other sixteen.
        const snapshotRecords = snapshot?.records ?? {};
        const snapshotCounters = snapshot?.counters ?? {};

        for (const name of COLLECTION_NAMES) {
            const records = snapshotRecords[name];

            store.collections[name]._hydrate(
                Array.isArray(records) ? records : [],
                typeof snapshotCounters[name] === 'number' ? snapshotCounters[name] : 0
            );
        }

        const snapshotJournal = snapshot?.journal;

        const merged = mergeEvents(Array.isArray(snapshotJournal) ? snapshotJournal : [], logged);

        // NOT `push(...merged)`: that passes every event as a call argument, and a long-lived
        // book (six figures of journal rows) exhausts the call stack during boot. A loop has
        // the same result without the argument-count ceiling.
        for (const event of merged) store.events.push(event);

        // A malformed settings section does the same thing a malformed collection does: it
        // rehydrates as absent rather than costing the Author the book (see the note above).
        if (
            snapshot?.settings !== null &&
            typeof snapshot?.settings === 'object' &&
            !Array.isArray(snapshot.settings)
        ) {
            for (const [key, value] of Object.entries(snapshot.settings)) {
                store.settings.set(key, copyIn(value));
            }
        }

        // The counter continues from the journal rather than restarting, or a replayed store
        // would hand out seq 1 twice and the digest derivation would read two different
        // commits by the same number.
        store.seq = merged.reduce((highest, event) => Math.max(highest, event.seq), 0);

        return store;
    }

    /**
     * Opens ONE story's book: `<root>/stories/<uuid>/{store.json,journal.jsonl}`. This is what
     * `StoryStores` calls; the story id is validated and cross-checked against the snapshot, so a
     * folder is never opened as the wrong story and a story-bound store never silently adopts a
     * book written before the per-story layout (there is no migration in this build).
     */
    static async loadStory(storyId: string, rootDir: string): Promise<Store> {
        return Store.load(rootDir, { storyId: assertStoryId(storyId, 'Store.loadStory storyId') });
    }

    // -- the journal --------------------------------------------------------------------

    /** The append-only commit journal (P11 audit, D-12a derivation source). */
    get journal(): readonly CommitEvent[] {
        return this.events;
    }

    /**
     * A host setting persisted with the book but outside the §4 record model (U-8's agent models).
     * `undefined` means the setting has never been written; callers own the default.
     */
    setting<T = unknown>(key: string): T | undefined {
        return this.settings.get(key) as T | undefined;
    }

    /**
     * Writes a host setting and schedules the same debounced snapshot a record write uses. Settings
     * are deliberately NOT journaled: they are host configuration, not story state (see `settings`
     * above), and an audit of the Author's book should not be cluttered by model names.
     */
    setSetting(key: string, value: unknown): void {
        this.settings.set(key, copyIn(value));
        this.schedulePersist();
    }

    /** Removes a host setting; a deleted setting is the absence a caller defaults from. */
    deleteSetting(key: string): void {
        if (!this.settings.delete(key)) return;

        this.schedulePersist();
    }

    /**
     * Subscribes to commit groups — the SSE feed's source. Returns the unsubscribe.
     *
     * A listener runs AFTER the writes have landed, never before, so a subscriber that reads
     * the store sees exactly the state the event describes (and never a half-applied commit).
     */
    onCommit(cb: CommitListener): () => void {
        this.listeners.add(cb);

        return () => {
            this.listeners.delete(cb);
        };
    }

    // -- transactions -------------------------------------------------------------------

    /**
     * Applies `fn`'s writes as ONE commit: one journal group, one listener notification, and
     * — when the store has a root — one journal append and one snapshot.
     *
     * This is the primitive the spec's "in the same commit" requirements are built on:
     * D-22 (selection deletes the losers with the selection), L-7 (the lock flag and every
     * `contract_locked` mirror), D-36 (the lock empties the Ideas tray), D-25/L-31 (backtrack
     * unlocks and scraps), D-37a (resume applies the Author's edit, re-derives the Digest and
     * marks dependents). It is NOT a database transaction: there is no isolation, because the
     * runtime is single-threaded and a synchronous write is already atomic; what it adds is
     * (a) all-or-nothing over the several writes one decision needs and (b) one audit group.
     *
     * Rollback is a snapshot/restore of the collection state and the journal, so a commit
     * that throws leaves the store exactly as it was — the loop's commit path can fail and be
     * redispatched without half-applying a decision.
     *
     * A nested `commit()` joins the enclosing group rather than starting a new one; a caught
     * error inside `fn` therefore leaves its earlier writes in the group (no savepoints),
     * which is the behaviour W4 wants for "best effort, then report".
     */
    async commit(label: string, fn: (tx: Store) => void | Promise<void>): Promise<void> {
        if (this.depth > 0) {
            this.depth += 1;

            try {
                await fn(this);
            } finally {
                this.depth -= 1;
            }

            return;
        }

        const rollback = this.snapshotState();
        const previousLabel = this.groupLabel;

        this.group = [];
        this.groupLabel = label;
        this.depth = 1;

        try {
            await fn(this);
        } catch (error) {
            // Undo everything: the maps, the counters, the seq, and any buffered events.
            this.depth = 0;
            this.group = null;
            this.groupLabel = previousLabel;
            this.restoreState(rollback);

            throw error;
        }

        const events = this.group;

        this.depth = 0;
        this.group = null;
        this.groupLabel = previousLabel;

        // A commit that wrote nothing journals nothing — and it must not persist, or a
        // read-only decision would still cost a snapshot.
        if (!events || events.length === 0) return;

        this.events.push(...events);
        this.enqueue(this.journalTask(events.map((event) => JSON.stringify(event))));

        // A copy of the array: a subscriber may sort or filter what it is handed, and that must
        // not reorder the journal it is also reading.
        this.notify([...events]);
        this.schedulePersist();
    }

    // -- durability ---------------------------------------------------------------------

    /**
     * Writes the snapshot (after any queued journal appends, on the same serialised chain).
     * A no-op for the in-memory store, which has nowhere to write.
     */
    async persist(): Promise<void> {
        if (this.rootDir === null) return;

        const rootDir = this.rootDir;

        await this.enqueue(async () => {
            await writeSnapshot(rootDir, this.snapshotFile());
        });
    }

    /**
     * Flushes and stops the debounced timer. Idempotent, and deliberately permissive about
     * further use: the loop's shutdown path closes the store while a late tool result may
     * still be arriving, and throwing there would lose a write rather than delay one.
     */
    async close(): Promise<void> {
        this.clearTimer();

        await this.persist();
    }

    // -- store-internal plumbing --------------------------------------------------------

    /**
     * @internal Journaled record of one mutation. Buffered when a commit is open; otherwise
     * it lands as its own one-event group labelled `<op>:<collection>`, so a write that skips
     * `commit()` is still durable and still auditable — the journal has no bypass.
     */
    _event(
        collection: CollectionName,
        op: CommitOperation,
        id: string,
        attribution: Attribution,
        patch: unknown
    ): void {
        const event: CommitEvent = {
            seq: ++this.seq,
            at: new Date().toISOString(),
            collection,
            op,
            id,
            attribution: copyIn(attribution),
            patch: patch === undefined ? undefined : copyIn(patch),
            commit_label: this.group ? this.groupLabel : `${op}:${collection}`
        };

        if (this.group) {
            this.group.push(event);

            return;
        }

        this.events.push(event);
        this.enqueue(this.journalTask([JSON.stringify(event)]));
        this.notify([event]);
        this.schedulePersist();
    }

    /**
     * @internal The "one production Store is one story" rule, enforced at the write gate.
     *
     * Only records that CARRY a `story_id` are checked (the `Story` row itself has none — it is the
     * story — and `Template`'s is optional). A story-bound store refuses a foreign one rather than
     * storing it: a finding about another story sitting in this folder would be listed, judged and
     * deleted as if it belonged here, and the Author would never see where it came from.
     */
    _assertStoryScope(collection: CollectionName, record: unknown): void {
        if (this.storyId === null) return;

        const value = (record as { story_id?: unknown } | undefined)?.story_id;

        if (typeof value !== 'string' || value.length === 0) return;
        if (value === this.storyId) return;

        throw new StoreError(
            `${collection} names story ${value}, but this store is story ${this.storyId} — one Store is one story, ` +
                `so another story's records live in their own ${STORIES_DIRECTORY}/<uuid>/ folder`
        );
    }

    /**
     * @internal Resolves an id to its collection and current record — id-prefix first (the
     * ids are minted `${singular}_…`), then a full scan for anything hand-authored. The second
     * loop is also how a story-bound store resolves its own UUID story id, which has no prefix.
     */
    _resolveId(id: string): { collection: CollectionName; record: AnyRecord | undefined } | undefined {
        let prefixHit: CollectionName | undefined;

        for (const name of COLLECTION_NAMES) {
            if (!id.startsWith(`${COLLECTION_SINGULARS[name]}_`)) continue;

            prefixHit = name;

            const found = this.collections[name]._find(id);

            if (found) return { collection: name, record: found };
        }

        for (const name of COLLECTION_NAMES) {
            const found = this.collections[name]._find(id);

            if (found) return { collection: name, record: found };
        }

        // Known family, no record: a deletion since it was read. CAS reports it as a conflict
        // with `record: undefined` rather than pretending the rev matched.
        return prefixHit === undefined ? undefined : { collection: prefixHit, record: undefined };
    }

    /**
     * @internal T-4 gate. Every `expects` entry is compared to the CURRENT rev; all mismatches
     * are collected before one throw (an agent that is stale on two records should re-read both
     * rather than fail one at a time), and the error carries the current record of every entry.
     */
    _assertCas(expects: readonly CAS[]): void {
        const currents = expects.map((expect) => {
            const found = this._resolveId(expect.id);

            return { id: expect.id, record: found ? copyIn(found.record) : undefined };
        });

        const stale = expects.filter((expect, index) => {
            const current = currents[index].record as StoredRecord | undefined;

            return current === undefined || current.rev !== expect.rev;
        });

        if (stale.length === 0) return;

        const detail = stale
            .map((expect) => {
                const current = this._resolveId(expect.id)?.record as StoredRecord | undefined;

                return current === undefined
                    ? `${expect.id} no longer exists (expected rev ${expect.rev})`
                    : `${expect.id} is at rev ${current.rev}, the caller expected rev ${expect.rev}`;
            })
            .join('; ');

        throw new CasConflict(
            currents,
            `compare-and-swap rejected (T-4): ${detail} — re-read and re-apply, do not force`
        );
    }

    // -- internals ----------------------------------------------------------------------

    /**
     * Collections + journal state, for the commit rollback. Cheap: records are immutable
     * values (every write replaces the map entry), so copying the maps is enough.
     */
    private snapshotState(): {
        collections: Record<CollectionName, CollectionState<AnyRecord>>;
        settings: Record<string, unknown>;
        seq: number;
        events: number;
    } {
        const collections = {} as Record<CollectionName, CollectionState<AnyRecord>>;

        for (const name of COLLECTION_NAMES) collections[name] = this.collections[name]._state();

        // `events.length`, not `seq`: after a load with a gapped journal the two differ, and
        // the rollback has to drop exactly the events this commit added.
        return {
            collections,
            settings: Object.fromEntries(this.settings),
            seq: this.seq,
            events: this.events.length
        };
    }

    private restoreState(state: {
        collections: Record<CollectionName, CollectionState<AnyRecord>>;
        settings: Record<string, unknown>;
        seq: number;
        events: number;
    }): void {
        for (const name of COLLECTION_NAMES) this.collections[name]._restore(state.collections[name]);

        this.settings.clear();

        for (const [key, value] of Object.entries(state.settings)) this.settings.set(key, value);

        // Buffered events were never published, and published-but-rolled-back ones must not
        // survive either: the journal is a record of what happened, not of what was attempted.
        this.seq = state.seq;
        this.events.length = state.events;

        // A flush scheduled by the rolled-back writes must not fire later and persist a state
        // that never existed.
        this.clearTimer();
    }

    /** The `store.json` payload (P1: this file is the memory). */
    private snapshotFile(): StoreSnapshot {
        const snapshot: StoreSnapshot = {
            version: SNAPSHOT_VERSION,
            counters: {},
            records: {},
            settings: copyIn(Object.fromEntries(this.settings)),
            journal: copyIn(this.events)
        };

        // Only a bound book writes `story_id`: an unbound book's snapshot stays exactly what it
        // was, and a bound one carries the identity `Store.loadStory` cross-checks on the next boot.
        if (this.storyId !== null) snapshot.story_id = this.storyId;

        for (const name of COLLECTION_NAMES) {
            const collection = this.collections[name];

            snapshot.counters[name] = collection._counter();
            snapshot.records[name] = [...collection._values()];
        }

        return snapshot;
    }

    /** Serialises file work so a burst of commits cannot interleave two snapshot writes. */
    private enqueue(task: () => Promise<void>): Promise<void> {
        const run = (): Promise<void> => (this.rootDir === null ? Promise.resolve() : task());
        const next = this.writeChain.then(run, run);

        // The chain itself never rejects: a failed write must not poison every write after it.
        this.writeChain = next.then(
            () => undefined,
            () => undefined
        );

        return next;
    }

    /**
     * Journal appends swallow their own failures. Justification, not convenience: the
     * snapshot carries the same events, so a failed append costs a log line and not a fact —
     * and the next persist writes the whole journal array anyway.
     */
    private journalTask(lines: readonly string[]): () => Promise<void> {
        return async () => {
            if (this.rootDir === null) return;

            try {
                await appendJournal(this.rootDir, lines);
            } catch {
                // Recoverable — see the note above.
            }
        };
    }

    private notify(events: CommitEvent[]): void {
        for (const listener of this.listeners) listener(events);
    }

    /**
     * Coalesces persistence: a sweep commits dozens of times per pass, and each of those as a
     * disk write is a snapshot per tool call. The debounce window is short enough that a crash
     * costs at most the last few commits — and every loop state read goes through the in-memory
     * store, so a crash costs nothing the journal cannot replay.
     */
    private schedulePersist(): void {
        if (this.rootDir === null) return;

        this.clearTimer();

        const timer = setTimeout(() => {
            this.timer = undefined;
            void this.persist().catch(() => undefined);
        }, PERSIST_DEBOUNCE_MS);

        // A debounced flush must never hold a process open (the CLI and the tests both exit
        // through here); the explicit persist()/close() path is the durable one.
        (timer as unknown as { unref?: () => void })?.unref?.();
        this.timer = timer;
    }

    private clearTimer(): void {
        if (this.timer === undefined) return;

        clearTimeout(this.timer);
        this.timer = undefined;
    }
}
