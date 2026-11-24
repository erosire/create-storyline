// S-RUNTIME — the workspace clock: `autoSweep` is the coordinator's, not each Story's (L-1, S-5).
//
// WHAT IS REAL HERE: the shipped `StoryRuntimes` coordinator, `LoopEngine`, `RunExecutor`, criteria engine,
// Digest builder and tool runtime — the same objects `api/server.ts:openStorylineRuntime` composes — over an
// IN-MEMORY `StoryStores` registry (`store/story-stores.ts:inMemory`), so no filesystem, no listener and no
// provider is touched. The only double is the model (`llm/mock.ts:MockChatClient`), which this layer stores
// and never interprets. The API cases use the shipped composition surface itself
// (`api/server.ts:buildStorylineRuntime`), which is what `startStorylineServer` calls `engine.start()` on
// (`api/server.ts:599`).
//
// WHY FAKE TIMERS RATHER THAN SLEEPS: the claim is about a HANDLE, and a handle is countable. Vitest's fake
// clock exposes `vi.getTimerCount()`, so "exactly one interval", "none at all" and "the one you started is the
// one you stopped" are exact relative integers against a baseline captured inside the fake window — the same
// technique `run/executor.test.ts:livenessRig` uses. A sleep could only show "probably not yet".
//
// THE CLOCK CONTRACT this suite pins (`runtime/story-runtimes.ts:start`):
//   * `autoSweep: false` → NO interval anywhere. The per-Story scheduling GATES still open, so the caller
//     that named the flag stays able to sweep by hand — closing the timer must not close the cord.
//   * `autoSweep: true`, or omitted (L-1's default: a started loop sweeps) → exactly ONE interval, re-armed
//     but never duplicated by a repeated `start()`, and cleared by `stop()`.
//   * `autoSweep` is forced off inside every per-Story `LoopEngine` (`story-runtimes.ts:build`), so a late
//     Story joining a running workspace adds no timer either.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockChatClient, msg } from '../llm/mock';
import { StoryStores } from '../store/story-stores';
import { buildStorylineRuntime } from '../api/server';
import { Store } from '../store';
import type { LoopEngineConfig } from '../loop/types';
import { StoryRuntimes } from './story-runtimes';

// Fixed UUIDs keep every id assertion exact, as in the isolation suite: the registry hands these out in
// order, so a literal in the fixture is a literal in the report.
const ID_A = '2f7c9a51-6a13-4bd6-9b1c-6c2b0d4b7a11';
const ID_B = '8b1d4c2e-0f77-4a3f-a2c5-9d1e6b8c4f22';
const ID_C = '5c0f3a9d-9b6e-4f42-8d7a-1e2b3c4d5e6f';

const IDEA_A = 'A lighthouse keeper starts answering letters written by a ship that sank in her bay.';
const IDEA_B = 'A cartographer returns to the valley she mapped as a girl and finds it redrawn by a reservoir.';
const IDEA_C = 'A beekeeper walks the last unmapped hedgerow in the county, one contract at a time.';

/** The model every run here gets: one prose answer, whatever the brief asks for. */
const stubChat = (): MockChatClient =>
    new MockChatClient(() => ({
        message: msg({ content: 'The watchtower stood over the pass, and the map it was built from was wrong.' })
    }));

/** The id sequence the registry injects, so created Stories are addressable by exact string. */
const factory = (ids: string[]) => {
    let next = 0;

    return () => ids[next++];
};

/**
 * A coordinator over an in-memory registry: the same `StoryRuntimes.open` the shipped workspace calls, with
 * no store root and therefore no fs. Built with REAL timers, because a boot awaits the registry and the
 * knowledge projection; the cases that need the fake clock take it only around `start()`/`stop()`.
 */
const openCoordinator = async (storyIds: string[], engineConfig: LoopEngineConfig): Promise<StoryRuntimes> =>
    StoryRuntimes.open({
        stories: StoryStores.inMemory({ createStoryId: factory(storyIds) }),
        chat: stubChat(),
        engineConfig
    });

/** The sweep report minus its wall-clock stamp: every other field of an idle pass is an exact literal. */
const idleOf = (report: {
    stories: unknown;
    runs_started: number;
    runs_finished: number;
    leases_lapsed: string[];
    skipped: boolean;
}): unknown[] => [report.stories, report.runs_started, report.runs_finished, report.leases_lapsed, report.skipped];

afterEach(() => {
    // A leaked fake clock would freeze the NEXT case's `await`s, and a leaked spy would count calls the next
    // case never made — both would report as a wrong integer rather than as this file.
    vi.useRealTimers();
    vi.restoreAllMocks();
});

// --------------------------------------------------------------------------------
// 1. `autoSweep: false` closes the timer and keeps the scheduler callable
// --------------------------------------------------------------------------------

describe('StoryRuntimes honours autoSweep:false', () => {
    it('runs no background sweep over a 1ms interval, and still sweeps by hand with the gates open (L-1)', async () => {
        const runtimes = await openCoordinator([ID_A, ID_B], { autoSweep: false, sweepIntervalMs: 1 });

        await runtimes.createStory({ idea: IDEA_A, title: 'Lighthouse' });
        await runtimes.createStory({ idea: IDEA_B, title: 'Reservoir' });

        const bookA = runtimes.storeFor(ID_A) as Store;
        const bookB = runtimes.storeFor(ID_B) as Store;
        const sweep = vi.spyOn(runtimes, 'sweep');

        try {
            vi.useFakeTimers();

            const timers = vi.getTimerCount();

            runtimes.start();

            // The interval: `sweepIntervalMs: 1` is deliberately absurd, because the point is that an
            // interval that EXISTS would fire hundreds of times inside the window below. With the flag off
            // there is no handle at all — and the gates open anyway, which is the half the flag must not
            // close: `sweepAll` visits a book only while its engine reports `started`.
            expect(runtimes.started).toBe(true);
            expect(runtimes.contexts_().map((context) => context.engine.started)).toEqual([true, true]);
            expect(vi.getTimerCount()).toBe(timers);

            // 20 interval lengths. Under the defect this window is 20 coordinator sweeps; asserted twice,
            // once as the call count and once as the books' own rows, so a background sweep cannot hide
            // behind a report the test never read.
            await vi.advanceTimersByTimeAsync(20);

            expect(sweep).toHaveBeenCalledTimes(0);
            expect(bookA.runs.list()).toEqual([]);
            expect(bookB.runs.list()).toEqual([]);

            // `stop()` is the inverse of a start that armed nothing, and starting again cannot leak a timer
            // that was never created: the handle count never moves off the baseline in this mode.
            runtimes.stop();
            expect(vi.getTimerCount()).toBe(timers);
            expect(runtimes.contexts_().map((context) => context.engine.started)).toEqual([false, false]);

            runtimes.start();
            expect(vi.getTimerCount()).toBe(timers);
            expect(runtimes.contexts_().map((context) => context.engine.started)).toEqual([true, true]);
        } finally {
            vi.useRealTimers();
        }

        // The caller IS the clock now: one explicit sweep, and it does the work the timer would have done —
        // both books in one pass, one run each, in each book's own rows (the ids the isolation suite pins).
        const report = await runtimes.sweep();

        expect(report.stories.map((story) => story.story_id)).toEqual([ID_A, ID_B]);
        expect([report.skipped, report.runs_started, report.runs_finished, report.leases_lapsed]).toEqual([
            false,
            2,
            0,
            []
        ]);
        expect(sweep).toHaveBeenCalledTimes(1);

        await runtimes.settle();

        expect(bookA.runs.list().map((row) => [row.id, row.story_id])).toEqual([['run_0', ID_A]]);
        expect(bookB.runs.list().map((row) => [row.id, row.story_id])).toEqual([['run_0', ID_B]]);

        await runtimes.close();
    });

    it('opens every Story’s gate and lets a Story made while it runs join them, with no timer either way', async () => {
        const runtimes = await openCoordinator([ID_A, ID_B, ID_C], { autoSweep: false, sweepIntervalMs: 1 });

        await runtimes.createStory({ idea: IDEA_A });
        await runtimes.createStory({ idea: IDEA_B });

        try {
            vi.useFakeTimers();

            const timers = vi.getTimerCount();

            runtimes.start();

            expect(runtimes.started).toBe(true);
            expect(runtimes.contexts_().map((context) => context.engine.started)).toEqual([true, true]);
            expect(vi.getTimerCount()).toBe(timers);

            // D-1: a Story created while the workspace runs joins the running loop — but `build` forces the
            // context's OWN `autoSweep` off, so a late joiner adds a scheduling gate, never a second clock.
            await runtimes.createStory({ idea: IDEA_C });

            expect(runtimes.contexts_().map((context) => context.engine.started)).toEqual([true, true, true]);
            expect(vi.getTimerCount()).toBe(timers);

            runtimes.stop();

            expect(runtimes.contexts_().map((context) => context.engine.started)).toEqual([
                false,
                false,
                false
            ]);
            expect(vi.getTimerCount()).toBe(timers);
        } finally {
            vi.useRealTimers();
        }

        // The gates, with the clock closed: a stopped sweep names no Story, a started one visits every book
        // in book order, and stopping again closes the cord exactly as it was before the start.
        expect(idleOf(await runtimes.sweep())).toEqual([[], 0, 0, [], false]);

        runtimes.start();

        expect((await runtimes.sweep()).stories.map((story) => story.story_id)).toEqual([ID_A, ID_B, ID_C]);

        runtimes.stop();

        expect(idleOf(await runtimes.sweep())).toEqual([[], 0, 0, [], false]);

        // The dispatched runs are behind `settle()`, so "nothing is live" is a fact about the books rather
        // than about a clock nobody advanced. The ceiling is still the ONE number the workspace reports,
        // unchanged by the flag (S-5), and moving it still reaches each Story's engine.
        await runtimes.settle();

        expect(runtimes.liveRuns()).toBe(0);
        expect(runtimes.ceilingView).toEqual({ limit: 12, live_runs: 0, stories: 3 });

        runtimes.setGlobalMaxConcurrent(1);

        expect(runtimes.ceilingView.limit).toBe(1);
        expect(runtimes.engineOf(ID_A)?.config.globalMaxConcurrent).toBe(1);
        expect(runtimes.engineOf(ID_B)?.config.globalMaxConcurrent).toBe(1);

        // The flag never leaks into the shape `/loop` reads: `config.autoSweep` is the PER-STORY answer and
        // says false under a coordinator in every mode (`story-runtimes.ts:config`).
        expect(runtimes.config.autoSweep).toBe(false);

        await runtimes.close();
    });
});

// --------------------------------------------------------------------------------
// 2. The default and `autoSweep: true`: one timer, fired, and cleared
// --------------------------------------------------------------------------------

describe('StoryRuntimes keeps L-1’s default: a started loop sweeps', () => {
    /**
     * Both cases sweep an EMPTY workspace (no Story, so no context and no run): the claim is about the
     * handle and the tick, and a real dispatch would arm the run's own heartbeat interval and make the
     * handle count a moving baseline. The dispatched work itself is pinned by the `autoSweep:false` case.
     */
    it('arms exactly one interval for the cadence it was given, fires it per tick, and clears it on stop', async () => {
        const runtimes = await openCoordinator([], { autoSweep: true, sweepIntervalMs: 250 });
        const sweep = vi.spyOn(runtimes, 'sweep');

        try {
            vi.useFakeTimers();

            const timers = vi.getTimerCount();

            runtimes.start();
            expect(vi.getTimerCount()).toBe(timers + 1);

            // Repeated starts must not duplicate the clock: a second interval would sweep twice per tick
            // and race the workspace's own re-entrancy guard.
            runtimes.start();
            runtimes.start();
            expect(vi.getTimerCount()).toBe(timers + 1);

            // Four ticks of a 250ms cadence inside 1000ms (250, 500, 750, 1000) — and each one is a call
            // into `sweep()`, which is what proves the handle is the workspace's own, not merely armed.
            await vi.advanceTimersByTimeAsync(1_000);
            expect(sweep).toHaveBeenCalledTimes(4);

            runtimes.stop();
            expect(vi.getTimerCount()).toBe(timers);

            await vi.advanceTimersByTimeAsync(5_000);
            expect(sweep).toHaveBeenCalledTimes(4);

            // The API's own switch, in both directions: re-arming after a stop adds one handle, and the
            // second `true` does not stack a second one.
            runtimes.setStopped(false);
            expect(vi.getTimerCount()).toBe(timers + 1);
            runtimes.setStopped(true);
            expect(vi.getTimerCount()).toBe(timers);
        } finally {
            vi.useRealTimers();
        }

        await runtimes.close();
    });

    it('treats an omitted autoSweep as ON, on the shipped 500ms cadence (L-1)', async () => {
        const runtimes = await openCoordinator([], {});
        const sweep = vi.spyOn(runtimes, 'sweep');

        try {
            vi.useFakeTimers();

            const timers = vi.getTimerCount();

            runtimes.start();

            // `!== false`, not `=== true`: an embed that names only the cadence or the ceiling keeps the
            // loop sweeping, exactly as it did before the flag gated the workspace timer.
            expect(runtimes.config.sweepIntervalMs).toBe(500);
            expect(vi.getTimerCount()).toBe(timers + 1);

            await vi.advanceTimersByTimeAsync(1_500);
            expect(sweep).toHaveBeenCalledTimes(3);

            runtimes.stop();
            expect(vi.getTimerCount()).toBe(timers);
        } finally {
            vi.useRealTimers();
        }

        await runtimes.close();
    });

    it('honours a cadence the caller named without the flag, so the interval is still the caller’s number', async () => {
        const runtimes = await openCoordinator([], { sweepIntervalMs: 10 });
        const sweep = vi.spyOn(runtimes, 'sweep');

        try {
            vi.useFakeTimers();

            const timers = vi.getTimerCount();

            runtimes.start();
            expect(vi.getTimerCount()).toBe(timers + 1);

            await vi.advanceTimersByTimeAsync(100);
            expect(sweep).toHaveBeenCalledTimes(10);

            runtimes.stop();
            expect(vi.getTimerCount()).toBe(timers);
        } finally {
            vi.useRealTimers();
        }

        await runtimes.close();
    });
});

// --------------------------------------------------------------------------------
// 3. The server composition: the flag a caller hands `buildStorylineRuntime` is the one that gates
// --------------------------------------------------------------------------------

describe('the server composition hands autoSweep to the coordinator', () => {
    /**
     * `startStorylineServer` starts the loop itself (`api/server.ts:599`), so the only question a caller can
     * still answer is which flag reaches the coordinator through `resolveEngineConfig`
     * (`api/server.ts:250` defaults it ON, and `openStorylineRuntime` forwards it to `StoryRuntimes.open`).
     * `buildStorylineRuntime` is that path without the listener: same builder, same `engine.start()`.
     */
    it('sweeps on its own clock by default, and not at all when the caller says autoSweep:false', async () => {
        try {
            vi.useFakeTimers();

            const shipped = buildStorylineRuntime({ store: Store.empty(), chat: stubChat(), env: {} });
            const timers = vi.getTimerCount();

            shipped.engine.start();

            // The shipped server: a started loop is a moving dashboard, and the handle is exactly one.
            expect(shipped.runtimes.started).toBe(true);
            expect(vi.getTimerCount()).toBe(timers + 1);

            shipped.engine.stop();
            expect(vi.getTimerCount()).toBe(timers);

            await shipped.runtimes.close();

            // A test fixture or an embed that names the flag: no handle, even on a cadence that would fire
            // constantly, which is the contract `api/server.ts:174` documents ("tests turn it off and drive
            // every sweep").
            const gated = buildStorylineRuntime({
                store: Store.empty(),
                chat: stubChat(),
                engineConfig: { autoSweep: false, sweepIntervalMs: 1 },
                env: {}
            });
            const gatedTimers = vi.getTimerCount();

            gated.engine.start();

            expect(gated.runtimes.started).toBe(true);
            expect(vi.getTimerCount()).toBe(gatedTimers);

            await vi.advanceTimersByTimeAsync(1_000);
            expect(gated.runtimes.liveRuns()).toBe(0);

            // And its sweep still answers, because the gates opened with the start.
            expect(idleOf(await gated.runtimes.sweep())).toEqual([[], 0, 0, [], false]);

            gated.engine.stop();
            expect(vi.getTimerCount()).toBe(gatedTimers);

            await gated.runtimes.close();
        } finally {
            vi.useRealTimers();
        }
    });
});
