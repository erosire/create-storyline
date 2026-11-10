// The application shell of the storyline UI.
//
// This file is deliberately thin: the dashboard instance, its plugins and its
// teardown all live in src/dashboard/StorylineApp.tsx, so a host that imports the
// package (`import { StorylineApp } from '@erosire/create-storyline'`) gets exactly
// what this app renders, with the same composition and the same options.
//
// The one thing App adds is the DEFAULT DEPLOYMENT: the UI dials `/v1/storyline` on
// this page's origin (src/api/root.ts), which the dev server proxies to the
// @underload/service gateway and a production host serves beside the bundle. A host
// that wants another mount passes its own `api`/`streamFactory` — the composition's
// two seams — rather than a root string, because the root is resolved once per page
// load by the harness client and cannot be re-pointed per component.
import { StorylineApp, type StorylineAppProps } from './dashboard';

export function App(props: StorylineAppProps = {}) {
    return <StorylineApp {...props} />;
}
