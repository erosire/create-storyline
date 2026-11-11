// U-4 / U-16 — the Summary pane (phase ①'s artifact).
//
// WHY IT IS READ-ONLY IN v1 (judgment call, reported to the orchestrator): U-4 lets the Author
// edit the Summary while phase ① is unlocked, but the pinned client contract T8 and T9 were
// given has NO summary-write method — its author verbs are `editSection` (chapter prose, D-37)
// and the goal/template/idea/proposal set. Inventing an endpoint would break against T8's
// `api.ts`, so the pane renders every field read-only, keeps U-4's **"Ask assistant"**
// affordance (which is what §8.6 actually describes: an Author-invoked run with write rights on
// ONE Summary field, for one run), and states the gap on the pane. The Author's own typing
// surface in v1 is the chapter prose editor (U-17).
//
// Once locked, D-3/L-30 make the pane read-only for every agent and the only way in is the
// Author's Backtrack — so the pane says that, on the pane (U-16: "the UI should say so on every
// locked pane"), and offers the same Ask-assistant affordance for the one thing the Author
// cannot do themselves.
import { ConfirmButton } from './story-phase-controls';
import type { BacktrackTarget } from './story-contract';
import type { Story, Summary } from '../../shared/types';

/** §4.2's prose fields, in the order the Writer fills them. `chapter_count` is excluded: D-3b makes it Author truth, never prose. */
const SUMMARY_FIELDS: Array<{ key: keyof Summary; label: string }> = [
    { key: 'premise', label: 'Premise' },
    { key: 'promise', label: 'Promise' },
    { key: 'theme', label: 'Theme' },
    // `tone` is the sheet C-12/C-13 are graded against (G-3a), so its label names what it is for.
    { key: 'tone', label: 'Tone (voice · POV · tense · register)' },
    { key: 'ending', label: 'Ending' },
    { key: 'world_rules', label: 'World rules' }
];

export interface SummaryPaneProps {
    story: Story;
    summary?: Summary | null;
    /**
     * The pane's own Backtrack (U-4). The sentence naming the deletions comes from the caller.
     * Typed as `BacktrackTarget` (①/②) because ③ is the phase the Story is already in — there is
     * no backtrack to a phase that has not been locked yet (L-31).
     */
    onBacktrack?: (phase: BacktrackTarget) => void;
    backtrackNote?: string;
    /** §8.6: an assistant run on ONE field. Absent until the API grows it — then the button is disabled and says so. */
    onAskAssistant?: (field: string) => void;
}

export function SummaryPane({ story, summary, onBacktrack, backtrackNote, onAskAssistant }: SummaryPaneProps) {
    const locked = story.summary_locked;

    return (
        <section className={`sv-pane sv-summary${locked ? ' sv-pane-locked' : ''}`} aria-label="Summary">
            <header className="sv-pane-head">
                <h3 className="sv-pane-title">Summary — phase ①&apos;s artifact</h3>
                {/* L-7a mirrors the flag onto the record; the pane reads the Story's flag (L-7). */}
                <span className="sv-pane-badge">
                    {locked
                        ? 'locked — read-only for every agent (P5, L-30)'
                        : 'unlocked — the Writer may still expand it (D-3)'}
                </span>
            </header>

            {!locked ? (
                <p className="sv-summary-note">
                    {/* The honest statement of the v1 gap: no Author summary write in the pinned contract. */}
                    This pane is read-only in v1: the pinned API has no Author summary write, so the Writer expands it
                    (D-3) and Ask assistant (§8.6) is the one field-level route in. The Author&apos;s own editing
                    surface is the chapter prose editor (U-17).
                </p>
            ) : (
                <p className="sv-summary-note">
                    {/* U-16: every locked pane states that Backtrack is the only way in. */}
                    There is no other way to change a locked Summary: an agent write is refused naming P5, and the only
                    move is a Backtrack (D-3, L-30, L-31).
                </p>
            )}

            <dl className="sv-summary-fields">
                <div className="sv-summary-field">
                    <dt>Chapter count</dt>
                    <dd className="sv-summary-value">
                        {summary ? summary.chapter_count : '—'}
                        <span className="sv-summary-flag">Author-declared · read-only for every agent (D-3b)</span>
                    </dd>
                </div>

                {SUMMARY_FIELDS.map(({ key, label }) => {
                    const value = summary?.[key];
                    const text = typeof value === 'string' ? value : '';

                    return (
                        <div className="sv-summary-field" key={key}>
                            <dt>{label}</dt>
                            <dd className="sv-summary-value">
                                {/* `sv-summary-text` is a plain read-only block: the pane never pretends to be a textarea it cannot save. */}
                                <span className="sv-summary-text">{text || 'not written yet'}</span>
                                {/* §8.6: one field, only when asked — hence one affordance per field, not one per pane. */}
                                <button
                                    type="button"
                                    className="sv-ask-assistant"
                                    disabled={!onAskAssistant}
                                    title={
                                        onAskAssistant
                                            ? `Ask an assistant run to change ${label} only (§8.6)`
                                            : 'Assistant runs land with the API (§8.6)'
                                    }
                                    onClick={() => onAskAssistant?.(key)}
                                >
                                    Ask assistant
                                </button>
                            </dd>
                        </div>
                    );
                })}
            </dl>

            {locked ? (
                <footer className="sv-summary-actions">
                    <ConfirmButton
                        className="sv-backtrack-button"
                        label="Backtrack"
                        // L-32: the confirm names exactly what the deletion covers.
                        confirmText={
                            backtrackNote ?? 'Backtracking to phase ① deletes everything later phases produced (D-25).'
                        }
                        disabled={!onBacktrack}
                        disabledReason="The backtrack endpoint has not landed yet."
                        onConfirm={() => onBacktrack?.('summary')}
                    />
                </footer>
            ) : null}
        </section>
    );
}
