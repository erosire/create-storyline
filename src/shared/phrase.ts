// THE PHRASE CATALOG — the phrase kinds and their entries, as data (R1, generalized for Phrase ②).
//
// WHY A CATALOG MODULE AT ALL: the redesign's whole point is that a phrase is not one blob of prose
// an agent rewrites end to end; it is a set of named, separately revisable ENTRIES (GROUPS) that
// compose into one whole the Author reads. Which phrases exist, what each composes from, what each
// entry is called, and the order they compose in is therefore PRODUCT DATA, not code shape — P15's
// rule ("a phase model, a role set, or a criterion must be replaceable without rewriting the store")
// applied to the phrase layer. Nothing in `shared/types.ts` or `server/store/**` may branch on a
// group name: they ask this module (R1 "data-driven").
//
// WHAT "GENERALIZED" MEANS HERE, concretely, since the module used to describe one phrase:
//   1. a definition carries its ENTRY POLICY — the Summary composes from a CLOSED, static set of five
//      groups, the Plotlines phrase composes from a COUNTED set of chapter entries the Editor's
//      structure pass decides. Both are described, neither is special-cased by name;
//   2. group keys are PER-PHRASE NAMESPACES (seam S1). `premise`…`ending` belong to the Summary and
//      `chapter_1`…`chapter_N` belong to the Plotlines phrase, so validity and composition rank are
//      always asked OF A PHRASE (`isPhraseGroupKeyOf`/`phraseGroupRankOf`). The old single-argument
//      `isPhraseGroupKey`/`phraseGroupRank` stay exactly as they were, scoped to the Summary, because
//      every existing caller is a Summary read;
//   3. a definition says where its SEED comes from and whether its row is created with the Story or by
//      an explicit start step. Phrase ①'s seed is the Story's idea, copied at creation; Phrase ②'s is
//      text handed in when the Author starts it, copied into the row so the two phrases are discrete
//      and independent (a later edit of Phrase ① cannot reach Phrase ②'s history).
//
// WHAT IS DELIBERATELY NOT HERE: no behaviour over the book (that is `server/phrase/**`), no
// role-instruction prose (R7 — the final Writer/Critic instruction text lives on the phrase
// CONTROLLERS in `server/phrase/controller.ts`, and the descriptions below are the GROUP DEFINITIONS
// the prompt assembler quotes, not a role's brief), and no dependency beyond a type-only import, so
// this module is as browser-safe as `shared/schemas/**`.
//
// WORLD RULES ARE NOT A GROUP (R1). §4.2's `summaries.world_rules` field stays exactly where it
// is, optional and DEPRECATED: the redesign gives it no group, no revision line and no writer, so
// nothing here may mint one. The mirror sync in `server/phrase/revisions.ts` never touches it, and
// the legacy field keeps whatever the Author or a pre-redesign pipeline put in it.
import type { Summary } from './types';

// ---------------------------------------------------------------------------
// Phrase kinds
// ---------------------------------------------------------------------------

/**
 * `phrases.key` for the Summary Phrase (Phrase ①) — the Overview the whole chain is measured against.
 */
export const PHRASE_SUMMARY_KEY = 'summary';

/**
 * `phrases.key` for the Plotlines Phrase (Phrase ②) — the chapter contracts, one ENTRY PER CHAPTER.
 *
 * Its entries are DYNAMIC: the Editor's structure pass over the phrase's copied seed decides the
 * chapter count, and accepting that brief materializes the whole entry set in one go
 * (`server/phrase/controllers/plotlines.ts:acceptPlotlineBrief`). Nothing may create these rows from
 * the catalog alone, which is what `starts_on_demand` below says.
 */
export const PHRASE_PLOTLINES_KEY = 'plotlines';

/** How one phrase's entry set is decided — the one axis along which the two phrase kinds differ. */
export type PhraseEntryPolicy =
    /** A CLOSED set enumerated in {@link PhraseDefinition.groups} (the Summary's five groups). */
    | 'static_groups'
    /** A COUNTED set of chapter entries, `chapter_1`…`chapter_N`, generated for the brief's N. */
    | 'chapter_entries';

/** Which brief collection structures this phrase's seed. A phrase has exactly one brief kind. */
export type PhraseBriefKind =
    /** §3.3's `seed_briefs` — the structure of `stories.idea` (Phrase ①). */
    | 'seed_brief'
    /** `plotline_briefs` — the structure of the PHRASE's own copied seed (Phrase ②). */
    | 'plotline_brief';

/** Where a phrase instance's copied seed is taken from when the row is created. */
export type PhraseSeedSource =
    /** `stories.idea`, copied at story creation (Phrase ① — identical content, so gates are unchanged). */
    | 'story_idea'
    /** Text handed to the start step: the compiled Phrase ① output, or the Author's own text (Phrase ②). */
    | 'supplied';

/** One entry of {@link PHRASE_CATALOG}: a phrase kind, what it composes from, and how it starts. */
export interface PhraseDefinition {
    key: string;
    title: string;
    description: string;
    /** Composition order across phrases. Summary is 1, Plotlines is 2. */
    order: number;
    /**
     * Whether this phrase kind is ENABLED — the dial R1 names. A disabled definition is known to the
     * catalog and deliberately not created: `ensurePhraseCatalog` skips it, so switching a future
     * phrase on is one flag here and no loop change.
     */
    enabled: boolean;
    /**
     * The static entry definitions, in composition order. EMPTY for a `chapter_entries` phrase, whose
     * entries are generated from the accepted brief's count — an empty list there is a statement that
     * the SET IS NOT KNOWN YET, not that the phrase composes from nothing.
     */
    groups: readonly PhraseGroupDefinition[];
    /** Whether the entry set is enumerated here or counted by the phrase's brief. */
    entry_policy: PhraseEntryPolicy;
    /** The brief kind that structures this phrase's seed. */
    brief_kind: PhraseBriefKind;
    /** Where the copied seed comes from at creation. */
    seed_source: PhraseSeedSource;
    /**
     * Whether the phrase's `phrases` row is deliberately NOT created at story creation.
     *
     * This is the same rule R1 already states for a DISABLED definition — "known to the catalog,
     * deliberately not created, created instead by one explicit step" — applied to a phrase that is
     * enabled but cannot exist before the Author starts it: Phrase ② has no seed until Phrase ①'s
     * output (or the Author's text) is handed to it. `autoCreatedPhraseDefinitions()` is the list the
     * story-creation ensure walks, and it excludes these; the start step is the only other creator.
     */
    starts_on_demand: boolean;
}

/**
 * One entry of a phrase: its stable key, its Author-facing label, and what it owes.
 *
 * `key` is a plain string because the key namespace is PER-PHRASE (seam S1) — the Summary's five keys
 * and the Plotlines' `chapter_<n>` keys share only the shape of this record, and
 * {@link phraseGroupDefinitionOf} is the read that resolves a key inside the right namespace.
 */
export interface PhraseGroupDefinition {
    /** Stable key WITHIN ITS PHRASE. For the Summary it is also the legacy `summaries` field mirrored. */
    key: string;
    /** The label the Author's rail and the prompt headings show. */
    title: string;
    /** What belongs in this entry, in the entry's own words. The prompt assembler quotes it verbatim. */
    description: string;
    /** Composition order (1-based). Explicit rather than derived from index so an entry can be retired without renumbering the rest. */
    order: number;
}

/**
 * The five writable groups of the Summary Phrase, in the order the Overview composes them.
 *
 * THESE FIVE KEYS ARE NOT INVENTED: they are the five prose fields §4.2 already defines on the
 * `Summary` record (`premise`, `promise`, `theme`, `tone`, `ending`), which is what makes the
 * compatibility mirror an identity mapping (R6) instead of a translation with lossy judgement in
 * it. The order is the pipeline's own reading order — what the story IS, what it PROMISES, what it
 * is ABOUT, how it SOUNDS, where it LANDS.
 *
 * THEY ARE THE SUMMARY PHRASE'S KEYS, not "group keys" in the abstract: the Plotlines phrase has its
 * own namespace ({@link PHRASE_CHAPTER_KEY_PREFIX}).
 */
export const SUMMARY_GROUP_KEYS = ['premise', 'promise', 'theme', 'tone', 'ending'] as const;
export type SummaryGroupKey = (typeof SUMMARY_GROUP_KEYS)[number];

/**
 * The original names for {@link SUMMARY_GROUP_KEYS}/{@link SummaryGroupKey}, kept because the Summary
 * was the only phrase when they were written and every existing caller is a Summary read. A new
 * phrase-scoped read should use the `SUMMARY_*` name or the `…Of(phraseKey, …)` form instead.
 */
export const PHRASE_GROUP_KEYS: readonly SummaryGroupKey[] = SUMMARY_GROUP_KEYS;
export type PhraseGroupKey = SummaryGroupKey;

/**
 * The group definitions, keyed by stable key (R1: the set is data, so adding, retitling or
 * reordering a group is an edit to this map plus the array above, and nothing else).
 *
 * A definition's `description` is written to be quoted into a Writer's and a Reviewer's prompt, so
 * it names what the group must CONTAIN and nothing else — no cost rules, no tool rules, no
 * lifecycle. The lifecycle lives in the loop and the tool layer.
 */
const SUMMARY_GROUP_DEFINITIONS: Record<SummaryGroupKey, PhraseGroupDefinition> = {
    premise: {
        key: 'premise',
        title: 'Premise',
        description:
            'What the story is: the situation, who is in it, and the confrontation they are drawn into. One concrete account, no theme statement and no ending.',
        order: 1
    },
    promise: {
        key: 'promise',
        title: 'Promise',
        description:
            'What the story commits the reader to: the experience it undertakes to deliver, and the terms the rest of the book will be held to.',
        order: 2
    },
    theme: {
        key: 'theme',
        title: 'Theme',
        description:
            'What the story is about underneath: the argument it makes, stated as a claim the events can be checked against — never as a moral.',
        order: 3
    },
    tone: {
        key: 'tone',
        title: 'Tone',
        description:
            'Voice, point of view, tense and register the book is written in — the reading surface phase ③ is measured against. Prose qualities named, no sample prose.',
        order: 4
    },
    ending: {
        key: 'ending',
        title: 'Ending',
        description:
            "Where the story lands and what resolves: the outcome the premise and the promise are answered by, including what is deliberately left open.",
        order: 5
    }
};

// ---------------------------------------------------------------------------
// The Plotlines phrase's entry namespace — chapter entries, counted by the brief
// ---------------------------------------------------------------------------

/**
 * The key prefix of one Plotlines chapter entry: `chapter_1`, `chapter_2`, …
 *
 * THE NUMBER IS IN THE KEY, and that is the whole chapter identity inside the phrase: the entry's
 * `order` and the `plotlines` row it mirrors are read back off it
 * ({@link phraseChapterNumber}), so a redraft of chapter 3 updates chapter 3's contract no matter
 * what order the Writer's answer arrived in.
 */
export const PHRASE_CHAPTER_KEY_PREFIX = 'chapter_';

/** The group key of the Nth chapter entry (1-based). */
export const phraseChapterGroupKey = (chapter: number): string => `${PHRASE_CHAPTER_KEY_PREFIX}${chapter}`;

/** The Author-facing title of the Nth chapter entry. */
export const phraseChapterGroupTitle = (chapter: number): string => `Chapter ${chapter}`;

/** Whether a key is a chapter entry key: `chapter_` plus digits, nothing else (`chapter_00` and `chapter_x` are not). */
export const isPhraseChapterGroupKey = (key: unknown): key is string =>
    typeof key === 'string' && new RegExp(`^${PHRASE_CHAPTER_KEY_PREFIX}[1-9][0-9]*$`).test(key);

/** The chapter number a chapter entry key names, or `0` for a key that is not one. */
export function phraseChapterNumber(key: unknown): number {
    if (!isPhraseChapterGroupKey(key)) return 0;

    return Number.parseInt(key.slice(PHRASE_CHAPTER_KEY_PREFIX.length), 10);
}

/** One chapter entry's definition, generated for its number (the brief's N, not a stored catalog list). */
function chapterGroupDefinition(chapter: number): PhraseGroupDefinition {
    return {
        key: phraseChapterGroupKey(chapter),
        title: phraseChapterGroupTitle(chapter),
        description:
            'The contract chapter ' +
            chapter +
            ' has to satisfy, as plotpoints rather than prose: the events it must deliver, what is different when it ends, whose eyes it is told through, and the setups it plants and payoffs it collects. Not a scene summary and not a draft of the chapter.',
        order: chapter
    };
}

/**
 * The chapter entry definitions for a phrase seeded with N chapters, in chapter order.
 *
 * A count outside 1..MAX_SAFE_INTEGER answers `[]` rather than throwing: the count is a number a model
 * produced, and the caller's job is to refuse a brief that carries a nonsense one, not to crash on it.
 */
export function phraseChapterDefinitions(chapterCount: number): PhraseGroupDefinition[] {
    if (!Number.isInteger(chapterCount) || chapterCount < 1) return [];

    return Array.from({ length: chapterCount }, (_, index) => chapterGroupDefinition(index + 1));
}

/**
 * The phrase catalog (R1), in composition order.
 *
 * Keeping this a LIST (rather than one exported constant) is what makes the create/hydrate path
 * phrase-generic: `ensurePhraseCatalog` walks `autoCreatedPhraseDefinitions()` and creates a `phrases`
 * row per definition that starts with the Story, so a second phrase kind arrives as data. The
 * Plotlines entry is ENABLED (the catalog knows it, and `isPhraseGroupManaged` can be answered for it)
 * but `starts_on_demand` (see that field's note), so story creation still mints exactly the Summary
 * row it always minted.
 */
export const PHRASE_CATALOG: readonly PhraseDefinition[] = [
    {
        key: PHRASE_SUMMARY_KEY,
        title: 'Summary Phrase',
        description:
            'The Overview the whole chain is measured against: five named groups, each with its own revision history, composed in this order.',
        order: 1,
        enabled: true,
        groups: orderedPhraseGroupDefinitions(),
        entry_policy: 'static_groups',
        brief_kind: 'seed_brief',
        seed_source: 'story_idea',
        // Phrase ① has always been created at story creation, and every existing catalog test pins it.
        starts_on_demand: false
    },
    {
        key: PHRASE_PLOTLINES_KEY,
        title: 'Plotlines Phrase',
        description:
            'The book\'s chapter contracts, one entry per chapter: each entry holds that chapter\'s precise plotpoints — what must happen, what must change, whose POV, and the setups and payoffs it carries — and the `plotlines` rows are the mirror the loop already reads.',
        order: 2,
        // Enabled: the catalog knows this phrase, the dial predicate can answer for it, and the loop
        // may plan its work. NOT created at story creation — it has no seed until one is handed in.
        enabled: true,
        // Empty is honest here: the entry set is decided by the phrase's brief, not enumerated here.
        groups: [],
        entry_policy: 'chapter_entries',
        brief_kind: 'plotline_brief',
        seed_source: 'supplied',
        starts_on_demand: true
    }
];

// ---------------------------------------------------------------------------
// Catalog reads
// ---------------------------------------------------------------------------

/** Every SUMMARY group definition, sorted by `order` (the composition order). A fresh array every call. */
export function orderedPhraseGroupDefinitions(): PhraseGroupDefinition[] {
    return SUMMARY_GROUP_KEYS.map((key) => SUMMARY_GROUP_DEFINITIONS[key]).sort(
        (left, right) => left.order - right.order
    );
}

/**
 * The entry definitions of ONE phrase, in composition order.
 *
 * A `static_groups` phrase answers its stored list; a `chapter_entries` phrase generates its first
 * `entryCount` chapter entries — so `phraseEntryDefinitions('plotlines', 4)` is
 * `chapter_1…chapter_4`. The count is required for a chapter phrase and IGNORED for a static one,
 * which is what lets a caller pass it unconditionally without the static phrase inventing entries.
 */
export function phraseEntryDefinitions(phraseKey: string, entryCount = 0): PhraseGroupDefinition[] {
    const definition = phraseDefinition(phraseKey);

    if (definition === undefined) return [];

    if (definition.entry_policy === 'chapter_entries') return phraseChapterDefinitions(entryCount);

    return [...definition.groups].sort((left, right) => left.order - right.order);
}

/** The one SUMMARY group definition whose key matches, or `undefined` for a key the Summary does not have. */
export function phraseGroupDefinition(key: string): PhraseGroupDefinition | undefined {
    return (SUMMARY_GROUP_KEYS as readonly string[]).includes(key)
        ? SUMMARY_GROUP_DEFINITIONS[key as SummaryGroupKey]
        : undefined;
}

/**
 * ONE entry definition, resolved inside ONE phrase's key namespace (seam S1).
 *
 * A chapter entry definition is GENERATED from the number its key carries rather than stored, so the
 * description a prompt quotes for `chapter_3` is the same text on every pass and survives a restart
 * with no bookkeeping (L-3). An unknown key answers `undefined`, which every caller already reads as
 * "render from the ROW, which carries its own title and description as written at creation".
 */
export function phraseGroupDefinitionOf(phraseKey: string, key: string): PhraseGroupDefinition | undefined {
    const definition = phraseDefinition(phraseKey);

    if (definition === undefined) return undefined;

    if (definition.entry_policy === 'chapter_entries') {
        const chapter = phraseChapterNumber(key);

        return chapter === 0 ? undefined : chapterGroupDefinition(chapter);
    }

    return phraseGroupDefinition(key);
}

/** The phrase definition for a `phrases.key`, or `undefined` for an unknown or retired kind. */
export function phraseDefinition(key: string): PhraseDefinition | undefined {
    return PHRASE_CATALOG.find((definition) => definition.key === key);
}

/** The ENABLED phrase definitions, in catalog order — every kind the book may hold a row for. */
export function enabledPhraseDefinitions(): PhraseDefinition[] {
    return PHRASE_CATALOG.filter((definition) => definition.enabled).sort(
        (left, right) => left.order - right.order
    );
}

/**
 * The ENABLED definitions whose rows are created WITH the Story — what `ensurePhraseCatalog` walks.
 *
 * WHY A SECOND LIST BESIDES {@link enabledPhraseDefinitions}: `enabled` answers "does this phrase
 * exist as a concept the product supports", and `starts_on_demand` answers "is its row created before
 * anyone has handed it a seed". Conflating them would force Phrase ② back to `enabled: false`, which
 * would make the dial predicate unable to answer for it and make the loop's planner blind to a phrase
 * the Author can start at any moment.
 */
export function autoCreatedPhraseDefinitions(): PhraseDefinition[] {
    return enabledPhraseDefinitions().filter((definition) => !definition.starts_on_demand);
}

/** Narrowing guard for a value read off a record, a route parameter, or a model's answer (SUMMARY keys). */
export function isPhraseGroupKey(value: unknown): value is SummaryGroupKey {
    return typeof value === 'string' && (SUMMARY_GROUP_KEYS as readonly string[]).includes(value);
}

/**
 * Whether `value` is a valid entry key OF THE NAMED PHRASE (seam S1).
 *
 * The question a per-phrase answer contract has to ask: a Summary job may not be answered for
 * `chapter_2` and a chapter job may not be answered for `tone`, even though both keys exist in the
 * book. It is a separate name rather than an overload of {@link isPhraseGroupKey} so the existing
 * single-argument type guard keeps its narrowing behaviour for every Summary caller.
 */
export function isPhraseGroupKeyOf(phraseKey: string, value: unknown): boolean {
    const definition = phraseDefinition(phraseKey);

    if (definition === undefined) return false;

    return definition.entry_policy === 'chapter_entries'
        ? isPhraseChapterGroupKey(value)
        : isPhraseGroupKey(value);
}

/** The SUMMARY group keys in composition order — the ordered key list R6's projection exposes. */
export function phraseGroupKeys(): SummaryGroupKey[] {
    return [...SUMMARY_GROUP_KEYS];
}

/**
 * Composition rank of a SUMMARY group key: lower composes earlier, `Number.MAX_SAFE_INTEGER` for a
 * key the Summary catalog does not know.
 *
 * WHY A RANK FUNCTION RATHER THAN AN INDEX LOOKUP: the loop sorts persisted rows (a group can be
 * `archived` in the catalog and still have rows on the book), and a sort that throws on an unknown
 * key would take the Author's whole Overview down over one stale row. Unknown keys sort last,
 * stably, and stay visible.
 *
 * THIS IS THE SUMMARY'S RANK. Use {@link phraseGroupRankOf} when the row may belong to another phrase.
 */
export function phraseGroupRank(key: string): number {
    return phraseGroupDefinition(key)?.order ?? Number.MAX_SAFE_INTEGER;
}

/** Composition rank of an entry key WITHIN ITS PHRASE: definition order, or the chapter number. */
export function phraseGroupRankOf(phraseKey: string, key: string): number {
    return phraseGroupDefinitionOf(phraseKey, key)?.order ?? Number.MAX_SAFE_INTEGER;
}

// ---------------------------------------------------------------------------
// The legacy compatibility mirror (R6) — the SUMMARY phrase's mirror, and only its own
// ---------------------------------------------------------------------------

/**
 * The five prose fields of §4.2's `Summary` record. Derived from the record itself rather than
 * written out as a second list, so a field rename in `./types` stops compiling HERE instead of
 * leaving this map pointing at a field that no longer exists.
 */
export type SummaryMirrorField = 'premise' | 'promise' | 'theme' | 'tone' | 'ending';

// Compile-time coupling check: every mirror field must still be a writable prose field of Summary.
// (If §4.2 ever renames one, this line — not a runtime surprise in the mirror sync — is what says so.)
export type SummaryMirrorFieldCheck = SummaryMirrorField extends keyof Summary ? true : never;

/**
 * SUMMARY group key → the legacy `summaries` field its latest text is mirrored into (R6).
 *
 * THE MAPPING IS AN IDENTITY, and that is the design: the five groups ARE §4.2's five prose fields,
 * so the mirror loses nothing and the dashboard, the Digest and phases ②/③ keep reading the record
 * they have always read. `server/phrase/revisions.ts` writes these fields in the SAME commit that
 * installs a group revision, so a reader can never see a new group text beside an old mirror.
 *
 * THE KEY TYPE IS SCOPED TO THE SUMMARY PHRASE ON PURPOSE (seam S3). Widening it to every phrase's
 * keys would let a Plotlines chapter key reach this map and turn "this phrase has no legacy mirror"
 * into a silent no-op; the install says so out loud instead. `world_rules` is absent here for the
 * same reason (R1/R6): it is not a group, it is deprecated, and the mirror never writes it.
 */
export const SUMMARY_MIRROR_FIELDS = {
    premise: 'premise',
    promise: 'promise',
    theme: 'theme',
    tone: 'tone',
    ending: 'ending'
} as const satisfies Record<SummaryGroupKey, SummaryMirrorField>;

/** The deprecated legacy field that has no group, named once so no other module has to spell it. */
export const WORLD_RULES_FIELD = 'world_rules';

// ---------------------------------------------------------------------------
// Composition — one phrase's content from its entries' latest texts
// ---------------------------------------------------------------------------

/** One line of a composition: the entry's key, its label, and its current text. */
export interface PhraseCompositionEntry {
    key: string;
    title: string;
    content: string;
}

/**
 * Composes ONE phrase's whole text from its entries (the `phrases.content` generator).
 *
 * THE SHAPE, stated so it can be asserted exactly: one `## <title>` heading per entry that has
 * non-empty text, its text underneath, entries separated by a single blank line, in `order`
 * rank order, with NO trailing newline. Empty entries are skipped rather than rendered as an empty
 * heading, because an empty entry means "not written yet" and a whole text full of empty headings
 * reads like a form, not like the thing the deep review judges.
 *
 * Entries with an unknown key sort LAST (see {@link phraseGroupRank}) instead of disappearing, so a
 * retired entry's text is still readable.
 *
 * `rankOf` is the phrase-scoped rank ({@link phraseGroupRankOf} partially applied to the phrase key).
 * It DEFAULTS to the Summary's rank so every existing Summary call site is byte-identical, and a
 * chapter composition passes the chapter rank so its entries compose in chapter order rather than
 * all landing in the unknown-key tie at the end.
 */
export function composePhraseContent(
    entries: readonly PhraseCompositionEntry[],
    rankOf: (key: string) => number = phraseGroupRank
): string {
    const sorted = [...entries].sort((left, right) => {
        const rankLeft = rankOf(left.key);
        const rankRight = rankOf(right.key);

        // Equal ranks (two unknown keys, or two chapters of the same generated order) keep the
        // caller's order: the sort must not invent one, and it is stable in every engine this runs on.
        return rankLeft - rankRight;
    });

    return sorted
        .filter((entry) => typeof entry.content === 'string' && entry.content.trim().length > 0)
        .map((entry) => `## ${entry.title}\n${entry.content.trim()}`)
        .join('\n\n');
}
