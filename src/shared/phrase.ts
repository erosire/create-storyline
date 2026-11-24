// SUMMARY PHRASE — the catalog, as data (R1).
//
// WHY A CATALOG MODULE AT ALL: the redesign's whole point is that a Summary is not one blob of
// prose an agent rewrites end to end; it is a set of named, separately revisable GROUPS (premise,
// promise, theme, tone, ending) that compose into one Overview the Author reads. Which groups
// exist, what they are called, what each one owes, and the order they compose in is therefore
// PRODUCT DATA, not code shape — P15's rule ("a phase model, a role set, or a criterion must be
// replaceable without rewriting the store") applied to the Summary. Nothing in `shared/types.ts`
// or `server/store/**` may branch on a group name: they ask this module (R1 "data-driven").
//
// WHAT IS DELIBERATELY NOT HERE: no behaviour over the book (that is `server/phrase/**`), no
// role-instruction prose (R7 — the final Writer/Reader instruction text is a later task, and the
// descriptions below are the GROUP DEFINITIONS the prompt assembler quotes, not a role's brief),
// and no dependency beyond a type-only import, so this module is as browser-safe as
// `shared/schemas/**`.
//
// WORLD RULES ARE NOT A GROUP (R1). §4.2's `summaries.world_rules` field stays exactly where it
// is, optional and DEPRECATED: the redesign gives it no group, no revision line and no writer, so
// nothing here may mint one. The mirror sync in `server/phrase/revisions.ts` never touches it, and
// the legacy field keeps whatever the Author or a pre-redesign pipeline put in it.
import type { Summary } from './types';

// ---------------------------------------------------------------------------
// Phrase kinds — only the Summary Phrase is enabled (R1)
// ---------------------------------------------------------------------------

/** The one phrase kind this build ships. It is also `phrases.key` for every row it creates. */
export const PHRASE_SUMMARY_KEY = 'summary';

/** One entry of {@link PHRASE_CATALOG}: a phrase kind, what it composes from, and whether it is on. */
export interface PhraseDefinition {
    key: string;
    title: string;
    description: string;
    /** Composition order across phrases. One phrase today, so this is 1. */
    order: number;
    /**
     * Whether this phrase kind is ENABLED — the dial R1 names ("only Summary enabled"). A disabled
     * definition is known to the catalog and deliberately not created: `ensurePhraseCatalog` skips
     * it, so switching a future phrase on is one flag here and no loop change.
     */
    enabled: boolean;
    /** The writable groups, in composition order. */
    groups: readonly PhraseGroupDefinition[];
}

/** One group of a phrase: its stable key, its Author-facing label, and what it owes. */
export interface PhraseGroupDefinition {
    /** Stable key. It is also the legacy `summaries` field this group mirrors — see {@link SUMMARY_MIRROR_FIELDS}. */
    key: PhraseGroupKey;
    /** The label the Author's rail and the prompt headings show. */
    title: string;
    /** What belongs in this group, in the group's own words. The prompt assembler quotes it verbatim. */
    description: string;
    /** Composition order (1-based). Numbers are explicit rather than derived from index so a group can be retired without renumbering the rest. */
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
 */
export const PHRASE_GROUP_KEYS = ['premise', 'promise', 'theme', 'tone', 'ending'] as const;
export type PhraseGroupKey = (typeof PHRASE_GROUP_KEYS)[number];

/**
 * The group definitions, keyed by stable key (R1: the set is data, so adding, retitling or
 * reordering a group is an edit to this map plus the array above, and nothing else).
 *
 * A definition's `description` is written to be quoted into a Writer's and a Reviewer's prompt, so
 * it names what the group must CONTAIN and nothing else — no cost rules, no tool rules, no
 * lifecycle. The lifecycle lives in the loop and the tool layer.
 */
const PHRASE_GROUP_DEFINITIONS: Record<PhraseGroupKey, PhraseGroupDefinition> = {
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

/**
 * The phrase catalog (R1). One entry, enabled; the five groups are its composition.
 *
 * Keeping this a LIST (rather than one exported constant) is what makes the loop's create/hydrate
 * path phrase-generic: `ensurePhraseCatalog` walks `enabledPhraseDefinitions()` and creates a
 * `phrases` row per enabled definition, so the second phrase kind arrives as data.
 */
export const PHRASE_CATALOG: readonly PhraseDefinition[] = [
    {
        key: PHRASE_SUMMARY_KEY,
        title: 'Summary Phrase',
        description:
            'The Overview the whole chain is measured against: five named groups, each with its own revision history, composed in this order.',
        order: 1,
        enabled: true,
        groups: orderedPhraseGroupDefinitions()
    }
];

// ---------------------------------------------------------------------------
// Catalog reads
// ---------------------------------------------------------------------------

/** Every group definition, sorted by `order` (the composition order). A fresh array every call. */
export function orderedPhraseGroupDefinitions(): PhraseGroupDefinition[] {
    return PHRASE_GROUP_KEYS.map((key) => PHRASE_GROUP_DEFINITIONS[key]).sort(
        (left, right) => left.order - right.order
    );
}

/** The one group definition whose key matches, or `undefined` for a key the catalog does not have. */
export function phraseGroupDefinition(key: string): PhraseGroupDefinition | undefined {
    return (PHRASE_GROUP_KEYS as readonly string[]).includes(key)
        ? PHRASE_GROUP_DEFINITIONS[key as PhraseGroupKey]
        : undefined;
}

/** The phrase definition for a `phrases.key`, or `undefined` for an unknown or retired kind. */
export function phraseDefinition(key: string): PhraseDefinition | undefined {
    return PHRASE_CATALOG.find((definition) => definition.key === key);
}

/** The ENABLED phrase definitions, in catalog order — the set the store is ensured against (R1). */
export function enabledPhraseDefinitions(): PhraseDefinition[] {
    return PHRASE_CATALOG.filter((definition) => definition.enabled).sort(
        (left, right) => left.order - right.order
    );
}

/** Narrowing guard for a value read off a record, a route parameter, or a model's answer. */
export function isPhraseGroupKey(value: unknown): value is PhraseGroupKey {
    return typeof value === 'string' && (PHRASE_GROUP_KEYS as readonly string[]).includes(value);
}

/** The group keys in composition order — the ordered key list R6's projection exposes. */
export function phraseGroupKeys(): PhraseGroupKey[] {
    return orderedPhraseGroupDefinitions().map((definition) => definition.key);
}

/**
 * Composition rank of a group key: lower composes earlier, `Number.MAX_SAFE_INTEGER` for a key the
 * catalog does not know.
 *
 * WHY A RANK FUNCTION RATHER THAN AN INDEX LOOKUP: the loop sorts persisted rows (a group can be
 * `archived` in the catalog and still have rows on the book), and a sort that throws on an unknown
 * key would take the Author's whole Overview down over one stale row. Unknown keys sort last,
 * stably, and stay visible.
 */
export function phraseGroupRank(key: string): number {
    return phraseGroupDefinition(key)?.order ?? Number.MAX_SAFE_INTEGER;
}

// ---------------------------------------------------------------------------
// The legacy compatibility mirror (R6)
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
 * group key → the legacy `summaries` field its latest text is mirrored into (R6).
 *
 * THE MAPPING IS AN IDENTITY, and that is the design: the five groups ARE §4.2's five prose fields,
 * so the mirror loses nothing and the dashboard, the Digest and phases ②/③ keep reading the record
 * they have always read. `server/phrase/revisions.ts` writes these fields in the SAME commit that
 * installs a group revision, so a reader can never see a new group text beside an old mirror.
 *
 * `world_rules` is absent here on purpose (R1/R6): it is not a group, it is deprecated, and the
 * mirror never writes it.
 */
export const SUMMARY_MIRROR_FIELDS = {
    premise: 'premise',
    promise: 'promise',
    theme: 'theme',
    tone: 'tone',
    ending: 'ending'
} as const satisfies Record<PhraseGroupKey, SummaryMirrorField>;

/** The deprecated legacy field that has no group, named once so no other module has to spell it. */
export const WORLD_RULES_FIELD = 'world_rules';

// ---------------------------------------------------------------------------
// Composition — phrase content from the latest group texts
// ---------------------------------------------------------------------------

/** One line of a composition: the group's label and its current text. */
export interface PhraseCompositionEntry {
    key: string;
    title: string;
    content: string;
}

/**
 * Composes the Overview text from group entries (the `phrases.content` generator).
 *
 * THE SHAPE, stated so it can be asserted exactly: one `## <title>` heading per entry that has
 * non-empty text, its text underneath, entries separated by a single blank line, in `order`
 * rank order, with NO trailing newline. Empty groups are skipped rather than rendered as an empty
 * heading, because an empty group means "not written yet" and an Overview full of empty headings
 * reads like a form, not like the thing the deep review judges.
 *
 * Entries with an unknown key sort LAST (see {@link phraseGroupRank}) instead of disappearing, so a
 * retired group's text is still readable in the Overview.
 */
export function composePhraseContent(entries: readonly PhraseCompositionEntry[]): string {
    const sorted = [...entries].sort((left, right) => {
        const rankLeft = phraseGroupRank(left.key);
        const rankRight = phraseGroupRank(right.key);

        // Equal ranks (two unknown keys) keep the caller's order: the sort must not invent one.
        return rankLeft - rankRight;
    });

    return sorted
        .filter((entry) => typeof entry.content === 'string' && entry.content.trim().length > 0)
        .map((entry) => `## ${entry.title}\n${entry.content.trim()}`)
        .join('\n\n');
}
