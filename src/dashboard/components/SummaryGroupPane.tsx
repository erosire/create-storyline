// R6 / U4 — one SUMMARY GROUP's pane: what it is for, what the Writer has written, what the Reviewer left open.
//
// WHY THIS PANE EXISTS AT ALL. U1's rail puts a button per group in front of the Author, and a button that opens
// nothing is chrome. This is the pane those buttons open: the group's own text, its revision number, and the
// findings the Reviewer aims at it — which had no address anywhere in the workspace before, the defect that made
// a grouped book unreadable in the desk. The five groups share one compiled Overview, so this pane shows what
// makes THIS group different (its purpose line, its findings, its history) and leaves the shared text to the
// Summary overview pane.
//
// WHAT THE HISTORY MAY SAY (U4). `PhraseRevisionRow` is metadata and `chars`; the projection sends the prose of
// exactly ONE superseded revision — the one immediately before the latest — so the pane can show the current
// text as a diff against it (`previous_content`). Older archived rows stay metadata, so the pane still prints
// the COUNT of archived revisions and offers no control that would open one.
//
// WHY ONE EDIT CONTROL, AND WHY IT IS SOMETIMES SHUT. `POST …/phrases/groups/:id/revise` (R2) is the Author's one
// write against a group: the new text plus a note, and the Editor replans and the Writer rewrites from it. The
// control is disabled off `group.writer_busy` — the SAME read the route refuses with (F8/R4), so a disabled button
// and a 409 cannot disagree, and U-16 is satisfied by the `title` that states the reason rather than by a grey
// rectangle. The finding approve/discard verbs stay where the engine records those decisions (the Ideas tray and
// the Findings folder); the pane shows findings, it does not re-decide them.
//
// THE MODEL IT READS is `StoryViewData` plus the group's UUID from the rail's selection ref. The group is looked
// up by id (`phraseGroupById`), never by index or `order`, so a refetch, a reorder or a retired group cannot move
// the pane to a different group (U2/U6).
//
// T3 ADDS TWO THINGS, AND BOTH OF THEM ARE THE WIRE'S. Each finding row now says WHAT it claims (`issue` or
// `proposal`) before it says what repairing it costs, because the Author's answer to "this is broken" and to
// "this could be better" are different decisions; and the pane prints the Critic's percentage for THIS group with
// the pass it moved from and the whole trail behind it, which is the group-level version of the rail's single
// number. Both are absent-tolerant by rule: an unscored group and an unscoped kind mean Issue, and neither draws
// a placeholder.
//
// R1 ADDS THE LOCK, AND THE PANE IS WHERE IT IS DECIDED. A group's text can be locked in — by the Author from
// here, or by the Editor when the Story's `editor_group_locking` Setting is on — and locked content is settled:
// it cannot be revised, the findings aimed at it are void, and the other groups adapt to it. The pane therefore
// carries three new things and one removed one: the locked BADGE (the revision the lock stands on and who made
// it), the Author's lock/unlock pair (locking armed behind a confirmation because it voids findings and binds the
// other groups; unlocking immediate because it destroys nothing), and the server's own refusal printed beside the
// button that raised it (`story-contract.groupLockError`, the store's per-group cache — a refusal never paints a
// locked badge on a group the route kept open). What is removed is the revise field's availability: a locked group
// is never editable, so the field is shut with the reason next to it rather than left to 409 in the author's
// face. All of it is read through `story-contract`'s lock selectors, so the rail's mark and this pane cannot
// disagree, and `locked` ABSENT means open — a payload from before the lock keeps the pane it had.
//
// T5 REPLACES THE DATED TRAIL WITH TWO MARKS. The score list used to print every Reader pass with a date and a
// run ref, which is a changelog; the Author's question is two facts wide — what does this section score now, and
// what did it score the last time the Reader read it. So the pane now renders at most two rows, `Current clean
// revision` and `Previous mark`, each with its percentage and the Critic's sentence when the pass wrote one, and
// NO date and no timestamp anywhere in the text. Three passes or thirteen, two rows appear: the third mark is
// history, and history is not this pane's claim. The numbers themselves are unchanged — same rows, same selectors,
// same normalizer the rail's percentage uses.

import { useState } from 'react';
import type { PhraseFindingRow, PhraseGroupRow } from '../api';
import type { StoryActions, StoryViewData } from './story-contract';
import { RevisionDiff } from './RevisionDiff';
import {
    canAuthorLockGroup,
    canAuthorUnlockGroup,
    findingGroups,
    findingKindLabel,
    findingKindToken,
    groupArchivedRevisions,
    groupBlockingFindings,
    groupLatestRevision,
    groupLockActor,
    groupLockActorLabel,
    groupLockBadge,
    groupLockError,
    groupLockRefusal,
    groupLockStatement,
    groupLockTooltip,
    groupOpenFindings,
    groupPreviousScorePercent,
    groupScoreMarks,
    groupScorePercent,
    groupUnlockRefusal,
    isEditorGroupLockingEnabled,
    isGroupLocked,
    isGroupSummary,
    isGroupWriterBusy,
    isGroupWritten,
    phraseGroupById,
    phraseGroups,
    phraseReadError
} from './story-contract';
import type { StorySelection } from './story-nav';

export interface SummaryGroupPaneProps {
    view: StoryViewData;
    /** The pinned action surface; every method is optional, and an absent one says so on the control. */
    actions?: StoryActions;
    /** The group the rail's selection addresses — its UUID, never its index or `order` (U2). */
    groupId?: string;
    onSelect?: (selection: StorySelection) => void;
}

/**
 * T3 — the movement between a group's LATEST score and the pass before it, in words.
 *
 * A delta printed as `+6` leans on a sign and a colour; a reader who cannot see the colour still needs the
 * sentence. `undefined` on a first pass is the honest answer — "never scored" and "scored zero" are different
 * claims, so the pane does not subtract an invented zero. `flat` says `unchanged`, because `up 0` is not a
 * sentence anyone would write.
 */
function scoreDelta(
    score: number,
    previousScore?: number
): { tone: 'up' | 'down' | 'flat'; text: string } | undefined {
    if (previousScore === undefined) return undefined;
    if (previousScore === score) return { tone: 'flat', text: `unchanged from ${previousScore}%` };

    return previousScore < score
        ? { tone: 'up', text: `up ${score - previousScore} from ${previousScore}%` }
        : { tone: 'down', text: `down ${previousScore - score} from ${previousScore}%` };
}

/**
 * One open finding, with the other groups it spans (U4's cross-group chips).
 *
 * The wire gives a finding a cost, a state, a title and its scope (`targeted`, plus `unscoped` when the record
 * named no group at all). It carries no evidence or detail fields — those live in the agent transcript — so the
 * row is one line: cost, the title the engine wrote, how many times the Reviewer had to raise it, and a chip for
 * every OTHER group the same finding aims at. The chips are what make a cross-group finding legible: the Author
 * sees that the row also stands in Premise's pane, and that its fix has to land on more than one group.
 */
function FindingRow({
    finding,
    groups,
    of
}: {
    finding: PhraseFindingRow;
    groups: readonly PhraseGroupRow[];
    of: PhraseGroupRow;
}) {
    // The other groups this finding is aimed at, resolved by the contract's rule (`targeted`, and an unscoped
    // legacy row meaning every group) — so the chips can never claim a scope the server did not record.
    const others = findingGroups(finding, groups).filter((group) => group.id !== of.id);
    // R3: the groups whose text has NOT yet answered this finding. When that is more than this group, the fix is
    // still waiting on another pane's revision — the one fact a flat finding list otherwise hides.
    const missing = (finding.missing ?? []).filter((id) => id !== of.id);

    return (
        <li className="sv-group-finding" data-cost={finding.cost} data-state={finding.state} data-testid={`finding-${finding.id}`}>
            {/* The cost word and the sentence the Reviewer wrote are two spans, and an accessible/linear read
                concatenates spans: the separator keeps them two words instead of "criticalthe promise…". */}
            {/* T3 — WHAT the row claims, said before what repairing it costs. `cost` is the repair bill; this is
                the claim type: an Issue is the text contradicting a commitment the Seed made, a Proposal is the
                text being merely improvable (word change, new element, a twist linked up). The Author's answer
                differs — one has to be repaired, the other is weighed on merit — so a findings list that prints
                only costs cannot tell the two apart. Absence means Issue (the legacy reading, pinned in
                `api.ts:PhraseFindingRow`), and the word is TEXT rather than colour so it survives greyscale. */}
            <span
                className={`sv-finding-kind sv-finding-kind--${findingKindToken(finding.kind)}`}
                data-testid={`finding-${finding.id}-kind`}
            >
                {findingKindLabel(finding.kind)}
            </span>
            {' '}
            <span className={`sv-cost-${finding.cost}`}>{finding.cost}</span>
            {' '}
            <span className="sv-group-finding-title">{finding.title}</span>
            {/* Every following span needs the same boundary: the re-raise count, the cross-group chips and the
                two status sentences all ride this one row. */}
            {finding.seen_count > 1 ? (
                <>
                    {' '}
                    <span className="sv-group-finding-count">{`raised ${finding.seen_count}×`}</span>
                </>
            ) : null}
            {others.length > 0 ? (
                <>
                    {' '}
                    <span className="sv-group-finding-groups" data-testid={`finding-${finding.id}-groups`}>
                        {/* The engine's titles, not the ids: a chip an Author can read is the point of the chip.
                            The space text node between chips is for the reader, not the eye: an accessible name is
                            built from TEXT, so without it a cross-group finding announces "…also Promisealso Theme". */}
                        {others.map((group, index) => (
                            <span key={group.id} className="sv-group-finding-chip">
                                {index > 0 ? ' ' : null}
                                {`also ${group.title}`}
                            </span>
                        ))}
                    </span>
                </>
            ) : null}
            {finding.state === 'approved' ? (
                <>
                    {' '}
                    <span className="sv-group-finding-count">approved — awaiting its revision</span>
                </>
            ) : null}
            {/* R3: the groups whose text has NOT answered this finding yet, when that is more than this group.
                It is the one fact a flat finding list hides: the fix is still waiting on another pane. */}
            {missing.length > 0 && others.length > 0 ? (
                <>
                    {' '}
                    <span className="sv-group-finding-count">
                        {`still missing on ${missing
                            .map((id) => groups.find((group) => group.id === id)?.title ?? id)
                            .join(', ')}`}
                    </span>
                </>
            ) : null}
        </li>
    );
}

export function SummaryGroupPane({ view, actions = {}, groupId, onSelect }: SummaryGroupPaneProps) {
    // The pane's local state, all three of it about a WRITE in progress and none of it about the record:
    //   - `draft`/`note` are the Author's pending revise body, dropped on send so what appears next is the
    //     server's answer;
    //   - `lockArmed` is only the confirmation STEP the lock sits on (R1) — the same shape the Reviewed-Summary
    //     choose uses in `SummaryOverviewPane`, and never a claim that the group is locked. The badge below reads
    //     `group.locked` off the phrase rows, so a refused lock leaves the pane saying `unlocked` in the same
    //     frame it prints the refusal.
    const [draft, setDraft] = useState<string | null>(null);
    const [note, setNote] = useState('');
    const [lockArmed, setLockArmed] = useState(false);

    // A sampling book has no groups. Its rail cannot select one, so this is the defensive answer, not a branch
    // the shell produces.
    if (!isGroupSummary(view)) {
        return (
            <div className="sv-pane" data-testid="group-pane-legacy">
                <p className="pane-state">
                    This Story&apos;s Summary is still compiled from sampling rounds, so it has no groups to open.
                </p>
            </div>
        );
    }

    const phrase = view.phrase;

    if (phrase === undefined || phrase === null) {
        // R-T2/F2 — A FAILED READ IS NOT A SLOW ONE. The store caches the route's own sentence per Story
        // (`state.ts:phraseErrors`), so the pane can say what broke and what to do, instead of promising text
        // that will not arrive until the Story is reloaded. The Story payload stays current: the failure
        // belongs to the phrase read, and only the Summary area changes what it says.
        const failure = phraseReadError(view);

        if (failure !== undefined) {
            return (
                <div className="sv-pane" data-testid="group-pane-error">
                    <p className="pane-state" data-testid="group-read-error">
                        {`The Summary group rows could not be read: ${failure}`}
                    </p>
                    <p className="sv-group-notice sv-group-notice--warn">
                        This Story is group-managed, so its groups exist — the read that lists them failed. The pane
                        cannot show this group until it answers; reload the Story to try again.
                    </p>
                </div>
            );
        }

        return (
            <div className="sv-pane" data-testid="group-pane-pending">
                <p className="pane-state">
                    This Summary is written as five groups. Their content arrives with the phrase read.
                </p>
            </div>
        );
    }

    const group = phraseGroupById(view, groupId);

    // U6's stale-ref answer: the group was retired, the book switched back to `sampling`, or the ref is the last
    // book's. The rail already falls back to the Summary header (`selectionExists`); this line is what the Author
    // sees when the fallback has not been applied yet — and it is not an empty pane that looks like an unwritten
    // group, which would be a lie about the book.
    if (group === undefined) {
        return (
            <div className="sv-pane" data-testid="group-pane-stale">
                <p className="pane-state">This group is no longer part of the Summary.</p>
                <div className="sv-summary-actions">
                    <button type="button" onClick={() => onSelect?.({ panel: 'summary' })}>
                        Open Summary
                    </button>
                </div>
            </div>
        );
    }

    const groups = phraseGroups(view);
    const open = groupOpenFindings(view, group.id);
    const blocking = groupBlockingFindings(view, group.id);
    const archived = groupArchivedRevisions(group);
    const latest = groupLatestRevision(group);
    // R2 / U3 — the ONE archived body the wire carries: the revision immediately before the latest. The pane
    // renders the current text as a grouped word diff against it, and stays a plain paragraph at revision 1.
    const previous = group.previous_content;
    const busy = isGroupWriterBusy(group);
    const written = isGroupWritten(group);
    // R1 — THE LOCK, read through the contract's selectors (`story-contract`), so the rail's mark, this pane's
    // badge and the two controls underneath it are four readings of ONE rule. `locked` absent means open, and the
    // four refusals below are the wire's own states — the shell's missing verb, the Writer holding the text
    // (R4's `writer_busy`, the same read the revise route refuses with), a group with no revision to commit
    // (R1's `revision: 0`), or a lock already standing — never a guess from run rows.
    const locked = isGroupLocked(group);
    const lockError = groupLockError(view, group.id);
    const lockRefusal = groupLockRefusal(group, actions.lockPhraseGroup !== undefined);
    const unlockRefusal = groupUnlockRefusal(group, actions.unlockPhraseGroup !== undefined);
    const canLock = canAuthorLockGroup(group, actions.lockPhraseGroup !== undefined);
    const canUnlock = canAuthorUnlockGroup(group, actions.unlockPhraseGroup !== undefined);
    // T3/T5 — the group's Reader marks, read through the contract's selectors (the SAME read that drives the
    // rail's percentage and the phrase header's average, so no surface rounds or orders it its own way).
    // `marks` is AT MOST TWO rows — the current clean mark and the mark immediately before it — which is the
    // whole comparison the Author asks for; the dated trail the pane used to print is gone (see
    // `story-contract.groupScoreMarks` for why). An empty list means the pass has never run over this group, and
    // the pane prints NOTHING rather than a `0%` that claims a review.
    const marks = groupScoreMarks(group);
    const score = groupScorePercent(group);
    const previousScore = groupPreviousScorePercent(group);
    // The movement in words (`up 6 from 78%`) — the two percentages the marks list is already showing, said as a
    // sentence. `undefined` on a first mark is the honest answer: "never scored" and "scored zero" are different
    // claims, so nothing subtracts an invented zero.
    const delta = score === undefined ? undefined : scoreDelta(score, previousScore);
    // The Author's one prose write against a group. R-T2/F6: the pane shows the group's text ONCE — the prose
    // region above is the reading copy — and the field below is an EDIT that starts empty and says what it
    // replaces. Prefilling the field with the whole current text announced the same paragraphs twice to a
    // screen reader (the prose region, then the field's value), which is noise on the one surface where the
    // Author is meant to read the book.
    const text = draft ?? '';
    // U-16: a disabled control states its reason, and the reason is the wire's own state (or the shell's missing
    // binding), never a guess from run rows. R1 puts the LOCK first: a locked group is settled content, so the
    // revise route refuses it whatever else is true of it, and an author who sees "the Writer is busy" on a locked
    // group would be waiting for a busy-flag that was never the blocker.
    const trimmed = text.trim();
    const refuse =
        actions.revisePhraseGroup === undefined
            ? 'The group revise route is not available in this shell.'
            : locked
              ? `${group.title} is locked in — locked content is settled and cannot be revised (R1). Unlock it first to write a new revision.`
              : busy
                ? 'The Writer is rewriting this group right now — the revise route refuses the write until it lands (R4).'
                : trimmed.length === 0
                  ? 'Write the new text above first — the route refuses an empty group text (R2), so there is nothing to send yet.'
                  : '';
    const canRevise = actions.revisePhraseGroup !== undefined && !locked && !busy && trimmed.length > 0;

    const submit = () => {
        if (!canRevise) {
            return;
        }

        void actions.revisePhraseGroup?.(view.story.id, group.id, {
            content: text,
            ...(note.trim().length > 0 ? { note: note.trim() } : {})
        });
        setDraft(null);
        setNote('');
    };

    /**
     * R1 — sends the lock. The confirmation step drops FIRST, exactly as the Reviewed-Summary choose does in
     * `SummaryOverviewPane`: the pane keeps no lock state of its own, so what appears next is the phrase read the
     * server answered with — the badge if the route accepted it, and the refusal line if it did not.
     */
    const lock = () => {
        if (!canLock) {
            return;
        }

        setLockArmed(false);
        void actions.lockPhraseGroup?.(view.story.id, group.id);
    };

    /**
     * R1 — opens a locked group again, and the Author's one verb on a lock the Editor made.
     *
     * NO CONFIRMATION STEP, unlike locking: unlocking destroys nothing. The text stands, the findings stay void
     * until the next revision moves the group, and the only consequence is that the Author may write again — so
     * a second click here would be friction on the exit out of a decision that was already confirmed.
     */
    const unlock = () => {
        if (!canUnlock) {
            return;
        }

        setLockArmed(false);
        void actions.unlockPhraseGroup?.(view.story.id, group.id);
    };

    return (
        <div
            className="sv-pane sv-group"
            data-tone={busy ? 'writer' : written ? 'written' : 'todo'}
            data-testid={`group-pane-${group.key}`}
        >
            <div className="sv-pane-head">
                <h3 className="sv-pane-title" data-testid="group-title">
                    {group.title}
                </h3>
                {/* The revision number the rail stopped printing (U2), where it belongs: a group's own status. */}
                <span className="sv-pane-badge" data-testid="group-revision">
                    {written ? `Revision ${group.revision}` : 'No revision yet'}
                </span>
                {blocking.length > 0 ? (
                    <span className="sv-badge sv-badge-warn" data-testid="group-blocking">
                        {`${blocking.length} holding the sign-off`}
                    </span>
                ) : null}
                {busy ? (
                    <span className="sv-badge sv-badge-lock" data-testid="group-writer">
                        Writer busy
                    </span>
                ) : null}
                {/* R1 — THE LOCKED BADGE, and it is the head's only claim about a decision someone made. Both
                    halves are the request: the revision the lock stands on (`groupLockRevision`, which is the
                    locked text's number rather than whatever the loop has installed since) and WHO made it, the
                    fact that explains why the write below is shut and why the desk's only way out is the Author's
                    unlock. It is a badge and not the status line for the same reason the Clean stamp is: the
                    status row is the Writer's account of the text, and this is a person's decision about it. */}
                {locked ? (
                    <span
                        className="sv-badge sv-badge-locked"
                        data-testid="group-locked"
                        title={groupLockTooltip(group)}
                    >
                        {groupLockBadge(group)}
                    </span>
                ) : null}
            </div>

            {/* The purpose line: what the group is for, in the catalog's own words. It is the difference between
                five textareas and five sections of a book. */}
            <p className="sv-group-purpose" data-testid="group-purpose">
                {group.description}
            </p>

            {busy ? (
                <p className="sv-group-notice" data-testid="group-busy">
                    The Writer is replacing this text right now. The pane shows the new revision when it lands.
                </p>
            ) : null}

            {/* R1 — the locked state stated in words, not only in a badge: a reader who lands on this pane needs
                the consequence, not the decoration. The third clause is the one an Author is least likely to
                expect from a lock button — the OTHER groups start adapting to this text — and the last is the
                way out, which is the difference between a lock and a dead end. */}
            {locked ? (
                <p className="sv-group-notice" data-testid="group-locked-notice">
                    {`This group is locked in by ${groupLockActorLabel(groupLockActor(group)).toLowerCase()}: the text is settled content, it cannot be revised from this pane, and the findings aimed at it are void. The other groups adapt to it. Only the Author can unlock it.`}
                </p>
            ) : null}

            {/* R1 — a refusal the server sent, verbatim, beside the button that raised it (`state.ts` caches it
                per group: `story-contract.groupLockError`). It says WHICH verb was refused, so a lock refusal and
                an unlock refusal cannot be read as each other, and the pane still shows the group as the phrase
                read describes it — the refusal never paints a locked badge over a group the route kept open. */}
            {lockError === undefined ? null : (
                <p className="sv-group-notice sv-group-notice--warn" role="alert" data-testid="group-lock-error">
                    {lockError}
                </p>
            )}

            {/* T5 — THE GROUP'S TWO READER MARKS. The score sits under the purpose line and above the text on
                purpose: it is the Reviewer's verdict on how well this group does what it is FOR, and the prose
                below is what produced it.

                WHAT CHANGED, AND WHY IT IS NOW TWO ROWS. The pane used to print the whole dated trail — every pass
                with a date and a run ref — which is a changelog, and a changelog answers a question nobody in the
                desk is asking. The Author's question is two facts wide: what does this section score NOW, and what
                did it score the last time the Reader read it? So the list is at most two rows, labelled
                `Current clean revision` and `Previous mark`, with the Critic's sentence for each and NO date and no
                run timestamp anywhere in the text (D-67 put the Reader's verdict on the clean vector, which is why
                the current row is named for the revision it judged rather than for the clock). Three passes or
                thirteen, the pane still renders two rows — the third mark is history, and history is not this
                pane's claim.

                The two rows come from `story-contract.groupScoreMarks`, the same selectors the rail's percentage
                and the delta sentence are built from, so a rail row, this pane and the phrase header's average
                cannot print three different pairs. A group nobody has scored prints NOTHING — the pane already
                says `not written`/`No revision yet`, and a `0%` would claim a pass that never ran. */}
            {score === undefined ? (
                /* D-67 — an EMPTY `scores` list on a WRITTEN group is now the normal state, and the pane says why.
                   The Reader pass reads the sections once the crew has a CLEAN revision of them to read (D-67
                   moved the scoring join onto the clean vector), so a section whose group has no clean verdict
                   carries no number at all. Printing `0%` there would claim a review that never ran, and
                   printing nothing would read like the wire broke — so the line names the wait, in the same
                   quiet voice an unwritten group already uses. */
                written ? (
                    <p className="sv-group-quiet" data-testid="group-score-none">
                        No Reader score for this section yet — the pass reads a section once the crew has a clean
                        revision of it to stand behind.
                    </p>
                ) : null
            ) : (
                <div className="sv-group-score" data-testid="group-score">
                    <p className="sv-group-score-line">
                        <span className="sv-group-score-value" data-testid="group-score-value">
                            {`Score ${score}%`}
                        </span>
                        {/* The same word boundary the rail's rows pin: an accessible/linear read concatenates
                            spans, so without it the pane announces "Score 84%(up 6 from 78%)". The WORDS are the
                            carrier ("up 6 from 78%"), so the delta keeps its colour as speed only and survives
                            greyscale and a screen reader. */}
                        {' '}
                        {delta === undefined ? null : (
                            <span
                                className={`sv-group-score-delta sv-group-score-delta--${delta.tone}`}
                                data-testid="group-score-delta"
                            >
                                {`(${delta.text})`}
                            </span>
                        )}
                    </p>

                    {/* The comparison itself. `vector_hash` still rides the TOOLTIP rather than the text: one
                        Reader pass scores all five groups against one text vector, so a row here and the same row
                        in four other panes are one event — and a mark from a DIFFERENT vector is a different book,
                        which is the thing a hover is for. A row with no `rationale` prints no sentence: the pass
                        recorded none, and the pane does not write one. */}
                    <ul
                        className="sv-group-score-marks"
                        aria-label="The Reader marks for this section — the current clean revision and the mark before it"
                        data-testid="group-score-marks"
                    >
                        {marks.map((mark) => (
                            <li
                                key={`${mark.role}:${mark.pass.vector_hash}`}
                                className="sv-group-score-mark"
                                data-mark={mark.role}
                                data-testid={`group-score-mark-${mark.role}`}
                                title={`run ${mark.pass.run_ref} · vector ${mark.pass.vector_hash}`}
                            >
                                <span className="sv-group-score-mark-label" data-testid={`group-score-mark-${mark.role}-label`}>
                                    {mark.label}
                                </span>
                                {/* The word boundary again: without it the row reads "Current clean revision84%". */}
                                {' '}
                                <span className="sv-group-score-mark-value">{`${mark.percent}%`}</span>
                                {mark.rationale ? (
                                    <>
                                        {' '}
                                        {/* The current mark keeps the established `group-score-rationale` id; the
                                            older mark gets its own, so a test can pin WHICH pass said WHICH
                                            sentence instead of trusting document order. */}
                                        <span
                                            className="sv-group-score-rationale sv-group-score-mark-why"
                                            data-testid={
                                                mark.role === 'current'
                                                    ? 'group-score-rationale'
                                                    : 'group-score-previous-rationale'
                                            }
                                        >
                                            {mark.rationale}
                                        </span>
                                    </>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            <p className="sv-pane-label">
                Current content
                {previous !== '' ? (
                    <span className="sv-group-diff-label" data-testid="group-diff-from">
                        {` · diff against Revision ${Math.max(1, group.revision - 1)}`}
                    </span>
                ) : null}
            </p>
            {written && group.content ? (
                previous !== '' ? (
                    /* R2 / U3 — the latest revision against the one it replaced: deletions struck in red,
                       additions in green. `previous_content` is the immediately preceding revision ONLY, so
                       this is never a cumulative diff over the archived history. */
                    <p className="sv-summary-text sv-group-content sv-group-diff" data-testid="group-content">
                        <RevisionDiff previous={previous} current={group.content} />
                    </p>
                ) : (
                    /* R-T2/F6 — the ONE reading copy of the group's text. It is prose, not a control, so a screen
                       reader reads the paragraph once; the field below is an empty edit, not a second copy. */
                    <p className="sv-summary-text sv-group-content" data-testid="group-content">
                        {group.content}
                    </p>
                )
            ) : (
                /* U4's purposeful empty state: why it is empty and what fills it. */
                <p className="sv-group-quiet" data-testid="group-empty">
                    {draft === null
                        ? 'No content yet. The loop writes this group when the Editor puts it in the queue, or you can write it below.'
                        : 'Nothing is on the record yet — what you write here is the first revision.'}
                </p>
            )}

            {/* The facts the wire actually supports: the current revision's own row, and the COUNT of superseded
                ones. The revision directly before the latest is on the wire only for the diff above; no older
                archived body is, so nothing here offers to open one. */}
            <dl className="sv-summary-fields">
                <div className="sv-summary-field">
                    <dt>Status</dt>
                    <dd className="sv-summary-value">
                        <span data-testid="group-status">
                            {written
                                ? `Revision ${group.revision}${latest === undefined ? '' : ` · ${latest.chars} chars`}`
                                : 'not written'}
                        </span>
                        {archived.length > 0 ? (
                            /* R-T2/F5 — the count only when there IS a count. `0 archived` beside `Revision 1`
                               states a nothing and reads like a defect; an archived revision is worth naming
                               because the prose behind it is gone (U3), and zero of them is not. */
                            <span className="sv-summary-flag" data-testid="group-archived">
                                {`${archived.length} archived`}
                            </span>
                        ) : null}
                        {/* D-67 — the Clean stamp, on the one row it describes. `history[].clean` is P11's audit
                            of a verdict (this text closed a cross-group Critic pass with no unresolved defect),
                            which is the only thing that makes a revision selectable into the reviewed Summary.
                            It is a BADGE, not a state word: the pane's state line is the Writer's business, and
                            this says something different — that a Reviewer has read exactly this text. The run
                            that earned it travels in the title because every verdict names its run (P11). */}
                        {latest?.clean === true ? (
                            <span
                                className="sv-badge sv-badge-assigned"
                                data-testid="group-clean"
                                title={
                                    latest.clean_run_ref
                                      ? `A cross-group Critic pass closed clean on this revision (run ${latest.clean_run_ref}) — it is the revision the reviewed Summary can stand behind.`
                                      : 'A cross-group Critic pass closed clean on this revision, so it is selectable into the reviewed Summary.'
                                }
                            >
                                Clean
                            </span>
                        ) : null}
                        {written && group.updated_by !== null ? (
                            <span className="sv-summary-flag">{`last written by ${group.updated_by}`}</span>
                        ) : null}
                    </dd>
                </div>
                <div className="sv-summary-field">
                    <dt>Open findings</dt>
                    <dd className="sv-summary-value" data-testid="group-findings-count">
                        {open.length === 0
                            ? 'none open'
                            : `${open.length} open · ${blocking.length} hold${blocking.length === 1 ? 's' : ''} the sign-off`}
                    </dd>
                </div>
                {/* R3: the findings this group's NEXT text has to answer. It is the server's number, so the pane
                    cannot count a group's debt differently from the gate. */}
                {group.owed_by_findings.length > 0 ? (
                    <div className="sv-summary-field">
                        <dt>This group owes</dt>
                        <dd className="sv-summary-value" data-testid="group-owed">
                            {`${group.owed_by_findings.length} finding${
                                group.owed_by_findings.length === 1 ? '' : 's'
                            } its next revision must answer`}
                        </dd>
                    </div>
                ) : null}
            </dl>

            {open.length > 0 ? (
                <ul className="sv-group-findings" data-testid="group-findings">
                    {open.map((finding) => (
                        <FindingRow key={finding.id} finding={finding} groups={groups} of={group} />
                    ))}
                </ul>
            ) : (
                <p className="sv-group-quiet" data-testid="group-findings-empty">
                    Nothing open on this group.
                </p>
            )}

            {/* R1 — THE AUTHOR'S TWO VERBS ON THIS GROUP'S LOCK. They sit with the write controls, not up in the
                head with the badge, because the decision and its consequence belong in one place: the pane says
                what the text is worth, then asks whether the Author is committing to it.

                LOCKING is armed, not fired: the first click puts the sentence above the verb, because a lock
                freezes the text, voids the group's own findings, and promises this text to the other four groups —
                three consequences an Author should read before the commit rather than discover after it (the same
                inline-confirm discipline the Reviewed-Summary choose uses; `window.confirm` would style none of
                it and assert none of it in a test). UNLOCKING has no such step: it destroys nothing — the text
                stands and the next revision may change it — and a confirm on the way OUT of a decision is
                friction on the only exit the Editor's lock has.

                Both controls state their reason when they are shut (U-16), and the reasons are the wire's own
                states: an unwritten group has nothing to commit (R1's `revision: 0`), a Writer-held group's text
                is about to move (R4's `writer_busy`, the same read the routes refuse with), a locked group is not
                asking to be locked again, and a shell with no verb says so on the spot. */}
            <div className="sv-group-lock" data-testid="group-lock-controls">
                {locked ? (
                    <button
                        type="button"
                        className="sv-group-unlock-button"
                        data-testid="group-unlock"
                        disabled={!canUnlock}
                        title={
                            canUnlock
                              ? 'Lift the lock so this group can be revised again (R1). Only the Author can do this, whoever made the lock.'
                              : unlockRefusal
                        }
                        onClick={unlock}
                    >
                        Unlock this group
                    </button>
                ) : (
                    <>
                        <button
                            type="button"
                            className="sv-group-lock-button"
                            data-testid="group-lock"
                            disabled={!canLock || lockArmed}
                            title={canLock ? 'Commit this text: it stops being editable and the other groups adapt to it (R1).' : lockRefusal}
                            onClick={() => setLockArmed(true)}
                        >
                            Lock this group in
                        </button>
                        {lockArmed ? (
                            <div className="sv-group-lock-confirm" data-testid="group-lock-confirm-block">
                                <p className="sv-group-notice sv-group-notice--warn" data-testid="group-lock-note">
                                    {groupLockStatement(group)}
                                </p>
                                <div className="sv-summary-actions">
                                    <button
                                        type="button"
                                        className="sv-group-lock-confirm-yes"
                                        data-testid="group-lock-confirm"
                                        disabled={!canLock}
                                        title={canLock ? 'Send the lock (R1).' : lockRefusal}
                                        onClick={lock}
                                    >
                                        Lock it in
                                    </button>
                                    <button
                                        type="button"
                                        className="sv-group-lock-confirm-no"
                                        data-testid="group-lock-cancel"
                                        onClick={() => setLockArmed(false)}
                                    >
                                        Leave it open
                                    </button>
                                </div>
                            </div>
                        ) : null}
                    </>
                )}
                {/* R2 — one line saying who else may lock this group, so the Author is not surprised by a lock
                    they did not make. It is the Setting's effect, stated where the lock lives. */}
                <p className="sv-group-quiet" data-testid="group-lock-who">
                    {isEditorGroupLockingEnabled(view.story)
                        ? 'This Story lets the Editor lock a group in too, on its own judgement over the Critic findings and the Reader score for it. Only you can unlock one.'
                        : 'Only the Author locks a group in on this Story — the Editor-locking Setting is off in Settings.'}
                </p>
            </div>

            {/* The Author's one write against a group. The field starts as the current content, so the control is
                an edit of the book rather than a blank page that silently replaces it. */}
            <div className="sv-group-note" data-testid="group-revise">
                {/* R1 — a locked group is not editable, so the whole edit block is shut rather than hidden: the
                    Author still needs to see the write that used to be here and read WHY it is not available (the
                    pane's rule for every shut control), and the field's own `title` carries the same sentence the
                    submit button states. */}
                {locked ? (
                    <p className="sv-group-quiet" data-testid="group-revise-locked">
                        {`Locked content is settled and cannot be revised (R1). Unlock ${group.title} to write the next revision.`}
                    </p>
                ) : null}
                <textarea
                    aria-label={`Rewrite ${group.title}`}
                    placeholder={`Write the new ${group.title} text — the current revision is above`}
                    value={text}
                    disabled={busy || locked}
                    title={locked ? refuse : undefined}
                    onChange={(event) => setDraft(event.currentTarget.value)}
                />
                <input
                    aria-label="Note for the Editor"
                    placeholder="Why this change"
                    value={note}
                    disabled={busy || locked}
                    onChange={(event) => setNote(event.currentTarget.value)}
                />
                <button
                    type="button"
                    className="sv-summary-revise-button"
                    data-testid="group-revise-submit"
                    disabled={!canRevise}
                    title={canRevise ? 'Send this text to the group as a new revision (R2).' : refuse}
                    onClick={submit}
                >
                    {draft === null ? 'Revise this group' : 'Send this text'}
                </button>
            </div>
        </div>
    );
}

export default SummaryGroupPane;
