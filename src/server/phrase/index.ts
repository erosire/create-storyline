// Barrel for the Summary Phrase domain (R1-R6).
//
// The four modules split along the seams the redesign's rules split along, so a change to one rule
// touches one file: `catalog.ts` owns what exists in the book and the group-managed predicate
// (R1/R6), `revisions.ts` owns the install/archive/mirror commit (R2/R5/R6), `exclusion.ts` owns the
// one-writer-per-group rule (R4), and `findings.ts` owns a finding's groups and its closure (R3).
// `loop/work.ts`, `loop/engine.ts` and `api/**` import from HERE rather than reaching into a module,
// so the domain keeps one surface and an import cannot quietly skip a rule's owner.
export * from './catalog';
export * from './revisions';
export * from './exclusion';
export * from './findings';
// PHRASE GROUP LOCK (R-lock): the two writes that put a group's current text out of the loop's reach and
// bring it back, plus the refusal a route turns into a 409. The flag's READ is `catalog.ts`'s
// `isPhraseGroupLocked`, because every module that subtracts locked groups already imports that file.
export * from './locks';
// SUMMARY PHRASE D-67/D-68: the Clean stamp, the reviewed selection, and the Author's choose. Its seat
// keys are `exclusion.ts`'s, its rows are `group_revisions` rows, and its only consumer on the loop
// side is the scoring seat — never a gate (D-65's boundary holds through this module).
export * from './reviewed';
// READER SCORING (D-65): the SectionScores answer check. Its claim key lives in `exclusion.ts`
// beside the review seats it re-arms with, and its rows are written by the engine's settle.
export * from './section-scores';
