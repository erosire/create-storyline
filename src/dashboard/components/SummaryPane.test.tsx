// U-4 / U-16 / L-30 — the Summary pane.
//
// Phase ① is a flat Revision 1…N history. The pane shows the Summary on record, the review
// counts, and every revision; opening one revision shows that version and its findings.
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { SummaryPane } from './SummaryPane';
import { click } from '../testing/shell-fakes';
import { fixtureRevisions, fixtureStory, fixtureSummary } from './story-fixtures';
import type { SummaryRevisionEntry } from './story-nav';

const DELETION_SENTENCE =
    'Backtrack to ① Summary deletes 4 chapters with their 4 revisions, 2 plotlines, and the derived Digest. ' +
    'Verdicts and findings survive as provenance; the Ideas do not — the lock already deleted them (D-25, D-36, L-31). ' +
    'Story "Neon Cathedral" starts again from its Seed.';

const REVISION = fixtureRevisions().find((revision) => revision.unit_kind === 'summary')!;

const ENTRY: SummaryRevisionEntry = {
    revision: { ...REVISION, state: 'competing' },
    index: 3,
    findings: [
        {
            id: 'finding_draft',
            rev: 1,
            created_at: '2026-11-11T11:00:00.000Z',
            updated_at: '2026-11-11T11:00:00.000Z',
            story_id: 's1',
            target_ref: 'sum1',
            criterion_ref: 'C-14',
            title: 'The draft loses the stray',
            evidence: 'premise names a keeper',
            cost: 'major',
            fingerprint: 'fp-draft',
            state: 'confirmed',
            seen_count: 1
        }
    ],
    editorVerdicts: []
};

describe('SummaryPane — locked law, and the one way in (U-4, U-16, L-30, L-32)', () => {
    it('marks the locked Summary read-only for every agent and names Backtrack as the only move', async () => {
        render(
            <SummaryPane
                story={fixtureStory()}
                summary={fixtureSummary()}
                onBacktrack={() => undefined}
                backtrackNote={DELETION_SENTENCE}
            />
        );

        expect(screen.getByText('locked — read-only for every agent (P5, L-30)')).toBeTruthy();
        expect(screen.getByText(/the only move is a Backtrack/)).toBeTruthy();

        const pane = screen.getByRole('region', { name: 'Summary' });
        const confirm = within(pane);
        expect(pane.querySelectorAll('textarea').length).toBe(0);

        await click(confirm.getByRole('button', { name: 'Backtrack' }));
        expect(screen.getByText(DELETION_SENTENCE)).toBeTruthy();
        await click(screen.getByRole('button', { name: 'Cancel' }));
        await click(confirm.getByRole('button', { name: 'Backtrack' }));
        await click(screen.getByRole('button', { name: 'Confirm' }));
    });

    it('prints every §4.2 field read-only, and calls a missing field what it is', () => {
        const summary = { ...fixtureSummary(), ending: undefined };
        render(<SummaryPane story={{ ...fixtureStory(), summary_locked: false }} summary={summary} />);

        expect(screen.getByText('A flooded city keeps its memory in a sealed cathedral of data.')).toBeTruthy();
        expect(screen.getByText('Close third, present tense, spare and technical; no irony.')).toBeTruthy();
        expect(screen.getByText('Tone (voice · POV · tense · register)')).toBeTruthy();
        expect(screen.getAllByText('not written yet').length).toBe(1);
        expect(screen.getByText('7')).toBeTruthy();
        expect(screen.getByText('Author-declared · read-only for every agent (D-3b)')).toBeTruthy();
    });

    it('does not put a chapter count on the phase-① Summary', () => {
        render(
            <SummaryPane
                story={{ ...fixtureStory(), phase: 'summary', summary_locked: false }}
                summary={{ ...fixtureSummary(), chapter_count: 3, locked: false }}
            />
        );

        expect(screen.queryByText('Chapter count')).toBeNull();
        expect(screen.queryByText('Author-declared · read-only for every agent (D-3b)')).toBeNull();
    });

    it('carries the phase-① round and reader counts, saved as one Author write', async () => {
        const calls: Array<[number, number]> = [];

        render(
            <SummaryPane
                story={{ ...fixtureStory(), summary_locked: false }}
                summary={{ ...fixtureSummary(), locked: false }}
                sampling={3}
                readers={5}
                onSetSummaryReview={(sampling, readers) => calls.push([sampling, readers])}
            />
        );

        expect(screen.getByText(/writes 3 complete Summaries per round/)).toBeTruthy();
        fireEvent.change(screen.getByLabelText('Writers per Summary round'), { target: { value: '6' } });
        fireEvent.change(screen.getByLabelText('Readers per revision'), { target: { value: '7' } });
        await click(screen.getByRole('button', { name: 'Set review counts' }));

        expect(calls).toEqual([[6, 7]]);
    });

    it('hides the counts once the Summary is locked, exactly like every other Author write (P5, L-30)', () => {
        render(<SummaryPane story={fixtureStory()} summary={fixtureSummary()} />);

        expect(screen.queryByRole('button', { name: 'Set review counts' })).toBeNull();
        expect(screen.queryByLabelText('Writers per Summary round')).toBeNull();
    });

    it('has no per-field assistant control — the directive bar is the Author’s channel', () => {
        render(
            <SummaryPane
                story={{ ...fixtureStory(), summary_locked: false }}
                summary={{ ...fixtureSummary(), locked: false }}
            />
        );

        expect(screen.queryByRole('button', { name: 'Ask assistant' })).toBeNull();
        expect(screen.getByText(/Use the directive bar below/)).toBeTruthy();
    });

    it('lists every revision flatly and lets the Author use a competing one', async () => {
        const calls: Array<[string, string]> = [];

        render(
            <SummaryPane
                story={{ ...fixtureStory(), phase: 'summary', summary_locked: false }}
                summary={{ ...fixtureSummary(), locked: false }}
                revisions={[ENTRY]}
                onSelectRevision={(unitRef, revisionId) => calls.push([unitRef, revisionId])}
            />
        );

        expect(screen.getByText('Revision 3')).toBeTruthy();
        // The field appears once on the Summary on record and once on the revision card.
        expect(screen.getAllByText('A flooded city keeps its memory in a sealed cathedral of data.').length).toBe(2);
        expect(screen.getAllByText('Close third, present tense, spare and technical; no irony.').length).toBeGreaterThan(0);
        await click(screen.getByRole('button', { name: 'Use this revision' }));
        expect(calls).toEqual([['sum1', REVISION.id]]);
    });

    it('opens one revision with only its findings', () => {
        render(
            <SummaryPane
                story={{ ...fixtureStory(), phase: 'summary', summary_locked: false }}
                summary={fixtureSummary()}
                focus={ENTRY}
            />
        );

        expect(screen.getByText('Summary — Revision 3')).toBeTruthy();
        expect(screen.getByText('The draft loses the stray')).toBeTruthy();
        expect(screen.queryByText('Summary — Phrase 1')).toBeNull();
        expect(screen.queryByText('The Summary on record')).toBeNull();
        expect(screen.queryByText(/Revisions ·/)).toBeNull();

        // The cost and the state are one unit on one line: "major confirmed", not a state
        // floated to the far edge of the row, and the state names its own colour (D-33/D-34).
        const row = screen.getByText('The draft loses the stray').closest('.find-row')!;
        const tags = row.querySelector('.find-tags')!;
        const state = row.querySelector('.find-state')!;
        expect(tags.textContent).toBe('majorconfirmed');
        expect(tags.contains(state)).toBe(true);
        expect(state.className).toContain('find-state--confirmed');
    });
});
