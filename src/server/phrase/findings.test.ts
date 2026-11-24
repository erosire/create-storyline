// The finding lifecycle a group-managed book adds (R3): scope, per-group resolution, the closure
// rule, and the routing read for the work still owed.
//
// WHY EXACT VALUES: R3's sentence — "a multi-group finding closes only when EVERY group it names has
// a revision written to resolve it" — is a rule about a SET, so it is pinned as one: the exact
// `targeted`/`resolved`/`missing` arrays at each step, the exact state and journal line of the closed
// row, and the exact groups the next Writer batch is routed to. A partial fix must read as
// unresolved, and that is only visible if the arrays are named.
//
// THE FIXTURE: real store, real catalog rows, real installs (`installGroupRevisions`), so the
// "resolving revision" is a row the install actually wrote rather than a fixture shaped to look like
// one. `seedFinding` covers the finding's legacy fields; only `group_refs` is set here.
import { describe, expect, it } from 'vitest';
import { Store } from '../store';
import { AUTHOR_ATTR, seedFinding, seedStory } from '../run/mock';
import { recordUidAt } from '../store/persist';
import { ensurePhraseCatalog } from './catalog';
import { installGroupRevisions } from './revisions';
import {
    closeFindingWhenGroupsResolved,
    findingGroupScope,
    findingGroupsStillOwed,
    findingResolution,
    findingTargetGroups,
    groupResolvesFinding
} from './findings';
import type { Finding } from '../../shared/types';
import type { Attribution } from '../store';

/** The attribution a settlement writes under — its `why` shows up verbatim in the closure sentence. */
const SETTLE: Attribution = { run_ref: 'run_0', author: false, why: 'settle wi_draft_groups_summary_0_590ac70fe3cccdb3_1' };

function seedBook() {
    const store = Store.empty();
    const story = seedStory(store, { phase: 'summary' });
    let next = 0;
    const ensured = ensurePhraseCatalog(store, story, AUTHOR_ATTR, { newId: () => recordUidAt(next++) })!;

    return { store, story, groups: ensured.groups };
}

const idOf = (groups: Array<{ id: string; key: string }>, key: string) =>
    groups.find((group) => group.key === key)!.id;
// The install CASes the GROUP ROW, so a test that wants to call it has to hand over the PERSISTED row —
// `ensurePhraseCatalog`'s return value is the lighter shape the catalog builds, not the row.
const rowOf = (store: Store, groups: Array<{ id: string; key: string }>, key: string) =>
    store.phraseGroups.require(idOf(groups, key));

/** A finding scoped to the given groups (`group_refs` is the only field this layer reads). */
function scopedFinding(
    store: Store,
    storyId: string,
    group_refs: string[] | undefined,
    init: Parameters<typeof seedFinding>[2] = {}
): Finding {
    const finding = seedFinding(store, storyId, { state: 'approved', ...init });

    if (group_refs === undefined) return finding;

    return store.findings.update(finding.id, { group_refs }, AUTHOR_ATTR, [{ id: finding.id, rev: finding.rev }]);
}

describe('a finding’s group scope (R3)', () => {
    it('reads an unscoped finding as the whole Overview, in catalog order', () => {
        const { store, story, groups } = seedBook();
        const finding = scopedFinding(store, story.id, undefined, { title: 'the Ending contradicts the Premise' });

        expect(findingGroupScope(store, story, finding)).toEqual({
            refs: [recordUidAt(1), recordUidAt(2), recordUidAt(3), recordUidAt(4), recordUidAt(5)],
            // The legacy reading: a finding that named no group is about every group.
            unscoped: true
        });
        expect(findingTargetGroups(store, story, finding).map((group) => group.key)).toEqual([
            'premise',
            'promise',
            'theme',
            'tone',
            'ending'
        ]);
        // Unscoped means ALL five must be rewritten before it may close — the expensive end of R3, and
        // the reason `tools/checker.ts:raiseFinding` asks a group book to name its groups.
        expect(findingResolution(store, story, finding)).toEqual({
            finding_id: 'finding_0',
            targeted: [recordUidAt(1), recordUidAt(2), recordUidAt(3), recordUidAt(4), recordUidAt(5)],
            resolved: [],
            missing: [recordUidAt(1), recordUidAt(2), recordUidAt(3), recordUidAt(4), recordUidAt(5)],
            resolved_all: false
        });
    });

    it('restores catalog order to a scoped finding however the reporter sent it', () => {
        const { store, story, groups } = seedBook();
        const finding = scopedFinding(store, story.id, [idOf(groups, 'ending'), idOf(groups, 'premise')]);

        expect(findingGroupScope(store, story, finding)).toEqual({
            refs: [recordUidAt(1), recordUidAt(5)],
            unscoped: false
        });
        expect(findingTargetGroups(store, story, finding).map((group) => group.key)).toEqual(['premise', 'ending']);
    });

    it('drops ids the Story does not have, and falls back to the whole Overview if none survive', () => {
        const { store, story, groups } = seedBook();

        const half = scopedFinding(store, story.id, [idOf(groups, 'tone'), 'group_7']);

        expect(half.group_refs).toEqual([idOf(groups, 'tone'), 'group_7']);
        expect(findingGroupScope(store, story, half)).toEqual({ refs: [recordUidAt(4)], unscoped: false });

        const none = scopedFinding(store, story.id, ['group_7', recordUidAt(99)]);

        expect(findingGroupScope(store, story, none)).toEqual({
            refs: [recordUidAt(1), recordUidAt(2), recordUidAt(3), recordUidAt(4), recordUidAt(5)],
            unscoped: true
        });
    });
});

describe('a multi-group finding closes only when every named group has answered it (R3)', () => {
    it('refuses a cross-group finding until BOTH named groups install a resolving revision', () => {
        const { store, story, groups } = seedBook();
        const finding = scopedFinding(store, story.id, [idOf(groups, 'promise'), idOf(groups, 'ending')], {
            title: 'the Ending does not keep the Promise',
            cost: 'critical'
        });

        // Nothing written yet: the work is owed to both groups, in catalog order.
        expect(findingResolution(store, story, finding)).toEqual({
            finding_id: 'finding_0',
            targeted: [recordUidAt(2), recordUidAt(5)],
            resolved: [],
            missing: [recordUidAt(2), recordUidAt(5)],
            resolved_all: false
        });
        expect(findingGroupsStillOwed(store, story, finding).map((group) => group.key)).toEqual(['promise', 'ending']);

        // The Promise rewrite lands. The row claims the finding, so one half of the defect is answered.
        installGroupRevisions(
            store,
            story,
            [{ group: rowOf(store, groups, 'promise'), content: 'The book promises the reconciliation is paid in the ending.' }],
            SETTLE,
            { runRef: 'run_0', findingRefs: [finding.id] }
        );

        expect(groupResolvesFinding(store, finding, idOf(groups, 'promise'))?.id).toBe('group_revision_0');
        expect(groupResolvesFinding(store, finding, idOf(groups, 'ending'))).toBeUndefined();

        const partial = findingResolution(store, story, finding);

        expect(partial).toEqual({
            finding_id: 'finding_0',
            targeted: [recordUidAt(2), recordUidAt(5)],
            resolved: [recordUidAt(2)],
            // The honest answer is the work still owed, not "close enough".
            missing: [recordUidAt(5)],
            resolved_all: false
        });

        const firstAttempt = closeFindingWhenGroupsResolved(store, finding, SETTLE);

        expect(firstAttempt.closed).toBe(false);
        expect(firstAttempt.resolution.missing).toEqual([recordUidAt(5)]);
        expect(store.findings.require(finding.id).state).toBe('approved');
        // The routing read sends the NEXT batch to the group that still owes it — and only that one.
        expect(findingGroupsStillOwed(store, story, finding).map((group) => group.key)).toEqual(['ending']);

        // The Ending rewrite. The finding row itself is untouched by this install — the closure is the
        // settlement's write, made in the same sweep.
        installGroupRevisions(
            store,
            story,
            [{ group: rowOf(store, groups, 'ending'), content: 'The last chapter reconciles map and territory.' }],
            SETTLE,
            { runRef: 'run_1', findingRefs: [finding.id] }
        );

        expect(findingResolution(store, story, finding)).toEqual({
            finding_id: 'finding_0',
            targeted: [recordUidAt(2), recordUidAt(5)],
            resolved: [recordUidAt(2), recordUidAt(5)],
            missing: [],
            resolved_all: true
        });
        // Rewritten but not yet settled: the planner owes nothing more.
        expect(findingGroupsStillOwed(store, story, finding)).toEqual([]);

        const closed = closeFindingWhenGroupsResolved(store, store.findings.require(finding.id), SETTLE);

        expect(closed.closed).toBe(true);
        expect(closed.resolution.resolved).toEqual([recordUidAt(2), recordUidAt(5)]);

        const row = store.findings.require(finding.id);

        expect(row.state).toBe('fixed');
        // The journal line says which GROUPS closed it — "run_0 fixed it" is not the truth of this model.
        // (`slice(-1)[0]`, not `.at(-1)`: the package's tsconfig lib predates ES2022 — `run/brief.ts:437`.)
        expect(store.journal.slice(-1)[0]).toMatchObject({
            collection: 'findings',
            op: 'update',
            id: 'finding_0',
            attribution: {
                run_ref: 'run_0',
                why: 'settle wi_draft_groups_summary_0_590ac70fe3cccdb3_1; closed finding_0 because every group it names (promise, ending) has a revision written to resolve it (R3, D-34)'
            }
        });

        // Idempotent: a restart that replays the install changes nothing and writes nothing again.
        const before = store.journal.length;
        const replay = closeFindingWhenGroupsResolved(store, store.findings.require(finding.id), SETTLE);

        expect(replay.closed).toBe(false);
        expect(store.journal).toHaveLength(before);
    });

    it('refuses to close on a revision that does not claim the finding', () => {
        const { store, story, groups } = seedBook();
        const finding = scopedFinding(store, story.id, [idOf(groups, 'premise')]);

        // The same group rewritten for some other reason: without the claim on the row there is no
        // evidence the defect was answered, and an unclaimed rewrite must not close a finding.
        installGroupRevisions(
            store,
            story,
            [{ group: rowOf(store, groups, 'premise'), content: 'A cartographer walks into the drowned valley.' }],
            SETTLE,
            { runRef: 'run_0' }
        );

        expect(store.groupRevisions.require('group_revision_0').finding_refs).toBeUndefined();
        expect(findingResolution(store, story, finding)).toEqual({
            finding_id: 'finding_0',
            targeted: [recordUidAt(1)],
            resolved: [],
            missing: [recordUidAt(1)],
            resolved_all: false
        });
        expect(closeFindingWhenGroupsResolved(store, finding, SETTLE).closed).toBe(false);
    });

    it('keeps the gate: only an approved finding may close here (D-33, D-34)', () => {
        const { store, story, groups } = seedBook();

        for (const state of ['unconfirmed', 'confirmed', 'disputed', 'discarded'] as const) {
            const finding = scopedFinding(store, story.id, [idOf(groups, 'theme')], { state });

            installGroupRevisions(
                store,
                story,
                [{ group: store.phraseGroups.require(idOf(groups, 'theme')), content: `A claim the events answer (${state}).` }],
                SETTLE,
                { runRef: 'run_0', findingRefs: [finding.id] }
            );

            const result = closeFindingWhenGroupsResolved(store, store.findings.require(finding.id), SETTLE);

            // Every one of these is fully rewritten — and not one of them may close. Closing a row the
            // Author has not approved would put the loop above the approval gate.
            expect(result.resolution.resolved_all).toBe(true);
            expect(result.closed).toBe(false);
            expect(store.findings.require(finding.id).state).toBe(state);
        }

        expect(store.findings.list().map((row) => [row.id, row.state])).toEqual([
            ['finding_0', 'unconfirmed'],
            ['finding_1', 'confirmed'],
            ['finding_2', 'disputed'],
            ['finding_3', 'discarded']
        ]);
    });

    it('names the newest claim, and an older superseded claim still counts as an answer', () => {
        const { store, story, groups } = seedBook();
        const finding = scopedFinding(store, story.id, [idOf(groups, 'tone')]);

        installGroupRevisions(
            store,
            story,
            [{ group: rowOf(store, groups, 'tone'), content: 'Plain, cold, precise.' }],
            SETTLE,
            { runRef: 'run_0', findingRefs: [finding.id] }
        );
        installGroupRevisions(
            store,
            story,
            // The second attempt answers the same finding, and it is THIS text the Overview carries.
            [{ group: store.phraseGroups.require(idOf(groups, 'tone')), content: 'Plain, cold, precise, and clipped.' }],
            SETTLE,
            { runRef: 'run_1', findingRefs: [finding.id] }
        );

        expect(store.groupRevisions.list().map((row) => [row.id, row.number, row.state])).toEqual([
            ['group_revision_0', 1, 'archived'],
            ['group_revision_1', 2, 'latest']
        ]);
        expect(groupResolvesFinding(store, finding, idOf(groups, 'tone'))?.id).toBe('group_revision_1');
        expect(closeFindingWhenGroupsResolved(store, store.findings.require(finding.id), SETTLE).closed).toBe(true);
    });

    it('reports a finding whose Story is gone as unresolvable rather than resolved', () => {
        const { store, groups } = seedBook();
        const finding = scopedFinding(store, 'story_0', [idOf(groups, 'premise')]);

        store.stories.delete('story_0', AUTHOR_ATTR);

        const orphan: Finding = store.findings.require(finding.id);

        expect(closeFindingWhenGroupsResolved(store, orphan, SETTLE)).toEqual({
            closed: false,
            resolution: { finding_id: 'finding_0', targeted: [], resolved: [], missing: [], resolved_all: false }
        });
    });
});
