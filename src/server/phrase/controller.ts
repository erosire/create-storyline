// THE PHRASE CONTROLLER — one phrase kind's behaviour, as an object bound to its definition.
//
// WHAT THIS MODULE IS: the "abstract controller" the phrase redesign needs, expressed the way this
// package expresses everything else — NOT a class hierarchy. A controller is a plain object of
// functions, one per enabled catalog entry, and the loop asks it the questions it used to answer by
// naming a phrase. `shared/phrase.ts` says WHICH phrases exist and what they compose from;
// `server/phrase/{catalog,revisions,exclusion,findings,reviewed,locks}.ts` is the SHARED ENGINE every
// phrase runs on (revisions, exclusion, findings, locks, reviewed, scores); a controller is the thin
// layer between them that says what THIS phrase's answer looks like, what its install mirrors, and
// what its prompts have to tell a model.
//
// THE RULE THIS EXISTS TO ENFORCE, stated as the test a reviewer can run: a loop or run change that
// supports a third phrase must not need a new `if (phrase === 'summary')`. It asks the registry
// ({@link phraseController}) and calls the hook. Phrase-name branching that remains lives INSIDE the
// engine's install branch (`revisions.ts`), where the downstream sync is a data-shape fact with a
// compile-time-checked mirror map, and that branch is allowed to name kinds because its whole job is to
// refuse an unmapped one rather than guess.
//
// WHY `Summary` "EXTENDS" THIS: the Summary controller ({@link controllers/summary.ts}) is one instance
// of the same shape. It overrides nothing and inherits nothing — it answers the same eleven questions
// for its own phrase, which is exactly what a subclass would do, without a class.
//
// WHAT IS DELIBERATELY NOT HERE: no prompt COMPILER wiring (the next wave's `run/phase1-prompt.ts`
// reads {@link PhraseController.instructions}); no Work Item generation (the loop's, which will call
// `answer`, `parseDraft`, `install` and `draftClaimRef` instead of spelling the summary's shapes); no
// HTTP surface (api's).

import type { PhraseDefinition } from '../../shared/phrase';
import { enabledPhraseDefinitions } from '../../shared/phrase';
import type { PhraseGroup, Phrase, Story } from '../../shared/types';
import type { Attribution, Store } from '../store';
import type { GroupInstallEntry, GroupInstallOptions, GroupInstallResult } from './revisions';
import type { PlotpointFields } from './plotpoints';
import { plotlinesPhraseController } from './controllers/plotlines';
import { summaryPhraseController } from './controllers/summary';

// ---------------------------------------------------------------------------
// The shape every phrase controller answers
// ---------------------------------------------------------------------------

/** Options a start step takes: the id factory every phrase writer shares, plus the seed to copy. */
export interface PhraseStartOptions {
    /** Pinnable id factory — see `catalog.ts:PhraseOptions.newId`. */
    newId?: () => string;
    /**
     * The text to COPY into the phrase's seed. Required for a `supplied` definition (Phrase ②), ignored
     * by a `story_idea` one (Phrase ①, which copies `stories.idea` itself). The word "copy" is the
     * contract: the phrase stores the string it was handed, so nothing upstream can change it later.
     */
    seedText?: string;
}

/** What a start did. `started` is false when the phrase was already started — a start is idempotent-by-reporting. */
export interface PhraseStartResult {
    /** The phrase row, pre-existing or created by this call. */
    phrase: Phrase;
    /** True when THIS call created the row. */
    started: boolean;
}

/** The structured-output contract a phrase's draft job carries (`WorkItem.responseSchema`). */
export interface PhraseAnswerContract {
    name: string;
    schema: unknown;
}

/** The four engine-owned instruction slots the prompt compiler reads (see {@link PhraseController.instructions}). */
export interface PhraseInstructionSet {
    /** What a valid DRAFT answer looks like for this phrase. */
    draft: string;
    /** What a REVIEW pass of this phrase's composed text owes. */
    review: string;
    /** How a Reader scores this phrase's sections. */
    score: string;
    /** What the Editor may conclude about LOCKING one of this phrase's entries. */
    lock: string;
}

/** One entry of a parsed draft answer, in the phrase's composition order. */
export interface PhraseDraftEntry {
    group: PhraseGroup;
    content: string;
    plotpoints?: PlotpointFields;
}

/** A parsed draft answer: the batch to install, or the reason the whole answer was refused. */
export type PhraseDraftDecision =
    | { ok: true; contents: PhraseDraftEntry[]; knowledgeUsed: string[] }
    | { ok: false; refusal: string };

/**
 * ONE phrase kind's behaviour, as an object of functions over a {@link PhraseDefinition}.
 *
 * THE ELEVEN QUESTIONS, and why each is a hook rather than a branch in the loop:
 *   1. `key`/`definition` — what this controller IS, so a registry lookup and a catalog read agree;
 *   2. `isManaged` — the per-phrase dial (the Story setting, never the presence of rows);
 *   3. `phraseOf`/`groupsOf` — this phrase's rows, scoped so no caller has to remember to scope;
 *   4. `start` — resolve/create the instance with its COPIED seed, on the phrase's own terms
 *      (Phrase ① at story creation, Phrase ② when text is handed to it);
 *   5. `ensureGroups` — materialize the entry set (the static five, or the brief's N chapters);
 *   6. `answer` — the structured contract the draft job carries;
 *   7. `parseDraft` — validate an answer against the JOB, phrase-arity-aware (seam S12);
 *   8. `install` — write the batch through the shared engine, phrase-specific sync included;
 *   9. `draftClaimRef` — the ref its claim family embeds (seam S8), which is what keeps two phrases'
 *      claim keys disjoint on one Story;
 *  10. `composeEntryContent` — how one entry's stored text is rendered from an answer (Summary: the
 *      prose verbatim; Plotlines: the labelled plotpoint block);
 *  11. `instructions` — the engine-owned prompt text for this phrase's passes.
 */
export interface PhraseController {
    /** The `phrases.key` this controller owns. */
    readonly key: string;
    /** The catalog entry it is bound to — the SAME object `shared/phrase.ts` exports. */
    readonly definition: PhraseDefinition;

    /** Is this Story running THIS phrase in the group model? Absent settings read as "no". */
    isManaged(story: Story | undefined): boolean;

    /** This phrase's row on a book, or `undefined` when the phrase has not been started on it. */
    phraseOf(store: Store, storyId: string): Phrase | undefined;

    /** ONE phrase's entry rows, in composition order — the scoped read every pipeline caller wants. */
    groupsOf(store: Store, storyId: string, phraseId: string): PhraseGroup[];

    /** Resolve/create the phrase instance, copying its seed. Idempotent: a second call reports `started: false`. */
    start(store: Store, story: Story, attribution: Attribution, options?: PhraseStartOptions): PhraseStartResult;

    /**
     * Ensure the phrase's entry rows exist, idempotently.
     *
     * `entryCount` is the chapter count for a counted phrase and IGNORED by a static one (whose set is
     * enumerated in the catalog), which is what lets a caller pass the number it has without knowing
     * which policy it is passing it to.
     */
    ensureGroups(
        store: Store,
        story: Story,
        phrase: Phrase,
        entryCount: number,
        attribution: Attribution,
        options?: { newId?: () => string }
    ): PhraseGroup[];

    /** The structured-output contract a draft job over this phrase carries. */
    readonly answer: PhraseAnswerContract;

    /** Validate a draft answer against the entries the JOB named — the phrase's arity, not a constant. */
    parseDraft(
        store: Store,
        story: Story,
        requestedGroupRefs: readonly string[],
        structured: unknown,
        phraseId?: string
    ): PhraseDraftDecision;

    /** Install a parsed batch through the shared engine (revision + archive + compose + sync, one commit). */
    install(
        store: Store,
        story: Story,
        entries: readonly GroupInstallEntry[],
        attribution: Attribution,
        options?: GroupInstallOptions
    ): GroupInstallResult;

    /** One entry's stored text, rendered from the answer (the phrase's own shape — see the hook list). */
    composeEntryContent(group: PhraseGroup, fields: PlotpointFields | undefined, prose?: string): string;

    /**
     * The ref this phrase's draft claim family embeds (seam S8).
     *
     * THE PHRASE OWNS ITS OWN CLAIM IDENTITY, and the two phrases must not collide: Phrase ① keeps
     * contributing the `summaries` row id, exactly as it always did, so every persisted
     * `wi_draft_groups_<summaryRef>_…` key survives this change byte for byte. Phrase ② contributes its
     * own phrase row id, so a chapter batch and a Summary batch on the same book can never claim each
     * other's attempts. `''` means "this phrase has nothing to key on yet", which the loop already
     * treats as "generate no job".
     */
    draftClaimRef(store: Store, story: Story, phrase?: Phrase): string;

    /** The engine-owned prompt text for this phrase's passes (the compiler wiring is the next wave). */
    readonly instructions: PhraseInstructionSet;
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * Every phrase controller, in CATALOG ORDER.
 *
 * ORDER MATTERS, and it is the catalog's order rather than this file's: the drain probe and the
 * projection walk the phrase pipeline in the order the phrases compose, and a registry whose order
 * disagreed with `shared/phrase.ts` would make two readers tell two stories about the same book.
 */
export const PHRASE_CONTROLLERS: readonly PhraseController[] = [summaryPhraseController, plotlinesPhraseController];

/** The controller for a `phrases.key`, or `undefined` for a retired or unknown kind. */
export function phraseController(key: string): PhraseController | undefined {
    return PHRASE_CONTROLLERS.find((controller) => controller.key === key);
}

/**
 * The controllers of the ENABLED catalog entries, in catalog order.
 *
 * THE JOIN IS DELIBERATELY TWO-WAY: an enabled definition with no controller is a kind the catalog
 * advertised and the server cannot run, and this list is where that shows up — the loop iterates THIS
 * and silently skips what the catalog has but the registry does not, instead of inventing a phrase it
 * has no behaviour for.
 */
export function enabledPhraseControllers(): PhraseController[] {
    return enabledPhraseDefinitions()
        .map((definition) => phraseController(definition.key))
        .filter((controller): controller is PhraseController => controller !== undefined);
}

/**
 * The controller of the phrase a ROW belongs to — the form a caller holding a `phraseId` needs, so it
 * never has to know the kind name (the row carries it, and the row is the record of what that phrase
 * was called even if the catalog has since been edited).
 */
export function phraseControllerOf(store: Store, storyId: string, phraseId: string): PhraseController | undefined {
    const phrase = store.phrases.list().find((row) => row.story_id === storyId && row.id === phraseId);

    return phrase === undefined ? undefined : phraseController(phrase.key);
}

/**
 * The controllers of the phrases this Story actually HAS rows for, in composition order.
 *
 * THE READ A PROJECTION OR A DRAIN PROBE WANTS: it is not "which phrases exist" (the catalog answers
 * that) and not "which dials are on" (`isManaged` answers that) — it is which phrases have been started
 * on THIS book, which is the only set that can hold owed work.
 */
export function startedPhraseControllers(store: Store, story: Story): PhraseController[] {
    return store.phrases
        .list()
        .filter((phrase) => phrase.story_id === story.id)
        .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
        .map((phrase) => phraseController(phrase.key))
        .filter((controller): controller is PhraseController => controller !== undefined);
}
