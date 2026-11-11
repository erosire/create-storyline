// W5's run layer (the spawner half of §9): one Work Item in, one closed run row out.
//
// The barrel is ordered inner-to-outer — the pinned surface first, so a reader meets the
// contract before the machinery that satisfies it:
//   ./types      the Work Item, the RunResult, and the PERMISSIVE MIRROR of T3's tool runtime
//   ./catalogue  the three name questions the layer answers (S-4 reports, D-38 proposals, D-38 grouping)
//   ./harness    template + role resolution (S-2's role prompt, D-17a's kind → permission row)
//   ./brief      S-2 assembly, E-3 budget, §4.13 `brief_hash`
//   ./loop       the one turn engine, shared by the run, its panel agents, and its delegates
//   ./panel      D-38: N agents of one role, aggregated to a single answer inside one run
//   ./executor   the run row's life, the unconditional teardown (S-3), kill (P8), delegation (D-17e)
//   ./mock       the test double for T3's runtime plus the §4 fixtures the layer's tests build on
//
// `src/index.ts` deliberately does NOT re-export this directory: the package barrel is
// browser-safe and `src/server/**` is a Node module graph (the store writes through `node:fs`).
export * from './types';
export * from './catalogue';
export * from './harness';
export * from './brief';
export * from './loop';
export * from './panel';
export * from './executor';
export * from './mock';
