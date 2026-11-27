// T-W4 — PHRASE ②'s surface: the phrase's brief, its chapter entries, and the one entry the rail opened.
//
// WHY A PANE RATHER THAN THE CLASSIC `PlotlinesPane`. `PlotlinesPane` renders the §4.3 records — the plotline rows
// the classic tools wrote, with their beats and their ledger state. A book on the grouped pipeline has a different
// object: one ENTRY PER CHAPTER, each a CONTRACT (its ordered beats, and the lines of dialogue it owes), each with
// its own revisions, findings and lock, all projected by `GET /stories/:id/phrases/plotlines`.
// The two surfaces are chosen by the Setting (`story.plotlines_mode`, echoed by the read's `mode`), never by which
// list happens to be non-empty — so `StoryView` routes on `story-contract.isPlotlinesGroups` and a classic book
// keeps the records pane byte-for-byte as it was.
//
// WHY THE RENDER IS THE SHARED PAIR. An entry row and an entry pane are the Summary group's shapes on the wire
// (`PhraseGroupRow`), so this pane calls the same `PhraseEntryRows`/`PhraseEntryDetail` components with
// `PLOTLINE_SURFACE` — one rule per rule, from the lock badge to the `writer_busy` refusal — and supplies only what
// is Phrase ②'s own: the phrase's heading, the brief card, the chapter-entry wording, and the CONTRACT EDITOR
// (`editor:'plotpoints'`) instead of a prose field. A forked pair of panes would drift on the first fix to either.
//
// THE VIEW IT RECEIVES IS THE SWAPPED ONE (`story-contract.plotlinesSurfaceView`, applied by `StoryView`). The
// phrase selectors all resolve through `view.phrase`, and Phrase ②'s read is that same shape with different rows,
// so the swap lets the shared components read the right rows without a phrase branch in the contract module.
// `isPlotlinesGroups` still answers from `story.plotlines_mode` when the read has not landed, which is what keeps a
// grouped book from rendering the classic records just because a route is slow.
import { PhraseEntryDetail, PhraseEntryRows, PhraseReadState, PLOTLINE_SURFACE } from './PhraseEntries';
import {
    isPlotlinesGroups,
    phraseDetailReadError,
    phraseDetailReadLanded,
    plotlinesBrief,
    plotlinesEntries,
    unwrittenPlotlinesEntries,
    type StoryActions,
    type StoryViewData
} from './story-contract';
import type { StorySelection } from './story-nav';
// T-W4 — the ref is PARSED, never string-matched: the prefix is `story-nav`'s contract, and a pane that re-cut the
// string by hand would break the moment the prefix changed (and would read a bare §4.3 plotline uuid as an entry).
import { parsePlotlineGroupRef } from './story-nav';

export interface PlotlinesPhrasePaneProps {
    /** The PHRASE-SWAPPED view: `phrase`/`phraseError` hold Phrase ②'s read, not the Summary's. */
    view: StoryViewData;
    /** The pinned action surface; every method is optional, and an absent one says so on the control (U-16). */
    actions?: StoryActions;
    /** The rail's selection, so the entry row the Author is standing on is the lit one. */
    selection?: StorySelection;
    onSelect?: (selection: StorySelection) => void;
}

/**
 * The phrase's structure brief: what the Editor concluded about the copied Seed, and whether the Author has
 * accepted it.
 *
 * IT PRINTS THE WIRE'S NULL, NOT A PLACEHOLDER. `brief === null` means nobody structured this phrase yet — a real
 * state, distinct from a structure that is drafted and one that is accepted (which is the state the chapter entries
 * were materialized from). Inventing "0 chapters" would read as a verdict about the book. The full per-chapter
 * brief stays server-side; the read carries the three fields the desk can act on (status, count, accept stamp).
 */
function BriefCard({ view }: { view: StoryViewData }) {
    const brief = plotlinesBrief(view);
    const accepted = brief?.status === 'accepted';

    return (
        <div className="sv-reviewed-actions sv-plotlines-brief" data-testid="plotlines-brief">
            <span className="sv-pane-badge" data-tone={accepted ? 'ready' : 'pending'} data-testid="plotlines-brief-state">
                {brief === null
                    ? 'no structure brief yet'
                    : accepted
                      ? `brief accepted — ${brief.chapter_count} chapters`
                      : `brief drafted — ${brief.chapter_count} chapters`}
            </span>
            {/* The accept stamp, only when the wire has one: a draft has no accepted moment, and printing a blank
                date would claim one. The count rides the state word above, because the count WITHOUT the state is
                the number the entries were NOT written from while the brief is still a draft. */}
            {brief === null || brief.accepted_at === undefined ? null : (
                <span className="sv-group-quiet" data-testid="plotlines-brief-accepted-at">
                    {`accepted ${brief.accepted_at}`}
                </span>
            )}
            <p className="sv-group-quiet" data-testid="plotlines-brief-note">
                {brief === null
                    ? 'Nobody has structured this phrase yet: the chapter entries are materialized from the brief the Editor writes, once its structure is accepted, and the directive bar is how you ask for that.'
                    : accepted
                      ? 'The chapter entries below were materialized from this brief, one per chapter it declares.'
                      : 'The brief is drafted, not accepted, so the entries below carry its count without a clean verdict behind it.'}
            </p>
        </div>
    );
}

/**
 * The phrase's own overview: the heading, the brief, and one row per chapter entry.
 *
 * THE THREE READ STATES COME FIRST, and they are the same three the Summary panes answer with (in flight, failed,
 * or not this model at all) — `PhraseReadState` with this pane's own ids and sentences, because "the read failed"
 * and "there are no entries" are different claims and only `phraseDetailReadLanded` tells them apart (U6).
 */
export function PlotlinesOverviewPane({ view, selection, onSelect }: PlotlinesPhrasePaneProps) {
    // The defensive guard `StoryView` normally applies: a classic book has no entries to list, and five rows of
    // "nothing written" would be a claim about the book that the wire never made.
    if (!isPlotlinesGroups(view)) {
        return (
            <PhraseReadState
                state="legacy"
                surface={PLOTLINE_SURFACE}
                testId="plotlines-overview-legacy"
                overrideLine={
                    "This Story's Plotlines are still written by the classic plotline tools, so it has no chapter entries. The records are the Plotlines pane."
                }
            />
        );
    }

    const phrase = view.phrase;

    if (phrase === undefined || phrase === null) {
        const failure = phraseDetailReadError(view);

        if (failure !== undefined) {
            return (
                <PhraseReadState
                    state="failed"
                    surface={PLOTLINE_SURFACE}
                    testId="plotlines-overview-error"
                    readErrorId="plotlines-read-error"
                    failure={failure}
                    overrideNotice={
                        'This Story started Phrase 2 on the chapter-entry pipeline, so the entries exist — the read that lists their state failed. Nothing here is a verdict about the contracts; reload the Story to read the entries again.'
                    }
                />
            );
        }

        return (
            <PhraseReadState
                state="pending"
                surface={PLOTLINE_SURFACE}
                testId="plotlines-overview-pending"
                overrideLine={
                    'This Plotlines phrase is written as chapter entries. The brief and the entry rows arrive with the phrase read.'
                }
            />
        );
    }

    const entries = plotlinesEntries(view);
    const unwritten = unwrittenPlotlinesEntries(view);
    const review = phrase.review;

    return (
        <div className="sv-pane sv-summary sv-group-overview sv-plotlines-overview" data-testid="plotlines-overview">
            <div className="sv-pane-head">
                <h3 className="sv-pane-title">Plotlines</h3>
                {/* The server's own count, not a verdict this pane invented — the same read as the rows, and the
                    same shape the Summary Overview's badge uses (`review.written_groups`). */}
                <span className="sv-pane-badge" data-testid="plotlines-written">
                    {`${review.written_groups} of ${entries.length} chapter entries written`}
                </span>
            </div>

            <p className="sv-pane-subtitle">
                The chapter entries are the Phrase 2 surface: one entry per chapter the phrase brief declares, each
                carrying the beats that chapter has to deliver IN ORDER, and the lines of dialogue it owes. Each
                entry is its own pane in the rail: its revisions, its findings and the contract you revise live
                there.
            </p>

            <BriefCard view={view} />

            {entries.length === 0 ? (
                /* Started on the grouped pipeline with NO entries: the brief has not been accepted, so there are no
                   chapters to write. A real state, said plainly — it is not a loading line, and it is not the
                   legacy line (the book IS on the entry model, it just has no rows yet). */
                <p className="sv-summary-flag" data-testid="plotlines-empty">
                    No chapter entries yet — the brief has to be accepted before the chapters exist.
                </p>
            ) : (
                <PhraseEntryRows
                    view={view}
                    entries={entries}
                    surface={PLOTLINE_SURFACE}
                    selection={selection}
                    onSelect={onSelect}
                    label="Plotlines chapter entries"
                />
            )}

            {unwritten.length > 0 ? (
                <p className="sv-summary-flag" data-testid="plotlines-unwritten">
                    {`${unwritten.length} of ${entries.length} chapter entries still have no contract: ${unwritten
                        .map((entry) => entry.title)
                        .join(', ')}.`}
                </p>
            ) : null}
        </div>
    );
}

/**
 * ONE chapter entry: its composed text, its revisions, its findings, its lock, and the contract editor.
 *
 * The prose above is the RECORD (the text the loop composes from the fields); the fields below are the write. That
 * split is `PhraseEntryDetail`'s, and `editor:'plotpoints'` is this phrase's half of the one real difference
 * between the two surfaces: sending prose would be editing a rendering, so the verb sends the fields and the route
 * composes the text (`phrase/plotpoints.ts:chapterEntryContent`) — which is why an entry with no `must_happen` or
 * `must_change` is a refusal rather than a revision (P4).
 */
export function PlotlinesEntryPane({ view, actions, selection, onSelect }: PlotlinesPhrasePaneProps) {
    // The entry the rail's ref addresses, parsed out of `plotlines-group:<uuid>` (`StoryView` resolves the
    // selection before routing, and a stale ref has already fallen back to the overview). The shared pane looks
    // the row up BY UUID anyway, so a refetch that reorders the chapters cannot move the pane (U2).
    const entryId = parsePlotlineGroupRef(selection?.ref);

    return (
        <PhraseEntryDetail
            view={view}
            surface={PLOTLINE_SURFACE}
            actions={actions ?? {}}
            entryId={entryId}
            editor="plotpoints"
            onSelect={onSelect}
        />
    );
}

export default PlotlinesOverviewPane;
