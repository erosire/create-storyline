// The @underload/service route forwards every `/v1/storyline/*` request into the Hono app.
//
// Storyline owns its server and its agents, so the service loader supplies only the storage
// boundary (`variables.root`); no harness catalogue is forwarded.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { disposeStorylineServiceRuntimes, storylineServiceHandler } from './service-route';

const call = (variables?: Record<string, unknown>) =>
    storylineServiceHandler(
        { req: { raw: new Request('http://localhost/v1/storyline/agents') } },
        undefined,
        variables
    );

const kindsOf = async (response: Response): Promise<string[]> =>
    ((await response.json()) as Array<{ kind: string }>).map((listing) => listing.kind);

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

    it('serves the Storyline employee roster from the mounted app', async () => {
        const result = await call();

        expect(result.raw.status).toBe(200);
        // §7.3 / U-8: five dispatched kinds, ALPHABETICALLY (the route sorts the harness catalogue
        // projection; T12/F1).
        expect(await kindsOf(result.raw)).toEqual(['checker', 'editor', 'reader', 'researcher', 'writer']);
    });

    it('ignores any harness variables: the storyline control plane owns them', async () => {
        const result = await call({ harness: { presets: [] } });

        expect(result.raw.status).toBe(200);
        // §7.3 / U-8: five dispatched kinds, ALPHABETICALLY (the route sorts the harness catalogue
        // projection; T12/F1).
        expect(await kindsOf(result.raw)).toEqual(['checker', 'editor', 'reader', 'researcher', 'writer']);
    });
});
