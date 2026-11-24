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
import type { Finding, GroupRevision, PhraseGroup, Story } from '../../shared/types';
import type { Attribution, Store } from '../store';
import { phraseGroupsOf } from './catalog';

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
    /** Every group the finding targets, catalog order. */
    targeted: string[];
    /** The targeted groups that have a resolving revision. */
    resolved: string[];
    /** The targeted groups that do not — the work still owed. Empty means the finding may close. */
    missing: string[];
    /** True only when EVERY targeted group has one (R3). A partial fix is FALSE, never "close enough". */
    resolved_all: boolean;
}

/**
 * R3's rule as a read: which targeted groups have been rewritten to answer this finding.
 *
 * A finding that targets NO groups at all (a Story with no phrase rows — the legacy shape on a
 * legacy book) resolves vacuously, and the caller that matters (the group settlement) never runs for
 * such a Story, so the vacuous TRUE cannot close anything it should not.
 */
export function findingResolution(store: Store, story: Story, finding: Finding): FindingResolution {
    const scope = findingGroupScope(store, story, finding);
    const resolved: string[] = [];
    const missing: string[] = [];

    for (const groupId of scope.refs) {
        if (groupResolvesFinding(store, finding, groupId) === undefined) missing.push(groupId);
        else resolved.push(groupId);
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

    const titles = resolution.targeted
        .map((id) => store.phraseGroups.get(id)?.key ?? id)
        .join(', ');

    store.findings.update(
        finding.id,
        { state: 'fixed' },
        // The `why` names the GROUPS, because "run X fixed it" is not the truth of this redesign —
        // the truth is that every group the defect named now has a revision written to answer it (R3).
        { ...attribution, why: `${attribution.why}; closed ${finding.id} because every group it names (${titles}) has a revision written to resolve it (R3, D-34)` },
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
 */
export function findingGroupsStillOwed(store: Store, story: Story, finding: Finding): PhraseGroup[] {
    const resolution = findingResolution(store, story, finding);
    const owed = new Set(resolution.missing);

    return phraseGroupsOf(store, story.id).filter((group) => owed.has(group.id));
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
