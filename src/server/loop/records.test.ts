/**
 * THE ONE open-defect predicate, pinned at the record layer (D-33c, D-33d, and D-67's Clean read).
 *
 * WHY THIS FILE EXISTS: `loop/records.ts:isOpenIssueFinding` is the single place the product answers
 * "does this row still hold work?", and four funnels read it — the Critic's `raiseFinding` gate
 * (`tools/reader.ts`), the Editor's `approveFinding` gate (`tools/editor.ts`), the auto-approve dial
 * sweep and `engine.approveFinding` (`loop/engine.ts`), and the Author's approve-all route
 * (`api/routes.ts`) — plus `phrase/reviewed.ts:openIssueGroupIds`, which is the Clean stamp's veto. The
 * funnel-level suites (`tools/runtime.test.ts`, `run/mock.test.ts`, `loop/findings.test.ts`,
 * `api/approve-all.test.ts`, `phrase/reviewed.test.ts`) each prove their own gate; only THIS file can
 * pin the boundary the gates share, so a drift in the set shows up here as one red test instead of five
 * half-moved funnels. That singleness is the whole reason the predicate lives in `records.ts`.
 *
 * THE BOUNDARY, stated once so a reader of this file knows what the rows below mean:
 *   - HOLDING: `unconfirmed`, `confirmed`, `approved` — each of them still owes somebody a step
 *     (confirm/dispute it, approve it, fix it), so an issue in one of them keeps a proposal waiting.
 *   - RELEASED: `disputed` (the Editor's "this is not a defect" — D-33, and the 2026-11-25 decision
 *     "Not blocking — keep flowing"), `fixed`, `discarded`.
 *   - `kind: 'proposal'` never holds anything, in any state: the Author asked that proposals wait
 *     behind DEFECTS, and a suggestion cannot be the reason a suggestion is waiting.
 *
 * `disputed` is deliberately NOT spelled "closed" here. It is a released state that stays on the record:
 * `OPEN_FINDING_STATES` (the chapter/drain/sign-off read, `loop/types.ts:269`) still counts it, the
 * completion preview still lists it, and the Author keeps the unguarded approve/discard routes to
 * overturn it. Those reads are pinned below so the next edit cannot quietly merge the two questions.
 */
import { describe, expect, it } from 'vitest';

import { Store } from '../store';
import { seedFinding, seedStory } from '../run/mock';
import { isOpenIssueFinding, openIssueFindings } from './records';
import { CLOSED_FINDING_STATES, ISSUE_HOLDING_STATES, OPEN_FINDING_STATES } from './types';
import type { Finding, FindingState } from '../../shared/types';

/** Every state §4.10 defines, in the order the type does — the ladder rows below walk all of them. */
const STATES: FindingState[] = ['unconfirmed', 'confirmed', 'disputed', 'approved', 'fixed', 'discarded'];

/** One Story, so the ladder rows share a scope and the ids stay predictable (`finding_0`, `finding_1`, …). */
function book() {
    const store = Store.empty();
    const story = seedStory(store);

    return { store, story };
}

/** The predicate's verdict as one readable token per row — the whole table in one `toEqual`. */
const holds = (finding: Finding): string =>
    `${finding.kind ?? 'absent'}|${finding.state}:${isOpenIssueFinding(finding) ? 'holds' : 'free'}`;

describe('isOpenIssueFinding — the holding set, per row (D-33c, D-33d)', () => {
    it('holds an issue in exactly `unconfirmed`, `confirmed` and `approved`, and frees every other state', () => {
        const { store, story } = book();

        // An EXPLICIT `kind: 'issue'` row for every state, then the kind-LESS legacy row (seedFinding
        // omits `kind`), then a `proposal` in every state. The ladder is one assertion because the
        // boundary is one fact: six states x three claim readings = 13 rows, and every one of them is
        // known from the doctrine above — no observed-output guessing.
        for (const state of STATES) seedFinding(store, story.id, { state, kind: 'issue', title: `issue ${state}` });
        seedFinding(store, story.id, { state: 'unconfirmed', title: 'the kind-less legacy row' });
        for (const state of STATES) seedFinding(store, story.id, { state, kind: 'proposal', title: `proposal ${state}` });

        expect(store.findings.list().map(holds)).toEqual([
            // Issues: the three work-owing states hold; the three released ones do not.
            'issue|unconfirmed:holds',
            'issue|confirmed:holds',
            'issue|disputed:free',
            'issue|approved:holds',
            'issue|fixed:free',
            'issue|discarded:free',
            // A row with no `kind` is an issue — the same legacy reading `tools/reader.ts:kindOf` and
            // `tools/utilities.ts:findingFingerprint` give it, so the gate cannot be dodged by omitting
            // the field.
            'absent|unconfirmed:holds',
            // Proposals never hold, in any state — including `unconfirmed`, the state that holds an issue.
            'proposal|unconfirmed:free',
            'proposal|confirmed:free',
            'proposal|disputed:free',
            'proposal|approved:free',
            'proposal|fixed:free',
            'proposal|discarded:free'
        ]);
    });

    it('keeps the three named sets distinct, because four different questions read them (D-33, D-67, L-15a)', () => {
        // THE EDGE CASE THIS FILE EXISTS FOR: `disputed` sits in the OLD open set and outside the HOLDING
        // set at the same time, on purpose. The chapter/drain/sign-off read (`OPEN_FINDING_STATES`,
        // `loop/types.ts:269`, read by `loop/engine.ts:909/1072` and `loop/editor-lock.ts:248`) and the
        // completion preview's leftovers answer "what is still on the record"; D-33c/D-33d/D-67 answer
        // "what still owes a step". Collapsing them would either re-wedge a disputed book or make a
        // disputed row invisible to the Author.
        expect(ISSUE_HOLDING_STATES).toEqual(['unconfirmed', 'confirmed', 'approved']);
        expect(OPEN_FINDING_STATES).toEqual(['unconfirmed', 'confirmed', 'approved', 'disputed']);
        expect(CLOSED_FINDING_STATES).toEqual(['fixed', 'discarded']);

        // The holding set is exactly the open set minus the released `disputed` row — stated as a set
        // difference so a future edit that moves a state out of one list has to move it out of both.
        expect(OPEN_FINDING_STATES.filter((state) => !ISSUE_HOLDING_STATES.includes(state))).toEqual(['disputed']);
    });
});

describe('openIssueFindings — the unresolved defects of one Story (D-33c, D-33d)', () => {
    it('returns exactly the holding issue rows of this Story, in the store order, and nothing else', () => {
        const { store, story } = book();

        // One row per state, plus the two rows the rule must IGNORE for reasons other than state: a
        // `confirmed` PROPOSAL (wrong kind) and a holding issue on ANOTHER Story (wrong scope — the
        // gate is Story-scoped, never phase-scoped, and never global).
        const ids: Record<string, string> = {};

        for (const state of STATES) ids[state] = seedFinding(store, story.id, { state, kind: 'issue' }).id;
        const proposal = seedFinding(store, story.id, {
            state: 'confirmed',
            kind: 'proposal',
            criterion_ref: 'C-11',
            fingerprint: 'C-11|chapter_1'
        }).id;

        const other = seedStory(store, { title: 'The other book' });
        const elsewhere = seedFinding(store, other.id, { state: 'confirmed', criterion_ref: 'C-9' }).id;

        expect(openIssueFindings(store, story.id).map((finding) => finding.id)).toEqual([
            ids.unconfirmed,
            ids.confirmed,
            ids.approved
        ]);
        // The two ignores are named explicitly rather than inferred from their absence above: a proposal
        // and another Story's defect must never join this list, at any cost.
        expect(openIssueFindings(store, story.id).map((finding) => finding.id)).not.toContain(proposal);
        expect(openIssueFindings(store, story.id).map((finding) => finding.id)).not.toContain(elsewhere);
        // And the empty answer is a real answer: a Story whose every issue is disputed, fixed or
        // discarded has NOTHING holding it, which is the state a wedged book reaches the moment the
        // Editor disputes its last open note.
        expect(openIssueFindings(store, 'story_missing')).toEqual([]);
    });
});
