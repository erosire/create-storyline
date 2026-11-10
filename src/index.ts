// Package barrel — the browser-facing surface of the storyline app.
//
// Kept browser-safe on purpose: the API root, the REST/stream clients, the
// composition factory and the app component. The server entry lives in
// `src/server/**` (a Node-only module graph: the harness runtime and the
// @underload/service gateway mount), so it is deliberately NOT re-exported here —
// a browser importing this barrel must never pull Node code into the bundle. When
// integration promotes the server entry to a public export, it belongs in its own
// subpath (e.g. `./server` in package.json exports), not in this file.
export * from './api';
export * from './dashboard';
export { App } from './App';
