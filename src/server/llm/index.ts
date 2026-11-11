// Barrel for the LLM layer. The pinned transport types and the factory live in `./client`;
// the deterministic provider used by this package's integration suites lives in `./mock`.
// Nothing else in the package is re-exported from here, so the executor can bind to this
// directory alone (S-1: one transport, one mock, no hidden coupling).
export * from './client';
export * from './mock';
