// The Story runtime on the harness engine: one harness per Story, one session per phase, one
// thread per Run, and a status projection that spans stories.
import { describe, expect, it } from 'vitest';
import { MockChatClient, calls, msg } from '../llm/mock';
import type { ChatResponse } from '../llm/client';
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
        expect(manager.forStory(first.id).sessionsForStatus().map((session) => session.phase)).toEqual(['summary']);
        expect(manager.forStory(first.id).sessionsForStatus()[0]?.runs.size).toBe(1);

        // The two Stories kept separate harnesses and separate sessions throughout.
        expect(manager.has(second.id)).toBe(true);
        expect(manager.forStory(first.id).sessionsForStatus().map((session) => session.phase)).toEqual(['summary']);
        expect(manager.forStory(second.id).sessionsForStatus().map((session) => session.phase)).toEqual(['chapters']);
        expect(manager.statuses().flatMap((row) => row.working)).toEqual([]);

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

        expect(manager.forStory(story.id).sessionsForStatus().map((session) => session.phase)).toEqual([
            'summary',
            'plotlines'
        ]);

        manager.dispose();
    });
});
