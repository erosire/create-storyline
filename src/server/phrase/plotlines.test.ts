// PHRASE ② — PLOTLINES as a domain layer, and the two phrases coexisting on one book.
//
// WHAT THIS FILE PINS, in the order the Author meets it: the CONTROLLER REGISTRY (the next wave's only
// way in), the START (a phrase instance whose seed is a COPY), the per-phrase DIAL, the BRIEF (a chapter
// count becomes N entry rows in one step), the INSTALL (a chapter text and that chapter's `plotlines`
// contract, in one commit, updated BY ORDER on a redraft), the ARITY of each phrase, the CLAIM-KEY and
// EXCLUSION disjointness of two phrases on one Story, and the refusal an unmapped phrase kind gets
// instead of a silent no-op.
//
// WHY EXACT VALUES: every refusal sentence here is what a failed structured run shows the Author, and
// every row list is what the rail renders. The install assertions name the `plotlines` rows field by
// field because P4's rule ("one chapter, one contract") is a fact about those rows and nothing else —
// an insert instead of an update, or an engine flag overwritten by a Writer, both read as a healthy
// store unless the fields are pinned.
//
// THE FIXTURE: `run/mock.ts:seedStory` + `ensurePhraseCatalog` with `recordUidAt`, the same id-pinned
// setup `revisions.test.ts` uses, so the ids in these expectations are literals a reader can point at.
import { describe, expect, it } from 'vitest';
import { Store } from '../store';
import { AUTHOR_ATTR, seedStory } from '../run/mock';
import { recordUidAt } from '../store/persist';
import {
    ensurePhraseCatalog,
    isGroupManagedStory,
    isPhraseGroupManaged,
    phraseGroupsOf,
    phraseGroupsOfPhrase,
    phraseSeedInitOf,
    phraseSeedOf,
    primaryPhraseOf,
    storyPhrase,
    storyPhraseByKey
} from './catalog';
import {
    acceptPlotlineBrief,
    createPlotlineBrief,
    ensureChapterGroups,
    isPlotlinesStarted,
    plotlinesPhraseController,
    startPlotlinesPhrase
} from './controllers/plotlines';
import { summaryPhraseController } from './controllers/summary';
import { enabledPhraseControllers, phraseController, phraseControllerOf, startedPhraseControllers } from './controller';
import {
    GROUP_DRAFT_ITEM_PREFIX,
    groupDraftClaimRef,
    groupPipelineOwed,
    groupWorkTargets,
    heldGroupRefs,
    liveGroupRefs,
    liveGroupSets,
    partitionGroups,
    planGroupDraftBatch
} from './exclusion';
import { chapterEntryContent, parseChapterDraftAnswer, type PlotpointFields } from './plotpoints';
import { groupRevisionVector, installGroupRevisions } from './revisions';
import type { PhraseGroup, Plotline, Story } from '../../shared/types';

/** The compiled Summary the Author hands Phrase ② — its seed, copied, never `stories.idea`. */
const PLOTLINES_SEED = 'Premise: a cartographer returns. Promise: the map reconciles. Ending: she floods the valley.';

/** A Summary-only book, with the catalog minted at literal ids. */
function seedBook() {
    const store = Store.empty();
    const story = seedStory(store, { phase: 'summary' });
    let next = 0;
    const newId = () => recordUidAt(next++);
    const ensured = ensurePhraseCatalog(store, story, AUTHOR_ATTR, { newId })!;

    return { store, story, phrase: ensured.phrase, groups: ensured.groups, newId, nextIdOf: () => next };
}

/**
 * A book with BOTH phrases: the dials on, Phrase ② started on `PLOTLINES_SEED`, and its brief written
 * (a DRAFT — the chapter rows only exist once the brief is accepted).
 *
 * The story object returned is the UPDATED row, because the dial write bumps `rev` and every later
 * compare-and-set in these tests needs the current one.
 */
function plotlinesBook(chapterCount = 3) {
    const book = seedBook();
    const story = book.store.stories.update(
        book.story.id,
        { summary_mode: 'groups', plotlines_mode: 'groups' },
        AUTHOR_ATTR,
        [{ id: book.story.id, rev: book.story.rev }]
    );
    // Phrase ①'s ensure minted ids 0..5, so Phrase ② starts at 20 and its entries at 21+ — every id in
    // this file is a literal a reader can compute.
    let next = 20;
    const newId = () => recordUidAt(next++);
    const started = startPlotlinesPhrase(book.store, story, PLOTLINES_SEED, AUTHOR_ATTR, { newId });

    const brief = createPlotlineBrief(book.store, story, started.phrase, { chapter_count: chapterCount }, AUTHOR_ATTR);

    return { ...book, story, plotlines: started.phrase, brief, newId };
}

/** The chapter entries of a book whose brief has been ACCEPTED, with ids continuing from the start. */
function acceptedBook(chapterCount = 3) {
    const book = plotlinesBook(chapterCount);
    const accepted = acceptPlotlineBrief(book.store, book.story, book.brief, AUTHOR_ATTR, { newId: book.newId });

    return { ...book, accepted, chapters: accepted.groups };
}

const groupOfKey = (groups: PhraseGroup[], key: string) => groups.find((group) => group.key === key)!;

/** One chapter's plotpoints, keyed by chapter number so the expectations stay readable. */
function plotpointsFor(chapter: number): PlotpointFields {
    if (chapter === 1) {
        return {
            heading: 'The return',
            must_happen: 'Mara walks the drowned road.',
            must_change: 'She knows the valley is flooded on purpose.',
            pov: 'Mara',
            setups: 'The drowned road'
        };
    }

    if (chapter === 2) {
        return {
            heading: 'The interview',
            must_happen: 'The engineer refuses to show the file.',
            must_change: 'Mara leaves with the file.'
        };
    }

    return { must_happen: 'The dam gate opens.', must_change: 'The valley is water again.' };
}

/** The exact stored text of one chapter entry — the labelled block, blanks omitted, no `##` heading. */
const CHAPTER_CONTENT: Record<number, string> = {
    1: [
        'Heading: The return',
        'Must happen: Mara walks the drowned road.',
        'Must change: She knows the valley is flooded on purpose.',
        'POV: Mara',
        'Setups: The drowned road'
    ].join('\n'),
    2: ['Heading: The interview', 'Must happen: The engineer refuses to show the file.', 'Must change: Mara leaves with the file.'].join(
        '\n'
    ),
    3: ['Must happen: The dam gate opens.', 'Must change: The valley is water again.'].join('\n')
};

/** Every field of a `plotlines` row the phrase layer owns, so an overwritten flag cannot hide. */
const contractRowOf = (row: Plotline) => ({
    id: row.id,
    story_id: row.story_id,
    order: row.order,
    heading: row.heading,
    must_happen: row.must_happen,
    must_change: row.must_change,
    pov: row.pov,
    setups: row.setups,
    payoffs: row.payoffs,
    contract_locked: row.contract_locked,
    aligned: row.aligned,
    needs_recheck: row.needs_recheck
});

/** A live Writer run of the draft family — the only thing the exclusion reads (R4). */
function seedGroupRun(store: Store, storyId: string, workItemRef: string, groupRefs?: string[]) {
    store.runs.create(
        {
            story_id: storyId,
            work_item_ref: workItemRef,
            role: 'writer',
            state: 'working',
            started_at: '2026-11-25T10:00:00.000Z',
            tokens: 0,
            kind: 'work',
            delegated: [],
            ...(groupRefs === undefined ? {} : { group_refs: groupRefs })
        },
        { run_ref: null, author: false, why: 'seed: a live group run for the two-phrase exclusion (R4)' }
    );
}

// ---------------------------------------------------------------------------------------------
// The registry — the interface the next wave dispatches through
// ---------------------------------------------------------------------------------------------

describe('the phrase controller registry', () => {
    it('answers both phrases in catalog order, each with its own answer contract', () => {
        expect(enabledPhraseControllers().map((controller) => controller.key)).toEqual(['summary', 'plotlines']);
        expect(phraseController('summary')).toBe(summaryPhraseController);
        expect(phraseController('plotlines')).toBe(plotlinesPhraseController);
        expect(phraseController('retired')).toBeUndefined();

        // The two structured contracts: the names a run records, and the ITEM-level required set — the
        // Summary's `content` against the chapter's two plotpoints. This is the pair a prompt compiler
        // must not confuse.
        expect(summaryPhraseController.answer.name).toBe('GroupDraft');
        expect(plotlinesPhraseController.answer.name).toBe('ChapterDraft');

        const itemRequired = (schema: unknown) =>
            (schema as { properties: { groups: { items: { required: string[] } } } }).properties.groups.items.required;

        expect((summaryPhraseController.answer.schema as { required: string[] }).required).toEqual(['groups', 'knowledge_used']);
        expect((plotlinesPhraseController.answer.schema as { required: string[] }).required).toEqual(['groups', 'knowledge_used']);
        expect(itemRequired(summaryPhraseController.answer.schema)).toEqual(['group_ref', 'content']);
        expect(itemRequired(plotlinesPhraseController.answer.schema)).toEqual(['group_ref', 'must_happen', 'must_change']);

        // Each controller is bound to its catalog definition, so a registry lookup and a catalog read
        // cannot disagree about what a phrase is.
        expect(summaryPhraseController.definition.key).toBe('summary');
        expect(plotlinesPhraseController.definition.key).toBe('plotlines');
    });

    it('finds the controller of a ROW, and the started phrases of a book in composition order', () => {
        const book = plotlinesBook();

        expect(startedPhraseControllers(book.store, book.story).map((controller) => controller.key)).toEqual([
            'summary',
            'plotlines'
        ]);
        expect(phraseControllerOf(book.store, book.story.id, book.plotlines.id)).toBe(plotlinesPhraseController);
        expect(phraseControllerOf(book.store, book.story.id, book.phrase.id)).toBe(summaryPhraseController);
        expect(phraseControllerOf(book.store, book.story.id, recordUidAt(99))).toBeUndefined();

        // A book with only the Summary started reports only the Summary — the shape every existing book
        // has, which is why this read must not become "every enabled phrase".
        const solo = seedBook();

        expect(startedPhraseControllers(solo.store, solo.story).map((controller) => controller.key)).toEqual(['summary']);
    });

    it('carries its own engine-owned instruction text for both phrases', () => {
        // These are the ANSWER CONTRACTS in the engine's voice (R7), and the chapter ones are not the
        // Summary's: a chapter answer owes plotpoints, not prose. Pinned at the head of each so a reword
        // that drops the contract sentence shows up here.
        expect(summaryPhraseController.instructions.draft).toContain('`groups`');
        expect(plotlinesPhraseController.instructions.draft).toContain('`must_happen`');
        expect(plotlinesPhraseController.instructions.review).toContain('chapter');
        expect(plotlinesPhraseController.instructions.score).toContain('0 to 100');
        expect(plotlinesPhraseController.instructions.lock).toContain('chapter');
    });
});

// ---------------------------------------------------------------------------------------------
// The start: the seed is a COPY (seam S2)
// ---------------------------------------------------------------------------------------------

describe('starting Phrase ② with its own copied seed', () => {
    it('a Story created after this change still gets exactly one phrase row — the Summary, seed copied', () => {
        const book = seedBook();

        // THE CATALOG-DATA CONSEQUENCE, pinned at the row level: Phrase ② is enabled, and story creation
        // still mints the single row it always minted.
        expect(book.store.phrases.list().map((row) => [row.key, row.order, row.seed])).toEqual([['summary', 1, book.story.idea]]);
        expect(book.store.phraseGroups.list().map((row) => [row.key, row.phrase_id])).toEqual([
            ['premise', book.phrase.id],
            ['promise', book.phrase.id],
            ['theme', book.phrase.id],
            ['tone', book.phrase.id],
            ['ending', book.phrase.id]
        ]);
        expect(book.phrase.group_refs).toEqual(book.groups.map((group) => group.id));
    });

    it('creates a second phrase row, seeded from the text handed in — not from stories.idea', () => {
        const book = plotlinesBook();
        const phrase = book.store.phrases.require(book.plotlines.id);

        expect(phrase.id).toBe(recordUidAt(20));
        expect(phrase.story_id).toBe('story_0');
        expect(phrase.key).toBe('plotlines');
        expect(phrase.title).toBe('Plotlines Phrase');
        expect(phrase.order).toBe(2);
        expect(phrase.revision).toBe(0);
        expect(phrase.content).toBe('');
        // The start creates NO entries: the chapter count is the brief's decision.
        expect(phrase.group_refs).toEqual([]);
        expect(phrase.seed).toBe(PLOTLINES_SEED);
        expect(phraseSeedOf(phrase, book.story)).toBe(PLOTLINES_SEED);
        expect(isPlotlinesStarted(book.store, book.story.id)).toBe(true);

        // Two rows now, and Phrase ① is untouched: the Summary stays the PRIMARY phrase, so every
        // existing unscoped read keeps answering the Summary after this second row exists.
        expect(book.store.phrases.list().map((row) => row.key)).toEqual(['summary', 'plotlines']);
        expect(storyPhraseByKey(book.store, book.story.id, 'plotlines')?.id).toBe(phrase.id);
        expect(storyPhrase(book.store, book.story.id)?.id).toBe(book.phrase.id);
        expect(primaryPhraseOf(book.store, book.story.id)?.id).toBe(book.phrase.id);
        expect(book.store.phraseGroups.list().map((row) => row.key)).toEqual([
            'premise',
            'promise',
            'theme',
            'tone',
            'ending'
        ]);
    });

    it('freezes the seed: editing the Story idea afterwards moves neither phrase', () => {
        const book = plotlinesBook();
        const originalIdea = book.story.idea;
        const edited = book.store.stories.update(
            book.story.id,
            { idea: 'A DIFFERENT IDEA ENTIRELY' },
            AUTHOR_ATTR,
            [{ id: book.story.id, rev: book.story.rev }]
        );

        // THE ACCEPTANCE PIN. Both phrases hash the text they were created with, so a Phrase ① edit (or a
        // delete) cannot invalidate a Phrase ② structure — and Phrase ①'s own seed, written at creation,
        // is its own fact too.
        expect(phraseSeedOf(book.store.phrases.require(book.plotlines.id), edited)).toBe(PLOTLINES_SEED);
        expect(phraseSeedOf(book.store.phrases.require(book.phrase.id), edited)).toBe(originalIdea);
        // `phraseSeedInitOf` is the definition's rule and nothing else: a `supplied` phrase takes the text
        // it was handed VERBATIM (the trim is the start's, before it calls this), and a `story_idea` one
        // reads the idea off the Story it is given.
        expect(phraseSeedInitOf(plotlinesPhraseController.definition, edited, '  Supplied text  ')).toBe('  Supplied text  ');
        expect(phraseSeedInitOf(summaryPhraseController.definition, edited)).toBe('A DIFFERENT IDEA ENTIRELY');
    });

    it('refuses an empty seed and a second start, before writing anything', () => {
        const book = seedBook();

        expect(() => startPlotlinesPhrase(book.store, book.story, '   ', AUTHOR_ATTR)).toThrow(
            `startPlotlinesPhrase: story ${book.story.id} was started with an empty seed — the text handed to Phrase ② becomes its seed, and a blank one would be hashed by every gate as though it were the Author's input`
        );
        expect(book.store.phrases.list()).toHaveLength(1);

        const beforeStart = book.store.journal.length;
        const first = startPlotlinesPhrase(book.store, book.story, PLOTLINES_SEED, AUTHOR_ATTR, { newId: () => recordUidAt(20) });

        // One journal line for the phrase row: a start with no entries writes no `group_refs` update.
        expect(book.store.journal.length).toBe(beforeStart + 1);

        expect(() => startPlotlinesPhrase(book.store, book.story, 'Other text', AUTHOR_ATTR)).toThrow(
            `startPlotlinesPhrase: story ${book.story.id} already has a Plotlines Phrase (${first.phrase.id}) — its seed is the input every entry, revision and claim key was written against, so a new seed needs a new phrase, not a re-seeded one`
        );
        expect(book.store.phrases.list()).toHaveLength(2);
        expect(book.store.phrases.require(first.phrase.id).seed).toBe(PLOTLINES_SEED);

        // The CONTROLLER is the idempotent form a retrying route wants: it reports `started: false`
        // instead of throwing, and re-starting never re-seeds or re-writes.
        const beforeRetry = book.store.journal.length;
        const again = plotlinesPhraseController.start(book.store, book.story, AUTHOR_ATTR);

        expect(again.started).toBe(false);
        expect(again.phrase.id).toBe(first.phrase.id);
        expect(book.store.journal.length).toBe(beforeRetry);
    });

    it('refuses a controller start with no seed text', () => {
        const book = seedBook();

        expect(() => plotlinesPhraseController.start(book.store, book.story, AUTHOR_ATTR)).toThrow(
            `plotlinesPhraseController.start: phrase 2 needs the seed text to copy (the compiled Summary, or the Author's own text) — story ${book.story.id}`
        );
        expect(isPlotlinesStarted(book.store, book.story.id)).toBe(false);
    });
});

// ---------------------------------------------------------------------------------------------
// The dials (per phrase, read off the Story setting)
// ---------------------------------------------------------------------------------------------

describe('the per-phrase dial', () => {
    it('answers each phrase from its own Story field', () => {
        const book = plotlinesBook();
        const dials = (story: Story | undefined) => ({
            summary: isPhraseGroupManaged(story, 'summary'),
            plotlines: isPhraseGroupManaged(story, 'plotlines'),
            // The legacy predicate is the Summary's, and it is untouched by any of this.
            legacy: isGroupManagedStory(story)
        });

        expect(dials(book.story)).toEqual({ summary: true, plotlines: true, legacy: true });

        const classic = book.store.stories.update(
            book.story.id,
            { plotlines_mode: 'classic' },
            AUTHOR_ATTR,
            [{ id: book.story.id, rev: book.story.rev }]
        );

        expect(dials(classic)).toEqual({ summary: true, plotlines: false, legacy: true });

        // A dial that was never written reads "not managed", which is what keeps a legacy book — one with
        // phrase rows from an import but no `plotlines_mode` field at all — out of chapter work.
        const solo = seedBook();

        expect(dials(solo.story)).toEqual({ summary: false, plotlines: false, legacy: false });
        expect(dials(undefined)).toEqual({ summary: false, plotlines: false, legacy: false });
        expect(plotlinesPhraseController.isManaged(classic)).toBe(false);
        expect(plotlinesPhraseController.isManaged(book.story)).toBe(true);
        expect(summaryPhraseController.isManaged(book.story)).toBe(true);
    });
});

// ---------------------------------------------------------------------------------------------
// The brief: N chapters, materialized in one step
// ---------------------------------------------------------------------------------------------

describe('the Plotline brief: accept materializes the whole chapter set', () => {
    it('writes a draft brief hashed against the phrase seed, and creates no entries yet', () => {
        const book = plotlinesBook(4);

        expect(book.brief.id).toBe('plotline_brief_0');
        expect(book.brief.story_id).toBe('story_0');
        expect(book.brief.phrase_id).toBe(book.plotlines.id);
        expect(book.brief.chapter_count).toBe(4);
        expect(book.brief.status).toBe('draft');
        // `seedHashOf` of the phrase's OWN seed (the same 8-hex truncation the Seed briefs use), so a
        // Phrase ① edit cannot make this structure stale. Pinned as a literal: it is a pure function of
        // `PLOTLINES_SEED`, and it is the value the accept refusal quotes back.
        expect(book.brief.seed_hash).toBe('97b0e9e1');
        expect(book.brief.chapters).toBeUndefined();
        expect(book.store.phrases.require(book.plotlines.id).group_refs).toEqual([]);
        // And the family prefix proves the registry order is doing its job: a `plotline_brief_0` id is
        // NOT read as the `plotline` family (see `shared/types.test.ts` and `store/record-identity.test.ts`).
        expect(book.store.plotlines.list()).toEqual([]);
    });

    it('accepting creates all N entries in one step, in chapter order, and syncs the count', () => {
        const book = acceptedBook(4);
        const accepted = book.accepted;

        expect(accepted.created_group_ids).toEqual([recordUidAt(21), recordUidAt(22), recordUidAt(23), recordUidAt(24)]);
        expect(accepted.groups.map((group) => [group.key, group.title, group.order])).toEqual([
            ['chapter_1', 'Chapter 1', 1],
            ['chapter_2', 'Chapter 2', 2],
            ['chapter_3', 'Chapter 3', 3],
            ['chapter_4', 'Chapter 4', 4]
        ]);
        expect(accepted.groups.map((group) => group.phrase_id)).toEqual([book.plotlines.id, book.plotlines.id, book.plotlines.id, book.plotlines.id]);
        expect(accepted.groups.map((group) => [group.content, group.revision])).toEqual([
            ['', 0],
            ['', 0],
            ['', 0],
            ['', 0]
        ]);
        // The phrase's ordered entry list is the chapter set — the composition order R6's read walks.
        expect(book.store.phrases.require(book.plotlines.id).group_refs).toEqual(accepted.created_group_ids);
        // D-3b: the chapter COUNT is the Editor's decision, written only onto the primitive.
        expect(accepted.summary_ref).toBe('summary_0');
        expect(accepted.chapter_count_synced).toBe(true);
        expect(book.store.summaries.require('summary_0').chapter_count).toBe(4);
        expect(accepted.brief.status).toBe('accepted');

        // Phrase ① is untouched: the five Summary groups still belong to the Summary row, and the
        // mirrored prose fields are still the seeded ones.
        expect(phraseGroupsOf(book.store, book.story.id, book.phrase.id).map((group) => group.key)).toEqual([
            'premise',
            'promise',
            'theme',
            'tone',
            'ending'
        ]);
        expect(book.store.summaries.require('summary_0').premise).toBe('A return to a mapped valley that no longer matches the map.');

        // Idempotent by skipping: a second accept creates no rows, writes no count, and journals nothing.
        const events = book.store.journal.length;
        const again = acceptPlotlineBrief(book.store, book.story, accepted.brief, AUTHOR_ATTR, { newId: book.newId });

        expect(again.created_group_ids).toEqual([]);
        expect(again.chapter_count_synced).toBe(false);
        expect(again.groups.map((group) => group.id)).toEqual(accepted.groups.map((group) => group.id));
        expect(book.store.journal.length).toBe(events);
    });

    it('refuses a brief whose seed hash no longer matches the phrase', () => {
        const book = plotlinesBook(3);
        const stale = { ...book.brief, seed_hash: 'deadbeefdeadbeef' };

        expect(() => acceptPlotlineBrief(book.store, book.story, stale, AUTHOR_ATTR, { newId: book.newId })).toThrow(
            `acceptPlotlineBrief: brief ${book.brief.id} was structured from seed hash deadbeefdeadbeef and this phrase's seed hashes ${book.brief.seed_hash} — a structure for a different seed cannot declare this book's chapters`
        );
        expect(book.store.phraseGroups.list().map((row) => row.key)).toEqual(['premise', 'promise', 'theme', 'tone', 'ending']);
        expect(book.store.summaries.require('summary_0').chapter_count).toBe(3);
    });

    it('grows a shrinking count without deleting entries, and keeps an existing chapter row intact', () => {
        const book = acceptedBook(4);
        const chapter2 = groupOfKey(book.chapters, 'chapter_2');

        // Re-ensure with a SMALLER count, on the phrase row the ACCEPT returned (the CAS in
        // `ensureChapterGroups` needs the current `rev`, which the accept's `group_refs` write moved).
        const fewer = ensureChapterGroups(book.store, book.story, book.accepted.phrase, 2, AUTHOR_ATTR, { newId: book.newId });

        expect(fewer.created_group_ids).toEqual([]);
        expect(fewer.groups.map((group) => group.key)).toEqual(['chapter_1', 'chapter_2', 'chapter_3', 'chapter_4']);
        expect(book.store.phrases.require(book.plotlines.id).group_refs).toEqual([recordUidAt(21), recordUidAt(22)]);
        expect(book.store.phraseGroups.require(chapter2.id).order).toBe(2);

        // And a count of 0 asks for no entries at all, which is reported rather than guessed.
        const current = book.store.phrases.require(book.plotlines.id);

        expect(ensureChapterGroups(book.store, book.story, current, 0, AUTHOR_ATTR, { newId: book.newId })).toEqual({
            groups: [],
            created_group_ids: []
        });
    });
});

// ---------------------------------------------------------------------------------------------
// The install: the entry text AND the chapter's contract, in one commit
// ---------------------------------------------------------------------------------------------

describe('installing a chapter batch (P4, and the explicit mirror of seam S3)', () => {
    it('writes one revision per chapter and one contract row per chapter, in the same commit', () => {
        const book = acceptedBook(3);
        const entries = book.chapters.map((group, index) => ({
            group,
            content: CHAPTER_CONTENT[index + 1],
            plotpoints: plotpointsFor(index + 1)
        }));

        const result = installGroupRevisions(book.store, book.story, entries, AUTHOR_ATTR, {
            runRef: 'run_7',
            workItemRef: 'wi_draft_groups_summary_0_set1_a1'
        });

        expect(result.installed.map((row) => [row.group_key, row.number, row.state, row.content])).toEqual([
            ['chapter_1', 1, 'latest', CHAPTER_CONTENT[1]],
            ['chapter_2', 1, 'latest', CHAPTER_CONTENT[2]],
            ['chapter_3', 1, 'latest', CHAPTER_CONTENT[3]]
        ]);
        expect(result.installed.map((row) => row.story_id)).toEqual(['story_0', 'story_0', 'story_0']);
        expect(result.archived).toEqual([]);
        expect(result.groups.map((group) => [group.key, group.revision])).toEqual([
            ['chapter_1', 1],
            ['chapter_2', 1],
            ['chapter_3', 1]
        ]);

        // THE PLOTLINE CONTRACTS, field by field. `''` on the optionals the answer left out is
        // `createPlotline`'s own behaviour, and the engine flags are the create-side defaults.
        expect(result.contracts).toEqual({ created: ['plotline_0', 'plotline_1', 'plotline_2'], updated: [] });
        expect(book.store.plotlines.list().map(contractRowOf)).toEqual([
            {
                id: 'plotline_0',
                story_id: 'story_0',
                order: 1,
                heading: 'The return',
                must_happen: 'Mara walks the drowned road.',
                must_change: 'She knows the valley is flooded on purpose.',
                pov: 'Mara',
                setups: 'The drowned road',
                payoffs: '',
                contract_locked: false,
                aligned: false,
                needs_recheck: false
            },
            {
                id: 'plotline_1',
                story_id: 'story_0',
                order: 2,
                heading: 'The interview',
                must_happen: 'The engineer refuses to show the file.',
                must_change: 'Mara leaves with the file.',
                pov: '',
                setups: '',
                payoffs: '',
                contract_locked: false,
                aligned: false,
                needs_recheck: false
            },
            {
                id: 'plotline_2',
                story_id: 'story_0',
                order: 3,
                heading: '',
                must_happen: 'The dam gate opens.',
                must_change: 'The valley is water again.',
                pov: '',
                setups: '',
                payoffs: '',
                contract_locked: false,
                aligned: false,
                needs_recheck: false
            }
        ]);

        // THE MIRROR IS EXPLICIT, not an empty fallthrough: Phrase ② has no prose mirror, and it says so.
        expect(result.mirror).toEqual({ summary_id: null, fields: [], written: false, reason: 'not_summary_phrase' });
        // And the legacy record really is untouched.
        expect(book.store.summaries.require('summary_0').chapter_count).toBe(3);

        // The PHRASE row composes the chapters, in chapter order, and only its own row moved.
        expect(result.phrase.id).toBe(book.plotlines.id);
        expect(result.phrase.revision).toBe(1);
        expect(result.phrase.content).toBe(
            `## Chapter 1\n${CHAPTER_CONTENT[1]}\n\n## Chapter 2\n${CHAPTER_CONTENT[2]}\n\n## Chapter 3\n${CHAPTER_CONTENT[3]}`
        );
        expect(book.store.phrases.require(book.phrase.id).content).toBe('');
        expect(book.store.phrases.require(book.phrase.id).revision).toBe(0);

        // The vectors are phrase-scoped: the chapter install moved the chapter vector, and the Summary's
        // five groups still read 0.
        expect(groupRevisionVector(book.store, book.story.id, book.plotlines.id)).toEqual({
            [recordUidAt(21)]: 1,
            [recordUidAt(22)]: 1,
            [recordUidAt(23)]: 1
        });
        expect(Object.values(groupRevisionVector(book.store, book.story.id))).toEqual([0, 0, 0, 0, 0]);
    });

    it('redrafts a chapter by ORDER: the same contract row, and nobody else’s flags', () => {
        const book = acceptedBook(3);
        const install = (chapter: number, plotpoints: PlotpointFields, group: PhraseGroup) =>
            installGroupRevisions(
                book.store,
                book.story,
                [{ group, content: chapterEntryContent(group, plotpoints), plotpoints }],
                AUTHOR_ATTR,
                { runRef: 'run_8' }
            );

        install(1, plotpointsFor(1), groupOfKey(book.chapters, 'chapter_1'));

        // An AUTHOR-side verdict and an invalidation flag sit on chapter 1's contract: a Writer's redraft
        // may rewrite the contract's TEXT and must not touch either.
        const first = book.store.plotlines.require('plotline_0');
        const judged = book.store.plotlines.update(
            first.id,
            { aligned: true, needs_recheck: true },
            AUTHOR_ATTR,
            [{ id: first.id, rev: first.rev }]
        );

        const redraft = install(
            1,
            { heading: 'The return, again', must_happen: 'Mara walks the dyke instead.', must_change: 'She burns the map.' },
            book.store.phraseGroups.require(recordUidAt(21))
        );

        expect(redraft.contracts).toEqual({ created: [], updated: ['plotline_0'] });
        // A redraft is one contract row, rewritten — never a second contract for chapter 1.
        expect(book.store.plotlines.list().map((row) => [row.id, row.order])).toEqual([['plotline_0', 1]]);

        const after = book.store.plotlines.require('plotline_0');

        expect(after.id).toBe(judged.id);
        expect(after.rev).toBe(judged.rev + 1);
        expect(after.heading).toBe('The return, again');
        expect(after.must_happen).toBe('Mara walks the dyke instead.');
        expect(after.must_change).toBe('She burns the map.');
        // Every optional is WRITTEN, blank included: the redraft promised no POV, so the row has none.
        expect(after.pov).toBe('');
        expect(after.setups).toBe('');
        expect(after.payoffs).toBe('');
        expect([after.contract_locked, after.aligned, after.needs_recheck]).toEqual([false, true, true]);

        // The chapter's revision LINE keeps its own history (one row per accepted text, highest is latest).
        expect(book.store.groupRevisions.list().map((row) => [row.group_key, row.number, row.state])).toEqual([
            ['chapter_1', 1, 'archived'],
            ['chapter_1', 2, 'latest']
        ]);

        // A redraft out of ORDER still lands on its own chapter. Chapter 3 is installed BEFORE chapter 2,
        // so the counter mints its row second — and the JOIN is still the chapter number read off the
        // entry key, which is the only reason a Writer batch arriving in any order cannot duplicate a
        // chapter's contract (P4, and `createPlotline`'s refusal of a duplicate order).
        install(3, plotpointsFor(3), groupOfKey(book.chapters, 'chapter_3'));
        install(2, plotpointsFor(2), groupOfKey(book.chapters, 'chapter_2'));

        expect(book.store.plotlines.list().map((row) => [row.id, row.order, row.must_happen])).toEqual([
            ['plotline_0', 1, 'Mara walks the dyke instead.'],
            ['plotline_1', 3, 'The dam gate opens.'],
            ['plotline_2', 2, 'The engineer refuses to show the file.']
        ]);
    });

    it('refuses a chapter install that carries no plotpoints, before writing', () => {
        const book = acceptedBook(3);
        const events = book.store.journal.length;

        expect(() =>
            installGroupRevisions(book.store, book.story, [{ group: book.chapters[0]!, content: 'Just prose.' }], AUTHOR_ATTR)
        ).toThrow(
            // A template literal, because the message itself carries backticks around `plotlines` and an
            // apostrophe in "pass's" — a single-quoted copy of it would end at the apostrophe.
            'installGroupRevisions: chapter_1 arrived without plotpoints — a chapter entry install has to carry the contract it writes, or the `plotlines` row it mirrors keeps the previous pass\u0027s plotpoints (P4)'
        );
        expect(book.store.groupRevisions.list()).toEqual([]);
        expect(book.store.plotlines.list()).toEqual([]);
        expect(book.store.journal.length).toBe(events);
    });

    it('refuses a phrase kind with no declared downstream sync instead of mirroring nothing (seam S3)', () => {
        const book = acceptedBook(3);
        // A phrase row of an UNKNOWN kind, with one entry row under it — the shape a third phrase kind
        // takes before anyone has said what its install mirrors.
        const mystery = book.store.phrases.createWithId(
            recordUidAt(40),
            {
                story_id: book.story.id,
                key: 'mystery',
                title: 'Mystery Phrase',
                description: 'A kind the install has no sync for.',
                content: '',
                order: 3,
                revision: 0,
                group_refs: [recordUidAt(41)]
            },
            AUTHOR_ATTR
        );
        const entry = book.store.phraseGroups.createWithId(
            recordUidAt(41),
            {
                story_id: book.story.id,
                phrase_id: mystery.id,
                key: 'mystery_entry',
                title: 'Mystery Entry',
                description: 'An entry of an unknown kind.',
                order: 1,
                content: '',
                revision: 0,
                updated_by: null
            },
            AUTHOR_ATTR
        );
        const events = book.store.journal.length;

        expect(() => installGroupRevisions(book.store, book.story, [{ group: entry, content: 'Text.' }], AUTHOR_ATTR)).toThrow(
            'installGroupRevisions: the "mystery" phrase has no declared downstream sync — a new phrase kind must say what its install writes below the entry rows instead of installing a batch that silently mirrors nothing (seam S3)'
        );
        expect(book.store.groupRevisions.list()).toEqual([]);
        expect(book.store.journal.length).toBe(events);
    });
});

// ---------------------------------------------------------------------------------------------
// The arity of each phrase (seam S12)
// ---------------------------------------------------------------------------------------------

describe('the arity and key namespace of each phrase', () => {
    it('accepts a chapter batch that answers exactly the chapters the job named', () => {
        const book = acceptedBook(3);
        const refs = book.chapters.map((group) => group.id);
        // The answer arrives in REVERSE order: the decision re-orders it into the phrase's composition
        // order, so two identical answers journal identical rows.
        const answer = {
            groups: [...book.chapters].reverse().map((group, index) => {
                const chapter = 3 - index;
                const plotpoints = plotpointsFor(chapter);

                return {
                    group_ref: group.id,
                    heading: plotpoints.heading ?? '',
                    must_happen: plotpoints.must_happen,
                    must_change: plotpoints.must_change,
                    pov: plotpoints.pov ?? '',
                    setups: plotpoints.setups ?? '',
                    payoffs: plotpoints.payoffs ?? ''
                };
            }),
            knowledge_used: ['knowledge_1']
        };
        const decision = parseChapterDraftAnswer(book.store, book.story.id, book.plotlines.id, refs, answer);

        expect(decision.ok).toBe(true);

        if (decision.ok) {
            expect(decision.knowledgeUsed).toEqual(['knowledge_1']);
            expect(decision.contents.map((entry) => [entry.group.key, entry.content])).toEqual([
                ['chapter_1', CHAPTER_CONTENT[1]],
                ['chapter_2', CHAPTER_CONTENT[2]],
                ['chapter_3', CHAPTER_CONTENT[3]]
            ]);
            // The blank optionals are DROPPED from the fields, which is what makes them absent from the
            // stored block rather than empty labels.
            expect(decision.contents[0]!.plotpoints).toEqual({
                heading: 'The return',
                must_happen: 'Mara walks the drowned road.',
                must_change: 'She knows the valley is flooded on purpose.',
                pov: 'Mara',
                setups: 'The drowned road'
            });
            expect(decision.contents[2]!.plotpoints).toEqual({
                must_happen: 'The dam gate opens.',
                must_change: 'The valley is water again.'
            });
        }

        // The controller hook reaches the same parse without a phrase id, and its refusal is the honest
        // one for a book that has no Phrase ② at all.
        const viaController = plotlinesPhraseController.parseDraft(book.store, book.story, refs, answer);

        expect(viaController.ok).toBe(true);

        const noPhrase = seedBook();

        expect(plotlinesPhraseController.parseDraft(noPhrase.store, noPhrase.story, [], answer)).toEqual({
            ok: false,
            refusal: `story ${noPhrase.story.id} has no Plotlines Phrase — a chapter draft answers the chapter entries of a started phrase, and this book has none to answer`
        });
    });

    it('refuses every chapter batch that does not answer the named chapter set exactly', () => {
        const book = acceptedBook(3);
        const [chapter1, chapter2, chapter3] = book.chapters;
        const refs = book.chapters.map((group) => group.id);
        const row = (group: PhraseGroup, chapter: number) => {
            const plotpoints = plotpointsFor(chapter);

            return {
                group_ref: group.id,
                must_happen: plotpoints.must_happen,
                must_change: plotpoints.must_change
            };
        };

        // Skipped chapter.
        expect(
            parseChapterDraftAnswer(book.store, book.story.id, book.plotlines.id, refs, {
                groups: [row(chapter1!, 1), row(chapter2!, 2)],
                knowledge_used: []
            })
        ).toEqual({
            ok: false,
            // The missing chapter is named by KEY, not by uuid: this sentence is what the Author reads.
            refusal: 'the answer left chapter_3 uncontracted — a batch that skips a chapter it was asked for installs nothing (R2)'
        });

        // A chapter nobody asked for (the job named two).
        expect(
            parseChapterDraftAnswer(book.store, book.story.id, book.plotlines.id, [chapter1!.id, chapter2!.id], {
                groups: [row(chapter1!, 1), row(chapter2!, 2), row(chapter3!, 3)],
                knowledge_used: []
            })
        ).toEqual({
            ok: false,
            refusal: `${chapter3!.id} was not one of the chapters this job asked for — writing a chapter nobody requested revises an untouched one (R2)`
        });

        // Answered twice.
        expect(
            parseChapterDraftAnswer(book.store, book.story.id, book.plotlines.id, [chapter1!.id, chapter2!.id, chapter3!.id], {
                groups: [row(chapter1!, 1), row(chapter1!, 1), row(chapter2!, 2), row(chapter3!, 3)],
                knowledge_used: []
            })
        ).toEqual({ ok: false, refusal: `${chapter1!.id} was answered twice in one answer — two contracts for one chapter is an ambiguous batch` });

        // A SUMMARY group answered inside a chapter batch: the namespaces are disjoint (seam S1).
        const premise = groupOfKey(book.groups, 'premise');

        expect(
            parseChapterDraftAnswer(book.store, book.story.id, book.plotlines.id, refs, {
                groups: [row(premise, 1), row(chapter1!, 1), row(chapter2!, 2), row(chapter3!, 3)],
                knowledge_used: []
            })
        ).toEqual({
            ok: false,
            refusal: `\`${premise.id}\` is not one of this phrase's chapter entries — a chapter draft answers for the chapter ids the job named, never for a key, a Summary group, or an invented id`
        });

        // A contract with no `must_change` is a chapter title, not a contract.
        expect(
            parseChapterDraftAnswer(book.store, book.story.id, book.plotlines.id, [chapter1!.id], {
                groups: [{ group_ref: chapter1!.id, must_happen: 'Mara walks the drowned road.', must_change: '   ' }],
                knowledge_used: []
            })
        ).toEqual({
            ok: false,
            // This refusal names the chapter by KEY (the two id-named refusals above identify a row a
            // Writer can re-read; this one is the sentence the Author is shown).
            refusal:
                'chapter_1 answered no must_change — a chapter contract has to say what happens and what is different afterwards, and an entry that says neither is a chapter title, not a contract'
        });

        // And no answer at all.
        expect(parseChapterDraftAnswer(book.store, book.story.id, book.plotlines.id, refs, { groups: [], knowledge_used: [] })).toEqual({
            ok: false,
            refusal: 'the ChapterDraft answer carried no `groups` entries'
        });
    });

    it('keeps the Summary on its own five-group arity, on the same book', () => {
        const book = acceptedBook(3);
        const summaryRefs = book.groups.map((group) => group.id);
        const chapter1 = groupOfKey(book.chapters, 'chapter_1');
        const prose = (group: PhraseGroup) => ({ group_ref: group.id, content: `The ${group.key} of this book.` });

        // Four of five, on a book that also has chapters: the missing group is named by KEY.
        expect(
            summaryPhraseController.parseDraft(book.store, book.story, summaryRefs, {
                groups: book.groups.slice(0, 4).map(prose),
                knowledge_used: []
            })
        ).toEqual({ ok: false, refusal: 'the answer left ending unwritten — a batch that skips a group it was asked for installs nothing (R2)' });

        // A chapter answered inside a Summary batch.
        expect(
            summaryPhraseController.parseDraft(book.store, book.story, summaryRefs, {
                groups: [...book.groups.map(prose), { group_ref: chapter1.id, content: 'A chapter contract.' }],
                knowledge_used: []
            })
        ).toEqual({
            ok: false,
            refusal: `\`${chapter1.id}\` is not one of this Story's phrase groups — a draft answers for the group ids the job named, never for a key or an invented id`
        });

        // All five, answered: the Summary's own arity is still 5 even with 3 chapter rows on the book —
        // the read that decides it is scoped to the phrase, not to the Story.
        const five = summaryPhraseController.parseDraft(book.store, book.story, summaryRefs, {
            groups: summaryRefs.map((id) => ({ group_ref: id, content: 'Text.' })),
            knowledge_used: []
        });

        expect(five.ok).toBe(true);
        expect(phraseGroupsOfPhrase(book.store, book.story.id, book.phrase.id).map((group) => group.key)).toEqual([
            'premise',
            'promise',
            'theme',
            'tone',
            'ending'
        ]);
        expect(phraseGroupsOfPhrase(book.store, book.story.id, book.plotlines.id).map((group) => group.key)).toEqual([
            'chapter_1',
            'chapter_2',
            'chapter_3'
        ]);
    });
});

// ---------------------------------------------------------------------------------------------
// Two phrases on one book: disjoint claim keys, disjoint exclusions
// ---------------------------------------------------------------------------------------------

describe('two phrases on one Story (seam S8)', () => {
    it('plans, partitions and counts each phrase from its own entry rows', () => {
        const book = acceptedBook(3);
        // The batch dial is set here rather than inherited, so the batch size below is a literal the
        // reader can see instead of a constant defined three files away.
        const story = book.store.stories.update(
            book.story.id,
            { summary_sampling: 2 },
            AUTHOR_ATTR,
            [{ id: book.story.id, rev: book.story.rev }]
        );
        const summaryTargets = groupWorkTargets(book.store, story);
        const chapterTargets = groupWorkTargets(book.store, story, book.plotlines.id);

        // The owed lists are phrase-scoped. Unscoped means the PRIMARY phrase, which is what every
        // existing loop call site means, and it does not gain chapters when Phrase ② is started.
        expect(summaryTargets.map((target) => target.group.key)).toEqual(['premise', 'promise', 'theme', 'tone', 'ending']);
        expect(chapterTargets.map((target) => target.group.key)).toEqual(['chapter_1', 'chapter_2', 'chapter_3']);

        // A chapter batch planned through the chapter scope, capped by the same dial the Summary uses.
        expect(planGroupDraftBatch(book.store, story, chapterTargets, book.plotlines.id).map((target) => target.group.key)).toEqual([
            'chapter_1',
            'chapter_2'
        ]);
        // And the Summary's own batch is the first two Summary groups — a chapter entry never enters it.
        expect(planGroupDraftBatch(book.store, story, summaryTargets).map((target) => target.group.key)).toEqual(['premise', 'promise']);

        // The drain probe counts the same two scopes, so its sentence about a Summary that still owes a
        // draft cannot be inflated by chapter work.
        expect(groupPipelineOwed(book.store, story)).toEqual({ drafts: 5, structuredReviews: 0, deepReviews: 0 });
        expect(groupPipelineOwed(book.store, story, book.plotlines.id)).toEqual({ drafts: 3, structuredReviews: 0, deepReviews: 0 });

        // A live chapter writer defers its chapter and nothing else.
        seedGroupRun(book.store, story.id, `wi_draft_groups_${book.plotlines.id}_set9_a1`, [book.chapters[0]!.id]);

        expect(heldGroupRefs(book.store, story.id, book.chapters.map((group) => group.id), book.plotlines.id)).toEqual([
            book.chapters[0]!.id
        ]);
        expect(heldGroupRefs(book.store, story.id, book.groups.map((group) => group.id))).toEqual([]);
        expect(partitionGroups(book.store, story.id, book.chapters, book.plotlines.id)).toEqual({
            free: [book.chapters[1]!, book.chapters[2]!],
            deferred: [book.chapters[0]!]
        });
        expect(partitionGroups(book.store, story.id, book.groups)).toEqual({ free: book.groups, deferred: [] });
    });

    it('names a different claim-key namespace for each phrase', () => {
        const book = acceptedBook(3);
        const summaryRef = summaryPhraseController.draftClaimRef(book.store, book.story);
        const plotlinesRef = plotlinesPhraseController.draftClaimRef(book.store, book.story);

        // Phrase ① contributes the `summaries` row id, exactly as it always did — the persisted
        // `wi_draft_groups_summary_0_…` keys survive this change byte for byte.
        expect(summaryRef).toBe('summary_0');
        // Phrase ② contributes its own phrase row id.
        expect(plotlinesRef).toBe(book.plotlines.id);
        expect(plotlinesRef).not.toBe(summaryRef);
        // A phrase that does not exist yet has nothing to key on, which the loop reads as "no job".
        const bare = seedBook();

        expect(plotlinesPhraseController.draftClaimRef(bare.store, bare.story)).toBe('');

        // THE LOOP-FACING FORM (seam S8): one call, scoped by the phrase the job is for. `phase1GroupCandidates`
        // builds `wi_draft_groups_<ref>_<set hash>_<attempt>` off this, so the two families cannot claim
        // each other's attempts after a restart.
        expect(groupDraftClaimRef(book.store, book.story)).toBe(summaryRef);
        expect(groupDraftClaimRef(book.store, book.story, book.plotlines.id)).toBe(plotlinesRef);
        expect(groupDraftClaimRef(book.store, book.story, recordUidAt(77))).toBe('');
        expect(`${GROUP_DRAFT_ITEM_PREFIX}_${summaryRef}_set1_a1`).not.toBe(`${GROUP_DRAFT_ITEM_PREFIX}_${plotlinesRef}_set1_a1`);
    });

    it('excludes each phrase’s writers from the other’s, including a run that named no groups', () => {
        const book = acceptedBook(3);
        // A live Summary draft run that carries NO `group_refs`: the fail-closed reading holds EVERY
        // group of the phrase being planned — and only that phrase's.
        seedGroupRun(book.store, book.story.id, 'wi_draft_groups_summary_0_set1_a1');

        expect(liveGroupSets(book.store, book.story.id, book.phrase.id)).toEqual([book.groups.map((group) => group.id)]);
        expect(liveGroupSets(book.store, book.story.id, book.plotlines.id)).toEqual([book.chapters.map((group) => group.id)]);

        // So a chapter is free while a Summary writer is live (the unscoped read answers for the PRIMARY
        // phrase, i.e. the Summary), and the Summary's groups are held against Summary work.
        expect(heldGroupRefs(book.store, book.story.id, book.groups.map((group) => group.id))).toEqual(
            book.groups.map((group) => group.id)
        );
        expect(heldGroupRefs(book.store, book.story.id, book.chapters.map((group) => group.id))).toEqual([]);

        // And a run that DID name its chapters holds exactly those chapters — on a book where it is the
        // only live run, which is the case that matters: it must not put the Summary's five groups behind
        // a chapter writer.
        const alone = acceptedBook(3);

        seedGroupRun(alone.store, alone.story.id, `wi_draft_groups_${alone.plotlines.id}_set2_a1`, [alone.chapters[1]!.id]);
        expect(heldGroupRefs(alone.store, alone.story.id, alone.groups.map((group) => group.id))).toEqual([]);
        // Scoped to Phrase ②, the same run holds only the chapter it named.
        expect([...liveGroupRefs(alone.store, alone.story.id, alone.plotlines.id)]).toEqual([alone.chapters[1]!.id]);
        expect(liveGroupSets(alone.store, alone.story.id, alone.phrase.id)).toEqual([[alone.chapters[1]!.id]]);
    });

    it('keeps a Summary choose scoped to the Summary’s own revision history', () => {
        // The discard sweep in `reviewed.ts` used to read "every revision of this Story", which is the
        // same set only while the Summary is the only phrase. With chapters installed first, a Summary
        // choose must leave the chapter history alone — pinned through the install the choose uses.
        const book = acceptedBook(3);
        const chapterInstall = installGroupRevisions(
            book.store,
            book.story,
            book.chapters.map((group, index) => ({ group, content: CHAPTER_CONTENT[index + 1], plotpoints: plotpointsFor(index + 1) })),
            AUTHOR_ATTR
        );
        const chapterRevisionIds = chapterInstall.installed.map((row) => row.id);
        const summaryInstall = installGroupRevisions(
            book.store,
            book.story,
            book.groups.map((group) => ({ group, content: `The ${group.key} of this book.` })),
            AUTHOR_ATTR
        );

        expect(summaryInstall.mirror).toEqual({
            summary_id: 'summary_0',
            fields: ['premise', 'promise', 'theme', 'tone', 'ending'],
            written: true
        });
        // Both histories exist, one per phrase, and neither install touched the other's rows.
        expect(book.store.groupRevisions.list().map((row) => row.group_key)).toEqual([
            'chapter_1',
            'chapter_2',
            'chapter_3',
            'premise',
            'promise',
            'theme',
            'tone',
            'ending'
        ]);
        expect(chapterRevisionIds.every((id) => book.store.groupRevisions.require(id).state === 'latest')).toBe(true);
        // The two phrase rows each hold their own composed text.
        expect(book.store.phrases.require(book.phrase.id).content.startsWith('## Premise')).toBe(true);
        expect(book.store.phrases.require(book.plotlines.id).content.startsWith('## Chapter 1')).toBe(true);
    });
});
