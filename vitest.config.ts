// Vitest configuration uses jsdom because the package ships a React dashboard.
// Mirrors distribution/chat-assistant/vitest.config.ts.
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Mirror vite.config.ts's `__APP_VERSION__` define so tests resolve the app
// version from the same single source (this package's package.json) the shipped
// bundle does. A plain global define, not `import.meta.env.APP_VERSION`, because
// vitest's runtime materializes `import.meta.env` and swallows env-scoped
// defines in test runs.
const APP_VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')).version as string;

// Keep test discovery scoped to this package. `passWithNoTests` is what keeps
// `yarn workspace @erosire/create-storyline test` green at scaffold time, before
// T1/T2 have added any spec files.
export default defineConfig({
    define: {
        __APP_VERSION__: JSON.stringify(APP_VERSION)
    },
    test: {
        environment: 'jsdom',
        globals: true,
        include: ['src/**/*.{test,spec}.{ts,tsx}'],
        passWithNoTests: true,
        // Harness-backed suites (lane runs, streaming) routinely exceed vitest's
        // default ceilings (5s test / 10s hook) under a parallel turbo run; a
        // timed-out test also leaves its in-flight stream running and poisons the
        // next test in the file. Both get explicit headroom up front.
        testTimeout: 60_000,
        hookTimeout: 60_000
    }
});
