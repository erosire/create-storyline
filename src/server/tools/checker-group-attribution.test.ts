/**
 * SUMMARY PHRASE R3 — `tools/checker.ts`'s group attribution, pinned at the tool layer.
 *
 * WHY THIS FILE EXISTS: the group finding's `group_refs` is the JOIN key every downstream rule runs on —
 * the planner routes a fix to exactly those groups (`loop/work.ts:groupWorkTargets`), the rail computes
 * each group's debt (`api/projections.ts`), and closure is "every named group has a revision CLAIMING
 * this finding". The reporter is a model, so the rule that decides what may be written into that array is
 * product behaviour, and its refusals are copy the crew reads. Six things are pinned:
 *
 *   1. on a group-managed book, a phase-① finding ON THE SUMMARY must name its groups — omitting
 *      `group_refs` is a legal claim about the whole Overview, but the reporter has to CHOOSE that with
 *      the ids in front of it, because the un-chosen reading costs five group rewrites for one sentence;
 *   2. an id the Story does not have is refused, never dropped: dropping it would quietly make the row
 *      mean something the reporter did not say, and if it were the only ref, quietly mean "everything";
 *   3. one, two or all five groups are accepted, and the row carries exactly what was named — normalised
 *      by the SAME rule `related_refs` uses (trim, drop blanks, dedupe, first-seen order);
 *   4. a REPEAT sighting widens the open row's scope instead of filing a second claim (L-11a's merge,
 *      existing order first, new ids appended), and a repeat that names nothing new changes only
 *      `seen_count`;
 *   5. everything else is untouched: a chapter defect, and a legacy (sampling) book's Summary defect,
 *      keep the rules they had — including D-33's draft-attribution rule the group model replaces;
 *   6. and a group id named on a LEGACY book is refused: that book has no groups, so accepting the ref
 *      would file a defect nothing can ever close.
 *
 * The closure half of R3 ("`fixed` only when EVERY targeted group has installed a revision claiming it")
 * lives in `phrase/findings.ts` and is pinned in `phrase/findings.test.ts` — including the two-group case
 * that must NOT close early. This file is only about what may enter the array.
 *
 * THE FIXTURE: `run/mock.ts:seedStory` plus `phrase/catalog.ts:ensurePhraseCatalog` with `recordUidAt`, so
 * every group id below is a literal the reader can point at. The factory is called for the Phrase row
 * first and then for the five groups in catalog order, so `recordUidAt(1)` is the Phrase and
 * `recordUidAt(2)`…`recordUidAt(6)` are premise…ending — and `recordUidAt(0)` is an address this book
 * never minted, which is what the unknown-id refusal needs.
 *
 * THE REFUSAL COPY: `tools/index.ts` prefixes every refusal with `Rule: <id> — `, so the strings below
 * carry it; the sentences themselves are pinned verbatim, because they are what the crew reads and the
 * fix it acts on.
 */
import { describe, expect, it } from 'vitest';

import { ensurePhraseCatalog } from '../phrase/catalog';
import { AUTHOR_ATTR, seedStory } from '../run/mock';
import { Store } from '../store';
import { recordUidAt } from '../store/persist';
import { createToolRuntime } from './index';
import type { Chapter, PhraseGroup, Story } from '../../shared/types';
import type { RunSession, RunToolContext, ToolRuntime } from './index';

interface Book {
    store: Store;
    story: Story;
    groups: PhraseGroup[];
    chapter: Chapter;
    runtime: ToolRuntime;
    context: RunToolContext;
}

/** The catalog order, so a test can name a group by key and still assert its pinned id. */
const idOf = (groups: PhraseGroup[], key: string) => groups.find((group) => group.key === key)!.id;

/** The deep-review session: the group Overview's reviewer is a `reader` (R5's `check_unit` pass). */
const sessionFor = (storyId: string): RunSession => ({
    storyId,
    roleKind: 'reader',
    roleName: 'reader_1',
    runId: 'run_reader'
});

/**
 * A phase-① book on either pipeline. The switch is set BEFORE the catalog is ensured because
 * `phrase/catalog.ts:isGroupManagedStory` reads `stories.summary_mode` — not the presence of rows — and
 * the tool reads that same Story row.
 */
function seedBook(summaryMode: 'groups' | 'sampling'): Book {
    const store = Store.empty();
    const seeded = seedStory(store, { phase: 'summary' });
    const story = store.stories.update(
        seeded.id,
        { summary_mode: summaryMode },
        { run_ref: null, author: true, why: 'seed: the Summary pipeline under test (R1)' },
        [{ id: seeded.id, rev: seeded.rev }]
    );

    let next = 1;
    const groups =
        summaryMode === 'groups'
            ? ensurePhraseCatalog(store, story, AUTHOR_ATTR, { newId: () => recordUidAt(next++) })!.groups
            : [];

    const chapter = store.chapters.create(
        {
            story_id: story.id,
            order: 1,
            title: 'The Ridge',
            summary: 'She reaches the ridge and reads the water.',
            sections: [{ id: 'section_1', text: 'The standing text.', origin: 'writer' }],
            state: 'drafting',
            author_locked: false,
            round: 1
        },
        { run_ref: null, author: true, why: 'seed: a chapter for the untouched-path control (R3)' }
    );

    const runtime = createToolRuntime(store);

    return { store, story, groups, chapter, runtime, context: runtime.createContext(sessionFor(story.id)) };
}

/**
 * The filing call the group deep review's brief asks for (the note in `loop/work.ts`), with `group_refs`
 * left to the test. `detail` is present because a Reader finding without it is refused for the D-30
 * reason before any group rule is reached.
 */
const filing = (groupRefs: string[] | undefined, extra: Record<string, unknown> = {}) => ({
    target_ref: 'summary_0',
    criterion_ref: 'C-14',
    title: 'the Overview promises a cartographer the Seed destroyed',
    detail: 'summary_0 promise keeps the cartographer; the Seed says the map was destroyed before she drew it',
    evidence: 'summary_0 promise: "the cartographer returns to the valley"',
    cost: 'major',
    ...(groupRefs === undefined ? {} : { group_refs: groupRefs }),
    ...extra
});

/** The refusal list the two group refusals print: `key=id` for every group the Story has. */
const groupList = (groups: PhraseGroup[]) => groups.map((group) => `${group.key}=${group.id}`).join(', ');

/**
 * The exact refusal the runtime returns: `tools/index.ts` prefixes the rule id, and the sentence after the
 * prefix is the copy the crew reads, so both halves are pinned.
 */
const refusal = (rule: string, message: string) => `Rule: ${rule} — ${message}`;

describe('a Summary defect on a group book has to name its groups (R3)', () => {
    it('refuses the unscoped filing and hands the reporter the ids it may name', async () => {
        const book = seedBook('groups');
        const result = await book.runtime.execute(book.context, 'raiseFinding', filing(undefined));

        expect(result.ok).toBe(false);
        expect(result.refused).toBe('R3');
        expect(result.message).toBe(
            refusal(
                'R3',
                `this Summary is written group by group, so a defect on it has to say which groups it is about: ${groupList(
                    book.groups
                )}. A finding that names none is read as "the whole Overview", and the fix would rewrite all five groups to answer one sentence (R3).`
            )
        );
        // Nothing moves on a refusal (P1): the book has no half-filed defect and no journal noise.
        expect(book.store.findings.list()).toEqual([]);
        expect(book.store.journal.filter((event) => event.collection === 'findings')).toEqual([]);
    });

    it('refuses a group id this Story does not have, rather than widening the defect by accident', async () => {
        const book = seedBook('groups');
        const premise = idOf(book.groups, 'premise');
        // A well-formed group address this Story never minted (`recordUidAt(0)` predates the catalog, which
        // starts at 1 for the Phrase row): the mistake a reporter makes when it copies an id out of a
        // different book, or invents one that looks right.
        const notAGroup = recordUidAt(0);

        const one = await book.runtime.execute(book.context, 'raiseFinding', filing([notAGroup]));

        expect(one.ok).toBe(false);
        expect(one.refused).toBe('R3');
        expect(one.message).toBe(
            refusal(
                'R3',
                `${notAGroup} is not a group of this Story — its groups are ${groupList(book.groups)}. ` +
                    'A defect cannot be closed against a group that does not exist (R3).'
            )
        );

        // Two unknown ids read as one list, so the fix is one call, not two guesses.
        const two = await book.runtime.execute(book.context, 'raiseFinding', filing([notAGroup, recordUidAt(42)]));

        expect(two.message).toBe(
            refusal(
                'R3',
                `${notAGroup}, ${recordUidAt(42)} are not a group of this Story — its groups are ${groupList(
                    book.groups
                )}. A defect cannot be closed against a group that does not exist (R3).`
            )
        );

        // A mixed call — one real ref and one invented — is refused WHOLE rather than filed with the real
        // one: silently dropping the invented ref would make the row mean less than the reporter said.
        const mixed = await book.runtime.execute(book.context, 'raiseFinding', filing([premise, notAGroup]));

        expect(mixed.ok).toBe(false);
        expect(book.store.findings.list()).toEqual([]);
    });

    it('accepts one, two, or all five groups, and stores exactly what was named', async () => {
        const book = seedBook('groups');
        const [premise, tone, ending] = ['premise', 'tone', 'ending'].map((key) => idOf(book.groups, key));

        const one = await book.runtime.execute(book.context, 'raiseFinding', filing([premise]));

        expect(one.ok).toBe(true);
        // R3's join key on the ROW, not only in the reply: this is the array the planner and the closure
        // rule read.
        expect(book.store.findings.require('finding_0').group_refs).toEqual([premise]);

        const two = await book.runtime.execute(
            book.context,
            'raiseFinding',
            filing([tone, ending], { criterion_ref: 'C-15', title: 'the ending contradicts the promise' })
        );

        expect(two.ok).toBe(true);
        expect(book.store.findings.require('finding_1').group_refs).toEqual([tone, ending]);

        // All five — the "it really is the whole Overview" claim, made WITH the ids in hand, which is the
        // difference this rule enforces. Padded and repeated entries normalise to the order sent.
        const all = await book.runtime.execute(
            book.context,
            'raiseFinding',
            filing(
                [` ${idOf(book.groups, 'ending')} `, ...book.groups.map((group) => group.id), idOf(book.groups, 'ending'), '  '],
                { criterion_ref: 'C-13', title: 'every group contradicts the Seed' }
            )
        );

        expect(all.ok).toBe(true);
        expect(book.store.findings.require('finding_2').group_refs).toEqual([
            idOf(book.groups, 'ending'),
            ...book.groups.map((group) => group.id).filter((id) => id !== idOf(book.groups, 'ending'))
        ]);
    });

    it('scopes a proposal to its groups exactly as it scopes a defect (D-33b, R3)', async () => {
        const book = seedBook('groups');
        const [premise, ending] = ['premise', 'ending'].map((key) => idOf(book.groups, key));

        // The two additive fields are independent and both are enforced on the same call: `group_refs`
        // routes and closes the repair (R3), `kind` decides which rule the Editor runs on the claim
        // (D-33b). A proposal on a grouped book pays the group rule exactly as a defect does.
        const filed = await book.runtime.execute(
            book.context,
            'raiseFinding',
            filing([premise, ending], {
                kind: 'improvement',
                criterion_ref: 'C-11',
                title: 'let the promise arrive in the premise, not the ending',
                detail: 'summary_0 promise states the return late; the premise already holds the map'
            })
        );

        expect(filed.ok).toBe(true);
        expect(book.store.findings.require('finding_0')).toMatchObject({
            kind: 'improvement',
            cost: 'major',
            group_refs: [premise, ending]
        });

        // An unscoped proposal is refused by the SAME R3 rule, with the same ids handed back: marking a
        // finding as a wish does not exempt it from saying which text the wish is about.
        const unscoped = await book.runtime.execute(
            book.context,
            'raiseFinding',
            filing(undefined, {
                kind: 'improvement',
                criterion_ref: 'C-13',
                title: 'state the debt in the tone group',
                detail: 'summary_0 tone never names the debt the premise owes'
            })
        );

        expect(unscoped.ok).toBe(false);
        expect(unscoped.refused).toBe('R3');
    });

    it('widens the open row on a repeat sighting instead of filing a second claim (L-11a, R3)', async () => {
        const book = seedBook('groups');
        const [premise, promise] = ['premise', 'promise'].map((key) => idOf(book.groups, key));

        const first = await book.runtime.execute(book.context, 'raiseFinding', filing([premise]));

        expect(first.ok).toBe(true);

        // The same defect seen again, one group wider. D-16's fingerprint matches, so the loop gets ONE
        // row — and the scope it now has must include both groups, or the fix would rewrite only one half
        // of a cross-group defect forever.
        const again = await book.runtime.execute(book.context, 'raiseFinding', filing([promise, premise]));

        expect(again.ok).toBe(true);
        expect(book.store.findings.list()).toHaveLength(1);
        // Existing order first, the new id appended — the same merge rule `related_refs` follows.
        expect(book.store.findings.require('finding_0').group_refs).toEqual([premise, promise]);
        expect((again as { data: { seen_count: number; group_refs: string[] } }).data).toMatchObject({
            seen_count: 2,
            group_refs: [premise, promise]
        });

        // A repeat that names nothing new changes the count and nothing else.
        const identical = await book.runtime.execute(book.context, 'raiseFinding', filing([premise, promise]));

        expect(book.store.findings.require('finding_0')).toMatchObject({ seen_count: 3 });
        expect(book.store.findings.require('finding_0').group_refs).toEqual([premise, promise]);
        void identical;
    });

    it('leaves a chapter defect and a Story-targeted defect to the rules they already had', async () => {
        const book = seedBook('groups');

        // A phase ②/③ defect is aimed at its own row: there is no Overview group question to answer, so
        // the argument stays optional and no `group_refs` field is written at all.
        const chapter = await book.runtime.execute(book.context, 'raiseFinding', {
            target_ref: book.chapter.id,
            criterion_ref: 'C-13',
            title: 'chapter 1 never pays the map',
            detail: 'chapter_0 section_1 mentions the map and drops it',
            evidence: 'chapter_0 section_1: "she looked for the map"',
            cost: 'major'
        });

        expect(chapter.ok).toBe(true);
        expect(book.store.findings.require('finding_0').group_refs).toBeUndefined();

        // A whole-Story defect (L-11a's propagation target) is not a Summary defect either.
        const storyWide = await book.runtime.execute(book.context, 'raiseFinding', {
            target_ref: book.story.id,
            criterion_ref: 'C-13',
            title: 'the book never reconciles the map and the water',
            detail: 'no chapter answers the premise',
            evidence: 'the Summary promise and chapter_0 disagree',
            cost: 'critical',
            related_refs: [book.chapter.id]
        });

        expect(storyWide.ok).toBe(true);
        expect(book.store.findings.require('finding_1').group_refs).toBeUndefined();
    });
});

describe('a legacy sampling book keeps its own attribution rule (R6, D-33)', () => {
    it('files the whole-Overview defect it always filed, and still demands the draft it describes', async () => {
        const book = seedBook('sampling');

        // Before the first selection there is no draft to name, so the legacy filing lands exactly as it
        // did before the redesign — and with no `group_refs` field on the row, which is what
        // `phrase/findings.ts:findingGroupScope` reads as "the whole Overview".
        const before = await book.runtime.execute(book.context, 'raiseFinding', filing(undefined));

        expect(before.ok).toBe(true);
        expect(book.store.findings.require('finding_0').group_refs).toBeUndefined();

        // The selection installs a draft; from then on D-33's rule governs this book exactly as before.
        book.store.revisions.create(
            {
                story_id: book.story.id,
                body: { premise: 'A return, on foot.', promise: 'The map and the territory reconcile.' },
                unit_kind: 'summary',
                unit_ref: 'summary_0',
                run_ref: 'run_writer',
                state: 'selected',
                verdict_refs: []
            },
            { run_ref: 'run_writer', why: 'seed: the carried Summary draft (D-33)' }
        );

        const stale = await book.runtime.execute(book.context, 'raiseFinding', filing(undefined));

        expect(stale.ok).toBe(false);
        expect(stale.refused).toBe('D-33');
        expect(stale.message).toBe(
            refusal(
                'D-33',
                'a phase ① finding on the Summary has to name the draft it describes: the Summary now carries ' +
                    'revision_0, and a finding that names no draft cannot be verified against it (D-33, §6.4 step 6).'
            )
        );

        // A DIFFERENT defect this time: the same target+criterion+title would be D-16's repeat sighting and
        // bump `finding_0` instead of opening a row, which is a different rule with its own pins.
        const named = await book.runtime.execute(
            book.context,
            'raiseFinding',
            filing(undefined, { criterion_ref: 'C-15', title: 'the promise is stated twice and paid once', related_refs: ['revision_0'] })
        );

        expect(named.ok).toBe(true);
        expect(book.store.findings.require('finding_1')).toMatchObject({ related_refs: ['revision_0'] });
        expect(book.store.findings.require('finding_1').group_refs).toBeUndefined();
    });

    it('refuses a group id on a book that has no groups, instead of filing an unclosable defect', async () => {
        const book = seedBook('sampling');
        const result = await book.runtime.execute(book.context, 'raiseFinding', filing([recordUidAt(1)]));

        expect(result.ok).toBe(false);
        expect(result.refused).toBe('R3');
        expect(result.message).toBe(
            refusal('R3', `${recordUidAt(1)} is not a group of this Story. A defect cannot be closed against a group that does not exist (R3).`)
        );
        expect(book.store.findings.list()).toEqual([]);
    });
});
