// The Title's record collections (R-B): `outlines` and `storyline`, the two ordered
// section stores every storyline session owns beside the harness's own `chapters` and
// `profiles`.
//
// WHY THESE TWO EXIST AT ALL. The redesign makes a SESSION a Title and the UI a folder
// tree over that Title: Outlines, Profiles (characters), Plotlines (chapters), Storyline.
// The harness ships `chapters` (prose layout) and `profiles` (cast) as built-in record
// collections, and it ships a GENERIC record engine behind the `records` tool — so the
// two remaining folders are a `define`, not a new tool. Keeping them in the record
// engine is what makes them free: the same `GET /sessions/{id}/records` snapshot the
// panels already read returns them, the same `records.updated` stream frame wakes a panel
// when an agent edits them, and the same compare-and-swap discipline (`expects
// [{id, rev}]`) guards a write. A hand-rolled REST resource would have needed all three
// re-invented.
//
// WHY A SECTION, NOT A WHOLE DOCUMENT. `maxRecords` is 50 and a `text` field caps at
// 4000 characters (the engine's own ceiling — `RECORD_MAX_TEXT_LENGTH`, and the same
// limit `chapters.content` carries, harness src/core/chapter.ts:27). A Title's prose is
// longer than either, so a record is ONE SECTION addressed by `order`: the whole
// document is the sections stitched in `order`, and an agent refines one section at a
// time. That is also the shape the brief asks for — "agents can work on any piece …
// constantly refining it".
//
// WHY `content` IS NOT `getOnly` (unlike `chapters.content`). A `getOnly` field is
// omitted from every list page and from the store snapshot, and returned only by a
// single-record `get` (harness src/core/records.ts:300-318). A chapter body is the
// outlier case: one body per read. Here the WHOLE document IS the list — the center
// panel stitches it — so omitting `content` would force one `get` per section per
// render. Fifty sections at 4000 characters is the documented cost of one read, and the
// collection's `responseBudgetBytes` still bounds a page.
//
// WHY DEFINING MUST BE IDEMPOTENT. A re-`define` of an existing name is REFUSED, never
// merged (harness src/core/records.ts:1129-1134, code `collection-exists`), because a
// silent merge would change a live contract. Two owners therefore exist for the same
// guarantee — this server's post-create hook (./service.ts) and the UI's own ensure —
// and each must treat "it already exists" as success. The pre-check below does most of
// that work; the catch handles the race where the other owner defined it between the
// read and the write.
//
// Cross-references:
//   - ./service.ts      — the post-create hook that calls `ensureStorylineCollections`
//   - ./presets.ts      — `records` in the enabled tool set (the agents' door to these two)
//   - ./orchestrator.ts — the change summary that names these collections to the next agent
import type { Harness } from '@underload/harness';

// ---------------------------------------------------------------------------
// Names and caps
// ---------------------------------------------------------------------------

/** The Outlines folder: the Title's plan, one section per record. */
export const OUTLINES_COLLECTION_NAME = 'outlines';

/** The Storyline folder: the Title's running prose, one section per record. */
export const STORYLINE_COLLECTION_NAME = 'storyline';

/** The two collections every storyline session owns, in the order the UI lists them. */
export const STORYLINE_COLLECTION_NAMES = [OUTLINES_COLLECTION_NAME, STORYLINE_COLLECTION_NAME] as const;

/** Sections per collection. The engine's own ceiling is 200; 50 is a working document. */
export const STORYLINE_SECTION_MAX_RECORDS = 50;

/** One section's prose. The engine's `text` ceiling (core/chapter.ts:27 uses the same). */
export const STORYLINE_SECTION_TEXT_MAX_LENGTH = 4000;

/** A section's heading is a label, not prose; 200 characters is generous for one. */
export const STORYLINE_SECTION_HEADING_MAX_LENGTH = 200;

/** The engine's refusal code for a re-`define` (core/records.ts:206 `collectionExists`). */
export const COLLECTION_EXISTS_CODE = 'collection-exists';

// ---------------------------------------------------------------------------
// The shape
// ---------------------------------------------------------------------------

/**
 * One field of a collection definition, in the shape `records` `define` accepts
 * (`RecordFieldDefinition`, harness src/types/index.ts:1400-1439). Declared locally
 * rather than imported so this module's public surface is the definition of a
 * collection, not a re-export of the library's.
 */
export type StorylineFieldDefinition = {
    key: string;
    type: 'integer' | 'text';
    sortable?: boolean;
    required?: boolean;
    maxLength?: number;
    default?: number | string;
};

/** One collection definition, in the shape `records` `define` accepts. */
export type StorylineCollectionDefinition = {
    name: string;
    maxRecords: number;
    fields: readonly StorylineFieldDefinition[];
};

/**
 * The one definition both folders use — an ordered section store.
 *
 * `order` is `sortable` because that is the field the panels sort by (a list page asked
 * for `order` comes back in document order), and it defaults to 0 so an agent that adds
 * a section without thinking about position still gets a valid record instead of an
 * `invalid-field` refusal. `heading` is optional: an unnamed section is legal and the UI
 * falls back to the section number.
 */
export const storylineSectionDefinition = (name: string): StorylineCollectionDefinition => ({
    name,
    maxRecords: STORYLINE_SECTION_MAX_RECORDS,
    fields: [
        { key: 'order', type: 'integer', sortable: true, default: 0 },
        { key: 'heading', type: 'text', maxLength: STORYLINE_SECTION_HEADING_MAX_LENGTH },
        { key: 'content', type: 'text', maxLength: STORYLINE_SECTION_TEXT_MAX_LENGTH }
    ]
});

/** Every collection this package guarantees, with its definition. */
export const storylineCollectionDefinitions = (): readonly StorylineCollectionDefinition[] =>
    STORYLINE_COLLECTION_NAMES.map((name) => storylineSectionDefinition(name));

// ---------------------------------------------------------------------------
// The ensure
// ---------------------------------------------------------------------------

/**
 * True when a rejection means "the collection is already there", i.e. the state we
 * wanted. The engine codes its refusals three ways on purpose (core/records.ts:195-198:
 * the code is `error.name`, `error.code`, AND the first token of the message), so all
 * three spellings are checked — a `Tool "records" failed: collection-exists: …` string
 * reaching us through a wrapper is still the success case.
 */
export const isCollectionExistsError = (error: unknown): boolean => {
    if (error === null || typeof error !== 'object') return false;

    const coded = error as { code?: unknown; name?: unknown; message?: unknown };

    if (coded.code === COLLECTION_EXISTS_CODE || coded.name === COLLECTION_EXISTS_CODE) return true;

    return typeof coded.message === 'string' && coded.message.includes(COLLECTION_EXISTS_CODE);
};

/** The collection names this harness already has. A pure `records()` read, no tool call. */
export const definedStorylineCollections = (harness: Harness): string[] =>
    harness
        .records()
        .collections.map((collection) => collection.name)
        .filter((name) => (STORYLINE_COLLECTION_NAMES as readonly string[]).includes(name));

/**
 * Make sure `outlines` and `storyline` exist on this session's harness.
 *
 * Returns the names it actually created this call, so a caller (and a test) can tell a
 * first define from a no-op. It never throws for a collection that already exists — the
 * pre-check skips it, and a `collection-exists` refusal that races the pre-check is
 * swallowed for the same reason. Anything else (a malformed definition, a harness
 * without the `records` tool) DOES throw, because that is a bug worth seeing rather than
 * a session that quietly lacks two folders.
 *
 * Why `executeTool` and not `runtime.executeRecords`: `executeTool` is the documented
 * host door to a registered tool (harness src/types/index.ts:3321) and it needs no
 * enabled-tool slot — `records` is `visibility: 'searchable'`, which gates what the
 * MODEL may call, not what the host may call. This call costs zero model turns.
 */
export const ensureStorylineCollections = async (harness: Harness): Promise<string[]> => {
    const present = new Set(definedStorylineCollections(harness));
    const created: string[] = [];

    for (const definition of storylineCollectionDefinitions()) {
        if (present.has(definition.name)) continue;

        try {
            await harness.executeTool('records', { define: definition });
            created.push(definition.name);
        } catch (error) {
            // The other owner (the UI's ensure, or a concurrent create) won the race.
            // That is the state we asked for, so it is a no-op and not a failure.
            if (isCollectionExistsError(error)) continue;

            throw error;
        }
    }

    return created;
};
