// THE PHRASE CATALOG AS DATA — what wave 1 added to `phrase.ts`, pinned at the data layer.
//
// WHY A SEPARATE FILE FROM THE EXISTING PHRASE TESTS: the Summary's five groups, their ranks and their
// mirror map were already pinned (in `../server/phrase/catalog.test.ts`, which reads this module through
// the catalog). What is NEW here is the second phrase: the catalog entry itself, the fact that it is
// enabled but NOT auto-created, the per-phrase key namespaces (seam S1), and the composition rule that
// takes a phrase-scoped rank. Those are pure-data facts, so they are pinned against the data.
//
// WHY EXACT VALUES: every one of these arrays is read by a prompt, a route, or the create path. The
// `starts_on_demand` flag decides whether a Story creation mints one `phrases` row or two, the entry
// definitions are the text a Writer prompt quotes for `chapter_3`, and `composePhraseContent`'s default
// rank is the reason a Summary call site composes byte-identically after this change. A range check on
// any of them would pass on a wrong value.
import { describe, expect, it } from 'vitest';
import {
    PHRASE_CATALOG,
    PHRASE_PLOTLINES_KEY,
    PHRASE_SUMMARY_KEY,
    autoCreatedPhraseDefinitions,
    composePhraseContent,
    enabledPhraseDefinitions,
    isPhraseChapterGroupKey,
    isPhraseGroupKeyOf,
    phraseChapterDefinitions,
    phraseChapterGroupKey,
    phraseChapterGroupTitle,
    phraseChapterNumber,
    phraseDefinition,
    phraseEntryDefinitions,
    phraseGroupDefinition,
    phraseGroupDefinitionOf,
    phraseGroupKeys,
    phraseGroupRank,
    phraseGroupRankOf
} from './phrase';

/** The catalog's scalar facts, in one projection, so a new phrase kind shows up as a whole row. */
const catalogFacts = () =>
    PHRASE_CATALOG.map((definition) => ({
        key: definition.key,
        order: definition.order,
        enabled: definition.enabled,
        entry_policy: definition.entry_policy,
        brief_kind: definition.brief_kind,
        seed_source: definition.seed_source,
        starts_on_demand: definition.starts_on_demand,
        group_keys: definition.groups.map((group) => group.key)
    }));

describe('the two-phrase catalog', () => {
    it('holds Phrase ① and Phrase ②, in composition order, with their own policies', () => {
        expect(catalogFacts()).toEqual([
            {
                key: 'summary',
                order: 1,
                enabled: true,
                entry_policy: 'static_groups',
                brief_kind: 'seed_brief',
                seed_source: 'story_idea',
                starts_on_demand: false,
                group_keys: ['premise', 'promise', 'theme', 'tone', 'ending']
            },
            {
                key: 'plotlines',
                order: 2,
                enabled: true,
                entry_policy: 'chapter_entries',
                brief_kind: 'plotline_brief',
                seed_source: 'supplied',
                starts_on_demand: true,
                // Empty is the honest value: the entry set is the brief's decision, not a stored list.
                group_keys: []
            }
        ]);
        expect(PHRASE_SUMMARY_KEY).toBe('summary');
        expect(PHRASE_PLOTLINES_KEY).toBe('plotlines');
    });

    it('creates ONLY Phrase ① with the Story, while both are enabled', () => {
        // THE LOAD-BEARING PAIR. `enabled` is what the dial predicate and the planner can answer for;
        // `autoCreated` is what story creation mints rows for. Phrase ② is enabled but on-demand, so
        // `ensurePhraseCatalog` still creates exactly one `phrases` row — the Summary — which is what
        // every existing catalog test pins.
        expect(enabledPhraseDefinitions().map((definition) => definition.key)).toEqual(['summary', 'plotlines']);
        expect(autoCreatedPhraseDefinitions().map((definition) => definition.key)).toEqual(['summary']);
    });

    it('answers its own definition, and nothing for a key the catalog does not have', () => {
        expect(phraseDefinition('plotlines')?.title).toBe('Plotlines Phrase');
        expect(phraseDefinition('retired')).toBeUndefined();
    });
});

describe('per-phrase entry keys and ranks (seam S1)', () => {
    it('generates the chapter entry set from the brief count', () => {
        expect(phraseEntryDefinitions(PHRASE_PLOTLINES_KEY, 4).map((entry) => [entry.key, entry.title, entry.order])).toEqual([
            ['chapter_1', 'Chapter 1', 1],
            ['chapter_2', 'Chapter 2', 2],
            ['chapter_3', 'Chapter 3', 3],
            ['chapter_4', 'Chapter 4', 4]
        ]);

        // The description is the text a Writer prompt quotes for the entry, so it is pinned verbatim for
        // one chapter — the same sentences on every pass and after every restart.
        expect(phraseGroupDefinitionOf(PHRASE_PLOTLINES_KEY, 'chapter_3')).toEqual({
            key: 'chapter_3',
            title: 'Chapter 3',
            description:
                'The contract chapter 3 has to satisfy, as plotpoints rather than prose: the events it must deliver, ' +
                'what is different when it ends, whose eyes it is told through, and the setups it plants and payoffs it collects. ' +
                'Not a scene summary and not a draft of the chapter.',
            order: 3
        });
    });

    it('ignores the count for a static phrase and answers nothing for an unknown phrase', () => {
        // The count is passed unconditionally by phrase-generic callers, so a static phrase must not
        // invent entries from it — and `entryCount` must not truncate the five either.
        expect(phraseEntryDefinitions(PHRASE_SUMMARY_KEY, 2).map((entry) => entry.key)).toEqual([
            'premise',
            'promise',
            'theme',
            'tone',
            'ending'
        ]);
        expect(phraseEntryDefinitions('retired', 3)).toEqual([]);
        expect(phraseChapterDefinitions(0)).toEqual([]);
        expect(phraseChapterDefinitions(1.5)).toEqual([]);
    });

    it('keeps the two key namespaces disjoint', () => {
        // A Summary job may not be answered for a chapter and a chapter job may not be answered for a
        // Summary group, even though both keys exist on the same book.
        expect(isPhraseGroupKeyOf(PHRASE_SUMMARY_KEY, 'tone')).toBe(true);
        expect(isPhraseGroupKeyOf(PHRASE_SUMMARY_KEY, 'chapter_2')).toBe(false);
        expect(isPhraseGroupKeyOf(PHRASE_PLOTLINES_KEY, 'chapter_2')).toBe(true);
        expect(isPhraseGroupKeyOf(PHRASE_PLOTLINES_KEY, 'tone')).toBe(false);
        expect(isPhraseGroupKeyOf('retired', 'tone')).toBe(false);

        // Chapter keys are strict: no zero, no padding, no words. `phraseChapterNumber` reads the number
        // the `plotlines` mirror joins on, so a loose key would put a redraft on the wrong chapter.
        expect(['chapter_1', 'chapter_12'].filter(isPhraseChapterGroupKey)).toEqual(['chapter_1', 'chapter_12']);
        expect(['chapter_0', 'chapter_01', 'chapter_x', 'premise'].filter(isPhraseChapterGroupKey)).toEqual([]);
        expect(phraseChapterNumber('chapter_12')).toBe(12);
        expect(phraseChapterNumber('chapter_0')).toBe(0);
        expect(phraseChapterNumber(undefined)).toBe(0);
        expect(phraseChapterGroupKey(7)).toBe('chapter_7');
        expect(phraseChapterGroupTitle(7)).toBe('Chapter 7');
    });

    it('ranks each phrase inside its own namespace', () => {
        expect(phraseGroupRankOf(PHRASE_SUMMARY_KEY, 'ending')).toBe(5);
        expect(phraseGroupRankOf(PHRASE_PLOTLINES_KEY, 'chapter_3')).toBe(3);
        // A key from the other namespace ranks as unknown, which is what keeps a mixed batch from
        // silently ordering itself into the wrong phrase.
        expect(phraseGroupRankOf(PHRASE_SUMMARY_KEY, 'chapter_3')).toBe(Number.MAX_SAFE_INTEGER);
        expect(phraseGroupRankOf(PHRASE_PLOTLINES_KEY, 'ending')).toBe(Number.MAX_SAFE_INTEGER);
        // The Summary's own rank function is untouched — this is the one every existing call site uses.
        expect(phraseGroupRank('tone')).toBe(4);
        expect(phraseGroupRank('chapter_1')).toBe(Number.MAX_SAFE_INTEGER);
        expect(phraseGroupKeys()).toEqual(['premise', 'promise', 'theme', 'tone', 'ending']);
        expect(phraseGroupDefinition('premise')?.title).toBe('Premise');
    });
});

describe('composition of one phrase from its entries', () => {
    it('composes a chapter phrase in chapter order when given the chapter rank', () => {
        const composed = composePhraseContent(
            [
                { key: 'chapter_2', title: 'Chapter 2', content: 'B: the valley floods.\n' },
                // An unwritten chapter is skipped, not rendered as an empty heading.
                { key: 'chapter_3', title: 'Chapter 3', content: '   ' },
                { key: 'chapter_1', title: 'Chapter 1', content: 'A: she comes back.' }
            ],
            (key) => phraseGroupRankOf(PHRASE_PLOTLINES_KEY, key)
        );

        expect(composed).toBe('## Chapter 1\nA: she comes back.\n\n## Chapter 2\nB: the valley floods.');
    });

    it('composes a Summary byte-identically with no rank argument', () => {
        // THE REGRESSION PIN FOR PHRASE ①: every existing Summary call site calls this with one argument,
        // so the default must stay the Summary's own rank. Entries arrive out of order from a store read;
        // the output is catalog order.
        expect(
            composePhraseContent([
                { key: 'ending', title: 'Ending', content: 'She floods the valley on purpose.' },
                { key: 'premise', title: 'Premise', content: 'A cartographer returns.' }
            ])
        ).toBe('## Premise\nA cartographer returns.\n\n## Ending\nShe floods the valley on purpose.');

        // And every key is unknown to the Summary rank, so a chapter batch left on the default keeps the
        // CALLER's order (a stable sort) rather than inventing one — the shape a Summary read of a mixed
        // list takes, and the reason the chapter composition passes its own rank.
        expect(
            composePhraseContent([
                { key: 'chapter_2', title: 'Chapter 2', content: 'B' },
                { key: 'chapter_1', title: 'Chapter 1', content: 'A' }
            ])
        ).toBe('## Chapter 2\nB\n\n## Chapter 1\nA');
    });
});
