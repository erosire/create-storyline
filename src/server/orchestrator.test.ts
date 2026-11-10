// R-C: the review chain, end to end on a SCRIPTED team — no provider, no listener, and no
// model that could answer differently on a Tuesday.
//
// WHY THE PRESET'S `build` SEAM AND NOT A HAND-BUILT OBSERVER. The chain only exists as
// installed by `createStorylinePreset().create()` — the observer wrapped around the session's
// own progress closure (./presets.ts). A test that built the orchestrator by hand would prove
// the helper and prove nothing about the wiring, so every test here goes through the preset and
// `build` supplies a team whose transports are scripts. Same last-wins swap the registry
// already supports (`extra` presets), with the team instead of the whole card replaced.
//
// WHY `harness({ report: { progress } })` IS THE RIGHT SCRIPTED TEAM. `report.progress` is
// where a harness delivers its frames (harness src/types/index.ts:3184) and the shared factory
// wires the preset closure into exactly that field. Verified against the harness: a TOP-LEVEL
// `progress` key is ignored, so a scripted team that passed one would never be observed.
//
// WHY A TURN IS A FACTORY (`Turn`) AND NOT A PLAIN FRAME LIST. The harness refuses a tool-call
// id that a conversation has already used ("reused tool call id ... must be unique within the
// conversation"), and a chain deliberately re-uses the conversation the user has. A fixture
// that built its tool-call frame once therefore collides with itself on the second hop, so each
// emission mints a fresh id.
//
// WHY A HOST THREAD PER AGENT IN THESE TESTS. That is what the UI does — the roster composer
// addresses an agent through its own conversation — and it is the only shape whose frames carry
// an invocation identity the chain can join (./orchestrator.ts). Verified: a host-thread run
// publishes `event.thread.id = <invocation id>` and the thread row mirrors it in `invocationId`,
// while a run in an agent's DEFAULT conversation (`agent:writer`) carries no thread identity and
// is therefore never chained.
import { describe, expect, it } from 'vitest';
import { agent, harness } from '@underload/harness';
import type { AgentConfiguration, Harness, HarnessEvent, HarnessProgress, HarnessStream, HarnessStreamEvent } from '@underload/harness';
import { createStorylinePreset, type StorylinePresetOptions } from './presets';
import { STORYLINE_THREAD_LABEL, createStorylineOrchestrator, storylineTargetThread, storylineTaskFor } from './orchestrator';
import { ensureStorylineCollections } from './collections';

// A provider that dials nothing: the transports are scripts, so nothing reads these.
const SETTINGS = { baseURL: 'http://127.0.0.1:1/v1', apiKey: '', model: 'story/test-model' };

// The four collections a bare harness already owns (verified by probe, in this order).
// `outlines` and `storyline` exist only once ./collections.ts defines them.
const BUILTIN_COLLECTIONS = ['tasks', 'chapters', 'profiles', 'locations'];

// The default circle, pinned explicitly so no test depends on the environment.
const CIRCLE = { editor: 'writer', writer: 'reader', reader: 'editor' };

// The rule every test runs with unless it passes its own: the shipped default
// (`STORYLINE_CHAIN=editor:writer,writer:reader,reader:editor`, depth 3), written out here so
// no test reads the operator's environment.
const DEFAULT_CHAIN = { enabled: true, next: CIRCLE, maxDepth: 3, rule: 'editor:writer,writer:reader,reader:editor' };

// ---------------------------------------------------------------------------
// Scripted transports
// ---------------------------------------------------------------------------

/** One scripted model request: a turn is a FACTORY, so every run gets fresh ids. */
type Turn = () => HarnessStreamEvent[];

let callIndex = 0;

/** The terminal frame of a tool round: one call, by tool name, with JSON arguments. */
const callTool = (name: string, parameters: unknown): Turn => {
    return (): HarnessStreamEvent[] => {
        callIndex += 1;

        return [{ type: 'done', stopReason: 'tool_calls', toolCalls: [{ id: `call-${callIndex}`, name, arguments: JSON.stringify(parameters) }] }];
    };
};

/** One text delta and the terminal frame: a turn that says something and changes nothing. */
const textTurn = (text: string): Turn => {
    return (): HarnessStreamEvent[] => [
        { type: 'text', delta: text },
        { type: 'done', stopReason: 'stop', toolCalls: [] }
    ];
};

/** A transport that fails the request outright (no text, no terminal frame). */
const failingTurn = (message: string): Turn => {
    return (): HarnessStreamEvent[] => [{ type: 'error', message }];
};

/** Replays `turns` round-robin, so EVERY run of this transport follows the same shape. A
 *  chain needs that: if only the first run of an agent wrote a record, the later hops would
 *  have nothing to act on and the depth cap could never be reached. */
const cycle = (turns: Turn[]): HarnessStream => {
    let index = 0;

    return async function* stream() {
        const frames = turns[index % turns.length]();

        index += 1;

        for (const frame of frames) yield frame;
    };
};

/** Replays each entry once and then repeats the LAST one, for a fixture where the FIRST run
 *  of an agent is the one that writes (e.g. a delegated child) and its later chained run must
 *  answer without touching a record. */
const scripted = (turns: Turn[]): HarnessStream => {
    let index = 0;

    return async function* stream() {
        const frames = turns[Math.min(index, turns.length - 1)]();

        index += 1;

        for (const frame of frames) yield frame;
    };
};

/** Delays the first frame of `inner`. This is the whole difference between the delegation
 *  tests below and the ones above: with the child still running, the parent's tool-free
 *  answer is emitted as a PAUSED `done` — `done` with the unfinished call in `pending`
 *  (harness src/harness.ts:9778, `streamPendingTools`) — and the run then keeps looping to a
 *  second, terminal `done` (src/harness.ts:9811). With a child that answers instantly the
 *  delegate call has already settled, so the parent emits ONE `done` and the pause never
 *  happens. Verified by probe: the same team with no delay emits a single `done` per run;
 *  with this delay it emits `done + 1 pending` and then the terminal one. */
const slow = (inner: HarnessStream, ms: number): HarnessStream => {
    return async function* stream(request) {
        await new Promise((resolve) => {
            setTimeout(resolve, ms);
        });

        for await (const frame of inner(request)) yield frame;
    };
};

/** A transport that adds a chapter, then answers: an agent that ACTUALLY changed the Title. */
const editsChapters = (title: string, note: string): HarnessStream =>
    cycle([callTool('chapters', { action: 'add', title, summary: `Written by the ${title} pass.` }), textTurn(note)]);

/** A transport that answers and writes nothing at all: the gate's negative case. */
const readsOnly = (note: string): HarnessStream => cycle([textTurn(note)]);

/** A transport that writes one section of the Title's own `outlines` collection. */
const editsOutlines = (heading: string, note: string): HarnessStream =>
    cycle([callTool('records', { collection: 'outlines', entries: [{ heading, order: 10, content: 'Ines arrives at the harbour.' }] }), textTurn(note)]);

/** A transport that delegates to `reader` and then answers. `input` is the delegate tool's
 *  argument name (harness core/metadata.ts `agentDelegateMetadata`). */
const delegatesToReader = (note: string): HarnessStream => cycle([callTool('delegate', { agent: 'reader', input: 'Critique the opening.' }), textTurn(note)]);

// ---------------------------------------------------------------------------
// The team under test
// ---------------------------------------------------------------------------

type Team = {
    harness: Harness;
    /** Every frame the session's progress closure received, in order. */
    frames: HarnessEvent[];
    /** The sentences the chain reported (depth cap, failed delivery). */
    reports: string[];
};

/**
 * One session of the REAL preset over a scripted team: `build` is this package's seam for
 * exactly that, while the tool declarations and the chain observer are ./presets.ts running
 * for real. `retry: false` is what keeps a failing transport test seconds long — a harness
 * agent otherwise retries a failed request ten times with doubling waits (1s..512s).
 */
const buildTeam = (
    transports: Record<string, HarnessStream>,
    options: Pick<StorylinePresetOptions, 'chain' | 'orchestration'> = {}
): Team => {
    const frames: HarnessEvent[] = [];
    const reports: string[] = [];
    const progress: HarnessProgress = (event) => {
        frames.push(event);
    };

    const brain = (agentName: string): AgentConfiguration & { model: string } => ({
        model: SETTINGS.model,
        retry: false,
        stream: transports[agentName] ?? readsOnly(agentName)
    });

    const preset = createStorylinePreset({
        build: (_settings, next, report) =>
            harness({
                agents: { writer: agent(brain('writer')), reader: agent(brain('reader')), editor: agent(brain('editor')) },
                primary: 'writer',
                subagents: ['reader', 'editor'],
                // The report bundle is forwarded the way the shared factory forwards it:
                // `progress` is the door the chain observes and `diagnostic`/`stateChange` are
                // the sinks a real session has. Nothing else is set, so the scripted team gets
                // the same toolbox `harness({...})` builds by default.
                report: { progress: next, ...(report === undefined ? {} : { diagnostic: report.diagnostic, stateChange: report.stateChange }) }
            }),
        chain: options.chain ?? DEFAULT_CHAIN,
        // Merged, not replaced: the report sink is how every test reads the chain's decisions,
        // and a test that overrides `deliver` must not silently lose it.
        orchestration: { report: (message: string) => reports.push(message), ...options.orchestration }
    });

    return { harness: preset.create(SETTINGS, progress), frames, reports };
};

/** The conversation the UI opens for one agent. `ownerThreadId` makes it a delegated child,
 *  which is the shape a delegation leaves in the roster (host origin, WITH an owner). */
const openThread = (team: Team, agentName: string, ownerThreadId?: string): string =>
    team.harness.createThread(agentName, { label: STORYLINE_THREAD_LABEL, ...(ownerThreadId === undefined ? {} : { ownerThreadId }) }).id;

/** One thread row, projected to the fields the target rule reads — an exact, stable thing to
 *  assert (ids and sequences are harness counters, so the whole row is pinned). */
const threadRow = (team: Team, threadId: string) => {
    const record = team.harness.threads().find((entry) => entry.id === threadId);

    if (record === undefined) return undefined;

    return { id: record.id, agent: record.agent, origin: record.origin, status: record.status, sequence: record.sequence, label: record.label };
};

/** A macrotask pause: the trigger is scheduled one microtask after the `done` frame, and every
 *  hop is a full run (model requests plus tool execution) of its own. */
const settle = async (ms = 120): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

/** The conversations a chain may open or reuse: top-level HOST threads, which excludes both an
 *  agent's default conversation (`origin: 'agent'`) and a delegated child (it is a host thread
 *  that carries `ownerThreadId`). */
const hostThreads = (team: Team, agentName?: string) =>
    team.harness
        .threads()
        .filter((record) => record.origin === 'host' && record.ownerThreadId === undefined && (agentName === undefined || record.agent === agentName));

/** Every host thread including delegated children, as `agent#sequence` rows. */
const everyThread = (team: Team): string[] =>
    team.harness.threads().filter((record) => record.origin === 'host').map((record) => `${record.agent}#${record.sequence}${record.ownerThreadId === undefined ? '' : '(child)'}`);

/** The chapter titles on the Title, in the order the `chapters` tool lists them. None of these
 *  fixtures sets `order`, so that is insertion order (chapters.tool.ts). */
const chapterTitles = async (team: Team): Promise<string[]> => {
    const listed = (await team.harness.executeTool('chapters', { action: 'list' })) as { chapters: { title: string }[] };

    return listed.chapters.map((chapter) => chapter.title);
};

/** The first thing said in one agent's conversation — a chained task, or the user's own words. */
const firstMessage = (team: Team, threadId: string): string => String(team.harness.threadMessages(threadId)[0].content);

describe('storyline review chain (R-C)', () => {
    it("hands the writer the editor's finished chapter change, exactly once, on the writer's own thread", async () => {
        const team = buildTeam({ editor: editsChapters('Chapter Two', 'the layout is reordered'), writer: readsOnly('prose follows') });

        const editorThread = openThread(team, 'editor');
        const answerForEditor = await team.harness.sendThreadInput(editorThread, 'Re-order the middle of the book.');

        expect(answerForEditor.content).toBe('the layout is reordered');

        await settle();

        // One conversation, opened on demand, carrying the label that says the server opened
        // it — the user never talked to the writer in this test. Ids, sequences and invocation
        // ids are harness counters, so the whole row is pinned.
        expect(hostThreads(team)).toEqual([
            { id: 'thread-1', agent: 'editor', origin: 'host', status: 'idle', sequence: 4, label: STORYLINE_THREAD_LABEL, invocationId: '1' },
            { id: 'thread-2', agent: 'writer', origin: 'host', status: 'idle', sequence: 5, label: STORYLINE_THREAD_LABEL, invocationId: '2' }
        ]);

        const writerThread = hostThreads(team, 'writer')[0].id;

        // The exact task text — who acted, what moved (collection, id, title, operation) and
        // the writer's job — plus the writer's own answer. Nothing here asks the receiving
        // agent to remember anything, because it may never have seen the change.
        expect(firstMessage(team, writerThread)).toBe(storylineTaskFor('writer', 'editor', 'chapter #1 "Chapter Two" (add)'));
        expect(team.harness.threadMessages(writerThread)).toEqual([
            { role: 'user', content: storylineTaskFor('writer', 'editor', 'chapter #1 "Chapter Two" (add)'), messageId: 'msg-1' },
            { role: 'assistant', content: 'prose follows', messageId: 'msg-2' }
        ]);

        // Exactly one hop. The reader is next in the circle and stayed out: only a COMPLETED
        // root turn may trigger, and the writer's own chained run answered without touching a
        // record — one completion triggers at most once.
        expect(hostThreads(team, 'reader')).toEqual([]);
        expect(team.reports).toEqual([]);

        // The store's own recorder still sees every frame: wrapping the closure observes, it
        // never replaces.
        expect(team.frames.filter((event) => event.type === 'done').map((event) => event.agent)).toEqual(['editor', 'writer']);
    });

    it('stays silent when the turn wrote no record', async () => {
        const team = buildTeam({ editor: readsOnly('I would tighten chapter two'), writer: editsChapters('Unused', 'never asked') });

        openThread(team, 'editor');

        await team.harness.sendThreadInput(hostThreads(team, 'editor')[0].id, 'Any notes?');
        await settle();

        // The turn completed and changed nothing, so there is nothing for the writer to
        // review: the gate is the difference between a chain and a spinning wheel.
        expect(everyThread(team)).toEqual(['editor#4']);
        expect(await chapterTitles(team)).toEqual([]);
        expect(team.harness.records().collections.map((collection) => collection.name)).toEqual(BUILTIN_COLLECTIONS);
    });

    it('walks the circle and stops at the depth cap', async () => {
        const team = buildTeam({
            editor: editsChapters('Editor pass', 'structure revised'),
            writer: editsChapters('Writer pass', 'prose updated'),
            reader: editsChapters('Reader pass', 'critique recorded')
        });

        openThread(team, 'editor');

        await team.harness.sendThreadInput(hostThreads(team, 'editor')[0].id, 'Tighten the middle.');
        await settle(400);

        // One chapter per run: the user's editor turn, then writer, then reader, then editor
        // again — three CHAINED turns, which is the cap — and the fourth hop is refused rather
        // than queued.
        expect(await chapterTitles(team)).toEqual(['Editor pass', 'Writer pass', 'Reader pass', 'Editor pass']);

        // Three conversations for four runs: the third chained hop rode the editor's existing
        // conversation, which is exactly the reuse the UI depends on.
        expect(everyThread(team)).toEqual(['editor#4', 'writer#5', 'reader#6']);

        // The refusal is not silent: the log names the agent, the hop and the variable to turn,
        // which is the only way an operator can tell "done" from "capped".
        expect(team.reports).toEqual(['chain stopped after editor: hop 4 exceeds STORYLINE_CHAIN_DEPTH (3).']);
    });

    it('ignores a delegated child run, because its owner is still mid-turn', async () => {
        // The only edge in the rule belongs to the CHILD agent. A chain that treated the
        // reader's delegated run as a finished turn would have opened an `editor` conversation
        // on the strength of it; the writer's own turn has no edge, so it stays quiet too.
        const team = buildTeam(
            { writer: delegatesToReader('noted the critique'), reader: editsChapters('Reader note', 'the opening drags'), editor: readsOnly('editor idle') },
            { chain: { enabled: true, next: { reader: 'editor' }, maxDepth: 3, rule: 'reader:editor' } }
        );

        const writerThread = openThread(team, 'writer');

        await team.harness.sendThreadInput(writerThread, 'Open the book.');
        await settle(400);

        // The child DID do the work, and it is the only extra conversation in the session. The
        // filter is about who may start the next hop, not about whether the delegation ran.
        expect(everyThread(team)).toEqual(['writer#4', 'reader#5(child)']);
        expect(await chapterTitles(team)).toEqual(['Reader note']);
        expect(team.reports).toEqual([]);
    });

    it('counts a delegated child write as the change its owner reports', async () => {
        // The same delegation, with the writer back in the circle: the child's write moved the
        // Title during the writer's turn, so the writer's completion is what hands it on. The
        // reader's own transport only writes on its FIRST run, so the chained run answers and
        // the chain stops at one hop.
        const team = buildTeam({
            writer: delegatesToReader('noted the critique'),
            reader: scripted([callTool('chapters', { action: 'add', title: 'Reader note', summary: 'the opening drags' }), textTurn('the opening drags')]),
            editor: readsOnly('editor idle')
        });

        const writerThread = openThread(team, 'writer');

        await team.harness.sendThreadInput(writerThread, 'Open the book.');
        await settle(400);

        expect(everyThread(team)).toEqual(['writer#4', 'reader#5(child)', 'reader#6']);
        expect(await chapterTitles(team)).toEqual(['Reader note']);

        // The task names the chapter the CHILD wrote — the changed-record summary is read from
        // the store, so it does not care which run in the session made the write.
        expect(firstMessage(team, hostThreads(team, 'reader')[0].id)).toBe(storylineTaskFor('reader', 'writer', 'chapter #1 "Reader note" (add)'));
    });

    it("names the Title's own collections in a triggered task", async () => {
        const team = buildTeam({ editor: editsOutlines('Act One', 'the plan moved'), writer: readsOnly('prose follows') });

        // The two folders a Title owns, defined exactly as ./service.ts does it after a create,
        // so this is the agent-facing half of R-B: the model can WRITE them.
        expect(await ensureStorylineCollections(team.harness)).toEqual(['outlines', 'storyline']);

        openThread(team, 'editor');

        await team.harness.sendThreadInput(hostThreads(team, 'editor')[0].id, 'Re-plan the first act.');
        await settle();

        expect(hostThreads(team, 'writer')).toHaveLength(1);

        // The section is named the way the UI will show it — collection, id, heading — and the
        // writer is pointed at the prose the new plan invalidates.
        expect(firstMessage(team, hostThreads(team, 'writer')[0].id)).toBe(storylineTaskFor('writer', 'editor', 'outlines #1 "Act One" (add)'));
        expect(firstMessage(team, hostThreads(team, 'writer')[0].id)).toContain('Review what changed and rewrite the prose that depends on it');
    });

    it('reuses the conversation the user already has, instead of opening a second one', async () => {
        const team = buildTeam({ editor: editsChapters('Chapter Two', 'revised'), writer: readsOnly('prose follows') });

        // The writer's thread exists BEFORE the chain runs, because the user has been talking to
        // the writer. That is the conversation the review belongs in.
        const writerThread = openThread(team, 'writer');
        const editorThread = openThread(team, 'editor');

        await team.harness.sendThreadInput(editorThread, 'Re-order the middle.');
        await settle();

        expect(everyThread(team)).toEqual(['writer#4', 'editor#5']);

        const writerMessages = team.harness.threadMessages(writerThread);

        expect(writerMessages).toHaveLength(2);
        expect(String(writerMessages[0].content)).toContain('You were called because the editor');
        expect(String(writerMessages[1].content)).toBe('prose follows');
        expect(hostThreads(team, 'writer')[0].id).toBe(writerThread);
    });

    it('targets the newest LIVE host thread — the conversation the workstation composer addresses', () => {
        // T10 SEAM 2, pinned on the rule itself. The workstation picks the conversation its
        // composer types into by exactly one rule: the newest host thread of that agent
        // (`selectAgentThread`, src/api/storyline.ts). Three look-alikes must not win against
        // it: a delegated CHILD (newer, and somebody else's turn), another agent's
        // conversation, and a conversation the user has stopped.
        const team = buildTeam({});

        const userThread = openThread(team, 'writer');

        // Newer than the user's, and `origin: 'host'` as well — but it carries an owner, so it
        // is a delegation's work in progress and never the chain's destination.
        openThread(team, 'writer', userThread);
        const readerThread = openThread(team, 'reader');
        const stoppedThread = openThread(team, 'writer');

        team.harness.stopThread(stoppedThread);
        expect(threadRow(team, stoppedThread)?.status).toBe('stopped');

        // Live beats stopped, newest beats older, a child loses to its parent, and the reader's
        // conversation is not the writer's.
        expect(storylineTargetThread(team.harness, 'writer')).toEqual({ id: userThread, opened: false });
        expect(storylineTargetThread(team.harness, 'reader')).toEqual({ id: readerThread, opened: false });

        // With nothing live left for the agent, the STOPPED conversation still beats a brand-new
        // one: the UI addresses it whatever its `status` is, and a fresh host send is the
        // harness's own legal revival path (src/harness.ts:5091, "a NEW host send captures the
        // new epoch, which is the only legal revival path").
        team.harness.stopThread(userThread);
        expect(storylineTargetThread(team.harness, 'writer')).toEqual({ id: stoppedThread, opened: false });

        // An agent the user has never talked to gets a conversation of its own, carrying the
        // label that says the server opened it. Sequences 1-3 are the three agents' default
        // conversations, and the four threads above took 4-7, so this one is sequence 8.
        const opened = storylineTargetThread(team.harness, 'editor');

        expect(opened.opened).toBe(true);
        expect(threadRow(team, opened.id)).toEqual({
            id: 'thread-5',
            agent: 'editor',
            origin: 'host',
            status: 'idle',
            sequence: 8,
            label: STORYLINE_THREAD_LABEL
        });
    });

    it('delivers into the conversation the user stopped, instead of opening a second one', async () => {
        // The user stopped the writer; the editor then moved the Title. The composer keeps
        // addressing the writer's existing conversation — its rule ignores `status`, and
        // `POST <mount>/tasks` on a stopped thread answers 202 and the roster row goes back to
        // `running` (verified live against a booted gateway) — so that conversation is where the
        // review belongs. Before T10 this hopped into a SECOND writer conversation, and its
        // answer appeared nowhere the user reads.
        const team = buildTeam({ editor: editsChapters('Chapter Two', 'revised'), writer: readsOnly('prose follows') });

        const writerThread = openThread(team, 'writer');
        const editorThread = openThread(team, 'editor');

        team.harness.stopThread(writerThread);
        expect(threadRow(team, writerThread)).toEqual({
            id: 'thread-1',
            agent: 'writer',
            origin: 'host',
            status: 'stopped',
            sequence: 4,
            label: STORYLINE_THREAD_LABEL
        });

        await team.harness.sendThreadInput(editorThread, 'Re-order the middle.');
        await settle();

        // One conversation per agent: the chain revived the stopped one rather than forking the
        // writer's context, and the writer answered in it.
        expect(everyThread(team)).toEqual(['writer#4', 'editor#5']);
        expect(threadRow(team, writerThread)).toEqual({
            id: 'thread-1',
            agent: 'writer',
            origin: 'host',
            status: 'idle',
            sequence: 4,
            label: STORYLINE_THREAD_LABEL
        });

        const writerMessages = team.harness.threadMessages(writerThread);

        expect(writerMessages).toHaveLength(2);
        expect(String(writerMessages[0].content)).toBe(storylineTaskFor('writer', 'editor', 'chapter #1 "Chapter Two" (add)'));
        expect(String(writerMessages[1].content)).toBe('prose follows');
    });

    it('never chains when the operator switched the rule off', async () => {
        const team = buildTeam(
            { editor: editsChapters('Chapter Two', 'revised'), writer: editsChapters('Never', 'should not run') },
            { chain: { enabled: false, next: CIRCLE, maxDepth: 3, rule: '' } }
        );

        openThread(team, 'editor');

        await team.harness.sendThreadInput(hostThreads(team, 'editor')[0].id, 'Re-order the middle.');
        await settle();

        // A real change, no chain: `STORYLINE_CHAIN=` (empty) / `off` / `none` means the user is
        // the one who decides who works next.
        expect(everyThread(team)).toEqual(['editor#4']);

        const chapters = (await team.harness.executeTool('chapters', { action: 'list' })) as { chapters: { title: string }[] };

        expect(chapters.chapters.map((chapter) => chapter.title)).toEqual(['Chapter Two']);
    });

    it('reports a delivery that could not start, without failing the run that triggered it', async () => {
        const team = buildTeam(
            { editor: editsChapters('Chapter Two', 'revised'), writer: readsOnly('prose follows') },
            {
                orchestration: {
                    deliver: async (): Promise<void> => {
                        throw new Error('the writer thread is stopped');
                    }
                }
            }
        );

        openThread(team, 'editor');

        const answerForEditor = await team.harness.sendThreadInput(hostThreads(team, 'editor')[0].id, 'Re-order the middle.');

        await settle();

        // The editor's own answer is intact: an orchestration failure is never allowed to become
        // a run failure, and it reaches the session's diagnostic sink rather than nowhere.
        expect(answerForEditor.content).toBe('revised');
        expect(team.reports).toEqual(['a chained review failed: the writer thread is stopped']);
        expect(everyThread(team)).toEqual(['editor#4']);
    });

    it('releases its watch on an errored run and does not chain from a failure', async () => {
        const team = buildTeam({ editor: cycle([failingTurn('the provider went away')]), writer: readsOnly('not asked') });

        openThread(team, 'editor');

        await expect(team.harness.sendThreadInput(hostThreads(team, 'editor')[0].id, 'Try again.')).rejects.toThrow('the provider went away');
        await settle();

        // A failed turn is not a finished one: chaining into a run that just failed is how one
        // bad provider response becomes an argument between two agents.
        expect(everyThread(team)).toEqual(['editor#4']);
        expect(team.frames.map((event) => event.type)).toEqual(['start', 'error']);
        expect(team.reports).toEqual([]);
    });

    it('hands over a slow delegation exactly once — the pause is not a completion (T13)', async () => {
        // THE FRAME THAT MADE ONE TURN FIRE TWICE. A delegation is BACKGROUND work: while the
        // child is still running, the parent's tool-free answer is reported as `done` WITH the
        // unfinished call in `pending` (harness src/harness.ts:9778), the run waits, and only
        // the drained response afterwards is terminal (src/harness.ts:9811). `HarnessEvent`
        // states it (`src/types/index.ts:2618`: "`pending` non-empty means the run is NOT
        // terminal"). The observer used to treat the first of those as the end of the turn, so
        // this exact team — a writer whose delegated reader writes a chapter — completed twice:
        // two identical review tasks in one conversation, and the second one started counting
        // depth at 1 again because its window had already been released.
        //
        // The child's transport is `slow` for one reason: with a child that answers at once the
        // delegate call has settled before the parent's next response, no `pending` is left, and
        // this scenario cannot be reached at all. Probed: same team, no delay, one `done` per
        // run; with the delay, `done + 1 pending` then the terminal one.
        const team = buildTeam({
            writer: scripted([callTool('delegate', { agent: 'reader', input: 'Critique the opening.' }), textTurn('noted the critique')]),
            reader: slow(scripted([callTool('chapters', { action: 'add', title: 'Reader note', summary: 'the opening drags' }), textTurn('the opening drags')]), 150),
            editor: readsOnly('editor idle')
        });

        const writerThread = openThread(team, 'writer');

        await team.harness.sendThreadInput(writerThread, 'Open the book.');
        await settle(600);

        // THE PRECONDITION, pinned rather than assumed: the turn really did pause, and exactly
        // once. Without this line the test would silently degrade back into the fast-child case
        // above and prove nothing about the pause.
        const paused = team.frames.filter((event) => event.type === 'done' && (event.pending?.length ?? 0) > 0);

        expect(paused.map((event) => `${event.agent}:${event.thread?.id}`)).toEqual(['writer:1']);

        // One child, one chained conversation: the writer's turn completed ONCE, so the reader
        // was addressed once.
        expect(everyThread(team)).toEqual(['writer#4', 'reader#5(child)', 'reader#6']);

        // The chapter is the CHILD's write; the chained reader answers without touching a
        // record, so a second chapter here would mean a second hop ran.
        expect(await chapterTitles(team)).toEqual(['Reader note']);

        // The conversation holds ONE task and ONE answer. This is the assertion the defect
        // breaks: with the pause treated as terminal the reader's conversation is
        // task · answer · task · answer — the same review handed over twice.
        const readerThread = hostThreads(team, 'reader')[0].id;

        expect(team.harness.threadMessages(readerThread)).toEqual([
            { role: 'user', content: storylineTaskFor('reader', 'writer', 'chapter #1 "Reader note" (add)'), messageId: 'msg-1' },
            { role: 'assistant', content: 'the opening drags', messageId: 'msg-2' }
        ]);

        // No depth cap report either: the doubled hop used to restart the count at 1 and run the
        // chain past the operator's limit.
        expect(team.reports).toEqual([]);
    });

    it('renders the task a role receives, with nothing left implicit', () => {
        // Pinned as whole sentences, because this text IS the interface between two agent
        // conversations that share no memory.
        expect(storylineTaskFor('reader', 'writer', 'chapters #4 "The Crossing" (update)')).toBe(
            [
                "You were called because the writer finished a turn and changed the Title's records.",
                'What moved: chapters #4 "The Crossing" (update).',
                'Read what the team has just changed and critique it: pacing, continuity, character consistency, prose quality. Name every finding against the chapter or profile it is about, rank them by what they cost the story, and end with the one thing to fix first. Change nothing.'
            ].join('\n')
        );

        // The editor is pointed at the two collections a Title owns, and an agent the operator
        // named has a prompt too — the chain never hands an agent an empty instruction.
        expect(storylineTaskFor('editor', 'reader', 'storyline #2 "The middle" (update)')).toContain('repair the plan in `outlines`');
        expect(storylineTaskFor('poet', 'stranger', 'the story records')).toContain('the stranger agent finished a turn');
        expect(storylineTaskFor('poet', 'stranger', 'the story records')).toContain('carry the Title forward');
    });
});

// ---------------------------------------------------------------------------
// The frame rule, pinned at the observer's own seam
// ---------------------------------------------------------------------------
//
// WHY A HAND-BUILT OBSERVER IS ALLOWED HERE AFTER THE HEADER ABOVE RULES IT OUT. The tests
// above go through the preset because the WIRING is what they pin. These pin the frame rule
// itself — what one invocation owes the chain per `done` — and two of its three cases cannot
// be produced by any scripted transport: a terminal frame arriving TWICE for one invocation
// (a late duplicate, a retried delivery) is a reporter artifact, not something a run emits,
// and the depth an armed run carries across a pause needs a watermark that moves at an exact
// moment. A transport can only approximate both with timing; `observe` states them directly,
// with a stub harness whose `records()` and `recordsChanges()` are the only two facts the
// gate and the task text read.
describe('the chain observer\'s frame rule (T13)', () => {
    /** One mutable thread row, mutable because a chained hop is a NEW invocation in an
     *  existing conversation — the join the observer makes is through `invocationId`. */
    type StubThread = {
        id: string;
        agent: string;
        origin: 'host';
        status: 'idle' | 'running' | 'stopped';
        sequence: number;
        label?: string;
        invocationId?: string;
    };

    /** One committed record change, with the watermark it committed at. */
    type StubChange = { rev: number; collection: string; id: string; op: string };

    const stubHarness = (threads: StubThread[]) => {
        const changes: StubChange[] = [];
        let storeRev = 0;
        let sequence = threads.reduce((best, row) => Math.max(best, row.sequence), 0);

        const harness = {
            threads: () => threads.map((row) => ({ ...row })),
            // `collections` carries the labels `describeChanges` reads; `storeRev` is the gate's
            // whole input, so it moves only when `write` below is called.
            records: () => ({
                storeRev,
                collections: [{ name: 'chapters', entries: changes.map((change) => ({ id: change.id, title: `Chapter ${change.id}` })) }]
            }),
            recordsChanges: (since: number) => ({
                changes: changes.filter((change) => change.rev > since).map((change) => ({ collection: change.collection, id: change.id, op: change.op })),
                reset: false
            }),
            createThread: (agentName: string, options?: { label?: string }) => {
                sequence += 1;

                const record: StubThread = { id: `thread-new-${sequence}`, agent: agentName, origin: 'host', status: 'idle', sequence, ...(options === undefined ? {} : { label: options.label }) };

                threads.push(record);

                return { ...record };
            },
            threadMessages: () => [],
            deleteThread: () => undefined,
            sendThreadInput: () => Promise.resolve({ content: '' })
        };

        return {
            harness: harness as unknown as Harness,
            /** Commits one change: the watermark moves, exactly as the engine's does. */
            write: (collection: string, id: string, op: string): number => {
                storeRev += 1;
                changes.push({ rev: storeRev, collection, id, op });

                return storeRev;
            },
            /** Points a conversation at a new invocation — what a fresh run does to its row. */
            run: (threadId: string, invocationId: string): void => {
                const row = threads.find((entry) => entry.id === threadId);

                if (row !== undefined) row.invocationId = invocationId;
            }
        };
    };

    const startFrame = (agent: string, invocationId: string): HarnessEvent => ({
        type: 'start',
        agent,
        model: SETTINGS.model,
        thread: { id: invocationId }
    });

    /** The two shapes of `done`: the answer of a run that is still waiting, and the terminal
     *  one. Only `pending` differs, which is exactly how thin the runtime's line is. */
    const doneFrame = (agent: string, invocationId: string, paused = false): HarnessEvent => ({
        type: 'done',
        agent,
        message: { role: 'assistant', content: 'answer', reasoning: '', toolCalls: [], model: SETTINGS.model, stopReason: 'stop' },
        thread: { id: invocationId },
        ...(paused ? { pending: [{ callId: 'call-bg', name: 'delegate', elapsedMs: 12 }] } : {})
    });

    /** An observer whose trigger is queued, not run, so a test decides when the hop happens. */
    const buildObserver = (harness: Harness, rules: { enabled: boolean; next: Record<string, string>; maxDepth: number; rule: string }) => {
        const queue: Array<() => Promise<void>> = [];
        const reports: string[] = [];
        const orchestrator = createStorylineOrchestrator({
            harness: () => harness,
            rules,
            // Delivery is recorded by the trigger history itself; nothing runs.
            deliver: async (): Promise<void> => undefined,
            report: (message: string) => reports.push(message),
            schedule: (run: () => Promise<void>) => {
                queue.push(run);
            }
        });
        const drain = async (): Promise<void> => {
            while (queue.length > 0) await (queue.shift() as () => Promise<void>)();
        };

        return { orchestrator, reports, drain, pending: () => queue.length };
    };

    const CHAIN = { enabled: true, next: { writer: 'reader', reader: 'editor' }, maxDepth: 3, rule: 'writer:reader,reader:editor' };

    it('chains once across a pause, and ignores a terminal frame that arrives twice', async () => {
        const threads: StubThread[] = [{ id: 'thread-w', agent: 'writer', origin: 'host', status: 'running', sequence: 4, invocationId: 'inv-1' }];
        const stub = stubHarness(threads);
        const observer = buildObserver(stub.harness, CHAIN);

        observer.orchestrator.observe(startFrame('writer', 'inv-1'));

        // The child's write lands DURING the pause: the gate's baseline is the run's `start`, so
        // this is still the turn's own change and must be credited to it, not lost.
        stub.write('chapters', '1', 'add');
        observer.orchestrator.observe(doneFrame('writer', 'inv-1', true));
        await observer.drain();

        // The pause owes the chain nothing, and it must not release the window: one watched run
        // is the proof the baseline and the depth survived it.
        expect(observer.pending()).toBe(0);
        expect(observer.orchestrator.triggers()).toEqual([]);
        expect(observer.orchestrator.watching()).toBe(1);

        observer.orchestrator.observe(doneFrame('writer', 'inv-1'));
        await observer.drain();

        // The terminal frame is the one that completes: one hop, at depth 1, naming the change
        // that landed while the run was paused.
        expect(observer.orchestrator.triggers()).toEqual([
            {
                from: 'writer',
                agent: 'reader',
                threadId: 'thread-new-5',
                depth: 1,
                task: storylineTaskFor('reader', 'writer', 'chapter #1 "Chapter 1" (add)')
            }
        ]);
        expect(observer.orchestrator.watching()).toBe(0);

        // A SECOND terminal frame for the same invocation — the late duplicate, the retried
        // delivery. Without the settled marker it falls into the "no window" fallback, re-opens
        // the run at `startRev: 0`, and fires the same hop a second time.
        observer.orchestrator.observe(doneFrame('writer', 'inv-1'));
        await observer.drain();

        expect(observer.orchestrator.triggers()).toHaveLength(1);
        expect(observer.orchestrator.watching()).toBe(0);
        expect(observer.reports).toEqual([]);
    });

    it('carries an armed hop through a pause instead of restarting the count at 1', async () => {
        const threads: StubThread[] = [
            { id: 'thread-w', agent: 'writer', origin: 'host', status: 'idle', sequence: 4, invocationId: 'inv-1' },
            { id: 'thread-r', agent: 'reader', origin: 'host', status: 'idle', sequence: 5 }
        ];
        const stub = stubHarness(threads);
        const observer = buildObserver(stub.harness, CHAIN);

        // Hop 1: the writer's turn writes and settles.
        observer.orchestrator.observe(startFrame('writer', 'inv-1'));
        stub.write('chapters', '1', 'add');
        observer.orchestrator.observe(doneFrame('writer', 'inv-1'));
        await observer.drain();

        // The arm is what carries the depth: the chained run has not started yet, and the hop
        // counter belongs to it, not to the conversation.
        expect(observer.orchestrator.armed()).toEqual(['thread-r']);
        stub.run('thread-r', 'inv-2');
        observer.orchestrator.observe(startFrame('reader', 'inv-2'));
        expect(observer.orchestrator.armed()).toEqual([]);

        // The reader's own run pauses — and the record it wrote lands during that pause.
        stub.write('chapters', '2', 'update');
        observer.orchestrator.observe(doneFrame('reader', 'inv-2', true));
        observer.orchestrator.observe(doneFrame('reader', 'inv-2', true));
        await observer.drain();

        expect(observer.orchestrator.triggers()).toHaveLength(1);
        expect(observer.orchestrator.watching()).toBe(1);

        observer.orchestrator.observe(doneFrame('reader', 'inv-2'));
        await observer.drain();

        // Depth 2, not 1: two paused frames inside one run still complete it once, and the hop
        // continues the count the arm carried. The change it names is the one written DURING the
        // pause — the reader's window opened with the store already at 1, so `startRev` is 1 and
        // the writer's earlier write is not this turn's change. Had the paused frame released the
        // window, this second completion would have fallen back to `startRev: 0`, named both, and
        // restarted the depth at 1.
        expect(observer.orchestrator.triggers()[1]).toEqual({
            from: 'reader',
            agent: 'editor',
            threadId: 'thread-new-6',
            depth: 2,
            task: storylineTaskFor('editor', 'reader', 'chapter #2 "Chapter 2" (update)')
        });
        expect(observer.reports).toEqual([]);
    });

    it('stops a chain that pauses, exactly like one that does not', async () => {
        const threads: StubThread[] = [
            { id: 'thread-w', agent: 'writer', origin: 'host', status: 'idle', sequence: 4, invocationId: 'inv-1' },
            { id: 'thread-r', agent: 'reader', origin: 'host', status: 'idle', sequence: 5 }
        ];
        const stub = stubHarness(threads);
        const observer = buildObserver(stub.harness, { ...CHAIN, maxDepth: 1, rule: 'writer:reader,reader:editor' });

        observer.orchestrator.observe(startFrame('writer', 'inv-1'));
        stub.write('chapters', '1', 'add');
        observer.orchestrator.observe(doneFrame('writer', 'inv-1'));
        await observer.drain();

        stub.run('thread-r', 'inv-2');
        observer.orchestrator.observe(startFrame('reader', 'inv-2'));
        stub.write('chapters', '2', 'update');

        // The pause does not open a fresh budget: the next hop is still hop 2, and the operator's
        // limit is still the sentence they read in the log.
        observer.orchestrator.observe(doneFrame('reader', 'inv-2', true));
        observer.orchestrator.observe(doneFrame('reader', 'inv-2'));
        await observer.drain();

        expect(observer.orchestrator.triggers()).toHaveLength(1);
        expect(observer.reports).toEqual(['chain stopped after reader: hop 2 exceeds STORYLINE_CHAIN_DEPTH (1).']);
    });
});
