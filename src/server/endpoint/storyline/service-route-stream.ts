// The WebSocket stream route: `GET /v1/storyline/stream` (subprotocol `harness.v1`).
//
// Its OWN module rather than a case inside the wildcard's handler, for one mechanical
// reason: the loader attaches an `upgrade` hook to a DECLARED route and matches an
// EXACT path unambiguously
// (packages/underload/service/src/server/start.ts `routeMatchesPath`). `/v1/storyline/*`
// would also match this path, and letting both claim it would make registration
// order decide whether the handshake ever happens.
//
// BOTH halves live here:
//   - `upgrade` — the real `101` on the gateway's own listener (same host, same port,
//     no second listener invented), served from the SAME root-keyed runtime as REST,
//     so the epoch in the handshake headers is the epoch on `X-Harness-Epoch`;
//   - `handler` — what a plain HTTP GET on this path gets. The loader still requires
//     every endpoint module to carry a handler, and a non-upgrade GET is a 400 by the
//     harness contract (the message names this mount, because the adapter rewrites the
//     mount on the way out).
//
// `body: 'raw'` keeps the two REST modules honest about the same body policy; a
// stream GET carries no body anyway.
//
// The subprotocol is `harness.v1` and is NOT renamed: it identifies the frame
// contract, not the URL, and this mount speaks that contract verbatim.
//
// Cross-references:
//   - ../../service.ts — createStorylineServiceHandler / createStorylineServiceUpgrade
//   - ./service-route.ts / ./service-route-root.ts — the REST halves of this mount
import { STORYLINE_STREAM_ROUTE, createStorylineServiceHandler, createStorylineServiceUpgrade } from '../../service';

export default {
    route: STORYLINE_STREAM_ROUTE,
    handler: createStorylineServiceHandler(),
    upgrade: createStorylineServiceUpgrade(),
    body: 'raw' as const
};
