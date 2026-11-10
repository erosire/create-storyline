// The endpoint-module contract (R1): what `@underload/service` reads off our default
// exports BEFORE it binds a listener.
//
// These assertions are deliberately about the EXPORTS, not about a request: the
// loader validates `route` and `handler` at import time, decides the port from
// `config.port`, and only then builds the app. A mistake here is a gateway that never
// mounts this package at all, and no request would ever explain why.
import { describe, expect, it } from 'vitest';
import rootModule from './service-route-root';
import streamModule from './service-route-stream';
import wildcardModule from './service-route';
import { STORYLINE_MOUNT, STORYLINE_STREAM_ROUTE, STORYLINE_WILDCARD_ROUTE, storylineRuntimeCount } from '../../service';

describe('storyline endpoint modules', () => {
    it('claim exactly the routes this mount documents', () => {
        expect(rootModule.route).toBe(STORYLINE_MOUNT);
        expect(wildcardModule.route).toBe(STORYLINE_WILDCARD_ROUTE);
        expect(streamModule.route).toBe(STORYLINE_STREAM_ROUTE);
    });

    it('declare no port, so the gateway serves them in place', () => {
        // A declared port would move each module to its own worker listener and the
        // gateway would answer with a 307 — and a WebSocket upgrade cannot follow a
        // redirect. Absence is load-bearing, hence an explicit assertion.
        expect('port' in rootModule).toBe(false);
        expect('port' in wildcardModule).toBe(false);
        expect('port' in streamModule).toBe(false);
    });

    it('export a handler on every module and an upgrade only on the stream', () => {
        expect(typeof rootModule.handler).toBe('function');
        expect(typeof wildcardModule.handler).toBe('function');
        expect(typeof streamModule.handler).toBe('function');

        // The upgrade hook is what answers the `101`; a `/*` route claiming one would
        // make registration order decide the handshake, so only the exact path has it.
        expect('upgrade' in rootModule).toBe(false);
        expect('upgrade' in wildcardModule).toBe(false);
        expect(typeof streamModule.upgrade).toBe('function');
    });

    it('ask the loader to skip the body pre-parse everywhere the harness bounds it itself', () => {
        expect(wildcardModule.body).toBe('raw');
        expect(streamModule.body).toBe('raw');
        // The bare mount serves a GET-only boot document; the loader's default
        // (pre-parsed) policy is correct there and must stay the default.
        expect('body' in rootModule).toBe(false);
    });

    it('export nothing beyond the loader contract', () => {
        expect(Object.keys(rootModule).sort()).toEqual(['handler', 'route']);
        expect(Object.keys(wildcardModule).sort()).toEqual(['body', 'handler', 'route']);
        expect(Object.keys(streamModule).sort()).toEqual(['body', 'handler', 'route', 'upgrade']);
    });

    it('import without building a runtime or reading the provider environment', () => {
        // The loader imports every route module before it serves a request, and the
        // first request is the first moment a database root exists. Reaching this
        // file means three route modules and the adapter were evaluated; a runtime
        // count of zero proves that evaluation bound nothing — no store, no `.env`
        // read, no listener.
        expect(storylineRuntimeCount()).toBe(0);
    });
});
