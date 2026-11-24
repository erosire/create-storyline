// Barrel for the shared contract: the §4 data model, the §5 Goal contract, and the one
// derived read over chapter prose. Browser-safe by construction — no Node imports anywhere
// under `src/shared`, because the dashboard (W9-W13) bundles exactly this surface.
export * from './types';
export * from './criteria';
export * from './chapter';
// The Summary Phrase catalog (R1). Browser-safe like the rest of this barrel: `./phrase` imports
// `./types` for TYPES ONLY, so the dashboard can render group titles without the server.
export * from './phrase';
