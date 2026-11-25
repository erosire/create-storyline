// The Writer exclusion (R4): at most one live Writer operation per Summary group, derived entirely
// from the persisted live `runs` rows.
//
// WHY EXACT VALUES: R4 is a rule about CONCURRENCY, and the only way to show a derived lock is right
// is to name the exact group set each state yields — which ids are held, which stay free, and in what
// order. "It defers some groups" would pass while the exclusion leaked a group and two Writers raced
// the compare-and-swap on the group row.
//
// NO CLOCK, NO EXECUTOR: the answer is a function of the rows, so a restart reproduces it (L-3) and
// two engines asking in the same instant agree (L-5). Every run row below is written by hand, which is
// also the point: the exclusion never sees a Work Item, only `work_item_ref` and `group_refs`.
//
// THE GROUP LOCK: a locked group is not writable, so it is out of the owed list and out of every set the
// cut dispatches — and a defect that crosses a locked group is dispatched against the WRITABLE half alone,
// which is what stops one frozen sentence from parking a whole book. Those pins are in the last describe;
// `phrase/locks.ts` owns the write they read.
import { describe, expect, it } from 'vitest';
import { Store } from '../store';
import { AUTHOR_ATTR, seedFinding, seedStory } from '../run/mock';
import { recordUidAt } from '../store/persist';
import { ensurePhraseCatalog } from './catalog';
import { lockPhraseGroup } from './locks';
import {
    GROUP_DRAFT_ITEM_PREFIX,
    GROUP_HOLDING_KINDS,
    findingGroupSets,
    groupItemPrefixOf,
    groupWorkTargets,
    heldGroupRefs,
    liveGroupRefs,
    liveGroupSets,
    partitionGroupRefs,
    partitionGroups,
    planGroupDraftBatch
} from './exclusion';
import type { Run, Story } from '../../shared/types';

/** A Story plus its five catalog groups, with the ids pinned. */
function seedBook() {
    const store = Store.empty();
    const story = seedStory(store, { phase: 'summary' });
    let next = 0;
    const ensured = ensurePhraseCatalog(store, story, AUTHOR_ATTR, { newId: () => recordUidAt(next++) })!;

    return { store, story, groups: ensured.groups };
}

/** The five persisted group ids, in catalog order — the ids a batch names. */
const idsOf = (groups: Array<{ id: string }>) => groups.map((group) => group.id);
const idForKey = (groups: Array<{ id: string; key: string }>, key: string) =>
    groups.find((group) => group.key === key)!.id;

/**
 * A run row in the shape `run/executor.ts` writes for a group job: the claim key from
 * `wi_draft_groups_<summaryRef>_<hash>_<attempt>` and the group set copied off the Work Item.
 */
const seedRun = (
    store: Store,
    storyId: string,
    init: { work_item_ref: string; state?: Run['state']; group_refs?: string[]; role?: 'writer' | 'critic' }
): Run =>
    store.runs.create(
        {
            story_id: storyId,
            work_item_ref: init.work_item_ref,
            role: init.role ?? 'writer',
            state: init.state ?? 'working',
            started_at: '2026-11-24T10:00:00.000Z',
            tokens: 0,
            kind: 'work',
            delegated: [],
            ...(init.group_refs === undefined ? {} : { group_refs: init.group_refs })
        },
        { run_ref: null, author: false, why: 'seed: a run row for the group exclusion (R4)' }
    );

describe('the Writer exclusion is derived from the live run rows (R4)', () => {
    it('names the holding kinds and the claim-key family the planner builds with', () => {
        // Only the Writer installs a group, so only the Writer holds one: a `review_groups` pass or a
        // deep review reads the Overview and writes findings, and excluding those would put the whole
        // phase behind its first install.
        expect(GROUP_HOLDING_KINDS).toEqual(['draft_groups']);
        expect(groupItemPrefixOf('draft_groups')).toBe('wi_draft_groups');
        expect(GROUP_DRAFT_ITEM_PREFIX).toBe('wi_draft_groups');
    });

    it('holds nothing while no Writer runs, so every group is offered', () => {
        const { store, story, groups } = seedBook();

        expect(liveGroupSets(store, story.id)).toEqual([]);
        expect(Array.from(liveGroupRefs(store, story.id))).toEqual([]);
        expect(heldGroupRefs(store, story.id, idsOf(groups))).toEqual([]);

        const partition = partitionGroupRefs(store, story.id, idsOf(groups));

        expect(partition.free).toEqual(idsOf(groups));
        expect(partition.deferred).toEqual([]);
        expect(partitionGroups(store, story.id, groups).deferred).toEqual([]);
    });

    it('holds exactly the groups of the live Writer, and defers them out of a wider batch', () => {
        const { store, story, groups } = seedBook();

        seedRun(store, story.id, {
            work_item_ref: 'wi_draft_groups_summary_0_590ac70fe3cccdb3_1',
            group_refs: [idForKey(groups, 'premise'), idForKey(groups, 'tone')]
        });

        expect(liveGroupSets(store, story.id)).toEqual([
            [recordUidAt(1), recordUidAt(4)]
        ]);
        expect(Array.from(liveGroupRefs(store, story.id)).sort()).toEqual([recordUidAt(1), recordUidAt(4)].sort());

        // The deferral is a SHRINK, not a cancel: the sweep offers the three groups nobody is writing.
        const partition = partitionGroupRefs(store, story.id, idsOf(groups));

        expect(partition.free).toEqual([
            recordUidAt(2),
            recordUidAt(3),
            recordUidAt(5)
        ]);
        expect(partition.deferred).toEqual([recordUidAt(1), recordUidAt(4)]);

        // The row form the planner dispatches, in catalog order.
        expect(partitionGroups(store, story.id, groups).free.map((group) => group.key)).toEqual([
            'promise',
            'theme',
            'ending'
        ]);
        expect(partitionGroups(store, story.id, groups).deferred.map((group) => group.key)).toEqual(['premise', 'tone']);
    });

    it('runs two disjoint batches at once, and leaves one group for the sweep after them', () => {
        const { store, story, groups } = seedBook();

        seedRun(store, story.id, {
            work_item_ref: 'wi_draft_groups_summary_0_aaaaaaaaaaaaaaaa_1',
            group_refs: [idForKey(groups, 'premise'), idForKey(groups, 'promise')]
        });
        seedRun(store, story.id, {
            work_item_ref: 'wi_draft_groups_summary_0_bbbbbbbbbbbbbbbb_1',
            group_refs: [idForKey(groups, 'tone')]
        });

        expect(liveGroupSets(store, story.id)).toEqual([
            [recordUidAt(1), recordUidAt(2)],
            [recordUidAt(4)]
        ]);

        const partition = partitionGroups(store, story.id, groups);

        expect(partition.free.map((group) => group.key)).toEqual(['theme', 'ending']);
        expect(partition.deferred.map((group) => group.key)).toEqual(['premise', 'promise', 'tone']);
    });

    it('a batch that is entirely held offers nothing at all', () => {
        const { store, story, groups } = seedBook();

        seedRun(store, story.id, {
            work_item_ref: 'wi_draft_groups_summary_0_cccccccccccccccc_1',
            group_refs: [idForKey(groups, 'premise'), idForKey(groups, 'ending')]
        });

        const requested = [idForKey(groups, 'ending'), idForKey(groups, 'premise')];
        const partition = partitionGroupRefs(store, story.id, requested);

        // Empty `free` is the caller's signal to dispatch nothing — a Writer with no group to write
        // would spend a claim-key attempt on an empty answer.
        expect(partition.free).toEqual([]);
        // `deferred` keeps the order the CALLER named, which is what its own log line reads.
        expect(partition.deferred).toEqual([recordUidAt(5), recordUidAt(1)]);
    });

    it('releases the groups as soon as the run is no longer live', () => {
        const { store, story, groups } = seedBook();

        for (const state of ['torn_down', 'failed', 'abandoned'] as const) {
            seedRun(store, story.id, {
                work_item_ref: `wi_draft_groups_summary_0_${state}11111111_1`,
                state,
                group_refs: idsOf(groups)
            });
        }

        // `loop/records.ts:LIVE_RUN_STATES` is ['spawning','working','reporting']: a closed run is
        // ledger, not a lock. This is why a lease expiry or a kill needs no bookkeeping of ours.
        expect(liveGroupSets(store, story.id)).toEqual([]);
        expect(heldGroupRefs(store, story.id, idsOf(groups))).toEqual([]);
    });

    it('holds every group when a live Writer row carries no group set at all', () => {
        const { store, story, groups } = seedBook();

        // The fail-closed reading: a row written before `group_refs` existed, or whose copy step was
        // skipped, costs one deferred sweep rather than two Writers installing over each other.
        seedRun(store, story.id, { work_item_ref: 'wi_draft_groups_summary_0_dddddddddddddddd_1' });

        expect(liveGroupSets(store, story.id)).toEqual([idsOf(groups)]);
        expect(partitionGroupRefs(store, story.id, idsOf(groups)).free).toEqual([]);
    });

    it('ignores the kinds that do not install, and another Story’s runs', () => {
        const { store, story, groups } = seedBook();
        const other = seedStory(store, { phase: 'summary' });
        let next = 100;
        ensurePhraseCatalog(store, other, AUTHOR_ATTR, { newId: () => recordUidAt(next++) });

        // A structured review seat and a deep review are both live tool-carrying or schema passes, and
        // neither can install a group.
        seedRun(store, story.id, {
            work_item_ref: 'wi_review_groups_590ac70fe3cccdb3_1',
            role: 'critic',
            group_refs: idsOf(groups)
        });
        seedRun(store, story.id, {
            work_item_ref: 'wi_group_check_590ac70fe3cccdb3_1',
            role: 'critic',
            group_refs: idsOf(groups)
        });
        // The same anchor rule the sampling families use: a family that merely STARTS WITH the prefix
        // (no `_`) is not this one.
        seedRun(store, story.id, {
            work_item_ref: 'wi_draft_groupsx_summary_0_eeeeeeeeeeeeeeee_1',
            group_refs: idsOf(groups)
        });
        // Another book's Writer holds another book's groups (S-RUNTIME: one Store is one Story).
        seedRun(store, other.id, {
            work_item_ref: 'wi_draft_groups_summary_0_ffffffffffffffff_1',
            group_refs: [recordUidAt(101), recordUidAt(102)]
        });

        expect(liveGroupSets(store, story.id)).toEqual([]);
        expect(liveGroupRefs(store, story.id).size).toBe(0);
        // …and the other book's own exclusion still sees ITS Writer.
        expect(liveGroupSets(store, other.id)).toEqual([[recordUidAt(101), recordUidAt(102)]]);
    });
});

// D-66 (R12) — the CUT, in isolation. The loop suite pins what a sweep dispatches; this pins the rule
// that decides it, because that rule is three rules in a stated order and the order is the requirement:
// a live hold defers a WHOLE finding-set, a set missing one of its finding's still-owed groups is withheld
// whole, and `summary_sampling` caps only the sets AFTER the first one. The three behaviours the old cut
// produced — the shrunk batch, the dial-split defect, and the per-set rationing of one defect's groups —
// are pinned here as the ABSENCE of a batch or the PRESENCE of the whole set, so a future "optimisation"
// that re-splits a set fails at the module that owns the rule and not three layers up.
describe('the batch is cut in whole finding-sets (D-66, R12)', () => {
    /** The book with every group ALREADY written: only finding-named groups are owed. */
    const writtenBook = (keys: string[], dial: number) => {
        const book = seedBook();
        const { store, story, groups } = book;

        for (const group of groups) {
            store.phraseGroups.update(
                group.id,
                { content: `the ${group.key} line the Seed insists on`, revision: 1 },
                AUTHOR_ATTR,
                [{ id: group.id, rev: group.rev }]
            );
        }

        const fresh = store.stories.require(story.id);

        store.stories.update(
            story.id,
            { summary_sampling: dial },
            { run_ref: null, author: true, why: 'seed: the Author’s batch dial (D-66 caps sets, not defects)' },
            [{ id: fresh.id, rev: fresh.rev }]
        );

        return book;
    };

    /** An `approved` defect naming these catalog keys — D-34's authorised fix work. */
    const scoped = (store: Store, storyId: string, groups: Array<{ id: string; key: string; rev: number }>, keys: string[], tag: string) => {
        const finding = seedFinding(store, storyId, {
            target_ref: 'summary_0',
            criterion_ref: 'C-14',
            cost: 'critical',
            state: 'approved',
            title: `the ${keys.join(' and ')} contradict the Seed (${tag})`,
            detail: `summary_0 ${keys.join(', ')} promise the drowned valley; the Seed drowned it`,
            fingerprint: `C-14|summary_0|${tag}`
        });

        return store.findings.update(
            finding.id,
            { group_refs: keys.map((key) => idForKey(groups, key)) },
            { run_ref: null, author: true, why: 'seed: the defect names its groups (R3)' },
            [{ id: finding.id, rev: finding.rev }]
        );
    };

    /** The batch this sweep would dispatch, as CATALOG KEYS — the whole point of the cut, in one value. */
    const planned = (store: Store, story: Story) =>
        planGroupDraftBatch(store, story, groupWorkTargets(store, story)).map((target) => target.group.key);

    /** What the planner thinks is owed, as `catalogKey: [finding ids]` — the input the cut receives. */
    const owed = (store: Store, story: Story) =>
        groupWorkTargets(store, story).map((target) => [target.group.key, target.findingRefs.length]);

    it('takes a three-group defect as ONE set under a dial of one', () => {
        const { store, story, groups } = writtenBook(['premise', 'promise', 'theme', 'tone', 'ending'], 1);

        scoped(store, story.id, groups, ['premise', 'tone', 'ending'], 'trio');

        // The dial is 1 and the defect names 3. The old cut offered `premise` and left the other two for
        // later sweeps; D-66 sends all three together, because the number is a cap on PASSes per sweep and
        // one defect is one pass. The order is the catalog's, which the claim hash keys off.
        expect(owed(store, story)).toEqual([
            ['premise', 1],
            ['tone', 1],
            ['ending', 1]
        ]);
        expect(planned(store, story)).toEqual(['premise', 'tone', 'ending']);
    });

    it('defers the WHOLE set when one of its groups is held, instead of shrinking around the hold', () => {
        const { store, story, groups } = writtenBook(['premise', 'promise', 'theme', 'tone', 'ending'], 1);
        const finding = scoped(store, story.id, groups, ['premise', 'tone'], 'pair');

        // A live Writer owns `tone`. R4's exclusion still reads per-group — and D-66 decides what a
        // partially held SET means: the set waits. The old behaviour offered `{premise}` and installed a
        // revision claiming a finding whose other group was mid-flight in the same book.
        seedRun(store, story.id, {
            work_item_ref: `${GROUP_DRAFT_ITEM_PREFIX}_summary_0_held_1`,
            group_refs: [idForKey(groups, 'tone')]
        });

        expect(liveGroupRefs(store, story.id)).toEqual(new Set([idForKey(groups, 'tone')]));
        expect(planned(store, story)).toEqual([]);

        // And the hold is what withholds it: with the run closed, the same book dispatches the pair.
        const live = store.runs.list().find((run) => run.state === 'working')!;

        store.runs.update(
            live.id,
            { state: 'torn_down', ended_at: '2026-11-24T10:05:00.000Z' },
            { run_ref: null, author: false, why: 'seed: the Writer reported (R4)' },
            [{ id: live.id, rev: live.rev }]
        );

        expect(planned(store, story)).toEqual(['premise', 'tone']);
        expect((finding.group_refs ?? []).length).toBe(2);
    });

    it('caps BETWEEN sets: the first set goes whole under a dial of two, the second waits a sweep', () => {
        const { store, story, groups } = writtenBook(['premise', 'promise', 'theme', 'tone', 'ending'], 2);

        scoped(store, story.id, groups, ['premise', 'tone'], 'pair-a');
        scoped(store, story.id, groups, ['promise', 'theme'], 'pair-b');

        // Two INDEPENDENT defects (no group in common, so two sets) under a dial of 2: one set per sweep,
        // which is the rationing D-66 keeps. The first set is taken at its full size; the second does not
        // fit, and a partial second set would be the bug all over again.
        expect(planned(store, story)).toEqual(['premise', 'tone']);
    });

    it('merges defects that meet on one group into one pass over the union', () => {
        const { store, story, groups } = writtenBook(['premise', 'promise', 'theme', 'tone', 'ending'], 1);

        scoped(store, story.id, groups, ['premise', 'tone'], 'meets-a');
        scoped(store, story.id, groups, ['tone', 'ending'], 'meets-b');

        // Both name `tone`, so they are ONE connected set over `{premise, tone, ending}`: one pass, and the
        // group both findings named is written once rather than twice. The set is also larger than the
        // dial, which D-66 explicitly allows — the first set is always taken.
        expect(findingGroupSets(groupWorkTargets(store, story)).map((set) => set.map((target) => target.group.key))).toEqual([
            ['premise', 'tone', 'ending']
        ]);
        expect(planned(store, story)).toEqual(['premise', 'tone', 'ending']);
    });

    it('withholds a set whose finding still owes a group the cap has parked', () => {
        const { store, story, groups } = writtenBook(['premise', 'promise', 'theme', 'tone', 'ending'], 1);

        scoped(store, story.id, groups, ['premise', 'tone'], 'parked');

        // `tone` has spent its two attempts against the current text (`GROUP_WRITE_ATTEMPT_CAP`), so
        // `groupWorkTargets` parks it and offers only `premise`. D-66 refuses the salvage pass: installing
        // `premise` alone would bank a half-answer under a `finding_refs` claim while the finding stays
        // open, which is the state the rule exists to make unreachable. The escalation stays the finding.
        for (const attempt of [1, 2]) {
            seedRun(store, story.id, {
                work_item_ref: `${GROUP_DRAFT_ITEM_PREFIX}_summary_0_tone_${attempt}_1`,
                state: 'torn_down',
                group_refs: [idForKey(groups, 'tone')]
            });
        }

        // THE POINT OF ASKING THE FINDING, NOT THE TARGET LIST: `groupWorkTargets` has already dropped the
        // parked group, so the cut's input looks like a complete one-group batch. `planGroupDraftBatch`
        // re-reads `findingGroupsStillOwed` and sees `tone` still owed, so it offers NOTHING — and the
        // escalation stays the finding with its attempts visible (§17.6), not a half-installed claim.
        expect(owed(store, story)).toEqual([['premise', 1]]);
        expect(planned(store, story)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// THE GROUP LOCK: a locked group is not writable, so it is neither owed nor dispatched
//
// `phrase/locks.ts` writes the lock; what this module owes is the batch's reading of it. The load-bearing
// case is the CROSS-GROUP defect: a finding that names a locked group and a writable one is still
// dispatched, against the writable half alone (`phrase/findings.ts:findingGroupsStillOwed` subtracts the
// fixed text). Treating the locked group as "still owed" instead would park that defect behind a group
// nobody may rewrite — the difference between a lock that freezes one sentence and a lock that freezes the
// book, and the reason the subtraction is pinned at the planner's own door as well as the finding read's.
// ---------------------------------------------------------------------------
describe('a locked group is neither owed nor dispatched (the group lock)', () => {
    /** The lock, applied through the op that owns it rather than by hand-editing the row. */
    const lock = (store: Store, storyId: string, groupId: string) =>
        lockPhraseGroup(store, store.stories.require(storyId), groupId, AUTHOR_ATTR, {
            actor: 'author',
            at: '2026-11-25T10:00:00.000Z'
        });

    /** The Author's batch dial: one finding-set per sweep (D-66), so a dispatched set is unambiguous. */
    const dialOne = (store: Store, storyId: string): Story => {
        const fresh = store.stories.require(storyId);

        store.stories.update(
            fresh.id,
            { summary_sampling: 1 },
            { run_ref: null, author: true, why: 'seed: one finding-set per sweep (D-66 caps sets, not defects)' },
            [{ id: fresh.id, rev: fresh.rev }]
        );

        return store.stories.require(storyId);
    };

    /**
     * Every group written by HAND — the D-66 fixture's write — so the only thing that can take a group out
     * of the owed list below is the lock: an unwritten group is owed a first draft for a different reason,
     * and a group whose finding is resolved is not owed at all. `keys` are then locked by the Author.
     */
    const lockedBook = (keys: string[]) => {
        const { store, story, groups } = seedBook();

        for (const group of groups) {
            store.phraseGroups.update(
                group.id,
                { content: `the ${group.key} line the Seed insists on`, revision: 1 },
                AUTHOR_ATTR,
                [{ id: group.id, rev: group.rev }]
            );
        }

        const fresh = dialOne(store, story.id);

        for (const key of keys) lock(store, story.id, idForKey(groups, key));

        return { store, story: store.stories.require(fresh.id), groups };
    };

    /** An `approved` defect naming these catalog keys — D-34's authorised fix work. */
    const defect = (
        store: Store,
        storyId: string,
        groups: Array<{ id: string; key: string; rev: number }>,
        keys: string[],
        tag: string
    ) => {
        const finding = seedFinding(store, storyId, {
            target_ref: 'summary_0',
            criterion_ref: 'C-14',
            cost: 'critical',
            state: 'approved',
            title: `the ${keys.join(' and ')} contradict the Seed (${tag})`,
            detail: `summary_0 ${keys.join(', ')} promise the drowned valley; the Seed drowned it`,
            fingerprint: `C-14|summary_0|${tag}`
        });

        return store.findings.update(
            finding.id,
            { group_refs: keys.map((key) => idForKey(groups, key)) },
            { run_ref: null, author: true, why: 'seed: the defect names its groups (R3)' },
            [{ id: finding.id, rev: finding.rev }]
        );
    };

    /** What the planner thinks is owed, as `catalogKey: [finding ids]` — the ids are part of the answer. */
    const owed = (store: Store, story: Story) =>
        groupWorkTargets(store, story).map((target) => [target.group.key, target.findingRefs]);
    /** What this sweep would dispatch, as CATALOG KEYS. */
    const planned = (store: Store, story: Story) =>
        planGroupDraftBatch(store, story, groupWorkTargets(store, story)).map((target) => target.group.key);

    it('drops the locked group from the owed list, and answers a cross-group defect against the half that can move', () => {
        const { store, story, groups } = lockedBook(['premise']);
        const finding = defect(store, story.id, groups, ['premise', 'tone'], 'pair');

        // The defect still names two groups and only one of them can be rewritten — so exactly one target
        // carries it, and the claim key, the prompt's GROUPS block and the install all name one group.
        expect(owed(store, story)).toEqual([['tone', [finding.id]]]);
        expect(findingGroupSets(groupWorkTargets(store, story)).map((set) => set.map((t) => t.group.key))).toEqual([['tone']]);
        expect(planned(store, story)).toEqual(['tone']);

        // THE LOCK REWRITES THE READ, NOT THE RECORD: the row still names both groups and is still open, so
        // the rail can say what the claim was about and `findings.ts:findingActionableScope` can say which
        // half of it the lock made unanswerable.
        expect(store.findings.require(finding.id)).toMatchObject({
            state: 'approved',
            group_refs: [idForKey(groups, 'premise'), idForKey(groups, 'tone')]
        });
    });

    it('takes a defect down to its writable half as locks land, and voids it when none is left', () => {
        const { store, story, groups } = lockedBook([]);
        const finding = defect(store, story.id, groups, ['premise', 'tone'], 'pair');

        // The un-locked baseline: ONE connected set over both groups, taken whole under a dial of one.
        expect(owed(store, story)).toEqual([
            ['premise', [finding.id]],
            ['tone', [finding.id]]
        ]);
        expect(planned(store, story)).toEqual(['premise', 'tone']);

        lock(store, story.id, idForKey(groups, 'premise'));

        // D-66's completeness check is answered against the work that CAN land, so the set shrinks to
        // `tone` and the sweep dispatches it rather than holding the pair back forever. A lock that parked
        // every defect crossing it is the failure mode this pins shut.
        expect(owed(store, story)).toEqual([['tone', [finding.id]]]);
        expect(planned(store, story)).toEqual(['tone']);

        lock(store, story.id, idForKey(groups, 'tone'));

        // The second lock removes the last writable group, so the claim has no text left to answer it:
        // `locks.ts` discards the row at the moment that becomes true, and a discarded row drives no work
        // — which is also why the drain probe and the batch cannot disagree about a locked book.
        expect(owed(store, story)).toEqual([]);
        expect(planned(store, story)).toEqual([]);
        expect(store.findings.require(finding.id).state).toBe('discarded');
    });

    it('drops a locked group from a target list cut before the lock landed, so no claim key is spent on a refused batch', () => {
        const { store, story, groups } = lockedBook([]);
        const finding = defect(store, story.id, groups, ['premise', 'tone'], 'stale');
        // The list the planner was handed BEFORE the Author froze `premise`.
        const targets = groupWorkTargets(store, store.stories.require(story.id));

        expect(targets.map((target) => target.group.key)).toEqual(['premise', 'tone']);

        lock(store, story.id, idForKey(groups, 'premise'));

        const locked = store.stories.require(story.id);

        // A fresh read drops the frozen group: a locked group's text is the fixed point, and offering it
        // would spend an attempt on a batch the install refuses (`revisions.ts:installGroupRevisions`).
        expect(groupWorkTargets(store, locked).map((target) => target.group.key)).toEqual(['tone']);
        // THE STALE LIST IS THE RACE — the queue cut its batch off the pre-lock rows and the lock landed in
        // between. The cut filters BEFORE it forms sets, so the sweep dispatches `tone` alone rather than
        // the pair: with the locked group in the set the install would refuse the WHOLE batch (R2's
        // atomicity), the claim key would be spent, and the defect would park for another sweep.
        expect(planGroupDraftBatch(store, locked, targets).map((target) => target.group.key)).toEqual(['tone']);
        // And a list whose only member is locked dispatches NOTHING at all — "offer nothing" is the answer
        // that keeps an empty batch from burning an attempt (`planGroupDraftBatch`'s empty contract).
        expect(
            planGroupDraftBatch(store, locked, targets.filter((target) => target.group.key === 'premise'))
        ).toEqual([]);
    });
});
