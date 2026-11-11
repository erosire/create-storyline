// Package barrel — the shared contract: the §4 data model, the §5 Goal, and the one derived
// read over chapter prose.
//
// KEPT BROWSER-SAFE ON PURPOSE: `src/server/**` is a Node module graph (the store persists
// through `node:fs`), so it is deliberately NOT re-exported here — the dashboard (W9-W13)
// imports this barrel and must never pull the server into the bundle. The server surface gets
// its own entry point when a later wave promotes one (e.g. a `./server` subpath), and the
// store stays importable by path (`src/server/store`).
//
// The explicit `Criterion` re-export is not redundancy: `./shared/criteria` re-exports that
// type too (it is §5.1's shape and lives beside the roster that uses it), and a name arriving
// from two `export *` arms is an ambiguous re-export — an explicit one resolves it.
export * from './shared/types';
export * from './shared/criteria';
export * from './shared/chapter';
export type { Criterion, CriterionChecker } from './shared/types';
