// The browser entry point: mount the app, and nothing else.
//
// WHY THIS FILE IS SO SHORT: the dashboard instance is created, provided and
// disposed INSIDE <StorylineApp/> (src/dashboard/StorylineApp.tsx), so the mount
// order the kernel wants — React unsubscribes first, then the plugin cleanups run
// (socket closed last, being registered first) — holds for any host, not only for
// this bundle. An earlier shape (build the instance here, hand it down) made the
// standalone entry correct and every OTHER embedder responsible for getting the
// teardown right by hand.
//
// StrictMode is kept on purpose: its setup -> cleanup -> setup double-run is where
// a lifecycle mistake shows up, and the deferred-dispose path in StorylineApp is
// built for it (that file's header explains the microtask and the cancel).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// `#root` is guaranteed by index.html. The stylesheet travels with the shell
// (WorkstationShell imports it), so an embedder never renders an unstyled tree.
createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <App />
    </StrictMode>
);
