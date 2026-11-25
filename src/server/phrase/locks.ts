// SUMMARY PHRASE — the group lock (lock/unlock one group's CURRENT text).
//
// WHAT A LOCK MEANS, stated once here because every other module reads it out of these two writes:
//
//   1. **The text is signed off.** The group keeps the revision it has; the lock names that revision
//      (`locked_revision`) and who fixed it (`locked_by`), so an audit can tell a lock from a later text
//      that merely carries the flag. Neither operation touches `content` and neither mints a revision —
//      a lock is a flag on the row that already holds the text, never an edit dressed up as one.
//   2. **Nothing may rewrite it.** `revisions.ts:installGroupRevisions` refuses any locked target
//      (defense in depth: a Writer batch planned before the lock can still come back after it), and
//      `exclusion.ts:groupWorkTargets` never offers a locked group, so the refusal is the guard rather
//      than the routine path.
//   3. **A finding against it is VOID for it — void, not owed.** At lock time a finding whose EVERY
//      named group is now locked becomes `discarded` (the established void state: D-33c reads
//      `fixed`/`discarded` as closed, and nothing else in §4.10's ladder says "about text that cannot
//      change"). A finding that also names an unlocked group stays open and stays workable — for the
//      unlocked groups only; `findings.ts:findingActionableScope` is the read that subtracts the locked
//      part, so a cross-group defect routes to the groups that can still move instead of parking
//      forever on the one that cannot.
//   4. **The other groups move, this one is the fixed point.** Consistency work is the unlocked side's
//      (D-66 keeps one defect in one pass, and the locked group's text is the baseline it must not
//      contradict — `reviewed.ts:cleanSelectionOf` composes the reviewed Overview over the locked text
//      for exactly that reason).
//
// WHO MAY ACT: the Author owns the lock on any group-managed Story. The Editor may lock only on a Story
// that turns `Story.editor_group_locking` on — its judgment is "Critic findings on this group are
// exhausted and the Reader's score says the text works", which is a recommendation to STOP rewriting,
// not to rewrite. Neither may unlock but the Author: lifting a lock is the decision that reopens the
// text, and a crew that just closed a defect should not be able to sign the book back out.
//
// WHY A REFUSAL RATHER THAN AN IDEMPOTENT NO-OP ON A REPEATED LOCK: `ensurePhraseCatalog`'s idempotence
// is about a READ-THAT-WRITES-NOTHING reaching the same state twice. A second lock is an Author action
// with an audit line and a timestamp, and silently re-dating a lock the Author already set is the kind
// of quiet rewrite this package refuses elsewhere (an install over an unchanged text still makes a
// revision row). `PhraseLockRefusal` carries the `code` a route maps to a 409, so the rail can say
// WHICH rule it hit rather than showing a bare sentence.
//
// WHAT THIS MODULE NEVER DOES: it never writes `content` or `revision`, never writes a
// `group_revisions` row, never touches `summary_locked` (L-7a's whole-Summary lock is a different
// decision on a different record), and never resurrects a discarded finding on unlock — a discard is
// terminal in §4.10, and an unlock that un-discarded one would be inventing work the Author already
// watched close.
import type { FindingState, PhraseGroup, PhraseGroupLockActor, Story } from '../../shared/types';
import { nowIso } from '../tools/utilities';
import type { Attribution, Store } from '../store';
import { isPhraseGroupLocked, phraseGroupsOf } from './catalog';
import { findingGroupScope } from './findings';

// ---------------------------------------------------------------------------
// The refusal (a route maps every one of these to a 409 that names the rule)
// ---------------------------------------------------------------------------

/** Why a lock or unlock was refused. Every value is a distinct sentence the Author can act on. */
export type PhraseLockRefusalCode =
    /** The `:groupId` is not one of this Story's groups (an invented id, or another Story's group). */
    | 'group_not_found'
    /** The group has no written text, so there is no revision for a lock to fix. */
    | 'group_unwritten'
    /** It is already locked — the Author's unlock is the move that reopens it. */
    | 'already_locked'
    /** An unlock was asked for on a group that is not locked. */
    | 'not_locked'
    /** The Editor acted and the Story has `editor_group_locking` off (absent = disabled). */
    | 'editor_locking_disabled'
    /** The Editor asked for an unlock, which is the Author's decision alone. */
    | 'editor_unlock';

/**
 * Thrown by {@link lockPhraseGroup} / {@link unlockPhraseGroup} before anything is written.
 *
 * It is a plain `Error` subclass for the same reason `installGroupRevisions` throws one: `api/routes.ts`
 * renders every throw inside a `store.commit` as a 409 carrying the message verbatim, and a throw inside
 * the commit rolls the writes back, so a refusal means nothing moved. The `code` is what a route or a
 * dashboard maps to a machine-readable reason; `details` carries the ids so the message is not the only
 * evidence (`ToolRefusal`'s shape, which is the house style for a refusal that has to teach).
 */
export class PhraseLockRefusal extends Error {
    constructor(
        /** The rule family — one of {@link PhraseLockRefusalCode}. */
        readonly code: PhraseLockRefusalCode,
        message: string,
        /** Structured context: the group, the actor, the revision in play. */
        readonly details: Record<string, unknown> = {}
    ) {
        super(message);
        this.name = 'PhraseLockRefusal';
    }
}

/** Whether a thrown value is one of this module's refusals (the alternative is a store CAS conflict). */
export const isPhraseLockRefusal = (error: unknown): error is PhraseLockRefusal => error instanceof PhraseLockRefusal;

// ---------------------------------------------------------------------------
// The setting read
// ---------------------------------------------------------------------------

/**
 * May the EDITOR lock a group on this Story? ABSENT means NO (`Story.editor_group_locking`).
 *
 * Owned here so the Editor job, its tool guard and this module's gate answer with one read: a second
 * copy of `=== true` is how a default and a permission start disagreeing.
 */
export const editorGroupLockingEnabled = (story: Story | undefined): boolean =>
    story?.editor_group_locking === true;

// ---------------------------------------------------------------------------
// The two operations
// ---------------------------------------------------------------------------

/** What one {@link lockPhraseGroup} call wrote, in the shapes a route answers with and a test pins. */
export interface PhraseLockResult {
    /** The group row after the lock: `locked`, `locked_revision`, `locked_by`, `locked_at`. */
    group: PhraseGroup;
    /** The revision the lock fixed — the group's `revision` at the moment of locking. */
    locked_revision: number;
    locked_by: PhraseGroupLockActor;
    /** The stamp the lock wrote (the caller's `at`, or the clock). */
    locked_at: string;
    /**
     * The findings THIS lock voided: every group they name is now locked, so the claim has no text
     * left to rewrite it. `previous_state` is what the row was before it became `discarded`, which is
     * the audit an Author needs when the rail's queue shortens.
     */
    voided_findings: Array<{ finding_id: string; previous_state: FindingState; scope: string[] }>;
}

/** What one {@link unlockPhraseGroup} call wrote. */
export interface PhraseUnlockResult {
    /** The group row after the unlock: `locked: false` and the three metadata fields cleared to null. */
    group: PhraseGroup;
    /** The revision the lock had been holding — the text that was, until now, unchangeable. */
    unlocked_revision: number;
    /** Always `'author'`: an Editor unlock is refused (see the file header). */
    actor: PhraseGroupLockActor;
}

/**
 * The finding states a lock may void. `fixed` and `discarded` are terminal (§4.10's ladder) and are left
 * exactly as they are — rewriting a closed row's state would move history, not a live claim. `disputed`
 * is included because D-33c counts it OPEN: an Editor dispute is "not proven yet", which is a live claim
 * about text that just stopped being writable.
 */
const VOIDABLE_FINDING_STATES: readonly FindingState[] = ['unconfirmed', 'confirmed', 'approved', 'disputed'];

/**
 * Locks one phrase group at its CURRENT revision (R-lock): the text stops being writable, the findings
 * about it stop being work, and the group becomes the fixed point the other groups are revised against.
 *
 * THE FOUR CHECKS, in the order that says the most actionable thing first:
 *   - the group must exist for this Story (`:groupId` is an address, and an invented one is a refusal,
 *     never a dangling attribution — the same rule `catalog.ts:phraseGroupsExist` applies to a finding);
 *   - it must ALREADY have a written text. A lock fixes a revision, and `revision: 0` with empty
 *     content has nothing to fix: locking an unwritten group would freeze an Overview with a hole in it
 *     and leave `installGroupRevisions` refusing the only write that could ever fill it;
 *   - it must not already be locked (see the file header for why this is a refusal and not a no-op);
 *   - an `'editor'` actor needs `Story.editor_group_locking` on; an `'author'` actor needs nothing.
 *
 * THE TWO WRITES, in the CALLER's commit (the house rule for every phrase writer — `api` and the loop
 * wrap this in `store.commit`), in this order, and the order matters:
 *   1. the group row's four lock fields, under a CAS against the row the caller read, so a concurrent
 *      install moves the text underneath and loses the lock rather than being locked mid-flight;
 *   2. the findings whose whole effective scope is now locked, to `discarded`. Reading the scope AFTER
 *      the write is what makes "the whole Overview" (an UNSCOPED finding, whose scope is every group)
 *      void exactly when the last of the five groups locks, and no earlier.
 *
 * Nothing else moves: no revision row, no `content`, no Overview recomposition, no mirror write. The
 * text is the same bytes before and after, so the group's `revision`, the `phrases` row and the legacy
 * `summaries` mirror all stay in sync with it by not being touched.
 *
 * Throws {@link PhraseLockRefusal} for a refusal and lets the store's `CasConflict` through for a lost
 * race; both are 409s at the route, and nothing is written in either case.
 */
export function lockPhraseGroup(
    store: Store,
    story: Story,
    groupId: string,
    attribution: Attribution,
    options: { actor: PhraseGroupLockActor; at?: string }
): PhraseLockResult {
    const { actor } = options;
    const group = store.phraseGroups.list().find((row) => row.story_id === story.id && row.id === groupId);

    if (group === undefined) {
        throw new PhraseLockRefusal(
            'group_not_found',
            `lockPhraseGroup: ${groupId} is not one of story ${story.id}'s phrase groups — a lock names a group this book has`,
            { story_id: story.id, group_id: groupId, actor }
        );
    }

    // A lock is a fact ABOUT a revision, so an unwritten group is not lockable (see the header). Both
    // halves are checked because a hand-edited row can carry a number and no text, and locking THAT
    // would freeze an empty section into every future Overview.
    if (group.revision === 0 || group.content.trim() === '') {
        throw new PhraseLockRefusal(
            'group_unwritten',
            `lockPhraseGroup: ${group.key} has no written text (revision ${group.revision}), so there is no revision for a lock to fix — the loop writes it, or the Author edits it, and then the lock lands on that text`,
            { story_id: story.id, group_id: groupId, group_key: group.key, revision: group.revision, actor }
        );
    }

    if (isPhraseGroupLocked(group)) {
        throw new PhraseLockRefusal(
            'already_locked',
            `lockPhraseGroup: ${group.key} is already locked at revision ${group.locked_revision ?? group.revision}${
                group.locked_by === undefined ? '' : ` by ${group.locked_by}`
            } — the Author unlocks it first, and a second lock would only re-date a decision the book already carries`,
            { story_id: story.id, group_id: groupId, group_key: group.key, locked_revision: group.locked_revision ?? group.revision, actor }
        );
    }

    if (actor === 'editor' && !editorGroupLockingEnabled(story)) {
        throw new PhraseLockRefusal(
            'editor_locking_disabled',
            `lockPhraseGroup: story ${story.id} has not enabled \`editor_group_locking\` (absent = disabled), so the Editor may recommend this group to the Author but may not lock it`,
            { story_id: story.id, group_id: groupId, group_key: group.key, actor }
        );
    }

    const at = options.at ?? nowIso();

    // 1. The lock itself. `locked_revision` is the revision as the BOOK has it (not as the caller's copy
    //    reads it), and the CAS is what keeps the two from disagreeing.
    const locked = store.phraseGroups.update(
        group.id,
        { locked: true, locked_revision: group.revision, locked_by: actor, locked_at: at },
        attribution,
        [{ id: group.id, rev: group.rev }]
    );

    // 2. The findings the lock voids. Read the rows back rather than reusing `groups`: the scope read
    //    below asks `isPhraseGroupLocked` of every group, so it has to see THIS lock.
    const lockedIds = new Set(phraseGroupsOf(store, story.id).filter(isPhraseGroupLocked).map((row) => row.id));
    const voidedFindings: PhraseLockResult['voided_findings'] = [];

    for (const finding of store.findings.list().filter((row) => row.story_id === story.id)) {
        if (!VOIDABLE_FINDING_STATES.includes(finding.state)) continue;

        // THE SCOPE READ IS NOT RE-FILTERED HERE (see `findings.ts:findingGroupScope`): an unscoped
        // finding's scope IS every group the Story has, which is the legacy whole-Overview meaning.
        // Filtering the finding's `group_refs` directly would silently turn "the whole Overview" into
        // "nothing" on the fourth of five locks, and the finding would read void while one group was
        // still writable. `refs.length > 0` is the other half: a Story with no groups at all has an
        // EMPTY scope, and an empty scope is not a scope the lock swallowed.
        const scope = findingGroupScope(store, story, finding);
        const open = scope.refs.filter((id) => !lockedIds.has(id));

        if (scope.refs.length === 0 || open.length > 0) continue;

        store.findings.update(
            finding.id,
            { state: 'discarded' },
            {
                ...attribution,
                // The `why` names the groups, because "the lock discarded it" is not the claim — the
                // claim is that every group the defect named is now fixed text with nothing left to
                // rewrite. That is the sentence an Author reads a week later, when the rail is quiet.
                why: `${attribution.why}; discarded ${finding.id} because every group it names (${scope.refs
                    .map((id) => store.phraseGroups.get(id)?.key ?? id)
                    .join(', ')}) is locked, so the claim has no text left to answer it (group lock)`
            },
            [{ id: finding.id, rev: finding.rev }]
        );

        voidedFindings.push({ finding_id: finding.id, previous_state: finding.state, scope: [...scope.refs] });
    }

    return { group: locked, locked_revision: locked.revision, locked_by: actor, locked_at: at, voided_findings: voidedFindings };
}

/**
 * Lifts a group's lock (Author-only): the text becomes writable again and the group rejoins the loop's
 * work, with NOTHING else rewritten.
 *
 * WHAT IT DOES NOT DO, and why each half is load-bearing:
 *   - it does not touch `content` or `revision`, and writes no `group_revisions` row: an unlock is the
 *     removal of a flag, not an edit, so the Author's signed-off text is byte-for-byte what it was;
 *   - it does not resurrect the findings the lock voided. `discarded` is terminal in §4.10 (a discard
 *     is the Author or the Editor declining a claim, and D-33c reads it as CLOSED), and un-discarding
 *     rows on an unlock would re-arm work the book has already decided against — for a defect the crew
 *     still believes in, the next Critic pass files the claim again, against the now-writable text;
 *   - it does not invent a revision to mark the unlock. The three metadata fields go to `null` rather
 *     than being deleted, because a store `update` merges through JSON and a key with an `undefined`
 *     value disappears rather than clearing (see `PhraseGroup.locked_revision`).
 *
 * The findings' scope reads are pure, so no re-derivation is needed: a finding still naming this group
 * becomes actionable for it again the moment the flag is off, which is a READ changing its answer, not a
 * write touching forty rows.
 */
export function unlockPhraseGroup(
    store: Store,
    story: Story,
    groupId: string,
    attribution: Attribution,
    // No `at` here, unlike `lockPhraseGroup`: an unlock writes no timestamp of its own (see the note at
    // the write), so the option would only invite a caller to pass a clock nothing reads.
    options: { actor: PhraseGroupLockActor }
): PhraseUnlockResult {
    const { actor } = options;

    if (actor !== 'author') {
        throw new PhraseLockRefusal(
            'editor_unlock',
            `unlockPhraseGroup: only the Author lifts a group lock (${actor} asked for ${groupId}) — the lock stopped the loop rewriting the text, and deciding to let it try again is the Author's call, not the crew's`,
            { story_id: story.id, group_id: groupId, actor }
        );
    }

    const group = store.phraseGroups.list().find((row) => row.story_id === story.id && row.id === groupId);

    if (group === undefined) {
        throw new PhraseLockRefusal(
            'group_not_found',
            `unlockPhraseGroup: ${groupId} is not one of story ${story.id}'s phrase groups — a lock names a group this book has`,
            { story_id: story.id, group_id: groupId, actor }
        );
    }

    if (!isPhraseGroupLocked(group)) {
        throw new PhraseLockRefusal(
            'not_locked',
            `unlockPhraseGroup: ${group.key} is not locked, so there is nothing to lift — the loop already has this group's text to work on`,
            { story_id: story.id, group_id: groupId, group_key: group.key, actor }
        );
    }

    const unlocked = store.phraseGroups.update(
        group.id,
        // `null`, not `undefined`: the fields must say "no live lock" on the row rather than keep the
        // address of a lock that is gone (see the note above). `locked: false` is the effective state.
        { locked: false, locked_revision: null, locked_by: null, locked_at: null },
        {
            ...attribution,
            why: `${attribution.why}; ${group.key} revision ${group.locked_revision ?? group.revision} stopped being fixed text (group lock lifted)`
        },
        [{ id: group.id, rev: group.rev }]
    );

    // No timestamp is written for the unlock itself: §4's group row carries the LOCK's stamp
    // (`locked_at`), and the journal line this write makes is the record of when the flag came off, so
    // an `unlocked_at` field would be a second clock that can disagree with it.
    return { group: unlocked, unlocked_revision: group.locked_revision ?? group.revision, actor };
}
