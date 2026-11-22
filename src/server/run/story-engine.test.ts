// The Story runtime on the harness engine: one harness per Story, one session per phase, one
// thread per Run, and a status projection that spans stories.
import { describe, expect, it, vi } from 'vitest';
import { harness } from '@underload/harness';
import { MockChatClient, calls, makeRecorder, msg } from '../llm/mock';
import type { ChatMessage, ChatResponse } from '../llm/client';
import { Store } from '../store';
import { MockToolRuntime, seedChapter, seedDigest, seedGoal, seedPlotline, seedStory, seedTemplate } from './mock';
import { createTally } from './loop';
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
    runtime.createContext({ storyId, runId: 'run_1', roleName: 'writer', roleKind: 'writer' });

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
        expect([...manager.forStory(story.id).pluginNames].sort()).toEqual(['context-compaction', 'context-trimmer']);

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
            label: 'run_1',
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
                                      chapter_id: 'chapter_1',
                                      summary: 'the lamp keeps its own log',
                                      expects: [{ id: 'chapter_1', rev: 1 }],
                                      why: 'the chapter pays the ledger entry'
                                  }
                              }
                          ])
                      }),
                      usage: { input: 10, output: 5 }
                  }
                : { message: msg({ content: 'reported' }), usage: { input: 3, output: 2 } };
        });
        const manager = new StoryHarnessManager({ store, runtime, chat, defaultModel: 'mock' });
        const tally = createTally();

        const result = await manager.run({
            storyId: story.id,
            phase: 'chapters',
            label: 'run_1',
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
        expect(store.chapters.get('chapter_1')).toMatchObject({
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
            label: 'run_1',
            roleName: 'checker',
            roleKind: 'checker',
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
        // value for `[0].function`: Field required"), which is the Checker's repeating fault.
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

    it('answers every employee’s rank, and keeps the newest closed runs on the tile (R15, S-3)', async () => {
        const store = Store.empty();
        const story = storyOf(store, 'Hollow Sea');
        const runtime = new MockToolRuntime(store, story.id);
        const chat = new MockChatClient(async () => ({ message: { content: 'done' } }));
        const manager = new StoryHarnessManager({ store, runtime, chat, defaultModel: 'mock' });

        store.runs.create(
            {
                story_id: story.id,
                work_item_ref: 'wi_check_chapters_1',
                role: 'checker',
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
        // V-1: an entry point is engine routing, not a roster role the dashboard draws.
        expect(rows.map((row) => (row as { entry?: boolean }).entry)).toEqual([
            undefined,
            undefined,
            undefined,
            undefined
        ]);

        const checker = rows.find((row) => row.kind === 'checker');

        expect(checker?.recent).toHaveLength(1);
        expect(checker?.recent[0]).toMatchObject({
            run_id: 'run_1',
            story_title: 'Hollow Sea',
            work_item: 'wi_check_chapters_1',
            state: 'failed',
            no_op: true
        });
        expect(checker?.recent[0]?.end_reason).toContain('Invalid value for `[0].function`');

        manager.dispose();
    });

    it('adds all four defined employees to every Story harness, at Rank A, with the Editor routing the session (R15)', () => {
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

        expect(Object.keys(built?.agents ?? {}).sort()).toEqual(['checker', 'editor', 'reader', 'writer']);
        expect(built?.ranks).toEqual({ writer: 'A', editor: 'A', reader: 'A', checker: 'A' });
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
