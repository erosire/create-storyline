// W5 acceptance for the run layer's spawner half: S-1..S-7 driven end to end over the REAL store,
// T3's pinned tool contract (the ./mock test double) and the package's mock provider.
//
// WHY EVERY NUMBER HERE IS EXACT: §4.13's run row is the artifact the Author reads (D-18, U-7) and
// `tokens`/`no_op`/`end_reason` are inputs to the loop's own decisions (L-15, S-4, S-6). A range
// assertion would let a run row drift and still pass, so each expectation below is the value the
// spec or the seeded state forces — including the token totals, which the scripted `usage` makes
// plain arithmetic rather than a guess.
import { describe, expect, it } from 'vitest';
import type { Chapter, Run } from '../../shared/types';
import type { ChatRequest, ChatResponse } from '../llm';
import { LlmError } from '../llm';
import { calls, msg } from '../llm/mock';
import { MockChatClient, type MockHandler } from '../llm/mock';
import { Store } from '../store';
import { buildBrief } from './brief';
import { resolveHarness } from './harness';
import { RunExecutor } from './executor';
import {
    MockToolRuntime,
    seedChapter,
    seedDigest,
    seedGoal,
    seedPlotline,
    seedRevision,
    seedStory,
    seedTemplate
} from './mock';
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
                                    chapter_id: 'chapter_1',
                                    summary: 'Maren reads the map against the water',
                                    expects: [{ id: 'chapter_1', rev: 1 }],
                                    why: 'the chapter must pay off the 1911 map'
                                }
                            }
                        ])
                    }),
                    usage: { input: 120, output: 45 }
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
                    usage: { input: 90, output: 30 }
                };

            // Turn 3: no tool call — §9's natural end.
            return {
                message: msg({ content: 'the chapter carries the promise through to the cost' }),
                usage: { input: 60, output: 80 }
            };
        });

        const result = await new RunExecutor({ store, runtime, chat: client, defaultModel: 'gpt-5' }).execute(item);

        // The RunResult the loop engine reads (T6's pinned shape).
        expect(result).toEqual({
            runId: 'run_1',
            ended: 'completed',
            no_op: false, // it wrote AND reported, so S-4's no-op turn did not happen
            tokens: 425, // 165 + 120 + 140 — the sum of the scripted usage across all three turns (S-6)
            toolsCalled: ['editChapter', 'requestAuthor']
        });

        // §4.13's row, exactly. S-1: one row for one Work Item, and `session_ref` names the session
        // that no other run will ever reuse.
        expect(rowOf(store, 'run_1')).toEqual({
            id: 'run_1',
            story_id: 'story_1',
            work_item_ref: 'work_1',
            template_ref: 'writer-prose',
            role: 'writer',
            kind: 'work',
            session_ref: 'sess_run_1',
            state: 'torn_down', // S-3: teardown is unconditional
            tokens: 425,
            no_op: false,
            end_reason: END_COMPLETED, // S-3: the row records WHY it ended
            delegated: [], // S-7: nothing was fanned out, so nothing nests here
            brief_hash: brief.hash
        });

        // D-18: the row existed from before the first token, so both timestamps are filled in.
        const row = store.runs.get('run_1')!;
        expect(typeof row.started_at).toBe('string');
        expect(typeof row.ended_at).toBe('string');
        expect(row.rev).toBe(6); // create, working, two heartbeats (S-4a), reporting, teardown (S-3)

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

        // S-4a: the lease is `runs.updated_at`, refreshed once per tool call — here that is exactly
        // two empty patches between `working` and `reporting`, and nothing else (E-0: no timeout,
        // so the heartbeat is the only guard this layer writes).
        expect(stateSteps(store)).toEqual([
            'create:spawning', // D-18: the row exists before the brief is even assembled
            'update:working', // S-2: brief assembled and hashed
            'update:', // heartbeat after editChapter
            'update:', // heartbeat after requestAuthor
            'update:reporting', // §9's report step
            'update:torn_down' // S-3's unconditional close
        ]);
        // S-3's teardown is not a separate journal verb in this store (P3's vocabulary is
        // create/update/delete), so the row's LAST write is the evidence it closed, and it names the
        // close the way P11 wants a reason attached.
        expect(lastRunEvent(store).attribution).toEqual({
            run_ref: 'run_1',
            why: `teardown — ${END_COMPLETED} (S-3)`
        });

        // P11: the write is the run's, not the Author's — the attribution is what D-20a's audit reads.
        // (Filtered to the run's own op: the seed's `create` on the same row is the Author's.)
        expect(
            store.journal
                .filter((event) => event.collection === 'chapters' && event.op === 'update')
                .map((event) => event.attribution)
        ).toEqual([{ run_ref: 'run_1', why: 'the chapter must pay off the 1911 map' }]);

        // And the store proves the write landed, with the rev the next `expects` needs (T-8).
        expect(store.chapters.get('chapter_1')).toMatchObject({
            rev: 2,
            summary: 'Maren reads the map against the water'
        });
        expect(
            store.tasks.list().map((task) => ({ id: task.id, kind: task.kind, title: task.title, state: task.state }))
        ).toEqual([
            { id: 'task_1', kind: 'author_question', title: 'does the valley flood on purpose?', state: 'blocked' }
        ]);
    });

    it('counts a run that reported nothing as a no-op turn, and never visits `reporting` (S-4)', async () => {
        const { store, runtime, item } = rig();
        const { client } = record(() => ({
            // The model stopped without calling a report tool — S-4's bug-in-a-brief case, measured
            // rather than prevented.
            message: msg({ content: 'the chapter is fine as it is' }),
            usage: { input: 50, output: 10 }
        }));

        const result = await new RunExecutor({ store, runtime, chat: client, defaultModel: 'gpt-5' }).execute(item);

        expect(result).toEqual({ runId: 'run_1', ended: 'completed', no_op: true, tokens: 60, toolsCalled: [] });
        expect(rowOf(store, 'run_1')).toMatchObject({
            state: 'torn_down',
            no_op: true,
            tokens: 60,
            end_reason: END_COMPLETED
        });
        // No report tool executed, so §9's `reporting` step never appears on the row.
        expect(stateSteps(store)).toEqual(['create:spawning', 'update:working', 'update:torn_down']);
    });

    it('moves the row to `reporting` while the report commit is still the next step (§9, U-7)', async () => {
        const { store, item } = rig();

        // The observation seam is a tool of our own: the mock runtime takes an override bag, and this
        // one reads the row back mid-run, which is exactly what the crew panel does (U-7).
        const seen: string[] = [];
        const runtime = new MockToolRuntime(store, 'story_1', {
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
        expect(rowOf(store, 'run_1')).toMatchObject({ state: 'torn_down', no_op: false });
        expect(stateSteps(store)).toEqual([
            'create:spawning',
            'update:working',
            'update:',
            'update:reporting',
            'update:',
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
                                chapter_id: 'chapter_1',
                                summary: 'half-written',
                                expects: [{ id: 'chapter_1', rev: 1 }]
                            }
                        }
                    ])
                }),
                usage: { input: 50, output: 25 }
            };
        });

        const executor = new RunExecutor({ store, runtime, chat: client, defaultModel: 'gpt-5' });
        const running = executor.execute(item);

        // The row and the dial happen in the synchronous prefix, so the Author has a Stop button
        // before the first token — D-18's whole point.
        expect(client.callCount).toBe(1);
        expect(store.runs.get('run_1')!.state).toBe('working');

        executor.kill('run_1');
        executor.kill('run_does_not_exist'); // a kill for a run this instance does not own is a no-op
        openGate();

        const result = await running;

        expect(result).toEqual({
            runId: 'run_1',
            ended: 'killed',
            no_op: true,
            tokens: 75,
            toolsCalled: ['editChapter']
        });

        const row = store.runs.get('run_1')!;
        expect(rowOf(store, 'run_1')).toEqual({
            id: 'run_1',
            story_id: 'story_1',
            work_item_ref: 'work_1',
            template_ref: 'writer-prose',
            role: 'writer',
            kind: 'work',
            // S-3's "no orphan sessions": a killed run keeps the session it wrote, because the Author
            // reads what the run got through. Nothing here deletes it.
            session_ref: 'sess_run_1',
            state: 'abandoned', // S-4a/L-3's terminal state; the row still closed (S-3)
            tokens: 75,
            no_op: true, // it never reached a report tool (S-4)
            end_reason: 'killed — the Author pulled the cord (P8, U-7)',
            delegated: [],
            brief_hash: brief.hash
        });
        expect(row.brief_hash).toMatch(/^[0-9a-f]{64}$/);

        // D-11: stopping a run is a stop, not a rewind — the events that happened stay. The turn the
        // Author interrupted still wrote, because the tool call had already been issued.
        expect(stateSteps(store)).toEqual(['create:spawning', 'update:working', 'update:', 'update:abandoned']);
        // S-3 has no exception for a stop: the row closed through the same teardown write, named on it.
        expect(lastRunEvent(store).attribution).toEqual({
            run_ref: 'run_1',
            why: 'teardown — killed — the Author pulled the cord (P8, U-7) (S-3)'
        });
        expect(store.chapters.get('chapter_1')).toMatchObject({ rev: 2, summary: 'half-written' });
    });

    it('hands a rejected write straight back to the model with the current values, and lets it re-apply (T-4)', async () => {
        const { store, runtime, item } = rig();

        // The Author edits the same chapter first (D-20a: a direct write, no proposal), so the rev the
        // run's brief carried is already stale when its write arrives.
        store.chapters.update(
            'chapter_1',
            { summary: 'the Author rewrote the ridge line' },
            { run_ref: null, author: true, why: 'the Author edited while the run was reading (D-20a)' },
            [{ id: 'chapter_1', rev: 1 }]
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
                                    chapter_id: 'chapter_1',
                                    summary: "the run's line",
                                    expects: [{ id: 'chapter_1', rev: 1 }],
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
                                    chapter_id: 'chapter_1',
                                    summary: 'the run reconciled with the Author line',
                                    expects: [{ id: 'chapter_1', rev: 2 }],
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
            runId: 'run_1',
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
                id: 'chapter_1',
                record: expect.objectContaining({ rev: 2, summary: 'the Author rewrote the ridge line' })
            }
        ]);
        expect(payload.message).toContain('chapter_1 is at rev 2, the caller expected rev 1');

        // And the run finished with the write applied over the Author's, at the rev T-8 reports.
        expect(store.chapters.get('chapter_1')).toMatchObject({
            rev: 3,
            summary: 'the run reconciled with the Author line'
        });
        expect(rowOf(store, 'run_1')).toMatchObject({ state: 'torn_down', no_op: false, end_reason: END_COMPLETED });
    });

    it('closes the row when the provider faults, and names the fault on it (S-3)', async () => {
        const { store, runtime, item } = rig();
        const { client } = record(() => {
            throw new LlmError(503, 'upstream asleep', 'the provider returned 503');
        });

        const result = await new RunExecutor({ store, runtime, chat: client, defaultModel: 'gpt-5' }).execute(item);

        expect(result).toEqual({
            runId: 'run_1',
            ended: 'failed',
            no_op: true,
            tokens: 0,
            toolsCalled: [],
            error: 'LlmError: the provider returned 503'
        });
        expect(rowOf(store, 'run_1')).toMatchObject({
            // The terminal STATE names the outcome (S-4a/L-3 read `failed` and `abandoned` as the two
            // ways a run stops being its own); S-3's teardown is the write that closes it either way.
            state: 'failed',
            // S-3: the row records why it ended, and the transport's own sentence is the most useful
            // thing it can carry for a provider fault.
            end_reason: 'failed — LLM provider fault: LlmError: the provider returned 503',
            no_op: true
        });
        expect(lastRunEvent(store).attribution).toEqual({
            run_ref: 'run_1',
            why: 'teardown — failed — LLM provider fault: LlmError: the provider returned 503 (S-3)'
        });
        // The row closed even though the loop threw before its first tool call.
        expect(stateSteps(store)).toEqual(['create:spawning', 'update:working', 'update:failed']);
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
                    usage: { input: 100, output: 20 }
                };
            if (isSubContext && toolResults === 0)
                return {
                    message: msg({
                        toolCalls: calls([
                            {
                                name: 'raiseFinding',
                                args: {
                                    criterion_ref: 'C-4',
                                    target_ref: 'chapter_1',
                                    title: 'the 1911 map is set up and never paid off',
                                    detail: 'sec_1 puts the map in her hand; nothing answers it',
                                    evidence: 'chapter_1 sec_1',
                                    cost: 'major',
                                    why: 'D-15: the failure needs an evidence line'
                                }
                            }
                        ])
                    }),
                    usage: { input: 70, output: 30 }
                };
            if (isSubContext)
                return {
                    message: msg({ content: 'the map is set up and never paid off in chapter_1' }),
                    usage: { input: 40, output: 50 }
                };

            return {
                message: msg({ content: 'the sub-context filed it; the run reports' }),
                usage: { input: 30, output: 25 }
            };
        });

        const result = await new RunExecutor({ store, runtime, chat: client, defaultModel: 'gpt-5' }).execute(item);

        // S-6: the run's total is its internals' total — parent 175 + sub-context 190.
        expect(result).toEqual({
            runId: 'run_1',
            ended: 'completed',
            no_op: false,
            tokens: 365,
            toolsCalled: ['delegate', 'raiseFinding']
        });

        // S-7: the sub-context is NOT a Work Item and gets no row of its own — the Author's unit of
        // attention is the dispatched run, and the sub-context shows nested under it.
        expect(store.runs.list().map((row) => row.id)).toEqual(['run_1']);

        const row = store.runs.get('run_1')!;
        expect(row.delegated).toEqual([
            {
                role: 'researcher',
                task: 'what would break the 1911 map payoff?',
                summary: 'the map is set up and never paid off in chapter_1',
                tokens: 190
            }
        ]);
        expect(rowOf(store, 'run_1')).toMatchObject({
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
            data: { summary: 'the map is set up and never paid off in chapter_1' }
        });

        // T-2b: it wrote for real, under the PARENT's run identity — a phantom run id would break the
        // audit trail (P11).
        expect(
            store.findings
                .list()
                .map((finding) => ({ id: finding.id, criterion_ref: finding.criterion_ref, cost: finding.cost }))
        ).toEqual([{ id: 'finding_1', criterion_ref: 'C-4', cost: 'major' }]);
        expect(
            store.journal.filter((event) => event.collection === 'findings').map((event) => event.attribution.run_ref)
        ).toEqual(['run_1']);
    });

    it('refuses a delegation the template forbids, and teaches the model why (D-17e, T-1a)', async () => {
        // The built-in `reader-genre` forbids fan-out with an explicit empty list; an absent field
        // means undeclared and is allowed.
        const store = Store.empty();
        const story = seedStory(store);

        seedGoal(store, story.id);
        seedDigest(store, story.id, 'the ridge, the map, the water');
        seedPlotline(store, story.id);
        const chapter = seedChapter(store, story.id);

        seedTemplate(store, {
            name: 'reader-genre',
            roles: [
                {
                    name: 'reader',
                    kind: 'reader',
                    prompt: 'You read for what the genre promises and propose, never edit (D-26, P10).'
                }
            ],
            delegation: []
        });

        const item: WorkItem = {
            id: 'work_1',
            storyId: story.id,
            kind: 'check_unit',
            templateRef: 'reader-genre',
            roleName: 'reader',
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
                    usage: { input: 40, output: 10 }
                };

            return { message: msg({ content: 'I will judge it myself then' }), usage: { input: 20, output: 15 } };
        });

        const result = await new RunExecutor({ store, runtime, chat: client, defaultModel: 'gpt-5' }).execute(item);

        expect(result).toEqual({
            runId: 'run_1',
            ended: 'completed',
            no_op: true,
            tokens: 85,
            toolsCalled: ['delegate']
        });
        expect(store.runs.list().length).toBe(1);
        expect(store.runs.get('run_1')!.delegated).toEqual([]);

        // The refusal is a teaching message inside the run (T-1a): the rule id, the reason, and the
        // list the model may actually use.
        expect(JSON.parse(requests[1].messages.filter((message) => message.role === 'tool')[0].content)).toEqual({
            ok: false,
            refused: 'D-17e',
            message:
                'template "reader-genre" does not name "researcher" in its delegation list (D-17e) — delegate to nobody, or do the reasoning yourself'
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
                const revisionId = index === 3 ? 'revision_2' : 'revision_1';

                return {
                    message: msg({
                        content: `agent ${index} reads the drafts`,
                        toolCalls: calls([
                            {
                                name: 'selectRevision',
                                args: {
                                    unit_ref: 'chapter_1',
                                    revision_id: revisionId,
                                    selection_note: `agent ${index} picks ${revisionId === 'revision_1' ? 'the map paid off on the page' : 'the bell under the water'}`,
                                    expects: [{ id: revisionId, rev: 1 }],
                                    why: 'the must_happen rule (T-2a)'
                                }
                            }
                        ])
                    }),
                    usage: { input: 100, output: 40 }
                };
            }

            return {
                message: msg({ content: `agent ${agent === null ? '?' : agent[1]} chose its draft and reported` }),
                usage: { input: 100, output: 40 }
            };
        });

        const result = await new RunExecutor({ store, runtime, chat: client, defaultModel: 'gpt-5' }).execute(item);

        // D-38: the loop receives exactly ONE permission-bearing answer, so S-4 sees a report and the
        // run's `toolsCalled` lists one write.
        expect(result).toEqual({
            runId: 'run_1',
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
        ).toEqual([{ name: 'selectRevision', runRef: 'run_1', revision_id: 'revision_1' }]);

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
                id: 'revision_1',
                state: 'selected',
                selection_note:
                    'agent 1 picks the map paid off on the page | 2 of 3 preferred revision_1; 1 of 3 preferred revision_2; selected revision_1 on majority 2 of 3'
            }
        ]);
        expect(store.chapters.get('chapter_1')!.current_revision).toBe('revision_1');

        const row = store.runs.get('run_1')!;
        // S-7 / U-8d: the three agents nest on the row (no extra rows), and the row marks that this
        // run's internals disagreed, because a hidden disagreement is the one thing untunable (D-38).
        expect(row.delegated.slice().sort((left, right) => left.role.localeCompare(right.role))).toEqual([
            {
                role: 'editor#agent_1',
                task: 'panel agent of select for chapter chapter_1',
                summary: 'agent 1 chose its draft and reported',
                tokens: 280
            },
            {
                role: 'editor#agent_2',
                task: 'panel agent of select for chapter chapter_1',
                summary: 'agent 2 chose its draft and reported',
                tokens: 280
            },
            {
                role: 'editor#agent_3',
                task: 'panel agent of select for chapter chapter_1',
                summary: 'agent 3 chose its draft and reported',
                tokens: 280
            }
        ]);
        expect(store.runs.list().map((entry) => entry.id)).toEqual(['run_1']);
        expect(row.tokens).toBe(840);
        expect(row.end_reason).toBe(
            `${END_COMPLETED}; panel disagreed — 2 of 3 preferred revision_1; 1 of 3 preferred revision_2; selected revision_1 on majority 2 of 3 (3 of 3 agents answered)`
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
            usage: { input: 10, output: 5 }
        }));
        const executor = new RunExecutor({ store, runtime, chat: client, defaultModel: 'gpt-5' });

        const first = await executor.execute(item);
        const second = await executor.execute(item);

        expect(first.runId).toBe('run_1');
        expect(second.runId).toBe('run_2');
        expect(second.tokens).toBe(15);

        // S-1: a run is never handed a second job, so the second dispatch is a second row with a
        // session no run will reuse.
        expect(
            store.runs
                .list()
                .map((row) => ({ id: row.id, session_ref: row.session_ref, state: row.state, tokens: row.tokens }))
        ).toEqual([
            { id: 'run_1', session_ref: 'sess_run_1', state: 'torn_down', tokens: 15 },
            { id: 'run_2', session_ref: 'sess_run_2', state: 'torn_down', tokens: 15 }
        ]);

        // S-2 / D-12a: the brief is a pure function of stored state, so two dispatches over the same
        // state hash identically — and a run's own rows never leak into it (which is why the second
        // hash still matches the pre-run assembly).
        expect(store.runs.list().map((row) => row.brief_hash)).toEqual([brief.hash, brief.hash]);
    });
});
