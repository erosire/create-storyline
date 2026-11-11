// The app root: one component, no routing. §10.1's four regions ARE the application, and the
// home-vs-story switch inside them (U-10) replaces a router — the Author's queue is the page,
// and selecting a Story is a store write rather than a URL change. A router would be a second
// source of truth for "what am I looking at", which P1 says lives in the store.
import { StorylineApp } from './dashboard/StorylineApp';

export function App() {
    return <StorylineApp />;
}

export default App;
