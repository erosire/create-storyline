// Acceptance for ./panel (D-38) and for ./catalogue's three name questions (S-4, D-38), which the
// panel is built out of.
//
// D-38 in one sentence: a role may declare `agents: N`, those N fresh agents run INSIDE one run, and
// the run answers ONCE — one report, one `selection_note`, one permission-bearing answer — while the
// split is surfaced rather than hidden ("2 of 3 preferred draft 1; selected 2 on the must_happen
// rule"). Everything below is an exact-value assertion, because the whole point of the rule is that
// the Author can read the disagreement off the record.
import { MockChatClient, calls, msg } from '../llm';
import type { AssistantMessage, ChatRequest } from '../llm';
import { Store } from '../store';
import { createTally } from './loop';
import { MockToolRuntime, seedChapter, seedDigest, seedGoal, seedRevision, seedStory, seedTemplate } from './mock';
import {
    aggregatorPrompt,
    dissentSentence,
    groupPrimaryActions,
    interceptingRuntime,
    parseAggregatorAnswer,
    runPanel
} from './panel';
import type { PanelAgent, PanelProposal, PanelSpec } from './panel';
import {
    REPORT_TOOLS,
    describeProposal,
    dissentFieldFor,
    isMutatingTool,
    isReadOnlyTool,
    isReportTool,
    primaryActionOf,
    proposalKey
} from './catalogue';
import type { RunDelegation, RoleAggregation } from '../../shared/types';

// ---------------------------------------------------------------------------
// The panel client
//
// The panel's agents run IN PARALLEL (D-38: "spawned together"; P2's blindness is the same
// property), so an index-scripted client would be asserting a scheduling order the spec never
// promises. This client answers from the agent each REQUEST belongs to: the system turn carries the
// panel preamble naming its index, and the aggregator's prompt is recognisable by its own first
// sentence. That is the only ordering the implementation is entitled to rely on.
// ---------------------------------------------------------------------------

interface PanelBehaviour {
    /** What one agent answers on its `turn`-th request (0 = its first). */
    agent: (index: number, turn: number) => AssistantMessage;
    /** The aggregator's answer, when the mode asks for one. */
    aggregator?: (request: ChatRequest) => string;
    /** Agents whose first request throws (the lost-agent paths). */
    lost?: number[];
}

function panelClient(behaviour: PanelBehaviour) {
    const requests: ChatRequest[] = [];
    const client = new MockChatClient((request) => {
        // The snapshot is REQUIRED, not tidy: ./loop pushes into ONE `messages` array per agent loop,
        // so a recorded request is an alias of that live conversation — every entry would read as the
        // agent's final transcript, and the blindness assertions below would prove nothing.
        requests.push({ ...request, messages: request.messages.map((message) => ({ ...message })) });

        const system = request.messages.find((message) => message.role === 'system')?.content ?? '';

        if (system.startsWith('You are the aggregator')) {
            if (behaviour.aggregator === undefined)
                throw new Error('an aggregator call arrived with none scripted (D-38: `majority` must not call one)');

            return { message: { content: behaviour.aggregator(request) }, usage: { input: 200, output: 30 } };
        }

        const index = Number(/You are agent (\d+) of/.exec(system)?.[1] ?? '0');
        const lost = behaviour.lost?.includes(index) === true;

        if (lost) throw new Error('provider exploded');

        const turn = request.messages.filter((message) => message.role === 'assistant').length;

        return { message: behaviour.agent(index, turn), usage: { input: 100, output: 40 } };
    });

    return { client, requests };
}

// ---------------------------------------------------------------------------
// The rig: one Story with three competing drafts, an Editor role, and the panel's spec
// ---------------------------------------------------------------------------

function rig(agents: number, aggregate: RoleAggregation) {
    const store = Store.empty();
    const story = seedStory(store);

    seedGoal(store, story.id);
    seedDigest(store, story.id, 'Three drafts of chapter 1 disagree about whether the steeple appears.');

    const chapter = seedChapter(store, story.id);
    const drafts = [
        seedRevision(store, story.id, chapter.id, 'DRAFT ONE — the steeple appears, and she lies about it.', 'run_2'),
        seedRevision(store, story.id, chapter.id, 'DRAFT TWO — the steeple is named but never seen.', 'run_3'),
        seedRevision(store, story.id, chapter.id, 'DRAFT THREE — she hears the bell under the water.', 'run_4')
    ];

    const template = seedTemplate(store, {
        name: 'editor-panel',
        selection_rules:
            'Prefer the draft that pays off the 1911 map on the page (must_happen), not the one that only names it.',
        roles: [{ name: 'editor', kind: 'editor', prompt: 'You choose between competing drafts.', agents, aggregate }]
    });

    const runtime = new MockToolRuntime(store, story.id);
    // The run's own context: the winning set executes HERE, so the write carries the dispatched
    // run's identity and permission row (D-38, T-2b, P11).
    const parentContext = runtime.createContext({
        storyId: story.id,
        runId: 'run_1',
        runRef: 'run_1',
        sessionRef: 'sess_run_1',
        templateRef: 'editor-panel',
        roleName: 'editor',
        roleKind: 'editor'
    });

    const delegated: RunDelegation[] = [];
    const executed: string[] = [];

    const spec: PanelSpec = {
        brief: 'THE BRIEF: choose one draft and say why (T-2a).',
        kickoff: 'Carry out THE JOB.',
        model: 'gpt-5',
        roleName: 'editor',
        roleKind: 'editor',
        templateRef: 'editor-panel',
        storyId: story.id,
        runId: 'run_1',
        count: agents,
        aggregate,
        selectionRules: template.selection_rules ?? '',
        jobSummary: 'panel agent of select for chapter chapter_1',
        parentContext,
        createContext: (session, hooks) => runtime.createContext(session, hooks),
        delegate: async () => ({ ok: true, summary: 'delegated answer' }),
        heartbeat: () => undefined,
        addDelegated: (entry) => delegated.push(entry),
        onExecuted: (name) => executed.push(name)
    };

    return { store, story, chapter, drafts, template, runtime, parentContext, delegated, executed, spec };
}

/** An agent that picks `revisionId` and then answers. */
function picker(revisionId: string, note: string, answer: string) {
    return (index: number, turn: number): AssistantMessage =>
        turn === 0
            ? msg({
                  toolCalls: calls([
                      {
                          name: 'selectRevision',
                          args: {
                              unit_ref: 'chapter_1',
                              revision_id: revisionId,
                              selection_note: note,
                              expects: [{ id: revisionId, rev: 1 }],
                              why: 'T-2a: the rule I applied'
                          }
                      }
                  ])
              })
            : msg({ content: answer });
}

const roleOrder = (entries: RunDelegation[]) => [...entries].sort((left, right) => left.role.localeCompare(right.role));

// ---------------------------------------------------------------------------
// The catalogue's three questions (S-4, D-38)
// ---------------------------------------------------------------------------

describe('catalogue — S-4’s report set and D-38’s proposals', () => {
    it('names S-4’s eight report tools plus the two outcomes the rest of §9 makes first-class (S-4, L-18)', () => {
        expect(REPORT_TOOLS).toEqual([
            'submitVerdict',
            'raiseFinding',
            'createTask',
            'requestAuthor',
            'proposeIdea',
            'verifyIdea',
            'verifyFinding',
            'selectRevision',
            'requestMerge',
            'rejectAll'
        ]);

        for (const name of REPORT_TOOLS) expect(isReportTool(name)).toBe(true);

        expect(isReportTool('readChapter')).toBe(false);
        expect(isReportTool('editChapter')).toBe(false);
        expect(isReportTool('delegate')).toBe(false);
    });

    it('classifies reads as reads and everything else as a proposal, with `delegate` neither (D-38, D-17e)', () => {
        // T-3b grows the catalogue, so reads are classified by NAME PREFIX: a new `readX` must not
        // silently become a proposal inside a panel.
        expect(isReadOnlyTool('readChapter')).toBe(true);
        expect(isReadOnlyTool('listIdeas')).toBe(true);
        expect(isReadOnlyTool('describeTool')).toBe(true);
        expect(isReadOnlyTool('compareRevisions')).toBe(true);
        expect(isReadOnlyTool('searchWeb')).toBe(true);
        expect(isReadOnlyTool('fetchPage')).toBe(true);
        expect(isMutatingTool('readChapter')).toBe(false);

        // The run answers `delegate` with an inner loop; the sub-context's own calls are what touch
        // the store, so it must not be recorded as a proposal.
        expect(isReadOnlyTool('delegate')).toBe(true);
        expect(isMutatingTool('delegate')).toBe(false);

        // The panel's write set: every one of these becomes a proposal.
        for (const name of [
            'selectRevision',
            'editChapter',
            'verifyFinding',
            'createTask',
            'submitVerdict',
            'markChapterDone'
        ]) {
            expect(isMutatingTool(name)).toBe(true);
        }
    });

    it('groups two agents that want the same change, ignoring revs and prose (D-38)', () => {
        const base = { unit_ref: 'chapter_1', revision_id: 'revision_2', selection_note: 'a' };

        // `expects` and `why` are volatile: two agents that want the identical change but read the
        // record at different revs hold the SAME preference, and splitting them would make every
        // panel divide by accident.
        expect(
            proposalKey('selectRevision', {
                ...base,
                selection_note: 'different prose',
                expects: [{ id: 'revision_2', rev: 4 }],
                why: 'x'
            })
        ).toBe(proposalKey('selectRevision', { ...base, expects: [{ id: 'revision_2', rev: 1 }], why: 'y' }));
        // The deciding argument is what separates two decisions.
        expect(
            proposalKey('selectRevision', { ...base, revision_id: 'revision_1' }) ===
                proposalKey('selectRevision', base)
        ).toBe(false);
        // An unknown write falls back to the stabilised payload, so it still groups.
        expect(proposalKey('editSummary', { premise: 'a', expects: [{ id: 'summary_1', rev: 1 }], why: 'q' })).toBe(
            'editSummary|{"premise":"a"}'
        );
    });

    it('takes an agent’s LAST report call as its position, and names proposals the way D-38 quotes them (D-38, L-17)', () => {
        const proposals: PanelProposal[] = [
            { tool: 'createTask', args: { title: 'tighten the opening' } },
            { tool: 'verifyFinding', args: { finding_id: 'finding_1', verdict: 'confirmed' } },
            { tool: 'submitVerdict', args: { target_ref: 'chapter_1', recommendation: 'fix' } }
        ];

        // A checker that filed a task and then submitted its verdict is reporting the VERDICT;
        // counting both would double-weight it.
        expect(primaryActionOf(proposals)).toEqual({
            tool: 'submitVerdict',
            args: { target_ref: 'chapter_1', recommendation: 'fix' }
        });
        // With no report call, the last write is the position.
        expect(primaryActionOf([proposals[0]])).toEqual(proposals[0]);
        expect(primaryActionOf([])).toBeUndefined();

        // The labels are what the dissent sentence is built from (D-38's example quotes "draft 1").
        expect(describeProposal('selectRevision', { revision_id: 'revision_2' })).toBe('revision_2');
        expect(describeProposal('rejectAll', { unit_ref: 'chapter_1' })).toBe('rejecting every draft');
        expect(describeProposal('requestMerge', { unit_ref: 'chapter_1' })).toBe('merge of chapter_1');
        expect(describeProposal('verifyFinding', { finding_id: 'finding_1', verdict: 'confirmed' })).toBe(
            'finding_1 as confirmed'
        );
        expect(describeProposal('submitVerdict', { recommendation: 'fix' })).toBe('a verdict of fix');
        expect(describeProposal('createTask', { title: 'tighten the opening' })).toBe('a task "tighten the opening"');

        // D-38 names two surfaces for the split: the selection note, and the finding's detail.
        expect(dissentFieldFor('selectRevision')).toBe('selection_note');
        expect(dissentFieldFor('verifyFinding')).toBe('detail');
        expect(dissentFieldFor('raiseFinding')).toBe('detail');
        expect(dissentFieldFor('submitVerdict')).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Grouping, the dissent sentence, the aggregator contract
// ---------------------------------------------------------------------------

describe('panel — aggregation primitives (D-38)', () => {
    const agent = (index: number, revisionId: string): PanelAgent => ({
        index,
        label: `editor#agent_${index}`,
        text: `agent ${index} answer`,
        proposals: [{ tool: 'selectRevision', args: { unit_ref: 'chapter_1', revision_id: revisionId } }],
        tokens: 280
    });

    it('groups by decision and breaks a tie by the earliest agent (D-38)', () => {
        const groups = groupPrimaryActions([agent(1, 'revision_1'), agent(2, 'revision_1'), agent(3, 'revision_2')]);

        expect(groups).toEqual([
            { key: 'selectRevision|{"revision_id":"revision_1"}', label: 'revision_1', count: 2, firstAgent: 1 },
            { key: 'selectRevision|{"revision_id":"revision_2"}', label: 'revision_2', count: 1, firstAgent: 3 }
        ]);

        // 1-1-1: most-chosen first, and equal counts resolve by the earliest agent — which is also
        // how `lead`'s declared tie-break ("prefer agent 1") behaves.
        const tied = groupPrimaryActions([agent(1, 'revision_3'), agent(2, 'revision_1'), agent(3, 'revision_2')]);

        expect(tied.map((group) => group.firstAgent)).toEqual([1, 2, 3]);
        expect(tied.map((group) => group.count)).toEqual([1, 1, 1]);
    });

    it('writes the split in D-38’s shape, and says nothing when the panel was unanimous (D-38, L-17)', () => {
        const split = groupPrimaryActions([agent(1, 'revision_1'), agent(2, 'revision_1'), agent(3, 'revision_2')]);

        expect(dissentSentence(split, split[0], 3, 'majority 2 of 3')).toBe(
            '2 of 3 preferred revision_1; 1 of 3 preferred revision_2; selected revision_1 on majority 2 of 3'
        );

        // Unanimous: no split to surface. A note that recites "3 of 3" on every selection teaches the
        // Author to skim past the ones that matter.
        const unanimous = groupPrimaryActions([agent(1, 'revision_2'), agent(2, 'revision_2'), agent(3, 'revision_2')]);

        expect(dissentSentence(unanimous, unanimous[0], 3, 'unanimity (3 of 3)')).toBe('');
        expect(dissentSentence(split, split[0], 1, 'one agent')).toBe('');
        expect(dissentSentence([], undefined, 3, 'nobody wrote')).toBe('');
    });

    it('parses the aggregator’s pick, and refuses an unusable one (D-38)', () => {
        expect(
            parseAggregatorAnswer('{"agent":2,"reason":"the must_happen rule","synthesis":"one report"}', 3)
        ).toEqual({
            agent: 2,
            reason: 'the must_happen rule',
            synthesis: 'one report'
        });
        // Prose around the object is tolerated — the aggregator is a model, not an API.
        expect(parseAggregatorAnswer('I looked at all three.\n{"agent": 3, "reason": "voice"}\nDone.', 3)).toEqual({
            agent: 3,
            reason: 'voice',
            synthesis: undefined
        });
        expect(parseAggregatorAnswer('{"agent":4,"reason":"out of range"}', 3)).toBeUndefined();
        expect(parseAggregatorAnswer('{"agent":0,"reason":"out of range"}', 3)).toBeUndefined();
        expect(parseAggregatorAnswer('they are all fine, honestly', 3)).toBeUndefined();
        expect(parseAggregatorAnswer('{"agent":"two"}', 3)).toBeUndefined();
    });

    it('briefs the aggregator on the Author’s rules and on the seam it may not write (D-17c, D-17a, L-19)', () => {
        const prompt = aggregatorPrompt(3, 'merge', 'Prefer the draft that pays off the 1911 map.');

        expect(prompt).toContain('3 fresh agents answered the same job independently');
        expect(prompt).toContain('Prefer the draft that pays off the 1911 map.');
        // A merge hands the seam to the Writer: the aggregator reports, it does not compose prose.
        expect(prompt).toContain('You may NOT compose prose');
        expect(prompt).toContain('one selection_note, one verdict set');

        // `lead` states the tie-break the contract pins, so a tie is decided by the declared rule.
        expect(aggregatorPrompt(2, 'lead', '')).toContain('prefer agent 1 (the declared tie-break)');
        expect(aggregatorPrompt(2, 'lead', '')).toContain('(none declared)');
    });
});

// ---------------------------------------------------------------------------
// The interception wrapper
// ---------------------------------------------------------------------------

describe('panel — D-38 interception (the tool layer holds no panel concept)', () => {
    it('executes reads, records writes, and tells the agent which happened', async () => {
        const store = Store.empty();
        const story = seedStory(store);

        seedChapter(store, story.id);

        const inner = new MockToolRuntime(store, story.id);
        const proposals: PanelProposal[] = [];
        const wrapped = interceptingRuntime(inner, 2, proposals);
        const context = wrapped.createContext({
            storyId: story.id,
            runId: 'run_1',
            runRef: 'run_1',
            templateRef: 'editor-panel',
            roleName: 'editor',
            roleKind: 'editor'
        });

        // A read runs through to the store (a panel agent that cannot read cannot judge).
        const read = await wrapped.execute(context, 'readChapter', { chapter_id: 'chapter_1' });

        expect(read.ok).toBe(true);
        expect(read.proposed).toBeUndefined();

        // A write is recorded and answered, and never reaches the tool layer at all — T3's hook bag
        // has no interception seam, so the panel owns this decision.
        const write = await wrapped.execute(context, 'editChapter', { chapter_id: 'chapter_1', summary: 'rewritten' });

        expect(write).toEqual({
            ok: true,
            summary:
                "recorded as agent 2's proposal — the run aggregates its panel and executes one winning set (D-38)",
            proposed: true
        });
        expect(proposals).toEqual([{ tool: 'editChapter', args: { chapter_id: 'chapter_1', summary: 'rewritten' } }]);
        expect(store.chapters.get('chapter_1')?.summary).toBe(
            'Maren reaches the ridge and does not recognise her own map.'
        );
        expect(inner.calls.map((call) => call.name)).toEqual(['readChapter']);
        // T-6a survives the wrapper: the same catalogue, role-blind.
        expect(wrapped.schemas()).toEqual(inner.schemas());
    });
});

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

describe('panel — D-38: N agents of one role, one answer per run', () => {
    it('three disagreeing agents produce ONE executed selection, one note naming the split, and three nested entries', async () => {
        const agents = rig(3, 'majority');
        const client = panelClient({
            agent: (index, turn) =>
                index === 3
                    ? picker(
                          'revision_2',
                          'agent 3 prefers the bell under the water',
                          `agent 3 chose the bell`
                      )(index, turn)
                    : picker(
                          'revision_1',
                          `agent ${index} prefers the map paid off on the page`,
                          `agent ${index} chose the steeple`
                      )(index, turn)
        });
        const tally = createTally();

        const outcome = await runPanel({ chat: client.client, runtime: agents.runtime }, agents.spec, tally);

        // One executed write, on the RUN's context — `runtime.calls` cannot contain a proposal,
        // because the wrapper short-circuits before the tool layer.
        expect(agents.runtime.calls.map((call) => call.name)).toEqual(['selectRevision']);
        expect(agents.runtime.calls[0]).toEqual({
            runRef: 'run_1',
            roleName: 'editor',
            roleKind: 'editor',
            name: 'selectRevision',
            args: {
                unit_ref: 'chapter_1',
                revision_id: 'revision_1',
                // The winning agent's own reasoning first, the split appended: D-38 requires the
                // dissent IN the note, and P11 keeps the reasoning auditable.
                selection_note:
                    'agent 1 prefers the map paid off on the page | 2 of 3 preferred revision_1; 1 of 3 preferred revision_2; selected revision_1 on majority 2 of 3',
                expects: [{ id: 'revision_1', rev: 1 }],
                why: 'T-2a: the rule I applied'
            }
        });

        // The record proves it: one draft survives, hard-deleted siblings and all (D-22), with the
        // note the Author will read (T-2a, L-17).
        const survivors = agents.store.revisions.list();

        expect(survivors).toHaveLength(1);
        expect(survivors[0].id).toBe('revision_1');
        expect(survivors[0].state).toBe('selected');
        expect(survivors[0].selection_note).toBe(
            'agent 1 prefers the map paid off on the page | 2 of 3 preferred revision_1; 1 of 3 preferred revision_2; selected revision_1 on majority 2 of 3'
        );
        expect(agents.store.chapters.get('chapter_1')?.current_revision).toBe('revision_1');

        // S-7: the three agents nest under the run — no Work Item, no run row of their own.
        expect(roleOrder(agents.delegated)).toEqual([
            {
                role: 'editor#agent_1',
                task: 'panel agent of select for chapter chapter_1',
                summary: 'agent 1 chose the steeple',
                tokens: 280
            },
            {
                role: 'editor#agent_2',
                task: 'panel agent of select for chapter chapter_1',
                summary: 'agent 2 chose the steeple',
                tokens: 280
            },
            {
                role: 'editor#agent_3',
                task: 'panel agent of select for chapter chapter_1',
                summary: 'agent 3 chose the bell',
                tokens: 280
            }
        ]);

        expect(agents.executed).toEqual(['selectRevision']);
        expect(outcome).toEqual({
            text: 'agent 1 chose the steeple',
            dissent: '2 of 3 preferred revision_1; 1 of 3 preferred revision_2; selected revision_1 on majority 2 of 3',
            answered: 3
        });
        // S-6: the run's total is its internals' total — three agents, two turns each.
        expect(tally.tokens).toBe(840);
        // Counting is arithmetic, so `majority` costs no model call (G-3: mechanical questions stay
        // out of an LLM's judgment). Three agents × two turns, and nothing else.
        expect(client.client.callCount).toBe(6);
    });

    it('keeps the agents blind to each other and executes only the winner’s set (P2, L-16, D-38)', async () => {
        const agents = rig(3, 'majority');
        const client = panelClient({
            agent: (index, turn) =>
                picker(`revision_${index}`, `agent ${index} note`, `agent ${index} answer`)(index, turn)
        });

        await runPanel({ chat: client.client, runtime: agents.runtime }, agents.spec, createTally());

        // Each agent's second request carries ONLY its own tool result — no other agent's text, no
        // other agent's proposal. Divergence that can see itself diverges differently.
        const perAgent = client.requests.filter(
            (request) => !(request.messages[0]?.content ?? '').startsWith('You are the aggregator')
        );
        const secondTurns = perAgent.filter((request) => request.messages.some((message) => message.role === 'tool'));

        expect(secondTurns).toHaveLength(3);

        for (const request of secondTurns) {
            const index = Number(/You are agent (\d+) of/.exec(String(request.messages[0]?.content))?.[1]);
            const transcript = JSON.stringify(request.messages);

            expect(transcript).toContain(`recorded as agent ${index}'s proposal`);

            for (const other of [1, 2, 3].filter((candidate) => candidate !== index)) {
                expect(transcript.includes(`recorded as agent ${other}'s proposal`)).toBe(false);
                expect(transcript.includes(`agent ${other} answer`)).toBe(false);
            }
        }

        // Three distinct picks: the panel answers once, so exactly one write reaches the store.
        expect(agents.runtime.calls).toHaveLength(1);
        expect(agents.store.revisions.list()).toHaveLength(1);
    });

    it('merge mode asks the aggregator ONCE, shows it all three answers, and reports its synthesis', async () => {
        const agents = rig(3, 'merge');
        const client = panelClient({
            agent: (index, turn) =>
                picker(`revision_${index}`, `agent ${index} note`, `agent ${index} answer`)(index, turn),
            aggregator: () =>
                '{"agent":3,"reason":"the must_change rule","synthesis":"take the bell from draft 3 and the map from draft 1; the Writer writes the seam"}'
        });
        const tally = createTally();

        const outcome = await runPanel({ chat: client.client, runtime: agents.runtime }, agents.spec, tally);

        // All three proposals in front of the aggregator (it is the only context that sees them,
        // which is what keeps the agents themselves blind), plus the Author's rules in its prompt.
        const aggregator = client.requests[client.requests.length - 1];

        expect(aggregator.messages[0]?.content).toContain('Prefer the draft that pays off the 1911 map on the page');
        expect(aggregator.messages[1]?.content).toContain('agent 1 answer');
        expect(aggregator.messages[1]?.content).toContain('agent 2 answer');
        expect(aggregator.messages[1]?.content).toContain('agent 3 answer');
        expect(aggregator.messages[1]?.content).toContain('selectRevision');

        // The pick decides which SET executes — the aggregation cannot invent a fourth draft (L-19).
        expect(agents.runtime.calls[0]?.args.revision_id).toBe('revision_3');
        expect(agents.store.revisions.list()[0]?.id).toBe('revision_3');
        expect(agents.store.revisions.list()[0]?.selection_note).toBe(
            'agent 3 note | 1 of 3 preferred revision_1; 1 of 3 preferred revision_2; 1 of 3 preferred revision_3; selected revision_3 on the must_change rule'
        );

        expect(outcome.text).toBe('take the bell from draft 3 and the map from draft 1; the Writer writes the seam');
        expect(outcome.answered).toBe(3);
        // Three agents × two turns + one aggregator call. ONE extra call for N agents, not N more loops.
        expect(client.client.callCount).toBe(7);
        expect(tally.tokens).toBe(840 + 230);
    });

    it('falls back to the counted majority when the aggregator cannot answer, and says so (D-38, L-17)', async () => {
        const agents = rig(3, 'lead');
        const client = panelClient({
            agent: (index, turn) =>
                picker(`revision_${index}`, `agent ${index} note`, `agent ${index} answer`)(index, turn),
            aggregator: () => 'they are all fine, I would pick whichever'
        });

        const outcome = await runPanel({ chat: client.client, runtime: agents.runtime }, agents.spec, createTally());

        // A panel that failed to aggregate would leave the run with NO report, which is worse for the
        // Author than a deterministic pick with the reason recorded. Earliest agent takes the tie.
        expect(agents.runtime.calls[0]?.args.revision_id).toBe('revision_1');
        expect(agents.store.revisions.list()[0]?.selection_note).toBe(
            'agent 1 note | 1 of 3 preferred revision_1; 1 of 3 preferred revision_2; 1 of 3 preferred revision_3; selected revision_1 on majority tie at 1 of 3 — earliest agent taken; the aggregator gave no usable pick, so the count decided'
        );
        expect(outcome.text).toBe('agent 1 answer');
    });

    it('answers once when one agent is lost, and fails only when all of them are (D-38, S-3)', async () => {
        const partial = rig(2, 'majority');
        const partialClient = panelClient({
            agent: (index, turn) =>
                picker(`revision_${index}`, `agent ${index} note`, `agent ${index} answer`)(index, turn),
            lost: [2]
        });

        const outcome = await runPanel(
            { chat: partialClient.client, runtime: partial.runtime },
            partial.spec,
            createTally()
        );

        // One lost agent still leaves an answer: the loop's one report is worth more to the Author
        // than one agent's transport fault.
        expect(outcome).toEqual({ text: 'agent 1 answer', dissent: '', answered: 1 });
        expect(partial.runtime.calls).toHaveLength(1);
        expect(roleOrder(partial.delegated)).toEqual([
            {
                role: 'editor#agent_1',
                task: 'panel agent of select for chapter chapter_1',
                summary: 'agent 1 answer',
                tokens: 280
            }
        ]);

        const lost = rig(2, 'majority');
        const lostClient = panelClient({ agent: () => msg({ content: 'never answered' }), lost: [1, 2] });

        // Nothing to aggregate is a genuine failure — rethrow so the executor records it (S-3).
        await expect(
            runPanel({ chat: lostClient.client, runtime: lost.runtime }, lost.spec, createTally())
        ).rejects.toThrow('provider exploded');
        expect(lost.delegated).toEqual([]);
        expect(lost.runtime.calls).toEqual([]);
    });

    it('leaves a silent panel as a no-op turn, still nested, still one report surface (S-4, S-7)', async () => {
        const agents = rig(2, 'majority');
        const client = panelClient({
            agent: (index) => msg({ content: `agent ${index} read everything and wrote nothing` })
        });

        const outcome = await runPanel({ chat: client.client, runtime: agents.runtime }, agents.spec, createTally());

        expect(outcome).toEqual({
            text: 'agent 1 read everything and wrote nothing\n\nagent 2 read everything and wrote nothing',
            dissent: '',
            answered: 2
        });
        expect(agents.runtime.calls).toEqual([]);
        expect(agents.executed).toEqual([]);
        expect(roleOrder(agents.delegated).map((entry) => entry.role)).toEqual(['editor#agent_1', 'editor#agent_2']);
        // Nothing reported, so the run's tally has no reports and the executor marks it a no-op.
        expect(createTally().reports).toEqual([]);
    });

    it('does not narrate unanimity, and keeps the winning agent’s own note intact (D-38, T-2a, P11)', async () => {
        const agents = rig(3, 'majority');
        const client = panelClient({
            agent: (index, turn) =>
                picker(
                    'revision_2',
                    `agent ${index} prefers the bell under the water`,
                    `agent ${index} agrees`
                )(index, turn)
        });

        const outcome = await runPanel({ chat: client.client, runtime: agents.runtime }, agents.spec, createTally());

        expect(outcome.dissent).toBe('');
        expect(agents.runtime.calls[0]?.args.revision_id).toBe('revision_2');
        // Every agent proposed the same thing; the winner's note is its own, verbatim.
        expect(agents.store.revisions.list()[0]?.selection_note).toBe('agent 1 prefers the bell under the water');
    });
});
