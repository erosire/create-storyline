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
    type Idea,
    type LedgerEntry,
    type Plotline,
    type Proposal,
    type Revision,
    type Run,
    type Story,
    type StoredRecord,
    type Summary,
    type Task,
    type Template,
    type Verdict,
    type RecordInit
} from '../../shared/types';
import {
    SNAPSHOT_VERSION,
    appendJournal,
    readJournal,
    readSnapshot,
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

/** The largest numeric suffix on `<singular>_<n>` ids, so a restart never mints a live id. */
function highestIdSuffix(singular: string, ids: readonly string[]): number {
    let highest = 0;

    for (const id of ids) {
        if (!id.startsWith(`${singular}_`)) continue;

        const suffix = Number(id.slice(singular.length + 1));

        if (Number.isFinite(suffix) && suffix > highest) highest = suffix;
    }

    return highest;
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

// ---------------------------------------------------------------------------
// Collection<T>
// ---------------------------------------------------------------------------

/** The mutable state of one collection — the unit `Store.commit` snapshots and rolls back. */
interface CollectionState<T> {
    records: Map<string, T>;
    counter: number;
}

/**
 * One §4 collection: an ordered (insertion-order) id → record map with the store's write
 * rules applied. Typed accessors live on {@link Store} (`store.chapters`, `store.ideas`, …),
 * so nothing outside the store constructs one.
 *
 * `T` is constrained to records carrying the §4 bookkeeping fields, which is what makes
 * `rev`-based CAS and the `updated_at` stamp type-safe for all 17 collections at once.
 */
export class Collection<T extends StoredRecord> {
    readonly name: CollectionName;
    readonly singular: string;

    private readonly owner: Store;
    private readonly records = new Map<string, T>();
    private counter = 0;

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
     * counter (W1), `rev` starts at 1, and the timestamps are the store's — a caller cannot
     * set any of the three, which is what keeps ids and revs trustworthy as CAS tokens.
     */
    create(init: RecordInit<T>, attribution: Attribution): T {
        requireAttribution(attribution, this.name, 'create');

        const id = `${this.singular}_${++this.counter}`;
        const at = new Date().toISOString();
        const record = { ...copyIn(init), id, rev: 1, created_at: at, updated_at: at } as unknown as T;

        this.records.set(id, record);
        this.owner._event(this.name, 'create', id, attribution, record);

        return copyIn(record);
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
        return { records: new Map(this.records), counter: this.counter };
    }

    /** @internal */
    _restore(state: CollectionState<T>): void {
        this.records.clear();

        for (const [id, record] of state.records) this.records.set(id, record);

        this.counter = state.counter;
    }

    /**
     * @internal Boot hydration (L-3: restart with no lost state). The counter is the HIGHER
     * of the persisted counter and the largest id suffix present, so a hand-edited or
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
            highestIdSuffix(
                this.singular,
                materialised.map((record) => record.id)
            )
        );
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
    // The 17 §4 collections, named exactly as §4 names them (MUST NOT rename — W1).
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

    /** The single registry every generic path (snapshot, CAS resolution, rollback) walks. */
    private readonly collections: Record<CollectionName, Collection<AnyRecord>>;

    private readonly events: CommitEvent[] = [];
    private readonly listeners = new Set<CommitListener>();

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

    private constructor(rootDir: string | null) {
        this.rootDir = rootDir;
        this.collections = {} as Record<CollectionName, Collection<AnyRecord>>;

        for (const name of COLLECTION_NAMES) {
            this.collections[name] = new Collection<AnyRecord>(this, name);
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
    }

    // -- construction -------------------------------------------------------------------

    /** A store with no files behind it — the test path and the "run it in memory" case. */
    static empty(): Store {
        return new Store(null);
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
     */
    static async load(rootDir: string): Promise<Store> {
        const store = new Store(rootDir);
        const snapshot = await readSnapshot(rootDir);
        const logged = await readJournal(rootDir);

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

        store.events.push(...merged);

        // The counter continues from the journal rather than restarting, or a replayed store
        // would hand out seq 1 twice and the digest derivation would read two different
        // commits by the same number.
        store.seq = merged.reduce((highest, event) => Math.max(highest, event.seq), 0);

        return store;
    }

    // -- the journal --------------------------------------------------------------------

    /** The append-only commit journal (P11 audit, D-12a derivation source). */
    get journal(): readonly CommitEvent[] {
        return this.events;
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
     * @internal Resolves an id to its collection and current record — id-prefix first (the
     * ids are minted `${singular}_…`), then a full scan for anything hand-authored.
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
        seq: number;
        events: number;
    } {
        const collections = {} as Record<CollectionName, CollectionState<AnyRecord>>;

        for (const name of COLLECTION_NAMES) collections[name] = this.collections[name]._state();

        // `events.length`, not `seq`: after a load with a gapped journal the two differ, and
        // the rollback has to drop exactly the events this commit added.
        return { collections, seq: this.seq, events: this.events.length };
    }

    private restoreState(state: {
        collections: Record<CollectionName, CollectionState<AnyRecord>>;
        seq: number;
        events: number;
    }): void {
        for (const name of COLLECTION_NAMES) this.collections[name]._restore(state.collections[name]);

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
            journal: copyIn(this.events)
        };

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
