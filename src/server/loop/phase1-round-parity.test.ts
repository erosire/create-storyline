/**
 * T12/P1 + P2 — the ACTIVE-ROUND PARITY test: one Story state, ONE projected payload, BOTH
 * implementations of the same four questions read side by side.
 *
 * WHY THIS FILE EXISTS (and why it is a SERVER test that imports the DASHBOARD contract): the loop
 * answers "is this Summary draft already set aside?" from `records.ts:isSupersededSummaryDraft`, which
 * compares the draft's round against `records.ts:samplingRoundOf` — the round IN FLIGHT. The rail
 * answered the same question against `view.sampling.round`, which is the LAST COMPLETED round, so the
 * two sides were one round apart at exactly the boundary that matters: a Story that has selected once
 * leaves a `drafted` sample of round 1 on the ledger (the round closed while it was still being
 * screened), the engine stops offering it work, and the dashboard keeps calling it live competition —
 * "2 Summary revisions still in this round" beside a round that already chose. A shared fixture file
 * would not prove this, because each side would still interpret the fixture's `round` its own way; so
 * every case below drives the REAL engine, projects the view with the REAL projection
 * (`server/api/projections.ts:storyView`), and asserts both sides' answers as literal rows.
 *
 * THE TABLE BOTH SIDES IMPLEMENT (`samplingRoundOf` is the reference column):
 *
 *   | state                                        | sampling_round | active | deep-review | round-1 draft |
 *   | -------------------------------------------- | -------------- | ------ | ----------- | ------------- |
 *   | before the first selection                   | absent         | 1      | 1           | LIVE          |
 *   | round 1 selected, nothing of round 2 written | 1              | 2      | 1           | SUPERSEDED    |
 *   | round 2 in flight (its drafts exist)         | 1              | 2      | 1           | SUPERSEDED    |
 *   | Author selects an OLDER round's revision     | 2              | 3      | 2           | SUPERSEDED    |
 *   | nine rounds completed                        | 9              | 10     | 9           | SUPERSEDED    |
 *
 * The last row is also the ROUND 1 vs 10 boundary: the sampling claim key carries the round number, so
 * a round-10 attempt must never be counted as round 1's retry (`samplePrefixOf`'s trailing `_`), and a
 * round-10 draft must never be compared as a round-1 one.
 *
 * P2 — the LEGACY rows. `Revision.round` is optional ("absent on rows written before sampling
 * existed", §3.5), so a persisted Story can carry Summary drafts with no round at all. They are still
 * DRAFTS: `records.ts:summaryRevisionRounds` keys them at round 1 (the same fallback
 * `roundRevisions`/`isSupersededSummaryDraft` apply), which keeps a finding that names one attributed to
 * that draft instead of degrading it into a whole-Story statement — and it keeps an id this Story never
 * had (`revision_77`) the other answer. Both halves are asserted, because turning every unknown id into
 * a draft id would silence real blockers just as loudly.
 */
import { describe, expect, it } from 'vitest';

import { storyView } from '../api/projections';
import { CriteriaEngine } from '../criteria/engine';
import { DigestBuilder } from '../digest/digest';
import { createRig, seedFinding, seedTask } from './mock';
import { drainPreconditions } from './status';
import {
    authorAttr,
    deepReviewPassesOwed,
    deepReviewRoundOf,
    findingRevisionScope,
    isDeepReviewSelection,
    isSupersededSummaryDraft,
    sampleAttempts,
    samplingRoundOf,
    samplingRoundStarted,
    selectedSummaryRevision,
    summaryBlockingFindings,
    summaryRevisionRounds,
    unitsWithCompetingRevisions
} from './records';
// The DASHBOARD's implementation of the same four rules, read from the server test so a change on one
// side that is not a change on the other fails HERE. `lockCheck` is the Author's Accept gate;
// `summaryRevisionUnit` is the rail's Author-override list (`story-nav.ts`).
import {
    deepReviewProgress,
    findingRevisionScope as dashboardFindingScope,
    isSupersededSummaryDraft as dashboardSupersededSummaryDraft,
    lockCheck,
    selectedSummaryRevision as dashboardSelectedSummaryRevision,
    summaryBlockingFindings as dashboardSummaryBlockingFindings,
    summaryScopeContext
} from '../../dashboard/components/story-contract';
import { summaryRevisionUnit } from '../../dashboard/components/story-nav';
import type { StoryViewData } from '../../dashboard/components/story-contract';
import type { Rig } from './mock';
import type { Finding, Revision, Run, Story } from '../../shared/types';

// ---------------------------------------------------------------------------
// The two readers, reduced to comparable rows
// ---------------------------------------------------------------------------

/** Every Summary draft on the projected wire as `id:round:state` — the rows both sides are asked about. */
function summaryDraftRows(rig: Rig): string[] {
    return projected(rig)
        .revisions.filter((revision) => revision.unit_kind === 'summary')
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((revision) => `${revision.id}:r${revision.round}:${revision.state}`);
}

/**
 * Both supersession answers per Summary draft, as one row: `id:round:state server=<bool> dashboard=<bool>`.
 *
 * The DASHBOARD side reads the PROJECTED payload (`story-contract.ts:isSupersededSummaryDraft` takes the
 * wire view), the SERVER side reads the STORE (`records.ts:isSupersededSummaryDraft` takes the record).
 * `projected()` deliberately resurrects hard-deleted losers as `discarded` (projections.ts:
 * `viewRevisions`), so the loop's own audit rows are asked about too: they must read as history on both
 * sides, never as competition.
 */
function supersessionRows(rig: Rig): string[] {
    const store = rig.store;
    const story = storyOf(rig);
    const view = projected(rig);
    const context = summaryScopeContext(view);

    return view.revisions
        .filter((revision) => revision.unit_kind === 'summary')
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(
            (revision) =>
                `${revision.id}:r${revision.round}:${revision.state} server=${isSupersededSummaryDraft(
                    store,
                    story,
                    revision
                )} dashboard=${dashboardSupersededSummaryDraft(view, revision, context)}`
        );
}

/**
 * The two round numbers, from the store and from the payload. `server.active` is the loop's own
 * `samplingRoundOf`; `dashboard.activeRound` is what the rail compares against; and `wire.*` is what
 * actually crosses the boundary — the assertion that the projection carries the number rather than the
 * client guessing at it (T12/P1).
 */
function roundNumbers(rig: Rig): Record<string, number | string | undefined> {
    const story = storyOf(rig);
    const view = projected(rig);
    const context = summaryScopeContext(view);
    const carried = selectedSummaryRevision(rig.store, rig.storyId) ?? dashboardSelectedSummaryRevision(view);

    return {
        'server.deepReview': deepReviewRoundOf(story),
        'server.active': samplingRoundOf(story),
        'wire.round': view.sampling?.round,
        'wire.activeRound': view.sampling?.active_round,
        'dashboard.round': context.round,
        'dashboard.activeRound': context.activeRound,
        // The carried draft the deep-review guard is made against, asserted in the same row so an
        // override that changes WHICH draft is carried cannot slip past the round columns.
        'carried': carried?.id
    };
}

/** The Story row, re-read (the rig's cached copy is not the selection commit's result). */
function storyOf(rig: Rig): Story {
    return rig.store.stories.require(rig.storyId);
}

/** The Story's Summary UNIT row — the sampling claim keys are namespaced by its id (§6.4 step 3). */
function summaryOf(rig: Rig) {
    const summary = rig.store.summaries.list().find((row) => row.story_id === rig.storyId);

    if (summary === undefined) throw new Error('the rig has no Summary row');

    return summary;
}

/**
 * The WIRE payload, built by the shipped projection.
 *
 * `StoryView.templates` carries template IDS on the wire (D-17b) and the contract's `StoryViewData`
 * alias widens it to resolved records for the panes; no scope predicate reads templates, so the payload
 * is handed over with an empty list rather than a fake record.
 */
function projected(rig: Rig): StoryViewData {
    const view = storyView(
        { store: rig.store, criteria: new CriteriaEngine(), digest: new DigestBuilder() },
        storyOf(rig)
    );

    return { ...view, templates: [] };
}

// ---------------------------------------------------------------------------
// Seeding the states the engine cannot reach on its own
// ---------------------------------------------------------------------------

/**
 * A `drafted` Summary row that SURVIVED a selection — the exact shape the rules exist for (§16.6,
 * T6/R2b): selection hard-deletes its losers, but a sample that was still being screened when the
 * engine chose never entered the candidate set, so the row stays in the round forever.
 *
 * `round` is patched AFTER the create because `Revision.round` is optional (§3.5): passing no round is
 * how the LEGACY shape is reproduced (P2), and it is the shape the row has on the wire — `copyIn` is a
 * JSON round trip, so an `undefined` round cannot be patched away and has to be left out at create time.
 */
function seedSurvivor(rig: Rig, input: { round?: number; state?: Revision['state'] } = {}): Revision {
    const summary = summaryOf(rig);
    const row = rig.store.revisions.create(
        {
            story_id: rig.storyId,
            unit_kind: 'summary',
            unit_ref: summary.id,
            body: { premise: 'the survivor the round never judged' },
            run_ref: `run_survivor_${rig.store.revisions.list().length + 1}`,
            state: input.state ?? 'drafted',
            verdict_refs: []
        },
        authorAttr('test: seed a Summary draft')
    );

    if (input.round === undefined) return row;

    return rig.store.revisions.update(
        row.id,
        { round: input.round },
        { run_ref: null, why: `test: this draft belongs to round ${input.round} (§6.2a)` }
    );
}

/** One sampling run row under `wi_sample_<summary>_<round>[_w<wave>]_<attempt>` — the retry ledger. */
function seedSampleRun(rig: Rig, key: string): void {
    const at = new Date().toISOString();

    rig.store.runs.create(
        {
            story_id: rig.storyId,
            work_item_ref: key,
            role: 'writer',
            template_ref: 't-builtin',
            state: 'torn_down' satisfies Run['state'],
            started_at: at,
            ended_at: at,
            tokens: 10,
            kind: 'work',
            delegated: []
        },
        authorAttr('test: seed a Summary draft')
    );
}

/** A Reader finding in phase ①'s spelling: the Summary row as target, the draft it read in `related_refs`. */
function seedScopedFinding(
    rig: Rig,
    input: { fingerprint: string; refs?: string[]; target?: string; cost?: Finding['cost'] }
): Finding {
    return seedFinding(rig.store, rig.storyId, {
        target_ref: input.target ?? summaryOf(rig).id,
        criterion_ref: 'C-14',
        cost: input.cost ?? 'critical',
        state: 'confirmed',
        fingerprint: input.fingerprint,
        ...(input.refs === undefined ? {} : { related_refs: input.refs })
    });
}

/** Arms the next refinement round: an approved finding on the carried draft plus the fix it mandates. */
function armRefinementRound(rig: Rig) {
    const summary = summaryOf(rig);
    const carried = selectedSummaryRevision(rig.store, rig.storyId);

    if (carried === undefined) throw new Error('a refinement round needs a carried draft');

    const finding = seedFinding(rig.store, rig.storyId, {
        target_ref: summary.id,
        criterion_ref: 'C-14',
        cost: 'major',
        state: 'approved',
        fingerprint: 'C-14|arm',
        related_refs: [carried.id]
    });
    const task = seedTask(rig.store, rig.storyId, {
        kind: 'fix',
        title: 'fix major: the ending does not pay the promise',
        detail: `C-14 on ${summary.id} · ${summary.id}`,
        owner_role: 'writer',
        finding_ref: finding.id
    });

    return { finding, task };
}

/** The sweep's competition answer (server) and the rail's Author-override list (dashboard), as ids. */
function competition(rig: Rig): { server: string[]; dashboard: string[] } {
    const view = projected(rig);

    return {
        server: unitsWithCompetingRevisions(rig.store, storyOf(rig)),
        dashboard: (summaryRevisionUnit(view)?.revisions ?? []).map((revision) => revision.id)
    };
}

// ---------------------------------------------------------------------------
// P1 — the truth table, one case per row
// ---------------------------------------------------------------------------

describe('T12/P1 — the active round means the same thing on the server, on the wire and on the rail', () => {
    it('round 1 before the first selection: its drafts are LIVE work on both sides', async () => {
        const rig = await createRig({ summarySampling: 2, summaryReaders: 1 });

        // Two sweeps write the round's two samples; the third screens them and the fourth selects, so this
        // is the state with drafts on the ledger and no selection yet (§6.4 steps 3-4).
        await rig.step();
        await rig.step();

        expect(summaryDraftRows(rig)).toEqual(['revision_0:r1:drafted', 'revision_1:r1:drafted']);
        // The reference row: nothing has completed, so the in-flight round IS 1 — `sampling.round` alone
        // (also 1) cannot express that, which is the whole reason `active_round` exists.
        expect(roundNumbers(rig)).toEqual({
            'server.deepReview': 1,
            'server.active': 1,
            'wire.round': 1,
            'wire.activeRound': 1,
            'dashboard.round': 1,
            'dashboard.activeRound': 1,
            'carried': undefined
        });
        expect(supersessionRows(rig)).toEqual([
            'revision_0:r1:drafted server=false dashboard=false',
            'revision_1:r1:drafted server=false dashboard=false'
        ]);
        // The consequence the Author sees: the round is really in flight, so both readers count it.
        expect(competition(rig)).toEqual({
            server: [summaryOf(rig).id],
            dashboard: ['revision_0', 'revision_1']
        });
        // The gate says so too — and it is the SAME sentence the engine's own drain probe owes this state
        // (`status.ts:phase1Unmet` counts the two un-screened samples), Goal line included.
        expect(lockCheck(projected(rig)).reasons).toEqual([
            'the Goal has not passed: C-14 still failing (1/2 · failing: C-14)',
            '2 Summary revisions still in this round — the engine selects the winner once every draft has its screening reviews (§16.6)'
        ]);
    });

    it('after round 1 selects, a round-1 survivor is set aside on both sides — and stops holding the lock', async () => {
        const rig = await createRig({ summarySampling: 2, summaryReaders: 1 });

        await rig.run();

        const survivor = seedSurvivor(rig, { round: 1 });

        expect(storyOf(rig).sampling_round).toBe(1);
        expect(summaryDraftRows(rig)).toEqual([
            // The loser the selection hard-deleted: the projection recovers it from the journal as
            // `discarded`, so the rail keeps its history while the competition count stays clean.
            'revision_0:r1:selected',
            'revision_1:r1:discarded',
            `${survivor.id}:r1:drafted`
        ]);
        expect(roundNumbers(rig)).toEqual({
            'server.deepReview': 1,
            // THE parity row: one round AHEAD of `wire.round`, and the number the rail must compare with.
            'server.active': 2,
            'wire.round': 1,
            'wire.activeRound': 2,
            'dashboard.round': 1,
            'dashboard.activeRound': 2,
            'carried': 'revision_0'
        });
        expect(supersessionRows(rig)).toEqual([
            'revision_0:r1:selected server=false dashboard=false',
            'revision_1:r1:discarded server=false dashboard=false',
            `${survivor.id}:r1:drafted server=true dashboard=true`
        ]);
        expect(competition(rig)).toEqual({ server: [], dashboard: [] });
        expect(lockCheck(projected(rig)).reasons).toEqual([]);
    });

    it('during round 2, its own drafts are live while round 1 stays set aside', async () => {
        const rig = await createRig({ summarySampling: 2, summaryReaders: 1 });

        await rig.run();

        const survivor = seedSurvivor(rig, { round: 1 });

        armRefinementRound(rig);
        await rig.step();

        expect(storyOf(rig).sampling_round).toBe(1);
        // The survivor took `revision_2` (revisions come from one counter), so round 2's first sample is
        // `revision_3` — the round number, not the id, is what both sides compare.
        expect(summaryDraftRows(rig)).toEqual([
            'revision_0:r1:selected',
            'revision_1:r1:discarded',
            `${survivor.id}:r1:drafted`,
            'revision_3:r2:drafted'
        ]);
        expect(roundNumbers(rig)).toEqual({
            'server.deepReview': 1,
            'server.active': 2,
            'wire.round': 1,
            'wire.activeRound': 2,
            'dashboard.round': 1,
            'dashboard.activeRound': 2,
            'carried': 'revision_0'
        });
        expect(supersessionRows(rig)).toEqual([
            'revision_0:r1:selected server=false dashboard=false',
            'revision_1:r1:discarded server=false dashboard=false',
            `${survivor.id}:r1:drafted server=true dashboard=true`,
            'revision_3:r2:drafted server=false dashboard=false'
        ]);
        // The same rail, one row live and one retired: the count the Author reads is the live one, and the
        // override list offers only this round's draft (`summaryRevisionUnit` = the Author's Select).
        expect(competition(rig)).toEqual({ server: [summaryOf(rig).id], dashboard: ['revision_3'] });
        expect(lockCheck(projected(rig)).reasons).toEqual([
            '1 Summary revision still in this round — the engine selects the winner once every draft has its screening reviews (§16.6)',
            '1 approved critical/major finding on the selected Summary — the next Summary round writes fresh drafts to clear them (D-34)'
        ]);
        // The engine's own copy of the same state (§6.7): the round is in flight and owes its second sample.
        expect(drainPreconditions(rig.store, storyOf(rig)).unmet).toContain(
            '1 of 2 samples exist for round 2 and retries remain (§6.4 step 3)'
        );
    });

    it('an Author override to an older round neither resurrects rivals nor re-opens the review debt', async () => {
        const rig = await createRig({ summarySampling: 2, summaryReaders: 1 });

        await rig.run();

        armRefinementRound(rig);
        await rig.run();

        // Round 2 has now selected, so the Story carries a round-2 draft and the in-flight round is 3. A
        // round-1 draft is still on the ledger — the row the rounds never judged.
        expect(storyOf(rig).sampling_round).toBe(2);

        const survivor = seedSurvivor(rig, { round: 1 });

        expect(supersessionRows(rig)).toContain(`${survivor.id}:r1:drafted server=true dashboard=true`);

        // The Author's override (D-24, `POST /revisions/:id/select`): the rail demotes the draft the loop
        // carries, and round 1's winner is the Summary on record again.
        rig.store.revisions.update(
            'revision_2',
            { state: 'discarded' },
            { run_ref: null, why: 'test: the Author stopped carrying round 2’s draft (D-24)' }
        );

        expect(roundNumbers(rig)).toEqual({
            // The deep-review round tracks the ROUND, not the carried row: the loop can only dispatch a
            // review for the generation it just chose, so an older-round override owes nothing.
            'server.deepReview': 2,
            'server.active': 3,
            'wire.round': 2,
            'wire.activeRound': 3,
            'dashboard.round': 2,
            'dashboard.activeRound': 3,
            'carried': 'revision_0'
        });
        // The override changed which draft the Summary carries. It did not re-arm round 1: its rival is
        // still superseded on both sides, and neither the rail nor the drain treats it as work.
        expect(supersessionRows(rig)).toEqual([
            'revision_0:r1:selected server=false dashboard=false',
            'revision_1:r1:discarded server=false dashboard=false',
            'revision_2:r2:discarded server=false dashboard=false',
            'revision_3:r2:discarded server=false dashboard=false',
            `${survivor.id}:r1:drafted server=true dashboard=true`
        ]);
        // The review debt, read the same way by both sides (`records.ts:isDeepReviewSelection` and the
        // rail's owed count): the round-1 draft the Summary now carries is NOT the round-2 review target,
        // so the pass round 1 already had is history and nothing is owed.
        const carried = selectedSummaryRevision(rig.store, rig.storyId);

        if (carried === undefined) throw new Error('the override left no carried draft');

        expect(isDeepReviewSelection(storyOf(rig), carried)).toBe(false);
        expect(deepReviewPassesOwed(rig.store, storyOf(rig), carried)).toBe(0);
        expect(deepReviewProgress(projected(rig), dashboardSelectedSummaryRevision(projected(rig)))).toEqual({
            closed: 1,
            live: 0,
            owed: 0
        });
        // …and the gate stays open rather than waiting on work generation cannot dispatch.
        expect(competition(rig)).toEqual({ server: [], dashboard: [] });
        expect(lockCheck(projected(rig)).reasons).toEqual([]);
        expect(drainPreconditions(rig.store, storyOf(rig))).toEqual({ met: true, unmet: [] });
    });

    it('round 10 vs round 1: the round number never leaks across the claim-key boundary', async () => {
        const rig = await createRig({ summarySampling: 1, summaryReaders: 1 });
        const summary = summaryOf(rig);

        // Nine completed rounds (an Author-side state: the row says what it says), with a round-1 attempt
        // and a round-10 attempt on the ledger, and one draft of each of the last two rounds.
        rig.store.stories.update(
            rig.storyId,
            { sampling_round: 9 },
            { run_ref: null, why: 'test: nine completed sampling rounds (§6.6)' }
        );
        // `<prefix>_<attempt>`, so these are round 1's first attempt and round 10's first attempt — the
        // shapes `samplePrefixOf` anchors on.
        seedSampleRun(rig, `wi_sample_${summary.id}_1_1`);
        seedSampleRun(rig, `wi_sample_${summary.id}_10_1`);

        const round9 = seedSurvivor(rig, { round: 9, state: 'selected' });
        const round9Survivor = seedSurvivor(rig, { round: 9 });
        const round10 = seedSurvivor(rig, { round: 10 });

        expect(roundNumbers(rig)).toEqual({
            'server.deepReview': 9,
            'server.active': 10,
            'wire.round': 9,
            'wire.activeRound': 10,
            'dashboard.round': 9,
            'dashboard.activeRound': 10,
            'carried': round9.id
        });
        expect(supersessionRows(rig)).toEqual([
            `${round9.id}:r9:selected server=false dashboard=false`,
            `${round9Survivor.id}:r9:drafted server=true dashboard=true`,
            `${round10.id}:r10:drafted server=false dashboard=false`
        ]);
        // The retry counters the cap is measured by: round 1's prefix `…_1_` does NOT match round 10's key
        // `…_1_10_1` (the trailing `_` is the anchor, T10/F5), so a tenth round's attempt cannot spend the
        // first round's allowance and a first round's runs cannot re-arm the tenth.
        expect(sampleAttempts(rig.store, summary.id, 1, 0)).toBe(1);
        expect(sampleAttempts(rig.store, summary.id, 10, 0)).toBe(1);
        expect(samplingRoundStarted(rig.store, storyOf(rig), 2)).toBe(false);
        expect(samplingRoundStarted(rig.store, storyOf(rig), 10)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// P2 — the persisted legacy shapes
// ---------------------------------------------------------------------------

describe('T12/P2 — a Summary draft with no round is still a draft, on both sides', () => {
    it('keys round-less drafts at round 1 in BOTH maps, and keeps an unknown id an unknown id', async () => {
        const rig = await createRig({ summarySampling: 1, summaryReaders: 1 });
        const summary = summaryOf(rig);

        // A Story written before §3.5 numbered rounds: no sampling history, and Summary rows whose `round`
        // field was never present. The carried draft is one of them.
        const legacyCarried = seedSurvivor(rig, { state: 'selected' });
        const legacyDraft = seedSurvivor(rig);

        expect(
            projected(rig)
                .revisions.filter((revision) => revision.unit_kind === 'summary')
                .map((revision) => `${revision.id}:${revision.round}`)
        ).toEqual([`${legacyCarried.id}:undefined`, `${legacyDraft.id}:undefined`]);

        // The two maps are EQUAL, not merely similar: membership is "this Story has a Summary draft with
        // this id", and neither side may know a draft the other does not.
        const serverEntries = [...summaryRevisionRounds(rig.store, rig.storyId).entries()].sort();

        expect([...summaryScopeContext(projected(rig)).draftRounds.entries()].sort()).toEqual(serverEntries);
        expect(serverEntries).toEqual([
            [legacyCarried.id, 1],
            [legacyDraft.id, 1]
        ].sort());
        // Nothing has completed, so round 1 is in flight and the round-less draft is LIVE work.
        expect(roundNumbers(rig)).toEqual({
            'server.deepReview': 1,
            'server.active': 1,
            'wire.round': 1,
            'wire.activeRound': 1,
            'dashboard.round': 1,
            'dashboard.activeRound': 1,
            'carried': legacyCarried.id
        });
        expect(supersessionRows(rig)).toEqual([
            `${legacyCarried.id}:rundefined:selected server=false dashboard=false`,
            `${legacyDraft.id}:rundefined:drafted server=false dashboard=false`
        ]);

        // The attribution question, five spellings, one answer each. The first two are the fix: a finding
        // that names a round-less draft is about THAT DRAFT — it is not a statement about the whole
        // Summary, and reading it as one is what made a blocker on the carried revision go invisible on
        // the server while the rail already showed it.
        const namedOnCarried = seedScopedFinding(rig, {
            fingerprint: 'C-14|legacy-carried',
            refs: [legacyCarried.id],
            // The legacy tool filed the finding against the REVISION, not the unit — the target the
            // whole-artifact fallback would have needed to keep it blocking.
            target: legacyCarried.id
        });
        const namedOnDraft = seedScopedFinding(rig, { fingerprint: 'C-14|legacy-draft', refs: [legacyDraft.id] });
        const unknownId = seedScopedFinding(rig, { fingerprint: 'C-14|unknown', refs: ['revision_77'] });
        const namesUnit = seedScopedFinding(rig, { fingerprint: 'C-14|unit', refs: [summary.id] });
        const noRefs = seedScopedFinding(rig, { fingerprint: 'C-14|no-refs' });

        // Re-read the payload: these are the rows the pane renders, findings included.
        const view = projected(rig);
        const context = summaryScopeContext(view);
        const scopes = (finding: Finding) =>
            `server=${findingRevisionScope(rig.store, storyOf(rig), finding)} dashboard=${dashboardFindingScope(finding, context)}`;

        expect(scopes(namedOnCarried)).toBe('server=selected dashboard=selected');
        expect(scopes(namedOnDraft)).toBe('server=superseded dashboard=superseded');
        expect(scopes(unknownId)).toBe('server=artifact dashboard=artifact');
        expect(scopes(namesUnit)).toBe('server=artifact dashboard=artifact');
        expect(scopes(noRefs)).toBe('server=artifact dashboard=artifact');

        // …and the blocking weight follows the scope, identically: the carried draft's critical finding
        // blocks the sign-off on BOTH sides (the P2 fix — the server used to answer `artifact` here and
        // then drop it for naming the revision rather than the unit), while the three whole-artifact rows
        // keep blocking because their target IS the Summary unit, and the note about the round-less
        // sibling is that sibling's history alone.
        expect(summaryBlockingFindings(rig.store, storyOf(rig), summary.id).map((row) => row.id)).toEqual([
            namedOnCarried.id,
            unknownId.id,
            namesUnit.id,
            noRefs.id
        ]);
        expect(
            dashboardSummaryBlockingFindings(view, dashboardSelectedSummaryRevision(view)).map((row) => row.id)
        ).toEqual([namedOnCarried.id, unknownId.id, namesUnit.id, noRefs.id]);
    });

    it('the same round-less draft turns over as soon as a round completes — one boundary, two readers', async () => {
        const rig = await createRig({ summarySampling: 1, summaryReaders: 1 });
        const legacyDraft = seedSurvivor(rig);

        expect(supersessionRows(rig)).toEqual([`${legacyDraft.id}:rundefined:drafted server=false dashboard=false`]);

        // A legacy selection lands (a completed round with no P11 audit row, the state an upgrade from an
        // older build leaves): the round-less draft is now a round-1 loser, and both sides retire it.
        rig.store.stories.update(
            rig.storyId,
            { sampling_round: 1 },
            { run_ref: null, why: 'test: a selection completed before the audit field existed (§6.6)' }
        );

        expect(roundNumbers(rig)).toEqual({
            'server.deepReview': 1,
            'server.active': 2,
            'wire.round': 1,
            'wire.activeRound': 2,
            'dashboard.round': 1,
            'dashboard.activeRound': 2,
            'carried': undefined
        });
        expect(supersessionRows(rig)).toEqual([`${legacyDraft.id}:rundefined:drafted server=true dashboard=true`]);
        expect(competition(rig)).toEqual({ server: [], dashboard: [] });
    });
});
