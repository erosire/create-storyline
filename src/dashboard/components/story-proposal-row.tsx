// U-5 / D-20 — one agent proposal, rendered as a DIFF against the current text.
//
// U-5 is explicit: "inline accept/reject per proposal, with the `why` and the run that made it,
// and undo. A diff, not a replaced paragraph." The diff is the whole point — the Author is
// deciding about a span, not trusting a replacement — and P11 requires the run and the `why` to
// ride with it, because every change has to be attributable.
//
// D-20: proposals are the agent→Author direction ONLY. The Author's own edits never pass through
// here (D-20a) — they are direct writes made from a pause (D-37).
import { useState } from 'react';
import { diffWords, patchOf } from './story-contract';
import type { Proposal } from '../../shared/types';

export interface ProposalRowProps {
    proposal: Proposal;
    /** The text the proposal is against — the current section, so the diff is honest. */
    currentText: string;
    /** Human label for the span the patch targets (a section id renders as an id, a chapter title does not). */
    targetLabel?: string;
    onAccept?: (proposalId: string) => Promise<unknown> | unknown;
    onReject?: (proposalId: string) => Promise<unknown> | unknown;
    /** P11 / D-20a: accepting is undoable, and Undo is offered right there. */
    onUndo?: (input: { targetRef: string; runRef?: string | null }) => Promise<unknown> | unknown;
}

export function ProposalRow({ proposal, currentText, targetLabel, onAccept, onReject, onUndo }: ProposalRowProps) {
    // `decided` is local UI state, not a second source of truth: it exists so Undo can appear
    // immediately after Accept, before the next view refresh re-renders the proposal as accepted.
    const [decided, setDecided] = useState<'accepted' | 'rejected' | null>(null);
    const [error, setError] = useState<string | null>(null);

    const { sectionId, text } = patchOf(proposal.patch);
    const segments = diffWords(currentText, text);

    const run = async (action?: () => Promise<unknown> | unknown, mark?: 'accepted' | 'rejected'): Promise<void> => {
        if (!action) {
            return;
        }
        try {
            setError(null);
            await action();
            if (mark) {
                setDecided(mark);
            }
        } catch (cause) {
            // T-1a: the server refuses by naming the rule, and the refusal is the Author's information.
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    };

    return (
        <li className={`sv-proposal sv-proposal-${decided ?? proposal.state}`} key={proposal.id}>
            <div className="sv-proposal-head">
                <span className="sv-proposal-state">{decided ?? proposal.state}</span>
                <span className="sv-proposal-target">{targetLabel ?? proposal.target_field}</span>
                {sectionId ? <span className="sv-proposal-section">section {sectionId}</span> : null}
                {/* P11: every change names the run that made it. */}
                {proposal.run_ref ? <span className="sv-proposal-run">run {proposal.run_ref}</span> : null}
            </div>

            {/* U-5: the diff, in spans — never a paragraph swapped in silently. */}
            <p className="sv-proposal-diff" aria-label="proposed change">
                {segments.map((segment, index) => (
                    <span key={index} className={`sv-diff sv-diff-${segment.kind}`}>
                        {segment.kind === 'removed'
                            ? `[-${segment.text}-]`
                            : segment.kind === 'added'
                              ? `{+${segment.text}+}`
                              : segment.text}
                    </span>
                ))}
            </p>

            {/* D-20/T-5: `why` is mandatory on every write, so it is never an optional garnish here. */}
            <p className="sv-proposal-why">why — {proposal.why}</p>

            <div className="sv-proposal-actions">
                {/* The handlers speak the route shape (`(storyId, proposalId)`, curried by the caller),
                    so the row hands over only its own id and `run` stays a zero-arg thunk. */}
                <button
                    type="button"
                    className="sv-proposal-accept"
                    disabled={!onAccept || decided !== null}
                    onClick={() => void run(() => onAccept?.(proposal.id), 'accepted')}
                >
                    Accept
                </button>
                <button
                    type="button"
                    className="sv-proposal-reject"
                    disabled={!onReject || decided !== null}
                    onClick={() => void run(() => onReject?.(proposal.id), 'rejected')}
                >
                    Reject
                </button>
                {decided === 'accepted' ? (
                    // U-5: undo, offered right where the decision was made.
                    <button
                        type="button"
                        className="sv-proposal-undo"
                        disabled={!onUndo}
                        onClick={() =>
                            void run(() =>
                                onUndo?.({ targetRef: proposal.target_ref, runRef: proposal.run_ref ?? null })
                            )
                        }
                    >
                        Undo
                    </button>
                ) : null}
            </div>

            {error ? <p className="sv-proposal-error">{error}</p> : null}
        </li>
    );
}
