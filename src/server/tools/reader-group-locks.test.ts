/**
 * GROUP LOCK R1 — `tools/reader.ts`'s `raiseFinding` against LOCKED groups, pinned at the tool layer.
 *
 * WHY THIS FILE EXISTS: a locked group is settled content — no install may rewrite it
 * (`phrase/revisions.ts:installGroupRevisions` refuses the target), and the lock already voided the claims
 * whose whole scope stood on it (`phrase/locks.ts:lockPhraseGroup` discards them). So a NEW claim aimed only
 * at locked text is not work: it would sit open, the planner would offer it no group
 * (`phrase/exclusion.ts:groupWorkTargets` never names a locked group), and the round would wait on prose the
 * Author has signed off. Three behaviours are pinned, and the third is the one that keeps the crew working:
 *
 *   1. WHOLLY LOCKED — every id the reporter named is locked → REFUSED, before the D-16 dedupe, so a call
 *      this rule refuses cannot even bump `seen_count` on a row it is not allowed to touch. The refusal
 *      names the groups (`key=id`, the copy every other group refusal here uses) and hands back the ids that
 *      are NOT locked; when the whole Overview stands, the fix is "file nothing" rather than a re-scope that
 *      would name the same locked rows under another name;
 *   2. MIXED SCOPE — some named groups locked, some open → the locked ids come OFF the stored scope and the
 *      claim files for the groups that can still move. That is the same subtraction the domain reads
 *      (`phrase/findings.ts:findingActionableScope`), stated at the moment of filing, and the result TELLS
 *      the reporter which groups dropped: a scope that quietly shrinks between call and record is how a crew
 *      starts re-filing the same claim every pass;
 *   3. NOTHING ELSE MOVES — a cross-group defect between two OPEN groups still files (the lock's rule is
 *      "the unlocked side does the consistency work", not "stop reporting"), an UNSCOPED chapter or
 *      whole-Story claim keeps the meaning R3 gave it, and a legacy book with no catalog behaves exactly as
 *      `reader-group-attribution.test.ts` already pins.
 *
 * THE FIXTURE: `run/mock.ts:seedStory` + `phrase/catalog.ts:ensurePhraseCatalog` (the ids are addresses from
 * `recordUidAt`, so a group is named by key and asserted through `idOf`), then ONE accepted
 * `installGroupRevisions` so every group has written text — an unwritten group refuses for its own reason
 * (revision 0 has no text to lock) and would answer a different question. The locks are set through the
 * domain operation itself (`phrase/locks.ts:lockPhraseGroup`, actor `author`), never by patching the row, so
 * this file proves the tool agrees with the real lock rather than with a fixture shaped like one.
 *
 * THE REFUSAL COPY: `tools/index.ts` prefixes every refusal with `Rule: <id> — `, and refusal DETAILS
 * spread onto the result (`utilities.ts:refusalResult`), so both the sentence and the `fix` the crew acts on
 * are asserted from the result row.
 */
import { describe, expect, it } from 'vitest';

import { ensurePhraseCatalog } from '../phrase/catalog';
import { installGroupRevisions } from '../phrase/revisions';
import { lockPhraseGroup } from '../phrase/locks';
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
    /** The Critic's session — the role that files Summary defects (D-17a decides who is asked). */
    context: RunToolContext;
}

const idOf = (groups: PhraseGroup[], key: string) => groups.find((group) => group.key === key)!.id;

const sessionFor = (storyId: string): RunSession => ({
    storyId,
    roleKind: 'critic',
    roleName: 'critic_1',
    runId: 'run_critic'
});

/**
 * A phase-① book whose five groups are WRITTEN at revision 1, with `lockedKeys` locked by the Author.
 *
 * `summaryMode:'sampling'` is the legacy control: it has no catalog at all, so every group rule in
 * `raiseFinding` (R3's attribution and R1's lock) is inert for it.
 */
function seedBook(lockedKeys: string[], summaryMode: 'groups' | 'sampling' = 'groups'): Book {
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

    if (groups.length > 0) {
        installGroupRevisions(
            store,
            story,
            groups.map((group) => ({ group, content: `${group.key}: the installed text.` })),
            AUTHOR_ATTR,
            { runRef: 'run_writer', workItemRef: 'wi_draft_groups_summary_0_hash_1' }
        );

        // The locks go through the domain, in catalog order, so a lock in this fixture IS the real write:
        // the group row's four fields, and any finding whose scope it swallows.
        for (const key of lockedKeys) {
            lockPhraseGroup(store, story, idOf(groups, key), AUTHOR_ATTR, { actor: 'author' });
        }
    }

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
 * The filing call the group deep review's brief asks for, with `group_refs` left to the test. `detail` is
 * present because a Critic finding without it is refused for the D-30 reason before any group rule.
 */
const filing = (groupRefs: string[] | undefined) => ({
    target_ref: 'summary_0',
    criterion_ref: 'C-14',
    title: 'the Overview promises a cartographer the Seed destroyed',
    detail: 'summary_0 promise keeps the cartographer; the Seed says the map was destroyed before she drew it',
    evidence: 'summary_0 promise: "the cartographer returns to the valley"',
    cost: 'major',
    ...(groupRefs === undefined ? {} : { group_refs: groupRefs })
});

const refusal = (rule: string, message: string) => `Rule: ${rule} — ${message}`;

/** `key=id` for the ids a refusal names — the list style every group refusal in this file uses. */
const pairs = (groups: PhraseGroup[], ids: string[]) =>
    ids
        .map((id) => `${groups.find((row) => row.id === id)!.key}=${id}`)
        .join(', ');

/** The findings and the journal as ONE snapshot, so "the refusal filed nothing" is one exact assertion. */
const filingState = (book: Book) => ({
    findings: book.store.findings.list().map((row) => ({ ...row })),
    journal: book.store.journal.length
});

/** The D-33 note every non-Editor filing carries — asserted whole so a new note is a deliberate change. */
const UNCONFIRMED_NOTE =
    'Unconfirmed until an Editor confirms, disputes or rewrites it (D-33). Nothing is repaired yet (D-34).';

describe('a finding wholly scoped to locked groups is refused, not filed (R1)', () => {
    it('refuses the single locked group and hands back the ids that are still open', async () => {
        const book = seedBook(['premise']);
        const before = filingState(book);
        const premise = idOf(book.groups, 'premise');
        const open = book.groups.filter((group) => group.key !== 'premise').map((group) => group.id);

        const result = await book.runtime.execute(book.context, 'raiseFinding', filing([premise]));

        expect(result.ok).toBe(false);
        expect(result.refused).toBe('R1');
        expect(result.message).toBe(
            refusal(
                'R1',
                `premise=${premise} is locked, so this claim is aimed at settled content — a locked group has no next revision to answer it, and a finding no Writer may act on holds the round open over text the Author has signed off (R1).`
            )
        );
        // The structured advice names the groups the crew MAY file against, in catalog order — the fix is
        // one call away, not a guess at which of the five the lock took.
        expect((result as { fix?: string }).fix).toBe(
            `call raiseFinding again with group_refs naming the groups the defect crosses that are NOT locked (${pairs(book.groups, open)}), or ask the Author to unlock the group first`
        );
        expect((result as { locked_group_refs?: string[] }).locked_group_refs).toEqual([premise]);
        expect((result as { expected?: string[] }).expected).toEqual(open);
        // Refused means nothing moved: no row, no `seen_count` bump, no journal line (P1).
        expect(filingState(book)).toEqual(before);
    });

    it('refuses all five locked groups with "file nothing", because there is no open id to re-scope to', async () => {
        const book = seedBook(['premise', 'promise', 'theme', 'tone', 'ending']);
        const before = filingState(book);
        const ids = book.groups.map((group) => group.id);

        const result = await book.runtime.execute(book.context, 'raiseFinding', filing(ids));

        expect(result.ok).toBe(false);
        expect(result.refused).toBe('R1');
        expect(result.message).toBe(
            refusal(
                'R1',
                `${pairs(book.groups, ids)} are locked, so this claim is aimed at settled content — a locked group has no next revision to answer it, and a finding no Writer may act on holds the round open over text the Author has signed off (R1).`
            )
        );
        // Every group stands: offering "name the groups that are not locked" would offer an empty list and
        // invite the same call again, so the honest advice is the Author's unlock.
        expect((result as { fix?: string }).fix).toBe(
            'file nothing against the Summary — every group of this Overview is locked; only the Author lifts a lock (POST …/phrases/groups/:groupId/unlock)'
        );
        expect((result as { expected?: string[] }).expected).toEqual([]);
        expect(filingState(book)).toEqual(before);
    });
});

describe('a mixed scope files for the groups that can still move (R1)', () => {
    it('drops the locked id from the record, echoes the drop, and keeps the unlocked scope', async () => {
        const book = seedBook(['premise']);
        const premise = idOf(book.groups, 'premise');
        const tone = idOf(book.groups, 'tone');

        const result = await book.runtime.execute(book.context, 'raiseFinding', filing([premise, tone]));

        expect(result.ok).toBe(true);
        const row = book.store.findings.list()[0];

        // The record carries the WORKABLE scope. The reporter named two groups; the claim is still the same
        // claim, aimed at the one a Writer may rewrite — which is what
        // `phrase/findings.ts:findingActionableScope` reports on every later read, so record and read agree.
        expect(row.group_refs).toEqual([tone]);
        expect((result as { data: { group_refs: string[] } }).data.group_refs).toEqual([tone]);
        expect(
            (result as { data: { locked_group_refs_dropped?: string[] } }).data.locked_group_refs_dropped
        ).toEqual([premise]);
        // The drop is said out loud, and the D-33 note is untouched alongside it.
        expect((result as { notes?: string[] }).notes).toEqual([
            UNCONFIRMED_NOTE,
            `Locked groups are settled content: premise=${premise} came off this finding's scope, which now names only the groups a Writer may still rewrite (R1). Only the Author lifts a lock.`
        ]);
    });

    it('files a cross-group defect between two OPEN groups untouched, beside a locked neighbour', async () => {
        const book = seedBook(['premise']);
        const promise = idOf(book.groups, 'promise');
        const ending = idOf(book.groups, 'ending');

        const result = await book.runtime.execute(book.context, 'raiseFinding', filing([promise, ending]));

        expect(result.ok).toBe(true);
        expect(book.store.findings.list()[0].group_refs).toEqual([promise, ending]);
        // No drop, so no note and no extra key: the lock narrows a scope only where it actually touches it,
        // and a consistency defect across the groups that CAN move stays the work it always was.
        expect((result as { locked_group_refs_dropped?: string[] }).locked_group_refs_dropped).toBeUndefined();
        expect((result as { notes?: string[] }).notes).toEqual([UNCONFIRMED_NOTE]);
    });

    it('leaves an unscoped chapter or whole-Story claim to the meaning R3 gave it', async () => {
        // Three of five locked. Neither of these named a group, so neither has a locked target to refuse:
        // an absent `group_refs` keeps R3's whole-Overview/whole-Story meaning, and the tool invents no
        // attribution the crew never typed (the voiding read is `findingActionableScope`'s, not this call's).
        const book = seedBook(['premise', 'promise', 'theme']);

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
        expect((chapter as { data: { group_refs: string[] } }).data.group_refs).toEqual([]);
        expect((chapter as { notes?: string[] }).notes).toEqual([UNCONFIRMED_NOTE]);

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
        expect((storyWide as { notes?: string[] }).notes).toEqual([UNCONFIRMED_NOTE]);
    });

    it('files on a legacy whole-Summary book with no catalog, and still refuses its stray group id (R6)', async () => {
        const book = seedBook([], 'sampling');

        const legacy = await book.runtime.execute(book.context, 'raiseFinding', filing(undefined));

        expect(legacy.ok).toBe(true);
        expect(book.store.findings.list()[0].group_refs).toBeUndefined();
        expect((legacy as { notes?: string[] }).notes).toEqual([UNCONFIRMED_NOTE]);

        const events = book.store.journal.length;
        const named = await book.runtime.execute(book.context, 'raiseFinding', filing(['grp-premise']));

        // That book has no groups at all, so R3's unknown-id refusal is the sentence it has always had —
        // the lock rule sits behind it and changes nothing.
        expect(named.ok).toBe(false);
        expect(named.refused).toBe('R3');
        expect(book.store.findings.list()).toHaveLength(1);
        expect(book.store.journal.length).toBe(events);
    });
});
