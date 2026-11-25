// PHRASE ② PLOTLINES — chapters as phrase entries: the start, the brief, and the entry set.
//
// WHAT THIS MODULE IS: the Phrase ② domain, the way `catalog.ts` is Phrase ①'s. Four things happen
// here and they are the whole of the phrase's life before a Writer is involved:
//
//   1. START ({@link startPlotlinesPhrase}) — create the phrase row with a COPIED seed. This is the step
//      the catalog deliberately does not do: an `enabled` phrase whose definition says
//      `starts_on_demand` has no row until someone hands it the text it will be written from, and the
//      copy is what makes the phrases discrete. Pushing the compiled Summary in, or the Author typing
//      their own text, are the same call; a later edit or deletion of Phrase ① cannot reach this row.
//   2. STRUCTURE — the brief lives in `plotline_briefs` and is created by the Editor pass (the tool wave
//      writes it; {@link createPlotlineBrief} is the domain operation it writes through). Its
//      `seed_hash` is the hash of the PHRASE's seed, so a stale structure can never pass the gate.
//   3. ACCEPT ({@link acceptPlotlineBrief}) — the one moment the chapter set becomes records: the brief
//      is marked accepted, `summaries.chapter_count` is synced to the brief's number (the ONLY place the
//      phrase pipeline writes that number, and it is the Editor's decision accepted by the Author, not a
//      Writer's — D-3b), and ALL N chapter entries are materialized IN ONE GO, because "all chapters are
//      generated from the Seeds in one go" means the entry set is never discovered a chapter at a time.
//   4. THE ENTRY SET ({@link ensureChapterGroups}) — idempotent, keyed `chapter_<n>`, ordered by n.
//
// WHAT IS DELIBERATELY NOT HERE: no `plotlines` ROWS. Those are created by an INSTALL
// (`../plotpoints.ts:syncPlotlineContract`), from a Writer's answer, not by this module. A phrase that
// starts with three chapters has three UNWRITTEN entries and no contracts yet, so C-0 and the loop's
// completeness read still say the book owes work — which is the property that keeps the loop running
// after a start rather than declaring a fresh phrase finished.

import {
    PHRASE_PLOTLINES_KEY,
    phraseDefinition,
    phraseEntryDefinitions,
    type PhraseDefinition
} from '../../../shared/phrase';
import { CHAPTER_DRAFT_SCHEMA_NAME, ChapterDraftSchema } from '../../../shared/schemas';
import { seedHashOf } from '../../../shared/seed-hash';
import type {
    Phrase,
    PhraseGroup,
    PlotlineBrief,
    PlotlineBriefChapter,
    Story,
    Summary
} from '../../../shared/types';
import type { Attribution, Store } from '../../store';
import type { PhraseController, PhraseInstructionSet, PhraseStartOptions, PhraseStartResult } from '../controller';
import {
    isPhraseGroupManaged,
    phraseGroupsOf,
    phraseIdFactoryOf,
    phraseSeedInitOf,
    phraseSeedOf,
    storyPhraseByKey,
    type PhraseOptions
} from '../catalog';
import { installGroupRevisions, type GroupInstallEntry, type GroupInstallOptions } from '../revisions';
import { chapterEntryContent, parseChapterDraftAnswer, type PlotpointFields } from '../plotpoints';

/** The catalog entry this controller is bound to. The catalog is the source; the cast is a wiring assertion. */
const DEFINITION = phraseDefinition(PHRASE_PLOTLINES_KEY) as PhraseDefinition;

// ---------------------------------------------------------------------------
// The start: a phrase instance with its own copied seed
// ---------------------------------------------------------------------------

/**
 * Whether this Story's Plotlines Phrase has been started — the check {@link startPlotlinesPhrase}
 * refuses on, exposed so a route can answer 409 without running a write it knows will throw.
 */
export const isPlotlinesStarted = (store: Store, storyId: string): boolean =>
    storyPhraseByKey(store, storyId, PHRASE_PLOTLINES_KEY) !== undefined;

/**
 * Starts Phrase ② on a Story: creates its `phrases` row with the SEED COPIED from `seedText`.
 *
 * THE COPY IS THE WHOLE POINT (the user's "phrases are discrete and independent"): `seedText` is the
 * compiled Summary the Author pushed in, or text the Author typed themselves, and from this moment the
 * phrase reads its OWN `seed` field (`catalog.ts:phraseSeedOf`) and never `stories.idea` or Phrase ①'s
 * rows. Deleting or rewriting Phrase ① afterwards changes nothing here — including the hash every
 * Phrase ② gate takes.
 *
 * WHAT IT DOES NOT CREATE: the entry groups. The chapter count is the brief's decision, not the start's,
 * so a start leaves a phrase with no entries and the loop's completeness read still owes the work.
 * Materializing the set is one atomic step
 * ({@link acceptPlotlineBrief}), which is what "all chapters in one go" means in record terms.
 *
 * THE TWO REFUSALS, both before any write:
 *   - an empty seed. A phrase over a blank seed would have its blank text hashed as though the Author
 *     had written something, and every gate would read a structured book with nothing in it; and
 *   - an already-started phrase. Re-starting on new text is NOT a re-seed of the same row: the row is
 *     the identity that its entries, its revisions and its claim keys name, and quietly re-pointing its
 *     seed would rewrite the input of history that has already been written against it. A caller that
 *     wants a fresh Phrase ② deletes the book's phrase or starts a new Story.
 */
export function startPlotlinesPhrase(
    store: Store,
    story: Story,
    seedText: string,
    attribution: Attribution,
    options: PhraseOptions = {}
): { phrase: Phrase; started: boolean } {
    const seed = typeof seedText === 'string' ? seedText.trim() : '';

    if (seed === '') {
        throw new Error(
            `startPlotlinesPhrase: story ${story.id} was started with an empty seed — the text handed to Phrase ② becomes its seed, and a blank one would be hashed by every gate as though it were the Author's input`
        );
    }

    const existing = storyPhraseByKey(store, story.id, PHRASE_PLOTLINES_KEY);

    if (existing !== undefined) {
        throw new Error(
            `startPlotlinesPhrase: story ${story.id} already has a Plotlines Phrase (${existing.id}) — its seed is the input every entry, revision and claim key was written against, so a new seed needs a new phrase, not a re-seeded one`
        );
    }

    const phrase = store.phrases.createWithId(
        phraseIdFactoryOf(options)(),
        {
            story_id: story.id,
            key: DEFINITION.key,
            title: DEFINITION.title,
            description: DEFINITION.description,
            // Nothing composed yet — the same "empty, not a placeholder" rule `ensurePhraseCatalog`
            // states, and truer here: this phrase has no entries at all until its brief is accepted.
            content: '',
            order: DEFINITION.order,
            revision: 0,
            group_refs: [],
            // THE COPIED SEED, through the definition's own rule so a future phrase kind with a
            // different `seed_source` starts the same way without this call site changing.
            seed: phraseSeedInitOf(DEFINITION, story, seed)
        },
        attribution
    );

    return { phrase, started: true };
}

// ---------------------------------------------------------------------------
// The brief: the Editor's structure pass over the phrase's copied seed
// ---------------------------------------------------------------------------

/** What a new brief carries: the Editor's chapter decision, and the optional per-chapter seeds. */
export interface PlotlineBriefInit {
    chapter_count: number;
    chapters?: PlotlineBriefChapter[];
    research_questions?: string[];
    notes?: string;
}

/**
 * Creates a DRAFT `plotline_brief` for a started Phrase ②, hashed against the phrase's own seed.
 *
 * THE HASH IS TAKEN FROM `phraseSeedOf`, never from `stories.idea` (§3.3's rule applied one phrase
 * down): the thing being structured is the phrase's copied seed, so a Phrase ① edit cannot make this
 * structure stale, and a re-started phrase on different text cannot reuse a structure that described
 * the old text.
 *
 * It stays a DRAFT. Acceptance is the step with consequences (a chapter count and a set of entries), so
 * it is an explicit call, and a brief the Editor wrote but nobody accepted has created nothing.
 */
export function createPlotlineBrief(
    store: Store,
    story: Story,
    phrase: Phrase,
    init: PlotlineBriefInit,
    attribution: Attribution
): PlotlineBrief {
    if (phrase.story_id !== story.id) {
        throw new Error(`createPlotlineBrief: phrase ${phrase.id} belongs to another story than ${story.id}`);
    }

    const chapterCount = Math.trunc(init.chapter_count);

    if (!Number.isInteger(chapterCount) || chapterCount < 1) {
        throw new Error(
            `createPlotlineBrief: chapter_count ${init.chapter_count} is not a positive whole number — the Editor's structure pass decides how many chapters the seed resolves into, and materialization needs an exact one`
        );
    }

    return store.plotlineBriefs.create(
        {
            story_id: story.id,
            phrase_id: phrase.id,
            seed_hash: seedHashOf(phraseSeedOf(phrase, story)),
            chapter_count: chapterCount,
            ...(init.chapters === undefined
                ? {}
                : {
                      // Stored as written, in the order given: materialization reads the count, not this
                      // list, so a short or ragged list is an Editor note rather than a broken book.
                      chapters: init.chapters.map((chapter) => ({ order: chapter.order, seed: chapter.seed }))
                  }),
            status: 'draft',
            ...(init.research_questions === undefined ? {} : { research_questions: init.research_questions }),
            ...(init.notes === undefined || init.notes === '' ? {} : { notes: init.notes })
        },
        attribution
    );
}

/** What an {@link acceptPlotlineBrief} call did, in shapes a route and a test can assert exactly. */
export interface PlotlineBriefAcceptResult {
    /** The brief row after acceptance. */
    brief: PlotlineBrief;
    /** The phrase the entries were materialized on. */
    phrase: Phrase;
    /** The phrase's chapter entries after the call, in chapter order — all N, pre-existing or new. */
    groups: PhraseGroup[];
    /** Ids created by THIS call, in chapter order. Empty on a second accept. */
    created_group_ids: string[];
    /** The `summaries` row the chapter count was synced onto, or null when the book has none. */
    summary_ref: string | null;
    /** True when THIS call wrote `chapter_count` (the number was already right on a second accept). */
    chapter_count_synced: boolean;
}

/**
 * Accepts a Plotline brief: marks it accepted, syncs the chapter count, and materializes ALL N chapter
 * entries in one commit-shaped step.
 *
 * THE THREE WRITES, in the order they happen and each with its reason:
 *   1. the chapter ENTRIES, via {@link ensureChapterGroups} — the count comes from the brief, and one
 *      call creates `chapter_1…chapter_N`, because "all chapters are generated from the Seeds in one go"
 *      is a promise about the entry set being whole the moment it exists;
 *   2. `summaries.chapter_count`, PRIMITIVE ONLY (no prose field is touched) — D-3b says a WRITER may
 *      not choose the chapter count, and this is not a Writer: it is the Editor's structure pass,
 *      accepted by an explicit act, which is the same authority that declares the number in the classic
 *      pipeline. Nothing else in the phrase layer writes it;
 *   3. the brief's `status`, LAST, so a caller that re-reads a `draft` brief after a partial failure sees
 *      a book whose entries were never declared rather than a book declared complete.
 *
 * IDEMPOTENT BY SKIPPING, like every other step in this package: a second accept creates no groups,
 * writes no count it did not need, and writes no status it already had, so a retried press is safe.
 *
 * THE STALE-BRIEF REFUSAL runs before all three: `seed_hash` must still match the phrase's seed. A
 * structure for a seed that is no longer there would materialize a chapter count nobody asked this text
 * for, and every entry beneath it would inherit the mistake.
 */
export function acceptPlotlineBrief(
    store: Store,
    story: Story,
    brief: PlotlineBrief,
    attribution: Attribution,
    options: PhraseOptions = {}
): PlotlineBriefAcceptResult {
    const phrase = store.phrases.get(brief.phrase_id);

    if (phrase === undefined || phrase.story_id !== story.id) {
        throw new Error(
            `acceptPlotlineBrief: brief ${brief.id} names phrase ${brief.phrase_id}, which is not a phrase of story ${story.id}`
        );
    }

    const currentHash = seedHashOf(phraseSeedOf(phrase, story));

    if (brief.seed_hash !== currentHash) {
        throw new Error(
            `acceptPlotlineBrief: brief ${brief.id} was structured from seed hash ${brief.seed_hash} and this phrase's seed hashes ${currentHash} — a structure for a different seed cannot declare this book's chapters`
        );
    }

    const ensured = ensureChapterGroups(store, story, phrase, brief.chapter_count, attribution, options);

    // THE LEGACY COUNT (D-3b). Only the one primitive, and only when it disagrees, so a re-accept adds
    // no journal line. A book with no `summaries` row is reported rather than invented: creating one
    // here would have to guess every other field of it.
    const summary = store.summaries.list().find((row) => row.story_id === story.id);
    const chapterCountSynced = summary !== undefined && summary.chapter_count !== brief.chapter_count;

    if (summary !== undefined && chapterCountSynced) {
        store.summaries.update(
            summary.id,
            { chapter_count: brief.chapter_count },
            // The count is a DECISION, so it is journaled with the accept and names the brief it came from
            // — the audit line that tells a later reader which of the two authors set the number (P11).
            { ...attribution, why: `${attribution.why}; the chapter count is the accepted brief's (D-3b, brief ${brief.id})` },
            [{ id: summary.id, rev: summary.rev }]
        );
    }

    const accepted =
        brief.status === 'accepted'
            ? brief
            : store.plotlineBriefs.update(brief.id, { status: 'accepted' }, attribution, [
                  { id: brief.id, rev: brief.rev }
              ]);

    return {
        brief: accepted,
        phrase: store.phrases.require(phrase.id),
        groups: ensured.groups,
        created_group_ids: ensured.created_group_ids,
        summary_ref: summary?.id ?? null,
        chapter_count_synced: chapterCountSynced
    };
}

// ---------------------------------------------------------------------------
// The entry set: `chapter_1 … chapter_N`, materialized whole and idempotently
// ---------------------------------------------------------------------------

/** What an {@link ensureChapterGroups} call did. */
export interface ChapterGroupsResult {
    /** The phrase's chapter entries `1..N`, in chapter order. */
    groups: PhraseGroup[];
    /** Ids created by THIS call, in chapter order. Empty = the set was already materialized. */
    created_group_ids: string[];
}

/**
 * Materializes (or re-confirms) the chapter entry set of one phrase, in one go.
 *
 * THE ORDER IS THE KEY'S NUMBER, and both are written from the same `n`: `chapter_3` gets `order: 3` and
 * the title `Chapter 3`, so the composition order, the Plotline row the install mirrors, and the label
 * the Author's rail shows cannot disagree, and a redraft of chapter 3 finds chapter 3's contract
 * whatever order its batch arrived in.
 *
 * IDEMPOTENT BY KEY LOOKUP, the same way `ensurePhraseCatalog` is idempotent by key lookup: an existing
 * `chapter_n` row is left exactly as it is (its text and its revision history are the book's), so
 * accepting a brief twice, or re-accepting after the Writer has installed chapters 1-2, creates only
 * what is missing.
 *
 * A PHRASE WITH MORE ENTRIES THAN `N` KEEPS THEM. Shrinking a chapter count never deletes rows: entries
 * carry revision history, and deleting records to match a setting is how history disappears (D-12a). The
 * `group_refs` list is what says which entries the phrase composes RIGHT NOW, and it is rewritten to the
 * `1..N` set when it disagrees — the same "only when it disagrees" rule that keeps a restart's second
 * call silent.
 */
export function ensureChapterGroups(
    store: Store,
    story: Story,
    phrase: Phrase,
    chapterCount: number,
    attribution: Attribution,
    options: PhraseOptions = {}
): ChapterGroupsResult {
    const definitions = phraseEntryDefinitions(PHRASE_PLOTLINES_KEY, chapterCount);

    if (definitions.length === 0) {
        return { groups: [], created_group_ids: [] };
    }

    const newId = phraseIdFactoryOf(options);
    const ownedByKey = new Map(
        phraseGroupsOf(store, story.id, phrase.id).map((group) => [group.key, group] as const)
    );
    const createdGroupIds: string[] = [];
    const groupIds: string[] = [];

    for (const definition of definitions) {
        const existing = ownedByKey.get(definition.key);

        if (existing !== undefined) {
            groupIds.push(existing.id);
            continue;
        }

        const created = store.phraseGroups.createWithId(
            newId(),
            {
                story_id: story.id,
                // Filled here, not in the definition: `ensure` may itself have created the phrase, so the
                // real row id is the one field the definition cannot know.
                phrase_id: phrase.id,
                key: definition.key,
                title: definition.title,
                description: definition.description,
                order: definition.order,
                // An unwritten chapter: `''` + `revision: 0`, the state the loop reads as first-draft work
                // (R2) — and the reason a start plus an accept still leaves the book owing everything.
                content: '',
                revision: 0,
                updated_by: null
            },
            attribution
        );

        createdGroupIds.push(created.id);
        groupIds.push(created.id);
    }

    // The ordered id list, rewritten only when it disagrees (the `ensurePhraseCatalog` rule, for the same
    // reason: an idempotent second call must add no journal line).
    if (phrase.group_refs.join('|') !== groupIds.join('|')) {
        store.phrases.update(
            phrase.id,
            { group_refs: groupIds },
            {
                ...attribution,
                why: `${attribution.why}; the phrase's ordered chapter list was behind its rows (R6)`
            },
            [{ id: phrase.id, rev: phrase.rev }]
        );
    }

    return { groups: phraseGroupsOf(store, story.id, phrase.id), created_group_ids: createdGroupIds };
}

// A ChapterDraft answer, validated, lives in `../plotpoints.ts` (the barrel re-exports it from there,
// and so does the loop's settle in the next wave); the same for `chapterEntryContent`. This module's
// `parseDraft` hook is the phrase-generic path to the same function.

// ---------------------------------------------------------------------------------------------
// Phrase ②'s engine-owned instruction text.
//
// Same rule as the Summary controller's: these are the ANSWER CONTRACTS in the engine's voice, not
// Author-editable role prose (R7), and they are written to sit next to the entries they name. The
// prompt compiler that reads them is the next wave's file; what matters HERE is that a chapter pass has
// these sentences somewhere phrase-generic to ask for, because the rules a chapter answer has to satisfy
// are not the rules a Summary answer satisfies.
// ---------------------------------------------------------------------------------------------

const PLOTLINES_DRAFT_INSTRUCTION =
    'Answer with one `groups` entry for EVERY chapter named above and for NO other entry: `group_ref` is exactly the id printed in ' +
    'that heading, and the fields are that chapter\u2019s PLOTPOINTS \u2014 `must_happen` (the events the chapter has to deliver), ' +
    '`must_change` (what is different when it ends: state, knowledge, relationship, position), `pov` (whose eyes it is told ' +
    'through), `setups` (what it plants) and `payoffs` (what it collects).\n' +
    '- These are CONTRACT FIELDS, not prose. A scene summary, a paragraph of the chapter, or a mood sentence answers none of ' +
    'them; the loop checks `must_happen` and `must_change` against the finished chapter, and it cannot check a vibe.\n' +
    '- Stay inside the chapter the entry is. A chapter that takes on the next chapter\u2019s turn steals it, and the two chapters ' +
    'then both claim one change. The chapter count is fixed by the accepted brief: never add a chapter, never merge two.\n' +
    '- Where the entry already has a contract, REVISE it against the fix tasks and keep every commitment they do not touch: the ' +
    'neighbouring chapters are being written against those facts, and a setup you quietly drop leaves the chapter that pays it ' +
    'owing a debt nobody can see.\n' +
    '- `setups` and `payoffs` are a ledger, and the ledger is read across the whole phrase: name the debt, not "a clue". A setup ' +
    'no later chapter pays, or a payoff no earlier chapter planted, is a defect the next pass will find and you will spend a pass ' +
    'answering.\n' +
    '- The same chapter twice, a chapter you were asked for that you leave out, or a `group_ref` this job never printed fails the ' +
    'whole batch: the engine installs an answer for every named chapter or for none.\n' +
    '- An entry marked `LOCKED` is a signed-off contract: never answer for one, and treat what it states as a fact this chapter ' +
    'has to fit with.';

const PLOTLINES_REVIEW_INSTRUCTION =
    'JUDGE THE CHAPTERS TOGETHER. Every issue names the `group_refs` of the chapter or chapters it is about, copied from the ids ' +
    'the SECTION printed \u2014 and a defect that crosses chapters names every chapter it crosses: a payoff collected in chapter 7 ' +
    'from a setup planted in chapter 2 is ONE issue naming both, because the repair is one decision about two contracts.\n' +
    '- The chain is the thing to check: every payoff has a setup somewhere before it, every setup is collected somewhere after ' +
    'it, and a chapter that changes nothing leaves the book flat. Say which end of the chain is wrong and name the other end.\n' +
    '- Continuity of state, knowledge and relationship across the chapter boundaries: a character who does not yet know something ' +
    'acting on it in chapter 4, a position that silently resets. Name the chapter that introduces the contradiction and the one ' +
    'that has to answer it.\n' +
    '- A contract may be sparse and still correct; it is not a defect that a chapter does not say things your taste would like. ' +
    'A defect is something the other chapters now cannot be written against.\n' +
    '- A chapter marked `LOCKED` is the BASELINE: its contract is fixed text, so name the UNLOCKED chapter that has to move to ' +
    'agree with it. This pass writes nothing.';

const PLOTLINES_SCORE_INSTRUCTION =
    'SCORE EVERY CHAPTER ONCE, a whole number from 0 to 100, answering one question: how well does this chapter\u2019s contract hold ' +
    'up as a contract \u2014 is it specific enough that a chapter could be written to it and checked against it, does it connect to ' +
    'the chapters on either side, and are its setups and payoffs real debts rather than labels? Anchor the ends: 100 is a contract ' +
    'the surrounding chapters are written against, 70 is sound with a seam you can point at, 40 is a chapter that fights its ' +
    'neighbours, 10 is a heading with no obligations in it. Do NOT deduct for prose nobody has written yet, for a chapter shorter ' +
    'than you would choose, or for a detail the seed never promised. Name every chapter exactly once, with one `rationale` and one ' +
    '`evidence` quote taken verbatim from that entry. This pass reports a number: it files no finding, opens no task, and edits ' +
    'nothing.';

const PLOTLINES_LOCK_INSTRUCTION =
    'A CHAPTER CONTRACT is lockable when the judgement on it is exhausted rather than merely good: the Critic\u2019s findings on it ' +
    'are spent and the Reader\u2019s score and rationale say it is doing its job. Locking one fixes what that chapter must deliver, ' +
    'and the chapters on either side become the side that gets revised to stay consistent \u2014 so the recommendation has to name ' +
    'what would have to move elsewhere if it is locked, and in particular whether any setup or payoff still crosses into it. A ' +
    'chapter whose debt is unpaid in the unlocked half is not ready: lock the half that answers, not the half that still owes. ' +
    'The Editor may not unlock, and on a Story that has not enabled editor locking it may not lock at all.';

/** PHRASE ② as a controller: chapters as entries, a copied seed, and the `plotlines` mirror. */
export const plotlinesPhraseController: PhraseController = {
    key: PHRASE_PLOTLINES_KEY,
    definition: DEFINITION,

    isManaged: (story) => isPhraseGroupManaged(story, PHRASE_PLOTLINES_KEY),

    phraseOf: (store, storyId) => storyPhraseByKey(store, storyId, PHRASE_PLOTLINES_KEY),

    groupsOf: (store, storyId, phraseId) => phraseGroupsOf(store, storyId, phraseId),

    // Phrase ② starts on demand, and the text handed in IS its seed (see `startPlotlinesPhrase`). The
    // controller is the IDEMPOTENT form — it reports `started: false` for a phrase that already exists,
    // which is what a retrying route wants — while the domain function it delegates to REFUSES, so a
    // caller that means "start it or tell me why not" can tell the two apart. Neither one re-seeds: a
    // started phrase's seed is the input its entries and claim keys were written against.
    start: (store, story, attribution, options: PhraseStartOptions = {}): PhraseStartResult => {
        const existing = storyPhraseByKey(store, story.id, PHRASE_PLOTLINES_KEY);

        if (existing !== undefined) return { phrase: existing, started: false };

        if (typeof options.seedText !== 'string' || options.seedText.trim() === '') {
            throw new Error(
                `plotlinesPhraseController.start: phrase 2 needs the seed text to copy (the compiled Summary, or the Author's own text) — story ${story.id}`
            );
        }

        const started = startPlotlinesPhrase(store, story, options.seedText, attribution, options);

        return { phrase: started.phrase, started: started.started };
    },

    // The counted phrase: `entryCount` is the accepted brief's chapter count, and this is the one-go
    // materialization the loop and the accept step share.
    ensureGroups: (store, story, phrase, entryCount, attribution, options = {}) =>
        ensureChapterGroups(store, story, phrase, entryCount, attribution, options).groups,

    answer: { name: CHAPTER_DRAFT_SCHEMA_NAME, schema: ChapterDraftSchema },

    parseDraft: (store, story, requestedGroupRefs, structured, phraseId) => {
        const scoped = phraseId ?? storyPhraseByKey(store, story.id, PHRASE_PLOTLINES_KEY)?.id;

        if (scoped === undefined) {
            return {
                ok: false,
                refusal: `story ${story.id} has no Plotlines Phrase — a chapter draft answers the chapter entries of a started phrase, and this book has none to answer`
            };
        }

        return parseChapterDraftAnswer(store, story.id, scoped, requestedGroupRefs, structured);
    },

    install: (store, story, entries, attribution, options) =>
        installGroupRevisions(store, story, entries, attribution, options),

    // A chapter entry's text is the labelled plotpoint block, derived from the fields rather than handed
    // over as prose — which is what keeps the entry text and the mirrored contract one derivation.
    composeEntryContent: (group, fields) => chapterEntryContent(group, fields ?? { must_happen: '', must_change: '' }),

    // ITS OWN PHRASE ROW (seam S8). The Summary contributes the `summaries` row id; this contributes the
    // phrase id, so `wi_draft_groups_<summaryRef>_…` and `wi_draft_groups_<plotlinesPhraseId>_…` on one
    // book are disjoint families and neither re-claims the other's attempts after a restart.
    draftClaimRef: (store, story, phrase) =>
        phrase?.id ?? storyPhraseByKey(store, story.id, PHRASE_PLOTLINES_KEY)?.id ?? '',

    instructions: {
        draft: PLOTLINES_DRAFT_INSTRUCTION,
        review: PLOTLINES_REVIEW_INSTRUCTION,
        score: PLOTLINES_SCORE_INSTRUCTION,
        lock: PLOTLINES_LOCK_INSTRUCTION
    }
};
