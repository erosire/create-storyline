// R-B: the two record collections a Title owns, checked against the engine that stores them.
//
// WHY A REAL HARNESS AND NOT A UNIT TEST OF THE DEFINITION OBJECT. The definition is only a
// promise until the record engine accepts it: what the UI and the agents depend on is that the
// engine ENFORCES the bounds (a 4001-character section is refused, a 51st section is refused, an
// unknown field names the three that exist) and that `order` really is the sort key of a list
// page. Only `records` can answer those, so the harness is under test here too.
//
// WHY `updatedAt` IS STRIPPED AND NOTHING ELSE IS. It is the only wall-clock field the engine
// writes; every other field of every response below is deterministic and asserted in full.
//
// WHY `createStorylinePreset().create()` AND NOT a bare `harness({...})`. A session built by the
// preset is the thing this guarantee is about — same tool set, same record engine, same agent
// identity as a REST-created Title. The id counter is shared across collections in one harness
// (harness record engine), so each test gets a fresh one and the exact ids below are stable.
import { describe, expect, it } from 'vitest';
import type { Harness } from '@underload/harness';
import { createStorylinePreset } from './presets';
import {
    COLLECTION_EXISTS_CODE,
    STORYLINE_COLLECTION_NAMES,
    STORYLINE_SECTION_HEADING_MAX_LENGTH,
    STORYLINE_SECTION_MAX_RECORDS,
    STORYLINE_SECTION_TEXT_MAX_LENGTH,
    definedStorylineCollections,
    ensureStorylineCollections,
    isCollectionExistsError,
    storylineCollectionDefinitions,
    storylineSectionDefinition
} from './collections';

const SETTINGS = { baseURL: 'http://127.0.0.1:1/v1', apiKey: '', model: 'story/test-model' };

const buildHarness = (): Harness => createStorylinePreset().create(SETTINGS, () => {});

/** `updatedAt` is a wall-clock stamp; everything else in a record is deterministic. */
const withoutTimestamp = <T extends { updatedAt?: unknown }>(value: T): Omit<T, 'updatedAt'> => {
    const { updatedAt: _ignored, ...rest } = value;

    return rest;
};

const withoutTimestamps = <T extends { updatedAt?: unknown }>(values: T[]): Omit<T, 'updatedAt'>[] => values.map((value) => withoutTimestamp(value));

// The field spec exactly as the engine stores and re-advertises it (verified against
// `records().collections`, which is the same document `GET /sessions/{id}/records` returns).
const SECTION_FIELDS = [
    { key: 'order', type: 'integer', sortable: true, default: 0 },
    { key: 'heading', type: 'text', maxLength: STORYLINE_SECTION_HEADING_MAX_LENGTH },
    { key: 'content', type: 'text', maxLength: STORYLINE_SECTION_TEXT_MAX_LENGTH }
];

// The collections a harness owns before this package defines anything (probe-verified order).
const BUILTIN_COLLECTIONS = ['tasks', 'chapters', 'profiles', 'locations'];

/** The `records` list page for one collection. */
const listSections = async (harness: Harness, collection: string): Promise<Record<string, unknown>> =>
    (await harness.executeTool('records', { collection })) as Record<string, unknown>;

describe('storyline Title collections (R-B)', () => {
    it('defines both folders once and reports exactly what it created', async () => {
        const harness = buildHarness();

        // A storyline session starts WITHOUT them: the guarantee is this package's, not the
        // harness's, so an empty pre-check is the honest starting point.
        expect(definedStorylineCollections(harness)).toEqual([]);

        expect(await ensureStorylineCollections(harness)).toEqual([...STORYLINE_COLLECTION_NAMES]);

        const view = harness.records();

        expect(view.collections.map((collection) => collection.name)).toEqual([...BUILTIN_COLLECTIONS, 'outlines', 'storyline']);

        // Both folders, in full: the field spec is the contract the UI sorts by and the agents
        // write against, and it is returned by the same document the panels read.
        expect(view.collections.filter((collection) => (STORYLINE_COLLECTION_NAMES as readonly string[]).includes(collection.name))).toEqual([
            { name: 'outlines', fields: SECTION_FIELDS, storeRev: 0, count: 0, entries: [] },
            { name: 'storyline', fields: SECTION_FIELDS, storeRev: 0, count: 0, entries: [] }
        ]);

        // Idempotent, by pre-check rather than by retry: a second owner (the UI's ensure, a
        // restart, a duplicate create) costs one read and no write.
        expect(await ensureStorylineCollections(harness)).toEqual([]);
        expect(definedStorylineCollections(harness)).toEqual(['outlines', 'storyline']);
    });

    it('defines an ordered section store, not a document blob', () => {
        // The definitions are the whole product surface, so they are pinned literally: a
        // renamed field or a raised cap is a UI and agent-contract change, and it has to break
        // something here.
        expect(storylineCollectionDefinitions()).toEqual([
            { name: 'outlines', maxRecords: STORYLINE_SECTION_MAX_RECORDS, fields: SECTION_FIELDS },
            { name: 'storyline', maxRecords: STORYLINE_SECTION_MAX_RECORDS, fields: SECTION_FIELDS }
        ]);

        expect(storylineSectionDefinition('other')).toEqual({ name: 'other', maxRecords: STORYLINE_SECTION_MAX_RECORDS, fields: SECTION_FIELDS });

        // The caps this package chose, next to the engine's own ceilings they sit under.
        expect(STORYLINE_SECTION_MAX_RECORDS).toBe(50);
        expect(STORYLINE_SECTION_TEXT_MAX_LENGTH).toBe(4000);
        expect(STORYLINE_SECTION_HEADING_MAX_LENGTH).toBe(200);
    });

    it('reads a page back in document order, whatever order the sections were added in', async () => {
        const harness = buildHarness();

        await ensureStorylineCollections(harness);

        const added = (await harness.executeTool('records', {
            collection: 'outlines',
            entries: [
                { order: 30, heading: 'Act Three', content: 'The reckoning.' },
                { order: 10, heading: 'Act One', content: 'Ines arrives at the harbour.' },
                { order: 20, heading: 'Act Two', content: 'The harbour burns.' }
            ]
        })) as { entries: Record<string, unknown>[]; counts: Record<string, unknown>; page: Record<string, unknown>; storeRev: number };

        // `order` is the sort key because the definition marks it `sortable` (harness
        // core/records.ts `orderedViewOf`), so the centre panel's document order arrives
        // without the client sorting. Ids still name SUBMISSION order — '1' is the first entry
        // SENT, which is Act Three.
        expect(withoutTimestamps(added.entries)).toEqual([
            { id: '2', order: 10, heading: 'Act One', content: 'Ines arrives at the harbour.', rev: 1, updatedBy: 'writer' },
            { id: '3', order: 20, heading: 'Act Two', content: 'The harbour burns.', rev: 1, updatedBy: 'writer' },
            { id: '1', order: 30, heading: 'Act Three', content: 'The reckoning.', rev: 1, updatedBy: 'writer' }
        ]);
        expect(added.counts).toEqual({ total: 3 });
        expect(added.page).toEqual({ offset: 0, limit: 20, hasMore: false });
        expect(added.storeRev).toBe(3);

        // The list page is the same three in the same order, so the panel and the agent agree.
        expect(withoutTimestamps(((await listSections(harness, 'outlines')) as { entries: Record<string, unknown>[] }).entries)).toEqual(
            withoutTimestamps(added.entries)
        );

        // The store snapshot the UI reads (`GET /sessions/{id}/records`) carries `content` too —
        // the document IS the list, so it is not `getOnly` like `chapters.content` — but it is
        // ordered by ID, not by `order`. A panel that renders the snapshot has to sort by
        // `order` itself; only a `records` page comes pre-sorted.
        expect(withoutTimestamps(harness.records().collections.find((collection) => collection.name === 'outlines')!.entries)).toEqual([
            { id: '1', order: 30, heading: 'Act Three', content: 'The reckoning.', rev: 1, updatedBy: 'writer' },
            { id: '2', order: 10, heading: 'Act One', content: 'Ines arrives at the harbour.', rev: 1, updatedBy: 'writer' },
            { id: '3', order: 20, heading: 'Act Two', content: 'The harbour burns.', rev: 1, updatedBy: 'writer' }
        ]);
    });

    it('enforces the bounds a section has, naming the collection and the limit', async () => {
        const harness = buildHarness();

        await ensureStorylineCollections(harness);

        // The 4001st character is the engine's `text` ceiling, and the refusal says what to do.
        await expect(
            harness.executeTool('records', { collection: 'storyline', entries: [{ order: 10, heading: 'Big', content: 'a'.repeat(4001) }] })
        ).rejects.toThrow('field-too-long: storyline "content" is 4001 characters; the limit is 4000. Shorten it and retry.');

        // 50 sections is the working-document cap this package chose; the 51st is refused.
        await harness.executeTool('records', {
            collection: 'storyline',
            entries: Array.from({ length: STORYLINE_SECTION_MAX_RECORDS }, (_unused, index) => ({ order: index, heading: `Section ${index}` }))
        });

        await expect(harness.executeTool('records', { collection: 'storyline', entries: [{ order: 99, heading: 'One too many' }] })).rejects.toThrow(
            'store-full: storyline would hold 51 storyline; the maximum is 50. Remove one before adding another.'
        );

        // A field this collection does not have is refused with the list it does have — which
        // is how an agent recovers without being told the schema twice.
        await expect(harness.executeTool('records', { collection: 'outlines', entries: [{ title: 'wrong field' }] })).rejects.toThrow(
            'unknown-field: outlines "entries[0]" has no field "title"; outlines declares "order", "heading", "content".'
        );

        // An `order` that is not an integer is refused rather than coerced: the sort key is what
        // the panel reads, so a silent 10.5 would render in an order nobody chose.
        await expect(harness.executeTool('records', { collection: 'outlines', entries: [{ order: 10.5, heading: 'Half' }] })).rejects.toThrow(
            'invalid-field: outlines "order" must be an integer when provided.'
        );

        // The engine's own list of collections is the proof both folders are reachable by name
        // — by an agent through `records`, not only by the server that defined them.
        await expect(harness.executeTool('records', { collection: 'nope', entries: [{ heading: 'x' }] })).rejects.toThrow(
            'unknown-collection: records has no collection "nope"; defined collections: tasks, chapters, profiles, locations, outlines, storyline. Pass "define" to create a new one.'
        );
    });

    it('compares and swaps a section revision, exactly as the prompts promise', async () => {
        const harness = buildHarness();

        await ensureStorylineCollections(harness);

        await harness.executeTool('records', { collection: 'outlines', entries: [{ order: 10, heading: 'Act One', content: 'First draft.' }] });

        const patched = (await harness.executeTool('records', {
            collection: 'outlines',
            entries: [{ id: '1', content: 'Second draft.' }],
            expects: [{ id: '1', rev: 1 }]
        })) as { entry: Record<string, unknown>; storeRev: number };

        // A patch carries only the fields it means to change: `heading` and `order` survived
        // untouched and `rev` moved, which is what makes a section safe to edit from two places.
        expect(withoutTimestamp(patched.entry)).toEqual({ id: '1', order: 10, heading: 'Act One', content: 'Second draft.', rev: 2, updatedBy: 'writer' });

        await expect(
            harness.executeTool('records', { collection: 'outlines', entries: [{ id: '1', content: 'Forced.' }], expects: [{ id: '1', rev: 1 }] })
        ).rejects.toThrow('stale-record: outlines "1" changed since revision 1');
    });

    it('treats "the collection already exists" as success, in all three spellings', async () => {
        const harness = buildHarness();

        await ensureStorylineCollections(harness);

        let refusal: unknown = null;

        try {
            await harness.executeTool('records', { define: storylineSectionDefinition('outlines') });
        } catch (error) {
            refusal = error;
        }

        // The engine codes this refusal three ways on purpose (core/records.ts), and
        // `isCollectionExistsError` reads all three so a wrapper cannot hide the success case.
        const coded = refusal as { code?: string; name?: string; message?: string };

        expect(coded.code).toBe(COLLECTION_EXISTS_CODE);
        expect(coded.name).toBe(COLLECTION_EXISTS_CODE);
        expect(coded.message).toBe(
            'collection-exists: A collection named "outlines" is already defined; a re-define is refused rather than merged, because it would silently change a live contract.'
        );
        expect(isCollectionExistsError(refusal)).toBe(true);
        expect(isCollectionExistsError(new Error(`Tool "records" failed: ${COLLECTION_EXISTS_CODE}: already defined`))).toBe(true);
        expect(isCollectionExistsError({ code: COLLECTION_EXISTS_CODE })).toBe(true);
        expect(isCollectionExistsError({ name: COLLECTION_EXISTS_CODE })).toBe(true);

        // And is not over-eager: an unrelated failure still surfaces, because a session that
        // quietly lacks two folders is worse than a visible bug.
        expect(isCollectionExistsError(new Error('store-full: storyline would hold 51 storyline'))).toBe(false);
        expect(isCollectionExistsError(COLLECTION_EXISTS_CODE)).toBe(false);
        expect(isCollectionExistsError(null)).toBe(false);
        expect(isCollectionExistsError(undefined)).toBe(false);
    });

    it('survives two owners defining at the same moment', async () => {
        const harness = buildHarness();

        // Both callers read an empty pre-check and both try both names; between the read and
        // the write one of them loses, and losing is the state both asked for.
        const both = await Promise.all([ensureStorylineCollections(harness), ensureStorylineCollections(harness)]);

        expect(both.flat().sort()).toEqual(['outlines', 'storyline']);
        expect(harness.records().collections.map((collection) => collection.name)).toEqual([...BUILTIN_COLLECTIONS, 'outlines', 'storyline']);

        // The half-done case, which is what a UI that ensured only the folder it opened leaves
        // behind: the server then creates exactly the one that is missing.
        const half = buildHarness();

        await half.executeTool('records', { define: storylineSectionDefinition('outlines') });

        expect(definedStorylineCollections(half)).toEqual(['outlines']);
        expect(await ensureStorylineCollections(half)).toEqual(['storyline']);
    });

    it('leaves a harness it was never called on holding only the built-ins', async () => {
        // The negative control for the post-create hook: nothing in this module runs at import
        // time, so a session on another preset keeps the four collections the harness ships.
        const harness = buildHarness();

        expect(harness.records().collections.map((collection) => collection.name)).toEqual(BUILTIN_COLLECTIONS);
    });
});
