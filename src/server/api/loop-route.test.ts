// `GET /loop` and `PATCH /loop` — S-5's fan-out ceiling, the one engine setting the Author moves from
// the workstation (the employee rail's "Max threads" dropdown beside the roster's name).
//
// WHAT IS REAL HERE: the shipped `Store` and `LoopEngine` behind the mounted route table. The PATCH is
// asserted against `runtime.engine.config`, because that object is exactly what the sweep reads on every
// dispatch (`engine.ts:dispatch`) — a projection that agreed with a setting nobody reads would pass a
// test like this one and still ship a dead knob.
import { describe, expect, it } from 'vitest';
import { buildStorylineRuntime } from './server';
import { Store } from '../store/store';
import { DEFAULT_GLOBAL_MAX_CONCURRENT } from '../loop/types';
import { LOOP_CEILING_SETTING } from '../loop/ceiling';
import type { Run } from '../../shared/types';

const ENV = {
    STORYLINE_PROVIDER_BASE_URL: 'http://127.0.1.1/v1',
    STORYLINE_PROVIDER_MODEL: 'scripted',
    STORYLINE_PROVIDER_API_KEY: ''
};

/** The runtime, with the sweep timer off (L-1: a test is the clock). */
const runtime = (store: Store = Store.empty(), env: Record<string, string> = ENV) =>
    buildStorylineRuntime({ store, engineConfig: { autoSweep: false }, noAssistantSeed: true, env });

/** One live thread the ceiling has to count: a `working` run row is what `liveRuns` reads (L-2). */
const liveRun = (store: Store, index: number): Run =>
    store.runs.create(
        {
            story_id: 'story_1',
            work_item_ref: `wi_review_summary_a${index}`,
            role: 'critic',
            state: 'working',
            started_at: '2026-11-24T10:00:00.000Z',
            tokens: 1000 * index,
            kind: 'work',
            delegated: []
        },
        { run_ref: null, author: true, why: `seed live thread ${index} for the ceiling’s live count` }
    );

const call = async (app: ReturnType<typeof runtime>['app'], method: 'GET' | 'PATCH', body?: unknown) => {
    const response = await app.request('http://localhost/v1/storyline/loop', {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    });

    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const errorOf = (reply: { body: Record<string, unknown> }): string => reply.body.error as string;

describe('GET /loop', () => {
    it('answers the shipped ceiling with nothing live, before any Story dispatches work', async () => {
        const reply = await call(runtime().app, 'GET');

        expect(reply.status).toBe(200);
        // S-5's shipped ceiling is EXACTLY 12 threads, spelled as a literal here: reading it back through
        // `DEFAULT_GLOBAL_MAX_CONCURRENT` would let the projection drift with the constant and still pass.
        expect(reply.body).toEqual({ global_max_concurrent: 12, live_runs: 0 });
        // ...and the constant itself is pinned, because that is the value the boot falls back to
        // (`api/server.ts:234` leaves `globalMaxConcurrent` undefined when env/config/store are all unset,
        // and `engine.ts:209` fills in `DEFAULT_GLOBAL_MAX_CONCURRENT`). Changing `loop/types.ts:304`
        // without changing this line is a shipped-default change, and it must fail here.
        expect(DEFAULT_GLOBAL_MAX_CONCURRENT).toBe(12);
    });

    it('reports the ceiling the process booted with, when the env var set it (S-5)', async () => {
        const app = runtime(Store.empty(), { ...ENV, STORYLINE_GLOBAL_MAX_CONCURRENT: '12' }).app;

        expect((await call(app, 'GET')).body).toEqual({ global_max_concurrent: 12, live_runs: 0 });
    });

    it('counts every live thread across every Story, which is what makes the ceiling global (S-5)', async () => {
        // Seeded AFTER the runtime is built on purpose: a live run row that predates the engine is an
        // orphan, and `LoopEngine`'s recovery abandons it on construction (L-3). Counting occupancy
        // means counting THIS process's threads.
        const built = runtime();

        liveRun(built.store, 1);
        liveRun(built.store, 2);
        built.store.runs.create(
            {
                story_id: 'story_2',
                work_item_ref: 'wi_sample_summary_1_a1',
                role: 'writer',
                state: 'spawning',
                started_at: '2026-11-24T10:00:00.000Z',
                tokens: 0,
                kind: 'work',
                delegated: []
            },
            { run_ref: null, author: true, why: 'seed the second Story’s live thread' }
        );
        // A closed row is history, not occupancy (L-2's claim lives only in a LIVE run row).
        built.store.runs.create(
            {
                story_id: 'story_1',
                work_item_ref: 'wi_check_chapters_1',
                role: 'reader',
                state: 'torn_down',
                started_at: '2026-11-24T09:00:00.000Z',
                ended_at: '2026-11-24T09:00:02.000Z',
                tokens: 40,
                kind: 'work',
                no_op: true,
                end_reason: 'torn_down',
                delegated: []
            },
            { run_ref: null, author: true, why: 'seed a closed run the count must ignore' }
        );

        expect((await call(built.app, 'GET')).body).toEqual({ global_max_concurrent: 12, live_runs: 3 });
    });
});

describe('PATCH /loop', () => {
    it('moves the ceiling the sweep itself reads, and answers the fresh projection', async () => {
        const built = runtime();
        const reply = await call(built.app, 'PATCH', { global_max_concurrent: 8 });

        expect(reply.status).toBe(200);
        expect(reply.body).toEqual({ global_max_concurrent: 8, live_runs: 0 });
        // The knob is not a projection of a projection: this is the object `engine.ts:dispatch`
        // compares `liveRuns` against, so the NEXT sweep fills to 8.
        expect(built.engine.config.globalMaxConcurrent).toBe(8);
        expect((await call(built.app, 'GET')).body).toEqual({ global_max_concurrent: 8, live_runs: 0 });
    });

    it('cancels nothing when the ceiling drops under the threads already live (L-10)', async () => {
        const built = runtime();

        liveRun(built.store, 1);
        liveRun(built.store, 2);
        liveRun(built.store, 3);

        const reply = await call(built.app, 'PATCH', { global_max_concurrent: 1 });

        expect(reply.status).toBe(200);
        expect(reply.body).toEqual({ global_max_concurrent: 1, live_runs: 3 });
        // Lowering the cap is a gate on the NEXT claim, never a cut into a running pass.
        expect(built.store.runs.list().map((run) => run.state)).toEqual(['working', 'working', 'working']);
    });

    it('refuses a body without the field, naming it', async () => {
        const reply = await call(runtime().app, 'PATCH', {});

        expect(reply.status).toBe(400);
        expect(errorOf(reply)).toBe(
            '`global_max_concurrent` is required — send the number of threads the loop may run at once (S-5).'
        );
    });

    it('refuses a ceiling that is not a whole number of threads, and keeps the ceiling it had', async () => {
        const built = runtime();

        for (const value of [0, -3, 2.5, '8', null]) {
            const reply = await call(built.app, 'PATCH', { global_max_concurrent: value });

            expect(reply.status, `global_max_concurrent: ${JSON.stringify(value)}`).toBe(400);
            expect(errorOf(reply)).toBe(
                '`global_max_concurrent` must be a whole number of threads, at least 1 — it is the hard cap on simultaneous runs (S-5).'
            );
        }

        expect(built.engine.config.globalMaxConcurrent).toBe(DEFAULT_GLOBAL_MAX_CONCURRENT);
    });

    it('refuses a body that is not an object', async () => {
        const response = await runtime().app.request('http://localhost/v1/storyline/loop', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: '[8]'
        });

        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe('this route needs a JSON object body.');
    });
});

describe('the ceiling survives a restart', () => {
    // It is host configuration, so it rides the store's non-journaled `settings` section — the same
    // seam the roster's model choices use (U-8). A ceiling that reset to the shipped default
    // (`DEFAULT_GLOBAL_MAX_CONCURRENT`) on every boot would make the rail's dropdown a suggestion rather
    // than a control.
    it('remembers the Author’s ceiling in the settings, and writes nothing to the journal', async () => {
        const built = runtime();

        await call(built.app, 'PATCH', { global_max_concurrent: 12 });

        expect(built.store.setting(LOOP_CEILING_SETTING)).toBe(12);
        // Not one commit: the ceiling is not a fact about the book, so it must never reach the journal
        // or the Digest's derivation (D-12a).
        expect(built.store.journal).toHaveLength(0);
    });

    it('boots a fresh engine on the ceiling the Author last chose', async () => {
        const built = runtime();

        await call(built.app, 'PATCH', { global_max_concurrent: 12 });

        // Exactly what a restart is: a new engine over the same store root.
        const restarted = runtime(built.store);

        expect(restarted.engine.config.globalMaxConcurrent).toBe(12);
        expect((await call(restarted.app, 'GET')).body).toEqual({ global_max_concurrent: 12, live_runs: 0 });
    });

    it('lets the operator’s env pin outrank a remembered ceiling', async () => {
        const built = runtime();

        await call(built.app, 'PATCH', { global_max_concurrent: 12 });

        const restarted = runtime(built.store, { ...ENV, STORYLINE_GLOBAL_MAX_CONCURRENT: '3' });

        // The person who exports the variable is sizing a machine, and that outranks a click.
        expect(restarted.engine.config.globalMaxConcurrent).toBe(3);
    });

    it('ignores a malformed remembered ceiling rather than stranding the sweep', async () => {
        const built = runtime();

        // A hand-edited `store.json` must not become a ceiling of `NaN` — that is a loop with nothing
        // to dispatch and no sentence to say why.
        built.store.setSetting(LOOP_CEILING_SETTING, 'many');

        expect(runtime(built.store).engine.config.globalMaxConcurrent).toBe(DEFAULT_GLOBAL_MAX_CONCURRENT);
    });
});
