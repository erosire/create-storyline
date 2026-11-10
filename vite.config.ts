// Vite configuration for the create-storyline app (the dashboard + server pair
// that T1/T2 fill in). Modelled on distribution/chat-assistant/vite.config.ts —
// the repo's only other dashboard+harness app — with the mount contract and the
// dev port/proxy swapped for this package's decisions.
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Application version: read once from this package's package.json and injected
// as the `__APP_VERSION__` define, so the UI never carries a hardcoded duplicate
// of the "version" field (same single-source trick as chat-assistant's
// src/version.ts). A plain global define — not `import.meta.env.APP_VERSION` —
// because vitest's runtime rewrites `import.meta.env` access and silently
// swallows env-scoped defines during test runs, whereas esbuild substitutes a
// plain identifier identically in the vite build, the dev server, and vitest.
const APP_VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')).version as string;

// The dev proxy target: the @underload/service GATEWAY (port 5000), not a
// private harness listener like chat-assistant's :5181. Storyline reaches its
// harness through a gateway endpoint module mounted at `/v1/storyline`, so the
// browser dev server has to front the gateway. Overridable for a developer who
// runs the gateway elsewhere.
const DEV_API_TARGET = process.env.STORYLINE_DEV_TARGET ?? 'http://127.0.0.1:5000';

export default defineConfig({
    plugins: [react()],
    // Pin the package.json version into the bundle (see the APP_VERSION note
    // above) — mirrored by the define in vitest.config.ts so tests assert the
    // same value the shipped UI renders.
    define: {
        __APP_VERSION__: JSON.stringify(APP_VERSION)
    },
    // Relative assets keep the build servable from any path, including a host
    // that mounts the UI under a prefix (e.g. served behind the gateway).
    base: './',
    server: {
        // 4510 — this package's UI dev port (4500 is chat-assistant's).
        port: 4510,
        // THE DEV PROXY: `/v1/storyline` is the one root the UI dials, so
        // proxying it makes `yarn dev` on :4510 same-origin with the gateway on
        // :5000 — REST AND WEBSOCKET. `ws: true` is not optional: live story
        // deltas ride `wss?://<origin>/v1/storyline/stream` with the
        // `harness.v1` subprotocol, and without the socket upgrade path the
        // dashboard would stream nothing in development.
        proxy: {
            '/v1/storyline': {
                target: DEV_API_TARGET,
                changeOrigin: true,
                ws: true
            }
        },
        // Never watch the repo-root scratch directory (see AGENTS.md "Scratch
        // Space"): chokidar holding files under Temp/ while a harness run
        // persists a turn surfaces as sporadic EPERM failures on Windows.
        watch: {
            ignored: ['**/Temp/**']
        }
    },
    build: {
        outDir: 'dist'
    }
});
