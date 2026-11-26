/**
 * The mock crew's copy of the issues-first rules (D-33c at filing, D-33d at approval).
 *
 * WHY THIS FILE EXISTS: `MockToolRuntime` is not a stub, it is the double every loop, API and executor
 * test runs its crew through (`run/mock.ts:defaultTools`), and a double that lets a scripted crew do what
 * the product forbids is worse than no double at all — the suite would go green on a sequence the server
 * refuses. So the two mirrors (`raiseFinding`'s D-33c dismissal and `approveFinding`'s D-33d gate) are
 * pinned HERE, against the same exact result objects the real tools return, and both read the same shared
 * predicate (`loop/records.ts:openIssueFindings`) rather than a private re-read of the rule. The real-tool
 * side of the same contract lives in `src/server/tools/runtime.test.ts`; the engine/API side lives in
 * `src/server/loop/findings.test.ts` and `src/server/api/approve-all.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { Store } from '../store';
import { MockToolRuntime, seedFinding, seedStory } from './mock';
import type { RunToolSession } from './types';

/**
 * A CRITIC session on this Story, bound the way `run/executor.ts` binds one (T-3: the Story is fixed by
 * the session, never by the args). One `runId` is one review PASS — a dispatched run — so a test that
 * wants two passes asks for two sessions, exactly as two dispatched runs get two. (D-33c's filing gate is
 * Story-scoped and never counts the pass at all, since 2026-11-26.)
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

describe('the mock crew files under D-33c — issues before proposals, and a proposal dismissed while they wait', () => {
    it('dismisses a Proposal over an open issue, names the open rows, and files nothing (D-33c)', async () => {
        const { store, call } = crew();

        // The issue files first, and the double answers like the real tool does: the created row, its kind,
        // its rev — nothing about the happy path changed with this rule.
        expect(await call('run_0', 'raiseFinding', defect('the map contradicts the 1911 survey'))).toEqual({
            ok: true,
            finding_id: 'finding_0',
            kind: 'issue',
            rev: 1
        });

        const dismissed = await call('run_0', 'raiseFinding', improvement('open the book on the lie'));

        // The answer object is what the scripted crew reads back, so its exact wording and its structured
        // fields are both product surface. This one mirrors `tools/reader.ts:dismissedProposal`
        // (2026-11-26): the proposal is DISMISSED, not refused — `ok: true`, `filed: false`, the open rows
        // stated as the REASON (never a queue the claim waits behind, F3), and no exits to try. A
        // `{ok:false}` refusal would tell the scripted crew its call was wrong and invite another one,
        // which is the retry loop the rule now closes at the first call.
        expect(dismissed).toEqual({
            ok: true,
            dismissed: 'D-33c',
            filed: false,
            kind: 'proposal',
            message:
                'this proposal is dismissed, not filed — the reason is 1 issue: open before this call — finding_0. A suggestion about a book that still has defects is not what this round is for, and the dismissal settles the claim here: no row, no count, nothing to answer. Conclude this pass — submit your verdict (D-33c).',
            open_issues: 1,
            open_issue_refs: ['finding_0']
        });
        // And the dismissal is a dismissal: the proposal never reached the board, so the queue, the dial
        // and the closure rules all see the one row the pass actually filed.
        expect(store.findings.list().map((row) => [row.id, row.kind ?? 'issue', row.state])).toEqual([
            ['finding_0', 'issue', 'unconfirmed']
        ]);
    });

    it('files a WHOLE pass in one submitVerdict call — the verdict, a second target, and both claims (W3b)', async () => {
        // W3b (2026-11-26): the double carries the same terminal shape as `tools/reader.ts:submitVerdict`,
        // because every loop and API test runs its crew through this class. One call files the primary
        // verdict, an extra target from `verdicts[]`, and the claims from `findings[]` — and the D-33c gate
        // is resolved for the WHOLE call before it files, from the board as it stood plus the report's own
        // claims (F3), so a scripted crew cannot script around it whichever order it files in.
        const { store, call } = crew();

        await call('run_0', 'raiseFinding', defect('the map contradicts the 1911 survey'));

        expect(
            await call('run_1', 'submitVerdict', {
                target_ref: 'chapter_1',
                target_kind: 'chapter',
                round: 1,
                criteria: [{ criterion: 'C-4', result: true, evidence: 'chapter_1 sec_1 delivers the climb' }],
                recommendation: 'fix',
                why: 'the pass ends here',
                verdicts: [
                    {
                        target_ref: 'revision_0',
                        target_kind: 'revision',
                        round: 1,
                        // The nested entry sends `criteria_passed`, the field the real tool's schema names.
                        criteria_passed: [
                            { criterion: 'C-4', result: true, evidence: 'revision_0 sec_1 delivers the climb' }
                        ]
                    }
                ],
                findings: [
                    improvement('open the book on the lie'),
                    { ...defect('the bell is rung twice'), criterion_ref: 'C-7' }
                ]
            })
        ).toEqual({
            ok: true,
            id: 'verdict_0',
            rev: 1,
            verdicts: [{ ok: true, id: 'verdict_1', rev: 1, target_ref: 'revision_0' }],
            findings: [
                {
                    ok: true,
                    dismissed: 'D-33c',
                    filed: false,
                    kind: 'proposal',
                    // F3: the cause is BOTH the row that was open before the call and the issue this same
                    // report files beside it, and the answer says which is which — `open_issue_refs` stays
                    // the pre-existing rows, and `same_report_issues` counts the report's own.
                    message:
                        'this proposal is dismissed, not filed — the reason is 2 issues: open before this call — finding_0; plus 1 issue filed by this same report. A suggestion about a book that still has defects is not what this round is for, and the dismissal settles the claim here: no row, no count, nothing to answer. Conclude this pass — submit your verdict (D-33c).',
                    open_issues: 1,
                    open_issue_refs: ['finding_0'],
                    same_report_issues: 1
                },
                { ok: true, finding_id: 'finding_1', kind: 'issue', rev: 1 }
            ],
            reported: { verdicts: 2, findings: 2 }
        });
        // Two verdict rows and one new finding — the dismissed proposal wrote no row and counted no sighting
        // on the issue that holds the gate open (the same "the dismissal armed nothing" claim the real tool
        // makes in `tools/runtime.test.ts`).
        expect(store.verdicts.list().map((row) => `${row.id}:${row.target_ref}:${row.recommendation}`)).toEqual([
            'verdict_0:chapter_1:fix',
            'verdict_1:revision_0:fix'
        ]);
        expect(store.findings.list().map((row) => `${row.id}:${row.kind}:${row.state}:${row.seen_count}`)).toEqual([
            'finding_0:issue:unconfirmed:1',
            'finding_1:issue:unconfirmed:1'
        ]);
    });

    it('files both halves of a pass — the mirror rule is gone — and dismisses the Proposal (D-33c)', async () => {
        // THE MIRROR RULE THAT GOED (2026-11-26): an `issue` used to be refused in a pass that had already
        // filed a proposal. After the dismissal a proposal row only exists when NO issue was open, so that
        // rule could henceforth refuse only a DEFECT — the work the round exists for — and it would strand
        // it behind another pass while the proposal rode the dial. So both calls are accepted now, and the
        // half that loses is the proposal, by the first gate. Attribution by run decides nothing here
        // any more — the helper that read it went with the rule.
        const { store, call } = crew();

        expect(await call('run_0', 'raiseFinding', improvement('open the book on the lie'))).toEqual({
            ok: true,
            finding_id: 'finding_0',
            kind: 'proposal',
            rev: 1
        });

        // The defect the same pass files afterwards is accepted: an issue is always filable.
        expect(await call('run_0', 'raiseFinding', defect('the map contradicts the 1911 survey'))).toEqual({
            ok: true,
            finding_id: 'finding_1',
            kind: 'issue',
            rev: 1
        });

        // And a proposal attempted afterwards is dismissed by the open issue, in the same pass or any other.
        expect(await call('run_0', 'raiseFinding', improvement('let the keeper lie first'))).toEqual({
            ok: true,
            dismissed: 'D-33c',
            filed: false,
            kind: 'proposal',
            message:
                'this proposal is dismissed, not filed — the reason is 1 issue: open before this call — finding_1. A suggestion about a book that still has defects is not what this round is for, and the dismissal settles the claim here: no row, no count, nothing to answer. Conclude this pass — submit your verdict (D-33c).',
            open_issues: 1,
            open_issue_refs: ['finding_1']
        });
        // The board holds the first proposal and the defect, and nothing else: the dismissed improvement
        // left no row, so the loop cannot act on it and no Writer round comes from it.
        expect(store.findings.list().map((row) => [row.id, row.kind ?? 'issue'])).toEqual([
            ['finding_0', 'proposal'],
            ['finding_1', 'issue']
        ]);
    });

    it('dismisses the Proposal beside an issue in ONE report, whichever end of the array it sits at (D-33c, F3)', async () => {
        // THE DOUBLE MIRRORS THE TOOL (2026-11-26, F3). `submitVerdict`'s gate is read BEFORE the report
        // files, together with the report's own `kind: issue` entries, so a scripted crew cannot script an
        // answer the product no longer gives: on a clear board, `[proposal, issue]` used to FILE the
        // proposal while `[issue, proposal]` dismissed it. Both orders now dismiss it, and the issue files
        // either way — which is the sequence every loop and API test running through this class will script.
        const report = (order: 'proposal-first' | 'issue-first') => ({
            target_ref: 'chapter_1',
            target_kind: 'chapter',
            round: 1,
            criteria: [{ criterion: 'C-4', result: true, evidence: 'chapter_1 sec_1 delivers the climb' }],
            recommendation: 'fix',
            why: 'one defect and one wish, in the one closing call',
            findings:
                order === 'proposal-first'
                    ? [improvement('open the book on the lie'), defect('the map contradicts the 1911 survey')]
                    : [defect('the map contradicts the 1911 survey'), improvement('open the book on the lie')]
        });

        // The dismissal, identical in both orders: no pre-existing row (`open_issues: 0` — the roster does
        // not list a row this same call filed), and `same_report_issues: 1` naming the actual cause.
        const dismissed = {
            ok: true,
            dismissed: 'D-33c',
            filed: false,
            kind: 'proposal',
            message:
                'this proposal is dismissed, not filed — the reason is 1 issue: filed by this same report. A suggestion about a book that still has defects is not what this round is for, and the dismissal settles the claim here: no row, no count, nothing to answer. Conclude this pass — submit your verdict (D-33c).',
            open_issues: 0,
            open_issue_refs: [],
            same_report_issues: 1
        };
        const filed = { ok: true, finding_id: 'finding_0', kind: 'issue', rev: 1 };

        // The receipts, read off the double's FLAT result shape (`submitVerdict` returns `findings` beside
        // `id`/`rev`, and `ToolResult` types only the tool layer's envelope).
        const findingsOf = (result: unknown) => (result as { findings?: unknown[] }).findings;

        const proposalFirst = crew();
        const proposalFirstResult = await proposalFirst.call('run_0', 'submitVerdict', report('proposal-first'));

        expect(findingsOf(proposalFirstResult)).toEqual([dismissed, filed]);

        const issueFirst = crew();
        const issueFirstResult = await issueFirst.call('run_0', 'submitVerdict', report('issue-first'));

        expect(findingsOf(issueFirstResult)).toEqual([filed, dismissed]);
        // THE BOARD IS THE SAME in both orders — one issue row, no proposal row, and so no verification seat
        // and no Writer round armed by a claim the pass was never allowed to file.
        expect(proposalFirst.store.findings.list().map((row) => [row.id, row.kind, row.state])).toEqual([
            ['finding_0', 'issue', 'unconfirmed']
        ]);
        expect(issueFirst.store.findings.list().map((row) => [row.id, row.kind, row.state])).toEqual([
            ['finding_0', 'issue', 'unconfirmed']
        ]);
    });

    it('files the Proposal the moment the issue reaches a closed state (D-33c)', async () => {
        const { store, call } = crew();

        await call('run_0', 'raiseFinding', defect('the map contradicts the 1911 survey'));
        expect(await call('run_1', 'raiseFinding', improvement('open the book on the lie'))).toMatchObject({
            ok: true,
            dismissed: 'D-33c',
            filed: false
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

    it('files the Proposal over an issue the Editor DISPUTED (D-33c)', async () => {
        const { store, call } = crew();

        await call('run_0', 'raiseFinding', defect('the map contradicts the 1911 survey'));

        // THE BOUNDARY OF THE HOLDING SET. `disputed` is the Editor saying the note does not fit the text:
        // the row is still on the board and still answerable — neither `fixed` nor `discarded` — but it
        // claims no defect, so it does not hold a proposal down. This is the state that used to deadlock a
        // book: no phase owed a disputed row any work, and nothing could be proposed until somebody
        // fabricated a second verdict on it.
        store.findings.update(
            'finding_0',
            { state: 'disputed' },
            { run_ref: null, author: true, why: 'seed: the Editor disputes the note (D-33c)' },
            [{ id: 'finding_0', rev: 1 }]
        );

        expect(await call('run_1', 'raiseFinding', improvement('open the book on the lie'))).toEqual({
            ok: true,
            finding_id: 'finding_1',
            kind: 'proposal',
            rev: 1
        });
        // Release is not closure: the disputed row survives the call, exactly as the Editor left it, and
        // the Author can still overturn it (the unguarded approve/discard routes are the valve).
        expect(store.findings.list().map((row) => [row.id, row.kind ?? 'issue', row.state])).toEqual([
            ['finding_0', 'issue', 'disputed'],
            ['finding_1', 'proposal', 'unconfirmed']
        ]);
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
                'proposal finding_1 cannot be approved while 1 issue is unresolved — finding_0 — because issues are in focus before anything else can be done (D-33d). Only `unconfirmed`, `confirmed` and `approved` issues are in that set: one you marked `disputed` already released this proposal.',
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

    it('approves the Proposal over an issue the Editor DISPUTED (D-33d)', async () => {
        const { store, call } = crew();

        // Same desk as the refusal test — an open ISSUE and a `confirmed` PROPOSAL — with ONE variable
        // changed: the issue is `disputed`. The gate reads the shared holding set
        // (`loop/records.ts:openIssueFindings`), so a row the Editor rejected is not an unresolved defect
        // and the approval lands. The Author keeps every overturn valve — the unguarded approve/discard
        // routes and the completion-accept discard still answer a disputed row — but none of them is
        // AWAITED by a proposal.
        seedFinding(store, 'story_0', { criterion_ref: 'C-4', title: 'the map contradicts the 1911 survey' });
        seedFinding(store, 'story_0', {
            criterion_ref: 'C-11',
            title: 'open the book on the lie',
            cost: 'minor',
            kind: 'proposal',
            state: 'confirmed'
        });

        store.findings.update(
            'finding_0',
            { state: 'disputed' },
            { run_ref: null, author: true, why: 'seed: the Editor disputes the note (D-33d)' },
            [{ id: 'finding_0', rev: 1 }]
        );

        expect(
            await call('run_0', 'approveFinding', { finding_id: 'finding_1', decision: 'approve', why: 'worth a pass' })
        ).toEqual({ ok: true, rev: 2 });
        expect(store.findings.list().map((row) => [row.id, row.kind ?? 'issue', row.state, row.approved_by])).toEqual([
            // The disputed row is UNTOUCHED by the approval — `approved_by` stays absent. Releasing a
            // proposal is not the same write as closing an issue, and the Author still reads the row as
            // the Editor left it.
            ['finding_0', 'issue', 'disputed', undefined],
            ['finding_1', 'proposal', 'approved', 'run_0']
        ]);
    });
});
