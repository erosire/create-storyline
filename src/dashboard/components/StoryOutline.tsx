// The left rail's second half: the Story's four phrases and its supporting folders.
//
// WHY THE RAIL IS A PURE NAVIGATOR: the content area shows exactly one thing at a time, and the
// rail is the only place that decision is made. It therefore renders the phrase/folder list and
// nothing else — no article counts, no "one article per folder" sentence, no running commentary.
// The Summary's tick is the one piece of state the rail adds, because "ready for review" is a
// decision the Author makes by opening the Summary, not a badge to read on every other pane.
import {
    STORY_FOLDERS,
    STORY_PHRASES,
    attentionFor,
    castMembers,
    chaptersInOrder,
    plotlinesInOrder,
    summaryReadyForReview
} from './story-nav';
import type { StoryAttention, StorySelection } from './story-nav';
import type { StoryViewData } from './story-contract';

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

function ChevronIcon() {
    return (
        <svg className="outline-chevron" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
            <path d="M4 2.5 8 6l-4 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
    );
}

function isActive(selection: StorySelection, panel: StorySelection['panel'], ref?: string): boolean {
    return selection.panel === panel && (selection.ref ?? undefined) === ref;
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

export function StoryOutline({ view, selection, onSelect }: StoryOutlineProps) {
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
                        const children =
                            phrase.key === 'summary'
                                ? [{ ref: 'overview', title: 'Overview' }]
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

                        return (
                            <li className="outline-phase" key={phrase.key}>
                                <button
                                    type="button"
                                    className={`outline-item outline-item--phrase${selection.panel === phrase.key ? ' outline-item--active' : ''}${attentionClass(phraseAttention)}`}
                                    aria-current={isActive(selection, phrase.key) ? 'page' : undefined}
                                    data-attention={phraseAttention?.tone}
                                    title={phraseAttention?.label}
                                    onClick={() => onSelect({ panel: phrase.key })}
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

                                {children.length > 0 ? (
                                    <ul className="outline-children">
                                        {children.map((child) => {
                                            const childAttention = attentionFor(view, phrase.key, child.ref);

                                            return (
                                                <li key={child.ref}>
                                                    <button
                                                        type="button"
                                                        className={`outline-child${isActive(selection, phrase.key, child.ref) ? ' outline-child--active' : ''}${attentionClass(childAttention)}`}
                                                        data-attention={childAttention?.tone}
                                                        title={childAttention?.label}
                                                        onClick={() => onSelect({ panel: phrase.key, ref: child.ref })}
                                                    >
                                                        <ChevronIcon />
                                                        <span>{child.title}</span>
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
