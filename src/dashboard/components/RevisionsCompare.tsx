// U-13 / D-21 / D-22 / D-24 — revision comparison: a unit's competing drafts side by side, with
// the verdicts and the Editor's `selection_note`.
//
// D-21 restricts the side-by-side view to the Editor and the AUTHOR — a Writer's brief never
// sees its sibling drafts — which is why this pane exists at all: it is the Author's window onto
// the divergence, and nowhere else on the screen may drafts be compared.
//
// D-22 is why the list shrinks: on selection the server deletes every non-selected revision in
// the same commit, so "watch the losers disappear" is just the next view refresh. Nothing here
// caches a draft, and nothing here pretends a discarded one is recoverable — the record is
// deleted, so v1 offers no restore (D-24's "restore from the run's own output" needs the run
// transcript surface, which the pinned contract does not have).
//
// D-24 (the Author may always override an Editor) is wired end to end: the Select calls
// `onSelectRevision`, the shell binds it to `POST /stories/:id/revisions/:revisionId/select`, and
// the server installs the named draft and deletes its siblings in ONE commit (U-13, D-22). The
// control still renders DISABLED when a host passes no callback — a pane mounted from a fixture has
// no route to call — and the tooltip says which of the two states the Author is looking at.
//
// U-13a's merge request (D-23) is on the contract and on the route (`POST /stories/:id/revisions/merge`),
// and this pane deliberately offers no control for it: the request needs the MERGE BRIEF — which half
// of which draft — and there is no prose field here to type it into. A one-click merge that sent an
// empty brief would lie about what the Author decided, so the affordance waits for the brief field
// rather than being faked (the route is exercised by the API tests meanwhile).
//
// U-13's other half — "with the verdicts" — reads the view's `verdicts` slice, not
// `revision.verdict_refs`: §6.2a files a checker's report against the draft it read, and no server
// path populates the refs on the revision row. A draft with no verdict naming it falls back to the
// unit's rows and SAYS SO, because "this draft was not read" and "no verdict names this draft" are
// different claims.
import { draftVerdicts, revisionBodyText } from './story-contract';
import type { RevisionUnit } from './story-contract';
import type { Revision, Verdict } from '../../shared/types';

/**
 * U-13's verdict block for one draft column: the §4.9 row as the record states it — hard pass/fail,
 * the recommendation, the round, and every FAILING criterion with its evidence (D-15: a failing line
 * without a citation is an invalid verdict, so the citation is the point of showing the row).
 *
 * Nothing is summarised into a score (P6), and a row filed against the UNIT is labelled as such: the
 * Author must be able to tell "the checker read this draft" from "the checker read the unit".
 */
function DraftVerdicts({ unit, revision }: { unit: RevisionUnit; revision: Revision }) {
    const { verdicts, source } = draftVerdicts(unit, revision);

    if (verdicts.length === 0) {
        return <p className="sv-revision-verdicts-none">no verdicts filed against this draft yet</p>;
    }

    return (
        <div className="sv-revision-verdicts">
            {source === 'unit' ? (
                <p className="sv-revision-verdicts-scope">
                    no verdict names this draft — these were filed against {unit.unitRef}
                </p>
            ) : null}

            {verdicts.map((verdict: Verdict) => (
                <div
                    className={`sv-revision-verdict sv-revision-verdict-${verdict.hard_pass ? 'pass' : 'fail'}`}
                    key={verdict.id}
                >
                    <span
                        className="sv-revision-verdict-state"
                        aria-label={verdict.hard_pass ? 'hard pass' : 'hard fail'}
                    >
                        {verdict.hard_pass ? 'hard pass' : 'hard fail'}
                    </span>
                    <span className="sv-revision-verdict-id">
                        {verdict.id} · {verdict.target_kind} · round {verdict.round}
                    </span>
                    <span className="sv-revision-verdict-recommendation">recommends {verdict.recommendation}</span>

                    {/* D-15: only the failures carry the evidence that matters; a pass needs no defence. */}
                    {verdict.criteria_passed
                        .filter((line) => !line.result)
                        .map((line) => (
                            <p className="sv-revision-verdict-failure" key={line.criterion}>
                                {line.criterion} failing — {line.evidence}
                                {line.finding_ref ? ` (finding ${line.finding_ref})` : ''}
                            </p>
                        ))}
                </div>
            ))}
        </div>
    );
}

export interface RevisionsCompareProps {
    /** One entry per unit; the unit's label is already resolved to the artifact's human title. */
    units: RevisionUnit[];
    onSelectRevision?: (unitRef: string, revisionId: string) => void;
    /** Caller-supplied context, e.g. "3 competing drafts — the unit cannot advance (D-23)". */
    note?: string;
}

export function RevisionsCompare({ units, onSelectRevision, note }: RevisionsCompareProps) {
    if (units.length === 0) {
        return null;
    }

    return (
        <section className="sv-pane sv-revisions" aria-label="Revision comparison">
            <header className="sv-pane-head">
                <h3 className="sv-pane-title">Revisions — side by side, the Editor&apos;s view (D-21)</h3>
                <span className="sv-pane-badge">
                    the losers are deleted in the selection commit; the note survives (D-22)
                </span>
            </header>

            {note ? <p className="sv-revisions-note">{note}</p> : null}

            {units.map((unit) => (
                <div className="sv-revision-unit" key={unit.unitRef}>
                    <h4 className="sv-revision-unit-title">
                        {unit.label} · {unit.revisions.length} draft{unit.revisions.length === 1 ? '' : 's'} (
                        {unit.unitKind})
                    </h4>

                    {/* U-13: literal columns, so the comparison is spatial, not a list to scroll through. */}
                    <div className="sv-revision-cols">
                        {unit.revisions.map((revision) => (
                            <div className={`sv-revision-col sv-revision-${revision.state}`} key={revision.id}>
                                <div className="sv-revision-head">
                                    <span className={`sv-revision-state sv-revision-state-${revision.state}`}>
                                        {revision.state}
                                    </span>
                                    {revision.template_ref ? (
                                        <span className="sv-revision-template">{revision.template_ref}</span>
                                    ) : null}
                                    {revision.run_ref ? (
                                        <span className="sv-revision-run">run {revision.run_ref}</span>
                                    ) : null}
                                </div>

                                {/* U-13/D-21: the judgement that goes with THIS draft, from the §4.9 rows
                                    the view carries. A draft with no verdict of its own falls back to the
                                    unit's rows, labelled — the two conventions §8.3 produces. */}
                                <DraftVerdicts unit={unit} revision={revision} />

                                <pre className="sv-revision-body">{revisionBodyText(revision.body)}</pre>

                                {revision.selection_note ? (
                                    // T-2a / L-17: the note names the rule applied and what each draft was
                                    // preferred for — the only window the Author has onto automated taste.
                                    <p className="sv-revision-note">selection note — {revision.selection_note}</p>
                                ) : null}

                                <button
                                    type="button"
                                    className="sv-revision-select"
                                    disabled={!onSelectRevision}
                                    // The control is only disabled when the HOST passed no callback — the
                                    // route exists, so this is a mounting question, not a missing endpoint.
                                    title={
                                        onSelectRevision
                                            ? 'Override the Editor and take this draft (D-24)'
                                            : 'This pane was mounted without a selection callback, so the Author cannot choose from here (D-24)'
                                    }
                                    onClick={() => onSelectRevision?.(unit.unitRef, revision.id)}
                                >
                                    Select this draft
                                </button>
                            </div>
                        ))}
                    </div>
                </div>
            ))}

            <p className="sv-revisions-hint">
                A discarded draft is not restorable in this view: the selection commit deletes it hard (D-22), and
                D-24&apos;s restore needs the run&apos;s own output, which lands with the run-transcript endpoint.
            </p>
        </section>
    );
}
