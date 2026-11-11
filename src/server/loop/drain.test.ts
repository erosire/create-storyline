/**
 * Acceptance for the drain boundary and the U-13 read surface — decisions D-27, D-21, U-13, L-29,
 * L-36, L-37, C-15, and §6.2a's "Checker runs ×M → verdicts per revision".
 *
 * Two halves, one per direction of the same rule:
 *
 *   1. D-27 — "An Idea carrying `sources` MUST be verified by an Editor BEFORE it can be selected."
 *      The verification is the EDITOR's job, so an unverified sourced Idea is loop WORK, not an Author
 *      action. That is the whole difference between the three fixtures below: the sign-off (L-29) and
 *      the drained dial gate (D-35b) both stop the crew, and neither may strand a fact-check the
 *      Author's own pick depends on. The unsourced control proves the predicate is `sources`, not
 *      "an idea exists" — an unsourced Idea is judged on guidelines, not fact-checked (C-15).
 *
 *   2. §6.2a / D-21 / U-13 — a checker pointed at one draft files its verdict against THAT draft, and
 *      the Author's side-by-side pane reads those rows. The `GET /stories/:id` view is the pinned wire
 *      (W9), so the §4.9 rows ride with it; without them the pane can only print refs.
 *
 * Every value asserted below is a row in the store, a sweep-report field, or a projection field.
 */
import { describe, expect, it } from 'vitest';

import { completionPreview, storyView } from '../api/projections';
import { CriteriaEngine } from '../criteria/engine';
import { DigestBuilder } from '../digest/digest';
import { authorAttr } from './records';
import { createRig, seedIdea, walkToChapters, walkToDrain, type Rig } from './mock';
import type { Verdict } from '../../shared/types';

/** The Idea row as one string: id, state, and whether the Editor has answered. */
function ideaRows(rig: Rig): string[] {
    return rig.store.ideas
        .list()
        .filter((idea) => idea.story_id === rig.storyId)
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((idea) => `${idea.id}:${idea.state}:${idea.verification?.verdict ?? 'unverified'}`);
}

/** The verification jobs the loop ran, as `claim key:run state`. */
function verifyRuns(rig: Rig): string[] {
    return rig.store.runs
        .list()
        .filter((run) => (run.work_item_ref ?? '').includes('verify_ideas'))
        .map((run) => `${run.work_item_ref ?? ''}:${run.state}`);
}

/** A draft-verdict row reduced to the fields U-13 renders (§4.9's whole shape is pinned in tools/checker). */
function draftVerdictRows(rows: Verdict[]): string[] {
    return rows
        .filter((verdict) => /^revision_\d+$/.test(verdict.target_ref))
        .map(
            (verdict) =>
                `${verdict.target_ref}:${verdict.id}:${verdict.target_kind}:${verdict.round}:${verdict.hard_pass}:${verdict.recommendation}`
        )
        .sort((left, right) => left.localeCompare(right));
}

/** The sourced Idea §15 step 1's Readers would file (D-27's precondition: `sources` non-empty). */
const SOURCED = {
    body: 'the reservoir was drawn from a 1911 survey that no longer matches the valley floor',
    kind: 'fact' as const,
    state: 'proposed' as const,
    fingerprint: 'survey-1911',
    sources: [{ url_or_title: 'County survey, 1911', claim: 'the contours moved in 1936', accessed_at: '1936-04-02' }]
};

describe('D-27 — an unverified sourced Idea is loop work, not an Author action', () => {
    it('buys the Editor pass at the phase-① sign-off instead of waiting for the Author (D-27, L-29)', async () => {
        // Phase ①'s Goal passes, so the Story is sitting at the L-29 sign-off — exactly the state in
        // which §6.2's Loop S says the Editor verifies the tray BEFORE the Author selects.
        const rig = await createRig({ story: { chapter_count: 2 } });

        await rig.run();

        seedIdea(rig.store, rig.storyId, { phase: 'summary', ...SOURCED });

        const report = await rig.step();
        const story = rig.story();

        // L-29 stops the crew at a sign-off; D-27 does not. The sweep dispatches, and the pending
        // screen the Author would otherwise be reading is gone (status_reason names the D-27 clause).
        expect(report.stories[0]?.started).toEqual(['wi_verify_ideas_1_1_idea_1']);
        expect(report.stories[0]?.deferred).toEqual({});
        expect({ status: story.status, pending: story.pending_kind }).toEqual({ status: 'ready', pending: 'none' });
        expect(story.status_reason).toBe(
            "phase summary's Goal passes (2/2) — the crew keeps working until it drains (L-35, L-36) · 1 sourced Idea first need the Editor's verdict (D-27)"
        );

        await rig.run();

        const verified = rig.store.ideas.require('idea_1');

        // §4.17's `verification` block: the verdict, the evidence, the guidelines answer (D-31), and
        // the RUN that made it (C-15 refuses a verdict with no `checked_by_run`).
        expect({
            state: verified.state,
            verdict: verified.verification?.verdict,
            evidence: verified.verification?.evidence,
            meets_guidelines: verified.verification?.meets_guidelines,
            run: /^run_\d+$/.test(verified.verification?.checked_by_run ?? '')
        }).toEqual({
            state: 'verified',
            verdict: 'verified',
            evidence: 're-read the cited source; it says what the Idea claims',
            meets_guidelines: true,
            run: true
        });
        expect(verifyRuns(rig)).toEqual(['wi_verify_ideas_1_1_idea_1:torn_down']);

        // The verdict does NOT hand the sign-off back: `verified` is the Editor's answer to "is the claim
        // true?", not the Author's pick (T-3b), so the row is still in the tray and L-7a keeps the lock
        // refused. The desk the sweep reports is now the Author's pick, and the lock waits for it.
        const after = rig.story();

        expect({ status: after.status, pending: after.pending_kind, ideas: ideaRows(rig) }).toEqual({
            status: 'pending',
            pending: 'idea_selection',
            ideas: ['idea_1:verified:verified']
        });
        expect(after.status_reason).toBe(
            "phase summary's Goal passes (2/2) · 1 undecided Idea must be selected, discarded, or deferred before the lock (L-7a, D-29)"
        );
    });

    it('a verified Idea still holds the lock shut until the Author discards it — verified is not a decision (L-7a, U-15, T-3b)', async () => {
        // The gap this pins: the tray gate used to read `state: 'proposed'`, so the moment the Editor
        // answered a sourced Idea the row left the tray on its own and the phase became lockable with an
        // Idea nobody had ever selected or discarded — a decision the machine made by silence (L-7a), and
        // one D-36 would then have deleted at the lock without ever asking.
        const rig = await createRig({ story: { chapter_count: 2 } });

        await rig.run();

        seedIdea(rig.store, rig.storyId, { phase: 'summary', ...SOURCED });
        await rig.step();
        await rig.run();

        expect(ideaRows(rig)).toEqual(['idea_1:verified:verified']);

        // 1. The lock is refused, and the sentence names the tray.
        await expect(rig.engine.lockPhase(rig.storyId, 'summary')).rejects.toThrow(
            'cannot lock summary: 1 Idea still in the tray — each must be selected, discarded, or deferred first (L-7a, D-29)'
        );
        expect(rig.story().summary_locked).toBe(false);

        // 2. The Author's discard is the decision L-7a was waiting for (U-15's other button).
        await rig.store.commit('author_discards_the_verified_idea', () => {
            const row = rig.store.ideas.require('idea_1');

            rig.store.ideas.update(
                row.id,
                { state: 'discarded', selection_note: 'true, and not the book I am writing' },
                authorAttr('the Author discarded a verified Idea (D-29, U-15)'),
                [{ id: row.id, rev: row.rev }]
            );
        });

        // 3. With the tray empty the same lock goes through, and D-36 empties the phase behind it.
        await rig.engine.lockPhase(rig.storyId, 'summary');

        expect({ phase: rig.story().phase, locked: rig.story().summary_locked }).toEqual({
            phase: 'plotlines',
            locked: true
        });
        expect(rig.store.ideas.list().filter((idea) => idea.phase === 'summary')).toEqual([]);
    });

    it('leaves an UNSOURCED proposed Idea as the Author\'s decision (D-27 reads `sources`, not "an Idea exists")', async () => {
        const rig = await createRig({ story: { chapter_count: 2 } });

        await rig.run();

        seedIdea(rig.store, rig.storyId, { phase: 'summary', state: 'proposed', fingerprint: 'unsourced-notion' });

        const report = await rig.step();
        const story = rig.story();

        // No verification job is wanted, let alone started, and the Story keeps the `idea_selection`
        // wait it had before: the tray is the Author's lane (L-7a, D-26) and nothing is owed in the crew's.
        // The two probe jobs the sweep DOES want are held back by that same wait — the crew is stopped
        // while the Author has the desk, which is exactly what D-27 lifts for a fact-check and only for it.
        expect(report.stories[0]?.started).toEqual([]);
        expect(report.stories[0]?.wanted.map((candidate) => candidate.key)).toEqual([
            'wi_probe_checker_summary_1',
            'wi_probe_reader_summary_1'
        ]);
        expect(report.stories[0]?.deferred).toEqual({
            wi_probe_checker_summary_1: 'not dispatched: idea_selection',
            wi_probe_reader_summary_1: 'not dispatched: idea_selection'
        });
        expect({ status: story.status, pending: story.pending_kind }).toEqual({
            status: 'pending',
            pending: 'idea_selection'
        });
        expect(story.status_reason).toBe(
            "phase summary's Goal passes (2/2) · 1 undecided Idea must be selected, discarded, or deferred before the lock (L-7a, D-29)"
        );
        expect(ideaRows(rig)).toEqual(['idea_1:proposed:unverified']);
        expect(verifyRuns(rig)).toEqual([]);
    });

    it('dispatches at the drained boundary too, once, and the Idea lands verified (D-27, D-35b, L-37)', async () => {
        // In the built-in flow the Readers only file Ideas from the drain probe rounds, so the drained
        // Story is where D-27 actually bites. D-35b stops dispatch while the Author has the desk; this
        // is the one job that must survive that gate.
        const rig = await walkToDrain(await createRig({ story: { chapter_count: 2 } }), 2);

        seedIdea(rig.store, rig.storyId, { phase: 'chapters', ...SOURCED });

        const report = await rig.step();

        expect(report.stories[0]?.started).toEqual(['wi_verify_ideas_1_1_idea_1']);
        expect(report.stories[0]?.deferred).toEqual({});

        await rig.run();

        expect(ideaRows(rig)).toEqual(['idea_1:verified:verified']);
        // One Editor pass only: the claim key is store-derived and the row now carries `verification`, so
        // `ideasToVerify` (records.ts:305) stops offering it — no Editor-pass treadmill at the dial.
        expect(verifyRuns(rig)).toEqual(['wi_verify_ideas_1_1_idea_1:torn_down']);
        // And the drained screen comes back on its own once the fact-check is in.
        expect({ status: rig.story().status, pending: rig.story().pending_kind }).toEqual({
            status: 'pending',
            pending: 'drained'
        });
    });

    it("states the verified Idea in the completion prompt's discard count, not only the `proposed` ones (L-25b, U-14)", async () => {
        // Exactly the state the test above reaches: a drained phase ③ carrying one Idea the LOOP verified
        // and the Author never picked. `acceptCompletion` moves every row in `DISCARDABLE_IDEA_STATES` to
        // `discarded` (engine.ts), and `verified` is one of them (T-3b: the Editor answered "is the claim
        // true?", never "is it in the book?"). The strict `proposed` count both projections used said 0, so
        // the Author clicked "Complete" while an undecided row vanished; U-14 asks for the true number, so
        // the drained row, `completion.leftovers` and `completion_preview` all say 1 now.
        const rig = await walkToDrain(await createRig({ story: { chapter_count: 2 } }), 2);

        seedIdea(rig.store, rig.storyId, {
            phase: 'chapters',
            // `verified` with no `verification` block on purpose: the count reads the STATE, and seeding
            // the Editor's whole block here would pin a shape `verifyIdea` owns (see drain.test's D-27 rows).
            state: 'verified',
            body: SOURCED.body,
            fingerprint: 'survey-1911',
            sources: SOURCED.sources
        });

        // The sweep re-derives the Story, and the drained reason is what it rewrites.
        await rig.step();

        const story = rig.story();

        expect(story.pending_kind).toBe('drained');
        // L-25b's count of what the acceptance throws away: nothing open in the findings column, one
        // undecided Idea in the Ideas column. This is the number the proposal carries, not a re-derivation.
        expect(story.completion?.leftovers).toEqual({ findings: 0, ideas: 1 });
        // U-1c's row copy names it out loud, in the sentence the Author reads before deciding.
        expect(story.status_reason).toContain('1 undecided Idea in the tray, which accepting discards (L-25b, U-14)');
        // And the Story view's prompt (the pane's "will be closed without action" line) agrees with it.
        expect(completionPreview(rig.store, story)).toEqual({
            open_findings: 0,
            open_ideas: 1,
            oldest: 'the reservoir was drawn from a 1911 survey that no longer matches the valley floor'
        });
    });

    it('never re-verifies an Idea the Author picked over the missing verdict — C-15 stays red (D-27, C-15)', async () => {
        // The select route lets the Author override with a non-blank note (routes.ts:561). The loop does
        // NOT quietly repair that: `ideasToVerify` is `state: 'proposed'`, so a decided row is a decision,
        // not work, and the Goal keeps saying the truth about it (P6, L-25's "not proposed").
        const rig = await createRig({ story: { chapter_count: 2 } });

        await rig.run();

        seedIdea(rig.store, rig.storyId, { phase: 'summary', ...SOURCED, state: 'selected' });

        await rig.run();

        expect(verifyRuns(rig)).toEqual([]);
        expect(ideaRows(rig)).toEqual(['idea_1:selected:unverified']);
        expect(rig.story().status_reason).toBe(
            'no critical or major left to work on (D-35b) · a fresh round of Readers and checkers found nothing at that threshold (L-37) · completion not proposed: the phase Goal is 1/2 · failing: C-15'
        );
        expect(
            new CriteriaEngine().evaluateCode(rig.store, rig.storyId).find((result) => result.criterion === 'C-15')
        ).toEqual({
            criterion: 'C-15',
            passed: false,
            evidence:
                '1 selected Idea reached an artifact without a checked Editor verdict — idea_1 (1 source): no Editor verification at all',
            source: 'code'
        });
    });
});

describe('§6.2a / D-21 / U-13 — a verdict per draft, and the Author can read it', () => {
    it('files one verdict per competing draft against the DRAFT, and the pinned view carries every row', async () => {
        // Three attempts per chapter (D-17d) is the state §6.2a describes: N drafts, a checker per draft.
        const rig = await createRig({ story: { chapter_count: 2 }, attempts: 3 });

        await walkToChapters(rig, 2);
        await rig.run();

        // Six drafts, six draft-targeted verdicts. Before the rig's draft-id regex was fixed, `rev_\w+`
        // never matched a stored `revision_N`, so per-draft verdicts silently never landed and every
        // checker report was filed against the unit alone (which is what starved U-13).
        const rows = rig.store.verdicts.list().filter((verdict) => verdict.story_id === rig.storyId);

        expect(draftVerdictRows(rows)).toEqual([
            'revision_1:verdict_7:revision:1:true:advance',
            'revision_2:verdict_10:revision:1:true:advance',
            'revision_3:verdict_13:revision:1:true:advance',
            'revision_4:verdict_16:revision:1:true:advance',
            'revision_5:verdict_19:revision:1:true:advance',
            'revision_6:verdict_22:revision:1:true:advance'
        ]);

        // D-22: the selection deletes the losing drafts hard; the verdicts that judged them stay, because
        // the Author can still ask why this draft won (P11).
        expect(rig.store.revisions.list().map((revision) => `${revision.id}:${revision.state}`)).toEqual([
            'revision_1:selected',
            'revision_4:selected'
        ]);

        // U-13: `GET /stories/:id` is the pinned wire (W9) and the dashboard is forbidden from
        // recomputing anything, so the §4.9 rows themselves have to ride with it — in the store's
        // order, oldest first, which is what lets the pane take the LAST row per target as the newest.
        const view = storyView(
            { store: rig.store, criteria: new CriteriaEngine(), digest: new DigestBuilder() },
            rig.story()
        );

        expect(view.verdicts).toEqual(rows);
        expect(view.verdicts?.map((verdict) => verdict.id)).toEqual(rows.map((verdict) => verdict.id));
        expect(new Set(view.verdicts?.map((verdict) => verdict.story_id))).toEqual(new Set([rig.storyId]));

        // The selected drafts each carry their own verdict — the fact the pane renders as the draft's
        // judgement rather than the unit's.
        expect(
            rig.store.revisions.list().map(
                (revision) =>
                    `${revision.id}:${(view.verdicts ?? [])
                        .filter((v) => v.target_ref === revision.id)
                        .map((v) => v.id)
                        .join('+')}`
            )
        ).toEqual(['revision_1:verdict_7', 'revision_4:verdict_16']);
    });
});
