// The review chain (R-C): the server-side orchestration that makes "once the plot
// updates, the Writer reviews" happen without the UI driving it.
//
// THE SHAPE OF THE PROBLEM. Three agents share one Title, and the user's rule is that
// they keep handing it to each other until it holds together. The UI cannot own that: a
// panel cannot know that an editor's re-order invalidates chapter three, and a browser
// tab that closes mid-chain would stop the story. So the rule lives here, on the server,
// inside the session's own harness.
//
// WHY THE SEAM IS THE PROGRESS CLOSURE. A preset's `create(settings, progress, report)`
// runs once PER SESSION with a progress closure bound to that session
// (harness src/server/harnesses/types.ts:201), and the store builds exactly one harness
// per session (src/server/sessions.ts:2082, 2182-2197). Every run of that session — a
// REST turn, a delegated child, a thread this file starts — reports through THAT closure.
// Wrapping it is therefore the only place in this package that sees every run of one
// Title, with no new subscription, no polling, and no change to `packages/underload/**`.
//
// WHAT COUNTS AS A TURN COMPLETING. A `done` frame ENDS a run only when it carries no
// `pending` work. The runtime emits `done` for a tool-free answer even when the run is
// merely PAUSED on background work it is still waiting on (src/harness.ts:9778 —
// `emit(run, { type: 'done', agent, message, pending })` followed by `waitForWork` and
// `continue`), and only the later, fully drained one is terminal (src/harness.ts:9811).
// `HarnessEvent`'s own contract states it (`src/types/index.ts:2618`: "`pending` non-empty
// means the run is NOT terminal"). Treating the first of those as terminal is the T13
// defect: one run fired the chain twice and re-counted the same hop at depth 1 both times,
// so one writer turn that delegated an edit produced two identical review tasks and overran
// the depth cap. The rule here is therefore:
//
//   `done` + non-empty `pending`  → the run is pausing; keep its window (same baseline,
//                                   same depth) so the record-change accounting keeps
//                                   running across the pause, and chain nothing.
//   `done` with no `pending`      → terminal: complete the window EXACTLY once, with the
//                                   depth the run was armed with, and mark the invocation
//                                   settled so a second terminal frame for it is ignored
//                                   rather than falling back to a fresh `{startRev: 0}`
//                                   window (the fallback that made the double fire win).
//   `error`                       → terminal, and never chains.
//
// Two identities ride along, and only one of them is stable:
//
//   event.thread.id   — the INVOCATION id of this run (fresh every run)
//   record.id         — the PERSISTENT conversation the run executed in
//
// They join through `HarnessThreadRecord.invocationId`, which the runtime publishes
// BEFORE the run's first frame (src/harness.ts:5148 — "publish the run on its thread
// AFTER the invocation id exists"), and at most one run per thread is live because the
// actor queue serializes them. So the join is a read, not a guess.
//
// WHY ONLY A ROOT HOST THREAD TRIGGERS. The UI addresses an agent through a HOST thread
// (`origin: 'host'`, opened by `createThread`) and that conversation is what the user
// sees and keeps typing into. Everything else is somebody else's work in progress:
//   - a delegated child's frames carry `thread.parentId` (src/harness.ts:10301), and a
//     fork/autoanswer additionally carries `thread.kind` (:10291). The writer asking the
//     reader for a quick opinion must not light up the chain, because the writer is still
//     mid-turn and will act on that answer itself;
//   - `ownerThreadId` is checked as well as `parentId`, because a delegation child OF A
//     HOST THREAD is itself a host thread (src/types/index.ts:2430) — `origin` alone
//     would not filter it out;
//   - an agent's DEFAULT conversation (`origin: 'agent'`) is where a ROOT delegation and a
//     legacy `/messages` turn write, and its frames carry NO `thread` at all
//     (src/harness.ts:6314). That is why this observer never REQUIRES `thread`: a writer
//     root turn simply passes through unchained, which is the honest reading of "a turn
//     in a conversation the user is not addressing through the roster".
//   - the agent's NAME is never checked against the roster: `rules.next` is the roster
//     filter, so an operator who renames a member or adds one changes the chain through
//     the environment alone.
//
// WHY THE RECORD-CHANGE GATE. An agent can spend a whole turn reading, quoting and
// concluding without touching the Title. Chaining on that would spin: editor reads,
// writes nothing, writer re-reads, writes nothing, forever. So a completion counts only
// when the session's RECORD STORE actually moved — the store-wide watermark
// (`records().storeRev`) is captured when the run starts and compared when it ends. That
// is the engine's own fact (monotonic per committed call, rewound by `reset()`, silent for
// a rejected call), not a heuristic over the agent's prose.
//
// WHAT THE TRIGGER DOES. It hands the next agent a self-contained task on that agent's
// host thread — the same conversation the user talks to, or a fresh one labelled
// `storyline` when the user has not opened that agent — through `harness.sendThreadInput`
// (src/harness.ts:5404). It deliberately does NOT create a session turn: the store's
// submit route (`POST /sessions/{id}/tasks`) is a USER action with queueing, steering and
// cancellation rules, and an agent-to-agent handoff is not one. The consequence is honest
// and stated for the client: the chained run shows up as `records.updated` stream frames
// (the store's harness subscription fires for any record write, from any path) plus the
// thread's own row, which a client reads from `GET /sessions/{id}/threads`.
//
// WHY THE TURN PATH IS NOT AVAILABLE HERE (T11, checked rather than assumed). The obvious
// alternative — submitting the chained task exactly as `POST /sessions/{id}/tasks` does, so
// it gets a turn row, a display document and a status — needs the SESSION STORE, and the
// store owns that route (`src/server/sessions.ts:8098`, the one call site that wraps a run
// in `runContexts`). A preset's `create(settings, progress, report)` receives none of it:
// `RunnerSettings` is only `{ baseURL, apiKey, model }` (harness
// src/server/harnesses/types.ts:21), `HarnessPresetReport` carries the host hooks and no
// store (types.ts:33), and the handle itself exposes no task/queue member — its thread
// surface is `threads/thread/threadMessages/createThread/sendThreadInput/steerThread/
// stopThread/deleteThread` (src/types/index.ts:3235 onwards, the object built at
// src/harness.ts:11750). This package must not edit `packages/underload/**`, so the chain
// stays on `sendThreadInput` and the CLIENT makes it readable: the conversation's entries
// are read over `GET .../threads/{id}/transcript/messages` and folded into the transcript
// (src/dashboard/plugins/agents.ts and ./turns.ts), because a run always appends to the
// conversation whether or not a turn was minted for it.
//
// WHY A MICROTASK SITS BETWEEN THE `done` AND THE TRIGGER. `progress` is AWAITED by the
// run that emitted the frame (src/harness.ts:6330) and at that moment that run is still
// active. Starting the next run inside the callback would nest two runs of one harness
// and inherit the store's turn-recording scope (`runContexts`, src/server/sessions.ts:2189),
// splicing the chained agent's frames into the turn record that had just closed. One
// microtask lets the completing run finish its bookkeeping first; it is still the same
// tick, so a test sees the trigger land after a single `await`.
//
// DEPTH, AND WHY IT IS IN-MEMORY. Every chained run is armed with the depth its trigger
// sat at, and a chain stops when the next hop would exceed `STORYLINE_CHAIN_DEPTH`. The
// maps are process state: a restart drops the chains that were mid-flight, which is the
// right failure mode — a Title whose agents were passing it around waits for the next
// user turn instead of resurrecting a half-thought.
//
// Cross-references:
//   - ./presets.ts     — attaches `observe` to the progress closure of every session
//   - ./config.ts      — `resolveChainRules` (STORYLINE_CHAIN / STORYLINE_CHAIN_DEPTH)
//   - ./collections.ts — the collections whose ids appear in a triggered task
import type { Harness, HarnessEvent, HarnessThreadRecord } from '@underload/harness';
import type { StorylineChainRules } from './config';

// ---------------------------------------------------------------------------
// Names and bounds
// ---------------------------------------------------------------------------

/**
 * The label every server-opened chained thread carries. The UI can show it, and it is how
 * a client tells a conversation the server started from one the human started.
 */
export const STORYLINE_THREAD_LABEL = 'storyline';

/** A triggered task names at most this many changed records, then summarises the rest. */
export const STORYLINE_TASK_RECORD_LIMIT = 12;

/** Runs watched before the oldest window is dropped (a run that never settled). */
export const STORYLINE_RUN_WINDOW_LIMIT = 64;

/** Arms kept before the oldest is dropped (a delivery whose run never started). */
export const STORYLINE_ARM_LIMIT = 16;

/** How much trigger history is retained for diagnostics and for the tests. */
export const STORYLINE_TRIGGER_HISTORY_LIMIT = 25;

/** The environment name printed in the depth-cap message, so the log names its own knob. */
export const STORYLINE_CHAIN_DEPTH_ENVIRONMENT = 'STORYLINE_CHAIN_DEPTH';

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/** One chained task this orchestrator handed out, oldest first. */
export type StorylineTriggerRecord = {
    /** The agent whose finished turn caused it. */
    from: string;
    /** The agent that received the task. */
    agent: string;
    /** The persistent thread it was delivered on. */
    threadId: string;
    /** How deep in the chain the hop is (1 = the first hop after the user's own turn). */
    depth: number;
    /** The prompt the receiving agent got, verbatim. */
    task: string;
};

/** How a task is delivered. The default is `harness.sendThreadInput(threadId, task)`. */
export type StorylineTaskDelivery = (agent: string, threadId: string, task: string) => Promise<unknown> | void;

export type StorylineOrchestratorOptions = {
    /**
     * The session's harness — a GETTER, because the preset must wrap the progress closure
     * BEFORE the harness exists (the closure is a constructor argument).
     */
    harness: () => Harness | undefined;
    /** The chain rules. The default is "no chaining", so an unwired harness stays inert. */
    rules?: StorylineChainRules;
    /** Override the delivery (a test, or a host that owns its own queue). */
    deliver?: StorylineTaskDelivery;
    /** Where a failure goes. Defaults to `console.warn`. A throw never reaches the run. */
    report?: (message: string) => void;
    /**
     * Scheduling of the deferred trigger. Defaults to `queueMicrotask`; a test may pass a
     * synchronous runner to make the ordering explicit.
     */
    schedule?: (run: () => Promise<void>) => void;
};

export type StorylineOrchestrator = {
    /** Feed it one progress event. Synchronous, and never throws. */
    observe: (event: HarnessEvent) => void;
    /** The rules this instance was built with. */
    rules: () => StorylineChainRules;
    /** Runs still being watched — a leaked window is a bug this can surface. */
    watching: () => number;
    /** The chained tasks handed out, oldest first. */
    triggers: () => StorylineTriggerRecord[];
    /** Threads armed with a pending chained run. */
    armed: () => string[];
};

// ---------------------------------------------------------------------------
// The prompts (R-C, and the role split R-D restates in the instructions)
// ---------------------------------------------------------------------------

/**
 * What each role is asked to do when the Title is handed to it. The text has to work with
 * no context at all — the receiving agent's conversation may never have seen the change —
 * so it names who acted, what moved, and the one job. Only collections the agent already
 * has declared are named, and no UI vocabulary appears.
 */
const STORYLINE_TASKS: Readonly<Record<string, string>> = {
    writer:
        'Review what changed and rewrite the prose that depends on it, chapter by chapter, so the whole Title still holds together. Write into `chapters` (read a chapter first, then update it with `expects: [{ id, rev }]`), and keep a body under 4000 characters.',
    reader:
        'Read what the team has just changed and critique it: pacing, continuity, character consistency, prose quality. Name every finding against the chapter or profile it is about, rank them by what they cost the story, and end with the one thing to fix first. Change nothing.',
    editor:
        'Revise the structure so the Title stays coherent: re-order and re-summarise the chapters, repair the plan in `outlines` and the running line in `storyline`, and fix any cast contradiction in `profiles`. Read before you write, and update with `expects: [{ id, rev }]`.'
};

/** The fallback for a `next` this package has no prompt for (an operator-named agent). */
const STORYLINE_TASK_FALLBACK =
    'Review what changed in the story records and carry the Title forward from there: read the records that moved, then make the one change you judge necessary.';

/** A role as the sentence addresses it. Unknown names degrade to "the <name> agent". */
const STORYLINE_ROLE_LABELS: Readonly<Record<string, string>> = {
    writer: 'the writer',
    reader: 'the reader',
    editor: 'the editor'
};

// ---------------------------------------------------------------------------
// The helpers
// ---------------------------------------------------------------------------

/** The store watermark, or -1 when the harness is gone (a torn-down session). */
const storeRevOf = (harness: Harness | undefined): number => (harness === undefined ? -1 : harness.records().storeRev);

/**
 * One of OUR runs: a root frame (no parent, not a branch) executing in a top-level host
 * conversation. The parent/kind checks come from the frame itself because such a run may
 * own no thread record at all (a branch run's transcript is ephemeral).
 */
const isChainableRun = (event: HarnessEvent, record: HarnessThreadRecord | undefined): record is HarnessThreadRecord => {
    const thread = event.thread;

    if (thread === undefined || thread.parentId !== undefined || thread.kind !== undefined) return false;
    if (record === undefined) return false;

    return record.origin === 'host' && record.ownerThreadId === undefined;
};

/** `stopped` ranks LAST in the target preference; every other status ranks first. */
const stoppedRank = (record: HarnessThreadRecord): number => (record.status === 'stopped' ? 1 : 0);

/**
 * The thread a chained task lands on, and whether this call is the one that opened it.
 *
 * THE RULE IS THE UI'S RULE. Only this agent's TOP-LEVEL host threads qualify, newest
 * first — that is exactly how the workstation picks the conversation its composer types
 * into (`selectAgentThread`, src/api/storyline.ts), so the chained answer appears where the
 * user is already reading. A delegated child is skipped because it belongs to somebody
 * else's turn (`ownerThreadId`), and a second top-level conversation for one agent would
 * fork the story's context.
 *
 * A STOPPED CONVERSATION STILL WINS OVER OPENING A NEW ONE (T10 seam fix). Verified live
 * against this mount: `POST <mount>/tasks` addressed at a stopped thread answers 202 and
 * the roster row goes back to `running`, and the UI's selection rule never reads `status`
 * at all — so the conversation the user stopped is still the one the user reads, and
 * `harness.sendThreadInput` revives it on its own (harness src/harness.ts:5416, "an explicit
 * HOST turn revives a stopped conversation"). Opening a fresh thread instead stranded the
 * chain's answer in a conversation the transcript never showed. A LIVE conversation still
 * outranks a stopped one, so a session that owns both never revives what the user stopped.
 *
 * `opened` exists for one reason: a delivery that FAILS must not leave a brand-new,
 * message-less conversation in the roster. The UI would show a conversation the server
 * started and then never said anything in, so the caller deletes exactly what this opened
 * (never the user's own conversation, however old).
 */
export const storylineTargetThread = (harness: Harness, agent: string): { id: string; opened: boolean } => {
    const candidates = harness
        .threads()
        .filter((record) => record.origin === 'host' && record.agent === agent && record.ownerThreadId === undefined)
        // Live before stopped, newest before older inside each group. `status` is a
        // preference only: the delivery below resumes whatever it is handed.
        .sort((left, right) => {
            const rank = stoppedRank(left) - stoppedRank(right);

            return rank !== 0 ? rank : right.sequence - left.sequence;
        });

    if (candidates.length > 0) return { id: candidates[0].id, opened: false };

    // The user has never talked to this agent. Opening the conversation here is what lets
    // the chain run without a client round trip, and the label tells the UI the server
    // opened it.
    return { id: harness.createThread(agent, { label: STORYLINE_THREAD_LABEL }).id, opened: true };
};

/**
 * The records that moved during one run, rendered for a prompt.
 *
 * The delta feed (`recordsChanges(since)`) is the honest source: one entry per COMMITTED
 * change, in order, naming its collection — a rejected call appears in it not at all.
 * Labels come from the store snapshot in one read rather than one `get` per record, and a
 * record that has since been removed simply has no entry — which is why the id always
 * rides along with whatever label was found.
 */
const describeChanges = (harness: Harness | undefined, since: number): string => {
    if (harness === undefined) return 'the story records';

    const view = harness.records();
    const labels = new Map<string, string>();

    for (const collection of view.collections) {
        for (const entry of collection.entries) {
            const label = entry.title ?? entry.name ?? entry.heading;

            if (typeof label === 'string' && label.trim().length > 0) labels.set(`${collection.name}:${entry.id}`, label.trim());
        }
    }

    const delta = harness.recordsChanges(since < 0 ? 0 : since);

    if (delta.changes.length === 0) {
        // Either the retained feed window rolled (`reset: true`) or the store moved
        // without a record event (a `define`, a `reset`). Both mean "something moved that
        // this sentence cannot name", and the generic phrase is the honest remainder.
        return 'the story records';
    }

    const listed = delta.changes.slice(0, STORYLINE_TASK_RECORD_LIMIT).map((change) => {
        const label = labels.get(`${change.collection}:${change.id}`);
        const named = label === undefined ? `#${change.id}` : `#${change.id} "${label}"`;

        // Spelled out per collection so the sentence is readable without a legend: the
        // engine's own nouns (`chapter`, `profile`) for the built-ins, and the bare
        // collection name for the Title's two folders.
        const subject =
            change.collection === 'chapters'
                ? `chapter ${named}`
                : change.collection === 'profiles'
                  ? `profile ${named}`
                  : `${change.collection} ${named}`;

        return `${subject} (${change.op})`;
    });

    const omitted = delta.changes.length - listed.length;
    const text = listed.join(', ');

    return omitted > 0 ? `${text}, and ${omitted} more` : text;
};

/** The prompt one role receives, in full. Exported so the wording is testable directly. */
export const storylineTaskFor = (agent: string, from: string, changed: string): string => {
    const actor = STORYLINE_ROLE_LABELS[from] ?? `the ${from} agent`;
    const job = STORYLINE_TASKS[agent] ?? STORYLINE_TASK_FALLBACK;

    return [`You were called because ${actor} finished a turn and changed the Title's records.`, `What moved: ${changed}.`, job].join('\n');
};

// ---------------------------------------------------------------------------
// The orchestrator
// ---------------------------------------------------------------------------

/** One run this orchestrator watches, from its `start` to its terminal frame. */
type RunWindow = {
    agent: string;
    threadId: string;
    /** The store watermark at the run's start — the gate's baseline. */
    startRev: number;
    /** Present only when the CHAIN started this run (0 would mean the user's own turn). */
    depth?: number;
};

/** The arm written before a chained send, consumed by that run's `start` frame. */
type PendingArm = { depth: number };

/**
 * True for a `done` that only PAUSES the run: the answer is real, the run is not over, and
 * its background work is named in `pending` (harness src/harness.ts:9778 emits exactly this
 * frame and then keeps looping). Only `done` can pause, so the `type` check is part of the
 * narrowing, not decoration — `pending` exists on `tool_result` and `wakeup` too.
 */
const isPausedFrame = (event: HarnessEvent): boolean => {
    if (event.type !== 'done') return false;

    return event.pending !== undefined && event.pending.length > 0;
};

/**
 * Build the observer for ONE session. It holds no timers and no subscriptions: only the
 * run windows and the arms described above, both bounded.
 */
export const createStorylineOrchestrator = (options: StorylineOrchestratorOptions): StorylineOrchestrator => {
    const rules: StorylineChainRules = options.rules ?? { enabled: false, next: {}, maxDepth: 0, rule: '' };

    const warn =
        options.report ??
        ((message: string): void => {
            console.warn(`[storyline] ${message}`);
        });

    const schedule =
        options.schedule ??
        ((run: () => Promise<void>): void => {
            queueMicrotask(() => {
                run().catch((error: unknown) => warn(`a chained review failed: ${messageOf(error)}`));
            });
        });

    /** invocation id -> that run's window. */
    const windows = new Map<string, RunWindow>();
    /**
     * Invocations whose window has already been closed, so a second terminal frame for one is
     * ignored instead of re-opening it. Bounded like the windows: an id only has to outlive the
     * frames that follow its own run, and evicting the OLDEST settled id (64 completed runs
     * apart) is the failure mode of a leaked window, not of a live chain.
     */
    const settled = new Set<string>();
    /** thread id -> the depth the next run of that thread was triggered at. */
    const arms = new Map<string, PendingArm>();
    const history: StorylineTriggerRecord[] = [];

    /** The persistent conversation of one invocation, or undefined (a branch run). */
    const joinThread = (harness: Harness | undefined, invocationId: string): HarnessThreadRecord | undefined => {
        if (harness === undefined) return undefined;

        return harness.threads().find((record) => record.invocationId === invocationId);
    };

    /** Insert with the bound applied: the oldest window is the least useful one. */
    const watch = (invocationId: string, window: RunWindow): void => {
        while (windows.size >= STORYLINE_RUN_WINDOW_LIMIT) {
            const oldest = windows.keys().next();

            if (oldest.done === true) break;
            windows.delete(oldest.value);
        }

        windows.set(invocationId, window);
    };

    /** Records that a run's window is closed, with the same bound as `watch`. */
    const markSettled = (invocationId: string): void => {
        while (settled.size >= STORYLINE_RUN_WINDOW_LIMIT) {
            const oldest = settled.keys().next();

            if (oldest.done === true) break;
            settled.delete(oldest.value);
        }

        settled.add(invocationId);
    };

    const arm = (threadId: string, depth: number): PendingArm => {
        const value: PendingArm = { depth };

        while (arms.size >= STORYLINE_ARM_LIMIT) {
            const oldest = arms.keys().next();

            if (oldest.done === true) break;
            arms.delete(oldest.value);
        }

        arms.set(threadId, value);

        return value;
    };

    const deliver = async (from: string, agent: string, depth: number, task: string): Promise<void> => {
        const harness = options.harness();

        if (harness === undefined) return;

        const target = storylineTargetThread(harness, agent);
        const threadId = target.id;
        const pending = arm(threadId, depth);

        // Recorded before the send, so the history names the hop even when the run it
        // started is still in flight (`sendThreadInput` resolves at the END of the turn).
        history.push({ from, agent, threadId, depth, task });

        if (history.length > STORYLINE_TRIGGER_HISTORY_LIMIT) history.shift();

        try {
            if (options.deliver === undefined) await harness.sendThreadInput(threadId, task);
            else await options.deliver(agent, threadId, task);
        } catch (error) {
            // A run that never started leaves its arm behind. Drop ours and only ours —
            // an arm that was replaced belongs to a newer hop and must survive.
            if (arms.get(threadId) === pending) arms.delete(threadId);

            // A conversation THIS hop opened, with nothing in it, would sit in the roster as
            // a chat the server started and never spoke in. A conversation the user owns is
            // never removed, however the delivery failed.
            if (target.opened) releaseOpenedThread(harness, threadId);

            throw error;
        }
    };

    /** One frame that ENDS a run (or PAUSES inside it): measure it, and maybe start the next hop. */
    const complete = (event: HarnessEvent, harness: Harness | undefined): void => {
        const invocationId = String(event.thread?.id);
        const record = joinThread(harness, invocationId);

        // A frame that is not one of our runs still has to release its window (a delegated
        // child of one of our threads is a run of its own, and its window was opened).
        if (!isChainableRun(event, record)) {
            windows.delete(invocationId);

            return;
        }

        // A frame for a run whose window is already closed: the retried delivery, the late
        // duplicate, the paused `done` that lands after the terminal one. It owes the chain
        // nothing — and without this guard it would fall into the fallback window below, which
        // re-opens the run at `startRev: 0` with no depth and fires the SAME hop a second time.
        if (settled.has(invocationId)) {
            windows.delete(invocationId);

            return;
        }

        // THE PAUSE. `done` with `pending` is the answer of a run that is still waiting on
        // background work (harness src/harness.ts:9778), so nothing is measured yet. The window
        // is kept EXACTLY as it is — same `startRev`, the gate's baseline, and same `depth`, the
        // hop counter — so a record written during the pause is still credited to this turn and
        // the next hop continues the count instead of restarting at 1. A run whose `start` this
        // observer never saw gets the same fallback the terminal path uses.
        if (isPausedFrame(event)) {
            if (!windows.has(invocationId)) watch(invocationId, { agent: record.agent, threadId: record.id, startRev: 0 });

            return;
        }

        // DESTRUCTIVE read plus the settled marker: one completion of one run triggers at most
        // once, whatever the reporter does afterwards.
        const window: RunWindow = windows.get(invocationId) ?? {
            agent: record.agent,
            threadId: record.id,
            // No `start` was seen for this run — the orchestrator joined a session mid-run.
            // The only defensible baseline is the start of the store, so every change of
            // the Title counts; guessing "nothing moved" would silently drop a hop.
            startRev: 0
        };

        windows.delete(invocationId);
        markSettled(invocationId);

        // An errored turn is not a completed one: chaining into a run that just failed is
        // how one bad provider response becomes an endless argument. The window is still
        // released above, which is all an `error` frame owes the orchestrator.
        if (event.type !== 'done') return;

        const after = storeRevOf(harness);

        // THE GATE. No watermark movement means no record moved, and a turn that wrote
        // nothing has nothing for the next role to act on. `!==` rather than `>` because a
        // `reset()` rewinds the store, and a rewind IS a change.
        if (after < 0 || after === window.startRev) return;

        const from = record.agent;
        const next = rules.next[from];

        // No edge for this agent (or a self-edge an operator wrote by mistake): the chain
        // ends here, quietly, because the user is the one who will read the result.
        if (next === undefined || next === from) return;

        const depth = (window.depth ?? 0) + 1;

        if (depth > rules.maxDepth) {
            warn(`chain stopped after ${from}: hop ${depth} exceeds ${STORYLINE_CHAIN_DEPTH_ENVIRONMENT} (${rules.maxDepth}).`);

            return;
        }

        const task = storylineTaskFor(next, from, describeChanges(harness, window.startRev));

        schedule(() => deliver(from, next, depth, task));
    };

    const observe = (event: HarnessEvent): void => {
        // An off chain still observes nothing at all: no joins, no window bookkeeping, so
        // the observer costs one boolean for a deployment that asked for no chaining.
        if (!rules.enabled) return;

        const invocationId = event.thread?.id;

        if (invocationId === undefined) return;

        const harness = options.harness();
        const id = String(invocationId);

        if (event.type === 'start') {
            const record = joinThread(harness, id);

            if (!isChainableRun(event, record)) return;

            const pending = arms.get(record.id);

            if (pending !== undefined) arms.delete(record.id);

            watch(id, {
                agent: record.agent,
                threadId: record.id,
                startRev: storeRevOf(harness),
                ...(pending === undefined ? {} : { depth: pending.depth })
            });

            return;
        }

        if (event.type !== 'done' && event.type !== 'error') return;

        complete(event, harness);
    };

    return {
        observe: (event: HarnessEvent): void => {
            try {
                observe(event);
            } catch (error) {
                // Never throw into a run. An observer that cannot read its own harness
                // costs the user nothing but a line in the log.
                warn(`the storyline observer skipped an event: ${messageOf(error)}`);
            }
        },
        rules: () => rules,
        watching: () => windows.size,
        triggers: () => [...history],
        armed: () => [...arms.keys()]
    };
};

/** Error text that survives a non-Error throw (a tool body can reject with anything). */
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Close a conversation this orchestrator opened and then never used.
 *
 * Only an EMPTY thread is removed: if the user typed into the new conversation between the
 * open and the failed send, their message wins and the thread stays. A delete that cannot
 * happen (the thread is already gone) is not worth a second error on top of the delivery
 * failure the caller is already reporting.
 */
const releaseOpenedThread = (harness: Harness, threadId: string): void => {
    try {
        if (harness.threadMessages(threadId).length > 0) return;

        harness.deleteThread(threadId);
    } catch {
        // Swallowed on purpose: the delivery failure is the fact that matters here.
    }
};
