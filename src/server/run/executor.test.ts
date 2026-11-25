// W5 acceptance for the run layer's spawner half: S-1..S-7 driven end to end over the REAL store,
// T3's pinned tool contract (the ./mock test double) and the package's mock provider.
//
// WHY EVERY NUMBER HERE IS EXACT: §4.13's run row is the artifact the Author reads (D-18, U-7) and
// `tokens`/`no_op`/`end_reason` are inputs to the loop's own decisions (L-15, S-4, S-6). A range
// assertion would let a run row drift and still pass, so each expectation below is the value the
// spec or the seeded state forces — including the token totals, which the scripted `usage` makes
// plain arithmetic rather than a guess.
import { describe, expect, it, vi } from 'vitest';
import {
    ISSUE_LIST_SCHEMA_NAME,
    IssueListSchema,
    SUMMARY_SAMPLE_SCHEMA_NAME,
    SummarySampleSchema,
    type IssueList,
    type SummarySample
} from '../../shared/schemas';
import type { Chapter, Run } from '../../shared/types';
import type { ChatRequest, ChatResponse } from '../llm';
import { LlmError } from '../llm';
import { calls, msg } from '../llm/mock';
import { MockChatClient, type MockHandler } from '../llm/mock';
// The sweep's OWN lease machinery, imported rather than paraphrased: `lapsedRuns` is the exact
// predicate `LoopEngine.scanStory` runs against (server/loop/engine.ts:385), so "the sweep would
// not have abandoned this run" is asserted with the sweep's own query.
import { lapsedRuns } from '../loop/records';
import { DEFAULT_LEASE_IDLE_MS } from '../loop/types';
import { Store } from '../store';
import { setAgentModel } from './agent-models';
import { buildBrief } from './brief';
import { resolveHarness } from './harness';
import { RunExecutor } from './executor';
import {
    AUTHOR_ATTR,
    MockToolRuntime,
    seedChapter,
    seedDigest,
    seedGoal,
    seedPlotline,
    seedRevision,
    seedStory,
    seedTemplate
} from './mock';
import { compileSamplePrompt, compileScreenPrompt } from './phase1-prompt';
import { StoryThreadLog } from './thread-log';
import type { WorkItem } from './types';

/** §4.13's `end_reason` for a natural end — pinned in ./executor, restated here as the contract. */
const END_COMPLETED = 'completed — the model returned no tool call and the run reported';

/** The teardown state, projected off a journal patch — the shape every journal assertion uses. */
const stateSteps = (store: Store): string[] =>
    store.journal
        .filter((event) => event.collection === 'runs')
        .map((event) => `${event.op}:${(event.patch as Partial<Run> | undefined)?.state ?? ''}`);

/**
 * The §4.13 fields the crew panel and the loop engine read, picked out of the row so the
 * assertion is over the whole projected row (`toEqual`) rather than a field-by-field sniff.
 */
const rowOf = (store: Store, id: string) => {
    const row = store.runs.get(id)!;

    return {
        id: row.id,
        story_id: row.story_id,
        work_item_ref: row.work_item_ref,
        template_ref: row.template_ref,
        role: row.role,
        kind: row.kind,
        session_ref: row.session_ref,
        state: row.state,
        tokens: row.tokens,
        no_op: row.no_op,
        end_reason: row.end_reason,
        delegated: row.delegated,
        brief_hash: row.brief_hash
    };
};

/** The Story, the unit, and the template a dispatched job arrives at. */
function rig(
    options: {
        /** Panel size for the role — 1 (default) is the ordinary single-agent run. */
        agents?: number;
        aggregate?: 'majority' | 'merge' | 'lead';
        /** §4.12 `delegation`: undefined = undeclared, [] = forbidden (D-17e). */
        delegation?: string[];
        /** Competing drafts seeded on the unit, so an Editor has a real selection to make (D-23). */
        drafts?: number;
        kind?: 'write_unit' | 'select';
    } = {}
) {
    const store = Store.empty();
    const story = seedStory(store);

    seedGoal(store, story.id);
    seedDigest(store, story.id, 'Maren reaches the ridge; the map is wrong; the town is under water.');

    const plotline = seedPlotline(store, story.id);
    const chapter = seedChapter(store, story.id, { plotline_ref: plotline.id });

    const isPanel = (options.agents ?? 1) > 1;
    const template = seedTemplate(store, {
        name: isPanel ? 'editor-panel' : 'writer-prose',
        roles: [
            isPanel
                ? {
                      name: 'editor',
                      kind: 'editor',
                      prompt: 'You choose between competing drafts and say which rule you applied (T-2a).',
                      agents: options.agents,
                      aggregate: options.aggregate
                  }
                : {
                      name: 'writer',
                      kind: 'writer',
                      prompt: 'You write one chapter at a time, and never touch the Seed.'
                  }
        ],
        selection_rules:
            'Prefer the draft that pays off the 1911 map on the page (must_happen), not the one that only names it.',
        delegation: options.delegation
    });

    const drafts = Array.from({ length: options.drafts ?? 0 }, (_unused, index) =>
        seedRevision(store, story.id, chapter.id, `DRAFT ${index + 1} — the steeple answer`, `run_${index + 2}`)
    );

    const runtime = new MockToolRuntime(store, story.id);
    const item: WorkItem = {
        id: 'work_1',
        storyId: story.id,
        kind: options.kind ?? 'write_unit',
        templateRef: template.name,
        roleName: isPanel ? 'editor' : 'writer',
        unit: { kind: 'chapter', ref: chapter.id }
    };

    return { store, story, chapter, plotline, template, drafts, runtime, item };
}

/** The last journal event on the run row — S-3's teardown is a write like any other, so this is where it is visible. */
const lastRunEvent = (store: Store) => {
    const events = store.journal.filter((event) => event.collection === 'runs');

    return events[events.length - 1];
};

/** The brief as it stands BEFORE the run touched anything — the text the row's `brief_hash` names. */
const briefOf = (store: Store, item: WorkItem) => buildBrief(store, item, resolveHarness(store, item));

/**
 * A recording client that SNAPSHOTs each request.
 *
 * WHY not `makeRecorder` from ../llm/mock: ./loop keeps ONE `messages` array and pushes into it
 * between turns, so a recorded request is an alias of the live conversation — every entry reads as
 * the final transcript. These tests assert what the model was shown AT A GIVEN TURN (S-2's brief,
 * T-4's `currents`, D-17e's refusal), so the snapshot has to be a copy.
 */
function record(handler: MockHandler): { client: MockChatClient; requests: ChatRequest[] } {
    const requests: ChatRequest[] = [];
    const client = new MockChatClient((request, state) => {
        requests.push({ ...request, messages: request.messages.map((message) => ({ ...message })) });

        return handler(request, state);
    });

    return { client, requests };
}

// ---------------------------------------------------------------------------
// S-1 / S-3 / S-4 / S-4a / S-6 — the ordinary dispatched run
// ---------------------------------------------------------------------------

describe('RunExecutor — a dispatched run (S-1, S-3, S-4, S-6)', () => {
    it('writes the chapter, reports the escalation, and closes the row torn_down with its exact token total', async () => {
        const { store, runtime, item } = rig();
        const brief = briefOf(store, item);
        const { client, requests } = record((request: ChatRequest): ChatResponse => {
            const toolResults = request.messages.filter((message) => message.role === 'tool').length;

            // Turn 1: the Writer's own write, CAS'd against the rev its brief carried (T-4, P10).
            if (toolResults === 0)
                return {
                    message: msg({
                        content: 'writing the chapter',
                        toolCalls: calls([
                            {
                                name: 'editChapter',
                                args: {
                                    chapter_id: 'chapter_0',
                                    summary: 'Maren reads the map against the water',
                                    expects: [{ id: 'chapter_0', rev: 1 }],
                                    why: 'the chapter must pay off the 1911 map'
                                }
                            }
                        ])
                    }),
                    usage: { input: 120, output: 45, cached_input: 0 }
                };

            // Turn 2: the escalation is the report S-4 counts (a Writer "escalates", it does not verdict).
            if (toolResults === 1)
                return {
                    message: msg({
                        content: 'escalating the debt',
                        toolCalls: calls([
                            { name: 'requestAuthor', args: { question: 'does the valley flood on purpose?' } }
                        ])
                    }),
                    usage: { input: 90, output: 30, cached_input: 0 }
                };

            // Turn 3: no tool call — §9's natural end.
            return {
                message: msg({ content: 'the chapter carries the promise through to the cost' }),
                usage: { input: 60, output: 80, cached_input: 0 }
            };
        });

        const result = await new RunExecutor({ store, runtime, chat: client, defaultModel: 'gpt-5' }).execute(item);

        // The RunResult the loop engine reads (T6's pinned shape).
        expect(result).toEqual({
            runId: 'run_0',
            ended: 'completed',
            no_op: false, // it wrote AND reported, so S-4's no-op turn did not happen
            tokens: 425, // 165 + 120 + 140 — the sum of the scripted usage across all three turns (S-6)
            toolsCalled: ['editChapter', 'requestAuthor']
        });

        // §4.13's row, exactly. S-1: one row for one Work Item, and `session_ref` names the session
        // that no other run will ever reuse.
        expect(rowOf(store, 'run_0')).toEqual({
            id: 'run_0',
            story_id: 'story_0',
            work_item_ref: 'work_1',
            template_ref: 'writer-prose',
            role: 'writer',
            kind: 'work',
            session_ref: 'sess_run_0',
            state: 'torn_down', // S-3: teardown is unconditional
            tokens: 425,
            no_op: false,
            end_reason: END_COMPLETED, // S-3: the row records WHY it ended
            delegated: [], // S-7: nothing was fanned out, so nothing nests here
            brief_hash: brief.hash
        });

        // D-18: the row existed from before the first token, so both timestamps are filled in.
        const row = store.runs.get('run_0')!;
        expect(typeof row.started_at).toBe('string');
        expect(typeof row.ended_at).toBe('string');
        // create, working, a lease beat before each of the three model turns (S-4a), a beat after
        // each of the two tool calls, reporting, teardown (S-3).
        expect(row.rev).toBe(9);

        // S-2: the brief IS the run's memory — the first request is the assembled text plus the
        // kickoff and the whole catalogue (T-6a), and nothing else.
        expect(requests.length).toBe(3);
        expect(requests[0].messages.map((message) => message.role)).toEqual(['system', 'user']);
        expect(requests[0].messages[0].content).toBe(brief.text);
        expect(requests[0].messages[0].content).toContain(
            '# SEED — Author truth, read-only for you at every phase, forever'
        );
        expect(requests[0].messages[0].content).toContain(
            'Maren reaches the ridge; the map is wrong; the town is under water.'
        );
        expect(requests[0].messages[1].content).toContain(
            'End the run by reporting with one of: submitVerdict, raiseFinding'
        );
        expect(requests[0].tools).toEqual(runtime.schemas());

        // S-4a: the lease is `runs.updated_at`, refreshed while a provider request is in flight
        // and after every tool call — here three request beats and two tool beats between
        // `working` and `reporting`, and nothing else (E-0: no timeout).
        expect(stateSteps(store)).toEqual([
            'create:spawning', // D-18: the row exists before the brief is even assembled
            'update:working', // S-2: brief assembled and hashed
            'update:', // request beat, turn 1
            'update:', // heartbeat after editChapter
            'update:', // request beat, turn 2
            'update:', // heartbeat after requestAuthor
            'update:reporting', // §9's report step
            'update:', // request beat, turn 3
            'update:torn_down' // S-3's unconditional close
        ]);
        // S-3's teardown is not a separate journal verb in this store (P3's vocabulary is
        // create/update/delete), so the row's LAST write is the evidence it closed, and it names the
        // close the way P11 wants a reason attached.
        expect(lastRunEvent(store).attribution).toEqual({
            run_ref: 'run_0',
            why: `teardown — ${END_COMPLETED} (S-3)`
        });

        // P11: the write is the run's, not the Author's — the attribution is what D-20a's audit reads.
        // (Filtered to the run's own op: the seed's `create` on the same row is the Author's.)
        expect(
            store.journal
                .filter((event) => event.collection === 'chapters' && event.op === 'update')
                .map((event) => event.attribution)
        ).toEqual([{ run_ref: 'run_0', why: 'the chapter must pay off the 1911 map' }]);

        // And the store proves the write landed, with the rev the next `expects` needs (T-8).
        expect(store.chapters.get('chapter_0')).toMatchObject({
            rev: 2,
            summary: 'Maren reads the map against the water'
        });
        expect(
            store.tasks.list().map((task) => ({ id: task.id, kind: task.kind, title: task.title, state: task.state }))
        ).toEqual([
            { id: 'task_0', kind: 'author_question', title: 'does the valley flood on purpose?', state: 'blocked' }
        ]);
    });

    it('counts a run that reported nothing as a no-op turn, and never visits `reporting` (S-4)', async () => {
        const { store, runtime, item } = rig();
        const { client } = record(() => ({
            // The model stopped without calling a report tool — S-4's bug-in-a-brief case, measured
            // rather than prevented.
            message: msg({ content: 'the chapter is fine as it is' }),
            usage: { input: 50, output: 10, cached_input: 0 }
        }));

        const result = await new RunExecutor({ store, runtime, chat: client, defaultModel: 'gpt-5' }).execute(item);

        expect(result).toEqual({ runId: 'run_0', ended: 'completed', no_op: true, tokens: 60, toolsCalled: [] });
        expect(rowOf(store, 'run_0')).toMatchObject({
            state: 'torn_down',
            no_op: true,
            tokens: 60,
            end_reason: END_COMPLETED
        });
        // No report tool executed, so §9's `reporting` step never appears on the row; the one
        // empty patch is the lease beat while the single model request was in flight (S-4a).
        expect(stateSteps(store)).toEqual([
            'create:spawning',
            'update:working',
            'update:',
            'update:torn_down'
        ]);
    });

    it('moves the row to `reporting` while the report commit is still the next step (§9, U-7)', async () => {
        const { store, item } = rig();

        // The observation seam is a tool of our own: the mock runtime takes an override bag, and this
        // one reads the row back mid-run, which is exactly what the crew panel does (U-7).
        const seen: string[] = [];
        const runtime = new MockToolRuntime(store, 'story_0', {
            peekRow: (ctx) => {
                seen.push(store.runs.get(ctx.runRef)!.state);

                return { ok: true };
            }
        });

        const { client } = record((request: ChatRequest): ChatResponse => {
            const toolResults = request.messages.filter((message) => message.role === 'tool').length;

            if (toolResults === 0)
                return {
                    message: msg({ toolCalls: calls([{ name: 'requestAuthor', args: { question: 'which ending?' } }]) })
                };
            if (toolResults === 1) return { message: msg({ toolCalls: calls([{ name: 'peekRow', args: {} }]) }) };

            return { message: msg({ content: 'reported and escalated' }) };
        });

        await new RunExecutor({ store, runtime, chat: client, defaultModel: 'gpt-5' }).execute(item);

        // The report landed BEFORE the peek, so the row the run sees is `reporting`, and the final
        // state is still `torn_down` — the transient state is observable, not terminal.
        expect(seen).toEqual(['reporting']);
        expect(rowOf(store, 'run_0')).toMatchObject({ state: 'torn_down', no_op: false });
        expect(stateSteps(store)).toEqual([
            'create:spawning',
            'update:working',
            'update:', // request beat, turn 1
            'update:', // heartbeat after requestAuthor
            'update:reporting',
            'update:', // request beat, turn 2
            'update:', // heartbeat after peekRow
            'update:', // request beat, turn 3
            'update:torn_down'
        ]);
    });

    // -------------------------------------------------------------------------
    // P8 / U-7 — the Author's cord, and the two ways a run stops being its own
    // -------------------------------------------------------------------------

    it('kills a run mid-flight: abandoned, torn down, with the cord named on the row (P8, U-7, S-3)', async () => {
        const { store, runtime, item } = rig();
        const brief = briefOf(store, item);

        // The gate is inside the FIRST model call, so the kill lands while a turn is genuinely in
        // flight — the case U-7's Stop button is for.
        let openGate!: () => void;
        const gate = new Promise<void>((resolve) => {
            openGate = resolve;
        });
        const { client } = record(async (_request: ChatRequest, state) => {
            if (state.callIndex === 0) await gate;

            return {
                message: msg({
                    content: 'still working',
                    toolCalls: calls([
                        {
                            name: 'editChapter',
                            args: {
                                chapter_id: 'chapter_0',
                                summary: 'half-written',
                                expects: [{ id: 'chapter_0', rev: 1 }]
                            }
                        }
                    ])
                }),
                usage: { input: 50, output: 25, cached_input: 0 }
            };
        });

        const executor = new RunExecutor({ store, runtime, chat: client, defaultModel: 'gpt-5' });
        const running = executor.execute(item);

        // The row and the dial happen in the synchronous prefix, so the Author has a Stop button
        // before the first token — D-18's whole point. The engine's first stream request is queued
        // on its own thread, so the call lands one turn of the event loop later.
        await vi.waitFor(() => expect(client.callCount).toBe(1));
        expect(store.runs.get('run_0')!.state).toBe('working');

        executor.kill('run_0');
        executor.kill('run_does_not_exist'); // a kill for a run this instance does not own is a no-op
        openGate();

        const result = await running;

        // The engine checks cancellation before every tool call, so a turn the Author interrupted
        // does NOT land its write after the abort (P8's stop is preemptive).
        expect(result).toEqual({
            runId: 'run_0',
            ended: 'killed',
            no_op: true,
            tokens: 75,
            toolsCalled: []
        });

        const row = store.runs.get('run_0')!;
        expect(rowOf(store, 'run_0')).toEqual({
            id: 'run_0',
            story_id: 'story_0',
            work_item_ref: 'work_1',
            template_ref: 'writer-prose',
            role: 'writer',
            kind: 'work',
            // S-3's "no orphan sessions": a killed run keeps the session it wrote, because the Author
            // reads what the run got through. Nothing here deletes it.
            session_ref: 'sess_run_0',
            state: 'abandoned', // S-4a/L-3's terminal state; the row still closed (S-3)
            tokens: 75,
            no_op: true, // it never reached a report tool (S-4)
            end_reason: 'killed — the Author pulled the cord (P8, U-7)',
            delegated: [],
            brief_hash: brief.hash
        });
        expect(row.brief_hash).toMatch(/^[0-9a-f]{64}$/);

        // D-11: stopping a run is a stop, not a rewind — the events that happened stay. The tool
        // call the interrupted turn asked for is not issued after the abort.
        // The empty patch is the lease beat while the interrupted request was in flight (S-4a).
        expect(stateSteps(store)).toEqual(['create:spawning', 'update:working', 'update:', 'update:abandoned']);
        // S-3 has no exception for a stop: the row closed through the same teardown write, named on it.
        expect(lastRunEvent(store).attribution).toEqual({
            run_ref: 'run_0',
            why: 'teardown — killed — the Author pulled the cord (P8, U-7) (S-3)'
        });
        expect(store.chapters.get('chapter_0')).toMatchObject({ rev: 1 });
    });

    it('keeps the sweep’s lease sentence when it closes the row before the aborted run settles (S-4a, S-3)', async () => {
        const { store, runtime, item } = rig();

        let openGate!: () => void;
        const gate = new Promise<void>((resolve) => {
            openGate = resolve;
        });
        const { client } = record(async (_request: ChatRequest, state) => {
            if (state.callIndex === 0) await gate;

            return { message: msg({ content: 'done' }) };
        });

        const executor = new RunExecutor({ store, runtime, chat: client, defaultModel: 'gpt-5' });
        const running = executor.execute(item);

        await vi.waitFor(() => expect(client.callCount).toBe(1));

        // The sweep kills the lapsed run and closes its row with S-4a's reason (loop/engine.ts).
        executor.kill('run_0', 'lease');
        store.runs.update(
            'run_0',
            {
                state: 'abandoned',
                ended_at: new Date().toISOString(),
                end_reason: 'the lease lapsed after 120000ms of silence (S-4a, D-36)'
            },
            { run_ref: 'run_0', why: 'lease expiry returned the Work Item to the queue (S-4a)' }
        );
        openGate();

        await running;

        const row = store.runs.get('run_0')!;
        // The executor's teardown must not relabel a sweep kill as "the Author pulled the cord".
        expect(row.state).toBe('abandoned');
        expect(row.end_reason).toBe('the lease lapsed after 120000ms of silence (S-4a, D-36)');
        expect(row.tokens).toBe(0);
    });

    it('hands a rejected write straight back to the model with the current values, and lets it re-apply (T-4)', async () => {
        const { store, runtime, item } = rig();

        // The Author edits the same chapter first (D-20a: a direct write, no proposal), so the rev the
        // run's brief carried is already stale when its write arrives.
        store.chapters.update(
            'chapter_0',
            { summary: 'the Author rewrote the ridge line' },
            { run_ref: null, author: true, why: 'the Author edited while the run was reading (D-20a)' },
            [{ id: 'chapter_0', rev: 1 }]
        );

        const { client, requests } = record((request: ChatRequest): ChatResponse => {
            const toolResults = request.messages.filter((message) => message.role === 'tool').length;

            if (toolResults === 0)
                return {
                    message: msg({
                        toolCalls: calls([
                            {
                                name: 'editChapter',
                                args: {
                                    chapter_id: 'chapter_0',
                                    summary: "the run's line",
                                    expects: [{ id: 'chapter_0', rev: 1 }],
                                    why: 'pay off the map'
                                }
                            }
                        ])
                    })
                };
            // Turn 2 sees the conflict; the run re-applies with the rev `currents` named (T-4's
            // "re-read and re-apply, never force").
            if (toolResults === 1)
                return {
                    message: msg({
                        toolCalls: calls([
                            {
                                name: 'editChapter',
                                args: {
                                    chapter_id: 'chapter_0',
                                    summary: 'the run reconciled with the Author line',
                                    expects: [{ id: 'chapter_0', rev: 2 }],
                                    why: 'reconciled with the Author edit'
                                }
                            }
                        ])
                    })
                };
            if (toolResults === 2)
                return {
                    message: msg({
                        toolCalls: calls([{ name: 'requestAuthor', args: { question: 'is the ridge line mine now?' } }])
                    })
                };

            return { message: msg({ content: 'reconciled' }) };
        });

        const result = await new RunExecutor({ store, runtime, chat: client, defaultModel: 'gpt-5' }).execute(item);

        expect(result).toEqual({
            runId: 'run_0',
            ended: 'completed',
            no_op: false,
            tokens: 0, // no `usage` was scripted, and S-6 records what the provider sent — nothing invented
            toolsCalled: ['editChapter', 'editChapter', 'requestAuthor']
        });

        // The tool result the model actually read: the flag, the current record, and the sentence
        // naming the rule. The loop serialises the WHOLE result object, which is what makes a fresh
        // context able to correct itself (S-2, T-4).
        const conflictTurn = requests[1].messages.filter((message) => message.role === 'tool');
        expect(conflictTurn.length).toBe(1);

        const payload = JSON.parse(conflictTurn[0].content) as {
            ok: boolean;
            cas_conflict: boolean;
            currents: { id: string; record: Chapter }[];
            message: string;
        };

        expect(payload.ok).toBe(false);
        expect(payload.cas_conflict).toBe(true);
        expect(payload.currents).toEqual([
            {
                id: 'chapter_0',
                record: expect.objectContaining({ rev: 2, summary: 'the Author rewrote the ridge line' })
            }
        ]);
        expect(payload.message).toContain('chapter_0 is at rev 2, the caller expected rev 1');

        // And the run finished with the write applied over the Author's, at the rev T-8 reports.
        expect(store.chapters.get('chapter_0')).toMatchObject({
            rev: 3,
            summary: 'the run reconciled with the Author line'
        });
        expect(rowOf(store, 'run_0')).toMatchObject({ state: 'torn_down', no_op: false, end_reason: END_COMPLETED });
    });

    it('closes the row when the provider faults, and names the fault on it (S-3)', async () => {
        const { store, runtime, item } = rig();
        const { client } = record(() => {
            throw new LlmError(503, 'upstream asleep', 'the provider returned 503');
        });

        const result = await new RunExecutor({ store, runtime, chat: client, defaultModel: 'gpt-5' }).execute(item);

        expect(result).toEqual({
            runId: 'run_0',
            ended: 'failed',
            no_op: true,
            tokens: 0,
            toolsCalled: [],
            error: 'LlmError: the provider returned 503'
        });
        expect(rowOf(store, 'run_0')).toMatchObject({
            // The terminal STATE names the outcome (S-4a/L-3 read `failed` and `abandoned` as the two
            // ways a run stops being its own); S-3's teardown is the write that closes it either way.
            state: 'failed',
            // S-3: the row records why it ended, and the transport's own sentence is the most useful
            // thing it can carry for a provider fault.
            end_reason: 'failed — LLM provider fault: LlmError: the provider returned 503',
            no_op: true
        });
        expect(lastRunEvent(store).attribution).toEqual({
            run_ref: 'run_0',
            why: 'teardown — failed — LLM provider fault: LlmError: the provider returned 503 (S-3)'
        });
        // The row closed even though the loop threw before its first tool call; the empty patch
        // is the lease beat while the failing request was in flight (S-4a).
        expect(stateSteps(store)).toEqual(['create:spawning', 'update:working', 'update:', 'update:failed']);
    });

    // -------------------------------------------------------------------------
    // D-17e / S-7 — the delegated sub-context, and D-38 — the panel
    // -------------------------------------------------------------------------

    it("runs a delegated sub-context with no row of its own, and counts its report as the run's (D-17e, S-6, S-7, S-4)", async () => {
        const { store, runtime, item } = rig({ delegation: ['researcher'] });
        const { client, requests } = record((request: ChatRequest): ChatResponse => {
            // The sub-context's system turn is the generic reasoner prompt (the template declares no
            // role named `researcher`), so it is addressable without counting call indexes.
            const isSubContext = request.messages[0].content.includes('Calling role: researcher');
            const toolResults = request.messages.filter((message) => message.role === 'tool').length;

            if (!isSubContext && toolResults === 0)
                return {
                    message: msg({
                        content: 'asking',
                        toolCalls: calls([
                            {
                                name: 'delegate',
                                args: { role: 'researcher', task: 'what would break the 1911 map payoff?' }
                            }
                        ])
                    }),
                    usage: { input: 100, output: 20, cached_input: 0 }
                };
            if (isSubContext && toolResults === 0)
                return {
                    message: msg({
                        toolCalls: calls([
                            {
                                name: 'raiseFinding',
                                args: {
                                    criterion_ref: 'C-4',
                                    target_ref: 'chapter_0',
                                    title: 'the 1911 map is set up and never paid off',
                                    detail: 'sec_1 puts the map in her hand; nothing answers it',
                                    evidence: 'chapter_0 sec_1',
                                    cost: 'major',
                                    why: 'D-15: the failure needs an evidence line'
                                }
                            }
                        ])
                    }),
                    usage: { input: 70, output: 30, cached_input: 0 }
                };
            if (isSubContext)
                return {
                    message: msg({ content: 'the map is set up and never paid off in chapter_0' }),
                    usage: { input: 40, output: 50, cached_input: 0 }
                };

            return {
                message: msg({ content: 'the sub-context filed it; the run reports' }),
                usage: { input: 30, output: 25, cached_input: 0 }
            };
        });

        const result = await new RunExecutor({ store, runtime, chat: client, defaultModel: 'gpt-5' }).execute(item);

        // S-6: the run's total is its internals' total — parent 175 + sub-context 190.
        expect(result).toEqual({
            runId: 'run_0',
            ended: 'completed',
            no_op: false,
            tokens: 365,
            toolsCalled: ['delegate', 'raiseFinding']
        });

        // S-7: the sub-context is NOT a Work Item and gets no row of its own — the Author's unit of
        // attention is the dispatched run, and the sub-context shows nested under it.
        expect(store.runs.list().map((row) => row.id)).toEqual(['run_0']);

        const row = store.runs.get('run_0')!;
        expect(row.delegated).toEqual([
            {
                role: 'researcher',
                task: 'what would break the 1911 map payoff?',
                summary: 'the map is set up and never paid off in chapter_0',
                tokens: 190
            }
        ]);
        expect(rowOf(store, 'run_0')).toMatchObject({
            state: 'torn_down',
            tokens: 365,
            no_op: false,
            end_reason: END_COMPLETED
        });

        // D-17e: the sub-context's final text is the parent's only tool result.
        const delegateResult = JSON.parse(
            requests[3].messages.filter((message) => message.role === 'tool')[0].content
        ) as { ok: boolean; data?: { summary: string } };
        expect(delegateResult).toEqual({
            ok: true,
            data: { summary: 'the map is set up and never paid off in chapter_0' }
        });

        // T-2b: it wrote for real, under the PARENT's run identity — a phantom run id would break the
        // audit trail (P11).
        expect(
            store.findings
                .list()
                .map((finding) => ({ id: finding.id, criterion_ref: finding.criterion_ref, cost: finding.cost }))
        ).toEqual([{ id: 'finding_0', criterion_ref: 'C-4', cost: 'major' }]);
        expect(
            store.journal.filter((event) => event.collection === 'findings').map((event) => event.attribution.run_ref)
        ).toEqual(['run_0']);
    });

    it('refuses a delegation the template forbids, and teaches the model why (D-17e, T-1a)', async () => {
        // The built-in `critic-genre` forbids fan-out with an explicit empty list; an absent field
        // means undeclared and is allowed.
        const store = Store.empty();
        const story = seedStory(store);

        seedGoal(store, story.id);
        seedDigest(store, story.id, 'the ridge, the map, the water');
        seedPlotline(store, story.id);
        const chapter = seedChapter(store, story.id);

        seedTemplate(store, {
            name: 'critic-genre',
            roles: [
                {
                    name: 'critic',
                    kind: 'critic',
                    prompt: 'You read for what the genre promises and propose, never edit (D-26, P10).'
                }
            ],
            delegation: []
        });

        const item: WorkItem = {
            id: 'work_1',
            storyId: story.id,
            kind: 'check_unit',
            templateRef: 'critic-genre',
            roleName: 'critic',
            unit: { kind: 'chapter', ref: chapter.id }
        };
        const runtime = new MockToolRuntime(store, story.id);
        const { client, requests } = record((request: ChatRequest): ChatResponse => {
            const toolResults = request.messages.filter((message) => message.role === 'tool').length;

            if (toolResults === 0)
                return {
                    message: msg({
                        toolCalls: calls([
                            { name: 'delegate', args: { role: 'researcher', task: 'check the 1911 map' } }
                        ])
                    }),
                    usage: { input: 40, output: 10, cached_input: 0 }
                };

            return { message: msg({ content: 'I will judge it myself then' }), usage: { input: 20, output: 15, cached_input: 0 } };
        });

        const result = await new RunExecutor({ store, runtime, chat: client, defaultModel: 'gpt-5' }).execute(item);

        expect(result).toEqual({
            runId: 'run_0',
            ended: 'completed',
            no_op: true,
            tokens: 85,
            toolsCalled: ['delegate']
        });
        expect(store.runs.list().length).toBe(1);
        expect(store.runs.get('run_0')!.delegated).toEqual([]);

        // The refusal is a teaching message inside the run (T-1a): the rule id, the reason, and the
        // list the model may actually use.
        expect(JSON.parse(requests[1].messages.filter((message) => message.role === 'tool')[0].content)).toEqual({
            ok: false,
            refused: 'D-17e',
            message:
                'template "critic-genre" does not name "researcher" in its delegation list (D-17e) — delegate to nobody, or do the reasoning yourself'
        });
    });

    it('runs a 3-agent panel to ONE selection, with the dissent in the note and three nested entries (D-38, S-7, U-8d)', async () => {
        const { store, runtime, item } = rig({ agents: 3, aggregate: 'majority', drafts: 3, kind: 'select' });
        const { client } = record((request: ChatRequest): ChatResponse => {
            const system = request.messages[0].content;
            const agent = /You are agent (\d+) of 3/.exec(system);
            const toolResults = request.messages.filter((message) => message.role === 'tool').length;

            // Each agent picks a draft (agents 1 and 2 agree, agent 3 does not) and then answers.
            if (agent !== null && toolResults === 0) {
                const index = Number(agent[1]);
                const revisionId = index === 3 ? 'revision_1' : 'revision_0';

                return {
                    message: msg({
                        content: `agent ${index} reads the drafts`,
                        toolCalls: calls([
                            {
                                name: 'selectRevision',
                                args: {
                                    unit_ref: 'chapter_0',
                                    revision_id: revisionId,
                                    selection_note: `agent ${index} picks ${revisionId === 'revision_0' ? 'the map paid off on the page' : 'the bell under the water'}`,
                                    expects: [{ id: revisionId, rev: 1 }],
                                    why: 'the must_happen rule (T-2a)'
                                }
                            }
                        ])
                    }),
                    usage: { input: 100, output: 40, cached_input: 0 }
                };
            }

            return {
                message: msg({ content: `agent ${agent === null ? '?' : agent[1]} chose its draft and reported` }),
                usage: { input: 100, output: 40, cached_input: 0 }
            };
        });

        const result = await new RunExecutor({ store, runtime, chat: client, defaultModel: 'gpt-5' }).execute(item);

        // D-38: the loop receives exactly ONE permission-bearing answer, so S-4 sees a report and the
        // run's `toolsCalled` lists one write.
        expect(result).toEqual({
            runId: 'run_0',
            ended: 'completed',
            no_op: false,
            tokens: 840,
            toolsCalled: ['selectRevision']
        });
        // `majority` is arithmetic, so the panel costs three agents × two turns and no aggregator call
        // (G-3 keeps mechanical questions out of an LLM's judgment).
        expect(client.callCount).toBe(6);

        // The winning set executed ONCE, on the run's own context and identity — not three times, and
        // never under a per-agent id (D-38, T-2b, P11).
        expect(
            runtime.calls.map((call) => ({ name: call.name, runRef: call.runRef, revision_id: call.args.revision_id }))
        ).toEqual([{ name: 'selectRevision', runRef: 'run_0', revision_id: 'revision_0' }]);

        // D-38's MUST: the dissent is named IN the note, alongside the agent's own reasoning. D-22
        // deleted the other two drafts in the same commit.
        expect(
            store.revisions.list().map((revision) => ({
                id: revision.id,
                state: revision.state,
                selection_note: revision.selection_note
            }))
        ).toEqual([
            {
                id: 'revision_0',
                state: 'selected',
                selection_note:
                    'agent 1 picks the map paid off on the page | 2 of 3 preferred revision_0; 1 of 3 preferred revision_1; selected revision_0 on majority 2 of 3'
            }
        ]);
        expect(store.chapters.get('chapter_0')!.current_revision).toBe('revision_0');

        const row = store.runs.get('run_0')!;
        // S-7 / U-8d: the three agents nest on the row (no extra rows), and the row marks that this
        // run's internals disagreed, because a hidden disagreement is the one thing untunable (D-38).
        expect(row.delegated.slice().sort((left, right) => left.role.localeCompare(right.role))).toEqual([
            {
                role: 'editor#agent_1',
                task: 'panel agent of select for chapter chapter_0',
                summary: 'agent 1 chose its draft and reported',
                tokens: 280
            },
            {
                role: 'editor#agent_2',
                task: 'panel agent of select for chapter chapter_0',
                summary: 'agent 2 chose its draft and reported',
                tokens: 280
            },
            {
                role: 'editor#agent_3',
                task: 'panel agent of select for chapter chapter_0',
                summary: 'agent 3 chose its draft and reported',
                tokens: 280
            }
        ]);
        expect(store.runs.list().map((entry) => entry.id)).toEqual(['run_0']);
        expect(row.tokens).toBe(840);
        expect(row.end_reason).toBe(
            `${END_COMPLETED}; panel disagreed — 2 of 3 preferred revision_0; 1 of 3 preferred revision_1; selected revision_0 on majority 2 of 3 (3 of 3 agents answered)`
        );

        // The state trail, ignoring the heartbeats and the nested-entry writes (neither carries a
        // state in its patch): the run still visits `reporting` exactly once, from the panel's one
        // report surface.
        expect(stateSteps(store).filter((step) => step !== 'update:')).toEqual([
            'create:spawning',
            'update:working',
            'update:reporting',
            'update:torn_down'
        ]);
    });

    it('dispatches the same unit twice into two rows and two sessions over one identical brief (S-1, S-2, D-12a)', async () => {
        const { store, runtime, item } = rig();
        const brief = briefOf(store, item);
        const { client } = record(() => ({
            message: msg({ content: 'nothing to add' }),
            usage: { input: 10, output: 5, cached_input: 0 }
        }));
        const executor = new RunExecutor({ store, runtime, chat: client, defaultModel: 'gpt-5' });

        const first = await executor.execute(item);
        const second = await executor.execute(item);

        expect(first.runId).toBe('run_0');
        expect(second.runId).toBe('run_1');
        expect(second.tokens).toBe(15);

        // S-1: a run is never handed a second job, so the second dispatch is a second row with a
        // session no run will reuse.
        expect(
            store.runs
                .list()
                .map((row) => ({ id: row.id, session_ref: row.session_ref, state: row.state, tokens: row.tokens }))
        ).toEqual([
            { id: 'run_0', session_ref: 'sess_run_0', state: 'torn_down', tokens: 15 },
            { id: 'run_1', session_ref: 'sess_run_1', state: 'torn_down', tokens: 15 }
        ]);

        // S-2 / D-12a: the brief is a pure function of stored state, so two dispatches over the same
        // state hash identically — and a run's own rows never leak into it (which is why the second
        // hash still matches the pre-run assembly).
        expect(store.runs.list().map((row) => row.brief_hash)).toEqual([brief.hash, brief.hash]);
    });

    it('asks for the roster model the Author set, then falls back to the template role (U-8, T-6b)', async () => {
        const { store, runtime, item, template } = rig();
        const { client, requests } = record(() => ({
            message: msg({ content: 'nothing to add' }),
            usage: { input: 1, output: 1, cached_input: 0 }
        }));
        const executor = new RunExecutor({ store, runtime, chat: client, defaultModel: 'gpt-5' });

        setAgentModel(store, 'writer', 'deepseek-r1');

        await executor.execute(item);

        // The roster choice is the agent's model until the Author clears it.
        expect(requests[0]?.model).toBe('deepseek-r1');

        // T-6b: a template role's own model governs its crew once the roster has no choice.
        store.templates.update(
            template.id,
            { roles: template.roles.map((role) => ({ ...role, model: 'role-only' })) },
            { run_ref: null, author: true, why: 'the test pins a role-level model over the roster default' },
            [{ id: template.id, rev: template.rev }]
        );
        setAgentModel(store, 'writer', null);

        requests.length = 0;
        await executor.execute(item);

        expect(requests[0]?.model).toBe('role-only');
    });
});

// ---------------------------------------------------------------------------
// §4.2 / §2 decision 3 — the single-turn, no-tool structured run
// ---------------------------------------------------------------------------

/**
 * Phase ① in the state a `sample_unit`/`screen_samples` job arrives at: a Story in the summary
 * phase, the two Phase-1 templates, an accepted Seed Brief, and the draft a screen judges.
 *
 * A no-tool run assembles NO brief (its memory is the compiled prompt, §5), so the fixture only
 * needs what the compiler reads — which is exactly what makes these tests prove the compiler is
 * the run's whole input.
 */
function samplingRig() {
    const store = Store.empty();
    const story = seedStory(store, {
        phase: 'summary',
        idea: 'A cartographer returns to the valley she mapped as a girl.'
    });

    seedTemplate(store, {
        name: 'writer-summary-sampler',
        roles: [
            {
                name: 'writer',
                kind: 'writer',
                prompt: 'You are the Writer for phase ① in sampling mode. Answer with ONE JSON object.'
            }
        ],
        serves_phase: ['summary']
    });

    seedTemplate(store, {
        name: 'critic-screening',
        roles: [
            {
                name: 'critic',
                kind: 'critic',
                prompt: 'You are the screening Critic for phase ①. Report ONLY critical and high problems.'
            }
        ],
        serves_phase: ['summary']
    });

    store.seedBriefs.create(
        {
            story_id: story.id,
            seed_hash: 'abcd1234',
            logline: 'A cartographer finds her map is wrong.',
            protagonist: 'Maren',
            want: 'to prove the map',
            obstacle: 'the reservoir',
            stakes: 'her memory',
            setting: 'a drowned valley, 1963',
            world_rules: ['no magic'],
            promise: 'map and territory reconcile',
            constraints: [],
            open_questions: [],
            status: 'accepted'
        },
        AUTHOR_ATTR
    );

    const draft = store.revisions.create(
        {
            story_id: story.id,
            unit_kind: 'summary',
            unit_ref: 'summary_0',
            body: {
                fields: {
                    premise: 'Maren returns.',
                    promise: 'She floods it.',
                    theme: 'Loss.',
                    tone: 'Cold.',
                    ending: 'Water.',
                    world_rules: 'Engineering.'
                }
            },
            run_ref: 'run_1',
            state: 'drafted',
            verdict_refs: [],
            round: 1
        },
        AUTHOR_ATTR
    );

    const runtime = new MockToolRuntime(store, story.id);
    const sampleItem: WorkItem = {
        id: 'wi_sample_summary_0_1',
        storyId: story.id,
        kind: 'sample_unit',
        templateRef: 'writer-summary-sampler',
        roleName: 'writer',
        toolMode: 'none',
        responseSchema: { name: SUMMARY_SAMPLE_SCHEMA_NAME, schema: SummarySampleSchema },
        sampleIndex: 2,
        round: 1
    };

    return { store, story, draft, runtime, sampleItem };
}

/** The one JSON answer a scripted sampler gives — exact, so `structured` can be `toEqual`-ed. */
const SAMPLE_ANSWER: SummarySample = {
    premise: 'Maren returns to a valley the reservoir redrew.',
    promise: 'The map and the water reconcile.',
    theme: 'Memory against measurement.',
    tone: 'Plain, cold, precise.',
    ending: 'She floods the valley on purpose.',
    world_rules: 'No magic; the reservoir is engineering.',
    knowledge_used: ['K-aaa']
};

describe('RunExecutor — the structured no-tool run (§4.2, §2 decision 3)', () => {
    it('sends ONE tool-less request with the schema contract and the sample seed, and returns the parsed answer', async () => {
        const { store, story, runtime, sampleItem } = samplingRig();
        const compiled = compileSamplePrompt(store, story.id, { round: 1 });
        const { client, requests } = record(() => ({
            message: msg({ content: JSON.stringify(SAMPLE_ANSWER) }),
            usage: { input: 40, output: 10, cached_input: 5 }
        }));

        const result = await new RunExecutor({ store, runtime, chat: client, defaultModel: 'gpt-5' }).execute(
            sampleItem
        );

        // §4.2: exactly one request, and NOTHING that could make it a tool run.
        expect(requests.length).toBe(1);
        expect('tools' in requests[0]).toBe(false);
        expect('temperature' in requests[0]).toBe(false);
        expect(requests[0].responseFormat).toEqual({ name: SUMMARY_SAMPLE_SCHEMA_NAME, schema: SummarySampleSchema });
        // §5's diversity knob: the 1-based sample index rides as the provider seed.
        expect(requests[0].seed).toBe(2);
        expect(requests[0].messages.map((message) => message.role)).toEqual(['system', 'user']);
        expect(requests[0].messages[0].content).toBe(compiled.system);
        expect(requests[0].messages[1].content).toBe(compiled.user);

        // §2 decision 2: the engine persists the validated answer, so it never becomes a no-op.
        expect(result).toEqual({
            runId: 'run_0',
            ended: 'completed',
            no_op: false,
            tokens: 50,
            toolsCalled: [],
            structured: SAMPLE_ANSWER,
            promptHash: compiled.hash,
            usage: { input: 40, output: 10, cached_input: 5 }
        });

        // D-18/S-2: the row exists through spawn → work → teardown, and its `brief_hash` is the
        // COMPILED PROMPT's hash — that is the memory the model was actually given.
        const row = store.runs.get('run_0')!;

        expect({
            id: row.id,
            state: row.state,
            kind: row.kind,
            role: row.role,
            brief_hash: row.brief_hash,
            no_op: row.no_op,
            tokens: row.tokens,
            end_reason: row.end_reason
        }).toEqual({
            id: 'run_0',
            state: 'torn_down',
            kind: 'work',
            role: 'writer',
            brief_hash: compiled.hash,
            no_op: false,
            tokens: 50,
            end_reason: 'completed — one structured turn, validated against the response schema (§4.2)'
        });
    });

    it('repairs once: an invalid answer gets one retry with the validator’s error, then the valid one is taken', async () => {
        const { store, story, runtime, sampleItem } = samplingRig();
        const compiled = compileSamplePrompt(store, story.id, { round: 1 });
        const { client, requests } = record((_request, state) =>
            state.callIndex === 0
                ? { message: msg({ content: 'nope' }), usage: { input: 10, output: 5, cached_input: 0 } }
                : { message: msg({ content: JSON.stringify(SAMPLE_ANSWER) }), usage: { input: 20, output: 8, cached_input: 4 } }
        );

        const result = await new RunExecutor({ store, runtime, chat: client, defaultModel: 'gpt-5' }).execute(
            sampleItem
        );

        expect(requests.length).toBe(2);
        // The repair turn keeps the previous answer in the transcript and names the failure.
        expect(requests[1].messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user']);
        expect(requests[1].messages[2].content).toBe('nope');
        expect(requests[1].messages[3].content).toBe(
            'Your previous answer was not valid: assistant content is not valid JSON: "nope". Re-emit the COMPLETE JSON object matching the schema, and nothing else.'
        );

        // S-6: both provider calls count — the failed one cost a request too.
        expect(result).toEqual({
            runId: 'run_0',
            ended: 'completed',
            no_op: false,
            tokens: 43,
            toolsCalled: [],
            structured: SAMPLE_ANSWER,
            promptHash: compiled.hash,
            usage: { input: 30, output: 13, cached_input: 4 }
        });
    });

    it('fails the run after the one repair when the second answer is invalid too, and names the error on the row', async () => {
        const { store, runtime, sampleItem } = samplingRig();
        const { client, requests } = record(() => ({
            message: msg({ content: 'still not json' }),
            usage: { input: 10, output: 5, cached_input: 0 }
        }));

        const result = await new RunExecutor({ store, runtime, chat: client, defaultModel: 'gpt-5' }).execute(
            sampleItem
        );

        // TWO attempts exactly — the repair budget is one, never a second (§4.2).
        expect(requests.length).toBe(2);
        expect(result).toEqual({
            runId: 'run_0',
            ended: 'failed',
            no_op: true,
            tokens: 30,
            toolsCalled: [],
            error:
                'Error: structured answer failed schema validation after 2 attempts: assistant content is not valid JSON: "still not json"'
        });

        const row = store.runs.get('run_0')!;

        expect(row.state).toBe('failed');
        // S-3: the row says exactly why the run ended, and the validation error is the reason.
        expect(row.end_reason).toBe(
            'failed: Error: structured answer failed schema validation after 2 attempts: assistant content is not valid JSON: "still not json"'
        );
    });

    it('screens ONE named draft with the IssueList contract and keeps the sibling samples out of the prompt', async () => {
        const { store, story, draft, runtime } = samplingRig();
        const compiled = compileScreenPrompt(store, story.id, draft.id);
        const issues: IssueList = {
            issues: [
                {
                    severity: 'critical',
                    criterion: 'seed',
                    location: 'ending',
                    quote: 'She floods it.',
                    detail: 'The Seed Brief promises a reconciliation the ending does not stage.'
                }
            ]
        };
        const { client, requests } = record(() => ({
            message: msg({ content: JSON.stringify(issues) }),
            usage: { input: 30, output: 12, cached_input: 0 }
        }));

        const result = await new RunExecutor({ store, runtime, chat: client, defaultModel: 'gpt-5' }).execute({
            id: 'wi_screen_summary_0_1_2',
            storyId: story.id,
            kind: 'screen_samples',
            templateRef: 'critic-screening',
            roleName: 'critic',
            revisionRef: draft.id,
            toolMode: 'none',
            responseSchema: { name: ISSUE_LIST_SCHEMA_NAME, schema: IssueListSchema }
        });

        expect(requests.length).toBe(1);
        expect(requests[0].responseFormat).toEqual({ name: ISSUE_LIST_SCHEMA_NAME, schema: IssueListSchema });
        // A screen is not a sample: no `seed` is asked for, and the prompt is the screening one.
        expect('seed' in requests[0]).toBe(false);
        expect(requests[0].messages[0].content).toBe(compiled.system);
        expect(requests[0].messages[1].content).toBe(compiled.user);
        expect(requests[0].messages[1].content).toContain('## TARGET DRAFT\npremise: Maren returns.');

        expect(result).toEqual({
            runId: 'run_0',
            ended: 'completed',
            no_op: false,
            tokens: 42,
            toolsCalled: [],
            structured: issues,
            promptHash: compiled.hash,
            usage: { input: 30, output: 12, cached_input: 0 }
        });
    });

    it('retains the exchange in the thread log, because no engine thread exists for this mode', async () => {
        const { store, story, runtime, sampleItem } = samplingRig();
        const compiled = compileSamplePrompt(store, story.id, { round: 1 });
        const threadLog = StoryThreadLog.memory();
        const { client } = record(() => ({
            message: msg({ content: JSON.stringify(SAMPLE_ANSWER) }),
            usage: { input: 1, output: 1, cached_input: 0 }
        }));

        const result = await new RunExecutor({
            store,
            runtime,
            chat: client,
            defaultModel: 'gpt-5',
            threadLog
        }).execute(sampleItem);

        const records = threadLog.list('writer');

        expect(records).toHaveLength(1);
        expect({
            thread_id: records[0].thread_id,
            run_id: records[0].run_id,
            role: records[0].role,
            role_name: records[0].role_name,
            state: records[0].state,
            tokens: records[0].tokens,
            request: records[0].request,
            answer: records[0].answer,
            retained: records[0].retained
        }).toEqual({
            thread_id: 'single_run_0',
            run_id: result.runId,
            role: 'writer',
            role_name: 'writer',
            state: 'torn_down',
            tokens: 2,
            request: `${compiled.system}\n\n---\n\n${compiled.user}`,
            answer: JSON.stringify(SAMPLE_ANSWER),
            retained: true
        });
    });
});

// ---------------------------------------------------------------------------
// S-4a / D-36 — the lease across a SLOW structured turn (B2)
//
// WHY THIS SUITE EXISTS: on a fresh A Dog Tale four of six Summary samples and two screens
// closed as `the lease lapsed after 120000ms of silence (S-4a, D-36)` with `tokens=0`, while a
// FIFTH sample completed in 120.36s. A `toolMode: 'none'` run owns its provider call directly
// (./executor's `runStructuredTurn`) and never enters the engine, so nothing in the loop that
// beats the lease for a tool run was beating it here — a healthy model composing one long turn
// was indistinguishable from a dead worker, and the sweep's lease killed it mid-request and ate
// the round's bounded sampling allowance. Every case below pins one clause of the fix:
//   R1 liveness starts before the request and stops on its first ending, with no handle left;
//   R2 a pending request that crosses the old 120s idle threshold still completes;
//   R3 a request that NEVER answers is bounded by the ceiling, with its own cause on the row.
// They run on a fake clock: the assertions are exact tick counts, not sleeps, so the suite stays
// deterministic and a millisecond of real waiting never enters it.
// ---------------------------------------------------------------------------

/**
 * A provider whose answer is a PROMISE the test settles by hand — the only way to hold one
 * structured request open across the lease window without sleeping for minutes.
 *
 * It also IGNORES its `signal`, which is the worst-case transport the request ceiling exists to
 * bound (R3): with no rejection on abort, nothing but the executor's own finite guard can end the
 * run, and these tests prove one exists. `release` is the happy path; leaving it uncalled is the
 * hung path.
 */
function heldProvider() {
    const requests: ChatRequest[] = [];
    let release!: (response: ChatResponse) => void;

    // ONE promise for every call this client receives: a second attempt would see the same pending
    // answer, so a "how many requests did the run make" assertion stays meaningful.
    const pending = new Promise<ChatResponse>((resolve) => {
        release = resolve;
    });

    const client = new MockChatClient((request) => {
        // Snapshot like `record` above — the live `messages` array is mutated between attempts, so a
        // bare push would record the final transcript rather than this request.
        requests.push({ ...request, messages: request.messages.map((message) => ({ ...message })) });

        return pending;
    });

    return { client, requests, release };
}

/** The idle lease these cases are written against — the very default that abandoned the samples. */
const LEASE_IDLE_MS = 120_000;

/** The structured request ceiling, restated from ./executor as the contract (S-4a's finite leg). */
const REQUEST_MAX_MS = 600_000;

/** The `why` the row carries when the ceiling, not the sweep, stopped the run. */
const END_DEADLINE = 'abandoned — its provider request outlived the request-liveness ceiling (S-4a)';

/**
 * A structured run on a held provider: the fixture, the request count, and the fake clock, with the
 * environment's own timer baseline captured so "no handle leaked" is an exact relative assertion
 * rather than an absolute count of whatever else the environment happens to have armed.
 */
function livenessRig(options: { threadLog?: boolean } = {}) {
    const rig = samplingRig();
    const held = heldProvider();
    const executor = new RunExecutor({
        store: rig.store,
        runtime: rig.runtime,
        chat: held.client,
        defaultModel: 'gpt-5'
    });

    return { ...rig, ...held, executor, timers: vi.getTimerCount() };
}

describe('RunExecutor — the lease across a slow structured turn (S-4a, D-36)', () => {
    it('beats the lease through a turn slower than the idle window, so a slow sample still completes (S-4a)', async () => {
        vi.useFakeTimers();

        try {
            const { store, story, runtime, sampleItem, executor, requests, release, timers } = livenessRig();
            const compiled = compileSamplePrompt(store, story.id, { round: 1 });

            expect(DEFAULT_LEASE_IDLE_MS).toBe(LEASE_IDLE_MS);

            const running = executor.execute(sampleItem);

            // R1, first clause: `execute` dispatches synchronously up to its first `await`, so the
            // request has already left and the lease has already been beaten — the clock starts at
            // the REQUEST, not at the `working` write. The fake clock is frozen until advanced, which
            // makes "the beat just happened" an exact string comparison.
            expect(requests.length).toBe(1);
            expect(store.runs.require('run_0').updated_at).toBe(new Date(Date.now()).toISOString());
            // One interval armed for the request, and nothing else.
            expect(vi.getTimerCount()).toBe(timers + 1);

            // 130s of waiting — past the 120s that killed the samples — sampled once per minute and
            // once again 10s on. `lapsedRuns` is the sweep's OWN predicate (loop/records.ts:1599: a
            // live row whose `updated_at` is older than `leaseIdleMs`), so this is the real claim
            // "the sweep would not have touched this run", not a paraphrase of it.
            const silences: number[] = [];

            for (let minute = 0; minute < 3; minute += 1) {
                await vi.advanceTimersByTimeAsync(30_000);
                silences.push(Date.now() - Date.parse(store.runs.require('run_0').updated_at));
                expect(lapsedRuns(store, Date.now(), DEFAULT_LEASE_IDLE_MS)).toEqual([]);
            }

            await vi.advanceTimersByTimeAsync(40_000);
            silences.push(Date.now() - Date.parse(store.runs.require('run_0').updated_at));

            // The row is never silent for more than one beat cadence (30s). Before the fix every
            // entry reads [30000, 60000, 90000, 130000] — the last one over the lease, which is
            // exactly the abandonment the Author watched.
            expect(silences).toEqual([0, 0, 0, 10_000]);
            expect(store.runs.require('run_0').updated_at).toBe(new Date(Date.now() - 10_000).toISOString());
            expect(store.runs.require('run_0').state).toBe('working');

            // R2: the request that crossed the threshold is still eligible to finish, and it finishes
            // with the same exact result a fast turn produces.
            release({
                message: msg({ content: JSON.stringify(SAMPLE_ANSWER) }),
                usage: { input: 40, output: 10, cached_input: 5 }
            });

            const result = await running;

            expect(result).toEqual({
                runId: 'run_0',
                ended: 'completed',
                no_op: false,
                tokens: 50,
                toolsCalled: [],
                structured: SAMPLE_ANSWER,
                promptHash: compiled.hash,
                usage: { input: 40, output: 10, cached_input: 5 }
            });

            // The journal says the whole story: spawn, work, ONE beat per cadence (t=0 plus the four
            // 30s ticks inside 130s), then teardown. No write is missing and none is extra.
            expect(stateSteps(store)).toEqual([
                'create:spawning',
                'update:working',
                'update:',
                'update:',
                'update:',
                'update:',
                'update:',
                'update:torn_down'
            ]);
            // R1, second clause: completion cleared the interval — nothing is armed for a run that
            // already has its answer.
            expect(vi.getTimerCount()).toBe(timers);
        } finally {
            vi.useRealTimers();
        }
    });

    it('bounds a provider request that never answers, and abandons the run with its own cause (S-4a, R3)', async () => {
        vi.useFakeTimers();

        try {
            const { store, runtime, sampleItem, executor, requests, timers } = livenessRig();

            const running = executor.execute(sampleItem);
            const t0 = Date.now();

            // 599s in: still believed alive. The last beat landed at 570s, so the row is 29s old —
            // inside the lease right up to the ceiling, which is the point of the beat.
            await vi.advanceTimersByTimeAsync(599_000);

            expect(Date.now() - Date.parse(store.runs.require('run_0').updated_at)).toBe(29_000);
            expect(lapsedRuns(store, Date.now(), DEFAULT_LEASE_IDLE_MS)).toEqual([]);
            expect(store.runs.require('run_0').state).toBe('working');

            // The 600s tick: the ceiling, not the sweep, stops the run.
            await vi.advanceTimersByTimeAsync(1_000);

            const result = await running;

            // The RunResult the sweep reads: a stopped run, not a provider fault — the request never
            // answered, so nothing was spent and nothing was produced.
            expect(result).toEqual({ runId: 'run_0', ended: 'killed', no_op: true, tokens: 0, toolsCalled: [] });

            const row = store.runs.require('run_0');

            expect({
                state: row.state,
                ended_at: row.ended_at,
                end_reason: row.end_reason,
                tokens: row.tokens,
                no_op: row.no_op
            }).toEqual({
                state: 'abandoned',
                // The fake clock is frozen at the ceiling instant once that tick has run, so this is
                // the exact time the request was given up on: t0 + 600000ms, no drift.
                ended_at: new Date(t0 + REQUEST_MAX_MS).toISOString(),
                // The worker-health distinction: NOT the sweep's "lease lapsed" sentence. A reader can
                // tell "the row went silent" from "the answer never came".
                end_reason: END_DEADLINE,
                tokens: 0,
                no_op: true
            });

            // The transport is released, even for an adapter that ignores it: the request's own signal
            // is aborted, so the pinned client's `fetch` is cancelled and the socket is not leaked.
            expect(requests[0].signal?.aborted).toBe(true);
            // Bounded, twice over: ONE provider request (the ceiling ends the run, so the schema-repair
            // turn is never spent), and a beat count capped at REQUEST_MAX_MS / 30s.
            expect(requests.length).toBe(1);
            expect(stateSteps(store)).toEqual([
                'create:spawning',
                'update:working',
                // t=0 plus the nineteen beats that fit before the ceiling tick — 20 empty patches, and
                // the 21st beat never happens.
                ...Array.from({ length: 20 }, () => 'update:'),
                'update:abandoned'
            ]);
            // The interval is gone: a hung provider Promise cannot keep beating the lease forever.
            expect(vi.getTimerCount()).toBe(timers);

            // And a closed run stays closed: two more ceiling windows of dead air change nothing.
            await vi.advanceTimersByTimeAsync(REQUEST_MAX_MS * 2);

            expect(stateSteps(store).filter((step) => step !== 'update:')).toEqual([
                'create:spawning',
                'update:working',
                'update:abandoned'
            ]);
            expect(vi.getTimerCount()).toBe(timers);
        } finally {
            vi.useRealTimers();
        }
    });

    it('stops beating on the tick the Author pulls the cord, and keeps the Author’s cause (P8, S-3, R1)', async () => {
        vi.useFakeTimers();

        try {
            const { store, runtime, sampleItem, executor, requests, timers } = livenessRig();

            const running = executor.execute(sampleItem);

            // Two beats in: t=0 and t=30s.
            await vi.advanceTimersByTimeAsync(45_000);
            expect(store.runs.require('run_0').state).toBe('working');

            executor.kill('run_0');

            // The abort settles the run on the spot — the provider promise never answers at all, and
            // the executor does not wait for the ceiling to notice the stop.
            const result = await running;

            expect(result).toEqual({ runId: 'run_0', ended: 'killed', no_op: true, tokens: 0, toolsCalled: [] });

            const row = store.runs.require('run_0');

            expect({ state: row.state, end_reason: row.end_reason }).toEqual({
                state: 'abandoned',
                // The Author's sentence, never the deadline's: a stop that arrived first owns the row,
                // so the UI cannot blame a timeout for a cord the Author pulled (P8).
                end_reason: 'killed — the Author pulled the cord (P8, U-7)'
            });
            expect(requests[0].signal?.aborted).toBe(true);
            // Nothing left armed, and no beat spent after the cord.
            expect(vi.getTimerCount()).toBe(timers);
            expect(stateSteps(store)).toEqual([
                'create:spawning',
                'update:working',
                'update:',
                'update:',
                'update:abandoned'
            ]);

            await vi.advanceTimersByTimeAsync(REQUEST_MAX_MS);

            // The ceiling cannot re-open a closed row or overwrite its cause.
            expect(store.runs.require('run_0').end_reason).toBe('killed — the Author pulled the cord (P8, U-7)');
            expect(vi.getTimerCount()).toBe(timers);
        } finally {
            vi.useRealTimers();
        }
    });

    it('leaves exactly one beat and no armed timer when the answer is immediate (mock fast path unchanged, R2)', async () => {
        vi.useFakeTimers();

        try {
            // The fast path the whole suite already relies on: a mock that answers at once must not
            // grow a second write, a second request or a live interval just because liveness was added.
            const ok = livenessRig();
            const compiled = compileSamplePrompt(ok.store, ok.story.id, { round: 1 });

            const fastRunning = ok.executor.execute(ok.sampleItem);

            expect(ok.requests.length).toBe(1);
            expect(vi.getTimerCount()).toBe(ok.timers + 1);

            ok.release({
                message: msg({ content: JSON.stringify(SAMPLE_ANSWER) }),
                usage: { input: 40, output: 10, cached_input: 5 }
            });

            const fast = await fastRunning;

            expect(fast).toEqual({
                runId: 'run_0',
                ended: 'completed',
                no_op: false,
                tokens: 50,
                toolsCalled: [],
                structured: SAMPLE_ANSWER,
                promptHash: compiled.hash,
                usage: { input: 40, output: 10, cached_input: 5 }
            });
            // ONE beat — the pre-request one — and no interval survives an immediate answer.
            expect(stateSteps(ok.store)).toEqual([
                'create:spawning',
                'update:working',
                'update:',
                'update:torn_down'
            ]);
            expect(vi.getTimerCount()).toBe(ok.timers);
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps a provider fault a provider fault through the liveness wrapper (S-3, R5)', async () => {
        vi.useFakeTimers();

        try {
            const timers = vi.getTimerCount();
            const { store, runtime, sampleItem } = samplingRig();
            const { client, requests } = record(() => {
                throw new LlmError(503, 'upstream asleep', 'the provider returned 503');
            });

            const result = await new RunExecutor({ store, runtime, chat: client, defaultModel: 'gpt-5' }).execute(
                sampleItem
            );

            // The same sentences the tool-run fault case asserts, and the same one request: the wrapper
            // changed WHEN the lease is beaten, never what an error means.
            expect(result).toEqual({
                runId: 'run_0',
                ended: 'failed',
                no_op: true,
                tokens: 0,
                toolsCalled: [],
                error: 'LlmError: the provider returned 503'
            });
            expect({
                state: store.runs.require('run_0').state,
                end_reason: store.runs.require('run_0').end_reason
            }).toEqual({
                state: 'failed',
                end_reason: 'failed — LLM provider fault: LlmError: the provider returned 503'
            });
            expect(requests.length).toBe(1);
            expect(stateSteps(store)).toEqual([
                'create:spawning',
                'update:working',
                'update:',
                'update:failed'
            ]);
            // The fault cleared the interval too: an error is an ending (R1).
            expect(vi.getTimerCount()).toBe(timers);
        } finally {
            vi.useRealTimers();
        }
    });
});
