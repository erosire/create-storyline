// The content plugin: the center pane's selection, the chapter body only the tool can
// read, and the workstation's one CAS-guarded write.
//
// Pinned through the composition: the plugin's contract is the path from a click in the
// tree to the shared snapshot refresh, including the two guards that keep a slow reply
// from painting over a newer selection.
import { describe, expect, it } from 'vitest';
import type { ChapterDetail } from '../../api';
import {
    CHAPTER_STATUS_COMMAND,
    CHAPTER_WRITE_STATE,
    CONTENT_DETAIL_STATE,
    CONTENT_SELECT_COMMAND,
    CONTENT_SELECT_STATE,
    DEFAULT_CONTENT,
    EMPTY_CHAPTER_DETAIL,
    EMPTY_CHAPTER_WRITE,
    RECORDS_STATE,
    TITLES_SELECT_COMMAND,
    type ChapterDetailState,
    type ChapterWriteResult,
    type ContentSelection
} from '../contract';
import { buildStoryline, CHAPTER_BODY, CHAPTER_ROW } from '../testing/doubles';

/** The body of a second chapter, so a superseded read is distinguishable from the winner. */
const OTHER_BODY: ChapterDetail = { ...CHAPTER_BODY, id: 'ch-2', rev: 9, title: 'The second crossing', content: 'The lamps went out.' };

describe('content plugin', () => {
    it('opens on the first document with no body loaded', async () => {
        const { instance, flush } = buildStoryline();

        await flush();

        expect(instance.state<ContentSelection>(CONTENT_SELECT_STATE).get()).toEqual(DEFAULT_CONTENT);
        expect(instance.state<ChapterDetailState>(CONTENT_DETAIL_STATE).get()).toEqual(EMPTY_CHAPTER_DETAIL);

        instance.dispose();
    });

    it('reads a chapter body through the chapters tool when the tree selects one', async () => {
        const { instance, calls, flush } = buildStoryline();

        await flush();

        expect(instance.execute<ContentSelection, ContentSelection>(CONTENT_SELECT_COMMAND, { kind: 'chapters', id: 'ch-1' })).toEqual({
            kind: 'chapters',
            id: 'ch-1'
        });

        await flush();

        expect(calls).toContain('readChapter:ch-1');
        expect(instance.state<ChapterDetailState>(CONTENT_DETAIL_STATE).get()).toEqual({ chapter: CHAPTER_BODY, phase: 'ready', error: '' });

        instance.dispose();
    });

    it('drops a chapter id when another document is selected, so no tool is asked the wrong question', async () => {
        const { instance, calls, flush } = buildStoryline();

        await flush();

        instance.execute<ContentSelection, ContentSelection>(CONTENT_SELECT_COMMAND, { kind: 'chapters', id: 'ch-1' });
        await flush();

        instance.execute<ContentSelection, ContentSelection>(CONTENT_SELECT_COMMAND, { kind: 'profiles', id: 'ch-1' });
        await flush();

        expect(instance.state<ContentSelection>(CONTENT_SELECT_STATE).get()).toEqual({ kind: 'profiles', id: '' });
        expect(instance.state<ChapterDetailState>(CONTENT_DETAIL_STATE).get()).toEqual(EMPTY_CHAPTER_DETAIL);
        // One body read in total: `profiles` asked for none.
        expect(calls.filter((call) => call.startsWith('readChapter:'))).toEqual(['readChapter:ch-1']);

        instance.dispose();
    });

    it('keeps the body of the chapter it selected last when two reads race', async () => {
        const releases: Record<string, (value: ChapterDetail | null) => void> = {};

        const { instance, flush } = buildStoryline({
            api: {
                readChapter: (_sessionId, chapterId) =>
                    new Promise<ChapterDetail | null>((resolve) => {
                        releases[chapterId] = resolve;
                    })
            }
        });

        await flush();

        instance.execute<ContentSelection, ContentSelection>(CONTENT_SELECT_COMMAND, { kind: 'chapters', id: 'ch-1' });
        instance.execute<ContentSelection, ContentSelection>(CONTENT_SELECT_COMMAND, { kind: 'chapters', id: 'ch-2' });
        await flush();

        expect(instance.state<ChapterDetailState>(CONTENT_DETAIL_STATE).get().phase).toBe('loading');

        // The superseded reply lands LAST; painting it would show the wrong chapter's text.
        releases['ch-2']?.(OTHER_BODY);
        await flush();
        releases['ch-1']?.(CHAPTER_BODY);
        await flush();

        expect(instance.state<ChapterDetailState>(CONTENT_DETAIL_STATE).get()).toEqual({ chapter: OTHER_BODY, phase: 'ready', error: '' });

        instance.dispose();
    });

    it('writes a chapter status with the CAS token this pane is showing, then re-reads the store', async () => {
        const { instance, calls, flush } = buildStoryline();

        await flush();

        instance.execute<ContentSelection, ContentSelection>(CONTENT_SELECT_COMMAND, { kind: 'chapters', id: 'ch-1' });
        await flush();

        await instance.execute<{ id: string; rev: number; status: 'complete' }, Promise<ChapterDetailState>>(CHAPTER_STATUS_COMMAND, {
            id: 'ch-1',
            rev: 4,
            status: 'complete'
        });

        // `expects: [{id, rev}]` is what the engine demands for an identified write; the
        // rev here is the one the snapshot this pane is showing carried.
        expect(calls).toContain('setChapterStatus:ch-1:4:complete');
        expect(calls[calls.length - 1]).toBe('readRecords:ses-new');
        // The open body now carries the rev the tool handed back, so a second click is
        // guarded by the NEW token instead of the stale one.
        expect(instance.state<ChapterDetailState>(CONTENT_DETAIL_STATE).get()).toEqual({
            chapter: { ...CHAPTER_BODY, rev: 5, status: 'complete' },
            phase: 'ready',
            error: ''
        });
        expect(instance.state<{ data: { chapters: { status: string }[] } }>(RECORDS_STATE).get().data.chapters[0]?.status).toBe('draft');

        instance.dispose();
    });

    it('shows the tool’s own refusal instead of pretending the write happened', async () => {
        const { instance, flush } = buildStoryline({ api: { setChapterStatus: async () => null } });

        await flush();

        instance.execute<ContentSelection, ContentSelection>(CONTENT_SELECT_COMMAND, { kind: 'chapters', id: 'ch-1' });
        await flush();

        await instance.execute<{ id: string; rev: number; status: 'planned' }, Promise<ChapterDetailState>>(CHAPTER_STATUS_COMMAND, {
            id: 'ch-1',
            rev: 4,
            status: 'planned'
        });

        expect(instance.state<ChapterDetailState>(CONTENT_DETAIL_STATE).get()).toEqual({
            chapter: CHAPTER_BODY,
            phase: 'error',
            error: 'The chapters tool refused the update — it may have changed underneath.'
        });

        // The tree reads the SAME fact through its own cell: the envelope refusal and the
        // rejection below land in one place, beside the chip that was clicked.
        expect(instance.state<ChapterWriteResult>(CHAPTER_WRITE_STATE).get()).toEqual({
            chapterId: 'ch-1',
            error: 'The chapters tool refused the update — it may have changed underneath.'
        });

        instance.dispose();
    });

    it('holds the engine’s own conflict sentence where the refused chip can show it (T13)', async () => {
        // A CAS conflict is not an HTTP error: the engine answers 200 with `{ ok: false, error }`
        // (harness src/shared/harness-api.ts `ToolCallFailure`), and `unwrapToolResult`
        // (src/api/storyline.ts) turns THAT into a rejection carrying the engine's sentence —
        // the current rev, who moved it, the retry token (harness src/core/records.ts
        // `staleRecordError`). The click that started the write is `void setStatus(...)` in
        // StoryTree.tsx, so a rejection escaping the command has no caller at all: the operator
        // saw a chip that would not move and the page logged an unhandled rejection.
        const sentence = 'stale-record: chapters #ch-1 is at rev 7 (edited by writer); expected rev 4';
        const { instance, calls, flush } = buildStoryline({
            api: { setChapterStatus: async () => Promise.reject(new Error(sentence)) }
        });

        await flush();

        instance.execute<ContentSelection, ContentSelection>(CONTENT_SELECT_COMMAND, { kind: 'chapters', id: 'ch-1' });
        await flush();

        // Boot's own reads, counted rather than assumed, so the assertion below is about the
        // refusal and not about how many reads the composition happens to need to open.
        const readsBeforeWrite = calls.filter((call) => call.startsWith('readRecords:')).length;

        // RESOLVES, with the detail state as its value: nothing here throws at the caller.
        await expect(
            instance.execute<{ id: string; rev: number; status: 'complete' }, Promise<ChapterDetailState>>(CHAPTER_STATUS_COMMAND, {
                id: 'ch-1',
                rev: 4,
                status: 'complete'
            })
        ).resolves.toEqual({ chapter: CHAPTER_BODY, phase: 'error', error: sentence });

        // The write is not silently retried, and a refused write does NOT re-read the store: the
        // rows on screen are the rows the operator needs in order to see the chip they clicked.
        const writes = () => calls.filter((call) => call.startsWith('setChapterStatus:')).length;
        const reads = () => calls.filter((call) => call.startsWith('readRecords:')).length;

        expect(calls).toContain('setChapterStatus:ch-1:4:complete');
        expect(instance.state<ChapterWriteResult>(CHAPTER_WRITE_STATE).get()).toEqual({ chapterId: 'ch-1', error: sentence });
        expect(writes()).toBe(1);
        expect(reads()).toBe(readsBeforeWrite);

        // A refused write belongs to the Title it was refused on. Leaving that Title drops the
        // sentence with it, because the chapter it names is no longer on screen.
        await instance.execute<string, Promise<string>>(TITLES_SELECT_COMMAND, 'ses-old');
        await flush();

        expect(instance.state<ChapterWriteResult>(CHAPTER_WRITE_STATE).get()).toEqual(EMPTY_CHAPTER_WRITE);

        instance.dispose();
    });

    it('clears the refused write when the next click applies', async () => {
        // One double that refuses the FIRST write and takes the second: the rev the operator is
        // shown is the rev the read gave, so the retry is the same gesture the tree offers.
        let attempts = 0;
        const { instance, flush } = buildStoryline({
            api: {
                setChapterStatus: async () => {
                    attempts += 1;

                    if (attempts === 1) return Promise.reject(new Error('stale-record: chapters #ch-1 is at rev 7 (edited by writer)'));

                    return { ...CHAPTER_ROW, status: 'complete', rev: 7 };
                }
            }
        });

        await flush();

        instance.execute<ContentSelection, ContentSelection>(CONTENT_SELECT_COMMAND, { kind: 'chapters', id: 'ch-1' });
        await flush();

        await instance.execute<{ id: string; rev: number; status: 'complete' }, Promise<ChapterDetailState>>(CHAPTER_STATUS_COMMAND, {
            id: 'ch-1',
            rev: 4,
            status: 'complete'
        });

        expect(instance.state<ChapterWriteResult>(CHAPTER_WRITE_STATE).get().error).toBe('stale-record: chapters #ch-1 is at rev 7 (edited by writer)');

        await instance.execute<{ id: string; rev: number; status: 'complete' }, Promise<ChapterDetailState>>(CHAPTER_STATUS_COMMAND, {
            id: 'ch-1',
            rev: 4,
            status: 'complete'
        });

        expect(instance.state<ChapterWriteResult>(CHAPTER_WRITE_STATE).get()).toEqual({ chapterId: 'ch-1', error: '' });
        expect(instance.state<ChapterDetailState>(CONTENT_DETAIL_STATE).get()).toEqual({
            chapter: { ...CHAPTER_BODY, rev: 7, status: 'complete' },
            phase: 'ready',
            error: ''
        });

        instance.dispose();
    });

    it('reports a body the tool answered with nothing', async () => {
        const { instance, flush } = buildStoryline({ api: { readChapter: async () => null } });

        await flush();

        instance.execute<ContentSelection, ContentSelection>(CONTENT_SELECT_COMMAND, { kind: 'chapters', id: 'ch-9' });
        await flush();

        expect(instance.state<ChapterDetailState>(CONTENT_DETAIL_STATE).get()).toEqual({
            chapter: null,
            phase: 'error',
            error: 'The chapters tool answered with no chapter.'
        });

        instance.dispose();
    });

    it('goes back to the opening document when the Title changes', async () => {
        const { instance, flush } = buildStoryline();

        await flush();

        instance.execute<ContentSelection, ContentSelection>(CONTENT_SELECT_COMMAND, { kind: 'chapters', id: 'ch-1' });
        await flush();

        expect(instance.state<ChapterDetailState>(CONTENT_DETAIL_STATE).get().chapter?.id).toBe('ch-1');

        await instance.execute<string, Promise<string>>(TITLES_SELECT_COMMAND, 'ses-old');
        await flush();

        // A chapter body belongs to the Title it was read for; the other Title starts over.
        expect(instance.state<ContentSelection>(CONTENT_SELECT_STATE).get()).toEqual(DEFAULT_CONTENT);
        expect(instance.state<ChapterDetailState>(CONTENT_DETAIL_STATE).get()).toEqual(EMPTY_CHAPTER_DETAIL);

        instance.dispose();
    });

    it('answers a body read for a Title with no active story with nothing, not a request', async () => {
        const { instance, calls, flush } = buildStoryline({ api: { listTitles: async () => Promise.reject(new Error('gateway down')) } });

        await flush();

        instance.execute<ContentSelection, ContentSelection>(CONTENT_SELECT_COMMAND, { kind: 'chapters', id: 'ch-1' });
        await flush();

        expect(calls.filter((call) => call.startsWith('readChapter:'))).toEqual([]);
        expect(instance.state<ChapterDetailState>(CONTENT_DETAIL_STATE).get()).toEqual(EMPTY_CHAPTER_DETAIL);

        instance.dispose();
    });
});
