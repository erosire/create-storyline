// U-12a — the phase strip: ① Summary · ② Plotlines · ③ Chapters, each with a lock icon when
// the Author has signed it. It is the first thing on the Story view and the Author must be able
// to read where a Story is in the pipeline from across the room, so the current phase is marked
// with `aria-current` AND a colour, never colour alone (L-34's "distinguishable at a glance").
import { PHASE_LABELS, PHASE_ORDER } from './story-contract';
import type { StoryPhase } from '../../shared/types';

export interface PhaseStripProps {
    phase: StoryPhase;
    /** Which phases are signed. Phase ③'s lock is `completed` (L-25a) — see `phaseLocks`. */
    locked: Record<StoryPhase, boolean>;
    /** Jumping between panes; absent means the strip is a pure readout. */
    onSelect?: (phase: StoryPhase) => void;
}

export function PhaseStrip({ phase, locked, onSelect }: PhaseStripProps) {
    return (
        <nav className="sv-phase-strip" aria-label="Story phases">
            {PHASE_ORDER.map((candidate) => {
                const isCurrent = candidate === phase;
                const isLocked = locked[candidate];

                return (
                    <button
                        key={candidate}
                        type="button"
                        className={`sv-phase-item${isCurrent ? ' sv-phase-current' : ''}${isLocked ? ' sv-phase-locked' : ''}`}
                        // L-31: a signed phase is read-only for every agent; the strip says so on
                        // the icon so the lock never has to be remembered.
                        title={
                            isLocked
                                ? `${PHASE_LABELS[candidate]} is signed — the only way in is a backtrack (L-31)`
                                : PHASE_LABELS[candidate]
                        }
                        aria-current={isCurrent ? 'step' : undefined}
                        disabled={!onSelect}
                        onClick={() => onSelect?.(candidate)}
                    >
                        <span className="sv-phase-name">{PHASE_LABELS[candidate]}</span>
                        {isLocked ? (
                            <span className="sv-phase-lock" role="img" aria-label={`${PHASE_LABELS[candidate]} locked`}>
                                🔒
                            </span>
                        ) : null}
                    </button>
                );
            })}
        </nav>
    );
}
