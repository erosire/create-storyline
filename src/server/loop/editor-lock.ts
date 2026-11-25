// PHRASE GROUP LOCK — the EDITOR's lock seat: its claim key, its evidence, its answer contract and the
// guard its settlement re-runs (R-lock / R3, `Story.editor_group_locking`).
//
// WHY THIS MODULE EXISTS AS ITS OWN FILE: the whole feature is ONE judgement with four moving parts,
// and every part has to read the book the same way. The generator (`loop/work.ts` candidate 2c) arms a
// seat from {@link editorLockSeatTargets}; the prompt compiler (`run/phase1-prompt.ts`) renders the
// evidence {@link editorLockEvidenceOf} assembles; the settle (`loop/engine.ts:settleJob`) parses the
// answer with {@link parseGroupLockAnswer} and re-runs {@link editorLockGuardReason} before it calls
// `phrase/locks.ts:lockPhraseGroup`. Four call sites, three of them in different modules, reading ONE
// definition of "is this section actually lockable right now" — which is exactly the argument
// `phrase/exclusion.ts` already makes for the group pipeline's other reads.
//
// WHY THE RULES ARE NOT IN `phrase/**`: `locks.ts` owns the WRITE (and it is T4's, accepted and
// unchanged); this file owns the CREW'S READ that decides whether to ask. Keeping the seat's eligibility
// here also keeps the one D-65 exception in the loop layer visible in one place: this is the ONLY place
// outside `engine.ts` where the Reader's score rows are consumed, and it consumes the RATIONALE as
// evidence for a judgement, never the number as a gate.
//
// WHAT MAKES A SEAT ELIGIBLE, in the order that costs least to ask:
//   1. `Story.editor_group_locking === true` — ABSENT means OFF, and OFF means this module produces
//      nothing at all (no candidate, no run, no lock). The same read `locks.ts` gates the write with,
//      so a Setting cannot be on for the prompt and off for the settle.
//   2. A COMPLETE clean selection (`phrase/reviewed.ts:cleanSelectionOf`) whose hash still matches this
//      group's CURRENT text. Not "the group has text": a lock fixes a revision, and the revision the
//      Editor judged has to be the revision the flag will name. A group whose newest revision is not yet
//      clean is not lockable — its newest text has never survived a cross-group pass — and the seat
//      re-arms by itself when the Clean selection ADVANCES, because the key IS that selection's hash.
//   3. A Reader score row for THIS group at EXACTLY this vector, with a non-blank rationale. The Author's
//      decision makes the Reader's reading an input to this judgement; a group nobody scored has no
//      input, so there is no seat (and no lock bought from a number the crew never wrote down).
//   4. The group is unlocked, written, and NOT held by a live Writer run — a pass still installing over
//      it would leave the flag and the text disagreeing the moment the install landed.
//   5. The seat has not been decided before: `loop/work.ts` skips a key with a closed run, so a `false`
//      answer stands until the clean selection moves (which is the same spending rule the structured
//      Critic seats use) and one lock can never spend the seat of another group on the same vector.
//
// WHAT IT NEVER DOES: no numeric threshold anywhere (the Author chose judgement over a cutoff, and
// `score` is only ever rendered as evidence); no drain, sign-off, hill or goal read (the seat is
// OPTIONAL work — `phrase/exclusion.ts:groupPipelineOwed` and `GROUP_PIPELINE_RUN_PREFIXES` do not know
// this family, and that is deliberate); no unlock, ever (`phrase/locks.ts` keeps that Author-only).
import type { Finding, GroupRevision, PhraseGroup, Story, SummaryScore } from '../../shared/types';
import type { GroupLockDecision } from '../../shared/schemas';
import {
    cleanSelectionOf,
    editorGroupLockingEnabled,
    findingGroupScope,
    isPhraseGroupLocked,
    liveGroupWriters,
    phraseGroupsOf,
    type ReviewedCompositionEntry
} from '../phrase';
import { runsForItem } from './records';
import { OPEN_FINDING_STATES } from './types';
import type { Store } from '../store';

// ---------------------------------------------------------------------------
// The claim key (seat identity)
// ---------------------------------------------------------------------------

/**
 * The Editor lock seat's claim-key family.
 *
 * It is spelled `wi_group_lock_…` rather than `wi_lock_group_…` because the family names the ARTIFACT
 * the seat is about (a group lock) in the same shape the two other vector-keyed seats spell theirs
 * (`wi_review_groups_<hash>_<pass>`, `wi_group_check_<hash>_<pass>`). Owned here, not in
 * `phrase/exclusion.ts`, because this is the only module that recognises the family — the drain probe
 * deliberately does not (see the file header).
 */
export const GROUP_LOCK_ITEM_PREFIX = 'wi_group_lock';

/**
 * One seat per GROUP per CLEAN VECTOR — `wi_group_lock_<cleanVectorHash>_<groupId>`.
 *
 * The vector hash is the CLEAN selection's (`cleanSelectionOf(...).vector_hash`), exactly like the
 * Reader's score seat, for the same reason: an advance of the reviewed Overview re-arms the seat by
 * itself, and a restart reproduces the key from the rows with no counter of ours (L-3). The group id is
 * the second half because the seat is per section: locking `premise` must not spend `tone`'s decision,
 * and five sections need five answers (one Editor pass cannot judge five sections in one turn without
 * collapsing five judgements into one).
 */
export const groupLockSeatKey = (vectorHash: string, groupId: string): string =>
    `${GROUP_LOCK_ITEM_PREFIX}_${vectorHash}_${groupId}`;

/**
 * The seat a claim key names, read back off the key: `{ vector_hash, group_id }`.
 *
 * The SPLIT IS THE FIRST underscore after the family prefix, not the last: this key puts the group id
 * at the END, and a `phrase_groups.id` is a UUID (hyphens, never underscores) while a vector hash is 16
 * hex characters (no underscore either), so the first separator after the prefix is the only one. A
 * foreign key — a review seat, a legacy deep review, a scoring pass — answers two empty strings, which
 * every caller reads as "this run decided no lock" and therefore writes nothing.
 */
export const groupLockSeatOf = (claimKey: string): { vector_hash: string; group_id: string } => {
    if (!claimKey.startsWith(`${GROUP_LOCK_ITEM_PREFIX}_`)) return { vector_hash: '', group_id: '' };

    const rest = claimKey.slice(GROUP_LOCK_ITEM_PREFIX.length + 1);
    const split = rest.indexOf('_');

    if (split <= 0 || split === rest.length - 1) return { vector_hash: '', group_id: '' };

    return { vector_hash: rest.slice(0, split), group_id: rest.slice(split + 1) };
};

/** Whether a run row belongs to an Editor lock seat (the family anchor, same rule as above). */
export const isGroupLockRunKey = (claimKey: string): boolean => groupLockSeatOf(claimKey).group_id !== '';

// ---------------------------------------------------------------------------
// The evidence one seat is built from
// ---------------------------------------------------------------------------

/**
 * Everything one lock seat is allowed to weigh, in the shapes the prompt renders.
 *
 * The three fields that make the decision POSSIBLE are `revision` (the exact text), `score` (the
 * Reader's reading of it, which is only useful as the RATIONALE — the number alone is what the Author
 * refused as a rule) and `open_claims` (the Critic's live claims, which are what "no remaining issue"
 * denies). The two peer fields make it SAFE: a locked peer's text is the law this section has to match,
 * and an unlocked peer is the side that will still move, so a section can be left unlocked without
 * holding the book hostage.
 */
export interface EditorLockEvidence {
    /** The group row, as it stands at settle time. */
    group: PhraseGroup;
    /** The CLEAN revision the seat was armed for — the text the Reader scored. */
    revision: GroupRevision;
    /** The Reader's score row for THIS group at THIS vector (non-blank rationale guaranteed). */
    score: SummaryScore;
    /** The clean selection's hash — the seat's identity, and what the settle re-checks. */
    vector_hash: string;
    /**
     * Open claims naming this group OR a locked peer (D-33c's open set: `unconfirmed`, `confirmed`,
     * `approved`, `disputed`), issues and proposals alike.
     *
     * An open ISSUE naming the target itself is normally impossible here — `cleanSelectionOf` refuses a
     * clean entry for a group an unresolved issue names — so what actually reaches the prompt is the
     * PROPOSALS (the "is a major improvement missing?" half of the question) and the claims still open
     * against the fixed point.
     */
    open_claims: Finding[];
    /** Claims naming this group that already closed (`fixed` / `discarded`) — the answered history. */
    closed_claims: Finding[];
    /** The groups already locked, with the revisions the selection stands behind — the fixed point. */
    locked_peers: ReviewedCompositionEntry[];
    /** The other UNLOCKED groups: they keep being rewritten whichever way this answer goes. */
    unlocked_peers: PhraseGroup[];
}

/**
 * The two closed finding states (§4.10's ladder; D-33c reads both as CLOSED). Named here rather than
 * imported because `loop/status.ts`'s `DISCARDABLE_*` lists answer a different question — what a verb
 * may move — and a shared list would let a future gate change quietly move what this prompt calls
 * "already answered".
 */
const CLOSED_CLAIM_STATES: Finding['state'][] = ['fixed', 'discarded'];

/**
 * How many claims one prompt renders per bucket before it says "and N more".
 *
 * Bounded because the seat is a per-group pass that runs up to five times per vector: an unbounded
 * block would put the whole finding history in front of the Editor five times. Deterministic order
 * (id ASC) keeps one state, one byte sequence (§5's cache rule).
 */
export const GROUP_LOCK_CLAIM_RENDER_CAP = 12;

/** Every group of this Story that is already locked, in catalog order. */
const lockedGroupsOf = (store: Store, storyId: string): PhraseGroup[] =>
    phraseGroupsOf(store, storyId).filter(isPhraseGroupLocked);

/**
 * Whether a finding's effective scope names `groupId`.
 *
 * THE SCOPE IS THE DOMAIN READ, not `finding.group_refs` directly (`phrase/findings.ts:findingGroupScope`):
 * an UNSCOPED finding's scope is every group of the Story — the legacy whole-Overview meaning — and an
 * Editor shown only the scoped rows would conclude "nothing is open against this section" while a
 * whole-Overview defect sits on the book.
 */
function claimNamesGroup(store: Store, story: Story, finding: Finding, groupId: string): boolean {
    return findingGroupScope(store, story, finding).refs.includes(groupId);
}

/** id ASC, so two compiles over one store render the same lines in the same order (§5's cache rule). */
const byId = (left: Finding, right: Finding): number => left.id.localeCompare(right.id);

/**
 * The evidence for one lock seat, or `undefined` when the seat is not eligible (see the file header for
 * the five conditions and why each is a condition).
 *
 * This is a PURE READ: it writes nothing and costs nothing to call, which is what lets the generator,
 * the compiler and the settle guard all ask it on the same sweep.
 */
export function editorLockEvidenceOf(
    store: Store,
    story: Story,
    groupId: string,
    selection = cleanSelectionOf(store, story)
): EditorLockEvidence | undefined {
    // 1. The Setting. Absent is OFF, and OFF means the Editor has no seat at all.
    if (!editorGroupLockingEnabled(story)) return undefined;

    // 2. The reviewed Overview has to exist, and this group's entry has to be the CURRENT text. A newer
    //    revision that is not yet clean means the newest text has never survived a cross-group pass, and
    //    `lockPhraseGroup` would fix `group.revision` — the number nobody reviewed — not the text shown.
    if (!selection.complete) return undefined;

    const entry = selection.entries.find((candidate) => candidate.group.id === groupId);

    if (entry === undefined || entry.revision.number !== entry.group.revision) return undefined;

    const group = store.phraseGroups.get(groupId);

    // 4a. Written, and not already locked. An already-locked group is the answer already given (by the
    //     Author or by an earlier pass) and `lockPhraseGroup` would only refuse it (`already_locked`).
    if (group === undefined || isPhraseGroupLocked(group) || group.revision === 0 || group.content.trim() === '') {
        return undefined;
    }

    // 3. The Reader's reading of THIS section at THIS vector. The rationale is required, not optional:
    //    the number alone is exactly the input the Author refused to make a rule out of, so a row without
    //    a reason is no evidence. Newest-by-id, because a vector that was scored twice (a re-run after a
    //    torn-down pass) must resolve to one row deterministically.
    const score = store.summaryScores
        .list()
        .filter(
            (row) =>
                row.story_id === story.id &&
                row.group_id === groupId &&
                row.vector_hash === selection.vector_hash &&
                row.rationale.trim() !== ''
        )
        .sort((left, right) => left.id.localeCompare(right.id))
        .pop();

    if (score === undefined) return undefined;

    // 4b. No live Writer over this group: an install landing while the Editor deliberates would move the
    //     text under the judgement (`phrase/exclusion.ts:liveGroupWriters` — the fail-closed read, so a
    //     live holding run that names no groups still counts as holding this one).
    if (liveGroupWriters(store, story.id, groupId).length > 0) return undefined;

    const locked = lockedGroupsOf(store, story.id);
    const lockedIds = new Set(locked.map((row) => row.id));

    const openClaims = store.findings
        .list()
        .filter(
            (finding) =>
                finding.story_id === story.id &&
                OPEN_FINDING_STATES.includes(finding.state) &&
                (claimNamesGroup(store, story, finding, groupId) ||
                    findingGroupScope(store, story, finding).refs.some((id) => lockedIds.has(id)))
        )
        .sort(byId);

    const closedClaims = store.findings
        .list()
        .filter(
            (finding) =>
                finding.story_id === story.id &&
                CLOSED_CLAIM_STATES.includes(finding.state) &&
                claimNamesGroup(store, story, finding, groupId)
        )
        .sort(byId);

    return {
        group,
        revision: entry.revision,
        score,
        vector_hash: selection.vector_hash,
        open_claims: openClaims,
        closed_claims: closedClaims,
        locked_peers: selection.entries.filter((candidate) => lockedIds.has(candidate.group.id)),
        unlocked_peers: phraseGroupsOf(store, story.id).filter(
            (candidate) => candidate.id !== groupId && !lockedIds.has(candidate.id)
        )
    };
}

/**
 * Every group a sweep may arm an Editor lock seat for, in CATALOG ORDER, with the vector the seats share.
 *
 * One `cleanSelectionOf` for the whole Story, then one eligibility read per group: the generator walks
 * five groups per sweep and the selection read is the expensive half (it walks every group's revision
 * history).
 */
export function editorLockSeatTargets(store: Store, story: Story): EditorLockEvidence[] {
    if (!editorGroupLockingEnabled(story)) return [];

    const selection = cleanSelectionOf(store, story);

    if (!selection.complete) return [];

    return phraseGroupsOf(store, story.id)
        .map((group) => editorLockEvidenceOf(store, story, group.id, selection))
        .filter((evidence): evidence is EditorLockEvidence => evidence !== undefined);
}

/**
 * Whether this Story's Editor lock seats are still owed work, or already decided, at THIS vector.
 *
 * Exported for the settle-side restart read and for the tests that pin idempotence: a seat with a CLOSED
 * run is spent, whichever way the answer went, and only an ADVANCE of the clean selection re-arms it
 * (the same spending rule the structured Critic seats use, for the same reason — the escalation is that
 * the section simply stays unlocked, which costs the book nothing).
 *
 * WHY THE SCAN IS ALSO SCOPED TO THE STORY: unlike the review seat (`wi_review_groups_<hash>_<pass>` on a
 * Story's own Summary) and the score seat (`sectionScoreSeatKey` takes `storyId` as a parameter), this key
 * carries no book id — the vector hash and the group id are all it has, and neither is guaranteed unique
 * across books. `loop/records.ts:1353` sets the precedent for reading a seat key inside one Story
 * (`runsForItem(...).some((run) => run.story_id === story.id)`), and it is the rule here too: one book's
 * judgement must never silence another book's seat. A live run counts as spent for the same reason the
 * other seats count it: the section is already being decided.
 */
export const groupLockSeatSpent = (store: Store, evidence: EditorLockEvidence): boolean =>
    runsForItem(store, groupLockSeatKey(evidence.vector_hash, evidence.group.id)).some(
        (run) => run.story_id === evidence.group.story_id
    );

// ---------------------------------------------------------------------------
// The answer, validated
// ---------------------------------------------------------------------------

/** A usable `GroupLockDecision`, or the reason the answer was refused (nothing is written either way). */
export type GroupLockDecisionResult = { ok: true; decision: GroupLockDecision } | { ok: false; refusal: string };

/**
 * Validates a `GroupLockDecision` answer against the SEAT that asked for it.
 *
 * THE SAME SPLIT every other structured contract in this package draws: the JSON Schema closes the shape
 * for the provider, and everything only knowable from the book is decided here, because the in-process
 * validator (`server/llm/structured.ts`) ignores `minLength` and cannot know which group the seat was
 * claimed for. Four refusals, in the order that names the most actionable defect first:
 *   1. no `group_ref`, or one that is not this group — the decision was made about a section the seat
 *      never showed, so nothing may be locked on the strength of it (and `expectedGroupRef` empty means
 *      the JOB was malformed, which is the loop's bug, not the model's);
 *   2. `lock` not a boolean — a string `"true"` is not a judgement the loop may freeze a section on;
 *   3. a blank `rationale` — D-15, and the requirement's own words: a lock with no reason given is
 *      refused, so no lock can ever be recorded without the sentence the Author reads;
 *   4. an id the Story does not have (an invention), which cannot be attributed to a row at all.
 *
 * A refusal costs the book NOTHING: `engine.ts:settleJob` locks only an `ok` answer whose `lock` is
 * true, and the seat's closed run retires the key, so a malformed answer leaves the section unlocked and
 * the next clean vector asks again.
 */
export function parseGroupLockAnswer(
    store: Store,
    storyId: string,
    expectedGroupRef: string,
    structured: unknown
): GroupLockDecisionResult {
    const answer = structured as Partial<GroupLockDecision> | undefined;
    const ref = typeof answer?.group_ref === 'string' ? answer.group_ref.trim() : '';
    const groups = phraseGroupsOf(store, storyId);

    if (expectedGroupRef === '') {
        return {
            ok: false,
            refusal: 'the group-lock job named no group to decide on (WorkItem.groupRefs was empty), so no answer can be attributed'
        };
    }

    const group = groups.find((candidate) => candidate.id === ref);

    if (group === undefined) {
        return {
            ok: false,
            refusal: `the lock answer named "${ref === '' ? '(no group_ref)' : ref}", which is not a group of story ${storyId} — and the seat asked about ${expectedGroupRef} (R-lock)`
        };
    }

    if (ref !== expectedGroupRef) {
        return {
            ok: false,
            refusal: `the lock answer decided ${group.key} (${ref}) while this seat was claimed for ${expectedGroupRef} — one seat decides one section, so a decision about another group is refused rather than re-attributed (R-lock)`
        };
    }

    if (typeof answer?.lock !== 'boolean') {
        return {
            ok: false,
            refusal: `the lock answer for ${group.key} carried \`lock: ${JSON.stringify(answer?.lock)}\` — a lock is a yes or a no, never a string or a number (R-lock)`
        };
    }

    const rationale = typeof answer.rationale === 'string' ? answer.rationale.trim() : '';

    if (rationale === '') {
        return {
            ok: false,
            refusal: `the lock answer for ${group.key} said ${answer.lock ? 'lock' : 'do not lock'} with no rationale — the decision has to name the claims it weighed and what settles them (D-15, R-lock)`
        };
    }

    return { ok: true, decision: { group_ref: ref, lock: answer.lock, rationale } };
}

// ---------------------------------------------------------------------------
// The guard the settlement re-runs
// ---------------------------------------------------------------------------

/**
 * Why this seat may NOT lock right now, or `undefined` when it may — re-read inside the settle commit.
 *
 * WHY RE-RUN IT AT ALL, when the generator already checked: the generator's read is from when the job
 * was QUEUED, and an Editor run is a thread that can sit behind a full capacity ceiling. In that window
 * the Author may lock the section by hand, switch the Setting off, write a new revision, or have a Writer
 * install land under the pass. `phrase/locks.ts` would refuse most of those anyway (and its
 * `PhraseLockRefusal` is caught, so a refusal can never corrupt the settle), and this guard is what makes
 * the refusal the ROUTINE outcome rather than the exception — the seat is a judgement about one specific
 * combination of Setting, text, and Reader evidence, and a judgement about a state that no longer exists
 * must not be executed.
 *
 * Every clause returns the sentence the next reader of the code (or of a future rail line) needs; the
 * caller discards it, which is honest because nothing is written on any path.
 */
export function editorLockGuardReason(
    store: Store,
    story: Story,
    claimKey: string,
    decision: GroupLockDecision
): string | undefined {
    const seat = groupLockSeatOf(claimKey);

    if (seat.group_id === '' || seat.vector_hash === '') {
        return `${claimKey} is not a group-lock seat key, so its answer locks nothing`;
    }

    // THE TARGET IDENTITY FIRST: the answer and the seat must name the same group, and that group must be
    // the one the run's Work Item carried. `parseGroupLockAnswer` already insists; this is the settle's
    // own copy of the rule, so a future caller that skips the parse cannot lock an arbitrary section.
    if (decision.group_ref !== seat.group_id) {
        return `the answer decided ${decision.group_ref} while the seat ${claimKey} was claimed for ${seat.group_id}`;
    }

    if (!editorGroupLockingEnabled(story)) {
        return `story ${story.id} has \`editor_group_locking\` off (absent = disabled), so the Editor's decision does not lock ${seat.group_id}`;
    }

    const group = store.phraseGroups.get(seat.group_id);

    if (group === undefined || group.story_id !== story.id) {
        return `${seat.group_id} is not a phrase group of story ${story.id}`;
    }

    if (isPhraseGroupLocked(group)) {
        return `${group.key} is already locked at revision ${group.locked_revision ?? group.revision}${
            group.locked_by ? ` by ${group.locked_by}` : ''
        } — a second lock would only re-date a decision the book already carries`;
    }

    if (group.revision === 0 || group.content.trim() === '') {
        return `${group.key} has no written text, so there is no revision for a lock to fix`;
    }

    // THE VECTOR, re-read now: the seat judged the selection its key hashes, and the flag is about to name
    // `group.revision`. Both halves have to agree — the selection's hash AND the clean row being the
    // current text — or the lock fixes a revision nobody reviewed.
    const selection = cleanSelectionOf(store, story);

    if (!selection.complete) {
        return `story ${story.id} has no complete reviewed Summary any more, so the clean vector ${seat.vector_hash} this seat judged is gone`;
    }

    if (selection.vector_hash !== seat.vector_hash) {
        return `the reviewed Summary moved from ${seat.vector_hash} to ${selection.vector_hash} between the seat's claim and its settle — the Editor judged a different Overview than the one the lock would fix`;
    }

    const entry = selection.entries.find((candidate) => candidate.group.id === seat.group_id);

    if (entry === undefined) return `${group.key} has no entry in the current clean selection`;

    if (entry.revision.number !== group.revision) {
        return `${group.key} is at revision ${group.revision} while the clean selection stands behind ${entry.revision.number} — the newest text was never reviewed, so it is not lockable`;
    }

    // THE READER'S READING, still present at this vector: the seat is an adjudication OVER the Reader's
    // rationale, and a score row that has been deleted (a scrap) leaves nothing to adjudicate.
    const score = store.summaryScores
        .list()
        .find(
            (row) =>
                row.story_id === story.id && row.group_id === seat.group_id && row.vector_hash === seat.vector_hash
        );

    if (score === undefined) {
        return `${group.key} has no Reader score at vector ${seat.vector_hash}, so the Editor's decision has no reading to weigh`;
    }

    if (score.rationale.trim() === '') {
        return `the Reader's score for ${group.key} carries no rationale, and a lock may not rest on a bare number (D-65's exception is a judgement over the READING)`;
    }

    const writers = liveGroupWriters(store, story.id, group.id);

    if (writers.length > 0) {
        return `${group.key} is being written by ${writers.map((run) => run.id).join(', ')} — locking under a live install would leave the flag naming a text the Writer is still replacing`;
    }

    return undefined;
}

/**
 * The one call the settle makes: "may this seat lock, and with what domain attribution?" — so the
 * engine sequences the write and this module owns every rule that decides it.
 */
export const editorLockMayLock = (
    store: Store,
    story: Story,
    claimKey: string,
    decision: GroupLockDecision | undefined
): string | undefined => {
    if (decision === undefined) return 'the run left no structured lock answer';

    return editorLockGuardReason(store, story, claimKey, decision);
};

/** A locked group, as the peer sections' prompt line renders it. */
export interface LockedPeerLine {
    group: PhraseGroup;
    revision: number;
    locked_by: string;
}

/**
 * The Story's locked groups, in catalog order, with the revision each lock fixed — the fixed point every
 * other group is revised against. The prompt renders these as the LAW; the loop already enforces them in
 * `phrase/exclusion.ts:groupWorkTargets` and `revisions.ts:installGroupRevisions`.
 */
export function lockedPeerLines(store: Store, story: Story): LockedPeerLine[] {
    return lockedGroupsOf(store, story.id).map((group) => ({
        group,
        revision: group.locked_revision ?? group.revision,
        locked_by: group.locked_by ?? 'author'
    }));
}
