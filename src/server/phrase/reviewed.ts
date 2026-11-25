// SUMMARY PHRASE — the Clean stamp, the reviewed Overview, and the Author's choose (D-67, D-68).
//
// WHAT THIS MODULE IS: the seam between "the loop has written texts" and "the Author has a Summary
// they can pick". The pipeline produces revisions; a cross-group Critic pass reads a combination of
// them and either finds a defect or does not; this module records the second case as a fact on the
// row (the Clean stamp), reads those facts back as ONE selection per group (the reviewed Overview),
// and finally performs the Author's decision (the choose). Three rules, one file, because they are
// the same rule seen from three sides:
//
//   1. **Clean is a verdict about a PASS, recorded on the row it judged.** A deep-review pass over
//      vector V leaves group G's revision in V clean when the pass closed with no unresolved defect
//      on G. It is written once and never revoked by a later event — the finding a pass filed can be
//      discarded a week later, and D-67 refuses to let a discarded finding retroactively certify the
//      text that produced it.
//   2. **The selection is a READ, so revocation is free.** `cleanSelectionOf` asks, per group, "what
//      is the newest revision of this group that earned a clean pass AND whose group carries no
//      unresolved defect right now?" Because the open-issue half is re-checked on every read, a
//      finding raised after the fact invalidates a selection with no bookkeeping (L-3: the rows are
//      the state), and a group whose newest text has an open defect falls back to its EARLIER clean
//      revision — the user's Ending example (r1 issue, r2 clean, r3 issue, r4 clean, r5 issue → pick
//      r4 "because Revision 5 has issue") is what the rule gives, not a special case.
//   3. **The reviewed Overview exists only when ALL FIVE groups have a selection.** Half a reviewed
//      Summary is not a Summary the Reader may be asked to score, and it is certainly not one the
//      Author may choose, so `complete` is the gate everything downstream hangs on.
//
// WHY THE CHOOSE INSTALLS NEW ROWS INSTEAD OF ADOPTING THE SELECTED ONES IN PLACE: a group's line is
// specced as "created in order, one per accepted text, the HIGHEST number is `latest`" (§4.19, R2).
// Adopting r4 in place while a discarded r5 sits above it breaks both halves of that sentence at
// once, and the next install would mint number 5 a second time (`installGroupRevisions` numbers from
// the GROUP row, R2's per-group line). So the choose is an install like any other — each group gets
// its next `latest` holding the chosen text, and the numbers of the discarded rows are never reused.
// The selected rows themselves become `discarded`: retained (R3's closure join still walks them, so a
// `fixed` finding stays fixed after the choose — pinned by `phrase/reviewed.test.ts`), hidden from
// every current read, and never selected again.
//
// WHAT THIS MODULE NEVER DOES: it never touches `lockPhase` (choosing is not locking, §17.17), never
// reads or writes a score (D-65's boundary — the score reads THIS module's selection, never the
// reverse), never writes a group row outside the install path, and never writes through a GROUP LOCK
// (`phrase/locks.ts`): a locked group's current row is selected and retained, so the choose confirms
// that text instead of minting another revision of it.
import type { GroupRevision, Phrase, PhraseGroup, Story } from '../../shared/types';
import { nowIso } from '../tools/utilities';
// D-33c's ONE open-defect predicate PAIR. `loop/records.ts` says, in its own header, that the day a
// "clean revision" step arrives it wants exactly this question — this is that step, so it reads those
// two functions instead of inventing a fourth open set or a second copy of the same filter.
// (Acyclic: `records.ts` imports nothing from `phrase/**`; `phrase/exclusion.ts` already reaches
// across for the run reads, and D-65's scoring read already lives on this side of that seam.)
import { openIssueFindings } from '../loop/records';
import type { Attribution, Store } from '../store';
import {
    composeReviewedContentFrom,
    isPhraseGroupLocked,
    lockedPhraseGroupIds,
    phraseGroupsOf,
    storyPhrase,
    type ReviewedCompositionEntry
} from './catalog';
import { findingGroupScope } from './findings';
import { groupCheckVectorHashOf } from './exclusion';
import {
    groupRevisionHistory,
    groupRevisionVector,
    groupVectorHash,
    installGroupRevisions,
    latestGroupRevision,
    type GroupInstallResult
} from './revisions';

// ---------------------------------------------------------------------------
// The open-defect read — which groups a selection may NOT name right now
// ---------------------------------------------------------------------------

/**
 * The groups that currently carry an unresolved DEFECT (D-67's second half of the selection rule).
 *
 * ISSUE-ONLY, deliberately: `kind: 'proposal'` is an improvement the Seed never promised (D-33b), and
 * a book is not unchosen because somebody suggested a word change. The state set is D-33c's
 * `isOpenIssueFinding` — only `fixed` and `discarded` close an issue, so `unconfirmed`, `confirmed`,
 * `approved` and `disputed` all still hold the group open — and the scope is R3's
 * `findingGroupScope`, which means an UNSCOPED finding (no `group_refs`, the legacy whole-Overview
 * reading) scopes to ALL FIVE groups and therefore blocks clean for all five.
 *
 * Computed once per read and returned as a set because every caller asks it for all five groups at
 * once: the stamping pass, the selection read and the projection.
 *
 * A LOCKED GROUP IS NEVER IN THE SET (R-LOCK). The predicate is "this text may not be certified because
 * the book still holds a defect against it", and a locked group has no certification to withhold: no
 * Writer can replace its row, so holding it blocked would make the reviewed Overview permanently
 * incomplete over text the Author declared final, and the choose could never run. The defect itself is
 * untouched — `api/projections.ts` still lists it against the group — and a finding that also names an
 * unlocked group keeps blocking THAT group, which is the half the loop can still repair.
 */
export function openIssueGroupIds(store: Store, story: Story): Set<string> {
    const blocked = new Set<string>();
    const locked = lockedPhraseGroupIds(store, story.id);

    // D-33c's own open-issue read (`loop/records.ts:openIssueFindings`), not a second copy of it: the
    // day the open set changes for the crew's gates, it changes for the Clean verdict in the same commit.
    for (const finding of openIssueFindings(store, story.id)) {
        for (const groupId of findingGroupScope(store, story, finding).refs) {
            if (!locked.has(groupId)) blocked.add(groupId);
        }
    }

    return blocked;
}

/** A group that has no clean revision to select, and WHY — the author-facing reason the rail shows. */
export interface ReviewedGap {
    group_id: string;
    group_key: string;
    /** `unwritten`: the group has no revision at all. `no_clean_revision`: every row failed its pass. */
    reason: 'unwritten' | 'no_clean_revision';
    /** The group's newest revision number, 0 when it has none — so the rail can name the text that failed. */
    latest: number;
    /** True when an unresolved issue names this group, which is what makes even a stamped row unusable. */
    issues_open: boolean;
}

/** One selected piece: a group row and the Clean revision the reviewed Overview is built from. */
export type { ReviewedCompositionEntry } from './catalog';

/** The reviewed Overview's selection: the chosen revision per group, and whether that is ALL groups. */
export interface ReviewedSelection {
    /** Catalog order, and only ever the groups that HAVE a selection. */
    entries: ReviewedCompositionEntry[];
    /** `{groupId: revisionNumber}` for those entries — the full vector when `complete` is true. */
    vector: Record<string, number>;
    /** `groupVectorHash(vector)`: the identity the Reader's scores are keyed by (D-65, §17.5). */
    vector_hash: string;
    /** True only when EVERY group of this Story's phrase has one — the reviewed Summary exists. */
    complete: boolean;
    /** The groups that have none, catalog order, each with its reason. */
    gaps: ReviewedGap[];
}

/**
 * The selection the reviewed Overview is made of, RIGHT NOW (D-67).
 *
 * THE RULE, per group, in the order the checks run:
 *   1. the group currently carries an unresolved issue → NOTHING is selectable for it, newest stamped
 *      row or not — a clean verdict predates the finding, and a selection may not walk past a defect
 *      the book still holds;
 *   2. otherwise take the NEWEST revision that carries the Clean stamp (D-67) and is not `discarded`.
 *      "Newest" means by NUMBER, not by `state`: the newest clean revision of a group whose latest text
 *      failed review is an ARCHIVED row, and that is exactly the point — the Ending example picks r4
 *      while r5 is the current, defect-carrying text.
 *
 * WHY THERE IS NO REVOCATION MACHINERY: revocation would need a place to remember which selections a
 * finding invalidated, and it would be wrong after a restart the moment the rows moved. Reading the
 * open-issue set fresh (step 1) means the invalidation is the same pure read on every machine and after
 * every restart, with nothing to reconcile — and it means the fall-back to the earlier clean revision
 * needs no code either, because "newest clean row that is not currently blocked" IS the fall-back.
 *
 * A LOCKED GROUP SELECTS ITS OWN CURRENT ROW (R-LOCK), and that is step 2 with one branch, not a new
 * rule. The Clean stamp is the answer to "which of this group's competing texts did the Critic read
 * without objecting?" — a question a locked group stops asking, because the lock removed every
 * competitor it could ever have: its current row is the only text the group will ever contribute.
 * Selecting it is therefore the same fact the stamp records, stated without waiting for a verdict that
 * cannot change anything, and it is what lets the reviewed Overview COMPOSE over locked text (D-68's
 * `complete` gate would otherwise never close and the Reader would never be armed on a book with one
 * locked group). It is also the consistency baseline the choose installs the OTHER groups against — the
 * locked sentence is in the Overview the Writer was answering, so it stays in the Overview the Author
 * picks. Its `vector` entry is the group's current revision, which is the number
 * `groupRevisionVector` already prints, so a locked book's reviewed hash and its live hash agree.
 *
 * `vector_hash` of a PARTIAL selection is still a hash, but it is not a scoring key: only a
 * `complete` selection names an Overview, and the scoring seat checks `complete` first.
 */
export function cleanSelectionOf(store: Store, story: Story): ReviewedSelection {
    const groups = phraseGroupsOf(store, story.id);
    const blocked = openIssueGroupIds(store, story);
    const entries: ReviewedCompositionEntry[] = [];
    const gaps: ReviewedGap[] = [];

    for (const group of groups) {
        const history = groupRevisionHistory(store, group.id);
        const issuesOpen = blocked.has(group.id);
        // The locked branch reads the CURRENT row (`state: 'latest'` at the group's own number), never
        // "newest row of any state": a live lock always names the group's current revision
        // (`phrase/locks.ts` writes `locked_revision: group.revision`, and an install cannot move the
        // number under a lock), so the row that matches `group.revision` IS the text the freeze signed
        // off, and picking any other would put text nobody installed in the Overview. The exact-number
        // check is DEFENSIVE, not a lifecycle state: every flow that takes a group's revision backing
        // away clears the flag with it (`engine.ts:editSeed`'s reset, and
        // `invalidation.ts:scrapPhasesAfter` when its scrap deletes the `group_revisions` rows the lock
        // names — D-69), and `unlockPhraseGroup` takes the flag off on its own, so a locked row with no
        // matching `latest` row is a legacy or hand-repaired row. It falls through to the gap below
        // (`unwritten` when the group has no rows at all, `no_clean_revision` otherwise) rather than
        // freezing a text the book no longer holds.
        const picked = isPhraseGroupLocked(group)
            ? history.find((revision) => revision.state === 'latest' && revision.number === group.revision)
            : issuesOpen
              ? undefined
              : history.find((revision) => revision.clean === true && revision.state !== 'discarded');

        if (picked === undefined) {
            gaps.push({
                group_id: group.id,
                group_key: group.key,
                reason: history.length === 0 ? 'unwritten' : 'no_clean_revision',
                latest: history[0]?.number ?? 0,
                issues_open: issuesOpen
            });
            continue;
        }

        entries.push({ group, revision: picked });
    }

    const vector: Record<string, number> = {};

    for (const entry of entries) vector[entry.group.id] = entry.revision.number;

    return {
        entries,
        vector,
        vector_hash: groupVectorHash(vector),
        complete: groups.length > 0 && entries.length === groups.length,
        gaps
    };
}

/**
 * The selection the AUTHOR chose, read back off the Phrase row (D-68).
 *
 * `undefined` means the Author has never chosen, or the chosen history no longer exists — a Seed reset
 * or a scrap deletes the group revision rows (`loop/invalidation.ts:scrapPhasesAfter`), and a reset
 * Summary re-grows numbers from 1, so the persisted `{groupId: number}` could otherwise point at a
 * brand-new text and be reported as the Author's pick. Requiring the named row to still EXIST and to
 * still carry its Clean stamp is what makes that read honest without touching the invalidation code.
 *
 * The rows it names are `discarded` (the choose discarded them), which is why this read does not go
 * through `cleanSelectionOf`: the selection read answers "what would I review NOW", this one answers
 * "what did the Author pick THEN".
 */
export function chosenSelectionOf(store: Store, story: Story): ReviewedSelection | undefined {
    const phrase = storyPhrase(store, story.id);
    const vector = phrase?.reviewed_vector;

    if (phrase === undefined || vector === undefined || Object.keys(vector).length === 0) return undefined;

    const groups = phraseGroupsOf(store, story.id);
    const entries: ReviewedCompositionEntry[] = [];

    for (const group of groups) {
        const number = vector[group.id];

        if (number === undefined) return undefined;

        // THE TEST THAT THE NAMED ROW STILL MEANS WHAT THE CHOICE SAID IT MEANT. For an unlocked group
        // that test is the Clean stamp (D-68): the row earned a verdict, and a row a scrap deleted or a
        // reset re-grew to the same number and never earned one must not be reported as the Author's
        // pick. A LOCKED group's entry was never required to carry a stamp — the choose selected its
        // fixed current text, which is a different kind of fact (see `cleanSelectionOf`) — so the
        // equivalent evidence is the lock's own record: the number `locked_revision` fixed. A Seed reset
        // deletes the history and re-grows the numbers from 1 while that field keeps naming the row that
        // went, and the same false pick this guard prevents for a clean row is prevented here.
        const locked = isPhraseGroupLocked(group);
        const picked = store.groupRevisions
            .list()
            .find(
                (revision) =>
                    revision.group_id === group.id &&
                    revision.number === number &&
                    (locked ? group.locked_revision === number : revision.clean === true)
            );

        // A group the vector does not name, or a row the scrap deleted, or a re-grown row that never
        // earned a pass: the persisted choice no longer describes this book.
        if (picked === undefined) return undefined;

        entries.push({ group, revision: picked });
    }

    const chosenVector: Record<string, number> = {};

    for (const entry of entries) chosenVector[entry.group.id] = entry.revision.number;

    return {
        entries,
        vector: chosenVector,
        // Recomputed with the SAME function the choose wrote with, so a hand-edited snapshot cannot
        // desync the score join from the text the scores describe.
        vector_hash: groupVectorHash(chosenVector),
        complete: entries.length === groups.length && groups.length > 0,
        gaps: []
    };
}

/** The reviewed Overview's text: the five selected pieces, composed exactly as the live one is. */
export function composeReviewedOverview(selection: ReviewedSelection): string {
    return composeReviewedContentFrom(selection.entries);
}

// ---------------------------------------------------------------------------
// The Clean stamp (D-67)
// ---------------------------------------------------------------------------

/** What one stamping pass did — every field is something a settlement journals and a test pins. */
export interface CleanStampResult {
    /** The rows THIS call stamped (empty for a pass that earned nothing). */
    stamped: GroupRevision[];
    /** Every group it passed over, with the reason — so the rail can say WHY a vector is not clean. */
    skipped: Array<{ group_id: string; group_key: string; reason: string }>;
    /** The vector hash the seat was keyed by; `''` when the claim key named none. */
    vector_hash: string;
}

/**
 * Stamps the vector a finished cross-group Critic pass reviewed (D-67).
 *
 * CALLED FROM ONE PLACE: `loop/engine.ts:settleJob`, in the same commit that closes a `check_unit`
 * run whose claim key is the group deep-review family (`wi_group_check_<vectorHash>_<pass>`). That
 * seat is the findings-producing pass of the standard pipeline — it is the one group-model review that
 * carries tools and files real `Finding` rows through `tools/reader.ts:raiseFinding` — so its closing
 * is the moment "this Critic read this combination and found nothing on this group" becomes a fact.
 * The structured `review_groups` seat is deliberately NOT a stamper: its answer is a review ROW of
 * notes, it opens no finding, and treating the absence of a note as a clean verdict would certify text
 * nothing ever tried to break (D-33's ladder makes a review finding, not a review answer, the thing
 * the loop works on).
 *
 * THE TWO CONDITIONS, and why only one is checked:
 *   (a) the pass filed no `kind: 'issue'` finding scoping to G, and
 *   (b) no unresolved issue scopes to G when the pass closes.
 * At the instant this runs, (b) IMPLIES (a): a row `raiseFinding` writes starts `unconfirmed`
 * (D-33), so anything the pass filed is still unresolved when its own settle runs, and (b) also covers
 * the older defect that (a) would miss — a finding from an earlier pass that is still open on that
 * group. So the open-issue read answers both, and it answers them with the same predicate the crew's
 * own gates use (`records.ts:isOpenIssueFinding`).
 *
 * WHY THE VECTOR HAS TO STILL BE THE CURRENT ONE: the verdict is about the combination the seat was
 * claimed against, and the claim key carries only its HASH. If a Writer install moved the vector while
 * the pass ran, the rows the pass read are gone from the current line, and stamping the rows that
 * replaced them would credit a clean read that never happened. Nothing is stamped in that case; the
 * new vector simply owes its own pass.
 *
 * IDEMPOTENT: a row already stamped is skipped rather than rewritten, so a replayed settle adds no
 * journal line and no second `clean_run_ref`.
 */
export function stampCleanRevisions(
    store: Store,
    story: Story,
    options: { seatKey: string; runRef: string },
    attribution: Attribution
): CleanStampResult {
    const vectorHash = groupCheckVectorHashOf(options.seatKey);

    if (vectorHash === '') {
        return { stamped: [], skipped: [{ group_id: '', group_key: '', reason: 'seat-not-group-family' }], vector_hash: '' };
    }

    const vector = groupRevisionVector(store, story.id);

    if (groupVectorHash(vector) !== vectorHash) {
        return {
            stamped: [],
            skipped: [{ group_id: '', group_key: '', reason: 'vector-moved-mid-pass' }],
            vector_hash: vectorHash
        };
    }

    const blocked = openIssueGroupIds(store, story);
    const stamped: GroupRevision[] = [];
    const skipped: CleanStampResult['skipped'] = [];

    for (const group of phraseGroupsOf(store, story.id)) {
        const number = vector[group.id] ?? 0;

        if (number === 0) {
            skipped.push({ group_id: group.id, group_key: group.key, reason: 'group-unwritten' });
            continue;
        }

        if (blocked.has(group.id)) {
            // The reason a critic will want: which defect is holding the group's clean verdict back.
            skipped.push({ group_id: group.id, group_key: group.key, reason: 'open-issue-scopes-to-group' });
            continue;
        }

        const current = latestGroupRevision(store, group.id);

        // The vector says the CURRENT text is what was reviewed; `latestGroupRevision` is the row behind
        // it (R2 keeps them from drifting, and the check makes the drift loud rather than silent).
        if (current === undefined || current.number !== number) {
            skipped.push({ group_id: group.id, group_key: group.key, reason: 'no-current-revision-row' });
            continue;
        }

        if (current.clean === true) {
            skipped.push({ group_id: group.id, group_key: group.key, reason: 'already-stamped' });
            continue;
        }

        stamped.push(
            store.groupRevisions.update(
                current.id,
                { clean: true, clean_run_ref: options.runRef },
                {
                    ...attribution,
                    // The `why` names the vector, because "run X stamped it" is not the claim — the claim
                    // is that this TEXT was the group's text in a clean read of that combination (D-67).
                    why: `${attribution.why}; ${group.key} revision ${current.number} was clean at vector ${vectorHash} (D-67)`
                },
                [{ id: current.id, rev: current.rev }]
            )
        );
    }

    return { stamped, skipped, vector_hash: vectorHash };
}

// ---------------------------------------------------------------------------
// The Author's choose (D-68)
// ---------------------------------------------------------------------------

/** What the choose wrote, in the shapes the route answers with and a test pins. */
export interface ReviewedChooseResult {
    /**
     * The new `latest` rows — one per group that was WRITTEN, holding the chosen text (catalog order).
     *
     * A LOCKED GROUP IS NOT IN HERE (R-LOCK): its chosen text is the row it already had, retained rather
     * than replaced, so a book with four locked groups installs one row. `chosen.sources` names every
     * group, installed or retained, so a caller never has to guess which slot a row belongs to.
     */
    installed: GroupRevision[];
    /** Every revision row THIS choose flipped to `discarded`, in group-then-number order. */
    discarded: GroupRevision[];
    /**
     * The group rows the install rewrote, catalog order: the live Overview now IS the reviewed one.
     * On an all-locked book nothing was rewritten, so this names the locked rows the choose RETAINED —
     * the Overview is unchanged because the reviewed one and the live one are the same bytes.
     */
    groups: PhraseGroup[];
    /** The Phrase row after the install and the choice record. */
    phrase: Phrase;
    /** R6's mirror write, reported exactly as the install reported it. */
    mirror: GroupInstallResult['mirror'];
    /** The decision the Author made, as it was persisted. */
    chosen: {
        vector: Record<string, number>;
        vector_hash: string;
        at: string;
        overview: string;
        /** Where each chosen text came from: `{groupId: the selected revision's number/id}`. */
        sources: Array<{ group_id: string; group_key: string; source_revision: number; source_id: string; installed_revision: number }>;
    };
}

/**
 * Performs the Author's choose: the reviewed Overview becomes the book (D-68).
 *
 * ONE COMMIT, four writes, in this order:
 *   1. an ordinary INSTALL of the selected texts (`installGroupRevisions`, the only write path a group
 *      text has): each group gets its next `latest` holding the chosen text, the text it replaces is
 *      archived, the Overview recomposes from the rows as they now are, and §4.2's mirror is rewritten
 *      in the same commit (R6). Choosing therefore cannot produce a second definition of "current" —
 *      after this line the live Overview and the reviewed Overview are the same bytes;
 *   2. every revision of this Story that is NOT one of those five new rows becomes `discarded`. The
 *      rows PERSIST: R3's closure join (`phrase/findings.ts:groupResolvesFinding`) walks the whole
 *      history with no state filter, so a finding that a discarded revision closed stays `fixed` —
 *      pinned by `phrase/reviewed.test.ts`, because the obvious implementation ("drop the losers", the
 *      legacy selection's D-22 truncation) is the one that would have quietly un-fixed half the book;
 *   3. the choice itself is recorded on the Phrase row (`reviewed_vector` / `reviewed_vector_hash`),
 *      which is what lets the rail keep showing the CHOSEN text and the score that was judged against
 *      it after the live pipeline moves on;
 *   4. nothing else. No phase lock (choosing is not locking), no score write (D-65), no task, and no
 *      finding claim — the chosen rows carry `run_ref: null` and no `finding_refs`, exactly like the
 *      Author's hand-edit route, because a choice resolves nothing on R3's evidence rule.
 *
 * LOCKED GROUPS ARE CHOSEN, NOT REWRITTEN (R-LOCK). A locked group's selection is its current row (see
 * {@link cleanSelectionOf}), so the choose installs the writable groups and RETAINS the frozen one: the
 * locked row is put in the chosen set rather than installed, which keeps it `latest` (the discard sweep
 * would otherwise take the group's only current row with it), keeps `chosenSelectionOf` able to read the
 * choice back through `locked_revision`, and keeps the locked sentence inside the chosen Overview as the
 * baseline the installed groups were revised to agree with. The vector is the full five-group one either
 * way — for a locked group it is the group's own current number, the same number
 * `groupRevisionVector` prints — so a choose over a partly locked book records the Overview it actually
 * chose and cannot desync the Reader's score from the text the score describes. On a book whose FIVE
 * groups are locked there is nothing to install at all; the choose is still a decision worth recording,
 * so it writes step 3 and says plainly that it installed and mirrored nothing.
 *
 * The installed rows are deliberately NOT clean-stamped: they never sat through a review pass. The
 * group's next cross-group pass over the new vector earns that verdict, and until then the book has no
 * new reviewed Overview to choose — which is the honest reading of a Summary nobody has read yet.
 *
 * Throws when the selection is incomplete; the route answers 409, and the throw is the guard for every
 * other caller (the install of a three-group Overview would install a three-group book).
 */
export function chooseReviewedSummary(
    store: Store,
    story: Story,
    attribution: Attribution,
    options: { at?: string } = {}
): ReviewedChooseResult {
    const selection = cleanSelectionOf(store, story);

    if (!selection.complete) {
        throw new Error(
            `chooseReviewedSummary: no reviewed Overview exists — ${selection.gaps
                .map((gap) => `${gap.group_key} (${gap.reason})`)
                .join(', ')} still lacks a clean revision (D-68)`
        );
    }

    const at = options.at ?? nowIso();
    const fresh = store.stories.require(story.id);
    const phraseBefore = storyPhrase(store, story.id);

    if (phraseBefore === undefined) {
        throw new Error(`chooseReviewedSummary: story ${story.id} has no Summary Phrase row (R1: ensure the catalog first)`);
    }

    // 1. The install — the SELECTED texts of every group that is still writable, in catalog order.
    //    A LOCKED GROUP IS NOT INSTALLED (R-LOCK): the text `cleanSelectionOf` picked for it IS the
    //    group's current text, so an install would mint a fresh revision of prose the Author froze — and
    //    `installGroupRevisions` refuses a locked entry before it writes anything, which would fail the
    //    WHOLE choose (R2's atomicity) over a group that needed no write at all. Splitting here keeps
    //    that refusal a guard for stale Writer results rather than a routine refusal of the Author's own
    //    choose, and it keeps the locked sentence inside the chosen Overview as the baseline the newly
    //    installed groups were revised to agree with.
    const lockedEntries = selection.entries.filter((entry) => isPhraseGroupLocked(entry.group));
    const installEntries = selection.entries.filter((entry) => !isPhraseGroupLocked(entry.group));
    const summary = store.summaries.list().find((row) => row.story_id === story.id);

    const install: GroupInstallResult =
        installEntries.length === 0
            ? // Every group is locked, so the reviewed Overview already IS the live one, byte for byte,
              // and there is nothing to install. The choose still writes the decision record (step 3):
              // the Author's pick is a fact — the rail keeps showing that text and the score judged
              // against it — even when it changed nothing. `groups` reports the rows this choose
              // touched, which here is every locked group (`selection.complete` plus no writable entry
              // means all five are locked), and the mirror says plainly that no field was rewritten.
              {
                  installed: [],
                  archived: [],
                  groups: phraseGroupsOf(store, story.id, phraseBefore.id).filter(isPhraseGroupLocked),
                  phrase: phraseBefore,
                  mirror: {
                      summary_id: summary?.id ?? null,
                      fields: [],
                      written: false,
                      ...(summary === undefined ? { reason: 'no_summary' as const } : {})
                  }
              }
            : installGroupRevisions(
                  store,
                  fresh,
                  installEntries.map((entry) => ({ group: entry.group, content: entry.revision.content })),
                  attribution,
                  // `run_ref: null` says no run wrote this text (P11); `work_item_ref` names the Author's verb
                  // rather than a Work Item, the same convention the legacy import seeds (`phrase_import`).
                  { runRef: null, workItemRef: 'phrase_reviewed_choose' }
              );

    const chosenIds = new Set<string>([
        ...install.installed.map((revision) => revision.id),
        // THE RETAINED ROWS. A locked group gets no new revision, so the row behind its current text is
        // itself a chosen row — and the sweep below flips everything un-chosen to `discarded`. Without
        // this, a choose would discard a locked group's own `latest` row: `latestGroupRevision` filters
        // on `state: 'latest'`, so the group would read as having no current text, the group row and its
        // history would disagree (R2's invariant), and the locked sentence would vanish from every later
        // Overview. Retaining it is also what `chosenSelectionOf` reads back (its number is in the vector).
        ...lockedEntries.map((entry) => entry.revision.id)
    ]);

    // 2. Discard everything the choice passed over — retained, terminal, hidden from current reads.
    const discarded = store.groupRevisions
        .list()
        .filter((revision) => revision.story_id === story.id && !chosenIds.has(revision.id) && revision.state !== 'discarded')
        .sort((left, right) => left.group_id.localeCompare(right.group_id) || left.number - right.number)
        .map((revision) =>
            store.groupRevisions.update(
                revision.id,
                { state: 'discarded' },
                {
                    ...attribution,
                    why: `${attribution.why}; discarded ${revision.group_key} revision ${revision.number} as a text the reviewed Summary did not select (D-68)`
                },
                [{ id: revision.id, rev: revision.rev }]
            )
        );

    // 3. The decision record. Re-read the phrase row: the install moved its `rev` in this commit, and a
    //    CAS against the pre-install copy would fail on every choose.
    const phraseAfter = store.phrases.require(phraseBefore.id);
    const phrase = store.phrases.update(
        phraseAfter.id,
        {
            reviewed_vector: selection.vector,
            reviewed_vector_hash: selection.vector_hash,
            reviewed_at: at
        },
        {
            ...attribution,
            why: `${attribution.why}; the Phrase row records the reviewed vector ${selection.vector_hash} as the Author's choice (D-68)`
        },
        [{ id: phraseAfter.id, rev: phraseAfter.rev }]
    );

    // The installed rows, joined by GROUP rather than by position: with a locked group in the selection
    // the two orders differ (the locked entry occupies a slot in `selection.entries` and installs no
    // row), and a positional read would hand the rail the NEXT group's revision number.
    const installedByGroup = new Map(install.installed.map((revision) => [revision.group_id, revision] as const));

    return {
        installed: install.installed,
        discarded,
        groups: install.groups,
        phrase,
        mirror: install.mirror,
        chosen: {
            vector: selection.vector,
            vector_hash: selection.vector_hash,
            at,
            overview: composeReviewedOverview(selection),
            sources: selection.entries.map((entry) => ({
                group_id: entry.group.id,
                group_key: entry.group.key,
                source_revision: entry.revision.number,
                source_id: entry.revision.id,
                // A locked group installed nothing, so the revision the Overview carries for it is the
                // one it already had — the retained row — which is also the number its lock fixed.
                installed_revision: installedByGroup.get(entry.group.id)?.number ?? entry.group.revision
            }))
        }
    };
}


