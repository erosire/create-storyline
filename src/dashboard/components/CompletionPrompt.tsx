// U-14 / §6.9 — Completion is a proposal, and the prompt is where the Author accepts it with
// their eyes open.
//
// L-25b is the load-bearing rule: completion does NOT require an empty findings list, so what
// the UI owes the Author is the count of what accepting throws away — "47 findings and 12 Ideas
// will be closed without action, the oldest from chapter 2". A green tick the machine gave
// itself is not information, and neither is a to-do list quietly emptied.
import { completionDiscardSentence } from './story-contract';
import type { CompletionPreview } from './story-contract';
import type { Story } from '../../shared/types';

export interface CompletionPromptProps {
    preview: CompletionPreview;
    story: Story;
    /**
     * L-25 makes a clean ledger part of what makes completion worth accepting. The pinned view
     * carries no `ledger` collection, so the server's one-line ledger state is passed in when
     * the caller has it and the row is simply absent when it does not.
     */
    ledgerState?: string;
    onAccept?: (storyId: string) => void;
}

export function CompletionPrompt({ preview, story, ledgerState, onAccept }: CompletionPromptProps) {
    return (
        // L-25b: the count is kept as a record afterwards, so the sentence is the acceptance text,
        // not a tooltip.
        <section className="sv-pane sv-completion" aria-label="Completion proposal">
            <header className="sv-pane-head">
                <h3 className="sv-pane-title">The crew proposes the book is done</h3>
                {/* L-37a: drained is the loop stopping; this panel is the Author closing it. */}
                <span className="sv-pane-badge">
                    the loop stopped looking for work — it is the Author who completes it (L-26)
                </span>
            </header>

            <dl className="sv-completion-facts">
                <div className="sv-completion-fact">
                    <dt>Passing levels</dt>
                    {/* G-2: the server's own level sentence, never a percentage. */}
                    <dd>{story.consistency || 'no levels measured yet'}</dd>
                </div>
                {ledgerState ? (
                    <div className="sv-completion-fact">
                        <dt>Ledger</dt>
                        <dd>{ledgerState}</dd>
                    </div>
                ) : null}
                <div className="sv-completion-fact">
                    <dt>Trend</dt>
                    <dd>{story.trend}</dd>
                </div>
            </dl>

            {/* THE sentence (L-25b / U-14). */}
            <p className="sv-completion-discard">{completionDiscardSentence(preview)}</p>

            <button
                type="button"
                className="sv-completion-accept"
                disabled={!onAccept}
                title={
                    onAccept
                        ? 'Accept completion: the chapters lock as the other phases did (L-25a)'
                        : 'The completion endpoint has not landed yet.'
                }
                onClick={() => onAccept?.(story.id)}
            >
                Accept completion
            </button>
        </section>
    );
}
