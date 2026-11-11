// U-16 / L-32 — the two biggest controls on the Story view, plus the confirmation primitive
// they share.
//
// Lock states in one line what becomes read-only, and is disabled unless the phase's Goal has
// passed AND the Ideas tray is empty (L-7a); the disabled state names the blocker, because a
// greyed button with no reason leaves the Author guessing at the machine's rules.
//
// Backtrack states in one line what gets DELETED and asks once. L-32 forbids offering it as
// "revert to an earlier draft", so the confirm line is generated from the live record counts
// (`backtrackStatement` in `story-contract`), never from a static string.
import { useState } from 'react';
import { PHASE_LABELS, PHASE_ORDER, backtrackStatement, lockCheck, phasesAfter } from './story-contract';
import type { BacktrackTarget, LockCheck, StoryActions, StoryViewData } from './story-contract';
import type { Story, StoryPhase } from '../../shared/types';

/**
 * The ask-once button: the first click swaps the control for the destructive sentence plus a
 * confirm pair, and nothing is sent until the second click. An inline confirm rather than
 * `window.confirm` because the sentence has to be readable, styled, and assertable (L-32).
 */
export function ConfirmButton({
    className,
    label,
    confirmText,
    onConfirm,
    disabled,
    disabledReason
}: {
    className: string;
    label: string;
    confirmText: string;
    onConfirm?: () => void;
    disabled?: boolean;
    disabledReason?: string;
}) {
    const [asking, setAsking] = useState(false);

    if (asking) {
        return (
            <span className={`${className}-confirm`}>
                {/* L-32: the confirmation names exactly what will be deleted. */}
                <span className="sv-confirm-text">{confirmText}</span>
                <button
                    type="button"
                    className="sv-confirm-yes"
                    onClick={() => {
                        setAsking(false);
                        onConfirm?.();
                    }}
                >
                    Confirm
                </button>
                <button type="button" className="sv-confirm-no" onClick={() => setAsking(false)}>
                    Cancel
                </button>
            </span>
        );
    }

    return (
        <button
            type="button"
            className={className}
            // A control whose endpoint has not landed is disabled too, and `disabledReason` says so.
            disabled={disabled || !onConfirm}
            // U-16: a disabled control must state why.
            title={disabled ? disabledReason : confirmText}
            onClick={() => setAsking(true)}
        >
            {label}
        </button>
    );
}

/** §4.1 / L-25a — which lock signed which phase (phase ③'s lock IS `completed`). */
function phaseLocksFor(story: Story): Record<StoryPhase, boolean> {
    return { summary: story.summary_locked, plotlines: story.plotlines_locked, chapters: story.status === 'completed' };
}

/**
 * The phases a Backtrack can retarget: only a phase the Author has actually signed, and only one
 * strictly earlier than where the Story now stands (L-31 — backtrack is the single way a lock
 * opens, and there is no going "back" to a phase that is still open).
 *
 * The predicate narrows to `BacktrackTarget` (T8's route accepts ①/② only): ③ is where the Story
 * already is, and the filter above already excludes it — TS cannot see that through `filter`, so
 * the narrowing is stated rather than cast at the call site.
 */
export function backtrackTargets(story: Story): BacktrackTarget[] {
    const locked = phaseLocksFor(story);
    const currentIndex = PHASE_ORDER.indexOf(story.phase);
    return PHASE_ORDER.filter(
        (phase): phase is BacktrackTarget =>
            phase !== 'chapters' && locked[phase] && PHASE_ORDER.indexOf(phase) < currentIndex
    );
}

export interface PhaseControlsProps {
    view: StoryViewData;
    actions: StoryActions;
    /** Optional so the gate is derived once by StoryView and passed down; recomputed if absent. */
    lock?: LockCheck;
}

export function PhaseControls({ view, actions, lock }: PhaseControlsProps) {
    const gate = lock ?? lockCheck(view);
    const { story } = view;
    const targets = backtrackTargets(story);

    return (
        <div className="sv-phase-controls">
            <div className="sv-lock-block">
                <ConfirmButton
                    className="sv-lock-button"
                    label={`Lock phase ${PHASE_LABELS[gate.phase]}`}
                    confirmText={gate.statement}
                    // U-16: enabled only when the Goal passes AND the tray is empty.
                    disabled={!gate.canLock}
                    disabledReason={`Not yet: ${gate.reasons.join(' · ')}`}
                    // Phase ③'s sign-off is completion (L-25a), and the completion endpoint is the
                    // one that discards the leftovers with a count on them (L-25b).
                    onConfirm={
                        gate.phase === 'chapters' && actions.acceptCompletion
                            ? () => void actions.acceptCompletion?.(story.id)
                            : actions.lockPhase
                              ? // §6.3a: the route locks the CURRENT phase, so the phase is not an argument —
                                // `gate.phase` IS `story.phase` here (lockCheck reads it from the record).
                                () => void actions.lockPhase?.(story.id)
                              : undefined
                    }
                />
                {/* One line stating what becomes read-only, clickable or not (U-16). */}
                <p className="sv-lock-statement">{gate.statement}</p>
                {!gate.canLock ? (
                    <ul className="sv-lock-reasons">
                        {gate.reasons.map((reason) => (
                            <li key={reason}>{reason}</li>
                        ))}
                    </ul>
                ) : null}
            </div>

            <div className="sv-backtrack-block">
                {targets.length === 0 ? (
                    <p className="sv-backtrack-none">
                        Nothing is locked yet, so there is nothing to backtrack to (L-31).
                    </p>
                ) : null}
                {targets.map((phase) => (
                    <ConfirmButton
                        key={phase}
                        className="sv-backtrack-button"
                        label={`Backtrack to ${PHASE_LABELS[phase]}`}
                        confirmText={backtrackStatement(story, phase, view)}
                        disabled={!actions.backtrack}
                        disabledReason="The backtrack endpoint has not landed yet."
                        onConfirm={() => void actions.backtrack?.(story.id, phase)}
                    />
                ))}
                {targets.length > 0 ? (
                    <p className="sv-backtrack-hint">
                        Backtrack is not undo. Each target reopens its phase from the locked artifact above it and
                        deletes everything later phases produced —{' '}
                        {targets
                            .map(
                                (phase) =>
                                    `${PHASE_LABELS[phase]}: ${phasesAfter(phase).length} later phase${phasesAfter(phase).length === 1 ? '' : 's'}`
                            )
                            .join(' · ')}{' '}
                        (D-25, L-32).
                    </p>
                ) : null}
            </div>
        </div>
    );
}
