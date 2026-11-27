// §5 — the Goal: the criterion shape, the built-in criteria, the level grouping, and the
// default Goal every fresh Story starts from.
//
// WHY THE ROSTER IS DATA AND NOT CODE (G-3, P15): the criteria engine (W3) evaluates `code`
// checkers server-side and collects `judge` answers from verdicts, and the Author may
// "toggle a criterion's hard flag, delete one, add one, and change threshold_soft, per Story
// and per chapter" (G-1). A criterion the Author can edit cannot be a switch statement, so
// the built-ins below are a plain editable roster: id, label, question, checker, hard,
// fix_hint, and nothing else.
//
// §5.2 IS NORMATIVE FOR checker AND hard. A build that flips one is wrong: `code` means the
// server can decide it with no model call (C-0, C-1, C-5, C-6, C-15), and `hard` means it
// must pass at its level rather than counting toward `threshold_soft` (§5.1).
//
// G-6 / §5.3: no criterion asks "is this good?". Each one below is answerable against a
// stored artifact — the Seed, the Summary, a plotline, the ledger, a template's
// selection_rules — which is what makes a boolean with a citation possible at all (P6).

import type { PhraseCatalogEntry, StoryVocabulary } from '../api';
import type { Criterion, Goal } from '../../types';

// The shape itself lives in ./types (so §4.11's `goals.criteria` can hold it without an
// import cycle); it is re-exported here so a consumer of the Goal contract reads it from the
// Goal module, exactly as §5.1 presents it.
export type { Criterion, CriterionChecker } from '../../types';

// ---------------------------------------------------------------------------
// §5.2 — the built-in criteria (C-0…C-15)
// ---------------------------------------------------------------------------

/**
 * The §5.2 table, verbatim. `label` is the table's criterion text (the plain-language label
 * G-2 renders), `question` is the same requirement phrased as the one question a fresh
 * reviewer answers (P4), and `fix_hint` names the smallest change that would satisfy it —
 * G-2 requires every failure to name one.
 */
export const BUILT_IN_CRITERIA: Criterion[] = [
    {
        // §5.2 C-0 — the count is Author truth (D-3b): "no more, no fewer" is a hard
        // criterion, never a creative choice (L-6a).
        id: 'C-0',
        label: 'the Story has exactly `chapter_count` plotlines and chapters — no more, no fewer',
        question: 'Does the Story have exactly `chapter_count` plotlines and exactly `chapter_count` chapters?',
        checker: 'code',
        hard: true,
        fix_hint:
            'Create the missing plotlines/chapters or delete the surplus; never edit chapter_count to pass (D-3b).'
    },
    {
        // §5.2 C-1 — a chapter with no contract is a chapter nothing can judge (P4).
        id: 'C-1',
        label: 'every chapter has a plotline',
        question: 'Does every chapter name a plotline that governs it?',
        checker: 'code',
        hard: true,
        fix_hint:
            'createPlotline for the orphan chapter, or set the chapter\u2019s plotline_ref to the plotline that owns it.'
    },
    {
        // §5.2 C-2 — the first consistency check, and it runs before any chapter exists (D-4).
        id: 'C-2',
        label: 'every plotline traces to the Summary \u2014 nothing in it contradicts premise, promise, theme, or ending',
        question:
            'Does every plotline trace to the locked Summary \u2014 does nothing in it contradict the premise, promise, theme or ending?',
        checker: 'judge',
        hard: true,
        fix_hint:
            'Rewrite the plotline to serve the Summary it names; if the Summary is the thing that is wrong, raise a finding and let the Author backtrack (D-25).'
    },
    {
        // §5.2 C-3 — soft on purpose: a flat arc is a legitimate choice, a restatement is not.
        //
        // R5 (W2) — RE-CUT FOR BEATS, ID UNCHANGED, and this file mirrors the server's table
        // (`shared/criteria.ts:CRITERIA`) byte for byte. The rule has always been "the chapter leaves the book
        // different"; what moved is where that sentence lives — the chapter's beat list now ENDS IN the change, so
        // the question points at the last beat instead of at a prose field that no longer gets written. The ID is
        // the load-bearing part: it is what an Author's per-Story setting names (G-1), so a re-worded criterion
        // keeps the hard flag, the deletion and the override exactly where the Author left them.
        id: 'C-3',
        label: 'every plotline\u2019s last beat is actually a change, not a restatement of the beats before it',
        question:
            'Is the last beat of each plotline a real change of state, knowledge, relationship or position, rather than a restatement of the beats that came before it?',
        checker: 'judge',
        hard: false,
        fix_hint:
            'State the last beat as a named before and after; if nothing is different when the chapter ends, the chapter has no contract.'
    },
    {
        // §5.2 C-4 — cross-plotline consistency; the level this fails on is the one that
        // stalls books in act two (§6.8, L-21, §15 step 9).
        id: 'C-4',
        label: 'plotlines are consistent with each other: no contradiction between adjacent chapters, no event requiring a setup that no earlier chapter makes',
        question:
            'Are the plotlines consistent with each other \u2014 no adjacent contradiction, and no event that needs a setup no earlier chapter makes?',
        checker: 'judge',
        hard: true,
        fix_hint:
            'Move the setup into an earlier plotline, or drop the event that depends on it (L-8a fixes whichever side the plotline says is wrong).'
    },
    {
        // §5.2 C-5 — mechanical, so it is code (D-10): continuity MUST NOT ride on an LLM's judgment.
        id: 'C-5',
        label: 'every `setup` in the ledger has a `payoff`, and every `payoff` has a setup',
        question: 'Does every setup in the ledger have a matching payoff, and every payoff a setup?',
        checker: 'code',
        hard: true,
        fix_hint: 'editLedger: add the payoff the setup promises, or add the setup the payoff presumes.'
    },
    {
        id: 'C-6',
        label: 'timeline is monotonic; no `fact` contradiction',
        question: 'Is the ledger timeline monotonic, and do no two fact entries contradict each other on the same key?',
        checker: 'code',
        hard: true,
        fix_hint: 'Reorder or re-date the timeline entries, and resolve the contradicting fact to one value (D-10).'
    },
    {
        // §5.2 C-7 — the loop's one question, pointed at prose (P4). R5 (W2): the contract is a LIST now, so the
        // question is asked of every beat in order — strictly more checkable than "the events must_happen names",
        // where one prose block could hide an event a reviewer never found. Mirrors `shared/criteria.ts` verbatim.
        id: 'C-7',
        label: 'expanded prose delivers every beat of its chapter\u2019s contract, in order',
        question:
            'Does the expanded prose deliver every beat this chapter\u2019s contract lists, and in the order the contract lists them?',
        checker: 'judge',
        hard: true,
        fix_hint:
            'Write the beats the contract names in this chapter, in its order; do not let an adjacent chapter do them instead.'
    },
    {
        // C-8 is the other half of the pair: C-7 asks whether the beats happened, C-8 asks whether the LAST one left
        // the chapter changed (R5). Two lines, not one, because they fail for different reasons and the Author fixes
        // them differently (L-14 reports each level's failures separately).
        id: 'C-8',
        label: 'expanded prose lands the change its chapter\u2019s last beat declares',
        question: 'Does the expanded prose actually leave this chapter in the changed state its last beat declares?',
        checker: 'judge',
        hard: true,
        fix_hint: 'Show the declared change happening on the page by the chapter\u2019s final section.'
    },
    {
        // §5.2 C-9 — D-9: behaviour is checked against `arc` + `state_now`, not vibes.
        id: 'C-9',
        label: 'no character acts against `arc` + `state_now` without a scene that owns the change',
        question:
            'Does every character act consistently with their arc and state_now, or is there a scene that owns the change when they do not?',
        checker: 'judge',
        hard: false,
        fix_hint: 'Add the scene that owns the change, or bring the behaviour back to the cast record (D-9).'
    },
    {
        id: 'C-10',
        label: 'the ending pays the `promise`',
        question: 'Does the ending pay the promise the Summary made to the reader?',
        checker: 'judge',
        hard: true,
        fix_hint:
            'Change the ending so it pays the promise; changing the promise instead is the Author\u2019s call (P5).'
    },
    {
        id: 'C-11',
        label: 'no two consecutive chapters do the same job (pacing)',
        question: 'Do any two consecutive chapters do the same job?',
        checker: 'judge',
        hard: false,
        fix_hint: 'Merge the two chapters, or restate one chapter\u2019s contract so it does a different job.'
    },
    {
        // C-12 sits OUTSIDE the levels — it is a per-chapter quality check (§5.2 note,
        // PER_CHAPTER below), which is why the whole-Story level does not list it.
        id: 'C-12',
        label: 'prose quality at the level the `tone` sheet demands',
        question: 'Does the prose reach the quality level the Summary\u2019s tone sheet demands?',
        checker: 'judge',
        hard: false,
        fix_hint:
            'Revise the prose toward the tone sheet\u2019s voice, POV, tense and register \u2014 the Writer writes it, never the reviewer (P10).'
    },
    {
        // G-3a: C-13 is the criterion the whole product is measured by, and the one the
        // Author is expected to tune until it stops failing on prose they like. Its evidence
        // is the tone sheet plus the Editor templates' selection_rules.
        id: 'C-13',
        label: 'the prose reads as though this Author wrote it \u2014 matches the `tone` sheet and the Editor templates\u2019 `selection_rules`',
        question:
            'Does the prose read as though this Author wrote it \u2014 does it match the tone sheet and the Editor templates\u2019 selection_rules?',
        checker: 'judge',
        hard: true,
        fix_hint:
            'Revise toward the tone sheet and selection_rules; if those do not describe prose you like, edit the rules \u2014 that text is the product (P12).'
    },
    {
        // C-14 is the level "the Author did not name and Phase 1 requires": if the Summary
        // drifts from the Seed, every later level can pass while the book is wrong (§5.2).
        //
        // THE SEED IS GENERAL ON PURPOSE, so C-14 is a CONTRADICTION test, not a checklist. The
        // Author's Seed states a few things firmly and leaves the rest open; the Writer's job is to
        // fill the open part with compatible specifics. An older wording ("nothing central … is
        // missing from it") turned every silence into an unmet promise, and Critics spent rounds on
        // details the Seed never stated (stakes it left open, a refuge that appears only in the
        // ending). So the three fields below state the admissible grounds — contradiction, a broken
        // explicit commitment, a broken promise of the Summary's own — and say in words that
        // omission from a general Seed is not evidence. The controls that matter stay: an explicit
        // commitment the Summary drops still fails this line.
        id: 'C-14',
        label: 'the Summary delivers the Seed: nothing in it contradicts what the Seed states, and no commitment the Seed states explicitly goes unpaid',
        question:
            'Does the Summary deliver the Seed \u2014 is it free of anything that contradicts what the Seed states, and does it leave no commitment the Seed states explicitly unpaid? The Seed is general, not an outline, and the Writer may supply any detail the Seed does not rule out, so an absence alone \u2014 a detail the Seed never stated, stakes it left open, setup the Summary did not promise \u2014 does not fail this line; a quote of what the Summary contradicts, or of the commitment it breaks, does.',
        checker: 'judge',
        hard: true,
        fix_hint:
            'Remove what contradicts the Seed, repair what contradicts the Summary\u2019s own promise, and add only a commitment the Seed states explicitly that the Summary does not carry; what the Seed leaves open is the Writer\u2019s to fill with any compatible detail, so its absence is not a defect to fix (P5: the Seed is never edited to pass).'
    },
    {
        // C-15 is code because it reads a stored record, not the prose: an unverified sourced
        // Idea that reaches a locked artifact fails it (D-27, W3 acceptance).
        id: 'C-15',
        label: 'every Idea that reached a locked artifact was verified by an Editor and carries evidence',
        question: 'Was every Idea that reached a locked artifact verified by an Editor, with evidence recorded?',
        checker: 'code',
        hard: true,
        fix_hint:
            'Run verifyIdea (re-read the source, record evidence) before the lock, or keep the unverified Idea out of the artifact (D-27).'
    }
];

// ---------------------------------------------------------------------------
// §5.2 — level grouping
// ---------------------------------------------------------------------------

/** One grouping key: the three phase boundaries plus the whole-Story pass, and C-12 outside them. */
export type CriterionLevel = 'summary' | 'plotlines' | 'chapters' | 'whole';

/**
 * §5.2's levels table: one level per phase boundary, plus a whole-Story level, reported
 * separately "because they fail for different reasons" (L-14 renders each as `n/m`, and a
 * level the Story has not reached is `n/a`, not `0/n`).
 */
export const LEVELS: Record<CriterionLevel, string[]> = {
    // Seed → Summary (phase ①).
    summary: ['C-14', 'C-15'],
    // Summary → Plotlines (phase ②).
    plotlines: ['C-0', 'C-1', 'C-2', 'C-3', 'C-4', 'C-5', 'C-6'],
    // Plotlines → Chapters (phase ③).
    chapters: ['C-7', 'C-8', 'C-9'],
    // Whole Story (phase ③, reported once the chapter set exists).
    whole: ['C-10', 'C-11', 'C-13']
};

/**
 * C-12 deliberately sits outside the levels: §5.2 closes the table with "C-12 sits outside
 * the levels as a per-chapter quality check", so it is judged on every chapter and counted
 * in no level's `n/m`.
 */
export const PER_CHAPTER: string[] = ['C-12'];

/** §5.2's "question" column — the sentence each level's number answers (G-2 renders it). */
export const LEVEL_QUESTIONS: Record<CriterionLevel, string> = {
    summary: 'does the Summary deliver the idea the Author actually had?',
    plotlines: 'do the plotlines serve the story the Author declared, in the count the Author declared?',
    chapters: 'does each chapter deliver the contract written for it?',
    whole: 'does the book pay its promise, hold its pace, and sound like the Author?'
};

/** §5.2's level headings — the labels the Stories panel and the Goal panel render (U-6). */
export const LEVEL_LABELS: Record<CriterionLevel, string> = {
    summary: 'Seed \u2192 Summary',
    plotlines: 'Summary \u2192 Plotlines',
    chapters: 'Plotlines \u2192 Chapters',
    whole: 'Whole Story'
};

// ---------------------------------------------------------------------------
// §4.11 / G-5 — the default Goal
// ---------------------------------------------------------------------------

/** G-5: `flat_rounds` is a LOOP-DETECTION parameter, not a budget (§6.8, L-21). */
export const DEFAULT_THRESHOLD_SOFT = 3;
export const DEFAULT_FLAT_ROUNDS = 3;
export const DEFAULT_REGRESS_TOLERANCE = 2;

/**
 * The Goal a new Story starts with: all 16 built-in criteria and the three loop-detection
 * numbers (G-5). A clone, not a shared reference — the Author edits their own Goal (G-1) and
 * must never mutate the built-in roster for everybody else.
 *
 * Note what is NOT here (G-5, E-0): no token field, no minute field, no round cap. Nothing
 * about a Goal can stop a loop; what ends work is a sign-off, an approval wait, or drained
 * (§6.6). The returned `id`/`rev`/timestamps are placeholders: `store.goals.create` assigns
 * the real ones (W1), which is why callers pass this as the create payload rather than
 * inserting it directly.
 */
export function defaultGoal(storyId: string): Goal {
    const now = new Date().toISOString();

    return {
        id: 'goal_default',
        rev: 1,
        created_at: now,
        updated_at: now,
        story_id: storyId,
        title: 'Consistent at every level, and written like mine',
        threshold_soft: DEFAULT_THRESHOLD_SOFT,
        // G-8: the Goal is never "the best story"; the title states the real objective so a
        // fresh crew reading the Goal (G-4) cannot drift into chasing objective quality.
        criteria: BUILT_IN_CRITERIA.map((criterion) => ({ ...criterion })),
        flat_rounds: DEFAULT_FLAT_ROUNDS,
        regress_tolerance: DEFAULT_REGRESS_TOLERANCE
    };
}

/** Convenience lookup for G-2 rendering (`failing: C-4, C-5` needs the label and fix_hint). */
export function criterionById(id: string): Criterion | undefined {
    return BUILT_IN_CRITERIA.find((criterion) => criterion.id === id);
}

// ---------------------------------------------------------------------------
// TEST-ONLY PRODUCT DATA — the server's values, copied into the test scaffolding.
//
// The UI production tree does not import this module. The real values are owned by
// `@underload/storyline` and arrive over the wire (`StoryView.vocabulary` and the phrase
// projections); tests use this mock so a fixture can build a payload without depending on
// the server package (the two packages are separate repositories).
// ---------------------------------------------------------------------------

/** Typed by shape so this mock does not need the server's phrase module. */
export interface MockPhraseGroupDefinition {
    key: string;
    title: string;
    description: string;
    order: number;
}

/** The five Summary groups, in composition order — the server's catalog values. */
export const MOCK_SUMMARY_GROUPS: readonly MockPhraseGroupDefinition[] = [
    {
        key: 'premise',
        title: 'Premise',
        description:
            'What the story is: the situation, who is in it, and the confrontation they are drawn into. One concrete account, no theme statement and no ending.',
        order: 1
    },
    {
        key: 'promise',
        title: 'Promise',
        description:
            'What the story commits the reader to: the experience it undertakes to deliver, and the terms the rest of the book will be held to.',
        order: 2
    },
    {
        key: 'theme',
        title: 'Theme',
        description:
            'What the story is about underneath: the argument it makes, stated as a claim the events can be checked against — never as a moral.',
        order: 3
    },
    {
        key: 'tone',
        title: 'Tone',
        description:
            'Voice, point of view, tense and register the book is written in — the reading surface phase ③ is measured against. Prose qualities named, no sample prose.',
        order: 4
    },
    {
        key: 'ending',
        title: 'Ending',
        description:
            "Where the story lands and what resolves: the outcome the premise and the promise are answered by, including what is deliberately left open.",
        order: 5
    }
];

/** Every Summary group definition, sorted by order. */
export function orderedPhraseGroupDefinitions(): MockPhraseGroupDefinition[] {
    return [...MOCK_SUMMARY_GROUPS].sort((left, right) => left.order - right.order);
}

/** One Summary group definition by key. */
export function phraseGroupDefinition(key: string): MockPhraseGroupDefinition | undefined {
    return MOCK_SUMMARY_GROUPS.find((definition) => definition.key === key);
}

/**
 * The producer's composition format, copied for fixtures only: one `## <title>` per non-empty
 * entry, blank line between, no trailing newline.
 */
export function composePhraseContent(
    entries: ReadonlyArray<{ key: string; title: string; content: string }>,
    rankOf: (key: string) => number = (key) => phraseGroupDefinition(key)?.order ?? Number.MAX_SAFE_INTEGER
): string {
    return [...entries]
        .sort((left, right) => rankOf(left.key) - rankOf(right.key))
        .filter((entry) => typeof entry.content === 'string' && entry.content.trim().length > 0)
        .map((entry) => `## ${entry.title}\n${entry.content.trim()}`)
        .join('\n\n');
}

/** FNV-1a 32-bit, rendered as 8 lowercase hex chars — the server's Seed-hash algorithm, mocked. */
export function seedHashOf(text: string): string {
    let hash = 0x811c9dc5;

    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }

    return hash.toString(16).padStart(8, '0');
}

/**
 * The stored content format of one chapter entry, copied for fixtures only — the server's composer
 * (`server/phrase/plotpoints.ts:chapterEntryContent`), R5 shape: `Heading:` when a heading is given, `Beats:` with
 * one `- ` bullet per beat IN ARRAY ORDER, then `Important dialogue:` the same way and ONLY when the list has a
 * non-blank item. A blank heading or an empty list emits nothing at all rather than a label over nothing, which is
 * why a fixture that wants "no contract" passes `beats: []`.
 */
export function chapterEntryContent(
    _group: unknown,
    fields: {
        heading?: string;
        beats: string[];
        dialogue?: string[];
    }
): string {
    // The same cleaner the route applies: trim, drop blanks, KEEP THE ORDER — order is the contract.
    const listOf = (rows: string[] | undefined): string[] =>
        (rows ?? []).map((row) => row.trim()).filter((row) => row !== '');

    const heading = typeof fields.heading === 'string' ? fields.heading.trim() : '';
    const beats = listOf(fields.beats);
    const dialogue = listOf(fields.dialogue);
    const blocks: string[] = [];

    if (heading !== '') blocks.push(`Heading: ${heading}`);
    if (beats.length > 0) blocks.push(['Beats:', ...beats.map((beat) => `- ${beat}`)].join('\n'));
    if (dialogue.length > 0) blocks.push(['Important dialogue:', ...dialogue.map((line) => `- ${line}`)].join('\n'));

    return blocks.join('\n');
}

/**
 * `GET /phrases` — the phrase kinds a book may open on, row for row as the Server's catalog answers today
 * (`server/api/projections.ts:phraseCatalogView` over `shared/phrase.ts:PHRASE_CATALOG`).
 *
 * WHY THIS IS DATA AND NOT A TEST HELPER WITH THE KEYS INLINED: the create form's selector, `POST /stories`'
 * `start_phrase` and both cleanup verbs are GENERIC (R1), so the desk's own behaviour is pinned by these rows — the
 * pressable option (`starts_on_demand`) is the one the form may send, and the on-create row
 * (`starts_on_create:true`) is the default it must explain rather than offer. A third kind reaches this file as one
 * more row, exactly as it reaches the server as one more definition, and every catalog-driven assertion keeps
 * running (P15).
 */
export const PHRASE_CATALOG_ROWS: PhraseCatalogEntry[] = [
    {
        key: 'summary',
        title: 'Summary Phrase',
        description:
            'The Overview the whole chain is measured against: five named groups, each with its own revision history, composed in this order.',
        order: 1,
        enabled: true,
        starts_on_demand: false,
        starts_on_create: true,
        entry_policy: 'static_groups',
        brief_kind: 'seed_brief',
        seed_source: 'story_idea',
        enters_phase: 'summary'
    },
    {
        key: 'plotlines',
        title: 'Plotlines Phrase',
        description:
            'The book\u2019s chapter contracts, one entry per chapter: each entry holds that chapter\u2019s precise plotpoints \u2014 the beats it has to deliver, in order, and the lines of dialogue it has to land \u2014 and the `plotlines` rows are the mirror the loop already reads.',
        order: 2,
        enabled: true,
        starts_on_demand: true,
        starts_on_create: false,
        entry_policy: 'chapter_entries',
        brief_kind: 'plotline_brief',
        seed_source: 'supplied',
        enters_phase: 'plotlines'
    }
];

/** The server's sample/critic defaults, mocked for fixtures. */
export const DEFAULT_SUMMARY_SAMPLING = 3;export const DEFAULT_SUMMARY_CRITICS = 5;

/** The server's auto-approve default, mocked for fixtures. */
export const DEFAULT_AUTO_APPROVE_COSTS = ['critical', 'major', 'minor'] as const;

/** The server's finding-cost order, mocked for fixtures. */
export const FINDING_COSTS = ['critical', 'major', 'minor', 'taste'] as const;

/** The criterion checker choices, mocked for fixtures. */
export const CRITERION_CHECKERS = ['code', 'judge'] as const;

/** The server's accepted bound for a Summary review count, mocked for fixtures. */
export const SUMMARY_REVIEW_LIMIT = 20;


/** The server's Story-frame vocabulary, mocked for fixtures. */
export function fixtureVocabulary(): StoryVocabulary {
    return {
        finding_costs: [...FINDING_COSTS],
        default_auto_approve: [...DEFAULT_AUTO_APPROVE_COSTS],
        summary_sampling_default: DEFAULT_SUMMARY_SAMPLING,
        summary_critics_default: DEFAULT_SUMMARY_CRITICS,
        summary_review_limit: SUMMARY_REVIEW_LIMIT,
        criterion_checkers: [...CRITERION_CHECKERS],
        goal_levels: (Object.keys(LEVELS) as CriterionLevel[]).map((key) => ({
            key,
            label: LEVEL_LABELS[key],
            question: LEVEL_QUESTIONS[key],
            criteria: [...LEVELS[key]]
        })),
        per_chapter_criteria: [...PER_CHAPTER]
    };
}
