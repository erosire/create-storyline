/**
 * THE REVIEWED SUMMARY (D-67, D-68) — the clean revision per group, the Overview compiled from them,
 * the Clean stamp a cross-group review leaves, and the Author's choose.
 *
 * The feature's whole point is that the Reader is shown the Summary the loop has STOPPED rejecting, and
 * the pins below are the parts that make that claim true:
 *
 *   1. LATEST-CLEAN, NOT LATEST (`cleanSelectionOf`). The worked example this design was asked for: an
 *      Ending group whose r1 carried a defect, r2 was clean, r3 carried one, r4 was clean and r5 carries
 *      one again, selects **r4** — while `ending.revision` is still 5 and the live Overview still prints
 *      r5. Premise (r1 clean, r2 defective, r3 clean) selects r3, and Promise (r1, r2 defective, r3
 *      clean) selects r3. A rule that read "the newest clean row that is also current" would answer
 *      NOTHING for Ending, which is the bug this file exists to keep fixed.
 *   2. AN OPEN ISSUE BLOCKS THE GROUP, newest stamp or not — the same predicate the crew's own gates use
 *      (`loop/records.ts:openIssueFindings` + `phrase/findings.ts:findingGroupScope`), so the Clean
 *      verdict and the work queue cannot disagree, and revocation needs no machinery and no memory.
 *   3. THE STAMP IS THE DEEP PASS'S PRODUCT (`stampCleanRevisions`): it answers to the deep review's claim
 *      key only, refuses when the vector moved under the pass, skips a group an open issue still names,
 *      and is idempotent.
 *   4. THE CHOOSE IS AN INSTALL, NOT AN EDIT (`chooseReviewedSummary`): the selected texts go in as each
 *      group's NEXT latest revision, every other revision of the Story becomes `discarded` and PERSISTS
 *      (R3's `fixed` findings stay `fixed` — `phrase/findings.ts:groupResolvesFinding` walks the history
 *      with no state filter), and the choice is recorded on the Phrase row.
 *
 *   5. A LOCKED GROUP IS CHOSEN AS IT STANDS (the group lock): the lock removes the only question a
 *      reviewed selection asks of a group — "which of your texts should replace the current one?" — so
 *      `cleanSelectionOf` selects a locked group's CURRENT row, an open finding on it stops blocking the
 *      book, and the choose RETAINS that row instead of installing a fresh revision of frozen prose.
 *      The lock op itself is `phrase/locks.ts`; the pins here are the reviewed-selection half.
 *
 * Every value below was read off a probe run (`Temp/tc1/`), not guessed. Group ids are UIDs the store
 * mints, so expectations are functions of the rows, never hardcoded addresses; the texts are literals
 * because they are the inputs this file chooses.
 */
import { describe, expect, it } from 'vitest';
import { Store } from '../store';
import { AUTHOR_ATTR, seedStory } from '../run/mock';
import { recordUidAt } from '../store/persist';
import { composeGroupContentFrom, ensurePhraseCatalog, phraseGroupsOf } from './catalog';
import { groupRevisionVector, groupVectorHash, installGroupRevisions, latestGroupRevision } from './revisions';
import { closeFindingWhenGroupsResolved, findingResolution } from './findings';
import { lockPhraseGroup } from './locks';
import { groupCheckSeatKey } from './exclusion';
import {
    chooseReviewedSummary,
    chosenSelectionOf,
    cleanSelectionOf,
    composeReviewedOverview,
    openIssueGroupIds,
    stampCleanRevisions
} from './reviewed';
import type { GroupRevision, PhraseGroup, Story } from '../../shared/types';
// The journal's attribution record comes from the store module (store.ts:203), not from shared/types.
import type { Attribution } from '../store';

/** The attribution every fixture writes under; the `why` sentences themselves are pinned in `routes.test.ts`. */
const ATTR: Attribution = { run_ref: null, author: true, why: 'seed: the Author is driving this write (D-68)' };

/** A Story with the five-group Summary Phrase catalog and no revisions yet. */
function seedBook() {
    const store = Store.empty();
    const seeded = seedStory(store, { phase: 'summary' });
    let next = 0;

    ensurePhraseCatalog(store, seeded, AUTHOR_ATTR, { newId: () => recordUidAt(next++) });

    const story = (): Story => store.stories.require(seeded.id);
    const groups = (): PhraseGroup[] => phraseGroupsOf(store, seeded.id);
    const group = (key: string): PhraseGroup => groups().find((row) => row.key === key)!;

    return { store, story, groups, group, storyId: seeded.id };
}

type Book = ReturnType<typeof seedBook>;

/** The group's next revision, through the only write path a group text has (R2: numbered, latest, previous archived). */
const write = (book: Book, key: string, content: string, findingRefs: readonly string[] = []): GroupRevision => {
    const installed = installGroupRevisions(
        book.store,
        book.story(),
        [{ group: book.group(key), content }],
        ATTR,
        { runRef: 'run_writer', workItemRef: `wi_group_write_test_${key}` }
    ).installed[0]!;

    if (findingRefs.length === 0) return installed;

    // R3's explicit claim: the row says which finding it answers. `installGroupRevisions` leaves the
    // field empty (a batch may answer several, and the caller names them), so the fixture sets it here.
    return book.store.groupRevisions.update(
        installed.id,
        { finding_refs: [...findingRefs] },
        ATTR,
        [{ id: installed.id, rev: installed.rev }]
    );
};

/** The Clean stamp, written the way the deep pass's settle writes it — on the group's CURRENT row. */
const stamp = (book: Book, key: string, runRef: string): GroupRevision => {
    const current = latestGroupRevision(book.store, book.group(key).id)!;

    return book.store.groupRevisions.update(
        current.id,
        { clean: true, clean_run_ref: runRef },
        { ...ATTR, why: `seed: ${key} passed the cross-group review of that vector (D-67)` },
        [{ id: current.id, rev: current.rev }]
    );
};

/** The vector hash a deep-review seat would currently be claimed under — the same read the engine uses. */
const seatKey = (book: Book, pass = 1): string =>
    groupCheckSeatKey(groupVectorHash(groupRevisionVector(book.store, book.storyId)), pass);

/** Every revision row of the book, as `key:number:state[:clean]` — the state a choose is judged on. */
const rowsOf = (book: Book): string[] =>
    book.store.groupRevisions
        .list()
        .filter((row) => row.story_id === book.storyId)
        .map((row) => `${row.group_key}:${row.number}:${row.state}${row.clean === true ? ':clean' : ''}`)
        .sort();

/**
 * THE WORKED EXAMPLE, end to end: five groups, each with its own history of defects and clean passes, and
 * the newest text of the Ending group carrying a defect again.
 *
 * - premise r1 clean, r2 defect, r3 clean → **r3** (the newest clean row is also current)
 * - promise r1 defect, r2 defect, r3 clean → **r3** (the first time it passed)
 * - theme r1 clean → r1; tone r1 clean → r1
 * - ending r1 defect, r2 clean, r3 defect, r4 clean, r5 defect → **r4** (the current text is r5)
 */
function workedExample() {
    const book = seedBook();

    write(book, 'premise', 'premise r1.');
    stamp(book, 'premise', 'run_check_1');
    write(book, 'premise', 'premise r2, the one that broke the promise.');
    write(book, 'premise', 'premise r3.');
    stamp(book, 'premise', 'run_check_3');

    write(book, 'promise', 'promise r1.');
    write(book, 'promise', 'promise r2.');
    write(book, 'promise', 'promise r3.');
    stamp(book, 'promise', 'run_check_3');

    write(book, 'theme', 'theme r1.');
    stamp(book, 'theme', 'run_check_1');

    write(book, 'tone', 'tone r1.');
    stamp(book, 'tone', 'run_check_1');

    write(book, 'ending', 'ending r1.');
    write(book, 'ending', 'ending r2.');
    stamp(book, 'ending', 'run_check_2');
    write(book, 'ending', 'ending r3.');
    write(book, 'ending', 'ending r4.');
    stamp(book, 'ending', 'run_check_4');
    write(book, 'ending', 'ending r5, the newest text and a defect on it.');

    return book;
}

/** An open `issue` finding scoped to `groupKeys` (D-33c's open set: `approved` is open and authorised). */
function openIssue(book: Book, groupKeys: readonly string[], title = 'the ending drops the promise it sold'): string {
    const groups = groupKeys.length === 0 ? [] : groupKeys.map((key) => book.group(key).id);

    return book.store.findings.create(
        {
            story_id: book.storyId,
            target_ref: `phrase:${book.groups()[0].phrase_id}`,
            criterion_ref: 'criterion_test',
            title,
            evidence: 'The last line promises nothing.',
            cost: 'major',
            kind: 'issue',
            fingerprint: `fp_${title.replace(/\W+/g, '_')}`,
            state: 'approved',
            approved_by: 'auto',
            seen_count: 1,
            ...(groups.length === 0 ? {} : { group_refs: groups })
        },
        ATTR
    ).id;
}

describe('the reviewed selection is the LATEST clean revision of each group (D-67)', () => {
    it('picks the worked example: Ending r4 over the current r5, Premise r3, Promise r3', () => {
        const book = workedExample();
        const selection = cleanSelectionOf(book.store, book.story());

        // Catalog order, and each entry names the revision the reviewed Overview is built from.
        expect(selection.entries.map((entry) => [entry.group.key, entry.revision.number, entry.revision.content])).toEqual([
            ['premise', 3, 'premise r3.'],
            ['promise', 3, 'promise r3.'],
            ['theme', 1, 'theme r1.'],
            ['tone', 1, 'tone r1.'],
            ['ending', 4, 'ending r4.']
        ]);
        expect(selection.complete).toBe(true);
        expect(selection.gaps).toEqual([]);
        expect(selection.vector).toEqual({
            [book.group('premise').id]: 3,
            [book.group('promise').id]: 3,
            [book.group('theme').id]: 1,
            [book.group('tone').id]: 1,
            [book.group('ending').id]: 4
        });
        // The identity the Reader's scores are keyed by is the SELECTION's, recomputed with the install
        // side's own function so a choose and a scoring pass can never disagree about one book.
        expect(selection.vector_hash).toBe(groupVectorHash(selection.vector));
    });

    it('leaves the live book alone — the group still reports r5 and the Overview still prints r5', () => {
        const book = workedExample();
        const selection = cleanSelectionOf(book.store, book.story());

        expect(book.group('ending')).toMatchObject({ revision: 5, content: 'ending r5, the newest text and a defect on it.' });
        // The reviewed Overview is composed from the SELECTED rows by the same composition the live
        // Overview uses, so a choose later installs byte-identical prose.
        expect(composeReviewedOverview(selection)).toBe(
            composeGroupContentFrom(
                selection.entries.map((entry) => ({ ...entry.group, content: entry.revision.content }) as PhraseGroup)
            )
        );
        expect(composeReviewedOverview(selection)).toContain('ending r4.');
        expect(composeReviewedOverview(selection)).not.toContain('ending r5');
        expect(composeGroupContentFrom(book.groups())).toContain('ending r5');
    });

    it('selects nothing for a group whose every row is discarded, and says which text failed', () => {
        const book = workedExample();
        const ending = book.group('ending');

        // A choose discards the rows its choice passed over, and a DISCARDED row is not a candidate for
        // the NEXT reviewed Overview — the clean verdict belongs to a prose line the book no longer
        // stands behind. Ending r2 and r4 keep their stamps, and Ending still has no selection.
        for (const row of book.store.groupRevisions.list()) {
            if (row.group_id === ending.id) {
                book.store.groupRevisions.update(row.id, { state: 'discarded' }, ATTR, [{ id: row.id, rev: row.rev }]);
            }
        }

        expect(
            cleanSelectionOf(book.store, book.story()).entries.map((entry) => [entry.group.key, entry.revision.number])
        ).toEqual([
            ['premise', 3],
            ['promise', 3],
            ['theme', 1],
            ['tone', 1]
        ]);

        // A row that was merely un-stamped (a Seed reset re-grew the numbers) reads the same way, and the
        // gap still names the newest text — the one the Author sees on the rail.
        book.store.groupRevisions
            .list()
            .filter((row) => row.group_id === ending.id && row.clean === true)
            .forEach((row) =>
                // Clearing a stamp is a write WITHOUT the field's truth: `clean: false` and an absent
                // `clean` read identically (the selection tests `clean === true`), which is what keeps a
                // pre-D-67 row and a re-grown row on one code path. `clean_run_ref` is only ever read off
                // a row the selection actually selected, so an unstamped row's value never reaches the
                // wire and does not need clearing here.
                book.store.groupRevisions.update(row.id, { state: 'archived', clean: false }, ATTR, [
                    { id: row.id, rev: row.rev }
                ])
            );

        const selection = cleanSelectionOf(book.store, book.story());

        expect(selection.complete).toBe(false);
        expect(selection.entries.map((entry) => entry.group.key)).toEqual(['premise', 'promise', 'theme', 'tone']);
        expect(selection.gaps).toEqual([
            { group_id: ending.id, group_key: 'ending', reason: 'no_clean_revision', latest: 5, issues_open: false }
        ]);
    });

    it('reports an unwritten group as a gap of its own kind, with latest 0', () => {
        const book = seedBook();

        write(book, 'premise', 'premise r1.');

        expect(cleanSelectionOf(book.store, book.story()).gaps).toEqual([
            { group_id: book.group('premise').id, group_key: 'premise', reason: 'no_clean_revision', latest: 1, issues_open: false },
            { group_id: book.group('promise').id, group_key: 'promise', reason: 'unwritten', latest: 0, issues_open: false },
            { group_id: book.group('theme').id, group_key: 'theme', reason: 'unwritten', latest: 0, issues_open: false },
            { group_id: book.group('tone').id, group_key: 'tone', reason: 'unwritten', latest: 0, issues_open: false },
            { group_id: book.group('ending').id, group_key: 'ending', reason: 'unwritten', latest: 0, issues_open: false }
        ]);
    });

    it('blocks a stamped group whose open issue still names it, and names the open defect', () => {
        const book = workedExample();

        // Every group is selectable until the deep pass files a defect on Ending — and then r4 stops
        // being selectable even though it carries the stamp, because a clean verdict predates the finding.
        openIssue(book, ['ending'], 'the ending contradicts the premise');

        const selection = cleanSelectionOf(book.store, book.story());

        expect(selection.complete).toBe(false);
        expect(selection.entries.map((entry) => entry.group.key)).toEqual(['premise', 'promise', 'theme', 'tone']);
        expect(selection.gaps).toEqual([
            { group_id: book.group('ending').id, group_key: 'ending', reason: 'no_clean_revision', latest: 5, issues_open: true }
        ]);
    });

    it('reads a Story-wide open issue against every group it scopes to', () => {
        const book = workedExample();

        // An UNSCOPED finding targets the whole Overview (the legacy reading), so it blocks all five
        // groups at once — the same scope `phrase/findings.ts:findingResolution` closes on.
        openIssue(book, [], 'the Overview promises a book it does not deliver');

        const selection = cleanSelectionOf(book.store, book.story());

        expect(selection.complete).toBe(false);
        expect(selection.entries).toEqual([]);
        expect(selection.gaps.map((gap) => [gap.group_key, gap.issues_open])).toEqual([
            ['premise', true],
            ['promise', true],
            ['theme', true],
            ['tone', true],
            ['ending', true]
        ]);
    });
});

describe('the Clean stamp is the deep review pass\'s product (D-67)', () => {
    /** Installs one revision for every group, in catalog order — the vector a deep pass would read. */
    function fullBook(book = seedBook()) {
        for (const group of book.groups()) write(book, group.key, `${group.key} r1.`);

        return book;
    }

    it('stamps the current row of every group the closed pass read, and says so per row', () => {
        const book = fullBook();
        const result = stampCleanRevisions(book.store, book.story(), { seatKey: seatKey(book), runRef: 'run_check_1' }, ATTR);

        expect(result.vector_hash).toBe(groupVectorHash(groupRevisionVector(book.store, book.storyId)));
        expect(result.stamped.map((row) => [row.group_key, row.number, row.clean, row.clean_run_ref])).toEqual([
            ['premise', 1, true, 'run_check_1'],
            ['promise', 1, true, 'run_check_1'],
            ['theme', 1, true, 'run_check_1'],
            ['tone', 1, true, 'run_check_1'],
            ['ending', 1, true, 'run_check_1']
        ]);
        expect(result.skipped).toEqual([]);
    });

    it('is idempotent — a replayed settle re-stamps nothing and rewrites no run ref', () => {
        const book = fullBook();
        const seat = seatKey(book);

        stampCleanRevisions(book.store, book.story(), { seatKey: seat, runRef: 'run_check_1' }, ATTR);
        const replay = stampCleanRevisions(book.store, book.story(), { seatKey: seat, runRef: 'run_check_1_replay' }, ATTR);

        expect(replay.stamped).toEqual([]);
        expect(replay.skipped).toEqual([
            { group_id: book.group('premise').id, group_key: 'premise', reason: 'already-stamped' },
            { group_id: book.group('promise').id, group_key: 'promise', reason: 'already-stamped' },
            { group_id: book.group('theme').id, group_key: 'theme', reason: 'already-stamped' },
            { group_id: book.group('tone').id, group_key: 'tone', reason: 'already-stamped' },
            { group_id: book.group('ending').id, group_key: 'ending', reason: 'already-stamped' }
        ]);
        // The FIRST pass's run ref survives the replay: the stamp belongs to the pass that earned it.
        expect(
            book.store.groupRevisions
                .list()
                .filter((row) => row.story_id === book.storyId)
                .map((row) => row.clean_run_ref)
        ).toEqual(['run_check_1', 'run_check_1', 'run_check_1', 'run_check_1', 'run_check_1']);
    });

    it('refuses a pass whose vector moved while it ran — the verdict is about the combination it read', () => {
        const book = fullBook();
        const seat = seatKey(book);

        // A Writer installs a new Ending revision mid-pass: the rows the Critic read are no longer the
        // group's current text, so nothing may be certified by this settle.
        write(book, 'ending', 'ending r2, installed while the pass ran.');

        const result = stampCleanRevisions(book.store, book.story(), { seatKey: seat, runRef: 'run_check_2' }, ATTR);
        const read = groupVectorHash({
            [book.group('premise').id]: 1,
            [book.group('promise').id]: 1,
            [book.group('theme').id]: 1,
            [book.group('tone').id]: 1,
            [book.group('ending').id]: 1
        });

        // One skip, no group named: the pass as a whole is what the verdict was about.
        expect(result).toEqual({
            stamped: [],
            skipped: [{ group_id: '', group_key: '', reason: 'vector-moved-mid-pass' }],
            vector_hash: read
        });
        // The new vector owes its own pass, and the rows the old pass read stay un-stamped.
        expect(latestGroupRevision(book.store, book.group('ending').id)?.number).toBe(2);
        expect(latestGroupRevision(book.store, book.group('ending').id)?.clean).toBeUndefined();
    });

    it('skips a group an open issue still names, and stamps the other four', () => {
        const book = fullBook();

        openIssue(book, ['tone'], 'the tone abandons the register the Seed committed to');

        const result = stampCleanRevisions(book.store, book.story(), { seatKey: seatKey(book), runRef: 'run_check_1' }, ATTR);

        expect(result.stamped.map((row) => row.group_key)).toEqual(['premise', 'promise', 'theme', 'ending']);
        expect(result.skipped).toEqual([
            { group_id: book.group('tone').id, group_key: 'tone', reason: 'open-issue-scopes-to-group' }
        ]);
    });

    it('skips a group nobody has written, and answers nothing at all to a seat outside the deep-review family', () => {
        const book = seedBook();

        for (const group of book.groups().slice(0, 4)) write(book, group.key, `${group.key} r1.`);

        expect(
            stampCleanRevisions(book.store, book.story(), { seatKey: seatKey(book), runRef: 'run_check_1' }, ATTR).skipped
        ).toEqual([{ group_id: book.group('ending').id, group_key: 'ending', reason: 'group-unwritten' }]);

        // The legacy `'sampling'` deep review (`wi_review_<revision>_a1`, §16) is NOT a stamper: its claim
        // key names no group vector, so a mixed-mode book cannot earn a grouped clean verdict from it.
        expect(
            stampCleanRevisions(book.store, book.story(), { seatKey: 'wi_review_summary_0_a1', runRef: 'run_check_1' }, ATTR)
        ).toEqual({
            stamped: [],
            skipped: [{ group_id: '', group_key: '', reason: 'seat-not-group-family' }],
            vector_hash: ''
        });
    });
});

describe('the Author\'s choose installs the reviewed Overview (D-68)', () => {
    it('installs one new latest row per group holding the CHOSEN text, and never rewrites a revision', () => {
        const book = workedExample();
        const result = chooseReviewedSummary(book.store, book.story(), ATTR, { at: '2026-11-25T09:00:00.000Z' });

        // The five new rows: each group's NEXT number, `latest`, and the reviewed text — Ending's is r6
        // holding r4's prose, because the choice passed r5 over.
        expect(result.installed.map((row) => [row.group_key, row.number, row.state, row.content])).toEqual([
            ['premise', 4, 'latest', 'premise r3.'],
            ['promise', 4, 'latest', 'promise r3.'],
            ['theme', 2, 'latest', 'theme r1.'],
            ['tone', 2, 'latest', 'tone r1.'],
            ['ending', 6, 'latest', 'ending r4.']
        ]);
        // The install is an ordinary group install, so it carries the Author's verb and no run (P11), and
        // it resolves nothing on R3's evidence rule (no `finding_refs`, and no Clean stamp either — these
        // five rows never sat through a review pass of their own).
        expect(result.installed.map((row) => [row.run_ref, row.work_item_ref, row.finding_refs, row.clean])).toEqual([
            [null, 'phrase_reviewed_choose', undefined, undefined],
            [null, 'phrase_reviewed_choose', undefined, undefined],
            [null, 'phrase_reviewed_choose', undefined, undefined],
            [null, 'phrase_reviewed_choose', undefined, undefined],
            [null, 'phrase_reviewed_choose', undefined, undefined]
        ]);

        // The live book IS the reviewed Overview now: group rows, the composed Overview and the string the
        // choose reported are all the same bytes.
        expect(book.groups().map((group) => group.content)).toEqual([
            'premise r3.',
            'promise r3.',
            'theme r1.',
            'tone r1.',
            'ending r4.'
        ]);
        expect(result.phrase.content).toBe(result.chosen.overview);
        expect(result.chosen.overview).toContain('ending r4.');
        expect(result.chosen.overview).not.toContain('ending r5');
    });

    it('discards every revision the choice passed over, and keeps the rows (D-68)', () => {
        const book = workedExample();
        const result = chooseReviewedSummary(book.store, book.story(), ATTR, { at: '2026-11-25T09:00:00.000Z' });

        // Nothing is deleted (unlike the legacy selection's D-22 truncation): 13 old rows + 5 new ones, and
        // the only rows that are not `discarded` are the five the choose just installed.
        expect(rowsOf(book)).toEqual([
            'ending:1:discarded',
            'ending:2:discarded:clean',
            'ending:3:discarded',
            'ending:4:discarded:clean',
            'ending:5:discarded',
            'ending:6:latest',
            'premise:1:discarded:clean',
            'premise:2:discarded',
            'premise:3:discarded:clean',
            'premise:4:latest',
            'promise:1:discarded',
            'promise:2:discarded',
            'promise:3:discarded:clean',
            'promise:4:latest',
            'theme:1:discarded:clean',
            'theme:2:latest',
            'tone:1:discarded:clean',
            'tone:2:latest'
        ]);
        expect(result.discarded.map((row) => `${row.group_key}:${row.number}`).sort()).toEqual([
            'ending:1', 'ending:2', 'ending:3', 'ending:4', 'ending:5',
            'premise:1', 'premise:2', 'premise:3',
            'promise:1', 'promise:2', 'promise:3',
            'theme:1', 'tone:1'
        ]);
        // The selected rows keep their stamps — that is how a later read still knows which prose was reviewed.
        expect(result.discarded.filter((row) => row.clean === true).map((row) => `${row.group_key}:${row.number}`).sort()).toEqual([
            'ending:2', 'ending:4', 'premise:1', 'premise:3', 'promise:3', 'theme:1', 'tone:1'
        ]);
    });

    it('records the decision on the Phrase row and reads back the choice it names', () => {
        const book = workedExample();
        const selection = cleanSelectionOf(book.store, book.story());
        const result = chooseReviewedSummary(book.store, book.story(), ATTR, { at: '2026-11-25T09:00:00.000Z' });

        expect(book.store.phrases.require(result.phrase.id)).toMatchObject({
            reviewed_vector: selection.vector,
            reviewed_vector_hash: selection.vector_hash,
            reviewed_at: '2026-11-25T09:00:00.000Z'
        });
        expect(result.chosen).toMatchObject({
            vector: selection.vector,
            vector_hash: selection.vector_hash,
            at: '2026-11-25T09:00:00.000Z'
        });
        expect(result.chosen.sources).toEqual(
            selection.entries.map((entry) => ({
                group_id: entry.group.id,
                group_key: entry.group.key,
                source_revision: entry.revision.number,
                source_id: entry.revision.id,
                installed_revision: entry.group.revision + 1
            }))
        );

        // The persisted choice re-reads the SOURCE rows, not the new ones — that is the read the rail uses
        // to keep showing the chosen prose and its score after the live pipeline moves on.
        const chosen = chosenSelectionOf(book.store, book.story());

        expect(chosen?.entries.map((entry) => [entry.group.key, entry.revision.number])).toEqual([
            ['premise', 3],
            ['promise', 3],
            ['theme', 1],
            ['tone', 1],
            ['ending', 4]
        ]);
        expect(chosen?.complete).toBe(true);
        expect(chosen?.vector_hash).toBe(selection.vector_hash);
        // And the LIVE selection is empty of verdicts now: five unreviewed rows, so there is no new
        // reviewed Overview to choose until another deep pass earns one.
        expect(
            cleanSelectionOf(book.store, book.story()).gaps.map((gap) => [gap.group_key, gap.reason, gap.latest])
        ).toEqual([
            ['premise', 'no_clean_revision', 4],
            ['promise', 'no_clean_revision', 4],
            ['theme', 'no_clean_revision', 2],
            ['tone', 'no_clean_revision', 2],
            ['ending', 'no_clean_revision', 6]
        ]);
    });

    it('heals a persisted choice whose rows no longer carry the verdict it was made of', () => {
        const book = workedExample();

        chooseReviewedSummary(book.store, book.story(), ATTR, { at: '2026-11-25T09:00:00.000Z' });

        // A Seed reset re-grows the numbers from 1 and a scrap deletes rows; either way the persisted
        // `{groupId: number}` can now point at a text that never passed a review. The read requires the
        // named row to still exist AND still be Clean, so the choice simply stops being reported.
        const premiseR3 = book.store.groupRevisions
            .list()
            .find((row) => row.group_key === 'premise' && row.number === 3)!;

        book.store.groupRevisions.update(premiseR3.id, { clean: false }, ATTR, [{ id: premiseR3.id, rev: premiseR3.rev }]);

        expect(chosenSelectionOf(book.store, book.story())).toBeUndefined();
        // The live selection is unaffected by the choice itself — it answers "what could I review NOW".
        expect(cleanSelectionOf(book.store, book.story()).entries).toEqual([]);
    });

    it('keeps a finding a discarded revision fixed — the discard is a display decision, not an undo', () => {
        const book = workedExample();
        const findingId = openIssue(book, ['ending'], 'the ending never pays the promise');

        // R3's evidence: a revision that names the finding and lands resolves it, and the close walks the
        // whole history with no state filter.
        write(book, 'ending', 'ending r6 pays the promise off.', [findingId]);
        expect(closeFindingWhenGroupsResolved(book.store, book.store.findings.require(findingId), ATTR)).toEqual({
            closed: true,
            resolution: {
                finding_id: findingId,
                targeted: [book.group('ending').id],
                resolved: [book.group('ending').id],
                missing: [],
                resolved_all: true
            }
        });
        expect(book.store.findings.require(findingId).state).toBe('fixed');

        // The choose discards r6 along with every other row it passed over — and the finding stays `fixed`.
        chooseReviewedSummary(book.store, book.story(), ATTR, { at: '2026-11-25T09:00:00.000Z' });

        expect(book.store.findings.require(findingId).state).toBe('fixed');
        expect(findingResolution(book.store, book.story(), book.store.findings.require(findingId)).resolved_all).toBe(true);
    });

    it('refuses a book with no reviewed Overview, naming every group that still lacks one', () => {
        const book = seedBook();

        write(book, 'premise', 'premise r1.');
        stamp(book, 'premise', 'run_check_1');

        expect(() => chooseReviewedSummary(book.store, book.story(), ATTR)).toThrow(
            'chooseReviewedSummary: no reviewed Overview exists — promise (unwritten), theme (unwritten), tone (unwritten), ending (unwritten) still lacks a clean revision (D-68)'
        );
        // Refusal is all-or-nothing: the premise row nobody chose is untouched, and no choice is recorded.
        expect(book.groups()[0]).toMatchObject({ revision: 1, content: 'premise r1.' });
        expect(book.store.phrases.list()[0].reviewed_vector).toBeUndefined();
        expect(book.store.phrases.list()[0].reviewed_vector_hash).toBeUndefined();
        expect(book.store.phrases.list()[0].reviewed_at).toBeUndefined();
    });

    it('reports the legacy Summary mirror it wrote, exactly as the install reported it', () => {
        const book = workedExample();
        const result = chooseReviewedSummary(book.store, book.story(), ATTR, { at: '2026-11-25T09:00:00.000Z' });

        // R6: the choose rewrites the mirror in the same commit unless the Summary is locked — and it
        // REPORTS that rather than letting the Author discover a stale mirror in the projection. The five
        // field names are the mirror's own per-group columns, so the legacy rail moves with the choose.
        expect(result.mirror).toEqual({
            summary_id: 'summary_0',
            fields: ['premise', 'promise', 'theme', 'tone', 'ending'],
            written: true
        });
    });
});

// ---------------------------------------------------------------------------
// THE GROUP LOCK (the fixed point the other groups get revised against)
//
// `locks.ts` owns the write; what THIS file owns is the consequence for the reviewed Summary, and the
// consequence is a subtraction: a lock removes the one question a reviewed selection asks a group ("which
// of your texts should replace the current one?"), so every rule that asked it stops asking it —
// `openIssueGroupIds`, `cleanSelectionOf`, `chosenSelectionOf` and the choose's install. Nothing here
// invents a second selection: the locked group's entry IS its current row, the same row
// `groupRevisionVector` prints, which is what keeps the reviewed Overview and the live Overview agreeing.
// ---------------------------------------------------------------------------
describe('a locked group is chosen as it stands and is never rewritten by the choose', () => {
    /** The lock, applied through the op that owns it rather than by hand-editing the row. */
    const lock = (book: Book, key: string) =>
        lockPhraseGroup(
            book.store,
            book.story(),
            book.group(key).id,
            { ...ATTR, why: `lock: the Author froze ${key} as the text the rest of the book answers (the group lock)` },
            { actor: 'author', at: '2026-11-25T10:00:00.000Z' }
        );

    it('selects a locked group an open finding still names, while an open finding on a writable group blocks the book', () => {
        const book = workedExample();

        // Locked BEFORE either finding is raised, so neither lock voids anything (`locks.ts` voids a claim
        // only when every group it names is already fixed), and both rows below are live claims.
        lock(book, 'ending');

        // A deep pass over a vector that includes locked text can still file a defect about it. The lock
        // makes the claim unanswerable; it does not censor it, and it must not veto the Overview.
        openIssue(book, ['ending'], 'ending r5 walks back the promise the ending sold');
        openIssue(book, ['premise'], 'premise r3 contradicts the locked ending');

        // THE BLOCK SET IS THE WRITABLE HALF. `ending` still carries an open issue and is not in here;
        // `premise` carries the same kind of issue and is. This is the same read the crew's gates use, so
        // the Clean verdict and the work queue cannot disagree about a locked book either.
        expect(openIssueGroupIds(book.store, book.story())).toEqual(new Set([book.group('premise').id]));

        const selection = cleanSelectionOf(book.store, book.story());

        // Ending is selected with no verdict on it at all: r5 is the text the lock fixed, and asking
        // "which ending instead?" is the question the lock took away.
        expect(selection.entries.map((entry) => [entry.group.key, entry.revision.number])).toEqual([
            ['promise', 3],
            ['theme', 1],
            ['tone', 1],
            ['ending', 5]
        ]);
        expect(selection.gaps.map((gap) => [gap.group_key, gap.reason, gap.latest, gap.issues_open])).toEqual([
            ['premise', 'no_clean_revision', 3, true]
        ]);
        expect(selection.complete).toBe(false);
        // THE VECTOR IS THE BOOK, minus the group nobody has cleared yet: each entry is that group's
        // CURRENT number, including the locked one — the selection never reaches back for an older text of
        // a group the Author froze.
        expect(selection.vector).toEqual(
            Object.fromEntries(
                book.groups().filter((group) => group.key !== 'premise').map((group) => [group.id, group.revision])
            )
        );
        expect(composeReviewedOverview(selection)).toContain('ending r5, the newest text and a defect on it.');

        // And the lock refused nothing that was merely about locked text: the deep pass's own stamp lands
        // on the locked row like any other, because a verdict is not a write of text.
        const stamped = stampCleanRevisions(
            book.store,
            book.story(),
            { seatKey: seatKey(book), runRef: 'run_check_locked_vector' },
            { ...ATTR, why: 'settle: the deep pass read the vector that includes the locked ending (D-67)' }
        );

        expect(stamped.stamped.map((row) => `${row.group_key}:${row.number}`)).toEqual(['ending:5']);
        expect(stamped.skipped).toEqual([
            { group_id: book.group('premise').id, group_key: 'premise', reason: 'open-issue-scopes-to-group' },
            { group_id: book.group('promise').id, group_key: 'promise', reason: 'already-stamped' },
            { group_id: book.group('theme').id, group_key: 'theme', reason: 'already-stamped' },
            { group_id: book.group('tone').id, group_key: 'tone', reason: 'already-stamped' }
        ]);
    });

    it('installs only the writable groups, and keeps the locked one on the revision its lock fixed', () => {
        const book = workedExample();

        lock(book, 'ending');

        const selection = cleanSelectionOf(book.store, book.story());
        // THE CONSISTENCY CLAIM, in the case where every group is selected: a locked book's reviewed vector
        // IS the live one — same numbers, same hash — so the Overview the rail composes and the Overview
        // every Writer was answering are the same bytes, locked row included. Read BEFORE the choose, which
        // moves the four writable groups and therefore the live vector with them.
        const liveVector = Object.fromEntries(book.groups().map((group) => [group.id, group.revision]));
        const liveHash = groupVectorHash(groupRevisionVector(book.store, book.storyId));
        const result = chooseReviewedSummary(book.store, book.story(), ATTR, { at: '2026-11-25T09:00:00.000Z' });

        expect(selection.vector).toEqual(liveVector);
        expect(selection.vector_hash).toBe(liveHash);

        // Four rows, not five: Ending's prose was chosen, and it was chosen as the row it already had.
        expect(result.installed.map((row) => [row.group_key, row.number, row.state, row.content])).toEqual([
            ['premise', 4, 'latest', 'premise r3.'],
            ['promise', 4, 'latest', 'promise r3.'],
            ['theme', 2, 'latest', 'theme r1.'],
            ['tone', 2, 'latest', 'tone r1.']
        ]);
        // The locked group is untouched, down to the lock's own record of which revision it froze.
        expect(book.group('ending')).toMatchObject({
            revision: 5,
            content: 'ending r5, the newest text and a defect on it.',
            locked: true,
            locked_revision: 5,
            locked_by: 'author',
            locked_at: '2026-11-25T10:00:00.000Z'
        });

        // THE RETAINED ROW. Ending's r5 stays `latest` while its four older texts are discarded: the sweep
        // flips everything the choice did not name, and r5 WAS named. Were it flipped, `latestGroupRevision`
        // would find no current text, the group row and its history would disagree (R2), and the locked
        // sentence would vanish from every later Overview.
        expect(rowsOf(book)).toEqual([
            'ending:1:discarded',
            'ending:2:discarded:clean',
            'ending:3:discarded',
            'ending:4:discarded:clean',
            'ending:5:latest',
            'premise:1:discarded:clean',
            'premise:2:discarded',
            'premise:3:discarded:clean',
            'premise:4:latest',
            'promise:1:discarded',
            'promise:2:discarded',
            'promise:3:discarded:clean',
            'promise:4:latest',
            'theme:1:discarded:clean',
            'theme:2:latest',
            'tone:1:discarded:clean',
            'tone:2:latest'
        ]);
        expect(result.discarded.map((row) => `${row.group_key}:${row.number}`).sort()).toEqual([
            'ending:1', 'ending:2', 'ending:3', 'ending:4',
            'premise:1', 'premise:2', 'premise:3',
            'promise:1', 'promise:2', 'promise:3',
            'theme:1', 'tone:1'
        ]);

        // R6: the mirror moves for the fields the choose actually rewrote — the locked group wrote nothing.
        expect(result.mirror).toEqual({
            summary_id: 'summary_0',
            fields: ['premise', 'promise', 'theme', 'tone'],
            written: true
        });
        expect(result.groups.map((group) => group.key)).toEqual(['premise', 'promise', 'theme', 'tone']);
        // The live book is the chosen Overview, and the chosen Overview still carries the locked sentence:
        // that is the baseline the four new rows were revised to agree with.
        expect(result.phrase.content).toBe(result.chosen.overview);
        expect(result.chosen.overview).toContain('ending r5, the newest text and a defect on it.');
        expect(result.chosen.overview).not.toContain('ending r4.');

        // The sources join each group to its own row: the writable groups move to their NEXT number, the
        // locked one reports the revision it already had. A positional join would hand the rail Ending's
        // number for Tone's row and a sixth revision Ending never got.
        expect(result.chosen.sources).toEqual(
            selection.entries.map((entry) => ({
                group_id: entry.group.id,
                group_key: entry.group.key,
                source_revision: entry.revision.number,
                source_id: entry.revision.id,
                installed_revision: entry.group.key === 'ending' ? 5 : entry.group.revision + 1
            }))
        );

        // The persisted choice reads back complete even though Ending's row carries no Clean stamp — the
        // evidence for a locked entry is the lock's own record, and `locked_revision` names this row.
        const chosen = chosenSelectionOf(book.store, book.story());

        expect(chosen?.entries.map((entry) => [entry.group.key, entry.revision.number])).toEqual([
            ['premise', 3],
            ['promise', 3],
            ['theme', 1],
            ['tone', 1],
            ['ending', 5]
        ]);
        expect(chosen?.complete).toBe(true);
        expect(chosen?.vector_hash).toBe(selection.vector_hash);

        // The NEW selection: the four installed rows carry no verdict yet, and Ending is reviewable as it
        // stands — so a locked book is never stuck without an Overview because of the group it froze.
        const live = cleanSelectionOf(book.store, book.story());

        expect(live.entries.map((entry) => [entry.group.key, entry.revision.number])).toEqual([['ending', 5]]);
        expect(live.gaps.map((gap) => [gap.group_key, gap.reason, gap.latest, gap.issues_open])).toEqual([
            ['premise', 'no_clean_revision', 4, false],
            ['promise', 'no_clean_revision', 4, false],
            ['theme', 'no_clean_revision', 2, false],
            ['tone', 'no_clean_revision', 2, false]
        ]);
        expect(live.complete).toBe(false);
    });

    it('records a choice that rewrote nothing when every group is locked, and discards the prose it passed over', () => {
        const book = workedExample();

        for (const key of ['premise', 'promise', 'theme', 'tone', 'ending']) lock(book, key);

        const selection = cleanSelectionOf(book.store, book.story());

        expect(selection.complete).toBe(true);

        const result = chooseReviewedSummary(book.store, book.story(), ATTR, { at: '2026-11-25T09:00:00.000Z' });

        // Nothing to install: every group's selected text IS its current text.
        expect(result.installed).toEqual([]);
        expect(result.groups.map((group) => group.key)).toEqual(['premise', 'promise', 'theme', 'tone', 'ending']);
        expect(result.mirror).toEqual({ summary_id: 'summary_0', fields: [], written: false });
        expect(book.groups().map((group) => [group.key, group.revision])).toEqual([
            ['premise', 3],
            ['promise', 3],
            ['theme', 1],
            ['tone', 1],
            ['ending', 5]
        ]);

        // The choose is still a DECISION, so the sweep still runs: the prose it passed over is discarded
        // and kept, and the five rows behind the current texts are the only ones left standing.
        expect(rowsOf(book)).toEqual([
            'ending:1:discarded',
            'ending:2:discarded:clean',
            'ending:3:discarded',
            'ending:4:discarded:clean',
            'ending:5:latest',
            'premise:1:discarded:clean',
            'premise:2:discarded',
            'premise:3:latest:clean',
            'promise:1:discarded',
            'promise:2:discarded',
            'promise:3:latest:clean',
            'theme:1:latest:clean',
            'tone:1:latest:clean'
        ]);
        // The decision record is written the same way an install-only choose writes it, and it names the
        // live vector — for an all-locked book the reviewed Overview IS the live one, byte for byte.
        expect(book.store.phrases.require(result.phrase.id)).toMatchObject({
            reviewed_vector: selection.vector,
            reviewed_vector_hash: selection.vector_hash,
            reviewed_at: '2026-11-25T09:00:00.000Z'
        });
        expect(result.chosen.overview).toBe(composeGroupContentFrom(book.groups()));
        expect(result.chosen.sources.map((source) => [source.group_key, source.source_revision, source.installed_revision])).toEqual([
            ['premise', 3, 3],
            ['promise', 3, 3],
            ['theme', 1, 1],
            ['tone', 1, 1],
            ['ending', 5, 5]
        ]);
        expect(chosenSelectionOf(book.store, book.story())?.complete).toBe(true);
    });

    it('refuses to install over locked text when a Writer hands the install a locked group mid-sweep', () => {
        const book = workedExample();

        // The choose selects the five clean rows, and the Author locks Ending between the read and the
        // write — the same mid-commit race `revisions.test.ts` pins for the Writer's own install.
        const selection = cleanSelectionOf(book.store, book.story());

        lock(book, 'ending');

        expect(selection.entries.map((entry) => [entry.group.key, entry.revision.number])).toEqual([
            ['premise', 3],
            ['promise', 3],
            ['theme', 1],
            ['tone', 1],
            ['ending', 4]
        ]);
        // The lock re-reads the book, so the selection the rail was about to offer is now Ending r5 — the
        // r4 the previous selection named is no longer what a locked book presents.
        expect(
            cleanSelectionOf(book.store, book.story()).entries.map((entry) => [entry.group.key, entry.revision.number])
        ).toEqual([['premise', 3], ['promise', 3], ['theme', 1], ['tone', 1], ['ending', 5]]);
        // And the install guard underneath the choose is unambiguous: prose the Author froze cannot be
        // installed over, whatever read produced it.
        expect(() =>
            installGroupRevisions(
                book.store,
                book.story(),
                [{ group: book.group('ending'), content: 'ending r4.' }],
                ATTR,
                { runRef: null, workItemRef: 'phrase_reviewed_choose' }
            )
        ).toThrow(
            "installGroupRevisions: ending is locked at revision 5 by author — a locked group's text is the fixed point the other groups are revised against, so nothing installs over it until the Author unlocks it"
        );
    });
});
