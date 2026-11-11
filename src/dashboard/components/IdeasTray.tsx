// U-15 / D-27 / D-29 / D-32 / D-36 — the Ideas tray.
//
// The tray holds every UNDECIDED Idea of the current phase, above a collapsed list of what has
// already been decided. The decided list is not decoration (D-32): it is the only reason the
// next amnesiac Reader does not propose the same thing again, so a re-raise is shown as the
// repeat badge it is, with the earlier decision attached.
//
// D-27 is the interaction rule: the Author selects among VERIFIED Ideas first, and an unverified
// one cannot be selected without an explicit "I know". So the dimming is not aesthetic — it is
// the gate, and the gate is a confirm, not a disabled button (the Author outranks the Editor,
// D-24's principle applied one level down).
//
// D-36: the tray is phase-scoped and empties at the lock, which is why the tray count doubles as
// the lock gate (L-7a) and is stated here.
import { useState } from 'react';
import { earlierDecisionOf, isDecidedIdea, isVerifiedIdea } from './story-contract';
import { PHASE_LABELS } from './story-contract';
import type { Idea, StoryPhase } from '../../shared/types';

/** Verified Ideas sort first — D-27: "the Author selects among verified Ideas first". */
function trayOrder(a: Idea, b: Idea): number {
    const verifiedDelta = Number(isVerifiedIdea(b)) - Number(isVerifiedIdea(a));
    if (verifiedDelta !== 0) {
        return verifiedDelta;
    }
    // A repeated claim is more urgent than a fresh one: the crew is arguing in circles (D-32).
    return b.seen_count - a.seen_count;
}

export interface IdeasTrayProps {
    ideas: Idea[];
    phase: StoryPhase;
    onSelect?: (ideaId: string) => void;
    onDiscard?: (ideaId: string) => void;
    onDefer?: (ideaId: string) => void;
}

export function IdeasTray({ ideas, phase, onSelect, onDiscard, onDefer }: IdeasTrayProps) {
    // D-27's "I know" confirm is per-Idea, and only ever armed for an unverified one.
    const [confirmId, setConfirmId] = useState<string | null>(null);

    // Phase-scoped (D-36): a phase's tray is that phase's workspace, nothing else's.
    const inPhase = ideas.filter((idea) => idea.phase === phase);
    const open = inPhase.filter((idea) => !isDecidedIdea(idea)).sort(trayOrder);
    const decided = inPhase.filter(isDecidedIdea);

    const select = (idea: Idea): void => {
        if (!isVerifiedIdea(idea) && confirmId !== idea.id) {
            // D-27: unverified, and the Author has not said "I know" yet.
            setConfirmId(idea.id);
            return;
        }
        setConfirmId(null);
        onSelect?.(idea.id);
    };

    return (
        <section className={`sv-pane sv-ideas${open.length > 0 ? ' sv-ideas-open' : ''}`} aria-label="Ideas tray">
            <header className="sv-pane-head">
                <h3 className="sv-pane-title">
                    Ideas — {PHASE_LABELS[phase]} tray · <span className="sv-ideas-count">{open.length}</span> open
                </h3>
                {/* L-7a: the tray count is the lock gate, so it belongs on the tray. */}
                <span className="sv-pane-badge">
                    {open.length > 0
                        ? 'the phase cannot be locked while the tray is non-empty (L-7a) · locking empties it (D-36)'
                        : 'tray empty — the phase can be locked (L-7a)'}
                </span>
            </header>

            {inPhase.length === 0 ? (
                // D-28: an empty tray is a thin crew, never a clean one.
                <p className="sv-ideas-thin">
                    No Ideas filed this phase — that reads as a thin crew, not a clean one (D-28).
                </p>
            ) : null}

            <ul className="sv-ideas-tray">
                {open.map((idea) => {
                    const verified = isVerifiedIdea(idea);
                    // D-32: a repeat of a DECIDED Idea is reported with the earlier decision attached.
                    const earlier = earlierDecisionOf(idea, ideas);

                    return (
                        <li className={`sv-idea${verified ? ' sv-idea-verified' : ' sv-idea-dim'}`} key={idea.id}>
                            <div className="sv-idea-head">
                                <span className="sv-idea-kind">{idea.kind}</span>
                                <span className="sv-idea-author">filed by {idea.author}</span>
                                {idea.unit_ref ? <span className="sv-idea-unit">on {idea.unit_ref}</span> : null}
                                {idea.seen_count > 1 ? (
                                    // D-32: the crew is re-raising a settled point; that is a template signal (G-7).
                                    <span className="sv-idea-repeat">{idea.seen_count}× seen — repeat (D-32)</span>
                                ) : null}
                                {/* D-27's verdict badge: verified · refuted · unverifiable, or awaiting a check. */}
                                <span
                                    className={`sv-idea-verdict sv-idea-verdict-${idea.verification?.verdict ?? 'pending'}`}
                                >
                                    {idea.verification ? idea.verification.verdict : 'awaiting an Editor (D-27)'}
                                </span>
                            </div>

                            <p className="sv-idea-body">{idea.body}</p>

                            {idea.sources.length > 0 ? (
                                <ul className="sv-idea-sources">
                                    {idea.sources.map((source) => (
                                        // T-10: a citation names the source, the specific claim, and when it was read.
                                        <li className="sv-idea-source" key={`${idea.id}-${source.url_or_title}`}>
                                            <span className="sv-idea-source-title">{source.url_or_title}</span>
                                            <span className="sv-idea-source-claim">{source.claim}</span>
                                            <span className="sv-idea-source-date">accessed {source.accessed_at}</span>
                                        </li>
                                    ))}
                                </ul>
                            ) : null}

                            {idea.verification ? (
                                <div className="sv-idea-verify">
                                    {/* D-27: the verdict without the evidence is a shrug, so the evidence rides with it. */}
                                    <p className="sv-idea-evidence">
                                        Editor&apos;s evidence — {idea.verification.evidence}
                                    </p>
                                    {/* D-31: two independent answers — is it true, and does THIS Author want it. */}
                                    <p className="sv-idea-guidelines">
                                        {idea.verification.meets_guidelines
                                            ? 'fits your guidelines — criteria, tone, world rules, selection_rules (D-31)'
                                            : 'against your guidelines, even if it is true (D-31)'}
                                    </p>
                                </div>
                            ) : null}

                            {earlier ? (
                                <p className="sv-idea-earlier">
                                    Already decided: {earlier.state}
                                    {earlier.selection_note ? ` — ${earlier.selection_note}` : ''} (D-32)
                                </p>
                            ) : null}

                            <div className="sv-idea-actions">
                                <button
                                    type="button"
                                    className="sv-idea-select"
                                    disabled={!onSelect}
                                    // D-27: the reason the dimming exists.
                                    title={
                                        verified
                                            ? "Select — this becomes the next Writer's brief (D-29)"
                                            : 'Unverified — the Editor has not returned `verified` (D-27)'
                                    }
                                    onClick={() => select(idea)}
                                >
                                    Select
                                </button>
                                <button
                                    type="button"
                                    className="sv-idea-discard"
                                    disabled={!onDiscard}
                                    onClick={() => onDiscard?.(idea.id)}
                                >
                                    Discard
                                </button>
                                <button
                                    type="button"
                                    className="sv-idea-defer"
                                    disabled={!onDefer}
                                    onClick={() => onDefer?.(idea.id)}
                                >
                                    Defer
                                </button>
                            </div>

                            {confirmId === idea.id ? (
                                // D-27: the explicit "I know". A confirm, not a hard block — the Author outranks the Editor.
                                <p className="sv-idea-confirm" role="alert">
                                    Unverified: no Editor has returned `verified` with evidence (D-27, C-15). Select it
                                    anyway?
                                    <button type="button" className="sv-idea-confirm-yes" onClick={() => select(idea)}>
                                        I know
                                    </button>
                                    <button
                                        type="button"
                                        className="sv-idea-confirm-no"
                                        onClick={() => setConfirmId(null)}
                                    >
                                        Cancel
                                    </button>
                                </p>
                            ) : null}
                        </li>
                    );
                })}
            </ul>

            {decided.length > 0 ? (
                // U-15: decided ideas live BELOW the tray, collapsed, and stay readable for the rest
                // of the phase (D-28) — they are the memory, not the workspace.
                <details className="sv-ideas-decided">
                    <summary>
                        {decided.length} decided — selected · discarded · deferred, with the note that decided it (D-32)
                    </summary>
                    <ul className="sv-ideas-decided-list">
                        {decided.map((idea) => (
                            <li className={`sv-idea-decided sv-idea-decided-${idea.state}`} key={idea.id}>
                                <span className="sv-idea-decided-state">{idea.state}</span>
                                <span className="sv-idea-body">{idea.body}</span>
                                {/* D-29 / D-32: the decision is a record, and the record is what the next brief carries. */}
                                {idea.selection_note ? (
                                    <span className="sv-idea-note">{idea.selection_note}</span>
                                ) : null}
                                {idea.absorbed_into ? (
                                    <span className="sv-idea-absorbed">absorbed into {idea.absorbed_into} (D-29)</span>
                                ) : null}
                                {idea.seen_count > 1 ? (
                                    <span className="sv-idea-repeat">{idea.seen_count}× seen (D-32)</span>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                </details>
            ) : null}
        </section>
    );
}
