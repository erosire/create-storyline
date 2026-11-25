// SUMMARY PHRASE — a finding's groups, and when one is allowed to close (R3).
//
// THE RULE THIS MODULE ENFORCES, stated exactly: a finding names the groups it is about — one,
// several, or all five — and it becomes `fixed` only when EVERY group it names has a revision
// written to resolve it. A finding that names Premise and Ending stays OPEN when a Premise revision
// lands: the Author's book still contains the defect, in the group nobody rewrote, and closing the
// row on a partial fix is how the loop reports work it did not do.
//
// WHY THE ANCHOR IS AN EXPLICIT `finding_refs` LIST ON THE REVISION RATHER THAN A TIMESTAMP:
// "a revision of that group created after the finding was approved" looks equivalent and is not.
// The loop restarts, a Writer may answer two findings in one batch, and an Author's own edit to a
// group would resolve a finding it was never told about. A resolving revision is one the JOB said it
// was written for — recorded on the row when the batch is installed (`revisions.ts` copies
// `WorkItem.findingRefs` there) — so closure is re-derivable from the journal after a restart, and
// the audit can name which revision closed which finding and in which group.
//
// WHY AN UNSCOPED FINDING READS AS "ALL GROUPS": `Finding.group_refs` is optional (R3, additive),
// because a finding raised before the redesign, or by a run that named none, has no attribution —
// and that is precisely the legacy meaning of a Summary defect: it belongs to the Overview as a
// whole. Treating absence as "no groups" would close a whole-Overview finding on the strength of one
// unrelated group edit, which is the exact bug R3 exists to prevent.
//
// THE GROUP LOCK (R-LOCK) ADDS ONE CLAUSE to that rule, and it is a subtraction, not a new state: a
// group whose text is locked cannot be rewritten, so a claim against it can never be ANSWERED with a
// revision. `findingActionableScope` splits the R3 attribution into the part a Writer can still act on
// and the frozen part, and every read that decides WORK (`findingResolution`'s `missing`,
// `findingGroupsStillOwed`, and through them the batch planner and the drain probe) uses the actable
// part. That is what keeps a cross-group finding from parking forever on a locked group, and it is why
// an all-locked finding is discarded rather than left `approved` with nothing to do (`locks.ts` writes
// the discard at lock time). The ATTRIBUTION itself is never rewritten: `findingGroupScope` still names
// every group, because the record says what the defect is about even where the book has stopped being
// able to act on it.
import { PHRASE_PLOTLINES_KEY, PHRASE_SUMMARY_KEY } from '../../shared/phrase';
import type { Finding, GroupRevision, PhraseGroup, Story } from '../../shared/types';
import type { Attribution, Store } from '../store';
import {
    isGroupManagedStory,
    isPhraseGroupLocked,
    isPhraseGroupManaged,
    lockedPhraseGroupIds,
    phraseGroupsOf,
    storyPhraseByKey
} from './catalog';

// ---------------------------------------------------------------------------
// Attribution — which groups a finding is about
// ---------------------------------------------------------------------------

/** A finding's group attribution: the ids, in catalog order, and whether the finding named any. */
export interface FindingGroupScope {
    /** The groups the finding targets, in catalog order. For an unscoped finding: every group. */
    refs: string[];
    /** True when the finding named NO groups (the legacy whole-Overview reading). */
    unscoped: boolean;
}

/**
 * The groups one finding targets (R3).
 *
 * The ids on the record are FILTERED against the Story's own rows: a ref naming a group this Story
 * does not have (a book edited by hand, or a finding carried over from a re-imported story) is
 * dropped rather than trusted, because an unresolvable target would keep the finding open forever
 * with no work the loop can ever dispatch against it. The order is the CATALOG's, not the answer's,
 * so two findings describing the same group set read identically everywhere (projections, claim
 * keys, the Author's rail).
 */
export function findingGroupScope(store: Store, story: Story, finding: Finding): FindingGroupScope {
    const owned = phraseGroupsOf(store, story.id);
    const ownedIds = new Set(owned.map((group) => group.id));
    const named = Array.isArray(finding.group_refs) ? finding.group_refs.filter((id) => ownedIds.has(id)) : [];

    if (named.length === 0) {
        // Unscoped: the whole Overview is the target (see the file header). Order comes from
        // `phraseGroupsOf`, which is already catalog-ordered.
        return { refs: owned.map((group) => group.id), unscoped: true };
    }

    // Preserve catalog order even though the record's array is in whatever order the reporter sent.
    const namedSet = new Set(named);

    return { refs: owned.filter((group) => namedSet.has(group.id)).map((group) => group.id), unscoped: false };
}

/** The catalog-ordered group rows a finding targets — the form the work planner batches. */
export function findingTargetGroups(store: Store, story: Story, finding: Finding): PhraseGroup[] {
    const scope = findingGroupScope(store, story, finding);
    const wanted = new Set(scope.refs);

    return phraseGroupsOf(store, story.id).filter((group) => wanted.has(group.id));
}

/**
 * A finding's scope split by what a lock has frozen (the lock's view of R3's attribution).
 *
 * WHY A SECOND READ RATHER THAN A FILTER INSIDE {@link findingGroupScope}: that function answers the
 * ATTRIBUTION question — "which groups is this claim about?" — and the rail, the brief and the
 * fingerprint all read it as written, including for a group nobody may rewrite any more. This one
 * answers the WORK question — "which of those groups can still be rewritten to answer it?" — and only
 * the planner, the closure gate and the clean selection want that. Collapsing the two would put a lock
 * inside the record's meaning, and an unscoped finding (whose scope IS every group) would quietly turn
 * into an empty scope on the first lock instead of narrowing to the groups still open.
 */
export interface FindingActionableScope extends FindingGroupScope {
    /** The part of `refs` the lock has frozen: void for this finding — no further revision of it exists. */
    locked_refs: string[];
    /** `refs` without `locked_refs` — the groups this finding may still demand a rewrite from. */
    unlocked_refs: string[];
    /**
     * True when the finding names groups and every one of them is locked. Void, not resolved: the
     * claim is about text nobody is allowed to change, so it can neither be answered with a new
     * revision nor hold a fix open — `locks.ts:lockPhraseGroup` discards rows in this state, and a row
     * raised after the lock simply never becomes work.
     */
    voided: boolean;
}

/**
 * R3's scope with the locked groups subtracted (R-lock). Pure over the rows, like the scope it reads.
 *
 * The subtraction is applied to `refs` — never to `finding.group_refs` — so an UNSCOPED finding keeps
 * its whole-Overview meaning and narrows to exactly the groups that remain writable: with four of five
 * groups locked, an unscoped claim is still work for the fifth, and with all five locked it is void.
 */
export function findingActionableScope(store: Store, story: Story, finding: Finding): FindingActionableScope {
    const scope = findingGroupScope(store, story, finding);
    const locked = lockedPhraseGroupIds(store, story.id);
    const locked_refs = scope.refs.filter((id) => locked.has(id));
    const unlocked_refs = scope.refs.filter((id) => !locked.has(id));

    return { ...scope, locked_refs, unlocked_refs, voided: scope.refs.length > 0 && unlocked_refs.length === 0 };
}

// ---------------------------------------------------------------------------
// Resolution — which targeted groups have been rewritten to answer the finding
// ---------------------------------------------------------------------------

/**
 * The revision of ONE group that resolves one finding, or `undefined`.
 *
 * "Resolves" is the explicit claim on the row (`finding_refs` includes the finding id), and the
 * newest such revision wins: a Writer can answer the same finding twice (the first attempt failed
 * review), and the later one is the text the Overview now carries.
 */
export function groupResolvesFinding(
    store: Store,
    finding: Finding,
    groupId: string
): GroupRevision | undefined {
    return store.groupRevisions
        .list()
        .filter(
            (revision) =>
                revision.group_id === groupId &&
                Array.isArray(revision.finding_refs) &&
                revision.finding_refs.includes(finding.id)
        )
        .sort((left, right) => right.number - left.number || left.id.localeCompare(right.id))[0];
}

/** One finding's resolution state, group by group — the shape R3's rule is stated in. */
export interface FindingResolution {
    finding_id: string;
    /** Every group the finding targets, catalog order — the ATTRIBUTION, locked groups included. */
    targeted: string[];
    /** The targeted groups that have a resolving revision. */
    resolved: string[];
    /**
     * The targeted groups that do not — the work still owed. Empty means the finding may close.
     *
     * A LOCKED group is never in here (R-lock): `missing` is the debt a Writer can pay, and a locked
     * group has no next revision to buy. It stays in `targeted`, because the claim really is about it,
     * and it is the locked side's consistency that the unlocked groups have to be revised for.
     */
    missing: string[];
    /** True only when EVERY targetable group has one (R3). A partial fix is FALSE, never "close enough". */
    resolved_all: boolean;
}

/**
 * R3's rule as a read: which targeted groups have been rewritten to answer this finding.
 *
 * A finding that targets NO groups at all (a Story with no phrase rows — the legacy shape on a
 * legacy book) resolves vacuously, and the caller that matters (the group settlement) never runs for
 * such a Story, so the vacuous TRUE cannot close anything it should not.
 *
 * A LOCKED group with no answering revision is skipped rather than counted as `missing` (see the field
 * note above): the alternative is a claim that holds the pipeline open over text the Author has
 * declared final, which is the state a lock exists to end. `closeFindingWhenGroupsResolved` still
 * refuses to write `fixed` for a finding whose groups are ALL locked — that sentence would say a
 * revision answered it, and none did.
 */
export function findingResolution(store: Store, story: Story, finding: Finding): FindingResolution {
    const scope = findingActionableScope(store, story, finding);
    const locked = new Set(scope.locked_refs);
    const resolved: string[] = [];
    const missing: string[] = [];

    for (const groupId of scope.refs) {
        if (groupResolvesFinding(store, finding, groupId) !== undefined) resolved.push(groupId);
        // Void for the locked group: not an answer, and not a debt either.
        else if (!locked.has(groupId)) missing.push(groupId);
    }

    return {
        finding_id: finding.id,
        targeted: [...scope.refs],
        resolved,
        missing,
        resolved_all: missing.length === 0
    };
}

/**
 * Closes a finding whose every targeted group has a resolving revision, and reports what it did.
 *
 * THE STATE GATE IS NOT CEREMONY. The loop calls this after every group install, and the rows in
 * play are whatever the batch answered — including findings that were never authorised (D-33
 * `unconfirmed`/`confirmed`, or D-34's approval gate still waiting on the Author). Closing one of
 * those would put the loop above the gate: the finding would read `fixed` while the Author was
 * looking at an APPROVAL row. So only an `approved` finding can close here (the dial's auto-approve
 * writes `approved` with `approved_by: 'auto'`, so the covered costs do close without a tap), and a
 * `fixed`/`discarded`/`disputed` row is left exactly as it is — idempotent, so a restart that
 * replays the install changes nothing the second time.
 *
 * WHY A PARTIAL FIX IS NOT A PARTIAL CLOSE: there is no "partly fixed" state in §4.10's ladder, and
 * inventing one would put a new value in an enum the whole build reads. The open finding with its
 * `missing` groups is the honest answer, and `findingGroupsStillOwed` routes exactly those groups
 * into the next Writer batch, so the partial fix is a step, not a stall.
 *
 * AND WHY A VOID FINDING DOES NOT CLOSE EITHER (R-lock): when a finding names a locked group AND an
 * unlocked one, the unlocked side's answering revision is the whole of the evidence the close can ask
 * for — the locked half can never produce one — so it may close, with the journal saying which half was
 * void. When EVERY group it names is locked, nothing has been answered at all and the row is discarded,
 * never `fixed`: that write would claim a revision that no install is allowed to make.
 */
export function closeFindingWhenGroupsResolved(
    store: Store,
    finding: Finding,
    attribution: Attribution
): { closed: boolean; resolution: FindingResolution } {
    const story = store.stories.get(finding.story_id);

    if (story === undefined) {
        return {
            closed: false,
            resolution: { finding_id: finding.id, targeted: [], resolved: [], missing: [], resolved_all: false }
        };
    }

    const resolution = findingResolution(store, story, finding);

    if (finding.state !== 'approved' || !resolution.resolved_all) return { closed: false, resolution };

    // R-LOCK — a claim about text that can no longer change is VOID, not answered. The lock operation
    // discards rows in this state, so reaching the close gate with one means the claim was raised (or
    // approved) AFTER its whole scope froze; writing `fixed` there would journal "every group it names
    // has a revision written to resolve it" over a group that has no revision on its way at all.
    const scope = findingActionableScope(store, story, finding);

    if (scope.voided) return { closed: false, resolution };

    const keyOf = (id: string): string => store.phraseGroups.get(id)?.key ?? id;
    // Only the groups that could still be rewritten are credited in the sentence; the locked ones are
    // named separately, so an Author reading the journal can see which half of the claim the lock made
    // moot rather than inferring it from a group that is conspicuously missing from the list.
    const titles = resolution.targeted.filter((id) => !scope.locked_refs.includes(id)).map(keyOf).join(', ');
    const lockedTitles = scope.locked_refs.map(keyOf).join(', ');

    store.findings.update(
        finding.id,
        { state: 'fixed' },
        {
            ...attribution,
            // The `why` names the GROUPS, because "run X fixed it" is not the truth of this redesign —
            // the truth is that every group the defect named now has a revision written to answer it (R3).
            why: `${attribution.why}; closed ${finding.id} because every group it names (${titles}) has a revision written to resolve it${
                lockedTitles === '' ? '' : `; ${lockedTitles} is locked, so the claim is void for that group`
            } (R3, D-34)`
        },
        [{ id: finding.id, rev: finding.rev }]
    );

    return { closed: true, resolution };
}

/**
 * The groups a still-open finding still owes work to — the planner's routing read (R3 + R4).
 *
 * Returns the targeted groups with NO resolving revision, catalog order. An approved finding whose
 * groups are all rewritten but which has not closed yet (the install commit is about to close it)
 * yields `[]`, so the sweep does not buy a Writer pass for a defect the book has already answered.
 *
 * LOCKED GROUPS ARE NEVER IN THE ANSWER (R-lock). The resolution read already omits them from
 * `missing`; the row-level filter here is the second half of the same sentence, and it is what stops a
 * finding that spans a locked group and an unlocked one from stranding the batch: the locked half is
 * void, so the finding's whole still-owed set IS the unlocked half, and `planGroupDraftBatch`'s
 * completeness check (D-66) sees a set it can install whole.
 */
export function findingGroupsStillOwed(store: Store, story: Story, finding: Finding): PhraseGroup[] {
    const resolution = findingResolution(store, story, finding);
    const owed = new Set(resolution.missing);

    return phraseGroupsOf(store, story.id).filter((group) => owed.has(group.id) && !isPhraseGroupLocked(group));
}

/**
 * T-W2b — THE GROUP NAMESPACE a reporter may name: which groups exist for `raiseFinding`'s R3 rules.
 *
 * WHY THIS IS A FUNCTION AND NOT `phraseGroupsOf(store, storyId)`: the namespace is what makes the
 * reporter's R3 branch fire at all (an empty list switches those rules off), so widening it silently
 * changes the meaning of every finding on the book. It follows the DIALS:
 *
 *   * neither phrase is group-managed → `[]`. A classic book keeps its legacy semantics exactly:
 *     `group_refs` is optional and an absent list means "not about a group";
 *   * the SUMMARY is group-managed → every group of the book, read unscoped, the same list R3 has
 *     always used (a Summary defect may name any entry, and the phrase's own rows are the ones it
 *     means). This is the untouched pre-T-W2b behaviour;
 *   * the PLOTLINE phrase is group-managed → the chapter ENTRIES are in the namespace, whether or not
 *     the Summary is grouped. This is the case the hybrid creates: phase ②'s reader reports a contract
 *     defect against a `plotlines` row, and the text that has to change is `chapter_<order>` — a
 *     reporter that could not name that id could not file a group-scoped finding at all, and an
 *     unscoped finding on a grouped book means "every entry", which is the expensive reading R3
 *     refuses. A started-but-classic Plotlines phrase (`plotlines_mode: 'classic'`) adds nothing, and
 *     the Summary reporter's list is exactly what it was before Phrase ② existed.
 *
 * The Summary's rows come first and the Plotlines phrase's second, each in its own catalog order, so a
 * refusal message lists a stable, phrase-grouped set instead of an interleaved one.
 */
export function findingGroupNamespace(store: Store, story: Story): PhraseGroup[] {
    const summaryManaged = isGroupManagedStory(story);
    const plotlineManaged = isPhraseGroupManaged(story, PHRASE_PLOTLINES_KEY);

    if (!summaryManaged && !plotlineManaged) return [];
    if (!plotlineManaged) return phraseGroupsOf(store, story.id);

    const plotlinePhrase = storyPhraseByKey(store, story.id, PHRASE_PLOTLINES_KEY);

    if (!summaryManaged) {
        return plotlinePhrase === undefined ? [] : phraseGroupsOf(store, story.id, plotlinePhrase.id);
    }

    const summaryPhrase = storyPhraseByKey(store, story.id, PHRASE_SUMMARY_KEY);

    return [
        ...(summaryPhrase === undefined ? [] : phraseGroupsOf(store, story.id, summaryPhrase.id)),
        ...(plotlinePhrase === undefined ? [] : phraseGroupsOf(store, story.id, plotlinePhrase.id))
    ];
}

/**
 * R3 — the close the state gate deferred, for an approval that lands AFTER its own fix.
 *
 * WHY THIS EXISTS AS ITS OWN CALL: `closeFindingWhenGroupsResolved` refuses anything but an
 * `approved` row (D-34's gate — the loop may not mark a defect `fixed` while the Author is looking
 * at an approval row), and the loop only calls it from the group install in `loop/engine.ts:settleJob`.
 * Those two events are ordered by the loop and not by causality: the group planner cuts a Writer
 * batch off an OPEN finding (`loop/work.ts:groupWorkTargets` deliberately accepts D-33's
 * `unconfirmed`/`confirmed` rows), so a pass can install the answer while the defect is still sitting
 * in front of the Editor, and the approval arrives afterwards — by the Editor's `approveFinding`, by
 * the dial's auto-approve, or by the Author's tap. Nothing then re-runs the close, and the book keeps
 * a finding whose every targeted group ALREADY has a revision claiming to resolve it: `approved`
 * forever, with a fix task the planner will never dispatch again because
 * {@link findingGroupsStillOwed} answers `[]` for it. Measured end to end in
 * `integration/summary-groups.test.ts`, which is where the ordering was found.
 *
 * WHY CONSUMING IT HERE IS HONEST AND NOT A SHORTCUT: R3's close is a READ over records — "every
 * group this finding targets has a revision written to answer it" — and the records already say true.
 * A hand edit cannot get a book into that state, because
 * `POST …/phrases/groups/{id}/revise` deliberately leaves `finding_refs` off the row it writes (R3: a
 * hand edit cannot close a finding on an evidence rule that belongs to a dispatched pass), so only an
 * installed Writer answer can have.
 *
 * THE `targeted.length > 0` GUARD IS NOT DECORATION: {@link findingResolution} answers
 * `resolved_all: true` for a finding with NOTHING in scope — a Story with no phrase rows, which is
 * every legacy Summary — and closing THAT on approval would delete the fix work the sampling pipeline
 * runs on. Only a finding that names real groups, every one of which carries a resolving revision,
 * is consumed here.
 *
 * Returns the row AS CLOSED, or `undefined` when nothing was written; the caller that arms Writer
 * work (the loop's `createWorkForFinding`, the Editor's `approveFinding`) uses that to decide whether
 * a fix task is owed at all.
 */
export function closeFindingAnsweredByInstalls(
    store: Store,
    story: Story,
    finding: Finding,
    attribution: Attribution
): Finding | undefined {
    // RE-READ, never the caller's copy: every approval funnel writes the state and then still holds the
    // PRE-update row, and the state gate is exactly the field it just changed.
    const authorised = store.findings.get(finding.id);

    if (authorised === undefined) return undefined;

    const resolution = findingResolution(store, story, authorised);

    if (resolution.targeted.length === 0 || !resolution.resolved_all) return undefined;

    const outcome = closeFindingWhenGroupsResolved(store, authorised, attribution);

    // The row is read back rather than built here: `closeFindingWhenGroupsResolved` owns the write and
    // its CAS, and the caller only needs to know the state the row is in now.
    return outcome.closed ? store.findings.get(finding.id) : undefined;
}
