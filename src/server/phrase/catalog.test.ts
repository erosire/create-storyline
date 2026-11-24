// The Summary Phrase's catalog layer: the ensure (R1), the legacy import (R6) and the composed
// Overview. Unit-level on purpose — the store is real, the loop is not.
//
// WHY EXACT VALUES: three of the four things this file pins are things a READER quotes. The group
// rows' titles and order are what the Author's rail shows and what the Writer's prompt heading
// prints; the composed Overview is the artifact the deep review judges and the string the API
// returns; the import's seeded rows are the audit line an Author reads before trusting a group
// history. A "contains the heading" sniff would pass while all three drifted, so every expectation
// below is a whole row, a whole string or a whole array.
//
// THE FIXTURE: `run/mock.ts:seedStory` — a real Story row plus §4.2's real Summary row, whose five
// prose fields and `world_rules` are the legacy prose the import test reads. `summary_mode` is left
// ABSENT on purpose: that absence is the legacy book R6 talks about, and `isGroupManagedStory` must
// answer false for it until an explicit import flips it.
import { describe, expect, it } from 'vitest';
import { Store } from '../store';
import { AUTHOR_ATTR, seedStory } from '../run/mock';
import { recordUidAt } from '../store/persist';
import {
    composeGroupContent,
    ensurePhraseCatalog,
    importLegacySummary,
    isGroupManagedStory,
    phraseGroupsOf,
    storyPhrase
} from './catalog';
import type { PhraseGroup } from '../../shared/types';

/**
 * A Story plus the phrase catalog, with the catalog ids pinned by `recordUidAt` (a valid v4-shaped
 * uid per index, so the ids below are readable AND checkable). `next` is a caller-owned counter
 * because the ensure mints one id for the phrase and one per group, in that order — the exact
 * sequence is itself asserted below.
 */
function seedCatalog(nextStart = 0) {
    const store = Store.empty();
    const story = seedStory(store, { phase: 'summary' });
    let next = nextStart;
    const options = { newId: () => recordUidAt(next++) };

    return { store, story, options };
}

/** The one write every phrase helper needs; kept here so the attribution never varies between cases. */
const journalOf = (store: Store) => store.journal.map((event) => [event.seq, event.collection, event.op, event.id]);

/** The group row as a reader sees it — every field, so a silent change in any one of them fails here. */
const groupRowOf = (group: PhraseGroup) => ({
    id: group.id,
    story_id: group.story_id,
    phrase_id: group.phrase_id,
    key: group.key,
    title: group.title,
    description: group.description,
    order: group.order,
    content: group.content,
    revision: group.revision,
    updated_by: group.updated_by
});

describe('the phrase catalog is ensured as records, not as code shape (R1)', () => {
    it('creates the Summary Phrase and its five groups in catalog order, all unwritten', () => {
        const { store, story, options } = seedCatalog();
        const first = ensurePhraseCatalog(store, story, AUTHOR_ATTR, options);

        expect(first).toBeDefined();
        expect(first!.created_phrase).toBe(true);
        // The minting order is the phrase first, then the five groups in catalog order. Pinned because
        // the ids are what routes, findings and run rows name from here on (persist.ts says why they
        // are uids rather than counter labels).
        expect(first!.created_group_ids).toEqual([
            recordUidAt(1),
            recordUidAt(2),
            recordUidAt(3),
            recordUidAt(4),
            recordUidAt(5)
        ]);

        const phrase = store.phrases.require(first!.phrase.id);

        expect({
            id: phrase.id,
            story_id: phrase.story_id,
            key: phrase.key,
            title: phrase.title,
            description: phrase.description,
            content: phrase.content,
            order: phrase.order,
            revision: phrase.revision,
            group_refs: phrase.group_refs
        }).toEqual({
            id: recordUidAt(0),
            story_id: story.id,
            key: 'summary',
            title: 'Summary Phrase',
            description:
                'The Overview the whole chain is measured against: five named groups, each with its own revision history, composed in this order.',
            // An empty Overview, not a placeholder: `shared/phrase.ts` says a placeholder would be
            // quoted back by a review as though the Author had written it.
            content: '',
            order: 1,
            revision: 0,
            group_refs: [recordUidAt(1), recordUidAt(2), recordUidAt(3), recordUidAt(4), recordUidAt(5)]
        });

        // Five groups, catalog order, catalog titles, and the "never written" state (`''` + 0 + null)
        // the loop reads as first-draft work (R2's first install makes the number 1).
        expect(first!.groups.map(groupRowOf)).toEqual([
            {
                id: recordUidAt(1),
                story_id: story.id,
                phrase_id: recordUidAt(0),
                key: 'premise',
                title: 'Premise',
                description:
                    'What the story is: the situation, who is in it, and the confrontation they are drawn into. One concrete account, no theme statement and no ending.',
                order: 1,
                content: '',
                revision: 0,
                updated_by: null
            },
            {
                id: recordUidAt(2),
                story_id: story.id,
                phrase_id: recordUidAt(0),
                key: 'promise',
                title: 'Promise',
                description:
                    'What the story commits the reader to: the experience it undertakes to deliver, and the terms the rest of the book will be held to.',
                order: 2,
                content: '',
                revision: 0,
                updated_by: null
            },
            {
                id: recordUidAt(3),
                story_id: story.id,
                phrase_id: recordUidAt(0),
                key: 'theme',
                title: 'Theme',
                description:
                    'What the story is about underneath: the argument it makes, stated as a claim the events can be checked against — never as a moral.',
                order: 3,
                content: '',
                revision: 0,
                updated_by: null
            },
            {
                id: recordUidAt(4),
                story_id: story.id,
                phrase_id: recordUidAt(0),
                key: 'tone',
                title: 'Tone',
                description:
                    'Voice, point of view, tense and register the book is written in — the reading surface phase ③ is measured against. Prose qualities named, no sample prose.',
                order: 4,
                content: '',
                revision: 0,
                updated_by: null
            },
            {
                id: recordUidAt(5),
                story_id: story.id,
                phrase_id: recordUidAt(0),
                key: 'ending',
                title: 'Ending',
                description:
                    "Where the story lands and what resolves: the outcome the premise and the promise are answered by, including what is deliberately left open.",
                order: 5,
                content: '',
                revision: 0,
                updated_by: null
            }
        ]);

        // The journal is the audit of the same fact: one phrase create, five group creates, and the
        // one phrase update that puts the ordered id list on the row. (`seedStory` wrote the Story and
        // its Summary first, so the phrase ledger starts at seq 3.)
        expect(journalOf(store)).toEqual([
            [1, 'stories', 'create', 'story_0'],
            [2, 'summaries', 'create', 'summary_0'],
            [3, 'phrases', 'create', recordUidAt(0)],
            [4, 'phrase_groups', 'create', recordUidAt(1)],
            [5, 'phrase_groups', 'create', recordUidAt(2)],
            [6, 'phrase_groups', 'create', recordUidAt(3)],
            [7, 'phrase_groups', 'create', recordUidAt(4)],
            [8, 'phrase_groups', 'create', recordUidAt(5)],
            [9, 'phrases', 'update', recordUidAt(0)]
        ]);
    });

    it('writes nothing on the second ensure, and keeps the rows it already made', () => {
        const { store, story, options } = seedCatalog();
        const first = ensurePhraseCatalog(store, story, AUTHOR_ATTR, options)!;
        const events = store.journal.length;

        const second = ensurePhraseCatalog(store, story, AUTHOR_ATTR, options)!;

        expect(second.created_phrase).toBe(false);
        expect(second.created_group_ids).toEqual([]);
        expect(second.phrase.id).toBe(first.phrase.id);
        expect(second.groups.map((group) => group.id)).toEqual(first.groups.map((group) => group.id));
        // "Idempotent" here means SILENT: no journal line at all, so the entries that mean something
        // stay readable (catalog.ts's note about a restart's second ensure).
        expect(store.journal).toHaveLength(events);
        expect(store.phrases.list()).toHaveLength(1);
        expect(store.phraseGroups.list()).toHaveLength(5);
    });

    it('ensures a partially built catalog without touching the group that already has text', () => {
        const { store, story, options } = seedCatalog();
        const first = ensurePhraseCatalog(store, story, AUTHOR_ATTR, options)!;

        // The state a retired/re-added key or a half-migrated book leaves: Premise written, the other
        // four still unwritten. A re-ensure must leave the written row exactly as it is.
        store.phraseGroups.update(
            first.groups[0].id,
            { content: 'A return to a mapped valley.', revision: 1 },
            AUTHOR_ATTR,
            [{ id: first.groups[0].id, rev: first.groups[0].rev }]
        );

        const before = store.phraseGroups.require(first.groups[0].id);
        const second = ensurePhraseCatalog(store, story, AUTHOR_ATTR, options)!;

        expect(second.created_group_ids).toEqual([]);
        expect(store.phraseGroups.require(first.groups[0].id)).toEqual(before);
        expect(store.journal).toHaveLength(10);
    });

    it('leaves a legacy Story on the legacy pipeline until the catalog is asked for (R6)', () => {
        const { store, story } = seedCatalog();

        // The setting is a Story field, not a derived fact: a row with no `summary_mode` is a legacy
        // book even if rows exist beneath it. This is the ONE predicate the whole server reads.
        expect(story.summary_mode).toBeUndefined();
        expect(isGroupManagedStory(story)).toBe(false);
        expect(isGroupManagedStory(store.stories.require(story.id))).toBe(false);
        expect(storyPhrase(store, story.id)).toBeUndefined();
        expect(phraseGroupsOf(store, story.id)).toEqual([]);
        // And the legacy prose the import will read is where §4.2 put it.
        expect(store.summaries.list()[0].premise).toBe('A return to a mapped valley that no longer matches the map.');
    });
});

describe('the legacy Summary imports into groups by one explicit step (R6)', () => {
    it('seeds one latest revision per non-empty legacy field, preserves the prose, and switches the Story', () => {
        const { store, story, options } = seedCatalog();
        const imported = importLegacySummary(store, story, AUTHOR_ATTR, options)!;

        expect(imported.story_switched).toBe(true);
        expect(store.stories.require(story.id).summary_mode).toBe('groups');
        expect(isGroupManagedStory(store.stories.require(story.id))).toBe(true);

        // Five seeded rows: number 1, `latest`, and NO run — the Author's own text is preserved, not
        // re-authored, and `work_item_ref: 'phrase_import'` is the audit line that says so.
        expect(imported.seeded).toEqual([
            { group_id: recordUidAt(1), revision_id: 'group_revision_0', number: 1, group_key: 'premise' },
            { group_id: recordUidAt(2), revision_id: 'group_revision_1', number: 1, group_key: 'promise' },
            { group_id: recordUidAt(3), revision_id: 'group_revision_2', number: 1, group_key: 'theme' },
            { group_id: recordUidAt(4), revision_id: 'group_revision_3', number: 1, group_key: 'tone' },
            { group_id: recordUidAt(5), revision_id: 'group_revision_4', number: 1, group_key: 'ending' }
        ]);
        expect(
            store.groupRevisions
                .list()
                .map((row) => [row.id, row.group_id, row.group_key, row.number, row.state, row.run_ref, row.work_item_ref])
        ).toEqual([
            ['group_revision_0', recordUidAt(1), 'premise', 1, 'latest', null, 'phrase_import'],
            ['group_revision_1', recordUidAt(2), 'promise', 1, 'latest', null, 'phrase_import'],
            ['group_revision_2', recordUidAt(3), 'theme', 1, 'latest', null, 'phrase_import'],
            ['group_revision_3', recordUidAt(4), 'tone', 1, 'latest', null, 'phrase_import'],
            ['group_revision_4', recordUidAt(5), 'ending', 1, 'latest', null, 'phrase_import']
        ]);

        // The group rows carry the legacy prose VERBATIM (trimmed only), which is the compatibility
        // half of R6: nothing the Author wrote is reworded on the way in.
        expect(imported.groups.map((group) => [group.key, group.revision, group.content])).toEqual([
            ['premise', 1, 'A return to a mapped valley that no longer matches the map.'],
            ['promise', 1, 'The map and the territory reconcile in the last chapter.'],
            ['theme', 1, 'Memory against measurement.'],
            ['tone', 1, 'Plain, cold, precise.'],
            ['ending', 1, 'She floods the valley on purpose.']
        ]);

        // The composed Overview, in full: one `## <title>` per written group, text underneath, one
        // blank line between entries, no trailing newline (`shared/phrase.ts:composePhraseContent`).
        expect(imported.phrase.content).toBe(
            [
                '## Premise',
                'A return to a mapped valley that no longer matches the map.',
                '',
                '## Promise',
                'The map and the territory reconcile in the last chapter.',
                '',
                '## Theme',
                'Memory against measurement.',
                '',
                '## Tone',
                'Plain, cold, precise.',
                '',
                '## Ending',
                'She floods the valley on purpose.'
            ].join('\n')
        );
        expect(store.phrases.require(imported.phrase.id).revision).toBe(1);
        expect(store.phrases.require(imported.phrase.id).content).toBe(imported.phrase.content);

        // R1/R6: `world_rules` is not a group and the import writes no group from it — and the import
        // does not touch the `summaries` row at all (the mirror's direction belongs to the install).
        const summary = store.summaries.require(store.summaries.list()[0].id);

        expect(summary.world_rules).toBe('No magic; the reservoir is engineering.');
        expect(summary.chapter_count).toBe(3);
        expect(store.phraseGroups.list().some((group) => group.key === 'world_rules')).toBe(false);

        // The import's journal: the ensure's 7 rows, then five revision rows, five group updates, the
        // phrase's composed content, and the Story row that carries the switch.
        expect(journalOf(store).slice(9).map(([seq, collection, op, id]) => [seq, collection, op])).toEqual([
            [10, 'group_revisions', 'create'],
            [11, 'phrase_groups', 'update'],
            [12, 'group_revisions', 'create'],
            [13, 'phrase_groups', 'update'],
            [14, 'group_revisions', 'create'],
            [15, 'phrase_groups', 'update'],
            [16, 'group_revisions', 'create'],
            [17, 'phrase_groups', 'update'],
            [18, 'group_revisions', 'create'],
            [19, 'phrase_groups', 'update'],
            [20, 'phrases', 'update'],
            [21, 'stories', 'update']
        ]);
    });

    it('is idempotent by skipping: a second import writes nothing and rewrites no text', () => {
        const { store, story, options } = seedCatalog();
        const first = importLegacySummary(store, story, AUTHOR_ATTR, options)!;
        const events = store.journal.length;
        const groupsBefore = store.phraseGroups.list();

        // The row the first import returned is a `rev` behind now, and the store's CAS (T-4) refuses to
        // force a stale write — which is why a retrying route re-reads the book first.
        const again = importLegacySummary(store, store.stories.require(story.id), AUTHOR_ATTR, options)!;

        expect(again.seeded).toEqual([]);
        // The switch already happened, so this call changes no row anywhere — the route is safe to
        // retry after a partial run rather than destructive on the second press.
        expect(again.story_switched).toBe(false);
        expect(store.journal).toHaveLength(events);
        expect(store.groupRevisions.list()).toHaveLength(5);
        expect(store.phraseGroups.list()).toEqual(groupsBefore);
        expect(store.phrases.require(first.phrase.id).revision).toBe(1);
    });

    it('imports a half-written Summary as a half-written group history', () => {
        const store = Store.empty();
        const story = seedStory(store, { phase: 'summary' });

        // Theme and Ending blank: the two groups stay at `revision: 0`, get no revision row, and stay
        // out of the composed Overview — which is the truth about that book, not a formatted lie.
        store.summaries.update(
            store.summaries.list()[0].id,
            { theme: '', ending: '   ' },
            AUTHOR_ATTR,
            [{ id: store.summaries.list()[0].id, rev: store.summaries.list()[0].rev }]
        );

        let next = 0;
        const imported = importLegacySummary(store, story, AUTHOR_ATTR, { newId: () => recordUidAt(next++) })!;

        expect(imported.seeded.map((row) => row.group_key)).toEqual(['premise', 'promise', 'tone']);
        expect(imported.groups.map((group) => [group.key, group.revision])).toEqual([
            ['premise', 1],
            ['promise', 1],
            ['theme', 0],
            ['tone', 1],
            ['ending', 0]
        ]);
        expect(store.groupRevisions.list().map((row) => row.group_key)).toEqual(['premise', 'promise', 'tone']);
        expect(imported.phrase.content).toBe(
            [
                '## Premise',
                'A return to a mapped valley that no longer matches the map.',
                '',
                '## Promise',
                'The map and the territory reconcile in the last chapter.',
                '',
                '## Tone',
                'Plain, cold, precise.'
            ].join('\n')
        );
    });

    it('switches a Story with no legacy prose at all, with nothing to seed', () => {
        const store = Store.empty();
        const story = seedStory(store, { phase: 'summary' });

        for (const field of ['premise', 'promise', 'theme', 'tone', 'ending'] as const) {
            const summary = store.summaries.list()[0];

            store.summaries.update(
                summary.id,
                { [field]: '' },
                AUTHOR_ATTR,
                [{ id: summary.id, rev: summary.rev }]
            );
        }

        let next = 0;
        const imported = importLegacySummary(store, story, AUTHOR_ATTR, { newId: () => recordUidAt(next++) })!;

        expect(imported.seeded).toEqual([]);
        expect(imported.story_switched).toBe(true);
        expect(store.groupRevisions.list()).toEqual([]);
        expect(imported.phrase.content).toBe('');
        expect(store.phrases.require(imported.phrase.id).revision).toBe(0);
        // An unwritten Overview composes to the empty string, not to five empty headings.
        expect(composeGroupContent(store, story.id, imported.phrase.id)).toBe('');
    });
});
