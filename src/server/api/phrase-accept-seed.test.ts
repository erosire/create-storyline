// R6 — THE ACCEPT COPIES THE SUMMARY THE AUTHOR IS LOOKING AT.
//
// The Author's report: "When I selected Accept Final Summary, to move into Plotlines Phrase, it doesn't copy the
// complete compile Seed correctly (or maybe it did and the Editor mess it up)." R6 is the half of that the server
// owns: the text handed to Phrase ② in `POST /stories/:id/lock`'s second commit must be THE text the Author saw
// and accepted as the Summary — and where the two can legitimately differ, the difference must be named, not silent.
//
// WHAT THE RAIL SHOWS, and it is not `PhraseView.overview` (2026-11-27 forensics on the recovered real book
// `025292ba…`, `Temp/p1/REPORT.md`): the Summary tab prints `story-contract.ts:reviewedSummaryText` —
// `reviewed.overview` in `ready`, `reviewed.chosen.overview` in `chosen`, and NOTHING in `pending` — and prints the
// live composed Overview "NOWHERE on that tab" (`knowledge.md:471-474`, D-67). So `displayed()` below is the
// Author's Summary, restated here as the rule rather than imported so a client module never rides into the server
// suite; `PhraseSeedPane.test.tsx` pins the same rule against the real function on the desk side.
//
// THE TWO CASES THIS FILE EXISTS FOR:
//
//   1. `ready` — the newest group text carries an open defect (or simply no verdict), so the reviewed selection
//      stands on an EARLIER clean revision: §4.19's `latest_revision: 5` beside `selected_revision: 4`
//      ("Ending r5 has an issue, so the reviewed Ending is r4"). The rail shows the reviewed text and the Accept
//      copies it, even though the group rows hold newer words. §17.16 is why the newer words are NOT the copy:
//      "a helper that quietly preferred the current text would put an unreviewed sentence inside the Summary".
//      THE FIXTURE MIRRORS THE REAL BOOK: premise r7-clean/current-r9 and ending r10-clean/current-r13,
//      `chosen: null`, `complete: true` — there, 3 602 chars reviewed vs 3 658 live, and the byte-equal match is
//      what the recovered book's own probe printed (`Temp/c3/out-ac1.txt`).
//
//   2. `chosen` with the selection no longer complete — the ordinary state AFTER a D-68 choose: the installed rows
//      are deliberately not clean-stamped (`specifications.md:1850`), so `cleanSelectionOf` reads partial while the
//      rail keeps printing `chosen.overview` "after the live pipeline moves on" (`phrase/reviewed.ts:484-486`).
//      Until this wave, `compiledSummaryOf` fell through to the composed Overview in exactly that window, so the
//      first Writer install after the choose put text the Author never accepted into Phrase ②'s Seed — silently,
//      with the rail still showing the chosen text. `projections.ts:compiledSummaryOf`'s second arm now takes the
//      re-validated choice, and the last test in this file is the regression: choose, install, accept, and the
//      copied Seed is still the chosen Overview.
//
// THE FIXTURE is `lock-accept-routes.test.ts`'s: the shipped wiring with the loop's doubles and the sweep off, a
// real Story from the create route, and phase ①'s two criteria removed by the Author's own goal patch so the
// lock's Goal gate (U-16) opens. The group rows are written by the real install + the real Clean stamp, exactly as
// `phrase-routes.test.ts`'s reviewed book does it.
import { describe, expect, it } from 'vitest';
import { CriteriaEngine } from '../criteria/engine';
import { DigestBuilder } from '../digest/digest';
import { MockChatClient, msg } from '../llm/mock';
import { LoopEngine } from '../loop/engine';
import { RunExecutor } from '../run/executor';
import { MockToolRuntime } from '../run/mock';
import { Store } from '../store/store';
import { buildStorylineRuntime } from './server';
import { groupCheckSeatKey } from '../phrase/exclusion';
import { groupRevisionVector, groupVectorHash, installGroupRevisions } from '../phrase/revisions';
import { stampCleanRevisions } from '../phrase/reviewed';
import { compiledSummaryOf, phraseView } from './projections';
import { PHRASE_PLOTLINES_KEY, PHRASE_SUMMARY_KEY } from '../../shared/phrase';
import { AUTHOR_ATTR } from '../run/mock';
import type { Hono } from 'hono';
import type { PhraseView } from './projections';
import type { LoopEngineConfig } from '../loop/types';

interface World {
    app: Hono;
    store: Store;
}

/** The shipped wiring with the loop's two doubles and the sweep timer off. */
function makeWorld(): World {
    const store = Store.empty();
    const criteria = new CriteriaEngine();
    const digest = new DigestBuilder();
    const chat = new MockChatClient(() => ({ message: msg({ content: 'nothing to report' }) }));
    const runtime = new MockToolRuntime(store, '', {});
    const executor = new RunExecutor({ store, runtime, chat, defaultModel: 'mock-gpt' });
    const engineConfig: LoopEngineConfig = { autoSweep: false };
    const engine = new LoopEngine({ store, executor, criteria, digest, config: engineConfig });
    const built = buildStorylineRuntime({ store, chat, runtime, executor, engine, engineConfig, streamDebounceMs: 5 });

    return { app: built.app, store };
}

interface Reply {
    status: number;
    body: unknown;
}

const call = async (app: Hono, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<Reply> => {
    const response = await app.request(`http://localhost/v1/storyline${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    });

    const text = await response.text();

    return { status: response.status, body: text.length === 0 ? undefined : JSON.parse(text) };
};

const viewOf = (reply: Reply): Record<string, any> => reply.body as Record<string, any>;

/**
 * THE SUMMARY THE AUTHOR IS SHOWN — the rule of `story-contract.ts:2205-2211`, restated on the wire's own
 * fields: `chosen.overview` in `chosen`, `reviewed.overview` in `ready`, and no Summary text at all in
 * `pending`. Every equality in this file is against THIS string, because "the text the Author accepted" is a
 * fact about the rail, not about a row.
 */
function displayed(view: PhraseView): string {
    if (view.reviewed.state === 'chosen') return view.reviewed.chosen?.overview ?? '';

    return view.reviewed.state === 'ready' ? view.reviewed.overview : '';
}

/** A Story on both dials (R5/R11) with phase ①'s Goal gate opened by the Author's own goal patch. */
async function makeBook(extra: Record<string, unknown> = {}): Promise<World> {
    const world = makeWorld();

    const created = await call(world.app, 'POST', '/stories', {
        title: 'The Salt Cartographer',
        idea: 'A mapmaker finds her own coastline redrawn on a chart she surveyed herself.',
        chapter_count: 2,
        ...extra
    });

    expect(created.status).toBe(200);

    const goal = await call(world.app, 'PATCH', '/stories/story_0/goal', {
        criteria: [
            { op: 'remove', id: 'C-14' },
            { op: 'remove', id: 'C-15' }
        ]
    });

    expect(goal.status).toBe(200);

    return world;
}

/** One batch across all five groups, through the real install (R2: one row per group, one phrase revision). */
function writeAll(world: World, text: (key: string) => string, workItemRef: string) {
    return installGroupRevisions(
        world.store,
        world.store.stories.require('story_0'),
        world.store.phraseGroups
            .list()
            .filter((group) => group.story_id === 'story_0')
            .map((group) => ({ group, content: text(group.key) })),
        AUTHOR_ATTR,
        { runRef: null, workItemRef }
    );
}

/**
 * The recovered book's shape at wire scale: five CLEAN texts, then five NEWER texts carrying no verdict, so the
 * reviewed selection stands one revision behind every group — `complete: true`, `chosen: null`, and
 * `reviewed.overview !== overview`, exactly the 3 602-vs-3 658 pair the live book measured.
 */
function seedCleanThenNewer(world: World) {
    writeAll(world, (key) => `${key} is the clean text a cross-group pass passed.`, 'wi_reviewed_pass_1');

    stampCleanRevisions(
        world.store,
        world.store.stories.require('story_0'),
        {
            seatKey: groupCheckSeatKey(groupVectorHash(groupRevisionVector(world.store, 'story_0')), 1),
            runRef: 'run_check_1'
        },
        AUTHOR_ATTR
    );

    writeAll(world, (key) => `${key} is the newest text, with no verdict on it.`, 'wi_unreviewed_pass_2');
}

/** The five CLEAN sections, composed the way `shared/phrase.ts:composePhraseContent` composes them. */
const CLEAN_OVERVIEW = [
    '## Premise\npremise is the clean text a cross-group pass passed.',
    '## Promise\npromise is the clean text a cross-group pass passed.',
    '## Theme\ntheme is the clean text a cross-group pass passed.',
    '## Tone\ntone is the clean text a cross-group pass passed.',
    '## Ending\nending is the clean text a cross-group pass passed.'
].join('\n\n');

/** The Phrase ② row, read off the store — the row the accept's second commit writes. */
const plotlinesOf = (store: Store) => store.phrases.list().find((phrase) => phrase.key === PHRASE_PLOTLINES_KEY);

/** The Summary read, through the same projection the rail calls. */
const summaryRead = (world: World): PhraseView =>
    phraseView(world.store, world.store.stories.require('story_0'));

describe('R6 — Accept final Summary: Phrase ②’s Seed is the Summary the rail shows', () => {
    it('copies the reviewed Overview the rail prints, not the newer live Overview the group rows hold', async () => {
        const world = await makeBook();

        seedCleanThenNewer(world);

        const before = summaryRead(world);

        // THE FIXTURE PINS THE BOOK THE REPORT CAME FROM: a complete selection one revision behind on every
        // group, no choice recorded, and the rail's two Overview fields disagreeing.
        expect({
            state: before.reviewed.state,
            complete: before.reviewed.complete,
            chosen: before.reviewed.chosen,
            stale: before.reviewed.stale,
            superseded: before.reviewed.groups.map((group) => group.superseded)
        }).toEqual({
            state: 'ready',
            complete: true,
            chosen: null,
            stale: false,
            superseded: [true, true, true, true, true]
        });
        expect(before.reviewed.overview).toBe(CLEAN_OVERVIEW);
        expect(before.overview).not.toBe(CLEAN_OVERVIEW);
        expect(before.overview).toContain('premise is the newest text, with no verdict on it.');

        // THE SERVER-SIDE HALF OF THE SAME PROMISE: `compiledSummaryOf` is the only text the Accept and the
        // handoff card copy (D-78 §6.3a, §18.4), so it equals the displayed Summary byte for byte.
        const story = world.store.stories.require('story_0');

        expect(compiledSummaryOf(world.store, story)).toBe(displayed(before));

        const lock = await call(world.app, 'POST', '/stories/story_0/lock');

        expect(lock.status).toBe(200);
        expect(receiptOf(lock)).toMatchObject({ phase: 'summary', phrase_started: true, phrase_start_reason: '' });

        const phrase = plotlinesOf(world.store)!;

        // AC2 — THE REGRESSION THAT MATTERS: the copied Seed is the Overview the Author accepted, exactly, and
        // not the words the group rows happen to hold now. Both directions are asserted because the old
        // behaviour passed any test that only checked "a phrase row appeared with some text in it".
        expect(phrase.seed).toBe(CLEAN_OVERVIEW);
        expect(phrase.seed).toBe(displayed(before));
        expect(phrase.seed).not.toBe(before.overview);
        expect(phrase.seed).not.toContain('no verdict on it');

        // And the rail's Phrase ② preview is the head of THAT text — so the pane cannot show a copy shorter
        // than the Summary it came from (D-76 keeps it a 400-character window; R6 keeps the window honest).
        const started = viewOf(await call(world.app, 'GET', `/stories/story_0/phrases/${PHRASE_PLOTLINES_KEY}`));

        expect({ seed_head: started.seed_head, seed_chars: started.seed_chars }).toEqual({
            seed_head: CLEAN_OVERVIEW.slice(0, 400),
            seed_chars: CLEAN_OVERVIEW.length
        });
    });

    it('after a choose and a later install, still copies the CHOSEN Overview the rail keeps showing', async () => {
        const world = await makeBook();

        seedCleanThenNewer(world);

        const chosen = await call(world.app, 'POST', '/stories/story_0/phrases/reviewed/choose', {
            note: 'the reviewed Ending is the one I meant'
        });

        expect(chosen.status).toBe(200);

        // The install moved the book onto the reviewed words, so right now every arm agrees. The gap opens with
        // the next install, which is what the rest of this test does.
        expect(displayed(summaryRead(world))).toBe(CLEAN_OVERVIEW);

        // A Writer rewrites ONE group afterwards. The choose stamped no new Clean rows, so the selection stays
        // partial and the rail's state is `chosen` — it keeps printing `chosen.overview` (D-68,
        // `phrase/reviewed.ts:484-486`), while the composed Overview has moved.
        const endingId = world.store.phraseGroups.list().find((group) => group.key === 'ending')!.id;
        const revised = await call(world.app, 'POST', `/stories/story_0/phrases/groups/${endingId}/revise`, {
            content: 'ending was rewritten after the choose, and nobody has read it.'
        });

        expect(revised.status).toBe(200);

        const after = viewOf(revised).view as PhraseView;

        expect({
            state: after.reviewed.state,
            complete: after.reviewed.complete,
            chosen_overview: after.reviewed.chosen?.overview
        }).toEqual({ state: 'chosen', complete: false, chosen_overview: CLEAN_OVERVIEW });
        expect(after.overview).toContain('rewritten after the choose');
        expect(displayed(after)).toBe(CLEAN_OVERVIEW);

        const lock = await call(world.app, 'POST', '/stories/story_0/lock');

        expect(lock.status).toBe(200);
        expect(receiptOf(lock)).toMatchObject({ phrase_started: true });

        const phrase = plotlinesOf(world.store)!;

        // THE SILENT DIVERGENCE R6 CALLS A DEFECT: before the chosen arm, this Seed was `after.overview` — the
        // moved text the rail was NOT showing. It is the chosen text now, and the live text is still named so a
        // reader cannot mistake this for a truncation.
        expect(phrase.seed).toBe(displayed(after));
        expect(phrase.seed).toBe(CLEAN_OVERVIEW);
        expect(phrase.seed).not.toBe(after.overview);
        expect(phrase.seed).not.toContain('rewritten after the choose');
    });

    it('copies a real-size Overview whole, and the preview stays a 400-character window (AC1 + AC4)', async () => {
        // The recovered book's SCALE, not just its shape: five clean sections of ~200 characters each, so the
        // composed Overview is longer than `SEED_HEAD_CHARS` and the accept's copy is provably WHOLE while the
        // rail's preview is provably a window. That pair is the user's report — a complete copy that reads as a
        // truncated one — pinned on both sides of the wire at once.
        const world = await makeBook();
        const long = (key: string) => `${key} is the clean section text, and it runs to roughly two hundred characters so the composed Overview is longer than the desk's seed window on purpose, which is the size the report came in at.`;

        writeAll(world, long, 'wi_reviewed_pass_1');

        stampCleanRevisions(
            world.store,
            world.store.stories.require('story_0'),
            {
                seatKey: groupCheckSeatKey(groupVectorHash(groupRevisionVector(world.store, 'story_0')), 1),
                runRef: 'run_check_1'
            },
            AUTHOR_ATTR
        );

        const before = summaryRead(world);
        const expected = [
            '## Premise',
            '## Promise',
            '## Theme',
            '## Tone',
            '## Ending'
        ].map((title) => `${title}\n${long(title.slice(3).toLowerCase())}`).join('\n\n');

        expect(before.reviewed.state).toBe('ready');
        expect(before.reviewed.overview).toBe(expected);
        expect(expected.length).toBeGreaterThan(400);

        const lock = await call(world.app, 'POST', '/stories/story_0/lock');

        expect(lock.status).toBe(200);
        expect(receiptOf(lock)).toMatchObject({ phrase_started: true });

        const phrase = plotlinesOf(world.store)!;

        expect(phrase.seed).toBe(expected);
        expect(phrase.seed).toBe(displayed(before));

        const started = viewOf(await call(world.app, 'GET', `/stories/story_0/phrases/${PHRASE_PLOTLINES_KEY}`));

        // AC4, server side: `seed_head`/`seed_chars` keep their pinned contract — a whole-character 400-char
        // prefix plus the TRUE length — so nothing that reads them today reads a bigger or smaller window.
        expect({ seed_head: started.seed_head, seed_chars: started.seed_chars }).toEqual({
            seed_head: expected.slice(0, 400),
            seed_chars: expected.length
        });
        expect(started.seed_head.length).toBe(400);
        expect(started.seed_chars).toBe(expected.length);
    });

    it('reports the one state where the rail shows no Summary: the copy takes the composed Overview (pending)', async () => {
        const world = await makeBook();

        // Five groups written, never a clean pass: `pending` — the rail prints gap rows and NO Summary text
        // (`reviewedSummaryText` answers `''`), so the desk's own gate keeps the Accept out of this state
        // (`story-contract.ts:cleanSummaryGateReason`, U-19). The route has always taken this lock anyway, and
        // the text it hands on is the composed Overview — the residual difference R6 allows, now named.
        writeAll(world, (key) => `${key} is written, and no pass has passed it.`, 'wi_draft_groups_1');

        const before = summaryRead(world);

        expect({ state: before.reviewed.state, complete: before.reviewed.complete, chosen: before.reviewed.chosen }).toEqual(
            { state: 'pending', complete: false, chosen: null }
        );
        expect(displayed(before)).toBe('');

        expect(compiledSummaryOf(world.store, world.store.stories.require('story_0'))).toBe(before.overview);

        const lock = await call(world.app, 'POST', '/stories/story_0/lock');

        expect(lock.status).toBe(200);
        expect(receiptOf(lock)).toMatchObject({ phrase_started: true });

        const phrase = plotlinesOf(world.store)!;
        // The row's own `seed` is optional on the type (a Phrase ① row never had one), so the read that asserts
        // the copy states it is present rather than letting the assertion vanish into `undefined`.
        const seed = phrase.seed ?? '';

        // The copy is the live Overview, and it is whole — five sections, in catalog order.
        expect(seed.split('\n\n## ').length).toBe(5);
        expect(seed).toBe(before.overview);
        expect(seed.startsWith('## Premise\n')).toBe(true);
    });
});

describe('R6 — a book with no reviewed Selection to reconcile is untouched (legacy dials)', () => {
    it('leaves a `' + 'sampling' + '` Summary exactly as it was: no groups, no Phrase ②, the same refusal', async () => {
        // R6's absent-flags rule: `summary_mode` absent means `'sampling'` and `plotlines_mode` absent means
        // `'classic'`; this book asks for `'sampling'` explicitly while keeping the `'groups'` lane, which is
        // the combination D-77 records — NO Summary phrase row at all, so there is nothing to reconcile and
        // every arm of `compiledSummaryOf` answers `''`.
        const world = await makeBook({ summary_mode: 'sampling' });

        const before = viewOf(await call(world.app, 'GET', '/stories/story_0/phrases'));

        expect({ mode: before.mode, phrase_id: before.phrase_id, reviewed_state: before.reviewed?.state }).toEqual({
            mode: 'sampling',
            phrase_id: null,
            reviewed_state: 'pending'
        });
        expect(compiledSummaryOf(world.store, world.store.stories.require('story_0'))).toBe('');

        const lock = await call(world.app, 'POST', '/stories/story_0/lock');

        expect(lock.status).toBe(200);
        expect(summaryLocked(lock)).toBe(true);
        // The refusal is a 200 with the reason, never a 409 over a lock that committed (§6.3a).
        expect(receiptOf(lock).phrase_started).toBe(false);
        expect(String(receiptOf(lock).phrase_start_reason)).toContain('no compiled Summary to start the plotlines Phrase from');
        expect(plotlinesOf(world.store)).toBeUndefined();
    });

    it('leaves a `' + 'classic' + '` Plotlines lane untouched: the lock commits and starts nothing', async () => {
        const world = await makeBook({ plotlines_mode: 'classic' });

        writeAll(world, (key) => `${key} text.`, 'wi_draft_groups_1');

        const lock = await call(world.app, 'POST', '/stories/story_0/lock');

        expect(lock.status).toBe(200);
        expect(summaryLocked(lock)).toBe(true);
        expect(receiptOf(lock).phrase_started).toBe(false);
        expect(String(receiptOf(lock).phrase_start_reason)).toContain("classic plotline tools");
        expect(plotlinesOf(world.store)).toBeUndefined();
    });
});

/** The accept's accounting, as the response carries it. */
function receiptOf(reply: Reply): Record<string, unknown> {
    return viewOf(reply).lock_receipt as Record<string, unknown>;
}

/** The flag the first commit wrote — the lock is what committed, whatever the second commit did. */
function summaryLocked(reply: Reply): unknown {
    return viewOf(reply).summary_locked;
}
