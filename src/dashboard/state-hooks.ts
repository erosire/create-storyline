// The state bridge: `useSyncExternalStore` over the kernel's own cells.
//
// A `DashboardState<T>` is already EXACTLY the shape React needs — `subscribe(
// listener) => unsubscribe` and a stable `get()` snapshot — which is why the
// dashboard package ships no React adapter (README "React needs no adapter
// package at all"). Two details are load-bearing:
//
//   1. `subscribe`/`get` are wrapped in arrows, never passed straight through, so
//      an implementation that later keeps `this` cannot break under React's
//      detached-call convention;
//   2. derived values are CACHED against reference equality of their inputs
//      (`useDashboardPair`). getSnapshot() must not return a fresh object every
//      call or React loops forever; the kernel already guarantees stable
//      references between writes, which is what makes the cache correct.
import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import type { Dashboard, DashboardState } from '@underload/dashboard';
import type { Contribution } from './contract';
import { useWorkbench } from './workbench';

/** Subscribe to one registered state cell. */
export function useDashboardState<T>(state: DashboardState<T>): T {
    const subscribe = useCallback((listener: () => void) => state.subscribe(listener), [state]);
    const getSnapshot = useCallback(() => state.get(), [state]);

    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Read one registered state by id, straight off the composed instance. */
export function useDashboardValue<T>(stateId: string): T {
    const instance = useWorkbench();
    const state = useMemo(() => instance.state<T>(stateId), [instance, stateId]);

    return useDashboardState(state);
}

/**
 * A derived snapshot over TWO cells (the chapters and profiles panels both need
 * the store plus their own selection). `compute` may be an inline arrow every
 * render — it is read through a ref, so it never causes a resubscribe and never
 * changes the snapshot identity on its own.
 */
export function useDashboardPair<A, B, T>(firstId: string, secondId: string, compute: (first: A, second: B) => T): T {
    const instance = useWorkbench();
    const first = useMemo(() => instance.state<A>(firstId), [instance, firstId]);
    const second = useMemo(() => instance.state<B>(secondId), [instance, secondId]);

    const computeRef = useRef(compute);

    computeRef.current = compute;

    const cacheRef = useRef<{ first: A; second: B; value: T } | null>(null);

    const subscribe = useCallback(
        (listener: () => void) => {
            const offFirst = first.subscribe(listener);
            const offSecond = second.subscribe(listener);

            return () => {
                offFirst();
                offSecond();
            };
        },
        [first, second]
    );

    const getSnapshot = useCallback((): T => {
        const nextFirst = first.get();
        const nextSecond = second.get();
        const cached = cacheRef.current;

        if (cached !== null && cached.first === nextFirst && cached.second === nextSecond) return cached.value;

        const value = computeRef.current(nextFirst, nextSecond);

        cacheRef.current = { first: nextFirst, second: nextSecond, value };

        return value;
    }, [first, second]);

    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * A registered service facade. Services are published during setup and never
 * replaced, so a memo is enough — no subscription exists to miss.
 */
export function useDashboardService<S>(serviceId: string): S {
    const instance = useWorkbench();

    return useMemo(() => instance.service<S>(serviceId), [instance, serviceId]);
}

/**
 * One slot snapshot. Also setup-time only: the snapshot is frozen when the build
 * finishes, which is what lets the shell render the array directly instead of
 * subscribing to a slot-changed event.
 */
export function useDashboardSlot<T>(slotName: string): readonly Contribution<T>[] {
    const instance = useWorkbench();

    // No cast on the return: the declared type IS the structural check, so a
    // renamed contribution field stops compiling instead of shaping away a field.
    return useMemo(() => instance.slot<T>(slotName), [instance, slotName]);
}

/**
 * A command runner, stable across renders. Commands are looked up at call time
 * (not memoized), which is what keeps a runner valid after the instance it
 * belongs to is swapped in a test.
 */
export function useDashboardCommand<I = void, O = void>(commandId: string): (input?: I) => O {
    const instance = useWorkbench();

    return useCallback((input?: I): O => instance.execute<I, O>(commandId, input), [instance, commandId]);
}
