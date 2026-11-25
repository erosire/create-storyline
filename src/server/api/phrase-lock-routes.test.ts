// GROUP LOCK (R1/R2/R3) — the Author's two route verbs, the Editor-locking Setting, and the lock's
// projection, pinned at the HTTP surface.
//
// WHY THIS FILE RATHER THAN `phrase/locks.test.ts`: the domain file proves the RULES (who may act, what is
// written, what is voided). This file proves the four things only the route layer owns:
//
//   1. ADDRESSING and STATUS — an unknown Story or group answers 404 BEFORE any verb (the revise route's
//      rule, L-13: a typo must not come back as a refusal about real content), a `sampling` book answers
//      409 naming the door it wants instead, and every domain refusal is a 409 whose body is the domain's
//      own sentence VERBATIM (`refusal()` passes `error.message` through, so route copy and the domain's
//      audit line cannot drift apart);
//   2. THE ENVELOPE — `{story_id, phrase_id, group_id, locked, locked_revision, locked_by, locked_at,
//      view}`, the revise route's convention (R2/D-68), carrying the FRESH phrase read so the rail's badge
//      moves with the write rather than with a later poll. "Fresh" is proved by asserting `view` against a
//      subsequent GET, not by asserting a hand-written copy of the projection;
//   3. NO FALSE SUCCESS — every refusal leaves the group rows, the findings, the revision rows and the
//      journal exactly as they were (the snapshot is ONE exact `toEqual`, not four guards);
//   4. THE LIVE-WRITER REFUSAL (R4) — a lock fixes the revision that STANDS, so a `draft_groups` pass in
//      flight is refused by run id, on the same read the rail disables its button off
//      (`projections.ts:writer_busy`).
//
// THE LOCK FIELDS ON THE WIRE (R1): a locked group row carries `locked` / `locked_revision` / `locked_by` /
// `locked_at`; an UNLOCKED row carries NONE of those keys — not `false`, not `null`. Absence is the meaning
// the client declares (`dashboard/api.ts:PhraseGroupRow.locked`: "ABSENT MEANS UNLOCKED"), and the stored
// row after an unlock holds three `null`s a wire would have to mis-state to emit.
//
// THE IDS: a route-created Story mints its phrase rows with `newRecordUid`, so group ids come out of the
// store; the counter-minted rows (`summary_0`, `finding_0`, `run_0`) are pinned literally. The journal reads
// use `slice(-1)[0]` rather than `.at(-1)` (the package's tsconfig lib predates ES2022).
import { describe, expect, it } from 'vitest';
import { CriteriaEngine } from '../criteria/engine';
import { DigestBuilder } from '../digest/digest';
import { MockChatClient, msg } from '../llm/mock';
import { LoopEngine } from '../loop/engine';
import { RunExecutor } from '../run/executor';
import { MockToolRuntime } from '../run/mock';
import { Store } from '../store/store';
import { buildStorylineRuntime } from './server';
import type { Hono } from 'hono';
import type { Cost, PhraseGroup, Story } from '../../shared/types';
import type { StoryRow } from '../../dashboard/api';

interface TestApp {
    app: Hono;
    store: Store;
}

/** The shipped wiring with the loop's two doubles and the sweep timer off (as in `phrase-routes.test.ts`). */
function makeApp(): TestApp {
    const store = Store.empty();
    const criteria = new CriteriaEngine();
    const digest = new DigestBuilder();
    const chat = new MockChatClient(() => ({ message: msg({ content: 'nothing to report' }) }));
    const runtime = new MockToolRuntime(store, '', {});
    const executor = new RunExecutor({ store, runtime, chat, defaultModel: 'mock-gpt' });
    const engineConfig = { autoSweep: false };
    const engine = new LoopEngine({ store, executor, criteria, digest, config: engineConfig });
    const built = buildStorylineRuntime({ store, chat, runtime, executor, engine, engineConfig, streamDebounceMs: 5 });

    return { app: built.app, store };
}

interface Reply {
    status: number;
    body: unknown;
}

const call = async (
    app: Hono,
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown
): Promise<Reply> => {
    const response = await app.request(`http://localhost/v1/storyline${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    });

    const text = await response.text();

    return { status: response.status, body: text.length === 0 ? undefined : JSON.parse(text) };
};

const errorOf = (reply: Reply): string => (reply.body as { error: string }).error;

/**
 * The phrase read inside a reply: a GET sends it as the body, the lock/unlock routes send it as `view`
 * (the revise route's convention), and the assertions below want ONE accessor for both.
 */
const viewOf = (reply: Reply): Record<string, unknown> =>
    ((reply.body as { view?: Record<string, unknown> }).view ?? reply.body) as Record<string, unknown>;

/** One projected group row out of either reply shape, addressed by catalog key. */
const groupRow = (reply: Reply, key: string): Record<string, unknown> =>
    ((viewOf(reply).groups as Array<Record<string, unknown>>).find((row) => row.key === key))!;

/** The ten columns every group row sends, with the four lock keys appended only for a locked group. */
const BASE_ROW_KEYS = [
    'id',
    'key',
    'title',
    'description',
    'order',
    'content',
    'revision',
    'updated_by',
    'previous_content',
    'history',
    'owed_by_findings',
    'writer_busy',
    'scores'
];

/** A Story on the new pipeline; `sampling` is the legacy book the lock routes must refuse outright. */
async function seedStory(summaryMode?: 'groups' | 'sampling'): Promise<TestApp & { story: Story }> {
    const world = makeApp();
    const reply = await call(world.app, 'POST', '/stories', {
        title: 'The Return',
        idea: 'A cartographer finds the valley she mapped is under water.',
        chapter_count: 2,
        ...(summaryMode === undefined ? {} : { summary_mode: summaryMode })
    });

    return { ...world, story: world.store.stories.require((reply.body as StoryRow).id) };
}

/** The legacy prose §4.2 carries, so an import gives every group a WRITTEN revision 1 to lock. */
function writeLegacyProse(store: Store) {
    const summary = store.summaries.require('summary_0');

    store.summaries.update(
        summary.id,
        {
            premise: 'A return to a mapped valley that no longer matches the map.',
            promise: 'The map and the territory reconcile in the last chapter.',
            theme: 'Memory against measurement.',
            tone: 'Plain, cold, precise.',
            ending: 'She floods the valley on purpose.'
        },
        { run_ref: null, author: true, why: 'seed: the legacy prose an import reads (R6)' },
        [{ id: summary.id, rev: summary.rev }]
    );
}

/**
 * A group-managed book with all five groups WRITTEN at revision 1 — the only state a lock is allowed on.
 * The import route is used rather than a hand install because it is the Author's own door (R6).
 */
async function writtenBook(): Promise<TestApp & { story: Story; ids: Record<string, string> }> {
    const world = await seedStory();

    writeLegacyProse(world.store);
    await call(world.app, 'POST', '/stories/story_0/phrases/import');

    return {
        ...world,
        ids: Object.fromEntries(world.store.phraseGroups.list().map((group) => [group.key, group.id]))
    };
}

/** The group row as stored — the book's truth, asserted next to the wire so the two cannot disagree. */
const storedGroup = (store: Store, key: string): PhraseGroup =>
    store.phraseGroups.list().find((row) => row.key === key)!;

/** The rows and the journal a refusal must leave EXACTLY where it found them — one exact snapshot. */
const bookState = (store: Store) => ({
    groups: store.phraseGroups.list().map((row) => ({ ...row })),
    findings: store.findings.list().map((row) => ({ ...row })),
    groupRevisions: store.groupRevisions.list().map((row) => ({ ...row })),
    phrases: store.phrases.list().map((row) => ({ ...row })),
    journal: store.journal.length
});

/** A Writer pass IN FLIGHT over `groupRefs` — the state R4's exclusion reads (a live, group-holding run). */
function seedLiveWriter(store: Store, groupRefs: string[]) {
    return store.runs.create(
        {
            story_id: 'story_0',
            work_item_ref: 'wi_draft_groups_summary_0_ffffffffffffffff_9',
            role: 'writer',
            state: 'working',
            started_at: '2026-11-25T10:00:00.000Z',
            tokens: 0,
            kind: 'work',
            delegated: [],
            group_refs: groupRefs
        },
        { run_ref: null, author: false, why: 'seed: a live group Writer run (R4)' }
    );
}

/** An open finding scoped to `groupRefs` — the row a lock either voids or narrows. */
function seedFinding(store: Store, groupRefs: string[], fingerprint = 'C-14|summary_0') {
    return store.findings.create(
        {
            story_id: 'story_0',
            target_ref: 'summary_0',
            criterion_ref: 'C-14',
            title: 'the Overview promises a cartographer the Seed destroyed',
            detail: 'the promise paragraph keeps the cartographer',
            evidence: 'summary_0 promise: "the cartographer returns"',
            cost: 'major' as Cost,
            fingerprint,
            state: 'approved',
            seen_count: 1,
            group_refs: groupRefs
        },
        { run_ref: null, author: true, why: 'seed: a finding the lock rules on (R1)' }
    );
}

/** The last journal line for one collection — the audit trail the Author reads a week later. */
const lastWhy = (store: Store, collection: string): string | undefined =>
    store.journal.filter((event) => event.collection === collection).slice(-1)[0]?.attribution.why;

describe('POST /stories/:id/phrases/groups/:groupId/lock (R1)', () => {
    it('locks the written group, answers the verdict with the fresh view, and projects the four fields', async () => {
        const world = await writtenBook();
        const phraseId = world.store.phrases.list()[0].id;
        const reply = await call(world.app, 'POST', `/stories/story_0/phrases/groups/${world.ids.tone}/lock`);

        expect(reply.status).toBe(200);

        // `locked_at` is the commit's own clock (`nowIso()`), so it is read out and matched against the
        // projected and stored rows rather than guessed at; every other key of the envelope is a known value.
        const { locked_at: lockedAt, ...envelope } = reply.body as Record<string, unknown>;

        expect(envelope).toEqual({
            story_id: 'story_0',
            phrase_id: phraseId,
            group_id: world.ids.tone,
            locked: true,
            locked_revision: 1,
            locked_by: 'author',
            // Nothing was in flight and no claim named only this group, so the lock voided nothing.
            voided_findings: [],
            view: (await call(world.app, 'GET', '/stories/story_0/phrases')).body
        });
        expect(typeof lockedAt).toBe('string');
        // THE CLOCK'S SHAPE (T9, finding 5): the stamp is `nowIso()` — `new Date().toISOString()` — so the
        // value the route returns, the row stores, and the contract documents with `format: date-time` are
        // UTC with millisecond precision and a `Z`, never a local offset like `+01:00`. Pinned as a shape
        // rather than a literal instant because the commit owns the clock.
        expect(String(lockedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

        // THE WIRE ROW: exactly the four lock keys on top of the thirteen every row sends, and no `revision`
        // move — a lock is a flag on the row that already carries the text, never an edit dressed up as one.
        expect(Object.keys(groupRow(reply, 'tone')).sort()).toEqual(
            [...BASE_ROW_KEYS, 'locked', 'locked_at', 'locked_by', 'locked_revision'].sort()
        );
        expect(groupRow(reply, 'tone')).toMatchObject({
            locked: true,
            locked_revision: 1,
            locked_by: 'author',
            locked_at: lockedAt,
            revision: 1,
            content: 'Plain, cold, precise.'
        });

        // The four SIBLING groups send none of those keys — not `false`, not `null`: absence is the reading
        // the client declares, and it is what keeps a pre-lock payload rendering its old pane.
        const view = await call(world.app, 'GET', '/stories/story_0/phrases');

        for (const key of ['premise', 'promise', 'theme', 'ending']) {
            expect(Object.keys(groupRow(view, key))).toEqual(BASE_ROW_KEYS);
        }

        // The row and the audit agree: the lock is the store's write, and the journal names the route that
        // asked for it (P11 — the store refuses an unattributed write, and this is the line the Author reads).
        expect(storedGroup(world.store, 'tone')).toMatchObject({
            locked: true,
            locked_revision: 1,
            locked_by: 'author',
            locked_at: lockedAt,
            revision: 1,
            content: 'Plain, cold, precise.'
        });
        expect(lastWhy(world.store, 'phrase_groups')).toBe(
            'the Author used POST /stories/:id/phrases/groups/:groupId/lock on story_0 — tone revision 1 was locked in as settled content (R1) (§10 dashboard write)'
        );
    });

    it('voids a claim whose whole scope is now locked, and reports the audit it changed', async () => {
        const world = await writtenBook();
        const finding = seedFinding(world.store, [world.ids.tone]);

        const reply = await call(world.app, 'POST', `/stories/story_0/phrases/groups/${world.ids.tone}/lock`);

        expect(reply.status).toBe(200);
        expect((reply.body as { voided_findings: unknown[] }).voided_findings).toEqual([
            { finding_id: finding.id, previous_state: 'approved', scope: [world.ids.tone] }
        ]);
        // `discarded`, the established void state — not `fixed`, which would claim a revision answered it.
        expect(world.store.findings.require(finding.id).state).toBe('discarded');
        expect(world.store.findings.require(finding.id).rev).toBe(finding.rev + 1);
    });

    it('leaves a cross-group claim open, owing work to the group that can still move', async () => {
        const world = await writtenBook();
        const finding = seedFinding(world.store, [world.ids.tone, world.ids.promise]);

        const reply = await call(world.app, 'POST', `/stories/story_0/phrases/groups/${world.ids.tone}/lock`);

        expect((reply.body as { voided_findings: unknown[] }).voided_findings).toEqual([]);
        expect(world.store.findings.require(finding.id).state).toBe('approved');

        // R1's other half, on the read the rail draws: the claim still NAMES the locked group (the defect
        // really is about it), but `missing`/`owed_by_findings` — the debt a Writer can pay — no longer
        // include it. `targeted` keeps both, in the catalog order the projection always uses.
        const view = await call(world.app, 'GET', '/stories/story_0/phrases');
        const ids = world.ids;

        expect(viewOf(view).findings).toEqual([
            {
                id: finding.id,
                title: finding.title,
                cost: 'major',
                kind: 'issue',
                state: 'approved',
                seen_count: 1,
                // `group_refs` echoes the RECORD in the order it was written; `targeted`/`missing` are the
                // projection's, always in the CATALOG's order — two different facts, and the rail reads both.
                group_refs: [ids.tone, ids.promise],
                unscoped: false,
                targeted: [ids.promise, ids.tone],
                resolved: [],
                // The locked side is skipped, not counted: a claim that held the pipeline open over text the
                // Author signed off is the state a lock exists to end.
                missing: [ids.promise],
                resolved_all: false
            }
        ]);
        expect(groupRow(view, 'tone').owed_by_findings).toEqual([]);
        expect(groupRow(view, 'promise').owed_by_findings).toEqual([finding.id]);
    });

    it('409s a group nobody has written, and writes nothing', async () => {
        const world = await seedStory();
        const before = bookState(world.store);

        const unwrittenId = world.store.phraseGroups.list().find((group) => group.key === 'premise')!.id;
        const reply = await call(world.app, 'POST', `/stories/story_0/phrases/groups/${unwrittenId}/lock`);

        expect(reply.status).toBe(409);
        // The domain's sentence, verbatim: the route formats nothing, so a rail and a crew read one sentence
        // (L-13), and the sentence is the Author's next action — write the group, then lock that text.
        expect(errorOf(reply)).toBe(
            'lockPhraseGroup: premise has no written text (revision 0), so there is no revision for a lock to fix — the loop writes it, or the Author edits it, and then the lock lands on that text'
        );
        expect(bookState(world.store)).toEqual(before);
    });

    it('409s a second lock instead of re-dating the decision the book already carries', async () => {
        const world = await writtenBook();

        await call(world.app, 'POST', `/stories/story_0/phrases/groups/${world.ids.tone}/lock`);

        const events = world.store.journal.length;
        const before = bookState(world.store);
        const reply = await call(world.app, 'POST', `/stories/story_0/phrases/groups/${world.ids.tone}/lock`);

        expect(reply.status).toBe(409);
        expect(errorOf(reply)).toBe(
            'lockPhraseGroup: tone is already locked at revision 1 by author — the Author unlocks it first, and a second lock would only re-date a decision the book already carries'
        );
        expect(bookState(world.store)).toEqual(before);
        expect(world.store.journal.length).toBe(events);
    });

    it('409s while a Writer holds the group, naming the run that holds it', async () => {
        const world = await writtenBook();
        const run = seedLiveWriter(world.store, [world.ids.tone]);
        const before = bookState(world.store);

        const reply = await call(world.app, 'POST', `/stories/story_0/phrases/groups/${world.ids.tone}/lock`);

        expect(reply.status).toBe(409);
        // The run id travels because the Author's next action is "wait for THAT pass", and a free group in
        // the same book still locks — the refusal is per group, exactly like the rail's disabled button.
        expect(errorOf(reply)).toBe(
            `the Writer is rewriting tone right now (${run.id}), so a lock would fix text that has not finished moving — the same lock lands once that run closes (R1, R4).`
        );
        expect(bookState(world.store)).toEqual(before);

        const free = await call(world.app, 'POST', `/stories/story_0/phrases/groups/${world.ids.ending}/lock`);

        expect(free.status).toBe(200);
    });

    it('404s a group this book never minted, before any write', async () => {
        const world = await writtenBook();
        const before = bookState(world.store);

        const reply = await call(world.app, 'POST', '/stories/story_0/phrases/groups/grp-tone/lock');

        expect(reply.status).toBe(404);
        expect(errorOf(reply)).toBe('no phrase group named grp-tone is in the book (P1: the store is the memory)');
        expect(bookState(world.store)).toEqual(before);
    });

    it('404s an unknown Story and 409s a book with no group catalog', async () => {
        const world = await writtenBook();

        expect((await call(world.app, 'POST', '/stories/story_9/phrases/groups/grp-tone/lock')).status).toBe(404);

        const legacy = await seedStory('sampling');
        const reply = await call(legacy.app, 'POST', '/stories/story_0/phrases/groups/grp-tone/lock');

        expect(reply.status).toBe(409);
        expect(errorOf(reply)).toBe(
            "this Story's Summary is still written as one text (no group catalog); POST /stories/story_0/phrases/import turns the flat Summary into groups first (R1, R6)."
        );
    });
});

describe('POST /stories/:id/phrases/groups/:groupId/unlock (R1)', () => {
    it('opens the group, nulls the three metadata fields, and drops all four from the wire', async () => {
        const world = await writtenBook();

        await call(world.app, 'POST', `/stories/story_0/phrases/groups/${world.ids.tone}/lock`);

        const reply = await call(world.app, 'POST', `/stories/story_0/phrases/groups/${world.ids.tone}/unlock`);

        expect(reply.status).toBe(200);

        // `null`, not absent, on the VERDICT: the route is stating the state it left the group in, and the
        // row itself carries nulls for exactly that reason. The `view` says it the client's way — absence.
        const envelope = reply.body as Record<string, unknown>;

        expect({ ...envelope, view: undefined }).toEqual({
            story_id: 'story_0',
            phrase_id: world.store.phrases.list()[0].id,
            group_id: world.ids.tone,
            locked: false,
            locked_revision: null,
            locked_by: null,
            locked_at: null,
            view: undefined
        });
        // The revise route's convention: the refreshed read rides with the write.
        expect(envelope.view).toEqual((await call(world.app, 'GET', '/stories/story_0/phrases')).body);

        expect(storedGroup(world.store, 'tone')).toMatchObject({
            locked: false,
            locked_revision: null,
            locked_by: null,
            locked_at: null,
            revision: 1,
            content: 'Plain, cold, precise.'
        });

        const view = await call(world.app, 'GET', '/stories/story_0/phrases');

        expect(Object.keys(groupRow(view, 'tone'))).toEqual(BASE_ROW_KEYS);
        expect(lastWhy(world.store, 'phrase_groups')).toBe(
            'the Author used POST /stories/:id/phrases/groups/:groupId/unlock on story_0 — tone stopped being settled content and rejoined the loop (R1) (§10 dashboard write); tone revision 1 stopped being fixed text (group lock lifted)'
        );
    });

    it('409s a group that is not locked, and moves nothing', async () => {
        const world = await writtenBook();
        const before = bookState(world.store);

        const reply = await call(world.app, 'POST', `/stories/story_0/phrases/groups/${world.ids.tone}/unlock`);

        expect(reply.status).toBe(409);
        expect(errorOf(reply)).toBe(
            "unlockPhraseGroup: tone is not locked, so there is nothing to lift — the loop already has this group's text to work on"
        );
        expect(bookState(world.store)).toEqual(before);
    });

    it('409s an unlock under a live Writer, and 404s an unknown group', async () => {
        const world = await writtenBook();

        await call(world.app, 'POST', `/stories/story_0/phrases/groups/${world.ids.tone}/lock`);

        const run = seedLiveWriter(world.store, [world.ids.tone]);
        const before = bookState(world.store);
        const busy = await call(world.app, 'POST', `/stories/story_0/phrases/groups/${world.ids.tone}/unlock`);

        expect(busy.status).toBe(409);
        expect(errorOf(busy)).toBe(
            `the Writer is rewriting tone right now (${run.id}), so unlocking would open the group under a pass that has not installed its text — the lock comes off once that run closes (R1, R4).`
        );
        expect(bookState(world.store)).toEqual(before);
        expect(storedGroup(world.store, 'tone').locked).toBe(true);

        const miss = await call(world.app, 'POST', '/stories/story_0/phrases/groups/grp-tone/unlock');

        expect(miss.status).toBe(404);
        expect(errorOf(miss)).toBe('no phrase group named grp-tone is in the book (P1: the store is the memory)');
    });
});

describe('PATCH /stories/:id — the Editor-locking Setting is the Author’s switch (R2)', () => {
    it('writes true, writes false, and leaves the row alone when the key is absent', async () => {
        const world = await writtenBook();

        expect((await call(world.app, 'PATCH', '/stories/story_0', { editor_group_locking: true })).status).toBe(200);
        expect(world.store.stories.require('story_0').editor_group_locking).toBe(true);
        expect(lastWhy(world.store, 'stories')).toBe(
            'the Author used PATCH /stories/:id on story_0 — the Editor may lock a phrase group (R1) (§10 dashboard write)'
        );

        await call(world.app, 'PATCH', '/stories/story_0', { editor_group_locking: false });
        expect(world.store.stories.require('story_0').editor_group_locking).toBe(false);
        expect(lastWhy(world.store, 'stories')).toBe(
            'the Author used PATCH /stories/:id on story_0 — the Editor may not lock a phrase group (R1) (§10 dashboard write)'
        );

        // Absent leaves it alone: a body that names a DIFFERENT field cannot flip a Setting the Author set
        // weeks ago, and the route has no quiet default to fall back to.
        await call(world.app, 'PATCH', '/stories/story_0', { editor_group_locking: true });
        await call(world.app, 'PATCH', '/stories/story_0', { title: 'The Return, again' });

        expect(world.store.stories.require('story_0').title).toBe('The Return, again');
        expect(world.store.stories.require('story_0').editor_group_locking).toBe(true);
    });

    it('400s a non-boolean with its own sentence, and keeps the no-known-field refusal verbatim', async () => {
        const world = await writtenBook();
        const events = world.store.journal.length;

        for (const value of ['true', 1, null, 'false']) {
            const reply = await call(world.app, 'PATCH', '/stories/story_0', { editor_group_locking: value });

            expect(reply.status).toBe(400);
            expect(errorOf(reply)).toBe(
                '`editor_group_locking` must be a boolean: true lets the Editor lock a phrase group, false takes that power back, and omitting it leaves the Story as it is (R1).'
            );
        }

        // The Setting is on the allow-list, while the sentence for a body that names NONE of the fields stays
        // byte-identical (L-13 pins that copy; the new field has its own 400 above).
        const empty = await call(world.app, 'PATCH', '/stories/story_0', {});

        expect(empty.status).toBe(400);
        expect(errorOf(empty)).toBe(
            'PATCH /stories/:id got no field it knows: title, idea, chapter_count, auto_approve, summary_sampling, summary_critics (D-35, D-17d).'
        );
        expect(world.store.journal.length).toBe(events);
        expect(world.store.stories.require('story_0').editor_group_locking).toBeUndefined();
    });

    it('answers the Setting with the Story row the dashboard commits', async () => {
        const world = await writtenBook();
        const reply = await call(world.app, 'PATCH', '/stories/story_0', { editor_group_locking: true });

        expect((reply.body as StoryRow).id).toBe('story_0');
        expect((reply.body as StoryRow).title).toBe('The Return');
    });
});
