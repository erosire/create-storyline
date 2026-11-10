// Every storyline REST route below the mount: `/v1/storyline/*`.
//
// This is the module `@underload/service` discovers. The gateway scans its root for
// folders named `endpoint`/`endpoints`, imports every `service-route*.ts` inside them
// BEFORE it binds, and installs `app.all(config.route)` around our default export.
// The handler is the storyline remount of the harness API
// (../../service.ts), so this mount answers the whole canonical surface — sessions,
// turns, threads, tools, agents, harnesses — under a story-shaped root.
//
// NO `port` on purpose. A declared port would move this endpoint onto an isolated
// worker listener and the gateway would answer with a 307 redirect, and a WebSocket
// upgrade cannot follow one; the API is cheap to host in-process, so it shares the
// gateway's single listener (and the gateway's single origin) instead.
//
// `body: 'raw'` asks the loader to skip its pre-parse so the harness applies its own
// streaming size cap (a 16 MiB base64 attachment would otherwise be buffered and
// parsed twice). See packages/underload/harness/src/server/service.ts "BODY BOUNDS".
//
// Cross-references:
//   - ./service-route-root.ts  — the bare `/v1/storyline` boot document
//   - ./service-route-stream.ts — the `/v1/storyline/stream` upgrade
//   - ../../service.ts          — the remount, and why the rewrite exists
import { STORYLINE_WILDCARD_ROUTE, createStorylineServiceHandler } from '../../service';

export default {
    route: STORYLINE_WILDCARD_ROUTE,
    handler: createStorylineServiceHandler(),
    body: 'raw' as const
};
