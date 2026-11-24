// Barrel for the per-Story runtime layer (S-RUNTIME).
//
// Three objects, and each answers one question the rest of the server cannot answer for itself:
//   * `ceiling.ts`       — how many runs may be live across EVERY Story (S-5's one number);
//   * `server-config.ts` — which crews and host settings a Story book is configured with (the app book);
//   * `story-runtimes.ts`— the Stories this process is running, and the loop the routes talk to.
// `persist.ts`/`story-stores.ts` own the layout and the books; this layer owns what runs ON them.
export * from './ceiling';
export * from './server-config';
export * from './story-runtimes';
