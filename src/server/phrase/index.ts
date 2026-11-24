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
