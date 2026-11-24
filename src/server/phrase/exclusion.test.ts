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
import { describe, expect, it } from 'vitest';
import { Store } from '../store';
import { AUTHOR_ATTR, seedStory } from '../run/mock';
import { recordUidAt } from '../store/persist';
import { ensurePhraseCatalog } from './catalog';
import {
    GROUP_DRAFT_ITEM_PREFIX,
    GROUP_HOLDING_KINDS,
    groupItemPrefixOf,
    heldGroupRefs,
    liveGroupRefs,
    liveGroupSets,
    partitionGroupRefs,
    partitionGroups
} from './exclusion';
import type { Run } from '../../shared/types';

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
    init: { work_item_ref: string; state?: Run['state']; group_refs?: string[]; role?: 'writer' | 'reader' }
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
            role: 'reader',
            group_refs: idsOf(groups)
        });
        seedRun(store, story.id, {
            work_item_ref: 'wi_group_check_590ac70fe3cccdb3_1',
            role: 'reader',
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
