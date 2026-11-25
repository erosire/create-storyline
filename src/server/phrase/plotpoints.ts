// PHRASE ② PLOTLINES — the chapter entry's content, its answer contract, and its downstream sync.
//
// WHY A SEPARATE MODULE FOR ONE PHRASE'S INSTALL PIECES: `revisions.ts` is the ONE install, and an
// install that grew a `if (phrase === …)` arm per phrase would end up owning every phrase's answer
// shape. This module holds the Plotlines-specific pieces — what a chapter entry's stored text looks
// like, how a `ChapterDraft` answer is validated, and what the install mirrors afterwards — and it
// imports NOTHING from `phrase/**` except `catalog.ts` (which never imports back), so the install can
// reach it and the controller can reach it without an import cycle.
//
// THE MIRROR, stated once because it is the whole reason this file exists: for the Summary Phrase the
// downstream sync is §4.2's legacy prose fields (R6). For the Plotlines Phrase the downstream sync is
// §4.3's `plotlines` row — the chapter contract the loop's C-7/C-8 checks and the §8.1 tools already
// read. Both are written in the SAME commit as the group revision that caused them, so no reader can
// ever see a new entry text beside an old contract. It is the same design, applied to the record that
// phrase's entries describe.
import { PHRASE_PLOTLINES_KEY, phraseChapterNumber } from '../../shared/phrase';
import type { ChapterDraft } from '../../shared/schemas';
import type { PhraseGroup, Plotline, Story } from '../../shared/types';
import type { Attribution, Store } from '../store';
import { isPhraseGroupManaged, phraseGroupsOfPhrase, storyPhraseByKey } from './catalog';

// ---------------------------------------------------------------------------
// The plotpoint fields — a chapter entry's answer, and the fields of its contract
// ---------------------------------------------------------------------------

/**
 * One chapter entry's plotpoints, in the field names §4.3's `Plotline` record already uses.
 *
 * `heading` is optional because `Plotline.heading` is optional; the other two required ones are the
 * fields the §8.1 `createPlotline` tool requires (`must_happen`/`must_change`, C-7/C-8). There is no
 * `order` here: the chapter number IS the entry (`chapter_3`), and an answer that also carried an
 * order could contradict the entry it was asked about.
 */
export interface PlotpointFields {
    heading?: string;
    must_happen: string;
    must_change: string;
    pov?: string;
    setups?: string;
    payoffs?: string;
}

/** The labeled lines of a chapter entry's content, in the order they are always written. */
const CHAPTER_CONTENT_LABELS: Array<{ label: string; field: keyof PlotpointFields }> = [
    { label: 'Heading', field: 'heading' },
    { label: 'Must happen', field: 'must_happen' },
    { label: 'Must change', field: 'must_change' },
    { label: 'POV', field: 'pov' },
    { label: 'Setups', field: 'setups' },
    { label: 'Payoffs', field: 'payoffs' }
];

/**
 * The stored `content` of one chapter entry, composed from its plotpoints.
 *
 * THE FORMAT, stated so a test can assert it byte for byte: one `Label: value` line per field, in the
 * fixed order above, blank lines omitted, joined with a single newline and no trailing newline. The
 * two required fields always appear; an optional field the Writer left blank is ABSENT rather than
 * rendered as `Setups:`, because a blank label in a contract block reads like a promise the chapter
 * makes and pays with nothing.
 *
 * WHY THERE IS NO `## Chapter N` HEADING IN HERE: `composePhraseContent` already puts one in front of
 * every entry when it composes the phrase's whole text (the entry's `title` is `Chapter N`), and a
 * heading in the content too would print the chapter number twice in the Overview the Author reads.
 *
 * THE SAME TEXT IS DERIVED, never stored twice: `syncPlotlineContract` writes the FIELDS onto the
 * `plotlines` row while the install writes THIS text onto the group row, from the same values, in the
 * same commit — the readable block is what a review quotes, the fields are what the loop checks.
 */
export function chapterEntryContent(group: PhraseGroup, fields: PlotpointFields): string {
    return CHAPTER_CONTENT_LABELS.map(({ label, field }) => {
        const value = fields[field];

        return typeof value === 'string' && value.trim() !== '' ? `${label}: ${value.trim()}` : '';
    })
        .filter((line) => line !== '')
        .join('\n');
}

// ---------------------------------------------------------------------------
// The ChapterDraft answer, validated against the JOB (phrase-arity aware — seam S12)
// ---------------------------------------------------------------------------

/** A chapter batch that passed every check: the entries to install, in the phrase's composition order. */
export interface ChapterDraftDecision {
    ok: true;
    /** `{group, content, plotpoints}` per answered entry, ordered by the phrase's own composition order. */
    contents: Array<{ group: PhraseGroup; content: string; plotpoints: PlotpointFields }>;
    knowledgeUsed: string[];
}

/** A chapter batch refused before any row moved. */
export interface ChapterDraftRefusal {
    ok: false;
    refusal: string;
}

/**
 * Validates a `ChapterDraft` answer against the CHAPTER SET the job named (R2's atomicity rule, applied
 * to Phrase ②).
 *
 * It is the same five-check shape as `revisions.ts:parseGroupDraftAnswer`, in the same order, and for
 * the same reason: a batch that answers a chapter it was not asked for, skips one it was, or answers
 * one twice installs a PARTIAL book, and R2's rule about that is to refuse the whole thing before the
 * first write. The checks that differ are phrase-specific and are the point of this function:
 *
 *   - every entry must belong to THIS PHRASE (`phraseGroupsOfPhrase`), so a Summary group id answered
 *     inside a chapter batch is a refusal rather than an install onto the wrong phrase; and
 *   - the two required plotpoints must be non-blank, because a contract with no `must_happen` is not a
 *     contract — it is a chapter title, and the loop's C-7 check would have nothing to read.
 *
 * `requestedGroupRefs` is the phrase's arity, exactly as it is for the Summary: five for Phrase ① and
 * the materialized chapter count for Phrase ②, so the arity lives in the job rather than in a constant
 * (the in-process schema validator ignores `minItems`, so this parse layer is where the number lives).
 */
export function parseChapterDraftAnswer(
    store: Store,
    storyId: string,
    phraseId: string,
    requestedGroupRefs: readonly string[],
    structured: unknown
): ChapterDraftDecision | ChapterDraftRefusal {
    const answer = structured as ChapterDraft | undefined;
    const rows = Array.isArray(answer?.groups) ? answer.groups : undefined;

    if (rows === undefined || rows.length === 0) {
        return { ok: false, refusal: 'the ChapterDraft answer carried no `groups` entries' };
    }

    // The PHRASE's entries, in composition order — not every group of the book (seam S5).
    const groups = phraseGroupsOfPhrase(store, storyId, phraseId);
    const byId = new Map(groups.map((group) => [group.id, group] as const));
    const requested = new Set(requestedGroupRefs);
    const seen = new Map<string, { group: PhraseGroup; content: string; plotpoints: PlotpointFields }>();

    for (const entry of rows) {
        const groupId = typeof entry.group_ref === 'string' ? entry.group_ref.trim() : '';

        if (groupId === '') {
            return { ok: false, refusal: 'a `groups` entry named no group' };
        }

        if (!byId.has(groupId)) {
            return {
                ok: false,
                refusal: `\`${groupId}\` is not one of this phrase's chapter entries — a chapter draft answers for the chapter ids the job named, never for a key, a Summary group, or an invented id`
            };
        }

        if (!requested.has(groupId)) {
            return {
                ok: false,
                refusal: `${groupId} was not one of the chapters this job asked for — writing a chapter nobody requested revises an untouched one (R2)`
            };
        }

        if (seen.has(groupId)) {
            return { ok: false, refusal: `${groupId} was answered twice in one answer — two contracts for one chapter is an ambiguous batch` };
        }

        const group = byId.get(groupId)!;

        // The chapter NUMBER has to be readable off the entry key for the `plotlines` mirror to know
        // which contract it is writing. A row the catalog did not mint (`chapter_x`) cannot be mirrored,
        // so it is refused here rather than silently writing a contract at order 0.
        if (phraseChapterNumber(group.key) === 0) {
            return {
                ok: false,
                refusal: `${group.key} is not a chapter entry key, so its install could not say which chapter's contract it writes`
            };
        }

        const plotpoints: PlotpointFields = {
            must_happen: typeof entry.must_happen === 'string' ? entry.must_happen.trim() : '',
            must_change: typeof entry.must_change === 'string' ? entry.must_change.trim() : '',
            ...(typeof entry.heading === 'string' && entry.heading.trim() !== '' ? { heading: entry.heading.trim() } : {}),
            ...(typeof entry.pov === 'string' && entry.pov.trim() !== '' ? { pov: entry.pov.trim() } : {}),
            ...(typeof entry.setups === 'string' && entry.setups.trim() !== '' ? { setups: entry.setups.trim() } : {}),
            ...(typeof entry.payoffs === 'string' && entry.payoffs.trim() !== '' ? { payoffs: entry.payoffs.trim() } : {})
        };

        // The two required plotpoints. Checked per entry, in the loop, so the refusal names the chapter
        // whose answer was thin rather than making the model hunt for it.
        if (plotpoints.must_happen === '' || plotpoints.must_change === '') {
            return {
                ok: false,
                refusal: `${group.key} answered no ${plotpoints.must_happen === '' ? 'must_happen' : 'must_change'} — a chapter contract has to say what happens and what is different afterwards, and an entry that says neither is a chapter title, not a contract`
            };
        }

        seen.set(groupId, { group, content: chapterEntryContent(group, plotpoints), plotpoints });
    }

    const missing = requestedGroupRefs.filter((id) => !seen.has(id));

    if (missing.length > 0) {
        const titles = missing.map((id) => byId.get(id)?.key ?? id);

        return {
            ok: false,
            refusal: `the answer left ${titles.join(', ')} uncontracted — a batch that skips a chapter it was asked for installs nothing (R2)`
        };
    }

    return {
        ok: true,
        // The PHRASE's order, from the book's rows, not the answer's order — the same rule
        // `parseGroupDraftAnswer` follows, so two identical answers journal identical rows.
        contents: groups.filter((group) => seen.has(group.id)).map((group) => seen.get(group.id)!),
        knowledgeUsed: Array.isArray(answer?.knowledge_used)
            ? answer.knowledge_used.filter((id) => typeof id === 'string')
            : []
    };
}

// ---------------------------------------------------------------------------
// The downstream sync: the chapter entry's contract, mirrored onto its `plotlines` row
// ---------------------------------------------------------------------------

/**
 * Creates or updates the `plotlines` row of one chapter entry (create-or-update-BY-ORDER).
 *
 * WHY UPDATE AND NOT INSERT: P4's rule — "one chapter carries one contract" — is what the §8.1
 * `createPlotline` tool enforces by REFUSING a duplicate order. A redraft of chapter 3 is therefore
 * not a second contract for chapter 3; it is chapter 3's contract being rewritten, and the join is the
 * chapter number read off the entry key. Looking the row up by anything else (id, insertion order)
 * would put a second contract on a chapter the moment a Writer redrafted out of order.
 *
 * EVERY FIELD IS WRITTEN, blank included, on BOTH paths. A chapter draft answer is a complete statement
 * of that chapter's contract, so a plotpoint the Writer left out this pass is one the chapter no longer
 * carries — keeping the previous value would put a payoff in the contract that the installed text does
 * not claim, and C-5/C-6 check these mechanically. (`createPlotline` writes `''` for absent optionals
 * for the same reason; this is that behaviour, on the update path too.)
 *
 * THE THREE ENGINE-OWNED FLAGS are exactly `createPlotline`'s on a CREATE — `contract_locked` mirrors
 * `stories.plotlines_locked` (L-7), and a fresh contract starts `aligned: false` / `needs_recheck:
 * false` because nothing has judged it yet (D-1). On an UPDATE they are left ALONE: the lock is the
 * Author's, `aligned` is the last verdict's, and `needs_recheck` belongs to invalidation (L-11) — none
 * of them is a fact a Writer's prose install may overwrite.
 */
export function syncPlotlineContract(
    store: Store,
    story: Story,
    group: PhraseGroup,
    fields: PlotpointFields,
    attribution: Attribution
): { row: Plotline; created: boolean } {
    const order = phraseChapterNumber(group.key);

    if (order === 0) {
        throw new Error(
            `syncPlotlineContract: ${group.key} is not a chapter entry key — the plotlines mirror writes the contract of the chapter the key names`
        );
    }

    const text = (value: string | undefined): string => (typeof value === 'string' ? value.trim() : '');
    const patch = {
        heading: text(fields.heading),
        must_happen: text(fields.must_happen),
        must_change: text(fields.must_change),
        pov: text(fields.pov),
        setups: text(fields.setups),
        payoffs: text(fields.payoffs)
    };

    const existing = store.plotlines.list().find((row) => row.story_id === story.id && row.order === order);

    if (existing !== undefined) {
        return {
            row: store.plotlines.update(existing.id, patch, attribution, [{ id: existing.id, rev: existing.rev }]),
            created: false
        };
    }

    return {
        row: store.plotlines.create(
            {
                story_id: story.id,
                order,
                ...patch,
                contract_locked: story.plotlines_locked,
                aligned: false,
                needs_recheck: false
            },
            attribution
        ),
        created: true
    };
}

/**
 * T-W2b — THE CHAPTER ENTRIES of the Plotlines phrase, in the phrase's composition order. `[]` when the
 * phrase is not started, which is the same answer `ensureChapterGroups` has not yet produced. Every
 * reader that has to name an entry (the reporter's refusal message, the finding route below) reads this
 * rather than rebuilding the lookup.
 */
export function plotlineChapterGroups(store: Store, storyId: string): PhraseGroup[] {
    const phrase = storyPhraseByKey(store, storyId, PHRASE_PLOTLINES_KEY);

    return phrase === undefined ? [] : phraseGroupsOfPhrase(store, storyId, phrase.id);
}

/**
 * T-W2b — THE INVERSE LOOKUP: the chapter GROUP that owns a chapter's contract, by `order`.
 *
 * `syncPlotlineContract` above maps a GROUP to a ROW by `order`; this maps the same `order` back to
 * its GROUP, and it exists because the hybrid's READING legs still file findings against `plotlines`
 * rows while the WRITING surface has moved to the chapter ENTRIES. A finding has to name the group its
 * fix will actually be written into (`tools/reader.ts:raiseFinding`), or R3 closure and the batch
 * planner have nothing to join on: `phrase/exclusion.ts:groupWorkTargets` arms a group from
 * `findingGroupsStillOwed`, and the install that closes the finding is a GROUP revision.
 *
 * `undefined` is the honest answer in two cases, and the caller refuses rather than guessing:
 *   * the book has no started Plotlines phrase (no seed was pushed, so no entries were materialized);
 *   * the entry set does not cover that order — a contract outside the chapter count, which is the
 *     lane's one-gap rule, not a Writer's judgement.
 */
export function plotlineChapterGroupOf(store: Store, storyId: string, order: number): PhraseGroup | undefined {
    return plotlineChapterGroups(store, storyId).find((group) => phraseChapterNumber(group.key) === order);
}

/**
 * T-W2b — THE ONE PREDICATE for "do chapter entries own the contract text on this book?".
 *
 * It is `isPhraseGroupManaged(story, PHRASE_PLOTLINES_KEY)` with the phrase key already applied, and
 * it sits HERE (next to the sync it guards) so the loop, `tools/reader.ts` and `tools/writer.ts` cannot
 * drift on how the dial is read. The spec's rule holds: this keys on the PER-PHRASE mode, never on
 * `story.phase` — a grouped book in phase ③ is still group-managed.
 *
 * IT IS NOT ENOUGH TO ACT ON ALONE. `loop/engine.ts:2887` defaults `plotlines_mode` to `'groups'`, so
 * the dial reads `groups` on every book whose Author never pushed a Summary into Phrase ② — and the
 * §4.3 tools, the classic `write_unit` pair, and the classic meaning of an unscoped finding must stay
 * exactly where they were for that book. {@link plotlineLaneIsLive} is the gate those three read.
 */
export const isPlotlinePhraseGroupManaged = (story: Story | undefined): boolean =>
    isPhraseGroupManaged(story, PHRASE_PLOTLINES_KEY);

/**
 * T-W2b — IS THE LANE THE WRITING SURFACE FOR CONTRACTS ON THIS BOOK, RIGHT NOW?
 *
 * The dial PLUS A STARTED PHRASE ② ROW. Starting the phrase is the Author's decision that chapter groups
 * will carry this book's contracts (`phrase/controllers/plotlines.ts:startPlotlinesPhrase` copies the
 * seed; the structure gate then accepts the brief and materializes the entries the install writes), so
 * from that moment on a `write_unit` pass over a contract is out-of-band work, whether or not the entries
 * exist yet — a brief that has not been accepted has NO contracts, which is not a licence for the classic
 * Writer to draft them out of band and have the install overwrite them.
 *
 * THE DIAL ALONE IS NOT ENOUGH, and this is the whole reason the function exists: `loop/engine.ts:2887`
 * spawns every session with `plotlines_mode: 'groups'`, so the dial reads `groups` on every book whose
 * Author never pushed a Summary into Phrase ②. Those books — which is every book written before this
 * phrase existed, and every classic pin in the suite — keep the §8.1 tools, the classic `write_unit` pair,
 * and the classic reading of a finding that names no group. Measured cost of a dial-only gate: 18 failures
 * across `loop/{findings,drain,trend,slice,verbs}.test.ts` and `integration/slice-{phases,chapters,ops}`
 * (`Temp/w2b/focused-08.txt`), all of them green with the clause inert (`Temp/w2b/probe-findings-off.txt`).
 */
export function plotlineLaneIsLive(store: Store, story: Story | undefined): boolean {
    if (story === undefined || !isPlotlinePhraseGroupManaged(story)) return false;

    return storyPhraseByKey(store, story.id, PHRASE_PLOTLINES_KEY) !== undefined;
}
