/**
 * R1 — a discarded revision carries the reason it was discarded.
 *
 * WHY THIS FILE EXISTS: the rail could already tell the Author THAT a revision lost, never WHY. The
 * two Editor moves that park a retained row in `discarded` are §8.2's `rejectAll` (editor.ts:464) and
 * the Summary half of `commitSelection` (artifacts.ts:599); both already carry a mandatory
 * justification (T-5's `why`, T-2a's `selection_note`) and both threw it into the journal only. These
 * tests pin the durable half: the reason is written on the row, as `Revision.discard_reason`, beside
 * the state change that made it history.
 *
 * `selection_note` is deliberately NOT reused — it is the winner's sentence about the choice (T-2a),
 * and the sidebar needs the loser's reason beside it. Every assertion is an exact value: the whole
 * row triple that changes, and the journaled patch that produced it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../store/store';
import type { Chapter, Revision, RoleKind, Story } from '../../shared/types';
import { createToolRuntime, type RunToolContext, type ToolResult, type ToolRuntime } from './index';
import type { RunSession } from './types';

/** Builds a Story row with the exact §4.1 defaults a fresh Story carries (as runtime.test.ts does). */
function seedStory(store: Store, title: string): Story {
    return store.stories.create(
        {
            title,
            phase: 'chapters',
            idea: 'A lighthouse keeper learns the light was never the point.',
            summary_locked: false,
            plotlines_locked: false,
            pending_kind: 'none',
            status: 'ready',
            trend: 'unknown',
            auto_approve: ['critical'],
            author_stop: false,
            digest_rev: 0,
            template_refs: [],
            chapter_deps: {}
        },
        { why: 'seed: story created' }
    );
}

/** One Story, its Summary, one plotline and one chapter — the units the two tools can act on. */
function seedWorld(): { store: Store; story: Story; chapter: Chapter; summaryId: string } {
    const store = Store.empty();
    const story = seedStory(store, 'The Light Keeper');
    const summary = store.summaries.create(
        { story_id: story.id, chapter_count: 1, premise: 'A keeper, a light, a debt.', locked: false },
        { why: 'seed: summary created' }
    );
    const plotline = store.plotlines.create(
        {
            story_id: story.id,
            order: 1,
            heading: 'The keeper signs off',
            must_happen: 'He climbs the tower.',
            must_change: 'He knows the light is his own fault.',
            contract_locked: false,
            aligned: false,
            needs_recheck: false
        },
        { why: 'seed: plotline created' }
    );
    const chapter = store.chapters.create(
        {
            story_id: story.id,
            plotline_ref: plotline.id,
            order: 1,
            title: 'Sign off',
            summary: 'The keeper climbs.',
            sections: [{ id: 'section_1', text: 'The standing text before any draft.', origin: 'writer' }],
            state: 'drafting',
            author_locked: false,
            round: 0
        },
        { why: 'seed: chapter created' }
    );

    return { store, story, chapter, summaryId: summary.id };
}

/**
 * The three fields the rail reads, per row, in the store's own id order. Asserting the whole triple
 * (not just the reason) is what catches a write that sets the state and forgets the reason, or sets
 * the reason on a row nobody discarded.
 */
const reasonsOf = (store: Store) =>
    store.revisions.list().map((row) => ({
        id: row.id,
        state: row.state,
        selection_note: row.selection_note,
        discard_reason: row.discard_reason
    }));

/** The journaled update patches on `revisions`, as `{id, patch}` — proof the reason is durable (P11). */
const revisionPatchesOf = (store: Store, label: string) =>
    store.journal
        .filter((event) => event.commit_label === label && event.collection === 'revisions' && event.op === 'update')
        .map((event) => ({ id: event.id, patch: event.patch }));

/** Files one competing draft of the chapter (§4.15: a chapter body is `{sections}`). */
function seedChapterDraft(store: Store, story: Story, chapter: Chapter, text: string): Revision {
    return store.revisions.create(
        {
            story_id: story.id,
            unit_kind: 'chapter',
            unit_ref: chapter.id,
            body: { sections: [{ id: 'section_1', text, origin: 'writer' }] },
            state: 'competing',
            verdict_refs: []
        },
        { why: 'seed: competing draft' }
    ) as Revision;
}

/** Files one competing Summary draft (§4.15: a Summary body is `{fields}`, tools/artifacts.ts:502). */
function seedSummaryDraft(store: Store, story: Story, summaryId: string, ending: string): Revision {
    return store.revisions.create(
        {
            story_id: story.id,
            unit_kind: 'summary',
            unit_ref: summaryId,
            body: { fields: { ending } },
            state: 'competing',
            verdict_refs: []
        },
        { why: 'seed: competing summary draft' }
    ) as Revision;
}

describe('the discard reason on a discarded revision (R1)', () => {
    let store: Store;
    let story: Story;
    let chapter: Chapter;
    let summaryId: string;

    beforeEach(() => {
        const world = seedWorld();
        store = world.store;
        story = world.story;
        chapter = world.chapter;
        summaryId = world.summaryId;
    });

    /** Runs one call as one role kind, the way the run layer builds its context. */
    async function call(roleKind: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
        const session: RunSession = {
            storyId: story.id,
            roleKind: roleKind as RoleKind,
            roleName: `${roleKind}_1`,
            runId: `run_${roleKind}`
        };
        const runtime: ToolRuntime = createToolRuntime(store);
        const context: RunToolContext = runtime.createContext(session);

        return runtime.execute(context, name, args);
    }

    it("rejectAll writes the Editor's why onto every draft it discards, and still opens the re-brief (R1, L-18)", async () => {
        seedChapterDraft(store, story, chapter, 'The map paid off on the page.');
        seedChapterDraft(store, story, chapter, 'The bell under the water.');

        const why = 'Neither draft answers the brief: the contract never sets up the climb.';
        const result = await call('editor', 'rejectAll', {
            unit_ref: chapter.id,
            why,
            re_brief: 'Rebuild the chapter around the map, not the weather.'
        });

        expect(result.ok).toBe(true);
        expect(result.data).toEqual({
            unit_ref: 'chapter_1',
            discarded: ['revision_1', 'revision_2'],
            count: 2,
            next: 'a Writer works the re-brief task for chapter_1; the rejected drafts stay readable'
        });

        // R1: the reason is ON the rows, and `selection_note` is untouched — it names a winner, and
        // these rows have none.
        expect(reasonsOf(store)).toEqual([
            { id: 'revision_1', state: 'discarded', selection_note: undefined, discard_reason: why },
            { id: 'revision_2', state: 'discarded', selection_note: undefined, discard_reason: why }
        ]);

        // P11/D-12a: the journaled patch is the state change plus the reason, in one write, under the
        // tool's own commit label — the reason is durable history, not a projection guess.
        expect(revisionPatchesOf(store, 'tool:rejectAll')).toEqual([
            { id: 'revision_1', patch: { state: 'discarded', discard_reason: why } },
            { id: 'revision_2', patch: { state: 'discarded', discard_reason: why } }
        ]);

        // L-18's other half is unchanged: the re-brief task still carries the same words the row does.
        expect(
            store.tasks.list().map((task) => ({
                id: task.id,
                kind: task.kind,
                title: task.title,
                owner_role: task.owner_role,
                detail: task.detail
            }))
        ).toEqual([
            {
                id: 'task_1',
                kind: 're_brief',
                title: 'Re-brief chapter_1: all 2 drafts rejected',
                owner_role: 'writer',
                detail: `${why}\nRe-brief: Rebuild the chapter around the map, not the weather.`
            }
        ]);
    });

    it('persists the reason trimmed, so the rail never renders a padded or blank string (R1, T-5)', async () => {
        seedChapterDraft(store, story, chapter, 'The map paid off on the page.');

        // `whyOf` (tools/utilities.ts:232) trims before the write, and a blank `why` is refused by
        // T-5 before `execute` runs (tools/context.ts:232) — so the stored field is never empty.
        const result = await call('editor', 'rejectAll', {
            unit_ref: chapter.id,
            why: '\n   The brief is wrong, not the prose.   ',
            re_brief: 'Name the scene the chapter must actually deliver.'
        });

        expect(result.ok).toBe(true);
        expect(store.revisions.require('revision_1')).toMatchObject({
            state: 'discarded',
            discard_reason: 'The brief is wrong, not the prose.'
        });
    });

    it("a Summary selection writes its note onto every kept loser and leaves the winner's fields alone (R1, D-22)", async () => {
        seedSummaryDraft(store, story, summaryId, 'She floods the valley on purpose.');
        seedSummaryDraft(store, story, summaryId, 'She leaves the valley standing.');

        const note = 'It keeps the flood deliberate, which is the rule the Seed promises (T-2a).';
        const result = await call('editor', 'selectRevision', {
            unit_ref: summaryId,
            revision_id: 'revision_2',
            selection_note: note,
            expects: [{ id: summaryId, rev: 1 }]
        });

        expect(result.ok).toBe(true);
        expect((result.data as Record<string, unknown>).deleted_drafts).toEqual([]);

        // D-22's Summary exception: the loser survives as history, with the sentence that decided
        // against it. The winner keeps `selection_note` (T-2a) and gains no `discard_reason`.
        expect(reasonsOf(store)).toEqual([
            { id: 'revision_1', state: 'discarded', selection_note: undefined, discard_reason: note },
            { id: 'revision_2', state: 'selected', selection_note: note, discard_reason: undefined }
        ]);

        expect(revisionPatchesOf(store, 'tool:selectRevision')).toEqual([
            { id: 'revision_2', patch: { state: 'selected', selection_note: note } },
            { id: 'revision_1', patch: { state: 'discarded', discard_reason: note } }
        ]);

        // The install is still the winner's prose (this is the selection, not a new verb).
        expect(store.summaries.require(summaryId).ending).toBe('She leaves the valley standing.');
    });

    it('a chapter selection still deletes its losers hard, so no reason is invented on a row nobody reads (D-22)', async () => {
        seedChapterDraft(store, story, chapter, 'The map paid off on the page.');
        seedChapterDraft(store, story, chapter, 'The bell under the water.');

        const result = await call('editor', 'selectRevision', {
            unit_ref: chapter.id,
            revision_id: 'revision_2',
            selection_note: 'It keeps the bell under the water.',
            expects: [{ id: chapter.id, rev: chapter.rev }]
        });

        expect(result.ok).toBe(true);
        expect((result.data as Record<string, unknown>).deleted_drafts).toEqual(['revision_1']);

        // Only RETAINED rows carry a reason; D-22's hard delete is unchanged, and the winner's own
        // fields are exactly what they were before this field existed.
        expect(reasonsOf(store)).toEqual([
            {
                id: 'revision_2',
                state: 'selected',
                selection_note: 'It keeps the bell under the water.',
                discard_reason: undefined
            }
        ]);
        expect(store.revisions.get('revision_1')).toBeUndefined();
    });
});
