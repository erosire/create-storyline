// The Summary Phrase's HTTP surface (R1, R2, R3, R6) and the two legacy routes that must REFUSE a
// group-managed book. Same harness as `revision-routes.test.ts`: real store, real engine, real Hono
// request — the 400s and 409s are product copy an Author reads, so they are asserted verbatim.
//
// WHY THE VIEW IS ASSERTED AS A WHOLE: `GET /stories/:id/phrases` is the dashboard's only read of the
// group model — the rail's "which group still owes what" is computed here, not in the client. Pinning
// the composed Overview, the per-group history, the R3 resolution arrays and the mirror report in one
// object is what proves the projection agrees with the rows.
//
// THE IDS: a route-created Story mints its phrase rows with `newRecordUid` (persist.ts explains why
// these ids are addresses rather than counter labels), so the ids come out of the store and the
// expectations name them through those reads. The counter-minted rows (`summary_0`, `group_revision_0`,
// `finding_0`) are pinned literally.
//
// THE JOURNAL READS use `slice(-1)[0]` rather than `.at(-1)`: the package's tsconfig lib predates ES2022
// (the same rule `run/brief.ts:437` and `run/catalogue.ts:249` record).
import { describe, expect, it } from 'vitest';
import { CriteriaEngine } from '../criteria/engine';
import { DigestBuilder } from '../digest/digest';
import { MockChatClient, msg } from '../llm/mock';
import { LoopEngine } from '../loop/engine';
import { RunExecutor } from '../run/executor';
import { MockToolRuntime } from '../run/mock';
import { Store } from '../store/store';
import { isRecordUid } from '../store/persist';
import { buildStorylineRuntime } from './server';
import { groupCheckSeatKey } from '../phrase/exclusion';
import { groupRevisionVector, groupVectorHash, installGroupRevisions } from '../phrase/revisions';
import { stampCleanRevisions } from '../phrase/reviewed';
import { AUTHOR_ATTR } from '../run/mock';
import type { Hono } from 'hono';
import type { Cost, Finding, Story } from '../../shared/types';
import type { StoryRow } from '../../dashboard/api';
import type { LoopEngineConfig } from '../loop/types';

interface TestApp {
    app: Hono;
    store: Store;
}

/** The shipped wiring with the loop's two doubles and the sweep timer off. */
function makeApp(): TestApp {
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

const call = async (app: Hono, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Reply> => {
    const response = await app.request(`http://localhost/v1/storyline${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    });

    const text = await response.text();

    return { status: response.status, body: text.length === 0 ? undefined : JSON.parse(text) };
};

const errorOf = (reply: Reply): string => (reply.body as { error: string }).error;
const viewOf = (reply: Reply): Record<string, unknown> => reply.body as Record<string, unknown>;
const reviewOf = (reply: Reply): Record<string, unknown> => viewOf(reply).review as Record<string, unknown>;
const groupsOf = (reply: Reply): Array<Record<string, unknown>> => viewOf(reply).groups as Array<Record<string, unknown>>;

/** The rail's per-group summary — the five columns this projection exists to fill. */
const groupShape = (reply: Reply) =>
    groupsOf(reply).map((group) => [
        group.key,
        group.title,
        group.order,
        group.revision,
        group.content,
        group.previous_content,
        group.updated_by,
        group.history,
        group.owed_by_findings
    ]);

/**
 * The Reviewed Summary block's per-group row (D-67) — the columns the rail draws beside each section:
 * which revision the crew stands behind, which number the group is actually on, and why they differ.
 */
const reviewedShape = (reply: Reply) =>
    (viewOf(reply).reviewed as { groups: Array<Record<string, unknown>> }).groups.map((group) => [
        group.key,
        group.selected_revision,
        group.selected_id,
        group.clean_run_ref,
        group.latest_revision,
        group.superseded,
        group.issues_open,
        group.gap,
        group.scores
    ]);

/**
 * The whole view with its two row lists normalised to the pinned columns above (`groups` through
 * `groupShape`, the reviewed block's rows through `reviewedShape`, since a group id is a minted uuid an
 * expectation cannot name). Every other key, the reviewed block's scalar fields included, stays exactly
 * as the projection wrote it.
 */
const viewShape = (reply: Reply) => ({
    ...viewOf(reply),
    groups: groupShape(reply),
    reviewed: { ...(viewOf(reply).reviewed as Record<string, unknown>), groups: reviewedShape(reply) }
});

/**
 * A Story on the NEW pipeline (the create route's default) plus the legacy prose a legacy book would
 * have. The prose is written straight to the store because §8's `editSummary` is the crew's path and
 * this file is about the phrase routes; the row is otherwise real.
 */
async function seedGroupStory(summaryMode?: 'groups' | 'sampling'): Promise<TestApp & { story: Story }> {
    const world = makeApp();
    const reply = await call(world.app, 'POST', '/stories', {
        title: 'The Return',
        idea: 'A cartographer finds the valley she mapped is under water.',
        chapter_count: 2,
        ...(summaryMode === undefined ? {} : { summary_mode: summaryMode })
    });

    const story = world.store.stories.require((reply.body as StoryRow).id);

    return { ...world, story };
}

/** The legacy prose §4.2's record carries, written as an Author left it. */
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

describe('POST /stories: the Summary switch is a setting on the Story (R1, R6)', () => {
    it('opens the five groups in the create commit, and the view reads them as unwritten', async () => {
        const world = await seedGroupStory();

        expect(world.story.summary_mode).toBe('groups');
        // R1: the catalog exists IN the book from the first moment the Story does.
        expect(world.store.phrases.list()).toHaveLength(1);
        expect(world.store.phraseGroups.list().map((group) => group.key)).toEqual([
            'premise',
            'promise',
            'theme',
            'tone',
            'ending'
        ]);

        const phraseId = world.store.phrases.list()[0].id;
        const groupIds = world.store.phraseGroups.list().map((group) => group.id);

        expect(isRecordUid(phraseId)).toBe(true);
        expect(groupIds.every(isRecordUid)).toBe(true);

        const reply = await call(world.app, 'GET', '/stories/story_0/phrases');
        const view = viewOf(reply);

        expect(Object.keys(view)).toEqual([
            'story_id',
            'mode',
            'phrase_id',
            'revision',
            'overview',
            'groups',
            'findings',
            'tasks',
            'review',
            // D-67/D-68: the Reviewed Summary block is ALWAYS present, empty for a book nobody has
            // reviewed yet — a client must not have to feature-detect it.
            'reviewed'
        ]);
        // The group rows carry minted uuid addresses (`persist.ts` explains why a group id is an
        // address), so the rows are normalised to the nine columns the rail reads — each one pinned —
        // and every other key of the projection is asserted as the whole object it is.
        expect(viewShape(reply)).toEqual({
            story_id: 'story_0',
            mode: 'groups',
            phrase_id: phraseId,
            revision: 0,
            overview: '',
            groups: [
                ['premise', 'Premise', 1, 0, '', '', null, [], []],
                ['promise', 'Promise', 2, 0, '', '', null, [], []],
                ['theme', 'Theme', 3, 0, '', '', null, [], []],
                ['tone', 'Tone', 4, 0, '', '', null, [], []],
                ['ending', 'Ending', 5, 0, '', '', null, [], []]
            ],
            findings: [],
            tasks: [],
            // D-67: the Reviewed Summary exists from the first moment the book does, and it is EMPTY —
            // `pending` with five `unwritten` gaps, no vector, and no choice. The rail's Choose button is
            // grey because there is nothing reviewable, not because the projection failed.
            reviewed: {
                state: 'pending',
                complete: false,
                vector: {},
                vector_hash: groupVectorHash({}),
                overview: '',
                groups: [
                    ['premise', null, null, null, 0, false, false, 'unwritten', []],
                    ['promise', null, null, null, 0, false, false, 'unwritten', []],
                    ['theme', null, null, null, 0, false, false, 'unwritten', []],
                    ['tone', null, null, null, 0, false, false, 'unwritten', []],
                    ['ending', null, null, null, 0, false, false, 'unwritten', []]
                ],
                chosen: null,
                stale: false,
                blocking_issues: [],
                writer_busy: false
            },
            review: {
                mode: 'groups',
                unwritten_groups: ['premise', 'promise', 'theme', 'tone', 'ending'],
                written_groups: 0,
                vector: Object.fromEntries(groupIds.map((id) => [id, 0])),
                vector_hash: groupVectorHash(Object.fromEntries(groupIds.map((id) => [id, 0]))),
                // The Critic dial is the review seat count, unchanged by the redesign.
                review_seats: 5,
                reviews_on_current_vector: 0,
                deep_reviews_on_current_vector: 0,
                open_findings: 0,
                blocking_findings: 0,
                open_tasks: 0,
                mirror: {
                    summary_id: 'summary_0',
                    in_sync: true,
                    locked: false,
                    fields: ['premise', 'promise', 'theme', 'tone', 'ending']
                }
            }
        });
        expect(view.groups).toHaveLength(5);
    });

    it('keeps a book that asks for the old pipeline on it, with no catalog rows to read', async () => {
        const world = await seedGroupStory('sampling');

        expect(world.story.summary_mode).toBe('sampling');
        expect(world.store.phrases.list()).toEqual([]);

        const reply = await call(world.app, 'GET', '/stories/story_0/phrases');

        // R6: readable, not migrated. A sampling book answers the SAME route with its empty group set
        // rather than a 404, so the rail shows it the old panel.
        expect(viewOf(reply)).toEqual({
            story_id: 'story_0',
            mode: 'sampling',
            phrase_id: null,
            revision: 0,
            overview: '',
            groups: [],
            findings: [],
            tasks: [],
            review: {
                mode: 'sampling',
                unwritten_groups: [],
                written_groups: 0,
                vector: {},
                vector_hash: groupVectorHash({}),
                review_seats: 5,
                reviews_on_current_vector: 0,
                deep_reviews_on_current_vector: 0,
                open_findings: 0,
                blocking_findings: 0,
                open_tasks: 0,
                mirror: {
                    summary_id: 'summary_0',
                    // The five mirror fields are unset on this row and the five groups are absent, so
                    // the mirror agrees by having nothing to disagree about.
                    in_sync: true,
                    locked: false,
                    fields: ['premise', 'promise', 'theme', 'tone', 'ending']
                }
            },
            // D-67/D-68: the reviewed block is present here too, and says the same nothing — a sampling
            // book has no groups, so it has no clean selection and nothing to choose.
            reviewed: {
                state: 'pending',
                complete: false,
                vector: {},
                vector_hash: groupVectorHash({}),
                overview: '',
                groups: [],
                chosen: null,
                stale: false,
                blocking_issues: [],
                writer_busy: false
            }
        });
    });

    it('refuses a word that is not one of the two pipelines, because a typo books work nobody asked for', async () => {
        const world = makeApp();
        const reply = await call(world.app, 'POST', '/stories', {
            title: 'The Return',
            idea: 'A cartographer finds the valley she mapped is under water.',
            summary_mode: 'group'
        });

        expect(reply.status).toBe(400);
        expect(errorOf(reply)).toBe(
            "`summary_mode` must be `'groups'` (the five Summary groups, revised one batch at a time) or `'sampling'` (the whole-Summary sampler)."
        );
        expect(world.store.stories.list()).toEqual([]);
    });

    it('a legacy Story row with no switch reads as sampling, and nothing migrated it', async () => {
        const world = await seedGroupStory('sampling');

        // R6's read-only promise: GET changes nothing.
        const before = world.store.journal.length;

        await call(world.app, 'GET', '/stories/story_0/phrases');

        expect(world.store.journal).toHaveLength(before);
        expect(world.store.stories.require('story_0').summary_mode).toBe('sampling');
        expect(world.store.phrases.list()).toEqual([]);
    });
});

describe('POST /stories/:id/phrases/import: one explicit step turns flat prose into groups (R6)', () => {
    it('seeds five revisions from the Author’s own prose, switches the Story, and leaves the Summary row alone', async () => {
        const world = await seedGroupStory('sampling');

        writeLegacyProse(world.store);

        const reply = await call(world.app, 'POST', '/stories/story_0/phrases/import');

        expect(reply.status).toBe(200);

        const groupIds = world.store.phraseGroups.list().map((group) => group.id);
        const body = viewOf(reply);

        // Every key the client's contract names, and the payload of each one pinned.
        expect(Object.keys(body)).toEqual(['story_id', 'phrase_id', 'imported', 'seeded', 'story_switched', 'view']);
        expect(body.story_id).toBe('story_0');
        expect(body.phrase_id).toBe(world.store.phrases.list()[0].id);
        expect(body.imported).toBe(5);
        expect(body.seeded).toEqual(
            groupIds.map((group_id, index) => ({
                group_id,
                revision_id: `group_revision_${index}`,
                number: 1,
                group_key: ['premise', 'promise', 'theme', 'tone', 'ending'][index]
            }))
        );
        expect(body.story_switched).toBe(true);

        // The view the route returned in the SAME response is the one a fresh GET answers.
        expect(body.view).toEqual(viewOf(await call(world.app, 'GET', '/stories/story_0/phrases')));

        const view = viewOf(await call(world.app, 'GET', '/stories/story_0/phrases'));

        expect(view.mode).toBe('groups');
        expect(view.revision).toBe(1);
        // The Overview composes the Author's own sentences, in catalog order.
        expect(view.overview).toBe(
            [
                '## Premise',
                'A return to a mapped valley that no longer matches the map.',
                '',
                '## Promise',
                'The map and the territory reconcile in the last chapter.',
                '',
                '## Theme',
                'Memory against measurement.',
                '',
                '## Tone',
                'Plain, cold, precise.',
                '',
                '## Ending',
                'She floods the valley on purpose.'
            ].join('\n')
        );
        // The import's direction is legacy → groups. The mirror's direction is the install's job, so the
        // Summary row still holds exactly what the Author wrote.
        expect(world.store.summaries.require('summary_0').premise).toBe(
            'A return to a mapped valley that no longer matches the map.'
        );
        expect(world.store.stories.require('story_0').summary_mode).toBe('groups');
        expect(world.store.groupRevisions.list().map((row) => [row.id, row.group_key, row.number, row.state, row.run_ref, row.work_item_ref])).toEqual(
            [
                ['group_revision_0', 'premise', 1, 'latest', null, 'phrase_import'],
                ['group_revision_1', 'promise', 1, 'latest', null, 'phrase_import'],
                ['group_revision_2', 'theme', 1, 'latest', null, 'phrase_import'],
                ['group_revision_3', 'tone', 1, 'latest', null, 'phrase_import'],
                ['group_revision_4', 'ending', 1, 'latest', null, 'phrase_import']
            ]
        );
        expect((view.review as Record<string, unknown>).mirror).toEqual({
            summary_id: 'summary_0',
            in_sync: true,
            locked: false,
            fields: ['premise', 'promise', 'theme', 'tone', 'ending']
        });
    });

    it('is idempotent: a second press writes nothing and switches nothing', async () => {
        const world = await seedGroupStory('sampling');

        writeLegacyProse(world.store);

        const first = await call(world.app, 'POST', '/stories/story_0/phrases/import');
        const events = world.store.journal.length;

        expect(first.status).toBe(200);

        const again = await call(world.app, 'POST', '/stories/story_0/phrases/import');

        expect(viewOf(again).imported).toBe(0);
        expect(viewOf(again).story_switched).toBe(false);
        expect(viewOf(again).seeded).toEqual([]);
        expect(world.store.journal).toHaveLength(events);
        expect(world.store.groupRevisions.list()).toHaveLength(5);
    });

    it('a sampling book that has no prose to import still switches, and seeds nothing', async () => {
        const world = await seedGroupStory('sampling');
        const reply = await call(world.app, 'POST', '/stories/story_0/phrases/import');

        expect(reply.status).toBe(200);
        expect(viewOf(reply).imported).toBe(0);
        expect(viewOf(reply).story_switched).toBe(true);
        expect(world.store.groupRevisions.list()).toEqual([]);
        expect(world.store.stories.require('story_0').summary_mode).toBe('groups');
    });

    it('404s a Story that is not in the book, and writes nothing', async () => {
        const world = await seedGroupStory();
        const reply = await call(world.app, 'POST', '/stories/nope_9/phrases/import');

        expect(reply.status).toBe(404);
        expect(errorOf(reply)).toBe('no story named nope_9 is in the book (P1: the store is the memory)');
        expect(world.store.phrases.list()).toHaveLength(1);
    });
});

describe('POST /stories/:id/phrases/groups/:groupId/revise: the Author rewrites ONE group (R2, R6)', () => {
    it('installs the next revision, archives the one it replaces, and mirrors only the field it wrote', async () => {
        const world = await seedGroupStory();

        writeLegacyProse(world.store);
        await call(world.app, 'POST', '/stories/story_0/phrases/import');

        const premiseId = world.store.phraseGroups.list().find((group) => group.key === 'premise')!.id;
        const reply = await call(world.app, 'POST', `/stories/story_0/phrases/groups/${premiseId}/revise`, {
            content: '  A return, on foot, into a valley the map still shows as dry.  ',
            note: 'the map is the antagonist now'
        });

        expect(reply.status).toBe(200);

        const body = viewOf(reply);

        expect(Object.keys(body)).toEqual(['story_id', 'phrase_id', 'revision', 'installed', 'archived', 'mirror', 'view']);
        expect(body.story_id).toBe('story_0');
        expect(body.phrase_id).toBe(world.store.phrases.list()[0].id);
        // The Overview's own revision moves with every install, whoever wrote the text.
        expect(body.revision).toBe(2);
        expect(body.installed).toEqual([
            { group_id: premiseId, group_key: 'premise', revision_id: 'group_revision_5', number: 2 }
        ]);
        expect(body.archived).toEqual([
            { group_id: premiseId, group_key: 'premise', revision_id: 'group_revision_0', number: 1 }
        ]);
        expect(body.mirror).toEqual({ summary_id: 'summary_0', fields: ['premise'], written: true });
        expect(body.view).toEqual(viewOf(await call(world.app, 'GET', '/stories/story_0/phrases')));

        // The trimmed text is what lands, on the row and in the mirror.
        expect(world.store.phraseGroups.require(premiseId).content).toBe(
            'A return, on foot, into a valley the map still shows as dry.'
        );
        expect(world.store.phraseGroups.require(premiseId).revision).toBe(2);
        // `updated_by: null` is the honest attribution: no run wrote this.
        expect(world.store.phraseGroups.require(premiseId).updated_by).toBeNull();
        expect(world.store.groupRevisions.require('group_revision_0').state).toBe('archived');
        expect(world.store.groupRevisions.require('group_revision_5').state).toBe('latest');

        // R2: the four groups the Author did not touch keep their own revision lines.
        expect(world.store.phraseGroups.list().map((group) => [group.key, group.revision])).toEqual([
            ['premise', 2],
            ['promise', 1],
            ['theme', 1],
            ['tone', 1],
            ['ending', 1]
        ]);

        // R6: the mirror moves for the one field that changed, and `world_rules` is never touched.
        const summary = world.store.summaries.require('summary_0');

        expect(summary.premise).toBe('A return, on foot, into a valley the map still shows as dry.');
        expect(summary.promise).toBe('The map and the territory reconcile in the last chapter.');
        expect(summary.world_rules).toBeUndefined();

        // The hand edit claims NOTHING: a hand edit may not close a finding on R3's evidence rule.
        expect(world.store.groupRevisions.require('group_revision_5').finding_refs).toBeUndefined();
        expect(world.store.groupRevisions.require('group_revision_5').task_refs).toBeUndefined();
        expect(world.store.groupRevisions.require('group_revision_5').run_ref).toBeNull();

        // P11: the journal names the route, the Story, and the Author's own note.
        expect(
            world.store.journal
                .filter((event) => event.collection === 'group_revisions' && event.op === 'create')
                .slice(-1)[0]?.attribution.why
        ).toBe(
            'the Author used POST /stories/:id/phrases/groups/:groupId/revise on story_0 — premise was rewritten by hand: the map is the antagonist now (R2) (§10 dashboard write)'
        );

        // And the rail sees the history: the current text, the superseded one, and the composed Overview.
        const view = groupsOf(await call(world.app, 'GET', '/stories/story_0/phrases'));

        expect(view[0].previous_content).toBe(
            'A return to a mapped valley that no longer matches the map.'
        );

        expect(view[0].history).toEqual([
            {
                id: 'group_revision_5',
                number: 2,
                state: 'latest',
                at: world.store.groupRevisions.require('group_revision_5').created_at,
                run_ref: null,
                finding_refs: [],
                task_refs: [],
                // D-67: every revision row carries its Clean stamp, so the rail can mark the text a
                // cross-group pass passed. A hand edit has never sat through one.
                clean: false,
                clean_run_ref: null,
                // The rail shows a length, not the body: 60 is the Author's new sentence and 59 the
                // legacy prose the import seeded — the two texts this group has held.
                chars: 60
            },
            {
                id: 'group_revision_0',
                number: 1,
                state: 'archived',
                at: world.store.groupRevisions.require('group_revision_0').created_at,
                run_ref: null,
                finding_refs: [],
                task_refs: [],
                clean: false,
                clean_run_ref: null,
                chars: 59
            }
        ]);
    });

    it('sends only the immediately previous revision as the diff body, never the older history', async () => {
        const world = await seedGroupStory();

        writeLegacyProse(world.store);
        await call(world.app, 'POST', '/stories/story_0/phrases/import');

        const premiseId = world.store.phraseGroups.list().find((group) => group.key === 'premise')!.id;
        const firstRevision = 'A return, on foot, into a valley the map still shows as dry.';
        const secondRevision = 'A return, on foot, into a valley the map has not finished drawing.';

        await call(world.app, 'POST', `/stories/story_0/phrases/groups/${premiseId}/revise`, {
            content: firstRevision
        });
        await call(world.app, 'POST', `/stories/story_0/phrases/groups/${premiseId}/revise`, {
            content: secondRevision
        });

        const premise = groupsOf(await call(world.app, 'GET', '/stories/story_0/phrases')).find(
            (group) => group.key === 'premise'
        )!;

        expect(premise.content).toBe(secondRevision);
        // U3's one comparison: the text the latest revision replaced. The legacy text below it (revision 1)
        // is history metadata only, so the diff can never turn into a cumulative comparison.
        expect(premise.previous_content).toBe(firstRevision);
        expect(premise.history).toEqual([
            expect.objectContaining({ number: 3, state: 'latest' }),
            expect.objectContaining({ number: 2, state: 'archived' }),
            expect.objectContaining({ number: 1, state: 'archived' })
        ]);
        expect(JSON.stringify(premise)).not.toContain(
            'A return to a mapped valley that no longer matches the map.'
        );
    });

    it('refuses an empty text, an unknown group, and a book that has no groups yet', async () => {
        const world = await seedGroupStory();
        const premiseId = world.store.phraseGroups.list().find((group) => group.key === 'premise')!.id;
        const events = world.store.journal.length;

        const empty = await call(world.app, 'POST', `/stories/story_0/phrases/groups/${premiseId}/revise`, {
            content: '   '
        });

        expect(empty.status).toBe(400);
        expect(errorOf(empty)).toBe(
            "`content` is the group's new text and must be a non-empty string (R2: an empty group text is a refusal, not a revision)."
        );

        const missing = await call(world.app, 'POST', '/stories/story_0/phrases/groups/group_9/revise', {
            content: 'text'
        });

        expect(missing.status).toBe(404);
        expect(errorOf(missing)).toBe('no phrase group named group_9 is in the book (P1: the store is the memory)');

        const legacy = await seedGroupStory('sampling');
        const refused = await call(legacy.app, 'POST', '/stories/story_0/phrases/groups/whatever/revise', {
            content: 'text'
        });

        expect(refused.status).toBe(409);
        expect(errorOf(refused)).toBe(
            "this Story's Summary is still written as one text (no group catalog); POST /stories/story_0/phrases/import turns the flat Summary into groups first (R6)."
        );
        expect(legacy.store.groupRevisions.list()).toEqual([]);
        expect(world.store.journal).toHaveLength(events);
    });
});

describe('the view reports the R3 debt per group and the mirror honestly (R3, R6)', () => {
    /** A finding whose text names two groups, filed the way the tool layer files it. */
    function fileCrossGroupFinding(store: Store): Finding {
        const [promise, ending] = ['promise', 'ending'].map(
            (key) => store.phraseGroups.list().find((group) => group.key === key)!.id
        );

        return store.findings.create(
            {
                story_id: 'story_0',
                target_ref: 'summary_0',
                criterion_ref: 'C-14',
                title: 'the Ending does not keep the Promise',
                detail: 'The Ending resolves a debt the Promise never opens.',
                evidence: 'the Ending paragraph contradicts the Promise paragraph',
                cost: 'critical' as Cost,
                fingerprint: 'C-14|summary_0',
                state: 'approved',
                seen_count: 1,
                group_refs: [ending, promise]
            },
            { run_ref: null, author: true, why: 'seed: a cross-group finding (R3)' }
        );
    }

    it('names the groups a finding still owes, and clears them as each group answers', async () => {
        const world = await seedGroupStory();

        writeLegacyProse(world.store);
        await call(world.app, 'POST', '/stories/story_0/phrases/import');

        const finding = fileCrossGroupFinding(world.store);

        expect(finding.group_refs).toHaveLength(2);

        const before = await call(world.app, 'GET', '/stories/story_0/phrases');
        const groupIds = world.store.phraseGroups.list().map((group) => group.id);

        expect(viewOf(before).findings).toEqual([
            {
                id: 'finding_0',
                title: 'the Ending does not keep the Promise',
                cost: 'critical',
                // D-33b (T5): the claim type is part of the rail's row, defaulted on the way out — this
                // finding was written with no `kind`, and the projection reads that as `issue`. No badge
                // is drawn from it; the field is data the read carries.
                kind: 'issue',
                state: 'approved',
                seen_count: 1,
                group_refs: [groupIds[4], groupIds[1]],
                unscoped: false,
                targeted: [groupIds[1], groupIds[4]],
                resolved: [],
                missing: [groupIds[1], groupIds[4]],
                resolved_all: false
            }
        ]);
        // The rail's per-group debt, transposed from the resolution rather than recomputed client-side.
        expect(groupsOf(before).map((group) => group.owed_by_findings)).toEqual([[], ['finding_0'], [], [], ['finding_0']]);
        expect(reviewOf(before).open_findings).toBe(1);
        expect(reviewOf(before).blocking_findings).toBe(1);

        // The Promise rewrite claims the finding; the rail must still show Ending in debt.
        const promiseId = groupIds[1];
        const revised = await call(world.app, 'POST', `/stories/story_0/phrases/groups/${promiseId}/revise`, {
            content: 'The book undertakes a reconciliation the ending must pay.'
        });

        // The revise route answers with its install report plus the fresh view nested under `view`,
        // so the rail's findings come off that projection rather than off the top level.
        expect((viewOf(revised).view as Record<string, unknown>).findings).toEqual([
            {
                id: 'finding_0',
                title: 'the Ending does not keep the Promise',
                cost: 'critical',
                // The same defaulting read as the pin above (D-33b): the row is unchanged by the rewrite.
                kind: 'issue',
                state: 'approved',
                seen_count: 1,
                group_refs: [groupIds[4], groupIds[1]],
                unscoped: false,
                targeted: [groupIds[1], groupIds[4]],
                // A hand edit claims nothing, so NOTHING is resolved yet (R3's evidence rule).
                resolved: [],
                missing: [groupIds[1], groupIds[4]],
                resolved_all: false
            }
        ]);

        const after = await call(world.app, 'GET', '/stories/story_0/phrases');

        expect(reviewOf(after).open_findings).toBe(1);
        expect(reviewOf(after).written_groups).toBe(5);
        // The mirror moved for one field only, so the rail still reports it in sync.
        expect(reviewOf(after).mirror).toEqual({
            summary_id: 'summary_0',
            in_sync: true,
            locked: false,
            fields: ['premise', 'promise', 'theme', 'tone', 'ending']
        });
    });

    it('says so when the mirror has drifted (a locked Summary is the Author’s choice, not a bug)', async () => {
        const world = await seedGroupStory();

        writeLegacyProse(world.store);
        await call(world.app, 'POST', '/stories/story_0/phrases/import');

        const summary = world.store.summaries.require('summary_0');

        // L-7a: the lock is the Author's declaration, and the mirror waits for them to lift it.
        world.store.summaries.update(
            summary.id,
            { locked: true },
            { run_ref: null, author: true, why: 'seed: the Author locked the Summary (L-7a)' },
            [{ id: summary.id, rev: summary.rev }]
        );

        const premiseId = world.store.phraseGroups.list().find((group) => group.key === 'premise')!.id;
        const revised = await call(world.app, 'POST', `/stories/story_0/phrases/groups/${premiseId}/revise`, {
            content: 'A return, on foot, into a valley the map still shows as dry.'
        });

        // The install still lands; the mirror reports WHY it waited (L-7a is the Author's call).
        expect(viewOf(revised).mirror).toEqual({
            summary_id: 'summary_0',
            fields: [],
            written: false,
            reason: 'locked'
        });

        const after = reviewOf(await call(world.app, 'GET', '/stories/story_0/phrases'));

        expect(after.mirror).toEqual({
            summary_id: 'summary_0',
            // The group row is ahead of the legacy field: the rail shows that instead of hiding it.
            in_sync: false,
            locked: true,
            fields: ['premise', 'promise', 'theme', 'tone', 'ending']
        });
    });

    it('says which kind of claim a rail row is, so a proposal reads as one (D-33b)', async () => {
        const world = await seedGroupStory();

        writeLegacyProse(world.store);
        await call(world.app, 'POST', '/stories/story_0/phrases/import');

        // A PROPOSAL, filed the way §8.4 files one: `kind` on the row, the passage it would improve as
        // the evidence, and no `group_refs` — the whole-Overview reading. This pins the NON-default
        // direction: the two big pins above prove a kind-less row reads as `issue`, and this one proves
        // a marked row survives the projection as `proposal` instead of collapsing into the default.
        world.store.findings.create(
            {
                story_id: 'story_0',
                target_ref: 'summary_0',
                criterion_ref: 'C-14',
                title: 'name the map in the Premise, not only in the Ending',
                detail: 'The Premise withholds the map; naming it there gives the reader the reconciliation to watch for.',
                evidence: 'the Premise paragraph never mentions the map',
                cost: 'major' as Cost,
                kind: 'proposal',
                fingerprint: 'C-14|summary_0|improvement',
                state: 'approved',
                seen_count: 1
            },
            { run_ref: null, author: true, why: 'seed: a proposal on the rail (D-33b)' }
        );

        const reply = await call(world.app, 'GET', '/stories/story_0/phrases');
        const groupIds = world.store.phraseGroups.list().map((group) => group.id);

        expect(viewOf(reply).findings).toEqual([
            {
                id: 'finding_0',
                title: 'name the map in the Premise, not only in the Ending',
                cost: 'major',
                kind: 'proposal',
                state: 'approved',
                seen_count: 1,
                // Unscoped on purpose: an improvement about the Overview as a whole names no group, and
                // R3 reads that as "every group owes it" (the whole-Overview finding), so all five ids
                // are targeted and none is resolved. Only the kind distinguishes this row from a defect.
                group_refs: [],
                unscoped: true,
                targeted: groupIds,
                resolved: [],
                missing: groupIds,
                resolved_all: false
            }
        ]);
    });
});

describe('the legacy draft-set routes refuse a group-managed book (R5, R6)', () => {
    /** A competing SUMMARY draft on a group-managed book, written the way the crew writes one. */
    function seedSummaryDraft(store: Store, state = 'competing') {
        return store.revisions.create(
            {
                story_id: 'story_0',
                body: { fields: { ending: 'She leaves the valley standing.' } },
                unit_kind: 'summary',
                unit_ref: 'summary_0',
                run_ref: 'run_writer',
                state: state as never,
                verdict_refs: []
            },
            { run_ref: 'run_writer', why: 'seed: a Summary draft on a group book' }
        );
    }

    it('refuses a Summary select, with the sentence that points at the group route', async () => {
        const world = await seedGroupStory();

        seedSummaryDraft(world.store);

        const reply = await call(world.app, 'POST', '/stories/story_0/revisions/revision_0/select', {
            note: 'the deliberate ending'
        });

        expect(reply.status).toBe(409);
        expect(errorOf(reply)).toBe(
            "this Story's Summary is written group by group, so there is no Summary draft set to select from — a Writer result is installed when it is accepted, and the Author edits one group with POST /stories/story_0/phrases/groups/:groupId/revise (R5, R6)."
        );
        // The refusal is a read: the draft still competes, and nothing was installed.
        expect(world.store.revisions.require('revision_0').state).toBe('competing');
        expect(world.store.summaries.require('summary_0').ending).toBeUndefined();
    });

    it('refuses a Summary merge for the same reason', async () => {
        const world = await seedGroupStory();

        seedSummaryDraft(world.store);
        seedSummaryDraft(world.store, 'competing');

        const reply = await call(world.app, 'POST', '/stories/story_0/revisions/merge', {
            unit_ref: 'summary_0',
            revision_ids: ['revision_0', 'revision_1'],
            parts: 'the opening of revision_0, the last paragraph of revision_1'
        });

        expect(reply.status).toBe(409);
        expect(errorOf(reply)).toBe(
            "this Story's Summary is written group by group, so there are no Summary drafts to merge — its text is the group vector, and the Author rewrites one group with POST /stories/story_0/phrases/groups/:groupId/revise (R5, R6)."
        );
        // The merge is queued work on a legacy book; on a group book it opens no task at all.
        expect(world.store.tasks.list()).toEqual([]);
    });

    it('still lets a CHAPTER draft be selected on a group-managed book (phases ②/③ are unchanged)', async () => {
        const world = await seedGroupStory();
        const chapter = world.store.chapters.create(
            {
                story_id: 'story_0',
                order: 1,
                title: 'The Ridge',
                summary: 'She reaches the ridge.',
                sections: [{ id: 'section_1', text: 'The standing text.', origin: 'writer' }],
                state: 'drafting',
                author_locked: false,
                round: 1
            },
            { run_ref: null, author: true, why: 'seed: a chapter for the selection to install' }
        );

        world.store.revisions.create(
            {
                story_id: 'story_0',
                body: { sections: [{ id: 'section_1', text: 'The ridge is underwater.', origin: 'writer' }] },
                unit_kind: 'chapter',
                unit_ref: chapter.id,
                run_ref: 'run_writer',
                state: 'competing',
                verdict_refs: []
            },
            { run_ref: 'run_writer', why: 'seed: a chapter draft' }
        );

        const reply = await call(world.app, 'POST', '/stories/story_0/revisions/revision_0/select', {
            note: 'the ridge is underwater (D-24)'
        });

        expect(reply.status).toBe(200);
        expect(world.store.chapters.require(chapter.id).sections[0].text).toBe('The ridge is underwater.');
        // The journal line is the select route's own decision sentence (routes.ts:1574) — the note the
        // Author typed rides on the revision row, not on the attribution, so this is the exact string.
        expect(world.store.journal.slice(-1)[0]?.attribution.why).toBe(
            'the Author selected revision_0 for chapter_0 (D-24, U-13)'
        );
    });
});

// ---------------------------------------------------------------------------
// F8 — the Author's hand edit and the Writer's install race on ONE group row
// ---------------------------------------------------------------------------

/**
 * A Writer pass IN FLIGHT over `groupRefs` — the state R4's exclusion reads (`runs` row, live, on a
 * group-holding kind), written straight to the book because no crew is needed to hold a group. Passing
 * `null` omits `group_refs` entirely, which is `phrase/exclusion.ts`'s fail-closed case: a live holding
 * run that named no groups holds EVERY group of the Story.
 */
function seedLiveWriter(store: Store, groupRefs: string[] | null) {
    return store.runs.create(
        {
            story_id: 'story_0',
            work_item_ref: 'wi_draft_groups_summary_0_ffffffffffffffff_9',
            role: 'writer',
            state: 'working',
            started_at: '2026-11-24T10:00:00.000Z',
            tokens: 0,
            kind: 'work',
            delegated: [],
            ...(groupRefs === null ? {} : { group_refs: groupRefs })
        },
        { run_ref: null, author: false, why: 'seed: a live group Writer run (R4)' }
    );
}

/** The rail's editability answer per group — the flag the dashboard disables its button off (F8). */
const busyFlags = async (app: Hono) =>
    groupsOf(await call(app, 'GET', '/stories/story_0/phrases')).map((group) => [group.key, group.writer_busy]);

describe('a live Writer hold is projected, and the Author’s hand edit refuses to race it (F8, R4)', () => {
    it('disables exactly the held groups, 409s the held one, and lets the free ones through', async () => {
        const world = await seedGroupStory();

        writeLegacyProse(world.store);
        await call(world.app, 'POST', '/stories/story_0/phrases/import');

        const idOf = (key: string) => world.store.phraseGroups.list().find((group) => group.key === key)!.id;
        const revisions = world.store.groupRevisions.list().length;

        // Nobody is writing: five editable groups. The flag is a projected FIELD of the rail's row, not
        // something the client infers from a run list it does not have.
        expect(await busyFlags(world.app)).toEqual([
            ['premise', false],
            ['promise', false],
            ['theme', false],
            ['tone', false],
            ['ending', false]
        ]);

        const run = seedLiveWriter(world.store, [idOf('premise'), idOf('tone')]);
        // Counted AFTER the run row was written, so "the refusal journaled nothing" is measured against the
        // book as it stands when the request arrives.
        const events = world.store.journal.length;

        // Two disjoint groups held, three free — and the answer comes from the persisted Run row, so a
        // restart of this server changes it with no bookkeeping of ours.
        expect(await busyFlags(world.app)).toEqual([
            ['premise', true],
            ['promise', false],
            ['theme', false],
            ['tone', true],
            ['ending', false]
        ]);

        const refused = await call(world.app, 'POST', `/stories/story_0/phrases/groups/${idOf('premise')}/revise`, {
            content: 'a hand edit that arrives while the Writer is in the room',
            note: 'try me'
        });

        // The 409 names the group AND the run that holds it: the Author's next action is "wait for that
        // pass", not "guess which of the loop's jobs is in my text".
        expect(refused.status).toBe(409);
        expect(errorOf(refused)).toBe(
            `the Writer is rewriting premise right now (${run.id}), so a hand edit would install over text it has ` +
                'not finished with — the same edit lands once that run closes (R4: one Writer op per group, and this route is one).'
        );
        // The race is refused, not papered over: no revision row, no mirror write, no journal entry. The
        // group's history would have kept both texts, but only one Overview, and nobody could say which
        // sentences the next review actually read — which is why "history preserves it" is not a fix.
        expect(world.store.groupRevisions.list()).toHaveLength(revisions);
        expect(world.store.journal).toHaveLength(events);
        expect(world.store.phraseGroups.require(idOf('premise')).revision).toBe(1);
        expect(world.store.summaries.require('summary_0').premise).toBe(
            'A return to a mapped valley that no longer matches the map.'
        );

        // R4 is one Writer per GROUP, and the rail disabled two buttons, not five: the three groups nobody
        // holds are still editable while the pass runs.
        const allowed = await call(world.app, 'POST', `/stories/story_0/phrases/groups/${idOf('theme')}/revise`, {
            content: 'Memory, measured twice.'
        });

        expect(allowed.status).toBe(200);
        expect(world.store.phraseGroups.require(idOf('theme')).revision).toBe(2);

        // The run closing IS the unlock: the flag is derived, so the same edit lands with nothing to clear.
        const closed = world.store.runs.require(run.id);

        world.store.runs.update(
            closed.id,
            { state: 'torn_down' },
            { run_ref: null, author: false, why: 'seed: the Writer pass ended' },
            [{ id: closed.id, rev: closed.rev }]
        );

        expect(await busyFlags(world.app)).toEqual([
            ['premise', false],
            ['promise', false],
            ['theme', false],
            ['tone', false],
            ['ending', false]
        ]);

        const landed = await call(world.app, 'POST', `/stories/story_0/phrases/groups/${idOf('premise')}/revise`, {
            content: 'A return, on foot, into a valley the map still shows as dry.'
        });

        expect(landed.status).toBe(200);
        expect(world.store.phraseGroups.require(idOf('premise')).revision).toBe(2);
    });

    it('treats a live run that named no groups as holding every group, so no edit can race it', async () => {
        const world = await seedGroupStory();

        writeLegacyProse(world.store);
        await call(world.app, 'POST', '/stories/story_0/phrases/import');

        const run = seedLiveWriter(world.store, null);

        // Fail-closed, on purpose: an older row (or a writer that forgot to copy its refs) could otherwise
        // let a hand edit install over a pass that is rewriting the whole Overview.
        expect(await busyFlags(world.app)).toEqual([
            ['premise', true],
            ['promise', true],
            ['theme', true],
            ['tone', true],
            ['ending', true]
        ]);

        const refused = await call(world.app, 'POST', `/stories/story_0/phrases/groups/${world.store.phraseGroups.list()[0].id}/revise`, {
            content: 'text'
        });

        expect(refused.status).toBe(409);
        expect(errorOf(refused)).toContain(`(${run.id})`);
        expect(world.store.groupRevisions.list()).toHaveLength(5);
    });
});

// ---------------------------------------------------------------------------
// F6 — the legacy whole-Summary revise route against a group-managed book
// ---------------------------------------------------------------------------

describe('POST /stories/:id/summary/revise: the whole-Summary round refuses a group book (F6, R5)', () => {
    it('names the per-group route and leaves no task nobody can service', async () => {
        const world = await seedGroupStory();
        const reply = await call(world.app, 'POST', '/stories/story_0/summary/revise', { note: 'not final yet' });

        // The bounded answer, not a translation: the Author asked for another ROUND, and a group book has
        // no round — it has five groups that each take one rewrite. Answering with "rewrite all five"
        // would be a bigger claim than the one they made (R2).
        expect(reply.status).toBe(409);
        expect(errorOf(reply)).toBe(
            "this Story's Summary is written group by group, so there is no whole-Summary round to ask for — a " +
                'Writer result installs when it is accepted, and one group is rewritten with POST /stories/story_0/phrases/groups/:groupId/revise (R2, R5).'
        );

        // THE BUG: the verb used to queue a `rewrite` task, and the only thing that ever consumed one was
        // the whole-Summary sampler. On a group book that row would sit open forever — the rail showing
        // work nobody can do and an Author waiting for a round that cannot arrive.
        expect(world.store.tasks.list()).toEqual([]);
        expect(world.store.journal.filter((event) => event.collection === 'tasks')).toEqual([]);
    });

    it('still queues the rewrite task on a sampling book, where the sampler does service it', async () => {
        const world = await seedGroupStory('sampling');
        const reply = await call(world.app, 'POST', '/stories/story_0/summary/revise', { note: 'not final yet' });

        expect(reply.status).toBe(200);
        expect(world.store.tasks.list().map((task) => [task.kind, task.state, task.owner_role, task.priority])).toEqual([
            ['rewrite', 'open', 'writer', 0]
        ]);
        expect(world.store.tasks.list()[0]?.title).toBe('Author requested a fresh Summary round');
        expect(world.store.tasks.list()[0]?.detail).toBe(
            'The Author asked for another three-draft Summary round. Note: not final yet · summary_0'
        );
    });
});

// ---------------------------------------------------------------------------
// THE REVIEWED SUMMARY ON THE WIRE (D-67, D-68)
//
// Two states of one book, side by side: what the crew stands behind (the newest Clean revision of each
// group) and what the book currently says (the newest revision, verdict or no verdict). The projection
// carries BOTH because the Author's decision is exactly the distance between them, and the choose is the
// one verb that closes it — an install of the reviewed texts, not an edit of the current ones.
// ---------------------------------------------------------------------------

describe('the Reviewed Summary on the wire, and the Author\'s choose (D-67, D-68)', () => {
    /** One group's revision row, addressed by group key and number — the ids are counter-minted. */
    const revisionOf = (world: TestApp, key: string, number: number) =>
        world.store.groupRevisions.list().find((row) => row.group_key === key && row.number === number)!;

    /**
     * The book the feature exists for: five reviewed texts, then five NEWER texts nobody has read. This is
     * the user's Ending example at wire scale — every group's current prose carries no verdict while the
     * clean one sits exactly one revision behind it.
     */
    function seedReviewedBook(world: TestApp) {
        // Each write re-reads the rows it names: an install bumps its group row's `rev`, and handing the
        // helper a row captured before the previous install would trip the store's own CAS guard (T-4).
        const write = (text: (key: string) => string, workItemRef: string) =>
            installGroupRevisions(
                world.store,
                world.store.stories.require('story_0'),
                world.store.phraseGroups
                    .list()
                    .filter((group) => group.story_id === 'story_0')
                    .map((group) => ({ group, content: text(group.key) })),
                AUTHOR_ATTR,
                { runRef: null, workItemRef }
            );

        write((key) => `${key} r1, the text a cross-group pass passed.`, 'wi_draft_groups_summary_0_reviewed');

        // The clean pass, by its effect on the rows — the same write `loop/engine.ts:settleJob` makes when
        // the deep review's `check_unit` run closes (D-67).
        stampCleanRevisions(
            world.store,
            world.store.stories.require('story_0'),
            { seatKey: groupCheckSeatKey(groupVectorHash(groupRevisionVector(world.store, 'story_0')), 1), runRef: 'run_check_1' },
            AUTHOR_ATTR
        );

        write((key) => `${key} r2, the newest text, no verdict on it.`, 'wi_draft_groups_summary_0_unreviewed');
    }

    it('shows the reviewed revision beside the newer one for every group, with no choice recorded yet', async () => {
        const world = await seedGroupStory();

        seedReviewedBook(world);

        const reply = await call(world.app, 'GET', '/stories/story_0/phrases');
        const view = viewOf(reply);
        const reviewed = view.reviewed as Record<string, unknown>;

        // `[key, selected, selected_id, clean_run_ref, latest, superseded, issues_open, gap, scores]`.
        // Every group reads `1` under `2`, and `superseded` is what the rail paints amber.
        expect(reviewedShape(reply)).toEqual([
            ['premise', 1, revisionOf(world, 'premise', 1).id, 'run_check_1', 2, true, false, null, []],
            ['promise', 1, revisionOf(world, 'promise', 1).id, 'run_check_1', 2, true, false, null, []],
            ['theme', 1, revisionOf(world, 'theme', 1).id, 'run_check_1', 2, true, false, null, []],
            ['tone', 1, revisionOf(world, 'tone', 1).id, 'run_check_1', 2, true, false, null, []],
            ['ending', 1, revisionOf(world, 'ending', 1).id, 'run_check_1', 2, true, false, null, []]
        ]);

        const vector = Object.fromEntries(
            world.store.phraseGroups.list().map((group) => [group.id, 1])
        );

        expect({
            state: reviewed.state,
            complete: reviewed.complete,
            vector: reviewed.vector,
            vector_hash: reviewed.vector_hash,
            chosen: reviewed.chosen,
            stale: reviewed.stale,
            blocking_issues: reviewed.blocking_issues,
            writer_busy: reviewed.writer_busy
        }).toEqual({
            // `ready`: there IS a reviewed Overview to take, and the Author has not taken it.
            state: 'ready',
            complete: true,
            vector,
            vector_hash: groupVectorHash(vector),
            chosen: null,
            stale: false,
            blocking_issues: [],
            writer_busy: false
        });

        // Both readings travel at once, and they DIFFER: the rail's Overview is the unreviewed prose, the
        // reviewed block's is the clean prose. This is the window the choose closes.
        expect(view.overview).toContain('premise r2, the newest text, no verdict on it.');
        expect(reviewed.overview).toContain('premise r1, the text a cross-group pass passed.');
        expect(reviewed.overview).not.toBe(view.overview);
    });

    it('installs the reviewed Overview as the book, discards what it passed over, and returns the new view', async () => {
        const world = await seedGroupStory();

        seedReviewedBook(world);

        const reply = await call(world.app, 'POST', '/stories/story_0/phrases/reviewed/choose', {
            note: 'the reviewed Ending is the one I meant'
        });

        expect(reply.status).toBe(200);

        const body = viewOf(reply);
        const vector = Object.fromEntries(world.store.phraseGroups.list().map((group) => [group.id, 1]));
        const hash = groupVectorHash(vector);

        expect(Object.keys(body)).toEqual([
            'story_id',
            'phrase_id',
            'revision',
            'vector',
            'vector_hash',
            'at',
            'overview',
            'installed',
            'discarded',
            'sources',
            'mirror',
            'view'
        ]);
        expect({ story_id: body.story_id, vector: body.vector, vector_hash: body.vector_hash }).toEqual({
            story_id: 'story_0',
            vector,
            vector_hash: hash
        });
        expect(body.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        // One new `latest` per group — the choose INSTALLS (R2's numbering, R6's mirror), it does not edit
        // the current rows, so the whole history survives and the rail can still walk it.
        expect(body.installed).toEqual(
            ['premise', 'promise', 'theme', 'tone', 'ending'].map((key) => ({
                group_id: world.store.phraseGroups.list().find((group) => group.key === key)!.id,
                group_key: key,
                revision_id: revisionOf(world, key, 3).id,
                number: 3
            }))
        );
        // Every row the choice passed over is DISCARDED and RETAINED (10 of them): a finding one of those
        // revisions closed stays `fixed` (`phrase/findings.ts:groupResolvesFinding` walks every state).
        expect(
            (body.discarded as Array<Record<string, unknown>>)
                .map((row) => `${row.group_key}:${row.number}`)
                .sort()
        ).toEqual([
            'ending:1', 'ending:2',
            'premise:1', 'premise:2',
            'promise:1', 'promise:2',
            'theme:1', 'theme:2',
            'tone:1', 'tone:2'
        ].sort());
        expect(body.sources).toEqual(
            ['premise', 'promise', 'theme', 'tone', 'ending'].map((key) => ({
                group_id: world.store.phraseGroups.list().find((group) => group.key === key)!.id,
                group_key: key,
                source_revision: 1,
                source_id: revisionOf(world, key, 1).id,
                installed_revision: 3
            }))
        );
        // R6: the legacy mirror moves with the choose, exactly as an install's does.
        expect(body.mirror).toEqual({
            summary_id: 'summary_0',
            fields: ['premise', 'promise', 'theme', 'tone', 'ending'],
            written: true
        });

        // THE BOOK, afterwards: each group's current text IS the reviewed text, and the two Overviews the
        // rail reads are now the same bytes — which is the whole point of taking the choice.
        expect(world.store.phraseGroups.list().map((group) => [group.key, group.revision, group.content])).toEqual([
            ['premise', 3, 'premise r1, the text a cross-group pass passed.'],
            ['promise', 3, 'promise r1, the text a cross-group pass passed.'],
            ['theme', 3, 'theme r1, the text a cross-group pass passed.'],
            ['tone', 3, 'tone r1, the text a cross-group pass passed.'],
            ['ending', 3, 'ending r1, the text a cross-group pass passed.']
        ]);

        const view = viewOf(await call(world.app, 'GET', '/stories/story_0/phrases'));
        const reviewed = view.reviewed as Record<string, unknown>;

        // THE BOOK, afterwards: the rail's Overview and the CHOSEN Overview are the same bytes — the
        // choose installed the reviewed prose, so the text the Author reads and the record of the decision
        // cannot drift apart.
        expect(view.overview).toBe((reviewed.chosen as Record<string, unknown>).overview);
        // The live reviewed block answers `''` and `complete: false`: the five rows this choose installed
        // have not sat through a cross-group pass, so there is no NEWER reviewed Overview until the next
        // deep pass earns one. The choice itself is still reported in full.
        expect(reviewed.overview).toBe('');
        expect({ state: reviewed.state, complete: reviewed.complete, stale: reviewed.stale }).toEqual({
            // The choice stands (`chosen`), and there is nothing newer to take yet.
            state: 'chosen',
            complete: false,
            stale: false
        });
        expect((reviewed.chosen as Record<string, unknown>).vector).toEqual(vector);
        expect((reviewed.chosen as Record<string, unknown>).vector_hash).toBe(hash);
        // P11: the journal names the route, the Story, and what the Author said about it. The order of the
        // two clauses is the composition: `authorAttr` writes the route's sentence (closed by the
        // dashboard-write marker) and `chooseReviewedSummary` appends the record it committed, so the
        // domain's clause is last — the attribution stays attributable to whoever wrote each part.
        expect(
            world.store.journal
                .filter((event) => event.collection === 'phrases' && event.op === 'update')
                .slice(-1)[0]?.attribution.why
        ).toBe(
            `the Author used POST /stories/:id/phrases/reviewed/choose on story_0 — the reviewed Overview at vector ${hash} was chosen: the reviewed Ending is the one I meant (D-68) (§10 dashboard write); the Phrase row records the reviewed vector ${hash} as the Author's choice (D-68)`
        );
    });

    it('keeps the diff\'s "before" side across the choose, off the newest DISCARDED row of the group (D-68)', async () => {
        const world = await seedGroupStory();

        seedReviewedBook(world);

        expect((await call(world.app, 'POST', '/stories/story_0/phrases/reviewed/choose', {})).status).toBe(200);

        // WHY THIS IS NOT JUST ANOTHER ARCHIVED READ (§17.17): the install archived r2 — the row the new
        // number replaced — and the discard step then flipped r2 AND r1 over, so a post-choose group has
        // NO `archived` row at all. The read the pane has always used answers nothing here, and without
        // `projections.ts:1533-1535`'s fallback the rail loses its "before" side on the one transition the
        // Author cares about.
        expect(
            world.store.groupRevisions
                .list()
                .filter((revision) => revision.group_key === 'premise')
                .sort((left, right) => left.number - right.number)
                .map((revision) => [revision.number, revision.state])
        ).toEqual([
            [1, 'discarded'],
            [2, 'discarded'],
            [3, 'latest']
        ]);

        const rows = groupsOf(await call(world.app, 'GET', '/stories/story_0/phrases'));

        // Each group's `previous_content` is the text its chosen revision REPLACED: r2, the newest row of
        // the group and therefore the newest DISCARDED one. Taking r1 instead (the clean text, now also
        // the live one) would diff the chosen Summary against itself.
        expect(rows.map((group) => [group.key, group.content, group.previous_content])).toEqual([
            ['premise', 'premise r1, the text a cross-group pass passed.', 'premise r2, the newest text, no verdict on it.'],
            ['promise', 'promise r1, the text a cross-group pass passed.', 'promise r2, the newest text, no verdict on it.'],
            ['theme', 'theme r1, the text a cross-group pass passed.', 'theme r2, the newest text, no verdict on it.'],
            ['tone', 'tone r1, the text a cross-group pass passed.', 'tone r2, the newest text, no verdict on it.'],
            ['ending', 'ending r1, the text a cross-group pass passed.', 'ending r2, the newest text, no verdict on it.']
        ]);

        // §17.17's other half, from the same read: a discarded row is RETAINED (the fallback above can
        // only name text the book already published) and still never becomes a candidate in the history
        // list — one live row, its body reported as a count, and no discarded prose on the wire.
        const premise = rows.find((group) => group.key === 'premise')!;

        expect(premise.history).toEqual([
            {
                id: revisionOf(world, 'premise', 3).id,
                number: 3,
                state: 'latest',
                at: revisionOf(world, 'premise', 3).created_at,
                run_ref: null,
                finding_refs: [],
                task_refs: [],
                // The rows the choose installs are deliberately NOT clean-stamped — they never sat through
                // a review pass (D-68), so the stamp column reads false beside the chosen text.
                clean: false,
                clean_run_ref: null,
                // 47 is the length of the chosen sentence — the only body this row reports, as a count.
                chars: 47
            }
        ]);
        expect(JSON.stringify(premise.history)).not.toContain('discarded');
    });

    it('refuses a book nobody has reviewed, naming every group and why it is missing (D-68)', async () => {
        const world = await seedGroupStory();
        const reply = await call(world.app, 'POST', '/stories/story_0/phrases/reviewed/choose', {});

        expect(reply.status).toBe(409);
        expect(errorOf(reply)).toBe(
            'this Story has no Reviewed Summary to choose: premise (unwritten), promise (unwritten), theme (unwritten), tone (unwritten), ending (unwritten) — a group joins the reviewed Overview only once a cross-group Critic pass closes with no unresolved defect on it (D-67, D-68).'
        );
        // The refusal wrote nothing at all: no rows, no choice, no journal line for a verb that never ran.
        expect(world.store.groupRevisions.list()).toEqual([]);
        expect(world.store.journal.filter((event) => event.commit_label === 'phrase_reviewed_choose')).toEqual([]);
    });

    it('names the issue that holds a clean verdict back rather than a bare "no clean revision"', async () => {
        const world = await seedGroupStory();

        seedReviewedBook(world);

        const ending = world.store.phraseGroups.list().find((group) => group.key === 'ending')!;

        world.store.findings.create(
            {
                story_id: 'story_0',
                target_ref: world.store.phrases.list()[0].id,
                criterion_ref: 'criterion_structure',
                title: 'the ending walks away from the promise',
                evidence: 'The last paragraph stops answering the premise.',
                cost: 'major',
                kind: 'issue',
                fingerprint: 'fp_reviewed_wire',
                state: 'approved',
                approved_by: 'auto',
                seen_count: 1,
                group_refs: [ending.id]
            },
            AUTHOR_ATTR
        );

        const reply = await call(world.app, 'POST', '/stories/story_0/phrases/reviewed/choose', {});

        expect(reply.status).toBe(409);
        expect(errorOf(reply)).toContain('ending (an unresolved issue names it)');

        // The rail sees the same thing the refusal says: Ending has its stamp and is STILL not selectable.
        const after = await call(world.app, 'GET', '/stories/story_0/phrases');

        const blocked = reviewedShape(after);
        expect(blocked[4]).toEqual(['ending', null, null, null, 2, false, true, 'no_clean_revision', []]);
        expect((viewOf(after).reviewed as Record<string, unknown>).blocking_issues).toEqual([
            { id: 'finding_0', title: 'the ending walks away from the promise', cost: 'major', group_keys: ['ending'] }
        ]);
    });

    it('refuses while a Writer pass is live on any group — the same read the disabled button uses (R4)', async () => {
        const world = await seedGroupStory();

        seedReviewedBook(world);

        const ending = world.store.phraseGroups.list().find((group) => group.key === 'ending')!;
        const live = world.store.runs.create(
            {
                story_id: 'story_0',
                work_item_ref: 'wi_draft_groups_summary_0_live_1',
                role: 'writer',
                state: 'working',
                started_at: '2026-11-25T10:00:01.000Z',
                ended_at: null,
                tokens: 4,
                kind: 'work',
                no_op: false,
                delegated: [],
                group_refs: [ending.id]
            },
            AUTHOR_ATTR
        );

        const reply = await call(world.app, 'POST', '/stories/story_0/phrases/reviewed/choose', {});

        expect(reply.status).toBe(409);
        expect(errorOf(reply)).toBe(
            `the Writer is rewriting part of this Summary right now (${live.id}), so choosing the reviewed Overview would install under a pass that has not finished — the same choice lands once those runs close (R4, D-68).`
        );
        // The rail's Choose control is grey for the same reason, off the same read — a disabled button and
        // a 409 can never disagree.
        const view = viewOf(await call(world.app, 'GET', '/stories/story_0/phrases'));

        expect((view.reviewed as Record<string, unknown>).writer_busy).toBe(true);
        // `slice` rather than `.at`: this package's tsconfig `lib` predates ES2022.
        const busy = groupsOf(await call(world.app, 'GET', '/stories/story_0/phrases'));

        expect(busy[4]!.writer_busy).toBe(true);
    });

    it('refuses a book still on the legacy pipeline, and points at the import that would make it groupable', async () => {
        const world = await seedGroupStory('sampling');
        const reply = await call(world.app, 'POST', '/stories/story_0/phrases/reviewed/choose', {});

        expect(reply.status).toBe(409);
        expect(errorOf(reply)).toBe(
            "this Story's Summary is still written as one text (no group catalog); POST /stories/story_0/phrases/import turns the flat Summary into groups first (R6, D-68)."
        );
    });
});
