// W1 acceptance — the store's four load-bearing rules, each pinned to the id that requires it.
//
//   T-4   a rejected `expects` RETURNS the current record (the agent re-reads, never forces)
//   P11/D-8/T-5 every mutation carries who made it and a `why` — and a write without one is refused
//   D-22  a multi-record decision lands as ONE commit group (and not at all if it throws)
//   L-3/D-12a the two files round-trip: the snapshot rehydrates the memory, the journal survives as history
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

// The store module deliberately does NOT re-export the §4 record types: `shared/types` is
// their only home, so a barrel that star-exports both never hits an ambiguous name.
import { CasConflict, Store, StoreError, type Attribution } from './store';
import type { Finding, Revision, Story } from '../../shared/types';

// The two attribution shapes a real run produces: an agent run carries `run_ref`, the Author's
// own edit carries `author: true` with `run_ref: null` (D-20a).
const RUN_A: Attribution = { run_ref: 'run_1', why: 'writer expands the seed' };
const RUN_B: Attribution = { run_ref: 'run_2', why: 'editor selects the stronger expansion' };
const AUTHOR: Attribution = { run_ref: null, author: true, why: 'author declares the chapter count' };

/** A §4.1 Story payload — only the fields §4 marks required, so a test cannot drift into inventing fields. */
function storyInit(
    title = 'Cold Mountain',
    phase: Story['phase'] = 'summary'
): Omit<Story, 'id' | 'rev' | 'created_at' | 'updated_at'> {
    return {
        title,
        phase,
        idea: 'A cartographer returns to the valley she mapped as a girl and finds it redrawn by a reservoir.',
        summary_locked: false,
        plotlines_locked: false,
        pending_kind: 'none',
        status: 'ready',
        trend: 'unknown',
        auto_approve: ['critical', 'major'],
        author_stop: false,
        digest_rev: 0,
        template_refs: [],
        chapter_deps: {}
    };
}

/** A §4.15 competing revision — the payload D-22 deletes on selection. */
function revisionInit(runRef: string, body: string): Omit<Revision, 'id' | 'rev' | 'created_at' | 'updated_at'> {
    return {
        story_id: 'story_0',
        unit_kind: 'summary',
        unit_ref: 'summary_0',
        body,
        run_ref: runRef,
        state: 'competing',
        verdict_refs: []
    };
}

/**
 * A §4.11 Finding, scoped to whichever story the test is writing. `story_id` is a parameter
 * because the story-bound store's whole job is refusing a record that names a DIFFERENT story.
 */
function findingInit(
    storyId: string,
    detail: string
): Omit<Finding, 'id' | 'rev' | 'created_at' | 'updated_at'> {
    return {
        story_id: storyId,
        target_ref: 'chapter_0',
        criterion_ref: 'C-7',
        title: 'The reservoir is never paid off',
        detail,
        evidence: 'ch1 §3, ¶2',
        cost: 'major',
        fingerprint: `fp_${detail}`,
        state: 'unconfirmed',
        seen_count: 1
    };
}

/** A fresh scratch tree under the repo's own `Temp/` — never the OS temp (AGENTS.md), never a real book. */
async function scratchDir(): Promise<string> {
    const base = path.resolve(process.cwd(), 'Temp');

    await mkdir(base, { recursive: true });

    return mkdtemp(path.join(base, 'create-storyline-store-'));
}

describe('Store — ids, revisions and CAS (T-4)', () => {
    it('mints ZERO-BASED `${singular}_${n}` ids with rev 1 on create (W1, per-story ids)', () => {
        const store = Store.empty();

        const first = store.stories.create(storyInit('Cold Mountain'), AUTHOR);
        const second = store.stories.create(storyInit('Salt Line'), AUTHOR);

        // Child ids are story-local and start at zero: the first record in a collection is `_0`,
        // so two stories may both hold `finding_0` and mean different findings.
        expect(first.id).toBe('story_0');
        expect(second.id).toBe('story_1');
        expect(first.rev).toBe(1);
        expect([first.rev, second.rev]).toEqual([1, 1]);

        // The bookkeeping is the store's, and the timestamps are real ISO instants — the
        // journal and the audit read them, so a test pins the shape rather than the clock.
        expect(first.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(first.updated_at).toBe(first.created_at);

        // Two collections mint independently, and `cast`/`ledger` get their explicit singulares.
        expect(store.cast.create({ story_id: 'story_0', name: 'Ilse' }, RUN_A).id).toBe('cast_member_0');
        expect(
            store.ledger.create({ story_id: 'story_0', kind: 'setup', subject: 'the locket', status: 'open' }, RUN_A).id
        ).toBe('ledger_entry_0');

        // An id is not reused when the record that held it is deleted (the counter is monotonic).
        store.tasks.create(
            { story_id: 'story_0', kind: 'fix', title: 'Pay the locket setup', state: 'open', priority: 1, attempts: 0 },
            RUN_A
        );
        store.tasks.delete('task_0', RUN_A);

        expect(
            store.tasks.create(
                { story_id: 'story_0', kind: 'fix', title: 'Repay it', state: 'open', priority: 1, attempts: 0 },
                RUN_A
            ).id
        ).toBe('task_1');
    });

    it('T-4: a rejected `expects` returns the CURRENT record and writes nothing', () => {
        const store = Store.empty();

        store.stories.create(storyInit('Cold Mountain'), AUTHOR);

        let conflict: CasConflict | undefined;

        try {
            store.stories.update('story_0', { title: 'Forced' }, RUN_A, [{ id: 'story_0', rev: 99 }]);
        } catch (error) {
            conflict = error as CasConflict;
        }

        expect(conflict).toBeInstanceOf(CasConflict);
        // The contract of T-4 in one assertion: the caller is handed the record it must re-read.
        expect(conflict?.currents).toEqual([
            { id: 'story_0', record: expect.objectContaining({ id: 'story_0', rev: 1, title: 'Cold Mountain' }) }
        ]);
        expect(conflict?.message).toContain('T-4');
        // And the rejection is a refusal, not a force: nothing changed and nothing journaled.
        expect(store.stories.require('story_0').title).toBe('Cold Mountain');
        expect(store.stories.require('story_0').rev).toBe(1);
        expect(store.journal).toHaveLength(1);
    });

    it('T-4: `expects` resolves across collections, because a tool declares every record it read', () => {
        const store = Store.empty();

        store.stories.create(storyInit('Cold Mountain'), AUTHOR);
        store.chapters.create(
            {
                story_id: 'story_0',
                order: 1,
                title: 'One',
                sections: [],
                state: 'outlined',
                author_locked: false,
                round: 0
            },
            RUN_A
        );

        // A chapter write that assumes a stale STORY rev is still detected (a `selectRevision`
        // or `editChapter` brief carries the revs of everything it read — T-8, T-4).
        expect(() => store.chapters.update('chapter_0', { title: 'Two' }, RUN_A, [{ id: 'story_0', rev: 7 }])).toThrow(
            CasConflict
        );

        try {
            store.chapters.update('chapter_0', { title: 'Two' }, RUN_A, [{ id: 'story_0', rev: 7 }]);
        } catch (error) {
            const conflict = error as CasConflict;

            expect(conflict.currents[0].record).toEqual(expect.objectContaining({ id: 'story_0', rev: 1 }));
        }

        expect(store.chapters.require('chapter_0').title).toBe('One');
    });

    it('T-4: a matching `expects` writes, bumps rev, and reports every entry it checked', () => {
        const store = Store.empty();

        store.stories.create(storyInit('Cold Mountain'), AUTHOR);

        const updated = store.stories.update('story_0', { trend: 'improving' }, RUN_A, [{ id: 'story_0', rev: 1 }]);

        expect(updated).toEqual(
            expect.objectContaining({ id: 'story_0', rev: 2, trend: 'improving', title: 'Cold Mountain' })
        );

        // A deleted record is reported as a conflict with `record: undefined` rather than a
        // rev that silently matched nothing.
        store.stories.delete('story_0', AUTHOR);

        try {
            store.stories.create(storyInit('Again'), AUTHOR);
            store.stories.update('story_1', { trend: 'flat' }, RUN_A, [{ id: 'story_0', rev: 2 }]);
            throw new Error('unreachable: a deleted id must conflict');
        } catch (error) {
            expect(error).toBeInstanceOf(CasConflict);
            expect((error as CasConflict).currents).toEqual([{ id: 'story_0', record: undefined }]);
        }
    });

    it('hands out COPIES, so the journal stays the only way a change exists (P11)', () => {
        const store = Store.empty();

        store.stories.create(storyInit('Cold Mountain'), AUTHOR);

        const read = store.stories.require('story_0');

        read.title = 'Mutated in place';
        read.chapter_deps.story_0 = ['story_1'];

        expect(store.stories.require('story_0').title).toBe('Cold Mountain');
        expect(store.stories.require('story_0').chapter_deps).toEqual({});
        expect(store.journal).toHaveLength(1);
    });
});

describe('Store — attribution (P11, D-8, T-5)', () => {
    it('stamps attribution and `why` on create, update and delete', () => {
        const store = Store.empty();

        const story = store.stories.create(storyInit('Cold Mountain'), AUTHOR);

        store.stories.update(story.id, { digest_rev: 1 }, RUN_A);
        store.tasks.create(
            { story_id: story.id, kind: 'fix', title: 'Pay the locket setup', state: 'open', priority: 1, attempts: 0 },
            RUN_A
        );
        store.tasks.delete('task_0', RUN_B);

        expect(store.journal.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
        expect(store.journal.map((event) => [event.collection, event.op, event.id])).toEqual([
            ['stories', 'create', 'story_0'],
            ['stories', 'update', 'story_0'],
            ['tasks', 'create', 'task_0'],
            ['tasks', 'delete', 'task_0']
        ]);
        expect(store.journal.map((event) => event.attribution)).toEqual([AUTHOR, RUN_A, RUN_A, RUN_B]);

        // A delete carries the deleted record, or P11's "and undo it" has nothing to undo.
        expect(store.journal[3].patch).toEqual(
            expect.objectContaining({ id: 'task_0', title: 'Pay the locket setup' })
        );
        // An update carries the patch as sent, and `seq` ordering is the audit's only clock.
        expect(store.journal[1].patch).toEqual({ digest_rev: 1 });
    });

    it('T-5/D-8: refuses any mutation whose `why` is missing or blank, and writes nothing', () => {
        const store = Store.empty();

        expect(() => store.stories.create(storyInit('Cold Mountain'), { run_ref: 'run_1' } as Attribution)).toThrow(
            StoreError
        );

        try {
            store.stories.create(storyInit('Cold Mountain'), { run_ref: 'run_1', why: '   ' } as Attribution);
        } catch (error) {
            expect((error as StoreError).message).toContain('attribution.why');
        }

        expect(store.stories.count()).toBe(0);
        expect(store.journal).toEqual([]);
    });

    it('an Author edit is distinguishable from an agent write and from an assistant run (D-20a, §8.6)', () => {
        const store = Store.empty();

        const story = store.stories.create(storyInit('Cold Mountain'), AUTHOR);

        store.chapters.create(
            {
                story_id: story.id,
                order: 1,
                title: 'One',
                sections: [],
                state: 'outlined',
                author_locked: false,
                round: 0
            },
            { run_ref: 'run_9', assistant: true, why: 'assistant rewrite the Author asked for' }
        );

        expect(store.journal[0].attribution).toEqual({
            run_ref: null,
            author: true,
            why: 'author declares the chapter count'
        });
        expect(store.journal[1].attribution).toEqual({
            run_ref: 'run_9',
            assistant: true,
            why: 'assistant rewrite the Author asked for'
        });
    });
});

describe('Store.commit — one decision, one group (D-22)', () => {
    it('D-22 shape: the selection and the deletion of the losers are ONE commit', async () => {
        const store = Store.empty();

        store.stories.create(storyInit('Cold Mountain'), AUTHOR);

        const drafts = ['draft_a', 'draft_b', 'draft_c'].map((body) =>
            store.revisions.create(revisionInit('run_1', body), RUN_A)
        );

        const groups: { collection: string; ops: string[]; labels: string[] }[] = [];

        store.onCommit((events) => {
            groups.push({
                collection: events[0].collection,
                ops: events.map((event) => event.op),
                labels: [...new Set(events.map((event) => event.commit_label))]
            });
        });

        const [winner] = drafts;

        await store.commit('select_revision', (tx) => {
            tx.revisions.update(
                winner.id,
                { state: 'selected', selection_note: 'preferred the colder opening (rule 3)' },
                RUN_B,
                [{ id: winner.id, rev: winner.rev }]
            );

            // The same commit scraps the alternatives: P13/D-22 — deletion is hard, not a flag.
            tx.revisions.deleteWhere((revision) => revision.state === 'competing', RUN_B);
        });

        // One decision reached the journal: one listener call, three events, one label.
        expect(groups).toEqual([
            { collection: 'revisions', ops: ['update', 'delete', 'delete'], labels: ['select_revision'] }
        ]);

        // 1 story + 3 drafts + the 3 events of the selection, contiguous and ordered: the
        // group is one audit unit, and `seq` is the only clock the journal has.
        expect(store.journal).toHaveLength(7);
        expect(store.journal.slice(4).map((event) => [event.seq, event.op])).toEqual([
            [5, 'update'],
            [6, 'delete'],
            [7, 'delete']
        ]);

        // And the store holds only the chosen text.
        expect(store.revisions.list()).toEqual([
            expect.objectContaining({
                id: 'revision_0',
                state: 'selected',
                selection_note: 'preferred the colder opening (rule 3)'
            })
        ]);
    });

    it('rolls every write back when the commit throws, records and counters included', async () => {
        const store = Store.empty();

        store.stories.create(storyInit('Cold Mountain'), AUTHOR);

        const drafts = ['draft_a', 'draft_b'].map((body) => store.revisions.create(revisionInit('run_1', body), RUN_A));
        const before = store.journal.length;

        let notified = 0;

        store.onCommit(() => {
            notified += 1;
        });

        await expect(
            store.commit('select_revision', (tx) => {
                tx.revisions.update(drafts[0].id, { state: 'selected' }, RUN_B);
                tx.stories.update('story_0', { phase: 'plotlines' }, RUN_B);

                // A CAS rejection halfway through is the real failure mode W2 will hit.
                tx.revisions.update(drafts[1].id, { state: 'discarded' }, RUN_B, [{ id: drafts[1].id, rev: 99 }]);
            })
        ).rejects.toThrow(CasConflict);

        expect(store.revisions.list().map((revision) => [revision.id, revision.state, revision.rev])).toEqual([
            ['revision_0', 'competing', 1],
            ['revision_1', 'competing', 1]
        ]);
        expect(store.stories.require('story_0').phase).toBe('summary');
        expect(store.journal).toHaveLength(before);
        expect(notified).toBe(0);

        // The id counter rolled back with it, so the rolled-back create did not burn an id.
        expect(store.revisions.create(revisionInit('run_3', 'draft_c'), RUN_A).id).toBe('revision_2');
    });

    it('a commit that writes nothing journals nothing and notifies nobody', async () => {
        const store = Store.empty();

        store.stories.create(storyInit('Cold Mountain'), AUTHOR);

        let notified = 0;

        store.onCommit(() => {
            notified += 1;
        });

        await store.commit('read_only_pass', (tx) => {
            tx.stories.list();
        });

        expect(store.journal).toHaveLength(1);
        expect(notified).toBe(0);
    });

    it('onCommit unsubscribes (the SSE feed attaches and detaches)', async () => {
        const store = Store.empty();
        const seen: number[][] = [];

        const off = store.onCommit((events) => seen.push(events.map((event) => event.seq)));

        store.goals.create(
            { title: 'default', threshold_soft: 3, criteria: [], flat_rounds: 3, regress_tolerance: 2 },
            AUTHOR
        );
        off();
        store.goals.update('goal_0', { threshold_soft: 4 }, AUTHOR);

        expect(seen).toEqual([[1]]);
    });

    it('deleteWhere is the bulk scrap D-25/D-36 need, and reports the count', () => {
        const store = Store.empty();

        store.stories.create(storyInit('Cold Mountain'), AUTHOR);

        const idea = (phase: 'summary' | 'plotlines', body: string) => ({
            story_id: 'story_0',
            phase,
            body,
            kind: 'possibility' as const,
            author: 'reader-genre',
            sources: [],
            fingerprint: `fp_${body}`,
            seen_count: 1,
            state: 'discarded' as const
        });

        store.ideas.create(idea('summary', 'colder framing'), RUN_A);
        store.ideas.create(idea('summary', 'warmer framing'), RUN_A);
        store.ideas.create(idea('plotlines', 'move the reservoir'), RUN_A);

        // D-36: locking Phase 1 empties THAT phase's tray, and only that phase's tray.
        const removed = store.ideas.deleteWhere((record) => record.phase === 'summary', AUTHOR);

        expect(removed).toBe(2);
        expect(store.ideas.list().map((record) => record.body)).toEqual(['move the reservoir']);
        expect(store.journal.filter((event) => event.op === 'delete')).toHaveLength(2);
        // A bulk scrap that needs to be atomic runs inside the commit (see the D-22 test above).
        expect(store.ideas.count()).toBe(1);
    });
});

describe('Store persistence — the two files (P1, L-3, D-12a)', () => {
    // A scratch tree per run (see `scratchDir`), so parallel workers never share a file.
    let dir: string;

    async function scratch(): Promise<string> {
        dir = await scratchDir();

        return dir;
    }

    async function seed(root: string): Promise<Store> {
        const store = await Store.load(root);

        store.stories.create(storyInit('Cold Mountain'), AUTHOR);

        await store.commit('author_lock', (tx) => {
            tx.stories.update('story_0', { summary_locked: true, pending_kind: 'phase_signoff' }, AUTHOR, [
                { id: 'story_0', rev: 1 }
            ]);
            tx.summaries.create(
                { story_id: 'story_0', chapter_count: 8, premise: 'a mapped valley under water', locked: true },
                AUTHOR
            );
        });

        await store.close();

        return store;
    }

    it('writes store.json and journal.jsonl, and a reload restores the records AND the journal', async () => {
        const root = await scratch();

        try {
            const store = await seed(root);

            expect(store.journal.map((event) => event.seq)).toEqual([1, 2, 3]);

            const reloaded = await Store.load(root);

            expect(reloaded.stories.list()).toEqual([
                expect.objectContaining({
                    id: 'story_0',
                    rev: 2,
                    title: 'Cold Mountain',
                    summary_locked: true,
                    pending_kind: 'phase_signoff'
                })
            ]);
            expect(reloaded.summaries.list()).toEqual([
                expect.objectContaining({ id: 'summary_0', chapter_count: 8, locked: true })
            ]);

            // D-12a: the committed history is what the Digest is derived from, so it has to
            // survive the restart intact and in order.
            expect(
                reloaded.journal.map((event) => [event.seq, event.commit_label, event.collection, event.op])
            ).toEqual([
                [1, 'create:stories', 'stories', 'create'],
                [2, 'author_lock', 'stories', 'update'],
                [3, 'author_lock', 'summaries', 'create']
            ]);

            const journalFile = await readFile(path.join(root, 'journal.jsonl'), 'utf-8');

            expect(journalFile.trim().split('\n')).toHaveLength(3);
            expect(JSON.parse(journalFile.trim().split('\n')[1] as string)).toEqual(
                expect.objectContaining({ seq: 2, commit_label: 'author_lock', attribution: AUTHOR })
            );

            // `close()` flushed, so the store file is the current memory (P1).
            const snapshot = JSON.parse(await readFile(path.join(root, 'store.json'), 'utf-8'));

            expect(snapshot.version).toBe(2);
            // v2 counters are the NEXT id to mint, and ids are zero-based: one story (`story_0`)
            // means the next create is `story_1`, so the file says 1.
            expect(snapshot.counters.stories).toBe(1);
            // An unbound book writes no `story_id` — only a story store binds itself to a folder.
            expect('story_id' in snapshot).toBe(false);
            // `store.json` puts the record arrays under `records` (persist.ts `StoreSnapshot`);
            // the top level is version + counters + records + settings + journal.
            expect(snapshot.records.stories).toHaveLength(1);
            expect(snapshot.records.stories[0].rev).toBe(2);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('continues the id counters and the journal seq across a restart, so nothing is minted twice (L-3)', async () => {
        const root = await scratch();

        try {
            await seed(root);

            const reloaded = await Store.load(root);

            expect(reloaded.stories.create(storyInit('Second Book'), AUTHOR).id).toBe('story_1');
            expect(reloaded.journal[reloaded.journal.length - 1].seq).toBe(4);

            // A second restart after the new write must not reuse story_1 or seq 4.
            await reloaded.close();

            const again = await Store.load(root);

            expect(again.stories.list().map((story) => story.id)).toEqual(['story_0', 'story_1']);
            expect(again.journal.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('loads a long-lived book whose journal exceeds the argument-passing ceiling (L-3)', async () => {
        const root = await scratch();

        try {
            // Six figures of committed history is what a loop that has run for a day produces.
            // Spreading that many events into `push(...)` overflows the call stack on any V8
            // build, so the load has to append without a variadic call.
            const events = Array.from({ length: 200_000 }, (_, index) => ({
                seq: index + 1,
                at: new Date(0).toISOString(),
                collection: 'stories',
                op: 'update',
                id: 'story_0',
                attribution: AUTHOR,
                patch: {},
                commit_label: 'long_lived'
            }));

            await writeFile(
                path.join(root, 'store.json'),
                // version 2: the format this build writes (persist.ts `SNAPSHOT_VERSION`).
                JSON.stringify({ version: 2, counters: {}, records: {}, journal: events })
            );

            const store = await Store.load(root);

            expect(store.journal).toHaveLength(events.length);
            expect(store.journal[events.length - 1]?.seq).toBe(events.length);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('a missing store file is a first boot, not an error, and the empty store can still persist', async () => {
        const root = await scratch();

        try {
            const store = await Store.load(root);

            expect(store.stories.count()).toBe(0);
            expect(store.journal).toEqual([]);

            store.stories.create(storyInit('First Boot'), AUTHOR);
            await store.persist();

            const reloaded = await Store.load(root);

            expect(reloaded.stories.list().map((story) => story.title)).toEqual(['First Boot']);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('an in-memory store persists nowhere and loses nothing at runtime', async () => {
        const store = Store.empty();

        store.stories.create(storyInit('Ephemeral'), AUTHOR);

        await expect(store.persist()).resolves.toBeUndefined();
        await expect(store.close()).resolves.toBeUndefined();
        expect(store.stories.count()).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// A story-bound Store: one production Store is one story (per-story layout)
// ---------------------------------------------------------------------------

// Fixed UUIDs (any version nibble — the shape is what the layout validates) keep every id below
// an exact assertion rather than a `toMatch(uuid)`.
const STORY_A = '2f7c9a51-6a13-4bd6-9b1c-6c2b0d4b7a11';
const STORY_B = '8b1d4c2e-0f77-4a3f-a2c5-9d1e6b8c4f22';

describe('Story-bound Store — one Store is one story', () => {
    it('mints the story UUID as the one `stories` id, not `story_0`', () => {
        const store = Store.emptyStory(STORY_A);

        expect(store.storyId).toBe(STORY_A);

        const story = store.stories.create(storyInit('Cold Mountain'), AUTHOR);

        // This is what the registry depends on: the folder name, the story row's id, and every
        // child record's `story_id` are the same string.
        expect(story).toEqual(
            expect.objectContaining({ id: STORY_A, rev: 1, title: 'Cold Mountain', phase: 'summary' })
        );

        // Child ids stay story-local and zero-based inside the same store.
        expect(store.findings.create(findingInit(STORY_A, 'x'), RUN_A).id).toBe(
            'finding_0'
        );
        expect(store.journal.map((event) => [event.seq, event.collection, event.id])).toEqual([
            [1, 'stories', STORY_A],
            [2, 'findings', 'finding_0']
        ]);
    });

    it('refuses a second Story in the same Store, and refuses to reuse the UUID after a delete', () => {
        const store = Store.emptyStory(STORY_A);

        store.stories.create(storyInit('Cold Mountain'), AUTHOR);

        let message = '';

        try {
            store.stories.create(storyInit('Second Book'), AUTHOR);
        } catch (error) {
            message = (error as StoreError).message;
        }

        expect(message).toContain('one Store is one story');
        expect(store.stories.list().map((story) => story.id)).toEqual([STORY_A]);

        // Deleting the row does not free the identity: a new story is a new folder, and a new
        // Store, rather than a second story record wearing the old UUID.
        store.stories.delete(STORY_A, AUTHOR);

        expect(() => store.stories.create(storyInit('Third Book'), AUTHOR)).toThrow(StoreError);
    });

    it('rolls the story id back with a failed commit, so a redispatched decision can still write it', async () => {
        const store = Store.emptyStory(STORY_A);

        await expect(
            store.commit('author_seed', (tx) => {
                tx.stories.create(storyInit('Cold Mountain'), AUTHOR);

                throw new StoreError('the commit failed');
            })
        ).rejects.toThrow('the commit failed');

        expect(store.stories.count()).toBe(0);
        expect(store.journal).toEqual([]);
        expect(store.stories.create(storyInit('Cold Mountain'), AUTHOR).id).toBe(STORY_A);
    });

    it('refuses a record that names another story, and writes nothing when it does', () => {
        const store = Store.emptyStory(STORY_A);

        store.stories.create(storyInit('Cold Mountain'), AUTHOR);

        // The bug this closes: a finding from story B parked in story A's book would be listed,
        // judged and deleted as if it belonged to A.
        expect(() => store.findings.create(findingInit(STORY_B, 'x'), RUN_A)).toThrow(
            StoreError
        );

        try {
            store.findings.create(findingInit(STORY_B, 'x'), RUN_A);
        } catch (error) {
            expect((error as StoreError).message).toContain(STORY_B);
        }

        expect(store.findings.count()).toBe(0);
        expect(store.journal.map((event) => event.seq)).toEqual([1]);

        const chapter = store.chapters.create(
            { story_id: STORY_A, order: 1, title: 'One', sections: [], state: 'outlined', author_locked: false, round: 0 },
            RUN_A
        );

        // An update cannot smuggle a record into another story either.
        expect(() => store.chapters.update(chapter.id, { story_id: STORY_B }, RUN_A)).toThrow(StoreError);
        expect(store.chapters.require('chapter_0').story_id).toBe(STORY_A);
        expect(store.chapters.require('chapter_0').rev).toBe(1);
    });

    it('an UNBOUND store keeps the generic behaviour: no UUID, no story rule', () => {
        const store = Store.empty();

        expect(store.storyId).toBeNull();
        expect(store.stories.create(storyInit('Cold Mountain'), AUTHOR).id).toBe('story_0');
        expect(store.findings.create(findingInit('someone-elses-story', 'x'), RUN_A).id).toBe(
            'finding_0'
        );
    });

    it('refuses a story id that is not a UUID before anything is built', () => {
        for (const bad of ['story_1', '../evil', '', '2f7c9a51-6a13-4bd6-9b1c-6c2b0d4b7a1x']) {
            expect(() => Store.emptyStory(bad)).toThrow(/UUID/);
        }

        expect(() => Store.emptyStory(undefined as unknown as string)).toThrow(/UUID/);
    });

    it('binds store.json to its story and refuses to open one story as another', async () => {
        const dir = await scratchDir();

        try {
            const store = await Store.loadStory(STORY_A, dir);

            store.stories.create(storyInit('Cold Mountain'), AUTHOR);
            await store.close();

            const snapshot = JSON.parse(await readFile(path.join(dir, 'store.json'), 'utf-8'));

            expect(snapshot.version).toBe(2);
            expect(snapshot.story_id).toBe(STORY_A);

            // The same folder reopens as the same story, journal and all.
            const again = await Store.loadStory(STORY_A, dir);

            expect(again.storyId).toBe(STORY_A);
            expect(again.stories.list().map((story) => story.id)).toEqual([STORY_A]);

            // …and as any other story it is an error, not a quiet share of the wrong book.
            let message = '';

            try {
                await Store.loadStory(STORY_B, dir);
            } catch (error) {
                message = (error as StoreError).message;
            }

            expect(message).toContain(`belongs to story ${STORY_A}, not story ${STORY_B}`);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('refuses a store.json that names no story — the old flat layout is not migrated', async () => {
        const dir = await scratchDir();

        try {
            // What a pre-per-story book looks like: one flat `store.json` with no story binding.
            await writeFile(
                path.join(dir, 'store.json'),
                JSON.stringify({ version: 2, counters: {}, records: { stories: [] }, journal: [] })
            );

            let message = '';

            try {
                await Store.loadStory(STORY_A, dir);
            } catch (error) {
                message = (error as StoreError).message;
            }

            expect(message).toContain('is not bound to a story');
            expect(message).toContain('does not migrate');

            // The same file is still fine for a generic (unbound) read.
            expect((await Store.load(dir)).storyId).toBeNull();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('gives two story stores their own ids, counters and journal sequences', async () => {
        const [dirA, dirB] = [await scratchDir(), await scratchDir()];

        try {
            const [a, b] = [await Store.loadStory(STORY_A, dirA), await Store.loadStory(STORY_B, dirB)];

            a.stories.create(storyInit('Cold Mountain'), AUTHOR);
            b.stories.create(storyInit('Salt Line'), AUTHOR);

            const findingA = a.findings.create(findingInit(STORY_A, 'a'), RUN_A);
            const findingB = b.findings.create(findingInit(STORY_B, 'b'), RUN_B);

            // Duplicate local ids, different facts: exactly the collision the shared journal used to hide.
            expect([findingA.id, findingB.id]).toEqual(['finding_0', 'finding_0']);

            a.findings.update('finding_0', { detail: 'a revised' }, RUN_A);

            expect(a.findings.require('finding_0').detail).toBe('a revised');
            expect(b.findings.require('finding_0').detail).toBe('b');

            // Each journal is its own story's history, starting from the store's initial state.
            expect(a.journal.map((event) => event.seq)).toEqual([1, 2, 3]);
            expect(b.journal.map((event) => event.seq)).toEqual([1, 2]);
            expect(b.journal.map((event) => event.attribution)).toEqual([AUTHOR, RUN_B]);

            await Promise.all([a.close(), b.close()]);
        } finally {
            await rm(dirA, { recursive: true, force: true });
            await rm(dirB, { recursive: true, force: true });
        }
    });
});
