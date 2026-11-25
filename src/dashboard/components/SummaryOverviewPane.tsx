// R6 / U3 — the SUMMARY PHRASE's overview pane: the compiled Overview, and the five groups' state under it.
//
// WHY A SECOND SUMMARY PANE RATHER THAN CHANGES TO `SummaryPane`. A book whose Summary is still `mode:'sampling'`
// is a round: drafts, a recommendation, the Author's pick, a discard reason. That surface is `SummaryPane.tsx`,
// and it stays exactly as it is for those books. A GROUP-managed book has no round to inspect — the Overview is
// composed from five named parts, and the Author's work is the parts. Two honest surfaces, one route each
// (`StoryView` chooses on `isGroupSummary`), so neither pane carries a branch that invents the other's model.
//
// WHAT WAS REMOVED FROM THE SUMMARY SURFACE (U3). The sampling dials, the candidate cards, the pick/merge/serve
// verbs, the critic-seat count and `Request another revision round` do not appear here at all: they were the
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
// edited, and the only controls are the five rows that navigate and — since D-68 — the Author's Choose.
//
// D-67 CHANGED WHAT "THE SUMMARY" MEANS HERE, AND THE PANE FOLLOWED. Before it, this pane printed
// `phrase.overview`: the text composed from whatever each group's LATEST row happens to hold. That is a claim
// about the pipeline, not about the book the crew stands behind — with an unresolved defect on one group, the
// newest Ending is text nobody passed, and the Overview above it was reading that text to the Author as though
// it had. The reviewed block (`projections.ts:PhraseView.reviewed`) is the read that answers the Author's actual
// question, so the pane prints THAT and prints the live composed Overview nowhere: `ready` prints the compiled
// clean selection, `chosen` prints the text the Author took, and `pending` prints no Summary text at all — it
// says which groups are missing and why, which is the difference between "not yet" and "wait for this".
// Substituting the live text in the waiting state would be the same defect wearing a loading spinner.
//
// WHY THE LIVE GROUP ROWS SURVIVE ALL THREE STATES. They are not the live Overview; they are the five panes
// listed in one place, with the state each pane owns (findings, the Writer holding it, what it owes). The
// reviewed strip above them answers "what does the crew stand behind for this section", the row answers "what
// is this section's own desk doing", and both are the wire's rows — neither pane re-decides what the other means.
//
// WHY THE CHOOSE IS TWO CLICKS. A choose installs five texts and flips every revision it passed over to the
// terminal `discarded` state (D-68). Nothing about the click is reversible from this pane, so the pane states
// what will be dropped — the groups whose newest text is not the reviewed one — BEFORE it sends, and the
// Author confirms. That is the same honesty the phase gate's backtrack note uses: a verb that deletes says so first.
import { useState } from 'react';
import type { PhraseChosenSummary } from '../api';
import type { StorySelection } from './story-nav';
// T-W4 — the phrase-generic pieces. `groupStateLabel` and the group rows are this pane's, but they are ALSO
// Phrase ②'s row vocabulary, so they live in `PhraseEntries.tsx` and are re-exported here for the readers that
// already address them by this module (the rail's group rows).
import {
    entryStateLabel,
    PhraseEntryRows,
    PhraseReadState,
    SUMMARY_SURFACE
} from './PhraseEntries';
import {
    chosenGroupRevision,
    chosenGroupScores,
    isGroupSummary,
    phraseGroups,
    phraseReadError,
    phraseReviewed,
    phraseScorePercent,
    reviewedBlockingIssues,
    reviewedChosenDate,
    reviewedChooseError,
    reviewedChooseRefusal,
    reviewedGaps,
    reviewedGapReason,
    reviewedGroupRows,
    reviewedState,
    reviewedSummaryText,
    reviewedSupersededGroups,
    unwrittenGroups
} from './story-contract';
import type { StoryActions, StoryViewData } from './story-contract';

/** Re-exported under the name the rail and the acceptance tests already use (the rule itself is phrase-generic). */
export const groupStateLabel = entryStateLabel;

/**
 * One entry of the reviewed strip: what the crew stands behind for THIS section, the Reader's number that
 * judged exactly that text, and the pair of numbers the feature exists to print (`Revision 5 is newer`).
 *
 * It is a LIST, not a table, and every field is TEXT: the state word, the revision number and the percentage
 * have to survive greyscale, a screen reader and a 320px column at once, which is the same rule the rail's
 * rows and the group pane's score line follow.
 */
function ReviewedGroupEntry({
    groupKey,
    title,
    revision,
    score,
    reason,
    superseded,
    chosenState
}: {
    /** The catalog key — the stable address the test ids and the rail both use (titles are display text). */
    groupKey: string;
    title: string;
    /** The revision the reviewed Overview stands behind, or null when it stands behind none. */
    revision: number | null;
    /** The percentage that judged THAT text, or undefined when no pass reported against its hash (D-67's join). */
    score?: number;
    /** Why there is no reviewed text, in the Author's words; `''` when there is. */
    reason: string;
    /** The group's newest number when it is NOT the reviewed one — the supersession the Author acts on. */
    superseded: number | null;
    /** A chosen book labels its row `taken from`; a ready one labels its row `reviewed`. */
    chosenState: boolean;
}) {
    return (
        <li
            className="sv-reviewed-group"
            data-tone={revision === null ? 'gap' : superseded !== null ? 'superseded' : 'current'}
            data-testid={`reviewed-group-${groupKey}`}
        >
            <span className="sv-reviewed-group-name">{title}</span>
            {/* The same word boundary the rail and the group pane pin: an accessible name is built from TEXT,
                so these spans would announce "Premise reviewed Revision 2Score 84%" without them. */}
            {' '}
            <span className="sv-reviewed-group-state" data-tone={revision === null ? 'gap' : 'ok'}>
                {revision === null
                    ? reason
                    : chosenState
                      ? `taken from Revision ${revision}`
                      : `reviewed Revision ${revision}`}
            </span>
            {score === undefined ? null : (
                <>
                    {' '}
                    <span className="sv-reviewed-group-score" data-testid={`reviewed-score-${groupKey}`}>
                        {`Score ${score}%`}
                    </span>
                </>
            )}
            {superseded === null ? null : (
                <>
                    {' '}
                    {/* Said in words, and softly: the newest text is not the reviewed one, which is the state
                        the choose acts on — not a defect, so it is never the loudest thing on the row. */}
                    <span className="sv-reviewed-group-quiet" data-testid={`reviewed-newer-${groupKey}`}>
                        {`Revision ${superseded} is newer`}
                    </span>
                </>
            )}
        </li>
    );
}

export interface SummaryOverviewPaneProps {
    view: StoryViewData;
    /** The pinned action surface; every method is optional, and an absent one says so on the control. */
    actions?: StoryActions;
    /** The rail's selection, so the row the Author is standing on is the lit one. */
    selection?: StorySelection;
    onSelect?: (selection: StorySelection) => void;
}

export function SummaryOverviewPane({
    view,
    actions = {},
    selection,
    onSelect
}: SummaryOverviewPaneProps) {
    // The choose's confirmation step, and NOTHING else is local. The pane holds only which step the Author is
    // on — the record stays the store's (P1), so a refresh landing under the Author's fingers cannot corrupt it,
    // and a sent choose drops the step so what appears next is what the server returned.
    const [armed, setArmed] = useState(false);

    // A defensive guard, not a branch the shell produces: `StoryView` routes a sampling book to `SummaryPane`.
    // If one ever arrives here, the honest answer is that this pane has no groups to show — five empty rows
    // would be a claim about the book that the wire never made.
    if (!isGroupSummary(view)) {
        return (
            <PhraseReadState
                state="legacy"
                surface={SUMMARY_SURFACE}
                testId="summary-overview-legacy"
                overrideLine={
                    "This Story's Summary is still compiled from sampling rounds, so it has no groups. The round is above."
                }
            />
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
        //
        // T-W4 — THE THREE STATES ARE THE SHARED `PhraseReadState`, with this pane's own pinned ids and copy
        // passed in (`summary-overview-*`, `summary-read-error`, and the Overview-specific lines). The Overview
        // names the reviewed Summary in its waiting line, which is why `overrideLine`/`overrideNotice` stay
        // this pane's rather than the surface's generic entry-pane wording: the ids and sentences the tests pin
        // are byte-for-byte what they were before the panes were generalised.
        const failure = phraseReadError(view);

        if (failure !== undefined) {
            return (
                <PhraseReadState
                    state="failed"
                    surface={SUMMARY_SURFACE}
                    testId="summary-overview-error"
                    readErrorId="summary-read-error"
                    failure={failure}
                    overrideNotice={
                        'The Story is still written as five groups, so the groups exist — the read that lists their state failed. Nothing here is a verdict about the Overview; reload the Story to read the groups again.'
                    }
                />
            );
        }

        return (
            <PhraseReadState
                state="pending"
                surface={SUMMARY_SURFACE}
                testId="summary-overview-pending"
                overrideLine={
                    'This Summary is written as five groups. The reviewed Summary and the group rows arrive with the phrase read.'
                }
            />
        );
    }

    const groups = phraseGroups(view);
    const unwritten = unwrittenGroups(view);
    const review = phrase.review;

    // D-67 — THE SUMMARY THIS PANE PRINTS. `phraseReviewed` answers the wire's block, or the empty one for a
    // payload that predates it; `reviewedSummaryText` is the single place that decides WHICH text the tab
    // shows, and it answers `''` for `pending` so the live composed Overview appears nowhere.
    const reviewed = phraseReviewed(view);
    const chosen: PhraseChosenSummary | null = reviewed.chosen;
    const chosenDate = reviewedChosenDate(view);
    const summaryText = reviewedSummaryText(view);

    // Each reviewed row, paired with the live row that carries its title and, on a chosen book, read off the
    // CHOICE record rather than the live selection: immediately after a choose the chosen rows are the live
    // `latest` rows and carry no clean stamp (nobody has re-read them), so the live selection is empty while
    // the choice record is the only reviewed Summary the book has.
    const reviewedRows = reviewedGroupRows(view).map((row) => {
        const fromChosen = reviewed.state === 'chosen' && chosen !== null;
        const scores = fromChosen ? chosenGroupScores(view, row.reviewed.id) : row.reviewed.scores;
        const [latestScore] = scores.filter((score) => Number.isFinite(score?.value));

        return {
            key: row.reviewed.key,
            title: row.title,
            revision: fromChosen ? chosenGroupRevision(view, row.reviewed.id) : row.reviewed.selected_revision,
            score: latestScore === undefined ? undefined : phraseScorePercent(latestScore.value),
            reason: reviewedGapReason(row.reviewed),
            // The number to print beside the reviewed one — and only when the newest text is NOT the reviewed
            // one, because `Revision 2 is newer` beside `reviewed Revision 2` would be a contradiction.
            superseded: row.reviewed.superseded ? row.reviewed.latest_revision : null
        };
    });

    // The waiting state's two lists: which groups are missing and why, and which unresolved issue is holding a
    // clean verdict back. Both are the wire's rows — the pane adds the words, never the reasons.
    const gaps = reviewedGaps(view);
    const issues = reviewedBlockingIssues(view);

    // The Author's whole-Summary verb (D-68), and U-16's rule that a disabled control states its reason: the
    // reason is the wire's `writer_busy` or the shell's missing binding, never a guess from run rows.
    const refusal = reviewedChooseRefusal(view, actions.chooseReviewedSummary !== undefined);
    const canChoose = reviewed.state === 'ready' && refusal === '';
    const superseded = reviewedSupersededGroups(view);
    const chooseError = reviewedChooseError(view);

    /** Sends the choose, dropping the confirmation step first: what appears next is the server's answer. */
    const choose = () => {
        if (!canChoose) {
            return;
        }

        setArmed(false);
        void actions.chooseReviewedSummary?.(view.story.id);
    };

    return (
        <div className="sv-pane sv-summary sv-group-overview" data-testid="summary-overview">
            <div className="sv-pane-head">
                <h3 className="sv-pane-title">Summary</h3>
                {/* The server's own count, not a verdict this pane invented: the Overview is complete exactly when
                    every group has content (R1), and the number comes from the same read as the rows. */}
                <span className="sv-pane-badge" data-testid="summary-written">
                    {`${review.written_groups} of ${groups.length} groups written`}
                </span>
                {/* D-67's state word, beside the count so the two cannot be confused for one claim: written says
                    what the groups hold, this says what the Reviewers have passed. */}
                <span
                    className="sv-pane-badge"
                    data-tone={reviewed.state}
                    data-testid="reviewed-state"
                >
                    {reviewed.state === 'chosen'
                        ? 'reviewed Summary chosen'
                        : reviewed.state === 'ready'
                          ? 'reviewed Summary ready'
                          : 'no reviewed Summary yet'}
                </span>
            </div>

            <p className="sv-pane-subtitle">
                The Summary the crew stands behind — the reviewed text of the five groups, not the newest draft
                of them. Each group is its own pane in the rail: its findings, its history and the Writer&apos;s
                job live there.
            </p>

            {/* D-68's refusal, verbatim from the route. It is printed here rather than only in the shell-wide
                line because the Author made this choice on THIS tab, and the three refusals name the groups
                and the runs that caused them — that sentence is the Author's next action, not a stack trace. */}
            {chooseError === undefined ? null : (
                <p
                    className="sv-group-notice sv-group-notice--warn"
                    role="alert"
                    data-testid="reviewed-choose-error"
                >
                    {chooseError}
                </p>
            )}

            {reviewed.state === 'pending' ? (
                /* THE WAITING STATE. No Summary text at all — the live composed Overview is not this pane's
                   subject, and printing it here would put an unreviewed sentence in front of the Author under a
                   heading that says it has been read. What replaces it is the honest "not yet, and this is
                   what is missing": one line per group the selection lacks, and one per unresolved issue that
                   is holding a clean verdict back. */
                <>
                    <p className="sv-summary-flag sv-reviewed-waiting" data-testid="reviewed-waiting">
                        {/* The sentence says what is MISSING rather than printing the live text in the gap: the
                            live Overview may carry a group with an open defect, and this tab's claim is that what
                            it shows has been read and passed. */}
                        {`No reviewed Summary yet — ${gaps.length} of ${groups.length} groups are not in the selection, so the crew stands behind no Summary to choose.`}
                    </p>
                    <ul
                        className="sv-reviewed-gaps"
                        aria-label="Why there is no reviewed Summary yet"
                        data-testid="reviewed-gaps"
                    >
                        {gaps.map((row) => (
                            <li
                                className="sv-reviewed-gap"
                                key={row.reviewed.id}
                                data-testid={`reviewed-gap-${row.reviewed.key}`}
                            >
                                {/* The catalog's title and the wire's reason, in that order: the Author reads a
                                    group by its name, and the reason is the wait they are being asked for. */}
                                {`${row.title}: ${row.reason}`}
                            </li>
                        ))}
                    </ul>
                    {issues.length > 0 ? (
                        <ul
                            className="sv-reviewed-issues"
                            aria-label="Issues holding a clean pass back"
                            data-testid="reviewed-issues"
                        >
                            {issues.map((issue) => (
                                <li
                                    className="sv-reviewed-issue"
                                    key={issue.id}
                                    data-testid={`reviewed-issue-${issue.id}`}
                                >
                                    {`Holding a clean pass back: ${issue.title} (${issue.cost}) on ${issue.groups.join(', ')}`}
                                </li>
                            ))}
                        </ul>
                    ) : null}
                </>
            ) : (
                /* `ready` prints the compiled clean selection; `chosen` prints the text the Author took. Both
                   are the reviewed Overview, and neither is `phrase.overview` (D-67). */
                <>
                    <p className="sv-pane-label" data-testid="reviewed-caption">
                        {reviewed.state === 'chosen'
                            ? `The Summary the Author chose${chosenDate === '' ? '' : ` on ${chosenDate}`}. The revisions it passed over were dropped from the book (D-68).`
                            : 'The reviewed Summary — the clean revision of each group the crew stands behind.'}
                    </p>
                    {summaryText === '' ? (
                        <p className="sv-summary-flag" data-testid="summary-empty">
                            No reviewed Overview yet — the selection has no composed text to show.
                        </p>
                    ) : (
                        <p className="sv-summary-text" data-testid="summary-text">
                            {summaryText}
                        </p>
                    )}
                    {reviewed.state === 'chosen' ? (
                        <p className="sv-group-quiet sv-reviewed-dropped" data-testid="reviewed-dropped">
                            {/* The half a choose that is easy to forget: the texts it passed over are gone from
                                every current read (retained, never deleted — a finding they closed stays closed). */}
                            Everything this choice passed over was dropped from the Summary — the numbers below name the revision each section was taken from.
                        </p>
                    ) : null}
                </>
            )}

            {reviewed.state === 'ready' ? (
                /* D-68 — the Author's whole-Summary verb. It sits under the text it is about to install, and it
                   is the pane's only write. `stale` changes the LABEL, never the enabled state: `stale` means the
                   crew has reviewed a NEWER combination than the one the Author chose, which is the case the
                   choose exists for a second time (see `story-contract.reviewedChooseRefusal`). */
                <div className="sv-reviewed-actions" data-testid="reviewed-choose">
                    {reviewed.stale && chosen !== null ? (
                        <p className="sv-group-notice" data-testid="reviewed-stale">
                            {`You chose a Summary${chosenDate === '' ? '' : ` on ${chosenDate}`}, and the crew has reviewed a newer one since — choosing takes the newer text.`}
                        </p>
                    ) : null}
                    <button
                        type="button"
                        className="sv-summary-revise-button"
                        data-testid="reviewed-choose-submit"
                        disabled={!canChoose || armed}
                        title={canChoose ? 'Install the reviewed Summary and drop the revisions it passes over (D-68).' : refusal}
                        onClick={() => setArmed(true)}
                    >
                        {reviewed.stale ? 'Choose the newer reviewed Summary' : 'Choose the reviewed Summary'}
                    </button>
                    {!armed ? null : (
                        /* The confirmation step, with the drop spelled out before the verb: the five installs are
                           a commit the Author cannot undo from here, and the rows it passes over stop being
                           current. Naming them is what makes "drop everything" a decision rather than a surprise. */
                        <div className="sv-reviewed-confirm" data-testid="reviewed-choose-confirm-block">
                            <p className="sv-group-notice sv-group-notice--warn" data-testid="reviewed-choose-note">
                                {superseded.length === 0
                                    ? 'Choosing installs this Summary for all five groups. No group has a newer text standing, so nothing is dropped (D-68).'
                                    : `Choosing installs this Summary for all five groups and drops the newer texts it passes over (D-68): ${superseded
                                          .map((row) => `${row.title} Revision ${row.reviewed.latest_revision}`)
                                          .join(', ')}.`}
                            </p>
                            <div className="sv-summary-actions">
                                <button
                                    type="button"
                                    data-testid="reviewed-choose-confirm"
                                    disabled={!canChoose}
                                    onClick={choose}
                                >
                                    Choose the reviewed Summary
                                </button>
                                <button
                                    type="button"
                                    data-testid="reviewed-choose-cancel"
                                    onClick={() => setArmed(false)}
                                >
                                    Keep the current Summary
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            ) : null}

            {/* One entry per group: the revision the reviewed Overview stands behind, the number that judged
                exactly that text, and the newer revision it fell back past. Always all five (U1) — a group with
                no selection is a fact the tab shows, not a row it drops. */}
            <ul
                className="sv-reviewed-groups"
                aria-label="The reviewed Summary, group by group"
                data-testid="reviewed-groups"
            >
                {reviewedRows.map((row) => (
                    <ReviewedGroupEntry
                        key={row.key}
                        groupKey={row.key}
                        title={row.title}
                        revision={row.revision}
                        score={row.score}
                        reason={row.reason}
                        superseded={row.superseded}
                        chosenState={reviewed.state === 'chosen'}
                    />
                ))}
            </ul>

            {/* One row per group, in the contract's composition order, always all five (U1). R-T2/F4: the list
                is a named region, so its rows are announced as a list of five groups rather than five loose
                buttons, and the selected row carries `aria-current` (below). These are the LIVE groups — the
                panes they open are where a group's own text, findings and revise verb live.
                T-W4: the rows are the shared `PhraseEntryRows` under `SUMMARY_SURFACE`, which reproduces this
                list's `sv-group-rows` class, its `summary-group-rows` test id, its row ids and its state words
                exactly — Phrase ② renders the same component with its own surface. */}
            <PhraseEntryRows
                view={view}
                entries={groups}
                surface={SUMMARY_SURFACE}
                selection={selection}
                onSelect={onSelect}
                label="Summary groups"
            />

            {unwritten.length > 0 ? (
                <p className="sv-summary-flag" data-testid="summary-unwritten">
                    {/* The engine's TITLES, not its catalog keys (`review.unwritten_groups` holds keys): the rail
                        and this sentence have to name a group the same way (U6). */}
                    {`${unwritten.length} of ${groups.length} groups still have no content: ${unwritten
                        .map((group) => group.title)
                        .join(', ')}.`}
                </p>
            ) : null}

            {/* The review's own counts — what the last pass left open. No sampling state, no selection, no critic
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
