// R4 (symptom 3) — WHERE THE DESK LANDS when the Author opens a phrase (`story-nav.ts:phraseLandingSelection`).
//
// The rail is static display data: it lists Summary ① and Plotlines ② and always opens on Phrase ①
// (`DEFAULT_STORY_SELECTION`). That was fine until the desk gained a verb that OPENS a phrase — accepting the
// final Summary and pressing "Start Phrase 2" both move the book into the chapter pipeline while the content
// area kept showing the phrase the Author had just left, which is symptom 3 as the Author observes it.
//
// This module is the whole rule, and the rule is a selection or NOTHING:
//
//   - a phrase the projection says has started (`story.phrase_started.plotlines`, the read of the phrase ROW) →
//     land on that phrase's overview;
//   - anything else → `undefined`, meaning "stay where the Author is". `undefined` is what keeps the move
//     NON-DESTRUCTIVE: a refused start, a lock that did not open Phrase ②, and a frame whose read never landed
//     must not yank the Author out of the pane they are standing in, and must not silently drop a group ref
//     they were reading.
//
// The started flag is the server's projection (`server/api/projections.ts:phrase_started` is
// `storyPhraseByKey(...) !== undefined`), never a row count — L-14's rule that the desk re-derives nothing.
import { describe, expect, it } from 'vitest';

import { DEFAULT_STORY_SELECTION, phraseLandingSelection } from './story-nav';
import type { StoryViewData } from './story-contract';

/** The smallest frame the rule reads: the projection's two phrase-started flags, or none at all. */
const frame = (
    phrase_started?: { summary: boolean; plotlines: boolean }
): Pick<StoryViewData, 'phrase_started'> | undefined =>
    phrase_started === undefined ? undefined : ({ phrase_started } as Pick<StoryViewData, 'phrase_started'>);

/**
 * A Story payload that carries NO `phrase_started` field at all — the legacy wire, and the frame of a Story whose
 * read has not landed. The cast is the honest narrowing: the rule reads two flags, and this payload names neither.
 */
const frameWithoutFlags = (): Pick<StoryViewData, 'phrase_started'> => ({}) as Pick<
    StoryViewData,
    'phrase_started'
>;

describe('the desk lands on the phrase the Author just opened (R4)', () => {
    it('moves to Phrase 2 when the projection says the plotlines phrase exists', () => {
        // The exact selection: the phrase's OVERVIEW (`panel:'plotlines'`, no `ref`), because what the Author
        // just opened is the phrase — its brief and its entry rows — and not one entry inside it.
        expect(phraseLandingSelection(frame({ summary: true, plotlines: true }), 'plotlines')).toEqual({
            panel: 'plotlines'
        });
    });

    it('stays put when Phrase 2 has not been started, which is the non-destructive half of the rule', () => {
        // The state the handoff button exists to leave: the Summary was accepted, and nobody has copied it into
        // the phrase yet. A desk that moved here would open a Phrase-② pane with no rows and no brief.
        expect(phraseLandingSelection(frame({ summary: true, plotlines: false }), 'plotlines')).toBeUndefined();
    });

    it('stays put on a payload that carries no phrase-started flags at all', () => {
        // Absent is not "started": it is "the desk has not been told". A legacy book (no field on the wire) and
        // a frame whose Story read has not landed both answer this way, and neither may be read as Phrase ②.
        expect(phraseLandingSelection(frame(), 'plotlines')).toBeUndefined();
        expect(phraseLandingSelection(frameWithoutFlags(), 'plotlines')).toBeUndefined();
        expect(phraseLandingSelection(undefined, 'plotlines')).toBeUndefined();
    });

    it('never moves the desk for a Phrase-1 act, so an open group pane survives the Accept', () => {
        // Phrase ①'s row set comes from the catalog and the loop writes it, so no verb opens it. Moving the
        // rail on a Phrase-① verb would drop the `summary-group:<uuid>` the Author is standing on.
        const started = frame({ summary: true, plotlines: true });

        expect(phraseLandingSelection(started, 'summary')).toBeUndefined();
        // And the two phrases the rail has no start verb for keep the same answer: no verb, no landing.
        expect(phraseLandingSelection(started, 'characters')).toBeUndefined();
        expect(phraseLandingSelection(started, 'chapters')).toBeUndefined();
    });

    it('still OPENS every story on Phrase 1 — the landing rule does not change the desk’s default', () => {
        // AC1's other half: an un-started book opens on the Summary, and that default is a constant, not a
        // side effect of the landing rule. A book whose Phrase ② nobody started opens the same way.
        expect(DEFAULT_STORY_SELECTION).toEqual({ panel: 'summary' });
        expect(phraseLandingSelection(frame({ summary: true, plotlines: false }), 'plotlines')).not.toBe(
            DEFAULT_STORY_SELECTION
        );
    });
});
