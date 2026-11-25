// THE PHRASE GROUP LOCK — locking a group's current text, what that does to the loop's work and to the
// findings about it, and unlocking it again.
//
// WHY EXACT VALUES: a lock is a promise about FOUR things at once — the text does not move, the finding
// stops being work, the batch skips the group, and the unlock gives none of it back — and each promise
// is only falsifiable by naming the row it holds. So every assertion below is the whole projection
// (content, revision, the four lock fields), the whole `missing`/`owed`/`targeted` array, the whole
// journal sentence, or the whole row list. A `toBe(true)` here would pass while the lock silently
// minted a revision, left a finding blocking a clean verdict, or dropped the group from the book.
//
// THE FIXTURE: real store, real catalog rows, and every group text written through
// `revisions.ts:installGroupRevisions` — the only write path a group text has — so the revision a lock
// fixes is a row the install actually wrote, not a fixture shaped to look like one.
import { describe, expect, it } from 'vitest';
import { Store } from '../store';
import { AUTHOR_ATTR, seedFinding, seedStory } from '../run/mock';
import { recordUidAt } from '../store/persist';
import { ensurePhraseCatalog } from './catalog';
import { installGroupRevisions } from './revisions';
import { lockPhraseGroup, unlockPhraseGroup, editorGroupLockingEnabled, PhraseLockRefusal } from './locks';
import {
    closeFindingWhenGroupsResolved,
    findingActionableScope,
    findingGroupScope,
    findingGroupsStillOwed,
    findingResolution
} from './findings';
import { groupPipelineOwed, groupWorkTargets, planGroupDraftBatch } from './exclusion';
import type { Finding, PhraseGroup, Story } from '../../shared/types';
import type { Attribution } from '../store';

/** The clock the lock writes verbatim, so `locked_at` is assertable without a probe run. */
const AT = '2026-11-25T10:00:00.000Z';
/** The attribution the Author's lock route writes under (D-20a: a direct write, not a proposal). */
const LOCK_ATTR: Attribution = { run_ref: null, author: true, why: 'the Author locked the Premise (group lock)' };
const UNLOCK_ATTR: Attribution = { run_ref: null, author: true, why: 'the Author unlocked the Premise (group lock)' };
/** The install's attribution — `run_ref` rides onto the revision row and the group's `updated_by` (P11). */
const WRITE_ATTR: Attribution = { run_ref: 'run_writer', author: false, why: 'seed: the Writer installed the group text (R2)' };

/** The five texts, in catalog order — the Overview the lock freezes. */
const TEXTS: Array<[string, string]> = [
    ['premise', 'A cartographer returns to a valley the reservoir redrew.'],
    ['promise', 'The map and the territory reconcile in the last chapter.'],
    ['theme', 'A map is a claim, not a fact.'],
    ['tone', 'Plain, cold, precise.'],
    ['ending', 'She floods the valley on purpose.']
];

/** A Story whose five groups each hold revision 1, with the catalog ids pinned. */
function writtenBook(init: { editor_group_locking?: boolean } = {}) {
    const store = Store.empty();
    let next = 0;
    const seeded = seedStory(store, { phase: 'summary' });

    ensurePhraseCatalog(store, seeded, AUTHOR_ATTR, { newId: () => recordUidAt(next++) });

    if (init.editor_group_locking === true) {
        store.stories.update(
            seeded.id,
            { editor_group_locking: true },
            AUTHOR_ATTR,
            [{ id: seeded.id, rev: seeded.rev }]
        );
    }

    const idOf = (key: string) => store.phraseGroups.list().find((row) => row.key === key)!.id;

    for (const [key, content] of TEXTS) {
        installGroupRevisions(
            store,
            store.stories.require(seeded.id),
            [{ group: store.phraseGroups.require(idOf(key)), content }],
            WRITE_ATTR,
            { runRef: 'run_writer', workItemRef: `wi_group_write_test_${key}` }
        );
    }

    const story = (): Story => store.stories.require(seeded.id);
    const group = (key: string): PhraseGroup => store.phraseGroups.require(idOf(key));

    return { store, story, group, idOf, storyId: seeded.id };
}

type Book = ReturnType<typeof writtenBook>;

/** The lock as the row and the wire carry it — every field the contract names, plus the text it froze. */
const lockOf = (book: Book, key: string) => {
    const group = book.group(key);

    return {
        key: group.key,
        content: group.content,
        revision: group.revision,
        updated_by: group.updated_by,
        locked: group.locked,
        locked_revision: group.locked_revision,
        locked_by: group.locked_by,
        locked_at: group.locked_at
    };
};

/** Every revision row of the book, as `key:number:state` — what "no revision was invented" is judged on. */
const revisions = (book: Book): string[] =>
    book.store.groupRevisions
        .list()
        .map((row) => `${row.group_key}:${row.number}:${row.state}`)
        .sort();

/** The Overview and its install counter, as the phrase row carries them. */
const phraseOf = (book: Book) => {
    // `ensurePhraseCatalog` mints the phrase row with the FIRST injected uid, the groups after it.
    const phrase = book.store.phrases.require(recordUidAt(0));

    return { revision: phrase.revision, content: phrase.content };
};

/** The legacy mirror's five prose fields (R6) — a lock must not disturb what the install wrote. */
const mirrorOf = (book: Book) => {
    const summary = book.store.summaries.require('summary_0');

    return { premise: summary.premise, promise: summary.promise, theme: summary.theme, tone: summary.tone, ending: summary.ending, locked: summary.locked };
};

/** The journal's tail as an auditable projection: which rows moved, and the sentence each write claims. */
const journalTail = (book: Book, count: number) =>
    book.store.journal.slice(-count).map((event) => ({
        collection: event.collection,
        op: event.op,
        id: event.id,
        run_ref: event.attribution.run_ref,
        author: event.attribution.author,
        why: event.attribution.why
    }));

/** A finding scoped to the given groups (`group_refs` is the only scope field this layer reads). */
function scopedFinding(book: Book, group_refs: string[] | undefined, init: Parameters<typeof seedFinding>[2] = {}): Finding {
    const finding = seedFinding(book.store, book.storyId, { state: 'approved', ...init });

    if (group_refs === undefined) return finding;

    return book.store.findings.update(finding.id, { group_refs }, AUTHOR_ATTR, [
        { id: finding.id, rev: finding.rev }
    ]);
}

/** The refusal a lock call raised, so its `code` and `details` are assertable rather than its prose alone. */
function refusalOf(call: () => unknown): PhraseLockRefusal {
    try {
        call();
    } catch (error) {
        if (error instanceof PhraseLockRefusal) return error;

        throw error;
    }

    throw new Error('expected a PhraseLockRefusal, and the call wrote instead');
}

describe('locking a group fixes its current revision and rewrites nothing', () => {
    it('records the current revision, the actor and the stamp, with no text and no revision row added', () => {
        const book = writtenBook();
        const before = { lock: lockOf(book, 'premise'), rows: revisions(book), phrase: phraseOf(book), mirror: mirrorOf(book) };

        const result = lockPhraseGroup(book.store, book.story(), book.idOf('premise'), LOCK_ATTR, {
            actor: 'author',
            at: AT
        });

        expect({
            locked_revision: result.locked_revision,
            locked_by: result.locked_by,
            locked_at: result.locked_at,
            voided_findings: result.voided_findings,
            group: lockOf(book, 'premise')
        }).toEqual({
            locked_revision: 1,
            locked_by: 'author',
            locked_at: AT,
            // Nothing to void: the book has no findings.
            voided_findings: [],
            group: {
                key: 'premise',
                content: 'A cartographer returns to a valley the reservoir redrew.',
                revision: 1,
                updated_by: 'run_writer',
                locked: true,
                locked_revision: 1,
                locked_by: 'author',
                locked_at: AT
            }
        });
        // THE TEXT IS UNTOUCHED, end to end: no new revision row, no Overview recomposition, no mirror
        // rewrite, and the group's own `content` is the bytes the Writer installed (requirement 1).
        expect(revisions(book)).toEqual(before.rows);
        expect(phraseOf(book)).toEqual(before.phrase);
        expect(mirrorOf(book)).toEqual(before.mirror);
        // One journaled write, attributed to the Author, naming the rule.
        expect(journalTail(book, 1)).toEqual([
            {
                collection: 'phrase_groups',
                op: 'update',
                id: recordUidAt(1),
                run_ref: null,
                author: true,
                why: 'the Author locked the Premise (group lock)'
            }
        ]);
    });

    it('refuses an unwritten group, because a lock has no revision to fix', () => {
        const store = Store.empty();
        let next = 0;
        const story = seedStory(store, { phase: 'summary' });
        const ensured = ensurePhraseCatalog(store, story, AUTHOR_ATTR, { newId: () => recordUidAt(next++) })!;
        const events = store.journal.length;

        const refusal = refusalOf(() =>
            lockPhraseGroup(store, story, recordUidAt(1), LOCK_ATTR, { actor: 'author', at: AT })
        );

        expect({ code: refusal.code, details: refusal.details }).toEqual({
            code: 'group_unwritten',
            details: {
                story_id: 'story_0',
                group_id: recordUidAt(1),
                group_key: 'premise',
                revision: 0,
                actor: 'author'
            }
        });
        expect(refusal.message).toBe(
            'lockPhraseGroup: premise has no written text (revision 0), so there is no revision for a lock to fix — the loop writes it, or the Author edits it, and then the lock lands on that text'
        );
        // The refusal happened before the write: the row still says "unwritten" and carries no lock
        // field at all, and nothing was journaled.
        const unwritten = store.phraseGroups.require(recordUidAt(1));

        expect({
            content: unwritten.content,
            revision: unwritten.revision,
            locked: unwritten.locked,
            locked_revision: unwritten.locked_revision
        }).toEqual({ content: '', revision: 0, locked: undefined, locked_revision: undefined });
        expect(ensured.groups).toHaveLength(5);
        expect(store.journal).toHaveLength(events);
    });

    it('refuses a second lock on a locked group, and an id this Story does not have', () => {
        const book = writtenBook();

        lockPhraseGroup(book.store, book.story(), book.idOf('premise'), LOCK_ATTR, { actor: 'author', at: AT });

        const events = book.store.journal.length;
        const again = refusalOf(() =>
            lockPhraseGroup(book.store, book.story(), book.idOf('premise'), LOCK_ATTR, { actor: 'author', at: '2026-11-25T11:00:00.000Z' })
        );

        expect({ code: again.code, details: again.details }).toEqual({
            code: 'already_locked',
            details: {
                story_id: 'story_0',
                group_id: recordUidAt(1),
                group_key: 'premise',
                locked_revision: 1,
                actor: 'author'
            }
        });
        expect(again.message).toBe(
            'lockPhraseGroup: premise is already locked at revision 1 by author — the Author unlocks it first, and a second lock would only re-date a decision the book already carries'
        );

        const missing = refusalOf(() => lockPhraseGroup(book.store, book.story(), 'group_7', LOCK_ATTR, { actor: 'author', at: AT }));

        expect({ code: missing.code, message: missing.message }).toEqual({
            code: 'group_not_found',
            message: 'lockPhraseGroup: group_7 is not one of story story_0\'s phrase groups — a lock names a group this book has'
        });
        // The re-dated lock never landed either: `locked_at` is still the first lock's stamp.
        expect(lockOf(book, 'premise').locked_at).toBe(AT);
        expect(book.store.journal).toHaveLength(events);
    });

    it('gates the Editor on the Story’s setting and never the Author', () => {
        const book = writtenBook();

        expect(editorGroupLockingEnabled(book.story())).toBe(false);

        const refused = refusalOf(() =>
            lockPhraseGroup(book.store, book.story(), book.idOf('premise'), LOCK_ATTR, { actor: 'editor', at: AT })
        );

        expect({ code: refused.code, details: refused.details }).toEqual({
            code: 'editor_locking_disabled',
            details: { story_id: 'story_0', group_id: recordUidAt(1), group_key: 'premise', actor: 'editor' }
        });
        expect(book.store.phraseGroups.require(book.idOf('premise')).locked).toBeUndefined();

        // The setting on, and the same Editor call locks — as the Editor, not as the Author.
        book.store.stories.update(book.storyId, { editor_group_locking: true }, AUTHOR_ATTR, [
            { id: book.storyId, rev: book.story().rev }
        ]);

        expect(editorGroupLockingEnabled(book.story())).toBe(true);

        const locked = lockPhraseGroup(book.store, book.story(), book.idOf('tone'), LOCK_ATTR, { actor: 'editor', at: AT });

        expect({ locked_revision: locked.locked_revision, locked_by: locked.locked_by, locked_at: locked.locked_at }).toEqual({
            locked_revision: 1,
            locked_by: 'editor',
            locked_at: AT
        });
        expect(lockOf(book, 'tone')).toEqual({
            key: 'tone',
            content: 'Plain, cold, precise.',
            revision: 1,
            updated_by: 'run_writer',
            locked: true,
            locked_revision: 1,
            locked_by: 'editor',
            locked_at: AT
        });
        // The Author needs no setting at all, and the Editor's lock is journaled as the Editor's write.
        expect(lockPhraseGroup(book.store, book.story(), book.idOf('premise'), LOCK_ATTR, { actor: 'author', at: AT }).locked_by).toBe('author');
    });
});

describe('a lock voids the findings about the text it froze', () => {
    it('discards a finding whose whole scope is now locked, with the sentence the Author reads', () => {
        const book = writtenBook();
        const finding = scopedFinding(book, [book.idOf('premise')], { title: 'the Premise contradicts the Ending' });

        const result = lockPhraseGroup(book.store, book.story(), book.idOf('premise'), LOCK_ATTR, { actor: 'author', at: AT });

        expect(result.voided_findings).toEqual([
            { finding_id: 'finding_0', previous_state: 'approved', scope: [recordUidAt(1)] }
        ]);
        // `discarded` is the established void state (D-33c: `fixed`/`discarded` are what close a row).
        expect(book.store.findings.require(finding.id).state).toBe('discarded');
        expect(journalTail(book, 1)).toEqual([
            {
                collection: 'findings',
                op: 'update',
                id: 'finding_0',
                run_ref: null,
                author: true,
                why: 'the Author locked the Premise (group lock); discarded finding_0 because every group it names (premise) is locked, so the claim has no text left to answer it (group lock)'
            }
        ]);
        // A void claim is neither open nor owed: nothing in the work reads counts it.
        expect(findingResolution(book.store, book.story(), finding)).toEqual({
            finding_id: 'finding_0',
            targeted: [recordUidAt(1)],
            resolved: [],
            missing: [],
            resolved_all: true
        });
        expect(findingGroupsStillOwed(book.store, book.story(), finding)).toEqual([]);
        expect(groupWorkTargets(book.store, book.story())).toEqual([]);
    });

    it('keeps a cross-group finding open, actionable for the unlocked group only', () => {
        const book = writtenBook();
        const finding = scopedFinding(book, [book.idOf('premise'), book.idOf('ending')], {
            title: 'the Ending does not keep the Premise'
        });

        const result = lockPhraseGroup(book.store, book.story(), book.idOf('premise'), LOCK_ATTR, { actor: 'author', at: AT });

        expect(result.voided_findings).toEqual([]);
        expect(book.store.findings.require(finding.id).state).toBe('approved');
        // The ATTRIBUTION still names both groups; the ACTABLE half is the one that can move.
        expect(findingGroupScope(book.store, book.story(), finding)).toEqual({
            refs: [recordUidAt(1), recordUidAt(5)],
            unscoped: false
        });
        expect(findingActionableScope(book.store, book.story(), finding)).toEqual({
            refs: [recordUidAt(1), recordUidAt(5)],
            unscoped: false,
            locked_refs: [recordUidAt(1)],
            unlocked_refs: [recordUidAt(5)],
            voided: false
        });
        // The locked half is neither answered nor owed, so the debt is exactly the unlocked group.
        expect(findingResolution(book.store, book.story(), finding)).toEqual({
            finding_id: 'finding_0',
            targeted: [recordUidAt(1), recordUidAt(5)],
            resolved: [],
            missing: [recordUidAt(5)],
            resolved_all: false
        });
        expect(findingGroupsStillOwed(book.store, book.story(), finding).map((group) => group.key)).toEqual(['ending']);
    });

    it('reads an unscoped finding as the remaining groups, never as nothing, until the last lock lands', () => {
        const book = writtenBook();
        const finding = scopedFinding(book, undefined, { title: 'the Overview has no through-line' });

        // The legacy whole-Overview scope IS all five groups, before and after four locks.
        expect(findingGroupScope(book.store, book.story(), finding).refs).toEqual([
            recordUidAt(1),
            recordUidAt(2),
            recordUidAt(3),
            recordUidAt(4),
            recordUidAt(5)
        ]);

        for (const key of ['premise', 'promise', 'theme', 'tone']) {
            expect(lockPhraseGroup(book.store, book.story(), book.idOf(key), LOCK_ATTR, { actor: 'author', at: AT }).voided_findings).toEqual([]);
        }

        expect(findingActionableScope(book.store, book.story(), finding)).toEqual({
            refs: [recordUidAt(1), recordUidAt(2), recordUidAt(3), recordUidAt(4), recordUidAt(5)],
            unscoped: true,
            locked_refs: [recordUidAt(1), recordUidAt(2), recordUidAt(3), recordUidAt(4)],
            unlocked_refs: [recordUidAt(5)],
            voided: false
        });
        // Four of five locked has NOT emptied the scope: the whole-Overview claim is still work for the
        // group that stays writable.
        expect(findingGroupsStillOwed(book.store, book.story(), finding).map((group) => group.key)).toEqual(['ending']);

        const fifth = lockPhraseGroup(book.store, book.story(), book.idOf('ending'), LOCK_ATTR, { actor: 'author', at: AT });

        expect(fifth.voided_findings).toEqual([
            {
                finding_id: 'finding_0',
                previous_state: 'approved',
                scope: [recordUidAt(1), recordUidAt(2), recordUidAt(3), recordUidAt(4), recordUidAt(5)]
            }
        ]);
        expect(book.store.findings.require(finding.id).state).toBe('discarded');
    });

    it('leaves a terminal finding alone, and voids one that is still open in any rung of the ladder', () => {
        const book = writtenBook();

        for (const state of ['unconfirmed', 'confirmed', 'approved', 'disputed', 'fixed', 'discarded'] as const) {
            scopedFinding(book, [book.idOf('premise')], { state, title: `a claim in state ${state}` });
        }

        lockPhraseGroup(book.store, book.story(), book.idOf('premise'), LOCK_ATTR, { actor: 'author', at: AT });

        // The four open rungs become the void state; the two terminal ones keep the history they had.
        expect(book.store.findings.list().map((row) => [row.id, row.state])).toEqual([
            ['finding_0', 'discarded'],
            ['finding_1', 'discarded'],
            ['finding_2', 'discarded'],
            ['finding_3', 'discarded'],
            ['finding_4', 'fixed'],
            ['finding_5', 'discarded']
        ]);
    });
});

describe('locked groups drive no work, and a cross-group finding still gets its batch', () => {
    it('routes a cross-group finding to the unlocked half and cuts the batch from it', () => {
        const book = writtenBook();
        const finding = scopedFinding(book, [book.idOf('premise'), book.idOf('ending')], {
            title: 'the Ending does not keep the Premise'
        });

        for (const key of ['premise', 'promise', 'theme', 'tone']) {
            lockPhraseGroup(book.store, book.story(), book.idOf(key), LOCK_ATTR, { actor: 'author', at: AT });
        }

        const targets = groupWorkTargets(book.store, book.story()).map((target) => ({
            key: target.group.key,
            locked: target.group.locked,
            findingRefs: target.findingRefs
        }));

        // One target, and it is the writable half of the defect — not the whole finding set parked.
        expect(targets).toEqual([{ key: 'ending', locked: undefined, findingRefs: [finding.id] }]);
        // D-66's completeness check sees the set as WHOLE, because the locked group is not owed.
        expect(planGroupDraftBatch(book.store, book.story(), groupWorkTargets(book.store, book.story())).map((target) => target.group.key)).toEqual([
            'ending'
        ]);
        // The drain probe reads the same list, so "owed" and "done" agree. No run rows yet, so the five
        // structured Critic seats of the current vector are still owed.
        expect(groupPipelineOwed(book.store, book.story())).toEqual({
            drafts: 1,
            structuredReviews: 5,
            deepReviews: 0
        });

        // The unlocked half lands, and the finding may then close over the locked baseline.
        installGroupRevisions(
            book.store,
            book.story(),
            [{ group: book.group('ending'), content: 'She floods the valley to keep the first promise.' }],
            WRITE_ATTR,
            { runRef: 'run_writer_2', findingRefs: [finding.id] }
        );

        const closed = closeFindingWhenGroupsResolved(book.store, book.store.findings.require(finding.id), WRITE_ATTR);

        expect(closed.closed).toBe(true);
        expect(closed.resolution.resolved).toEqual([recordUidAt(5)]);
        expect(book.store.findings.require(finding.id).state).toBe('fixed');
        // The journal says which half the lock made moot, rather than crediting the locked group.
        expect(journalTail(book, 1)[0]!.why).toBe(
            'seed: the Writer installed the group text (R2); closed finding_0 because every group it names (ending) has a revision written to resolve it; premise is locked, so the claim is void for that group (R3, D-34)'
        );
        // The locked group never moved through any of this.
        expect(lockOf(book, 'premise')).toEqual({
            key: 'premise',
            content: 'A cartographer returns to a valley the reservoir redrew.',
            revision: 1,
            updated_by: 'run_writer',
            locked: true,
            locked_revision: 1,
            locked_by: 'author',
            locked_at: AT
        });
    });

    it('offers a locked group to no batch, and owes nothing when every group is locked', () => {
        const book = writtenBook();

        scopedFinding(book, undefined, { title: 'the Overview has no through-line' });

        // Before any lock: the whole-Overview claim routes to all five groups (R3's legacy reading).
        expect(groupWorkTargets(book.store, book.story()).map((target) => target.group.key)).toEqual([
            'premise',
            'promise',
            'theme',
            'tone',
            'ending'
        ]);

        for (const key of ['premise', 'promise', 'theme', 'tone']) {
            lockPhraseGroup(book.store, book.story(), book.idOf(key), LOCK_ATTR, { actor: 'author', at: AT });
        }

        expect(groupWorkTargets(book.store, book.story()).map((target) => target.group.key)).toEqual(['ending']);

        // A caller handing over a stale target list that still names locked groups gets them stripped, so
        // no set is dispatched whose install the lock would refuse.
        const stale = [
            { group: book.group('premise'), findingRefs: [] },
            { group: book.group('ending'), findingRefs: [] }
        ];

        expect(planGroupDraftBatch(book.store, book.story(), stale).map((target) => target.group.key)).toEqual(['ending']);

        for (const key of ['ending']) {
            lockPhraseGroup(book.store, book.story(), book.idOf(key), LOCK_ATTR, { actor: 'author', at: AT });
        }

        // A finding wholly against locked groups drives no work, so the drain owes no draft.
        expect(groupWorkTargets(book.store, book.story())).toEqual([]);
        expect(planGroupDraftBatch(book.store, book.story(), [{ group: book.group('premise'), findingRefs: [] }])).toEqual([]);
        expect(groupPipelineOwed(book.store, book.story())).toEqual({
            drafts: 0,
            structuredReviews: 5,
            deepReviews: 0
        });
    });

    it('refuses to close a claim raised after its whole scope was locked, because nothing answered it', () => {
        const book = writtenBook();

        lockPhraseGroup(book.store, book.story(), book.idOf('theme'), LOCK_ATTR, { actor: 'author', at: AT });

        // Raised AFTER the lock, so the lock had nothing to discard and the row is still `approved`.
        const finding = scopedFinding(book, [book.idOf('theme')], { title: 'the Theme is stated, not dramatised' });

        expect(findingActionableScope(book.store, book.story(), finding)).toEqual({
            refs: [recordUidAt(3)],
            unscoped: false,
            locked_refs: [recordUidAt(3)],
            unlocked_refs: [],
            voided: true
        });
        // Void: it does not count as missing, and it does not count as answered either.
        expect(findingResolution(book.store, book.story(), finding)).toEqual({
            finding_id: 'finding_0',
            targeted: [recordUidAt(3)],
            resolved: [],
            missing: [],
            resolved_all: true
        });
        expect(closeFindingWhenGroupsResolved(book.store, finding, WRITE_ATTR).closed).toBe(false);
        expect(book.store.findings.require(finding.id).state).toBe('approved');
        expect(groupWorkTargets(book.store, book.story())).toEqual([]);
    });
});

describe('unlocking restores writability without rewriting anything', () => {
    it('clears the lock fields, keeps the text and the revision, and invents no revision row', () => {
        const book = writtenBook();

        lockPhraseGroup(book.store, book.story(), book.idOf('premise'), LOCK_ATTR, { actor: 'author', at: AT });
        scopedFinding(book, [book.idOf('premise')], { title: 'the Premise contradicts the Ending' });
        const before = { rows: revisions(book), phrase: phraseOf(book), mirror: mirrorOf(book), content: lockOf(book, 'premise').content };

        const result = unlockPhraseGroup(book.store, book.story(), book.idOf('premise'), UNLOCK_ATTR, { actor: 'author' });

        expect({ unlocked_revision: result.unlocked_revision, actor: result.actor }).toEqual({
            unlocked_revision: 1,
            actor: 'author'
        });
        // `locked: false` and the metadata cleared to null — the shape the wire reads (requirement 1/7).
        expect(lockOf(book, 'premise')).toEqual({
            key: 'premise',
            content: before.content,
            revision: 1,
            updated_by: 'run_writer',
            locked: false,
            locked_revision: null,
            locked_by: null,
            locked_at: null
        });
        expect(revisions(book)).toEqual(before.rows);
        expect(phraseOf(book)).toEqual(before.phrase);
        expect(mirrorOf(book)).toEqual(before.mirror);
        expect(journalTail(book, 1)).toEqual([
            {
                collection: 'phrase_groups',
                op: 'update',
                id: recordUidAt(1),
                run_ref: null,
                author: true,
                why: 'the Author unlocked the Premise (group lock); premise revision 1 stopped being fixed text (group lock lifted)'
            }
        ]);

        // And the group is writable again, through the ordinary install path.
        installGroupRevisions(
            book.store,
            book.story(),
            [{ group: book.group('premise'), content: 'A cartographer maps a valley that has moved.' }],
            WRITE_ATTR,
            { runRef: 'run_writer_2' }
        );

        expect(lockOf(book, 'premise').revision).toBe(2);
        expect(revisions(book)).toContain('premise:2:latest');
    });

    it('refuses an unlock on an unlocked group, and any Editor unlock', () => {
        const book = writtenBook();

        const notLocked = refusalOf(() => unlockPhraseGroup(book.store, book.story(), book.idOf('premise'), UNLOCK_ATTR, { actor: 'author' }));

        expect({ code: notLocked.code, message: notLocked.message, details: notLocked.details }).toEqual({
            code: 'not_locked',
            message: "unlockPhraseGroup: premise is not locked, so there is nothing to lift — the loop already has this group's text to work on",
            details: { story_id: 'story_0', group_id: recordUidAt(1), group_key: 'premise', actor: 'author' }
        });
        // A never-locked row keeps the shape a pre-lock book has: no lock fields written at all.
        expect(lockOf(book, 'premise')).toEqual({
            key: 'premise',
            content: 'A cartographer returns to a valley the reservoir redrew.',
            revision: 1,
            updated_by: 'run_writer',
            locked: undefined,
            locked_revision: undefined,
            locked_by: undefined,
            locked_at: undefined
        });

        lockPhraseGroup(book.store, book.story(), book.idOf('premise'), LOCK_ATTR, { actor: 'author', at: AT });
        const events = book.store.journal.length;

        // The Editor may lock on an enabling Story; it may never LIFT a lock, enabling or not.
        book.store.stories.update(book.storyId, { editor_group_locking: true }, AUTHOR_ATTR, [
            { id: book.storyId, rev: book.story().rev }
        ]);

        const editor = refusalOf(() => unlockPhraseGroup(book.store, book.story(), book.idOf('premise'), UNLOCK_ATTR, { actor: 'editor' }));

        expect({ code: editor.code, message: editor.message, details: editor.details }).toEqual({
            code: 'editor_unlock',
            message: "unlockPhraseGroup: only the Author lifts a group lock (editor asked for 00000000-0000-4000-8000-000000000001) — the lock stopped the loop rewriting the text, and deciding to let it try again is the Author's call, not the crew's",
            details: { story_id: 'story_0', group_id: recordUidAt(1), actor: 'editor' }
        });
        expect(lockOf(book, 'premise')).toEqual({
            key: 'premise',
            content: 'A cartographer returns to a valley the reservoir redrew.',
            revision: 1,
            updated_by: 'run_writer',
            locked: true,
            locked_revision: 1,
            locked_by: 'author',
            locked_at: AT
        });
        // The only journal line after the lock is the Story's own setting write: a refusal adds nothing.
        expect(book.store.journal).toHaveLength(events + 1);
    });

    it('does not resurrect the findings the lock voided, and makes the group owed again', () => {
        const book = writtenBook();
        const voided = scopedFinding(book, [book.idOf('premise')], { title: 'the Premise contradicts the Ending' });
        const crossGroup = scopedFinding(book, [book.idOf('premise'), book.idOf('ending')], { title: 'the Ending does not keep the Premise' });

        lockPhraseGroup(book.store, book.story(), book.idOf('premise'), LOCK_ATTR, { actor: 'author', at: AT });

        expect(book.store.findings.require(voided.id).state).toBe('discarded');
        expect(findingGroupsStillOwed(book.store, book.story(), crossGroup).map((group) => group.key)).toEqual(['ending']);
        // The locked group is out of the batch and the voided row is out of every `findingRefs` list:
        // one target, named only by the claim that is still open.
        expect(
            groupWorkTargets(book.store, book.story()).map((target) => ({ key: target.group.key, findingRefs: target.findingRefs }))
        ).toEqual([{ key: 'ending', findingRefs: [crossGroup.id] }]);

        unlockPhraseGroup(book.store, book.story(), book.idOf('premise'), UNLOCK_ATTR, { actor: 'author' });

        // Requirement 7: the discard is terminal — an unlock is not an undo of the Author's decision.
        expect(book.store.findings.require(voided.id).state).toBe('discarded');
        // The live claim's scope read is a READ: the group is actionable again with nothing rewritten.
        expect(findingActionableScope(book.store, book.story(), crossGroup)).toEqual({
            refs: [recordUidAt(1), recordUidAt(5)],
            unscoped: false,
            locked_refs: [],
            unlocked_refs: [recordUidAt(1), recordUidAt(5)],
            voided: false
        });
        expect(findingGroupsStillOwed(book.store, book.story(), crossGroup).map((group) => group.key)).toEqual([
            'premise',
            'ending'
        ]);
        // The reopened work names the live claim only: the discarded row never came back.
        expect(
            groupWorkTargets(book.store, book.story()).map((target) => ({ key: target.group.key, findingRefs: target.findingRefs }))
        ).toEqual([
            { key: 'premise', findingRefs: [crossGroup.id] },
            { key: 'ending', findingRefs: [crossGroup.id] }
        ]);
        expect(book.store.phraseGroups.require(book.idOf('premise')).content).toBe(
            'A cartographer returns to a valley the reservoir redrew.'
        );
    });
});
