// W1 persistence — the two files the durable store is made of.
//
// WHY A SNAPSHOT PLUS AN APPEND-ONLY LOG (and not a database): P1 says the Dashboard's
// store is the ONLY memory in the system, and L-3 says the loop must restart with no lost
// state. Two plain files satisfy both with no dependency: `store.json` is the current
// snapshot every boot rehydrates, and `journal.jsonl` is the append-only commit history that
// D-12a needs (the Digest is a pure function of committed changes, so any past Digest must be
// reconstructible) and that P11's audit and undo read. A single JSON file cannot serve the
// second role without being rewritten in full on every event.
//
// WHY `store.json` IS WRITTEN tmp+rename: the Author's book must survive a kill in the middle
// of a write (P8 pulls the cord at any moment, and the vertical slice §15 step 4 kills the
// server mid-pass). A partial file would mean a partial book; an atomic rename means boot
// either sees the old snapshot or the new one, never a blend.
//
// WHY NO PERSISTED FILE IS EVER READ BACK AS AN UNTRUSTED SHAPE: §4 is the wire format, and
// `version` exists so a later wave can migrate rather than guess.
//
// WHY ONE DIRECTORY PER STORY (this is the layout, not a convention): a Story IS its records
// (P3), so the FOLDER is the Story's identity boundary — `<root>/stories/<uuid>/` holds that
// story's `store.json`, its own `journal.jsonl` and its own `harness/`. Story-local ids and
// journal `seq` numbers therefore start inside one folder and can never collide with another
// story's, and deleting a story is one validated `rm -r` of one folder. `<root>/server/` is
// reserved for application-level templates and settings, which is why nothing story-scoped may
// be written at `<root>` itself.
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import path from 'node:path';

/**
 * Snapshot format version — bump it with a migration, do not change the layout silently.
 *
 * v2: id counters are ZERO-BASED (`finding_0` is the first finding, and the persisted counter
 * is the NEXT id to mint rather than the last one handed out), and a story Store records its
 * `story_id` in the snapshot so a folder can never be opened as another story. The Author's
 * answer on upgrade is explicit — no migration, no backward compatibility: `probeFlatLayout`
 * refuses a pre-per-story book rather than silently adopting it.
 *
 * v3: the Checker employee KIND is renamed to Reader. The kind is a persisted wire value, not
 * just a label, so a v2 book carries rows a v3 build reads as another story's crew:
 * `templates.name` (`checker-consistency`/`checker-prose`), `templates.roles[].kind`,
 * `crew_runs.role`/`template_ref`, `work_items.key` (`wi_probe_checker_*`), and a loop's
 * `probe.checker_item_id`. Nothing here migrates those strings, so the version moves to mark
 * the format break rather than let a v2 book load as if it were current.
 *
 * v4 (this build): the Reviewed Summary (D-67/D-68) adds persisted STATE, not just fields:
 *   - `group_revisions[].state` gains `'discarded'` — the terminal position the Author's choose
 *     gives every revision its choice passed over, and a v3 build has no reading for it: its
 *     projection filters on nothing, so those rows would come back as live members of the group's
 *     line and a Summary the Author already rejected would be offered as current text;
 *   - `group_revisions[].clean` / `.clean_run_ref` — the Clean stamp a cross-group Critic pass
 *     leaves on the text it read with no unresolved defect on the group; and
 *   - `phrases[].reviewed_vector` / `.reviewed_vector_hash` / `.reviewed_at` — the choice record
 *     the rail and the score join read back.
 *
 * The migration is ONE-DIRECTIONAL and that is the whole reason the number moves: a v4 build reads
 * a v3 book as if the feature had never run (absent `clean` = "never earned a clean pass", absent
 * `reviewed_vector` = "the Author has never chosen", and no v3 book can hold a `discarded` row), so
 * NOTHING is rewritten on load. A v3 build reading a v4 book is the unsafe direction, and the
 * version mismatch is what refuses it loudly instead of displaying rejected prose as the Summary.
 */
export const SNAPSHOT_VERSION = 4;

/** The current-state file (P1: the only memory), written atomically. */
export const STORE_FILE = 'store.json';

/** The append-only commit journal (§4.8 D-12a source, P11 audit). */
export const JOURNAL_FILE = 'journal.jsonl';

/** The tmp name used for the atomic swap; it lives beside the target so the rename stays on one filesystem. */
const STORE_TMP_FILE = `${STORE_FILE}.tmp`;

/**
 * What `store.json` holds. `records` is keyed by the §4 collection names and `counters`
 * carries each collection's id counter so a restart cannot mint an id that already exists.
 * `journal` mirrors the log file so a boot works even if the log was pruned (the commit
 * LABEL each D-12a's derivation reads rides on each event, so it needs no field of its own).
 */
export interface StoreSnapshot {
    version: number;
    counters: Record<string, number>;
    records: Record<string, unknown[]>;
    /**
     * The Story this book belongs to (null/absent = a generic, unbound book such as the
     * server-level template store). It is written by a story-bound Store and cross-checked on
     * load, so `stories/<a>/store.json` opened as story `b` is a loud error instead of a story
     * that quietly shares another story's records.
     */
    story_id?: string | null;
    /**
     * Host settings that live beside the §4 records rather than inside them — today the global
     * employee roster's model choices (U-8). They are not journaled: a model setting is not a story
     * fact and must not enter the Digest's derivation, but it has to survive a restart all the
     * same (L-3), so it rides the same atomic snapshot.
     */
    settings?: Record<string, unknown>;
    journal: unknown[];
}

/** `<rootDir>/store.json` — one place builds the path so the two readers cannot drift. */
export const storeFilePath = (rootDir: string): string => path.join(rootDir, STORE_FILE);

/** `<rootDir>/journal.jsonl`. */
export const journalFilePath = (rootDir: string): string => path.join(rootDir, JOURNAL_FILE);

// ---------------------------------------------------------------------------
// The per-story layout: `<root>/stories/<uuid>/{store.json,journal.jsonl,harness/}`
// ---------------------------------------------------------------------------

/**
 * The directory the stories live in. `<root>/server/` (templates, settings) and `<root>/stories/`
 * are the only two things under a store root; nothing story-scoped may sit at `<root>` itself.
 */
export const STORIES_DIRECTORY = 'stories';

/** The reserved, application-level sibling of `stories/` — the registry never writes inside it. */
export const SERVER_DIRECTORY = 'server';

/**
 * The per-story working directory (§8's harness scratch: run transcripts, the knowledge file).
 * It is created with the story folder so a run never has to guess where its scratch goes, and it
 * is deleted with the folder (D-14: deleting a story deletes the story's data and nothing else).
 */
export const HARNESS_DIRECTORY = 'harness';

/**
 * The id shape: a canonical UUID, any version/variant nibble, case-insensitive.
 *
 * WHY IT IS VALIDATED BEFORE ANY PATH IS BUILT: the id is the folder name, so it is the one
 * string in this layer that a caller-supplied value reaches the filesystem through. A UUID
 * cannot contain `/`, `\`, `.`-dots or NUL, so validating the shape is exactly what makes
 * `join(root, id)` and `rm -r` of that join safe — `../../etc` never gets that far.
 *
 * One pattern, two exported names (see {@link RECORD_UID_PATTERN}): the story id and a record uid
 * have the SAME shape today, and sharing the regex means a shape change is one edit, not two that
 * can silently disagree.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const STORY_ID_PATTERN = UUID_PATTERN;

/** Everything this layer refuses to do, so a caller can tell "bad layout" from a store rule. */
export class StoryLayoutError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'StoryLayoutError';
    }
}

/** True when `value` is a well-formed story id (the only value that may name a story folder). */
export const isStoryId = (value: unknown): value is string =>
    typeof value === 'string' && STORY_ID_PATTERN.test(value);

/**
 * Narrows a story id or refuses, naming what was actually passed. Every filesystem join in this
 * module goes through it — a prompt is not a guard, and neither is a caller's good intentions.
 */
export const assertStoryId = (value: unknown, source = 'story id'): string => {
    if (isStoryId(value)) return value;

    throw new StoryLayoutError(
        `${source} must be a UUID (8-4-4-4-12 hexadecimal), got ${describeValue(value)} — story records live at ` +
            `${STORIES_DIRECTORY}/<uuid>/ and an unvalidated id could escape that root`
    );
};

/** Fresh story identity. Injectable everywhere (`StoryStoresOptions.createStoryId`) for tests. */
export const newStoryId = (): string => randomUUID();

// ---------------------------------------------------------------------------
// Record uids — ids that are ADDRESSES, not counters (Summary Phrase, R1)
// ---------------------------------------------------------------------------

/**
 * The shape of a record id that must be an ADDRESS: the same canonical UUID a story id uses.
 *
 * WHY SOME RECORDS TAKE A UUID AND THE REST KEEP `${singular}_${n}`: a finding's id, a task's id
 * and a run's id are LOCAL LABELS — every reader of one story's book is inside that story, so
 * `finding_0` is unambiguous and the counter keeps the Author's ledger readable. The Summary
 * Phrase's ids are different in kind: a `phrase_groups.id` is named by a ROUTE
 * (`POST /stories/:id/phrases/groups/{groupId}/revise`), by a finding's `group_refs` (R3), by a run
 * row's `group_refs` (R4's exclusion) and by every `group_revisions.group_id`, and the deep review's
 * structured answer quotes them back. An address has to be mintable before the row exists and has
 * to survive a restart unchanged, which a per-collection counter is not suited to (a counter-based
 * id would be re-minted from the counter a hydrating store computes, and a hand-edited book could
 * hand the same label to two groups).
 *
 * `store.ts:createWithId` is the write that preserves a uid; `Collection.create` keeps minting
 * counters for every collection that does not need one, so no existing id in any book changes.
 */
export const RECORD_UID_PATTERN = UUID_PATTERN;

/** True when `value` is a well-formed record uid. */
export const isRecordUid = (value: unknown): value is string =>
    typeof value === 'string' && RECORD_UID_PATTERN.test(value);

/**
 * Fresh record identity (R1). Injectable, exactly like {@link newStoryId}: the phrase module takes
 * the factory as an option so a test can pin the ids instead of asserting against `expect.any(String)`.
 */
export const newRecordUid = (): string => randomUUID();

/**
 * A deterministic uid for the nth record — the factory a deterministic test injects.
 *
 * `00000000-0000-4000-8000-<index>` is a valid v4-shaped UUID for every index below 2^48, so a test
 * that needs readable, ordered, PINNABLE ids (a projection asserting an exact group id, an exclusion
 * test naming two group sets) gets them without any mock, and `assertRecordUid` still accepts them.
 */
export const recordUidAt = (index: number): string =>
    `00000000-0000-4000-8000-${Math.trunc(index).toString(16).padStart(12, '0')}`;

/** `<root>/stories`. */
export const storiesDirectoryPath = (rootDir: string): string => path.join(rootDir, STORIES_DIRECTORY);

/**
 * `<root>/stories/<uuid>` — validated first (see `assertStoryId`), and the join is then re-checked
 * to sit directly inside `stories/`, so a hand-built path from an unvalidated caller is caught too.
 */
export const storyDirectoryPath = (rootDir: string, storyId: string): string => {
    const parent = path.resolve(storiesDirectoryPath(rootDir));
    const target = path.resolve(parent, assertStoryId(storyId));

    if (path.dirname(target) !== parent) {
        throw new StoryLayoutError(
            `story id ${assertStoryId(storyId)} resolves outside ${parent} — it cannot be read or deleted there`
        );
    }

    return target;
};

/** `<root>/stories/<uuid>/harness` — the story's own harness scratch, never a sibling story's. */
export const storyHarnessDirectoryPath = (rootDir: string, storyId: string): string =>
    path.join(storyDirectoryPath(rootDir, storyId), HARNESS_DIRECTORY);

/**
 * What sits at `<root>` that belongs to the pre-per-story layout. The accepted upgrade answer is
 * "no migration", so the registry PROVES the root is clean instead of assuming it: adopting a flat
 * `store.json` silently would make every story share one journal, which is the bug being removed.
 */
export interface FlatLayoutProbe {
    storeFile: string | null;
    journalFile: string | null;
}

export async function probeFlatLayout(rootDir: string): Promise<FlatLayoutProbe> {
    const probe = async (file: string): Promise<string | null> => {
        try {
            const info = await stat(file);

            return info.isFile() ? file : null;
        } catch (error) {
            // Absent = clean. Anything else (a directory in its place, EACCES) must surface: a
            // root the registry cannot read is not a root it may create stories inside.
            if (isMissingFile(error)) return null;
            throw error;
        }
    };

    return { storeFile: await probe(storeFilePath(rootDir)), journalFile: await probe(journalFilePath(rootDir)) };
}

/**
 * The uuid-named story folders under `<root>/stories/`, sorted (a missing `stories/` is a first
 * boot: no stories, not an error).
 *
 * Names that are not uuids are IGNORED rather than fatal — a stray `notes/` or `.DS_Store` shares
 * nothing with the store model, and refusing to boot over it would cost the Author every real
 * story. Anything uuid-named is loaded, and a folder whose `store.json` names a different story
 * fails loudly there (`Store.loadStory`). The on-disk name is returned verbatim (case included) so
 * the path this list hands back is always the path that exists.
 */
export async function listStoryIds(rootDir: string): Promise<string[]> {
    const parent = storiesDirectoryPath(rootDir);

    let entries: Dirent[];

    try {
        entries = await readdir(parent, { withFileTypes: true });
    } catch (error) {
        if (isMissingFile(error)) return [];
        throw error;
    }

    return entries
        .filter((entry) => entry.isDirectory() && isStoryId(entry.name))
        .map((entry) => entry.name)
        .sort();
}

/**
 * Creates `<root>/stories/<uuid>/` and its `harness/` child (idempotent), returning the story
 * directory. The harness folder is made here, eagerly, because the layout promises it exists for
 * every story — a run that has to create it is a run that can put it somewhere else.
 */
export async function createStoryDirectory(rootDir: string, storyId: string): Promise<string> {
    const dir = storyDirectoryPath(rootDir, storyId);

    await mkdir(dir, { recursive: true });
    await mkdir(path.join(dir, HARNESS_DIRECTORY), { recursive: true });

    return dir;
}

/**
 * Recursively removes ONE story's directory. The id is validated, the join is re-checked against
 * the `stories/` parent, and the parent itself is refused explicitly, so this can never take the
 * store root (or a sibling story) with it. `force: true` makes it idempotent — a purge of a folder
 * that is already gone is a purge that succeeded.
 */
export async function removeStoryDirectory(rootDir: string, storyId: string): Promise<void> {
    const parent = path.resolve(storiesDirectoryPath(rootDir));
    const target = storyDirectoryPath(rootDir, storyId);

    if (target === parent) {
        throw new StoryLayoutError(
            `refusing to remove ${parent} as a story directory — that is the stories root, not one story`
        );
    }

    await rm(target, { recursive: true, force: true });
}

/** A value in an error message that stays readable for `undefined`, `''`, and objects. */
function describeValue(value: unknown): string {
    if (typeof value === 'string') return value.length === 0 ? 'an empty string' : `"${value}"`;
    if (value === undefined) return 'nothing';
    if (value === null) return 'null';

    return JSON.stringify(value) ?? String(value);
}


/**
 * Reads the snapshot, or `null` when the store has not been persisted yet (the missing-file
 * case IS the "first boot" case for `Store.load`, so it is not an error).
 *
 * A snapshot that fails to parse is NOT silently treated as empty — an empty store on top of
 * a corrupted file would let the next persist overwrite the Author's book with nothing. It
 * throws, naming the path.
 */
export async function readSnapshot(rootDir: string): Promise<StoreSnapshot | null> {
    const file = storeFilePath(rootDir);

    let raw: string;

    try {
        raw = await readFile(file, 'utf-8');
    } catch (error) {
        if (isMissingFile(error)) return null;
        throw error;
    }

    try {
        return JSON.parse(raw) as StoreSnapshot;
    } catch {
        throw new Error(`store snapshot is not valid JSON (${file}); refusing to boot over a corrupted store`);
    }
}

/** Writes the snapshot atomically: `<rootDir>` is created on demand, tmp file then rename. */
export async function writeSnapshot(rootDir: string, snapshot: StoreSnapshot): Promise<void> {
    await mkdir(rootDir, { recursive: true });

    const tmp = path.join(rootDir, STORE_TMP_FILE);

    await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8');
    await rename(tmp, storeFilePath(rootDir));
}

/**
 * Appends journal lines (each already a complete JSON string). One `appendFile` per commit
 * group rather than one per event: the group is the atomic unit the loop reasons about, and
 * a line-per-event write would triple the syscalls for a selection commit.
 */
export async function appendJournal(rootDir: string, lines: readonly string[]): Promise<void> {
    if (lines.length === 0) return;

    await mkdir(rootDir, { recursive: true });
    await appendFile(journalFilePath(rootDir), `${lines.join('\n')}\n`, 'utf-8');
}

/**
 * Reads the journal log. A truncated final line (the process died mid-append) is dropped
 * rather than fatal: it is a torn write of an event the snapshot already has or never had,
 * and refusing to boot over it would cost more than the one event it might lose.
 */
export async function readJournal(rootDir: string): Promise<unknown[]> {
    let raw: string;

    try {
        raw = await readFile(journalFilePath(rootDir), 'utf-8');
    } catch (error) {
        if (isMissingFile(error)) return [];
        throw error;
    }

    const events: unknown[] = [];

    for (const line of raw.split('\n')) {
        const trimmed = line.trim();

        if (trimmed.length === 0) continue;

        try {
            events.push(JSON.parse(trimmed));
        } catch {
            // Torn trailing write — see the note above.
            continue;
        }
    }

    return events;
}

/** `ENOENT` only — any other read error must surface rather than look like an empty store. */
function isMissingFile(error: unknown): boolean {
    return (error as { code?: string } | null)?.code === 'ENOENT';
}
