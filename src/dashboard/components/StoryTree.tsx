// The Title tree: every story this operator has, and the documents inside the open one.
//
// THE WORKSTATION'S ENTRY POINT (R-F). A Title is one story session, so the tree is
// the list of sessions the server has — never a harness, a preset, or a "current
// session" widget. Picking a Title makes it active (plugins/titles.ts re-dials the
// socket and re-reads the store), and the open Title expands into the four collections
// the story is made of, so the center pane is reached by one click from the name.
//
// WHAT THIS FILE MAY DECIDE: only what is expanded and what is being renamed. Every
// row's CONTENT comes from the shared snapshot (plugins/records.ts) and every action
// is a command — nothing here can issue a request, which is what makes the tree
// testable without a server.
//
// THE CHAPTER STATUS CHIPS are the workstation's one write into the story, and they
// ride the chapter's own `rev` (the CAS token), so a chip clicked after an agent
// edited the same chapter fails as a conflict instead of overwriting the newer edit.
// A chip that was REFUSED says so: the write's outcome lands in
// `storyline.chapters.write` (plugins/content.ts) and this row renders the engine's own
// sentence under the chapter it names. The click itself is a fire-and-forget `void`, so
// that cell is the only channel by which a refusal can reach the operator at all.
import { useState } from 'react';
import { CHAPTER_STATUSES, profileLabel, type ChapterStatus } from '../../api';
import {
    CENTER_TABS,
    CHAPTER_STATUS_COMMAND,
    CHAPTER_WRITE_STATE,
    CONTENT_LABELS,
    CONTENT_SELECT_COMMAND,
    CONTENT_SELECT_STATE,
    RECORDS_STATE,
    TITLES_ACTIVE_STATE,
    TITLES_CREATE_COMMAND,
    TITLES_RENAME_COMMAND,
    TITLES_SELECT_COMMAND,
    TITLES_STATE,
    type ChapterWriteResult,
    type ContentKind,
    type ContentSelection,
    type RecordsState,
    type TitlesState
} from '../contract';
import { useDashboardCommand, useDashboardValue } from '../state-hooks';

/** The tree's reading order is the center pane's tab order — one list, in contract.ts. */
const GROUPS = CENTER_TABS;

/** True when the snapshot named this collection at all (an unbound store reads differently). */
function isBound(store: RecordsState['data'], kind: ContentKind): boolean {
    if (kind === 'outlines') return store.hasOutlines;
    if (kind === 'storyline') return store.hasStoryline;
    if (kind === 'chapters') return store.hasChapters;

    return store.hasProfiles;
}

/** How many rows a group holds in the current snapshot. */
function groupSize(store: RecordsState['data'], kind: ContentKind): number {
    if (kind === 'outlines') return store.outlines.length;
    if (kind === 'storyline') return store.storyline.length;
    if (kind === 'chapters') return store.chapters.length;

    return store.profiles.length;
}

export function StoryTree() {
    const titles = useDashboardValue<TitlesState>(TITLES_STATE);
    const activeId = useDashboardValue<string>(TITLES_ACTIVE_STATE);
    const store = useDashboardValue<RecordsState>(RECORDS_STATE);
    const selection = useDashboardValue<ContentSelection>(CONTENT_SELECT_STATE);

    // The last status write, per chapter: `error` non-empty means the engine refused it, and
    // the sentence is the engine's own (plugins/content.ts publishes it; this row shows it).
    const write = useDashboardValue<ChapterWriteResult>(CHAPTER_WRITE_STATE);

    const selectTitle = useDashboardCommand<string, Promise<string>>(TITLES_SELECT_COMMAND);
    const createTitle = useDashboardCommand<string, Promise<unknown>>(TITLES_CREATE_COMMAND);
    const renameTitle = useDashboardCommand<{ id: string; name: string }, Promise<unknown>>(TITLES_RENAME_COMMAND);
    const selectContent = useDashboardCommand<ContentSelection, ContentSelection>(CONTENT_SELECT_COMMAND);
    const setStatus = useDashboardCommand<{ id: string; rev: number; status: ChapterStatus }, Promise<unknown>>(CHAPTER_STATUS_COMMAND);

    // Collapse state is the tree's own: an operator's click should not round-trip
    // through the dashboard, and the open Title starts expanded because that is what
    // "open" means here.
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
    const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({ outlines: true });
    const [draft, setDraft] = useState<{ id: string; name: string } | null>(null);
    const [fresh, setFresh] = useState('');

    const toggleGroup = (kind: ContentKind): void => setOpenGroups((previous) => ({ ...previous, [kind]: !previous[kind] }));

    const open = (kind: ContentKind, id: string): void => void selectContent({ kind, id });

    return (
        <div className="stack tree">
            <form
                className="tree__new"
                onSubmit={(event) => {
                    event.preventDefault();
                    // An empty name is allowed on purpose: the api sends no title at all and
                    // the row renders as `Untitled N`, which is what a blank idea is called.
                    void createTitle(fresh);
                    setFresh('');
                }}
            >
                <input
                    className="tree__input"
                    value={fresh}
                    placeholder="New title"
                    aria-label="New title name"
                    onChange={(event) => setFresh(event.target.value)}
                />
                <button className="button button--primary" type="submit">
                    New Title
                </button>
            </form>

            {titles.phase === 'error' && titles.rows.length === 0 ? <p className="notice notice--error">Titles could not be read: {titles.error}</p> : null}
            {titles.rows.length === 0 && titles.phase !== 'error' ? <p className="notice">{titles.phase === 'loading' ? 'Reading Titles…' : 'No Titles yet. Start one.'}</p> : null}

            <ul className="rows tree__titles">
                {titles.rows.map((row) => {
                    const isActive = row.id === activeId;
                    const isCollapsed = collapsed[row.id] === true;

                    return (
                        <li key={row.id} className="row tree__title" data-active={isActive ? 'yes' : 'no'}>
                            <div className="row__main">
                                <button
                                    className="tree__twisty"
                                    type="button"
                                    aria-label={isCollapsed ? `Expand ${row.label}` : `Collapse ${row.label}`}
                                    aria-expanded={!isCollapsed}
                                    disabled={!isActive}
                                    onClick={() => setCollapsed((previous) => ({ ...previous, [row.id]: !isCollapsed }))}
                                >
                                    {isCollapsed ? '▸' : '▾'}
                                </button>
                                {draft?.id === row.id ? (
                                    <form
                                        className="tree__rename"
                                        onSubmit={(event) => {
                                            event.preventDefault();
                                            void renameTitle({ id: row.id, name: draft.name });
                                            setDraft(null);
                                        }}
                                    >
                                        <input
                                            className="tree__input"
                                            autoFocus
                                            value={draft.name}
                                            aria-label="Rename title"
                                            onChange={(event) => setDraft({ id: row.id, name: event.target.value })}
                                        />
                                        <button className="button" type="submit">
                                            Save
                                        </button>
                                    </form>
                                ) : (
                                    <button
                                        className="tree__name"
                                        type="button"
                                        aria-current={isActive ? 'true' : undefined}
                                        // Picking the Title already open expands it instead of
                                        // re-activating it (which would re-dial the socket).
                                        onClick={() => (isActive ? setCollapsed((previous) => ({ ...previous, [row.id]: false })) : void selectTitle(row.id))}
                                    >
                                        <span className="tree__label">{row.label}</span>
                                        <span className="badge" data-status={row.status}>
                                            {row.status}
                                        </span>
                                        <span className="hint">{row.turnCount} turns</span>
                                    </button>
                                )}
                                <button className="button" type="button" onClick={() => setDraft({ id: row.id, name: row.title })} aria-label={`Rename ${row.label}`}>
                                    rename
                                </button>
                            </div>

                            {isActive && !isCollapsed ? (
                                <ul className="tree__groups">
                                    {GROUPS.map((kind) => {
                                        const expanded = openGroups[kind] === true;
                                        const size = groupSize(store.data, kind);

                                        return (
                                            <li key={kind} className="tree__group" data-kind={kind}>
                                                <button
                                                    className="tree__group-name"
                                                    type="button"
                                                    aria-expanded={expanded}
                                                    onClick={() => {
                                                        toggleGroup(kind);
                                                        // A group header is also a selection: it
                                                        // opens the document's own overview.
                                                        open(kind, '');
                                                    }}
                                                >
                                                    <span>{CONTENT_LABELS[kind]}</span>
                                                    <span className="count">{isBound(store.data, kind) ? size : '—'}</span>
                                                </button>

                                                {expanded ? (
                                                    <ul className="tree__items">
                                                        {kind === 'chapters'
                                                            ? store.data.chapters.map((chapter, index) => (
                                                                  <li key={chapter.id} className="tree__item" data-selected={selection.kind === 'chapters' && selection.id === chapter.id ? 'yes' : 'no'}>
                                                                      <button className="tree__item-name" type="button" onClick={() => open('chapters', chapter.id)}>
                                                                          <span className="row__index">{index + 1}</span>
                                                                          <span className="row__title">{chapter.title || '(untitled)'}</span>
                                                                      </button>
                                                                      <span className="tags">
                                                                          {CHAPTER_STATUSES.map((status) => (
                                                                              <button
                                                                                  key={status}
                                                                                  className="tag"
                                                                                  type="button"
                                                                                  aria-pressed={chapter.status === status ? 'true' : 'false'}
                                                                                  // The write carries the rev this row was read at,
                                                                                  // which is what makes it a guarded change. Dropping the
                                                                                  // promise is safe because the command resolves on every
                                                                                  // outcome: a refusal is published to the write cell this row
                                                                                  // reads below, never thrown at this caller.
                                                                                  onClick={() => void setStatus({ id: chapter.id, rev: chapter.rev, status })}
                                                                              >
                                                                                  {status}
                                                                              </button>
                                                                          ))}
                                                                      </span>
                                                                      {/* The engine's own sentence about a chip it refused to move,
                                                                          under the chapter it named — the only place a refused
                                                                          write of this kind can reach the operator at all. */}
                                                                      {write.chapterId === chapter.id && write.error.length > 0 ? (
                                                                          <p className="notice notice--error tree__write">{write.error}</p>
                                                                      ) : null}
                                                                  </li>
                                                              ))
                                                            : null}

                                                        {kind === 'profiles'
                                                            ? store.data.profiles.map((profile) => (
                                                                  <li key={profile.id} className="tree__item" data-selected={selection.kind === 'profiles' ? 'yes' : 'no'}>
                                                                      <button className="tree__item-name" type="button" onClick={() => open('profiles', '')}>
                                                                          {/* `profileLabel` is the api's rule: the name plus `(F)`/`(M)` from a trait. */}
                                                                          <span className="row__title">{profileLabel(profile)}</span>
                                                                      </button>
                                                                  </li>
                                                              ))
                                                            : null}

                                                        {(kind === 'outlines' || kind === 'storyline') &&
                                                            (kind === 'outlines' ? store.data.outlines : store.data.storyline).map((section, index) => (
                                                                <li key={section.id} className="tree__item" data-selected={selection.kind === kind ? 'yes' : 'no'}>
                                                                    <button className="tree__item-name" type="button" onClick={() => open(kind, '')}>
                                                                        <span className="row__index">{section.order === null ? index + 1 : section.order}</span>
                                                                        <span className="row__title">{section.heading || '(untitled)'}</span>
                                                                        {/* `hasContent` is the difference between an empty section and a body this read cannot carry. */}
                                                                        {section.hasContent ? null : <span className="hint">no body</span>}
                                                                    </button>
                                                                </li>
                                                            ))}

                                                        {expanded && size === 0 ? <li className="hint tree__empty">{isBound(store.data, kind) ? 'Nothing here yet.' : 'Not created for this Title.'}</li> : null}
                                                    </ul>
                                                ) : null}
                                            </li>
                                        );
                                    })}
                                </ul>
                            ) : null}
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
