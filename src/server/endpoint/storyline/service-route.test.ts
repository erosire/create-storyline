// R5 — the @underload/service route forwards `variables.harness` into the Storyline boot and
// refuses a later, different configuration for the same root instead of silently reusing the
// first runtime. The in-memory store root keeps the test off the filesystem; `dispose` stops the
// loop and clears the module cache between cases.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { disposeStorylineServiceRuntimes, storylineServiceHandler } from './service-route';
import type { HarnessBootConfiguration } from '@underload/harness/server';

const customHarness: HarnessBootConfiguration = {
    presets: [
        {
            name: 'service-team',
            title: 'Service team',
            description: 'One service-declared card.',
            agents: ['general'],
            entry: 'general',
            ranks: { general: 'A' },
            tools: [],
            environmentTools: []
        }
    ],
    plugins: [],
    toolbox: { sharedToolbox: false }
};

// The loader's context: only the raw Request is read by the forwarder.
const call = (variables?: Record<string, unknown>) =>
    storylineServiceHandler(
        { req: { raw: new Request('http://localhost/v1/storyline/harnesses') } },
        undefined,
        variables
    );

const namesOf = async (response: Response): Promise<string[]> =>
    ((await response.json()) as Array<{ name: string }>).map((listing) => listing.name);

describe('the Storyline service route', () => {
    let previousStoreRoot: string | undefined;

    beforeEach(() => {
        previousStoreRoot = process.env.STORYLINE_STORE_ROOT;
        // The blank value is the documented in-memory switch, so every case shares the
        // `<memory>` cache key without touching a book on disk.
        process.env.STORYLINE_STORE_ROOT = '';
    });

    afterEach(async () => {
        await disposeStorylineServiceRuntimes();

        if (previousStoreRoot === undefined) delete process.env.STORYLINE_STORE_ROOT;
        else process.env.STORYLINE_STORE_ROOT = previousStoreRoot;
    });

    it('lists the Storyline default when no variables.harness is supplied', async () => {
        const result = await call();

        expect(result.raw.status).toBe(200);
        expect(await namesOf(result.raw)).toEqual([
            'general',
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner',
            'debugger',
            'chat'
        ]);
    });

    it('forwards variables.harness to the boot and lists exactly the host catalogue', async () => {
        const result = await call({ harness: customHarness });

        expect(result.raw.status).toBe(200);
        expect(await namesOf(result.raw)).toEqual(['service-team']);
    });

    it('rejects a different configuration for the same root instead of mixing catalogues', async () => {
        await call({ harness: customHarness });

        // The first request decided `<memory>`; an explicit empty configuration is a different
        // signature and must fail loudly rather than returning the first runtime's cards.
        await expect(call({ harness: {} })).rejects.toThrow(
            /The Storyline runtime for "<memory>" was already created with a DIFFERENT harness boot configuration/
        );

        // The original configuration still resolves, and its listing did not change.
        const repeated = await call({ harness: customHarness });

        expect(await namesOf(repeated.raw)).toEqual(['service-team']);
    });

    it('keeps an explicit empty configuration empty', async () => {
        const result = await call({ harness: {} });

        expect(result.raw.status).toBe(200);
        expect(await result.raw.json()).toEqual([]);
    });
});
