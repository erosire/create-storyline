// Decision item 17 — the cost distribution block.
//
// D-34a makes the Editor's triage final with no appeal step, and the brief's whole concern is
// that the only symptom of a systematically soft Editor is a book that drains too early and
// reads thin. Decision 17's answer is a NUMBER, not a queue: how many findings the Editor
// confirmed at each cost, and how many it downgraded. The Author sees the pattern in one glance
// and tunes the template (G-7) instead of re-refuting the same call forty times.
import { FINDING_COSTS } from '../../shared/types';
import type { CostDistribution } from './story-contract';

export interface CostDistributionProps {
    distribution: CostDistribution;
    /** The window the counts cover, stated by the server so the block never implies "all time". */
    windowLabel?: string;
}

export function CostDistributionPanel({ distribution, windowLabel = 'the last rounds' }: CostDistributionProps) {
    // A `critical` column of 0 next to a fat `taste` column is the soft-Editor signature; the
    // downgrades figure is what makes it a finding rather than a hunch.
    const downgrades = distribution.downgrades;

    return (
        <section className="sv-pane sv-cost" aria-label="Cost distribution">
            <header className="sv-pane-head">
                <h3 className="sv-pane-title">Cost distribution — {windowLabel}</h3>
                {/* D-34a: this is the only check on a triage that cannot be appealed. */}
                <span className="sv-pane-badge">the only check on a triage with no appeal (D-34a, decision 17)</span>
            </header>

            <ul className="sv-cost-stats">
                {FINDING_COSTS.map((cost) => (
                    <li className="sv-cost-stat" key={cost}>
                        <span className="sv-cost-cost">{cost}</span>
                        <span className="sv-cost-count">{distribution.confirmed_per_cost[cost] ?? 0}</span>
                        <span className="sv-cost-note">confirmed at {cost}</span>
                    </li>
                ))}
                <li className={`sv-cost-stat sv-cost-downgrades${downgrades > 0 ? ' sv-cost-warn' : ''}`}>
                    <span className="sv-cost-cost">downgrades</span>
                    <span className="sv-cost-count">{downgrades}</span>
                    {/* A downgrade is an Editor moving a finding to a cheaper cost as it confirms it (D-34). */}
                    <span className="sv-cost-note">findings the Editor moved to a cheaper cost</span>
                </li>
            </ul>

            {downgrades > 0 ? (
                <p className="sv-cost-hint">
                    If this number keeps climbing while `critical` stays at 0, the Editor is filing every alarm as a
                    whisper — edit its template, do not re-review the findings (G-7).
                </p>
            ) : null}
        </section>
    );
}
