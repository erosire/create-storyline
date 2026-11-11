// U-4 / decision 0/5 / L-8 / §14 item 11 — the plotline-and-chapter pane.
//
// Every row is one chapter and ITS OWN contract, side by side, because the product is the distance
// between them (U-4, P4). With all chapters in flight together (L-8) the pane groups them by what
// the crews are doing (decision 0/5), and the one per-chapter verb worth a button is UNAPPROVE —
// keep the prose, reopen the review — which is a different verb from backtrack (item 11).
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { PlotlineChapters } from './PlotlineChapters';
import { click } from '../testing/shell-fakes';
import { fixtureActions, fixtureFindings, fixtureView } from './story-fixtures';

function renderPane(props: Partial<Parameters<typeof PlotlineChapters>[0]> = {}) {
    const { actions } = fixtureActions();
    return render(
        <PlotlineChapters
            view={fixtureView()}
            actions={actions}
            paused={false}
            liveRuns={1}
            killedRuns={0}
            {...props}
        />
    );
}

/** The activity groups in the order the pane renders them. */
function groups(): Array<{ label: string; rows: number }> {
    return Array.from(document.querySelectorAll<HTMLElement>('.sv-activity')).map((element) => ({
        label: (element.querySelector('.sv-activity-title') as HTMLElement).textContent!,
        rows: element.querySelectorAll('.sv-chapter-row').length
    }));
}

/** The row of one chapter, addressed by the title printed in its contract heading. */
function chapterRow(title: string): HTMLElement {
    const found = Array.from(document.querySelectorAll<HTMLElement>('.sv-chapter-row')).find((element) =>
        element.textContent!.includes(title)
    );
    if (!found) {
        throw new Error(`no chapter row for ${title}`);
    }
    return found;
}

describe('PlotlineChapters — the contract beside the prose (U-4, decision 0/5, L-8)', () => {
    it('groups the chapters by activity, in the fixed order, with the group heading as the sentence', () => {
        renderPane();

        expect(groups()).toEqual([
            { label: 'Contested — competing revisions await a selection (D-23) · 1', rows: 1 },
            { label: 'Awaiting a fix — approved findings and rechecks · 1', rows: 1 },
            { label: 'Drafting — the crew is writing · 1', rows: 1 },
            { label: 'Clean — done · 1', rows: 1 }
        ]);
        // L-8: the reason the grouping exists is stated on the pane, not implied.
        expect(
            screen.getByText(
                'all chapters are in flight together, so the view groups them by what the crews are doing (L-8, decision 0/5)'
            )
        ).toBeTruthy();
    });

    it('puts the contract next to the prose: must-happen, must-change, POV, setups and payoffs (U-4, P4)', () => {
        renderPane();
        const row = chapterRow('Ghost Index');

        expect(within(row).getByText('Plotline 2 — Ghost Index')).toBeTruthy();
        const fields = Array.from(row.querySelectorAll<HTMLElement>('.sv-plotline-field')).map((field) => [
            field.querySelector('dt')!.textContent,
            field.querySelector('dd')!.textContent
        ]);
        expect(fields).toEqual([
            ['Must happen (C-7)', 'The index answers in a voice that is not hers.'],
            ['Must change (C-8)', 'She stops trusting the record.'],
            ['POV', 'Hale'],
            ['Setups / payoffs (C-5)', 'her own voice in the index / the sealed stack dreams']
        ]);

        // A locked contract is propose-only (D-6), and the gap to the Summary is shown, not fixed (C-2).
        expect(within(row).getByText('plotline locked — agents propose (D-6)')).toBeTruthy();
        expect(within(row).getByText('plotline not aligned to the Summary (C-2)')).toBeTruthy();
        expect(within(row).getByText('plotline marked needs_recheck (L-11)')).toBeTruthy();
    });

    it('says plainly when a chapter has no contract to be judged against (C-1, P4)', () => {
        renderPane();

        expect(
            within(chapterRow('The Water Line')).getByText(
                'This chapter has no plotline: C-1 fails, and nothing can judge it (P4).'
            )
        ).toBeTruthy();
        expect(chapterRow('The Water Line').querySelector('.sv-plotline-fields')).toBeNull();
    });

    it('names an approved finding as queued work, with the repeat count (D-34, D-16, U-11)', () => {
        renderPane();
        const row = chapterRow('Act Two, Drowned');

        expect(
            within(row).getByText('chapter marked needs_recheck — a change somewhere else touched this one (L-11a)')
        ).toBeTruthy();
        const finding = row.querySelector('.sv-chapter-finding') as HTMLElement;
        expect(within(finding).getByText('major')).toBeTruthy();
        expect(within(finding).getByText('Act two changes nothing')).toBeTruthy();
        expect(within(finding).getByText('approved')).toBeTruthy();
        expect(within(finding).getByText('3× seen (D-16)')).toBeTruthy();
    });

    it('offers Unapprove on the finished chapter only, and it is not a backtrack (§14 item 11, L-31)', async () => {
        const { actions, calls } = fixtureActions();
        renderPane({ actions });

        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.sv-chapter-unapprove'));
        expect(buttons.length).toBe(1);
        expect(buttons[0].getAttribute('title')).toBe(
            "Keeps every word and reopens this chapter's review. A different verb from backtrack: nothing is deleted (§14 item 11)."
        );

        await click(buttons[0]);
        expect(calls.unapproveChapter).toEqual([['s1', 'c1']]);
    });

    it('shows the drafts a chapter is contested between, under the prose they belong to (U-13, D-23)', () => {
        renderPane();
        const row = chapterRow('Ghost Index');

        expect(row.querySelector('.sv-chapter-revisions')).toBeTruthy();
        expect(
            within(row).getByText('2 competing drafts — the unit cannot advance until an Editor selects (D-23, L-20)')
        ).toBeTruthy();
        // The clean chapter has no comparison block: there is nothing to choose between.
        expect(chapterRow('The Sealed Stack').querySelector('.sv-chapter-revisions')).toBeNull();
    });

    // U-10b — "approve a whole chapter's worth". The queue (U-10a) stays one-finding-at-a-time; this
    // pane is where the chapter-scale move lives, and it is offered ONLY when the chapter holds
    // `confirmed` rows, so the button is never a blind batch. L-11a's `related_refs` count as this
    // chapter's findings, which is what makes the count on the button the count the server approves.
    it('offers the chapter-scale approval on a chapter holding confirmed findings, counting the L-11a ones too (U-10b, L-11a)', async () => {
        const { actions, calls } = fixtureActions();
        const view = fixtureView();

        view.findings = [
            ...view.findings,
            // Aimed straight at c2 (`Ghost Index`), and in the queue.
            {
                ...fixtureFindings()[0],
                id: 'f-c2',
                target_ref: 'c2',
                related_refs: [],
                title: 'The index speaks first',
                state: 'confirmed'
            },
            // Raised against c3 but naming c2 — L-11a says c2 is part of its blast radius.
            {
                ...fixtureFindings()[0],
                id: 'f-c3-refs',
                target_ref: 'c3',
                related_refs: ['c2'],
                title: 'The water line repeats the opening',
                state: 'confirmed'
            }
        ];
        renderPane({ actions, view });

        const row = chapterRow('Ghost Index');

        // Both rows are listed as this chapter's findings (the L-11a one included).
        const listed = Array.from(row.querySelectorAll('.sv-chapter-finding')).map(
            (item) => (item.querySelector('.sv-finding-title') as HTMLElement).textContent
        );
        expect(listed).toEqual(['The index speaks first', 'The water line repeats the opening']);

        const button = row.querySelector('.sv-chapter-approve') as HTMLButtonElement;

        // The count is the number of CONFIRMED rows, so the Author knows the size of the click (U-10b).
        expect(button.textContent).toBe('Approve this chapter’s findings — 2');

        await click(button);
        expect(calls.approveChapterFindings).toEqual([
            ['s1', 'c2', 'approved from the chapter row by the Author (U-10b)']
        ]);
    });

    it('offers no chapter approval where nothing is confirmed — c4 only holds an approved finding (U-10b)', () => {
        renderPane();

        // `f1` is `approved` (already authorised work, D-34) and c1's is `fixed`: nothing on this
        // fixture is in the queue, so no chapter may offer a bulk approve.
        expect(document.querySelectorAll('.sv-chapter-approve').length).toBe(0);
    });
});
