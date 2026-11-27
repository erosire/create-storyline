// Package barrel — TYPE DEFINITIONS ONLY.
//
// This package is the UI. The Storyline server is a separate package and repository
// (`@underload/storyline`), and the UI never imports it: every record shape and projection it
// renders arrives over `/v1/storyline` through `src/dashboard/api.ts`.
//
// Runtime product data (phrase catalog/composition, criteria roster and levels, Seed hash,
// default dials, chapter-entry formatting) is owned by the server, not duplicated here. The one
// thing this package keeps is the shape of the wire (`./types`), so TypeScript can type what the
// server sends. Test-only mocks live under `src/dashboard/testing/`.
export type * from './types';
