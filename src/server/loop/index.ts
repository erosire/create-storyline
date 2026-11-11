// W4's loop engine (§6): the sweep that reads the records, decides each Story's status, and dispatches
// Work Items — plus the Author's verbs the dashboard and the MCP server call (§9).
//
// The barrel is ordered the way the sweep itself runs, inner-to-outer:
//   ./types          the pinned `EngineApi`, the deps, the sweep reports, and the §4-legal additions
//   ./records        every read the loop does, including the claim-with-lease and the recency rules
//   ./trend          L-14's rendered consistency and L-15/L-21's round and stall measurement
//   ./status         L-16's `decideStory` — the status machine, `drained` included (L-37, L-37a)
//   ./work           what jobs a Story is entitled to run this sweep (§6.2's three loops, L-1 step 4)
//   ./invalidation   L-11/L-11a's propagation and the phase locks' reach (L-28…L-32)
//   ./directives     D-19's determination: what one line of Author direction touches
//   ./engine         `LoopEngine implements EngineApi` — the sweep and every verb
//   ./mock           the rig the loop's tests run on: real store + executor + criteria, scripted crew
//
// `src/index.ts` deliberately does NOT re-export this directory: the package barrel is browser-safe and
// `src/server/**` is a Node module graph (the store writes through `node:fs`).
export * from './types';
export * from './records';
export * from './trend';
export * from './status';
export * from './work';
export * from './invalidation';
export * from './directives';
export * from './engine';
export * from './mock';
