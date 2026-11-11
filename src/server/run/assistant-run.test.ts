// U-1e (author §7 / §8.6): the assistant run is the one run kind with NO web row in §7, so its
// session must never be OFFERED `searchWeb`/`fetchPage` — the empty cell has to be real for the
// model, not only enforced at call time (T-1a keeps the call-time refusal; this is the "do not
// offer what you will refuse" half).
//
// The filter is asserted where it is observable: `ChatRequest.tools` on the model's first turn
// (`runAgentLoop` sends `spec.tools` verbatim). A runtime that DECLARES the web pair is the
// interesting case, so both are injected; the crew run is the control, otherwise a filter that
// dropped the web tools for every kind would pass.
import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '../llm';
import { MockChatClient, msg } from '../llm/mock';
import { Store } from '../store';
import { MockToolRuntime, seedDigest, seedGoal, seedStory, seedTemplate } from './mock';
import { RunExecutor } from './executor';
import { RUN_WEB_TOOLS, toolsForRunKind } from './catalogue';
import type { WorkItem } from './types';

/**
 * The §8.6 harness: an `assistant` template whose role is a writer-kind role (the assistant
 * writes the artifact it is aimed at), plus the two web tools the mock runtime does NOT declare
 * by default — injected here so their removal is something the test can see.
 */
function rig() {
    const store = Store.empty();
    const story = seedStory(store);

    seedGoal(store, story.id);
    seedDigest(store, story.id, 'The keeper learns the light was never the point.');

    const template = seedTemplate(store, {
        name: 'assistant',
        roles: [{ name: 'assistant', kind: 'writer', prompt: 'You reshape the artifact the Author aimed you at.' }]
    });

    const runtime = new MockToolRuntime(store, story.id, {
        searchWeb: () => ({ ok: true, data: { hits: [] } }),
        fetchPage: () => ({ ok: true, data: { text: 'fetched' } })
    });

    return { store, story, template, runtime };
}

/** A recording client — one turn, no tool call, so the run ends at §9's natural end. */
function recorder() {
    const requests: ChatRequest[] = [];
    const client = new MockChatClient((request) => {
        requests.push({ ...request, messages: request.messages.map((message) => ({ ...message })) });

        return { message: msg({ content: 'The Summary now carries the promise.' }) };
    });

    return { client, requests };
}

/** The tool names the model was actually handed, in the order it was handed them. */
const offeredNames = (request: ChatRequest): string[] => (request.tools ?? []).map((tool) => tool.function.name);

/**
 * The mock runtime's whole declared catalogue (./mock's `defaultTools` plus the injected web pair),
 * alphabetical because `toolNames()` sorts — the exact surface a dispatched run is offered.
 */
const CREW_SURFACE = [
    'approveFinding',
    'createTask',
    'delegate',
    'describeTool',
    'editChapter',
    'editSummary',
    'fetchPage',
    'listIdeas',
    'listRevisions',
    'listTasks',
    'listTools',
    'markChapterDone',
    'markUnverifiable',
    'proposeIdea',
    'raiseFinding',
    'readChapter',
    'readDigest',
    'readFindings',
    'readGoals',
    'readPlotline',
    'readSeed',
    'readSummary',
    'readVerdicts',
    'rejectAll',
    'requestAuthor',
    'requestMerge',
    'searchWeb',
    'selectRevision',
    'submitVerdict',
    'verifyFinding',
    'verifyIdea'
];

/** §7's assistant row: the same surface with `fetchPage` and `searchWeb` gone — everything else intact. */
const ASSISTANT_SURFACE = CREW_SURFACE.filter((name) => name !== 'fetchPage' && name !== 'searchWeb');

const itemFor = (storyId: string, templateRef: string, over: Partial<WorkItem>): WorkItem => ({
    id: 'work_1',
    storyId,
    kind: 'assistant',
    templateRef,
    roleName: 'assistant',
    ...over
});

describe('U-1e — the assistant run is never offered the web tools (§7, §8.6)', () => {
    it('catalogue: an assistant run gets the declared list with BOTH web tools removed', () => {
        const declared = ['compareRevisions', 'editSummary', 'fetchPage', 'readSeed', 'searchWeb', 'writeSummary'];
        const schemas = declared.map((name) => ({ type: 'function' as const, function: { name } }));

        // Exact list and exact order — the filter subtracts, it does not re-rank (T-6a).
        expect(toolsForRunKind(schemas, 'assistant').map((schema) => schema.function.name)).toEqual([
            'compareRevisions',
            'editSummary',
            'readSeed',
            'writeSummary'
        ]);
    });

    it('catalogue: every other kind keeps the whole declared list, web tools included (T-6a)', () => {
        const declared = ['compareRevisions', 'fetchPage', 'searchWeb', 'writeSummary'];
        const schemas = declared.map((name) => ({ type: 'function' as const, function: { name } }));

        for (const kind of ['write_unit', 'select', 'check', 'digest', 'plan']) {
            expect(toolsForRunKind(schemas, kind).map((schema) => schema.function.name)).toEqual(declared);
        }

        // The set being removed is exactly §8.5's two tools — nothing else may be hidden.
        expect(RUN_WEB_TOOLS).toEqual(['searchWeb', 'fetchPage']);
    });

    it('the assistant run model faces never names searchWeb or fetchPage', async () => {
        const { store, story, template, runtime } = rig();
        const { client, requests } = recorder();

        await new RunExecutor({ store, runtime, chat: client, defaultModel: 'gpt-5' }).execute(
            itemFor(story.id, template.name, {})
        );

        expect(requests).toHaveLength(1);

        // The exact surface: the mock runtime's whole declared catalogue (./mock's `defaultTools`,
        // alphabetical) minus the web pair, in the runtime's own declaration order — proof the list
        // is subtracted rather than rebuilt, and that nothing else went with the pair.
        expect(offeredNames(requests[0])).toEqual(ASSISTANT_SURFACE);
        // Sanity: the pair really was declared by the runtime, so the assertion above is a
        // subtraction and not an accident of an empty catalogue.
        expect(runtime.toolNames()).toEqual(CREW_SURFACE);
    });

    it('a dispatched crew run over the SAME runtime is offered both web tools — the control', async () => {
        const { store, story, template, runtime } = rig();
        const { client, requests } = recorder();

        await new RunExecutor({ store, runtime, chat: client, defaultModel: 'gpt-5' }).execute(
            itemFor(story.id, template.name, { kind: 'write_unit', roleName: 'assistant' })
        );

        expect(requests).toHaveLength(1);
        // The runtime declares the web pair, and the crew run gets exactly that surface.
        expect(runtime.toolNames()).toEqual(CREW_SURFACE);
        expect(offeredNames(requests[0])).toEqual(CREW_SURFACE);
        expect(offeredNames(requests[0])).toContain('searchWeb');
        expect(offeredNames(requests[0])).toContain('fetchPage');
    });
});
