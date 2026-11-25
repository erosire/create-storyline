/**
 * PHRASE ② — the BYTES of the four compiled chapter-lane turns (wave T-W2).
 *
 * Why this file exists beside `run/phase1-prompt.test.ts` rather than inside it: the four group
 * compilers (`compileGroupDraftPrompt`, `compileGroupReviewPrompt`, `compileSectionScorePrompt`,
 * `compileGroupLockPrompt`) are phase-① code, and that file's pins ARE the phase-① contract — every
 * R-lock and R5 pin quotes a literal sentence out of it. Phrase ② runs through the SAME four
 * functions (`run/phase1-prompt.ts:promptLaneOf` picks a lane from the job's group rows), so the wave
 * has two obligations at once, and only literal-string assertions can show both:
 *
 *   1. the chapter crew is briefed about a CHAPTER — its law text is the Phrase ② seed plus the
 *      accepted Plotline Brief, its answer is `ChapterDraft` plotpoints, and it is never told it is
 *      writing a Summary section; and
 *   2. the Summary lane's bytes are UNCHANGED, including the two places where a lane refactor would
 *      most quietly rewrite them: the `## CANDIDATE SECTION` / `## LOCKED PEERS` wording of the lock
 *      seat, where the crew-facing word is 'Overview' (the phase-① book's own name, `artifact`) while
 *      the refusal messages say 'Summary' (the engine's name for the artifact, `subject`).
 *
 * WHAT IS NOT TESTED HERE: which job exists in which state, under which claim key, with which crew
 * (`loop/phase2-groups.test.ts`), and what the whole pipeline does end to end on a real server
 * (`integration/plotlines-groups.test.ts`). This file only ever asks: given this book, what exactly
 * does the model read?
 *
 * EXACT VALUES: the pinned strings are read off compiled prompts (probes under repo-root `Temp/w2/`),
 * not written from memory, and every id/vector comes out of the store the rig built — a hash is never
 * copied off a transcript.
 */
import { describe, expect, it } from 'vitest';

import { createRig, walkTo } from '../loop/mock';
import {
    compileGroupDraftPrompt,
    compileGroupLockPrompt,
    compileGroupReviewPrompt,
    compileSectionScorePrompt
} from './phase1-prompt';
import { AUTHOR_ATTR } from '../run/mock';
import { storyPhraseByKey } from '../phrase/catalog';
import { lockPhraseGroup } from '../phrase/locks';
import { cleanSelectionOf } from '../phrase/reviewed';
import {
    acceptPlotlineBrief,
    createPlotlineBrief,
    startPlotlinesPhrase
} from '../phrase/controllers/plotlines';
import { PHRASE_PLOTLINES_KEY, PHRASE_SUMMARY_KEY, phraseGroupDefinition } from '../../shared/phrase';
import type { Rig } from '../loop/mock';
import type { Phrase, PhraseGroup } from '../../shared/types';

// ---------------------------------------------------------------------------
// The lane, in the state each compiler is called with
// ---------------------------------------------------------------------------

/** The three chapter seeds the brief declares — the text the LAW block has to print verbatim. */
const CHAPTER_SEEDS = [
    'The keeper reads the ledger and finds his own name.',
    'The bird agrees to speak, for a price.',
    'The lamp burns on the keeper, and the last ship is warned.'
];

/** The lane's answer contract line, as `outputContract` ends every no-tool system turn with. */
const CHAPTER_DRAFT_CONTRACT =
    'Answer with ONE JSON object matching the `ChapterDraft` schema. You have no tools and exactly one turn. No prose outside the JSON.';

/** The phase-① contract line, pinned here so the two cannot be swapped without a failure. */
const GROUP_DRAFT_CONTRACT =
    'Answer with ONE JSON object matching the `GroupDraft` schema. You have no tools and exactly one turn. No prose outside the JSON.';

/** The law heading every chapter-lane turn opens with (`phase1-prompt.ts:phraseSeedSection`). */
const PHRASE_SEED_HEADING =
    '## PHRASE SEED — the text Phrase ② resolves into chapters (it is LAW, and it is general: P5 one phrase down)';

/**
 * Phase ① on the GROUP model, locked, with Phrase ② started and its chapter set ACCEPTED and WRITTEN:
 * the one book on which all four lane turns compile (the review, score and lock seats all need the
 * installed contracts, and the last two need the phrase's CLEAN selection).
 */
interface LaneBook {
    rig: Rig;
    phrase: Phrase;
    summaryPhraseId: string;
    /** The chapter entries in `order`, as the accept step materialized them. */
    chapters: PhraseGroup[];
    summaryGroups: PhraseGroup[];
    /** The lane's CLEAN selection vector — the hash the score and lock seats claim under. */
    chapterVector: string;
    summaryVector: string;
    /** The compiled Summary Phrase ② was seeded from: the lane's law text. */
    phraseSeed: string;
}

const laneBook = async (): Promise<LaneBook> => {
    const rig = await createRig({ summaryMode: 'groups', summarySampling: 5, summaryCritics: 1 });

    await walkTo(rig, 'plotlines');
    await rig.engine.lockPhase(rig.storyId, 'summary');

    const summaryPhrase = storyPhraseByKey(rig.store, rig.storyId, PHRASE_SUMMARY_KEY)!;
    const started = startPlotlinesPhrase(rig.store, rig.story(), summaryPhrase.content, AUTHOR_ATTR);
    const brief = createPlotlineBrief(
        rig.store,
        rig.story(),
        started.phrase,
        {
            chapter_count: CHAPTER_SEEDS.length,
            chapters: CHAPTER_SEEDS.map((seed, index) => ({ order: index + 1, seed }))
        },
        AUTHOR_ATTR
    );

    acceptPlotlineBrief(rig.store, rig.story(), brief, AUTHOR_ATTR);

    // R-lock's dial, on before the walk: the lock seat (both lanes) reads it as its first gate. It stays
    // ON without any lock happening — the mock crew never answers the Reader's `SectionScores` shape, so no
    // score row exists and the lock seat never dispatches during `run()` (the rows below are seeded by hand).
    rig.store.stories.update(rig.storyId, { editor_group_locking: true }, AUTHOR_ATTR, [
        { id: rig.storyId, rev: rig.story().rev }
    ]);

    await rig.run();

    const groupsOf = (phraseId: string): PhraseGroup[] =>
        rig.store.phraseGroups
            .list()
            .filter((group) => group.phrase_id === phraseId)
            .sort((left, right) => left.order - right.order);

    return {
        rig,
        phrase: started.phrase,
        summaryPhraseId: summaryPhrase.id,
        chapters: groupsOf(started.phrase.id),
        summaryGroups: groupsOf(summaryPhrase.id),
        chapterVector: cleanSelectionOf(rig.store, rig.story(), started.phrase.id).vector_hash,
        summaryVector: cleanSelectionOf(rig.store, rig.story(), summaryPhrase.id).vector_hash,
        phraseSeed: summaryPhrase.content
    };
};

/**
 * One entry heading, built the way `renderGroupEntry` builds it (the catalog title when the key has one,
 * the row's own title — 'Chapter 1' — when it does not), so the pin is exact per id.
 */
const headingFor = (group: PhraseGroup): string =>
    `### ${
        phraseGroupDefinition(group.key)?.title ?? group.title
    } (group_ref=${group.id}, key=${group.key}, revision=${group.revision})`;

/**
 * The Reader rows the LOCK seat's evidence gate reads (`loop/editor-lock.ts:editorLockEvidenceOf`): one
 * per group, at the vector the phrase's clean selection is stamped with, each with a non-blank rationale.
 * Seeded by hand because the rig's crew has no `SectionScores` answer, and the seat's dispatch is not what
 * this file is about — the prompt the seat would be given is.
 */
const seedReaderScores = (book: LaneBook): void => {
    for (const [groups, phraseId, vector] of [
        [book.chapters, book.phrase.id, book.chapterVector],
        [book.summaryGroups, book.summaryPhraseId, book.summaryVector]
    ] as const) {
        for (const [index, group] of groups.entries()) {
            book.rig.store.summaryScores.create(
                {
                    story_id: book.rig.storyId,
                    phrase_id: phraseId,
                    vector_hash: vector,
                    group_id: group.id,
                    group_key: group.key,
                    score: 70 + index,
                    rationale: `${group.key} holds together as written`,
                    evidence: `${group.key}: the line the Author committed to.`,
                    run_ref: 'run_probe',
                    work_item_ref: `wi_probe_${group.id}`
                },
                { run_ref: 'run_probe', author: false, why: 'seed: the Reader scored this phrase\'s clean selection' }
            );
        }
    }
};

// ---------------------------------------------------------------------------
// 1 — The Writer's batch: the phrase's law text, and an answer in plotpoints
// ---------------------------------------------------------------------------

describe('the chapter draft batch', () => {
    it('is briefed on the Phrase ② seed and the accepted brief, and answers in ChapterDraft plotpoints', async () => {
        const book = await laneBook();
        const prompt = compileGroupDraftPrompt(book.rig.store, book.rig.storyId, {
            groupRefs: book.chapters.map((group) => group.id)
        });

        // The LAW block is the PHRASE SEED, not the phase-① Seed Brief: Phrase ② reads its own copied seed
        // (seam S2), so the text the crew is told is law is the text every Phrase ② gate hashes.
        expect(prompt.user.startsWith(`${PHRASE_SEED_HEADING}\n`)).toBe(true);
        expect(prompt.user).toContain(book.phraseSeed);
        expect(prompt.user).not.toContain('## SEED BRIEF');

        // The accepted brief rides with it, with the count and the per-chapter seeds the Editor declared —
        // the chapter count is the one number a chapter Writer must never invent (D-3b).
        expect(prompt.user).toContain(
            [
                `ACCEPTED PLOTLINE BRIEF (chapter_count ${CHAPTER_SEEDS.length}):`,
                ...CHAPTER_SEEDS.map((seed, index) => `- chapter ${index + 1}: ${seed}`)
            ].join('\n')
        );

        // The answer contract comes from the CONTROLLER (seam S12), not from this file's Summary constant.
        expect(prompt.system.endsWith(`\n\n${CHAPTER_DRAFT_CONTRACT}`)).toBe(true);

        // And the entry block is the chapter set the batch may write — one heading per entry, IN `order`,
        // because the chapter number is the contract phase ③ reads and a batch rendered out of order tells
        // the crew a story about the sequence that the brief did not declare.
        expect(prompt.user).toContain('## GROUPS (the only groups this job may write — answer for every one of them)');
        expect(prompt.user.split('\n').filter((line) => line.startsWith('### '))).toEqual(
            book.chapters.map((group) => headingFor(group))
        );

        // The contract fields are plotpoints, and the batch is atomic over the named set.
        expect(prompt.user).toContain(
            'Answer with one `groups` entry for EVERY chapter named above and for NO other entry'
        );
        expect(prompt.user).toContain('- These are CONTRACT FIELDS, not prose.');
        // A chapter Writer is never told the Summary's answer shape: the word belongs to the other phrase.
        expect(prompt.user).not.toContain('GroupDraft');
    });

    it('follows the crew the job was dispatched under, and only that crew', async () => {
        const book = await laneBook();
        const refs = book.chapters.map((group) => group.id);

        // The lane's system turn is the EXECUTOR's pass-through (`item.templateRef` → `opts.templateSlug`),
        // because the built-in pool's rows are the Summary's voices and the chapter lane has no copy to
        // borrow (`phase1-prompt.ts:slugFor`). So naming the chapter crew has to change the lane's bytes…
        const crewed = compileGroupDraftPrompt(book.rig.store, book.rig.storyId, {
            groupRefs: refs,
            templateSlug: 'writer-plotlines-sampler',
            roleName: 'writer'
        });
        const plain = compileGroupDraftPrompt(book.rig.store, book.rig.storyId, { groupRefs: refs });

        expect(crewed.system).not.toBe(plain.system);
        expect(crewed.system.startsWith(
            book.rig.store.templates
                .list()
                .find((template) => template.name === 'writer-plotlines-sampler')!
                .roles!.find((role) => role.name === 'writer')!.prompt!.trim()
        )).toBe(true);

        // …while the Summary lane IGNORES the pool pick entirely: which Writer ran a phase-① batch is a
        // scheduling fact, and letting it drive the role copy would rewrite every phase-① prompt hash.
        const summaryRefs = book.summaryGroups.map((group) => group.id);
        const summaryPicked = compileGroupDraftPrompt(book.rig.store, book.rig.storyId, {
            groupRefs: summaryRefs,
            templateSlug: 'writer-plotlines-sampler',
            roleName: 'writer'
        });
        const summaryPlain = compileGroupDraftPrompt(book.rig.store, book.rig.storyId, { groupRefs: summaryRefs });

        expect(summaryPicked.system).toBe(summaryPlain.system);
        expect(summaryPicked.user).toBe(summaryPlain.user);
        expect(summaryPicked.hash).toBe(summaryPlain.hash);
    });
});

// ---------------------------------------------------------------------------
// 2 — The phase-① turns beside them, byte for byte
// ---------------------------------------------------------------------------

describe('the Summary lane running beside the chapter lane on the same book', () => {
    it('keeps the Seed Brief, the five catalog groups, and the GroupDraft contract', async () => {
        const book = await laneBook();
        const prompt = compileGroupDraftPrompt(book.rig.store, book.rig.storyId, {
            groupRefs: book.summaryGroups.map((group) => group.id)
        });

        expect(prompt.user.startsWith('## SEED BRIEF\n')).toBe(true);
        expect(prompt.user).not.toContain(PHRASE_SEED_HEADING);
        expect(prompt.user).not.toContain('ACCEPTED PLOTLINE BRIEF');
        expect(prompt.system.endsWith(`\n\n${GROUP_DRAFT_CONTRACT}`)).toBe(true);

        for (const group of book.summaryGroups) expect(prompt.user).toContain(headingFor(group));
    });

    it('names the OVERVIEW to its Critic where the chapter lane names the CHAPTER CONTRACTS', async () => {
        const book = await laneBook();
        const summary = compileGroupReviewPrompt(book.rig.store, book.rig.storyId, {
            groupRefs: book.summaryGroups.map((group) => group.id)
        });
        const chapter = compileGroupReviewPrompt(book.rig.store, book.rig.storyId, {
            groupRefs: book.chapters.map((group) => group.id)
        });

        expect(summary.user).toContain('## OVERVIEW — the five groups as they stand (every issue names the groups it is about)');
        expect(summary.user).not.toContain('## CHAPTER CONTRACTS');

        expect(chapter.user.startsWith(`${PHRASE_SEED_HEADING}\n`)).toBe(true);
        expect(chapter.user).toContain('## CHAPTER CONTRACTS — every entry as it stands (every issue names the groups it is about)');
        expect(chapter.user).not.toContain('## OVERVIEW — the five groups');
        // The chapter Critic's own grading rule: the defect this pass exists for crosses chapter bounds.
        expect(chapter.user).toContain('JUDGE THE CHAPTERS TOGETHER.');

        // The ANSWER CONTRACT stays `GroupReview` for both phrases — a chapter Critic attributes issues to
        // group ids exactly as a Summary Critic does — so the two system turns differ only in role copy.
        expect(chapter.system.endsWith('\n\nAnswer with ONE JSON object matching the `GroupReview` schema. You have no tools and exactly one turn. No prose outside the JSON.')).toBe(true);
        expect(summary.system.endsWith('\n\nAnswer with ONE JSON object matching the `GroupReview` schema. You have no tools and exactly one turn. No prose outside the JSON.')).toBe(true);
    });

    it('scores the reviewed OVERVIEW while the chapter seat scores the reviewed CHAPTER CONTRACTS', async () => {
        const book = await laneBook();
        const summary = compileSectionScorePrompt(book.rig.store, book.rig.storyId, {
            groupRefs: book.summaryGroups.map((group) => group.id),
            vectorHash: book.summaryVector
        });
        const chapter = compileSectionScorePrompt(book.rig.store, book.rig.storyId, {
            groupRefs: book.chapters.map((group) => group.id),
            vectorHash: book.chapterVector
        });

        expect(summary.user).toContain('## REVIEWED OVERVIEW — every section, scored (name each group_ref exactly once)');
        expect(summary.user).toContain('SCORE EVERY SECTION ONCE.');

        expect(chapter.user).toContain('## REVIEWED CHAPTER CONTRACTS — every entry, scored (name each group_ref exactly once)');
        expect(chapter.user).toContain('SCORE EVERY CHAPTER ONCE');
        // A chapter Reader grades CONTRACTS, not prose — the wording that keeps it from docking a chapter
        // for sentences nobody has written yet.
        expect(chapter.user).toContain('Do NOT deduct for prose nobody has written yet');

        // Each seat shows ONLY its own phrase's clean text: the score rows are keyed by the vector of the
        // selection the seat was armed under, so a cross-phrase render would mislabel the bytes.
        for (const group of book.chapters) expect(chapter.user).toContain(headingFor(group));
        for (const group of book.summaryGroups) {
            expect(chapter.user).not.toContain(headingFor(group));
            expect(summary.user).toContain(headingFor(group));
        }
    });
});

// ---------------------------------------------------------------------------
// 3 — The lock seat: the word the CREW reads, and the word the ENGINE reads
// ---------------------------------------------------------------------------

describe('the Editor\'s lock seat on both lanes', () => {
    it('calls the chapter lane\'s candidate a chapter set, and the Summary lane\'s an Overview', async () => {
        const book = await laneBook();

        seedReaderScores(book);

        const chapter = compileGroupLockPrompt(book.rig.store, book.rig.storyId, {
            groupRef: book.chapters[0]!.id,
            vectorHash: book.chapterVector
        });
        const summary = compileGroupLockPrompt(book.rig.store, book.rig.storyId, {
            groupRef: book.summaryGroups[0]!.id,
            vectorHash: book.summaryVector
        });

        // `artifact` — the crew-facing word. 'Overview' is phase ①'s own name for its artifact and the byte
        // every R-lock pin quotes; 'chapter set' is what the lane is actually freezing.
        expect(chapter.user).toContain(
            `## CANDIDATE SECTION — the one section this pass may lock (clean revision ${book.chapters[0]!.revision} of the reviewed chapter set, vector ${book.chapterVector})`
        );
        expect(summary.user).toContain(
            `## CANDIDATE SECTION — the one section this pass may lock (clean revision ${book.summaryGroups[0]!.revision} of the reviewed Overview, vector ${book.summaryVector})`
        );
        expect(chapter.user).toContain(
            '(no other section is locked yet — locking this one would make it the first fixed point the rest of the chapter set is revised against)'
        );
        expect(summary.user).toContain(
            '(no other section is locked yet — locking this one would make it the first fixed point the rest of the Overview is revised against)'
        );

        // The LOCK DECISION is phrase-owned: freezing a CONTRACT is not freezing a passage of prose.
        expect(chapter.user).toContain('A CHAPTER CONTRACT is lockable when the judgement on it is exhausted');
        expect(summary.user).toContain('ANSWER FOR THE CANDIDATE SECTION ONLY, and decide one thing: is that section FINISHED?');

        // The candidate block is the lane's own entry, at the CLEAN revision the Reader scored.
        expect(chapter.user).toContain(headingFor(book.chapters[0]!));
        expect(summary.user).toContain(headingFor(book.summaryGroups[0]!));
    });

    it('keeps a locked Summary section out of a chapter seat\'s LOCKED PEERS', async () => {
        const book = await laneBook();

        seedReaderScores(book);

        // The Author's lock on a Summary section is a fixed point for the OTHER SUMMARY SECTIONS only. A
        // chapter contract is not revised against a paragraph of the Overview, and a peer block that said
        // otherwise would tell the Editor to freeze a contract against prose it never composes with.
        const locked = lockPhraseGroup(book.rig.store, book.rig.story(), book.summaryGroups[0]!.id, AUTHOR_ATTR, {
            actor: 'author'
        });

        expect(locked.group.locked).toBe(true);

        const chapter = compileGroupLockPrompt(book.rig.store, book.rig.storyId, {
            groupRef: book.chapters[0]!.id,
            vectorHash: book.chapterVector
        });
        const summary = compileGroupLockPrompt(book.rig.store, book.rig.storyId, {
            groupRef: book.summaryGroups[1]!.id,
            vectorHash: book.summaryVector
        });

        expect(chapter.user).toContain('the rest of the chapter set is revised against');
        expect(chapter.user).not.toContain(headingFor(book.summaryGroups[0]!));
        // The Summary seat does see it — the scoping is per-phrase, not a blanket suppression.
        expect(summary.user).toContain(headingFor(book.summaryGroups[0]!));
    });
});

// ---------------------------------------------------------------------------
// 4 — The two refusals, which name the artifact in the engine's words
// ---------------------------------------------------------------------------

describe('a seat armed at a vector that is no longer the phrase\'s', () => {
    it('refuses with the lane\'s own noun, on both compilers', async () => {
        const book = await laneBook();

        // `subject`, not `artifact`: these two strings are engine diagnostics, and the engine's name for the
        // artifact is the Summary / the chapter set. Pinning the whole sentence is what stops a lane
        // refactor from renaming the thing a developer is told to look at.
        expect(() =>
            compileSectionScorePrompt(book.rig.store, book.rig.storyId, {
                groupRefs: book.chapters.map((group) => group.id),
                vectorHash: 'deadbeefdeadbeef'
            })
        ).toThrow(
            `compileSectionScorePrompt: story ${book.rig.storyId}'s reviewed chapter set moved from deadbeefdeadbeef to ` +
                `${book.chapterVector} between the seat's claim and its dispatch (D-67)`
        );

        // The lock seat's FIRST gate is the evidence gate, so an unscored chapter says so before it ever
        // compares vectors — and the sentence it says it names a chapter set, not a Summary.
        expect(() =>
            compileGroupLockPrompt(book.rig.store, book.rig.storyId, {
                groupRef: book.chapters[0]!.id,
                vectorHash: book.chapterVector
            })
        ).toThrow(
            `compileGroupLockPrompt: ${book.chapters[0]!.id} is not lockable by the Editor right now — story ` +
                `${book.rig.storyId} needs \`editor_group_locking\` on, a COMPLETE reviewed chapter set whose entry for this ` +
                'group is its current text, a Reader score for this group at that exact vector, and no live Writer over it (R-lock)'
        );

        // With the Reader's rows in place, the vector check is the one that fires — on both lanes.
        seedReaderScores(book);

        expect(() =>
            compileGroupLockPrompt(book.rig.store, book.rig.storyId, {
                groupRef: book.chapters[0]!.id,
                vectorHash: 'deadbeefdeadbeef'
            })
        ).toThrow(
            `compileGroupLockPrompt: story ${book.rig.storyId}'s reviewed chapter set moved from deadbeefdeadbeef to ` +
                `${book.chapterVector} between the seat's claim and its dispatch (R-lock)`
        );
        expect(() =>
            compileGroupLockPrompt(book.rig.store, book.rig.storyId, {
                groupRef: book.summaryGroups[0]!.id,
                vectorHash: 'deadbeefdeadbeef'
            })
        ).toThrow(
            `compileGroupLockPrompt: story ${book.rig.storyId}'s reviewed Summary moved from deadbeefdeadbeef to ` +
                `${book.summaryVector} between the seat's claim and its dispatch (R-lock)`
        );

        // The Summary lane keeps its own wording for the identical failure.
        expect(() =>
            compileSectionScorePrompt(book.rig.store, book.rig.storyId, {
                groupRefs: book.summaryGroups.map((group) => group.id),
                vectorHash: 'deadbeefdeadbeef'
            })
        ).toThrow(
            `compileSectionScorePrompt: story ${book.rig.storyId}'s reviewed Summary moved from deadbeefdeadbeef to ` +
                `${book.summaryVector} between the seat's claim and its dispatch (D-67)`
        );
    });

    it('scores the chapter vector against the chapter selection, never the Summary\'s', async () => {
        const book = await laneBook();
        const refs = book.chapters.map((group) => group.id);

        // Unscoped, `cleanSelectionOf` answers the Story's PRIMARY phrase. Handing a chapter seat the
        // SUMMARY vector is therefore not a near-miss: it is a different artifact, and the compiler refuses
        // it loudly rather than grading five sections under a chapter hash.
        expect(book.chapterVector).not.toBe(book.summaryVector);

        expect(() =>
            compileSectionScorePrompt(book.rig.store, book.rig.storyId, { groupRefs: refs, vectorHash: book.summaryVector })
        ).toThrow(
            `compileSectionScorePrompt: story ${book.rig.storyId}'s reviewed chapter set moved from ${book.summaryVector} to ` +
                `${book.chapterVector} between the seat's claim and its dispatch (D-67)`
        );

        // And the reverse: a Summary seat at the chapter vector.
        expect(() =>
            compileSectionScorePrompt(book.rig.store, book.rig.storyId, {
                groupRefs: book.summaryGroups.map((group) => group.id),
                vectorHash: book.chapterVector
            })
        ).toThrow(
            `compileSectionScorePrompt: story ${book.rig.storyId}'s reviewed Summary moved from ${book.chapterVector} to ` +
                `${book.summaryVector} between the seat's claim and its dispatch (D-67)`
        );
    });

    it('falls back to the phase-① lane when the Phrase ② row itself is gone', async () => {
        const book = await laneBook();
        const refs = book.chapters.map((group) => group.id);

        // The lane flag comes from the PHRASE ROW's controller (`phase1-prompt.ts:promptLaneOf` reads the
        // group row's `phrase_id`, then that row's key), so deleting it does not leave a half-chapter
        // prompt: the job is briefed as a phase-① batch again, on the Seed Brief and the `GroupDraft`
        // contract. That is the fail-closed direction — a Writer shown a Phrase ② law text it cannot
        // resolve would draft against a seed no gate hashes. (The `(no Plotlines Phrase row …)` body in
        // `phraseSeedSection` is the belt for a controller that resolves without its row, which these
        // compilers cannot reach; the entry rows still print, so the batch is never silently empty.)
        for (const phrase of book.rig.store.phrases.list().filter((row) => row.key === PHRASE_PLOTLINES_KEY))
            book.rig.store.phrases.delete(phrase.id, AUTHOR_ATTR);

        const prompt = compileGroupDraftPrompt(book.rig.store, book.rig.storyId, { groupRefs: refs });

        expect(prompt.user.startsWith('## SEED BRIEF\n')).toBe(true);
        expect(prompt.user).not.toContain(PHRASE_SEED_HEADING);
        expect(prompt.system.endsWith(`\n\n${GROUP_DRAFT_CONTRACT}`)).toBe(true);
        expect(prompt.user.split('\n').filter((line) => line.startsWith('### '))).toEqual(
            book.chapters.map((group) => headingFor(group))
        );
    });
});
