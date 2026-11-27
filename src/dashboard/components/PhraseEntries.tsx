// T-W4 — the PHRASE-GENERIC surface: one implementation of "a phrase's entry rows" and "one entry's pane", which
// the Summary (Phrase ①) and the Plotlines (Phrase ②) phrases both render.
//
// WHY THIS IS ONE COMPONENT AND NOT TWO. Both phrases are the SAME model on the wire: a phrase row, N entry rows
// (`PhraseGroupRow` — five Summary groups, or one chapter entry per chapter the Plotlines brief declares), each
// with its revisions, its findings, its lock and the Author's one hand write
// (`POST …/phrases/groups/:groupId/revise`). A forked pair of panes would mean two places to fix every time a
// finding-scope rule, a lock badge or a `writer_busy` refusal changes — and the fork's two copies drift by
// construction, which is the defect class this package keeps hitting. So the Summary panes call these components,
// and so does Phrase ②; the only thing a caller supplies is which phrase it is (`PhraseSurface`).
//
// WHAT STAYS OUT OF HERE, ON PURPOSE. The reviewed Summary and the Author's Choose (D-67/D-68) are Phrase ①'s
// whole-Overview verb — a reviewed vector over five named sections, with a legacy `summaries` mirror. Phrase ② has
// no mirror to keep in step and its whole-phrase decision is the phase gate, so that strip stays in
// `SummaryOverviewPane` rather than becoming a slot both phrases have to reason about. Same reason the Plotlines
// brief card lives in `PlotlinesPhrasePane`: it is that phrase's structure decision, not a shared shape.
//
// THE RENDER IS UNCHANGED FOR THE SUMMARY. These components emit the class names, test ids and sentences the
// Summary panes have always emitted (`testIdPrefix:'summary'` reproduces `summary-group-*`; the entry pane keeps
// `group-pane-*`/`group-revise-submit`), because the phrase model is the wire's, and renaming its vocabulary in a
// feature wave would break pins that have nothing to do with Phrase ②.
//
// EVERY RULE HERE IS READ THROUGH `story-contract` (identity is the row's UUID, a finding's scope is `targeted`,
// a lock is `locked === true`, a score is the newest `scores[]` row). This file adds no rules of its own: it adds
// a place for two phrases to render the same ones.
import { useState } from 'react';
import type { PhraseFindingRow, PhraseGroupRow } from '../api';
import type { StorySelection } from './story-nav';
import { plotlineGroupRef, summaryGroupRef } from './story-nav';
// T2 — the entry's prose region is rendered Markdown (`MarkdownText.tsx`); the diff beside it is not (see the
// branch at `:965`).
import { MarkdownText } from './MarkdownText';
import { RevisionDiff } from './RevisionDiff';
import {
    canAuthorLockGroup,
    canAuthorUnlockGroup,
    // R5 — the chapter contract's two directions: `chapterEntryDraft` decodes the entry's stored text back into
    // the ORDERED beat/dialogue rows the Author edits, and `ChapterEntryDraft` is that row model.
    chapterEntryDraft,
    type ChapterEntryDraft,
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
    isGroupWriterBusy,
    isGroupWritten,
    // T-W4 — the SUMMARY's dial question, kept beside the Plotlines' one below: the shared entry pane asks the
    // per-phrase question (`isGroupSummary` for the prose editor, `isPlotlinesGroups` for the contract editor),
    // and the two dials are independent settings on the Story row.
    isGroupSummary,
    // T-W4 — the per-phrase dial question, so the entry pane's legacy guard asks about the phrase it renders.
    isPlotlinesGroups,
    phraseGroupById,
    phraseGroups,
    phraseReadError
} from './story-contract';
import type { StoryActions, StoryViewData } from './story-contract';

// ---------------------------------------------------------------------------
// The phrase descriptor: everything two phrases disagree about, in one object
// ---------------------------------------------------------------------------

/**
 * WHICH phrase a shared pane is rendering.
 *
 * `testIdPrefix` is the load-bearing field for the pins: the Summary's rows keep their `summary-group-*` ids
 * exactly, and Phrase ② gets its own namespace so a test can address a chapter entry without praying that no
 * Summary row shares the id. The nouns exist because the copy has to say what the Author is looking at —
 * `Revision 3` over a chapter entry is not a group's revision, and a pane that printed "group" over chapter
 * contracts would be describing the wire rather than the book.
 */
export interface PhraseSurface {
    /** The rail panel these rows navigate to — the selection this surface owns. */
    panel: 'summary' | 'plotlines';
    /** The `data-testid` namespace for the row list (`summary` keeps the existing pins byte-identical). */
    testIdPrefix: string;
    /** One row's test id. The Summary's is `summary-group-<key>` because that is what its acceptance tests address
     * today (T-W4 changes phrases, not pinned vocabulary); Phrase ② says `plotlines-entry-<key>`, because a test
     * that has to say "group" about a chapter contract is a test that will mislead the next Author-facing change. */
    rowId: (key: string) => string;
    /**
     * The selection ref a row click hands the rail: the row's UUID under the PHRASE's own prefix
     * (`story-nav.summaryGroupRef` for Phrase ①, `story-nav.plotlineGroupRef` for Phrase ②).
     *
     * The phrase is part of the address. The rail resolves a ref against ONE phrase's rows, so a bare UUID would
     * leave a Summary selection and a chapter-entry selection indistinguishable on a book that has both — and
     * `selectionExists` could not tell a stale ref from a cross-phrase one, which is how a stale click ends up
     * opening the wrong row instead of falling back to the phrase's own pane.
     */
    refOf: (id: string) => string;
    /** One entry's own pane: `group-pane-<key>` for the Summary's pins, `plotlines-pane-<key>` for Phrase ②. */
    paneId: (key: string) => string;
    /** The four read-state ids, spelled per surface for the same reason (see `PhraseEntryDetail`). */
    paneLegacyId: string;
    panePendingId: string;
    paneErrorId: string;
    paneStaleId: string;
    /** The id of the line that prints the read's own failure sentence (R-T2/F2). */
    readErrorId: string;
    /** One entry, in the Author's words: `group`, or `chapter entry`. */
    entry: string;
    /** Many entries. */
    entries: string;
    /**
     * The refusal shown in the SEND control's `title` while the Author's write is still empty.
     *
     * It is per-surface copy, not a composed sentence, because the two phrases' writes are genuinely different
     * objects: a Summary group's text IS the prose the Author typed (R2 refuses an empty group text), while a
     * chapter entry's text is COMPOSED from its contract fields (P4 refuses an entry without `must_happen` and
     * `must_change`). "an empty text" would be true of both and use to neither, and the Summary's wording is a
     * pinned string its panes have always printed.
     */
    emptyWriteLine: string;
    /**
     * R5 (W2) — the sentence the SEND control carries BEFORE the write is open, and ONLY a surface that has an
     * open step supplies it.
     *
     * A Summary group's write is one textarea that is always on screen, so there is nothing to open and the field
     * stays absent. A chapter entry's write is a LIST of rows, and opening it prefilled is the point (R5): the
     * rows start as the contract the entry carries, so the first press opens the editor and the second one sends.
     * A control that shut that first press with an "empty write" refusal would be refusing a request the Author
     * never made — and the reason has to say what the press DOES.
     */
    openWriteLine?: string;
    /** The line while the phrase read is still on its way. */
    pendingLine: string;
    /** The line when the read FAILED — with the server's sentence appended by the caller. */
    failureLine: string;
    /** What to do after a failure, in the surface's own terms. */
    failureNotice: string;
    /** The line when the rail's ref names a row that is no longer part of the phrase. */
    staleLine: string;
    /** The fallback button on that stale line. */
    staleAction: string;
}

/** Phrase ① — the five Summary groups. The wording is verbatim what the Summary panes printed before T-W4. */
export const SUMMARY_SURFACE: PhraseSurface = {
    panel: 'summary',
    testIdPrefix: 'summary',
    rowId: (key) => `summary-group-${key}`,
    paneId: (key) => `group-pane-${key}`,
    refOf: summaryGroupRef,
    paneLegacyId: 'group-pane-legacy',
    panePendingId: 'group-pane-pending',
    paneErrorId: 'group-pane-error',
    paneStaleId: 'group-pane-stale',
    readErrorId: 'group-read-error',
    entry: 'group',
    entries: 'groups',
    emptyWriteLine:
        'Write the new text above first — the route refuses an empty group text (R2), so there is nothing to send yet.',
    pendingLine: 'This Summary is written as five groups. Their content arrives with the phrase read.',
    failureLine: 'The Summary group rows could not be read:',
    failureNotice:
        'This Story is group-managed, so its groups exist — the read that lists them failed. The pane cannot show this group until it answers; reload the Story to try again.',
    staleLine: 'This group is no longer part of the Summary.',
    staleAction: 'Open Summary'
};

/** Phrase ② — the chapter entries. Every sentence names a chapter entry, because that is what the row is. */
export const PLOTLINE_SURFACE: PhraseSurface = {
    panel: 'plotlines',
    testIdPrefix: 'plotlines',
    rowId: (key) => `plotlines-entry-${key}`,
    paneId: (key) => `plotlines-pane-${key}`,
    refOf: plotlineGroupRef,
    paneLegacyId: 'plotlines-pane-legacy',
    panePendingId: 'plotlines-pane-pending',
    paneErrorId: 'plotlines-pane-error',
    paneStaleId: 'plotlines-pane-stale',
    readErrorId: 'plotlines-read-error',
    entry: 'chapter entry',
    entries: 'chapter entries',
    emptyWriteLine:
        'Write at least one beat first — the route composes this chapter entry’s text and its plotlines contract from the beats IN THE ORDER you list them, and an entry with no beat is refused (P4).',
    // R5 — the beat rows open PREFILLED from the contract the entry carries today, so the first press is not a
    // write and must not read like one.
    openWriteLine:
        'Open this chapter entry’s beats — the rows start as the contract the entry carries now, in the order they happen, and nothing is sent until you press again (R5).',
    pendingLine:
        'This Plotlines phrase is written as chapter entries. Their contracts arrive with the phrase read.',
    failureLine: 'The Plotlines chapter entries could not be read:',
    failureNotice:
        'This Story has started Phrase 2 on the chapter-entry pipeline, so its entries exist — the read that lists them failed. Nothing here is a verdict about the contracts; reload the Story to read the entries again.',
    staleLine: 'This chapter entry is no longer part of the phrase.',
    staleAction: 'Open Plotlines'
};

/**
 * T5 — the movement between an entry's LATEST score and the pass before it, in words.
 *
 * A delta printed as `+6` leans on a sign and a colour; a reader who cannot see the colour still needs the
 * sentence. `undefined` on a first pass is the honest answer — "never scored" and "scored zero" are different
 * claims, so nothing subtracts an invented zero. `flat` says `unchanged`, because `up 0` is not a sentence.
 */
function scoreDelta(score: number, previousScore?: number): { tone: 'up' | 'down' | 'flat'; text: string } | undefined {
    if (previousScore === undefined) return undefined;
    if (previousScore === score) return { tone: 'flat', text: `unchanged from ${previousScore}%` };

    return previousScore < score
        ? { tone: 'up', text: `up ${score - previousScore} from ${previousScore}%` }
        : { tone: 'down', text: `down ${previousScore - score} from ${previousScore}%` };
}

// ---------------------------------------------------------------------------
// One entry's state word, and the rows that navigate
// ---------------------------------------------------------------------------

/**
 * The entry's one state word, shared by the rail's row and the overview pane's row so the two can never disagree.
 *
 * WHY THERE IS NO `review_state` ON A ROW. The phrase read carries no per-entry verdict: what an entry owes is the
 * findings aimed at it (R3) and whether the Writer is replacing its text right now. So the word comes from those two
 * things and from the phrase's own cost bar (`summaryBlockingCost`, the dial-aware one), in that priority — a row the
 * Writer is holding is not also "blocking", it is moving. The rule is per-ROW, not per-phrase, which is exactly why
 * one function serves both phrases.
 */
export function entryStateLabel(
    view: StoryViewData,
    entry: PhraseGroupRow
): { label: string; tone: 'blocking' | 'open' | 'done' | 'todo' | 'writer' } {
    if (isGroupWriterBusy(entry)) {
        return { label: 'writer', tone: 'writer' };
    }

    if (!isGroupWritten(entry)) {
        return { label: 'to write', tone: 'todo' };
    }

    // §6.8's COST bar, not a door: a critical/major finding open on this row makes the row say `blocking`,
    // while a minor or taste note is a note and the row says `open`. D-78 — the word names the band the
    // Reviewer weighs (exactly the set `summaryBlockingCost` gates, the same number the Overview's row and
    // this rail's badge print); it is NOT a promise that the sign-off waits, because the accept VOIDS these
    // rows (L-25b). The state word has to stay — a row with a critical open on it is not `clean` either.
    if (groupBlockingFindings(view, entry.id).length > 0) {
        return { label: 'blocking', tone: 'blocking' };
    }

    if (groupOpenFindings(view, entry.id).length > 0) {
        return { label: 'open', tone: 'open' };
    }

    return { label: 'clean', tone: 'done' };
}

/**
 * One entry row: the state word, the findings aimed at it, and the count of revisions the loop has superseded.
 *
 * No archived prose (U3): `PhraseRevisionRow` carries `chars`, not text, so this row prints the COUNT and offers
 * nothing to open. The row is one button because the row IS the pane — clicking it navigates, and the entry's own
 * verbs live in that pane. The Writer holding the job does not disable it: reading a row whose text is already on
 * the wire is never blocked, only editing it is (U5).
 *
 * T-W4: the row is phrase-agnostic. It navigates to `surface.panel` with the row's UUID as the ref, and its test id
 * comes from `surface.testIdPrefix`, so the Summary keeps its pinned `summary-group-*` ids and Phrase ② gets its
 * own namespace. The state word, the findings count and the archived count are read off the same contract
 * selectors for both phrases — the wire's rows are the same shape.
 */
export function PhraseEntryRow({
    view,
    entry,
    surface,
    selected,
    onSelect
}: {
    view: StoryViewData;
    entry: PhraseGroupRow;
    surface: PhraseSurface;
    selected: boolean;
    onSelect?: (selection: StorySelection) => void;
}) {
    const state = entryStateLabel(view, entry);
    const open = groupOpenFindings(view, entry.id);
    const blocking = groupBlockingFindings(view, entry.id);
    const archived = groupArchivedRevisions(entry).length;
    const written = isGroupWritten(entry);

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
            data-testid={surface.rowId(entry.key)}
        >
            {/* R-T2/F4 — the row IS the pane, so the selected one says so in the accessibility tree as well as in
                ink: `aria-current="true"` is the selected semantics for a control that navigates. */}
            <button
                type="button"
                className="sv-group-row-open"
                onClick={() => onSelect?.({ panel: surface.panel, ref: surface.refOf(entry.id) })}
                aria-current={selected ? 'true' : undefined}
            >
                <span className="sv-group-row-name">{entry.title}</span>
                {/* U7 — the same word boundary the rail's rows got: an accessible name is built from TEXT, and flex
                    `gap` is not text, so without these separators the row announces
                    "Promiseblocking3 open findings". A whitespace-only text node is not a flex item, so the layout
                    is untouched. The busy span is last, so its separator is guarded; the state span and the
                    findings/quiet span always render. */}
                {' '}
                <span className="sv-group-row-state" data-tone={state.tone}>
                    {state.label}
                </span>
                {' '}
                {open.length > 0 ? (
                    <span
                        className="sv-group-row-findings"
                        data-testid={`${surface.rowId(entry.key)}-findings`}
                    >
                        {`${open.length} open finding${open.length === 1 ? '' : 's'}` +
                            // D-78 — the clause names the COST BAND the number counts, never a wait. The old
                            // ` · holds the sign-off` promised the Accept would stay shut over these rows; it
                            // does not (the accept voids them), and the words now match the Overview's own
                            // review line (`SummaryOverviewPane`, ` · N critical/major`) and the confirm line
                            // that says the click voids them.
                            (blocking.length > 0 ? ` · ${blocking.length} critical/major` : '')}
                    </span>
                ) : (
                    <span className="sv-group-row-quiet">
                        {/* U3: the archived COUNT, never the archived text. R-T2/F5: the count only when it is worth
                            reading — a row at its first revision has `0 archived`, which states a nothing beside a
                            row already labelled `clean`. */}
                        {!written
                            ? 'nothing written yet'
                            : archived > 0
                              ? `${archived} archived`
                              : 'nothing superseded'}
                    </span>
                )}
                {isGroupWriterBusy(entry) ? (
                    <>
                        {' '}
                        <span className="sr-only">the Writer is rewriting this {surface.entry} now</span>
                    </>
                ) : null}
            </button>
        </li>
    );
}

/**
 * The entry list — one row per entry, in the contract's composition order.
 *
 * The caller owns the empty and loading states (they differ per phrase: the Summary's counts five groups and names
 * the reviewed Summary, Phrase ②'s names the brief and the chapter count). This component only renders rows, so the
 * two surfaces cannot draw the same row two different ways.
 */
export function PhraseEntryRows({
    view,
    entries,
    surface,
    selection,
    onSelect,
    label
}: {
    view: StoryViewData;
    entries: readonly PhraseGroupRow[];
    surface: PhraseSurface;
    selection?: StorySelection;
    onSelect?: (selection: StorySelection) => void;
    /** The list's accessible name — the phrase's own words, since a screen reader announces it as the group label. */
    label: string;
}) {
    return (
        <ul className="sv-group-rows" aria-label={label} data-testid={`${surface.testIdPrefix}-group-rows`}>
            {entries.map((entry) => (
                <PhraseEntryRow
                    key={entry.id}
                    view={view}
                    entry={entry}
                    surface={surface}
                    selected={selection?.ref === surface.refOf(entry.id)}
                    onSelect={onSelect}
                />
            ))}
        </ul>
    );
}

// ---------------------------------------------------------------------------
// The read's three non-render states, in the surface's own words
// ---------------------------------------------------------------------------

/**
 * The phrase read's pending / failed / wrong-model lines, shared so both phrases answer the same three questions
 * the same way: is the read still coming, did it fail, or is this book not this model at all.
 *
 * WHICH ONE IS DRAWN is the caller's decision — `phrase === null` cannot tell "in flight" from "failed" (R-T2/F2),
 * and only the store's cached sentence can, so this component receives the sentence rather than going looking for
 * one. That is also why the ids are passed in: the Summary pins `summary-overview-error` and `group-pane-pending`
 * side by side, and Phrase ② wants the same three states under its own namespace.
 */
export function PhraseReadState({
    state,
    surface,
    testId,
    failure,
    readErrorId,
    overrideLine,
    overrideNotice
}: {
    state: 'pending' | 'failed' | 'legacy';
    surface: PhraseSurface;
    testId: string;
    /** The store's cached sentence, when the read failed (L-13 — printed verbatim, never swallowed). */
    failure?: string;
    /**
     * The id of the failure line, when this pane's is not the surface's default. The Summary's two panes pin
     * different ones (`summary-read-error` on the Overview, `group-read-error` on the group pane), and a shared
     * component may not pick one and silently rename the other.
     */
    readErrorId?: string;
    /** A surface-specific line, when the generic one would be wrong for this pane (e.g. the Overview's counts). */
    overrideLine?: string;
    /** The Overview's failure notice is about the Overview, not about one group's pane — same reason as above. */
    overrideNotice?: string;
}) {
    if (state === 'failed') {
        return (
            <div className="sv-pane" data-testid={testId}>
                <p className="pane-state" data-testid={readErrorId ?? surface.readErrorId}>
                    {`${surface.failureLine} ${failure ?? 'the read did not answer'}`}
                </p>
                <p className="sv-group-notice sv-group-notice--warn">{overrideNotice ?? surface.failureNotice}</p>
            </div>
        );
    }

    if (state === 'legacy') {
        return (
            <div className="sv-pane" data-testid={testId}>
                <p className="pane-state">{overrideLine ?? ''}</p>
            </div>
        );
    }

    return (
        <div className="sv-pane" data-testid={testId}>
            <p className="pane-state">{overrideLine ?? surface.pendingLine}</p>
        </div>
    );
}

// ---------------------------------------------------------------------------
// One finding row (U4's cross-group chips), and the findings block
// ---------------------------------------------------------------------------

/**
 * One open finding, with the other entries it spans (U4's cross-group chips).
 *
 * The wire gives a finding a cost, a state, a title and its scope (`targeted`, plus `unscoped` when the record
 * named no entry at all). It carries no evidence or detail fields — those live in the agent transcript — so the row
 * is one line: cost, the claim type, the title the engine wrote, how many times the Reviewer had to raise it, and a
 * chip for every OTHER entry the same finding aims at. The chips are what make a cross-entry finding legible: the
 * Author sees that the row also stands in another pane, and that its fix has to land on more than one row.
 */
function FindingRow({
    finding,
    entries,
    of
}: {
    finding: PhraseFindingRow;
    entries: readonly PhraseGroupRow[];
    of: PhraseGroupRow;
}) {
    // The other entries this finding is aimed at, resolved by the contract's rule (`targeted`, and an unscoped
    // legacy row meaning every entry) — so the chips can never claim a scope the server did not record.
    const others = findingGroups(finding, entries).filter((entry) => entry.id !== of.id);
    // R3: the entries whose text has NOT yet answered this finding. When that is more than this one, the fix is
    // still waiting on another pane's revision — the one fact a flat finding list otherwise hides.
    const missing = (finding.missing ?? []).filter((id) => id !== of.id);

    return (
        <li className="sv-group-finding" data-cost={finding.cost} data-state={finding.state} data-testid={`finding-${finding.id}`}>
            {/* The cost word and the sentence the Reviewer wrote are two spans, and an accessible/linear read
                concatenates spans: the separator keeps them two words instead of "criticalthe promise…". */}
            {/* T3 — WHAT the row claims, said before what repairing it costs. `cost` is the repair bill; this is
                the claim type: an Issue is the text contradicting a commitment the Seed made, a Proposal is the
                text being merely improvable. The Author's answer differs — one has to be repaired, the other is
                weighed on merit — so a findings list that prints only costs cannot tell the two apart. Absence
                means Issue (the legacy reading, pinned in `api.ts:PhraseFindingRow`), and the word is TEXT rather
                than colour so it survives greyscale. */}
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
            {/* Every following span needs the same boundary: the re-raise count, the cross-entry chips and the two
                status sentences all ride this one row. */}
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
                        {/* The engine's TITLES, not the ids: a chip an Author can read is the point of the chip.
                            The space text node between chips is for the reader, not the eye: an accessible name is
                            built from TEXT, so without it a cross-entry finding announces "…also Promisealso Theme". */}
                        {others.map((entry, index) => (
                            <span key={entry.id} className="sv-group-finding-chip">
                                {index > 0 ? ' ' : null}
                                {`also ${entry.title}`}
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
            {missing.length > 0 && others.length > 0 ? (
                <>
                    {' '}
                    <span className="sv-group-finding-count">
                        {`still missing on ${missing
                            .map((id) => entries.find((entry) => entry.id === id)?.title ?? id)
                            .join(', ')}`}
                    </span>
                </>
            ) : null}
        </li>
    );
}

// ---------------------------------------------------------------------------
// The Author's one write: TWO editors, because the two phrases' texts are different objects
// ---------------------------------------------------------------------------

/**
 * R5 (W2) — THE CHAPTER CONTRACT, AS THE AUTHOR EDITS IT: an optional heading, ORDERED beat rows, and optional
 * ORDERED dialogue rows.
 *
 * WHY ROWS AND NOT PROSE BOXES. The contract IS two lists (`PhrasePlotpointsInput`: `heading` + `beats` +
 * `dialogue`), and array order is the content — the beats are chronological, so C-7 checks the prose against every
 * one of them IN ORDER and C-3/C-8 against the LAST. The pane used to offer six single-line prose fields named
 * `Must happen`/`Must change`/`POV`/`Setups`/`Payoffs`; four of those fields are deprecated on the row
 * (`shared/types.ts:Plotline`) and the two that survive were a list in disguise — one box holding several events
 * separated by `;`, which is exactly the shape `plotlineBeatsOf` has to split back apart. A row per beat is the
 * contract's own shape: it can be ordered, added to, and removed from, and the desk sends what the Author arranged
 * rather than a paragraph the route has to guess at.
 *
 * WHY THE ROWS OPEN PREFILLED (and the prose editor still opens empty). The reading copy above is the composed text
 * the loop installed, and an empty list of rows under it would ask the Author to retype a contract from memory —
 * a beat dropped from memory is a beat C-7 stops checking. So opening this editor SEEDS the rows from the entry's
 * stored text (`chapterEntryDraft`), and the reading copy steps aside while they are open: the rows ARE the text
 * being edited, and printing both would read the same contract twice (the R-T2/F6 pin stays exactly where it was
 * for the Summary's prose textarea, which still opens empty).
 */
/**
 * OPENS the contract editor. The rows are the entry's own contract (`chapterEntryDraft` decodes the stored text),
 * with ONE exception: an entry with nothing on the record yet — a row the loop has not written — opens with a single
 * blank beat, because a list with no rows at all gives the Author nothing to type into and an "Add a beat" button
 * they should not have to press to say the first thing.
 */
const openEntryDraft = (content: string | undefined): ChapterEntryDraft => {
    const draft = chapterEntryDraft(content);

    return { ...draft, beats: draft.beats.length > 0 ? draft.beats : [''] };
};

/** Trims a contract list and drops the blanks, KEEPING THE ORDER — the desk's half of `contractListOf`. */
const cleanRows = (rows: string[]): string[] =>
    rows.map((row) => row.trim()).filter((row) => row !== '');

/** Moves one row to `to`, the one rule every reorder button shares; out-of-range indexes leave the list alone. */
const moveRow = (rows: string[], from: number, to: number): string[] => {
    if (to < 0 || to >= rows.length || from < 0 || from >= rows.length) return rows;

    const next = [...rows];
    const [row] = next.splice(from, 1);

    next.splice(to, 0, row);

    return next;
};

/** One ordered section of the contract editor — the beats, or the dialogue. See {@link ContractRows}. */
interface ContractRowsProps {
    /** The section's label, with its `*` when the route requires at least one row. */
    label: string;
    /** What ONE row is called, in its own accessible name and in the tooltips: `beat`, or `line`. */
    noun: string;
    /** The `data-testid` namespace: `group-beat` / `group-dialogue`. A test must be able to address the beats
     * without guessing that the dialogue rows exist, and vice versa. */
    testId: string;
    /** The rows as the Author has them, IN ORDER. The array index IS the beat's position in the chapter. */
    rows: string[];
    onChange: (rows: string[]) => void;
    /** A Writer pass or a lock holds the entry, so every control in the section is shut (U-16 states why). */
    disabled: boolean;
    /** The floor on removals: a contract keeps its last beat, a dialogue section may go empty. */
    minRows: number;
    /** The section's own explanation, carried by the inputs and the add control (U-16). */
    hint: string;
    /** The add control's label. */
    addLabel: string;
}

/**
 * R5 (W2) — ONE ORDERED LIST OF THE CONTRACT, as rows the Author can edit, reorder, add to, and remove.
 *
 * WHY A SECTION COMPONENT AND NOT INLINE MARKUP: the beats and the dialogue are the SAME shape — a list of strings
 * where position is meaning — and two hand-written copies of "up, down, remove, add" drift the moment one gets a
 * fix. One component means one set of `data-testid`s per section (`-input-N`, `-up-N`, `-down-N`, `-remove-N`,
 * `-add`), which is also what lets a test pin the ORDER rather than the set.
 *
 * WHY THE BUTTONS SAY UP AND DOWN AND NOT MOVE-1/MOVE+1: the row number is printed beside the field, so an
 * unlabelled arrow would describe a glyph instead of an act, and the accessible name carries the row it moves.
 *
 * WHY THE LAST BEAT CANNOT BE REMOVED (`minRows`): an entry with no non-blank beat is the write the route refuses
 * (`contractListOf` drops the blanks, so a list of blanks is no contract), and a control that let the Author delete
 * into that state would be a refusal they had to discover by clicking. The dialogue section's floor is 0 — a chapter
 * that owes no lines is a normal chapter — and closing it leaves the key OFF the body, never an empty list.
 */
function ContractRows({ label, noun, testId, rows, onChange, disabled, minRows, hint, addLabel }: ContractRowsProps) {
    /** Replaces ONE row's text, leaving the others and their order alone. */
    const setRow = (index: number, value: string): void =>
        onChange(rows.map((row, each) => (each === index ? value : row)));

    return (
        <div className="sv-contract-rows" data-testid={`${testId}-rows`}>
            <span className="sv-group-plotpoint-label sv-contract-label" data-testid={`${testId}-label`}>
                {label}
            </span>
            {rows.map((row, index) => (
                // The index is the row's MEANING (beat 3 is beat 3), and the array is the only source of its text,
                // so an index key is the honest key here: a reorder re-renders the values in their new positions.
                <div className="sv-contract-row" key={`${testId}-row-${index}`} data-testid={`${testId}-row-${index}`}>
                    <span className="sv-contract-row-order" data-testid={`${testId}-order-${index}`}>
                        {index + 1}
                    </span>
                    <input
                        className="sv-contract-row-input"
                        aria-label={`${noun} ${index + 1} of ${rows.length}`}
                        data-testid={`${testId}-input-${index}`}
                        value={row}
                        disabled={disabled}
                        title={hint}
                        onChange={(event) => setRow(index, event.currentTarget.value)}
                    />
                    <button
                        type="button"
                        className="button button--ghost sv-contract-row-move"
                        data-testid={`${testId}-up-${index}`}
                        disabled={disabled || index === 0}
                        aria-label={`Move ${noun} ${index + 1} earlier`}
                        title={index === 0 ? 'This is already the first one.' : `Move this ${noun} one place earlier (the order is the contract).`}
                        onClick={() => onChange(moveRow(rows, index, index - 1))}
                    >
                        Up
                    </button>
                    <button
                        type="button"
                        className="button button--ghost sv-contract-row-move"
                        data-testid={`${testId}-down-${index}`}
                        disabled={disabled || index === rows.length - 1}
                        aria-label={`Move ${noun} ${index + 1} later`}
                        title={
                            index === rows.length - 1
                                ? 'This is already the last one.'
                                : `Move this ${noun} one place later (the order is the contract).`
                        }
                        onClick={() => onChange(moveRow(rows, index, index + 1))}
                    >
                        Down
                    </button>
                    <button
                        type="button"
                        className="button button--ghost sv-contract-row-remove"
                        data-testid={`${testId}-remove-${index}`}
                        disabled={disabled || rows.length <= minRows}
                        aria-label={`Remove ${noun} ${index + 1}`}
                        title={
                            rows.length <= minRows
                                ? `A ${noun === 'beat' ? 'chapter entry needs at least one beat — the route refuses an entry without one (P4)' : 'chapter already owes no lines'} — nothing left to remove.`
                                : `Take this ${noun} out of the contract.`
                        }
                        onClick={() => onChange(rows.filter((_, each) => each !== index))}
                    >
                        Remove
                    </button>
                </div>
            ))}
            <button
                type="button"
                className="button button--ghost sv-contract-row-add"
                data-testid={`${testId}-add`}
                disabled={disabled}
                title={hint}
                onClick={() => onChange([...rows, ''])}
            >
                {addLabel}
            </button>
        </div>
    );
}

/**
 * ONE entry's pane: its purpose, its text, its revision number, its findings, its lock, and the Author's write.
 *
 * THE TWO EDITORS ARE THE ONLY REAL FORK. A Summary group's text is prose, so the write is `{content, note}`. A
 * chapter entry's text is a DERIVATION of its contract fields (`phrase/plotpoints.ts:chapterEntryContent`), so the
 * write is `{plotpoints, note}` and the prose shown above is what the server composed — an Author editing the prose
 * there would be editing a rendering. `editor` picks which control appears; everything else (badges, notices, the
 * score marks, the meta rows, the findings, the lock pair) is the same wire shape read the same way.
 *
 * WHY ONE EDIT CONTROL, AND WHY IT IS SOMETIMES SHUT. `POST …/phrases/groups/:id/revise` (R2) is the Author's one
 * write against a row: the Editor replans and the Writer rewrites from it. The control is disabled off
 * `row.writer_busy` — the SAME read the route refuses with (F8/R4) — and U-16 is satisfied by the `title` that
 * states the reason rather than by a grey rectangle. A LOCKED row is never editable (R1), and the refusal is
 * printed beside the button that raised it (`story-contract.groupLockError`, the store's per-row cache), so a
 * refusal never paints a locked badge on a row the route kept open.
 *
 * THE MODEL IT READS is `StoryViewData` plus the row's UUID from the rail's selection ref, looked up by id
 * (`phraseGroupById`), never by index or `order` — so a refetch, a reorder or a retired entry cannot move the pane
 * to a different row (U2/U6). For Phrase ② the caller passes the SURFACE-SWAPPED view
 * (`story-contract.plotlinesSurfaceView`), which is why no selector here needs to know which phrase it is on.
 */
export function PhraseEntryDetail({
    view,
    surface,
    actions = {},
    entryId,
    editor,
    onSelect
}: {
    view: StoryViewData;
    surface: PhraseSurface;
    /** The pinned action surface; every method is optional, and an absent one says so on the control. */
    actions?: StoryActions;
    /** The entry the rail's selection addresses — its UUID, never its index or `order` (U2). */
    entryId?: string;
    /** Which write this phrase's rows take: prose (`content`), or the contract fields (`plotpoints`). */
    editor: 'content' | 'plotpoints';
    onSelect?: (selection: StorySelection) => void;
}) {
    // The pane's local state, all of it about a WRITE in progress and none of it about the record:
    //   - `draft`/`contract`/`note` are the Author's pending revise body, dropped on send so what appears next
    //     is the server's answer (`contract` is the chapter entry's row list, and it starts CLOSED — see below);
    //   - `lockArmed` is only the confirmation STEP the lock sits on (R1) — never a claim that the row is locked.
    //     The badge below reads `locked` off the phrase rows, so a refused lock leaves the pane saying `unlocked`
    //     in the same frame it prints the refusal.
    const [draft, setDraft] = useState<string | null>(null);
    /**
     * R5 — the chapter contract being rewritten, or `null` while the editor is CLOSED.
     *
     * `null` is a state, not an empty value: it is what keeps the reading copy on screen and gives the first press
     * something to do (open the rows, prefilled) instead of sending a write the Author has not read yet. Closing
     * the editor discards the rows — the record is the entry's stored text, and nothing here is a draft worth
     * keeping across a pane change (P1: the durable store is the only memory).
     */
    const [contract, setContract] = useState<ChapterEntryDraft | null>(null);
    const [note, setNote] = useState('');
    const [lockArmed, setLockArmed] = useState(false);

    // A book whose phrase is not the entry model cannot select an entry, so this is the defensive answer, not a
    // branch the shell produces. THE QUESTION IS PER-PHRASE, and the two dials are independent: a Summary grouped
    // on `summary_mode:'groups'` says nothing about Phrase ②, whose own Setting (`plotlines_mode`) decides whether
    // chapter entries exist. So the entry pane asks about the phrase it is rendering — the Summary's own mode for
    // the prose editor, and `isPlotlinesGroups` (the phrase read's `mode`, falling back to the Story row) for the
    // contract editor — otherwise a grouped Summary would render a chapter-entry pane over a classic Plotlines book
    // and print "no chapter entries" as if the phrase were mid-read.
    if (editor === 'content' ? !isGroupSummary(view) : !isPlotlinesGroups(view)) {
        return (
            <PhraseReadState
                state="legacy"
                surface={surface}
                testId={surface.paneLegacyId}
                overrideLine={
                    editor === 'content'
                        ? "This Story's Summary is still compiled from sampling rounds, so it has no groups to open."
                        : "This Story's Plotlines are still written by the classic plotline tools, so it has no chapter entries to open."
                }
            />
        );
    }

    const phrase = view.phrase;

    if (phrase === undefined || phrase === null) {
        // R-T2/F2 — A FAILED READ IS NOT A SLOW ONE. The store caches the route's own sentence per Story, so the
        // pane can say what broke and what to do, instead of promising text that will not arrive until the Story
        // is reloaded. The Story payload stays current: the failure belongs to the phrase read.
        const failure = phraseReadError(view);

        return (
            <PhraseReadState
                state={failure === undefined ? 'pending' : 'failed'}
                surface={surface}
                testId={failure === undefined ? surface.panePendingId : surface.paneErrorId}
                failure={failure}
            />
        );
    }

    const entry = phraseGroupById(view, entryId);

    // U6's stale-ref answer: the entry was retired, the book switched pipelines, or the ref is the last book's. The
    // rail already falls back to the phrase's own pane (`selectionExists`); this line is what the Author sees when
    // the fallback has not been applied yet — and it is not an empty pane that looks like an unwritten row, which
    // would be a lie about the book.
    if (entry === undefined) {
        return (
            <div className="sv-pane" data-testid={surface.paneStaleId}>
                <p className="pane-state">{surface.staleLine}</p>
                <div className="sv-summary-actions">
                    <button type="button" onClick={() => onSelect?.({ panel: surface.panel })}>
                        {surface.staleAction}
                    </button>
                </div>
            </div>
        );
    }

    const entries = phraseGroups(view);
    const open = groupOpenFindings(view, entry.id);
    const blocking = groupBlockingFindings(view, entry.id);
    const archived = groupArchivedRevisions(entry);
    const latest = groupLatestRevision(entry);
    // R2 / U3 — the ONE archived body the wire carries: the revision immediately before the latest. The pane
    // renders the current text as a grouped word diff against it, and stays a plain paragraph at revision 1.
    const previous = entry.previous_content;
    const busy = isGroupWriterBusy(entry);
    const written = isGroupWritten(entry);
    // R1 — THE LOCK, read through the contract's selectors, so the rail's mark, this pane's badge and the two
    // controls underneath it are four readings of ONE rule. `locked` absent means open, and the refusals below are
    // the wire's own states — the shell's missing verb, the Writer holding the text (R4's `writer_busy`), a row
    // with no revision to commit (R1's `revision: 0`), or a lock already standing — never a guess from run rows.
    const locked = isGroupLocked(entry);
    const lockError = groupLockError(view, entry.id);
    const lockRefusal = groupLockRefusal(entry, actions.lockPhraseGroup !== undefined);
    const unlockRefusal = groupUnlockRefusal(entry, actions.unlockPhraseGroup !== undefined);
    const canLock = canAuthorLockGroup(entry, actions.lockPhraseGroup !== undefined);
    const canUnlock = canAuthorUnlockGroup(entry, actions.unlockPhraseGroup !== undefined);
    // T3/T5 — the Reader marks, read through the contract's selectors (the SAME read that drives the rail's
    // percentage and the phrase header's average), at most two rows: the current clean mark and the one before it.
    // An empty list means the pass has never run over this row, and the pane prints NOTHING rather than a `0%`
    // that claims a review.
    const marks = groupScoreMarks(entry);
    const score = groupScorePercent(entry);
    const previousScore = groupPreviousScorePercent(entry);
    const delta = score === undefined ? undefined : scoreDelta(score, previousScore);

    // THE AUTHOR'S ONE WRITE.
    //
    // THE PROSE EDITOR keeps R-T2/F6 exactly as it was: the pane shows the row's text ONCE (the reading copy above),
    // and the textarea below is an EDIT that starts EMPTY, because pre-filling it announced the same paragraphs
    // twice to a screen reader on the one surface where the Author is meant to read the book.
    //
    // THE CONTRACT EDITOR is the exception R5 makes, and the reason is a list. Six prose boxes that start empty ask
    // the Author to retype a contract from memory, and a beat dropped from memory is a beat C-7 stops checking. So
    // this editor OPENS: `contract === null` is the closed state (the reading copy is the record), the first press
    // seeds the rows from the entry's stored text (`chapterEntryDraft`), and while the rows are open the reading
    // copy steps aside — the rows ARE that text, editable, and printing both would read the same contract twice.
    const text = draft ?? '';
    const trimmed = text.trim();
    // The editor's open/closed state, per editor. The prose editor has no open step, so it is always "open" and its
    // send condition is the prose itself. (`editorOpen`, not `open`: the findings above already own that name.)
    const editorOpen = editor === 'content' || contract !== null;
    // The rows as they will be SENT: trimmed, blanks dropped, ORDER PRESERVED (`contractListOf`'s rules, mirrored on
    // the way out — the route drops the same blanks, so the desk and the entry's text cannot disagree about which
    // beats the contract holds).
    const beats = contract === null ? [] : cleanRows(contract.beats);
    const dialogue = contract === null ? [] : cleanRows(contract.dialogue);
    const heading = contract === null ? '' : contract.heading.trim();
    const verb = editor === 'content' ? actions.revisePhraseGroup : actions.revisePhraseEntry;
    // U-16: a disabled control states its reason, and the reason is the wire's own state (or the shell's missing
    // binding), never a guess from run rows. R1 puts the LOCK first: a locked row is settled content, so the
    // revise route refuses it whatever else is true, and an author who sees "the Writer is busy" on a locked row
    // would be waiting for a busy-flag that was never the blocker.
    const refuse =
        verb === undefined
            ? `The ${surface.entry} revise route is not available in this shell.`
            : locked
              ? `${entry.title} is locked in — locked content is settled and cannot be revised (R1). Unlock it first to write a new revision.`
              : busy
                ? `The Writer is rewriting this ${surface.entry} right now — the revise route refuses the write until it lands (R4).`
                : // THE CLOSED EDITOR, and only a surface that HAS an open step says what the press does (R5). The
                  // Summary's textarea is always on screen, so it has none and falls through to the empty-write line.
                  !editorOpen && surface.openWriteLine !== undefined
                  ? surface.openWriteLine
                  : // THE EMPTY-WRITE REFUSAL, per surface. One branch for both editors, because the two phrases'
                    // "nothing to send yet" sentences are different claims about different objects (an empty group
                    // text vs an entry with no beat) and both live on the surface descriptor — the Summary's
                    // wording is byte-identical to what its pane printed before the panes were generalised, which
                    // is what its pinned tests hold.
                    trimmed.length === 0 || beats.length === 0
                    ? surface.emptyWriteLine
                    : '';
    const canRevise =
        verb !== undefined &&
        !locked &&
        !busy &&
        // R5 — the CLOSED contract editor is not a shut control, it is an unopened one: the press that lands here
        // opens the rows rather than sending, so it must be enabled. The SEND condition is what the rows hold once
        // they are open — at least one non-blank beat, because an entry with no beat is the refusal the route makes.
        //
        // THE CLOSED TEST IS `editorOpen`, and it has to be that one: `open` above is `groupOpenFindings`, an ARRAY,
        // and `![]` is false — keyed off that, a row with no findings at all would look "open", a row with findings
        // would look closed, and the editor could never be opened from the closed state on either.
        (!editorOpen && surface.openWriteLine !== undefined
            ? true
            : editor === 'content'
              ? trimmed.length > 0
              : beats.length > 0);

    /**
     * Sends the write, dropping the draft first: what appears next is the server's answer.
     *
     * The two bodies are built apart on purpose. A plotpoints body carries the optional keys ONLY when they say
     * something (`plotpointsFromBody`'s rule mirrored here — the client does not send a blank it knows the route
     * will drop), and an empty dialogue section must not overwrite a contract the loop wrote with a blank line. The
     * BEATS are sent as they stand, in order: re-ordering them in the rows IS the redraft, so nothing sorts them
     * here, and the one blank row the editor keeps for typing into is dropped by `cleanRows` rather than sent as an
     * empty beat.
     */
    const submit = () => {
        // R5 — the first press on a chapter entry OPENS the rows, prefilled from the contract the entry carries.
        // Nothing is sent, and the reading copy hands its place over to the rows.
        if (editor !== 'content' && contract === null) {
            setContract(openEntryDraft(entry.content));
            return;
        }

        if (!canRevise) {
            return;
        }

        const noteValue = note.trim().length > 0 ? { note: note.trim() } : {};

        if (editor === 'content') {
            void actions.revisePhraseGroup?.(view.story.id, entry.id, { content: text, ...noteValue });
            setDraft(null);
        } else {
            void actions.revisePhraseEntry?.(view.story.id, entry.id, {
                plotpoints: {
                    beats,
                    ...(heading === '' ? {} : { heading }),
                    ...(dialogue.length === 0 ? {} : { dialogue })
                    // The deprecated prose is NOT sent: the route recovers beats from a legacy `must_happen` body
                    // for a client that has not caught up, and this desk writes the current shape (R5).
                },
                ...noteValue
            });
            setContract(null);
        }

        setNote('');
    };

    /**
     * R1 — sends the lock. The confirmation step drops FIRST, exactly as the Reviewed-Summary choose does: the pane
     * keeps no lock state of its own, so what appears next is the phrase read the server answered with — the badge
     * if the route accepted it, and the refusal line if it did not.
     */
    const lock = () => {
        if (!canLock) {
            return;
        }

        setLockArmed(false);
        void actions.lockPhraseGroup?.(view.story.id, entry.id);
    };

    /**
     * R1 — opens a locked row again, and the Author's one verb on a lock the Editor made.
     *
     * NO CONFIRMATION STEP, unlike locking: unlocking destroys nothing. The text stands, the findings stay void
     * until the next revision moves the row, and the only consequence is that the Author may write again — so a
     * second click here would be friction on the exit out of a decision that was already confirmed.
     */
    const unlock = () => {
        if (!canUnlock) {
            return;
        }

        setLockArmed(false);
        void actions.unlockPhraseGroup?.(view.story.id, entry.id);
    };

    return (
        <div
            className="sv-pane sv-group"
            data-tone={busy ? 'writer' : written ? 'written' : 'todo'}
            data-testid={surface.paneId(entry.key)}
        >
            <div className="sv-pane-head">
                <h3 className="sv-pane-title" data-testid="group-title">
                    {entry.title}
                </h3>
                {/* The revision number the rail stopped printing (U2), where it belongs: a row's own status. */}
                <span className="sv-pane-badge" data-testid="group-revision">
                    {written ? `Revision ${entry.revision}` : 'No revision yet'}
                </span>
                {blocking.length > 0 ? (
                    <span className="sv-badge sv-badge-warn" data-testid="group-blocking">
                        {/* D-78 — the badge names the severity band the number counts (§6.8's bar,
                            `summaryBlockingCost`), not a wait it no longer creates: the accept voids these rows,
                            so "holding the sign-off" contradicted the confirm line two rows below it. A noun is
                            needed here because the badge stands alone in the head, outside the "Open findings"
                            row that carries the noun in the body. */}
                        {`${blocking.length} critical/major finding${blocking.length === 1 ? '' : 's'}`}
                    </span>
                ) : null}
                {busy ? (
                    <span className="sv-badge sv-badge-lock" data-testid="group-writer">
                        Writer busy
                    </span>
                ) : null}
                {/* R1 — THE LOCKED BADGE, and it is the head's only claim about a decision someone made. Both halves
                    are the request: the revision the lock stands on and WHO made it, the fact that explains why the
                    write below is shut and why the desk's only way out is the Author's unlock. */}
                {locked ? (
                    <span className="sv-badge sv-badge-locked" data-testid="group-locked" title={groupLockTooltip(entry)}>
                        {groupLockBadge(entry)}
                    </span>
                ) : null}
            </div>

            {/* The purpose line: what the row is for, in the engine's own words. It is the difference between five
                textareas and five sections of a book — and between six contract fields and a chapter. */}
            <p className="sv-group-purpose" data-testid="group-purpose">
                {entry.description}
            </p>

            {busy ? (
                <p className="sv-group-notice" data-testid="group-busy">
                    The Writer is replacing this text right now. The pane shows the new revision when it lands.
                </p>
            ) : null}

            {/* R1 — the locked state stated in words, not only in a badge: a reader who lands on this pane needs the
                consequence, not the decoration. The third clause is the one an Author is least likely to expect from
                a lock button — the OTHER rows start adapting to this text — and the last is the way out, which is
                the difference between a lock and a dead end. */}
            {locked ? (
                <p className="sv-group-notice" data-testid="group-locked-notice">
                    {`This ${surface.entry} is locked in by ${groupLockActorLabel(groupLockActor(entry)).toLowerCase()}: the text is settled content, it cannot be revised from this pane, and the findings aimed at it are void. The other ${surface.entries} adapt to it. Only the Author can unlock it.`}
                </p>
            ) : null}

            {/* R1 — a refusal the server sent, verbatim, beside the button that raised it (`state.ts` caches it per
                row: `story-contract.groupLockError`). It says WHICH verb was refused, so a lock refusal and an
                unlock refusal cannot be read as each other, and the pane still shows the row as the phrase read
                describes it — the refusal never paints a locked badge over a row the route kept open. */}
            {lockError === undefined ? null : (
                <p className="sv-group-notice sv-group-notice--warn" role="alert" data-testid="group-lock-error">
                    {lockError}
                </p>
            )}

            {/* T5 — THE TWO READER MARKS. The score sits under the purpose line and above the text on purpose: it is
                the Reviewer's verdict on how well this row does what it is FOR, and the prose below is what produced
                it. At most two rows — what it scores NOW and what it scored the last time the Reader read it. Three
                passes or thirteen, two rows appear: the third mark is history, and history is not this pane's claim.
                A row nobody has scored prints NOTHING (the pane already says `not written`/`No revision yet`, and a
                `0%` would claim a pass that never ran). */}
            {score === undefined ? (
                /* D-67 — an EMPTY `scores` list on a WRITTEN row is the normal state, and the pane says why: the
                   Reader pass reads a section once the crew has a CLEAN revision of it to stand behind. */
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
                        {/* The same word boundary the rail's rows pin: an accessible/linear read concatenates spans,
                            so without it the pane announces "Score 84%(up 6 from 78%)". The WORDS are the carrier. */}
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

                    {/* The comparison itself. `vector_hash` still rides the TOOLTIP rather than the text: one Reader
                        pass scores all rows against one text vector, so a row here and the same row in another pane
                        are one event — and a mark from a DIFFERENT vector is a different book. A row with no
                        `rationale` prints no sentence: the pass recorded none, and the pane does not write one. */}
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
                                            older mark gets its own, so a test can pin WHICH pass said WHICH sentence
                                            instead of trusting document order. */}
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
                        {` · diff against Revision ${Math.max(1, entry.revision - 1)}`}
                    </span>
                ) : null}
            </p>
            {written && entry.content ? (
                previous !== '' ? (
                    /* R2 / U3 — the latest revision against the one it replaced: deletions struck in red, additions
                       in green. `previous_content` is the immediately preceding revision ONLY, so this is never a
                       cumulative diff over the archived history.

                       T2 — this branch is NOT Markdown, deliberately (specifications.md:464, U-18): U3's rule is the
                       WORD diff — every removed word in one struck run, every added word in one green run — and those
                       `<del>`/`<ins>` runs are inline HTML this renderer would have to escape, not prose it could
                       render. So a group whose text is Markdown shows its source here while it is being compared,
                       which the spec accepts ("the diff is prose, not a patch viewer", `styles/story.css:1050-1067`);
                       the whole-text branch below renders it properly. It keeps the same test id and the same two
                       classes, so the reading copy is one node in either state. */
                    <p className="sv-summary-text sv-group-content sv-group-diff" data-testid="group-content">
                        <RevisionDiff previous={previous} current={entry.content} />
                    </p>
                ) : (
                    /* R-T2/F6 — the ONE reading copy of the row's text. It is prose, not a control, so a screen
                       reader reads the paragraph once; the editor below is an empty edit, not a second copy. For a
                       chapter entry this is the prose the server COMPOSED from the contract fields, which is why the
                       editor under it edits the fields and never this text.

                       T2 — AND IT IS RENDERED AS MARKDOWN, for both phrases. A Summary group's text is the prose the
                       Writer/Author installed, in the same `## <title>` shape `shared/phrase.ts:composePhraseContent`
                       joins the Overview from, so printed as text the Author read the SOURCE — `## Premise`, a literal
                       `- ` — which is the complaint this change answers. A chapter entry's text is
                       `phrase/plotpoints.ts:chapterEntryContent`, and its shape is NOT a heading and bullets, whatever
                       a fixture may carry: one `Label: value` line per contract field the Writer filled, in that
                       function's fixed order, joined with a SINGLE `\n`, with no blank lines and no heading of its own
                       (the entry's title is the heading, and `composePhraseContent` is what puts `## Chapter N — …` in
                       front of it when it composes the phrase's whole text — `server/api/routes.ts:1271`,
                       `server/phrase/controllers/plotlines.ts:523`). Its half of the complaint is the opposite one:
                       markdown folds a lone newline away, so six labelled fields read as one running sentence —
                       `Heading: … Must happen: … Must change: …` — unless the renderer keeps the breaks the writer
                       installed, which is why `MarkdownText` turns every newline in prose into a real break
                       (`MarkdownText.tsx`, `remark-breaks`). `MarkdownText` renders it, and
                       it stays the ONE copy: one wrapper element, the same `data-testid`, and BOTH classes it always
                       carried (`sv-summary-text` is the pane's sizing rule, `sv-group-content` is the reading copy),
                       so the sizing contract at `styles/story.css:1040-1048` and the R-T2/F6 pin still address it.
                       Raw HTML in agent prose stays escaped (`MarkdownText` has no `rehype-raw`). */
                    /* R5 (W2) — WHILE THE CONTRACT EDITOR IS OPEN, THE ROWS BELOW ARE THE READING COPY. The composed
                       text and the prefilled rows are the same words in two shapes, and printing both reads one
                       contract twice — the duplication R-T2/F6 exists to prevent. So the composed prose steps aside
                       for the duration and says where its text went; closing the editor (or landing a revision)
                       brings it back. The Summary's prose editor has no open step, so this branch never fires for it
                       and its reading copy is byte-identical to what it printed before — which is what that
                       surface's pinned tests hold. */
                    editor === 'plotpoints' && contract !== null ? (
                        <p className="sv-group-quiet" data-testid="group-content-rows">
                            {`${entry.title}’s contract is in the rows below — its heading, its beats in the order they happen, and the lines of dialogue it owes. Send them and the text here is composed from the new ones (P4).`}
                        </p>
                    ) : (
                        <MarkdownText className="sv-summary-text sv-group-content" testId="group-content">
                            {entry.content}
                        </MarkdownText>
                    )
                )
            ) : (
                /* U4's purposeful empty state: why it is empty and what fills it. */
                <p className="sv-group-quiet" data-testid="group-empty">
                    {draft === null && contract === null
                        ? `No content yet. The loop writes this ${surface.entry} when the Editor puts it in the queue, or you can write it below.`
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
                                ? `Revision ${entry.revision}${latest === undefined ? '' : ` · ${latest.chars} chars`}`
                                : 'not written'}
                        </span>
                        {archived.length > 0 ? (
                            /* R-T2/F5 — the count only when there IS a count. `0 archived` beside `Revision 1` states
                               a nothing and reads like a defect. */
                            <span className="sv-summary-flag" data-testid="group-archived">
                                {`${archived.length} archived`}
                            </span>
                        ) : null}
                        {/* D-67 — the Clean stamp, on the one row it describes. `history[].clean` is P11's audit of a
                            verdict (this text closed a cross-row Critic pass with no unresolved defect). It is a
                            BADGE, not a state word: the pane's state line is the Writer's business, and this says a
                            Reviewer has read exactly this text. The run that earned it travels in the title because
                            every verdict names its run (P11). */}
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
                        {written && entry.updated_by !== null ? (
                            <span className="sv-summary-flag">{`last written by ${entry.updated_by}`}</span>
                        ) : null}
                    </dd>
                </div>
                <div className="sv-summary-field">
                    <dt>Open findings</dt>
                    {/* D-78 — the second number is §6.8's critical/major band (`groupBlockingFindings` →
                        `summaryBlockingCost`, dial included), the same count the head badge and the rail's row
                        print. It used to read "M hold the sign-off", which promised a wait the accept does not
                        impose — it voids these rows in the lock commit. The `<dt>` carries the noun, so the band
                        needs none here. */}
                    <dd className="sv-summary-value" data-testid="group-findings-count">
                        {open.length === 0 ? 'none open' : `${open.length} open · ${blocking.length} critical/major`}
                    </dd>
                </div>
                {/* R3: the findings this row's NEXT text has to answer. It is the server's number, so the pane
                    cannot count a row's debt differently from the gate. */}
                {entry.owed_by_findings.length > 0 ? (
                    <div className="sv-summary-field">
                        <dt>{`This ${surface.entry} owes`}</dt>
                        <dd className="sv-summary-value" data-testid="group-owed">
                            {`${entry.owed_by_findings.length} finding${
                                entry.owed_by_findings.length === 1 ? '' : 's'
                            } its next revision must answer`}
                        </dd>
                    </div>
                ) : null}
            </dl>

            {open.length > 0 ? (
                <ul className="sv-group-findings" data-testid="group-findings">
                    {open.map((finding) => (
                        <FindingRow key={finding.id} finding={finding} entries={entries} of={entry} />
                    ))}
                </ul>
            ) : (
                <p className="sv-group-quiet" data-testid="group-findings-empty">
                    Nothing open on this {surface.entry}.
                </p>
            )}

            {/* R1 — THE AUTHOR'S TWO VERBS ON THIS ROW'S LOCK. They sit with the write controls, not up in the head
                with the badge, because the decision and its consequence belong in one place: the pane says what the
                text is worth, then asks whether the Author is committing to it.

                LOCKING is armed, not fired: the first click puts the sentence above the verb, because a lock
                freezes the text, voids the row's own findings, and promises this text to the other rows — three
                consequences an Author should read before the commit rather than discover after it. UNLOCKING has no
                such step: it destroys nothing, and a confirm on the way OUT of a decision is friction on the only
                exit the Editor's lock has.

                Both controls state their reason when they are shut (U-16), and the reasons are the wire's own
                states: an unwritten row has nothing to commit (R1's `revision: 0`), a Writer-held row's text is about
                to move (R4's `writer_busy`), a locked row is not asking to be locked again, and a shell with no verb
                says so on the spot. */}
            <div className="sv-group-lock" data-testid="group-lock-controls">
                {locked ? (
                    <button
                        type="button"
                        className="sv-group-unlock-button"
                        data-testid="group-unlock"
                        disabled={!canUnlock}
                        title={
                            canUnlock
                              ? 'Lift the lock so this entry can be revised again (R1). Only the Author can do this, whoever made the lock.'
                              : unlockRefusal
                        }
                        onClick={unlock}
                    >
                        {`Unlock this ${surface.entry}`}
                    </button>
                ) : (
                    <>
                        <button
                            type="button"
                            className="sv-group-lock-button"
                            data-testid="group-lock"
                            disabled={!canLock || lockArmed}
                            title={canLock ? 'Commit this text: it stops being editable and the other entries adapt to it (R1).' : lockRefusal}
                            onClick={() => setLockArmed(true)}
                        >
                            {`Lock this ${surface.entry} in`}
                        </button>
                        {lockArmed ? (
                            <div className="sv-group-lock-confirm" data-testid="group-lock-confirm-block">
                                <p className="sv-group-notice sv-group-notice--warn" data-testid="group-lock-note">
                                    {groupLockStatement(entry)}
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
                {/* R2 — one line saying who else may lock this row, so the Author is not surprised by a lock they did
                    not make. It is the Setting's effect, stated where the lock lives. */}
                <p className="sv-group-quiet" data-testid="group-lock-who">
                    {isEditorGroupLockingEnabled(view.story)
                        ? 'This Story lets the Editor lock a group in too, on its own judgement over the Critic findings and the Reader score for it. Only you can unlock one.'
                        : 'Only the Author locks a group in on this Story — the Editor-locking Setting is off in Settings.'}
                </p>
            </div>

            {/* The Author's one write against the row. `editor` decides which control: prose for a Summary group,
                the six contract fields for a chapter entry. The field(s) start EMPTY for the same reason in both
                cases (R-T2/F6): the reading copy above is the book, and an edit that prefills it reads the same
                paragraphs twice. */}
            <div className="sv-group-note" data-testid="group-revise">
                {/* R1 — a locked row is not editable, so the whole edit block is shut rather than hidden: the Author
                    still needs to see the write that used to be here and read WHY it is not available (the pane's
                    rule for every shut control), and the field's own `title` carries the same sentence the submit
                    button states. */}
                {locked ? (
                    <p className="sv-group-quiet" data-testid="group-revise-locked">
                        {`Locked content is settled and cannot be revised (R1). Unlock ${entry.title} to write the next revision.`}
                    </p>
                ) : null}
                {editor === 'content' ? (
                    <textarea
                        aria-label={`Rewrite ${entry.title}`}
                        placeholder={`Write the new ${entry.title} text — the current revision is above`}
                        value={text}
                        disabled={busy || locked}
                        title={locked ? refuse : undefined}
                        onChange={(event) => setDraft(event.currentTarget.value)}
                    />
                ) : (
                    /* R5 (W2) — THE CONTRACT AS ORDERED ROWS. There is no prose textarea here on purpose: a chapter
                       entry's stored text is composed FROM these fields
                       (`phrase/plotpoints.ts:chapterEntryContent`), so editing the prose would be editing a
                       rendering, and the send would replace the Author's words with a paragraph the route has to
                       re-split. The rows are closed until the Author opens them (`contract === null`), and opening
                       seeds them from the entry's stored text, so the contract being edited is the one on the
                       record — not a blank form the Author has to retype from memory. */
                    contract === null ? (
                        // THE CLOSED EDITOR says what the press does, so the pane never shows a dead button (U-16)
                        // and never shows the same contract twice (the reading copy above is still the record).
                        <p className="sv-group-quiet" data-testid="group-contract-closed">
                            {`“Revise this ${surface.entry}” opens ${entry.title}’s contract as rows — its heading, its beats in the order they happen, and the lines of dialogue it owes. The rows start as the contract on the record, and nothing is sent until you press again (R5).`}
                        </p>
                    ) : (
                        <div className="sv-group-plotpoints" data-testid="group-plotpoints-fields">
                            <label className="sv-group-plotpoint" data-testid="group-plotpoint-heading">
                                <span className="sv-group-plotpoint-label">Heading</span>
                                <input
                                    aria-label={`Heading for ${entry.title}`}
                                    data-testid="group-plotpoint-heading-input"
                                    value={contract.heading}
                                    disabled={busy || locked}
                                    title="The chapter title this contract stands under. Blank sends no heading, and the entry keeps the one its row carries."
                                    onChange={(event) =>
                                        setContract({ ...contract, heading: event.currentTarget.value })
                                    }
                                />
                            </label>

                            <ContractRows
                                label="Beats *"
                                noun="beat"
                                testId="group-beat"
                                rows={contract.beats}
                                disabled={busy || locked}
                                // A contract keeps its last row: an entry with no non-blank beat is the write the
                                // route refuses, so removing the only beat is not a move the desk offers.
                                minRows={1}
                                hint="One event this chapter has to put on the page, in the order it happens. C-7 checks the prose against every beat, and C-3/C-8 against the last one — so the order is the contract, and the Up/Down buttons are part of the write."
                                addLabel="Add a beat"
                                onChange={(beats) => setContract({ ...contract, beats })}
                            />

                            <ContractRows
                                label="Important dialogue"
                                noun="line"
                                testId="group-dialogue"
                                rows={contract.dialogue}
                                disabled={busy || locked}
                                // The section may go EMPTY: a chapter that owes no lines is a normal chapter, and an
                                // empty list is sent as NO key rather than as a blank the composed text would print.
                                minRows={0}
                                hint="A line this chapter has to land, with the speaker inline (e.g. Mara: “The gate is open.”). Blank lines are dropped, and an empty section sends nothing."
                                addLabel="Add a line of dialogue"
                                onChange={(dialogue) => setContract({ ...contract, dialogue })}
                            />

                            {/* THE OTHER WAY OUT. Closing drops the rows: the record is the entry's stored text, and
                                the desk keeps no draft of its own (P1). Without this control an Author who opened the
                                editor by accident could only leave it by sending. */}
                            <button
                                type="button"
                                className="button button--ghost"
                                data-testid="group-contract-cancel"
                                onClick={() => setContract(null)}
                            >
                                Leave the contract as it is
                            </button>
                        </div>
                    )
                )}
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
                    // R5 — an ENABLED closed button still says what its press does: the press opens the rows, and a
                    // tooltip promising "send this contract" over a closed editor would name a write that is not
                    // happening. The prose editor is always open, so its sentence is unchanged.
                    title={canRevise && editorOpen
                        ? `Send this ${editor === 'content' ? 'text' : 'contract'} to the ${surface.entry} as a new revision (R2).`
                        : refuse}
                    onClick={submit}
                >
                    {draft === null && contract === null
                        ? `Revise this ${surface.entry}`
                        : editor === 'content'
                          ? 'Send this text'
                          : 'Send this contract'}
                </button>
            </div>
        </div>
    );
}

export default PhraseEntryDetail;
