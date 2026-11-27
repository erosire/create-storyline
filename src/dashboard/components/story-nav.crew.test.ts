// C7 / R10 — the ONE crew-phrase read behind every phrase mark the desk prints.
//
// WHY A SEPARATE MODULE TEST. `StorylineApp.crew-phrase.test.tsx` pins the mounted status line; `CrewPanel.test.tsx`
// pins the (currently unmounted) thread panel. Both render this helper's words, so the RULE that must not drift is
// pinned here, away from either surface:
//   1. only LIVE threads are answered (§4.13's three live states, via `story-contract.isLiveRun`);
//   2. one mark per phrase, in the rail's fixed order, with the count and the live rows' claim keys;
//   3. `'unknown'` and an ABSENT key share one mark whose words are "phrase not named" — never Phrase ①;
//   4. no rows, no marks: an absent slice is not a claim that Phrase ① is running.
//
// The rows are built off `story-fixtures.ts:fixtureRuns()` (one `working` writer `r-5` claiming `w-9`, one
// `torn_down` editor `r-2` claiming `w-7`, story-fixtures.ts:725-771) so the fixture's own shape — not a row
// invented for this file — decides what "live" and "closed" mean here.
import { describe, expect, it } from 'vitest';

import { crewPhraseMarks } from './story-nav';
import { fixtureRuns } from './story-fixtures';
import type { ProjectedRun } from '../api';

const [FIXTURE_LIVE, FIXTURE_CLOSED] = fixtureRuns();

/** The fixture's live writer (`r-5`), with the projection's key and the claim the case cares about. */
function live(
    phrase_key: ProjectedRun['phrase_key'],
    over: { id?: string; work_item_ref?: string; started_at?: string } = {}
): ProjectedRun {
    return {
        ...FIXTURE_LIVE!,
        delegated: [],
        ...(phrase_key === undefined ? {} : { phrase_key }),
        ...(over.id === undefined ? {} : { id: over.id }),
        // `Object.hasOwn` rather than an `undefined` check: a case that asks for NO claim key means it, and a
        // spread of `{work_item_ref: undefined}` is exactly that (§4.13's field is optional).
        ...('work_item_ref' in over ? { work_item_ref: over.work_item_ref } : {}),
        ...(over.started_at === undefined ? {} : { started_at: over.started_at })
    };
}

/** The fixture's torn-down editor (`r-2`) — a row the line must never answer about. */
function closed(phrase_key: ProjectedRun['phrase_key']): ProjectedRun {
    return { ...FIXTURE_CLOSED!, delegated: [], ...(phrase_key === undefined ? {} : { phrase_key }) };
}

describe('story-nav.crewPhraseMarks — the desk’s crew-phrase read (C7/R10)', () => {
    it('a Phrase-② thread reads in the rail’s own words, with its claim key beside it', () => {
        expect(crewPhraseMarks([live('plotlines')])).toEqual([
            { key: 'plotlines', text: 'Phrase 2 — Plotlines', count: 1, claimKeys: ['w-9'] }
        ]);
    });

    it('a torn-down Phrase-① row is not an answer, and never becomes the default (AC3)', () => {
        // The fixture's only closed row, labelled Phrase ①: the live writer below carries no key at all, and the
        // desk says "phrase not named" rather than borrowing the closed row's phrase.
        expect(crewPhraseMarks([closed('summary'), live(undefined)])).toEqual([
            { key: 'unknown', text: 'phrase not named', count: 1, claimKeys: ['w-9'] }
        ]);
    });

    it("'unknown' and an ABSENT key join one mark, oldest thread’s claim first", () => {
        expect(crewPhraseMarks([live('unknown'), live(undefined, { id: 'r-6', work_item_ref: 'assistant_story_1_2' })])).toEqual([
            {
                key: 'unknown',
                text: 'phrase not named',
                count: 2,
                // Both threads started at the fixture's `r-5` instant, so the id tie-break is what orders them.
                claimKeys: ['w-9', 'assistant_story_1_2']
            }
        ]);

        // The order follows the clock, not the array: a later thread is listed last.
        expect(
            crewPhraseMarks([
                live(undefined, { id: 'r-6', work_item_ref: 'assistant_story_1_2', started_at: '2026-11-11T12:00:30.000Z' }),
                live('unknown', { started_at: '2026-11-11T11:57:30.000Z' })
            ])
        ).toEqual([
            { key: 'unknown', text: 'phrase not named', count: 2, claimKeys: ['w-9', 'assistant_story_1_2'] }
        ]);
    });

    it('two live threads on one phrase are ONE mark that counts them', () => {
        const secondLive = { ...FIXTURE_CLOSED!, state: 'working' as const, ended_at: null, delegated: [] };

        expect(
            crewPhraseMarks([
                live('plotlines', { started_at: '2026-11-11T11:57:30.000Z' }),
                { ...secondLive, phrase_key: 'plotlines' as const, started_at: '2026-11-11T11:30:00.000Z' }
            ])
        ).toEqual([
            {
                key: 'plotlines',
                text: 'Phrase 2 — Plotlines',
                count: 2,
                // The older thread's claim leads, so the tooltip cannot reshuffle between refetches.
                claimKeys: ['w-7', 'w-9']
            }
        ]);
    });

    it('both phrases live at once answers BOTH, in the rail’s fixed order, unnamed last', () => {
        expect(
            crewPhraseMarks([
                live('plotlines'),
                live('summary', { id: 'r-7', work_item_ref: 'wi_structure_seed_3f9a1c7b5d2e8a40_1' }),
                live('unknown', { id: 'r-8', work_item_ref: 'wi_group_check_4c1d8e2a77b0f5a3' })
            ]).map((mark) => [mark.key, mark.text, mark.count])
        ).toEqual([
            ['summary', 'Phrase 1 — Summary', 1],
            ['plotlines', 'Phrase 2 — Plotlines', 1],
            ['unknown', 'phrase not named', 1]
        ]);
    });

    it('no rows, no slice, a closed crew and an unclaimed live thread each say nothing invented', () => {
        expect(crewPhraseMarks([])).toEqual([]);
        expect(crewPhraseMarks(undefined)).toEqual([]);
        expect(crewPhraseMarks([closed('summary'), closed('plotlines')])).toEqual([]);
        // A live row with no claim key still gets its mark; the evidence list is simply empty.
        expect(crewPhraseMarks([live('summary', { work_item_ref: undefined })])).toEqual([
            { key: 'summary', text: 'Phrase 1 — Summary', count: 1, claimKeys: [] }
        ]);
    });
});
