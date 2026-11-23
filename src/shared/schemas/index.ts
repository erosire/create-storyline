// Barrel for the structured-output contracts (documents/phase-1-research-pipeline.md §4.3).
//
// Both schemas are plain data plus their TS mirrors; nothing here imports a library, so the
// dashboard and the server can consume the same contract without dragging runtime code along.
export * from './summary-sample';
export * from './issue-list';
