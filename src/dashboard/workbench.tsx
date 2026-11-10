// The React seam between the headless kernel and this package's views.
//
// `@underload/dashboard` has no React dependency at all (packages/underload/
// dashboard/README.md "What this framework does not do"), so the composed
// instance reaches the tree through one context. It lives here rather than in a
// shared adapter package for the same reason the kernel's example keeps its own:
// a second target (vanilla DOM, another framework) would provide its own context
// and reuse every plugin untouched.
import { createContext, useContext, type ReactNode } from 'react';
import type { Dashboard } from '@underload/dashboard';

const WorkbenchContext = createContext<Dashboard | null>(null);

/** Wraps the shell with the composed instance (see StorylineApp). */
export function WorkbenchProvider({ instance, children }: { instance: Dashboard; children: ReactNode }) {
    return <WorkbenchContext.Provider value={instance}>{children}</WorkbenchContext.Provider>;
}

/**
 * The composed dashboard. Throws instead of returning null: every consumer
 * renders under <WorkbenchProvider>, so a missing instance is a composition bug,
 * and one clear message beats a "cannot read state of null" three frames down.
 */
export function useWorkbench(): Dashboard {
    const instance = useContext(WorkbenchContext);

    if (instance === null) {
        throw new Error('useWorkbench() needs a <WorkbenchProvider> with a dashboard() instance');
    }

    return instance;
}
