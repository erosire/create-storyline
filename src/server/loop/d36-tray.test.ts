// D-36 / U-2 (review fix 5): locking a phase empties the Ideas tray — EVERY row of that phase,
// `selected` ones included.
//
// The rule previously existed twice, and the copy in `./invalidation`'s lock path and the one in
// `./records` disagreed: the copy kept `state === 'selected'` rows, on the theory that an accepted
// Idea is a record worth keeping. It is not — what was accepted became the phase's artifact (C-1/C-2
// judge the plotline, not the Idea that fed it; provenance is the journal), and a tray that still
// shows last phase's accepted rows makes L-7a's "empty the tray before the lock" meaningless.
//
// Pinned at both levels on purpose: `deletePhaseIdeas` is now the single definition, and `lockWrites`
// is the path the Author's sign-off actually takes, so the two must agree.
import { describe, expect, it } from 'vitest';
import type { Idea, IdeaState, Story, StoryPhase } from '../../shared/types';
import { Store } from '../store/store';
import { deletePhaseIdeas } from './records';
import { lockWrites } from './invalidation';

/** §4.1's defaults, spelled out because the store keeps whatever it is handed. */
function seedStory(store: Store, phase: StoryPhase): Story {
    return store.stories.create(
        {
            title: 'The Light Keeper',
            phase,
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
    ) as Story;
}

/** One §4.17 Idea in one state; the store mints the ids, so call order names them exactly. */
function seedIdea(store: Store, storyId: string, phase: StoryPhase, state: IdeaState): Idea {
    return store.ideas.create(
        {
            story_id: storyId,
            phase,
            body: `A ${state} proposal for ${phase}.`,
            kind: 'direction',
            author: 'reader_1',
            sources: [],
            fingerprint: `fp_${phase}_${state}`,
            seen_count: 1,
            state
        },
        { why: `seed: ${state} idea` }
    ) as Idea;
}

/** `[id, state]` of every Idea still on the board, so "what survived" is an exact value. */
function survivors(store: Store): Array<[string, IdeaState]> {
    return store.ideas
        .list()
        .filter((idea) => idea.story_id === 'story_1')
        .map((idea) => [idea.id, idea.state] as [string, IdeaState]);
}

describe('D-36 / U-2 — the lock empties the Ideas tray, selected rows included', () => {
    it('deletePhaseIdeas deletes proposed, selected, discarded and deferred alike, and leaves the next phase alone', () => {
        const store = Store.empty();
        const story = seedStory(store, 'plotlines');

        // Four states of the phase being locked. `selected` is the row the old copy spared.
        seedIdea(store, story.id, 'summary', 'proposed'); // idea_1
        seedIdea(store, story.id, 'summary', 'selected'); // idea_2
        seedIdea(store, story.id, 'summary', 'discarded'); // idea_3
        seedIdea(store, story.id, 'summary', 'deferred'); // idea_4
        // One row of the phase being ENTERED — it is not part of this tray (D-32's memory is per-phase).
        seedIdea(store, story.id, 'plotlines', 'selected'); // idea_5

        expect(deletePhaseIdeas(store, story.id, 'summary')).toBe(4);
        expect(survivors(store)).toEqual([['idea_5', 'selected']]);
    });

    it('every delete is journaled with the D-36 why, so the audit shows the tray was emptied by the lock', () => {
        const store = Store.empty();
        const story = seedStory(store, 'plotlines');

        seedIdea(store, story.id, 'summary', 'selected');
        seedIdea(store, story.id, 'summary', 'discarded');

        expect(deletePhaseIdeas(store, story.id, 'summary')).toBe(2);
        expect(
            store.journal
                .filter((event) => event.collection === 'ideas' && event.op === 'delete')
                .map((event) => ({ id: event.id, attribution: event.attribution }))
        ).toEqual([
            {
                id: 'idea_1',
                attribution: { run_ref: null, why: 'locking phase summary empties the Ideas tray (D-36)' }
            },
            {
                id: 'idea_2',
                attribution: { run_ref: null, why: 'locking phase summary empties the Ideas tray (D-36)' }
            }
        ]);
    });

    it("lockWrites('chapters') — the sign-off path the Author actually takes — deletes a selected Idea and reports the exact count", () => {
        const store = Store.empty();
        const story = seedStory(store, 'chapters');

        seedIdea(store, story.id, 'chapters', 'selected'); // idea_1 — the row the old copy kept alive
        seedIdea(store, story.id, 'chapters', 'discarded'); // idea_2
        seedIdea(store, story.id, 'summary', 'selected'); // idea_3 — an older phase's decided row

        // L-25a: `completed` is phase ③'s lock, and there is no fourth phase.
        expect(lockWrites(store, story, 'chapters', '2026-11-11T10:00:00.000Z')).toEqual({
            deleted_ideas: 2,
            next_phase: null
        });
        expect(survivors(store)).toEqual([['idea_3', 'selected']]);
    });
});
