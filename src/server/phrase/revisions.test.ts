// The Summary Phrase's revision layer: the answer validators, the install (R2/R5), the per-group
// history, and the legacy mirror (R6). Unit-level: real store, no loop.
//
// WHY EXACT VALUES: the validators' refusal sentences are what a failed structured run shows the
// Author, and the install's rows are the history the Author reads back ("Revision 1…N" per group).
// Both are pinned verbatim. The mirror assertions are the R6 compatibility claim in row form: a
// reader of the legacy `summaries` record sees the current text for the groups that were written and
// nothing else moved.
//
// THE LOCK LEG: `installGroupRevisions` refuses a locked group outright (the op is locks.ts) — a
// locked group is the fixed point the other groups get revised against, so nothing installs over it,
// whether it was locked before the install or by another writer in the middle of one.
//
// THE GROUP-QUOTE LEG (R3/D-15): a review issue carries ONE primary `quote`, which can only prove that ONE
// group was read, so every OTHER group its `group_refs` names has to carry a `group_quotes` entry. The parser
// refuses an issue that names a group it never quoted, and refuses an entry that is not evidence for a group
// the same issue names — both sentences are pinned verbatim, as is the shape of an accepted multi-group answer
// (refs deduped, entries carried in the answered order, fix certificates passed through). The prompt states the
// same rules in BOTH engine-owned blocks: `run/phase1-prompt.ts:GROUP_REVIEW_INSTRUCTION` (phrase ①, pinned in
// `run/phase1-prompt.test.ts`) and `run/phase1-prompt.ts:CONTRACT_SCREEN_INSTRUCTION` (phrase ②'s chapter twin,
// pinned in `integration/plotlines-groups.test.ts`); `parseGroupReviewAnswer` is one validator for both lanes, so
// the two prompt files and this one are a single contract, and drift between them costs the book a refused pass
// per attempt.
//
// THE FIXTURE: `run/mock.ts:seedStory` + `ensurePhraseCatalog` with `recordUidAt`, so every group id
// in the expectations below is a literal the reader can point at.
import { describe, expect, it } from 'vitest';
import { Store } from '../store';
import { AUTHOR_ATTR, seedStory } from '../run/mock';
import { recordUidAt } from '../store/persist';
import { ensurePhraseCatalog, importLegacySummary } from './catalog';
import { lockPhraseGroup } from './locks';
import {
    groupRevisionHistory,
    groupRevisionVector,
    groupVectorHash,
    installGroupRevisions,
    latestGroupRevision,
    parseGroupDraftAnswer,
    parseGroupReviewAnswer,
    syncSummaryMirror
} from './revisions';
import type { Phrase, PhraseGroup } from '../../shared/types';

/** A Story whose five catalog groups exist and are unwritten, with the ids pinned. */
function seedBook() {
    const store = Store.empty();
    const story = seedStory(store, { phase: 'summary' });
    let next = 0;
    const ensured = ensurePhraseCatalog(store, story, AUTHOR_ATTR, { newId: () => recordUidAt(next++) })!;

    return { store, story, phrase: ensured.phrase, groups: ensured.groups };
}

const groupOf = (groups: PhraseGroup[], key: string) => groups.find((group) => group.key === key)!;

/** The legacy record as a projection, so the mirror assertions name every field it owns. */
const summaryOf = (store: Store): Record<string, unknown> => {
    const row = store.summaries.require('summary_0');

    return {
        id: row.id,
        chapter_count: row.chapter_count,
        premise: row.premise,
        promise: row.promise,
        theme: row.theme,
        tone: row.tone,
        ending: row.ending,
        world_rules: row.world_rules,
        locked: row.locked
    };
};

/** The audit fields of a new revision row, in the order the install writes them. */
const revisionRowOf = (store: Store) =>
    store.groupRevisions
        .list()
        .map((row) => ({
            id: row.id,
            group_id: row.group_id,
            group_key: row.group_key,
            number: row.number,
            state: row.state,
            run_ref: row.run_ref,
            work_item_ref: row.work_item_ref,
            task_refs: row.task_refs,
            finding_refs: row.finding_refs,
            knowledge_used: row.knowledge_used,
            prompt_hash: row.prompt_hash
        }));

describe('a group Writer answer is validated against the JOB, not just the schema (R2)', () => {
    it('accepts an exact answer and hands the install catalog-ordered pairs, whatever order it answered in', () => {
        const { store, story, groups } = seedBook();
        const premise = groupOf(groups, 'premise');
        const tone = groupOf(groups, 'tone');

        const decision = parseGroupDraftAnswer(store, story.id, [tone.id, premise.id], {
            groups: [
                // Answered tone-first on purpose: the order below is the CATALOG's, not the answer's.
                { group_ref: tone.id, content: '  Plain, cold, precise — and it stays that way.  ' },
                { group_ref: premise.id, content: 'A cartographer walks into the drowned valley.' }
            ],
            knowledge_used: ['K-aaa', 7, 'K-bbb']
        });

        expect(decision.ok).toBe(true);

        if (!decision.ok) throw new Error(decision.refusal);

        expect(decision.contents.map((entry) => [entry.group.key, entry.content])).toEqual([
            // Trimmed once, at validation, so the row and the mirror hold the same bytes.
            ['premise', 'A cartographer walks into the drowned valley.'],
            ['tone', 'Plain, cold, precise — and it stays that way.']
        ]);
        // Non-strings are dropped rather than crashing a settlement on a provider that downgrades.
        expect(decision.knowledgeUsed).toEqual(['K-aaa', 'K-bbb']);
    });

    it('refuses every malformed answer with the sentence the Author reads, and writes nothing', () => {
        const { store, story, groups } = seedBook();
        const premise = groupOf(groups, 'premise');
        const promise = groupOf(groups, 'promise');
        const tone = groupOf(groups, 'tone');
        const events = store.journal.length;

        const refusals: Array<[unknown, string]> = [
            [{}, 'the GroupDraft answer carried no `groups` entries'],
            [{ groups: [] }, 'the GroupDraft answer carried no `groups` entries'],
            [
                { groups: [{ group_ref: premise.id, content: '   ' }] },
                'a `groups` entry named no group or carried empty content'
            ],
            [
                { groups: [{ group_ref: 'made-up-id', content: 'text' }] },
                '`made-up-id` is not one of this Story\'s phrase groups — a draft answers for the group ids the job named, never for a key or an invented id'
            ],
            [
                // A catalog KEY instead of the persisted id is the mistake this rule exists to catch.
                { groups: [{ group_ref: 'premise', content: 'text' }] },
                '`premise` is not one of this Story\'s phrase groups — a draft answers for the group ids the job named, never for a key or an invented id'
            ],
            [
                { groups: [{ group_ref: premise.id, content: 'a' }, { group_ref: promise.id, content: 'b' }] },
                `${promise.id} was not one of the groups this job asked for — writing a group nobody requested would revise an untouched one (R2)`
            ],
            [
                { groups: [{ group_ref: premise.id, content: 'a' }, { group_ref: premise.id, content: 'b' }] },
                `${premise.id} was answered twice in one answer — two texts for one group is an ambiguous batch`
            ],
            [
                // Asked for two, answered one: the titles in the sentence are the group KEYS, because
                // an Author reading it owns the rail, not the uid.
                { groups: [{ group_ref: tone.id, content: 'only the tone' }] },
                'the answer left premise unwritten — a batch that skips a group it was asked for installs nothing (R2)'
            ]
        ];

        for (const [answer, refusal] of refusals) {
            const decision = parseGroupDraftAnswer(store, story.id, [premise.id, tone.id], answer);

            expect(decision.ok).toBe(false);

            if (decision.ok) throw new Error('expected a refusal');

            expect(decision.refusal).toBe(refusal);
        }

        // Refusal is a read, not a write: a validator that journalled would leave a half batch behind.
        expect(store.journal).toHaveLength(events);
        expect(store.groupRevisions.list()).toEqual([]);
    });
});

describe('a group review answer is refused unless every issue names real groups (R3)', () => {
    /**
     * One review issue, in the shape a provider answers with.
     *
     * `group_quotes` is added ONLY when the case supplies it, because the row shape differs by exactly that
     * key: `parseGroupReviewAnswer` spreads the answered issue and attaches the array only when the answer
     * carried entries (`revisions.ts:340-344`), so a single-group row carries none. A fixture that always
     * printed the key would pin a row the engine never writes.
     */
    const issue = (
        group_refs: string[],
        group_quotes?: Array<{ group_ref: string; quote: string; location?: string }>
    ) => ({
        severity: 'critical' as const,
        criterion: 'C-14',
        location: 'the Ending',
        quote: 'She floods the valley on purpose.',
        detail: 'The Ending answers a promise the Promise never makes.',
        group_refs,
        ...(group_quotes === undefined ? {} : { group_quotes })
    });

    /** One extra group's evidence, as the prompt tells the Critic to answer (`group_ref`, `quote`, `location`). */
    const quoteFor = (group: PhraseGroup, line: string) => ({
        group_ref: group.id,
        quote: line,
        location: `the ${group.key} section`
    });

    /**
     * The refusal a bad `group_quotes` ENTRY gets — one sentence for all three shapes of bad entry (an id
     * the issue does not name, an id the Story does not have, a blank quote), because the Author sees the
     * same repair whichever one the model made.
     */
    const BAD_ENTRY =
        'a `group_quotes` entry must quote a group named in the same issue\'s `group_refs`, using an id this Story has and a non-empty quote (R3, D-15)';

    /** The refusal a named-but-unquoted group gets, with the group count and ids the source prints. */
    const unquotedRefusal = (count: number, unquoted: string[]) =>
        `an issue naming ${count} groups has to quote every one of them; ${unquoted.join(', ')} has no quote — put the primary quote's group first in \`group_refs\` and add a \`group_quotes\` entry for every other group (R3, D-15)`;

    it('refuses an answer with no issues array', () => {
        const { store, story } = seedBook();

        expect(parseGroupReviewAnswer(store, story.id, {})).toEqual({
            ok: false,
            refusal: 'the GroupReview answer carried no `issues` array'
        });
    });

    it('refuses an issue that names no group, and one that invents one', () => {
        const { store, story, groups } = seedBook();
        const ending = groupOf(groups, 'ending');

        expect(parseGroupReviewAnswer(store, story.id, { issues: [issue([])] })).toEqual({
            ok: false,
            refusal:
                "an issue named no group outside this Story's groups — every review issue has to say which group it is about (R3)"
        });

        expect(parseGroupReviewAnswer(store, story.id, { issues: [issue([ending.id, 'group_9'])] })).toEqual({
            ok: false,
            refusal:
                'an issue named group_9 outside this Story\'s groups — every review issue has to say which group it is about (R3)'
        });
    });

    it('refuses a multi-group issue whose only quote is the primary group\'s (R3, D-15)', () => {
        const { store, story, groups } = seedBook();
        const ending = groupOf(groups, 'ending');
        const premise = groupOf(groups, 'premise');
        const promise = groupOf(groups, 'promise');

        // THE IMPOSSIBILITY THIS CLOSES: one `quote` can only prove ONE group was read, so "name three, quote
        // one" used to be the only legal answer while being unverifiable. Both engine-owned prompt blocks now
        // say a group named without a quote is refused (`run/phase1-prompt.ts:GROUP_REVIEW_INSTRUCTION` for a
        // Summary review, `run/phase1-prompt.ts:CONTRACT_SCREEN_INSTRUCTION` for a chapter-contract review),
        // and this is the engine keeping that promise. The count in the sentence is the RAW `group_refs.length` and the ids
        // are the unquoted ones only — the repair has to be readable from the refusal alone.
        expect(parseGroupReviewAnswer(store, story.id, { issues: [issue([ending.id, premise.id])] })).toEqual({
            ok: false,
            refusal: unquotedRefusal(2, [premise.id])
        });

        // Two groups named and neither quoted: both ids are listed, in the order the issue named them.
        expect(
            parseGroupReviewAnswer(store, story.id, { issues: [issue([ending.id, premise.id, promise.id])] })
        ).toEqual({ ok: false, refusal: unquotedRefusal(3, [premise.id, promise.id]) });
    });

    it('refuses a `group_quotes` entry that is not evidence for a named group of this Story (R3, D-15)', () => {
        const { store, story, groups } = seedBook();
        const ending = groupOf(groups, 'ending');
        const premise = groupOf(groups, 'premise');

        // (a) A group this STORY has but this ISSUE did not name: evidence no closure join can route, because
        //     a finding closes on the ids in `group_refs` and this one is not among them.
        expect(
            parseGroupReviewAnswer(store, story.id, {
                issues: [issue([ending.id], [quoteFor(premise, 'The cartographer walks back into the water.')])]
            })
        ).toEqual({ ok: false, refusal: BAD_ENTRY });

        // (b) An id the Story does not have. It sits in `group_quotes` ONLY: an unknown id in `group_refs` is
        //     caught by the earlier ref check (`phrase/revisions.ts:293-300`, pinned above), and that ordering
        //     is deliberate — the invented GROUP is the more specific defect than an unusable piece of evidence.
        expect(
            parseGroupReviewAnswer(store, story.id, {
                issues: [issue([ending.id, premise.id], [{ group_ref: 'group_9', quote: 'A row no rail can label.' }])]
            })
        ).toEqual({ ok: false, refusal: BAD_ENTRY });

        // (c) An entry that quotes nothing: an empty quote proves no group was read, and `minLength` is not
        //     enforced by the in-process validator (`llm/structured.ts`), so this is the only place the rule runs.
        expect(
            parseGroupReviewAnswer(store, story.id, {
                issues: [issue([ending.id, premise.id], [{ group_ref: premise.id, quote: '   ' }])]
            })
        ).toEqual({ ok: false, refusal: BAD_ENTRY });

        // (d) THE ORDER the two refusals fire in: a broken entry outranks an unquoted group, so a model that
        //     made both mistakes is sent home with the specific one (the same ordering rule
        //     `parseSectionScoreAnswer` follows, and the difference between a repairable retry and a new
        //     invention). Here `promise.id` is unquoted AND `premise.id`'s entry is blank.
        const promise = groupOf(groups, 'promise');

        expect(
            parseGroupReviewAnswer(store, story.id, {
                issues: [
                    issue([ending.id, premise.id, promise.id], [{ group_ref: premise.id, quote: '' }])
                ]
            })
        ).toEqual({ ok: false, refusal: BAD_ENTRY });
    });

    it('accepts a single-group issue with no `group_quotes` — the primary quote covers the only group named', () => {
        const { store, story, groups } = seedBook();
        const ending = groupOf(groups, 'ending');

        expect(
            parseGroupReviewAnswer(store, story.id, { issues: [issue([ending.id])] })
        ).toEqual({
            ok: true,
            review: {
                // No `group_quotes` key at all: the answer carried none, so the row carries none. A repair
                // that wrote `group_quotes: []` here would put an empty array on every legacy row.
                issues: [
                    {
                        severity: 'critical',
                        criterion: 'C-14',
                        location: 'the Ending',
                        quote: 'She floods the valley on purpose.',
                        detail: 'The Ending answers a promise the Promise never makes.',
                        group_refs: [ending.id]
                    }
                ]
            }
        });
    });

    it('keeps a valid answer verbatim, dedupes its group list, and carries the fix certificates through', () => {
        const { store, story, groups } = seedBook();
        const premise = groupOf(groups, 'premise');
        const promise = groupOf(groups, 'promise');
        const ending = groupOf(groups, 'ending');

        // Every group this issue names is quoted: the primary `quote` answers `ending` (the FIRST ref, which
        // is the position the prompt sends the quoted group to), and the two others each carry an entry. The
        // double `ending.id` is kept in the answer on purpose — the dedupe runs on the refs, not on the quotes.
        const events = store.journal.length;
        const decision = parseGroupReviewAnswer(store, story.id, {
            issues: [
                issue([ending.id, ending.id, promise.id, premise.id], [
                    quoteFor(promise, 'The map reconciles at the price of the map.'),
                    quoteFor(premise, 'A cartographer returns to a valley the water redrew.')
                ])
            ],
            fix_verifications: [{ fix_ref: 'task_0', status: 'resolved', evidence: 'the Ending now pays the promise' }]
        });

        expect(decision.ok).toBe(true);

        if (!decision.ok) throw new Error(decision.refusal);

        expect(decision.review.issues).toEqual([
            {
                severity: 'critical',
                criterion: 'C-14',
                location: 'the Ending',
                quote: 'She floods the valley on purpose.',
                detail: 'The Ending answers a promise the Promise never makes.',
                // The double `ending.id` is collapsed; the critic's own text is untouched (D-15).
                group_refs: [ending.id, promise.id, premise.id],
                // The entries are carried in the ANSWERED order, not re-sorted to the refs' order: the engine
                // validates evidence, it does not re-organise the Critic's case against the book.
                group_quotes: [
                    { group_ref: promise.id, quote: 'The map reconciles at the price of the map.', location: 'the promise section' },
                    { group_ref: premise.id, quote: 'A cartographer returns to a valley the water redrew.', location: 'the premise section' }
                ]
            }
        ]);
        expect(decision.review.fix_verifications).toEqual([
            { fix_ref: 'task_0', status: 'resolved', evidence: 'the Ending now pays the promise' }
        ]);
        // A validation is a read: the review rows are the settle's to file, not the parser's, so nothing on
        // the book moved while the answer was judged (the same guard the draft refusals run).
        expect(store.journal).toHaveLength(events);
    });

    it('keeps a redundant quote for the primary group rather than tidying the Critic\'s evidence (D-15)', () => {
        const { store, story, groups } = seedBook();
        const ending = groupOf(groups, 'ending');
        const premise = groupOf(groups, 'premise');

        // A Critic that quotes the primary group TWICE — once in `quote`, once in `group_quotes` — is not
        // malformed: every named group is evidenced, and dropping the extra entry would be the loop editing
        // the Critic's evidence, which D-15 forbids. This is the case an "optimisation" would silently break.
        const decision = parseGroupReviewAnswer(store, story.id, {
            issues: [
                issue([ending.id, premise.id], [
                    quoteFor(ending, 'She floods the valley on purpose, and says so.'),
                    quoteFor(premise, 'A cartographer returns to a valley the water redrew.')
                ])
            ]
        });

        expect(decision.ok).toBe(true);

        if (!decision.ok) throw new Error(decision.refusal);

        expect(decision.review.issues[0].group_quotes).toEqual([
            { group_ref: ending.id, quote: 'She floods the valley on purpose, and says so.', location: 'the ending section' },
            { group_ref: premise.id, quote: 'A cartographer returns to a valley the water redrew.', location: 'the premise section' }
        ]);
    });
});

describe('installing a group revision moves one group line and nobody else’s (R2, R5)', () => {
    it('writes the first revision, its audit fields, the composed Overview, and the mirror fields it owes', () => {
        const { store, story, groups } = seedBook();
        const premise = groupOf(groups, 'premise');
        const tone = groupOf(groups, 'tone');

        const result = installGroupRevisions(
            store,
            story,
            [
                { group: premise, content: 'A cartographer walks into the drowned valley.' },
                { group: tone, content: 'Plain, cold, precise.' }
            ],
            AUTHOR_ATTR,
            {
                runRef: 'run_0',
                workItemRef: 'wi_draft_groups_summary_0_deadbeefdeadbeef_1',
                taskRefs: ['task_0'],
                findingRefs: ['finding_0'],
                knowledgeUsed: ['K-aaa'],
                promptHash: 'a1b2c3d4e5f60718'
            }
        );

        // Two rows, each at number 1 on ITS OWN line, both `latest`, with the job's audit fields.
        expect(revisionRowOf(store)).toEqual([
            {
                id: 'group_revision_0',
                group_id: recordUidAt(1),
                group_key: 'premise',
                number: 1,
                state: 'latest',
                run_ref: 'run_0',
                work_item_ref: 'wi_draft_groups_summary_0_deadbeefdeadbeef_1',
                task_refs: ['task_0'],
                finding_refs: ['finding_0'],
                knowledge_used: ['K-aaa'],
                prompt_hash: 'a1b2c3d4e5f60718'
            },
            {
                id: 'group_revision_1',
                group_id: recordUidAt(4),
                group_key: 'tone',
                number: 1,
                state: 'latest',
                run_ref: 'run_0',
                work_item_ref: 'wi_draft_groups_summary_0_deadbeefdeadbeef_1',
                task_refs: ['task_0'],
                finding_refs: ['finding_0'],
                knowledge_used: ['K-aaa'],
                prompt_hash: 'a1b2c3d4e5f60718'
            }
        ]);
        expect(result.archived).toEqual([]);
        expect(latestGroupRevision(store, premise.id)?.id).toBe('group_revision_0');
        expect(latestGroupRevision(store, groupOf(groups, 'promise').id)).toBeUndefined();

        // The group rows carry the current text and number; `updated_by` names the run that wrote it.
        expect(result.groups.map((group) => [group.key, group.revision, group.content, group.updated_by])).toEqual([
            ['premise', 1, 'A cartographer walks into the drowned valley.', 'run_0'],
            ['tone', 1, 'Plain, cold, precise.', 'run_0']
        ]);

        // R2 in row form: the three groups this batch never touched have no rows at all and still say
        // "never written". One group's write renumbers nobody.
        expect(
            store.phraseGroups
                .list()
                .filter((group) => group.key !== 'premise' && group.key !== 'tone')
                .map((group) => [group.key, group.revision, group.content, group.updated_by])
        ).toEqual([
            ['promise', 0, '', null],
            ['theme', 0, '', null],
            ['ending', 0, '', null]
        ]);

        // The Overview composes from the ROWS, not from the batch — an unwritten group is simply absent.
        const phrase: Phrase = store.phrases.require(result.phrase.id);

        expect(phrase.revision).toBe(1);
        expect(phrase.content).toBe(
            [
                '## Premise',
                'A cartographer walks into the drowned valley.',
                '',
                '## Tone',
                'Plain, cold, precise.'
            ].join('\n')
        );

        // R6: the mirror is written in the SAME commit, for the fields the install actually wrote.
        expect(result.mirror).toEqual({ summary_id: 'summary_0', fields: ['premise', 'tone'], written: true });
        expect(summaryOf(store)).toEqual({
            id: 'summary_0',
            chapter_count: 3,
            premise: 'A cartographer walks into the drowned valley.',
            // Untouched groups keep the legacy prose the Author already had — the mirror is a
            // projection of the group vector, and an unwritten group has no text to project.
            promise: 'The map and the territory reconcile in the last chapter.',
            theme: 'Memory against measurement.',
            tone: 'Plain, cold, precise.',
            ending: 'She floods the valley on purpose.',
            // R1: `world_rules` has no group and the mirror never writes it. D-3b: neither does chapter_count.
            world_rules: 'No magic; the reservoir is engineering.',
            locked: false
        });
    });

    it('supersedes the previous text, keeps it as history, and leaves the other four groups byte-identical', () => {
        const { store, story, groups } = seedBook();
        const premise = groupOf(groups, 'premise');
        const promise = groupOf(groups, 'promise');

        // The install CASes the GROUP row it is superseding, so the second install is handed a freshly
        // read row (T-4: re-read and re-apply, never force). The loop reads its group rows in the
        // sweep that dispatches the batch, and the route re-reads per request.
        installGroupRevisions(store, story, [{ group: premise, content: 'First take.' }], AUTHOR_ATTR, {
            runRef: 'run_0'
        });
        installGroupRevisions(
            store,
            story,
            [{ group: store.phraseGroups.require(premise.id), content: 'Second take.' }],
            AUTHOR_ATTR,
            { runRef: 'run_1' }
        );

        // The install archives the previous row BEFORE creating the new one, so `latest` is never
        // claimed twice — and the archive is the first write of the second install's journal.
        expect(store.groupRevisions.list().map((row) => [row.id, row.number, row.state, row.run_ref])).toEqual([
            ['group_revision_0', 1, 'archived', 'run_0'],
            ['group_revision_1', 2, 'latest', 'run_1']
        ]);
        expect(store.phraseGroups.require(premise.id)).toMatchObject({
            content: 'Second take.',
            revision: 2,
            updated_by: 'run_1'
        });

        // The group's own history, newest first — the "Revision 1…N" line the Author reads.
        expect(groupRevisionHistory(store, premise.id).map((row) => [row.id, row.number, row.state])).toEqual([
            ['group_revision_1', 2, 'latest'],
            ['group_revision_0', 1, 'archived']
        ]);
        expect(latestGroupRevision(store, premise.id)?.content).toBe('Second take.');

        // Nothing else moved: no rows, and the sibling group row is the row it was.
        const promiseRow = store.phraseGroups.require(promise.id);

        expect(store.groupRevisions.list().filter((row) => row.group_id === promise.id)).toEqual([]);
        expect(promiseRow.revision).toBe(0);
        expect(promiseRow.content).toBe('');
        expect(promiseRow.updated_by).toBeNull();

        // Each group numbers from its OWN line: a third group's first install is number 1, not 3.
        const third = installGroupRevisions(store, story, [{ group: promise, content: 'A promise kept.' }], AUTHOR_ATTR);

        expect(third.installed.map((row) => [row.group_key, row.number, row.state])).toEqual([['promise', 1, 'latest']]);
        expect(third.archived).toEqual([]);
    });

    it('numbers a group per group after an import seeded the legacy prose (R2)', () => {
        const store = Store.empty();
        const story = seedStory(store, { phase: 'summary' });
        let next = 0;
        const options = { newId: () => recordUidAt(next++) };
        const ensured = ensurePhraseCatalog(store, story, AUTHOR_ATTR, options)!;

        // The imported book: every group at revision 1 from the Author's own prose.
        importLegacySummary(store, store.stories.require(story.id), AUTHOR_ATTR, options);

        const vectorBefore = groupRevisionVector(store, story.id);

        expect(vectorBefore).toEqual({
            [recordUidAt(1)]: 1,
            [recordUidAt(2)]: 1,
            [recordUidAt(3)]: 1,
            [recordUidAt(4)]: 1,
            [recordUidAt(5)]: 1
        });

        const hashBefore = groupVectorHash(vectorBefore);

        expect(hashBefore).toBe(groupVectorHash({ [recordUidAt(5)]: 1, [recordUidAt(1)]: 1, [recordUidAt(3)]: 1, [recordUidAt(2)]: 1, [recordUidAt(4)]: 1 }));

        // The import moved every group row, so the batch is handed the row as it stands now.
        const tone = store.phraseGroups.require(groupOf(ensured.groups, 'tone').id);
        const installed = installGroupRevisions(store, story, [{ group: tone, content: 'Plainer, colder.' }], AUTHOR_ATTR, {
            runRef: 'run_2'
        });

        expect(installed.installed.map((row) => [row.group_key, row.number])).toEqual([['tone', 2]]);

        // The vector moved on one entry only, so the review seats' claim key moves with it (R3/R5).
        const vector = groupRevisionVector(store, story.id);

        expect(vector).toEqual({ ...vectorBefore, [recordUidAt(4)]: 2 });
        expect(groupVectorHash(vector)).not.toBe(hashBefore);
        // The exact address of THIS vector — the five catalog uids with `recordUidAt(4)` (tone) at 2 and
        // the rest at 1 — is pinned because a seat's claim key IS this hash, and the hash is the only
        // thing that makes a seat reproducible across a restart (R3/R5). The value moves if the fixture
        // mints different uids; what does NOT move is the line above: one entry changed, so one entry of
        // the address changed.
        expect(groupVectorHash(vector)).toBe('590ac70fe3cccdb3');
    });

    it('holds the mirror back when the Author has locked the Summary, and still installs the group (R6, L-7a)', () => {
        const { store, story, groups } = seedBook();
        const summary = store.summaries.list()[0];

        store.summaries.update(summary.id, { locked: true }, AUTHOR_ATTR, [{ id: summary.id, rev: summary.rev }]);

        const result = installGroupRevisions(
            store,
            story,
            [{ group: groupOf(groups, 'premise'), content: 'A cartographer walks into the drowned valley.' }],
            AUTHOR_ATTR
        );

        expect(result.mirror).toEqual({ summary_id: 'summary_0', fields: [], written: false, reason: 'locked' });
        // The group install is not undone by the lock — the projection reports the difference instead.
        expect(store.phraseGroups.require(groupOf(groups, 'premise').id).revision).toBe(1);
        expect(store.summaries.require('summary_0').premise).toBe(
            'A return to a mapped valley that no longer matches the map.'
        );
    });

    it('reports a Story with no Summary row rather than inventing one (R6, D-3b)', () => {
        const { store, story, groups } = seedBook();

        store.summaries.delete('summary_0', AUTHOR_ATTR);

        const result = installGroupRevisions(
            store,
            story,
            [{ group: groupOf(groups, 'theme'), content: 'Memory against measurement, stated as a claim.' }],
            AUTHOR_ATTR
        );

        expect(result.mirror).toEqual({ summary_id: null, fields: [], written: false, reason: 'no_summary' });
        expect(store.summaries.list()).toEqual([]);
        expect(store.phraseGroups.require(groupOf(groups, 'theme').id).revision).toBe(1);
    });

    it('refuses a malformed batch before a single row moves', () => {
        const { store, story, groups } = seedBook();
        const premise = groupOf(groups, 'premise');
        const events = store.journal.length;

        expect(() => installGroupRevisions(store, story, [], AUTHOR_ATTR)).toThrow(
            'installGroupRevisions: an empty batch installs nothing — the caller should not have dispatched it'
        );
        expect(() =>
            installGroupRevisions(store, story, [{ group: premise, content: '   ' }], AUTHOR_ATTR)
        ).toThrow(
            'installGroupRevisions: premise arrived with empty content — an empty group text is a refusal, not a revision'
        );
        // A half batch (one good entry, one empty) refuses the WHOLE batch: R2's point is that a bad
        // group must not install three revisions while the fourth silently keeps its text.
        expect(() =>
            installGroupRevisions(
                store,
                story,
                [
                    { group: premise, content: 'A cartographer walks in.' },
                    { group: groupOf(groups, 'tone'), content: '' }
                ],
                AUTHOR_ATTR
            )
        ).toThrow(
            'installGroupRevisions: tone arrived with empty content — an empty group text is a refusal, not a revision'
        );
        expect(store.journal).toHaveLength(events);
        expect(store.groupRevisions.list()).toEqual([]);
        expect(store.phrases.require(store.phrases.list()[0].id).revision).toBe(0);

        // And a book with no phrase row at all is a caller error, not a silent no-op. The message names
        // the PHRASE row rather than the Summary specifically: the install now resolves the book's PRIMARY
        // phrase, whatever kind that is, so the missing row it reports is a phrase row of any kind.
        const bare = Store.empty();
        const bareStory = seedStory(bare, { phase: 'summary' });

        expect(() =>
            installGroupRevisions(bare, bareStory, [{ group: { ...(groups[0] as PhraseGroup), story_id: bareStory.id }, content: 'x' }], AUTHOR_ATTR)
        ).toThrow(
            `installGroupRevisions: story ${bareStory.id} has no Phrase row — ensurePhraseCatalog must create the catalog before any group is written`
        );
    });
});

describe('the mirror on its own (R6)', () => {
    it('writes nothing when there is no mirrored field to write', () => {
        const { store, story } = seedBook();

        // A retired key still on the book has no mirror field, and guessing one would put text in a
        // field the Author never defined.
        expect(syncSummaryMirror(store, story, [], AUTHOR_ATTR)).toEqual({
            summary_id: 'summary_0',
            fields: [],
            written: false
        });
        expect(store.summaries.require('summary_0').premise).toBe(
            'A return to a mapped valley that no longer matches the map.'
        );
    });
});

describe('a locked group is refused by the install, whole batch and before the first write (the group lock)', () => {
    /** The exact refusal `installGroupRevisions` raises for a locked `premise` at revision 1. */
    const LOCKED_REFUSAL =
        "installGroupRevisions: premise is locked at revision 1 by author — a locked group's text is the fixed point the other groups are revised against, so nothing installs over it until the Author unlocks it";

    /** The persisted row id of one catalog group — the address the install CASes against. */
    const idOf = (store: Store, key: string) => store.phraseGroups.list().find((row) => row.key === key)!.id;

    /** One group row as the lock and the text see it. */
    const rowOf = (store: Store, key: string) => {
        const group = store.phraseGroups.require(idOf(store, key));

        return {
            content: group.content,
            revision: group.revision,
            updated_by: group.updated_by,
            locked: group.locked,
            locked_revision: group.locked_revision,
            locked_by: group.locked_by
        };
    };

    /** Premise and Promise at revision 1; Tone and Ending still unwritten. */
    function twoWrittenGroups() {
        const book = seedBook();

        installGroupRevisions(
            book.store,
            book.story,
            [{ group: groupOf(book.groups, 'premise'), content: 'A cartographer walks into the drowned valley.' }],
            AUTHOR_ATTR,
            { runRef: 'run_0' }
        );
        installGroupRevisions(
            book.store,
            book.story,
            [{ group: groupOf(book.groups, 'promise'), content: 'The map and the territory reconcile in the last chapter.' }],
            AUTHOR_ATTR,
            { runRef: 'run_0' }
        );

        return book;
    }

    it('refuses a locked target with the sentence the Author reads, and moves nothing', () => {
        const { store, story, phrase } = twoWrittenGroups();

        lockPhraseGroup(store, story, idOf(store, 'premise'), AUTHOR_ATTR, { actor: 'author', at: '2026-11-25T10:00:00.000Z' });

        const rows = revisionRowOf(store);
        const groups = store.phraseGroups.list();
        const events = store.journal.length;

        expect(() =>
            installGroupRevisions(
                store,
                story,
                [{ group: store.phraseGroups.require(idOf(store, 'premise')), content: 'A cartographer walks in — the rewrite nobody asked for.' }],
                AUTHOR_ATTR,
                { runRef: 'run_1' }
            )
        ).toThrowError(new Error(LOCKED_REFUSAL));

        // Defense in depth means the refusal costs the book NOTHING: no revision row, no archived row,
        // no group row, no Overview bump, no mirror write, no journal line.
        expect(revisionRowOf(store)).toEqual(rows);
        expect(store.phraseGroups.list()).toEqual(groups);
        expect(store.phrases.require(phrase.id).revision).toBe(2);
        expect(store.journal).toHaveLength(events);
    });

    it('refuses a stale Writer result whose copy of the row predates the lock, and installs none of its siblings', () => {
        const { store, story } = twoWrittenGroups();
        // The batch carries the row as the sweep read it — before the Author locked it mid-pass. A check
        // on `entry.group` alone would wave this through, which is the stale-Writer hole the lock closes.
        const stalePremise = store.phraseGroups.require(idOf(store, 'premise'));

        lockPhraseGroup(store, story, stalePremise.id, AUTHOR_ATTR, { actor: 'author', at: '2026-11-25T10:00:00.000Z' });

        const rows = revisionRowOf(store);

        expect(() =>
            installGroupRevisions(
                store,
                story,
                [
                    { group: store.phraseGroups.require(idOf(store, 'promise')), content: 'The reconciliation is paid in the last chapter.' },
                    { group: stalePremise, content: 'A cartographer walks into the valley twice.' }
                ],
                AUTHOR_ATTR,
                { runRef: 'run_1' }
            )
        ).toThrowError(new Error(LOCKED_REFUSAL));

        // R2's atomicity through the lock: the unlocked sibling in the same batch installed NOTHING, so
        // the Author's Overview is the one they had, not a half-batch nobody journalled.
        expect(rowOf(store, 'promise')).toEqual({
            content: 'The map and the territory reconcile in the last chapter.',
            revision: 1,
            updated_by: 'run_0',
            locked: undefined,
            locked_revision: undefined,
            locked_by: undefined
        });
        expect(revisionRowOf(store)).toEqual(rows);
    });

    it('installs every unlocked entry of a book that has a locked sibling elsewhere', () => {
        const { store, story } = twoWrittenGroups();

        lockPhraseGroup(store, story, idOf(store, 'premise'), AUTHOR_ATTR, { actor: 'author', at: '2026-11-25T10:00:00.000Z' });

        const install = installGroupRevisions(
            store,
            story,
            [
                { group: store.phraseGroups.require(idOf(store, 'promise')), content: 'The reconciliation is paid in the last chapter.' },
                { group: store.phraseGroups.require(idOf(store, 'tone')), content: 'Plain, cold, precise.' }
            ],
            AUTHOR_ATTR,
            { runRef: 'run_1' }
        );

        // The lock stops its own group and nothing else: the loop keeps revising the rest for consistency.
        expect(install.installed.map((row) => [row.group_key, row.number, row.state])).toEqual([
            ['promise', 2, 'latest'],
            ['tone', 1, 'latest']
        ]);
        expect(install.archived.map((row) => [row.group_key, row.number, row.state])).toEqual([['promise', 1, 'archived']]);
        expect(rowOf(store, 'premise')).toEqual({
            content: 'A cartographer walks into the drowned valley.',
            revision: 1,
            updated_by: 'run_0',
            locked: true,
            locked_revision: 1,
            locked_by: 'author'
        });
    });
});

