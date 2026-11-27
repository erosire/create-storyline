// U-7 / D-18 / S-3 / S-6 / S-7 / U-8d — the live-thread panel.
//
// The right region lists THREADS: a run is one thread inside the phase's session (the UI's
// "phrase"), not the session itself, so a row exists from spawn to teardown (D-18) and carries
// what it is doing, what it costs in wall-clock (S-6, informational only per E-0), whether its
// internal panel disagreed (D-38), and the cord for that one thread (U-7). A delegated
// sub-context is a nested thread, with no row and no kill button of its own (S-7).
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { CrewPanel } from './CrewPanel';
import { click } from '../testing/shell-fakes';
import { NOW, fixtureActions, fixtureRuns, fixtureTemplates } from './story-fixtures';
// C2a/R4 — the phrase mark is a field the CREW LISTING's projection adds, so the rows a mark test builds are the
// projected rows (`api.ts:ProjectedRun`), not the bare §4.13 record.
import type { ProjectedRun } from '../api';

function renderCrew(runs = fixtureRuns(), handlers: Partial<Parameters<typeof CrewPanel>[0]> = {}) {
    return render(<CrewPanel runs={runs} templates={fixtureTemplates()} now={NOW} {...handlers} />);
}

/** The live rows (the closed ones are inside a collapsed details, and read differently). */
function liveRows(): HTMLElement[] {
    const list = document.querySelector('.sv-runs') as HTMLElement;
    return Array.from(list.querySelectorAll<HTMLElement>(':scope > .sv-run'));
}

describe('CrewPanel — the harnesses and what they are doing (U-7, D-18, S-3, S-6, S-7, U-8d)', () => {
    it('lists the live run with its kind, work item, elapsed time, and token count', () => {
        renderCrew();

        expect(screen.getByText('Threads — live on this story (U-7)')).toBeTruthy();
        expect(screen.getByText('1 running')).toBeTruthy();

        const [row] = liveRows();
        expect(liveRows().length).toBe(1);
        // U-8a: the crew that writes reads different from the crew that judges.
        expect((row.querySelector('.sv-run-kind') as HTMLElement).textContent).toBe('writer');
        expect(row.className).toContain('sv-run-writer');
        expect(within(row).getByText('Chapter crew')).toBeTruthy();
        expect(within(row).getByText('working')).toBeTruthy();
        expect(within(row).getByText('holds w-9')).toBeTruthy();
        expect(
            within(row).getByText('done when: every criterion the plotline names is answerable from the prose')
        ).toBeTruthy();

        // S-6: elapsed is shown, and the tooltip refuses to let it read as a limit (E-0).
        expect((row.querySelector('.sv-run-elapsed') as HTMLElement).textContent).toBe('2m 30s');
        expect(row.querySelector('.sv-run-elapsed')!.getAttribute('title')).toBe(
            'wall-clock, informational only (S-6, E-0)'
        );
        expect(within(row).getByText('1,234 tokens (informational — E-0)')).toBeTruthy();
    });

    it('says what a panel role inside the run is, and marks the answer that was not unanimous (D-38, U-8d)', () => {
        renderCrew();
        const [row] = liveRows();

        expect(
            within(row).getByText(
                'panel of 3 writer agents inside this one run · aggregate: merge · the loop gets one report (D-38)'
            )
        ).toBeTruthy();
        expect(
            within(row).getByText(
                'the run reported disagreement: 1 of 3 preferred the earlier cut — dissent recorded in the selection note.'
            )
        ).toBeTruthy();

        // S-7 / T-2b: the delegated sub-context is nested — no row, no cord of its own.
        const nested = row.querySelector('.sv-delegated') as HTMLElement;
        expect(within(nested).getByText('reader')).toBeTruthy();
        expect(within(nested).getByText('check C-8 against the plotline')).toBeTruthy();
        expect(
            within(nested).getByText('1 of 3 preferred the earlier cut — dissent recorded in the selection note.')
        ).toBeTruthy();
        expect(within(nested).getByText('300 tokens')).toBeTruthy();
        expect(within(nested).getByText('a thread this run spun — not a work item (S-7, T-2b)')).toBeTruthy();
        expect(nested.querySelector('.sv-run-kill')).toBeNull();
    });

    it('gives the live run exactly one cord, and records why a closed run ended (U-7, S-3, D-18)', async () => {
        const { actions, calls } = fixtureActions();
        renderCrew(fixtureRuns(), { onKillRun: (runId) => void actions.killRun?.(runId) });

        const [row] = liveRows();
        await click(within(row).getByRole('button', { name: 'Kill run' }));
        expect(calls.killRun).toEqual([['r-5']]);

        // The torn-down run is collapsed below, and its row says why it ended (S-3).
        const closed = document.querySelector('.sv-crew-closed') as HTMLElement;
        expect(within(closed).getByText('1 threads torn down — each row says why it ended (S-3)')).toBeTruthy();
        const ended = closed.querySelector('.sv-run-ended') as HTMLElement;
        expect(ended.textContent).toBe('ended 2026-11-11T11:34:20.000Z · killed by author stop (D-37)');
        expect(closed.querySelector('.sv-run-kill')).toBeNull();
        // Its elapsed time is measured to `ended_at`, not to now.
        expect((closed.querySelector('.sv-run-elapsed') as HTMLElement).textContent).toBe('4m 20s');
    });

    it('says so plainly when nothing is running, and keeps the cord disabled without the route', () => {
        const { rerender } = renderCrew(fixtureRuns().slice(1));

        expect(screen.getByText('No thread is running on this story right now.')).toBeTruthy();
        expect(screen.getByText('0 running')).toBeTruthy();

        rerender(<CrewPanel runs={fixtureRuns()} templates={fixtureTemplates()} now={NOW} />);
        const [row] = liveRows();
        const kill = within(row).getByRole('button', { name: 'Kill run' }) as HTMLButtonElement;
        expect(kill.disabled).toBe(true);
        expect(kill.getAttribute('title')).toBe('Tear this thread down; the Story keeps running (D-18, S-3)');
    });
});

// C2a / R4 (symptom 3) — WHICH PHRASE the thread is on, printed on the row.
//
// Before this mark, the only phrase words on screen were the rail's lit row, so a Phrase-② thread under a rail that
// still read Phrase ① was indistinguishable from the desk "going back to Phrase 1". The words come from the
// projection's `phrase_key` (`server/api/projections.ts:runPhraseKeyOf`), and the DESK NEVER GUESSES: a key the
// server could not resolve prints "phrase not named" rather than the Summary's name, which is the default this
// change removes. The label itself is the rail's own `phraseLabel` (`components/story-nav.ts`), so the number and
// the title cannot drift apart between the two panels.
describe('CrewPanel — the phrase mark on a thread row (C2a/R4, V-3)', () => {
    /** The fixture rows, wearing the phrase keys the crew listing's projection would give them. */
    function labelled(keys: ('summary' | 'plotlines' | 'unknown' | undefined)[]): ProjectedRun[] {
        return fixtureRuns().map((run, index) => ({
            ...run,
            ...(keys[index] === undefined ? {} : { phrase_key: keys[index] })
        })) as ProjectedRun[];
    }

    it('names Phrase 2 out loud on a thread the projection files under Plotlines', () => {
        renderCrew(labelled(['plotlines', undefined]));

        const [row] = liveRows();
        const mark = row.querySelector('.sv-run-phrase') as HTMLElement;

        expect(mark.textContent).toBe('Phrase 2 — Plotlines');
        expect(mark.className).toBe('sv-run-phrase sv-run-phrase-plotlines');
        // The tooltip says HOW the mark was derived, so the Author can tell a derived phrase from a guessed one.
        expect(mark.getAttribute('title')).toBe(
            'which phrase this thread belongs to, read off the group rows it holds or the phrase its claim key is keyed on (R4, V-3)'
        );
        // The mark sits in the WORK line, beside the claim it holds — the pair the Author reads together.
        expect((row.querySelector('.sv-run-work') as HTMLElement).textContent).toContain('holds w-9');
    });

    it('names Phrase 1 on a thread the projection files under the Summary, torn-down rows included', () => {
        renderCrew(labelled([undefined, 'summary']));

        const closed = document.querySelector('.sv-crew-closed') as HTMLElement;
        const mark = closed.querySelector('.sv-run-phrase') as HTMLElement;

        expect(mark.textContent).toBe('Phrase 1 — Summary');
        expect(mark.className).toBe('sv-run-phrase sv-run-phrase-summary');
    });

    it('says "phrase not named" for an unresolvable key, and never falls back to Phrase 1', () => {
        renderCrew(labelled(['unknown', undefined]));

        const [row] = liveRows();
        const mark = row.querySelector('.sv-run-phrase') as HTMLElement;

        expect(mark.textContent).toBe('phrase not named');
        expect(mark.className).toBe('sv-run-phrase sv-run-phrase-unknown');
        // THE DEFAULT THAT USED TO LIE: an unresolved key rendered "Phrase 1 — Summary".
        expect(document.body.textContent).not.toContain('Phrase 1 — Summary');
        // The unknown's tooltip names the witness that WOULD have answered (the shared vector-hash family).
        expect(mark.getAttribute('title')).toContain('both phrases mint');
    });

    it('distinguishes a row that carries no key at all from one whose key the server could not resolve', () => {
        renderCrew(labelled([undefined, 'unknown']));

        // The live row carries NO `phrase_key` (it came off a route that does not attribute), so its sentence is
        // the absent-key one, and the torn-down row's is the shared-family one.
        const liveMark = liveRows()[0].querySelector('.sv-run-phrase') as HTMLElement;

        expect(liveMark.textContent).toBe('phrase not named');
        expect(liveMark.getAttribute('title')).toBe(
            'this row came from a route that attributes no phrase; only the crew listing does, and the desk will not invent one (R4)'
        );

        const closedMark = (document.querySelector('.sv-crew-closed') as HTMLElement).querySelector(
            '.sv-run-phrase'
        ) as HTMLElement;

        expect(closedMark.textContent).toBe('phrase not named');
        expect(closedMark.getAttribute('title')).not.toBe(liveMark.getAttribute('title'));
    });
});
