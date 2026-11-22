// U-4 / U-16 — the Summary pane (phase ①'s artifact).
//
// PHASE ① IS A FLAT REVISION HISTORY. The Writer writes `summary_sampling` (three) complete
// Summaries per round. The Readers critique every draft, the Editor keeps one, and the two it
// did not keep are parked as `discarded` history — not deleted. The next round writes three
// more from the kept text, so the rail reads Revision 1 … Revision N.
//
// The pane shows the Summary on record, the review counts, and every revision. Opening one
// revision from the rail shows exactly that revision and the findings filed against it.
import { useEffect, useState } from 'react';
import { ConfirmButton } from './story-phase-controls';
import {
    DEFAULT_SUMMARY_READERS,
    DEFAULT_SUMMARY_SAMPLING,
    SUMMARY_REVIEW_LIMIT,
    type Revision,
    type Story,
    type Summary
} from '../../shared/types';
import type { BacktrackTarget } from './story-contract';
import type { SummaryRevisionEntry } from './story-nav';

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
    /** Every Summary revision, oldest first. The rail's Revision 1…N and this list agree. */
    revisions?: SummaryRevisionEntry[];
    /** The revision the rail has open; the pane renders only that one. */
    focus?: SummaryRevisionEntry;
    /** The draft whose newest verdict recommends `advance`, if any. */
    recommendedRevisionId?: string;
    /** U-13 / D-24 — the Author's pick among the competing revisions. */
    onSelectRevision?: (unitRef: string, revisionId: string) => void;
    /** U-4 — the Summary's round is finished and the Author may sign it. */
    readyForReview?: boolean;
    /** Phase ①'s two counts (the Author's settings): Writer samples per round and Readers per sample. */
    sampling?: number;
    readers?: number;
    /** Saves both counts in one Author write; absent means the control states the gap. */
    onSetSummaryReview?: (sampling: number, readers: number) => void;
    onBacktrack?: (phase: BacktrackTarget) => void;
    backtrackNote?: string;
}

/** A count input is only meaningful inside the API's own bound. */
function countValue(raw: string, fallback: number): number {
    const value = Number.parseInt(raw, 10);

    if (!Number.isFinite(value)) return fallback;

    return Math.min(SUMMARY_REVIEW_LIMIT, Math.max(1, value));
}

/**
 * One revision's prose fields. A revision is a complete Summary on disk, but an older draft may
 * carry only the fields it changed; the Summary on record is the honest fallback, so the pane
 * never renders "not written yet" over a field the selected text still has.
 */
function revisionFields(
    revision: Revision,
    summary?: Summary | null
): Array<{ key: keyof Summary; label: string; value: string; inherited: boolean }> {
    const body = revision.body;
    const record =
        body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    const nested = record.fields;
    const source =
        nested && typeof nested === 'object' && !Array.isArray(nested)
            ? (nested as Record<string, unknown>)
            : record;

    return SUMMARY_FIELDS.map(({ key, label }) => {
        const own = source[key];
        const fallback = summary?.[key];

        if (typeof own === 'string' && own.trim().length > 0) {
            return { key, label, value: own, inherited: false };
        }

        if (typeof fallback === 'string' && fallback.trim().length > 0) {
            return { key, label, value: fallback, inherited: true };
        }

        return { key, label, value: 'not written yet', inherited: false };
    });
}

/** The findings filed against ONE revision — never the story-wide Findings folder. */
function RevisionFindingList({ entry }: { entry: SummaryRevisionEntry }) {
    if (entry.findings.length === 0) {
        return <p className="sv-summary-focus-empty">No Reader findings on this revision yet.</p>;
    }

    return (
        <ul className="find-list">
            {entry.findings.map((finding) => (
                <li className={`find-row find-row--${finding.cost}`} key={finding.id}>
                    <div className="find-head">
                        <span className={`sv-finding-cost sv-cost-${finding.cost}`}>{finding.cost}</span>
                        <span className="find-title">{finding.title}</span>
                        <span className="find-state">{finding.state}</span>
                    </div>
                    <p className="find-meta">
                        {finding.criterion_ref} · on this revision ({finding.id})
                    </p>
                    {finding.detail ? <p className="find-detail">{finding.detail}</p> : null}
                    <p className="find-evidence">evidence — {finding.evidence}</p>
                </li>
            ))}
        </ul>
    );
}

/** Fields + state, shared by the revision card and the opened revision. */
function RevisionFields({ revision, summary }: { revision: Revision; summary?: Summary | null }) {
    return (
        <dl className="sv-summary-draft-fields">
            {revisionFields(revision, summary).map(({ key, label, value, inherited }) => (
                <div className="sv-summary-draft-field" key={key}>
                    <dt>
                        {label}
                        {inherited ? <span className="sv-summary-inherited"> · from the Summary on record</span> : null}
                    </dt>
                    <dd>{value}</dd>
                </div>
            ))}
        </dl>
    );
}

/** One revision in the flat history. Discarded is history, not deletion. */
function RevisionCard({
    entry,
    summary,
    recommended,
    onSelectRevision
}: {
    entry: SummaryRevisionEntry;
    summary?: Summary | null;
    recommended: boolean;
    onSelectRevision?: (unitRef: string, revisionId: string) => void;
}) {
    const { revision } = entry;
    const competing = revision.state === 'competing';

    return (
        <article
            className={`sv-summary-draft${recommended ? ' sv-summary-draft--recommended' : ''}`}
            data-recommended={recommended ? 'true' : 'false'}
            data-state={revision.state}
        >
            <header className="sv-summary-draft-head">
                <span className="sv-summary-draft-label">Revision {entry.index}</span>
                <span className="sv-summary-draft-meta">
                    {revision.state} · {entry.findings.length} finding{entry.findings.length === 1 ? '' : 's'}
                </span>
                {recommended ? <span className="sv-summary-draft-pick">Editor recommends</span> : null}
            </header>

            <RevisionFields revision={revision} summary={summary} />

            {revision.selection_note ? (
                <p className="sv-summary-draft-note">{revision.selection_note}</p>
            ) : null}

            <button
                type="button"
                className="sv-summary-draft-select"
                disabled={!competing || !onSelectRevision || !summary}
                title={
                    competing
                        ? 'Make this revision the Summary. The other drafts stay as discarded history.'
                        : `This revision is ${revision.state}.`
                }
                onClick={() => summary && onSelectRevision?.(summary.id, revision.id)}
            >
                {competing ? 'Use this revision' : revision.state === 'selected' ? 'Selected' : 'Discarded'}
            </button>
        </article>
    );
}

/** The content area when the rail has one Revision open. */
function SummaryRevisionPane({ entry, summary }: { entry: SummaryRevisionEntry; summary?: Summary | null }) {
    const title = `Summary — Revision ${entry.index}`;

    return (
        <section className="sv-pane sv-summary sv-summary-overview-pane" aria-label={title}>
            <header className="sv-pane-head">
                <h3 className="sv-pane-title">{title}</h3>
                <span className="sv-pane-badge">
                    {entry.revision.state} · {entry.findings.length} finding
                    {entry.findings.length === 1 ? '' : 's'}
                </span>
            </header>

            <RevisionFields revision={entry.revision} summary={summary} />

            {entry.editorNote ? (
                <p className="sv-summary-draft-note">
                    Editor’s note on this revision: {entry.editorNote.note}
                </p>
            ) : null}

            <section className="sv-summary-focus-list" aria-label={`Revision ${entry.index} findings`}>
                <h4 className="sv-summary-current-title">Findings · {entry.findings.length}</h4>
                <RevisionFindingList entry={entry} />
            </section>

            {entry.editorVerdicts.length > 0 ? (
                <ul className="sv-summary-focus-rows">
                    {entry.editorVerdicts.map((verdict) => (
                        <li className="sv-summary-focus-row" key={verdict.id}>
                            <span className="sv-summary-focus-title">
                                {verdict.hard_pass ? 'hard pass' : 'failing'} · {verdict.recommendation}
                            </span>
                            <span className="sv-summary-focus-meta">
                                {verdict.id} · {verdict.target_ref}
                            </span>
                        </li>
                    ))}
                </ul>
            ) : null}
        </section>
    );
}

export function SummaryPane({
    story,
    summary,
    revisions = [],
    focus,
    recommendedRevisionId,
    onSelectRevision,
    readyForReview,
    sampling,
    readers,
    onSetSummaryReview,
    onBacktrack,
    backtrackNote
}: SummaryPaneProps) {
    const locked = story.summary_locked;
    const standardSampling = sampling ?? story.summary_sampling ?? DEFAULT_SUMMARY_SAMPLING;
    const standardReaders = readers ?? story.summary_readers ?? DEFAULT_SUMMARY_READERS;
    const [samplingDraft, setSamplingDraft] = useState(String(standardSampling));
    const [readersDraft, setReadersDraft] = useState(String(standardReaders));

    // The pane is reused when the rail moves between Stories, and a save/refetch moves the props:
    // the inputs follow the record rather than keeping a dead story's draft in the field.
    useEffect(() => {
        setSamplingDraft(String(standardSampling));
    }, [story.id, standardSampling]);
    useEffect(() => {
        setReadersDraft(String(standardReaders));
    }, [story.id, standardReaders]);

    if (focus) return <SummaryRevisionPane entry={focus} summary={summary} />;

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
                <span className="sv-pane-badge">
                    {locked
                        ? 'locked — read-only for every agent (P5, L-30)'
                        : 'unlocked — the Writer may still revise it (D-3)'}
                </span>
            </header>

            {!locked ? (
                <section className="sv-summary-review-dials" aria-label="Summary review dials">
                    <p className="sv-summary-review-dials-hint">
                        Phase ① writes {DEFAULT_SUMMARY_SAMPLING} complete Summaries per round. The Readers critique
                        each draft; the Editor keeps one and discards the rest. Both counts are yours.
                    </p>
                    <label className="sv-summary-review-count">
                        <span>Writers per Summary round</span>
                        <input
                            type="number"
                            min={1}
                            max={SUMMARY_REVIEW_LIMIT}
                            value={samplingDraft}
                            onChange={(event) => setSamplingDraft(event.target.value)}
                        />
                    </label>
                    <label className="sv-summary-review-count">
                        <span>Readers per revision</span>
                        <input
                            type="number"
                            min={1}
                            max={SUMMARY_REVIEW_LIMIT}
                            value={readersDraft}
                            onChange={(event) => setReadersDraft(event.target.value)}
                        />
                    </label>
                    <button
                        type="button"
                        className="sv-summary-review-save"
                        disabled={!onSetSummaryReview}
                        title={
                            onSetSummaryReview
                                ? 'Set how many complete Summaries each round writes and how many Readers critique each one (D-17d, D-38a).'
                                : 'The Story patch route is not available in this shell.'
                        }
                        onClick={() =>
                            onSetSummaryReview?.(
                                countValue(samplingDraft, standardSampling),
                                countValue(readersDraft, standardReaders)
                            )
                        }
                    >
                        Set review counts
                    </button>
                </section>
            ) : null}

            <h4 className="sv-summary-current-title">The Summary on record</h4>

            <dl className="sv-summary-fields">
                {story.phase === 'summary' ? null : (
                    <div className="sv-summary-field">
                        <dt>Chapter count</dt>
                        <dd className="sv-summary-value">
                            {summary ? summary.chapter_count : '—'}
                            <span className="sv-summary-flag">Author-declared · read-only for every agent (D-3b)</span>
                        </dd>
                    </div>
                )}

                {SUMMARY_FIELDS.map(({ key, label }) => {
                    const value = summary?.[key];
                    const text = typeof value === 'string' ? value : '';

                    return (
                        <div className="sv-summary-field" key={key}>
                            <dt>{label}</dt>
                            <dd className="sv-summary-value">
                                <span className="sv-summary-text">{text || 'not written yet'}</span>
                            </dd>
                        </div>
                    );
                })}
            </dl>

            <section className="sv-summary-revisions" aria-label="Summary revisions">
                <h4 className="sv-summary-current-title">
                    Revisions · {revisions.length}
                </h4>
                {revisions.length === 0 ? (
                    <p className="sv-summary-focus-empty">No Summary revision has landed yet.</p>
                ) : (
                    <div className="sv-summary-drafts">
                        {revisions.map((entry) => (
                            <RevisionCard
                                key={entry.revision.id}
                                entry={entry}
                                summary={summary}
                                recommended={entry.revision.id === recommendedRevisionId}
                                onSelectRevision={onSelectRevision}
                            />
                        ))}
                    </div>
                )}
            </section>

            {!locked ? (
                <p className="sv-summary-note">
                    This pane is read-only in v1: the pinned API has no Author summary write, so the Writer expands
                    it (D-3). Use the directive bar below to tell the Editor what to change here; it reviews the
                    direction and updates the Summary.
                </p>
            ) : (
                <p className="sv-summary-note">
                    There is no other way to change a locked Summary: an agent write is refused naming P5, and the
                    only move is a Backtrack (D-3, L-30, L-31).
                </p>
            )}

            {locked ? (
                <footer className="sv-summary-actions">
                    <ConfirmButton
                        className="sv-backtrack-button"
                        label="Backtrack"
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
