// The Titles plugin: the registry, the pick rules, and the one socket per Title.
//
// Pinned through the real composition (see testing/doubles.ts): the plugin's whole
// purpose is wiring — the list is what the tree renders, the Title it picks is what
// every other plugin addresses, and the socket it dials is the only one the dashboard
// has. A unit test with hand-fed services would pass with the wiring wrong.
import { describe, expect, it } from 'vitest';
import type { TitleRow } from '../../api';
import {
    TITLES_ACTIVE_EVENT,
    TITLES_ACTIVE_STATE,
    TITLES_CREATE_COMMAND,
    TITLES_FAILED_EVENT,
    TITLES_REFRESH_COMMAND,
    TITLES_RENAME_COMMAND,
    TITLES_SELECT_COMMAND,
    TITLES_SERVICE,
    TITLES_STATE,
    type TitlesService,
    type TitlesState
} from '../contract';
import { buildStoryline, TITLE_NEW, TITLE_OLD } from '../testing/doubles';

/**
 * Only the routes the titles plugin itself takes. Every activation also reads the roster
 * through `listThreads:<id>`, and each roster it gets is then read for its newest sentence
 * through `readThreadMessages:<thread>` — both are contracts pinned in plugins/agents.test.ts,
 * and counting another plugin's calls here would couple this file to the agents panel.
 */
const titleRoutes = (calls: readonly string[]) =>
    calls.filter((call) => !call.startsWith('listThreads:') && !call.startsWith('readThreadMessages:'));

describe('titles plugin', () => {
    it('loads the registry at boot, opens the newest Title, and dials exactly one stream', async () => {
        const { instance, calls, captured, handle, flush } = buildStoryline();

        await flush();

        // No action was needed: the tree is the front door (plugins/titles.ts header).
        expect(titleRoutes(calls)).toEqual(['listTitles', 'readRecords:ses-new', 'ensureCollections:ses-new', 'readRecords:ses-new']);
        expect(instance.state<TitlesState>(TITLES_STATE).get()).toEqual({ phase: 'ready', error: '', rows: [TITLE_NEW, TITLE_OLD] });
        expect(instance.state<string>(TITLES_ACTIVE_STATE).get()).toBe('ses-new');
        // One observation, pointed at the active Title — never one per Title.
        expect(handle.connectCalls).toBe(1);
        expect(captured.sessionIds).toEqual(['ses-new']);
        expect(instance.service<TitlesService>(TITLES_SERVICE).activeId()).toBe('ses-new');

        instance.dispose();
    });

    it('restores the persisted Title while the server still lists it', async () => {
        // A real localStorage entry: the storage key is what makes a reload land on the
        // same story, and a stored id the list no longer returns must NOT win.
        globalThis.localStorage?.setItem('storyline:active-title', 'ses-old');

        const { instance, captured, flush } = buildStoryline({ storageKey: 'storyline:active-title' });

        await flush();

        expect(instance.state<string>(TITLES_ACTIVE_STATE).get()).toBe('ses-old');
        expect(captured.sessionIds).toEqual(['ses-old']);
        // Writing the active id back is the persistence half of the same rule.
        expect(globalThis.localStorage?.getItem('storyline:active-title')).toBe('ses-old');

        globalThis.localStorage?.removeItem('storyline:active-title');
        instance.dispose();
    });

    it('ignores a persisted Title the server no longer lists', async () => {
        globalThis.localStorage?.setItem('storyline:active-title', 'ses-gone');

        const { instance, captured, flush } = buildStoryline({ storageKey: 'storyline:active-title' });

        await flush();

        expect(instance.state<string>(TITLES_ACTIVE_STATE).get()).toBe('ses-new');
        expect(captured.sessionIds).toEqual(['ses-new']);

        globalThis.localStorage?.removeItem('storyline:active-title');
        instance.dispose();
    });

    it('opens a fresh Title when the library is empty, and never creates one over a failed list', async () => {
        const empty = buildStoryline({ api: { listTitles: async () => [] } });

        await empty.flush();

        expect(empty.instance.state<TitlesState>(TITLES_STATE).get().rows).toEqual([
            { id: 'ses-fresh', title: '', label: 'Untitled 1', createdAt: 3_000, updatedAt: 3_000, status: 'idle', turnCount: 0, threadCount: 0 }
        ]);
        expect(titleRoutes(empty.calls)).toEqual(['listTitles', 'createTitle:', 'readRecords:ses-fresh', 'ensureCollections:ses-fresh', 'readRecords:ses-fresh']);
        expect(empty.instance.state<string>(TITLES_ACTIVE_STATE).get()).toBe('ses-fresh');

        empty.instance.dispose();

        // A server that is down is not an empty library: creating here would paper over
        // the failure with a stack of blank Titles.
        const failed = buildStoryline({ api: { listTitles: async () => Promise.reject(new Error('gateway down')) } });

        await failed.flush();

        expect(failed.instance.state<TitlesState>(TITLES_STATE).get()).toEqual({ phase: 'error', error: 'gateway down', rows: [] });
        expect(failed.calls).toEqual(['listTitles']);
        expect(failed.instance.state<string>(TITLES_ACTIVE_STATE).get()).toBe('');

        failed.instance.dispose();
    });

    it('re-dials exactly one stream when the operator switches Title', async () => {
        const { instance, calls, captured, handle, flush } = buildStoryline();

        await flush();

        const events: string[] = [];

        instance.on<{ sessionId: string; label: string }>(TITLES_ACTIVE_EVENT, ({ sessionId, label }) => events.push(`${sessionId}:${label}`));

        expect(await instance.execute<string, Promise<string>>(TITLES_SELECT_COMMAND, 'ses-old')).toBe('ses-old');
        await flush();

        // The old observation is closed by name, and the new one replaces it.
        expect(handle.closeReasons).toEqual(['title change']);
        expect(handle.connectCalls).toBe(2);
        expect(captured.sessionIds).toEqual(['ses-new', 'ses-old']);
        expect(events).toEqual(['ses-old:Untitled 2']);
        // Every read follows the new Title; the previous one's rows are gone with its stream.
        expect(titleRoutes(calls)).toEqual(['listTitles', 'readRecords:ses-new', 'ensureCollections:ses-new', 'readRecords:ses-new', 'readRecords:ses-old', 'ensureCollections:ses-old', 'readRecords:ses-old']);

        instance.dispose();
    });

    it('treats re-selecting the open Title as a no-op instead of a second observation', async () => {
        const { instance, handle, flush } = buildStoryline();

        await flush();

        expect(await instance.execute<string, Promise<string>>(TITLES_SELECT_COMMAND, 'ses-new')).toBe('ses-new');
        await flush();

        expect(handle.connectCalls).toBe(1);
        expect(handle.closeReasons).toEqual([]);

        instance.dispose();
    });

    it('reports a Title the tree never listed instead of dialling a socket at it', async () => {
        const { instance, handle, flush } = buildStoryline();

        await flush();

        expect(await instance.execute<string, Promise<string>>(TITLES_SELECT_COMMAND, 'ses-nope')).toBe('ses-new');
        expect(instance.state<TitlesState>(TITLES_STATE).get().error).toBe('No Title ses-nope.');
        expect(handle.connectCalls).toBe(1);

        instance.dispose();
    });

    it('starts a new Title, puts it at the top of the tree, and works on it', async () => {
        const { instance, handle, captured, flush } = buildStoryline();

        await flush();

        const created: TitleRow = await instance.execute<string, Promise<TitleRow>>(TITLES_CREATE_COMMAND, 'Salt and lamps');
        await flush();

        expect(created.label).toBe('Salt and lamps');
        expect(instance.state<TitlesState>(TITLES_STATE).get().rows.map((row) => row.id)).toEqual(['ses-fresh', 'ses-new', 'ses-old']);
        expect(instance.state<string>(TITLES_ACTIVE_STATE).get()).toBe('ses-fresh');
        expect(captured.sessionIds).toEqual(['ses-new', 'ses-fresh']);
        expect(handle.connectCalls).toBe(2);

        instance.dispose();
    });

    it('renames a Title in place and re-announces the open one', async () => {
        const { instance, flush } = buildStoryline();

        await flush();

        const labels: string[] = [];

        instance.on<{ sessionId: string; label: string }>(TITLES_ACTIVE_EVENT, ({ label }) => labels.push(label));

        const renamed = await instance.execute<{ id: string; name: string }, Promise<TitleRow | null>>(TITLES_RENAME_COMMAND, {
            id: 'ses-new',
            name: 'Fog, revised'
        });

        expect(renamed?.label).toBe('Fog, revised');
        expect(instance.state<TitlesState>(TITLES_STATE).get().rows.map((row) => row.label)).toEqual(['Fog, revised', 'Untitled 2']);
        // The strip shows the active label, so a rename of the open Title is an event.
        expect(labels).toEqual(['Fog, revised']);

        instance.dispose();
    });

    it('keeps the rows it already had when a refresh fails, and says so', async () => {
        let second = false;
        const failures: string[] = [];

        const { instance, flush } = buildStoryline({
            api: {
                listTitles: async () => {
                    if (second) return Promise.reject(new Error('socket hang up'));
                    second = true;

                    return [TITLE_NEW, TITLE_OLD];
                }
            }
        });

        await flush();

        instance.on<{ message: string }>(TITLES_FAILED_EVENT, ({ message }) => failures.push(message));

        expect(await instance.execute<undefined, Promise<readonly TitleRow[]>>(TITLES_REFRESH_COMMAND)).toEqual([TITLE_NEW, TITLE_OLD]);

        expect(instance.state<TitlesState>(TITLES_STATE).get()).toEqual({ phase: 'error', error: 'socket hang up', rows: [TITLE_NEW, TITLE_OLD] });
        expect(failures).toEqual(['socket hang up']);

        instance.dispose();
    });

    it('announces a collection the store would not create, and re-reads the store when one lands', async () => {
        const failures: string[] = [];
        const { instance, flush } = buildStoryline({
            api: {
                ensureCollections: async (sessionId) => ({
                    sessionId,
                    results: [
                        { name: 'outlines', state: 'failed', error: 'this session binds no records tool' },
                        { name: 'storyline', state: 'exists', error: '' }
                    ]
                })
            }
        });

        instance.on<{ message: string }>(TITLES_FAILED_EVENT, ({ message }) => failures.push(message));

        await flush();

        // The Title is still open and still usable; the sentence names what is missing.
        expect(failures).toEqual(['outlines: this session binds no records tool']);
        expect(instance.state<string>(TITLES_ACTIVE_STATE).get()).toBe('ses-new');

        instance.dispose();
    });
});
