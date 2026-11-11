// D-38 — the panel: one template ROLE that is N fresh agents answering ONCE, inside one run.
//
// WHY IT LIVES INSIDE THE RUN (D-38, D-34a, S-1): the loop must still receive exactly one
// report, one `selection_note`, one verdict set and one permission-bearing answer. If the panel
// were three runs, the loop would hold three votes and the Author's taste would be applied
// three times per decision — which is what D-34a forbids above the Editor. So the panel is
// scoped to this layer: N loops, one aggregation, one set of writes executed under the run's own
// identity, and one report surface.
//
// THE DISSENT IS NOT OPTIONAL (D-38): what a run MUST surface when its internals disagreed is
// the split, in the `selection_note` or in the finding's `detail` — "2 of 3 preferred draft 1;
// selected 2 on the must_happen rule" — because a hidden disagreement inside an authoritative
// answer is the one thing the Author cannot tune. So the aggregation does not merely pick: it
// composes that sentence and appends it to the winning call's note field before executing.
//
// THE AGENTS ARE BLIND (P2, L-16): they run in parallel from the SAME brief and never see each
// other's output. Nothing here feeds one agent's text to another; only the aggregator (the
// `merge` / `lead` modes) is shown all N proposals, and the aggregator is a different context
// again — so no agent's answer is contaminated by another's, and the run's answer is one.
import type { ToolSchema } from '../llm';
import type { LoopDeps, RunTally } from './loop';
import { createTally, runAgentLoop } from './loop';
import type { RunDelegation, RoleAggregation } from '../../shared/types';
import { panelPreamble } from './harness';
import {
    describeProposal,
    dissentFieldFor,
    isMutatingTool,
    primaryActionOf,
    proposalKey,
    REPORT_TOOLS
} from './catalogue';
import { panelAgentRoleLabel } from './types';
import type { RunToolContext, RunToolHooks, RunToolSession, ToolResult, ToolRuntime } from './types';

/** A panel agent's intercepted write, held until the aggregation decides which set lands (D-38). */
export interface PanelProposal {
    tool: string;
    args: Record<string, unknown>;
}

/** What one panel agent came back with. */
export interface PanelAgent {
    index: number;
    label: string;
    /** The agent's final prose — its answer, before the aggregation collapses the panel. */
    text: string;
    proposals: PanelProposal[];
    tokens: number;
}

export interface PanelSpec {
    /** The SAME assembled brief for every agent (S-2) — the blindness is the point (L-16). */
    brief: string;
    kickoff: string;
    model: string;
    roleName: string;
    roleKind: string;
    templateRef: string;
    storyId: string;
    runId: string;
    count: number;
    aggregate: RoleAggregation;
    /** D-17c: the aggregator applies the Author's own rules, not this file's notion of better. */
    selectionRules: string;
    /** One line naming the job, for the nested crew entries the panel records (S-7, U-7). */
    jobSummary: string;
    /** The run's own context: the winning calls execute HERE, under the run's identity (D-38). */
    parentContext: RunToolContext;
    /** Fresh session + context per agent; `delegatedRole` is what nests them under the run (S-7). */
    createContext: (session: RunToolSession, hooks: RunToolHooks) => RunToolContext;
    /** D-17e delegation, still available to a panel agent — a sub-context writes for the parent run. */
    delegate: (role: string, task: string) => Promise<ToolResult>;
    heartbeat: () => void;
    /** Records one nested entry on the run row as each agent finishes (S-7). */
    addDelegated: (entry: RunDelegation) => void;
    /** Called for each winning call that really executed — the run row's `reporting` step and tally (S-4, §4.13). */
    onExecuted: (name: string) => void;
    /**
     * U-1e: the run's tool list, decided by the executor from the Work Item's kind
     * (`toolsForRunKind` in ./catalogue). Forwarded so a panel agent is offered exactly what its run
     * is allowed — an `assistant` run's agents get no web tools either.
     */
    tools?: ToolSchema[];
    /** U-1e: §8.6's Author-invoked run. Panel agents inherit it, so their writes are attributed to the assistant (§2). */
    assistant?: boolean;
    signal?: AbortSignal;
}

export interface PanelOutcome {
    /** The winning agent's answer, or the aggregator's synthesis for a merge. */
    text: string;
    /** The split sentence appended to the winning call's note field, or empty when unanimous. */
    dissent: string;
    /** How many agents answered (the crew panel's "3 agents, 1 report", D-38). */
    answered: number;
}

/** One group of proposals that mean the same decision (D-38's "group by tool + key args"). */
interface ProposalGroup {
    key: string;
    label: string;
    /** How many agents' PRIMARY actions landed here — the number the dissent sentence quotes. */
    count: number;
    /** The lowest agent index that chose it, which is also the `lead` tie-break. */
    firstAgent: number;
}

/**
 * The aggregation's answer: whose proposal set the run executes. A mode may pick an agent
 * directly (`lead`) or synthesize and still pick one (`merge` — the seam goes to the Writer,
 * L-19, so the aggregation cannot invent a fourth draft).
 */
interface AggregationResult {
    winner: number;
    reason: string;
    synthesis?: string;
}

// ---------------------------------------------------------------------------
// The aggregator's prompt (merge / lead)
// ---------------------------------------------------------------------------

/**
 * The aggregator is ONE extra LLM call, not N more loops: it sees all N proposals and returns one
 * pick. `merge` asks for a synthesis line to report; `lead` states the tie-break the delegation
 * contract pins — the first agent's proposal wins ties — so a tie is decided by the Author's
 * declared rule rather than by this file's coin flip.
 */
export function aggregatorPrompt(count: number, aggregate: RoleAggregation, selectionRules: string): string {
    const mode =
        aggregate === 'lead'
            ? 'LEAD: the panel is advisory and the run answers once. Pick the proposal you would have made; where the panel is evenly balanced, prefer agent 1 (the declared tie-break).'
            : "MERGE: pick the proposal the run should execute, and put in `synthesis` what the run reports — including anything worth taking from the agents you did not pick. You may NOT compose prose: a merge of drafts hands the seam to the Writer (L-19), so `synthesis` is the run's report text, not a new draft.";

    return (
        'You are the aggregator inside ONE run of a template role that declares `agents` > 1 (D-38). ' +
        `${count} fresh agents answered the same job independently; they never saw each other (P2, L-16), and the run must now answer ONCE: one report, one selection_note, one verdict set (D-38, D-34a).\n` +
        `You are shown each agent's final answer and the writes it proposed. Choose one agent.\n` +
        `${mode}\n` +
        'What you MUST NOT do: average the panel into a mush, or hide the split. The run reports the dissent whether or not you mention it, and a hidden disagreement is the one thing the Author cannot tune (D-38).\n\n' +
        `The Author's selection rules (D-17c), which the run applies:\n${selectionRules || '(none declared)'}\n\n` +
        'Answer with ONE JSON object and nothing else:\n' +
        '{"agent": <1-based agent number>, "reason": "<one line naming the rule you applied>", "synthesis": "<optional report text>"}'
    );
}

/** Renders all N proposals for the aggregator (T-7: bounded — one line per proposed call). */
function renderProposals(agents: PanelAgent[]): string {
    return agents
        .map((agent) => {
            const writes =
                agent.proposals.length === 0
                    ? '  (no writes proposed)'
                    : agent.proposals
                          .map((proposal) => `  - ${proposal.tool}: ${JSON.stringify(proposal.args)}`)
                          .join('\n');

            return `Agent ${agent.index} — answer:\n${agent.text.trim()}\nProposed writes:\n${writes}`;
        })
        .join('\n\n');
}

interface AggregatorAnswer {
    agent: number;
    reason: string;
    synthesis?: string;
}

/**
 * Parses the aggregator's pick. Anything unusable returns `undefined` and the caller falls back
 * to the counted majority: a panel MUST answer once (D-38), so an aggregator that mumbles is
 * degraded rather than fatal — and the fallback is deterministic, which matters because the same
 * disagreement should aggregate the same way twice.
 */
export function parseAggregatorAnswer(content: string, count: number): AggregatorAnswer | undefined {
    const match = /\{[\s\S]*\}/.exec(content);

    if (!match) return undefined;

    let parsed: unknown;

    try {
        parsed = JSON.parse(match[0]);
    } catch {
        return undefined;
    }

    if (typeof parsed !== 'object' || parsed === null) return undefined;

    const record = parsed as Record<string, unknown>;
    const agent = Number(record.agent);

    if (!Number.isInteger(agent) || agent < 1 || agent > count) return undefined;

    return {
        agent,
        reason: typeof record.reason === 'string' ? record.reason : '',
        synthesis:
            typeof record.synthesis === 'string' && record.synthesis.trim().length > 0 ? record.synthesis : undefined
    };
}

// ---------------------------------------------------------------------------
// Majority grouping and the dissent sentence
// ---------------------------------------------------------------------------

/**
 * Groups the agents' primary actions (D-38: "group by tool name + normalized key args").
 * `primaryActionOf` picks each agent's decisive write, so an agent that read thirty records and
 * filed one verdict counts exactly once.
 */
export function groupPrimaryActions(agents: readonly PanelAgent[]): ProposalGroup[] {
    const groups = new Map<string, ProposalGroup>();

    for (const agent of agents) {
        const primary = primaryActionOf(agent.proposals);

        if (primary === undefined) continue;

        const key = proposalKey(primary.tool, primary.args);
        const existing = groups.get(key);

        if (existing === undefined) {
            groups.set(key, {
                key,
                label: describeProposal(primary.tool, primary.args),
                count: 1,
                firstAgent: agent.index
            });

            continue;
        }

        existing.count += 1;
    }

    // Most-chosen first; equal counts resolve by the earliest agent, which is also what makes the
    // `lead` tie-break ("first agent wins ties") consistent with how `majority` handles a tie.
    return [...groups.values()].sort((left, right) => right.count - left.count || left.firstAgent - right.firstAgent);
}

/**
 * The dissent sentence D-38 requires, in the shape the spec itself demonstrates
 * ("2 of 3 preferred draft 1; selected 2 on the must_happen rule").
 *
 * `panelSize` is N, not the number of groups, so the Author can see how many agents answered at
 * all. Unanimity returns an empty string: there is no disagreement to surface, and a note that
 * recites "3 of 3 preferred X" on every selection teaches the Author to skim past the ones that
 * matter.
 */
export function dissentSentence(
    groups: readonly ProposalGroup[],
    winner: ProposalGroup | undefined,
    panelSize: number,
    reason: string
): string {
    if (winner === undefined || panelSize <= 1 || groups.length <= 1) return '';

    const counts = groups.map((group) => `${group.count} of ${panelSize} preferred ${group.label}`);

    return `${counts.join('; ')}; selected ${winner.label} on ${reason}`;
}

/** Appends the dissent to the field D-38 names for this tool, keeping whatever the agent wrote. */
function withDissent(tool: string, args: Record<string, unknown>, dissent: string): Record<string, unknown> {
    const field = dissentFieldFor(tool);

    if (field === undefined || dissent === '') return args;

    const existing = typeof args[field] === 'string' ? (args[field] as string) : '';

    // The agent's own reasoning first: D-38 wants the rule and the preference IN the note, and the
    // panel's split rides on top of it rather than replacing it (P11 keeps the reasoning auditable).
    return { ...args, [field]: existing.trim().length > 0 ? `${existing} | ${dissent}` : dissent };
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/**
 * D-38's interception, implemented as a runtime wrapper rather than a tool-layer hook.
 *
 * WHY A WRAPPER: the tool layer's hook bag (`CreateContextHooks` in `src/server/tools/types.ts`)
 * carries only `delegate`, and this workstream does not own `src/server/tools/**`. Asking T3 for a
 * new seam would put a panel concept in the layer that only knows about permissions and CAS, so the
 * panel intercepts one level up, where it already decides what a proposal means.
 *
 * THE RULE IT ENFORCES (D-38): reads execute for real — a panel agent that cannot read cannot
 * judge — and every MUTATING call is recorded and answered with a `summary` the agent can see, so
 * it does not retry a write it believes already happened (T-11's point about a visible refusal
 * applies to a visible proposal too). Nothing lands until the aggregation picks one agent's set,
 * which is what keeps "one Editor or a panel" from writing three competing answers.
 */
export function interceptingRuntime(base: ToolRuntime, index: number, proposals: PanelProposal[]): ToolRuntime {
    return {
        // T-6a: the agent sees the whole catalogue, exactly as the run itself does.
        schemas: () => base.schemas(),
        createContext: (session, hooks) => base.createContext(session, hooks),
        async execute(context, name, args) {
            if (!isMutatingTool(name)) return base.execute(context, name, args);

            proposals.push({ tool: name, args });

            return {
                ok: true,
                summary: `recorded as agent ${index}'s proposal — the run aggregates its panel and executes one winning set (D-38)`,
                proposed: true
            };
        }
    };
}

/**
 * Runs the panel and returns the single answer the run reports. Tokens from every agent and from
 * the aggregator land in the run's tally (S-6): the run's total is the whole run's, including
 * whatever its internals cost, and S-6 says that number is informational only (E-0).
 */
export async function runPanel(deps: LoopDeps, spec: PanelSpec, tally: RunTally): Promise<PanelOutcome> {
    const agents: (PanelAgent | undefined)[] = new Array(spec.count);

    // N loops started together and awaited together: L-16's "spawned together" and P2's blindness
    // are the same property, and running them sequentially would let agent 2 read what agent 1
    // wrote — a panel that converges because it can see itself is not a panel.
    const started = Array.from({ length: spec.count }, async (_unused, position) => {
        const index = position + 1;
        const label = panelAgentRoleLabel(spec.roleName, index);
        const proposals: PanelProposal[] = [];

        // A per-agent tally, merged into the run's at the end: the nested crew entry carries this
        // agent's own token count (S-6 per-run reporting is per-sub-context too, U-7), and agents
        // sharing one counter across interleaved awaits would report numbers that add to nothing.
        const agentTally: RunTally = createTally();

        // D-38 interception: reads execute for real (a panel agent that cannot read cannot judge);
        // every write is recorded instead, so the losing agents write nothing at all.
        const agentRuntime = interceptingRuntime(deps.runtime, index, proposals);
        const hooks: RunToolHooks = {
            // D-17e: a panel agent may still fan out. Its sub-context is NOT intercepted — the
            // parent agent's own writes are what the panel aggregates, and a sub-context writes for
            // the parent run under T-2b's rule that it can do whatever the parent could.
            delegate: spec.delegate
        };

        const context = spec.createContext(
            {
                storyId: spec.storyId,
                runId: spec.runId,
                // T-2b/S-7: the sub-context carries the PARENT's runRef, so anything that does
                // land is attributable to the dispatched run and never to a phantom run row.
                runRef: spec.runId,
                sessionRef: `sess_${spec.runId}`,
                templateRef: spec.templateRef,
                roleName: spec.roleName,
                roleKind: spec.roleKind,
                agents: spec.count,
                aggregate: spec.aggregate,
                delegatedRole: label,
                // U-1e: a panel agent writes for its run, so an Author-invoked run's panel keeps the
                // assistant flag (§2) rather than attributing the write to a plain dispatched crew run.
                assistant: spec.assistant
            },
            hooks
        );

        const outcome = await runAgentLoop(
            { chat: deps.chat, runtime: agentRuntime, heartbeat: spec.heartbeat },
            {
                label,
                // The same brief, plus the one fact an agent needs about its own writes (D-38).
                system: `${spec.brief}\n${panelPreamble(index, spec.count, spec.aggregate)}`,
                kickoff: spec.kickoff,
                model: spec.model,
                context,
                // U-1e: the run's own tool list — see `PanelSpec.tools`.
                tools: spec.tools,
                signal: spec.signal
            },
            agentTally
        );

        agents[position] = { index, label, text: outcome.text, proposals, tokens: agentTally.tokens };

        // S-7: the panel's agents nest on the run row; they are not Work Items and have no rows.
        spec.addDelegated({ role: label, task: spec.jobSummary, summary: outcome.text, tokens: agentTally.tokens });

        return agents[position];
    });

    // `allSettled`, not `all`: a panel that loses one of three agents still answers once (D-38),
    // and the loop's one report is worth more to the Author than one agent's transport fault.
    const settled = await Promise.allSettled(started);
    const answered = agents.filter((agent): agent is PanelAgent => agent !== undefined);

    // Every agent failed → nothing to aggregate and the run genuinely failed: rethrow the first
    // reason so the executor records it (S-3) rather than reporting an empty panel.
    if (answered.length === 0) {
        const failure = settled.find((outcome) => outcome.status === 'rejected');

        throw failure && failure.status === 'rejected' ? failure.reason : new Error('panel produced no answers (D-38)');
    }

    // Tokens still merge into the run's total even when the run later fails (S-6, E-0).
    for (const agent of answered) tally.tokens += agent.tokens;

    const wrote = answered.filter((agent) => agent.proposals.length > 0);

    if (wrote.length === 0) {
        // Nobody wrote anything: there is nothing to aggregate, so the run reports what its agents
        // read. The loop counts it as a no-op (S-4) — correctly, since nothing was reported.
        return {
            text: answered
                .map((agent) => agent.text)
                .filter(Boolean)
                .join('\n\n'),
            dissent: '',
            answered: answered.length
        };
    }

    const groups = groupPrimaryActions(answered);
    const pick = await chooseAggregation(deps, spec, answered, groups, tally);

    const winner = answered.find((agent) => agent.index === pick.winner) ?? wrote[0];
    const winnerGroup = groups.find((group) => group.firstAgent === winner.index);
    const dissent = dissentSentence(groups, winnerGroup, spec.count, pick.reason);

    // ONE report surface: only the winning set executes, and it executes on the parent's context,
    // so the write carries the dispatched run's identity and permission row (D-38, T-2b, P11).
    for (const proposal of winner.proposals) {
        await deps.runtime.execute(
            spec.parentContext,
            proposal.tool,
            withDissent(proposal.tool, proposal.args, dissent)
        );
        spec.onExecuted(proposal.tool);
    }

    return { text: pick.synthesis ?? winner.text, dissent, answered: answered.length };
}

/**
 * Chooses which agent's proposals the run executes.
 *
 * `majority` is decided with no model call — D-38's counting is arithmetic, and G-3 keeps
 * mechanical questions out of an LLM's judgment. `merge` and `lead` ask the aggregator, and both
 * fall back to the counted majority when that call cannot answer: a panel that failed to
 * aggregate would leave the run with no report at all, which is worse for the Author than a
 * deterministic pick with the reason recorded in the note.
 */
async function chooseAggregation(
    deps: LoopDeps,
    spec: PanelSpec,
    agents: PanelAgent[],
    groups: ProposalGroup[],
    tally: RunTally
): Promise<AggregationResult> {
    // Counted, not judged: D-38's aggregation is arithmetic for `majority`, and the reason string
    // has to tell the Author whether the panel actually agreed or merely tied — `groups[0]` is
    // always one of the groups, so "is there a tie" is "does another group share the top count".
    const top = groups[0];
    const tied = groups.length > 1 && groups.filter((group) => group.count === top.count).length > 1;

    const fallback: AggregationResult = {
        winner: top?.firstAgent ?? 1,
        reason:
            groups.length === 0
                ? 'no agent proposed a write'
                : groups.length === 1
                  ? `unanimity (${top.count} of ${spec.count})`
                  : tied
                    ? `majority tie at ${top.count} of ${spec.count} — earliest agent taken`
                    : `majority ${top.count} of ${spec.count}`
    };

    if (spec.aggregate === 'majority') return fallback;

    try {
        const response = await deps.chat.complete({
            model: spec.model,
            // No tools for the aggregator: it picks, it does not work — so the loop still receives
            // exactly one report, from the winning set (D-38).
            messages: [
                { role: 'system', content: aggregatorPrompt(spec.count, spec.aggregate, spec.selectionRules) },
                { role: 'user', content: renderProposals(agents) }
            ],
            signal: spec.signal
        });

        // The aggregator's own tokens belong to the run (S-6).
        tally.tokens += (response.usage?.input ?? 0) + (response.usage?.output ?? 0);

        const answer = parseAggregatorAnswer(response.message.content ?? '', spec.count);

        if (answer === undefined)
            return {
                ...fallback,
                reason: `${fallback.reason}; the aggregator gave no usable pick, so the count decided`
            };

        return { winner: answer.agent, reason: answer.reason || fallback.reason, synthesis: answer.synthesis };
    } catch (error) {
        // An abort propagates (S-3): a killed run does not get to finish its aggregation.
        if ((error as { name?: string } | undefined)?.name === 'AbortError') throw error;

        return {
            ...fallback,
            reason: `${fallback.reason}; the aggregator call failed (${error instanceof Error ? error.message : String(error)})`
        };
    }
}

/** The report surface the loop is told about — exported so the executor's messaging stays consistent. */
export const reportToolList = REPORT_TOOLS;
