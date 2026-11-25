/**
 * SUMMARY PHRASE R3 — `tools/reader.ts`'s group attribution, pinned at the tool layer.
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
// T-W2b: the Phrase ② lifecycle, so the finding-route fixture is the PRODUCT's state (started phrase,
// accepted brief, materialized chapter entries) rather than hand-minted group rows.
import { acceptPlotlineBrief, createPlotlineBrief, startPlotlinesPhrase } from '../phrase/controllers/plotlines';
import { AUTHOR_ATTR, seedStory } from '../run/mock';
import { Store } from '../store';
import { recordUidAt } from '../store/persist';
import { createToolRuntime } from './index';
import type { Chapter, PhraseGroup, Plotline, Story } from '../../shared/types';
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

/** The deep-review session: the group Overview's reviewer is a `critic` (R5's `check_unit` pass). */
const sessionFor = (storyId: string): RunSession => ({
    storyId,
    roleKind: 'critic',
    roleName: 'critic_1',
    runId: 'run_critic'
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
 * left to the test. `detail` is present because a Critic finding without it is refused for the D-30
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
                kind: 'proposal',
                criterion_ref: 'C-11',
                title: 'let the promise arrive in the premise, not the ending',
                detail: 'summary_0 promise states the return late; the premise already holds the map'
            })
        );

        expect(filed.ok).toBe(true);
        expect(book.store.findings.require('finding_0')).toMatchObject({
            kind: 'proposal',
            cost: 'major',
            group_refs: [premise, ending]
        });

        // An unscoped proposal is refused by the SAME R3 rule, with the same ids handed back: marking a
        // finding as a wish does not exempt it from saying which text the wish is about.
        const unscoped = await book.runtime.execute(
            book.context,
            'raiseFinding',
            filing(undefined, {
                kind: 'proposal',
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

// ── T-W2b — A FINDING ON A CONTRACT IS A FINDING ON A CHAPTER ENTRY ───────────────────────────
//
// WHY THIS RULE EXISTS: phase ② on a group-managed book is a HYBRID — the reader legs stay and file
// their defects against the §4.3 `plotlines` row, while the WRITING surface is the lane's chapter ENTRY.
// Every downstream rule joins a finding on `group_refs`: `phrase/findings.ts:findingResolution` decides
// closure over the groups it names, and `phrase/exclusion.ts:groupWorkTargets` arms a group's redraft
// from `findingGroupsStillOwed`. An unscoped contract defect therefore stays open through the install
// that answers it, and it arms a classic `wi_fix_plotline_*` pass whose only tool (`editPlotline`) is
// the surface this book no longer has. So the tool ROUTES the row the reporter named to the entry that
// owns it — the same `order` mapping the install mirrors by (`phrase/plotpoints.ts:syncPlotlineContract`)
// — and REFUSES the case it cannot map, because on a grouped book "no groups" means "every entry".
//
// The namespace question is the other half of the same rule: before T-W2b the reporter's list of
// nameable groups was `summary_mode === 'groups' ? every group : []`. Once chapter entries are a
// writing surface they have to be nameable EVEN ON A BOOK WHOSE SUMMARY RUNS CLASSIC
// (`phrase/findings.ts:findingGroupNamespace`), which is what the last pin below holds.
describe('a phase-② finding on a contract is scoped to the chapter entry that owns it (R3, T-W2b)', () => {
    const PLOTLINES_SEED =
        'Premise: a cartographer returns. Promise: the map reconciles. Ending: she floods the valley.';

    interface ContractBook {
        store: Store;
        story: Story;
        chapters: PhraseGroup[];
        contract: Plotline;
        runtime: ToolRuntime;
        critic: RunToolContext;
    }

    /**
     * A phase-② book whose Plotlines phrase is started and ACCEPTED (three chapter entries), with one
     * contract row at the order the test names. `summaryMode` lets a pin hold the Summary's OWN mode
     * classic, which is the case the namespace widening is about.
     */
    function seedContractBook(options: {
        plotlinesMode: 'groups' | 'classic';
        summaryMode?: 'groups' | 'sampling';
        contractOrder?: number;
        chapterCount?: number;
    }): ContractBook {
        const store = Store.empty();
        const seeded = seedStory(store, { phase: 'plotlines' });
        const story = store.stories.update(
            seeded.id,
            { summary_mode: options.summaryMode ?? 'sampling', plotlines_mode: options.plotlinesMode },
            AUTHOR_ATTR,
            [{ id: seeded.id, rev: seeded.rev }]
        );

        let next = 0;
        const newId = () => recordUidAt(next++);

        ensurePhraseCatalog(store, story, AUTHOR_ATTR, { newId });

        next = 20;
        const started = startPlotlinesPhrase(store, story, PLOTLINES_SEED, AUTHOR_ATTR, { newId });
        const brief = createPlotlineBrief(
            store,
            story,
            started.phrase,
            { chapter_count: options.chapterCount ?? 3 },
            AUTHOR_ATTR
        );
        const chapters = acceptPlotlineBrief(store, story, brief, AUTHOR_ATTR, { newId }).groups;

        const contract = store.plotlines.create(
            {
                story_id: story.id,
                order: options.contractOrder ?? 1,
                heading: 'The return',
                must_happen: 'Mara walks the drowned road.',
                must_change: 'She knows the valley is flooded on purpose.',
                pov: 'Mara',
                setups: 'The drowned road',
                payoffs: '',
                contract_locked: false,
                aligned: false,
                needs_recheck: false
            },
            AUTHOR_ATTR
        );

        const runtime = createToolRuntime(store);

        return { store, story, chapters, contract, runtime, critic: runtime.createContext(sessionFor(story.id)) };
    }

    /** The contract defect the phase-② reader files: a plotline target, the C-7 criterion, no group refs. */
    const contractFiling = (contractId: string, extra: Record<string, unknown> = {}) => ({
        target_ref: contractId,
        criterion_ref: 'C-7',
        title: 'chapter 1 never delivers the dam',
        detail: 'plotline_1 must_happen never reaches the dam gate the Ending depends on',
        evidence: 'plotline_1 must_happen: "Mara walks the drowned road."',
        cost: 'critical',
        ...extra
    });

    it('routes an unscoped contract defect onto the chapter entry that carries that order', async () => {
        const book = seedContractBook({ plotlinesMode: 'groups' });
        const entry = book.chapters.find((group) => group.order === 1)!;
        const result = await book.runtime.execute(book.critic, 'raiseFinding', contractFiling(book.contract.id));

        expect(result.ok).toBe(true);
        // EXACTLY the one entry that owns order 1 — not all three, which is what an unscoped row would
        // mean on a grouped book (three contract rewrites for one sentence).
        expect(book.store.findings.require('finding_0').group_refs).toEqual([entry.id]);
    });

    it('keeps the refs the reporter named, and lets a chapter id be named on a classic-Summary book', async () => {
        // `summary_mode: 'sampling'` is the point: the chapter entries are nameable because the PLOTLINE
        // phrase is group-managed, not because the Summary is.
        const book = seedContractBook({ plotlinesMode: 'groups', summaryMode: 'sampling' });
        const named = book.chapters.find((group) => group.order === 2)!;
        const result = await book.runtime.execute(book.critic, 'raiseFinding', contractFiling(book.contract.id, {
            group_refs: [named.id]
        }));

        expect(result.ok).toBe(true);
        // The reporter's attribution is never overridden — routing is the fallback for an unscoped row.
        expect(book.store.findings.require('finding_0').group_refs).toEqual([named.id]);
    });

    it('refuses a contract the entry set does not cover rather than filing it against every entry', async () => {
        const book = seedContractBook({ plotlinesMode: 'groups', contractOrder: 5 });
        const result = await book.runtime.execute(book.critic, 'raiseFinding', contractFiling(book.contract.id));

        expect(result.ok).toBe(false);
        expect(result.refused).toBe('R3');
        expect(result.message).toBe(
            refusal(
                'R3',
                `this Story's Plotlines phrase is group-managed, so a defect on chapter 5's contract has to name the chapter entry it is about, and no entry covers that order — this Story's entries are ${book.chapters
                    .map((group) => `${group.key}=${group.id}`)
                    .join(', ')}. A grouped book's finding is scoped to an entry (R3).`
            )
        );
        expect((result as { expected?: string[] }).expected).toEqual(book.chapters.map((group) => group.id));
        expect((result as { fix?: string }).fix).toBe(
            `call raiseFinding again with group_refs naming the chapter entry this defect is about (this Story's entries: ${book.chapters
                .map((group) => `${group.key}=${group.id}`)
                .join(', ')})`
        );
        // Nothing filed: a phantom "every entry" defect would arm three redrafts the Author never asked for.
        expect(book.store.findings.list()).toEqual([]);
    });

    it('leaves the classic dial unscoped, as its own reading of a contract defect always was', async () => {
        // The phrase's entries EXIST here (started, accepted); the DIAL says they are not the writing
        // surface, so the reporter's unscoped row keeps its old meaning and no ref is invented for it.
        const book = seedContractBook({ plotlinesMode: 'classic' });
        const result = await book.runtime.execute(book.critic, 'raiseFinding', contractFiling(book.contract.id));

        expect(result.ok).toBe(true);
        expect(book.store.findings.require('finding_0').group_refs).toBeUndefined();
    });
});
