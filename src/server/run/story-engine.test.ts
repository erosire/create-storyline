// The Story runtime on the harness engine: one harness per Story, one session per phase, one
// thread per Run, and a status projection that spans stories.
import { describe, expect, it, vi } from 'vitest';
import { harness } from '@underload/harness';
import { MockChatClient, calls, makeRecorder, msg } from '../llm/mock';
import type { ChatMessage, ChatResponse } from '../llm/client';
import { Store } from '../store';
import {
    MockToolRuntime,
    seedChapter,
    seedDigest,
    seedGoal,
    seedPlotline,
    seedStory,
    seedTemplate,
    type MockToolHandler
} from './mock';
import { createTally } from './loop';
import { CRITIC_CONCLUDE_NUDGE, CRITIC_REVIEW_TURN_CAP } from './plugins/critic-termination';
import { StoryHarnessManager } from './story-engine';

const storyOf = (store: Store, title: string) => {
    const story = seedStory(store, { title });

    seedGoal(store, story.id);
    seedDigest(store, story.id, `${title} digest`);
    const plotline = seedPlotline(store, story.id);
    seedChapter(store, story.id, { plotline_ref: plotline.id });
    seedTemplate(store, {
        name: `writer-${story.id}`,
        roles: [{ name: 'writer', kind: 'writer', prompt: 'write' }]
    });

    return story;
};

const contextFor = (store: Store, runtime: MockToolRuntime, storyId: string) =>
    runtime.createContext({ storyId, runId: 'run_0', roleName: 'writer', roleKind: 'writer' });

describe('StoryHarnessManager — one harness per Story', () => {
    it('keeps two stories in separate harnesses and reports their threads by phase', async () => {
        const store = Store.empty();
        const first = storyOf(store, 'Hollow Sea');
        const second = storyOf(store, 'Salt Year');

        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        const chat = new MockChatClient(async (): Promise<ChatResponse> => {
            await gate;

            return { message: { content: 'done' } };
        });
        const runtimeA = new MockToolRuntime(store, first.id);
        const runtimeB = new MockToolRuntime(store, second.id);
        const manager = new StoryHarnessManager({ store, runtime: runtimeA, chat, defaultModel: 'mock' });

        const running = manager.run({
            storyId: first.id,
            phase: 'summary',
            label: 'run_a',
            roleName: 'writer',
            roleKind: 'writer',
            model: 'mock',
            system: 'BRIEF A',
            kickoff: 'write',
            context: contextFor(store, runtimeA, first.id),
            runtime: runtimeA,
            tally: createTally()
        });
        const runningB = manager.run({
            storyId: second.id,
            phase: 'chapters',
            label: 'run_b',
            roleName: 'writer',
            roleKind: 'writer',
            model: 'mock',
            system: 'BRIEF B',
            kickoff: 'write',
            context: contextFor(store, runtimeA, second.id),
            runtime: runtimeA,
            tally: createTally()
        });

        // One status row per agent, with BOTH Stories' live threads named under the same Writer.
        const during = manager.statuses();
        const writer = during.find((row) => row.kind === 'writer');

        expect(writer?.status).toBe('running');
        expect(writer?.working).toHaveLength(2);
        expect(writer?.working.map((thread) => thread.story_id).sort()).toEqual([first.id, second.id].sort());
        expect(writer?.working.find((thread) => thread.story_id === first.id)).toMatchObject({
            story_id: first.id,
            story_title: 'Hollow Sea',
            phase: 'summary',
            work_item: 'run_a',
            role_name: 'writer'
        });

        release();
        await Promise.all([running, runningB]);

        expect(manager.statuses().find((row) => row.kind === 'writer')?.status).toBe('idle');
        expect(
            manager
                .forStory(first.id)
                .sessionsForStatus()
                .map((session) => session.phase)
        ).toEqual(['summary']);
        expect(manager.forStory(first.id).sessionsForStatus()[0]?.runs.size).toBe(1);

        // The two Stories kept separate harnesses and separate sessions throughout.
        expect(manager.has(second.id)).toBe(true);
        expect(
            manager
                .forStory(first.id)
                .sessionsForStatus()
                .map((session) => session.phase)
        ).toEqual(['summary']);
        expect(
            manager
                .forStory(second.id)
                .sessionsForStatus()
                .map((session) => session.phase)
        ).toEqual(['chapters']);
        expect(manager.statuses().flatMap((row) => row.working)).toEqual([]);

        // The retained surface keeps every thread with its request and answer, oldest first.
        const threads = manager.threads('writer');

        expect(threads).toHaveLength(2);
        expect(threads.map((thread) => thread.run_id)).toEqual(['run_a', 'run_b']);
        expect(threads.map((thread) => thread.story_title)).toEqual(['Hollow Sea', 'Salt Year']);
        expect(threads[0]).toMatchObject({
            phase: 'summary',
            state: 'torn_down',
            retained: true,
            request: 'BRIEF A\n\n---\n\nwrite',
            answer: 'done'
        });

        manager.dispose();
    });

    it('runs the engine’s context plugins and leaves the background ping off (R2/R3)', () => {
        const store = Store.empty();
        const story = storyOf(store, 'Hollow Sea');
        const runtime = new MockToolRuntime(store, story.id);
        const chat = new MockChatClient(async (): Promise<ChatResponse> => ({ message: { content: 'done' } }));
        const manager = new StoryHarnessManager({ store, runtime, chat, defaultModel: 'mock' });

        // Compaction is the bound on a thread's context growth; the trimmer is its per-turn half.
        // `async-ping` is a parked-session keepalive and must not add provider traffic here.
        // `critic-termination` is Storyline's own policy plugin (C2-AD3), applied after the built-ins.
        expect([...manager.forStory(story.id).pluginNames].sort()).toEqual([
            'context-compaction',
            'context-trimmer',
            'critic-termination'
        ]);

        manager.dispose();
    });

    it('keeps a thread’s brief after its run resolves, so context compaction can continue it (S-2, S-4a)', async () => {
        // The engine's `context-compaction` plugin ends a host turn on its own SUMMARY and then
        // continues the conversation with a nudge as a SECOND run on the SAME thread. The transport
        // resolves a request to its run through the seeded brief, so a brief dropped when
        // `sendThreadInput` resolved made that continuation die with "the writer harness received a
        // request whose brief names no Storyline Run" — the Writer thread the Author saw fail at
        // 297k tokens. This pins the brief for the thread's life instead.
        const store = Store.empty();
        const story = storyOf(store, 'Context Limit');
        const runtime = new MockToolRuntime(store, story.id);
        let turns = 0;
        const chat = new MockChatClient(async () => {
            turns += 1;

            // Turn 1 reaches the compaction trigger; turn 2 is the summary the pass asked for;
            // turn 3 is the continuation, which only runs if the brief is still resolvable.
            if (turns === 1) return { message: msg({ toolCalls: calls([{ name: 'readGoals', args: {} }]) }) };

            return { message: { content: turns === 2 ? 'SUMMARY ANSWER' : 'CONTINUED ANSWER' } };
        });
        const createHarness = ((configuration: Parameters<typeof harness>[0]) =>
            harness({
                ...configuration,
                // A limit above this catalogue's floor and far below the seeded brief's estimate.
                pluginSettings: {
                    get: (plugin: string, key: string) => {
                        if (plugin !== 'context-compaction') return undefined;
                        if (key === 'contextLimit') return 150_000;
                        if (key === 'minTokens') return 10;

                        return undefined;
                    }
                }
            })) as typeof harness;
        const manager = new StoryHarnessManager({ store, runtime, chat, defaultModel: 'mock', createHarness });

        const result = await manager.run({
            storyId: story.id,
            phase: 'summary',
            label: 'run_0',
            roleName: 'writer',
            roleKind: 'writer',
            model: 'mock',
            system: `BRIEF ${'x'.repeat(1_000_000)}`,
            kickoff: 'write',
            context: contextFor(store, runtime, story.id),
            runtime,
            tally: createTally()
        });

        // A host run resolves on the compaction answer (the engine's depth-1 contract).
        expect(result.text).toBe('SUMMARY ANSWER');

        // The continuation nudge is fire-and-forget; its request is the proof the brief survived.
        await vi.waitFor(() => expect(chat.callCount).toBeGreaterThanOrEqual(3), { timeout: 10_000 });

        manager.dispose();
    });

    it('reports a running thread’s live steps and drops them once it closes (U-8)', async () => {
        const store = Store.empty();
        const story = storyOf(store, 'Hollow Sea');
        const runtime = new MockToolRuntime(store, story.id);

        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const chat = new MockChatClient(async (): Promise<ChatResponse> => {
            await gate;

            return { message: { content: 'done' } };
        });
        const manager = new StoryHarnessManager({ store, runtime, chat, defaultModel: 'mock' });
        let beats = 0;

        const running = manager.run({
            storyId: story.id,
            phase: 'summary',
            label: 'run_0',
            roleName: 'writer',
            roleKind: 'writer',
            model: 'mock',
            system: 'BRIEF',
            kickoff: 'write',
            context: contextFor(store, runtime, story.id),
            runtime,
            tally: createTally(),
            heartbeat: () => {
                beats += 1;
            }
        });

        await vi.waitFor(() => expect(chat.callCount).toBeGreaterThan(0));

        const live = manager.threads('writer')[0]!;
        expect(live.state).toBe('running');
        expect(live.activity?.map((step) => step.text)).toContain('waiting on the model (turn 1)');
        // S-4a: the lease is refreshed while the provider request is in flight, not only after
        // a tool call — a slow turn must not read as a dead owner.
        expect(beats).toBeGreaterThan(0);

        release();
        await running;

        const closed = manager.threads('writer')[0]!;
        expect(closed.activity).toBeUndefined();
        expect(closed.answer).toBe('done');

        manager.dispose();
    });

    it('executes the Story catalogue through the engine loop and records the tally', async () => {
        const store = Store.empty();
        const story = storyOf(store, 'Hollow Sea');
        const runtime = new MockToolRuntime(store, story.id);
        let call = 0;
        const chat = new MockChatClient(async () => {
            call += 1;

            return call === 1
                ? {
                      message: msg({
                          toolCalls: calls([
                              {
                                  name: 'editChapter',
                                  args: {
                                      chapter_id: 'chapter_0',
                                      summary: 'the lamp keeps its own log',
                                      expects: [{ id: 'chapter_0', rev: 1 }],
                                      why: 'the chapter pays the ledger entry'
                                  }
                              }
                          ])
                      }),
                      usage: { input: 10, output: 5, cached_input: 0 }
                  }
                : { message: msg({ content: 'reported' }), usage: { input: 3, output: 2, cached_input: 0 } };
        });
        const manager = new StoryHarnessManager({ store, runtime, chat, defaultModel: 'mock' });
        const tally = createTally();

        const result = await manager.run({
            storyId: story.id,
            phase: 'chapters',
            label: 'run_0',
            roleName: 'writer',
            roleKind: 'writer',
            model: 'mock',
            system: 'BRIEF',
            kickoff: 'write',
            context: contextFor(store, runtime, story.id),
            runtime,
            tally
        });

        expect(result.text).toBe('reported');
        expect(result.turns).toBe(2);
        expect(tally.executed).toEqual(['editChapter']);
        expect(tally.tokens).toBe(20);
        expect(store.chapters.get('chapter_0')).toMatchObject({
            rev: 2,
            summary: 'the lamp keeps its own log'
        });

        manager.dispose();
    });

    it('projects the engine’s flat tool call into the OpenAI wire shape a strict provider requires (T-6, S-4)', async () => {
        const store = Store.empty();
        const story = storyOf(store, 'Hollow Sea');
        const runtime = new MockToolRuntime(store, story.id);
        const { client, requests } = makeRecorder((_request, state) =>
            state.callIndex === 0
                ? {
                      message: msg({
                          toolCalls: calls([{ name: 'readGoals', args: {} }])
                      })
                  }
                : { message: msg({ content: 'reported' }) }
        );
        const manager = new StoryHarnessManager({ store, runtime, chat: client, defaultModel: 'mock' });

        await manager.run({
            storyId: story.id,
            phase: 'chapters',
            label: 'run_0',
            roleName: 'reader',
            roleKind: 'reader',
            model: 'mock',
            system: 'BRIEF',
            kickoff: 'check',
            context: contextFor(store, runtime, story.id),
            runtime,
            tally: createTally()
        });

        expect(requests).toHaveLength(2);

        // The provider's OpenAI schema nests name/arguments under `function`; the engine keeps
        // them flat. A second turn with the flat form is a 400 on a strict provider ("Invalid
        // value for `[0].function`: Field required"), which is the Reader's repeating fault.
        const assistant = requests[1]?.messages.find((message) => message.role === 'assistant') as
            | (ChatMessage & { tool_calls?: unknown[] })
            | undefined;

        expect(assistant?.tool_calls).toEqual([
            {
                id: 'call_1~1_0',
                type: 'function',
                function: { name: 'readGoals', arguments: '{}' }
            }
        ]);

        manager.dispose();
    });

    it('answers every employee’s rank, and keeps the newest closed runs on the tile (D-38a, S-3)', async () => {
        const store = Store.empty();
        const story = storyOf(store, 'Hollow Sea');
        const runtime = new MockToolRuntime(store, story.id);
        const chat = new MockChatClient(async () => ({ message: { content: 'done' } }));
        const manager = new StoryHarnessManager({ store, runtime, chat, defaultModel: 'mock' });

        store.runs.create(
            {
                story_id: story.id,
                work_item_ref: 'wi_check_chapters_1',
                role: 'reader',
                state: 'failed',
                started_at: '2026-11-22T10:00:00.000Z',
                ended_at: '2026-11-22T10:00:01.000Z',
                tokens: 0,
                kind: 'work',
                no_op: true,
                end_reason: 'failed — LLM provider fault: Invalid value for `[0].function`: Field required',
                delegated: []
            },
            { run_ref: null, author: true, why: 'seed a failed run for the roster projection' }
        );

        const rows = manager.statuses();

        expect(rows.every((row) => row.rank === 'A')).toBe(true);
        // The five employees, in roster order: §7.3 appends the Researcher to the catalogue.
        expect(rows.map((row) => row.kind)).toEqual(['writer', 'editor', 'critic', 'reader', 'researcher']);
        // V-1: an entry point is engine routing, not a roster role the dashboard draws.
        expect(rows.map((row) => (row as { entry?: boolean }).entry)).toEqual([
            undefined,
            undefined,
            undefined,
            undefined,
            undefined
        ]);

        const reader = rows.find((row) => row.kind === 'reader');

        expect(reader?.recent).toHaveLength(1);
        expect(reader?.recent[0]).toMatchObject({
            run_id: 'run_0',
            story_title: 'Hollow Sea',
            work_item: 'wi_check_chapters_1',
            state: 'failed',
            no_op: true
        });
        expect(reader?.recent[0]?.end_reason).toContain('Invalid value for `[0].function`');

        manager.dispose();
    });

    it('counts a live Run row that has no engine thread — the off-thread Writer tile (R1)', () => {
        const store = Store.empty();
        const story = storyOf(store, 'Hollow Sea');
        const runtime = new MockToolRuntime(store, story.id);
        const chat = new MockChatClient(async () => ({ message: { content: 'done' } }));
        const manager = new StoryHarnessManager({ store, runtime, chat, defaultModel: 'mock' });

        // A `toolMode: 'none'` run is the case the tile used to miss: the row says `working` from
        // the moment the executor dispatches it, while `run/executor.ts:runStructuredTurn` calls
        // `chat.complete` directly and opens NO engine thread — the thread record only lands in
        // `execute`'s `finally`. The Author sees the thread panel RUNNING and the tile idle.
        store.runs.create(
            {
                story_id: story.id,
                work_item_ref: 'wi_draft_chapter_0',
                role: 'writer',
                state: 'working',
                started_at: '2026-11-23T10:00:00.000Z',
                ended_at: null,
                tokens: 0,
                kind: 'work',
                delegated: []
            },
            { run_ref: null, author: true, why: 'seed the live row an off-thread run leaves behind' }
        );

        const rows = manager.statuses();
        const writer = rows.find((row) => row.kind === 'writer');

        expect(writer?.status).toBe('running');
        // Exactly one working entry, on the identity the thread list already uses for a run-row
        // thread (`api/projections.ts:agentThreads`), so a refetch never re-keys the row.
        expect(writer?.working).toEqual([
            {
                story_id: story.id,
                story_title: 'Hollow Sea',
                phase: 'chapters',
                role_name: 'writer',
                work_item: 'wi_draft_chapter_0',
                thread_id: 'run_row:run_0',
                started_at: Date.parse('2026-11-23T10:00:00.000Z')
            }
        ]);
        // It is a LIVE run, so it is not also a closed thread (S-3's list stays the closed ones)…
        expect(writer?.recent).toEqual([]);
        // …and it belongs to one employee: no other tile moves (R3). Catalogue order is the
        // projection's; §7.3's alphabetic sort is `api/routes.ts`'s.
        expect(rows.filter((row) => row.kind !== 'writer').map((row) => [row.kind, row.status, row.working.length])).toEqual(
            [
                ['editor', 'idle', 0],
                ['critic', 'idle', 0],
                ['reader', 'idle', 0],
                ['researcher', 'idle', 0]
            ]
        );

        manager.dispose();
    });

    it('counts every live Run row across Stories oldest first, and keeps a closed row out (R1)', () => {
        const store = Store.empty();
        const first = storyOf(store, 'Hollow Sea');
        const second = storyOf(store, 'Salt Year');
        const runtime = new MockToolRuntime(store, first.id);
        const chat = new MockChatClient(async () => ({ message: { content: 'done' } }));
        const manager = new StoryHarnessManager({ store, runtime, chat, defaultModel: 'mock' });

        const liveRow = (storyId: string, workItem: string, startedAt: string) =>
            store.runs.create(
                {
                    story_id: storyId,
                    work_item_ref: workItem,
                    role: 'writer',
                    state: 'spawning',
                    started_at: startedAt,
                    ended_at: null,
                    tokens: 0,
                    kind: 'work',
                    delegated: []
                },
                { run_ref: null, author: true, why: 'seed a live row for the roster reconciliation' }
            );

        // Newest written first: the projection's `working` promise is oldest first regardless.
        liveRow(second.id, 'wi_draft_chapter_1', '2026-11-23T10:05:00.000Z');
        liveRow(first.id, 'wi_draft_chapter_0', '2026-11-23T10:01:00.000Z');
        liveRow(second.id, 'wi_seed_structure', '2026-11-23T10:03:00.000Z');

        store.runs.create(
            {
                story_id: first.id,
                work_item_ref: 'wi_draft_chapter_0',
                role: 'writer',
                state: 'torn_down',
                started_at: '2026-11-23T09:00:00.000Z',
                ended_at: '2026-11-23T09:30:00.000Z',
                tokens: 12,
                kind: 'work',
                end_reason: 'completed',
                delegated: []
            },
            { run_ref: null, author: true, why: 'seed a closed row that must stay off `working`' }
        );

        const writer = manager.statuses().find((row) => row.kind === 'writer');

        expect(writer?.status).toBe('running');
        expect(writer?.working).toEqual([
            {
                story_id: first.id,
                story_title: 'Hollow Sea',
                phase: 'chapters',
                role_name: 'writer',
                work_item: 'wi_draft_chapter_0',
                thread_id: 'run_row:run_1',
                started_at: Date.parse('2026-11-23T10:01:00.000Z')
            },
            {
                story_id: second.id,
                story_title: 'Salt Year',
                phase: 'chapters',
                role_name: 'writer',
                work_item: 'wi_seed_structure',
                thread_id: 'run_row:run_2',
                started_at: Date.parse('2026-11-23T10:03:00.000Z')
            },
            {
                story_id: second.id,
                story_title: 'Salt Year',
                phase: 'chapters',
                role_name: 'writer',
                work_item: 'wi_draft_chapter_1',
                thread_id: 'run_row:run_0',
                started_at: Date.parse('2026-11-23T10:05:00.000Z')
            }
        ]);
        // The closed row is history, not a live thread: it belongs to `recent` (S-3).
        expect(writer?.recent.map((row) => [row.run_id, row.state])).toEqual([['run_3', 'torn_down']]);

        manager.dispose();
    });

    it('counts a live engine thread and the Run row it belongs to ONCE, and closes to idle (R1)', async () => {
        const store = Store.empty();
        const story = storyOf(store, 'Hollow Sea');
        const runtime = new MockToolRuntime(store, story.id);

        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        const chat = new MockChatClient(async (): Promise<ChatResponse> => {
            await gate;

            return { message: { content: 'done' } };
        });
        const manager = new StoryHarnessManager({ store, runtime, chat, defaultModel: 'mock' });

        store.runs.create(
            {
                story_id: story.id,
                work_item_ref: 'wi_draft_chapter_0',
                role: 'writer',
                state: 'working',
                started_at: '2026-11-23T10:00:00.000Z',
                ended_at: null,
                tokens: 0,
                kind: 'work',
                delegated: []
            },
            { run_ref: null, author: true, why: 'seed the row this engine thread belongs to' }
        );

        const running = manager.run({
            storyId: story.id,
            phase: 'chapters',
            label: 'run_0',
            // `executor.ts` passes the journaled id, so the thread and the row name the same run.
            runId: 'run_0',
            roleName: 'writer',
            roleKind: 'writer',
            model: 'mock',
            system: 'BRIEF',
            kickoff: 'write',
            context: contextFor(store, runtime, story.id),
            runtime,
            tally: createTally()
        });

        const threadId = manager.forStory(story.id).threads()[0]?.thread_id;
        const during = manager.statuses().find((row) => row.kind === 'writer');

        // ONE entry — the engine thread's own — because the row it belongs to is covered by the
        // thread's `run_id` (the identity `api/projections.ts:agentThreads` dedups on, R1).
        expect(during?.status).toBe('running');
        expect(during?.working).toHaveLength(1);
        expect(during?.working[0]).toMatchObject({
            story_id: story.id,
            story_title: 'Hollow Sea',
            phase: 'chapters',
            role_name: 'writer',
            work_item: 'run_0'
        });
        expect(during?.working.map((thread) => thread.thread_id)).toEqual([threadId]);

        release();
        await running;

        // The thread is closed but the row is still `working` (the executor closes it only after the
        // result is committed): the journal still says a run is live, so the tile still says running.
        expect(
            manager.statuses().find((row) => row.kind === 'writer')?.working.map((thread) => thread.thread_id)
        ).toEqual(['run_row:run_0']);

        store.runs.update(
            'run_0',
            { state: 'torn_down', ended_at: '2026-11-23T10:00:09.000Z', tokens: 0 },
            { run_ref: null, author: true, why: 'close the run the way the executor does' }
        );

        // Neither a thread nor a live row is left: idle, with the run visible as history (S-3).
        const closed = manager.statuses().find((row) => row.kind === 'writer');

        expect(closed?.status).toBe('idle');
        expect(closed?.working).toEqual([]);
        expect(closed?.recent.map((row) => [row.run_id, row.state])).toEqual([['run_0', 'torn_down']]);

        manager.dispose();
    });

    it('adds all five defined employees to every Story harness, at Rank A, with the Editor routing the session (D-38a)', () => {
        const store = Store.empty();
        const story = storyOf(store, 'Hollow Sea');
        const runtime = new MockToolRuntime(store, story.id);
        const chat = new MockChatClient(async () => ({ message: { content: 'done' } }));
        let built: Parameters<typeof harness>[0] | undefined;
        const createHarness = ((configuration: Parameters<typeof harness>[0]) => {
            built = configuration;

            return harness(configuration);
        }) as typeof harness;
        const manager = new StoryHarnessManager({ store, runtime, chat, defaultModel: 'mock', createHarness });

        // Building a harness is what a Story's first dispatch does; no run is needed to prove the
        // roster is defined once and added whole.
        manager.forStory(story.id);

        expect(Object.keys(built?.agents ?? {}).sort()).toEqual([
            'critic',
            'editor',
            'reader',
            'researcher',
            'writer'
        ]);
        expect(built?.ranks).toEqual({
            writer: 'A',
            editor: 'A',
            critic: 'A',
            reader: 'A',
            // V-2: the Researcher must be Rank A, or its `research` Work Item could not be owned.
            researcher: 'A'
        });
        // The harness needs a session route; the Author's channel is the Editor, so that route is
        // the Editor's (V-1) — it is never shown as a roster role.
        expect(built?.entry).toBe('editor');

        manager.dispose();
    });

    it('opens a separate session for each phase of the same story', async () => {
        const store = Store.empty();
        const story = storyOf(store, 'Hollow Sea');
        const runtime = new MockToolRuntime(store, story.id);
        const chat = new MockChatClient(async () => ({ message: { content: 'done' } }));
        const manager = new StoryHarnessManager({ store, runtime, chat, defaultModel: 'mock' });

        for (const phase of ['summary', 'plotlines'] as const) {
            await manager.run({
                storyId: story.id,
                phase,
                label: `run_${phase}`,
                roleName: 'writer',
                roleKind: 'writer',
                model: 'mock',
                system: `BRIEF ${phase}`,
                kickoff: 'write',
                context: contextFor(store, runtime, story.id),
                runtime,
                tally: createTally()
            });
        }

        expect(
            manager
                .forStory(story.id)
                .sessionsForStatus()
                .map((session) => session.phase)
        ).toEqual(['summary', 'plotlines']);

        manager.dispose();
    });
});

// ---------------------------------------------------------------------------
// C2-AD3 — a Critic review pass ENDS at the report it files, and ends truthfully
//
// These run the SHIPPED path end to end: `StoryHarnessManager` → the Story's `@underload/harness`
// engine → the `critic-termination` plugin, with the package's mock provider behind the engine's
// stream adapter. Every assertion is on something observable from outside the plugin — how many times
// the provider was asked, what the provider was SHOWN, what the retained thread record says, and what
// is still in the store when the pass ends — because the acceptance criteria are about the run the
// Author reads, not about the plugin's internals.
// ---------------------------------------------------------------------------

/**
 * The two report tools, pinned here so this file tests WHEN the pass ends rather than the row shape a
 * report returns (W3b owns ./mock's versions of both and is rewriting them in parallel).
 *
 * `submitVerdict` still writes a REAL verdict row through the store, because C3's claim is that the
 * filed verdict SURVIVES the stop, and only a committed write can show that.
 */
const reportTools = (): Record<string, MockToolHandler> => ({
    submitVerdict: async (ctx, args, runtime) => {
        const created = await runtime.store.verdicts.create(
            {
                story_id: ctx.storyId,
                target_ref: String(args.target_ref ?? 'chapter_0'),
                target_kind: 'chapter',
                run_ref: ctx.runRef,
                template_ref: ctx.templateRef,
                round: 1,
                criteria_passed: [{ criterion: 'promise', result: true, evidence: 'the steeple answer lands' }],
                hard_pass: true,
                soft_count: 1,
                recommendation: 'fix'
            },
            { run_ref: ctx.runRef, why: 'the review pass filed its verdict (C2-AD3)' }
        );

        return { ok: true, id: created.id, rev: created.rev };
    },
    // A finding is S-4's report and NOT the terminal call: the pass must keep going after it (C5).
    raiseFinding: async () => ({ ok: true, id: 'finding_0', rev: 1 })
});

/** One employee thread, with everything this file repeats; only the kind and the script vary. */
function rig(kind: 'critic' | 'writer' | 'editor', options: { criticTurnCap?: number; tools?: Record<string, MockToolHandler> } = {}) {
    const store = Store.empty();
    const story = storyOf(store, 'Hollow Sea');
    // D-a: an `editor` seat needs a tool the mock catalogue does not carry (`structurePlotlines` lives
    // in ./tools, and ./mock is shared with other workers), so the rig takes per-test handlers. Every
    // existing call site passes none and gets the two report tools, byte-identically to before.
    const runtime = new MockToolRuntime(store, story.id, { ...reportTools(), ...(options.tools ?? {}) });
    const replies: ChatResponse[] = [];
    const chat = new MockChatClient((request, state) => {
        const reply = replies[state.callIndex];

        if (reply === undefined)
            throw new Error(
                `no scripted turn for call ${state.callIndex} — the ${kind} pass asked the provider more times than the test scripted`
            );

        return reply;
    });
    const manager = new StoryHarnessManager({
        store,
        runtime,
        chat,
        defaultModel: 'mock',
        ...(options.criticTurnCap === undefined ? {} : { criticTurnCap: options.criticTurnCap })
    });

    const rig_ = {
        store,
        story,
        runtime,
        chat,
        manager,
        replies,
        /** Script the pass's turns, one `ChatResponse` per provider call. */
        script: (...turns: ChatResponse[]) => replies.push(...turns),
        /** The usage every turn reports, so token totals stay exact (S-6). */
        run: (runId = 'run_0') =>
            manager.run({
                storyId: story.id,
                phase: 'chapters',
                label: runId,
                runId,
                roleName: kind,
                roleKind: kind,
                model: 'mock',
                system: `BRIEF ${kind}`,
                kickoff: 'review the chapter',
                context: runtime.createContext({
                    storyId: story.id,
                    runId,
                    // T-3: `runRef` is the attribution the store writes under, and the tool context
                    // takes it as its own field — the verdict row's `run_ref` is how C3 proves the
                    // filed report belongs to this run.
                    runRef: runId,
                    sessionRef: `sess_${runId}`,
                    roleName: kind,
                    roleKind: kind
                }),
                runtime,
                tally: createTally()
            })
    };

    return rig_;
}

/** One scripted turn: prose, and the tools it asks for. */
const turnOf = (content: string, tools: Array<{ name: string; args?: Record<string, unknown> }> = []) => ({
    message: msg({ content, toolCalls: tools.length === 0 ? undefined : calls(tools) }),
    usage: { input: 100, output: 20, cached_input: 0 }
});

describe('StoryHarnessManager — the Critic pass ends at its report (C2-AD3)', () => {
    it('stops on the reporting turn, records the thread torn_down, and keeps the filed verdict (C1, C3)', async () => {
        const h = rig('critic');

        h.script(
            turnOf('reading the chapter', [{ name: 'readChapter', args: { chapter_id: 'chapter_0' } }]),
            turnOf('the steeple answer pays off; the map line does not', [
                { name: 'submitVerdict', args: { target_ref: 'chapter_0', recommendation: 'fix' } }
            ]),
            // Scripted so it WOULD answer if asked: C1's claim is that this reply is never consumed.
            turnOf('never asked')
        );

        const outcome = await h.run();

        // The pass CONCLUDED. `endCause` says so, and its prose answer is kept rather than dropped.
        expect(outcome).toEqual({
            text: 'the steeple answer pays off; the map line does not',
            turns: 2,
            endCause: {
                kind: 'reported',
                turns: 2,
                cap: CRITIC_REVIEW_TURN_CAP,
                reports: ['submitVerdict'],
                terminal_tool: 'submitVerdict'
            }
        });
        // C1, measured at the provider: TWO calls, and the third scripted reply is still unconsumed —
        // the stop is taken at `turn.before`, after the report tool ran, so no further model turn is
        // issued. (The documented cap is asserted against its constant, not a magic number.)
        expect(h.chat.callCount).toBe(2);
        expect(h.chat.calls).toHaveLength(2);

        // C3 — the filed result survived the stop: the verdict row is in the book, attributed to the
        // run that filed it.
        expect(
            h.store.verdicts.list().map((verdict) => ({
                story_id: verdict.story_id,
                target_ref: verdict.target_ref,
                run_ref: verdict.run_ref,
                recommendation: verdict.recommendation,
                hard_pass: verdict.hard_pass
            }))
        ).toEqual([
            {
                story_id: h.story.id,
                target_ref: 'chapter_0',
                run_ref: 'run_0',
                recommendation: 'fix',
                hard_pass: true
            }
        ]);

        // And the thread the Author reads says COMPLETED: `torn_down`, its answer kept, no `error`.
        // Not `failed` (the old misreport that lost the pass) and not `abandoned`.
        const threads = h.manager.threads('critic');

        expect(threads).toHaveLength(1);
        expect(threads[0]).toMatchObject({
            run_id: 'run_0',
            role: 'critic',
            state: 'torn_down',
            answer: 'the steeple answer pays off; the map line does not',
            tokens: 240,
            retained: true
        });
        expect(threads[0]?.error).toBeUndefined();
        expect(h.manager.statuses().find((row) => row.kind === 'critic')?.status).toBe('idle');

        h.manager.dispose();
    });

    it('leaves a Writer that files a report tool on its normal path to the natural end (C2)', async () => {
        const h = rig('writer');

        h.script(
            // A Writer CAN call `submitVerdict` (T-6a's catalogue is role-blind). C2-AD3 is critic-only,
            // so this must not end the run.
            turnOf('writing', [{ name: 'submitVerdict', args: { target_ref: 'chapter_0' } }]),
            turnOf('still working', [{ name: 'readChapter', args: { chapter_id: 'chapter_0' } }]),
            turnOf('the chapter carries the promise')
        );

        const outcome = await h.run();

        expect(outcome).toEqual({ text: 'the chapter carries the promise', turns: 3 });
        expect(h.chat.callCount).toBe(3);
        // The retained row is the ordinary completed thread: no `error`, no cap sentence.
        expect(h.manager.threads('writer')[0]).toMatchObject({ state: 'torn_down', answer: 'the chapter carries the promise' });
        expect(h.manager.threads('writer')[0]?.error).toBeUndefined();

        h.manager.dispose();
    });

    it('nudges once, only after a report is filed, and stops at the verdict that nudge produced (C5)', async () => {
        const h = rig('critic');

        h.script(
            turnOf('reading', [{ name: 'readChapter', args: { chapter_id: 'chapter_0' } }]),
            // A PARTIAL report: S-4 counts it, C2-AD3 does not end the pass on it.
            turnOf('one defect', [{ name: 'raiseFinding', args: { criterion_ref: 'promise', target_ref: 'chapter_0' } }]),
            turnOf('still reading', [{ name: 'readChapter', args: { chapter_id: 'chapter_0' } }]),
            turnOf('verdict filed', [{ name: 'submitVerdict', args: { recommendation: 'fix' } }]),
            turnOf('never asked')
        );

        const outcome = await h.run();

        /** The nudge count in the request the provider actually received for turn `index`. */
        const nudgesIn = (index: number): number =>
            h.chat.calls[index].messages.filter((message) => message.content === CRITIC_CONCLUDE_NUDGE).length;

        // Only AFTER a report exists: neither the first request nor the one that was in flight while
        // the finding was filed carries the nudge.
        expect(nudgesIn(0)).toBe(0);
        expect(nudgesIn(1)).toBe(0);
        // The request right after the report: exactly one, and it is the LAST thing the model is shown
        // (mid-transcript it would read as one of its own tool results).
        expect(nudgesIn(2)).toBe(1);
        const shown = h.chat.calls[2].messages;

        expect(shown[shown.length - 1]).toEqual({ role: 'user', content: CRITIC_CONCLUDE_NUDGE });
        // AT MOST ONCE: a `turn.before` transcript override reaches the REQUEST and is never committed
        // to the canonical transcript, so the following turn carries no nudge at all.
        expect(nudgesIn(3)).toBe(0);
        expect(h.chat.callCount).toBe(4);

        expect(outcome).toEqual({
            text: 'verdict filed',
            turns: 4,
            endCause: {
                kind: 'reported',
                turns: 4,
                cap: CRITIC_REVIEW_TURN_CAP,
                reports: ['raiseFinding', 'submitVerdict'],
                terminal_tool: 'submitVerdict'
            }
        });

        h.manager.dispose();
    });

    it('caps a critic that never concludes, at the bound it was given, and records the cap (C4)', async () => {
        const h = rig('critic', { criticTurnCap: 2 });

        expect(h.manager.forStory(h.story.id).criticTurnCap).toBe(2);

        h.script(
            turnOf('reading', [{ name: 'readChapter', args: { chapter_id: 'chapter_0' } }]),
            turnOf('reading further', [{ name: 'readChapter', args: { chapter_id: 'chapter_0' } }]),
            turnOf('never asked'),
            turnOf('never asked either')
        );

        const outcome = await h.run();

        // `capped`, at exactly the bound, and NOT the `reported` shape a clean conclusion has.
        expect(outcome).toEqual({
            text: 'reading further',
            turns: 2,
            endCause: { kind: 'capped', turns: 2, cap: 2, reports: [] }
        });
        expect(h.chat.callCount).toBe(2);

        // The thread is torn down (teardown really happened) but is NOT silent about the missing
        // verdict: the cap sentence rides on `error`, which is what keeps a capped pass from reading
        // as a successful one. Exact string, because the rail renders it.
        const threads = h.manager.threads('critic');

        expect(threads[0]).toMatchObject({
            state: 'torn_down',
            answer: 'reading further',
            error: 'the Critic review pass reached its 2-model-turn cap without filing its verdict (C2-AD3)'
        });
        // Nothing was ever filed, so the pass is exactly what it claims to be: a bounded attempt.
        expect(h.store.verdicts.list()).toEqual([]);

        h.manager.dispose();
    });

    it('runs the policy at the documented default cap when the host sets none (C4’s bound)', () => {
        const store = Store.empty();
        const story = storyOf(store, 'Hollow Sea');
        const runtime = new MockToolRuntime(store, story.id);
        const chat = new MockChatClient(async (): Promise<ChatResponse> => ({ message: { content: 'done' } }));
        const manager = new StoryHarnessManager({ store, runtime, chat, defaultModel: 'mock' });

        // The default bound, pinned at its DEFINITION so a silent retune of the constant fails a test
        // (the installed plugin reads the same value the harness reports).
        expect(CRITIC_REVIEW_TURN_CAP).toBe(24);
        expect(manager.forStory(story.id).criticTurnCap).toBe(24);
        // The policy is installed on the harness that runs every employee — the plugin set the engine
        // reports is the proof, and the R2/R3 test above pins the exact list.
        expect([...manager.forStory(story.id).pluginNames]).toContain('critic-termination');

        manager.dispose();
    });
});

// ---------------------------------------------------------------------------
// D-a / T-W2 — a structuring run is NOT ended by its write, on the shipped engine
//
// `run/catalogue.ts:REPORT_TOOLS` gained `structurePlotlines`, the Phrase ② structuring write, so that
// a run whose whole product is that one write stops reading as an S-4 no-op turn. The risk the change
// had to answer is the other direction: does a name in the report list now END a run the way
// `submitVerdict` ends a Critic pass (C2-AD3)? The critic rig above answers that at the provider for a
// Critic — TWO calls, third scripted reply never consumed (lines 855-925). This is the same boundary
// measured on the run that actually holds the tool: an `editor` seat.
//
// THE RIG'S `criticTurnCap: 1` IS THE TRAP. The plugin is installed on the harness that runs EVERY
// employee (`forStory(...).pluginNames`, pinned above), so if termination keyed off the report list
// alone instead of the ROLE — `loop.ts:236 isCriticPass`, and the plugin's own `payload.agent ===
// 'critic'` guards — this editor run would have been stopped at turn 1 and the provider would have been
// asked exactly once. Two asks is therefore the measurement, not an assumption; the editor also has no
// cap of its own (E-0), so nothing else in the loop can cut it short.
// ---------------------------------------------------------------------------

describe('StoryHarnessManager — a structuring run keeps its turns after the write (D-a, T-W2)', () => {
    it('runs to its natural end after `structurePlotlines`, at a one-turn Critic bound, with the write counted as a report', async () => {
        const h = rig('editor', {
            criticTurnCap: 1,
            tools: {
                structurePlotlines: async (_ctx, args) => ({
                    ok: true,
                    rev: 1,
                    summary: `the chapter set is accepted under seed ${String(args.seed_hash)}`,
                    data: { chapter_count: args.chapter_count, status: 'accepted' }
                })
            }
        });

        h.script(
            turnOf('structured', [{ name: 'structurePlotlines', args: { seed_hash: 'h', chapter_count: 3 } }]),
            // Scripted so it WOULD answer. D-a's claim is that it IS asked: the write files its report
            // and the run still gets the turn that closes it.
            turnOf('the book is bounded')
        );

        const outcome = await h.run();

        // The natural end, exactly — and NOTE the absence of `endCause`. A run the plugin ended carries
        // the `{ kind: 'reported', terminal_tool, … }` cause the Critic rig above asserts (lines 871-881);
        // this one has no cause at all, because the model stopped asking and no policy stopped it.
        expect(outcome).toEqual({ text: 'the book is bounded', turns: 2 });
        expect(h.chat.callCount).toBe(2);
        expect(h.chat.calls).toHaveLength(2);

        // The retained thread is an ordinary completed pass: `torn_down`, its prose kept, and no cap
        // sentence on `error` — the bound of 1 that would have ended a Critic pass here says nothing
        // about an editor run, which is exactly what E-0 requires of a structuring seat.
        const threads = h.manager.threads('editor');

        expect(threads).toHaveLength(1);
        expect(threads[0]).toMatchObject({
            run_id: 'run_0',
            role: 'editor',
            state: 'torn_down',
            answer: 'the book is bounded',
            tokens: 240, // 120 (turn 1) + 120 (turn 2) — the two scripted usages
            retained: true
        });
        expect(threads[0]?.error).toBeUndefined();

        h.manager.dispose();
    });
});
