// The left rail's second half: the Story's phrases, their children, and the Story's supporting sheets and folders.
//
// R6 — WHAT THE PHRASE LIST HOLDS. T-W4 turned the second phrase on, so `STORY_PHRASES` now carries Summary ① and
// Plotlines ②: the rail is the content area's table of contents, and a grouped book's content area opens the Summary
// Overview, one of its five groups, the Plotlines phrase, one of its chapter entries, or a folder. Under each phrase
// header the rows are the server's ENTRY rows when the book is group-managed on that phrase, and the sampling round's
// `Revision 1 … N` drafts under Summary when it is not — see `groupChildren`/`summaryChildren`/`plotlineChildren`.
// Chapters still has no rail row (no group loop writes its rows), and Characters is no longer numbered: it is a
// supplementary sheet the crew builds from the Summary, so it rides the rail under `Supplements` (T-W4).
//
// WHY THE RAIL IS A PURE NAVIGATOR: the content area shows exactly one thing at a time, and the
// rail is the only place that decision is made. It therefore renders the phrase/folder list and
// nothing else — no article counts, no "one article per folder" sentence, no running commentary.
// Three marks are the exception, and all three are decisions rather than decoration: the Summary's
// tick ("ready for review"), one badge on a Revision that still has OPEN Critical/Major findings
// against it, and the STRIKE-THROUGH on a Revision a round parked as history (T4/R2, then R6 — the Author
// has to see WHICH revision went at a glance, so the word `DISCARDED` became a struck-out label; the word
// itself stays in the accessible name, and the reason stays in the tooltip). Minor findings never badge —
// they are filed, not raised. A child row is a leaf, so it carries no chevron: there is nothing to expand.
//
// A PHRASE HEADER IS ALSO A DISCLOSURE CONTROL (U-21): clicking `Phrase 1` folds its children away and
// clicking it again unfolds them, which is how the Author gets the rail back to four lines. It changes
// what the rail SHOWS and nothing else — the collapsed phrase's rows are unmounted, never deleted, so
// re-expanding restores every row, its strike-through, its badge and its tooltip, in the same order.
//
// U-25 — THE SEED IS A PHRASE CHILD, NOT A RAIL ROW OF ITS OWN. The rail used to pin one `Seed → "The Author's
// idea"` row above `Phrases`, which claimed one Seed for the whole Story. Each Phrase has its own: Phrase ①'s is the
// Author's idea, Phrase ②'s is the text its Start copied (the compiled Overview, or the Author's own words). So the
// row moved INSIDE every phrase's children list, first, and it folds with them — collapsed means it leaves the DOM
// like any other leaf — and it navigates as `{panel:<phrase>, ref: phraseSeedRef()}`, the same ref-on-a-panel shape
// a Summary group and a chapter entry use. Nothing in the rail offers a `panel:'seed'` selection any more.
//
import { useState } from 'react';
import {
    STORY_FOLDERS,
    STORY_PHRASES,
    STORY_SUPPLEMENTS,
    attentionFor,
    castMembers,
    chaptersInOrder,
    phraseLoaded,
    // U-25 — the Seed row's synthetic ref: the rail builds the row from it and the pane routes on it, so neither
    // side ever writes the bare string.
    phraseSeedRef,
    // T-W4 — Phrase ②'s rail vocabulary: the chapter-entry rows, and the predicate that decides whether the
    // header offers a `start` tick.
    plotlineRailEntries,
    plotlinesInOrder,
    plotlinesReadyToStart,
    summaryGroupEntries,
    summaryReadyForReview,
    summaryRevisionRef,
    summaryRevisions
} from './story-nav';
import type { StoryAttention, StoryPhraseKey, StorySelection, SummaryRevisionEntry } from './story-nav';
import {
    groupLockActorLabel,
    isGroupSummary,
    // T-W4 — Phrase ②'s read states. `isPlotlinesGroups` is the dial question (absent means classic) and the two
    // read predicates are what separate "the entries are on their way" from "the entries could not be read",
    // which is the U6 rule restated for the second phrase.
    isPlotlinesGroups,
    isOpenFinding,
    phraseDetailReadError,
    phraseDetailReadLanded,
    phraseOverallScore,
    phraseReadError,
    plotlinesStarted,
    type PhraseLockActor,
    type StoryViewData
} from './story-contract';

function CheckIcon() {
    return (
        <svg className="outline-check" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path
                d="M3.2 8.4 6.4 11.6 12.8 5.2"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function isActive(selection: StorySelection, panel: StorySelection['panel'], ref?: string): boolean {
    return selection.panel === panel && (selection.ref ?? undefined) === ref;
}

/** One entry under a phrase. A Summary entry is one flat Revision and its findings badge. */
interface OutlineChildSpec {
    ref: string;
    title: string;
    /**
     * U-25 — this row is a phrase's OWN Seed, the synthetic child every phrase carries. It is the only child row
     * that is not a record off the wire, and the flag is what keeps it addressable: the row keeps the
     * `.outline-item--seed` class the rail has always carried (so the stylesheet's rule for a Seed row is still the
     * rule for THIS row), it carries `data-testid="outline-seed"`, and it takes none of the record marks below —
     * no findings badge, no state word, no score, no attention dot, because a Seed is pinned truth, not work.
     */
    seed?: boolean;
    /**
     * Open Critical/Major findings filed against this revision — the badge. Minor findings are
     * filed, not raised: a revision that only has those has nothing for the Author to answer, so
     * it earns no badge.
     */
    findings?: number;
    state?: string;
    /**
     * Recorded explanation for a `discarded` state (T4/R1), already trimmed and absent when the row has
     * none. It only feeds the row's TOOLTIP — the row itself says "discarded" (struck name, plus the
     * screen-reader word), so no tooltip is needed to discover the state (R2/R6).
     */
    discardReason?: string;
    /**
     * R6 — one word for a Summary GROUP's state, rendered as a pill (`outline-state`). A group row has no
     * engine `state` string of its own: what it can honestly say is whether the Writer holds its text and
     * whether anything has been written at all. Never set on a revision row, so the sampling rail's rows —
     * and every test that reads their exact accessible names — are untouched.
     */
    mark?: string;
    /** The pill's tone: the Writer holding the job reads as activity (accent), unwritten as amber. */
    markTone?: 'writer' | 'todo';
    /**
     * T3 — the group's latest Critic score, an integer percentage (`84` prints as `84%`). Set on GROUP rows
     * only, from `story-nav.summaryGroupEntries`; a sampling rail's Revision rows carry none, so their
     * accessible names are byte-for-byte what they were before percentages existed on this rail. Absent
     * means never scored, which renders NOTHING — a `0%` would claim a review that never ran.
     */
    score?: number;
    /**
     * T3 — the percentage this group's latest score moved FROM, for the row's tooltip only. The rail has
     * 320px and one number fits; the movement is the fact worth a hover, and it comes from the same
     * `scores` array the pane prints.
     */
    previousScore?: number;
    /**
     * R1 — the group's text is LOCKED IN: settled content, not revisable, its own findings void, the other
     * groups adapting to it. Set only for a locked group row, so an unlocked row (and every sampling-revision
     * row) keeps the exact accessible name it had before locks existed.
     */
    locked?: boolean;
    /**
     * R1 — WHO made the lock (`'author'` | `'editor'`), absent when the wire row names no actor. It is tooltip
     * words only: the rail's one word is `Locked`, and the pane's badge is where the actor is read (the rail is
     * 320px and the actor changes nothing about which row to click).
     */
    lockedBy?: PhraseLockActor;
    /**
     * R1 — the revision the lock stands on, for the row's tooltip. The pane's badge prints the same number from
     * the same selector (`story-nav.summaryGroupEntries`), so rail and pane cannot name two different texts.
     */
    lockedRevision?: number;
}

/** The engine's word for a draft a round parked as history (§4.17, P13/D-22). */
const DISCARDED_STATE = 'discarded';

/**
 * U-25 — the Seed child every phrase carries, and the rail's FIRST row under every phrase header.
 *
 * WHY EVERY PHRASE HAS ONE. The Author's words are the whole request: "The Seed (The Author's Idea) belongs to the
 * Phrase 1, so it should be under Phrase 1 as seed. Phrase 2 have different seed". Each phrase is a discrete
 * surface with its own Seed — Phrase ①'s is `story.idea` (`server/phrase/catalog.ts:phraseSeedOf`), Phrase ②'s is the
 * text its Start copied — and the desk has no third, story-level Seed. So the row the rail used to pin ABOVE the
 * phrases moved INSIDE each one, and the two Seeds are now two rows that open two different panes.
 *
 * WHY IT IS BUILT FROM THE PHRASE LIST, NOT HARDCODED. The row is prepended to whatever `STORY_PHRASES` renders
 * (see the map below), so Phrase ③ inherits its Seed row the day the rail gains the phrase — the rule lives once,
 * on the phrase list, rather than in a branch per phrase key.
 *
 * WHY IT IS NOT MERGED WITH THE RECORD ROWS' MARKS. A Seed cannot hold an open finding, a Writer, a score or a
 * discard: nothing answers to it, so it renders as a bare named row. Its class hook (`.outline-item--seed`) stays
 * so the stylesheet keeps one rule for "a Seed row" wherever the rail shows one.
 */
const seedChild = (): OutlineChildSpec => ({ ref: phraseSeedRef(), title: 'Seed', seed: true });

/** Phase ① is a flat Revision 1…N list — no Overview/sub-tree. */
function summaryChildren(revisions: SummaryRevisionEntry[]): OutlineChildSpec[] {
    return revisions.map((entry) => ({
        ref: summaryRevisionRef(entry.revision.id),
        title: `Revision ${entry.index}`,
        findings: entry.findings.filter(
            (finding) => isOpenFinding(finding) && (finding.cost === 'critical' || finding.cost === 'major')
        ).length,
        state: entry.revision.state,
        discardReason: entry.discardReason
    }));
}

/**
 * R6 / U2 — the rail's children of the Summary phrase when the book is GROUP-MANAGED: the server's five group
 * rows, in composition order, named by their own titles.
 *
 * WHY NOT `Revision 1 … N` here. The sampling rail listed drafts because phase ① wrote whole-Summary drafts the
 * Author could compare and pick. A grouped Story writes five NAMED parts, each with its own revision number
 * (which belongs in the group's own pane, U3), so a `Revision N` row would name a draft the Author cannot open
 * and hide the one thing that identifies the pane — which group it is. Archived history is not a row either: the
 * projection sends metadata for superseded rows and no prose, so a row a reader cannot open is decoration.
 *
 * The badge keeps the sampling rail's rule (open Critical/Major only), and the counts come from
 * `story-nav.summaryGroupEntries` — the same `groupBlockingFindings` read the Overview pane and the Accept gate
 * use, so a badge can never disagree with the pane it points at. `state` stays unset: a group is never
 * `discarded`, so it must not take the struck-out mark the stylesheet keys on.
 */
function groupChildren(view: StoryViewData): OutlineChildSpec[] {
    return summaryGroupEntries(view).map((entry) => ({
        ref: entry.ref,
        // U6: the accessible name IS the group title — no id, no number, nothing else to read per row.
        title: entry.group.title,
        findings: entry.blockingFindings,
        // T3 — the score the pass wrote for THIS group, latest first. `!== undefined` rather than truthy:
        // a scored-zero group prints `0%`, and rendering nothing there would hide the worst number on the
        // rail. `previousScore` rides along for the tooltip (the rail has no room for a second figure).
        ...(entry.score === undefined ? {} : { score: entry.score }),
        ...(entry.previousScore === undefined ? {} : { previousScore: entry.previousScore }),
        // R1 — the lock, passed through from the SAME entries the pane's badge reads
        // (`story-nav.summaryGroupEntries` → `story-contract.isGroupLocked`), so a row can never show `Locked`
        // over a group the pane says is open. Set only for a locked row: an unlocked group renders no word,
        // which keeps every pre-lock row name byte-for-byte what its tests already pin.
        ...(entry.locked === true
            ? { locked: true as const, lockedBy: entry.lockedBy, lockedRevision: entry.lockedRevision }
            : {}),
        ...(entry.writerBusy
            ? { mark: 'writer', markTone: 'writer' as const }
            : entry.written
              ? {}
              : { mark: 'to write', markTone: 'todo' as const })
    }));
}

/**
 * T-W4 — the rail's children of Phrase ②: the server's CHAPTER-ENTRY rows, in composition order, named by their
 * own titles ("Chapter 1 — The Salt Road"), each addressed by `plotlines-group:<uuid>`.
 *
 * WHY NOT `Plotline 1 … N`. Those rows belong to the other Plotlines surface: a classic book's §4.3 records pane,
 * whose list the pane itself draws from `view.plotlines`. Which of the two the rail shows is the Setting's answer
 * (`story.plotlines_mode` + the phrase's own `mode`, read by `isPlotlinesGroups`), never a count of rows — so a
 * book that has both (a classic history, a dial the Author just turned on) cannot get a mixed rail.
 *
 * The marks come from `story-nav.plotlineRailEntries`, which evaluates the SAME `groupBlockingFindings` and
 * `isGroupLocked` selectors the entry pane uses (through the phrase-swap view), so a badge can never disagree
 * with the pane it points at. No score percentages here: Phrase ②'s entries are contracts, and nothing in the wire
 * scores a contract the way a Reader pass scores a Summary section.
 */
function plotlineChildren(view: StoryViewData): OutlineChildSpec[] {
    return plotlineRailEntries(view).map((row) => ({
        ref: row.ref,
        title: row.entry.title,
        findings: row.blockingFindings,
        ...(row.locked === true
            ? { locked: true as const, lockedBy: row.lockedBy, lockedRevision: row.lockedRevision }
            : {}),
        ...(row.writerBusy
            ? { mark: 'writer', markTone: 'writer' as const }
            : row.written
              ? {}
              : { mark: 'to write', markTone: 'todo' as const })
    }));
}

/**
 * T3 — the score's tooltip: the number, and the movement behind it when there is one.
 *
 * The rail row prints `84%` and nothing else, because the column is 320px and the number is what the eye
 * compares down the list. What the row cannot fit is the direction, and that is the half the request asks
 * for ("the user sees how the phrase improves over time"), so it goes where the rail puts every other
 * un-fittable fact — the row's own `title`. A first pass says so plainly instead of implying a missing zero.
 */
function scoreTooltip(score: number, previousScore?: number): string {
    if (previousScore === undefined) return `Score ${score}% — the first pass over this group`;

    const moved = score - previousScore;

    return `Score ${score}% — ${moved === 0 ? 'unchanged' : moved > 0 ? `up ${moved}` : `down ${-moved}`} from ${previousScore}%`;
}

/**
 * R1 — the lock's tooltip words: the two facts the 320px rail cannot fit.
 *
 * The row itself prints ONE word, `Locked`, because the row's job is to say "this text is settled" and the
 * accessible name has to stay short enough to read down the list. WHICH text is settled (the revision the lock
 * stands on) and WHO settled it are the facts a hover is for, and they come from the same selectors the pane's
 * badge prints (`story-nav.summaryGroupEntries`), so rail and pane describe one lock. An actor the wire never
 * named reads as `by crew` rather than as a guessed Author — the pane's badge follows the same rule
 * (`story-contract.groupLockActorLabel`).
 */
function lockTooltip(child: OutlineChildSpec): string {
    const who = groupLockActorLabel(child.lockedBy).toLowerCase();
    const revision = child.lockedRevision === undefined ? '' : ` at Revision ${child.lockedRevision}`;

    return `Locked in${revision} by ${who}: this group's text is settled content — it cannot be revised from its pane, and the other groups adapt to it (R1).`;
}

/**
 * T3 — the phrase header's tooltip. The header prints ONE number, the average, so the tooltip carries the
 * breakdown behind it: every group's latest percentage, in server order. `not scored` can only appear on a
 * group the average already ignores, and since one pass scores all five, in practice it never shows.
 */
function overallScoreTooltip(view: StoryViewData): string {
    const parts = summaryGroupEntries(view).map(
        (entry) => `${entry.group.title} ${entry.score === undefined ? 'not scored' : `${entry.score}%`}`
    );

    return `Overall score — the average of every group: ${parts.join(', ')}`;
}

/**
 * T4/R2, then R6: a parked draft is marked in the row itself, not by hover. The visible mark used to be a
 * `DISCARDED` pill; the report is that the word is noise once the row is obviously not the live one, so the
 * visible mark is now the STRUCK-THROUGH revision name (`app.css` — `.outline-child[data-state='discarded']
 * .outline-name`). The row's own `data-state` is what the stylesheet keys on, so the marker needs no text
 * to be visible, survives greyscale (a strike is a shape, not a hue), and adds nothing to scan.
 *
 * The word still exists for a screen reader, as `.sr-only` text inside the row's button: the row stays a
 * plain selectable button, its accessible name still reads "Revision 1 Discarded", and no `aria-label` is
 * used — an `aria-label` would REPLACE that name and swallow the findings badge's and attention mark's own
 * labels. The tooltip keeps the recorded reason. No SVG: a leaf row carries no icon, and a test pins that.
 *
 * The text node before the span is the word separator, and its POSITION is load-bearing (T5 pinned the
 * failure: the tree flattened the row into "Revision 1Discarded"). Verified against `dom-accessibility-api`,
 * the implementation the suite queries through:
 *   - it sits at the ROW level, as a sibling of the two spans, not at the edge of the span's own text — each
 *     nested element's contribution is computed and then TRIMMED (`computeMiscTextAlternative` ends in
 *     `.trim()`), so a space inside or beside the span's text is dropped, while a text node between the spans
 *     is returned verbatim by the text-node branch and lands mid-string, out of reach of the final trim;
 *   - a plain space, not an NBSP: the flat string keeps a single mid-string whitespace, so the name is
 *     "Revision 1 Discarded". An NBSP would surface as U+00A0 in the name (that implementation only
 *     collapses RUNS of whitespace), which no reader promises to normalize;
 *   - the name does not depend on the stylesheet either: `.sr-only` clips the box visually but never removes
 *     the text from the accessibility tree, and the accessible name comes from the text alone.
 */
function DiscardedMark() {
    return (
        <>
            {' '}
            <span className="sr-only">Discarded</span>
        </>
    );
}

/**
 * R1 — the rail's lock mark, and it is a WORD rather than a glyph.
 *
 * Same rule the discarded row already follows: the mark has to survive greyscale and a screen reader, and the
 * accessible name is built from text. `Locked` sits in the row right after the group's title, so a reader
 * hearing the list hears "Premise Locked" before any of the counts, and the padlock colour (`app.css`) only
 * adds speed. The word is short on purpose: the rail is 320px, and the facts it cannot fit — which revision is
 * settled, and who settled it — ride the row's tooltip (`lockTooltip`).
 */
function LockMark() {
    return (
        <>
            {' '}
            <span className="outline-lock" data-testid="outline-group-lock">
                Locked
            </span>
        </>
    );
}

/**
 * The row's tooltip, COMPOSED from every reason the row has, joined in reading order.
 *
 * The old spelling was a `??` chain, so an attention label hid the state line entirely. Segments keep both:
 * attention label, then `title · state`, then `Discard reason: …` when one is recorded. A non-discarded row
 * is byte-for-byte what it was before, and a row with nothing to say still has no tooltip.
 */
function childTooltip(child: OutlineChildSpec, attention: StoryAttention | undefined): string | undefined {
    const segments: string[] = [];

    if (attention !== undefined) segments.push(attention.label);
    // R1 — the lock's two un-fittable facts, in reading order after the attention label and before the engine
    // state line (a group row has no `state`, so for a locked group this is usually the whole tooltip).
    if (child.locked === true) segments.push(lockTooltip(child));
    if (child.state !== undefined) segments.push(`${child.title} · ${child.state}`);
    if (child.state === DISCARDED_STATE && child.discardReason !== undefined) {
        segments.push(`Discard reason: ${child.discardReason}`);
    }

    return segments.length > 0 ? segments.join(' · ') : undefined;
}

/** The rail's one status mark: a dot plus the reason, never a second paragraph of detail. */
function AttentionMark({ attention }: { attention: StoryAttention }) {
    return (
        <span className="outline-attention" data-tone={attention.tone} title={attention.label}>
            <span className="outline-attention__dot" aria-hidden="true" />
            <span className="sr-only">{attention.label}</span>
        </span>
    );
}

function attentionClass(attention: StoryAttention | undefined): string {
    return attention ? ` outline-item--attention outline-item--${attention.tone}` : '';
}

export interface StoryOutlineProps {
    view?: StoryViewData | null;
    selection: StorySelection;
    onSelect: (selection: StorySelection) => void;
}

/** The id a phrase header's `aria-controls` points at: the `<ul>` that holds that phrase's rows. */
const outlineChildrenId = (phrase: StoryPhraseKey): string => `outline-children-${phrase}`;

export function StoryOutline({ view, selection, onSelect }: StoryOutlineProps) {
    // U-21 — the phrases the Author has folded away. A Set of KEYS (not a boolean per phrase, not indices):
    // empty means every phrase is expanded, which is the default the rail had before this existed, so no
    // existing row test changes. It is view state, not story state: it is local to this rail, never sent to
    // the server, never in the URL, and a refetch of `view` does not reset it (the fold survives a poll).
    //
    // The hook runs before the `!view` early return below: a hook after a conditional return would change
    // the hook order between the loading and loaded renders and React would drop this state.
    const [collapsed, setCollapsed] = useState<Set<StoryPhraseKey>>(() => new Set<StoryPhraseKey>());

    // Immutable toggle: a NEW Set each time, otherwise React sees the same reference and never re-renders,
    // and the fold would look broken. Unknown keys are simply absent, so a phrase is always expandable.
    const toggleCollapsed = (phrase: StoryPhraseKey): void => {
        setCollapsed((current) => {
            const next = new Set(current);

            if (next.has(phrase)) next.delete(phrase);
            else next.add(phrase);

            return next;
        });
    };

    if (!view) {
        return (
            <section className="panel panel--outline" aria-label="Story phrases" data-testid="story-outline">
                <p className="panel__empty">reading the story…</p>
            </section>
        );
    }

    const ready = summaryReadyForReview(view);
    const cast = castMembers(view);
    const chapters = chaptersInOrder(view);
    const revisions = summaryRevisions(view);
    // R6 — the one question that decides what the Summary phrase's children ARE: the server's five group rows,
    // or the sampling round's Revision 1…N drafts. `isGroupSummary` reads `story.summary_mode` (echoed by the
    // phrase read), so the answer cannot drift from what the wire says the book is.
    const grouped = isGroupSummary(view);
    // T-W4 — the same question for Phrase ②, and it is a DIFFERENT dial: `story.plotlines_mode` (echoed by the
    // Phrase ② read). A book may be grouped on one phrase and classic on the other, and the two answers may not
    // borrow each other's value — a Summary switch does not rewrite the Plotlines surface, and vice versa.
    const groupedPlotlines = isPlotlinesGroups(view);
    // T-W4 — R5's step ②: the Summary is compiled and Phrase ② has not started, which is the one frame where the
    // handoff is live. Same predicate the pane's button is built from (`plotlinesReadyToStart` →
    // `story-contract.plotlinesHandoffRefusal`), so a rail tick that promises "start" and a disabled button cannot
    // appear on the same frame. The phrase's own read gates the ROWS below, never this tick.
    const plotlinesStart = plotlinesReadyToStart(view);
    // The phrase's own started flag (`story.phrase_started.plotlines`), read separately from the tick above on
    // purpose: an uncompiled Summary makes the tick absent too, and the two marks mean different things.
    const plotlinesStartedNow = plotlinesStarted(view);
    // T-W4 — whether Phrase ②'s read has LANDED, which is the only thing that separates "the entries are on their
    // way" from "the entries could not be read" (the U6 rule, for the second route). It reads `view.phraseDetail`,
    // the frame's own cache slot, so the rail and the pane answer from one fact.
    const plotlinesDetailLanded = phraseDetailReadLanded(view);
    // T3 — the phrase header's OVERALL score, the mean of every group's latest score. It is undefined unless
    // EVERY group carries one, because one scoring pass scores all five: a book with four scored rows is a
    // pass that has not reached the fifth, and an average of the rows that happened to arrive is a number
    // the server never claimed. Absent means the header renders nothing, exactly as the tick does when the
    // Summary is not ready.
    const overallScore = grouped ? phraseOverallScore(view) : undefined;

    return (
        <nav className="outline" aria-label="Story phrases" data-testid="story-outline">
            {/* U-25 — THE TOP-LEVEL SEED ROW IS GONE. It sat above `Phrases` naming one Seed for the whole Story,
                which is the claim the request retires: the Seed belongs to a phrase, and each phrase has its own.
                The row moved DOWN into every phrase's own children list (`seedChild`), where its pane can answer
                about THAT phrase's text — `story.idea` under Phrase ①, the copied Seed under Phrase ②. */}
            <div className="outline-group">
                <h2 className="outline-heading">Phrases</h2>
                <ol className="outline-phases">
                    {STORY_PHRASES.map((phrase) => {
                        const recordChildren: OutlineChildSpec[] =
                            phrase.key === 'summary'
                                ? grouped
                                  ? groupChildren(view)
                                  : summaryChildren(revisions)
                                : // T-W4 — Phrase ②'s rows are the chapter entries, and ONLY on the grouped
                                  // pipeline. A classic book's rail row opens the §4.3 records pane, which lists
                                  // its own plotlines in the content area; putting those records in the rail as
                                  // well would put two Plotlines lists on screen at once.
                                  phrase.key === 'plotlines'
                                  ? groupedPlotlines
                                      ? plotlineChildren(view)
                                      : []
                                  : phrase.key === 'characters'
                                    ? cast.map((member) => ({ ref: member.id, title: member.name || member.id }))
                                    : chapters.map((chapter) => ({
                                          ref: chapter.id,
                                          title: `Chapter ${chapter.order} — ${chapter.title}`
                                      }));

                        // U-25 — the Seed is EVERY phrase's first child, whatever the phrase's record rows happen
                        // to be (grouped, sampled, or none at all). It is prepended rather than appended because the
                        // Seed is the phrase's input: reading the list top-down reads the pipeline in order. This is
                        // also what makes a classic-pipeline Phrase ② gain a children list — it had no rows before,
                        // and its Seed is now a row the Author can open without leaving the rail.
                        const children: OutlineChildSpec[] = [seedChild(), ...recordChildren];

                        const phraseAttention = attentionFor(view, phrase.key);
                        // U-21: fold state is per phrase, so folding Summary leaves Characters open.
                        const isCollapsed = collapsed.has(phrase.key);
                        // The ONE condition that decides whether the rows exist: expanded AND non-empty. It
                        // drives both the `<ul>` below and the header's `aria-controls`, so the IDREF can never
                        // point at a list that is not in the DOM (folded phrase, or a phrase with no children).
                        //
                        // U-25 — SINCE EVERY PHRASE CARRIES ITS SEED ROW, `children` is never empty: the only state
                        // that hides a phrase's list is the fold. A classic-pipeline Phrase ②, which had no rows at
                        // all before, now has exactly one (its Seed), so its header gains `aria-controls` and its
                        // `<ul>` exists — which is the point: the phrase's Seed was unreachable from the rail.
                        const showsChildren = !isCollapsed && children.length > 0;

                        return (
                            <li className="outline-phase" key={phrase.key}>
                                <button
                                    type="button"
                                    className={`outline-item outline-item--phrase${selection.panel === phrase.key ? ' outline-item--active' : ''}${attentionClass(phraseAttention)}`}
                                    aria-current={isActive(selection, phrase.key) ? 'page' : undefined}
                                    // U-21: the header doubles as the disclosure control for this phrase's rows.
                                    // `aria-expanded` is ALWAYS present and current — it is the state a reader
                                    // announces. `aria-controls` is only meaningful while the list it names is in
                                    // the DOM, and a folded list (and a childless phrase's list) is UNMOUNTED
                                    // below, which is what drops its rows from tab order; pointing at a removed
                                    // id would be a dangling IDREF, so the attribute is omitted with the list.
                                    // `aria-current` stays a SEPARATE concern: folding a phrase does not
                                    // un-select it, and selecting a phrase does not fold it.
                                    aria-expanded={!isCollapsed}
                                    aria-controls={showsChildren ? outlineChildrenId(phrase.key) : undefined}
                                    data-attention={phraseAttention?.tone}
                                    title={phraseAttention?.label}
                                    onClick={() => {
                                        // U-21: one click folds, the next unfolds — on the WHOLE header, because a
                                        // second control (a chevron) would be chrome the rail has never had and
                                        // the package's other disclosure rows put the toggle on the row itself.
                                        toggleCollapsed(phrase.key);
                                        // …and navigation still fires on EVERY click, even when this phrase is
                                        // already the selection. That is a shell invariant, not an accident:
                                        // clicking the phrase row is how the Author drops a revision ref and
                                        // clears the selected-agent thread view, and an early return here would
                                        // leave the content area on a stale child of a phrase it just folded.
                                        onSelect({ panel: phrase.key });
                                    }}
                                >
                                    <span className="outline-index">Phrase {phrase.number}</span>
                                    <span className="outline-name">{phrase.title}</span>
                                    {phraseAttention ? <AttentionMark attention={phraseAttention} /> : null}
                                    {phrase.key === 'summary' && ready ? (
                                        <span className="outline-ready" title="ready for review">
                                            <CheckIcon />
                                            <span className="sr-only">ready for review</span>
                                        </span>
                                    ) : null}
                                    {phrase.key === 'characters' && cast.length === 0 && ready ? (
                                        <span className="outline-start" title="characters can be started">
                                            start
                                        </span>
                                    ) : null}
                                    {/* T-W4 — R5's handoff prompt, Phrase ②'s equivalent of the Summary's tick. The
                                        Summary is compiled and the phrase has not started, so the pane the Author is
                                        one click from has a live "start Phrase 2 from the compiled Summary" button —
                                        and ONLY that predicate says so (`story-contract.summaryIsCompiled` +
                                        `phrase_started.plotlines`, the same two facts the button's refusal reads).
                                        A started phrase shows no tick: the handoff is one-way (D-72), and a mark that
                                                kept promising a start nobody can press is noise. */}
                                    {phrase.key === 'plotlines' && plotlinesStart ? (
                                        <span
                                            className="outline-start"
                                            data-testid="outline-plotlines-start"
                                            title="the compiled Summary is ready to start Phrase 2"
                                        >
                                            start
                                        </span>
                                    ) : null}
                                    {/* T-W4 — the started mark, on the phrase's own flag (`story.phrase_started.plotlines`)
                                        rather than on the absence of the tick above: an uncompiled Summary also makes
                                        the tick absent, and labelling THAT "started" would be a lie. Once the phrase
                                        has started, the rail says so rather than leaving the row ambiguous: the copied
                                        Seed, the entries and the claim keys were written against it, so nothing here is
                                        repeatable (D-72), and the Author who wonders "did it start?" reads one word
                                        instead of opening the pane. The tooltip names WHICH pipeline it started on,
                                        because that decides whether the pane below shows entries or records. */}
                                    {phrase.key === 'plotlines' && plotlinesStartedNow ? (
                                        <span
                                            className="outline-state outline-state--writer"
                                            data-testid="outline-plotlines-state"
                                            title={
                                                groupedPlotlines
                                                    ? 'Phrase 2 has started: its Seed is copied, and its chapter entries are the surface you revise.'
                                                    : 'Phrase 2 is running on the classic plotline tools: the pane shows the §4.3 records, not chapter entries.'
                                            }
                                        >
                                            started
                                        </span>
                                    ) : null}
                                    {/* T3 — the phrase's OVERALL score, the mean of the five groups. It rides the
                                        Summary header because the header is the one row that stands for the whole
                                        Overview, and it is the number the Author compares between passes. The
                                        leading space is a word boundary, not layout: an accessible name is built
                                        from TEXT, so without it the row reads "…ready for review84%" (the same fix
                                        R6 pinned for the child rows below). Absent means never scored, and a `0%`
                                        there would claim a review that never ran. */}
                                    {overallScore === undefined || phrase.key !== 'summary' ? null : (
                                        <>
                                            {' '}
                                            <span
                                                className="outline-score outline-score--header"
                                                data-testid="outline-phrase-score"
                                                aria-label={`Overall score ${overallScore}%`}
                                                title={overallScoreTooltip(view)}
                                            >
                                                {overallScore}%
                                            </span>
                                        </>
                                    )}
                                </button>

                                {/* U-21: a folded phrase renders NO list at all, so its rows leave the DOM and the
                                    tab order rather than sitting there hidden — the point of the request is to
                                    clear the rail. Nothing is deleted: the rows come back exactly as they were,
                                    with their strikes, badges and tooltips, on the next click. A phrase with no
                                    children has nothing to disclose, so it renders no list either way. */}
                                {showsChildren ? (
                                    <ul className="outline-children" id={outlineChildrenId(phrase.key)}>
                                        {children.map((child) => {
                                            const childAttention = attentionFor(view, phrase.key, child.ref);

                                            return (
                                                <li key={child.ref}>
                                                    <button
                                                        type="button"
                                                        // U-25 — the Seed row is a child row (`.outline-child`, so it
                                                        // folds, indents and navigates like every other leaf) that
                                                        // KEEPS the rail's `.outline-item--seed` hook: the stylesheet's
                                                        // one rule for "a Seed row" (`app.css:1624`) and the class the
                                                        // acceptance check for "no top-level Seed row" reads, beside
                                                        // the `data-testid="outline-seed"` the rail puts on it.
                                                        // The order of the two class names in this attribute changes
                                                        // NOTHING in ink: at equal specificity (one class each) the
                                                        // gap comes out `.outline-child`'s 5px because that rule sits
                                                        // LATER IN THE STYLESHEET (`app.css:1689`, after the seed
                                                        // rule at 1624) — cascade source order, not attribute order.
                                                        // The seed rule's own `gap: 8px` is therefore always
                                                        // overridden today; it stays as the hook, and a rule meant to
                                                        // win from here has to out-specify `.outline-child`.
                                                        className={`outline-child${child.seed === true ? ' outline-item--seed' : ''}${isActive(selection, phrase.key, child.ref) ? ' outline-child--active' : ''}${attentionClass(childAttention)}`}
                                                        data-attention={childAttention?.tone}
                                                        data-state={child.state}
                                                        // U-25 — the one hook the Seed row adds: a phrase's Seed is the
                                                        // only child row a test needs to name without its title
                                                        // (every phrase's row is literally titled `Seed`).
                                                        data-testid={child.seed === true ? 'outline-seed' : undefined}
                                                        title={childTooltip(child, childAttention)}
                                                        onClick={() => onSelect({ panel: phrase.key, ref: child.ref })}
                                                    >
                                                        <span className="outline-name">{child.title}</span>
                                                        {/* R1 — the lock word, first thing after the title: a reader
                                                            scanning the rail learns which sections are settled before
                                                            reading any of their counts. It sits BEFORE the row's
                                                            separator block (line 452's `<> </>`), and carries its own
                                                            leading space, because an accessible name is built from
                                                            text nodes between elements — the same rule T5 pinned for
                                                            the discarded row and R6 pinned for the state word. Without
                                                            it the row would read "PremiseLocked". */}
                                                        {child.locked === true ? <LockMark /> : null}
                                                        {/* R6 — a GROUP row's one state word. A group has no engine
                                                            state string (`data-state` above stays unset for group
                                                            rows, so they never take the struck-out `discarded`
                                                            mark), so the honest marks are the write's own: the
                                                            Writer holds this group's job, or nothing has been
                                                            written yet. Plain text in the row, so the word is in
                                                            the accessible name and survives greyscale; the pill's
                                                            border and colour (`app.css`) only add speed. */}
                                                        {/* R6 — the row-level space the accessible name needs. An
                                            accessible name is built from TEXT, and flex `gap` is not text: with no
                                            separator the row reads "Premise1 open Critical or Major finding". This
                                            is the same fix T5 pinned for the discarded row (its `' '` text node
                                            sits between the two spans, out of reach of the name's final trim), and
                                            the same reasoning applies to the state word, the badge and the
                                            attention mark. A run of these spaces collapses to one, so a row that
                                            also carries `DiscardedMark` is unaffected. */}
                                                        {child.mark !== undefined ||
                                                        (child.findings !== undefined && child.findings > 0) ||
                                                        childAttention !== undefined ? (
                                                            <> </>
                                                        ) : null}
                                                        {child.mark !== undefined ? (
                                                            <span
                                                                className={`outline-state outline-state--${child.markTone ?? 'todo'}`}
                                                                data-testid="outline-group-state"
                                                            >
                                                                {child.mark}
                                                            </span>
                                                        ) : null}
                                                        {/* T4/R2 + R6: the visible mark is this row's struck name
                                                            (`data-state` drives the stylesheet); the word lives in
                                                            an `sr-only` span so a reader still says it, and the
                                                            row stays a plain button the Author can still select
                                                            — the only way to open that draft and read its reason
                                                            (T4/R1), parked history included. */}
                                                        {child.state === DISCARDED_STATE ? <DiscardedMark /> : null}
                                                        {/* R6: a GROUP row needs the same word boundary BETWEEN its state
                                                            word and its badge, or the name reads "Theme writer2 open…".
                                                            `DiscardedMark` already emits its own leading space (line 159),
                                                            so sampling rows keep their existing names untouched. */}
                                                        {child.mark !== undefined ? ' ' : null}
                                                        {child.findings !== undefined && child.findings > 0 ? (
                                                            <span
                                                                className="outline-badge"
                                                                title={`${child.findings} open Critical or Major finding${child.findings === 1 ? '' : 's'}`}
                                                                aria-label={`${child.findings} open Critical or Major finding${child.findings === 1 ? '' : 's'}`}
                                                            >
                                                                {child.findings}
                                                            </span>
                                                        ) : null}
                                                        {/* R6: the same separator again before the attention mark —
                                                            a row can carry a name, a state word, a badge AND a
                                                            mark, and every one of those contributions needs a word
                                                            boundary in front of it or the name runs them together
                                                            ("…finding1 open finding…"). */}
                                                        {childAttention ? (
                                                            <>
                                                                {child.findings !== undefined && child.findings > 0
                                                                    ? ' '
                                                                    : null}
                                                                <AttentionMark attention={childAttention} />
                                                            </>
                                                        ) : null}
                                                        {/* T3 — the group's latest percentage, the LAST thing in the
                                                            row, so it lands at the right end of the column: the name
                                                            span already holds `flex: 1`, so this number needs no
                                                            margin of its own. `84%` alone is not a name, hence the
                                                            `aria-label`; the direction of travel — the half of the
                                                            request a 320px rail cannot fit — rides `title`, the same
                                                            split the badge above it uses. Absent means NEVER scored:
                                                            an unscored group prints nothing, because `0%` is a score
                                                            the Critic actually gave and printing one would be a lie. */}
                                                        {child.score === undefined ? null : (
                                                            <>
                                                                {' '}
                                                                <span
                                                                    className="outline-score"
                                                                    data-testid="outline-group-score"
                                                                    aria-label={`Score ${child.score}%`}
                                                                    title={scoreTooltip(child.score, child.previousScore)}
                                                                >
                                                                    {child.score}%
                                                                </span>
                                                            </>
                                                        )}
                                                    </button>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                ) : null}
                                {/* R6 / U6 — a group-managed book whose phrase read has NOT landed. The five groups
                                    are part of the contract, so the rail says the rows are on their way instead of
                                    showing a phrase with nothing under it, which reads as an empty book. One line,
                                    not a spinner (U-11), and it is gone the moment `GET /stories/:id/phrases`
                                    answers — including when it answers with five unwritten groups, which is a real
                                    state and gets real rows. A folded phrase keeps showing nothing (U-21 unmounts the
                                    rows on purpose). */}
                                {phrase.key === 'summary' && grouped && !phraseLoaded(view) && !isCollapsed ? (
                                    phraseReadError(view) === undefined ? (
                                        /* Pending: the read is in flight and the rows will arrive with it. */
                                        <p className="outline-pending" data-testid="outline-phrase-pending">
                                            reading the Summary groups…
                                        </p>
                                    ) : (
                                        /* R-T2/F2 — the read FAILED. A rail that keeps promising "reading…"
                                           over a 503 hides the only actionable fact the desk has: the server's
                                           own sentence, plus the fact that the groups exist and are merely
                                           unread. Kept to one line like the pending state (U-11), and the
                                           Story's other rows stay exactly where they were. */
                                        <p
                                            className="outline-pending outline-pending--error"
                                            data-testid="outline-phrase-error"
                                            title={phraseReadError(view)}
                                        >
                                            {`Summary groups unread: ${phraseReadError(view)}`}
                                        </p>
                                    )
                                ) : null}
                                {/* T-W4 / U6 — the SAME three answers for Phrase ②: rows on their way, rows unread,
                                    or nothing to show. The gating differs from Summary's in one honest way: Phrase ②
                                    is fetched on demand (only when the dial is on or the surface is already open —
                                    `state.ts:phraseDetailWanted`), so a classic, unstarted book has NO read and must
                                    not render a loading line for a route it never called. That is why the line hangs
                                    off `groupedPlotlines` (the Setting's answer) and not off the selection: an Author
                                    standing on the §4.3 records pane gets no Phrase ② furniture at all. */}
                                {phrase.key === 'plotlines' && groupedPlotlines && !isCollapsed ? (
                                    !plotlinesDetailLanded ? (
                                        phraseDetailReadError(view) === undefined ? (
                                            /* Pending: the read is in flight and the entries arrive with it. */
                                            <p
                                                className="outline-pending"
                                                data-testid="outline-plotlines-pending"
                                            >
                                                reading the chapter entries…
                                            </p>
                                        ) : (
                                            /* R-T2/F2, restated for the second phrase: the entries exist and are
                                               merely unread, and the server's own sentence is the actionable fact. */
                                            <p
                                                className="outline-pending outline-pending--error"
                                                data-testid="outline-plotlines-error"
                                                title={phraseDetailReadError(view)}
                                            >
                                                {`Chapter entries unread: ${phraseDetailReadError(view)}`}
                                            </p>
                                        )
                                    ) : plotlinesStartedNow && recordChildren.length === 0 ? (
                                        /* The phrase started on the grouped pipeline and the read answered with NO
                                           entries — the brief has not been accepted yet, so the chapter entries have
                                           not been materialized. This is a real state, not a loading one, and it
                                           names the wait above the empty list. */
                                        <p className="outline-pending" data-testid="outline-plotlines-empty">
                                            no chapter entries yet — the phrase's brief has to be accepted before the
                                            chapters exist
                                        </p>
                                    ) : null
                                ) : null}
                            </li>
                        );
                    })}
                </ol>
            </div>

            {/* T-W4 — SUPPLEMENTS: the sheets the crew builds FROM the phrases, which are not steps in the
                numbered pipeline. Characters lives here now (it was Phrase 2 in the old numbering): the loop has no
                Characters phase to sign off, its records come from `view.cast` on the Story payload rather than from
                a phrase read, and the Author still needs the sheet one click away. It navigates with the same
                `{panel:'characters'}` selection it always used, so its pane, its rows and its tests are unchanged —
                only the heading above it moved, and the "Phrase 2" number is gone. */}
            <div className="outline-group">
                <h2 className="outline-heading">Supplements</h2>
                <ul className="outline-folders" data-testid="outline-supplements">
                    {STORY_SUPPLEMENTS.map((supplement) => {
                        const supplementAttention = attentionFor(view, supplement.key);

                        return (
                            <li key={supplement.key}>
                                <button
                                    type="button"
                                    className={`outline-item outline-item--folder${isActive(selection, supplement.key) ? ' outline-item--active' : ''}${attentionClass(supplementAttention)}`}
                                    aria-current={isActive(selection, supplement.key) ? 'page' : undefined}
                                    data-attention={supplementAttention?.tone}
                                    title={supplementAttention?.label}
                                    onClick={() => onSelect({ panel: supplement.key })}
                                >
                                    <span className="outline-name">{supplement.title}</span>
                                    {supplementAttention ? <AttentionMark attention={supplementAttention} /> : null}
                                </button>
                            </li>
                        );
                    })}
                </ul>
            </div>

            <div className="outline-group">
                <h2 className="outline-heading">Folders</h2>
                <ul className="outline-folders">
                    {STORY_FOLDERS.map((folder) => {
                        const folderAttention = attentionFor(view, folder.key);

                        return (
                            <li key={folder.key}>
                                <button
                                    type="button"
                                    className={`outline-item outline-item--folder${isActive(selection, folder.key) ? ' outline-item--active' : ''}${attentionClass(folderAttention)}`}
                                    aria-current={isActive(selection, folder.key) ? 'page' : undefined}
                                    data-attention={folderAttention?.tone}
                                    title={folderAttention?.label}
                                    onClick={() => onSelect({ panel: folder.key })}
                                >
                                    <span className="outline-name">{folder.title}</span>
                                    {folderAttention ? <AttentionMark attention={folderAttention} /> : null}
                                </button>
                            </li>
                        );
                    })}
                </ul>
            </div>
        </nav>
    );
}

export default StoryOutline;
