/**
 * READER SCORING (D-65) — the projection half of the pinned wire contract.
 *
 * `GET /stories/:id/phrases` is the rail's only read of the group model, and the score rail is the one
 * place it draws a number the loop never acts on. The dashboard worker codes against EXACTLY this shape
 * (`api/projections.ts:PhraseGroupScoreRow`), so the field names, the order, and the absence of anything
 * else are the contract — a rename or an extra field here is a broken panel there:
 *
 *     scores: { value, vector_hash, at, run_ref, rationale? }[]   // newest first, no `evidence`
 *
 * WHAT EACH PIN IS FOR:
 *   1. `scores: []` for a section nobody has scored — absence has to be readable as "no judgement yet",
 *      not as a zero the rail would draw (the same reason `isScorableSummary` refuses to score a
 *      half-written Overview);
 *   2. NEWEST FIRST, so `scores[0]` IS the current number. Order is `created_at` descending with the row
 *      id as the tie-break, because a scoring run commits all five rows with ONE timestamp — a sort on
 *      time alone would leave the rail's "current score" up to the store's iteration order after a
 *      restart (L-3: the rows are the state, and so is the order they read back in);
 *   3. `rationale` is OMITTED, never empty — a display line the Reader did not give is absence, and the
 *      panel must not draw a blank reason;
 *   4. `evidence` stays server-side: the quote is in the run's thread (`run_ref` reaches it), and a rail
 *      that renders a percentage has nowhere to put a paragraph;
 *   5. one Story's scores never appear on another Story's rail.
 *
 * The rows are seeded through the store rather than through the loop, so this file pins the READ; the
 * write side and the five-row commit are `loop/section-scores.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { phraseView } from './projections';
import { Store } from '../store/store';
import { AUTHOR_ATTR, seedStory } from '../run/mock';
import { recordUidAt } from '../store/persist';
import { ensurePhraseCatalog, phraseGroupsOf } from '../phrase/catalog';
import type { PhraseGroup, RecordInit, SummaryScore } from '../../shared/types';

/** The stored payload minus the four bookkeeping fields, so a test can say "one row, exactly this". */
type ScoreInit = RecordInit<SummaryScore>;

/**
 * A Story with its five catalog groups and pinned ids (the counter-minted `recordUidAt` keeps the
 * group addresses literal, which is what lets the expectations name them), and every group holding text.
 */
function seedBook(store: Store, title: string, seed = 0) {
    const story = seedStory(store, { title, phase: 'summary' });
    let next = seed;
    const ensured = ensurePhraseCatalog(store, story, AUTHOR_ATTR, { newId: () => recordUidAt(next++) })!;

    for (const group of ensured.groups) {
        store.phraseGroups.update(
            group.id,
            { content: `${group.key}: the line the Author committed to.`, revision: 1 },
            { run_ref: null, author: true, why: 'seed: the group has text, so the Overview is scorable' }
        );
    }

    return { story, groups: phraseGroupsOf(store, story.id) };
}

/** One scoring run's rows — the same payload the engine's settle writes, minus the loop's clock. */
const scoreRow = (
    story: { id: string },
    group: PhraseGroup,
    phraseId: string,
    vectorHash: string,
    score: number,
    runRef: string,
    workItemRef: string,
    rationale = `${group.key} holds together as written`
): ScoreInit => ({
    story_id: story.id,
    phrase_id: phraseId,
    vector_hash: vectorHash,
    group_id: group.id,
    group_key: group.key,
    score,
    rationale,
    evidence: `${group.key}: the line the Author committed to.`,
    run_ref: runRef,
    work_item_ref: workItemRef
});

/** Every group's `scores` rail, keyed by catalog order, as the projection hands it to the client. */
const railsOf = (store: Store, story: { id: string }) => {
    const view = phraseView(store, store.stories.require(story.id));

    return view.groups.map((group) => ({ key: group.key, scores: group.scores }));
};

describe('the score rail on a group row (D-65)', () => {
    it('is an empty list for a section nobody has scored, with no zero to misread', async () => {
        const store = Store.empty();
        const { story, groups } = seedBook(store, 'Unscored');

        expect(railsOf(store, story)).toEqual(
            groups.map((group) => ({ key: group.key, scores: [] }))
        );
    });

    it('lists one run newest-first, pins the exact wire shape, and keeps `evidence` off the read', async () => {
        const store = Store.empty();
        const { story, groups } = seedBook(store, 'One run');
        const phraseId = phraseView(store, story).phrase_id!;
        const hash = 'cb34f094051bb701';

        // ONE COMMIT: the five rows share a `created_at`, exactly as `loop/engine.ts` writes them.
        let written: SummaryScore[] = [];

        await store.commit('test: one scoring run', () => {
            written = groups.map((group, index) =>
                store.summaryScores.create(
                    scoreRow(story, group, phraseId, hash, 60 + index * 8, 'run_7', `wi_summary_score_${hash}`),
                    { run_ref: 'run_7', author: true, why: 'seed: the Reader scored the installed Overview' }
                )
            );
        });

        const rails = railsOf(store, story);

        expect(rails).toEqual(
            groups.map((group, index) => ({
                key: group.key,
                // The rail's entry, field for field: `value` (not `score`), `at` (not `created_at`), and
                // NO `group_id`/`group_key` — the row is already inside its group.
                scores: [
                    {
                        value: 60 + index * 8,
                        vector_hash: hash,
                        at: written[index].created_at,
                        run_ref: 'run_7',
                        rationale: `${group.key} holds together as written`
                    }
                ]
            }))
        );
        // The names, pinned as names: the dashboard worker imports this shape, and an added field is a
        // panel that stops compiling. `evidence` is deliberately absent.
        expect(Object.keys(rails[0]!.scores[0]!).sort()).toEqual(['at', 'rationale', 'run_ref', 'value', 'vector_hash']);
        expect(phraseId).toBe(groups[0]!.phrase_id);
    });

    it('keeps two runs of the same section newest-first, and breaks a tie on the row id', async () => {
        const store = Store.empty();
        const { story, groups } = seedBook(store, 'Two runs');
        const phraseId = phraseView(store, story).phrase_id!;
        const premise = groups[0];
        const older = '1111111111111111';
        const newer = '2222222222222222';

        // Run 1 — the vector as it stood.
        await store.commit('test: the first scoring run', () => {
            store.summaryScores.create(
                scoreRow(story, premise, phraseId, older, 41, 'run_1', `wi_summary_score_${older}`),
                { run_ref: 'run_1', author: true, why: 'seed: the first score' }
            );
        });

        // Run 2 — after an install, so the rail holds two judgements of two different texts.
        await store.commit('test: the second scoring run', () => {
            store.summaryScores.create(
                scoreRow(story, premise, phraseId, newer, 88, 'run_2', `wi_summary_score_${newer}`),
                { run_ref: 'run_2', author: true, why: 'seed: the score after the rewrite' }
            );
        });

        const rail = phraseView(store, story).groups[0]!;

        expect(rail.scores).toEqual([
            { value: 88, vector_hash: newer, at: expect.any(String), run_ref: 'run_2', rationale: 'premise holds together as written' },
            { value: 41, vector_hash: older, at: expect.any(String), run_ref: 'run_1', rationale: 'premise holds together as written' }
        ]);
        // The history is what the rail draws: `scores[0]` is the CURRENT number and the older judgement is
        // still there, stamped with the vector it described. Two commits CAN land inside one millisecond —
        // the clock is the store's, not the test's — and then the row id is what orders them, which is the
        // case the next block pins outright. What may never happen is the newer write reading second.
        expect(rail.scores[0]!.at >= rail.scores[1]!.at).toBe(true);
        expect(rail.scores.map((entry) => entry.run_ref)).toEqual(['run_2', 'run_1']);
        // The other four sections were never judged, and say so.
        expect(phraseView(store, story).groups.slice(1).map((group) => group.scores)).toEqual([[], [], [], []]);

        // THE TIE-BREAK: two rows for ONE section that carry the SAME `created_at` cannot be ordered by
        // time, so the id is the tie-break, and the higher id (the later write) is first. That is what
        // makes `scores[0]` the same row after a restart, not merely the same value.
        //
        // THE CLOCK IS PINNED, and it has to be. `store.ts:397` stamps `created_at` from `new Date()` on
        // EVERY create, so two writes in one commit are only equal while the wall clock does not tick
        // between them — the assertion below is a 1-in-many-thousands flake under load (and was one in the
        // baseline run) until the test owns the clock. A pinned `Date` makes the tie a FACT of the row
        // pair rather than a coin flip, which is the only way this row can pin the tie-break at all: the
        // projection's `created_at` DESC + id tie-break (specifications.md §17.15 "The read",
        // knowledge.md:430) is otherwise never exercised, because unequal stamps order themselves.
        const tied = { value: 63, run: 'run_3' };
        const second = { value: 79, run: 'run_4' };

        let tiedRows: SummaryScore[] = [];

        // One hour ahead of the two commits above, so the tied pair stays the NEWEST pair (`after` below
        // still reads them first) while both writes read the identical instant.
        vi.useFakeTimers({ now: Date.now() + 60 * 60 * 1000, toFake: ['Date'] });

        try {
            await store.commit('test: two judgements of one section in one commit', () => {
                tiedRows = [tied, second].map((entry, index) =>
                    store.summaryScores.create(
                        scoreRow(story, premise, phraseId, '3333333333333333', entry.value, entry.run, `wi_summary_score_3333333333333333-${index}`),
                        { run_ref: entry.run, author: true, why: `seed: the ${entry.value} judgement` }
                    )
                );
            });
        } finally {
            vi.useRealTimers();
        }

        expect(tiedRows[0].created_at).toBe(tiedRows[1].created_at);
        expect(tiedRows[0].id < tiedRows[1].id).toBe(true);

        const after = phraseView(store, story).groups[0]!.scores;

        expect(after.map((entry) => entry.value)).toEqual([79, 63, 88, 41]);
        expect(after.map((entry) => entry.run_ref)).toEqual(['run_4', 'run_3', 'run_2', 'run_1']);
    });

    it('omits `rationale` rather than shipping an empty line, and keeps each Story on its own rail', async () => {
        const store = Store.empty();
        const { story, groups } = seedBook(store, 'No rationale');
        const phraseId = phraseView(store, story).phrase_id!;

        // A score the Reader gave without a reason line: the row stores `''` (a required column with
        // nothing in it), and the read must not hand the panel a blank to render.
        await store.summaryScores.create(
            scoreRow(story, groups[0], phraseId, '4444444444444444', 55, 'run_5', 'wi_summary_score_4444444444444444', ''),
            { run_ref: 'run_5', author: true, why: 'seed: a score with no rationale' }
        );

        expect(phraseView(store, story).groups[0]!.scores).toEqual([
            { value: 55, vector_hash: '4444444444444444', at: expect.any(String), run_ref: 'run_5' }
        ]);

        // A second book with its own rows: the rail filters by Story, so the panels cannot trade scores.
        const other = seedBook(store, 'The other book', 40);
        const otherPhraseId = phraseView(store, other.story).phrase_id!;

        await store.summaryScores.create(
            scoreRow(other.story, other.groups[2], otherPhraseId, '5555555555555555', 71, 'run_6', 'wi_summary_score_5555555555555555'),
            { run_ref: 'run_6', author: true, why: 'seed: the other Story holds its own score' }
        );

        expect(phraseView(store, story).groups.map((group) => group.scores.length)).toEqual([1, 0, 0, 0, 0]);
        expect(railsOf(store, other.story)).toEqual([
            { key: 'premise', scores: [] },
            { key: 'promise', scores: [] },
            {
                key: 'theme',
                scores: [
                    {
                        value: 71,
                        vector_hash: '5555555555555555',
                        at: expect.any(String),
                        run_ref: 'run_6',
                        rationale: 'theme holds together as written'
                    }
                ]
            },
            { key: 'tone', scores: [] },
            { key: 'ending', scores: [] }
        ]);
    });
});
