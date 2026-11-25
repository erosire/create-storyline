// §10 / P1 — deleting a Story is deleting its harness: every story-scoped §4 row, the knowledge
// directory, the in-memory sessions/threads, and the Story row itself. This is the route the
// dashboard's Delete button drives, asserted through the real engine and store.
import { describe, expect, it } from 'vitest';
import { MockChatClient, msg } from '../llm/mock';
import { buildStorylineRuntime } from './server';
import { MockToolRuntime, AUTHOR_ATTR, seedChapter, seedFinding, seedIdea, seedPlotline, seedRevision, seedTask } from '../run/mock';
import { installGroupRevisions } from '../phrase/revisions';
// PHRASE ② (T-W6): the three domain operations that put a second phrase on the book the delete has to
// purge — the start (its copied Seed), the Editor's structure pass, and the accept that materializes the
// chapter entries. They come from the phrase barrel, the same surface `loop/**` and `api/routes.ts` use.
import { acceptPlotlineBrief, createPlotlineBrief, startPlotlinesPhrase } from '../phrase';
import { Store } from '../store/store';
import type { Hono } from 'hono';
import type { StoryRow } from '../../dashboard/api';

const makeApp = () => {
    const store = Store.empty();
    const chat = new MockChatClient(() => ({ message: msg({ content: 'nothing to report' }) }));
    const runtime = new MockToolRuntime(store, '');
    const built = buildStorylineRuntime({
        store,
        chat,
        runtime,
        engineConfig: { autoSweep: false },
        noAssistantSeed: true
    });

    return { ...built, toolRuntime: runtime };
};

async function call(app: Hono, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) {
    const response = await app.request(`http://localhost/v1/storyline${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    });
    const text = await response.text();

    return { status: response.status, body: text.length === 0 ? undefined : (JSON.parse(text) as unknown) };
}

describe('DELETE /stories/:id — the Story and its harness go together (P1, §10)', () => {
    it('removes the book, its artifacts, its runs, its knowledge and its harness', async () => {
        const world = makeApp();

        const created = await call(world.app, 'POST', '/stories', {
            title: 'The Salt Cartographer',
            idea: 'A mapmaker finds her own coastline redrawn on a chart she surveyed herself.',
            chapter_count: 2
        });
        const storyId = (created.body as StoryRow).id;

        // Seed one row in the collections the Story owns (the shape of a lived-in book).
        const plotline = seedPlotline(world.store, storyId);
        const chapter = seedChapter(world.store, storyId, { plotline_ref: plotline.id });
        seedFinding(world.store, storyId, { target_ref: chapter.id });
        seedTask(world.store, storyId);
        seedIdea(world.store, storyId);
        const draft = seedRevision(world.store, storyId, chapter.id, 'a competing draft', 'run_1');

        // Phase ①'s three research collections are story-scoped too (T12/A): one accepted Seed
        // Brief, one sourced Knowledge entry and one screening review of the draft above. A delete
        // that leaves any of them behind orphans rows naming a Story the store no longer holds.
        const brief = world.store.seedBriefs.create(
            {
                story_id: storyId,
                seed_hash: 'seed-fnv-1',
                logline: 'a mapmaker finds her coastline redrawn',
                protagonist: 'Maren',
                want: 'the true chart',
                obstacle: 'a reservoir',
                stakes: 'her name on the map',
                setting: 'the valley',
                world_rules: ['the Seed is law (P5)'],
                promise: 'the book pays the promise the Seed makes',
                constraints: [],
                open_questions: [],
                status: 'accepted'
            },
            { run_ref: null, why: 'seed a Seed Brief the delete must remove (T12/A)' }
        );
        const fact = world.store.knowledge.create(
            {
                story_id: storyId,
                kind: 'place',
                topic: 'the valley',
                claim: 'the reservoir drowned the 1911 shoreline',
                importance: 'critical',
                sources: [
                    { url_or_title: 'the survey', claim: 'it charts the old shoreline', accessed_at: '2026-11-22T00:00:00.000Z' }
                ],
                fingerprint: 'knowledge|valley|reservoir',
                seen_count: 1,
                author: 'researcher'
            },
            { run_ref: null, why: 'seed a Knowledge entry the delete must remove (T12/A)' }
        );
        const review = world.store.sampleReviews.create(
            {
                story_id: storyId,
                revision_ref: draft.id,
                critic: 'critic',
                issues: [],
                valid: true
            },
            { run_ref: null, why: 'seed a screening review the delete must remove (T12/A)' }
        );

        expect([brief.story_id, fact.story_id, review.story_id]).toEqual([storyId, storyId, storyId]);

        world.store.runs.create(
            {
                story_id: storyId,
                work_item_ref: 'wi_write_chapter_1',
                role: 'writer',
                state: 'torn_down',
                started_at: '2026-11-22T10:00:00.000Z',
                ended_at: '2026-11-22T10:00:01.000Z',
                tokens: 12,
                kind: 'work',
                no_op: false,
                delegated: []
            },
            { run_ref: null, author: true, why: 'seed a closed run the delete must remove' }
        );

        // The knowledge directory materialises on read; the harness exists once a Story dispatches.
        expect((await call(world.app, 'GET', `/stories/${storyId}/knowledge`)).status).toBe(200);
        // Nine folders: the eight §4 surfaces plus phase ①'s research mirror (§3.2/§10).
        expect(world.knowledge.tree(storyId)?.sections).toHaveLength(9);

        world.executor.harness.forStory(storyId);
        expect(world.executor.harness.has(storyId)).toBe(true);

        const deleted = await call(world.app, 'DELETE', `/stories/${storyId}`);

        expect(deleted).toEqual({ status: 200, body: { deleted: storyId } });
        expect(world.store.stories.get(storyId)).toBeUndefined();
        expect(world.store.summaries.list().filter((row) => row.story_id === storyId)).toEqual([]);
        expect(world.store.plotlines.list().filter((row) => row.story_id === storyId)).toEqual([]);
        expect(world.store.chapters.list().filter((row) => row.story_id === storyId)).toEqual([]);
        expect(world.store.findings.list().filter((row) => row.story_id === storyId)).toEqual([]);
        expect(world.store.tasks.list().filter((row) => row.story_id === storyId)).toEqual([]);
        expect(world.store.ideas.list().filter((row) => row.story_id === storyId)).toEqual([]);
        expect(world.store.revisions.list().filter((row) => row.story_id === storyId)).toEqual([]);
        expect(world.store.runs.list().filter((row) => row.story_id === storyId)).toEqual([]);
        expect(world.store.goals.list().filter((row) => row.story_id === storyId)).toEqual([]);

        // T12/A — the three phase-① research collections go in the SAME commit (P1). Each assertion
        // is "no row names this Story", which is the orphan the defect produced.
        expect(world.store.seedBriefs.list().filter((row) => row.story_id === storyId)).toEqual([]);
        expect(world.store.knowledge.list().filter((row) => row.story_id === storyId)).toEqual([]);
        expect(world.store.sampleReviews.list().filter((row) => row.story_id === storyId)).toEqual([]);

        // The projection outside §4 and the harness are gone with the Story.
        expect(world.knowledge.tree(storyId)).toBeNull();
        expect(world.executor.harness.has(storyId)).toBe(false);
        expect((await call(world.app, 'GET', `/stories/${storyId}`)).status).toBe(404);
        expect((await call(world.app, 'GET', `/stories/${storyId}/knowledge`)).status).toBe(404);
    });

    it('purges both Phrase catalogs with the book: the Summary rows, and Phrase ②\u2019s row, entries, history and brief (P1, R1, D-63, D-77)', async () => {
        const world = makeApp();

        const created = await call(world.app, 'POST', '/stories', {
            title: 'The Salt Cartographer',
            idea: 'A mapmaker finds her own coastline redrawn on a chart she surveyed herself.',
            chapter_count: 1,
            summary_mode: 'groups'
        });
        const storyId = (created.body as StoryRow).id;
        const groupsOf = (id: string) => world.store.phraseGroups.list().filter((group) => group.story_id === id);

        // The create mints the catalog on this pipeline (R1): the five groups, unwritten, plus the one
        // Overview row that composes them.
        expect(groupsOf(storyId).map((group) => group.key)).toEqual(['premise', 'promise', 'theme', 'tone', 'ending']);
        expect(world.store.phrases.list().filter((row) => row.story_id === storyId)).toHaveLength(1);

        // Two accepted passes: five `latest` group revisions at number 2 and five `archived` at number 1.
        // These are the rows T4's probe measured SURVIVING the delete (`phrases=1 phrase_groups=5`).
        for (const pass of ['first', 'second']) {
            installGroupRevisions(
                world.store,
                world.store.stories.require(storyId),
                groupsOf(storyId).map((group) => ({ group, content: `${group.key}: the ${pass} text.` })),
                AUTHOR_ATTR,
                { runRef: `run_${pass}`, workItemRef: `wi_draft_groups_${pass}_1` }
            );
        }

        expect(
            world.store.groupRevisions
                .list()
                .filter((row) => row.story_id === storyId)
                .map((row) => `${row.number}:${row.state}`)
                .sort()
        ).toEqual([
            '1:archived',
            '1:archived',
            '1:archived',
            '1:archived',
            '1:archived',
            '2:latest',
            '2:latest',
            '2:latest',
            '2:latest',
            '2:latest'
        ]);

        // An open defect scoped to two groups (R3) and the fix task it opened — phrase-scoped rows the
        // Author's rail shows, riding on ids the delete is about to remove.
        const seededFinding = seedFinding(world.store, storyId, {
            target_ref: 'summary_0',
            criterion_ref: 'C-14',
            cost: 'major',
            state: 'confirmed',
            title: 'the Overview keeps a coastline the Seed drowned',
            detail: 'summary_0 promise says the valley is dry; the Seed says it is a reservoir',
            fingerprint: 'C-14|summary_0|coastline'
        });
        const finding = world.store.findings.update(
            seededFinding.id,
            { group_refs: [groupsOf(storyId)[0]!.id, groupsOf(storyId)[1]!.id] },
            { run_ref: null, author: true, why: 'seed: the defect is scoped to two groups (R3)' },
            [{ id: seededFinding.id, rev: seededFinding.rev }]
        );

        seedTask(world.store, storyId, {
            kind: 'fix',
            title: 'fix finding_0: drown the coastline',
            detail: `C-14 on summary_0 · ${finding.id}`,
            owner_role: 'writer',
            finding_ref: finding.id
        });

        // The Author has ALREADY locked the phase (L-7). P1 gives the delete no lock exemption: a locked
        // Summary is part of the book, and the whole book goes.
        const summary = world.store.summaries.require('summary_0');
        const lockedStory = world.store.stories.require(storyId);

        world.store.summaries.update(
            summary.id,
            { locked: true },
            { run_ref: null, author: true, why: 'seed: the Author signed the Summary off (L-7)' },
            [{ id: summary.id, rev: summary.rev }]
        );
        world.store.stories.update(
            lockedStory.id,
            { summary_locked: true, status: 'pending', pending_kind: 'phase_signoff' },
            { run_ref: null, author: true, why: 'seed: the phase is signed off (L-7, L-29)' },
            [{ id: lockedStory.id, rev: lockedStory.rev }]
        );

        // PHRASE ② (T-W6) — the second phrase on the SAME book: a started row with its copied Seed, the
        // chapter entries its accepted structure pass materialized, and one row of those entries' history.
        // `plotline_briefs` is the collection the delete had NO line for: the rows stayed in the book
        // naming a `story_id` (and a `phrase_id`) the store no longer held — the same leak the three
        // Summary collections above had before the 2026-11-24 hardening closed it.
        const storyRowA = world.store.stories.require(storyId);
        const started = startPlotlinesPhrase(
            world.store,
            storyRowA,
            'Premise: a mapmaker returns. Promise: the chart reconciles. Ending: she floods the valley.',
            AUTHOR_ATTR
        );
        const structure = acceptPlotlineBrief(
            world.store,
            world.store.stories.require(storyId),
            createPlotlineBrief(
                world.store,
                world.store.stories.require(storyId),
                started.phrase,
                { chapter_count: 2, chapters: [{ order: 1, seed: 'the chart is wrong' }, { order: 2, seed: 'the valley pays' }] },
                AUTHOR_ATTR
            ),
            AUTHOR_ATTR
        );
        const entryHistory = world.store.groupRevisions.create(
            {
                story_id: storyId,
                phrase_id: started.phrase.id,
                group_id: structure.groups[0]!.id,
                group_key: structure.groups[0]!.key,
                number: 1,
                content: 'Must happen: the chart is wrong.',
                state: 'latest'
            },
            { run_ref: 'run_plotlines', why: 'seed: one chapter-entry revision the delete must remove (T-W6)' }
        );

        // The pre-state: two phrases on one book, the chapter entries under the Plotlines row, and one
        // brief the Author accepted. Each of these is a row the Story owns (P1).
        expect(
            world.store.phrases.list().filter((row) => row.story_id === storyId).map((row) => row.key).sort()
        ).toEqual(['plotlines', 'summary']);
        expect(structure.groups.map((group) => group.key)).toEqual(['chapter_1', 'chapter_2']);
        expect(world.store.plotlineBriefs.list().filter((row) => row.phrase_id === started.phrase.id)).toHaveLength(1);

        // Story B: another group-managed book, one install deep. The delete is scoped by `story_id`, so
        // B's addresses, texts and history keep their exact values.
        const createdB = await call(world.app, 'POST', '/stories', {
            title: 'The Signalman',
            idea: 'A signalman answers a letter written after his death.',
            chapter_count: 1,
            summary_mode: 'groups'
        });
        const storyB = (createdB.body as StoryRow).id;

        installGroupRevisions(
            world.store,
            world.store.stories.require(storyB),
            groupsOf(storyB).map((group) => ({ group, content: `${group.key}: B keeps this text.` })),
            AUTHOR_ATTR,
            { runRef: 'run_b', workItemRef: 'wi_draft_groups_b_1' }
        );

        const rowShape = (rows: { id: string; content: string; revision: number }[]) =>
            rows.map((row) => `${row.id}:${row.content}:${row.revision}`);
        const beforeB = rowShape(groupsOf(storyB));
        const historyB = world.store.groupRevisions.list().filter((row) => row.story_id === storyB);

        const deleted = await call(world.app, 'DELETE', `/stories/${storyId}`);

        expect(deleted).toEqual({ status: 200, body: { deleted: storyId } });

        // The three Summary Phrase collections go in the same commit as the §4 rows (P1): nothing may
        // keep a `story_id` the store no longer holds — not the Overview, not the Author-imported
        // groups, not one archived revision of a scrapped pass.
        expect(world.store.phrases.list().filter((row) => row.story_id === storyId)).toEqual([]);
        expect(world.store.phraseGroups.list().filter((row) => row.story_id === storyId)).toEqual([]);
        expect(world.store.groupRevisions.list().filter((row) => row.story_id === storyId)).toEqual([]);

        // And the rows that JOIN on those ids go with them (findings/tasks ride the §4 deletes).
        expect(world.store.findings.list().filter((row) => row.story_id === storyId)).toEqual([]);
        expect(world.store.tasks.list().filter((row) => row.story_id === storyId)).toEqual([]);

        // PHRASE ② (T-W6) — the fourth collection goes in the SAME commit. Asserted per phrase, not only
        // per story, so a delete that took the Summary rows and left the Plotlines phrase standing cannot
        // pass: the brief row is the one the `phrases`/`phrase_groups`/`group_revisions` deletes above
        // never reached, and its `phrase_id` would name a row this commit deleted.
        expect(world.store.plotlineBriefs.list().filter((row) => row.story_id === storyId)).toEqual([]);
        expect(world.store.plotlineBriefs.list().filter((row) => row.phrase_id === started.phrase.id)).toEqual([]);
        expect(
            world.store.phraseGroups.list().filter((group) => group.phrase_id === started.phrase.id)
        ).toEqual([]);
        expect(
            world.store.groupRevisions.list().filter((row) => row.phrase_id === started.phrase.id)
        ).toEqual([]);
        // The rows BY ID, so a purge that deleted the Summary's rows and kept Phrase ②'s cannot pass on a
        // story_id filter that happens to be empty.
        expect(world.store.phrases.get(started.phrase.id)).toBeUndefined();
        expect(world.store.plotlineBriefs.get(structure.brief.id)).toBeUndefined();
        expect(world.store.groupRevisions.get(entryHistory.id)).toBeUndefined();
        expect(world.store.phraseGroups.get(structure.groups[0]!.id)).toBeUndefined();

        // Story B is untouched by any of it — same ids, same texts, same five revisions.
        expect(rowShape(groupsOf(storyB))).toEqual(beforeB);
        expect(world.store.groupRevisions.list().filter((row) => row.story_id === storyB).length).toBe(
            historyB.length
        );
        expect(world.store.phrases.list().filter((row) => row.story_id === storyB)).toHaveLength(1);
    });

    it('keeps the global template catalogue: a template is the Author’s, not the Story’s', async () => {
        const world = makeApp();
        const created = await call(world.app, 'POST', '/stories', {
            title: 'First Light',
            idea: 'A keeper inherits a lamp that has never been lit.',
            chapter_count: 1
        });
        const storyId = (created.body as StoryRow).id;
        const before = world.store.templates.list().map((row) => row.name);

        await call(world.app, 'DELETE', `/stories/${storyId}`);

        expect(world.store.templates.list().map((row) => row.name)).toEqual(before);
    });

    it('answers 404 for a Story that is not in the book, and 404 for a second delete', async () => {
        const world = makeApp();
        const created = await call(world.app, 'POST', '/stories', {
            title: 'Quiet Orchard',
            idea: 'A fruit grower hears the trees answer a question nobody asked.',
            chapter_count: 1
        });
        const storyId = (created.body as StoryRow).id;

        expect((await call(world.app, 'DELETE', '/stories/story_999')).status).toBe(404);
        expect((await call(world.app, 'DELETE', `/stories/${storyId}`)).status).toBe(200);
        expect((await call(world.app, 'DELETE', `/stories/${storyId}`)).status).toBe(404);
    });
});
