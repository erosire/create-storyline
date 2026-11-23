// S-5's fan-out ceiling, as ONE HOST SETTING in the store's `settings` section — the same place the
// global employee roster's model choices live (`run/agent-models.ts`), and for the same two reasons.
//
// WHY A SETTING AND NOT A §4 RECORD: the ceiling is not a fact about the book. It is configuration the
// Author sets once for the machine the loop runs on, so it rides the store's atomic snapshot and stays
// OUT of the journal — an audit of the Story should not be cluttered with a thread count, and the
// Digest must never derive anything from it (D-12a). `Store.setSetting` is exactly that seam.
//
// WHY IT IS PERSISTED AT ALL: a ceiling the Author moved from 4 to 12 in the employee rail and lost on
// the next restart is a control that does not hold. This is the same argument the roster's model choice
// carries (L-3), and it is why the number is not left in the engine's memory alone.
//
// THE PRECEDENCE, stated once so `api/server.ts` and nobody else owns it:
//   1. `STORYLINE_GLOBAL_MAX_CONCURRENT`, when it is set — an operator's deployment-wide pin, and the
//      one thing that outranks a click, because the person who exports it is sizing a box, not
//      steering a book;
//   2. the number the Author last chose in the rail (this setting);
//   3. `DEFAULT_GLOBAL_MAX_CONCURRENT` (`loop/types.ts`) — 12, the shipped standard.
// So the env var seeds a store that has never been configured, and an unset env var — the normal case —
// leaves the Author's choice in charge across restarts.
import type { Store } from '../store';

/** The key under the store snapshot's `settings` section. */
export const LOOP_CEILING_SETTING = 'loop_global_max_concurrent';

/**
 * The ceiling the Author last chose, sanitised. A malformed setting — a hand-edited `store.json`, a
 * value written by an older build — reads as "never chosen" rather than as a ceiling of `NaN` or zero,
 * which would leave the sweep with nothing to dispatch and no sentence to say why.
 */
export function storedGlobalMaxConcurrent(store: Store): number | undefined {
    const raw = store.setting<unknown>(LOOP_CEILING_SETTING);

    return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 ? raw : undefined;
}

/**
 * Writes the Author's choice. Deliberately not journaled (`Store.setSetting`), and deliberately not
 * validated here: the route that owns the product's 400 sentence already rejected anything that is not
 * a whole number of threads at least 1 (S-5).
 */
export const rememberGlobalMaxConcurrent = (store: Store, limit: number): void =>
    store.setSetting(LOOP_CEILING_SETTING, limit);
