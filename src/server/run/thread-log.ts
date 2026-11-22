// The retained thread record: one line per thread a Story's harness ever ran.
//
// WHY A FILE AND NOT A §4 COLLECTION: a thread is harness state, not a book record. The
// engine's own thread records are in-memory and capped (MAX_THREAD_RECORDS), so the Author's
// "all threads are retained for revision" cannot be met by asking the live harness. This log
// keeps exactly the two things the thread surface renders — the request and the answer — beside
// the metadata the bars need (phase, role, state, times, tokens). It lives under
// `<storeRoot>/harness/threads.jsonl`, outside every session, so disposing a harness or
// restarting the process does not take the history with it.
//
// APPEND-ONLY IN THE NORMAL PATH. A completed thread is one JSON line, which keeps the write
// cheap and the file readable after a crash. Only deleting a Story rewrites the file, because
// P1 says a Story's threads go with it.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RoleKind, StoryPhase } from '../../shared/types';

/** The four states a thread bar can read. */
export type StoryThreadState = 'running' | 'torn_down' | 'failed' | 'abandoned';

/** One retained thread, field-for-field what `GET /agents/:kind/threads` renders. */
export interface StoryThreadRecord {
    /** The engine thread id; stable for the life of this record. */
    thread_id: string;
    /** The Storyline Run row this thread belongs to (a panel's N threads share one id). */
    run_id: string;
    story_id: string;
    /** The Story's title at the time the thread closed (the route refreshes it from the book). */
    story_title: string;
    /** The phase session (the UI's "phrase") the thread ran in. */
    phase: StoryPhase;
    role: RoleKind;
    /** The role name shown on the bar (`writer`, `editor#agent_2`, a delegated role). */
    role_name: string;
    /** What the thread was asked to do, in one line. */
    title: string;
    state: StoryThreadState;
    started_at: string;
    ended_at?: string;
    tokens: number;
    /** The full brief/ask the thread was given. */
    request: string;
    /** The thread's final answer, or empty while it is still running. */
    answer: string;
    /** The failure text when the thread ended without an answer. */
    error?: string;
    /** False for a legacy Run row whose pre-retention transcript is gone. */
    retained: boolean;
}

const THREAD_LOG_DIRECTORY = 'harness';
const THREAD_LOG_FILE = 'threads.jsonl';

/**
 * The process's thread history. `memory()` is the in-memory run (tests and `Store.empty()`);
 * `open(storeRoot)` reads the JSONL and appends to it.
 */
export class StoryThreadLog {
    private readonly file: string | null;
    private records: StoryThreadRecord[];

    private constructor(file: string | null, records: StoryThreadRecord[]) {
        this.file = file;
        this.records = records;
    }

    /** The in-memory log (no durability, nothing left behind). */
    static memory(): StoryThreadLog {
        return new StoryThreadLog(null, []);
    }

    /** The durable log beside the book. A null root is the documented in-memory run. */
    static open(storeRoot: string | null): StoryThreadLog {
        if (storeRoot === null) return StoryThreadLog.memory();

        const file = path.join(path.resolve(storeRoot), THREAD_LOG_DIRECTORY, THREAD_LOG_FILE);
        let records: StoryThreadRecord[] = [];

        try {
            if (existsSync(file)) {
                records = readFileSync(file, 'utf8')
                    .split('\n')
                    .filter((line) => line.trim().length > 0)
                    .map((line) => JSON.parse(line) as StoryThreadRecord)
                    .filter((record) => typeof record?.thread_id === 'string');
            }
        } catch {
            // A corrupt log must not keep the server from booting; the in-memory history the
            // process builds from here is still usable, and the next completion appends cleanly.
            records = [];
        }

        return new StoryThreadLog(file, records);
    }

    /**
     * Retain one completed thread. The in-memory record always lands; the disk write is
     * best-effort because a full disk must not fail the run that just ended (S-3 is about the
     * row's teardown, not a log line).
     */
    append(record: StoryThreadRecord): void {
        this.records.push(record);

        if (this.file === null) return;

        try {
            mkdirSync(path.dirname(this.file), { recursive: true });
            appendFileSync(this.file, `${JSON.stringify(record)}\n`, 'utf8');
        } catch {
            // Best-effort: the live harness still holds the record for this process.
        }
    }

    /** Every retained thread of one kind, oldest first. */
    list(kind?: RoleKind): StoryThreadRecord[] {
        const rows = kind === undefined ? this.records : this.records.filter((record) => record.role === kind);

        return [...rows].sort(
            (left, right) =>
                left.started_at.localeCompare(right.started_at) || left.thread_id.localeCompare(right.thread_id)
        );
    }

    /** P1: deleting a Story deletes its threads. Rewrites the file so nothing is left behind. */
    removeStory(storyId: string): void {
        this.records = this.records.filter((record) => record.story_id !== storyId);

        if (this.file === null) return;

        try {
            mkdirSync(path.dirname(this.file), { recursive: true });
            writeFileSync(
                this.file,
                this.records.map((record) => JSON.stringify(record)).join('\n') + (this.records.length > 0 ? '\n' : ''),
                'utf8'
            );
        } catch {
            // Same reasoning as `append`: the rewrite is durability, never the deletion itself.
        }
    }
}
