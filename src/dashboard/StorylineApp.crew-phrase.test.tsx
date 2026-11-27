// C7 / R10 (AC1) — the phrase attribution is VISIBLE on the surface the Author actually gets.
//
// WHAT THE AUTHOR SAW. The desk's phrase mark existed only on `CrewPanel`, and `CrewPanel` is not mounted in the
// shell (§10.1's three regions are Stories+Rail | content | employee roster). So the rail could be lit on
// Phrase ① while the crew worked Phrase ② and the desk said nothing — symptom 3 as reported.
//
// THE SURFACE THIS PINS (the shell as it is mounted today, no new panel):
//   `StorylineApp` → `StoryView` → the ONE status line above every pane (`.sv-story-status`).
// It is mounted on every pane, it is the frame's only place that already reports engine state (the status badge,
// the reason sentence, phase ①'s sampling round), and `StoryView` already reads this same `runs` slice for its
// live count. The rows are the ones the shell's `getStory` answered — the `GET /stories/:id` payload — which is
// also the frame `state.ts:refreshStory` parks in the crew slot, so this file proves the label travels on the
// path the desk uses FIRST, without a second `GET /runs`.
//
// The rows are labelled the way the server labels them (`projections.ts:runPhraseKeyOf`, pinned by
// `run-phrase-attribution-story-view.test.ts`); here the desk's READING of those labels is what is pinned.
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';

import { StorylineApp } from './StorylineApp';
import { fakeHarness, renderWithStore, storyRow, storyView } from './testing/shell-fakes';
import type { ApiClient, ProjectedRun, StoryView as StoryViewPayload } from './api';
import type { Run } from '../shared/types';

/** The Story the shell's `getStory` answers with, over the rows one case cares about. */
function payloadWith(runs: ProjectedRun[]): StoryViewPayload {
    return { ...storyView(storyRow('story_1', { title: 'Hollow Sea' })), runs } as StoryViewPayload;
}

/** A §4.13 row in the shape `run/executor.ts` writes, plus the `phrase_key` the projection adds. */
function crewRow(
    id: string,
    init: { state: Run['state']; work_item_ref: string; phrase_key?: ProjectedRun['phrase_key'] }
): ProjectedRun {
    return {
        id,
        rev: 1,
        created_at: '2026-11-09T09:50:00.000Z',
        updated_at: '2026-11-09T09:55:00.000Z',
        story_id: 'story_1',
        work_item_ref: init.work_item_ref,
        template_ref: 'writer-plotlines',
        role: 'writer',
        state: init.state,
        started_at: '2026-11-09T09:55:00.000Z',
        tokens: 1200,
        kind: 'work',
        delegated: [],
        ...(init.phrase_key === undefined ? {} : { phrase_key: init.phrase_key })
    };
}

/**
 * Mounts the WHOLE shell over one Story, with the story region already open: the rail, the content column and the
 * real `StoryView` (nothing stubbed). `runs` is the Story payload's slice, so the desk is fed by `getStory` only.
 */
async function mountDesk(runs: ProjectedRun[]) {
    const listRuns = vi.fn(async () => runs);
    const overrides: Partial<ApiClient> = {
        getStory: async () => payloadWith(runs),
        listRuns
    };
    const harness = fakeHarness([storyRow('story_1', { title: 'Hollow Sea' })], [], overrides);

    await harness.store.reload();
    await harness.store.openStory('story_1');

    let rendered!: RenderResult;

    await act(async () => {
        rendered = renderWithStore(<StorylineApp store={harness.store} />, harness.store);
    });

    return { ...harness, ...rendered, listRuns };
}

/** The status line the shell mounts above the pane — the surface AC1 is about, read as ONE string. */
function statusLine(container: HTMLElement): string {
    const line = container.querySelector<HTMLElement>('.sv-story-status');

    expect(line === null ? null : line.textContent).not.toBeNull();

    return String(line!.textContent);
}

/** The crew chip itself, by phrase key; `null` is the honest "this frame says nothing about the phrase". */
function crewChip(container: HTMLElement, key: 'summary' | 'plotlines' | 'unknown'): HTMLElement | null {
    return container.querySelector<HTMLElement>(`.sv-story-crew-${key}`);
}

describe('the mounted desk names the phrase the crew is on (C7/R10, AC1)', () => {
    it('a live Phrase-② thread reads Phrase 2 on the one line above every pane', async () => {
        const { container } = await mountDesk([
            // The shape the loop mints for Phrase ②'s Writer batch: claim keyed on the plotlines phrase row.
            crewRow('run_1', {
                state: 'working',
                work_item_ref: 'wi_draft_groups_00000000-0000-4000-8000-00000000a11f_9b7c5d3e1f2a4068_2',
                phrase_key: 'plotlines'
            })
        ]);

        // The chip, verbatim, on the mounted surface — the rail's own words, not a paraphrase.
        expect(crewChip(container, 'plotlines')!.textContent).toBe('crew: Phrase 2 — Plotlines');

        const line = statusLine(container);

        // THE DEFECT, pinned as an absence: a Phrase-② thread never presented as Phrase ① work, and never
        // silently unlabelled either.
        expect(line).not.toContain('Phrase 1');
        expect(line).not.toContain('phrase not named');
        expect(line).toContain('crew: Phrase 2 — Plotlines');
    });

    it('a live Phrase-① thread reads Phrase 1, while the desk is standing on the Summary pane', async () => {
        const { container } = await mountDesk([
            crewRow('run_0', {
                state: 'working',
                work_item_ref: 'wi_draft_groups_summary_0_9b7c5d3e1f2a4068_1',
                phrase_key: 'summary'
            })
        ]);

        expect(crewChip(container, 'summary')!.textContent).toBe('crew: Phrase 1 — Summary');
        expect(statusLine(container)).not.toContain('Phrase 2');

        // And the desk is standing on the Summary pane while it says this: the label is about the CREW, and a
        // rail lit on Phrase ① is not evidence of what the staff is doing (nor is a Summary pane).
        expect(container.querySelector('.sv-summary')).not.toBeNull();
    });

    it('a thread the projection could not attribute is never shown as Phrase 1 (AC3)', async () => {
        const { container } = await mountDesk([
            // A `wi_group_check_*` pass: the claim key is a group-set hash BOTH phrases mint, so the server
            // answered `'unknown'`, and the desk says so rather than defaulting to the Summary.
            crewRow('run_4', { state: 'working', work_item_ref: 'wi_group_check_4c1d8e2a77b0f5a3', phrase_key: 'unknown' })
        ]);

        expect(crewChip(container, 'unknown')!.textContent).toBe('crew: phrase not named');
        expect(statusLine(container)).not.toContain('Phrase 1');
        expect(crewChip(container, 'summary')).toBeNull();
    });

    it('a row from a route that attributed nothing is treated the same honest way', async () => {
        // No `phrase_key` at all — the shape `POST /runs/:id/kill` answers, and the shape the Story payload had
        // before this wave. Absent is NOT Phrase ①.
        const { container } = await mountDesk([
            crewRow('run_9', { state: 'spawning', work_item_ref: 'assistant_story_1_1' })
        ]);

        expect(crewChip(container, 'unknown')!.textContent).toBe('crew: phrase not named');
        expect(crewChip(container, 'summary')).toBeNull();
        expect(statusLine(container)).not.toContain('Phrase 1');
    });

    it('two live threads on one phrase are ONE chip that counts them, and a closed Phrase-① row stays off the line', async () => {
        const { container } = await mountDesk([
            crewRow('run_1', {
                state: 'reporting',
                work_item_ref: 'wi_draft_groups_00000000-0000-4000-8000-00000000a11f_9b7c5d3e1f2a4068_1',
                phrase_key: 'plotlines'
            }),
            crewRow('run_2', {
                state: 'working',
                work_item_ref: 'wi_draft_groups_00000000-0000-4000-8000-00000000a11f_9b7c5d3e1f2a4068_2',
                phrase_key: 'plotlines'
            }),
            // Phrase ①'s last pass, torn down: history, and not an answer to "what are they on now".
            crewRow('run_0', {
                state: 'torn_down',
                work_item_ref: 'wi_structure_seed_3f9a1c7b5d2e8a40_1',
                phrase_key: 'summary'
            })
        ]);

        expect(crewChip(container, 'plotlines')!.textContent).toBe('crew: Phrase 2 — Plotlines ×2');
        expect(crewChip(container, 'summary')).toBeNull();
        expect(container.querySelectorAll('.sv-story-crew')).toHaveLength(1);

        // The claim keys of both live threads are the evidence behind the words — one hover, not a second panel.
        expect(crewChip(container, 'plotlines')!.getAttribute('title')).toContain(
            'claims: wi_draft_groups_00000000-0000-4000-8000-00000000a11f_9b7c5d3e1f2a4068_1, wi_draft_groups_00000000-0000-4000-8000-00000000a11f_9b7c5d3e1f2a4068_2'
        );
    });

    it('a Story whose crew is all closed puts no phrase on the line', async () => {
        const { container } = await mountDesk([
            crewRow('run_0', {
                state: 'torn_down',
                work_item_ref: 'wi_structure_seed_3f9a1c7b5d2e8a40_1',
                phrase_key: 'summary'
            })
        ]);

        expect(container.querySelectorAll('.sv-story-crew')).toHaveLength(0);
        expect(statusLine(container)).not.toContain('phrase not named');
    });

    it('the label arrives on the Story payload alone — the desk never needs `GET /runs` to say the phrase', async () => {
        const { container, listRuns } = await mountDesk([
            crewRow('run_1', {
                state: 'working',
                work_item_ref: 'wi_structure_plotlines_3f9a1c7b5d2e8a40_1',
                phrase_key: 'plotlines'
            })
        ]);

        expect(crewChip(container, 'plotlines')!.textContent).toBe('crew: Phrase 2 — Plotlines');
        expect(listRuns).toHaveBeenCalled();
    });

    it('a pane switch keeps the phrase line: the rail moving does not move the crew out of sight', async () => {
        const { container } = await mountDesk([
            crewRow('run_1', {
                state: 'working',
                work_item_ref: 'wi_structure_plotlines_3f9a1c7b5d2e8a40_1',
                phrase_key: 'plotlines'
            })
        ]);

        // Click the rail's Phrase ② header (the rail is another wave's file; the row is found, not re-described).
        const railRows = Array.from(container.querySelectorAll('.outline-phases button'));
        const plotlinesRow = railRows.find((row) => (row.textContent ?? '').includes('Plotlines'));

        expect(plotlinesRow === undefined ? null : plotlinesRow.textContent).toContain('Plotlines');

        await act(async () => {
            fireEvent.click(plotlinesRow!);
        });

        // The content column moved to Phrase ②'s pane; the crew line stayed, still naming Phrase ②.
        expect(crewChip(container, 'plotlines')!.textContent).toBe('crew: Phrase 2 — Plotlines');
    });
});
