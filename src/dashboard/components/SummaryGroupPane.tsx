// R6 / U4 — one SUMMARY GROUP's pane: what it is for, what the Writer has written, what the Reviewer left open.
//
// WHY THIS PANE EXISTS AT ALL. U1's rail puts a button per group in front of the Author, and a button that opens
// nothing is chrome. This is the pane those buttons open: the group's own text, its revision number, and the
// findings the Reviewer aims at it — which had no address anywhere in the workspace before, the defect that made
// a grouped book unreadable in the desk. The five groups share one compiled Overview, so this pane shows what
// makes THIS group different (its purpose line, its findings, its history) and leaves the shared text to the
// Summary overview pane.
//
// WHAT THE HISTORY MAY SAY (U4). `PhraseRevisionRow` is metadata and `chars` — the projection sends no prose for
// a superseded revision. So the pane prints the CURRENT text and the COUNT of archived revisions, and offers no
// control that would open one, because there is no text on the wire to open.
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

import { useState } from 'react';
import type { PhraseFindingRow, PhraseGroupRow } from '../api';
import type { StoryActions, StoryViewData } from './story-contract';
import {
    findingGroups,
    groupArchivedRevisions,
    groupBlockingFindings,
    groupLatestRevision,
    groupOpenFindings,
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
    // The pane's only local state: the Author's draft and the note that goes with it. It is a draft of a WRITE,
    // never a claim about the record, so a poll landing under the Author's fingers cannot corrupt the record —
    // and sending drops the draft, so what appears next is what the server returned.
    const [draft, setDraft] = useState<string | null>(null);
    const [note, setNote] = useState('');

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
    const busy = isGroupWriterBusy(group);
    const written = isGroupWritten(group);
    // The Author's one write against a group. R-T2/F6: the pane shows the group's text ONCE — the prose
    // region above is the reading copy — and the field below is an EDIT that starts empty and says what it
    // replaces. Prefilling the field with the whole current text announced the same paragraphs twice to a
    // screen reader (the prose region, then the field's value), which is noise on the one surface where the
    // Author is meant to read the book.
    const text = draft ?? '';
    // U-16: a disabled control states its reason, and the reason is the wire's own state (or the shell's missing
    // binding), never a guess from run rows.
    const trimmed = text.trim();
    const refuse =
        actions.revisePhraseGroup === undefined
            ? 'The group revise route is not available in this shell.'
            : busy
              ? 'The Writer is rewriting this group right now — the revise route refuses the write until it lands (R4).'
              : trimmed.length === 0
                ? 'Write the new text above first — the route refuses an empty group text (R2), so there is nothing to send yet.'
                : '';
    const canRevise = actions.revisePhraseGroup !== undefined && !busy && trimmed.length > 0;

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

            <p className="sv-pane-label">Current content</p>
            {written && group.content ? (
                /* R-T2/F6 — the ONE reading copy of the group's text. It is prose, not a control, so a screen
                   reader reads the paragraph once; the field below is an empty edit, not a second copy. */
                <p className="sv-summary-text sv-group-content" data-testid="group-content">
                    {group.content}
                </p>
            ) : (
                /* U4's purposeful empty state: why it is empty and what fills it. */
                <p className="sv-group-quiet" data-testid="group-empty">
                    {draft === null
                        ? 'No content yet. The loop writes this group when the Editor puts it in the queue, or you can write it below.'
                        : 'Nothing is on the record yet — what you write here is the first revision.'}
                </p>
            )}

            {/* The facts the wire actually supports: the current revision's own row, and the COUNT of superseded
                ones. No archived prose exists on this read, so nothing here offers to open one. */}
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

            {/* The Author's one write against a group. The field starts as the current content, so the control is
                an edit of the book rather than a blank page that silently replaces it. */}
            <div className="sv-group-note" data-testid="group-revise">
                <textarea
                    aria-label={`Rewrite ${group.title}`}
                    placeholder={`Write the new ${group.title} text — the current revision is above`}
                    value={text}
                    disabled={busy}
                    onChange={(event) => setDraft(event.currentTarget.value)}
                />
                <input
                    aria-label="Note for the Editor"
                    placeholder="Why this change"
                    value={note}
                    disabled={busy}
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
