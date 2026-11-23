// U-4 / U-16 — the Summary pane (phase ①'s artifact).
//
// PHASE ① IS A FLAT REVISION HISTORY. The Writer writes `summary_sampling` (three) complete
// Summaries per round. The Readers critique every draft, and the round settles by the engine's
// DETERMINISTIC selection — fewest critical, then fewest high, then fewest total, then earliest
// (§6.5, §16.6, D-47) — not by an Editor picking a column. The drafts it did not keep are parked as
// `discarded` history, never deleted. The next round writes more from the kept text, so the rail
// reads Revision 1 … Revision N.
//
// The pane shows the Summary on record, the review counts, and the ONE revision the record names (R1 —
// the drafts a round parked as `discarded` history, the ones still competing, and every OLDER round's
// `selected` row are all kept out of this list; the rail still is the record of every version tried).
// Opening one revision from the rail shows exactly that revision and the findings filed against it,
// parked drafts included, and that is where a discard reason is read — and, T4, where a candidate the
// contract still offers (`story-nav.summaryRevisionUnit`) carries the review's recommendation and the
// Author's "Use Revision" (U-13, D-24), because R1 leaves the overview holding only the accepted row.
import { useEffect, useState } from 'react';
import { ConfirmButton } from './story-phase-controls';
import {
    DEFAULT_SUMMARY_READERS,
    DEFAULT_SUMMARY_SAMPLING,
    SUMMARY_REVIEW_LIMIT,
    type Finding,
    type Revision,
    type RevisionState,
    type Story,
    type StoryPhase,
    type Summary
} from '../../shared/types';
import { isReviewableRevision, type BacktrackTarget, type FindingRevisionScope } from './story-contract';
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
    /** Every Summary revision, oldest first. The rail's Revision 1…N and this list agree; the pane's own card
     *  list is NOT a subset of it (R1) — it is the one row `onRecordRevisionId` names. The whole list is still
     *  passed because the empty state has to tell "nothing has landed" from "nothing is on record". */
    revisions?: SummaryRevisionEntry[];
    /**
     * R1: the id of the Summary revision currently ON RECORD — the only card the ordinary (non-focused)
     * pane may print.
     *
     * `StoryView` passes `story-contract.selectedSummaryRevision(view)?.id`: the newest `state: 'selected'`
     * row of this Summary (`created_at`, then id). Several rounds leave several `selected` rows on the
     * record (story-contract.ts:522-530), which is exactly the reported screenshot — "Revisions · 9" with
     * Revision 1 AND Revision 4 both marked selected, because the old state filter admitted every one of them.
     *
     * It is deliberately NOT `view.sampling.selected.revision_id`: the Author's override (§6.6) moves the
     * row's state without appending a sampling history entry, so that field can still name a draft the
     * record no longer carries.
     *
     * Absent means NOTHING is accepted. The pane then shows its empty state; falling back to the live
     * drafts would be the very thing R1's "only" forbids.
     */
    onRecordRevisionId?: string;
    /** The revision the rail has open; the pane renders only that one. */
    focus?: SummaryRevisionEntry;
    /**
     * T4: whether the Author may take the FOCUSED revision — the existing U-13 / D-24 override
     * (`POST /stories/:id/revisions/:revisionId/select`), no new route or lifecycle.
     *
     * `StoryView` passes membership of `story-nav.summaryRevisionUnit(view)`, the contract's own candidate
     * list: `isReviewableRevision` MINUS `isSupersededSummaryDraft` (story-nav.ts:128-141, and the very list
     * `server/loop/phase1-round-parity.test.ts` pins as the Author's override). So a `drafted` row an OLDER
     * round already lost stays disabled even though the rail can open it — the flag widens nothing.
     *
     * It exists because R1 moved the candidates out of the overview: the rail-opened revision is the only
     * Summary surface that can print one, and without the action the override would have no Summary UI at
     * all. The row's own state remains the second gate, so `pending`, `selected`, `discarded` and
     * `merged_into` can never gain an enabled Select.
     */
    focusSelectable?: boolean;
    /**
     * The draft whose newest verdict recommends `advance`, if any — the advisory marks ONE row.
     *
     * T4: it lands on the FOCUSED revision when that is the draft the verdict advanced.
     * `story-nav.recommendedRevisionId` reads it out of `summaryRevisionUnit`'s candidates, and R1 keeps
     * candidates out of the overview, so in real wiring an overview card is never the recommended row.
     */
    recommendedRevisionId?: string;
    /**
     * U-13 / D-24 — the Author's pick among the competing revisions: `onSelectRevision(summaryId, revisionId)`.
     * T4 puts the control on the rail-opened candidate, since R1 leaves the overview with only the accepted row.
     */
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

/**
 * The scope line of one listed finding (T11/F6). `story-nav.summaryRevisions` decides the scope once
 * (`findingRevisionScope`) and ships it on the entry, so this is a read, not a second guess; the
 * fallback only covers a hand-built entry, and it reads the refs the same way — a row naming no draft is
 * a statement about the Summary as a whole, and calling that "on this revision" on every card would put
 * one sentence under six different drafts.
 */
function findingScopeLabel(entry: SummaryRevisionEntry, finding: Finding): string {
    const related = finding.related_refs ?? [];
    const scope: FindingRevisionScope = entry.findingScopes?.[finding.id] ?? (related.length === 0 ? 'artifact' : 'selected');

    // Only the whole-artifact answer changes the sentence: a row naming a draft IS about this revision.
    return scope === 'artifact' ? 'about the Summary as a whole' : 'on this revision';
}

/**
 * The advisory that marks the draft whose newest verdict advances (U-13, D-21).
 *
 * T11/F5: in PHASE ① this is a reading of the round's own review, not an Editor's choice — the round
 * settles by the engine's deterministic counts (fewest critical → fewest high → fewest total → earliest,
 * §6.5, §16.6, D-47), and labelling the mark "Editor recommends" named a decision phase ① never makes
 * (the same half of the reported contradiction the rail chip and the lock's copy already dropped).
 * Later phases really do have an Editor applying `selection_rules` (§16.8), so their copy is untouched.
 */
const recommendationLabel = (phase: StoryPhase): string =>
    phase === 'summary' ? 'Review recommends' : 'Editor recommends';

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
                        {/* The cost and where the finding stands read as one unit: the badge says what
                            it costs, the state says what has happened to it (D-33/D-34). */}
                        <span className="find-tags">
                            <span className={`sv-finding-cost sv-cost-${finding.cost}`}>{finding.cost}</span>
                            <span className={`find-state find-state--${finding.state}`}>{finding.state}</span>
                        </span>
                        <span className="find-title">{finding.title}</span>
                    </div>
                    {/* T11/F6: the scope sentence is the SAME decision the gate made, so a whole-Summary
                        critique is not claimed by every revision card it is listed on. */}
                    <p className="find-meta">
                        {finding.criterion_ref} · {findingScopeLabel(entry, finding)} ({finding.id})
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

/**
 * What a disabled control calls a row it cannot take: the row's own §4.15 state, spelt as a word — the same
 * fact its `title` spells out in a sentence. Parked states never reach it; they print as plain text.
 */
const stateLabel = (state: RevisionState): string => state.charAt(0).toUpperCase() + state.slice(1);

/**
 * The Author's override on ONE Summary revision (U-13, D-24) — `POST /stories/:id/revisions/:revisionId/select`.
 *
 * One component serves both surfaces so the label, the reason a row cannot be taken, and the
 * `(summaryId, revisionId)` callback signature cannot drift between them:
 *   - the overview card — R1 makes that row the one ON RECORD, so the button renders disabled as
 *     "Selected": the pane may not ask the Author to re-take a decision the round already settled;
 *   - the revision the rail opens (T4) — with every candidate out of the overview, this is the only Summary
 *     surface left that can print a `drafted`/`competing` draft, so the override lives here. Without it the
 *     Author's override (and the review's recommendation of it) would have no Summary UI at all.
 *
 * `offered` is the CALLER's authority (see `SummaryPaneProps.focusSelectable`), and the row's own state is
 * the second gate: §4.15 says only a reviewable draft may be taken. A `pending` block is still being
 * written — a Shortcut that installed half a Summary would blank the blocks it has not reached — and the
 * accepted row is a settled fact, so each keeps its disabled button, labelled with the state it is. Parked
 * history is not a control at all: it returns before the button, as plain text naming the state.
 */
function RevisionSelectAction({
    entry,
    summary,
    offered,
    onSelectRevision
}: {
    entry: SummaryRevisionEntry;
    summary?: Summary | null;
    /** Whether this surface invites the Author to take the row. The row's state still has to allow it. */
    offered: boolean;
    onSelectRevision?: (unitRef: string, revisionId: string) => void;
}) {
    const { revision } = entry;
    const selectable = offered && isReviewableRevision(revision);

    // A parked row is a settled fact, never a move the Author still has: `discarded`/`merged_into` print the
    // state as plain red TEXT, not as a dead-looking control — the header shows a button only where clicking
    // it would write something. Its real detail, the reason it was parked, is printed above it in the
    // focused view.
    if (revision.state === 'discarded' || revision.state === 'merged_into') {
        return <span className="sv-summary-draft-parked">Discarded</span>;
    }

    return (
        <button
            type="button"
            className="sv-summary-draft-select"
            disabled={!selectable || !onSelectRevision || !summary}
            title={
                selectable
                    ? 'Make this revision the Summary. The other drafts stay as discarded history.'
                    : `This revision is ${revision.state}.`
            }
            onClick={() => summary && onSelectRevision?.(summary.id, revision.id)}
        >
            {selectable ? 'Use Revision' : stateLabel(revision.state)}
        </button>
    );
}

/** The one revision the record names, printed as a card. Live drafts and parked history never reach it (R1). */
function RevisionCard({
    entry,
    summary,
    recommended,
    phase,
    onSelectRevision
}: {
    entry: SummaryRevisionEntry;
    summary?: Summary | null;
    recommended: boolean;
    /** Whose judgement the advisory names: phase ①'s review, or a later phase's Editor (T11/F5). */
    phase: StoryPhase;
    onSelectRevision?: (unitRef: string, revisionId: string) => void;
}) {
    const { revision } = entry;

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
                {recommended ? (
                    <span className="sv-summary-draft-pick">{recommendationLabel(phase)}</span>
                ) : null}
            </header>

            <RevisionFields revision={revision} summary={summary} />

            {revision.selection_note ? (
                <p className="sv-summary-draft-note">{revision.selection_note}</p>
            ) : null}

            {/* R1: no discard reason is printed here. `story-nav.ts:330` derives `discardReason` ONLY while
                the row's state is `discarded`, and only the row ON RECORD reaches this card, so the paragraph
                would be dead copy over a list that cannot contain one. The reason is still readable —
                `SummaryRevisionPane` prints it for the revision the rail has open (T4/R1). */}
            <RevisionSelectAction entry={entry} summary={summary} offered onSelectRevision={onSelectRevision} />
        </article>
    );
}

/**
 * The content area when the rail has one Revision open.
 *
 * T4: the Author's override and the review's recommendation of a candidate live HERE. R1 keeps every
 * candidate out of the overview — which is right for "what IS the Summary now" — so the revision the Author
 * explicitly opens from the unchanged rail is the one place a competing draft can be read AND taken. The
 * advisory is the same `recommendedRevisionId` the overview card used, and it marks only the row it names.
 * Nothing else about the opened row moves: fields, the Editor's note, the discard reason, its findings and
 * its verdict rows are exactly what this pane printed before.
 */
function SummaryRevisionPane({
    entry,
    summary,
    recommended,
    phase,
    selectable,
    onSelectRevision
}: {
    entry: SummaryRevisionEntry;
    summary?: Summary | null;
    /** Whether the review's/Editor's advisory names THIS row — a mark for one revision, never for all (T4). */
    recommended: boolean;
    /** Whose judgement the advisory names: phase ①'s review, or a later phase's Editor (T11/F5). */
    phase: StoryPhase;
    /** The contract's own answer on whether the Author may take this row (see `focusSelectable`). */
    selectable: boolean;
    onSelectRevision?: (unitRef: string, revisionId: string) => void;
}) {
    const title = `Summary — Revision ${entry.index}`;

    return (
        <section className="sv-pane sv-summary sv-summary-overview-pane" aria-label={title}>
            <header className="sv-pane-head">
                <h3 className="sv-pane-title">{title}</h3>
                <span className="sv-pane-badge">
                    {entry.revision.state} · {entry.findings.length} finding
                    {entry.findings.length === 1 ? '' : 's'}
                </span>
                {recommended ? <span className="sv-summary-draft-pick">{recommendationLabel(phase)}</span> : null}
                <RevisionSelectAction
                    entry={entry}
                    summary={summary}
                    offered={selectable}
                    onSelectRevision={onSelectRevision}
                />
            </header>

            <RevisionFields revision={entry.revision} summary={summary} />

            {entry.editorNote ? (
                <p className="sv-summary-draft-note">
                    Editor’s note on this revision: {entry.editorNote.note}
                </p>
            ) : null}

            {/* T4/R1: the opened revision says WHY it was discarded, in neutral wording. Never "Editor's
                discard reason" — phase ① parks a draft by the deterministic selector (§16.6, D-47), so no
                Editor made this call and the pane may not claim one. Absent `discardReason` renders
                nothing, which is the legacy-row contract: mark the state, do not invent an explanation. */}
            {entry.discardReason ? (
                <p className="sv-summary-draft-note">Discard reason: {entry.discardReason}</p>
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
    onRecordRevisionId,
    focus,
    focusSelectable = false,
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

    // The rail's one-revision view short-circuits the overview, and it is NOT filtered: a `discarded`
    // draft is still selectable in the rail, and opening it here must keep rendering its fields and its
    // `Discard reason:` line (T4/R1) — hiding parked history from the card LIST never hides it from the record.
    //
    // T4: this view also carries the recommendation mark (when it names THIS row) and the Author's override,
    // because R1 left it as the only Summary surface that can print a candidate. `focusSelectable` is the
    // caller's authority; `RevisionSelectAction` still refuses any row whose own state is not reviewable.
    if (focus) {
        return (
            <SummaryRevisionPane
                entry={focus}
                summary={summary}
                recommended={focus.revision.id === recommendedRevisionId}
                phase={story.phase}
                selectable={focusSelectable}
                onSelectRevision={onSelectRevision}
            />
        );
    }

    // R1 — "selecting Summary displays only the latest accepted revision that is actively being worked upon".
    //
    // The reported defect (the screenshot): the pane printed EVERY row the record still carried, so with two
    // rounds on the Story it read "Revisions · 9" with Revision 1 AND Revision 4 both marked `selected` — one
    // `selected` row per round is normal (story-contract.ts:522-530), and the old state filter admitted every
    // one of them plus the live `drafted`/`competing`/`pending` work. The overview answers one question — what
    // IS the Summary now — so it prints the ONE row `story-contract.selectedSummaryRevision` names, which is
    // the same authority `summaryBlockingFindings` and the Accept gate read (story-contract.ts:531-545). The
    // cut is an id, not a state, so an older round's `selected` row cannot sneak back in beside it.
    //
    // The filter belongs HERE, in the overview-card branch, and NOT in `story-nav.summaryRevisions`: that one
    // list also feeds the rail, `summaryRevisionFocus`, the readiness tick and the lock's blocker count, so
    // filtering there would delete superseded and parked drafts from the sidebar and make them unselectable.
    // History stays selectable in the rail; its fields and its `Discard reason:` line are the FOCUS pane's job
    // (the short-circuit above).
    //
    // Nothing on record means NOTHING is printed: the live drafts are real work, but falling back to them is
    // the fallback R1 rules out, so the id-less case (and an id whose row a refetch dropped) takes the empty
    // state below.
    const current =
        onRecordRevisionId === undefined ? [] : revisions.filter((entry) => entry.revision.id === onRecordRevisionId);

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
                        each draft, and the round settles by itself: the engine keeps the draft with the fewest
                        findings — fewest critical, then fewest high, then fewest total, then the earliest sample
                        (§6.5, §16.6) — and parks the rest as discarded history. No Editor picks a column in phase ①.
                        Both counts are yours.
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
                {/* R1: the count is the count of CARDS rendered — the row on record, so at most 1 — not the
                    length of the revision record. The rail beside it still keeps the full Revision 1…N. */}
                <h4 className="sv-summary-current-title">
                    Revisions · {current.length}
                </h4>
                {current.length === 0 ? (
                    // Two different empties, and the pane says which one it is. Nothing has landed is the
                    // round-not-run case; a Story whose revision record holds only superseded, parked or
                    // still-live drafts must NOT claim nothing landed (the history is in the rail) and must
                    // NOT fall back to printing those drafts as cards either — that fallback is precisely
                    // what R1's "only the latest accepted revision" rules out. So the pane says what is
                    // true: nothing is on record, and the rail still opens every row for its detail.
                    <p className="sv-summary-focus-empty">
                        {revisions.length === 0
                            ? 'No Summary revision has landed yet.'
                            : 'No current Summary revision.'}
                    </p>
                ) : (
                    <div className="sv-summary-drafts">
                        {current.map((entry) => (
                            <RevisionCard
                                key={entry.revision.id}
                                entry={entry}
                                summary={summary}
                                phase={story.phase}
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
