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
import type {
    PhraseBriefSection,
    PhraseController,
    PhraseInstructionSet,
    PhraseStartOptions,
    PhraseStartResult,
    PhraseStructureSeatInput
} from '../controller';
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

// ---------------------------------------------------------------------------------------------
// THE STRUCTURE SEAT (R2/R3/R7) — what Phrase ②'s structuring Editor is told.
//
// WHY THIS IS THE FIX THE OWNER ASKED FOR. The user's report was that accepting the compiled Summary
// into the Plotlines Phrase and moving to Phrase ② "doesn't copy the complete compile Seed correctly
// (or maybe it did and the Editor messed it up)". It copied correctly: `startPlotlinesPhrase` stores the
// text verbatim and every gate hashes it. What was missing was the BRIEF. Measured against the real
// builder (Temp/create-storyline-probe): the phrase seed rode ONLY inside the job note, and
// `run/brief.ts:renderJob` clips the note at 600 characters, of which this job's fixed prefix took 535
// — so a 1,714-character Overview arrived as 65 characters of prose plus a "read the full record with
// the read tool" tail, and the seat's job sentence was Phrase ①'s (`structureSeed`, the Seed Brief, the
// D-51 research waiver) because both seats share the `structure_seed` KIND. An Editor briefed for
// Phase ①, shown 3.6% of the text, and told its job was a Seed Brief is exactly the observed mess.
//
// SO THIS SLOT CARRIES THREE THINGS, all phrase-owned and none of them a branch in `run/brief.ts`:
// the job sentence that names `structurePlotlines` and the chapter count (R2), the unclipped section
// that shows the whole text being structured with its hash (R1), and the declared count presented as
// the default to honor (R3). P5 and P10 are unchanged: the seat still reads the seed and writes no
// prose, and D-3b is still unbent — the count stays the STRUCTURING pass's decision (the write is
// `acceptPlotlineBrief` below), this copy only makes the Author's number visible and a deviation
// explainable.
// ---------------------------------------------------------------------------------------------

/**
 * The seat's `PHRASE SEED` section, rendered WHOLE.
 *
 * WHY A SECTION AND NOT THE NOTE: a brief section named in `AssembledBrief.sections` is the assertion
 * surface for "the brief is self-contained" (S-2), and E-1/D-13 put the artifact UNDER the trim ladder's
 * protection rather than under it — the notes get trimmed, the reading does not. `clip(item.note, 600)`
 * in `run/brief.ts:renderJob` is the clip this seat was losing its seed to, so the seed stops riding in
 * the note entirely: `loop/work.ts:1614` now puts the instruction and the hash there and nothing else.
 *
 * THE HEADING AND BODY BOTH PRINT `seed_hash=<hash>`, in the `=` form, for two reasons: the seat has to
 * send the value verbatim (`tools/plotlines.ts:187-203` refuses anything else and cannot recover a hash
 * it never printed), and `integration/harness.ts:901` reads the FIRST `seed_hash=` in the brief as the
 * scripted crew's answer. The phase-① `SEED BRIEF` section above prints `seed_hash: <hash>` with a
 * colon, so it cannot shadow this one.
 */
function plotlinesStructureSeedSection(input: PhraseStructureSeatInput): PhraseBriefSection {
    const { store, story } = input;
    const phrase = story === undefined ? undefined : storyPhraseByKey(store, story.id, PHRASE_PLOTLINES_KEY);
    const seed = phraseSeedOf(phrase, story);
    const seedHash = seedHashOf(seed);

    return {
        heading: `PHRASE SEED — the text Phrase ② resolves into chapters (read-only for you, P5 one phrase down) · seed_hash=${seedHash}`,
        body:
            `${seed}\n\n` +
            `seed_hash=${seedHash} — \`structurePlotlines\` checks THIS text against that value and refuses any other with P5. It is ` +
            'not the Story’s Seed above, and not the top-level `seed_hash` `readSeed` prints; that read prints this one as the ' +
            'Plotlines entry of its `phrases[]`. The text is GENERAL, not an outline with unfilled boxes: the chapter set is what it ' +
            'resolves into, and a detail it leaves silent stays the Writers’ choice (P7, D-17c). Never edit it (P5).'
    };
}

/**
 * The job sentence: the chapter decision, the one tool that makes it, and the number on the record.
 *
 * THE DECLARED COUNT IS THE DEFAULT, NOT A CEILING (R3, D-3b). `summaries.chapter_count` is the
 * Author's field (D-3b), and it is the number the classic phase ② pipeline would have written contracts
 * against, so an Author who already decided "12 chapters" has to see it honored or answered — that is
 * the whole of R3. Authority does not move: `acceptPlotlineBrief` is still the writer of the count
 * (`acceptPlotlineBrief`'s D-3b journal line below), the Editor may still overwrite it, and no new
 * approval step is added. What is added is the obligation to SAY why, in the `why` the call already
 * carries (T-5).
 */
function plotlinesStructureJob(input: PhraseStructureSeatInput): string {
    const { store, story } = input;
    const phrase = story === undefined ? undefined : storyPhraseByKey(store, story.id, PHRASE_PLOTLINES_KEY);
    const seedHash = seedHashOf(phraseSeedOf(phrase, story));

    // THE COUNT ON THE RECORD, read the same way `acceptPlotlineBrief` reads it below (the `summaries`
    // row of this Story). `undefined` or 0 means the book has no number yet — a fresh Phrase ② on a
    // Story with no Summary row — and the honest sentence is "yours to decide", not "honor nothing".
    const declared = story === undefined
        ? undefined
        : store.summaries.list().find((row) => row.story_id === story.id)?.chapter_count;
    const countClause =
        typeof declared === 'number' && declared > 0
            ? `The book declares \`chapter_count: ${declared}\` on its Summary row today, and that number is the Author’s (D-3b): it is the DEFAULT this job honors. Answer with exactly ${declared} unless the seed cannot be read as that many chapters, and when you deviate, name the reason in this call’s \`why\` — a deviation is allowed, an unexplained one is not, and there is no approval step downstream that would catch it.`
            : 'No chapter count is on the record for this book yet, so the number is yours to decide from the seed and nothing else, and 1 is a legitimate chapter set (D-3b).';

    return (
        'Structure the `PHRASE SEED` section of this brief BEFORE any chapter contract is drafted — the lane refuses every other ' +
        'Phrase ② job until an accepted Plotline Brief exists, because until it does the book has no chapter set to draft against. ' +
        'Read it once: it is the text THIS Phrase resolves into chapters, it is Author truth and read-only forever (P5, one phrase ' +
        'down), and it is the only source of facts this job may use. ' +
        // F3 — THE SECTION THE SEAT MAY NOT SEE. The old copy said the derived `SEED BRIEF` sat "beside" the `SEED`
        // section, which is a promise about a heading the brief is free not to print: `run/brief.ts`'s seat-aware
        // rung drops exactly that section whenever the brief runs over `BRIEF_CHAR_BUDGET`, and on the built-in
        // template this seat's brief is over it at EVERY seed size (measured 14,247 characters on a 422-character
        // compiled Overview, rising to 38,248 at a 24k seed, against the 12,000 budget — `Temp/c9/probe-f3.out`,
        // and `has_seed_brief: false` on every row). The trim is decided AFTER this sentence is composed, so the
        // copy cannot name the section's presence at all: what follows states the RULE and tells the seat to read
        // the headings that are actually there, which is true whether the rung fired or not. Fixing the budget is
        // a separate, recorded hole — this sentence must simply stop lying.
        'Phrase ①’s `SEED` section above is context only, and so is the derived `SEED BRIEF` — and that second heading is ' +
        'NOT one this brief guarantees you: it is the single section the seat-aware rung in `run/brief.ts` trades for a ' +
        'character count when the brief runs over budget, so read the headings that are actually in front of you and never ' +
        'go looking for one that is not there. Neither section is the text you are structuring, either: that is the ' +
        '`PHRASE SEED`, and the hash you answer with is that ' +
        'text’s. Decide the chapter set the seed actually resolves into — one chapter per commitment it states that cannot be ' +
        'settled inside the previous one — then call `structurePlotlines` ONCE with `chapter_count`, the per-chapter seeds the ' +
        `Writers should carry, and seed_hash=${seedHash} exactly as the \`PHRASE SEED\` section prints it. That one call CREATES the ` +
        'brief AND ACCEPTS it: it writes `summaries.chapter_count` and materializes `chapter_1..chapter_N` in the same commit, and ' +
        `every chapter contract is written against exactly that set (D-3b). ${countClause} Never edit the phrase seed (P5), and write ` +
        'no story artifact yourself (P10, L-19): no plotline, no chapter, no Summary, no Idea. `structurePlotlines` is your only ' +
        'write, and stop as soon as it reports.'
    );
}

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
        lock: PLOTLINES_LOCK_INSTRUCTION,
        // THE STRUCTURE SEAT (R1/R2/R3/R7) — the Editor that turns this phrase's copied seed into the
        // chapter set. Its claim family, `wi_structure_plotlines_<phrase seed hash>`, is what
        // `run/brief.ts` reads to put this copy in front of that seat instead of Phrase ①'s.
        structure: {
            // `loop/records.ts:1420` (`PLOTLINES_STRUCTURE_ITEM_PREFIX`). The two prefixes MUST stay
            // disjoint — the same text in both phrases hashes the same, and one family would let
            // Phrase ①'s accepted structuring satisfy Phrase ②'s (`loop/work.ts:1543-1545`) — and
            // `loop/phase2-groups.test.ts` pins this literal against the planner's real key.
            seatKeyPrefix: 'wi_structure_plotlines',
            // THE COUNT IS THIS SEAT'S PRODUCT: `acceptPlotlineBrief` writes `summaries.chapter_count`
            // inside the same commit as the chapter set (D-3b — the structuring pass, never a drafting one).
            declaresChapterCount: true,
            job: plotlinesStructureJob,
            // THE SEED IS THE ARTIFACT. Naming it wrongly is how the seat could not tell which text it
            // was judging: Phrase ①'s heading calls the artifact `the Seed`, and on a book whose Phrase ②
            // was seeded from the compiled Overview both texts are prose the Author wrote.
            artifactHeading: () =>
                'the Phrase ② seed (structure pass — you declare the chapter set, and neither this seed nor any prose is yours to edit, P5 one phrase down)',
            // R1: the whole copied seed, unclipped, with the hash `structurePlotlines` accepts. Phrase ①'s
            // `SEED` section stays, and its derived `SEED BRIEF` is the one section the brief's seat-aware
            // rung may DROP when the brief is over budget (`run/brief.ts:seatTrimHeading`) — which is why
            // `plotlinesStructureJob` names both conditionally instead of promising a heading that can be
            // trimmed away. The seat's own artifact is never among the tradeable ones: E-0 keeps it whole.
            seedSection: plotlinesStructureSeedSection
        }
    }
};
