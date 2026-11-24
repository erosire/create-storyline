// R6 / U3 — the SUMMARY PHRASE's overview pane: the compiled Overview, and the five groups' state under it.
//
// WHY A SECOND SUMMARY PANE RATHER THAN CHANGES TO `SummaryPane`. A book whose Summary is still `mode:'sampling'`
// is a round: drafts, a recommendation, the Author's pick, a discard reason. That surface is `SummaryPane.tsx`,
// and it stays exactly as it is for those books. A GROUP-managed book has no round to inspect — the Overview is
// composed from five named parts, and the Author's work is the parts. Two honest surfaces, one route each
// (`StoryView` chooses on `isGroupSummary`), so neither pane carries a branch that invents the other's model.
//
// WHAT WAS REMOVED FROM THE SUMMARY SURFACE (U3). The sampling dials, the candidate cards, the pick/merge/serve
// verbs, the reader-seat count and `Request another revision round` do not appear here at all: they were the
// machine's instrument panel, and the group loop refines on its own. The Author's remaining verbs are a direction
// to the Editor (the directive bar), one group's own revise (`SummaryGroupPane`), and the phase gate under this
// pane — which is why the gate stays: signing off the Summary is still the Author's decision, and the group
// blockers in `story-contract.groupSignOffBlockers` are what keep it from claiming the book is ready.
//
// WHY THE GROUP ROWS SIT HERE AS WELL AS IN THE RAIL. The rail's row is one title, one state word and a badge,
// because it is a control in a narrow column. This row is the desk's: the state word plus what the state is made
// of — the open findings aimed at the group, the count of superseded revisions — so the Author can read the
// book's state without opening five panes. Both read the SAME derivations from `story-contract`; neither pane
// re-decides what "open" or "blocking" means.
//
// WHY THIS PANE IS A READ. The wire has no whole-Summary prose write: every change to the Summary goes through a
// group's revise job, which the Editor replans and the Writer rewrites. So the Overview is printed here, not
// edited, and the only controls are the five rows that navigate.
import type { PhraseGroupRow } from '../api';
import type { StorySelection } from './story-nav';
import { summaryGroupRef } from './story-nav';
import type { StoryViewData } from './story-contract';
import {
    groupArchivedRevisions,
    groupBlockingFindings,
    groupOpenFindings,
    isGroupSummary,
    isGroupWriterBusy,
    isGroupWritten,
    phraseGroups,
    phraseOverview,
    phraseReadError,
    unwrittenGroups
} from './story-contract';

/**
 * The group's one state word, shared by the rail's row and this pane's row so the two can never disagree.
 *
 * WHY THERE IS NO `review_state` ON A GROUP. The phrase read carries no per-group verdict: what a group owes is
 * the findings aimed at it (R3) and whether the Writer is replacing its text right now. So the word comes from
 * those two things and from the Summary's own cost bar (`summaryBlockingCost`, the dial-aware one), in that
 * priority — a group the Writer is holding is not also "blocking", it is moving.
 */
export function groupStateLabel(
    view: StoryViewData,
    group: PhraseGroupRow
): { label: string; tone: 'blocking' | 'open' | 'done' | 'todo' | 'writer' } {
    if (isGroupWriterBusy(group)) {
        return { label: 'writer', tone: 'writer' };
    }

    if (!isGroupWritten(group)) {
        return { label: 'to write', tone: 'todo' };
    }

    // The gate's own bar: a critical/major finding open on this group holds the sign-off, so the row says
    // `blocking`. A minor or taste note is a note, and the row says `open`.
    if (groupBlockingFindings(view, group.id).length > 0) {
        return { label: 'blocking', tone: 'blocking' };
    }

    if (groupOpenFindings(view, group.id).length > 0) {
        return { label: 'open', tone: 'open' };
    }

    return { label: 'clean', tone: 'done' };
}

/**
 * One group's row: the state word, the findings aimed at it, and the count of revisions the loop has superseded.
 *
 * No archived prose (U3): `PhraseRevisionRow` carries `chars`, not text, so this row prints the COUNT and offers
 * nothing to open. The row is one button because the row IS the pane — clicking it navigates, and the group's own
 * verbs live in that pane. The Writer holding the job does not disable it: reading a group whose text is already
 * on the wire is never blocked, only editing it is (U5).
 */
function GroupRow({
    view,
    group,
    selected,
    onSelect
}: {
    view: StoryViewData;
    group: PhraseGroupRow;
    selected: boolean;
    onSelect?: (selection: StorySelection) => void;
}) {
    const state = groupStateLabel(view, group);
    const open = groupOpenFindings(view, group.id);
    const blocking = groupBlockingFindings(view, group.id);
    const archived = groupArchivedRevisions(group).length;
    const written = isGroupWritten(group);

    return (
        <li
            className={[
                'sv-group-row',
                state.tone === 'blocking' ? 'sv-group-row--blocking' : '',
                state.tone === 'todo' ? 'sv-group-row--todo' : '',
                state.tone === 'writer' ? 'sv-group-row--writer' : ''
            ]
                .filter(Boolean)
                .join(' ')}
            data-tone={state.tone}
            data-selected={selected ? 'true' : undefined}
            data-testid={`summary-group-${group.key}`}
        >
            {/* R-T2/F4 — the row IS the pane, so the selected one says so in the accessibility tree as well as
                in ink: `aria-current="true"` is the selected semantics for a control that navigates. The rail's
                own rows keep their handling untouched (F4 asks for no rail change). */}
            <button
                type="button"
                className="sv-group-row-open"
                onClick={() => onSelect?.({ panel: 'summary', ref: summaryGroupRef(group.id) })}
                aria-current={selected ? 'true' : undefined}
            >
                <span className="sv-group-row-name">{group.title}</span>
                {/* U7 — the same word boundary the rail's group rows got: an accessible name is built from
                    TEXT, and flex `gap` is not text, so without these separators the row announces
                    "Promiseblocking3 open findings". A whitespace-only text node is not a flex item, so the
                    layout is untouched. The busy span is last, so its separator is guarded; the state span
                    and the findings/quiet span always render. */}
                {' '}
                <span className="sv-group-row-state" data-tone={state.tone}>
                    {state.label}
                </span>
                {' '}
                {open.length > 0 ? (
                    <span className="sv-group-row-findings" data-testid={`summary-group-${group.key}-findings`}>
                        {`${open.length} open finding${open.length === 1 ? '' : 's'}` +
                            (blocking.length > 0 ? ' · holds the sign-off' : '')}
                    </span>
                ) : (
                    <span className="sv-group-row-quiet">
                        {/* U3: the archived COUNT, never the archived text. R-T2/F5: the count only when it is
                            worth reading — a group at its first revision has `0 archived`, which states a
                            nothing beside a row already labelled `clean`. */}
                        {!written
                            ? 'nothing written yet'
                            : archived > 0
                              ? `${archived} archived`
                              : 'nothing superseded'}
                    </span>
                )}
                {isGroupWriterBusy(group) ? (
                    <>
                        {' '}
                        <span className="sr-only">the Writer is rewriting this group now</span>
                    </>
                ) : null}
            </button>
        </li>
    );
}

export interface SummaryOverviewPaneProps {
    view: StoryViewData;
    /** The rail's selection, so the row the Author is standing on is the lit one. */
    selection?: StorySelection;
    onSelect?: (selection: StorySelection) => void;
}

export function SummaryOverviewPane({ view, selection, onSelect }: SummaryOverviewPaneProps) {
    // A defensive guard, not a branch the shell produces: `StoryView` routes a sampling book to `SummaryPane`.
    // If one ever arrives here, the honest answer is that this pane has no groups to show — five empty rows
    // would be a claim about the book that the wire never made.
    if (!isGroupSummary(view)) {
        return (
            <div className="sv-pane" data-testid="summary-overview-legacy">
                <p className="pane-state">
                    This Story&apos;s Summary is still compiled from sampling rounds, so it has no groups. The
                    round is above.
                </p>
            </div>
        );
    }

    const phrase = view.phrase;

    // U6's loading state, in one line: the phrase read is a separate route, and until it answers the desk knows
    // the book is group-managed but not what the groups hold. NOT five "unwritten" rows — an unwritten group is a
    // fact about the book, and a read that has not landed is not that fact. (The Story payload's own failure is
    // the top bar's sentence, L-13; the phrase read's failure keeps the Story payload current.)
    if (phrase === undefined || phrase === null) {
        // R-T2/F2 — PENDING AND FAILED ARE TWO DIFFERENT STATES. The store caches the phrase route's own
        // failure sentence per Story (`state.ts:phraseErrors`), so a 503 says so here instead of leaving the
        // desk promising state that will not arrive until the Story is reloaded. The Story payload is
        // unaffected — its own failure stays the top bar's sentence (L-13) — and the group rows are not
        // "unwritten", they are unread: this pane may not draw five unwritten rows over a read that failed.
        const failure = phraseReadError(view);

        if (failure !== undefined) {
            return (
                <div className="sv-pane" data-testid="summary-overview-error">
                    <p className="pane-state" data-testid="summary-read-error">
                        {`The Summary group rows could not be read: ${failure}`}
                    </p>
                    <p className="sv-group-notice sv-group-notice--warn">
                        The Story is still written as five groups, so the groups exist — the read that lists their
                        state failed. Nothing here is a verdict about the Overview; reload the Story to read the
                        groups again.
                    </p>
                </div>
            );
        }

        return (
            <div className="sv-pane" data-testid="summary-overview-pending">
                <p className="pane-state">
                    This Summary is written as five groups. Their state arrives with the phrase read — the
                    Overview above is what the Story payload has for now.
                </p>
            </div>
        );
    }

    const overview = phraseOverview(view);
    const groups = phraseGroups(view);
    const unwritten = unwrittenGroups(view);
    const review = phrase.review;

    return (
        <div className="sv-pane sv-summary sv-group-overview" data-testid="summary-overview">
            <div className="sv-pane-head">
                <h3 className="sv-pane-title">Summary</h3>
                {/* The server's own count, not a verdict this pane invented: the Overview is complete exactly when
                    every group has content (R1), and the number comes from the same read as the rows. */}
                <span className="sv-pane-badge" data-testid="summary-written">
                    {`${review.written_groups} of ${groups.length} groups written`}
                </span>
            </div>

            <p className="sv-pane-subtitle">
                The Overview the system compiled from the five groups. Each group is its own pane in the rail —
                its findings, its history and the Writer&apos;s job live there.
            </p>

            {overview ? (
                <p className="sv-summary-text" data-testid="summary-text">
                    {overview}
                </p>
            ) : (
                /* U4's purposeful empty state: why there is nothing to read, and what would fill it. */
                <p className="sv-summary-flag" data-testid="summary-empty">
                    {`No Overview yet — ${unwritten.length} of ${groups.length} groups have no content for the system to compile.`}
                </p>
            )}

            {/* One row per group, in the contract's composition order, always all five (U1). R-T2/F4: the list
                is a named region, so its rows are announced as a list of five groups rather than five loose
                buttons, and the selected row carries `aria-current` (below). */}
            <ul
                className="sv-group-rows"
                aria-label="Summary groups"
                data-testid="summary-group-rows"
            >
                {groups.map((group) => (
                    <GroupRow
                        key={group.id}
                        view={view}
                        group={group}
                        selected={selection?.ref === summaryGroupRef(group.id)}
                        onSelect={onSelect}
                    />
                ))}
            </ul>

            {unwritten.length > 0 ? (
                <p className="sv-summary-flag" data-testid="summary-unwritten">
                    {/* The engine's TITLES, not its catalog keys (`review.unwritten_groups` holds keys): the rail
                        and this sentence have to name a group the same way (U6). */}
                    {`${unwritten.length} of ${groups.length} groups still have no content: ${unwritten
                        .map((group) => group.title)
                        .join(', ')}.`}
                </p>
            ) : null}

            {/* The review's own counts — what the last pass left open. No sampling state, no selection, no reader
                seats, and no request-another-round verb (U3). */}
            <p className="sv-group-review" data-testid="summary-review">
                {`${review.open_findings} open finding${review.open_findings === 1 ? '' : 's'}` +
                    ` · ${review.blocking_findings} holding the sign-off` +
                    ` · ${review.open_tasks} open task${review.open_tasks === 1 ? '' : 's'}`}
            </p>
        </div>
    );
}

export default SummaryOverviewPane;
