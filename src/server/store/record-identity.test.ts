/**
 * SUMMARY PHRASE R1 — the store's uid-addressed records: the id helpers (`store/persist.ts`) and the one
 * write that preserves an externally-assigned id (`store/store.ts:Collection.createWithId`).
 *
 * WHY THIS FILE EXISTS: the phrase layer's tests all inject `recordUidAt` and never look at the store
 * rule itself. Three things only the store can answer, and each is a decision the redesign depends on:
 *
 *   1. A phrase/group id is an ADDRESS, not a label — routes, a finding's `group_refs` and a Run row's
 *      `group_refs` all quote it, so it has to be mintable before the row exists. `isRecordUid` is the
 *      predicate every such read uses, so its accept/reject list is product behaviour;
 *   2. `createWithId` refuses a counter-shaped id, a re-used id, and a collection whose ids come from
 *      the store's own story identity — the three ways a caller can quietly mint something twice;
 *   3. A refusal writes and journals NOTHING (P1: the store is the memory), so a half-created catalog
 *      cannot survive a restart.
 *
 * The refusal sentences are product copy an agent or an Author reads, so they are pinned verbatim.
 */
import { describe, expect, it } from 'vitest';

import { Store, StoreError } from './store';
import { AUTHOR_ATTR, seedStory } from '../run/mock';
import { isRecordUid, newRecordUid, recordUidAt } from './persist';
import type { Phrase, RecordInit, Story } from '../../shared/types';

/** The catalog row the tests below mint — one entry of the R1 catalog, hand-written. */
const phraseInit = (storyId: string) => ({
    story_id: storyId,
    key: 'summary',
    title: 'Summary',
    description: 'What the book is for.',
    content: '',
    order: 1,
    revision: 0,
    group_refs: []
});

describe('the record uid is an address, and the predicate says what is one (R1)', () => {
    it('mints a v4-shaped uid and reproduces the nth one exactly', () => {
        // `recordUidAt` is what every phrase test injects; pinning its strings is what lets the rest of
        // the suite name a group id literally instead of `expect.any(String)`.
        expect(recordUidAt(0)).toBe('00000000-0000-4000-8000-000000000000');
        expect(recordUidAt(4)).toBe('00000000-0000-4000-8000-000000000004');
        expect(recordUidAt(255)).toBe('00000000-0000-4000-8000-0000000000ff');
        expect(recordUidAt(255)).toBe(recordUidAt(255));
        expect(isRecordUid(recordUidAt(0))).toBe(true);
        // The real factory is not pinned (it is `randomUUID`), only that it satisfies the predicate.
        expect(isRecordUid(newRecordUid())).toBe(true);
    });

    it('rejects a counter label and every malformed address', () => {
        // The first four are the mistakes this predicate exists to catch: a counter id looks like an id
        // and would otherwise be quoted back by a route as though it were addressable.
        const rejected = ['phrase_0', 'group_revision_3', 'premise', 'summary', '', '00000000', 7, null, undefined];

        expect(rejected.map(isRecordUid)).toEqual([false, false, false, false, false, false, false, false, false]);

        // Well-formed v4-shaped strings of either case are accepted (the pattern is hex, not lowercase).
        expect(isRecordUid('00000000-0000-4000-8000-00000000000A'.toLowerCase())).toBe(true);
        expect(isRecordUid('A1B2C3D4-0000-4000-8000-000000000001')).toBe(true);
    });
});

describe('createWithId keeps an assigned id, and refuses the three ways to mint it wrong (R1)', () => {
    it('writes the row under the caller’s id and journals it under the same address', () => {
        const store = Store.empty();
        const story = seedStory(store, { phase: 'summary' });

        const created = store.phrases.createWithId(recordUidAt(0), phraseInit(story.id), AUTHOR_ATTR);
        const row = store.phrases.require(recordUidAt(0));

        // Reads are COPIES (`store.ts:Collection` hands out clones), so the assertion is deep — the point
        // is that the row landed under the id the caller named, not that it is the same object.
        expect(row).toEqual(created);
        // The address is the id the caller named — not `phrase_0`, which is what `create` would mint.
        expect(row.id).toBe('00000000-0000-4000-8000-000000000000');
        expect(row.rev).toBe(1);
        expect(row.key).toBe('summary');
        expect(row.revision).toBe(0);
        expect(row.group_refs).toEqual([]);
        expect(row.created_at).toBe(row.updated_at);
        expect(store.phrases.list().map((record) => record.id)).toEqual([recordUidAt(0)]);
        // The journal entry is written under the SAME address: an audit read of the book finds the row by
        // the id its owner minted, which is the whole point of an address rather than a label.
        expect(store.journal.slice(-1)[0]).toMatchObject({
            collection: 'phrases',
            op: 'create',
            id: '00000000-0000-4000-8000-000000000000',
            attribution: { author: true, run_ref: null }
        });
    });

    it('refuses a counter-shaped id, a re-used id, and a collection the store mints for', () => {
        const store = Store.empty();
        const story = seedStory(store, { phase: 'summary' });

        store.phrases.createWithId(recordUidAt(0), phraseInit(story.id), AUTHOR_ATTR);

        const attempt = (run: () => unknown) => {
            try {
                run();
            } catch (error) {
                return error instanceof StoreError ? error.message : String(error);
            }

            return null;
        };

        // 1. A label is not an address.
        expect(attempt(() => store.phrases.createWithId('phrase_0', phraseInit(story.id), AUTHOR_ATTR))).toBe(
            'the phrase id "phrase_0" is not a UUID (8-4-4-4-12 hexadecimal) — an externally-assigned id is quoted by routes, findings and structured answers, so it must be minted by newRecordUid()'
        );

        // 2. An address is issued once; minting it twice means the caller re-created a row it has.
        expect(attempt(() => store.phrases.createWithId(recordUidAt(0), phraseInit(story.id), AUTHOR_ATTR))).toBe(
            'the phrase id 00000000-0000-4000-8000-000000000000 is already in the phrases collection — an ' +
                'externally-assigned id is issued once, so minting it twice means the caller re-created a row it already has (P1: the store is the memory)'
        );

        // 3. `stories` takes its id from the store's story identity (the registry's folder UUID), so an
        // assigned one is a bug. A `Store.empty()` book mints story ids from its counter, so the case has
        // to bind the factory the story-bound Store binds (`store.ts:_setIdFactory`).
        store.stories._setIdFactory(() => recordUidAt(1));

        // A well-formed init (the guard under test fires before any init validation, but the test should
        // not depend on that ordering: `RecordInit<Story>` is what `createWithId` takes).
        const storyInit: RecordInit<Story> = { ...store.stories.require(story.id) };

        expect(attempt(() => store.stories.createWithId(recordUidAt(1), storyInit, AUTHOR_ATTR))).toBe(
            "the stories collection takes its id from the store's story identity, not from a caller — createWithId is for the collections whose ids are minted by their owner (phrase, group, revision)"
        );

        // P1 — every refusal wrote nothing: the catalog cannot be left half-built for a restart to find.
        expect(store.phrases.list().map((record: Phrase) => record.id)).toEqual([recordUidAt(0)]);
        // The seeded Story is still the only one: the refused `createWithId` never reached the map.
        expect(store.stories.list()).toHaveLength(1);
        // And the journal's last entry is still the one real write above.
        expect(store.journal.slice(-1)[0].op).toBe('create');
        expect(store.journal.slice(-1)[0].collection).toBe('phrases');
    });
});

// F2 — the store half of the `phrases` / `phrase_groups` contract that `shared/types.ts:
// UID_ADDRESSED_COLLECTIONS` states and `src/shared/types.test.ts` pins at the registry level.
//
// `store.ts:_resolveId` recognises a record's FAMILY BY ID PREFIX (it has to: T-4's `expects` arrives
// as a bare id), and the phrase pair's singulars nest — `phrase_group_0` starts with `phrase_` — which
// is the one place the registry's ambiguity rule cannot hold. What makes it safe is not luck:
//
//   1. a real phrase/group row carries a UUID, so no id in either family is ever shaped like a counter
//      id in production, and the prefix walk is not even consulted for those rows (the second, no-prefix
//      scan finds them by content) — so the nested pair cannot claim the same id; and
//   2. when a family IS nested (a hand-minted counter row, or an id quoted after its row was deleted),
//      `_resolveId` returns the RECORD it found, and otherwise the LAST prefix match it walked. The
//      registry puts `phrase_groups` after `phrases`, so the answer is the most specific family — and a
//      CAS conflict then names the collection the caller actually meant.
//
// Both halves are pinned below, so the contract is a behaviour and not a comment.
describe('_resolveId keeps the nested phrase family unambiguous (F2)', () => {
    /** A catalog group, hand-written, so the test can name its counter id literally. */
    const groupInit = (storyId: string, phraseId: string) => ({
        story_id: storyId,
        phrase_id: phraseId,
        key: 'premise',
        title: 'Premise',
        description: 'What happens.',
        order: 1,
        content: '',
        revision: 0,
        updated_by: null
    });

    it('resolves each family by the record it holds, even when the shorter prefix also matches', () => {
        const store = Store.empty();
        const story = seedStory(store, { phase: 'summary' });

        // `create` is the counter path, so these ids ARE prefix-shaped — the situation `_resolveId`'s
        // prefix walk can get wrong, which is why the test mints them this way rather than using uids.
        const phrase = store.phrases.create(phraseInit(story.id), AUTHOR_ATTR);
        const group = store.phraseGroups.create(groupInit(story.id, phrase.id), AUTHOR_ATTR);
        const revision = store.groupRevisions.create(
            {
                story_id: story.id,
                phrase_id: phrase.id,
                group_id: group.id,
                group_key: 'premise',
                number: 1,
                content: 'A cartographer maps a sea that is not there.',
                state: 'latest',
                run_ref: null,
                work_item_ref: 'wi_draft_groups_summary_0_7fc4'
            },
            AUTHOR_ATTR
        );

        // Counter ids: `phrase_group_0` matches BOTH `phrase_` and `phrase_group_`, and the walk tries
        // `phrases` first — the record lookup is what keeps the answer in the right family.
        expect(phrase.id).toBe('phrase_0');
        expect(group.id).toBe('phrase_group_0');
        expect(revision.id).toBe('group_revision_0');
        expect(store._resolveId('phrase_0')).toMatchObject({
            collection: 'phrases',
            record: { id: 'phrase_0', key: 'summary', rev: 1 }
        });
        expect(store._resolveId('phrase_group_0')).toMatchObject({
            collection: 'phrase_groups',
            record: { id: 'phrase_group_0', key: 'premise', rev: 1 }
        });
        expect(store._resolveId('group_revision_0')).toMatchObject({
            collection: 'group_revisions',
            record: { id: 'group_revision_0', group_key: 'premise', number: 1, state: 'latest' }
        });
    });

    it('answers a uid-addressed row by its content, so the two uid families never share an id shape', () => {
        const store = Store.empty();
        const story = seedStory(store, { phase: 'summary' });

        // The production shape (R1): `persist.ts:newRecordUid` minting, `createWithId` preserving. Neither
        // id has a family prefix at all, so `_resolveId` falls through the prefix walk to the plain scan —
        // which is why the nested singulars are irrelevant for every row the app actually writes.
        const phrase = store.phrases.createWithId(recordUidAt(0), phraseInit(story.id), AUTHOR_ATTR);
        const group = store.phraseGroups.createWithId(
            recordUidAt(1),
            { ...groupInit(story.id, phrase.id) },
            AUTHOR_ATTR
        );

        expect(store._resolveId(recordUidAt(0))).toMatchObject({
            collection: 'phrases',
            record: { id: recordUidAt(0), key: 'summary', rev: 1 }
        });
        expect(store._resolveId(recordUidAt(1))).toMatchObject({
            collection: 'phrase_groups',
            record: { id: recordUidAt(1), key: 'premise', rev: 1 }
        });
        // An address nobody holds resolves to NO family (the caller gets "unknown id", not a wrong
        // collection whose rev happens to match by accident).
        expect(store._resolveId(recordUidAt(9))).toBeUndefined();
    });

    it('names the most specific family when a phrase-family id has no row left', () => {
        const store = Store.empty();
        const story = seedStory(store, { phase: 'summary' });

        const phrase = store.phrases.create(phraseInit(story.id), AUTHOR_ATTR);
        const group = store.phraseGroups.create(groupInit(story.id, phrase.id), AUTHOR_ATTR);

        store.phraseGroups.delete(group.id, { ...AUTHOR_ATTR, why: 'F2: the row the caller quoted is gone' });

        // "Known family, no record" is a CAS CONFLICT, and the collection it reports is what the Author
        // or agent is told to re-read. `phrase_group_0` matches `phrase_` too, but the walk keeps the LAST
        // match, and the registry orders `phrase_groups` after `phrases` (`shared/types.ts`), so the
        // conflict names the deeper family — the one that really lost the row.
        expect(store._resolveId('phrase_group_0')).toEqual({ collection: 'phrase_groups', record: undefined });
        // The shallower family is unaffected: an id only it matches still reports its record.
        expect(store._resolveId('phrase_0')).toMatchObject({
            collection: 'phrases',
            record: { id: 'phrase_0', key: 'summary', rev: 1 }
        });
        expect(store._resolveId('group_revision_0')).toEqual({ collection: 'group_revisions', record: undefined });

        // And with the phrase row deleted too, both families are empty and the answer stays specific.
        store.phrases.delete(phrase.id, { ...AUTHOR_ATTR, why: 'F2: the row the caller quoted is gone' });

        expect(store._resolveId('phrase_0')).toEqual({ collection: 'phrases', record: undefined });
        expect(store._resolveId('phrase_group_0')).toEqual({ collection: 'phrase_groups', record: undefined });
    });
});
