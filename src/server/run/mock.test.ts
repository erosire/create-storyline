/**
 * The mock crew's copy of the issues-first rules (D-33c at filing, D-33d at approval).
 *
 * WHY THIS FILE EXISTS: `MockToolRuntime` is not a stub, it is the double every loop, API and executor
 * test runs its crew through (`run/mock.ts:defaultTools`), and a double that lets a scripted crew do what
 * the product forbids is worse than no double at all — the suite would go green on a sequence the server
 * refuses. So the two mirrors (`raiseFinding`'s D-33c gates and `approveFinding`'s D-33d gate) are pinned
 * HERE, against the same exact refusal objects the real tools throw, and both read the same shared
 * predicates (`loop/records.ts:openIssueFindings`, `findingsRaisedByRun`) rather than a private re-read of
 * the rule. The real-tool side of the same contract lives in `src/server/tools/runtime.test.ts`; the
 * engine/API side lives in `src/server/loop/findings.test.ts` and `src/server/api/approve-all.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { Store } from '../store';
import { MockToolRuntime, seedFinding, seedStory } from './mock';
import type { RunToolSession } from './types';

/**
 * A CRITIC session on this Story, bound the way `run/executor.ts` binds one (T-3: the Story is fixed by
 * the session, never by the args). One `runId` is one review PASS, which is the unit D-33c's no-mixing
 * rule counts — so a test that wants two passes asks for two sessions, exactly as two dispatched runs get
 * two.
 */
const sessionFor = (runId: string): RunToolSession => ({
    storyId: 'story_0',
    runId,
    runRef: runId,
    sessionRef: `sess_${runId}`,
    templateRef: 'critic-genre',
    roleName: 'critic',
    roleKind: 'critic'
});

/** The crew, on a bare book: the runtime, the store, and one way to call a tool as one of its passes. */
function crew() {
    const store = Store.empty();
    const story = seedStory(store);
    const runtime = new MockToolRuntime(store, story.id);

    const call = (runId: string, name: string, args: Record<string, unknown>) =>
        runtime.execute(runtime.createContext(sessionFor(runId)), name, args);

    return { store, story, runtime, call };
}

/** One defect, aimed at the chapter every §4 fixture already has. */
const defect = (title: string) => ({
    target_ref: 'chapter_1',
    criterion_ref: 'C-4',
    title,
    detail: 'chapter_1 sec_1 quotes the 1911 survey; the survey says otherwise',
    evidence: 'chapter_1 sec_1: "the 1911 survey"',
    cost: 'major',
    why: 'the review found a contradiction'
});

/** One improvement the Seed never promised — the row D-33c sequences behind the defects. */
const improvement = (title: string) => ({
    target_ref: 'chapter_1',
    criterion_ref: 'C-11',
    title,
    detail: 'opening on the lie gives chapter_2 its tension',
    evidence: 'chapter_1 sec_1: "he told them the truth"',
    cost: 'minor',
    kind: 'proposal',
    why: 'the pass is worth taking'
});

describe('the mock crew files under D-33c — issues before proposals, and never in one pass', () => {
    it('refuses a Proposal over an open issue, names the open rows, and files nothing (D-33c)', async () => {
        const { store, call } = crew();

        // The issue files first, and the double answers like the real tool does: the created row, its kind,
        // its rev — nothing about the happy path changed with this rule.
        expect(await call('run_0', 'raiseFinding', defect('the map contradicts the 1911 survey'))).toEqual({
            ok: true,
            finding_id: 'finding_0',
            kind: 'issue',
            rev: 1
        });

        const refused = await call('run_0', 'raiseFinding', improvement('open the book on the lie'));

        // The refusal object is what the model reads back, so its exact wording and its structured fields
        // are both product surface — this one mirrors `tools/reader.ts:raiseFinding`'s D-33c throw.
        expect(refused).toEqual({
            ok: false,
            refused: 'D-33c',
            message:
                'a proposal cannot be filed while 1 issue is unresolved — finding_0 — because a suggestion about a book that still has defects is not what the round is for. Every issue has to reach `fixed` or `discarded` before a proposal can be filed (D-33c).',
            open_issues: 1,
            open_issue_refs: ['finding_0']
        });
        // And the refusal is a refusal: the proposal never reached the board, so the queue, the dial and the
        // closure rules all see the one row the pass actually filed.
        expect(store.findings.list().map((row) => [row.id, row.kind ?? 'issue', row.state])).toEqual([
            ['finding_0', 'issue', 'unconfirmed']
        ]);
    });

    it('refuses an issue in the pass that already filed a Proposal, and keeps an issue filable in the next (D-33c)', async () => {
        // THE ASYMMETRY IS THE POINT, SO IT IS PINNED FROM BOTH SIDES. A pass that filed a Proposal first
        // may not also file a defect — the pass answered "what would be better?", and it stops there. A
        // DIFFERENT pass may file the defect at any time (a defect is always filable), which is also why
        // the proposal-after-issue direction needs no second rule: the issue is open, so the gate above
        // refuses the proposal. The attribution runs through the journal
        // (`loop/records.ts:findingsRaisedByRun`), because a finding carries no `run_ref` — which is why
        // the two directions of this test differ only in their `runId`.
        const { store, call } = crew();

        expect(await call('run_0', 'raiseFinding', improvement('open the book on the lie'))).toEqual({
            ok: true,
            finding_id: 'finding_0',
            kind: 'proposal',
            rev: 1
        });

        expect(await call('run_0', 'raiseFinding', defect('the map contradicts the 1911 survey'))).toEqual({
            ok: false,
            refused: 'D-33c',
            message:
                'this pass already filed finding_0 as `kind: proposal`, and an issue cannot share a review pass with a proposal (D-33c).',
            proposal_refs: ['finding_0']
        });

        // The next pass files the defect, rule notwithstanding: an open PROPOSAL does not hold an ISSUE
        // down, and a loop that refused the defect would refuse the very work that releases proposals.
        expect(await call('run_1', 'raiseFinding', defect('the map contradicts the 1911 survey'))).toEqual({
            ok: true,
            finding_id: 'finding_1',
            kind: 'issue',
            rev: 1
        });
        expect(store.findings.list().map((row) => [row.id, row.kind ?? 'issue'])).toEqual([
            ['finding_0', 'proposal'],
            ['finding_1', 'issue']
        ]);
    });

    it('releases the Proposal the moment the issue reaches a closed state (D-33c)', async () => {
        const { store, call } = crew();

        await call('run_0', 'raiseFinding', defect('the map contradicts the 1911 survey'));
        expect(await call('run_1', 'raiseFinding', improvement('open the book on the lie'))).toMatchObject({
            ok: false,
            refused: 'D-33c'
        });

        // The repair landing — `fixed` is one of the two states `records.ts:CLOSED_FINDING_STATES` counts
        // as closed, and it is the state the whole rule is waiting for.
        store.findings.update(
            'finding_0',
            { state: 'fixed' },
            { run_ref: null, author: true, why: 'seed: the repair landed (D-33c)' },
            [{ id: 'finding_0', rev: 1 }]
        );

        expect(await call('run_2', 'raiseFinding', improvement('open the book on the lie'))).toEqual({
            ok: true,
            finding_id: 'finding_1',
            kind: 'proposal',
            rev: 1
        });
    });
});

describe('the mock crew approves under D-33d — issues are in focus before a Proposal is approved', () => {
    it('refuses the approval, names the open issues, and leaves the row for the pass after them (D-33d)', async () => {
        const { store, call } = crew();

        // Both rows seeded straight in, so the approval path is the only variable: an open ISSUE and a
        // `confirmed` PROPOSAL, the exact desk the rule is about.
        seedFinding(store, 'story_0', { criterion_ref: 'C-4', title: 'the map contradicts the 1911 survey' });
        seedFinding(store, 'story_0', {
            criterion_ref: 'C-11',
            title: 'open the book on the lie',
            cost: 'minor',
            kind: 'proposal',
            state: 'confirmed'
        });

        expect(
            await call('run_0', 'approveFinding', { finding_id: 'finding_1', decision: 'approve', why: 'worth a pass' })
        ).toEqual({
            ok: false,
            refused: 'D-33d',
            message:
                'proposal finding_1 cannot be approved while 1 issue is unresolved — finding_0 — because issues are in focus before anything else can be done (D-33d).',
            open_issues: 1,
            open_issue_refs: ['finding_0']
        });
        expect(store.findings.list().map((row) => [row.id, row.kind ?? 'issue', row.state, row.approved_by])).toEqual([
            // `approved_by` is ABSENT on a row nobody approved — the store does not write a null, and
            // a fixture that asserted one would be asserting a field the record never carries.
            ['finding_0', 'issue', 'unconfirmed', undefined],
            ['finding_1', 'proposal', 'confirmed', undefined]
        ]);

        // Discard is the exception in every funnel, including this double: declining a change is not an
        // approval and opens no Writer work.
        expect(
            await call('run_0', 'approveFinding', {
                finding_id: 'finding_1',
                decision: 'discard',
                why: 'not this book'
            })
        ).toEqual({ ok: true, rev: 2 });
        expect(store.findings.get('finding_1')).toMatchObject({ state: 'discarded', kind: 'proposal' });
    });

    it('approves the Proposal once the issue is closed — and an approved ISSUE is not a closed one (D-33d)', async () => {
        const { store, call } = crew();

        seedFinding(store, 'story_0', { criterion_ref: 'C-4', title: 'the map contradicts the 1911 survey' });
        seedFinding(store, 'story_0', {
            criterion_ref: 'C-11',
            title: 'open the book on the lie',
            cost: 'minor',
            kind: 'proposal',
            state: 'confirmed'
        });

        // Approving the ISSUE moves it into work; it does not resolve it. The predicate counts `approved`
        // as open, so the proposal is still held — the same reading the dial sweep and the Author's
        // approve-all use, which is the divergence this single predicate exists to prevent.
        expect(
            await call('run_0', 'approveFinding', { finding_id: 'finding_0', decision: 'approve', why: 'do it' })
        ).toEqual({ ok: true, rev: 2 });
        expect(
            await call('run_0', 'approveFinding', {
                finding_id: 'finding_1',
                decision: 'approve',
                why: 'and the flourish'
            })
        ).toMatchObject({ ok: false, refused: 'D-33d' });

        store.findings.update(
            'finding_0',
            { state: 'fixed' },
            { run_ref: null, author: true, why: 'seed: the repair landed (D-33d)' },
            [{ id: 'finding_0', rev: 2 }]
        );

        expect(
            await call('run_0', 'approveFinding', { finding_id: 'finding_1', decision: 'approve', why: 'now' })
        ).toEqual(
            // rev 2, not 3: the two refusals above moved NOTHING, which is the whole claim — a refused
            // approval is not a write, so the row arrives at its first real write at its second rev.
            { ok: true, rev: 2 }
        );
        // The approval is attributed to the RUN, as every other write from a session is (T-3, D-41c keeps
        // the auto and author lanes distinguishable) — the mirror does not invent an author lane.
        expect(store.findings.get('finding_1')).toMatchObject({ state: 'approved', approved_by: 'run_0' });
    });
});
