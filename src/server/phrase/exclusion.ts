// SUMMARY PHRASE — the Writer exclusion (R4).
//
// THE RULE THIS MODULE ENFORCES, stated exactly: at most ONE live Writer operation per group. Two Writer
// batches whose group sets are DISJOINT run at the same time (that is the parallelism the redesign buys:
// Premise and Tone can be revised in one sweep without waiting on each other); a batch whose set OVERLAPS
// a live one is deferred, because two live writers on one group would race the compare-and-swap on
// the group row and — worse — would each install a revision on top of the other's, silently
// archiving text that the second writer never saw.
//
// D-66 (R12) ADDED ONE CLAUSE to that sentence, and it belongs in this file's header because the module
// that cuts the batch (`planGroupDraftBatch` below) is the module that holds the exclusion: the batch is
// not a bag of groups, it is a set of FINDING-SETS, and a set is deferred WHOLE. "Shrink the overlapping
// batch and dispatch the rest" is what used to split one defect across passes — installing `tone` while
// `premise` still said what the Author objected to banks a partial fix under a `finding_refs` claim — so
// the shrink survives as a primitive for refs and rows (`partitionGroupRefs`/`partitionGroups`, which the
// rail and the tests read) but no longer sizes a Writer batch.
//
// WHY IT IS DERIVED FROM THE BOOK AND NOT FROM A SEMAPHORE (R4): the loop is amnesiac by design
// (L-3: "the rows are the state"), so an in-memory set of held groups would be wrong in both
// directions after a restart — it would forget groups that are still being written and it would
// hold groups whose run died with the process. This module therefore reads the SAME live `runs`
// rows the sweep already walks when it sweeps for expired leases (`loop/records.ts:liveRuns`, L-2),
// and the group set from `Run.group_refs`, which `run/executor.ts` copies off the Work Item when the
// row is created. A lease expiry, a kill, and a restart all change the answer here with no
// bookkeeping of ours, because the run row IS the bookkeeping.
import type { Finding, Run, PhraseGroup, Story } from '../../shared/types';
import type { Store } from '../store';
// HARDENING (drain/sign-off parity): the group pipeline's write-allowance, target set and review
// seats now READ from here rather than duplicating — the counters below need the same run reads the
// exclusion makes (`createdAfter`/`isLiveRun`/`runsForItem`) and the same Author dials.
// `samplingSizeOf` joins those reads for D-66: the batch dial (`stories.summary_sampling`) is one of
// the two inputs of the cut below, and the number must keep ONE definition — `loop/records.ts` owns
// it, `loop/work.ts:summarySamplingOf` is only a named alias of it, and importing the alias here would
// put a cycle between this module and the planner that dispatches with it.
// W5 adds the two reads the review seat's retry counter needs: `isReportedRun` (the closed state that
// means an ANSWER, not merely a run row) and `SAMPLING_RETRY_ALLOWANCE` (the loop's one retry budget,
// which `groupReviewAttemptCap` reuses instead of inventing a number here).
import {
    createdAfterSeq,
    creationSeq,
    isLiveRun,
    isReportedRun,
    liveRuns,
    runsForItem,
    samplingSizeOf,
    SAMPLING_RETRY_ALLOWANCE,
    screeningSizeOf,
    storyFindings
} from '../loop/records';
// The catalog order the atomic batch is cut and re-sorted in (D-66): the same rank every group list in
// this package is written in, read from its owner rather than re-derived here.
import { phraseGroupRank } from '../../shared/phrase';
import { isPhraseGroupLocked, phraseGroupsOf, primaryPhraseOf } from './catalog';
// SEAM S8: the draft claim-key ref comes from the PHRASE CONTROLLER, because which record a claim
// family keys on is a fact about the phrase, not about the loop (`summaryRef` was that fact spelled out
// by hand while the Summary was the only phrase). `controller.ts` reaches the engine through
// `catalog.ts`/`revisions.ts` and never back into this module, so the import has no cycle.
import { phraseController } from './controller';
// The vector identity the review seats are keyed by, and the history the write-allowance counts
// against — both owned by `phrase/revisions.ts`, both read here rather than re-derived.
import { groupRevisionHistory, groupRevisionVector, groupVectorHash } from './revisions';
// R3's routing read: which groups an open finding still needs rewritten.
import { findingGroupsStillOwed } from './findings';

/**
 * The Work Item kinds that HOLD a group.
 *
 * A review pass (`review_groups`) and a tool-carrying deep review read the Overview and write
 * findings, verdicts and review rows — never a group — so they are deliberately absent: excluding
 * them behind a Writer would serialise the whole phase-① pipeline behind its first install and buy
 * back the queueing the redesign removes. `draft_groups` is the only kind that can install, so it is
 * the only kind that can hold.
 */
export const GROUP_HOLDING_KINDS = ['draft_groups'] as const;

/**
 * The claim-key family of a group draft job — `wi_draft_groups_<summaryRef>_<group-set hash>_<attempt>`.
 *
 * It lives HERE rather than in `loop/work.ts` because the exclusion has to recognise the family from
 * a persisted `work_item_ref` alone (a run row is all the restart leaves), and an anchored prefix
 * check is the only test that cannot confuse one family with another (`wi_draft_groups_1` vs a
 * hypothetical `wi_draft_groups_10` is the same trap the sampling families already guard against).
 * `work.ts` builds its keys from this constant, so the builder and the reader cannot drift.
 */
/**
 * The claim-key family of one holding kind (`wi_draft_groups`). One function, so adding a second
 * holding kind is one entry in {@link GROUP_HOLDING_KINDS} and the reader picks it up automatically.
 */
export const groupItemPrefixOf = (kind: (typeof GROUP_HOLDING_KINDS)[number]): string => `wi_${kind}`;

/** The Writer family's anchored prefix — the spelling `loop/work.ts` builds keys with. */
export const GROUP_DRAFT_ITEM_PREFIX = groupItemPrefixOf('draft_groups');

/**
 * The ref a phrase's draft claim family embeds (seam S8) — the loop's drop-in for the summary-only
 * expression it builds keys with today (`storySummary(store, story.id)?.id`).
 *
 * WHY IT DELEGATES INSTEAD OF REPEATING THE RULE: "which row namespaces this phrase's claim keys" belongs
 * to the phrase, and both owners already exist — the Summary contributes the `summaries` row id (so every
 * persisted `wi_draft_groups_summary_0_…` key survives), Phrase ② contributes its own phrase row id (so a
 * chapter batch and a Summary batch on one book can never claim each other's attempts). A second spelling
 * of that rule here is how the two would drift, so this is a lookup: resolve the phrase (the PRIMARY one
 * when the caller names none, which is what the loop has always meant), ask its controller, and fall back
 * to the row's own id for a kind the registry does not know — still a family disjoint from the Summary's.
 *
 * `''` means "this phrase has nothing to key on yet", the same empty answer the loop already reads as
 * "generate no job".
 */
export function groupDraftClaimRef(store: Store, story: Story, phraseId?: string): string {
    const phrase =
        phraseId === undefined
            ? primaryPhraseOf(store, story.id)
            : store.phrases.list().find((row) => row.story_id === story.id && row.id === phraseId);

    if (phrase === undefined) return '';

    return phraseController(phrase.key)?.draftClaimRef(store, story, phrase) ?? phrase.id;
}

/**
 * Whether a run row belongs to a kind that holds its groups.
 *
 * The trailing `_` is the anchor, not decoration: `wi_draft_groups_<summaryRef>_…` is the family, and
 * a kind spelled with this one as its prefix (`draft_groupsx`) must not read as held. This is the same
 * anchoring rule `loop/records.ts` applies to the sampling families, and for the same reason — the
 * check runs against a persisted key alone, which is all a restart leaves.
 */
/**
 * Whether a run row belongs to a kind that HOLDS its groups — the one reading of "this run is writing
 * a group" that both the exclusion and the retry allowance share.
 *
 * Exported because the retry counter (`loop/work.ts:groupWriteAttempts`) must count the SAME rows this
 * predicate recognises: a `review_groups` or deep-review run carries `group_refs` (its Critic judged all
 * five groups) but wrote none of them, and counting it as a write spends the group's Writer allowance on
 * reading. Two definitions of "a write" would drift the first time a third kind learns to carry refs.
 */
export const isGroupHoldingRun = (run: Run): boolean =>
    GROUP_HOLDING_KINDS.some((kind) => (run.work_item_ref ?? '').startsWith(`${groupItemPrefixOf(kind)}_`));

/**
 * The group sets of the live Writer runs of one Story, in run order.
 *
 * A live holding run that carries NO `group_refs` (a row written before this field existed, or a
 * row whose copy step was skipped) is read as holding EVERY group of the Story. That fails CLOSED,
 * and failing closed is the right direction for an exclusion: the cost of the conservative reading
 * is one deferred sweep, and the cost of the permissive one is two writers installing over each
 * other and an archived revision nobody reviewed.
 */
export function liveGroupSets(store: Store, storyId: string, phraseId?: string): string[][] {
    const live = liveRuns(store, storyId).filter(isGroupHoldingRun);

    if (live.length === 0) return [];

    // Scoped to the phrase the caller is planning (default: the Story's PRIMARY phrase — what this read
    // always meant). Without scoping, a chapter entry of Phrase ② would appear in the "every group"
    // fallback below and a Summary run with no `group_refs` would hold chapters it never touched.
    const all = phraseGroupsOf(store, storyId, phraseId ?? primaryPhraseOf(store, storyId)?.id).map(
        (group) => group.id
    );

    return live.map((run) => {
        const refs = Array.isArray(run.group_refs) ? run.group_refs.filter((ref) => typeof ref === 'string') : [];

        return refs.length > 0 ? refs : all;
    });
}

/** The union of every held group id — the fast answer generation and dispatch both ask for. */
export function liveGroupRefs(store: Store, storyId: string, phraseId?: string): Set<string> {
    const held = new Set<string>();

    for (const set of liveGroupSets(store, storyId, phraseId)) for (const id of set) held.add(id);

    return held;
}

/**
 * The live Writer runs holding one group, in row order — the subject of the Author's 409.
 *
 * The projection answers `writer_busy` as a boolean (a rail needs a disabled button, not a run id),
 * but the refusal has to name WHAT is writing, because the Author's next action is "wait for that run
 * or let it finish", not "guess". Same fail-closed reading as `liveGroupSets`: a live holding run with
 * no `group_refs` holds every group, so it appears here for every group of the Story.
 */
export function liveGroupWriters(store: Store, storyId: string, groupId: string): Run[] {
    return liveRuns(store, storyId).filter((run) => {
        if (!isGroupHoldingRun(run)) return false;

        const refs = Array.isArray(run.group_refs) ? run.group_refs.filter((ref) => typeof ref === 'string') : [];

        return refs.length === 0 || refs.includes(groupId);
    });
}

/** The ids in `groupRefs` that a live Writer already holds, in the order the caller named them. */
export function heldGroupRefs(store: Store, storyId: string, groupRefs: readonly string[], phraseId?: string): string[] {
    const held = liveGroupRefs(store, storyId, phraseId);

    return groupRefs.filter((id) => held.has(id));
}

/**
 * Splits a candidate batch into what may run now and what must wait (R4's "disjoint run
 * concurrently, overlapping batches deferred").
 *
 * The deferral is a SHRINK, not a cancel: a batch of {premise, tone} with premise already live
 * offers {tone} this sweep. Canceling the whole batch instead would make the exclusion a serialiser
 * again — the Author's queue would sit idle while one group's writer works, and a group with an
 * open fix task would keep waiting on an unrelated group. A batch that is ENTIRELY held yields an
 * empty `free`, which is the caller's signal to offer nothing (a Writer with no group to write has
 * no job to dispatch, and a claim key for it would spend an attempt on an empty answer).
 *
 * D-66 CHANGED WHO CALLS THIS for the Writer batch: `planGroupDraftBatch` defers a finding-set WHOLE
 * rather than shrinking it, because a shrunk multi-group batch is a partial fix. The split stays
 * exactly as it was for its other readers — the group rail's `writer_busy`/`deferred` read,
 * `phrase/exclusion.test.ts`, and any caller that has a BAG of groups rather than a finding — and the
 * two readings are kept apart by this note rather than by a second function, because the primitive is
 * the same and a near-copy is how the two would drift.
 *
 * Deterministic and clock-free by construction: the answer is a function of the run rows, so a
 * restart reproduces it exactly (L-3), and two engines asking in the same instant agree (L-5).
 */
export function partitionGroupRefs(
    store: Store,
    storyId: string,
    groupRefs: readonly string[],
    phraseId?: string
): { free: string[]; deferred: string[] } {
    const held = heldGroupRefs(store, storyId, groupRefs, phraseId);
    const heldSet = new Set(held);

    return {
        free: groupRefs.filter((id) => !heldSet.has(id)),
        deferred: held
    };
}

/** The same partition over GROUP ROWS, in catalog order — the form the work planner dispatches. */
export function partitionGroups(
    store: Store,
    storyId: string,
    groups: readonly PhraseGroup[],
    phraseId?: string
): { free: PhraseGroup[]; deferred: PhraseGroup[] } {
    const held = liveGroupRefs(store, storyId, phraseId);

    return {
        free: groups.filter((group) => !held.has(group.id)),
        deferred: groups.filter((group) => held.has(group.id))
    };
}

// ---------------------------------------------------------------------------
// The group pipeline's allowance, targets, and owed work — moved out of `loop/work.ts`
// ---------------------------------------------------------------------------
//
// HARDENING (drain/sign-off parity): `loop/work.ts` imports `loop/status.ts`, so `status.ts` cannot
// import `work.ts` back — and the drain probe (§6.7) and the phase-① sign-off gate have to answer the
// SAME questions the batch generator asks, or the rail says "owed" while the queue says "done" (or
// the reverse, which is worse: a sign-off over an unread Overview). These reads were always phrase-
// domain (the allowance counts exactly R4's rows, the targets are R3's routing, the seats are the
// vector's), so this module — which already owns the exclusion — is their one home. `work.ts` keeps
// the CANDIDATE building and re-exports the two Author-facing names from here.

/**
 * How many Writer passes one group gets against its CURRENT text before the loop stops buying
 * another one for it.
 *
 * The bound is per GROUP and measured against the group's CURRENT TEXT (`groupWriteAttempts`,
 * which falls back to the `phrase_groups` row while the group has never been written). Two
 * consequences are load-bearing:
 *
 *   1. a successful install RESETS the count for that group and only that group — writing the Tone
 *      group never spends Premise's allowance (R2), and a group that was rewritten successfully but
 *      is criticised again gets a fresh pair of attempts against the NEW text; and
 *   2. the count is a count of WRITES. A `review_groups` seat and the deep review carry `group_refs`
 *      (their Critic judged all five groups) yet install nothing, so they are excluded by the same
 *      `isGroupHoldingRun` predicate R4 holds groups with. Reading the review runs as writes would
 *      spend the allowance on reading: after one draft plus its two seats, every group would sit at
 *      the cap and an approved finding could never schedule its Writer fix (F1).
 *
 * Why a number at all: without one, a provider that cannot answer the `GroupDraft` schema buys a
 * run per sweep forever, which is the same failure the sampling family bounds before it escalates.
 * The group path's escalation is the finding itself — it stays open in the Author's review rail with
 * its attempts visible — so the loop parks the group rather than raising a second question about
 * the same defect. That parking is also what `groupPipelineOwed` below refuses to count: a capped
 * group is parked, not owed.
 */
export const GROUP_WRITE_ATTEMPT_CAP = 2;

/**
 * What a group's attempts are counted against: its `latest` Group Revision when it has one (the text
 * a Writer pass would be rewriting), else the `phrase_groups` row the catalog created.
 *
 * The revision row rather than the group row matters because of what a RESET has to mean: the group
 * row is created once and then updated in place, so "runs created after the group row" is a count of
 * every pass the book has ever made. The revision row is created by the install, so "runs created
 * after THIS text" is the allowance the redesign wants.
 *
 * The boundary, stated because it is a number a reader will check: the pass that INSTALLED the current
 * text is not an attempt AGAINST it — its run row predates the revision row it produced — so a group
 * that was just written reads 0 and has its full pair of attempts in front of it. The cap therefore
 * counts failed passes over one text, which is the runaway it exists to bound.
 *
 * HARDENING (D-25a reset): the marker is a JOURNAL POSITION — "the event that wrote the text this group
 * holds right now" — not a row identity. With a `latest` revision that is its create event; with none,
 * it is the LAST event that wrote the group row (its create, or the `update` a Seed reset
 * (`loop/engine.ts:editSeed`) puts there: same ids (R1), empty text, revision 0, and the revision
 * history deleted with the scrapped round by `loop/invalidation.ts:scrapPhasesAfter`).
 *
 * Two reasons it has to be a position: ids cannot express "updated", and `createdAfter` resolves ids
 * through the journal's CREATE event, which for a group row always predates every write the allowance
 * is supposed to count. Counting from that create after a reset would charge every pre-reset pass
 * against the NEW Seed: a group the old Seed already passed twice would come back parked, and a book
 * with an EMPTY Overview would read as drained because a parked group is never owed (see
 * `groupPipelineOwed`). For a catalog that has never been written the last write IS its create, so
 * first-draft counting is unchanged, and the timestamp fallback keeps the same answer when the journal
 * has been trimmed.
 */
interface WriteBaseline {
    /** Journal position of the write that produced the current text, or -1 when it is no longer held. */
    seq: number;
    /** The same moment as a timestamp — the fallback `createdAfterSeq` uses when `seq` is -1. */
    created_at: string;
}

/** The journal position of the LAST event that wrote one row, whichever operation it was. */
function lastWriteSeqOf(store: Store, collection: 'phrase_groups', id: string): number {
    let seq = -1;

    for (const event of store.journal) {
        if (event.collection === collection && event.id === id && event.seq > seq) seq = event.seq;
    }

    return seq;
}

function writeBaselineOf(store: Store, group: PhraseGroup): WriteBaseline {
    // `groupRevisionHistory` sorts by number DESC, so [0] is the `latest` row (exactly one exists —
    // `phrase/revisions.ts` installs under a CAS that archives the one it replaces).
    const latest = groupRevisionHistory(store, group.id)[0];

    if (latest !== undefined) return { seq: creationSeq(store, latest.id), created_at: latest.created_at };

    return { seq: lastWriteSeqOf(store, 'phrase_groups', group.id), created_at: group.updated_at };
}

/**
 * Writer passes against a group's current text — the retry read the batch gate makes.
 *
 * Two exclusions, both of them load-bearing:
 *   * a LIVE run is not counted: R4's exclusion (`liveGroupRefs`) already holds that group for this
 *     sweep, and counting the live run here too would spend the allowance on work that is still
 *     being done; and
 *   * only a HOLDING run is counted (`isGroupHoldingRun`): reading the Overview never spends the
 *     budget for rewriting it (F1).
 *
 * Exported because the number is Author-facing: the rail shows which group has spent its allowance,
 * and a gate that cannot be read is indistinguishable from a hang. `loop/work.ts` re-exports this
 * name so the existing planner-side reads keep resolving.
 */
export function groupWriteAttempts(store: Store, story: Story, group: PhraseGroup): number {
    const baseline = writeBaselineOf(store, group);

    return store.runs.list().filter(
        (run) =>
            run.story_id === story.id &&
            !isLiveRun(run) &&
            isGroupHoldingRun(run) &&
            (run.group_refs ?? []).includes(group.id) &&
            createdAfterSeq(store, run, baseline.seq, baseline.created_at)
    ).length;
}

/**
 * One group's owed work, as the batch generator consumes it: the row, and the findings that named it.
 *
 * It is an exported type because the atomic cut below ({@link findingGroupSets} /
 * {@link planGroupDraftBatch}) takes these rows as input and returns a subset of them, so the
 * generator, the drain probe and the planner all speak one shape rather than three near-copies of it.
 */
export interface GroupWorkTarget {
    group: PhraseGroup;
    /** The open/approved findings that still owe this group a rewrite, in finding order. */
    findingRefs: string[];
}

/**
 * Which findings can drive group work — D-33's ladder plus D-34's authorised rows.
 *
 * THE ONE PREDICATE, in one place, because two reads have to agree exactly: {@link groupWorkTargets}
 * cuts the batch off these rows, and {@link planGroupDraftBatch} asks the SAME rows "does this finding
 * still owe a group that is not in the set?" to decide whether a set is whole. A finding admitted by
 * one and refused by the other would make a partial fix read as a complete one (D-66).
 */
const drivesGroupWork = (finding: Finding): boolean =>
    finding.state === 'unconfirmed' || finding.state === 'confirmed' || finding.state === 'approved';

/**
 * The groups that still owe the Overview text — the batch this sweep may write, in catalog order.
 *
 * Two reasons to write a group, and both are RECORDS rather than engine memory (L-3):
 *
 *   1. it has never been written (`revision: 0`, empty content) — first-draft work, and the only
 *      reason a brand-new group-managed Story generates anything;
 *   2. an open finding targets it and no revision of THAT group resolves it
 *      (`phrase/findings.ts:findingGroupsStillOwed`) — R3's routing, and the reason a finding about
 *      two groups buys one pass over both instead of a rewrite of all five.
 *
 * A finding with NO `group_refs` targets every group (the legacy whole-Overview meaning), so an
 * old-style complaint still routes work; it just routes more of it. The set is then cut by R4's
 * exclusion, the per-group attempt cap above, and D-66's atomic finding-set rule — none of which
 * removes a group from THIS list except the cap, which parks (see
 * `GROUP_WRITE_ATTEMPT_CAP`'s note). What this list says is OWED; what the sweep dispatches is
 * {@link planGroupDraftBatch}, which may hold a whole finding-set back because one of its groups is
 * parked or held.
 *
 * THE GROUP LOCK REMOVES A GROUP FROM THIS LIST ALTOGETHER (R-LOCK), and both halves of that matter:
 *   - a locked group is never a draft target — its text is the fixed point, and the install would
 *     refuse the write anyway (`revisions.ts:installGroupRevisions`), so offering it would spend an
 *     attempt on a batch that cannot land; and
 *   - a finding that crosses a locked group and an unlocked one still appears, with the UNLOCKED half as
 *     its whole set (`findings.ts:findingGroupsStillOwed` subtracts the locked groups), so the cross-group
 *     defect is dispatched and answered rather than parking forever on the group nobody may rewrite. A
 *     finding whose every group is locked drops out with no target at all: it drives no work, and the
 *     drain probe reads the same list, so "owed" and "done" cannot disagree about it.
 */
export function groupWorkTargets(store: Store, story: Story, phraseId?: string): GroupWorkTarget[] {
    // Scoped to ONE phrase, defaulting to the Story's PRIMARY one (the Summary) — the phrase this read
    // has always answered. With Phrase ② started, an unscoped read would offer a chapter entry to the
    // Summary's batch planner, and the Summary's answer contract has no chapter in it.
    const groups = phraseGroupsOf(store, story.id, phraseId ?? primaryPhraseOf(store, story.id)?.id);

    if (groups.length === 0) return [];

    // The findings that can drive work: OPEN rows (D-33's ladder, any cost — a minor note is still a
    // group the Author says is wrong) and D-34's `approved` rows, which are authorised fixes. A
    // `disputed`/`discarded`/`fixed` row drives nothing.
    const findings = storyFindings(store, story.id).filter(drivesGroupWork);

    // group id -> the findings it owes, in finding order. An unscoped finding lists every group, so it
    // lands on all five — and D-66 is what keeps those five in ONE pass instead of spreading them over
    // `summary_sampling` sweeps.
    const owed = new Map<string, string[]>();

    for (const finding of findings) {
        for (const group of findingGroupsStillOwed(store, story, finding)) {
            owed.set(group.id, [...(owed.get(group.id) ?? []), finding.id]);
        }
    }

    return groups
        // R-LOCK first: a locked group is not writable, whatever the findings say about it.
        .filter((group) => !isPhraseGroupLocked(group))
        .filter((group) => group.revision === 0 || owed.has(group.id))
        .filter((group) => groupWriteAttempts(store, story, group) < GROUP_WRITE_ATTEMPT_CAP)
        .map((group) => ({ group, findingRefs: owed.get(group.id) ?? [] }));
}

/**
 * D-66 — the indivisible group sets inside an owed list (R12: one defect, one pass).
 *
 * A finding that names several groups is ONE defect, and §4.10 has no "partly fixed" state, so the
 * groups it names may never be split across passes. That turns the owed list into a list of ATOMIC
 * GROUP SETS rather than a queue of groups: two targets are in the same set whenever one finding names
 * both, which is transitive — so a batch is a connected component, and overlapping findings merge
 * ({premise, promise} ∪ {promise, ending} is one set of three). A target no finding named — first-draft
 * work — is a set of ONE.
 *
 * WHY THE TARGETS' OWN REF LIST IS ENOUGH, with no extra read: `groupWorkTargets` stamps a finding id
 * onto EVERY group that finding still owes (it walks `findingGroupsStillOwed`), so a finding's whole
 * still-owed group set is exactly the set of targets carrying that id. Unioning targets that share an
 * id therefore unions findings, groups and overlapping findings in one pass.
 *
 * The sets come out ordered by their FIRST group, which is what makes the cut below deterministic: two
 * engines over the same rows take the same set first, and a restart reproduces it (L-3, L-5).
 */
export function findingGroupSets(targets: readonly GroupWorkTarget[]): GroupWorkTarget[][] {
    // Index-based union-find with path halving: the merge rule is "these two rows share a finding id",
    // and the row order (the CATALOG order `groupWorkTargets` returns) has to survive the merge.
    const parent = targets.map((_, index) => index);
    const rootOf = (index: number): number => {
        let cursor = index;

        while (parent[cursor] !== cursor) {
            parent[cursor] = parent[parent[cursor]];
            cursor = parent[cursor];
        }

        return cursor;
    };
    const merge = (left: number, right: number): void => {
        const leftRoot = rootOf(left);
        const rightRoot = rootOf(right);

        if (leftRoot === rightRoot) return;

        // The LOWER index keeps the root, so a merged set sits where its EARLIEST group sits rather
        // than hopping to wherever the later finding happened to be listed.
        if (leftRoot < rightRoot) parent[rightRoot] = leftRoot;
        else parent[leftRoot] = rightRoot;
    };

    // finding id -> the first target that named it; anything naming the same finding joins that set.
    const namedBy = new Map<string, number>();

    targets.forEach((target, index) => {
        for (const findingId of target.findingRefs) {
            const first = namedBy.get(findingId);

            if (first === undefined) namedBy.set(findingId, index);
            else merge(first, index);
        }
    });

    const sets = new Map<number, GroupWorkTarget[]>();

    targets.forEach((target, index) => {
        const root = rootOf(index);
        const bucket = sets.get(root);

        if (bucket === undefined) sets.set(root, [target]);
        else bucket.push(target);
    });

    return [...sets.values()];
}

/**
 * D-66 — the one `draft_groups` batch this sweep dispatches, as whole finding-sets.
 *
 * THE ORDER OF THE THREE RULES IS THE RULE. Each answers a different question, and D-66 sits between
 * the other two:
 *
 *   1. **R4's exclusion** — is any group of the set already held by a live Writer? Then the WHOLE set
 *      waits this sweep. §17.6 used to shrink a partially held batch (`{premise, tone}` with premise
 *      live offered `{tone}`), and that shrink IS the partial fix R12 forbids: the installed `tone`
 *      revision claims the finding while `premise` still says what the Author objected to. The deferral
 *      costs one sweep — a closed run or a lapsed lease releases the hold with no bookkeeping of ours —
 *      and a set whose groups are all free is untouched, so disjoint work still runs concurrently;
 *   2. **D-66's completeness** — does every group the set's findings still owe appear in the set? A
 *      group parked at `GROUP_WRITE_ATTEMPT_CAP` was dropped from `groupWorkTargets` before this cut,
 *      so a set missing one is a defect the loop can no longer answer WHOLE, and installing the rest
 *      would bank a partial fix under a `finding_refs` claim. The set is held back and the finding stays
 *      open with its attempts visible, which is the allowance's designed escalation (§17.6), not a new
 *      one;
 *   3. **the Author's batch dial** (`stories.summary_sampling`) — a cap BETWEEN finding-sets that
 *      YIELDS within one. Sets are taken whole, in order, while they fit; the FIRST set is taken even
 *      when it is larger than the dial, because a dial that could split a finding would put a knob
 *      above the rule that knob exists to serve. Independent sets are still rationed exactly as before,
 *      so a five-group first draft under a dial of 2 remains three passes.
 *
 * The result is re-sorted into CATALOG order (the set order is by first group, so a merged set can put
 * `ending` before a later set's `promise`). The group-set hash, the prompt's GROUPS block and the
 * install all key off that order, so it is asserted here rather than assumed.
 *
 * An empty answer means "offer nothing": every set is held, parked, incomplete, or does not fit under a
 * dial the first set already filled — and a claim key spent on an empty answer would burn an attempt
 * (`runsForItem` counts it against the family).
 *
 * A LOCKED GROUP IS OUT BEFORE THE CUT (R-LOCK): it joins no set, and the sets its findings still owe
 * are computed from the unlocked side (`findings.ts:findingGroupsStillOwed`), so rule 2's completeness
 * check is answered against the work that can actually land. That is what stops a lock from parking a
 * cross-group defect forever — the D-66 set shrinks to the groups that remain writable instead of
 * waiting on one that cannot move.
 */
export function planGroupDraftBatch(
    store: Store,
    story: Story,
    targets: readonly GroupWorkTarget[],
    phraseId?: string
): GroupWorkTarget[] {
    // R-LOCK — a locked group cannot be written, so it belongs to no set this sweep dispatches, even when
    // the caller's list still names it (a target list cut before the lock landed, or a caller that read the
    // rows mid-commit). `findingGroupsStillOwed` already keeps locked groups out of the sets this cuts, so
    // the only thing this filter can remove is a set whose install would come back refused — and a set that
    // installs nothing still spends a claim key and an attempt.
    //
    // THE CHECK IS AGAINST THE ROW, NOT THE CALLER'S COPY: `targets` is a snapshot the queue may have cut a
    // commit or two ago, and a stale snapshot is exactly the case this filter exists for — an unlocked row
    // that has since been locked. It is the same reason `installGroupRevisions` re-reads before it writes
    // (`revisions.ts`): the answer has to be about the book as it is, not as the caller saw it. A group row
    // that has vanished from the store falls back to the caller's copy, where the install's own re-read is
    // what refuses it.
    const current = new Map(phraseGroupsOf(store, story.id).map((group) => [group.id, group] as const));
    const writable = targets.filter(
        (target) => !isPhraseGroupLocked(current.get(target.group.id) ?? target.group)
    );

    if (writable.length === 0) return [];

    const held = liveGroupRefs(store, story.id, phraseId ?? primaryPhraseOf(store, story.id)?.id);
    const batchSize = Math.max(1, samplingSizeOf(story));

    // finding id -> the groups it STILL owes. Read from the FINDINGS, not from `targets`: the question
    // D-66 asks is about the defect ("does anything it names remain unwritten?"), while `targets` is
    // this sweep's trimmed candidate list, with parked groups already removed.
    const stillOwed = new Map<string, string[]>();

    for (const finding of storyFindings(store, story.id)) {
        if (!drivesGroupWork(finding)) continue;

        stillOwed.set(
            finding.id,
            findingGroupsStillOwed(store, story, finding).map((group) => group.id)
        );
    }

    const batch: GroupWorkTarget[] = [];

    for (const set of findingGroupSets(writable)) {
        const ids = new Set(set.map((target) => target.group.id));

        // 1. R4 — a live Writer holds one of the set's groups: the set waits, whole.
        if (set.some((target) => held.has(target.group.id))) continue;

        // 2. D-66 — the set must be the WHOLE still-owed group set of every finding it answers.
        const incomplete = set.some((target) =>
            target.findingRefs.some((findingId) =>
                (stillOwed.get(findingId) ?? []).some((groupId) => !ids.has(groupId))
            )
        );

        if (incomplete) continue;

        // 3. The dial — a cap BETWEEN sets, never WITHIN one (so the first set fits whatever its size).
        if (batch.length > 0 && batch.length + set.length > batchSize) break;

        batch.push(...set);
    }

    return batch.sort((left, right) => phraseGroupRank(left.group.key) - phraseGroupRank(right.group.key));
}

// ---------------------------------------------------------------------------
// The structured review seat's ledger reads (W5 — resultless seats re-arm)
// ---------------------------------------------------------------------------

/**
 * The attempt ceiling of ONE vector's structured review family (W5).
 *
 * WHY A CEILING AT ALL: before W5 a seat was paid by ANY run row — a `torn_down` answer or a pass killed
 * at `run/executor.ts:STRUCTURED_REQUEST_MAX_MS` with `tokens: 0` paid it the same. Measured on the Bird
 * Brain store: 16 `wi_review_groups_*` runs, 3 of them `abandoned`, and 13 `sample_reviews` rows — so
 * exactly the three dead passes left NOTHING on the record and the vector kept only 2 of its 5 Critic
 * reads (`DEFAULT_SUMMARY_CRITICS`, `shared/types.ts:284`), permanently, until the group vector moved.
 * A dead provider therefore cost the book 20-60% of its review, silently.
 *
 * WHY `critics + SAMPLING_RETRY_ALLOWANCE`: it is the loop's existing answer to "the provider is not
 * answering the schema" — `records.ts:screeningCapOf` caps one draft's SCREENING family at its owed
 * passes plus the allowance, and the screening family is the same shape as this one (`critics` owed
 * passes over one artifact). Reusing the expression, rather than inventing a number, means the same
 * grace everywhere: one pass per seat plus `SAMPLING_RETRY_ALLOWANCE` retries to spend ACROSS the set.
 * For the default dial that is 5 owed seats and 3 spare attempts, so a fully dead vector costs 8 runs
 * instead of 5 — never a run per sweep, and never more than `critics` at a time (the fan-out ceiling
 * `types.ts:DEFAULT_GLOBAL_MAX_CONCURRENT` budgets is untouched: this queue is the same size it was).
 *
 * WHY FAMILY-WIDE rather than per-seat, stated because a reader will check: per-seat caps multiply
 * (5 seats × 4 = 20 runs on one dead vector). The family counter spreads one allowance over the set,
 * exactly as `records.ts:screenAttempts` does for screens, and it degrades the same way — see
 * {@link groupReviewSeatSettled}'s exhaustion clause.
 */
export const groupReviewAttemptCap = (critics: number): number => critics + SAMPLING_RETRY_ALLOWANCE;

/**
 * The structured review seat's claim key — the SAME spelling `loop/work.ts:phase1GroupCandidates`
 * builds its candidate with and `api/projections.ts` counts closed runs under. A seat is keyed by the
 * GROUP VECTOR, so an install re-arms every seat by itself (the redesign's replacement for screening
 * N candidates); the literals cannot drift because the generator and this builder are pinned to one
 * shape by `loop/phase1-groups-restart.test.ts` and the projection test.
 *
 * W5 KEEPS THE KEY EXACTLY AS IT IS while letting a dead seat run again, and that is deliberate: the
 * seat's identity is the `(vector, pass)` pair, not the attempt, and three readers parse or count the
 * key by that shape (`api/projections.ts:1945`'s family count, `GROUP_PIPELINE_RUN_PREFIXES`, and the
 * dashboard's seat view). Appending an attempt segment — the sampler's `claimKey(prefix, attempts + 1)`
 * idiom — would have moved all three. A retry is a SECOND RUN ROW under the same key, which is what
 * `runsForItem` already reads and what `records.ts:isReportedRun` grades.
 */
export const groupReviewSeatKey = (vectorHash: string, pass: number): string =>
    `${GROUP_REVIEW_ITEM_PREFIX}_${vectorHash}_${pass}`;

/** One vector's whole structured review family, prefix form — the anchor `records.ts:screenPrefixOf` uses. */
export const groupReviewSeatFamily = (vectorHash: string): string => `${GROUP_REVIEW_ITEM_PREFIX}_${vectorHash}_`;

/**
 * How many CLOSED passes this vector's review family has spent — the retry counter W5 arms on.
 *
 * Counted over the FAMILY (`wi_review_groups_<hash>_`, every pass) and not per seat, because the cap
 * above is a family budget. Live rows are excluded: a seat in flight has not failed yet, and `records.ts
 * :isClaimed` is what stops the same seat being dispatched twice (so an attempt is only ever counted
 * once it has an outcome). Story scoping follows `runsForItem` exactly as this family counted before
 * W5 — the vector hash is the scope, the same content-derived anchor every other read here uses.
 */
export const groupReviewAttempts = (store: Store, vectorHash: string): number => {
    const family = groupReviewSeatFamily(vectorHash);

    return store.runs
        .list()
        .filter((run) => (run.work_item_ref ?? '').startsWith(family) && !isLiveRun(run)).length;
};

/**
 * Whether one seat brought an ANSWER back, as opposed to having once been tried (W5).
 *
 * This is the predicate that was missing: the generator used to ask "does a run row exist?"
 * (`runsForItem(store, key).length > 0`), which a killed pass answers just as well as a real review.
 * `records.ts:isReportedRun` is the only state whose structured answer reached `engine.ts:1756`'s
 * `groupReview.ok` guard and therefore wrote a `sample_reviews` row.
 */
export const groupReviewSeatAnswered = (store: Store, vectorHash: string, pass: number): boolean =>
    runsForItem(store, groupReviewSeatKey(vectorHash, pass)).some(isReportedRun);

/**
 * Is one seat DONE, so the vector no longer owes it? (W5)
 *
 * Two ways, and they are the whole rule — the same pair `records.ts:isFullyScreened` states for a
 * draft's screens:
 *   1. it ANSWERED (`groupReviewSeatAnswered`), which is the normal case and is byte-identical to what
 *      the old "a run row exists" test accepted, since every healthy seat closes `torn_down`; or
 *   2. its family SPENT THE CAP (`groupReviewAttempts ≥ groupReviewAttemptCap`) — the degrade path. A
 *      provider that answers `GroupReview` never again is not fixed by a ninth pass; without this
 *      clause, tightening the gate would strand the vector forever: the review seats would stay owed,
 *      the deep cross-group pass (`work.ts` leg 3) would never arm, and the drain would hold on work
 *      the loop can no longer buy. Exhaustion therefore SETTLES the seat, and the dead passes are
 *      visible on the ledger as the `abandoned`/`failed` rows the count reads.
 *
 * A live run satisfies NEITHER clause, which is right: a seat that is still deciding has produced
 * nothing yet, and `candidate()`'s own `isClaimed` guard (`work.ts:612`) is what keeps the in-flight
 * seat off the queue — one row per seat per sweep, never two.
 */
export const groupReviewSeatSettled = (store: Store, vectorHash: string, critics: number, pass: number): boolean =>
    groupReviewSeatAnswered(store, vectorHash, pass) ||
    groupReviewAttempts(store, vectorHash) >= groupReviewAttemptCap(critics);

/**
 * Whether every structured review seat of one vector is DONE — answered, or out of attempts (W5).
 *
 * Renamed on 2026-11-26 because the name it had asked for a RUN, and a run is not a result — that is
 * what made the bug comfortable. The deep cross-group pass is armed by this, so a vector whose three
 * seats died at the request-liveness ceiling no longer reaches its tool-carrying review on the strength
 * of rows that filed nothing — it waits for the retries, or accepts the exhausted set (clause 2).
 */
export function allReviewSeatsReported(store: Store, vectorHash: string, critics: number): boolean {
    for (let pass = 1; pass <= critics; pass += 1) {
        if (!groupReviewSeatSettled(store, vectorHash, critics, pass)) return false;
    }

    return true;
}

// ---------------------------------------------------------------------------
// The drain probe's and the sign-off gate's reads (HARDENING)
// ---------------------------------------------------------------------------

/**
 * The structured review seat's claim-key family (`loop/work.ts` legs 2 and 3, both phrases).
 *
 * Named so the three readers of this family spell it once: {@link groupReviewSeatKey} builds a seat,
 * {@link groupReviewSeatFamily} builds the prefix the retry counter scans, and
 * `GROUP_PIPELINE_RUN_PREFIXES` below lists it for the in-flight read. `api/projections.ts:1945` still
 * interpolates the literal itself, because a projection is not part of this vocabulary.
 */
export const GROUP_REVIEW_ITEM_PREFIX = 'wi_review_groups';

/** The deep cross-group review seat's claim-key family — §6.4 step 6, the tool-carrying pass (R5). */
export const GROUP_CHECK_ITEM_PREFIX = 'wi_group_check';

/** The deep cross-group review seat's claim key — §6.4 step 6, the tool-carrying pass (R5). */
export const groupCheckSeatKey = (vectorHash: string, pass: number): string =>
    `${GROUP_CHECK_ITEM_PREFIX}_${vectorHash}_${pass}`;

/**
 * The group vector a deep-review seat was claimed against, read back off the claim key (D-67).
 *
 * `wi_group_check_<vectorHash>_<pass>` carries the pass number at the END, so the hash is everything
 * between the family prefix and the LAST underscore — not the first one. A 16-hex vector hash never
 * contains an underscore, so the last separator is unambiguous, and anchoring on the family prefix
 * keeps a legacy deep-review key (`wi_review_<revision>_a<pass>`, §16) out of the group reading: an
 * unrecognised key answers `''`, which every caller treats as "this run reviewed no vector" and
 * therefore stamps nothing.
 *
 * This is the read the Clean stamp hangs on (`phrase/reviewed.ts:stampCleanRevisions`): the verdict
 * belongs to the COMBINATION the Critic was shown, and the claim key is the only record of that
 * combination once the run has closed.
 */
export const groupCheckVectorHashOf = (claimKey: string): string => {
    if (!claimKey.startsWith(`${GROUP_CHECK_ITEM_PREFIX}_`)) return '';

    const rest = claimKey.slice(GROUP_CHECK_ITEM_PREFIX.length + 1);
    const split = rest.lastIndexOf('_');

    return split <= 0 ? rest : rest.slice(0, split);
};

/**
 * One vector's whole deep-review family, prefix form — the anchor the attempt counter below scans and
 * the rail counts DISTINCT seats under (MAJOR 3, 2026-11-26).
 *
 * The trailing `_` is the same family anchor `records.ts:screenPrefixOf` insists on: the pass number is
 * a counter, so `…_1` must not also match `…_10`.
 */
export const groupCheckSeatFamily = (vectorHash: string): string => `${GROUP_CHECK_ITEM_PREFIX}_${vectorHash}_`;

/**
 * Did one DEEP-REVIEW seat actually bring a report back? (MAJOR 3 — the deep family's answer read.)
 *
 * WHY `isReportedRun` IS NOT ENOUGH HERE, which is the whole of the defect this closes: the structured
 * seats answer in ONE structured turn, so `torn_down` (the state `run/executor.ts` writes from its
 * success branch) implies the answer validated and `loop/engine.ts` persisted it — that is
 * `records.ts:isReportedRun`'s evidence, and W5 gates the structured family on it. A deep pass is
 * TOOL-CARRYING: its success branch is reached whenever the session simply ENDED, and `torn_down` says
 * nothing about whether the pass ever filed. Measured in `run/plugins/critic-termination.ts`'s own
 * header, this pass runs 6-17 minutes and 200k-380k tokens, and the plugin exists because a Critic that
 * runs out of turns used to close `torn_down` with nothing on the record. So this family needs the
 * REPORT, not the state.
 *
 * WHAT COUNTS AS THE REPORT: a `verdicts` row the seat's own run filed. `submitVerdict` is the ONE call
 * that ENDS a Critic pass and it carries the review's verdict lines AND its findings
 * (`run/plugins/critic-termination.ts:CRITIC_TERMINAL_REPORT_TOOLS`, and the deep-review notes in
 * `loop/work.ts` say "File ONE submitVerdict"), while a critic that only filed `raiseFinding` "has
 * reported something but has NOT concluded" by that plugin's own wording — so a verdict row is the
 * evidence the pass concluded, and a finding without one is a pass that stopped mid-report. Attribution
 * is the row's own `run_ref`, the join `records.ts:wholeStoryVerdicts` already uses; no journal scan and
 * no new field, so the read survives a restart off rows the product already writes.
 *
 * SCOPED BY STORY ON PURPOSE: `runsForItem` is key-scoped (see `records.ts:isClaimed`'s S-RUNTIME note),
 * and the vector hash makes a cross-book collision practically impossible, but this predicate is called
 * from a projection that is Story-scoped, so it answers the same question at the same scope rather than
 * a wider one.
 */
export const groupCheckSeatAnswered = (store: Store, storyId: string, claimKey: string): boolean => {
    const runIds = new Set(
        runsForItem(store, claimKey)
            .filter((run) => run.story_id === storyId)
            .map((run) => run.id)
    );

    if (runIds.size === 0) return false;

    return store.verdicts
        .list()
        .some(
            (verdict) =>
                verdict.story_id === storyId &&
                verdict.run_ref !== undefined &&
                verdict.run_ref !== null &&
                runIds.has(verdict.run_ref)
        );
};

/**
 * The attempt ceiling of ONE vector's deep-review family (MAJOR 3).
 *
 * `critics + SAMPLING_RETRY_ALLOWANCE` — the identical expression `groupReviewAttemptCap` uses for the
 * structured seats and `records.ts:screeningCapOf` uses for a draft's screens: one pass per seat plus
 * `SAMPLING_RETRY_ALLOWANCE` retries to spend ACROSS the set, not a fresh allowance per seat (per-seat
 * caps multiply: 5 seats × 4 = 20 deep passes on one dead vector).
 *
 * WHY THE CEILING MATTERS MORE HERE THAN DOWNSTREAM: this is the expensive family — 6-17 minutes and
 * 200k-380k tokens a pass (`run/plugins/critic-termination.ts` header; 12 deep passes were 86.8% of one
 * run's tokens). On the default dial the healthy vector buys 5 passes (≈30-85 min); a vector whose
 * provider keeps closing without filing spends at most 5 + 3 = 8 passes (≈48-136 min) before the family
 * is parked, instead of one 6-17 minute pass every sweep forever. Fan-out is unchanged: one candidate
 * per seat per sweep, and `loop/work.ts:candidate`'s `isClaimed` guard drops a seat whose run is live.
 */
export const groupCheckAttemptCap = (critics: number): number => critics + SAMPLING_RETRY_ALLOWANCE;

/**
 * How many CLOSED passes this vector's deep family has spent — the retry counter MAJOR 3 arms on.
 *
 * FAMILY-wide and not per seat, because the ceiling above is a family budget (the same shape as
 * `groupReviewAttempts` reads for the structured seats); live rows are excluded because a seat in flight
 * has not failed yet. Story scoping follows `runsForItem`, exactly as the sibling family counts: the
 * vector hash is the scope.
 */
export const groupCheckAttempts = (store: Store, vectorHash: string): number => {
    const family = groupCheckSeatFamily(vectorHash);

    return store.runs
        .list()
        .filter((run) => (run.work_item_ref ?? '').startsWith(family) && !isLiveRun(run)).length;
};

/**
 * Is one deep-review seat DONE, so the vector no longer owes it? (MAJOR 3)
 *
 * The SAME pair of clauses `groupReviewSeatSettled` states for the structured seats, so the two review
 * families finally degrade the same way:
 *   1. it PRODUCED A REPORT ({@link groupCheckSeatAnswered} — a verdict row its own run filed), or
 *   2. its family SPENT THE CAP (`groupCheckAttempts ≥ groupCheckAttemptCap`) — the degrade path, so a
 *      provider that keeps ending the session without filing parks the vector rather than buying a
 *      6-17 minute pass every sweep, and the sign-off and the drain cannot strand on it.
 *
 * WHAT THIS REPLACES, stated because the parity claim in `loop/status.ts` depends on it: the gate used to
 * settle a deep seat on ANY CLOSED row (`runsForItem(key).length > 0` in `loop/work.ts`, and `closedOn`
 * here), which a capped or abandoned pass that filed nothing paid just as well — while the Author's rail
 * counted that seat as NOT reviewed. One dead deep pass therefore printed "0 of 5 deep reviews" beside a
 * `phase_signoff` offer with nothing owed. Both readers now call THIS function's predicate.
 */
export const groupCheckSeatSettled = (
    store: Store,
    storyId: string,
    vectorHash: string,
    critics: number,
    pass: number
): boolean =>
    groupCheckSeatAnswered(store, storyId, groupCheckSeatKey(vectorHash, pass)) ||
    groupCheckAttempts(store, vectorHash) >= groupCheckAttemptCap(critics);

/**
 * The Reader's section-score seat's claim key (D-65) — ONE seat per group vector, not one per pass.
 *
 * Same re-arm rule as its two siblings above: the key names the GROUP VECTOR, so an install moves the
 * vector and the scoring run becomes owed again by itself, and a restart re-derives the key from the
 * rows with no bookkeeping of ours (L-3). It takes no `pass` argument because the Author's Critic dial
 * does not size it — one Reader reads the whole Overview and scores all five sections in one answer.
 * Owned here for the usual reason: the generator (`loop/work.ts`), the projection
 * (`api/projections.ts`) and this module's own owed-count all name the same family, and a literal
 * spelled three ways is the bug this file already exists to prevent.
 */
/** The scoring seat's claim-key family — the prefix `status.ts` recognises a live scoring run by. */
export const SECTION_SCORE_ITEM_PREFIX = 'wi_summary_score';

export const sectionScoreClaimKey = (vectorHash: string): string => `${SECTION_SCORE_ITEM_PREFIX}_${vectorHash}`;

/**
 * The group vector a scoring seat was claimed against, read back off the claim key (D-65).
 *
 * WHY READ FROM THE KEY AND NOT RE-DERIVED AT SETTLEMENT: the score is a judgement of the text that
 * was in front of the Reader, and a Writer install can move the vector WHILE the pass runs. Stamping
 * the settled vector onto that answer would file an old judgement under a new book, so the engine
 * settles against the hash the job was claimed under — which is the same reason
 * `parseGroupDraftAnswer` validates against `item.groupRefs` rather than against the current rows.
 */
export const sectionScoreVectorHashOf = (claimKey: string): string =>
    claimKey.startsWith(`${SECTION_SCORE_ITEM_PREFIX}_`)
        ? claimKey.slice(SECTION_SCORE_ITEM_PREFIX.length + 1)
        : claimKey;

/**
 * The claim-key prefixes of every group-pipeline job. The drain probe counts in-flight runs with
 * this; the trailing `_` is the same family anchor the draft-key reader above insists on.
 *
 * `wi_summary_score_` joins the list: a scoring run IS in-flight group-pipeline work (it reads the
 * installed Overview), so a drain that ignored it would report a settled book while a Reader thread
 * is still open. It does NOT join `GROUP_HOLDING_KINDS` — a score writes no group — and it does not
 * join `groupPipelineOwed`'s owed counts, which answer "does the BOOK still owe work?" for the
 * sign-off gate; a scoring pass never holds sign-off (D-65: display-only).
 */
export const GROUP_PIPELINE_RUN_PREFIXES = [
    `${GROUP_DRAFT_ITEM_PREFIX}_`,
    `${GROUP_REVIEW_ITEM_PREFIX}_`,
    `${GROUP_CHECK_ITEM_PREFIX}_`,
    `${SECTION_SCORE_ITEM_PREFIX}_`
] as const;

/** Whether a run row belongs to the group pipeline (draft batch, structured seat, or deep review). */
export const isGroupPipelineRun = (run: Run): boolean => {
    const key = run.work_item_ref ?? '';

    return GROUP_PIPELINE_RUN_PREFIXES.some((prefix) => key.startsWith(prefix));
};

/** What the group pipeline still owes, per job family — `0` means that family is not owed work. */
export interface GroupPipelineOwed {
    /** Groups with first-draft or finding-driven work inside the attempt cap (parked groups: no). */
    drafts: number;
    /** Structured Critic seats at the CURRENT vector with no ANSWER yet and attempts still in hand (W5). */
    structuredReviews: number;
    /** Deep-review seats at the CURRENT vector with no REPORT yet and attempts still in hand (MAJOR 3). */
    deepReviews: number;
}

/**
 * "What does the group pipeline still owe?" — the read behind the drain lines (§6.7) and the phase-①
 * sign-off gate, built from EXACTLY the generator's rules so the probe and the queue can never tell
 * two stories (the same argument `researchGate` makes for the sampling pipeline):
 *
 *   * a structured seat is owed while it has produced no ANSWER and still has attempts in hand — W5
 *     tightened this from "no CLOSED run", because a pass killed at the request-liveness ceiling closes
 *     a run row and brings back nothing, and a drain that called that paid would sign off an Overview
 *     read by fewer Critics than the dial asked for. The evidence rule is the SAME one
 *     `records.ts:deepReviewPassesOwed` applies to the legacy deep review (a live row has not REPORTED)
 *     plus `records.ts:isFullyScreened`'s exhaustion clause, so a dead provider parks the vector rather
 *     than holding the drain forever — and the queue this count describes is `groupReviewSeatSettled`,
 *     the generator's own predicate, not a second opinion on it;
 *   * a deep seat is owed while it has produced NO REPORT and its family still has attempts in hand —
 *     MAJOR 3 (2026-11-26) replaced "no CLOSED run" here, because a tool-carrying pass that was capped or
 *     abandoned closes a run row and files NOTHING, and a drain that called that paid signed off an
 *     Overview the rail still showed as unreviewed. The evidence rule is
 *     {@link groupCheckSeatAnswered} (a `verdicts` row the seat's own run filed — `submitVerdict` is the
 *     one call that ends a Critic pass and carries its verdicts and findings) plus
 *     {@link groupCheckAttemptCap}'s exhaustion clause, so a dead provider parks the vector rather than
 *     holding the drain forever, exactly as the structured clause above does;
 *   * the deep seats are owed only once every structured seat of the same vector is settled, which
 *     is the generator's own `allReviewSeatsReported` gate, not a second opinion on it;
 *   * a capped (parked) group is NOT owed — the loop parks it and the open finding IS the escalation
 *     (see the allowance's note), so the drain must not hold on work the design refused to buy.
 *
 * The caller (`loop/status.ts`) composes the sentences; this answers the counts.
 */
export function groupPipelineOwed(store: Store, story: Story, phraseId?: string): GroupPipelineOwed {
    // Scoped to ONE phrase, defaulting to the PRIMARY one. The counts are per-phrase facts — the drain's
    // sentence about a Summary that still owes a draft must not count a chapter entry.
    const groups = phraseGroupsOf(store, story.id, phraseId ?? primaryPhraseOf(store, story.id)?.id);

    if (groups.length === 0) return { drafts: 0, structuredReviews: 0, deepReviews: 0 };

    const drafts = groupWorkTargets(store, story, phraseId).length;

    // No installed text means nothing to review: the seats only open once a group has a revision
    // (`hasText` in the generator), and the drafts line above already says what is owed.
    if (!groups.some((group) => group.revision > 0)) return { drafts, structuredReviews: 0, deepReviews: 0 };

    const critics = screeningSizeOf(story);
    // The ONE vector this phrase's seats key on: the primary phrase's when the caller names none, so the
    // Summary's review seats keep hashing the same five-group combination they always did.
    const vectorHash = groupVectorHash(groupRevisionVector(store, story.id, phraseId));

    let structuredReviews = 0;

    // W5: owed = the seat has no ANSWER and the family has attempts left — the SAME predicate
    // `loop/work.ts` legs 2 and 3 arm on, so the drain can never report an owed pass the queue has
    // stopped offering (a seat at the cap is parked, and the drain must not hold on parked work).
    for (let pass = 1; pass <= critics; pass += 1) {
        if (!groupReviewSeatSettled(store, vectorHash, critics, pass)) structuredReviews += 1;
    }

    if (structuredReviews > 0) return { drafts, structuredReviews, deepReviews: 0 };

    let deepReviews = 0;

    // MAJOR 3: the deep family is read with the GENERATOR's own predicate, the same pair of clauses the
    // structured seats above use — ANSWERED (a verdict row the seat's run filed) or out of attempts. The
    // `closedOn` read this replaces called a capped/abandoned deep pass paid, which is how a vector ended
    // with `deepReviews: 0` while the rail still showed the seat as never reviewed.
    for (let pass = 1; pass <= critics; pass += 1) {
        if (!groupCheckSeatSettled(store, story.id, vectorHash, critics, pass)) deepReviews += 1;
    }

    return { drafts, structuredReviews, deepReviews };
}
