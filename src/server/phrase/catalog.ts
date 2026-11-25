// THE PHRASE CATALOG — the catalog's life in the book (R1, R6), now for every phrase kind.
//
// WHAT THIS MODULE OWNS: the rule that turns the CODE catalog (`shared/phrase.ts` — which phrases
// exist, what each composes from and what its entries are called) into RECORDS (`phrases`,
// `phrase_groups`), plus the predicates that say whether a Story runs a GIVEN phrase in the group
// model, plus the one PREDICATE that says whether a group's current text is locked
// (`isPhraseGroupLocked` — the lock's WRITES belong to `locks.ts`, and every other read asks this
// one). Nothing here decides what a Writer may write, when the loop dispatches, or what a review
// means: `revisions.ts`, the phrase CONTROLLERS (`controller.ts`), `loop/work.ts` and
// `loop/engine.ts` do, and they all ask THIS module the questions it is allowed to answer
// — "which entries does this phrase have on this book, in what order?", "is this Story
// phrase-managed?", and "is this group locked?".
//
// WHAT CHANGED WHEN PHRASE ② ARRIVED: every read here is now either SCOPED (it names a `phraseId` or
// a phrase kind key — `phraseGroupsOfPhrase`, `storyPhraseByKey`) or it keeps its old, unscoped meaning
// and is documented as "every phrase's rows" (`phraseGroupsOf`) / "the Summary's row" (`storyPhrase`).
// The unscoped forms are the pre-Phrase-② call sites, and they keep behaving identically until the
// loop and api waves migrate them; the scoped forms are what new phrase-aware code must use. The
// phrase-level install and pipeline reads take a phrase id and default to the Story's PRIMARY phrase
// (its lowest-`order` row — the Summary), so their answers cannot silently start including a second
// phrase's entries.
//
// WHY AN ENSURE RATHER THAN A MIGRATION (R6): a Story written before the redesign has no phrase
// rows, and this build does not migrate books on load — a legacy Story keeps its `'sampling'`
// behaviour until the Author asks for the import, and a PURE READ never writes. So rows are created
// by an explicit, idempotent {@link ensurePhraseCatalog} (called by `engine.ts:createStory`, and by
// the group work planner when the flag is on and the rows are missing), and legacy prose is copied
// in by the equally idempotent {@link importLegacySummary} — reached only from an explicit route or
// the create path. Both are safe to call twice: the second call writes nothing.
//
// WHY EVERY WRITER HERE RUNS IN THE CALLER'S COMMIT: P11's audit and D-22's atomicity both want a
// multi-record change to land as one journal entry. An ensure creates up to six rows (one phrase +
// five groups); if it committed itself, a create that then threw would leave a half-built catalog
// journaled as a finished one. Callers wrap it:
// `store.commit('phrase_catalog', () => ensurePhraseCatalog(...))`.
import {
    PHRASE_SUMMARY_KEY,
    autoCreatedPhraseDefinitions,
    composePhraseContent,
    phraseGroupRank,
    phraseGroupRankOf,
    type PhraseDefinition,
    type PhraseGroupDefinition
} from '../../shared/phrase';
import type { GroupRevision, Phrase, PhraseGroup, Story, Summary } from '../../shared/types';
import { newRecordUid, type Attribution, type Store } from '../store';

// ---------------------------------------------------------------------------
// Options and the group-managed predicate
// ---------------------------------------------------------------------------

/** Id factories are injectable everywhere in this package (deterministic tests under R1's UUID rule). */
export type PhraseIdFactory = () => string;

/** Options bag shared by every phrase writer, so one seam makes every created id deterministic. */
export interface PhraseOptions {
    /**
     * Mints the uid that becomes a `phrases.id` / `phrase_groups.id`. Defaults to `newRecordUid()`;
     * a test passes `recordUidAt(n)` (exported from `server/store`) to PIN ids, which is what lets a
     * projection test assert an exact group id instead of `expect.any(String)`.
     */
    newId?: PhraseIdFactory;
}

/** The factory in use — one place resolves the default so no call site re-decides it. */
export const phraseIdFactoryOf = (options: PhraseOptions = {}): PhraseIdFactory => options.newId ?? newRecordUid;

/**
 * The ONE predicate for "is this Story's Summary group-managed?" (R5/R6).
 *
 * It reads the Story's explicit `summary_mode`, NOT the presence of phrase rows, and that order
 * matters: rows can exist while a create is still settling, and a Story deliberately set back to
 * `'sampling'` must stop being group-managed at once instead of being held by its own history.
 * ABSENT means `'sampling'` — the pre-redesign book, whose Summary is still one flat artifact.
 *
 * Every guard in the loop (work generation, settlement, the sampling/plateau machinery, the legacy
 * select and merge routes) asks this function. A second predicate is how the two paths start
 * disagreeing about which one they are on.
 */
export const isGroupManagedStory = (story: Story | undefined): boolean => story?.summary_mode === 'groups';

/**
 * The per-PHRASE dial: "is this Story's NAMED phrase group-managed?" (the general form of
 * {@link isGroupManagedStory}).
 *
 * WHY A PREDICATE PER PHRASE RATHER THAN ONE FOR THE BOOK: the two phrases are separate authoring
 * models with separate dials, exactly as `summary_mode` already was — a Story may run Phrase ① in the
 * group model while Phrase ② stays on the classic `createPlotline` tools, or the reverse. A single
 * book-level flag would force them to move together and make Phrase ② a Summary setting instead of a
 * phrase.
 *
 * ABSENT MEANS THE PRE-PHRASE VALUE, per phrase, and the values are NOT spelled the same on purpose:
 * the Summary's off value is `'sampling'` (the pre-redesign machinery that actually ran) and the
 * Plotlines' off value is `'classic'` (the classic §4.3 + §8.1 tool path). Both are what a book
 * written before the phrase exists reads as, so no migration is needed and a pure read never writes.
 *
 * It reads the STORY SETTING, never the presence of rows, for the reason `isGroupManagedStory` already
 * states: rows can exist while a start step is still settling, and a Story deliberately set back must
 * stop being phrase-managed at once instead of being held by its own history.
 *
 * `isGroupManagedStory` stays the Summary's one predicate for every existing call site; this is the
 * form a phrase-generic caller (a controller, and later the loop's phrase pass) asks.
 */
export const isPhraseGroupManaged = (story: Story | undefined, phraseKey: string): boolean => {
    if (story === undefined) return false;

    // The dial values are per-phrase, so the lookup is data-shaped rather than a shared constant: a
    // third phrase adds its own line here and its own `Story` field, and changes nothing above it.
    if (phraseKey === PHRASE_SUMMARY_KEY) return story.summary_mode === 'groups';

    return story.plotlines_mode === 'groups';
};

// ---------------------------------------------------------------------------
// The group lock predicate (the flag on the row; the operations live in `locks.ts`)
// ---------------------------------------------------------------------------

/**
 * The ONE predicate for "is this group's current text locked?" (`PhraseGroup.locked`).
 *
 * It reads the flag and nothing else: `locked: true` is the lock, absent/`false` is unlocked, so a book
 * written before the field exists needs no migration. It sits HERE rather than in `locks.ts` because
 * every module that has to subtract locked groups from a read — `findings.ts`, `revisions.ts`,
 * `reviewed.ts`, `exclusion.ts` — already imports this one for `phraseGroupsOf`, and a second home for
 * the predicate is how the reads start disagreeing about which groups are writable. `locks.ts` owns the
 * two writes (lock and unlock); this owns the sentence every other read asks.
 */
export const isPhraseGroupLocked = (group: PhraseGroup | undefined): boolean => group?.locked === true;

/**
 * The ids of a Story's locked groups, in one read — the set the work planner, the finding routing and
 * the clean selection all subtract. Computed once per read for the same reason `openIssueGroupIds` is:
 * every caller asks it for all the groups at once, and a per-group call would re-walk the collection.
 */
export function lockedPhraseGroupIds(store: Store, storyId: string): Set<string> {
    return new Set(phraseGroupsOf(store, storyId).filter(isPhraseGroupLocked).map((group) => group.id));
}

// ---------------------------------------------------------------------------
// Reads — every one pure over the store snapshot, ordered deterministically
// ---------------------------------------------------------------------------

/**
 * The group rows of a Story, in CATALOG ORDER (R6's "ordered keys").
 *
 * Sorting by `(order, catalog rank, id)` rather than by insertion order means a freshly hydrated
 * store, a hand-edited book, and a store that just created the rows all render the same Overview
 * order — and the group review's prompt hash depends on that stability (§5's cache argument).
 *
 * WITHOUT `phraseId` this is EVERY phrase's rows: it is the raw read, not a Summary read, and once a
 * Story holds a Plotlines phrase the two phrases' entries interleave by `order` (`chapter_1` and
 * `premise` are both order 1). A caller that means one phrase — which is every pipeline caller —
 * passes `phraseId`, or asks {@link phraseGroupsOfPhrase} where scoping cannot be forgotten. The rank
 * tie-break is resolved inside the phrase when one is named (seam S1), so a chapter set composes in
 * chapter order rather than in an id tie.
 */
export function phraseGroupsOf(store: Store, storyId: string, phraseId?: string): PhraseGroup[] {
    // The phrase key is read ONCE for a scoped call: resolving it per row would make a sort over N
    // rows do N catalog lookups, and the answer is the same for every row of one phrase. A phrase id
    // the book does not have scopes to nothing anyway (the filter drops every row), so the empty
    // namespace below is unreachable in practice and answers the summary rank, which is harmless.
    const scopedKey = phraseId === undefined ? undefined : (store.phrases.get(phraseId)?.key ?? PHRASE_SUMMARY_KEY);

    return store.phraseGroups
        .list()
        .filter((group) => group.story_id === storyId && (phraseId === undefined || group.phrase_id === phraseId))
        .sort(
            (left, right) =>
                left.order - right.order ||
                (scopedKey === undefined
                    ? phraseGroupRank(left.key) - phraseGroupRank(right.key)
                    : phraseGroupRankOf(scopedKey, left.key) - phraseGroupRankOf(scopedKey, right.key)) ||
                left.id.localeCompare(right.id)
        );
}

/** The Story's phrase rows, in catalog order (more than one once a second phrase kind has been started). */
export function storyPhrases(store: Store, storyId: string): Phrase[] {
    return store.phrases
        .list()
        .filter((phrase) => phrase.story_id === storyId)
        .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

/**
 * The Summary Phrase row. `undefined` means the Story is not group-managed yet (a legacy book, or a
 * catalog that has not been ensured), and every caller that reads that as "serve the legacy Summary
 * instead" is what R6 asks for — the read path must never write.
 *
 * IT IS THE SUMMARY's row by key, not "the Story's phrase": with Phrase ② started there are two rows
 * on the book, and this one keeps meaning what it always meant. A phrase-generic caller asks
 * {@link storyPhraseByKey} or {@link primaryPhraseOf} instead.
 */
export function storyPhrase(store: Store, storyId: string): Phrase | undefined {
    return storyPhrases(store, storyId).find((phrase) => phrase.key === PHRASE_SUMMARY_KEY);
}

/**
 * A Story's phrase row BY KIND KEY (seam S5) — the phrase-scoped form of {@link storyPhrase}.
 *
 * The generic name is what lets a controller ask for its own phrase without the loop naming a phrase:
 * `storyPhraseByKey(store, storyId, controller.key)`. `undefined` is the normal "this phrase has not
 * been started on this book" answer, never an error: an un-started phrase is a state the Author can
 * leave a book in.
 */
export function storyPhraseByKey(store: Store, storyId: string, phraseKey: string): Phrase | undefined {
    return storyPhrases(store, storyId).find((phrase) => phrase.key === phraseKey);
}

/**
 * The Story's PRIMARY phrase — its lowest-`order` row, which is the Summary for every book this build
 * can create.
 *
 * WHY THIS EXISTS NEXT TO {@link storyPhrase}: the pre-Phrase-② pipeline callers read "the Story's
 * phrase" without naming a kind, and that read has to keep meaning the Summary even once a Plotlines
 * row exists. Resolving it by `order` rather than by the `'summary'` literal keeps it data-driven (a
 * catalog that ever reorders phrases moves the answer with it) while staying one row, and it lets the
 * phrase-level reads below default to the phrase they always implicitly meant.
 */
export function primaryPhraseOf(store: Store, storyId: string): Phrase | undefined {
    return storyPhrases(store, storyId)[0];
}

/**
 * ONE phrase's group rows, in composition order, with the scoping REQUIRED (seam S5).
 *
 * `phraseGroupsOf`'s third argument is optional, which is how a Summary read and a phrase read look
 * identical at the call site and behave differently the moment a second phrase exists. This is the
 * form a phrase-aware caller is supposed to reach for: the phrase id is not omittable, so a call site
 * cannot silently start reading two phrases.
 */
export function phraseGroupsOfPhrase(store: Store, storyId: string, phraseId: string): PhraseGroup[] {
    return phraseGroupsOf(store, storyId, phraseId);
}

/**
 * The SEED a phrase was written from — the one read that interprets {@link Phrase.seed} (seam S2).
 *
 * PHRASE SCOPING IS WHAT MAKES THE PHRASES DISCRETE: every phrase-level gate (the brief's `seed_hash`,
 * the prompt's SEED block, a re-arm check) hashes THIS text, so Phrase ② keeps its own input after
 * Phrase ① is edited or deleted. A row created before the field exists has no `seed`, and the honest
 * reading of that is the Story's idea — the only text that phrase could have been written from — so a
 * legacy book needs no migration and every existing Summary gate hashes an identical string.
 */
export function phraseSeedOf(phrase: Phrase | undefined, story: Story | undefined): string {
    const seed = phrase?.seed;

    if (typeof seed === 'string') return seed;

    return story?.idea ?? '';
}

/** A group by its uid address — the shape a route parameter, a finding's `group_refs` and a run's carry. */
export function phraseGroupById(store: Store, storyId: string, groupId: string): PhraseGroup | undefined {
    return store.phraseGroups.list().find((group) => group.story_id === storyId && group.id === groupId);
}

/** A group by its catalog key (`premise`, `tone`, …) — the shape the mirror sync and the prompt need. */
export function phraseGroupByKey(store: Store, storyId: string, key: string): PhraseGroup | undefined {
    return store.phraseGroups.list().find((group) => group.story_id === storyId && group.key === key);
}

/**
 * True only when EVERY id names one of this Story's groups (an empty list is FALSE: no group set
 * claims nothing). The validator a route, a tool argument and a structured answer all need — an
 * invented group id is a refusal, never a dangling attribution.
 */
export function phraseGroupsExist(store: Store, storyId: string, groupIds: readonly string[]): boolean {
    if (groupIds.length === 0) return false;

    const owned = new Set(phraseGroupsOf(store, storyId).map((group) => group.id));

    return groupIds.every((id) => owned.has(id));
}

// ---------------------------------------------------------------------------
// The ensure (R1: the catalog exists in the book as records, idempotently)
// ---------------------------------------------------------------------------

/** What one {@link ensurePhraseCatalog} call did — reported so a caller can journal it and a test can pin it. */
export interface PhraseCatalogResult {
    /** The Story's Summary Phrase row (pre-existing or created). */
    phrase: Phrase;
    /** Its groups, in catalog order (pre-existing or created). */
    groups: PhraseGroup[];
    /** Ids created by THIS call, in creation order. Empty = the catalog was already complete. */
    created_group_ids: string[];
    /** True when the phrase row itself was created by this call. */
    created_phrase: boolean;
}

/**
 * A group row's payload from its definition. The phrase id is filled by the caller (see the note there).
 *
 * It works for BOTH phrase kinds because a definition is a definition: the Summary's five static group
 * definitions and the Plotlines phrase's generated `chapter_<n>` definitions produce the same row
 * shape, and the row's `order` is what orders the phrase's composition in each case.
 */
function groupInitOf(
    story: Story,
    group: PhraseGroupDefinition
): Omit<PhraseGroup, 'id' | 'rev' | 'created_at' | 'updated_at'> {
    return {
        story_id: story.id,
        // Filled at the call site with the REAL phrase row id: `ensure` may itself be creating that
        // row, so this is the one field the builder cannot know and the caller must not get wrong.
        phrase_id: '',
        key: group.key,
        title: group.title,
        description: group.description,
        order: group.order,
        // An unwritten group holds no text: `''` + `revision: 0` is the state the loop reads as
        // "never written", i.e. first-draft work (R2 — the first install makes the number 1).
        content: '',
        revision: 0,
        // `null`, not `''`: the projection tells "never written" from "written by an unnamed run".
        updated_by: null
    };
}

/**
 * The SEED a phrase row is created with, from the definition's `seed_source` (seam S2).
 *
 * THE COPY IS THE POINT: the phrase gets its OWN string, so nothing upstream of it — an edit of
 * `stories.idea`, a deleted Phrase ① — can change what this phrase's gates hash later. For
 * `'story_idea'` the content is the same text every existing Summary gate already hashes, so behavior
 * is unchanged; for `'supplied'` the text is handed to the start step rather than read off the Story,
 * and `ensurePhraseCatalog` never sees that phrase at all (it is `starts_on_demand`).
 */
export function phraseSeedInitOf(definition: PhraseDefinition, story: Story, supplied?: string): string {
    return definition.seed_source === 'supplied' ? (supplied ?? '') : story.idea;
}

/**
 * Creates the Story's phrase rows for every definition that starts WITH the Story, leaving existing
 * rows alone (R1, idempotent).
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *   - create an `enabled` phrase that `starts_on_demand` — Phrase ② has no seed until the Author hands
 *     one to it, and a phrase row minted before then would be a phrase over an empty seed that some
 *     gate would later hash as though the Author had written it. Its row comes from its own start step
 *     (`server/phrase/controllers/plotlines.ts:startPlotlinesPhrase`), which is the same "known to the
 *     catalog, created by one explicit step" rule R1 already states for a DISABLED definition;
 *   - import legacy prose — that is {@link importLegacySummary}, because copying the Summary's fields
 *     into group history is a decision the Author makes, not a side effect of the loop wanting
 *     somewhere to write;
 *   - delete a group whose key the catalog has retired — those rows still carry revisions, and
 *     deleting records to match code is how history disappears (D-12a);
 *   - touch the `summaries` row at all, so an ensure on a legacy Story changes nothing a legacy
 *     reader looks at;
 *   - write anything at all in the steady state: the ordered `group_refs` list is rewritten only when
 *     it disagrees with the rows, so a restart's second ensure adds no journal line.
 *
 * Returns `undefined` when the catalog has NO definition that starts with the Story (R1's dial turned
 * off, or every remaining phrase starting on demand): there is then nothing to create and no phrase to
 * hand back, and callers treat that as "no group work" rather than inventing a phrase row the catalog
 * refused.
 */
export function ensurePhraseCatalog(
    store: Store,
    story: Story,
    attribution: Attribution,
    options: PhraseOptions = {}
): PhraseCatalogResult | undefined {
    const definitions = autoCreatedPhraseDefinitions();

    if (definitions.length === 0) return undefined;

    const newId = phraseIdFactoryOf(options);
    const definition = definitions[0];

    let createdPhrase = false;
    let phrase = storyPhrase(store, story.id);

    if (phrase === undefined) {
        phrase = store.phrases.createWithId(
            newId(),
            {
                story_id: story.id,
                key: definition.key,
                title: definition.title,
                description: definition.description,
                // Nothing composed yet: an empty Overview, not a placeholder sentence — a placeholder
                // would be quoted back by a review as though the Author had written it.
                content: '',
                order: definition.order,
                revision: 0,
                group_refs: [],
                // THE COPIED SEED (seam S2). A `story_idea` phrase copies `stories.idea` at creation,
                // which is the same text every existing gate hashes, so nothing downstream moves. A
                // `supplied` phrase is never reached here (see `autoCreatedPhraseDefinitions`).
                seed: phraseSeedInitOf(definition, story)
            },
            attribution
        );
        createdPhrase = true;
    }

    const ownedByKey = new Map(
        phraseGroupsOf(store, story.id, phrase.id).map((group) => [group.key, group] as const)
    );
    const createdGroupIds: string[] = [];
    const groupIds: string[] = [];

    for (const group of definition.groups) {
        const existing = ownedByKey.get(group.key);

        if (existing !== undefined) {
            groupIds.push(existing.id);
            continue;
        }

        const created = store.phraseGroups.createWithId(
            newId(),
            { ...groupInitOf(story, group), phrase_id: phrase.id },
            attribution
        );

        createdGroupIds.push(created.id);
        groupIds.push(created.id);
    }

    // The ordered id list is (re)written only when it disagrees, so the idempotent second call stays
    // silent — a journal full of no-op ensure entries would bury the entries that mean something.
    if (phrase.group_refs.join('|') !== groupIds.join('|')) {
        phrase = store.phrases.update(
            phrase.id,
            { group_refs: groupIds },
            // The caller's `why` is kept and extended, never replaced: P11 wants the reason the
            // caller acted, and this clause says what THIS write was.
            { ...attribution, why: `${attribution.why}; the phrase's ordered group list was behind its rows (R6)` },
            [{ id: phrase.id, rev: phrase.rev }]
        );
    }

    return {
        phrase,
        groups: phraseGroupsOf(store, story.id, phrase.id),
        created_group_ids: createdGroupIds,
        created_phrase: createdPhrase
    };
}

// ---------------------------------------------------------------------------
// The legacy import (R6: a legacy book becomes group-managed by one explicit, idempotent step)
// ---------------------------------------------------------------------------

/** What one {@link importLegacySummary} call did. */
export interface PhraseImportResult {
    /** The catalog as it stands after the import. */
    phrase: Phrase;
    groups: PhraseGroup[];
    /** Revision rows THIS call seeded, in group order. Empty = nothing to import. */
    seeded: Array<{ group_id: string; revision_id: string; number: number; group_key: string }>;
    /** True when this call moved the Story's `summary_mode` to `'groups'`. */
    story_switched: boolean;
}

/** The legacy prose a group inherits (`''` when the legacy field is absent or blank). */
function legacyContentOf(summary: Summary | undefined, key: string): string {
    if (summary === undefined) return '';

    const value = (summary as unknown as Record<string, unknown>)[key];

    return typeof value === 'string' ? value.trim() : '';
}

/**
 * Makes a legacy Story group-managed, seeding each group's revision 1 from the Summary's prose
 * (R6). The only non-create path that flips `summary_mode`.
 *
 * THE HISTORY IT WRITES, stated because tests pin it: a group whose legacy field is NON-empty gets
 * exactly one `group_revisions` row at `number: 1`, `state: 'latest'`, `run_ref: null` — no run
 * wrote it, the Author's existing text is being PRESERVED, not re-authored (P11, D-3b) — and the
 * group row's `content`/`revision` are set to match. A group whose legacy field is EMPTY gets no
 * revision row and stays at `revision: 0`, which the loop reads as first-draft work. So importing a
 * half-written Summary yields a half-written group history, which is the truth about that book.
 *
 * IDEMPOTENT BY SKIPPING, not by overwriting: a group with `revision > 0` is left exactly as it is,
 * so a second press of the button writes nothing and no import can rewrite text a Writer has already
 * revised. That is what makes the route non-destructive and safe to retry after a partial run.
 *
 * THE `summaries` ROW IS NOT TOUCHED. The import's direction is legacy → groups; the mirror's
 * direction (groups → legacy) belongs to the install commit (`revisions.ts`). Writing the Summary
 * here too would risk reformatting Author-owned prose (`chapter_count` and `locked` are Author
 * truth, D-3b/L-7a) to say what is already there.
 */
export function importLegacySummary(
    store: Store,
    story: Story,
    attribution: Attribution,
    options: PhraseOptions = {}
): PhraseImportResult | undefined {
    const ensured = ensurePhraseCatalog(store, story, attribution, options);

    if (ensured === undefined) return undefined;

    const summary = store.summaries.list().find((row) => row.story_id === story.id);
    const seeded: PhraseImportResult['seeded'] = [];

    for (const group of ensured.groups) {
        // Has history already (this import ran before, or a Writer revised it): skip, never rewrite.
        if (group.revision > 0) continue;

        const content = legacyContentOf(summary, group.key);

        if (content === '') continue;

        const revision = store.groupRevisions.create(
            {
                story_id: story.id,
                phrase_id: group.phrase_id,
                group_id: group.id,
                group_key: group.key,
                number: 1,
                content,
                state: 'latest',
                run_ref: null,
                // No job wrote this text, and naming the import here is the audit line that tells an
                // Author which rows came from their own legacy prose rather than from a run (P11).
                work_item_ref: 'phrase_import',
                knowledge_used: []
            },
            attribution
        );

        store.phraseGroups.update(group.id, { content, revision: revision.number }, attribution, [
            { id: group.id, rev: group.rev }
        ]);

        seeded.push({ group_id: group.id, revision_id: revision.id, number: revision.number, group_key: group.key });
    }

    // The Overview is recomposed from whatever the groups now hold — including the groups the import
    // left empty, whose absence the composition shows by simply not heading them.
    const groups = phraseGroupsOf(store, story.id, ensured.phrase.id);
    const phrase =
        seeded.length === 0
            ? ensured.phrase
            : store.phrases.update(
                  ensured.phrase.id,
                  { content: composePhraseContent(groups.map((group) => ({ key: group.key, title: group.title, content: group.content }))), revision: ensured.phrase.revision + 1 },
                  attribution,
                  [{ id: ensured.phrase.id, rev: ensured.phrase.rev }]
              );

    const storySwitched = story.summary_mode !== 'groups';

    if (storySwitched) {
        store.stories.update(
            story.id,
            { summary_mode: 'groups' },
            // The mode is a setting, not prose, and it is journaled under the SAME attribution so the
            // import is one audit line ("the Author moved this Story into the group model") — which is
            // what a later reader needs before trusting the group history beneath it.
            attribution,
            // `story.rev` is the row the caller handed; a caller that re-read the story between calls
            // gets a CAS conflict instead of a lost write, which is the store's normal T-4 contract.
            [{ id: story.id, rev: story.rev }]
        );
    }

    return {
        phrase,
        groups: phraseGroupsOf(store, story.id, phrase.id),
        seeded,
        story_switched: storySwitched
    };
}

// ---------------------------------------------------------------------------
// The composed Overview (R6's phrase-level content)
// ---------------------------------------------------------------------------

/**
 * Composes a Story's Overview from its groups' CURRENT texts, in catalog order.
 *
 * Thin wiring between the rows and the pure rule in `shared/phrase.ts:composePhraseContent` (which
 * owns the exact output format, so the format has one home and one test surface). Exported because
 * `revisions.ts`, the projections and the review prompt all need the SAME text — three renderings
 * that disagree would put a different Overview in front of the Author, the Reviewer and the API.
 */
export function composeGroupContent(store: Store, storyId: string, phraseId: string): string {
    // THE RANK IS RESOLVED INSIDE THE PHRASE (seam S7): a chapter set composes in chapter order and a
    // Summary composes in catalog order, and neither is "the" global order any more. A phrase id the
    // book does not have falls back to the default (Summary) rank, which is what it always did.
    const phraseKey = store.phrases.get(phraseId)?.key;

    return composeGroupContentFrom(
        phraseGroupsOf(store, storyId, phraseId),
        phraseKey === undefined ? undefined : (key: string) => phraseGroupRankOf(phraseKey, key)
    );
}

/**
 * The same composition over rows already in hand — the form `revisions.ts` uses mid-install.
 *
 * `rankOf` is optional and defaults to the Summary's rank, so every existing Summary call site is
 * byte-identical. A caller holding another phrase's rows either passes that phrase's rank or relies on
 * having handed the rows over in composition order already (which is what `phraseGroupsOfPhrase`
 * guarantees), because unknown-key ranks tie and the sort is stable.
 */
export function composeGroupContentFrom(
    groups: readonly PhraseGroup[],
    rankOf?: (key: string) => number
): string {
    return composePhraseContent(
        groups.map((group) => ({ key: group.key, title: group.title, content: group.content })),
        rankOf
    );
}

// ---------------------------------------------------------------------------
// The reviewed composition (D-67): the SAME Overview format, built from SELECTED rows
// ---------------------------------------------------------------------------

/** One piece of a reviewed Overview: the group it belongs to, and the Clean revision chosen for it. */
export interface ReviewedCompositionEntry {
    group: PhraseGroup;
    revision: GroupRevision;
}

/**
 * Composes a reviewed Overview from a set of SELECTED revisions (D-67).
 *
 * THE ONE RULE THAT MAKES THIS ITS OWN FUNCTION: it joins exactly the rows it is handed. It never
 * reads a `latest`, never reads `PhraseGroup.content`, and never falls back to the live text, because
 * a reviewed Overview is a composition of the revisions the review covered — which for a group whose
 * newest text failed review is an ARCHIVED row (the user's Ending example: r5 has the issue, so the
 * reviewed Ending is r4). A helper that quietly preferred the current text would put an unreviewed
 * sentence inside a Summary the Reader is being asked to score.
 *
 * It is the same `composePhraseContent` rule the live Overview uses (§4.19, R6), so the reviewed text
 * and the chosen text are byte-identical once the Author chooses — the choose install writes exactly
 * these texts onto the group rows, and the projection's `overview` and `reviewed.overview` agree.
 */
export function composeReviewedContentFrom(entries: readonly ReviewedCompositionEntry[]): string {
    return composePhraseContent(
        entries.map((entry) => ({ key: entry.group.key, title: entry.group.title, content: entry.revision.content }))
    );
}
