// The left rail's second half: the Story's four phrases and its supporting folders.
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
// A PHRASE HEADER IS ALSO A DISCLOSURE CONTROL (R8): clicking `Phrase 1` folds its children away and
// clicking it again unfolds them, which is how the Author gets the rail back to four lines. It changes
// what the rail SHOWS and nothing else — the collapsed phrase's rows are unmounted, never deleted, so
// re-expanding restores every row, its strike-through, its badge and its tooltip, in the same order.
import { useState } from 'react';
import {
    STORY_FOLDERS,
    STORY_PHRASES,
    attentionFor,
    castMembers,
    chaptersInOrder,
    plotlinesInOrder,
    summaryReadyForReview,
    summaryRevisionRef,
    summaryRevisions
} from './story-nav';
import type { StoryAttention, StoryPhraseKey, StorySelection, SummaryRevisionEntry } from './story-nav';
import { isOpenFinding, type StoryViewData } from './story-contract';

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
}

/** The engine's word for a draft a round parked as history (§4.17, P13/D-22). */
const DISCARDED_STATE = 'discarded';

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
 * The row's tooltip, COMPOSED from every reason the row has, joined in reading order.
 *
 * The old spelling was a `??` chain, so an attention label hid the state line entirely. Segments keep both:
 * attention label, then `title · state`, then `Discard reason: …` when one is recorded. A non-discarded row
 * is byte-for-byte what it was before, and a row with nothing to say still has no tooltip.
 */
function childTooltip(child: OutlineChildSpec, attention: StoryAttention | undefined): string | undefined {
    const segments: string[] = [];

    if (attention !== undefined) segments.push(attention.label);
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
    // R8 — the phrases the Author has folded away. A Set of KEYS (not a boolean per phrase, not indices):
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
    const plotlines = plotlinesInOrder(view);
    const chapters = chaptersInOrder(view);
    const revisions = summaryRevisions(view);

    return (
        <nav className="outline" aria-label="Story phrases" data-testid="story-outline">
            <div className="outline-group">
                <button
                    type="button"
                    className={`outline-item outline-item--seed${isActive(selection, 'seed') ? ' outline-item--active' : ''}`}
                    onClick={() => onSelect({ panel: 'seed' })}
                >
                    <span className="outline-index">Seed</span>
                    <span className="outline-name">The Author&apos;s idea</span>
                </button>
            </div>

            <div className="outline-group">
                <h2 className="outline-heading">Phrases</h2>
                <ol className="outline-phases">
                    {STORY_PHRASES.map((phrase) => {
                        const children: OutlineChildSpec[] =
                            phrase.key === 'summary'
                                ? summaryChildren(revisions)
                                : phrase.key === 'characters'
                                  ? cast.map((member) => ({ ref: member.id, title: member.name || member.id }))
                                  : phrase.key === 'plotlines'
                                    ? plotlines.map((plotline) => ({
                                          ref: plotline.id,
                                          title: `Plotline ${plotline.order}${plotline.heading ? ` — ${plotline.heading}` : ''}`
                                      }))
                                    : chapters.map((chapter) => ({
                                          ref: chapter.id,
                                          title: `Chapter ${chapter.order} — ${chapter.title}`
                                      }));

                        const phraseAttention = attentionFor(view, phrase.key);
                        // R8: fold state is per phrase, so folding Summary leaves Characters open.
                        const isCollapsed = collapsed.has(phrase.key);
                        // The ONE condition that decides whether the rows exist: expanded AND non-empty. It
                        // drives both the `<ul>` below and the header's `aria-controls`, so the IDREF can never
                        // point at a list that is not in the DOM (folded phrase, or a phrase with no children).
                        const showsChildren = !isCollapsed && children.length > 0;

                        return (
                            <li className="outline-phase" key={phrase.key}>
                                <button
                                    type="button"
                                    className={`outline-item outline-item--phrase${selection.panel === phrase.key ? ' outline-item--active' : ''}${attentionClass(phraseAttention)}`}
                                    aria-current={isActive(selection, phrase.key) ? 'page' : undefined}
                                    // R8: the header doubles as the disclosure control for this phrase's rows.
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
                                        // R8: one click folds, the next unfolds — on the WHOLE header, because a
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
                                </button>

                                {/* R8: a folded phrase renders NO list at all, so its rows leave the DOM and the
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
                                                        className={`outline-child${isActive(selection, phrase.key, child.ref) ? ' outline-child--active' : ''}${attentionClass(childAttention)}`}
                                                        data-attention={childAttention?.tone}
                                                        data-state={child.state}
                                                        title={childTooltip(child, childAttention)}
                                                        onClick={() => onSelect({ panel: phrase.key, ref: child.ref })}
                                                    >
                                                        <span className="outline-name">{child.title}</span>
                                                        {/* T4/R2 + R6: the visible mark is this row's struck name
                                                            (`data-state` drives the stylesheet); the word lives in
                                                            an `sr-only` span so a reader still says it, and the
                                                            row stays a plain button the Author can still select
                                                            — the only way to open that draft and read its reason
                                                            (T4/R1), parked history included. */}
                                                        {child.state === DISCARDED_STATE ? <DiscardedMark /> : null}
                                                        {child.findings !== undefined && child.findings > 0 ? (
                                                            <span
                                                                className="outline-badge"
                                                                title={`${child.findings} open Critical or Major finding${child.findings === 1 ? '' : 's'}`}
                                                                aria-label={`${child.findings} open Critical or Major finding${child.findings === 1 ? '' : 's'}`}
                                                            >
                                                                {child.findings}
                                                            </span>
                                                        ) : null}
                                                        {childAttention ? (
                                                            <AttentionMark attention={childAttention} />
                                                        ) : null}
                                                    </button>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                ) : null}
                            </li>
                        );
                    })}
                </ol>
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
