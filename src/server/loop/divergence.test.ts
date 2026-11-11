/**
 * Acceptance for divergence — §12 row W4b ("a chapter drafted three ways, judged, and narrowed to one")
 * and decisions D-17d, D-22, D-23, L-16, L-20, P13.
 *
 * `attempts: 3` rewrites the assigned chapter Writer's `attempts` before the first sweep (D-17d: the
 * template is where the divergence count lives, §4.12), so the loop owes three drafts of every chapter.
 *
 * The rows pinned here are the ones the spec names: three draft runs, a checker pass PER DRAFT (D-22's
 * "the Editor chooses between drafts that have each been read" — a choice made about a draft nobody read
 * is not a choice), one Editor selection that deletes the losers in the same commit, the `selection_note`
 * the Editor wrote (L-17), and the winning prose landing on the chapter row (D-22).
 */
import { describe, expect, it } from 'vitest';

import { createRig, walkToChapters, type Rig } from './mock';

/** Draft rows as the store holds them: id, state, and the note the Editor left when it chose. */
function drafts(rig: Rig): string[] {
    return rig.store.revisions
        .list()
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((revision) => `${revision.id}:${revision.state}:${revision.selection_note ?? 'none'}`);
}

/** The Work Item refs one family of runs was built from, sorted so the assertion reads as a set. */
function runRefs(rig: Rig, prefix: string): string[] {
    return rig.store.runs
        .list()
        .filter((run) => (run.work_item_ref ?? '').startsWith(prefix))
        .map((run) => run.work_item_ref ?? '')
        .sort();
}

/** Three blind drafts of one chapter, plotlines locked. */
async function diverging() {
    const rig = await createRig({ story: { chapter_count: 1 }, attempts: 3 });

    await walkToChapters(rig, 1);

    return rig;
}

describe("D-17d / L-16 — the template's `attempts` buys that many blind drafts", () => {
    it('dispatches exactly `attempts` writer runs, each told no sibling exists', async () => {
        const rig = await diverging();

        await rig.run();

        expect(runRefs(rig, 'wi_write_chapter')).toEqual([
            'wi_write_chapter_1_1_a1',
            'wi_write_chapter_1_1_a2',
            'wi_write_chapter_1_1_a3'
        ]);

        // P13's blindness is written into the job line the sweep stamps, so the record shows the Writer
        // was never handed its sibling drafts — L-16's independence is a property of the brief, not of
        // the model's temperament.
        expect(
            [...rig.items.values()].filter((item) => item.id.startsWith('wi_write_chapter')).map((item) => item.note)
        ).toEqual([
            'Divergent draft 1/3 of chapter chapter_1: no other draft is visible to you (L-16, P13).',
            'Divergent draft 2/3 of chapter chapter_1: no other draft is visible to you (L-16, P13).',
            'Divergent draft 3/3 of chapter chapter_1: no other draft is visible to you (L-16, P13).'
        ]);

        // Each draft was its own competing row while the set was being built (D-21); after the Editor's
        // choice, only the winner is a row at all.
        expect(drafts(rig)).toEqual([
            'revision_1:selected:rule: keeps the chapter contract; revision_1 states the change on the page'
        ]);
    });

    it('holds the checkers until the set is complete, then judges each draft once (D-22, L-20)', async () => {
        const rig = await diverging();

        // While the unit still owes drafts, no checker is bought for a single sibling: the Editor judges
        // the SET together (§6.2a's loop B), and a pass bought now would be re-bought after every draft.
        const first = await rig.step();

        expect(first.stories[0].started).toEqual(['wi_write_chapter_1_1_a1']);

        await rig.run();

        // One checker pass per competing draft, each naming the draft it is told to read. The Work Item
        // has no revision field, so the draft is named in the job line and read with `listRevisions`.
        expect(runRefs(rig, 'wi_check_chapter')).toEqual([
            'wi_check_chapter_1_1_revision_1',
            'wi_check_chapter_1_2_revision_2',
            'wi_check_chapter_1_3_revision_3'
        ]);
        expect(
            runRefs(rig, 'wi_check_chapter')
                .map((ref) => rig.items.get(ref)?.note)
                .filter((note) => note !== undefined)
        ).toEqual([
            'This run judges draft revision_1 of chapter_1; read it with `listRevisions` and file your verdict against it.',
            'This run judges draft revision_2 of chapter_1; read it with `listRevisions` and file your verdict against it.',
            'This run judges draft revision_3 of chapter_1; read it with `listRevisions` and file your verdict against it.'
        ]);
    });
});

describe("D-22 / L-17 — the Editor's choice deletes the losers and records why", () => {
    it('selects once, removes the other drafts, and writes the note it gave', async () => {
        const rig = await diverging();

        await rig.run();

        expect(runRefs(rig, 'wi_select')).toEqual(['wi_select_1_chapter_1']);

        // D-22: the losers are deleted in the same commit that selected the winner — they do not linger
        // as `rejected` rows on a chapter that has moved on. The `selection_note` survives on the winner,
        // because L-17 asks that a re-run of the same divergence be able to say what was preferred.
        expect(drafts(rig)).toEqual([
            'revision_1:selected:rule: keeps the chapter contract; revision_1 states the change on the page'
        ]);
    });

    it('the chapter carries the winning prose, and it is the chosen revision (D-22, L-10)', async () => {
        const rig = await diverging();

        await rig.run();

        const chapter = rig.store.chapters.list()[0];

        expect({
            order: chapter.order,
            state: chapter.state,
            current_revision: chapter.current_revision,
            last_score: chapter.last_score,
            competing: rig.store.revisions.list().filter((revision) => revision.state === 'competing').length
        }).toEqual({
            order: 1,
            state: 'done',
            current_revision: 'revision_1',
            last_score: '4/4',
            competing: 0
        });

        // The section text is the winner's, named by the Work Item that drafted it — which is what makes
        // "where did this sentence come from" answerable a hundred chapters later (P11).
        expect(chapter.sections.map((section) => `${section.origin}:${section.text}`)).toEqual([
            'author:',
            'writer:draft wi_write_chapter_1_1_a1: Chapter 1 delivers its contract'
        ]);

        // L-20: a unit with drafts still competing is not finished with; a chosen draft is.
        expect(rig.story().status).toBe('pending');
    });
});
