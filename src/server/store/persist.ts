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
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Snapshot format version — bump it with a migration, do not change the layout silently. */
export const SNAPSHOT_VERSION = 1;

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
    journal: unknown[];
}

/** `<rootDir>/store.json` — one place builds the path so the two readers cannot drift. */
export const storeFilePath = (rootDir: string): string => path.join(rootDir, STORE_FILE);

/** `<rootDir>/journal.jsonl`. */
export const journalFilePath = (rootDir: string): string => path.join(rootDir, JOURNAL_FILE);

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
