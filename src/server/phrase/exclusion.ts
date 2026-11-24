// SUMMARY PHRASE — the Writer exclusion (R4).
//
// THE RULE, exactly: at most ONE live Writer operation per group. Two Writer batches whose group
// sets are DISJOINT run at the same time (that is the parallelism the redesign buys: Premise and
// Tone can be revised in one sweep without waiting on each other); a batch whose set OVERLAPS a
// live one is deferred, because two live writers on one group would race the compare-and-swap on
// the group row and — worse — would each install a revision on top of the other's, silently
// archiving text that the second writer never saw.
//
// WHY IT IS DERIVED FROM THE BOOK AND NOT FROM A SEMAPHORE (R4): the loop is amnesiac by design
// (L-3: "the rows are the state"), so an in-memory set of held groups would be wrong in both
// directions after a restart — it would forget groups that are still being written and it would
// hold groups whose run died with the process. This module therefore reads the SAME live `runs`
// rows the sweep already walks when it sweeps for expired leases (`loop/records.ts:liveRuns`, L-2),
// and the group set from `Run.group_refs`, which `run/executor.ts` copies off the Work Item when the
// row is created. A lease expiry, a kill, and a restart all change the answer here with no
// bookkeeping of ours, because the run row IS the bookkeeping.
import type { Run, PhraseGroup, Story } from '../../shared/types';
import type { Store } from '../store';
// HARDENING (drain/sign-off parity): the group pipeline's write-allowance, target set and review
// seats now READ from here rather than duplicating — the counters below need the same run reads the
// exclusion makes (`createdAfter`/`isLiveRun`/`runsForItem`) and the same Author dials.
import { createdAfterSeq, creationSeq, isLiveRun, liveRuns, runsForItem, screeningSizeOf, storyFindings } from '../loop/records';
import { phraseGroupsOf } from './catalog';
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
 * predicate recognises: a `review_groups` or deep-review run carries `group_refs` (its Reader judged all
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
export function liveGroupSets(store: Store, storyId: string): string[][] {
    const live = liveRuns(store, storyId).filter(isGroupHoldingRun);

    if (live.length === 0) return [];

    const all = phraseGroupsOf(store, storyId).map((group) => group.id);

    return live.map((run) => {
        const refs = Array.isArray(run.group_refs) ? run.group_refs.filter((ref) => typeof ref === 'string') : [];

        return refs.length > 0 ? refs : all;
    });
}

/** The union of every held group id — the fast answer generation and dispatch both ask for. */
export function liveGroupRefs(store: Store, storyId: string): Set<string> {
    const held = new Set<string>();

    for (const set of liveGroupSets(store, storyId)) for (const id of set) held.add(id);

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
export function heldGroupRefs(store: Store, storyId: string, groupRefs: readonly string[]): string[] {
    const held = liveGroupRefs(store, storyId);

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
 * Deterministic and clock-free by construction: the answer is a function of the run rows, so a
 * restart reproduces it exactly (L-3), and two engines asking in the same instant agree (L-5).
 */
export function partitionGroupRefs(
    store: Store,
    storyId: string,
    groupRefs: readonly string[]
): { free: string[]; deferred: string[] } {
    const held = heldGroupRefs(store, storyId, groupRefs);
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
    groups: readonly PhraseGroup[]
): { free: PhraseGroup[]; deferred: PhraseGroup[] } {
    const held = liveGroupRefs(store, storyId);

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
 *      (their Reader judged all five groups) yet install nothing, so they are excluded by the same
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
 * exclusion, the per-group attempt cap above, and the Author's batch size — none of which removes a
 * group from THIS list except the cap, which parks (see `GROUP_WRITE_ATTEMPT_CAP`'s note).
 */
export function groupWorkTargets(store: Store, story: Story): { group: PhraseGroup; findingRefs: string[] }[] {
    const groups = phraseGroupsOf(store, story.id);

    if (groups.length === 0) return [];

    // The findings that can drive work: OPEN rows (D-33's ladder, any cost — a minor note is still a
    // group the Author says is wrong) and D-34's `approved` rows, which are authorised fixes. A
    // `disputed`/`discarded`/`fixed` row drives nothing.
    const findings = storyFindings(store, story.id).filter(
        (finding) =>
            finding.state === 'unconfirmed' || finding.state === 'confirmed' || finding.state === 'approved'
    );

    // group id -> the findings it owes, in finding order. An unscoped finding lists every group, so
    // it lands on all five and the batch cap is what keeps the pass affordable.
    const owed = new Map<string, string[]>();

    for (const finding of findings) {
        for (const group of findingGroupsStillOwed(store, story, finding)) {
            owed.set(group.id, [...(owed.get(group.id) ?? []), finding.id]);
        }
    }

    return groups
        .filter((group) => group.revision === 0 || owed.has(group.id))
        .filter((group) => groupWriteAttempts(store, story, group) < GROUP_WRITE_ATTEMPT_CAP)
        .map((group) => ({ group, findingRefs: owed.get(group.id) ?? [] }));
}

/** Whether every structured review seat of one vector has already produced a run row. */
export function allReviewSeatsRun(store: Store, vectorHash: string, readers: number): boolean {
    for (let pass = 1; pass <= readers; pass += 1) {
        if (runsForItem(store, groupReviewSeatKey(vectorHash, pass)).length === 0) return false;
    }

    return true;
}

// ---------------------------------------------------------------------------
// The drain probe's and the sign-off gate's reads (HARDENING)
// ---------------------------------------------------------------------------

/**
 * The structured review seat's claim key — the SAME spelling `loop/work.ts:phase1GroupCandidates`
 * builds its candidate with and `api/projections.ts` counts closed runs under. A seat is keyed by the
 * GROUP VECTOR, so an install re-arms every seat by itself (the redesign's replacement for screening
 * N candidates); the literals cannot drift because the generator and this builder are pinned to one
 * shape by `loop/phase1-groups-restart.test.ts` and the projection test.
 */
export const groupReviewSeatKey = (vectorHash: string, pass: number): string =>
    `wi_review_groups_${vectorHash}_${pass}`;

/** The deep cross-group review seat's claim key — §6.4 step 6, the tool-carrying pass (R5). */
export const groupCheckSeatKey = (vectorHash: string, pass: number): string =>
    `wi_group_check_${vectorHash}_${pass}`;

/**
 * The claim-key prefixes of every group-pipeline job. The drain probe counts in-flight runs with
 * this; the trailing `_` is the same family anchor the draft-key reader above insists on.
 */
export const GROUP_PIPELINE_RUN_PREFIXES = [
    `${GROUP_DRAFT_ITEM_PREFIX}_`,
    'wi_review_groups_',
    'wi_group_check_'
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
    /** Structured Reader seats at the CURRENT vector without a CLOSED run yet. */
    structuredReviews: number;
    /** Deep-review seats at the current vector, owed only once every structured seat has reported. */
    deepReviews: number;
}

/**
 * "What does the group pipeline still owe?" — the read behind the drain lines (§6.7) and the phase-①
 * sign-off gate, built from EXACTLY the generator's rules so the probe and the queue can never tell
 * two stories (the same argument `researchGate` makes for the sampling pipeline):
 *
 *   * a seat is owed while it has no CLOSED run — the evidence rule `records.ts:deepReviewPassesOwed`
 *     already applies to the legacy deep review: a seat whose run is still live has not REPORTED, so
 *     the sign-off must not proceed over it (and the in-flight line names the live run meanwhile);
 *   * the deep seats are owed only once every structured seat of the same vector has reported, which
 *     is the generator's own `allReviewSeatsRun` gate, not a second opinion on it;
 *   * a capped (parked) group is NOT owed — the loop parks it and the open finding IS the escalation
 *     (see the allowance's note), so the drain must not hold on work the design refused to buy.
 *
 * The caller (`loop/status.ts`) composes the sentences; this answers the counts.
 */
export function groupPipelineOwed(store: Store, story: Story): GroupPipelineOwed {
    const groups = phraseGroupsOf(store, story.id);

    if (groups.length === 0) return { drafts: 0, structuredReviews: 0, deepReviews: 0 };

    const drafts = groupWorkTargets(store, story).length;

    // No installed text means nothing to review: the seats only open once a group has a revision
    // (`hasText` in the generator), and the drafts line above already says what is owed.
    if (!groups.some((group) => group.revision > 0)) return { drafts, structuredReviews: 0, deepReviews: 0 };

    const readers = screeningSizeOf(story);
    const vectorHash = groupVectorHash(groupRevisionVector(store, story.id));
    const closedOn = (key: string): boolean => runsForItem(store, key).some((run) => !isLiveRun(run));

    let structuredReviews = 0;

    for (let pass = 1; pass <= readers; pass += 1) {
        if (!closedOn(groupReviewSeatKey(vectorHash, pass))) structuredReviews += 1;
    }

    if (structuredReviews > 0) return { drafts, structuredReviews, deepReviews: 0 };

    let deepReviews = 0;

    for (let pass = 1; pass <= readers; pass += 1) {
        if (!closedOn(groupCheckSeatKey(vectorHash, pass))) deepReviews += 1;
    }

    return { drafts, structuredReviews, deepReviews };
}
