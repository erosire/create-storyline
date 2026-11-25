/**
 * PHRASE GROUP LOCK (R3/T6b) — the Editor's judgement seat in the LIVE loop.
 *
 * The Author's decision being pinned is a permission, not a pipeline: with `Story.editor_group_locking`
 * on, the Editor may be asked — once per section per CLEAN vector — whether that section's current clean
 * text may be LOCKED, i.e. fixed as the consistency evidence the rest of the book is revised against.
 * Four things make that safe, and every test below exists for one of them:
 *
 *   1. THE SETTING IS THE SWITCH, ABSENT = OFF (`phrase/locks.ts:editorGroupLockingEnabled`, read by
 *      `loop/editor-lock.ts`). OFF means the generator never asks: no candidate, no run, no judgement, no
 *      lock, and the book behaves exactly as it did before the feature existed.
 *   2. ONE SEAT PER SECTION (`wi_group_lock_<cleanVectorHash>_<groupId>`). A lock is a judgement about ONE
 *      section, so a `false` on `tone` must not stop `premise` from being frozen, and freezing `premise`
 *      must not spend `tone`'s turn. The vector half of the key is what re-arms a decided seat when the
 *      clean selection ADVANCES — and what makes a restart reproduce the seat list from the rows instead of
 *      re-deciding anything.
 *   3. THE FLAG IS THE ONLY PRODUCT, and the only thing that moves it is a positive judgement with a
 *      reason. The settle writes no text, no finding, no task, no verdict and no counter. A `false`, a
 *      decision with no rationale, a decision about another section, and a state that moved under the pass
 *      (the Setting withdrawn, a Writer installing, the Author locking by hand) all write NOTHING, and
 *      none of them corrupts the run or the loop.
 *   4. THE SEAT IS NEVER OWED. `phrase/exclusion.ts:GROUP_PIPELINE_RUN_PREFIXES` and `:groupPipelineOwed`
 *      deliberately do not know this family, so sign-off, the drain probe and the write-allowance reads are
 *      untouched — even with a judgement pass in flight. A book whose Editor answers `false` five times
 *      still drains.
 *
 * VALUES ARE DERIVED WHERE THE LEDGER DECIDES THEM: the seats' keys, which section a capacity-1 slot
 * dispatches first, and a revision number after an install are all consequences of store state, so the
 * expectations read them off the rows (`decidedId`, `vectorOf`) rather than hardcoding a run order — a
 * literal UUID order would be an accident of this store's id minting, and the product rule is the same
 * whatever ids the rows carry. Sentences, template slugs, ranks and thresholds ARE pinned as literals,
 * because those are the copy the product chose.
 */
import { describe, expect, it } from 'vitest';
import { createRig, type CrewBehaviour, type Rig } from './mock';
import { drainPreconditions } from './status';
import { generateWork } from './work';
import type { Store } from '../store';
// The seat's own vocabulary: the key builder, the eligibility read, and the spent-seat test the restart
// relies on. Asserting them through the loop (not only in `editor-lock.test.ts`) is what proves the
// generator, the prompt compiler and the settle all read the SAME definition of "lockable right now".
import { editorLockEvidenceOf, groupLockSeatKey, groupLockSeatSpent } from './editor-lock';
import {
    GROUP_DRAFT_ITEM_PREFIX,
    groupCheckSeatKey,
    groupReviewSeatKey,
    sectionScoreClaimKey
} from '../phrase/exclusion';
import { storyPhrase } from '../phrase/catalog';
import { lockPhraseGroup, unlockPhraseGroup } from '../phrase/locks';
import { cleanSelectionOf, stampCleanRevisions } from '../phrase/reviewed';
import { groupRevisionVector, groupVectorHash, installGroupRevisions } from '../phrase/revisions';
import { AUTHOR_ATTR } from '../run/mock';
import { GroupLockDecisionSchema, GROUP_LOCK_SCHEMA_NAME } from '../../shared/schemas';
import type { PhraseGroup, Run, Story, SummaryScore } from '../../shared/types';

/** The phase-① rig every grouped fixture uses: one Critic pass, research waived (§6.4 step 2 stays out). */
const rigged = (crew: CrewBehaviour = {}): Promise<Rig> =>
    createRig({
        summaryMode: 'groups',
        summarySampling: 5,
        summaryCritics: 1,
        crew: { researchQuestions: [], ...crew }
    });

// ---------------------------------------------------------------------------
// The fixture — the same idiom as `loop/section-scores.test.ts`
// ---------------------------------------------------------------------------

const groupsOf = (store: Store, storyId: string): PhraseGroup[] =>
    store.phraseGroups.list().filter((group) => group.story_id === storyId);

/** The vector of the text installed RIGHT NOW — the read the generator, the rail and the seats share. */
const vectorOf = (store: Store, storyId: string): string => groupVectorHash(groupRevisionVector(store, storyId));

/** The Author's permission, switched through the story row. Absent is OFF, so this line IS the gate. */
function withLocking(store: Store, storyId: string, enabled: boolean): Story {
    const story = store.stories.require(storyId);

    return store.stories.update(
        story.id,
        { editor_group_locking: enabled },
        { ...AUTHOR_ATTR, why: `seed: the Author ${enabled ? 'granted' : 'withdrew'} the Editor a lock seat (R3)` },
        [{ id: story.id, rev: story.rev }]
    );
}

/** Text for all five sections, through the production install path (R2's numbering). */
function installAll(rig: Rig, content: string, workItemRef = `${GROUP_DRAFT_ITEM_PREFIX}_summary_0_test_1`) {
    return installGroupRevisions(
        rig.store,
        rig.story(),
        // FRESH rows: an install CASes each group row, so a row captured before an earlier write would trip
        // the store's guard instead of testing the rule.
        groupsOf(rig.store, rig.storyId).map((group) => ({
            group: rig.store.phraseGroups.require(group.id),
            content: `${group.key}: ${content}`
        })),
        AUTHOR_ATTR,
        { runRef: 'run_writer', workItemRef }
    );
}

/** Closes the cross-group pass over the current vector: the write that makes a revision CLEAN (D-67). */
function stampClean(rig: Rig, runRef = 'run_check_1') {
    return stampCleanRevisions(
        rig.store,
        rig.story(),
        { seatKey: groupCheckSeatKey(vectorOf(rig.store, rig.storyId), 1), runRef },
        AUTHOR_ATTR
    );
}

/**
 * A CLOSED run for one seat key — "the book already paid this seat". This retires the work phase ① genuinely
 * owes (the structured Critic pass and the deep cross-group review) so the rig's capacity-1 slot can only
 * take the optional seat. `torn_down` is the state a finished pass leaves: `records.ts` counts a CLOSED run
 * whatever its outcome, which is the very spentness rule these seats share.
 */
function paySeat(rig: Rig, key: string, role: Run['role'], groupRefs: string[]) {
    return rig.store.runs.create(
        {
            story_id: rig.storyId,
            work_item_ref: key,
            role,
            state: 'torn_down' satisfies Run['state'],
            started_at: '2026-11-25T10:00:01.000Z',
            ended_at: '2026-11-25T10:00:02.000Z',
            tokens: 4,
            kind: 'work',
            no_op: false,
            delegated: [],
            group_refs: groupRefs
        },
        { run_ref: null, author: true, why: `seed: the paid seat ${key}` }
    );
}

/**
 * The Reader's row for ONE section at ONE vector (D-65). A lock seat is an adjudication OVER that reading,
 * so no seat exists without it; it is written by hand rather than by running the scoring seat, because a
 * fixture should state its own precondition rather than depend on another seat's settle.
 */
function scoreRowFor(rig: Rig, group: PhraseGroup, vectorHash: string): SummaryScore {
    return rig.store.summaryScores.create(
        {
            story_id: rig.storyId,
            phrase_id: storyPhrase(rig.store, rig.storyId)!.id,
            vector_hash: vectorHash,
            group_id: group.id,
            group_key: group.key,
            score: 76,
            rationale: `${group.key} holds as written and nothing in the Overview contradicts it`,
            evidence: `${group.key}: the installed text.`,
            run_ref: 'run_score_1',
            work_item_ref: sectionScoreClaimKey(vectorHash)
        },
        { ...AUTHOR_ATTR, why: `seed: the Reader scored ${group.key} at ${vectorHash} (D-65)` }
    );
}

/**
 * The state a lock seat is legitimately dispatched into: five sections at revision 1, all five stamped
 * CLEAN, the Reader's row for each, the seats the book owes already paid, and the permission set to
 * `enabled`. The vector comes back so each test states the keys it expects instead of re-deriving them.
 */
async function armed(crew: CrewBehaviour = {}, enabled = true) {
    const rig = await rigged(crew);

    installAll(rig, 'the installed text.');
    stampClean(rig);

    const vector = vectorOf(rig.store, rig.storyId);
    const groups = groupsOf(rig.store, rig.storyId);

    for (const group of groups) scoreRowFor(rig, group, vector);

    paySeat(rig, groupReviewSeatKey(vector, 1), 'critic', groups.map((group) => group.id));
    paySeat(rig, groupCheckSeatKey(vector, 1), 'critic', groups.map((group) => group.id));
    // The scoring seat retires itself on the rows above (`scoredVectorHashes`), and the Writer batch owes
    // nothing because no finding is open — so the only live candidate is the optional seat.

    withLocking(rig.store, rig.storyId, enabled);

    return { rig, vector, groups };
}

// ---------------------------------------------------------------------------
// The reads the assertions are made of
// ---------------------------------------------------------------------------

/** The lock seats in this sweep's queue, whatever else the sweep wants. */
function lockSeats(store: Store, storyId: string) {
    return generateWork(store, store.stories.require(storyId), {
        at: '2026-11-25T10:00:00.000Z',
        phase: 'summary'
    }).filter((candidate) => candidate.item.kind === 'group_lock');
}

/**
 * Seat keys, SORTED — on both sides of every comparison.
 *
 * The keys are MINTED in catalog order (`editorLockSeatTargets` walks the clean selection in catalog order),
 * but `generateWork` returns the queue, and five seats with the same priority and the same rank come out in
 * key order. Asserting the generator's order through the queue would pin the queue's tie-break by accident,
 * so these tests assert the SET of keys, which is the product rule: one seat per section, one key per seat.
 */
const seatKeys = (seats: Array<{ key: string }>): string[] => seats.map((seat) => seat.key).sort();

/** The one seat claimed for `groupId`, whichever order the queue emitted it in. */
const seatFor = (seats: ReturnType<typeof lockSeats>, groupId: string) =>
    seats.find((seat) => seat.item.groupRefs?.[0] === groupId)!;

/**
 * The lock runs on the ledger, in insertion order — which is dispatch order, the order `store.runs.list()`
 * yields them and the order a restart reads them back in.
 */
const lockRuns = (store: Store): Run[] =>
    store.runs.list().filter((run) => (run.work_item_ref ?? '').startsWith('wi_group_lock_'));

/** Each section's lock state — the whole product of the seat, in one read. */
function lockState(store: Store, storyId: string) {
    return groupsOf(store, storyId).map((group) => {
        const row = store.phraseGroups.require(group.id);

        // An UNLOCKED row leaves the lock fields OUT (absent, not `false`) — that is exactly what
        // `isPhraseGroupLocked` reads, and a fixture that wrote `false` would not be the same book.
        return { key: row.key, locked: row.locked ?? null, revision: row.revision, locked_by: row.locked_by ?? null };
    });
}

/** The lock state a five-section book shows when `id` is the one section the crew was allowed to freeze. */
const frozenOnly = (groups: PhraseGroup[], id: string) =>
    groups.map((group) => ({
        key: group.key,
        locked: group.id === id ? true : null,
        revision: 1,
        locked_by: group.id === id ? 'editor' : null
    }));

describe('the seat is gated on the Author\u2019s permission (R3, absent = OFF)', () => {
    it('offers nothing while the Setting is absent, and a full sweep writes no lock', async () => {
        const { rig, vector, groups } = await armed({}, false);

        // Everything a seat needs EXCEPT the permission: the eligibility read answers with nothing at all.
        expect(cleanSelectionOf(rig.store, rig.story()).complete).toBe(true);
        expect(lockSeats(rig.store, rig.storyId)).toEqual([]);

        await rig.run(4);

        // No seat means no run, and a run is the only thing that could have written the flag: the book is
        // byte-for-byte the pre-R3 book, which is what "a permission, not a pipeline" has to mean.
        expect(lockRuns(rig.store)).toEqual([]);
        expect(lockState(rig.store, rig.storyId)).toEqual([
            { key: 'premise', locked: null, revision: 1, locked_by: null },
            { key: 'promise', locked: null, revision: 1, locked_by: null },
            { key: 'theme', locked: null, revision: 1, locked_by: null },
            { key: 'tone', locked: null, revision: 1, locked_by: null },
            { key: 'ending', locked: null, revision: 1, locked_by: null }
        ]);
        expect(vector).toBe(vectorOf(rig.store, rig.storyId));
    });

    it('refuses a freeze whose permission was withdrawn while the seat was deliberating, and queues no more', async () => {
        const { rig, vector, groups } = await armed(
            {
                // The Author flips the Setting off MID-PASS — the window the settle guard exists for, since
                // an Editor run may sit in the queue behind the capacity ceiling.
                groupLock: ({ item }) => {
                    withLocking(rig.store, rig.storyId, false);

                    return { group_ref: item.groupRefs![0], lock: true, rationale: 'the section is finished (scripted)' };
                }
            },
            true
        );

        expect(seatKeys(lockSeats(rig.store, rig.storyId))).toEqual(
            seatKeys(groups.map((group) => ({ key: groupLockSeatKey(vector, group.id) })))
        );

        await rig.step();

        // The judgement was about a book that no longer exists, so it is not executed: no flag, the run
        // closed normally, and the queue has nothing to offer on a permission that is off.
        expect(lockState(rig.store, rig.storyId).every((row) => row.locked === null)).toBe(true);
        expect(lockRuns(rig.store)).toHaveLength(1);
        expect(lockRuns(rig.store)[0].state).toBe('torn_down');
        expect(lockSeats(rig.store, rig.storyId)).toEqual([]);
        expect(rig.liveRuns()).toEqual([]);
    });
});

describe('one seat per clean section, keyed by the clean vector (R3)', () => {
    it('offers one seat per section and pins the exact job the Editor is sent', async () => {
        const { rig, vector, groups } = await armed();
        const seats = lockSeats(rig.store, rig.storyId);

        // FIVE seats, each keyed by the clean selection's hash plus its OWN group id — the pair that makes
        // "one judgement per section" true and a restart reproducible.
        expect(seatKeys(seats)).toEqual(seatKeys(groups.map((group) => ({ key: groupLockSeatKey(vector, group.id) }))));

        // THE JOB, pinned exactly: the seat's identity, its contract, and the one section it may freeze.
        expect(seatFor(seats, groups[0].id)).toEqual({
            key: groupLockSeatKey(vector, groups[0].id),
            item: {
                id: groupLockSeatKey(vector, groups[0].id),
                storyId: rig.storyId,
                kind: 'group_lock',
                // Its OWN slug: the system turn is compiled from `editor-group-lock`
                // (`run/phase1-prompt.ts:compileGroupLockPrompt`), so the row names the copy the run was
                // actually shown and an Author editing the generic Editor template cannot lose the rules.
                templateRef: 'editor-group-lock',
                roleName: 'editor',
                unit: { kind: 'summary', ref: 'summary_0' },
                // No tools: an Editor holding the lock tool here would be a second, unaudited path to the
                // same flag — the tool surface is the Author's, with its own actor rules.
                toolMode: 'none',
                responseSchema: { name: GROUP_LOCK_SCHEMA_NAME, schema: GroupLockDecisionSchema },
                // EXACTLY one section — the seat's identity, and what the settle re-checks.
                groupRefs: [groups[0].id],
                // Nothing open names this section in this fixture; the empty list is still stated.
                findingRefs: []
            },
            max_concurrent: 1,
            why: `Editor judges whether ${groups[0].key} may be locked as finished text at clean vector ${vector} (R3)`,
            priority: 2,
            // LAST in the priority-2 class (the Reader's number is -1, the Critic seats 0): the freeze is an
            // adjudication OVER both of those, and its absence costs the least — an unlocked section keeps
            // being rewritten, which is the loop's normal, healthy state.
            rank: 1
        });
        // The seat's schema is the SAME object the transport ships, not a copy that could drift.
        expect(seatFor(seats, groups[0].id).item.responseSchema!.schema).toBe(GroupLockDecisionSchema);
        // No seat carries the whole book: each names its own single group.
        expect(seats.map((seat) => seat.item.groupRefs).sort()).toEqual(
            groups.map((group) => [group.id]).sort()
        );
    });

    it('locks one section per seat, and a lock never spends another section\u2019s seat', async () => {
        const { rig, vector, groups } = await armed();

        // The capacity-1 slot can only take the optional seat: everything owed is already paid.
        await rig.step();

        const first = lockRuns(rig.store)[0];
        const decidedId = first.group_refs![0];

        expect(first.work_item_ref).toBe(groupLockSeatKey(vector, decidedId));
        expect(first.role).toBe('editor');
        expect(first.state).toBe('torn_down');

        // THE FLAG, on the one section this seat was claimed for, fixed at the CLEAN revision it judged —
        // and nowhere else. The four neighbours are untouched rows, not `false` rows.
        expect(lockState(rig.store, rig.storyId)).toEqual(frozenOnly(groups, decidedId));

        // The decided section drops out of the queue (the flag IS the answer already given) and the other
        // four keep their seats, still keyed by the SAME clean vector: freezing one section did not spend
        // another one's turn, which is the whole argument for a per-group key.
        const remaining = groups.filter((group) => group.id !== decidedId);

        expect(seatKeys(lockSeats(rig.store, rig.storyId))).toEqual(
            seatKeys(remaining.map((group) => ({ key: groupLockSeatKey(vector, group.id) })))
        );

        // A second seat decides a second section, and the two flags are independent rows.
        await rig.step();

        const second = lockRuns(rig.store)[1];

        expect(second.group_refs![0]).not.toBe(decidedId);
        expect(remaining.map((group) => group.id)).toContain(second.group_refs![0]);
        expect(lockState(rig.store, rig.storyId).filter((row) => row.locked === true)).toHaveLength(2);
    });

    it('spends the seat on a NO, writes no flag, and re-arms only when the clean selection advances', async () => {
        const { rig, vector, groups } = await armed({
            // A refusal is a DECISION, not a failure: nothing is written, and the seat is not bought again.
            groupLock: ({ item }) => ({
                group_ref: item.groupRefs![0],
                lock: false,
                rationale: 'an open proposal still asks this section to change, so the loop keeps working on it (scripted)'
            })
        });

        await rig.step();

        const decidedId = lockRuns(rig.store)[0].group_refs![0];

        expect(lockRuns(rig.store)).toHaveLength(1);
        expect(lockState(rig.store, rig.storyId)).toEqual([
            { key: 'premise', locked: null, revision: 1, locked_by: null },
            { key: 'promise', locked: null, revision: 1, locked_by: null },
            { key: 'theme', locked: null, revision: 1, locked_by: null },
            { key: 'tone', locked: null, revision: 1, locked_by: null },
            { key: 'ending', locked: null, revision: 1, locked_by: null }
        ]);

        // THE SPENTNESS RULE, read the way the generator reads it: the section is still perfectly lockable
        // (unlocked, written, clean, scored — the evidence exists), but this vector already carries a closed
        // judgement pass, so the seat is not owed again.
        const evidence = editorLockEvidenceOf(rig.store, rig.story(), decidedId)!;

        expect({ vector_hash: evidence.vector_hash, group: evidence.group.key }).toEqual({
            vector_hash: vector,
            group: groups.find((group) => group.id === decidedId)!.key
        });
        expect(groupLockSeatSpent(rig.store, evidence)).toBe(true);
        // A section nobody has decided yet is still owed its seat: spentness is per key, never per book.
        expect(groupLockSeatSpent(rig.store, editorLockEvidenceOf(rig.store, rig.story(), groups.find((group) => group.id !== decidedId)!.id)!)).toBe(
            false
        );

        // Every seat at this vector is retired once it has answered (five seats, five dispatches): the loop
        // does not ask five times per sweep about text the Editor already declined.
        await rig.step();
        await rig.step();
        await rig.step();
        await rig.step();

        expect(lockRuns(rig.store)).toHaveLength(5);
        expect(lockSeats(rig.store, rig.storyId)).toEqual([]);

        // The vector moves — a Writer rewrite, then a clean pass over the new text.
        installAll(rig, 'a rewritten text.', `${GROUP_DRAFT_ITEM_PREFIX}_summary_0_test_2`);
        stampClean(rig, 'run_check_2');

        const next = vectorOf(rig.store, rig.storyId);

        expect({ advanced: next !== vector, complete: cleanSelectionOf(rig.store, rig.story()).complete }).toEqual({
            advanced: true,
            complete: true
        });

        // NOTHING is offered yet, and that is the seat's other half: a lock seat is an adjudication OVER the
        // Reader's reading of THIS vector, and the rows still describe the old one. An advance re-arms the
        // question only once the new text has been scored — never on a stale number.
        expect(lockSeats(rig.store, rig.storyId)).toEqual([]);

        for (const group of groups) scoreRowFor(rig, group, next);

        expect(seatKeys(lockSeats(rig.store, rig.storyId))).toEqual(
            seatKeys(groups.map((group) => ({ key: groupLockSeatKey(next, group.id) })))
        );
    });

    it('reproduces the seat list from the rows, so a restart re-arms nothing that already answered', async () => {
        const { rig, vector, groups } = await armed();
        const store = rig.store;
        const storyId = rig.storyId;

        await rig.step();

        const decidedId = lockRuns(store)[0].group_refs![0];

        // THE RESTART READ: `generateWork` is a pure read of the rows, so booting the loop over the same
        // store reproduces exactly the seats the ledger still owes — the decided section is gone (closed run
        // AND the flag), the other four come back with identical keys.
        const remaining = groups.filter((group) => group.id !== decidedId);

        expect(seatKeys(lockSeats(store, storyId))).toEqual(
            seatKeys(remaining.map((group) => ({ key: groupLockSeatKey(vector, group.id) })))
        );
        expect(lockRuns(store).filter((run) => run.work_item_ref === groupLockSeatKey(vector, decidedId))).toHaveLength(1);

        // And the decided section is not even ELIGIBLE any more — the lock is the answer — so a restart
        // cannot ask for a second opinion on one freeze, whatever the ledger says about runs.
        expect(editorLockEvidenceOf(store, store.stories.require(storyId), decidedId)).toBeUndefined();
    });
});

describe('the settle: the judgement, the reason, and a book that moved underneath it (R3)', () => {
    it('refuses a decision with no reason and writes nothing (D-15)', async () => {
        const { rig } = await armed({
            groupLock: ({ item }) => ({ group_ref: item.groupRefs![0], lock: true, rationale: '   ' })
        });

        await rig.step();

        expect(lockRuns(rig.store)).toHaveLength(1);
        expect(lockState(rig.store, rig.storyId).every((row) => row.locked === null)).toBe(true);
        // A blank reason is refused by the CONTRACT, which costs the book nothing and spends the pass: the
        // other four seats stay armed, so the loop keeps moving instead of re-buying this judgement.
        expect(lockSeats(rig.store, rig.storyId)).toHaveLength(4);
        expect(rig.liveRuns()).toEqual([]);
    });

    it('refuses a decision about a section this seat never held, rather than re-attributing it', async () => {
        const { rig } = await armed({
            // Every seat answers about a section that is NOT its own. Re-attributing the answer would freeze
            // a section whose text the pass was never shown.
            groupLock: ({ item }) => {
                const other = groupsOf(rig.store, rig.storyId).find((group) => group.id !== item.groupRefs![0])!;

                return { group_ref: other.id, lock: true, rationale: 'a decision about the wrong section (scripted)' };
            }
        });

        await rig.step();

        // The answer named a different section than the seat, so the contract refuses it whole; the section
        // the answer was ABOUT is not locked either, because no seat was claimed for that judgement.
        expect(lockRuns(rig.store)).toHaveLength(1);
        expect(lockState(rig.store, rig.storyId).every((row) => row.locked === null)).toBe(true);
        expect(lockRuns(rig.store)[0].state).toBe('torn_down');
    });

    it('drops the freeze when a Writer installs under the pass, and narrows the seats to the text still under review', async () => {
        const { rig, vector, groups } = await armed({
            // The install lands while the Editor is answering. `liveGroupWriters` and the clean-vector clause
            // both see it inside the settle commit.
            groupLock: ({ item }) => {
                installGroupRevisions(
                    rig.store,
                    rig.story(),
                    [{ group: rig.store.phraseGroups.require(item.groupRefs![0]), content: 'rewritten under the pass.' }],
                    AUTHOR_ATTR,
                    { runRef: 'run_writer_late', workItemRef: `${GROUP_DRAFT_ITEM_PREFIX}_summary_0_test_9` }
                );

                return { group_ref: item.groupRefs![0], lock: true, rationale: 'finished, as far as I can tell (scripted)' };
            }
        });

        await rig.step();

        const decidedId = lockRuns(rig.store)[0].group_refs![0];

        // That section is now at revision 2 while the clean selection still stands behind 1, so the flag
        // would have named words nobody reviewed — which is the one thing a lock must never do.
        expect(lockState(rig.store, rig.storyId)).toEqual(
            groups.map((group) => ({
                key: group.key,
                locked: null,
                revision: group.id === decidedId ? 2 : 1,
                locked_by: null
            }))
        );

        // AND the seat list narrows to the four sections that still match the reviewed Overview. The clean
        // selection itself stays COMPLETE (`cleanSelectionOf` stands behind each group's newest CLEAN row,
        // revision 1 here), so this is not the whole-vector case — it is the per-group clause doing its job:
        // `entry.revision.number !== group.revision` makes a section whose newest text was never reviewed
        // un-lockable, while its neighbours keep the seats they still have. The moved group's seat re-arms
        // when a deep pass clears revision 2, because the seat key is that selection's hash.
        expect(cleanSelectionOf(rig.store, rig.story()).complete).toBe(true);
        expect(editorLockEvidenceOf(rig.store, rig.story(), decidedId)).toBeUndefined();

        const stillLockable = groups.filter((group) => group.id !== decidedId);

        // The keys are the CLEAN selection's, which still stands behind revision 1 of every group — the same
        // hash the seats were armed under (`vector`), not the live vector the install just moved.
        expect(cleanSelectionOf(rig.store, rig.story()).vector_hash).toBe(vector);
        expect(seatKeys(lockSeats(rig.store, rig.storyId))).toEqual(
            seatKeys(stillLockable.map((group) => ({ key: groupLockSeatKey(vector, group.id) })))
        );
    });

    it('leaves the Author\u2019s own lock alone instead of re-dating it with the crew\u2019s', async () => {
        const { rig, groups } = await armed({
            groupLock: ({ item }) => ({ group_ref: item.groupRefs![0], lock: true, rationale: 'finished (scripted)' })
        });

        // The Author signs one section off by hand while the seats sit in the queue.
        lockPhraseGroup(
            rig.store,
            rig.story(),
            groups[0].id,
            { ...AUTHOR_ATTR, why: 'seed: the Author signed premise off by hand (R-lock)' },
            { actor: 'author' }
        );

        // Not offered at all — and the other four seats are unaffected, which is the per-group rule again.
        const remaining = groups.slice(1);

        expect(seatKeys(lockSeats(rig.store, rig.storyId))).toEqual(
            seatKeys(remaining.map((group) => ({ key: groupLockSeatKey(vectorOf(rig.store, rig.storyId), group.id) })))
        );

        await rig.step();

        // Two flags on the book, attributed differently, and the crew never touched the Author's row.
        const crewId = lockRuns(rig.store)[0].group_refs![0];

        expect({ author: rig.store.phraseGroups.require(groups[0].id).locked_by, crew: rig.store.phraseGroups.require(crewId).locked_by }).toEqual(
            { author: 'author', crew: 'editor' }
        );
        expect(crewId).not.toBe(groups[0].id);
    });
});

describe('the seat is optional work: never the drain, never the sign-off, never the allowance (R3)', () => {
    it('reads drained with five seats offered and nothing decided', async () => {
        const { rig, groups } = await armed({
            groupLock: ({ item }) => ({ group_ref: item.groupRefs![0], lock: false, rationale: 'not yet (scripted)' })
        });

        // The queue is full of optional work and the phase may still sign off — the whole exception in one
        // assertion: neither `groupPipelineOwed` nor `GROUP_PIPELINE_RUN_PREFIXES` knows this family.
        expect(lockSeats(rig.store, rig.storyId)).toHaveLength(5);
        expect(drainPreconditions(rig.store, rig.story())).toEqual({ met: true, unmet: [] });

        // A judgement pass IN FLIGHT does not hold the gate either: it writes no text, so it is neither a
        // holding run nor owed work — the probe may not even name it.
        const live = rig.store.runs.create(
            {
                story_id: rig.storyId,
                work_item_ref: groupLockSeatKey('0123456789abcdef', groups[0].id),
                role: 'editor',
                state: 'reporting' satisfies Run['state'],
                started_at: '2026-11-25T10:00:03.000Z',
                ended_at: null,
                tokens: 2,
                kind: 'work',
                no_op: false,
                delegated: [],
                group_refs: [groups[0].id]
            },
            { run_ref: null, author: true, why: 'seed: a judgement pass still in flight' }
        );

        expect(drainPreconditions(rig.store, rig.story())).toEqual({ met: true, unmet: [] });
        expect(live.work_item_ref).toBe(`wi_group_lock_0123456789abcdef_${groups[0].id}`);
    });

    it('leaves the identical book when every seat is declined: the same fixture without the permission reads the same', async () => {
        const declined = await armed({
            groupLock: ({ item }) => ({ group_ref: item.groupRefs![0], lock: false, rationale: 'not yet (scripted)' })
        });
        // The same state, same crew, one line apart: the permission off. Whatever the Editor was asked, it
        // said no, so the two books have to be indistinguishable.
        const off = await armed({}, false);

        await declined.rig.run(6);
        await off.rig.run(6);

        expect(lockState(declined.rig.store, declined.rig.storyId)).toEqual(lockState(off.rig.store, off.rig.storyId));
        expect(drainPreconditions(declined.rig.store, declined.rig.story())).toEqual(
            drainPreconditions(off.rig.store, off.rig.story())
        );
        // The seat's whole footprint is a flag and a run row: the write allowance phase ① tracks for the
        // Writer is untouched by five judgement passes.
        expect(lockRuns(declined.rig.store)).toHaveLength(5);
    });
});

describe('the flag is the Author\u2019s to lift, and lifting it re-buys nothing (R3)', () => {
    it('unlocks what the Editor locked, and does not re-arm the seat at the same vector', async () => {
        const { rig, vector, groups } = await armed({
            groupLock: ({ item }) => ({ group_ref: item.groupRefs![0], lock: true, rationale: 'finished (scripted)' })
        });

        await rig.step();

        const decidedId = lockRuns(rig.store)[0].group_refs![0];

        const unlocked = unlockPhraseGroup(
            rig.store,
            rig.story(),
            decidedId,
            { ...AUTHOR_ATTR, why: 'seed: the Author reopened the section (R-lock)' },
            { actor: 'author' }
        );

        expect({ locked: unlocked.group.locked, at: unlocked.unlocked_revision }).toEqual({ locked: false, at: 1 });

        // The unlock does not buy the seat back: this vector already carries a closed judgement pass, and
        // re-arming on an unlock would let one section cycle lock/unlock every sweep. Only a NEW clean
        // vector asks again — the same spending rule the structured Critic seats use.
        const remaining = groups.filter((group) => group.id !== decidedId);

        expect(seatKeys(lockSeats(rig.store, rig.storyId))).toEqual(
            seatKeys(remaining.map((group) => ({ key: groupLockSeatKey(vector, group.id) })))
        );
        expect(lockRuns(rig.store).filter((run) => run.work_item_ref === groupLockSeatKey(vector, decidedId))).toHaveLength(1);
    });
});
