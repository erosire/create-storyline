// The Story knowledge directory — the left panel's second half.
//
// WHAT IT IS: eight folders (Summary, Plotlines, Chapters, Characters, Continuity, Goal, Ideas,
// Findings), each one durable harness knowledge article. The panel does not derive a single
// entry from the book: the server projects the book into the knowledge base, and this component
// only paints what the article says. That is the same division as L-14's levels — the client
// renders, it never recomputes.
//
// THE FOLDERS ARE ALWAYS THERE. A section with no records still carries a placeholder entry, so
// an empty Summary reads as "not written yet" rather than a missing directory. That is the point
// of a knowledge listing: the shape of the story is visible before the prose exists.
import type { StoryKnowledgeEntry, StoryKnowledgeTree } from '../api';

function FolderIcon() {
    return (
        <svg className="kn-icon" viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">
            <path
                d="M2.75 5.25A1.75 1.75 0 0 1 4.5 3.5h3.2c.46 0 .9.18 1.24.5l1.06 1h5.5a1.75 1.75 0 0 1 1.75 1.75v7.75a1.75 1.75 0 0 1-1.75 1.75h-11A1.75 1.75 0 0 1 2.75 14.5V5.25Z"
                fill="currentColor"
                opacity=".9"
            />
        </svg>
    );
}

function FileIcon() {
    return (
        <svg className="kn-icon" viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
            <path
                d="M4.5 2.75A1.75 1.75 0 0 1 6.25 1h5.1l4.4 4.4v10.85a1.75 1.75 0 0 1-1.75 1.75h-7.75a1.75 1.75 0 0 1-1.75-1.75V2.75Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
            />
            <path d="M11 1.4V5a1 1 0 0 0 1 1h3.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
        </svg>
    );
}

function isPlaceholder(entry: StoryKnowledgeEntry): boolean {
    return entry.tags.includes('placeholder') || entry.key.endsWith(':empty');
}

function Entry({ entry }: { entry: StoryKnowledgeEntry }) {
    const placeholder = isPlaceholder(entry);

    return (
        <li className="kn-entry" data-placeholder={placeholder ? 'true' : 'false'}>
            <details>
                <summary className="kn-entry__summary">
                    <FileIcon />
                    <span className="kn-entry__title">{entry.title}</span>
                    {placeholder ? <span className="kn-entry__tag">empty</span> : null}
                </summary>
                <pre className="kn-entry__body">{entry.body || 'Nothing recorded yet.'}</pre>
            </details>
        </li>
    );
}

export interface KnowledgeTreeProps {
    tree?: StoryKnowledgeTree | null;
    loading?: boolean;
}

export function KnowledgeTree({ tree, loading = false }: KnowledgeTreeProps) {
    const entryCount = tree?.sections.reduce((total, section) => total + section.entries.length, 0) ?? 0;

    return (
        <section className="panel panel--knowledge" data-testid="knowledge-tree">
            <header className="panel__head">
                <div>
                    <h2 className="panel__title">Knowledge</h2>
                    <p className="panel__subtitle">the story's durable memory · harness knowledge store</p>
                </div>
                <span className="pill pill--quiet" title="one harness knowledge article per folder">
                    {entryCount} notes
                </span>
            </header>

            {tree ? (
                <>
                    <p className="panel__hint">
                        {tree.story_title} · one article per folder, persisted outside every session.
                    </p>
                    {tree.degraded ? (
                        <p className="kn-warning" role="status">
                            The knowledge store did not answer; this is the book's fallback view.
                        </p>
                    ) : null}
                    <nav className="kn-tree" aria-label="Story knowledge">
                        {tree.sections.map((section) => (
                            <details
                                key={section.key}
                                className="kn-folder"
                                data-section={section.key}
                                data-empty={section.entries.every(isPlaceholder) ? 'true' : 'false'}
                                open
                            >
                                <summary className="kn-folder__summary">
                                    <FolderIcon />
                                    <span className="kn-folder__title">{section.title}</span>
                                    <span className="kn-folder__count">{section.entries.length}</span>
                                </summary>
                                <ul className="kn-entries">
                                    {section.entries.map((entry) => (
                                        <Entry key={entry.key} entry={entry} />
                                    ))}
                                </ul>
                            </details>
                        ))}
                    </nav>
                </>
            ) : (
                <p className="panel__empty">{loading ? 'reading the knowledge base…' : 'no knowledge yet'}</p>
            )}
        </section>
    );
}

export default KnowledgeTree;
