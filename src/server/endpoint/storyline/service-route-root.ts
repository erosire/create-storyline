// The bare mount document: `GET /v1/storyline`.
//
// A separate module because the loader registers the literal `route` string with
// `app.all(...)`, and Hono's wildcard `/v1/storyline/*` does NOT match the bare
// `/v1/storyline` path. Both modules build their handler from the same factory, and
// the factory resolves a root-keyed runtime, so the two halves share one store, one
// registry and one stream epoch.
//
// What `GET` answers is the harness boot document (`{ api_root, service, api_version,
// epoch, capabilities, links, ... }`) with the mount rewritten: `api_root` and every
// link say `/v1/storyline`, because a client that booted at this root must be handed
// links it can follow through this gateway. Any other method is the dispatcher's 405,
// and unknown subpaths are the wildcard module's 404.
//
// Cross-references:
//   - ./service-route.ts — everything below the mount
//   - ../../service.ts   — the remount, and why `api_root` has to be rewritten
import { STORYLINE_ROOT_ROUTE, createStorylineServiceHandler } from '../../service';

export default {
    route: STORYLINE_ROOT_ROUTE,
    // The body policy stays the loader default (`parsed`): this route serves a boot
    // document over GET, and the dispatcher requires an object body only for action
    // endpoints, which live on the wildcard module.
    handler: createStorylineServiceHandler()
};
