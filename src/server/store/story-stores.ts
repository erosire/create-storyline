// The multi-story registry: `<root>/stories/<uuid>/`, one Store per story, and nothing else.
//
// WHY THIS MODULE EXISTS: P3 says a Story IS its records, so the Story's identity boundary has to
// be the boundary of its memory too. Before this, one flat `store.json` at `<root>` held every
// story, which meant every story shared one id counter, one journal, and one delete story — a
// `findings_7` in one book was indistinguishable from a `findings_7` in another, and purging a
// story was a predicate over shared state. Here the FOLDER is the story: `StoryStores` opens a
// store root, finds the story folders, and hands out one `Store` per UUID. Child ids
// (`finding_0`, `revision_0`, …) and journal `seq` numbers are therefore LOCAL to one story, and
// deleting a story is one validated recursive remove.
//
// WHY IT IS A REGISTRY AND NOT A COLLECTION INSIDE `Store`: the alternative — a global map of
// stories hidden behind the store — would put the story list inside the thing that is supposed to
// be per-story (chicken-and-egg boot order, and every unit test inheriting global state). This
// class holds no story data of its own: it owns ids, paths, and the fan-in subscription. The
// server-level book (templates, settings) lives under `<root>/server/` and is another caller's
// wiring, not a story.
//
// WHY EVERY ID IS VALIDATED BEFORE A PATH IS BUILT: the id IS the directory name, so `join` and
// `rm -r` take their safety from `assertStoryId` (persist.ts). A caller cannot escape the
// `stories/` root with `../evil`, and the registry would rather throw than ask.
import path from 'node:path';
import {
    createStoryDirectory,
    listStoryIds,
    newStoryId,
    probeFlatLayout,
    removeStoryDirectory,
    storyDirectoryPath,
    STORY_ID_PATTERN,
    STORIES_DIRECTORY,
    assertStoryId,
    StoryLayoutError,
    type FlatLayoutProbe
} from './persist';
import { Store, type CommitEvent } from './store';

// ---------------------------------------------------------------------------
// The shapes P2 (routes/engine) codes against
// ---------------------------------------------------------------------------

/** One open story: its UUID, the directory it is persisted in (`null` = in-memory), its Store. */
export interface StoryEntry {
    readonly id: string;
    readonly root: string | null;
    readonly store: Store;
}

/**
 * One commit, tagged with the story it happened in.
 *
 * The fan-in listener cannot get this from the events alone: two stories both journal
 * `finding_0` with `seq` 1, so the story id is what makes a shared SSE feed (or a shared digest
 * derivation) addressable at all.
 */
export interface StoryCommit {
    readonly storyId: string;
    readonly root: string | null;
    readonly events: readonly CommitEvent[];
}

export type StoryCommitListener = (commit: StoryCommit) => void;

export interface StoryStoresOptions {
    /**
     * Fresh story identity. Defaults to `node:crypto`'s `randomUUID`; a test injects a fixed
     * sequence and then asserts exact ids instead of a shape. Whatever it returns is still
     * validated (`assertStoryId`), so an injected factory cannot smuggle in `story_1`.
     */
    createStoryId?: () => string;
}

// ---------------------------------------------------------------------------
// StoryStores
// ---------------------------------------------------------------------------

/**
 * The set of stories under one store root.
 *
 * Lifetime: `await StoryStores.open(root)` (or `StoryStores.inMemory()` for tests and for
 * `--store-root ""`) → `list`/`get`/`require`/`create`/`remove` → `await close()`.
 *
 * Deliberately synchronous for reads (`get`/`require`/`list`) because the Stores are already
 * loaded in memory at open time and every store read is synchronous; only the operations that
 * touch the filesystem (open, create, remove, persistAll, close) are async.
 */
export class StoryStores {
    /** The store root (`<root>`), or `null` for the in-memory registry. */
    readonly root: string | null;

    /** Open stories, in insertion order (open() loads them sorted by folder name). */
    private readonly entries = new Map<string, StoryEntry>();

    /** The fan-in listeners; each open store relays its commits into this set. */
    private readonly listeners = new Set<StoryCommitListener>();

    private readonly createStoryId: () => string;

    /** `close()` has run; further use is permissive (see `Store.close`'s reasoning). */
    private closed = false;

    private constructor(root: string | null, options: StoryStoresOptions = {}) {
        this.root = root === null ? null : path.resolve(root);
        this.createStoryId = options.createStoryId ?? newStoryId;
    }

    // -- construction -------------------------------------------------------------------

    /**
     * Opens a store root: rejects the old flat layout, then loads every `<root>/stories/<uuid>/`.
     *
     * `root === null` is the in-memory registry (`--store-root ""`), which behaves identically
     * except that it writes nothing anywhere. A missing `stories/` directory is a first boot —
     * zero stories, not an error.
     */
    static async open(root: string | null, options: StoryStoresOptions = {}): Promise<StoryStores> {
        // In-memory: the registry behaves identically, it just has nowhere to write.
        if (root === null) return new StoryStores(null, options);

        const base = path.resolve(root);

        // THE OLD FLAT LAYOUT IS REFUSED, NOT ADOPTED. This build has no migration and no backward
        // compatibility, and adopting it silently is the exact bug being removed: one journal and
        // one id counter shared by every story. The error names the file and the fix.
        assertCleanRoot(await probeFlatLayout(base), base);

        const registry = new StoryStores(base, options);

        for (const id of await listStoryIds(base)) {
            // `loadStory` cross-checks `store.json`'s `story_id` against the folder name, so a
            // folder holding another story's book fails here rather than joining the wrong story.
            const dir = storyDirectoryPath(base, id);

            registry.attach({ id, root: dir, store: await Store.loadStory(id, dir) });
        }

        return registry;
    }

    /** The registry with no filesystem behind it — two stories, two Stores, zero writes. */
    static inMemory(options: StoryStoresOptions = {}): StoryStores {
        return new StoryStores(null, options);
    }

    // -- reads --------------------------------------------------------------------------

    /** Every open story, as `{id, root, store}`, in open() order. */
    list(): StoryEntry[] {
        return [...this.entries.values()];
    }

    /** The open story ids. */
    ids(): string[] {
        return [...this.entries.keys()];
    }

    count(): number {
        return this.entries.size;
    }

    /** True when `storyId` (any value at all — a route param, a parsed body) is an open story. */
    has(storyId: unknown): boolean {
        return typeof storyId === 'string' && this.entries.has(storyId);
    }

    /**
     * The story's Store, or `undefined` when it is not open. A malformed id is `undefined` too:
     * this is the read where absence is a valid answer, and the caller decides between 404 and 400.
     */
    get(storyId: unknown): Store | undefined {
        return this.entry(storyId)?.store;
    }

    /** The story's Store, or a thrown error that names what a bad id was. */
    require(storyId: unknown): Store {
        const entry = this.entry(storyId);

        if (entry) return entry.store;

        throw new StoryLayoutError(
            `no story ${describe(storyId)} is open under ${this.root ?? '<memory>'} — story ids are UUIDs, and ` +
                `only ${STORIES_DIRECTORY}/<uuid>/ folders are stories`
        );
    }

    /** The whole entry (id + root + store), or `undefined`. */
    entry(storyId: unknown): StoryEntry | undefined {
        if (typeof storyId !== 'string') return undefined;

        return this.entries.get(storyId);
    }

    /** The directory one story is persisted in, or `null` in-memory. Throws on an unknown id. */
    rootOf(storyId: unknown): string | null {
        const entry = this.entry(storyId);

        if (entry) return entry.root;

        throw new StoryLayoutError(`no story ${describe(storyId)} is open under ${this.root ?? '<memory>'}`);
    }

    // -- story lifecycle ----------------------------------------------------------------

    /**
     * Opens a NEW story: assigns the UUID, creates `<root>/stories/<uuid>/` (plus its `harness/`),
     * and binds a fresh Store to that UUID.
     *
     * The registry — not the caller, and certainly not a `stories_<n>` counter — owns the id, so
     * `entry.store.stories.create(...)` later mints exactly this UUID (`Store` wires the story id in
     * as its `stories` collection's id factory).
     *
     * The empty book is persisted immediately: the binding must be on disk before the first run, so
     * a crash between "created" and "ran" restarts as the same story rather than as a folder whose
     * `store.json` names no story at all.
     */
    async create(storyId?: string): Promise<StoryEntry> {
        // An explicit id is validated exactly like a minted one — it becomes a directory name.
        const id = assertStoryId(storyId === undefined ? this.mintId() : storyId, 'story id');

        if (this.entries.has(id)) {
            throw new StoryLayoutError(`story ${id} is already open under ${this.root ?? '<memory>'}`);
        }

        let entry: StoryEntry;

        if (this.root === null) {
            entry = { id, root: null, store: Store.emptyStory(id) };
        } else {
            const root = this.root;

            // The folder (and its `harness/` child) is made before the Store points at it, and the
            // book is LOADED rather than assumed empty: a folder created outside this process may
            // already hold a `store.json`, and `loadStory` is what cross-checks its story_id binding.
            const dir = await createStoryDirectory(root, id);

            entry = { id, root: dir, store: await Store.loadStory(id, dir) };
        }

        this.attach(entry);

        if (entry.root !== null) await entry.store.persist();

        return entry;
    }

    /**
     * Purges ONE story: flushes its Store, removes `<root>/stories/<uuid>/` recursively, and drops
     * the entry. Nothing else is touched — not a sibling story's folder, not `<root>/server/`, not
     * the store root itself (`removeStoryDirectory` re-checks the join).
     *
     * Returns whether the story was open. The filesystem folder is removed either way, so purging
     * a story the registry never loaded still leaves the root clean; purging twice is a purge that
     * succeeded twice.
     */
    async remove(storyId: unknown): Promise<boolean> {
        // Validated FIRST: `rm -r` is the only destructive call in this module, and it must never
        // receive a path built from an unvalidated string.
        const id = assertStoryId(storyId, 'story id');
        const entry = this.entries.get(id);

        this.entries.delete(id);

        if (entry) {
            try {
                await entry.store.close();
            } catch {
                // The book is about to be deleted, so a failed last flush costs nothing — refusing
                // the delete would strand a story folder the Author has already removed.
            }
        }

        if (this.root !== null) await removeStoryDirectory(this.root, id);

        return entry !== undefined;
    }

    // -- the fan-in ---------------------------------------------------------------------

    /**
     * Subscribes to EVERY story's commits — the open ones and the ones created later — and returns
     * the unsubscribe. This is what a single SSE feed over all stories attaches to: a per-store
     * `Store.onCommit` would miss the next story the Author creates.
     */
    onCommit(listener: StoryCommitListener): () => void {
        this.listeners.add(listener);

        return () => {
            this.listeners.delete(listener);
        };
    }

    /** Flushes every open story (the debounced timers are the only thing outstanding). */
    async persistAll(): Promise<void> {
        for (const entry of this.entries.values()) await entry.store.persist();
    }

    /**
     * Flushes and stops every story's debounced timer. Idempotent, and deliberately permissive
     * about further use — see `Store.close`.
     */
    async close(): Promise<void> {
        this.closed = true;

        for (const entry of this.entries.values()) await entry.store.close();
    }

    /** @internal Whether `close()` has run; P2's shutdown ordering may read it. */
    isClosed(): boolean {
        return this.closed;
    }

    // -- internals ----------------------------------------------------------------------

    /** Adds an entry and relays its commits into the fan-in set (that is how future stories join). */
    private attach(entry: StoryEntry): void {
        this.entries.set(entry.id, entry);

        // One relay per store, attached once. It checks membership on every event, so an entry
        // removed by `remove()` stops emitting without anyone having to unsubscribe the store.
        entry.store.onCommit((events) => {
            if (!this.entries.has(entry.id) || this.listeners.size === 0) return;

            for (const listener of this.listeners) listener({ storyId: entry.id, root: entry.root, events });
        });
    }

    /**
     * Mints a fresh story id through the injected factory and proves it is a UUID. A factory that
     * returns `story_1` would otherwise become a directory called `story_1` and re-open the exact
     * collision this layout exists to close.
     */
    private mintId(): string {
        const id = this.createStoryId();

        if (!STORY_ID_PATTERN.test(id)) {
            throw new StoryLayoutError(
                `the story id factory returned ${describe(id)}, which is not a UUID — story folders are named by UUID`
            );
        }

        return id;
    }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Refuses a store root that still carries the pre-per-story flat layout. The message names the
 * offending files (so the Author can find them) and the target layout (so the fix is obvious);
 * there is no migration in this build, so silence would be data loss by another route.
 */
function assertCleanRoot(flat: FlatLayoutProbe, root: string | null): void {
    const found = [flat.storeFile, flat.journalFile].filter((file): file is string => file !== null);

    if (found.length === 0) return;

    throw new StoryLayoutError(
        `${found.join(' and ')} ${found.length === 1 ? 'is' : 'are'} the pre-per-story layout, which this build does ` +
            `not migrate: every story needs its own ${STORIES_DIRECTORY}/<uuid>/ folder holding store.json, ` +
            `journal.jsonl and harness/, so move or remove the files under ${root ?? '<memory>'} first`
    );
}

/** An unknown value in an error message, readable for `undefined`, `null`, `''` and objects. */
function describe(value: unknown): string {
    if (typeof value === 'string') return value.length === 0 ? 'an empty id' : `"${value}"`;
    if (value === undefined) return 'nothing';
    if (value === null) return 'null';

    return JSON.stringify(value) ?? String(value);
}
