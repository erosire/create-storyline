/**
 * Unit tests for the Critic termination policy (./critic-termination) — the decisions the shipped
 * path makes, asserted at the boundary the engine actually calls.
 *
 * WHY A SEPARATE FILE FROM ./story-engine.test.ts: that file proves the policy through the real
 * engine (how many provider calls a pass costs, what the row and the thread record say). This one
 * pins the VOCABULARY the rail, the run row and the operator depend on — the cap and its environment
 * override, the terminal-tool set and its relationship to S-4's report list, and the exact sentences
 * the plugin hands to the engine's `stop` and to the host ledger. Those strings are contracts, and a
 * engine-level test can only see them indirectly.
 *
 * The hooks are driven through a captured-handler double for `HarnessPluginApi`: `setup` is the whole
 * surface the engine uses, and every payload here carries exactly the fields the hook reads
 * (`agent`, `threadId`, `iteration`, `message` / `currentMessages()`), which is the same shape the
 * engine commits — pinned against the real engine in ./story-engine.test.ts.
 *
 * THE SHIPPED RULE, stated before the mechanics (2026-11-26): ONLY a SUCCESSFUL terminal report ends a
 * Critic pass. A `submitVerdict` the tool REFUSES files nothing, so it ends NOTHING — it arms neither
 * the stop nor the nudge, because the engine commits the refusal as that call's own tool message and the
 * pass keeps its next turn to answer it ('leaves a REFUSED terminal report its correction turn, and files
 * when the pass fixes it'); a pass whose verdict never got filed is ended only by the turn cap, and the
 * cap's own sentence says so ('names the refusal when the cap catches a pass whose verdict never got
 * filed'). Only `ok: true` concludes a pass, and then at the NEXT boundary — 'ends the pass on the verdict
 * alone, and only on the verdict' and 'ends the pass at the next boundary after the verdict, with the
 * sentence and the ledger record'.
 *
 * THE THIRD INPUT IS A HOST CALL, NOT A HOOK, which is how that rule is observable.
 * `handle.toolResult(threadId, tool, ok)` is how the host reports what a call ANSWERED, and a Critic pass
 * is classified from THAT and not from the committed `toolCalls` — because the tool layer can refuse the
 * request to file (T-1a) and nothing the hooks carry can see it (`isError`/`outcome` say `completed` for a
 * `{ ok: false }` value, per harness/src/engine/core/tool-outcome.ts). So every test below that wants a
 * report FILED calls the sink with `ok: true`, and the two refusal tests call it with `ok: false`: one
 * asserts the pass KEPT RUNNING on its correction turn, the other that the CAP ended it with the refusal
 * named on the row.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HarnessMessage, HarnessPluginApi } from '@underload/harness';
import { REPORT_TOOLS, isReportTool } from '../catalogue';
import {
    CRITIC_CONCLUDE_NUDGE,
    CRITIC_REVIEW_TURN_CAP,
    CRITIC_TERMINAL_REPORT_TOOLS,
    CRITIC_TURN_CAP_ENV,
    createCriticTerminationPlugin,
    criticTurnCapFromEnvironment,
    isTerminalCriticReport
} from './critic-termination';

/** What a `turn.before` handler answers: nothing, or a decision for the engine to honour. */
interface TurnDecision {
    decision?: { action: string; reason?: string; transcript?: HarnessMessage[] };
}

/** The hook payload fields this policy reads — the ones a `turn.before` frame carries. */
interface BeforePayloadLike {
    agent: string;
    threadId: string;
    iteration: number;
    currentMessages: () => HarnessMessage[];
}

/** The hook payload fields a `turn.after` frame carries: the COMMITTED assistant message. */
interface AfterPayloadLike {
    agent: string;
    threadId: string;
    iteration: number;
    message: { content?: string; toolCalls?: Array<{ name: string; args?: Record<string, unknown> }> };
}

/**
 * A plugin wired to captured handlers, so a test can drive one thread's turn boundary directly.
 * `cap` is passed only when the test wants a bound other than the environment's.
 */
const wire = (cap?: number) => {
    const { plugin, ledger, cap: effectiveCap, toolResult } = createCriticTerminationPlugin(
        cap === undefined ? {} : { cap }
    );

    let before: ((payload: BeforePayloadLike) => TurnDecision | undefined) | undefined;
    let after: ((payload: AfterPayloadLike) => void) | undefined;

    // Only `on` is ever called by the engine during `setup`; the rest of `HarnessPluginApi` (tools,
    // threads, events) is this policy's way of ignoring them, so the double states that explicitly.
    const api = {
        on: (hook: string, handler: (payload: never) => unknown) => {
            if (hook === 'turn.before') before = handler as unknown as typeof before;
            if (hook === 'turn.after') after = handler as unknown as typeof after;
        }
    } as unknown as HarnessPluginApi;

    // `setup` is optional on `HarnessPlugin` (a plugin may exist to contribute tools only); this one
    // always carries it, and the guard says so instead of silently testing nothing.
    if (plugin.setup === undefined) throw new Error('critic-termination must install a setup hook');
    plugin.setup(api);

    const transcript: HarnessMessage[] = [{ role: 'user', content: 'the review brief' }];

    return {
        ledger,
        cap: effectiveCap,
        /** The assistant message the engine committed for turn `iteration`. */
        turnAfter: (
            threadId: string,
            iteration: number,
            message: AfterPayloadLike['message'],
            agent = 'critic'
        ): void => {
            after?.({ agent, threadId, iteration, message });
        },
        /** The boundary BEFORE the model is asked for turn `iteration`. */
        turnBefore: (threadId: string, iteration: number, agent = 'critic'): TurnDecision | undefined =>
            before?.({ agent, threadId, iteration, currentMessages: () => transcript }),
        /**
         * What the host's tool bridge reports when the call finishes: the tool's OWN verdict. `ok:
         * false` is a T-1a refusal, and it is the only input that can keep a pass alive after it asked
         * to file a verdict.
         */
        toolResult: (threadId: string, tool: string, ok: boolean): void => {
            toolResult(threadId, tool, ok);
        },
        /** The request the model would receive — what a `replace` decision rewrites. */
        transcript
    };
};

afterEach(() => {
    // Every env stub is scoped to one test: the cap is read from `process.env` at call time, and a
    // leaked value would change what the NEXT test calls the default.
    vi.unstubAllEnvs();
});

describe('the Critic review-turn cap (C2-AD3, objective 2)', () => {
    it('names the documented default and the operator override it reads', () => {
        // 24 model turns ≈ 2x the most expensive measured legitimate pass (380k tokens at ~40k/turn).
        // Pinned at the DEFINITION: the run-row sentence the rail renders quotes this number, and the
        // executor's capped sentence interpolates it, so a silent retune has to fail here first.
        expect(CRITIC_REVIEW_TURN_CAP).toBe(24);
        expect(CRITIC_TURN_CAP_ENV).toBe('STORYLINE_CRITIC_TURN_CAP');
    });

    it('takes the environment value when the operator set one, and the fallback when they did not', () => {
        const cases: Array<[string | undefined, number]> = [
            [undefined, CRITIC_REVIEW_TURN_CAP], // unset — the default
            ['', CRITIC_REVIEW_TURN_CAP], // set but blank, which is how a shell "unset" arrives
            ['   ', CRITIC_REVIEW_TURN_CAP], // whitespace only
            ['9', 9], // a real override
            ['  12  ', 12], // trimmed, because operators paste
            ['0', CRITIC_REVIEW_TURN_CAP], // zero is not a bound: it would end every pass at turn one
            ['-4', CRITIC_REVIEW_TURN_CAP], // negative, same reason
            ['twelve', CRITIC_REVIEW_TURN_CAP], // unreadable, and the boot must not fail over it
            ['0.5', CRITIC_REVIEW_TURN_CAP] // rounds to nothing, so it is not a bound either
        ];

        for (const [value, expected] of cases) {
            if (value === undefined) vi.stubEnv(CRITIC_TURN_CAP_ENV, undefined);
            else vi.stubEnv(CRITIC_TURN_CAP_ENV, value);

            expect(criticTurnCapFromEnvironment()).toBe(expected);
        }

        // The fallback is a parameter, because `run/loop.ts`'s hand-written loop passes its own spec
        // default through the same reader.
        vi.stubEnv(CRITIC_TURN_CAP_ENV, 'twelve');
        expect(criticTurnCapFromEnvironment(3)).toBe(3);
        vi.stubEnv(CRITIC_TURN_CAP_ENV, '5');
        expect(criticTurnCapFromEnvironment(3)).toBe(5);
    });

    it('builds the plugin at the environment cap, and lets the host override it outright', () => {
        vi.stubEnv(CRITIC_TURN_CAP_ENV, '7');

        expect(createCriticTerminationPlugin().cap).toBe(7);
        // An explicit host option always wins — `StoryHarness` passes one whenever the host configured
        // `criticTurnCap`, and a test rig must not be at the mercy of the process environment.
        expect(createCriticTerminationPlugin({ cap: 2 }).cap).toBe(2);

        vi.unstubAllEnvs();

        expect(createCriticTerminationPlugin().cap).toBe(CRITIC_REVIEW_TURN_CAP);
    });
});

describe('the terminal report set (C2-AD3, objective 1)', () => {
    it('ends the pass on the verdict alone, and only on the verdict', () => {
        // `submitVerdict` is the one call that carries the review's verdicts and findings.
        expect([...CRITIC_TERMINAL_REPORT_TOOLS]).toEqual(['submitVerdict']);
        expect(isTerminalCriticReport('submitVerdict')).toBe(true);
        // A finding or an Idea is S-4's report but NOT a conclusion: the pass that filed one has work
        // left, so it gets the nudge and the cap instead of an end.
        expect(isTerminalCriticReport('raiseFinding')).toBe(false);
        expect(isTerminalCriticReport('proposeIdea')).toBe(false);
        expect(isTerminalCriticReport('readChapter')).toBe(false);
    });

    it('narrows S-4’s report list rather than inventing a parallel one', () => {
        // The reuse contract: every terminal tool is one of `run/catalogue.ts`'s report tools, so the
        // pass cannot end on a call the loop does not already count as work it must not re-dispatch.
        expect(CRITIC_TERMINAL_REPORT_TOOLS.filter((tool) => !(REPORT_TOOLS as readonly string[]).includes(tool))).toEqual([]);
        // And the narrowing is real — S-4's list is wider, which is why `raiseFinding` arms the nudge
        // without ending anything.
        expect(isReportTool('raiseFinding')).toBe(true);
        expect(REPORT_TOOLS.length > CRITIC_TERMINAL_REPORT_TOOLS.length).toBe(true);
    });
});

describe('the plugin’s decisions on one Critic thread (C2-AD3)', () => {
    it('ends the pass at the next boundary after the verdict, with the sentence and the ledger record', () => {
        const pass = wire(24);

        // Turn 1 reads. Nothing has been reported, so the boundary before turn 2 changes nothing.
        expect(pass.turnBefore('t1', 1)).toBeUndefined();
        pass.turnAfter('t1', 1, { content: 'reading the chapter', toolCalls: [{ name: 'readChapter', args: { chapter_id: 'chapter_0' } }] });
        expect(pass.turnBefore('t1', 2)).toBeUndefined();

        // Turn 2 commits `submitVerdict`. `turn.after` fires BEFORE the tool launches, so the stop can
        // not be taken there — and it is not taken from that message at all: what arms it is the tool's
        // ANSWER, which the host reports between the two boundaries.
        pass.turnAfter('t1', 2, {
            content: 'the steeple answer pays off; the map line does not',
            toolCalls: [{ name: 'submitVerdict', args: { target_ref: 'chapter_0' } }]
        });

        // THE REQUEST IS NOT THE FILING: at the boundary right after the commit and BEFORE the result,
        // the pass is still running. This is the exact assertion the shipped path used to fail — the
        // stop was armed off `toolCalls`, so a verdict the tool then refused ended the run anyway.
        expect(pass.turnBefore('t1', 3)).toBeUndefined();

        // The tool answers, and the NEXT boundary is where the engine stops: by then the verdict row is
        // committed, and no further model request is issued.
        pass.toolResult('t1', 'submitVerdict', true);

        expect(pass.turnBefore('t1', 3)).toEqual({
            decision: {
                action: 'stop',
                reason: 'the Critic filed its report (submitVerdict) at model turn 2 — the pass is complete (C2-AD3)'
            }
        });

        // The host reads the SAME fact back out of the ledger — the rejection the engine raises carries
        // no machine-readable code, which is why this record exists at all.
        expect(pass.ledger.take('t1')).toEqual({
            kind: 'reported',
            thread_id: 't1',
            turns: 2,
            cap: 24,
            reports: ['submitVerdict'],
            terminal_tool: 'submitVerdict',
            final_text: 'the steeple answer pays off; the map line does not',
            nudged: false,
            reason: 'the Critic filed its report (submitVerdict) at model turn 2 — the pass is complete (C2-AD3)'
        });
        // Consumed once: a later run on a surviving thread cannot inherit this conclusion.
        expect(pass.ledger.take('t1')).toBeUndefined();
    });

    it('nudges once, only after a report, and rewrites the request rather than the transcript', () => {
        const pass = wire(24);

        // The first boundary: nothing has been filed, so the pass is left alone.
        expect(pass.turnBefore('t1', 1)).toBeUndefined();
        // Turn 1 files a FINDING — a partial report. Nothing ends.
        pass.turnAfter('t1', 1, { content: 'one defect', toolCalls: [{ name: 'raiseFinding', args: { criterion_ref: 'C-14' } }] });
        pass.toolResult('t1', 'raiseFinding', true);

        // The first boundary after the report: the instruction is appended to the request the model is
        // about to receive, after everything an earlier hook in the round produced.
        expect(pass.turnBefore('t1', 2)).toEqual({
            decision: {
                action: 'replace',
                transcript: [{ role: 'user', content: 'the review brief' }, { role: 'user', content: CRITIC_CONCLUDE_NUDGE }]
            }
        });

        // AT MOST ONCE, even though the pass keeps reading: the override never reaches the canonical
        // transcript, so a second injection would be the model reading its own instruction twice.
        pass.turnAfter('t1', 2, { content: 'still reading', toolCalls: [{ name: 'readChapter', args: { chapter_id: 'chapter_0' } }] });
        expect(pass.turnBefore('t1', 3)).toBeUndefined();
        pass.turnAfter('t1', 3, { content: 'still reading', toolCalls: [{ name: 'readChapter', args: { chapter_id: 'chapter_0' } }] });
        expect(pass.turnBefore('t1', 4)).toBeUndefined();

        expect(pass.ledger.observe('t1')).toEqual({ turns: 3, reports: ['raiseFinding'], refusals: [], nudges: 1 });
        // A partial report never produces a terminal record: there is nothing for the host to record.
        expect(pass.ledger.take('t1')).toBeUndefined();
    });

    it('caps a pass that never concludes, and records the bound it hit', () => {
        const pass = wire(2);

        expect(pass.turnBefore('t1', 1)).toBeUndefined();
        pass.turnAfter('t1', 1, { content: 'reading', toolCalls: [{ name: 'readChapter', args: { chapter_id: 'chapter_0' } }] });
        expect(pass.turnBefore('t1', 2)).toBeUndefined();
        pass.turnAfter('t1', 2, { content: 'reading again', toolCalls: [{ name: 'readChapter', args: { chapter_id: 'chapter_0' } }] });

        // Turn 3 would be the third request; the bound says it is never issued.
        expect(pass.turnBefore('t1', 3)).toEqual({
            decision: {
                action: 'stop',
                reason: 'the Critic review pass reached its 2-model-turn cap without filing its verdict (C2-AD3)'
            }
        });

        const record = pass.ledger.take('t1');

        expect(record).toEqual({
            kind: 'capped',
            thread_id: 't1',
            turns: 2,
            cap: 2,
            reports: [],
            // The prose the pass did write is kept, so the thread still ANSWERS even without a verdict.
            final_text: 'reading again',
            nudged: false,
            reason: 'the Critic review pass reached its 2-model-turn cap without filing its verdict (C2-AD3)'
        });
        // A capped pass names no terminal tool: naming one would claim a verdict that was never filed.
        expect(record?.terminal_tool).toBeUndefined();
    });

    it('leaves a REFUSED terminal report its correction turn, and files when the pass fixes it', () => {
        const pass = wire(24);

        expect(pass.turnBefore('t1', 1)).toBeUndefined();
        pass.turnAfter('t1', 1, { content: 'reading', toolCalls: [{ name: 'readChapter', args: { chapter_id: 'chapter_0' } }] });
        pass.toolResult('t1', 'readChapter', true);
        expect(pass.turnBefore('t1', 2)).toBeUndefined();

        // The pass asks to file, and the tool layer REFUSES the call (T-1a: an evidence field that
        // quotes an absence). Nothing was written, so nothing concluded: the pass keeps its turn, and
        // the refusal — committed by the engine as this call's own tool message — is what it answers.
        pass.turnAfter('t1', 2, {
            content: 'verdict filed',
            toolCalls: [{ name: 'submitVerdict', args: { target_ref: 'chapter_0' } }]
        });
        pass.toolResult('t1', 'submitVerdict', false);

        // N1 AT THE BOUNDARY: no stop. This is the exact call site that used to end the run.
        expect(pass.turnBefore('t1', 3)).toBeUndefined();
        // And the refusal did NOT arm the nudge either: "you have already filed a report" would be a
        // lie here, and the refusal is already the instruction the model has to answer.
        expect(pass.ledger.observe('t1')).toEqual({ turns: 2, reports: [], refusals: ['submitVerdict'], nudges: 0 });
        expect(pass.ledger.take('t1')).toBeUndefined();

        // The corrected call FILES, and the pass ends exactly as an unwounded one would — on the result,
        // at the next boundary, with no further model turn.
        pass.turnAfter('t1', 3, {
            content: 'verdict filed, with the quotation',
            toolCalls: [{ name: 'submitVerdict', args: { target_ref: 'chapter_0' } }]
        });
        pass.toolResult('t1', 'submitVerdict', true);

        expect(pass.turnBefore('t1', 4)).toEqual({
            decision: {
                action: 'stop',
                reason: 'the Critic filed its report (submitVerdict) at model turn 3 — the pass is complete (C2-AD3)'
            }
        });

        // The record keeps BOTH facts: it filed, and it had been refused on the way. A reader must not
        // have to guess whether the pass answered on its first try.
        expect(pass.ledger.take('t1')).toEqual({
            kind: 'reported',
            thread_id: 't1',
            turns: 3,
            cap: 24,
            reports: ['submitVerdict'],
            refusals: ['submitVerdict'],
            terminal_tool: 'submitVerdict',
            final_text: 'verdict filed, with the quotation',
            nudged: false,
            reason: 'the Critic filed its report (submitVerdict) at model turn 3 — the pass is complete (C2-AD3)'
        });
    });

    it('names the refusal when the cap catches a pass whose verdict never got filed', () => {
        const pass = wire(2);

        expect(pass.turnBefore('t1', 1)).toBeUndefined();
        pass.turnAfter('t1', 1, { content: 'reading', toolCalls: [{ name: 'readChapter', args: { chapter_id: 'chapter_0' } }] });
        pass.toolResult('t1', 'readChapter', true);
        expect(pass.turnBefore('t1', 2)).toBeUndefined();

        // The verdict is asked for and refused on the last turn the cap allows: the pass is over, and it
        // is over WITHOUT its verdict — but it is not the same run as the one that never asked.
        pass.turnAfter('t1', 2, {
            content: 'verdict filed',
            toolCalls: [{ name: 'submitVerdict', args: { target_ref: 'chapter_0' } }]
        });
        pass.toolResult('t1', 'submitVerdict', false);

        expect(pass.turnBefore('t1', 3)).toEqual({
            decision: {
                action: 'stop',
                reason: 'the Critic review pass reached its 2-model-turn cap with its submitVerdict report refused and never filed (C2-AD3)'
            }
        });

        expect(pass.ledger.take('t1')).toEqual({
            kind: 'capped',
            thread_id: 't1',
            turns: 2,
            cap: 2,
            reports: [],
            refusals: ['submitVerdict'],
            final_text: 'verdict filed',
            nudged: false,
            reason: 'the Critic review pass reached its 2-model-turn cap with its submitVerdict report refused and never filed (C2-AD3)'
        });
    });

    it('refuses to classify a call the policy never watched, so no other employee gains a state', () => {
        const pass = wire(1);

        // THE SINK IS GATED BY THE ROLE GATE, not by its own argument: the host reports every executed
        // tool of every thread, and a Writer's `submitVerdict` must not open state, arm a stop, or make
        // this policy's map grow for employees it never watches (T-6a makes the catalogue role-blind).
        pass.toolResult('t_writer', 'submitVerdict', true);
        pass.toolResult('t_writer', 'raiseFinding', false);

        expect(pass.ledger.observe('t_writer')).toBeUndefined();
        expect(pass.ledger.take('t_writer')).toBeUndefined();
    });

    it('says nothing about any other employee', () => {
        const pass = wire(1);

        // A WRITER can call `submitVerdict` — the catalogue is role-blind (T-6a) — and the bound here is
        // deliberately 1, so a policy that leaked past the role gate would end the run on the spot.
        pass.turnAfter('t1', 2, { content: 'verdict filed', toolCalls: [{ name: 'submitVerdict' }] }, 'writer');
        expect(pass.turnBefore('t1', 2, 'writer')).toBeUndefined();
        expect(pass.turnBefore('t1', 9, 'writer')).toBeUndefined();
        // The thread never enters the policy's state at all.
        expect(pass.ledger.observe('t1')).toBeUndefined();
        expect(pass.ledger.take('t1')).toBeUndefined();
    });

    it('forgets a thread the host released, and bounds the map it never gets to release', () => {
        const pass = wire(24);

        pass.turnAfter('t1', 1, { content: 'reading', toolCalls: [{ name: 'readChapter', args: { chapter_id: 'chapter_0' } }] });
        expect(pass.ledger.observe('t1')).toEqual({ turns: 1, reports: [], refusals: [], nudges: 0 });

        pass.ledger.release('t1');

        expect(pass.ledger.observe('t1')).toBeUndefined();
        expect(pass.ledger.take('t1')).toBeUndefined();

        // The belt, not the mechanism: `StoryHarness` releases every thread in its `finally`, and this
        // ceiling only guarantees a leaked key cannot grow the map forever. Insertion order decides the
        // eviction, so the first thread watched is the first one dropped.
        for (let index = 0; index < 513; index += 1) {
            pass.turnAfter(`thread_${String(index)}`, 1, { content: 'reading' });
        }

        expect(pass.ledger.observe('thread_0')).toBeUndefined();
        expect(pass.ledger.observe('thread_1')).toEqual({ turns: 1, reports: [], refusals: [], nudges: 0 });
        expect(pass.ledger.observe('thread_512')).toEqual({ turns: 1, reports: [], refusals: [], nudges: 0 });
    });
});
