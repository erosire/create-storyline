// The one API root this UI dials — and the seam that makes it stick.
//
// THE CONTRACT: storyline's server exposes the harness HTTP surface under
// `/v1/storyline` (REST) and `/v1/storyline/stream` (WebSocket, subprotocol
// `harness.v1`). Every route is a harness route with the prefix swapped; the dev
// server proxies `/v1/storyline` to the @underload/service gateway on :5000
// (vite.config.ts), so the UI stays same-origin with the gateway in development
// and needs no absolute host at all.
//
// WHY THIS FILE WRITES A GLOBAL: `@underload/harness/frontend` resolves its API
// root EXACTLY ONCE, while that module is being evaluated — `api.ts` runs
// `const initialRoot = resolveRoot()` at module scope, and every request URL is
// built from that value through the `API_ROOT` live binding. Its documented
// resolution chain is: `?apiRoot=` query → the URL this browser saved →
// `window.__HARNESS_CONFIG__.apiRoot` / `<meta name="harness-api-root">` →
// `import.meta.env.VITE_HARNESS_API` → the canonical `/v1/harness`. A query or
// injected value is trust-gated only when it names ANOTHER origin, so the rooted
// path `/v1/storyline` is accepted on every host without a rebuild.
//
// Writing `__HARNESS_CONFIG__` here is therefore the whole mount: no fork of the
// harness package, no build-time env, and `streamSocketUrl()` follows the same
// root automatically, so REST and WS can never disagree.
//
// IMPORT ORDER IS THE CONTRACT. Because ESM evaluates a module's dependencies
// before the module's own body, THIS file must not import the harness client —
// it would land after the root had already been resolved. So this module imports
// nothing, and every module that does import the client (`src/api/storyline.ts`)
// lists './root' as its FIRST import. Nothing else in this package touches the
// harness client, which keeps that rule checkable by eye.
//
// Verified against the package (probe run): with this file imported first,
// `apiUrl('/v1/harness/sessions')` answers `/v1/storyline/sessions` and
// `streamSocketUrl()` answers `ws://<origin>/v1/storyline/stream`.

/** The one REST root of the storyline API (also the WS root plus `/stream`). */
export const STORYLINE_API_ROOT = '/v1/storyline';

// The write itself. Only filled in when nothing has pinned the root yet, so an
// explicit `?apiRoot=`/saved setting still wins over this default, and a host
// that renders its own `__HARNESS_CONFIG__` keeps whatever it set.
const injected = globalThis as unknown as { __HARNESS_CONFIG__?: { apiRoot?: string } };

injected.__HARNESS_CONFIG__ = { apiRoot: STORYLINE_API_ROOT, ...injected.__HARNESS_CONFIG__ };
