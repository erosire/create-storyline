// U-4 / U-16 — the Summary pane (phase ①'s artifact).
//
// WHY IT IS READ-ONLY IN v1: U-4 lets the Author edit the Summary while phase ① is unlocked, but
// the pinned client contract has NO summary-write method — its author verbs are `editSection`
// (chapter prose, D-37) and the goal/template/idea/proposal set. The pane therefore renders every
// field read-only and states the gap. The Author's way to change it is the directive bar at the
// foot of the content: viewing the Summary labels that bar "Summary → Editor", and the Editor
// reviews the direction and updates the Summary in focus (D-19).
//
// Once locked, D-3/L-30 make the pane read-only for every agent and the only way in is the
// Author's Backtrack, so the pane says that on the pane (U-16: "the UI should say so on every
// locked pane") and offers the Backtrack control.
import { ConfirmButton } from './story-phase-controls';
import type { BacktrackTarget, RevisionUnit } from './story-contract';
import type { Revision, Story, Summary } from '../../shared/types';

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
    /** U-13 / D-24 — the competing overviews, already grouped by unit. */
    unit?: RevisionUnit;
    /** The draft whose newest verdict recommends `advance`, if any (see `recommendedRevisionId`). */
    recommendedRevisionId?: string;
    /** U-13 / D-24 — the Author's pick among the overviews. */
    onSelectRevision?: (unitRef: string, revisionId: string) => void;
    /** U-4 — the Summary's goal has passed (or it is signed): the phase is ready for review. */
    readyForReview?: boolean;
}

/** One Summary draft as the Author reads it: its own prose fields, never the whole book. */
function overviewFields(revision: Revision): Array<{ key: keyof Summary; label: string; value: string }> {
    const body = revision.body;

    return SUMMARY_FIELDS.map(({ key, label }) => {
        const source =
            body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
        const value = source[key];

        return {
            key,
            label,
            value: typeof value === 'string' && value.trim().length > 0 ? value : 'not written yet'
        };
    });
}

function OverviewCandidates({
    unit,
    recommendedRevisionId,
    onSelectRevision
}: {
    unit: RevisionUnit;
    recommendedRevisionId?: string;
    onSelectRevision?: (unitRef: string, revisionId: string) => void;
}) {
    const recommended = unit.revisions.find((revision) => revision.id === recommendedRevisionId);

    return (
        <section className="sv-summary-review" aria-label="Overview candidates">
            <header className="sv-summary-review-head">
                <h4 className="sv-summary-review-title">Overview — the drafts the crew wrote</h4>
                <p className="sv-summary-review-hint">
                    {unit.revisions.length === 1
                        ? 'One overview is waiting for the Author.'
                        : `${unit.revisions.length} overviews are waiting. Take the one the latest verdict advances, or choose another.`}
                    {recommended ? '' : ' No verdict has recommended one yet.'}
                </p>
            </header>

            <div className="sv-summary-drafts">
                {unit.revisions.map((revision, index) => {
                    const isRecommended = revision.id === recommendedRevisionId;

                    return (
                        <article
                            className={`sv-summary-draft${isRecommended ? ' sv-summary-draft--recommended' : ''}`}
                            key={revision.id}
                            data-recommended={isRecommended ? 'true' : 'false'}
                        >
                            <header className="sv-summary-draft-head">
                                <span className="sv-summary-draft-label">Overview {index + 1}</span>
                                {isRecommended ? (
                                    <span className="sv-summary-draft-pick">Editor recommends</span>
                                ) : null}
                                {revision.template_ref ? (
                                    <span className="sv-summary-draft-meta">{revision.template_ref}</span>
                                ) : null}
                            </header>

                            <dl className="sv-summary-draft-fields">
                                {overviewFields(revision).map(({ key, label, value }) => (
                                    <div className="sv-summary-draft-field" key={key}>
                                        <dt>{label}</dt>
                                        <dd>{value}</dd>
                                    </div>
                                ))}
                            </dl>

                            {revision.selection_note ? (
                                <p className="sv-summary-draft-note">{revision.selection_note}</p>
                            ) : null}

                            <button
                                type="button"
                                className="sv-summary-draft-select"
                                disabled={!onSelectRevision}
                                title={
                                    onSelectRevision
                                        ? 'Install this overview as the Summary. The other drafts are deleted in the same commit (D-22).'
                                        : 'The selection route has not landed yet.'
                                }
                                onClick={() => onSelectRevision?.(unit.unitRef, revision.id)}
                            >
                                {isRecommended ? 'Take the recommended overview' : 'Choose this overview'}
                            </button>
                        </article>
                    );
                })}
            </div>
        </section>
    );
}

export function SummaryPane({
    story,
    summary,
    onBacktrack,
    backtrackNote,
    unit,
    recommendedRevisionId,
    onSelectRevision,
    readyForReview
}: SummaryPaneProps) {
    const locked = story.summary_locked;

    return (
        <section className={`sv-pane sv-summary${locked ? ' sv-pane-locked' : ''}`} aria-label="Summary">
            <header className="sv-pane-head">
                <h3 className="sv-pane-title">Summary — Phrase 1</h3>
                {readyForReview ? (
                    <span className="sv-summary-ready" title="ready for review">
                        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                            <path
                                d="M3.2 8.4 6.4 11.6 12.8 5.2"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            />
                        </svg>
                        ready for review
                    </span>
                ) : null}
                {/* L-7a mirrors the flag onto the record; the pane reads the Story's flag (L-7). */}
                <span className="sv-pane-badge">
                    {locked
                        ? 'locked — read-only for every agent (P5, L-30)'
                        : 'unlocked — the Writer may still expand it (D-3)'}
                </span>
            </header>

            {unit && unit.revisions.length > 0 ? (
                <OverviewCandidates
                    unit={unit}
                    recommendedRevisionId={recommendedRevisionId}
                    onSelectRevision={onSelectRevision}
                />
            ) : null}

            {!locked ? (
                <p className="sv-summary-note">
                    {/* The honest statement of the v1 gap: no Author summary write in the pinned contract. */}
                    This pane is read-only in v1: the pinned API has no Author summary write, so the Writer expands it
                    (D-3). Use the directive bar below to tell the Editor what to change here; it reviews the direction
                    and updates the Summary. The Author&apos;s own editing surface is the chapter prose editor (U-17).
                </p>
            ) : (
                <p className="sv-summary-note">
                    {/* U-16: every locked pane states that Backtrack is the only way in. */}
                    There is no other way to change a locked Summary: an agent write is refused naming P5, and the only
                    move is a Backtrack (D-3, L-30, L-31).
                </p>
            )}

            <h4 className="sv-summary-current-title">The Summary on record</h4>

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
