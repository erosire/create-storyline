// §10 / W9 — the program entry (T7). `yarn start` runs THIS file, and nothing imports it.
//
// WHY THE ENTRY IS ITS OWN FILE AND NOT THE BOTTOM OF `cli.ts`: vite-node runs a module out of its own
// transform pipeline, so `process.argv[1]` is vite-node's bin rather than the entry path — an "am I the
// program?" guard cannot be answered inside `cli.ts`. And an unconditional boot there would bind a
// listener every time `api/server.test.ts` imports `parseArgs` for the flag grammar. A file nobody imports
// is the answer this repo already uses (`packages/underload/service/server.ts` does exactly this).
//
// ALL THE DECISIONS LIVE ELSEWHERE: flags → `./cli.ts`, precedence → `../config.ts`, composition →
// `./main.ts`, routes → `./api/`. This file exists only to say "start it".
import { run } from './cli';

// Top-level await: a bad flag or an unwritable store root must exit non-zero through `run()`'s own
// sentence rather than leaving a half-booted process behind (W9).
await run();
