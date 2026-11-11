// The pinned client surface (the half of the wave T7 builds the server against). These
// assert the WIRE, not the render: the paths, the verbs, the error text, and the stream
// contract — the four things that silently break the dashboard when the two halves meet.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_ROOT, ApiError, api } from './api';
import { storyRow } from './testing/shell-fakes';

/** The fetch call api.ts actually made: [url, init]. */
function lastFetch(): { url: string; method: string; body?: string } {
    const calls = (fetch as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls;
    const [url, init] = calls[calls.length - 1] as [string, RequestInit];
    return { url, method: init.method ?? 'GET', body: typeof init.body === 'string' ? init.body : undefined };
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('api — the pinned REST surface', () => {
    it('reads a Story row list from /v1/storyline/stories and returns it untouched', async () => {
        const rows = [storyRow('story_1'), storyRow('story_2')];
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => rows }))
        );

        const result = await api.listStories();
        expect(result).toEqual(rows);
        expect(lastFetch()).toEqual({ url: `${API_ROOT}/stories`, method: 'GET' });
    });

    it("refuses a locked phase with the server's own sentence, not a generic failure (L-7a / L-13)", async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: false,
                status: 409,
                statusText: 'Conflict',
                json: async () => ({ error: 'the Ideas tray still holds 3 proposed Ideas · lock empties it (D-36)' })
            }))
        );

        const failure = await api.lockPhase('story_1').catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(ApiError);
        expect((failure as ApiError).message).toBe(
            'the Ideas tray still holds 3 proposed Ideas · lock empties it (D-36)'
        );
        expect((failure as ApiError).status).toBe(409);
        expect(lastFetch()).toEqual({ url: `${API_ROOT}/stories/story_1/lock`, method: 'POST' });
    });

    it("sends the Author's prose edit to the section route with its content (D-7 / T-2)", async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => storyRow('story_1') }))
        );

        await api.editSection('story_1', 'chapter_4', 'section_2', 'the sea remembers her name');
        expect(lastFetch()).toEqual({
            url: `${API_ROOT}/stories/story_1/chapters/chapter_4/sections/section_2`,
            method: 'POST',
            body: '{"content":"the sea remembers her name"}'
        });
    });
});

describe('api — the event stream', () => {
    it('listens to story/runs/queue on /stream and hands the story id to the refetch handler', () => {
        const seen: Array<[string, string | undefined]> = [];
        const handlers = new Map<string, (event: { data: string }) => void>();
        let closed = false;
        let streamUrl = '';

        class FakeSource {
            constructor(url: string) {
                streamUrl = url;
            }
            addEventListener(kind: string, listener: (event: { data: string }) => void) {
                handlers.set(kind, listener);
            }
            close() {
                closed = true;
            }
            onerror: (() => void) | null = null;
        }
        vi.stubGlobal('EventSource', FakeSource);

        const unsubscribe = api.subscribeEvents((kind, storyId) => seen.push([kind, storyId]));

        expect(streamUrl).toBe(`${API_ROOT}/stream`);
        expect([...handlers.keys()].sort()).toEqual(['queue', 'runs', 'story']);

        handlers.get('story')?.({ data: 'story_7' });
        // `runs` and `queue` aggregate across Stories, so the server may omit the id.
        handlers.get('queue')?.({ data: '' });

        expect(seen).toEqual([
            ['story', 'story_7'],
            ['queue', undefined]
        ]);

        unsubscribe();
        expect(closed).toBe(true);
    });

    it('degrades to a 5s poll when EventSource cannot be opened at all (U-2 stays honest)', () => {
        vi.useFakeTimers();
        vi.stubGlobal('EventSource', undefined);

        const seen: string[] = [];
        const unsubscribe = api.subscribeEvents((kind) => seen.push(kind));

        vi.advanceTimersByTime(5000);
        // One poll announces all three topics — the same refetch an event would have caused.
        expect(seen).toEqual(['story', 'runs', 'queue']);

        unsubscribe();
        vi.advanceTimersByTime(20000);
        expect(seen).toHaveLength(3);
    });
});
