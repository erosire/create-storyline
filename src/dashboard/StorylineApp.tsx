// The public application component: build one dashboard, render it, tear it down.
//
// RESPONSIBILITIES, and nothing else:
//   1. build exactly ONE dashboard instance for this mount (composition.ts);
//   2. hand it to the shell;
//   3. dispose it on unmount in the order the kernel requires.
//
// DISPOSAL ORDER — the part that is easy to get wrong, and the reason the instance
// is created in a ref rather than in an effect:
//
//   React unmounts bottom-up, so every child's `useSyncExternalStore` unsubscribe
//   runs BEFORE this component's effect cleanup. Deferring `dispose()` one microtask
//   past that cleanup adds the other half of the guarantee, and — more importantly —
//   survives React 18 StrictMode, which runs setup -> cleanup -> setup on the same
//   committed tree. A synchronous dispose would leave the re-mounted children
//   subscribed to detached cells, and a detached cell throws
//   DashboardError('disposed') on get()/subscribe()
//   (packages/underload/dashboard/src/extensions/state.ts). The re-run setup
//   CANCELS the pending dispose, so the instance simply stays alive; on a real
//   unmount no setup follows and the microtask disposes exactly once.
//
//   The same ordering is why the socket's teardown lives in the session plugin's
//   returned cleanup (plugins/session.ts): dispose() runs cleanups in REVERSE setup
//   order, so the consumers of the stream are torn down before the stream itself.
//
// The instance is built once per mount. Changing an option after mount does not
// rebuild it — a rebuild would drop every state cell mid-story — so a host that
// wants a different deployment remounts this component by key instead.
//
// Precedent: distribution/chat-assistant/src/dashboard/ChatAssistantApp.tsx and
// packages/underload/dashboard/example/src/app/entry.tsx.
import { memo, useEffect, useRef } from 'react';
import type { Dashboard } from '@underload/dashboard';
import { createStoryline, type StorylineOptions } from './composition';
import { WorkstationShell } from './WorkstationShell';

export type StorylineAppProps = StorylineOptions & {
    /** Test seam: a host that composes its own instance (a storybook scenario). */
    instance?: Dashboard;
};

export const StorylineApp = memo(function StorylineApp({ instance: provided, ...options }: StorylineAppProps = {}) {
    // Built during the first render, not in an effect: the very first paint already
    // reads state cells, so the instance must exist before any child renders.
    // `cancelPending` holds the cancel handle of a dispose queued by the last
    // cleanup, which the next setup consumes.
    const holder = useRef<{ instance: Dashboard; owns: boolean; cancelPending: (() => void) | null } | null>(null);

    if (holder.current === null) {
        holder.current = { instance: provided ?? createStoryline(options), owns: provided === undefined, cancelPending: null };
    }

    const current = holder.current;

    useEffect(() => {
        // A StrictMode re-setup (or a fast refresh) cancels the dispose the previous
        // cleanup queued for this same instance.
        current.cancelPending?.();
        current.cancelPending = null;

        return () => {
            if (!current.owns) return;

            let cancelled = false;

            current.cancelPending = () => {
                cancelled = true;
            };

            // One microtask, cancelled by the following setup — see the header. React
            // runs the StrictMode cleanup and re-setup in the SAME task, so the
            // microtask lands after the re-setup has set `cancelled`; a real unmount
            // has no following setup, so this still disposes exactly once.
            globalThis.queueMicrotask(() => {
                current.cancelPending = null;
                if (cancelled) return;
                current.instance.dispose();
            });
        };
    }, [current]);

    return <WorkstationShell instance={current.instance} />;
});
