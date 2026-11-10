// The content plugin: which document the workstation is showing, one chapter body,
// and the one edit the operator may make from here.
//
// WHAT IS A "DOCUMENT" HERE: a Title owns four ordered collections, and the center
// pane shows exactly one of them at a time — `outlines`, `chapters`, `profiles`,
// `storyline`. The tree is the navigator and the fold that turns a snapshot into a
// document lives beside it (content-view.ts); THIS plugin owns the selection, so the
// tree and the pane can never disagree about what is open.
//
// WHY THE BODY NEEDS ITS OWN READ: `content` is a `getOnly` field of the built-in
// `chapters` collection (harness src/core/chapter.ts:49), so a list or snapshot read
// NEVER carries a chapter body — "no body" and "this read does not show bodies" are
// different facts (that is what `SectionRow.hasContent` states for the two section
// stores, which are defined WITHOUT `getOnly` precisely so the story text rides the
// snapshot — see src/api/storyline.ts). One chapter, one `chapters` tool `get`.
//
// THE ONE WRITE: a chapter's status. The record store has no REST mutation route —
// agents edit it with tools — so the pane edits through the same `chapters` tool an
// agent uses, with the CAS token the engine demands (`expects: [{id, rev}]`,
// harness src/core/records.ts:1770). Everything else on screen is what the agents
// wrote, and the UI says so rather than offering a form for it.
//
// A REFUSED WRITE IS A FACT, NOT AN EXCEPTION. A stale token answers as an HTTP 200 whose
// body is `{ ok: false, error }` (harness src/shared/harness-api.ts:822-845,
// `ToolCallFailure`), which `unwrapToolResult` (src/api/storyline.ts:618) turns into a
// REJECTION. This command catches it, puts the engine's own sentence in
// `storyline.chapters.write` for the tree to render beside the chip that was clicked, and
// RESOLVES — the click that started the write is a `void` call in StoryTree.tsx, so a
// rejection escaping here has no caller to reach and would surface only as an unhandled
// rejection while the chip sat visibly unchanged.
import type { DashboardPlugin, DashboardPluginAPI } from '@underload/dashboard';
import {
    API_SERVICE,
    CENTER_PANEL,
    CHAPTER_STATUS_COMMAND,
    CHAPTER_WRITE_STATE,
    CONTENT_DETAIL_STATE,
    CONTENT_REFRESH_COMMAND,
    CONTENT_SELECT_COMMAND,
    CONTENT_SELECT_STATE,
    DEFAULT_CONTENT,
    EMPTY_CHAPTER_DETAIL,
    EMPTY_CHAPTER_WRITE,
    PANEL_ORDERS,
    PANEL_SLOT,
    PLUGIN_IDS,
    RECORDS_REFRESH_COMMAND,
    TREE_PANEL,
    TITLES_ACTIVE_EVENT,
    TITLES_SERVICE,
    type ChapterDetail,
    type ChapterDetailState,
    type ChapterRow,
    type ChapterStatus,
    type ChapterWriteResult,
    type ContentSelection,
    type PanelValue,
    type StorylineApiService,
    type TitlesActiveEvent,
    type TitlesService
} from '../contract';
import { ContentPane } from '../components/ContentPane';
import { StoryTree } from '../components/StoryTree';

/** The one edit this workstation makes to the story: a chapter's status. */
export type ChapterStatusInput = { id: string; rev: number; status: ChapterStatus };

export function createContentPlugin(): DashboardPlugin {
    return {
        id: PLUGIN_IDS.content,
        requires: [PLUGIN_IDS.api, PLUGIN_IDS.titles, PLUGIN_IDS.records],

        setup(api: DashboardPluginAPI): () => void {
            const server = api.getService<StorylineApiService>(API_SERVICE);
            const titles = api.getService<TitlesService>(TITLES_SERVICE);

            const selection = api.state<ContentSelection>(CONTENT_SELECT_STATE, DEFAULT_CONTENT);
            const detail = api.state<ChapterDetailState>(CONTENT_DETAIL_STATE, EMPTY_CHAPTER_DETAIL);

            /**
             * The last status write's outcome, per chapter. The tree reads it to put the engine's
             * refusal next to the chip that was clicked, because the click that made the write has
             * no caller to receive a failure (see `CHAPTER_STATUS_COMMAND` below).
             */
            const write = api.state<ChapterWriteResult>(CHAPTER_WRITE_STATE, EMPTY_CHAPTER_WRITE);

            /** Bumped by every new read AND every Title switch: the stale-reply guard. */
            let attempt = 0;
            let disposed = false;

            /** Reads one chapter's body; a reply superseded by a later read is dropped. */
            const openChapter = (id: string): Promise<ChapterDetail | null> => {
                const sessionId = titles.activeId();
                const ticket = (attempt += 1);

                if (sessionId.length === 0 || id.length === 0) {
                    detail.set(EMPTY_CHAPTER_DETAIL);

                    return Promise.resolve(null);
                }

                detail.set((previous) => ({ ...previous, phase: 'loading', error: '' }));

                return server.readChapter(sessionId, id).then(
                    (chapter) => {
                        if (disposed || ticket !== attempt) return null;

                        if (chapter === null) {
                            detail.set({ chapter: null, phase: 'error', error: 'The chapters tool answered with no chapter.' });

                            return null;
                        }

                        detail.set({ chapter, phase: 'ready', error: '' });

                        return chapter;
                    },
                    (error: unknown) => {
                        if (disposed || ticket !== attempt) return null;
                        const message = error instanceof Error ? error.message : String(error);

                        detail.set({ chapter: null, phase: 'error', error: `Chapter body could not be read: ${message}` });

                        return null;
                    },
                );
            };

            api.command<ContentSelection, ContentSelection>(CONTENT_SELECT_COMMAND, (next) => {
                const kind = next?.kind ?? DEFAULT_CONTENT.kind;
                // The id must stay paired with its kind: a chapter id carried over to
                // `profiles` would ask the wrong tool for a body.
                const settled: ContentSelection = { kind, id: kind === 'chapters' ? next?.id ?? '' : '' };

                selection.set(settled);

                // Re-selecting the open chapter RE-reads it — the agents may have edited it.
                if (settled.id.length > 0) void openChapter(settled.id);
                else detail.set(EMPTY_CHAPTER_DETAIL);

                return settled;
            });

            api.command<void, Promise<ChapterDetail | null>>(CONTENT_REFRESH_COMMAND, () => {
                const current = selection.get();

                if (current.kind === 'chapters' && current.id.length > 0) return openChapter(current.id);

                return Promise.resolve(null);
            });

            api.command<ChapterStatusInput, Promise<ChapterDetailState>>(CHAPTER_STATUS_COMMAND, async ({ id, rev, status }) => {
                const sessionId = titles.activeId();

                if (sessionId.length === 0 || id.length === 0) return detail.get();

                // THE WRITE, AND EVERY WAY IT CAN COME BACK NOT APPLIED. It is CAS-guarded by the
                // rev this pane is showing, so an agent that edited the chapter first turns this
                // into a CONFLICT, not a silent overwrite — and the engine answers that conflict as
                // an HTTP 200 whose body is `{ ok: false, error }`, which the api layer turns into a
                // REJECTION (src/api/storyline.ts `unwrapToolResult`). Awaiting it here without
                // catching was the T13 defect: the click that started this (`void setStatus(...)` in
                // StoryTree.tsx) has no caller left to handle a rejection, so the operator saw
                // nothing happen at all and the page logged an unhandled rejection. Both refusals —
                // the envelope and the throw — land in the SAME cell, and the command resolves.
                let row: ChapterRow | null;

                try {
                    row = await server.setChapterStatus(sessionId, { id, rev }, status);
                } catch (error) {
                    // `error.message` is the server's own sentence, prefixed by the tool label:
                    // the current rev, who edited it, the fields that moved, the retry token, and
                    // the current record (harness src/core/records.ts `staleRecordError`) — the
                    // whole explanation of a chip that refused to move, quoted rather than guessed.
                    const message = error instanceof Error ? error.message : String(error);

                    write.set({ chapterId: id, error: message });
                    detail.set((previous) => ({ ...previous, phase: 'error', error: message }));

                    return detail.get();
                }

                if (row === null) {
                    const message = 'The chapters tool refused the update — it may have changed underneath.';

                    write.set({ chapterId: id, error: message });
                    detail.set((previous) => ({
                        ...previous,
                        phase: 'error',
                        error: message
                    }));

                    return detail.get();
                }

                // A write that applied clears the chip's complaint: the next click starts clean.
                write.set({ chapterId: id, error: '' });

                // The open body, if it is the same chapter, carries the new rev, so a second
                // click is guarded by the token the engine just handed back.
                detail.set((previous) =>
                    previous.chapter === null || previous.chapter.id !== id
                        ? previous
                        : { ...previous, phase: 'ready', error: '', chapter: { ...previous.chapter, status, rev: row.rev } },
                );

                // The tree and the chapter list read the snapshot, so a successful write re-reads it.
                await api.execute<void, Promise<void>>(RECORDS_REFRESH_COMMAND);

                return detail.get();
            });

            // A new Title is a new story: the pane goes back to its opening document and
            // drops the chapter body that belonged to the Title now back in the tree. The
            // refused-write notice goes with it — it names a chapter of the Title being left.
            api.on<TitlesActiveEvent>(TITLES_ACTIVE_EVENT, () => {
                attempt += 1;
                selection.set(DEFAULT_CONTENT);
                detail.set(EMPTY_CHAPTER_DETAIL);
                write.set(EMPTY_CHAPTER_WRITE);
            });

            // The tree and the document are the two halves of "what am I looking at", so one
            // plugin contributes both and they can never be placed apart.
            api.slot<PanelValue>(PANEL_SLOT, {
                id: TREE_PANEL,
                order: PANEL_ORDERS.tree,
                value: { title: 'Titles', region: 'tree', component: StoryTree }
            });

            api.slot<PanelValue>(PANEL_SLOT, {
                id: CENTER_PANEL,
                order: PANEL_ORDERS.center,
                value: { title: 'Story', region: 'center', hint: 'one document at a time', component: ContentPane }
            });

            return () => {
                disposed = true;
                attempt += 1;
            };
        }
    };
}
