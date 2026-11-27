// T12 — the SERVER side of "Accept final Summary": POST /stories/:id/lock is the accept.
//
// WHAT THIS FILE PINS, and why each thing is a rule rather than an implementation detail:
//
//   1. THE LOCK'S OWN CONTRACT IS UNTOUCHED. The two refusals (the undecided Ideas tray L-7a and the phase
//      Goal U-16) and the row the success answers with are byte-stable; the accept's accounting rides in on
//      ONE new key, `lock_receipt`. `dashboard/api.ts:lockPhase` still types the response as `StoryRow`, and
//      a client that ignores the receipt sees exactly what it saw before — so the key set of the row part is
//      asserted here, not just the new key's presence.
//   2. THE LEFTOVERS ARE COUNTED, NOT GATED (R3, mirroring L-25b). Findings and tasks never blocked the
//      accept, and they still don't; what changes is that the act of completing stops them, and the count
//      rides back on the receipt because "the queue emptied itself" is otherwise a mystery to the Author.
//   3. PHRASE ② STARTS FROM THE COMPILED SUMMARY, BYTE FOR BYTE (R4). The assertion that matters is not
//      "a phrase row appeared" — it is that the row's `seed` equals the text the handoff button previews
//      (`projections.ts:compiledSummaryOf`, which the fixture pins as `## Premise\n<text>`), because D-72's
//      whole phrase-independence rule hangs on THAT string being copied.
//   4. THE AUTO-START NEVER PRETENDS TO BE THE LOCK. Every non-starting arm answers 200 with the lock
//      committed (`summary_locked: true`, `phase: 'plotlines'`) and says why Phrase ② did not move: an
//      already-started phrase (idempotence), a book with nothing compiled to copy, and a book on the classic
//      lane. A 409 there would tell the Author their accept failed when it did not.
//   5. THE SENTENCES ARE PRODUCT COPY (L-13) and are asserted verbatim, including the two verbs each
//      non-starting sentence names — a refusal the Author cannot act on is a dead end.
//   6. A `plotlines`/`chapters` lock starts nothing and reports nothing about Phrase ② — the KEY SET of its
//      receipt is asserted, because a zero in a field that leg never wrote would invent a decision.
//
// THE FIXTURE: the shipped wiring with the loop's doubles and the sweep off (as in `phrase-start-routes
// .test.ts`), so the rows are the create route's own — a real Summary Phrase with its five real groups,
// written through the real revise verb. Phase ①'s two criteria are removed by the Author's own goal patch
// so the lock's Goal gate (U-16) opens; the tray is empty because nothing proposed anything.
import { describe, expect, it } from 'vitest';
import { CriteriaEngine } from '../criteria/engine';
import { DigestBuilder } from '../digest/digest';
import { MockChatClient, msg } from '../llm/mock';
import { LoopEngine } from '../loop/engine';
import { RunExecutor } from '../run/executor';
import { MockToolRuntime } from '../run/mock';
import { Store } from '../store/store';
import { buildStorylineRuntime } from './server';
// THE COMPILED SUMMARY, the same read the handoff button previews (`projections.ts:compiledSummaryOf`). The
// accept seeds Phrase ② from it, so the test asserts the seed against THAT function, not against a copy of
// its sentence.
import { compiledSummaryOf } from './projections';
import type { Hono } from 'hono';
import type { Cost, FindingState, Story, TaskState } from '../../shared/types';
import type { LoopEngineConfig } from '../loop/types';

interface World {
    app: Hono;
    store: Store;
}

/** The shipped wiring with the loop's two doubles and the sweep timer off (as in `phrase-start-routes.test.ts`). */
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

const viewOf = (reply: Reply): Record<string, unknown> => reply.body as Record<string, unknown>;

/** The accept's accounting, as the response carries it. */
const receiptOf = (reply: Reply): Record<string, unknown> => viewOf(reply).lock_receipt as Record<string, unknown>;

/** The LAST journal line a commit label wrote — the audit every phrase verb is pinned against. */
const journalWhy = (store: Store, label: string): string =>
    (store.journal.filter((event) => event.commit_label === label).slice(-1)[0].attribution as { why: string }).why;

/**
 * R12 — EVERY journal line a commit label wrote, in order.
 *
 * The Start commit now writes TWO rows-in-one-group: the phrase create that copies the Seed, and the update
 * that records WHICH ARM wrote it (`Phrase.seed_source`). `journalWhy` alone lands on the provenance line, so
 * a test that means "what did the copy say" has to name the create. Pinning the pair is also the honest
 * shape: the audit of a start is two sentences, and both are Author-shaped.
 */
const journalWhys = (store: Store, label: string): string[] =>
    store.journal
        .filter((event) => event.commit_label === label)
        .map((event) => (event.attribution as { why: string }).why);

/**
 * A Story on the create route's defaults — BOTH dials on (R5/R11) — with phase ①'s two criteria removed by
 * the Author's own goal patch, which is the move U-16 describes: the Goal panel is what tells the Author
 * these two are the ones standing between them and the lock.
 */
async function makeBook(extra: Record<string, unknown> = {}): Promise<World & { story: Story }> {
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

    return { ...world, story: world.store.stories.require('story_0') };
}

/** The Premise group's id — the group the fixture writes, so the compiled Overview is one known string. */
const premiseIdOf = (store: Store): string => store.phraseGroups.list().find((group) => group.key === 'premise')!.id;

/** Writes the Premise group through the Author's own revise verb, and returns the Overview it composed. */
async function writePremise(
    world: World,
    text = 'A keeper refuses the relief boat and the island decides for her.'
): Promise<string> {
    const revised = await call(world.app, 'POST', `/stories/story_0/phrases/groups/${premiseIdOf(world.store)}/revise`, {
        content: text
    });

    expect(revised.status).toBe(200);

    const overview = (revised.body as { view: { overview: string } }).view.overview;

    // THE COMPOSITION FORMAT, pinned here so the seed assertion below cannot drift with it: the heading is
    // the projection's decoration, and it travels into Phrase ②'s seed with the text.
    expect(overview).toBe(`## Premise\n${text}`);

    return overview;
}

/** One §4.10 finding on the book, in the state the accept is about to make irrelevant. */
function seedFinding(store: Store, state: FindingState, cost: Cost = 'major', groupRefs?: string[]): string {
    return store.findings.create(
        {
            story_id: 'story_0',
            target_ref: 'summary_0',
            criterion_ref: 'C-1',
            title: `A ${state} claim`,
            evidence: 'a line of the Overview contradicts another',
            cost,
            fingerprint: `fp_${state}`,
            state,
            seen_count: 1,
            ...(groupRefs === undefined ? {} : { group_refs: groupRefs })
        },
        { why: `seed: ${state} finding` }
    ).id;
}

/** One §4.7 task in the queue. */
function seedTask(store: Store, state: TaskState, kind = 'fix'): string {
    return store.tasks.create(
        { story_id: 'story_0', kind, title: `A ${state} ${kind}`, state, priority: 1, attempts: 0 },
        { why: `seed: ${state} task` }
    ).id;
}

/** `[id, state]` of the book's findings and tasks, so "what survived" is an exact value. */
const queueOf = (store: Store) => ({
    findings: store.findings.list().map((finding) => [finding.title, finding.state]),
    tasks: store.tasks.list().map((task) => [task.title, task.state])
});

/** Phrase ②'s row, or `undefined` — a started phrase is a ROW, which is the only fact worth asserting. */
const plotlinesOf = (store: Store) => store.phrases.list().find((phrase) => phrase.key === 'plotlines');

/**
 * A Phrase ② row with ONE chapter entry, hand-seeded: the entry set comes from the Editor's accepted brief
 * (`phrase/plotlines.ts:ensureChapterGroups`), and this file is not about that rule — it is about which
 * GROUP a finding may name and still survive the Summary accept. So the rows come from the store, and only
 * the namespace matters.
 */
function seedChapterEntry(store: Store): string {
    const phrase = store.phrases.create(
        {
            story_id: 'story_0',
            key: 'plotlines',
            title: 'Plotlines Phrase',
            description: 'One entry per chapter.',
            content: '',
            order: 2,
            revision: 0,
            group_refs: [],
            seed: 'A compiled Summary, copied.'
        },
        { why: 'seed: the plotlines phrase' }
    );

    const group = store.phraseGroups.create(
        {
            story_id: 'story_0',
            phrase_id: phrase.id,
            key: 'chapter_1',
            title: 'Chapter 1',
            description: 'The chapter contract.',
            order: 1,
            content: 'Chapter 1 text.',
            revision: 1
        },
        { why: 'seed: the chapter entry' }
    );

    store.phrases.update(phrase.id, { group_refs: [group.id] }, { why: 'seed: the entry list' }, [
        { id: phrase.id, rev: phrase.rev }
    ]);

    return group.id;
}

describe('POST /stories/:id/lock — the accept stops the Summary\u2019s outstanding work and counts it (T12/R3)', () => {
    it('voids the open claims, closes the queued jobs, and answers the counts beside the row', async () => {
        const world = await makeBook();
        const overview = await writePremise(world);

        const openClaim = seedFinding(world.store, 'confirmed');
        const disputedClaim = seedFinding(world.store, 'disputed');
        const closedClaim = seedFinding(world.store, 'fixed', 'critical');
        const queuedJob = seedTask(world.store, 'open');
        const claimedJob = seedTask(world.store, 'claimed');
        const finishedJob = seedTask(world.store, 'done');

        const reply = await call(world.app, 'POST', '/stories/story_0/lock');

        expect(reply.status).toBe(200);
        expect(receiptOf(reply)).toEqual({
            phase: 'summary',
            deleted_ideas: 0,
            next_phase: 'plotlines',
            voided_findings: 2,
            wontfixed_tasks: 2,
            phrase_started: true,
            phrase_start_reason: ''
        });

        // THE ROW IS BYTE-STABLE NEXT TO THE RECEIPT: the accept adds a key, it does not rearrange the row
        // the pinned client types as `StoryRow`.
        expect(viewOf(reply)).toMatchObject({
            id: 'story_0',
            phase: 'plotlines',
            status: 'ready',
            summary_locked: true,
            plotlines_locked: false
        });
        expect(Object.keys(viewOf(reply)).sort()).toEqual([
            'active_runs',
            'auto_approve',
            'completion_proposed',
            'id',
            'levels',
            'lock_receipt',
            'pending_kind',
            'phase',
            'plotlines_locked',
            'status',
            'status_reason',
            'summary_locked',
            'title',
            'trend'
        ]);

        expect(queueOf(world.store)).toEqual({
            findings: [
                ['A confirmed claim', 'discarded'],
                ['A disputed claim', 'discarded'],
                ['A fixed claim', 'fixed']
            ],
            tasks: [
                ['A open fix', 'wontfix'],
                ['A claimed fix', 'wontfix'],
                ['A done fix', 'done']
            ]
        });

        // P11: the claims are still ROWS — voided, not deleted — and each is journaled by the accept.
        expect(world.store.findings.list().map((finding) => finding.id)).toEqual([
            openClaim,
            disputedClaim,
            closedClaim
        ]);
        expect(world.store.tasks.list().map((task) => task.id)).toEqual([queuedJob, claimedJob, finishedJob]);

        // THE PHRASE ② ROW, copied from the compiled Overview the rail previewed (R4, D-72). The seed is
        // asserted against `compiledSummaryOf` ITSELF — the projection the handoff button reads — so the
        // text the Author was shown and the text the phrase hashes cannot drift apart.
        const phrase = plotlinesOf(world.store)!;

        expect({ id: phrase.id === undefined, key: phrase.key, seed: phrase.seed, content: phrase.content }).toEqual({
            id: false,
            key: 'plotlines',
            seed: overview,
            content: ''
        });
        expect(phrase.seed).toBe(compiledSummaryOf(world.store, world.store.stories.require('story_0')));
        expect(world.store.phrases.list().filter((phrase) => phrase.key === 'plotlines')).toHaveLength(1);

        // The journal says the ACCEPT did it — the verb is the lock, not a Start the Author never pressed.
        expect(journalWhy(world.store, 'lock_phase')).toContain('phase summary signed off');
        // R12 — THE START COMMIT IS TWO LINES NOW, and both are pinned whole: the copy the Accept performed,
        // and the provenance it recorded beside it. `compiled` is the accept's arm BY DEFINITION — the text is
        // `compiledSummaryOf`, the Overview the Author just accepted — and it is the reason no grammar pass
        // is ever owed on a phrase the accept started (R7).
        expect(journalWhys(world.store, 'phrase_start')).toEqual([
            'the Author used POST /stories/:id/lock on story_0 — the Plotlines Phrase was started from the compiled Summary the Author accepted (D-72, R4) (§10 dashboard write)',
            'the Author used POST /stories/:id/lock on story_0 — the Seed this phrase copies came from `compiled` (this Story\'s compiled Summary, which the crew wrote and the Author reviewed, so no cleanup pass is owed on it, R7); the provenance is recorded ONCE, at the start, because no later read can tell the two arms apart (R12, D-72) (§10 dashboard write)'
        ]);
        // THE FIELD ITSELF, on the row the accept wrote — the audit sentence and the row must agree.
        expect(plotlinesOf(world.store)!.seed_source).toBe('compiled');
    });

    it('leaves a claim about Phrase ②’s own entry open — the sweep is the Summary\u2019s, not the Story\u2019s (R3)', async () => {
        const world = await makeBook();

        await writePremise(world);

        const chapterId = seedChapterEntry(world.store);

        world.store.findings.create(
            {
                story_id: 'story_0',
                target_ref: 'summary_0',
                criterion_ref: 'C-1',
                title: 'A claim on a chapter entry',
                evidence: 'the chapter contradicts its own contract',
                cost: 'major',
                fingerprint: 'fp_chapter_claim',
                state: 'confirmed',
                seen_count: 1,
                group_refs: [chapterId]
            },
            { why: 'seed: an out-of-phrase claim' }
        );

        const reply = await call(world.app, 'POST', '/stories/story_0/lock');

        // The claim names text the accept did NOT freeze — Phrase ② is the phrase this accept is starting —
        // so it keeps its state and its row. R3's scope is the artifact being completed, not the Story.
        expect(receiptOf(reply).voided_findings).toBe(0);
        expect(queueOf(world.store).findings).toEqual([['A claim on a chapter entry', 'confirmed']]);
    });
});

describe('POST /stories/:id/lock — Phrase ② starts automatically, and a start that cannot happen is reported (T12/R4)', () => {
    it('takes the already-started phrase as a no-op and keeps the seed the Author handed it (idempotence)', async () => {
        const world = await makeBook();

        await writePremise(world);

        const manual = await call(world.app, 'POST', '/stories/story_0/phrases/plotlines/start', {
            source: 'custom',
            text: 'A coast guard finds a wreck she reported herself.'
        });

        expect(manual.status).toBe(200);

        // R12 — the Author's manual start is TWO journal lines (the copy, and the provenance recorded beside
        // it). Counted here, BEFORE the accept runs, so the assertion below can say what the accept itself
        // wrote rather than restating what the start did.
        const linesAfterManualStart = world.store.journal.filter(
            (event) => event.commit_label === 'phrase_start'
        ).length;

        expect(linesAfterManualStart).toBe(2);
        expect(plotlinesOf(world.store)!.seed_source).toBe('custom');

        const reply = await call(world.app, 'POST', '/stories/story_0/lock');

        expect(reply.status).toBe(200);
        expect(receiptOf(reply).phrase_started).toBe(false);
        expect(receiptOf(reply).phrase_start_reason).toBe(
            `the plotlines Phrase is already started on this Story (${plotlinesOf(world.store)!.id}); its copied seed is the text every entry, revision and claim key was written against, so the accept left it alone (D-72).`
        );

        // THE SEED DID NOT MOVE: the Author's own text is the input Phrase ②'s entries and claim keys were
        // written against, and an accept is not a re-seed (D-72). One row; the accept added NO journal line of
        // its own — the two `phrase_start` lines belong to the Author's earlier start (the copy, and R12's
        // provenance), and the no-op performed no write at all, which is what the unchanged count says. The
        // provenance stayed `custom` for the same reason: a row the accept did not create is not the accept's
        // to re-label, least of all with the arm THIS request did not perform (R6 / R12).
        expect(plotlinesOf(world.store)!.seed).toBe('A coast guard finds a wreck she reported herself.');
        expect(plotlinesOf(world.store)!.seed_source).toBe('custom');
        expect(world.store.phrases.list().filter((phrase) => phrase.key === 'plotlines')).toHaveLength(1);
        expect(world.store.journal.filter((event) => event.commit_label === 'phrase_start')).toHaveLength(
            linesAfterManualStart
        );

        // THE LOCK STILL LANDED beside the no-op: idempotence is about the phrase, not about the accept.
        expect(viewOf(reply)).toMatchObject({ phase: 'plotlines', summary_locked: true });
    });

    it('leaves the lock committed and says so when there is nothing compiled to copy — never a 409', async () => {
        const world = await makeBook();

        // NO GROUP HAS TEXT: the handoff button is grey for the same reason the rail's `summary_compiled`
        // flag is false, and the accept must not undo itself over it.
        seedFinding(world.store, 'confirmed');
        seedTask(world.store, 'open');

        const reply = await call(world.app, 'POST', '/stories/story_0/lock');

        expect(reply.status).toBe(200);
        expect({
            phase: viewOf(reply).phase,
            summary_locked: viewOf(reply).summary_locked,
            receipt: receiptOf(reply)
        }).toEqual({
            phase: 'plotlines',
            summary_locked: true,
            receipt: {
                phase: 'summary',
                deleted_ideas: 0,
                next_phase: 'plotlines',
                voided_findings: 1,
                wontfixed_tasks: 1,
                phrase_started: false,
                phrase_start_reason:
                    'this Story has no compiled Summary to start the plotlines Phrase from, so the Summary is locked and Phrase ② is unchanged; POST /stories/story_0/phrases/import turns the flat Summary into groups, and a written Overview is what gets copied (R5, D-76).'
            }
        });

        // R4's tolerance, checked where it matters: the lock SURVIVED the refused start — no rollback.
        expect(world.store.stories.require('story_0')).toMatchObject({ phase: 'plotlines', summary_locked: true });
        expect(world.store.findings.list()[0].state).toBe('discarded');
        expect(world.store.tasks.list()[0].state).toBe('wontfix');
        expect(plotlinesOf(world.store)).toBeUndefined();
        expect(world.store.journal.filter((event) => event.commit_label === 'phrase_start')).toEqual([]);
    });

    it('does not invent a Phrase ② row on the classic lane, and names the two moves that would (R11)', async () => {
        const world = await makeBook({ plotlines_mode: 'classic' });

        await writePremise(world);

        const reply = await call(world.app, 'POST', '/stories/story_0/lock');

        expect(reply.status).toBe(200);
        expect(receiptOf(reply).phrase_started).toBe(false);
        expect(receiptOf(reply).phrase_start_reason).toBe(
            'this Story writes its chapter contracts with the classic plotline tools (`plotlines_mode` is not \'groups\', R11), so there is no Phrase ② to start; PATCH /stories/story_0 moves the dial and POST /stories/story_0/phrases/plotlines/start starts the phrase whenever the Author chooses (R5).'
        );
        expect(plotlinesOf(world.store)).toBeUndefined();
        expect(world.store.stories.require('story_0').summary_locked).toBe(true);
    });
});

describe('POST /stories/:id/lock — a plotlines lock is the same sign-off, and its receipt says only that', () => {
    it('reports no leftover counts and no Phrase ② answer on the phase ② leg', async () => {
        const world = await makeBook();

        await writePremise(world);
        seedFinding(world.store, 'confirmed');
        seedTask(world.store, 'open');

        expect(receiptOf(await call(world.app, 'POST', '/stories/story_0/lock')).phrase_started).toBe(true);

        // The Author empties phase ②'s Goal the same way, so the second lock passes its own gate (U-16).
        const goal = await call(world.app, 'PATCH', '/stories/story_0/goal', {
            criteria: [
                { op: 'remove', id: 'C-0' },
                { op: 'remove', id: 'C-2' },
                { op: 'remove', id: 'C-3' },
                { op: 'remove', id: 'C-4' }
            ]
        });

        expect(goal.status).toBe(200);

        const reply = await call(world.app, 'POST', '/stories/story_0/lock');

        expect(reply.status).toBe(200);
        expect(receiptOf(reply)).toEqual({ phase: 'plotlines', deleted_ideas: 0, next_phase: 'chapters' });
        expect(Object.keys(receiptOf(reply)).sort()).toEqual(['deleted_ideas', 'next_phase', 'phase']);
        expect(viewOf(reply).phase).toBe('chapters');

        // Nothing further was swept by the second lock: the rows the accept already decided are where it
        // left them, and no new claim or job was opened by phase ②'s sign-off.
        expect(queueOf(world.store)).toEqual({
            findings: [['A confirmed claim', 'discarded']],
            tasks: [['A open fix', 'wontfix']]
        });
    });
});
