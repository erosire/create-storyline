// R5 (W2) — THE ONE READ-ONLY RENDERING OF A CHAPTER'S CONTRACT.
//
// A contract is an ORDERED list of beats, and the point of the list is its order: C-7 asks whether the prose
// delivers every beat in the order the contract lists them, and C-3/C-8 ask whether the LAST beat is a change and
// whether the prose landed it. The five prose fields this component replaced (`Must happen`, `Must change`, `POV`,
// `Setups`, `Payoffs`) printed the same contract as a form, and a form hides the one thing the rule checks —
// which beat comes last, and in what order the events run.
//
// WHY ONE COMPONENT AND NOT TWO COPIES: the classic Plotlines pane (`PlotlinesPane.tsx`, the §4.3 plotline records
// the plotline tools lock) and the chapter compare view (`PlotlineChapters.tsx`, the contract beside its prose)
// render the SAME contract to two different questions. The class names differ because the two panes have different
// density, so they come in as props; the reading rules do not, and a second copy is where the two would start
// disagreeing about what a beat is.
//
// WHAT A LEGACY ROW DOES: nothing here reads `must_change`/`pov`/`setups`/`payoffs`. `story-contract.plotlineBeatsOf`
// is the single compatibility read — `beats` when the row has them, otherwise the old `must_happen` prose recovered
// as beats (`story-contract.ts:plotlineBeatsOf`, the client mirror of the server's own rule). A row written before
// beats existed therefore still renders, as the one beat it actually stated, and the desk never claims a list the
// server never stored.
import type { Plotline } from '../../types';
import { plotlineBeatsOf, plotlineDialogueOf } from './story-contract';

export interface PlotlineContractProps {
    /** The §4.3 row, or the entry's mirror of one. */
    plotline: Plotline;
    /** The list's class: `plot-card-fields` on the Plotlines pane, `sv-plotline-fields` in the compare view. */
    contractClassName: string;
    /** The row class that goes with it: `plot-card-field` / `sv-plotline-field`. */
    fieldClassName: string;
    /** `data-testid` namespace, so a test can address THIS contract's beats without addressing the pane's. */
    testId: string;
    /** The sentence for a contract with no beats at all. Each pane's own, because the two panes are asked
     *  different questions by an empty contract: nothing to review here, nothing to expand there. */
    emptyLine: string;
}

export function PlotlineContract({
    plotline,
    contractClassName,
    fieldClassName,
    testId,
    emptyLine
}: PlotlineContractProps) {
    const beats = plotlineBeatsOf(plotline);
    const dialogue = plotlineDialogueOf(plotline);

    return (
        <dl className={contractClassName} data-testid={`${testId}-contract`}>
            <div className={fieldClassName}>
                {/* The label names the list, not the field the old form had: `Beats` is what C-7 counts. */}
                <dt>Beats</dt>
                <dd>
                    {beats.length === 0 ? (
                        // Absent is stated, not padded: an empty `<ol>` under a heading reads as a contract that
                        // exists and says nothing, which is the state C-1/C-3 call "no contract".
                        <p className="sv-contract-none" data-testid={`${testId}-beats-none`}>
                            {emptyLine}
                        </p>
                    ) : (
                        // `ol` because the order is the content — a `ul` would render the same text and drop the
                        // one fact the criterion is measured against.
                        <ol className="sv-contract-beats" data-testid={`${testId}-beats`}>
                            {beats.map((beat, index) => (
                                // The index is the beat's position IN THE CHAPTER, and the list is its only source,
                                // so an index key is the honest key here.
                                <li
                                    className="sv-contract-beat"
                                    key={`${testId}-beat-${index}`}
                                    data-testid={`${testId}-beat-${index}`}
                                >
                                    {beat}
                                </li>
                            ))}
                        </ol>
                    )}
                </dd>
            </div>

            {/* DIALOGUE IS OPTIONAL, AND ABSENT IS NOT AN EMPTY ROW. The route omits the `Important dialogue:`
                block when the list has no non-blank item (`phrase/plotpoints.ts:chapterEntryContent`), so the desk
                omits it too rather than printing a heading over nothing. */}
            {dialogue.length === 0 ? null : (
                <div className={fieldClassName}>
                    <dt>Important dialogue</dt>
                    <dd>
                        <ul className="sv-contract-dialogue" data-testid={`${testId}-dialogue`}>
                            {dialogue.map((line, index) => (
                                <li
                                    className="sv-contract-dialogue-line"
                                    key={`${testId}-dialogue-${index}`}
                                    data-testid={`${testId}-dialogue-${index}`}
                                >
                                    {line}
                                </li>
                            ))}
                        </ul>
                    </dd>
                </div>
            )}
        </dl>
    );
}

export default PlotlineContract;
