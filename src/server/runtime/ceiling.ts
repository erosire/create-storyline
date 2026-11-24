// S-5's fan-out ceiling, expressed ONCE for a workspace that has many Stories.
//
// WHY THIS EXISTS AT ALL: the engine has always applied `config.globalMaxConcurrent` against
// `liveRuns(store)` (`loop/engine.ts:dispatch`), and while one Store held every Story that was the
// whole rule. Per-story Stores break it in the worst possible direction: each engine counts only
// ITS OWN Story's live rows, so a ceiling of 4 with four open Stories means sixteen threads, and
// the Author's one number stops meaning anything. S-5's sentence — one ceiling ACROSS Stories —
// needs a number that is not inside any one Store, so the coordinator owns it and hands every
// engine the same view.
//
// WHY IT IS A VIEW AND NOT A COUNTER: the rows are still the memory (P1). A live run is a `runs`
// row in `spawning|working|reporting` (`loop/records.ts:isLiveRun`), and the executor creates that
// row SYNCHRONOUSLY inside `execute` (D-18) — so a sweep of Story B, taken after Story A's launch,
// already sees A's rows. Counting them is therefore a read of the books, not a reservation the
// coordinator has to hand out and take back; an in-memory semaphore would be a second source of
// truth that drifts the moment a run dies without the coordinator noticing (L-3).
//
// WHY THE ENGINE STILL OWNS THE DECISION: the ceiling is an input the sweep reads on every
// dispatch, exactly as `config.globalMaxConcurrent` was. The engine still orders candidates by
// urgency (`work.ts`), still respects each template's own `max_concurrent` (D-38a) and still
// refuses a unit another live run holds (L-5). Nothing about ordering moved.
// THE SEAM, stated once: `loop/types.ts:LoopCeiling` is the input an engine accepts, and this class is
// the implementation a coordinator provides. The engine keeps the decision — it already counted its own
// store's live rows against its own config, and it still does, except that the two numbers now come from
// whoever owns the whole workspace (`loop/engine.ts:dispatch`).
import type { LoopCeiling } from '../loop/types';

/**
 * The shared ceiling: one limit, and a live-run count summed over every open Story's Store.
 *
 * `counter` is installed by the coordinator (`StoryRuntimes`) because only it knows which Stores
 * are open; an engine holds the view, never the number. A ceiling with no counter yet answers its
 * limit and zero live runs, which is the correct reading of a workspace with no stories.
 */
export class GlobalCeiling implements LoopCeiling {
    private limitValue: number;
    private counter: (() => number) | null = null;

    constructor(limit: number) {
        // The caller validated (the route answers 400 with the product sentence); a sane floor
        // still protects the sweep from a hand-built zero, which would leave it with nothing to
        // dispatch and no sentence to say why (S-5).
        this.limitValue = Number.isInteger(limit) && limit >= 1 ? Math.floor(limit) : 1;
    }

    /** S-5's number right now — what every context's sweep compares its dispatch against. */
    limit(): number {
        return this.limitValue;
    }

    /**
     * Moving the ceiling while the loop runs. Like the engine's own setter, this cancels nothing:
     * the runs already in flight finish their pass and the next sweep is the one that fills (or
     * stops filling) the capacity.
     */
    setLimit(limit: number): void {
        if (!Number.isInteger(limit) || limit < 1) return;

        this.limitValue = Math.floor(limit);
    }

    /** The coordinator installs (or removes, with `null`) the cross-store live-count read. */
    attach(counter: (() => number) | null): void {
        this.counter = counter;
    }

    /** Live run rows across EVERY open Story — the number the ceiling is compared against. */
    liveRuns(): number {
        if (this.counter === null) return 0;

        const counted = this.counter();

        // A negative probe (a host computing it from two clocks, a partially-closed context) must
        // not buy extra capacity: the ceiling is a cap, and a cap only ever gets tighter.
        return Number.isFinite(counted) && counted > 0 ? Math.floor(counted) : 0;
    }
}

/**
 * The headroom the sweep still has: the ceiling minus what is already running across every Story.
 *
 * `localLive` is that Story's own live count and is passed for one reason — the cross-book count can
 * never be smaller than it, but a ceiling whose counter has not been attached yet (a single Story opened
 * outside the coordinator, a test rig holding one engine) would otherwise read zero and oversubscribe.
 * `loop/engine.ts:dispatch` applies the same rule in the other direction, as the count it fills against.
 */
export const ceilingHeadroom = (ceiling: LoopCeiling, localLive: number): number =>
    Math.max(0, ceiling.limit() - Math.max(localLive, ceiling.liveRuns()));
