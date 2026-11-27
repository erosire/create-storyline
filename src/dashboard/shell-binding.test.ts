// The binding layer's own contract: the wire shape → the panel props, in BOTH argument shapes
// the panels produce (see the header of `shell-binding.ts`). Pure functions plus the action
// bindings, so this file needs no DOM and no W10/W11 component — only their types.
import { describe, expect, it, vi } from 'vitest';
import { assignedTemplates, criteriaOps, shellActions, storyViewData } from './shell-binding';
import { fakeHarness, storyRow, storyView } from './testing/shell-fakes';
import type { SeedCleanupProposal } from './api';
import type { Chapter, Criterion, Template } from '../types';

const criterion = (id: string, hard: boolean): Criterion => ({
    id,
    label: `${id} label`,
    question: `does ${id} hold?`,
    checker: 'judge',
    hard,
    fix_hint: `fix ${id}`
});

const template = (id: string): Template => ({
    id,
    rev: 1,
    created_at: '2026-11-09T10:00:00.000Z',
    updated_at: '2026-11-09T10:00:00.000Z',
    name: id,
    title: `template ${id}`,
    roles: [],
    serves_phase: ['chapters'],
    done_definition: 'the chapter delivers its contract',
    attempts: 2,
    builtin: false,
    editable: true
});

/** A §4.4 chapter whose section ids are the address `undo` has to recover (D-7). */
const chapter: Chapter = {
    id: 'chapter_4',
    rev: 1,
    created_at: '2026-11-09T10:00:00.000Z',
    updated_at: '2026-11-09T10:00:00.000Z',
    story_id: 'story_1',
    order: 4,
    title: 'The salt chart',
    sections: [
        { id: 'section_1', text: 'one', origin: 'writer' },
        { id: 'section_2', text: 'two', origin: 'author' }
    ],
    state: 'in_pass',
    author_locked: false,
    round: 2
};

/** A harness with a chapter loaded, which is what the span-resolving bindings read. */
async function bound() {
    const harness = fakeHarness([storyRow('story_1')], [], {
        getStory: async () => ({ ...storyView(storyRow('story_1')), chapters: [chapter] })
    });
    await harness.store.openStory('story_1');
    return { ...harness, actions: shellActions(harness.store, 'story_1') };
}

describe('shell-binding — the wire shape becomes panel props', () => {
    it('resolves the assigned ids into the records the rail draws, in assignment order (D-17b / U-8d)', () => {
        const view = { ...storyView(storyRow('story_1')), templates: ['template_b', 'template_missing', 'template_a'] };
        const rail = storyViewData(view, [template('template_a'), template('template_b')]);
        expect(rail.templates.map((record) => record.id)).toEqual(['template_b', 'template_a']);
        // The rest of the pinned payload passes through untouched (P3: one source per fact).
        expect(storyViewData(view, []).templates).toEqual([]);
        expect(assignedTemplates(view, [template('template_a')])[0]?.id).toBe('template_a');
    });

    it("diffs the Goal panel's criterion list into route ops, and says nothing for a threshold-only edit (G-1)", () => {
        const current = [criterion('C-0', true), criterion('C-4', true), criterion('C-9', false)];

        // No list handed back means the Author only moved the threshold: no criterion writes.
        expect(criteriaOps(current, undefined)).toEqual([]);

        const next = [criterion('C-0', true), criterion('C-4', false), criterion('C-12', true)];
        expect(criteriaOps(current, next)).toEqual([
            { op: 'remove', id: 'C-9' },
            { op: 'setHard', id: 'C-4', hard: false },
            { op: 'add', criterion: criterion('C-12', true) }
        ]);
    });

    it('addresses undo at the section span, from a pair, a bare section id, or the panel object (D-7 / P11)', async () => {
        const { actions, client } = await bound();

        // The proposal row's own shape: one object naming the ref.
        await actions.undo({ targetRef: 'chapter_4:section_2' });
        expect(client.undo).toHaveBeenLastCalledWith('story_1', { chapter_id: 'chapter_4', section_id: 'section_2' });

        // A ref that names only the section resolves against the loaded chapters.
        await actions.undo({ targetRef: 'section_2' });
        expect(client.undo).toHaveBeenLastCalledWith('story_1', { chapter_id: 'chapter_4', section_id: 'section_2' });

        // And the pinned shape, unchanged: (storyId, {chapter_id, section_id}).
        await actions.undo('story_1', { chapter_id: 'chapter_4', section_id: 'section_1' });
        expect(client.undo).toHaveBeenLastCalledWith('story_1', { chapter_id: 'chapter_4', section_id: 'section_1' });
    });

    it("takes the prose editor's object write and the pinned positional write alike (D-37 / D-20a)", async () => {
        const { actions, client } = await bound();

        await actions.editSection({
            storyId: 'story_1',
            chapterId: 'chapter_4',
            sectionId: 'section_2',
            text: 'the sea remembers her name'
        });
        expect(client.editSection).toHaveBeenLastCalledWith(
            'story_1',
            'chapter_4',
            'section_2',
            'the sea remembers her name'
        );

        await actions.editSection('story_1', 'chapter_4', 'section_1', 'and so does the salt');
        expect(client.editSection).toHaveBeenLastCalledWith(
            'story_1',
            'chapter_4',
            'section_1',
            'and so does the salt'
        );

        // A write with no section cannot be addressed: named, rather than dialled at `undefined`.
        await expect(actions.editSection({ storyId: 'story_1' })).rejects.toThrow(
            'editSection was called without the id the route needs'
        );
    });

    it('binds the artifact verbs whatever scope the panel left out (D-29 / D-20 / G-1)', async () => {
        const { actions, client } = await bound();

        // IdeasTray hands over only the Idea id; the shell supplies the Story and the note (D-29).
        await actions.selectIdea('idea_7');
        expect(client.selectIdea).toHaveBeenLastCalledWith('story_1', 'idea_7', 'selected by the Author');

        // Pinned shape, with the tray's own note.
        await actions.selectIdea('story_1', 'idea_8', 'keep the naming scene out');
        expect(client.selectIdea).toHaveBeenLastCalledWith('story_1', 'idea_8', 'keep the naming scene out');

        await actions.discardIdea('idea_9');
        expect(client.discardIdea).toHaveBeenLastCalledWith('story_1', 'idea_9');

        // GoalPanel calls with the CHAPTER id and the override (G-1 / §14 item 2).
        await actions.setChapterBar('chapter_4', 'drop C-11 for this chapter');
        expect(client.setChapterBar).toHaveBeenLastCalledWith('story_1', 'chapter_4', 'drop C-11 for this chapter');

        await actions.unapproveChapter('chapter_4');
        expect(client.unapproveChapter).toHaveBeenLastCalledWith('story_1', 'chapter_4');

        // U-10b — the chapter row calls with (chapterId, why); the shell supplies the Story, exactly as
        // it does for the chapter bar above. The pinned three-argument shape passes through untouched.
        await actions.approveChapterFindings('chapter_4', 'approved from the chapter row by the Author (U-10b)');
        expect(client.approveChapterFindings).toHaveBeenLastCalledWith(
            'story_1',
            'chapter_4',
            'approved from the chapter row by the Author (U-10b)'
        );

        await actions.approveChapterFindings(
            'story_1',
            'chapter_4',
            'approved the ridge findings from the queue drill'
        );
        expect(client.approveChapterFindings).toHaveBeenLastCalledWith(
            'story_1',
            'chapter_4',
            'approved the ridge findings from the queue drill'
        );

        // No chapter id means no target: loud, not a call that approves the wrong chapter (L-13).
        await expect(actions.approveChapterFindings()).rejects.toThrow(
            'approveChapterFindings was called without the id the route needs'
        );

        // A proposal row that passes no id at all fails loudly instead of silently (L-13).
        await expect(actions.acceptProposal()).rejects.toThrow(
            'acceptProposal was called without the id the route needs'
        );
        await actions.acceptProposal('story_1', 'proposal_9');
        expect(client.acceptProposal).toHaveBeenLastCalledWith('story_1', 'proposal_9');
    });

    it("turns the Goal panel's list into ops on the route, resolving the goal id to its Story (G-1)", async () => {
        const { actions, client, store } = await bound();
        const goalId = store.selectedStory()?.goal.goal.id ?? '';

        await actions.patchGoal(goalId, {
            threshold_soft: 4,
            criteria: [criterion('C-0', true), criterion('C-4', false)]
        });
        // The fixture Goal starts empty, so both lines are adds; the diff cases are above.
        expect(client.patchGoal).toHaveBeenCalledWith('story_1', {
            threshold_soft: 4,
            criteria: [
                { op: 'add', criterion: criterion('C-0', true) },
                { op: 'add', criterion: criterion('C-4', false) }
            ]
        });

        // A threshold-only edit sends no criterion ops at all.
        await actions.patchGoal(goalId, { threshold_soft: 5 });
        expect(client.patchGoal).toHaveBeenLastCalledWith('story_1', { threshold_soft: 5, criteria: [] });
    });

    it("routes the locked pane's assistant note onto the §8.6 route with a target and a text", async () => {
        const { actions, client } = await bound();

        await actions.askAssistant({ storyId: 'story_1', field: 'premise', note: 'tighten the promise' });
        expect(client.requestAssistant).toHaveBeenLastCalledWith('story_1', {
            target: 'summary',
            text: 'tighten the promise'
        });

        await actions.requestAssistant('story_1', { target: 'directive', text: 'make the sea a character' });
        expect(client.requestAssistant).toHaveBeenLastCalledWith('story_1', {
            target: 'directive',
            text: 'make the sea a character'
        });
    });

    it("binds the Author's revision pick and merge request to their routes (U-13, U-13a, D-24, D-23)", async () => {
        const { actions, client } = await bound();

        // The pane calls with (unitRef, revisionId); the store method is the Story-scoped client verb,
        // and the shell supplies the Story — the panel never learns it (the whole point of this file).
        await actions.selectRevision?.('chapter_4', 'revision_2');
        expect(client.selectRevisionAuthor).toHaveBeenLastCalledWith('story_1', 'revision_2', undefined);

        // A one-argument call names the draft alone, which is enough: the row carries its own unit and
        // the server derives D-22's sibling delete from it.
        await actions.selectRevision?.('revision_3');
        expect(client.selectRevisionAuthor).toHaveBeenLastCalledWith('story_1', 'revision_3', undefined);

        await actions.mergeRevisions?.('chapter_4', ['revision_1', 'revision_2'], 'The opening of revision_1.');
        expect(client.mergeRevisions).toHaveBeenLastCalledWith('story_1', {
            unit_ref: 'chapter_4',
            revision_ids: ['revision_1', 'revision_2'],
            parts: 'The opening of revision_1.'
        });
    });
});

describe('shell-binding — the Reviewed Summary reaches the pane as props, not as a guess (D-67, D-68)', () => {
    it('threads the cached choose refusal onto the rail payload, and says NOTHING when there is none', () => {
        const view = storyView(storyRow('story_1'));
        const refusal =
            'this Story has no Reviewed Summary to choose: ending (unwritten) — a group joins the reviewed Overview only once a cross-group Critic pass closes with no unresolved defect on it (D-67, D-68).';

        // The refusal is a SENTENCE, not a flag: `reviewedError: ''` would be an empty paragraph in the pane,
        // and `undefined` must stay absent so the pane's `reviewedChooseError` reads "no refusal".
        expect(storyViewData(view, [], undefined, undefined, refusal).reviewedError).toBe(refusal);
        expect('reviewedError' in storyViewData(view, [], undefined, undefined)).toBe(false);
        expect('reviewedError' in storyViewData(view, [], undefined, undefined, undefined)).toBe(false);
        // A null is a deliberate "no refusal" from the store, and travels as itself (the pane tests both).
        expect(storyViewData(view, [], undefined, null, null).reviewedError).toBeNull();
        // The two error slots are independent: a failed phrase READ does not silence a choose refusal, and
        // one does not overwrite the other.
        const both = storyViewData(view, [], undefined, 'this Story has no Summary Phrase', refusal);

        expect(both.phraseError).toBe('this Story has no Summary Phrase');
        expect(both.reviewedError).toBe(refusal);
    });

    it('routes the choose from the pinned shape, the local shape, and a note that is not a story id (D-68)', async () => {
        const { actions, client } = await bound();

        // The pane's pinned call: (storyId, note).
        await actions.chooseReviewedSummary?.('story_1', 'the newer Ending');
        expect(client.choosePhraseReviewed).toHaveBeenLastCalledWith('story_1', { note: 'the newer Ending' });

        // The shell-local call: (note), with the Story being the shell's scope (D-29). The note is FREE
        // TEXT, so `scopeOf` alone would hand it to the route table as an id — `namesStory` is the guard.
        await actions.chooseReviewedSummary?.('the newer Ending');
        expect(client.choosePhraseReviewed).toHaveBeenLastCalledWith('story_1', { note: 'the newer Ending' });

        // A bare call is the verb with nothing attached, which is what the Summary tab sends.
        await actions.chooseReviewedSummary?.();
        expect(client.choosePhraseReviewed).toHaveBeenLastCalledWith('story_1', {});

        // And a first argument that DOES name the book, in the second position: still this Story, no note.
        await actions.chooseReviewedSummary?.('story_1');
        expect(client.choosePhraseReviewed).toHaveBeenLastCalledWith('story_1', {});
    });
});

// R7 — the desk's one-time Seed proofread, as the binding passes it. The card's action type names three
// arguments (`story-contract.ts:requestSeedCleanup`); the shell-local shape names the draft alone, with the
// Story and Phrase ② implied by the shell's scope. Both reach the SAME store verb, and nothing else: this read
// writes no row, so the binding takes no `phraseOpened` hop and no refetch (`state.ts:requestSeedCleanup`
// deliberately commits nothing but the error line, P10 — a refetch would re-render the card mid-draft).
describe('shell-binding — the Seed proofread is carried, not landed (R7)', () => {
    it('dials the store with the Story, Phrase ②, and the draft, in every shape the caller can send', async () => {
        // The harness's own `getStory`, but as a SPY: `bound()` installs a plain function there, and "the
        // proofread re-read nothing" needs a call list to count.
        const getStory = vi.fn(async (storyId: string) => storyView(storyRow(storyId)));
        const harness = fakeHarness([storyRow('story_1')], [], { getStory });
        await harness.store.openStory('story_1');
        const actions = shellActions(harness.store, 'story_1');
        const client = harness.client;
        const draft = 'A mapmaker she find her own coastline, and she need 6 charts.';
        const storyReads = getStory.mock.calls.length;

        // The card's pinned call: (storyId, phraseKey, seed).
        await actions.requestSeedCleanup?.('story_1', 'plotlines', draft);
        expect(client.getPhraseSeedCleanup).toHaveBeenLastCalledWith('story_1', 'plotlines', draft);

        // The shell-local call: the draft alone, against this shell's Story and the handoff phrase. A bare string
        // is NOT an id here — the ask has no id slot — so it is the seed, and the Story comes from the scope.
        await actions.requestSeedCleanup?.(draft);
        expect(client.getPhraseSeedCleanup).toHaveBeenLastCalledWith('story_1', 'plotlines', draft);

        // A bare call is the ask with no draft. The binding sends `''` rather than guessing an id, so the ROUTE's
        // 400 sentence is the answer (`routes.ts` refuses an unnamed Seed instead of spending a model call).
        await actions.requestSeedCleanup?.();
        expect(client.getPhraseSeedCleanup).toHaveBeenLastCalledWith('story_1', 'plotlines', '');

        // NO WRITE, NO REFETCH, NO LANDING. The phrase surface is untouched and the Story has not been re-read,
        // which is the difference between this verb and every other phrase verb in this file.
        expect((client.getStory as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(storyReads);
        expect(client.startPhrase).not.toHaveBeenCalled();
    });

    it('answers the card with the proposal itself — the binding adds nothing and drops nothing', async () => {
        // A proposal with `changed: true`, because the arms the card branches on (`ok`, `changed`) have to survive
        // the binding intact: a binding that mapped the answer into a boolean is a desk offering "confirm" on a
        // refusal.
        const proposal: SeedCleanupProposal = {
            ok: true,
            source_hash: '9b8387ee',
            text: 'A mapmaker finds her own coastline, and she needs 6 charts.',
            changed: true
        };
        const harness = fakeHarness([storyRow('story_1')], [], {
            getPhraseSeedCleanup: vi.fn(async () => proposal)
        });
        await harness.store.openStory('story_1');
        const actions = shellActions(harness.store, 'story_1');

        expect(await actions.requestSeedCleanup?.('story_1', 'plotlines', 'A mapmaker she find it.')).toBe(proposal);
        // The refusal arm travels the same way, as a VALUE: the shell's error line is for the route's failures,
        // and a guard's "I refused" is not one (AC3).
        expect(harness.store.getSnapshot().error).toBeNull();
    });
});
