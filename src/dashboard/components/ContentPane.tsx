// The center pane: one document of the open Title, rendered from the fold in
// content-view.ts and nothing else.
//
// THIS COMPONENT DECIDES NOTHING. The document comes out of `contentViewOf(snapshot,
// selection, detail)` — a pure function a test pins without React or a server — and
// every click runs a command. That is why the pane can be read in a storybook with
// three state cells and no network.
//
// THE FOUR TABS are the same four collections the tree expands, so the center pane
// stays usable on its own (a narrow screen hides the tree), and both halves read the
// SAME selection cell, which is what keeps them honest with each other.
import {
    CENTER_TABS,
    CONTENT_LABELS,
    CONTENT_REFRESH_COMMAND,
    CONTENT_SELECT_COMMAND,
    CONTENT_SELECT_STATE,
    CONTENT_DETAIL_STATE,
    RECORDS_STATE,
    TITLES_ACTIVE_STATE,
    TITLES_STATE,
    type ContentSelection,
    type ChapterDetailState,
    type RecordsState,
    type TitlesState
} from '../contract';
import { contentViewOf } from '../content-view';
import { useDashboardCommand, useDashboardValue } from '../state-hooks';

export function ContentPane() {
    const store = useDashboardValue<RecordsState>(RECORDS_STATE);
    const selection = useDashboardValue<ContentSelection>(CONTENT_SELECT_STATE);
    const detail = useDashboardValue<ChapterDetailState>(CONTENT_DETAIL_STATE);
    const titles = useDashboardValue<TitlesState>(TITLES_STATE);
    const activeId = useDashboardValue<string>(TITLES_ACTIVE_STATE);

    const select = useDashboardCommand<ContentSelection, ContentSelection>(CONTENT_SELECT_COMMAND);
    const refresh = useDashboardCommand<void, Promise<unknown>>(CONTENT_REFRESH_COMMAND);

    const view = contentViewOf(store.data, selection, detail);
    const title = titles.rows.find((row) => row.id === activeId)?.label ?? '';

    if (activeId.length === 0) {
        // No Title, no story. This is the honest first screen, not an empty document.
        return <p className="notice">Pick a Title in the tree, or start a new one.</p>;
    }

    return (
        <div className="stack document">
            <nav className="document__tabs" role="group" aria-label="Documents">
                {CENTER_TABS.map((kind) => (
                    <button
                        key={kind}
                        className="button"
                        type="button"
                        data-active={selection.kind === kind ? 'yes' : 'no'}
                        aria-pressed={selection.kind === kind ? 'true' : 'false'}
                        // A tab is a document overview: the id is cleared for everything but a
                        // specific chapter, which the tree selects.
                        onClick={() => void select({ kind, id: '' })}
                    >
                        {/* One label source with the tree section and the document title below
                            (`CONTENT_LABELS`), so a document is never called two things: the
                            `chapters` collection is the PLOTLINES document, and the raw
                            collection key never reaches an operator's eye. */}
                        {CONTENT_LABELS[kind]}
                    </button>
                ))}
                <button className="button" type="button" onClick={() => void refresh()} aria-label="Re-read this document">
                    re-read
                </button>
            </nav>

            <header className="document__head">
                <h3 className="document__title">{view.title}</h3>
                <p className="hint">
                    {title} · {view.blocks.length} block{view.blocks.length === 1 ? '' : 's'} · store rev {store.data.storeRev}
                </p>
            </header>

            {store.phase === 'error' ? <p className="notice notice--error">The store could not be re-read: {store.error}</p> : null}
            {view.notice.length > 0 ? <p className="notice">{view.notice}</p> : null}

            <article className="document__body">
                {view.blocks.map((block, index) => (
                    <section key={`${view.kind}-${index}`} className="block" data-kind={block.meta}>
                        {block.heading.length > 0 ? <h4 className="block__heading">{block.heading}</h4> : null}
                        <p className="block__body">{block.body.length > 0 ? block.body : '—'}</p>
                        {block.meta.length > 0 ? <p className="block__meta">{block.meta}</p> : null}
                    </section>
                ))}
            </article>
        </div>
    );
}
