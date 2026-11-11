// Decision 17 / D-34a — the cost distribution block.
//
// The Editor's triage is final, with no appeal step, so the only check on a systematically soft
// Editor is this number: what it confirmed at each cost, and how much it moved to a cheaper cost.
// A queue of re-refuted findings is loop engineering aimed at the machine; this block is the same
// information aimed at the Author.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CostDistributionPanel } from './story-cost-distribution';
import { fixtureCostDistribution } from './story-fixtures';

function stats(): Array<[string, string]> {
    return Array.from(document.querySelectorAll<HTMLElement>('.sv-cost-stat')).map((stat) => [
        stat.querySelector('.sv-cost-cost')!.textContent!,
        stat.querySelector('.sv-cost-count')!.textContent!
    ]);
}

describe('CostDistributionPanel — the number behind a triage with no appeal (decision 17, D-34a)', () => {
    it('counts confirmations per cost and the downgrades, in the fixed cost order', () => {
        render(<CostDistributionPanel distribution={fixtureCostDistribution()} />);

        // The window is named, or the block would imply "all time" (E-1's honesty).
        expect(screen.getByText('Cost distribution — the last rounds')).toBeTruthy();
        expect(stats()).toEqual([
            ['critical', '0'],
            ['major', '4'],
            ['minor', '9'],
            ['taste', '12'],
            ['downgrades', '11']
        ]);
        expect(screen.getByText('the only check on a triage with no appeal (D-34a, decision 17)')).toBeTruthy();
        expect(screen.getByText('findings the Editor moved to a cheaper cost')).toBeTruthy();

        // The signature of a soft Editor: a fat `taste` column beside an empty `critical` one.
        expect(
            screen.getByText(
                'If this number keeps climbing while `critical` stays at 0, the Editor is filing every alarm as a whisper — edit its template, do not re-review the findings (G-7).'
            )
        ).toBeTruthy();
        expect((document.querySelector('.sv-cost-downgrades') as HTMLElement).className).toContain('sv-cost-warn');
    });

    it('states the server\u2019s window when it supplies one, and goes quiet when there is nothing to warn about', () => {
        render(
            <CostDistributionPanel
                distribution={{ confirmed_per_cost: { critical: 3, major: 2, minor: 1, taste: 0 }, downgrades: 0 }}
                windowLabel="the current phase"
            />
        );

        expect(screen.getByText('Cost distribution — the current phase')).toBeTruthy();
        expect(stats()).toEqual([
            ['critical', '3'],
            ['major', '2'],
            ['minor', '1'],
            ['taste', '0'],
            ['downgrades', '0']
        ]);
        // A zero downgrade count is not a warning, and the pane does not claim one.
        expect(document.querySelector('.sv-cost-hint')).toBeNull();
        expect((document.querySelector('.sv-cost-downgrades') as HTMLElement).className).not.toContain('sv-cost-warn');
    });

    it('renders a cost the server never reported as zero, never as a missing row', () => {
        render(
            <CostDistributionPanel distribution={{ confirmed_per_cost: { critical: 1 } as never, downgrades: 2 }} />
        );

        // The four costs are the fixed list (§4.1 `auto_approve` doubles as the dial), so a partial
        // record still renders four rows — the Author never sees a silent omission.
        expect(stats()).toEqual([
            ['critical', '1'],
            ['major', '0'],
            ['minor', '0'],
            ['taste', '0'],
            ['downgrades', '2']
        ]);
    });
});
